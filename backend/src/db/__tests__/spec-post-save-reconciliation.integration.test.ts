/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
import crypto from 'node:crypto';
import * as path from 'node:path';
import type PgBossInstance from 'pg-boss';
import { Pool } from 'pg';
import type * as DatabaseModule from '../index';
import type * as SpecPostSaveModule from '../spec-post-save';
import type * as ReconciliationModule from '../../lib/spec-post-save-reconciliation';
import type * as WorkflowModule from '../../lib/spec-post-save-workflow';
import type * as PgBossModule from '../../lib/pg-boss';

const runtimeUrl = process.env.DATABASE_URL!;
const migrationUrl = process.env.WAVE2_TEST_MIGRATION_DATABASE_URL!;
const schema = process.env.RORCA_PGBOSS_SCHEMA!;
const originalWorkspaceScope = Object.prototype.hasOwnProperty.call(
  process.env,
  'RORCA_TEST_DATABASE_WORKSPACE_SCOPE',
)
  ? { present: true as const, value: process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE! }
  : { present: false as const };
const workspaceId = `spec-post-save-reconciliation-${crypto.randomUUID()}`;
const specId = `wave-2-reconcile-${crypto.randomUUID()}`;
const crashFixtureName = `test_reconcile_audit_crash_${crypto.randomUUID().replace(/-/g, '')}`;
process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE = workspaceId;

const { closePool, pool: runtime } = require('../index') as typeof DatabaseModule;
const { hashEffectivePolicy } = require('../spec-post-save') as typeof SpecPostSaveModule;
const {
  reconcilePostSaveWorkflowStage,
} = require('../../lib/spec-post-save-reconciliation') as typeof ReconciliationModule;
const {
  startSpecPostSaveWorkflow,
  syncSpecPostSaveWorkflowStageFromJob,
} = require('../../lib/spec-post-save-workflow') as typeof WorkflowModule;
const pgBossModule = require('../../lib/pg-boss') as typeof PgBossModule;
const RealPgBoss: typeof PgBossInstance = require(
  path.resolve(__dirname, '../../../node_modules/pg-boss'),
);

const strictPolicy = { version: 'v1', presetId: 'skill_first_strict', context: 'capture', enrich: 'skip', skills: 'skip', memory: 'synthesize', onFailure: 'fail' };
const repairPolicy = { version: 'v1', presetId: 'repair_only', context: 'capture', enrich: 'skip', skills: 'skip', memory: 'skip', onFailure: 'continue' };

let owner: Pool;
let boss: PgBossInstance;
const operatorAuthority = { actorId: 'integration-local-admin', authorityClass: 'local_human_admin' as const };

async function dropCrashFixture(): Promise<void> {
  await owner.query(`DROP TRIGGER IF EXISTS "${crashFixtureName}" ON spec_post_save_reconciliation_audit`);
  await owner.query(`DROP FUNCTION IF EXISTS rorca."${crashFixtureName}"()`);
}

async function clearFixture(deleteWorkspace = false): Promise<void> {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    const transportJobs = await client.query<{ boss_job_id: string }>(
      `SELECT DISTINCT boss_job_id::text
         FROM spec_jobs
        WHERE workspace_id=$1 AND spec_id=$2 AND boss_job_id IS NOT NULL`,
      [workspaceId, specId],
    );
    const bossJobIds = transportJobs.rows.map((row) => row.boss_job_id);
    if (bossJobIds.length > 0) {
      await client.query(`DELETE FROM "${schema}".archive WHERE id=ANY($1::uuid[])`, [bossJobIds]);
      await client.query(`DELETE FROM "${schema}".job WHERE id=ANY($1::uuid[])`, [bossJobIds]);
    }

    await client.query(
      'ALTER TABLE spec_post_save_reconciliation_audit DISABLE TRIGGER spec_post_save_reconciliation_audit_immutable',
    );
    await client.query(
      'ALTER TABLE spec_post_save_reconciliation_operations DISABLE TRIGGER spec_post_save_reconciliation_operations_immutable',
    );
    await client.query('DELETE FROM spec_post_save_reconciliation_audit WHERE workspace_id=$1', [workspaceId]);
    await client.query('DELETE FROM spec_post_save_reconciliation_operations WHERE workspace_id=$1', [workspaceId]);
    await client.query(
      'ALTER TABLE spec_post_save_reconciliation_operations ENABLE TRIGGER spec_post_save_reconciliation_operations_immutable',
    );
    await client.query(
      'ALTER TABLE spec_post_save_reconciliation_audit ENABLE TRIGGER spec_post_save_reconciliation_audit_immutable',
    );

    await client.query(
      'DELETE FROM spec_post_save_workflow_runs WHERE workspace_id=$1 AND spec_id=$2',
      [workspaceId, specId],
    );
    await client.query('DELETE FROM spec_jobs WHERE workspace_id=$1 AND spec_id=$2', [workspaceId, specId]);
    await client.query('DELETE FROM spec_generation_logs WHERE spec_slug=$1', [specId]);
    if (deleteWorkspace) {
      await client.query('DELETE FROM workspaces WHERE id=$1', [workspaceId]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function ensurePostSaveQueues(): Promise<void> {
  await boss.createQueue('spec:memory-synthesis');
  await boss.createQueue('spec:enrich');
  await boss.createQueue('spec:match-skills');
}

async function seedEnrichCompletion() {
  const generation=733;const jobId=crypto.randomUUID();const bossJobId=crypto.randomUUID();
  const policy={...repairPolicy,enrich:'enqueue'};const policyHash=hashEffectivePolicy(policy);
  const log=(await owner.query<{id:number}>(`INSERT INTO spec_generation_logs(spec_slug,model,provider,duration_ms,context_summary,enriched,retrieval_method,context_summary_json,status,save_generation) VALUES($1,'offline','local',0,'fixture',false,'none',$2::jsonb,'persisted',$3) RETURNING id`,[specId,JSON.stringify({workspaceId,saveGeneration:generation,postSaveStages:{}}),generation])).rows[0];
  const run=(await owner.query<{id:number}>(`INSERT INTO spec_post_save_workflow_runs(workspace_id,spec_id,generation_log_id,save_generation,effective_policy_hash,effective_policy,idempotency_key,status,source) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,'running','repair') RETURNING id`,[workspaceId,specId,log.id,generation,policyHash,JSON.stringify(policy),`deadlock:${jobId}`])).rows[0];
  const metadata={origin:'persist-post-save',workflow:'spec-post-save-v1',workflowRunId:Number(run.id),stage:'enrich',saveGeneration:generation,generationLogId:log.id,effectivePolicyHash:policyHash,transportSchema:schema,queueName:'spec:enrich',bossJobId,priority:1,singletonKey:`persist-post-save:${workspaceId}:${specId}`};
  await owner.query(`INSERT INTO spec_jobs(id,spec_id,workspace_id,job_type,status,boss_job_id,transport_schema,save_generation,request_payload,finished_at) VALUES($1,$2,$3,'enrich','completed',$4,$5,$6,$7::jsonb,NOW())`,[jobId,specId,workspaceId,bossJobId,schema,generation,JSON.stringify(metadata)]);
  await owner.query(`INSERT INTO spec_post_save_workflow_stages(run_id,stage_key,requested,status,reason,finished_at) VALUES($1,'context',true,'completed','context_captured',NOW())`,[run.id]);
  const stage=(await owner.query<{id:number}>(`INSERT INTO spec_post_save_workflow_stages(run_id,stage_key,requested,status,reason,job_id,boss_job_id,queue_name,transport_schema,queue_status) VALUES($1,'enrich',true,'running','job_started',$2,$3,'spec:enrich',$4,'running') RETURNING id`,[run.id,jobId,bossJobId,schema])).rows[0];
  return {runId:Number(run.id),jobId,bossJobId,stageId:Number(stage.id)};
}

async function seedTopology(options: {
  applicationStatus?: 'pending' | 'running' | 'completed' | 'failed';
  stageStatus?: 'queued' | 'running' | 'completed' | 'failed';
  transportState?: 'created' | 'active' | 'completed' | 'failed' | 'missing';
} = {}) {
  const applicationStatus = options.applicationStatus ?? 'failed';
  const stageStatus = options.stageStatus ?? 'queued';
  const transportState = options.transportState ?? 'failed';
  const generation = 432;
  const jobId = crypto.randomUUID();
  const bossJobId = crypto.randomUUID();
  const log = (await owner.query<{ id: number }>(
    `INSERT INTO spec_generation_logs(spec_slug,model,provider,duration_ms,context_summary,enriched,retrieval_method,context_summary_json,status,save_generation)
     VALUES($1,'offline','local',0,'fixture',false,'none',$2::jsonb,'persisted',$3) RETURNING id`,
    [specId, JSON.stringify({ workspaceId, saveGeneration: generation, contextCaptureStatus: { status: 'provided' } }), generation],
  )).rows[0];
  const run80 = (await owner.query<{ id: number }>(
    `INSERT INTO spec_post_save_workflow_runs(workspace_id,spec_id,generation_log_id,save_generation,effective_policy_hash,effective_policy,idempotency_key,status,source)
     VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,'queued','repair') RETURNING id`,
    [workspaceId, specId, log.id, generation, hashEffectivePolicy(strictPolicy), JSON.stringify(strictPolicy), `strict:${jobId}`],
  )).rows[0];
  run80.id = Number(run80.id);
  await owner.query(
    `INSERT INTO spec_post_save_workflow_stages(run_id,stage_key,requested,status,reason,finished_at)
     VALUES($1,'context',true,'completed','context_captured',NOW()),
           ($1,'enrich',false,'skipped','disabled_by_policy',NOW()),
           ($1,'matchSkills',false,'skipped','disabled_by_policy',NOW())`,
    [run80.id],
  );
  const requestPayload = {
    origin: 'persist-post-save', workflow: 'spec-post-save-v1', workflowRunId: run80.id,
    stage: 'memorySynthesis', saveGeneration: generation, generationLogId: log.id,
    effectivePolicyHash: hashEffectivePolicy(strictPolicy), transportSchema: schema, queueName:'spec:memory-synthesis', bossJobId, priority: 1,
    singletonKey: `persist-post-save:${workspaceId}:${specId}`,
  };
  await owner.query(
    `INSERT INTO spec_jobs(id,spec_id,workspace_id,job_type,status,boss_job_id,transport_schema,save_generation,request_payload,error_message,started_at,finished_at)
     VALUES($1,$2,$3,'memory-synthesis',$4,$5,$6,$7,$8::jsonb,$9,NOW()-INTERVAL '1 hour',
       CASE WHEN $4 IN ('completed','failed') THEN NOW()-INTERVAL '50 minutes' ELSE NULL END)`,
    [jobId, specId, workspaceId, applicationStatus, bossJobId, schema, generation, JSON.stringify(requestPayload), applicationStatus === 'failed' ? 'offline fixture failure' : null],
  );
  await owner.query(
    `INSERT INTO spec_post_save_workflow_stages(run_id,stage_key,requested,status,reason,job_id,boss_job_id,queue_name,transport_schema,queue_status,updated_at)
     VALUES($1,'memorySynthesis',true,$2,'durable_job_enqueued',$3,$4,'spec:memory-synthesis',$5,
       CASE WHEN $2='running' THEN 'running' WHEN $2='queued' THEN 'queued' ELSE NULL END,NOW()-INTERVAL '45 minutes')`,
    [run80.id, stageStatus, jobId, bossJobId, schema],
  );
  const run93 = (await owner.query<{ id: number }>(
    `INSERT INTO spec_post_save_workflow_runs(workspace_id,spec_id,generation_log_id,save_generation,effective_policy_hash,effective_policy,idempotency_key,status,source,finished_at)
     VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,'failed','repair',NOW()) RETURNING id`,
    [workspaceId, specId, log.id, generation, hashEffectivePolicy(repairPolicy), JSON.stringify(repairPolicy), `repair:${jobId}`],
  )).rows[0];
  run93.id = Number(run93.id);

  if (transportState !== 'missing') {
    await boss.send('spec:memory-synthesis', { jobId, specId, workspaceId }, { id: bossJobId, retryLimit: 0 });
    if (transportState !== 'created') {
      const fetched = await boss.fetch('spec:memory-synthesis');
      expect(fetched[0]?.id).toBe(bossJobId);
      if (transportState === 'completed') await boss.complete('spec:memory-synthesis', bossJobId);
      else if (transportState === 'failed') await boss.fail('spec:memory-synthesis', bossJobId, { message: 'fixture terminal failure' });
      // fetched but unsettled is active transport work
    }
  }
  return { run80: Number(run80.id), run93: Number(run93.id), jobId, bossJobId };
}

beforeAll(async () => {
  if (!runtimeUrl || !migrationUrl || !schema) throw new Error('fresh Wave 2 DB URLs and RORCA_PGBOSS_SCHEMA are required');
  if (!/^pgboss(?:_[a-z0-9_]{1,48})?$/.test(schema)) throw new Error('RORCA_PGBOSS_SCHEMA is invalid');
  owner = new Pool({
    connectionString: migrationUrl,
    max: 1,
    options: `--search_path=rorca,public -c rorca.migration_mode=on -c rorca.workspace_id=${workspaceId}`,
  });
  await owner.query(
    `INSERT INTO workspaces (id,label,path)
     VALUES($1,'Spec post-save reconciliation integration',$2)`,
    [workspaceId, `/tmp/${workspaceId}`],
  );
  await pgBossModule.prepareSplitPrincipalPgBoss(migrationUrl, schema);
  boss = new RealPgBoss({ connectionString: runtimeUrl, schema, migrate: false });
  await boss.start();
  jest.spyOn(pgBossModule, 'initBoss').mockResolvedValue(undefined);
  jest.spyOn(pgBossModule, 'getBoss').mockImplementation(() => boss);
  await ensurePostSaveQueues();
});

beforeEach(async () => {
  await dropCrashFixture();
  await clearFixture();
});

afterEach(async () => {
  await dropCrashFixture();
  await clearFixture();
});

afterAll(async () => {
  const cleanupErrors: unknown[] = [];
  for (const cleanup of [
    dropCrashFixture,
    () => clearFixture(true),
    () => pgBossModule.stopBoss(),
    () => boss.stop({ graceful: false }),
    closePool,
    () => owner.end(),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  jest.restoreAllMocks();
  if (originalWorkspaceScope.present) {
    process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE = originalWorkspaceScope.value;
  } else {
    delete process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'spec-post-save reconciliation cleanup failed');
  }
});

describe('exact post-save reconciliation on fresh PostgreSQL 16', () => {
  test('settles only run 80 in the observed same-generation 80/93 topology', async () => {
    const fixture = await seedTopology();
    const result = await reconcilePostSaveWorkflowStage({
      workspaceId, specId, workflowRunId: fixture.run80, stageKey: 'memorySynthesis',
      applicationJobId: fixture.jobId, operationId: `integration:${fixture.jobId}`, source: 'operator', ...operatorAuthority,
    });
    expect(result).toMatchObject({ outcome: 'accepted', afterStatus: 'failed', transport: { state: 'failed' } });
    const runs = await owner.query<{ id: number; status: string }>(
      'SELECT id,status FROM spec_post_save_workflow_runs WHERE id=ANY($1::bigint[]) ORDER BY id',
      [[fixture.run80, fixture.run93]],
    );
    expect(runs.rows.map((row) => ({ ...row, id: Number(row.id) }))).toEqual([
      { id: fixture.run80, status: 'failed' },
      { id: fixture.run93, status: 'failed' },
    ]);
  });

  test('concurrent repair and stage-retry publication yields one exact application job, transport, and stage binding',async()=>{
    const generation=901;
    const log=(await owner.query<{id:number}>(`INSERT INTO spec_generation_logs(spec_slug,model,provider,duration_ms,context_summary,enriched,retrieval_method,context_summary_json,status,save_generation) VALUES($1,'offline','local',0,'fixture',false,'none',$2::jsonb,'persisted',$3) RETURNING id`,[specId,JSON.stringify({workspaceId,saveGeneration:generation,postSaveStages:{}}),generation])).rows[0];
    const policy={version:'v1' as const,presetId:'repair_only' as const,context:'capture' as const,enrich:'enqueue' as const,skills:'skip' as const,memory:'skip' as const,onFailure:'continue' as const};
    const base={workspaceId,specId,effectivePolicy:policy,saveGeneration:generation,generationLogId:log.id};
    const [repair,retry]=await Promise.all([startSpecPostSaveWorkflow({...base,source:'repair'}),startSpecPostSaveWorkflow({...base,source:'stage-retry'})]);
    expect(repair.id).toBe(retry.id);
    const rows=await owner.query<{job_id:string;boss_job_id:string;transport_schema:string;status:string}>(`SELECT stage.job_id,stage.boss_job_id,stage.transport_schema,stage.status FROM spec_post_save_workflow_stages stage WHERE stage.run_id=$1 AND stage.stage_key='enrich'`,[repair.id]);
    expect(rows.rows).toHaveLength(1);expect(rows.rows[0]).toMatchObject({status:'queued',transport_schema:schema});
    const jobs=await owner.query<{id:string;boss_job_id:string;transport_schema:string}>(`SELECT id,boss_job_id,transport_schema FROM spec_jobs WHERE workspace_id=$1 AND spec_id=$2 AND job_type='enrich'`,[workspaceId,specId]);
    expect(jobs.rows).toHaveLength(1);expect(jobs.rows[0]).toMatchObject({id:rows.rows[0].job_id,boss_job_id:rows.rows[0].boss_job_id,transport_schema:schema});
    const transport=await runtime.query<{id:string}>(`SELECT id::text FROM "${schema}".job WHERE id=$1::uuid`,[rows.rows[0].boss_job_id]);
    expect(transport.rows).toHaveLength(1);
  });

  test('worker sync and reconciliation share stage-to-run lock order without deadlock or completed-job regression',async()=>{
    const fixture=await seedEnrichCompletion();
    const reconciliation=reconcilePostSaveWorkflowStage({workspaceId,specId,workflowRunId:fixture.runId,stageKey:'enrich',applicationJobId:fixture.jobId,operationId:`deadlock:${fixture.jobId}`,source:'operator',...operatorAuthority});
    const raced=Promise.all([syncSpecPostSaveWorkflowStageFromJob(fixture.jobId),reconciliation]);
    const [,result]=await Promise.race([raced,new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('stage-run deadlock timeout')),5000))]);
    expect(result.outcome).toMatch(/accepted|no_op/);
    const state=await owner.query<{job_status:string;stage_status:string;run_status:string}>(`SELECT job.status job_status,stage.status stage_status,run.status run_status FROM spec_jobs job JOIN spec_post_save_workflow_stages stage ON stage.job_id=job.id JOIN spec_post_save_workflow_runs run ON run.id=stage.run_id WHERE job.id=$1`,[fixture.jobId]);
    expect(state.rows[0]).toEqual({job_status:'completed',stage_status:'completed',run_status:'completed'});
  });

  test('serializes duplicate concurrent reconcile into accepted plus no-op', async () => {
    const fixture = await seedTopology({ transportState: 'missing' });
    const [a, b] = await Promise.all([
      reconcilePostSaveWorkflowStage({ workspaceId, specId, workflowRunId: fixture.run80, stageKey: 'memorySynthesis', applicationJobId: fixture.jobId, operationId: `race:a:${fixture.jobId}`, source: 'repair', ...operatorAuthority }),
      reconcilePostSaveWorkflowStage({ workspaceId, specId, workflowRunId: fixture.run80, stageKey: 'memorySynthesis', applicationJobId: fixture.jobId, operationId: `race:b:${fixture.jobId}`, source: 'stage_retry', ...operatorAuthority }),
    ]);
    expect([a.outcome, b.outcome].sort()).toEqual(['accepted', 'no_op']);
  });

  test('rejects live/nonterminal transport and wrong workflow/spec/workspace/job fences', async () => {
    const fixture = await seedTopology({ applicationStatus: 'running', stageStatus: 'running', transportState: 'active' });
    const live = await reconcilePostSaveWorkflowStage({ workspaceId, specId, workflowRunId: fixture.run80, stageKey: 'memorySynthesis', applicationJobId: fixture.jobId, operationId: `live:${fixture.jobId}`, source: 'operator', ...operatorAuthority });
    expect(live).toMatchObject({ outcome: 'rejected', reasonCode: 'transport_live_work', afterStatus: 'running' });
    for (const [label, patch] of [
      ['workspace', { workspaceId: 'workspace:other' }],
      ['spec', { specId: 'wrong-spec' }],
      ['run', { workflowRunId: fixture.run93 }],
      ['job', { applicationJobId: crypto.randomUUID() }],
    ] as const) {
      const request = {
        workspaceId, specId, workflowRunId: fixture.run80, stageKey: 'memorySynthesis' as const,
        applicationJobId: fixture.jobId, operationId: `wrong:${label}:${crypto.randomUUID()}`, source: 'operator' as const, ...operatorAuthority,
      };
      Object.assign(request, patch);
      const rejected = await reconcilePostSaveWorkflowStage(request);
      expect(rejected.outcome).toBe('rejected');
    }
    const stage = await owner.query<{ status: string }>('SELECT status FROM spec_post_save_workflow_stages WHERE run_id=$1 AND stage_key=$2', [fixture.run80, 'memorySynthesis']);
    expect(stage.rows[0].status).toBe('running');
  });

  test('inspects the persisted transport schema across process drift and fails closed when schema identity is missing',async()=>{
    const fixture=await seedTopology({applicationStatus:'running',stageStatus:'running',transportState:'active'});
    const configured=process.env.RORCA_PGBOSS_SCHEMA;process.env.RORCA_PGBOSS_SCHEMA='pgboss_drifted_process';
    try {
      const oldLive=await reconcilePostSaveWorkflowStage({workspaceId,specId,workflowRunId:fixture.run80,stageKey:'memorySynthesis',applicationJobId:fixture.jobId,operationId:`schema-live:${fixture.jobId}`,source:'operator',...operatorAuthority});
      expect(oldLive).toMatchObject({outcome:'rejected',reasonCode:'transport_live_work',transport:{state:'active'}});
      await owner.query('UPDATE spec_jobs SET transport_schema=NULL WHERE id=$1',[fixture.jobId]);
      await owner.query('UPDATE spec_post_save_workflow_stages SET transport_schema=NULL WHERE run_id=$1 AND stage_key=$2',[fixture.run80,'memorySynthesis']);
      const missing=await reconcilePostSaveWorkflowStage({workspaceId,specId,workflowRunId:fixture.run80,stageKey:'memorySynthesis',applicationJobId:fixture.jobId,operationId:`schema-missing:${fixture.jobId}`,source:'operator',...operatorAuthority});
      expect(missing).toMatchObject({outcome:'rejected',reasonCode:expect.stringMatching(/transport_schema/)});
    } finally { process.env.RORCA_PGBOSS_SCHEMA=configured; }
  });

  test('rolls back the stage transition when the audit crash seam fails, then succeeds after restart', async () => {
    const fixture = await seedTopology({ transportState: 'missing' });
    await owner.query(`CREATE FUNCTION rorca."${crashFixtureName}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture crash seam'; END $$`);
    await owner.query(`CREATE TRIGGER "${crashFixtureName}" BEFORE INSERT ON spec_post_save_reconciliation_audit FOR EACH ROW EXECUTE FUNCTION rorca."${crashFixtureName}"()`);
    const crashed = await reconcilePostSaveWorkflowStage({ workspaceId, specId, workflowRunId: fixture.run80, stageKey: 'memorySynthesis', applicationJobId: fixture.jobId, operationId: `crash:${fixture.jobId}`, source: 'operator', ...operatorAuthority });
    expect(crashed).toMatchObject({ outcome: 'rejected', reasonCode: 'reconciliation_evidence_unavailable', auditId: null });
    expect((await owner.query<{ status: string }>('SELECT status FROM spec_post_save_workflow_stages WHERE run_id=$1 AND stage_key=$2', [fixture.run80, 'memorySynthesis'])).rows[0].status).toBe('queued');
    await dropCrashFixture();

    await boss.stop({ graceful: false });
    const restarted = await reconcilePostSaveWorkflowStage({ workspaceId, specId, workflowRunId: fixture.run80, stageKey: 'memorySynthesis', applicationJobId: fixture.jobId, operationId: `restart:${fixture.jobId}`, source: 'operator', ...operatorAuthority });
    expect(restarted).toMatchObject({ outcome: 'accepted', afterStatus: 'failed' });
    boss = new RealPgBoss({ connectionString: runtimeUrl, schema, migrate: false });
    await boss.start();
    await ensurePostSaveQueues();
  });

  test('returns exact bounded idempotent replay, permanently conflicts changed reuse, and bounds audit growth per actor',async()=>{
    const fixture=await seedTopology({transportState:'missing'});
    const key=`replay:${fixture.jobId}`;
    const request={workspaceId,specId,workflowRunId:fixture.run80,stageKey:'memorySynthesis' as const,applicationJobId:fixture.jobId,operationId:key,source:'operator' as const,...operatorAuthority};
    const first=await reconcilePostSaveWorkflowStage(request);
    const replay=await reconcilePostSaveWorkflowStage(request);
    expect(first).toEqual(replay);expect(first.outcome).toBe('accepted');
    const changedRequest={...request,applicationJobId:crypto.randomUUID()};
    const changed=await reconcilePostSaveWorkflowStage(changedRequest);
    const changedAgain=await reconcilePostSaveWorkflowStage(changedRequest);
    expect(changed).toMatchObject({outcome:'rejected',reasonCode:'idempotency_key_reused_with_changed_request'});
    expect(changedAgain.auditId).toBe(changed.auditId);
    const counts=await owner.query<{operations:string;audits:string;conflicts:string}>(
      `SELECT (SELECT count(*) FROM spec_post_save_reconciliation_operations WHERE workspace_id=$1 AND actor_id=$2)::text operations,
              (SELECT count(*) FROM spec_post_save_reconciliation_audit audit WHERE audit.operation_receipt_id=operation.id)::text audits,
              (SELECT count(*) FROM spec_post_save_reconciliation_audit audit WHERE audit.operation_receipt_id=operation.id AND reason_code='idempotency_key_reused_with_changed_request')::text conflicts
         FROM spec_post_save_reconciliation_operations operation
        WHERE operation.workspace_id=$1 AND operation.actor_id=$2 ORDER BY operation.id DESC LIMIT 1`,
      [workspaceId,operatorAuthority.actorId],
    );
    expect(counts.rows[0]).toMatchObject({conflicts:'1'});
    const crossActor=await reconcilePostSaveWorkflowStage({...request,actorId:'integration-other-admin'});
    expect(crossActor).toMatchObject({outcome:'no_op',reasonCode:'stage_already_reconciled'});
  });

  test('never promotes a required failed stage from caller-fabricated completion', async () => {
    const fixture = await seedTopology({ applicationStatus: 'completed', stageStatus: 'failed', transportState: 'completed' });
    const result = await reconcilePostSaveWorkflowStage({ workspaceId, specId, workflowRunId: fixture.run80, stageKey: 'memorySynthesis', applicationJobId: fixture.jobId, operationId: `fabricated:${fixture.jobId}`, source: 'operator', ...operatorAuthority });
    expect(result).toMatchObject({ outcome: 'rejected', reasonCode: 'required_failed_stage_cannot_be_promoted', afterStatus: 'failed' });
    expect((await owner.query<{ status: string }>('SELECT status FROM spec_post_save_workflow_stages WHERE run_id=$1 AND stage_key=$2', [fixture.run80, 'memorySynthesis'])).rows[0].status).toBe('failed');
  });
});
