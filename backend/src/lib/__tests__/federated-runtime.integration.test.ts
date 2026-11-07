/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import {
  ContextBundleV1Schema, ContextCheckpointV1Schema, ContextPolicyActivationV1Schema, ContinuationDispatchV1Schema,
  ExecutionLeaseV1Schema, MissionContractV1Schema, RetrievalReceiptV1Schema, RuntimeEventV1Schema,
  WorkPackageV1Schema, governedHash,
} from '../governed-contracts';
import {
  RuntimeNeutralObservationV1Schema, RuntimeTelemetryBatchV1Schema, type RuntimeNeutralObservationV1,
} from '../governed-contracts/run-stream';
import {
  evaluateGovernedCloseout, requestExecutionCancellation, reviewPlanChangeProposal,
} from '../governed-mission-service';
import { runtimeTelemetryBatchIntegrityHash } from '../run-activity-store';
import {
  FederatedHostVerifier, type FederatedHostVerification,
} from '../federated-host-verifier';
import {
  FederatedRuntimeService, federatedCredentialDigest, type FederatedAuthenticatedRuntime,
} from '../federated-runtime-service';
import { FederatedLeaseBindingSchema, type FederatedLeaseBinding, type FederatedResultProposal } from '../federated-runtime-contracts';
import { loadCanonicalWave4FederationGate, type Wave4FederationGate } from '../wave4-federation-gate';
import { createFederatedRuntimeRouter } from '../../routes/federated-runtime';

const ownerUrl = process.env.RORCA_MIGRATION_DATABASE_URL;
const writerUrl = process.env.RORCA_CANONICAL_WRITER_DATABASE_URL;
const runtimeUrl = process.env.DATABASE_URL;
if (!ownerUrl || !writerUrl || !runtimeUrl) throw new Error('Federated runtime DB integration requires isolated owner, writer, and runtime URLs');
const suffix = randomUUID();
const workspaceId = `workspace:wave4-${suffix}`;
const runtimeId = `runtime:wave4-${suffix}`;
const owner = new Pool({ connectionString: ownerUrl,
  options: `--search_path=rorca,public -c rorca.migration_mode=on -c rorca.workspace_id=${workspaceId}` });
const runtimeDb = new Pool({ connectionString: runtimeUrl,
  options: `--search_path=rorca,public -c rorca.workspace_id=${workspaceId}` });
const writerDb = new Pool({ connectionString: writerUrl,
  options: `--search_path=rorca,public -c rorca.workspace_id=${workspaceId}` });
const credentialOne = `credential-one-${suffix}-at-least-thirty-two-bytes`;
const credentialTwo = `credential-two-${suffix}-at-least-thirty-two-bytes`;
const h = (value: string): string => `sha256:${value.repeat(64)}`;
const gate: Wave4FederationGate = { schemaVersion: 'rorca.wave4-federation-gate.v1', accepted: true, packetHash: h('1'),
  runtimeLimit: 1, executionAuthority: 'execute_bounded', lifecycleDecisionAuthority: 'none', providerHumanAuthority: 'none',
  mergeAuthority: 'none', deploymentAuthority: 'none', productionAuthority: 'none' };
const service = new FederatedRuntimeService(gate, new FederatedHostVerifier({ loadWorktree: async () => null,
  verifyValidation: async () => false, verifyArtifact: async () => false }));
const federatedHttp = express();
federatedHttp.set('trust proxy', 'loopback');
federatedHttp.use('/api/mission-control/v1/federation', createFederatedRuntimeRouter(async () => service));

function registration(id = runtimeId, workspace = workspaceId, credentialVersion = 1, keyVersion = 1, credential = credentialOne) {
  return { schemaVersion: 'rorca.federated-runtime-registration.v1', runtimeId: id, workspaceId: workspace,
    credentialVersion, keyVersion, credentialDigest: federatedCredentialDigest(id, credentialVersion, keyVersion, credential),
    endpoint: 'https://runtime.example.test/v1', allowedContractVersions: ['1.0.0'], allowedPaths: ['backend/src'],
    mutationBoundsHash: h('2'), status: 'active', expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    auditProvenanceHash: h('3'), registeredBy: 'host:wave4-test', idempotencyKey: `register:${id}`,
    controlPlaneCredentials: false, databaseCredentials: false, githubCredentials: false, modelProviderCredentials: false,
    providerHumanCredentials: false, mergeAuthority: false, deploymentAuthority: false };
}

const runId = 9_000_000 + Math.floor(Math.random() * 500_000);
const generation = 1;
const sessionId = `session:wave4-${suffix}`;
const sessionFileHash = h('4');
const cursorHash = h('5');
let authenticatedRuntime: FederatedAuthenticatedRuntime;
let binding: FederatedLeaseBinding;
let claimId: string;

function canonicalOfferFixture() {
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const offerExpiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const missionId = `mission:wave4-${suffix}`;
  const workPackageId = `work-package:wave4-${suffix}`;
  const attemptId = `attempt:wave4-${suffix}`;
  const leaseId = `lease:wave4-${suffix}`;
  const repository = { repositoryId: `repository:wave4-${suffix}`, remoteAuthorityHash: h('6'), gitObjectFormat: 'sha1' as const,
    baseSha: 'a'.repeat(40), currentSha: 'a'.repeat(40), expectedHeadSha: 'a'.repeat(40), worktreeId: `worktree:wave4-${suffix}`,
    allowedPathManifestHash: h('7'), requiredPathManifestHash: h('8'), changedPathManifestHash: h('9'),
    forbiddenPathManifestHash: h('a') };
  const spec = { specId: `spec:wave4-${suffix}`, specVersion: 1, specHash: h('b'),
    canonicalSpecPath: `forge/specs/pending/wave4-${suffix}.json`, storyId: `W4-${suffix}`, storyVersion: 1,
    storyHash: h('c'), criteriaManifestHash: h('d') };
  const missionHash = h('e'); const workPackageHash = h('f'); const definitionHash = h('0');
  const activationHash = h('1'); const checkpointHash = h('2'); const receiptHash = h('3'); const bundleHash = h('4');
  const evidenceManifest = [{ kind: 'federated_host_verification', minimumTrust: 'host_observed',
    requiredStatus: 'passed', obligationHash: h('5') }];
  const evidenceManifestHash = governedHash('rorca.evidence-obligation-manifest.v1', evidenceManifest);
  const header = (schemaVersion: string, artifactId: string, contentHash: string) => ({
    schemaVersion, contractId: schemaVersion, contractVersion: '1.0.0', artifactId, contentHash, createdAt, createdBy: 'host:wave4-test',
  });
  const mission = MissionContractV1Schema.parse({
    ...header('rorca.mission-contract.v1', `artifact:${missionId}`, missionHash), missionId, missionRevision: 1,
    missionHash, workspaceId, canonicalSpec: spec, requirements: { ids: ['REQ-W4'], hash: h('5') },
    criteria: { ids: ['W4-003:criterion:2'], hash: h('6') }, objectivesHash: h('7'), invariantsHash: h('8'),
    constraintsHash: h('9'), prohibitedOutcomesHash: h('a'), evidenceObligationsHash: evidenceManifestHash,
    completionDefinitionHash: h('c'),
    repository, compiler: { id: 'compiler:wave4', revision: 1, hash: h('d') },
    policy: { id: 'policy:mission-wave4', revision: 1, hash: h('e') },
    contextPolicyDefinition: { id: 'policy:context-wave4', revision: 1, hash: definitionHash },
    approvedDecisionReferences: [], allowedExecutionPosture: { sequential: true, branchOnly: true, autoMerge: false,
      deployment: false, providerMutation: false, execution: 'execute_bounded' },
    directionLayerHashes: [], sourceManifestHash: h('f'), creationProvenanceHash: h('0'),
  });
  const workPackage = WorkPackageV1Schema.parse({
    ...header('rorca.work-package.v1', `artifact:${workPackageId}`, workPackageHash), workspaceId, missionId,
    missionRevision: 1, missionHash, workPackageId, workPackageRevision: 1, workPackageHash, spec,
    objectiveHash: h('1'), dependencies: [], repository, allowedPaths: ['backend/src'], requiredPaths: ['backend/src'],
    validationObligationsHash: h('2'), evidenceObligationsHash: evidenceManifestHash, executionPostureHash: h('4'),
    lifecycleProjectionRef: `lifecycle:${suffix}`, authorityCeilings: { delivery: 'none', operational: 'none',
      knowledge: 'observe', interactive: 'none' }, resourceLimitsHash: h('5'), retryLimit: 2, planRevision: 1,
    state: 'active', proposalId: `proposal:initial-${suffix}`,
  });
  const lease = ExecutionLeaseV1Schema.parse({
    ...header('rorca.execution-lease.v1', `artifact:${leaseId}`, h('6')), workspaceId, missionId, missionRevision: 1,
    missionHash, workPackageId, workPackageRevision: 1, workPackageHash, spec, leaseId, attemptId, runId,
    fencingToken: 1, runtimeId, runtimeCapabilityRevision: 1, repository, policyDefinitionId: 'policy:context-wave4',
    policyDefinitionVersion: '1.0.0', policyDefinitionHash: definitionHash, policyActivationId: `activation:${suffix}`,
    policyActivationRevision: 1, policyActivationHash: activationHash, checkpointId: `checkpoint:${suffix}`,
    checkpointHash, bundleId: `bundle:${suffix}`, bundleHash, cancellationId: `cancellation:${suffix}`,
    issuedAt: createdAt, observedAt: createdAt, expiresAt, resourceLimitsHash: h('7'),
    evidenceObligationDigest: evidenceManifestHash,
    authorityCeilings: { mutation: 'execute_bounded', delivery: 'none', operational: 'none', knowledge: 'observe',
      interactive: 'none' }, state: 'active', reasonCode: 'wave4_federated_offer',
  });
  const activationScope = { workspaceId, missionId, missionRevision: 1, missionHash, workPackageId, workPackageRevision: 1,
    workPackageHash, spec, runId, attemptId, leaseId, fencingToken: 1, cancellationId: lease.cancellationId, runtimeId,
    repositoryId: repository.repositoryId, remoteAuthorityHash: repository.remoteAuthorityHash, baseSha: repository.baseSha,
    worktreeId: repository.worktreeId, allowedPathManifestHash: repository.allowedPathManifestHash,
    requiredPathManifestHash: repository.requiredPathManifestHash, policyDefinitionId: lease.policyDefinitionId,
    policyDefinitionVersion: lease.policyDefinitionVersion, policyDefinitionHash: definitionHash };
  const activation = ContextPolicyActivationV1Schema.parse({
    ...header('rorca.context-continuation-policy-activation.v1', `artifact:activation-${suffix}`, activationHash),
    workspaceId, activationId: lease.policyActivationId, activationRevision: 1, activationHash,
    definitionId: lease.policyDefinitionId, definitionVersion: '1.0.0', definitionHash, scope: activationScope,
    effectiveValuesHash: h('8'), authorityReceiptId: `authority:activation-${suffix}`, activatedAt: createdAt,
    expiresAt, state: 'active',
  });
  const scope = { workspaceId, missionId, missionRevision: 1, missionHash, workPackageId, workPackageRevision: 1,
    workPackageHash, spec, runId, attemptId, leaseId, fencingToken: 1, leaseExpiresAt: expiresAt,
    cancellationId: lease.cancellationId, runtimeId, controllerGeneration: 1, runtimeGeneration: generation, sessionId,
    sessionFileHash, turnId: `turn:${suffix}`, turnAttempt: 1, originatingGeneration: generation, cursor: 0, cursorHash,
    priorEntryId: 'not_applicable' as const, repository, validationStateHash: h('9'),
    rootCauseClassification: 'code', rootCauseHash: h('a'), policyDefinitionId: lease.policyDefinitionId,
    policyDefinitionVersion: '1.0.0', policyDefinitionHash: definitionHash, policyActivationId: activation.activationId,
    policyActivationRevision: 1, policyActivationHash: activationHash };
  const trigger = { type: 'initial_dispatch' as const, launchRequestId: `launch:${suffix}`, launchRequestHash: h('b'),
    engineRequestId: `engine:${suffix}`, engineRequestHash: h('c'), sourceManifestHash: h('d') };
  const checkpoint = ContextCheckpointV1Schema.parse({
    ...header('rorca.context-checkpoint.v1', `artifact:checkpoint-${suffix}`, checkpointHash), scope,
    checkpointId: lease.checkpointId, checkpointSequence: 0, priorCheckpointId: 'not_applicable', reasonCode: 'initial',
    trigger, eventHighWaterMark: 0, planCursorHash: h('e'), completedWorkHash: h('f'), pendingWorkHash: h('0'),
    boundedReferences: [], retry: { retryCycleId: 'not_applicable', phase: 'none', attempt: 0, maximum: 2,
      startEventHash: 'not_applicable', endEventHash: 'not_applicable', settledEventHash: 'not_applicable', generation },
    completionCandidate: { state: 'absent', hash: 'not_applicable' }, redactionManifestHash: h('1'), state: 'current',
  });
  const source = { contextClass: 'required' as const, sourceType: 'git', stableSourceId: `source:${suffix}`,
    sourceVersion: '1', contentHash: h('2'), freshness: 'current' as const, excluded: false, redactionHash: h('3') };
  const tokenAccounting = { required: 10, advisory: 0, instructions: 2, total: 12 };
  const receipt = RetrievalReceiptV1Schema.parse({
    ...header('rorca.retrieval-receipt.v1', `artifact:receipt-${suffix}`, receiptHash), scope,
    requestId: `retrieval:${suffix}`, receiptId: `receipt:${suffix}`, checkpointId: checkpoint.checkpointId,
    definitionHash, activationHash, retrievalKey: h('4'), sources: [source], requiredComplete: true, tokenAccounting,
    outputId: `output:${suffix}`, outputHash: h('5'), startedAt: createdAt, finishedAt: createdAt, status: 'completed',
    reasonCode: 'complete', retryable: false, retryBudgetId: `retry-budget:${suffix}`,
  });
  const bundle = ContextBundleV1Schema.parse({
    ...header('rorca.context-bundle.v1', `artifact:bundle-${suffix}`, bundleHash), scope, bundleId: lease.bundleId,
    bundleVersion: 1, bundleHash, checkpointId: checkpoint.checkpointId, checkpointHash,
    receiptId: receipt.receiptId, receiptHash, definitionHash, activationHash, requiredContext: [source], advisoryMemory: [],
    orderedSourceHash: governedHash('rorca.context-bundle-ordered-sources.v1', [source]),
    redactionManifestHash: governedHash('rorca.context-bundle-redactions.v1', [source.redactionHash]),
    tokenAllocationHash: governedHash('rorca.context-bundle-token-allocation.v1', tokenAccounting), tokenAccounting,
    serializedBytes: 200, expiresAt, state: 'active',
  });
  const dispatch = ContinuationDispatchV1Schema.parse({
    ...header('rorca.continuation-dispatch.v1', `artifact:dispatch-${suffix}`, h('6')), scope,
    dispatchId: `dispatch:${suffix}`, continuationKey: h('7'), trigger, checkpointId: checkpoint.checkpointId,
    checkpointHash, receiptId: receipt.receiptId, receiptHash, bundleId: bundle.bundleId, bundleHash,
    definitionHash, activationHash, targetSessionId: sessionId, targetCursor: 0, priorEntryId: 'not_applicable',
    expectedCursorAdvance: 1, renderedPayloadHash: h('8'), renderedPayloadRef: { referenceId: `rendered:${suffix}`,
      kind: 'context', hash: h('8'), sensitivity: 'restricted', retentionClass: 'wave4-test', accessTier: 'admin',
      rawPayloadIncluded: false }, firstLeaseVerificationHash: h('9'), casLeaseVerificationHash: h('a'),
    authorizationExpiresAt: offerExpiresAt, controllerId: 'controller:wave4', adapterVersion: '1.0.0', attempt: 1,
    retryBudgetId: receipt.retryBudgetId, state: 'lease_verified', reasonCode: 'verified',
  });
  return { mission, workPackage, lease, activation, checkpoint, receipt, bundle, dispatch, scope, offerExpiresAt,
    evidenceManifest, evidenceManifestHash };
}
let offerFixture = canonicalOfferFixture();

async function seedCanonicalOffer() {
  const fixture = canonicalOfferFixture();
  const { mission, workPackage, lease, activation } = fixture;
  const repository = lease.repository; const spec = lease.spec;
  await owner.query(`INSERT INTO rorca.governed_missions(workspace_id,mission_id,created_by) VALUES($1,$2,'host:wave4')`,
    [workspaceId, mission.missionId]);
  await owner.query(`INSERT INTO rorca.governed_mission_versions(
    workspace_id,mission_id,mission_revision,mission_hash,contract_version,canonical_spec_id,canonical_spec_version,
    canonical_spec_hash,canonical_spec_path,repository_id,base_sha,payload_json,payload_hash,created_by)
    VALUES($1,$2,1,$3,'1.0.0',$4,1,$5,$6,$7,$8,$9::jsonb,$10,'host:wave4')`,
  [workspaceId, mission.missionId, mission.missionHash, spec.specId, spec.specHash, spec.canonicalSpecPath,
    repository.repositoryId, repository.baseSha, JSON.stringify(mission), h('b')]);
  await owner.query(`INSERT INTO rorca.governed_mission_heads(workspace_id,mission_id,current_revision,current_hash,lifecycle_state)
    VALUES($1,$2,1,$3,'active')`, [workspaceId, mission.missionId, mission.missionHash]);
  await owner.query(`INSERT INTO rorca.governed_work_packages(workspace_id,mission_id,work_package_id,created_by)
    VALUES($1,$2,$3,'host:wave4')`, [workspaceId, mission.missionId, workPackage.workPackageId]);
  const obligationSetId = `obligation-set:${suffix}`;
  await owner.query(`INSERT INTO rorca.governed_work_package_revisions(
    workspace_id,mission_id,work_package_id,work_package_revision,work_package_hash,mission_revision,mission_hash,story_id,
    repository_id,base_sha,allowed_path_manifest_hash,required_path_manifest_hash,validation_manifest_hash,
    authority_ceiling_hash,payload_json,proposal_id,evidence_obligation_set_id,evidence_obligation_policy_id,
    evidence_obligation_policy_revision,evidence_obligation_policy_hash,evidence_obligation_manifest_hash)
    VALUES($1,$2,$3,1,$4,1,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18,$19)`,
  [workspaceId, mission.missionId, workPackage.workPackageId, workPackage.workPackageHash, mission.missionHash,
    spec.storyId, repository.repositoryId, repository.baseSha, repository.allowedPathManifestHash,
    repository.requiredPathManifestHash, workPackage.validationObligationsHash, h('c'), JSON.stringify(workPackage),
    workPackage.proposalId, obligationSetId, mission.policy.id, mission.policy.revision, mission.policy.hash,
    fixture.evidenceManifestHash]);
  await owner.query(`INSERT INTO rorca.governed_work_package_heads(
    workspace_id,mission_id,work_package_id,current_revision,current_hash,lifecycle_state)
    VALUES($1,$2,$3,1,$4,'active')`, [workspaceId, mission.missionId, workPackage.workPackageId, workPackage.workPackageHash]);
  await owner.query(`INSERT INTO rorca.governed_evidence_obligation_sets(
    workspace_id,mission_id,work_package_id,work_package_revision,obligation_set_id,obligation_policy_id,
    obligation_policy_revision,obligation_policy_hash,manifest_hash,manifest_json,authority_receipt_hash)
    VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
  [workspaceId, mission.missionId, workPackage.workPackageId, obligationSetId, mission.policy.id,
    mission.policy.revision, mission.policy.hash, fixture.evidenceManifestHash, JSON.stringify(fixture.evidenceManifest), h('d')]);
  await owner.query(`INSERT INTO rorca.governed_evidence_obligations(
    workspace_id,mission_id,work_package_id,work_package_revision,obligation_set_id,obligation_order,
    obligation_kind,minimum_trust,required_status,obligation_hash)
    VALUES($1,$2,$3,1,$4,0,$5,$6,$7,$8)`,
  [workspaceId, mission.missionId, workPackage.workPackageId, obligationSetId,
    fixture.evidenceManifest[0]!.kind, fixture.evidenceManifest[0]!.minimumTrust,
    fixture.evidenceManifest[0]!.requiredStatus, fixture.evidenceManifest[0]!.obligationHash]);
  await owner.query(`INSERT INTO rorca.pipeline_runs(
    id,spec_path,workspace_id,status,branch_name,worktree_path,execution_workspace_path,execution_worktree_path,
    dispatch_fence,canonical_spec_revision)
    VALUES($1,$2,$3,'running','wave4-test',$4,$4,$4,$5,$6)`,
  [runId, spec.canonicalSpecPath, workspaceId, `/tmp/${workspaceId}/worktree`, h('d'), spec.specHash]);
  await owner.query(`INSERT INTO rorca.governed_execution_attempts(
    workspace_id,attempt_id,mission_id,work_package_id,work_package_revision,run_id,story_id,runtime_id,generation,
    manifest_hash,repository_id,worktree_id,spec_id,spec_version,spec_hash,story_version,story_hash,
    criteria_manifest_hash,base_sha,current_sha,expected_head_sha,allowed_path_manifest_hash,required_path_manifest_hash,
    changed_path_manifest_hash,forbidden_path_manifest_hash)
    VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10,$11,$12,1,$13,1,$14,$15,$16,$16,$16,$17,$18,$19,$20)`,
  [workspaceId, lease.attemptId, mission.missionId, workPackage.workPackageId, runId, spec.storyId, runtimeId, generation,
    h('e'), repository.repositoryId, repository.worktreeId, spec.specId, spec.specHash, spec.storyHash,
    spec.criteriaManifestHash, repository.baseSha, repository.allowedPathManifestHash, repository.requiredPathManifestHash,
    repository.changedPathManifestHash, repository.forbiddenPathManifestHash]);
  await owner.query(`INSERT INTO rorca.context_policy_definitions(
    workspace_id,policy_definition_id,policy_definition_version,policy_definition_hash,lifecycle_state,body_json,issuer_authority_ref)
    VALUES($1,$2,'1.0.0',$3,'published',$4::jsonb,'host:wave4')`,
  [workspaceId, lease.policyDefinitionId, lease.policyDefinitionHash, JSON.stringify({ posture: 'bounded_federated' })]);
  await owner.query(`INSERT INTO rorca.context_policy_activations(
    workspace_id,activation_id,activation_revision,activation_hash,policy_definition_id,policy_definition_version,
    scope_key,scope_json,effective_values_hash,authority_receipt_id,state,activated_at,expires_at)
    VALUES($1,$2,1,$3,$4,'1.0.0',$5,$6::jsonb,$7,$8,'active',$9,$10)`,
  [workspaceId, activation.activationId, activation.activationHash, activation.definitionId,
    governedHash('rorca.context-policy-activation-scope.v1', activation.scope), JSON.stringify(activation.scope),
    activation.effectiveValuesHash, activation.authorityReceiptId, activation.activatedAt, activation.expiresAt]);
  await owner.query(`INSERT INTO rorca.context_policy_activation_heads(
    workspace_id,scope_key,activation_id,current_revision,current_hash,effective_state)
    VALUES($1,$2,$3,1,$4,'active')`,
  [workspaceId, governedHash('rorca.context-policy-activation-scope.v1', activation.scope),
    activation.activationId, activation.activationHash]);
  const slotKey = h('f');
  await owner.query(`INSERT INTO rorca.execution_lease_slots(workspace_id,lease_slot_key,last_fence,active_lease_id)
    VALUES($1,$2,1,$3)`, [workspaceId, slotKey, lease.leaseId]);
  await owner.query(`INSERT INTO rorca.execution_leases(
    workspace_id,lease_id,lease_slot_key,attempt_id,fencing_token,work_package_revision,runtime_id,repository_id,
    base_sha,current_sha,worktree_id,policy_definition_hash,policy_activation_hash,checkpoint_hash,bundle_hash,
    cancellation_id,issued_at,expires_at,state,state_version,payload_hash)
    VALUES($1,$2,$3,$4,1,1,$5,$6,$7,$7,$8,$9,$10,$11,$12,$13,$14,$15,'active',1,$16)`,
  [workspaceId, lease.leaseId, slotKey, lease.attemptId, runtimeId, repository.repositoryId, repository.baseSha,
    repository.worktreeId, lease.policyDefinitionHash, lease.policyActivationHash, lease.checkpointHash,
    lease.bundleHash, lease.cancellationId, lease.issuedAt, lease.expiresAt, h('0')]);
  const scopeKey = governedHash('rorca.continuation-scope.v1', fixture.scope);
  await owner.query(`INSERT INTO rorca.context_scope_heads(
    workspace_id,scope_key,checkpoint_id,checkpoint_sequence,runtime_sequence,canonical_state_order)
    VALUES($1,$2,$3,$4,-1,-1)`,
  [workspaceId, scopeKey, fixture.checkpoint.checkpointId, fixture.checkpoint.checkpointSequence]);
  await owner.query(`INSERT INTO rorca.context_checkpoints(
    workspace_id,checkpoint_id,scope_key,checkpoint_sequence,checkpoint_hash,trigger_type,trigger_hash,
    lease_id,fencing_token,activation_hash,state,payload_json)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'current',$11::jsonb)`,
  [workspaceId, fixture.checkpoint.checkpointId, scopeKey, fixture.checkpoint.checkpointSequence,
    fixture.checkpoint.contentHash, fixture.checkpoint.trigger.type,
    governedHash('rorca.context-trigger.v1', fixture.checkpoint.trigger), lease.leaseId, lease.fencingToken,
    activation.activationHash, JSON.stringify(fixture.checkpoint)]);
  binding = FederatedLeaseBindingSchema.parse({
    workspaceId, runtimeId, missionId: mission.missionId, missionRevision: mission.missionRevision,
    missionHash: mission.missionHash, workPackageId: workPackage.workPackageId,
    workPackageRevision: workPackage.workPackageRevision, workPackageHash: workPackage.workPackageHash,
    specId: spec.specId, specVersion: spec.specVersion, specHash: spec.specHash, storyId: spec.storyId,
    storyVersion: spec.storyVersion, storyHash: spec.storyHash, criteriaManifestHash: spec.criteriaManifestHash,
    attemptId: lease.attemptId, leaseId: lease.leaseId, fencingToken: lease.fencingToken,
    expectedLeaseExpiresAt: lease.expiresAt, policyDefinitionHash: lease.policyDefinitionHash,
    policyActivationId: activation.activationId, policyActivationRevision: activation.activationRevision,
    policyActivationHash: activation.activationHash, checkpointId: fixture.checkpoint.checkpointId,
    checkpointHash: fixture.checkpoint.contentHash, retrievalReceiptId: fixture.receipt.receiptId,
    retrievalReceiptHash: fixture.receipt.contentHash, bundleId: fixture.bundle.bundleId,
    bundleHash: fixture.bundle.bundleHash, dispatchId: fixture.dispatch.dispatchId,
    dispatchHash: fixture.dispatch.contentHash, repositoryId: repository.repositoryId,
    remoteAuthorityHash: repository.remoteAuthorityHash, baseSha: repository.baseSha, currentSha: repository.currentSha,
    expectedHeadSha: repository.expectedHeadSha, worktreeId: repository.worktreeId,
    allowedPathManifestHash: repository.allowedPathManifestHash,
    requiredPathManifestHash: repository.requiredPathManifestHash,
    changedPathManifestHash: repository.changedPathManifestHash,
    forbiddenPathManifestHash: repository.forbiddenPathManifestHash,
    validationManifestHash: workPackage.validationObligationsHash,
  });
  await service.publishOffer({ offerId: `offer:${suffix}`, mission: fixture.mission, workPackage: fixture.workPackage,
    lease: fixture.lease, policyActivation: fixture.activation, checkpoint: fixture.checkpoint,
    retrievalReceipt: fixture.receipt, contextBundle: fixture.bundle, continuationDispatch: fixture.dispatch,
    worktreePath: `/tmp/${workspaceId}/worktree`, sourceCheckoutPath: `/tmp/${workspaceId}/source`,
    publishedBy: 'host:wave4', expiresAt: fixture.offerExpiresAt });
  return fixture;
}

async function wave4Snapshot(): Promise<Record<string, unknown>> {
  const result = await writerDb.query<{ snapshot: Record<string, unknown> }>(
    'SELECT rorca.wave4_test_matrix_snapshot_v1($1) snapshot', [workspaceId]);
  return result.rows[0]!.snapshot;
}

async function mutateWave4(action: string, subjectId: string, value: string): Promise<void> {
  await writerDb.query('SELECT rorca.wave4_test_matrix_mutate_v1($1,$2,$3,$4)', [action, workspaceId, subjectId, value]);
}

describe('Wave 4 one-runtime identity registry', () => {
  beforeAll(async () => {
    process.env.RORCA_FEDERATED_CREDENTIAL_PEPPER = 'wave4-test-pepper-material-at-least-thirty-two-bytes';
    const readiness = await owner.query('SELECT state,reviewed_wave3_sha,runtime_limit FROM rorca.wave4_federation_readiness WHERE singleton');
    expect(readiness.rows[0]).toMatchObject({ state: 'ready', reviewed_wave3_sha: 'a66537fc3a5607a80f6b1010ebdde238d3b6ce8f', runtime_limit: 1 });
    await owner.query('INSERT INTO rorca.workspaces(id,label,path) VALUES($1,$2,$3)',
      [workspaceId, workspaceId, `/tmp/${workspaceId}`]);
    await owner.query(`CREATE FUNCTION rorca.wave4_test_matrix_snapshot_v1(p_workspace TEXT) RETURNS JSONB
      LANGUAGE SQL SECURITY DEFINER SET search_path=pg_catalog,rorca AS $$
      SELECT jsonb_build_object(
        'offer',(SELECT to_jsonb(o) FROM rorca.federated_work_offers o WHERE o.workspace_id=p_workspace LIMIT 1),
        'claim',(SELECT to_jsonb(c) FROM rorca.federated_execution_claims c WHERE c.workspace_id=p_workspace LIMIT 1),
        'executionEvents',COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.event_id) FROM rorca.federated_execution_events e WHERE e.workspace_id=p_workspace),'[]'::jsonb),
        'results',COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM rorca.federated_result_proposals r WHERE r.workspace_id=p_workspace),'[]'::jsonb),
        'recovery',COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.recovery_id) FROM rorca.federated_recovery_decisions d WHERE d.workspace_id=p_workspace),'[]'::jsonb),
        'cancellation',(SELECT to_jsonb(d) FROM rorca.federated_cancellation_deliveries d WHERE d.workspace_id=p_workspace LIMIT 1)
      ) $$`);
    await owner.query(`CREATE FUNCTION rorca.wave4_test_matrix_mutate_v1(
      p_action TEXT,p_workspace TEXT,p_subject TEXT,p_value TEXT) RETURNS BOOLEAN
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,rorca AS $$
      BEGIN
        CASE p_action
          WHEN 'offer_raw_credential' THEN UPDATE rorca.federated_work_offers
            SET input_public_json=input_public_json||jsonb_build_object('rawCredential',p_value)
            WHERE workspace_id=p_workspace AND offer_id=p_subject;
          WHEN 'claim_state' THEN UPDATE rorca.federated_execution_claims SET state=p_value
            WHERE workspace_id=p_workspace AND claim_id=p_subject::uuid;
          WHEN 'lease_expire' THEN UPDATE rorca.execution_leases SET expires_at=issued_at+interval '1 millisecond'
            WHERE workspace_id=p_workspace AND lease_id=p_subject;
          WHEN 'lease_restore' THEN UPDATE rorca.execution_leases SET expires_at=clock_timestamp()+interval '1 hour',state='active'
            WHERE workspace_id=p_workspace AND lease_id=p_subject;
          WHEN 'cancellation_attempt' THEN UPDATE rorca.federated_cancellation_deliveries
            SET attempt_count=p_value::integer,next_attempt_at=clock_timestamp()+(p_value::integer*interval '1 second'),
              last_reason_code='runtime_unreachable' WHERE workspace_id=p_workspace AND cancellation_id=p_subject;
          WHEN 'cancellation_state' THEN UPDATE rorca.federated_cancellation_deliveries SET state=p_value
            WHERE workspace_id=p_workspace AND cancellation_id=p_subject;
          WHEN 'recovery_tamper' THEN UPDATE rorca.federated_recovery_decisions SET action=p_value
            WHERE workspace_id=p_workspace;
          ELSE RAISE EXCEPTION 'unknown test action';
        END CASE;
        RETURN TRUE;
      END $$`);
  });
  afterAll(async () => { await Promise.all([owner.end(), writerDb.end(), runtimeDb.end()]); });

  test('authenticates exact current credential while redacting restricted credential state', async () => {
    const exactRegistration = registration();
    await expect(service.registerRuntime(exactRegistration, credentialOne)).resolves.toMatchObject({ runtimeId, workspaceId, credentialVersion: 1 });
    await expect(service.registerRuntime(exactRegistration, credentialOne)).resolves.toMatchObject({ runtimeId, credentialVersion: 1 });
    await expect(service.registerRuntime({ ...exactRegistration, endpoint: 'https://changed.example.test/v1' }, credentialOne))
      .rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'second_runtime_or_changed_registration', retryable: false } });
    const authenticated = await service.authenticate({ workspaceId, runtimeId, credentialVersion: 1, keyVersion: 1, credential: credentialOne });
    expect(authenticated).toEqual(expect.objectContaining({ runtimeId, workspaceId, credentialVersion: 1, keyVersion: 1, status: 'active' }));
    expect(JSON.stringify(authenticated)).not.toMatch(/credentialDigest|credential-one|password|secret|token/i);
    await expect(loadCanonicalWave4FederationGate()).resolves.toMatchObject({
      accepted: true, runtimeLimit: 1, executionAuthority: 'execute_bounded', lifecycleDecisionAuthority: 'none',
    });
    await expect(runtimeDb.query('SELECT credential_digest FROM rorca.federated_runtime_credential_versions')).rejects.toThrow();
  });

  test('rejects unknown, cross-workspace, impersonated, and second runtime identities before disclosure', async () => {
    await expect(service.authenticate({ workspaceId, runtimeId: 'runtime:unknown', credentialVersion: 1, keyVersion: 1, credential: credentialOne })).rejects.toMatchObject({ statusCode: 401 });
    await expect(service.authenticate({ workspaceId: 'workspace:other', runtimeId, credentialVersion: 1, keyVersion: 1, credential: credentialOne })).rejects.toMatchObject({ statusCode: 401 });
    await expect(service.authenticate({ workspaceId, runtimeId, credentialVersion: 1, keyVersion: 1, credential: `${credentialOne}-wrong` })).rejects.toMatchObject({ statusCode: 401 });
    const secondCredential = `second-runtime-${suffix}-credential-at-least-thirty-two-bytes`;
    await expect(service.registerRuntime(registration(`runtime:second-${suffix}`, workspaceId, 1, 1, secondCredential), secondCredential))
      .rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'second_runtime_or_changed_registration', retryable: false } });
  });

  test('seeds every canonical offer contract and admits exactly one atomic poll/acquire winner', async () => {
    authenticatedRuntime = await service.authenticate({ workspaceId, runtimeId, credentialVersion: 1, keyVersion: 1,
      credential: credentialOne });
    offerFixture = await seedCanonicalOffer();
    const offerSnapshot = (await wave4Snapshot()).offer as {
      input_public_json: { continuationDispatch: { authorizationExpiresAt: string } };
    };
    expect(offerSnapshot.input_public_json.continuationDispatch.authorizationExpiresAt)
      .toBe(offerFixture.dispatch.authorizationExpiresAt);
    await expect(mutateWave4('offer_raw_credential', `offer:${suffix}`,
      'credential-value-must-never-persist')).rejects.toThrow();
    const discovered = await service.discover(authenticatedRuntime, {
      schemaVersion: 'rorca.federated-discovery-request.v1', workspaceId, runtimeId,
      contractVersions: ['1.0.0'], limit: 10,
    }) as { offers: Array<{ offerId: string; bindingHash: string }> };
    expect(discovered.offers).toEqual([expect.objectContaining({ offerId: `offer:${suffix}`,
      bindingHash: governedHash('rorca.federated-lease-binding.v1', binding) })]);
    const policyHead = await owner.query(`SELECT activation_id,current_revision,current_hash,effective_state
      FROM rorca.context_policy_activation_heads WHERE workspace_id=$1 AND activation_id=$2`,
    [workspaceId, binding.policyActivationId]);
    expect(policyHead.rows[0]).toMatchObject({ activation_id: binding.policyActivationId,
      current_revision: binding.policyActivationRevision, current_hash: binding.policyActivationHash,
      effective_state: 'active' });
    const baseAcquire = { schemaVersion: 'rorca.federated-acquire-request.v1', offerId: `offer:${suffix}`,
      bindingHash: discovered.offers[0]!.bindingHash, binding, generation, sessionId, sessionFileHash,
      turnId: offerFixture.scope.turnId, originatingGeneration: generation, cursor: 0, cursorHash };
    const contenders = await Promise.allSettled([
      service.acquire(authenticatedRuntime, { ...baseAcquire, idempotencyKey: `acquire:a-${suffix}` }),
      service.acquire(authenticatedRuntime, { ...baseAcquire, idempotencyKey: `acquire:b-${suffix}` }),
    ]);
    const winners = contenders.filter((result): result is PromiseFulfilledResult<Record<string, unknown>> =>
      result.status === 'fulfilled');
    if (winners.length === 0) throw new Error(JSON.stringify(contenders.find((result) => result.status === 'rejected')!.reason));
    expect(winners).toHaveLength(1);
    expect(contenders.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    claimId = String(winners[0]!.value.claimId);
    const winningKey = contenders[0]!.status === 'fulfilled' ? `acquire:a-${suffix}` : `acquire:b-${suffix}`;
    await expect(service.acquire(authenticatedRuntime, { ...baseAcquire, idempotencyKey: winningKey }))
      .resolves.toMatchObject({ claimId });
    await expect(service.discover(authenticatedRuntime, {
      schemaVersion: 'rorca.federated-discovery-request.v1', workspaceId, runtimeId,
      contractVersions: ['1.0.0'], limit: 10,
    })).resolves.toMatchObject({ offers: [] });
    const input = await service.readWorkPackage(authenticatedRuntime, {
      schemaVersion: 'rorca.federated-work-package-read-request.v1', binding, generation, sessionId,
    }) as Record<string, unknown>;
    expect(input).toMatchObject({ schemaVersion: 'rorca.federated-work-input.v1',
      mission: { schemaVersion: 'rorca.mission-contract.v1' }, workPackage: { schemaVersion: 'rorca.work-package.v1' },
      lease: { schemaVersion: 'rorca.execution-lease.v1' },
      policyActivation: { schemaVersion: 'rorca.context-continuation-policy-activation.v1' },
      checkpoint: { schemaVersion: 'rorca.context-checkpoint.v1' },
      retrievalReceipt: { schemaVersion: 'rorca.retrieval-receipt.v1' },
      contextBundle: { schemaVersion: 'rorca.context-bundle.v1' },
      continuationDispatch: { schemaVersion: 'rorca.continuation-dispatch.v1' } });
    expect(JSON.stringify(input)).not.toMatch(/contextEpoch|credentialDigest|mergeAuthority|deploymentAuthority/);
    expect((await wave4Snapshot()).claim).toMatchObject({ claim_id: claimId, state: 'active' });
    await expect(service.recover(authenticatedRuntime, {
      schemaVersion: 'rorca.federated-recovery-request.v1', binding, generation, sessionId, sessionFileHash,
      turnId: offerFixture.scope.turnId, originatingGeneration: generation, cursor: 0, cursorHash,
      bundleHash: binding.bundleHash, idempotencyKey: `recovery:${suffix}:active`,
    })).resolves.toMatchObject({ classification: 'resume_same_session_observation', action: 'observe_only',
      relaunch: false, successInferred: false });
  });


  test('runs production federated recovery conformance through authenticated TLS HTTP, the real service, and SQL', async () => {
    const priorNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const recovery = {
      schemaVersion: 'rorca.federated-recovery-request.v1', binding, generation, sessionId, sessionFileHash,
      turnId: offerFixture.scope.turnId, originatingGeneration: generation, cursor: 0, cursorHash,
      bundleHash: binding.bundleHash, idempotencyKey: `recovery:${suffix}:http-active`,
    };
    const post = (body: Record<string, unknown>, credential = credentialOne, forwardedProto?: string) => {
      let pending = request(federatedHttp).post('/api/mission-control/v1/federation/recover')
        .set('authorization', `Federated ${credential}`)
        .set('x-rorca-workspace-id', workspaceId).set('x-rorca-runtime-id', runtimeId)
        .set('x-rorca-credential-version', '1').set('x-rorca-key-version', '1');
      if (forwardedProto) pending = pending.set('x-forwarded-proto', forwardedProto);
      return pending.send(body);
    };
    try {
      const exact = await post(recovery, credentialOne, 'https');
      expect(exact.status).toBe(200);
      expect(exact.body).toMatchObject({ classification: 'resume_same_session_observation', action: 'observe_only',
        relaunch: false, successInferred: false });
      const replay = await post(recovery, credentialOne, 'https');
      expect(replay.status).toBe(200);
      expect(replay.body).toMatchObject({ classification: 'resume_same_session_observation', action: 'observe_only' });
      expect((await post(recovery, `${credentialOne}-wrong`, 'https')).status).toBe(401);
      expect((await post(recovery)).status).toBe(401);
      const faults: Array<(input: typeof recovery) => typeof recovery> = [
        (input) => ({ ...input, generation: input.generation + 1 }),
        (input) => ({ ...input, sessionId: `${input.sessionId}:stale` }),
        (input) => ({ ...input, sessionFileHash: h('0') }),
        (input) => ({ ...input, turnId: `${input.turnId}:stale` }),
        (input) => ({ ...input, originatingGeneration: input.originatingGeneration + 1 }),
        (input) => ({ ...input, cursor: input.cursor + 1 }),
        (input) => ({ ...input, cursorHash: h('0') }),
        (input) => ({ ...input, bundleHash: h('0') }),
        (input) => ({ ...input, binding: { ...input.binding, currentSha: '0'.repeat(40) } }),
        (input) => ({ ...input, binding: { ...input.binding, policyActivationHash: h('0') } }),
      ];
      for (const [index, mutate] of faults.entries()) {
        const response = await post({ ...mutate(recovery),
          idempotencyKey: `recovery:${suffix}:http-fault-${index}` }, credentialOne, 'https');
        expect([404, 409]).toContain(response.status);
      }
    } finally {
      process.env.NODE_ENV = priorNodeEnv;
    }
  });

  test('ingests Wave 2 events and Wave 3B activity across partial, reconnect, replay, ordering, flood, secret, and restart cases', async () => {
    const now = new Date().toISOString();
    const event = RuntimeEventV1Schema.parse({
      schemaVersion: 'rorca.execution-event.v1', contractId: 'rorca.execution-event.v1', contractVersion: '1.0.0',
      artifactId: `event-artifact:${suffix}:0`, contentHash: h('1'), createdAt: now, createdBy: runtimeId,
      eventId: `event:${suffix}:0`, idempotencyKey: h('2'), scope: offerFixture.scope, eventType: 'attempt_started',
      runtimeSequence: 0, canonicalStateOrder: 0, hostReceiptOrder: 0, observedAt: now, receivedAt: now,
      databaseTime: now, observerClass: 'runtime', trustClass: 'runtime_asserted',
      checkpointId: offerFixture.checkpoint.checkpointId, checkpointHash: offerFixture.checkpoint.contentHash,
      retrievalReceiptId: offerFixture.receipt.receiptId, retrievalReceiptHash: offerFixture.receipt.contentHash,
      contextBundleId: offerFixture.bundle.bundleId, contextBundleHash: offerFixture.bundle.contentHash,
      continuationDispatchId: offerFixture.dispatch.dispatchId, continuationDispatchHash: offerFixture.dispatch.contentHash,
      compaction: null, retryPhase: null, completionCandidate: null, stateOrderLinkHash: null, payloadHash: h('3'),
      reasonCode: 'attempt_started', count: 1, durationMs: 0, redactionClass: 'none', restrictedRef: null,
      originatingEventHash: null,
    });
    const eventRequest = (candidate: unknown, idempotencyKey: string) => ({
      schemaVersion: 'rorca.federated-event-request.v1', binding, event: candidate, idempotencyKey,
    });
    await expect(service.ingestEvent(authenticatedRuntime, eventRequest(event, `event-ingest:${suffix}:0`)))
      .resolves.toMatchObject({ duplicate: false, canonicalStateOrder: 0, hostReceiptOrder: 0 });
    await expect(service.ingestEvent(authenticatedRuntime, eventRequest(event, `event-ingest:${suffix}:0`)))
      .resolves.toMatchObject({ duplicate: true, canonicalStateOrder: 0 });
    const changedIdempotencyEvent = RuntimeEventV1Schema.parse({ ...event,
      artifactId: `event-artifact:${suffix}:changed-key`, eventId: `event:${suffix}:changed-key`, contentHash: h('3') });
    await expect(service.ingestEvent(authenticatedRuntime,
      eventRequest(changedIdempotencyEvent, `event-ingest:${suffix}:0`))).rejects.toMatchObject({
      code: 'CONFLICT', details: { reason: 'changed_idempotency_replay', retryable: false },
    });
    await expect(service.ingestEvent(authenticatedRuntime, eventRequest(event, `event-ingest:${suffix}:duplicate`)))
      .resolves.toMatchObject({ duplicate: true, canonicalStateOrder: 0 });
    const gapEvent = RuntimeEventV1Schema.parse({ ...event, artifactId: `event-artifact:${suffix}:gap`,
      eventId: `event:${suffix}:gap`, runtimeSequence: 2, contentHash: h('4') });
    await expect(service.ingestEvent(authenticatedRuntime, eventRequest(gapEvent, `event-ingest:${suffix}:gap`)))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    const restartedService = new FederatedRuntimeService(gate, new FederatedHostVerifier({
      loadWorktree: async () => null, verifyValidation: async () => false, verifyArtifact: async () => false,
    }));
    const secondEvent = RuntimeEventV1Schema.parse({ ...event, artifactId: `event-artifact:${suffix}:1`,
      eventId: `event:${suffix}:1`, runtimeSequence: 1, contentHash: h('5') });
    await expect(restartedService.ingestEvent(authenticatedRuntime,
      eventRequest(secondEvent, `event-ingest:${suffix}:restart`))).resolves.toMatchObject({
      duplicate: false, canonicalStateOrder: 1, hostReceiptOrder: 1,
    });

    const observation = (sequence: number, id: string, reasonCode = `activity:${id}`): RuntimeNeutralObservationV1 =>
      RuntimeNeutralObservationV1Schema.parse({
        eventId: `activity-event:${suffix}:${id}`, streamId: `stream:${suffix}`, scope: offerFixture.scope,
        source: { store: 'fake_federated_runtime', recordId: `activity-source:${suffix}:${id}`, recordRevision: 1,
          recordHash: governedHash('rorca.wave4-activity-source.v1', { id }), sourceSequence: sequence },
        observedAt: now, kind: 'activity_observed', plane: 'activity',
        payload: { activityType: 'federated:runtime', reasonCode, count: 1, durationMs: 1, referenceHash: h('6'),
          establishesStoryCompletion: false }, redactionClass: 'none', restrictedRef: null, orderingMode: 'live_projection',
      });
    const batch = (batchId: string, firstSourceSequence: number, events: RuntimeNeutralObservationV1[]) => {
      const unsigned = RuntimeTelemetryBatchV1Schema.parse({
        schemaVersion: 'rorca.runtime-telemetry-batch.v1', contractVersion: '1.0.0', batchId, batchHash: h('0'),
        workspaceId, runtimeId, attemptId: binding.attemptId, leaseId: binding.leaseId,
        fencingToken: binding.fencingToken, runtimeGeneration: generation, firstSourceSequence, events,
        compressedBytes: 100, uncompressedBytes: 200,
      });
      return RuntimeTelemetryBatchV1Schema.parse({ ...unsigned, batchHash: runtimeTelemetryBatchIntegrityHash(unsigned) });
    };
    const duplicateEventId = { ...observation(1, 'partial-second'), eventId: `activity-event:${suffix}:partial-first` };
    const partial = batch(`batch:${suffix}:partial`, 0, [observation(0, 'partial-first'), duplicateEventId]);
    await expect(service.ingestActivity(authenticatedRuntime, {
      schemaVersion: 'rorca.federated-activity-request.v1', binding, batch: partial,
      idempotencyKey: `activity:${suffix}:partial`,
    })).rejects.toThrow();
    expect((await owner.query(`SELECT count(*)::int count FROM rorca.run_activity_events
      WHERE workspace_id=$1`, [workspaceId])).rows[0].count).toBe(0);
    const firstBatch = batch(`batch:${suffix}:0`, 0, [observation(0, '0')]);
    const firstReceipt = await service.ingestActivity(authenticatedRuntime, {
      schemaVersion: 'rorca.federated-activity-request.v1', binding, batch: firstBatch,
      idempotencyKey: `activity:${suffix}:0`,
    });
    expect(firstReceipt).toMatchObject({ duplicate: false, eventCount: 1, observabilityOnly: true,
      evidenceAuthority: 'none', closeoutAuthority: 'none', lifecycleAuthority: 'none' });
    await expect(service.ingestActivity(authenticatedRuntime, {
      schemaVersion: 'rorca.federated-activity-request.v1', binding, batch: firstBatch,
      idempotencyKey: `activity:${suffix}:0-reconnect`,
    })).resolves.toMatchObject({ duplicate: true, eventCount: 1 });
    const gapBatch = batch(`batch:${suffix}:gap`, 2, [observation(2, 'gap')]);
    await expect(service.ingestActivity(authenticatedRuntime, {
      schemaVersion: 'rorca.federated-activity-request.v1', binding, batch: gapBatch,
      idempotencyKey: `activity:${suffix}:gap`,
    })).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'source_sequence_gap_or_regression', retryable: false } });
    const reconnectBatch = batch(`batch:${suffix}:1`, 1, [observation(1, '1')]);
    await expect(restartedService.ingestActivity(authenticatedRuntime, {
      schemaVersion: 'rorca.federated-activity-request.v1', binding, batch: reconnectBatch,
      idempotencyKey: `activity:${suffix}:restart`,
    })).resolves.toMatchObject({ duplicate: false, eventCount: 1 });
    const changedReplay = batch(`batch:${suffix}:1`, 2, [observation(2, 'changed-replay')]);
    await expect(service.ingestActivity(authenticatedRuntime, {
      schemaVersion: 'rorca.federated-activity-request.v1', binding, batch: changedReplay,
      idempotencyKey: `activity:${suffix}:changed-replay`,
    })).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'changed_batch_replay', retryable: false } });
    const floodEvents = Array.from({ length: 501 }, (_, index) => observation(index + 2, `flood-${index}`));
    await expect(service.ingestActivity(authenticatedRuntime, {
      schemaVersion: 'rorca.federated-activity-request.v1', binding,
      batch: { ...firstBatch, batchId: `batch:${suffix}:flood`, firstSourceSequence: 2, events: floodEvents },
      idempotencyKey: `activity:${suffix}:flood`,
    })).rejects.toMatchObject({ name: 'ZodError' });
    const canary = 'Bearer abcdefghijklmnopqrstuvwxyz';
    const secretEvent = observation(2, 'secret');
    await expect(restartedService.ingestActivity(authenticatedRuntime, {
      schemaVersion: 'rorca.federated-activity-request.v1', binding,
      batch: { ...firstBatch, batchId: `batch:${suffix}:secret`, firstSourceSequence: 2,
        events: [{ ...secretEvent, payload: { ...(secretEvent.payload as Record<string, unknown>), reasonCode: canary } }] },
      idempotencyKey: `activity:${suffix}:secret`,
    })).rejects.toMatchObject({ name: 'ZodError' });
  });


  test('serializes renewal and fails both renewal/release closed across an expiry race', async () => {
    const renew = (expectedStateVersion: number, idempotencyKey: string) => service.renew(authenticatedRuntime, {
      schemaVersion: 'rorca.federated-renew-request.v1', binding, generation, sessionId, expectedStateVersion,
      extendSeconds: 60, idempotencyKey,
    });
    const renewalRace = await Promise.allSettled([
      renew(1, `renew:${suffix}:a`), renew(1, `renew:${suffix}:b`),
    ]);
    expect(renewalRace.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(renewalRace.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    const stateVersion = Number((await owner.query<{ state_version: string }>(`SELECT state_version FROM rorca.execution_leases
      WHERE workspace_id=$1 AND lease_id=$2`, [workspaceId, binding.leaseId])).rows[0]!.state_version);
    await owner.query(`UPDATE rorca.execution_leases SET expires_at=issued_at+interval '1 millisecond'
      WHERE workspace_id=$1 AND lease_id=$2`, [workspaceId, binding.leaseId]);
    const expiredRace = await Promise.allSettled([
      renew(stateVersion, `renew:${suffix}:expired`),
      service.release(authenticatedRuntime, { schemaVersion: 'rorca.federated-release-request.v1', binding,
        generation, sessionId, expectedStateVersion: stateVersion, reasonCode: 'expired_race',
        idempotencyKey: `release:${suffix}:expired` }),
    ]);
    expect(expiredRace.every(({ status }) => status === 'rejected')).toBe(true);
    await owner.query(`UPDATE rorca.execution_leases SET expires_at=$3,state='active'
      WHERE workspace_id=$1 AND lease_id=$2`, [workspaceId, binding.leaseId, new Date(Date.now() + 60 * 60 * 1000)]);
    const audit = await owner.query<{ event_type: string }>(`SELECT event_type FROM rorca.execution_lease_events
      WHERE workspace_id=$1 AND lease_id=$2 ORDER BY id`, [workspaceId, binding.leaseId]);
    expect(audit.rows.map(({ event_type }) => event_type)).toContain('renewed');
  });
  test('keeps accepted, rejected, stale, and replayed plan changes proposal-only', async () => {
    const now = new Date().toISOString();
    const proposal = {
      schemaVersion: 'rorca.plan-change-proposal.v1', contractId: 'rorca.plan-change-proposal.v1',
      contractVersion: '1.0.0', artifactId: `artifact:plan-${suffix}:accepted`, contentHash: h('7'), createdAt: now,
      createdBy: runtimeId, workspaceId, missionId: binding.missionId, workPackageId: binding.workPackageId,
      attemptId: binding.attemptId, leaseId: binding.leaseId, fencingToken: binding.fencingToken,
      policyActivationHash: binding.policyActivationHash, baseRevision: binding.workPackageRevision,
      baseHash: binding.workPackageHash, proposalId: `plan:${suffix}:accepted`, diffHash: h('8'),
      rationale: 'Narrow bounded implementation correction', impactHash: h('9'), requestedPaths: ['backend/src'],
      dependencyManifestHash: h('a'), validationManifestHash: binding.validationManifestHash,
      proposerRuntimeId: runtimeId, requestsMergeAuthority: false as const, requestsDeploymentAuthority: false as const,
      state: 'proposed' as const,
    };
    const headBefore = (await owner.query<{ state_version: string }>(`SELECT state_version FROM rorca.governed_work_package_heads
      WHERE workspace_id=$1 AND mission_id=$2 AND work_package_id=$3`,
    [workspaceId, binding.missionId, binding.workPackageId])).rows[0]!.state_version;
    const submitted = await service.proposePlanChange(authenticatedRuntime, {
      schemaVersion: 'rorca.federated-plan-change-request.v1', binding, proposal, generation, sessionId,
      exactDiffHash: proposal.diffHash, contextChangesHash: h('b'), idempotencyKey: `plan:${suffix}:accepted`,
    });
    expect(submitted.value).toMatchObject({ canonicalMutationPerformed: false, state: 'proposed' });
    await expect(service.proposePlanChange(authenticatedRuntime, {
      schemaVersion: 'rorca.federated-plan-change-request.v1', binding, proposal, generation, sessionId,
      exactDiffHash: proposal.diffHash, contextChangesHash: h('b'), idempotencyKey: `plan:${suffix}:accepted`,
    })).resolves.toMatchObject({ duplicate: true });
    const reviewContext = { principalId: 'reviewer:wave4', authoritySource: 'local_admin' as const,
      correlationId: `review:${suffix}`, idempotencyKey: `review:${suffix}:accepted-1` };
    await reviewPlanChangeProposal({ workspaceId, proposalId: proposal.proposalId, expectedStateVersion: 1,
      decision: 'under_review', reasonCode: 'review_started' }, reviewContext);
    await expect(reviewPlanChangeProposal({ workspaceId, proposalId: proposal.proposalId, expectedStateVersion: 2,
      decision: 'accepted', reasonCode: 'bounded_change_accepted' },
    { ...reviewContext, idempotencyKey: `review:${suffix}:accepted-2` })).resolves.toMatchObject({
      value: { state: 'accepted', canonicalMutationPerformed: false },
    });
    const rejectedProposal = { ...proposal, artifactId: `artifact:plan-${suffix}:rejected`,
      proposalId: `plan:${suffix}:rejected`, contentHash: h('c'), diffHash: h('d') };
    await service.proposePlanChange(authenticatedRuntime, {
      schemaVersion: 'rorca.federated-plan-change-request.v1', binding, proposal: rejectedProposal, generation, sessionId,
      exactDiffHash: rejectedProposal.diffHash, contextChangesHash: h('e'), idempotencyKey: `plan:${suffix}:rejected`,
    });
    await expect(reviewPlanChangeProposal({ workspaceId, proposalId: rejectedProposal.proposalId, expectedStateVersion: 1,
      decision: 'rejected', reasonCode: 'review_rejected' },
    { ...reviewContext, idempotencyKey: `review:${suffix}:rejected` })).resolves.toMatchObject({
      value: { state: 'rejected', canonicalMutationPerformed: false },
    });
    await expect(service.proposePlanChange(authenticatedRuntime, {
      schemaVersion: 'rorca.federated-plan-change-request.v1', binding,
      proposal: { ...proposal, artifactId: `artifact:plan-${suffix}:stale`, proposalId: `plan:${suffix}:stale`,
        baseRevision: binding.workPackageRevision + 1 }, generation, sessionId, exactDiffHash: proposal.diffHash,
      contextChangesHash: h('f'), idempotencyKey: `plan:${suffix}:stale`,
    })).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'scope_expansion', retryable: false } });
    expect((await owner.query<{ state_version: string }>(`SELECT state_version FROM rorca.governed_work_package_heads
      WHERE workspace_id=$1 AND mission_id=$2 AND work_package_id=$3`,
    [workspaceId, binding.missionId, binding.workPackageId])).rows[0]!.state_version).toBe(headBefore);
  });

  test('passes a federated proposal through host evidence and the shared closeout resolver without a completion shortcut', async () => {
    const now = new Date().toISOString();
    const validation = { validationId: `validation:${suffix}`, commandHash: h('1'), claimedOutcome: 'passed' as const,
      artifactHash: h('2'), observedAt: now };
    const artifact = { artifactId: `artifact:result-${suffix}`, contentHash: h('3'), byteLength: 64,
      restrictedReferenceId: `restricted:result-${suffix}` };
    const validationSetHash = governedHash('rorca.federated-host-validations.v1',
      [{ validationId: validation.validationId, commandHash: validation.commandHash, artifactHash: validation.artifactHash }]);
    const artifactSetHash = governedHash('rorca.federated-host-artifacts.v1', [artifact]);
    const host: FederatedHostVerification = { schemaVersion: 'rorca.federated-host-verification.v1', verified: true,
      repositoryId: binding.repositoryId, baseSha: binding.baseSha, headSha: binding.expectedHeadSha,
      worktreeId: binding.worktreeId, changedPaths: ['backend/src'], changedPathHash: binding.changedPathManifestHash,
      gitObservationHash: h('4'), validationObservationHash: validationSetHash, artifactObservationHash: artifactSetHash,
      observedAt: now, runtimeClaimsTrust: 'runtime_asserted', hostEvidenceTrust: 'host_observed', closeoutAuthority: 'none' };
    const verifyHost = jest.fn().mockResolvedValue(host);
    const resultService = new FederatedRuntimeService(gate, {
      verify: verifyHost,
    } as unknown as FederatedHostVerifier);
    const proposal: FederatedResultProposal = {
      schemaVersion: 'rorca.federated-result-proposal.v1', contractVersion: '1.0.0',
      proposalId: `result:${suffix}`, binding, generation, sessionId, terminalSequence: 2,
      completionCandidateState: 'controller_validated', completionCandidateHash: h('5'),
      changedPaths: ['backend/src'], changedPathHash: binding.changedPathManifestHash, validations: [validation],
      validationSetHash, artifacts: [artifact], artifactSetHash, outcomeClaim: 'failed',
      observedHeadSha: binding.expectedHeadSha, submittedAt: now, idempotencyKey: `result:${suffix}`,
      closeoutAuthority: 'none', lifecycleAuthority: 'none', mergeAuthority: 'none', deploymentAuthority: 'none',
    };
    const receipt = await resultService.proposeResult(authenticatedRuntime, proposal);
    expect(receipt).toMatchObject({ proposalId: proposal.proposalId, duplicate: false,
      closeoutPosture: 'shared_canonical_resolver_pending', acceptedAsCompletion: false, lifecycleAuthority: 'none',
      mergeAuthority: 'none', deploymentAuthority: 'none' });
    await expect(resultService.proposeResult(authenticatedRuntime, proposal)).resolves.toMatchObject({
      duplicate: true, acceptedAsCompletion: false,
    });
    expect(verifyHost).toHaveBeenCalledTimes(1);
    await expect(resultService.proposeResult(authenticatedRuntime, { ...proposal, outcomeClaim: 'cancelled' }))
      .rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'changed_result_replay', retryable: false } });
    expect(verifyHost).toHaveBeenCalledTimes(1);
    const persisted = ((await wave4Snapshot()).results as Array<{
      proposal_json: FederatedResultProposal; host_verification_json: FederatedHostVerification;
    }>)[0];
    expect(persisted).toMatchObject({
      proposal_json: { outcomeClaim: 'failed', closeoutAuthority: 'none', lifecycleAuthority: 'none' },
      host_verification_json: { runtimeClaimsTrust: 'runtime_asserted', hostEvidenceTrust: 'host_observed',
        closeoutAuthority: 'none' },
    });
    const evidence = await owner.query<{ trust_level: string; evidence_status: string; governed_contract_hash: string }>(
      `SELECT trust_level,evidence_status,governed_contract_hash FROM rorca.ssdlc_lifecycle_evidence
       WHERE workspace_id=$1 AND source_system='governed-mission' AND source_idempotency_key=$2`,
    [workspaceId, `evidence:${proposal.proposalId}`]);
    expect(evidence.rows[0]).toMatchObject({ trust_level: 'host_observed', evidence_status: 'passed',
      governed_contract_hash: receipt.evidenceHash });
    const evaluation = {
      schemaVersion: 'rorca.closeout-evaluation.v1', contractId: 'rorca.closeout-evaluation.v1',
      contractVersion: '1.0.0', artifactId: `artifact:closeout-${suffix}`, contentHash: h('6'), createdAt: now,
      createdBy: 'resolver:shared', evaluationId: `evaluation:${suffix}`, workspaceId, missionId: binding.missionId,
      missionRevision: binding.missionRevision, workPackageId: binding.workPackageId,
      workPackageRevision: binding.workPackageRevision, specHash: binding.specHash, storyHash: binding.storyHash,
      attemptId: binding.attemptId, leaseId: binding.leaseId, fencingToken: binding.fencingToken,
      policyActivationHash: binding.policyActivationHash, checkpointHash: binding.checkpointHash,
      repositoryRevision: binding.currentSha, worktreeId: binding.worktreeId,
      evidence: [{ evidenceId: `evidence:${proposal.proposalId}`, evidenceHash: receipt.evidenceHash }],
      obligationSetId: `obligation-set:${suffix}`, obligationSetHash: offerFixture.evidenceManifestHash,
      policyVersion: String(offerFixture.mission.policy.revision), resolverVersion: '1.0.0', outcome: 'eligible' as const,
      missingEvidenceKinds: [], conflictingEvidenceIds: [], decisionTime: now, storyCloseoutDecisionId: null,
      establishesStoryCompletion: false as const,
    };
    await expect(evaluateGovernedCloseout(evaluation, { principalId: 'resolver:shared', authoritySource: 'local_admin',
      correlationId: `closeout:${suffix}`, idempotencyKey: `closeout:${suffix}` })).resolves.toMatchObject({
      value: { outcome: 'eligible', establishesStoryCompletion: false, storyCloseoutDecisionId: null },
    });
  });

  test('replays canonical SQL recovery after a result without relaunch or mutable audit', async () => {
    const recovery = {
      schemaVersion: 'rorca.federated-recovery-request.v1', binding, generation, sessionId, sessionFileHash,
      turnId: offerFixture.scope.turnId, originatingGeneration: generation, cursor: 0, cursorHash,
      bundleHash: binding.bundleHash, idempotencyKey: `recovery:${suffix}:after-result`,
    };
    await expect(service.recover(authenticatedRuntime, recovery)).resolves.toMatchObject({
      classification: 'resume_shared_closeout', action: 'enqueue_closeout', relaunch: false, successInferred: false,
    });
    await expect(service.recover(authenticatedRuntime, recovery)).resolves.toMatchObject({
      classification: 'resume_shared_closeout', action: 'enqueue_closeout',
    });
    await expect(service.recover(authenticatedRuntime, { ...recovery, sessionFileHash: h('0'),
      idempotencyKey: `recovery:${suffix}:wrong-session-file` })).rejects.toMatchObject({
      code: 'CONFLICT', details: { reason: 'recovery_identity_mismatch', retryable: false },
    });
    await expect(service.recover(authenticatedRuntime, { ...recovery, turnId: `turn:changed-${suffix}`,
      idempotencyKey: `recovery:${suffix}:wrong-turn` })).rejects.toMatchObject({
      code: 'CONFLICT', details: { reason: 'recovery_identity_mismatch', retryable: false },
    });
    await expect(service.recover(authenticatedRuntime, { ...recovery, cursor: 1,
      idempotencyKey: `recovery:${suffix}:wrong-cursor` })).rejects.toMatchObject({
      code: 'CONFLICT', details: { reason: 'recovery_identity_mismatch', retryable: false },
    });
    const decisions = (await wave4Snapshot()).recovery as Array<{ classification: string }>;
    expect(decisions.map(({ classification }) => classification)).toContain('resume_shared_closeout');
    await expect(mutateWave4('recovery_tamper', claimId, 'none')).rejects.toThrow();
  });

  test('persists bounded cancellation backoff, accepted/duplicate ack, expiry posture, restart, and late-write rejection', async () => {
    const requestedAt = new Date();
    const cancellation = {
      schemaVersion: 'rorca.cancellation.v1', contractId: 'rorca.cancellation.v1', contractVersion: '1.0.0',
      artifactId: `artifact:cancellation-${suffix}`, contentHash: h('7'), createdAt: requestedAt.toISOString(),
      createdBy: 'host:wave4', workspaceId, cancellationId: offerFixture.lease.cancellationId,
      requesterAuthorityRef: 'host:wave4', reasonCode: 'runtime_unreachable', attemptId: binding.attemptId,
      leaseId: binding.leaseId, fencingToken: binding.fencingToken, requestedAt: requestedAt.toISOString(),
      deadlineAt: new Date(requestedAt.getTime() + 60_000).toISOString(), acknowledgementId: null,
      acknowledgedAt: null, disposition: 'requested' as const,
    };
    await expect(requestExecutionCancellation(cancellation, { principalId: 'host:wave4', authoritySource: 'local_admin',
      correlationId: `cancel:${suffix}`, idempotencyKey: `cancel:${suffix}` })).resolves.toMatchObject({
      value: { leaseAuthorityRevoked: true },
    });
    expect((await wave4Snapshot()).cancellation).toMatchObject({ state: 'pending', attempt_count: 0 });
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await mutateWave4('cancellation_attempt', cancellation.cancellationId, String(attempt));
    }
    await expect(mutateWave4('cancellation_attempt', cancellation.cancellationId, '6')).rejects.toThrow();
    await mutateWave4('cancellation_state', cancellation.cancellationId, 'expired');
    expect((await wave4Snapshot()).cancellation).toMatchObject({ state: 'expired', attempt_count: 5 });
    await mutateWave4('cancellation_state', cancellation.cancellationId, 'pending');
    const acknowledgement = { ...cancellation, artifactId: `artifact:cancellation-ack-${suffix}`,
      contentHash: h('8'), createdBy: runtimeId, acknowledgementId: `ack:${suffix}`,
      acknowledgedAt: new Date().toISOString(), disposition: 'acknowledged' as const };
    const ackRequest = { schemaVersion: 'rorca.federated-cancellation-acknowledgement.v1', binding,
      cancellation: acknowledgement, generation, sessionId, idempotencyKey: `cancel-ack:${suffix}` };
    await expect(service.acknowledgeCancellation(authenticatedRuntime, ackRequest)).resolves.toMatchObject({
      duplicate: false, value: { classification: 'accepted', acknowledged: true, requestRowImmutable: true },
    });
    await expect(service.acknowledgeCancellation(authenticatedRuntime, ackRequest)).resolves.toMatchObject({
      duplicate: true, value: { classification: 'accepted', acknowledged: true },
    });
    const restartedService = new FederatedRuntimeService(gate, new FederatedHostVerifier({
      loadWorktree: async () => null, verifyValidation: async () => false, verifyArtifact: async () => false,
    }));
    await expect(restartedService.acknowledgeCancellation(authenticatedRuntime, ackRequest)).resolves.toMatchObject({
      duplicate: true, value: { classification: 'accepted' },
    });
    expect((await wave4Snapshot()).cancellation).toMatchObject({ state: 'acknowledged', attempt_count: 5 });
    const lateValidation = { validationId: `validation:late-${suffix}`, commandHash: h('9'),
      claimedOutcome: 'passed' as const, artifactHash: h('a'), observedAt: new Date().toISOString() };
    const lateArtifact = { artifactId: `artifact:late-${suffix}`, contentHash: h('b'), byteLength: 1,
      restrictedReferenceId: `restricted:late-${suffix}` };
    const lateResult: FederatedResultProposal = {
      schemaVersion: 'rorca.federated-result-proposal.v1', contractVersion: '1.0.0', proposalId: `result:late-${suffix}`,
      binding, generation, sessionId, terminalSequence: 3, completionCandidateState: 'controller_validated',
      completionCandidateHash: h('c'), changedPaths: ['backend/src'], changedPathHash: binding.changedPathManifestHash,
      validations: [lateValidation], validationSetHash: governedHash('rorca.federated-host-validations.v1',
        [{ validationId: lateValidation.validationId, commandHash: lateValidation.commandHash,
          artifactHash: lateValidation.artifactHash }]),
      artifacts: [lateArtifact], artifactSetHash: governedHash('rorca.federated-host-artifacts.v1', [lateArtifact]),
      outcomeClaim: 'succeeded', observedHeadSha: binding.expectedHeadSha, submittedAt: new Date().toISOString(),
      idempotencyKey: `result:late-${suffix}`, closeoutAuthority: 'none', lifecycleAuthority: 'none',
      mergeAuthority: 'none', deploymentAuthority: 'none',
    };
    await expect(service.proposeResult(authenticatedRuntime, lateResult)).rejects.toMatchObject({
      code: 'CONFLICT', details: { reason: 'lease_expired_cancelled_or_fenced', retryable: false },
    });
    const lateEvent = RuntimeEventV1Schema.parse({
      schemaVersion: 'rorca.execution-event.v1', contractId: 'rorca.execution-event.v1', contractVersion: '1.0.0',
      artifactId: `event-artifact:${suffix}:late`, contentHash: h('d'), createdAt: new Date().toISOString(),
      createdBy: runtimeId, eventId: `event:${suffix}:late`, idempotencyKey: h('e'), scope: offerFixture.scope,
      eventType: 'attempt_result_observed', runtimeSequence: 2, canonicalStateOrder: 2, hostReceiptOrder: 2,
      observedAt: new Date().toISOString(), receivedAt: new Date().toISOString(), databaseTime: new Date().toISOString(),
      observerClass: 'runtime', trustClass: 'runtime_asserted', checkpointId: binding.checkpointId,
      checkpointHash: binding.checkpointHash, retrievalReceiptId: binding.retrievalReceiptId,
      retrievalReceiptHash: binding.retrievalReceiptHash, contextBundleId: binding.bundleId,
      contextBundleHash: binding.bundleHash, continuationDispatchId: binding.dispatchId,
      continuationDispatchHash: binding.dispatchHash, compaction: null, retryPhase: null, completionCandidate: null,
      stateOrderLinkHash: null, payloadHash: h('f'), reasonCode: 'late_after_cancel', count: 1, durationMs: 0,
      redactionClass: 'none', restrictedRef: null, originatingEventHash: null,
    });
    await expect(service.ingestEvent(authenticatedRuntime, {
      schemaVersion: 'rorca.federated-event-request.v1', binding, event: lateEvent,
      idempotencyKey: `event-ingest:${suffix}:late`,
    })).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'lease_expired_cancelled_or_fenced', retryable: false } });
    expect((await wave4Snapshot()).results).toHaveLength(1);
  });
  test('fails every federated mutation closed after the exact policy activation is no longer active', async () => {
    await owner.query(`UPDATE rorca.context_policy_activation_heads SET effective_state='rejected'
      WHERE workspace_id=$1 AND activation_id=$2`, [workspaceId, binding.policyActivationId]);
    await expect(service.renew(authenticatedRuntime, {
      schemaVersion: 'rorca.federated-renew-request.v1', binding, generation, sessionId,
      expectedStateVersion: 1, extendSeconds: 30, idempotencyKey: `renew:${suffix}:inactive-policy`,
    })).rejects.toMatchObject({
      code: 'CONFLICT', details: { reason: 'policy_activation_inactive', retryable: false },
    });
    await expect(service.recover(authenticatedRuntime, {
      schemaVersion: 'rorca.federated-recovery-request.v1', binding, generation, sessionId, sessionFileHash,
      turnId: offerFixture.scope.turnId, originatingGeneration: generation, cursor: 0, cursorHash,
      bundleHash: binding.bundleHash, idempotencyKey: `recovery:${suffix}:inactive-policy`,
    })).rejects.toMatchObject({
      code: 'CONFLICT', details: { reason: 'policy_activation_inactive', retryable: false },
    });
    await expect(service.recover(authenticatedRuntime, {
      schemaVersion: 'rorca.federated-recovery-request.v1', binding, generation, sessionId, sessionFileHash,
      turnId: offerFixture.scope.turnId, originatingGeneration: generation, cursor: 0, cursorHash,
      bundleHash: binding.bundleHash, idempotencyKey: `recovery:${suffix}:active`,
    })).rejects.toMatchObject({
      code: 'CONFLICT', details: { reason: 'policy_activation_inactive', retryable: false },
    });
  });

  test('rotates without rewriting history, rejects old credential, and revokes current credential', async () => {
    const expiresAt = new Date(Date.now() + 7_200_000).toISOString();
    const exactRotation = { workspaceId, runtimeId, priorCredentialVersion: 1, credentialVersion: 2,
      keyVersion: 2, credential: credentialTwo, expiresAt, auditProvenanceHash: h('4'), idempotencyKey: 'rotate:two' };
    await expect(service.rotateRuntimeCredential(exactRotation)).resolves.toEqual({ credentialVersion: 2, keyVersion: 2 });
    await expect(service.rotateRuntimeCredential(exactRotation)).resolves.toEqual({ credentialVersion: 2, keyVersion: 2 });
    await expect(service.rotateRuntimeCredential({ ...exactRotation, credential: `${credentialTwo}-changed` }))
      .rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'credential_replay_conflict', retryable: false } });
    await expect(service.authenticate({ workspaceId, runtimeId, credentialVersion: 1, keyVersion: 1, credential: credentialOne }))
      .rejects.toMatchObject({ statusCode: 401 });
    await expect(service.authenticate({ workspaceId, runtimeId, credentialVersion: 2, keyVersion: 2, credential: credentialTwo }))
      .resolves.toMatchObject({ credentialVersion: 2, keyVersion: 2 });
    const immutable = await owner.query(`SELECT tgname FROM pg_trigger
      WHERE tgrelid='rorca.federated_runtime_credential_versions'::regclass AND tgname='federated_runtime_credential_versions_immutable'`);
    expect(immutable.rowCount).toBe(1);
    const exactRevocation = { workspaceId, runtimeId, expectedCredentialVersion: 2, reasonCode: 'pilot_revoked',
      provenanceHash: h('5'), idempotencyKey: 'revoke:two' };
    await service.revokeRuntime(exactRevocation);
    await service.revokeRuntime(exactRevocation);
    await expect(service.revokeRuntime({ ...exactRevocation, reasonCode: 'changed_reason' }))
      .rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'revocation_replay_conflict', retryable: false } });
    await expect(service.authenticate({ workspaceId, runtimeId, credentialVersion: 2, keyVersion: 2, credential: credentialTwo }))
      .rejects.toMatchObject({ statusCode: 401 });
  });
});
