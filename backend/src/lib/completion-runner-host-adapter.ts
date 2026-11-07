/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  governedHash,
  type AttemptTaskPlanV1,
  type CanonicalObligationSetV1,
  type CompletionGateDecisionV1,
  type ResultProposalV1,
  type WorkPackageV1,
} from './governed-contracts';
import {
  runCompletionRunner,
  type CompletionExecutionReceipt,
  type CompletionRunnerPortsWithoutDurable,
  type CompletionRunnerTurnResult,
  type CompletionSelfReviewReceipt,
  type CompletionValidationReceipt,
} from './completion-runner';
import {
  loadProductionCompletionContext,
  observeProductionCompletionControl,
  type ProductionCompletionContextIdentity,
  type ReadyProductionCompletionContext,
} from './completion-runner-production-context';
import type { HostValidationObservation, StoryCloseoutDecision } from './story-closeout';

const SHA256_PREFIX_LENGTH = 'sha256:'.length;

export interface ProductionCompletionStoryInput {
  identity: ProductionCompletionContextIdentity;
  stateRoot: string;
  checkoutRoot: string;
  result: {
    baseSha: string;
    resultSha: string;
    treeHash: string;
    diffHash: string;
    changedPaths: readonly string[];
    sourceVectorHash: string;
    settledAt: string;
  };
  requiredCommandHashes: readonly string[];
  validations: readonly HostValidationObservation[];
  selfAuditIssueCodes: readonly string[];
  submitCloseout(): Promise<StoryCloseoutDecision>;
}

export type ProductionCompletionStoryResult =
  | { kind: 'not_governed' }
  | { kind: 'blocked'; reasonCode: string; runner: null }
  | { kind: 'runner'; runner: CompletionRunnerTurnResult };

function stableId(prefix: string, hash: string): string {
  return `${prefix}:${hash.slice(SHA256_PREFIX_LENGTH, SHA256_PREFIX_LENGTH + 40)}`;
}

function artifactHash(domain: string, value: unknown): string {
  return governedHash(domain, value as never);
}

function planFor(input: {
  scope: CanonicalObligationSetV1['scope'];
  workPackage: WorkPackageV1;
  obligations: CanonicalObligationSetV1;
  previousPlan: AttemptTaskPlanV1 | null;
  commandHashes: readonly string[];
  createdAt: string;
}): AttemptTaskPlanV1 {
  if (input.previousPlan) return input.previousPlan;
  if (input.workPackage.allowedPaths.length > 20) throw new Error('Production Completion Runner requires a focused work package of at most twenty paths');
  const commands = [...new Set(input.commandHashes)].sort();
  if (commands.length > 8) throw new Error('Production Completion Runner requires a focused validation set of at most eight commands');
  const coveredObligationIds = input.obligations.obligations.map((item) => item.obligationId);
  const planMaterial = {
    scope: input.scope,
    obligationSetId: input.obligations.obligationSetId,
    obligationSetRevision: input.obligations.obligationSetRevision,
    obligationSetHash: input.obligations.obligationSetHash,
    objectiveHash: input.workPackage.objectiveHash,
    allowedPaths: input.workPackage.allowedPaths,
    commandHashes: commands,
    coveredObligationIds,
  };
  const planHash = artifactHash('rorca.production-completion-plan.v1', planMaterial);
  const planId = stableId('plan', planHash);
  const batchId = stableId('batch', artifactHash('rorca.production-completion-batch.v1', planMaterial));
  const taskId = stableId('task', artifactHash('rorca.production-completion-task.v1', planMaterial));
  const batches: AttemptTaskPlanV1['batches'] = [{
    batchId,
    ordinal: 0,
    tasks: [{
      taskId,
      ordinal: 0,
      objectiveHash: input.workPackage.objectiveHash,
      coveredObligationIds,
      allowedPaths: [...input.workPackage.allowedPaths],
      commandHashes: commands,
      state: 'pending',
    }],
  }];
  return {
    schemaVersion: 'rorca.attempt-task-plan.v1',
    contractId: 'rorca.attempt-task-plan.v1',
    contractVersion: '1.0.0',
    artifactId: stableId('artifact', planHash),
    contentHash: planHash,
    createdAt: input.createdAt,
    createdBy: input.scope.runtimeId,
    scope: input.scope,
    planId,
    planRevision: 1,
    planHash,
    priorPlanHash: 'not_applicable',
    obligationSetId: input.obligations.obligationSetId,
    obligationSetRevision: input.obligations.obligationSetRevision,
    obligationSetHash: input.obligations.obligationSetHash,
    batches,
    totalBatches: 1,
    totalTasks: 1,
    totalMutablePaths: new Set(input.workPackage.allowedPaths).size,
    totalValidationCommands: commands.length,
    serializedBytes: Buffer.byteLength(JSON.stringify({ ...planMaterial, batches }), 'utf8'),
  };
}

function executionReceipt(
  input: ProductionCompletionStoryInput,
  scope: CanonicalObligationSetV1['scope'],
  plan: AttemptTaskPlanV1,
  batch: AttemptTaskPlanV1['batches'][number],
  taskIds: readonly string[],
  operationKey: string,
  executionNonce: string,
): CompletionExecutionReceipt {
  const allowed = new Set(batch.tasks.flatMap((task) => task.allowedPaths));
  const changedPaths = [...new Set(input.result.changedPaths)].sort();
  if (changedPaths.length > 20 || changedPaths.some((item) => !allowed.has(item))) {
    throw new Error('Observed result exceeds the exact focused-batch path authority');
  }
  if (input.result.baseSha !== scope.repository.baseSha
      || input.result.resultSha !== scope.repository.currentSha) {
    throw new Error('Observed result differs from the exact governed repository scope');
  }
  return {
    operationKey,
    executionNonce,
    scopeHash: governedHash('rorca.continuation-scope.v1', scope as never),
    fencingToken: scope.fencingToken,
    planId: plan.planId,
    planRevision: plan.planRevision,
    planHash: plan.planHash,
    batchId: batch.batchId,
    taskIds: [...taskIds],
    baseSha: input.result.baseSha,
    resultSha: input.result.resultSha,
    treeHash: input.result.treeHash,
    diffHash: input.result.diffHash,
    changedPathManifestHash: scope.repository.changedPathManifestHash,
    changedPaths,
    sourceVectorHash: input.result.sourceVectorHash,
    mutation: changedPaths.length === 0 ? 'none' : 'material',
    settledAt: input.result.settledAt,
  };
}

function validationReceipt(input: {
  execution: CompletionExecutionReceipt;
  requiredCommandHashes: readonly string[];
  observations: readonly HostValidationObservation[];
  obligations: CanonicalObligationSetV1;
}): CompletionValidationReceipt {
  const required = [...new Set(input.requiredCommandHashes)].sort();
  const exactObservations = required.map((hash) => input.observations.find((item) => item.commandHash === hash));
  const complete = exactObservations.every(Boolean);
  const passed = complete && exactObservations.every((item) => item?.classification === 'passed' || item?.classification === 'unrelated_baseline');
  const issueCodes = complete
    ? exactObservations.filter((item) => item?.classification !== 'passed' && item?.classification !== 'unrelated_baseline')
      .map((item) => `VALIDATION_${String(item?.classification ?? 'missing').toUpperCase()}`)
    : ['REQUIRED_VALIDATION_MISSING'];
  const failedObligationIds = passed ? [] : input.obligations.obligations.filter((item) => item.required).map((item) => item.obligationId);
  const material = {
    operationKey: input.execution.operationKey,
    resultSha: input.execution.resultSha,
    treeHash: input.execution.treeHash,
    commandHashes: required,
    complete,
    outcome: passed ? 'passed' : 'failed',
    failedObligationIds,
    issueCodes,
  };
  const validationHash = artifactHash('rorca.production-completion-validation.v1', material);
  return {
    validationId: stableId('validation', validationHash),
    validationHash,
    ...material,
    outcome: passed ? 'passed' : 'failed',
    validatedAt: input.execution.settledAt,
  };
}

function reviewReceipt(
  execution: CompletionExecutionReceipt,
  validation: CompletionValidationReceipt,
  issueCodes: readonly string[],
): CompletionSelfReviewReceipt {
  const issues = [...new Set(issueCodes)].sort();
  const outcome: CompletionSelfReviewReceipt['outcome'] = validation.outcome === 'passed' && issues.length === 0
    ? 'ready'
    : 'needs_fix';
  const material = {
    operationKey: execution.operationKey,
    validationHash: validation.validationHash,
    resultSha: execution.resultSha,
    complete: true,
    outcome,
    issueCodes: issues,
  };
  const reviewHash = artifactHash('rorca.production-completion-review.v1', material);
  return {
    reviewId: stableId('review', reviewHash),
    reviewHash,
    ...material,
    reviewedAt: validation.validatedAt,
  };
}

function proposalFor(input: {
  scope: CanonicalObligationSetV1['scope'];
  plan: AttemptTaskPlanV1;
  execution: CompletionExecutionReceipt;
  validation: CompletionValidationReceipt;
  review: CompletionSelfReviewReceipt;
  ledgerHighWaterHash: string;
  priorProposal: ResultProposalV1 | null;
}): ResultProposalV1 {
  const disposition = input.validation.outcome === 'passed' && input.review.outcome === 'ready' ? 'ready' : 'blocked';
  const revision = (input.priorProposal?.proposalRevision ?? 0) + 1;
  const material = {
    scope: input.scope,
    planId: input.plan.planId,
    planRevision: input.plan.planRevision,
    planHash: input.plan.planHash,
    ledgerHighWaterHash: input.ledgerHighWaterHash,
    baseSha: input.execution.baseSha,
    resultSha: input.execution.resultSha,
    treeHash: input.execution.treeHash,
    diffHash: input.execution.diffHash,
    changedPathManifestHash: input.execution.changedPathManifestHash,
    taskResultManifestHash: artifactHash('rorca.production-completion-task-results.v1', input.execution),
    criterionResultManifestHash: artifactHash('rorca.production-completion-criterion-results.v1', {
      validationHash: input.validation.validationHash,
      reviewHash: input.review.reviewHash,
    }),
    disposition,
    revision,
  };
  const proposalHash = artifactHash('rorca.production-completion-proposal.v1', material);
  return {
    schemaVersion: 'rorca.completion-result-proposal.v1',
    contractId: 'rorca.completion-result-proposal.v1',
    contractVersion: '1.0.0',
    artifactId: stableId('artifact', proposalHash),
    contentHash: proposalHash,
    createdAt: input.review.reviewedAt,
    createdBy: input.scope.runtimeId,
    scope: input.scope,
    proposalId: stableId('proposal', proposalHash),
    proposalRevision: revision,
    proposalHash,
    planId: input.plan.planId,
    planRevision: input.plan.planRevision,
    planHash: input.plan.planHash,
    ledgerHighWaterHash: input.ledgerHighWaterHash,
    baseSha: input.execution.baseSha,
    resultSha: input.execution.resultSha,
    treeHash: input.execution.treeHash,
    diffHash: input.execution.diffHash,
    changedPathManifestHash: input.execution.changedPathManifestHash,
    taskResultManifestHash: material.taskResultManifestHash,
    criterionResultManifestHash: material.criterionResultManifestHash,
    disposition,
    summaryRef: {
      referenceId: stableId('summary', proposalHash),
      kind: 'log',
      hash: input.execution.sourceVectorHash,
      sensitivity: 'internal',
      retentionClass: 'run-artifact',
      accessTier: 'auth',
      rawPayloadIncluded: false,
    },
  };
}

function gateDecision(input: {
  stage: CompletionGateDecisionV1['stage'];
  scope: CanonicalObligationSetV1['scope'];
  obligations: CanonicalObligationSetV1;
  plan: AttemptTaskPlanV1;
  proposal: ResultProposalV1;
  validation: CompletionValidationReceipt;
  review: CompletionSelfReviewReceipt;
  createdAt: string;
}): CompletionGateDecisionV1 {
  const validated = input.proposal.disposition === 'ready'
    && input.validation.outcome === 'passed'
    && input.review.outcome === 'ready';
  const failedObligationIds = validated ? [] : [...new Set(input.validation.failedObligationIds)].sort();
  const reasonCodes = validated ? ['HOST_OBSERVATIONS_VALIDATED'] : [
    ...new Set([...input.validation.issueCodes, ...input.review.issueCodes, 'COMPLETION_NOT_READY']),
  ].sort();
  const material = {
    stage: input.stage,
    scope: input.scope,
    proposalHash: input.proposal.proposalHash,
    planHash: input.plan.planHash,
    obligationSetHash: input.obligations.obligationSetHash,
    outcome: validated ? 'validated' : 'rejected_gate',
    reasonCodes,
    failedObligationIds,
    nextAction: validated && input.stage === 'host_semantic' ? 'submit_closeout' : 'none',
    hostEvidenceHash: artifactHash('rorca.production-completion-host-evidence.v1', {
      validationHash: input.validation.validationHash,
      reviewHash: input.review.reviewHash,
    }),
  };
  const decisionHash = artifactHash(`rorca.production-completion-${input.stage}-gate.v1`, material);
  return {
    schemaVersion: 'rorca.completion-gate-decision.v1',
    contractId: 'rorca.completion-gate-decision.v1',
    contractVersion: '1.0.0',
    artifactId: stableId('artifact', decisionHash),
    contentHash: decisionHash,
    createdAt: input.createdAt,
    createdBy: 'host:execution-engine',
    scope: input.scope,
    decisionId: stableId(`decision:${input.stage}`, decisionHash),
    decisionRevision: 1,
    decisionHash,
    proposalId: input.proposal.proposalId,
    proposalRevision: input.proposal.proposalRevision,
    proposalHash: input.proposal.proposalHash,
    planId: input.plan.planId,
    planRevision: input.plan.planRevision,
    planHash: input.plan.planHash,
    obligationSetId: input.obligations.obligationSetId,
    obligationSetRevision: input.obligations.obligationSetRevision,
    obligationSetHash: input.obligations.obligationSetHash,
    stage: input.stage,
    outcome: validated ? 'validated' : 'rejected_gate',
    reasonCodes,
    failedObligationIds,
    nextAction: validated && input.stage === 'host_semantic' ? 'submit_closeout' : 'none',
    hostEvidenceHash: material.hostEvidenceHash,
    establishesStoryCompletion: false,
  };
}

function portsFor(
  input: ProductionCompletionStoryInput,
  context: ReadyProductionCompletionContext,
): CompletionRunnerPortsWithoutDurable {
  const { scope, workPackage, obligations } = context;
  let currentPlan: AttemptTaskPlanV1 | null = null;
  const createExecution = (args: {
    plan: AttemptTaskPlanV1;
    batch: AttemptTaskPlanV1['batches'][number];
    taskIds: readonly string[];
    operationKey: string;
    executionNonce: string;
  }): CompletionExecutionReceipt => executionReceipt(
    input,
    scope,
    args.plan,
    args.batch,
    args.taskIds,
    args.operationKey,
    args.executionNonce,
  );
  return {
    clock: { now: () => input.result.settledAt },
    control: { observe: async () => observeProductionCompletionControl(scope) },
    obligations: { load: async () => obligations },
    planner: {
      createOrRevise: async ({ previousPlan }) => {
        currentPlan = planFor({
          scope,
          workPackage,
          obligations,
          previousPlan,
          commandHashes: input.requiredCommandHashes,
          createdAt: input.result.settledAt,
        });
        return currentPlan;
      },
    },
    executor: {
      reconcile: async ({ operation }) => {
        if (!currentPlan) throw new Error('Cannot reconcile before the exact plan is loaded');
        const batch = currentPlan.batches.find((item) => item.batchId === operation.batchId);
        if (!batch) return { state: 'conflict', reasonCode: 'operation_batch_missing' };
        return { state: 'settled', receipt: createExecution({
          plan: currentPlan,
          batch,
          taskIds: operation.taskIds,
          operationKey: operation.operationKey,
          executionNonce: operation.executionNonce,
        }) };
      },
      execute: async (args) => createExecution(args),
    },
    validation: {
      validate: async ({ execution, requiredCommandHashes }) => validationReceipt({
        execution,
        requiredCommandHashes,
        observations: input.validations,
        obligations,
      }),
    },
    review: {
      review: async ({ execution, validation }) => reviewReceipt(execution, validation, input.selfAuditIssueCodes),
    },
    proposal: {
      create: async ({ plan, execution, validation, review, ledgerHighWaterHash, priorProposal }) => proposalFor({
        scope,
        plan,
        execution,
        validation,
        review,
        ledgerHighWaterHash,
        priorProposal,
      }),
    },
    gate: {
      controllerPreflight: async ({ plan, proposal, validation, review }) => gateDecision({
        stage: 'controller_preflight', scope, obligations, plan, proposal, validation, review, createdAt: input.result.settledAt,
      }),
      hostSemantic: async ({ plan, proposal, validation, review }) => gateDecision({
        stage: 'host_semantic', scope, obligations, plan, proposal, validation, review, createdAt: input.result.settledAt,
      }),
    },
    continuation: {
      authorize: async () => {
        throw new Error('Execution engine cannot mint continuation authority');
      },
    },
    closeout: {
      submit: async () => input.submitCloseout(),
    },
  };
}

export async function runProductionCompletionStory(
  input: ProductionCompletionStoryInput,
): Promise<ProductionCompletionStoryResult> {
  const context = await loadProductionCompletionContext(input.identity);
  if (context.kind === 'not_governed') return context;
  if (context.kind === 'governed_incomplete') return { kind: 'blocked', reasonCode: context.reasonCode, runner: null };
  const runner = await runCompletionRunner({
    scope: context.scope,
    workPackage: context.workPackage,
    persistence: { stateRoot: input.stateRoot, checkoutRoot: input.checkoutRoot },
  }, portsFor(input, context));
  return { kind: 'runner', runner };
}
