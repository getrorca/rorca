/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
import {
  RUNTIME_TELEMETRY_EVENT_KINDS,
  RUN_STREAM_EVENT_KINDS,
  RUN_STREAM_OPERATIONAL_PLANES,
  RunStreamEnvelopeV1Schema,
  RuntimeNeutralObservationV1Schema,
  RuntimeTelemetryBatchV1Schema,
  StatusPlaneObservationPayloadSchema,
  type RunStreamEventKind,
} from '../governed-contracts/run-stream';
import { RUNTIME_EVENT_TYPES } from '../governed-contracts/runtime-event';
import { applyRunStreamEnvelope, createEmptyRunActivityProjection, deriveRunViewState, projectExpiredOperationalPlanes, reduceRunActivity } from '../run-activity-reducers';
import { redactRunActivityObservation } from '../run-activity-redaction';
import { createPtyRangeProjectionCallback, runActivityStreamId } from '../run-activity-projector';
import type { RunActivityStore } from '../run-activity-store';

const H = `sha256:${'a'.repeat(64)}`;
const H2 = `sha256:${'b'.repeat(64)}`;
const G = 'c'.repeat(40);
const T = '2026-08-05T00:00:00.000Z';
const scope = {
  workspaceId: 'workspace:one', missionId: 'mission:one', missionRevision: 1, missionHash: H,
  workPackageId: 'work-package:one', workPackageRevision: 1, workPackageHash: H,
  spec: { specId: 'spec:one', specVersion: 1, specHash: H, canonicalSpecPath: 'specs/one.json',
    storyId: 'story:one', storyVersion: 1, storyHash: H, criteriaManifestHash: H },
  runId: 7, attemptId: 'attempt:one', leaseId: 'lease:one', fencingToken: 3,
  leaseExpiresAt: '2026-08-05T00:30:00.000Z', cancellationId: 'cancellation:none', runtimeId: 'runtime:one',
  controllerGeneration: 1, runtimeGeneration: 2, sessionId: 'session:one', sessionFileHash: H,
  turnId: 'turn:one', turnAttempt: 1, originatingGeneration: 2, cursor: 0, cursorHash: H,
  priorEntryId: 'not_applicable' as const,
  repository: { repositoryId: 'repository:one', remoteAuthorityHash: H, gitObjectFormat: 'sha1' as const,
    baseSha: G, currentSha: G, expectedHeadSha: G, worktreeId: 'worktree:one', allowedPathManifestHash: H,
    requiredPathManifestHash: H, changedPathManifestHash: H, forbiddenPathManifestHash: H },
  validationStateHash: H, rootCauseClassification: 'root-cause:none', rootCauseHash: H,
  policyDefinitionId: 'policy:one', policyDefinitionVersion: '1.0.0', policyDefinitionHash: H,
  policyActivationId: 'activation:one', policyActivationRevision: 1, policyActivationHash: H,
};
const restrictedRef = { referenceId: 'reference:one', kind: 'transcript' as const, hash: H,
  sensitivity: 'restricted' as const, retentionClass: 'retention:restricted', accessTier: 'admin' as const,
  rawPayloadIncluded: false as const };

function transportPayload(state: 'opened' | 'closed' | 'throttled' | 'terminated') {
  return { state, reasonCode: 'transport:observation', retryAfterMs: 0, droppedRecords: 0,
    establishesStoryCompletion: false as const };
}

function envelope(kind: RunStreamEventKind, payload: unknown, sequence = 1, eventHash = H,
  priorEventHash: string = sequence === 1 ? 'stream_origin' : H) {
  return RunStreamEnvelopeV1Schema.parse({
    schemaVersion: 'rorca.run-stream-envelope.v1', contractId: 'rorca.run-stream-envelope.v1', contractVersion: '1.0.0',
    eventId: `event:${sequence}:${kind}`, streamId: 'stream:one', scope, runtimeGeneration: 2,
    streamSequence: sequence, priorEventHash, eventHash, payloadHash: H,
    source: { store: 'run_activity_internal', recordId: `source:${sequence}`, recordRevision: sequence,
      recordHash: H, sourceSequence: sequence },
    observedAt: T, receivedAt: T, databaseTime: T, projectedAt: T,
    kind, plane: kind.startsWith('transport_') ? 'transport' : kind === 'status_plane_observed' ? 'operations' : 'closeout',
    payload,
    redaction: { class: 'none', policyHash: H, redactedFieldCount: 0, restrictedRef: null,
      ordinaryProjectionContainsRaw: false },
    retention: { policyHash: H, retainUntil: '2026-09-05T00:00:00.000Z', archiveManifestHash: 'not_applicable' },
    orderingMode: 'live_projection', projectionOnly: true, authorityEffect: 'none',
  });
}

const commonRuntime = {
  eventType: 'attempt_started' as const, runtimeSequence: 0, canonicalStateOrder: 0, hostReceiptOrder: 0,
  reasonCode: 'attempt:started', count: 0, durationMs: 0, trustClass: 'runtime_asserted' as const,
  originatingTurnId: 'turn:one', originatingGeneration: 2, runtimeGeneration: 2, sessionId: 'session:one',
  establishesStoryCompletion: false as const,
};

describe('Wave 3B runtime-neutral stream contract', () => {
  test('registers every frozen runtime event without rename plus transport/projection events', () => {
    expect(RUNTIME_EVENT_TYPES.every((kind) => RUN_STREAM_EVENT_KINDS.includes(kind))).toBe(true);
    expect(new Set(RUN_STREAM_EVENT_KINDS).size).toBe(RUN_STREAM_EVENT_KINDS.length);
    expect(RUN_STREAM_OPERATIONAL_PLANES).toHaveLength(7);
  });

  test('telemetry ingress admits only runtime-owned non-authoritative observations', () => {
    expect(RUNTIME_TELEMETRY_EVENT_KINDS).toContain('activity_observed');
    expect(RUNTIME_TELEMETRY_EVENT_KINDS).not.toContain('story_closeout_observed');
    expect(RUNTIME_TELEMETRY_EVENT_KINDS).not.toContain('status_plane_observed');
    const activity = RuntimeNeutralObservationV1Schema.parse({
      eventId: 'event:runtime-activity', streamId: 'stream:one', scope,
      source: { store: 'fake_federated_runtime', recordId: 'runtime:activity:one', recordRevision: 1,
        recordHash: H, sourceSequence: 0 },
      observedAt: T, kind: 'activity_observed', plane: 'activity',
      payload: { activityType: 'runtime:turn', reasonCode: 'turn:observed', count: 1, durationMs: 1,
        referenceHash: H, establishesStoryCompletion: false },
      redactionClass: 'none', restrictedRef: null, orderingMode: 'live_projection',
    });
    const batch = {
      schemaVersion: 'rorca.runtime-telemetry-batch.v1', contractVersion: '1.0.0',
      batchId: 'batch:runtime-owned', batchHash: H, workspaceId: scope.workspaceId, runtimeId: scope.runtimeId,
      attemptId: scope.attemptId, leaseId: scope.leaseId, fencingToken: scope.fencingToken,
      runtimeGeneration: scope.runtimeGeneration, firstSourceSequence: 0, events: [activity],
      compressedBytes: 100, uncompressedBytes: 200,
    };
    expect(RuntimeTelemetryBatchV1Schema.safeParse(batch).success).toBe(true);
    const closeout = {
      ...activity, eventId: 'event:forged-closeout', kind: 'story_closeout_observed', plane: 'closeout',
      payload: { decisionId: 'decision:forged', decisionHash: H, decisionStatus: 'accepted', subjectHash: H,
        integrityVerified: true, exactSubjectMatched: true, establishesStoryCompletion: true },
    };
    const status = {
      ...activity, eventId: 'event:forged-plane', kind: 'status_plane_observed', plane: 'operations',
      payload: { plane: 'runtime_health', status: 'healthy', sourceClass: 'sandbox_resource_monitor',
        sourceIdentity: 'runtime:forged', sourceHash: H, observedAt: T, validUntil: '2026-08-05T00:01:00.000Z',
        reasonCode: 'runtime:claimed_healthy', impact: 'Forged health.', nextSafeAction: 'Trust runtime.',
        establishesStoryCompletion: false },
    };
    for (const forged of [closeout, status]) {
      const result = RuntimeTelemetryBatchV1Schema.safeParse({ ...batch, events: [forged] });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ['events', 0, 'kind'] }),
      ]));
    }
  });

  test('binds each transport kind to its matching semantic state', () => {
    expect(() => envelope('transport_opened', transportPayload('terminated'))).toThrow();
    expect(() => envelope('transport_closed', transportPayload('opened'))).toThrow();
    expect(envelope('transport_throttled', transportPayload('throttled')).payload).toMatchObject({ state: 'throttled' });
  });

  test('execution-engine PTY callbacks project a restricted range reference without raw bytes', async () => {
    const append = jest.fn().mockResolvedValue({ duplicate: false });
    const callback = createPtyRangeProjectionCallback(scope, { append } as unknown as RunActivityStore);
    await callback({
      generationId: 'generation:one',
      firstSequence: 4,
      lastSequence: 6,
      byteCount: 12_345,
      rangeHash: H2,
      observedAt: T,
    });

    expect(append).toHaveBeenCalledTimes(1);
    const observation = append.mock.calls[0]![0];
    expect(observation).toMatchObject({
      streamId: runActivityStreamId(scope),
      kind: 'pty_output_referenced',
      plane: 'terminal',
      redactionClass: 'restricted',
      payload: {
        generationId: 'generation:one',
        firstSequence: 4,
        lastSequence: 6,
        byteCount: 12_345,
        rangeHash: H2,
        rawBytesIncluded: false,
        establishesStoryCompletion: false,
      },
      restrictedRef: {
        kind: 'transcript',
        hash: H2,
        sensitivity: 'restricted',
        rawPayloadIncluded: false,
      },
    });
    expect(JSON.stringify(observation)).not.toContain('raw-secret');
  });

  test('requires exact successful, non-aborted, non-retrying compaction eligibility', () => {
    const payload = { ...commonRuntime, eventType: 'context_compaction_ended' as const, status: 'success' as const,
      aborted: false, willRetry: false, resultHash: H, summaryHash: H, settledEventId: 'event:settled',
      eligibleForContinuation: true };
    expect(() => envelope('context_compaction_ended', payload)).not.toThrow();
    expect(() => envelope('context_compaction_ended', { ...payload, aborted: true })).toThrow(/eligibility/);
    expect(() => envelope('context_compaction_ended', { ...payload, willRetry: true })).toThrow(/eligibility/);
    expect(() => envelope('context_compaction_started', { ...payload, eventType: 'context_compaction_started' })).toThrow(/eligibility/);
  });

  test('binds settled/retry phase, turn, generation, session, and cycle', () => {
    const payload = { ...commonRuntime, eventType: 'pi_auto_retry_settled' as const, retryCycleId: 'retry:one',
      phase: 'settled' as const, retryAttempt: 1, retryMaximum: 3, retryGeneration: 2,
      stateOrderLinkHash: H, eligibleForContinuation: true };
    expect(() => envelope('pi_auto_retry_settled', payload)).not.toThrow();
    expect(() => envelope('pi_auto_retry_started', { ...payload, eventType: 'pi_auto_retry_started', phase: 'settled' })).toThrow(/phase/);
    expect(() => envelope('pi_auto_retry_settled', { ...payload, retryGeneration: 1 })).toThrow(/eligibility/);
  });

  test('completion candidates are proposal-only and cannot contain closeout authority', () => {
    const candidate = { ...commonRuntime, eventType: 'execution_completion_candidate_validated' as const,
      candidateState: 'controller_validated' as const, candidateHash: H, closeoutDecisionId: 'not_applicable' as const };
    const projection = applyRunStreamEnvelope(createEmptyRunActivityProjection(),
      envelope('execution_completion_candidate_validated', candidate));
    expect(projection.completionCandidate).toBe('controller_validated');
    expect(projection.establishesStoryCompletion).toBe(false);
    expect(() => envelope('execution_completion_candidate_validated', { ...candidate,
      establishesStoryCompletion: true, closeoutDecisionId: 'decision:forged' })).toThrow();
  });

  test('only an exact verified accepted canonical closeout establishes completion', () => {
    const closed = envelope('transport_closed', transportPayload('closed'));
    const candidate = envelope('execution_completion_candidate_submitted', { ...commonRuntime,
      eventType: 'execution_completion_candidate_submitted', candidateState: 'submitted_to_closeout',
      candidateHash: H, closeoutDecisionId: 'not_applicable' }, 2, H2, H);
    let projection = reduceRunActivity([closed, candidate]);
    expect(projection.establishesStoryCompletion).toBe(false);
    expect(deriveRunViewState(projection)).toBe('transport_closed');
    const accepted = envelope('story_closeout_observed', { decisionId: 'decision:one', decisionHash: H,
      decisionStatus: 'accepted', subjectHash: H, integrityVerified: true, exactSubjectMatched: true,
      establishesStoryCompletion: true }, 3, H, H2);
    projection = applyRunStreamEnvelope(projection, accepted);
    expect(projection.establishesStoryCompletion).toBe(true);
    expect(deriveRunViewState(projection)).toBe('story_accepted');
    expect(() => envelope('story_closeout_observed', { ...(accepted.payload as Record<string, unknown>), integrityVerified: false })).toThrow();
  });

  test('does not splice gaps, streams, generations, or hash chains', () => {
    const first = envelope('transport_opened', transportPayload('opened'));
    const projection = applyRunStreamEnvelope(createEmptyRunActivityProjection(), first);
    const skipped = envelope('transport_closed', transportPayload('closed'), 3, H2, H);
    const afterGap = applyRunStreamEnvelope(projection, skipped);
    expect(afterGap.incomplete).toBe(true);
    expect(afterGap.lastSequence).toBe(1);
    expect(afterGap.transport).toBe('open');
    const changedGeneration = RunStreamEnvelopeV1Schema.parse({ ...envelope('transport_closed', transportPayload('closed'), 2, H2, H),
      runtimeGeneration: 3, scope: { ...scope, runtimeGeneration: 3 } });
    expect(applyRunStreamEnvelope(projection, changedGeneration).gap?.reasonCode).toBe('generation_changed');
  });

  test('persists references rather than PTY bytes', () => {
    const payload = { generationId: 'generation:one', firstSequence: 1, lastSequence: 4, byteCount: 1024,
      rangeHash: H, checkpointId: 'checkpoint:one', checkpointHash: H, archiveManifestHash: H,
      restrictedRef, rawBytesIncluded: false, establishesStoryCompletion: false };
    expect(() => envelope('pty_output_referenced', payload)).not.toThrow();
    expect(() => envelope('pty_output_referenced', { ...payload, rawBytes: 'secret terminal bytes' })).toThrow();
  });
});

describe('Wave 3B redaction and operational planes', () => {
  test('redacts provider credentials and database URLs before projection', () => {
    const payload = StatusPlaneObservationPayloadSchema.parse({ plane: 'provider_operations_readiness',
      status: 'degraded', sourceClass: 'operations_controller', sourceIdentity: 'operations:one', sourceHash: H,
      observedAt: T, validUntil: '2026-08-05T00:10:00.000Z', reasonCode: 'provider:quota',
      impact: 'Bearer abcdefghijklmnopqrstuvwxyz and postgresql://user:password@db.internal/prod are unavailable',
      nextSafeAction: 'Rotate api_key=super-secret-value', establishesStoryCompletion: false });
    const observation = RuntimeNeutralObservationV1Schema.parse({ eventId: 'event:status', streamId: 'stream:one', scope,
      source: { store: 'provider_operations', recordId: 'operations:one', recordRevision: 1, recordHash: H, sourceSequence: 1 },
      observedAt: T, kind: 'status_plane_observed', plane: 'operations', payload, redactionClass: 'none', restrictedRef: null,
      orderingMode: 'live_projection' });
    const result = redactRunActivityObservation(observation);
    expect(JSON.stringify(result.payload)).not.toMatch(/abcdefghijklmnopqrstuvwxyz|password@|super-secret-value/);
    expect(JSON.stringify(result.payload)).toContain('[REDACTED]');
    expect(result.redactionClass).toBe('redacted');
  });

  test('rejects raw prompts, transcripts, context, environment snapshots, attestations, and invalid UTF-8', () => {
    const observation = RuntimeNeutralObservationV1Schema.parse({ eventId: 'event:activity', streamId: 'stream:one', scope,
      source: { store: 'run_activity_internal', recordId: 'source:one', recordRevision: 1, recordHash: H, sourceSequence: 1 },
      observedAt: T, kind: 'activity_observed', plane: 'activity',
      payload: { activityType: 'worker:step', reasonCode: 'worker:step', count: 1, durationMs: 1,
        referenceHash: H, establishesStoryCompletion: false }, redactionClass: 'none', restrictedRef: null,
      orderingMode: 'live_projection' });
    for (const key of ['rawPrompt', 'rawTranscript', 'environmentSnapshot', 'humanAttestation', 'authorization']) {
      expect(() => redactRunActivityObservation({ ...observation, payload: { ...(observation.payload as object), [key]: 'restricted' } })).toThrow(/forbidden/);
    }
    expect(() => redactRunActivityObservation({ ...observation,
      payload: { ...(observation.payload as object), activityType: 'bad\uFFFDutf8' } })).toThrow(/UTF-8/);
  });

  test('requires a distinct typed source for every independent plane', () => {
    const sources = {
      source_config_drift: 'canonical_config', dependency_health: 'dependency_probe',
      runtime_health: 'sandbox_resource_monitor', queue_outbox_freshness: 'queue_outbox_monitor',
      lease_retry_recovery: 'lease_controller', observability_freshness: 'observability_store',
      provider_operations_readiness: 'operations_controller',
    } as const;
    let projection = createEmptyRunActivityProjection();
    RUN_STREAM_OPERATIONAL_PLANES.forEach((plane, index) => {
      const payload = { plane, status: index === 3 ? 'failed' : 'healthy', sourceClass: sources[plane],
        sourceIdentity: `source:${plane}`, sourceHash: index % 2 ? H : H2, observedAt: T,
        validUntil: '2026-08-05T00:10:00.000Z', reasonCode: `reason:${plane}`,
        impact: `Independent impact for ${plane}`, nextSafeAction: `Independent action for ${plane}`,
        establishesStoryCompletion: false } as const;
      projection = applyRunStreamEnvelope(projection,
        envelope('status_plane_observed', payload, index + 1, index % 2 ? H : H2, index === 0 ? 'stream_origin' : (index - 1) % 2 ? H : H2));
    });
    expect(Object.keys(projection.operationalPlanes)).toHaveLength(7);
    expect(projection.operationalPlanes.runtime_health.status).toBe('healthy');
    expect(projection.operationalPlanes.queue_outbox_freshness.status).toBe('failed');
    expect(deriveRunViewState(projection)).toBe('degraded');
    expect(() => StatusPlaneObservationPayloadSchema.parse({
      plane: 'runtime_health', status: 'healthy', sourceClass: 'queue_outbox_monitor', sourceIdentity: 'heartbeat:one',
      sourceHash: H, observedAt: T, validUntil: T, reasonCode: 'heartbeat:seen', impact: 'None', nextSafeAction: 'None',
      establishesStoryCompletion: false,
    })).toThrow(/independent typed source/);
  });

  test('expires only the stale plane and preserves source/reason/action parity', () => {
    const payload = { plane: 'dependency_health' as const, status: 'healthy' as const, sourceClass: 'dependency_probe' as const,
      sourceIdentity: 'dependency:one', sourceHash: H, observedAt: T, validUntil: '2026-08-05T00:01:00.000Z',
      reasonCode: 'dependency:healthy', impact: 'Dependencies were available.', nextSafeAction: 'Probe dependencies again.',
      establishesStoryCompletion: false as const };
    const projection = applyRunStreamEnvelope(createEmptyRunActivityProjection(), envelope('status_plane_observed', payload));
    const expired = projectExpiredOperationalPlanes(projection, new Date('2026-08-05T00:02:00.000Z'));
    expect(expired.operationalPlanes.dependency_health).toMatchObject({ status: 'stale', sourceIdentity: 'dependency:one',
      impact: 'Dependencies were available.' });
    expect(expired.operationalPlanes.runtime_health.status).toBe('unknown');
    expect(deriveRunViewState(expired)).toBe('stale');
  });
});

describe('Wave 3B Run View states', () => {
  test.each([
    ['empty', createEmptyRunActivityProjection(), undefined],
    ['replaying', createEmptyRunActivityProjection(), 'replaying'],
    ['reconnecting', { ...createEmptyRunActivityProjection(), eventCount: 1 }, 'reconnecting'],
    ['error', { ...createEmptyRunActivityProjection(), eventCount: 1 }, 'error'],
  ] as const)('derives %s without inventing success', (expected, projection, transport) => {
    expect(deriveRunViewState(projection, transport)).toBe(expected);
    expect(projection.establishesStoryCompletion).toBe(false);
  });

  test('shows closed transport as non-completing and cancellation independently', () => {
    const opened = envelope('transport_opened', transportPayload('opened'));
    const cancellation = envelope('cancellation_state_observed', { state: 'requested', cancellationId: 'cancellation:one',
      reasonCode: 'operator:requested', establishesStoryCompletion: false }, 2, H2, H);
    const closed = envelope('transport_closed', transportPayload('closed'), 3, H, H2);
    const projection = reduceRunActivity([opened, cancellation, closed]);
    expect(projection.cancellation).toBe('requested');
    expect(projection.establishesStoryCompletion).toBe(false);
    expect(deriveRunViewState(projection)).toBe('transport_closed');
  });
  test('derives live, rejected, quarantined, and gap as distinct non-success states', () => {
    const live = applyRunStreamEnvelope(createEmptyRunActivityProjection(),
      envelope('transport_opened', transportPayload('opened')));
    expect(deriveRunViewState(live)).toBe('live');
    const rejected = applyRunStreamEnvelope(createEmptyRunActivityProjection(),
      envelope('context_rejected', { ...commonRuntime, eventType: 'context_rejected' }));
    expect(deriveRunViewState(rejected)).toBe('rejected');
    const quarantined = applyRunStreamEnvelope(createEmptyRunActivityProjection(),
      envelope('continuation_quarantined', { ...commonRuntime, eventType: 'continuation_quarantined' }));
    expect(deriveRunViewState(quarantined)).toBe('quarantined');
    const gap = applyRunStreamEnvelope(live,
      envelope('transport_closed', transportPayload('closed'), 3, H2, H));
    expect(deriveRunViewState(gap)).toBe('gap');
    expect([live, rejected, quarantined, gap].every((projection) => !projection.establishesStoryCompletion)).toBe(true);
  });

});
