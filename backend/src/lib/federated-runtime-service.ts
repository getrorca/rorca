/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { z } from 'zod';
import { canonicalTransaction } from '../db';
import {
  ContextBundleV1Schema, ContextCheckpointV1Schema, ContextPolicyActivationV1Schema, ContinuationDispatchV1Schema,
  EvidenceEnvelopeV1Schema, ExecutionLeaseV1Schema, MissionContractV1Schema, RetrievalReceiptV1Schema, WorkPackageV1Schema,
  assertNoForbiddenGovernedFields, governedHash, type ExecutionLeaseV1, type MissionContractV1, type WorkPackageV1,
} from './governed-contracts';
import {
  acknowledgeExecutionCancellation, ingestGovernedEvidence, ingestRuntimeEvent, releaseExecutionLease,
  renewExecutionLease, submitPlanChangeProposal, type GovernedMutationContext,
} from './governed-mission-service';
import { RunActivityStore } from './run-activity-store';
import { AuthError, ConflictError, NotFoundError, UnprocessableError, ValidationError } from './errors';
import {
  FederatedAcquireRequestSchema, FederatedActivityRequestSchema, FederatedCancellationAcknowledgementSchema,
  FederatedDiscoveryRequestSchema, FederatedEventRequestSchema, FederatedLeaseBindingSchema, FederatedPlanChangeRequestSchema,
  FederatedRecoveryRequestSchema, FederatedReleaseRequestSchema, FederatedRenewRequestSchema,
  FederatedResultProposalSchema, FederatedRuntimeRegistrationSchema, FederatedWorkPackageReadRequestSchema,
  type FederatedLeaseBinding, type FederatedResultProposal, type FederatedRuntimeRegistration,
} from './federated-runtime-contracts';
import { FederatedHostVerifier, type FederatedHostVerification, type FederatedHostVerificationPorts, type FederatedHostWorktree } from './federated-host-verifier';
import type { Wave4FederationGate } from './wave4-federation-gate';

export const FEDERATED_RUNTIME_VERSION = 'rorca.federated-runtime.v1' as const;
const CREDENTIAL_MIN_BYTES = 32;
type ContextPolicyActivationV1 = z.infer<typeof ContextPolicyActivationV1Schema>;
type ContextCheckpointV1 = z.infer<typeof ContextCheckpointV1Schema>;
type RetrievalReceiptV1 = z.infer<typeof RetrievalReceiptV1Schema>;
type ContextBundleV1 = z.infer<typeof ContextBundleV1Schema>;
type ContinuationDispatchV1 = z.infer<typeof ContinuationDispatchV1Schema>;

export interface FederatedCanonicalOffer {
  readonly offerId: string;
  readonly mission: unknown;
  readonly workPackage: unknown;
  readonly lease: unknown;
  readonly policyActivation: unknown;
  readonly checkpoint: unknown;
  readonly retrievalReceipt: unknown;
  readonly contextBundle: unknown;
  readonly continuationDispatch?: unknown;
  readonly worktreePath: string;
  readonly sourceCheckoutPath: string;
  readonly publishedBy: string;
  readonly expiresAt: string;
  readonly contextEpoch?: never;
}

export interface FederatedAuthenticatedRuntime {
  readonly runtimeId: string;
  readonly workspaceId: string;
  readonly credentialVersion: number;
  readonly keyVersion: number;
  readonly status: 'active';
  readonly allowedContractVersions: readonly ['1.0.0'];
  readonly mutationBoundsHash: string;
}

interface DbDecision<T = unknown> { ok: boolean; reasonCode?: string; duplicate?: boolean; value?: T }
async function canonicalOne<T>(sql: string, params: readonly unknown[] = []): Promise<T | undefined> {
  return canonicalTransaction(async (client) => (await client.query<T & Record<string, unknown>>(sql, [...params])).rows[0] as T | undefined);
}

function requireDecision<T>(decision: DbDecision<T> | undefined, operation: string): T {
  if (!decision?.ok) {
    const reason = decision?.reasonCode ?? 'canonical_state_unavailable';
    if (reason.includes('missing')) throw new NotFoundError(`${operation} subject not found`);
    throw new ConflictError(`${operation} blocked by canonical state`, { reason, retryable: false });
  }
  return decision.value as T;
}

function credentialPepper(): string {
  const pepper = process.env.RORCA_FEDERATED_CREDENTIAL_PEPPER ?? '';
  if (Buffer.byteLength(pepper, 'utf8') < CREDENTIAL_MIN_BYTES) {
    throw new Error('RORCA_FEDERATED_CREDENTIAL_PEPPER must contain at least 32 bytes');
  }
  return pepper;
}

export function federatedCredentialDigest(runtimeId: string, credentialVersion: number, keyVersion: number, credential: string): string {
  if (Buffer.byteLength(credential, 'utf8') < CREDENTIAL_MIN_BYTES || Buffer.byteLength(credential, 'utf8') > 512) {
    throw new ValidationError('Federated credential must contain between 32 and 512 bytes');
  }
  return `sha256:${createHash('sha256').update('rorca.federated-credential.v1\0').update(credentialPepper()).update('\0')
    .update(runtimeId).update('\0').update(String(credentialVersion)).update('\0').update(String(keyVersion)).update('\0').update(credential).digest('hex')}`;
}

function mutationContext(runtime: FederatedAuthenticatedRuntime, idempotencyKey: string): GovernedMutationContext {
  return { principalId: runtime.runtimeId, authoritySource: 'runtime_lease', idempotencyKey,
    correlationId: `federated:${randomBytes(12).toString('hex')}` };
}

function bindingFor(input: {
  mission: MissionContractV1; workPackage: WorkPackageV1; lease: ExecutionLeaseV1;
  activation: ContextPolicyActivationV1; checkpoint: ContextCheckpointV1; receipt: RetrievalReceiptV1;
  bundle: ContextBundleV1; dispatch?: ContinuationDispatchV1;
}): FederatedLeaseBinding {
  const { mission, workPackage, lease, activation, checkpoint, receipt, bundle, dispatch } = input;
  return FederatedLeaseBindingSchema.parse({ workspaceId: mission.workspaceId, runtimeId: lease.runtimeId,
    missionId: mission.missionId, missionRevision: mission.missionRevision, missionHash: mission.missionHash,
    workPackageId: workPackage.workPackageId, workPackageRevision: workPackage.workPackageRevision, workPackageHash: workPackage.workPackageHash,
    specId: workPackage.spec.specId, specVersion: workPackage.spec.specVersion, specHash: workPackage.spec.specHash,
    storyId: workPackage.spec.storyId, storyVersion: workPackage.spec.storyVersion, storyHash: workPackage.spec.storyHash,
    criteriaManifestHash: workPackage.spec.criteriaManifestHash, attemptId: lease.attemptId, leaseId: lease.leaseId,
    fencingToken: lease.fencingToken, expectedLeaseExpiresAt: lease.expiresAt, policyDefinitionHash: lease.policyDefinitionHash,
    policyActivationId: activation.activationId, policyActivationRevision: activation.activationRevision,
    policyActivationHash: activation.activationHash, checkpointId: checkpoint.checkpointId, checkpointHash: checkpoint.contentHash,
    retrievalReceiptId: receipt.receiptId, retrievalReceiptHash: receipt.contentHash, bundleId: bundle.bundleId,
    bundleHash: bundle.bundleHash, dispatchId: dispatch?.dispatchId ?? 'not_applicable', dispatchHash: dispatch?.contentHash ?? 'not_applicable',
    repositoryId: lease.repository.repositoryId, remoteAuthorityHash: lease.repository.remoteAuthorityHash,
    baseSha: lease.repository.baseSha, currentSha: lease.repository.currentSha, expectedHeadSha: lease.repository.expectedHeadSha,
    worktreeId: lease.repository.worktreeId, allowedPathManifestHash: lease.repository.allowedPathManifestHash,
    requiredPathManifestHash: lease.repository.requiredPathManifestHash, changedPathManifestHash: lease.repository.changedPathManifestHash,
    forbiddenPathManifestHash: lease.repository.forbiddenPathManifestHash, validationManifestHash: workPackage.validationObligationsHash });
}

function parseOffer(input: FederatedCanonicalOffer) {
  const mission = MissionContractV1Schema.parse(input.mission);
  const workPackage = WorkPackageV1Schema.parse(input.workPackage);
  const lease = ExecutionLeaseV1Schema.parse(input.lease);
  const activation = ContextPolicyActivationV1Schema.parse(input.policyActivation);
  const checkpoint = ContextCheckpointV1Schema.parse(input.checkpoint);
  const receipt = RetrievalReceiptV1Schema.parse(input.retrievalReceipt);
  const bundle = ContextBundleV1Schema.parse(input.contextBundle);
  const dispatch = input.continuationDispatch === undefined ? undefined : ContinuationDispatchV1Schema.parse(input.continuationDispatch);
  assertNoForbiddenGovernedFields({ mission, workPackage, lease, activation, checkpoint, receipt, bundle, dispatch });
  const binding = bindingFor({ mission, workPackage, lease, activation, checkpoint, receipt, bundle, dispatch });
  const same = mission.workspaceId === workPackage.workspaceId && mission.workspaceId === lease.workspaceId
    && mission.missionId === workPackage.missionId && mission.missionId === lease.missionId
    && mission.missionRevision === workPackage.missionRevision && mission.missionRevision === lease.missionRevision
    && mission.missionHash === workPackage.missionHash && mission.missionHash === lease.missionHash
    && workPackage.workPackageId === lease.workPackageId && workPackage.workPackageRevision === lease.workPackageRevision
    && workPackage.workPackageHash === lease.workPackageHash && lease.policyActivationHash === activation.activationHash
    && lease.checkpointId === checkpoint.checkpointId && lease.checkpointHash === checkpoint.contentHash
    && receipt.checkpointId === checkpoint.checkpointId && bundle.checkpointId === checkpoint.checkpointId
    && bundle.receiptId === receipt.receiptId && lease.bundleId === bundle.bundleId && lease.bundleHash === bundle.bundleHash;
  if (!same || lease.state !== 'active' || activation.state !== 'active' || bundle.state !== 'active' || !receipt.requiredComplete) {
    throw new UnprocessableError('Federated offer canonical identities are inconsistent or inactive', 'FEDERATED_SCOPE_MISMATCH');
  }
  if (Date.parse(lease.expiresAt) <= Date.now() || Date.parse(bundle.expiresAt) <= Date.now() || Date.parse(input.expiresAt) > Date.parse(lease.expiresAt)) {
    throw new UnprocessableError('Federated offer expiry exceeds an active canonical input', 'FEDERATED_EXPIRY_MISMATCH');
  }
  return { mission, workPackage, lease, activation, checkpoint, receipt, bundle, dispatch, binding,
    bindingHash: governedHash('rorca.federated-lease-binding.v1', binding as never) };
}

export class FederatedRuntimeService {
  private readonly activity = new RunActivityStore();
  private readonly gate: Wave4FederationGate;
  private readonly hostVerifier: FederatedHostVerifier;
  /**
   * Optional W5-005 hook: invoked after a host-verified result proposal has
   * been durably persisted. The hook (e.g. the Forgejo federation bridge)
   * projects evidence at the exact head and never changes the proposal's
   * authority posture (closeoutAuthority stays 'none').
   */
  private readonly resultProjection?: (input: {
    workspaceId: string;
    proposal: FederatedResultProposal;
    hostVerification: FederatedHostVerification;
    proposalHash: string;
  }) => Promise<void>;
  constructor(
    gate: Wave4FederationGate,
    hostVerifier: FederatedHostVerifier,
    resultProjection?: (input: {
      workspaceId: string;
      proposal: FederatedResultProposal;
      hostVerification: FederatedHostVerification;
      proposalHash: string;
    }) => Promise<void>,
  ) {
    this.gate = gate;
    this.hostVerifier = hostVerifier;
    this.resultProjection = resultProjection;
    if (!gate.accepted || gate.runtimeLimit !== 1 || gate.mergeAuthority !== 'none' || gate.deploymentAuthority !== 'none') {
      throw new Error('Wave 4 exact prerequisite gate is not accepted');
    }
  }

  async registerRuntime(registrationInput: unknown, credential: string): Promise<{ runtimeId: string; workspaceId: string; credentialVersion: number }> {
    const supplied = FederatedRuntimeRegistrationSchema.parse(registrationInput);
    const credentialDigest = federatedCredentialDigest(supplied.runtimeId, supplied.credentialVersion, supplied.keyVersion, credential);
    if (supplied.credentialDigest !== credentialDigest) throw new ValidationError('Credential digest does not match authentication-boundary material');
    const registration: FederatedRuntimeRegistration = { ...supplied, credentialDigest };
    const row = await canonicalOne<{ decision: DbDecision<{ runtimeId: string; workspaceId: string; credentialVersion: number }> }>(
      'SELECT rorca.register_wave4_federated_runtime_v1($1::jsonb) decision', [JSON.stringify(registration)]);
    return requireDecision(row?.decision, 'Runtime registration');
  }

  async rotateRuntimeCredential(input: { workspaceId: string; runtimeId: string; priorCredentialVersion: number;
    credentialVersion: number; keyVersion: number; credential: string; expiresAt: string; auditProvenanceHash: string;
    idempotencyKey: string }): Promise<{ credentialVersion: number; keyVersion: number }> {
    const credentialDigest = federatedCredentialDigest(input.runtimeId, input.credentialVersion, input.keyVersion, input.credential);
    const { credential: _credential, ...bounded } = input;
    const material = { ...bounded, credentialDigest };
    const row = await canonicalOne<{ decision: DbDecision<{ credentialVersion: number; keyVersion: number }> }>(
      'SELECT rorca.rotate_wave4_federated_credential_v1($1::jsonb) decision', [JSON.stringify(material)]);
    return requireDecision(row?.decision, 'Runtime credential rotation');
  }

  async revokeRuntime(input: { workspaceId: string; runtimeId: string; expectedCredentialVersion: number; reasonCode: string;
    provenanceHash: string; idempotencyKey: string }): Promise<void> {
    const row = await canonicalOne<{ decision: DbDecision }>('SELECT rorca.revoke_wave4_federated_runtime_v1($1::jsonb) decision', [JSON.stringify(input)]);
    requireDecision(row?.decision, 'Runtime revocation');
  }

  async authenticate(input: { workspaceId: string; runtimeId: string; credentialVersion: number; keyVersion: number; credential: string }): Promise<FederatedAuthenticatedRuntime> {
    let digest: string;
    try { digest = federatedCredentialDigest(input.runtimeId, input.credentialVersion, input.keyVersion, input.credential); }
    catch { throw new AuthError('Federated runtime authentication failed'); }
    const row = await canonicalOne<{ identity: FederatedAuthenticatedRuntime | null }>(
      'SELECT rorca.authenticate_wave4_federated_runtime_v1($1,$2,$3,$4,$5) identity',
      [input.workspaceId, input.runtimeId, input.credentialVersion, input.keyVersion, digest]);
    if (!row?.identity) throw new AuthError('Federated runtime authentication failed');
    return row.identity;
  }

  async publishOffer(input: FederatedCanonicalOffer): Promise<{ offerId: string; bindingHash: string }> {
    const parsed = parseOffer(input);
    const offer = { schemaVersion: FEDERATED_RUNTIME_VERSION, offerId: input.offerId, binding: parsed.binding,
      bindingHash: parsed.bindingHash, mission: parsed.mission, workPackage: parsed.workPackage, lease: parsed.lease,
      policyActivation: parsed.activation, checkpoint: parsed.checkpoint, retrievalReceipt: parsed.receipt,
      contextBundle: parsed.bundle, continuationDispatch: parsed.dispatch ?? null, worktreePath: input.worktreePath,
      sourceCheckoutPath: input.sourceCheckoutPath, publishedBy: input.publishedBy, expiresAt: input.expiresAt,
      inputHash: governedHash('rorca.federated-work-offer.v1', { offerId: input.offerId, bindingHash: parsed.bindingHash,
        missionHash: parsed.mission.contentHash, workPackageHash: parsed.workPackage.contentHash, leaseHash: parsed.lease.contentHash,
        activationHash: parsed.activation.contentHash, checkpointHash: parsed.checkpoint.contentHash, receiptHash: parsed.receipt.contentHash,
        bundleHash: parsed.bundle.contentHash, dispatchHash: parsed.dispatch?.contentHash ?? 'not_applicable', expiresAt: input.expiresAt } as never) };
    const row = await canonicalOne<{ decision: DbDecision<{ offerId: string; bindingHash: string }> }>(
      'SELECT rorca.publish_wave4_federated_offer_v1($1::jsonb) decision', [JSON.stringify(offer)]);
    return requireDecision(row?.decision, 'Federated offer publication');
  }

  async discover(runtime: FederatedAuthenticatedRuntime, candidate: unknown) {
    const request = FederatedDiscoveryRequestSchema.parse(candidate);
    if (request.runtimeId !== runtime.runtimeId || request.workspaceId !== runtime.workspaceId) throw new AuthError('Federated runtime scope mismatch');
    const row = await canonicalOne<{ offers: unknown }>('SELECT rorca.discover_wave4_federated_work_v1($1,$2,$3) offers',
      [runtime.workspaceId, runtime.runtimeId, request.limit]);
    return row?.offers ?? { schemaVersion: 'rorca.federated-discovery.v1', offers: [], databaseTime: new Date().toISOString() };
  }

  async acquire(runtime: FederatedAuthenticatedRuntime, candidate: unknown) {
    const request = FederatedAcquireRequestSchema.parse(candidate);
    this.assertRuntimeBinding(runtime, request.binding);
    const computed = governedHash('rorca.federated-lease-binding.v1', request.binding as never);
    if (computed !== request.bindingHash) throw new ConflictError('Federated acquisition binding hash differs', { reason: 'binding_hash_mismatch', retryable: false });
    const row = await canonicalOne<{ decision: DbDecision }>('SELECT rorca.acquire_wave4_federated_work_v1($1::jsonb) decision', [JSON.stringify(request)]);
    return requireDecision(row?.decision, 'Federated work acquisition');
  }

  async readWorkPackage(runtime: FederatedAuthenticatedRuntime, candidate: unknown) {
    const request = FederatedWorkPackageReadRequestSchema.parse(candidate);
    this.assertRuntimeBinding(runtime, request.binding);
    await this.verifyBinding(request.binding, request.generation, request.sessionId);
    const row = await canonicalOne<{ work_input: unknown }>('SELECT rorca.read_wave4_federated_work_input_v1($1,$2,$3,$4) work_input',
      [runtime.workspaceId, request.binding.leaseId, request.generation, request.sessionId]);
    if (!row?.work_input) throw new NotFoundError('Federated work input not found');
    return row.work_input;
  }

  async renew(runtime: FederatedAuthenticatedRuntime, candidate: unknown) {
    const request = FederatedRenewRequestSchema.parse(candidate);
    this.assertRuntimeBinding(runtime, request.binding);
    await this.verifyBinding(request.binding, request.generation, request.sessionId);
    const result = await renewExecutionLease({ workspaceId: runtime.workspaceId, leaseId: request.binding.leaseId,
      fencingToken: request.binding.fencingToken, runtimeId: runtime.runtimeId, expectedStateVersion: request.expectedStateVersion,
      extendSeconds: request.extendSeconds }, mutationContext(runtime, request.idempotencyKey));
    await canonicalOne('SELECT rorca.record_wave4_federated_lease_transition_v1($1,$2,$3,$4)',
      [runtime.workspaceId, request.binding.leaseId, 'renewed', request.idempotencyKey]);
    return result;
  }

  async release(runtime: FederatedAuthenticatedRuntime, candidate: unknown) {
    const request = FederatedReleaseRequestSchema.parse(candidate);
    this.assertRuntimeBinding(runtime, request.binding);
    await this.verifyBinding(request.binding, request.generation, request.sessionId);
    const result = await releaseExecutionLease({ workspaceId: runtime.workspaceId, leaseId: request.binding.leaseId,
      fencingToken: request.binding.fencingToken, runtimeId: runtime.runtimeId, expectedStateVersion: request.expectedStateVersion,
      reasonCode: request.reasonCode }, mutationContext(runtime, request.idempotencyKey));
    await canonicalOne('SELECT rorca.record_wave4_federated_lease_transition_v1($1,$2,$3,$4)',
      [runtime.workspaceId, request.binding.leaseId, 'released', request.idempotencyKey]);
    return result;
  }

  async ingestEvent(runtime: FederatedAuthenticatedRuntime, candidate: unknown) {
    const request = FederatedEventRequestSchema.parse(candidate);
    this.assertRuntimeBinding(runtime, request.binding);
    await this.verifyBinding(request.binding, request.event.scope.runtimeGeneration, request.event.scope.sessionId);
    if (request.event.scope.runtimeId !== runtime.runtimeId || request.event.createdBy !== runtime.runtimeId) throw new AuthError('Runtime event identity mismatch');
    return ingestRuntimeEvent(request.event, { idempotencyKey: request.idempotencyKey,
      correlationId: `federated:${request.idempotencyKey}`, observerId: runtime.runtimeId,
      observerClass: 'runtime', maximumTrust: 'runtime_asserted' });
  }

  async ingestActivity(runtime: FederatedAuthenticatedRuntime, candidate: unknown) {
    const request = FederatedActivityRequestSchema.parse(candidate);
    this.assertRuntimeBinding(runtime, request.binding);
    await this.verifyBinding(request.binding, request.batch.runtimeGeneration, request.batch.events[0]!.scope.sessionId);
    if (request.batch.runtimeId !== runtime.runtimeId || request.batch.workspaceId !== runtime.workspaceId) throw new AuthError('Runtime telemetry identity mismatch');
    const value = await this.activity.ingestTelemetryBatch(request.batch);
    return { schemaVersion: 'rorca.federated-activity-receipt.v1', ...value, observabilityOnly: true,
      evidenceAuthority: 'none', closeoutAuthority: 'none', lifecycleAuthority: 'none' };
  }

  async recordHostValidationObservation(input: { workspaceId: string; attemptId: string; validationId: string;
    commandHash: string; artifactHash: string; outcome: 'passed' | 'failed'; observerId: string }): Promise<{ duplicate: boolean }> {
    assertNoForbiddenGovernedFields(input);
    if (![input.commandHash, input.artifactHash].every((value) => /^sha256:[a-f0-9]{64}$/.test(value))) {
      throw new ValidationError('Host validation observation hashes are invalid');
    }
    const material = { ...input, observerClass: 'host', trustClass: 'host_observed' };
    const row = await canonicalOne<{ duplicate: boolean }>('SELECT rorca.record_wave4_federated_host_validation_v1($1::jsonb) duplicate',
      [JSON.stringify(material)]);
    return { duplicate: row?.duplicate === true };
  }

  async recordHostArtifactObservation(input: { workspaceId: string; artifactId: string; contentHash: string;
    byteLength: number; restrictedReferenceId: string; observerId: string }): Promise<{ duplicate: boolean }> {
    assertNoForbiddenGovernedFields(input);
    if (!/^sha256:[a-f0-9]{64}$/.test(input.contentHash) || !Number.isSafeInteger(input.byteLength)
        || input.byteLength < 0 || input.byteLength > 64 * 1024 * 1024) {
      throw new ValidationError('Host artifact observation is invalid');
    }
    const material = { ...input, integrityState: 'verified', observerClass: 'host', trustClass: 'host_observed' };
    const row = await canonicalOne<{ duplicate: boolean }>('SELECT rorca.record_wave4_federated_host_artifact_v1($1::jsonb) duplicate',
      [JSON.stringify(material)]);
    return { duplicate: row?.duplicate === true };
  }

  async proposeResult(runtime: FederatedAuthenticatedRuntime, candidate: unknown) {
    const proposal = FederatedResultProposalSchema.parse(candidate);
    this.assertRuntimeBinding(runtime, proposal.binding);
    const proposalHash = governedHash('rorca.federated-result-proposal.v1', proposal as never);
    const replay = await canonicalOne<{ replay: { proposalHash: string;
      hostVerification: FederatedHostVerification } | null }>(
      'SELECT rorca.load_wave4_federated_result_replay_v1($1,$2) replay',
      [runtime.workspaceId, proposal.proposalId]);
    const stored = replay?.replay;
    if (stored) {
      if (stored.proposalHash !== proposalHash) {
        throw new ConflictError('Changed federated result proposal replay', { reason: 'changed_result_replay', retryable: false });
      }
      const evidence = await this.persistHostEvidence(runtime, proposal, stored.hostVerification, proposalHash);
      await this.resultProjection?.({
        workspaceId: runtime.workspaceId,
        proposal,
        hostVerification: stored.hostVerification,
        proposalHash,
      }).catch((error: unknown) => {
        // The proposal is already durably accepted; projection failure must
        // never fail the proposal or change its authority posture.
        console.warn(`[FederatedRuntime] Result projection deferred: ${error instanceof Error ? error.message : String(error)}`);
      });
      return this.resultReceipt(proposal, proposalHash, true,
        governedHash('rorca.federated-host-verification.v1', stored.hostVerification as never), evidence.evidenceHash);
    }
    await this.verifyBinding(proposal.binding, proposal.generation, proposal.sessionId, false, true);
    const host = await this.hostVerifier.verify(proposal);
    const row = await canonicalOne<{ decision: DbDecision<{ duplicate: boolean; hostVerification: FederatedHostVerification }> }>(
      'SELECT rorca.persist_wave4_federated_result_v1($1::jsonb,$2::jsonb,$3) decision',
      [JSON.stringify(proposal), JSON.stringify(host), proposalHash]);
    const persisted = requireDecision(row?.decision, 'Federated result proposal');
    const effectiveHost = persisted.hostVerification;
    const evidence = await this.persistHostEvidence(runtime, proposal, effectiveHost, proposalHash);
    await this.resultProjection?.({
      workspaceId: runtime.workspaceId,
      proposal,
      hostVerification: effectiveHost,
      proposalHash,
    }).catch((error: unknown) => {
      console.warn(`[FederatedRuntime] Result projection deferred: ${error instanceof Error ? error.message : String(error)}`);
    });
    return this.resultReceipt(proposal, proposalHash, persisted.duplicate,
      governedHash('rorca.federated-host-verification.v1', effectiveHost as never), evidence.evidenceHash);
  }

  async acknowledgeCancellation(runtime: FederatedAuthenticatedRuntime, candidate: unknown) {
    const request = FederatedCancellationAcknowledgementSchema.parse(candidate);
    this.assertRuntimeBinding(runtime, request.binding);
    await this.verifyBinding(request.binding, request.generation, request.sessionId, true);
    if (request.cancellation.leaseId !== request.binding.leaseId || request.cancellation.fencingToken !== request.binding.fencingToken
        || request.cancellation.attemptId !== request.binding.attemptId) throw new ConflictError('Cancellation acknowledgement lost exact fence');
    return acknowledgeExecutionCancellation(request.cancellation, runtime.runtimeId, mutationContext(runtime, request.idempotencyKey));
  }

  async proposePlanChange(runtime: FederatedAuthenticatedRuntime, candidate: unknown) {
    const request = FederatedPlanChangeRequestSchema.parse(candidate);
    this.assertRuntimeBinding(runtime, request.binding);
    await this.verifyBinding(request.binding, request.generation, request.sessionId);
    const proposal = request.proposal;
    const allowedPaths = await this.allowedPaths(request.binding);
    if (proposal.proposerRuntimeId !== runtime.runtimeId || proposal.baseRevision !== request.binding.workPackageRevision
        || proposal.baseHash !== request.binding.workPackageHash || proposal.diffHash !== request.exactDiffHash
        || proposal.requestedPaths.some((path) => !this.pathPermitted(path, allowedPaths))) {
      throw new ConflictError('Plan change proposal expands or changes the exact leased scope', { reason: 'scope_expansion', retryable: false });
    }
    return submitPlanChangeProposal(proposal, mutationContext(runtime, request.idempotencyKey));
  }

  async recover(runtime: FederatedAuthenticatedRuntime, candidate: unknown) {
    const request = FederatedRecoveryRequestSchema.parse(candidate);
    this.assertRuntimeBinding(runtime, request.binding);
    if (request.bundleHash !== request.binding.bundleHash) throw new ConflictError('Recovery bundle identity differs', { reason: 'bundle_mismatch', retryable: false });
    const row = await canonicalOne<{ decision: DbDecision }>('SELECT rorca.reconcile_wave4_federated_runtime_v1($1::jsonb) decision',
      [JSON.stringify(request)]);
    return requireDecision(row?.decision, 'Federated recovery');
  }

  private assertRuntimeBinding(runtime: FederatedAuthenticatedRuntime, binding: FederatedLeaseBinding): void {
    if (binding.workspaceId !== runtime.workspaceId || binding.runtimeId !== runtime.runtimeId) throw new AuthError('Federated runtime scope mismatch');
  }

  private async verifyBinding(binding: FederatedLeaseBinding, generation: number, sessionId: string,
    cancellationAck = false, resultReplay = false): Promise<void> {
    const row = await canonicalOne<{ decision: DbDecision }>('SELECT rorca.verify_wave4_federated_binding_v1($1::jsonb,$2,$3,$4,$5) decision',
      [JSON.stringify(binding), generation, sessionId, cancellationAck, resultReplay]);
    requireDecision(row?.decision, 'Federated lease binding');
  }

  private async allowedPaths(binding: FederatedLeaseBinding): Promise<readonly string[]> {
    const row = await canonicalOne<{ paths: string[] | null }>('SELECT rorca.load_wave4_federated_allowed_paths_v1($1,$2) paths', [binding.workspaceId, binding.leaseId]);
    if (!row?.paths) throw new NotFoundError('Federated path scope not found');
    return row.paths;
  }

  private pathPermitted(path: string, allowed: readonly string[]): boolean {
    return allowed.some((entry) => path === entry || path.startsWith(`${entry.replace(/\/$/, '')}/`));
  }

  private resultReceipt(proposal: FederatedResultProposal, proposalHash: string, duplicate: boolean,
    hostVerificationHash: string, evidenceHash: string) {
    return { schemaVersion: 'rorca.federated-result-receipt.v1' as const, proposalId: proposal.proposalId, proposalHash,
      duplicate, hostVerificationHash, evidenceId: `evidence:${proposal.proposalId}`, evidenceHash,
      closeoutPosture: 'shared_canonical_resolver_pending' as const, acceptedAsCompletion: false as const,
      lifecycleAuthority: 'none' as const, mergeAuthority: 'none' as const, deploymentAuthority: 'none' as const };
  }

  private async persistHostEvidence(runtime: FederatedAuthenticatedRuntime, proposal: FederatedResultProposal,
    host: FederatedHostVerification, proposalHash: string) {
    const binding = proposal.binding;
    const artifact = proposal.artifacts[0]!;
    const observedAt = host.observedAt;
    const evidenceId = `evidence:${proposal.proposalId}`;
    const evidenceMaterial = { proposalHash, gitObservationHash: host.gitObservationHash,
      validationObservationHash: host.validationObservationHash, artifactObservationHash: host.artifactObservationHash };
    const payloadHash = governedHash('rorca.federated-host-evidence.v1', evidenceMaterial as never);
    const envelopeMaterial = { schemaVersion: 'rorca.evidence-envelope.v1', contractId: 'rorca.evidence-envelope.v1',
      contractVersion: '1.0.0', artifactId: `artifact:${proposal.proposalId}`, createdAt: observedAt,
      createdBy: 'host:federation-verifier', evidenceId, kind: 'federated_host_verification', trustClass: 'host_observed',
      observerId: 'host:federation-verifier', workspaceId: binding.workspaceId, missionId: binding.missionId,
      missionRevision: binding.missionRevision, workPackageId: binding.workPackageId, workPackageRevision: binding.workPackageRevision,
      specId: binding.specId, specVersion: binding.specVersion, specHash: binding.specHash, storyId: binding.storyId,
      storyVersion: binding.storyVersion, storyHash: binding.storyHash, attemptId: binding.attemptId, leaseId: binding.leaseId,
      fencingToken: binding.fencingToken, policyActivationId: binding.policyActivationId, policyActivationHash: binding.policyActivationHash,
      checkpointId: binding.checkpointId, repositoryId: binding.repositoryId, repositoryRevision: host.headSha,
      worktreeId: binding.worktreeId, observedAt, receivedAt: observedAt, databaseTime: observedAt,
      status: 'passed' as const,
      payloadHash, redactionClass: 'restricted' as const, restrictedRef: {
        referenceId: artifact.restrictedReferenceId, kind: 'artifact' as const, hash: artifact.contentHash,
        sensitivity: 'restricted' as const, retentionClass: 'wave4-federated-result', accessTier: 'admin' as const,
        rawPayloadIncluded: false as const,
      },
      independentReviewProvenanceHash: null };
    const evidenceHash = governedHash('rorca.evidence-envelope.integrity.v1', envelopeMaterial as never);
    const envelope = EvidenceEnvelopeV1Schema.parse({ ...envelopeMaterial, contentHash: evidenceHash, evidenceHash });
    return ingestGovernedEvidence(envelope, { id: 'host:federation-verifier', maximumTrust: 'host_observed',
      correlationId: `federated-result:${proposal.proposalId}` });
  }
}

export function createDatabaseFederatedHostVerificationPorts(): FederatedHostVerificationPorts {
  return {
    async loadWorktree(workspaceId: string, worktreeId: string): Promise<FederatedHostWorktree | null> {
      const row = await canonicalOne<{ worktree: FederatedHostWorktree | null }>(
        'SELECT rorca.load_wave4_federated_host_worktree_v1($1,$2) worktree', [workspaceId, worktreeId]);
      return row?.worktree ?? null;
    },
    async verifyValidation(input): Promise<boolean> {
      const row = await canonicalOne<{ verified: boolean }>(
        'SELECT rorca.verify_wave4_federated_host_validation_v1($1,$2,$3,$4,$5) verified',
        [input.workspaceId, input.attemptId, input.validationId, input.commandHash, input.artifactHash]);
      return row?.verified === true;
    },
    async verifyArtifact(input): Promise<boolean> {
      const row = await canonicalOne<{ verified: boolean }>(
        'SELECT rorca.verify_wave4_federated_host_artifact_v1($1,$2,$3,$4,$5) verified',
        [input.workspaceId, input.artifactId, input.contentHash, input.byteLength, input.restrictedReferenceId]);
      return row?.verified === true;
    },
  };
}
