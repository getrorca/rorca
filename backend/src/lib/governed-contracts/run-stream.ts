/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
import { z } from 'zod';
import { ContinuationScopeSchema } from './context-continuation';
import {
  CanonicalTimestampSchema,
  GOVERNED_CONTRACT_LIMITS,
  RestrictedReferenceSchema,
  Sha256Schema,
  StableIdSchema,
} from './primitives';
import { RUNTIME_EVENT_TYPES } from './runtime-event';

export const RUN_STREAM_SCHEMA_VERSION = 'rorca.run-stream-envelope.v1' as const;
export const RUN_STREAM_CONTRACT_VERSION = '1.0.0' as const;
export const RUN_STREAM_ORIGIN_HASH = 'stream_origin' as const;

export const RUN_STREAM_OPERATIONAL_PLANES = [
  'source_config_drift',
  'dependency_health',
  'runtime_health',
  'queue_outbox_freshness',
  'lease_retry_recovery',
  'observability_freshness',
  'provider_operations_readiness',
] as const;
export const RunStreamOperationalPlaneSchema = z.enum(RUN_STREAM_OPERATIONAL_PLANES);

export const RUN_STREAM_EVENT_KINDS = [
  ...RUNTIME_EVENT_TYPES,
  'pty_output_referenced',
  'activity_observed',
  'lease_state_observed',
  'cancellation_state_observed',
  'stream_checkpoint',
  'stream_gap',
  'retention_pruned',
  'transport_opened',
  'transport_closed',
  'transport_throttled',
  'transport_terminated',
  'status_plane_observed',
] as const;
export const RunStreamEventKindSchema = z.enum(RUN_STREAM_EVENT_KINDS);

export const RunStreamProjectionPlaneSchema = z.enum([
  'terminal', 'activity', 'context', 'lease', 'cancellation', 'transport', 'operations', 'closeout',
]);

const SafeReasonSchema = StableIdSchema;
const SafeTextSchema = z.string().min(1).max(1024);
const HashOrNotApplicableSchema = z.union([Sha256Schema, z.literal('not_applicable')]);

export const RunStreamSourceSchema = z.object({
  store: z.enum([
    'runtime_events', 'story_closeout_decisions', 'completion_protocol', 'pty_generations',
    'run_pty_output_chunks', 'context_checkpoints', 'execution_leases', 'pipeline_cancellations',
    'queue_outbox', 'dependency_observation', 'provider_operations', 'run_activity_internal', 'fake_federated_runtime',
  ]),
  recordId: StableIdSchema,
  recordRevision: z.union([z.number().int().nonnegative(), z.string().min(1).max(128)]),
  recordHash: Sha256Schema,
  sourceSequence: z.number().int().nonnegative(),
}).strict();

const CommonRuntimePayloadSchema = z.object({
  eventType: z.enum(RUNTIME_EVENT_TYPES),
  runtimeSequence: z.number().int().nonnegative(),
  canonicalStateOrder: z.number().int().nonnegative(),
  hostReceiptOrder: z.number().int().nonnegative(),
  reasonCode: SafeReasonSchema,
  count: z.number().int().nonnegative().max(1_000_000),
  durationMs: z.number().int().nonnegative().max(86_400_000),
  trustClass: z.enum(['runtime_asserted', 'host_observed', 'automated_test', 'provider_verified', 'provider_human']),
  originatingTurnId: StableIdSchema,
  originatingGeneration: z.number().int().nonnegative(),
  runtimeGeneration: z.number().int().nonnegative(),
  sessionId: StableIdSchema,
  establishesStoryCompletion: z.literal(false),
}).strict();

const CompactionPayloadSchema = CommonRuntimePayloadSchema.extend({
  eventType: z.enum(['context_compaction_started', 'context_compaction_ended']),
  status: z.enum(['success', 'failed', 'aborted']),
  aborted: z.boolean(),
  willRetry: z.boolean(),
  resultHash: Sha256Schema,
  summaryHash: Sha256Schema,
  settledEventId: z.union([StableIdSchema, z.literal('not_applicable')]),
  eligibleForContinuation: z.boolean(),
}).strict().superRefine((value, ctx) => {
  const eligible = value.eventType === 'context_compaction_ended' && value.status === 'success'
    && !value.aborted && !value.willRetry && value.settledEventId !== 'not_applicable';
  if (value.eligibleForContinuation !== eligible) {
    ctx.addIssue({ code: 'custom', path: ['eligibleForContinuation'], message: 'compaction continuation eligibility is exact and explanatory only' });
  }
});

const RetryPayloadSchema = CommonRuntimePayloadSchema.extend({
  eventType: z.enum(['agent_settled_observed', 'pi_auto_retry_started', 'pi_auto_retry_ended', 'pi_auto_retry_settled']),
  retryCycleId: StableIdSchema,
  phase: z.enum(['started', 'ended', 'settled', 'fenced']),
  retryAttempt: z.number().int().positive(),
  retryMaximum: z.number().int().min(1).max(5),
  retryGeneration: z.number().int().nonnegative(),
  stateOrderLinkHash: Sha256Schema,
  eligibleForContinuation: z.boolean(),
}).strict().superRefine((value, ctx) => {
  const expected: Record<string, readonly string[]> = {
    agent_settled_observed: ['settled', 'fenced'],
    pi_auto_retry_started: ['started'],
    pi_auto_retry_ended: ['ended'],
    pi_auto_retry_settled: ['settled', 'fenced'],
  };
  if (!expected[value.eventType]!.includes(value.phase)) {
    ctx.addIssue({ code: 'custom', path: ['phase'], message: 'retry phase does not match event kind' });
  }
  const eligible = ['agent_settled_observed', 'pi_auto_retry_settled'].includes(value.eventType)
    && ['settled', 'fenced'].includes(value.phase)
    && value.retryGeneration === value.runtimeGeneration;
  if (value.eligibleForContinuation !== eligible) {
    ctx.addIssue({ code: 'custom', path: ['eligibleForContinuation'], message: 'retry continuation eligibility is exact and explanatory only' });
  }
});

const CandidatePayloadSchema = CommonRuntimePayloadSchema.extend({
  eventType: z.enum([
    'execution_completion_candidate_observed', 'execution_completion_candidate_validated',
    'execution_completion_candidate_rejected', 'execution_completion_candidate_submitted',
  ]),
  candidateState: z.enum(['observed', 'controller_rejected', 'controller_validated', 'submitted_to_closeout']),
  candidateHash: Sha256Schema,
  closeoutDecisionId: z.literal('not_applicable'),
}).strict().superRefine((value, ctx) => {
  const expected: Record<string, string> = {
    execution_completion_candidate_observed: 'observed',
    execution_completion_candidate_validated: 'controller_validated',
    execution_completion_candidate_rejected: 'controller_rejected',
    execution_completion_candidate_submitted: 'submitted_to_closeout',
  };
  if (value.candidateState !== expected[value.eventType]) {
    ctx.addIssue({ code: 'custom', path: ['candidateState'], message: 'candidate state does not match event kind' });
  }
});

export const VerifiedCloseoutProjectionPayloadSchema = z.object({
  decisionId: StableIdSchema,
  decisionHash: Sha256Schema,
  decisionStatus: z.enum(['accepted', 'blocked']),
  subjectHash: Sha256Schema,
  integrityVerified: z.literal(true),
  exactSubjectMatched: z.literal(true),
  establishesStoryCompletion: z.boolean(),
}).strict().superRefine((value, ctx) => {
  if (value.establishesStoryCompletion !== (value.decisionStatus === 'accepted')) {
    ctx.addIssue({ code: 'custom', path: ['establishesStoryCompletion'], message: 'only an exact verified accepted closeout establishes story completion' });
  }
});

export const PtyOutputReferencePayloadSchema = z.object({
  generationId: StableIdSchema,
  firstSequence: z.number().int().nonnegative(),
  lastSequence: z.number().int().nonnegative(),
  byteCount: z.number().int().nonnegative().max(16 * 1024 * 1024),
  rangeHash: Sha256Schema,
  checkpointId: z.union([StableIdSchema, z.literal('not_applicable')]),
  checkpointHash: HashOrNotApplicableSchema,
  archiveManifestHash: HashOrNotApplicableSchema,
  restrictedRef: RestrictedReferenceSchema,
  rawBytesIncluded: z.literal(false),
  establishesStoryCompletion: z.literal(false),
}).strict().refine((value) => value.lastSequence >= value.firstSequence, {
  path: ['lastSequence'], message: 'PTY sequence range is inverted',
});

const StatusPlaneSourceClassSchema = z.enum([
  'canonical_config', 'dependency_probe', 'sandbox_resource_monitor', 'queue_outbox_monitor',
  'lease_controller', 'observability_store', 'operations_controller',
]);
export const StatusPlaneObservationPayloadSchema = z.object({
  plane: RunStreamOperationalPlaneSchema,
  status: z.enum(['active', 'healthy', 'degraded', 'failed', 'stale', 'rejected', 'authorized', 'dispatched', 'settled', 'gap', 'quarantined', 'unknown']),
  sourceClass: StatusPlaneSourceClassSchema,
  sourceIdentity: StableIdSchema,
  sourceHash: Sha256Schema,
  observedAt: CanonicalTimestampSchema,
  validUntil: CanonicalTimestampSchema,
  reasonCode: SafeReasonSchema,
  impact: SafeTextSchema,
  nextSafeAction: SafeTextSchema,
  establishesStoryCompletion: z.literal(false),
}).strict().superRefine((value, ctx) => {
  const sourceByPlane: Record<z.infer<typeof RunStreamOperationalPlaneSchema>, z.infer<typeof StatusPlaneSourceClassSchema>> = {
    source_config_drift: 'canonical_config',
    dependency_health: 'dependency_probe',
    runtime_health: 'sandbox_resource_monitor',
    queue_outbox_freshness: 'queue_outbox_monitor',
    lease_retry_recovery: 'lease_controller',
    observability_freshness: 'observability_store',
    provider_operations_readiness: 'operations_controller',
  };
  if (value.sourceClass !== sourceByPlane[value.plane]) {
    ctx.addIssue({ code: 'custom', path: ['sourceClass'], message: 'status plane requires its independent typed source' });
  }
  if (Date.parse(value.validUntil) < Date.parse(value.observedAt)) {
    ctx.addIssue({ code: 'custom', path: ['validUntil'], message: 'status-plane validity cannot precede observation' });
  }
});

const LeaseStatePayloadSchema = z.object({
  state: z.enum(['active', 'stale', 'expired', 'released', 'cancelled']),
  leaseId: StableIdSchema,
  fencingToken: z.number().int().positive(),
  retryState: z.enum(['none', 'available', 'backoff', 'exhausted', 'quarantined']),
  retrySpent: z.number().int().nonnegative().max(5),
  retryMaximum: z.number().int().nonnegative().max(5),
  reasonCode: SafeReasonSchema,
  establishesStoryCompletion: z.literal(false),
}).strict().refine((value) => value.retrySpent <= value.retryMaximum, { path: ['retrySpent'], message: 'retry budget exceeded' });

const CancellationPayloadSchema = z.object({
  state: z.enum(['requested', 'acknowledged', 'settled']),
  cancellationId: StableIdSchema,
  reasonCode: SafeReasonSchema,
  establishesStoryCompletion: z.literal(false),
}).strict();

const transportPayloadSchema = (state: 'opened' | 'closed' | 'throttled' | 'terminated') => z.object({
  state: z.literal(state),
  reasonCode: SafeReasonSchema,
  retryAfterMs: z.number().int().nonnegative().max(60_000),
  droppedRecords: z.number().int().nonnegative().max(1_000_000),
  establishesStoryCompletion: z.literal(false),
}).strict();

const StreamCheckpointPayloadSchema = z.object({
  durableSequence: z.number().int().nonnegative(),
  durableEventHash: HashOrNotApplicableSchema,
  firstRetainedSequence: z.number().int().positive(),
  retentionPolicyHash: Sha256Schema,
  expiresAt: CanonicalTimestampSchema,
  establishesStoryCompletion: z.literal(false),
}).strict();

const GapPayloadSchema = z.object({
  firstAvailableSequence: z.number().int().positive(),
  requestedAfterSequence: z.number().int().nonnegative(),
  reasonCode: z.enum(['expired', 'pruned', 'sequence_gap', 'generation_changed', 'cursor_invalid']),
  resetRequired: z.literal(true),
  establishesStoryCompletion: z.literal(false),
}).strict();

const RetentionPayloadSchema = z.object({
  firstPrunedSequence: z.number().int().positive(),
  lastPrunedSequence: z.number().int().positive(),
  prunedRecords: z.number().int().positive(),
  prunedBytes: z.number().int().nonnegative(),
  eventWindowHash: Sha256Schema,
  archiveManifestHash: HashOrNotApplicableSchema,
  canonicalRowsDeleted: z.literal(false),
  establishesStoryCompletion: z.literal(false),
}).strict().refine((value) => value.lastPrunedSequence >= value.firstPrunedSequence, {
  path: ['lastPrunedSequence'], message: 'retention range is inverted',
});

const ActivityPayloadSchema = z.object({
  activityType: StableIdSchema,
  reasonCode: SafeReasonSchema,
  count: z.number().int().nonnegative().max(1_000_000),
  durationMs: z.number().int().nonnegative().max(86_400_000),
  referenceHash: HashOrNotApplicableSchema,
  establishesStoryCompletion: z.literal(false),
}).strict();

const payloadSchemas: Partial<Record<(typeof RUN_STREAM_EVENT_KINDS)[number], z.ZodType>> = {
  context_compaction_started: CompactionPayloadSchema,
  context_compaction_ended: CompactionPayloadSchema,
  agent_settled_observed: RetryPayloadSchema,
  pi_auto_retry_started: RetryPayloadSchema,
  pi_auto_retry_ended: RetryPayloadSchema,
  pi_auto_retry_settled: RetryPayloadSchema,
  execution_completion_candidate_observed: CandidatePayloadSchema,
  execution_completion_candidate_validated: CandidatePayloadSchema,
  execution_completion_candidate_rejected: CandidatePayloadSchema,
  execution_completion_candidate_submitted: CandidatePayloadSchema,
  story_closeout_observed: VerifiedCloseoutProjectionPayloadSchema,
  pty_output_referenced: PtyOutputReferencePayloadSchema,
  status_plane_observed: StatusPlaneObservationPayloadSchema,
  lease_state_observed: LeaseStatePayloadSchema,
  cancellation_state_observed: CancellationPayloadSchema,
  stream_checkpoint: StreamCheckpointPayloadSchema,
  stream_gap: GapPayloadSchema,
  retention_pruned: RetentionPayloadSchema,
  transport_opened: transportPayloadSchema('opened'),
  transport_closed: transportPayloadSchema('closed'),
  transport_throttled: transportPayloadSchema('throttled'),
  transport_terminated: transportPayloadSchema('terminated'),
  activity_observed: ActivityPayloadSchema,
};
for (const kind of RUNTIME_EVENT_TYPES) {
  if (!payloadSchemas[kind]) payloadSchemas[kind] = CommonRuntimePayloadSchema;
}

export function parseRunStreamPayload(kind: (typeof RUN_STREAM_EVENT_KINDS)[number], payload: unknown): unknown {
  return payloadSchemas[kind]!.parse(payload);
}

export const RunStreamRedactionSchema = z.object({
  class: z.enum(['none', 'redacted', 'restricted']),
  policyHash: Sha256Schema,
  redactedFieldCount: z.number().int().nonnegative().max(1_000),
  restrictedRef: RestrictedReferenceSchema.nullable(),
  ordinaryProjectionContainsRaw: z.literal(false),
}).strict();

export const RunStreamRetentionSchema = z.object({
  policyHash: Sha256Schema,
  retainUntil: CanonicalTimestampSchema,
  archiveManifestHash: HashOrNotApplicableSchema,
}).strict();

const RunStreamEnvelopeBaseSchema = z.object({
  schemaVersion: z.literal(RUN_STREAM_SCHEMA_VERSION),
  contractId: z.literal(RUN_STREAM_SCHEMA_VERSION),
  contractVersion: z.literal(RUN_STREAM_CONTRACT_VERSION),
  eventId: StableIdSchema,
  streamId: StableIdSchema,
  scope: ContinuationScopeSchema,
  runtimeGeneration: z.number().int().nonnegative(),
  streamSequence: z.number().int().positive(),
  priorEventHash: z.union([Sha256Schema, z.literal(RUN_STREAM_ORIGIN_HASH)]),
  eventHash: Sha256Schema,
  payloadHash: Sha256Schema,
  source: RunStreamSourceSchema,
  observedAt: CanonicalTimestampSchema,
  receivedAt: CanonicalTimestampSchema,
  databaseTime: CanonicalTimestampSchema,
  projectedAt: CanonicalTimestampSchema,
  kind: RunStreamEventKindSchema,
  plane: RunStreamProjectionPlaneSchema,
  payload: z.unknown(),
  redaction: RunStreamRedactionSchema,
  retention: RunStreamRetentionSchema,
  orderingMode: z.enum(['live_projection', 'historical_projection']),
  projectionOnly: z.literal(true),
  authorityEffect: z.literal('none'),
}).strict();

export const RunStreamEnvelopeV1Schema = RunStreamEnvelopeBaseSchema.superRefine((value, ctx) => {
  if (value.runtimeGeneration !== value.scope.runtimeGeneration) {
    ctx.addIssue({ code: 'custom', path: ['runtimeGeneration'], message: 'runtime generation must match exact scope' });
  }
  if ((value.streamSequence === 1) !== (value.priorEventHash === RUN_STREAM_ORIGIN_HASH)) {
    ctx.addIssue({ code: 'custom', path: ['priorEventHash'], message: 'only sequence one uses stream origin' });
  }
  const parsed = payloadSchemas[value.kind]!.safeParse(value.payload);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, path: ['payload', ...issue.path] });
  }
  if (value.kind !== 'story_closeout_observed' && RUNTIME_EVENT_TYPES.includes(value.kind as (typeof RUNTIME_EVENT_TYPES)[number])
    && (typeof value.payload !== 'object' || value.payload === null
      || (value.payload as Record<string, unknown>).eventType !== value.kind)) {
    ctx.addIssue({ code: 'custom', path: ['payload', 'eventType'], message: 'runtime payload event type must equal the envelope kind' });
  }
});

export const RuntimeNeutralObservationV1Schema = z.object({
  eventId: StableIdSchema,
  streamId: StableIdSchema,
  scope: ContinuationScopeSchema,
  source: RunStreamSourceSchema,
  observedAt: CanonicalTimestampSchema,
  kind: RunStreamEventKindSchema,
  plane: RunStreamProjectionPlaneSchema,
  payload: z.unknown(),
  redactionClass: z.enum(['none', 'redacted', 'restricted']),
  restrictedRef: RestrictedReferenceSchema.nullable(),
  orderingMode: z.enum(['live_projection', 'historical_projection']).default('live_projection'),
}).strict().superRefine((value, ctx) => {
  const parsed = payloadSchemas[value.kind]!.safeParse(value.payload);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, path: ['payload', ...issue.path] });
  }
  if (value.kind !== 'story_closeout_observed' && RUNTIME_EVENT_TYPES.includes(value.kind as (typeof RUNTIME_EVENT_TYPES)[number])
    && (typeof value.payload !== 'object' || value.payload === null
      || (value.payload as Record<string, unknown>).eventType !== value.kind)) {
    ctx.addIssue({ code: 'custom', path: ['payload', 'eventType'], message: 'runtime payload event type must equal the observation kind' });
  }
});

export const RUNTIME_TELEMETRY_EVENT_KINDS = [
  'context_compaction_started',
  'context_compaction_ended',
  'agent_settled_observed',
  'pi_auto_retry_started',
  'pi_auto_retry_ended',
  'pi_auto_retry_settled',
  'execution_completion_candidate_observed',
  'activity_observed',
] as const satisfies readonly RunStreamEventKind[];
const runtimeTelemetryEventKinds = new Set<RunStreamEventKind>(RUNTIME_TELEMETRY_EVENT_KINDS);

export const RuntimeTelemetryBatchV1Schema = z.object({
  schemaVersion: z.literal('rorca.runtime-telemetry-batch.v1'),
  contractVersion: z.literal(RUN_STREAM_CONTRACT_VERSION),
  batchId: StableIdSchema,
  batchHash: Sha256Schema,
  workspaceId: StableIdSchema,
  runtimeId: StableIdSchema,
  attemptId: StableIdSchema,
  leaseId: StableIdSchema,
  fencingToken: z.number().int().positive(),
  runtimeGeneration: z.number().int().nonnegative(),
  firstSourceSequence: z.number().int().nonnegative(),
  events: z.array(RuntimeNeutralObservationV1Schema).min(1).max(GOVERNED_CONTRACT_LIMITS.maxPageSize),
  compressedBytes: z.number().int().positive().max(GOVERNED_CONTRACT_LIMITS.eventBytes),
  uncompressedBytes: z.number().int().positive().max(GOVERNED_CONTRACT_LIMITS.requestBytes),
}).strict().superRefine((value, ctx) => {
  if (value.uncompressedBytes < value.compressedBytes || value.uncompressedBytes > value.compressedBytes * 100) {
    ctx.addIssue({ code: 'custom', path: ['uncompressedBytes'], message: 'invalid or unbounded compression accounting' });
  }
  for (let index = 0; index < value.events.length; index += 1) {
    const event = value.events[index]!;
    if (event.scope.workspaceId !== value.workspaceId || event.scope.runtimeId !== value.runtimeId
      || event.scope.attemptId !== value.attemptId || event.scope.leaseId !== value.leaseId
      || event.scope.fencingToken !== value.fencingToken || event.scope.runtimeGeneration !== value.runtimeGeneration
      || event.source.sourceSequence !== value.firstSourceSequence + index) {
      ctx.addIssue({ code: 'custom', path: ['events', index], message: 'batch event exact subject or source sequence mismatch' });
    }
    if (JSON.stringify(event.scope) !== JSON.stringify(value.events[0]!.scope)) {
      ctx.addIssue({ code: 'custom', path: ['events', index, 'scope'], message: 'batch events must share one exact canonical scope' });
    }
    if (event.source.store !== 'fake_federated_runtime') {
      ctx.addIssue({ code: 'custom', path: ['events', index, 'source', 'store'], message: 'telemetry ingress accepts only the bounded federated seam' });
    }
    if (!runtimeTelemetryEventKinds.has(event.kind)) {
      ctx.addIssue({ code: 'custom', path: ['events', index, 'kind'],
        message: 'telemetry ingress accepts only runtime-owned non-authoritative event kinds' });
    }
  }
});

export type RunStreamEventKind = z.infer<typeof RunStreamEventKindSchema>;
export type RunStreamOperationalPlane = z.infer<typeof RunStreamOperationalPlaneSchema>;
export type RunStreamEnvelopeV1 = z.infer<typeof RunStreamEnvelopeV1Schema>;
export type RuntimeNeutralObservationV1 = z.infer<typeof RuntimeNeutralObservationV1Schema>;
export type RuntimeTelemetryBatchV1 = z.infer<typeof RuntimeTelemetryBatchV1Schema>;
export type StatusPlaneObservationPayload = z.infer<typeof StatusPlaneObservationPayloadSchema>;
