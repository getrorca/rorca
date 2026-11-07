/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Managed wiring shared by canonical HTTP admission, outbox and worker.
 * No authority issuer, model client, scheduler or ambient database connection.
 */
import { createHash, randomUUID } from 'node:crypto';
import { ConflictError } from './errors';
import { canonicalJson, contractHash, EcoPhaseWorkBindingSchema, type EcoBindingClient, type EcoPhaseWorkBinding } from './eco-phase-work';
import { admitEcoManagedRun, assertEcoManagedAuthority, consumeEcoManagedBudget, EcoManagedAdmissionSchema, type EcoManagedInput } from './eco-managed-admission';
import type { LifecycleDispatchClaim } from './lifecycle-dispatch-claim';
import type { EcoModelReservation } from './eco-model-budget';

export interface EcoWorkerEffects {
 readonly runId:number;
 reserveModel(reservation:Readonly<EcoModelReservation>,signal:AbortSignal):Promise<void>;
 reserveTool(eventKey:string,usage:{toolCalls:number;contextTokens:number;outputBytes:number;spendMicroUsd:number},signal:AbortSignal):Promise<void>;
 storeArtifact(relativePath:string,text:string,signal:AbortSignal):Promise<void>;
}
export function ecoModelIdentity(scope:Readonly<EcoManagedInput>,runId:number) {
 const phase=scope.binding.phaseWork;
 return {rootId:`${phase.workspaceId}:${phase.id}:${phase.revision}`,attemptId:String(runId),
  authorityHash:contractHash({phaseHash:phase.contentHash,claim:scope.claim,ownerId:scope.ownerId,fence:scope.fence,runId})};
}

export type EcoTransaction = <T>(action:(client:EcoBindingClient)=>Promise<T>)=>Promise<T>;
export const ECO_PREPARED_PROTOCOL = 'rorca.eco-prepared-dispatch.v1';
const zero = {toolCalls:0,contextTokens:0,outputBytes:0,spendMicroUsd:0};
const object = (v:unknown):Record<string,any> => typeof v==='string' ? object(JSON.parse(v)) : v && typeof v==='object' && !Array.isArray(v) ? v as Record<string,any> : {};
const deny = (message:string):never => {throw new ConflictError(message);};

/** The insert callback is the existing canonical run INSERT on this transaction.
 * Metadata is only a selector for host records. It is never an approval grant.
 */
export async function reserveEcoManagedCanonicalRun(client:EcoBindingClient,input:EcoManagedInput,insert:()=>Promise<{id:number}>) {
 return admitEcoManagedRun(client,input,insert);
}

/** Always inspect canonical metadata, not just the queue payload: removing all
 * managed fields from a forged delivery must not turn a managed run into legacy.
 * Legacy calls do not read any optional ECO tables (rolling schema compatibility).
 */
export async function assertEcoDispatch(client:EcoBindingClient,runId:number,payload?:Record<string,unknown>):Promise<EcoManagedInput|undefined> {
 const run=(await client.query('SELECT workspace_id,status,spec_path,trigger_options,dispatch_request_hash,idempotency_key,retried_from_run_id FROM pipeline_runs WHERE id=$1',[runId])).rows[0];
 if(!run)deny('Canonical run is missing');
 const options=object(run.trigger_options);
 const supplied=object(payload?.triggerOptions);
 if(!options.ecoManagedAdmission){
  if(supplied.ecoManagedAdmission)deny('Managed delivery has no canonical admission');
  return undefined;
 }
 const managed=EcoManagedAdmissionSchema.parse(options.ecoManagedAdmission);
 if(['failed','done','completed','partial_failure','cancelled'].includes(run.status))deny('Managed canonical run is terminal');
 const binding=EcoPhaseWorkBindingSchema.parse(options.phaseWorkBinding);
 if(payload && (canonicalJson(supplied.ecoManagedAdmission??null)!==canonicalJson(options.ecoManagedAdmission)
  ||canonicalJson(supplied.phaseWorkBinding??null)!==canonicalJson(binding)
  ||canonicalJson(supplied.lifecycleDispatchClaim??null)!==canonicalJson(options.lifecycleDispatchClaim)
  ||payload.workspaceId!==run.workspace_id||Number(payload.runId)!==runId||payload.specPath!==run.spec_path))deny('Managed delivery is missing or differs from frozen pins');
 await client.query("SELECT set_config('rorca.workspace_id',$1,TRUE)",[run.workspace_id]);
 const row=(await client.query(`SELECT binding.*,root.company_id,root.deadline_at,root.current_run_id
  FROM eco_managed_run_bindings binding JOIN eco_managed_roots root
  ON root.workspace_id=binding.workspace_id AND root.phase_work_id=binding.phase_work_id AND root.revision=binding.revision
  WHERE binding.workspace_id=$1 AND binding.run_id=$2`,[run.workspace_id,runId])).rows[0];
 if(!row||Number(row.current_run_id)!==runId||row.phase_hash!==binding.phaseWork.contentHash
  ||row.phase_work_id!==binding.phaseWork.id||Number(row.revision)!==binding.phaseWork.revision
  ||row.request_hash!==run.dispatch_request_hash||row.idempotency_key!==run.idempotency_key
  ||Number(row.predecessor_run_id??0)!==Number(run.retried_from_run_id??0)
  ||row.owner_id!==managed.ownerId||Number(row.fence)!==managed.fence||row.company_id!==managed.companyId)deny('Managed canonical binding is missing or stale');
 const input:EcoManagedInput={binding,claim:options.lifecycleDispatchClaim as LifecycleDispatchClaim,principalId:row.principal_id,
  ...managed,idempotencyKey:row.idempotency_key,requestHash:row.request_hash,specPath:run.spec_path,
  deadlineAt:new Date(row.deadline_at).toISOString(),...(run.retried_from_run_id?{predecessorRunId:Number(run.retried_from_run_id)}:{})};
 await assertEcoManagedAuthority(client,input);
 // Revalidate full current parent bytes as well as stored hashes at each boundary.
 const {assertEcoPhaseWorkParent}=await import('./eco-phase-work');
 const {assertEcoAcceptedPrerequisites}=await import('./eco-managed-admission');
 await assertEcoPhaseWorkParent(client,input.claim,binding,()=>assertEcoAcceptedPrerequisites(client,binding.phaseWork));
 const cancelled=(await client.query('SELECT run_id FROM pipeline_run_cancellation_requests WHERE run_id=$1',[runId])).rows[0];
 if(cancelled)deny('Managed execution is fenced by cancellation');
 return input;
}

/** A bounded adapter must own containment, authoritative upper bounds and
 * confirmed cancellation of its effects. Generic CLI/model engines are NOT
 * adapters for this protocol. There is intentionally no production registration
 * or JSON capability/approved boolean. The test supplies a labeled simulator.
 */
export interface EcoBoundedExecutor {
 readonly hostValidationKind?: 'text-artifact-v1';
 readonly protocol:typeof ECO_PREPARED_PROTOCOL;
 bind?(effects:EcoWorkerEffects):void;
 steps(input:Readonly<EcoManagedInput>):Promise<readonly {id:string;usage:typeof zero}[]>;
 perform(stepId:string,signal:AbortSignal):Promise<void>;
 stop():Promise<void>;
}
type ExecutorFactory=(scope:Readonly<EcoManagedInput>)=>EcoBoundedExecutor;
let executorFactory:ExecutorFactory|undefined;
/** Trusted worker/API bootstrap composition only; never an HTTP/MCP field,
 * environment switch or qualification receipt. Registering a factory does not
 * enable managedAdmission capability or attest production effect containment.
 * The explicit simulator in integration tests is the only current consumer.
 */
export function installEcoBoundedExecutor(factory:ExecutorFactory):()=>void {
 if(executorFactory)deny('Bounded executor bootstrap is already installed');
 executorFactory=factory;return()=>{if(executorFactory===factory)executorFactory=undefined;};
}
export function requireEcoBoundedExecutor(scope:EcoManagedInput):EcoBoundedExecutor {
 const executor=executorFactory?.(scope);
 if(!executor||executor.protocol!==ECO_PREPARED_PROTOCOL)deny('Bounded managed executor unavailable; generic engine fallback is forbidden');
 return executor!;
}
export async function executeEcoManagedWorker(input:{runId:number;payload:Record<string,unknown>;transaction:EcoTransaction;worker?:{ownerId:string;retryIdentityHash?:string;fence?:number};executor?:EcoBoundedExecutor;closeout:()=>Promise<void>}):Promise<boolean> {
 const scope=await input.transaction(c=>assertEcoDispatch(c,input.runId,input.payload));
 if(!scope)return false;
 const executor=input.executor??requireEcoBoundedExecutor(scope);
 if(executor.protocol!==ECO_PREPARED_PROTOCOL)deny('Bounded managed executor protocol differs');
 const checkWorker = async (client:EcoBindingClient) => {
  if(!input.worker)deny('Managed worker lacks existing dispatch lease identity');
  const worker=input.worker!;
  const lease=worker.retryIdentityHash
   ? await client.query(`SELECT lease_expires_at FROM governed_retry_dispatches WHERE retry_run_id=$1 AND identity_hash=$2
      AND lease_owner=$3 AND fencing_token=$4 AND state IN ('claimed','executing') AND lease_expires_at>clock_timestamp() AND cancellation_requested_at IS NULL`,
     [input.runId,worker.retryIdentityHash,worker.ownerId,worker.fence])
   : await client.query(`SELECT lease_expires_at FROM pipeline_dispatch_publications WHERE run_id=$1 AND state='claimed'
      AND lease_owner=$2 AND lease_expires_at>clock_timestamp()`,[input.runId,worker.ownerId]);
  if(!lease.rows[0])deny('Managed worker lost existing dispatch lease/fence');
  return new Date(lease.rows[0].lease_expires_at).getTime();
 };
 await input.transaction(async client=>{
  await assertEcoDispatch(client,input.runId,input.payload);
  await checkWorker(client);
  // Durable no-relaunch marker. A crash after this point is uncertain and must
  // be observed/closed out by the existing host, never repeat executor effects.
  const existing=await client.query('SELECT event_key FROM eco_managed_usage_events WHERE workspace_id=$1 AND run_id=$2 AND event_key=$3',
   [scope.binding.phaseWork.workspaceId,input.runId,'worker-start']);
  if(existing.rows[0])deny('Managed worker already started; reconcile uncertain effects, do not relaunch');
  await consumeEcoManagedBudget(client,{workspaceId:scope.binding.phaseWork.workspaceId,runId:input.runId,eventKey:'worker-start',principalId:scope.principalId,
   companyId:scope.companyId,ownerId:scope.ownerId,fence:scope.fence,usage:zero});
 });
 const controller=new AbortController();
 try {
 const nativeTextAttempt=executor.hostValidationKind==='text-artifact-v1'
  ? await (await import('./eco-native-text-closeout')).prepareEcoNativeTextAttempt(input.runId,scope,input.worker!.ownerId,
    id=>input.transaction(async c=>{await assertEcoDispatch(c,input.runId,input.payload);await checkWorker(c);
      return (await c.query('SELECT canonical_bytes,content_hash FROM eco_managed_usage_events WHERE workspace_id=$1 AND run_id=$2 AND event_key=$3',[scope.binding.phaseWork.workspaceId,input.runId,`artifact:${id}`])).rows[0];}),async c=>{await assertEcoDispatch(c,input.runId,input.payload);await checkWorker(c);}) : undefined;
 executor.bind?.({runId:input.runId,
  storeArtifact:async(relativePath,text,signal)=>{
   signal.throwIfAborted();
   const phase=scope.binding.phaseWork;
   const deliverable=phase.deliverables.find(d=>d.relativePath===relativePath);
   if(!phase.effectPolicy.permittedToolClasses.includes('write')||!deliverable
    ||!phase.effectPolicy.allowWriteRoots.some(r=>relativePath===r||relativePath.startsWith(r+'/'))
    ||!deliverable.mediaType.startsWith('text/')||Buffer.from(text,'utf8').toString('utf8')!==text
    ||Buffer.byteLength(text)>deliverable.maximumBytes)deny('Artifact tool/path/byte policy denied');
   await input.transaction(async c=>{
    signal.throwIfAborted();await assertEcoDispatch(c,input.runId,input.payload);await checkWorker(c);
    const eventKey=`artifact:${deliverable!.id}`;
    if((await c.query('SELECT event_key FROM eco_managed_usage_events WHERE workspace_id=$1 AND run_id=$2 AND event_key=$3',[phase.workspaceId,input.runId,eventKey])).rows[0])deny('Artifact already submitted');
    await consumeEcoManagedBudget(c,{workspaceId:phase.workspaceId,runId:input.runId,eventKey:`artifact-budget:${deliverable!.id}`,
     principalId:scope.principalId,companyId:scope.companyId,ownerId:scope.ownerId,fence:scope.fence,
     usage:{toolCalls:1,contextTokens:0,outputBytes:Buffer.byteLength(text),spendMicroUsd:0}});
    const proposal={contractVersion:'rorca.eco-artifact-proposal.v1',runId:input.runId,phaseHash:phase.contentHash,
     relativePath,text,acceptanceAuthority:'none'};
    await c.query('INSERT INTO eco_managed_usage_events(workspace_id,run_id,event_key,content_hash,canonical_bytes) VALUES($1,$2,$3,$4,$5)',
     [phase.workspaceId,input.runId,eventKey,contractHash(proposal),canonicalJson(proposal)]);
    // Host observations, never model-authored checks or a story/test pass. The
    // exact submitted subject and source/recipe pins survive later review.
    const observation={contractVersion:'rorca.eco-text-structural-observation.v1',
     workspaceId:phase.workspaceId,runId:input.runId,phaseWorkId:phase.id,revision:phase.revision,phaseHash:phase.contentHash,
     sourceSetHash:contractHash(phase.sourceBindings),recipeHash:phase.recipeBinding.contentHash,
     deliverableId:deliverable!.id,relativePath,mediaType:deliverable!.mediaType,
     artifactHash:`sha256:${createHash('sha256').update(text,'utf8').digest('hex')}`,byteLength:Buffer.byteLength(text),
     proposalHash:contractHash(proposal),observer:'host-typed-artifact-writer',
     checks:['declared-text-media-type','lossless-utf8','declared-path','maximum-bytes'],
     outcome:'structurally-valid-proposal',criterionResults:phase.criteria.map(c=>({criterionId:c.id,outcome:'not-evaluated'})),
     acceptanceAuthority:'none',codeExecution:'not-performed'};
    await c.query('INSERT INTO eco_managed_usage_events(workspace_id,run_id,event_key,content_hash,canonical_bytes) VALUES($1,$2,$3,$4,$5)',
     [phase.workspaceId,input.runId,`artifact-validation:${deliverable!.id}`,contractHash(observation),canonicalJson(observation)]);
    signal.throwIfAborted();
   });
  },
  reserveTool:async(eventKey,usage,signal)=>{
   signal.throwIfAborted();
   await input.transaction(async c=>{
    signal.throwIfAborted();await assertEcoDispatch(c,input.runId,input.payload);await checkWorker(c);
    await consumeEcoManagedBudget(c,{workspaceId:scope.binding.phaseWork.workspaceId,runId:input.runId,eventKey,
     principalId:scope.principalId,companyId:scope.companyId,ownerId:scope.ownerId,fence:scope.fence,usage});
   });
   signal.throwIfAborted();
  },
  reserveModel:async(reservation,signal)=>{
   signal.throwIfAborted();
   const identity=ecoModelIdentity(scope,input.runId);
   if(Object.entries(identity).some(([k,v])=>reservation[k as keyof typeof identity]!==v))deny('Model reservation scope differs');
   await input.transaction(async c=>{
    signal.throwIfAborted();await assertEcoDispatch(c,input.runId,input.payload);await checkWorker(c);
    const workspaceId=scope.binding.phaseWork.workspaceId;
    const eventKey=`model:${reservation.operationId}`;
    // assertEcoDispatch serializes this root; accounting replay NEVER grants a second send.
    if((await c.query('SELECT event_key FROM eco_managed_usage_events WHERE workspace_id=$1 AND run_id=$2 AND event_key=$3',[workspaceId,input.runId,eventKey])).rows[0])deny('Model operation already reserved; reconcile unknown spend');
    await consumeEcoManagedBudget(c,{workspaceId,runId:input.runId,eventKey,principalId:scope.principalId,
     companyId:scope.companyId,ownerId:scope.ownerId,fence:scope.fence,
     usage:{toolCalls:0,contextTokens:reservation.contextTokens,outputBytes:reservation.outputBytes,spendMicroUsd:reservation.spendMicroUsd}});
    const bytes=canonicalJson(reservation);
    await c.query('INSERT INTO eco_managed_usage_events(workspace_id,run_id,event_key,content_hash,canonical_bytes) VALUES($1,$2,$3,$4,$5)',
     [workspaceId,input.runId,`model-pins:${reservation.operationId}`,contractHash(reservation),bytes]);
    signal.throwIfAborted();
   }); // Commit is awaited before broker may send. Never refund unknown outcomes.
   signal.throwIfAborted();
  }});
 const steps=await executor.steps(scope);
 if(steps.length>1000||new Set(steps.map(s=>s.id)).size!==steps.length||steps.some(s=>!s.id||s.id.length>128))deny('Invalid bounded execution steps');
  for(const step of steps){
   const eventKey=`worker:${randomUUID()}`; // Never replay an uncertain effect using an accounting replay.
   await input.transaction(async client=>{
    const current=await assertEcoDispatch(client,input.runId,input.payload);
    if(!current)deny('Managed execution binding disappeared');
    await checkWorker(client);
    await consumeEcoManagedBudget(client,{workspaceId:scope.binding.phaseWork.workspaceId,runId:input.runId,eventKey,
     principalId:scope.principalId,companyId:scope.companyId,ownerId:scope.ownerId,fence:scope.fence,usage:step.usage});
   });
   // The adapter must honor AbortSignal and stop must confirm containment. Poll
   // authority while an effect is pending, not only between model/tool calls.
   let checking=false;
   // Independent read-only observation: no effect transaction exists to hold
   // root/source/owner locks. A blocked reservation cannot suppress cancellation.
   const timer=setInterval(()=>{if(checking)return;checking=true;
    input.transaction(async c=>{
     await c.query("SELECT set_config('rorca.workspace_id',$1,TRUE)",[scope.binding.phaseWork.workspaceId]);
     await checkWorker(c);
     const owner=await c.query(`SELECT fence FROM eco_watcher_owners WHERE workspace_id=$1 AND company_id=$2 AND phase_work_id=$3::uuid
      AND principal_id=$4 AND owner_id=$5 AND fence=$6 AND NOT revoked AND expires_at>clock_timestamp()`,
      [scope.binding.phaseWork.workspaceId,scope.companyId,scope.binding.phaseWork.id,scope.principalId,scope.ownerId,scope.fence]);
     if(!owner.rows[0])deny('Managed watcher owner/fence lost');
     const revoked=await c.query(`SELECT record_key FROM eco_host_record_revocations WHERE workspace_id=$1
      AND ((kind='recipe' AND record_key=$2) OR (kind='source' AND record_key=ANY($3::text[])))`,
      [scope.binding.phaseWork.workspaceId,scope.binding.phaseWork.recipeBinding.contentHash,scope.binding.phaseWork.sourceBindings.map(contractHash)]);
     if(revoked.rows[0])deny('Managed source/recipe revoked');
     const cancelled=await c.query('SELECT run_id FROM pipeline_run_cancellation_requests WHERE run_id=$1',[input.runId]);
     if(cancelled.rows[0])deny('Managed execution is fenced by cancellation');
    }).catch(()=>controller.abort()).finally(()=>{checking=false;});
   },250);
   const deadline=setTimeout(()=>controller.abort(),Math.max(0,Date.parse(scope.deadlineAt)-Date.now()));
   let expiry:ReturnType<typeof setTimeout>|undefined;
   try {
    await input.transaction(async client=>{
     await assertEcoDispatch(client,input.runId,input.payload);
     const workerExpiry=await checkWorker(client);
     const owner=(await client.query(`SELECT expires_at FROM eco_watcher_owners WHERE workspace_id=$1 AND company_id=$2 AND phase_work_id=$3::uuid`,
      [scope.binding.phaseWork.workspaceId,scope.companyId,scope.binding.phaseWork.id])).rows[0];
     expiry=setTimeout(()=>controller.abort(),Math.max(0,Math.min(workerExpiry,new Date(owner.expires_at).getTime())-Date.now()));
    });
    // ALL network/tool work is outside DB transactions; broker commits its own
    // per-request reservation through the bound capability before transport.
    controller.signal.throwIfAborted();
    await executor.perform(step.id,controller.signal);
    if(controller.signal.aborted)deny('Managed authority lost during effect');
    await input.transaction(async c=>{await assertEcoDispatch(c,input.runId,input.payload);await checkWorker(c);});
   }finally {if(expiry)clearTimeout(expiry);clearInterval(timer);clearTimeout(deadline);}
  }
  await executor.stop(); // confirmed containment before canonical closeout
  await nativeTextAttempt?.finish(async()=>{await input.transaction(async c=>{await assertEcoDispatch(c,input.runId,input.payload);await checkWorker(c);});});
  await input.transaction(c=>assertEcoDispatch(c,input.runId,input.payload));
  // Existing host closeout, never an executor result claiming acceptance.
  await input.closeout();
  return true;
 }finally {controller.abort();await executor.stop();}
}

/** Link only a real canonical host WAL pointer. This is provenance linkage,
 * never ECO accepted-artifact issuance or human/lifecycle acceptance.
 * Terminal failure/cancel closeout must remain possible after lease/source loss.
 */
export async function linkEcoManagedCloseout(client:EcoBindingClient,runId:number):Promise<void>{
 const run=(await client.query('SELECT workspace_id,trigger_options,host_closeout_event_id FROM pipeline_runs WHERE id=$1',[runId])).rows[0];
 if(!object(run?.trigger_options).ecoManagedAdmission)return;
 await client.query("SELECT set_config('rorca.workspace_id',$1,TRUE)",[run.workspace_id]);
 const binding=(await client.query(`SELECT binding.*,revision.source_set_hash,revision.recipe_hash,revision.canonical_body->'parentBinding'->>'planHash' AS parent_plan_hash
  FROM eco_managed_run_bindings binding JOIN eco_phase_work_revisions revision
  ON revision.workspace_id=binding.workspace_id AND revision.phase_work_id=binding.phase_work_id AND revision.revision=binding.revision
  WHERE binding.workspace_id=$1 AND binding.run_id=$2`,[run.workspace_id,runId])).rows[0];
 if(!binding)deny('Managed closeout lacks immutable run binding');
 const wal=(await client.query(`SELECT id,event_identity_hash,payload FROM wal_events WHERE id=$1 AND workspace_id=$2
  AND canonical_run_id=$3 AND event_type='run_closeout' AND trust_provenance='host' AND trusted_source='worker'`,[run.host_closeout_event_id,run.workspace_id,runId])).rows[0];
 if(!wal||Number(object(wal.payload).run_id)!==runId)deny('Managed closeout lacks exact canonical host evidence');
 const pins={phaseHash:binding.phase_hash,sourceSetHash:binding.source_set_hash,recipeHash:binding.recipe_hash,parentHash:binding.parent_plan_hash,
  phaseWorkId:binding.phase_work_id,revision:Number(binding.revision),runId,closeoutEventId:Number(wal.id),closeoutIdentityHash:wal.event_identity_hash};
 const bytes=canonicalJson(pins);const digest=contractHash(pins);
 await client.query(`INSERT INTO eco_managed_closeout_links(workspace_id,run_id,closeout_event_id,content_hash,canonical_bytes)
  VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,run_id) DO NOTHING`,[run.workspace_id,runId,wal.id,digest,bytes]);
 const retained=(await client.query('SELECT content_hash FROM eco_managed_closeout_links WHERE workspace_id=$1 AND run_id=$2',[run.workspace_id,runId])).rows[0];
 if(retained?.content_hash!==digest)deny('Managed closeout evidence replay conflicts');
}
