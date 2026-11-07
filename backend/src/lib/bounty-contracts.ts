/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const BOUNTY_CONTRACT_VERSION = 'bounty.v1' as const;
export const BOUNTY_CAPABILITIES = ['repository:read', 'target:observe', 'target:test', 'evidence:write', 'finding:draft'] as const;
const id = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const text = z.string().min(1).max(16_384);
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const instant = z.string().datetime({ offset: true });
const capability = z.enum(BOUNTY_CAPABILITIES);
const money = z.object({ currency: z.string().regex(/^[A-Z]{3}$/), minorUnits: z.number().int().safe().nonnegative().max(1_000_000_000) }).strict();
const citation = z.object({ sourceId: id, sourceHash: hash, locator: z.string().min(1).max(2048) }).strict();
const target = z.object({ kind: z.enum(['repository', 'url', 'service']), value: z.string().min(1).max(2048) }).strict();
const base = { version: z.literal(BOUNTY_CONTRACT_VERSION), id, issuedAt: instant };
const strict = <T extends z.ZodRawShape>(kind: string, shape: T) => z.object({ ...base, kind: z.literal(kind), ...shape }).strict();

export const ProgramSourceSchema = strict('programSource', { workspaceId: id, programId: id, uri: z.string().url().max(2048), contentHash: hash, retrievedAt: instant });
export const AdmissionSchema = strict('admission', { workspaceId: id, programId: id, sourceCitations: z.array(citation).min(1).max(64), decision: z.enum(['admit', 'reject']), reason: text });
export const ScopeSchema = strict('scope', { workspaceId: id, programId: id, targets: z.array(target).min(1).max(256), excludedTargets: z.array(target).max(256) });
export const GrantSchema = strict('grant', { missionId: id, capabilities: z.array(capability).min(1).max(BOUNTY_CAPABILITIES.length), expiresAt: instant });
export const BudgetSchema = strict('budget', { missionId: id, maximum: money, maxOperations: z.number().int().positive().max(100_000) });
export const CredentialSchema = strict('credential', { missionId: id, credentialRef: id, capabilities: z.array(capability).min(1).max(BOUNTY_CAPABILITIES.length), expiresAt: instant });
export const SkillSchema = strict('skill', { name: id, contentHash: hash });
export const WorkPackageSchema = strict('workPackage', {
  missionId: id,
  routeInputHash: hash,
  routeHash: hash,
  routePolicyHash: hash,
  objective: z.object({ id, objectiveClass: id, summaryHash: hash }).strict(),
  phase: id,
  role: id,
  targetTuples: z.array(z.object({ targetId: id, targetKind: z.enum(['repository', 'url', 'service']), targetHash: hash }).strict()).min(1).max(256),
  accountRoles: z.array(id).max(64),
  evidenceRefs: z.array(z.object({ evidenceId: id, evidenceType: id, evidenceHash: hash }).strict()).min(1).max(256),
  outputSchema: z.object({ schemaId: id, schemaHash: hash }).strict(),
  effectBudget: z.object({ maxOperations: z.number().int().nonnegative().max(100_000), maxCostCents: z.number().int().nonnegative().max(1_000_000_000), allowedCapabilities: z.array(capability).max(BOUNTY_CAPABILITIES.length) }).strict(),
  selectedHashes: z.array(hash).min(1).max(1024),
  contextCost: z.object({ selectedTokens: z.number().int().nonnegative(), evidenceTokens: z.number().int().nonnegative(), totalTokens: z.number().int().nonnegative().max(40_000) }).strict(),
  modelTier: z.enum(['standard', 'advanced']),
}).superRefine((value, ctx) => {
  if (value.contextCost.selectedTokens + value.contextCost.evidenceTokens !== value.contextCost.totalTokens) {
    ctx.addIssue({ code: 'custom', path: ['contextCost', 'totalTokens'], message: 'totalTokens must equal selectedTokens plus evidenceTokens' });
  }
});
export const ApprovalSchema = strict('approval', { missionId: id, workPackageId: id, approverId: id, decision: z.enum(['approved', 'denied']), expiresAt: instant });
export const OperationSchema = strict('operation', { missionId: id, workPackageId: id, capability, targetId: id, inputHash: hash });
export const EvidenceSchema = strict('evidence', { missionId: id, operationId: id, contentHash: hash, mediaType: z.string().min(1).max(128), byteLength: z.number().int().nonnegative().max(100_000_000) });
export const FindingSchema = strict('finding', { missionId: id, title: z.string().min(1).max(512), severity: z.enum(['low', 'medium', 'high', 'critical']), evidenceIds: z.array(id).min(1).max(256) });
export const DraftSchema = strict('draft', { missionId: id, findingId: id, content: text });
export const ReceiptSchema = strict('receipt', { missionId: id, operationId: id, outcome: z.enum(['succeeded', 'failed', 'denied']), outputHash: hash.optional() });

const missionShape = {
  workspaceId: id,
  programId: id,
  sourceCitations: z.array(citation).min(1).max(64),
  scope: z.object({ includedTargetIds: z.array(id).min(1).max(256), excludedTargetIds: z.array(id).max(256) }).strict(),
  capabilities: z.array(capability).min(1).max(BOUNTY_CAPABILITIES.length),
  skillHashes: z.array(hash).max(128),
  modelHash: hash,
  runtimeHash: hash,
  budget: z.object({ maximum: money, maxOperations: z.number().int().positive().max(100_000) }).strict(),
  retentionDays: z.number().int().positive().max(3650),
  expiresAt: instant,
};
export const MissionContractSchema = strict('mission', missionShape).superRefine((value, ctx) => {
  if (Date.parse(value.expiresAt) <= Date.parse(value.issuedAt) || Date.parse(value.expiresAt) <= Date.now()) ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: 'expiry must be future and after issuance' });
  if (new Set(value.capabilities).size !== value.capabilities.length) ctx.addIssue({ code: 'custom', path: ['capabilities'], message: 'capabilities must be unique' });
  const overlap = value.scope.includedTargetIds.some((entry) => value.scope.excludedTargetIds.includes(entry));
  if (overlap) ctx.addIssue({ code: 'custom', path: ['scope'], message: 'included and excluded scope contradict' });
});
export type MissionContract = z.infer<typeof MissionContractSchema>;
export const BountyContractSchema = z.union([MissionContractSchema, ProgramSourceSchema, AdmissionSchema, ScopeSchema, GrantSchema, BudgetSchema, CredentialSchema, SkillSchema, WorkPackageSchema, ApprovalSchema, OperationSchema, EvidenceSchema, FindingSchema, DraftSchema, ReceiptSchema]);

/** Build authority only from the trusted argument; untrusted content is strict and has no authority keys. */
export function issueMissionContract(authority: Pick<MissionContract, 'version' | 'kind' | 'id' | 'issuedAt' | 'workspaceId' | 'programId'>, content: Omit<MissionContract, keyof typeof authority>): MissionContract {
  return MissionContractSchema.parse({ ...content, ...authority });
}

function normalized(value: unknown, seen = new Set<object>()): unknown {
  if (value === null) return null;
  if (typeof value === 'string') return value.normalize('NFC');
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value) && !Number.isSafeInteger(value * 1e12)) throw new TypeError('numbers must be finite and bounded to 12 decimal places');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === 'boolean') return value;
  if (typeof value === 'undefined') throw new TypeError('undefined/absent values are not canonicalizable; omit object keys explicitly');
  if (typeof value !== 'object') throw new TypeError('unsupported canonical value');
  if (seen.has(value)) throw new TypeError('cyclic values are not canonicalizable');
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item) => normalized(item, seen));
    seen.delete(value);
    return result;
  }
  const result: Record<string, unknown> = {};
  const entries = Object.keys(value as object).map((key) => [key.normalize('NFC'), key] as const).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  for (const [canonicalKey, originalKey] of entries) {
    if (Object.hasOwn(result, canonicalKey)) throw new TypeError('duplicate key after Unicode normalization');
    result[canonicalKey] = normalized((value as Record<string, unknown>)[originalKey], seen);
  }
  seen.delete(value);
  return result;
}

/** Arrays retain order, object keys sort lexically, strings/keys use NFC, null is explicit, and absent values are rejected. */
export function canonicalizeBountyValue(value: unknown): string { return JSON.stringify(normalized(value)); }

/** Domain separation prevents the same bytes from being interchangeable between artifact kinds or versions. */
export function hashBountyContract(domain: string, value: unknown): string {
  if (!/^[a-z][a-zA-Z0-9.-]{0,63}$/.test(domain)) throw new TypeError('invalid hash domain');
  return `sha256:${createHash('sha256').update(`rorca:bounty:${BOUNTY_CONTRACT_VERSION}:${domain}\0`, 'utf8').update(canonicalizeBountyValue(value), 'utf8').digest('hex')}`;
}

/** JSON parser with a bounded input and duplicate-key rejection at every object depth. */
export function parseCanonicalJson(raw: string): unknown {
  if (Buffer.byteLength(raw, 'utf8') > 1_000_000) throw new TypeError('JSON exceeds 1 MB');
  let cursor = 0;
  const whitespace = () => { while (/\s/.test(raw[cursor] ?? '')) cursor += 1; };
  const string = (): string => {
    const start = cursor;
    if (raw[cursor++] !== '"') throw new SyntaxError('expected string');
    while (cursor < raw.length) {
      if (raw[cursor] === '\\') { cursor += 2; continue; }
      if (raw[cursor++] === '"') return JSON.parse(raw.slice(start, cursor)) as string;
    }
    throw new SyntaxError('unterminated string');
  };
  const value = (): void => {
    whitespace();
    if (raw[cursor] === '{') {
      cursor += 1; whitespace();
      const keys = new Set<string>();
      if (raw[cursor] === '}') { cursor += 1; return; }
      for (;;) {
        const key = string().normalize('NFC'); whitespace();
        if (keys.has(key)) throw new SyntaxError(`duplicate key: ${key}`);
        keys.add(key);
        if (raw[cursor++] !== ':') throw new SyntaxError('expected colon');
        value(); whitespace();
        if (raw[cursor] === '}') { cursor += 1; return; }
        if (raw[cursor++] !== ',') throw new SyntaxError('expected comma');
        whitespace();
      }
    }
    if (raw[cursor] === '[') {
      cursor += 1; whitespace();
      if (raw[cursor] === ']') { cursor += 1; return; }
      for (;;) { value(); whitespace(); if (raw[cursor] === ']') { cursor += 1; return; } if (raw[cursor++] !== ',') throw new SyntaxError('expected comma'); }
    }
    if (raw[cursor] === '"') { string(); return; }
    const match = raw.slice(cursor).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
    if (!match) throw new SyntaxError('invalid JSON value');
    cursor += match[0].length;
  };
  value(); whitespace();
  if (cursor !== raw.length) throw new SyntaxError('trailing JSON content');
  return JSON.parse(raw) as unknown;
}
