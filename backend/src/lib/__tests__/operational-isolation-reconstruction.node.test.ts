/* Copyright (c) 2026 Rorca Inc. SPDX-License-Identifier: Apache-2.0 */
import assert from 'node:assert/strict'; import test from 'node:test';
import { CleanRoomReconstructor,OPERATIONAL_RESOURCE_BUDGETS,RECONSTRUCTION_STEPS,
  WorkspaceIsolationFaultHarness,gateFinalPilotDemonstration,type CanonicalCleanRoomInputs,type ExecutedReconstructionReceipt,
  type FreshHostNamespace,type PilotLane,type ReconstructionOptions,type ReconstructionStep,type ReconstructionVerifier,
  type StatusPlane,type WorkspaceIsolationState } from '../operational-isolation-reconstruction';
import { governedOperationsHash } from '../governed-operations-primitives';
const H=(value:string)=>governedOperationsHash(value), SHA='a66537fc3a5607a80f6b1010ebdde238d3b6ce8f';
const planes=Object.freeze({source_config_drift:'healthy',dependency_health:'healthy',runtime_health:'healthy',
  queue_outbox_freshness:'healthy',lease_retry_recovery:'healthy',observability_freshness:'healthy',
  provider_operations_readiness:'healthy'}) satisfies Record<StatusPlane,'healthy'|'degraded'>;
function state(workspaceId:string):WorkspaceIsolationState{ return {workspaceId,
  limits:Object.fromEntries(OPERATIONAL_RESOURCE_BUDGETS.map(key=>[key,10])) as WorkspaceIsolationState['limits'],
  used:Object.fromEntries(OPERATIONAL_RESOURCE_BUDGETS.map(key=>[key,0])) as WorkspaceIsolationState['used'],
  reservations:4,admitted:true,cursor:17,replayWindow:['event:16','event:17'],archiveReferences:[`archive://${workspaceId}/1`],
  rawReferenceAccess:true,statusPlanes:{...planes},alertCount:1,secretReferenceHash:H(`${workspaceId}:secret`),
  credentialReferenceHash:H(`${workspaceId}:credential`),authorityReferenceHash:H(`${workspaceId}:authority`)}; }
function inputs():CanonicalCleanRoomInputs{return {exactGitSha:SHA,migrationManifestHash:H('migrations'),verifiedBackupHash:H('backup'),
  ledgerHash:H('ledger'),policyVersion:'1',policyHash:H('policy'),configurationVersion:'1',configurationHash:H('config'),
  vaultSecretReferences:['vault://a/runtime/v3'],artifacts:[{artifactId:'bundle',contentHash:H('bytes')}],
  contractManifestHash:H('contracts'),specHash:H('spec')};}
function namespace(overrides:Partial<FreshHostNamespace>={}):FreshHostNamespace{return {namespaceId:'fresh:1',emptyCaches:true,
  emptyProjections:true,emptyRuntimeHomes:true,hiddenHomeFilesPresent:false,ambientEnvironmentPresent:false,
  mutableHostCronPresent:false,undocumentedSshStatePresent:false,preservedContainersPresent:false,
  projectionDatabasePresent:false,runtimeLocalMemoryPresent:false,advisoryMemoryPresent:false,...overrides};}
function options(lane:PilotLane,overrides:Partial<ReconstructionOptions>={}):ReconstructionOptions{return {lane,namespace:namespace(),inputs:inputs(),
  toolVersions:{node:'22.19.0',postgres:'16'},exactCommands:RECONSTRUCTION_STEPS.map(step=>`execute:${step}`),
  environmentClass:'deterministic_fixture',...overrides};}
class ExecutedVerifierFixture implements ReconstructionVerifier{
  calls:ReconstructionStep[]=[]; blocked=new Set<ReconstructionStep>(); tamper:ReconstructionStep|null=null;
  async execute(step:ReconstructionStep,inputHash:`sha256:${string}`,command:string):Promise<ExecutedReconstructionReceipt>{
    this.calls.push(step); const material={step,inputHash,command,status:this.blocked.has(step)?'blocked' as const:
      step==='verify_optional_dependency_degradation'?'degraded' as const:'verified' as const,observedHash:H(`observed:${step}`),
      executedAt:'2026-08-05T15:00:00.000Z',verifierId:'fixture:executed-verifier',
      ...(step==='observe_seven_status_planes'?{statusPlanes:planes}:{})};
    return {...material,receiptHash:this.tamper===step?H('tampered'):governedOperationsHash(material)};
  }
}
test('W4-014 independently exhausts every budget without changing workspace B',()=>{for(const lane of ['managed','fake_federated'] as const)
  for(const budget of OPERATIONAL_RESOURCE_BUDGETS){const a=state('a'),b=state('b'),before=structuredClone(b);
    const receipt=new WorkspaceIsolationFaultHarness(new Map([['a',a],['b',b]])).exhaust(lane,'a','b',budget);
    assert.equal(receipt.zeroLeakage,true);assert.equal(receipt.protectedStateBeforeHash,receipt.protectedStateAfterHash);assert.deepEqual(b,before);}});
test('W4-014 certificate observations require executed, exact-input, immutable verifier receipts',async()=>{
  for(const lane of ['managed','fake_federated'] as const){const verifier=new ExecutedVerifierFixture();
    const certificate=await new CleanRoomReconstructor(verifier).reconstruct(options(lane));
    assert.deepEqual(verifier.calls,RECONSTRUCTION_STEPS);assert.equal(certificate.observations.length,12);
    assert.ok(certificate.observations.every(value=>/^sha256:/.test(value.verifierReceiptHash)));
    assert.ok(certificate.unresolvedBlockers.includes('real_host_reconstruction_outstanding'));
    assert.equal(certificate.environmentClass,'deterministic_fixture');assert.equal(certificate.providerMutationCount,0);
  }});
test('W4-014 forged or blocked executed receipts and hidden state fail closed',async()=>{
  const verifier=new ExecutedVerifierFixture();verifier.tamper='apply_migrations';verifier.blocked.add('verify_artifacts');
  const certificate=await new CleanRoomReconstructor(verifier).reconstruct(options('managed',{namespace:namespace({ambientEnvironmentPresent:true})}));
  assert.ok(certificate.unresolvedBlockers.includes('invalid_executed_receipt:apply_migrations'));
  assert.ok(certificate.unresolvedBlockers.includes('executed_step_blocked:verify_artifacts'));
  assert.ok(certificate.unresolvedBlockers.includes('fresh_namespace_or_hidden_state_not_proven_absent'));
});
test('W4-014 fixture certificates cannot satisfy final independent real-host review gate',async()=>{
  const verifier=new ExecutedVerifierFixture(),reconstructor=new CleanRoomReconstructor(verifier);
  const certificates=[await reconstructor.reconstruct(options('managed')),await reconstructor.reconstruct(options('fake_federated'))];
  const hashes=certificates.map(value=>value.certificateHash),review={packetHash:governedOperationsHash([...hashes].sort()),
    certificateHashes:hashes,reviewerIdentityHash:H('reviewer'),architectureFindingCount:0,securityFindingCount:0,
    operationsFindingCount:0,hiddenStateFindingCount:0,crossWorkspaceFindingCount:0,resourceIsolationFindingCount:0,
    secretFindingCount:0,authorityFindingCount:0,verdict:'accepted' as const};
  assert.deepEqual(gateFinalPilotDemonstration(certificates,review),{permitted:false,reasonCode:'final_demonstration_blocked',authorityEffect:'none'});
});
