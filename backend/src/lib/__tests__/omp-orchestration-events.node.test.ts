/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { WalEvent } from '../sse-hub';
import type { ManagedEngineRequest } from '../rorca-managed-executor';
import {
  ORCHESTRATION_EVENT_KINDS, OrchestrationEventV1Schema, mapOmpRpcType,
  ompSourceKey, orchestrationWalEventType, projectOmpOrchestrationEvent,
  type OmpOrchestrationInput, type OrchestrationEventV1, type OrchestrationEventWriter,
} from '../omp-orchestration-events';

const hash = (digit: string) => `sha256:${digit.repeat(64)}`;
const request = {
  requestHash: hash('a'), workspaceId: 'workspace-one', runId: 42,
  specId: 'spec:one', specVersion: 7, specHash: hash('b'),
  storyId: 'story:one', storyVersion: 3, storyHash: hash('c'),
  attemptId: 'attempt:one', generation: 2,
} as ManagedEngineRequest;

function input(sourceOrdinal: number, event: unknown, observedAt = '2026-03-16T00:00:00.000Z'): OmpOrchestrationInput {
  return { request, processIdentity: 'process:omp:123', sourceOrdinal, event, observedAt };
}

class RestartableMemoryWriter implements OrchestrationEventWriter {
  constructor(private readonly durable: Map<string, OrchestrationEventV1>) {}
  async append(value: OmpOrchestrationInput) {
    const key = ompSourceKey(value);
    const existing = this.durable.get(key);
    if (existing) return { payload: existing, duplicate: true, walEventId: existing.sequence };
    const payload = projectOmpOrchestrationEvent(value, this.durable.size + 1);
    this.durable.set(key, payload);
    return { payload, duplicate: false, walEventId: payload.sequence };
  }
}

describe('OMP orchestration event projection', () => {
  test('maps the owned provider-neutral vocabulary from actual RPC event names', () => {
    assert.deepEqual([
      mapOmpRpcType('agent_start'), mapOmpRpcType('turn_start'), mapOmpRpcType('message_update'),
      mapOmpRpcType('agent_settled'), mapOmpRpcType('error'),
    ], [...ORCHESTRATION_EVENT_KINDS]);
  });

  test('retains OMP parentage and exact EntityRefV1 identity chain', () => {
    const payload = projectOmpOrchestrationEvent(input(1, {
      type: 'tool_execution_start', eventId: 'event:task', parentEventId: 'event:agent',
      agentId: 'agent:child', parentAgentId: 'agent:root', taskId: 'task:one',
    }), 1);
    assert.equal(OrchestrationEventV1Schema.safeParse(payload).success, true);
    assert.equal(payload.parentEventId, 'event:agent');
    assert.deepEqual(payload.omp, { provider: 'omp', rpcType: 'tool_execution_start', sourceEventId: 'event:task',
      parentEventId: 'event:agent', agentId: 'agent:child', parentAgentId: 'agent:root', taskId: 'task:one',
      raw: { type: 'tool_execution_start', eventId: 'event:task', parentEventId: 'event:agent', agentId: 'agent:child', parentAgentId: 'agent:root', taskId: 'task:one' } });
    assert.equal(payload.run.parent?.kind, 'spec');
    assert.equal(payload.story.parent?.kind, 'run');
    assert.equal(payload.attempt.parent?.kind, 'story');
    assert.equal(payload.process.parent?.kind, 'attempt');
    assert.deepEqual(payload.spec.revision, { kind: 'spec_version', value: '7' });
    assert.equal(payload.specRevisionHash, request.specHash);
  });

  test('is idempotent on replay and continues monotonic sequence after writer restart', async () => {
    const durable = new Map<string, OrchestrationEventV1>();
    const firstWriter = new RestartableMemoryWriter(durable);
    const first = await firstWriter.append(input(1, { type: 'agent_start', id: 'omp:1' }));
    const duplicate = await new RestartableMemoryWriter(durable).append(input(1, { type: 'agent_start', id: 'omp:1' }, '2026-03-16T01:00:00.000Z'));
    const second = await new RestartableMemoryWriter(durable).append(input(2, { type: 'message_update', id: 'omp:2' }));
    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.deepEqual(duplicate.payload, first.payload);
    assert.equal(second.payload.sequence, 2);
  });

  test('preserves unknown OMP events and remains compatible with the existing WAL/SSE row envelope', () => {
    const payload = projectOmpOrchestrationEvent(input(9, { type: 'future_parallel_signal', parent_id: 'omp:8', detail: { safe: true } }), 9);
    assert.equal(payload.kind, null);
    assert.equal(payload.omp.rpcType, 'future_parallel_signal');
    assert.deepEqual(payload.omp.raw.detail, { safe: true });
    const wal: WalEvent = {
      id: 91, ts: payload.observedAt, event_type: orchestrationWalEventType(payload), workspace_id: request.workspaceId,
      spec_id: request.specId, story_id: request.storyId, actor: 'omp-managed-executor', payload: JSON.stringify(payload),
      ingest_key: `omp-orchestration:v1:${payload.idempotencyKey}`, trust_provenance: 'untrusted',
    };
    assert.equal(wal.event_type, 'orchestration.unknown');
    assert.equal(OrchestrationEventV1Schema.parse(JSON.parse(wal.payload!)).schemaVersion, 'rorca.orchestration-event.v1');
    assert.equal('action' in JSON.parse(wal.payload!), false);
    assert.equal(wal.event_type.startsWith('gateway.'), false);
  });
});
