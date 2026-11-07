/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  getAuthorityGrant,
  getAuthorityRequest,
  getCredentialLease,
  getExecutionReceiptByIdempotencyKey,
  getLatestExecutionAttempt,
  getOperationIntent,
  getProviderBindingByReference,
  isCurrentExecutionAttempt,
  listRecoverableExecutionAttempts,
  reserveExecutionAttempt,
  settleExecutionReceipt,
  transitionExecutionAttempt,
  transitionOperationIntent,
  type AuthorityGrantRecord,
  type AuthorityJson,
  type AuthorityRequestRecord,
  type AuthorityScope,
  type CredentialLeaseRecord,
  type ExecutionAttemptRecord,
  type ExecutionReceiptOutcome,
  type ExecutionReceiptRecord,
  type OperationIntentRecord,
  type ProviderBindingRecord,
  type ReserveExecutionAttemptInput,
  type SettleExecutionReceiptInput,
} from '../db/execution-authority';
import { transaction } from '../db/index';
import { ConflictError, NotFoundError, ValidationError } from './errors';
import { authorityDigest } from './execution-authority-policy';
import { assertExecutionAuthorityMutationProviderAvailable } from './execution-authority-rollout';
import {
  assertAuthorityRedactedReference,
  assertAuthorityRedactedValue,
} from './authority-redaction';

export const TRUSTED_OPERATION_EXECUTOR_SCHEMA_VERSION = 'rorca.trusted-operation-executor.v1' as const;
export const TRUSTED_OPERATION_ADAPTER_CONTRACT_VERSION = 'rorca.trusted-operation-adapter.v1' as const;

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SECRET_REFERENCE_PATTERN = /^(vault|infisical):\/\/[^\s]+$/;
const DEFAULT_RECEIPT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export interface TrustedOperationIdentity {
  workspaceId: string;
  intentId: string;
  grantId: string;
  leaseId: string;
}

export interface TrustedOperationAdapterContext extends AuthorityScope {
  schemaVersion: typeof TRUSTED_OPERATION_ADAPTER_CONTRACT_VERSION;
  attemptId: string;
  intentId: string;
  grantId: string;
  leaseId: string;
  requestingPrincipal: string;
  capabilityId: string;
  bindingReference: string;
  bindingGeneration: number;
  provider: string;
  leasePurpose: string;
  leaseFencingGeneration: number;
  requestDigest: string;
  evidenceDigest: string;
  idempotencyKey: string;
  fencingGeneration: number;
  constraints: AuthorityJson;
  secretReference: string;
  secretFingerprint: string;
}

export interface TrustedOperationAdapterSettlement {
  state: 'settled';
  outcome: 'succeeded' | 'failed';
  providerOperationReference: string;
  providerReceiptReference: string;
  redactedPayload: AuthorityJson;
}

export interface TrustedOperationAdapterUncertain {
  state: 'uncertain';
  providerOperationReference?: string;
}

export type TrustedOperationExecutionObservation =
  | TrustedOperationAdapterSettlement
  | TrustedOperationAdapterUncertain;

export type TrustedOperationReconciliation =
  | TrustedOperationAdapterSettlement
  | TrustedOperationAdapterUncertain
  | { state: 'not_accepted' };

/**
 * The adapter is inside the trusted broker boundary. Every mutating method
 * receives the durable idempotency key and monotonic fencing generation. An
 * implementation must pass both to the provider and reject an older generation.
 * Its result types intentionally have no credential-bearing field.
 */
export interface TrustedOperationAdapter {
  readonly contractVersion: typeof TRUSTED_OPERATION_ADAPTER_CONTRACT_VERSION;
  execute(input: TrustedOperationAdapterContext): Promise<TrustedOperationExecutionObservation>;
  reconcile(input: TrustedOperationAdapterContext): Promise<TrustedOperationReconciliation>;
  revoke(input: TrustedOperationAdapterContext): Promise<void>;
}

export type TrustedOperationExecutionResult =
  | {
      status: 'settled';
      source: 'execute' | 'reconcile' | 'replay';
      attempt: ExecutionAttemptRecord;
      receipt: ExecutionReceiptRecord;
    }
  | {
      status: 'in_progress';
      reasonCode: 'active_fenced_attempt';
      attempt: ExecutionAttemptRecord;
    }
  | {
      status: 'awaiting_reconciliation';
      reasonCode: 'provider_result_uncertain' | 'adapter_reconciliation_failed' | 'adapter_revocation_failed';
      attempt: ExecutionAttemptRecord;
    }
  | {
      status: 'fenced';
      reasonCode: 'newer_fencing_generation_reserved';
      attempt: ExecutionAttemptRecord;
    };

export interface TrustedOperationStore {
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  getIntent(workspaceId: string, intentId: string): Promise<OperationIntentRecord | null>;
  getRequest(workspaceId: string, requestId: string): Promise<AuthorityRequestRecord | null>;
  getGrant(workspaceId: string, grantId: string): Promise<AuthorityGrantRecord | null>;
  getLease(workspaceId: string, leaseId: string): Promise<CredentialLeaseRecord | null>;
  getBinding(workspaceId: string, bindingReference: string, generation: number): Promise<ProviderBindingRecord | null>;
  getLatestAttempt(workspaceId: string, idempotencyKey: string): Promise<ExecutionAttemptRecord | null>;
  getReceipt(workspaceId: string, idempotencyKey: string): Promise<ExecutionReceiptRecord | null>;
  isCurrentAttempt(input: {
    workspaceId: string;
    attemptId: string;
    idempotencyKey: string;
    fencingGeneration: number;
  }): Promise<boolean>;
  reserveAttempt(input: ReserveExecutionAttemptInput): Promise<ExecutionAttemptRecord>;
  transitionAttempt(input: Parameters<typeof transitionExecutionAttempt>[0]): Promise<boolean>;
  settleReceipt(input: SettleExecutionReceiptInput): Promise<ExecutionReceiptRecord>;
  transitionIntent(
    workspaceId: string,
    intentId: string,
    from: Exclude<OperationIntentRecord['status'], 'settled' | 'cancelled'>,
    to: Exclude<OperationIntentRecord['status'], 'proposed'>,
  ): Promise<boolean>;
  listRecoverable(input: {
    workspaceId: string;
    runId: number;
    storyId?: string;
  }): Promise<ExecutionAttemptRecord[]>;
}

const DEFAULT_STORE: TrustedOperationStore = {
  transaction: async <T>(operation: () => Promise<T>) => transaction(operation),
  getIntent: getOperationIntent,
  getRequest: getAuthorityRequest,
  getGrant: getAuthorityGrant,
  getLease: getCredentialLease,
  getBinding: getProviderBindingByReference,
  getLatestAttempt: getLatestExecutionAttempt,
  getReceipt: getExecutionReceiptByIdempotencyKey,
  isCurrentAttempt: isCurrentExecutionAttempt,
  reserveAttempt: reserveExecutionAttempt,
  transitionAttempt: transitionExecutionAttempt,
  settleReceipt: settleExecutionReceipt,
  transitionIntent: transitionOperationIntent,
  listRecoverable: listRecoverableExecutionAttempts,
};

interface TrustedOperationAggregate {
  intent: OperationIntentRecord;
  request: AuthorityRequestRecord;
  grant: AuthorityGrantRecord;
  lease: CredentialLeaseRecord;
  binding: ProviderBindingRecord;
}

interface RunOperationInput extends TrustedOperationIdentity {
  adapter: TrustedOperationAdapter;
  store: TrustedOperationStore;
  now: Date;
  receiptRetentionMs: number;
  restartProof: { priorWorkerFenced: true; evidenceDigest: string } | null;
}

interface ReservationResult {
  attempt: ExecutionAttemptRecord;
  acquired: boolean;
}

function pgCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  return String(error.code ?? '');
}

function sameScope(left: AuthorityScope, right: AuthorityScope): boolean {
  return left.workspaceId === right.workspaceId
    && left.runId === right.runId
    && left.storyId === right.storyId
    && left.environment === right.environment
    && left.providerResourceId === right.providerResourceId
    && left.operation === right.operation;
}

function assertReference(value: string, name: string, maximumBytes = 1024): void {
  try {
    assertAuthorityRedactedReference(value, maximumBytes);
  } catch {
    throw new ValidationError(`${name} is not a bounded redacted provider reference`);
  }
}

function assertRedactedJson(value: unknown): asserts value is AuthorityJson {
  assertAuthorityRedactedValue(value, { maximumBytes: 32_768 });
}

function assertAdapter(adapter: TrustedOperationAdapter): void {
  if (adapter.contractVersion !== TRUSTED_OPERATION_ADAPTER_CONTRACT_VERSION
    || typeof adapter.execute !== 'function'
    || typeof adapter.reconcile !== 'function'
    || typeof adapter.revoke !== 'function') {
    throw new ValidationError('Trusted operation adapter contract is invalid');
  }
}

function assertIdentity(input: TrustedOperationIdentity): void {
  for (const [field, value] of Object.entries({
    workspaceId: input.workspaceId,
    intentId: input.intentId,
    grantId: input.grantId,
    leaseId: input.leaseId,
  })) {
    if (typeof value !== 'string' || value.trim() === '') throw new ValidationError(`Trusted operation ${field} is required`);
  }
}

function assertRestartProof(proof: RunOperationInput['restartProof']): void {
  if (!proof || proof.priorWorkerFenced !== true || !DIGEST_PATTERN.test(proof.evidenceDigest)) {
    throw new ValidationError('Run restart requires an exact prior-worker fence evidence digest');
  }
}

async function loadAggregate(input: TrustedOperationIdentity, store: TrustedOperationStore): Promise<TrustedOperationAggregate> {
  const intent = await store.getIntent(input.workspaceId, input.intentId);
  if (!intent) throw new NotFoundError('Operation intent', input.intentId);
  const grant = await store.getGrant(input.workspaceId, input.grantId);
  if (!grant) throw new NotFoundError('Authority grant', input.grantId);
  const request = await store.getRequest(input.workspaceId, grant.requestId);
  if (!request) throw new NotFoundError('Authority request', grant.requestId);
  const lease = await store.getLease(input.workspaceId, input.leaseId);
  if (!lease) throw new NotFoundError('Credential lease', input.leaseId);
  const binding = await store.getBinding(input.workspaceId, grant.bindingReference, grant.bindingGeneration);
  if (!binding) throw new NotFoundError('Provider binding', grant.bindingReference);

  if (request.intentId !== intent.id || grant.requestId !== request.id || lease.grantId !== grant.id
    || request.requestDigest !== grant.requestDigest
    || !sameScope(intent, grant) || !sameScope(intent, lease)
    || intent.bindingReference !== grant.bindingReference || intent.bindingGeneration !== grant.bindingGeneration
    || lease.bindingReference !== grant.bindingReference || lease.bindingGeneration !== grant.bindingGeneration
    || binding.bindingReference !== grant.bindingReference || binding.generation !== grant.bindingGeneration
    || binding.capabilityId !== grant.capabilityId || binding.environment !== grant.environment
    || binding.providerResourceId !== grant.providerResourceId
    || binding.secretReference !== grant.secretReference || binding.secretReference !== lease.secretReference
    || binding.secretFingerprint !== grant.secretFingerprint || binding.secretFingerprint !== lease.secretFingerprint) {
    throw new ConflictError('Trusted operation authority aggregate is not exact');
  }
  if (request.status !== 'approved' || intent.status === 'proposed' || intent.status === 'cancelled'
    || grant.usesConsumed < 1 || !['active', 'exhausted'].includes(grant.status)) {
    throw new ConflictError('Trusted operation authority aggregate is not executable');
  }
  if (!SECRET_REFERENCE_PATTERN.test(lease.secretReference) || !DIGEST_PATTERN.test(lease.secretFingerprint)) {
    throw new ConflictError('Trusted operation lease does not contain an opaque secret reference');
  }
  return { intent, request, grant, lease, binding };
}

function assertAttemptMatchesAggregate(
  attempt: ExecutionAttemptRecord,
  aggregate: TrustedOperationAggregate,
): void {
  if (attempt.workspaceId !== aggregate.intent.workspaceId
    || attempt.intentId !== aggregate.intent.id
    || attempt.grantId !== aggregate.grant.id
    || attempt.leaseId !== aggregate.lease.id
    || attempt.requestDigest !== aggregate.request.requestDigest
    || attempt.idempotencyKey !== aggregate.intent.idempotencyKey
    || !sameScope(attempt, aggregate.intent)) {
    throw new ConflictError('Execution attempt does not match its exact authority aggregate');
  }
}

function contextFor(aggregate: TrustedOperationAggregate, attempt: ExecutionAttemptRecord): TrustedOperationAdapterContext {
  return Object.freeze({
    schemaVersion: TRUSTED_OPERATION_ADAPTER_CONTRACT_VERSION,
    workspaceId: attempt.workspaceId,
    runId: attempt.runId,
    storyId: attempt.storyId,
    environment: attempt.environment,
    providerResourceId: attempt.providerResourceId,
    operation: attempt.operation,
    attemptId: attempt.id,
    intentId: attempt.intentId,
    grantId: attempt.grantId,
    leaseId: attempt.leaseId,
    requestingPrincipal: aggregate.intent.requestingPrincipal,
    capabilityId: aggregate.intent.capabilityId,
    bindingReference: aggregate.binding.bindingReference,
    bindingGeneration: aggregate.binding.generation,
    provider: aggregate.binding.provider,
    leasePurpose: aggregate.lease.leasePurpose,
    leaseFencingGeneration: aggregate.lease.fencingGeneration,
    requestDigest: attempt.requestDigest,
    evidenceDigest: aggregate.intent.evidenceDigest,
    idempotencyKey: attempt.idempotencyKey,
    fencingGeneration: attempt.fencingGeneration,
    constraints: aggregate.intent.constraints,
    secretReference: aggregate.lease.secretReference,
    secretFingerprint: aggregate.lease.secretFingerprint,
  });
}

function reserveInput(
  aggregate: TrustedOperationAggregate,
  idempotencyKey: string,
  fencingGeneration: number,
  priorAttemptId: string | null,
  restartEvidenceDigest: string | null,
): ReserveExecutionAttemptInput {
  return {
    workspaceId: aggregate.intent.workspaceId,
    runId: aggregate.intent.runId,
    storyId: aggregate.intent.storyId,
    environment: aggregate.intent.environment,
    providerResourceId: aggregate.intent.providerResourceId,
    operation: aggregate.intent.operation,
    intentId: aggregate.intent.id,
    grantId: aggregate.grant.id,
    leaseId: aggregate.lease.id,
    requestDigest: aggregate.request.requestDigest,
    idempotencyKey,
    fencingGeneration,
    provenance: Object.freeze({
      schemaVersion: TRUSTED_OPERATION_EXECUTOR_SCHEMA_VERSION,
      source: 'trusted-operation-executor',
      priorAttemptId,
      restartEvidenceDigest,
    }),
  };
}

async function reserveFirst(
  aggregate: TrustedOperationAggregate,
  now: Date,
  store: TrustedOperationStore,
): Promise<ReservationResult | ExecutionReceiptRecord> {
  try {
    return await store.transaction(async () => {
      const receipt = await store.getReceipt(aggregate.intent.workspaceId, aggregate.intent.idempotencyKey);
      if (receipt) return receipt;
      const existing = await store.getLatestAttempt(aggregate.intent.workspaceId, aggregate.intent.idempotencyKey);
      if (existing) return { attempt: existing, acquired: false };
      if (aggregate.intent.status !== 'authorized' || aggregate.grant.expiresAt.getTime() <= now.getTime()
        || aggregate.lease.status !== 'active' || aggregate.lease.expiresAt.getTime() <= now.getTime()) {
        throw new ConflictError('Fresh trusted operation requires authorized intent and active unexpired authority');
      }
      const attempt = await store.reserveAttempt(reserveInput(aggregate, aggregate.intent.idempotencyKey, 1, null, null));
      const transitioned = await store.transitionIntent(aggregate.intent.workspaceId, aggregate.intent.id, 'authorized', 'executing');
      if (!transitioned) throw new ConflictError('Operation intent changed while reserving execution');
      return { attempt, acquired: true };
    });
  } catch (error) {
    if (!['23505', '40001'].includes(pgCode(error) ?? '')) throw error;
    const receipt = await store.getReceipt(aggregate.intent.workspaceId, aggregate.intent.idempotencyKey);
    if (receipt) return receipt;
    const existing = await store.getLatestAttempt(aggregate.intent.workspaceId, aggregate.intent.idempotencyKey);
    if (!existing) throw error;
    return { attempt: existing, acquired: false };
  }
}

async function reserveRetry(
  aggregate: TrustedOperationAggregate,
  prior: ExecutionAttemptRecord,
  restartEvidenceDigest: string | null,
  store: TrustedOperationStore,
): Promise<ReservationResult | ExecutionReceiptRecord> {
  try {
    return await store.transaction(async () => {
      const receipt = await store.getReceipt(prior.workspaceId, prior.idempotencyKey);
      if (receipt) return receipt;
      const latest = await store.getLatestAttempt(prior.workspaceId, prior.idempotencyKey);
      if (!latest || latest.id !== prior.id || latest.status !== 'uncertain') {
        if (!latest) throw new ConflictError('Uncertain execution attempt disappeared during recovery');
        return { attempt: latest, acquired: false };
      }
      const attempt = await store.reserveAttempt(reserveInput(
        aggregate,
        prior.idempotencyKey,
        prior.fencingGeneration + 1,
        prior.id,
        restartEvidenceDigest,
      ));
      return { attempt, acquired: true };
    });
  } catch (error) {
    if (!['23505', '40001'].includes(pgCode(error) ?? '')) throw error;
    const receipt = await store.getReceipt(prior.workspaceId, prior.idempotencyKey);
    if (receipt) return receipt;
    const latest = await store.getLatestAttempt(prior.workspaceId, prior.idempotencyKey);
    if (!latest) throw error;
    return { attempt: latest, acquired: false };
  }
}

function receiptAttempt(receipt: ExecutionReceiptRecord, attempt: ExecutionAttemptRecord): ExecutionAttemptRecord {
  return { ...attempt, status: 'settled', settledAt: receipt.settledAt, updatedAt: receipt.settledAt };
}

async function replayResult(
  aggregate: TrustedOperationAggregate,
  receipt: ExecutionReceiptRecord,
  store: TrustedOperationStore,
): Promise<TrustedOperationExecutionResult> {
  const attempt = await store.getLatestAttempt(receipt.workspaceId, receipt.idempotencyKey);
  if (!attempt || attempt.id !== receipt.attemptId) {
    throw new ConflictError('Settled execution receipt has no exact latest attempt');
  }
  assertAttemptMatchesAggregate(attempt, aggregate);
  if (receipt.intentId !== attempt.intentId
    || receipt.grantId !== attempt.grantId
    || receipt.requestDigest !== attempt.requestDigest
    || receipt.fencingGeneration !== attempt.fencingGeneration
    || !sameScope(receipt, attempt)) {
    throw new ConflictError('Execution receipt does not match its exact fenced attempt');
  }
  return { status: 'settled', source: 'replay', attempt: receiptAttempt(receipt, attempt), receipt };
}

async function fencedResult(
  attempt: ExecutionAttemptRecord,
  store: TrustedOperationStore,
): Promise<TrustedOperationExecutionResult> {
  const latest = await store.getLatestAttempt(attempt.workspaceId, attempt.idempotencyKey);
  return {
    status: 'fenced',
    reasonCode: 'newer_fencing_generation_reserved',
    attempt: latest ?? attempt,
  };
}

async function markUncertain(
  attempt: ExecutionAttemptRecord,
  from: 'reserved' | 'running',
  failureDomain: string,
  providerOperationReference: string | undefined,
  store: TrustedOperationStore,
): Promise<ExecutionAttemptRecord | null> {
  const transitioned = await store.transitionAttempt({
    workspaceId: attempt.workspaceId,
    attemptId: attempt.id,
    idempotencyKey: attempt.idempotencyKey,
    fencingGeneration: attempt.fencingGeneration,
    from,
    to: 'uncertain',
    providerOperationReference,
    failureDigest: authorityDigest('rorca.trusted-operation.failure.v1', {
      attemptId: attempt.id,
      fencingGeneration: attempt.fencingGeneration,
      domain: failureDomain,
    }),
  });
  if (!transitioned) return null;
  const latest = await store.getLatestAttempt(attempt.workspaceId, attempt.idempotencyKey);
  return latest?.id === attempt.id && latest.status === 'uncertain' ? latest : null;
}

function assertSettlement(value: TrustedOperationAdapterSettlement): void {
  assertReference(value.providerOperationReference, 'providerOperationReference');
  assertReference(value.providerReceiptReference, 'providerReceiptReference');
  assertRedactedJson(value.redactedPayload);
}

function assertAdapterObservation(value: unknown, reconciliation: boolean): asserts value is TrustedOperationReconciliation {
  if (!value || typeof value !== 'object' || !('state' in value)) {
    throw new ValidationError('Trusted operation adapter returned an invalid observation');
  }
  const observation = value as Record<string, unknown>;
  if (observation.state === 'not_accepted') {
    if (!reconciliation || Object.keys(observation).some((key) => key !== 'state')) {
      throw new ValidationError('Trusted operation adapter returned an invalid not-accepted observation');
    }
    return;
  }
  if (observation.state === 'uncertain') {
    if (Object.keys(observation).some((key) => key !== 'state' && key !== 'providerOperationReference')
      || (observation.providerOperationReference !== undefined
        && typeof observation.providerOperationReference !== 'string')) {
      throw new ValidationError('Trusted operation adapter returned an invalid uncertain observation');
    }
    if (typeof observation.providerOperationReference === 'string') {
      assertReference(observation.providerOperationReference, 'providerOperationReference');
    }
    return;
  }
  if (observation.state !== 'settled'
    || Object.keys(observation).some((key) => ![
      'state',
      'outcome',
      'providerOperationReference',
      'providerReceiptReference',
      'redactedPayload',
    ].includes(key))
    || (observation.outcome !== 'succeeded' && observation.outcome !== 'failed')) {
    throw new ValidationError('Trusted operation adapter returned an invalid settled observation');
  }
  assertSettlement(value as TrustedOperationAdapterSettlement);
}

async function revokeWhileCurrent(
  adapter: TrustedOperationAdapter,
  context: TrustedOperationAdapterContext,
  store: TrustedOperationStore,
): Promise<'revoked' | 'fenced' | 'failed'> {
  if (!await store.isCurrentAttempt(context)) return 'fenced';
  try {
    await adapter.revoke(context);
  } catch {
    return 'failed';
  }
  return await store.isCurrentAttempt(context) ? 'revoked' : 'fenced';
}

async function settle(
  aggregate: TrustedOperationAggregate,
  attempt: ExecutionAttemptRecord,
  observation: TrustedOperationAdapterSettlement,
  source: 'execute' | 'reconcile',
  now: Date,
  receiptRetentionMs: number,
  store: TrustedOperationStore,
): Promise<TrustedOperationExecutionResult> {
  assertSettlement(observation);
  if (!await store.isCurrentAttempt({
    workspaceId: attempt.workspaceId,
    attemptId: attempt.id,
    idempotencyKey: attempt.idempotencyKey,
    fencingGeneration: attempt.fencingGeneration,
  })) return fencedResult(attempt, store);

  const outcome: ExecutionReceiptOutcome = source === 'reconcile'
    ? (observation.outcome === 'succeeded' ? 'reconciled_succeeded' : 'reconciled_failed')
    : observation.outcome;
  const receiptDigest = authorityDigest('rorca.execution-authority.receipt.v1', {
    schemaVersion: TRUSTED_OPERATION_EXECUTOR_SCHEMA_VERSION,
    attemptId: attempt.id,
    intentId: attempt.intentId,
    grantId: attempt.grantId,
    scope: {
      workspaceId: attempt.workspaceId,
      runId: attempt.runId,
      storyId: attempt.storyId,
      environment: attempt.environment,
      providerResourceId: attempt.providerResourceId,
      operation: attempt.operation,
    },
    requestDigest: attempt.requestDigest,
    idempotencyKey: attempt.idempotencyKey,
    fencingGeneration: attempt.fencingGeneration,
    outcome,
    providerOperationReference: observation.providerOperationReference,
    providerReceiptReference: observation.providerReceiptReference,
    redactedPayload: observation.redactedPayload,
  });

  try {
    const receipt = await store.transaction(async () => {
      const existing = await store.getReceipt(attempt.workspaceId, attempt.idempotencyKey);
      if (existing) return existing;
      if (!await store.isCurrentAttempt({
        workspaceId: attempt.workspaceId,
        attemptId: attempt.id,
        idempotencyKey: attempt.idempotencyKey,
        fencingGeneration: attempt.fencingGeneration,
      })) throw new ConflictError('Execution attempt was fenced before receipt settlement');
      const inserted = await store.settleReceipt({
        workspaceId: attempt.workspaceId,
        attemptId: attempt.id,
        intentId: attempt.intentId,
        grantId: attempt.grantId,
        runId: attempt.runId,
        storyId: attempt.storyId,
        environment: attempt.environment,
        providerResourceId: attempt.providerResourceId,
        operation: attempt.operation,
        requestDigest: attempt.requestDigest,
        receiptDigest,
        idempotencyKey: attempt.idempotencyKey,
        fencingGeneration: attempt.fencingGeneration,
        outcome,
        providerReceiptReference: observation.providerReceiptReference,
        secretReference: aggregate.lease.secretReference,
        secretFingerprint: aggregate.lease.secretFingerprint,
        redactedPayload: observation.redactedPayload,
        provenance: Object.freeze({
          schemaVersion: TRUSTED_OPERATION_EXECUTOR_SCHEMA_VERSION,
          source,
          providerOperationReference: observation.providerOperationReference,
        }),
        retentionClass: 'standard',
        retainedUntil: new Date(now.getTime() + receiptRetentionMs),
      });
      const intentSettled = await store.transitionIntent(attempt.workspaceId, attempt.intentId, 'executing', 'settled');
      if (!intentSettled) {
        const currentIntent = await store.getIntent(attempt.workspaceId, attempt.intentId);
        if (currentIntent?.status !== 'settled') throw new ConflictError('Operation intent changed before receipt settlement');
      }
      return inserted;
    });
    return { status: 'settled', source, attempt: receiptAttempt(receipt, attempt), receipt };
  } catch (error) {
    if (!['23505', '40001'].includes(pgCode(error) ?? '')) throw error;
    const receipt = await store.getReceipt(attempt.workspaceId, attempt.idempotencyKey);
    if (receipt) return replayResult(aggregate, receipt, store);
    return fencedResult(attempt, store);
  }
}

async function settleObservation(
  aggregate: TrustedOperationAggregate,
  attempt: ExecutionAttemptRecord,
  adapter: TrustedOperationAdapter,
  observation: TrustedOperationAdapterSettlement,
  source: 'execute' | 'reconcile',
  now: Date,
  receiptRetentionMs: number,
  store: TrustedOperationStore,
): Promise<TrustedOperationExecutionResult> {
  assertSettlement(observation);
  let settlementAttempt = attempt;
  if (settlementAttempt.status === 'running') {
    const uncertain = await markUncertain(
      settlementAttempt,
      'running',
      'external_result_pending_settlement',
      observation.providerOperationReference,
      store,
    );
    if (!uncertain) return fencedResult(settlementAttempt, store);
    settlementAttempt = uncertain;
  }
  const context = contextFor(aggregate, settlementAttempt);
  const revocation = await revokeWhileCurrent(adapter, context, store);
  if (revocation === 'fenced') return fencedResult(settlementAttempt, store);
  if (revocation === 'failed') {
    return {
      status: 'awaiting_reconciliation',
      reasonCode: 'adapter_revocation_failed',
      attempt: settlementAttempt,
    };
  }
  return settle(aggregate, settlementAttempt, observation, source, now, receiptRetentionMs, store);
}

async function executeReserved(
  aggregate: TrustedOperationAggregate,
  attempt: ExecutionAttemptRecord,
  input: RunOperationInput,
): Promise<TrustedOperationExecutionResult> {
  const running = await input.store.transitionAttempt({
    workspaceId: attempt.workspaceId,
    attemptId: attempt.id,
    idempotencyKey: attempt.idempotencyKey,
    fencingGeneration: attempt.fencingGeneration,
    from: 'reserved',
    to: 'running',
  });
  if (!running) return fencedResult(attempt, input.store);
  const current = await input.store.getLatestAttempt(attempt.workspaceId, attempt.idempotencyKey);
  if (!current || current.id !== attempt.id || current.status !== 'running'
    || !await input.store.isCurrentAttempt({
      workspaceId: attempt.workspaceId,
      attemptId: attempt.id,
      idempotencyKey: attempt.idempotencyKey,
      fencingGeneration: attempt.fencingGeneration,
    })) return fencedResult(attempt, input.store);

  let observation: TrustedOperationExecutionObservation;
  try {
    observation = await input.adapter.execute(contextFor(aggregate, current));
    assertAdapterObservation(observation, false);
  } catch {
    const uncertain = await markUncertain(current, 'running', 'adapter_execute_failed', undefined, input.store);
    if (!uncertain) return fencedResult(current, input.store);
    return { status: 'awaiting_reconciliation', reasonCode: 'provider_result_uncertain', attempt: uncertain };
  }
  if (observation.state === 'uncertain') {
    if (observation.providerOperationReference) assertReference(observation.providerOperationReference, 'providerOperationReference');
    const uncertain = await markUncertain(
      current,
      'running',
      'provider_result_uncertain',
      observation.providerOperationReference,
      input.store,
    );
    if (!uncertain) return fencedResult(current, input.store);
    return { status: 'awaiting_reconciliation', reasonCode: 'provider_result_uncertain', attempt: uncertain };
  }
  return settleObservation(
    aggregate,
    current,
    input.adapter,
    observation,
    'execute',
    input.now,
    input.receiptRetentionMs,
    input.store,
  );
}

async function reconcileUncertain(
  aggregate: TrustedOperationAggregate,
  attempt: ExecutionAttemptRecord,
  input: RunOperationInput,
): Promise<TrustedOperationExecutionResult> {
  const context = contextFor(aggregate, attempt);
  if (!await input.store.isCurrentAttempt(context)) return fencedResult(attempt, input.store);
  let reconciliation: TrustedOperationReconciliation;
  try {
    reconciliation = await input.adapter.reconcile(context);
    assertAdapterObservation(reconciliation, true);
  } catch {
    return { status: 'awaiting_reconciliation', reasonCode: 'adapter_reconciliation_failed', attempt };
  }
  if (reconciliation.state === 'uncertain') {
    if (reconciliation.providerOperationReference) {
      assertReference(reconciliation.providerOperationReference, 'providerOperationReference');
    }
    return { status: 'awaiting_reconciliation', reasonCode: 'provider_result_uncertain', attempt };
  }
  if (reconciliation.state === 'settled') {
    return settleObservation(
      aggregate,
      attempt,
      input.adapter,
      reconciliation,
      'reconcile',
      input.now,
      input.receiptRetentionMs,
      input.store,
    );
  }

  const revocation = await revokeWhileCurrent(input.adapter, context, input.store);
  if (revocation === 'fenced') return fencedResult(attempt, input.store);
  if (revocation === 'failed') {
    return { status: 'awaiting_reconciliation', reasonCode: 'adapter_revocation_failed', attempt };
  }
  const reservation = await reserveRetry(
    aggregate,
    attempt,
    input.restartProof?.evidenceDigest ?? null,
    input.store,
  );
  if ('receiptDigest' in reservation) return replayResult(aggregate, reservation, input.store);
  if (!reservation.acquired) {
    if (reservation.attempt.status === 'settled') {
      const receipt = await input.store.getReceipt(attempt.workspaceId, attempt.idempotencyKey);
      if (!receipt) throw new ConflictError('Settled execution attempt is missing its receipt');
      return replayResult(aggregate, receipt, input.store);
    }
    return { status: 'in_progress', reasonCode: 'active_fenced_attempt', attempt: reservation.attempt };
  }
  return executeReserved(aggregate, reservation.attempt, input);
}

async function runTrustedOperation(input: RunOperationInput): Promise<TrustedOperationExecutionResult> {
  assertIdentity(input);
  assertAdapter(input.adapter);
  if (!Number.isSafeInteger(input.receiptRetentionMs) || input.receiptRetentionMs < 60_000) {
    throw new ValidationError('Trusted operation receipt retention must be at least one minute');
  }
  const aggregate = await loadAggregate(input, input.store);
  const receipt = await input.store.getReceipt(input.workspaceId, aggregate.intent.idempotencyKey);
  if (receipt) return replayResult(aggregate, receipt, input.store);

  let latest = await input.store.getLatestAttempt(input.workspaceId, aggregate.intent.idempotencyKey);
  if (!latest) {
    const reservation = await reserveFirst(aggregate, input.now, input.store);
    if ('receiptDigest' in reservation) return replayResult(aggregate, reservation, input.store);
    if (!reservation.acquired) latest = reservation.attempt;
    else return executeReserved(aggregate, reservation.attempt, input);
  }
  assertAttemptMatchesAggregate(latest, aggregate);
  if (latest.status === 'settled') {
    const settledReceipt = await input.store.getReceipt(input.workspaceId, latest.idempotencyKey);
    if (!settledReceipt) throw new ConflictError('Settled execution attempt is missing its receipt');
    return replayResult(aggregate, settledReceipt, input.store);
  }
  if (latest.status === 'reserved' || latest.status === 'running') {
    if (!input.restartProof) return { status: 'in_progress', reasonCode: 'active_fenced_attempt', attempt: latest };
    assertRestartProof(input.restartProof);
    const uncertain = await markUncertain(
      latest,
      latest.status,
      'prior_worker_fenced_for_restart',
      latest.providerOperationReference ?? undefined,
      input.store,
    );
    if (!uncertain) return fencedResult(latest, input.store);
    latest = uncertain;
  }
  return reconcileUncertain(aggregate, latest, input);
}

export async function executeTrustedOperation(input: TrustedOperationIdentity & {
  adapter: TrustedOperationAdapter;
  now?: Date;
  receiptRetentionMs?: number;
  store?: TrustedOperationStore;
}): Promise<TrustedOperationExecutionResult> {
  const store = input.store ?? DEFAULT_STORE;
  if (store === DEFAULT_STORE) await assertExecutionAuthorityMutationProviderAvailable(input.workspaceId);
  return runTrustedOperation({
    ...input,
    store,
    now: input.now ?? new Date(),
    receiptRetentionMs: input.receiptRetentionMs ?? DEFAULT_RECEIPT_RETENTION_MS,
    restartProof: null,
  });
}

export async function resumeTrustedOperation(input: TrustedOperationIdentity & {
  adapter: TrustedOperationAdapter;
  priorWorkerFenced: true;
  fenceEvidenceDigest: string;
  now?: Date;
  receiptRetentionMs?: number;
  store?: TrustedOperationStore;
}): Promise<TrustedOperationExecutionResult> {
  const store = input.store ?? DEFAULT_STORE;
  if (store === DEFAULT_STORE) await assertExecutionAuthorityMutationProviderAvailable(input.workspaceId);
  return runTrustedOperation({
    ...input,
    store,
    now: input.now ?? new Date(),
    receiptRetentionMs: input.receiptRetentionMs ?? DEFAULT_RECEIPT_RETENTION_MS,
    restartProof: { priorWorkerFenced: input.priorWorkerFenced, evidenceDigest: input.fenceEvidenceDigest },
  });
}

export interface TrustedRunRecoveryAdapterIdentity {
  provider: string;
  capabilityId: string;
  bindingReference: string;
  bindingGeneration: number;
  operation: string;
}

export interface TrustedRunRecoveryResult {
  schemaVersion: typeof TRUSTED_OPERATION_EXECUTOR_SCHEMA_VERSION;
  workspaceId: string;
  runId: number;
  storyId: string | null;
  operations: Array<{
    storyId: string;
    operation: string;
    idempotencyKey: string;
    result: TrustedOperationExecutionResult;
  }>;
}

/**
 * Recovers only each idempotency key's latest unsettled generation, ordered by
 * its first durable reservation. Settled operations are absent and therefore
 * cannot be repeated when the run resumes at its persisted story position.
 */
export async function recoverTrustedRunOperations(input: {
  workspaceId: string;
  runId: number;
  storyId?: string;
  priorWorkerFenced: true;
  fenceEvidenceDigest: string;
  resolveAdapter(identity: TrustedRunRecoveryAdapterIdentity): Promise<TrustedOperationAdapter> | TrustedOperationAdapter;
  now?: Date;
  receiptRetentionMs?: number;
  store?: TrustedOperationStore;
}): Promise<TrustedRunRecoveryResult> {
  if (!Number.isSafeInteger(input.runId) || input.runId <= 0) throw new ValidationError('Trusted run recovery runId is invalid');
  assertRestartProof({ priorWorkerFenced: input.priorWorkerFenced, evidenceDigest: input.fenceEvidenceDigest });
  const store = input.store ?? DEFAULT_STORE;
  const attempts = await store.listRecoverable({
    workspaceId: input.workspaceId,
    runId: input.runId,
    ...(input.storyId ? { storyId: input.storyId } : {}),
  });
  const operations: TrustedRunRecoveryResult['operations'] = [];
  for (const attempt of attempts) {
    const aggregate = await loadAggregate({
      workspaceId: input.workspaceId,
      intentId: attempt.intentId,
      grantId: attempt.grantId,
      leaseId: attempt.leaseId,
    }, store);
    const adapter = await input.resolveAdapter({
      provider: aggregate.binding.provider,
      capabilityId: aggregate.intent.capabilityId,
      bindingReference: aggregate.binding.bindingReference,
      bindingGeneration: aggregate.binding.generation,
      operation: attempt.operation,
    });
    const result = await resumeTrustedOperation({
      workspaceId: input.workspaceId,
      intentId: attempt.intentId,
      grantId: attempt.grantId,
      leaseId: attempt.leaseId,
      adapter,
      priorWorkerFenced: true,
      fenceEvidenceDigest: input.fenceEvidenceDigest,
      now: input.now,
      receiptRetentionMs: input.receiptRetentionMs,
      store,
    });
    operations.push({
      storyId: attempt.storyId,
      operation: attempt.operation,
      idempotencyKey: attempt.idempotencyKey,
      result,
    });
  }
  return {
    schemaVersion: TRUSTED_OPERATION_EXECUTOR_SCHEMA_VERSION,
    workspaceId: input.workspaceId,
    runId: input.runId,
    storyId: input.storyId ?? null,
    operations,
  };
}
