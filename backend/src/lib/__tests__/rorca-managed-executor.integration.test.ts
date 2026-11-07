/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */
import crypto from 'node:crypto';
import { Pool } from 'pg';

const ownerUrl=process.env.RORCA_MIGRATION_DATABASE_URL??process.env.WAVE2_TEST_MIGRATION_DATABASE_URL;
const writerUrl=process.env.RORCA_CANONICAL_WRITER_DATABASE_URL;
const runtimeUrl=process.env.DATABASE_URL;
if(!ownerUrl||!writerUrl||!runtimeUrl)throw new Error('Managed executor DB integration requires owner, canonical writer, and runtime database URLs');

const suffix=crypto.randomUUID();
const workspaceA=`workspace:managed-db-a-${suffix}`;
const workspaceB=`workspace:managed-db-b-${suffix}`;
const runtimeA=`runtime:managed-db-a-${suffix}`;
const runtimeB=`runtime:managed-db-b-${suffix}`;
const missionId=`mission:managed-db-${suffix}`;
const workPackageId=`work-package:managed-db-${suffix}`;
const hash=(digit:string)=>`sha256:${digit.repeat(64)}`;
const git=(digit:string)=>digit.repeat(40);
const owner=new Pool({connectionString:ownerUrl,options:'--search_path=rorca,public -c rorca.migration_mode=on'});
const writer=new Pool({connectionString:writerUrl,options:'--search_path=rorca,public'});
const runtime=new Pool({connectionString:runtimeUrl,options:'--search_path=rorca,public'});
const quotaDimensions=['cpuMillis','memoryBytes','executionConcurrency','continuationConcurrency','eventCount','contextBytes','contextTokens','storageBytes','storageObjects','retrySpend','providerTokens','providerMicrounits'] as const;
const quota=(amount:number)=>Object.fromEntries(quotaDimensions.map((dimension)=>[dimension,amount]));
const policyVersion=`quota-policy:${suffix}`;
const now=new Date(Date.now()-60_000).toISOString();
const future=new Date(Date.now()+3_600_000).toISOString();

function dependency(status:'healthy'|'unknown'='healthy'){
  return {dependencyId:'dependency:canonical-context',requirement:'required',contractVersion:'1.0.0',compatibleContractVersions:['1.0.0'],status,observedAt:now,validUntil:future,
    rateLimit:{remaining:100,resetAt:future},circuit:{state:'closed',revision:1},quota:{available:true,headroom:100},fallback:{eligible:false,runtimeId:null}};
}
function snapshot(workspaceId:string,runtimeId:string,id:string,digit:string,status:'healthy'|'unknown'='healthy'){
  return {schemaVersion:'rorca.managed-capability-snapshot.v1',snapshotId:id,snapshotHash:hash(digit),policyVersion:'capability-policy:1',workspaceId,runtimeId,
    providerId:'provider:pi',role:'worker',principalId:`principal:${id}`,providerAuthReferenceId:`auth-ref:${id}`,providerBudgetId:`budget:${id}`,
    rateLimitIdentity:`rate:${id}`,circuitIdentity:`circuit:${id}`,processIdentity:`process:${id}`,queueIdentity:`queue:${id}`,observedAt:now,validUntil:future,
    dependencies:[dependency(status)],decisionSource:'canonical_snapshot'};
}

async function seedWorkspace(workspaceId:string,runtimeId:string,digit:string){
  const attemptId=`attempt:${workspaceId}`;const leaseId=`lease:${workspaceId}`;const slot=hash(digit);
  const spec={specId:`spec:${workspaceId}`,specVersion:1,specHash:hash('1'),canonicalSpecPath:'forge/specs/managed-db.json',storyId:`story:${workspaceId}`,storyVersion:1,
    storyHash:hash('2'),criteriaManifestHash:hash('3')};
  const repository={repositoryId:`repository:${workspaceId}`,baseSha:git('a'),currentSha:git('a'),expectedHeadSha:git('a'),worktreeId:`worktree:${workspaceId}`,
    allowedPathManifestHash:hash('4'),requiredPathManifestHash:hash('5'),changedPathManifestHash:hash('6'),forbiddenPathManifestHash:hash('7')};
  const missionHash=hash('8');const workPackageHash=hash('9');
  const client=await owner.connect();
  try{
    await client.query('BEGIN');await client.query(`SELECT set_config('rorca.migration_mode','on',TRUE)`);
    await client.query('INSERT INTO rorca.workspaces(id,label,path) VALUES($1,$2,$3)',[workspaceId,workspaceId,`/tmp/${workspaceId}`]);
    await client.query('INSERT INTO rorca.governed_missions(workspace_id,mission_id,created_by) VALUES($1,$2,$3)',[workspaceId,missionId,'host:managed-db']);
    await client.query(`INSERT INTO rorca.governed_mission_versions(workspace_id,mission_id,mission_revision,mission_hash,contract_version,canonical_spec_id,canonical_spec_version,
      canonical_spec_hash,canonical_spec_path,repository_id,base_sha,payload_json,payload_hash,created_by) VALUES($1,$2,1,$3,'1.0.0',$4,1,$5,$6,$7,$8,$9::jsonb,$10,'host:managed-db')`,
      [workspaceId,missionId,missionHash,spec.specId,spec.specHash,spec.canonicalSpecPath,repository.repositoryId,repository.baseSha,JSON.stringify({workspaceId,missionId,missionRevision:1,missionHash,canonicalSpec:spec,repository}),hash('a')]);
    await client.query('INSERT INTO rorca.governed_work_packages(workspace_id,mission_id,work_package_id,created_by) VALUES($1,$2,$3,$4)',[workspaceId,missionId,workPackageId,'host:managed-db']);
    await client.query(`INSERT INTO rorca.governed_work_package_revisions(workspace_id,mission_id,work_package_id,work_package_revision,work_package_hash,mission_revision,mission_hash,
      story_id,repository_id,base_sha,allowed_path_manifest_hash,required_path_manifest_hash,validation_manifest_hash,authority_ceiling_hash,payload_json,proposal_id)
      VALUES($1,$2,$3,1,$4,1,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)`,
      [workspaceId,missionId,workPackageId,workPackageHash,missionHash,spec.storyId,repository.repositoryId,repository.baseSha,repository.allowedPathManifestHash,
        repository.requiredPathManifestHash,hash('b'),hash('c'),JSON.stringify({workspaceId,missionId,workPackageId,workPackageRevision:1,workPackageHash,missionRevision:1,missionHash,spec,
          repository:{...repository,remoteAuthorityHash:hash('d'),gitObjectFormat:'sha1'},allowedPaths:['backend/src/lib'],requiredPaths:['backend/src/lib'],state:'active'}),`proposal:${workspaceId}`]);
    await client.query(`INSERT INTO rorca.governed_execution_attempts(workspace_id,attempt_id,mission_id,work_package_id,work_package_revision,run_id,story_id,runtime_id,generation,
      manifest_hash,repository_id,worktree_id,spec_id,spec_version,spec_hash,story_version,story_hash,criteria_manifest_hash,base_sha,current_sha,expected_head_sha,
      allowed_path_manifest_hash,required_path_manifest_hash,changed_path_manifest_hash,forbidden_path_manifest_hash)
      VALUES($1,$2,$3,$4,1,1,$5,$6,0,$7,$8,$9,$10,1,$11,1,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [workspaceId,attemptId,missionId,workPackageId,spec.storyId,runtimeId,hash('e'),repository.repositoryId,repository.worktreeId,spec.specId,spec.specHash,spec.storyHash,
        spec.criteriaManifestHash,repository.baseSha,repository.currentSha,repository.expectedHeadSha,repository.allowedPathManifestHash,repository.requiredPathManifestHash,
        repository.changedPathManifestHash,repository.forbiddenPathManifestHash]);
    await client.query('INSERT INTO rorca.execution_lease_slots(workspace_id,lease_slot_key,last_fence,active_lease_id) VALUES($1,$2,1,$3)',[workspaceId,slot,leaseId]);
    await client.query(`INSERT INTO rorca.execution_leases(workspace_id,lease_id,lease_slot_key,attempt_id,fencing_token,work_package_revision,runtime_id,repository_id,base_sha,current_sha,
      worktree_id,policy_definition_hash,policy_activation_hash,checkpoint_hash,bundle_hash,cancellation_id,issued_at,expires_at,state,payload_hash)
      VALUES($1,$2,$3,$4,1,1,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'active',$17)`,
      [workspaceId,leaseId,slot,attemptId,runtimeId,repository.repositoryId,repository.baseSha,repository.currentSha,repository.worktreeId,hash('f'),hash('1'),hash('2'),hash('3'),
        `cancellation:${workspaceId}`,now,future,hash('4')]);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  return {attemptId,leaseId};
}

async function reserve(input:{workspaceId:string;runtimeId:string;attemptId:string;leaseId:string;reservationId:string;requestHash:string;snapshotHash:string;amount:number}){
  const result=await writer.query<{admitted:boolean;duplicate:boolean;reason_code:string}>(
    'SELECT * FROM rorca.reserve_managed_executor_quota_v1($1,$2,$3,0,$4,1,$5,$6,$7,$8,$9::jsonb,$10::timestamptz)',
    [input.workspaceId,input.runtimeId,input.attemptId,input.leaseId,input.reservationId,input.requestHash,input.snapshotHash,policyVersion,JSON.stringify(quota(input.amount)),future]);
  return result.rows[0]!;
}

describe('RorcaManagedExecutor PostgreSQL admission',()=>{
  let a:{attemptId:string;leaseId:string};let b:{attemptId:string;leaseId:string};
  beforeAll(async()=>{
    const readiness=await owner.query(`SELECT state,migration_version,wave2_implementation_git_sha FROM rorca.wave3a_schema_readiness WHERE singleton=TRUE`);
    expect(readiness.rows[0]).toEqual({state:'ready',migration_version:'20260804182000',wave2_implementation_git_sha:'1420fb4c819aad692894da9449bc4958ed74dd49'});
    a=await seedWorkspace(workspaceA,runtimeA,'5');b=await seedWorkspace(workspaceB,runtimeB,'6');
    const limits=quota(10);const client=await owner.connect();
    try{
      await client.query('BEGIN');await client.query(`SELECT set_config('rorca.migration_mode','on',TRUE)`);
      await client.query(`INSERT INTO rorca.managed_quota_policies(scope_type,scope_id,policy_version,policy_hash,hard_limits_json,effective_at,state)
        VALUES('global','*',$1,$2,$3::jsonb,$4,'active'),('workspace',$5,$1,$6,$3::jsonb,$4,'active'),('runtime',$7,$1,$8,$3::jsonb,$4,'active'),
        ('workspace',$9,$1,$10,$3::jsonb,$4,'active'),('runtime',$11,$1,$12,$3::jsonb,$4,'active')`,
        [policyVersion,hash('7'),JSON.stringify(limits),now,workspaceA,hash('8'),runtimeA,hash('9'),workspaceB,hash('a'),runtimeB,hash('b')]);
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    for(const item of [snapshot(workspaceA,runtimeA,`snapshot:a:${suffix}`,'c'),snapshot(workspaceB,runtimeB,`snapshot:b:${suffix}`,'d'),
      snapshot(workspaceA,runtimeA,`snapshot:unhealthy:${suffix}`,'e','unknown')]){
      await writer.query('SELECT rorca.persist_managed_capability_snapshot_v1($1::jsonb)',[JSON.stringify(item)]);
    }
  });
  afterAll(async()=>{await Promise.all([owner.end(),writer.end(),runtime.end()]);});

  test('atomically applies global/workspace/runtime limits, idempotency, and cross-workspace capacity isolation',async()=>{
    const bResult=await reserve({workspaceId:workspaceB,runtimeId:runtimeB,...b,reservationId:`reservation:b:${suffix}`,requestHash:hash('c'),snapshotHash:hash('d'),amount:2});
    expect(bResult).toMatchObject({admitted:true,duplicate:false});
    const aResult=await reserve({workspaceId:workspaceA,runtimeId:runtimeA,...a,reservationId:`reservation:a:${suffix}`,requestHash:hash('d'),snapshotHash:hash('c'),amount:8});
    expect(aResult).toMatchObject({admitted:true,duplicate:false});
    await expect(reserve({workspaceId:workspaceA,runtimeId:runtimeA,...a,reservationId:`reservation:a:${suffix}`,requestHash:hash('d'),snapshotHash:hash('c'),amount:8}))
      .resolves.toMatchObject({admitted:true,duplicate:true,reason_code:'idempotent_replay'});
    await expect(reserve({workspaceId:workspaceA,runtimeId:runtimeA,...a,reservationId:`reservation:a:${suffix}`,requestHash:hash('e'),snapshotHash:hash('c'),amount:7}))
      .resolves.toMatchObject({admitted:false,reason_code:'reservation_replay_conflict'});
    await expect(reserve({workspaceId:workspaceA,runtimeId:runtimeA,...a,reservationId:`reservation:a-over:${suffix}`,requestHash:hash('f'),snapshotHash:hash('c'),amount:1}))
      .resolves.toMatchObject({admitted:false,reason_code:'quota_exhausted:cpuMillis'});
    const bRows=await runtime.connect();
    try{
      await bRows.query('BEGIN');await bRows.query(`SELECT set_config('rorca.workspace_id',$1,TRUE)`,[workspaceB]);
      const visible=await bRows.query('SELECT workspace_id,reservation_id,state FROM rorca.managed_quota_reservations ORDER BY reservation_id');
      expect(visible.rows).toEqual([{workspace_id:workspaceB,reservation_id:`reservation:b:${suffix}`,state:'active'}]);
      await bRows.query('ROLLBACK');
    }finally{bRows.release();}
  });

  test('blocks an unhealthy typed dependency before reservation or child release',async()=>{
    const result=await reserve({workspaceId:workspaceA,runtimeId:runtimeA,...a,reservationId:`reservation:unhealthy:${suffix}`,requestHash:hash('1'),snapshotHash:hash('e'),amount:0});
    expect(result).toMatchObject({admitted:false,duplicate:false,reason_code:'dependency_unhealthy'});
    const persisted=await owner.query('SELECT 1 FROM rorca.managed_quota_reservations WHERE workspace_id=$1 AND reservation_id=$2',[workspaceA,`reservation:unhealthy:${suffix}`]);
    expect(persisted.rowCount).toBe(0);
  });

  test('runtime principal reads readiness and only its exact workspace recovery projection',async()=>{
    const client=await runtime.connect();
    try{
      const readiness=await client.query<{ value: Record<string,unknown> }>('SELECT rorca.load_wave3a_readiness_v1() value');
      expect(readiness.rows[0]?.value).toMatchObject({state:'ready',migration_version:20260804182000});
      await client.query('BEGIN');
      await client.query(`SELECT set_config('rorca.workspace_id',$1,TRUE)`,[workspaceA]);
      const recoverable=await client.query('SELECT * FROM rorca.list_recoverable_managed_executor_generations_v1($1,100)',[workspaceA]);
      expect(recoverable.rows).toEqual([]);
      await client.query(`SELECT set_config('rorca.workspace_id',$1,TRUE)`,[workspaceB]);
      await expect(client.query('SELECT * FROM rorca.list_recoverable_managed_executor_generations_v1($1,100)',[workspaceA]))
        .rejects.toMatchObject({code:'42501'});
      await client.query('ROLLBACK');
    }finally{client.release();}
  });

  test('serializes concurrent supervisor and worker snapshot separation checks per workspace',async()=>{
    const supervisor={...snapshot(workspaceA,runtimeA,`snapshot:race-supervisor:${suffix}`,'4'),role:'supervisor',providerId:'provider:supervisor-race'};
    const worker={...snapshot(workspaceA,runtimeA,`snapshot:race-worker:${suffix}`,'5'),
      principalId:supervisor.principalId,providerAuthReferenceId:supervisor.providerAuthReferenceId,providerBudgetId:supervisor.providerBudgetId,
      rateLimitIdentity:supervisor.rateLimitIdentity,circuitIdentity:supervisor.circuitIdentity,processIdentity:supervisor.processIdentity,queueIdentity:supervisor.queueIdentity};
    const first=await writer.connect();
    const second=await writer.connect();
    try{
      await first.query('BEGIN');
      await second.query('BEGIN');
      await first.query('SELECT rorca.persist_managed_capability_snapshot_v1($1::jsonb)',[JSON.stringify(supervisor)]);
      const secondPid=await second.query<{pid:number}>('SELECT pg_backend_pid() pid');
      const collision=second.query('SELECT rorca.persist_managed_capability_snapshot_v1($1::jsonb)',[JSON.stringify(worker)])
        .then(()=>null,(error:unknown)=>error);
      let lockObserved=false;
      for(let attempt=0;attempt<100&&!lockObserved;attempt+=1){
        const turn=Promise.withResolvers<void>();
        setImmediate(turn.resolve);
        await turn.promise;
        const activity=await owner.query<{blocked:boolean}>('SELECT cardinality(pg_blocking_pids($1))>0 blocked',[secondPid.rows[0]?.pid]);
        lockObserved=activity.rows[0]?.blocked===true;
      }
      expect(lockObserved).toBe(true);
      await first.query('COMMIT');
      await expect(collision).resolves.toMatchObject({code:'42501'});
      await second.query('ROLLBACK');
    }finally{
      await first.query('ROLLBACK').catch(()=>undefined);
      await second.query('ROLLBACK').catch(()=>undefined);
      first.release();
      second.release();
    }
  });

  test('rejects supervisor credential, budget, rate-limit, circuit, process, or queue reuse by a worker snapshot',async()=>{
    const supervisor={...snapshot(workspaceA,runtimeA,`snapshot:supervisor:${suffix}`,'2'),role:'supervisor',providerId:'provider:supervisor'};
    await writer.query('SELECT rorca.persist_managed_capability_snapshot_v1($1::jsonb)',[JSON.stringify(supervisor)]);
    const colliding={...snapshot(workspaceA,runtimeA,`snapshot:colliding:${suffix}`,'3'),principalId:supervisor.principalId};
    await expect(writer.query('SELECT rorca.persist_managed_capability_snapshot_v1($1::jsonb)',[JSON.stringify(colliding)])).rejects.toMatchObject({code:'42501'});
  });
});
