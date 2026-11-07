/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import { Pool, type PoolClient } from 'pg';

const migrationDatabaseUrl = process.env.RORCA_MIGRATION_DATABASE_URL ?? process.env.WAVE2_TEST_MIGRATION_DATABASE_URL;
const runtimeDatabaseUrl = process.env.DATABASE_URL;
const writerDatabaseUrl = process.env.RORCA_CANONICAL_WRITER_DATABASE_URL;
if (!migrationDatabaseUrl || !runtimeDatabaseUrl || !writerDatabaseUrl) {
  throw new Error('Split isolated migration, runtime, and canonical-writer database URLs are required');
}

const workspaceId = `workspace:completion-${crypto.randomUUID()}`;
const foreignWorkspaceId = `workspace:completion-foreign-${crypto.randomUUID()}`;
const missionId = 'mission:completion';
const workPackageId = 'work-package:completion';
const attemptId = 'attempt:completion';
const leaseId = 'lease:completion';
const runtimeId = 'runtime:completion';
const obligationSetId = 'obligation-set:completion';
const planId = 'plan:completion';
const hash = (digit: string) => `sha256:${digit.repeat(64)}`;
const H = hash('a');
const H2 = hash('b');
const gitSha = 'c'.repeat(40);
const fixtureHex = (label: string) => crypto.createHash('sha256').update(`${workspaceId}:${label}`).digest('hex');
const acceptedManifestHash = `sha256:${fixtureHex('accepted-manifest')}`;
const acceptedAttemptResultId = `ATR-sha256:${fixtureHex('accepted-result')}`;
const blockedAttemptResultId = `ATR-sha256:${fixtureHex('blocked-result')}`;
const acceptedCloseoutDecisionId = `CLO-sha256:${fixtureHex('accepted-closeout')}`;
const blockedCloseoutDecisionId = `CLO-sha256:${fixtureHex('blocked-closeout')}`;

const ownerPool = new Pool({
  connectionString: migrationDatabaseUrl,
  options: `--search_path=rorca,public -c rorca.migration_mode=on -c rorca.workspace_id=${workspaceId}`,
});
const runtimePool = new Pool({
  connectionString: runtimeDatabaseUrl,
  options: `--search_path=rorca,public -c rorca.workspace_id=${workspaceId}`,
});
const writerPool = new Pool({
  connectionString: writerDatabaseUrl,
  options: `--search_path=rorca,public -c rorca.workspace_id=${workspaceId}`,
});

async function issueCompletionCapability(
  client: PoolClient,
  operation: 'completion.activate' | 'completion.plan' | 'completion.proposal' | 'completion.gate' | 'completion.continuation' | 'completion.final-report' | 'completion.attempt-transition',
  authorizedWorkspace = workspaceId,
  subjectHash = H,
): Promise<void> {
  const request = JSON.stringify({ artifact: {
    artifactHash: subjectHash, attemptId, writerFence: 1,
    scope: { workspaceId: authorizedWorkspace, attemptId, fencingToken: 1 },
  } });
  await client.query(
    `SELECT rorca.authorize_completion_protocol_mutation_v1($1,$2,$3,$4,$5::jsonb)`,
    [authorizedWorkspace, operation, H, subjectHash, request],
  );
}

async function writerTransaction(action: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await writerPool.connect();
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('rorca.workspace_id',$1,TRUE)`, [workspaceId]);
    await action(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function seedGovernedAttempt(): Promise<{ acceptedDecisionId: string; blockedDecisionId: string }> {
  await ownerPool.query(
    `INSERT INTO workspaces(id,label,path) VALUES($1,$1,$2),($3,$3,$4)`,
    [workspaceId, `/tmp/${workspaceId}`, foreignWorkspaceId, `/tmp/${foreignWorkspaceId}`],
  );
  await ownerPool.query(
    `INSERT INTO governed_missions(workspace_id,mission_id,created_by) VALUES($1,$2,'host:test')`,
    [workspaceId, missionId],
  );
  await ownerPool.query(`INSERT INTO governed_mission_versions(
      workspace_id,mission_id,mission_revision,mission_hash,contract_version,canonical_spec_id,
      canonical_spec_version,canonical_spec_hash,canonical_spec_path,repository_id,base_sha,payload_json,payload_hash,created_by)
    VALUES($1,$2,1,$3,'1.0.0','spec:completion',1,$3,'specs/completion.yaml','repository:completion',$4,'{}',$3,'host:test')`,
  [workspaceId, missionId, H, gitSha]);
  await ownerPool.query(
    `INSERT INTO governed_work_packages(workspace_id,mission_id,work_package_id,created_by) VALUES($1,$2,$3,'host:test')`,
    [workspaceId, missionId, workPackageId],
  );
  await ownerPool.query(`INSERT INTO governed_work_package_revisions(
      workspace_id,mission_id,work_package_id,work_package_revision,work_package_hash,mission_revision,
      mission_hash,story_id,repository_id,base_sha,allowed_path_manifest_hash,required_path_manifest_hash,
      validation_manifest_hash,authority_ceiling_hash,payload_json,proposal_id)
    VALUES($1,$2,$3,1,$4,1,$4,'story:completion','repository:completion',$5,$4,$4,$4,$4,'{"spec":{"specId":"spec:completion","storyId":"story:completion"}}','proposal:work-package')`,
  [workspaceId, missionId, workPackageId, H, gitSha]);

  const runIds: number[] = [];
  for (const suffix of ['accepted', 'blocked']) {
    const run = await ownerPool.query<{ id: string }>(`INSERT INTO pipeline_runs(
        spec_path,workspace_id,status,branch_name,worktree_path,execution_workspace_path,
        execution_worktree_path,dispatch_fence,canonical_spec_revision)
      VALUES('specs/completion.yaml',$1,'running','main',$2,$2,$2,$3,$4) RETURNING id::text`,
    [workspaceId, `/tmp/${workspaceId}`, H, H]);
    runIds.push(Number(run.rows[0].id));
    const manifestHash = suffix === 'accepted' ? acceptedManifestHash : `sha256:${fixtureHex('blocked-manifest')}`;
    const attemptResultId = suffix === 'accepted' ? acceptedAttemptResultId : blockedAttemptResultId;
    const decisionId = suffix === 'accepted' ? acceptedCloseoutDecisionId : blockedCloseoutDecisionId;
    const storyId = suffix === 'accepted' ? 'story:completion' : 'story:blocked';
    await ownerPool.query(`INSERT INTO story_execution_manifests(
        manifest_hash,schema_version,workspace_id,spec_id,run_id,story_id,attempt,spec_revision,story_revision,payload)
      VALUES($1,'rorca.story-execution-manifest.v2',$2,'spec:completion',$3,$4,1,$5,$5,'{}')`,
    [manifestHash, workspaceId, runIds.at(-1), storyId, H]);
    if (suffix === 'accepted') {
      await ownerPool.query(`INSERT INTO host_story_attempt_envelopes(
          envelope_id,schema_version,workspace_id,run_id,story_id,attempt,launch_generation,
          cancellation_fence,manifest_hash,spec_id,spec_revision,story_revision,
          canonical_spec_path,canonical_spec_revision,canonical_spec_bytes_hash,
          run_spec_path,run_spec_revision,run_spec_bytes_hash,
          repository_realpath,repository_identity,base_git_sha,expected_git_sha,observed_git_sha,
          expected_git_branch,worktree_realpath,worktree_identity,worktree_branch,runtime_identity,
          identity_hash,payload_hash,outcome,outcome_provenance,exit_code,finished_at)
        VALUES($1,'rorca.host-story-attempt-envelope.v1',$2,$3,$4,1,'00000000-0000-0000-0000-000000000001'::uuid,$5,$6,'spec:completion',$7,$7,
          'specs/completion.yaml',$7,$7,'specs/completion.yaml',$7,$7,$8,$7,$9::char(40),$9::text,$9::char(40),'main',
          $8,$7,'main',$10::jsonb,$11,$12,'success','host_process',0,statement_timestamp())`,
      [
        crypto.randomUUID(), workspaceId, runIds.at(-1), storyId, H, manifestHash, H,
        `/tmp/${workspaceId}`, gitSha, JSON.stringify({ processRole: 'worker-engine', processPid: 1 }),
        hash('f'), hash('9'),
      ]);
    }
    const attemptPayload = { schemaVersion: 'rorca.story-attempt-result.v1', attemptResultId,
      manifestHash, identity: { workspaceId, specId: 'spec:completion', runId: runIds.at(-1), storyId, attempt: 1 } };
    await ownerPool.query(`INSERT INTO story_attempt_results(
        attempt_result_id,manifest_hash,workspace_id,spec_id,run_id,story_id,attempt,payload)
      VALUES($1,$2,$3,'spec:completion',$4,$5,1,$6::jsonb)`,
    [attemptResultId, manifestHash, workspaceId, runIds.at(-1), storyId, JSON.stringify(attemptPayload)]);
    const decisionPayload = { schemaVersion: 'rorca.story-closeout-decision.v1', decisionId, status: suffix,
      activeSubjectRevision: { commitSha: gitSha, worktreePath: `/tmp/${workspaceId}`, branch: 'main' } };
    await ownerPool.query(`INSERT INTO story_closeout_decisions(
        decision_id,manifest_hash,attempt_result_id,workspace_id,spec_id,run_id,story_id,attempt,status,payload)
      VALUES($1,$2,$3,$4,'spec:completion',$5,$6,1,$7,$8::jsonb)`,
    [decisionId, manifestHash, attemptResultId, workspaceId, runIds.at(-1), storyId, suffix,
      JSON.stringify(decisionPayload)]);
  }

  await ownerPool.query(`INSERT INTO governed_execution_attempts(
      workspace_id,attempt_id,mission_id,work_package_id,work_package_revision,run_id,story_id,
      runtime_id,generation,manifest_hash,repository_id,worktree_id,spec_id,spec_version,spec_hash,
      story_version,story_hash,criteria_manifest_hash,base_sha,current_sha,expected_head_sha,
      allowed_path_manifest_hash,required_path_manifest_hash,changed_path_manifest_hash,forbidden_path_manifest_hash)
    VALUES($1,$2,$3,$4,1,$5,'story:completion',$6,0,$7,'repository:completion','worktree:completion',
      'spec:completion',1,$8,1,$8,$8,$9,$9,$9,$8,$8,$8,$8)`,
  [workspaceId, attemptId, missionId, workPackageId, runIds[0], runtimeId, acceptedManifestHash, H, gitSha]);
  await ownerPool.query(
    `INSERT INTO execution_lease_slots(workspace_id,lease_slot_key,last_fence) VALUES($1,$2,1)`,
    [workspaceId, H],
  );
  await ownerPool.query(`INSERT INTO execution_leases(
      workspace_id,lease_id,lease_slot_key,attempt_id,fencing_token,work_package_revision,runtime_id,
      repository_id,base_sha,current_sha,worktree_id,policy_definition_hash,policy_activation_hash,
      checkpoint_hash,bundle_hash,cancellation_id,expires_at,state,payload_hash)
    VALUES($1,$2,$3,$4,1,1,$5,'repository:completion',$6,$6,'worktree:completion',$3,$3,$3,$3,
      'cancellation:none',statement_timestamp()+INTERVAL '1 hour','active',$3)`,
  [workspaceId, leaseId, H, attemptId, runtimeId, gitSha]);

  return {
    acceptedDecisionId: acceptedCloseoutDecisionId,
    blockedDecisionId: blockedCloseoutDecisionId,
  };
}

let acceptedDecisionId: string;
let blockedDecisionId: string;

beforeAll(async () => {
  ({ acceptedDecisionId, blockedDecisionId } = await seedGovernedAttempt());
  await writerTransaction(async (client) => {
    await issueCompletionCapability(client, 'completion.activate');
    await client.query(`INSERT INTO completion_obligation_sets(
        workspace_id,obligation_set_id,obligation_set_revision,artifact_hash,attempt_id,lease_id,
        fencing_token,work_package_hash,manifest_hash,state,payload_json)
      VALUES($1,$2,1,$3,$4,$5,1,$3,$6,'active','{}')`,
    [workspaceId, obligationSetId, H, attemptId, leaseId, acceptedManifestHash]);
    await client.query(`INSERT INTO completion_attempts(
        workspace_id,attempt_id,protocol_version,scope_hash,lease_id,fencing_token,runtime_id,
        obligation_set_id,obligation_set_revision,obligation_set_hash,state,writer_fence,retry_maximum,artifact_hash)
      VALUES($1,$2,1,$3,$4,1,$5,$6,1,$3,'pending',1,2,$3)`,
    [workspaceId, attemptId, H, leaseId, runtimeId, obligationSetId]);
  });
  await writerTransaction(async (client) => {
    await issueCompletionCapability(client, 'completion.plan');
    await client.query(`INSERT INTO completion_task_plans(
        workspace_id,attempt_id,plan_id,plan_revision,plan_hash,prior_plan_hash,artifact_hash,payload_json)
      VALUES($1,$2,$3,1,$4,NULL,$4,'{}')`,
    [workspaceId, attemptId, planId, H]);
  });
});

afterAll(async () => {
  await Promise.allSettled([ownerPool.end(), runtimePool.end(), writerPool.end()]);
});

test('fresh isolated migrations install Completion Protocol v1 and canonical writer activation persists exact rows', async () => {
  const readiness = await ownerPool.query<{
    wave2_migration_version: string;
    completion_migration_version: string;
    tables: number;
  }>(`SELECT
      w.migration_version::text AS wave2_migration_version,
      c.migration_version::text AS completion_migration_version,
      (SELECT COUNT(*)::int FROM information_schema.tables
        WHERE table_schema='rorca' AND table_name LIKE 'completion_%') AS tables
    FROM wave2_schema_readiness w CROSS JOIN completion_schema_readiness c
    WHERE w.singleton=TRUE AND c.singleton=TRUE AND c.state='ready'`);
  expect(readiness.rows[0].wave2_migration_version).toBe('20260731157000');
  expect(readiness.rows[0].completion_migration_version).toBe('20260804170000');
  expect(readiness.rows[0].tables).toBeGreaterThanOrEqual(11);
  const persisted = await writerPool.query<{ attempts: string; plans: string }>(`SELECT
      (SELECT COUNT(*)::text FROM completion_attempts WHERE workspace_id=$1) attempts,
      (SELECT COUNT(*)::text FROM completion_task_plans WHERE workspace_id=$1) plans`, [workspaceId]);
  expect(persisted.rows[0]).toEqual({ attempts: '1', plans: '1' });
});

test('ordinary runtime direct writes and canonical-writer cross-workspace writes are denied with 42501', async () => {
  await expect(runtimePool.query(`INSERT INTO completion_task_plans(
      workspace_id,attempt_id,plan_id,plan_revision,plan_hash,artifact_hash,payload_json)
    VALUES($1,$2,'plan:runtime-forged',1,$3,$3,'{}')`, [workspaceId, attemptId, H2]))
    .rejects.toMatchObject({ code: '42501' });

  const client = await writerPool.connect();
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('rorca.workspace_id',$1,TRUE)`, [workspaceId]);
    await issueCompletionCapability(client, 'completion.plan', workspaceId, H2);
    await expect(client.query(`INSERT INTO completion_task_plans(
        workspace_id,attempt_id,plan_id,plan_revision,plan_hash,artifact_hash,payload_json)
      VALUES($1,$2,'plan:cross-workspace',1,$3,$3,'{}')`, [foreignWorkspaceId, attemptId, H2]))
      .rejects.toMatchObject({ code: '42501' });
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
});

test('immutable journals deny UPDATE, DELETE, and TRUNCATE', async () => {
  const client = await writerPool.connect();
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('rorca.workspace_id',$1,TRUE)`, [workspaceId]);
    await issueCompletionCapability(client, 'completion.plan');
    await expect(client.query(
      `UPDATE completion_task_plans SET payload_json='{"changed":true}' WHERE workspace_id=$1 AND plan_id=$2`,
      [workspaceId, planId],
    )).rejects.toMatchObject({ code: '42501' });
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
  await expect(writerPool.query(
    `DELETE FROM completion_task_plans WHERE workspace_id=$1 AND plan_id=$2`, [workspaceId, planId],
  )).rejects.toMatchObject({ code: '42501' });
  await expect(writerPool.query('TRUNCATE completion_task_plans')).rejects.toMatchObject({ code: '42501' });
});

test('attempt state transitions enforce legal edges and exact state-version CAS before allowing writer advancement', async () => {
  const illegal = await writerPool.connect();
  await illegal.query('BEGIN');
  try {
    await illegal.query(`SELECT set_config('rorca.workspace_id',$1,TRUE)`, [workspaceId]);
    await issueCompletionCapability(illegal, 'completion.attempt-transition');
    await expect(illegal.query(`UPDATE completion_attempts
      SET state='executing',state_version=state_version+1 WHERE workspace_id=$1 AND attempt_id=$2`,
    [workspaceId, attemptId])).rejects.toMatchObject({ code: '55000' });
    await illegal.query('ROLLBACK');
  } finally {
    illegal.release();
  }

  const stale = await writerPool.connect();
  await stale.query('BEGIN');
  try {
    await stale.query(`SELECT set_config('rorca.workspace_id',$1,TRUE)`, [workspaceId]);
    await issueCompletionCapability(stale, 'completion.attempt-transition');
    await expect(stale.query(`UPDATE completion_attempts
      SET state='loading' WHERE workspace_id=$1 AND attempt_id=$2`, [workspaceId, attemptId]))
      .rejects.toMatchObject({ code: '42501' });
    await stale.query('ROLLBACK');
  } finally {
    stale.release();
  }

  await writerTransaction(async (client) => {
    await issueCompletionCapability(client, 'completion.attempt-transition');
    await client.query(`UPDATE completion_attempts
      SET state='loading',state_version=state_version+1 WHERE workspace_id=$1 AND attempt_id=$2`,
    [workspaceId, attemptId]);
  });
  expect((await writerPool.query<{ state: string; state_version: string }>(
    `SELECT state,state_version::text FROM completion_attempts WHERE workspace_id=$1 AND attempt_id=$2`,
    [workspaceId, attemptId],
  )).rows[0]).toEqual({ state: 'loading', state_version: '2' });
});

test('final reports reject blocked or different-revision closeout authority and bind the exact accepted proposal subject', async () => {
  const proposalId = 'proposal:db-final';
  const gateId = 'decision:db-host-final';
  const gateHash = hash('d');
  const treeHash = gitSha;
  const diffHash = hash('e');
  const exactScope = { workspaceId, attemptId, leaseId, fencingToken: 1, repository: { currentSha: gitSha } };
  await writerTransaction(async (writer) => {
    await issueCompletionCapability(writer, 'completion.proposal', workspaceId, H2);
    await writer.query(`INSERT INTO completion_result_proposals(
      workspace_id,attempt_id,proposal_id,proposal_revision,proposal_hash,disposition,artifact_hash,payload_json)
      VALUES($1,$2,$3,1,$4,'ready',$4,$5::jsonb)`, [workspaceId, attemptId, proposalId, H2,
      JSON.stringify({ scope: exactScope, proposalId, proposalRevision: 1, proposalHash: H2,
        resultSha: gitSha, treeHash, diffHash, disposition: 'ready' })]);
  });
  await writerTransaction(async (writer) => {
    await issueCompletionCapability(writer, 'completion.gate', workspaceId, gateHash);
    await writer.query(`INSERT INTO completion_gate_decisions(
      workspace_id,attempt_id,decision_id,decision_revision,decision_hash,proposal_id,proposal_revision,
      proposal_hash,stage,outcome,next_action,establishes_story_completion,artifact_hash,payload_json)
      VALUES($1,$2,$3,1,$4,$5,1,$6,'host_semantic','validated','submit_closeout',FALSE,$4,$7::jsonb)`,
    [workspaceId, attemptId, gateId, gateHash, proposalId, H2, JSON.stringify({
      scope: exactScope, decisionId: gateId, decisionHash: gateHash, proposalId, proposalHash: H2,
      stage: 'host_semantic', outcome: 'validated', nextAction: 'submit_closeout', establishesStoryCompletion: false,
    })]);
  });


  const forgedDirective = await writerPool.connect();
  await forgedDirective.query('BEGIN');
  try {
    await forgedDirective.query(`SELECT set_config('rorca.workspace_id',$1,TRUE)`, [workspaceId]);
    await issueCompletionCapability(forgedDirective, 'completion.continuation', workspaceId, hash('6'));
    await expect(forgedDirective.query(`INSERT INTO completion_continuation_directives(
      workspace_id,attempt_id,directive_id,directive_revision,directive_hash,continuation_key,
      prior_decision_id,prior_decision_revision,state,dispatch_id,artifact_hash,payload_json)
      VALUES($1,$2,'directive:forged-settled',1,$3,$4,$5,1,'settled','dispatch:forged',$3,$6::jsonb)`,
    [workspaceId, attemptId, hash('6'), hash('7'), gateId, JSON.stringify({
      scope: exactScope, directiveId: 'directive:forged-settled', directiveRevision: 1,
      directiveHash: hash('6'), continuationKey: hash('7'), state: 'settled',
    })])).rejects.toMatchObject({ code: expect.stringMatching(/^(?:23503|23514|42501)$/) });
    await forgedDirective.query('ROLLBACK');
  } finally {
    forgedDirective.release();
  }
  const reportPayload = (decisionId: string, finalSha: string) => JSON.stringify({
    scope: { ...exactScope, repository: { currentSha: finalSha } },
    storyCloseoutDecisionId: decisionId, storyCloseoutDecisionStatus: 'accepted',
    gateDecisionId: gateId, gateDecisionHash: gateHash, proposalId, proposalHash: H2,
    finalSha, treeHash, diffHash,
  });
  const insertReport = async (client: PoolClient, decisionId: string, attemptResultId: string,
    manifestHash: string, finalSha: string) => client.query(`INSERT INTO completion_final_reports(
      workspace_id,attempt_id,report_id,report_hash,story_closeout_decision_id,story_attempt_result_id,
      story_manifest_hash,active_subject_sha,gate_decision_id,gate_decision_hash,proposal_id,proposal_hash,
      final_sha,tree_hash,diff_hash,merge_ready,artifact_hash,payload_json)
      VALUES($1,$2,$3,$4,$3,$5,$6,$7,$8,$9,$10,$4,$7,$11,$12,TRUE,$4,$13::jsonb)`,
    [workspaceId, attemptId, decisionId, H2, attemptResultId, manifestHash, finalSha, gateId,
      gateHash, proposalId, treeHash, diffHash, reportPayload(decisionId, finalSha)]);

  const blockedManifestHash = `sha256:${fixtureHex('blocked-manifest')}`;
  const blocked = await writerPool.connect();
  await blocked.query('BEGIN');
  try {
    await blocked.query(`SELECT set_config('rorca.workspace_id',$1,TRUE)`, [workspaceId]);
    await issueCompletionCapability(blocked, 'completion.final-report', workspaceId, H2);
    await expect(insertReport(blocked, blockedDecisionId, blockedAttemptResultId, blockedManifestHash, gitSha))
      .rejects.toMatchObject({ code: expect.stringMatching(/^(?:23503|23514|42501)$/) });
    await blocked.query('ROLLBACK');
  } finally {
    blocked.release();
  }

  const differentSha = 'f'.repeat(40);
  const forged = await writerPool.connect();
  await forged.query('BEGIN');
  try {
    await forged.query(`SELECT set_config('rorca.workspace_id',$1,TRUE)`, [workspaceId]);
    await issueCompletionCapability(forged, 'completion.final-report', workspaceId, H2);
    await expect(insertReport(forged, acceptedDecisionId, acceptedAttemptResultId, acceptedManifestHash, differentSha))
      .rejects.toMatchObject({ code: '42501' });
    await forged.query('ROLLBACK');
  } finally {
    forged.release();
  }

  const lineage = await ownerPool.query(`SELECT s.status,s.spec_id,s.run_id::text,s.story_id,s.attempt,
    s.payload->>'decisionId' payload_decision,s.payload->>'status' payload_status,
    s.payload->'activeSubjectRevision'->>'commitSha' payload_sha,
    ar.payload->>'manifestHash' attempt_manifest,
    ar.payload->'identity'->>'workspaceId' attempt_workspace,
    ar.payload->'identity'->>'specId' attempt_spec,
    ar.payload->'identity'->>'runId' attempt_run,
    ar.payload->'identity'->>'storyId' attempt_story,
    ar.payload->'identity'->>'attempt' attempt_number,
    ge.attempt_id governed_attempt,ge.generation::text governed_generation,ge.current_sha governed_sha,
    w.payload_json->'spec'->>'specId' work_spec,w.payload_json->'spec'->>'storyId' work_story
    FROM story_closeout_decisions s
    LEFT JOIN story_attempt_results ar ON ar.attempt_result_id=s.attempt_result_id
    LEFT JOIN governed_execution_attempts ge ON ge.workspace_id=s.workspace_id AND ge.run_id=s.run_id AND ge.story_id=s.story_id
    LEFT JOIN governed_work_package_revisions w ON w.workspace_id=ge.workspace_id AND w.mission_id=ge.mission_id
      AND w.work_package_id=ge.work_package_id AND w.work_package_revision=ge.work_package_revision
    WHERE s.decision_id=$1`, [acceptedDecisionId]);
  expect(lineage.rows).toEqual([expect.objectContaining({
    status: 'accepted', spec_id: 'spec:completion', story_id: 'story:completion', attempt: 1,
    payload_decision: acceptedDecisionId, payload_status: 'accepted', payload_sha: gitSha,
    attempt_manifest: acceptedManifestHash, attempt_workspace: workspaceId, attempt_spec: 'spec:completion',
    attempt_story: 'story:completion', attempt_number: '1', governed_attempt: attemptId,
    governed_generation: '0', governed_sha: gitSha, work_spec: 'spec:completion', work_story: 'story:completion',
  })]);
  const exactAuthority = await writerPool.query(`SELECT story_attempt_result_id,story_manifest_hash,active_subject_sha
    FROM completion_final_report_authority_subject_v1($1,$2,$3::jsonb)`,
  [workspaceId, attemptId, reportPayload(acceptedDecisionId, gitSha)]);
  expect(exactAuthority.rows).toEqual([{
    story_attempt_result_id: acceptedAttemptResultId,
    story_manifest_hash: acceptedManifestHash,
    active_subject_sha: gitSha,
  }]);

  await writerTransaction(async (writer) => {
    await issueCompletionCapability(writer, 'completion.final-report', workspaceId, H2);
    await insertReport(writer, acceptedDecisionId, acceptedAttemptResultId, acceptedManifestHash, gitSha);
  });
  expect((await writerPool.query<{ report_id: string; final_sha: string }>(
    `SELECT report_id,final_sha FROM completion_final_reports WHERE workspace_id=$1`, [workspaceId],
  )).rows).toEqual([{ report_id: acceptedDecisionId, final_sha: gitSha }]);
});
