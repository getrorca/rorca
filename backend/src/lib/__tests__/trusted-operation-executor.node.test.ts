/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EXECUTION_AUTHORITY_SCHEMA_VERSION,
  type AuthorityGrantRecord,
  type AuthorityRequestRecord,
  type CredentialLeaseRecord,
  type ExecutionAttemptRecord,
  type ExecutionReceiptRecord,
  type OperationIntentRecord,
  type ProviderBindingRecord,
  type ReserveExecutionAttemptInput,
  type SettleExecutionReceiptInput,
} from '../../db/execution-authority';
import { authorityDigest } from '../execution-authority-policy';
import {
  TRUSTED_OPERATION_ADAPTER_CONTRACT_VERSION,
  executeTrustedOperation,
  recoverTrustedRunOperations,
  resumeTrustedOperation,
  type TrustedOperationAdapter,
  type TrustedOperationAdapterContext,
  type TrustedOperationAdapterSettlement,
  type TrustedOperationExecutionObservation,
  type TrustedOperationReconciliation,
  type TrustedOperationStore,
} from '../trusted-operation-executor';

const NOW = new Date('2026-08-23T12:00:00.000Z');
const FENCE_EVIDENCE = authorityDigest('test-worker-fence', 'prior-worker-dead');

interface OperationFixture {
  identity: { workspaceId: string; intentId: string; grantId: string; leaseId: string };
  intent: OperationIntentRecord;
  request: AuthorityRequestRecord;
  grant: AuthorityGrantRecord;
  lease: CredentialLeaseRecord;
  binding: ProviderBindingRecord;
}

class MemoryOperationStore implements TrustedOperationStore {
  readonly intents = new Map<string, OperationIntentRecord>();
  readonly requests = new Map<string, AuthorityRequestRecord>();
  readonly grants = new Map<string, AuthorityGrantRecord>();
  readonly leases = new Map<string, CredentialLeaseRecord>();
  readonly bindings = new Map<string, ProviderBindingRecord>();
  readonly attempts: ExecutionAttemptRecord[] = [];
  readonly receipts = new Map<string, ExecutionReceiptRecord>();
  private transactionTail: Promise<void> = Promise.resolve();
  private sequence = 0;

  addOperation(index: number, storyId: string, operation: string): OperationFixture {
    const suffix = String(index).padStart(12, '0');
    const workspaceId = 'workspace-rea-004';
    const runId = 404;
    const environment = 'staging';
    const providerResourceId = 'fixture/repository';
    const intentId = `10000000-0000-4000-8000-${suffix}`;
    const requestId = `20000000-0000-4000-8000-${suffix}`;
    const grantId = `30000000-0000-4000-8000-${suffix}`;
    const leaseId = `40000000-0000-4000-8000-${suffix}`;
    const bindingId = `50000000-0000-4000-8000-${suffix}`;
    const bindingReference = `fixture-binding-${index}`;
    const idempotencyKey = `operation:${runId}:${storyId}:${operation}`;
    const requestDigest = authorityDigest('test-request', { index, storyId, operation });
    const evidenceDigest = authorityDigest('test-evidence', { index, storyId });
    const secretReference = `vault://workspaces/${workspaceId}/fixture/${index}`;
    const secretFingerprint = authorityDigest('test-secret-fingerprint', index);
    const scope = { workspaceId, runId, storyId, environment, providerResourceId, operation };
    const provenance = { source: 'trusted-operation-test' };
    const binding: ProviderBindingRecord = {
      id: bindingId,
      schemaVersion: EXECUTION_AUTHORITY_SCHEMA_VERSION,
      workspaceId,
      bindingReference,
      generation: 1,
      capabilityId: 'provider.fixture.write',
      provider: 'fixture',
      environment,
      providerResourceId,
      secretReference,
      secretFingerprint,
      status: 'active',
      configuration: {},
      provenance,
      createdAt: NOW,
      updatedAt: NOW,
      revokedAt: null,
    };
    const intent: OperationIntentRecord = {
      id: intentId,
      schemaVersion: EXECUTION_AUTHORITY_SCHEMA_VERSION,
      ...scope,
      requestingPrincipal: `execution:run:${runId}`,
      capabilityId: binding.capabilityId,
      bindingReference,
      bindingGeneration: 1,
      constraints: { branch: 'feat/rea-004' },
      evidenceDigest,
      canonicalDigest: authorityDigest('test-intent', { index, storyId, operation }),
      idempotencyKey,
      status: 'authorized',
      provenance,
      createdAt: NOW,
      updatedAt: NOW,
      settledAt: null,
    };
    const request: AuthorityRequestRecord = {
      id: requestId,
      schemaVersion: EXECUTION_AUTHORITY_SCHEMA_VERSION,
      ...scope,
      intentId,
      requestingPrincipal: intent.requestingPrincipal,
      capabilityId: intent.capabilityId,
      bindingReference,
      bindingGeneration: 1,
      constraints: intent.constraints,
      evidenceDigest,
      requestDigest,
      idempotencyKey: authorityDigest('test-request-key', idempotencyKey),
      status: 'approved',
      maximumUses: 1,
      expiresAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
      provenance,
      createdAt: NOW,
      updatedAt: NOW,
      resolvedAt: NOW,
    };
    const grant: AuthorityGrantRecord = {
      id: grantId,
      schemaVersion: EXECUTION_AUTHORITY_SCHEMA_VERSION,
      ...scope,
      requestId,
      decisionId: `60000000-0000-4000-8000-${suffix}`,
      requestDigest,
      capabilityId: intent.capabilityId,
      bindingReference,
      bindingGeneration: 1,
      constraints: intent.constraints,
      evidenceDigest,
      maximumUses: 1,
      usesConsumed: 1,
      fencingGeneration: 1,
      status: 'exhausted',
      idempotencyKey: authorityDigest('test-grant-key', idempotencyKey),
      secretReference,
      secretFingerprint,
      provenance,
      createdAt: NOW,
      updatedAt: NOW,
      expiresAt: request.expiresAt,
      revokedAt: null,
    };
    const lease: CredentialLeaseRecord = {
      id: leaseId,
      schemaVersion: EXECUTION_AUTHORITY_SCHEMA_VERSION,
      ...scope,
      grantId,
      bindingReference,
      bindingGeneration: 1,
      leasePurpose: operation,
      idempotencyKey: authorityDigest('test-lease-key', idempotencyKey),
      fencingGeneration: 1,
      maximumUses: 1,
      usesConsumed: 0,
      status: 'active',
      secretReference,
      secretFingerprint,
      provenance,
      createdAt: NOW,
      updatedAt: NOW,
      expiresAt: request.expiresAt,
      revokedAt: null,
    };
    this.intents.set(intent.id, intent);
    this.requests.set(request.id, request);
    this.grants.set(grant.id, grant);
    this.leases.set(lease.id, lease);
    this.bindings.set(`${binding.bindingReference}:${binding.generation}`, binding);
    return { identity: { workspaceId, intentId, grantId, leaseId }, intent, request, grant, lease, binding };
  }

  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const waitFor = this.transactionTail;
    const next = Promise.withResolvers<void>();
    this.transactionTail = next.promise;
    release = next.resolve;
    await waitFor;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async getIntent(_workspaceId: string, intentId: string): Promise<OperationIntentRecord | null> {
    return this.intents.get(intentId) ?? null;
  }

  async getRequest(_workspaceId: string, requestId: string): Promise<AuthorityRequestRecord | null> {
    return this.requests.get(requestId) ?? null;
  }

  async getGrant(_workspaceId: string, grantId: string): Promise<AuthorityGrantRecord | null> {
    return this.grants.get(grantId) ?? null;
  }

  async getLease(_workspaceId: string, leaseId: string): Promise<CredentialLeaseRecord | null> {
    return this.leases.get(leaseId) ?? null;
  }

  async getBinding(
    _workspaceId: string,
    bindingReference: string,
    generation: number,
  ): Promise<ProviderBindingRecord | null> {
    return this.bindings.get(`${bindingReference}:${generation}`) ?? null;
  }

  async getLatestAttempt(workspaceId: string, idempotencyKey: string): Promise<ExecutionAttemptRecord | null> {
    return this.attempts
      .filter((attempt) => attempt.workspaceId === workspaceId && attempt.idempotencyKey === idempotencyKey)
      .sort((left, right) => right.fencingGeneration - left.fencingGeneration)[0] ?? null;
  }

  async getReceipt(workspaceId: string, idempotencyKey: string): Promise<ExecutionReceiptRecord | null> {
    return this.receipts.get(`${workspaceId}:${idempotencyKey}`) ?? null;
  }

  async isCurrentAttempt(input: {
    workspaceId: string;
    attemptId: string;
    idempotencyKey: string;
    fencingGeneration: number;
  }): Promise<boolean> {
    const latest = await this.getLatestAttempt(input.workspaceId, input.idempotencyKey);
    return latest?.id === input.attemptId && latest.fencingGeneration === input.fencingGeneration;
  }

  async reserveAttempt(input: ReserveExecutionAttemptInput): Promise<ExecutionAttemptRecord> {
    const latest = await this.getLatestAttempt(input.workspaceId, input.idempotencyKey);
    if ((!latest && input.fencingGeneration !== 1)
      || (latest && (latest.status !== 'uncertain' || input.fencingGeneration !== latest.fencingGeneration + 1))) {
      throw Object.assign(new Error('stale fence'), { code: '40001' });
    }
    this.sequence += 1;
    const createdAt = new Date(NOW.getTime() + this.sequence * 1000);
    const attempt: ExecutionAttemptRecord = {
      id: `70000000-0000-4000-8000-${String(this.sequence).padStart(12, '0')}`,
      schemaVersion: EXECUTION_AUTHORITY_SCHEMA_VERSION,
      workspaceId: input.workspaceId,
      intentId: input.intentId,
      grantId: input.grantId,
      leaseId: input.leaseId,
      runId: input.runId,
      storyId: input.storyId,
      environment: input.environment,
      providerResourceId: input.providerResourceId,
      operation: input.operation,
      requestDigest: input.requestDigest,
      idempotencyKey: input.idempotencyKey,
      fencingGeneration: input.fencingGeneration,
      status: 'reserved',
      providerOperationReference: null,
      failureDigest: null,
      provenance: input.provenance,
      createdAt,
      updatedAt: createdAt,
      startedAt: null,
      uncertainAt: null,
      settledAt: null,
    };
    this.attempts.push(attempt);
    return attempt;
  }

  async transitionAttempt(input: Parameters<TrustedOperationStore['transitionAttempt']>[0]): Promise<boolean> {
    const latest = await this.getLatestAttempt(input.workspaceId, input.idempotencyKey);
    if (!latest || latest.id !== input.attemptId || latest.fencingGeneration !== input.fencingGeneration
      || latest.status !== input.from) return false;
    latest.status = input.to;
    latest.providerOperationReference = input.providerOperationReference ?? latest.providerOperationReference;
    latest.failureDigest = input.failureDigest ?? latest.failureDigest;
    latest.updatedAt = new Date(latest.updatedAt.getTime() + 100);
    if (input.to === 'running') latest.startedAt = latest.updatedAt;
    if (input.to === 'uncertain') {
      latest.startedAt ??= latest.updatedAt;
      latest.uncertainAt = latest.updatedAt;
    }
    return true;
  }

  async settleReceipt(input: SettleExecutionReceiptInput): Promise<ExecutionReceiptRecord> {
    const key = `${input.workspaceId}:${input.idempotencyKey}`;
    if (this.receipts.has(key)) throw Object.assign(new Error('duplicate receipt'), { code: '23505' });
    const latest = await this.getLatestAttempt(input.workspaceId, input.idempotencyKey);
    if (!latest || latest.id !== input.attemptId || latest.fencingGeneration !== input.fencingGeneration
      || (latest.status !== 'running' && latest.status !== 'uncertain')) {
      throw Object.assign(new Error('stale receipt'), { code: '40001' });
    }
    const settledAt = new Date(latest.updatedAt.getTime() + 100);
    const receipt: ExecutionReceiptRecord = {
      id: `80000000-0000-4000-8000-${String(this.receipts.size + 1).padStart(12, '0')}`,
      schemaVersion: EXECUTION_AUTHORITY_SCHEMA_VERSION,
      workspaceId: input.workspaceId,
      attemptId: input.attemptId,
      intentId: input.intentId,
      grantId: input.grantId,
      runId: input.runId,
      storyId: input.storyId,
      environment: input.environment,
      providerResourceId: input.providerResourceId,
      operation: input.operation,
      requestDigest: input.requestDigest,
      receiptDigest: input.receiptDigest,
      idempotencyKey: input.idempotencyKey,
      fencingGeneration: input.fencingGeneration,
      outcome: input.outcome,
      providerReceiptReference: input.providerReceiptReference,
      secretReference: input.secretReference,
      secretFingerprint: input.secretFingerprint,
      redactedPayload: input.redactedPayload,
      provenance: input.provenance,
      status: 'settled',
      retentionClass: input.retentionClass,
      retainedUntil: input.retainedUntil,
      createdAt: settledAt,
      settledAt,
    };
    latest.status = 'settled';
    latest.updatedAt = settledAt;
    latest.settledAt = settledAt;
    this.receipts.set(key, receipt);
    return receipt;
  }

  async transitionIntent(
    _workspaceId: string,
    intentId: string,
    from: Exclude<OperationIntentRecord['status'], 'settled' | 'cancelled'>,
    to: Exclude<OperationIntentRecord['status'], 'proposed'>,
  ): Promise<boolean> {
    const intent = this.intents.get(intentId);
    if (!intent || intent.status !== from) return false;
    intent.status = to;
    intent.updatedAt = new Date(intent.updatedAt.getTime() + 100);
    if (to === 'settled') intent.settledAt = intent.updatedAt;
    return true;
  }

  async listRecoverable(input: {
    workspaceId: string;
    runId: number;
    storyId?: string;
  }): Promise<ExecutionAttemptRecord[]> {
    const latestByKey = new Map<string, ExecutionAttemptRecord>();
    const firstCreatedAt = new Map<string, number>();
    for (const attempt of this.attempts) {
      if (attempt.workspaceId !== input.workspaceId || attempt.runId !== input.runId
        || (input.storyId && attempt.storyId !== input.storyId)) continue;
      firstCreatedAt.set(attempt.idempotencyKey, Math.min(
        firstCreatedAt.get(attempt.idempotencyKey) ?? Number.POSITIVE_INFINITY,
        attempt.createdAt.getTime(),
      ));
      const latest = latestByKey.get(attempt.idempotencyKey);
      if (!latest || latest.fencingGeneration < attempt.fencingGeneration) {
        latestByKey.set(attempt.idempotencyKey, attempt);
      }
    }
    return [...latestByKey.values()]
      .filter((attempt) => attempt.status !== 'settled')
      .sort((left, right) => (firstCreatedAt.get(left.idempotencyKey) ?? 0)
        - (firstCreatedAt.get(right.idempotencyKey) ?? 0));
  }
}

type FirstExecutionBehavior = 'settled' | 'uncertain_after_acceptance' | 'uncertain_before_acceptance' | 'deferred';

class FixtureOperationAdapter implements TrustedOperationAdapter {
  readonly contractVersion = TRUSTED_OPERATION_ADAPTER_CONTRACT_VERSION;
  readonly executeCalls: TrustedOperationAdapterContext[] = [];
  readonly reconcileCalls: TrustedOperationAdapterContext[] = [];
  readonly revokeCalls: TrustedOperationAdapterContext[] = [];
  readonly effects = new Map<string, TrustedOperationAdapterSettlement>();
  private releaseFirstExecution: (() => void) | null = null;
  private firstExecutionStarted: (() => void) | null = null;
  readonly firstExecutionStartedPromise: Promise<void>;

  constructor(private readonly firstBehavior: FirstExecutionBehavior = 'settled') {
    const started = Promise.withResolvers<void>();
    this.firstExecutionStartedPromise = started.promise;
    this.firstExecutionStarted = started.resolve;
  }

  releaseDeferredExecution(): void {
    this.releaseFirstExecution?.();
  }

  private accepted(input: TrustedOperationAdapterContext): TrustedOperationAdapterSettlement {
    const existing = this.effects.get(input.idempotencyKey);
    if (existing) return existing;
    const effect: TrustedOperationAdapterSettlement = {
      state: 'settled',
      outcome: 'succeeded',
      providerOperationReference: `provider-operation:${input.idempotencyKey}`,
      providerReceiptReference: `provider-receipt:${input.idempotencyKey}`,
      redactedPayload: { accepted: true, operation: input.operation },
    };
    this.effects.set(input.idempotencyKey, effect);
    return effect;
  }

  async execute(input: TrustedOperationAdapterContext): Promise<TrustedOperationExecutionObservation> {
    this.executeCalls.push(input);
    const first = this.executeCalls.length === 1;
    if (first) this.firstExecutionStarted?.();
    if (first && this.firstBehavior === 'deferred') {
      const deferred = Promise.withResolvers<void>();
      this.releaseFirstExecution = deferred.resolve;
      await deferred.promise;
      return this.accepted(input);
    }
    if (first && this.firstBehavior === 'uncertain_after_acceptance') {
      const accepted = this.accepted(input);
      return { state: 'uncertain', providerOperationReference: accepted.providerOperationReference };
    }
    if (first && this.firstBehavior === 'uncertain_before_acceptance') return { state: 'uncertain' };
    return this.accepted(input);
  }

  async reconcile(input: TrustedOperationAdapterContext): Promise<TrustedOperationReconciliation> {
    this.reconcileCalls.push(input);
    return this.effects.get(input.idempotencyKey) ?? { state: 'not_accepted' };
  }

  async revoke(input: TrustedOperationAdapterContext): Promise<void> {
    this.revokeCalls.push(input);
  }
}

function execute(
  fixture: OperationFixture,
  store: MemoryOperationStore,
  adapter: TrustedOperationAdapter,
) {
  return executeTrustedOperation({ ...fixture.identity, store, adapter, now: NOW });
}

function resume(
  fixture: OperationFixture,
  store: MemoryOperationStore,
  adapter: TrustedOperationAdapter,
) {
  return resumeTrustedOperation({
    ...fixture.identity,
    store,
    adapter,
    priorWorkerFenced: true,
    fenceEvidenceDigest: FENCE_EVIDENCE,
    now: NOW,
  });
}

test('concurrent and replayed dispatch acquires one active fence and executes one provider effect', async () => {
  const store = new MemoryOperationStore();
  const fixture = store.addOperation(1, 'REA-004-A', 'repository.commit');
  const adapter = new FixtureOperationAdapter();

  const [first, concurrent] = await Promise.all([
    execute(fixture, store, adapter),
    execute(fixture, store, adapter),
  ]);
  const statuses = [first.status, concurrent.status].sort();
  assert.deepEqual(statuses, ['in_progress', 'settled']);
  assert.equal(adapter.executeCalls.length, 1);
  assert.equal(adapter.effects.size, 1);
  assert.equal(store.attempts.length, 1);
  assert.equal(store.receipts.size, 1);

  const replay = await execute(fixture, store, adapter);
  assert.equal(replay.status, 'settled');
  if (replay.status === 'settled') assert.equal(replay.source, 'replay');
  assert.equal(adapter.executeCalls.length, 1);
});

test('a stale worker cannot revoke or settle after restart reserves a newer generation', async () => {
  const store = new MemoryOperationStore();
  const fixture = store.addOperation(1, 'REA-004-A', 'deployment.apply');
  const adapter = new FixtureOperationAdapter('deferred');

  const staleWorker = execute(fixture, store, adapter);
  await adapter.firstExecutionStartedPromise;
  const recovered = await resume(fixture, store, adapter);
  assert.equal(recovered.status, 'settled');
  if (recovered.status === 'settled') assert.equal(recovered.receipt.fencingGeneration, 2);

  adapter.releaseDeferredExecution();
  const staleResult = await staleWorker;
  assert.equal(staleResult.status, 'fenced');
  assert.equal(adapter.effects.size, 1);
  assert.deepEqual(adapter.revokeCalls.map(({ fencingGeneration }) => fencingGeneration), [1, 2]);
  assert.equal(store.receipts.size, 1);
  assert.equal([...store.receipts.values()][0]?.fencingGeneration, 2);
});

test('post-acceptance crash reconciles one receipt without repeating the external effect', async () => {
  const store = new MemoryOperationStore();
  const fixture = store.addOperation(1, 'REA-004-A', 'credential.rotate');
  const adapter = new FixtureOperationAdapter('uncertain_after_acceptance');

  const interrupted = await execute(fixture, store, adapter);
  assert.equal(interrupted.status, 'awaiting_reconciliation');
  assert.equal(adapter.effects.size, 1);
  assert.equal(store.receipts.size, 0);

  const recovered = await resume(fixture, store, adapter);
  assert.equal(recovered.status, 'settled');
  if (recovered.status === 'settled') assert.equal(recovered.receipt.outcome, 'reconciled_succeeded');
  assert.equal(adapter.executeCalls.length, 1);
  assert.equal(adapter.reconcileCalls.length, 1);
  assert.equal(adapter.effects.size, 1);
  assert.equal(store.receipts.size, 1);
});

test('pre-acceptance crash retries with the same idempotency key under a newer fence', async () => {
  const store = new MemoryOperationStore();
  const fixture = store.addOperation(1, 'REA-004-A', 'migration.apply');
  const adapter = new FixtureOperationAdapter('uncertain_before_acceptance');

  const interrupted = await execute(fixture, store, adapter);
  assert.equal(interrupted.status, 'awaiting_reconciliation');
  const recovered = await resume(fixture, store, adapter);
  assert.equal(recovered.status, 'settled');
  assert.equal(adapter.executeCalls.length, 2);
  assert.equal(new Set(adapter.executeCalls.map(({ idempotencyKey }) => idempotencyKey)).size, 1);
  assert.deepEqual(adapter.executeCalls.map(({ fencingGeneration }) => fencingGeneration), [1, 2]);
  assert.equal(adapter.effects.size, 1);
  assert.equal(store.receipts.size, 1);
});

test('run restart skips settled effects and resumes the exact unsettled story operation', async () => {
  const store = new MemoryOperationStore();
  const completed = store.addOperation(1, 'REA-004-A', 'repository.commit');
  const pending = store.addOperation(2, 'REA-004-B', 'browser.session.open');
  const completedAdapter = new FixtureOperationAdapter();
  const pendingAdapter = new FixtureOperationAdapter('uncertain_after_acceptance');

  assert.equal((await execute(completed, store, completedAdapter)).status, 'settled');
  assert.equal((await execute(pending, store, pendingAdapter)).status, 'awaiting_reconciliation');
  const resolvedOperations: string[] = [];
  const recovery = await recoverTrustedRunOperations({
    workspaceId: pending.identity.workspaceId,
    runId: pending.intent.runId,
    priorWorkerFenced: true,
    fenceEvidenceDigest: FENCE_EVIDENCE,
    store,
    now: NOW,
    resolveAdapter: ({ operation }) => {
      resolvedOperations.push(operation);
      return pendingAdapter;
    },
  });

  assert.deepEqual(resolvedOperations, ['browser.session.open']);
  assert.equal(recovery.operations.length, 1);
  assert.equal(recovery.operations[0]?.storyId, 'REA-004-B');
  assert.equal(recovery.operations[0]?.result.status, 'settled');
  assert.equal(completedAdapter.executeCalls.length, 1);
  assert.equal(pendingAdapter.executeCalls.length, 1);
  assert.equal(store.receipts.size, 2);
});

test('credential-shaped reconciliation data fails closed without retry or receipt', async () => {
  const store = new MemoryOperationStore();
  const fixture = store.addOperation(1, 'REA-004-A', 'release.publish');
  const adapter = new FixtureOperationAdapter('uncertain_before_acceptance');
  adapter.reconcile = async (input: TrustedOperationAdapterContext) => {
    adapter.reconcileCalls.push(input);
    return { state: 'not_accepted', token: 'provider-secret-canary' } as unknown as TrustedOperationReconciliation;
  };

  assert.equal((await execute(fixture, store, adapter)).status, 'awaiting_reconciliation');
  const recovered = await resume(fixture, store, adapter);
  assert.equal(recovered.status, 'awaiting_reconciliation');
  if (recovered.status === 'awaiting_reconciliation') {
    assert.equal(recovered.reasonCode, 'adapter_reconciliation_failed');
  }
  assert.equal(adapter.executeCalls.length, 1);
  assert.equal(store.attempts.length, 1);
  assert.equal(store.receipts.size, 0);
});
