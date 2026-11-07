/** Copyright (c) 2026 Rorca Inc. SPDX-License-Identifier: Apache-2.0 */
import { createPublicKey, verify } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import { hashBountyContract } from './bounty-contracts';
import { ForbiddenError, UnprocessableError, ValidationError } from './errors';
import { authorizeObservation, normalizeHost, type PolicyAdmission } from './bounty-scope';

const HASH = /^sha256:[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECEIPT_ROLES = ['legal', 'security', 'operator'] as const;
export type CanaryAuthorizationRole = typeof RECEIPT_ROLES[number];

const HashSchema = z.string().regex(HASH);
const IdSchema = z.string().trim().min(1).max(256);
const ScopeRuleSchema = z.object({
  effect: z.enum(['allow', 'deny']), scheme: z.enum(['http', 'https']), host: z.string(),
  port: z.number().int().min(1).max(65535), path: z.string(),
  methods: z.array(z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])),
  actions: z.array(z.enum(['observe', 'test', 'authenticate', 'submit'])), accountRoles: z.array(z.string()),
  query: z.object({ allowedKeys: z.array(z.string()), allowRepeated: z.boolean() }).strict().optional(),
}).strict();
const PolicyAdmissionSchema = z.object({
  workspaceId: IdSchema, programId: IdSchema, effectiveFrom: z.string().datetime({ offset: true }),
  effectiveUntil: z.string().datetime({ offset: true }).optional(),
  sourceHashes: z.array(z.object({ sourceId: IdSchema, hash: HashSchema }).strict()).min(1),
  assertion: z.object({ assertionId: IdSchema, humanId: IdSchema, authenticatedAt: z.string().datetime({ offset: true }), revokedAt: z.string().datetime({ offset: true }).optional() }).strict(),
  rules: z.array(ScopeRuleSchema).min(1), limits: z.object({ requestsPerMinute: z.number().int().positive(), maximumDataBytes: z.number().int().positive() }).strict(),
  generation: z.number().int().positive(), status: z.enum(['admitted', 'hold']), contractHash: HashSchema,
}).strict();
const SignedAuthorizationSchema = z.object({
  receiptId: z.string().uuid(), role: z.enum(RECEIPT_ROLES), signerId: IdSchema,
  authorizationHash: HashSchema, issuedAt: z.string().datetime({ offset: true }), expiresAt: z.string().datetime({ offset: true }),
  publicKeyPem: z.string().min(32).max(8192), signature: z.string().min(16).max(8192),
}).strict();
const TargetSchema = z.object({
  targetId: IdSchema, provenance: z.literal('external-program'), fixture: z.literal(false), url: z.string().url().max(2048),
  method: z.enum(['GET', 'HEAD']), action: z.literal('observe'), accountRole: IdSchema.optional(),
  resolvedAddresses: z.array(z.string()).min(1).max(16),
}).strict();
const BudgetSchema = z.object({
  requests: z.number().int().positive().max(5), callbacks: z.number().int().nonnegative().max(1),
  tools: z.number().int().positive().max(5), wallTimeMs: z.number().int().positive().max(600_000),
  costCents: z.number().int().nonnegative().max(100), concurrency: z.literal(1), targetEffects: z.literal(1),
}).strict();
const QualificationSchema = z.object({
  receiptId: IdSchema, mode: z.literal('release'), liveExternalEligible: z.literal(true), qualifiedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }), sourceSha: z.string().regex(/^[0-9a-f]{40,64}$/), bindingHash: HashSchema,
}).strict();
const LaunchPacketSchema = z.object({
  version: z.literal('bounty.canary-launch.v1'), workspaceId: IdSchema, programId: IdSchema, missionId: z.string().uuid(),
  qualification: QualificationSchema, policy: PolicyAdmissionSchema,
  policyAuthority: z.object({
    kind: z.literal('external-program'), policyUrl: z.string().url(), authorityExpiresAt: z.string().datetime({ offset: true }),
    approvedTargets: z.array(z.object({ targetId: IdSchema, targetHash: HashSchema }).strict()).min(1).max(64),
  }).strict(),
  target: TargetSchema,
  accounts: z.array(z.object({ accountId: IdSchema, role: IdSchema }).strict()).min(1).max(8),
  budgets: BudgetSchema,
  skills: z.array(z.object({ name: IdSchema, contentHash: HashSchema }).strict()).min(1).max(16),
  modelRuntime: z.object({ model: IdSchema, modelHash: HashSchema, runtime: IdSchema, runtimeHash: HashSchema }).strict(),
  retention: z.object({ policyId: IdSchema, evidenceExpiresAt: z.string().datetime({ offset: true }), deleteOnClose: z.boolean() }).strict(),
  emergencyContacts: z.array(z.object({ contactId: IdSchema, duty: z.enum(RECEIPT_ROLES), channelHash: HashSchema }).strict()).length(3),
  authorizationReceipts: z.array(SignedAuthorizationSchema).length(3),
}).strict();

export type CanaryLaunchPacket = z.infer<typeof LaunchPacketSchema>;
export type CanarySignedAuthorization = z.infer<typeof SignedAuthorizationSchema>;
export type CanaryBudget = z.infer<typeof BudgetSchema>;
export interface CanaryTrustPolicy { trustedSignerKeyHashes: Record<CanaryAuthorizationRole, readonly string[]> }
/** Load only key fingerprints provisioned by the operator; absent/invalid roots authorize nobody. */
export function loadCanaryTrustPolicy(env: NodeJS.ProcessEnv = process.env): CanaryTrustPolicy {
  const variable: Record<CanaryAuthorizationRole, string> = {
    legal: 'RORCA_BOUNTY_CANARY_LEGAL_KEY_HASHES', security: 'RORCA_BOUNTY_CANARY_SECURITY_KEY_HASHES', operator: 'RORCA_BOUNTY_CANARY_OPERATOR_KEY_HASHES',
  };
  const hashes = (role: CanaryAuthorizationRole): string[] => String(env[variable[role]] ?? '')
    .split(',').map((value) => value.trim()).filter((value) => HASH.test(value));
  return { trustedSignerKeyHashes: { legal: hashes('legal'), security: hashes('security'), operator: hashes('operator') } };
}

export interface CanaryTimelineEvent {
  sequence: number; type: 'authorization.admitted' | 'operation.brokered' | 'mission.paused' | 'mission.killed' | 'budget.increased' | 'mission.closed';
  occurredAt: string; evidenceHash: string; authorityEpoch: number;
}
export interface CanaryOperationProof {
  operationId: string; channel: 'broker'; workerDirectEffectPath: false; kind: 'canary.observe';
  authorityEpoch: number; state: 'observed' | 'cancelled-before-send'; brokerReceiptHash: string; evidenceHash: string;
}
export interface CanaryMissionRecord {
  launchId: string; workspaceId: string; programId: string; missionId: string; authorizationHash: string; qualificationReceiptId: string;
  policyCitation: { contractHash: string; sourceHashes: ReadonlyArray<{ sourceId: string; hash: string }>; policyUrl: string; targetId: string };
  state: 'active' | 'paused' | 'killed' | 'completed' | 'stopped' | 'no-finding'; epoch: number;
  budget: CanaryBudget; budgetIncreaseCount: number; operations: readonly CanaryOperationProof[]; timeline: readonly CanaryTimelineEvent[];
  authorizationReceipts: readonly CanarySignedAuthorization[];
}

function fail(message: string): never { throw new ForbiddenError(message); }
function timestamp(value: string, label: string): number {
  const parsed = Date.parse(value); if (!Number.isFinite(parsed)) throw new ValidationError(`${label} is invalid`); return parsed;
}
export function canarySignerKeyHash(publicKeyPem: string): string {
  try {
    const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
    return hashBountyContract('canary-trusted-public-key', der.toString('base64'));
  } catch { throw new ValidationError('Canary authorization public key is invalid'); }
}
function verifyReceipt(receipt: CanarySignedAuthorization, trust: CanaryTrustPolicy, authorizationHash: string, now: number): void {
  if (receipt.authorizationHash !== authorizationHash) fail(`${receipt.role} receipt targets different launch authority`);
  if (timestamp(receipt.issuedAt, `${receipt.role} receipt issue time`) > now || timestamp(receipt.expiresAt, `${receipt.role} receipt expiry`) <= now) fail(`${receipt.role} receipt is not current`);
  const keyHash = canarySignerKeyHash(receipt.publicKeyPem);
  if (!trust.trustedSignerKeyHashes[receipt.role]?.includes(keyHash)) fail(`${receipt.role} signer is not trusted`);
  let valid = false;
  try { valid = verify(null, Buffer.from(authorizationHash, 'utf8'), receipt.publicKeyPem, Buffer.from(receipt.signature, 'base64')); } catch { valid = false; }
  if (!valid) fail(`${receipt.role} receipt signature is invalid`);
}
function ipv4Octets(address: string): number[] | undefined {
  if (isIP(address) !== 4) return undefined;
  const octets = address.split('.').map(Number);
  return octets.length === 4 && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) ? octets : undefined;
}
/** Reject every non-public destination class before broker DNS/redirect rechecks. */
export function isForbiddenCanaryAddress(address: string): boolean {
  const normalized = address.trim().toLowerCase();
  const octets = ipv4Octets(normalized);
  if (octets) {
    const [a, b, c, d] = octets;
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) ||
      (a === 203 && b === 0 && c === 113) || (a === 255 && b === 255 && c === 255 && d === 255);
  }
  if (isIP(normalized) !== 6) return true;
  const plain = normalized.replace(/^\[|\]$/g, '');
  return plain === '::' || plain === '::1' || plain.startsWith('fc') || plain.startsWith('fd') ||
    /^f[89ab][0-9a-f]:/.test(plain) || plain.startsWith('fe8') || plain.startsWith('fe9') || plain.startsWith('fea') || plain.startsWith('feb') ||
    plain.startsWith('2001:db8:') || plain.startsWith('ff') || plain.startsWith('::ffff:');
}
function assertExternalTarget(packet: CanaryLaunchPacket, now: number): void {
  const target = packet.target;
  let url: URL; try { url = new URL(target.url); } catch { return fail('Canary target URL is invalid'); }
  let host: string; try { host = normalizeHost(url.hostname); } catch { return fail('Canary target host is ambiguous'); }
  const canonical = `${url.protocol}//${host}${url.port ? `:${url.port}` : ''}${url.pathname}${url.search}`;
  if (target.url !== canonical || url.username || url.password || url.hash) fail('Canary target URL is ambiguous or non-canonical');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.test') ||
      host === 'example.com' || host === 'example.net' || host === 'example.org' || target.targetId.toLowerCase().includes('fixture')) fail('Fixture and local canary targets are forbidden');
  if (target.resolvedAddresses.some(isForbiddenCanaryAddress)) fail('Private, link-local, metadata, reserved, or ambiguous target address is forbidden');
  if (packet.policy.status !== 'admitted' || timestamp(packet.policy.effectiveFrom, 'policy effectiveFrom') > now ||
      !packet.policy.effectiveUntil || timestamp(packet.policy.effectiveUntil, 'policy effectiveUntil') <= now ||
      timestamp(packet.policyAuthority.authorityExpiresAt, 'policy authority expiry') <= now) fail('Program policy is absent, held, or expired');
  if (packet.policy.workspaceId !== packet.workspaceId || packet.policy.programId !== packet.programId || packet.policy.assertion.revokedAt) fail('Program policy authority does not match the mission');
  if (packet.policy.sourceHashes.some((source) => /fixture|sample|test/i.test(source.sourceId))) fail('Fixture policy sources cannot authorize a canary');
  let policyUrl: URL; try { policyUrl = new URL(packet.policyAuthority.policyUrl); } catch { return fail('External policy citation is invalid'); }
  if (policyUrl.protocol !== 'https:' || /(?:^|\.)(?:localhost|local|test)$/.test(policyUrl.hostname)) fail('External policy citation must be a public HTTPS URL');
  const targetHash = hashBountyContract('canary-approved-target', { targetId: target.targetId, url: target.url, method: target.method, action: target.action, accountRole: target.accountRole ?? null });
  if (!packet.policyAuthority.approvedTargets.some((approved) => approved.targetId === target.targetId && approved.targetHash === targetHash)) fail('Canary target is not explicitly approved by the admitted policy');
  if (!authorizeObservation(packet.policy as PolicyAdmission, { workspaceId: packet.workspaceId, programId: packet.programId, generation: packet.policy.generation, url: target.url, method: target.method, action: target.action, accountRole: target.accountRole })) fail('Canary target is outside the admitted policy scope');
}

export function canaryLaunchAuthorizationHash(packet: Omit<CanaryLaunchPacket, 'authorizationReceipts'>): string {
  return hashBountyContract('canary-launch-authorization', packet);
}

/** Fail-closed launch gate. No trust roots means no launch. */
export function authorizeCanaryLaunch(candidate: unknown, trust: CanaryTrustPolicy, at = new Date()): CanaryMissionRecord {
  const parsed = LaunchPacketSchema.safeParse(candidate);
  if (!parsed.success) throw new ValidationError('Canary launch contract is incomplete or malformed', { issues: parsed.error.issues });
  const packet = parsed.data;
  const now = at.getTime(); if (!Number.isFinite(now)) throw new ValidationError('Canary launch time is invalid');
  if (timestamp(packet.qualification.qualifiedAt, 'qualification time') > now || timestamp(packet.qualification.expiresAt, 'qualification expiry') <= now) fail('Release qualification is expired or not current');
  if (new Set(packet.accounts.map((account) => `${account.accountId}:${account.role}`)).size !== packet.accounts.length) fail('Target accounts must be distinct');
  if (new Set(packet.emergencyContacts.map((contact) => contact.duty)).size !== RECEIPT_ROLES.length || new Set(packet.emergencyContacts.map((contact) => contact.contactId)).size !== RECEIPT_ROLES.length) fail('Distinct legal, security, and operator emergency contacts are required');
  if (timestamp(packet.retention.evidenceExpiresAt, 'retention expiry') <= now) fail('Evidence retention policy is expired');
  assertExternalTarget(packet, now);
  const { authorizationReceipts: _receipts, ...unsigned } = packet;
  const authorizationHash = canaryLaunchAuthorizationHash(unsigned);
  if (new Set(packet.authorizationReceipts.map((receipt) => receipt.role)).size !== RECEIPT_ROLES.length ||
      new Set(packet.authorizationReceipts.map((receipt) => receipt.signerId)).size !== RECEIPT_ROLES.length ||
      new Set(packet.authorizationReceipts.map((receipt) => receipt.receiptId)).size !== RECEIPT_ROLES.length) fail('Distinct legal, security, and operator receipts are required');
  for (const role of RECEIPT_ROLES) {
    const receipt = packet.authorizationReceipts.find((item) => item.role === role);
    if (!receipt) fail(`${role} receipt is required`);
    verifyReceipt(receipt, trust, authorizationHash, now);
  }
  const launchId = hashBountyContract('canary-launch-receipt', { missionId: packet.missionId, authorizationHash });
  const timeline: readonly CanaryTimelineEvent[] = [{ sequence: 1, type: 'authorization.admitted', occurredAt: at.toISOString(), evidenceHash: authorizationHash, authorityEpoch: 1 }];
  return Object.freeze({
    launchId, workspaceId: packet.workspaceId, programId: packet.programId, missionId: packet.missionId, authorizationHash, qualificationReceiptId: packet.qualification.receiptId,
    policyCitation: { contractHash: packet.policy.contractHash, sourceHashes: packet.policy.sourceHashes, policyUrl: packet.policyAuthority.policyUrl, targetId: packet.target.targetId },
    state: 'active', epoch: 1, budget: packet.budgets, budgetIncreaseCount: 0, operations: [], authorizationReceipts: packet.authorizationReceipts,
    timeline,
  });
}

function appendEvent(record: CanaryMissionRecord, event: Omit<CanaryTimelineEvent, 'sequence'>): readonly CanaryTimelineEvent[] {
  return [...record.timeline, { ...event, sequence: record.timeline.length + 1 }];
}
/** Admit only an observed, broker-signed canary operation; workers have no direct effect path. */
export function recordBrokeredCanaryOperation(record: CanaryMissionRecord, proof: CanaryOperationProof, at = new Date()): CanaryMissionRecord {
  if (record.state !== 'active' || proof.authorityEpoch !== record.epoch) throw new ForbiddenError('Canary operation authority is stale');
  if (proof.channel !== 'broker' || proof.workerDirectEffectPath !== false || proof.kind !== 'canary.observe' || proof.state !== 'observed' || !UUID.test(proof.operationId) || !HASH.test(proof.brokerReceiptHash) || !HASH.test(proof.evidenceHash)) throw new ValidationError('Canary operation lacks broker-only observed evidence');
  if (record.operations.length >= record.budget.targetEffects) throw new ForbiddenError('Canary target-effect budget is exhausted');
  return Object.freeze({ ...record, operations: [...record.operations, Object.freeze(proof)], timeline: appendEvent(record, { type: 'operation.brokered', occurredAt: at.toISOString(), evidenceHash: proof.brokerReceiptHash, authorityEpoch: record.epoch }) });
}
/** Pause/kill establishes a new authority epoch before any optional budget increase. */
export function exerciseCanaryFence(record: CanaryMissionRecord, action: 'pause' | 'kill', receiptHash: string, at = new Date()): CanaryMissionRecord {
  if (record.state !== 'active' || !HASH.test(receiptHash)) throw new UnprocessableError('Canary fence requires an active mission and durable receipt', 'CANARY_FENCE_INVALID');
  const epoch = record.epoch + 1;
  return Object.freeze({ ...record, state: action === 'pause' ? 'paused' : 'killed', epoch, timeline: appendEvent(record, { type: action === 'pause' ? 'mission.paused' : 'mission.killed', occurredAt: at.toISOString(), evidenceHash: receiptHash, authorityEpoch: epoch }) });
}
/** Stale post-fence worker output returns the exact record unchanged. */
export function applyCanaryWorkerOutput(record: CanaryMissionRecord, output: { authorityEpoch: number; evidenceHash: string }, at = new Date()): CanaryMissionRecord {
  if (record.state !== 'active' || output.authorityEpoch !== record.epoch) return record;
  if (!HASH.test(output.evidenceHash)) throw new ValidationError('Worker output evidence hash is invalid');
  return Object.freeze({ ...record, timeline: appendEvent(record, { type: 'operation.brokered', occurredAt: at.toISOString(), evidenceHash: output.evidenceHash, authorityEpoch: record.epoch }) });
}
export function increaseCanaryBudget(record: CanaryMissionRecord, budget: CanaryBudget, approvalHash: string, at = new Date()): CanaryMissionRecord {
  if (!record.timeline.some((event) => event.type === 'mission.paused' || event.type === 'mission.killed')) throw new ForbiddenError('Pause or kill must be exercised before a canary budget increase');
  if (record.state === 'killed' || !HASH.test(approvalHash)) throw new ForbiddenError('Killed missions cannot increase budget');
  const parsed = BudgetSchema.parse(budget);
  return Object.freeze({ ...record, budget: parsed, budgetIncreaseCount: record.budgetIncreaseCount + 1, timeline: appendEvent(record, { type: 'budget.increased', occurredAt: at.toISOString(), evidenceHash: approvalHash, authorityEpoch: record.epoch }) });
}

export interface CanaryCloseoutSummary {
  terminalState: 'completed' | 'stopped' | 'no-finding'; effects: readonly { operationId: string; state: 'observed' | 'cancelled-before-send'; receiptHash: string }[];
  budgets: { authorized: CanaryBudget; used: Record<keyof CanaryBudget, number>; increases: number };
  holds: { opened: number; resolved: number; unresolved: 0 }; evidenceHashes: readonly string[]; findingIds: readonly string[]; draftIds: readonly string[];
  incidents: readonly { incidentId: string; status: 'resolved' }[]; rollback: { required: boolean; state: 'not-required' | 'completed'; complete: true };
  leases: readonly { leaseId: string; closed: true }[]; unresolvedOperations: readonly never[];
  authorizationAudit: { launchAuthorizationHash: string; policyContractHash: string; qualificationReceiptId: string; legalReceiptId: string; securityReceiptId: string; operatorReceiptId: string };
}
export interface SignedCanaryCloseout { closeoutId: string; summary: CanaryCloseoutSummary; closeoutHash: string; operatorReceipt: CanarySignedAuthorization }
/** Verify terminal reconciliation and a fresh operator signature over the exact closeout. */
export function closeCanaryMission(record: CanaryMissionRecord, summary: CanaryCloseoutSummary, operatorReceipt: CanarySignedAuthorization, trust: CanaryTrustPolicy, at = new Date()): { mission: CanaryMissionRecord; closeout: SignedCanaryCloseout } {
  if (!record.timeline.some((event) => event.type === 'mission.paused' || event.type === 'mission.killed')) throw new ForbiddenError('Canary pause or kill was not exercised');
  if (record.operations.length < 1 || record.operations.some((operation) => !['observed', 'cancelled-before-send'].includes(operation.state))) throw new ForbiddenError('Canary operations are unresolved');
  if (summary.unresolvedOperations.length || summary.leases.some((lease) => lease.closed !== true) || summary.holds.unresolved !== 0 || summary.holds.resolved !== summary.holds.opened) throw new ForbiddenError('Closeout has open leases, holds, or operations');
  if (summary.effects.length !== record.operations.length || summary.effects.some((effect) => !record.operations.some((operation) => operation.operationId === effect.operationId && operation.state === effect.state && operation.brokerReceiptHash === effect.receiptHash))) throw new ValidationError('Closeout effects do not match brokered operations');
  if (summary.budgets.increases !== record.budgetIncreaseCount || hashBountyContract('canary-budget', summary.budgets.authorized) !== hashBountyContract('canary-budget', record.budget)) throw new ValidationError('Closeout budget accounting does not match mission authority');
  if (Object.entries(summary.budgets.used).some(([key, used]) => !Number.isFinite(used) || used < 0 || used > record.budget[key as keyof CanaryBudget])) throw new ValidationError('Closeout budget usage is invalid');
  if (summary.evidenceHashes.some((hash) => !HASH.test(hash)) || record.operations.some((operation) => !summary.evidenceHashes.includes(operation.evidenceHash)) || summary.effects.some((effect) => !HASH.test(effect.receiptHash)) || summary.rollback.required === (summary.rollback.state === 'not-required')) throw new ValidationError('Closeout evidence or rollback accounting is invalid');
  const launchRoles = Object.fromEntries(record.authorizationReceipts.map((receipt) => [receipt.role, receipt.receiptId])) as Record<CanaryAuthorizationRole, string>;
  const expectedAudit = { launchAuthorizationHash: record.authorizationHash, policyContractHash: record.policyCitation.contractHash, qualificationReceiptId: record.qualificationReceiptId, legalReceiptId: launchRoles.legal, securityReceiptId: launchRoles.security, operatorReceiptId: launchRoles.operator };
  if (hashBountyContract('canary-authorization-audit', summary.authorizationAudit) !== hashBountyContract('canary-authorization-audit', expectedAudit)) throw new ValidationError('Closeout authorization audit is incomplete or mismatched');
  const closeoutHash = hashBountyContract('canary-closeout', { missionId: record.missionId, epoch: record.epoch, summary });
  if (operatorReceipt.role !== 'operator' || operatorReceipt.authorizationHash !== closeoutHash || operatorReceipt.signerId !== record.authorizationReceipts.find((receipt) => receipt.role === 'operator')?.signerId) throw new ForbiddenError('Closeout is not signed by the launch operator');
  verifyReceipt(operatorReceipt, trust, closeoutHash, at.getTime());
  const closeoutId = hashBountyContract('canary-closeout-receipt', { closeoutHash, receiptId: operatorReceipt.receiptId });
  const mission = Object.freeze({ ...record, state: summary.terminalState, timeline: appendEvent(record, { type: 'mission.closed', occurredAt: at.toISOString(), evidenceHash: closeoutHash, authorityEpoch: record.epoch }) });
  return { mission, closeout: Object.freeze({ closeoutId, summary, closeoutHash, operatorReceipt }) };
}
