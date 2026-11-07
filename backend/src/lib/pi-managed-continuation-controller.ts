/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */
import {
  ContextBundleDeltaV1Schema,
  ContextBundleV1Schema,
  ContextCheckpointV1Schema,
  ContextPolicyActivationV1Schema,
  ContinuationDispatchV1Schema,
  RetrievalReceiptV1Schema,
  Sha256Schema,
  governedHash,
  type ContinuationScope,
} from './governed-contracts';
import { ManagedAdmissionError } from './rorca-managed-executor';

export type ManagedRetryPhase = 'none' | 'started' | 'ended' | 'settled' | 'fenced';
export type ManagedContinuationTrigger = ReturnType<typeof ContextCheckpointV1Schema.parse>['trigger'];

export interface ManagedContinuationCheckpointInput {
  readonly scope: ContinuationScope;
  readonly checkpoint: unknown;
  readonly policyActivation: unknown;
  readonly retryCycleId: string | null;
  readonly retryPhase: ManagedRetryPhase;
  readonly completionCandidateState: 'none' | 'observed' | 'controller_validated' | 'submitted_to_closeout';
  readonly priorProcessGroupDead: boolean;
  /** Durable death receipt when the fence reason carries one
   * ('settled_timeout_writer_dead:<receipt>'); null when unproven. */
  readonly priorWriterDeathReceiptHash: string | null;
  readonly contextEpoch?: never;
}

export interface CanonicalRetrievalOutput {
  readonly receipt: unknown;
  readonly bundle: unknown;
  readonly delta?: unknown;
  readonly renderedPayloadRef: Readonly<{
    referenceId: string;
    kind: 'context';
    hash: string;
    sensitivity: 'public' | 'internal' | 'confidential' | 'restricted';
    retentionClass: string;
    accessTier: 'auth' | 'admin';
    rawPayloadIncluded: false;
  }>;
  readonly renderedPayloadHash: string;
}

export interface ManagedContinuationDispatchMaterial {
  readonly dispatch: unknown;
  readonly renderedPayload: string;
}
export type ManagedContinuationFence =
  | Readonly<{ reasonCode: 'dispatch_authorization_expired'; evidenceHash: null }>
  | Readonly<{ reasonCode: 'settled_timeout_writer_dead'; evidenceHash: string }>;


export interface ManagedCheckpointStore {
  persistBeforeTrigger(checkpoint: unknown): Promise<{ duplicate: boolean }>;
  loadDispatch(continuationKey: string): Promise<Readonly<{
    state: 'proposed' | 'authorized' | 'dispatch_consumed' | 'dispatched' | 'settled' | 'expired' | 'failed' | 'quarantined';
    dispatch: unknown;
    sendReceiptHash: string | null;
  }> | null>;
  consumeDispatchCas(dispatch: unknown): Promise<Readonly<{ consumed: boolean; duplicate: boolean; authorizationExpiresAt: string }>>;
  markDispatched(dispatchId: string, sendReceiptHash: string): Promise<void>;
  settle(dispatchId: string, entryId: string, cursor: number, entryHash: string): Promise<{ duplicate: boolean }>;
  fence(dispatchId: string, fence: ManagedContinuationFence): Promise<void>;
}

export interface CanonicalContextClient {
  retrieve(input: Readonly<{ scope: ContinuationScope; checkpoint: unknown; activation: unknown; forceFullBundle: boolean }>): Promise<CanonicalRetrievalOutput>;
  createDispatch(input: Readonly<{
    scope: ContinuationScope; checkpoint: unknown; activation: unknown; receipt: unknown; bundle: unknown;
    renderedPayloadRef: CanonicalRetrievalOutput['renderedPayloadRef']; renderedPayloadHash: string;
  }>): Promise<ManagedContinuationDispatchMaterial>;
}

export interface PolicyActivationVerifier {
  verifyActive(activation: unknown, scope: ContinuationScope, now: string): Promise<void>;
}
export interface ManagedLeaseVerifier {
  verifyExact(scope: ContinuationScope, phase: 'checkpoint' | 'retrieval' | 'pre_send' | 'settle' | 'restart'): Promise<void>;
}
export interface ContinuationAuthorizer {
  authorize(dispatch: unknown): Promise<void>;
}
export interface PiRpcManagedAdapter {
  sendSameSession(input: Readonly<{ sessionId: string; renderedPayload: string; dispatchId: string; continuationKey: string }>): Promise<{ sendReceiptHash: string }>;
  observeSettled(input: Readonly<{ sessionId: string; turnId: string; generation: number; afterCursor: number }>): Promise<Readonly<{
    settled: boolean; turnId: string; generation: number; entryId: string | null; entryHash: string | null; cursor: number;
  }>>;
  abortProcessGroup(scope: ContinuationScope, reasonCode: string): Promise<{ dead: boolean; deathReceiptHash: string }>;
}
export interface ManagedContinuationEventSink {
  emit(event: Readonly<{ type: string; scopeHash: string; dispatchId?: string; reasonCode: string; evidenceHash: string }>): Promise<void>;
}
export interface AggregateRetryBudget {
  claim(input: Readonly<{ continuationKey: string; actor: 'controller'; phase: 'retrieval' | 'transport' }>): Promise<Readonly<{ claimed: boolean; fence: number; state: 'open' | 'in_flight' | 'backoff' | 'exhausted' | 'quarantined' }>>;
  settle(input: Readonly<{ continuationKey: string; fence: number; phase: 'retrieval' | 'transport'; outcome: 'succeeded' | 'retryable_failed' | 'permanent_conflict'; reasonCode: string }>): Promise<Readonly<{ state: string; retryable: boolean }>>;
}
export interface ManagedClock { now(): string; sleep(milliseconds: number): Promise<void> }

export interface ManagedContinuationOutcome {
  readonly kind: 'suppressed_retry' | 'completion_candidate' | 'dispatched' | 'settled' | 'fenced_timeout' | 'quarantined' | 'observing_existing';
  readonly continuationKey: string;
  readonly dispatchId: string | null;
  readonly promptSent: boolean;
  readonly resultProposalRequired: boolean;
  readonly restartProposal: Readonly<{
    priorRuntimeGeneration:number;newRuntimeGeneration:number;sessionId:string;cursor:number;
    priorWriterDeathReceiptHash:string;forceFullCanonicalContext:true;newLeaseAndFenceRequired:true;authority:'proposal_only';
  }> | null;
  readonly storyLifecycleMutation: false;
  readonly closeoutDecision: false;
}

function outcome(
  kind: ManagedContinuationOutcome['kind'], continuationKey: string, dispatchId: string | null,
  promptSent: boolean, resultProposalRequired = false,
): ManagedContinuationOutcome {
  return Object.freeze({ kind, continuationKey, dispatchId, promptSent, resultProposalRequired,restartProposal:null,
    storyLifecycleMutation: false as const, closeoutDecision: false as const });
}

function assertExactScope(expected: ContinuationScope, actual: ContinuationScope, label: string): void {
  if (governedHash('rorca.managed-continuation-scope.v1', expected) !== governedHash('rorca.managed-continuation-scope.v1', actual)) {
    throw new ManagedAdmissionError('scope_mismatch', `${label} scope differs from the canonical checkpoint scope`);
  }
}

export class PiManagedContinuationController {
  constructor(
    private readonly checkpoints: ManagedCheckpointStore,
    private readonly context: CanonicalContextClient,
    private readonly policy: PolicyActivationVerifier,
    private readonly leases: ManagedLeaseVerifier,
    private readonly authorizer: ContinuationAuthorizer,
    private readonly pi: PiRpcManagedAdapter,
    private readonly events: ManagedContinuationEventSink,
    private readonly retryBudget: AggregateRetryBudget,
    private readonly clock: ManagedClock,
    private readonly settleTimeoutMs = 30_000,
    private readonly settlePollMs = 100,
  ) {}

  async continue(input: ManagedContinuationCheckpointInput): Promise<ManagedContinuationOutcome> {
    const checkpoint = ContextCheckpointV1Schema.parse(input.checkpoint);
    const activation = ContextPolicyActivationV1Schema.parse(input.policyActivation);
    assertExactScope(input.scope, checkpoint.scope, 'checkpoint');
    await this.leases.verifyExact(input.scope, 'checkpoint');
    await this.policy.verifyActive(activation, input.scope, this.clock.now());
    await this.checkpoints.persistBeforeTrigger(checkpoint);
    const continuationKey = governedHash('rorca.managed-continuation-key.v1', {
      scope: input.scope, checkpointId: checkpoint.checkpointId, checkpointHash: checkpoint.contentHash,
      trigger: checkpoint.trigger, retryCycleId: input.retryCycleId, retryPhase: input.retryPhase,
    });

    if (input.retryPhase === 'started' || input.retryPhase === 'ended') {
      return outcome('suppressed_retry', continuationKey, null, false);
    }
    if (input.completionCandidateState === 'controller_validated' || input.completionCandidateState === 'submitted_to_closeout') {
      return outcome('completion_candidate', continuationKey, null, false, true);
    }
    if (checkpoint.trigger.type === 'successful_compaction') {
      if (checkpoint.trigger.aborted || checkpoint.trigger.willRetry
          || checkpoint.trigger.originatingTurnId !== input.scope.turnId
          || checkpoint.trigger.originatingGeneration !== input.scope.originatingGeneration
          || input.retryPhase !== 'settled') {
        throw new ManagedAdmissionError('invalid_contract', 'compaction continuation requires matching successful end and later settled retry state');
      }
    }

    const existing = await this.checkpoints.loadDispatch(continuationKey);
    if (existing?.state === 'dispatch_consumed' || existing?.state === 'dispatched') {
      const parsed = ContinuationDispatchV1Schema.parse(existing.dispatch);
      return this.observeDispatched(parsed, input.scope, continuationKey, false);
    }
    if (existing?.state === 'settled') return outcome('settled', continuationKey, ContinuationDispatchV1Schema.parse(existing.dispatch).dispatchId, false);
    if (existing?.state === 'quarantined') return outcome('quarantined', continuationKey, ContinuationDispatchV1Schema.parse(existing.dispatch).dispatchId, false);

    const retryClaim = await this.retryBudget.claim({ continuationKey, actor: 'controller', phase: 'retrieval' });
    if (!retryClaim.claimed) {
      if (retryClaim.state === 'exhausted' || retryClaim.state === 'quarantined') return outcome('quarantined', continuationKey, null, false);
      return outcome('observing_existing', continuationKey, null, false);
    }

    let canonical: CanonicalRetrievalOutput;
    try {
      await this.leases.verifyExact(input.scope, 'retrieval');
      canonical = await this.context.retrieve({ scope: input.scope, checkpoint, activation, forceFullBundle: false });
      this.verifyCanonicalContext(input.scope, checkpoint, activation, canonical);
      await this.retryBudget.settle({ continuationKey, fence: retryClaim.fence, phase: 'retrieval', outcome: 'succeeded', reasonCode: 'canonical_context_verified' });
    } catch (error) {
      await this.retryBudget.settle({ continuationKey, fence: retryClaim.fence, phase: 'retrieval',
        outcome: error instanceof ManagedAdmissionError ? 'permanent_conflict' : 'retryable_failed', reasonCode: 'canonical_context_retrieval_failed' });
      throw error;
    }

    const material = await this.context.createDispatch({
      scope: input.scope, checkpoint, activation, receipt: canonical.receipt, bundle: canonical.bundle,
      renderedPayloadRef: canonical.renderedPayloadRef, renderedPayloadHash: canonical.renderedPayloadHash,
    });
    const dispatch = ContinuationDispatchV1Schema.parse(material.dispatch);
    assertExactScope(input.scope, dispatch.scope, 'dispatch');
    if (dispatch.continuationKey !== continuationKey || dispatch.targetSessionId !== input.scope.sessionId
        || dispatch.targetCursor !== input.scope.cursor || dispatch.renderedPayloadHash !== canonical.renderedPayloadHash
        || dispatch.bundleId !== ContextBundleV1Schema.parse(canonical.bundle).bundleId) {
      throw new ManagedAdmissionError('scope_mismatch', 'canonical continuation dispatch does not match controller state');
    }
    if (governedHash('rorca.managed-rendered-payload.v1', material.renderedPayload) !== dispatch.renderedPayloadHash) {
      throw new ManagedAdmissionError('invalid_contract', 'rendered payload bytes do not match canonical dispatch identity');
    }
    await this.authorizer.authorize(dispatch);
    await this.leases.verifyExact(input.scope, 'pre_send');
    await this.policy.verifyActive(activation, input.scope, this.clock.now());
    const consumed = await this.checkpoints.consumeDispatchCas(dispatch);
    if (!consumed.consumed) {
      const raced = await this.checkpoints.loadDispatch(continuationKey);
      if (raced?.state === 'dispatch_consumed' || raced?.state === 'dispatched') return this.observeDispatched(ContinuationDispatchV1Schema.parse(raced.dispatch), input.scope, continuationKey, false);
      throw new ManagedAdmissionError('fence_lost', 'continuation dispatch CAS was not consumed');
    }
    if (Date.parse(consumed.authorizationExpiresAt) <= Date.parse(this.clock.now())) {
      await this.checkpoints.fence(dispatch.dispatchId, {
        reasonCode: 'dispatch_authorization_expired',
        evidenceHash: null,
      });
      throw new ManagedAdmissionError('fence_lost', 'continuation dispatch authorization expired');
    }
    const sent = await this.pi.sendSameSession({
      sessionId: input.scope.sessionId, renderedPayload: material.renderedPayload,
      dispatchId: dispatch.dispatchId, continuationKey,
    });
    await this.checkpoints.markDispatched(dispatch.dispatchId, sent.sendReceiptHash);
    await this.events.emit({ type: 'managed_continuation_dispatched',
      scopeHash: governedHash('rorca.managed-continuation-scope.v1', input.scope), dispatchId: dispatch.dispatchId,
      reasonCode: 'same_session_pi_rpc', evidenceHash: sent.sendReceiptHash });
    return this.observeDispatched(dispatch, input.scope, continuationKey, true);
  }

  private verifyCanonicalContext(
    scope: ContinuationScope,
    checkpoint: ReturnType<typeof ContextCheckpointV1Schema.parse>,
    activation: ReturnType<typeof ContextPolicyActivationV1Schema.parse>,
    canonical: CanonicalRetrievalOutput,
  ): void {
    const receipt = RetrievalReceiptV1Schema.parse(canonical.receipt);
    const bundle = ContextBundleV1Schema.parse(canonical.bundle);
    assertExactScope(scope, receipt.scope, 'retrieval receipt');
    assertExactScope(scope, bundle.scope, 'context bundle');
    if (!receipt.requiredComplete || !['completed', 'degraded'].includes(receipt.status)
        || bundle.state !== 'active' || Date.parse(bundle.expiresAt) <= Date.parse(this.clock.now())
        || receipt.checkpointId !== checkpoint.checkpointId || bundle.checkpointId !== checkpoint.checkpointId
        || bundle.receiptId !== receipt.receiptId || receipt.activationHash !== activation.activationHash
        || bundle.activationHash !== activation.activationHash || bundle.requiredContext.some((source) => source.freshness !== 'current' || source.excluded)
        || bundle.advisoryMemory.some((source) => source.contextClass !== 'advisory')) {
      throw new ManagedAdmissionError('scope_mismatch', 'canonical context is incomplete, stale, excluded, or mismatched');
    }
    if (canonical.renderedPayloadRef.rawPayloadIncluded || canonical.renderedPayloadRef.hash !== canonical.renderedPayloadHash) {
      throw new ManagedAdmissionError('invalid_contract', 'canonical context reference must be redacted and hash-bound');
    }
    if (canonical.delta !== undefined) {
      const delta = ContextBundleDeltaV1Schema.parse(canonical.delta);
      if (delta.state !== 'verified' || delta.targetBundleId !== bundle.bundleId
          || delta.reconstructedTargetHash !== bundle.bundleHash
          || !delta.operations.every((operation) => /^(?:\/scope\/(?:cursor|repository\/(?:currentSha|expectedHeadSha)|validationStateHash|rootCauseHash)|\/trigger)$/.test(operation.path))) {
        throw new ManagedAdmissionError('revision_drift', 'delta changes exceed canonical stale-base reuse dimensions');
      }
    }
  }

  private async observeDispatched(
    dispatch: ReturnType<typeof ContinuationDispatchV1Schema.parse>,
    scope: ContinuationScope,
    continuationKey: string,
    promptSent: boolean,
  ): Promise<ManagedContinuationOutcome> {
    const deadline = Date.parse(this.clock.now()) + this.settleTimeoutMs;
    while (Date.parse(this.clock.now()) < deadline) {
      const observed = await this.pi.observeSettled({
        sessionId: scope.sessionId, turnId: scope.turnId, generation: scope.runtimeGeneration, afterCursor: scope.cursor,
      });
      if (observed.settled) {
        if (observed.turnId !== scope.turnId || observed.generation !== scope.runtimeGeneration || observed.cursor <= scope.cursor
            || !observed.entryId || !observed.entryHash) {
          throw new ManagedAdmissionError('scope_mismatch', 'settled event has stale cursor, empty entry, or wrong turn/generation');
        }
        await this.leases.verifyExact(scope, 'settle');
        await this.checkpoints.settle(dispatch.dispatchId, observed.entryId, observed.cursor, observed.entryHash);
        await this.events.emit({ type: 'managed_continuation_settled',
          scopeHash: governedHash('rorca.managed-continuation-scope.v1', scope), dispatchId: dispatch.dispatchId,
          reasonCode: 'assistant_cursor_advanced', evidenceHash: observed.entryHash });
        return outcome('settled', continuationKey, dispatch.dispatchId, promptSent);
      }
      await this.clock.sleep(this.settlePollMs);
    }
    const aborted = await this.pi.abortProcessGroup(scope, 'managed_continuation_settle_timeout');
    if (!aborted.dead) throw new ManagedAdmissionError('fence_lost', 'old Pi writer remains live after continuation timeout');
    const deathReceipt = Sha256Schema.safeParse(aborted.deathReceiptHash);
    if (!deathReceipt.success) {
      throw new ManagedAdmissionError('invalid_contract', 'writer death was not accompanied by a valid durable death receipt');
    }
    await this.checkpoints.fence(dispatch.dispatchId, {
      reasonCode: 'settled_timeout_writer_dead',
      evidenceHash: deathReceipt.data,
    });
    await this.events.emit({ type: 'managed_continuation_fenced_timeout',
      scopeHash: governedHash('rorca.managed-continuation-scope.v1', scope), dispatchId: dispatch.dispatchId,
      reasonCode: 'settled_timeout_writer_dead', evidenceHash: deathReceipt.data });
    return Object.freeze({
      ...outcome('fenced_timeout',continuationKey,dispatch.dispatchId,promptSent),
      restartProposal:Object.freeze({priorRuntimeGeneration:scope.runtimeGeneration,newRuntimeGeneration:scope.runtimeGeneration+1,
        sessionId:scope.sessionId,cursor:scope.cursor,priorWriterDeathReceiptHash:deathReceipt.data,
        forceFullCanonicalContext:true as const,newLeaseAndFenceRequired:true as const,authority:'proposal_only' as const}),
    });
  }

  /** Crash reconciliation never calls send after a consumed dispatch. */
  async reconcile(input: ManagedContinuationCheckpointInput): Promise<ManagedContinuationOutcome> {
    const checkpoint = ContextCheckpointV1Schema.parse(input.checkpoint);
    const continuationKey = governedHash('rorca.managed-continuation-key.v1', {
      scope: input.scope, checkpointId: checkpoint.checkpointId, checkpointHash: checkpoint.contentHash,
      trigger: checkpoint.trigger, retryCycleId: input.retryCycleId, retryPhase: input.retryPhase,
    });
    const existing = await this.checkpoints.loadDispatch(continuationKey);
    // Durable writer-death fence recovered from a prior worker: the fence was
    // recorded with proof ('settled_timeout_writer_dead:<receipt>') before the
    // crash, so recovery emits the restart proposal instead of re-observing or
    // re-dispatching — never a fence_lost wedge.
    if (input.priorProcessGroupDead) {
      if (!input.priorWriterDeathReceiptHash) {
        throw new ManagedAdmissionError('invalid_contract', 'durable writer-death fence lacks its death receipt');
      }
      const dispatchId = existing?.dispatch ? ContinuationDispatchV1Schema.parse(existing.dispatch).dispatchId : null;
      await this.events.emit({ type: 'managed_continuation_fenced_timeout',
        scopeHash: governedHash('rorca.managed-continuation-scope.v1', input.scope), dispatchId: dispatchId ?? undefined,
        reasonCode: 'settled_timeout_writer_dead', evidenceHash: input.priorWriterDeathReceiptHash });
      return Object.freeze({
        ...outcome('fenced_timeout', continuationKey, dispatchId, false),
        restartProposal: Object.freeze({
          priorRuntimeGeneration: input.scope.runtimeGeneration,
          newRuntimeGeneration: input.scope.runtimeGeneration + 1,
          sessionId: input.scope.sessionId, cursor: input.scope.cursor,
          priorWriterDeathReceiptHash: input.priorWriterDeathReceiptHash,
          forceFullCanonicalContext: true as const, newLeaseAndFenceRequired: true as const,
          authority: 'proposal_only' as const,
        }),
      });
    }
    if (!existing || existing.state === 'proposed' || existing.state === 'authorized') return this.continue(input);
    const dispatch = ContinuationDispatchV1Schema.parse(existing.dispatch);
    if (existing.state === 'dispatch_consumed' || existing.state === 'dispatched') return this.observeDispatched(dispatch, input.scope, continuationKey, false);
    if (existing.state === 'settled') return outcome('settled', continuationKey, dispatch.dispatchId, false);
    if (existing.state === 'quarantined') return outcome('quarantined', continuationKey, dispatch.dispatchId, false);
    return outcome('observing_existing', continuationKey, dispatch.dispatchId, false);
  }
}
