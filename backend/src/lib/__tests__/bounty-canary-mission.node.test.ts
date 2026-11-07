/** Copyright (c) 2026 Rorca Inc. SPDX-License-Identifier: Apache-2.0 */
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { test } from 'node:test';
import { hashBountyContract } from '../bounty-contracts';
import {
  applyCanaryWorkerOutput,
  authorizeCanaryLaunch,
  canaryLaunchAuthorizationHash,
  canarySignerKeyHash,
  closeCanaryMission,
  exerciseCanaryFence,
  increaseCanaryBudget,
  isForbiddenCanaryAddress,
  recordBrokeredCanaryOperation,
  type CanaryAuthorizationRole,
  type CanaryCloseoutSummary,
  type CanaryLaunchPacket,
  type CanarySignedAuthorization,
  type CanaryTrustPolicy,
} from '../bounty-canary-mission';
import { admitProgramPolicy } from '../bounty-scope';

const now = new Date('2026-08-03T12:00:00.000Z');
const digest = (seed: string): string => `sha256:${createHash('sha256').update(seed).digest('hex')}`;
const roles = ['legal', 'security', 'operator'] as const;
const keys = Object.fromEntries(roles.map((role) => {
  const pair = generateKeyPairSync('ed25519');
  return [role, { privateKey: pair.privateKey, publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }];
})) as Record<CanaryAuthorizationRole, { privateKey: KeyObject; publicKeyPem: string }>;
const trust: CanaryTrustPolicy = { trustedSignerKeyHashes: Object.fromEntries(roles.map((role) => [role, [canarySignerKeyHash(keys[role].publicKeyPem)]])) as CanaryTrustPolicy['trustedSignerKeyHashes'] };

function signed(role: CanaryAuthorizationRole, authorizationHash: string, overrides: Partial<CanarySignedAuthorization> = {}): CanarySignedAuthorization {
  return {
    receiptId: randomUUID(), role, signerId: `${role}-authority`, authorizationHash,
    issuedAt: '2026-08-03T11:55:00.000Z', expiresAt: '2026-08-03T12:30:00.000Z',
    publicKeyPem: keys[role].publicKeyPem,
    signature: sign(null, Buffer.from(authorizationHash, 'utf8'), keys[role].privateKey).toString('base64'),
    ...overrides,
  };
}
function packet(mutate?: (candidate: Record<string, unknown>) => void): CanaryLaunchPacket {
  const policyBytes = 'ACME external bounty policy revision 7; canary.acme-security.com /health is approved for one GET observation.';
  const policy = structuredClone(admitProgramPolicy({
    workspaceId: 'workspace-canary', programId: 'program-acme', effectiveFrom: '2026-08-03T00:00:00.000Z', effectiveUntil: '2026-08-04T00:00:00.000Z', generation: 7,
    sources: [{ sourceId: 'acme-policy-r7', bytes: policyBytes, claimedHash: digest(policyBytes) }],
    assertion: { assertionId: 'provider-assertion-7', humanId: 'acme-program-owner', authenticatedAt: '2026-08-03T11:30:00.000Z' },
    limits: { requestsPerMinute: 1, maximumDataBytes: 4096 },
    rules: [{ effect: 'allow', scheme: 'https', host: 'canary.acme-security.com', path: '/health', methods: ['GET'], actions: ['observe'], accountRoles: ['canary-reader'] }],
  }));
  const target = { targetId: 'acme-health-canary', provenance: 'external-program' as const, fixture: false as const, url: 'https://canary.acme-security.com/health', method: 'GET' as const, action: 'observe' as const, accountRole: 'canary-reader', resolvedAddresses: ['8.8.8.8'] };
  const targetHash = hashBountyContract('canary-approved-target', { targetId: target.targetId, url: target.url, method: target.method, action: target.action, accountRole: target.accountRole });
  const unsigned = {
    version: 'bounty.canary-launch.v1' as const, workspaceId: 'workspace-canary', programId: 'program-acme', missionId: randomUUID(),
    qualification: { receiptId: 'release-qualification-20260803', mode: 'release' as const, liveExternalEligible: true as const, qualifiedAt: '2026-08-03T10:00:00.000Z', expiresAt: '2026-08-04T00:00:00.000Z', sourceSha: 'a'.repeat(40), bindingHash: digest('release-bindings') },
    policy,
    policyAuthority: { kind: 'external-program' as const, policyUrl: 'https://security.acme-security.com/bounty/policy', authorityExpiresAt: '2026-08-04T00:00:00.000Z', approvedTargets: [{ targetId: target.targetId, targetHash }] },
    target, accounts: [{ accountId: 'provider-canary-account', role: 'canary-reader' }],
    budgets: { requests: 1, callbacks: 0, tools: 1, wallTimeMs: 60_000, costCents: 5, concurrency: 1 as const, targetEffects: 1 as const },
    skills: [{ name: 'safe-http-observation', contentHash: digest('skill') }],
    modelRuntime: { model: 'pinned-canary-model', modelHash: digest('model'), runtime: 'bwrap-v1', runtimeHash: digest('runtime') },
    retention: { policyId: 'retention-30d', evidenceExpiresAt: '2026-09-02T12:00:00.000Z', deleteOnClose: false },
    emergencyContacts: roles.map((duty) => ({ contactId: `${duty}-on-call`, duty, channelHash: digest(`${duty}-channel`) })),
  };
  mutate?.(unsigned as unknown as Record<string, unknown>);
  const authorizationHash = canaryLaunchAuthorizationHash(unsigned as Omit<CanaryLaunchPacket, 'authorizationReceipts'>);
  return { ...unsigned, authorizationReceipts: roles.map((role) => signed(role, authorizationHash)) } as CanaryLaunchPacket;
}

function summary(record: ReturnType<typeof authorizeCanaryLaunch>): CanaryCloseoutSummary {
  return {
    terminalState: 'no-finding',
    effects: record.operations.map((operation) => ({ operationId: operation.operationId, state: operation.state, receiptHash: operation.brokerReceiptHash })),
    budgets: { authorized: record.budget, used: { requests: 1, callbacks: 0, tools: 1, wallTimeMs: 1_000, costCents: 1, concurrency: 1, targetEffects: 1 }, increases: record.budgetIncreaseCount },
    holds: { opened: 0, resolved: 0, unresolved: 0 }, evidenceHashes: record.operations.map((operation) => operation.evidenceHash),
    findingIds: [], draftIds: [], incidents: [], rollback: { required: false, state: 'not-required', complete: true },
    leases: [{ leaseId: 'canary-lease-1', closed: true }], unresolvedOperations: [],
    authorizationAudit: {
      launchAuthorizationHash: record.authorizationHash, policyContractHash: record.policyCitation.contractHash, qualificationReceiptId: record.qualificationReceiptId,
      legalReceiptId: record.authorizationReceipts.find((receipt) => receipt.role === 'legal')!.receiptId,
      securityReceiptId: record.authorizationReceipts.find((receipt) => receipt.role === 'security')!.receiptId,
      operatorReceiptId: record.authorizationReceipts.find((receipt) => receipt.role === 'operator')!.receiptId,
    },
  } as CanaryCloseoutSummary;
}

test('launch rejects fixtures, local/private/metadata, expired, ambiguous, and non-approved targets', () => {
  const cases: Array<[string, (candidate: Record<string, unknown>) => void, RegExp]> = [
    ['fixture', (candidate) => { (candidate.target as Record<string, unknown>).fixture = true; }, /malformed|fixture/i],
    ['localhost', (candidate) => { (candidate.target as Record<string, unknown>).url = 'https://localhost/health'; }, /local|ambiguous/i],
    ['private', (candidate) => { (candidate.target as Record<string, unknown>).resolvedAddresses = ['10.0.0.8']; }, /private|reserved/i],
    ['metadata', (candidate) => { (candidate.target as Record<string, unknown>).resolvedAddresses = ['169.254.169.254']; }, /private|metadata|reserved/i],
    ['expired', (candidate) => { (candidate.policy as Record<string, unknown>).effectiveUntil = '2026-08-03T11:59:59.000Z'; }, /expired/i],
    ['ambiguous', (candidate) => { (candidate.target as Record<string, unknown>).url = 'https://CANARY.acme-security.com/health'; }, /ambiguous/i],
    ['not-approved', (candidate) => { (candidate.policyAuthority as Record<string, unknown>).approvedTargets = [{ targetId: 'acme-health-canary', targetHash: digest('different-target') }]; }, /approved/i],
  ];
  for (const [name, mutate, expected] of cases) assert.throws(() => authorizeCanaryLaunch(packet(mutate), trust, now), expected, name);
  for (const address of ['127.0.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fe80::1', 'fd00::1', '2001:db8::1', '::ffff:192.168.1.1', 'ff02::1']) assert.equal(isForbiddenCanaryAddress(address), true, address);
  assert.equal(isForbiddenCanaryAddress('8.8.8.8'), false);
});

test('launch requires current distinct legal, security, and operator receipts rooted in configured trust', () => {
  const candidate = packet();
  assert.throws(() => authorizeCanaryLaunch(candidate, { trustedSignerKeyHashes: { legal: [], security: [], operator: [] } }, now), /not trusted/);
  candidate.authorizationReceipts[1] = { ...candidate.authorizationReceipts[0], role: 'security' };
  assert.throws(() => authorizeCanaryLaunch(candidate, trust, now), /distinct/i);
  const expired = packet(); expired.authorizationReceipts[2] = signed('operator', expired.authorizationReceipts[2].authorizationHash, { expiresAt: now.toISOString() });
  assert.throws(() => authorizeCanaryLaunch(expired, trust, now), /not current/);
});

test('one brokered canary, pause fence, stale output, and signed no-finding closeout are auditable', () => {
  let mission = authorizeCanaryLaunch(packet(), trust, now);
  assert.equal(mission.policyCitation.targetId, 'acme-health-canary');
  assert.equal(mission.timeline[0].type, 'authorization.admitted');
  assert.throws(() => increaseCanaryBudget(mission, mission.budget, digest('increase'), now), /pause or kill/i);

  mission = recordBrokeredCanaryOperation(mission, {
    operationId: randomUUID(), channel: 'broker', workerDirectEffectPath: false, kind: 'canary.observe', authorityEpoch: 1,
    state: 'observed', brokerReceiptHash: digest('broker-receipt'), evidenceHash: digest('redacted-canary-evidence'),
  }, now);
  assert.equal(mission.timeline.at(-1)?.type, 'operation.brokered');
  assert.throws(() => recordBrokeredCanaryOperation(mission, { ...mission.operations[0], operationId: randomUUID() }, now), /budget/);

  const preFenceEpoch = mission.epoch;
  mission = exerciseCanaryFence(mission, 'pause', digest('pause-receipt'), now);
  const staleResult = applyCanaryWorkerOutput(mission, { authorityEpoch: preFenceEpoch, evidenceHash: digest('post-fence-output') }, now);
  assert.strictEqual(staleResult, mission);
  assert.equal(mission.timeline.some((event) => event.evidenceHash === digest('post-fence-output')), false);

  const closeoutSummary = summary(mission);
  const closeoutHash = hashBountyContract('canary-closeout', { missionId: mission.missionId, epoch: mission.epoch, summary: closeoutSummary });
  const mismatched = structuredClone(closeoutSummary);
  mismatched.effects[0].receiptHash = digest('different-broker-receipt');
  const mismatchedHash = hashBountyContract('canary-closeout', { missionId: mission.missionId, epoch: mission.epoch, summary: mismatched });
  assert.throws(() => closeCanaryMission(mission, mismatched, signed('operator', mismatchedHash), trust, now), /effects do not match/);
  const result = closeCanaryMission(mission, closeoutSummary, signed('operator', closeoutHash), trust, now);
  assert.equal(result.mission.state, 'no-finding');
  assert.equal(result.mission.timeline.at(-1)?.type, 'mission.closed');
  assert.equal(result.closeout.summary.leases.every((lease) => lease.closed), true);
  assert.equal(result.closeout.summary.unresolvedOperations.length, 0);
  assert.deepEqual(result.closeout.summary.findingIds, []);
});
