/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import { Pool } from 'pg';
import { canonicalTransaction, closePool } from '../../db';
import {
  consumeCompletionContinuationDirective,
  dispatchCompletionContinuationDirective,
  activateCompletionAttempt,
  loadCanonicalCompletionProgressRecords,
  loadCanonicalCompletionContinuationLifecycles,
  loadCompletionAttempt,
  loadCurrentCompletionTaskPlan,
  persistCompletionGateDecision,
  persistCompletionContinuationDirective,
  persistCompletionProgressEntry,
  persistCompletionResultProposal,
  settleCompletionContinuationDirective,
  persistCompletionTaskPlan,
  persistFinalCompletionReport,
} from '../completion-protocol-service';
import {
  AttemptTaskPlanV1Schema,
  CanonicalObligationSetV1Schema,
  CompletionGateDecisionV1Schema,
  ContinuationDirectiveV1Schema,
  FinalCompletionReportV1Schema,
  ProgressLedgerEntryV1Schema,
  ResultProposalV1Schema,
  WorkPackageV1Schema,
  completionContinuationKey,
  completionProgressEntryHash,
  governedHash,
  type CompletionGateDecisionV1,
  type ProgressLedgerEntryHashMaterial,
  type ProgressLedgerEntryV1,
} from '../governed-contracts';

const migrationDatabaseUrl = process.env.RORCA_MIGRATION_DATABASE_URL ?? process.env.WAVE2_TEST_MIGRATION_DATABASE_URL;
const runtimeDatabaseUrl = process.env.DATABASE_URL;
if (!migrationDatabaseUrl || !runtimeDatabaseUrl) throw new Error('Isolated migration and runtime database URLs are required');

const workspaceId = `workspace:completion-service-${crypto.randomUUID()}`;
const foreignWorkspaceId = `workspace:completion-service-foreign-${crypto.randomUUID()}`;
const missionId = 'mission:completion-service';
const workPackageId = 'work-package:completion-service';
const attemptId = 'attempt:completion-service';
const leaseId = 'lease:completion-service';
const runtimeId = 'runtime:completion-service';
const obligationSetId = 'obligation-set:completion-service';
const planId = 'plan:completion-service';
const hash = (digit: string) => `sha256:${digit.repeat(64)}`;
const gitSha = (digit: string) => digit.repeat(40);
const workPackageHash = hash('1');
const missionHash = hash('2');
const obligationSetHash = hash('3');
const planHash = hash('4');
const manifestHash = hash('5');
const resultProposalHash = hash('6');
const hostGateHash = hash('7');
const finalReportHash = hash('8');
const storyAttemptResultId = `ATR-sha256:${'e'.repeat(64)}`;
const G = gitSha('a');
const createdAt = '2026-08-04T14:00:00.000Z';
const expiresAt = '2026-08-04T15:00:00.000Z';

const ownerPool = new Pool({
  connectionString: migrationDatabaseUrl,
  options: `--search_path=rorca,public -c rorca.migration_mode=on -c rorca.workspace_id=${workspaceId}`,
});
const runtimePool = new Pool({
  connectionString: runtimeDatabaseUrl,
  options: `--search_path=rorca,public -c rorca.workspace_id=${workspaceId}`,
});

const spec = {
  specId: 'spec:completion-service', specVersion: 1, specHash: hash('b'),
  canonicalSpecPath: 'specs/completion-service.yaml', storyId: 'story:completion-service',
  storyVersion: 1, storyHash: hash('c'), criteriaManifestHash: hash('d'),
};
const repository = {
  repositoryId: 'repository:completion-service', remoteAuthorityHash: hash('e'), gitObjectFormat: 'sha1' as const,
  baseSha: G, currentSha: G, expectedHeadSha: G, worktreeId: 'worktree:completion-service',
  allowedPathManifestHash: hash('f'), requiredPathManifestHash: hash('a'),
  changedPathManifestHash: hash('b'), forbiddenPathManifestHash: hash('c'),
};
const scope = {
  workspaceId, missionId, missionRevision: 1, missionHash,
  workPackageId, workPackageRevision: 1, workPackageHash,
  spec, runId: 1, attemptId, leaseId, fencingToken: 1, leaseExpiresAt: expiresAt,
  cancellationId: 'cancellation:none', runtimeId, controllerGeneration: 0, runtimeGeneration: 0,
  sessionId: 'session:completion-service', sessionFileHash: hash('d'), turnId: 'turn:completion-service',
  turnAttempt: 1, originatingGeneration: 0, cursor: 0, cursorHash: hash('e'), priorEntryId: 'not_applicable' as const,
  repository, validationStateHash: hash('f'), rootCauseClassification: 'root-cause:none', rootCauseHash: hash('a'),
  policyDefinitionId: 'policy:completion-service', policyDefinitionVersion: '1.0.0', policyDefinitionHash: hash('b'),
  policyActivationId: 'activation:completion-service', policyActivationRevision: 1, policyActivationHash: hash('c'),
};
const restrictedRef = {
  referenceId: 'reference:completion-summary', kind: 'artifact' as const, hash: hash('d'),
  sensitivity: 'internal' as const, retentionClass: 'retention:standard', accessTier: 'auth' as const,
  rawPayloadIncluded: false as const,
};

function header(schemaVersion: string, artifactId: string, contentHash: string, createdBy = 'controller:completion-service') {
  return { schemaVersion, contractId: schemaVersion, contractVersion: '1.0.0', artifactId, contentHash, createdAt, createdBy };
}

const workPackage = WorkPackageV1Schema.parse({
  ...header('rorca.work-package.v1', 'artifact:work-package-service', workPackageHash),
  workspaceId, missionId, missionRevision: 1, missionHash, workPackageId, workPackageRevision: 1,
  workPackageHash, spec, objectiveHash: hash('e'), dependencies: [], repository,
  allowedPaths: ['src/completion.ts'], requiredPaths: ['src/completion.ts'],
  validationObligationsHash: hash('f'), evidenceObligationsHash: hash('a'), executionPostureHash: hash('b'),
  lifecycleProjectionRef: 'lifecycle:completion-service',
  authorityCeilings: { delivery: 'execute_bounded', operational: 'none', knowledge: 'none', interactive: 'none' },
  resourceLimitsHash: hash('c'), retryLimit: 2, planRevision: 1, state: 'active', proposalId: 'proposal:work-package-service',
});
const obligationSet = CanonicalObligationSetV1Schema.parse({
  ...header('rorca.completion-obligation-set.v1', 'artifact:obligation-service', obligationSetHash, 'host:completion-service'),
  scope, obligationSetId, obligationSetRevision: 1, obligationSetHash, workPackageHash,
  manifestHash, validationHash: hash('f'), evidenceHash: hash('a'), pathHash: hash('b'),
  postureHash: hash('c'), resourceHash: hash('d'),
  obligations: [
    { obligationId: 'obligation:requirement', ordinal: 0, kind: 'requirement', required: true, sourceHash: hash('e'), hostVerifierRef: 'verifier:requirements' },
    { obligationId: 'obligation:validation', ordinal: 1, kind: 'validation', required: true, sourceHash: hash('f'), hostVerifierRef: 'verifier:validation' },
  ],
  state: 'active',
});
const plan = AttemptTaskPlanV1Schema.parse({
  ...header('rorca.attempt-task-plan.v1', 'artifact:plan-service', planHash), scope,
  planId, planRevision: 1, planHash, priorPlanHash: 'not_applicable',
  obligationSetId, obligationSetRevision: 1, obligationSetHash,
  batches: [{
    batchId: 'batch:completion-service', ordinal: 0,
    tasks: [{
      taskId: 'task:completion-service', ordinal: 0, objectiveHash: hash('a'),
      coveredObligationIds: ['obligation:requirement', 'obligation:validation'],
      allowedPaths: ['src/completion.ts'], commandHashes: [hash('b')], state: 'pending',
    }],
  }],
  totalBatches: 1, totalTasks: 1, totalMutablePaths: 1, totalValidationCommands: 1, serializedBytes: 4096,
});

let runId: number;
let acceptedCloseoutDecisionId: string;
let blockedCloseoutDecisionId: string;

async function seedExactGovernedAuthority(): Promise<void> {
  await ownerPool.query(`INSERT INTO workspaces(id,label,path) VALUES($1,$1,$2),($3,$3,$4)`,
    [workspaceId, `/tmp/${workspaceId}`, foreignWorkspaceId, `/tmp/${foreignWorkspaceId}`]);
  await ownerPool.query(`INSERT INTO governed_missions(workspace_id,mission_id,created_by) VALUES($1,$2,'host:test')`,
    [workspaceId, missionId]);
  await ownerPool.query(`INSERT INTO governed_mission_versions(
      workspace_id,mission_id,mission_revision,mission_hash,contract_version,canonical_spec_id,
      canonical_spec_version,canonical_spec_hash,canonical_spec_path,repository_id,base_sha,payload_json,payload_hash,created_by)
    VALUES($1,$2,1,$3,'1.0.0',$4,1,$5,$6,$7,$8,$9::jsonb,$10,'host:test')`, [
    workspaceId, missionId, missionHash, spec.specId, spec.specHash, spec.canonicalSpecPath,
    repository.repositoryId, repository.baseSha, JSON.stringify({ spec }), hash('e'),
  ]);
  await ownerPool.query(`INSERT INTO governed_work_packages(workspace_id,mission_id,work_package_id,created_by)
    VALUES($1,$2,$3,'host:test')`, [workspaceId, missionId, workPackageId]);
  await ownerPool.query(`INSERT INTO governed_work_package_revisions(
      workspace_id,mission_id,work_package_id,work_package_revision,work_package_hash,mission_revision,
      mission_hash,story_id,repository_id,base_sha,allowed_path_manifest_hash,required_path_manifest_hash,
      validation_manifest_hash,authority_ceiling_hash,payload_json,proposal_id)
    VALUES($1,$2,$3,1,$4,1,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)`, [
    workspaceId, missionId, workPackageId, workPackageHash, missionHash, spec.storyId, repository.repositoryId,
    repository.baseSha, repository.allowedPathManifestHash, repository.requiredPathManifestHash,
    workPackage.validationObligationsHash, workPackage.executionPostureHash, JSON.stringify(workPackage), workPackage.proposalId,
  ]);
  runId = Number((await ownerPool.query<{ id: string }>(`INSERT INTO pipeline_runs(
      id,spec_path,workspace_id,status,branch_name,worktree_path,execution_workspace_path,
      execution_worktree_path,dispatch_fence,canonical_spec_revision)
    VALUES(1,$1,$2,'running','main',$3,$3,$3,$4,$5) RETURNING id::text`,
  [spec.canonicalSpecPath, workspaceId, `/tmp/${workspaceId}`, hash('f'), spec.specHash])).rows[0].id);
  await ownerPool.query(`INSERT INTO story_execution_manifests(
      manifest_hash,schema_version,workspace_id,spec_id,run_id,story_id,attempt,spec_revision,story_revision,payload)
    VALUES($1,'rorca.story-execution-manifest.v2',$2,$3,$4,$5,1,$6,$7,'{}')`,
  [manifestHash, workspaceId, spec.specId, runId, spec.storyId, spec.specHash, spec.storyHash]);
  await ownerPool.query(`INSERT INTO host_story_attempt_envelopes(
      envelope_id,schema_version,workspace_id,run_id,story_id,attempt,launch_generation,cancellation_fence,
      manifest_hash,spec_id,spec_revision,story_revision,canonical_spec_path,canonical_spec_revision,
      canonical_spec_bytes_hash,run_spec_path,run_spec_revision,run_spec_bytes_hash,repository_realpath,
      repository_identity,base_git_sha,expected_git_sha,observed_git_sha,expected_git_branch,worktree_realpath,
      worktree_identity,worktree_branch,runtime_identity,identity_hash,payload_hash,outcome,outcome_provenance,
      exit_code,finished_at)
    VALUES($1,'rorca.host-story-attempt-envelope.v1',$2,$3,$4,1,$5,$6,$7,$8,$9,$10,$11,$9,$12,$11,$9,$12,
      $13,$14,$15::char(40),$15::text,$15::char(40),'main',$13,$16,'main',$17::jsonb,$18,$19,
      'success','host_process',0,statement_timestamp())`, [
    crypto.randomUUID(), workspaceId, runId, spec.storyId, crypto.randomUUID(), hash('f'), manifestHash,
    spec.specId, spec.specHash, spec.storyHash, spec.canonicalSpecPath, hash('a'), `/tmp/${workspaceId}`,
    hash('b'), G, hash('c'), JSON.stringify({ processRole: 'worker-engine', processPid: 1 }), hash('d'), hash('e'),
  ]);
  const attemptResultId = storyAttemptResultId;
  const attemptPayload = {
    schemaVersion: 'rorca.story-attempt-result.v1', attemptResultId, manifestHash,
    identity: { workspaceId, specId: spec.specId, runId, storyId: spec.storyId, attempt: 1 },
  };
  await ownerPool.query(`INSERT INTO story_attempt_results(
      attempt_result_id,manifest_hash,workspace_id,spec_id,run_id,story_id,attempt,payload)
    VALUES($1,$2,$3,$4,$5,$6,1,$7::jsonb)`,
  [attemptResultId, manifestHash, workspaceId, spec.specId, runId, spec.storyId, JSON.stringify(attemptPayload)]);
  blockedCloseoutDecisionId = `CLO-sha256:${'e'.repeat(64)}`;
  acceptedCloseoutDecisionId = `CLO-sha256:${'f'.repeat(64)}`;
  const blockedPayload = { decisionId: blockedCloseoutDecisionId, status: 'blocked',
    activeSubjectRevision: { commitSha: G, worktreePath: `/tmp/${workspaceId}`, branch: 'main' } };
  await ownerPool.query(`INSERT INTO story_closeout_decisions(
      decision_id,manifest_hash,attempt_result_id,workspace_id,spec_id,run_id,story_id,attempt,status,payload)
    VALUES($1,$2,$3,$4,$5,$6,$7,1,'blocked',$8::jsonb)`,
  [blockedCloseoutDecisionId, manifestHash, attemptResultId, workspaceId, spec.specId, runId, spec.storyId,
    JSON.stringify(blockedPayload)]);
  await ownerPool.query(`INSERT INTO governed_execution_attempts(
      workspace_id,attempt_id,mission_id,work_package_id,work_package_revision,run_id,story_id,runtime_id,
      generation,manifest_hash,repository_id,worktree_id,spec_id,spec_version,spec_hash,story_version,story_hash,
      criteria_manifest_hash,base_sha,current_sha,expected_head_sha,allowed_path_manifest_hash,
      required_path_manifest_hash,changed_path_manifest_hash,forbidden_path_manifest_hash)
    VALUES($1,$2,$3,$4,1,$5,$6,$7,0,$8,$9,$10,$11,1,$12,1,$13,$14,$15,$15,$15,$16,$17,$18,$19)`, [
    workspaceId, attemptId, missionId, workPackageId, runId, spec.storyId, runtimeId, manifestHash,
    repository.repositoryId, repository.worktreeId, spec.specId, spec.specHash, spec.storyHash,
    spec.criteriaManifestHash, G, repository.allowedPathManifestHash, repository.requiredPathManifestHash,
    repository.changedPathManifestHash, repository.forbiddenPathManifestHash,
  ]);
  await ownerPool.query(`INSERT INTO execution_lease_slots(workspace_id,lease_slot_key,last_fence)
    VALUES($1,$2,1)`, [workspaceId, hash('f')]);
  await ownerPool.query(`INSERT INTO execution_leases(
      workspace_id,lease_id,lease_slot_key,attempt_id,fencing_token,work_package_revision,runtime_id,
      repository_id,base_sha,current_sha,worktree_id,policy_definition_hash,policy_activation_hash,
      checkpoint_hash,bundle_hash,cancellation_id,expires_at,state,payload_hash)
    VALUES($1,$2,$3,$4,1,1,$5,$6,$7,$7,$8,$9,$10,$11,$12,$13,statement_timestamp()+INTERVAL '1 day','active',$14)`, [
    workspaceId, leaseId, hash('f'), attemptId, runtimeId, repository.repositoryId, G, repository.worktreeId,
    scope.policyDefinitionHash, scope.policyActivationHash, hash('d'), hash('e'), scope.cancellationId, hash('f'),
  ]);
}

beforeAll(async () => {
  await seedExactGovernedAuthority();
});

afterAll(async () => {
  await closePool();
  await Promise.allSettled([ownerPool.end(), runtimePool.end()]);
});

test('service activates exact authority idempotently, rejects immutable conflicts, runtime writes, and cross-workspace substitution', async () => {
  const first = await activateCompletionAttempt(obligationSet, 2);
  expect(first).toMatchObject({ disposition: 'accepted', artifactHash: obligationSetHash });
  const duplicate = await activateCompletionAttempt(obligationSet, 2);
  expect(duplicate).toEqual({ ...first, disposition: 'duplicate' });
  const conflictingHash = hash('9');
  await expect(activateCompletionAttempt(CanonicalObligationSetV1Schema.parse({
    ...obligationSet, contentHash: conflictingHash, obligationSetHash: conflictingHash,
  }), 2)).rejects.toThrow(/different immutable content/);
  await expect(runtimePool.query(`INSERT INTO completion_attempts(
      workspace_id,attempt_id,protocol_version,scope_hash,lease_id,fencing_token,runtime_id,
      obligation_set_id,obligation_set_revision,obligation_set_hash,state,writer_fence,retry_maximum,artifact_hash)
    VALUES($1,'attempt:runtime-forged',1,$2,$3,1,$4,$5,1,$6,'pending',1,2,$6)`,
  [workspaceId, hash('a'), leaseId, runtimeId, obligationSetId, obligationSetHash])).rejects.toMatchObject({ code: '42501' });
  await expect(activateCompletionAttempt(CanonicalObligationSetV1Schema.parse({
    ...obligationSet, artifactId: 'artifact:foreign-obligation', scope: { ...scope, workspaceId: foreignWorkspaceId },
  }), 2)).rejects.toThrow(/exact active governed lease/);
  expect((await loadCompletionAttempt(workspaceId, attemptId))?.state).toBe('pending');
});

test('service persists a plan, advances pending through loading to planning, and replays the exact plan idempotently', async () => {
  const first = await persistCompletionTaskPlan(plan);
  expect(first).toMatchObject({ disposition: 'accepted', artifactHash: planHash });
  const duplicate = await persistCompletionTaskPlan(plan);
  expect(duplicate).toEqual({ ...first, disposition: 'duplicate' });
  expect(await loadCurrentCompletionTaskPlan(workspaceId, attemptId)).toEqual(plan);
  expect(await loadCompletionAttempt(workspaceId, attemptId)).toMatchObject({
    state: 'planning', state_version: '3', current_plan_id: planId, current_plan_hash: planHash,
  });
});

function progressEntry(
  sequence: number,
  priorEntryHash: string,
  event: Record<string, unknown>,
  entryType: 'batch_started' | 'validation_recorded' | 'self_review_recorded',
): ProgressLedgerEntryV1 {
  const material: ProgressLedgerEntryHashMaterial = {
    schemaVersion: 'rorca.completion-progress-entry.v1', contractId: 'rorca.completion-progress-entry.v1',
    contractVersion: '1.0.0', artifactId: `artifact:progress:${sequence}`, createdAt,
    createdBy: 'controller:completion-service', scope, sequence,
    priorEntryHash: sequence === 0 ? 'not_applicable' : priorEntryHash,
    writerFence: 1, planId, planRevision: 1, planHash, repositorySha: G, entryType,
    payloadHash: governedHash('rorca.completion-durable-event.v1', event as never), databaseReceiptRefs: [], recordedAt: createdAt,
  };
  const entryHash = completionProgressEntryHash(material);
  return ProgressLedgerEntryV1Schema.parse({ ...material, contentHash: entryHash, entryHash });
}

let ledgerHeadHash: string;

test('DB-first progress persistence reloads canonical event bytes and rolls back entry, receipt, and state on illegal CAS transition', async () => {
  const batchEvent = { type: 'batch_started', batchId: 'batch:completion-service', ordinal: 0 };
  const batch = progressEntry(0, 'not_applicable', batchEvent, 'batch_started');
  expect(await persistCompletionProgressEntry(batch, batchEvent, 3, 'executing'))
    .toMatchObject({ disposition: 'accepted', artifactHash: batch.entryHash });
  expect(await loadCanonicalCompletionProgressRecords(workspaceId, attemptId)).toEqual([{ entry: batch, event: batchEvent }]);

  const forbiddenEvent = { type: 'closeout_submitted_without_gate', rejected: true };
  const forbidden = progressEntry(1, batch.entryHash, forbiddenEvent, 'validation_recorded');
  await expect(persistCompletionProgressEntry(forbidden, forbiddenEvent, 4, 'submitted'))
    .rejects.toMatchObject({ code: '55000' });
  const orphanCounts = await canonicalTransaction(async (client) => {
    await client.query(`SELECT set_config('rorca.workspace_id',$1,TRUE)`, [workspaceId]);
    return (await client.query<{ entries: string; receipts: string }>(`SELECT
      (SELECT COUNT(*)::text FROM completion_progress_entries WHERE workspace_id=$1 AND artifact_hash=$2) entries,
      (SELECT COUNT(*)::text FROM completion_operation_receipts WHERE workspace_id=$1 AND artifact_hash=$2) receipts`,
    [workspaceId, forbidden.entryHash])).rows[0];
  });
  expect(orphanCounts).toEqual({ entries: '0', receipts: '0' });
  expect(await loadCanonicalCompletionProgressRecords(workspaceId, attemptId)).toEqual([{ entry: batch, event: batchEvent }]);
  expect(await loadCompletionAttempt(workspaceId, attemptId)).toMatchObject({
    state: 'executing', state_version: '4', ledger_high_water: '0', ledger_high_water_hash: batch.entryHash,
  });

  const validationEvent = { type: 'validation_recorded', validationHash: hash('a'), resultSha: G };
  const validation = progressEntry(1, batch.entryHash, validationEvent, 'validation_recorded');
  await persistCompletionProgressEntry(validation, validationEvent, 4, 'validating');
  const reviewEvent = { type: 'self_review_recorded', reviewHash: hash('b'), resultSha: G };
  const review = progressEntry(2, validation.entryHash, reviewEvent, 'self_review_recorded');
  await persistCompletionProgressEntry(review, reviewEvent, 5, 'self_reviewing');
  const records = await loadCanonicalCompletionProgressRecords(workspaceId, attemptId);
  expect(records).toEqual([
    { entry: batch, event: batchEvent }, { entry: validation, event: validationEvent }, { entry: review, event: reviewEvent },
  ]);
  ledgerHeadHash = review.entryHash;
});

const proposal = () => ResultProposalV1Schema.parse({
  ...header('rorca.completion-result-proposal.v1', 'artifact:proposal-service', resultProposalHash, runtimeId),
  scope, proposalId: 'proposal:completion-service', proposalRevision: 1, proposalHash: resultProposalHash,
  planId, planRevision: 1, planHash, ledgerHighWaterHash: ledgerHeadHash, baseSha: G, resultSha: G, treeHash: G,
  diffHash: hash('c'), changedPathManifestHash: repository.changedPathManifestHash,
  taskResultManifestHash: hash('d'), criterionResultManifestHash: hash('e'), disposition: 'ready', summaryRef: restrictedRef,
});
function gate(
  decisionId: string,
  decisionHash: string,
  stage: 'controller_preflight' | 'host_semantic',
): CompletionGateDecisionV1 {
  const host = stage === 'host_semantic';
  return CompletionGateDecisionV1Schema.parse({
    ...header('rorca.completion-gate-decision.v1', `artifact:${decisionId}`, decisionHash, 'host:completion-service'),
    scope, decisionId, decisionRevision: 1, decisionHash,
    proposalId: 'proposal:completion-service', proposalRevision: 1, proposalHash: resultProposalHash,
    planId, planRevision: 1, planHash, obligationSetId, obligationSetRevision: 1, obligationSetHash,
    stage, outcome: 'validated', reasonCodes: [],
    failedObligationIds: [], nextAction: host ? 'submit_closeout' : 'none',
    hostEvidenceHash: hash('f'), establishesStoryCompletion: false,
  });
}

let hostGate: CompletionGateDecisionV1;

test('service persists ready proposal followed by controller and host gates without granting completion authority', async () => {
  const resultProposal = proposal();
  expect(await persistCompletionResultProposal(resultProposal)).toMatchObject({ disposition: 'accepted' });
  const controllerGate = gate('decision:controller-preflight', hash('a'), 'controller_preflight');
  expect(await persistCompletionGateDecision(controllerGate)).toMatchObject({ disposition: 'accepted' });
  hostGate = gate('decision:host-semantic', hostGateHash, 'host_semantic');
  expect(await persistCompletionGateDecision(hostGate)).toMatchObject({ disposition: 'accepted' });
  expect(hostGate.establishesStoryCompletion).toBe(false);
  expect(await loadCompletionAttempt(workspaceId, attemptId)).toMatchObject({
    state: 'gate_wait', current_gate_decision_id: hostGate.decisionId, current_gate_decision_hash: hostGateHash,
  });
});

test('service rejects a forged initially-settled continuation before any persistence effect', async () => {
  const directiveHash = hash('9');
  const forged = ContinuationDirectiveV1Schema.parse({
    ...header('rorca.completion-continuation-directive.v1', 'artifact:forged-settled', directiveHash),
    scope, directiveId: 'directive:forged-settled', directiveRevision: 1, directiveHash,
    continuationKey: hash('0'), priorDecisionId: 'decision:controller-preflight',
    priorDecisionRevision: 1, priorDecisionHash: hash('a'), targetPlanId: planId,
    targetPlanRevision: 1, targetPlanHash: planHash, targetBatchId: 'batch:completion-service',
    failedObligationIds: ['obligation:validation'], checkpointId: 'checkpoint:completion-service',
    checkpointHash: hash('b'), receiptId: 'receipt:completion-service', receiptHash: hash('c'),
    bundleId: 'bundle:completion-service', bundleHash: hash('d'), policyActivationHash: scope.policyActivationHash,
    trigger: { type: 'meaningful_retry', previewHash: hash('e'), receiptHash: hash('f'), priorAttempt: 1,
      newAttempt: 2, priorGeneration: 1, newGeneration: 2, failedScopeHash: hash('1'),
      changedSourceVectorHash: hash('2') },
    targetCursor: 1, expectedCursorAdvance: 1, retryBudgetId: 'retry:completion-service',
    retryFence: 1, retrySpent: 0, retryMaximum: 2, authorizationExpiresAt: expiresAt, state: 'settled',
  });
  await expect(persistCompletionContinuationDirective(forged))
    .rejects.toThrow('Continuation directives may only be created in authorized state');
  const count = await canonicalTransaction((client) => client.query<{ count: number }>(
    `SELECT count(*)::int count FROM completion_continuation_directives WHERE workspace_id=$1`, [workspaceId]));
  expect(count.rows[0].count).toBe(0);
});

test('continuation lifecycle is exact dispatch/receipt bound, replay-idempotent, and consumed once', async () => {
  const retryDecisionHash = hash('9');
  const retryDecision = CompletionGateDecisionV1Schema.parse({
    ...hostGate,
    ...header('rorca.completion-gate-decision.v1', 'artifact:decision:retry', retryDecisionHash, 'host:completion-service'),
    decisionId: 'decision:retry', decisionHash: retryDecisionHash, outcome: 'rejected_gate',
    reasonCodes: ['host:retry'], failedObligationIds: ['obligation:validation'],
    nextAction: 'continue_fix',
  });
  await expect(persistCompletionGateDecision(retryDecision)).resolves.toMatchObject({ disposition: 'accepted' });
  const trigger = { type: 'meaningful_retry' as const, previewHash: hash('1'), receiptHash: hash('2'),
    priorAttempt: 1, newAttempt: 2, priorGeneration: 1, newGeneration: 2,
    failedScopeHash: hash('3'), changedSourceVectorHash: hash('4') };
  const material = {
    decision: retryDecision, scope, targetPlanId: planId, targetPlanRevision: 1, targetPlanHash: planHash,
    targetBatchId: 'batch:completion-service', failedObligationIds: retryDecision.failedObligationIds,
    checkpointHash: hash('5'), receiptHash: hash('6'), bundleHash: hash('7'),
    policyActivationHash: scope.policyActivationHash, trigger, targetCursor: 1, expectedCursorAdvance: 1,
    retryBudgetId: 'retry:completion-lifecycle', retryFence: 1, retrySpent: 0, retryMaximum: 2,
  };
  const continuationKey = completionContinuationKey(material);
  expect(continuationKey).not.toBeNull();
  const directiveHash = hash('8');
  const directive = ContinuationDirectiveV1Schema.parse({
    ...header('rorca.completion-continuation-directive.v1', 'artifact:directive:lifecycle', directiveHash),
    scope, directiveId: 'directive:lifecycle', directiveRevision: 1, directiveHash, continuationKey,
    priorDecisionId: retryDecision.decisionId, priorDecisionRevision: 1, priorDecisionHash: retryDecisionHash,
    targetPlanId: planId, targetPlanRevision: 1, targetPlanHash: planHash,
    targetBatchId: material.targetBatchId, failedObligationIds: retryDecision.failedObligationIds,
    checkpointId: 'checkpoint:completion-lifecycle', checkpointHash: material.checkpointHash,
    receiptId: 'receipt:completion-lifecycle', receiptHash: material.receiptHash,
    bundleId: 'bundle:completion-lifecycle', bundleHash: material.bundleHash,
    policyActivationHash: scope.policyActivationHash, trigger, targetCursor: 1, expectedCursorAdvance: 1,
    retryBudgetId: material.retryBudgetId, retryFence: 1, retrySpent: 0, retryMaximum: 2,
    authorizationExpiresAt: expiresAt, state: 'authorized',
  });
  await expect(persistCompletionContinuationDirective(directive)).resolves.toMatchObject({ disposition: 'accepted' });
  await expect(loadCanonicalCompletionContinuationLifecycles(workspaceId, attemptId)).resolves.toEqual([
    expect.objectContaining({
      directive,
      state: 'authorized',
      dispatchId: null,
      dispatchReceiptHash: null,
      consumptionId: null,
    }),
  ]);

  const scopeKey = hash('a');
  const dispatchId = 'dispatch:completion-lifecycle';
  const deliveryKey = hash('b');
  const payloadHash = hash('c');
  const dispatchReceiptHash = hash('d');
  await ownerPool.query(`INSERT INTO context_scope_heads(workspace_id,scope_key) VALUES($1,$2)`, [workspaceId, scopeKey]);
  await ownerPool.query(`INSERT INTO context_checkpoints(
    workspace_id,checkpoint_id,scope_key,checkpoint_sequence,checkpoint_hash,trigger_type,trigger_hash,
    lease_id,fencing_token,activation_hash,state,payload_json)
    VALUES($1,$2,$3,0,$4,'meaningful_retry',$5,$6,1,$7,'current','{}')`,
  [workspaceId, directive.checkpointId, scopeKey, directive.checkpointHash, hash('e'), leaseId, scope.policyActivationHash]);
  await ownerPool.query(`INSERT INTO context_retrieval_receipts(
    workspace_id,receipt_id,retrieval_key,scope_key,checkpoint_id,activation_hash,required_complete,
    status,reason_code,retryable,request_hash,payload_json,finished_at)
    VALUES($1,$2,$3,$4,$5,$6,TRUE,'completed','complete',FALSE,$7,
      '{"tokenAccounting":{"total":0,"required":0,"advisory":0,"instructions":0}}',
      clock_timestamp()+interval '1 second')`,
  [workspaceId, directive.receiptId, hash('f'), scopeKey, directive.checkpointId, scope.policyActivationHash, hash('1')]);
  await ownerPool.query(`INSERT INTO context_bundles(
    workspace_id,bundle_id,bundle_hash,scope_key,checkpoint_id,receipt_id,required_manifest_hash,
    advisory_manifest_hash,serialized_bytes,token_count,expires_at,state,payload_json)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,2,0,clock_timestamp()+interval '1 hour','active',
      '{"requiredContext":[],"advisoryMemory":[],"tokenAccounting":{"total":0,"required":0,"advisory":0,"instructions":0}}')`,
  [workspaceId, directive.bundleId, directive.bundleHash, scopeKey, directive.checkpointId, directive.receiptId, hash('2'), hash('3')]);
  await ownerPool.query(`INSERT INTO continuation_retry_budgets(
    workspace_id,continuation_key,retrieval_max,retrieval_spent,transport_max,transport_spent,retry_fence,
    permanent_conflict_count,state,reason_code,retry_budget_id,scope_key,attempt_id,lease_id,fencing_token,
    activation_hash,checkpoint_hash,bundle_hash,payload_json)
    VALUES($1,$2,2,0,1,0,1,0,'open','available',$3,$4,$5,$6,1,$7,$8,$9,'{}')`,
  [workspaceId, continuationKey, directive.retryBudgetId, scopeKey, attemptId, leaseId,
    scope.policyActivationHash, directive.checkpointHash, directive.bundleHash]);
  await ownerPool.query(`INSERT INTO continuation_dispatches(
    workspace_id,dispatch_id,continuation_key,scope_key,lease_id,fencing_token,checkpoint_id,receipt_id,
    bundle_id,activation_hash,rendered_payload_hash,first_verification_hash,cas_verification_hash,
    authorization_expires_at,state,reason_code,state_version,dispatch_hash,payload_json)
    VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,$9,$10,$11,$12,statement_timestamp()+interval '1 hour',
      'settled','accepted',3,$13,$14::jsonb)`,
  [workspaceId, dispatchId, continuationKey, scopeKey, leaseId, directive.checkpointId, directive.receiptId,
    directive.bundleId, scope.policyActivationHash, payloadHash, hash('4'), hash('5'), hash('6'), JSON.stringify({ scope })]);
  await ownerPool.query(`INSERT INTO continuation_dispatch_consumptions(
    workspace_id,dispatch_id,continuation_key,lease_verification_hash) VALUES($1,$2,$3,$4)`,
  [workspaceId, dispatchId, continuationKey, hash('7')]);
  await ownerPool.query(`INSERT INTO continuation_dispatch_outbox(
    workspace_id,dispatch_id,continuation_key,delivery_key,payload_hash,state,claim_fence,attempt_count,
    transport_receipt_hash,state_version,send_authorization_consumed_at,receiver_acceptance_receipt_hash,
    receiver_accepted_at)
    VALUES($1,$2,$3,$4,$5,'sent',1,1,$6,3,statement_timestamp(),$7,statement_timestamp())`,
  [workspaceId, dispatchId, continuationKey, deliveryKey, payloadHash, hash('8'), dispatchReceiptHash]);
  await ownerPool.query(`ALTER TABLE continuation_dispatch_acceptances DISABLE ROW LEVEL SECURITY`);
  try {
    await ownerPool.query(`INSERT INTO continuation_dispatch_acceptances(
      workspace_id,dispatch_id,claim_fence,send_authorization_hash,delivery_key,payload_hash,receiver_id,
      acceptance_receipt_hash) VALUES($1,$2,1,$3,$4,$5,'receiver:completion',$6)`,
    [workspaceId, dispatchId, hash('9'), deliveryKey, payloadHash, dispatchReceiptHash]);
  } finally {
    await ownerPool.query(`ALTER TABLE continuation_dispatch_acceptances ENABLE ROW LEVEL SECURITY`);
    await ownerPool.query(`ALTER TABLE continuation_dispatch_acceptances FORCE ROW LEVEL SECURITY`);
  }

  const dispatchInput = { workspaceId, attemptId, directiveId: directive.directiveId,
    directiveRevision: 1, directiveHash, continuationKey: continuationKey!, dispatchId, leaseId, fencingToken: 1 };
  await expect(dispatchCompletionContinuationDirective({ ...dispatchInput, fencingToken: 2 }))
    .rejects.toThrow(/durable dispatched row|consumption receipt/);
  await expect(dispatchCompletionContinuationDirective({ ...dispatchInput, continuationKey: hash('0') }))
    .rejects.toThrow(/conflicts with the exact directive/);
  await expect(dispatchCompletionContinuationDirective(dispatchInput)).resolves.toMatchObject({ disposition: 'accepted' });
  await expect(loadCanonicalCompletionContinuationLifecycles(workspaceId, attemptId)).resolves.toEqual([
    expect.objectContaining({ directive, state: 'dispatched', dispatchId, dispatchReceiptHash: null }),
  ]);
  const settlement = { ...dispatchInput, dispatchReceiptHash };
  await expect(settleCompletionContinuationDirective({ ...settlement, dispatchReceiptHash: hash('0') }))
    .rejects.toThrow(/receiver acceptance receipt/);
  await expect(settleCompletionContinuationDirective(settlement)).resolves.toMatchObject({ disposition: 'accepted' });
  await expect(settleCompletionContinuationDirective(settlement)).resolves.toMatchObject({ disposition: 'duplicate' });
  await expect(loadCanonicalCompletionContinuationLifecycles(workspaceId, attemptId)).resolves.toEqual([
    expect.objectContaining({
      directive,
      state: 'settled',
      dispatchId,
      dispatchReceiptHash,
      consumptionId: null,
    }),
  ]);
  const consumption = { ...settlement, consumptionId: 'consumption:completion-lifecycle' };
  await expect(consumeCompletionContinuationDirective({ ...consumption, dispatchReceiptHash: hash('0') }))
    .rejects.toThrow(/receipt-verified settled directive/);
  await expect(consumeCompletionContinuationDirective(consumption)).resolves.toMatchObject({
    disposition: 'accepted', directive: { directiveId: directive.directiveId, continuationKey },
  });
  await expect(loadCanonicalCompletionContinuationLifecycles(workspaceId, attemptId)).resolves.toEqual([
    expect.objectContaining({
      directive,
      state: 'settled',
      dispatchId,
      dispatchReceiptHash,
      consumptionId: consumption.consumptionId,
      consumptionHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      consumedAt: expect.any(String),
    }),
  ]);
  await expect(consumeCompletionContinuationDirective(consumption)).resolves.toMatchObject({ disposition: 'duplicate' });
  await expect(consumeCompletionContinuationDirective({ ...consumption, consumptionId: 'consumption:double' }))
    .rejects.toThrow(/already consumed/);
});

function finalReport(closeoutDecisionId: string, contentHash: string, subjectSha = G) {
  return FinalCompletionReportV1Schema.parse({
    ...header('rorca.completion-final-report.v1', `artifact:report:${contentHash.slice(-8)}`, contentHash, 'host:completion-service'),
    scope: { ...scope, repository: { ...scope.repository, currentSha: subjectSha } },
    reportId: closeoutDecisionId, storyCloseoutDecisionId: closeoutDecisionId,
    storyCloseoutDecisionStatus: 'accepted', gateDecisionId: hostGate.decisionId, gateDecisionHash: hostGate.decisionHash,
    proposalId: 'proposal:completion-service', proposalHash: resultProposalHash,
    obligationSetId, obligationSetHash, finalSha: subjectSha, treeHash: G, diffHash: hash('c'), writerFence: 1,
    fileManifestHash: hash('d'), changeManifestHash: hash('e'),
    validationReceipts: [{ receiptId: 'validation-receipt:completion', receiptHash: hash('f') }],
    evidenceReceipts: [{ receiptId: 'evidence-receipt:completion', receiptHash: hash('a') }],
    taskDispositions: [{ taskId: 'task:completion-service', state: 'settled', resultHash: hash('b') }],
    proposalDisposition: 'ready', exclusionDispositions: [],
    retryDisposition: { retryBudgetId: 'retry-budget:completion', spent: 0, maximum: 2, state: 'not_used' },
    recoveryDisposition: { recoveryHash: hash('c'), state: 'not_required' },
    contextDisposition: { checkpointHash: hash('d'), receiptHash: hash('e'), bundleHash: hash('f'), state: 'current' },
    missingObligationIds: [], conflictingObligationIds: [], risks: [], blockers: [],
    merged: false, deployed: false, productionApproved: false, mergeReady: true,
  });
}

test('service rejects blocked closeout authority and persists only the exact accepted final report', async () => {
  await expect(persistFinalCompletionReport(finalReport(blockedCloseoutDecisionId, hash('9'))))
    .rejects.toThrow(/final completion report rejected|accepted closeout/i);
  const acceptedPayload = { schemaVersion: 'rorca.story-closeout-decision.v1',
    decisionId: acceptedCloseoutDecisionId, status: 'accepted',
    activeSubjectRevision: { commitSha: G, worktreePath: `/tmp/${workspaceId}`, branch: 'main' } };
  await ownerPool.query(`INSERT INTO story_closeout_decisions(
    decision_id,manifest_hash,attempt_result_id,workspace_id,spec_id,run_id,story_id,attempt,status,payload)
    VALUES($1,$2,$3,$4,$5,$6,$7,1,'accepted',$8::jsonb)`,
  [acceptedCloseoutDecisionId, manifestHash, storyAttemptResultId, workspaceId, spec.specId,
    runId, spec.storyId, JSON.stringify(acceptedPayload)]);
  await expect(persistFinalCompletionReport(finalReport(acceptedCloseoutDecisionId, hash('0'), gitSha('b'))))
    .rejects.toThrow(/final completion report rejected|repository revision|immutable closeout lineage/i);
  const accepted = finalReport(acceptedCloseoutDecisionId, finalReportHash);
  expect(await persistFinalCompletionReport(accepted)).toMatchObject({ disposition: 'accepted', artifactHash: finalReportHash });
  expect(await persistFinalCompletionReport(accepted)).toMatchObject({ disposition: 'duplicate', artifactHash: finalReportHash });
});
