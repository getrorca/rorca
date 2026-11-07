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
import {execFileSync,fork} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {Client, Pool} from 'pg';
import express from 'express';
import request from 'supertest';
import {body,plan,h} from '../../lib/__tests__/fixtures/eco-phase-work.fixture';
import {canonicalJson,contractHash,sealExternalPhaseWork} from '../../lib/eco-phase-work';
import type {EcoTransaction} from '../../lib/eco-managed-runtime';
import {createEcoProviderRouter} from '../../routes/eco-provider';
import {errorHandler} from '../../lib/error-handler';

// Explicit bounded simulation: no real model/CLI, approval issuer, production
// database URL, environment bootstrap or worker/server entrypoint is imported.
test('wired managed admission: real provider read routes + canonical publication + bounded worker on disposable PG',{timeout:90000},async t=>{
 const scratch=path.join(os.homedir(),'.hermes/cache/scratch');fs.mkdirSync(scratch,{recursive:true});
 const root=fs.mkdtempSync(path.join(scratch,'eco16-pg-'));const data=path.join(root,'data');let started=false;
 const run=(bin:string,args:string[])=>execFileSync(`/usr/local/bin/${bin}`,args,{encoding:'utf8',stdio:'pipe'});
 const config={host:root,port:55496,database:'postgres',user:'eco16_test'};
 const admin=new Client(config);let pool:Pool|undefined;
 const migration=(name:string)=>fs.readFileSync(path.resolve(__dirname,'../pg-migrations',name),'utf8');
 try{
  run('initdb',['-D',data,'-U','eco16_test','-A','trust','--no-locale']);run('pg_ctl',['-D',data,'-l',path.join(root,'log'),'-o',`-k ${root} -h '' -p 55496`,'-w','start']);started=true;
  // Invocation-owned topology checked before any runtime/bootstrap import or
  // transport: never let ambient PG*/URL values choose the target.
  assert.ok(fs.realpathSync(root).startsWith(fs.realpathSync(scratch)+path.sep+'eco16-pg-'));
  assert.equal(fs.realpathSync(data),path.join(fs.realpathSync(root),'data'));
  const postmaster=fs.readFileSync(path.join(data,'postmaster.pid'),'utf8').split('\n');
  assert.equal(postmaster[1],data);assert.equal(postmaster[4],root);process.kill(Number(postmaster[0]),0);
  await admin.connect();assert.equal((await admin.query('SHOW data_directory')).rows[0].data_directory,data);
  const {reserveEcoManagedCanonicalRun,assertEcoDispatch,executeEcoManagedWorker,installEcoBoundedExecutor,linkEcoManagedCloseout,ECO_PREPARED_PROTOCOL}=require('../../lib/eco-managed-runtime') as typeof import('../../lib/eco-managed-runtime');
  await admin.query(`CREATE SCHEMA rorca;SET search_path=rorca,public;CREATE EXTENSION pgcrypto;
   CREATE ROLE eco16_runtime;SELECT set_config('rorca.runtime_database_user','eco16_runtime',FALSE);GRANT USAGE ON SCHEMA rorca TO eco16_runtime;
   CREATE TABLE workspaces(id TEXT PRIMARY KEY);INSERT INTO workspaces VALUES('ws'),('foreign');
   CREATE TABLE workspace_members(workspace_id TEXT,user_auth_id TEXT,role TEXT);INSERT INTO workspace_members VALUES('ws','principal','member');
   CREATE TABLE ssdlc_compiled_plans(id BIGINT PRIMARY KEY,workspace_id TEXT,spec_slug TEXT,plan_json JSONB,spec_version TEXT,is_current BOOLEAN,validation_status TEXT,provenance_json JSONB);
   CREATE TABLE spec_versions(workspace_id TEXT,spec_slug TEXT,version INTEGER);INSERT INTO spec_versions VALUES('ws','parent',7);
   CREATE TABLE pipeline_runs(id SERIAL PRIMARY KEY,workspace_id TEXT REFERENCES workspaces(id),status TEXT,spec_path TEXT,idempotency_key TEXT,trigger_options JSONB,dispatch_request_hash TEXT,dispatch_effective_options_hash TEXT,retried_from_run_id INTEGER,campaign_dispatch_authorization_hash TEXT,host_closeout_event_id INTEGER);
   CREATE UNIQUE INDEX run_keys ON pipeline_runs(workspace_id,idempotency_key);
   CREATE TABLE pipeline_run_cancellation_requests(run_id INTEGER PRIMARY KEY);
   CREATE TABLE task_manifest_dispatch_publications(run_id INTEGER,workspace_id TEXT,queue_name TEXT,boss_job_id UUID,state TEXT,payload_hash TEXT,lease_owner TEXT,lease_expires_at TIMESTAMPTZ,published_at TIMESTAMPTZ,created_at TIMESTAMPTZ,updated_at TIMESTAMPTZ);
   CREATE TABLE ssdlc_lifecycle_evidence(id BIGINT PRIMARY KEY,workspace_id TEXT,source_system TEXT,source_idempotency_key TEXT,payload_hash TEXT,metadata JSONB,subject_type TEXT,subject_value TEXT,run_id INTEGER,phase_id TEXT,gate_id TEXT);
   CREATE TABLE wal_events(id SERIAL PRIMARY KEY,workspace_id TEXT,canonical_run_id INTEGER,event_type TEXT,trust_provenance TEXT,trusted_source TEXT,event_identity_hash TEXT,payload JSONB);`);
  for(const m of ['20260722070000_pipeline_dispatch_outbox.sql','20260812121000_lifecycle_dispatch_claims.sql','20261027120000_eco_phase_work_binding.sql','20261027140000_eco_managed_admission.sql','20261027160000_eco_wired_admission.sql'])await admin.query(migration(m));
  await admin.query('INSERT INTO ssdlc_compiled_plans VALUES(1,$1,$2,$3,$4,TRUE,$5,$6)',['ws','parent',plan,'7','validated',{specHash:h}]);
  pool=new Pool({...config,options:'-c search_path=rorca,public',max:5});
  const transaction:EcoTransaction=async action=>{const c=await pool!.connect();try{await c.query('BEGIN');const value=await action(c);await c.query('COMMIT');return value;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
  const query=async(sql:string,params:any[]=[]) => (await pool!.query(sql,params)).rows;
  // Only infrastructure transport is substituted: actual admission, lifecycle
  // claim SQL, outbox preparation/publication/worker claim and HTTP routes run.
  const stub=(name:string,exports:unknown)=>{const id=require.resolve(name);require.cache[id]={id,filename:id,loaded:true,exports} as NodeModule;};
  const sent=new Map<string,any>();
  stub('../../db/index',{transaction,query,queryOne:async(sql:string,p:any[]) => (await query(sql,p))[0]});
  stub('../../lib/pg-boss',{getBoss:()=>({createQueue:async()=>{},send:async(_q:string,p:any,o:any)=>{sent.set(o.id,p);return o.id;}})});
  const {claimLifecycleDispatch}=require('../../lib/lifecycle-dispatch-claim') as typeof import('../../lib/lifecycle-dispatch-claim');
  const publication=require('../../lib/dispatch-publication') as typeof import('../../lib/dispatch-publication');
  const raw=body();raw.budgets.retries=1;
  const recipe={contractVersion:'eco.recipe/proposal-v1',id:'fixture-retry',semanticVersion:'1.0.0',effectPolicy:raw.effectPolicy,budgets:raw.budgets,phases:['development'],workKind:'implementation',executionModes:['rorca-managed'],prompt:'EXPLICIT BOUNDED SIMULATOR, NOT A MODEL',modelJudgment:['Fixture only'],inputs:[{id:'source',kind:'source-artifact',description:'Pinned fixture'}],outputs:raw.deliverables.map(({criterionIds,...o})=>o),steps:['inspect','execute','collect','stop'].map(id=>({id,action:'Bounded fixture',toolClass:'read',required:true})),checks:raw.criteria.map(c=>({id:c.id,evaluatorKind:c.evaluatorKind,requirement:c.description})),stop:'artifact-review-submission',onMissingInput:'block',onSourceChange:'require-new-revision',onTimeout:'stop-and-reconcile'};
  raw.recipeBinding.id=recipe.id;raw.recipeBinding.contentHash=contractHash(recipe);
  const binding={contractVersion:'rorca.phase-work-binding.v1' as const,phaseWork:sealExternalPhaseWork(raw),providerSpecVersion:'7'};
  const put=async(kind:string,key:string,value:unknown)=>admin.query('INSERT INTO eco_host_records(workspace_id,kind,record_key,canonical_bytes,content_hash) VALUES($1,$2,$3,$4,$5)',['ws',kind,key,canonicalJson(value),contractHash(value)]);
  await put('recipe',raw.recipeBinding.contentHash,recipe);for(const s of raw.sourceBindings)await put('source',contractHash(s),s);
  await put('story-mapping',binding.phaseWork.contentHash,{phaseHash:binding.phaseWork.contentHash,parentHash:raw.parentBinding.planHash,specId:'parent',specHash:h,providerSpecVersion:'7',storyId:'US-1',specPath:'forge/specs/approved/parent.json'});
  await admin.query(`INSERT INTO eco_watcher_owners VALUES('ws','company',$1,'principal','watcher',1,clock_timestamp()+interval '60 seconds',FALSE)`,[raw.id]);
  const managed={contractVersion:'rorca.eco-managed-admission.v1' as const,companyId:'company',ownerId:'watcher',fence:1,storyId:'US-1',deadlineAt:new Date(Date.now()+500000).toISOString()};
  const claim=await claimLifecycleDispatch({workspaceId:'ws',specId:'parent',specHash:h,compiledPlanId:'1',requestIdentity:'pipeline:eco16-command-key',requestHash:h});
  const input={binding,claim,principalId:'principal',...managed,idempotencyKey:'eco16-command-key',requestHash:h,specPath:'forge/specs/approved/parent.json'};
  const options={lifecycleDispatchClaim:claim,ecoManagedAdmission:managed,phaseWorkBinding:binding};
  const insert=async(c:any,i=input,o:any=options)=> (await c.query(`INSERT INTO pipeline_runs(workspace_id,status,spec_path,idempotency_key,trigger_options,dispatch_request_hash,dispatch_effective_options_hash,retried_from_run_id) VALUES('ws','queued',$1,$2,$3,$4,$4,$5) RETURNING id`,[i.specPath,i.idempotencyKey,o,i.requestHash,(i as any).predecessorRunId??null])).rows[0];
  let id=0;let payload:any;
  await t.test('actual canonical INSERT/outbox crash rollback and exact transactional replay',async()=>{
   await assert.rejects(transaction(c=>reserveEcoManagedCanonicalRun(c,input,async()=>{await insert(c);throw Error('after-real-insert');})),/after-real-insert/);
   for(const table of ['pipeline_runs','pipeline_dispatch_publications','eco_managed_roots','eco_managed_run_bindings','eco_phase_work_revisions'])assert.equal((await query(`SELECT count(*) FROM ${table}`))[0].count,'0');
   const first=await transaction(c=>reserveEcoManagedCanonicalRun(c,input,()=>insert(c)));id=first.runId;
   const second=await transaction(c=>reserveEcoManagedCanonicalRun(c,input,()=>{throw Error('replay must not insert');}));assert.equal(second.runId,id);assert.equal(second.replayed,true);
   await assert.rejects(transaction(c=>reserveEcoManagedCanonicalRun(c,{...input,storyId:'other'},()=>insert(c))),/conflict/i);
   payload={runId:id,workspaceId:'ws',specPath:input.specPath,triggerOptions:options,worktreePath:'/explicit-fixture-only',executionTimeoutSeconds:7200};
  });
  const app=(authSource='internal',subject='principal')=>{const app=express();app.use((req,_res,next)=>{req.user={id:subject,email:'fixture@example.test',supabaseId:subject,role:'user'};req.authSource=authSource as any;next();});app.use('/api/pipeline/provider/v1',createEcoProviderRouter({read:query,plan:async()=>({plan})}));app.use(errorHandler);return app;};
  await t.test('actual HTTP provider routes use PG membership before lookup and never advertise fixture authority',async()=>{
   assert.equal((await request(app('local-fallback')).get('/api/pipeline/provider/v1/capabilities?workspaceId=ws')).status,401);
   assert.equal((await request(app()).get(`/api/pipeline/provider/v1/runs/${id}?workspaceId=foreign`)).status,404);
   assert.equal((await request(app('internal','foreign')).get(`/api/pipeline/provider/v1/runs/${id}?workspaceId=ws`)).status,404);
   const response=await request(app()).get(`/api/pipeline/provider/v1/runs/${id}?workspaceId=ws`);assert.equal(response.status,200);assert.equal(response.body.run.id,id);
   const caps=await request(app()).get('/api/pipeline/provider/v1/capabilities?workspaceId=ws');assert.equal(caps.body.managedAdmission,false);assert.equal(caps.body.artifactExecution,false);
  });
  let prepared:any;let pub:any;
  await t.test('real publication rejects stripped pins, prepares immutable payload and claims exact existing outbox',async()=>{
   pub=await publication.claimDispatchPublication({runId:id,workspaceId:'ws',expectedRequestHash:h});
   await assert.rejects(publication.prepareDispatchPublication({runId:id,owner:pub.owner!,requestHash:h,effectiveOptionsHash:h,payload:{...payload,triggerOptions:{lifecycleDispatchClaim:claim}}}),/missing|pins|differs|identity/i);
   prepared=await publication.prepareDispatchPublication({runId:id,owner:pub.owner!,requestHash:h,effectiveOptionsHash:h,payload});
   await assert.rejects(publication.publishPreparedDispatch({runId:id,owner:pub.owner!,bossJobId:prepared.bossJobId,payloadHash:prepared.payloadHash,payload}),/executor unavailable/i);
   assert.equal(sent.size,0);
   const uninstall=installEcoBoundedExecutor(()=>({protocol:ECO_PREPARED_PROTOCOL,steps:async()=>[],perform:async()=>{},stop:async()=>{}}));
   try {
   await publication.publishPreparedDispatch({runId:id,owner:pub.owner!,bossJobId:prepared.bossJobId,payloadHash:prepared.payloadHash,payload});
   } finally {uninstall();}
   assert.deepEqual(sent.get(prepared.bossJobId),payload);
   assert.equal((await query('SELECT state FROM pipeline_dispatch_publications WHERE run_id=$1',[id]))[0].state,'published');
   assert.equal((await publication.claimDispatchForWorker({runId:id,bossJobId:prepared.bossJobId,payload,workerId:'fixture-worker',queueName:'pipeline:run'})).claimed,true);
   assert.equal((await publication.claimDispatchForWorker({runId:id,bossJobId:prepared.bossJobId,payload,workerId:'duplicate'})).claimed,false);
  });
  await t.test('worker denies missing/stale pins, source revocation, owner loss, cancellation and absent bounded adapter',async()=>{
   await assert.rejects(executeEcoManagedWorker({runId:id,payload,transaction,closeout:async()=>{throw Error('must not close');}}),/executor unavailable/i);
   await assert.rejects(transaction(c=>assertEcoDispatch(c,id,{...payload,triggerOptions:{}})),/missing|pins|differs/i);
   await admin.query('BEGIN');await admin.query(`INSERT INTO eco_host_record_revocations VALUES('ws','source',$1,'fixture revocation')`,[contractHash(raw.sourceBindings[0])]);
   // Separate connection needs committed authority to observe it. Rollback is
   // tested separately; revoke recipe below in a self-contained transaction.
   await assert.rejects(assertEcoDispatch(admin,id,payload),/revoked|source/i);await admin.query('ROLLBACK');
   for(const mutation of ["revoked=TRUE", "fence=2,expires_at=clock_timestamp()+interval '60 seconds'"]) {
    await admin.query('BEGIN');await admin.query(`UPDATE eco_watcher_owners SET ${mutation} WHERE phase_work_id=$1`,[raw.id]);
    await assert.rejects(assertEcoDispatch(admin,id,payload),/owner|fence/i);await admin.query('ROLLBACK');
   }
   await admin.query('INSERT INTO pipeline_run_cancellation_requests VALUES($1)',[id]);await assert.rejects(transaction(c=>assertEcoDispatch(c,id,payload)),/cancellation/i);await admin.query('DELETE FROM pipeline_run_cancellation_requests');
   await assert.rejects(admin.query(`UPDATE pipeline_runs SET trigger_options='{}' WHERE id=$1`,[id]),/immutable/i);
  });
  let effects=0;let stops=0;
  const executor:import('../../lib/eco-managed-runtime').EcoBoundedExecutor={protocol:ECO_PREPARED_PROTOCOL,steps:async()=>[{id:'fixture-read',usage:{toolCalls:1,contextTokens:10,outputBytes:20,spendMicroUsd:0}}],perform:async(_id:string,signal:AbortSignal)=>{assert.equal(signal.aborted,false);effects++;},stop:async()=>{stops++;}};
  await t.test('bounded simulator reserves before effect, stops before canonical host-evidence linkage; never accepts a phase',async()=>{
   let closed=0;
   await assert.rejects(executeEcoManagedWorker({runId:id,payload,transaction,executor,worker:{ownerId:'stale-worker'},closeout:async()=>{}}),/lease|fence/i);
   const uninstall=installEcoBoundedExecutor(()=>executor);
   try {await executeEcoManagedWorker({runId:id,payload,transaction,worker:{ownerId:'fixture-worker'},closeout:async()=>{
    assert.ok(stops>0);closed++;
    // Explicit host WAL fixture, NOT a real Git/model/human closeout proof.
    await transaction(async c=>{const wal=(await c.query(`INSERT INTO wal_events(workspace_id,canonical_run_id,event_type,trust_provenance,trusted_source,event_identity_hash,payload) VALUES('ws',$1,'run_closeout','host','worker',$2,$3) RETURNING id`,[id,h,{run_id:id,status:'done'}])).rows[0];await c.query('UPDATE pipeline_runs SET host_closeout_event_id=$2 WHERE id=$1',[id,wal.id]);await linkEcoManagedCloseout(c,id);});
   }});}finally{uninstall();}
   assert.equal(effects,1);assert.equal(closed,1);
   assert.equal((await query('SELECT used_tool_calls FROM eco_managed_roots'))[0].used_tool_calls,'1');
   const link=(await query('SELECT canonical_bytes,content_hash FROM eco_managed_closeout_links'))[0];assert.equal(contractHash(JSON.parse(link.canonical_bytes)),link.content_hash);assert.equal(JSON.parse(link.canonical_bytes).phaseHash,binding.phaseWork.contentHash);
   await transaction(c=>linkEcoManagedCloseout(c,id));
   await assert.rejects(executeEcoManagedWorker({runId:id,payload,transaction,executor,worker:{ownerId:'fixture-worker'},closeout:async()=>{}}),/already started|reconcile/i);
   assert.equal(effects,1);assert.equal((await query("SELECT count(*) FROM eco_host_records WHERE kind='accepted-artifact'"))[0].count,'0');
  });
  await t.test('actual restricted-role RLS hides managed lineage and forbids forged authority/closeout writes',async()=>{
   await admin.query("SET ROLE eco16_runtime;SELECT set_config('rorca.workspace_id','foreign',FALSE)");
   assert.equal((await admin.query('SELECT count(*) FROM eco_managed_run_bindings')).rows[0].count,'0');assert.equal((await admin.query('SELECT count(*) FROM eco_managed_closeout_links')).rows[0].count,'0');
   await assert.rejects(admin.query("INSERT INTO eco_host_records VALUES('foreign','source','fake','{}',$1)",[contractHash({})]),/permission denied/i);
   await assert.rejects(admin.query('UPDATE eco_managed_closeout_links SET canonical_bytes=$1',['{}']),/permission denied/i);await admin.query('RESET ROLE');
  });
  await t.test('real retry uses a new current lifecycle claim, retains counters/deadline and refuses a second retry',async()=>{
   await admin.query("UPDATE pipeline_runs SET status='failed' WHERE id=$1",[id]);
   const retryClaim=await claimLifecycleDispatch({workspaceId:'ws',specId:'parent',specHash:h,compiledPlanId:'1',requestIdentity:'retry:eco16-retry-key',requestHash:h});
   const retry={...input,claim:retryClaim,idempotencyKey:'eco16-retry-key',predecessorRunId:id};const retryOptions={...options,lifecycleDispatchClaim:retryClaim};
   const next=await transaction(c=>reserveEcoManagedCanonicalRun(c,retry,()=>insert(c,retry,retryOptions)));
   const r=(await query('SELECT retry_count,used_tool_calls,deadline_at FROM eco_managed_roots'))[0];assert.equal(r.retry_count,1);assert.equal(r.used_tool_calls,'1');assert.equal(new Date(r.deadline_at).toISOString(),managed.deadlineAt);
   await admin.query("UPDATE pipeline_runs SET status='failed' WHERE id=$1",[next.runId]);await assert.rejects(transaction(c=>reserveEcoManagedCanonicalRun(c,{...retry,idempotencyKey:'eco16-exhausted-key',predecessorRunId:next.runId},()=>insert(c))),/exhausted/i);
  });
 const nonce=randomBytes(32).toString('hex');
 fs.writeFileSync(path.join(root,'eco18-owner.lease'),JSON.stringify({nonce,ownerPid:process.pid,dataDirectory:data,config}),{mode:0o600,flag:'wx'});
 await admin.query('CREATE TABLE eco18_invocation(nonce TEXT,owner_pid INTEGER,data_directory TEXT,postmaster_started_at TIMESTAMPTZ)');
 await admin.query('INSERT INTO eco18_invocation VALUES($1,$2,$3,pg_postmaster_start_time())',[nonce,process.pid,data]);
 for(const scenario of ['preparation','lease-loss','cancellation'] as const) await t.test(`bounded executor ${scenario}: cleanup and no closeout`,async()=>{
  // A separate phase/run: uncertain worker-start must never be deleted or reused.
  const phaseId={preparation:'00000000-0000-4000-8000-000000000018','lease-loss':'00000000-0000-4000-8000-000000000019',cancellation:'00000000-0000-4000-8000-000000000020'}[scenario];
  const phase=sealExternalPhaseWork({...raw,id:phaseId});
  const freshBinding={...binding,phaseWork:phase};
  await put('story-mapping',phase.contentHash,{phaseHash:phase.contentHash,parentHash:raw.parentBinding.planHash,specId:'parent',specHash:h,providerSpecVersion:'7',storyId:'US-1',specPath:input.specPath});
  await admin.query(`INSERT INTO eco_watcher_owners VALUES('ws','company',$1,'principal','watcher',1,clock_timestamp()+interval '60 seconds',FALSE)`,[phase.id]);
  const freshClaim=await claimLifecycleDispatch({workspaceId:'ws',specId:'parent',specHash:h,compiledPlanId:'1',requestIdentity:`pipeline:eco18-${scenario}`,requestHash:h});
  const fresh={...input,binding:freshBinding,claim:freshClaim,idempotencyKey:`eco18-${scenario}`,deadlineAt:new Date(Date.now()+500000).toISOString()};
  const freshOptions={lifecycleDispatchClaim:freshClaim,ecoManagedAdmission:{...managed,deadlineAt:fresh.deadlineAt},phaseWorkBinding:freshBinding};
  const reserved=await transaction(c=>reserveEcoManagedCanonicalRun(c,fresh,()=>insert(c,fresh,freshOptions)));
  const freshPayload={...payload,runId:reserved.runId,triggerOptions:freshOptions};
  const freshPub=await publication.claimDispatchPublication({runId:reserved.runId,workspaceId:'ws',expectedRequestHash:h});
  const preparedFresh=await publication.prepareDispatchPublication({runId:reserved.runId,owner:freshPub.owner!,requestHash:h,effectiveOptionsHash:h,payload:freshPayload});
  const uninstallFresh=installEcoBoundedExecutor(()=>({protocol:ECO_PREPARED_PROTOCOL,steps:async()=>[],perform:async()=>{},stop:async()=>{}}));
  try{await publication.publishPreparedDispatch({runId:reserved.runId,owner:freshPub.owner!,bossJobId:preparedFresh.bossJobId,payloadHash:preparedFresh.payloadHash,payload:freshPayload});}finally{uninstallFresh();}
  assert.equal((await publication.claimDispatchForWorker({runId:reserved.runId,bossJobId:preparedFresh.bossJobId,payload:freshPayload,workerId:'fixture-worker',queueName:'pipeline:run'})).claimed,true);
  if(scenario!=='preparation'){
   const worker=fork(path.resolve(__dirname,'../../lib/__tests__/fixtures/eco-bounded-worker-simulator.ts'),[],{execArgv:['--import','tsx'],env:{HOME:os.homedir(),TMPDIR:scratch,NODE_ENV:'test'},stdio:['ignore','pipe','pipe','ipc']});
   let output='';const messages:any[]=[];worker.stdout?.on('data',b=>{output+=b;});worker.stderr?.on('data',b=>{output+=b;});
   try {
    const code=await new Promise<number|null>((resolve,reject)=>{
     worker.once('error',reject);worker.once('exit',resolve);
     worker.on('message',(message:any)=>{messages.push(message);if(message.type==='effect-started')setTimeout(()=>{
      // Allow at least one healthy poll before loss, so a poll blocked by its
      // own effect transaction cannot accidentally pass the test.
      const sql=scenario==='lease-loss'?`UPDATE pipeline_dispatch_publications SET lease_owner='lost-worker' WHERE run_id=$1`:'INSERT INTO pipeline_run_cancellation_requests VALUES($1)';
      admin.query(sql,[reserved.runId]).catch(reject);
     },600);});
     worker.send({config,nonce,dataDirectory:data,ownerPid:process.pid,runId:reserved.runId,payload:freshPayload});
    });
    assert.equal(code,0,output);assert.deepEqual(messages.map(m=>m.type),['owned-db-verified','effect-started','simulator-result']);
    assert.equal(messages[2].aborted,true);assert.equal(messages[2].stopped,true);assert.equal(messages[2].closed,0);
   }finally{if(worker.exitCode===null&&worker.signalCode===null)worker.kill('SIGTERM');}
   return;
  }
  let stopped=0;let closed=0;
  await assert.rejects(executeEcoManagedWorker({runId:reserved.runId,payload:{...payload,runId:reserved.runId,triggerOptions:freshOptions},transaction,worker:{ownerId:'fixture-worker'},executor:{protocol:ECO_PREPARED_PROTOCOL,steps:async()=>{throw Error('fixture-preparation-failure');},perform:async()=>{throw Error('must not execute');},stop:async()=>{stopped++;}},closeout:async()=>{closed++;}}),/fixture-preparation-failure/);
  assert.equal(stopped,1,'stop must run even when steps throws');assert.equal(closed,0);
 });
 const {exerciseStructuredWorker}=require('../../lib/__tests__/fixtures/eco-structured-worker-integration') as typeof import('../../lib/__tests__/fixtures/eco-structured-worker-integration');
 await exerciseStructuredWorker(t,{query,admin,transaction,put,raw,input,binding,options,payload,insert,claimLifecycleDispatch,publication});
 }finally{await pool?.end();await admin.end();if(started)run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);fs.rmSync(root,{recursive:true,force:true});}
});
