/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import controlsArtifact from '../ssdlc/catalog/controls.json';
import { resolveActiveControls, type ApplicabilityProfile } from '../ssdlc/applicability/resolver';
import { bindAssuranceProfile, assertCurrentAssuranceProfile, type AssuranceMechanism, type RiskProfile } from '../ssdlc/assurance-profile';
import { compileGates } from '../ssdlc/gates/gate-compiler';
import { parseControl } from '../ssdlc/schema/control-schema';
import { UnprocessableError, ValidationError } from './errors';
import { MISSION_CONTRACT_VERSIONS, EntityRefV1Schema, RevisionRefV1Schema, type EntityRefV1, type RevisionRefV1 } from './mission-contracts';
import { reviewHermesRequirements } from './hermes-requirements-review';
import { GenesisProvenanceSchema, type GenesisProvenance } from './source-adapters/genesis';
import { deriveFrozenSourceBundleDigest, IntentDispositionV1Schema, SourceBundleV1Schema, type SourceBundleV1 } from './source-contracts';

const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const StorySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  dependsOn: z.array(z.string()).optional(),
}).passthrough();
const ApplicabilitySchema = z.object({
  productProfile: z.enum(['cli', 'library', 'web-frontend', 'api-service', 'mobile', 'data-pipeline', 'ai-ml', 'infrastructure']).nullable(),
  riskProfile: z.array(z.string()),
  domainRegulatory: z.array(z.string()),
  workspaceConventions: z.array(z.string()).optional(),
  specTaskOverrides: z.array(z.object({
    controlId: z.string().min(1), action: z.enum(['include', 'exclude']),
    evidenceDepthOverride: z.enum(['self-attestation', 'artifact', 'independent-verification']).optional(),
    requirementId: z.string().min(1),
  }).strict()).optional(),
}).strict();
const MechanismSchema = z.object({
  mechanismId: z.string().min(1),
  kind: z.enum(['command', 'repository-path', 'skill', 'workflow', 'review']),
  locator: z.string().min(1),
}).strict();
const RiskSchema = z.object({
  level: z.enum(['none', 'low', 'medium', 'high', 'critical']),
  tags: z.array(z.string().min(1)),
  rationale: z.string().min(1),
}).strict();

export const MissionDraftBridgeInputSchema = z.object({
  disposition: IntentDispositionV1Schema,
  sourceBundle: SourceBundleV1Schema,
  genesis: GenesisProvenanceSchema,
  title: z.string().min(1),
  slug: z.string().min(1).optional(),
  stories: z.array(StorySchema).min(1),
  maxBundleAgeSeconds: z.number().int().positive().max(86_400).default(900),
  assurance: z.object({
    profileId: z.string().min(1),
    repositoryContextHash: sha256,
    mechanisms: z.array(MechanismSchema).min(1),
    riskProfile: RiskSchema,
    applicability: ApplicabilitySchema,
  }).strict(),
}).strict();
export type MissionDraftBridgeInput = z.infer<typeof MissionDraftBridgeInputSchema>;

const MissionDraftRecompileInputSchema = z.object({
  previous: z.object({
    sourceBundle: SourceBundleV1Schema,
    specRevision: RevisionRefV1Schema,
    assuranceCompilationReceiptHash: sha256,
  }).strict(),
  drift: z.object({
    schemaVersion: z.literal('rorca.source-drift-report.v1'),
    bundleId: z.string().min(1), bundleHash: sha256, contextState: z.literal('stale'), stale: z.literal(true),
    checkedAt: z.string().datetime({ offset: true }),
    sources: z.array(z.object({
      sourceId: z.string().min(1), kind: z.string().min(1), locator: z.string().min(1),
      state: z.enum(['unchanged', 'changed', 'deleted', 'unavailable', 'unknown']),
      oldHash: sha256, newHash: sha256.nullable(), detail: z.string().min(1),
    }).strict()).min(1).max(500),
  }).strict(),
  draft: MissionDraftBridgeInputSchema,
}).strict();

export interface PersistSpecDraftPayload {
  workspaceId: string;
  title: string;
  slug: string;
  stories: z.infer<typeof StorySchema>[];
  source: 'hermes-mission-draft';
  contextUsed: {
    text: string;
    meta: {
      sourceVerification: MissionDraftProvenance;
    };
    genesis: GenesisProvenance;
  };
  contextSummary: { genesis: GenesisProvenance; sourceBundleHash: string; sourceCount: number };
}

export interface MissionDraftProvenance {
  disposition: 'mission_draft';
  bundleId: string;
  bundleHash: string;
  frozenBundleDigest: string;
  sourceRefs: SourceBundleV1['includedSources'];
  /** Exact immutable bundle persisted with the spec; consumers must not reconstruct it from refs. */
  sourceBundle: SourceBundleV1;
  genesis: GenesisProvenance;
  entityRef: EntityRefV1;
  revisionRef: RevisionRefV1;
}

export interface MissionDraftPersistencePort {
  /** Must invoke POST /api/specs/persist, never the legacy generate endpoint. */
  persist(payload: PersistSpecDraftPayload): Promise<Record<string, unknown>>;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export const deriveFrozenBundleDigest = deriveFrozenSourceBundleDigest;

function slugFor(input: MissionDraftBridgeInput): string {
  const slug = (input.slug ?? input.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!slug) throw new ValidationError('Mission draft title or slug must contain a stable identifier');
  return slug;
}

function assertFreshFrozenBundle(input: MissionDraftBridgeInput, now: Date): SourceBundleV1 {
  if (input.disposition.disposition !== 'mission_draft' || input.disposition.permittedAction !== 'draft_mission') {
    throw new ValidationError('Only a mission_draft disposition can be persisted by this bridge');
  }
  const bundle = SourceBundleV1Schema.parse(input.sourceBundle);
  if (input.disposition.draftHash !== bundle.bundleHash) {
    throw new UnprocessableError('Mission draft disposition does not match the frozen source bundle', 'SOURCE_BUNDLE_MISMATCH');
  }
  if (deriveFrozenBundleDigest(bundle) !== input.disposition.frozenBundleDigest) {
    throw new UnprocessableError('Source bundle was mutated after classification', 'SOURCE_BUNDLE_MUTATED');
  }
  const ageSeconds = (now.getTime() - new Date(bundle.compiledAt).getTime()) / 1000;
  if (!Number.isFinite(ageSeconds) || ageSeconds < -60 || ageSeconds > input.maxBundleAgeSeconds) {
    throw new UnprocessableError('Source bundle is stale; recompile sources before persistence', 'SOURCE_BUNDLE_STALE');
  }
  return structuredClone(bundle);
}

/** Build the canonical explicit-draft body before any mutation is attempted. */
export function buildMissionPersistPayload(raw: unknown, now = new Date()): PersistSpecDraftPayload {
  const parsed = MissionDraftBridgeInputSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError('Invalid mission draft bridge request', { issues: parsed.error.issues });
  const input = parsed.data;
  const bundle = assertFreshFrozenBundle(input, now);
  const frozenBundleDigest = input.disposition.disposition === 'mission_draft'
    ? input.disposition.frozenBundleDigest
    : deriveFrozenBundleDigest(bundle); // unreachable after assertFreshFrozenBundle
  const slug = slugFor(input);
  const revisionRef = RevisionRefV1Schema.parse({
    kind: 'artifact_digest',
    value: `sha256:${createHash('sha256').update(canonicalJson({ title: input.title, slug, stories: input.stories, bundleHash: bundle.bundleHash })).digest('hex')}`,
  });
  const entityRef = EntityRefV1Schema.parse({
    schemaVersion: MISSION_CONTRACT_VERSIONS.entityRef,
    workspaceId: bundle.workspaceRef.workspaceId,
    kind: 'spec', id: slug, label: input.title, revision: revisionRef,
  });
  const provenance: MissionDraftProvenance = {
    disposition: 'mission_draft', bundleId: bundle.bundleId, bundleHash: bundle.bundleHash,
    frozenBundleDigest,
    sourceRefs: structuredClone(bundle.includedSources), sourceBundle: structuredClone(bundle),
    genesis: structuredClone(input.genesis),
    entityRef, revisionRef,
  };
  return {
    workspaceId: bundle.workspaceRef.workspaceId, title: input.title, slug,
    stories: structuredClone(input.stories), source: 'hermes-mission-draft',
    contextUsed: {
      text: bundle.userIntent,
      meta: { sourceVerification: provenance },
      genesis: structuredClone(input.genesis),
    },
    contextSummary: { genesis: structuredClone(input.genesis), sourceBundleHash: bundle.bundleHash, sourceCount: bundle.includedSources.length },
  };
}

/** Persist first, then run canonical US-003/US-004 and AAV-005 binding for that exact revision. */
export async function bridgeMissionDraft(raw: unknown, port: MissionDraftPersistencePort, now = new Date()) {
  const persistPayload = buildMissionPersistPayload(raw, now);
  // buildMissionPersistPayload has already validated and cloned this request at the
  // pre-persist trust boundary, so subsequent compilation cannot observe caller mutation.
  const input = MissionDraftBridgeInputSchema.parse(raw);
  const bundle = persistPayload.contextUsed.meta.sourceVerification.sourceBundle;
  const persisted = await port.persist(persistPayload);
  if ((persisted.slug ?? persisted.id) !== persistPayload.slug) {
    throw new UnprocessableError('Explicit-draft persistence returned a different spec identity', 'SPEC_REVISION_MISMATCH');
  }
  const readback = persisted.readback && typeof persisted.readback === 'object' && !Array.isArray(persisted.readback)
    ? persisted.readback as Record<string, unknown>
    : persisted;
  const exactPersistedMaterial = {
    source: readback.source,
    stories: readback.stories,
    contextUsed: readback.contextUsed,
    contextSummary: readback.contextSummary,
  };
  const exactRequestedMaterial = {
    source: persistPayload.source,
    stories: persistPayload.stories,
    contextUsed: persistPayload.contextUsed,
    contextSummary: persistPayload.contextSummary,
  };
  if (canonicalJson(exactPersistedMaterial) !== canonicalJson(exactRequestedMaterial)) {
    throw new UnprocessableError(
      'Explicit-draft readback does not contain the exact frozen source provenance and spec revision material',
      'SPEC_REVISION_MISMATCH',
    );
  }

  const applicability = resolveActiveControls(input.assurance.applicability as ApplicabilityProfile);
  const controls = controlsArtifact.map((control) => parseControl(control));
  // US-003 may derive a shallower default from a low-risk profile, but a canonical
  // non-overridable control can never be weakened below its catalog requirement.
  const resolvedDepthRank = { 'self-attestation': 0, artifact: 1, 'independent-verification': 2 } as const;
  const requiredDepth = { declaration: 'self-attestation', demonstrated: 'artifact', 'independent-verification': 'independent-verification' } as const;
  for (const control of controls) {
    if (!applicability.activeControlIds.includes(control.controlId) || control.exceptionPolicy.allowed) continue;
    const minimum = control.requiredEvidence.reduce<'self-attestation' | 'artifact' | 'independent-verification'>((highest, requirement) => {
      const candidate = requiredDepth[requirement.evidenceDepth];
      return resolvedDepthRank[candidate] > resolvedDepthRank[highest] ? candidate : highest;
    }, 'self-attestation');
    if (resolvedDepthRank[applicability.evidenceDepthByControlId[control.controlId]] < resolvedDepthRank[minimum]) {
      applicability.evidenceDepthByControlId[control.controlId] = minimum;
    }
  }
  const gates = compileGates(controls, applicability);
  const mechanism = input.assurance.mechanisms[0] as AssuranceMechanism;
  const controlBindings = applicability.activeControlIds.map((controlId) => ({
    controlId,
    enforcement: 'required' as const,
    mechanismBindings: [mechanism],
    criteria: [{ criterionId: `${controlId.toLowerCase()}-bound`, description: `${controlId} must be reviewed through its bound repository mechanism.`, evaluator: 'human-decision' as const, expected: 'approved' }],
    evidenceRequirements: gates.phaseGroups.flatMap((group) => group.evidenceRequirements.filter((item) => item.controlId === controlId).map(({ controlId: _id, sourceReferences: _refs, ...requirement }) => requirement)),
  }));
  const provenance = persistPayload.contextUsed.meta.sourceVerification;
  const profile = bindAssuranceProfile({
    profileId: input.assurance.profileId,
    specRef: provenance.entityRef,
    specRevision: provenance.revisionRef,
    persistedSourceContext: { bundle, specRevision: provenance.revisionRef },
    repositoryContext: { contextHash: input.assurance.repositoryContextHash, mechanisms: input.assurance.mechanisms },
    riskProfile: input.assurance.riskProfile as RiskProfile,
    applicability,
    gateCompilation: gates,
    modelProposal: { specRevision: provenance.revisionRef, sourceBundleHash: bundle.bundleHash, controlBindings },
  });
  assertCurrentAssuranceProfile(profile, {
    specRef: provenance.entityRef, specRevision: provenance.revisionRef,
    repositoryContextHash: input.assurance.repositoryContextHash, sourceBundle: bundle,
  });

  const requirementsReview = reviewHermesRequirements({
    workspaceId: bundle.workspaceRef.workspaceId,
    specSlug: persistPayload.slug,
    specRevision: provenance.revisionRef,
    stories: persistPayload.stories,
    observedAt: now,
  });

  return {
    persisted,
    persistPayload,
    provenance,
    applicability,
    gates,
    assuranceProfile: profile,
    requirementsReview,
    approvalReady: requirementsReview.approval.status === 'ready',
  };
}

/** Persist a changed bundle as a new exact revision while preserving prior revision authority as history only. */
export async function recompileMissionDraft(raw: unknown, port: MissionDraftPersistencePort, now = new Date()) {
  const input = MissionDraftRecompileInputSchema.parse(raw);
  const previous = input.previous.sourceBundle;
  if (input.drift.bundleId !== previous.bundleId || input.drift.bundleHash !== previous.bundleHash) {
    throw new UnprocessableError('Drift report does not bind the exact prior frozen bundle', 'SOURCE_BUNDLE_MISMATCH');
  }
  if (input.draft.sourceBundle.bundleHash === previous.bundleHash
    || input.draft.sourceBundle.workspaceRef.workspaceId !== previous.workspaceRef.workspaceId
    || input.draft.sourceBundle.userIntent !== previous.userIntent) {
    throw new UnprocessableError('Recompilation must produce changed source bytes for the same Mission intent and workspace', 'SOURCE_BUNDLE_MISMATCH');
  }
  for (const changed of input.drift.sources.filter(({ state }) => state === 'changed')) {
    const replacement = input.draft.sourceBundle.includedSources.find(({ locator }) => locator === changed.locator);
    if (!changed.newHash || replacement?.contentHash !== changed.newHash) {
      throw new UnprocessableError('Recompiled bundle does not contain the exact changed source hash from drift inspection', 'SOURCE_BUNDLE_MISMATCH');
    }
  }
  const result = await bridgeMissionDraft(input.draft, port, now);
  if (result.provenance.revisionRef.kind === input.previous.specRevision.kind
    && result.provenance.revisionRef.value === input.previous.specRevision.value) {
    throw new UnprocessableError('Recompilation reused the prior exact spec revision', 'SPEC_REVISION_MISMATCH');
  }
  if (result.assuranceProfile.compilationReceiptHash === input.previous.assuranceCompilationReceiptHash) {
    throw new UnprocessableError('Recompilation reused the prior assurance receipt', 'ASSURANCE_PROFILE_STALE');
  }
  return {
    ...result,
    approvalReady: false as const,
    reviewState: 'pending_re_review' as const,
    executionAffected: false as const,
    priorProfileApplies: false as const,
    priorRevision: input.previous.specRevision,
  };
}
