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
  FinalCompletionReportV1Schema,
  ProgressLedgerEntryV1Schema,
  ResultProposalV1Schema,
  completionContinuationKey,
  completionOperationKey,
  validateAttemptTaskPlan,
  validateContinuationDirective,
  validateFinalCompletionReport,
  validateResultProposal,
  type CompletionContinuationKeyInput,
} from '../governed-contracts/completion-protocol';
import {
  GOVERNED_EXECUTION_JSON_SCHEMA_CLASSIFICATION,
  parseGovernedExecutionContract,
  type GovernedExecutionContractName,
} from '../../../../packages/rorca-public-contract/src/governed-execution';
import { WorkPackageV1Schema } from '../governed-contracts/work-package';

const hash = (digit = 'a') => `sha256:${digit.repeat(64)}`;
const gitSha = (digit = 'a') => digit.repeat(40);
const createdAt = '2026-08-04T12:00:00.000Z';
const expiresAt = '2026-08-04T12:10:00.000Z';
const H = hash();
const G = gitSha();

const spec = {
  specId: 'spec:one', specVersion: 1, specHash: H, canonicalSpecPath: 'specs/one.yaml',
  storyId: 'story:one', storyVersion: 1, storyHash: H, criteriaManifestHash: H,
};
const repository = {
  repositoryId: 'repository:one', remoteAuthorityHash: H, gitObjectFormat: 'sha1' as const,
  baseSha: G, currentSha: G, expectedHeadSha: G, worktreeId: 'worktree:one',
  allowedPathManifestHash: H, requiredPathManifestHash: H, changedPathManifestHash: H,
  forbiddenPathManifestHash: H,
};
const scope = {
  workspaceId: 'workspace:one', missionId: 'mission:one', missionRevision: 1, missionHash: H,
  workPackageId: 'work-package:one', workPackageRevision: 1, workPackageHash: H,
  spec, runId: 7, attemptId: 'attempt:one', leaseId: 'lease:one', fencingToken: 11,
  leaseExpiresAt: expiresAt, cancellationId: 'cancellation:none', runtimeId: 'runtime:one',
  controllerGeneration: 1, runtimeGeneration: 1, sessionId: 'session:one', sessionFileHash: H,
  turnId: 'turn:one', turnAttempt: 1, originatingGeneration: 1, cursor: 2, cursorHash: H,
  priorEntryId: 'entry:prior', repository, validationStateHash: H,
  rootCauseClassification: 'root-cause:none', rootCauseHash: H,
  policyDefinitionId: 'policy:one', policyDefinitionVersion: '1.0.0', policyDefinitionHash: H,
  policyActivationId: 'activation:one', policyActivationRevision: 1, policyActivationHash: H,
};
const restrictedRef = {
  referenceId: 'reference:summary', kind: 'artifact' as const, hash: H, sensitivity: 'internal' as const,
  retentionClass: 'retention:standard', accessTier: 'auth' as const, rawPayloadIncluded: false as const,
};

function artifactHeader(schemaVersion: string, artifactId: string, createdBy = 'controller:one') {
  return { schemaVersion, contractId: schemaVersion, contractVersion: '1.0.0', artifactId, contentHash: H, createdAt, createdBy };
}

function rawObligationSet() {
  return {
    ...artifactHeader('rorca.completion-obligation-set.v1', 'artifact:obligations'),
    scope, obligationSetId: 'obligation-set:one', obligationSetRevision: 1, obligationSetHash: H,
    workPackageHash: H, manifestHash: H, validationHash: H, evidenceHash: H, pathHash: H,
    postureHash: H, resourceHash: H,
    obligations: [
      { obligationId: 'obligation:requirement', ordinal: 0, kind: 'requirement' as const, required: true, sourceHash: H, hostVerifierRef: 'verifier:requirements' },
      { obligationId: 'obligation:validation', ordinal: 1, kind: 'validation' as const, required: true, sourceHash: H, hostVerifierRef: 'verifier:tests' },
    ],
    state: 'active' as const,
  };
}

function rawPlan() {
  return {
    ...artifactHeader('rorca.attempt-task-plan.v1', 'artifact:plan'),
    scope, planId: 'plan:one', planRevision: 1, planHash: H, priorPlanHash: 'not_applicable' as const,
    obligationSetId: 'obligation-set:one', obligationSetRevision: 1, obligationSetHash: H,
    batches: [{
      batchId: 'batch:one', ordinal: 0,
      tasks: [{
        taskId: 'task:one', ordinal: 0, objectiveHash: H,
        coveredObligationIds: ['obligation:requirement', 'obligation:validation'],
        allowedPaths: ['src/one.ts'], commandHashes: [H], state: 'pending' as const,
      }],
    }],
    totalBatches: 1, totalTasks: 1, totalMutablePaths: 1, totalValidationCommands: 1, serializedBytes: 4096,
  };
}

function rawProposal() {
  return {
    ...artifactHeader('rorca.completion-result-proposal.v1', 'artifact:proposal', 'runtime:one'),
    scope, proposalId: 'proposal:one', proposalRevision: 1, proposalHash: H,
    planId: 'plan:one', planRevision: 1, planHash: H, ledgerHighWaterHash: H,
    baseSha: G, resultSha: G, treeHash: G, diffHash: H, changedPathManifestHash: H,
    taskResultManifestHash: H, criterionResultManifestHash: H, disposition: 'ready' as const,
    summaryRef: restrictedRef,
  };
}

function rawGate(nextAction: 'continue_fix' | 'submit_closeout' = 'submit_closeout') {
  const accepted = nextAction === 'submit_closeout';
  return {
    ...artifactHeader('rorca.completion-gate-decision.v1', `artifact:gate:${accepted ? 'accepted' : 'fix'}`, 'host:controller'),
    scope, decisionId: `decision:${accepted ? 'accepted' : 'fix'}`, decisionRevision: 1, decisionHash: H,
    proposalId: 'proposal:one', proposalRevision: 1, proposalHash: H,
    planId: 'plan:one', planRevision: 1, planHash: H,
    obligationSetId: 'obligation-set:one', obligationSetRevision: 1, obligationSetHash: H,
    stage: 'host_semantic' as const, outcome: accepted ? 'validated' as const : 'rejected_gate' as const,
    reasonCodes: accepted ? [] : ['validation:failed'], failedObligationIds: accepted ? [] : ['obligation:validation'],
    nextAction, hostEvidenceHash: H, establishesStoryCompletion: false as const,
  };
}

const trigger = {
  type: 'validation_root_cause_change' as const,
  priorValidationHash: H, currentValidationHash: hash('b'), priorRootCauseClass: 'root-cause:unknown',
  currentRootCauseClass: 'root-cause:code', priorRootCauseHash: H, currentRootCauseHash: hash('b'),
  changedReferencesHash: H,
};

function continuationMaterial(decision = CompletionGateDecisionV1Schema.parse(rawGate('continue_fix'))): CompletionContinuationKeyInput {
  return {
    decision, scope, targetPlanId: 'plan:one', targetPlanRevision: 1, targetPlanHash: H,
    targetBatchId: 'batch:one', failedObligationIds: ['obligation:validation'], checkpointHash: H,
    receiptHash: H, bundleHash: H, policyActivationHash: H, trigger, targetCursor: 3,
    expectedCursorAdvance: 1, retryBudgetId: 'retry-budget:one', retryFence: 1, retrySpent: 0, retryMaximum: 2,
  };
}

function rawDirective() {
  const material = continuationMaterial();
  const continuationKey = completionContinuationKey(material);
  if (!continuationKey) throw new Error('fixture decision must authorize continuation');
  return {
    ...artifactHeader('rorca.completion-continuation-directive.v1', 'artifact:directive'),
    scope, directiveId: 'directive:one', directiveRevision: 1, directiveHash: H, continuationKey,
    priorDecisionId: material.decision.decisionId, priorDecisionRevision: material.decision.decisionRevision,
    priorDecisionHash: material.decision.decisionHash, targetPlanId: material.targetPlanId,
    targetPlanRevision: material.targetPlanRevision, targetPlanHash: material.targetPlanHash,
    targetBatchId: material.targetBatchId, failedObligationIds: [...material.failedObligationIds],
    checkpointId: 'checkpoint:one', checkpointHash: material.checkpointHash,
    receiptId: 'receipt:one', receiptHash: material.receiptHash,
    bundleId: 'bundle:one', bundleHash: material.bundleHash, policyActivationHash: material.policyActivationHash,
    trigger: material.trigger, targetCursor: material.targetCursor, expectedCursorAdvance: material.expectedCursorAdvance,
    retryBudgetId: material.retryBudgetId, retryFence: material.retryFence, retrySpent: material.retrySpent,
    retryMaximum: material.retryMaximum, authorizationExpiresAt: expiresAt, state: 'authorized' as const,
  };
}

function rawLedgerEntry() {
  return {
    ...artifactHeader('rorca.completion-progress-entry.v1', 'artifact:ledger-entry'),
    scope, sequence: 0, priorEntryHash: 'not_applicable' as const, entryHash: H, writerFence: 11,
    planId: 'plan:one', planRevision: 1, planHash: H, repositorySha: G,
    entryType: 'plan_persisted' as const, payloadHash: H,
    databaseReceiptRefs: [{ receiptId: 'db-receipt:one', receiptHash: H }], recordedAt: createdAt,
  };
}

function rawFinalReport() {
  const closeoutDecisionId = `CLO-sha256:${'c'.repeat(64)}`;
  return {
    ...artifactHeader('rorca.completion-final-report.v1', 'artifact:final-report', 'host:controller'),
    scope, reportId: closeoutDecisionId, storyCloseoutDecisionId: closeoutDecisionId,
    storyCloseoutDecisionStatus: 'accepted' as const, gateDecisionId: 'decision:accepted', gateDecisionHash: H,
    proposalId: 'proposal:one', proposalHash: H, obligationSetId: 'obligation-set:one', obligationSetHash: H,
    finalSha: G, treeHash: G, diffHash: H, writerFence: 11, fileManifestHash: H, changeManifestHash: H,
    validationReceipts: [{ receiptId: 'validation-receipt:one', receiptHash: H }],
    evidenceReceipts: [{ receiptId: 'evidence-receipt:one', receiptHash: H }],
    taskDispositions: [{ taskId: 'task:one', state: 'settled' as const, resultHash: H }],
    proposalDisposition: 'ready' as const, exclusionDispositions: [],
    retryDisposition: { retryBudgetId: 'retry-budget:one', spent: 0, maximum: 2, state: 'not_used' as const },
    recoveryDisposition: { recoveryHash: H, state: 'not_required' as const },
    contextDisposition: { checkpointHash: H, receiptHash: H, bundleHash: H, state: 'current' as const },
    missingObligationIds: [], conflictingObligationIds: [], risks: [], blockers: [],
    merged: false as const, deployed: false as const, productionApproved: false as const, mergeReady: true,
  };
}

const workPackage = WorkPackageV1Schema.parse({
  ...artifactHeader('rorca.work-package.v1', 'artifact:work-package'),
  workspaceId: 'workspace:one', missionId: 'mission:one', missionRevision: 1, missionHash: H,
  workPackageId: 'work-package:one', workPackageRevision: 1, workPackageHash: H, spec,
  objectiveHash: H, dependencies: [], repository, allowedPaths: ['src/one.ts'], requiredPaths: ['src/one.ts'],
  validationObligationsHash: H, evidenceObligationsHash: H, executionPostureHash: H,
  lifecycleProjectionRef: 'lifecycle:one',
  authorityCeilings: { delivery: 'execute_bounded', operational: 'none', knowledge: 'none', interactive: 'none' },
  resourceLimitsHash: H, retryLimit: 2, planRevision: 1, state: 'active', proposalId: 'work-proposal:one',
});

test('all seven canonical Completion Protocol v1 artifacts parse strictly', () => {
  expect(CanonicalObligationSetV1Schema.parse(rawObligationSet()).schemaVersion).toBe('rorca.completion-obligation-set.v1');
  expect(AttemptTaskPlanV1Schema.parse(rawPlan()).schemaVersion).toBe('rorca.attempt-task-plan.v1');
  expect(ResultProposalV1Schema.parse(rawProposal()).schemaVersion).toBe('rorca.completion-result-proposal.v1');
  expect(CompletionGateDecisionV1Schema.parse(rawGate()).establishesStoryCompletion).toBe(false);
  expect(ContinuationDirectiveV1Schema.parse(rawDirective()).state).toBe('authorized');
  expect(ProgressLedgerEntryV1Schema.parse(rawLedgerEntry()).sequence).toBe(0);
  expect(FinalCompletionReportV1Schema.parse(rawFinalReport()).reportId).toBe(rawFinalReport().storyCloseoutDecisionId);
});

test('published semantic validator rejects every completion refinement counterexample', () => {
  const duplicateObligations = rawObligationSet();
  duplicateObligations.obligations[1].obligationId = duplicateObligations.obligations[0].obligationId;
  const misorderedObligations = rawObligationSet();
  misorderedObligations.obligations[1].ordinal = 0;

  const duplicatePaths = rawPlan();
  duplicatePaths.batches[0].tasks[0].allowedPaths = ['src/one.ts', 'src/one.ts'];
  const duplicateCommands = rawPlan();
  duplicateCommands.batches[0].tasks[0].commandHashes = [H, H];
  const duplicateCoveredObligations = rawPlan();
  duplicateCoveredObligations.batches[0].tasks[0].coveredObligationIds = [
    'obligation:requirement', 'obligation:requirement',
  ];
  const duplicateBatchIds = rawPlan();
  duplicateBatchIds.batches.push({
    ...structuredClone(duplicateBatchIds.batches[0]),
    ordinal: 1,
    tasks: [{ ...structuredClone(duplicateBatchIds.batches[0].tasks[0]), taskId: 'task:two' }],
  });
  duplicateBatchIds.totalBatches = 2;
  duplicateBatchIds.totalTasks = 2;
  const duplicateTaskIds = rawPlan();
  duplicateTaskIds.batches.push({
    ...structuredClone(duplicateTaskIds.batches[0]),
    batchId: 'batch:two',
    ordinal: 1,
  });
  duplicateTaskIds.totalBatches = 2;
  duplicateTaskIds.totalTasks = 2;

  const duplicateReceipts = rawLedgerEntry();
  duplicateReceipts.databaseReceiptRefs.push({ ...duplicateReceipts.databaseReceiptRefs[0] });
  const duplicateTaskDispositions = rawFinalReport();
  duplicateTaskDispositions.taskDispositions.push({ ...duplicateTaskDispositions.taskDispositions[0] });

  const cases: Array<readonly [GovernedExecutionContractName, unknown, string]> = [
    ['completion-obligation-set', { ...rawObligationSet(), contentHash: hash('b') }, 'obligation content hash'],
    ['completion-obligation-set', { ...rawObligationSet(), createdBy: 'runtime:one' }, 'obligation runtime authorship'],
    ['completion-obligation-set', { ...rawObligationSet(), workPackageHash: hash('b') }, 'obligation scope'],
    ['completion-obligation-set', duplicateObligations, 'duplicate obligation IDs'],
    ['completion-obligation-set', misorderedObligations, 'obligation canonical order'],
    ['attempt-task-plan', { ...rawPlan(), contentHash: hash('b') }, 'plan content hash'],
    ['attempt-task-plan', { ...rawPlan(), planRevision: 2 }, 'plan revision correlation'],
    ['attempt-task-plan', { ...rawPlan(), totalTasks: 2 }, 'plan totals'],
    ['attempt-task-plan', duplicatePaths, 'duplicate paths'],
    ['attempt-task-plan', duplicateCommands, 'duplicate commands'],
    ['attempt-task-plan', duplicateCoveredObligations, 'duplicate covered obligation IDs'],
    ['attempt-task-plan', duplicateBatchIds, 'duplicate batch IDs'],
    ['attempt-task-plan', duplicateTaskIds, 'duplicate task IDs'],
    ['completion-result-proposal', { ...rawProposal(), contentHash: hash('b') }, 'proposal content hash'],
    ['completion-result-proposal', { ...rawProposal(), createdBy: 'controller:one' }, 'proposal runtime binding'],
    ['completion-result-proposal', { ...rawProposal(), baseSha: gitSha('b') }, 'proposal base SHA scope'],
    ['completion-result-proposal', { ...rawProposal(), resultSha: gitSha('b') }, 'proposal result SHA scope'],
    ['completion-result-proposal', { ...rawProposal(), changedPathManifestHash: hash('b') }, 'proposal path manifest scope'],
    ['completion-gate-decision', { ...rawGate(), contentHash: hash('b') }, 'gate content hash'],
    ['completion-gate-decision', { ...rawGate(), createdBy: 'runtime:one' }, 'runtime gate authorship'],
    ['completion-gate-decision', { ...rawGate(), failedObligationIds: ['obligation:validation'] }, 'validated gate failures'],
    ['completion-gate-decision', { ...rawGate(), stage: 'controller_preflight' }, 'closeout stage correlation'],
    ['completion-gate-decision', { ...rawGate(), nextAction: 'none' }, 'validated next-action correlation'],
    ['completion-continuation-directive', { ...rawDirective(), contentHash: hash('b') }, 'directive content hash'],
    ['completion-continuation-directive', { ...rawDirective(), createdBy: 'runtime:one' }, 'runtime continuation authorship'],
    ['completion-continuation-directive', { ...rawDirective(), retrySpent: 3, retryMaximum: 2 }, 'retry overspend'],
    ['completion-continuation-directive', { ...rawDirective(), retrySpent: 2, retryMaximum: 2 }, 'exhausted authorization'],
    ['completion-continuation-directive', { ...rawDirective(), authorizationExpiresAt: createdAt }, 'authorization expiry'],
    ['completion-progress-entry', { ...rawLedgerEntry(), contentHash: hash('b') }, 'ledger content hash'],
    ['completion-progress-entry', { ...rawLedgerEntry(), sequence: 1 }, 'ledger chain origin'],
    ['completion-progress-entry', { ...rawLedgerEntry(), writerFence: 12 }, 'ledger scope fence'],
    ['completion-progress-entry', { ...rawLedgerEntry(), repositorySha: gitSha('b') }, 'ledger repository scope'],
    ['completion-progress-entry', duplicateReceipts, 'duplicate receipt IDs'],
    ['completion-final-report', { ...rawFinalReport(), reportId: 'closeout:other' }, 'final report decision binding'],
    ['completion-final-report', { ...rawFinalReport(), finalSha: gitSha('b') }, 'final report repository scope'],
    ['completion-final-report', { ...rawFinalReport(), writerFence: 12 }, 'final report scope fence'],
    ['completion-final-report', {
      ...rawFinalReport(),
      retryDisposition: { ...rawFinalReport().retryDisposition, spent: 3, maximum: 2 },
    }, 'final report retry disposition'],
    ['completion-final-report', {
      ...rawFinalReport(),
      missingObligationIds: ['obligation:missing'],
    }, 'final report merge-ready binding'],
    ['completion-final-report', duplicateTaskDispositions, 'duplicate final task IDs'],
  ];

  expect(GOVERNED_EXECUTION_JSON_SCHEMA_CLASSIFICATION).toBe('structural-only');
  for (const [contract, counterexample, label] of cases) {
    let rejected = false;
    try {
      parseGovernedExecutionContract(contract, counterexample);
    } catch {
      rejected = true;
    }
    expect({ label, rejected }).toEqual({ label, rejected: true });
  }
});

test('plan schemas enforce batch, task, path, command, total, and serialized-byte bounds', () => {
  const tooManyBatches = { ...rawPlan(), batches: Array.from({ length: 33 }, (_, ordinal) => ({ ...rawPlan().batches[0], batchId: `batch:${ordinal}`, ordinal })) };
  expect(AttemptTaskPlanV1Schema.safeParse(tooManyBatches).success).toBe(false);
  const tooManyTasks = { ...rawPlan(), batches: [{ ...rawPlan().batches[0], tasks: Array.from({ length: 7 }, (_, ordinal) => ({ ...rawPlan().batches[0].tasks[0], taskId: `task:${ordinal}`, ordinal })) }] };
  expect(AttemptTaskPlanV1Schema.safeParse(tooManyTasks).success).toBe(false);
  expect(AttemptTaskPlanV1Schema.safeParse({ ...rawPlan(), serializedBytes: 256 * 1024 + 1 }).success).toBe(false);
  expect(ContinuationDirectiveV1Schema.safeParse({ ...rawDirective(), retryMaximum: 4 }).success).toBe(false);
});

test('strict schemas reject unknown fields and every forbidden authority escalation', () => {
  expect(CanonicalObligationSetV1Schema.safeParse({ ...rawObligationSet(), contextEpoch: 9 }).success).toBe(false);
  expect(CanonicalObligationSetV1Schema.safeParse({ ...rawObligationSet(), createdBy: 'runtime:one' }).success).toBe(false);
  expect(ResultProposalV1Schema.safeParse({ ...rawProposal(), createdBy: 'controller:one' }).success).toBe(false);
  expect(CompletionGateDecisionV1Schema.safeParse({ ...rawGate(), mergeAuthority: 'approved' }).success).toBe(false);
  expect(FinalCompletionReportV1Schema.safeParse({ ...rawFinalReport(), merged: true }).success).toBe(false);
  expect(FinalCompletionReportV1Schema.safeParse({ ...rawFinalReport(), deployed: true }).success).toBe(false);
  expect(FinalCompletionReportV1Schema.safeParse({ ...rawFinalReport(), productionApproved: true }).success).toBe(false);
  expect(FinalCompletionReportV1Schema.safeParse({ ...rawFinalReport(), providerHumanApproved: true }).success).toBe(false);
});

test('plan validator rejects broadened paths and omitted required obligation coverage', () => {
  const obligationSet = CanonicalObligationSetV1Schema.parse(rawObligationSet());
  const broadened = AttemptTaskPlanV1Schema.parse({
    ...rawPlan(),
    batches: [{ ...rawPlan().batches[0], tasks: [{ ...rawPlan().batches[0].tasks[0], allowedPaths: ['src/other.ts'] }] }],
  });
  expect(validateAttemptTaskPlan(broadened, { workPackage, obligationSet })).toMatchObject({
    valid: false, violations: expect.arrayContaining([expect.objectContaining({ code: 'path_broadening' })]),
  });
  const omitted = AttemptTaskPlanV1Schema.parse({
    ...rawPlan(),
    batches: [{ ...rawPlan().batches[0], tasks: [{ ...rawPlan().batches[0].tasks[0], coveredObligationIds: ['obligation:requirement'] }] }],
  });
  expect(validateAttemptTaskPlan(omitted, { workPackage, obligationSet })).toMatchObject({
    valid: false, violations: expect.arrayContaining([expect.objectContaining({ code: 'required_obligation_omitted' })]),
  });
});

test('plan revisions cannot rewrite settled tasks or broaden commands', () => {
  const obligationSet = CanonicalObligationSetV1Schema.parse(rawObligationSet());
  const priorPlan = AttemptTaskPlanV1Schema.parse({
    ...rawPlan(),
    batches: [{ ...rawPlan().batches[0], tasks: [{ ...rawPlan().batches[0].tasks[0], state: 'settled' }] }],
  });
  const nextHash = hash('b');
  const rewritten = AttemptTaskPlanV1Schema.parse({
    ...rawPlan(), contentHash: nextHash, planRevision: 2, planHash: nextHash, priorPlanHash: priorPlan.planHash,
    batches: [{ ...rawPlan().batches[0], tasks: [{ ...rawPlan().batches[0].tasks[0], state: 'settled', objectiveHash: hash('c'), commandHashes: [H, hash('d')] }] }],
    totalValidationCommands: 2,
  });
  const result = validateAttemptTaskPlan(rewritten, { workPackage, obligationSet, priorPlan });
  expect(result).toMatchObject({
    valid: false,
    violations: expect.arrayContaining([
      expect.objectContaining({ code: 'settled_task_rewrite' }),
    ]),
  });
});

test('proposal validator fails closed on plan, scope, ledger, and hash mismatches', () => {
  const plan = AttemptTaskPlanV1Schema.parse(rawPlan());
  const proposal = ResultProposalV1Schema.parse({ ...rawProposal(), planHash: hash('b'), ledgerHighWaterHash: hash('c') });
  const mismatchedScope = { ...scope, cursor: scope.cursor + 1 };
  const result = validateResultProposal(proposal, { scope: mismatchedScope, plan, ledgerHighWater: H });
  expect(result).toMatchObject({
    valid: false,
    violations: expect.arrayContaining([
      expect.objectContaining({ code: 'scope_mismatch' }),
      expect.objectContaining({ code: 'plan_mismatch' }),
      expect.objectContaining({ code: 'ledger_high_water_mismatch' }),
    ]),
  });
});

test('completion gate is a literal non-completion decision', () => {
  expect(CompletionGateDecisionV1Schema.safeParse({ ...rawGate(), establishesStoryCompletion: true }).success).toBe(false);
  expect(CompletionGateDecisionV1Schema.safeParse({ ...rawGate(), stage: 'controller_preflight' }).success).toBe(false);
});

test('operation and continuation keys are deterministic, scope-bound, and suppress terminal continuation', () => {
  const operation = {
    scope, planId: 'plan:one', planRevision: 1, planHash: H, batchId: 'batch:one', taskId: 'task:one',
    objectiveHash: H, payloadHash: H,
  };
  expect(completionOperationKey(operation)).toBe(completionOperationKey(structuredClone(operation)));
  expect(completionOperationKey(operation)).not.toBe(completionOperationKey({
    ...operation, scope: { ...scope, repository: { ...scope.repository, currentSha: gitSha('b') } },
  }));
  const material = continuationMaterial();
  expect(completionContinuationKey(material)).toBe(completionContinuationKey(structuredClone(material)));
  const terminalDecision = CompletionGateDecisionV1Schema.parse(rawGate('submit_closeout'));
  expect(completionContinuationKey({ ...material, decision: terminalDecision })).toBeNull();
  const directive = ContinuationDirectiveV1Schema.parse(rawDirective());
  expect(validateContinuationDirective(directive, {
    decision: material.decision, candidateState: 'submitted_to_closeout', retryMaximum: 2,
  })).toMatchObject({ valid: false, violations: expect.arrayContaining([expect.objectContaining({ code: 'continuation_suppressed' })]) });
});

test('final reports require exact accepted closeout and mergeReady has no missing or conflicting obligations', () => {
  const proposal = ResultProposalV1Schema.parse(rawProposal());
  const gateDecision = CompletionGateDecisionV1Schema.parse(rawGate('submit_closeout'));
  const report = FinalCompletionReportV1Schema.parse(rawFinalReport());
  const closeoutDecision = { decisionId: report.storyCloseoutDecisionId, status: 'accepted' as const };
  expect(validateFinalCompletionReport(report, { closeoutDecision, gateDecision, proposal })).toEqual({ valid: true, violations: [] });
  expect(FinalCompletionReportV1Schema.safeParse({
    ...rawFinalReport(), missingObligationIds: ['obligation:missing'], mergeReady: true,
  }).success).toBe(false);
  expect(FinalCompletionReportV1Schema.safeParse({
    ...rawFinalReport(), conflictingObligationIds: ['obligation:conflict'], mergeReady: true,
  }).success).toBe(false);
  const notReady = FinalCompletionReportV1Schema.parse({
    ...rawFinalReport(), missingObligationIds: ['obligation:missing'], mergeReady: false,
  });
  expect(validateFinalCompletionReport(notReady, { closeoutDecision, gateDecision, proposal })).toMatchObject({
    valid: false, violations: expect.arrayContaining([expect.objectContaining({ code: 'obligations_unsettled' })]),
  });
  expect(validateFinalCompletionReport(report, {
    closeoutDecision: { ...closeoutDecision, status: 'blocked' }, gateDecision, proposal,
  })).toMatchObject({ valid: false, violations: expect.arrayContaining([expect.objectContaining({ code: 'closeout_not_accepted' })]) });
});
