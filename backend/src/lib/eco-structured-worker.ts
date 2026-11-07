/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Host-only composition for the existing ECO worker. No CLI, eval, shell,
 * filesystem tool, opaque CONNECT, ambient credentials or model-selected URL.
 * The supported route is pinned-source -> text model -> durable artifact proposal.
 * It is NOT a code execution adapter or native lifecycle acceptance writer.
 */
import { createHash, randomUUID } from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import path from 'node:path';
const optionalRequire=createRequire(typeof __filename==='string'?__filename:path.resolve('package.json'));
import { z } from 'zod';
import { createEcoModelBudgetBroker, type EcoModelBudgetConfig, type EcoModelBudgetBroker } from './eco-model-budget';
import { ECO_PREPARED_PROTOCOL, ecoModelIdentity, installEcoBoundedExecutor, type EcoWorkerEffects, type EcoBoundedExecutor } from './eco-managed-runtime';
import { RelativePathSchema } from './eco-phase-work';
import type { EcoManagedInput } from './eco-managed-admission';

export interface EcoStructuredHostProfile {
 readonly mode: 'production'|'local-fixture';
 readonly model: string;
 readonly endpoint: string;
 readonly authorization?: string;
 readonly tokenizer: EcoModelBudgetConfig['tokenizer'];
 readonly pricing: EcoModelBudgetConfig['pricing'];
 readonly limits: Omit<EcoModelBudgetConfig['limits'],'deadlineAt'>;
 /** Custody-qualified bytes, not filesystem paths or callbacks from the model.
  * Each is independently matched against the frozen source artifact hash. */
 readonly sources: Readonly<Record<string,string>>;
}
export type EcoStructuredHostResolver=(scope:Readonly<EcoManagedInput>)=>EcoStructuredHostProfile;
const concreteTokenizers=new WeakSet<object>();
/** Concrete optional host dependency. Host must qualify the framing algorithm
 * against this exact dated route before installing it; no character estimate or
 * caller-provided count function is accepted on the production route. Missing
 * package/config fails closed without loading credentials or sending a request. */
export interface EcoOpenAiMiniQualification {
 readonly qualificationRef:string;
 readonly scope:'production'|'local-fixture';
 /** Exact installed implementation and separately qualified wire framing. */
 readonly packageVersion:'1.0.21';
 readonly framing:'openai-chat-2024-v1';
}
export function createEcoOpenAiMiniTokenizer(qualification:string|EcoOpenAiMiniQualification):EcoModelBudgetConfig['tokenizer'] {
 const q:EcoOpenAiMiniQualification=typeof qualification==='string'
  ? {qualificationRef:qualification,scope:'production',packageVersion:'1.0.21',framing:'openai-chat-2024-v1'}:qualification;
 const {qualificationRef}=q;
 if(!qualificationRef)throw Error('ECO tokenizer host qualification is required');
 if(!['production','local-fixture'].includes(q.scope)||q.packageVersion!=='1.0.21'||q.framing!=='openai-chat-2024-v1')throw Error('ECO tokenizer implementation/framing unsupported');
 const packagePath=path.resolve(path.dirname(optionalRequire.resolve('js-tiktoken')),'../package.json');
 const installed=JSON.parse(readFileSync(packagePath,'utf8'));
 if(installed.name!=='js-tiktoken'||installed.version!==q.packageVersion)throw Error('ECO tokenizer exact installed package version differs');
 let encoding:{encode(text:string,allowed?:string[],disallowed?:string[]):number[]};
 try {encoding=(optionalRequire('js-tiktoken') as {getEncoding(name:string):typeof encoding}).getEncoding('o200k_base');}
 catch {throw Error('ECO supported tokenizer unavailable: install and qualify js-tiktoken o200k_base at the host');}
 const tokens=(text:string)=>encoding.encode(text,[],[]).length;
 const tokenizer=Object.freeze({id:'o200k_base:openai-chat-2024-v1',qualificationRef,scope:q.scope,
  provider:'openai',model:'gpt-4o-mini-2024-07-18',protocol:'openai-chat-text-v1' as const,kind:'exact' as const,
  countInput:(messages:ReadonlyArray<Readonly<{role:string;content:string}>>)=>3+messages.reduce((n,m)=>n+3+tokens(m.role)+tokens(m.content),0),
  countOutput:tokens});
 concreteTokenizers.add(tokenizer);return tokenizer;
}
let hostResolver:EcoStructuredHostResolver|undefined;
/** Trusted embedding host only, never reachable by HTTP/MCP or env switches.
 * No default profile: absence remains a publication/worker refusal. */
export function installEcoStructuredHost(resolver:EcoStructuredHostResolver):()=>void {
 if(hostResolver)throw Error('ECO structured host already configured');
 hostResolver=resolver;return()=>{if(hostResolver===resolver)hostResolver=undefined;};
}
const ToolSchema=z.discriminatedUnion('tool',[
 z.object({tool:z.literal('read'),path:RelativePathSchema}).strict(),
 z.object({tool:z.literal('write'),path:RelativePathSchema,text:z.string()}).strict(),
]);
const inside=(p:string,roots:readonly string[])=>roots.some(r=>p===r||p.startsWith(r+'/'));
const hash=(text:string)=>`sha256:${createHash('sha256').update(text,'utf8').digest('hex')}`;

/** A virtual, pinned namespace intentionally has no OS path lookup: traversal,
 * symlinks, hardlinks, exec, sockets and arbitrary network cannot be expressed.
 * Model responses are data, never executed. This is the typed host tool boundary. */
export function createEcoTypedToolGateway(scope:Readonly<EcoManagedInput>,sourceTexts:Readonly<Record<string,string>>,effects:EcoWorkerEffects) {
 const phase=structuredClone(scope.binding.phaseWork);
 const sources=Object.freeze({...sourceTexts});
 return Object.freeze({async invoke(raw:unknown,signal:AbortSignal):Promise<string> {
  signal.throwIfAborted();
  const call=ToolSchema.parse(raw);
  if(!phase.effectPolicy.permittedToolClasses.includes(call.tool))throw Error('ECO tool class denied');
  if(call.tool==='write') {
   if(!inside(call.path,phase.effectPolicy.allowWriteRoots)||!phase.deliverables.some(d=>d.relativePath===call.path&&Buffer.byteLength(call.text)<=d.maximumBytes))throw Error('ECO artifact path/bytes denied');
   await effects.storeArtifact(call.path,call.text,signal);return 'submitted-proposal';
  }
  if(!inside(call.path,phase.effectPolicy.allowReadRoots))throw Error('ECO read path denied');
  const binding=phase.sourceBindings.find(s=>s.artifactPath===call.path);
  if(!binding||!Object.hasOwn(sources,call.path)||hash(sources[call.path])!==binding.artifactHash)throw Error('ECO pinned source bytes missing or changed');
  const text=sources[call.path];
  // Bounded memory/read result, pre-effect durable tool accounting. Context is
  // separately counted by the model broker including protocol framing.
  if(Buffer.byteLength(text)>phase.budgets.outputBytes)throw Error('ECO source read byte bound exceeded');
  await effects.reserveTool(`read:${randomUUID()}`,{toolCalls:1,contextTokens:0,outputBytes:Buffer.byteLength(text),spendMicroUsd:0},signal);
  signal.throwIfAborted();return text;
 }});
}
function qualify(scope:Readonly<EcoManagedInput>,profile:EcoStructuredHostProfile) {
 const phase=scope.binding.phaseWork;
 if(profile.mode==='production') {
  // Deliberately a single concrete supported route, not any object asserting
  // kind=exact. Host qualification must cover its chat framing and price ceiling.
  if(!concreteTokenizers.has(profile.tokenizer)||profile.model!=='gpt-4o-mini-2024-07-18'||profile.tokenizer.id!=='o200k_base:openai-chat-2024-v1'
   ||profile.tokenizer.model!==profile.model||profile.tokenizer.scope!=='production'
   ||!profile.tokenizer.qualificationRef||!profile.pricing.qualificationRef
   ||profile.pricing.scope!=='production'||!profile.authorization
   ||profile.endpoint!=='https://api.openai.com/v1/chat/completions')throw Error('ECO concrete host model/tokenizer/pricing configuration missing or unsupported');
 } else if(profile.mode!=='local-fixture')throw Error('ECO profile scope unsupported');
 if(profile.tokenizer.id!==phase.budgets.tokenizer)throw Error('ECO phase tokenizer differs from host');
 if(phase.effectPolicy.networkDestinations.length!==0)throw Error('ECO typed route does not support network tools');
 if(phase.effectPolicy.permittedToolClasses.some(t=>!['read','write'].includes(t))
  ||!phase.effectPolicy.permittedToolClasses.includes('read')||!phase.effectPolicy.permittedToolClasses.includes('write'))throw Error('ECO typed tool policy unsupported');
 if(phase.deliverables.length!==1||!phase.deliverables[0].mediaType.startsWith('text/')
  ||!inside(phase.deliverables[0].relativePath,phase.effectPolicy.allowWriteRoots))throw Error('ECO structured route requires one permitted text artifact');
 for(const source of phase.sourceBindings) {
  if(!inside(source.artifactPath,phase.effectPolicy.allowReadRoots)||!Object.hasOwn(profile.sources,source.artifactPath)
   ||hash(profile.sources[source.artifactPath])!==source.artifactHash)throw Error('ECO qualified source projection missing');
 }
 if(profile.limits.maxTotalTokens>phase.budgets.contextTokens||profile.limits.maxTotalSpendMicroUsd>phase.budgets.spendMicroUsd
  ||profile.limits.maxTotalResponseBytes>phase.budgets.outputBytes||profile.limits.maxRequests!==1)throw Error('ECO host limits exceed frozen phase policy');
}
export function createEcoStructuredExecutor(scope:Readonly<EcoManagedInput>,rawProfile:EcoStructuredHostProfile):EcoBoundedExecutor {
 qualify(scope,rawProfile);
 // Snapshot primitives/maps; preserve only trusted tokenizer methods explicitly.
 const profile={...rawProfile,sources:Object.freeze({...rawProfile.sources}),limits:Object.freeze({...rawProfile.limits}),
  pricing:Object.freeze({...rawProfile.pricing}),tokenizer:Object.freeze({...rawProfile.tokenizer,
   countInput:rawProfile.tokenizer.countInput.bind(rawProfile.tokenizer),countOutput:rawProfile.tokenizer.countOutput.bind(rawProfile.tokenizer)})};
 let effects:EcoWorkerEffects|undefined,broker:EcoModelBudgetBroker|undefined,performed=false;
 const stopped=new AbortController();
 return {
  protocol:ECO_PREPARED_PROTOCOL,
  hostValidationKind:'text-artifact-v1',
  bind(value){if(effects)throw Error('ECO worker already bound');effects=value;},
  async steps(){return [{id:'structured-text-artifact',usage:{toolCalls:0,contextTokens:0,outputBytes:0,spendMicroUsd:0}}];},
  async perform(stepId,caller){
   if(!effects||performed||stepId!=='structured-text-artifact')throw Error('ECO structured worker binding/step invalid');
   performed=true;
   const signal=AbortSignal.any([caller,stopped.signal]);signal.throwIfAborted();
   const gateway=createEcoTypedToolGateway(scope,profile.sources,effects);
   const texts:string[]=[];
   for(const source of scope.binding.phaseWork.sourceBindings)texts.push(await gateway.invoke({tool:'read',path:source.artifactPath},signal));
   broker=createEcoModelBudgetBroker({...profile,provider:'openai',...ecoModelIdentity(scope,effects.runId),
    limits:{...profile.limits,deadlineAt:Date.parse(scope.deadlineAt)},reserve:effects.reserveModel});
   const result=await broker.complete({messages:[{role:'system',content:'Return only the requested text artifact. No tools, executable code or external actions are available.'},
    {role:'user',content:JSON.stringify({objective:scope.binding.phaseWork.objective,sources:texts,deliverable:scope.binding.phaseWork.deliverables[0]})}],
    maxOutputTokens:profile.limits.maxOutputTokens,stream:true},signal);
   signal.throwIfAborted();
   await gateway.invoke({tool:'write',path:scope.binding.phaseWork.deliverables[0].relativePath,text:result.text},signal);
  },
  async stop(){stopped.abort();await broker?.stop();},
 };
}
/** Called by BOTH server publication and worker bootstrap. Registration does not
 * advertise/enable managed execution; require() still refuses missing host config.
 * Factory construction performs no IO, secrets lookup, model call or DB writes. */
export function installEcoStructuredWorkerBootstrap():()=>void {
 return installEcoBoundedExecutor(scope=>{
  if(!hostResolver)throw Error('Bounded managed executor unavailable: missing qualified ECO structured host configuration');
  return createEcoStructuredExecutor(scope,hostResolver(scope));
 });
}
