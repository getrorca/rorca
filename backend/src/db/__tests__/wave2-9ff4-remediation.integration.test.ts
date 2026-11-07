/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { closePool, pool } from '../index';
import { getJobByTransportOwnership,terminalizeOwnedSpecJobTransportFailure } from '../spec-jobs';

const H=`sha256:${'9'.repeat(64)}`;
const H2=`sha256:${'8'.repeat(64)}`;
const writerUrl=process.env.RORCA_CANONICAL_WRITER_DATABASE_URL;
if(!writerUrl)throw new Error('RORCA_CANONICAL_WRITER_DATABASE_URL is required');
const writerPool=new Pool({connectionString:writerUrl,options:'--search_path=rorca_canonical_api,rorca,public -c rorca.workspace_id=workspace:wave-two'});
const migrationUrl=process.env.WAVE2_TEST_MIGRATION_DATABASE_URL;
if(!migrationUrl)throw new Error('WAVE2_TEST_MIGRATION_DATABASE_URL is required');
const ownerPool=new Pool({connectionString:migrationUrl,options:'--search_path=rorca,public -c rorca.migration_mode=on -c rorca.workspace_id=workspace:wave-two'});
const canonicalRelations=['governed_missions','governed_mission_versions','governed_mission_heads','governed_work_packages',
  'governed_work_package_revisions','governed_work_package_dependencies','governed_work_package_heads','execution_lease_slots',
  'execution_leases','execution_lease_events','context_policy_definitions','context_policy_activations','context_policy_activation_heads',
  'context_scope_heads','context_checkpoints','context_retrieval_receipts','context_retrieval_sources','context_bundles','context_bundle_deltas',
  'continuation_retry_budgets','continuation_retry_events','continuation_quarantines','continuation_dispatches',
  'continuation_dispatch_consumptions','continuation_dispatch_outbox','continuation_dispatch_outcomes','continuation_dispatch_acceptances',
  'runtime_event_stream_heads','runtime_events','runtime_event_conflicts','ssdlc_lifecycle_evidence','governed_closeout_evaluations',
  'execution_cancellation_requests','execution_cancellation_acknowledgements','plan_change_proposals','plan_change_proposal_heads',
  'plan_change_proposal_reviews','mission_control_idempotency','mission_control_replay_conflicts','mission_control_audit',
  'context_epoch_retirement_evaluations'];

beforeAll(async()=>{
  await ownerPool.query(`INSERT INTO workspaces(id,label,path)
    VALUES('workspace:wave-two','Wave Two remediation fixture',$1)
    ON CONFLICT (id) DO NOTHING`,[process.cwd()]);
});

afterAll(async()=>{await Promise.all([closePool(),writerPool.end(),ownerPool.end()]);});

test('ordinary runtime has neither canonical mutation issuance nor canonical relation DML',async()=>{
  const capability=await pool.query<{legacy_allowed:boolean;writer_allowed:boolean}>(`SELECT
    has_function_privilege(current_user,'rorca.authorize_wave2_runtime_mutation_v1(text,text,text,text,jsonb)','EXECUTE') legacy_allowed,
    has_function_privilege(current_user,'rorca.authorize_wave2_canonical_writer_mutation_v3(text,text,text,text,jsonb)','EXECUTE') writer_allowed`);
  expect(capability.rows[0]).toEqual({legacy_allowed:false,writer_allowed:false});
  const relations=['continuation_dispatch_outbox','continuation_dispatches','continuation_dispatch_outcomes',
    'continuation_retry_budgets','continuation_retry_events','mission_control_audit','mission_control_idempotency'];
  const grants=await pool.query<{relation_name:string;can_insert:boolean;can_update:boolean;can_delete:boolean}>(`SELECT relation_name,
    has_table_privilege(current_user,'rorca.'||relation_name,'INSERT') can_insert,
    has_table_privilege(current_user,'rorca.'||relation_name,'UPDATE') can_update,
    has_table_privilege(current_user,'rorca.'||relation_name,'DELETE') can_delete
    FROM unnest($1::text[]) relation_name`,[relations]);
  expect(grants.rows).toHaveLength(relations.length);
  expect(grants.rows.every(row=>!row.can_insert&&!row.can_update&&!row.can_delete)).toBe(true);
});

test('canonical writer has no base-table DML on every mutable relation and only the HMAC issuer is executable',async()=>{
  const grants=await writerPool.query<{relation_name:string;can_insert:boolean;can_update:boolean;can_delete:boolean;api_insert:boolean}>(`SELECT relation_name,
    has_table_privilege(current_user,'rorca.'||relation_name,'INSERT') can_insert,
    has_table_privilege(current_user,'rorca.'||relation_name,'UPDATE') can_update,
    has_table_privilege(current_user,'rorca.'||relation_name,'DELETE') can_delete,
    has_table_privilege(current_user,'rorca_canonical_api.'||relation_name,'INSERT') api_insert
    FROM unnest($1::text[]) relation_name`,[canonicalRelations]);
  expect(grants.rows).toHaveLength(canonicalRelations.length);
  expect(grants.rows.every(row=>!row.can_insert&&!row.can_update&&!row.can_delete&&row.api_insert)).toBe(true);
  const issuers=await writerPool.query<{v2:boolean;v3:boolean}>(`SELECT
    has_function_privilege(current_user,'rorca.authorize_wave2_canonical_writer_mutation_v2(text,text,text,text,jsonb)','EXECUTE') v2,
    has_function_privilege(current_user,'rorca.authorize_wave2_canonical_writer_mutation_v3(text,text,text,text,jsonb)','EXECUTE') v3`);
  expect(issuers.rows[0]).toEqual({v2:false,v3:true});
  await expect(writerPool.query(`INSERT INTO rorca_canonical_api.mission_control_audit
    (workspace_id,operation,actor_id,authority_source,request_hash,subject_hash,decision,result_code,correlation_id,metadata_json)
    VALUES('workspace:wave-two','mutation-rejection.audit','attacker','forged',$1,$1,'accepted','forged','forged','{}')`,[H]))
    .rejects.toMatchObject({code:'42501'});
});

test('a valid HMAC capability cannot cross its operation into another canonical relation',async()=>{
  const client=await writerPool.connect();
  try{
    await client.query('BEGIN');
    await client.query(`SELECT set_config('rorca.workspace_id','workspace:wave-two',TRUE)`);
    await client.query(`SELECT rorca.authorize_wave2_canonical_writer_mutation_v3('workspace:wave-two','mutation-rejection.audit',$1,$1,$2::jsonb)`,
      [H,JSON.stringify({operation:'test.rejection',request:{bounded:true}})]);
    await expect(client.query(`INSERT INTO rorca_canonical_api.continuation_dispatch_outcomes
      (workspace_id,dispatch_id,outcome_sequence,claim_fence,outcome_hash,outcome_state,transport_accepted,reason_code)
      VALUES('workspace:wave-two','dispatch:forged',1,1,$1,'sent',TRUE,'forged')`,[H]))
      .rejects.toMatchObject({code:'42501'});
    await client.query('ROLLBACK');
  }finally{client.release();}
});

test.each([
  ['audit-first',['mutation-rejection.audit','context-epoch-retirement.evaluate']],
  ['retirement-first',['context-epoch-retirement.evaluate','mutation-rejection.audit']],
])('multiple relation-compatible capabilities fail closed regardless of issuance order: %s',async(_label,operations)=>{
  const client=await writerPool.connect();
  try{
    await client.query('BEGIN');
    await client.query(`SELECT set_config('rorca.workspace_id','workspace:wave-two',TRUE)`);
    for(const operation of operations){
      const request=operation==='mutation-rejection.audit'?{operation:'test.rejection',request:{bounded:true}}
        :{workspaceId:'workspace:wave-two',evaluationId:'evaluation:ambiguous'};
      await client.query(`SELECT rorca.authorize_wave2_canonical_writer_mutation_v3('workspace:wave-two',$1,$2,$2,$3::jsonb)`,
        [operation,operation==='mutation-rejection.audit'?H:H2,JSON.stringify(request)]);
    }
    await expect(client.query(`INSERT INTO rorca_canonical_api.mission_control_audit
      (workspace_id,operation,actor_id,authority_source,request_hash,subject_hash,decision,result_code,correlation_id,metadata_json)
      VALUES('workspace:wave-two','test.rejection','test:writer','diagnostic',$1,$1,'blocked','test','test:ambiguous','{}')`,[H]))
      .rejects.toMatchObject({code:'42501'});
    await client.query('ROLLBACK');
  }finally{client.release();}
});

test('one operation capability cannot be reissued to reset its effect cardinality',async()=>{
  const client=await writerPool.connect();
  try{
    await client.query('BEGIN');
    await client.query(`SELECT set_config('rorca.workspace_id','workspace:wave-two',TRUE)`);
    const request=JSON.stringify({operation:'test.rejection',request:{bounded:true}});
    await client.query(`SELECT rorca.authorize_wave2_canonical_writer_mutation_v3('workspace:wave-two','mutation-rejection.audit',$1,$1,$2::jsonb)`,[H,request]);
    await expect(client.query(`SELECT rorca.authorize_wave2_canonical_writer_mutation_v3('workspace:wave-two','mutation-rejection.audit',$1,$1,$2::jsonb)`,[H,request]))
      .rejects.toMatchObject({code:'42501'});
    await client.query('ROLLBACK');
  }finally{client.release();}
});

test('a capability cannot be reused for a changed row even within its allowed relation and operation',async()=>{
  const client=await writerPool.connect();
  try{
    await client.query('BEGIN');
    await client.query(`SELECT set_config('rorca.workspace_id','workspace:wave-two',TRUE)`);
    await client.query(`SELECT rorca.authorize_wave2_canonical_writer_mutation_v3('workspace:wave-two','mutation-rejection.audit',$1,$1,$2::jsonb)`,
      [H,JSON.stringify({operation:'test.rejection',request:{bounded:true}})]);
    await client.query(`INSERT INTO rorca_canonical_api.mission_control_audit
      (workspace_id,operation,actor_id,authority_source,request_hash,subject_hash,decision,result_code,correlation_id,metadata_json)
      VALUES('workspace:wave-two','test.rejection','test:writer','diagnostic',$1,$1,'blocked','test','test:exact','{}')`,[H]);
    await expect(client.query(`INSERT INTO rorca_canonical_api.mission_control_audit
      (workspace_id,operation,actor_id,authority_source,request_hash,subject_hash,decision,result_code,correlation_id,metadata_json)
      VALUES('workspace:wave-two','test.rejection','test:writer','diagnostic',$1,$1,'blocked','test','test:second-row','{}')`,
    [H])).rejects.toMatchObject({code:'42501'});
    await client.query('ROLLBACK');
  }finally{client.release();}
});

test('broker identity resolves and terminalizes its exact application owner with attempt evidence atomically',async()=>{
  const jobId=randomUUID();
  const bossJobId=randomUUID();
  await pool.query(`INSERT INTO spec_jobs(id,workspace_id,spec_id,job_type,status,boss_job_id,transport_schema,request_payload)
    VALUES($1,'workspace:wave-two','spec:poison','enrich','pending',$2,'pgboss_xhigh','{}')`,[jobId,bossJobId]);
  expect(await getJobByTransportOwnership(bossJobId,'pgboss_xhigh','spec:enrich')).toEqual(expect.objectContaining({id:jobId,status:'pending'}));
  const terminal=await terminalizeOwnedSpecJobTransportFailure({bossJobId,transportSchema:'pgboss_xhigh',queueName:'spec:enrich',
    reasonCode:'invalid_transport_payload'});
  expect(terminal).toEqual(expect.objectContaining({id:jobId,status:'failed'}));
  const truth=await pool.query<{status:string;outcome:string;reason_code:string}>(`SELECT job.status,attempt.outcome,attempt.reason_code
    FROM spec_jobs job JOIN spec_job_transport_attempts attempt ON attempt.workspace_id=job.workspace_id AND attempt.job_id=job.id
    WHERE job.id=$1 AND attempt.phase='terminal'`,[jobId]);
  expect(truth.rows).toEqual([{status:'failed',outcome:'rejected',reason_code:'invalid_transport_payload'}]);
});

test('repair effect completion loses to an expired claim before any next effect can be authorized',async()=>{
  const owner=randomUUID();
  const actorId=`test:repair-fence:${owner}`;
  const operationHash=`sha256:${owner.replaceAll('-','').padEnd(64,'0')}`;
  const inserted=await pool.query<{id:string;claim_fence:string}>(`INSERT INTO spec_repair_operations
    (workspace_id,actor_id,surface,operation_key_hash,request_hash,status,claim_owner,claim_fence,lease_expires_at)
    VALUES('workspace:wave-two',$1,'repair',$2,$2,'in_progress',$3,1,clock_timestamp()+interval '30 seconds')
    RETURNING id,claim_fence`,[actorId,operationHash,owner]);
  const operationId=inserted.rows[0]!.id;
  await pool.query(`INSERT INTO spec_repair_effect_receipts
    (workspace_id,operation_id,claim_fence,effect_sequence,effect_kind,effect_hash,state)
    VALUES('workspace:wave-two',$1,1,1,'test.effect',$2,'authorized')`,[operationId,H]);
  await pool.query(`UPDATE spec_repair_operations SET lease_expires_at=clock_timestamp()-interval '1 second'
    WHERE id=$1 AND claim_owner=$2 AND claim_fence=1`,[operationId,owner]);
  const completed=await pool.query(`UPDATE spec_repair_effect_receipts receipt SET state='completed',completed_at=clock_timestamp()
    FROM spec_repair_operations operation
    WHERE receipt.workspace_id='workspace:wave-two' AND receipt.operation_id=$1 AND receipt.claim_fence=1
      AND receipt.effect_sequence=1 AND receipt.state='authorized' AND operation.id=receipt.operation_id
      AND operation.workspace_id=receipt.workspace_id AND operation.status='in_progress' AND operation.claim_owner=$2
      AND operation.claim_fence=1 AND operation.lease_expires_at>statement_timestamp()`,[operationId,owner]);
  expect(completed.rowCount).toBe(0);
  const nextAuthorization=await pool.query(`UPDATE spec_repair_operations SET lease_expires_at=statement_timestamp()+interval '2 minutes'
    WHERE id=$1 AND status='in_progress' AND claim_owner=$2 AND claim_fence=1 AND lease_expires_at>statement_timestamp()`,
  [operationId,owner]);
  expect(nextAuthorization.rowCount).toBe(0);
  const receipt=await pool.query<{state:string}>(`SELECT state FROM spec_repair_effect_receipts
    WHERE workspace_id='workspace:wave-two' AND operation_id=$1`,[operationId]);
  expect(receipt.rows).toEqual([{state:'authorized'}]);
  await expect(pool.query(`INSERT INTO spec_repair_effect_receipts
    (workspace_id,operation_id,claim_fence,effect_sequence,effect_kind,effect_hash,state)
    VALUES('workspace:wave-two',$1,2,1,'test.effect',$2,'authorized')`,[operationId,H]))
    .rejects.toMatchObject({code:'23505'});
});
