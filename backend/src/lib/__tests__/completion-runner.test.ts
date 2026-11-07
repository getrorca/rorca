/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as completionRunnerPersistence from '../completion-runner-persistence';
import {
  completionContinuationKey,
  governedHash,
  type AttemptTaskPlanV1,
  type CanonicalObligationSetV1,
  type CompletionGateDecisionV1,
  type ContinuationDirectiveV1,
  type ContinuationScope,
  type ResultProposalV1,
  type WorkPackageV1,
} from '../governed-contracts';
import { evaluateStoryCloseout, LEGACY_CLOSEOUT_RULE_NAME, type StoryCloseoutDecision } from '../story-closeout';
import {
  completionContinuationConsumptionHash,
  type CompletionContinuationConsumptionInput,
} from '../completion-protocol-service';
import {
  COMPLETION_RUNNER_LIMITS,
  classifyCompletionGateOutcome,
  completionFailureFingerprint,
  completionFixBudget,
  completionRetryBackoffMs,
  deriveCompletionOperationIdentity,
  isFinalCompletionReportEligible,
  runCompletionRunnerTurn,
  runCompletionRunner,
  type CompletionExecutionReceipt,
  type CompletionRunnerControlObservation,
  type CompletionRunnerControlWindow,
  type CompletionRunnerDurableEvent,
  type CompletionRunnerDurableState,
  type CompletionRunnerPorts,
  type CompletionSelfReviewReceipt,
  type CompletionRunnerPortsWithoutDurable,
  type CompletionTaskOperation,
  type CompletionValidationReceipt,
} from '../completion-runner';

const NOW = '2026-08-04T12:00:00.000Z';
const hash = (seed: number): string => `sha256:${(seed % 16).toString(16).repeat(64)}`;
const git = (seed: number): string => (seed % 16).toString(16).repeat(40);

const SPEC = {
  specId: 'spec:one', specVersion: 1, specHash: hash(1), canonicalSpecPath: 'forge/specs/one.json',
  storyId: 'story:one', storyVersion: 1, storyHash: hash(2), criteriaManifestHash: hash(3),
};
const REPOSITORY = {
  repositoryId: 'repo:one', remoteAuthorityHash: hash(4), gitObjectFormat: 'sha1' as const,
  baseSha: git(1), currentSha: git(2), expectedHeadSha: git(2), worktreeId: 'worktree:one',
  allowedPathManifestHash: hash(5), requiredPathManifestHash: hash(6), changedPathManifestHash: hash(7),
  forbiddenPathManifestHash: hash(8),
};
const SCOPE: ContinuationScope = {
  workspaceId: 'workspace:one', missionId: 'mission:one', missionRevision: 1, missionHash: hash(9),
  workPackageId: 'package:one', workPackageRevision: 1, workPackageHash: hash(10), spec: SPEC,
  runId: 41, attemptId: 'attempt:one', leaseId: 'lease:one', fencingToken: 7,
  leaseExpiresAt: '2026-08-05T12:00:00.000Z', cancellationId: 'cancel:one', runtimeId: 'runtime:one',
  controllerGeneration: 1, runtimeGeneration: 1, sessionId: 'session:one', sessionFileHash: hash(11),
  turnId: 'turn:one', turnAttempt: 1, originatingGeneration: 1, cursor: 2, cursorHash: hash(12),
  priorEntryId: 'entry:prior', repository: REPOSITORY, validationStateHash: hash(13),
  rootCauseClassification: 'root:none', rootCauseHash: hash(14), policyDefinitionId: 'policy:one',
  policyDefinitionVersion: '1.0.0', policyDefinitionHash: hash(15), policyActivationId: 'activation:one',
  policyActivationRevision: 1, policyActivationHash: hash(1),
};
const SCOPE_HASH = governedHash('rorca.continuation-scope.v1', SCOPE as never);

function workPackage(allowedPaths = Array.from({ length: 24 }, (_, index) => `src/file-${index}.ts`), retryLimit = 2): WorkPackageV1 {
  return {
    schemaVersion: 'rorca.work-package.v1', contractId: 'rorca.work-package.v1', contractVersion: '1.0.0',
    artifactId: 'artifact:package', contentHash: SCOPE.workPackageHash, createdAt: NOW, createdBy: 'human:one',
    workspaceId: SCOPE.workspaceId, missionId: SCOPE.missionId, missionRevision: SCOPE.missionRevision,
    missionHash: SCOPE.missionHash, workPackageId: SCOPE.workPackageId, workPackageRevision: SCOPE.workPackageRevision,
    workPackageHash: SCOPE.workPackageHash, spec: SPEC, objectiveHash: hash(2), dependencies: [], repository: REPOSITORY,
    allowedPaths, requiredPaths: [], validationObligationsHash: hash(3), evidenceObligationsHash: hash(4),
    executionPostureHash: hash(5), lifecycleProjectionRef: 'lifecycle:one', authorityCeilings: {
      delivery: 'none', operational: 'none', knowledge: 'observe', interactive: 'none',
    },
    resourceLimitsHash: hash(6), retryLimit, planRevision: 1, state: 'active', proposalId: 'proposal:work-package',
  };
}

const OBLIGATIONS: CanonicalObligationSetV1 = {
  schemaVersion: 'rorca.completion-obligation-set.v1', contractId: 'rorca.completion-obligation-set.v1', contractVersion: '1.0.0',
  artifactId: 'artifact:obligations', contentHash: hash(2), createdAt: NOW, createdBy: 'controller:one', scope: SCOPE,
  obligationSetId: 'obligations:one', obligationSetRevision: 1, obligationSetHash: hash(2),
  workPackageHash: SCOPE.workPackageHash, manifestHash: hash(3), validationHash: hash(4), evidenceHash: hash(5),
  pathHash: hash(6), postureHash: hash(7), resourceHash: hash(8), obligations: [{
    obligationId: 'obligation:one', ordinal: 0, kind: 'requirement', required: true,
    sourceHash: hash(9), hostVerifierRef: 'verifier:one',
  }], state: 'active',
};

interface PlanOptions {
  taskCount?: number;
  pathCount?: number;
  commandCount?: number;
  twoBatches?: boolean;
}

function plan(options: PlanOptions = {}): AttemptTaskPlanV1 {
  const taskCount = options.taskCount ?? (options.twoBatches ? 2 : 1);
  const paths = Array.from({ length: options.pathCount ?? Math.min(taskCount, 1) }, (_, index) => `src/file-${index}.ts`);
  const commands = Array.from({ length: options.commandCount ?? 1 }, (_, index) => hash(index + 1));
  const tasks = Array.from({ length: taskCount }, (_, index) => ({
    taskId: `task:${index + 1}`,
    ordinal: options.twoBatches ? 0 : index,
    objectiveHash: hash(index + 2),
    coveredObligationIds: ['obligation:one'],
    allowedPaths: index === 0 ? paths : [],
    commandHashes: index === 0 ? commands : [],
    state: 'pending' as const,
  }));
  const batches = options.twoBatches
    ? tasks.map((task, index) => ({ batchId: `batch:${index + 1}`, ordinal: index, tasks: [task] }))
    : [{ batchId: 'batch:one', ordinal: 0, tasks }];
  const planHash = hash(11);
  return {
    schemaVersion: 'rorca.attempt-task-plan.v1', contractId: 'rorca.attempt-task-plan.v1', contractVersion: '1.0.0',
    artifactId: 'artifact:plan', contentHash: planHash, createdAt: NOW, createdBy: SCOPE.runtimeId, scope: SCOPE,
    planId: 'plan:one', planRevision: 1, planHash, priorPlanHash: 'not_applicable',
    obligationSetId: OBLIGATIONS.obligationSetId, obligationSetRevision: OBLIGATIONS.obligationSetRevision,
    obligationSetHash: OBLIGATIONS.obligationSetHash, batches, totalBatches: batches.length, totalTasks: tasks.length,
    totalMutablePaths: new Set(tasks.flatMap((task) => task.allowedPaths)).size,
    totalValidationCommands: new Set(tasks.flatMap((task) => task.commandHashes)).size,
    serializedBytes: 2_048,
  };
}

function executionFor(currentPlan: AttemptTaskPlanV1, batchId: string, taskIds: readonly string[], mutation: 'none' | 'material' = 'material'): CompletionExecutionReceipt {
  const identity = deriveCompletionOperationIdentity({ scope: SCOPE, plan: currentPlan, batchId, taskIds });
  const batch = currentPlan.batches.find((candidate) => candidate.batchId === batchId)!;
  const allowed = new Set(batch.tasks.filter((task) => taskIds.includes(task.taskId)).flatMap((task) => task.allowedPaths));
  return {
    ...identity,
    scopeHash: SCOPE_HASH,
    fencingToken: SCOPE.fencingToken,
    planId: currentPlan.planId,
    planRevision: currentPlan.planRevision,
    planHash: currentPlan.planHash,
    batchId,
    taskIds: [...taskIds],
    baseSha: SCOPE.repository.baseSha,
    resultSha: SCOPE.repository.currentSha,
    treeHash: git(3),
    diffHash: hash(4),
    changedPathManifestHash: SCOPE.repository.changedPathManifestHash,
    changedPaths: mutation === 'material' ? [...allowed].slice(0, 1) : [],
    sourceVectorHash: hash(5),
    mutation,
    settledAt: NOW,
  };
}


function validationFor(execution: CompletionExecutionReceipt, commandHashes: readonly string[], outcome: CompletionValidationReceipt['outcome'] = 'passed'): CompletionValidationReceipt {
  return {
    validationId: 'validation:one', validationHash: hash(6), operationKey: execution.operationKey,
    resultSha: execution.resultSha, treeHash: execution.treeHash, commandHashes: [...commandHashes], complete: true,
    outcome, failedObligationIds: outcome === 'passed' ? [] : ['obligation:one'],
    issueCodes: outcome === 'passed' ? [] : ['TEST_FAILED'], validatedAt: NOW,
  };
}

function reviewFor(execution: CompletionExecutionReceipt, validation: CompletionValidationReceipt, outcome: CompletionSelfReviewReceipt['outcome'] = 'ready'): CompletionSelfReviewReceipt {
  return {
    reviewId: 'review:one', reviewHash: hash(7), operationKey: execution.operationKey,
    validationHash: validation.validationHash, resultSha: execution.resultSha, complete: true, outcome,
    issueCodes: outcome === 'ready' ? [] : ['FIX_REQUIRED'], reviewedAt: NOW,
  };
}

function proposalFor(input: {
  currentPlan: AttemptTaskPlanV1;
  execution: CompletionExecutionReceipt;
  ledgerHighWaterHash: string;
  revision?: number;
  disposition?: ResultProposalV1['disposition'];
}): ResultProposalV1 {
  const revision = input.revision ?? 1;
  const proposalHash = hash(8 + revision);
  return {
    schemaVersion: 'rorca.completion-result-proposal.v1', contractId: 'rorca.completion-result-proposal.v1', contractVersion: '1.0.0',
    artifactId: `artifact:proposal:${revision}`, contentHash: proposalHash, createdAt: NOW, createdBy: SCOPE.runtimeId, scope: SCOPE,
    proposalId: `proposal:${revision}`, proposalRevision: revision, proposalHash,
    planId: input.currentPlan.planId, planRevision: input.currentPlan.planRevision, planHash: input.currentPlan.planHash,
    ledgerHighWaterHash: input.ledgerHighWaterHash, baseSha: input.execution.baseSha, resultSha: input.execution.resultSha,
    treeHash: input.execution.treeHash, diffHash: input.execution.diffHash,
    changedPathManifestHash: input.execution.changedPathManifestHash, taskResultManifestHash: hash(12),
    criterionResultManifestHash: hash(13), disposition: input.disposition ?? 'ready', summaryRef: {
      referenceId: `summary:${revision}`, kind: 'artifact', hash: hash(14), sensitivity: 'internal',
      retentionClass: 'retention:standard', accessTier: 'auth', rawPayloadIncluded: false,
    },
  };
}

function gateFor(input: {
  stage: CompletionGateDecisionV1['stage'];
  proposal: ResultProposalV1;
  outcome?: CompletionGateDecisionV1['outcome'];
  nextAction?: CompletionGateDecisionV1['nextAction'];
  decisionId?: string;
}): CompletionGateDecisionV1 {
  const outcome = input.outcome ?? 'validated';
  const decisionId = input.decisionId ?? `decision:${input.stage}`;
  const decisionHash = input.stage === 'controller_preflight' ? hash(3) : hash(4);
  return {
    schemaVersion: 'rorca.completion-gate-decision.v1', contractId: 'rorca.completion-gate-decision.v1', contractVersion: '1.0.0',
    artifactId: `artifact:${decisionId}`, contentHash: decisionHash, createdAt: NOW,
    createdBy: input.stage === 'controller_preflight' ? 'controller:one' : 'host:one', scope: SCOPE,
    decisionId, decisionRevision: 1, decisionHash, proposalId: input.proposal.proposalId,
    proposalRevision: input.proposal.proposalRevision, proposalHash: input.proposal.proposalHash,
    planId: input.proposal.planId, planRevision: input.proposal.planRevision, planHash: input.proposal.planHash,
    obligationSetId: OBLIGATIONS.obligationSetId, obligationSetRevision: OBLIGATIONS.obligationSetRevision,
    obligationSetHash: OBLIGATIONS.obligationSetHash, stage: input.stage, outcome,
    reasonCodes: outcome === 'validated' ? ['VALIDATED'] : ['VALIDATION_FAILED'],
    failedObligationIds: outcome === 'validated' ? [] : ['obligation:one'],
    nextAction: input.nextAction ?? (input.stage === 'host_semantic' && outcome === 'validated' ? 'submit_closeout' : 'none'),
    hostEvidenceHash: hash(5), establishesStoryCompletion: false,
  };
}

function acceptedCloseout(): StoryCloseoutDecision {
  return evaluateStoryCloseout({
    manifest: null,
    attempt: null,
    host: null,
    legacyCompatibility: {
      ruleName: LEGACY_CLOSEOUT_RULE_NAME,
      manifestVersion: 0,
      runCreatedAt: '2026-01-01T00:00:00.000Z',
      cutoff: '2026-02-01T00:00:00.000Z',
      auditReference: 'audit:legacy-closeout',
      workspaceId: SCOPE.workspaceId,
      specId: SCOPE.spec.specId,
      runId: 41,
      storyId: SCOPE.spec.storyId,
      activeSubjectRevision: { commitSha: SCOPE.repository.currentSha, worktreePath: 'checkout', branch: 'story-one' },
      hostEvidenceReferences: ['evidence:legacy-one'],
    },
  });
}

function blockedCloseout(): StoryCloseoutDecision {
  return evaluateStoryCloseout({ manifest: null, attempt: null, host: null });
}

function emptyState(overrides: Partial<CompletionRunnerDurableState> = {}): CompletionRunnerDurableState {
  return {
    scope: SCOPE,
    ledgerHighWaterHash: hash(1),
    reconciliation: 'clean',
    plan: null,
    settledTaskIds: [],
    operations: [],
    validations: [],
    reviews: [],
    proposals: [],
    gateDecisions: [],
    directives: [],
    continuationLifecycles: [],
    closeoutDecisions: [],
    retry: { spent: 0, retryFence: SCOPE.fencingToken, failures: [] },
    terminal: null,
    ...overrides,
  };
}

function operationFor(currentPlan: AttemptTaskPlanV1, batchId: string, taskIds: readonly string[], state: CompletionTaskOperation['state']): CompletionTaskOperation {
  const receipt = executionFor(currentPlan, batchId, taskIds);
  return {
    operationKey: receipt.operationKey,
    executionNonce: receipt.executionNonce,
    scopeHash: receipt.scopeHash,
    fencingToken: receipt.fencingToken,
    planId: receipt.planId,
    planRevision: receipt.planRevision,
    planHash: receipt.planHash,
    batchId,
    taskIds: [...taskIds],
    repositorySha: SCOPE.repository.currentSha,
    state,
    receipt: state === 'settled' ? receipt : null,
  };
}

interface HarnessOptions {
  currentPlan?: AttemptTaskPlanV1;
  currentWorkPackage?: WorkPackageV1;
  state?: CompletionRunnerDurableState;
  control?: (window: CompletionRunnerControlWindow) => CompletionRunnerControlObservation;
  validationOutcome?: CompletionValidationReceipt['outcome'];
  reviewOutcome?: CompletionSelfReviewReceipt['outcome'];
  incompleteReview?: boolean;
  controller?: (proposal: ResultProposalV1) => CompletionGateDecisionV1;
  host?: (proposal: ResultProposalV1) => CompletionGateDecisionV1;
  closeout?: StoryCloseoutDecision;
  reconcile?: CompletionRunnerPorts['executor']['reconcile'];
  duplicateReservation?: boolean;
}
interface Harness {
  ports: CompletionRunnerPorts;
  calls: string[];
  events: CompletionRunnerDurableEvent[];
  currentPlan: AttemptTaskPlanV1;
  currentWorkPackage: WorkPackageV1;
}

function harness(options: HarnessOptions = {}): Harness {
  const currentPlan = options.currentPlan ?? plan();
  const currentWorkPackage = options.currentWorkPackage ?? workPackage();
  const state = options.state ?? emptyState();
  const calls: string[] = [];
  const events: CompletionRunnerDurableEvent[] = [];
  let recordCount = 1;
  const defaultControl = (): CompletionRunnerControlObservation => ({ observedAt: NOW, cancellation: 'none', cancellationId: null });

  const ports: CompletionRunnerPorts = {
    clock: { now: () => NOW },
    control: {
      observe: async ({ window }) => {
        calls.push(`control:${window}`);
        return (options.control ?? defaultControl)(window);
      },
    },
    durable: {
      reloadAndReconcile: async () => {
        calls.push('reload');
        return state;
      },
      record: async ({ event }) => {
        calls.push(`record:${event.eventType}`);
        events.push(event);
        recordCount += 1;
        return {
          outcome: options.duplicateReservation && event.eventType === 'operation_reserved' ? 'exact_duplicate' : 'appended',
          ledgerHighWaterHash: hash(recordCount),
        };
      },
    },
    obligations: {
      load: async () => {
        calls.push('obligations');
        return OBLIGATIONS;
      },
    },
    planner: {
      createOrRevise: async () => {
        calls.push('plan');
        return currentPlan;
      },
    },
    executor: {
      reconcile: options.reconcile ?? (async () => ({ state: 'uncertain' })),
      execute: async ({ batch, taskIds, operationKey, executionNonce }) => {
        calls.push(`execute:${batch.batchId}`);
        const receipt = executionFor(currentPlan, batch.batchId, taskIds);
        expect(receipt.operationKey).toBe(operationKey);
        expect(receipt.executionNonce).toBe(executionNonce);
        return receipt;
      },
    },
    validation: {
      validate: async ({ execution, requiredCommandHashes }) => {
        calls.push('validate');
        return validationFor(execution, requiredCommandHashes, options.validationOutcome);
      },
    },
    review: {
      review: async ({ execution, validation }) => {
        calls.push('review');
        const receipt = reviewFor(execution, validation, options.reviewOutcome);
        return options.incompleteReview ? { ...receipt, complete: false } : receipt;
      },
    },
    proposal: {
      create: async ({ execution, ledgerHighWaterHash, priorProposal, validation, review }) => {
        calls.push('proposal');
        return proposalFor({
          currentPlan,
          execution,
          ledgerHighWaterHash,
          revision: (priorProposal?.proposalRevision ?? 0) + 1,
          disposition: validation.outcome === 'passed' && review.outcome === 'ready' ? 'ready' : 'failed',
        });
      },
    },
    gate: {
      controllerPreflight: async ({ proposal }) => {
        calls.push('gate:controller_preflight');
        return options.controller?.(proposal) ?? gateFor({ stage: 'controller_preflight', proposal });
      },
      hostSemantic: async ({ proposal }) => {
        calls.push('gate:host_semantic');
        return options.host?.(proposal) ?? gateFor({ stage: 'host_semantic', proposal });
      },
    },
    continuation: {
      authorize: async (input) => {
        calls.push('continuation');
        const seed = {
          schemaVersion: 'rorca.completion-continuation-directive.v1' as const,
          contractId: 'rorca.completion-continuation-directive.v1' as const,
          contractVersion: '1.0.0', artifactId: 'artifact:directive', contentHash: hash(6), createdAt: NOW,
          createdBy: 'controller:one', scope: SCOPE, directiveId: 'directive:one', directiveRevision: 1,
          directiveHash: hash(6), continuationKey: hash(7), priorDecisionId: input.decision.decisionId,
          priorDecisionRevision: input.decision.decisionRevision, priorDecisionHash: input.decision.decisionHash,
          targetPlanId: input.plan.planId, targetPlanRevision: input.plan.planRevision, targetPlanHash: input.plan.planHash,
          targetBatchId: input.targetBatchId, failedObligationIds: input.decision.failedObligationIds,
          checkpointId: 'checkpoint:one', checkpointHash: hash(8), receiptId: 'receipt:one', receiptHash: hash(9),
          bundleId: 'bundle:one', bundleHash: hash(10), policyActivationHash: SCOPE.policyActivationHash,
          trigger: {
            type: 'meaningful_retry' as const, previewHash: hash(1), receiptHash: hash(2), priorAttempt: 1,
            newAttempt: 2, priorGeneration: 1, newGeneration: 2, failedScopeHash: hash(3), changedSourceVectorHash: hash(4),
          },
          targetCursor: SCOPE.cursor, expectedCursorAdvance: 1, retryBudgetId: input.retryBudgetId,
          retryFence: input.retryFence, retrySpent: input.retrySpent, retryMaximum: input.retryMaximum,
          authorizationExpiresAt: '2026-08-05T00:00:00.000Z', state: 'authorized' as const,
        };
        const key = completionContinuationKey({
          decision: input.decision,
          scope: SCOPE,
          targetPlanId: seed.targetPlanId,
          targetPlanRevision: seed.targetPlanRevision,
          targetPlanHash: seed.targetPlanHash,
          targetBatchId: seed.targetBatchId,
          failedObligationIds: seed.failedObligationIds,
          checkpointHash: seed.checkpointHash,
          receiptHash: seed.receiptHash,
          bundleHash: seed.bundleHash,
          policyActivationHash: seed.policyActivationHash,
          trigger: seed.trigger,
          targetCursor: seed.targetCursor,
          expectedCursorAdvance: seed.expectedCursorAdvance,
          retryBudgetId: seed.retryBudgetId,
          retryFence: seed.retryFence,
          retrySpent: seed.retrySpent,
          retryMaximum: seed.retryMaximum,
        });
        expect(key).not.toBeNull();
        return { ...seed, continuationKey: key! };
      },
    },
    closeout: {
      submit: async () => {
        calls.push('closeout');
        return options.closeout ?? acceptedCloseout();
      },
    },
  };
  return { ports, calls, events, currentPlan, currentWorkPackage };
}

async function runHarness(value: Harness, continuationConsumptionClaim?: CompletionContinuationConsumptionInput) {
  return runCompletionRunnerTurn({
    scope: SCOPE,
    workPackage: value.currentWorkPackage,
    continuationConsumptionClaim,
  }, value.ports);
}

function persistedPipeline(currentPlan: AttemptTaskPlanV1, decision?: (proposal: ResultProposalV1) => CompletionGateDecisionV1) {
  const operation = operationFor(currentPlan, currentPlan.batches[0]!.batchId, currentPlan.batches[0]!.tasks.map((task) => task.taskId), 'settled');
  const validation = validationFor(operation.receipt!, currentPlan.batches[0]!.tasks.flatMap((task) => task.commandHashes), 'failed');
  const review = reviewFor(operation.receipt!, validation, 'needs_fix');
  const proposal = proposalFor({ currentPlan, execution: operation.receipt!, ledgerHighWaterHash: hash(1), disposition: 'failed' });
  const gate = decision?.(proposal) ?? gateFor({
    stage: 'controller_preflight', proposal, outcome: 'rejected_gate', nextAction: 'continue_fix',
  });
  return { operation, validation, review, proposal, gate };
}

describe('completion runner durable state machine', () => {
  test('orders reload, one bounded batch, validation, self-review, proposal, both gates, and accepted closeout', async () => {
    const value = harness();
    const result = await runHarness(value);

    expect(result.status).toBe('closeout_accepted');
    expect(result.finalReportEligible).toBe(true);
    expect(value.calls).toEqual([
      'reload', 'control:turn_start', 'obligations', 'plan', 'control:before_execution',
      'record:operation_reserved', 'execute:batch:one', 'record:operation_settled', 'control:after_execution',
      'validate', 'record:validation_recorded', 'control:before_review', 'review', 'record:review_recorded',
      'control:before_proposal', 'proposal', 'record:proposal_recorded', 'control:before_controller_preflight',
      'gate:controller_preflight', 'record:gate_recorded', 'control:before_host_semantic', 'gate:host_semantic',
      'record:gate_recorded', 'control:before_closeout', 'closeout', 'record:closeout_recorded',
    ]);
  });

  test('executes at most one focused batch per durable turn and preserves the remaining batch', async () => {
    const currentPlan = plan({ twoBatches: true, pathCount: 2 });
    const value = harness({ currentPlan });
    const result = await runHarness(value);

    expect(result).toMatchObject({ status: 'advanced', reasonCode: 'focused_batch_settled', executedBatchId: 'batch:1', finalReportEligible: false });
    expect(value.calls.filter((call) => call.startsWith('execute:'))).toEqual(['execute:batch:1']);
    expect(value.calls).not.toContain('proposal');
  });

  test('accepts exactly 6 tasks, 20 paths, and 8 validation commands, then fail-closes each exceeded bound', async () => {
    const maximum = plan({ taskCount: 6, pathCount: 20, commandCount: 8 });
    const accepted = harness({ currentPlan: maximum, currentWorkPackage: workPackage(Array.from({ length: 20 }, (_, index) => `src/file-${index}.ts`)) });
    expect((await runHarness(accepted)).status).toBe('closeout_accepted');
    expect(accepted.calls.filter((call) => call.startsWith('execute:'))).toHaveLength(1);
    expect(COMPLETION_RUNNER_LIMITS).toMatchObject({ tasksPerBatch: 6, mutablePathsPerBatch: 20, validationCommandsPerBatch: 8 });

    const invalidPlans = [
      plan({ taskCount: 7 }),
      plan({ pathCount: 21 }),
      plan({ commandCount: 9 }),
    ];
    for (const invalidPlan of invalidPlans) {
      const value = harness({ currentPlan: invalidPlan as AttemptTaskPlanV1 });
      const result = await runHarness(value);
      expect(result.status).toBe('quarantined');
      expect(value.calls.some((call) => call.startsWith('execute:'))).toBe(false);
    }
  });

  test('preserves durable settled tasks across plan revision and quarantines rewrites before execution', async () => {
    const previous = plan();
    const revisedHash = hash(12);
    const rewritten: AttemptTaskPlanV1 = {
      ...previous,
      artifactId: 'artifact:plan:two',
      contentHash: revisedHash,
      planRevision: 2,
      planHash: revisedHash,
      priorPlanHash: previous.planHash,
      batches: previous.batches.map((batch) => ({
        ...batch,
        tasks: batch.tasks.map((task) => ({ ...task, objectiveHash: hash(15) })),
      })),
    };
    const value = harness({
      currentPlan: rewritten,
      state: emptyState({ plan: previous, settledTaskIds: ['task:1'] }),
    });
    const result = await runHarness(value);
    expect(result).toMatchObject({ status: 'quarantined', reasonCode: 'SETTLED_TASK_REWRITTEN' });
    expect(value.calls.some((call) => call.startsWith('execute:'))).toBe(false);
  });

  test('quarantines an operation whose durable writer fence differs from the exact scope', async () => {
    const currentPlan = plan();
    const mismatched = { ...operationFor(currentPlan, 'batch:one', ['task:1'], 'uncertain'), fencingToken: SCOPE.fencingToken + 1 };
    const value = harness({
      currentPlan,
      state: emptyState({ plan: currentPlan, operations: [mismatched] }),
    });
    const result = await runHarness(value);
    expect(result).toMatchObject({ status: 'quarantined', reasonCode: 'OPERATION_FENCE_MISMATCH' });
    expect(value.calls.some((call) => call.startsWith('execute:'))).toBe(false);
  });

  test('never skips validation after material mutation, including cancellation immediately after execution', async () => {
    const value = harness({
      control: (window) => window === 'after_execution'
        ? { observedAt: NOW, cancellation: 'requested', cancellationId: SCOPE.cancellationId }
        : { observedAt: NOW, cancellation: 'none', cancellationId: null },
    });
    const result = await runHarness(value);

    expect(result.status).toBe('cancelled');
    expect(value.calls.indexOf('validate')).toBeGreaterThan(value.calls.indexOf('execute:batch:one'));
    expect(value.calls).not.toContain('review');
    expect(value.calls).not.toContain('proposal');
  });

  test('never emits a proposal before a complete self-review', async () => {
    const value = harness({ incompleteReview: true });
    const result = await runHarness(value);

    expect(result).toMatchObject({ status: 'quarantined', reasonCode: 'INCOMPLETE_SELF_REVIEW', finalReportEligible: false });
    expect(value.calls).toContain('validate');
    expect(value.calls).toContain('review');
    expect(value.calls).not.toContain('proposal');
  });

  test.each<CompletionRunnerControlWindow>(['turn_start', 'before_execution', 'before_proposal'])(
    'honors cancellation at the %s durable window without later authority calls',
    async (cancelWindow) => {
      const value = harness({
        control: (window) => window === cancelWindow
          ? { observedAt: NOW, cancellation: 'acknowledged', cancellationId: SCOPE.cancellationId }
          : { observedAt: NOW, cancellation: 'none', cancellationId: null },
      });
      const result = await runHarness(value);
      expect(result.status).toBe('cancelled');
      if (cancelWindow === 'turn_start') expect(value.calls).not.toContain('obligations');
      if (cancelWindow === 'before_execution') expect(value.calls.some((call) => call.startsWith('execute:'))).toBe(false);
      if (cancelWindow === 'before_proposal') expect(value.calls).not.toContain('proposal');
    },
  );

  test('expires before mutation when the lease boundary is reached', async () => {
    const value = harness({
      control: () => ({ observedAt: SCOPE.leaseExpiresAt, cancellation: 'none', cancellationId: null }),
    });
    const result = await runHarness(value);
    expect(result).toMatchObject({ status: 'expired', reasonCode: 'lease_expired' });
    expect(value.calls).not.toContain('obligations');
  });

  test('treats an exact duplicate reservation as recovery work and never spawns blindly', async () => {
    const value = harness({ duplicateReservation: true });
    const result = await runHarness(value);
    expect(result).toMatchObject({ status: 'awaiting_reconciliation', reasonCode: 'duplicate_operation_reservation' });
    expect(value.calls.some((call) => call.startsWith('execute:'))).toBe(false);
  });

  test('reuses an exact settled operation and validation path without executing it twice', async () => {
    const currentPlan = plan();
    const operation = operationFor(currentPlan, 'batch:one', ['task:1'], 'settled');
    const value = harness({ currentPlan, state: emptyState({ plan: currentPlan, operations: [operation] }) });
    const result = await runHarness(value);
    expect(result.status).toBe('closeout_accepted');
    expect(value.calls.some((call) => call.startsWith('execute:'))).toBe(false);
    expect(value.calls).toContain('validate');
  });

  test('reconciles an uncertain nonce and only executes after an exact not-started observation', async () => {
    const currentPlan = plan();
    const reserved = operationFor(currentPlan, 'batch:one', ['task:1'], 'uncertain');
    const uncertain = harness({
      currentPlan,
      state: emptyState({ plan: currentPlan, operations: [reserved] }),
      reconcile: async ({ operation }) => {
        expect(operation.executionNonce).toBe(reserved.executionNonce);
        return { state: 'uncertain' };
      },
    });
    expect(await runHarness(uncertain)).toMatchObject({ status: 'awaiting_reconciliation', reasonCode: 'execution_effect_uncertain' });
    expect(uncertain.calls.some((call) => call.startsWith('execute:'))).toBe(false);

    const notStarted = harness({
      currentPlan,
      state: emptyState({ plan: currentPlan, operations: [reserved] }),
      reconcile: async ({ operation }) => {
        expect(operation.executionNonce).toBe(reserved.executionNonce);
        return { state: 'not_started' };
      },
    });
    expect((await runHarness(notStarted)).status).toBe('closeout_accepted');
    expect(notStarted.calls.filter((call) => call.startsWith('execute:'))).toHaveLength(1);
  });

  test('enforces zero retry and the work-package budget capped at three', async () => {
    expect(completionFixBudget(0)).toBe(0);
    expect(completionFixBudget(5)).toBe(3);
    const currentPlan = plan({ twoBatches: true, pathCount: 2 });
    const failureOptions = {
      currentPlan,
      validationOutcome: 'failed' as const,
      reviewOutcome: 'needs_fix' as const,
      controller: (proposal: ResultProposalV1) => gateFor({
        stage: 'controller_preflight', proposal, outcome: 'rejected_gate', nextAction: 'continue_fix',
      }),
    };
    const zero = harness({ ...failureOptions, currentWorkPackage: workPackage(undefined, 0) });
    expect(await runHarness(zero)).toMatchObject({ status: 'blocked', reasonCode: 'retry_budget_exhausted' });
    expect(zero.calls).not.toContain('continuation');

    const third = harness({
      ...failureOptions,
      currentWorkPackage: workPackage(undefined, 5),
      state: emptyState({ retry: { spent: 2, retryFence: SCOPE.fencingToken, failures: [] } }),
    });
    expect(await runHarness(third)).toMatchObject({ status: 'awaiting_continuation', reasonCode: 'bounded_fix_authorized' });
    expect(third.calls).toContain('continuation');
    const directiveEvent = third.events.find((event): event is Extract<CompletionRunnerDurableEvent, { eventType: 'continuation_recorded' }> => event.eventType === 'continuation_recorded');
    expect(directiveEvent?.directive).toMatchObject({ retrySpent: 2, retryMaximum: 3 });

    const exhausted = harness({
      ...failureOptions,
      currentWorkPackage: workPackage(undefined, 5),
      state: emptyState({ retry: { spent: 3, retryFence: SCOPE.fencingToken, failures: [] } }),
    });
    expect(await runHarness(exhausted)).toMatchObject({ status: 'blocked', reasonCode: 'retry_budget_exhausted' });
    expect(exhausted.calls).not.toContain('continuation');
  });

  test('uses deterministic bounded backoff and jitter', () => {
    const input = { scope: SCOPE, priorDecisionHash: hash(2), retrySpentBeforeAuthorization: 1 };
    const first = completionRetryBackoffMs(input);
    expect(completionRetryBackoffMs(input)).toBe(first);
    expect(first).toBeGreaterThanOrEqual(2_000);
    expect(first).toBeLessThan(2_000 + COMPLETION_RUNNER_LIMITS.retryJitterRangeMs);
  });

  test('quarantines a second unchanged failure fingerprint and source vector', async () => {
    const currentPlan = plan({ twoBatches: true, pathCount: 2 });
    const persisted = persistedPipeline(currentPlan);
    const fingerprint = completionFailureFingerprint({ decision: persisted.gate, validation: persisted.validation, review: persisted.review });
    const value = harness({
      currentPlan,
      currentWorkPackage: workPackage(undefined, 3),
      state: emptyState({
        plan: currentPlan,
        operations: [persisted.operation],
        validations: [persisted.validation],
        reviews: [persisted.review],
        proposals: [persisted.proposal],
        gateDecisions: [persisted.gate],
        retry: {
          spent: 0,
          retryFence: SCOPE.fencingToken,
          failures: [{ decisionId: 'decision:prior', fingerprint, sourceVectorHash: persisted.operation.receipt!.sourceVectorHash, observedAt: NOW }],
        },
      }),
    });
    const result = await runHarness(value);
    expect(result).toMatchObject({ status: 'quarantined', reasonCode: 'repeated_unchanged_failure' });
    expect(value.calls).not.toContain('continuation');
  });

  test('keeps a rejected gate immutable, authorizes from it once, and requires a new proposal after the settled fix directive', async () => {
    const currentPlan = plan({ twoBatches: true, pathCount: 2 });
    const persisted = persistedPipeline(currentPlan);
    const frozenDecision = JSON.parse(JSON.stringify(persisted.gate));
    const first = harness({
      currentPlan,
      validationOutcome: 'failed',
      reviewOutcome: 'needs_fix',
      state: emptyState({
        plan: currentPlan,
        operations: [persisted.operation],
        validations: [persisted.validation],
        reviews: [persisted.review],
        proposals: [persisted.proposal],
        gateDecisions: [persisted.gate],
      }),
    });
    expect(await runHarness(first)).toMatchObject({ status: 'awaiting_continuation', reasonCode: 'bounded_fix_authorized' });
    expect(first.calls).not.toContain('proposal');
    expect(persisted.gate).toEqual(frozenDecision);
    const authorized = first.events.find((event): event is Extract<CompletionRunnerDurableEvent, { eventType: 'continuation_recorded' }> => event.eventType === 'continuation_recorded')!.directive;

    const settledDirective: ContinuationDirectiveV1 = { ...authorized, state: 'settled' };
    const claim: CompletionContinuationConsumptionInput = {
      workspaceId: SCOPE.workspaceId,
      attemptId: SCOPE.attemptId,
      directiveId: authorized.directiveId,
      directiveRevision: authorized.directiveRevision,
      directiveHash: authorized.directiveHash,
      continuationKey: authorized.continuationKey,
      dispatchId: 'dispatch:one',
      dispatchReceiptHash: hash(15),
      leaseId: SCOPE.leaseId,
      fencingToken: SCOPE.fencingToken,
      consumptionId: 'consumption:one',
    };
    const second = harness({
      currentPlan,
      state: emptyState({
        plan: currentPlan,
        settledTaskIds: ['task:1'],
        operations: [persisted.operation],
        validations: [persisted.validation],
        reviews: [persisted.review],
        proposals: [persisted.proposal],
        gateDecisions: [persisted.gate],
        directives: [settledDirective],
        continuationLifecycles: [{
          directive: authorized,
          state: 'settled',
          dispatchId: claim.dispatchId,
          dispatchReceiptHash: claim.dispatchReceiptHash,
          consumptionId: claim.consumptionId,
          consumptionHash: completionContinuationConsumptionHash(claim),
          consumedAt: NOW,
        }],
        retry: { spent: 1, retryFence: SCOPE.fencingToken, failures: [] },
      }),
    });
    const result = await runHarness(second, claim);
    expect(result.status).toBe('closeout_accepted');
    expect(second.calls).toContain('execute:batch:2');
    expect(second.calls).toContain('proposal');
    const newProposal = second.events.find((event): event is Extract<CompletionRunnerDurableEvent, { eventType: 'proposal_recorded' }> => event.eventType === 'proposal_recorded')!.proposal;
    expect(newProposal.proposalId).not.toBe(persisted.proposal.proposalId);
    expect(newProposal.proposalRevision).toBeGreaterThan(persisted.proposal.proposalRevision);
    expect(persisted.proposal.proposalRevision).toBe(1);
  });

  test('classifies controller preflight separately from host semantics and never treats validated gate as completion', () => {
    const currentPlan = plan();

    const execution = executionFor(currentPlan, 'batch:one', ['task:1']);
    const proposal = proposalFor({ currentPlan, execution, ledgerHighWaterHash: hash(1) });
    const controller = gateFor({ stage: 'controller_preflight', proposal });
    const host = gateFor({ stage: 'host_semantic', proposal });
    expect(classifyCompletionGateOutcome(controller)).toEqual({ authority: 'controller_contract', classification: 'validated_not_complete' });
    expect(classifyCompletionGateOutcome(host)).toEqual({ authority: 'host_semantic', classification: 'validated_not_complete' });
    expect(controller.establishesStoryCompletion).toBe(false);
    expect(host.establishesStoryCompletion).toBe(false);
    expect(isFinalCompletionReportEligible(null)).toBe(false);
  });

  test('direct turn refuses a settled continuation without its exact current canonical claim', async () => {
    const currentPlan = plan({ twoBatches: true, pathCount: 2 });
    const persisted = persistedPipeline(currentPlan);
    const first = harness({
      currentPlan,
      state: emptyState({
        plan: currentPlan,
        operations: [persisted.operation],
        validations: [persisted.validation],
        reviews: [persisted.review],
        proposals: [persisted.proposal],
        gateDecisions: [persisted.gate],
      }),
    });
    await runHarness(first);
    const authorized = first.events.find((event): event is Extract<CompletionRunnerDurableEvent, { eventType: 'continuation_recorded' }> => event.eventType === 'continuation_recorded')!.directive;
    const settled = { ...authorized, state: 'settled' as const };
    const unclaimed = harness({
      currentPlan,
      state: emptyState({
        plan: currentPlan,
        settledTaskIds: ['task:1'],
        operations: [persisted.operation],
        validations: [persisted.validation],
        reviews: [persisted.review],
        proposals: [persisted.proposal],
        gateDecisions: [persisted.gate],
        directives: [settled],
        continuationLifecycles: [{
          directive: authorized,
          state: 'settled',
          dispatchId: 'dispatch:one',
          dispatchReceiptHash: hash(15),
          consumptionId: null,
          consumptionHash: null,
          consumedAt: null,
        }],
      }),
    });
    await expect(runHarness(unclaimed)).resolves.toMatchObject({
      status: 'quarantined',
      reasonCode: 'SETTLED_CONTINUATION_NOT_CLAIMED',
    });
    expect(unclaimed.calls).not.toContain('planner');
    expect(unclaimed.calls).not.toContain('execute:batch:2');
  });
  test.each(['authorized', 'dispatched'] as const)('canonical %s continuation waits without reaching execution', async (state) => {
    const currentPlan = plan({ twoBatches: true, pathCount: 2 });
    const persisted = persistedPipeline(currentPlan);
    const authorization = harness({
      currentPlan,
      state: emptyState({
        plan: currentPlan,
        operations: [persisted.operation],
        validations: [persisted.validation],
        reviews: [persisted.review],
        proposals: [persisted.proposal],
        gateDecisions: [persisted.gate],
      }),
    });
    await runHarness(authorization);
    const directive = authorization.events.find((event): event is Extract<CompletionRunnerDurableEvent, { eventType: 'continuation_recorded' }> => event.eventType === 'continuation_recorded')!.directive;
    const waiting = harness({
      currentPlan,
      state: emptyState({
        plan: currentPlan,
        directives: [{ ...directive, state }],
        continuationLifecycles: [{
          directive,
          state,
          dispatchId: state === 'dispatched' ? 'dispatch:wait' : null,
          dispatchReceiptHash: null,
          consumptionId: null,
          consumptionHash: null,
          consumedAt: null,
        }],
      }),
    });
    await expect(runHarness(waiting)).resolves.toMatchObject({
      status: 'awaiting_continuation',
      reasonCode: `continuation_${state}`,
    });
    expect(waiting.calls.some((call) => call.startsWith('execute:'))).toBe(false);
  });

  test('production runner executes the targeted plan only for the canonical CAS winner', async () => {
    const currentPlan = plan({ twoBatches: true, pathCount: 2 });
    const persisted = persistedPipeline(currentPlan);
    const authorization = harness({
      currentPlan,
      state: emptyState({
        plan: currentPlan,
        operations: [persisted.operation],
        validations: [persisted.validation],
        reviews: [persisted.review],
        proposals: [persisted.proposal],
        gateDecisions: [persisted.gate],
      }),
    });
    await runHarness(authorization);
    const authorized = authorization.events.find((event): event is Extract<CompletionRunnerDurableEvent, { eventType: 'continuation_recorded' }> => event.eventType === 'continuation_recorded')!.directive;
    const settled = { ...authorized, state: 'settled' as const };
    const claim: CompletionContinuationConsumptionInput = {
      workspaceId: SCOPE.workspaceId,
      attemptId: SCOPE.attemptId,
      directiveId: authorized.directiveId,
      directiveRevision: authorized.directiveRevision,
      directiveHash: authorized.directiveHash,
      continuationKey: authorized.continuationKey,
      dispatchId: 'dispatch:production',
      dispatchReceiptHash: hash(15),
      leaseId: SCOPE.leaseId,
      fencingToken: SCOPE.fencingToken,
      consumptionId: `consumption:${governedHash('rorca.completion-continuation-consumption-id.v1', {
        workspaceId: SCOPE.workspaceId,
        attemptId: SCOPE.attemptId,
        directiveId: authorized.directiveId,
        directiveRevision: authorized.directiveRevision,
        directiveHash: authorized.directiveHash,
        continuationKey: authorized.continuationKey,
        dispatchId: 'dispatch:production',
        dispatchReceiptHash: hash(15),
        leaseId: SCOPE.leaseId,
        fencingToken: SCOPE.fencingToken,
      } as never).slice('sha256:'.length)}`,
    };
    const target = harness({ currentPlan });
    let consumed = false;
    const projectedState = (): CompletionRunnerDurableState => emptyState({
      plan: currentPlan,
      settledTaskIds: ['task:1'],
      operations: [persisted.operation],
      validations: [persisted.validation],
      reviews: [persisted.review],
      proposals: [persisted.proposal],
      gateDecisions: [persisted.gate],
      directives: [settled],
      continuationLifecycles: [{
        directive: authorized,
        state: 'settled',
        dispatchId: claim.dispatchId,
        dispatchReceiptHash: claim.dispatchReceiptHash,
        consumptionId: consumed ? claim.consumptionId : null,
        consumptionHash: consumed ? completionContinuationConsumptionHash(claim) : null,
        consumedAt: consumed ? NOW : null,
      }],
      retry: { spent: 1, retryFence: SCOPE.fencingToken, failures: [] },
    });
    const durable: CompletionRunnerPorts['durable'] = {
      reloadAndReconcile: jest.fn(async () => projectedState()),
      record: target.ports.durable.record,
    };
    const consumeContinuation = jest.fn(async (received: CompletionContinuationConsumptionInput) => {
      expect(received).toEqual(claim);
      if (consumed) {
        return { disposition: 'duplicate' as const, operationKey: hash(1), artifactHash: authorized.directiveHash, directive: authorized };
      }
      consumed = true;
      return { disposition: 'accepted' as const, operationKey: hash(1), artifactHash: authorized.directiveHash, directive: authorized };
    });
    const persistence = {
      durable,
      consumeContinuation,
      wrapPorts: (ports: CompletionRunnerPortsWithoutDurable) => ({ ...ports, durable }),
      close: jest.fn(),
    };
    const create = jest.spyOn(completionRunnerPersistence, 'createCompletionRunnerPersistence')
      .mockResolvedValue(persistence as never);
    const { durable: ignoredDurable, ...ports } = target.ports;
    expect(ignoredDurable).toBeDefined();
    try {

      const acceptedInput = {
        scope: SCOPE,
        workPackage: target.currentWorkPackage,
        persistence: { stateRoot: '/unused/state', checkoutRoot: '/unused/checkout' },
      };
      const concurrent = await Promise.allSettled([
        runCompletionRunner(acceptedInput, ports),
        runCompletionRunner(acceptedInput, ports),
      ]);
      const winner = concurrent.find((outcome) => outcome.status === 'fulfilled');
      const loser = concurrent.find((outcome) => outcome.status === 'rejected');
      expect(winner).toMatchObject({ status: 'fulfilled', value: { status: 'closeout_accepted', executedBatchId: 'batch:2' } });
      expect(loser).toMatchObject({ status: 'rejected', reason: { reasonCode: 'SETTLED_CONTINUATION_CAS_LOST' } });
      expect(consumeContinuation).toHaveBeenCalledTimes(2);
      expect(target.calls.filter((call) => call === 'execute:batch:2')).toHaveLength(1);

      const executionCount = target.calls.filter((call) => call === 'execute:batch:2').length;
      await expect(runCompletionRunner(acceptedInput, ports))
        .rejects.toMatchObject({ reasonCode: 'SETTLED_CONTINUATION_ALREADY_CONSUMED' });
      expect(target.calls.filter((call) => call === 'execute:batch:2')).toHaveLength(executionCount);
    } finally {
      create.mockRestore();
    }
  });


  test('blocked closeout remains incomplete and only an exact accepted StoryCloseoutDecision enables final report', async () => {
    const blocked = blockedCloseout();
    expect(isFinalCompletionReportEligible(blocked)).toBe(false);
    expect(isFinalCompletionReportEligible({ ...acceptedCloseout(), decisionId: 'forged' })).toBe(false);
    expect(isFinalCompletionReportEligible(acceptedCloseout())).toBe(true);

    const blockedRun = harness({ closeout: blocked });
    const result = await runHarness(blockedRun);
    expect(result).toMatchObject({ status: 'blocked', reasonCode: 'closeout_blocked', finalReportEligible: false });
    expect(result.closeoutDecisionId).toBe(blocked.decisionId);
  });
});
