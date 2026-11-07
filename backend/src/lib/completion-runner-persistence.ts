/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  AttemptTaskPlanV1Schema,
  CompletionGateDecisionV1Schema,
  ContinuationDirectiveV1Schema,
  ProgressLedgerEntryV1Schema,
  ResultProposalV1Schema,
  completionProgressEntryHash,
  governedHash,
  type AttemptTaskPlanV1,
  type CompletionGateDecisionV1,
  type ContinuationDirectiveV1,
  type ContinuationScope,
  type ProgressLedgerEntryV1,
  type ResultProposalV1,
} from './governed-contracts';
import {
  CompletionProgressLedgerError,
  CompletionProgressLedgerReplayError,
  openCompletionProgressLedger,
  rebuildCompletionLedger,
  type CompletionProgressAppendInput,
  type CompletionProgressLedgerOptions,
  type CompletionProgressLedgerWriter,
} from './completion-progress-ledger';
import {
  loadCanonicalCompletionProgressEntries,
  loadCanonicalCompletionProgressRecords,
  loadCanonicalCompletionContinuationLifecycles,
  loadCompletionAttempt,
  consumeCompletionContinuationDirective,
  dispatchCompletionContinuationDirective,
  loadCurrentCompletionTaskPlan,
  persistCompletionContinuationDirective,
  persistCompletionGateDecision,
  persistCompletionProgressEntry,
  persistCompletionResultProposal,
  settleCompletionContinuationDirective,
  persistCompletionTaskPlan,
  type CanonicalCompletionProgressRecord,
  type CanonicalCompletionContinuationLifecycle,
  type CompletionMutationResult,
  type CompletionContinuationConsumptionInput,
  type CompletionContinuationConsumptionResult,
  type CompletionContinuationDispatchInput,
  type CompletionContinuationSettlementInput,
} from './completion-protocol-service';
import {
  type CompletionDurableWriteResult,
  type CompletionExecutionReceipt,
  type CompletionRunnerDurableEvent,
  type CompletionRunnerDurableState,
  type CompletionRunnerPorts,
  type CompletionTaskOperation,
} from './completion-runner';
import { verifyStoryCloseoutDecision, type StoryCloseoutDecision } from './story-closeout';

export type CompletionAttemptProgressState =
  | 'loading'
  | 'planning'
  | 'executing'
  | 'validating'
  | 'self_reviewing'
  | 'proposing'
  | 'submitted'
  | 'blocked'
  | 'cancelled'
  | 'quarantined'
  | 'escalated';

export interface CompletionRunnerPersistenceServices {
  persistProgressEntry(
    entry: ProgressLedgerEntryV1,
    event: Record<string, unknown>,
    expectedStateVersion: number,
    nextState?: CompletionAttemptProgressState,
  ): Promise<CompletionMutationResult>;
  loadProgressRecords(workspaceId: string, attemptId: string): Promise<readonly CanonicalCompletionProgressRecord[]>;
  loadProgressEntries(workspaceId: string, attemptId: string): Promise<readonly ProgressLedgerEntryV1[]>;
  loadContinuationLifecycles(workspaceId: string, attemptId: string): Promise<readonly CanonicalCompletionContinuationLifecycle[]>;
  loadCurrentPlan(workspaceId: string, attemptId: string): Promise<AttemptTaskPlanV1 | null>;
  loadAttempt(workspaceId: string, attemptId: string): Promise<Record<string, unknown> | null>;
  persistPlan(plan: AttemptTaskPlanV1): Promise<CompletionMutationResult>;
  persistProposal(proposal: ResultProposalV1): Promise<CompletionMutationResult>;
  persistGate(decision: CompletionGateDecisionV1): Promise<CompletionMutationResult>;
  persistContinuation(directive: ContinuationDirectiveV1): Promise<CompletionMutationResult>;
  dispatchContinuation(input: CompletionContinuationDispatchInput): Promise<CompletionMutationResult>;
  settleContinuation(input: CompletionContinuationSettlementInput): Promise<CompletionMutationResult>;
  consumeContinuation(input: CompletionContinuationConsumptionInput): Promise<CompletionContinuationConsumptionResult>;
}

export interface CompletionRunnerPersistenceOptions {
  stateRoot: string;
  checkoutRoot: string;
  scope: ContinuationScope;
  writerFence: number;
  clock?: () => Date;
  services?: Partial<CompletionRunnerPersistenceServices>;
}

interface PlanPersistedEvent {
  eventType: 'plan_persisted';
  observedAt: string;
  plan: AttemptTaskPlanV1;
}

interface RecoveryRecordedEvent {
  eventType: 'recovery_recorded';
  observedAt: string;
  localHeadHash: string | null;
  canonicalHeadHash: string;
  recoveredEntryHashes: string[];
}

type StoredCompletionRunnerEvent = CompletionRunnerDurableEvent | PlanPersistedEvent | RecoveryRecordedEvent;
type ProgressEntryType = ProgressLedgerEntryV1['entryType'];
type DatabaseReceiptRef = ProgressLedgerEntryV1['databaseReceiptRefs'][number];

type RunnerPortsWithoutDurable = Omit<CompletionRunnerPorts, 'durable'>;

export interface CompletionRunnerPersistence {
  durable: CompletionRunnerPorts['durable'];
  persistPlan(plan: AttemptTaskPlanV1): Promise<CompletionMutationResult>;
  stageProposal(proposal: ResultProposalV1): Promise<CompletionMutationResult>;
  stageGate(decision: CompletionGateDecisionV1): Promise<CompletionMutationResult>;
  stageContinuation(directive: ContinuationDirectiveV1): Promise<CompletionMutationResult>;
  dispatchContinuation(input: CompletionContinuationDispatchInput): Promise<CompletionMutationResult>;
  settleContinuation(input: CompletionContinuationSettlementInput): Promise<CompletionMutationResult>;
  consumeContinuation(input: CompletionContinuationConsumptionInput): Promise<CompletionContinuationConsumptionResult>;
  wrapPorts(ports: RunnerPortsWithoutDurable): CompletionRunnerPorts;
  close(): void;
}

export class CompletionRunnerPersistenceError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CompletionRunnerPersistenceError';
  }
}

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const GIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const KNOWN_EVENT_TYPES: Readonly<Record<StoredCompletionRunnerEvent['eventType'], true>> = Object.freeze({
  plan_persisted: true,
  operation_reserved: true,
  operation_uncertain: true,
  operation_reconciled: true,
  operation_settled: true,
  validation_recorded: true,
  review_recorded: true,
  proposal_recorded: true,
  gate_recorded: true,
  failure_observed: true,
  continuation_recorded: true,
  closeout_recorded: true,
  terminal_recorded: true,
  recovery_recorded: true,
});

const DEFAULT_SERVICES: CompletionRunnerPersistenceServices = {
  persistProgressEntry: persistCompletionProgressEntry,
  loadProgressRecords: loadCanonicalCompletionProgressRecords,
  loadProgressEntries: loadCanonicalCompletionProgressEntries,
  loadContinuationLifecycles: loadCanonicalCompletionContinuationLifecycles,
  loadCurrentPlan: loadCurrentCompletionTaskPlan,
  loadAttempt: loadCompletionAttempt,
  persistPlan: persistCompletionTaskPlan,
  persistProposal: persistCompletionResultProposal,
  persistGate: persistCompletionGateDecision,
  persistContinuation: persistCompletionContinuationDirective,
  dispatchContinuation: dispatchCompletionContinuationDirective,
  settleContinuation: settleCompletionContinuationDirective,
  consumeContinuation: consumeCompletionContinuationDirective,
};

function invariant(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new CompletionRunnerPersistenceError(code, message);
}

function exactScope(left: ContinuationScope, right: ContinuationScope): boolean {
  return governedHash('rorca.completion-persistence-scope.v1', left as never)
    === governedHash('rorca.completion-persistence-scope.v1', right as never);
}

function currentIso(clock: () => Date): string {
  const value = clock();
  invariant(Number.isFinite(value.getTime()), 'INVALID_PERSISTENCE_CLOCK', 'persistence clock returned an invalid Date');
  return value.toISOString();
}

function integerField(record: Record<string, unknown>, names: readonly string[], fallback?: number): number {
  for (const name of names) {
    const value = record[name];
    if ((typeof value === 'number' || typeof value === 'string') && Number.isSafeInteger(Number(value))) return Number(value);
  }
  invariant(fallback !== undefined, 'MISSING_ATTEMPT_FIELD', `attempt is missing ${names[0]}`);
  return fallback;
}

function stringField(record: Record<string, unknown>, names: readonly string[]): string | null {
  for (const name of names) {
    if (typeof record[name] === 'string') return record[name] as string;
  }
  return null;
}

function eventRecord(event: StoredCompletionRunnerEvent): Record<string, unknown> {
  return event as unknown as Record<string, unknown>;
}

function eventPayloadHash(event: StoredCompletionRunnerEvent): string {
  return governedHash('rorca.completion-durable-event.v1', eventRecord(event) as never);
}

function eventIdentity(event: StoredCompletionRunnerEvent): string {
  switch (event.eventType) {
    case 'plan_persisted': return `plan:${event.plan.planId}:${event.plan.planRevision}`;
    case 'operation_reserved':
    case 'operation_uncertain': return `${event.eventType}:${event.operation.operationKey}`;
    case 'operation_reconciled':
    case 'operation_settled': return `${event.eventType}:${event.receipt.operationKey}`;
    case 'validation_recorded': return `validation:${event.validation.validationId}`;
    case 'review_recorded': return `review:${event.review.reviewId}`;
    case 'proposal_recorded': return `proposal:${event.proposal.proposalId}:${event.proposal.proposalRevision}`;
    case 'gate_recorded': return `gate:${event.decision.decisionId}:${event.decision.decisionRevision}`;
    case 'failure_observed': return `failure:${event.failure.decisionId}`;
    case 'continuation_recorded': return `continuation:${event.directive.directiveId}:${event.directive.directiveRevision}`;
    case 'closeout_recorded': return `closeout:${event.decision.decisionId}`;
    case 'terminal_recorded': return `terminal:${event.status}`;
    case 'recovery_recorded': return `recovery:${event.canonicalHeadHash}`;
  }
}

function entryTypeFor(event: StoredCompletionRunnerEvent): ProgressEntryType {
  switch (event.eventType) {
    case 'plan_persisted': return 'plan_persisted';
    case 'operation_reserved':
    case 'operation_uncertain': return 'task_operation_persisted';
    case 'operation_reconciled':
    case 'failure_observed':
    case 'recovery_recorded': return 'recovery_recorded';
    case 'operation_settled': return 'task_settled';
    case 'validation_recorded': return 'validation_recorded';
    case 'review_recorded': return 'self_review_recorded';
    case 'proposal_recorded': return 'proposal_persisted';
    case 'gate_recorded': return 'gate_decided';
    case 'continuation_recorded': return 'continuation_authorized';
    case 'closeout_recorded': return 'closeout_submitted';
    case 'terminal_recorded': return 'attempt_settled';
  }
}

function nextStateFor(event: StoredCompletionRunnerEvent): CompletionAttemptProgressState | undefined {
  switch (event.eventType) {
    case 'operation_reserved': return 'executing';
    case 'validation_recorded': return 'validating';
    case 'review_recorded': return 'self_reviewing';
    case 'gate_recorded': {
      if (event.decision.outcome === 'cancelled') return 'cancelled';
      if (event.decision.outcome === 'quarantined') return 'quarantined';
      if (event.decision.nextAction === 'continue_fix') return 'planning';
      if (event.decision.nextAction === 'escalate') return 'escalated';
      if (event.decision.outcome !== 'validated' && event.decision.nextAction === 'none') return 'blocked';
      return undefined;
    }
    case 'closeout_recorded': return event.decision.status === 'accepted' ? 'submitted' : 'blocked';
    case 'terminal_recorded': {
      if (event.status === 'cancelled') return 'cancelled';
      if (event.status === 'quarantined') return 'quarantined';
      return 'blocked';
    }
    default: return undefined;
  }
}

function assertOperationBinding(
  operation: CompletionTaskOperation,
  entry: ProgressLedgerEntryV1,
  scope: ContinuationScope,
): void {
  invariant(SHA256.test(operation.operationKey), 'OPERATION_KEY_CONFLICT', 'durable operation key is invalid');
  invariant(SHA256.test(operation.executionNonce), 'EXECUTION_NONCE_CONFLICT', 'durable execution nonce is invalid');
  invariant(
    operation.scopeHash === governedHash('rorca.continuation-scope.v1', scope as never),
    'OPERATION_SCOPE_CONFLICT',
    'durable operation scope hash differs',
  );
  invariant(operation.fencingToken === entry.writerFence, 'OPERATION_FENCE_CONFLICT', 'durable operation fence differs');
  invariant(
    operation.planId === entry.planId
      && operation.planRevision === entry.planRevision
      && operation.planHash === entry.planHash,
    'OPERATION_PLAN_CONFLICT',
    'durable operation plan binding differs',
  );
  invariant(operation.repositorySha === entry.repositorySha, 'OPERATION_SHA_CONFLICT', 'durable operation repository SHA differs');
}

function assertExecutionBinding(
  receipt: CompletionExecutionReceipt,
  entry: ProgressLedgerEntryV1,
  scope: ContinuationScope,
): void {
  invariant(SHA256.test(receipt.operationKey) && SHA256.test(receipt.executionNonce), 'EXECUTION_IDENTITY_CONFLICT', 'execution receipt identity is invalid');
  invariant(
    receipt.scopeHash === governedHash('rorca.continuation-scope.v1', scope as never),
    'EXECUTION_SCOPE_CONFLICT',
    'execution receipt scope differs',
  );
  invariant(receipt.fencingToken === entry.writerFence, 'EXECUTION_FENCE_CONFLICT', 'execution receipt fence differs');
  invariant(
    receipt.planId === entry.planId
      && receipt.planRevision === entry.planRevision
      && receipt.planHash === entry.planHash,
    'EXECUTION_PLAN_CONFLICT',
    'execution receipt plan differs',
  );
  invariant(receipt.baseSha === scope.repository.baseSha, 'EXECUTION_BASE_SHA_CONFLICT', 'execution base SHA differs');
  invariant(receipt.resultSha === entry.repositorySha, 'EXECUTION_RESULT_SHA_CONFLICT', 'execution result SHA differs');
  invariant(GIT_SHA.test(receipt.treeHash), 'EXECUTION_TREE_CONFLICT', 'execution tree hash is invalid');
  invariant(
    SHA256.test(receipt.diffHash)
      && receipt.changedPathManifestHash === scope.repository.changedPathManifestHash
      && SHA256.test(receipt.sourceVectorHash),
    'EXECUTION_RESULT_CONFLICT',
    'execution result hashes differ',
  );
}

function assertStoredEventBinding(
  event: StoredCompletionRunnerEvent,
  entry: ProgressLedgerEntryV1,
  scope: ContinuationScope,
): void {
  invariant(entry.entryType === entryTypeFor(event), 'EVENT_ENTRY_TYPE_CONFLICT', 'durable event maps to the wrong progress entry type');
  switch (event.eventType) {
    case 'plan_persisted': {
      const plan = AttemptTaskPlanV1Schema.parse(event.plan);
      invariant(exactScope(plan.scope, scope), 'PLAN_SCOPE_CONFLICT', 'plan event scope differs');
      invariant(
        plan.planId === entry.planId && plan.planRevision === entry.planRevision && plan.planHash === entry.planHash,
        'PLAN_ENTRY_CONFLICT',
        'plan event does not bind its progress entry',
      );
      return;
    }
    case 'operation_reserved':
    case 'operation_uncertain':
      assertOperationBinding(event.operation, entry, scope);
      if (event.eventType === 'operation_uncertain') {
        invariant(SHA256.test(event.failureHash), 'UNCERTAIN_FAILURE_CONFLICT', 'uncertain execution failure hash is invalid');
      }
      return;
    case 'operation_reconciled':
    case 'operation_settled':
      assertOperationBinding(event.operation, entry, scope);
      assertExecutionBinding(event.receipt, entry, scope);
      invariant(
        event.operation.operationKey === event.receipt.operationKey
          && event.operation.executionNonce === event.receipt.executionNonce,
        'OPERATION_RECEIPT_CONFLICT',
        'operation and execution receipt identities differ',
      );
      return;
    case 'validation_recorded':
      invariant(
        SHA256.test(event.validation.validationHash)
          && SHA256.test(event.validation.operationKey)
          && event.validation.resultSha === entry.repositorySha
          && GIT_SHA.test(event.validation.treeHash),
        'VALIDATION_ENTRY_CONFLICT',
        'validation event result binding differs',
      );
      return;
    case 'review_recorded':
      invariant(
        SHA256.test(event.review.reviewHash)
          && SHA256.test(event.review.operationKey)
          && SHA256.test(event.review.validationHash)
          && event.review.resultSha === entry.repositorySha,
        'REVIEW_ENTRY_CONFLICT',
        'review event result binding differs',
      );
      return;
    case 'proposal_recorded': {
      const proposal = ResultProposalV1Schema.parse(event.proposal);
      invariant(exactScope(proposal.scope, scope), 'PROPOSAL_SCOPE_CONFLICT', 'proposal event scope differs');
      invariant(
        proposal.planId === entry.planId
          && proposal.planRevision === entry.planRevision
          && proposal.planHash === entry.planHash
          && proposal.ledgerHighWaterHash === entry.priorEntryHash
          && proposal.resultSha === entry.repositorySha,
        'PROPOSAL_ENTRY_CONFLICT',
        'proposal event does not bind its progress entry',
      );
      return;
    }
    case 'gate_recorded': {
      const decision = CompletionGateDecisionV1Schema.parse(event.decision);
      invariant(exactScope(decision.scope, scope), 'GATE_SCOPE_CONFLICT', 'gate event scope differs');
      invariant(
        decision.planId === entry.planId
          && decision.planRevision === entry.planRevision
          && decision.planHash === entry.planHash,
        'GATE_ENTRY_CONFLICT',
        'gate event does not bind its progress entry',
      );
      return;
    }
    case 'continuation_recorded': {
      const directive = ContinuationDirectiveV1Schema.parse(event.directive);
      invariant(exactScope(directive.scope, scope), 'CONTINUATION_SCOPE_CONFLICT', 'continuation event scope differs');
      invariant(
        directive.targetPlanId === entry.planId
          && directive.targetPlanRevision === entry.planRevision
          && directive.targetPlanHash === entry.planHash,
        'CONTINUATION_ENTRY_CONFLICT',
        'continuation event does not bind its progress entry',
      );
      return;
    }
    case 'closeout_recorded':
      invariant(verifyStoryCloseoutDecision(event.decision), 'CLOSEOUT_DECISION_CONFLICT', 'closeout event is forged or mutable');
      return;
    case 'failure_observed':
      invariant(
        SHA256.test(event.failure.fingerprint) && SHA256.test(event.failure.sourceVectorHash),
        'FAILURE_EVENT_CONFLICT',
        'failure observation hashes are invalid',
      );
      return;
    case 'terminal_recorded':
      invariant(
        event.status === 'cancelled' || event.status === 'expired' || event.status === 'quarantined',
        'TERMINAL_EVENT_CONFLICT',
        'terminal event status is invalid',
      );
      return;
    case 'recovery_recorded':
      invariant(
        SHA256.test(event.canonicalHeadHash)
          && (event.localHeadHash === null || SHA256.test(event.localHeadHash))
          && event.recoveredEntryHashes.every((hash) => SHA256.test(hash)),
        'RECOVERY_EVENT_CONFLICT',
        'recovery event hashes are invalid',
      );
      return;
  }
}

function planBinding(event: StoredCompletionRunnerEvent, currentPlan: AttemptTaskPlanV1 | null): AttemptTaskPlanV1 {
  if (event.eventType === 'plan_persisted') return AttemptTaskPlanV1Schema.parse(event.plan);
  invariant(currentPlan, 'CURRENT_PLAN_MISSING', 'durable event requires the canonical current task plan');
  return currentPlan;
}

function receiptReference(result: CompletionMutationResult): DatabaseReceiptRef {
  invariant(SHA256.test(result.operationKey) && SHA256.test(result.artifactHash), 'INVALID_DATABASE_RECEIPT', 'canonical service returned invalid receipt material');
  return { receiptId: `receipt:${result.operationKey.slice(7)}`, receiptHash: result.artifactHash };
}

function validateCanonicalRecords(
  scope: ContinuationScope,
  records: readonly CanonicalCompletionProgressRecord[],
  entries: readonly ProgressLedgerEntryV1[],
): CanonicalCompletionProgressRecord[] {
  invariant(records.length === entries.length, 'CANONICAL_PROGRESS_DIVERGENCE', 'canonical record and entry loaders disagree');
  let prior = 'not_applicable';
  return records.map((record, index) => {
    const entry = ProgressLedgerEntryV1Schema.parse(record.entry);
    const companion = ProgressLedgerEntryV1Schema.parse(entries[index]);
    invariant(entry.entryHash === companion.entryHash, 'CANONICAL_PROGRESS_DIVERGENCE', 'canonical record and entry hashes disagree');
    invariant(entry.sequence === index && entry.priorEntryHash === prior, 'CANONICAL_PROGRESS_CHAIN_CONFLICT', 'canonical progress chain is not contiguous');
    invariant(exactScope(entry.scope, scope), 'CANONICAL_PROGRESS_SCOPE_CONFLICT', 'canonical progress entry scope differs');
    invariant(entry.writerFence === scope.fencingToken, 'CANONICAL_PROGRESS_FENCE_CONFLICT', 'canonical progress entry fence differs');
    invariant(entry.repositorySha === scope.repository.currentSha, 'CANONICAL_PROGRESS_SHA_CONFLICT', 'canonical progress entry repository SHA differs');
    invariant(entry.payloadHash === governedHash('rorca.completion-durable-event.v1', record.event as never), 'CANONICAL_EVENT_PAYLOAD_CONFLICT', 'canonical event payload does not match its entry');
    const event = asStoredEvent(record.event);
    assertStoredEventBinding(event, entry, scope);
    prior = entry.entryHash;
    return { entry, event: record.event };
  });
}

function asStoredEvent(record: Record<string, unknown>): StoredCompletionRunnerEvent {
  const type = record.eventType;
  invariant(typeof type === 'string', 'CANONICAL_EVENT_MISSING', 'canonical event has no type');
  invariant(
    Object.prototype.hasOwnProperty.call(KNOWN_EVENT_TYPES, type),
    'UNKNOWN_CANONICAL_EVENT',
    `unknown canonical completion event ${type}`,
  );
  invariant(typeof record.observedAt === 'string' && Number.isFinite(Date.parse(record.observedAt)), 'INVALID_CANONICAL_EVENT_TIME', 'canonical event timestamp is invalid');
  return record as unknown as StoredCompletionRunnerEvent;
}

function reduceCanonicalState(input: {
  scope: ContinuationScope;
  records: readonly CanonicalCompletionProgressRecord[];
  currentPlan: AttemptTaskPlanV1 | null;
  continuationLifecycles: readonly CanonicalCompletionContinuationLifecycle[];
  attempt: Record<string, unknown>;
  reconciliation: CompletionRunnerDurableState['reconciliation'];
}): CompletionRunnerDurableState {
  let currentPlan = input.currentPlan;
  const operations: CompletionRunnerDurableState['operations'] = [];
  const validations: CompletionRunnerDurableState['validations'] = [];
  const reviews: CompletionRunnerDurableState['reviews'] = [];
  const proposals: CompletionRunnerDurableState['proposals'] = [];
  const gateDecisions: CompletionRunnerDurableState['gateDecisions'] = [];
  const recordedDirectives: ContinuationDirectiveV1[] = [];
  const closeoutDecisions: StoryCloseoutDecision[] = [];
  const failures: CompletionRunnerDurableState['retry']['failures'] = [];
  const settledTaskIds = new Set<string>();
  let terminal: CompletionRunnerDurableState['terminal'] = null;

  for (const record of input.records) {
    const event = asStoredEvent(record.event);
    switch (event.eventType) {
      case 'plan_persisted':
        currentPlan = AttemptTaskPlanV1Schema.parse(event.plan);
        invariant(exactScope(currentPlan.scope, input.scope), 'PLAN_SCOPE_CONFLICT', 'persisted plan scope differs');
        break;
      case 'operation_reserved':
      case 'operation_uncertain':
        operations.push(event.operation);
        break;
      case 'operation_reconciled':
      case 'operation_settled':
        operations.push(event.operation);
        for (const taskId of event.receipt.taskIds) settledTaskIds.add(taskId);
        break;
      case 'validation_recorded':
        validations.push(event.validation);
        break;
      case 'review_recorded':
        reviews.push(event.review);
        break;
      case 'proposal_recorded': {
        const proposal = ResultProposalV1Schema.parse(event.proposal);
        invariant(exactScope(proposal.scope, input.scope), 'PROPOSAL_SCOPE_CONFLICT', 'persisted proposal scope differs');
        proposals.push(proposal);
        break;
      }
      case 'gate_recorded': {
        const decision = CompletionGateDecisionV1Schema.parse(event.decision);
        invariant(exactScope(decision.scope, input.scope), 'GATE_SCOPE_CONFLICT', 'persisted gate scope differs');
        gateDecisions.push(decision);
        break;
      }
      case 'failure_observed':
        failures.push(event.failure);
        break;
      case 'continuation_recorded': {
        const directive = ContinuationDirectiveV1Schema.parse(event.directive);
        invariant(exactScope(directive.scope, input.scope), 'CONTINUATION_SCOPE_CONFLICT', 'persisted continuation scope differs');
        recordedDirectives.push(directive);
        break;
      }
      case 'closeout_recorded':
        invariant(verifyStoryCloseoutDecision(event.decision), 'CLOSEOUT_DECISION_CONFLICT', 'persisted closeout decision is forged or mutable');
        closeoutDecisions.push(event.decision);
        break;
      case 'terminal_recorded':
        terminal = { status: event.status, reasonCode: event.reasonCode };
        break;
      case 'recovery_recorded':
        break;
    }
  }

  const lifecycleByIdentity = new Map(input.continuationLifecycles.map((lifecycle) => [
    `${lifecycle.directive.directiveId}:${lifecycle.directive.directiveRevision}`,
    lifecycle,
  ]));
  for (const recorded of recordedDirectives) {
    const lifecycle = lifecycleByIdentity.get(`${recorded.directiveId}:${recorded.directiveRevision}`);
    invariant(lifecycle, 'CONTINUATION_LIFECYCLE_MISSING', 'recorded continuation lacks its canonical relational lifecycle');
    invariant(governedHash('rorca.completion-continuation-authorized-payload.v1', recorded as never)
      === governedHash('rorca.completion-continuation-authorized-payload.v1', lifecycle.directive as never),
    'CONTINUATION_LIFECYCLE_PAYLOAD_CONFLICT', 'canonical continuation lifecycle differs from its immutable recorded payload');
  }
  const directives = input.continuationLifecycles.map((lifecycle) => {
    invariant(exactScope(lifecycle.directive.scope, input.scope), 'CONTINUATION_SCOPE_CONFLICT',
      'canonical continuation lifecycle scope differs');
    return ContinuationDirectiveV1Schema.parse({ ...lifecycle.directive, state: lifecycle.state });
  });

  if (currentPlan) {
    const parsed = AttemptTaskPlanV1Schema.parse(currentPlan);
    invariant(exactScope(parsed.scope, input.scope), 'PLAN_SCOPE_CONFLICT', 'canonical current plan scope differs');
    currentPlan = parsed;
  }
  const writerFence = integerField(input.attempt, ['writer_fence', 'writerFence']);
  invariant(writerFence === input.scope.fencingToken, 'ATTEMPT_FENCE_CONFLICT', 'canonical attempt writer fence differs');
  const retrySpent = integerField(input.attempt, ['retry_spent', 'retrySpent'], 0);
  invariant(retrySpent >= 0 && retrySpent <= 3, 'ATTEMPT_RETRY_CONFLICT', 'canonical attempt retry budget is invalid');
  const state = stringField(input.attempt, ['state']);
  if (!terminal && state === 'cancelled') terminal = { status: 'cancelled', reasonCode: 'canonical_attempt_cancelled' };
  if (!terminal && state === 'quarantined') terminal = { status: 'quarantined', reasonCode: 'canonical_attempt_quarantined' };
  if (state === 'submitted' && !closeoutDecisions.some((decision) => decision.status === 'accepted')) {
    terminal = { status: 'quarantined', reasonCode: 'submitted_without_accepted_closeout' };
  }
  const highWater = input.records.at(-1)?.entry.entryHash
    ?? governedHash('rorca.completion-empty-progress-ledger.v1', { scope: input.scope } as never);
  return {
    scope: input.scope,
    ledgerHighWaterHash: highWater,
    reconciliation: input.reconciliation,
    plan: currentPlan,
    settledTaskIds: [...settledTaskIds].sort(),
    operations,
    validations,
    reviews,
    proposals,
    gateDecisions,
    directives,
    continuationLifecycles: [...input.continuationLifecycles],
    closeoutDecisions,
    retry: { spent: retrySpent, retryFence: writerFence, failures },
    terminal,
  };
}

class CompletionRunnerPersistenceImpl implements CompletionRunnerPersistence {
  readonly durable: CompletionRunnerPorts['durable'];
  private records: CanonicalCompletionProgressRecord[] = [];
  private currentPlan: AttemptTaskPlanV1 | null = null;
  private continuationLifecycles: CanonicalCompletionContinuationLifecycle[] = [];
  private closed = false;
  private rebuilt = false;
  private readonly stagedReceipts = new Map<string, DatabaseReceiptRef[]>();
  private readonly recoveryEventsByPayloadHash = new Map<string, RecoveryRecordedEvent>();

  private constructor(
    private readonly options: CompletionRunnerPersistenceOptions,
    private readonly services: CompletionRunnerPersistenceServices,
    private readonly clock: () => Date,
    private writer: CompletionProgressLedgerWriter,
  ) {
    this.durable = {
      reloadAndReconcile: async ({ scope }) => this.reloadAndReconcile(scope),
      record: async ({ scope, event }) => this.record(scope, event),
    };
  }

  static async create(options: CompletionRunnerPersistenceOptions): Promise<CompletionRunnerPersistenceImpl> {
    invariant(typeof options.stateRoot === 'string' && options.stateRoot.length > 0, 'STATE_ROOT_REQUIRED', 'stateRoot must be explicit');
    invariant(typeof options.checkoutRoot === 'string' && options.checkoutRoot.length > 0, 'CHECKOUT_ROOT_REQUIRED', 'checkoutRoot must be explicit');
    invariant(options.writerFence === options.scope.fencingToken, 'WRITER_FENCE_CONFLICT', 'writer fence must equal exact scope');
    const services = { ...DEFAULT_SERVICES, ...options.services };
    const clock = options.clock ?? (() => new Date());
    const ledgerOptions: CompletionProgressLedgerOptions = {
      stateRoot: options.stateRoot,
      checkoutRoot: options.checkoutRoot,
      scope: options.scope,
      writerFence: options.writerFence,
      clock,
    };
    let writer: CompletionProgressLedgerWriter;
    let rebuilt = false;
    try {
      writer = openCompletionProgressLedger(ledgerOptions);
    } catch (error) {
      if (!(error instanceof CompletionProgressLedgerError) || error.code !== 'COMPLETION_LEDGER_MISSING') throw error;
      writer = await rebuildCompletionLedger(ledgerOptions, () => services.loadProgressEntries(options.scope.workspaceId, options.scope.attemptId));
      rebuilt = true;
    }
    const persistence = new CompletionRunnerPersistenceImpl(options, services, clock, writer);
    persistence.rebuilt = rebuilt;
    try {
      await persistence.refreshCanonical();
      return persistence;
    } catch (error) {
      persistence.close();
      throw error;
    }
  }

  private assertOpen(): void {
    invariant(!this.closed, 'PERSISTENCE_CLOSED', 'completion runner persistence is closed');
  }

  private async refreshCanonical(): Promise<void> {
    const [records, entries, currentPlan, continuationLifecycles] = await Promise.all([
      this.services.loadProgressRecords(this.options.scope.workspaceId, this.options.scope.attemptId),
      this.services.loadProgressEntries(this.options.scope.workspaceId, this.options.scope.attemptId),
      this.services.loadCurrentPlan(this.options.scope.workspaceId, this.options.scope.attemptId),
      this.services.loadContinuationLifecycles(this.options.scope.workspaceId, this.options.scope.attemptId),
    ]);
    this.records = validateCanonicalRecords(this.options.scope, records, entries);
    this.currentPlan = currentPlan ? AttemptTaskPlanV1Schema.parse(currentPlan) : null;
    if (this.currentPlan) invariant(exactScope(this.currentPlan.scope, this.options.scope), 'PLAN_SCOPE_CONFLICT', 'canonical current plan scope differs');
    this.continuationLifecycles = [...continuationLifecycles];
  }

  private findEvent(identity: string): CanonicalCompletionProgressRecord | null {
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      const record = this.records[index]!;
      if (eventIdentity(asStoredEvent(record.event)) === identity) return record;
    }
    return null;
  }

  private async reconcileWriter(): Promise<'exact' | 'database_ahead' | 'ledger_ahead_replayed'> {
    const result = await this.writer.reconcile({
      loadCanonicalReceipts: () => this.services.loadProgressEntries(this.options.scope.workspaceId, this.options.scope.attemptId),
      replayLedgerEntry: async (entry) => {
        const records = await this.services.loadProgressRecords(this.options.scope.workspaceId, this.options.scope.attemptId);
        const existing = records.find((record) => record.entry.entryHash === entry.entryHash);
        if (existing) return existing.entry;
        const recovery = this.recoveryEventsByPayloadHash.get(entry.payloadHash);
        if (!recovery) {
          throw new CompletionRunnerPersistenceError(
            'LEDGER_AHEAD_EVENT_MISSING',
            'ledger-ahead entry lacks its canonical event payload and cannot be replayed',
          );
        }
        const attempt = await this.requireAttempt();
        const stateVersion = integerField(attempt, ['state_version', 'stateVersion']);
        await this.services.persistProgressEntry(entry, eventRecord(recovery), stateVersion);
        return entry;
      },
      createDatabaseAheadMarker: ({ localHead, canonicalHead, recoveredEntries }) => {
        const recovery: RecoveryRecordedEvent = {
          eventType: 'recovery_recorded',
          observedAt: currentIso(this.clock),
          localHeadHash: localHead?.entryHash ?? null,
          canonicalHeadHash: canonicalHead.entryHash,
          recoveredEntryHashes: recoveredEntries.map((entry) => entry.entryHash),
        };
        const payloadHash = eventPayloadHash(recovery);
        this.recoveryEventsByPayloadHash.set(payloadHash, recovery);
        return this.appendInput(recovery, {
          planId: canonicalHead.planId,
          planRevision: canonicalHead.planRevision,
          planHash: canonicalHead.planHash,
        }, []);
      },
    });
    await this.refreshCanonical();
    return result.state;
  }

  private async reloadAndReconcile(scope: ContinuationScope): Promise<CompletionRunnerDurableState> {
    this.assertOpen();
    invariant(exactScope(scope, this.options.scope), 'DURABLE_SCOPE_CONFLICT', 'reload scope differs from persistence scope');
    this.writer.reload();
    let reconciliation: CompletionRunnerDurableState['reconciliation'] = this.rebuilt ? 'rebuilt_from_canonical_receipts' : 'clean';
    try {
      const state = await this.reconcileWriter();
      if (state === 'database_ahead') reconciliation = 'rebuilt_from_canonical_receipts';
    } catch (error) {
      if (error instanceof CompletionProgressLedgerReplayError) reconciliation = 'quarantined';
      else throw error;
    }
    const attempt = await this.requireAttempt();
    return reduceCanonicalState({
      scope,
      records: this.records,
      currentPlan: this.currentPlan,
      continuationLifecycles: this.continuationLifecycles,
      attempt,
      reconciliation,
    });
  }

  private async requireAttempt(): Promise<Record<string, unknown>> {
    const attempt = await this.services.loadAttempt(this.options.scope.workspaceId, this.options.scope.attemptId);
    invariant(attempt, 'CANONICAL_ATTEMPT_MISSING', 'canonical completion attempt is absent');
    const writerFence = integerField(attempt, ['writer_fence', 'writerFence']);
    invariant(writerFence === this.options.writerFence, 'ATTEMPT_FENCE_CONFLICT', 'canonical attempt writer fence differs');
    return attempt;
  }

  private appendInput(
    event: StoredCompletionRunnerEvent,
    plan: Pick<AttemptTaskPlanV1, 'planId' | 'planRevision' | 'planHash'>,
    databaseReceiptRefs: DatabaseReceiptRef[],
  ): CompletionProgressAppendInput {
    const observedAt = event.observedAt;
    invariant(Number.isFinite(Date.parse(observedAt)), 'INVALID_EVENT_TIME', 'durable event timestamp is invalid');
    return {
      schemaVersion: 'rorca.completion-progress-entry.v1',
      contractId: 'rorca.completion-progress-entry.v1',
      contractVersion: '1.0.0',
      artifactId: `progress:${governedHash('rorca.completion-progress-artifact-id.v1', {
        scope: this.options.scope,
        identity: eventIdentity(event),
      } as never).slice(7)}`,
      createdAt: observedAt,
      createdBy: this.options.scope.runtimeId,
      scope: this.options.scope,
      planId: plan.planId,
      planRevision: plan.planRevision,
      planHash: plan.planHash,
      repositorySha: this.options.scope.repository.currentSha,
      entryType: entryTypeFor(event),
      payloadHash: eventPayloadHash(event),
      databaseReceiptRefs,
      recordedAt: observedAt,
    };
  }

  private candidate(input: CompletionProgressAppendInput): ProgressLedgerEntryV1 {
    const sequence = this.writer.entries.length;
    const priorEntryHash = this.writer.head?.entryHash ?? 'not_applicable';
    const material = { ...input, sequence, priorEntryHash, writerFence: this.options.writerFence };
    const entryHash = completionProgressEntryHash(material);
    return ProgressLedgerEntryV1Schema.parse({ ...material, contentHash: entryHash, entryHash });
  }

  private async record(scope: ContinuationScope, event: CompletionRunnerDurableEvent): Promise<CompletionDurableWriteResult> {
    const identity = eventIdentity(event);
    const staged = this.stagedReceipts.get(identity) ?? [];
    const result = await this.recordInternal(scope, event, staged);
    if (result.outcome !== 'conflict') this.stagedReceipts.delete(identity);
    return result;
  }

  private async recordInternal(
    scope: ContinuationScope,
    event: StoredCompletionRunnerEvent,
    databaseReceiptRefs: DatabaseReceiptRef[],
  ): Promise<CompletionDurableWriteResult> {
    this.assertOpen();
    invariant(exactScope(scope, this.options.scope), 'DURABLE_SCOPE_CONFLICT', 'record scope differs from persistence scope');
    const identity = eventIdentity(event);
    const payloadHash = eventPayloadHash(event);
    const prior = this.findEvent(identity);
    if (prior) {
      return {
        outcome: prior.entry.payloadHash === payloadHash ? 'exact_duplicate' : 'conflict',
        ledgerHighWaterHash: this.writer.head?.entryHash ?? prior.entry.entryHash,
      };
    }

    const plan = planBinding(event, this.currentPlan);
    const appendInput = this.appendInput(event, plan, databaseReceiptRefs);
    const candidate = this.candidate(appendInput);
    assertStoredEventBinding(event, candidate, scope);
    const attempt = await this.requireAttempt();
    const stateVersion = integerField(attempt, ['state_version', 'stateVersion']);
    let persisted: CompletionMutationResult;
    try {
      persisted = await this.services.persistProgressEntry(candidate, eventRecord(event), stateVersion, nextStateFor(event));
    } catch (error) {
      await this.refreshCanonical();
      const concurrent = this.findEvent(identity);
      if (concurrent) {
        await this.reconcileWriter();
        return {
          outcome: concurrent.entry.payloadHash === payloadHash ? 'exact_duplicate' : 'conflict',
          ledgerHighWaterHash: this.writer.head?.entryHash ?? concurrent.entry.entryHash,
        };
      }
      throw error;
    }
    invariant(persisted.artifactHash === candidate.entryHash, 'DATABASE_ENTRY_HASH_CONFLICT', 'canonical progress receipt changed the exact entry hash');
    if (persisted.disposition === 'duplicate') {
      await this.reconcileWriter();
      const duplicate = this.findEvent(identity);
      invariant(duplicate, 'DUPLICATE_EVENT_MISSING', 'canonical duplicate has no recoverable event payload');
      return {
        outcome: duplicate.entry.payloadHash === payloadHash ? 'exact_duplicate' : 'conflict',
        ledgerHighWaterHash: this.writer.head?.entryHash ?? duplicate.entry.entryHash,
      };
    }

    const appended = this.writer.append(appendInput);
    invariant(appended.entryHash === candidate.entryHash, 'FILE_APPEND_HASH_CONFLICT', 'file append differs from canonical DB entry');
    const verification = this.writer.reload();
    invariant(verification.entries.at(-1)?.entryHash === candidate.entryHash, 'FILE_APPEND_VERIFY_FAILED', 'file append did not verify at the durable head');
    this.records.push({ entry: candidate, event: eventRecord(event) });
    if (event.eventType === 'plan_persisted') this.currentPlan = event.plan;
    return { outcome: 'appended', ledgerHighWaterHash: candidate.entryHash };
  }

  private stage(eventIdentityValue: string, result: CompletionMutationResult): void {
    const receipts = this.stagedReceipts.get(eventIdentityValue) ?? [];
    const next = receiptReference(result);
    if (!receipts.some((receipt) => receipt.receiptId === next.receiptId)) receipts.push(next);
    this.stagedReceipts.set(eventIdentityValue, receipts);
  }

  async persistPlan(plan: AttemptTaskPlanV1): Promise<CompletionMutationResult> {
    this.assertOpen();
    const parsed = AttemptTaskPlanV1Schema.parse(plan);
    invariant(exactScope(parsed.scope, this.options.scope), 'PLAN_SCOPE_CONFLICT', 'planner output scope differs');
    const result = await this.services.persistPlan(parsed);
    this.currentPlan = parsed;
    const event: PlanPersistedEvent = { eventType: 'plan_persisted', observedAt: parsed.createdAt, plan: parsed };
    await this.recordInternal(this.options.scope, event, [receiptReference(result)]);
    return result;
  }

  async stageProposal(proposal: ResultProposalV1): Promise<CompletionMutationResult> {
    this.assertOpen();
    const parsed = ResultProposalV1Schema.parse(proposal);
    invariant(exactScope(parsed.scope, this.options.scope), 'PROPOSAL_SCOPE_CONFLICT', 'proposal scope differs');
    const result = await this.services.persistProposal(parsed);
    this.stage(`proposal:${parsed.proposalId}:${parsed.proposalRevision}`, result);
    return result;
  }

  async stageGate(decision: CompletionGateDecisionV1): Promise<CompletionMutationResult> {
    this.assertOpen();
    const parsed = CompletionGateDecisionV1Schema.parse(decision);
    invariant(exactScope(parsed.scope, this.options.scope), 'GATE_SCOPE_CONFLICT', 'gate scope differs');
    const result = await this.services.persistGate(parsed);
    this.stage(`gate:${parsed.decisionId}:${parsed.decisionRevision}`, result);
    return result;
  }

  async stageContinuation(directive: ContinuationDirectiveV1): Promise<CompletionMutationResult> {
    this.assertOpen();
    const parsed = ContinuationDirectiveV1Schema.parse(directive);
    invariant(exactScope(parsed.scope, this.options.scope), 'CONTINUATION_SCOPE_CONFLICT', 'continuation scope differs');
    const result = await this.services.persistContinuation(parsed);
    this.stage(`continuation:${parsed.directiveId}:${parsed.directiveRevision}`, result);
    return result;
  }

  private assertContinuationTransitionScope(input: CompletionContinuationDispatchInput): void {
    invariant(input.workspaceId === this.options.scope.workspaceId
      && input.attemptId === this.options.scope.attemptId
      && input.leaseId === this.options.scope.leaseId
      && input.fencingToken === this.options.scope.fencingToken,
    'CONTINUATION_TRANSITION_SCOPE_CONFLICT', 'continuation lifecycle input differs from the exact persistence scope');
  }

  async dispatchContinuation(input: CompletionContinuationDispatchInput): Promise<CompletionMutationResult> {
    this.assertOpen();
    this.assertContinuationTransitionScope(input);
    return this.services.dispatchContinuation(input);
  }

  async settleContinuation(input: CompletionContinuationSettlementInput): Promise<CompletionMutationResult> {
    this.assertOpen();
    this.assertContinuationTransitionScope(input);
    return this.services.settleContinuation(input);
  }

  async consumeContinuation(input: CompletionContinuationConsumptionInput): Promise<CompletionContinuationConsumptionResult> {
    this.assertOpen();
    this.assertContinuationTransitionScope(input);
    const result = await this.services.consumeContinuation(input);
    invariant(result.disposition === 'accepted',
      'CONTINUATION_CONSUMPTION_CAS_LOST', 'only the winner of the one-use continuation consumption CAS may proceed');
    await this.refreshCanonical();
    const lifecycle = this.continuationLifecycles.find((candidate) => (
      candidate.directive.directiveId === input.directiveId
        && candidate.directive.directiveRevision === input.directiveRevision
        && candidate.directive.directiveHash === input.directiveHash
        && candidate.directive.continuationKey === input.continuationKey
    ));
    invariant(lifecycle?.state === 'settled'
      && lifecycle.dispatchId === input.dispatchId
      && lifecycle.dispatchReceiptHash === input.dispatchReceiptHash
      && lifecycle.consumptionId === input.consumptionId,
    'CONTINUATION_CONSUMPTION_PROJECTION_CONFLICT', 'accepted continuation claim was not projected by canonical persistence');
    invariant(exactScope(result.directive.scope, this.options.scope),
      'CONTINUATION_CONSUMPTION_SCOPE_CONFLICT', 'consumed continuation differs from the exact persistence scope');
    invariant(result.directive.directiveId === input.directiveId
      && result.directive.directiveRevision === input.directiveRevision
      && result.directive.directiveHash === input.directiveHash
      && result.directive.continuationKey === input.continuationKey,
    'CONTINUATION_CONSUMPTION_SUBJECT_CONFLICT', 'consumed continuation differs from the requested exact subject');
    return result;
  }

  wrapPorts(ports: RunnerPortsWithoutDurable): CompletionRunnerPorts {
    return {
      ...ports,
      durable: this.durable,
      planner: {
        createOrRevise: async (input) => {
          const plan = await ports.planner.createOrRevise(input);
          await this.persistPlan(plan);
          return plan;
        },
      },
      proposal: {
        create: async (input) => {
          const proposal = await ports.proposal.create(input);
          await this.stageProposal(proposal);
          return proposal;
        },
      },
      gate: {
        controllerPreflight: async (input) => {
          const decision = await ports.gate.controllerPreflight(input);
          await this.stageGate(decision);
          return decision;
        },
        hostSemantic: async (input) => {
          const decision = await ports.gate.hostSemantic(input);
          await this.stageGate(decision);
          return decision;
        },
      },
      continuation: {
        authorize: async (input) => {
          const directive = await ports.continuation.authorize(input);
          await this.stageContinuation(directive);
          return directive;
        },
      },
    };
  }

  close(): void {
    if (this.closed) return;
    this.writer.close();
    this.closed = true;
    this.stagedReceipts.clear();
    this.recoveryEventsByPayloadHash.clear();
  }
}

export async function createCompletionRunnerPersistence(options: CompletionRunnerPersistenceOptions): Promise<CompletionRunnerPersistence> {
  return CompletionRunnerPersistenceImpl.create(options);
}
