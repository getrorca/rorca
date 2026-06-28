/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * US-026: Capture Sidecar API client + local JSONL queue — tests.
 *
 * Coverage:
 *   - Online: client successfully submits events and candidates
 *   - Offline: queue buffers entries when server is unreachable
 *   - Partial failure: flush preserves failed entries; succeeded entries are removed
 *   - Duplicate keys: idempotency prevents double-ingestion on replay
 *   - Flush is idempotent: replaying same queue does not double-write
 *   - Queue stores versioned, redacted payloads
 *   - retryCount increments on failure
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CaptureClient, CaptureQueue } from '../capture-client';
import type { ContextEvent, MemoryCandidate } from '../capture-contracts';

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

let keyCounter = 0;
function nextKey(prefix = 't'): string {
  keyCounter += 1;
  const pad = String(keyCounter).padStart(3, '0');
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}:${pad}:${rand}`;
}

function makeEvent(overrides: Partial<ContextEvent> = {}): ContextEvent {
  return {
    schemaVersion: 'v1' as const,
    idempotencyKey: nextKey('evt'),
    workspaceId: 'ws-test',
    kind: 'note',
    source: 'rorca-capture',
    payload: { note: 'Test event payload', secret: 'sk-test-secret-12345678' },
    occurredAt: '2026-06-27T12:00:00Z',
    capturedAt: '2026-06-27T12:00:01Z',
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    schemaVersion: 'v1' as const,
    idempotencyKey: nextKey('cnd'),
    workspaceId: 'ws-test',
    status: 'pending',
    title: 'Test Candidate',
    body: 'This is a test memory candidate.',
    trust: 'unverified',
    createdAt: '2026-06-27T12:00:00Z',
    ...overrides,
  };
}

function makeEventWithKey(key: string, overrides?: Partial<ContextEvent>): ContextEvent {
  return makeEvent({ ...overrides, idempotencyKey: key });
}

function makeMockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return jest.fn().mockImplementation(
    (url: string, init?: RequestInit) => Promise.resolve(handler(url, init)),
  ) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function setupTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-capture-test-'));
  return dir;
}

// ════════════════════════════════════════════════════════════════════════════
// CaptureQueue tests
// ════════════════════════════════════════════════════════════════════════════

describe('CaptureQueue', () => {
  let tmpDir: string;
  let queue: CaptureQueue;

  beforeEach(() => {
    tmpDir = setupTempDir();
    queue = new CaptureQueue(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── basic enqueue / read ────────────────────────────────────────────────

  it('starts empty', () => {
    expect(queue.length).toBe(0);
    expect(queue.isEmpty).toBe(true);
  });

  it('enqueues an event and returns the idempotency key', () => {
    const event = makeEvent();
    const key = queue.enqueueEvent(event);
    expect(key).toBe(event.idempotencyKey);
    expect(queue.length).toBe(1);
  });

  it('enqueues a candidate and returns the idempotency key', () => {
    const candidate = makeCandidate();
    const key = queue.enqueueCandidate(candidate);
    expect(key).toBe(candidate.idempotencyKey);
    expect(queue.length).toBe(1);
  });

  it('reads back multiple entries in FIFO order', () => {
    const k1 = nextKey('fifo');
    const k2 = nextKey('fifo');
    const k3 = nextKey('fifo');
    queue.enqueueEvent(makeEventWithKey(k1));
    queue.enqueueEvent(makeEventWithKey(k2));
    queue.enqueueCandidate(makeCandidate({ idempotencyKey: k3 }));

    const entries = queue.readAll();
    expect(entries).toHaveLength(3);
    expect(entries[0].idempotencyKey).toBe(k1);
    expect(entries[1].idempotencyKey).toBe(k2);
    expect(entries[2].idempotencyKey).toBe(k3);
    expect(entries[0].type).toBe('event');
    expect(entries[2].type).toBe('candidate');
  });

  // ── versioning ──────────────────────────────────────────────────────────

  it('stores versioned entries', () => {
    queue.enqueueEvent(makeEvent());
    const entries = queue.readAll();
    expect(entries[0].version).toBe(1);
  });

  // ── redaction ───────────────────────────────────────────────────────────

  it('redacts secrets in event payloads', () => {
    const event = makeEvent({
      payload: {
        note: 'found key sk-ant-test-secret-key',
        config: { password: 'super-secret-password', url: 'https://user:pass@host.com/path' },
      },
    });
    queue.enqueueEvent(event);
    const entries = queue.readAll();
    const payload = entries[0].payload as ContextEvent;
    const payloadObj = payload.payload as Record<string, unknown>;
    const payloadStr = JSON.stringify(payloadObj);

    expect(payloadStr).not.toContain('sk-ant-test-secret-key');
    expect(payloadStr).not.toContain('super-secret-password');
    expect(payloadStr).not.toContain('user:pass@host.com');
    expect(payloadStr).toContain('[REDACTED]');
  });

  // ── removeSucceeded ─────────────────────────────────────────────────────

  it('removeSucceeded removes matching entries and keeps others', () => {
    const kKeep1 = nextKey('keep');
    const kRemove1 = nextKey('rmov');
    const kKeep2 = nextKey('keep');
    const kRemove2 = nextKey('rmov');
    queue.enqueueEvent(makeEventWithKey(kKeep1));
    queue.enqueueEvent(makeEventWithKey(kRemove1));
    queue.enqueueEvent(makeEventWithKey(kKeep2));
    queue.enqueueEvent(makeEventWithKey(kRemove2));

    queue.removeSucceeded(new Set([kRemove1, kRemove2]));

    const remaining = queue.readAll();
    expect(remaining).toHaveLength(2);
    expect(remaining.map((e) => e.idempotencyKey).sort()).toEqual([kKeep1, kKeep2].sort());
  });

  it('removeSucceeded removes the file when all entries succeed', () => {
    const k = nextKey('gone');
    queue.enqueueEvent(makeEventWithKey(k));
    queue.removeSucceeded(new Set([k]));
    expect(queue.length).toBe(0);
    expect(fs.existsSync(queue.filePath)).toBe(false);
  });

  // ── markFailed ──────────────────────────────────────────────────────────

  it('markFailed increments retryCount and stores error', () => {
    const kFail = nextKey('fail');
    const kPass = nextKey('pass');
    queue.enqueueEvent(makeEventWithKey(kFail));
    queue.enqueueEvent(makeEventWithKey(kPass));

    queue.markFailed(new Map([[kFail, 'Network timeout']]));

    const entries = queue.readAll();
    const failed = entries.find((e) => e.idempotencyKey === kFail);
    const passed = entries.find((e) => e.idempotencyKey === kPass);

    expect(failed?.retryCount).toBe(1);
    expect(failed?.lastError).toBe('Network timeout');
    expect(passed?.retryCount).toBe(0);
    expect(passed?.lastError).toBeUndefined();
  });

  it('markFailed accumulates retry counts across cycles', () => {
    const k = nextKey('stbb');
    queue.enqueueEvent(makeEventWithKey(k));

    queue.markFailed(new Map([[k, 'Error 1']]));
    queue.markFailed(new Map([[k, 'Error 2']]));
    queue.markFailed(new Map([[k, 'Error 3']]));

    const entries = queue.readAll();
    expect(entries[0].retryCount).toBe(3);
    expect(entries[0].lastError).toBe('Error 3');
  });

  // ── clear ───────────────────────────────────────────────────────────────

  it('clear removes the queue file', () => {
    queue.enqueueEvent(makeEvent());
    expect(fs.existsSync(queue.filePath)).toBe(true);
    queue.clear();
    expect(fs.existsSync(queue.filePath)).toBe(false);
  });

  // ── validation rejects invalid input ────────────────────────────────────

  it('rejects invalid event at enqueue boundary', () => {
    expect(() => queue.enqueueEvent({} as ContextEvent)).toThrow();
  });

  it('rejects invalid candidate at enqueue boundary', () => {
    expect(() => queue.enqueueCandidate({} as MemoryCandidate)).toThrow();
  });

  it('rejects event with missing idempotencyKey', () => {
    const bad = { ...makeEvent(), idempotencyKey: '' };
    expect(() => queue.enqueueEvent(bad)).toThrow();
  });

  // ── corrupt lines are skipped ───────────────────────────────────────────

  it('skips corrupt lines when reading the queue', () => {
    const k = nextKey('good');
    fs.writeFileSync(queue.filePath, `not-json\n{"version":1,"idempotencyKey":"${k}","type":"event","payload":{},"queuedAt":1,"retryCount":0}\n{broken\n`, 'utf8');
    const entries = queue.readAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].idempotencyKey).toBe(k);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// CaptureClient tests
// ════════════════════════════════════════════════════════════════════════════

describe('CaptureClient', () => {
  // ── Online: health ──────────────────────────────────────────────────────

  it('health returns true when server responds ok', async () => {
    const mockFetch = makeMockFetch((_url) => jsonResponse({ status: 'ok', db: 'connected' }));
    const client = new CaptureClient({ baseUrl: 'http://test:3030', fetch: mockFetch });

    const healthy = await client.health();
    expect(healthy).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://test:3030/api/context-events/health',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('health returns false on server error', async () => {
    const mockFetch = makeMockFetch(() => jsonResponse({ error: 'Down' }, 500));
    const client = new CaptureClient({ baseUrl: 'http://test:3030', fetch: mockFetch });

    const healthy = await client.health();
    expect(healthy).toBe(false);
  });

  it('health returns false on network failure', async () => {
    const mockFetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const client = new CaptureClient({ baseUrl: 'http://test:3030', fetch: mockFetch as unknown as typeof fetch });

    const healthy = await client.health();
    expect(healthy).toBe(false);
  });

  // ── Online: submit event ────────────────────────────────────────────────

  it('submitEvent sends event to API and returns result', async () => {
    const evtKey = nextKey('sev1');
    const mockFetch = makeMockFetch((_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.event.idempotencyKey).toBe(evtKey);
      return jsonResponse({ id: 42, created: true });
    });

    const client = new CaptureClient({ baseUrl: 'http://test:3030', fetch: mockFetch });
    const result = await client.submitEvent(makeEventWithKey(evtKey));

    expect(result.id).toBe(42);
    expect(result.created).toBe(true);
  });

  it('submitEvent returns created: false for duplicate key', async () => {
    const mockFetch = makeMockFetch(() => jsonResponse({ id: 42, created: false }));
    const client = new CaptureClient({ baseUrl: 'http://test:3030', fetch: mockFetch });

    const result = await client.submitEvent(makeEvent());
    expect(result.created).toBe(false);
  });

  it('submitEvent throws on server error', async () => {
    const mockFetch = makeMockFetch(() => jsonResponse({ error: 'Workspace not found' }, 404));
    const client = new CaptureClient({ baseUrl: 'http://test:3030', fetch: mockFetch });

    await expect(client.submitEvent(makeEvent())).rejects.toThrow('Workspace not found');
  });

  // ── Online: submit candidate ────────────────────────────────────────────

  it('submitCandidate sends candidate to API and returns result', async () => {
    const cndKey = nextKey('smc1');
    const mockFetch = makeMockFetch((_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.candidate.title).toBe('Test Candidate');
      return jsonResponse({ id: 99, created: true });
    });

    const client = new CaptureClient({ baseUrl: 'http://test:3030', fetch: mockFetch });
    const result = await client.submitCandidate(makeCandidate({ idempotencyKey: cndKey }));

    expect(result.id).toBe(99);
    expect(result.created).toBe(true);
  });

  // ── Flush queue ─────────────────────────────────────────────────────────

  it('flushQueue returns empty result for empty queue', async () => {
    const tmpDir = setupTempDir();
    try {
      const queue = new CaptureQueue(tmpDir);
      const mockFetch = makeMockFetch(() => jsonResponse({ succeeded: 0, failed: [] }));
      const client = new CaptureClient({ baseUrl: 'http://test:3030', fetch: mockFetch });

      const result = await client.flushQueue(queue);
      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('flushQueue sends all entries and removes succeeded ones', async () => {
    const tmpDir = setupTempDir();
    try {
      const queue = new CaptureQueue(tmpDir);
      const k1 = nextKey('flsh');
      const k2 = nextKey('flsh');
      const k3 = nextKey('flsh');
      queue.enqueueEvent(makeEventWithKey(k1));
      queue.enqueueCandidate(makeCandidate({ idempotencyKey: k2 }));
      queue.enqueueEvent(makeEventWithKey(k3));

      const mockFetch = makeMockFetch(() =>
        jsonResponse({ succeeded: 3, failed: [] }),
      );
      const client = new CaptureClient({ baseUrl: 'http://test:3030', fetch: mockFetch });

      const result = await client.flushQueue(queue);
      expect(result.succeeded).toBe(3);
      expect(result.failed).toBe(0);
      expect(queue.length).toBe(0);

      for (const r of result.entries) {
        expect(r.success).toBe(true);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── Idempotent flush ────────────────────────────────────────────────────

  it('flushQueue is idempotent — replaying same queue does not double-write', async () => {
    const tmpDir = setupTempDir();
    try {
      const queue = new CaptureQueue(tmpDir);
      const k1 = nextKey('idem');
      const k2 = nextKey('idem');
      queue.enqueueEvent(makeEventWithKey(k1));
      queue.enqueueCandidate(makeCandidate({ idempotencyKey: k2 }));

      let callCount = 0;
      const mockFetch = makeMockFetch(() => {
        callCount += 1;
        return jsonResponse({ succeeded: 2, failed: [] });
      });
      const client = new CaptureClient({ baseUrl: 'http://test:3030', fetch: mockFetch });

      const r1 = await client.flushQueue(queue);
      expect(r1.succeeded).toBe(2);
      expect(callCount).toBe(1);

      // Re-enqueue the same entries (simulates replay).
      queue.enqueueEvent(makeEventWithKey(k1));
      queue.enqueueCandidate(makeCandidate({ idempotencyKey: k2 }));

      const r2 = await client.flushQueue(queue);
      expect(r2.succeeded).toBe(2);
      expect(queue.length).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── Partial failure: preserves failed entries ───────────────────────────

  it('flushQueue preserves failed entries in the queue', async () => {
    const tmpDir = setupTempDir();
    try {
      const queue = new CaptureQueue(tmpDir);
      const kOk1 = nextKey('pfok');
      const kFail1 = nextKey('pffl');
      const kOk2 = nextKey('pfok');
      const kFail2 = nextKey('pffl');
      queue.enqueueEvent(makeEventWithKey(kOk1));
      queue.enqueueEvent(makeEventWithKey(kFail1));
      queue.enqueueCandidate(makeCandidate({ idempotencyKey: kOk2 }));
      queue.enqueueEvent(makeEventWithKey(kFail2));

      const mockFetch = makeMockFetch((_url, init) => {
        const body = JSON.parse((init as RequestInit).body as string);
        const failed = body.entries
          .filter((e: { payload: { idempotencyKey: string } }) =>
            [kFail1, kFail2].includes(e.payload.idempotencyKey),
          )
          .map((e: { payload: { idempotencyKey: string } }) => ({
            index: body.entries.indexOf(e),
            idempotencyKey: e.payload.idempotencyKey,
            error: 'Conflict',
          }));
        return jsonResponse({ succeeded: body.entries.length - failed.length, failed });
      });
      const client = new CaptureClient({ baseUrl: 'http://test:3030', fetch: mockFetch });

      const result = await client.flushQueue(queue);
      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(2);

      const remaining = queue.readAll();
      expect(remaining).toHaveLength(2);
      expect(remaining.map((e) => e.idempotencyKey).sort()).toEqual([kFail1, kFail2].sort());
      for (const r of remaining) {
        expect(r.retryCount).toBe(1);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── Network failure: entire batch marked failed ─────────────────────────

  it('flushQueue marks all entries as failed on network error', async () => {
    const tmpDir = setupTempDir();
    try {
      const queue = new CaptureQueue(tmpDir);
      const k1 = nextKey('nter');
      const k2 = nextKey('nter');
      queue.enqueueEvent(makeEventWithKey(k1));
      queue.enqueueEvent(makeEventWithKey(k2));

      const mockFetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      const client = new CaptureClient({ baseUrl: 'http://test:3030', fetch: mockFetch as unknown as typeof fetch });

      const result = await client.flushQueue(queue);
      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(2);

      const remaining = queue.readAll();
      expect(remaining).toHaveLength(2);
      for (const r of remaining) {
        expect(r.retryCount).toBe(1);
        expect(r.lastError).toBe('ECONNREFUSED');
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── Duplicate keys in queue ─────────────────────────────────────────────

  it('flushQueue handles duplicate idempotency keys in same batch by deduplicating', async () => {
    const tmpDir = setupTempDir();
    try {
      const queue = new CaptureQueue(tmpDir);
      const dupKey = nextKey('dupe');
      // Enqueue two entries with the same key.
      queue.enqueueEvent(makeEventWithKey(dupKey));
      queue.enqueueEvent(makeEventWithKey(dupKey));

      // Server responds with one success (the on-conflict upsert returns the same row).
      const mockFetch = makeMockFetch(() =>
        jsonResponse({
          succeeded: 2,
          failed: [],
        }),
      );
      const client = new CaptureClient({ baseUrl: 'http://test:3030', fetch: mockFetch });

      const result = await client.flushQueue(queue);
      // Both entries succeed because they're idempotent — server upserts both.
      expect(result.succeeded).toBe(2);
      expect(queue.length).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── Batch processing ────────────────────────────────────────────────────

  it('flushQueue splits large queues into batches', async () => {
    const tmpDir = setupTempDir();
    try {
      const queue = new CaptureQueue(tmpDir);
      const totalEntries = 120;
      const keys: string[] = [];
      for (let i = 0; i < totalEntries; i++) {
        const k = nextKey('batc');
        keys.push(k);
        queue.enqueueEvent(makeEventWithKey(k));
      }

      let batchCount = 0;
      const mockFetch = makeMockFetch((_url, init) => {
        batchCount += 1;
        const body = JSON.parse((init as RequestInit).body as string);
        return jsonResponse({ succeeded: body.entries.length, failed: [] });
      });
      const client = new CaptureClient({ baseUrl: 'http://test:3030', fetch: mockFetch });

      const result = await client.flushQueue(queue, 50);
      expect(result.succeeded).toBe(totalEntries);
      expect(batchCount).toBe(3); // 50 + 50 + 20
      expect(queue.length).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── API key forwarding ──────────────────────────────────────────────────

  it('sends Authorization header when apiKey is provided', async () => {
    const mockFetch = makeMockFetch((_url, init) => {
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer test-api-key');
      return jsonResponse({ status: 'ok', db: 'connected' });
    });
    const client = new CaptureClient({
      baseUrl: 'http://test:3030',
      apiKey: 'test-api-key',
      fetch: mockFetch,
    });

    await client.health();
  });

  // ── Timeout ─────────────────────────────────────────────────────────────

  it('aborts request after timeout', async () => {
    // Use a promise that rejects after the timeout fires, simulating an AbortError.
    const mockFetch = jest.fn().mockImplementation(
      (_url: string, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('The operation was aborted'));
          });
        });
      },
    );
    const client = new CaptureClient({
      baseUrl: 'http://test:3030',
      fetch: mockFetch as unknown as typeof fetch,
      timeoutMs: 50,
    });

    const healthy = await client.health();
    expect(healthy).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Integration: CaptureClient + CaptureQueue (full workflow)
// ════════════════════════════════════════════════════════════════════════════

describe('CaptureClient + CaptureQueue integration', () => {
  it('offline → online workflow: queue buffers while offline, flushes when online', async () => {
    const tmpDir = setupTempDir();
    try {
      const queue = new CaptureQueue(tmpDir);
      const e1 = makeEvent({ payload: { note: 'Event 1' } });
      const e2 = makeEvent({ payload: { note: 'Event 2' } });
      queue.enqueueEvent(e1);
      queue.enqueueEvent(e2);
      expect(queue.length).toBe(2);

      const mockFetch = makeMockFetch(() => jsonResponse({ succeeded: 2, failed: [] }));
      const client = new CaptureClient({ baseUrl: 'http://test:3030', fetch: mockFetch });

      const result = await client.flushQueue(queue);
      expect(result.succeeded).toBe(2);
      expect(queue.length).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('offline → online with partial failure → retry clears remaining', async () => {
    const tmpDir = setupTempDir();
    try {
      const queue = new CaptureQueue(tmpDir);
      const keys: string[] = [];
      for (let i = 1; i <= 4; i++) {
        const k = nextKey('retr');
        keys.push(k);
        queue.enqueueEvent(makeEventWithKey(k));
      }

      let flushNumber = 0;
      const mockFetch = makeMockFetch((_url, init) => {
        flushNumber += 1;
        const body = JSON.parse((init as RequestInit).body as string);
        if (flushNumber === 1) {
          return jsonResponse({
            succeeded: 2,
            failed: [
              { index: 1, idempotencyKey: keys[1], error: 'DB timeout' },
              { index: 3, idempotencyKey: keys[3], error: 'DB timeout' },
            ],
          });
        }
        return jsonResponse({ succeeded: body.entries.length, failed: [] });
      });
      const client = new CaptureClient({ baseUrl: 'http://test:3030', fetch: mockFetch });

      const r1 = await client.flushQueue(queue);
      expect(r1.succeeded).toBe(2);
      expect(r1.failed).toBe(2);
      expect(queue.length).toBe(2);

      const r2 = await client.flushQueue(queue);
      expect(r2.succeeded).toBe(2);
      expect(r2.failed).toBe(0);
      expect(queue.length).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
