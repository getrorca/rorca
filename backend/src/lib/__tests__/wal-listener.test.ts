// Copyright (c) 2026 Rorca Inc.
// SPDX-License-Identifier: Apache-2.0

const queryOne = jest.fn();
const broadcastAll = jest.fn();
const broadcastAllDurably = jest.fn();
const acknowledgeTrustedWalRelay = jest.fn();
const relayReadyTrustedWalEvents = jest.fn();
let mockActiveClients = 0;
let mockPeakClients = 0;

jest.mock('pg', () => {
  const { EventEmitter } = require('node:events');
  return {
    Client: class extends EventEmitter {
      connected = false;
      async connect() {
        this.connected = true;
        mockActiveClients += 1;
        mockPeakClients = Math.max(mockPeakClients, mockActiveClients);
      }
      async query() { return { rows: [] }; }
      async end() {
        if (this.connected) mockActiveClients -= 1;
        this.connected = false;
      }
    },
  };
});

jest.mock('../../db/index', () => ({
  queryOne: (...args: unknown[]) => queryOne(...args),
}));
jest.mock('../sse-hub', () => ({
  broadcastAll: (...args: unknown[]) => broadcastAll(...args),
  broadcastAllDurably: (...args: unknown[]) => broadcastAllDurably(...args),
}));
jest.mock('../trusted-wal', () => ({
  acknowledgeTrustedWalRelay: (...args: unknown[]) => acknowledgeTrustedWalRelay(...args),
  relayReadyTrustedWalEvents: (...args: unknown[]) => relayReadyTrustedWalEvents(...args),
}));
jest.mock('../story-result-persistence', () => ({
  persistLegacyStoryResultAccounting: jest.fn(),
}));
jest.mock('../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
  dispatchWalNotificationPayload,
  enqueueWalNotificationPayload,
  parseWalNotificationPayload,
  resolveWalNotificationPayload,
  startWalListener,
  stopWalListener,
} from '../wal-listener';

const legacyRow = {
  id: 701,
  ts: '2026-08-02T00:00:00.000Z',
  event_type: 'validation_completed',
  workspace_id: 'ws-notify',
  spec_id: 'bounded-notify',
  story_id: 'BBM-009',
  actor: 'engine',
  payload: { validation_output: 'legacy full-row compatibility' },
  trust_provenance: 'untrusted',
};

beforeEach(() => {
  jest.clearAllMocks();
});

test('parses bounded general and trusted WAL pointers', () => {
  expect(parseWalNotificationPayload('{"wal_event_id":701}')).toEqual({
    kind: 'pointer', eventId: 701, trustedOnly: false,
  });
  expect(parseWalNotificationPayload('{"trusted_wal_id":"702"}')).toEqual({
    kind: 'pointer', eventId: 702, trustedOnly: true,
  });
});

test('retains compatibility with historical full-row notifications', async () => {
  const payload = JSON.stringify(legacyRow);
  expect(parseWalNotificationPayload(payload)).toEqual({ kind: 'legacy-row', row: legacyRow });
  await expect(resolveWalNotificationPayload(payload)).resolves.toEqual(legacyRow);
  expect(queryOne).not.toHaveBeenCalled();

  await expect(dispatchWalNotificationPayload(payload)).resolves.toBe(true);
  expect(broadcastAll).toHaveBeenCalledWith(expect.objectContaining({
    id: 701,
    event_type: 'validation_completed',
    payload: JSON.stringify(legacyRow.payload),
  }));
});

test('hydrates a compact notification from the canonical WAL row before dispatch', async () => {
  queryOne.mockResolvedValueOnce(legacyRow);

  await expect(dispatchWalNotificationPayload('{"wal_event_id":701}')).resolves.toBe(true);

  expect(queryOne).toHaveBeenCalledWith(
    expect.stringContaining("trust_provenance = 'untrusted'"),
    [701],
  );
  expect(broadcastAll).toHaveBeenCalledWith(expect.objectContaining({
    id: 701,
    event_type: 'validation_completed',
    payload: JSON.stringify(legacyRow.payload),
  }));
});

test('treats a missing compact notification row as a harmless stale wake-up', async () => {
  queryOne.mockResolvedValueOnce(undefined);

  await expect(dispatchWalNotificationPayload('{"wal_event_id":703}')).resolves.toBe(false);

  expect(broadcastAll).not.toHaveBeenCalled();
  expect(broadcastAllDurably).not.toHaveBeenCalled();
});

test('hydrates legacy trusted pointers with the host-only predicate and durable dispatch', async () => {
  const trustedRow = {
    ...legacyRow,
    id: 702,
    event_type: 'story_passed',
    actor: 'rorca-host',
    trust_provenance: 'host',
    trusted_source: 'story-result',
    outbox_ready_at: '2026-08-02T00:00:01.000Z',
  };
  queryOne.mockResolvedValueOnce(trustedRow);
  broadcastAllDurably.mockResolvedValueOnce(undefined);
  acknowledgeTrustedWalRelay.mockResolvedValueOnce(undefined);

  await expect(dispatchWalNotificationPayload('{"trusted_wal_id":702}')).resolves.toBe(true);

  expect(queryOne).toHaveBeenCalledWith(
    expect.stringContaining("trust_provenance = 'host' AND outbox_ready_at IS NOT NULL"),
    [702],
  );
  expect(broadcastAllDurably).toHaveBeenCalledWith(expect.objectContaining({ id: 702 }));
  expect(acknowledgeTrustedWalRelay).toHaveBeenCalledWith(702);
  expect(broadcastAll).not.toHaveBeenCalled();
});

test('serializes notification dispatch so a backlog cannot exhaust the database pool', async () => {
  const firstRow = {
    ...legacyRow,
    id: 801,
    trust_provenance: 'host',
    trusted_source: 'worker',
    outbox_ready_at: '2026-08-02T00:00:01.000Z',
  };
  const secondRow = { ...firstRow, id: 802 };
  queryOne.mockResolvedValueOnce(firstRow).mockResolvedValueOnce(secondRow);

  let releaseFirst!: () => void;
  const firstDispatchGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  broadcastAllDurably
    .mockImplementationOnce(() => firstDispatchGate)
    .mockResolvedValueOnce(undefined);
  acknowledgeTrustedWalRelay.mockResolvedValue(undefined);

  const first = enqueueWalNotificationPayload('{"trusted_wal_id":801}');
  const second = enqueueWalNotificationPayload('{"trusted_wal_id":802}');
  await new Promise<void>((resolve) => setImmediate(resolve));

  expect(queryOne).toHaveBeenCalledTimes(1);
  expect(broadcastAllDurably).toHaveBeenCalledWith(expect.objectContaining({ id: 801 }));

  releaseFirst();
  await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
  expect(queryOne).toHaveBeenCalledTimes(2);
  expect(broadcastAllDurably.mock.calls.map(([event]) => event.id)).toEqual([801, 802]);
});

test.each([
  'null',
  '[]',
  '{}',
  '{"wal_event_id":0}',
  '{"wal_event_id":true}',
  '{"wal_event_id":1.5}',
  '{"wal_event_id":9007199254740992}',
  '{"trusted_wal_id":"not-an-id"}',
  '{"id":701}',
])('rejects malformed notification payload %s', (payload) => {
  expect(() => parseWalNotificationPayload(payload)).toThrow(/notification/i);
});

test('closes a listening session when replay fails, including retries and duplicate starts', async () => {
  jest.useFakeTimers();
  mockActiveClients = 0;
  mockPeakClients = 0;
  relayReadyTrustedWalEvents.mockRejectedValue(new Error('runtime principal rejected'));
  const flush = async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  };
  try {
    startWalListener();
    startWalListener();
    await flush();
    expect(relayReadyTrustedWalEvents).toHaveBeenCalledTimes(1);
    expect(mockActiveClients).toBe(0);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(relayReadyTrustedWalEvents).toHaveBeenCalledTimes(2);
    expect(mockActiveClients).toBe(0);
    expect(mockPeakClients).toBe(1);

    relayReadyTrustedWalEvents.mockResolvedValue(undefined);
    await jest.advanceTimersByTimeAsync(2_000);
    expect(mockActiveClients).toBe(1);
    await stopWalListener();
    expect(mockActiveClients).toBe(0);
  } finally {
    await stopWalListener();
    jest.useRealTimers();
  }
});
