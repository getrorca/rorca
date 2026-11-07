/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ContextBundleV1Schema, ContextCheckpointV1Schema, ContextPolicyActivationV1Schema, ExecutionLeaseV1Schema,
  MissionContractV1Schema, RetrievalReceiptV1Schema, WorkPackageV1Schema,
} from '../governed-contracts';
import {
  MANAGED_EXECUTION_ADAPTER, ManagedAdmissionError, RorcaManagedExecutor, authorizeConservativeManagedFallback, normalizeManagedEngineRequest,
  type CurrentExecutionEngineBridge, type ExecutionAdapter, type ManagedAttemptState, type ManagedCapabilitySnapshot,
  type ManagedEngineRequest, type ManagedExecutorCanonicalInput, type ManagedExecutorStore,
  type ManagedHostObservation, type ManagedPreparation, type ManagedRecoveryRecord, type ManagedResultProposal,
} from '../rorca-managed-executor';
import { CurrentEngineManagedBridge } from '../current-engine-managed-bridge';
import type { SyntheticTaskManifestSpec } from '../task-manifest-execution-envelope';
import {
  WAVE3A_COMPLETION_MIGRATION, WAVE3A_CONTRACT_PACKAGE_VERSION, WAVE3A_CONTRACT_SOURCE_SHA, WAVE3A_SPEC_SHA,
  WAVE3A_WAVE2_IMPLEMENTATION_SHA, WAVE3A_WAVE2_MIGRATION_HEAD, WAVE3A_WAVE2_SPEC_SHA,
  verifyWave3AImplementationPrerequisites, type Wave3AExactPrerequisitePacket,
} from '../wave3a-managed-executor-gate';

const hash = (digit: string) => `sha256:${digit.repeat(64)}`;
const git = (digit: string) => digit.repeat(40);
const now = '2026-08-05T10:00:00.000Z';
const future = '2026-08-05T11:00:00.000Z';
const workspaceId = 'workspace:managed-test';
const missionId = 'mission:managed-test';
const workPackageId = 'work-package:managed-test';
const attemptId = 'attempt:managed-test';
const leaseId = 'lease:managed-test';
const runtimeId = 'runtime:managed-test';

function header(schemaVersion: string, artifactId: string, contentHash: string) {
  return { schemaVersion,contractId:schemaVersion,contractVersion:'1.0.0',artifactId,contentHash,createdAt:now,createdBy:'host:managed-test' };
}

const spec = { specId:'spec:managed-test',specVersion:1,specHash:hash('1'),canonicalSpecPath:'forge/specs/managed.json',
  storyId:'story:managed-test',storyVersion:1,storyHash:hash('2'),criteriaManifestHash:hash('3') };
const repository = { repositoryId:'repository:managed-test',remoteAuthorityHash:hash('4'),gitObjectFormat:'sha1' as const,
  baseSha:git('a'),currentSha:git('a'),expectedHeadSha:git('a'),worktreeId:'worktree:managed-test',
  allowedPathManifestHash:hash('5'),requiredPathManifestHash:hash('6'),changedPathManifestHash:hash('7'),forbiddenPathManifestHash:hash('8') };
const missionHash = hash('9');
const workPackageHash = hash('a');
const policyDefinitionHash = hash('b');
const activationHash = hash('c');
const checkpointHash = hash('d');
const receiptHash = hash('e');
const bundleHash = hash('f');

const mission = MissionContractV1Schema.parse({
  ...header('rorca.mission-contract.v1','artifact:mission',missionHash),missionId,missionRevision:1,missionHash,workspaceId,canonicalSpec:spec,
  requirements:{ids:['requirement:one'],hash:hash('1')},criteria:{ids:['criterion:one'],hash:hash('2')},objectivesHash:hash('3'),
  invariantsHash:hash('4'),constraintsHash:hash('5'),prohibitedOutcomesHash:hash('6'),evidenceObligationsHash:hash('7'),completionDefinitionHash:hash('8'),
  repository,compiler:{id:'compiler:v1',revision:1,hash:hash('9')},policy:{id:'policy:mission',revision:1,hash:hash('a')},
  contextPolicyDefinition:{id:'policy:context',revision:1,hash:policyDefinitionHash},approvedDecisionReferences:[],
  allowedExecutionPosture:{sequential:true,branchOnly:true,autoMerge:false,deployment:false,providerMutation:false,execution:'execute_bounded'},
  directionLayerHashes:[],sourceManifestHash:hash('b'),creationProvenanceHash:hash('c'),
});
const workPackage = WorkPackageV1Schema.parse({
  ...header('rorca.work-package.v1','artifact:work-package',workPackageHash),workspaceId,missionId,missionRevision:1,missionHash,
  workPackageId,workPackageRevision:1,workPackageHash,spec,objectiveHash:hash('d'),dependencies:[],repository,
  allowedPaths:['backend/src/lib'],requiredPaths:['backend/src/lib'],validationObligationsHash:hash('e'),evidenceObligationsHash:hash('f'),
  executionPostureHash:hash('1'),lifecycleProjectionRef:'lifecycle:managed-test',authorityCeilings:{delivery:'execute_bounded',operational:'none',knowledge:'none',interactive:'none'},
  resourceLimitsHash:hash('2'),retryLimit:2,planRevision:1,state:'active',proposalId:'proposal:managed-test',
});
const lease = ExecutionLeaseV1Schema.parse({
  ...header('rorca.execution-lease.v1','artifact:lease',hash('3')),workspaceId,missionId,missionRevision:1,missionHash,
  workPackageId,workPackageRevision:1,workPackageHash,spec,leaseId,attemptId,runId:41,fencingToken:3,runtimeId,runtimeCapabilityRevision:1,repository,
  policyDefinitionId:'policy:context',policyDefinitionVersion:'1.0.0',policyDefinitionHash,policyActivationId:'activation:managed-test',policyActivationRevision:1,
  policyActivationHash:activationHash,checkpointId:'checkpoint:managed-test',checkpointHash,bundleId:'bundle:managed-test',bundleHash,
  cancellationId:'cancellation:none',issuedAt:now,observedAt:now,expiresAt:future,resourceLimitsHash:hash('4'),evidenceObligationDigest:hash('5'),
  authorityCeilings:{mutation:'execute_bounded',delivery:'execute_bounded',operational:'none',knowledge:'none',interactive:'none'},state:'active',reasonCode:'lease:active',
});
const activationScope = { workspaceId,missionId,missionRevision:1,missionHash,workPackageId,workPackageRevision:1,workPackageHash,spec,runId:41,attemptId,
  leaseId,fencingToken:3,cancellationId:'cancellation:none',runtimeId,repositoryId:repository.repositoryId,remoteAuthorityHash:repository.remoteAuthorityHash,
  baseSha:repository.baseSha,worktreeId:repository.worktreeId,allowedPathManifestHash:repository.allowedPathManifestHash,
  requiredPathManifestHash:repository.requiredPathManifestHash,policyDefinitionId:'policy:context',policyDefinitionVersion:'1.0.0',policyDefinitionHash };
const activation = ContextPolicyActivationV1Schema.parse({
  ...header('rorca.context-continuation-policy-activation.v1','artifact:activation',activationHash),workspaceId,activationId:'activation:managed-test',
  activationRevision:1,activationHash,definitionId:'policy:context',definitionVersion:'1.0.0',definitionHash:policyDefinitionHash,scope:activationScope,
  effectiveValuesHash:hash('6'),authorityReceiptId:'receipt:policy-activation',activatedAt:now,expiresAt:future,state:'active',
});
const continuationScope = { workspaceId,missionId,missionRevision:1,missionHash,workPackageId,workPackageRevision:1,workPackageHash,spec,runId:41,attemptId,
  leaseId,fencingToken:3,leaseExpiresAt:future,cancellationId:'cancellation:none',runtimeId,controllerGeneration:0,runtimeGeneration:0,
  sessionId:'session:managed-test',sessionFileHash:hash('7'),turnId:'turn:managed-test',turnAttempt:1,originatingGeneration:0,cursor:1,cursorHash:hash('8'),
  priorEntryId:'entry:prior',repository,validationStateHash:hash('9'),rootCauseClassification:'root-cause:none',rootCauseHash:hash('a'),
  policyDefinitionId:'policy:context',policyDefinitionVersion:'1.0.0',policyDefinitionHash,policyActivationId:'activation:managed-test',policyActivationRevision:1,policyActivationHash:activationHash };
const checkpoint = ContextCheckpointV1Schema.parse({
  ...header('rorca.context-checkpoint.v1','artifact:checkpoint',checkpointHash),scope:continuationScope,checkpointId:'checkpoint:managed-test',checkpointSequence:1,
  priorCheckpointId:'not_applicable',reasonCode:'initial:dispatch',trigger:{type:'initial_dispatch',launchRequestId:'launch:managed-test',launchRequestHash:hash('b'),
    engineRequestId:'engine-request:managed-test',engineRequestHash:hash('c'),sourceManifestHash:hash('d')},eventHighWaterMark:0,planCursorHash:hash('e'),
  completedWorkHash:hash('f'),pendingWorkHash:hash('1'),boundedReferences:[],retry:{retryCycleId:'not_applicable',phase:'none',attempt:0,maximum:2,
    startEventHash:'not_applicable',endEventHash:'not_applicable',settledEventHash:'not_applicable',generation:0},
  completionCandidate:{state:'absent',hash:'not_applicable'},redactionManifestHash:hash('2'),state:'current',
});
const source = { contextClass:'required' as const,sourceType:'source:spec',stableSourceId:'source:managed-test',sourceVersion:'1',contentHash:hash('3'),
  freshness:'current' as const,excluded:false,redactionHash:hash('4') };
const receipt = RetrievalReceiptV1Schema.parse({
  ...header('rorca.retrieval-receipt.v1','artifact:receipt',receiptHash),scope:continuationScope,requestId:'retrieval:managed-test',receiptId:'receipt:managed-test',
  checkpointId:'checkpoint:managed-test',definitionHash:policyDefinitionHash,activationHash,retrievalKey:hash('5'),sources:[source],requiredComplete:true,
  tokenAccounting:{required:10,advisory:0,instructions:2,total:12},outputId:'output:managed-test',outputHash:hash('6'),startedAt:now,finishedAt:now,
  status:'completed',reasonCode:'retrieval:complete',retryable:false,retryBudgetId:'retry-budget:managed-test',
});
const bundle = ContextBundleV1Schema.parse({
  ...header('rorca.context-bundle.v1','artifact:bundle',bundleHash),scope:continuationScope,bundleId:'bundle:managed-test',bundleVersion:1,bundleHash,
  checkpointId:'checkpoint:managed-test',checkpointHash,receiptId:'receipt:managed-test',receiptHash,definitionHash:policyDefinitionHash,activationHash,
  requiredContext:[source],advisoryMemory:[],orderedSourceHash:hash('7'),redactionManifestHash:hash('8'),tokenAllocationHash:hash('9'),
  tokenAccounting:{required:10,advisory:0,instructions:2,total:12},serializedBytes:200,expiresAt:future,state:'active',
});

function capability(overrides: Partial<ManagedCapabilitySnapshot> = {}): ManagedCapabilitySnapshot {
  return {
    schemaVersion:'rorca.managed-capability-snapshot.v1',snapshotId:'snapshot:worker',snapshotHash:hash('a'),policyVersion:'capability-policy:1',workspaceId,runtimeId,
    providerId:'provider:pi',role:'worker',principalId:'principal:worker',providerAuthReferenceId:'auth-ref:worker',providerBudgetId:'budget:worker',
    rateLimitIdentity:'rate:worker',circuitIdentity:'circuit:worker',processIdentity:'process:worker',queueIdentity:'queue:worker',observedAt:now,validUntil:future,
    decisionSource:'canonical_snapshot',dependencies:[{dependencyId:'dependency:context',requirement:'required',contractVersion:'1.0.0',compatibleContractVersions:['1.0.0'],
      status:'healthy',observedAt:now,validUntil:future,rateLimit:{remaining:10,resetAt:future},circuit:{state:'closed',revision:1},quota:{available:true,headroom:10},
      fallback:{eligible:false,runtimeId:null}}],...overrides,
  };
}
const quota = { cpuMillis:100,memoryBytes:1024,executionConcurrency:1,continuationConcurrency:1,eventCount:100,contextBytes:4096,contextTokens:100,
  storageBytes:4096,storageObjects:5,retrySpend:1,providerTokens:100,providerMicrounits:100 } as const;
function canonicalInput(agent: ManagedExecutorCanonicalInput['agent'] = 'pi'): ManagedExecutorCanonicalInput {
  return { mission,workPackage,lease,policyActivation:activation,checkpoint,retrievalReceipt:receipt,contextBundle:bundle,capabilitySnapshot:capability(),
    degradationPolicy:{policyVersion:'capability-policy:1',allowed:{}},capabilityRequirements:{required:[{dependencyId:'dependency:context',compatibleContractVersions:['1.0.0']}],advisory:[]},
    quotaPolicyVersion:'quota-policy:1',quotaReservationId:'reservation:managed-test',quota,
    generation:0,agent,model:null,terminalMode:'pipe',timeoutMs:1000,retryLimit:2,canonicalSpecPath:spec.canonicalSpecPath,
    repositoryPath:'/tmp/repository-managed',worktreePath:'/tmp/repository-managed/worktree',branchName:'wave3a-managed-test' };
}

const packet: Wave3AExactPrerequisitePacket = {
  schemaVersion:'rorca.wave3a-prerequisite-packet.v1',wave2SpecSha:WAVE3A_WAVE2_SPEC_SHA,contractPackageVersion:WAVE3A_CONTRACT_PACKAGE_VERSION,
  contractSourceSha:WAVE3A_CONTRACT_SOURCE_SHA,migrationHead:WAVE3A_WAVE2_MIGRATION_HEAD,completionMigration:WAVE3A_COMPLETION_MIGRATION,
  implementationGitSha:WAVE3A_WAVE2_IMPLEMENTATION_SHA,conformance:{outcome:'passed',receiptHash:hash('b'),exactSha:WAVE3A_WAVE2_IMPLEMENTATION_SHA},
  independentReview:{outcome:'accepted',receiptHash:hash('c'),reviewerId:'reviewer:independent',implementationActorId:'actor:implementer',exactSha:WAVE3A_WAVE2_IMPLEMENTATION_SHA},
  activeImplementationWaves:['ROR-25','ROR-28'],ownership:{ror28Root:'/private/tmp/rorca-wave3a-ror28-20260805',
    serializedPaths:['packages/rorca-public-contract','scripts/generate-governed-contract-artifacts.ts','generated schemas','docs/implementation/governed-mission-waves-coverage.json'],
    overlapDecision:'serialized_integration_only'},wave3aSpecSha:WAVE3A_SPEC_SHA,
};

class MemoryStore implements ManagedExecutorStore {
  record: ManagedRecoveryRecord | null = null;
  transitionCalls = 0;
  async prepare(request: ManagedEngineRequest): Promise<ManagedPreparation> {
    if (this.record) return {request,launchToken:this.record.launchToken,released:true,replayed:true};
    this.record={request,state:'released',launchToken:'11111111-1111-4111-8111-111111111111',processIdentity:null,resultProposal:null,quarantined:false};
    return {request,launchToken:this.record.launchToken,released:true,replayed:false};
  }
  async revalidate(): Promise<void> {}
  async transition(_hash: string,from: readonly ManagedAttemptState[],to: ManagedAttemptState): Promise<boolean> {
    if (!this.record || !from.includes(this.record.state)) return false;
    this.record={...this.record,state:to}; this.transitionCalls+=1; return true;
  }
  async bindProcess(_hash: string,processIdentity: string): Promise<void> { if (this.record) this.record={...this.record,processIdentity}; }
  async load(): Promise<ManagedRecoveryRecord | null> { return this.record; }
  async listRecoverable(): Promise<readonly ManagedRecoveryRecord[]> { return this.record ? [this.record] : []; }
  async persistResult(proposal: ManagedResultProposal): Promise<{duplicate:boolean}> { if (this.record) this.record={...this.record,resultProposal:proposal}; return {duplicate:false}; }
}
class MemoryBridge implements CurrentExecutionEngineBridge {
  launches=0; live=false;
  async launch(): Promise<{processIdentity:string}> { this.launches+=1;this.live=true;return {processIdentity:'process:managed:1'}; }
  async cancel(): Promise<ManagedHostObservation> { this.live=false;return this.observe(); }
  async observe(): Promise<ManagedHostObservation> { return {live:this.live,processIdentity:'process:managed:1',exitCode:this.live?null:0,exitSignal:null,outputHash:this.live?null:hash('d'),diagnosticCode:null}; }
  async terminate(): Promise<ManagedHostObservation> { this.live=false;return this.observe(); }
}

describe('RorcaManagedExecutor canonical boundary', () => {
  test('exact prerequisite gate is authority-free and rejects a third wave or self-review', () => {
    expect(verifyWave3AImplementationPrerequisites(packet)).toMatchObject({accepted:true,executionAuthority:'none',mergeAuthority:'none',deploymentAuthority:'none'});
    expect(() => verifyWave3AImplementationPrerequisites({...packet,activeImplementationWaves:['ROR-28','ROR-28']} as unknown as Wave3AExactPrerequisitePacket)).toThrow(/sole permitted/);
    expect(() => verifyWave3AImplementationPrerequisites({...packet,independentReview:{...packet.independentReview,reviewerId:'actor:implementer'}})).toThrow(/independent/);
  });

  test('TaskManifest broker has no nominal or structural ExecutionAdapter compatibility',()=>{
    const broker={} as SyntheticTaskManifestSpec;
    expect(MANAGED_EXECUTION_ADAPTER in broker).toBe(false);
    if(false){
      // @ts-expect-error The nominal symbol deliberately prevents broker/executor substitution.
      const forbiddenAdapter:ExecutionAdapter=broker;
      void forbiddenAdapter;
    }
  });

  test.each(['claude','opencode','codex','pi'] as const)('normalizes %s symmetrically and deterministically with branch-only defaults', (agent) => {
    const first=normalizeManagedEngineRequest(canonicalInput(agent),Date.parse(now)+1);
    const second=normalizeManagedEngineRequest(canonicalInput(agent),Date.parse(now)+1);
    expect(second.requestHash).toBe(first.requestHash);
    expect(first).toMatchObject({agent,parallelism:1,isolatedWorktree:true,branchOnly:true,autoMerge:false,deploymentAuthority:false,memoryAuthority:'advisory_only',
      policyActivationHash:activationHash,checkpointHash,bundleHash,capabilitySnapshotHash:hash('a')});
    expect(JSON.stringify(first)).not.toMatch(/contextEpoch|password|secret|authorization|rawPrompt|rawTranscript/i);
  });

  test('blocks stale, unavailable, incompatible, rate-limited, open-circuit, and exhausted dependencies before store/spawn', () => {
    const base=canonicalInput();
    const dependency=(base.capabilitySnapshot.dependencies[0]);
    for (const changed of [
      {...dependency,status:'unknown' as const},{...dependency,status:'unavailable' as const},
      {...dependency,contractVersion:'2.0.0'},{...dependency,rateLimit:{remaining:0,resetAt:future}},
      {...dependency,circuit:{state:'open' as const,revision:2}},{...dependency,quota:{available:false,headroom:0}},
    ]) {
      expect(() => normalizeManagedEngineRequest({...base,capabilitySnapshot:capability({dependencies:[changed]})},Date.parse(now)+1)).toThrow(ManagedAdmissionError);
    }
    expect(() => normalizeManagedEngineRequest({...base,capabilitySnapshot:capability({validUntil:now})},Date.parse(now)+1)).toThrow(/admission window/);
  });

  test('blocks a missing required dependency and policy-gates a missing advisory dependency',()=>{
    const required=canonicalInput();
    expect(()=>normalizeManagedEngineRequest({...required,capabilitySnapshot:capability({dependencies:[]})},Date.parse(now)+1)).toThrow(/required dependency/);
    const advisory={...required,capabilitySnapshot:capability({dependencies:[]}),capabilityRequirements:{required:[],advisory:[{dependencyId:'dependency:optional',compatibleContractVersions:['1.0.0']}]}};
    expect(()=>normalizeManagedEngineRequest(advisory,Date.parse(now)+1)).toThrow(/not policy-permitted/);
    expect(normalizeManagedEngineRequest({...advisory,degradationPolicy:{policyVersion:'capability-policy:1',allowed:{'dependency:optional':['availability']}}},Date.parse(now)+1).degradedDependencies)
      .toEqual([{dependencyId:'dependency:optional',dimensions:['availability']}]);
  });

  test('records only policy-named advisory degradation', () => {
    const degraded={...canonicalInput().capabilitySnapshot.dependencies[0],requirement:'advisory' as const,status:'degraded' as const};
    const input={...canonicalInput(),capabilitySnapshot:capability({dependencies:[degraded]}),capabilityRequirements:{required:[],advisory:[{dependencyId:'dependency:context',compatibleContractVersions:['1.0.0']}]}};
    expect(() => normalizeManagedEngineRequest(input,Date.parse(now)+1)).toThrow(/not policy-permitted/);
    expect(normalizeManagedEngineRequest({...input,degradationPolicy:{policyVersion:'capability-policy:1',allowed:{'dependency:context':['latency']}}},Date.parse(now)+1).degradedDependencies)
      .toEqual([{dependencyId:'dependency:context',dimensions:['latency']}]);
  });

  test('prepares and launches current engine exactly once, then proposes evidence without lifecycle authority', async () => {
    const store=new MemoryStore(); const bridge=new MemoryBridge();
    const executor=new RorcaManagedExecutor(store,bridge,verifyWave3AImplementationPrerequisites(packet),() => Date.parse(now)+1);
    const prepared=await executor.prepare(canonicalInput());
    await executor.launch(prepared);
    await expect(executor.launch(prepared)).rejects.toMatchObject({reason:'duplicate_launch'});
    expect(bridge.launches).toBe(1);
    bridge.live=false;
    const proposal=await executor.proposeResult(prepared.request.requestHash,'succeeded',hash('e'));
    expect(proposal).toMatchObject({closeoutAuthority:'none',storyLifecycleAuthority:'none',mergeAuthority:'none',deploymentAuthority:'none'});
  });

  test('death-proves SIGKILL before cancellation returns a terminal observation',async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'rorca-managed-kill-proof-'));
    const childScript=[
      "process.on('SIGTERM',()=>{})",
      "process.on('message',(message)=>{if(message&&message.type==='launch_start'&&process.send)process.send({type:'pid'})})",
    ].join(';');
    try{
      const request=normalizeManagedEngineRequest({...canonicalInput(),repositoryPath:root,worktreePath:root,canonicalSpecPath:'spec.json'},Date.parse(now)+1);
      const bridge=new CurrentEngineManagedBridge({bin:process.execPath,args:['-e',childScript,'--']},{},10,1_000);
      await bridge.launch(request,'launch-token:kill-proof');
      const observation=await bridge.cancel(request,'security-test');
      expect(observation).toMatchObject({live:false,exitSignal:'SIGKILL'});
    }finally{
      fs.rmSync(root,{recursive:true,force:true});
    }
  });

  test('does not terminalize cancellation while process quiescence is ambiguous',async()=>{
    const store=new MemoryStore();
    const bridge=new MemoryBridge();
    const executor=new RorcaManagedExecutor(store,bridge,verifyWave3AImplementationPrerequisites(packet),()=>Date.parse(now)+1);
    const prepared=await executor.prepare(canonicalInput());
    await executor.launch(prepared);
    bridge.cancel=async()=>bridge.observe();
    await expect(executor.cancel(prepared.request.requestHash,'ambiguous-process')).rejects.toMatchObject({reason:'fence_lost'});
    expect(store.record?.state).toBe('conflicting');
    expect(bridge.live).toBe(true);
  });

  test('terminates an acknowledged child before recording a failed process binding as lost',async()=>{
    const store=new MemoryStore();
    const bridge=new MemoryBridge();
    store.bindProcess=async()=>{throw new Error('bind failed');};
    const executor=new RorcaManagedExecutor(store,bridge,verifyWave3AImplementationPrerequisites(packet),()=>Date.parse(now)+1);
    const prepared=await executor.prepare(canonicalInput());
    await expect(executor.launch(prepared)).rejects.toThrow('bind failed');
    expect(bridge.live).toBe(false);
    expect(store.record?.state).toBe('lost');
  });

  test('retains an acknowledged but unquiesced child as conflicting after process binding fails',async()=>{
    const store=new MemoryStore();
    const bridge=new MemoryBridge();
    store.bindProcess=async()=>{throw new Error('bind failed');};
    bridge.terminate=async()=>bridge.observe();
    const executor=new RorcaManagedExecutor(store,bridge,verifyWave3AImplementationPrerequisites(packet),()=>Date.parse(now)+1);
    const prepared=await executor.prepare(canonicalInput());
    await expect(executor.launch(prepared)).rejects.toMatchObject({reason:'fence_lost'});
    expect(bridge.live).toBe(true);
    expect(store.record?.state).toBe('conflicting');
  });

  test('provider fallback requires distinct worker identities and a new attempt/generation/lease/fence', () => {
    const prior=normalizeManagedEngineRequest(canonicalInput(),Date.parse(now)+1);
    const supervisor=capability({snapshotId:'snapshot:supervisor',snapshotHash:hash('1'),role:'supervisor',providerId:'provider:supervisor'});
    const fallback=capability({snapshotId:'snapshot:fallback',snapshotHash:hash('2'),providerId:'provider:claude',principalId:'principal:fallback',providerAuthReferenceId:'auth-ref:fallback',
      providerBudgetId:'budget:fallback',rateLimitIdentity:'rate:fallback',circuitIdentity:'circuit:fallback',processIdentity:'process:fallback',queueIdentity:'queue:fallback'});
    expect(authorizeConservativeManagedFallback({prior,fallbackSnapshot:fallback,newAttemptId:'attempt:fallback',newGeneration:1,newLeaseId:'lease:fallback',newFence:4,
      exactCompatiblePassExists:false,supervisorSnapshot:supervisor},Date.parse(now)+1)).toMatchObject({allowed:true,branchOnly:true,autoMerge:false,deploymentAuthority:false});
    expect(() => authorizeConservativeManagedFallback({prior,fallbackSnapshot:fallback,newAttemptId:prior.attemptId,newGeneration:0,newLeaseId:prior.leaseId,newFence:3,
      exactCompatiblePassExists:false},Date.parse(now)+1)).toThrow(/new attempt/);
    expect(() => authorizeConservativeManagedFallback({prior,fallbackSnapshot:fallback,newAttemptId:'attempt:fallback',newGeneration:1,newLeaseId:'lease:fallback',newFence:4,
      exactCompatiblePassExists:true},Date.parse(now)+1)).toThrow(/passed story/);
  });
});
