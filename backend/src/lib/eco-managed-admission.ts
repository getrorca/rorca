/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Transactional ECO admission inside existing canonical run admission.
 * No DB bootstrap, host record issuer, scheduler, lease allocator or acceptance writer.
 * Call only with an already-open transaction and its authenticated principal.
 */
import { z } from 'zod';
import { ConflictError, ValidationError } from './errors';
import { assertEcoPhaseWorkParent, bindEcoPhaseWork, canonicalJson, contractHash, EcoPhaseWorkBindingSchema, sealExternalPhaseWork, type EcoBindingClient, type EcoPhaseWorkBinding, type PhaseWork } from './eco-phase-work';
import { assertEcoRecipeAuthority } from './eco-recipe-authority';
import type { LifecycleDispatchClaim } from './lifecycle-dispatch-claim';
const positive=z.number().int().safe().positive();
const text=z.string().min(1).max(256).refine(v=>v===v.trim());
export const EcoManagedAdmissionSchema=z.object({
 contractVersion:z.literal('rorca.eco-managed-admission.v1'),companyId:text,ownerId:text,fence:positive,
 deadlineAt:z.string().datetime({offset:true}),storyId:text,
}).strict();
export interface EcoManagedInput {
 binding:EcoPhaseWorkBinding;claim:LifecycleDispatchClaim;principalId:string;companyId:string;ownerId:string;fence:number;
 idempotencyKey:string;requestHash:string;storyId:string;specPath:string;deadlineAt:string;predecessorRunId?:number;
}
const fail=(message:string):never=>{throw new ConflictError(message);};
const equal=(a:unknown,b:unknown)=>canonicalJson(a)===canonicalJson(b);
async function record(client:EcoBindingClient,workspaceId:string,kind:string,key:string):Promise<any>{
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array($1::text,$2::text,$3::text)::text,0))',[workspaceId,kind,key]);
 const {rows}=await client.query(`SELECT record.canonical_bytes,record.content_hash FROM eco_host_records record
  WHERE record.workspace_id=$1 AND record.kind=$2 AND record.record_key=$3
   AND NOT EXISTS(SELECT 1 FROM eco_host_record_revocations revoked WHERE revoked.workspace_id=record.workspace_id AND revoked.kind=record.kind AND revoked.record_key=record.record_key)
  `,[workspaceId,kind,key]);
 const row=rows[0];if(!row)fail(`Current host ${kind} authority is missing or revoked`);
 const value=JSON.parse(row.canonical_bytes);
 if(canonicalJson(value)!==row.canonical_bytes||contractHash(value)!==row.content_hash)fail(`Host ${kind} integrity differs`);
 return value;
}
async function lockScope(client:EcoBindingClient,input:Pick<EcoManagedInput,'binding'|'principalId'|'companyId'|'ownerId'|'fence'>){
 const workspaceId=input.binding.phaseWork.workspaceId;
 // SAVEPOINT is rejected by PostgreSQL in autocommit mode. Fail before any
 // authority lookup or write rather than silently splitting atomic admission.
 await client.query('SAVEPOINT eco_require_transaction',[]);
 await client.query('RELEASE SAVEPOINT eco_require_transaction',[]);
 await client.query("SELECT set_config('rorca.workspace_id',$1,TRUE)",[workspaceId]);
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[canonicalJson(['eco-managed',workspaceId,input.binding.phaseWork.id])]);
 const member=await client.query('SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_auth_id=$2 FOR SHARE',[workspaceId,input.principalId]);
 if(!member.rows[0])fail('Current authenticated workspace membership is required');
 const owner=await client.query(`SELECT fence FROM eco_watcher_owners WHERE workspace_id=$1 AND company_id=$2 AND phase_work_id=$3::uuid
  AND principal_id=$4 AND owner_id=$5 AND fence=$6 AND NOT revoked AND expires_at>clock_timestamp() FOR SHARE`,
 [workspaceId,input.companyId,input.binding.phaseWork.id,input.principalId,input.ownerId,input.fence]);
 if(!owner.rows[0])fail('Current global watcher owner/fence is required');
}
/** Exact records are imported by trusted native host custody/acceptance adapters,
 * not model JSON. Absence/revocation blocks; hashes alone never grant authority.
 */
export async function assertEcoManagedAuthority(client:EcoBindingClient,input:EcoManagedInput):Promise<PhaseWork>{
 const parsed=EcoPhaseWorkBindingSchema.safeParse(input.binding);
 if(!parsed.success)throw new ValidationError('Invalid managed phase binding');
 const {contentHash,...body}=parsed.data.phaseWork;
 const phase=sealExternalPhaseWork(body);
 if(contentHash!==phase.contentHash)fail('Managed phase hash differs');
 if(phase.modes.execution!=='rorca-managed'||phase.modes.governance!=='enrolled'||phase.modes.knowledge!=='connected')fail('Managed mode is unsupported');
 if(!['implementation','repair'].includes(phase.workKind)||!['development','testing','maintenance'].includes(phase.phase))fail('Explicit artifact execution adapter is unavailable');
 if(phase.workspaceId!==input.claim.workspaceId||phase.parentBinding?.specId!==input.claim.specId)fail('Managed parent scope differs');
 await lockScope(client,input);
 const now=(await client.query('SELECT clock_timestamp() AS now',[])).rows[0].now;
 const deadline=Date.parse(input.deadlineAt);const nowMs=new Date(now).getTime();
 if(!Number.isSafeInteger(deadline)||deadline<=nowMs||deadline>nowMs+phase.budgets.wallSeconds*1000)fail('Original execution deadline is exhausted or exceeds phase budget');
 const recipe=await record(client,phase.workspaceId,'recipe',phase.recipeBinding.contentHash);
 assertEcoRecipeAuthority(recipe,phase);
 for(const source of phase.sourceBindings){
  if(!equal(await record(client,phase.workspaceId,'source',contractHash(source)),source))fail('Native source custody authority differs');
 }
 const expectedMapping={phaseHash:phase.contentHash,parentHash:phase.parentBinding!.planHash,specId:input.claim.specId,specHash:input.claim.specHash,providerSpecVersion:input.binding.providerSpecVersion,storyId:input.storyId,specPath:input.specPath};
 if(!equal(await record(client,phase.workspaceId,'story-mapping',phase.contentHash),expectedMapping)
  ||input.specPath!==`forge/specs/approved/${input.claim.specId}.json`)fail('Explicit approved phase/story mapping differs');
 await assertEcoAcceptedPrerequisites(client,phase);
 return phase;
}
/** Versioned host acceptance transport, never an evidence-to-acceptance inference.
 * Existing generic evidence, QA approvals and completed runs do not match this
 * exact host-closeout record. The runtime has no INSERT authority on host records.
 */
export async function assertEcoAcceptedPrerequisites(client:EcoBindingClient,phase:PhaseWork):Promise<void>{
 const visiting=new Set<string>();const visited=new Set<string>();let count=0;
 const visit=async(current:PhaseWork,depth:number):Promise<void>=>{
  const identity=`${current.id}:${current.revision}`;
  if(visiting.has(identity)||depth>100)fail('Prerequisite dependency cycle or depth limit');
  if(visited.has(identity))return;if(++count>1000)fail('Prerequisite graph exceeds bounded capacity');
  visiting.add(identity);
  for(const p of current.prerequisites){
   const rows=await client.query('SELECT canonical_body,content_hash FROM eco_phase_work_revisions WHERE workspace_id=$1 AND phase_work_id=$2::uuid AND revision=$3',[phase.workspaceId,p.phaseWorkId,p.revision]);
   if(!rows.rows[0])fail('Accepted prerequisite phase is missing');
   const dependency=sealExternalPhaseWork(rows.rows[0].canonical_body);
   if(dependency.contentHash!==rows.rows[0].content_hash)fail('Accepted prerequisite phase integrity differs');
   const acceptance=await record(client,phase.workspaceId,'accepted-artifact',contractHash(p));
   const accepted=z.object({contractVersion:z.literal('rorca.eco-host-acceptance.v1'),workspaceId:text,phaseWorkId:z.string().uuid(),revision:positive,phaseHash:text,sourceSetHash:text,recipeHash:text,parentHash:text,deliverableId:text,artifactHash:text,attemptRunId:positive,gateIds:z.array(text).min(1),evidenceId:positive,eventKey:text}).strict().safeParse(acceptance);
   if(!accepted.success)fail('Host accepted artifact semantics are unavailable');
   const a=accepted.data!;const deliverable=dependency.deliverables.find(d=>d.id===p.deliverableId);
   const gates=deliverable?dependency.criteria.filter(c=>deliverable.criterionIds.includes(c.id)).flatMap(c=>c.gateIds):[];
   if(a.workspaceId!==phase.workspaceId||a.phaseWorkId!==p.phaseWorkId||a.revision!==p.revision||a.deliverableId!==p.deliverableId
    ||a.artifactHash!==p.artifactHash||a.phaseHash!==dependency.contentHash||a.sourceSetHash!==contractHash(dependency.sourceBindings)
    ||a.recipeHash!==dependency.recipeBinding.contentHash||a.parentHash!==dependency.parentBinding?.planHash
    ||!deliverable||!equal([...new Set(gates)].sort(),[...a.gateIds].sort()))fail('Accepted artifact exact phase/source/recipe/subject/gates differ');
   const proof=await client.query(`SELECT evidence.id FROM ssdlc_lifecycle_evidence evidence
    JOIN eco_managed_run_bindings binding ON binding.run_id=evidence.run_id AND binding.workspace_id=evidence.workspace_id
    WHERE evidence.workspace_id=$1 AND evidence.id=$2 AND evidence.source_system='rorca-host-closeout'
     AND evidence.source_idempotency_key=$3 AND evidence.subject_type='artifact_digest' AND evidence.subject_value=$4
     AND evidence.run_id=$5 AND evidence.phase_id=$6 AND evidence.metadata->'ecoAcceptance'=$7::jsonb
     AND evidence.payload_hash=$11 AND evidence.gate_id=ANY($12::text[])
     AND binding.phase_work_id=$8::uuid AND binding.revision=$9 AND binding.phase_hash=$10`,
    [phase.workspaceId,a.evidenceId,a.eventKey,a.artifactHash,a.attemptRunId,dependency.phase,JSON.stringify(a),a.phaseWorkId,a.revision,a.phaseHash,contractHash(a),a.gateIds]);
   if(!proof.rows[0])fail('Host accepted artifact lacks exact canonical evidence/attempt record');
   // Revalidate source authority so an accepted old source cannot launder drift.
   for(const source of dependency.sourceBindings)await record(client,phase.workspaceId,'source',contractHash(source));
   await visit(dependency,depth+1);
  }
  visiting.delete(identity);visited.add(identity);
 };
 await visit(phase,0);
}
export async function admitEcoManagedRun(client:EcoBindingClient,input:EcoManagedInput,reserveCanonicalRun:()=>Promise<{id:number}>):Promise<{runId:number;replayed:boolean}>{
 if(!/^[A-Za-z0-9:._-]{8,256}$/.test(input.idempotencyKey)||!/^sha256:[0-9a-f]{64}$/.test(input.requestHash)
  ||!Number.isSafeInteger(input.fence)||input.fence<1||!input.principalId)throw new ValidationError('Invalid managed command identity');
 input=JSON.parse(canonicalJson(input)); // freeze untrusted caller bytes before the first await
 const {contentHash,...body}=EcoPhaseWorkBindingSchema.parse(input.binding).phaseWork;
 if(sealExternalPhaseWork(body).contentHash!==contentHash)fail('Managed phase integrity hash differs');
 const commandHash=contractHash({binding:input.binding,claim:input.claim,principalId:input.principalId,companyId:input.companyId,idempotencyKey:input.idempotencyKey,requestHash:input.requestHash,storyId:input.storyId,specPath:input.specPath,predecessorRunId:input.predecessorRunId??null});
 await lockScope(client,input);
 const phase=input.binding.phaseWork;
 const existing=(await client.query(`SELECT * FROM eco_managed_run_bindings WHERE workspace_id=$1 AND idempotency_key=$2`,[phase.workspaceId,input.idempotencyKey])).rows[0];
 if(existing){
  if(existing.command_hash!==commandHash||existing.phase_work_id!==phase.id||Number(existing.revision)!==phase.revision||existing.phase_hash!==phase.contentHash||existing.request_hash!==input.requestHash
   ||existing.principal_id!==input.principalId||Number(existing.predecessor_run_id??0)!==(input.predecessorRunId??0))fail('Managed idempotency identity conflicts');
  return {runId:Number(existing.run_id),replayed:true}; // observation only, no budget or admission reset
 }
 let root=(await client.query('SELECT * FROM eco_managed_roots WHERE workspace_id=$1 AND phase_work_id=$2::uuid AND revision=$3 FOR UPDATE',[phase.workspaceId,phase.id,phase.revision])).rows[0];
 if(!root){
  const active=await client.query(`SELECT run.id FROM eco_managed_roots root JOIN pipeline_runs run ON run.id=root.current_run_id
   WHERE root.workspace_id=$1 AND root.phase_work_id=$2::uuid AND run.status NOT IN ('completed','done','partial_failure','failed','cancelled') FOR SHARE OF run`,[phase.workspaceId,phase.id]);
  if(active.rows[0])fail('Another revision has an active canonical phase attempt; observation/termination is required');
 }
 if(root && !input.predecessorRunId)fail('Phase revision already has a canonical managed admission identity');
 if(!root && input.predecessorRunId)fail('Retry lineage root is missing');
 if(root){
  if(root.principal_id!==input.principalId||root.company_id!==input.companyId||root.phase_hash!==phase.contentHash)fail('Managed retry root identity differs');
  if(Number(root.retry_count)>=Number(root.retry_limit))fail('Cumulative retry budget is exhausted');
  if(Number(root.current_run_id)!==input.predecessorRunId)fail('Retry predecessor is not current');
  const predecessor=(await client.query('SELECT status FROM pipeline_runs WHERE id=$1 AND workspace_id=$2 FOR UPDATE',[input.predecessorRunId,phase.workspaceId])).rows[0];
  if(predecessor?.status!=='failed')fail('Retry predecessor is not canonically failed');
  input={...input,deadlineAt:new Date(root.deadline_at).toISOString()};
 }
 await assertEcoManagedAuthority(client,input);
 // bindEcoPhaseWork also locks/revalidates exact current native parent plan.
 if(root) await assertEcoPhaseWorkParent(client,input.claim,input.binding,()=>assertEcoAcceptedPrerequisites(client,phase));
 else await bindEcoPhaseWork(client,input.claim,input.binding,()=>assertEcoAcceptedPrerequisites(client,phase));
 const reserved=await reserveCanonicalRun();const runId=Number(reserved.id);
 if(!Number.isSafeInteger(runId)||runId<1)fail('Canonical admission did not return a run');
 const canonical=(await client.query(`SELECT run.id FROM pipeline_runs run JOIN pipeline_dispatch_publications publication ON publication.run_id=run.id
  WHERE run.id=$1 AND run.workspace_id=$2 AND publication.workspace_id=$2 AND run.idempotency_key=$3
   AND run.dispatch_request_hash=$4 AND publication.request_hash=$4 AND run.retried_from_run_id IS NOT DISTINCT FROM $5::bigint
   AND run.trigger_options->'lifecycleDispatchClaim'->>'claimId'=$6 FOR UPDATE OF run,publication`,
  [runId,phase.workspaceId,input.idempotencyKey,input.requestHash,input.predecessorRunId??null,input.claim.claimId])).rows[0];
 if(!canonical)fail('Atomic admission lacks exact canonical run/outbox/phase claim identity');
 if(!root){
  await client.query(`INSERT INTO eco_managed_roots(workspace_id,phase_work_id,revision,phase_hash,company_id,principal_id,root_run_id,current_run_id,deadline_at,retry_limit,tool_limit,context_limit,output_limit,spend_limit)
   VALUES($1,$2::uuid,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11,$12,$13)`,
   [phase.workspaceId,phase.id,phase.revision,phase.contentHash,input.companyId,input.principalId,runId,input.deadlineAt,phase.budgets.retries,phase.budgets.toolCalls,phase.budgets.contextTokens,phase.budgets.outputBytes,phase.budgets.spendMicroUsd]);
 }else await client.query('UPDATE eco_managed_roots SET current_run_id=$4,retry_count=retry_count+1 WHERE workspace_id=$1 AND phase_work_id=$2::uuid AND revision=$3',[phase.workspaceId,phase.id,phase.revision,runId]);
 await client.query(`INSERT INTO eco_managed_run_bindings(run_id,workspace_id,phase_work_id,revision,phase_hash,idempotency_key,request_hash,principal_id,owner_id,fence,predecessor_run_id,command_hash)
  VALUES($1,$2,$3::uuid,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[runId,phase.workspaceId,phase.id,phase.revision,phase.contentHash,input.idempotencyKey,input.requestHash,input.principalId,input.ownerId,input.fence,input.predecessorRunId??null,commandHash]);
 return {runId,replayed:false};
}
const usageSchema=z.object({toolCalls:z.number().int().safe().nonnegative(),contextTokens:z.number().int().safe().nonnegative(),outputBytes:z.number().int().safe().nonnegative(),spendMicroUsd:z.number().int().safe().nonnegative()}).strict();
/** Reserve authoritative upper bounds BEFORE a tool/context/output/spend effect.
 * Never refund uncertain work. Integration must call this at each host boundary;
 * post-hoc telemetry alone is not enforcement and cannot enable the capability.
 */
export async function consumeEcoManagedBudget(client:EcoBindingClient,input:{workspaceId:string;runId:number;eventKey:string;principalId:string;companyId:string;ownerId:string;fence:number;usage:z.infer<typeof usageSchema>}):Promise<void>{
 const usage=usageSchema.parse(input.usage);text.parse(input.eventKey);
 await client.query("SELECT set_config('rorca.workspace_id',$1,TRUE)",[input.workspaceId]);
 const binding=(await client.query(`SELECT binding.*,revision.canonical_body FROM eco_managed_run_bindings binding JOIN eco_phase_work_revisions revision
  ON revision.workspace_id=binding.workspace_id AND revision.phase_work_id=binding.phase_work_id AND revision.revision=binding.revision
  WHERE binding.workspace_id=$1 AND binding.run_id=$2`,[input.workspaceId,input.runId])).rows[0];
 if(!binding)fail('Managed budget run binding is missing');
 const phase=sealExternalPhaseWork(binding.canonical_body);
 await lockScope(client,{...input,binding:{contractVersion:'rorca.phase-work-binding.v1',phaseWork:phase,providerSpecVersion:'unused'}});
 const root=(await client.query('SELECT * FROM eco_managed_roots WHERE workspace_id=$1 AND phase_work_id=$2::uuid AND revision=$3 FOR UPDATE',[input.workspaceId,phase.id,phase.revision])).rows[0];
 const bytes=canonicalJson(usage);const hash=contractHash(usage);
 const event=(await client.query('SELECT content_hash FROM eco_managed_usage_events WHERE workspace_id=$1 AND run_id=$2 AND event_key=$3',[input.workspaceId,input.runId,input.eventKey])).rows[0];
 if(event){if(event.content_hash!==hash)fail('Managed usage event replay conflicts');return;}
 if(!root||root.company_id!==input.companyId||root.principal_id!==input.principalId||Number(root.current_run_id)!==input.runId)fail('Managed budget current lineage authority differs');
 const now=(await client.query('SELECT clock_timestamp() AS now',[])).rows[0].now;
 if(new Date(root.deadline_at).getTime()<=new Date(now).getTime())fail('Original execution deadline is exhausted');
 for(const source of phase.sourceBindings)await record(client,phase.workspaceId,'source',contractHash(source));
 await record(client,phase.workspaceId,'recipe',phase.recipeBinding.contentHash);
 const updated=await client.query(`UPDATE eco_managed_roots SET used_tool_calls=used_tool_calls+$4,used_context_tokens=used_context_tokens+$5,used_output_bytes=used_output_bytes+$6,used_spend_micro_usd=used_spend_micro_usd+$7
  WHERE workspace_id=$1 AND phase_work_id=$2::uuid AND revision=$3
   AND used_tool_calls+$4<=tool_limit AND used_context_tokens+$5<=context_limit AND used_output_bytes+$6<=output_limit AND used_spend_micro_usd+$7<=spend_limit RETURNING root_run_id`,
 [input.workspaceId,phase.id,phase.revision,usage.toolCalls,usage.contextTokens,usage.outputBytes,usage.spendMicroUsd]);
 if(!updated.rows[0])fail('Cumulative managed quota is exhausted');
 await client.query('INSERT INTO eco_managed_usage_events(workspace_id,run_id,event_key,content_hash,canonical_bytes) VALUES($1,$2,$3,$4,$5)',[input.workspaceId,input.runId,input.eventKey,hash,bytes]);
}
