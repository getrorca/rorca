/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
import type { ContinuationScope } from './governed-contracts/context-continuation';
import { governedHash, type RestrictedReferenceSchema } from './governed-contracts/primitives';
import type { z } from 'zod';
import { RuntimeEventV1Schema, type RuntimeEventV1 } from './governed-contracts/runtime-event';
import {
  PtyOutputReferencePayloadSchema,
  StatusPlaneObservationPayloadSchema,
  VerifiedCloseoutProjectionPayloadSchema,
  type RuntimeNeutralObservationV1,
  type StatusPlaneObservationPayload,
} from './governed-contracts/run-stream';
import { UnprocessableError } from './errors';
import { runActivityStore, type AppendRunActivityResult, type RunActivityStore } from './run-activity-store';
import type { PtyCommittedRangeCallback } from './pty-manager';

type RestrictedReference = z.infer<typeof RestrictedReferenceSchema>;

export function runActivityStreamId(scope: ContinuationScope): string {
  return `stream:activity:${governedHash('rorca.run-activity-stream-id.v1', {
    workspaceId: scope.workspaceId,
    attemptId: scope.attemptId,
    runtimeId: scope.runtimeId,
    runtimeGeneration: scope.runtimeGeneration,
  }).slice('sha256:'.length)}`;
}

export function createPtyRangeProjectionCallback(
  scope: ContinuationScope,
  store: RunActivityStore = runActivityStore,
): PtyCommittedRangeCallback {
  const streamId = runActivityStreamId(scope);
  return async (range) => {
    await projectPtyOutputReference({
      streamId,
      scope,
      generationId: range.generationId,
      firstSequence: range.firstSequence,
      lastSequence: range.lastSequence,
      byteCount: range.byteCount,
      rangeHash: range.rangeHash,
      checkpointId: 'not_applicable',
      checkpointHash: 'not_applicable',
      archiveManifestHash: 'not_applicable',
      restrictedRef: {
        referenceId: `pty-range:${range.generationId}:${range.firstSequence}:${range.lastSequence}`,
        kind: 'transcript',
        hash: range.rangeHash,
        sensitivity: 'restricted',
        retentionClass: 'pty-raw-archive',
        accessTier: 'admin',
        rawPayloadIncluded: false,
      },
      observedAt: range.observedAt,
    }, store);
  };
}

function commonRuntimePayload(event: RuntimeEventV1) {
  return {
    eventType: event.eventType,
    runtimeSequence: event.runtimeSequence,
    canonicalStateOrder: event.canonicalStateOrder,
    hostReceiptOrder: event.hostReceiptOrder,
    reasonCode: event.reasonCode,
    count: event.count,
    durationMs: event.durationMs,
    trustClass: event.trustClass,
    originatingTurnId: event.scope.turnId,
    originatingGeneration: event.scope.originatingGeneration,
    runtimeGeneration: event.scope.runtimeGeneration,
    sessionId: event.scope.sessionId,
    establishesStoryCompletion: false as const,
  };
}

export function runtimeEventObservation(candidate: unknown, streamId: string): RuntimeNeutralObservationV1 {
  const event = RuntimeEventV1Schema.parse(candidate);
  const common = commonRuntimePayload(event);
  let payload: Record<string, unknown>;
  if (event.eventType === 'story_closeout_observed') {
    throw new UnprocessableError('Runtime story-closeout assertions cannot be projected as completion', 'CANONICAL_CLOSEOUT_REQUIRED');
  } else if (event.eventType === 'context_compaction_started' || event.eventType === 'context_compaction_ended') {
    const compaction = event.compaction!;
    payload = {
      ...common,
      status: compaction.status,
      aborted: compaction.aborted,
      willRetry: compaction.willRetry,
      resultHash: compaction.resultHash,
      summaryHash: compaction.summaryHash,
      settledEventId: compaction.settledEventId ?? 'not_applicable',
      eligibleForContinuation: event.eventType === 'context_compaction_ended' && compaction.status === 'success'
        && !compaction.aborted && !compaction.willRetry && compaction.settledEventId !== null,
    };
  } else if (['agent_settled_observed', 'pi_auto_retry_started', 'pi_auto_retry_ended', 'pi_auto_retry_settled'].includes(event.eventType)) {
    const retry = event.retryPhase!;
    payload = {
      ...common,
      retryCycleId: retry.retryCycleId,
      phase: retry.phase,
      retryAttempt: retry.attempt,
      retryMaximum: retry.maximum,
      retryGeneration: retry.generation,
      stateOrderLinkHash: event.stateOrderLinkHash!,
      eligibleForContinuation: ['agent_settled_observed', 'pi_auto_retry_settled'].includes(event.eventType)
        && ['settled', 'fenced'].includes(retry.phase) && retry.generation === event.scope.runtimeGeneration,
    };
  } else if (event.completionCandidate) {
    payload = {
      ...common,
      candidateState: event.completionCandidate.state,
      candidateHash: event.completionCandidate.candidateHash,
      closeoutDecisionId: 'not_applicable',
    };
  } else {
    payload = common;
  }
  return {
    eventId: event.eventId,
    streamId,
    scope: event.scope,
    source: {
      store: 'runtime_events',
      recordId: event.eventId,
      recordRevision: event.runtimeSequence,
      recordHash: event.contentHash,
      sourceSequence: event.runtimeSequence,
    },
    observedAt: event.observedAt,
    kind: event.eventType,
    plane: event.eventType.startsWith('context_') || event.eventType.startsWith('continuation_')
      || event.eventType.startsWith('cursor_') || event.eventType.startsWith('pi_auto_retry')
      || event.eventType === 'agent_settled_observed' ? 'context'
      : event.eventType.startsWith('cancellation_') ? 'cancellation'
        : event.eventType.startsWith('execution_completion_candidate_') ? 'closeout' : 'activity',
    payload,
    redactionClass: event.redactionClass,
    restrictedRef: event.restrictedRef,
    orderingMode: 'live_projection',
  };
}

export async function projectRuntimeEvent(candidate: unknown, streamId: string,
  store: RunActivityStore = runActivityStore): Promise<AppendRunActivityResult> {
  return store.append(runtimeEventObservation(candidate, streamId));
}

export interface VerifiedCloseoutProjectionInput {
  streamId: string;
  scope: ContinuationScope;
  decisionId: string;
  decisionHash: string;
  decisionStatus: 'accepted' | 'blocked';
  subjectHash: string;
  sourceRevision: number;
  observedAt: string;
}

export async function projectVerifiedCloseoutDecision(input: VerifiedCloseoutProjectionInput,
  store: RunActivityStore = runActivityStore): Promise<AppendRunActivityResult> {
  const payload = VerifiedCloseoutProjectionPayloadSchema.parse({
    decisionId: input.decisionId,
    decisionHash: input.decisionHash,
    decisionStatus: input.decisionStatus,
    subjectHash: input.subjectHash,
    integrityVerified: true,
    exactSubjectMatched: true,
    establishesStoryCompletion: input.decisionStatus === 'accepted',
  });
  return store.append({
    eventId: `projection:${input.decisionId}`,
    streamId: input.streamId,
    scope: input.scope,
    source: {
      store: 'story_closeout_decisions',
      recordId: input.decisionId,
      recordRevision: input.sourceRevision,
      recordHash: input.decisionHash,
      sourceSequence: input.sourceRevision,
    },
    observedAt: input.observedAt,
    kind: 'story_closeout_observed',
    plane: 'closeout',
    payload,
    redactionClass: 'none',
    restrictedRef: null,
    orderingMode: 'live_projection',
  });
}

export interface PtyRangeProjectionInput {
  streamId: string;
  scope: ContinuationScope;
  generationId: string;
  firstSequence: number;
  lastSequence: number;
  byteCount: number;
  rangeHash: string;
  checkpointId: string | 'not_applicable';
  checkpointHash: string | 'not_applicable';
  archiveManifestHash: string | 'not_applicable';
  restrictedRef: RestrictedReference;
  observedAt: string;
}

export async function projectPtyOutputReference(input: PtyRangeProjectionInput,
  store: RunActivityStore = runActivityStore): Promise<AppendRunActivityResult> {
  const payload = PtyOutputReferencePayloadSchema.parse({
    generationId: input.generationId,
    firstSequence: input.firstSequence,
    lastSequence: input.lastSequence,
    byteCount: input.byteCount,
    rangeHash: input.rangeHash,
    checkpointId: input.checkpointId,
    checkpointHash: input.checkpointHash,
    archiveManifestHash: input.archiveManifestHash,
    restrictedRef: input.restrictedRef,
    rawBytesIncluded: false,
    establishesStoryCompletion: false,
  });
  const recordId = `pty-range:${input.generationId}:${input.firstSequence}:${input.lastSequence}`;
  return store.append({
    eventId: `projection:${recordId}`,
    streamId: input.streamId,
    scope: input.scope,
    source: {
      store: 'run_pty_output_chunks',
      recordId,
      recordRevision: input.lastSequence,
      recordHash: governedHash('rorca.pty-range-projection-source.v1', {
        generationId: input.generationId,
        firstSequence: input.firstSequence,
        lastSequence: input.lastSequence,
        byteCount: input.byteCount,
        rangeHash: input.rangeHash,
      }),
      sourceSequence: input.lastSequence,
    },
    observedAt: input.observedAt,
    kind: 'pty_output_referenced',
    plane: 'terminal',
    payload,
    redactionClass: 'restricted',
    restrictedRef: input.restrictedRef,
    orderingMode: 'live_projection',
  });
}

export interface StatusPlaneProjectionInput {
  streamId: string;
  scope: ContinuationScope;
  observationId: string;
  sourceRevision: number;
  sourceStore: 'queue_outbox' | 'dependency_observation' | 'provider_operations' | 'execution_leases' | 'run_activity_internal';
  payload: StatusPlaneObservationPayload;
}

export async function projectStatusPlane(input: StatusPlaneProjectionInput,
  store: RunActivityStore = runActivityStore): Promise<AppendRunActivityResult> {
  const payload = StatusPlaneObservationPayloadSchema.parse(input.payload);
  return store.append({
    eventId: `projection:${input.observationId}`,
    streamId: input.streamId,
    scope: input.scope,
    source: {
      store: input.sourceStore,
      recordId: input.observationId,
      recordRevision: input.sourceRevision,
      recordHash: payload.sourceHash,
      sourceSequence: input.sourceRevision,
    },
    observedAt: payload.observedAt,
    kind: 'status_plane_observed',
    plane: 'operations',
    payload,
    redactionClass: 'redacted',
    restrictedRef: null,
    orderingMode: 'live_projection',
  });
}
