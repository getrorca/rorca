/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import type * as DatabaseModule from '../../db/index';
import type * as DispatchPublicationModule from '../dispatch-publication';
import type * as PgBossModule from '../pg-boss';
import type * as RetryGovernanceModule from '../retry-governance';

jest.mock('../pg-boss', () => ({
  initBoss: jest.fn().mockResolvedValue(undefined),
  getBoss: jest.fn().mockReturnValue({
    createQueue: jest.fn().mockResolvedValue(undefined),
    send: jest.fn().mockImplementation(async (_name: string, _payload: unknown, options?: { id?: string }) => options?.id ?? null),
  }),
}));
jest.mock('../lifecycle-dispatch-claim', () => ({
  parseLifecycleDispatchClaim: jest.fn((value: unknown) => value),
  assertLifecycleDispatchClaim: jest.fn().mockResolvedValue(undefined),
  withLifecycleDispatchClaimLock: jest.fn(async (_claim: unknown, action: () => unknown) => action()),
}));

const WORKSPACE_ID = `ws-dispatch-recovery-${randomUUID()}`;
const originalWorkspaceScope = process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE;
process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE = WORKSPACE_ID;

const { execute, query, queryOne } = require('../../db/index') as typeof DatabaseModule;
const { recoverPendingDispatchPublications } = require('../dispatch-publication') as typeof DispatchPublicationModule;
const { getBoss } = require('../pg-boss') as typeof PgBossModule;
const { retryHash } = require('../retry-governance') as typeof RetryGovernanceModule;
const { withLifecycleDispatchClaimLock } = require('../lifecycle-dispatch-claim') as {
  withLifecycleDispatchClaimLock: jest.Mock;
};

const migrationDatabaseUrl = process.env.WAVE2_TEST_MIGRATION_DATABASE_URL;
if (!migrationDatabaseUrl) throw new Error('WAVE2_TEST_MIGRATION_DATABASE_URL is required');
const ownerPool = new Pool({
  connectionString: migrationDatabaseUrl,
  max: 1,
  options: `--search_path=rorca,public -c rorca.migration_mode=on -c rorca.workspace_id=${WORKSPACE_ID}`,
});

function restoreEnvironment(): void {
  if (originalWorkspaceScope === undefined) delete process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE;
  else process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE = originalWorkspaceScope;
}

async function ownerExecute(sql: string, params: unknown[] = []): Promise<void> {
  await ownerPool.query(sql, params);
}

async function ownerQueryOne<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  const result = await ownerPool.query(sql, params);
  return result.rows[0] as T | undefined;
}

async function cleanupFixture(): Promise<void> {
  await ownerExecute(
    `DELETE FROM pipeline_run_cancellation_requests
      WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = $1)`,
    [WORKSPACE_ID],
  );
  await ownerExecute('DELETE FROM pipeline_dispatch_publications WHERE workspace_id = $1', [WORKSPACE_ID]);
  await ownerExecute('DELETE FROM pipeline_runs WHERE workspace_id = $1', [WORKSPACE_ID]);
  await ownerExecute('DELETE FROM workspaces WHERE id = $1', [WORKSPACE_ID]);
}

async function seedRecoverablePublication(
  state: 'preparing' | 'published',
  suffix: string,
  activeLease = false,
  queueName: 'pipeline:run' | 'pipeline:run:direct' = 'pipeline:run',
) {
  const requestHash = `sha256:${suffix.repeat(64).slice(0, 64)}`;
  const payload = {
    runId: 1,
    workspaceId: WORKSPACE_ID,
    marker: suffix,
    executionTimeoutSeconds: 7_200,
    triggerOptions: { lifecycleDispatchClaim: { fixture: true } },
  };
  const run = await ownerQueryOne<{ id: number }>(
    `INSERT INTO pipeline_runs (
       spec_path, workspace_id, status, trigger_type, idempotency_key,
       dispatch_request_hash, dispatch_effective_options_hash, dispatch_fence,
       trigger_options
     ) VALUES ($1, $2, 'queued', 'manual', $3, $4, $5, $4, $6::jsonb) RETURNING id`,
    [
      `forge/specs/approved/recovery-${suffix}.json`,
      WORKSPACE_ID,
      `11111111-1111-4111-8111-${suffix.repeat(12).slice(0, 12)}`,
      requestHash,
      requestHash,
      JSON.stringify(payload.triggerOptions),
    ],
  );
  payload.runId = run!.id;
  const exactPayloadHash = retryHash(payload);
  const publication = await ownerQueryOne<{ run_id: number }>(
    `UPDATE pipeline_dispatch_publications
        SET state = $2, request_hash = $3, effective_options_hash = $3,
            payload_hash = $4, payload = $5::jsonb, queue_name = $8,
            lease_owner = CASE WHEN $6 THEN 'live-owner' ELSE 'dead-owner' END,
            lease_expires_at = CASE WHEN $6 THEN NOW() + INTERVAL '5 minutes' ELSE NOW() - INTERVAL '1 minute' END,
            updated_at = CASE WHEN $2 = 'published' THEN NOW() - INTERVAL '10 minutes' ELSE NOW() - INTERVAL '1 minute' END
      WHERE run_id = $1 AND workspace_id = $7
      RETURNING run_id`,
    [run!.id, state, requestHash, exactPayloadHash, JSON.stringify(payload), activeLease, WORKSPACE_ID, queueName],
  );
  if (!publication) throw new Error(`Missing exact dispatch publication fixture for run ${run!.id}`);
  return { runId: run!.id, payload, payloadHash: exactPayloadHash };
}

beforeAll(async () => {
  const runtimePrincipal = await queryOne<{ principal_class: string; workspace_scope: string }>(
    `SELECT principal_class, current_setting('rorca.workspace_id', true) AS workspace_scope
       FROM wave2_database_principals WHERE database_user = current_user`,
  );
  const ownerPrincipal = (await ownerPool.query<{ principal_class: string }>(
    `SELECT principal_class FROM wave2_database_principals
      WHERE database_user = current_user`,
  )).rows[0];
  expect(runtimePrincipal).toEqual({ principal_class: 'internal_runtime', workspace_scope: WORKSPACE_ID });
  expect(ownerPrincipal).toEqual({ principal_class: 'migration_owner' });
});

beforeEach(async () => {
  process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE = WORKSPACE_ID;
  await cleanupFixture();
  await ownerExecute(
    `INSERT INTO workspaces (id, label, path)
     VALUES ($1, 'Dispatch recovery', $2)`,
    [WORKSPACE_ID, `/tmp/${WORKSPACE_ID}`],
  );
  jest.clearAllMocks();
});

afterAll(async () => {
  try {
    await cleanupFixture();
  } finally {
    await ownerPool.end();
    restoreEnvironment();
  }
});

test('payload-less direct transport completion fails closed in application dispatch authority', async () => {
  const dispatchFence = retryHash({ workspaceId: WORKSPACE_ID, contract: 'direct-transport' });
  const run = await ownerQueryOne<{ id: number }>(
    `INSERT INTO pipeline_runs (spec_path, workspace_id, status, trigger_type, dispatch_fence)
     VALUES ('forge/specs/approved/direct-transport.json', $1, 'queued', 'manual', $2)
     RETURNING id`,
    [WORKSPACE_ID, dispatchFence],
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
  const expired = await seedRecoverablePublication('preparing', 'a', false, 'pipeline:run:direct');
  const retainedOnlyByApplication = await seedRecoverablePublication('published', 'b');
  const live = await seedRecoverablePublication('preparing', 'c', true);

  const result = await recoverPendingDispatchPublications({ limit: 10, workspaceId: WORKSPACE_ID });

  expect(result).toMatchObject({ scanned: 2, published: 2, failed: 0 });
  const send = jest.mocked(getBoss().send);
  expect(send).toHaveBeenCalledTimes(2);
  expect(withLifecycleDispatchClaimLock).toHaveBeenCalledTimes(2);
  expect(Math.max(...withLifecycleDispatchClaimLock.mock.invocationCallOrder))
    .toBeLessThan(Math.max(...send.mock.invocationCallOrder));
  const sentIds = send.mock.calls.map((call) => (call[2] as { id?: string }).id).sort();
  expect(send.mock.calls.map(([queueName]) => queueName)).toEqual(expect.arrayContaining([
    'pipeline:run:direct',
    'pipeline:run',
  ]));
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

test('restart recovery performs no queue send when the lifecycle claim is stale', async () => {
  await seedRecoverablePublication('preparing', 'd');
  withLifecycleDispatchClaimLock.mockRejectedValueOnce(new Error('stale lifecycle dispatch claim'));

  const result = await recoverPendingDispatchPublications({ limit: 10, workspaceId: WORKSPACE_ID });

  expect(result).toMatchObject({ scanned: 1, published: 0, failed: 1 });
  expect(getBoss().send).not.toHaveBeenCalled();
});
