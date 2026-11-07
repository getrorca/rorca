/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */
import { z } from 'zod';
import {
  CancellationV1Schema, ExecutionLeaseV1Schema, PlanChangeProposalV1Schema, RuntimeEventV1Schema,
} from './governed-contracts';
import { RuntimeTelemetryBatchV1Schema } from './governed-contracts/run-stream';
import {
  CanonicalTimestampSchema, FullGitShaSchema, SafeRelativePathSchema, Sha256Schema, StableIdSchema,
} from './governed-contracts/primitives';

const IdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{1,199}$/);
const ContractVersionsSchema = z.tuple([z.literal('1.0.0')]);

export const FederatedRuntimeRegistrationSchema = z.object({
  schemaVersion: z.literal('rorca.federated-runtime-registration.v1'), runtimeId: StableIdSchema,
  workspaceId: StableIdSchema, credentialVersion: z.number().int().positive(), keyVersion: z.number().int().positive(),
  credentialDigest: Sha256Schema, endpoint: z.string().url().max(2048).refine((value) => value.startsWith('https://'), 'runtime endpoint must use HTTPS'),
  allowedContractVersions: ContractVersionsSchema, allowedPaths: z.array(SafeRelativePathSchema).max(500),
  mutationBoundsHash: Sha256Schema, status: z.enum(['active', 'disabled', 'revoked']), expiresAt: CanonicalTimestampSchema,
  auditProvenanceHash: Sha256Schema, registeredBy: StableIdSchema, idempotencyKey: IdempotencyKeySchema,
  controlPlaneCredentials: z.literal(false), databaseCredentials: z.literal(false), githubCredentials: z.literal(false),
  modelProviderCredentials: z.literal(false), providerHumanCredentials: z.literal(false), mergeAuthority: z.literal(false),
  deploymentAuthority: z.literal(false),
}).strict();

export const FederatedDiscoveryRequestSchema = z.object({
  schemaVersion: z.literal('rorca.federated-discovery-request.v1'), workspaceId: StableIdSchema,
  runtimeId: StableIdSchema, contractVersions: ContractVersionsSchema, limit: z.number().int().min(1).max(10).default(1),
}).strict();

export const FederatedLeaseBindingSchema = z.object({
  workspaceId: StableIdSchema, runtimeId: StableIdSchema, missionId: StableIdSchema, missionRevision: z.number().int().positive(),
  missionHash: Sha256Schema, workPackageId: StableIdSchema, workPackageRevision: z.number().int().positive(), workPackageHash: Sha256Schema,
  specId: StableIdSchema, specVersion: z.number().int().positive(), specHash: Sha256Schema, storyId: StableIdSchema,
  storyVersion: z.number().int().positive(), storyHash: Sha256Schema, criteriaManifestHash: Sha256Schema,
  attemptId: StableIdSchema, leaseId: StableIdSchema, fencingToken: z.number().int().positive(), expectedLeaseExpiresAt: CanonicalTimestampSchema,
  policyDefinitionHash: Sha256Schema, policyActivationId: StableIdSchema, policyActivationRevision: z.number().int().positive(), policyActivationHash: Sha256Schema,
  checkpointId: StableIdSchema, checkpointHash: Sha256Schema, retrievalReceiptId: StableIdSchema, retrievalReceiptHash: Sha256Schema,
  bundleId: StableIdSchema, bundleHash: Sha256Schema, dispatchId: z.union([StableIdSchema, z.literal('not_applicable')]),
  dispatchHash: z.union([Sha256Schema, z.literal('not_applicable')]), repositoryId: StableIdSchema, remoteAuthorityHash: Sha256Schema,
  baseSha: FullGitShaSchema, currentSha: FullGitShaSchema, expectedHeadSha: FullGitShaSchema, worktreeId: StableIdSchema,
  allowedPathManifestHash: Sha256Schema, requiredPathManifestHash: Sha256Schema, changedPathManifestHash: Sha256Schema,
  forbiddenPathManifestHash: Sha256Schema, validationManifestHash: Sha256Schema,
}).strict();

export const FederatedAcquireRequestSchema = z.object({
  schemaVersion: z.literal('rorca.federated-acquire-request.v1'), offerId: StableIdSchema,
  bindingHash: Sha256Schema, binding: FederatedLeaseBindingSchema,
  generation: z.number().int().nonnegative(), sessionId: StableIdSchema, sessionFileHash: Sha256Schema,
  turnId: StableIdSchema, originatingGeneration: z.number().int().nonnegative(),
  cursor: z.number().int().nonnegative(), cursorHash: Sha256Schema, idempotencyKey: IdempotencyKeySchema,
}).strict();

export const FederatedWorkPackageReadRequestSchema = z.object({
  schemaVersion: z.literal('rorca.federated-work-package-read-request.v1'), binding: FederatedLeaseBindingSchema,
  generation: z.number().int().nonnegative(), sessionId: StableIdSchema,
}).strict();

export const FederatedRenewRequestSchema = z.object({
  schemaVersion: z.literal('rorca.federated-renew-request.v1'), binding: FederatedLeaseBindingSchema,
  generation: z.number().int().nonnegative(), sessionId: StableIdSchema, expectedStateVersion: z.number().int().positive(),
  extendSeconds: z.number().int().min(1).max(3600), idempotencyKey: IdempotencyKeySchema,
}).strict();

export const FederatedReleaseRequestSchema = z.object({
  schemaVersion: z.literal('rorca.federated-release-request.v1'), binding: FederatedLeaseBindingSchema,
  generation: z.number().int().nonnegative(), sessionId: StableIdSchema, expectedStateVersion: z.number().int().positive(),
  reasonCode: StableIdSchema, idempotencyKey: IdempotencyKeySchema,
}).strict();

export const FederatedEventRequestSchema = z.object({
  schemaVersion: z.literal('rorca.federated-event-request.v1'), binding: FederatedLeaseBindingSchema,
  event: RuntimeEventV1Schema, idempotencyKey: IdempotencyKeySchema,
}).strict();

export const FederatedActivityRequestSchema = z.object({
  schemaVersion: z.literal('rorca.federated-activity-request.v1'), binding: FederatedLeaseBindingSchema,
  batch: RuntimeTelemetryBatchV1Schema, idempotencyKey: IdempotencyKeySchema,
}).strict();

const ArtifactReferenceSchema = z.object({
  artifactId: StableIdSchema, contentHash: Sha256Schema, byteLength: z.number().int().min(0).max(64 * 1024 * 1024),
  restrictedReferenceId: StableIdSchema,
}).strict();
const ValidationClaimSchema = z.object({
  validationId: StableIdSchema, commandHash: Sha256Schema, claimedOutcome: z.enum(['passed', 'failed']),
  artifactHash: Sha256Schema, observedAt: CanonicalTimestampSchema,
}).strict();

export const FederatedResultProposalSchema = z.object({
  schemaVersion: z.literal('rorca.federated-result-proposal.v1'), contractVersion: z.literal('1.0.0'),
  proposalId: StableIdSchema, binding: FederatedLeaseBindingSchema, generation: z.number().int().nonnegative(),
  sessionId: StableIdSchema, terminalSequence: z.number().int().nonnegative(),
  completionCandidateState: z.enum(['controller_validated', 'submitted_to_closeout']), completionCandidateHash: Sha256Schema,
  changedPaths: z.array(SafeRelativePathSchema).max(500), changedPathHash: Sha256Schema,
  validations: z.array(ValidationClaimSchema).min(1).max(100), validationSetHash: Sha256Schema,
  artifacts: z.array(ArtifactReferenceSchema).min(1).max(100), artifactSetHash: Sha256Schema,
  outcomeClaim: z.enum(['succeeded', 'failed', 'cancelled', 'validation_failed', 'fenced']),
  observedHeadSha: FullGitShaSchema, submittedAt: CanonicalTimestampSchema, idempotencyKey: IdempotencyKeySchema,
  closeoutAuthority: z.literal('none'), lifecycleAuthority: z.literal('none'), mergeAuthority: z.literal('none'),
  deploymentAuthority: z.literal('none'),
}).strict();

export const FederatedCancellationAcknowledgementSchema = z.object({
  schemaVersion: z.literal('rorca.federated-cancellation-acknowledgement.v1'), binding: FederatedLeaseBindingSchema,
  cancellation: CancellationV1Schema, generation: z.number().int().nonnegative(), sessionId: StableIdSchema,
  idempotencyKey: IdempotencyKeySchema,
}).strict();

export const FederatedPlanChangeRequestSchema = z.object({
  schemaVersion: z.literal('rorca.federated-plan-change-request.v1'), binding: FederatedLeaseBindingSchema,
  proposal: PlanChangeProposalV1Schema, generation: z.number().int().nonnegative(), sessionId: StableIdSchema,
  exactDiffHash: Sha256Schema, contextChangesHash: Sha256Schema, idempotencyKey: IdempotencyKeySchema,
}).strict();

export const FederatedRecoveryRequestSchema = z.object({
  schemaVersion: z.literal('rorca.federated-recovery-request.v1'), binding: FederatedLeaseBindingSchema,
  generation: z.number().int().nonnegative(), sessionId: StableIdSchema, sessionFileHash: Sha256Schema,
  turnId: StableIdSchema, originatingGeneration: z.number().int().nonnegative(), cursor: z.number().int().nonnegative(),
  cursorHash: Sha256Schema, bundleHash: Sha256Schema, idempotencyKey: IdempotencyKeySchema,
}).strict();

export type FederatedRuntimeRegistration = z.infer<typeof FederatedRuntimeRegistrationSchema>;
export type FederatedLeaseBinding = z.infer<typeof FederatedLeaseBindingSchema>;
export type FederatedAcquireRequest = z.infer<typeof FederatedAcquireRequestSchema>;
export type FederatedResultProposal = z.infer<typeof FederatedResultProposalSchema>;
export type FederatedRecoveryRequest = z.infer<typeof FederatedRecoveryRequestSchema>;
export type FederatedCancellationAcknowledgement = z.infer<typeof FederatedCancellationAcknowledgementSchema>;
export type FederatedPlanChangeRequest = z.infer<typeof FederatedPlanChangeRequestSchema>;
export type FederatedEventRequest = z.infer<typeof FederatedEventRequestSchema>;
export type FederatedActivityRequest = z.infer<typeof FederatedActivityRequestSchema>;
export type ExactExecutionLease = z.infer<typeof ExecutionLeaseV1Schema>;
