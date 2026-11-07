/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
import { z } from 'zod';
import { ArtifactHeaderSchema, CanonicalTimestampSchema, RestrictedReferenceSchema, Sha256Schema, StableIdSchema } from './primitives';
import { ContinuationScopeSchema } from './context-continuation';

export const RUNTIME_EVENT_TYPES = [
  'attempt_started', 'validation_observed', 'cancellation_requested', 'attempt_result_observed', 'story_closeout_observed',
  'runtime_recovered', 'runtime_liveness', 'context_compaction_started', 'context_compaction_ended', 'agent_settled_observed',
  'pi_auto_retry_started', 'pi_auto_retry_ended', 'pi_auto_retry_settled', 'execution_completion_candidate_observed',
  'execution_completion_candidate_validated', 'execution_completion_candidate_rejected', 'execution_completion_candidate_submitted',
  'context_checkpoint_persisted', 'context_retrieval_requested', 'context_retrieval_completed', 'context_retrieval_degraded',
  'context_retrieval_failed', 'continuation_authorized', 'continuation_dispatched', 'continuation_settled', 'cursor_advanced',
  'context_stale', 'context_rejected', 'continuation_quarantined',
] as const;

const EventCompactionMaterialSchema = z.object({ status: z.enum(['success', 'failed', 'aborted']), aborted: z.boolean(),
  willRetry: z.boolean(), resultHash: Sha256Schema, summaryHash: Sha256Schema, settledEventId: StableIdSchema.nullable() }).strict();
const EventRetryMaterialSchema = z.object({ retryCycleId: StableIdSchema, phase: z.enum(['started', 'ended', 'settled', 'fenced']),
  attempt: z.number().int().positive(), maximum: z.number().int().min(1).max(5), generation: z.number().int().nonnegative() }).strict();
const EventCandidateMaterialSchema = z.object({ state: z.enum(['observed', 'controller_rejected', 'controller_validated', 'submitted_to_closeout']),
  candidateHash: Sha256Schema }).strict();

export const RuntimeEventV1Schema = ArtifactHeaderSchema.extend({
  schemaVersion: z.literal('rorca.execution-event.v1'), contractId: z.literal('rorca.execution-event.v1'),
  eventId: StableIdSchema, idempotencyKey: Sha256Schema, scope: ContinuationScopeSchema,
  eventType: z.enum(RUNTIME_EVENT_TYPES), runtimeSequence: z.number().int().nonnegative(),
  canonicalStateOrder: z.number().int().nonnegative(), hostReceiptOrder: z.number().int().nonnegative(),
  observedAt: CanonicalTimestampSchema, receivedAt: CanonicalTimestampSchema, databaseTime: CanonicalTimestampSchema,
  observerClass: z.enum(['runtime', 'host', 'provider', 'human']),
  trustClass: z.enum(['runtime_asserted', 'host_observed', 'automated_test', 'provider_verified', 'provider_human']),
  checkpointId: StableIdSchema, checkpointHash: Sha256Schema,
  retrievalReceiptId: z.union([StableIdSchema, z.literal('not_applicable')]), retrievalReceiptHash: z.union([Sha256Schema, z.literal('not_applicable')]),
  contextBundleId: z.union([StableIdSchema, z.literal('not_applicable')]), contextBundleHash: z.union([Sha256Schema, z.literal('not_applicable')]),
  continuationDispatchId: z.union([StableIdSchema, z.literal('not_applicable')]), continuationDispatchHash: z.union([Sha256Schema, z.literal('not_applicable')]),
  compaction: EventCompactionMaterialSchema.nullable(), retryPhase: EventRetryMaterialSchema.nullable(),
  completionCandidate: EventCandidateMaterialSchema.nullable(), stateOrderLinkHash: Sha256Schema.nullable(),
  payloadHash: Sha256Schema, reasonCode: StableIdSchema, count: z.number().int().nonnegative().max(1_000_000),
  durationMs: z.number().int().nonnegative().max(86_400_000), redactionClass: z.enum(['none', 'redacted', 'restricted']),
  restrictedRef: RestrictedReferenceSchema.nullable(), originatingEventHash: Sha256Schema.nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.observerClass === 'runtime' && value.trustClass !== 'runtime_asserted') ctx.addIssue({ code: 'custom', path: ['trustClass'], message: 'runtime cannot escalate trust' });
  if (value.observerClass === 'host' && !['host_observed', 'automated_test'].includes(value.trustClass)) ctx.addIssue({ code: 'custom', path: ['trustClass'], message: 'host trust mismatch' });
  const compactionEvent = value.eventType === 'context_compaction_started' || value.eventType === 'context_compaction_ended';
  if (compactionEvent !== Boolean(value.compaction)) ctx.addIssue({ code: 'custom', path: ['compaction'], message: 'compaction material must appear only on compaction events' });
  const retryExpected: Partial<Record<(typeof RUNTIME_EVENT_TYPES)[number], string[]>> = {
    agent_settled_observed: ['settled', 'fenced'], pi_auto_retry_started: ['started'],
    pi_auto_retry_ended: ['ended'], pi_auto_retry_settled: ['settled', 'fenced'],
  };
  const allowedRetryPhases = retryExpected[value.eventType];
  if (allowedRetryPhases && (!value.retryPhase || !allowedRetryPhases.includes(value.retryPhase.phase) || !value.stateOrderLinkHash)) ctx.addIssue({ code: 'custom', path: ['retryPhase'], message: 'retry phase does not match event type' });
  if (!allowedRetryPhases && value.retryPhase) ctx.addIssue({ code: 'custom', path: ['retryPhase'], message: 'retry material forbidden for event type' });
  const candidateExpected: Partial<Record<(typeof RUNTIME_EVENT_TYPES)[number], string>> = {
    execution_completion_candidate_observed: 'observed', execution_completion_candidate_validated: 'controller_validated',
    execution_completion_candidate_rejected: 'controller_rejected', execution_completion_candidate_submitted: 'submitted_to_closeout',
  };
  const expectedCandidate = candidateExpected[value.eventType];
  if (expectedCandidate && value.completionCandidate?.state !== expectedCandidate) ctx.addIssue({ code: 'custom', path: ['completionCandidate'], message: 'completion candidate state does not match event type' });
  if (!expectedCandidate && value.completionCandidate) ctx.addIssue({ code: 'custom', path: ['completionCandidate'], message: 'completion candidate material forbidden for event type' });
  if (['continuation_authorized', 'continuation_dispatched', 'continuation_settled'].includes(value.eventType)
    && (value.continuationDispatchId === 'not_applicable' || value.continuationDispatchHash === 'not_applicable')) {
    ctx.addIssue({ code: 'custom', path: ['continuationDispatchId'], message: 'continuation dispatch identity required' });
  }
});

export const EvidenceEnvelopeV1Schema = ArtifactHeaderSchema.extend({
  schemaVersion: z.literal('rorca.evidence-envelope.v1'), contractId: z.literal('rorca.evidence-envelope.v1'),
  evidenceId: StableIdSchema, evidenceHash: Sha256Schema, kind: StableIdSchema,
  trustClass: z.enum(['runtime_asserted', 'host_observed', 'automated_test', 'provider_verified', 'provider_human']),
  observerId: StableIdSchema, workspaceId: StableIdSchema, missionId: StableIdSchema, missionRevision: z.number().int().positive(),
  workPackageId: StableIdSchema, workPackageRevision: z.number().int().positive(),
  specId: StableIdSchema, specVersion: z.number().int().positive(), specHash: Sha256Schema,
  storyId: StableIdSchema, storyVersion: z.number().int().positive(), storyHash: Sha256Schema,
  attemptId: StableIdSchema, leaseId: StableIdSchema, fencingToken: z.number().int().positive(), policyActivationId: StableIdSchema,
  policyActivationHash: Sha256Schema, checkpointId: StableIdSchema, repositoryId: StableIdSchema, repositoryRevision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  worktreeId: StableIdSchema, observedAt: CanonicalTimestampSchema, receivedAt: CanonicalTimestampSchema, databaseTime: CanonicalTimestampSchema,
  status: z.enum(['passed', 'failed', 'unknown', 'conflicted', 'cancelled']), payloadHash: Sha256Schema,
  redactionClass: z.enum(['redacted', 'restricted']), restrictedRef: RestrictedReferenceSchema,
  independentReviewProvenanceHash: Sha256Schema.nullable(),
}).strict();

export const CloseoutEvaluationV1Schema = ArtifactHeaderSchema.extend({
  schemaVersion: z.literal('rorca.closeout-evaluation.v1'), contractId: z.literal('rorca.closeout-evaluation.v1'),
  evaluationId: StableIdSchema, workspaceId: StableIdSchema, missionId: StableIdSchema, missionRevision: z.number().int().positive(),
  workPackageId: StableIdSchema, workPackageRevision: z.number().int().positive(), specHash: Sha256Schema, storyHash: Sha256Schema,
  attemptId: StableIdSchema, leaseId: StableIdSchema, fencingToken: z.number().int().positive(), policyActivationHash: Sha256Schema,
  checkpointHash: Sha256Schema, repositoryRevision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), worktreeId: StableIdSchema,
  evidence: z.array(z.object({ evidenceId: StableIdSchema, evidenceHash: Sha256Schema }).strict()).min(1).max(500),
  obligationSetId: StableIdSchema, obligationSetHash: Sha256Schema,
  policyVersion: z.string(), resolverVersion: z.string(), outcome: z.enum(['eligible', 'blocked', 'failed', 'cancelled', 'expired', 'conflicted', 'stale', 'reconciliation_required']),
  missingEvidenceKinds: z.array(StableIdSchema).max(100), conflictingEvidenceIds: z.array(StableIdSchema).max(100),
  decisionTime: CanonicalTimestampSchema, storyCloseoutDecisionId: StableIdSchema.nullable(),
  establishesStoryCompletion: z.literal(false),
}).strict();

export type RuntimeEventV1 = z.infer<typeof RuntimeEventV1Schema>;
export type EvidenceEnvelopeV1 = z.infer<typeof EvidenceEnvelopeV1Schema>;
