/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { randomUUID } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import {
  ContextBundleV1Schema, ContextCheckpointV1Schema, ContextPolicyActivationV1Schema, ContinuationDispatchV1Schema,
  ExecutionLeaseV1Schema, MissionContractV1Schema, RetrievalReceiptV1Schema, WorkPackageV1Schema, governedHash,
} from '../governed-contracts';
import { FederatedHostVerifier, type FederatedHostVerification } from '../federated-host-verifier';
import { FederatedRuntimeService, federatedCredentialDigest } from '../federated-runtime-service';
import { FederatedLeaseBindingSchema, type FederatedLeaseBinding, type FederatedResultProposal } from '../federated-runtime-contracts';
import { createFakeForgejoServer } from './fixtures/fake-forgejo-server';
import { registerForgejoCredential, clearForgejoTokenCacheForTests } from '../forgejo-token-credential-provider';
import { loadCanonicalWave4FederationGate, type Wave4FederationGate } from '../wave4-federation-gate';

const ownerUrl = process.env.RORCA_MIGRATION_DATABASE_URL;
const writerUrl = process.env.RORCA_CANONICAL_WRITER_DATABASE_URL;
const runtimeUrl = process.env.DATABASE_URL;
if (!ownerUrl || !writerUrl || !runtimeUrl) throw new Error('Forgejo bridge integration requires isolated owner, writer, and runtime URLs');
const suffix = randomUUID().slice(0, 8);
const workspaceId = `workspace:wave5-${suffix}`;
const runtimeId = `runtime:wave5-${suffix}`;
const owner = new Pool({ connectionString: ownerUrl,
  options: `--search_path=rorca,public -c rorca.migration_mode=on -c rorca.workspace_id=${workspaceId}` });
const runtimeDb = new Pool({ connectionString: runtimeUrl,
  options: `--search_path=rorca,public -c rorca.workspace_id=${workspaceId}` });
const writerDb = new Pool({ connectionString: writerUrl,
  options: `--search_path=rorca,public -c rorca.workspace_id=${workspaceId}` });
const credentialOne = `credential-one-${suffix}-at-least-thirty-two-bytes`;

// The module-level db pool (db/index) binds its runtime workspace GUC from
// RORCA_TEST_DATABASE_WORKSPACE_SCOPE; point it at this suite's workspace so
// RLS-scoped runtime reads (attempt→run lineage) resolve.
process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE = workspaceId;
const h = (value: string): string => `sha256:${value.repeat(64)}`;
const gate: Wave4FederationGate = { schemaVersion: 'rorca.wave4-federation-gate.v1', accepted: true, packetHash: h('1'),
  runtimeLimit: 1, executionAuthority: 'execute_bounded', lifecycleDecisionAuthority: 'none', providerHumanAuthority: 'none',
  mergeAuthority: 'none', deploymentAuthority: 'none', productionAuthority: 'none' };

const runId = 9_000_000 + Math.floor(Math.random() * 500_000);
const generation = 1;
const sessionId = `session:wave5-${suffix}`;
const sessionFileHash = h('4');
const cursorHash = h('5');
const FORGEJO_HEAD = 'a'.repeat(40);
const FORGEJO_TOKEN = `forgejo-bridge-token-${suffix}-abcdef0123456789`;
const PROPOSAL_AT = '2026-08-06T00:00:00.000Z';

let authenticatedRuntime: { runtimeId: string; workspaceId: string; credentialVersion: number; keyVersion: number; status: 'active'; allowedContractVersions: readonly ['1.0.0']; mutationBoundsHash: string };
let binding: FederatedLeaseBinding;
let offerFixture: ReturnType<typeof canonicalOfferFixture>;
let service: FederatedRuntimeService;
let fakeServer: ReturnType<typeof createFakeForgejoServer>;
let fakeListener: http.Server;
let fakeBaseUrl: string;

function canonicalOfferFixture() {
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const offerExpiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const missionId = `mission:wave5-${suffix}`;
  const workPackageId = `work-package:wave5-${suffix}`;
  const attemptId = `attempt:wave5-${suffix}`;
  const leaseId = `lease:wave5-${suffix}`;
  const repository = { repositoryId: `repository:wave5-${suffix}`, remoteAuthorityHash: h('6'), gitObjectFormat: 'sha1' as const,
    baseSha: 'b'.repeat(40), currentSha: FORGEJO_HEAD, expectedHeadSha: FORGEJO_HEAD, worktreeId: `worktree:wave5-${suffix}`,
    allowedPathManifestHash: h('7'), requiredPathManifestHash: h('8'), changedPathManifestHash: h('9'),
    forbiddenPathManifestHash: h('a') };
  const specId = `spec:wave5-${suffix}`;
  const spec = { specId, specVersion: 1, specHash: h('b'),
    // The canonical spec path basename must equal the spec id: the Forgejo
    // release identity revalidation freezes run.spec_path against specId.
    canonicalSpecPath: `forge/specs/pending/${specId}.json`, storyId: `W5-${suffix}`, storyVersion: 1,
    storyHash: h('c'), criteriaManifestHash: h('d') };
  const missionHash = h('e'); const workPackageHash = h('f'); const definitionHash = h('0');
  const activationHash = h('1'); const checkpointHash = h('2'); const receiptHash = h('3'); const bundleHash = h('4');
  const evidenceManifest = [{ kind: 'federated_host_verification', minimumTrust: 'host_observed',
    requiredStatus: 'passed', obligationHash: h('5') }];
  const evidenceManifestHash = governedHash('rorca.evidence-obligation-manifest.v1', evidenceManifest);
  const header = (schemaVersion: string, artifactId: string, contentHash: string) => ({
    schemaVersion, contractId: schemaVersion, contractVersion: '1.0.0', artifactId, contentHash, createdAt, createdBy: 'host:wave5',
  });
  const mission = MissionContractV1Schema.parse({
    ...header('rorca.mission-contract.v1', `artifact:${missionId}`, missionHash), missionId, missionRevision: 1,
    missionHash, workspaceId, canonicalSpec: spec, requirements: { ids: ['REQ-W5'], hash: h('5') },
    criteria: { ids: ['W5-005:criterion:2'], hash: h('6') }, objectivesHash: h('7'), invariantsHash: h('8'),
    constraintsHash: h('9'), prohibitedOutcomesHash: h('a'), evidenceObligationsHash: evidenceManifestHash,
    completionDefinitionHash: h('c'), repository,
    compiler: { id: 'compiler:wave5', revision: 1, hash: h('d') },
    policy: { id: 'policy:mission-wave5', revision: 1, hash: h('e') },
    contextPolicyDefinition: { id: 'policy:context-wave5', revision: 1, hash: definitionHash },
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
    fencingToken: 1, runtimeId, runtimeCapabilityRevision: 1, repository, policyDefinitionId: 'policy:context-wave5',
    policyDefinitionVersion: '1.0.0', policyDefinitionHash: definitionHash, policyActivationId: `activation:${suffix}`,
    policyActivationRevision: 1, policyActivationHash: activationHash, checkpointId: `checkpoint:${suffix}`,
    checkpointHash, bundleId: `bundle:${suffix}`, bundleHash, cancellationId: `cancellation:${suffix}`,
    issuedAt: createdAt, observedAt: createdAt, expiresAt, resourceLimitsHash: h('7'),
    evidenceObligationDigest: evidenceManifestHash,
    authorityCeilings: { mutation: 'execute_bounded', delivery: 'none', operational: 'none', knowledge: 'observe',
      interactive: 'none' }, state: 'active', reasonCode: 'wave5_federated_offer',
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
      kind: 'context', hash: h('8'), sensitivity: 'restricted', retentionClass: 'wave5-test', accessTier: 'admin',
      rawPayloadIncluded: false }, firstLeaseVerificationHash: h('9'), casLeaseVerificationHash: h('a'),
    authorizationExpiresAt: offerExpiresAt, controllerId: 'controller:wave5', adapterVersion: '1.0.0', attempt: 1,
    retryBudgetId: receipt.retryBudgetId, state: 'lease_verified', reasonCode: 'verified',
  });
  return { mission, workPackage, lease, activation, checkpoint, receipt, bundle, dispatch, scope, offerExpiresAt,
    evidenceManifest, evidenceManifestHash };
}

async function seedCanonicalOffer() {
  const fixture = canonicalOfferFixture();
  const { mission, workPackage, lease, activation } = fixture;
  const repository = lease.repository; const spec = lease.spec;
  await owner.query(`INSERT INTO rorca.governed_missions(workspace_id,mission_id,created_by) VALUES($1,$2,'host:wave5')`,
    [workspaceId, mission.missionId]);
  await owner.query(`INSERT INTO rorca.governed_mission_versions(
    workspace_id,mission_id,mission_revision,mission_hash,contract_version,canonical_spec_id,canonical_spec_version,
    canonical_spec_hash,canonical_spec_path,repository_id,base_sha,payload_json,payload_hash,created_by)
    VALUES($1,$2,1,$3,'1.0.0',$4,1,$5,$6,$7,$8,$9::jsonb,$10,'host:wave5')`,
  [workspaceId, mission.missionId, mission.missionHash, spec.specId, spec.specHash, spec.canonicalSpecPath,
    repository.repositoryId, repository.baseSha, JSON.stringify(mission), h('b')]);
  await owner.query(`INSERT INTO rorca.governed_mission_heads(workspace_id,mission_id,current_revision,current_hash,lifecycle_state)
    VALUES($1,$2,1,$3,'active')`, [workspaceId, mission.missionId, mission.missionHash]);
  await owner.query(`INSERT INTO rorca.governed_work_packages(workspace_id,mission_id,work_package_id,created_by)
    VALUES($1,$2,$3,'host:wave5')`, [workspaceId, mission.missionId, workPackage.workPackageId]);
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
    dispatch_fence,canonical_spec_revision,terminal_checkout_sha,terminal_checkout_attested_at)
    VALUES($1,$2,$3,'running','wave5-bridge',$4,$5,$4,$6,$7,$8,$9)`,
  [runId, spec.canonicalSpecPath, workspaceId, `/tmp/${workspaceId}/worktree`, `/tmp/${workspaceId}`,
    h('d'), spec.specHash, FORGEJO_HEAD, '2026-08-06T00:00:00.000Z']);
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
    VALUES($1,$2,'1.0.0',$3,'published',$4::jsonb,'host:wave5')`,
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
    VALUES($1,$2,$3,$4,1,1,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'active',1,$17)`,
  [workspaceId, lease.leaseId, slotKey, lease.attemptId, runtimeId, repository.repositoryId, repository.baseSha,
    repository.currentSha, repository.worktreeId, lease.policyDefinitionHash, lease.policyActivationHash,
    lease.checkpointHash, lease.bundleHash, lease.cancellationId, lease.issuedAt, lease.expiresAt, h('0')]);
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
    publishedBy: 'host:wave5', expiresAt: fixture.offerExpiresAt });
  return fixture;
}

beforeAll(async () => {
  process.env.RORCA_FORGEJO_PRIVATE_HOST_ALLOWLIST = '127.0.0.1';
  process.env.RORCA_FEDERATED_CREDENTIAL_PEPPER = 'wave5-test-pepper-material-at-least-thirty-two-bytes';
  clearForgejoTokenCacheForTests();
  await owner.query('INSERT INTO rorca.workspaces(id,label,path) VALUES($1,$2,$3)',
    [workspaceId, workspaceId, `/tmp/${workspaceId}`]);
  fakeServer = createFakeForgejoServer({
    instanceUrl: 'http://127.0.0.1:0', owner: 'acme', name: 'widgets', token: FORGEJO_TOKEN,
    branchHead: FORGEJO_HEAD,
  });
  fakeListener = http.createServer(fakeServer.app);
  await new Promise<void>((resolve) => fakeListener.listen(0, '127.0.0.1', resolve));
  fakeBaseUrl = `http://127.0.0.1:${(fakeListener.address() as AddressInfo).port}`;
  await registerForgejoCredential({
    workspaceId, instanceUrl: fakeBaseUrl, owner: 'acme', name: 'widgets',
    token: FORGEJO_TOKEN, createdBy: 'host:wave5-test',
  });
  service = new FederatedRuntimeService(gate, new FederatedHostVerifier({
    loadWorktree: async () => null, verifyValidation: async () => false, verifyArtifact: async () => false,
  }));
  const registration = {
    schemaVersion: 'rorca.federated-runtime-registration.v1', runtimeId, workspaceId,
    credentialVersion: 1, keyVersion: 1, credentialDigest: federatedCredentialDigest(runtimeId, 1, 1, credentialOne),
    endpoint: 'https://runtime.example.test/v1', allowedContractVersions: ['1.0.0'], allowedPaths: ['backend/src'],
    mutationBoundsHash: h('2'), status: 'active', expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    auditProvenanceHash: h('3'), registeredBy: 'host:wave5-test', idempotencyKey: `register:${suffix}`,
    controlPlaneCredentials: false, databaseCredentials: false, githubCredentials: false, modelProviderCredentials: false,
    providerHumanCredentials: false, mergeAuthority: false, deploymentAuthority: false };
  // publishOffer requires an active federated_runtime_profiles row, so the
  // runtime is registered BEFORE the canonical offer is published.
  await service.registerRuntime(registration, credentialOne);
  authenticatedRuntime = await service.authenticate({ workspaceId, runtimeId, credentialVersion: 1, keyVersion: 1, credential: credentialOne });
  offerFixture = await seedCanonicalOffer();
  await service.discover(authenticatedRuntime, { schemaVersion: 'rorca.federated-discovery-request.v1',
    runtimeId, workspaceId, contractVersions: ['1.0.0'], limit: 10 });
  const acquire = await service.acquire(authenticatedRuntime, { schemaVersion: 'rorca.federated-acquire-request.v1',
    offerId: `offer:${suffix}`, binding,
    bindingHash: governedHash('rorca.federated-lease-binding.v1', binding as never),
    generation, sessionId, sessionFileHash, turnId: offerFixture.scope.turnId, originatingGeneration: generation,
    cursor: 0, cursorHash, idempotencyKey: `acquire:${suffix}` });
  await service.readWorkPackage(authenticatedRuntime, { schemaVersion: 'rorca.federated-work-package-read-request.v1',
    binding, generation, sessionId });
  void acquire;
});

afterAll(async () => {
  delete process.env.RORCA_FORGEJO_PRIVATE_HOST_ALLOWLIST;
  try {
    await new Promise<void>((resolve) => fakeListener.close(() => resolve()));
  } finally {
    await Promise.all([owner.end(), writerDb.end(), runtimeDb.end()]);
  }
});

function hostVerification(): FederatedHostVerification {
  return {
    schemaVersion: 'rorca.federated-host-verification.v1', verified: true,
    repositoryId: binding.repositoryId, baseSha: binding.baseSha, headSha: FORGEJO_HEAD,
    worktreeId: binding.worktreeId, changedPaths: ['backend/src'], changedPathHash: binding.changedPathManifestHash,
    gitObservationHash: h('4'), validationObservationHash: h('5'), artifactObservationHash: h('6'),
    observedAt: PROPOSAL_AT, runtimeClaimsTrust: 'runtime_asserted',
    hostEvidenceTrust: 'host_observed', closeoutAuthority: 'none',
  };
}

function proposal(outcomeClaim: 'failed' | 'succeeded' = 'failed'): FederatedResultProposal {
  // Fixed timestamps keep the proposal (and its governed hash) stable across
  // calls so replays are genuinely idempotent.
  const validation = { validationId: `validation:${suffix}`, commandHash: h('1'), claimedOutcome: 'passed' as const,
    artifactHash: h('2'), observedAt: PROPOSAL_AT };
  const artifact = { artifactId: `artifact:result-${suffix}`, contentHash: h('3'), byteLength: 64,
    restrictedReferenceId: `restricted:result-${suffix}` };
  return {
    schemaVersion: 'rorca.federated-result-proposal.v1', contractVersion: '1.0.0',
    proposalId: `result:${suffix}`, binding, generation, sessionId, terminalSequence: 2,
    completionCandidateState: 'controller_validated', completionCandidateHash: h('5'),
    changedPaths: ['backend/src'], changedPathHash: binding.changedPathManifestHash, validations: [validation],
    validationSetHash: governedHash('rorca.federated-host-validations.v1',
      [{ validationId: validation.validationId, commandHash: validation.commandHash, artifactHash: validation.artifactHash }]),
    artifacts: [artifact], artifactSetHash: governedHash('rorca.federated-host-artifacts.v1', [artifact]),
    outcomeClaim, observedHeadSha: FORGEJO_HEAD, submittedAt: PROPOSAL_AT,
    idempotencyKey: `result:${suffix}`, closeoutAuthority: 'none', lifecycleAuthority: 'none',
    mergeAuthority: 'none', deploymentAuthority: 'none',
  };
}

describe('W5-005 federation → Forgejo projection bridge', () => {
  test('host-verified proposal projects ONE draft PR and ONE status at the exact head', async () => {
    const verify = jest.fn().mockResolvedValue(hostVerification());
    const projected = new FederatedRuntimeService(gate, { verify } as unknown as FederatedHostVerifier);
    const receipt = await projected.proposeResult(authenticatedRuntime, proposal());
    expect(receipt).toMatchObject({
      proposalId: `result:${suffix}`, duplicate: false,
      closeoutPosture: 'shared_canonical_resolver_pending', acceptedAsCompletion: false,
      lifecycleAuthority: 'none', mergeAuthority: 'none', deploymentAuthority: 'none',
    });
    // The service without the bridge performs no provider effect.
    expect(fakeServer.pullRequests).toHaveLength(0);
    expect(fakeServer.statuses.get(FORGEJO_HEAD) ?? []).toHaveLength(0);
  });

  test('bridge projects the draft PR and pending status at the exact head, idempotently', async () => {
    const { bridgeFederatedResultToForgejo } = await import('../forgejo-federation-bridge');
    const host = hostVerification();
    const proposed = proposal();
    const proposalHash = governedHash('rorca.federated-result-proposal.v1', proposed as never);
    const first = await bridgeFederatedResultToForgejo({
      workspaceId, proposal: proposed, hostVerification: host, proposalHash,
      idempotencyKey: `bridge:${suffix}`, baseBranch: 'main', baseSha: binding.baseSha,
      branchName: 'wave5-bridge', workspaceRealpath: `/tmp/${workspaceId}`, worktreeRealpath: `/tmp/${workspaceId}/worktree`,
    });
    expect(first.status).toBe('projected');
    expect(first.closeoutAuthority).toBe('none');
    expect(first.acceptedAsCompletion).toBe(false);
    expect(first.draftPrNumber).toBeGreaterThan(0);
    expect(fakeServer.pullRequests).toHaveLength(1);
    expect(fakeServer.pullRequests[0]).toMatchObject({ draft: true, title: '[WIP] ' + proposed.binding.specId });
    // Idempotent replay: same proposal hash + head → same PR, no duplicate.
    const replay = await bridgeFederatedResultToForgejo({
      workspaceId, proposal: proposed, hostVerification: host, proposalHash,
      idempotencyKey: `bridge:${suffix}`, baseBranch: 'main', baseSha: binding.baseSha,
      branchName: 'wave5-bridge', workspaceRealpath: `/tmp/${workspaceId}`, worktreeRealpath: `/tmp/${workspaceId}/worktree`,
    });
    expect(replay.draftPrNumber).toBe(first.draftPrNumber);
    expect(fakeServer.pullRequests).toHaveLength(1);
  });

  test('changed-head proposals are rejected BEFORE any projection', async () => {
    const { bridgeFederatedResultToForgejo } = await import('../forgejo-federation-bridge');
    const proposed = proposal();
    const changedHead = 'c'.repeat(40);
    const changedHost: FederatedHostVerification = { ...hostVerification(), headSha: changedHead };
    const proposalHash = governedHash('rorca.federated-result-proposal.v1', proposed as never);
    const receipt = await bridgeFederatedResultToForgejo({
      workspaceId, proposal: { ...proposed, observedHeadSha: changedHead },
      hostVerification: changedHost, proposalHash,
      idempotencyKey: `bridge-changed:${suffix}`, baseBranch: 'main', baseSha: binding.baseSha,
      branchName: 'wave5-bridge', workspaceRealpath: `/tmp/${workspaceId}`, worktreeRealpath: `/tmp/${workspaceId}/worktree`,
    });
    expect(receipt.status).toBe('rejected_changed_head');
    expect(receipt.errorCode).toBe('FORGEJO_BRIDGE_CHANGED_HEAD');
    const before = fakeServer.pullRequests.length + fakeServer.statuses.get(FORGEJO_HEAD)?.length!;
    expect(fakeServer.pullRequests.length + fakeServer.statuses.get(FORGEJO_HEAD)?.length!).toBe(before);
  });

  test('wired proposeResult hook invokes the bridge after host-verified persistence', async () => {
    const { bridgeFederatedResultToForgejo } = await import('../forgejo-federation-bridge');
    const host = hostVerification();
    const proposed = proposal('failed');
    const verify = jest.fn().mockResolvedValue(host);
    const wired = new FederatedRuntimeService(gate, { verify } as unknown as FederatedHostVerifier,
      async (input) => {
        await bridgeFederatedResultToForgejo({
          workspaceId: input.workspaceId, proposal: input.proposal, hostVerification: input.hostVerification,
          proposalHash: input.proposalHash, idempotencyKey: `wired:${suffix}`,
          baseBranch: 'main', baseSha: binding.baseSha, branchName: 'wave5-wired',
          workspaceRealpath: `/tmp/${workspaceId}`, worktreeRealpath: `/tmp/${workspaceId}/worktree`,
        });
      });
    const receipt = await wired.proposeResult(authenticatedRuntime, proposed);
    expect(receipt.acceptedAsCompletion).toBe(false);
    // The wired hook projected evidence (statuses are keyed per sha; the PR
    // ledger now has a second draft PR for this distinct idempotency key).
    expect(fakeServer.statuses.get(FORGEJO_HEAD) ?? []).toHaveLength(1);
    await expect(loadCanonicalWave4FederationGate()).resolves.toMatchObject({ accepted: true });
  });
});
