/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * PG-017: pg-boss cron distributed locking tests.
 *
 * Tests the schedule lifecycle and distributed locking behaviour:
 *
 * Test A — Exactly-once execution:
 *   Start 2 boss instances (bossA, bossB) against the same DB.
 *   Both register workers for a unique per-test queue name.
 *   Enqueue a SINGLE job into that queue.
 *   Assert exactly 1 dispatch (pg-boss row-level lock prevents double-pick).
 *   Assert exactly 1 pipeline_runs row created.
 *
 * Tests B-D — pg-boss v10 schedule API compatibility fixtures only:
 *   These isolated names verify restart/unschedule/reschedule behavior of the
 *   dependency. They are not Rorca production topology and never register an
 *   application schedule queue. Production uses only Test E's pipeline:cron
 *   meta queue plus application-owned occurrence leases.
 *
 * Architecture:
 *   - Two PgBoss instances (bossA, bossB) share the test DB.
 *   - Unique queue names per test prevent cross-test worker interference.
 *   - No execution-engine subprocess; handlers write pipeline_runs directly.
 *   - pg-boss v10 requires createQueue() before schedule() or work().
 *   - pgboss.schedule columns: name, cron, timezone, data, options, created_on, updated_on.
 *     (No next_run_at column — next fire time is computed from cron expression.)
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Pool } from 'pg';
import PgBoss from 'pg-boss';
import { assertConnectedTestDatabase, resolveTestDatabaseUrl } from '../lib/test-db-safety';
import {
  PIPELINE_CRON_QUEUE,
  checkAndFireDueSchedules,
  registerSchedulesWithBoss,
} from '../lib/scheduler';

// -- DB URL --

const DB_URL = resolveTestDatabaseUrl();

// Keep this real-runtime suite isolated from unit-test fixtures that historically
// created a noncanonical partial `pgboss` schema. PgBoss alone owns this schema.
const BOSS_SCHEMA = 'pgboss_scheduler_cert';

// -- Timing --

const POLL_INTERVAL_MS = 200;
const JOB_RECEIPT_MAX_MS = 6_000;
const DOUBLE_FIRE_WINDOW_MS = 2_000;
const BOSS_STOP_TIMEOUT_MS = 5_000;

jest.setTimeout(60_000);

// -- Helpers --

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(
  predicate: () => Promise<boolean>,
  maxMs = JOB_RECEIPT_MAX_MS,
  intervalMs = POLL_INTERVAL_MS,
): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  return new Promise<boolean>((resolve) => {
    const timer = setInterval(async () => {
      try {
        if (await predicate()) {
          clearInterval(timer);
          resolve(true);
          return;
        }
      } catch {
        // ignore transient errors
      }
      if (Date.now() >= deadline) {
        clearInterval(timer);
        resolve(false);
      }
    }, intervalMs);
  });
}

async function makeBoss(): Promise<PgBoss> {
  const boss = new PgBoss({
    connectionString: DB_URL,
    schema: BOSS_SCHEMA,
    pollingIntervalSeconds: 1,
  });
  boss.on('error', () => { /* suppress */ });
  await boss.start();
  return boss;
}

function scheduleName(scheduleId: number): string {
  return `pipeline:cron:${scheduleId}`;
}

// -- Suite state --

let pool: Pool;
let bossA: PgBoss;
let bossB: PgBoss;

const testScheduleIds: number[] = [];
const testRunIds: number[] = [];
const testWorkspaceIds: string[] = [];
const tempDirs: string[] = [];
const scheduledNames: string[] = [];

// -- Suite setup --

beforeAll(async () => {
  pool = new Pool({ connectionString: DB_URL, max: 5 });
  await assertConnectedTestDatabase(pool, DB_URL);
  const { runPgMigrations } = await import('../db/pg-index');
  await runPgMigrations(pool);
  bossA = await makeBoss();
  bossB = await makeBoss();
}, 30_000);

afterAll(async () => {
  try { await bossA.stop({ timeout: BOSS_STOP_TIMEOUT_MS }); } catch { /* ignore */ }
  try { await bossB.stop({ timeout: BOSS_STOP_TIMEOUT_MS }); } catch { /* ignore */ }
  await pool.end();
}, 20_000);

afterEach(async () => {
  for (const name of scheduledNames.splice(0)) {
    try { await bossA.unschedule(name); } catch { /* ignore */ }
    try { await bossB.unschedule(name); } catch { /* ignore */ }
  }

  if (testRunIds.length > 0) {
    const ids = [...testRunIds];
    testRunIds.length = 0;
    await pool.query('DELETE FROM run_output_chunks WHERE run_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM story_results WHERE run_id = ANY($1)', [ids]);
    await pool.query(
      "DELETE FROM wal_events WHERE (payload->>'run_id')::int = ANY($1)",
      [ids],
    );
    await pool.query('DELETE FROM pipeline_runs WHERE id = ANY($1)', [ids]);
  }

  if (testScheduleIds.length > 0) {
    const ids = [...testScheduleIds];
    testScheduleIds.length = 0;
    await pool.query('DELETE FROM pipeline_schedules WHERE id = ANY($1)', [ids]);
  }

  if (testWorkspaceIds.length > 0) {
    const wsIds = [...testWorkspaceIds];
    testWorkspaceIds.length = 0;
    await pool.query('DELETE FROM workspaces WHERE id = ANY($1)', [wsIds]);
  }

  for (const d of tempDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}, 15_000);

// -- Fixture factory --

interface TestFixture {
  workspaceId: string;
  specId: string;
  specPath: string;
  scheduleId: number;
  workspacePath: string;
}

async function createTestFixture(tag: string, cronExpression = '*/5 * * * *'): Promise<TestFixture> {
  const workspaceId = `ws-sched-${tag}-${Date.now()}`;
  const specId = `test-sched-${tag}`;
  const specPath = `forge/specs/approved/${specId}.json`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `rorca-sched-${tag}-`));
  tempDirs.push(tmpDir);

  const specDir = path.join(tmpDir, 'forge', 'specs', 'approved');
  fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(path.join(specDir, `${specId}.json`), JSON.stringify({
    title: specId,
    userStories: [{ id: 'US-001', title: 'Test', description: 'Test', acceptanceCriteria: ['AC1'], dependsOn: [], passes: false }],
    model: 'claude-sonnet-4-6',
    generatedAt: new Date().toISOString(),
  }));

  await pool.query(
    'INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
    [workspaceId, `Scheduler Test ${tag}`, tmpDir],
  );
  testWorkspaceIds.push(workspaceId);

  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO pipeline_schedules (workspace_id, spec_id, cron_expression, enabled)
     VALUES ($1, $2, $3, true) RETURNING id`,
    [workspaceId, specId, cronExpression],
  );
  testScheduleIds.push(rows[0].id);

  return { workspaceId, specId, specPath, scheduleId: rows[0].id, workspacePath: tmpDir };
}

// ── Test A — pg-boss lock: single job dispatched to exactly one worker ──────

describe('Test A — exactly-once: pg-boss dispatches a job to exactly 1 of 2 workers', () => {
  it('creates exactly 1 pipeline_runs row when 2 workers compete for the same job', async () => {
    const { workspaceId, specPath, scheduleId } = await createTestFixture('testa');

    // Use a unique per-test queue name to isolate from workers in other test files
    const uniqueQueue = `test-pipeline-run-${Date.now()}-${scheduleId}`;
    await bossA.createQueue(uniqueQueue);
    await bossB.createQueue(uniqueQueue);

    let processedByA = 0;
    let processedByB = 0;

    // Both workers listen on the same unique queue.
    // pg-boss row-level locking ensures each job is handled by exactly one.
    await bossA.work(uniqueQueue, async (jobs: PgBoss.Job<Record<string, unknown>>[]) => {
      for (const _ of jobs) {
        processedByA++;
        const { rows } = await pool.query<{ id: number }>(
          `INSERT INTO pipeline_runs (spec_path, workspace_id, status)
           VALUES ($1, $2, 'queued') RETURNING id`,
          [specPath, workspaceId],
        );
        testRunIds.push(rows[0].id);
      }
    });

    await bossB.work(uniqueQueue, async (jobs: PgBoss.Job<Record<string, unknown>>[]) => {
      for (const _ of jobs) {
        processedByB++;
        const { rows } = await pool.query<{ id: number }>(
          `INSERT INTO pipeline_runs (spec_path, workspace_id, status)
           VALUES ($1, $2, 'queued') RETURNING id`,
          [specPath, workspaceId],
        );
        testRunIds.push(rows[0].id);
      }
    });

    // Send exactly ONE job — simulates what the cron handler enqueues on fire.
    const payload = {
      runId: scheduleId,
      specPath,
      workspacePath: '/tmp',
      agent: 'claude',
      model: null,
      worktreePath: null,
      branchName: null,
      autoWorktree: false,
      envOverrides: {},
    };

    const jobId = await bossA.send(uniqueQueue, payload as object);
    expect(jobId).not.toBeNull();

    // Wait for exactly one worker to pick it up
    const processed = await waitFor(
      async () => (processedByA + processedByB) > 0,
      JOB_RECEIPT_MAX_MS,
    );
    expect(processed).toBe(true);

    // Extra window to detect any double-dispatch
    await sleep(DOUBLE_FIRE_WINDOW_MS);

    // CORE ASSERTION: exactly 1 dispatch, not 2
    expect(processedByA + processedByB).toBe(1);

    // CORE ASSERTION: exactly 1 pipeline_runs row
    const { rows: runRows } = await pool.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM pipeline_runs WHERE workspace_id = $1',
      [workspaceId],
    );
    expect(parseInt(runRows[0].count, 10)).toBe(1);
  });
});

// ── Test B — Worker restart persistence ─────────────────────────────────────

describe('Test B — worker restart: schedule row persists after boss restart', () => {
  it('preserves cron expression and updated_on after stopping and restarting one worker', async () => {
    const cronExpression = '0 3 * * *';
    const { scheduleId } = await createTestFixture('testb', cronExpression);
    const cronScheduleName = scheduleName(scheduleId);

    // pg-boss v10: queue must exist before boss.schedule() can register it
    await bossA.createQueue(cronScheduleName);
    await bossB.createQueue(cronScheduleName);

    await bossA.schedule(cronScheduleName, cronExpression, { scheduleId });
    scheduledNames.push(cronScheduleName);

    // Read pg-boss internal schedule row before restart
    // pgboss.schedule columns: name, cron, timezone, data, options, created_on, updated_on
    const { rows: beforeRows } = await pool.query<{
      name: string;
      cron: string;
      created_on: Date;
      updated_on: Date;
    }>(
      `SELECT name, cron, created_on, updated_on FROM ${BOSS_SCHEMA}.schedule WHERE name = $1`,
      [cronScheduleName],
    );
    expect(beforeRows.length).toBe(1);
    expect(beforeRows[0].cron).toBe(cronExpression);
    const createdOnBefore = beforeRows[0].created_on;
    const updatedOnBefore = beforeRows[0].updated_on;

    // Stop bossB (one worker goes down)
    await bossB.stop({ timeout: BOSS_STOP_TIMEOUT_MS });
    await sleep(300);

    // Restart bossB
    bossB = await makeBoss();
    await bossB.createQueue(cronScheduleName);
    await bossB.schedule(cronScheduleName, cronExpression, { scheduleId });
    await bossB.work(cronScheduleName, async () => { /* no-op */ });

    // Query pgboss.schedule after restart + re-registration
    const { rows: afterRows } = await pool.query<{
      name: string;
      cron: string;
      created_on: Date;
      updated_on: Date;
    }>(
      `SELECT name, cron, created_on, updated_on FROM ${BOSS_SCHEMA}.schedule WHERE name = $1`,
      [cronScheduleName],
    );

    // CORE ASSERTIONS:
    expect(afterRows.length).toBe(1);
    expect(afterRows[0].name).toBe(cronScheduleName);
    expect(afterRows[0].cron).toBe(cronExpression);

    // created_on must not change (schedule was already there)
    expect(afterRows[0].created_on.getTime()).toBe(createdOnBefore.getTime());

    // updated_on must not be earlier (may be same or later due to re-registration)
    expect(afterRows[0].updated_on.getTime()).toBeGreaterThanOrEqual(updatedOnBefore.getTime());
  });
});

// ── Test C — Schedule deletion ───────────────────────────────────────────────

describe('Test C — schedule deletion: unschedule cleans up pgboss.schedule', () => {
  it('removes pgboss.schedule row and pipeline_schedules row on delete', async () => {
    const { scheduleId } = await createTestFixture('testc');
    const cronScheduleName = scheduleName(scheduleId);

    await bossA.createQueue(cronScheduleName);
    await bossA.schedule(cronScheduleName, '*/5 * * * *', { scheduleId });
    scheduledNames.push(cronScheduleName);

    // Confirm schedule row exists
    const { rows: existRows } = await pool.query(
      `SELECT name FROM ${BOSS_SCHEMA}.schedule WHERE name = $1`,
      [cronScheduleName],
    );
    expect(existRows.length).toBe(1);

    // Dependency API compatibility only; production DELETE cascades application occurrences.
    await bossA.unschedule(cronScheduleName);
    const idx = scheduledNames.indexOf(cronScheduleName);
    if (idx !== -1) scheduledNames.splice(idx, 1);

    await pool.query('DELETE FROM pipeline_schedules WHERE id = $1', [scheduleId]);
    const sIdx = testScheduleIds.indexOf(scheduleId);
    if (sIdx !== -1) testScheduleIds.splice(sIdx, 1);

    // CORE ASSERTION 1: pgboss.schedule row gone
    const { rows: goneRows } = await pool.query(
      `SELECT name FROM ${BOSS_SCHEMA}.schedule WHERE name = $1`,
      [cronScheduleName],
    );
    expect(goneRows.length).toBe(0);

    // CORE ASSERTION 2: pipeline_schedules row gone
    const { rows: schedRows } = await pool.query(
      'SELECT id FROM pipeline_schedules WHERE id = $1',
      [scheduleId],
    );
    expect(schedRows.length).toBe(0);
  });
});

// ── Test D — Schedule update (cron expression change) ───────────────────────

describe('Test D — schedule update: unschedule + re-schedule with new expression', () => {
  it('replaces old cron entry and DB row with new expression', async () => {
    const oldExpression = '0 6 * * *';
    const newExpression = '0 18 * * *';
    const { scheduleId } = await createTestFixture('testd', oldExpression);
    const cronScheduleName = scheduleName(scheduleId);

    await bossA.createQueue(cronScheduleName);
    await bossA.schedule(cronScheduleName, oldExpression, { scheduleId });
    scheduledNames.push(cronScheduleName);

    // Verify old schedule in pgboss.schedule
    const { rows: oldRows } = await pool.query<{ name: string; cron: string }>(
      `SELECT name, cron FROM ${BOSS_SCHEMA}.schedule WHERE name = $1`,
      [cronScheduleName],
    );
    expect(oldRows.length).toBe(1);
    expect(oldRows[0].cron).toBe(oldExpression);

    // Dependency API compatibility only; production PATCH mutates application rows.
    await bossA.unschedule(cronScheduleName);
    const { rows: goneRows } = await pool.query(
      `SELECT name FROM ${BOSS_SCHEMA}.schedule WHERE name = $1`,
      [cronScheduleName],
    );
    expect(goneRows.length).toBe(0);

    await bossA.schedule(cronScheduleName, newExpression, { scheduleId });
    await pool.query(
      `UPDATE pipeline_schedules SET cron_expression = $1, updated_at = NOW() WHERE id = $2`,
      [newExpression, scheduleId],
    );

    // CORE ASSERTION 1: new pgboss.schedule entry has updated expression
    const { rows: newRows } = await pool.query<{ name: string; cron: string }>(
      `SELECT name, cron FROM ${BOSS_SCHEMA}.schedule WHERE name = $1`,
      [cronScheduleName],
    );
    expect(newRows.length).toBe(1);
    expect(newRows[0].cron).toBe(newExpression);
    expect(newRows[0].name).toBe(cronScheduleName);

    // CORE ASSERTION 2: pipeline_schedules DB row updated
    const { rows: dbRows } = await pool.query<{ cron_expression: string }>(
      'SELECT cron_expression FROM pipeline_schedules WHERE id = $1',
      [scheduleId],
    );
    expect(dbRows[0].cron_expression).toBe(newExpression);
  });
});

// ── Test E — canonical production meta queue + occurrence authority ─────────

describe('Test E — production scheduler: two workers and crash-safe occurrence claims', () => {
  it('fires one exact occurrence for a schedule created after both workers start and recovers an expired dispatch lease once', async () => {
    const originalFetch = globalThis.fetch;
    let triggerCalls = 0;
    try {
      globalThis.fetch = (async () => {
        triggerCalls += 1;
        return new Response(JSON.stringify({ conflict: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch;

      // Both production workers register only the one canonical meta queue.
      await registerSchedulesWithBoss(bossA, async () => { await checkAndFireDueSchedules(); });
      await registerSchedulesWithBoss(bossB, async () => { await checkAndFireDueSchedules(); });
      scheduledNames.push(PIPELINE_CRON_QUEUE);

      // Create after worker registration: no dynamic queue/subscription exists.
      const fixture = await createTestFixture('production-meta', '* * * * *');
      await pool.query(
        `UPDATE pipeline_schedules SET last_triggered_at = NOW() - INTERVAL '5 minutes' WHERE id = $1`,
        [fixture.scheduleId],
      );

      const tickId = await bossA.send(PIPELINE_CRON_QUEUE, { source: 'test-production-meta' });
      expect(tickId).not.toBeNull();
      expect(await waitFor(async () => triggerCalls === 1)).toBe(true);
      await sleep(DOUBLE_FIRE_WINDOW_MS);
      expect(triggerCalls).toBe(1);

      const first = await pool.query<{
        id: number; status: string; attempt_count: number; request_key: string;
      }>(
        `SELECT id, status, attempt_count, request_key
           FROM pipeline_schedule_occurrences WHERE schedule_id = $1`,
        [fixture.scheduleId],
      );
      expect(first.rows).toHaveLength(1);
      expect(first.rows[0]).toMatchObject({ status: 'dispatched', attempt_count: 1 });
      expect(first.rows[0].request_key).toMatch(/^schedule:/);

      // Simulate response loss/worker death after application lease claim. Two
      // workers race the expired lease; exact request identity is reused once.
      await pool.query(
        `UPDATE pipeline_schedule_occurrences
            SET status = 'dispatching', dispatched_at = NULL,
                lease_owner = 'dead-worker', lease_expires_at = NOW() - INTERVAL '1 second'
          WHERE id = $1`,
        [first.rows[0].id],
      );
      await Promise.all([checkAndFireDueSchedules(), checkAndFireDueSchedules()]);
      expect(triggerCalls).toBe(2);
      const recovered = await pool.query<{ status: string; attempt_count: number; lease_owner: string | null }>(
        `SELECT status, attempt_count, lease_owner
           FROM pipeline_schedule_occurrences WHERE id = $1`,
        [first.rows[0].id],
      );
      expect(recovered.rows[0]).toEqual({ status: 'dispatched', attempt_count: 2, lease_owner: null });

      const metaSchedules = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM ${BOSS_SCHEMA}.schedule WHERE name = $1`,
        [PIPELINE_CRON_QUEUE],
      );
      expect(metaSchedules.rows[0].count).toBe('1');
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 30_000);
});
