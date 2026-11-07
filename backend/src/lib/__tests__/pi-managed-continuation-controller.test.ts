/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */
import {
  ContextBundleV1Schema,ContextCheckpointV1Schema,ContextPolicyActivationV1Schema,RetrievalReceiptV1Schema,governedHash,
} from '../governed-contracts';
import {
  PiManagedContinuationController,
  type AggregateRetryBudget,type CanonicalContextClient,type ManagedCheckpointStore,type ManagedClock,
  type ManagedContinuationCheckpointInput,type ManagedContinuationEventSink,type ManagedLeaseVerifier,
  type PiRpcManagedAdapter,type PolicyActivationVerifier,type ContinuationAuthorizer,
} from '../omp-continuation-lane';

const hash=(digit:string)=>`sha256:${digit.repeat(64)}`;
const git=(digit:string)=>digit.repeat(40);
const now='2026-08-05T10:00:00.000Z';
const future='2026-08-05T11:00:00.000Z';
const workspaceId='workspace:continuation-test';
const repository={repositoryId:'repository:continuation-test',remoteAuthorityHash:hash('1'),gitObjectFormat:'sha1' as const,baseSha:git('a'),currentSha:git('a'),
  expectedHeadSha:git('a'),worktreeId:'worktree:continuation-test',allowedPathManifestHash:hash('2'),requiredPathManifestHash:hash('3'),
  changedPathManifestHash:hash('4'),forbiddenPathManifestHash:hash('5')};
const spec={specId:'spec:continuation-test',specVersion:1,specHash:hash('6'),canonicalSpecPath:'forge/specs/test.json',storyId:'story:continuation-test',
  storyVersion:1,storyHash:hash('7'),criteriaManifestHash:hash('8')};
const scope={workspaceId,missionId:'mission:continuation-test',missionRevision:1,missionHash:hash('9'),workPackageId:'work-package:continuation-test',workPackageRevision:1,
  workPackageHash:hash('a'),spec,runId:51,attemptId:'attempt:continuation-test',leaseId:'lease:continuation-test',fencingToken:7,leaseExpiresAt:future,
  cancellationId:'cancellation:none',runtimeId:'runtime:continuation-test',controllerGeneration:0,runtimeGeneration:0,sessionId:'session:continuation-test',
  sessionFileHash:hash('b'),turnId:'turn:continuation-test',turnAttempt:1,originatingGeneration:0,cursor:4,cursorHash:hash('c'),priorEntryId:'entry:prior',repository,
  validationStateHash:hash('d'),rootCauseClassification:'root-cause:none',rootCauseHash:hash('e'),policyDefinitionId:'policy:continuation-test',
  policyDefinitionVersion:'1.0.0',policyDefinitionHash:hash('f'),policyActivationId:'activation:continuation-test',policyActivationRevision:1,policyActivationHash:hash('1')};
const header=(schemaVersion:string,artifactId:string,contentHash:string)=>({schemaVersion,contractId:schemaVersion,contractVersion:'1.0.0',artifactId,contentHash,createdAt:now,createdBy:'controller:continuation-test'});
const activation=ContextPolicyActivationV1Schema.parse({...header('rorca.context-continuation-policy-activation.v1','artifact:activation',hash('1')),workspaceId,
  activationId:'activation:continuation-test',activationRevision:1,activationHash:hash('1'),definitionId:'policy:continuation-test',definitionVersion:'1.0.0',definitionHash:hash('f'),
  scope:{workspaceId,missionId:scope.missionId,missionRevision:1,missionHash:scope.missionHash,workPackageId:scope.workPackageId,workPackageRevision:1,
    workPackageHash:scope.workPackageHash,spec,runId:51,attemptId:scope.attemptId,leaseId:scope.leaseId,fencingToken:7,cancellationId:scope.cancellationId,runtimeId:scope.runtimeId,
    repositoryId:repository.repositoryId,remoteAuthorityHash:repository.remoteAuthorityHash,baseSha:repository.baseSha,worktreeId:repository.worktreeId,
    allowedPathManifestHash:repository.allowedPathManifestHash,requiredPathManifestHash:repository.requiredPathManifestHash,policyDefinitionId:scope.policyDefinitionId,
    policyDefinitionVersion:'1.0.0',policyDefinitionHash:scope.policyDefinitionHash},effectiveValuesHash:hash('2'),authorityReceiptId:'receipt:activation',activatedAt:now,expiresAt:future,state:'active'});
const checkpoint=ContextCheckpointV1Schema.parse({...header('rorca.context-checkpoint.v1','artifact:checkpoint',hash('3')),scope,checkpointId:'checkpoint:continuation-test',
  checkpointSequence:2,priorCheckpointId:'checkpoint:prior',reasonCode:'trigger:material',trigger:{type:'material_file_scope_change',priorAllowedHash:hash('4'),currentAllowedHash:hash('5'),
    priorRequiredHash:hash('6'),currentRequiredHash:hash('7'),priorChangedHash:hash('8'),currentChangedHash:hash('9'),priorForbiddenHash:hash('a'),currentForbiddenHash:hash('b'),
    gitStatusHash:hash('c'),diffHash:hash('d')},eventHighWaterMark:10,planCursorHash:hash('e'),completedWorkHash:hash('f'),pendingWorkHash:hash('1'),boundedReferences:[],
  retry:{retryCycleId:'not_applicable',phase:'none',attempt:0,maximum:2,startEventHash:'not_applicable',endEventHash:'not_applicable',settledEventHash:'not_applicable',generation:0},
  completionCandidate:{state:'absent',hash:'not_applicable'},redactionManifestHash:hash('2'),state:'current'});
const source={contextClass:'required' as const,sourceType:'source:spec',stableSourceId:'source:continuation-test',sourceVersion:'1',contentHash:hash('4'),freshness:'current' as const,
  excluded:false,redactionHash:hash('5')};
const receipt=RetrievalReceiptV1Schema.parse({...header('rorca.retrieval-receipt.v1','artifact:receipt',hash('6')),scope,requestId:'retrieval:continuation-test',
  receiptId:'receipt:continuation-test',checkpointId:checkpoint.checkpointId,definitionHash:scope.policyDefinitionHash,activationHash:scope.policyActivationHash,retrievalKey:hash('7'),
  sources:[source],requiredComplete:true,tokenAccounting:{required:20,advisory:0,instructions:2,total:22},outputId:'output:continuation-test',outputHash:hash('8'),
  startedAt:now,finishedAt:now,status:'completed',reasonCode:'retrieval:complete',retryable:false,retryBudgetId:'retry-budget:continuation-test'});
const bundle=ContextBundleV1Schema.parse({...header('rorca.context-bundle.v1','artifact:bundle',hash('9')),scope,bundleId:'bundle:continuation-test',bundleVersion:1,bundleHash:hash('9'),
  checkpointId:checkpoint.checkpointId,checkpointHash:checkpoint.contentHash,receiptId:receipt.receiptId,receiptHash:receipt.contentHash,definitionHash:scope.policyDefinitionHash,
  activationHash:scope.policyActivationHash,requiredContext:[source],advisoryMemory:[],orderedSourceHash:hash('a'),redactionManifestHash:hash('b'),tokenAllocationHash:hash('c'),
  tokenAccounting:{required:20,advisory:0,instructions:2,total:22},serializedBytes:300,expiresAt:future,state:'active'});
const renderedPayload='canonical managed continuation';
const renderedPayloadHash=governedHash('rorca.managed-rendered-payload.v1',renderedPayload);

class Store implements ManagedCheckpointStore {
  persisted=0; consumed=0; marked=0; settled=0; fenced=0;
  lastFence: Parameters<ManagedCheckpointStore['fence']>[1] | null=null;
  current: Awaited<ReturnType<ManagedCheckpointStore['loadDispatch']>>=null;
  async persistBeforeTrigger():Promise<{duplicate:boolean}>{this.persisted+=1;return {duplicate:this.persisted>1};}
  async loadDispatch(){return this.current;}
  async consumeDispatchCas(dispatch:unknown){this.consumed+=1;this.current={state:'dispatch_consumed',dispatch,sendReceiptHash:null};return {consumed:true,duplicate:false,authorizationExpiresAt:future};}
  async markDispatched(_id:string,receiptHash:string){this.marked+=1;if(this.current)this.current={...this.current,state:'dispatched',sendReceiptHash:receiptHash};}
  async settle(_id:string,_entry:string,_cursor:number,_hash:string){this.settled+=1;if(this.current)this.current={...this.current,state:'settled'};return {duplicate:this.settled>1};}
  async fence(_id:string,fence:Parameters<ManagedCheckpointStore['fence']>[1]){this.fenced+=1;this.lastFence=fence;if(this.current)this.current={...this.current,state:'failed'};}
}
class Clock implements ManagedClock { time=Date.parse(now)+1;now(){return new Date(this.time).toISOString();}async sleep(ms:number){this.time+=ms;} }
class Pi implements PiRpcManagedAdapter {
  sends=0;aborts=0;settled=true;cursor=5;entryId:string|null='entry:new';
  async sendSameSession(){this.sends+=1;return {sendReceiptHash:hash('d')};}
  async observeSettled(){return {settled:this.settled,turnId:scope.turnId,generation:scope.runtimeGeneration,entryId:this.entryId,entryHash:this.entryId?hash('e'):null,cursor:this.cursor};}
  async abortProcessGroup(){this.aborts+=1;return {dead:true,deathReceiptHash:hash('f')};}
}

function harness() {
  const store=new Store();const clock=new Clock();const pi=new Pi();let dispatchId='dispatch:continuation-test';
  const context:CanonicalContextClient={
    async retrieve(){return {receipt,bundle,renderedPayloadRef:{referenceId:'reference:rendered',kind:'context',hash:renderedPayloadHash,sensitivity:'internal',
      retentionClass:'retention:standard',accessTier:'auth',rawPayloadIncluded:false},renderedPayloadHash};},
    async createDispatch(){
      const continuationKey=governedHash('rorca.managed-continuation-key.v1',{scope,checkpointId:checkpoint.checkpointId,checkpointHash:checkpoint.contentHash,
        trigger:checkpoint.trigger,retryCycleId:null,retryPhase:'none'});
      return {renderedPayload,dispatch:{...header('rorca.continuation-dispatch.v1','artifact:dispatch',hash('1')),scope,dispatchId,continuationKey,trigger:checkpoint.trigger,
        checkpointId:checkpoint.checkpointId,checkpointHash:checkpoint.contentHash,receiptId:receipt.receiptId,receiptHash:receipt.contentHash,bundleId:bundle.bundleId,
        bundleHash:bundle.bundleHash,definitionHash:scope.policyDefinitionHash,activationHash:scope.policyActivationHash,targetSessionId:scope.sessionId,targetCursor:scope.cursor,
        priorEntryId:scope.priorEntryId,expectedCursorAdvance:1,renderedPayloadHash,renderedPayloadRef:{referenceId:'reference:rendered',kind:'context',hash:renderedPayloadHash,
          sensitivity:'internal',retentionClass:'retention:standard',accessTier:'auth',rawPayloadIncluded:false},firstLeaseVerificationHash:hash('2'),casLeaseVerificationHash:hash('3'),
        authorizationExpiresAt:future,controllerId:'controller:managed',adapterVersion:'1.0.0',attempt:1,retryBudgetId:'retry-budget:continuation-test',state:'authorized',reasonCode:'authorized'}};
    },
  };
  const leases:ManagedLeaseVerifier={async verifyExact(){}};const policy:PolicyActivationVerifier={async verifyActive(){}};const authorizer:ContinuationAuthorizer={async authorize(){}};
  const events:ManagedContinuationEventSink={async emit(){}};const retryBudget:AggregateRetryBudget={async claim(){return {claimed:true,fence:1,state:'in_flight'};},async settle(){return {state:'closed',retryable:false};}};
  const controller=new PiManagedContinuationController(store,context,policy,leases,authorizer,pi,events,retryBudget,clock,300,100);
  const input:ManagedContinuationCheckpointInput={scope,checkpoint,policyActivation:activation,retryCycleId:null,retryPhase:'none',completionCandidateState:'none',priorProcessGroupDead:false,priorWriterDeathReceiptHash:null};
  return {store,clock,pi,controller,input,setDispatchId:(value:string)=>{dispatchId=value;}};
}

describe('PiManagedContinuationController',()=>{
  test('persists before trigger, consumes one CAS, sends one same-session prompt, and settles only after cursor advance',async()=>{
    const {store,pi,controller,input}=harness();
    await expect(controller.continue(input)).resolves.toMatchObject({kind:'settled',promptSent:true,storyLifecycleMutation:false,closeoutDecision:false});
    expect({persisted:store.persisted,consumed:store.consumed,marked:store.marked,settled:store.settled,sends:pi.sends}).toEqual({persisted:1,consumed:1,marked:1,settled:1,sends:1});
    await expect(controller.reconcile(input)).resolves.toMatchObject({kind:'settled',promptSent:false});
    expect(pi.sends).toBe(1);
  });

  test('suppresses managed prompt while Pi retry is started and for a validated completion candidate',async()=>{
    const first=harness();
    await expect(first.controller.continue({...first.input,retryCycleId:'retry-cycle:one',retryPhase:'started'})).resolves.toMatchObject({kind:'suppressed_retry',promptSent:false});
    expect(first.pi.sends).toBe(0);expect(first.store.persisted).toBe(1);
    const second=harness();
    await expect(second.controller.continue({...second.input,completionCandidateState:'controller_validated'})).resolves.toMatchObject({kind:'completion_candidate',resultProposalRequired:true,promptSent:false});
    expect(second.pi.sends).toBe(0);
  });

  test('rejects settled without a new non-empty assistant entry and never records pass',async()=>{
    const {pi,controller,input}=harness();pi.cursor=scope.cursor;pi.entryId=null;
    await expect(controller.continue(input)).rejects.toMatchObject({reason:'scope_mismatch'});
    expect(pi.sends).toBe(1);
  });

  test('fences timed-out writer after process-group death without launching a replacement',async()=>{
    const {store,pi,controller,input}=harness();pi.settled=false;
    await expect(controller.continue(input)).resolves.toMatchObject({kind:'fenced_timeout',promptSent:true,restartProposal:{
      priorRuntimeGeneration:0,newRuntimeGeneration:1,sessionId:scope.sessionId,cursor:scope.cursor,forceFullCanonicalContext:true,
      newLeaseAndFenceRequired:true,authority:'proposal_only',
    }});
    expect(pi.sends).toBe(1);expect(pi.aborts).toBe(1);expect(store.fenced).toBe(1);
    expect(store.lastFence).toEqual({reasonCode:'settled_timeout_writer_dead',evidenceHash:hash('f')});
    await expect(controller.reconcile({...input,priorProcessGroupDead:true,priorWriterDeathReceiptHash:hash('f')})).resolves.toMatchObject({
      kind:'fenced_timeout',promptSent:false,restartProposal:{priorWriterDeathReceiptHash:hash('f'),authority:'proposal_only'},
    });
    expect(pi.sends).toBe(1);
  });

  test('fails closed when writer death is claimed without its durable receipt',async()=>{
    const {pi,controller,input}=harness();pi.settled=false;
    await expect(controller.continue(input)).resolves.toMatchObject({kind:'fenced_timeout'});
    await expect(controller.reconcile({...input,priorProcessGroupDead:true,priorWriterDeathReceiptHash:null})).rejects.toMatchObject({
      reason:'invalid_contract',
    });
    expect(pi.sends).toBe(1);
  });
});
