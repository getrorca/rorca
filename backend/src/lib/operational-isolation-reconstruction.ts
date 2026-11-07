/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { boundedRedactedObservation, governedOperationsHash, requireExactHash, type Sha256 } from './governed-operations-primitives';

export const OPERATIONAL_RESOURCE_BUDGETS = ['cpuMillis','memoryBytes','executionConcurrency','continuationConcurrency','eventRate',
  'contextBytes','contextTokens','storageBytes','storageObjects','retrySpend','providerTokens','providerCurrencyMicros',
  'rawReferences','retentionObjects','alerts'] as const;
export type OperationalResourceBudget = typeof OPERATIONAL_RESOURCE_BUDGETS[number];
export type PilotLane = 'managed' | 'fake_federated';
export const SEVEN_STATUS_PLANES = ['source_config_drift','dependency_health','runtime_health','queue_outbox_freshness',
  'lease_retry_recovery','observability_freshness','provider_operations_readiness'] as const;
export type StatusPlane = typeof SEVEN_STATUS_PLANES[number];
export interface WorkspaceIsolationState { workspaceId:string; limits:Record<OperationalResourceBudget,number>;
  used:Record<OperationalResourceBudget,number>; reservations:number; admitted:boolean; cursor:number; replayWindow:readonly string[];
  archiveReferences:readonly string[]; rawReferenceAccess:boolean; statusPlanes:Readonly<Record<StatusPlane,'healthy'|'degraded'>>;
  alertCount:number; secretReferenceHash:Sha256; credentialReferenceHash:Sha256; authorityReferenceHash:Sha256 }
export interface ExhaustionReceipt { lane:PilotLane; exhaustedWorkspaceId:string; protectedWorkspaceId:string;
  budget:OperationalResourceBudget; scopedAdmissionBlocked:true; protectedStateBeforeHash:Sha256; protectedStateAfterHash:Sha256;
  zeroLeakage:true; providerMutationCount:0; authorityEffect:'none'; receiptHash:Sha256 }
export class WorkspaceIsolationFaultHarness {
  constructor(private readonly workspaces:Map<string,WorkspaceIsolationState>) {}
  exhaust(lane:PilotLane,workspaceA:string,workspaceB:string,budget:OperationalResourceBudget):ExhaustionReceipt {
    const isolated=this.workspaces.get(workspaceA), protectedState=this.workspaces.get(workspaceB);
    if(!isolated||!protectedState||workspaceA===workspaceB) throw new Error('Two distinct workspace fixtures are required');
    const beforeHash=governedOperationsHash(structuredClone(protectedState));
    isolated.used[budget]=isolated.limits[budget]; isolated.admitted=false;
    isolated.statusPlanes={...isolated.statusPlanes,runtime_health:'degraded'};
    isolated.alertCount=Math.min(isolated.alertCount+1,isolated.limits.alerts);
    const afterHash=governedOperationsHash(protectedState);
    if(beforeHash!==afterHash||isolated.secretReferenceHash===protectedState.secretReferenceHash
      ||isolated.credentialReferenceHash===protectedState.credentialReferenceHash
      ||isolated.authorityReferenceHash===protectedState.authorityReferenceHash) throw new Error('Cross-workspace isolation failed');
    const material={lane,exhaustedWorkspaceId:workspaceA,protectedWorkspaceId:workspaceB,budget,
      scopedAdmissionBlocked:true as const,protectedStateBeforeHash:beforeHash,protectedStateAfterHash:afterHash,
      zeroLeakage:true as const,providerMutationCount:0 as const,authorityEffect:'none' as const};
    return Object.freeze({...material,receiptHash:governedOperationsHash(material)});
  }
}
export interface CanonicalCleanRoomInputs { exactGitSha:string; migrationManifestHash:Sha256; verifiedBackupHash:Sha256;
  ledgerHash:Sha256; policyVersion:string; policyHash:Sha256; configurationVersion:string; configurationHash:Sha256;
  vaultSecretReferences:readonly string[]; artifacts:readonly {artifactId:string;contentHash:Sha256}[];
  contractManifestHash:Sha256; specHash:Sha256 }
export interface FreshHostNamespace { namespaceId:string; emptyCaches:boolean; emptyProjections:boolean; emptyRuntimeHomes:boolean;
  hiddenHomeFilesPresent:boolean; ambientEnvironmentPresent:boolean; mutableHostCronPresent:boolean; undocumentedSshStatePresent:boolean;
  preservedContainersPresent:boolean; projectionDatabasePresent:boolean; runtimeLocalMemoryPresent:boolean; advisoryMemoryPresent:boolean }
export const RECONSTRUCTION_STEPS = ['verify_source_sha','apply_migrations','verify_backup_ledger','verify_public_contract_generation',
  'reconcile_inventory','recover_queue_outbox','scan_lease_fence_retry','verify_artifacts','verify_context_continuation',
  'observe_seven_status_planes','verify_optional_dependency_degradation','cleanup'] as const;
export type ReconstructionStep=typeof RECONSTRUCTION_STEPS[number];
export interface ExecutedReconstructionReceipt { step:ReconstructionStep; inputHash:Sha256; command:string;
  status:'verified'|'degraded'|'blocked'; observedHash:Sha256; executedAt:string; verifierId:string;
  statusPlanes?:Readonly<Record<StatusPlane,'healthy'|'degraded'>>; receiptHash:Sha256 }
export interface ReconstructionObservation { step:ReconstructionStep; status:'verified'|'degraded'|'blocked';
  observationHash:Sha256; verifierReceiptHash:Sha256; detail:string }
export interface ReconstructionOptions { lane:PilotLane; namespace:FreshHostNamespace; inputs:CanonicalCleanRoomInputs;
  toolVersions:Readonly<Record<string,string>>; exactCommands:readonly string[];
  environmentClass:'deterministic_fixture'|'real_isolated_host' }
export interface ReconstructionVerifier { execute(step:ReconstructionStep,inputHash:Sha256,command:string,
  options:ReconstructionOptions):Promise<ExecutedReconstructionReceipt> }
export interface CleanRoomCertificate { schemaVersion:'rorca.clean-room-certificate.v1'; lane:PilotLane; namespaceId:string;
  environmentClass:ReconstructionOptions['environmentClass']; sourceSha:string; migrationHash:Sha256; contractHash:Sha256;
  specHash:Sha256; artifactSetHash:Sha256; backupLedgerHash:Sha256; policyConfigurationHash:Sha256;
  toolVersions:Readonly<Record<string,string>>; exactCommands:readonly string[]; observations:readonly ReconstructionObservation[];
  statusPlanes:Readonly<Record<StatusPlane,'healthy'|'degraded'>>; unresolvedBlockers:readonly string[]; cleanupHash:Sha256;
  providerMutationCount:0; productionMutationCount:0; authorityEffect:'none'; certificateHash:Sha256 }

export class CleanRoomReconstructor {
  constructor(private readonly verifier:ReconstructionVerifier) {}
  async reconstruct(options:ReconstructionOptions):Promise<CleanRoomCertificate> {
    this.validateInputs(options.inputs);
    if(options.exactCommands.length!==RECONSTRUCTION_STEPS.length) throw new Error('Every reconstruction step requires one exact command');
    const blockers:string[]=[]; const observations:ReconstructionObservation[]=[];
    let statusPlanes={} as Record<StatusPlane,'healthy'|'degraded'>;
    for(let index=0;index<RECONSTRUCTION_STEPS.length;index+=1){
      const step=RECONSTRUCTION_STEPS[index], command=options.exactCommands[index]!;
      const inputHash=governedOperationsHash({step,command,lane:options.lane,namespace:options.namespace,inputs:options.inputs});
      const receipt=await this.verifier.execute(step,inputHash,command,options);
      const {receiptHash,...receiptMaterial}=receipt;
      const exact=receipt.step===step&&receipt.inputHash===inputHash&&receipt.command===command
        &&governedOperationsHash(receiptMaterial)===receiptHash&&Boolean(receipt.verifierId)&&Number.isFinite(Date.parse(receipt.executedAt));
      if(!exact){ blockers.push(`invalid_executed_receipt:${step}`); observations.push({step,status:'blocked',
        observationHash:governedOperationsHash({step,invalid:true}),verifierReceiptHash:receiptHash,
        detail:'executed verifier receipt failed exact input, command, or integrity binding'}); continue; }
      if(receipt.status==='blocked') blockers.push(`executed_step_blocked:${step}`);
      if(step==='observe_seven_status_planes'){
        if(!receipt.statusPlanes||SEVEN_STATUS_PLANES.some(plane=>!receipt.statusPlanes?.[plane])) blockers.push('status_plane_missing');
        else statusPlanes={...receipt.statusPlanes};
      }
      observations.push({step,status:receipt.status,observationHash:governedOperationsHash({step,receiptHash,status:receipt.status}),
        verifierReceiptHash:receiptHash,detail:boundedRedactedObservation(`executed verifier ${receipt.verifierId}; observed ${receipt.observedHash}`)});
    }
    if(options.environmentClass!=='real_isolated_host') blockers.push('real_host_reconstruction_outstanding');
    const hidden=options.namespace;
    if(!hidden.emptyCaches||!hidden.emptyProjections||!hidden.emptyRuntimeHomes||hidden.hiddenHomeFilesPresent
      ||hidden.ambientEnvironmentPresent||hidden.mutableHostCronPresent||hidden.undocumentedSshStatePresent
      ||hidden.preservedContainersPresent||hidden.projectionDatabasePresent||hidden.runtimeLocalMemoryPresent||hidden.advisoryMemoryPresent){
      blockers.push('fresh_namespace_or_hidden_state_not_proven_absent');
    }
    const material={schemaVersion:'rorca.clean-room-certificate.v1' as const,lane:options.lane,namespaceId:options.namespace.namespaceId,
      environmentClass:options.environmentClass,sourceSha:options.inputs.exactGitSha,migrationHash:options.inputs.migrationManifestHash,
      contractHash:options.inputs.contractManifestHash,specHash:options.inputs.specHash,artifactSetHash:governedOperationsHash(options.inputs.artifacts),
      backupLedgerHash:governedOperationsHash([options.inputs.verifiedBackupHash,options.inputs.ledgerHash]),
      policyConfigurationHash:governedOperationsHash([options.inputs.policyVersion,options.inputs.policyHash,
        options.inputs.configurationVersion,options.inputs.configurationHash]),toolVersions:Object.freeze({...options.toolVersions}),
      exactCommands:Object.freeze([...options.exactCommands]),observations:Object.freeze(observations),statusPlanes:Object.freeze(statusPlanes),
      unresolvedBlockers:Object.freeze([...new Set(blockers)]),cleanupHash:governedOperationsHash(observations.find(value=>value.step==='cleanup')),
      providerMutationCount:0 as const,productionMutationCount:0 as const,authorityEffect:'none' as const};
    return Object.freeze({...material,certificateHash:governedOperationsHash(material)});
  }
  private validateInputs(inputs:CanonicalCleanRoomInputs):void {
    if(!/^[0-9a-f]{40}$/.test(inputs.exactGitSha)) throw new Error('Typed block: exact full Git SHA required');
    for(const [value,label] of [[inputs.migrationManifestHash,'migration'],[inputs.verifiedBackupHash,'backup'],[inputs.ledgerHash,'ledger'],
      [inputs.policyHash,'policy'],[inputs.configurationHash,'configuration'],[inputs.contractManifestHash,'contract'],[inputs.specHash,'spec']] as const) requireExactHash(value,label);
    if(inputs.vaultSecretReferences.length===0||inputs.vaultSecretReferences.some(reference=>!reference.startsWith('vault://'))||inputs.artifacts.length===0)
      throw new Error('Typed block: vault references and content-addressed artifacts required');
    inputs.artifacts.forEach(artifact=>requireExactHash(artifact.contentHash,`artifact ${artifact.artifactId}`));
  }
}
export interface IndependentOperationsReview { packetHash:Sha256; certificateHashes:readonly Sha256[]; reviewerIdentityHash:Sha256;
  architectureFindingCount:number;securityFindingCount:number;operationsFindingCount:number;hiddenStateFindingCount:number;
  crossWorkspaceFindingCount:number;resourceIsolationFindingCount:number;secretFindingCount:number;authorityFindingCount:number;verdict:'accepted'|'blocked' }
export function gateFinalPilotDemonstration(certificates:readonly CleanRoomCertificate[],review:IndependentOperationsReview):{permitted:boolean;reasonCode:string;authorityEffect:'none'}{
  const exact=certificates.map(value=>value.certificateHash).sort(),reviewed=[...review.certificateHashes].sort();
  const findings=review.architectureFindingCount+review.securityFindingCount+review.operationsFindingCount+review.hiddenStateFindingCount
    +review.crossWorkspaceFindingCount+review.resourceIsolationFindingCount+review.secretFindingCount+review.authorityFindingCount;
  const exactPacket=governedOperationsHash(exact)===review.packetHash&&governedOperationsHash(reviewed)===review.packetHash
    &&exact.every((hash,index)=>hash===reviewed[index]);
  const clean=certificates.length===2&&new Set(certificates.map(value=>value.lane)).size===2
    &&certificates.every(value=>value.environmentClass==='real_isolated_host'&&value.unresolvedBlockers.length===0);
  const permitted=exactPacket&&clean&&review.verdict==='accepted'&&findings===0;
  return {permitted,reasonCode:permitted?'independent_exact_packet_review_accepted':'final_demonstration_blocked',authorityEffect:'none'};
}
