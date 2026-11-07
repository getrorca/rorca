// Copyright (c) 2026 Rorca Inc.
// SPDX-License-Identifier: Apache-2.0

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client, Pool } from 'pg';
import { assertConnectedTestDatabase, resolveTestDatabaseUrl } from '../test-db-safety';
import { fallbackReplayBlocksCompletion, replayFallbackResults } from '../fallback-replay';
import { dispatchWalNotificationPayload, resolveWalNotificationPayload } from '../wal-listener';
import { flushFallbackWrites, writeFallbackResult, type FallbackResultEntry } from '../resilient-post';
import { subscribe, type WalEvent } from '../sse-hub';

const connectionString = resolveTestDatabaseUrl();
const clientConfig = { connectionString, options: '--search_path=rorca,public' };
const pool = new Pool({ ...clientConfig, max: 2 });
const listener = new Client(clientConfig);
const workspaceId = `wal-notify-${crypto.randomUUID()}`;
const storyId = 'BBM-009';
const fallbackRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-wal-notify-'));
const notifications: string[] = [];
let runId: number;

async function waitForNotification(eventId: number): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const match = notifications.find((payload) => {
      try {
        const parsed = JSON.parse(payload) as Record<string, unknown>;
        return Number(parsed.wal_event_id) === eventId;
      } catch {
        return false;
      }
    });
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for compact WAL notification ${eventId}`);
}

describe('bounded WAL notifications (real PostgreSQL)', () => {
  beforeAll(async () => {
    await assertConnectedTestDatabase(pool, connectionString);
    // The canonical Jest harness applies migrations with the migration owner.
    // This regression uses the runtime principal and must never acquire DDL
    // authority merely to exercise the installed notification trigger.
    listener.on('notification', (message) => {
      if (message.channel === 'wal_events' && message.payload) notifications.push(message.payload);
    });
    await listener.connect();
    await listener.query('LISTEN wal_events');

    await pool.query(
      `INSERT INTO workspaces (id, label, path)
       VALUES ($1, 'Bounded WAL notification fixture', $2)`,
      [workspaceId, fallbackRoot],
    );
    runId = Number((await pool.query<{ id: string }>(
      `INSERT INTO pipeline_runs
         (spec_path, workspace_id, status, branch_name, expected_story_ids,
          execution_workspace_path, execution_worktree_path)
       VALUES ('forge/specs/approved/bounded-wal-notify.json', $1, 'running', $2, $3, $4, $4)
       RETURNING id`,
      [workspaceId, `test/bounded-wal-${crypto.randomUUID()}`, [storyId], fallbackRoot],
    )).rows[0].id);
  });

  afterAll(async () => {
    await listener.query('UNLISTEN wal_events').catch(() => undefined);
    await listener.end().catch(() => undefined);
    if (runId) {
      await pool.query('DELETE FROM wal_events WHERE workspace_id = $1', [workspaceId]);
      await pool.query('DELETE FROM pipeline_runs WHERE id = $1', [runId]);
    }
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
    await pool.end();
    fs.rmSync(fallbackRoot, { recursive: true, force: true });
  });

  test('oversized WAL writes commit, notify by bounded pointer, hydrate fully, and do not block critical replay closeout', async () => {
    const oversizedValidation = 'validation-output\n'.repeat(2_048);
    expect(Buffer.byteLength(oversizedValidation)).toBeGreaterThan(8_000);
    const directIngestKey = `bounded-notify:direct:${crypto.randomUUID()}`;
    const directPayload = {
      run_id: runId,
      story_id: storyId,
      validation_output: oversizedValidation,
      completion_packet: { status: 'completed', accepted: true },
    };

    const inserted = (await pool.query<{ id: string; payload_bytes: number }>(
      `INSERT INTO wal_events
         (event_type, workspace_id, spec_id, story_id, payload, ingest_key, trust_provenance)
       VALUES ('validation_completed', $1, 'bounded-wal-notify', $2, $3::jsonb, $4, 'untrusted')
       RETURNING id, octet_length(payload::text) AS payload_bytes`,
      [workspaceId, storyId, JSON.stringify(directPayload), directIngestKey],
    )).rows[0];
    const directEventId = Number(inserted.id);
    expect(inserted.payload_bytes).toBeGreaterThan(8_000);

    const compactPayload = await waitForNotification(directEventId);
    expect(Buffer.byteLength(compactPayload)).toBeLessThan(128);
    expect(JSON.parse(compactPayload)).toEqual({ wal_event_id: directEventId });

    const hydrated = await resolveWalNotificationPayload(compactPayload);
    expect(hydrated).toMatchObject({ id: directEventId, event_type: 'validation_completed' });
    expect((hydrated?.payload as Record<string, unknown>).validation_output).toBe(oversizedValidation);

    let dispatched: WalEvent | undefined;
    const unsubscribe = subscribe((event) => {
      if (event.id === directEventId) dispatched = event;
    });
    try {
      await expect(dispatchWalNotificationPayload(compactPayload)).resolves.toBe(true);
    } finally {
      unsubscribe();
    }
    expect(dispatched).toMatchObject({ id: directEventId, event_type: 'validation_completed' });
    expect(JSON.parse(dispatched!.payload!).validation_output).toBe(oversizedValidation);

    const fallbackIngestKey = `bounded-notify:fallback:${crypto.randomUUID()}`;
    const fallbackEntry: FallbackResultEntry = {
      type: 'wal',
      runId,
      storyId,
      status: 'validation_bundle_archived',
      retries: 1,
      ts: new Date().toISOString(),
      idempotencyKey: fallbackIngestKey,
      payload: {
        event_type: 'validation_bundle_archived',
        workspace_id: workspaceId,
        story_id: storyId,
        payload: {
          run_id: runId,
          story_id: storyId,
          raw_validation_output: oversizedValidation,
          completion_packet: { status: 'completed', host_closeout_pending: true },
        },
      },
    };
    await writeFallbackResult(fallbackRoot, fallbackEntry);
    await flushFallbackWrites(fallbackRoot);

    const replayed = await replayFallbackResults(fallbackRoot, workspaceId);
    expect(replayed).toMatchObject({
      total: 1,
      inserted: 1,
      duplicates: 0,
      invalid: 0,
      retained: false,
      criticalTotal: 1,
      criticalCompleted: 1,
      criticalIncomplete: false,
      blocksCompletion: false,
    });
    expect(fallbackReplayBlocksCompletion(replayed)).toBe(false);
    expect(fs.existsSync(path.join(fallbackRoot, '.rorca-results.jsonl'))).toBe(false);

    const replayedRow = (await pool.query<{ id: string; payload_bytes: number; payload: Record<string, unknown> }>(
      `SELECT id, octet_length(payload::text) AS payload_bytes, payload
         FROM wal_events WHERE ingest_key = $1`,
      [fallbackIngestKey],
    )).rows[0];
    expect(replayedRow.payload_bytes).toBeGreaterThan(8_000);
    expect(replayedRow.payload.raw_validation_output).toBe(oversizedValidation);

    const replayNotification = await waitForNotification(Number(replayedRow.id));
    expect(Buffer.byteLength(replayNotification)).toBeLessThan(128);
    expect(JSON.parse(replayNotification)).toEqual({ wal_event_id: Number(replayedRow.id) });
  }, 30_000);
});
