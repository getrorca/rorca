#!/usr/bin/env node

/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Invocation-owned qualification runner. Never falls back to an ambient DB,
 * mock queue, service-only worker or fabricated acceptance on startup failure.
 * Run from backend: node --import tsx scripts/run-eco-golden-text.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { allocateIsolatedTestDatabase, cleanupIsolatedTestDatabase, touchIsolatedTestDatabaseHeartbeat } from '../src/lib/test-db-harness';
import { assertTestDatabaseAccess } from '../src/db/test-db-isolation';

async function main() {
 const missingContent=process.argv.includes('--missing-content');
 const scratch=path.join(os.homedir(),'.hermes/cache/scratch');fs.mkdirSync(scratch,{recursive:true});
 // Do not inherit dotenv credentials, PG selectors, isolated leases or providers.
 const fixtureHome=fs.mkdtempSync(path.join(scratch,'eco24-home-'));
 // Existing credential-presence validator accepts host settings. No live secret
 // or authenticated provider claim: explicit TEST fixture, no CLI is launched.
 fs.mkdirSync(path.join(fixtureHome,'.claude'));fs.writeFileSync(path.join(fixtureHome,'.claude/settings.json'),JSON.stringify({fixture:'TEST-eco24-no-provider-credential'}));
 const env:NodeJS.ProcessEnv={HOME:fixtureHome,PATH:process.env.PATH,TMPDIR:scratch,NODE_ENV:'test',DOTENV_CONFIG_PATH:path.join(scratch,'eco23-nonexistent.env'),RORCA_TEST_DB_CAPABILITY:'invocation-lease'};
 Object.keys(process.env).forEach(key=>{if(!['PATH','HOME','TMPDIR'].includes(key))delete process.env[key];});
 Object.assign(process.env,env);
 let state:Awaited<ReturnType<typeof allocateIsolatedTestDatabase>>|undefined;
 let worker:ChildProcess|undefined;let heartbeat:NodeJS.Timeout|undefined;
 let http:import('node:http').Server|undefined;let modelServer:import('node:http').Server|undefined;let appDb:any;let appBoss:any;let modelCalls=0;
 const backend=process.cwd();
 const receipts=path.resolve('../docs/workplans');
 const evidencePrefix=missingContent?'INCREMENT-27-negative':'INCREMENT-27';
 try {
  state=await allocateIsolatedTestDatabase(env);
  Object.assign(env,{RORCA_JEST_INVOCATION_ID:state.invocationId,RORCA_JEST_OWNER_PID:String(state.ownerPid),RORCA_JEST_STATE_FILE:state.stateFile,
   DATABASE_URL:state.databaseUrl,RORCA_MIGRATION_DATABASE_URL:state.migrationDatabaseUrl,RORCA_CANONICAL_WRITER_DATABASE_URL:state.canonicalWriterDatabaseUrl,
   RORCA_RUNTIME_DATABASE_USER:state.user,RORCA_CANONICAL_WRITER_DATABASE_USER:decodeURIComponent(new URL(state.canonicalWriterDatabaseUrl!).username)});
  Object.assign(process.env,env);assertTestDatabaseAccess(state.databaseUrl);
  touchIsolatedTestDatabaseHeartbeat(env);heartbeat=setInterval(()=>touchIsolatedTestDatabaseHeartbeat(env),15000);
  console.log(JSON.stringify({stage:'invocation-owned-database',mode:state.mode,database:state.database,root:state.root}));
  // Actual pg-boss package/transport on the exact same invocation-owned DB.
  const {default:PgBoss}=await import('pg-boss');
  const boss=new PgBoss({connectionString:state.migrationDatabaseUrl!,schema:'pgboss_eco23',supervise:false});
  boss.on('error',e=>console.error('queue error',e));
  try {await boss.start();await boss.createQueue('eco23:transport-proof');
   const id=await boss.send('eco23:transport-proof',{synthetic:true,invocation:state.invocationId},{retryLimit:0});
   const jobs=await boss.fetch<{synthetic:boolean;invocation:string}>('eco23:transport-proof');
   if(jobs.length!==1||jobs[0].id!==id||jobs[0].data.invocation!==state.invocationId)throw Error('actual queue publication/readback mismatch');
   await boss.complete('eco23:transport-proof',id!);
   console.log(JSON.stringify({stage:'actual-queue-roundtrip',package:'pg-boss',jobId:id}));
  }finally{await boss.stop({graceful:false});}
  const packageRoot=fs.mkdtempSync(path.join(scratch,'eco23-package-'));
  const build=path.join(packageRoot,'backend/dist');
  const {execFileSync}=await import('node:child_process');
  execFileSync(path.resolve('node_modules/.bin/tsc'),['--outDir',build,'--pretty','false'],{stdio:'pipe'});
  // Preserve native relative asset topology; copy existing authority bytes,
  // never construct substitute human receipts to make migrations pass.
  fs.cpSync(path.resolve('src/db/pg-migrations'),path.join(build,'db/pg-migrations'),{recursive:true});
  fs.cpSync(path.resolve('../docs/implementation/evidence/ror24-adr-0001-v1'),path.join(packageRoot,'docs/implementation/evidence/ror24-adr-0001-v1'),{recursive:true});
  env.NODE_PATH=path.resolve('node_modules');env.RORCA_PGBOSS_SCHEMA='pgboss_eco23';process.env.RORCA_PGBOSS_SCHEMA=env.RORCA_PGBOSS_SCHEMA;
  worker=spawn(process.execPath,[path.join(build,'worker.js')],{cwd:scratch,env,stdio:['ignore','pipe','pipe']});
  let output='';const workerLog=path.join(receipts,`${evidencePrefix}-worker.log`);fs.writeFileSync(workerLog,'');
  const record=(b:Buffer)=>{output+=b;fs.appendFileSync(workerLog,b);};worker.stdout!.on('data',record);worker.stderr!.on('data',record);
  await new Promise<void>((resolve,reject)=>{
   const timeout=setTimeout(()=>reject(Error('built worker startup exceeded 90 seconds')),90000);
   const check=(b:Buffer)=>{if(b.toString().includes('[worker] ready — listening')){clearTimeout(timeout);resolve();}};
   worker!.stdout!.on('data',check);worker!.stderr!.on('data',check);
   worker!.once('error',reject);worker!.once('close',(code,signal)=>{clearTimeout(timeout);reject(Error(`actual built worker exited before ready: ${code}/${signal}; see INCREMENT-26-worker.log`));});
  });
  console.log(JSON.stringify({stage:'actual-built-worker-ready',pid:worker.pid}));
  // The actual exported server mounts its normal auth, scoped routers and error
  // handler. Test mode suppresses unrelated background subscribers, not routes.
  fs.symlinkSync(path.join(backend,'node_modules'),path.join(packageRoot,'backend/node_modules'),'dir');
  const {randomBytes}=await import('node:crypto');
  Object.assign(process.env,{RORCA_INTERNAL_SERVICE_TOKEN:randomBytes(48).toString('hex')});
  process.chdir(packageRoot); // dotenv.config() must never see the checkout .env.
  appDb=require(path.join(build,'db/index.js'));appBoss=require(path.join(build,'lib/pg-boss.js'));
  await appDb.initDb();await appBoss.initBoss();
  const readScoped=async(sql:string,params:any[]=[])=>appDb.transaction(async(client:any)=>{await client.query("SELECT set_config('rorca.workspace_id','ws',TRUE)");return (await client.query(sql,params)).rows;});
  const {Client}=await import('pg');
  const fixture=new Client({connectionString:state.migrationDatabaseUrl,options:'-c search_path=rorca,public'});
  await fixture.connect();
  const workspace=path.join(packageRoot,'fixture-workspace');fs.mkdirSync(path.join(workspace,'forge/specs/approved'),{recursive:true});
  const ignorePolicyRevision=require(path.join(backend,'scripts/eco-golden-test-fixture.ts')).prepareGoldenTestRepository(workspace);
  console.log(JSON.stringify({stage:'TEST-ignore-policy-committed-before-source-seal',ignorePolicyRevision}));
  // Native compiler/publisher/sealer semantics from routes/__tests__/pipeline.test.ts.
  // This authority is explicitly synthetic TEST, never a canonical human receipt.
  const {publishSpecExportKit,sealSpecExportKit,assertSealedSpecExportKit}=require(path.join(build,'lib/spec-export-kit.js'));
  const source:any={id:'parent',title:'TEST machine-verifiable text only',userStories:[{id:'US-1',title:'Produce TEST text',description:'Synthetic text-only fixture; no code execution or human acceptance',acceptanceCriteria:['TEST text exact hash and required content'],executionManifest:{profileId:'TEST-native-text-v1',changePolicy:'no_code_allowed',noCodeReason:'Text artifact only; no implementation code or human review criteria'},passes:false}]};
  source.exportKitIdentity=publishSpecExportKit(workspace,source);
  const testSeal=sealSpecExportKit(workspace,source,{actorId:'TEST-eco24-fixture-approver',approvalReceiptId:'TEST-eco24-source-seal'});
  assertSealedSpecExportKit(workspace,source);
  console.log(JSON.stringify({stage:'TEST-compiler-produced-source',identity:source.exportKitIdentity,seal:testSeal}));
  fs.writeFileSync(path.join(workspace,'forge/specs/approved/parent.json'),JSON.stringify(source));
  for(const args of [['add','.'],['-c','user.name=TEST fixture','-c','user.email=test@example.test','commit','-m','TEST source fixture']])execFileSync('git',args,{cwd:workspace,stdio:'pipe'});
  if(execFileSync('git',['status','--porcelain','--untracked-files=all'],{cwd:workspace,encoding:'utf8'}).trim())throw Error('TEST source must be clean before admission');
  try{
   // Same restricted live-truth function installed by jest.setup.ts, not a
   // synthetic server identity. SECURITY DEFINER reads this actual PG16 host.
   await fixture.query(`CREATE FUNCTION rorca.test_invocation_server_identity()
    RETURNS TABLE(system_identifier TEXT,data_directory TEXT)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
     SELECT control.system_identifier::text,current_setting('data_directory') FROM pg_control_system() control
    $$; REVOKE ALL ON FUNCTION rorca.test_invocation_server_identity() FROM PUBLIC;`);
   const writerName=decodeURIComponent(new URL(state.canonicalWriterDatabaseUrl!).username);
   await fixture.query(`GRANT EXECUTE ON FUNCTION rorca.test_invocation_server_identity() TO "${writerName.replace(/"/g,'""')}"`);
   await fixture.query("INSERT INTO workspaces(id,label,path) VALUES('ws','ECO23 synthetic host fixture',$1)",[workspace]);
   await fixture.query("INSERT INTO spec_versions(workspace_id,spec_slug,version,content_json,status) VALUES('ws','parent',1,$1,'approved')",[source]);
   await fixture.query("INSERT INTO workspace_members(workspace_id,user_auth_id,role) VALUES('ws','00000000-0000-0000-0000-000000000002','member')");
   // Canonical effective-user lookup needs the app identity as well as the
   // credential subject. This is a service account, explicitly NOT a human.
   await fixture.query(`INSERT INTO spec_generation_logs (spec_slug,model,provider,duration_ms,context_summary,enriched,retrieval_method,context_summary_json,status,save_generation)
    VALUES ('parent','TEST-local-model','TEST-fixture',0,'TEST supplied context',false,'none',$1,'persisted',1)`,[JSON.stringify({workspaceId:'ws',contextCaptureStatus:{status:'provided',reason:'caller_supplied_context'},postSaveStages:{enrich:{requested:true,status:'completed',reason:'job_completed'},matchSkills:{requested:true,status:'completed',reason:'job_completed'}}})]);
   const {HERMES_OPERATOR_DISPATCH_USER_ID}=require(path.join(build,'lib/auth-utils.js'));
   await fixture.query("INSERT INTO users(id,email,display_name,role,plan,auth_id) VALUES($1,'eco23-service@example.test','ECO23 synthetic service','user','free','00000000-0000-0000-0000-000000000002')",[HERMES_OPERATOR_DISPATCH_USER_ID]);
  }finally{await fixture.end();}
  const app=require(path.join(build,'server.js')).default;
  http=await new Promise<import('node:http').Server>(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const port=(http.address() as {port:number}).port;
  const base=`http://127.0.0.1:${port}`;
  const {hermesAuthorityHeaders,declareHermesAuthority}=require(path.join(build,'lib/hermes-authority.js'));
  const headers={'Content-Type':'application/json','x-rorca-service':'hermes','x-rorca-internal':process.env.RORCA_INTERNAL_SERVICE_TOKEN!,
   ...hermesAuthorityHeaders(declareHermesAuthority('dispatch','operator-dispatch'))};
  const httpReceipt:any[]=[];
  for(const scope of ['ws','foreign']){
   const response=await fetch(`${base}/api/pipeline/provider/v1/capabilities?workspaceId=${scope}`,{headers});
   httpReceipt.push({operation:'actual-capabilities',scope,status:response.status,body:await response.json()});
  }
  const {body}=require(path.join(backend,'src/lib/__tests__/fixtures/eco-phase-work.fixture.ts'));
  const compilation=await require(path.join(build,'lib/ssdlc-plan-service.js')).compileSpecPlan({workspaceId:'ws',workspacePath:workspace,specSlug:'parent',source:'lazy-compile'});
  console.log(JSON.stringify({stage:'actual-lifecycle-compile',compilation}));
  const authority=new Client({connectionString:state.migrationDatabaseUrl,options:'-c search_path=rorca,public'});await authority.connect();
  let phaseFixture:any;
  try{phaseFixture=await require(path.join(backend,'scripts/eco-golden-test-fixture.ts')).prepareGoldenTestPhase(build,workspace,source,authority,appDb);}finally{await authority.end();}
  modelServer=require('node:http').createServer(async(req:any,res:any)=>{
   try{
    modelCalls++;for await(const _ of req){};
    const reservations=await readScoped("SELECT event_key,canonical_bytes FROM eco_managed_usage_events WHERE event_key LIKE 'model%'");
    console.log(JSON.stringify({stage:'TEST-loopback-provider-reservations-before-send',reservations}));
    if(reservations.length!==2)throw Error('committed model reservation and pins required before provider');
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end('data: '+JSON.stringify({id:'TEST-eco24',object:'chat.completion.chunk',created:1,model:'gpt-4o-mini-2024-07-18',choices:[{index:0,delta:{content:missingContent?'TEST missing required content':'TEST text proposal for review only.'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
   }catch(e){console.error(e);res.destroy();}
  });
  await new Promise<void>(resolve=>modelServer!.listen(0,'127.0.0.1',resolve));
  const endpoint=`http://127.0.0.1:${(modelServer!.address() as any).port}/v1/chat/completions`;
  const profile={mode:'local-fixture',model:'gpt-4o-mini-2024-07-18',endpoint,
   pricing:{scope:'local-fixture',qualificationRef:'TEST-eco24-synthetic-upper-cost',inputMicroUsdPerMillion:1,outputMicroUsdPerMillion:1,requestMicroUsd:1},
   limits:{maxInputTokens:10000,maxOutputTokens:100,maxRequestBytes:20000,maxResponseBytes:5000,maxTotalTokens:20000,maxTotalSpendMicroUsd:100,maxTotalResponseBytes:5000,maxRequests:1,timeoutMs:10000},sources:phaseFixture.sources};
  const hostModule=path.join(build,'lib/eco-structured-worker.js');
  const preload=path.join(packageRoot,'TEST-host-preload.cjs');
  fs.writeFileSync(preload,`const host=require(${JSON.stringify(hostModule)});const profile=${JSON.stringify(profile)};profile.tokenizer=host.createEcoOpenAiMiniTokenizer({qualificationRef:'TEST-eco24-local-only',scope:'local-fixture',packageVersion:'1.0.21',framing:'openai-chat-2024-v1'});host.installEcoStructuredHost(()=>profile);`);
  env.NODE_PATH=[path.join(backend,'node_modules'),path.join(scratch,'eco23-tokenizer/node_modules')].join(path.delimiter);
  // Same CommonJS instance in API publication and built worker, no module mocks.
  process.env.NODE_PATH=env.NODE_PATH;require('node:module').Module._initPaths();
  const host=require(hostModule);host.installEcoStructuredHost(()=>({...profile,tokenizer:host.createEcoOpenAiMiniTokenizer({qualificationRef:'TEST-eco24-local-only',scope:'local-fixture',packageVersion:'1.0.21',framing:'openai-chat-2024-v1'})}));
  const oldClosed=new Promise<void>(resolve=>worker!.once('close',()=>resolve()));worker!.kill('SIGTERM');await oldClosed;
  worker=spawn(process.execPath,['--require',preload,path.join(build,'worker.js')],{cwd:fixtureHome,env,stdio:['ignore','pipe','pipe']});
  worker.stdout!.on('data',record);worker.stderr!.on('data',record);
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('configured built worker startup timeout')),90000);const check=(b:Buffer)=>{if(b.toString().includes('[worker] ready — listening')){clearTimeout(timer);resolve();}};worker!.stdout!.on('data',check);worker!.stderr!.on('data',check);worker!.once('close',code=>{clearTimeout(timer);reject(Error(`configured built worker exited ${code}`));});});
  console.log(JSON.stringify({stage:'TEST-configured-built-worker-ready',pid:worker.pid}));
  const {sealExternalPhaseWork}=require(path.join(build,'lib/eco-phase-work.js'));
  const request={workspaceId:'ws',specPath:'forge/specs/approved/parent.json',storyId:'US-1',autoMerge:false,mergeStrategy:'branch-only',parallelism:1,
   idempotencyKey:'eco23-golden-original-command',phaseWorkBinding:phaseFixture.binding,
   ecoManagedAdmission:{contractVersion:'rorca.eco-managed-admission.v1',companyId:'company',ownerId:'watcher',fence:1,storyId:'US-1',deadlineAt:new Date(Date.now()+180000).toISOString()}};
  const preflight=await fetch(`${base}/api/pipeline/preflight`,{method:'POST',headers,body:JSON.stringify({workspaceId:'ws',specPath:request.specPath,storyId:'US-1',autoMerge:false,mergeStrategy:'branch-only',parallelism:1})});
  const previewBody:any=await preflight.json();httpReceipt.push({operation:'actual-preflight',status:preflight.status,body:previewBody});
  if(!preflight.ok)throw Error(`Actual preflight blocked: ${JSON.stringify(previewBody)}`);
  Object.assign(request,{previewHash:previewBody.preview.previewHash,previewExpiresAt:previewBody.preview.expiresAt});
  const response=await fetch(`${base}/api/pipeline/trigger`,{method:'POST',headers:{...headers,'Idempotency-Key':request.idempotencyKey},body:JSON.stringify(request)});
  const responseBody=await response.json();httpReceipt.push({operation:'actual-trigger',status:response.status,body:responseBody});
  if(response.ok){
   const replay=await fetch(`${base}/api/pipeline/trigger`,{method:'POST',headers:{...headers,'Idempotency-Key':request.idempotencyKey},body:JSON.stringify(request)});
   const replayBody=await replay.json();httpReceipt.push({operation:'actual-original-key-replay',status:replay.status,body:replayBody});
   fs.writeFileSync(path.join(receipts,`${evidencePrefix}-http.json`),JSON.stringify(httpReceipt,null,2)+'\n');
   let snapshot:any;
   for(let i=0;i<100;i++){
    snapshot={runs:await readScoped("SELECT id,status,host_closeout_event_id,dispatch_fence,terminal_checkout_sha,run_spec_path FROM pipeline_runs WHERE workspace_id='ws'"),events:await readScoped("SELECT run_id,event_key,canonical_bytes,content_hash FROM eco_managed_usage_events WHERE workspace_id='ws' ORDER BY event_key"),publications:await readScoped("SELECT run_id,state,boss_job_id,lease_owner,last_error FROM pipeline_dispatch_publications WHERE workspace_id='ws'")};
    if(snapshot.runs.some((r:any)=>['failed','cancelled','completed','done','partial_failure'].includes(r.status)))break;
    await new Promise(resolve=>setTimeout(resolve,500));
   }
   httpReceipt.push({operation:'actual-worker-readback',...snapshot,modelCalls});
  }
  httpReceipt.push({operation:'canonical-readback',runs:await readScoped("SELECT id,status FROM pipeline_runs WHERE workspace_id='ws'"),
   reservations:await readScoped("SELECT run_id,event_key FROM eco_managed_usage_events WHERE workspace_id='ws'"),
   pipelineJobs:await readScoped("SELECT id,state,name FROM pgboss_eco23.job WHERE name IN ('pipeline:run','pipeline:run:direct','pipeline:retry')")});
  httpReceipt.push({operation:'actual-authority-and-budget-readback',roots:await readScoped("SELECT root_run_id,current_run_id,retry_count,used_tool_calls,used_context_tokens,used_output_bytes,used_spend_micro_usd FROM eco_managed_roots WHERE workspace_id='ws'"),
   counts:await readScoped("SELECT (SELECT count(*) FROM eco_managed_run_bindings WHERE workspace_id='ws') AS managed_bindings,(SELECT count(*) FROM eco_phase_work_revisions WHERE workspace_id='ws') AS phase_revisions,(SELECT count(*) FROM eco_managed_closeout_links WHERE workspace_id='ws') AS accepted_closeout_links"),
   hostInspection:await appDb.transaction(async(client:any)=>{await client.query("SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',TRUE)");return require(path.join(build,'lib/run-host-authority.js')).inspectRunHostAuthority(Number((responseBody as any).runId));})});
  // Exact same committed BIGINT row and transaction; only authenticated RLS
  // principal changes. Workspace GUC alone must not reveal tenant workspace.
  const runId=Number((responseBody as any).runId);
  const native={manifests:await readScoped('SELECT manifest_hash,spec_revision,story_revision,payload FROM story_execution_manifests WHERE run_id=$1',[runId]),
    attempts:await readScoped('SELECT * FROM host_story_attempt_envelopes WHERE run_id=$1',[runId]),
    attemptResults:await readScoped('SELECT * FROM story_attempt_results WHERE run_id=$1',[runId]),
    decisions:await readScoped('SELECT * FROM story_closeout_decisions WHERE run_id=$1',[runId]),
    results:await readScoped('SELECT * FROM story_results WHERE run_id=$1',[runId]),
    attestations:await readScoped('SELECT * FROM checkpoint_validation_attestations WHERE run_id=$1',[runId]),
    wal:await readScoped('SELECT id,event_type,trust_provenance,trusted_source,event_identity_hash,outbox_ready_at,payload FROM wal_events WHERE canonical_run_id=$1',[runId]),
    links:await readScoped('SELECT * FROM eco_managed_closeout_links WHERE run_id=$1',[runId])};
  const canonicalSourceText=fs.readFileSync(path.join(workspace,'forge/specs/approved/parent.json'),'utf8');
  const runProjection=JSON.parse(fs.readFileSync(native.attempts[0].run_spec_path,'utf8'));
  const nativeFilesystem={canonicalSourceUnchanged:canonicalSourceText===JSON.stringify(source),runProjection,
   sourceHead:execFileSync('git',['rev-parse','HEAD'],{cwd:workspace,encoding:'utf8'}).trim(),
   worktreeHead:execFileSync('git',['rev-parse','HEAD'],{cwd:native.attempts[0].worktree_realpath,encoding:'utf8'}).trim(),
   worktreeStatus:execFileSync('git',['status','--porcelain','--untracked-files=all'],{cwd:native.attempts[0].worktree_realpath,encoding:'utf8'}),
   sourceIgnorePolicy:fs.readFileSync(path.join(workspace,'.gitignore'),'utf8'),
   worktreeIgnorePolicy:fs.readFileSync(path.join(native.attempts[0].worktree_realpath,'.gitignore'),'utf8')};
  httpReceipt.push({operation:'exact-filesystem-readback',...nativeFilesystem});
  httpReceipt.push({operation:'exact-native-evidence-readback',...native});
  if(response.ok){
   const runtimeProbe=new Client({connectionString:state.databaseUrl,options:'-c search_path=rorca,public'});await runtimeProbe.connect();
   const visibility=await (async()=>{
    const client=runtimeProbe;
    await client.query('BEGIN');
    const select=async()=> (await client.query(`SELECT current_user AS database_principal,session_user AS session_principal,
      current_setting('request.jwt.claim.sub',TRUE) AS authenticated_subject,
      current_setting('request.jwt.claims',TRUE) AS authenticated_claims,
      run.id::text AS id,pg_typeof(run.id)::text AS id_type,run.workspace_id,
      EXISTS(SELECT 1 FROM workspaces ws WHERE ws.id=run.workspace_id) AS workspace_visible,
      (SELECT count(*) FROM story_execution_manifests WHERE run_id=run.id) AS manifests,
      (SELECT count(*) FROM host_story_attempt_envelopes WHERE run_id=run.id) AS host_attempts,
      (SELECT count(*) FROM story_results WHERE run_id=run.id) AS results
      FROM pipeline_runs run WHERE run.id=$1`,[runId])).rows;
    const unscoped=await select();
    await client.query("SELECT set_config('rorca.workspace_id','ws',TRUE)");const workspaceOnly=await select();
    await client.query("SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000003',TRUE)");const foreignPrincipal=await select();
    await client.query("SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',TRUE)");const exactPrincipal=await select();
    return {unscoped,workspaceOnly,foreignPrincipal,exactPrincipal};
   })().finally(async()=>{try{await runtimeProbe.query('ROLLBACK');}finally{await runtimeProbe.end();}});
   httpReceipt.push({operation:'exact-closeout-lookup-root-cause',...visibility});
   fs.writeFileSync(path.join(receipts,`${evidencePrefix}-http.json`),JSON.stringify(httpReceipt,null,2)+'\n');
   const assert=require('node:assert/strict');
   assert.equal(visibility.unscoped[0].id,String(runId));assert.equal(visibility.unscoped[0].id_type,'bigint');
   assert.equal(visibility.exactPrincipal[0].workspace_visible,true);
   const control=new Client({connectionString:state.migrationDatabaseUrl,options:'-c search_path=rorca,public'});await control.connect();
   const denials:any[]=[];
   try{
    const canonical=(await control.query('SELECT trigger_options FROM pipeline_runs WHERE id=$1',[runId])).rows[0].trigger_options;
    const scope={binding:canonical.phaseWorkBinding,claim:canonical.lifecycleDispatchClaim,...canonical.ecoManagedAdmission,
     principalId:'00000000-0000-0000-0000-000000000002',idempotencyKey:request.idempotencyKey,requestHash:(await control.query('SELECT dispatch_request_hash FROM pipeline_runs WHERE id=$1',[runId])).rows[0].dispatch_request_hash,specPath:request.specPath};
    const {assertEcoManagedAuthority}=require(path.join(build,'lib/eco-managed-admission.js'));
    for(const mutation of ['control','missing-membership','revoked-source','stale-fence']){
     await control.query('BEGIN');
     try{
      if(mutation==='missing-membership')await control.query("DELETE FROM workspace_members WHERE workspace_id='ws' AND user_auth_id=$1",[scope.principalId]);
      if(mutation==='revoked-source')await control.query("INSERT INTO eco_host_record_revocations(workspace_id,kind,record_key,reason) VALUES('ws','source',$1,'TEST rollback-only revocation')",[require(path.join(build,'lib/eco-phase-work.js')).contractHash(scope.binding.phaseWork.sourceBindings[0])]);
      if(mutation==='stale-fence')await control.query("UPDATE eco_watcher_owners SET fence=fence+1 WHERE workspace_id='ws' AND phase_work_id=$1",[scope.binding.phaseWork.id]);
      let error:string|null=null;try{await assertEcoManagedAuthority(control,scope);}catch(e){error=e instanceof Error?e.message:String(e);}
      denials.push({mutation,error});assert.equal(error===null,mutation==='control',JSON.stringify(denials));
     }finally{await control.query('ROLLBACK');}
    }
   }finally{await control.end();}
   httpReceipt.push({operation:'actual-rollback-only-authority-regression',denials});
  }
  fs.writeFileSync(path.join(receipts,`${evidencePrefix}-http.json`),JSON.stringify(httpReceipt,null,2)+'\n');
  console.log(JSON.stringify({stage:'actual-HTTP-trigger',status:response.status,body:responseBody}));
  if(!response.ok)throw Error(`Actual HTTP trigger blocked (${response.status}); see INCREMENT-26-http.json; do not replace native gate with service mocks`);
  const observed=httpReceipt.find((r:any)=>r.operation==='actual-worker-readback');
  const replay=httpReceipt.find((r:any)=>r.operation==='actual-original-key-replay');
  const assert=require('node:assert/strict');
  assert.equal(response.status,201);assert.equal(replay?.status,200);assert.equal(replay.body.runId,responseBody.runId);
  assert.equal(observed.runs.length,1);assert.equal(modelCalls,1);
  assert.equal(nativeFilesystem.canonicalSourceUnchanged,true);
  assert.equal(nativeFilesystem.sourceIgnorePolicy,nativeFilesystem.worktreeIgnorePolicy);
  assert.ok(!nativeFilesystem.worktreeStatus.includes('.gitignore'));
  assert.equal(observed.events.filter((e:any)=>e.event_key.startsWith('model:')).length,1);
  const proposal=observed.events.find((e:any)=>e.event_key==='artifact:code');
  const observation=observed.events.find((e:any)=>e.event_key==='artifact-validation:code');
  assert.ok(proposal);assert.ok(observation);assert.equal(JSON.parse(proposal.canonical_bytes).acceptanceAuthority,'none');
  assert.equal(JSON.parse(observation.canonical_bytes).codeExecution,'not-performed');
  if(missingContent){
    assert.equal(observed.runs[0].status,'failed');assert.equal(native.results.length,0);assert.equal(native.links.length,0);
    assert.equal(native.attempts.length,1);assert.equal(native.attempts[0].outcome,'nonzero_exit');
    assert.equal(native.decisions[0].status,'blocked');
    console.log(JSON.stringify({stage:'TEST-missing-content-denied',runId:responseBody.runId,status:'failed',nativeResults:0,checks:native.attemptResults[0].payload.hostValidationObservations}));return;
  }
  assert.equal(native.manifests.length,1);assert.equal(native.attempts.length,1);assert.equal(native.results.length,1);
  assert.equal(native.attempts[0].outcome,'success');assert.equal(native.attempts[0].outcome_provenance,'host_process');assert.equal(native.attempts[0].exit_code,0);
  assert.equal(native.attempts[0].manifest_hash,native.manifests[0].manifest_hash);assert.equal(native.results[0].manifest_hash,native.manifests[0].manifest_hash);
  assert.equal(native.decisions[0].status,'accepted');assert.equal(native.results[0].closeout_decision_id,native.decisions[0].decision_id);
  assert.equal(native.links.length,1);assert.equal(native.attestations.length,1);
  assert.equal(native.attemptResults.length,1);assert.equal(native.decisions.length,1);
  const envelope=native.attempts[0],manifest=native.manifests[0],attempt=native.attemptResults[0],decision=native.decisions[0],result=native.results[0];
  assert.equal(envelope.cancellation_fence,observed.runs[0].dispatch_fence);
  for(const row of [envelope,attempt,decision,result]){
   assert.equal(String(row.run_id),String(runId));assert.equal(row.story_id,'US-1');assert.equal(row.attempt ?? row.completion_packet?.identity.attempt,1);
   assert.equal(row.manifest_hash,manifest.manifest_hash);
  }
  assert.equal(envelope.spec_revision,manifest.spec_revision);assert.equal(envelope.story_revision,manifest.story_revision);
  assert.equal(attempt.payload.revisions.specRevision,manifest.spec_revision);assert.equal(attempt.payload.revisions.storyRevision,manifest.story_revision);
  assert.equal(decision.attempt_result_id,attempt.attempt_result_id);
  assert.equal(result.closeout_decision_id,decision.decision_id);
  for(const sha of [envelope.base_git_sha,envelope.observed_git_sha,envelope.expected_git_sha,decision.payload.activeSubjectRevision.commitSha,result.commit_sha,observed.runs[0].terminal_checkout_sha,nativeFilesystem.worktreeHead])assert.equal(sha,nativeFilesystem.sourceHead);
  const validations=attempt.payload.hostValidationObservations;
  assert.equal(validations.length,1);assert.equal(validations[0].classification,'passed');assert.equal(validations[0].termination.exitCode,0);
  assert.equal(validations[0].repositoryRevisionBefore,nativeFilesystem.sourceHead);assert.equal(validations[0].repositoryRevisionAfter,nativeFilesystem.sourceHead);
  assert.equal(nativeFilesystem.runProjection.userStories[0].passes,true);
  // `passes` is the intentional lifecycle projection, not an admitted input.
  // Verify that it is the ONLY changed value; hash the unchanged admitted source.
  const unprojected=JSON.parse(JSON.stringify(nativeFilesystem.runProjection));unprojected.userStories[0].passes=false;
  assert.deepEqual(unprojected,source);
  assert.equal(require(path.join(build,'lib/story-execution-packet.js')).deriveStoryContractRevision(source),manifest.spec_revision);
  const passed=native.wal.filter((e:any)=>e.event_type==='story_passed');assert.equal(passed.length,1);
  assert.equal(String(passed[0].payload.story_result_id),String(result.id));assert.equal(passed[0].trust_provenance,'host');
  assert.equal(passed[0].payload.closeout_decision_id,decision.decision_id);
  assert.equal(passed[0].payload.checkpoint_attestation_id,native.attestations[0].id);
  const {createHash}=require('node:crypto');const {canonicalJson}=require(path.join(build,'lib/eco-phase-work.js'));
  const checkpointDigest=createHash('sha256').update(canonicalJson({manifestHash:manifest.manifest_hash,decisionId:decision.decision_id,artifactObservations:validations,phaseHash:phaseFixture.binding.phaseWork.contentHash,dispatchFence:envelope.cancellation_fence,generation:envelope.launch_generation,head:nativeFilesystem.sourceHead,branch:envelope.worktree_branch})).digest('hex');
  assert.equal(native.attestations[0].evidence_digest,checkpointDigest);assert.equal(passed[0].payload.checkpoint_attestation_digest,checkpointDigest);
  const closeout=native.wal.filter((e:any)=>e.event_type==='run_closeout');assert.equal(closeout.length,1);
  assert.equal(Number(closeout[0].id),Number(observed.runs[0].host_closeout_event_id));
  assert.equal(closeout[0].payload.integrated_revision,nativeFilesystem.sourceHead);assert.deepEqual(closeout[0].payload.accepted_story_ids,['US-1']);
  assert.equal(native.links[0].closeout_event_id,closeout[0].id);
  const link=JSON.parse(native.links[0].canonical_bytes);
  assert.equal(link.closeoutIdentityHash,closeout[0].event_identity_hash);assert.equal(link.phaseHash,phaseFixture.binding.phaseWork.contentHash);
  const inspection=httpReceipt.find((r:any)=>r.operation==='actual-authority-and-budget-readback').hostInspection;
  assert.equal(inspection.releaseEligible,true);assert.equal(inspection.complete,true);assert.equal(inspection.stories[0].resultId,result.id);
  assert.ok(native.wal.find((e:any)=>e.event_type==='story_passed'&&e.outbox_ready_at));
  assert.equal(observed.runs[0].status,'done','native terminal success is required; proposal/process success is insufficient');
  assert.ok(observed.runs[0].host_closeout_event_id,'native closeout pointer is required');
  console.log(JSON.stringify({stage:'TEST-terminal-text-proposal-proof',runId:responseBody.runId,status:observed.runs[0].status,modelCalls,proposalHash:proposal.content_hash,observationHash:observation.content_hash,nativeTextAcceptance:true,codeExecution:'not-performed',humanAcceptance:false}));
 }finally{
  process.chdir(backend);
  if(heartbeat)clearInterval(heartbeat);
  if(http){http.closeAllConnections();await new Promise<void>(resolve=>http!.close(()=>resolve()));}
  await appBoss?.stopBoss();await appDb?.closePool();
  if(worker&&worker.exitCode===null&&worker.signalCode===null){
   const closed=new Promise<void>(resolve=>worker!.once('close',()=>resolve()));worker.kill('SIGTERM');
   const timer=setTimeout(()=>worker!.kill('SIGKILL'),5000);await closed;clearTimeout(timer);
  }
  if(modelServer){modelServer.closeAllConnections();await new Promise<void>(resolve=>modelServer!.close(()=>resolve()));}
  fs.rmSync(fixtureHome,{recursive:true,force:true});
  if(state){await cleanupIsolatedTestDatabase(env);console.log(JSON.stringify({stage:'exact-invocation-cleanup',removed:!fs.existsSync(state.root),fixtureHomeRemoved:!fs.existsSync(fixtureHome),modelCalls}));}
 }
}
void main().then(()=>process.exit(0),error=>{console.error(error);process.exit(1);});
