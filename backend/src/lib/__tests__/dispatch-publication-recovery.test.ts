/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { execute, query, queryOne } from '../../db/index';
import { recoverPendingDispatchPublications } from '../dispatch-publication';
import { getBoss } from '../pg-boss';
import { retryHash } from '../retry-governance';

jest.mock('../pg-boss', () => ({
  initBoss: jest.fn().mockResolvedValue(undefined),
  getBoss: jest.fn().mockReturnValue({
    createQueue: jest.fn().mockResolvedValue(undefined),
    send: jest.fn().mockImplementation(async (_name: string, _payload: unknown, options?: { id?: string }) => options?.id ?? null),
  }),
}));

const WORKSPACE_ID = 'ws-dispatch-recovery';

async function seedRecoverablePublication(state: 'preparing' | 'published', suffix: string, activeLease = false) {
  const requestHash = `sha256:${suffix.repeat(64).slice(0, 64)}`;
  const payload = { runId: 1, workspaceId: WORKSPACE_ID, marker: suffix };
  const run = await queryOne<{ id: number }>(
    `INSERT INTO pipeline_runs (
       spec_path, workspace_id, status, trigger_type, idempotency_key,
       dispatch_request_hash, dispatch_effective_options_hash
     ) VALUES ($1, $2, 'queued', 'manual', $3, $4, $5) RETURNING id`,
    [
      `forge/specs/approved/recovery-${suffix}.json`,
      WORKSPACE_ID,
      `11111111-1111-4111-8111-${suffix.repeat(12).slice(0, 12)}`,
      requestHash,
      requestHash,
    ],
  );
  payload.runId = run!.id;
  const exactPayloadHash = retryHash(payload);
  await execute(
    `UPDATE pipeline_dispatch_publications
        SET state = $2, request_hash = $3, effective_options_hash = $3,
            payload_hash = $4, payload = $5::jsonb,
            lease_owner = CASE WHEN $6 THEN 'live-owner' ELSE 'dead-owner' END,
            lease_expires_at = CASE WHEN $6 THEN NOW() + INTERVAL '5 minutes' ELSE NOW() - INTERVAL '1 minute' END,
            updated_at = CASE WHEN $2 = 'published' THEN NOW() - INTERVAL '10 minutes' ELSE NOW() - INTERVAL '1 minute' END
      WHERE run_id = $1`,
    [run!.id, state, requestHash, exactPayloadHash, JSON.stringify(payload), activeLease],
  );
  return { runId: run!.id, payload, payloadHash: exactPayloadHash };
}

beforeEach(async () => {
  await execute('DELETE FROM pipeline_runs WHERE workspace_id = $1', [WORKSPACE_ID]);
  await execute(
    `INSERT INTO workspaces (id, label, path)
     VALUES ($1, 'Dispatch recovery', '/tmp/rorca-dispatch-recovery')
     ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label`,
    [WORKSPACE_ID],
  );
  jest.clearAllMocks();
});

afterAll(async () => {
  await execute('DELETE FROM pipeline_runs WHERE workspace_id = $1', [WORKSPACE_ID]);
  await execute('DELETE FROM workspaces WHERE id = $1', [WORKSPACE_ID]);
});

test('payload-less direct transport completion fails closed in application dispatch authority', async () => {
  const run = await queryOne<{ id: number }>(
    `INSERT INTO pipeline_runs (spec_path, workspace_id, status, trigger_type)
     VALUES ('forge/specs/approved/direct-transport.json', $1, 'queued', 'manual')
     RETURNING id`,
    [WORKSPACE_ID],
  );

  await execute(`UPDATE pipeline_runs SET status = 'done', finished_at = NOW() WHERE id = $1`, [run!.id]);
  const publication = await queryOne<{ state: string; last_error: string | null; payload: unknown }>(
    `SELECT state, last_error, payload FROM pipeline_dispatch_publications WHERE run_id = $1`,
    [run!.id],
  );
  expect(publication).toEqual({
    state: 'failed',
    last_error: 'terminal_without_prepared_dispatch_payload',
    payload: null,
  });
});

test('restart recovery republishes expired preparation and stale published rows after transport retention loss', async () => {
  const expired = await seedRecoverablePublication('preparing', 'a');
  const retainedOnlyByApplication = await seedRecoverablePublication('published', 'b');
  const live = await seedRecoverablePublication('preparing', 'c', true);

  const result = await recoverPendingDispatchPublications({ limit: 10, workspaceId: WORKSPACE_ID });

  expect(result).toMatchObject({ scanned: 2, published: 2, failed: 0 });
  const send = jest.mocked(getBoss().send);
  expect(send).toHaveBeenCalledTimes(2);
  const sentIds = send.mock.calls.map((call) => (call[2] as { id?: string }).id).sort();
  const rows = await query<{ run_id: number; state: string; boss_job_id: string; publish_attempts: number }>(
    `SELECT run_id, state, boss_job_id::text, publish_attempts
       FROM pipeline_dispatch_publications
      WHERE run_id = ANY($1::bigint[]) ORDER BY run_id`,
    [[expired.runId, retainedOnlyByApplication.runId, live.runId]],
  );
  const recoveredRows = rows.filter((row) => row.run_id !== live.runId);
  expect(sentIds).toEqual(recoveredRows.map((row) => row.boss_job_id).sort());
  expect(recoveredRows).toEqual(expect.arrayContaining([
    expect.objectContaining({ run_id: expired.runId, state: 'published', publish_attempts: 1 }),
    expect.objectContaining({ run_id: retainedOnlyByApplication.runId, state: 'published', publish_attempts: 1 }),
  ]));
  expect(rows.find((row) => row.run_id === live.runId)).toMatchObject({ state: 'preparing', publish_attempts: 0 });
});
