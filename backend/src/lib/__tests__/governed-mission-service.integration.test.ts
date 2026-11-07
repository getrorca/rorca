/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
import { Pool, type PoolClient } from 'pg';
import { closePool, pool } from '../../db/index';
import { ConflictError } from '../errors';
import { acknowledgeExecutionCancellation, acceptContinuationDispatchDelivery, acquireExecutionLease, activateContextPolicy as rawActivateContextPolicy, authorizeContinuationDispatch, authorizeContinuationDispatchSend,
  claimContinuationDispatchOutbox, claimContinuationRetry, compileGovernedMission, consumeContinuationDispatch, createWorkPackageRevision,
  evaluateGovernedCloseout, ingestGovernedEvidence, ingestRuntimeEvent, persistContextBundle,
  persistContextBundleDelta, persistContextCheckpoint, persistContinuationRetryBudget, persistRetrievalReceipt,
  publishContextPolicyDefinition as rawPublishContextPolicyDefinition, recordContextEpochRetirementEvaluation, releaseExecutionLease, renewExecutionLease, requestExecutionCancellation,
  reviewPlanChangeProposal, settleContinuationDispatchOutbox, settleContinuationRetry, submitPlanChangeProposal } from '../governed-mission-service';
import { governedHash, RuntimeEventV1Schema } from '../governed-contracts';
import { CONTEXT, EVIDENCE_OBLIGATION_MANIFEST, EVIDENCE_OBLIGATION_MANIFEST_HASH, GOVERNED_PATHS, H, MISSION,
  REPOSITORY, SPEC, WORK_PACKAGE, lease, withMissionIntegrity, withWorkPackageIntegrity } from './governed-test-fixtures';
const H2 = `sha256:${'b'.repeat(64)}`;
const H3 = `sha256:${'c'.repeat(64)}`;
const H4 = `sha256:${'d'.repeat(64)}`;
const H5 = `sha256:${'e'.repeat(64)}`;
const H6 = `sha256:${'6'.repeat(64)}`;
const H7 = `sha256:${'7'.repeat(64)}`;
const H10 = `sha256:${'0'.repeat(64)}`;
const H11 = `sha256:${'1'.repeat(64)}`;
const H12 = `sha256:${'2'.repeat(64)}`;
const H13 = `sha256:${'3'.repeat(64)}`;
type EvidenceLease = { lease_id: string; runtime_id: string; fencing_token: string; current_sha: string; worktree_id: string };
const authorityDatabaseUrl = process.env.WAVE2_TEST_MIGRATION_DATABASE_URL;
if (!authorityDatabaseUrl) throw new Error('WAVE2_TEST_MIGRATION_DATABASE_URL is required');
const authorityPool = new Pool({ connectionString: authorityDatabaseUrl,
  options: '--search_path=rorca,public -c rorca.migration_mode=on -c rorca.workspace_id=workspace:wave-two' });
async function withAuthorityTransaction(action: (client: PoolClient) => Promise<void>) {
  const client = await authorityPool.connect();
  try { await client.query('BEGIN'); await client.query(`SELECT set_config('rorca.workspace_id',$1,TRUE)`, [MISSION.workspaceId]); await action(client); await client.query('COMMIT'); }
  catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
async function publishContextPolicyDefinition(workspaceId: string, policy: Record<string, unknown>, context: Parameters<typeof rawPublishContextPolicyDefinition>[3]) {
  const authorityReceiptId = `receipt:publish:${String(policy.policyDefinitionId)}`;
  await withAuthorityTransaction(async (client) => { await client.query(`INSERT INTO context_policy_authority_receipts
    (workspace_id,authority_receipt_id,operation,authority_ref,artifact_hash,decision_state,provider_human_attestation_hash)
    VALUES($1,$2,'publish',$3,$4,'accepted',$5) ON CONFLICT DO NOTHING`,
  [workspaceId, authorityReceiptId, policy.issuerAuthorityRef, policy.policyDefinitionHash, H]); });
  return rawPublishContextPolicyDefinition(workspaceId, policy, authorityReceiptId, context);
}
async function activateContextPolicy(candidate: Record<string, unknown>, context: Parameters<typeof rawActivateContextPolicy>[1]) {
  const scopeKey = governedHash('rorca.context-policy-activation-scope.v1', candidate.scope as never);
  const authorityReceiptId = `authority:${governedHash('rorca.test-policy-authority.v1', { scopeKey, activationHash: candidate.activationHash as never,
    activationRevision: candidate.activationRevision as never })}`;
  const authorized = { ...candidate, authorityReceiptId };
  await withAuthorityTransaction(async (client) => { await client.query(`INSERT INTO context_policy_authority_receipts
    (workspace_id,authority_receipt_id,operation,authority_ref,artifact_hash,scope_key,decision_state,provider_human_attestation_hash)
    VALUES($1,$2,'activate','provider-human:test-fixture',$3,$4,'accepted',$5) ON CONFLICT DO NOTHING`,
  [candidate.workspaceId, authorityReceiptId, candidate.activationHash, scopeKey, H]); });
  return rawActivateContextPolicy(authorized, context);
}

function withEvidenceIntegrity<T extends Record<string, unknown>>(value: T): T & {contentHash:string;evidenceHash:string} {
  const canonical = governedHash('rorca.evidence-envelope.integrity.v1',
    Object.fromEntries(Object.entries(value).filter(([key]) => !['contentHash', 'evidenceHash'].includes(key))) as never);
  return { ...value, contentHash: canonical, evidenceHash: canonical };
}
function evidenceFor(active: EvidenceLease, overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return withEvidenceIntegrity({ contractVersion: '1.0.0', artifactId: 'evidence-artifact:one', contentHash: H, createdAt: now, createdBy: 'host:one',
    schemaVersion: 'rorca.evidence-envelope.v1', contractId: 'rorca.evidence-envelope.v1', evidenceId: 'evidence:one', evidenceHash: H,
    kind: 'automated-test', trustClass: 'host_observed' as const, observerId: 'host:one', workspaceId: MISSION.workspaceId,
    missionId: MISSION.missionId, missionRevision: 1, workPackageId: WORK_PACKAGE.workPackageId, workPackageRevision: 1,
    specId: SPEC.specId, specVersion: SPEC.specVersion, specHash: SPEC.specHash, storyId: SPEC.storyId,
    storyVersion: SPEC.storyVersion, storyHash: SPEC.storyHash, attemptId: 'attempt:one', leaseId: active.lease_id,
    fencingToken: Number(active.fencing_token), policyActivationId: 'activation:one', policyActivationHash: H, checkpointId: 'checkpoint:one',
    repositoryId: REPOSITORY.repositoryId, repositoryRevision: active.current_sha, worktreeId: active.worktree_id,
    observedAt: now, receivedAt: now, databaseTime: now, status: 'passed' as const, payloadHash: H,
    redactionClass: 'restricted' as const, restrictedRef: { referenceId: 'evidence-ref:one', kind: 'evidence' as const, hash: H,
      sensitivity: 'restricted' as const, retentionClass: 'wave-two-evidence', accessTier: 'admin' as const, rawPayloadIncluded: false as const },
    independentReviewProvenanceHash: null, ...overrides });
}

beforeAll(async () => {
  await withAuthorityTransaction(async (client) => {
    await client.query(`INSERT INTO governed_spec_authority_snapshots
      (workspace_id,spec_id,spec_version,spec_hash,canonical_spec_path,repository_id,repository_sha,approval_receipt_hash,lifecycle_state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'approved')`, [MISSION.workspaceId, SPEC.specId, SPEC.specVersion, SPEC.specHash,
      SPEC.canonicalSpecPath, REPOSITORY.repositoryId, REPOSITORY.baseSha, H]);
    await client.query(`INSERT INTO governed_decision_authority_snapshots(workspace_id,decision_ref,decision_hash,decision_state)
      VALUES($1,'decision:one',$2,'accepted')`, [MISSION.workspaceId, H]);
    await client.query(`INSERT INTO governed_exact_revision_authority_snapshots
      (workspace_id,reference_kind,reference_id,reference_revision,reference_hash,authority_receipt_hash,lifecycle_state,
       maximum_authority_ceiling,sequential_only,branch_only,auto_merge_allowed,deployment_allowed,provider_mutation_allowed)
      VALUES($1,'compiler',$2,$3,$4,$5,'accepted',NULL,NULL,NULL,NULL,NULL,NULL),
            ($1,'mission_policy',$6,$7,$8,$5,'accepted','execute_bounded',TRUE,TRUE,FALSE,FALSE,FALSE),
            ($1,'context_policy_definition',$9,$10,$11,$5,'accepted',NULL,NULL,NULL,NULL,NULL,NULL)`,
    [MISSION.workspaceId,MISSION.compiler.id,MISSION.compiler.revision,MISSION.compiler.hash,H,MISSION.policy.id,
      MISSION.policy.revision,MISSION.policy.hash,MISSION.contextPolicyDefinition.id,MISSION.contextPolicyDefinition.revision,
      MISSION.contextPolicyDefinition.hash]);
    await client.query(`INSERT INTO governed_repository_authority_snapshots
      (workspace_id,repository_id,remote_authority_hash,git_object_format,base_sha,current_sha,expected_head_sha,worktree_id,
       allowed_path_manifest_hash,required_path_manifest_hash,changed_path_manifest_hash,forbidden_path_manifest_hash,authority_receipt_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[MISSION.workspaceId,REPOSITORY.repositoryId,
      REPOSITORY.remoteAuthorityHash,REPOSITORY.gitObjectFormat,REPOSITORY.baseSha,REPOSITORY.currentSha,
      REPOSITORY.expectedHeadSha,REPOSITORY.worktreeId,REPOSITORY.allowedPathManifestHash,REPOSITORY.requiredPathManifestHash,
      REPOSITORY.changedPathManifestHash,REPOSITORY.forbiddenPathManifestHash,H]);
    const manifestHashes={allowed:REPOSITORY.allowedPathManifestHash,required:REPOSITORY.requiredPathManifestHash,
      changed:REPOSITORY.changedPathManifestHash,forbidden:REPOSITORY.forbiddenPathManifestHash};
    for(const [kind,paths] of [['allowed',GOVERNED_PATHS],['required',GOVERNED_PATHS],['changed',[]],['forbidden',[]]] as const){
      await client.query(`INSERT INTO governed_path_manifest_snapshots
        (workspace_id,repository_id,base_sha,manifest_kind,manifest_hash,paths_json,authority_receipt_hash)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`,[MISSION.workspaceId,REPOSITORY.repositoryId,REPOSITORY.baseSha,kind,
        manifestHashes[kind],JSON.stringify(paths),H]);
    }
    await client.query(`INSERT INTO governed_evidence_obligation_sets
      (workspace_id,mission_id,work_package_id,work_package_revision,obligation_set_id,obligation_policy_id,
       obligation_policy_revision,obligation_policy_hash,manifest_hash,manifest_json,authority_receipt_hash)
      VALUES($1,$2,$3,1,'obligation-set:one',$4,$5,$6,$7,$8::jsonb,$9)`,[MISSION.workspaceId,MISSION.missionId,
      WORK_PACKAGE.workPackageId,MISSION.policy.id,MISSION.policy.revision,MISSION.policy.hash,EVIDENCE_OBLIGATION_MANIFEST_HASH,
      JSON.stringify(EVIDENCE_OBLIGATION_MANIFEST),H]);
    await client.query(`INSERT INTO governed_evidence_obligations
      (workspace_id,mission_id,work_package_id,work_package_revision,obligation_set_id,obligation_order,obligation_kind,
       minimum_trust,required_status,obligation_hash)
      VALUES($1,$2,$3,1,'obligation-set:one',0,'automated-test','host_observed','passed',$4)`,
    [MISSION.workspaceId,MISSION.missionId,WORK_PACKAGE.workPackageId,H]);
  });
});

afterAll(async () => { await Promise.all([closePool(), authorityPool.end()]); });

test('mission/work-package writes are immutable, CAS-bound, idempotent, and conflict-audited', async () => {
  const first = await compileGovernedMission(MISSION, null, CONTEXT);
  const duplicate = await compileGovernedMission(MISSION, null, CONTEXT);
  expect(first.duplicate).toBe(false);
  expect(duplicate).toEqual({ ...first, duplicate: true });
  expect((await pool.query(`SELECT ready,reason_code,prerequisite_receipt_hash FROM wave2_effective_readiness`)).rows[0])
    .toEqual(expect.objectContaining({ ready: true, reason_code: 'ready', prerequisite_receipt_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) }));
  await expect(compileGovernedMission(withMissionIntegrity({ ...MISSION, objectivesHash: H2 }), null, CONTEXT)).rejects.toMatchObject({ statusCode: 409 });
  const conflicts = await pool.query(`SELECT reason_code FROM mission_control_replay_conflicts WHERE workspace_id=$1`, [MISSION.workspaceId]);
  expect(conflicts.rows).toEqual([{ reason_code: 'idempotency_payload_conflict' }]);
  const forgedSpecMission = withMissionIntegrity({ ...MISSION, missionId: 'mission:forged-spec', artifactId: 'mission-artifact:forged-spec',
    canonicalSpec: { ...MISSION.canonicalSpec, specId: 'spec:unknown', specHash: H2 } });
  await expect(compileGovernedMission(forgedSpecMission, null, { ...CONTEXT, idempotencyKey: 'idempotency:mission-forged-spec' }))
    .rejects.toMatchObject({ code: 'CONFLICT', details: expect.objectContaining({ reason: 'database_authority_denied' }) });
  const forgedCompilerMission=withMissionIntegrity({...MISSION,missionId:'mission:forged-compiler',artifactId:'mission-artifact:forged-compiler',
    compiler:{...MISSION.compiler,hash:H2}});
  await expect(compileGovernedMission(forgedCompilerMission,null,{...CONTEXT,idempotencyKey:'idempotency:mission-forged-compiler'}))
    .rejects.toMatchObject({code:'CONFLICT',details:expect.objectContaining({reason:'database_authority_denied'})});
  expect(Number((await pool.query(`SELECT count(*) count FROM governed_mission_versions WHERE workspace_id=$1 AND mission_id='mission:forged-spec'`,
    [MISSION.workspaceId])).rows[0].count)).toBe(0);

  const workContext = { ...CONTEXT, idempotencyKey: 'idempotency:work-package' };
  const work = await createWorkPackageRevision(WORK_PACKAGE, null, workContext);
  expect(work.value.revision).toBe(1);
  expect((await createWorkPackageRevision(WORK_PACKAGE, null, workContext)).duplicate).toBe(true);
  await expect(createWorkPackageRevision(withWorkPackageIntegrity({ ...WORK_PACKAGE, workPackageRevision: 2 }), 999,
    { ...CONTEXT, idempotencyKey: 'idempotency:stale-work-package' })).rejects.toMatchObject({code:'CONFLICT'});
  const expandedWorkPackages = [
    withWorkPackageIntegrity({...WORK_PACKAGE,artifactId:'work-package-artifact:current-sha',repository:{...WORK_PACKAGE.repository,currentSha:'c'.repeat(40)}}),
    withWorkPackageIntegrity({...WORK_PACKAGE,artifactId:'work-package-artifact:expected-head',repository:{...WORK_PACKAGE.repository,expectedHeadSha:'c'.repeat(40)}}),
    withWorkPackageIntegrity({...WORK_PACKAGE,artifactId:'work-package-artifact:changed-paths',repository:{...WORK_PACKAGE.repository,changedPathManifestHash:H2}}),
    withWorkPackageIntegrity({...WORK_PACKAGE,artifactId:'work-package-artifact:forbidden-paths',repository:{...WORK_PACKAGE.repository,forbiddenPathManifestHash:H2}}),
    withWorkPackageIntegrity({...WORK_PACKAGE,artifactId:'work-package-artifact:delivery-ceiling',authorityCeilings:{...WORK_PACKAGE.authorityCeilings,delivery:'execute_bounded' as any}}),
    withWorkPackageIntegrity({...WORK_PACKAGE,artifactId:'work-package-artifact:operational-ceiling',authorityCeilings:{...WORK_PACKAGE.authorityCeilings,operational:'execute_bounded' as any}}),
  ];
  for (let index=0;index<expandedWorkPackages.length;index+=1) {
    await expect(createWorkPackageRevision(expandedWorkPackages[index],null,
      {...CONTEXT,idempotencyKey:`idempotency:work-package-expansion:${index}`}))
      .rejects.toMatchObject({statusCode:expect.any(Number)});
  }

  const missionOne = withMissionIntegrity({ ...MISSION, missionId: 'mission:cas', artifactId: 'mission-artifact:cas-one' });
  await compileGovernedMission(missionOne, null, { ...CONTEXT, idempotencyKey: 'idempotency:mission-cas-one' });
  const missionTwo = withMissionIntegrity({ ...missionOne, artifactId: 'mission-artifact:cas-two', missionRevision: 2,
    createdAt: '2026-07-29T00:00:01.000Z', objectivesHash: H2 });
  await compileGovernedMission(missionTwo, 1, { ...CONTEXT, idempotencyKey: 'idempotency:mission-cas-two' });
  expect((await pool.query<{ current_revision: number; state_version: string }>(`SELECT current_revision,state_version
    FROM governed_mission_heads WHERE workspace_id=$1 AND mission_id=$2`, [MISSION.workspaceId, missionOne.missionId])).rows[0])
    .toEqual({ current_revision: 2, state_version: '2' });
  const missionThree = withMissionIntegrity({ ...missionTwo, artifactId: 'mission-artifact:cas-three', missionRevision: 3,
    createdAt: '2026-07-29T00:00:02.000Z', objectivesHash: H3 });
  await expect(compileGovernedMission(missionThree, 1, { ...CONTEXT, idempotencyKey: 'idempotency:mission-cas-stale' }))
    .rejects.toBeInstanceOf(ConflictError);
});

test('direct runtime writes fail before side effects when the durable prerequisite is stale and RLS rejects another workspace', async () => {
  await withAuthorityTransaction(async (client) => { await client.query(`UPDATE wave2_schema_readiness SET state='disabled' WHERE singleton=TRUE`); });
  const before = Number((await pool.query(`SELECT count(*) count FROM continuation_retry_events`)).rows[0].count);
  await expect(claimContinuationRetry({ workspaceId: MISSION.workspaceId, continuationKey: H2, actorAttemptId: 'attempt:none',
    runtimeId: 'runtime:none', owner: 'owner:none', phase: 'retrieval' })).rejects.toMatchObject({ code: 'WAVE2_NOT_READY' });
  expect(Number((await pool.query(`SELECT count(*) count FROM continuation_retry_events`)).rows[0].count)).toBe(before);
  await withAuthorityTransaction(async (client) => { await client.query(`UPDATE wave2_schema_readiness SET state='ready' WHERE singleton=TRUE`); });
  await expect(pool.query(`INSERT INTO governed_missions(workspace_id,mission_id,created_by) VALUES('workspace:other','mission:cross','test')`))
    .rejects.toMatchObject({ code: '42501' });
  await expect(pool.query(`INSERT INTO context_policy_authority_receipts
    (workspace_id,authority_receipt_id,operation,authority_ref,artifact_hash,decision_state,provider_human_attestation_hash)
    VALUES($1,'forged:runtime','publish','forged:runtime',$2,'accepted',$2)`, [MISSION.workspaceId, H]))
    .rejects.toMatchObject({ code: '42501' });
  await expect(pool.query(`INSERT INTO governed_missions(workspace_id,mission_id,created_by)
    VALUES($1,'mission:direct-runtime','runtime:forged')`,[MISSION.workspaceId])).rejects.toMatchObject({code:'42501'});
  await expect(pool.query(`UPDATE governed_mission_heads SET current_hash=$3 WHERE workspace_id=$1 AND mission_id=$2`,
    [MISSION.workspaceId,MISSION.missionId,H])).rejects.toMatchObject({code:'42501'});
  await expect(pool.query(`INSERT INTO context_policy_definitions
    (workspace_id,policy_definition_id,policy_definition_version,policy_definition_hash,lifecycle_state,body_json,issuer_authority_ref)
    VALUES($1,'policy:direct-runtime','1',$2,'published','{}'::jsonb,'authority:forged')`,[MISSION.workspaceId,H]))
    .rejects.toMatchObject({code:'42501'});
  const canonicalRelations=['governed_missions','governed_mission_versions','governed_mission_heads','governed_work_packages',
    'governed_work_package_revisions','governed_work_package_dependencies','governed_work_package_heads','execution_lease_slots',
    'execution_leases','execution_lease_events','context_policy_definitions','context_policy_activations','context_policy_activation_heads',
    'context_scope_heads','context_checkpoints','context_retrieval_receipts','context_retrieval_sources','context_bundles','context_bundle_deltas',
    'continuation_retry_budgets','continuation_retry_events','continuation_quarantines','continuation_dispatches',
    'continuation_dispatch_consumptions','continuation_dispatch_outbox','continuation_dispatch_outcomes','continuation_dispatch_acceptances',
    'continuation_dispatch_receiver_inbox','runtime_event_stream_heads','runtime_events','runtime_event_conflicts','ssdlc_lifecycle_evidence',
    'governed_closeout_evaluations','execution_cancellation_requests','execution_cancellation_acknowledgements','plan_change_proposals',
    'plan_change_proposal_heads','plan_change_proposal_reviews','mission_control_idempotency','mission_control_replay_conflicts',
    'mission_control_audit','context_epoch_retirement_evaluations'];
  const relationPrivileges=await pool.query<{relation_name:string;can_insert:boolean;can_update:boolean;can_delete:boolean}>(`SELECT relation_name,
    has_table_privilege(current_user,'rorca.'||relation_name,'INSERT') can_insert,
    has_table_privilege(current_user,'rorca.'||relation_name,'UPDATE') can_update,
    has_table_privilege(current_user,'rorca.'||relation_name,'DELETE') can_delete
    FROM unnest($1::text[]) relation_name`,[canonicalRelations]);
  expect(relationPrivileges.rows).toHaveLength(canonicalRelations.length);
  expect(relationPrivileges.rows.every(row=>!row.can_insert&&!row.can_update&&!row.can_delete)).toBe(true);
  await expect(pool.query(`INSERT INTO governed_execution_attempts
    (workspace_id,attempt_id,mission_id,work_package_id,work_package_revision,run_id,story_id,runtime_id,generation,manifest_hash,
     repository_id,worktree_id,spec_id,spec_version,spec_hash,story_version,story_hash,criteria_manifest_hash,base_sha,current_sha,
     expected_head_sha,allowed_path_manifest_hash,required_path_manifest_hash,changed_path_manifest_hash,forbidden_path_manifest_hash)
    VALUES($1,'attempt:direct-runtime',$2,$3,1,999,$4,'runtime:forged',1,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [MISSION.workspaceId,MISSION.missionId,WORK_PACKAGE.workPackageId,SPEC.storyId,H,REPOSITORY.repositoryId,REPOSITORY.worktreeId,
      SPEC.specId,SPEC.specVersion,SPEC.specHash,SPEC.storyVersion,SPEC.storyHash,SPEC.criteriaManifestHash,REPOSITORY.baseSha,
      REPOSITORY.currentSha,REPOSITORY.expectedHeadSha,REPOSITORY.allowedPathManifestHash,REPOSITORY.requiredPathManifestHash,
      REPOSITORY.changedPathManifestHash,REPOSITORY.forbiddenPathManifestHash])).rejects.toMatchObject({code:'42501'});

  // Ordinary runtime cannot mint any canonical capability, including for a
  // valid subject, and retains no canonical relation DML privileges.
  const direct = await pool.connect();
  const deniedInFreshTransaction=async(sql:string,params:unknown[]=[]):Promise<void>=>{
    await direct.query('BEGIN');
    try{
      await direct.query(`SELECT set_config('rorca.workspace_id',$1,TRUE)`,[MISSION.workspaceId]);
      await expect(direct.query(sql,params)).rejects.toMatchObject({code:'42501'});
    }finally{await direct.query('ROLLBACK');}
  };
  try {
    await deniedInFreshTransaction(`SELECT authorize_wave2_runtime_mutation_v1($1,'mission.compile',$2,$3,$4::jsonb)`,[
      MISSION.workspaceId,H,H,JSON.stringify({mission:MISSION,expectedStateVersion:1}),
    ]);
    for (const statement of [
      `UPDATE continuation_dispatch_outbox SET state='sent' WHERE workspace_id='workspace:wave-two'`,
      `UPDATE continuation_dispatches SET state='settled' WHERE workspace_id='workspace:wave-two'`,
      `INSERT INTO continuation_dispatch_outcomes DEFAULT VALUES`,
      `UPDATE continuation_retry_budgets SET state='exhausted' WHERE workspace_id='workspace:wave-two'`,
      `INSERT INTO continuation_retry_events DEFAULT VALUES`,
    ])await deniedInFreshTransaction(statement);
  } finally { direct.release(); }
});

test('concurrent lease acquisition has one winner, monotonic fence, exact replay, and DB-time renewal CAS', async () => {
  await withAuthorityTransaction(async(client)=>{await client.query(`INSERT INTO governed_execution_attempts
    (workspace_id,attempt_id,mission_id,work_package_id,work_package_revision,run_id,story_id,runtime_id,generation,manifest_hash,
     repository_id,worktree_id,spec_id,spec_version,spec_hash,story_version,story_hash,criteria_manifest_hash,base_sha,current_sha,
     expected_head_sha,allowed_path_manifest_hash,required_path_manifest_hash,changed_path_manifest_hash,forbidden_path_manifest_hash)
    VALUES($1,'attempt:one',$2,$3,1,1,$4,'runtime:one',1,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
  [MISSION.workspaceId, MISSION.missionId, WORK_PACKAGE.workPackageId, SPEC.storyId, H, REPOSITORY.repositoryId, REPOSITORY.worktreeId,
    SPEC.specId, SPEC.specVersion, SPEC.specHash, SPEC.storyVersion, SPEC.storyHash, SPEC.criteriaManifestHash,
    REPOSITORY.baseSha, REPOSITORY.currentSha, REPOSITORY.expectedHeadSha, REPOSITORY.allowedPathManifestHash,
    REPOSITORY.requiredPathManifestHash, REPOSITORY.changedPathManifestHash, REPOSITORY.forbiddenPathManifestHash]);});
  const firstCandidate = lease('lease:one', 'runtime:one');
  const secondCandidate = lease('lease:two', 'runtime:one');
  const activationScope = { workspaceId: MISSION.workspaceId, missionId: MISSION.missionId, missionRevision: 1, missionHash: MISSION.missionHash,
    workPackageId: WORK_PACKAGE.workPackageId, workPackageRevision: 1, workPackageHash: WORK_PACKAGE.workPackageHash, spec: SPEC, runId: 1,
    attemptId: 'attempt:one', leaseId: firstCandidate.leaseId, fencingToken: 1, cancellationId: 'cancellation:one',
    runtimeId: firstCandidate.runtimeId, repositoryId: REPOSITORY.repositoryId, remoteAuthorityHash: H, baseSha: REPOSITORY.baseSha,
    worktreeId: REPOSITORY.worktreeId, allowedPathManifestHash: H, requiredPathManifestHash: H,
    policyDefinitionId: 'context-policy:one', policyDefinitionVersion: '1.0.0', policyDefinitionHash: H };
  const activationScopeKey = governedHash('rorca.context-policy-activation-scope.v1', activationScope);
  const policyBody = { schemaVersion: 'rorca.context-continuation-policy-definition.v1', contractId: 'rorca.context-continuation-policy-definition.v1',
    contractVersion: '1.0.0', policyDefinitionId: 'context-policy:one', policyDefinitionVersion: '1.0.0', policyDefinitionHash: H,
    issuerAuthorityRef: 'human:one', supportedVersions: ['1.0.0'], triggerRulesHash: H, sourceAllowlistHash: H, redactionPolicyHash: H,
    limits: { totalTokens: 64000, requiredTokens: 48000, advisoryTokens: 8000, instructionTokens: 8000, requiredSources: 500,
      advisoryItems: 50, serializedBytes: 4194304, ttlMinutes: 60, deltaChain: 8, retrievalAttempts: 5, transportReconciliations: 3 },
    lifecycleState: 'published', createdAt: '2026-07-29T00:00:00.000Z', createdBy: 'human:one' };
  await withAuthorityTransaction(async(client)=>{
    await client.query(`INSERT INTO context_policy_definitions
      (workspace_id,policy_definition_id,policy_definition_version,policy_definition_hash,lifecycle_state,body_json,issuer_authority_ref)
      VALUES($1,'context-policy:one','1.0.0',$2,'published',$3::jsonb,'human:one')`, [MISSION.workspaceId, H, JSON.stringify(policyBody)]);
    await client.query(`INSERT INTO context_policy_activations
      (workspace_id,activation_id,activation_revision,activation_hash,policy_definition_id,policy_definition_version,scope_key,scope_json,
       effective_values_hash,authority_receipt_id,state)
      VALUES($1,'activation:one',1,$2,'context-policy:one','1.0.0',$3,$4::jsonb,$2,'authority-receipt:one','active')`,
    [MISSION.workspaceId, H, activationScopeKey, JSON.stringify(activationScope)]);
    await client.query(`INSERT INTO context_policy_activation_heads
      (workspace_id,scope_key,activation_id,current_revision,current_hash,effective_state)
      VALUES($1,$2,'activation:one',1,$3,'active')`, [MISSION.workspaceId, activationScopeKey, H]);
  });
  const settled = await Promise.allSettled([
    acquireExecutionLease(firstCandidate, { ...CONTEXT, idempotencyKey: 'idempotency:lease-one' }),
    acquireExecutionLease(secondCandidate, { ...CONTEXT, idempotencyKey: 'idempotency:lease-two' }),
  ]);
  const fulfilled = settled.filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireExecutionLease>>> => item.status === 'fulfilled');
  const rejected = settled.filter((item) => item.status === 'rejected');
  expect(fulfilled).toHaveLength(1); expect(rejected).toHaveLength(1);
  const winner = fulfilled[0]!.value.value;
  expect(winner.fencingToken).toBe(1);
  const winnerCandidate = winner.leaseId === 'lease:one' ? firstCandidate : secondCandidate;
  const winnerKey = winner.leaseId === 'lease:one' ? 'idempotency:lease-one' : 'idempotency:lease-two';
  expect((await acquireExecutionLease(winnerCandidate, { ...CONTEXT, idempotencyKey: winnerKey })).duplicate).toBe(true);
  const renewed = await renewExecutionLease({ workspaceId: MISSION.workspaceId, leaseId: winner.leaseId, fencingToken: 1,
    runtimeId: winnerCandidate.runtimeId, expectedStateVersion: 1, extendSeconds: 120 },
  { ...CONTEXT, authoritySource: 'runtime_lease', principalId: winnerCandidate.runtimeId, idempotencyKey: 'idempotency:renew-one' });
  expect(renewed.value.stateVersion).toBe(2);
  const lockOrderRace = await Promise.allSettled([
    acquireExecutionLease({ ...lease('lease:lock-order', winnerCandidate.runtimeId), artifactId: 'lease-artifact:lock-order', contentHash: H2 },
      { ...CONTEXT, idempotencyKey: 'idempotency:lease-lock-order' }),
    renewExecutionLease({ workspaceId: MISSION.workspaceId, leaseId: winner.leaseId, fencingToken: 1,
      runtimeId: winnerCandidate.runtimeId, expectedStateVersion: 2, extendSeconds: 120 },
    { ...CONTEXT, authoritySource: 'runtime_lease', principalId: winnerCandidate.runtimeId, idempotencyKey: 'idempotency:renew-lock-order' }),
  ]);
  expect(lockOrderRace.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
  expect(lockOrderRace.filter((item) => item.status === 'rejected')).toHaveLength(1);
  expect(lockOrderRace.filter((item) => item.status === 'rejected')
    .some((item) => String((item as PromiseRejectedResult).reason).includes('deadlock'))).toBe(false);
  await expect(renewExecutionLease({ workspaceId: MISSION.workspaceId, leaseId: winner.leaseId, fencingToken: 1,
    runtimeId: winnerCandidate.runtimeId, expectedStateVersion: 1, extendSeconds: 120 },
  { ...CONTEXT, authoritySource: 'runtime_lease', principalId: winnerCandidate.runtimeId, idempotencyKey: 'idempotency:renew-stale' })).rejects.toBeInstanceOf(ConflictError);
});

test('context lineage persists definition/activation/checkpoint/receipt/bundle/delta and dispatches exactly once', async () => {
  const active = (await pool.query<{ lease_id: string; runtime_id: string; fencing_token: string; expires_at: Date }>(
    `SELECT lease_id,runtime_id,fencing_token,expires_at FROM execution_leases WHERE workspace_id=$1 AND state='active'`, [MISSION.workspaceId])).rows[0]!;
  const now = new Date(); const createdAt = now.toISOString();
  const runtimeContext = { ...CONTEXT, principalId: active.runtime_id, authoritySource: 'runtime_lease' as const };
  const policy = { schemaVersion: 'rorca.context-continuation-policy-definition.v1', contractId: 'rorca.context-continuation-policy-definition.v1',
    contractVersion: '1.0.0', policyDefinitionId: 'context-policy:one', policyDefinitionVersion: '1.0.0', policyDefinitionHash: H,
    issuerAuthorityRef: 'human:one', supportedVersions: ['1.0.0'], triggerRulesHash: H, sourceAllowlistHash: H, redactionPolicyHash: H,
    limits: { totalTokens: 64000, requiredTokens: 48000, advisoryTokens: 8000, instructionTokens: 8000, requiredSources: 500,
      advisoryItems: 50, serializedBytes: 4194304, ttlMinutes: 60, deltaChain: 8, retrievalAttempts: 5, transportReconciliations: 3 },
    lifecycleState: 'published' as const, createdAt, createdBy: 'human:one' };
  expect((await publishContextPolicyDefinition(MISSION.workspaceId, policy, { ...CONTEXT, idempotencyKey: 'idempotency:policy-one' })).value.hash).toBe(H);
  const activationScope = { workspaceId: MISSION.workspaceId, missionId: MISSION.missionId, missionRevision: 1, missionHash: MISSION.missionHash,
    workPackageId: WORK_PACKAGE.workPackageId, workPackageRevision: 1, workPackageHash: WORK_PACKAGE.workPackageHash, spec: SPEC, runId: 1,
    attemptId: 'attempt:one', leaseId: active.lease_id, fencingToken: Number(active.fencing_token), cancellationId: 'cancellation:one',
    runtimeId: active.runtime_id, repositoryId: REPOSITORY.repositoryId, remoteAuthorityHash: H, baseSha: REPOSITORY.baseSha,
    worktreeId: REPOSITORY.worktreeId, allowedPathManifestHash: H, requiredPathManifestHash: H,
    policyDefinitionId: policy.policyDefinitionId, policyDefinitionVersion: policy.policyDefinitionVersion, policyDefinitionHash: H };
  const activation = { contractVersion: '1.0.0', artifactId: 'activation-artifact:one', contentHash: H, createdAt, createdBy: 'human:one',
    schemaVersion: 'rorca.context-continuation-policy-activation.v1', contractId: 'rorca.context-continuation-policy-activation.v1',
    workspaceId: MISSION.workspaceId, activationId: 'activation:one', activationRevision: 1, activationHash: H,
    definitionId: policy.policyDefinitionId, definitionVersion: policy.policyDefinitionVersion, definitionHash: H, scope: activationScope,
    effectiveValuesHash: H, authorityReceiptId: 'authority-receipt:one', activatedAt: createdAt, expiresAt: null, state: 'active' as const };
  await expect(rawActivateContextPolicy(activation, { ...CONTEXT, idempotencyKey: 'idempotency:activation-forged-receipt' }))
    .rejects.toMatchObject({ code: 'CONFLICT', details: expect.objectContaining({ reason: 'database_authority_denied' }) });
  expect((await activateContextPolicy(activation, { ...CONTEXT, idempotencyKey: 'idempotency:activation-one' })).value.hash).toBe(H);
  const scope = { workspaceId: MISSION.workspaceId, missionId: MISSION.missionId, missionRevision: 1, missionHash: MISSION.missionHash,
    workPackageId: WORK_PACKAGE.workPackageId, workPackageRevision: 1, workPackageHash: WORK_PACKAGE.workPackageHash, spec: SPEC, runId: 1,
    attemptId: 'attempt:one', leaseId: active.lease_id, fencingToken: Number(active.fencing_token), cancellationId: 'cancellation:one',
    runtimeId: active.runtime_id, repository: REPOSITORY, leaseExpiresAt: active.expires_at.toISOString(),
    controllerGeneration: 1, runtimeGeneration: 1, sessionId: 'session:context', sessionFileHash: H, turnId: 'turn:context',
    turnAttempt: 1, originatingGeneration: 1, cursor: 0, cursorHash: H, priorEntryId: 'not_applicable' as const,
    validationStateHash: H, rootCauseClassification: 'unknown', rootCauseHash: H,
    policyDefinitionId: policy.policyDefinitionId, policyDefinitionVersion: policy.policyDefinitionVersion, policyDefinitionHash: H,
    policyActivationId: activation.activationId, policyActivationRevision: 1, policyActivationHash: H };
  const trigger = { type: 'initial_dispatch' as const, launchRequestId: 'launch:one', launchRequestHash: H,
    engineRequestId: 'engine:one', engineRequestHash: H, sourceManifestHash: H };
  const checkpoint = { contractVersion: '1.0.0', artifactId: 'checkpoint-artifact:one', contentHash: H, createdAt, createdBy: active.runtime_id,
    schemaVersion: 'rorca.context-checkpoint.v1', contractId: 'rorca.context-checkpoint.v1', scope, checkpointId: 'checkpoint:one',
    checkpointSequence: 0, priorCheckpointId: 'not_applicable' as const, reasonCode: 'initial', trigger, eventHighWaterMark: 0,
    planCursorHash: H, completedWorkHash: H, pendingWorkHash: H, boundedReferences: [], retry: { retryCycleId: 'not_applicable' as const,
      phase: 'none' as const, attempt: 0, maximum: 0, startEventHash: 'not_applicable' as const, endEventHash: 'not_applicable' as const,
      settledEventHash: 'not_applicable' as const, generation: 1 }, completionCandidate: { state: 'absent' as const, hash: 'not_applicable' as const },
    redactionManifestHash: H, state: 'current' as const };
  expect((await persistContextCheckpoint(checkpoint, { ...runtimeContext, idempotencyKey: 'idempotency:checkpoint-one' })).value.sequence).toBe(0);
  const requiredSource = { contextClass: 'required' as const, sourceType: 'git', stableSourceId: 'source:one', sourceVersion: '1',
    contentHash: H, freshness: 'current' as const, excluded: false, redactionHash: H };
  const receipt = { contractVersion: '1.0.0', artifactId: 'receipt-artifact:one', contentHash: H, createdAt, createdBy: active.runtime_id,
    schemaVersion: 'rorca.retrieval-receipt.v1', contractId: 'rorca.retrieval-receipt.v1', scope, requestId: 'retrieval-request:one',
    receiptId: 'receipt:one', checkpointId: checkpoint.checkpointId, definitionHash: H, activationHash: H, retrievalKey: H2,
    sources: [requiredSource], requiredComplete: true, tokenAccounting: { required: 10, advisory: 0, instructions: 2, total: 12 },
    outputId: 'output:one', outputHash: H, startedAt: createdAt, finishedAt: createdAt, status: 'completed' as const,
    reasonCode: 'complete', retryable: false, retryBudgetId: 'retry-budget:one' };
  await expect(persistRetrievalReceipt({ ...receipt, artifactId: 'receipt-artifact:invalid-tokens', receiptId: 'receipt:invalid-tokens',
    tokenAccounting: { ...receipt.tokenAccounting, total: 13 } }, { ...runtimeContext, idempotencyKey: 'idempotency:receipt-invalid-tokens' }))
    .rejects.toThrow('token total mismatch');
  expect((await persistRetrievalReceipt(receipt, { ...runtimeContext, idempotencyKey: 'idempotency:receipt-one' })).value.status).toBe('completed');
  const bundle = { contractVersion: '1.0.0', artifactId: 'bundle-artifact:one', contentHash: H, createdAt, createdBy: active.runtime_id,
    schemaVersion: 'rorca.context-bundle.v1', contractId: 'rorca.context-bundle.v1', scope, bundleId: 'bundle:one', bundleVersion: 1,
    bundleHash: H, checkpointId: checkpoint.checkpointId, checkpointHash: H, receiptId: receipt.receiptId, receiptHash: H,
    definitionHash: H, activationHash: H, requiredContext: [requiredSource], advisoryMemory: [],
    orderedSourceHash: governedHash('rorca.context-bundle-ordered-sources.v1', [requiredSource]),
    redactionManifestHash: governedHash('rorca.context-bundle-redactions.v1', [requiredSource.redactionHash]),
    tokenAllocationHash: governedHash('rorca.context-bundle-token-allocation.v1', receipt.tokenAccounting),
    tokenAccounting: receipt.tokenAccounting, serializedBytes: 1024,
    expiresAt: new Date(Math.min(active.expires_at.getTime(), now.getTime() + 120_000)).toISOString(), state: 'active' as const };
  await expect(persistContextBundle({ ...bundle, artifactId: 'bundle-artifact:forged-advisory', bundleId: 'bundle:forged-advisory',
    advisoryMemory: [{ ...requiredSource, contextClass: 'advisory' as const, stableSourceId: 'source:forged-advisory' }] },
  { ...runtimeContext, idempotencyKey: 'idempotency:bundle-forged-advisory' })).rejects.toMatchObject({ code: 'BUNDLE_CANONICAL_HASH_MISMATCH' });
  expect((await persistContextBundle(bundle, { ...runtimeContext, idempotencyKey: 'idempotency:bundle-one' })).value.state).toBe('active');
  const target = { ...bundle, artifactId: 'bundle-artifact:two', contentHash: H2, bundleId: 'bundle:two', bundleVersion: 2, bundleHash: H2, state: 'verified' as const };
  await persistContextBundle(target, { ...runtimeContext, idempotencyKey: 'idempotency:bundle-two' });
  const operationPaths = ['/artifactId', '/contentHash', '/bundleId', '/bundleVersion', '/bundleHash', '/state'] as const;
  const operations = operationPaths.map((path, index) => ({ index, type: 'replace' as const, path,
    valueHash: governedHash('rorca.context-delta-value.v1', target[path.slice(1) as keyof typeof target]) }));
  const operationListHash = governedHash('rorca.context-delta-operations.v1', operations);
  const targetScopeHash = governedHash('rorca.continuation-scope.v1', scope);
  const verificationReceiptHash = governedHash('rorca.context-delta-verification-receipt.v1', { scopeKey: targetScopeHash,
    baseBundleId: bundle.bundleId, baseBundleHash: bundle.bundleHash, targetBundleId: target.bundleId,
    targetBundleHash: target.bundleHash, operationListHash, chainDepth: 1,
    reconstructionHash: governedHash('rorca.context-delta-reconstruction.v1', target) });
  const delta = { contractVersion: '1.0.0', artifactId: 'delta-artifact:one', contentHash: H, createdAt, createdBy: active.runtime_id,
    schemaVersion: 'rorca.context-bundle-delta.v1', contractId: 'rorca.context-bundle-delta.v1', scope, deltaId: 'delta:one',
    baseBundleId: bundle.bundleId, baseBundleHash: H, targetBundleId: target.bundleId, targetScopeHash,
    operations, operationListHash, reconstructedTargetHash: H2, chainDepth: 1, verificationReceiptHash,
    state: 'verified' as const, fallbackReason: null };
  expect((await persistContextBundleDelta(delta, { ...runtimeContext, idempotencyKey: 'idempotency:delta-one' })).value.mode).toBe('delta');
  expect((await persistContextBundleDelta({ ...delta, artifactId: 'delta-artifact:fallback', deltaId: 'delta:fallback', baseBundleHash: H3 },
    { ...runtimeContext, idempotencyKey: 'idempotency:delta-fallback' })).value)
    .toEqual(expect.objectContaining({ mode: 'full', reason: 'base_corrupt', fullBundleRequired: true }));
  const budget = { schemaVersion: 'rorca.continuation-retry-budget.v1', workspaceId: MISSION.workspaceId,
    retryBudgetId: 'retry-budget:one', continuationKey: H2, scope, checkpointHash: H, bundleHash: H,
    retrievalMaximum: 2, retrievalSpent: 0, transportMaximum: 1, transportSpent: 0, inFlightOwner: null, retryFence: 0,
    retryExpiresAt: null, nextRetryAt: null, permanentConflictCount: 0, state: 'open' as const, reasonCode: 'available' };
  await persistContinuationRetryBudget(budget, { ...CONTEXT, idempotencyKey: 'idempotency:budget-one' });
  const dispatch = { contractVersion: '1.0.0', artifactId: 'dispatch-artifact:one', contentHash: H, createdAt, createdBy: active.runtime_id,
    schemaVersion: 'rorca.continuation-dispatch.v1', contractId: 'rorca.continuation-dispatch.v1', scope, dispatchId: 'dispatch:one',
    continuationKey: H2, trigger, checkpointId: checkpoint.checkpointId, checkpointHash: H, receiptId: receipt.receiptId,
    receiptHash: H, bundleId: bundle.bundleId, bundleHash: H, definitionHash: H, activationHash: H,
    targetSessionId: scope.sessionId, targetCursor: 1, priorEntryId: 'not_applicable' as const, expectedCursorAdvance: 1,
    renderedPayloadHash: H, renderedPayloadRef: { referenceId: 'rendered:one', kind: 'context' as const, hash: H,
      sensitivity: 'restricted' as const, retentionClass: 'continuation', accessTier: 'admin' as const, rawPayloadIncluded: false as const },
    firstLeaseVerificationHash: H, casLeaseVerificationHash: H,
    authorizationExpiresAt: new Date(Math.min(active.expires_at.getTime(), now.getTime() + 60_000)).toISOString(),
    controllerId: 'controller:one', adapterVersion: '1.0.0', attempt: 1, retryBudgetId: 'retry-budget:one',
    state: 'lease_verified' as const, reasonCode: 'verified' };
  await expect(authorizeContinuationDispatch({ ...dispatch, artifactId: 'dispatch-artifact:forged-receipt',
    dispatchId: 'dispatch:forged-receipt', receiptHash: H2 }, { ...runtimeContext,
    idempotencyKey: 'idempotency:dispatch-forged-receipt' })).rejects.toMatchObject({ code: 'CONFLICT' });
  const authorized = await authorizeContinuationDispatch(dispatch, { ...runtimeContext, idempotencyKey: 'idempotency:dispatch-authorize' });
  expect(authorized.value.state).toBe('authorized');
  const consumption = { workspaceId: MISSION.workspaceId, dispatchId: dispatch.dispatchId, continuationKey: H2,
    leaseId: active.lease_id, fencingToken: Number(active.fencing_token), runtimeId: active.runtime_id };
  expect(await consumeContinuationDispatch(consumption, { ...runtimeContext, idempotencyKey: 'idempotency:dispatch-consume' }))
    .toEqual({ consumed: true, duplicate: false, outboxState: 'pending' });
  const firstClaim = await claimContinuationDispatchOutbox({ workspaceId: MISSION.workspaceId, dispatchId: dispatch.dispatchId,
    owner: 'transport:one', claimSeconds: 30 });
  expect(firstClaim).toEqual(expect.objectContaining({ claimed: true, claimFence: 1, deliveryKey: H2 }));
  await withAuthorityTransaction(async(client)=>{await client.query(`UPDATE continuation_dispatch_outbox
    SET claim_expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND dispatch_id=$2`,
  [MISSION.workspaceId,dispatch.dispatchId]);});
  const recovered = await claimContinuationDispatchOutbox({ workspaceId: MISSION.workspaceId, dispatchId: dispatch.dispatchId,
    owner: 'transport:recovery', claimSeconds: 30 });
  expect(recovered).toEqual(expect.objectContaining({ claimed: true, claimFence: 2, deliveryKey: H2 }));
  await expect(settleContinuationDispatchOutbox({ workspaceId: MISSION.workspaceId, dispatchId: dispatch.dispatchId,
    owner: 'transport:one', claimFence: 1, sendAuthorizationHash: H2, receiverAcceptanceReceiptHash: null,
    outcome: 'sent', transportAccepted: true, transportReceiptHash: H, reasonCode: 'sent' })).rejects.toMatchObject({ code: 'CONFLICT' });
  const sendAuthority = await authorizeContinuationDispatchSend({ workspaceId: MISSION.workspaceId, dispatchId: dispatch.dispatchId,
    owner: 'transport:recovery', claimFence: 2, deliveryKey: recovered.deliveryKey, payloadHash: recovered.payloadHash });
  await withAuthorityTransaction(async(client)=>{await client.query(`UPDATE execution_leases SET state='cancelled'
    WHERE workspace_id=$1 AND lease_id=$2`,[MISSION.workspaceId,active.lease_id]);});
  await expect(acceptContinuationDispatchDelivery({workspaceId:MISSION.workspaceId,dispatchId:dispatch.dispatchId,
    owner:'transport:recovery',claimFence:2,sendAuthorizationHash:sendAuthority.sendAuthorizationHash,
    deliveryKey:recovered.deliveryKey,payloadHash:recovered.payloadHash,payload:sendAuthority.payload},'rorca-dispatch-receiver'))
    .rejects.toMatchObject({details:expect.objectContaining({reason:'authority_revoked_before_acceptance'})});
  await withAuthorityTransaction(async(client)=>{await client.query(`UPDATE execution_leases SET state='active'
    WHERE workspace_id=$1 AND lease_id=$2`,[MISSION.workspaceId,active.lease_id]);});
  await withAuthorityTransaction(async(client)=>{await client.query(`UPDATE context_policy_activation_heads SET effective_state='revoked'
    WHERE workspace_id=$1 AND current_hash=$2`,[MISSION.workspaceId,H]);});
  await expect(acceptContinuationDispatchDelivery({workspaceId:MISSION.workspaceId,dispatchId:dispatch.dispatchId,
    owner:'transport:recovery',claimFence:2,sendAuthorizationHash:sendAuthority.sendAuthorizationHash,
    deliveryKey:recovered.deliveryKey,payloadHash:recovered.payloadHash,payload:sendAuthority.payload},'rorca-dispatch-receiver'))
    .rejects.toMatchObject({details:expect.objectContaining({reason:'authority_revoked_before_acceptance'})});
  await withAuthorityTransaction(async(client)=>{await client.query(`UPDATE context_policy_activation_heads SET effective_state='active'
    WHERE workspace_id=$1 AND current_hash=$2`,[MISSION.workspaceId,H]);});
  await expect(acceptContinuationDispatchDelivery({workspaceId:MISSION.workspaceId,dispatchId:dispatch.dispatchId,
    owner:'transport:recovery',claimFence:2,sendAuthorizationHash:sendAuthority.sendAuthorizationHash,
    deliveryKey:recovered.deliveryKey,payloadHash:recovered.payloadHash,payload:{...sendAuthority.payload,bundleId:'bundle:substituted'}},
  'rorca-dispatch-receiver')).rejects.toMatchObject({details:expect.objectContaining({reason:'payload_hash_mismatch'})});
  const receiverAcceptance = await acceptContinuationDispatchDelivery({ workspaceId:MISSION.workspaceId,dispatchId:dispatch.dispatchId,
    owner:'transport:recovery',claimFence:2,sendAuthorizationHash:sendAuthority.sendAuthorizationHash,
    deliveryKey:recovered.deliveryKey,payloadHash:recovered.payloadHash,payload:sendAuthority.payload },'rorca-dispatch-receiver');
  expect(receiverAcceptance).toEqual(expect.objectContaining({accepted:true,duplicate:false,acceptanceReceiptHash:expect.stringMatching(/^sha256:/)}));
  const receiverInbox=(await authorityPool.query<{payload_bytes:Buffer;payload_bytes_hash:string;payload_size:number;state:string}>(`SELECT
    payload_bytes,payload_bytes_hash,payload_size,state FROM continuation_dispatch_receiver_inbox
    WHERE workspace_id=$1 AND dispatch_id=$2`,[MISSION.workspaceId,dispatch.dispatchId])).rows[0]!;
  const expectedReceiverBytes=Buffer.from(JSON.stringify(sendAuthority.payload),'utf8');
  expect(receiverInbox).toEqual({payload_bytes:expectedReceiverBytes,
    payload_bytes_hash:`sha256:${(await import('node:crypto')).createHash('sha256').update(expectedReceiverBytes).digest('hex')}`,
    payload_size:expectedReceiverBytes.length,state:'accepted'});
  expect(await acceptContinuationDispatchDelivery({ workspaceId:MISSION.workspaceId,dispatchId:dispatch.dispatchId,
    owner:'transport:recovery',claimFence:2,sendAuthorizationHash:sendAuthority.sendAuthorizationHash,
    deliveryKey:recovered.deliveryKey,payloadHash:recovered.payloadHash,payload:sendAuthority.payload },'rorca-dispatch-receiver'))
    .toEqual(expect.objectContaining({accepted:true,duplicate:true,acceptanceReceiptHash:receiverAcceptance.acceptanceReceiptHash}));
  const settledDispatch = await settleContinuationDispatchOutbox({ workspaceId: MISSION.workspaceId, dispatchId: dispatch.dispatchId,
    owner: 'transport:recovery', claimFence: 2, sendAuthorizationHash: sendAuthority.sendAuthorizationHash,
    receiverAcceptanceReceiptHash:receiverAcceptance.acceptanceReceiptHash,outcome: 'sent', transportAccepted: true,
    transportReceiptHash: H, reasonCode: 'sent' });
  expect(settledDispatch).toEqual(expect.objectContaining({ state: 'sent', retryable: false }));
  expect(await claimContinuationDispatchOutbox({ workspaceId: MISSION.workspaceId, dispatchId: dispatch.dispatchId,
    owner: 'transport:late', claimSeconds: 30 })).toEqual(expect.objectContaining({ claimed: false, duplicate: true, state: 'sent' }));
  expect(await consumeContinuationDispatch(consumption, { ...runtimeContext, idempotencyKey: 'idempotency:dispatch-consume-replay' }))
    .toEqual({ consumed: true, duplicate: true, outboxState: 'sent' });
});

test('matching failed evidence under a required-failed PostgreSQL obligation is terminal failed, never eligible',async()=>{
  const failedActivationHashes=[`sha256:${'f'.repeat(64)}`,`sha256:${'4'.repeat(64)}`,`sha256:${'5'.repeat(64)}`] as const;
  const requiredFailedManifest=[{kind:'automated-test',minimumTrust:'host_observed',requiredStatus:'failed',obligationHash:H13}];
  const requiredFailedManifestHash=governedHash('rorca.evidence-obligation-manifest.v1',requiredFailedManifest);
  const failedMission=withMissionIntegrity({...MISSION,artifactId:'mission-artifact:required-failed',missionId:'mission:required-failed',
    objectivesHash:H13,evidenceObligationsHash:requiredFailedManifestHash});
  await compileGovernedMission(failedMission,null,{...CONTEXT,idempotencyKey:'idempotency:mission-required-failed'});
  const failedWorkPackage=withWorkPackageIntegrity({...WORK_PACKAGE,artifactId:'work-package-artifact:required-failed',
    missionId:failedMission.missionId,missionHash:failedMission.missionHash,workPackageId:'work-package:required-failed',
    evidenceObligationsHash:requiredFailedManifestHash});
  await withAuthorityTransaction(async(client)=>{
    await client.query(`INSERT INTO governed_evidence_obligation_sets
      (workspace_id,mission_id,work_package_id,work_package_revision,obligation_set_id,obligation_policy_id,
       obligation_policy_revision,obligation_policy_hash,manifest_hash,manifest_json,authority_receipt_hash)
      VALUES($1,$2,$3,1,'obligation-set:required-failed',$4,$5,$6,$7,$8::jsonb,$9)`,[MISSION.workspaceId,
      failedMission.missionId,failedWorkPackage.workPackageId,MISSION.policy.id,MISSION.policy.revision,MISSION.policy.hash,
      requiredFailedManifestHash,JSON.stringify(requiredFailedManifest),H]);
    await client.query(`INSERT INTO governed_evidence_obligations
      (workspace_id,mission_id,work_package_id,work_package_revision,obligation_set_id,obligation_order,obligation_kind,
       minimum_trust,required_status,obligation_hash)
      VALUES($1,$2,$3,1,'obligation-set:required-failed',0,'automated-test','host_observed','failed',$4)`,
    [MISSION.workspaceId,failedMission.missionId,failedWorkPackage.workPackageId,H13]);
  });
  await createWorkPackageRevision(failedWorkPackage,null,{...CONTEXT,idempotencyKey:'idempotency:work-package-required-failed'});
  await withAuthorityTransaction(async(client)=>{await client.query(`INSERT INTO governed_execution_attempts
    (workspace_id,attempt_id,mission_id,work_package_id,work_package_revision,run_id,story_id,runtime_id,generation,manifest_hash,
     repository_id,worktree_id,spec_id,spec_version,spec_hash,story_version,story_hash,criteria_manifest_hash,base_sha,current_sha,
     expected_head_sha,allowed_path_manifest_hash,required_path_manifest_hash,changed_path_manifest_hash,forbidden_path_manifest_hash)
    VALUES($1,'attempt:required-failed',$2,$3,1,2002,$4,'runtime:required-failed',1,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
  [MISSION.workspaceId,failedMission.missionId,failedWorkPackage.workPackageId,SPEC.storyId,H,REPOSITORY.repositoryId,
    REPOSITORY.worktreeId,SPEC.specId,SPEC.specVersion,SPEC.specHash,SPEC.storyVersion,SPEC.storyHash,SPEC.criteriaManifestHash,
    REPOSITORY.baseSha,REPOSITORY.currentSha,REPOSITORY.expectedHeadSha,REPOSITORY.allowedPathManifestHash,
    REPOSITORY.requiredPathManifestHash,REPOSITORY.changedPathManifestHash,REPOSITORY.forbiddenPathManifestHash]);});
  const failedLeaseId='lease:required-failed';
  const failedActivationScope={workspaceId:MISSION.workspaceId,missionId:failedMission.missionId,missionRevision:1,
    missionHash:failedMission.missionHash,workPackageId:failedWorkPackage.workPackageId,workPackageRevision:1,
    workPackageHash:failedWorkPackage.workPackageHash,spec:SPEC,runId:2002,attemptId:'attempt:required-failed',leaseId:failedLeaseId,
    fencingToken:1,cancellationId:'cancellation:required-failed',runtimeId:'runtime:required-failed',repositoryId:REPOSITORY.repositoryId,
    remoteAuthorityHash:H,baseSha:REPOSITORY.baseSha,worktreeId:REPOSITORY.worktreeId,allowedPathManifestHash:H,
    requiredPathManifestHash:H,policyDefinitionId:'context-policy:one',policyDefinitionVersion:'1.0.0',policyDefinitionHash:H};
  const failedActivationBase={contractVersion:'1.0.0',artifactId:'activation-artifact:required-failed-proposed',contentHash:failedActivationHashes[0],
    createdAt:new Date().toISOString(),createdBy:'human:one',schemaVersion:'rorca.context-continuation-policy-activation.v1',
    contractId:'rorca.context-continuation-policy-activation.v1',workspaceId:MISSION.workspaceId,
    activationId:'activation:required-failed',activationRevision:1,activationHash:failedActivationHashes[0],definitionId:'context-policy:one',
    definitionVersion:'1.0.0',definitionHash:H,scope:failedActivationScope,effectiveValuesHash:failedActivationHashes[0],
    authorityReceiptId:'authority-receipt:required-failed-proposed',activatedAt:new Date().toISOString(),expiresAt:null,state:'proposed' as const};
  await activateContextPolicy(failedActivationBase,{...CONTEXT,idempotencyKey:'idempotency:activation-required-failed-proposed'});
  await activateContextPolicy({...failedActivationBase,artifactId:'activation-artifact:required-failed-verified',contentHash:failedActivationHashes[1],
    activationRevision:2,activationHash:failedActivationHashes[1],effectiveValuesHash:failedActivationHashes[1],state:'verified' as const},
  {...CONTEXT,idempotencyKey:'idempotency:activation-required-failed-verified'});
  const failedActivation={...failedActivationBase,artifactId:'activation-artifact:required-failed-active',contentHash:failedActivationHashes[2],
    activationRevision:3,activationHash:failedActivationHashes[2],effectiveValuesHash:failedActivationHashes[2],state:'active' as const};
  await activateContextPolicy(failedActivation,{...CONTEXT,idempotencyKey:'idempotency:activation-required-failed-active'});
  const failedLease={...lease(failedLeaseId,'runtime:required-failed'),artifactId:'lease-artifact:required-failed',contentHash:H13,
    missionId:failedMission.missionId,missionHash:failedMission.missionHash,workPackageId:failedWorkPackage.workPackageId,
    workPackageHash:failedWorkPackage.workPackageHash,attemptId:'attempt:required-failed',runId:2002,
    policyActivationId:failedActivation.activationId,policyActivationRevision:failedActivation.activationRevision,
    policyActivationHash:failedActivation.activationHash,checkpointId:'checkpoint:required-failed',checkpointHash:H,
    cancellationId:'cancellation:required-failed',evidenceObligationDigest:requiredFailedManifestHash};
  const active=(await acquireExecutionLease(failedLease,{...CONTEXT,idempotencyKey:'idempotency:lease-required-failed'})).value;
  await withAuthorityTransaction(async(client)=>{
    await client.query(`INSERT INTO context_scope_heads(workspace_id,scope_key,checkpoint_id,checkpoint_sequence)
      VALUES($1,$2,'checkpoint:required-failed',0)`,[MISSION.workspaceId,H13]);
    await client.query(`INSERT INTO context_checkpoints
      (workspace_id,checkpoint_id,scope_key,checkpoint_sequence,checkpoint_hash,trigger_type,trigger_hash,lease_id,
       fencing_token,activation_hash,state,payload_json)
      VALUES($1,'checkpoint:required-failed',$2,0,$3,'test-fixture',$3,$4,$5,$6,'current','{}')`,
    [MISSION.workspaceId,H13,H,active.leaseId,active.fencingToken,failedActivation.activationHash]);
  });
  const observedAt=new Date().toISOString();
  const failedEvidence=evidenceFor({lease_id:active.leaseId,runtime_id:'runtime:required-failed',fencing_token:String(active.fencingToken),
    current_sha:REPOSITORY.currentSha,worktree_id:REPOSITORY.worktreeId},{artifactId:'evidence-artifact:required-failed',
    evidenceId:'evidence:required-failed',missionId:failedMission.missionId,workPackageId:failedWorkPackage.workPackageId,
    attemptId:'attempt:required-failed',leaseId:active.leaseId,fencingToken:active.fencingToken,
    policyActivationId:failedActivation.activationId,policyActivationHash:failedActivation.activationHash,
    checkpointId:'checkpoint:required-failed',status:'failed',
    createdAt:observedAt,observedAt,receivedAt:observedAt,databaseTime:observedAt});
  const ingested=await ingestGovernedEvidence(failedEvidence,{id:'host:one',maximumTrust:'host_observed'});
  const result=await evaluateGovernedCloseout({contractVersion:'1.0.0',artifactId:'evaluation-artifact:required-failed',
    contentHash:H13,createdAt:observedAt,createdBy:'resolver:one',schemaVersion:'rorca.closeout-evaluation.v1',
    contractId:'rorca.closeout-evaluation.v1',evaluationId:'evaluation:required-failed',workspaceId:MISSION.workspaceId,
    missionId:failedMission.missionId,missionRevision:1,workPackageId:failedWorkPackage.workPackageId,workPackageRevision:1,
    specHash:SPEC.specHash,storyHash:SPEC.storyHash,attemptId:'attempt:required-failed',leaseId:active.leaseId,
    fencingToken:active.fencingToken,policyActivationHash:failedActivation.activationHash,checkpointHash:H,
    repositoryRevision:REPOSITORY.currentSha,worktreeId:REPOSITORY.worktreeId,
    evidence:[{evidenceId:failedEvidence.evidenceId,evidenceHash:ingested.evidenceHash}],
    obligationSetId:'obligation-set:required-failed',obligationSetHash:requiredFailedManifestHash,
    policyVersion:String(MISSION.policy.revision),resolverVersion:'1.0.0',outcome:'failed' as const,missingEvidenceKinds:[],
    conflictingEvidenceIds:[],decisionTime:observedAt,storyCloseoutDecisionId:null,establishesStoryCompletion:false as const},
  {...CONTEXT,principalId:'resolver:one',idempotencyKey:'idempotency:closeout-required-failed'});
  expect(result.value).toEqual(expect.objectContaining({outcome:'failed',missingEvidenceIds:[],conflictingEvidenceIds:[]}));
  expect((await pool.query<{outcome:string}>(`SELECT outcome FROM governed_closeout_evaluations
    WHERE workspace_id=$1 AND evaluation_id='evaluation:required-failed'`,[MISSION.workspaceId])).rows).toEqual([{outcome:'failed'}]);
  await releaseExecutionLease({workspaceId:MISSION.workspaceId,leaseId:active.leaseId,fencingToken:active.fencingToken,
    runtimeId:'runtime:required-failed',expectedStateVersion:1,reasonCode:'required_failed_fixture_complete'},
  {...CONTEXT,principalId:'runtime:required-failed',authoritySource:'runtime_lease',idempotencyKey:'idempotency:release-required-failed'});
});

test('retirement evaluation resolves durable evidence and dispatch projection material is exact', async () => {
  const kinds = ['migration_fixtures', 'rollback_fixtures', 'break_markers', 'release_notes', 'next_major_declaration'] as const;
  const hashes = [H, H2, H3, H4, H5];
  for (let index = 0; index < kinds.length; index += 1) await pool.query(`INSERT INTO context_epoch_retirement_evidence
    (workspace_id,evidence_hash,evidence_kind,status,source_ref,trust_level,observed_at)
    VALUES($1,$2,$3,'passed',$4,'host_observed',clock_timestamp())`,
  [MISSION.workspaceId, hashes[index], kinds[index], `fixture:${kinds[index]}`]);
  await pool.query(`INSERT INTO context_epoch_retirement_review_decisions
    (workspace_id,review_receipt_id,evidence_hash,accepted,reviewer_authority_ref,reviewed_at)
    VALUES($1,'review-receipt:one',$2,TRUE,'reviewer:one',clock_timestamp())`, [MISSION.workspaceId, H]);
  await withAuthorityTransaction(async (client) => { await client.query(`INSERT INTO context_contract_release_history(contract_version,release_sha,write_current,released_at,contract_hash)
    VALUES('1.1.0',$1,TRUE,clock_timestamp()-interval '100 days',$2),
          ('1.2.0',$1,FALSE,clock_timestamp()-interval '95 days',$2)`, ['a'.repeat(40), H]); });
  const evidence = { migrationFixtureEvidenceHash: H, rollbackFixtureEvidenceHash: H2, breakMarkerEvidenceHash: H3,
    releaseNotesHash: H4, nextMajorDeclarationHash: H5, independentReviewReceiptId: 'review-receipt:one',
    independentReviewEvidenceHash: H };
  const evaluation = await recordContextEpochRetirementEvaluation({ workspaceId: MISSION.workspaceId,
    evaluationId: 'epoch-retirement:one', nextMajorVersion: '2.0.0', evidence },
  { ...CONTEXT, idempotencyKey: 'idempotency:epoch-retirement-one' });
  expect(evaluation.value).toEqual(expect.objectContaining({ eligible: true, failedReasons: [] }));
  const unsupported = await recordContextEpochRetirementEvaluation({ workspaceId: MISSION.workspaceId,
    evaluationId: 'epoch-retirement:unbound', nextMajorVersion: '2.0.0', evidence: { ...evidence,
      migrationFixtureEvidenceHash: `sha256:${'f'.repeat(64)}` } }, { ...CONTEXT, idempotencyKey: 'idempotency:epoch-retirement-unbound' });
  expect(unsupported.value).toEqual(expect.objectContaining({ eligible: false }));
  const dispatch = (await pool.query<{ dispatch_hash: string; payload_json: unknown }>(`SELECT dispatch_hash,payload_json
    FROM continuation_dispatches WHERE workspace_id=$1 AND dispatch_id='dispatch:one'`, [MISSION.workspaceId])).rows[0]!;
  expect(dispatch.dispatch_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect((dispatch.payload_json as { dispatchId: string }).dispatchId).toBe('dispatch:one');
});

test('retry budget serializes both phases, settles/backoffs, preserves permanent conflicts, and quarantines exhaustion', async () => {
  const claims = await Promise.all([
    claimContinuationRetry({ workspaceId: MISSION.workspaceId, continuationKey: H2, actorAttemptId: 'attempt:one', runtimeId: 'runtime:one', owner: 'owner:one', phase: 'retrieval' }),
    claimContinuationRetry({ workspaceId: MISSION.workspaceId, continuationKey: H2, actorAttemptId: 'attempt:one', runtimeId: 'runtime:one', owner: 'owner:two', phase: 'retrieval' }),
  ]);
  expect(claims.filter((item) => item.claimed)).toHaveLength(1);
  const winnerIndex = claims.findIndex((item) => item.claimed); const winnerOwner = winnerIndex === 0 ? 'owner:one' : 'owner:two';
  const winner = claims[winnerIndex]!;
  const before = (await pool.query<{ retrieval_spent: number }>(`SELECT retrieval_spent FROM continuation_retry_budgets WHERE workspace_id=$1 AND continuation_key=$2`, [MISSION.workspaceId, H2])).rows[0]!.retrieval_spent;
  const permanent = await claimContinuationRetry({ workspaceId: MISSION.workspaceId, continuationKey: H2, actorAttemptId: 'attempt:one',
    runtimeId: 'runtime:one', owner: 'owner:three', phase: 'retrieval', failureReason: 'hash_mismatch' });
  expect(permanent).toEqual(expect.objectContaining({ claimed: false, state: 'permanent_conflict', retrySpent: before }));
  expect(await settleContinuationRetry({ workspaceId: MISSION.workspaceId, continuationKey: H2, runtimeId: 'runtime:one', owner: winnerOwner,
    retryFence: winner.retryFence, phase: 'retrieval', outcome: 'retryable_failed', reasonCode: 'temporary_outage', backoffSeconds: 30 }))
    .toEqual(expect.objectContaining({ state: 'backoff', retryable: true }));
  expect(await claimContinuationRetry({ workspaceId: MISSION.workspaceId, continuationKey: H2, actorAttemptId: 'attempt:one',
    runtimeId: 'runtime:one', owner: 'owner:backoff', phase: 'retrieval' })).toEqual(expect.objectContaining({ claimed: false, state: 'backoff' }));
  await withAuthorityTransaction(async(client)=>{await client.query(`UPDATE continuation_retry_budgets
    SET next_retry_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND continuation_key=$2`,[MISSION.workspaceId,H2]);});
  const transport = await claimContinuationRetry({ workspaceId: MISSION.workspaceId, continuationKey: H2, actorAttemptId: 'attempt:one',
    runtimeId: 'runtime:one', owner: 'owner:transport', phase: 'transport' });
  expect(transport).toEqual(expect.objectContaining({ claimed: true, retrySpent: 1 }));
  expect(await settleContinuationRetry({ workspaceId: MISSION.workspaceId, continuationKey: H2, runtimeId: 'runtime:one', owner: 'owner:transport',
    retryFence: transport.retryFence, phase: 'transport', outcome: 'released', reasonCode: 'released_before_send' }))
    .toEqual(expect.objectContaining({ state: 'open', retryable: true }));
  await withAuthorityTransaction(async(client)=>{await client.query(`UPDATE continuation_retry_budgets
    SET retrieval_spent=retrieval_max,in_flight_owner=NULL,retry_expires_at=NULL,state='open'
    WHERE workspace_id=$1 AND continuation_key=$2`,[MISSION.workspaceId,H2]);});
  const exhausted = await claimContinuationRetry({ workspaceId: MISSION.workspaceId, continuationKey: H2, actorAttemptId: 'attempt:one', runtimeId: 'runtime:one', owner: 'owner:four', phase: 'retrieval' });
  expect(exhausted.state).toBe('quarantined');
  expect(Number((await pool.query(`SELECT count(*) count FROM continuation_quarantines WHERE workspace_id=$1`, [MISSION.workspaceId])).rows[0].count)).toBe(1);
});

test('plan-change proposals cannot expand paths or mutate canonical work-package state', async () => {
  const active = (await pool.query<{ runtime_id: string; lease_id: string; fencing_token: string; attempt_id: string; policy_activation_hash: string }>(
    `SELECT runtime_id,lease_id,fencing_token,attempt_id,policy_activation_hash FROM execution_leases WHERE workspace_id=$1 AND state='active'`,
  [MISSION.workspaceId])).rows[0]!;
  const proposal = { contractVersion: '1.0.0', artifactId: 'proposal-artifact:one', contentHash: H, createdAt: new Date().toISOString(),
    createdBy: active.runtime_id, schemaVersion: 'rorca.plan-change-proposal.v1', contractId: 'rorca.plan-change-proposal.v1',
    workspaceId: MISSION.workspaceId, missionId: MISSION.missionId, workPackageId: WORK_PACKAGE.workPackageId,
    attemptId: active.attempt_id, leaseId: active.lease_id, fencingToken: Number(active.fencing_token),
    policyActivationHash: active.policy_activation_hash, baseRevision: 1, baseHash: WORK_PACKAGE.workPackageHash, proposalId: 'proposal:runtime-one', diffHash: H, rationale: 'Narrow implementation correction',
    impactHash: H, requestedPaths: WORK_PACKAGE.allowedPaths, dependencyManifestHash: H, validationManifestHash: H,
    proposerRuntimeId: active.runtime_id, requestsMergeAuthority: false as const, requestsDeploymentAuthority: false as const,
    state: 'proposed' as const };
  const before = (await pool.query<{ state_version: string }>(`SELECT state_version FROM governed_work_package_heads
    WHERE workspace_id=$1 AND mission_id=$2 AND work_package_id=$3`, [MISSION.workspaceId, MISSION.missionId, WORK_PACKAGE.workPackageId])).rows[0]!.state_version;
  const result = await submitPlanChangeProposal(proposal, { ...CONTEXT, principalId: active.runtime_id, authoritySource: 'runtime_lease', idempotencyKey: 'idempotency:proposal-one' });
  expect(result.value.canonicalMutationPerformed).toBe(false);
  expect((await reviewPlanChangeProposal({ workspaceId: MISSION.workspaceId, proposalId: proposal.proposalId,
    expectedStateVersion: 1, decision: 'under_review', reasonCode: 'review_started' },
  { ...CONTEXT, idempotencyKey: 'idempotency:proposal-review-start' })).value).toEqual(expect.objectContaining({ state: 'under_review', canonicalMutationPerformed: false }));
  expect((await reviewPlanChangeProposal({ workspaceId: MISSION.workspaceId, proposalId: proposal.proposalId,
    expectedStateVersion: 2, decision: 'accepted', reasonCode: 'scope_accepted_for_revision' },
  { ...CONTEXT, idempotencyKey: 'idempotency:proposal-review-accept' })).value).toEqual(expect.objectContaining({ state: 'accepted', canonicalMutationPerformed: false }));
  expect((await pool.query<{ state_version: string }>(`SELECT state_version FROM governed_work_package_heads
    WHERE workspace_id=$1 AND mission_id=$2 AND work_package_id=$3`, [MISSION.workspaceId, MISSION.missionId, WORK_PACKAGE.workPackageId])).rows[0]!.state_version).toBe(before);
  await expect(submitPlanChangeProposal({ ...proposal, artifactId: 'proposal-artifact:secret', proposalId: 'proposal:secret',
    rationale: 'api_key=canary-secret' }, { ...CONTEXT, principalId: active.runtime_id, authoritySource: 'runtime_lease',
    idempotencyKey: 'idempotency:proposal-secret' })).rejects.toMatchObject({ code: 'SECRET_BEARING_PAYLOAD' });
  await expect(submitPlanChangeProposal({ ...proposal, artifactId: 'proposal-artifact:scope-expansion', proposalId: 'proposal:scope-expansion',
    requestedPaths: ['src/forbidden.ts'] }, { ...CONTEXT, principalId: active.runtime_id, authoritySource: 'runtime_lease', idempotencyKey: 'idempotency:proposal-scope-expansion' }))
    .rejects.toMatchObject({ code: 'SCOPE_EXPANSION_FORBIDDEN' });
});

test('evidence is trust-bounded and closeout is server-evaluated without establishing completion', async () => {
  const active = (await pool.query<{ lease_id: string; runtime_id: string; fencing_token: string; current_sha: string; worktree_id: string }>(
    `SELECT lease_id,runtime_id,fencing_token,current_sha,worktree_id FROM execution_leases WHERE workspace_id=$1 AND state='active'`, [MISSION.workspaceId])).rows[0]!;
  const now = new Date().toISOString();
  const evidence = evidenceFor(active, { createdAt: now, observedAt: now, receivedAt: now, databaseTime: now });
  await expect(ingestGovernedEvidence({...evidence,evidenceHash:H}, { id:'host:one',maximumTrust:'host_observed' }))
    .rejects.toMatchObject({code:'CANONICAL_EVIDENCE_HASH_MISMATCH'});
  const evidenceResult = await ingestGovernedEvidence(evidence, { id: 'host:one', maximumTrust: 'host_observed' });
  expect(evidenceResult.duplicate).toBe(false);
  await expect(ingestGovernedEvidence(withEvidenceIntegrity({ ...evidence, evidenceId: 'evidence:escalated', trustClass: 'provider_verified' }),
    { id: 'host:one', maximumTrust: 'host_observed' })).rejects.toMatchObject({ code: 'TRUST_ESCALATION_FORBIDDEN' });
  await expect(ingestGovernedEvidence(withEvidenceIntegrity({ ...evidence, artifactId: 'evidence-artifact:wrong-story', evidenceId: 'evidence:wrong-story',
    storyId: 'W2-999' }), { id: 'host:one', maximumTrust: 'host_observed' })).rejects.toBeInstanceOf(ConflictError);
  const evaluation = { contractVersion: '1.0.0', artifactId: 'evaluation-artifact:one', contentHash: H, createdAt: now, createdBy: 'resolver:one',
    schemaVersion: 'rorca.closeout-evaluation.v1', contractId: 'rorca.closeout-evaluation.v1', evaluationId: 'evaluation:one',
    workspaceId: MISSION.workspaceId, missionId: MISSION.missionId, missionRevision: 1, workPackageId: WORK_PACKAGE.workPackageId,
    workPackageRevision: 1, specHash: SPEC.specHash, storyHash: SPEC.storyHash, attemptId: 'attempt:one', leaseId: active.lease_id,
    fencingToken: Number(active.fencing_token), policyActivationHash: H, checkpointHash: H, repositoryRevision: active.current_sha,
    worktreeId: active.worktree_id, evidence: [{ evidenceId: evidence.evidenceId, evidenceHash: evidenceResult.evidenceHash }],
    obligationSetId:'obligation-set:one',obligationSetHash:EVIDENCE_OBLIGATION_MANIFEST_HASH,
    policyVersion: String(MISSION.policy.revision), resolverVersion: '1.0.0', outcome: 'eligible' as const, missingEvidenceKinds: [], conflictingEvidenceIds: [],
    decisionTime: now, storyCloseoutDecisionId: null, establishesStoryCompletion: false as const };
  await expect(evaluateGovernedCloseout({...evaluation,evaluationId:'evaluation:substituted-set',obligationSetHash:H},
    {...CONTEXT,principalId:'resolver:one',idempotencyKey:'idempotency:closeout-substituted-set'}))
    .rejects.toMatchObject({code:'CONFLICT',details:expect.objectContaining({reason:'database_authority_denied'})});
  await expect(evaluateGovernedCloseout({...evaluation,evaluationId:'evaluation:substituted-policy',policyVersion:'999'},
    {...CONTEXT,principalId:'resolver:one',idempotencyKey:'idempotency:closeout-substituted-policy'}))
    .rejects.toMatchObject({code:'CONFLICT',details:expect.objectContaining({reason:'database_authority_denied'})});
  const closeout = await evaluateGovernedCloseout(evaluation, { ...CONTEXT, principalId: 'resolver:one', idempotencyKey: 'idempotency:closeout-one' });
  expect(closeout.value).toEqual(expect.objectContaining({ outcome: 'eligible', establishesStoryCompletion: false, storyCloseoutDecisionId: null }));
  const failedEvidence=evidenceFor(active,{artifactId:'evidence-artifact:failed',evidenceId:'evidence:failed',status:'failed'});
  const failedEvidenceResult=await ingestGovernedEvidence(failedEvidence,{id:'host:one',maximumTrust:'host_observed'});
  const failedEvaluation={...evaluation,artifactId:'evaluation-artifact:failed',evaluationId:'evaluation:failed',
    evidence:[{evidenceId:failedEvidence.evidenceId,evidenceHash:failedEvidenceResult.evidenceHash}],outcome:'failed' as const};
  const failedCloseout=await evaluateGovernedCloseout(failedEvaluation,{...CONTEXT,principalId:'resolver:one',
    idempotencyKey:'idempotency:closeout-failed'});
  expect(failedCloseout.value).toEqual(expect.objectContaining({outcome:'failed',missingEvidenceIds:[],conflictingEvidenceIds:[]}));
  const missingRef = { evidenceId: 'evidence:missing', evidenceHash: H2 };
  await expect(evaluateGovernedCloseout({ ...evaluation, evaluationId: 'evaluation:wrong-missing-member',
    evidence: [missingRef], outcome: 'blocked', missingEvidenceKinds: ['wrong:same-length'] },
  { ...CONTEXT, principalId: 'resolver:one', idempotencyKey: 'idempotency:closeout-wrong-missing-member' }))
    .rejects.toMatchObject({ code: 'CLOSEOUT_EVALUATION_MISMATCH' });
  await expect(evaluateGovernedCloseout({ ...evaluation, evaluationId: 'evaluation:lie', outcome: 'blocked', missingEvidenceKinds: ['fabricated'] },
    { ...CONTEXT, principalId: 'resolver:one', idempotencyKey: 'idempotency:closeout-lie' })).rejects.toMatchObject({ code: 'CLOSEOUT_EVALUATION_MISMATCH' });
});

test('policy activation revocation stales the old lease before any further renewal', async () => {
  const active = (await pool.query<EvidenceLease & { state_version: string }>(
    `SELECT lease_id,runtime_id,fencing_token,state_version,current_sha,worktree_id FROM execution_leases
     WHERE workspace_id=$1 AND state='active'`, [MISSION.workspaceId])).rows[0]!;
  const activationScope = { workspaceId: MISSION.workspaceId, missionId: MISSION.missionId, missionRevision: 1, missionHash: MISSION.missionHash,
    workPackageId: WORK_PACKAGE.workPackageId, workPackageRevision: 1, workPackageHash: WORK_PACKAGE.workPackageHash, spec: SPEC, runId: 1,
    attemptId: 'attempt:one', leaseId: active.lease_id, fencingToken: Number(active.fencing_token), cancellationId: 'cancellation:one',
    runtimeId: active.runtime_id, repositoryId: REPOSITORY.repositoryId, remoteAuthorityHash: H, baseSha: REPOSITORY.baseSha,
    worktreeId: REPOSITORY.worktreeId, allowedPathManifestHash: H, requiredPathManifestHash: H,
    policyDefinitionId: 'context-policy:one', policyDefinitionVersion: '1.0.0', policyDefinitionHash: H };
  const now = new Date().toISOString();
  const revocation = { contractVersion: '1.0.0', artifactId: 'activation-artifact:revoked', contentHash: H2, createdAt: now, createdBy: 'human:one',
    schemaVersion: 'rorca.context-continuation-policy-activation.v1', contractId: 'rorca.context-continuation-policy-activation.v1',
    workspaceId: MISSION.workspaceId, activationId: 'activation:one', activationRevision: 2, activationHash: H2,
    definitionId: 'context-policy:one', definitionVersion: '1.0.0', definitionHash: H, scope: activationScope,
    effectiveValuesHash: H2, authorityReceiptId: 'authority-receipt:revocation', activatedAt: now, expiresAt: null, state: 'revoked' as const };
  const result = await activateContextPolicy(revocation, { ...CONTEXT, idempotencyKey: 'idempotency:activation-revoked' });
  expect(result.value.effectiveState).toBe('revoked');
  await expect(ingestGovernedEvidence(evidenceFor(active, { artifactId: 'evidence-artifact:after-revocation',
    evidenceId: 'evidence:after-revocation' }), { id: 'host:one', maximumTrust: 'host_observed' })).rejects.toBeInstanceOf(ConflictError);
  await expect(renewExecutionLease({ workspaceId: MISSION.workspaceId, leaseId: active.lease_id,
    fencingToken: Number(active.fencing_token), runtimeId: active.runtime_id, expectedStateVersion: Number(active.state_version), extendSeconds: 60 },
  { ...CONTEXT, principalId: active.runtime_id, authoritySource: 'runtime_lease', idempotencyKey: 'idempotency:renew-after-revocation' }))
    .rejects.toMatchObject({ code: 'POLICY_ACTIVATION_INACTIVE' });
});

test('cancellation revokes lease authority and classifies wrong-runtime then accepted acknowledgements', async () => {
  const active = (await pool.query<EvidenceLease>(
    `SELECT lease_id,runtime_id,fencing_token,current_sha,worktree_id FROM execution_leases
     WHERE workspace_id=$1 AND state='active'`, [MISSION.workspaceId])).rows[0]!;
  const requestedAt = new Date(); const deadlineAt = new Date(requestedAt.getTime() + 60_000);
  const request = { contractVersion: '1.0.0', artifactId: 'cancellation-artifact:one', contentHash: H, createdAt: requestedAt.toISOString(), createdBy: 'human:one',
    schemaVersion: 'rorca.cancellation.v1', contractId: 'rorca.cancellation.v1', workspaceId: MISSION.workspaceId,
    cancellationId: 'cancellation:one', requesterAuthorityRef: 'human:one', reasonCode: 'operator-request', attemptId: 'attempt:one',
    leaseId: active.lease_id, fencingToken: Number(active.fencing_token), requestedAt: requestedAt.toISOString(), deadlineAt: deadlineAt.toISOString(),
    acknowledgementId: null, acknowledgedAt: null, disposition: 'requested' as const };
  const cancellation = await requestExecutionCancellation(request, { ...CONTEXT, idempotencyKey: 'idempotency:cancellation-one' });
  expect(cancellation.value.leaseAuthorityRevoked).toBe(true);
  expect((await pool.query<{ state: string }>(`SELECT state FROM execution_leases WHERE workspace_id=$1 AND lease_id=$2`, [MISSION.workspaceId, active.lease_id])).rows[0]!.state).toBe('cancelled');
  await expect(ingestGovernedEvidence(evidenceFor(active, { artifactId: 'evidence-artifact:after-cancellation',
    evidenceId: 'evidence:after-cancellation' }), { id: 'host:one', maximumTrust: 'host_observed' })).rejects.toBeInstanceOf(ConflictError);
  const wrong = { ...request, artifactId: 'cancellation-ack-artifact:wrong', contentHash: H2, createdBy: 'runtime:wrong',
    acknowledgementId: 'acknowledgement:wrong', acknowledgedAt: new Date().toISOString(), disposition: 'acknowledged' as const };
  const wrongResult = await acknowledgeExecutionCancellation(wrong, 'runtime:wrong', { ...CONTEXT, principalId: 'runtime:wrong', authoritySource: 'runtime_lease', idempotencyKey: 'idempotency:ack-wrong' });
  expect(wrongResult.value.classification).toBe('wrong_runtime');
  const accepted = { ...wrong, artifactId: 'cancellation-ack-artifact:accepted', createdBy: active.runtime_id, acknowledgementId: 'acknowledgement:accepted' };
  const acceptedResult = await acknowledgeExecutionCancellation(accepted, active.runtime_id, { ...CONTEXT, principalId: active.runtime_id, authoritySource: 'runtime_lease', idempotencyKey: 'idempotency:ack-accepted' });
  expect(acceptedResult.value).toEqual(expect.objectContaining({ classification: 'accepted', requestState: 'requested',
    effectiveDisposition: 'acknowledged', acknowledged: true, requestRowImmutable: true }));
  expect((await pool.query(`SELECT request_state,effective_disposition,acknowledged,request_row_immutable
    FROM execution_cancellation_effective_state WHERE workspace_id=$1 AND cancellation_id=$2`,
  [MISSION.workspaceId, request.cancellationId])).rows[0]).toEqual(expect.objectContaining({ request_state: 'requested',
    effective_disposition: 'acknowledged', acknowledged: true, request_row_immutable: true }));
});

test('a separately activated takeover receives a higher fence and supports idempotent release', async () => {
  const candidate = { ...lease('lease:takeover', 'runtime:one'), artifactId: 'lease-artifact:takeover', contentHash: H3,
    fencingToken: 2, policyActivationId: 'activation:takeover', policyActivationRevision: 3, policyActivationHash: H3 };
  const activationScope = { workspaceId: MISSION.workspaceId, missionId: MISSION.missionId, missionRevision: 1, missionHash: MISSION.missionHash,
    workPackageId: WORK_PACKAGE.workPackageId, workPackageRevision: 1, workPackageHash: WORK_PACKAGE.workPackageHash, spec: SPEC, runId: 1,
    attemptId: 'attempt:one', leaseId: candidate.leaseId, fencingToken: 2, cancellationId: candidate.cancellationId,
    runtimeId: candidate.runtimeId, repositoryId: REPOSITORY.repositoryId, remoteAuthorityHash: H, baseSha: REPOSITORY.baseSha,
    worktreeId: REPOSITORY.worktreeId, allowedPathManifestHash: H, requiredPathManifestHash: H,
    policyDefinitionId: 'context-policy:one', policyDefinitionVersion: '1.0.0', policyDefinitionHash: H };
  const now = new Date().toISOString();
  const activation = { contractVersion: '1.0.0', artifactId: 'activation-artifact:takeover', contentHash: H6, createdAt: now, createdBy: 'human:one',
    schemaVersion: 'rorca.context-continuation-policy-activation.v1', contractId: 'rorca.context-continuation-policy-activation.v1',
    workspaceId: MISSION.workspaceId, activationId: 'activation:takeover', activationRevision: 1, activationHash: H6,
    definitionId: 'context-policy:one', definitionVersion: '1.0.0', definitionHash: H, scope: activationScope,
    effectiveValuesHash: H6, authorityReceiptId: 'authority-receipt:takeover', activatedAt: now, expiresAt: null, state: 'proposed' as const };
  await activateContextPolicy(activation, { ...CONTEXT, idempotencyKey: 'idempotency:activation-takeover-proposed' });
  await activateContextPolicy({ ...activation, artifactId: 'activation-artifact:takeover-verified', contentHash: H7,
    activationRevision: 2, activationHash: H7, effectiveValuesHash: H7, state: 'verified' as const },
  { ...CONTEXT, idempotencyKey: 'idempotency:activation-takeover-verified' });
  await activateContextPolicy({ ...activation, artifactId: 'activation-artifact:takeover-active', contentHash: H3,
    activationRevision: 3, activationHash: H3, effectiveValuesHash: H3, state: 'active' as const },
  { ...CONTEXT, idempotencyKey: 'idempotency:activation-takeover-active' });
  const acquired = await acquireExecutionLease(candidate, { ...CONTEXT, idempotencyKey: 'idempotency:lease-takeover' });
  expect(acquired.value.fencingToken).toBe(2);
});

test('runtime event ordering is serialized; exact replay is duplicate and gap/changed replay is conflict evidence', async () => {
  const active = (await pool.query<{ lease_id: string; runtime_id: string; expires_at: Date; fencing_token: string; policy_activation_hash: string }>(`SELECT lease_id,runtime_id,expires_at,fencing_token,policy_activation_hash FROM execution_leases WHERE workspace_id=$1 ORDER BY fencing_token DESC LIMIT 1`, [MISSION.workspaceId])).rows[0]!;
  const scope = { workspaceId: MISSION.workspaceId, missionId: MISSION.missionId, missionRevision: 1, missionHash: MISSION.missionHash,
    workPackageId: WORK_PACKAGE.workPackageId, workPackageRevision: 1, workPackageHash: WORK_PACKAGE.workPackageHash, spec: SPEC, runId: 1, attemptId: 'attempt:one',
    leaseId: active.lease_id, fencingToken: Number(active.fencing_token), leaseExpiresAt: active.expires_at.toISOString(), cancellationId: 'cancellation:one', runtimeId: active.runtime_id,
    controllerGeneration: 1, runtimeGeneration: 1, sessionId: 'session:one', sessionFileHash: H, turnId: 'turn:one', turnAttempt: 1,
    originatingGeneration: 1, cursor: 0, cursorHash: H, priorEntryId: 'not_applicable' as const, repository: REPOSITORY,
    validationStateHash: H, rootCauseClassification: 'unknown', rootCauseHash: H, policyDefinitionId: 'policy:one',
    policyDefinitionVersion: '1.0.0', policyDefinitionHash: H, policyActivationId: 'activation:one', policyActivationRevision: 1, policyActivationHash: active.policy_activation_hash };
  const event = { contractVersion: '1.0.0', artifactId: 'event-artifact:one', contentHash: H, createdAt: '2026-07-29T00:00:00.000Z', createdBy: active.runtime_id,
    schemaVersion: 'rorca.execution-event.v1', contractId: 'rorca.execution-event.v1', eventId: 'event:one', idempotencyKey: H, scope,
    eventType: 'attempt_started' as const, runtimeSequence: 0, canonicalStateOrder: 0, hostReceiptOrder: 0,
    observedAt: '2026-07-29T00:00:00.000Z', receivedAt: '2026-07-29T00:00:00.000Z', databaseTime: '2026-07-29T00:00:00.000Z',
    observerClass: 'runtime' as const, trustClass: 'runtime_asserted' as const,
    checkpointId: 'checkpoint:one', checkpointHash: H, retrievalReceiptId: 'receipt:one', retrievalReceiptHash: H,
    contextBundleId: 'bundle:one', contextBundleHash: H, continuationDispatchId: 'dispatch:one', continuationDispatchHash: H,
    compaction: null, retryPhase: null, completionCandidate: null, stateOrderLinkHash: null,
    payloadHash: H, reasonCode: 'started', count: 1, durationMs: 0,
    redactionClass: 'none' as const, restrictedRef: null, originatingEventHash: null };
  expect(RuntimeEventV1Schema.safeParse({ ...event, retryPhase: { retryCycleId: 'retry:forged', phase: 'settled',
    attempt: 1, maximum: 1, generation: 1 } }).success).toBe(false);
  expect(RuntimeEventV1Schema.safeParse({ ...event, eventType: 'execution_completion_candidate_validated',
    completionCandidate: { state: 'observed', candidateHash: H } }).success).toBe(false);
  const ingress = (correlationId: string) => ({ correlationId, observerId: active.runtime_id,
    observerClass: 'runtime' as const, maximumTrust: 'runtime_asserted' as const });
  expect(await ingestRuntimeEvent(event, ingress('correlation:event-one'))).toEqual(expect.objectContaining({
    duplicate: false, eventId: 'event:one', canonicalStateOrder: 0, hostReceiptOrder: 0 }));
  expect(await ingestRuntimeEvent(event, ingress('correlation:event-replay'))).toEqual(expect.objectContaining({
    duplicate: true, eventId: 'event:one', canonicalStateOrder: 0, hostReceiptOrder: 0 }));
  const ordered = await ingestRuntimeEvent({ ...event, eventId: 'event:server-ordered', artifactId: 'event-artifact:server-ordered',
    runtimeSequence: 1, canonicalStateOrder: 999, hostReceiptOrder: 999 }, ingress('correlation:event-server-ordered'));
  expect(ordered).toEqual(expect.objectContaining({ canonicalStateOrder: 1, hostReceiptOrder: 1 }));
  await expect(ingestRuntimeEvent({ ...event, eventId: 'event:gap', artifactId: 'event-artifact:gap', contentHash: H2,
    runtimeSequence: 3, canonicalStateOrder: 2, hostReceiptOrder: 2 }, ingress('correlation:event-gap'))).rejects.toBeInstanceOf(ConflictError);
  await expect(ingestRuntimeEvent({ ...event, contentHash: H2 }, ingress('correlation:event-changed'))).rejects.toBeInstanceOf(ConflictError);
  await expect(ingestRuntimeEvent({ ...event, eventId: 'event:stale-generation', artifactId: 'event-artifact:stale-generation',
    scope: { ...event.scope, runtimeGeneration: 0 } }, ingress('correlation:event-stale-generation'))).rejects.toBeInstanceOf(ConflictError);
  await expect(ingestRuntimeEvent({ ...event, eventId: 'event:invalid-compaction', artifactId: 'event-artifact:invalid-compaction',
    eventType: 'context_compaction_ended', runtimeSequence: 2, canonicalStateOrder: 1, hostReceiptOrder: 1,
    compaction: null }, ingress('correlation:event-invalid-compaction'))).rejects.toMatchObject({ name: 'ZodError' });
  expect(Number((await pool.query(`SELECT count(*) count FROM runtime_event_conflicts WHERE workspace_id=$1`, [MISSION.workspaceId])).rows[0].count)).toBe(3);
  const releaseInput = { workspaceId: MISSION.workspaceId, leaseId: active.lease_id, fencingToken: Number(active.fencing_token),
    runtimeId: active.runtime_id, expectedStateVersion: 1, reasonCode: 'runtime-settled' };
  const releaseContext = { ...CONTEXT, principalId: active.runtime_id, authoritySource: 'runtime_lease' as const, idempotencyKey: 'idempotency:release-takeover' };
  expect((await releaseExecutionLease(releaseInput, releaseContext)).value.state).toBe('released');
  expect((await releaseExecutionLease(releaseInput, releaseContext)).duplicate).toBe(true);
  await expect(releaseExecutionLease(releaseInput, { ...releaseContext, idempotencyKey: 'idempotency:release-takeover-replay' }))
    .rejects.toBeInstanceOf(ConflictError);
  await expect(ingestRuntimeEvent({ ...event, eventId: 'event:after-release', artifactId: 'event-artifact:after-release',
    runtimeSequence: 2 }, ingress('correlation:event-after-release'))).rejects.toBeInstanceOf(ConflictError);
});

test('two fully valid lease contenders serialize to one active slot owner without deadlock', async () => {
  await withAuthorityTransaction(async(client)=>{await client.query(`INSERT INTO governed_execution_attempts
    (workspace_id,attempt_id,mission_id,work_package_id,work_package_revision,run_id,story_id,runtime_id,generation,manifest_hash,
     repository_id,worktree_id,spec_id,spec_version,spec_hash,story_version,story_hash,criteria_manifest_hash,base_sha,current_sha,
     expected_head_sha,allowed_path_manifest_hash,required_path_manifest_hash,changed_path_manifest_hash,forbidden_path_manifest_hash)
    VALUES($1,'attempt:race',$2,$3,1,2,$4,'runtime:one',1,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
  [MISSION.workspaceId, MISSION.missionId, WORK_PACKAGE.workPackageId, SPEC.storyId, H, REPOSITORY.repositoryId, REPOSITORY.worktreeId,
    SPEC.specId, SPEC.specVersion, SPEC.specHash, SPEC.storyVersion, SPEC.storyHash, SPEC.criteriaManifestHash,
    REPOSITORY.baseSha, REPOSITORY.currentSha, REPOSITORY.expectedHeadSha, REPOSITORY.allowedPathManifestHash,
    REPOSITORY.requiredPathManifestHash, REPOSITORY.changedPathManifestHash, REPOSITORY.forbiddenPathManifestHash]);});
  const candidate = (leaseId: string, activationId: string, activationHash: string) => ({ ...lease(leaseId, 'runtime:one'),
    artifactId: `lease-artifact:${leaseId.split(':').pop()}`, attemptId: 'attempt:race', runId: 2,
    policyActivationId: activationId, policyActivationRevision: 3, policyActivationHash: activationHash });
  const first = candidate('lease:race-one', 'activation:race-one', H4);
  const second = candidate('lease:race-two', 'activation:race-two', H5);
  const activationFor = (leaseCandidate: ReturnType<typeof candidate>, hash: string) => {
    const scope = { workspaceId: MISSION.workspaceId, missionId: MISSION.missionId, missionRevision: 1, missionHash: MISSION.missionHash,
      workPackageId: WORK_PACKAGE.workPackageId, workPackageRevision: 1, workPackageHash: WORK_PACKAGE.workPackageHash,
      spec: SPEC, runId: 2, attemptId: 'attempt:race', leaseId: leaseCandidate.leaseId, fencingToken: 1,
      cancellationId: leaseCandidate.cancellationId, runtimeId: 'runtime:one', repositoryId: REPOSITORY.repositoryId,
      remoteAuthorityHash: H, baseSha: REPOSITORY.baseSha, worktreeId: REPOSITORY.worktreeId,
      allowedPathManifestHash: H, requiredPathManifestHash: H, policyDefinitionId: 'context-policy:one',
      policyDefinitionVersion: '1.0.0', policyDefinitionHash: H };
    return { contractVersion: '1.0.0', artifactId: `activation-artifact:${leaseCandidate.leaseId.split(':').pop()}`,
      contentHash: hash, createdAt: new Date().toISOString(), createdBy: 'human:one',
      schemaVersion: 'rorca.context-continuation-policy-activation.v1', contractId: 'rorca.context-continuation-policy-activation.v1',
      workspaceId: MISSION.workspaceId, activationId: leaseCandidate.policyActivationId, activationRevision: 1,
      activationHash: hash, definitionId: 'context-policy:one', definitionVersion: '1.0.0', definitionHash: H,
      scope, effectiveValuesHash: hash, authorityReceiptId: `authority-receipt:${leaseCandidate.leaseId.split(':').pop()}`,
      activatedAt: new Date().toISOString(), expiresAt: null, state: 'proposed' as const };
  };
  const activateLifecycle = async (leaseCandidate: ReturnType<typeof candidate>, hashes: [string, string, string], key: string) => {
    const proposed = activationFor(leaseCandidate, hashes[0]);
    await activateContextPolicy(proposed, { ...CONTEXT, idempotencyKey: `idempotency:activation-${key}-proposed` });
    await activateContextPolicy({ ...proposed, artifactId: `${proposed.artifactId}-verified`, contentHash: hashes[1],
      activationRevision: 2, activationHash: hashes[1], effectiveValuesHash: hashes[1], state: 'verified' as const },
    { ...CONTEXT, idempotencyKey: `idempotency:activation-${key}-verified` });
    await activateContextPolicy({ ...proposed, artifactId: `${proposed.artifactId}-active`, contentHash: hashes[2],
      activationRevision: 3, activationHash: hashes[2], effectiveValuesHash: hashes[2], state: 'active' as const },
    { ...CONTEXT, idempotencyKey: `idempotency:activation-${key}-active` });
  };
  await activateLifecycle(first, [H10, H11, H4], 'race-one');
  await activateLifecycle(second, [H12, H13, H5], 'race-two');
  const race = await Promise.allSettled([
    acquireExecutionLease(first, { ...CONTEXT, idempotencyKey: 'idempotency:lease-race-one' }),
    acquireExecutionLease(second, { ...CONTEXT, idempotencyKey: 'idempotency:lease-race-two' }),
  ]);
  expect(race.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
  expect(race.filter((item) => item.status === 'rejected')).toHaveLength(1);
  expect(Number((await pool.query(`SELECT count(*) count FROM execution_leases l JOIN governed_execution_attempts a
    ON a.workspace_id=l.workspace_id AND a.attempt_id=l.attempt_id WHERE l.workspace_id=$1 AND a.attempt_id='attempt:race' AND l.state='active'`,
  [MISSION.workspaceId])).rows[0].count)).toBe(1);
});
