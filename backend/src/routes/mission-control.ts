/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
import { json, Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { queryOne, transaction } from '../db/index';
import type { QueryResultRow } from 'pg';
import { AdminRequiredError, AuthError, ForbiddenError, GoneError, NotFoundError, PayloadTooLargeError, UnprocessableError, ValidationError } from '../lib/errors';
import { INTERNAL_SERVICE_USER_ID, requireWorkspaceMember } from '../lib/auth-utils';
import {
  CancellationV1Schema, CloseoutEvaluationV1Schema, ContextBundleDeltaV1Schema, ContextCheckpointV1Schema,
  ContextBundleV1Schema, ContextPolicyActivationV1Schema, ContextPolicyDefinitionV1Schema, ContinuationDispatchV1Schema,
  ContinuationRetryBudgetV1Schema, EvidenceEnvelopeV1Schema, ExecutionLeaseV1Schema, MissionContractV1Schema,
  PlanChangeProposalV1Schema, RetrievalReceiptV1Schema, RuntimeEventV1Schema, RuntimeTelemetryBatchV1Schema,
  RunStreamEnvelopeV1Schema, RUN_STREAM_OPERATIONAL_PLANES, WorkPackageV1Schema, contextEpochProjectionId,
} from '../lib/governed-contracts';
import {
  FederatedAcquireRequestSchema, FederatedActivityRequestSchema, FederatedCancellationAcknowledgementSchema,
  FederatedDiscoveryRequestSchema, FederatedEventRequestSchema, FederatedLeaseBindingSchema,
  FederatedPlanChangeRequestSchema, FederatedRecoveryRequestSchema, FederatedReleaseRequestSchema,
  FederatedRenewRequestSchema, FederatedResultProposalSchema, FederatedWorkPackageReadRequestSchema,
} from '../lib/federated-runtime-contracts';
import {
  acknowledgeExecutionCancellation, acquireExecutionLease, activateContextPolicy, authorizeContinuationDispatch,
  acceptContinuationDispatchDelivery, authorizeContinuationDispatchSend, claimContinuationDispatchOutbox, claimContinuationRetry, compileGovernedMission, consumeContinuationDispatch, createWorkPackageRevision, evaluateGovernedCloseout,
  ingestGovernedEvidence, ingestRuntimeEvent, persistContextBundle, persistContextBundleDelta, persistContextCheckpoint,
  persistContinuationRetryBudget, persistRetrievalReceipt, publishContextPolicyDefinition,
  recordContextEpochRetirementEvaluation, releaseExecutionLease, renewExecutionLease, requestExecutionCancellation,
  reviewPlanChangeProposal, settleContinuationDispatchOutbox, settleContinuationRetry, submitPlanChangeProposal,
  type GovernedMutationContext,
} from '../lib/governed-mission-service';
import { validateBody } from '../lib/validate';
import runActivityRouter from './run-activity';
const router = Router();
type RawBoundedRequest = Request & { missionControlRawBodyBytes?: number };
router.use(json({ limit: '4mb', verify: (req, _res, bytes) => {
  (req as RawBoundedRequest).missionControlRawBodyBytes = bytes.byteLength;
} }));
router.use((req, _res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const bytes = (req as RawBoundedRequest).missionControlRawBodyBytes ?? 0;
  const limit = req.path === '/runtime/context-bundles' ? 4 * 1024 * 1024
    : ['/events', '/runtime/events', '/evidence', '/runtime/evidence'].includes(req.path) ? 64 * 1024 : 256 * 1024;
  if (bytes > limit) return next(new PayloadTooLargeError(`Mission-control payload exceeds ${limit} bytes`));
  next();
});
// Wave 3B owns exact membership/runtime authentication inside this bounded
// child router. Mount before the parent mutation capability classifier so the
// federated seam cannot be mistaken for an operator mutation.
router.use('/run-activity', runActivityRouter);
const WorkspaceQuerySchema = z.object({ workspaceId: z.string().min(2).max(128), limit: z.coerce.number().int().min(1).max(100).default(25), cursor: z.coerce.number().int().nonnegative().default(0) }).strict();
const MissionRequestSchema = z.object({ artifact: MissionContractV1Schema, expectedStateVersion: z.number().int().positive().nullable() }).strict();
const WorkPackageRequestSchema = z.object({ artifact: WorkPackageV1Schema, expectedStateVersion: z.number().int().positive().nullable() }).strict();
const AttemptQuerySchema = z.object({ workspaceId: z.string().min(2).max(128), attemptId: z.string().min(2).max(128),
  limit: z.coerce.number().int().min(1).max(100).default(25), cursor: z.coerce.number().int().nonnegative().default(0) }).strict();
const RenewLeaseSchema = z.object({ workspaceId: z.string(), fencingToken: z.number().int().positive(), runtimeId: z.string(), expectedStateVersion: z.number().int().positive(), extendSeconds: z.number().int().min(1).max(3600) }).strict();
const ReleaseLeaseSchema = z.object({ workspaceId: z.string(), fencingToken: z.number().int().positive(), runtimeId: z.string(),
  expectedStateVersion: z.number().int().positive(), reasonCode: z.string().regex(/^[A-Za-z][A-Za-z0-9._:-]{1,127}$/) }).strict();
const CancellationAcknowledgementSchema = z.object({ artifact: CancellationV1Schema, runtimeId: z.string().min(2).max(128) }).strict();
const PolicyDefinitionRequestSchema = z.object({
  workspaceId: z.string().min(2).max(128),
  authorityReceiptId: z.string().regex(/^[A-Za-z][A-Za-z0-9._:-]{1,127}$/),
  artifact: ContextPolicyDefinitionV1Schema,
}).strict();
const ProposalReviewSchema = z.object({ workspaceId: z.string().min(2).max(128), proposalId: z.string().min(2).max(128),
  expectedStateVersion: z.number().int().positive(), decision: z.enum(['under_review', 'accepted', 'rejected', 'stale']),
  reasonCode: z.string().regex(/^[A-Za-z][A-Za-z0-9._:-]{1,127}$/) }).strict();
const DeltaRequestSchema = z.object({ artifact: ContextBundleDeltaV1Schema }).strict();
const DispatchConsumptionSchema = z.object({ workspaceId: z.string(), dispatchId: z.string(), continuationKey: z.string(), leaseId: z.string(),
  fencingToken: z.number().int().positive(), runtimeId: z.string() }).strict();
const DispatchOutboxClaimSchema = z.object({ workspaceId: z.string().min(2).max(128), dispatchId: z.string().min(2).max(128),
  owner: z.string().min(2).max(128), claimSeconds: z.number().int().min(5).max(300) }).strict();
const RetryClaimSchema = z.object({ workspaceId: z.string().min(2).max(128), continuationKey: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  actorAttemptId: z.string().min(2).max(128), runtimeId: z.string().min(2).max(128), owner: z.string().min(2).max(128),
  phase: z.enum(['retrieval', 'transport']), failureReason: z.string().min(2).max(128).optional() }).strict();
const RetrySettleSchema = z.object({ workspaceId: z.string().min(2).max(128), continuationKey: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  runtimeId: z.string().min(2).max(128), owner: z.string().min(2).max(128), retryFence: z.number().int().positive(),
  phase: z.enum(['retrieval', 'transport']), outcome: z.enum(['succeeded', 'retryable_failed', 'permanent_conflict', 'released']),
  reasonCode: z.string().regex(/^[A-Za-z][A-Za-z0-9._:-]{1,127}$/), backoffSeconds: z.number().int().min(1).max(300).optional() }).strict();
const DispatchSendAuthorizationSchema = z.object({ workspaceId: z.string().min(2).max(128), dispatchId: z.string().min(2).max(128),
  owner: z.string().min(2).max(128), claimFence: z.number().int().positive(), deliveryKey: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  payloadHash: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict();
const ContinuationReceiverPayloadSchema=z.object({schemaVersion:z.literal('rorca.continuation-receiver-payload.v1'),
  dispatchId:z.string().min(2).max(128),continuationKey:z.string().regex(/^sha256:[a-f0-9]{64}$/),leaseId:z.string().min(2).max(128),
  fencingToken:z.number().int().positive(),bundleId:z.string().min(2).max(128)}).strict();
const DispatchAcceptanceSchema = z.object({ workspaceId: z.string().min(2).max(128), dispatchId: z.string().min(2).max(128),
  owner: z.string().min(2).max(128), claimFence: z.number().int().positive(), sendAuthorizationHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  deliveryKey: z.string().regex(/^sha256:[a-f0-9]{64}$/), payloadHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  payload:ContinuationReceiverPayloadSchema }).strict();
const DispatchOutboxSettleSchema = z.object({ workspaceId: z.string().min(2).max(128), dispatchId: z.string().min(2).max(128),
  owner: z.string().min(2).max(128), claimFence: z.number().int().positive(), sendAuthorizationHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  receiverAcceptanceReceiptHash: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable(),
  outcome: z.enum(['sent', 'failed_retryable', 'failed_permanent', 'unknown']), transportAccepted: z.boolean(),
  transportReceiptHash: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable(),
  reasonCode: z.string().regex(/^[A-Za-z][A-Za-z0-9._:-]{1,127}$/) }).strict();
const EpochRetirementSchema = z.object({ workspaceId: z.string().min(2).max(128), evaluationId: z.string().min(2).max(128),
  nextMajorVersion: z.string().regex(/^\d+\.0\.0$/), evidence: z.object({
    migrationFixtureEvidenceHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    rollbackFixtureEvidenceHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    breakMarkerEvidenceHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    releaseNotesHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    nextMajorDeclarationHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    independentReviewReceiptId: z.string().min(2).max(128),
    independentReviewEvidenceHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  }).strict() }).strict();

const RunActivityPageWireSchema = z.object({
  schemaVersion: z.literal('rorca.run-activity-page.v1'),
  status: z.enum(['ok', 'gap', 'reset']),
  resetReason: z.enum(['cursor_invalid', 'cursor_expired', 'scope_mismatch', 'future_sequence', 'hash_mismatch',
    'pruned', 'generation_changed', 'stream_not_found']).nullable(),
  streamId: z.string().nullable(),
  runtimeGeneration: z.number().int().nonnegative().nullable(),
  firstRetainedSequence: z.number().int().positive().nullable(),
  lastDurableSequence: z.number().int().nonnegative().nullable(),
  events: z.array(RunStreamEnvelopeV1Schema).max(100),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  authoritative: z.literal(false),
  authorityEffect: z.literal('none'),
}).strict();
const RunActivityTelemetryReceiptWireSchema = z.object({
  schemaVersion: z.literal('rorca.runtime-telemetry-receipt.v1'),
  duplicate: z.boolean(),
  batchId: z.string(),
  firstStreamSequence: z.number().int().positive(),
  lastStreamSequence: z.number().int().positive(),
  eventCount: z.number().int().positive(),
  projectionOnly: z.literal(true),
  authorityEffect: z.literal('none'),
}).strict();
const RunActivityPlaneWireSchema = z.object({
  plane: z.enum(RUN_STREAM_OPERATIONAL_PLANES),
  status: z.enum(['active', 'healthy', 'degraded', 'failed', 'stale', 'rejected', 'authorized', 'dispatched',
    'settled', 'gap', 'quarantined', 'unknown']),
  sourceClass: z.string().nullable(),
  sourceIdentity: z.string().nullable(),
  sourceHash: z.string().nullable(),
  observedAt: z.string().nullable(),
  validUntil: z.string().nullable(),
  reasonCode: z.string(),
  impact: z.string(),
  nextSafeAction: z.string(),
  observationSequence: z.union([z.number().int().nonnegative(), z.string()]).nullable().optional(),
}).strict();
const RunActivityProjectionWireSchema = z.object({
  schemaVersion: z.literal('rorca.run-activity-projection.v1'),
  streamId: z.string().nullable(),
  runtimeGeneration: z.number().int().nonnegative().nullable(),
  lastSequence: z.number().int().nonnegative(),
  lastEventHash: z.string().nullable(),
  eventCount: z.number().int().nonnegative(),
  incomplete: z.boolean(),
  gap: z.object({ expectedSequence: z.number().int().positive(), observedSequence: z.number().int().positive(),
    reasonCode: z.string() }).strict().nullable(),
  transport: z.enum(['empty', 'open', 'closed', 'throttled', 'terminated']),
  lease: z.enum(['unknown', 'active', 'stale', 'expired', 'released', 'cancelled']),
  cancellation: z.enum(['none', 'requested', 'acknowledged', 'settled']),
  context: z.enum(['unknown', 'compacting', 'compacted', 'aborted', 'retrying', 'settled', 'stale', 'rejected',
    'quarantined']),
  completionCandidate: z.enum(['absent', 'observed', 'controller_rejected', 'controller_validated',
    'submitted_to_closeout']),
  retryBudget: z.object({ state: z.enum(['none', 'available', 'backoff', 'exhausted', 'quarantined']),
    spent: z.number().int().nonnegative(), maximum: z.number().int().nonnegative() }).strict(),
  closeout: z.object({ decisionId: z.string(), decisionHash: z.string(), status: z.enum(['accepted', 'blocked']),
    verified: z.literal(true) }).strict().nullable(),
  establishesStoryCompletion: z.boolean(),
  operationalPlanes: z.record(z.enum(RUN_STREAM_OPERATIONAL_PLANES), RunActivityPlaneWireSchema),
}).strict();
const RunActivityStateWireSchema = z.object({
  schemaVersion: z.literal('rorca.run-view-state.v1'),
  state: z.enum(['empty', 'replaying', 'live', 'reconnecting', 'gap', 'stale', 'degraded', 'rejected',
    'quarantined', 'error', 'transport_closed', 'story_accepted']),
  projection: RunActivityProjectionWireSchema,
  operationalPlanes: z.array(RunActivityPlaneWireSchema).length(7),
  planeCount: z.literal(7),
  notices: z.array(z.string()).length(2),
  authorityLabels: z.object({
    terminalOutput: z.literal('observability_only'),
    runtimeAssertion: z.literal('observability_only'),
    completionCandidate: z.literal('proposal_only'),
    storyCompletion: z.literal('verified_StoryCloseoutDecision.accepted_only'),
    runLifecycle: z.literal('separate_host_authority'),
    mergeDeploymentProduction: z.literal('not_authorized'),
  }).strict(),
  authoritative: z.literal(false),
  authorityEffect: z.literal('none'),
}).strict();
const RunActivityLiveFrameWireSchema = z.union([
  RunStreamEnvelopeV1Schema,
  RunActivityPageWireSchema,
  z.object({ reasonCode: z.literal('slow_client'), retryAfterMs: z.number().int().positive(),
    cursor: z.string().nullable() }).strict(),
  z.object({ code: z.literal('RUN_ACTIVITY_STREAM_ERROR'), retryable: z.literal(true) }).strict(),
]);

export const missionControlRequestSchemas: Record<string, z.ZodType> = {
  '/api/mission-control/v1/missions/compile': MissionRequestSchema,
  '/api/mission-control/v1/work-packages/revisions': WorkPackageRequestSchema,
  '/api/mission-control/v1/leases/acquire': ExecutionLeaseV1Schema,
  '/api/mission-control/v1/leases/{leaseId}/renew': RenewLeaseSchema,
  '/api/mission-control/v1/leases/{leaseId}/release': ReleaseLeaseSchema,
  '/api/mission-control/v1/context/policy-definitions': PolicyDefinitionRequestSchema,
  '/api/mission-control/v1/context/policy-activations': ContextPolicyActivationV1Schema,
  '/api/mission-control/v1/runtime/retrieval-receipts': RetrievalReceiptV1Schema,
  '/api/mission-control/v1/runtime/context-bundles': ContextBundleV1Schema,
  '/api/mission-control/v1/runtime/context-deltas': DeltaRequestSchema,
  '/api/mission-control/v1/context/retry-budgets': ContinuationRetryBudgetV1Schema,
  '/api/mission-control/v1/runtime/retries/claim': RetryClaimSchema,
  '/api/mission-control/v1/runtime/retries/settle': RetrySettleSchema,
  '/api/mission-control/v1/runtime/dispatches/authorize': ContinuationDispatchV1Schema,
  '/api/mission-control/v1/runtime/dispatches/consume': DispatchConsumptionSchema,
  '/api/mission-control/v1/internal/dispatch-outbox/claim': DispatchOutboxClaimSchema,
  '/api/mission-control/v1/internal/dispatch-outbox/authorize-send': DispatchSendAuthorizationSchema,
  '/api/mission-control/v1/internal/dispatch-outbox/accept': DispatchAcceptanceSchema,
  '/api/mission-control/v1/internal/dispatch-outbox/settle': DispatchOutboxSettleSchema,
  '/api/mission-control/v1/runtime/checkpoints': ContextCheckpointV1Schema,
  '/api/mission-control/v1/events': RuntimeEventV1Schema,
  '/api/mission-control/v1/runtime/events': RuntimeEventV1Schema,
  '/api/mission-control/v1/runtime/evidence': EvidenceEnvelopeV1Schema,
  '/api/mission-control/v1/evidence': EvidenceEnvelopeV1Schema,
  '/api/mission-control/v1/runtime/plan-change-proposals': PlanChangeProposalV1Schema,
  '/api/mission-control/v1/plan-change-proposals/review': ProposalReviewSchema,
  '/api/mission-control/v1/closeout/evaluate': CloseoutEvaluationV1Schema,
  '/api/mission-control/v1/cancellations/request': CancellationV1Schema,
  '/api/mission-control/v1/runtime/cancellations/acknowledge': CancellationAcknowledgementSchema,
  '/api/mission-control/v1/compat/context-epoch-retirement/evaluate': EpochRetirementSchema,
  '/api/mission-control/v1/run-activity/telemetry/batches': RuntimeTelemetryBatchV1Schema,
  '/api/mission-control/v1/federation/discover': FederatedDiscoveryRequestSchema,
  '/api/mission-control/v1/federation/acquire': FederatedAcquireRequestSchema,
  '/api/mission-control/v1/federation/work-package/read': FederatedWorkPackageReadRequestSchema,
  '/api/mission-control/v1/federation/leases/renew': FederatedRenewRequestSchema,
  '/api/mission-control/v1/federation/leases/release': FederatedReleaseRequestSchema,
  '/api/mission-control/v1/federation/events': FederatedEventRequestSchema,
  '/api/mission-control/v1/federation/activity': FederatedActivityRequestSchema,
  '/api/mission-control/v1/federation/results/propose': FederatedResultProposalSchema,
  '/api/mission-control/v1/federation/cancellations/acknowledge': FederatedCancellationAcknowledgementSchema,
  '/api/mission-control/v1/federation/plan-changes/propose': FederatedPlanChangeRequestSchema,
  '/api/mission-control/v1/federation/recover': FederatedRecoveryRequestSchema,
};
const S = z.string(); const I = z.number().int(); const B = z.boolean();
const mutationResult = (value: z.ZodType) => z.object({ duplicate: B, value }).strict();
const retirementMetrics = z.object({ consecutiveMinorReleases: I, daysSinceWriteCurrent: I, zeroReadDays: I,
  supportedConsumersRemaining: I, migrationFixturesPass: B, rollbackFixturesPass: B, breakMarkersPresent: B,
  releaseNotesPresent: B, nextMajorDeclared: B, independentReviewAccepted: B }).strict();
const retirementResult = z.object({ evaluationId: S, packetHash: S, metrics: retirementMetrics, eligible: B,
  gates: z.object({ releaseGate: B, ageGate: B, zeroUseGate: B, clientsGate: B, fixturesGate: B,
    breakMarkersGate: B, independentReviewGate: B }).strict(), failedReasons: z.array(S) }).strict();
export const missionControlMutationIdempotencyPaths=new Set([
  '/api/mission-control/v1/missions/compile','/api/mission-control/v1/work-packages/revisions','/api/mission-control/v1/leases/acquire',
  '/api/mission-control/v1/leases/{leaseId}/renew','/api/mission-control/v1/leases/{leaseId}/release','/api/mission-control/v1/context/policy-definitions',
  '/api/mission-control/v1/context/policy-activations','/api/mission-control/v1/runtime/retrieval-receipts','/api/mission-control/v1/runtime/context-bundles',
  '/api/mission-control/v1/runtime/context-deltas','/api/mission-control/v1/context/retry-budgets','/api/mission-control/v1/runtime/dispatches/authorize',
  '/api/mission-control/v1/runtime/dispatches/consume','/api/mission-control/v1/runtime/checkpoints','/api/mission-control/v1/runtime/plan-change-proposals',
  '/api/mission-control/v1/plan-change-proposals/review','/api/mission-control/v1/closeout/evaluate','/api/mission-control/v1/cancellations/request',
  '/api/mission-control/v1/runtime/cancellations/acknowledge','/api/mission-control/v1/compat/context-epoch-retirement/evaluate',
  '/api/mission-control/v1/federation/acquire','/api/mission-control/v1/federation/leases/renew',
  '/api/mission-control/v1/federation/leases/release','/api/mission-control/v1/federation/events',
  '/api/mission-control/v1/federation/activity','/api/mission-control/v1/federation/results/propose',
  '/api/mission-control/v1/federation/cancellations/acknowledge',
  '/api/mission-control/v1/federation/plan-changes/propose','/api/mission-control/v1/federation/recover',
]);
export const missionControlRuntimeHeaderPaths=new Set([
  '/api/mission-control/v1/leases/{leaseId}/renew','/api/mission-control/v1/leases/{leaseId}/release',
  '/api/mission-control/v1/runtime/retrieval-receipts','/api/mission-control/v1/runtime/context-bundles','/api/mission-control/v1/runtime/context-deltas',
  '/api/mission-control/v1/runtime/retries/claim','/api/mission-control/v1/runtime/retries/settle','/api/mission-control/v1/runtime/dispatches/authorize',
  '/api/mission-control/v1/runtime/dispatches/consume','/api/mission-control/v1/runtime/checkpoints','/api/mission-control/v1/runtime/events',
  '/api/mission-control/v1/runtime/evidence','/api/mission-control/v1/runtime/plan-change-proposals','/api/mission-control/v1/runtime/cancellations/acknowledge',
  '/api/mission-control/v1/run-activity/telemetry/batches',
  '/api/mission-control/v1/federation/discover','/api/mission-control/v1/federation/acquire',
  '/api/mission-control/v1/federation/work-package/read','/api/mission-control/v1/federation/leases/renew',
  '/api/mission-control/v1/federation/leases/release','/api/mission-control/v1/federation/events',
  '/api/mission-control/v1/federation/activity','/api/mission-control/v1/federation/results/propose',
  '/api/mission-control/v1/federation/cancellations/acknowledge',
  '/api/mission-control/v1/federation/plan-changes/propose','/api/mission-control/v1/federation/recover',
]);

export const missionControlResponseSchemas: Record<string, z.ZodType> = {
  '/api/mission-control/v1/missions/compile': mutationResult(z.object({ missionId: S, revision: I, hash: S }).strict()),
  '/api/mission-control/v1/work-packages/revisions': mutationResult(z.object({ workPackageId: S, revision: I, hash: S }).strict()),
  '/api/mission-control/v1/leases/acquire': mutationResult(z.object({ leaseId: S, fencingToken: I, issuedAt: S.optional(), expiresAt: S.optional(), duplicate: B }).strict()),
  '/api/mission-control/v1/leases/{leaseId}/renew': mutationResult(z.object({ leaseId: S, fencingToken: I, expiresAt: S, stateVersion: I }).strict()),
  '/api/mission-control/v1/leases/{leaseId}/release': mutationResult(z.object({ leaseId: S, state: z.literal('released'), stateVersion: I }).strict()),
  '/api/mission-control/v1/context/policy-definitions': mutationResult(z.object({ policyDefinitionId: S, version: S, hash: S }).strict()),
  '/api/mission-control/v1/context/policy-activations': mutationResult(z.object({ activationId: S, revision: I, hash: S, scopeKey: S, effectiveState: S.optional() }).strict()),
  '/api/mission-control/v1/runtime/retrieval-receipts': mutationResult(z.object({ receiptId: S, retrievalKey: S, status: S }).strict()),
  '/api/mission-control/v1/runtime/context-bundles': mutationResult(z.object({ bundleId: S, version: I, hash: S, state: S }).strict()),
  '/api/mission-control/v1/runtime/context-deltas': mutationResult(z.object({ deltaId: S, mode: z.enum(['delta','full']), reason: S, fullBundleRequired: B, verificationReceiptHash: S.optional() }).strict()),
  '/api/mission-control/v1/context/retry-budgets': mutationResult(z.object({ retryBudgetId: S, continuationKey: S, state: S }).strict()),
  '/api/mission-control/v1/runtime/retries/claim': z.object({ claimed: B, retryFence: I, state: S, retrySpent: I }).strict(),
  '/api/mission-control/v1/runtime/retries/settle': z.object({ state: S, retryable: B, eventHash: S }).strict(),
  '/api/mission-control/v1/runtime/dispatches/authorize': mutationResult(z.object({ dispatchId: S, state: S, dispatchHash: S, firstVerificationHash: S, authorizationExpiresAt: S }).strict()),
  '/api/mission-control/v1/runtime/dispatches/consume': z.object({ consumed: B, duplicate: B, outboxState: S }).strict(),
  '/api/mission-control/v1/internal/dispatch-outbox/claim': z.object({ claimed: B, duplicate: B, state: S, claimFence: I, deliveryKey: S, payloadHash: S }).strict(),
  '/api/mission-control/v1/internal/dispatch-outbox/authorize-send': z.object({ authorized: z.literal(true), sendAuthorizationHash: S, expiresAt: S, deliveryKey: S, payloadHash: S,payload:ContinuationReceiverPayloadSchema }).strict(),
  '/api/mission-control/v1/internal/dispatch-outbox/accept': z.object({ accepted: z.literal(true), duplicate: B, acceptanceReceiptHash: S, acceptedAt: S }).strict(),
  '/api/mission-control/v1/internal/dispatch-outbox/settle': z.object({ state: S, outcomeHash: S, retryable: B }).strict(),
  '/api/mission-control/v1/runtime/checkpoints': mutationResult(z.object({ checkpointId: S, sequence: I, duplicate: B }).strict()),
  '/api/mission-control/v1/events': z.object({ duplicate: B, eventId: S, canonicalStateOrder: I, hostReceiptOrder: I, databaseTime: S }).strict(),
  '/api/mission-control/v1/runtime/events': z.object({ duplicate: B, eventId: S, canonicalStateOrder: I, hostReceiptOrder: I, databaseTime: S }).strict(),
  '/api/mission-control/v1/runtime/evidence': z.object({ evidenceRowId: I, evidenceHash: S, duplicate: B }).strict(),
  '/api/mission-control/v1/evidence': z.object({ evidenceRowId: I, evidenceHash: S, duplicate: B }).strict(),
  '/api/mission-control/v1/runtime/plan-change-proposals': mutationResult(z.object({ proposalId: S, state: S, stateVersion: I.optional(), canonicalMutationPerformed: z.literal(false) }).strict()),
  '/api/mission-control/v1/plan-change-proposals/review': mutationResult(z.object({ proposalId: S, state: S, stateVersion: I, canonicalMutationPerformed: z.literal(false) }).strict()),
  '/api/mission-control/v1/closeout/evaluate': mutationResult(z.object({ evaluationId: S, outcome: S, missingEvidenceIds: z.array(S), conflictingEvidenceIds: z.array(S), establishesStoryCompletion: z.literal(false), storyCloseoutDecisionId: S.nullable() }).strict()),
  '/api/mission-control/v1/cancellations/request': mutationResult(z.object({ cancellationId: S, requestState: S, effectiveDisposition: S, requestRowImmutable: B, leaseAuthorityRevoked: B }).strict()),
  '/api/mission-control/v1/runtime/cancellations/acknowledge': mutationResult(z.object({ acknowledgementId: S, classification: S, requestState: S, effectiveDisposition: S, acknowledged: B, requestRowImmutable: B }).strict()),
  '/api/mission-control/v1/compat/context-epoch-retirement/evaluate': mutationResult(retirementResult),
  '/api/mission-control/v1/run-activity/telemetry/batches': RunActivityTelemetryReceiptWireSchema,
  '/api/mission-control/v1/federation/discover': z.object({
    schemaVersion: z.literal('rorca.federated-discovery.v1'),
    offers: z.array(z.object({ offerId: S, bindingHash: S, leaseId: S, workPackageId: S,
      workPackageRevision: I.positive(), storyId: S, expiresAt: S }).strict()).max(10),
    databaseTime: S,
  }).strict(),
  '/api/mission-control/v1/federation/acquire': z.object({
    claimId: S, offerId: S, bindingHash: S, leaseId: S, fencingToken: I.positive(), databaseTime: S,
  }).strict(),
  '/api/mission-control/v1/federation/work-package/read': z.object({
    schemaVersion: z.literal('rorca.federated-work-input.v1'), offerId: S,
    binding: FederatedLeaseBindingSchema, bindingHash: S, mission: MissionContractV1Schema,
    workPackage: WorkPackageV1Schema, lease: ExecutionLeaseV1Schema,
    policyActivation: ContextPolicyActivationV1Schema, checkpoint: ContextCheckpointV1Schema,
    retrievalReceipt: RetrievalReceiptV1Schema, contextBundle: ContextBundleV1Schema,
    continuationDispatch: ContinuationDispatchV1Schema.nullable(), publishedBy: S, expiresAt: S, inputHash: S,
    cancellation: z.object({ cancellationId: S, deadlineAt: S, reasonCode: S }).strict().nullable(),
  }).strict(),
  '/api/mission-control/v1/federation/leases/renew': mutationResult(z.object({
    leaseId: S, fencingToken: I.positive(), expiresAt: S, stateVersion: I.positive(),
  }).strict()),
  '/api/mission-control/v1/federation/leases/release': mutationResult(z.object({
    leaseId: S, state: z.literal('released'), stateVersion: I.positive(),
  }).strict()),
  '/api/mission-control/v1/federation/events': z.object({
    duplicate: B, eventId: S, canonicalStateOrder: I.nonnegative(), hostReceiptOrder: I.nonnegative(), databaseTime: S,
  }).strict(),
  '/api/mission-control/v1/federation/activity': z.object({
    schemaVersion: z.literal('rorca.federated-activity-receipt.v1'), duplicate: B, batchId: S,
    firstStreamSequence: I.positive(), lastStreamSequence: I.positive(), eventCount: I.positive(),
    observabilityOnly: z.literal(true), evidenceAuthority: z.literal('none'),
    closeoutAuthority: z.literal('none'), lifecycleAuthority: z.literal('none'),
  }).strict(),
  '/api/mission-control/v1/federation/results/propose': z.object({
    schemaVersion: z.literal('rorca.federated-result-receipt.v1'), proposalId: S, proposalHash: S, duplicate: B,
    hostVerificationHash: S, evidenceId: S, evidenceHash: S,
    closeoutPosture: z.literal('shared_canonical_resolver_pending'), acceptedAsCompletion: z.literal(false),
    lifecycleAuthority: z.literal('none'), mergeAuthority: z.literal('none'), deploymentAuthority: z.literal('none'),
  }).strict(),
  '/api/mission-control/v1/federation/cancellations/acknowledge': mutationResult(z.object({
    acknowledgementId: S, classification: S, requestState: S, effectiveDisposition: S,
    acknowledged: B, requestRowImmutable: B,
  }).strict()),
  '/api/mission-control/v1/federation/plan-changes/propose': mutationResult(z.object({
    proposalId: S, state: S, stateVersion: I.optional(), canonicalMutationPerformed: z.literal(false),
  }).strict()),
  '/api/mission-control/v1/federation/recover': z.object({
    classification: z.enum(['resume_same_session_observation','await_cancellation_ack','terminal_no_relaunch',
      'resume_shared_closeout','quarantined_ambiguity']),
    action: z.enum(['observe_only','deliver_cancellation','none','enqueue_closeout','preserve_and_block']),
    canonicalReferencesHash: S, relaunch: z.literal(false).optional(), successInferred: z.literal(false).optional(),
  }).strict(),
};
const JsonScalar=z.union([z.string(),z.number(),z.boolean(),z.null()]);
const exactReadRow=(keys:readonly string[])=>z.object(Object.fromEntries(keys.map(key=>[key,JsonScalar]))).strict();
const MissionReadItem=exactReadRow(['mission_id','mission_revision','mission_hash','contract_version','canonical_spec_id','canonical_spec_version','canonical_spec_hash','canonical_spec_path','repository_id','base_sha','created_at']);
const EventReadItem=exactReadRow(['event_id','attempt_id','runtime_generation','runtime_sequence','canonical_state_order','host_receipt_order','event_type','event_hash','payload_hash','trust_class','reason_code','observed_at','received_at']);
const EvidenceReadItem=exactReadRow(['id','spec_slug','spec_version','story_id','evidence_type','payload_hash','observed_at','evidence_status','trust_level','confidence','governed_contract_hash','governed_mission_id','governed_work_package_id','governed_spec_id','governed_spec_version','governed_spec_hash','governed_story_id','governed_story_version','governed_story_hash','governed_attempt_id','governed_lease_id','governed_fencing_token','governed_activation_hash','governed_checkpoint_id','governed_repository_id','governed_worktree_id','governed_observer_id']);
const pagedRead=(item:z.ZodType)=>z.object({schemaVersion:S,items:z.array(item).max(100),nextCursor:I.nonnegative().nullable()}).strict();
const AttemptReadItem=exactReadRow(['attempt_id','mission_id','work_package_id','work_package_revision','story_id','runtime_id','generation','manifest_hash','repository_id','worktree_id']);
const LeaseReadItem=exactReadRow(['lease_id','fencing_token','state','expires_at','repository_id','base_sha','current_sha','worktree_id','policy_activation_hash','checkpoint_hash','bundle_hash']);
const CloseoutReadItem=exactReadRow(['evaluation_id','outcome','subject_hash','story_closeout_decision_id','decision_time']);
const ManagedCapabilityReadItem=exactReadRow(['snapshot_id','snapshot_hash','policy_version','runtime_id','provider_id','role','observed_at','valid_until']);
const ManagedQuotaReadItem=exactReadRow(['reservation_id','request_hash','attempt_id','generation','runtime_id','capability_snapshot_hash','quota_policy_version','state','reserved_at','expires_at','release_reason_code']);
const ManagedGenerationReadItem=exactReadRow(['request_hash','attempt_id','generation','lease_id','fencing_token','runtime_id','provider_id','work_package_id','work_package_revision','repository_id','base_sha','current_sha','expected_head_sha','worktree_id','policy_activation_hash','checkpoint_hash','bundle_hash','capability_snapshot_hash','quota_reservation_id','state','process_identity','last_evidence_hash','prepared_at','released_at','updated_at','expires_at']);
export const missionControlReadResponseSchemas:Record<string,z.ZodType>={
  '/api/mission-control/v1/missions':pagedRead(MissionReadItem),
  '/api/mission-control/v1/events':pagedRead(EventReadItem),
  '/api/mission-control/v1/evidence':pagedRead(EvidenceReadItem).extend({redacted:z.literal(true)}).strict(),
  '/api/mission-control/v1/managed-executor/capabilities':pagedRead(ManagedCapabilityReadItem),
  '/api/mission-control/v1/managed-executor/quota-reservations':pagedRead(ManagedQuotaReadItem),
  '/api/mission-control/v1/managed-executor/generations':pagedRead(ManagedGenerationReadItem),
  '/api/mission-control/v1/cancellations/{cancellationId}':z.object({schemaVersion:S,cancellation_id:S,attempt_id:S,lease_id:S,
    fencing_token:z.union([I,S]),request_state:S,effective_disposition:S,acknowledgement_id:S.nullable(),acknowledged_at:S.nullable(),
    acknowledged:B,request_row_immutable:B}).strict(),
  '/api/mission-control/v1/runs/{runId}':z.object({schemaVersion:S,authoritative:z.literal(false),attempt:AttemptReadItem,
    lease:LeaseReadItem.nullable().optional(),closeout:CloseoutReadItem.nullable().optional(),componentAuthority:z.object({attempt:S,lease:S,closeout:S}).strict(),
    authorityLabels:z.object({processExit:S,continuationSettlement:S,completionCandidate:S,storyCompletion:S}).strict()}).strict(),
  '/api/mission-control/v1/compat/context-epoch':z.object({schemaVersion:S,legacyEpochId:S,checkpointId:S,checkpointVersion:I,checkpointHash:S,
    policyDefinitionId:S,policyDefinitionVersion:S,policyDefinitionHash:S,policyActivationId:S,policyActivationRevision:I,policyActivationHash:S,
    retrievalReceiptId:S,retrievalReceiptVersion:I,retrievalReceiptHash:S,contextBundleId:S,contextBundleVersion:I,contextBundleHash:S,
    continuationDispatchId:S,continuationDispatchVersion:z.union([I,z.literal('not_applicable')]),continuationDispatchHash:S,
    projectionOnly:z.literal(true),authoritative:z.literal(false),generatedAt:S,compatibilityRemovalNotBefore:S}).strict(),
  '/api/mission-control/v1/run-activity/runs/{runId}/events': RunActivityPageWireSchema,
  '/api/mission-control/v1/run-activity/runs/{runId}/state': RunActivityStateWireSchema,
  '/api/mission-control/v1/run-activity/runs/{runId}/live': RunActivityLiveFrameWireSchema,
};
function sendGovernedRead(res:Response,apiPath:string,value:unknown):void{
  const wireValue=JSON.parse(JSON.stringify(value));
  const schema=missionControlReadResponseSchemas[apiPath];
  if(!schema)throw new Error(`Mission-control read schema missing for ${apiPath}`);
  const parsed=schema.safeParse(wireValue);
  if(!parsed.success)throw new Error(`Mission-control read result invalid for ${apiPath}`);
  res.json(parsed.data);
}

async function workspaceRows<T extends QueryResultRow>(workspaceId: string, sql: string, params: unknown[] = []): Promise<T[]> {
  return transaction(async (client) => {
    await client.query(`SELECT set_config('rorca.workspace_id',$1,TRUE)`, [workspaceId]);
    return (await client.query<T>(sql, params)).rows;
  });
}
async function workspaceOne<T extends QueryResultRow>(workspaceId: string, sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await workspaceRows<T>(workspaceId, sql, params))[0];
}
async function workspaceExecute(workspaceId: string, sql: string, params: unknown[] = []): Promise<void> {
  await workspaceRows(workspaceId, `${sql} RETURNING workspace_id`, params);
}

function parseRouteInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ValidationError('Request input validation failed', { issues: result.error.issues });
  return result.data;
}
function parseCanonicalRecord<T>(schema: z.ZodType<T>, value: unknown, recordType: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new UnprocessableError(`${recordType} canonical payload is invalid`, 'CANONICAL_PAYLOAD_INVALID', { issues: result.error.issues });
  return result.data;
}
function requestCorrelationId(req: Request): string {
  return String((req as Request & { requestId?: string }).requestId ?? 'request:unknown');
}
function mutationContext(req: Request, delegatedRuntimeId?: string): GovernedMutationContext {
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length < 8 || key.length > 200) throw new ValidationError('Idempotency-Key must be 8-200 characters');
  if (!req.user) throw new AuthError();
  if (req.user.role !== 'admin') throw new AdminRequiredError();
  const internalService = req.user.id === INTERNAL_SERVICE_USER_ID || req.user.id === 'rorca-hermes-service';
  if (delegatedRuntimeId && !internalService) throw new AuthError('Runtime delegation requires bounded internal service identity');
  return { principalId: delegatedRuntimeId ?? req.user.id,
    authoritySource: internalService ? 'runtime_lease' : 'local_admin', idempotencyKey: key,
    correlationId: requestCorrelationId(req), ...(delegatedRuntimeId ? { relayPrincipalId: req.user.id } : {}) };
}
function requireInternal(req: Request): void {
  if (!req.user || ![INTERNAL_SERVICE_USER_ID, 'rorca-hermes-service'].includes(req.user.id)) throw new AuthError('Bounded internal service credential required');
}
function requireRuntime(req: Request, runtimeId: string): void {
  requireInternal(req);
  const claimed = req.headers['x-rorca-runtime-id'];
  if (typeof claimed !== 'string' || claimed !== runtimeId) throw new AuthError('Runtime principal does not match leased subject');
}
function requireDispatchReceiver(req: Request): string {
  const receiverPrincipalId = 'rorca-dispatch-receiver';
  if (!req.user || req.user.id !== receiverPrincipalId
    || req.headers['x-rorca-receiver-id'] !== receiverPrincipalId) {
    throw new AuthError('Dedicated dispatch receiver credential and exact receiver binding required');
  }
  return receiverPrincipalId;
}
function asyncRoute(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };
}
function mutationWorkspace(req: Request): string | null {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const artifact = body.artifact && typeof body.artifact === 'object' ? body.artifact as Record<string, unknown> : null;
  const direct = typeof body.workspaceId === 'string' ? body.workspaceId : artifact && typeof artifact.workspaceId === 'string' ? artifact.workspaceId : null;
  if(direct)return direct;
  if(req.path.replace(/\/+$/,'')==='/compat/context-epoch'&&typeof req.query.workspaceId==='string')return req.query.workspaceId;
  return null;
}
// Mission-control governed reads never inherit the generic platform-superuser
// membership bypass: tenant membership is an explicit authority requirement.
router.use(async (req, _res, next) => {
  if (!['GET', 'HEAD'].includes(req.method)) return next();
  if (!req.user) return next(new AuthError());
  const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : null;
  if (!workspaceId) return next(new ValidationError('Workspace ID is required'));
  const membership = await queryOne(`SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_auth_id=$2`,
    [workspaceId, req.user.supabaseId]);
  if (!membership) return next(new ForbiddenError('Exact workspace membership is required'));
  next();
});
type MutationRouteCapability = 'operator' | 'internal' | 'runtime' | 'receiver';
const INTERNAL_MUTATION_PATHS = new Set([
  '/events', '/evidence', '/closeout/evaluate',
  '/internal/dispatch-outbox/claim', '/internal/dispatch-outbox/authorize-send',
  '/internal/dispatch-outbox/accept', '/internal/dispatch-outbox/settle',
]);
const runtimeSubjectForRequest = (req: Request): string | null => {
  const body = (req.body ?? {}) as Record<string, any>;
  if (req.path.startsWith('/leases/')) return typeof body.runtimeId === 'string' ? body.runtimeId : null;
  if (req.path === '/runtime/retrieval-receipts' || req.path === '/runtime/context-bundles'
    || req.path === '/runtime/dispatches/authorize' || req.path === '/runtime/checkpoints'
    || req.path === '/runtime/events') return typeof body.scope?.runtimeId === 'string' ? body.scope.runtimeId : null;
  if (req.path === '/runtime/context-deltas') return typeof body.artifact?.scope?.runtimeId === 'string' ? body.artifact.scope.runtimeId : null;
  if (req.path === '/runtime/retries/claim' || req.path === '/runtime/retries/settle'
    || req.path === '/runtime/dispatches/consume' || req.path === '/runtime/cancellations/acknowledge') {
    return typeof body.runtimeId === 'string' ? body.runtimeId : null;
  }
  if (req.path === '/runtime/evidence') return typeof body.observerId === 'string' ? body.observerId : null;
  if (req.path === '/runtime/plan-change-proposals') return typeof body.proposerRuntimeId === 'string' ? body.proposerRuntimeId : null;
  return null;
};
function mutationRouteCapability(req: Request): MutationRouteCapability {
  if (req.path === '/internal/dispatch-outbox/accept') return 'receiver';
  if (INTERNAL_MUTATION_PATHS.has(req.path)) return 'internal';
  if (req.path.startsWith('/runtime/') || /^\/leases\/[^/]+\/(?:renew|release)$/.test(req.path)) return 'runtime';
  return 'operator';
}
// Header presence and a service credential are never router-wide tenant
// authority. Every bypass is an explicit route capability and runtime routes
// bind the header to the exact body subject before service-level lease checks.
router.use(async (req, _res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  try {
    const capability = mutationRouteCapability(req);
    if (capability === 'receiver') { requireDispatchReceiver(req); return next(); }
    if (capability === 'internal') { requireInternal(req); return next(); }
    if (capability === 'runtime') {
      const runtimeId = runtimeSubjectForRequest(req);
      if (!runtimeId) throw new AuthError('Runtime route is missing its exact delegated subject');
      requireRuntime(req, runtimeId);
      return next();
    }
    if (!req.user) throw new AuthError();
    const workspaceId = mutationWorkspace(req);
    if (!workspaceId) throw new ValidationError('Workspace ID is required');
    const membership = await queryOne<{ role: string }>(`SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_auth_id=$2`,
      [workspaceId, req.user.supabaseId]);
    if (!membership || !['admin', 'owner'].includes(membership.role)) throw new ForbiddenError('Workspace administrator authority required');
    next();
  } catch (error) { next(error); }
});

/**
 * @swagger
 * /api/mission-control/v1/missions:
 *   get:
 *     summary: List sanitized governed mission revisions
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Workspace-owned read projection exposes bounded identities and hashes only; no raw authority payloads."
 *     parameters:
 *       - { in: query, name: workspaceId, required: true, schema: { type: string } }
 *       - { in: query, name: limit, schema: { type: integer, maximum: 100 } }
 *       - { in: query, name: cursor, schema: { type: integer, minimum: 0 } }
 *     responses:
 *       200: { description: OK }
 */
router.get('/missions', requireWorkspaceMember(), asyncRoute(async (req, res) => {
  const input = parseRouteInput(WorkspaceQuerySchema, req.query);
  const rows = await workspaceRows(input.workspaceId, `SELECT mission_id,mission_revision,mission_hash,contract_version,canonical_spec_id,canonical_spec_version,
    canonical_spec_hash,canonical_spec_path,repository_id,base_sha,created_at FROM governed_mission_versions
    WHERE workspace_id=$1 ORDER BY mission_id,mission_revision DESC LIMIT $2 OFFSET $3`, [input.workspaceId, input.limit, input.cursor]);
  sendGovernedRead(res,'/api/mission-control/v1/missions',{ schemaVersion: 'rorca.governed-mission-read.v1', items: rows, nextCursor: rows.length === input.limit ? input.cursor + rows.length : null });
}));

/**
 * @swagger
 * /api/mission-control/v1/managed-executor/capabilities:
 *   get:
 *     summary: List redacted canonical managed capability snapshots
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Exact workspace membership and RLS expose health identities only; provider auth references and dependency payloads stay private."
 *     responses:
 *       200: { description: OK }
 */
router.get('/managed-executor/capabilities', requireWorkspaceMember(), asyncRoute(async (req,res)=>{
  const input=parseRouteInput(WorkspaceQuerySchema,req.query);
  const rows=await workspaceRows(input.workspaceId,`SELECT snapshot_id,snapshot_hash,policy_version,runtime_id,provider_id,role,observed_at,valid_until
    FROM managed_capability_snapshots WHERE workspace_id=$1 ORDER BY observed_at DESC,snapshot_id LIMIT $2 OFFSET $3`,
    [input.workspaceId,input.limit,input.cursor]);
  sendGovernedRead(res,'/api/mission-control/v1/managed-executor/capabilities',{schemaVersion:'rorca.managed-capability-read.v1',items:rows,nextCursor:rows.length===input.limit?input.cursor+rows.length:null});
}));

/**
 * @swagger
 * /api/mission-control/v1/managed-executor/quota-reservations:
 *   get:
 *     summary: List redacted workspace quota reservations
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Workspace RLS returns bounded reservation identities and states without prompts, transcripts, credentials, or authority payloads."
 *     responses:
 *       200: { description: OK }
 */
router.get('/managed-executor/quota-reservations', requireWorkspaceMember(), asyncRoute(async (req,res)=>{
  const input=parseRouteInput(WorkspaceQuerySchema,req.query);
  const rows=await workspaceRows(input.workspaceId,`SELECT reservation_id,request_hash,attempt_id,generation,runtime_id,capability_snapshot_hash,
    quota_policy_version,state,reserved_at,expires_at,release_reason_code FROM managed_quota_reservations
    WHERE workspace_id=$1 ORDER BY reserved_at DESC,reservation_id LIMIT $2 OFFSET $3`,[input.workspaceId,input.limit,input.cursor]);
  sendGovernedRead(res,'/api/mission-control/v1/managed-executor/quota-reservations',{schemaVersion:'rorca.managed-quota-read.v1',items:rows,nextCursor:rows.length===input.limit?input.cursor+rows.length:null});
}));

/**
 * @swagger
 * /api/mission-control/v1/managed-executor/generations:
 *   get:
 *     summary: List fenced managed execution generations
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Workspace RLS exposes canonical hashes and host process identity only; request bodies, output, and lifecycle authority remain private."
 *     responses:
 *       200: { description: OK }
 */
router.get('/managed-executor/generations', requireWorkspaceMember(), asyncRoute(async (req,res)=>{
  const input=parseRouteInput(WorkspaceQuerySchema,req.query);
  const rows=await workspaceRows(input.workspaceId,`SELECT request_hash,attempt_id,generation,lease_id,fencing_token,runtime_id,provider_id,
    work_package_id,work_package_revision,repository_id,base_sha,current_sha,expected_head_sha,worktree_id,policy_activation_hash,
    checkpoint_hash,bundle_hash,capability_snapshot_hash,quota_reservation_id,state,process_identity,last_evidence_hash,prepared_at,released_at,updated_at,expires_at
    FROM managed_executor_generations WHERE workspace_id=$1 ORDER BY updated_at DESC,request_hash LIMIT $2 OFFSET $3`,
    [input.workspaceId,input.limit,input.cursor]);
  sendGovernedRead(res,'/api/mission-control/v1/managed-executor/generations',{schemaVersion:'rorca.managed-generation-read.v1',items:rows,nextCursor:rows.length===input.limit?input.cursor+rows.length:null});
}));

/**
 * @swagger
 * /api/mission-control/v1/missions/compile:
 *   post:
 *     summary: Compile one immutable governed mission revision
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Mission compilation mutates canonical authority and is operator-only, idempotent, and MCP-excluded."
 *     responses:
 *       200: { description: Compiled }
 */
router.post('/missions/compile', validateBody(MissionRequestSchema), asyncRoute(async (req, res) => {
  res.json(await compileGovernedMission(req.body.artifact, req.body.expectedStateVersion, mutationContext(req)));
}));

/**
 * @swagger
 * /api/mission-control/v1/work-packages/revisions:
 *   post:
 *     summary: Create a work-package revision through CAS
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Scope revisions require operator authority and cannot be exposed as an ordinary MCP mutation."
 *     responses:
 *       200: { description: Revised }
 */
router.post('/work-packages/revisions', validateBody(WorkPackageRequestSchema), asyncRoute(async (req, res) => {
  res.json(await createWorkPackageRevision(req.body.artifact, req.body.expectedStateVersion, mutationContext(req)));
}));

/**
 * @swagger
 * /api/mission-control/v1/leases/acquire:
 *   post:
 *     summary: Acquire one fenced execution lease
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Lease issuance grants bounded mutation authority and is never an MCP/public operation."
 *     responses:
 *       200: { description: Acquired }
 */
router.post('/leases/acquire', validateBody(ExecutionLeaseV1Schema), asyncRoute(async (req, res) => {
  res.json(await acquireExecutionLease(req.body, mutationContext(req)));
}));

/**
 * @swagger
 * /api/mission-control/v1/leases/{leaseId}/renew:
 *   post:
 *     summary: Narrowly renew an exact active lease
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Lease renewal is fence-bound execution authority and remains MCP-excluded."
 *     parameters:
 *       - { in: path, name: leaseId, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Renewed }
 */
router.post('/leases/:leaseId/renew', validateBody(RenewLeaseSchema), asyncRoute(async (req, res) => {
  requireRuntime(req, req.body.runtimeId);
  res.json(await renewExecutionLease({ ...req.body, leaseId: req.params.leaseId }, mutationContext(req, req.body.runtimeId)));
}));

/**
 * @swagger
 * /api/mission-control/v1/leases/{leaseId}/release:
 *   post:
 *     summary: Release one exact active lease under fence and state-version CAS
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Lease release revokes bounded runtime authority and remains unavailable through MCP."
 *     parameters:
 *       - { in: path, name: leaseId, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Released }
 */
router.post('/leases/:leaseId/release', validateBody(ReleaseLeaseSchema), asyncRoute(async (req, res) => {
  requireRuntime(req, req.body.runtimeId);
  res.json(await releaseExecutionLease({ ...req.body, leaseId: req.params.leaseId }, mutationContext(req, req.body.runtimeId)));
}));

/**
 * @swagger
 * /api/mission-control/v1/context/policy-definitions:
 *   post:
 *     summary: Publish an immutable context policy definition
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Immutable context policy changes require operator authority and remain MCP-excluded."
 *     responses:
 *       200: { description: Published }
 */
router.post('/context/policy-definitions', validateBody(PolicyDefinitionRequestSchema), asyncRoute(async (req, res) => {
  res.json(await publishContextPolicyDefinition(req.body.workspaceId, req.body.artifact, req.body.authorityReceiptId, mutationContext(req)));
}));

/**
 * @swagger
 * /api/mission-control/v1/context/policy-activations:
 *   post:
 *     summary: Activate exact context policy values for a leased scope
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Policy activation is revisioned authority and requires an operator mutation."
 *     responses:
 *       200: { description: Activated }
 */
router.post('/context/policy-activations', validateBody(ContextPolicyActivationV1Schema), asyncRoute(async (req, res) => {
  res.json(await activateContextPolicy(req.body, mutationContext(req)));
}));

/**
 * @swagger
 * /api/mission-control/v1/runtime/retrieval-receipts:
 *   post:
 *     summary: Persist an ordered context retrieval receipt
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Receipts bind leased retrieval provenance and use bounded internal machine ingress."
 *     responses:
 *       200: { description: Persisted }
 */
router.post('/runtime/retrieval-receipts', validateBody(RetrievalReceiptV1Schema), asyncRoute(async (req, res) => {
  requireRuntime(req, req.body.scope.runtimeId);
  res.json(await persistRetrievalReceipt(req.body, mutationContext(req, req.body.scope.runtimeId)));
}));

/**
 * @swagger
 * /api/mission-control/v1/runtime/context-bundles:
 *   post:
 *     summary: Persist a bounded required/advisory context bundle
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Bundle assembly is lease-bound machine ingress with immutable lineage, not an MCP activity mutation."
 *     responses:
 *       200: { description: Persisted }
 */
router.post('/runtime/context-bundles', validateBody(ContextBundleV1Schema), asyncRoute(async (req, res) => {
  requireRuntime(req, req.body.scope.runtimeId);
  res.json(await persistContextBundle(req.body, mutationContext(req, req.body.scope.runtimeId)));
}));

/**
 * @swagger
 * /api/mission-control/v1/runtime/context-deltas:
 *   post:
 *     summary: Persist only a byte-exact verified context delta or require full fallback
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Delta reconstruction is lease-bound ingress and fails safely to a full bundle."
 *     responses:
 *       200: { description: Persisted or full fallback required }
 */
router.post('/runtime/context-deltas', validateBody(DeltaRequestSchema), asyncRoute(async (req, res) => {
  requireRuntime(req, req.body.artifact.scope.runtimeId);
  res.json(await persistContextBundleDelta(req.body.artifact, mutationContext(req, req.body.artifact.scope.runtimeId)));
}));

/**
 * @swagger
 * /api/mission-control/v1/context/retry-budgets:
 *   post:
 *     summary: Create one bounded continuation retry budget
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Retry limits are authority-bearing canonical state and require operator initialization."
 *     responses:
 *       200: { description: Persisted }
 */
router.post('/context/retry-budgets', validateBody(ContinuationRetryBudgetV1Schema), asyncRoute(async (req, res) => {
  res.json(await persistContinuationRetryBudget(req.body, mutationContext(req)));
}));

/** @swagger
 * /api/mission-control/v1/runtime/retries/claim:
 *   post:
 *     summary: Claim one exact retrieval or transport retry under a monotonic fence
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Lease-bound retry accounting is internal runtime ingress and MCP-excluded."
 *     responses:
 *       200: { description: Claimed or refused }
 */
router.post('/runtime/retries/claim', validateBody(RetryClaimSchema), asyncRoute(async (req, res) => {
  requireRuntime(req, req.body.runtimeId);
  res.json(await claimContinuationRetry(req.body));
}));

/** @swagger
 * /api/mission-control/v1/runtime/retries/settle:
 *   post:
 *     summary: Settle, release, back off, or quarantine an exact retry claim
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Retry settlement is fence-bound internal runtime ingress and MCP-excluded."
 *     responses:
 *       200: { description: Settled }
 */
router.post('/runtime/retries/settle', validateBody(RetrySettleSchema), asyncRoute(async (req, res) => {
  requireRuntime(req, req.body.runtimeId);
  res.json(await settleContinuationRetry(req.body));
}));

/**
 * @swagger
 * /api/mission-control/v1/runtime/dispatches/authorize:
 *   post:
 *     summary: Authorize a continuation dispatch against an active exact lease
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Continuation authorization is second-phase lease authority and is never exposed through MCP."
 *     responses:
 *       200: { description: Authorized }
 */
router.post('/runtime/dispatches/authorize', validateBody(ContinuationDispatchV1Schema), asyncRoute(async (req, res) => {
  requireRuntime(req, req.body.scope.runtimeId);
  res.json(await authorizeContinuationDispatch(req.body, mutationContext(req, req.body.scope.runtimeId)));
}));

/**
 * @swagger
 * /api/mission-control/v1/runtime/dispatches/consume:
 *   post:
 *     summary: Consume an authorized continuation key exactly once after CAS re-verification
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "One-use dispatch consumption is lease-bound runtime ingress and remains MCP-excluded."
 *     responses:
 *       200: { description: Consumed }
 */
router.post('/runtime/dispatches/consume', validateBody(DispatchConsumptionSchema), asyncRoute(async (req, res) => {
  requireRuntime(req, req.body.runtimeId);
  res.json(await consumeContinuationDispatch(req.body, mutationContext(req, req.body.runtimeId)));
}));

/** @swagger
 * /api/mission-control/v1/internal/dispatch-outbox/claim:
 *   post:
 *     summary: Claim one durable continuation publication using an expiring fence
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Internal crash-recovery transport claim; never an MCP or external runtime operation."
 *     responses:
 *       200: { description: Claimed or reconciled }
 */
router.post('/internal/dispatch-outbox/claim', validateBody(DispatchOutboxClaimSchema), asyncRoute(async (req, res) => {
  requireInternal(req);
  res.json(await claimContinuationDispatchOutbox(req.body));
}));

/** @swagger
 * /api/mission-control/v1/internal/dispatch-outbox/authorize-send:
 *   post:
 *     summary: Revalidate a claim immediately before idempotent transport send
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "A recovery claim is not send authority; this short-lived exact authority must bind the provider delivery key."
 *     responses:
 *       200: { description: Short-lived send authority }
 */
router.post('/internal/dispatch-outbox/authorize-send', validateBody(DispatchSendAuthorizationSchema), asyncRoute(async (req, res) => {
  requireInternal(req);
  res.json(await authorizeContinuationDispatchSend(req.body));
}));

/** @swagger
 * /api/mission-control/v1/internal/dispatch-outbox/accept:
 *   post:
 *     summary: Atomically consume one send authorization at receiver acceptance
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Receiver-side one-use fencing prevents cancellation/revocation races before a delivery is accepted."
 *     responses:
 *       200: { description: Receiver acceptance receipt }
 */
router.post('/internal/dispatch-outbox/accept', validateBody(DispatchAcceptanceSchema), asyncRoute(async (req, res) => {
  const receiverPrincipalId = requireDispatchReceiver(req);
  res.json(await acceptContinuationDispatchDelivery(req.body, receiverPrincipalId));
}));

/** @swagger
 * /api/mission-control/v1/internal/dispatch-outbox/settle:
 *   post:
 *     summary: Append a transport outcome under the exact outbox claim fence
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Internal append-only transport reconciliation; never grants execution authority."
 *     responses:
 *       200: { description: Settled }
 */
router.post('/internal/dispatch-outbox/settle', validateBody(DispatchOutboxSettleSchema), asyncRoute(async (req, res) => {
  requireInternal(req);
  res.json(await settleContinuationDispatchOutbox(req.body));
}));

/**
 * @swagger
 * /api/mission-control/v1/runtime/checkpoints:
 *   post:
 *     summary: Persist a runtime checkpoint proposal under an exact lease
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Machine ingress changes immutable leased-subject provenance and requires bounded internal credentials."
 *     responses:
 *       200: { description: Persisted }
 */
router.post('/runtime/checkpoints', validateBody(ContextCheckpointV1Schema), asyncRoute(async (req, res) => {
  requireRuntime(req, req.body.scope.runtimeId);
  res.json(await persistContextCheckpoint(req.body, mutationContext(req, req.body.scope.runtimeId)));
}));

/**
 * @swagger
 * /api/mission-control/v1/events:
 *   get:
 *     summary: List bounded sanitized runtime-neutral event metadata
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Workspace members may review ordered event identities and trust metadata; raw payloads and restricted references are excluded."
 *     responses:
 *       200: { description: OK }
 *   post:
 *     summary: Ingest one host-observed ordered runtime-neutral event
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Host event trust is bound to exact internal service identity and leased-subject lineage."
 *     responses:
 *       200: { description: Ingested }
 */
router.get('/events', requireWorkspaceMember(), asyncRoute(async (req, res) => {
  const input = parseRouteInput(AttemptQuerySchema, req.query);
  const rows = await workspaceRows(input.workspaceId, `SELECT event_id,attempt_id,runtime_generation,runtime_sequence,canonical_state_order,host_receipt_order,
    event_type,event_hash,payload_hash,trust_class,reason_code,observed_at,received_at FROM runtime_events
    WHERE workspace_id=$1 AND attempt_id=$2 ORDER BY runtime_generation,runtime_sequence LIMIT $3 OFFSET $4`,
  [input.workspaceId, input.attemptId, input.limit, input.cursor]);
  sendGovernedRead(res,'/api/mission-control/v1/events',{ schemaVersion: 'rorca.execution-event-read.v1', items: rows,
    nextCursor: rows.length === input.limit ? input.cursor + rows.length : null });
}));
router.post('/events', validateBody(RuntimeEventV1Schema), asyncRoute(async (req, res) => {
  requireInternal(req);
  if (req.body.observerClass !== 'host' || req.body.createdBy !== req.user!.id) throw new AuthError('Host event observer does not match service identity');
  res.json(await ingestRuntimeEvent(req.body, { correlationId: requestCorrelationId(req), observerId: req.user!.id,
    observerClass: 'host', maximumTrust: 'automated_test' }));
}));

/**
 * @swagger
 * /api/mission-control/v1/runtime/events:
 *   post:
 *     summary: Ingest one ordered runtime-neutral event
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Event ingress is immutable leased-subject provenance, not an MCP activity mutation."
 *     responses:
 *       200: { description: Ingested }
 */
router.post('/runtime/events', validateBody(RuntimeEventV1Schema), asyncRoute(async (req, res) => {
  requireRuntime(req, req.body.scope.runtimeId);
  if (req.body.createdBy !== req.body.scope.runtimeId) throw new AuthError('Runtime event creator does not match leased runtime');
  res.json(await ingestRuntimeEvent(req.body, { correlationId: requestCorrelationId(req), observerId: req.body.scope.runtimeId,
    observerClass: 'runtime', maximumTrust: 'runtime_asserted' }));
}));

/**
 * @swagger
 * /api/mission-control/v1/runtime/evidence:
 *   post:
 *     summary: Ingest a non-escalating evidence envelope
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Evidence trust is server-derived and runtime ingress is deliberately absent from MCP."
 *     responses:
 *       200: { description: Ingested }
 */
router.post('/runtime/evidence', validateBody(EvidenceEnvelopeV1Schema), asyncRoute(async (req, res) => {
  requireRuntime(req, req.body.observerId);
  res.json(await ingestGovernedEvidence(req.body, { id: req.body.observerId, maximumTrust: 'runtime_asserted', correlationId: requestCorrelationId(req) }));
}));

/**
 * @swagger
 * /api/mission-control/v1/evidence:
 *   get:
 *     summary: List redacted governed evidence provenance
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Workspace members may review canonical evidence lineage and trust while source references and restricted raw payloads remain excluded."
 *     responses:
 *       200: { description: OK }
 *   post:
 *     summary: Ingest host-observed or automated-test evidence under exact service identity
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Host evidence trust is server-bounded and cannot be claimed by a runtime or generic browser principal."
 *     responses:
 *       200: { description: Ingested }
 */
router.get('/evidence', requireWorkspaceMember(), asyncRoute(async (req, res) => {
  const input = parseRouteInput(AttemptQuerySchema, req.query);
  const rows = await workspaceRows(input.workspaceId, `SELECT id,spec_slug,spec_version,story_id,evidence_type,payload_hash,observed_at,evidence_status,trust_level,
    confidence,governed_contract_hash,governed_mission_id,governed_work_package_id,governed_spec_id,governed_spec_version,
    governed_spec_hash,governed_story_id,governed_story_version,governed_story_hash,governed_attempt_id,governed_lease_id,
    governed_fencing_token,governed_activation_hash,governed_checkpoint_id,governed_repository_id,governed_worktree_id,governed_observer_id
    FROM ssdlc_lifecycle_evidence WHERE workspace_id=$1 AND governed_attempt_id=$2 ORDER BY observed_at,id LIMIT $3 OFFSET $4`,
  [input.workspaceId, input.attemptId, input.limit, input.cursor]);
  sendGovernedRead(res,'/api/mission-control/v1/evidence',{ schemaVersion: 'rorca.evidence-read.v1', redacted: true, items: rows,
    nextCursor: rows.length === input.limit ? input.cursor + rows.length : null });
}));
router.post('/evidence', validateBody(EvidenceEnvelopeV1Schema), asyncRoute(async (req, res) => {
  requireInternal(req);
  if (req.body.observerId !== req.user!.id) throw new AuthError('Evidence observer does not match service identity');
  res.json(await ingestGovernedEvidence(req.body, { id: req.user!.id, maximumTrust: 'automated_test', correlationId: requestCorrelationId(req) }));
}));

/**
 * @swagger
 * /api/mission-control/v1/runtime/plan-change-proposals:
 *   post:
 *     summary: Submit a bounded non-mutating plan-change proposal
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Runtime proposals are leased-subject ingress and cannot directly revise canonical scope."
 *     responses:
 *       200: { description: Proposed }
 */
router.post('/runtime/plan-change-proposals', validateBody(PlanChangeProposalV1Schema), asyncRoute(async (req, res) => {
  requireRuntime(req, req.body.proposerRuntimeId);
  res.json(await submitPlanChangeProposal(req.body, mutationContext(req, req.body.proposerRuntimeId)));
}));

/** @swagger
 * /api/mission-control/v1/plan-change-proposals/review:
 *   post:
 *     summary: Review a lease-bound proposal without mutating canonical work-package scope
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Proposal review requires operator authority and remains separate from work-package revision CAS."
 *     responses:
 *       200: { description: Reviewed }
 */
router.post('/plan-change-proposals/review', validateBody(ProposalReviewSchema), asyncRoute(async (req, res) => {
  res.json(await reviewPlanChangeProposal(req.body, mutationContext(req)));
}));

/**
 * @swagger
 * /api/mission-control/v1/closeout/evaluate:
 *   post:
 *     summary: Evaluate an exact leased closeout subject from canonical evidence
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Closeout evaluation reads canonical evidence under a bounded host credential and never infers completion from runtime status."
 *     responses:
 *       200: { description: Evaluated }
 */
router.post('/closeout/evaluate', validateBody(CloseoutEvaluationV1Schema), asyncRoute(async (req, res) => {
  requireInternal(req);
  res.json(await evaluateGovernedCloseout(req.body, mutationContext(req)));
}));

/**
 * @swagger
 * /api/mission-control/v1/cancellations/request:
 *   post:
 *     summary: Request cancellation and revoke one exact lease authority
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Cancellation is an operator authority transition with exact lease/fence binding."
 *     responses:
 *       200: { description: Requested }
 */
router.post('/cancellations/request', validateBody(CancellationV1Schema), asyncRoute(async (req, res) => {
  res.json(await requestExecutionCancellation(req.body, mutationContext(req)));
}));

/**
 * @swagger
 * /api/mission-control/v1/runtime/cancellations/acknowledge:
 *   post:
 *     summary: Classify a runtime cancellation acknowledgement
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Acknowledgements are runtime-bound observations; wrong/late/fenced responses cannot regain authority."
 *     responses:
 *       200: { description: Classified }
 */
router.post('/runtime/cancellations/acknowledge', validateBody(CancellationAcknowledgementSchema), asyncRoute(async (req, res) => {
  requireRuntime(req, req.body.runtimeId);
  res.json(await acknowledgeExecutionCancellation(req.body.artifact, req.body.runtimeId, mutationContext(req, req.body.runtimeId)));
}));

/** @swagger
 * /api/mission-control/v1/cancellations/{cancellationId}:
 *   get:
 *     summary: Read immutable request state and acknowledgement-derived effective disposition
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Workspace members receive a truthful derived projection; the immutable request is never relabeled."
 *     parameters:
 *       - { in: path, name: cancellationId, required: true, schema: { type: string } }
 *       - { in: query, name: workspaceId, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Effective cancellation state }
 */
router.get('/cancellations/:cancellationId', requireWorkspaceMember(), asyncRoute(async (req, res) => {
  const workspaceId = parseRouteInput(z.string().min(2).max(128), req.query.workspaceId);
  const cancellationId = parseRouteInput(z.string().min(2).max(128), req.params.cancellationId);
  const row = await workspaceOne(workspaceId, `SELECT cancellation_id,attempt_id,lease_id,fencing_token,request_state,effective_disposition,
    acknowledgement_id,acknowledged_at,acknowledged,request_row_immutable FROM execution_cancellation_effective_state
    WHERE workspace_id=$1 AND cancellation_id=$2`, [workspaceId, cancellationId]);
  if (!row) throw new NotFoundError('Cancellation', cancellationId);
  sendGovernedRead(res,'/api/mission-control/v1/cancellations/{cancellationId}',{ schemaVersion: 'rorca.cancellation-effective-state.v1', ...row });
}));

/**
 * @swagger
 * /api/mission-control/v1/runs/{runId}:
 *   get:
 *     summary: Read one bounded governed execution projection
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Read-only workspace projection exposes revision/fence/trust metadata without raw prompts, transcripts, or authority payloads."
 *     parameters:
 *       - { in: path, name: runId, required: true, schema: { type: integer } }
 *       - { in: query, name: workspaceId, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: OK }
 */
router.get('/runs/:runId', requireWorkspaceMember(), asyncRoute(async (req, res) => {
  const workspaceId = parseRouteInput(z.string().min(2).max(128), req.query.workspaceId);
  const runId = parseRouteInput(z.coerce.number().int().positive(), req.params.runId);
  const attempt = await workspaceOne(workspaceId, `SELECT attempt_id,mission_id,work_package_id,work_package_revision,story_id,runtime_id,generation,manifest_hash,repository_id,worktree_id
    FROM governed_execution_attempts WHERE workspace_id=$1 AND run_id=$2 ORDER BY generation DESC LIMIT 1`, [workspaceId, runId]);
  if (!attempt) throw new NotFoundError('Governed run projection', String(runId));
  const lease = await workspaceOne(workspaceId, `SELECT lease_id,fencing_token,state,expires_at,repository_id,base_sha,current_sha,worktree_id,policy_activation_hash,checkpoint_hash,bundle_hash
    FROM execution_leases WHERE workspace_id=$1 AND attempt_id=$2 ORDER BY fencing_token DESC LIMIT 1`, [workspaceId, (attempt as { attempt_id: string }).attempt_id]);
  const closeout = await workspaceOne(workspaceId, `SELECT evaluation_id,outcome,subject_hash,story_closeout_decision_id,decision_time FROM governed_closeout_evaluations
    WHERE workspace_id=$1 AND attempt_id=$2 ORDER BY decision_time DESC LIMIT 1`, [workspaceId, (attempt as { attempt_id: string }).attempt_id]);
  sendGovernedRead(res,'/api/mission-control/v1/runs/{runId}',{ schemaVersion: 'rorca.governed-execution-read.v1', authoritative: false, attempt, lease:lease??null, closeout:closeout??null,
    componentAuthority: { attempt: 'canonical_record', lease: 'canonical_record', closeout: 'non_authoritative_eligibility' },
    authorityLabels: { processExit: 'observation_only', continuationSettlement: 'observation_only', completionCandidate: 'proposal_only', storyCompletion: 'StoryCloseoutDecision.accepted_only' } });
}));

/**
 * @swagger
 * /api/mission-control/v1/compat/context-epoch-retirement/evaluate:
 *   post:
 *     summary: Record an executable fail-closed ContextEpoch retirement gate evaluation
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Compatibility retirement requires all durable release, age, use, client, fixture, break-marker, and independent-review gates."
 *     responses:
 *       200: { description: Evaluated }
 */
router.post('/compat/context-epoch-retirement/evaluate', validateBody(EpochRetirementSchema), asyncRoute(async (req, res) => {
  res.json(await recordContextEpochRetirementEvaluation(req.body, mutationContext(req)));
}));

/**
 * @swagger
 * /api/mission-control/v1/compat/context-epoch:
 *   get:
 *     summary: Read the deprecated exact ContextEpoch compatibility projection
 *     deprecated: true
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Authorized compatibility read computes a projection from canonical bundle lineage; it is non-authoritative and accepts no writes."
 *     parameters:
 *       - { in: query, name: workspaceId, required: true, schema: { type: string } }
 *       - { in: query, name: bundleId, required: true, schema: { type: string } }
 *       - { in: query, name: bundleHash, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Projection }
 */
router.get('/compat/context-epoch', requireWorkspaceMember(), asyncRoute(async (req, res) => {
  const input = parseRouteInput(z.object({ workspaceId: z.string(), bundleId: z.string(), bundleHash: z.string().regex(/^sha256:[a-f0-9]{64}$/), clientVersion: z.string().regex(/^\d+\.\d+\.\d+$/).default('0.0.0') }).strict(), req.query);
  const row = await workspaceOne<{ payload_json: unknown; bundle_hash: string }>(input.workspaceId, `SELECT payload_json,bundle_hash FROM context_bundles WHERE workspace_id=$1 AND bundle_id=$2`, [input.workspaceId, input.bundleId]);
  if (!row) throw new NotFoundError('Context bundle', input.bundleId);
  if (row.bundle_hash !== input.bundleHash) throw new ValidationError('Context epoch projection component mismatch', { code: 'CONTEXT_EPOCH_PROJECTION_MISMATCH' });
  const bundle = parseCanonicalRecord(ContextBundleV1Schema, row.payload_json, 'Context bundle');
  const dispatchRows = await workspaceRows<{ dispatch_id: string; dispatch_hash: string; payload_json: unknown }>(input.workspaceId, `SELECT dispatch_id,dispatch_hash,payload_json
    FROM continuation_dispatches WHERE workspace_id=$1 AND bundle_id=$2 AND state IN('authorized','dispatched','settled')
    ORDER BY created_at,dispatch_id LIMIT 2`, [input.workspaceId, input.bundleId]);
  if (dispatchRows.length > 1) throw new ValidationError('Context epoch projection has ambiguous dispatch lineage', { code: 'CONTEXT_EPOCH_PROJECTION_AMBIGUOUS' });
  const dispatch = dispatchRows[0] ? parseCanonicalRecord(ContinuationDispatchV1Schema, dispatchRows[0].payload_json, 'Continuation dispatch') : null;
  if (dispatch && (dispatch.dispatchId !== dispatchRows[0]!.dispatch_id || dispatch.bundleId !== bundle.bundleId
    || dispatch.bundleHash !== bundle.bundleHash)) throw new ValidationError('Context epoch dispatch projection mismatch', { code: 'CONTEXT_EPOCH_PROJECTION_MISMATCH' });
  const projectionFields = {
    checkpointId: bundle.checkpointId, checkpointVersion: 1, checkpointHash: bundle.checkpointHash,
    policyDefinitionId: bundle.scope.policyDefinitionId, policyDefinitionVersion: bundle.scope.policyDefinitionVersion, policyDefinitionHash: bundle.definitionHash,
    policyActivationId: bundle.scope.policyActivationId, policyActivationRevision: bundle.scope.policyActivationRevision, policyActivationHash: bundle.activationHash,
    retrievalReceiptId: bundle.receiptId, retrievalReceiptVersion: 1, retrievalReceiptHash: bundle.receiptHash,
    contextBundleId: bundle.bundleId, contextBundleVersion: bundle.bundleVersion, contextBundleHash: bundle.bundleHash,
    continuationDispatchId: dispatch?.dispatchId ?? 'not_applicable' as const,
    continuationDispatchVersion: dispatch ? 1 : 'not_applicable' as const,
    continuationDispatchHash: dispatchRows[0]?.dispatch_hash ?? 'not_applicable' as const,
  };
  const clock = await workspaceOne<{ generated_at: Date }>(input.workspaceId, 'SELECT clock_timestamp() generated_at');
  await workspaceExecute(input.workspaceId, `INSERT INTO context_epoch_projection_reads(workspace_id,bundle_id,server_version,client_version,outcome,correlation_id)
    VALUES($1,$2,'1.0.0',$3,'success',$4)`, [input.workspaceId, input.bundleId, input.clientVersion, requestCorrelationId(req)]);
  sendGovernedRead(res,'/api/mission-control/v1/compat/context-epoch',{ schemaVersion: 'rorca.context-epoch-projection.v0', legacyEpochId: contextEpochProjectionId(projectionFields), ...projectionFields,
    projectionOnly: true, authoritative: false, generatedAt: clock!.generated_at.toISOString(), compatibilityRemovalNotBefore: '2026-10-27T00:00:00.000Z' });
}));

// No legacy writer exists. Non-GET attempts are rejected and recorded without
// retaining the request payload or creating any authority-bearing state.
router.use('/compat/context-epoch', requireWorkspaceMember(), asyncRoute(async (req, _res) => {
  if (req.method === 'GET') throw new NotFoundError('ContextEpoch projection');
  const workspaceId = typeof req.query.workspaceId === 'string' && /^[A-Za-z][A-Za-z0-9._:-]{1,127}$/.test(req.query.workspaceId)
    ? req.query.workspaceId : null;
  if (!workspaceId) throw new ValidationError('Workspace ID is required');
  await workspaceExecute(workspaceId, `INSERT INTO context_epoch_write_rejections(workspace_id,route_class,correlation_id)
    VALUES($1,$2,$3)`, [workspaceId, `http:${req.method.toLowerCase()}`, requestCorrelationId(req)]);
  throw new GoneError('ContextEpoch writes are retired; use canonical checkpoint, receipt, bundle, and dispatch contracts');
}));

export default router;
