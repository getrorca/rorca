/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
import { z } from 'zod';
import {
  ArtifactHeaderSchema, CanonicalSpecScopeSchema, CanonicalTimestampSchema, GOVERNED_CONTRACT_LIMITS,
  RepositoryScopeSchema, RestrictedReferenceSchema, Sha256Schema, StableIdSchema,
} from './primitives';

export const ContinuationScopeSchema = z.object({
  workspaceId: StableIdSchema, missionId: StableIdSchema, missionRevision: z.number().int().positive(), missionHash: Sha256Schema,
  workPackageId: StableIdSchema, workPackageRevision: z.number().int().positive(), workPackageHash: Sha256Schema,
  spec: CanonicalSpecScopeSchema, runId: z.union([z.number().int().positive(), StableIdSchema]), attemptId: StableIdSchema,
  leaseId: StableIdSchema, fencingToken: z.number().int().positive(), leaseExpiresAt: CanonicalTimestampSchema, cancellationId: StableIdSchema,
  runtimeId: StableIdSchema, controllerGeneration: z.number().int().nonnegative(), runtimeGeneration: z.number().int().nonnegative(),
  sessionId: StableIdSchema, sessionFileHash: Sha256Schema, turnId: StableIdSchema, turnAttempt: z.number().int().positive(),
  originatingGeneration: z.number().int().nonnegative(), cursor: z.number().int().nonnegative(), cursorHash: Sha256Schema,
  priorEntryId: z.union([StableIdSchema, z.literal('not_applicable')]), repository: RepositoryScopeSchema,
  validationStateHash: Sha256Schema, rootCauseClassification: StableIdSchema, rootCauseHash: Sha256Schema,
  policyDefinitionId: StableIdSchema, policyDefinitionVersion: z.string().regex(/^1\.[0-9]+\.[0-9]+$/), policyDefinitionHash: Sha256Schema,
  policyActivationId: StableIdSchema, policyActivationRevision: z.number().int().positive(), policyActivationHash: Sha256Schema,
}).strict();

export const ActivationScopeSchema = z.object({
  workspaceId: StableIdSchema, missionId: StableIdSchema, missionRevision: z.number().int().positive(), missionHash: Sha256Schema,
  workPackageId: StableIdSchema, workPackageRevision: z.number().int().positive(), workPackageHash: Sha256Schema,
  spec: CanonicalSpecScopeSchema, runId: z.union([z.number().int().positive(), StableIdSchema]), attemptId: StableIdSchema,
  leaseId: StableIdSchema, fencingToken: z.number().int().positive(), cancellationId: StableIdSchema, runtimeId: StableIdSchema,
  repositoryId: StableIdSchema, remoteAuthorityHash: Sha256Schema, baseSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  worktreeId: StableIdSchema, allowedPathManifestHash: Sha256Schema, requiredPathManifestHash: Sha256Schema,
  policyDefinitionId: StableIdSchema, policyDefinitionVersion: z.string(), policyDefinitionHash: Sha256Schema,
}).strict();

const RetryPhaseSchema = z.object({
  retryCycleId: z.union([StableIdSchema, z.literal('not_applicable')]), phase: z.enum(['none', 'started', 'ended', 'settled', 'fenced']),
  attempt: z.number().int().nonnegative(), maximum: z.number().int().nonnegative().max(5),
  startEventHash: z.union([Sha256Schema, z.literal('not_applicable')]), endEventHash: z.union([Sha256Schema, z.literal('not_applicable')]),
  settledEventHash: z.union([Sha256Schema, z.literal('not_applicable')]), generation: z.number().int().nonnegative(),
}).strict();
const CandidateSchema = z.object({
  state: z.enum(['absent', 'observed', 'controller_rejected', 'controller_validated', 'submitted_to_closeout']),
  hash: z.union([Sha256Schema, z.literal('not_applicable')]),
}).strict();

const InitialTrigger = z.object({ type: z.literal('initial_dispatch'), launchRequestId: StableIdSchema, launchRequestHash: Sha256Schema, engineRequestId: StableIdSchema, engineRequestHash: Sha256Schema, sourceManifestHash: Sha256Schema }).strict();
const CompactionTrigger = z.object({
  type: z.literal('successful_compaction'), compactionId: StableIdSchema, startEventId: StableIdSchema, startEventHash: Sha256Schema,
  endEventId: StableIdSchema, endEventHash: Sha256Schema, status: z.literal('success'), aborted: z.literal(false), willRetry: z.literal(false),
  resultHash: Sha256Schema, summaryHash: Sha256Schema, originatingTurnId: StableIdSchema, originatingTurnAttempt: z.number().int().positive(),
  originatingGeneration: z.number().int().nonnegative(), settledEventId: StableIdSchema, settledEventHash: Sha256Schema,
  retry: RetryPhaseSchema.refine((value) => ['none', 'settled', 'fenced'].includes(value.phase), 'retry is not settled/fenced'), candidate: CandidateSchema,
}).strict().refine((value) => !['controller_validated', 'submitted_to_closeout'].includes(value.candidate.state), { path: ['candidate', 'state'], message: 'terminal completion candidate suppresses continuation' });
const RestartTrigger = z.object({ type: z.literal('generation_restart'), priorControllerGeneration: z.number().int().nonnegative(), newControllerGeneration: z.number().int().positive(), priorRuntimeGeneration: z.number().int().nonnegative(), newRuntimeGeneration: z.number().int().positive(), processGroupHash: Sha256Schema, reasonCode: StableIdSchema, evidenceHash: Sha256Schema, priorWriterDeathReceiptHash: Sha256Schema }).strict();
const TransitionTrigger = z.object({ type: z.literal('story_wave_transition'), fromStoryHash: Sha256Schema, toStoryHash: Sha256Schema, fromWaveHash: Sha256Schema, toWaveHash: Sha256Schema, authorityReceiptHash: Sha256Schema }).strict();
const PathTrigger = z.object({ type: z.literal('material_file_scope_change'), priorAllowedHash: Sha256Schema, currentAllowedHash: Sha256Schema, priorRequiredHash: Sha256Schema, currentRequiredHash: Sha256Schema, priorChangedHash: Sha256Schema, currentChangedHash: Sha256Schema, priorForbiddenHash: Sha256Schema, currentForbiddenHash: Sha256Schema, gitStatusHash: Sha256Schema, diffHash: Sha256Schema }).strict();
const ValidationTrigger = z.object({ type: z.literal('validation_root_cause_change'), priorValidationHash: Sha256Schema, currentValidationHash: Sha256Schema, priorRootCauseClass: StableIdSchema, currentRootCauseClass: StableIdSchema, priorRootCauseHash: Sha256Schema, currentRootCauseHash: Sha256Schema, changedReferencesHash: Sha256Schema }).strict();
const MeaningfulRetryTrigger = z.object({ type: z.literal('meaningful_retry'), previewHash: Sha256Schema, receiptHash: Sha256Schema, priorAttempt: z.number().int().positive(), newAttempt: z.number().int().positive(), priorGeneration: z.number().int().nonnegative(), newGeneration: z.number().int().positive(), failedScopeHash: Sha256Schema, changedSourceVectorHash: Sha256Schema }).strict();
const TtlTrigger = z.object({ type: z.literal('ttl_or_source_staleness'), priorBundleId: StableIdSchema, priorBundleHash: Sha256Schema, priorExpiry: CanonicalTimestampSchema, observedAt: CanonicalTimestampSchema, requiredSourceManifestHash: Sha256Schema, advisorySourceManifestHash: Sha256Schema }).strict();
const MissingTrigger = z.object({ type: z.literal('explicit_missing_context'), requestId: StableIdSchema, requestHash: Sha256Schema, eventId: StableIdSchema, eventHash: Sha256Schema, reasonCode: StableIdSchema, missingRequiredManifestHash: Sha256Schema }).strict();
export const TriggerMaterialSchema = z.discriminatedUnion('type', [InitialTrigger, CompactionTrigger, RestartTrigger, TransitionTrigger, PathTrigger, ValidationTrigger, MeaningfulRetryTrigger, TtlTrigger, MissingTrigger]);
export const CONTINUATION_TRIGGER_TYPES = ['initial_dispatch', 'successful_compaction', 'generation_restart', 'story_wave_transition', 'material_file_scope_change', 'validation_root_cause_change', 'meaningful_retry', 'ttl_or_source_staleness', 'explicit_missing_context'] as const;

export const ContextPolicyDefinitionV1Schema = z.object({
  schemaVersion: z.literal('rorca.context-continuation-policy-definition.v1'), contractId: z.literal('rorca.context-continuation-policy-definition.v1'),
  contractVersion: z.string().regex(/^1\.[0-9]+\.[0-9]+$/), policyDefinitionId: StableIdSchema,
  policyDefinitionVersion: z.string().regex(/^1\.[0-9]+\.[0-9]+$/), policyDefinitionHash: Sha256Schema,
  issuerAuthorityRef: StableIdSchema, supportedVersions: z.array(z.string()).min(1), triggerRulesHash: Sha256Schema,
  sourceAllowlistHash: Sha256Schema, redactionPolicyHash: Sha256Schema,
  limits: z.object({ totalTokens: z.number().int().min(1).max(64000), requiredTokens: z.number().int().min(1).max(48000), advisoryTokens: z.number().int().nonnegative().max(8000), instructionTokens: z.number().int().nonnegative().max(8000), requiredSources: z.number().int().min(1).max(500), advisoryItems: z.number().int().nonnegative().max(50), serializedBytes: z.number().int().min(1).max(GOVERNED_CONTRACT_LIMITS.bundleBytes), ttlMinutes: z.number().int().min(1).max(60), deltaChain: z.number().int().min(1).max(8), retrievalAttempts: z.number().int().min(1).max(5), transportReconciliations: z.number().int().min(1).max(3) }).strict(),
  lifecycleState: z.enum(['draft', 'validated', 'published', 'superseded', 'rejected', 'revoked']), createdAt: CanonicalTimestampSchema, createdBy: StableIdSchema,
}).strict();
export const ContextPolicyActivationV1Schema = ArtifactHeaderSchema.extend({
  schemaVersion: z.literal('rorca.context-continuation-policy-activation.v1'), contractId: z.literal('rorca.context-continuation-policy-activation.v1'),
  workspaceId: StableIdSchema, activationId: StableIdSchema, activationRevision: z.number().int().positive(), activationHash: Sha256Schema,
  definitionId: StableIdSchema, definitionVersion: z.string(), definitionHash: Sha256Schema, scope: ActivationScopeSchema,
  effectiveValuesHash: Sha256Schema, authorityReceiptId: StableIdSchema, activatedAt: CanonicalTimestampSchema,
  expiresAt: CanonicalTimestampSchema.nullable(), state: z.enum(['proposed', 'verified', 'active', 'superseded', 'rejected', 'revoked']),
}).strict();

export const ContextCheckpointV1Schema = ArtifactHeaderSchema.extend({
  schemaVersion: z.literal('rorca.context-checkpoint.v1'), contractId: z.literal('rorca.context-checkpoint.v1'),
  scope: ContinuationScopeSchema, checkpointId: StableIdSchema, checkpointSequence: z.number().int().nonnegative(),
  priorCheckpointId: z.union([StableIdSchema, z.literal('not_applicable')]), reasonCode: StableIdSchema, trigger: TriggerMaterialSchema,
  eventHighWaterMark: z.number().int().nonnegative(), planCursorHash: Sha256Schema, completedWorkHash: Sha256Schema,
  pendingWorkHash: Sha256Schema, boundedReferences: z.array(RestrictedReferenceSchema).max(100),
  retry: RetryPhaseSchema, completionCandidate: CandidateSchema, redactionManifestHash: Sha256Schema,
  state: z.enum(['proposed', 'persisted', 'current', 'superseded', 'rejected']),
}).strict();

const SourceRecordSchema = z.object({ contextClass: z.enum(['required', 'advisory']), sourceType: StableIdSchema, stableSourceId: StableIdSchema, sourceVersion: z.string(), contentHash: Sha256Schema, freshness: z.enum(['current', 'stale', 'unavailable']), excluded: z.boolean(), redactionHash: Sha256Schema }).strict();
const TokenAccountingSchema = z.object({ required: z.number().int().nonnegative(), advisory: z.number().int().nonnegative(), instructions: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).strict();
export const RetrievalReceiptV1Schema = ArtifactHeaderSchema.extend({
  schemaVersion: z.literal('rorca.retrieval-receipt.v1'), contractId: z.literal('rorca.retrieval-receipt.v1'),
  scope: ContinuationScopeSchema, requestId: StableIdSchema, receiptId: StableIdSchema, checkpointId: StableIdSchema,
  definitionHash: Sha256Schema, activationHash: Sha256Schema, retrievalKey: Sha256Schema,
  sources: z.array(SourceRecordSchema).max(550), requiredComplete: z.boolean(),
  tokenAccounting: TokenAccountingSchema,
  outputId: StableIdSchema.nullable(), outputHash: Sha256Schema.nullable(), startedAt: CanonicalTimestampSchema,
  finishedAt: CanonicalTimestampSchema, status: z.enum(['requested', 'assembling', 'completed', 'degraded', 'failed', 'rejected']),
  reasonCode: StableIdSchema, retryable: z.boolean(), retryBudgetId: StableIdSchema,
}).strict().superRefine((value, ctx) => {
  if (value.status === 'degraded' && !value.requiredComplete) ctx.addIssue({ code: 'custom', path: ['status'], message: 'degraded requires complete required context' });
  if (value.tokenAccounting.total > 64000 || value.tokenAccounting.required > 48000) ctx.addIssue({ code: 'custom', path: ['tokenAccounting'], message: 'token budget exceeded' });
  if (value.tokenAccounting.total !== value.tokenAccounting.required + value.tokenAccounting.advisory + value.tokenAccounting.instructions) ctx.addIssue({ code: 'custom', path: ['tokenAccounting', 'total'], message: 'token total mismatch' });
  if (Date.parse(value.finishedAt) < Date.parse(value.startedAt)) ctx.addIssue({ code: 'custom', path: ['finishedAt'], message: 'receipt finish precedes start' });
  if (['completed', 'degraded'].includes(value.status) && (!value.outputId || !value.outputHash)) ctx.addIssue({ code: 'custom', path: ['outputId'], message: 'completed receipt output identity required' });
  const keys = value.sources.map((source) => `${source.contextClass}\u0000${source.sourceType}\u0000${source.stableSourceId}\u0000${source.sourceVersion}\u0000${source.contentHash}`);
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', path: ['sources'], message: 'duplicate source identity' });
  const firstAdvisory = value.sources.findIndex((source) => source.contextClass === 'advisory');
  if (firstAdvisory >= 0 && value.sources.slice(firstAdvisory).some((source) => source.contextClass === 'required')) ctx.addIssue({ code: 'custom', path: ['sources'], message: 'required sources must precede advisory sources' });
});

export const ContextBundleV1Schema = ArtifactHeaderSchema.extend({
  schemaVersion: z.literal('rorca.context-bundle.v1'), contractId: z.literal('rorca.context-bundle.v1'),
  scope: ContinuationScopeSchema, bundleId: StableIdSchema, bundleVersion: z.number().int().positive(), bundleHash: Sha256Schema,
  checkpointId: StableIdSchema, checkpointHash: Sha256Schema, receiptId: StableIdSchema, receiptHash: Sha256Schema,
  definitionHash: Sha256Schema, activationHash: Sha256Schema,
  requiredContext: z.array(SourceRecordSchema.refine((value) => value.contextClass === 'required')).min(1).max(500),
  advisoryMemory: z.array(SourceRecordSchema.refine((value) => value.contextClass === 'advisory')).max(50),
  orderedSourceHash: Sha256Schema, redactionManifestHash: Sha256Schema, tokenAllocationHash: Sha256Schema,
  tokenAccounting: TokenAccountingSchema, serializedBytes: z.number().int().positive().max(GOVERNED_CONTRACT_LIMITS.bundleBytes), expiresAt: CanonicalTimestampSchema,
  state: z.enum(['assembled', 'verified', 'active', 'superseded', 'rejected', 'stale']),
}).strict().superRefine((value, ctx) => {
  if (value.tokenAccounting.total !== value.tokenAccounting.required + value.tokenAccounting.advisory + value.tokenAccounting.instructions) ctx.addIssue({ code: 'custom', path: ['tokenAccounting', 'total'], message: 'token total mismatch' });
  if (Date.parse(value.expiresAt) <= Date.parse(value.createdAt)) ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: 'bundle expiry must follow creation' });
});

export const ContextBundleDeltaV1Schema = ArtifactHeaderSchema.extend({
  schemaVersion: z.literal('rorca.context-bundle-delta.v1'), contractId: z.literal('rorca.context-bundle-delta.v1'),
  scope: ContinuationScopeSchema, deltaId: StableIdSchema, baseBundleId: StableIdSchema, baseBundleHash: Sha256Schema,
  targetBundleId: StableIdSchema, targetScopeHash: Sha256Schema, operations: z.array(z.object({ index: z.number().int().nonnegative(), type: z.enum(['add', 'remove', 'replace']), path: z.string().min(1), valueHash: Sha256Schema.nullable() }).strict()).max(1000),
  operationListHash: Sha256Schema, reconstructedTargetHash: Sha256Schema, chainDepth: z.number().int().min(1).max(8),
  verificationReceiptHash: Sha256Schema, state: z.enum(['proposed', 'verified', 'applied', 'rejected', 'stale', 'superseded']),
  fallbackReason: StableIdSchema.nullable(),
}).strict();

export const ContinuationDispatchV1Schema = ArtifactHeaderSchema.extend({
  schemaVersion: z.literal('rorca.continuation-dispatch.v1'), contractId: z.literal('rorca.continuation-dispatch.v1'),
  scope: ContinuationScopeSchema, dispatchId: StableIdSchema, continuationKey: Sha256Schema, trigger: TriggerMaterialSchema,
  checkpointId: StableIdSchema, checkpointHash: Sha256Schema, receiptId: StableIdSchema, receiptHash: Sha256Schema,
  bundleId: StableIdSchema, bundleHash: Sha256Schema, definitionHash: Sha256Schema, activationHash: Sha256Schema,
  targetSessionId: StableIdSchema, targetCursor: z.number().int().nonnegative(), priorEntryId: z.union([StableIdSchema, z.literal('not_applicable')]),
  expectedCursorAdvance: z.number().int().positive(), renderedPayloadHash: Sha256Schema, renderedPayloadRef: RestrictedReferenceSchema,
  firstLeaseVerificationHash: Sha256Schema, casLeaseVerificationHash: Sha256Schema, authorizationExpiresAt: CanonicalTimestampSchema,
  controllerId: StableIdSchema, adapterVersion: z.string(), attempt: z.number().int().positive(), retryBudgetId: StableIdSchema,
  state: z.enum(['proposed', 'lease_verified', 'authorized', 'dispatched', 'settled', 'rejected', 'expired', 'failed', 'quarantined']), reasonCode: StableIdSchema,
}).strict();

export const ContinuationRetryBudgetV1Schema = z.object({
  schemaVersion: z.literal('rorca.continuation-retry-budget.v1'), workspaceId: StableIdSchema,
  retryBudgetId: StableIdSchema, continuationKey: Sha256Schema, scope: ContinuationScopeSchema,
  checkpointHash: Sha256Schema, bundleHash: Sha256Schema,
  retrievalMaximum: z.number().int().min(1).max(5), retrievalSpent: z.number().int().nonnegative().max(5),
  transportMaximum: z.number().int().min(1).max(3), transportSpent: z.number().int().nonnegative().max(3),
  inFlightOwner: StableIdSchema.nullable(), retryFence: z.number().int().nonnegative(), retryExpiresAt: CanonicalTimestampSchema.nullable(),
  nextRetryAt: CanonicalTimestampSchema.nullable(), permanentConflictCount: z.number().int().nonnegative(),
  state: z.enum(['open', 'in_flight', 'backoff', 'closed', 'exhausted', 'quarantined']), reasonCode: StableIdSchema,
}).strict();

export const ContextEpochProjectionV0Schema = z.object({
  schemaVersion: z.literal('rorca.context-epoch-projection.v0'), legacyEpochId: z.string().regex(/^ctxe_[a-f0-9]{64}$/),
  checkpointId: StableIdSchema, checkpointVersion: z.number().int().positive(), checkpointHash: Sha256Schema,
  policyDefinitionId: StableIdSchema, policyDefinitionVersion: z.string(), policyDefinitionHash: Sha256Schema,
  policyActivationId: StableIdSchema, policyActivationRevision: z.number().int().positive(), policyActivationHash: Sha256Schema,
  retrievalReceiptId: StableIdSchema, retrievalReceiptVersion: z.number().int().positive(), retrievalReceiptHash: Sha256Schema,
  contextBundleId: StableIdSchema, contextBundleVersion: z.number().int().positive(), contextBundleHash: Sha256Schema,
  continuationDispatchId: z.union([StableIdSchema, z.literal('not_applicable')]), continuationDispatchVersion: z.union([z.number().int().positive(), z.literal('not_applicable')]), continuationDispatchHash: z.union([Sha256Schema, z.literal('not_applicable')]),
  projectionOnly: z.literal(true), authoritative: z.literal(false), generatedAt: CanonicalTimestampSchema, compatibilityRemovalNotBefore: CanonicalTimestampSchema,
}).strict();

export type ContinuationScope = z.infer<typeof ContinuationScopeSchema>;
