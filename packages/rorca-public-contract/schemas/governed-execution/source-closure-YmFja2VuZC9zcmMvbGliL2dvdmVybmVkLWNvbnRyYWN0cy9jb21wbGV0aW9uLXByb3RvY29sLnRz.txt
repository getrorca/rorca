/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { z } from 'zod';
import {
  ArtifactHeaderSchema,
  CanonicalTimestampSchema,
  FullGitShaSchema,
  GOVERNED_CONTRACT_LIMITS,
  RestrictedReferenceSchema,
  SafeRelativePathSchema,
  Sha256Schema,
  StableIdSchema,
  governedHash,
} from './primitives';
import { ContinuationScopeSchema, TriggerMaterialSchema, type ContinuationScope } from './context-continuation';
import type { WorkPackageV1 } from './work-package';

const NotApplicableHashSchema = z.union([Sha256Schema, z.literal('not_applicable')]);
const UniqueStableIdsSchema = z.array(StableIdSchema).max(500).superRefine((values, ctx) => {
  if (new Set(values).size !== values.length) {
    ctx.addIssue({ code: 'custom', message: 'duplicate identifiers are forbidden' });
  }
});
const RuntimeAuthor = /^(?:runtime|model|process|tool)(?::|\.|-|$)/i;

const ObligationSchema = z.object({
  obligationId: StableIdSchema,
  ordinal: z.number().int().nonnegative().max(499),
  kind: z.enum(['requirement', 'validation', 'evidence', 'path', 'review']),
  required: z.boolean(),
  sourceHash: Sha256Schema,
  hostVerifierRef: StableIdSchema,
}).strict();

export const CanonicalObligationSetV1Schema = ArtifactHeaderSchema.extend({
  schemaVersion: z.literal('rorca.completion-obligation-set.v1'),
  contractId: z.literal('rorca.completion-obligation-set.v1'),
  scope: ContinuationScopeSchema,
  obligationSetId: StableIdSchema,
  obligationSetRevision: z.number().int().positive(),
  obligationSetHash: Sha256Schema,
  workPackageHash: Sha256Schema,
  manifestHash: Sha256Schema,
  validationHash: Sha256Schema,
  evidenceHash: Sha256Schema,
  pathHash: Sha256Schema,
  postureHash: Sha256Schema,
  resourceHash: Sha256Schema,
  obligations: z.array(ObligationSchema).min(1).max(500),
  state: z.enum(['active', 'superseded', 'rejected']),
}).strict().superRefine((value, ctx) => {
  if (value.contentHash !== value.obligationSetHash) {
    ctx.addIssue({ code: 'custom', path: ['contentHash'], message: 'content hash must equal obligation-set hash' });
  }
  if (RuntimeAuthor.test(value.createdBy) || value.createdBy === value.scope.runtimeId) {
    ctx.addIssue({ code: 'custom', path: ['createdBy'], message: 'runtime/model/process/tool cannot author canonical obligations' });
  }
  if (value.workPackageHash !== value.scope.workPackageHash) {
    ctx.addIssue({ code: 'custom', path: ['workPackageHash'], message: 'work-package hash must match exact scope' });
  }
  const ids = value.obligations.map((obligation) => obligation.obligationId);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: 'custom', path: ['obligations'], message: 'duplicate obligation identifiers are forbidden' });
  }
  value.obligations.forEach((obligation, index) => {
    if (obligation.ordinal !== index) {
      ctx.addIssue({ code: 'custom', path: ['obligations', index, 'ordinal'], message: 'obligations must have contiguous canonical order' });
    }
  });
});

const AttemptTaskSchema = z.object({
  taskId: StableIdSchema,
  ordinal: z.number().int().nonnegative().max(5),
  objectiveHash: Sha256Schema,
  coveredObligationIds: UniqueStableIdsSchema.min(1),
  allowedPaths: z.array(SafeRelativePathSchema).max(20).superRefine((values, ctx) => {
    if (new Set(values).size !== values.length) ctx.addIssue({ code: 'custom', message: 'duplicate task paths are forbidden' });
  }),
  commandHashes: z.array(Sha256Schema).max(8).superRefine((values, ctx) => {
    if (new Set(values).size !== values.length) ctx.addIssue({ code: 'custom', message: 'duplicate validation commands are forbidden' });
  }),
  state: z.enum(['pending', 'settled']),
}).strict();

const AttemptBatchSchema = z.object({
  batchId: StableIdSchema,
  ordinal: z.number().int().nonnegative().max(31),
  tasks: z.array(AttemptTaskSchema).min(1).max(6),
}).strict().superRefine((value, ctx) => {
  const paths = new Set(value.tasks.flatMap((task) => task.allowedPaths));
  const commands = new Set(value.tasks.flatMap((task) => task.commandHashes));
  if (paths.size > 20) ctx.addIssue({ code: 'custom', path: ['tasks'], message: 'batch exceeds 20 mutable paths' });
  if (commands.size > 8) ctx.addIssue({ code: 'custom', path: ['tasks'], message: 'batch exceeds 8 validation commands' });
  value.tasks.forEach((task, index) => {
    if (task.ordinal !== index) ctx.addIssue({ code: 'custom', path: ['tasks', index, 'ordinal'], message: 'tasks must have contiguous canonical order' });
  });
});

export const AttemptTaskPlanV1Schema = ArtifactHeaderSchema.extend({
  schemaVersion: z.literal('rorca.attempt-task-plan.v1'),
  contractId: z.literal('rorca.attempt-task-plan.v1'),
  scope: ContinuationScopeSchema,
  planId: StableIdSchema,
  planRevision: z.number().int().positive(),
  planHash: Sha256Schema,
  priorPlanHash: NotApplicableHashSchema,
  obligationSetId: StableIdSchema,
  obligationSetRevision: z.number().int().positive(),
  obligationSetHash: Sha256Schema,
  batches: z.array(AttemptBatchSchema).min(1).max(32),
  totalBatches: z.number().int().min(1).max(32),
  totalTasks: z.number().int().min(1).max(192),
  totalMutablePaths: z.number().int().nonnegative().max(500),
  totalValidationCommands: z.number().int().nonnegative().max(256),
  serializedBytes: z.number().int().positive().max(GOVERNED_CONTRACT_LIMITS.requestBytes),
}).strict().superRefine((value, ctx) => {
  if (value.contentHash !== value.planHash) {
    ctx.addIssue({ code: 'custom', path: ['contentHash'], message: 'content hash must equal plan hash' });
  }
  if ((value.planRevision === 1) !== (value.priorPlanHash === 'not_applicable')) {
    ctx.addIssue({ code: 'custom', path: ['priorPlanHash'], message: 'only the first plan revision may omit a prior plan hash' });
  }
  const tasks = value.batches.flatMap((batch) => batch.tasks);
  const paths = new Set(tasks.flatMap((task) => task.allowedPaths));
  const commands = new Set(tasks.flatMap((task) => task.commandHashes));
  if (value.totalBatches !== value.batches.length) ctx.addIssue({ code: 'custom', path: ['totalBatches'], message: 'batch total mismatch' });
  if (value.totalTasks !== tasks.length) ctx.addIssue({ code: 'custom', path: ['totalTasks'], message: 'task total mismatch' });
  if (value.totalMutablePaths !== paths.size) ctx.addIssue({ code: 'custom', path: ['totalMutablePaths'], message: 'mutable-path total mismatch' });
  if (value.totalValidationCommands !== commands.size) ctx.addIssue({ code: 'custom', path: ['totalValidationCommands'], message: 'validation-command total mismatch' });
  const batchIds = value.batches.map((batch) => batch.batchId);
  const taskIds = tasks.map((task) => task.taskId);
  if (new Set(batchIds).size !== batchIds.length) ctx.addIssue({ code: 'custom', path: ['batches'], message: 'duplicate batch identifiers are forbidden' });
  if (new Set(taskIds).size !== taskIds.length) ctx.addIssue({ code: 'custom', path: ['batches'], message: 'duplicate task identifiers are forbidden' });
  value.batches.forEach((batch, index) => {
    if (batch.ordinal !== index) ctx.addIssue({ code: 'custom', path: ['batches', index, 'ordinal'], message: 'batches must have contiguous canonical order' });
  });
});

export const ResultProposalV1Schema = ArtifactHeaderSchema.extend({
  schemaVersion: z.literal('rorca.completion-result-proposal.v1'),
  contractId: z.literal('rorca.completion-result-proposal.v1'),
  scope: ContinuationScopeSchema,
  proposalId: StableIdSchema,
  proposalRevision: z.number().int().positive(),
  proposalHash: Sha256Schema,
  planId: StableIdSchema,
  planRevision: z.number().int().positive(),
  planHash: Sha256Schema,
  ledgerHighWaterHash: Sha256Schema,
  baseSha: FullGitShaSchema,
  resultSha: FullGitShaSchema,
  treeHash: FullGitShaSchema,
  diffHash: Sha256Schema,
  changedPathManifestHash: Sha256Schema,
  taskResultManifestHash: Sha256Schema,
  criterionResultManifestHash: Sha256Schema,
  disposition: z.enum(['ready', 'blocked', 'failed', 'cancelled']),
  summaryRef: RestrictedReferenceSchema,
}).strict().superRefine((value, ctx) => {
  if (value.contentHash !== value.proposalHash) ctx.addIssue({ code: 'custom', path: ['contentHash'], message: 'content hash must equal proposal hash' });
  if (value.createdBy !== value.scope.runtimeId) ctx.addIssue({ code: 'custom', path: ['createdBy'], message: 'result proposal is a runtime assertion only' });
  if (value.baseSha !== value.scope.repository.baseSha) ctx.addIssue({ code: 'custom', path: ['baseSha'], message: 'base SHA must match exact scope' });
  if (value.resultSha !== value.scope.repository.currentSha) ctx.addIssue({ code: 'custom', path: ['resultSha'], message: 'result SHA must match exact scope' });
  if (value.changedPathManifestHash !== value.scope.repository.changedPathManifestHash) {
    ctx.addIssue({ code: 'custom', path: ['changedPathManifestHash'], message: 'changed-path manifest must match exact scope' });
  }
});

export const CompletionGateDecisionV1Schema = ArtifactHeaderSchema.extend({
  schemaVersion: z.literal('rorca.completion-gate-decision.v1'),
  contractId: z.literal('rorca.completion-gate-decision.v1'),
  scope: ContinuationScopeSchema,
  decisionId: StableIdSchema,
  decisionRevision: z.number().int().positive(),
  decisionHash: Sha256Schema,
  proposalId: StableIdSchema,
  proposalRevision: z.number().int().positive(),
  proposalHash: Sha256Schema,
  planId: StableIdSchema,
  planRevision: z.number().int().positive(),
  planHash: Sha256Schema,
  obligationSetId: StableIdSchema,
  obligationSetRevision: z.number().int().positive(),
  obligationSetHash: Sha256Schema,
  stage: z.enum(['controller_preflight', 'host_semantic']),
  outcome: z.enum(['rejected_contract', 'stale', 'cancelled', 'rejected_gate', 'validated', 'quarantined']),
  reasonCodes: UniqueStableIdsSchema.max(100),
  failedObligationIds: UniqueStableIdsSchema.max(100),
  nextAction: z.enum(['none', 'continue_fix', 'submit_closeout', 'escalate']),
  hostEvidenceHash: Sha256Schema,
  establishesStoryCompletion: z.literal(false),
}).strict().superRefine((value, ctx) => {
  if (value.contentHash !== value.decisionHash) ctx.addIssue({ code: 'custom', path: ['contentHash'], message: 'content hash must equal decision hash' });
  if (value.createdBy === value.scope.runtimeId || RuntimeAuthor.test(value.createdBy)) {
    ctx.addIssue({ code: 'custom', path: ['createdBy'], message: 'runtime/model/process/tool cannot author a completion gate' });
  }
  if (value.outcome === 'validated' && value.failedObligationIds.length > 0) {
    ctx.addIssue({ code: 'custom', path: ['failedObligationIds'], message: 'validated gate cannot retain failed obligations' });
  }
  if (value.nextAction === 'submit_closeout' && (value.stage !== 'host_semantic' || value.outcome !== 'validated')) {
    ctx.addIssue({ code: 'custom', path: ['nextAction'], message: 'only a validated host-semantic gate may submit closeout' });
  }
  if (value.stage === 'host_semantic' && value.outcome === 'validated' && value.nextAction !== 'submit_closeout') {
    ctx.addIssue({ code: 'custom', path: ['nextAction'], message: 'validated host-semantic gate must submit closeout' });
  }
});

export const ContinuationDirectiveV1Schema = ArtifactHeaderSchema.extend({
  schemaVersion: z.literal('rorca.completion-continuation-directive.v1'),
  contractId: z.literal('rorca.completion-continuation-directive.v1'),
  scope: ContinuationScopeSchema,
  directiveId: StableIdSchema,
  directiveRevision: z.number().int().positive(),
  directiveHash: Sha256Schema,
  continuationKey: Sha256Schema,
  priorDecisionId: StableIdSchema,
  priorDecisionRevision: z.number().int().positive(),
  priorDecisionHash: Sha256Schema,
  targetPlanId: StableIdSchema,
  targetPlanRevision: z.number().int().positive(),
  targetPlanHash: Sha256Schema,
  targetBatchId: StableIdSchema,
  failedObligationIds: UniqueStableIdsSchema.max(100),
  checkpointId: StableIdSchema,
  checkpointHash: Sha256Schema,
  receiptId: StableIdSchema,
  receiptHash: Sha256Schema,
  bundleId: StableIdSchema,
  bundleHash: Sha256Schema,
  policyActivationHash: Sha256Schema,
  trigger: TriggerMaterialSchema,
  targetCursor: z.number().int().nonnegative(),
  expectedCursorAdvance: z.number().int().positive(),
  retryBudgetId: StableIdSchema,
  retryFence: z.number().int().nonnegative(),
  retrySpent: z.number().int().nonnegative().max(3),
  retryMaximum: z.number().int().nonnegative().max(3),
  authorizationExpiresAt: CanonicalTimestampSchema,
  state: z.enum(['authorized', 'dispatched', 'settled', 'expired', 'quarantined']),
}).strict().superRefine((value, ctx) => {
  if (value.contentHash !== value.directiveHash) ctx.addIssue({ code: 'custom', path: ['contentHash'], message: 'content hash must equal directive hash' });
  if (value.createdBy === value.scope.runtimeId || RuntimeAuthor.test(value.createdBy)) {
    ctx.addIssue({ code: 'custom', path: ['createdBy'], message: 'runtime/model/process/tool cannot authorize continuation' });
  }
  if (value.retrySpent > value.retryMaximum) ctx.addIssue({ code: 'custom', path: ['retrySpent'], message: 'retry budget overspent' });
  if (['authorized', 'dispatched'].includes(value.state) && value.retrySpent >= value.retryMaximum) {
    ctx.addIssue({ code: 'custom', path: ['retrySpent'], message: 'authorization requires remaining retry budget' });
  }
  if (Date.parse(value.authorizationExpiresAt) <= Date.parse(value.createdAt)) {
    ctx.addIssue({ code: 'custom', path: ['authorizationExpiresAt'], message: 'continuation authorization must expire after creation' });
  }
});

const DatabaseReceiptRefSchema = z.object({ receiptId: StableIdSchema, receiptHash: Sha256Schema }).strict();

export const ProgressLedgerEntryV1Schema = ArtifactHeaderSchema.extend({
  schemaVersion: z.literal('rorca.completion-progress-entry.v1'),
  contractId: z.literal('rorca.completion-progress-entry.v1'),
  scope: ContinuationScopeSchema,
  sequence: z.number().int().nonnegative(),
  priorEntryHash: NotApplicableHashSchema,
  entryHash: Sha256Schema,
  writerFence: z.number().int().positive(),
  planId: StableIdSchema,
  planRevision: z.number().int().positive(),
  planHash: Sha256Schema,
  repositorySha: FullGitShaSchema,
  entryType: z.enum([
    'attempt_reconciled', 'plan_persisted', 'batch_started', 'task_operation_persisted', 'task_settled',
    'validation_recorded', 'self_review_recorded', 'proposal_persisted', 'gate_decided',
    'continuation_authorized', 'closeout_submitted', 'attempt_settled', 'recovery_recorded',
  ]),
  payloadHash: Sha256Schema,
  databaseReceiptRefs: z.array(DatabaseReceiptRefSchema).max(100),
  recordedAt: CanonicalTimestampSchema,
}).strict().superRefine((value, ctx) => {
  if (value.contentHash !== value.entryHash) ctx.addIssue({ code: 'custom', path: ['contentHash'], message: 'content hash must equal ledger entry hash' });
  if ((value.sequence === 0) !== (value.priorEntryHash === 'not_applicable')) {
    ctx.addIssue({ code: 'custom', path: ['priorEntryHash'], message: 'only the first ledger entry may omit a prior hash' });
  }
  if (value.writerFence !== value.scope.fencingToken) ctx.addIssue({ code: 'custom', path: ['writerFence'], message: 'writer fence must match exact scope' });
  if (value.repositorySha !== value.scope.repository.currentSha) ctx.addIssue({ code: 'custom', path: ['repositorySha'], message: 'repository SHA must match exact scope' });
  const receiptIds = value.databaseReceiptRefs.map((receipt) => receipt.receiptId);
  if (new Set(receiptIds).size !== receiptIds.length) ctx.addIssue({ code: 'custom', path: ['databaseReceiptRefs'], message: 'duplicate database receipt identifiers are forbidden' });
});

const ReceiptDispositionSchema = z.object({ receiptId: StableIdSchema, receiptHash: Sha256Schema }).strict();
const TaskDispositionSchema = z.object({
  taskId: StableIdSchema,
  state: z.enum(['settled', 'blocked', 'cancelled']),
  resultHash: Sha256Schema,
}).strict();
const ExclusionDispositionSchema = z.object({ obligationId: StableIdSchema, reasonCode: StableIdSchema, evidenceHash: Sha256Schema }).strict();
const RiskOrBlockerSchema = z.object({ code: StableIdSchema, referenceHash: Sha256Schema }).strict();

export const FinalCompletionReportV1Schema = ArtifactHeaderSchema.extend({
  schemaVersion: z.literal('rorca.completion-final-report.v1'),
  contractId: z.literal('rorca.completion-final-report.v1'),
  scope: ContinuationScopeSchema,
  reportId: StableIdSchema,
  storyCloseoutDecisionId: StableIdSchema,
  storyCloseoutDecisionStatus: z.literal('accepted'),
  gateDecisionId: StableIdSchema,
  gateDecisionHash: Sha256Schema,
  proposalId: StableIdSchema,
  proposalHash: Sha256Schema,
  obligationSetId: StableIdSchema,
  obligationSetHash: Sha256Schema,
  finalSha: FullGitShaSchema,
  treeHash: FullGitShaSchema,
  diffHash: Sha256Schema,
  writerFence: z.number().int().positive(),
  fileManifestHash: Sha256Schema,
  changeManifestHash: Sha256Schema,
  validationReceipts: z.array(ReceiptDispositionSchema).min(1).max(100),
  evidenceReceipts: z.array(ReceiptDispositionSchema).min(1).max(500),
  taskDispositions: z.array(TaskDispositionSchema).max(192),
  proposalDisposition: z.enum(['ready', 'blocked', 'failed', 'cancelled']),
  exclusionDispositions: z.array(ExclusionDispositionSchema).max(500),
  retryDisposition: z.object({ retryBudgetId: StableIdSchema, spent: z.number().int().nonnegative().max(3), maximum: z.number().int().nonnegative().max(3), state: z.enum(['not_used', 'settled', 'exhausted', 'quarantined']) }).strict(),
  recoveryDisposition: z.object({ recoveryHash: Sha256Schema, state: z.enum(['not_required', 'reconciled', 'quarantined']) }).strict(),
  contextDisposition: z.object({ checkpointHash: Sha256Schema, receiptHash: Sha256Schema, bundleHash: Sha256Schema, state: z.enum(['current', 'superseded', 'expired']) }).strict(),
  missingObligationIds: UniqueStableIdsSchema.max(100),
  conflictingObligationIds: UniqueStableIdsSchema.max(100),
  risks: z.array(RiskOrBlockerSchema).max(100),
  blockers: z.array(RiskOrBlockerSchema).max(100),
  merged: z.literal(false),
  deployed: z.literal(false),
  productionApproved: z.literal(false),
  mergeReady: z.boolean(),
}).strict().superRefine((value, ctx) => {
  if (value.reportId !== value.storyCloseoutDecisionId) {
    ctx.addIssue({ code: 'custom', path: ['reportId'], message: 'final report ID must equal the accepted closeout decision ID' });
  }
  if (value.finalSha !== value.scope.repository.currentSha) ctx.addIssue({ code: 'custom', path: ['finalSha'], message: 'final SHA must match exact scope' });
  if (value.writerFence !== value.scope.fencingToken) ctx.addIssue({ code: 'custom', path: ['writerFence'], message: 'writer fence must match exact scope' });
  if (value.retryDisposition.spent > value.retryDisposition.maximum) ctx.addIssue({ code: 'custom', path: ['retryDisposition', 'spent'], message: 'retry budget overspent' });
  if (value.mergeReady && (value.missingObligationIds.length > 0 || value.conflictingObligationIds.length > 0)) {
    ctx.addIssue({ code: 'custom', path: ['mergeReady'], message: 'merge readiness requires no missing or conflicting obligations' });
  }
  const taskIds = value.taskDispositions.map((task) => task.taskId);
  if (new Set(taskIds).size !== taskIds.length) ctx.addIssue({ code: 'custom', path: ['taskDispositions'], message: 'duplicate task dispositions are forbidden' });
});

export type CanonicalObligationSetV1 = z.infer<typeof CanonicalObligationSetV1Schema>;
export type AttemptTaskPlanV1 = z.infer<typeof AttemptTaskPlanV1Schema>;
export type ResultProposalV1 = z.infer<typeof ResultProposalV1Schema>;
export type CompletionGateDecisionV1 = z.infer<typeof CompletionGateDecisionV1Schema>;
export type ContinuationDirectiveV1 = z.infer<typeof ContinuationDirectiveV1Schema>;
export type ProgressLedgerEntryV1 = z.infer<typeof ProgressLedgerEntryV1Schema>;
export type FinalCompletionReportV1 = z.infer<typeof FinalCompletionReportV1Schema>;

export interface CompletionContractViolation {
  code: string;
  path: string;
  message: string;
}
export type CompletionContractValidation = Readonly<
  | { valid: true; violations: readonly [] }
  | { valid: false; violations: readonly CompletionContractViolation[] }
>;

function validation(violations: CompletionContractViolation[]): CompletionContractValidation {
  return violations.length === 0 ? { valid: true, violations: [] } : { valid: false, violations };
}
function violation(violations: CompletionContractViolation[], code: string, path: string, message: string): void {
  violations.push({ code, path, message });
}
function governedEqual(domain: string, left: unknown, right: unknown): boolean {
  return governedHash(domain, left as never) === governedHash(domain, right as never);
}
function findTasks(plan: AttemptTaskPlanV1): Map<string, { batchId: string; task: AttemptTaskPlanV1['batches'][number]['tasks'][number] }> {
  return new Map(plan.batches.flatMap((batch) => batch.tasks.map((task) => [task.taskId, { batchId: batch.batchId, task }] as const)));
}

export function validateAttemptTaskPlan(
  plan: AttemptTaskPlanV1,
  input: { workPackage: WorkPackageV1; obligationSet: CanonicalObligationSetV1; priorPlan?: AttemptTaskPlanV1 | null },
): CompletionContractValidation {
  const violations: CompletionContractViolation[] = [];
  const { workPackage, obligationSet, priorPlan = null } = input;
  if (!governedEqual('rorca.completion-scope-compare.v1', plan.scope, obligationSet.scope)) {
    violation(violations, 'scope_mismatch', 'scope', 'plan and obligation set must have exactly equal continuation scopes');
  }
  if (plan.scope.workspaceId !== workPackage.workspaceId || plan.scope.missionId !== workPackage.missionId
    || plan.scope.missionRevision !== workPackage.missionRevision || plan.scope.missionHash !== workPackage.missionHash
    || plan.scope.workPackageId !== workPackage.workPackageId || plan.scope.workPackageRevision !== workPackage.workPackageRevision
    || plan.scope.workPackageHash !== workPackage.workPackageHash
    || !governedEqual('rorca.completion-spec-compare.v1', plan.scope.spec, workPackage.spec)
    || !governedEqual('rorca.completion-repository-compare.v1', plan.scope.repository, workPackage.repository)) {
    violation(violations, 'work_package_scope_mismatch', 'scope', 'plan scope must exactly bind the governing work package');
  }
  if (obligationSet.workPackageHash !== workPackage.workPackageHash
    || plan.obligationSetId !== obligationSet.obligationSetId
    || plan.obligationSetRevision !== obligationSet.obligationSetRevision
    || plan.obligationSetHash !== obligationSet.obligationSetHash) {
    violation(violations, 'obligation_set_mismatch', 'obligationSetHash', 'plan must bind the exact canonical obligation set');
  }
  const obligationIds = new Set(obligationSet.obligations.map((obligation) => obligation.obligationId));
  const coveredIds = new Set(plan.batches.flatMap((batch) => batch.tasks.flatMap((task) => task.coveredObligationIds)));
  for (const obligation of obligationSet.obligations) {
    if (obligation.required && !coveredIds.has(obligation.obligationId)) {
      violation(violations, 'required_obligation_omitted', 'batches', `required obligation ${obligation.obligationId} is not covered`);
    }
  }
  for (const coveredId of coveredIds) {
    if (!obligationIds.has(coveredId)) violation(violations, 'unknown_obligation', 'batches', `unknown obligation ${coveredId} is covered`);
  }
  const allowedPaths = new Set(workPackage.allowedPaths);
  for (const batch of plan.batches) {
    for (const task of batch.tasks) {
      for (const path of task.allowedPaths) {
        if (!allowedPaths.has(path)) violation(violations, 'path_broadening', `batches.${batch.ordinal}.tasks.${task.ordinal}.allowedPaths`, `${path} is outside the work-package allowlist`);
      }
    }
  }
  if (plan.planRevision > 1 && !priorPlan) {
    violation(violations, 'prior_plan_required', 'priorPlanHash', 'revised plans require the exact prior plan for fail-closed validation');
  }
  if (priorPlan) {
    if (plan.planRevision !== priorPlan.planRevision + 1 || plan.priorPlanHash !== priorPlan.planHash) {
      violation(violations, 'plan_revision_mismatch', 'priorPlanHash', 'plan revision and prior hash must advance exactly once');
    }
    if (!governedEqual('rorca.completion-scope-compare.v1', plan.scope, priorPlan.scope)
      || plan.planId !== priorPlan.planId
      || plan.obligationSetId !== priorPlan.obligationSetId
      || plan.obligationSetRevision !== priorPlan.obligationSetRevision
      || plan.obligationSetHash !== priorPlan.obligationSetHash) {
      violation(violations, 'plan_identity_mismatch', 'planId', 'plan revision cannot change scope, identity, or obligation set');
    }
    const previousTasks = findTasks(priorPlan);
    const currentTasks = findTasks(plan);
    for (const [taskId, previous] of previousTasks) {
      const current = currentTasks.get(taskId);
      if (previous.task.state === 'settled' && (!current || current.batchId !== previous.batchId
        || !governedEqual('rorca.completion-settled-task-compare.v1', current.task, previous.task))) {
        violation(violations, 'settled_task_rewrite', 'batches', `settled task ${taskId} cannot be removed, moved, or rewritten`);
        continue;
      }
      if (!current) continue;
      const previousPaths = new Set(previous.task.allowedPaths);
      const previousCommands = new Set(previous.task.commandHashes);
      if (current.task.allowedPaths.some((path) => !previousPaths.has(path))) {
        violation(violations, 'path_broadening', 'batches', `task ${taskId} cannot broaden mutable paths in a revision`);
      }
      if (current.task.commandHashes.some((hash) => !previousCommands.has(hash))) {
        violation(violations, 'command_broadening', 'batches', `task ${taskId} cannot broaden validation commands in a revision`);
      }
    }
  }
  return validation(violations);
}

export function validateResultProposal(
  proposal: ResultProposalV1,
  input: { scope: ContinuationScope; plan: AttemptTaskPlanV1; ledgerHighWater: ProgressLedgerEntryV1 | string },
): CompletionContractValidation {
  const violations: CompletionContractViolation[] = [];
  if (!governedEqual('rorca.completion-scope-compare.v1', proposal.scope, input.scope)
    || !governedEqual('rorca.completion-scope-compare.v1', proposal.scope, input.plan.scope)) {
    violation(violations, 'scope_mismatch', 'scope', 'proposal, plan, and expected continuation scope must match exactly');
  }
  if (proposal.planId !== input.plan.planId || proposal.planRevision !== input.plan.planRevision || proposal.planHash !== input.plan.planHash) {
    violation(violations, 'plan_mismatch', 'planHash', 'proposal must bind the exact attempt plan');
  }
  const highWaterHash = typeof input.ledgerHighWater === 'string' ? input.ledgerHighWater : input.ledgerHighWater.entryHash;
  if (proposal.ledgerHighWaterHash !== highWaterHash) {
    violation(violations, 'ledger_high_water_mismatch', 'ledgerHighWaterHash', 'proposal must bind the exact durable-ledger high-water hash');
  }
  if (typeof input.ledgerHighWater !== 'string') {
    if (!governedEqual('rorca.completion-scope-compare.v1', input.ledgerHighWater.scope, proposal.scope)
      || input.ledgerHighWater.planId !== input.plan.planId
      || input.ledgerHighWater.planRevision !== input.plan.planRevision
      || input.ledgerHighWater.planHash !== input.plan.planHash
      || input.ledgerHighWater.repositorySha !== proposal.resultSha) {
      violation(violations, 'ledger_binding_mismatch', 'ledgerHighWaterHash', 'ledger high-water entry must bind the same scope, plan, and result SHA');
    }
  }
  if (proposal.baseSha !== proposal.scope.repository.baseSha || proposal.resultSha !== proposal.scope.repository.currentSha
    || proposal.changedPathManifestHash !== proposal.scope.repository.changedPathManifestHash) {
    violation(violations, 'repository_binding_mismatch', 'resultSha', 'proposal repository hashes must match its exact continuation scope');
  }
  return validation(violations);
}

export interface CompletionOperationKeyInput {
  scope: ContinuationScope;
  planId: string;
  planRevision: number;
  planHash: string;
  batchId: string;
  taskId: string;
  objectiveHash: string;
  payloadHash: string;
}

export function completionOperationKey(input: CompletionOperationKeyInput): string {
  return governedHash('rorca.completion-operation-key.v1', {
    scope: input.scope,
    planId: input.planId,
    planRevision: input.planRevision,
    planHash: input.planHash,
    batchId: input.batchId,
    taskId: input.taskId,
    objectiveHash: input.objectiveHash,
    payloadHash: input.payloadHash,
  } as never);
}

export interface CompletionContinuationKeyInput {
  decision: CompletionGateDecisionV1;
  scope: ContinuationScope;
  targetPlanId: string;
  targetPlanRevision: number;
  targetPlanHash: string;
  targetBatchId: string;
  failedObligationIds: readonly string[];
  checkpointHash: string;
  receiptHash: string;
  bundleHash: string;
  policyActivationHash: string;
  trigger: z.infer<typeof TriggerMaterialSchema>;
  targetCursor: number;
  expectedCursorAdvance: number;
  retryBudgetId: string;
  retryFence: number;
  retrySpent: number;
  retryMaximum: number;
}

export function completionContinuationKey(input: CompletionContinuationKeyInput): string | null {
  if (input.decision.nextAction !== 'continue_fix'
    || ['validated', 'cancelled', 'quarantined'].includes(input.decision.outcome)) return null;
  return governedHash('rorca.completion-continuation-key.v1', {
    scope: input.scope,
    priorDecisionId: input.decision.decisionId,
    priorDecisionRevision: input.decision.decisionRevision,
    priorDecisionHash: input.decision.decisionHash,
    targetPlanId: input.targetPlanId,
    targetPlanRevision: input.targetPlanRevision,
    targetPlanHash: input.targetPlanHash,
    targetBatchId: input.targetBatchId,
    failedObligationIds: [...input.failedObligationIds],
    checkpointHash: input.checkpointHash,
    receiptHash: input.receiptHash,
    bundleHash: input.bundleHash,
    policyActivationHash: input.policyActivationHash,
    trigger: input.trigger,
    targetCursor: input.targetCursor,
    expectedCursorAdvance: input.expectedCursorAdvance,
    retryBudgetId: input.retryBudgetId,
    retryFence: input.retryFence,
    retrySpent: input.retrySpent,
    retryMaximum: input.retryMaximum,
  } as never);
}

export function validateContinuationDirective(
  directive: ContinuationDirectiveV1,
  input: { decision: CompletionGateDecisionV1; candidateState: 'open' | 'submitted_to_closeout' | 'accepted' | 'cancelled'; retryMaximum: number },
): CompletionContractValidation {
  const violations: CompletionContractViolation[] = [];
  if (input.candidateState !== 'open') violation(violations, 'continuation_suppressed', 'state', 'terminal or submitted completion candidates suppress continuation');
  if (input.decision.nextAction !== 'continue_fix') violation(violations, 'continuation_not_authorized', 'priorDecisionId', 'prior decision does not authorize a bounded fix');
  if (directive.priorDecisionId !== input.decision.decisionId || directive.priorDecisionRevision !== input.decision.decisionRevision
    || directive.priorDecisionHash !== input.decision.decisionHash
    || !governedEqual('rorca.completion-scope-compare.v1', directive.scope, input.decision.scope)) {
    violation(violations, 'decision_mismatch', 'priorDecisionHash', 'directive must bind the exact prior gate decision and scope');
  }
  if (directive.retryMaximum !== Math.min(Math.max(input.retryMaximum, 0), 3)) {
    violation(violations, 'retry_budget_mismatch', 'retryMaximum', 'directive retry maximum must equal the governing budget capped at three');
  }
  const expectedKey = completionContinuationKey({
    decision: input.decision,
    scope: directive.scope,
    targetPlanId: directive.targetPlanId,
    targetPlanRevision: directive.targetPlanRevision,
    targetPlanHash: directive.targetPlanHash,
    targetBatchId: directive.targetBatchId,
    failedObligationIds: directive.failedObligationIds,
    checkpointHash: directive.checkpointHash,
    receiptHash: directive.receiptHash,
    bundleHash: directive.bundleHash,
    policyActivationHash: directive.policyActivationHash,
    trigger: directive.trigger,
    targetCursor: directive.targetCursor,
    expectedCursorAdvance: directive.expectedCursorAdvance,
    retryBudgetId: directive.retryBudgetId,
    retryFence: directive.retryFence,
    retrySpent: directive.retrySpent,
    retryMaximum: directive.retryMaximum,
  });
  if (expectedKey === null || directive.continuationKey !== expectedKey) {
    violation(violations, 'continuation_key_mismatch', 'continuationKey', 'directive continuation key must be deterministic and authorized');
  }
  return validation(violations);
}

export function validateFinalCompletionReport(
  report: FinalCompletionReportV1,
  input: {
    closeoutDecision: { decisionId: string; status: 'accepted' | 'blocked' };
    gateDecision: CompletionGateDecisionV1;
    proposal: ResultProposalV1;
  },
): CompletionContractValidation {
  const violations: CompletionContractViolation[] = [];
  if (input.closeoutDecision.status !== 'accepted'
    || report.storyCloseoutDecisionStatus !== 'accepted'
    || report.reportId !== input.closeoutDecision.decisionId
    || report.storyCloseoutDecisionId !== input.closeoutDecision.decisionId) {
    violation(violations, 'closeout_not_accepted', 'storyCloseoutDecisionId', 'only the exact accepted StoryCloseoutDecision can create a final report');
  }
  if (input.gateDecision.stage !== 'host_semantic' || input.gateDecision.outcome !== 'validated'
    || input.gateDecision.nextAction !== 'submit_closeout'
    || input.gateDecision.establishesStoryCompletion !== false
    || report.gateDecisionId !== input.gateDecision.decisionId
    || report.gateDecisionHash !== input.gateDecision.decisionHash) {
    violation(violations, 'gate_not_accepted', 'gateDecisionId', 'final report must bind the validated host-semantic gate without treating it as completion');
  }
  if (input.proposal.disposition !== 'ready' || report.proposalDisposition !== 'ready'
    || report.proposalId !== input.proposal.proposalId || report.proposalHash !== input.proposal.proposalHash
    || input.gateDecision.proposalId !== input.proposal.proposalId
    || input.gateDecision.proposalRevision !== input.proposal.proposalRevision
    || input.gateDecision.proposalHash !== input.proposal.proposalHash) {
    violation(violations, 'proposal_not_ready', 'proposalId', 'accepted final report must bind the exact ready proposal and gate subject');
  }
  if (!governedEqual('rorca.completion-scope-compare.v1', report.scope, input.gateDecision.scope)
    || !governedEqual('rorca.completion-scope-compare.v1', report.scope, input.proposal.scope)
    || report.finalSha !== input.proposal.resultSha || report.treeHash !== input.proposal.treeHash
    || report.diffHash !== input.proposal.diffHash || report.writerFence !== report.scope.fencingToken) {
    violation(violations, 'final_subject_mismatch', 'scope', 'final report must preserve the exact scope, fence, SHA, tree, and diff accepted by the gate');
  }
  if (report.obligationSetId !== input.gateDecision.obligationSetId || report.obligationSetHash !== input.gateDecision.obligationSetHash) {
    violation(violations, 'obligation_set_mismatch', 'obligationSetHash', 'final report must bind the exact gated obligation set');
  }
  if (report.missingObligationIds.length > 0 || report.conflictingObligationIds.length > 0) {
    violation(violations, 'obligations_unsettled', 'missingObligationIds', 'accepted final report cannot retain missing or conflicting obligations');
  }
  if (report.mergeReady && report.taskDispositions.some((task) => task.state !== 'settled')) {
    violation(violations, 'tasks_unsettled', 'mergeReady', 'merge-ready report cannot retain unsettled tasks');
  }
  return validation(violations);
}

export type ProgressLedgerEntryHashMaterial = Omit<ProgressLedgerEntryV1, 'contentHash' | 'entryHash'>;
export function completionProgressEntryHash(input: ProgressLedgerEntryHashMaterial): string {
  return governedHash('rorca.completion-progress-entry.v1', input as never);
}
