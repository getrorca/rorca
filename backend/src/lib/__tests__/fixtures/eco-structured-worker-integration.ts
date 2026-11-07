/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import type {TestContext} from 'node:test';
import type {EcoTransaction} from '../../eco-managed-runtime';

/** Invoked only after the parent verifies its newly created socket-only cluster.
 * No application DB/config bootstrap and no pg defaults are imported here. */
export async function exerciseStructuredWorker(t:TestContext,ctx:any) {
 const {query,admin,transaction,put,raw,input,binding,options,payload,insert,claimLifecycleDispatch,publication}=ctx;
 const {sealExternalPhaseWork,contractHash}=require('../../eco-phase-work') as typeof import('../../eco-phase-work');
 const {executeEcoManagedWorker,requireEcoBoundedExecutor}=require('../../eco-managed-runtime') as typeof import('../../eco-managed-runtime');
 const {installEcoStructuredHost,installEcoStructuredWorkerBootstrap,createEcoTypedToolGateway}=require('../../eco-structured-worker') as typeof import('../../eco-structured-worker');
 const sha=(s:string)=>`sha256:${createHash('sha256').update(s).digest('hex')}`;
 for(const scenario of ['success','lease-loss','cancel','watcher-loss','revoke','exhausted'] as const)await t.test(`structured broker actual worker composition: ${scenario}`,async()=>{
  const source='explicit fixture source';
  const phaseRaw=structuredClone(raw);phaseRaw.id=randomUUID();
  phaseRaw.budgets={...raw.budgets,contextTokens:32000,outputBytes:20000,spendMicroUsd:100,tokenizer:'fixture-character-chat'};
  phaseRaw.effectPolicy={...raw.effectPolicy,allowReadRoots:['src'],allowWriteRoots:['out'],permittedToolClasses:['read','write']};
  phaseRaw.sourceBindings=raw.sourceBindings.map((s:any)=>({...s,sourcePath:'src/source.md',artifactPath:'src/source.md',artifactHash:sha(source),packageHash:sha(source)}));
  phaseRaw.deliverables=[{...raw.deliverables[0],maximumBytes:1000}];
  const recipe={contractVersion:'eco.recipe/proposal-v1',id:`structured-fixture-${scenario}`,semanticVersion:'1.0.0',effectPolicy:phaseRaw.effectPolicy,budgets:phaseRaw.budgets,phases:['development'],workKind:'implementation',executionModes:['rorca-managed'],prompt:'LABELED TEXT FIXTURE',modelJudgment:['Fixture'],inputs:[{id:'source',kind:'source-artifact',description:'Pinned fixture'}],outputs:phaseRaw.deliverables.map(({criterionIds,...o}:any)=>o),steps:['inspect','read','collect','write'].map(id=>({id,action:'Typed fixture',toolClass:id==='write'?'write':'read',required:true})),checks:phaseRaw.criteria.map((c:any)=>({id:c.id,evaluatorKind:c.evaluatorKind,requirement:c.description})),stop:'artifact-review-submission',onMissingInput:'block',onSourceChange:'require-new-revision',onTimeout:'stop-and-reconcile'};
  // Use the existing producer-compatible timeout enum, not an adapter invention.
  recipe.onTimeout='stop-and-reconcile';
  phaseRaw.recipeBinding={id:recipe.id,semanticVersion:'1.0.0',contentHash:contractHash(recipe)};
  const phase=sealExternalPhaseWork(phaseRaw),freshBinding={...binding,phaseWork:phase};
  await put('recipe',phase.recipeBinding.contentHash,recipe);
  for(const s of phase.sourceBindings)await admin.query(`INSERT INTO eco_host_records(workspace_id,kind,record_key,canonical_bytes,content_hash) VALUES('ws','source',$1,$2,$3) ON CONFLICT DO NOTHING`,[contractHash(s),JSON.stringify(s,Object.keys(s).sort()),contractHash(s)]);
  await put('story-mapping',phase.contentHash,{phaseHash:phase.contentHash,parentHash:phase.parentBinding!.planHash,specId:'parent',specHash:input.claim.specHash,providerSpecVersion:'7',storyId:'US-1',specPath:input.specPath});
  await admin.query(`INSERT INTO eco_watcher_owners VALUES('ws','company',$1,'principal','watcher',1,clock_timestamp()+interval '60 seconds',FALSE)`,[phase.id]);
  const key=`eco22-${scenario}`;
  const claim=await claimLifecycleDispatch({workspaceId:'ws',specId:'parent',specHash:input.claim.specHash,compiledPlanId:'1',requestIdentity:`pipeline:${key}`,requestHash:input.requestHash});
  const fresh={...input,binding:freshBinding,claim,idempotencyKey:key,deadlineAt:new Date(Date.now()+500000).toISOString()};
  const freshOptions={...options,lifecycleDispatchClaim:claim,phaseWorkBinding:freshBinding,ecoManagedAdmission:{...options.ecoManagedAdmission,deadlineAt:fresh.deadlineAt}};
  const {reserveEcoManagedCanonicalRun}=await import('../../eco-managed-runtime');
  const reserved=await transaction((c:any)=>reserveEcoManagedCanonicalRun(c,fresh,()=>insert(c,fresh,freshOptions)));
  const id=reserved.runId,freshPayload={...payload,runId:id,triggerOptions:freshOptions};
  let sends=0,closed=0,fixtureError:unknown,mutated:Promise<any>|undefined;
  let serverClose:Promise<void>|undefined;
  const server=createServer(async(req,res)=>{
   try {
    sends++;for await(const _ of req){};
    const events=await query("SELECT event_key,canonical_bytes FROM eco_managed_usage_events WHERE run_id=$1 AND event_key LIKE 'model%'",[id]);
    assert.equal(events.length,2,'reservation and model identities COMMITTED before HTTP send');
    assert.ok(events.some((e:any)=>e.event_key.startsWith('model-pins:')));
    await admin.query('BEGIN');
    try {await admin.query('SELECT * FROM eco_managed_roots WHERE current_run_id=$1 FOR UPDATE NOWAIT',[id]);}
    finally {await admin.query('ROLLBACK');}
    assert.equal((await query("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'"))[0].count,'0','no effect transaction held');
    res.writeHead(200,{'content-type':'text/event-stream'});
    const chunk=(content:string,finish:string|null)=>`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture-text',choices:[{index:0,delta:{content},finish_reason:finish}]})}\n\n`;
    res.write(chunk('artifact',null));
    if(scenario==='success'){res.end(chunk('', 'stop')+'data: [DONE]\n\n');return;}
    serverClose=new Promise(resolve=>res.once('close',resolve));
    setTimeout(()=>{
     const sql=scenario==='lease-loss'?`UPDATE pipeline_dispatch_publications SET lease_owner='lost' WHERE run_id=$1`
      :scenario==='cancel'?'INSERT INTO pipeline_run_cancellation_requests VALUES($1)'
      :scenario==='watcher-loss'?`UPDATE eco_watcher_owners SET revoked=TRUE WHERE phase_work_id=$1`
      :`INSERT INTO eco_host_record_revocations VALUES('ws','recipe',$1,'fixture midcall revocation')`;
     mutated=admin.query(sql,[scenario==='watcher-loss'?phase.id:scenario==='revoke'?phase.recipeBinding.contentHash:id]);
    },650); // at least two healthy independent polls
   }catch(e){fixtureError=e;res.destroy();}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address() as {port:number};
  const uninstallBootstrap=installEcoStructuredWorkerBootstrap();
  await assert.rejects(async()=>requireEcoBoundedExecutor(fresh),/missing qualified/);
  const uninstallHost=installEcoStructuredHost(()=>({mode:'local-fixture',model:'fixture-text',endpoint:`http://127.0.0.1:${address.port}/v1/chat/completions`,
   tokenizer:{id:'fixture-character-chat',qualificationRef:'local-fixture-only',scope:'local-fixture',provider:'openai',model:'fixture-text',protocol:'openai-chat-text-v1',kind:'exact',countInput:messages=>messages.reduce((n,m)=>n+m.content.length+8,0),countOutput:text=>text.length},
   pricing:{scope:'local-fixture',qualificationRef:'fixture-upper-cost',inputMicroUsdPerMillion:1,outputMicroUsdPerMillion:1,requestMicroUsd:1},
   limits:{maxInputTokens:10000,maxOutputTokens:100,maxRequestBytes:20000,maxResponseBytes:5000,maxTotalTokens:20000,maxTotalSpendMicroUsd:100,maxTotalResponseBytes:5000,maxRequests:1,timeoutMs:4000},sources:{'src/source.md':source}}));
  try {
   const pub=await publication.claimDispatchPublication({runId:id,workspaceId:'ws',expectedRequestHash:input.requestHash});
   const prepared=await publication.prepareDispatchPublication({runId:id,owner:pub.owner,requestHash:input.requestHash,effectiveOptionsHash:input.requestHash,payload:freshPayload});
   await publication.publishPreparedDispatch({runId:id,owner:pub.owner,bossJobId:prepared.bossJobId,payloadHash:prepared.payloadHash,payload:freshPayload});
   assert.equal((await publication.claimDispatchForWorker({runId:id,bossJobId:prepared.bossJobId,payload:freshPayload,workerId:'fixture-worker',queueName:'pipeline:run'})).claimed,true);
   if(scenario==='exhausted')await admin.query('UPDATE eco_managed_roots SET used_context_tokens=context_limit WHERE current_run_id=$1',[id]);
   const pending=executeEcoManagedWorker({runId:id,payload:freshPayload,transaction:transaction as EcoTransaction,worker:{ownerId:'fixture-worker'},closeout:async()=>{closed++;}});
   if(scenario==='success')assert.equal(await pending,true);
   else await assert.rejects(pending,scenario==='exhausted'?/quota.*exhausted/i:/.+/);
   await mutated;await serverClose;
   assert.equal(fixtureError,undefined);
   assert.equal(sends,scenario==='exhausted'?0:1);assert.equal(closed,scenario==='success'?1:0);
   const root=(await query('SELECT used_context_tokens,used_spend_micro_usd FROM eco_managed_roots WHERE current_run_id=$1',[id]))[0];
   if(scenario!=='exhausted'){assert.ok(Number(root.used_context_tokens)>0);assert.ok(Number(root.used_spend_micro_usd)>0);}
   const artifacts=await query("SELECT canonical_bytes FROM eco_managed_usage_events WHERE run_id=$1 AND event_key LIKE 'artifact:%'",[id]);
   assert.equal(artifacts.length,scenario==='success'?1:0);
   if(artifacts.length){assert.equal(JSON.parse(artifacts[0].canonical_bytes).text,'artifact');assert.equal(JSON.parse(artifacts[0].canonical_bytes).acceptanceAuthority,'none');}
   const observations=await query("SELECT canonical_bytes,content_hash FROM eco_managed_usage_events WHERE run_id=$1 AND event_key LIKE 'artifact-validation:%'",[id]);
   assert.equal(observations.length,scenario==='success'?1:0);
   if(observations.length){
    const observed=JSON.parse(observations[0].canonical_bytes);
    assert.equal(observed.artifactHash,sha('artifact'));assert.equal(observed.byteLength,Buffer.byteLength('artifact'));
    assert.equal(observed.phaseHash,phase.contentHash);assert.equal(observed.recipeHash,phase.recipeBinding.contentHash);
    assert.equal(observed.acceptanceAuthority,'none');assert.equal(observed.codeExecution,'not-performed');
    assert.ok(observed.criterionResults.every((c:any)=>c.outcome==='not-evaluated'));
    assert.equal(contractHash(observed),observations[0].content_hash);
   }
   await assert.rejects(executeEcoManagedWorker({runId:id,payload:freshPayload,transaction,worker:{ownerId:'fixture-worker'},closeout:async()=>{}}),/.+/);
  }finally{uninstallHost();uninstallBootstrap();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
 });
 await t.test('typed gateway refuses exec, fetch, traversal, unpinned reads and undeclared writes before effects',async()=>{
  let effects=0;
  const gateway=createEcoTypedToolGateway(input,{}, {runId:1,reserveModel:async()=>{effects++;},reserveTool:async()=>{effects++;},storeArtifact:async()=>{effects++;}});
  for(const raw of [{tool:'fetch',url:'http://127.0.0.1/'},{tool:'exec',command:'true'},{tool:'read',path:'../secret'}, {tool:'read',path:'src/unpinned'}, {tool:'write',path:'src/escape',text:'x'}])await assert.rejects(gateway.invoke(raw,new AbortController().signal));
  assert.equal(effects,0);
 });
}
