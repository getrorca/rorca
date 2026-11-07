/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
import {
  RUN_STREAM_OPERATIONAL_PLANES,
  RunStreamEnvelopeV1Schema,
  StatusPlaneObservationPayloadSchema,
  VerifiedCloseoutProjectionPayloadSchema,
  type RunStreamEnvelopeV1,
  type RunStreamOperationalPlane,
} from './governed-contracts/run-stream';

export type RunViewState = 'empty' | 'replaying' | 'live' | 'reconnecting' | 'gap' | 'stale' | 'degraded'
  | 'rejected' | 'quarantined' | 'error' | 'transport_closed' | 'story_accepted';

export interface OperationalPlaneProjection {
  plane: RunStreamOperationalPlane;
  status: 'active' | 'healthy' | 'degraded' | 'failed' | 'stale' | 'rejected' | 'authorized' | 'dispatched' | 'settled' | 'gap' | 'quarantined' | 'unknown';
  sourceClass: string | null;
  sourceIdentity: string | null;
  sourceHash: string | null;
  observedAt: string | null;
  validUntil: string | null;
  reasonCode: string;
  impact: string;
  nextSafeAction: string;
}

export interface RunActivityProjection {
  schemaVersion: 'rorca.run-activity-projection.v1';
  streamId: string | null;
  runtimeGeneration: number | null;
  lastSequence: number;
  lastEventHash: string | null;
  eventCount: number;
  incomplete: boolean;
  gap: { expectedSequence: number; observedSequence: number; reasonCode: string } | null;
  transport: 'empty' | 'open' | 'closed' | 'throttled' | 'terminated';
  lease: 'unknown' | 'active' | 'stale' | 'expired' | 'released' | 'cancelled';
  cancellation: 'none' | 'requested' | 'acknowledged' | 'settled';
  context: 'unknown' | 'compacting' | 'compacted' | 'aborted' | 'retrying' | 'settled' | 'stale' | 'rejected' | 'quarantined';
  completionCandidate: 'absent' | 'observed' | 'controller_rejected' | 'controller_validated' | 'submitted_to_closeout';
  retryBudget: { state: 'none' | 'available' | 'backoff' | 'exhausted' | 'quarantined'; spent: number; maximum: number };
  closeout: { decisionId: string; decisionHash: string; status: 'accepted' | 'blocked'; verified: true } | null;
  establishesStoryCompletion: boolean;
  operationalPlanes: Record<RunStreamOperationalPlane, OperationalPlaneProjection>;
}

export function createEmptyRunActivityProjection(): RunActivityProjection {
  const operationalPlanes = Object.fromEntries(RUN_STREAM_OPERATIONAL_PLANES.map((plane) => [plane, {
    plane,
    status: 'unknown',
    sourceClass: null,
    sourceIdentity: null,
    sourceHash: null,
    observedAt: null,
    validUntil: null,
    reasonCode: 'not_observed',
    impact: 'No canonical observation is available for this independent plane.',
    nextSafeAction: 'Wait for or request a typed plane observation.',
  }])) as Record<RunStreamOperationalPlane, OperationalPlaneProjection>;
  return {
    schemaVersion: 'rorca.run-activity-projection.v1',
    streamId: null,
    runtimeGeneration: null,
    lastSequence: 0,
    lastEventHash: null,
    eventCount: 0,
    incomplete: false,
    gap: null,
    transport: 'empty',
    lease: 'unknown',
    cancellation: 'none',
    context: 'unknown',
    completionCandidate: 'absent',
    retryBudget: { state: 'none', spent: 0, maximum: 0 },
    closeout: null,
    establishesStoryCompletion: false,
    operationalPlanes,
  };
}

function markGap(projection: RunActivityProjection, observedSequence: number, reasonCode: string): RunActivityProjection {
  return {
    ...projection,
    incomplete: true,
    gap: { expectedSequence: projection.lastSequence + 1, observedSequence, reasonCode },
  };
}

/** Pure reducer. Non-contiguous, cross-stream, cross-generation, or bad-hash input never advances verified state. */
export function applyRunStreamEnvelope(current: RunActivityProjection, candidate: unknown): RunActivityProjection {
  const parsed = RunStreamEnvelopeV1Schema.safeParse(candidate);
  if (!parsed.success) return markGap(current, current.lastSequence + 1, 'invalid_envelope');
  const event = parsed.data;
  if (current.streamId !== null && current.streamId !== event.streamId) return markGap(current, event.streamSequence, 'stream_changed');
  if (current.runtimeGeneration !== null && current.runtimeGeneration !== event.runtimeGeneration) {
    return markGap(current, event.streamSequence, 'generation_changed');
  }
  if (event.streamSequence !== current.lastSequence + 1) return markGap(current, event.streamSequence, 'sequence_gap');
  if (current.lastEventHash !== null && event.priorEventHash !== current.lastEventHash) return markGap(current, event.streamSequence, 'hash_chain_conflict');

  let next: RunActivityProjection = {
    ...current,
    streamId: event.streamId,
    runtimeGeneration: event.runtimeGeneration,
    lastSequence: event.streamSequence,
    lastEventHash: event.eventHash,
    eventCount: current.eventCount + 1,
  };
  const payload = event.payload as Record<string, unknown>;
  switch (event.kind) {
    case 'transport_opened': next = { ...next, transport: 'open' }; break;
    case 'transport_closed': next = { ...next, transport: 'closed' }; break;
    case 'transport_throttled': next = { ...next, transport: 'throttled' }; break;
    case 'transport_terminated': next = { ...next, transport: 'terminated' }; break;
    case 'lease_state_observed': {
      const leaseState = payload.state as RunActivityProjection['lease'];
      next = {
        ...next,
        lease: leaseState,
        retryBudget: {
          state: payload.retryState as RunActivityProjection['retryBudget']['state'],
          spent: payload.retrySpent as number,
          maximum: payload.retryMaximum as number,
        },
      };
      break;
    }
    case 'cancellation_state_observed': next = { ...next, cancellation: payload.state as RunActivityProjection['cancellation'] }; break;
    case 'context_compaction_started': next = { ...next, context: 'compacting' }; break;
    case 'context_compaction_ended': {
      next = { ...next, context: payload.aborted === true ? 'aborted' : payload.status === 'success' ? 'compacted' : 'rejected' };
      break;
    }
    case 'pi_auto_retry_started': next = { ...next, context: 'retrying' }; break;
    case 'agent_settled_observed':
    case 'pi_auto_retry_settled': next = { ...next, context: payload.eligibleForContinuation === true ? 'settled' : next.context }; break;
    case 'context_stale': next = { ...next, context: 'stale' }; break;
    case 'context_rejected': next = { ...next, context: 'rejected' }; break;
    case 'continuation_quarantined': next = { ...next, context: 'quarantined', retryBudget: { ...next.retryBudget, state: 'quarantined' } }; break;
    case 'execution_completion_candidate_observed':
    case 'execution_completion_candidate_validated':
    case 'execution_completion_candidate_rejected':
    case 'execution_completion_candidate_submitted': {
      next = { ...next, completionCandidate: payload.candidateState as RunActivityProjection['completionCandidate'] };
      break;
    }
    case 'story_closeout_observed': {
      const closeout = VerifiedCloseoutProjectionPayloadSchema.parse(event.payload);
      next = {
        ...next,
        closeout: { decisionId: closeout.decisionId, decisionHash: closeout.decisionHash, status: closeout.decisionStatus, verified: true },
        establishesStoryCompletion: closeout.establishesStoryCompletion,
      };
      break;
    }
    case 'stream_gap': next = markGap(next, event.streamSequence, String(payload.reasonCode)); break;
    case 'status_plane_observed': {
      const plane = StatusPlaneObservationPayloadSchema.parse(event.payload);
      next = {
        ...next,
        operationalPlanes: {
          ...next.operationalPlanes,
          [plane.plane]: {
            plane: plane.plane,
            status: plane.status,
            sourceClass: plane.sourceClass,
            sourceIdentity: plane.sourceIdentity,
            sourceHash: plane.sourceHash,
            observedAt: plane.observedAt,
            validUntil: plane.validUntil,
            reasonCode: plane.reasonCode,
            impact: plane.impact,
            nextSafeAction: plane.nextSafeAction,
          },
        },
      };
      break;
    }
    default: break;
  }
  return next;
}

export function reduceRunActivity(events: readonly RunStreamEnvelopeV1[], seed = createEmptyRunActivityProjection()): RunActivityProjection {
  return events.reduce<RunActivityProjection>((projection, event) => applyRunStreamEnvelope(projection, event), seed);
}

export function projectExpiredOperationalPlanes(projection: RunActivityProjection, now: Date): RunActivityProjection {
  const timestamp = now.getTime();
  const operationalPlanes = Object.fromEntries(Object.entries(projection.operationalPlanes).map(([name, plane]) => {
    if (plane.validUntil !== null && Date.parse(plane.validUntil) < timestamp) {
      return [name, { ...plane, status: 'stale' as const, reasonCode: 'observation_expired',
        nextSafeAction: 'Obtain a new typed observation from the same plane source.' }];
    }
    return [name, plane];
  })) as Record<RunStreamOperationalPlane, OperationalPlaneProjection>;
  return { ...projection, operationalPlanes };
}

export function deriveRunViewState(projection: RunActivityProjection, transportState?: 'replaying' | 'live' | 'reconnecting' | 'error'): RunViewState {
  if (projection.establishesStoryCompletion && projection.closeout?.status === 'accepted') return 'story_accepted';
  if (projection.context === 'quarantined' || Object.values(projection.operationalPlanes).some((plane) => plane.status === 'quarantined')) return 'quarantined';
  if (projection.incomplete || projection.gap || Object.values(projection.operationalPlanes).some((plane) => plane.status === 'gap')) return 'gap';
  if (transportState === 'error') return 'error';
  if (transportState === 'reconnecting') return 'reconnecting';
  if (transportState === 'replaying') return 'replaying';
  if (projection.eventCount === 0) return 'empty';
  if (Object.values(projection.operationalPlanes).some((plane) => plane.status === 'rejected') || projection.context === 'rejected') return 'rejected';
  if (Object.values(projection.operationalPlanes).some((plane) => plane.status === 'failed' || plane.status === 'degraded')) return 'degraded';
  if (Object.values(projection.operationalPlanes).some((plane) => plane.status === 'stale') || projection.lease === 'stale' || projection.lease === 'expired') return 'stale';
  if (projection.transport === 'closed' || projection.transport === 'terminated') return 'transport_closed';
  return transportState === 'live' || projection.transport === 'open' ? 'live' : 'live';
}
