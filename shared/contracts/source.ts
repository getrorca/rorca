import { z } from 'zod';
import { EntityRefV1Schema } from './mission';
import { isoTimestamp } from './primitives';

export const SOURCE_CONTRACT_VERSIONS = {
  sourceRef: 'rorca.source-ref.v1',
  sourceBundle: 'rorca.source-bundle.v1',
  sourceCitation: 'rorca.source-citation.v1',
  sourceConflict: 'rorca.source-conflict.v1',
  contextCompilationReceipt: 'rorca.context-compilation-receipt.v1',
  intentEnvelope: 'rorca.intent-envelope.v1',
  intentDisposition: 'rorca.intent-disposition.v1',
} as const;

export const SOURCE_KINDS = ['genesis_package', 'genesis_evidence', 'local_file', 'url', 'github_issue', 'github_pr', 'linear_document', 'rorca_mission', 'inline'] as const;
export const SOURCE_REVIEW_STATUSES = ['approved', 'trusted', 'pending', 'unreviewed', 'external'] as const;
export const SOURCE_SENSITIVITIES = ['public', 'internal', 'confidential', 'restricted'] as const;
export const SOURCE_AUTHORITIES = ['user_mandated', 'approved_context', 'supporting_evidence'] as const;
export const INTENT_DISPOSITIONS = ['answer', 'clarification_required', 'mission_draft', 'existing_mission_action', 'memory_candidate', 'denied'] as const;
export const INTENT_PERMITTED_ACTIONS = ['answer', 'request_clarification', 'draft_mission', 'open_mission', 'propose_memory', 'deny'] as const;

export const SourceKindV1Schema = z.enum(SOURCE_KINDS);
export const SourceReviewStatusV1Schema = z.enum(SOURCE_REVIEW_STATUSES);
export const SourceSensitivityV1Schema = z.enum(SOURCE_SENSITIVITIES);
export const SourceAuthorityV1Schema = z.enum(SOURCE_AUTHORITIES);
export const IntentDispositionKindV1Schema = z.enum(INTENT_DISPOSITIONS);
export const IntentPermittedActionV1Schema = z.enum(INTENT_PERMITTED_ACTIONS);

const boundedId = z.string().min(1).max(256);
const boundedText = z.string().min(1).max(8_000);
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/, 'must be a lowercase sha256 digest');

function isSafeLocator(value: string): boolean {
  let decoded = value;
  for (let pass = 0; pass < 4; pass += 1) {
    if (!decoded || decoded !== decoded.trim() || decoded.startsWith('/') || decoded.startsWith('\\') || decoded.startsWith('~') || /[?#\u0000-\u001f]/.test(decoded)) return false;
    if (/[a-z][a-z0-9+.-]*:/i.test(decoded) || decoded.includes('//') || decoded.includes('\\')) return false;
    if (decoded.split('/').some((segment) => segment === '.' || segment === '..')) return false;
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) return true;
      decoded = next;
    } catch {
      return false;
    }
  }
  return false;
}

export const SourceLocatorV1Schema = z.string().min(1).max(2_000)
  .refine(isSafeLocator, 'locator must be an internal, non-traversing reference');

export const SourceRefV1Schema = z.object({
  schemaVersion: z.literal(SOURCE_CONTRACT_VERSIONS.sourceRef),
  sourceId: boundedId,
  kind: SourceKindV1Schema,
  locator: SourceLocatorV1Schema,
  title: z.string().min(1).max(500),
  contentHash: sha256,
  sourceVersion: z.string().min(1).max(256),
  reviewStatus: SourceReviewStatusV1Schema,
  sensitivity: SourceSensitivityV1Schema,
  authority: SourceAuthorityV1Schema,
  selectedSections: z.array(z.string().min(1).max(500)).max(500)
    .refine((sections) => new Set(sections).size === sections.length, 'selected sections must be unique'),
}).strict();
export type SourceRefV1 = z.infer<typeof SourceRefV1Schema>;

export const SourceCitationV1Schema = z.object({
  schemaVersion: z.literal(SOURCE_CONTRACT_VERSIONS.sourceCitation),
  citationId: boundedId,
  sourceId: boundedId,
  section: z.string().min(1).max(500),
  excerptHash: sha256,
  rationale: boundedText,
}).strict();
export type SourceCitationV1 = z.infer<typeof SourceCitationV1Schema>;

export const SourceConflictV1Schema = z.object({
  schemaVersion: z.literal(SOURCE_CONTRACT_VERSIONS.sourceConflict),
  conflictId: boundedId,
  sourceIds: z.array(boundedId).min(2).max(32)
    .refine((sourceIds) => new Set(sourceIds).size === sourceIds.length, 'conflict sourceIds must be unique'),
  summary: boundedText,
  resolution: boundedText.nullable(),
}).strict();
export type SourceConflictV1 = z.infer<typeof SourceConflictV1Schema>;

const ExcludedSourceV1Schema = z.object({ source: SourceRefV1Schema, reason: boundedText }).strict();
const CompilationNoteV1Schema = z.object({ description: boundedText, sourceIds: z.array(boundedId).max(32) }).strict();

export type SourceBundleHashInput = {
  userIntent: string;
  includedSources: readonly SourceRefV1[];
  citations: readonly SourceCitationV1[];
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

// Small environment-neutral SHA-256 implementation keeps schema parsing synchronous
// in browsers and in the backend mirror.
function sha256Hex(message: string): string {
  const bytes = new TextEncoder().encode(message);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  const initial = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const constants = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const state = initial.slice();
  const words = new Uint32Array(64);
  const rotate = (value: number, amount: number) => (value >>> amount) | (value << (32 - amount));
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const a = words[index - 15]; const b = words[index - 2];
      words[index] = (words[index - 16] + (rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3)) + words[index - 7] + (rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10))) >>> 0;
    }
    let [a,b,c,d,e,f,g,h] = state;
    for (let index = 0; index < 64; index += 1) {
      const t1 = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + constants[index] + words[index]) >>> 0;
      const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
    }
    [a,b,c,d,e,f,g,h].forEach((value, index) => { state[index] = (state[index] + value) >>> 0; });
  }
  return state.map((value) => value.toString(16).padStart(8, '0')).join('');
}

export function deriveSourceBundleHash(input: SourceBundleHashInput): string {
  const identity = {
    userIntent: input.userIntent,
    includedSources: input.includedSources,
    selectedSections: input.includedSources.map(({ sourceId, selectedSections }) => ({ sourceId, selectedSections })),
    citations: input.citations,
  };
  return `sha256:${sha256Hex(canonicalJson(identity))}`;
}

/** Full immutable snapshot digest; unlike bundleHash this includes compilation metadata and exclusions. */
export function deriveFrozenSourceBundleDigest(bundle: SourceBundleV1): string {
  return `sha256:${sha256Hex(canonicalJson(bundle))}`;
}

export const SourceBundleV1Schema = z.object({
  schemaVersion: z.literal(SOURCE_CONTRACT_VERSIONS.sourceBundle),
  bundleId: boundedId,
  bundleHash: sha256,
  userIntent: boundedText,
  workspaceRef: EntityRefV1Schema,
  includedSources: z.array(SourceRefV1Schema).min(1).max(500),
  excludedSources: z.array(ExcludedSourceV1Schema).max(500),
  conflicts: z.array(SourceConflictV1Schema).max(100),
  assumptions: z.array(CompilationNoteV1Schema).max(100),
  truncations: z.array(CompilationNoteV1Schema).max(100),
  citations: z.array(SourceCitationV1Schema).max(1_000),
  compiledAt: isoTimestamp,
}).strict().superRefine((value, context) => {
  if (value.workspaceRef.kind !== 'workspace' || value.workspaceRef.id !== value.workspaceRef.workspaceId) {
    context.addIssue({ code: 'custom', path: ['workspaceRef'], message: 'workspaceRef must identify its workspace' });
  }
  const sourceIds = new Set(value.includedSources.map((source) => source.sourceId));
  if (sourceIds.size !== value.includedSources.length) context.addIssue({ code: 'custom', path: ['includedSources'], message: 'included sourceIds must be unique' });
  const citationIds = new Set(value.citations.map((citation) => citation.citationId));
  if (citationIds.size !== value.citations.length) context.addIssue({ code: 'custom', path: ['citations'], message: 'citationIds must be unique' });
  value.citations.forEach((citation, index) => {
    const source = value.includedSources.find((candidate) => candidate.sourceId === citation.sourceId);
    if (!source || !source.selectedSections.includes(citation.section)) context.addIssue({ code: 'custom', path: ['citations', index], message: 'citation must reference an included selected section' });
  });
  if (value.bundleHash !== deriveSourceBundleHash(value)) context.addIssue({ code: 'custom', path: ['bundleHash'], message: 'bundleHash does not match canonical bundle content' });
});
export type SourceBundleV1 = z.infer<typeof SourceBundleV1Schema>;

export const ContextCompilationReceiptV1Schema = z.object({
  schemaVersion: z.literal(SOURCE_CONTRACT_VERSIONS.contextCompilationReceipt),
  receiptId: boundedId,
  bundleId: boundedId,
  bundleHash: sha256,
  sourceCount: z.number().int().nonnegative().max(500),
  citationCount: z.number().int().nonnegative().max(1_000),
  compiledAt: isoTimestamp,
}).strict();
export type ContextCompilationReceiptV1 = z.infer<typeof ContextCompilationReceiptV1Schema>;

const intentDispositionFields = {
  schemaVersion: z.literal(SOURCE_CONTRACT_VERSIONS.intentDisposition),
  targetRef: EntityRefV1Schema.nullable(),
  draftHash: sha256.nullable(),
  rationale: boundedText,
  requiredDecision: boundedText.nullable(),
  auditIdentity: z.string().email().max(320),
  authorityMode: z.literal('service-audit'),
};

export const IntentDispositionV1Schema = z.discriminatedUnion('disposition', [
  z.object({ ...intentDispositionFields, disposition: z.literal('answer'), permittedAction: z.literal('answer') }).strict(),
  z.object({ ...intentDispositionFields, disposition: z.literal('clarification_required'), permittedAction: z.literal('request_clarification') }).strict(),
  z.object({ ...intentDispositionFields, disposition: z.literal('mission_draft'), permittedAction: z.literal('draft_mission'), frozenBundleDigest: sha256 }).strict(),
  z.object({ ...intentDispositionFields, disposition: z.literal('existing_mission_action'), permittedAction: z.literal('open_mission') }).strict(),
  z.object({ ...intentDispositionFields, disposition: z.literal('memory_candidate'), permittedAction: z.literal('propose_memory') }).strict(),
  z.object({ ...intentDispositionFields, disposition: z.literal('denied'), permittedAction: z.literal('deny') }).strict(),
]);
export type IntentDispositionV1 = z.infer<typeof IntentDispositionV1Schema>;

export const IntentEnvelopeV1Schema = z.object({
  schemaVersion: z.literal(SOURCE_CONTRACT_VERSIONS.intentEnvelope),
  intentId: boundedId,
  idempotencyKey: z.string().min(8).max(256),
  userIntent: boundedText,
  workspaceRef: EntityRefV1Schema,
  missionRef: EntityRefV1Schema.nullable().default(null),
  sourceBundle: SourceBundleV1Schema.nullable().default(null),
  receivedAt: isoTimestamp,
}).strict().superRefine((value, context) => {
  if (value.workspaceRef.kind !== 'workspace' || value.workspaceRef.id !== value.workspaceRef.workspaceId) {
    context.addIssue({ code: 'custom', path: ['workspaceRef'], message: 'workspaceRef must identify its workspace' });
  }
  if (value.missionRef && value.missionRef.kind !== 'mission') context.addIssue({ code: 'custom', path: ['missionRef'], message: 'missionRef must identify a mission' });
  if (value.sourceBundle && value.userIntent !== value.sourceBundle.userIntent) context.addIssue({ code: 'custom', path: ['userIntent'], message: 'intent must match source bundle intent' });
  if (value.sourceBundle && (value.workspaceRef.id !== value.sourceBundle.workspaceRef.id || value.workspaceRef.workspaceId !== value.sourceBundle.workspaceRef.workspaceId)) context.addIssue({ code: 'custom', path: ['workspaceRef'], message: 'workspace must match source bundle workspace' });
});
export type IntentEnvelopeV1 = z.infer<typeof IntentEnvelopeV1Schema>;
