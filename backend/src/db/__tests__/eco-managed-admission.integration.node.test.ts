/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from 'pg';
import { body, plan, h } from '../../lib/__tests__/fixtures/eco-phase-work.fixture';
import { canonicalJson, contractHash, sealExternalPhaseWork } from '../../lib/eco-phase-work';

// No import of db/index, server, environment config or any live connection URL.
test('managed admission atomically owns canonical run/outbox, phase pins, authority and cumulative lineage', {timeout:90000}, async t=>{
 const scratch=path.join(os.homedir(),'.hermes/cache/scratch');fs.mkdirSync(scratch,{recursive:true});
 const root=fs.mkdtempSync(path.join(scratch,'eco14-pg-')); const data=path.join(root,'data'); let started=false;
 const run=(bin:string,args:string[])=>execFileSync(`/usr/local/bin/${bin}`,args,{encoding:'utf8',stdio:'pipe'});
 const client=new Client({host:root,port:55493,database:'postgres',user:'eco14_test'});
 try {
  run('initdb',['-D',data,'-U','eco14_test','-A','trust','--no-locale']);
  run('pg_ctl',['-D',data,'-l',path.join(root,'log'),'-o',`-k ${root} -h '' -p 55493`,'-w','start']);started=true;await client.connect();
  await client.query(`CREATE SCHEMA rorca;SET search_path=rorca,public;CREATE EXTENSION pgcrypto;
   CREATE ROLE eco14_runtime; SELECT set_config('rorca.runtime_database_user','eco14_runtime',FALSE);
   GRANT USAGE ON SCHEMA rorca TO eco14_runtime;
   CREATE TABLE workspaces(id TEXT PRIMARY KEY); INSERT INTO workspaces VALUES('ws'),('foreign');
   CREATE TABLE workspace_members(workspace_id TEXT,user_auth_id TEXT,role TEXT); INSERT INTO workspace_members VALUES('ws','principal','member');
   CREATE TABLE ssdlc_lifecycle_dispatch_claims(claim_id UUID PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id));
   CREATE TABLE ssdlc_compiled_plans(id BIGINT PRIMARY KEY,workspace_id TEXT,spec_slug TEXT,plan_json JSONB,spec_version TEXT,is_current BOOLEAN,validation_status TEXT,provenance_json JSONB);
   CREATE TABLE spec_versions(workspace_id TEXT,spec_slug TEXT,version INTEGER); INSERT INTO spec_versions VALUES('ws','parent',7);
   CREATE TABLE pipeline_runs(id SERIAL PRIMARY KEY,workspace_id TEXT REFERENCES workspaces(id),status TEXT,spec_path TEXT,idempotency_key TEXT,trigger_options JSONB,dispatch_request_hash TEXT,dispatch_effective_options_hash TEXT,retried_from_run_id INTEGER);
   CREATE UNIQUE INDEX run_keys ON pipeline_runs(workspace_id,idempotency_key);
   CREATE TABLE task_manifest_dispatch_publications(run_id INTEGER,workspace_id TEXT,queue_name TEXT,boss_job_id UUID,state TEXT,payload_hash TEXT,lease_owner TEXT,lease_expires_at TIMESTAMPTZ,published_at TIMESTAMPTZ,created_at TIMESTAMPTZ,updated_at TIMESTAMPTZ);
   CREATE TABLE ssdlc_lifecycle_evidence(id BIGINT PRIMARY KEY,workspace_id TEXT,source_system TEXT,source_idempotency_key TEXT,payload_hash TEXT,metadata JSONB,subject_type TEXT,subject_value TEXT,run_id INTEGER,phase_id TEXT,gate_id TEXT);`);
  const migration=(name:string)=>fs.readFileSync(path.resolve(__dirname,'../pg-migrations',name),'utf8');
  await client.query(migration('20260722070000_pipeline_dispatch_outbox.sql'));
  await client.query(migration('20261027120000_eco_phase_work_binding.sql'));
  // RED initially asserts the absent core/migration, rather than silently skipping.
  const modulePath=path.resolve(__dirname,'../../lib/eco-managed-admission.ts');
  assert.equal(fs.existsSync(modulePath),true,'managed transactional admission core is missing');
  const {admitEcoManagedRun,assertEcoManagedAuthority,assertEcoAcceptedPrerequisites,consumeEcoManagedBudget}=await import('../../lib/eco-managed-admission');
  await client.query(migration('20261027140000_eco_managed_admission.sql'));
  const claim={schemaVersion:'lifecycle-dispatch-claim.v1' as const,claimId:'a97719cf-df5e-4a4a-a3e3-043ce739209b',workspaceId:'ws',specId:'parent',compiledPlanId:'1',requestIdentity:'pipeline:eco14-command-key',requestHash:h,specHash:h};
  await client.query('INSERT INTO ssdlc_lifecycle_dispatch_claims VALUES($1,$2)',[claim.claimId,'ws']);
  await client.query('INSERT INTO ssdlc_compiled_plans VALUES(1,$1,$2,$3,$4,TRUE,$5,$6)',['ws','parent',plan,'7','validated',{specHash:h}]);
  const raw=body();raw.budgets.retries=1;
  // Explicitly synthetic, host-published extension for exercising a nonzero
  // retry ceiling; the real catalog remains zero-retry and is tested below.
  const recipe={contractVersion:'eco.recipe/proposal-v1',id:'fixture-retry',semanticVersion:'1.0.0',effectPolicy:raw.effectPolicy,budgets:raw.budgets,phases:['development'],workKind:'implementation',executionModes:['rorca-managed'],prompt:'Fixture only; no live authority',modelJudgment:['Bounded fixture'],inputs:[{id:'source',kind:'source-artifact',description:'Pinned fixture'}],outputs:raw.deliverables.map(({criterionIds,...output})=>output),steps:['inspect','execute','collect','stop'].map(id=>({id,action:'Bounded fixture action',toolClass:'read',required:true})),checks:raw.criteria.map(c=>({id:c.id,evaluatorKind:c.evaluatorKind,requirement:c.description})),stop:'artifact-review-submission',onMissingInput:'block',onSourceChange:'require-new-revision',onTimeout:'stop-and-reconcile'};
  raw.recipeBinding.id=recipe.id;raw.recipeBinding.contentHash=contractHash(recipe);
  const binding={contractVersion:'rorca.phase-work-binding.v1' as const,phaseWork:sealExternalPhaseWork(raw),providerSpecVersion:'7'};
  const put=async(kind:string,key:string,value:unknown)=>client.query('INSERT INTO eco_host_records(workspace_id,kind,record_key,canonical_bytes,content_hash) VALUES($1,$2,$3,$4,$5)',['ws',kind,key,canonicalJson(value),contractHash(value)]);
  await put('recipe',binding.phaseWork.recipeBinding.contentHash,recipe);
  for(const source of raw.sourceBindings) await put('source',contractHash(source),source);
  const input={binding,claim,principalId:'principal',companyId:'company',ownerId:'watcher',fence:1,idempotencyKey:'eco14-command-key',requestHash:h,storyId:'US-1',specPath:'forge/specs/approved/parent.json',deadlineAt:new Date(Date.now()+600000).toISOString()};
  await put('story-mapping',binding.phaseWork.contentHash,{phaseHash:binding.phaseWork.contentHash,parentHash:raw.parentBinding.planHash,specId:claim.specId,specHash:claim.specHash,providerSpecVersion:'7',storyId:input.storyId,specPath:input.specPath});
  await client.query(`INSERT INTO eco_watcher_owners(workspace_id,company_id,phase_work_id,principal_id,owner_id,fence,expires_at) VALUES('ws','company',$1,'principal','watcher',1,clock_timestamp()+interval '60 seconds')`,[raw.id]);
  const tx=async<T>(fn:()=>Promise<T>)=>{await client.query('BEGIN');try {const v=await fn();await client.query('COMMIT');return v;}catch(e){await client.query('ROLLBACK');throw e;}};
  let creates=0;
  const create=async()=>{creates++;return (await client.query(`INSERT INTO pipeline_runs(workspace_id,status,spec_path,idempotency_key,trigger_options,dispatch_request_hash,dispatch_effective_options_hash) VALUES('ws','queued',$1,$2,$3,$4,$4) RETURNING id`,[input.specPath,input.idempotencyKey,{lifecycleDispatchClaim:claim},h])).rows[0];};
  const admit=(i:any=input,fn=create)=>tx(()=>admitEcoManagedRun(client,i,fn));
  await t.test('crash after real INSERT rolls back run, existing outbox, phase and quota',async()=>{
   await assert.rejects(admit(input,async()=>{await create();throw new Error('injected-after-run');}),/injected-after-run/);
   for(const table of ['pipeline_runs','pipeline_dispatch_publications','eco_phase_work_revisions','eco_managed_roots','eco_managed_run_bindings']) assert.equal((await client.query(`SELECT count(*) FROM ${table}`)).rows[0].count,'0',table);
  });
  await t.test('deferred canonical identity rejects a corrupted outbox at COMMIT with full rollback',async()=>{
   await assert.rejects(tx(async()=>{const reserved=await admitEcoManagedRun(client,input,create);await client.query('UPDATE pipeline_dispatch_publications SET request_hash=$1 WHERE run_id=$2',[`sha256:${'d'.repeat(64)}`,reserved.runId]);}),/canonical run\/outbox/i);
   assert.equal((await client.query('SELECT count(*) FROM pipeline_runs')).rows[0].count,'0');
  });
  let first:any;
  await t.test('an autocommit caller cannot split authority, phase pins and canonical admission',async()=>{
   await assert.rejects(admitEcoManagedRun(client,input,create),/transaction|SAVEPOINT/i);
  });
  await t.test('concurrent exact commands commit one canonical run, existing outbox and phase binding',async()=>{
   const other=new Client({host:root,port:55493,database:'postgres',user:'eco14_test'});await other.connect();
   try {
    await other.query('SET search_path=rorca,public;BEGIN');
    const reserveOther=async()=>{creates++;return (await other.query(`INSERT INTO pipeline_runs(workspace_id,status,spec_path,idempotency_key,trigger_options,dispatch_request_hash,dispatch_effective_options_hash) VALUES('ws','queued',$1,$2,$3,$4,$4) RETURNING id`,[input.specPath,input.idempotencyKey,{lifecycleDispatchClaim:claim},h])).rows[0];};
    const before=creates;
    const results=await Promise.all([admit(),(async()=>{const r=await admitEcoManagedRun(other,input,reserveOther);await other.query('COMMIT');return r;})()]);
    assert.equal(creates,before+1);assert.deepEqual(results.map(r=>r.replayed).sort(),[false,true]);
    assert.equal(results[0].runId,results[1].runId);first=results.find(r=>!r.replayed)!;
   }finally {await other.query('ROLLBACK');await other.end();}
   assert.equal((await client.query('SELECT count(*) FROM pipeline_dispatch_publications')).rows[0].count,'1');
   assert.equal((await client.query('SELECT count(*) FROM eco_phase_dispatch_bindings')).rows[0].count,'1');
  });
  await t.test('a new revision cannot overlap an active phase attempt even under a different key and claim',async()=>{
   const next=structuredClone(raw);next.revision=2;
   const phaseWork=sealExternalPhaseWork(next);
   await put('story-mapping',phaseWork.contentHash,{phaseHash:phaseWork.contentHash,parentHash:next.parentBinding.planHash,specId:claim.specId,specHash:claim.specHash,providerSpecVersion:'7',storyId:input.storyId,specPath:input.specPath});
   const otherClaim={...claim,claimId:'a97719cf-df5e-4a4a-a3e3-043ce739209c'};
   await client.query('INSERT INTO ssdlc_lifecycle_dispatch_claims VALUES($1,$2)',[otherClaim.claimId,'ws']);
   const before=creates;
   await assert.rejects(admit({...input,claim:otherClaim,binding:{...binding,phaseWork},idempotencyKey:'eco14-revision-two'}),/active|overlap/i);
   assert.equal(creates,before);
  });
  await t.test('revocation cannot race between authority read and canonical commit',async()=>{
   const other=new Client({host:root,port:55493,database:'postgres',user:'eco14_test'});await other.connect();
   try {
    await client.query('BEGIN');await assertEcoManagedAuthority(client,input);
    await other.query("SET search_path=rorca,public;BEGIN;SET LOCAL statement_timeout='100ms'");
    await assert.rejects(other.query("INSERT INTO eco_host_record_revocations VALUES('ws','source',$1,'revoked')",[contractHash(raw.sourceBindings[0])]),/timeout/i);
   }finally {await other.query('ROLLBACK');await other.end();await client.query('ROLLBACK');}
  });
  await t.test('exact replay is read-only even with a fresh deadline; changed key/hash or principal conflicts',async()=>{
   const before=creates;const replay=await admit({...input,deadlineAt:new Date(Date.now()+700000).toISOString()});
   assert.equal(replay.runId,first.runId);assert.equal(replay.replayed,true);assert.equal(creates,before);
   await assert.rejects(admit({...input,idempotencyKey:'other-eco14-command'}),/identity|already|conflict/i);
   await assert.rejects(admit({...input,requestHash:`sha256:${'b'.repeat(64)}`}),/identity|conflict/i);
   await assert.rejects(admit({...input,principalId:'other'}),/member|owner|identity|conflict/i);
   await assert.rejects(admit({...input,storyId:'US-other'}),/identity|conflict/i);
   await assert.rejects(admit({...input,binding:{...binding,phaseWork:{...binding.phaseWork,objective:'tampered while retaining digest'}}}),/hash|integrity/i);
  });
  await t.test('source revocation, stale owner, recipe tampering, scope and deadline deny before callback',async()=>{
   await client.query('BEGIN');
   await client.query(`INSERT INTO eco_host_record_revocations VALUES('ws','source',$1,'revoked')`,[contractHash(raw.sourceBindings[0])]);
   await assert.rejects(assertEcoManagedAuthority(client,input),/source/i);
   await client.query('ROLLBACK');
   await assert.rejects(tx(()=>assertEcoManagedAuthority(client,{...input,fence:2})),/owner|fence/i);
   await assert.rejects(tx(()=>assertEcoManagedAuthority(client,{...input,deadlineAt:'2000-01-01T00:00:00.000Z'})),/deadline/i);
   const changed=structuredClone(raw);changed.effectPolicy.allowWriteRoots=['elsewhere'];
   await assert.rejects(tx(()=>assertEcoManagedAuthority(client,{...input,binding:{...binding,phaseWork:sealExternalPhaseWork(changed)}})),/recipe/i);
  });
  await t.test('actual standalone recipe bytes interoperate with provider authority and attenuated phase budgets',async()=>{
   const native=await import(path.resolve(__dirname,'../../../../../standalone-ssdlc/src/ecosystem/recipes.ts'));
   const sealed=native.RECIPES.find((r:any)=>r.id==='implement-spec');const {contentHash,...recipeBody}=sealed;
   const next=structuredClone(raw) as any;next.id='6760e13e-cf37-42be-b7d8-7c24b2148e88';
   next.recipeBinding={id:sealed.id,semanticVersion:sealed.semanticVersion,contentHash};next.effectPolicy=structuredClone(sealed.effectPolicy);
   next.budgets={...sealed.budgets,spendMicroUsd:0,wallSeconds:600};
   next.criteria=sealed.checks.map((c:any)=>({id:c.id,description:c.requirement,evaluatorKind:c.evaluatorKind,requiredEvidenceKinds:['host-observation'],gateIds:next.parentBinding.gateIds}));
   next.deliverables=sealed.outputs.map((o:any)=>({...o,criterionIds:next.criteria.map((c:any)=>c.id)}));
   const phaseWork=sealExternalPhaseWork(next);await put('recipe',contentHash,recipeBody);
   await put('story-mapping',phaseWork.contentHash,{phaseHash:phaseWork.contentHash,parentHash:next.parentBinding.planHash,specId:claim.specId,specHash:claim.specHash,providerSpecVersion:'7',storyId:input.storyId,specPath:input.specPath});
   await client.query(`INSERT INTO eco_watcher_owners(workspace_id,company_id,phase_work_id,principal_id,owner_id,fence,expires_at) VALUES('ws','company',$1,'principal','watcher',1,clock_timestamp()+interval '60 seconds')`,[next.id]);
   await tx(()=>assertEcoManagedAuthority(client,{...input,deadlineAt:new Date(Date.now()+300000).toISOString(),binding:{...binding,phaseWork}}));
  });
  await t.test('cumulative metering is immutable-event idempotent and quota cannot reset',async()=>{
   const charge={workspaceId:'ws',runId:first.runId,eventKey:'tool-event-1',ownerId:'watcher',fence:1,principalId:'principal',companyId:'company',usage:{toolCalls:70,contextTokens:100,outputBytes:10,spendMicroUsd:0}};
   await tx(()=>consumeEcoManagedBudget(client,charge));await tx(()=>consumeEcoManagedBudget(client,charge));
   await assert.rejects(tx(()=>consumeEcoManagedBudget(client,{...charge,usage:{...charge.usage,toolCalls:71}})),/replay|conflict/i);
   await assert.rejects(tx(()=>consumeEcoManagedBudget(client,{...charge,eventKey:'tool-event-2',usage:{...charge.usage,toolCalls:31}})),/quota/i);
   assert.equal((await client.query('SELECT used_tool_calls FROM eco_managed_roots')).rows[0].used_tool_calls,'70');
  });
  await t.test('accepted dependencies require host records plus full canonical phase/source/recipe/subject/gate/attempt evidence',async()=>{
   const prerequisite={phaseWorkId:raw.id,revision:1,deliverableId:'code',artifactHash:h};
   const next=structuredClone(raw) as any;next.id='6760e13e-cf37-42be-b7d8-7c24b2148e99';next.prerequisites=[prerequisite];
   const phase=sealExternalPhaseWork(next);
   await assert.rejects(tx(()=>assertEcoAcceptedPrerequisites(client,phase)),/accepted-artifact/i);
   const acceptance={contractVersion:'rorca.eco-host-acceptance.v1',workspaceId:'ws',phaseWorkId:raw.id,revision:1,phaseHash:binding.phaseWork.contentHash,sourceSetHash:contractHash(raw.sourceBindings),recipeHash:raw.recipeBinding.contentHash,parentHash:raw.parentBinding.planHash,deliverableId:'code',artifactHash:h,attemptRunId:first.runId,gateIds:raw.parentBinding.gateIds,evidenceId:1,eventKey:'host-closeout-event'};
   await put('accepted-artifact',contractHash(prerequisite),acceptance);
   await assert.rejects(tx(()=>assertEcoAcceptedPrerequisites(client,phase)),/canonical evidence/i);
   await client.query(`INSERT INTO ssdlc_lifecycle_evidence VALUES(1,'ws','rorca-host-closeout',$1,$2,$3,'artifact_digest',$4,$5,'development',$6)`,[acceptance.eventKey,contractHash(acceptance),{ecoAcceptance:acceptance},h,first.runId,raw.parentBinding.gateIds[0]]);
   await tx(()=>assertEcoAcceptedPrerequisites(client,phase));
   await client.query('BEGIN');await client.query("UPDATE ssdlc_lifecycle_evidence SET subject_value=$1",[`sha256:${'c'.repeat(64)}`]);
   await assert.rejects(assertEcoAcceptedPrerequisites(client,phase),/canonical evidence/i);await client.query('ROLLBACK');
   await client.query('BEGIN');await client.query("UPDATE ssdlc_lifecycle_evidence SET payload_hash=$1",[`sha256:${'c'.repeat(64)}`]);
   await assert.rejects(assertEcoAcceptedPrerequisites(client,phase),/canonical evidence/i);await client.query('ROLLBACK');
  });
  await t.test('retry keeps root deadline, meters and exact predecessor; exhaustion rejects new keys',async()=>{
   await client.query("UPDATE pipeline_runs SET status='failed' WHERE id=$1",[first.runId]);
   const retry={...input,idempotencyKey:'eco14-retry-command',predecessorRunId:first.runId};
   const successor=await admit(retry,async()=> (await client.query(`INSERT INTO pipeline_runs(workspace_id,status,spec_path,idempotency_key,trigger_options,dispatch_request_hash,dispatch_effective_options_hash,retried_from_run_id) VALUES('ws','queued',$1,$2,$3,$4,$4,$5) RETURNING id`,[input.specPath,retry.idempotencyKey,{lifecycleDispatchClaim:claim},h,first.runId])).rows[0]);
   assert.equal(successor.replayed,false);assert.equal((await client.query('SELECT retry_count,used_tool_calls FROM eco_managed_roots')).rows[0].retry_count,1);
   await client.query("UPDATE pipeline_runs SET status='failed' WHERE id=$1",[successor.runId]);
   await assert.rejects(admit({...retry,idempotencyKey:'eco14-exhausted-key',predecessorRunId:successor.runId}),/retry|exhaust/i);
  });
  await t.test('RLS hides foreign rows and runtime cannot manufacture host source/recipe/acceptance/owner authority',async()=>{
   await client.query("SET ROLE eco14_runtime;SELECT set_config('rorca.workspace_id','foreign',FALSE)");
   assert.equal((await client.query('SELECT count(*) FROM eco_managed_run_bindings')).rows[0].count,'0');
   await assert.rejects(client.query("INSERT INTO eco_host_records VALUES('foreign','source','fake','{}',$1)",[contractHash({})]),/permission denied/i);
   await assert.rejects(client.query("UPDATE eco_watcher_owners SET fence=2"),/permission denied/i);
   await client.query("SELECT set_config('rorca.workspace_id','ws',FALSE);BEGIN");
   assert.equal((await client.query('SELECT phase_work_id FROM eco_watcher_owners FOR SHARE')).rows.length,2);
   await assert.rejects(client.query("UPDATE eco_watcher_owners SET phase_work_id='6760e13e-cf37-42be-b7d8-7c24b2148eff'"),/requires increasing generation/i);
   await client.query('ROLLBACK');
   await client.query('RESET ROLE');
  });
 }finally {await client.end();if(started)run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);fs.rmSync(root,{recursive:true,force:true});}
});
