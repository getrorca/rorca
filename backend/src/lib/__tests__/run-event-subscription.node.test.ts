/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { broadcastAll, type WalEvent } from '../sse-hub';
import {
  RUN_EVENT_SUBSCRIPTION_TOOL_NAMES,
  RunEventSubscription,
  toRunEventDispatch,
  type RunEventDispatchV1,
} from '../run-event-subscription';

function wal(id: number, eventType: string, workspaceId = 'ws-a', schemaVersion?: string): WalEvent {
  return {
    id,
    ts: new Date(1_700_000_000_000 + id).toISOString(),
    event_type: eventType,
    workspace_id: workspaceId,
    spec_id: 'spec-a',
    story_id: eventType.startsWith('run') ? null : 'AAV-011',
    actor: 'rorca-host',
    payload: JSON.stringify({ ...(schemaVersion ? { schemaVersion } : {}), value: id }),
  };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test('replays every canonical run-event family once and preserves versioned WAL dispatch', async () => {
  const replay = [
    wal(710_001, 'run_started'),
    wal(710_002, 'story_started'),
    wal(710_003, 'gate.passed'),
    wal(710_004, 'evidence_admitted'),
    wal(710_005, 'orchestration.agent_progress', 'ws-a', 'rorca.orchestration-event.v1'),
    wal(710_006, 'gateway.run_completed', 'ws-a', 'rorca.gateway-event.v1'),
    wal(710_006, 'gateway.run_completed', 'ws-a', 'rorca.gateway-event.v1'),
  ];
  const delivered: RunEventDispatchV1[] = [];
  const subscription = new RunEventSubscription('ws-a', async (workspaceId, cursor) => {
    assert.equal(workspaceId, 'ws-a');
    assert.equal(cursor, 710_000);
    return replay;
  }, async (dispatch) => { delivered.push(dispatch); });

  try {
    const result = await subscription.start(710_000);
    assert.deepEqual(delivered.map((item) => item.family), [
      'run', 'story', 'gate', 'evidence', 'orchestration', 'gateway',
    ]);
    assert.equal(delivered[4]?.payloadSchemaVersion, 'rorca.orchestration-event.v1');
    assert.equal(delivered[5]?.payloadSchemaVersion, 'rorca.gateway-event.v1');
    assert.strictEqual(delivered[5]?.event, replay[5], 'canonical WAL/SSE envelope must not be rewritten');
    assert.equal(result.cursor, 710_006);
    assert.deepEqual(result.canonicalToolNames, RUN_EVENT_SUBSCRIPTION_TOOL_NAMES);
  } finally {
    subscription.stop();
  }
});

test('buffers the replay race, suppresses overlap, and isolates live events to the selected workspace', async () => {
  let releaseReplay!: (events: readonly WalEvent[]) => void;
  const replayPromise = new Promise<readonly WalEvent[]>((resolve) => { releaseReplay = resolve; });
  const delivered: RunEventDispatchV1[] = [];
  const subscription = new RunEventSubscription('ws-a', async () => replayPromise, (dispatch) => {
    delivered.push(dispatch);
  });

  try {
    const starting = subscription.start(720_000);
    broadcastAll(wal(720_002, 'gateway.source_drift', 'ws-b', 'rorca.gateway-event.v1'));
    broadcastAll(wal(720_002, 'gateway.source_drift', 'ws-a', 'rorca.gateway-event.v1'));
    releaseReplay([
      wal(720_001, 'orchestration.agent_started', 'ws-a', 'rorca.orchestration-event.v1'),
      wal(720_002, 'gateway.source_drift', 'ws-a', 'rorca.gateway-event.v1'),
    ]);
    await starting;
    broadcastAll(wal(720_003, 'story_passed', 'ws-b'));
    broadcastAll(wal(720_004, 'evidence.admitted', 'ws-a'));
    await settle();

    assert.deepEqual(delivered.map(({ event }) => [event.id, event.workspace_id]), [
      [720_001, 'ws-a'],
      [720_002, 'ws-a'],
      [720_004, 'ws-a'],
    ]);
  } finally {
    subscription.stop();
  }
});

test('exposes canonical subscription tool names and ignores unrelated WAL event types', () => {
  assert.deepEqual(RUN_EVENT_SUBSCRIPTION_TOOL_NAMES, [
    'rorca_subscribe_run_events',
    'rorca_unsubscribe_run_events',
  ]);
  assert.equal(toRunEventDispatch(wal(730_001, 'memory_saved')), null);
  assert.equal(toRunEventDispatch(wal(730_002, 'gateway.audit')), null);
  assert.equal(toRunEventDispatch(wal(730_003, 'gateway.decision_required'))?.toolName, 'rorca_subscribe_run_events');
});
