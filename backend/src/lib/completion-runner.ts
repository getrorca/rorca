/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  AttemptTaskPlanV1Schema,
  CanonicalObligationSetV1Schema,
  CompletionGateDecisionV1Schema,
  ContinuationDirectiveV1Schema,
  ResultProposalV1Schema,
  completionOperationKey,
  validateAttemptTaskPlan,
  validateContinuationDirective,
  validateResultProposal,
  governedHash,
  WorkPackageV1Schema,
  type AttemptTaskPlanV1,
  type CanonicalObligationSetV1,
  type CompletionGateDecisionV1,
  type ContinuationDirectiveV1,
  type ContinuationScope,
  type ResultProposalV1,
  type WorkPackageV1,
} from './governed-contracts';
import { verifyStoryCloseoutDecision, type StoryCloseoutDecision } from './story-closeout';
import {
  createCompletionRunnerPersistence,
  type CompletionRunnerPersistenceOptions,
} from './completion-runner-persistence';
import {
  completionContinuationConsumptionHash,
  type CanonicalCompletionContinuationLifecycle,
  type CompletionContinuationConsumptionInput,
} from './completion-protocol-service';

export const COMPLETION_RUNNER_LIMITS = Object.freeze({
  batches: 32,
  tasksPerBatch: 6,
  mutablePathsPerBatch: 20,
  validationCommandsPerBatch: 8,
  fixRetries: 3,
  retryBackoffBaseMs: 1_000,
  retryBackoffCapMs: 30_000,
  retryJitterRangeMs: 251,
});

export type CompletionRunnerControlWindow =
  | 'turn_start'
  | 'before_execution'
  | 'after_execution'
  | 'before_review'
  | 'before_proposal'
  | 'before_controller_preflight'
  | 'before_host_semantic'
  | 'before_continuation'
  | 'before_closeout';

export interface CompletionRunnerControlObservation {
  observedAt: string;
  cancellation: 'none' | 'requested' | 'acknowledged' | 'forced_expiry';
  cancellationId: string | null;
}

export interface CompletionExecutionReceipt {
  operationKey: string;
  executionNonce: string;
  scopeHash: string;
  fencingToken: number;
  planId: string;
  planRevision: number;
  planHash: string;
  batchId: string;
  taskIds: string[];
  baseSha: string;
  resultSha: string;
  treeHash: string;
  diffHash: string;
  changedPathManifestHash: string;
  changedPaths: string[];
  sourceVectorHash: string;
  mutation: 'none' | 'material';
  settledAt: string;
}

export interface CompletionTaskOperation {
  operationKey: string;
  executionNonce: string;
  scopeHash: string;
  fencingToken: number;
  planId: string;
  planRevision: number;
  planHash: string;
  batchId: string;
  taskIds: string[];
  repositorySha: string;
  state: 'reserved' | 'running' | 'uncertain' | 'settled';
  receipt: CompletionExecutionReceipt | null;
}

export type CompletionExecutionReconciliation =
  | { state: 'settled'; receipt: CompletionExecutionReceipt }
  | { state: 'not_started' }
  | { state: 'uncertain' }
  | { state: 'conflict'; reasonCode: string };

export interface CompletionValidationReceipt {
  validationId: string;
  validationHash: string;
  operationKey: string;
  resultSha: string;
  treeHash: string;
  commandHashes: string[];
  complete: boolean;
  outcome: 'passed' | 'failed' | 'blocked';
  failedObligationIds: string[];
  issueCodes: string[];
  validatedAt: string;
}

export interface CompletionSelfReviewReceipt {
  reviewId: string;
  reviewHash: string;
  operationKey: string;
  validationHash: string;
  resultSha: string;
  complete: boolean;
  outcome: 'ready' | 'needs_fix' | 'blocked';
  issueCodes: string[];
  reviewedAt: string;
}

export interface CompletionFailureObservation {
  decisionId: string;
  fingerprint: string;
  sourceVectorHash: string;
  observedAt: string;
}

export interface CompletionRetryState {
  spent: number;
  retryFence: number;
  failures: CompletionFailureObservation[];
}

export interface CompletionRunnerDurableState {
  scope: ContinuationScope;
  ledgerHighWaterHash: string;
  reconciliation: 'clean' | 'rebuilt_from_canonical_receipts' | 'quarantined';
  plan: AttemptTaskPlanV1 | null;
  settledTaskIds: string[];
  operations: CompletionTaskOperation[];
  validations: CompletionValidationReceipt[];
  reviews: CompletionSelfReviewReceipt[];
  proposals: ResultProposalV1[];
  gateDecisions: CompletionGateDecisionV1[];
  directives: ContinuationDirectiveV1[];
  continuationLifecycles: CanonicalCompletionContinuationLifecycle[];
  closeoutDecisions: StoryCloseoutDecision[];
  retry: CompletionRetryState;
  terminal: { status: 'cancelled' | 'expired' | 'quarantined'; reasonCode: string } | null;
}

export type CompletionRunnerDurableEvent =
  | { eventType: 'operation_reserved'; observedAt: string; operation: CompletionTaskOperation }
  | { eventType: 'operation_uncertain'; observedAt: string; operation: CompletionTaskOperation; failureHash: string }
  | { eventType: 'operation_reconciled'; observedAt: string; operation: CompletionTaskOperation; receipt: CompletionExecutionReceipt }
  | { eventType: 'operation_settled'; observedAt: string; operation: CompletionTaskOperation; receipt: CompletionExecutionReceipt }
  | { eventType: 'validation_recorded'; observedAt: string; validation: CompletionValidationReceipt }
  | { eventType: 'review_recorded'; observedAt: string; review: CompletionSelfReviewReceipt }
  | { eventType: 'proposal_recorded'; observedAt: string; proposal: ResultProposalV1 }
  | { eventType: 'gate_recorded'; observedAt: string; decision: CompletionGateDecisionV1 }
  | { eventType: 'failure_observed'; observedAt: string; failure: CompletionFailureObservation }
  | { eventType: 'continuation_recorded'; observedAt: string; directive: ContinuationDirectiveV1; backoffMs: number }
  | { eventType: 'closeout_recorded'; observedAt: string; decision: StoryCloseoutDecision }
  | { eventType: 'terminal_recorded'; observedAt: string; status: 'cancelled' | 'expired' | 'quarantined'; reasonCode: string };

export interface CompletionDurableWriteResult {
  outcome: 'appended' | 'exact_duplicate' | 'conflict';
  ledgerHighWaterHash: string;
}

export interface CompletionRunnerPorts {
  clock: { now(): string };
  control: {
    observe(input: { scope: ContinuationScope; window: CompletionRunnerControlWindow }): Promise<CompletionRunnerControlObservation>;
  };
  durable: {
    reloadAndReconcile(input: { scope: ContinuationScope }): Promise<CompletionRunnerDurableState>;
    record(input: { scope: ContinuationScope; event: CompletionRunnerDurableEvent }): Promise<CompletionDurableWriteResult>;
  };
  obligations: {
    load(input: { scope: ContinuationScope }): Promise<CanonicalObligationSetV1>;
  };
  planner: {
    createOrRevise(input: {
      scope: ContinuationScope;
      obligations: CanonicalObligationSetV1;
      workPackage: WorkPackageV1;
      previousPlan: AttemptTaskPlanV1 | null;
      settledTaskIds: readonly string[];
      priorDirective: ContinuationDirectiveV1 | null;
    }): Promise<AttemptTaskPlanV1>;
  };
  executor: {
    reconcile(input: { scope: ContinuationScope; operation: CompletionTaskOperation }): Promise<CompletionExecutionReconciliation>;
    execute(input: {
      scope: ContinuationScope;
      plan: AttemptTaskPlanV1;
      batch: AttemptTaskPlanV1['batches'][number];
      taskIds: readonly string[];
      operationKey: string;
      executionNonce: string;
    }): Promise<CompletionExecutionReceipt>;
  };
  validation: {
    validate(input: {
      scope: ContinuationScope;
      obligations: CanonicalObligationSetV1;
      plan: AttemptTaskPlanV1;
      batch: AttemptTaskPlanV1['batches'][number];
      execution: CompletionExecutionReceipt;
      requiredCommandHashes: readonly string[];
    }): Promise<CompletionValidationReceipt>;
  };
  review: {
    review(input: {
      scope: ContinuationScope;
      obligations: CanonicalObligationSetV1;
      plan: AttemptTaskPlanV1;
      execution: CompletionExecutionReceipt;
      validation: CompletionValidationReceipt;
    }): Promise<CompletionSelfReviewReceipt>;
  };
  proposal: {
    create(input: {
      scope: ContinuationScope;
      obligations: CanonicalObligationSetV1;
      plan: AttemptTaskPlanV1;
      execution: CompletionExecutionReceipt;
      validation: CompletionValidationReceipt;
      review: CompletionSelfReviewReceipt;
      ledgerHighWaterHash: string;
      priorProposal: ResultProposalV1 | null;
    }): Promise<ResultProposalV1>;
  };
  gate: {
    controllerPreflight(input: {
      scope: ContinuationScope;
      obligations: CanonicalObligationSetV1;
      plan: AttemptTaskPlanV1;
      proposal: ResultProposalV1;
      validation: CompletionValidationReceipt;
      review: CompletionSelfReviewReceipt;
    }): Promise<CompletionGateDecisionV1>;
    hostSemantic(input: {
      scope: ContinuationScope;
      obligations: CanonicalObligationSetV1;
      plan: AttemptTaskPlanV1;
      proposal: ResultProposalV1;
      controllerDecision: CompletionGateDecisionV1;
      validation: CompletionValidationReceipt;
      review: CompletionSelfReviewReceipt;
    }): Promise<CompletionGateDecisionV1>;
  };
  continuation: {
    authorize(input: {
      scope: ContinuationScope;
      obligations: CanonicalObligationSetV1;
      plan: AttemptTaskPlanV1;
      decision: CompletionGateDecisionV1;
      targetBatchId: string;
      retryBudgetId: string;
      retryFence: number;
      retrySpent: number;
      retryMaximum: number;
      backoffMs: number;
    }): Promise<ContinuationDirectiveV1>;
  };
  closeout: {
    submit(input: {
      scope: ContinuationScope;
      obligations: CanonicalObligationSetV1;
      plan: AttemptTaskPlanV1;
      proposal: ResultProposalV1;
      controllerDecision: CompletionGateDecisionV1;
      hostDecision: CompletionGateDecisionV1;
      validation: CompletionValidationReceipt;
      review: CompletionSelfReviewReceipt;
    }): Promise<StoryCloseoutDecision>;
  };
}

export interface CompletionRunnerTurnInput {
  scope: ContinuationScope;
  workPackage: WorkPackageV1;
  continuationConsumptionClaim?: CompletionContinuationConsumptionInput;
}

export interface CompletionRunnerTurnResult {
  status:
    | 'advanced'
    | 'awaiting_reconciliation'
    | 'awaiting_continuation'
    | 'blocked'
    | 'cancelled'
    | 'expired'
    | 'quarantined'
    | 'closeout_accepted';
  reasonCode: string;
  executedBatchId: string | null;
  gateStage: CompletionGateDecisionV1['stage'] | null;
  proposalId: string | null;
  closeoutDecisionId: string | null;
  finalReportEligible: boolean;
  ledgerHighWaterHash: string;
}

export interface DurableCompletionRunnerInput extends Omit<CompletionRunnerTurnInput, 'continuationConsumptionClaim'> {
  persistence: Omit<CompletionRunnerPersistenceOptions, 'scope' | 'writerFence'>;
}

export type CompletionRunnerPortsWithoutDurable = Omit<CompletionRunnerPorts, 'durable'>;

export class CompletionRunnerInvariantError extends Error {
  constructor(readonly reasonCode: string, message: string) {
    super(message);
    this.name = 'CompletionRunnerInvariantError';
  }
}

interface LedgerCursor { value: string }
interface ControlStop { status: 'cancelled' | 'expired'; reasonCode: string; observedAt: string }

type PlanBatch = AttemptTaskPlanV1['batches'][number];
type PlanTask = PlanBatch['tasks'][number];

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const GIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function invariant(condition: unknown, reasonCode: string, message: string): asserts condition {
  if (!condition) throw new CompletionRunnerInvariantError(reasonCode, message);
}

function last<T>(items: readonly T[]): T | null {
  return items.length === 0 ? null : items[items.length - 1]!;
}

function uniqueSorted(items: readonly string[]): string[] {
  return [...new Set(items)].sort();
}

function scopeHash(scope: ContinuationScope): string {
  return governedHash('rorca.continuation-scope.v1', scope as never);
}

function exactScope(left: ContinuationScope, right: ContinuationScope): boolean {
  return scopeHash(left) === scopeHash(right);
}

function artifactTaskSignature(task: PlanTask): string {
  return governedHash('rorca.completion-plan-task-preservation.v1', {
    taskId: task.taskId,
    ordinal: task.ordinal,
    objectiveHash: task.objectiveHash,
    coveredObligationIds: task.coveredObligationIds,
    allowedPaths: task.allowedPaths,
    commandHashes: task.commandHashes,
  } as never);
}

function assertIsoTimestamp(value: string, reasonCode: string): void {
  invariant(Number.isFinite(Date.parse(value)), reasonCode, 'port returned a non-ISO timestamp');
}

function assertSha256(value: string, reasonCode: string): void {
  invariant(SHA256.test(value), reasonCode, 'expected sha256 material');
}

function assertGitSha(value: string, reasonCode: string): void {
  invariant(GIT_SHA.test(value), reasonCode, 'expected a full Git object id');
}

export function completionFixBudget(retryLimit: number): number {
  invariant(Number.isInteger(retryLimit) && retryLimit >= 0, 'INVALID_RETRY_LIMIT', 'retryLimit must be a non-negative integer');
  return Math.min(retryLimit, COMPLETION_RUNNER_LIMITS.fixRetries);
}

export function completionRetryBackoffMs(input: {
  scope: ContinuationScope;
  priorDecisionHash: string;
  retrySpentBeforeAuthorization: number;
}): number {
  invariant(
    Number.isInteger(input.retrySpentBeforeAuthorization)
      && input.retrySpentBeforeAuthorization >= 0
      && input.retrySpentBeforeAuthorization < COMPLETION_RUNNER_LIMITS.fixRetries,
    'INVALID_RETRY_ORDINAL',
    'retry ordinal must be within the bounded runner budget',
  );
  const exponential = Math.min(
    COMPLETION_RUNNER_LIMITS.retryBackoffCapMs,
    COMPLETION_RUNNER_LIMITS.retryBackoffBaseMs * (2 ** input.retrySpentBeforeAuthorization),
  );
  const material = governedHash('rorca.completion-retry-jitter.v1', {
    scopeHash: scopeHash(input.scope),
    priorDecisionHash: input.priorDecisionHash,
    retrySpentBeforeAuthorization: input.retrySpentBeforeAuthorization,
  } as never);
  const jitter = Number.parseInt(material.slice(-8), 16) % COMPLETION_RUNNER_LIMITS.retryJitterRangeMs;
  return exponential + jitter;
}

export function deriveCompletionOperationIdentity(input: {
  scope: ContinuationScope;
  plan: AttemptTaskPlanV1;
  batchId: string;
  taskIds: readonly string[];
}): { operationKey: string; executionNonce: string } {
  const batch = input.plan.batches.find((candidate) => candidate.batchId === input.batchId);
  invariant(batch, 'UNKNOWN_OPERATION_BATCH', 'operation batch is absent from the exact plan');
  const selected = new Set(input.taskIds);
  const taskOperationKeys = batch.tasks
    .filter((task) => selected.has(task.taskId))
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((task) => completionOperationKey({
      scope: input.scope,
      planId: input.plan.planId,
      planRevision: input.plan.planRevision,
      planHash: input.plan.planHash,
      batchId: input.batchId,
      taskId: task.taskId,
      objectiveHash: task.objectiveHash,
      payloadHash: governedHash('rorca.completion-task-effect-payload.v1', {
        coveredObligationIds: task.coveredObligationIds,
        allowedPaths: task.allowedPaths,
        commandHashes: task.commandHashes,
      } as never),
    }));
  invariant(taskOperationKeys.length === selected.size, 'UNKNOWN_OPERATION_TASK', 'operation task is absent from the exact batch');
  const operationKey = taskOperationKeys.length === 1
    ? taskOperationKeys[0]!
    : governedHash('rorca.completion-focused-batch-operation.v1', { taskOperationKeys } as never);
  const executionNonce = governedHash('rorca.completion-execution-nonce.v1', {
    operationKey,
    runtimeId: input.scope.runtimeId,
    runtimeGeneration: input.scope.runtimeGeneration,
    fencingToken: input.scope.fencingToken,
  } as never);
  return { operationKey, executionNonce };
}

export function completionFailureFingerprint(input: {
  decision: CompletionGateDecisionV1;
  validation: CompletionValidationReceipt;
  review: CompletionSelfReviewReceipt;
}): string {
  return governedHash('rorca.completion-failure-fingerprint.v1', {
    stage: input.decision.stage,
    outcome: input.decision.outcome,
    reasonCodes: uniqueSorted(input.decision.reasonCodes.map((value) => value.trim().toUpperCase())),
    failedObligationIds: uniqueSorted(input.decision.failedObligationIds),
    validationOutcome: input.validation.outcome,
    validationIssueCodes: uniqueSorted(input.validation.issueCodes.map((value) => value.trim().toUpperCase())),
    reviewOutcome: input.review.outcome,
    reviewIssueCodes: uniqueSorted(input.review.issueCodes.map((value) => value.trim().toUpperCase())),
  } as never);
}

export function isFinalCompletionReportEligible(closeout: StoryCloseoutDecision | null | undefined): boolean {
  return Boolean(closeout && verifyStoryCloseoutDecision(closeout) && closeout.status === 'accepted');
}

export function classifyCompletionGateOutcome(decision: CompletionGateDecisionV1): {
  authority: 'controller_contract' | 'host_semantic';
  classification: 'validated_not_complete' | 'bounded_fix_candidate' | 'cancelled' | 'quarantine' | 'blocked';
} {
  const authority = decision.stage === 'controller_preflight' ? 'controller_contract' : 'host_semantic';
  if (decision.outcome === 'validated') return { authority, classification: 'validated_not_complete' };
  if (decision.outcome === 'cancelled') return { authority, classification: 'cancelled' };
  if (decision.outcome === 'quarantined' || hasPermanentConflict(decision.reasonCodes)) return { authority, classification: 'quarantine' };
  if (decision.nextAction === 'continue_fix') return { authority, classification: 'bounded_fix_candidate' };
  return { authority, classification: 'blocked' };
}

function hasPermanentConflict(reasonCodes: readonly string[]): boolean {
  return reasonCodes.some((raw) => {
    const code = raw.trim().toUpperCase();
    return /(?:SCOPE|FENCE|FENCING|REPLAY|IDENTITY).*(?:CONFLICT|MISMATCH|STALE|VIOLATION)/.test(code)
      || /(?:CONFLICT|MISMATCH|STALE|VIOLATION).*(?:SCOPE|FENCE|FENCING|REPLAY|IDENTITY)/.test(code)
      || /^STALE_(?:PLAN|PROPOSAL|OBLIGATION|WORK_PACKAGE)_HASH$/.test(code);
  });
}

function assertWorkPackageBinding(input: CompletionRunnerTurnInput): void {
  const parsed = WorkPackageV1Schema.safeParse(input.workPackage);
  invariant(parsed.success, 'INVALID_WORK_PACKAGE', 'work package failed its governed schema');
  const workPackage = parsed.data;
  invariant(workPackage.workspaceId === input.scope.workspaceId, 'WORK_PACKAGE_SCOPE_MISMATCH', 'workspace identity differs');
  invariant(workPackage.missionId === input.scope.missionId, 'WORK_PACKAGE_SCOPE_MISMATCH', 'mission identity differs');
  invariant(workPackage.missionRevision === input.scope.missionRevision, 'WORK_PACKAGE_SCOPE_MISMATCH', 'mission revision differs');
  invariant(workPackage.missionHash === input.scope.missionHash, 'WORK_PACKAGE_SCOPE_MISMATCH', 'mission hash differs');
  invariant(workPackage.workPackageId === input.scope.workPackageId, 'WORK_PACKAGE_SCOPE_MISMATCH', 'work package identity differs');
  invariant(workPackage.workPackageRevision === input.scope.workPackageRevision, 'WORK_PACKAGE_SCOPE_MISMATCH', 'work package revision differs');
  invariant(workPackage.workPackageHash === input.scope.workPackageHash, 'WORK_PACKAGE_SCOPE_MISMATCH', 'work package hash differs');
  invariant(workPackage.retryLimit >= 0, 'INVALID_RETRY_LIMIT', 'negative retry budget is invalid');
}

function assertObligations(input: {
  scope: ContinuationScope;
  obligations: CanonicalObligationSetV1;
}): void {
  const parsed = CanonicalObligationSetV1Schema.safeParse(input.obligations);
  invariant(parsed.success, 'INVALID_OBLIGATION_SET', 'obligation set failed its governed schema');
  invariant(exactScope(input.scope, parsed.data.scope), 'OBLIGATION_SCOPE_MISMATCH', 'obligation set scope differs');
  invariant(parsed.data.state === 'active', 'OBLIGATION_SET_NOT_ACTIVE', 'runner may consume only an active obligation set');
}

function assertPlan(input: {
  scope: ContinuationScope;
  workPackage: WorkPackageV1;
  obligations: CanonicalObligationSetV1;
  previousPlan: AttemptTaskPlanV1 | null;
  settledTaskIds: readonly string[];
  plan: AttemptTaskPlanV1;
}): void {
  const parsed = AttemptTaskPlanV1Schema.safeParse(input.plan);
  invariant(parsed.success, 'INVALID_ATTEMPT_PLAN', 'attempt plan failed its governed schema');
  const plan = parsed.data;
  const samePersistedRevision = Boolean(
    input.previousPlan
      && plan.planId === input.previousPlan.planId
      && plan.planRevision === input.previousPlan.planRevision,
  );
  if (samePersistedRevision) {
    invariant(
      governedHash('rorca.completion-plan-immutable-compare.v1', plan as never)
        === governedHash('rorca.completion-plan-immutable-compare.v1', input.previousPlan as never),
      'PLAN_REVISION_REWRITE',
      'an existing plan revision is immutable',
    );
  } else {
    const validation = validateAttemptTaskPlan(plan, {
      workPackage: input.workPackage,
      obligationSet: input.obligations,
      priorPlan: input.previousPlan,
    });
    invariant(
      validation.valid,
      validation.valid ? 'INVALID_ATTEMPT_PLAN' : validation.violations[0]?.code.toUpperCase() ?? 'INVALID_ATTEMPT_PLAN',
      validation.valid ? 'attempt plan is valid' : validation.violations[0]?.message ?? 'attempt plan violates the frozen contract',
    );
  }
  invariant(exactScope(input.scope, plan.scope), 'PLAN_SCOPE_MISMATCH', 'plan scope differs');
  invariant(plan.obligationSetId === input.obligations.obligationSetId, 'PLAN_OBLIGATION_MISMATCH', 'plan obligation id differs');
  invariant(plan.obligationSetRevision === input.obligations.obligationSetRevision, 'PLAN_OBLIGATION_MISMATCH', 'plan obligation revision differs');
  invariant(plan.obligationSetHash === input.obligations.obligationSetHash, 'PLAN_OBLIGATION_MISMATCH', 'plan obligation hash differs');
  invariant(plan.batches.length <= COMPLETION_RUNNER_LIMITS.batches, 'PLAN_BATCH_LIMIT_EXCEEDED', 'plan contains too many batches');

  const allowedPaths = new Set(input.workPackage.allowedPaths);
  const obligationIds = new Set(input.obligations.obligations.map((obligation) => obligation.obligationId));
  const covered = new Set<string>();
  const taskIds = new Set<string>();
  const batchIds = new Set<string>();
  for (const batch of plan.batches) {
    invariant(!batchIds.has(batch.batchId), 'DUPLICATE_PLAN_BATCH', 'batch identities must be unique');
    batchIds.add(batch.batchId);
    invariant(batch.tasks.length <= COMPLETION_RUNNER_LIMITS.tasksPerBatch, 'PLAN_TASK_LIMIT_EXCEEDED', 'batch contains more than six tasks');
    const paths = new Set<string>();
    const commands = new Set<string>();
    for (const task of batch.tasks) {
      invariant(!taskIds.has(task.taskId), 'DUPLICATE_PLAN_TASK', 'task identities must be unique');
      taskIds.add(task.taskId);
      for (const obligationId of task.coveredObligationIds) {
        invariant(obligationIds.has(obligationId), 'UNKNOWN_PLAN_OBLIGATION', 'task references an unknown obligation');
        covered.add(obligationId);
      }
      for (const path of task.allowedPaths) {
        invariant(allowedPaths.has(path), 'PLAN_PATH_OUTSIDE_WORK_PACKAGE', 'task path exceeds work-package authority');
        paths.add(path);
      }
      for (const commandHash of task.commandHashes) commands.add(commandHash);
    }
    invariant(paths.size <= COMPLETION_RUNNER_LIMITS.mutablePathsPerBatch, 'PLAN_PATH_LIMIT_EXCEEDED', 'batch exceeds twenty mutable paths');
    invariant(commands.size <= COMPLETION_RUNNER_LIMITS.validationCommandsPerBatch, 'PLAN_COMMAND_LIMIT_EXCEEDED', 'batch exceeds eight validation commands');
  }
  for (const obligation of input.obligations.obligations) {
    invariant(!obligation.required || covered.has(obligation.obligationId), 'REQUIRED_OBLIGATION_OMITTED', 'plan omits required obligation coverage');
  }

  if (!input.previousPlan) {
    invariant(input.settledTaskIds.length === 0, 'SETTLED_WORK_WITHOUT_PRIOR_PLAN', 'settled work requires a prior immutable plan');
    return;
  }
  const previous = input.previousPlan;
  const previousTasks = new Map<string, { batchId: string; task: PlanTask }>();
  for (const batch of previous.batches) {
    for (const task of batch.tasks) previousTasks.set(task.taskId, { batchId: batch.batchId, task });
  }
  const nextTasks = new Map<string, { batchId: string; task: PlanTask }>();
  for (const batch of plan.batches) {
    for (const task of batch.tasks) nextTasks.set(task.taskId, { batchId: batch.batchId, task });
  }
  for (const taskId of input.settledTaskIds) {
    const priorTask = previousTasks.get(taskId);
    const nextTask = nextTasks.get(taskId);
    invariant(priorTask && nextTask, 'SETTLED_TASK_REMOVED', 'a revised plan removed settled work');
    invariant(
      priorTask.batchId === nextTask.batchId
        && artifactTaskSignature(priorTask.task) === artifactTaskSignature(nextTask.task),
      'SETTLED_TASK_REWRITTEN',
      'a revised plan moved or rewrote settled work',
    );
  }
}

function selectPendingBatch(plan: AttemptTaskPlanV1, settledTaskIds: ReadonlySet<string>): { batch: PlanBatch; taskIds: string[] } | null {
  for (const batch of [...plan.batches].sort((left, right) => left.ordinal - right.ordinal)) {
    const taskIds = batch.tasks
      .filter((task) => task.state === 'pending' && !settledTaskIds.has(task.taskId))
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((task) => task.taskId);
    if (taskIds.length > 0) return { batch, taskIds };
  }
  return null;
}

function requiredCommands(batch: PlanBatch, taskIds: readonly string[]): string[] {
  const selected = new Set(taskIds);
  return uniqueSorted(batch.tasks.filter((task) => selected.has(task.taskId)).flatMap((task) => task.commandHashes));
}

function assertOperation(operation: CompletionTaskOperation, expected: {
  scope: ContinuationScope;
  plan: AttemptTaskPlanV1;
  batchId: string;
  taskIds: readonly string[];
  operationKey: string;
  executionNonce: string;
}): void {
  invariant(operation.operationKey === expected.operationKey, 'OPERATION_KEY_MISMATCH', 'operation key differs');
  invariant(operation.executionNonce === expected.executionNonce, 'EXECUTION_NONCE_MISMATCH', 'execution nonce differs');
  invariant(operation.scopeHash === scopeHash(expected.scope), 'OPERATION_SCOPE_MISMATCH', 'operation scope differs');
  invariant(operation.fencingToken === expected.scope.fencingToken, 'OPERATION_FENCE_MISMATCH', 'operation fence differs');
  invariant(operation.planId === expected.plan.planId && operation.planRevision === expected.plan.planRevision && operation.planHash === expected.plan.planHash, 'OPERATION_PLAN_MISMATCH', 'operation plan differs');
  invariant(operation.batchId === expected.batchId, 'OPERATION_BATCH_MISMATCH', 'operation batch differs');
  invariant(operation.repositorySha === expected.scope.repository.currentSha, 'OPERATION_SHA_MISMATCH', 'operation repository SHA differs');
  invariant(governedHash('rorca.completion-task-id-set.v1', uniqueSorted(operation.taskIds) as never) === governedHash('rorca.completion-task-id-set.v1', uniqueSorted(expected.taskIds) as never), 'OPERATION_TASK_MISMATCH', 'operation task set differs');
}

function assertExecutionReceipt(receipt: CompletionExecutionReceipt, expected: {
  operation: CompletionTaskOperation;
  scope: ContinuationScope;
  plan: AttemptTaskPlanV1;
  batch: PlanBatch;
  taskIds: readonly string[];
}): void {
  invariant(receipt.operationKey === expected.operation.operationKey, 'EXECUTION_RECEIPT_KEY_MISMATCH', 'execution receipt operation differs');
  invariant(receipt.executionNonce === expected.operation.executionNonce, 'EXECUTION_RECEIPT_NONCE_MISMATCH', 'execution receipt nonce differs');
  invariant(receipt.scopeHash === scopeHash(expected.scope), 'EXECUTION_RECEIPT_SCOPE_MISMATCH', 'execution receipt scope differs');
  invariant(receipt.fencingToken === expected.scope.fencingToken, 'EXECUTION_RECEIPT_FENCE_MISMATCH', 'execution receipt fence differs');
  invariant(receipt.planId === expected.plan.planId && receipt.planRevision === expected.plan.planRevision && receipt.planHash === expected.plan.planHash, 'EXECUTION_RECEIPT_PLAN_MISMATCH', 'execution receipt plan differs');
  invariant(receipt.batchId === expected.batch.batchId, 'EXECUTION_RECEIPT_BATCH_MISMATCH', 'execution receipt batch differs');
  invariant(uniqueSorted(receipt.taskIds).join('\n') === uniqueSorted(expected.taskIds).join('\n'), 'EXECUTION_RECEIPT_TASK_MISMATCH', 'execution receipt task set differs');
  invariant(receipt.baseSha === expected.scope.repository.baseSha, 'EXECUTION_RECEIPT_BASE_SHA_MISMATCH', 'execution receipt base SHA differs');
  invariant(receipt.resultSha === expected.scope.repository.currentSha, 'EXECUTION_RECEIPT_RESULT_SHA_MISMATCH', 'execution receipt result SHA differs');
  assertGitSha(receipt.resultSha, 'INVALID_EXECUTION_RESULT_SHA');
  assertGitSha(receipt.treeHash, 'INVALID_EXECUTION_TREE_HASH');
  assertSha256(receipt.diffHash, 'INVALID_EXECUTION_DIFF_HASH');
  invariant(receipt.changedPathManifestHash === expected.scope.repository.changedPathManifestHash, 'EXECUTION_PATH_HASH_MISMATCH', 'execution changed-path manifest differs');
  assertSha256(receipt.sourceVectorHash, 'INVALID_SOURCE_VECTOR_HASH');
  assertIsoTimestamp(receipt.settledAt, 'INVALID_EXECUTION_TIMESTAMP');
  invariant(receipt.changedPaths.length <= COMPLETION_RUNNER_LIMITS.mutablePathsPerBatch, 'EXECUTION_PATH_LIMIT_EXCEEDED', 'execution changed too many paths');
  const allowed = new Set(expected.batch.tasks.flatMap((task) => task.allowedPaths));
  invariant(receipt.changedPaths.every((path) => allowed.has(path)), 'EXECUTION_PATH_OUTSIDE_BATCH', 'execution changed a path outside its batch');
}

function assertValidation(validation: CompletionValidationReceipt, input: {
  execution: CompletionExecutionReceipt;
  requiredCommandHashes: readonly string[];
  obligations: CanonicalObligationSetV1;
}): void {
  invariant(validation.operationKey === input.execution.operationKey, 'VALIDATION_OPERATION_MISMATCH', 'validation operation differs');
  invariant(validation.resultSha === input.execution.resultSha && validation.treeHash === input.execution.treeHash, 'VALIDATION_RESULT_MISMATCH', 'validation does not bind the execution result');
  invariant(validation.complete, 'INCOMPLETE_REQUIRED_VALIDATION', 'required validation is incomplete');
  assertSha256(validation.validationHash, 'INVALID_VALIDATION_HASH');
  assertIsoTimestamp(validation.validatedAt, 'INVALID_VALIDATION_TIMESTAMP');
  invariant(validation.commandHashes.length <= COMPLETION_RUNNER_LIMITS.validationCommandsPerBatch, 'VALIDATION_COMMAND_LIMIT_EXCEEDED', 'validation exceeds the batch command limit');
  const observed = new Set(validation.commandHashes);
  invariant(input.requiredCommandHashes.every((command) => observed.has(command)), 'REQUIRED_VALIDATION_SKIPPED', 'required validation command was skipped');
  const obligationIds = new Set(input.obligations.obligations.map((obligation) => obligation.obligationId));
  invariant(validation.failedObligationIds.every((id) => obligationIds.has(id)), 'UNKNOWN_FAILED_OBLIGATION', 'validation names an unknown obligation');
}

function assertReview(review: CompletionSelfReviewReceipt, input: {
  execution: CompletionExecutionReceipt;
  validation: CompletionValidationReceipt;
}): void {
  invariant(review.operationKey === input.execution.operationKey, 'REVIEW_OPERATION_MISMATCH', 'review operation differs');
  invariant(review.validationHash === input.validation.validationHash, 'REVIEW_VALIDATION_MISMATCH', 'review validation differs');
  invariant(review.resultSha === input.execution.resultSha, 'REVIEW_RESULT_MISMATCH', 'review result SHA differs');
  invariant(review.complete, 'INCOMPLETE_SELF_REVIEW', 'self-review is incomplete');
  assertSha256(review.reviewHash, 'INVALID_REVIEW_HASH');
  assertIsoTimestamp(review.reviewedAt, 'INVALID_REVIEW_TIMESTAMP');
}

function assertProposal(proposal: ResultProposalV1, input: {
  scope: ContinuationScope;
  plan: AttemptTaskPlanV1;
  execution: CompletionExecutionReceipt;
  ledgerHighWaterHash: string;
  previousProposal: ResultProposalV1 | null;
  validation: CompletionValidationReceipt;
  review: CompletionSelfReviewReceipt;
}): void {
  const parsed = ResultProposalV1Schema.safeParse(proposal);
  invariant(parsed.success, 'INVALID_RESULT_PROPOSAL', 'result proposal failed its governed schema');
  const contractValidation = validateResultProposal(parsed.data, {
    scope: input.scope,
    plan: input.plan,
    ledgerHighWater: input.ledgerHighWaterHash,
  });
  invariant(
    contractValidation.valid,
    contractValidation.valid ? 'INVALID_RESULT_PROPOSAL' : contractValidation.violations[0]?.code.toUpperCase() ?? 'INVALID_RESULT_PROPOSAL',
    contractValidation.valid ? 'result proposal is valid' : contractValidation.violations[0]?.message ?? 'result proposal violates the frozen contract',
  );
  invariant(exactScope(input.scope, parsed.data.scope), 'PROPOSAL_SCOPE_MISMATCH', 'proposal scope differs');
  invariant(parsed.data.planId === input.plan.planId && parsed.data.planRevision === input.plan.planRevision && parsed.data.planHash === input.plan.planHash, 'PROPOSAL_PLAN_MISMATCH', 'proposal plan differs');
  invariant(parsed.data.ledgerHighWaterHash === input.ledgerHighWaterHash, 'PROPOSAL_LEDGER_MISMATCH', 'proposal ledger high-water differs');
  invariant(parsed.data.baseSha === input.execution.baseSha && parsed.data.resultSha === input.execution.resultSha, 'PROPOSAL_SHA_MISMATCH', 'proposal SHA binding differs');
  invariant(parsed.data.treeHash === input.execution.treeHash && parsed.data.diffHash === input.execution.diffHash, 'PROPOSAL_RESULT_MISMATCH', 'proposal result binding differs');
  invariant(parsed.data.changedPathManifestHash === input.execution.changedPathManifestHash, 'PROPOSAL_PATH_MISMATCH', 'proposal path manifest differs');
  invariant(input.validation.complete && input.review.complete, 'PROPOSAL_PRECONDITION_MISSING', 'proposal requires validation and self-review');
  if (input.validation.outcome !== 'passed' || input.review.outcome !== 'ready') {
    invariant(parsed.data.disposition !== 'ready', 'UNVALIDATED_READY_PROPOSAL', 'a failed validation or review cannot be proposed as ready');
  }
  if (input.previousProposal) {
    invariant(parsed.data.proposalId !== input.previousProposal.proposalId, 'PROPOSAL_ID_REUSED', 'a rejected or superseded proposal id cannot be reused');
    invariant(parsed.data.proposalRevision > input.previousProposal.proposalRevision, 'PROPOSAL_REVISION_NOT_ADVANCED', 'a new proposal must advance its revision');
  }
}

function assertGateDecision(decision: CompletionGateDecisionV1, expected: {
  stage: CompletionGateDecisionV1['stage'];
  scope: ContinuationScope;
  obligations: CanonicalObligationSetV1;
  plan: AttemptTaskPlanV1;
  proposal: ResultProposalV1;
}): void {
  const parsed = CompletionGateDecisionV1Schema.safeParse(decision);
  invariant(parsed.success, 'INVALID_GATE_DECISION', 'gate decision failed its governed schema');
  invariant(parsed.data.stage === expected.stage, 'GATE_STAGE_MISMATCH', 'gate authority returned the wrong stage');
  invariant(exactScope(expected.scope, parsed.data.scope), 'GATE_SCOPE_MISMATCH', 'gate scope differs');
  invariant(parsed.data.proposalId === expected.proposal.proposalId && parsed.data.proposalRevision === expected.proposal.proposalRevision && parsed.data.proposalHash === expected.proposal.proposalHash, 'GATE_PROPOSAL_MISMATCH', 'gate proposal differs');
  invariant(parsed.data.planId === expected.plan.planId && parsed.data.planRevision === expected.plan.planRevision && parsed.data.planHash === expected.plan.planHash, 'GATE_PLAN_MISMATCH', 'gate plan differs');
  invariant(parsed.data.obligationSetId === expected.obligations.obligationSetId && parsed.data.obligationSetRevision === expected.obligations.obligationSetRevision && parsed.data.obligationSetHash === expected.obligations.obligationSetHash, 'GATE_OBLIGATION_MISMATCH', 'gate obligation set differs');
  invariant(parsed.data.establishesStoryCompletion === false, 'GATE_COMPLETION_AUTHORITY_VIOLATION', 'a gate cannot establish story completion');
}

function matchingValidation(state: CompletionRunnerDurableState, execution: CompletionExecutionReceipt): CompletionValidationReceipt | null {
  const candidates = state.validations.filter((item) => item.operationKey === execution.operationKey && item.resultSha === execution.resultSha);
  return last(candidates);
}

function matchingReview(state: CompletionRunnerDurableState, execution: CompletionExecutionReceipt): CompletionSelfReviewReceipt | null {
  const candidates = state.reviews.filter((item) => item.operationKey === execution.operationKey && item.resultSha === execution.resultSha);
  return last(candidates);
}

function matchingProposal(state: CompletionRunnerDurableState, execution: CompletionExecutionReceipt, plan: AttemptTaskPlanV1): ResultProposalV1 | null {
  const candidates = state.proposals.filter((item) => item.planHash === plan.planHash && item.resultSha === execution.resultSha && item.treeHash === execution.treeHash && item.diffHash === execution.diffHash);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const proposal = candidates[index]!;
    const decisions = state.gateDecisions.filter((decision) => decision.proposalId === proposal.proposalId && decision.proposalHash === proposal.proposalHash);
    const rejected = decisions.find((decision) => decision.outcome !== 'validated');
    const consumed = rejected && state.directives.some((directive) => directive.priorDecisionId === rejected.decisionId && directive.state === 'settled');
    if (!consumed) return proposal;
  }
  return null;
}

function matchingGate(state: CompletionRunnerDurableState, proposal: ResultProposalV1, stage: CompletionGateDecisionV1['stage']): CompletionGateDecisionV1 | null {
  const decisions = state.gateDecisions.filter((decision) => (
    decision.proposalId === proposal.proposalId
      && decision.proposalHash === proposal.proposalHash
      && decision.stage === stage
  ));
  const first = decisions[0];
  for (const decision of decisions.slice(1)) {
    invariant(
      first?.decisionId === decision.decisionId
        && first?.decisionRevision === decision.decisionRevision
        && first?.decisionHash === decision.decisionHash,
      'IMMUTABLE_GATE_CONFLICT',
      'one proposal and gate stage cannot have conflicting immutable decisions',
    );
  }
  return last(decisions);
}
function assertCurrentContinuationConsumption(
  lifecycle: CanonicalCompletionContinuationLifecycle,
  claim: CompletionContinuationConsumptionInput | undefined,
): void {
  invariant(lifecycle.state === 'settled'
    && lifecycle.dispatchId !== null
    && lifecycle.dispatchReceiptHash !== null,
  'SETTLED_CONTINUATION_LIFECYCLE_CONFLICT', 'settled continuation lacks its canonical dispatch acceptance');
  invariant(lifecycle.consumptionId !== null
    && lifecycle.consumptionHash !== null
    && lifecycle.consumedAt !== null,
  'SETTLED_CONTINUATION_NOT_CLAIMED', 'settled continuation has no current canonical one-use consumption claim');
  invariant(claim, 'SETTLED_CONTINUATION_CLAIM_MISSING', 'settled continuation requires the exact current canonical consumption claim');
  const directive = lifecycle.directive;
  invariant(claim.workspaceId === directive.scope.workspaceId
    && claim.attemptId === directive.scope.attemptId
    && claim.directiveId === directive.directiveId
    && claim.directiveRevision === directive.directiveRevision
    && claim.directiveHash === directive.directiveHash
    && claim.continuationKey === directive.continuationKey
    && claim.dispatchId === lifecycle.dispatchId
    && claim.dispatchReceiptHash === lifecycle.dispatchReceiptHash
    && claim.leaseId === directive.scope.leaseId
    && claim.fencingToken === directive.scope.fencingToken
    && claim.consumptionId === lifecycle.consumptionId
    && completionContinuationConsumptionHash(claim) === lifecycle.consumptionHash,
  'SETTLED_CONTINUATION_CLAIM_MISMATCH', 'continuation claim differs from the exact canonical lifecycle consumption');
}

async function observeControl(ports: CompletionRunnerPorts, scope: ContinuationScope, window: CompletionRunnerControlWindow): Promise<ControlStop | null> {
  const observation = await ports.control.observe({ scope, window });
  assertIsoTimestamp(observation.observedAt, 'INVALID_CONTROL_TIMESTAMP');
  if (observation.cancellation !== 'none') {
    invariant(observation.cancellationId === scope.cancellationId, 'CANCELLATION_SCOPE_MISMATCH', 'cancellation identity differs from the exact scope');
    return { status: 'cancelled', reasonCode: `cancellation_${observation.cancellation}`, observedAt: observation.observedAt };
  }
  if (Date.parse(observation.observedAt) >= Date.parse(scope.leaseExpiresAt)) {
    return { status: 'expired', reasonCode: 'lease_expired', observedAt: observation.observedAt };
  }
  return null;
}

async function recordEvent(ports: CompletionRunnerPorts, scope: ContinuationScope, cursor: LedgerCursor, event: CompletionRunnerDurableEvent): Promise<CompletionDurableWriteResult> {
  const result = await ports.durable.record({ scope, event });
  assertSha256(result.ledgerHighWaterHash, 'INVALID_LEDGER_HIGH_WATER');
  invariant(result.outcome !== 'conflict', 'DURABLE_RECEIPT_CONFLICT', 'durable receipt conflicts with existing immutable state');
  cursor.value = result.ledgerHighWaterHash;
  return result;
}

function baseResult(input: {
  status: CompletionRunnerTurnResult['status'];
  reasonCode: string;
  cursor: LedgerCursor;
  executedBatchId?: string | null;
  gateStage?: CompletionGateDecisionV1['stage'] | null;
  proposalId?: string | null;
  closeout?: StoryCloseoutDecision | null;
}): CompletionRunnerTurnResult {
  const eligible = isFinalCompletionReportEligible(input.closeout);
  return {
    status: eligible ? 'closeout_accepted' : input.status,
    reasonCode: eligible ? 'accepted_story_closeout' : input.reasonCode,
    executedBatchId: input.executedBatchId ?? null,
    gateStage: input.gateStage ?? null,
    proposalId: input.proposalId ?? null,
    closeoutDecisionId: input.closeout?.decisionId ?? null,
    finalReportEligible: eligible,
    ledgerHighWaterHash: input.cursor.value,
  };
}

async function recordControlStop(ports: CompletionRunnerPorts, scope: ContinuationScope, cursor: LedgerCursor, stop: ControlStop, executedBatchId: string | null): Promise<CompletionRunnerTurnResult> {
  await recordEvent(ports, scope, cursor, {
    eventType: 'terminal_recorded', observedAt: stop.observedAt, status: stop.status, reasonCode: stop.reasonCode,
  });
  return baseResult({ status: stop.status, reasonCode: stop.reasonCode, cursor, executedBatchId });
}

function retryBudgetId(scope: ContinuationScope): string {
  return `retry:${governedHash('rorca.completion-retry-budget-id.v1', {
    scopeHash: scopeHash(scope), fencingToken: scope.fencingToken,
  } as never).slice(7)}`;
}


async function handleGateFailure(input: {
  ports: CompletionRunnerPorts;
  scope: ContinuationScope;
  state: CompletionRunnerDurableState;
  cursor: LedgerCursor;
  workPackage: WorkPackageV1;
  obligations: CanonicalObligationSetV1;
  plan: AttemptTaskPlanV1;
  decision: CompletionGateDecisionV1;
  execution: CompletionExecutionReceipt;
  validation: CompletionValidationReceipt;
  review: CompletionSelfReviewReceipt;
  settledTaskIds: ReadonlySet<string>;
  executedBatchId: string | null;
  proposalId: string;
}): Promise<CompletionRunnerTurnResult> {
  const classification = classifyCompletionGateOutcome(input.decision);
  if (classification.classification === 'cancelled') {
    const stop: ControlStop = { status: 'cancelled', reasonCode: 'gate_cancelled', observedAt: input.ports.clock.now() };
    return recordControlStop(input.ports, input.scope, input.cursor, stop, input.executedBatchId);
  }
  if (classification.classification === 'quarantine') {
    await recordEvent(input.ports, input.scope, input.cursor, {
      eventType: 'terminal_recorded', observedAt: input.ports.clock.now(), status: 'quarantined', reasonCode: 'permanent_gate_conflict',
    });
    return baseResult({ status: 'quarantined', reasonCode: 'permanent_gate_conflict', cursor: input.cursor, executedBatchId: input.executedBatchId, gateStage: input.decision.stage, proposalId: input.proposalId });
  }

  const fingerprint = completionFailureFingerprint({ decision: input.decision, validation: input.validation, review: input.review });
  const existingFailure = input.state.retry.failures.find((failure) => failure.decisionId === input.decision.decisionId);
  const failure: CompletionFailureObservation = existingFailure ?? {
    decisionId: input.decision.decisionId,
    fingerprint,
    sourceVectorHash: input.execution.sourceVectorHash,
    observedAt: input.ports.clock.now(),
  };
  if (!existingFailure) {
    await recordEvent(input.ports, input.scope, input.cursor, { eventType: 'failure_observed', observedAt: failure.observedAt, failure });
  } else {
    invariant(existingFailure.fingerprint === fingerprint && existingFailure.sourceVectorHash === input.execution.sourceVectorHash, 'FAILURE_RECORD_CONFLICT', 'immutable failure observation differs');
  }
  const repeated = input.state.retry.failures.some((prior) => prior.decisionId !== input.decision.decisionId && prior.fingerprint === fingerprint && prior.sourceVectorHash === input.execution.sourceVectorHash);
  if (repeated) {
    await recordEvent(input.ports, input.scope, input.cursor, {
      eventType: 'terminal_recorded', observedAt: input.ports.clock.now(), status: 'quarantined', reasonCode: 'repeated_unchanged_failure',
    });
    return baseResult({ status: 'quarantined', reasonCode: 'repeated_unchanged_failure', cursor: input.cursor, executedBatchId: input.executedBatchId, gateStage: input.decision.stage, proposalId: input.proposalId });
  }
  if (classification.classification !== 'bounded_fix_candidate') {
    return baseResult({ status: 'blocked', reasonCode: 'gate_blocked', cursor: input.cursor, executedBatchId: input.executedBatchId, gateStage: input.decision.stage, proposalId: input.proposalId });
  }

  const existingDirective = last(input.state.directives.filter((directive) => directive.priorDecisionId === input.decision.decisionId && directive.priorDecisionHash === input.decision.decisionHash));
  if (existingDirective) {
    const parsed = ContinuationDirectiveV1Schema.safeParse(existingDirective);
    invariant(parsed.success, 'INVALID_CONTINUATION_DIRECTIVE', 'persisted continuation failed its governed schema');
    invariant(exactScope(input.scope, parsed.data.scope), 'CONTINUATION_SCOPE_MISMATCH', 'continuation scope differs');
    if (parsed.data.state === 'quarantined') return baseResult({ status: 'quarantined', reasonCode: 'continuation_quarantined', cursor: input.cursor, gateStage: input.decision.stage, proposalId: input.proposalId });
    if (parsed.data.state === 'expired' || Date.parse(parsed.data.authorizationExpiresAt) <= Date.parse(input.ports.clock.now())) {
      return baseResult({ status: 'expired', reasonCode: 'continuation_expired', cursor: input.cursor, gateStage: input.decision.stage, proposalId: input.proposalId });
    }
    return baseResult({ status: 'awaiting_continuation', reasonCode: `continuation_${parsed.data.state}`, cursor: input.cursor, gateStage: input.decision.stage, proposalId: input.proposalId });
  }

  const retryMaximum = completionFixBudget(input.workPackage.retryLimit);
  invariant(input.state.retry.retryFence === input.scope.fencingToken, 'RETRY_FENCE_MISMATCH', 'retry fence differs from the active writer fence');
  invariant(Number.isInteger(input.state.retry.spent) && input.state.retry.spent >= 0 && input.state.retry.spent <= retryMaximum, 'INVALID_RETRY_STATE', 'retry state exceeds the bounded work-package budget');
  if (input.state.retry.spent >= retryMaximum) {
    return baseResult({ status: 'blocked', reasonCode: 'retry_budget_exhausted', cursor: input.cursor, executedBatchId: input.executedBatchId, gateStage: input.decision.stage, proposalId: input.proposalId });
  }
  const afterCurrent = new Set(input.settledTaskIds);
  for (const taskId of input.execution.taskIds) afterCurrent.add(taskId);
  const target = selectPendingBatch(input.plan, afterCurrent);
  if (!target) {
    return baseResult({ status: 'blocked', reasonCode: 'no_bounded_fix_batch', cursor: input.cursor, executedBatchId: input.executedBatchId, gateStage: input.decision.stage, proposalId: input.proposalId });
  }
  const control = await observeControl(input.ports, input.scope, 'before_continuation');
  if (control) return recordControlStop(input.ports, input.scope, input.cursor, control, input.executedBatchId);

  const retrySpent = input.state.retry.spent;
  const backoffMs = completionRetryBackoffMs({ scope: input.scope, priorDecisionHash: input.decision.decisionHash, retrySpentBeforeAuthorization: retrySpent });
  const budgetId = retryBudgetId(input.scope);
  const directive = await input.ports.continuation.authorize({
    scope: input.scope,
    obligations: input.obligations,
    plan: input.plan,
    decision: input.decision,
    targetBatchId: target.batch.batchId,
    retryBudgetId: budgetId,
    retryFence: input.scope.fencingToken,
    retrySpent,
    retryMaximum,
    backoffMs,
  });
  const parsed = ContinuationDirectiveV1Schema.safeParse(directive);
  invariant(parsed.success, 'INVALID_CONTINUATION_DIRECTIVE', 'continuation failed its governed schema');
  const contractValidation = validateContinuationDirective(parsed.data, {
    decision: input.decision,
    candidateState: 'open',
    retryMaximum,
  });
  invariant(
    contractValidation.valid,
    contractValidation.valid ? 'INVALID_CONTINUATION_DIRECTIVE' : contractValidation.violations[0]?.code.toUpperCase() ?? 'INVALID_CONTINUATION_DIRECTIVE',
    contractValidation.valid ? 'continuation directive is valid' : contractValidation.violations[0]?.message ?? 'continuation violates the frozen contract',
  );
  invariant(exactScope(input.scope, parsed.data.scope), 'CONTINUATION_SCOPE_MISMATCH', 'continuation scope differs');
  invariant(parsed.data.state === 'authorized', 'CONTINUATION_NOT_AUTHORIZED', 'new continuation must be an authorization only');
  invariant(parsed.data.priorDecisionId === input.decision.decisionId && parsed.data.priorDecisionRevision === input.decision.decisionRevision && parsed.data.priorDecisionHash === input.decision.decisionHash, 'CONTINUATION_DECISION_MISMATCH', 'continuation decision differs');
  invariant(parsed.data.targetPlanId === input.plan.planId && parsed.data.targetPlanRevision === input.plan.planRevision && parsed.data.targetPlanHash === input.plan.planHash && parsed.data.targetBatchId === target.batch.batchId, 'CONTINUATION_TARGET_MISMATCH', 'continuation target differs');
  invariant(parsed.data.retryBudgetId === budgetId && parsed.data.retryFence === input.scope.fencingToken && parsed.data.retrySpent === retrySpent && parsed.data.retryMaximum === retryMaximum, 'CONTINUATION_BUDGET_MISMATCH', 'continuation retry budget differs');
  invariant(parsed.data.failedObligationIds.join('\n') === input.decision.failedObligationIds.join('\n'), 'CONTINUATION_FAILURE_MISMATCH', 'continuation failures differ');
  await recordEvent(input.ports, input.scope, input.cursor, { eventType: 'continuation_recorded', observedAt: input.ports.clock.now(), directive: parsed.data, backoffMs });
  return baseResult({ status: 'awaiting_continuation', reasonCode: 'bounded_fix_authorized', cursor: input.cursor, executedBatchId: input.executedBatchId, gateStage: input.decision.stage, proposalId: input.proposalId });
}

async function runCompletionRunnerTurnCore(input: CompletionRunnerTurnInput, ports: CompletionRunnerPorts): Promise<CompletionRunnerTurnResult> {
  assertWorkPackageBinding(input);
  const state = await ports.durable.reloadAndReconcile({ scope: input.scope });
  assertSha256(state.ledgerHighWaterHash, 'INVALID_LEDGER_HIGH_WATER');
  invariant(exactScope(input.scope, state.scope), 'DURABLE_SCOPE_MISMATCH', 'durable state scope differs');
  const cursor: LedgerCursor = { value: state.ledgerHighWaterHash };
  if (state.reconciliation === 'quarantined' || state.terminal?.status === 'quarantined') {
    return baseResult({ status: 'quarantined', reasonCode: state.terminal?.reasonCode ?? 'reconciliation_quarantined', cursor });
  }
  const persistedCloseout = last(state.closeoutDecisions);
  if (persistedCloseout) {
    invariant(verifyStoryCloseoutDecision(persistedCloseout), 'INVALID_CLOSEOUT_DECISION', 'persisted closeout decision is not immutable');
    return baseResult({ status: persistedCloseout.status === 'accepted' ? 'closeout_accepted' : 'blocked', reasonCode: `closeout_${persistedCloseout.status}`, cursor, closeout: persistedCloseout });
  }
  if (state.terminal) return baseResult({ status: state.terminal.status, reasonCode: state.terminal.reasonCode, cursor });

  const initialControl = await observeControl(ports, input.scope, 'turn_start');
  if (initialControl) return recordControlStop(ports, input.scope, cursor, initialControl, null);
  const activeDirective = last(state.directives);
  if (activeDirective) {
    const parsed = ContinuationDirectiveV1Schema.safeParse(activeDirective);
    invariant(parsed.success, 'INVALID_CONTINUATION_DIRECTIVE', 'persisted continuation failed its governed schema');
    invariant(exactScope(input.scope, parsed.data.scope), 'CONTINUATION_SCOPE_MISMATCH', 'continuation scope differs');
    if (parsed.data.state === 'authorized' || parsed.data.state === 'dispatched') {
      if (Date.parse(parsed.data.authorizationExpiresAt) <= Date.parse(ports.clock.now())) return baseResult({ status: 'expired', reasonCode: 'continuation_expired', cursor });
      return baseResult({ status: 'awaiting_continuation', reasonCode: `continuation_${parsed.data.state}`, cursor });
    }
    if (parsed.data.state === 'expired') return baseResult({ status: 'expired', reasonCode: 'continuation_expired', cursor });
    if (parsed.data.state === 'quarantined') return baseResult({ status: 'quarantined', reasonCode: 'continuation_quarantined', cursor });
  }
  if (activeDirective?.state === 'settled') {
    const lifecycle = state.continuationLifecycles.find((candidate) => (
      candidate.directive.directiveId === activeDirective.directiveId
        && candidate.directive.directiveRevision === activeDirective.directiveRevision
        && candidate.directive.directiveHash === activeDirective.directiveHash
        && candidate.directive.continuationKey === activeDirective.continuationKey
    ));
    invariant(lifecycle, 'SETTLED_CONTINUATION_LIFECYCLE_MISSING', 'settled continuation lacks its canonical lifecycle projection');
    assertCurrentContinuationConsumption(lifecycle, input.continuationConsumptionClaim);
  } else {
    invariant(!input.continuationConsumptionClaim, 'CONTINUATION_CLAIM_WITHOUT_SETTLEMENT',
      'continuation consumption claim cannot be used without the matching settled directive');
  }

  const obligations = await ports.obligations.load({ scope: input.scope });
  assertObligations({ scope: input.scope, obligations });
  if (state.plan) {
    const previousParsed = AttemptTaskPlanV1Schema.safeParse(state.plan);
    invariant(previousParsed.success, 'INVALID_PRIOR_ATTEMPT_PLAN', 'persisted plan failed its governed schema');
    invariant(exactScope(input.scope, previousParsed.data.scope), 'PLAN_SCOPE_MISMATCH', 'persisted plan scope differs');
  }
  const plan = await ports.planner.createOrRevise({
    scope: input.scope,
    obligations,
    workPackage: input.workPackage,
    previousPlan: state.plan,
    settledTaskIds: state.settledTaskIds,
    priorDirective: activeDirective?.state === 'settled' ? activeDirective : null,
  });
  assertPlan({ scope: input.scope, workPackage: input.workPackage, obligations, previousPlan: state.plan, settledTaskIds: state.settledTaskIds, plan });
  if (activeDirective?.state === 'settled') {
    invariant(
      activeDirective.targetPlanId === plan.planId
        && activeDirective.targetPlanRevision === plan.planRevision
        && activeDirective.targetPlanHash === plan.planHash,
      'CONTINUATION_TARGET_MISMATCH',
      'settled continuation does not bind the exact executable plan',
    );
  }
  const settledTaskIds = new Set(state.settledTaskIds);
  let selected = selectPendingBatch(plan, settledTaskIds);
  if (activeDirective?.state === 'settled') {
    invariant(selected?.batch.batchId === activeDirective.targetBatchId, 'CONTINUATION_TARGET_MISMATCH', 'settled continuation does not bind the next focused batch');
  }

  let execution: CompletionExecutionReceipt | null = null;
  let operation: CompletionTaskOperation | null = null;
  let executedBatchId: string | null = null;
  if (selected) {
    const identity = deriveCompletionOperationIdentity({ scope: input.scope, plan, batchId: selected.batch.batchId, taskIds: selected.taskIds });
    const matchingOperations = state.operations.filter((item) => item.operationKey === identity.operationKey);
    for (const candidate of matchingOperations) {
      assertOperation(candidate, { scope: input.scope, plan, batchId: selected.batch.batchId, taskIds: selected.taskIds, ...identity });
    }
    operation = last(matchingOperations);
    if (!operation) {
      const control = await observeControl(ports, input.scope, 'before_execution');
      if (control) return recordControlStop(ports, input.scope, cursor, control, null);
      operation = {
        ...identity,
        scopeHash: scopeHash(input.scope),
        fencingToken: input.scope.fencingToken,
        planId: plan.planId,
        planRevision: plan.planRevision,
        planHash: plan.planHash,
        batchId: selected.batch.batchId,
        taskIds: [...selected.taskIds],
        repositorySha: input.scope.repository.currentSha,
        state: 'reserved',
        receipt: null,
      };
      const reservation = await recordEvent(ports, input.scope, cursor, { eventType: 'operation_reserved', observedAt: ports.clock.now(), operation });
      if (reservation.outcome === 'exact_duplicate') {
        return baseResult({ status: 'awaiting_reconciliation', reasonCode: 'duplicate_operation_reservation', cursor, executedBatchId: selected.batch.batchId });
      }
    } else {
      assertOperation(operation, { scope: input.scope, plan, batchId: selected.batch.batchId, taskIds: selected.taskIds, ...identity });
    }

    if (operation.state === 'settled') {
      invariant(operation.receipt, 'SETTLED_OPERATION_MISSING_RECEIPT', 'settled operation has no receipt');
      execution = operation.receipt;
      assertExecutionReceipt(execution, { operation, scope: input.scope, plan, batch: selected.batch, taskIds: selected.taskIds });
    } else if (state.operations.some((item) => item.operationKey === operation!.operationKey)) {
      const reconciliation = await ports.executor.reconcile({ scope: input.scope, operation });
      if (reconciliation.state === 'conflict') throw new CompletionRunnerInvariantError('EXECUTION_RECONCILIATION_CONFLICT', reconciliation.reasonCode);
      if (reconciliation.state === 'uncertain') return baseResult({ status: 'awaiting_reconciliation', reasonCode: 'execution_effect_uncertain', cursor, executedBatchId: selected.batch.batchId });
      if (reconciliation.state === 'settled') {
        execution = reconciliation.receipt;
        assertExecutionReceipt(execution, { operation, scope: input.scope, plan, batch: selected.batch, taskIds: selected.taskIds });
        await recordEvent(ports, input.scope, cursor, { eventType: 'operation_reconciled', observedAt: ports.clock.now(), operation: { ...operation, state: 'settled', receipt: execution }, receipt: execution });
      }
    }

    if (!execution) {
      try {
        execution = await ports.executor.execute({
          scope: input.scope,
          plan,
          batch: selected.batch,
          taskIds: selected.taskIds,
          operationKey: operation.operationKey,
          executionNonce: operation.executionNonce,
        });
      } catch (error) {
        const uncertain: CompletionTaskOperation = { ...operation, state: 'uncertain', receipt: null };
        const failureHash = governedHash('rorca.completion-execution-uncertain.v1', {
          operationKey: operation.operationKey,
          errorName: error instanceof Error ? error.name : 'UnknownThrownValue',
        } as never);
        await recordEvent(ports, input.scope, cursor, { eventType: 'operation_uncertain', observedAt: ports.clock.now(), operation: uncertain, failureHash });
        return baseResult({ status: 'awaiting_reconciliation', reasonCode: 'execution_effect_uncertain', cursor, executedBatchId: selected.batch.batchId });
      }
      assertExecutionReceipt(execution, { operation, scope: input.scope, plan, batch: selected.batch, taskIds: selected.taskIds });
      await recordEvent(ports, input.scope, cursor, { eventType: 'operation_settled', observedAt: ports.clock.now(), operation: { ...operation, state: 'settled', receipt: execution }, receipt: execution });
    }
    executedBatchId = selected.batch.batchId;
  } else {
    const latestSettled = last(state.operations.filter((item) => item.state === 'settled' && item.receipt));
    if (!latestSettled?.receipt) return baseResult({ status: 'blocked', reasonCode: 'no_pending_or_settled_batch', cursor });
    const batch = plan.batches.find((item) => item.batchId === latestSettled.batchId);
    invariant(batch, 'SETTLED_BATCH_REMOVED', 'settled operation batch is absent from the plan');
    operation = latestSettled;
    selected = { batch, taskIds: latestSettled.taskIds };
    execution = latestSettled.receipt;
    assertExecutionReceipt(execution, { operation, scope: input.scope, plan, batch, taskIds: latestSettled.taskIds });
  }

  invariant(operation && execution && selected, 'MISSING_EXECUTION_STATE', 'runner could not establish execution state');
  const persistedValidation = matchingValidation(state, execution);
  const persistedReview = matchingReview(state, execution);
  const persistedProposal = matchingProposal(state, execution, plan);
  invariant(!persistedReview || persistedValidation, 'REVIEW_PRECEDES_VALIDATION', 'durable self-review exists without validation');
  invariant(!persistedProposal || persistedReview, 'PROPOSAL_PRECEDES_SELF_REVIEW', 'durable proposal exists without self-review');

  const afterExecutionControl = await observeControl(ports, input.scope, 'after_execution');
  const commands = requiredCommands(selected.batch, execution.taskIds);
  let validation = persistedValidation;
  if (!validation) {
    validation = await ports.validation.validate({ scope: input.scope, obligations, plan, batch: selected.batch, execution, requiredCommandHashes: commands });
    assertValidation(validation, { execution, requiredCommandHashes: commands, obligations });
    await recordEvent(ports, input.scope, cursor, { eventType: 'validation_recorded', observedAt: ports.clock.now(), validation });
  } else {
    assertValidation(validation, { execution, requiredCommandHashes: commands, obligations });
  }
  if (afterExecutionControl) return recordControlStop(ports, input.scope, cursor, afterExecutionControl, executedBatchId);

  let control = await observeControl(ports, input.scope, 'before_review');
  if (control) return recordControlStop(ports, input.scope, cursor, control, executedBatchId);
  let review = persistedReview;
  if (!review) {
    review = await ports.review.review({ scope: input.scope, obligations, plan, execution, validation });
    assertReview(review, { execution, validation });
    await recordEvent(ports, input.scope, cursor, { eventType: 'review_recorded', observedAt: ports.clock.now(), review });
  } else {
    assertReview(review, { execution, validation });
  }
  const settledAfterBatch = new Set(settledTaskIds);
  for (const taskId of execution.taskIds) settledAfterBatch.add(taskId);
  if (!persistedProposal && validation.outcome === 'passed' && review.outcome === 'ready' && selectPendingBatch(plan, settledAfterBatch)) {
    return baseResult({
      status: 'advanced',
      reasonCode: 'focused_batch_settled',
      cursor,
      executedBatchId,
    });
  }

  control = await observeControl(ports, input.scope, 'before_proposal');
  if (control) return recordControlStop(ports, input.scope, cursor, control, executedBatchId);
  let proposal = persistedProposal;
  if (!proposal) {
    const previousProposal = last(state.proposals);
    const proposalLedgerHighWater = cursor.value;
    proposal = await ports.proposal.create({ scope: input.scope, obligations, plan, execution, validation, review, ledgerHighWaterHash: proposalLedgerHighWater, priorProposal: previousProposal });
    assertProposal(proposal, { scope: input.scope, plan, execution, ledgerHighWaterHash: proposalLedgerHighWater, previousProposal, validation, review });
    await recordEvent(ports, input.scope, cursor, { eventType: 'proposal_recorded', observedAt: ports.clock.now(), proposal });
  } else {
    const parsed = ResultProposalV1Schema.safeParse(proposal);
    invariant(parsed.success, 'INVALID_RESULT_PROPOSAL', 'persisted proposal failed its governed schema');
    invariant(exactScope(input.scope, parsed.data.scope), 'PROPOSAL_SCOPE_MISMATCH', 'persisted proposal scope differs');
  }

  control = await observeControl(ports, input.scope, 'before_controller_preflight');
  if (control) return recordControlStop(ports, input.scope, cursor, control, executedBatchId);
  let controllerDecision = matchingGate(state, proposal, 'controller_preflight');
  if (!controllerDecision) {
    controllerDecision = await ports.gate.controllerPreflight({ scope: input.scope, obligations, plan, proposal, validation, review });
    assertGateDecision(controllerDecision, { stage: 'controller_preflight', scope: input.scope, obligations, plan, proposal });
    await recordEvent(ports, input.scope, cursor, { eventType: 'gate_recorded', observedAt: ports.clock.now(), decision: controllerDecision });
  } else {
    assertGateDecision(controllerDecision, { stage: 'controller_preflight', scope: input.scope, obligations, plan, proposal });
  }
  if (controllerDecision.outcome !== 'validated') {
    return handleGateFailure({ ports, scope: input.scope, state, cursor, workPackage: input.workPackage, obligations, plan, decision: controllerDecision, execution, validation, review, settledTaskIds, executedBatchId, proposalId: proposal.proposalId });
  }

  control = await observeControl(ports, input.scope, 'before_host_semantic');
  if (control) return recordControlStop(ports, input.scope, cursor, control, executedBatchId);
  let hostDecision = matchingGate(state, proposal, 'host_semantic');
  if (!hostDecision) {
    hostDecision = await ports.gate.hostSemantic({ scope: input.scope, obligations, plan, proposal, controllerDecision, validation, review });
    assertGateDecision(hostDecision, { stage: 'host_semantic', scope: input.scope, obligations, plan, proposal });
    await recordEvent(ports, input.scope, cursor, { eventType: 'gate_recorded', observedAt: ports.clock.now(), decision: hostDecision });
  } else {
    assertGateDecision(hostDecision, { stage: 'host_semantic', scope: input.scope, obligations, plan, proposal });
  }
  if (hostDecision.outcome !== 'validated') {
    return handleGateFailure({ ports, scope: input.scope, state, cursor, workPackage: input.workPackage, obligations, plan, decision: hostDecision, execution, validation, review, settledTaskIds, executedBatchId, proposalId: proposal.proposalId });
  }

  if (hostDecision.nextAction !== 'submit_closeout') {
    return baseResult({ status: 'advanced', reasonCode: 'host_gate_validated_not_complete', cursor, executedBatchId, gateStage: 'host_semantic', proposalId: proposal.proposalId });
  }
  control = await observeControl(ports, input.scope, 'before_closeout');
  if (control) return recordControlStop(ports, input.scope, cursor, control, executedBatchId);
  const closeout = await ports.closeout.submit({ scope: input.scope, obligations, plan, proposal, controllerDecision, hostDecision, validation, review });
  invariant(verifyStoryCloseoutDecision(closeout), 'INVALID_CLOSEOUT_DECISION', 'closeout port returned a mutable or forged decision');
  await recordEvent(ports, input.scope, cursor, { eventType: 'closeout_recorded', observedAt: ports.clock.now(), decision: closeout });
  return baseResult({ status: closeout.status === 'accepted' ? 'closeout_accepted' : 'blocked', reasonCode: `closeout_${closeout.status}`, cursor, executedBatchId, gateStage: 'host_semantic', proposalId: proposal.proposalId, closeout });
}

export async function runCompletionRunnerTurn(input: CompletionRunnerTurnInput, ports: CompletionRunnerPorts): Promise<CompletionRunnerTurnResult> {
  try {
    return await runCompletionRunnerTurnCore(input, ports);
  } catch (error) {
    if (!(error instanceof CompletionRunnerInvariantError)) throw error;
    const observedAt = ports.clock.now();
    const event: CompletionRunnerDurableEvent = { eventType: 'terminal_recorded', observedAt, status: 'quarantined', reasonCode: error.reasonCode };
    const recorded = await ports.durable.record({ scope: input.scope, event });
    if (recorded.outcome === 'conflict') throw error;
    return {
      status: 'quarantined',
      reasonCode: error.reasonCode,
      executedBatchId: null,
      gateStage: null,
      proposalId: null,
      closeoutDecisionId: null,
      finalReportEligible: false,
      ledgerHighWaterHash: recorded.ledgerHighWaterHash,
    };
  }
}

function continuationConsumptionId(lifecycle: CanonicalCompletionContinuationLifecycle): string {
  return `consumption:${governedHash('rorca.completion-continuation-consumption-id.v1', {
    workspaceId: lifecycle.directive.scope.workspaceId,
    attemptId: lifecycle.directive.scope.attemptId,
    directiveId: lifecycle.directive.directiveId,
    directiveRevision: lifecycle.directive.directiveRevision,
    directiveHash: lifecycle.directive.directiveHash,
    continuationKey: lifecycle.directive.continuationKey,
    dispatchId: lifecycle.dispatchId,
    dispatchReceiptHash: lifecycle.dispatchReceiptHash,
    leaseId: lifecycle.directive.scope.leaseId,
    fencingToken: lifecycle.directive.scope.fencingToken,
  } as never).slice('sha256:'.length)}`;
}

/**
 * Production entrypoint for one bounded Completion Runner turn. Durable state is
 * opened and reconciled before any planning/execution port is reachable, every
 * staged artifact is receipt-backed by the persistence adapter, and the local
 * ledger is closed on every outcome.
 */
export async function runCompletionRunner(
  input: DurableCompletionRunnerInput,
  ports: CompletionRunnerPortsWithoutDurable,
): Promise<CompletionRunnerTurnResult> {
  const persistence = await createCompletionRunnerPersistence({
    ...input.persistence,
    scope: input.scope,
    writerFence: input.scope.fencingToken,
  });
  try {
    const durable = await persistence.durable.reloadAndReconcile({ scope: input.scope });
    const latestDirective = durable.directives.at(-1);
    let acceptedClaim: CompletionContinuationConsumptionInput | undefined;
    if (latestDirective?.state === 'settled') {
      const lifecycle = durable.continuationLifecycles.find((candidate) => (
        candidate.directive.directiveId === latestDirective.directiveId
          && candidate.directive.directiveRevision === latestDirective.directiveRevision
          && candidate.directive.directiveHash === latestDirective.directiveHash
          && candidate.directive.continuationKey === latestDirective.continuationKey
      ));
      if (!lifecycle || !lifecycle.dispatchId || !lifecycle.dispatchReceiptHash) {
        throw new CompletionRunnerInvariantError(
          'SETTLED_CONTINUATION_LIFECYCLE_CONFLICT',
          'settled continuation lacks its exact canonical receiver acceptance',
        );
      }
      if (lifecycle.consumptionId || lifecycle.consumptionHash || lifecycle.consumedAt) {
        throw new CompletionRunnerInvariantError(
          'SETTLED_CONTINUATION_ALREADY_CONSUMED',
          'settled continuation one-use claim was already consumed',
        );
      }
      acceptedClaim = {
        workspaceId: latestDirective.scope.workspaceId,
        attemptId: latestDirective.scope.attemptId,
        directiveId: latestDirective.directiveId,
        directiveRevision: latestDirective.directiveRevision,
        directiveHash: latestDirective.directiveHash,
        continuationKey: latestDirective.continuationKey,
        dispatchId: lifecycle.dispatchId,
        dispatchReceiptHash: lifecycle.dispatchReceiptHash,
        leaseId: latestDirective.scope.leaseId,
        fencingToken: latestDirective.scope.fencingToken,
        consumptionId: continuationConsumptionId(lifecycle),
      };
      const consumed = await persistence.consumeContinuation(acceptedClaim);
      if (consumed.disposition !== 'accepted') {
        throw new CompletionRunnerInvariantError(
          'SETTLED_CONTINUATION_CAS_LOST',
          'only the winner of the canonical one-use consumption CAS may execute',
        );
      }
    }
    return await runCompletionRunnerTurn(
      {
        scope: input.scope,
        workPackage: input.workPackage,
        continuationConsumptionClaim: acceptedClaim,
      },
      persistence.wrapPorts(ports),
    );
  } finally {
    persistence.close();
  }
}
