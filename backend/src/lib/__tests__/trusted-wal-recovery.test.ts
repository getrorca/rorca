// Copyright (c) 2026 Rorca Inc.
// SPDX-License-Identifier: Apache-2.0

const query = jest.fn();
const queryOne = jest.fn();
const execute = jest.fn();
const transaction = jest.fn();

jest.mock('../../db/index', () => ({
  query: (...args: unknown[]) => query(...args),
  queryOne: (...args: unknown[]) => queryOne(...args),
  execute: (...args: unknown[]) => execute(...args),
  transaction: (...args: unknown[]) => transaction(...args),
}));

import {
  relayReadyTrustedWalEvents,
  trustedWalIdentityHash,
  type TrustedWalRow,
} from '../trusted-wal';

type PageOverride = (
  cursor: number,
  highWatermark: number,
  limit: number,
) => TrustedWalRow[] | undefined;

let rowsById: Map<number, TrustedWalRow>;
let deliveredIds: number[];
let failNotificationOnceAt: number | null;
let acknowledgeBeforeUpdate: Set<number>;
let acknowledgeBeforeNotify: Set<number>;
let pageOverride: PageOverride | null;

function trustedRow(id: number): TrustedWalRow {
  const storyId = `STORY-${id}`;
  const payload = { run_id: 41, story_id: storyId };
  const identityHash = trustedWalIdentityHash({
    eventType: 'story_started',
    workspaceId: 'workspace-recovery',
    runId: 41,
    specId: 'specs/recovery.md',
    storyId,
    source: 'execution-engine',
    storyResultId: null,
    payload,
  });
  return {
    id,
    ts: '2026-08-17T00:00:00.000Z',
    event_type: 'story_started',
    workspace_id: 'workspace-recovery',
    spec_id: 'specs/recovery.md',
    story_id: storyId,
    actor: 'rorca-host',
    payload: JSON.stringify(payload),
    ingest_key: `trusted-wal:v1:${identityHash}`,
    trust_provenance: 'host',
    trusted_source: 'execution-engine',
    canonical_run_id: 41,
    story_result_id: null,
    event_identity_hash: identityHash,
    outbox_ready_at: '2026-08-17T00:00:00.000Z',
    outbox_relayed_at: null,
  };
}

function installRows(count: number): void {
  rowsById = new Map(Array.from({ length: count }, (_, offset) => {
    const row = trustedRow(offset + 1);
    return [row.id, row] as const;
  }));
}

function unacknowledgedRows(cursor: number, highWatermark: number, limit: number): TrustedWalRow[] {
  return [...rowsById.values()]
    .filter(row => row.id > cursor
      && row.id <= highWatermark
      && row.outbox_relayed_at === null)
    .sort((left, right) => left.id - right.id)
    .slice(0, limit);
}

beforeEach(() => {
  jest.clearAllMocks();
  rowsById = new Map();
  deliveredIds = [];
  failNotificationOnceAt = null;
  acknowledgeBeforeUpdate = new Set();
  acknowledgeBeforeNotify = new Set();
  pageOverride = null;

  query.mockImplementation(async (_sql: string, params: unknown[]) => {
    const [cursor, highWatermark, limit] = params as [number, number, number];
    return pageOverride?.(cursor, highWatermark, limit)
      ?? unacknowledgedRows(cursor, highWatermark, limit);
  });

  queryOne.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('MAX(id) AS max_id')) {
      const ids = [...rowsById.values()]
        .filter(row => row.outbox_relayed_at === null)
        .map(row => row.id);
      return { max_id: ids.length === 0 ? null : Math.max(...ids) };
    }

    const eventId = Number(params[0]);
    const row = rowsById.get(eventId);
    if (sql.includes('JOIN pipeline_runs')) return row;

    if (sql.includes('UPDATE wal_events w')) {
      if (acknowledgeBeforeUpdate.delete(eventId) && row) {
        row.outbox_relayed_at = '2026-08-17T00:00:01.000Z';
      }
      return row?.outbox_relayed_at === null ? row : undefined;
    }

    if (sql.includes('pg_notify')) {
      if (acknowledgeBeforeNotify.delete(eventId) && row) {
        row.outbox_relayed_at = '2026-08-17T00:00:01.000Z';
      }
      if (!row || row.outbox_relayed_at !== null) return undefined;
      if (failNotificationOnceAt === eventId) {
        failNotificationOnceAt = null;
        throw new Error(`notification failed for ${eventId}`);
      }
      deliveredIds.push(eventId);
      row.outbox_relayed_at = '2026-08-17T00:00:01.000Z';
      return { notified: '' };
    }

    throw new Error(`Unexpected trusted WAL query: ${sql}`);
  });
});

test('drains more than 2,000 ready rows in bounded canonical pages', async () => {
  installRows(2_505);

  await expect(relayReadyTrustedWalEvents()).resolves.toBe(2_505);

  expect(deliveredIds).toEqual(Array.from({ length: 2_505 }, (_, index) => index + 1));
  expect(query).toHaveBeenCalledTimes(2);
  expect(query.mock.calls.map(([, params]) => params)).toEqual([
    [0, 2_505, 2_000],
    [2_000, 2_505, 2_000],
  ]);
});

test('a mid-page failure remains retryable without redelivering acknowledged rows', async () => {
  installRows(2_405);
  failNotificationOnceAt = 1_251;

  await expect(relayReadyTrustedWalEvents(1_000)).rejects.toThrow('notification failed for 1251');
  await expect(relayReadyTrustedWalEvents(1_000)).resolves.toBe(1_155);

  expect(deliveredIds).toEqual(Array.from({ length: 2_405 }, (_, index) => index + 1));
  expect(new Set(deliveredIds).size).toBe(deliveredIds.length);
  expect([...rowsById.values()].every(row => row.outbox_relayed_at !== null)).toBe(true);
});

test('does not redeliver rows acknowledged concurrently with recovery', async () => {
  installRows(2_005);
  acknowledgeBeforeUpdate.add(1_500);
  acknowledgeBeforeNotify.add(1_501);

  await expect(relayReadyTrustedWalEvents()).resolves.toBe(2_005);

  expect(deliveredIds).not.toContain(1_500);
  expect(deliveredIds).not.toContain(1_501);
  expect(deliveredIds).toHaveLength(2_003);
  expect(new Set(deliveredIds).size).toBe(deliveredIds.length);
  expect([...rowsById.values()].every(row => row.outbox_relayed_at !== null)).toBe(true);
});

test('stops explicitly before a non-advancing page can duplicate delivery', async () => {
  installRows(2);
  const first = rowsById.get(1)!;
  pageOverride = cursor => cursor === 0 ? [first] : [first];

  await expect(relayReadyTrustedWalEvents(1)).rejects.toThrow(
    'Trusted WAL recovery page did not advance in canonical order',
  );

  expect(deliveredIds).toEqual([1]);
});
