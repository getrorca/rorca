/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * PG-020: Load test — 10 concurrent runs with 6 worker slots (batchSize:3 × 2 instances).
 *
 * Setup:
 *   - 2 pg-boss worker registrations, each with batchSize:3 (6 total concurrent slots)
 *   - In-process handler: sleeps 2s then marks run done (NO subprocesses)
 *   - Real PostgreSQL via TEST_DATABASE_URL / DATABASE_URL
 *
 * Test sequence (single 'execution' test handles timing-sensitive assertions):
 *   1. Start concurrency monitor (setInterval every 100ms)
 *   2. Trigger 10 runs simultaneously via Promise.all
 *   3. Assert all 10 job IDs are distinct (pg-boss deduplication check)
 *   4. Assert all 10 enter valid lifecycle state (queued/running/done) immediately
 *   5. Wait for all 10 to reach 'done' (target < 90s with 6 slots and 2s engine)
 *   6. Assert peak concurrency never exceeded 6 'running' rows
 *   7. Log observed throughput: "Completed 10 runs in Xs (Y runs/min)"
 *
 * Post-execution assertion tests (run after all 10 done):
 *   8. story_results has zero duplicate (run_id, story_id) pairs
 *   9. run_output_chunks sequences are contiguous per run (no gaps)
 *  10. No pg-boss internal errors fired
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as http from 'http';
import { Pool } from 'pg';
import PgBoss from 'pg-boss';
import express, { type Express } from 'express';
import { assertConnectedTestDatabase, resolveTestDatabaseUrl } from '../lib/test-db-safety';

// ── Extend Jest timeout for this suite ──────────────────────────────────────

jest.setTimeout(150_000);

// ── Connection ──────────────────────────────────────────────────────────────

const DB_URL = resolveTestDatabaseUrl();

// ── Constants ───────────────────────────────────────────────────────────────

const MOCK_ENGINE_SLEEP_MS = 2_000;
const TOTAL_RUNS = 10;
const WORKER_SLOTS_PER_INSTANCE = 3;
const TOTAL_WORKER_SLOTS = WORKER_SLOTS_PER_INSTANCE * 2; // 6 total
const POLL_INTERVAL_MS = 100;

// ── Suite state (shared across all tests via module scope) ───────────────────

let pool: Pool;
let boss: PgBoss;
let app: Express;
let server: http.Server;
let serverPort: number;

// Errors emitted by pg-boss internally or pg pool — test fails if any fire
const bossErrors: Error[] = [];

// Peak concurrency observed during execution (set by the main execution test)
let peakConcurrency = 0;

// Run IDs created during the execution test (used by assertion tests)
const loadRunIds: number[] = [];

// All run IDs across all tests (for afterAll cleanup)
const allRunIds: number[] = [];
// All workspace IDs (for afterAll cleanup)
const allWorkspaceIds: string[] = [];
// Temp spec files to delete in afterAll
const tempSpecPaths: string[] = [];

// ── Helpers ─────────────────────────────────────────────────────────────────

async function waitFor(
  predicate: () => Promise<boolean>,
  maxMs: number,
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
        // ignore transient errors during polling
      }
      if (Date.now() >= deadline) {
        clearInterval(timer);
        resolve(false);
      }
    }, intervalMs);
  });
}

// ── Mini Express server ──────────────────────────────────────────────────────

function buildMiniServer(dbPool: Pool): Express {
  const miniApp = express();
  miniApp.use(express.json());

  miniApp.post('/api/wal', async (req, res) => {
    try {
      const { event_type, workspace_id, spec_id, story_id, payload } = req.body as {
        event_type: string;
        workspace_id?: string;
        spec_id?: string;
        story_id?: string;
        payload?: Record<string, unknown>;
      };
      await dbPool.query(
        `INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, payload)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          event_type,
          workspace_id ?? null,
          spec_id ?? null,
          story_id ?? null,
          payload ? JSON.stringify(payload) : null,
        ],
      );
      res.status(201).json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  miniApp.post('/api/pipeline/story-result', async (req, res) => {
    try {
      const { runId, storyId, status } = req.body as {
        runId: number;
        storyId: string;
        status: string;
      };
      await dbPool.query(
        `INSERT INTO story_results (run_id, story_id, status, finished_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT DO NOTHING`,
        [runId, storyId, status],
      );
      res.status(201).json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return miniApp;
}

// ── In-process mock handler ──────────────────────────────────────────────────

/**
 * Mock job handler simulating a 2-second execution-engine run.
 * No subprocess spawn — all DB operations happen in-process.
 *
 * Per job:
 *   1. Mark pipeline_run as 'running'
 *   2. WAL run_started
 *   3. Output chunk #1 ("mock-load: start runId=N")
 *   4. Sleep 2s
 *   5. WAL story_started + story_passed + story_results row
 *   6. Output chunk #2 ("mock-load: done runId=N")
 *   7. Mark pipeline_run as 'done'
 *   8. WAL run_finished
 */
async function mockLoadHandler(
  jobs: PgBoss.Job<Record<string, unknown>>[],
): Promise<void> {
  for (const job of jobs) {
    const data = job.data as {
      runId: number;
      specPath: string;
      workspacePath: string;
    };
    const { runId, specPath, workspacePath } = data;
    if (!runId) continue;

    // Look up workspace_id
    const { rows: runRows } = await pool.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM pipeline_runs WHERE id = $1',
      [runId],
    );
    if (runRows.length === 0) continue;
    const workspaceId = runRows[0].workspace_id;

    // 1. Mark running
    await pool.query(
      "UPDATE pipeline_runs SET status = 'running', started_at = NOW(), pid = $1 WHERE id = $2",
      [process.pid, runId],
    );

    // 2. WAL run_started
    await pool.query(
      `INSERT INTO wal_events (event_type, workspace_id, payload)
       VALUES ('run_started', $1, $2)`,
      [workspaceId, JSON.stringify({ run_id: runId, spec_path: specPath })],
    );

    // 3. Output chunk #1
    const startMsg = Buffer.from(`mock-load: start runId=${runId}\n`);
    await pool.query(
      `INSERT INTO run_output_chunks (run_id, chunk, sequence)
       VALUES ($1, $2, 1)
       ON CONFLICT (run_id, sequence) DO NOTHING`,
      [runId, startMsg],
    );

    // 4. Simulate work (2s sleep — the "execution engine")
    await new Promise<void>((r) => setTimeout(r, MOCK_ENGINE_SLEEP_MS));

    // 5. Determine stories from spec file
    let storyIds: string[] = [];
    try {
      const absPath = path.isAbsolute(specPath)
        ? specPath
        : path.join(workspacePath ?? '', specPath);
      const specJson = JSON.parse(fs.readFileSync(absPath, 'utf8')) as {
        userStories?: Array<{ id: string; passes?: boolean; excluded?: boolean }>;
      };
      storyIds = (specJson.userStories ?? [])
        .filter((s) => !s.passes && !s.excluded)
        .map((s) => s.id);
    } catch {
      storyIds = ['US-001'];
    }

    for (const storyId of storyIds) {
      await pool.query(
        `INSERT INTO wal_events (event_type, workspace_id, payload)
         VALUES ('story_started', $1, $2)`,
        [workspaceId, JSON.stringify({ run_id: runId, story_id: storyId })],
      );
      await pool.query(
        `INSERT INTO wal_events (event_type, workspace_id, payload)
         VALUES ('story_passed', $1, $2)`,
        [workspaceId, JSON.stringify({ run_id: runId, story_id: storyId })],
      );
      await pool.query(
        `INSERT INTO story_results (run_id, story_id, status, finished_at)
         VALUES ($1, $2, 'pass', NOW())
         ON CONFLICT DO NOTHING`,
        [runId, storyId],
      );
    }

    // 6. Output chunk #2
    const doneMsg = Buffer.from(
      `mock-load: done runId=${runId} stories=${storyIds.length}\n`,
    );
    await pool.query(
      `INSERT INTO run_output_chunks (run_id, chunk, sequence)
       VALUES ($1, $2, 2)
       ON CONFLICT (run_id, sequence) DO NOTHING`,
      [runId, doneMsg],
    );

    // 7. Mark done
    await pool.query(
      "UPDATE pipeline_runs SET status = 'done', finished_at = NOW() WHERE id = $1",
      [runId],
    );

    // 8. WAL run_finished
    await pool.query(
      `INSERT INTO wal_events (event_type, workspace_id, payload)
       VALUES ('run_finished', $1, $2)`,
      [workspaceId, JSON.stringify({ run_id: runId, status: 'done', exit_code: 0 })],
    );
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

async function createTestFixtures(tag: string): Promise<{
  workspaceId: string;
  workspacePath: string;
  specPath: string;
  absSpecPath: string;
}> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${tag}`;
  const workspaceId = `test-load-${suffix}`;
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-load-'));

  await pool.query(
    `INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3)`,
    [workspaceId, `Load Test WS ${suffix}`, workspacePath],
  );
  allWorkspaceIds.push(workspaceId);

  const specJson = {
    title: `load-test-spec-${suffix}`,
    userStories: [
      {
        id: 'US-001',
        title: 'Load test story',
        description: 'Load test placeholder story',
        acceptanceCriteria: ['It completes'],
        dependsOn: [],
        passes: false,
      },
    ],
    model: 'claude-sonnet-4-5-20250929',
    generatedAt: new Date().toISOString(),
  };

  const specDir = path.join(workspacePath, 'forge', 'specs', 'approved');
  fs.mkdirSync(specDir, { recursive: true });
  const absSpecPath = path.join(specDir, `load-test-spec-${suffix}.json`);
  fs.writeFileSync(absSpecPath, JSON.stringify(specJson, null, 2));
  tempSpecPaths.push(absSpecPath);

  const specPath = absSpecPath; // use absolute path so handler can read it without workspacePath

  return { workspaceId, workspacePath, specPath, absSpecPath };
}

async function triggerRun(
  workspaceId: string,
  workspacePath: string,
  specPath: string,
): Promise<{ runId: number; jobUuid: string | null }> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO pipeline_runs
       (spec_path, workspace_id, status, trigger_type, parallelism, agent, agent_type, agent_model, queued_at)
     VALUES ($1, $2, 'queued', 'manual', 1, 'claude', 'claude', NULL, NOW())
     RETURNING id`,
    [specPath, workspaceId],
  );
  const runId = rows[0].id;
  allRunIds.push(runId);
  loadRunIds.push(runId);

  // Do NOT pass a custom `id` — pg-boss v10 requires valid UUIDs and integer strings
  // fail with "invalid input syntax for type uuid". Use auto-generated UUID.
  // runId is embedded in the data payload for correlation (per AGENTS.md gotcha).
  const jobUuid = await boss.send('pipeline:run:load-test', {
    runId,
    specPath,
    workspacePath,
    agent: 'claude',
    model: null,
    worktreePath: null,
    branchName: null,
    autoWorktree: false,
    envOverrides: {},
  });

  return { runId, jobUuid };
}

// ── Suite setup / teardown ───────────────────────────────────────────────────

beforeAll(async () => {
  // 1. Connect pool (max:20 to avoid exhaustion with 2 workers × 3 slots + test assertions)
  pool = new Pool({ connectionString: DB_URL, max: 20 });
  await assertConnectedTestDatabase(pool, DB_URL);
  pool.on('error', (err) => { bossErrors.push(err); });

  // 2. Run migrations
  const { runPgMigrations } = await import('../db/pg-index');
  await runPgMigrations(pool);

  // 3. Start mini Express server
  app = buildMiniServer(pool);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      serverPort = (server.address() as { port: number }).port;
      resolve();
    });
  });

  // 4. Start pg-boss with fast polling (1s for tests)
  boss = new PgBoss({
    connectionString: DB_URL,
    schema: 'pgboss',
    pollingIntervalSeconds: 1,
  });
  boss.on('error', (err: Error) => { bossErrors.push(err); });
  await boss.start();

  // 5. Create the dedicated load-test queue (pg-boss v10 requires explicit creation)
  await boss.createQueue('pipeline:run:load-test');

  // 6. Register 2 worker subscriptions with batchSize:3 (6 total concurrent slots)
  //    pg-boss uses SELECT FOR UPDATE SKIP LOCKED — each job goes to exactly one worker.
  await boss.work('pipeline:run:load-test', { batchSize: WORKER_SLOTS_PER_INSTANCE }, mockLoadHandler);
  await boss.work('pipeline:run:load-test', { batchSize: WORKER_SLOTS_PER_INSTANCE }, mockLoadHandler);
}, 30_000);

afterAll(async () => {
  try { await boss.stop({ timeout: 10_000 }); } catch { /* ignore */ }
  await new Promise<void>((res) => server.close(() => res()));

  if (allRunIds.length > 0) {
    const ids = [...allRunIds];
    await pool.query('DELETE FROM run_output_chunks WHERE run_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM story_results WHERE run_id = ANY($1)', [ids]);
    await pool.query(
      "DELETE FROM wal_events WHERE (payload->>'run_id')::int = ANY($1)",
      [ids],
    );
    await pool.query('DELETE FROM pipeline_runs WHERE id = ANY($1)', [ids]);
  }
  if (allWorkspaceIds.length > 0) {
    await pool.query('DELETE FROM workspaces WHERE id = ANY($1)', [allWorkspaceIds]);
  }
  for (const p of tempSpecPaths) {
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }

  await pool.end();
}, 20_000);

// ── Tests ────────────────────────────────────────────────────────────────────

describe('PG-020: pg-boss load test — 10 concurrent runs, 6 slots, 2s engine', () => {

  /**
   * Main execution test — combines triggering, concurrency monitoring, and completion.
   * Must run FIRST (Jest runs tests in order within a describe block).
   */
  it('triggers 10 runs simultaneously, monitors peak concurrency ≤ 6, all complete in < 90s', async () => {
    // Create 10 independent workspaces + specs
    const fixtures = await Promise.all(
      Array.from({ length: TOTAL_RUNS }, (_, i) => createTestFixtures(`r${i}`)),
    );

    // ── Start concurrency monitor BEFORE triggering ──────────────────────────
    let monitorPeak = 0;
    let monitorDone = false;
    const monitorTimer = setInterval(async () => {
      if (monitorDone || loadRunIds.length === 0) return;
      try {
        const { rows } = await pool.query<{ cnt: string }>(
          `SELECT COUNT(*) as cnt FROM pipeline_runs WHERE id = ANY($1) AND status = 'running'`,
          [loadRunIds],
        );
        const current = parseInt(rows[0]?.cnt ?? '0', 10);
        if (current > monitorPeak) {
          monitorPeak = current;
        }
      } catch {
        // ignore transient errors
      }
    }, POLL_INTERVAL_MS);

    const startTime = Date.now();

    try {
      // ── Trigger all 10 simultaneously ──────────────────────────────────────
      const results = await Promise.all(
        fixtures.map(({ workspaceId, workspacePath, specPath }) =>
          triggerRun(workspaceId, workspacePath, specPath),
        ),
      );

      // Assert: all 10 job UUIDs are non-null (successful enqueue)
      // pg-boss returns null if the job was deduplicated — indicates duplicate job IDs
      const jobUuids = results.map((r) => r.jobUuid);
      const nonNullUuids = jobUuids.filter((id) => id !== null);
      expect(nonNullUuids).toHaveLength(TOTAL_RUNS);

      // Assert: all 10 run IDs are distinct
      const uniqueRunIds = new Set(loadRunIds);
      expect(uniqueRunIds.size).toBe(TOTAL_RUNS);

      // Assert: all 10 pipeline_runs are in a valid lifecycle state
      const { rows: initialRows } = await pool.query<{ id: number; status: string }>(
        `SELECT id, status FROM pipeline_runs WHERE id = ANY($1) ORDER BY id`,
        [loadRunIds],
      );
      expect(initialRows).toHaveLength(TOTAL_RUNS);
      const validStatuses = new Set(['queued', 'running', 'done']);
      for (const row of initialRows) {
        expect(validStatuses.has(row.status)).toBe(true);
      }

      // ── Wait for all 10 to complete (90s limit) ────────────────────────────
      const allDone = await waitFor(async () => {
        const { rows } = await pool.query<{ status: string }>(
          'SELECT status FROM pipeline_runs WHERE id = ANY($1)',
          [loadRunIds],
        );
        return rows.length === TOTAL_RUNS && rows.every((r) => r.status === 'done');
      }, 90_000);

      const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
      const runsPerMin = (TOTAL_RUNS / (parseFloat(elapsedSec) / 60)).toFixed(1);

      console.log(
        `[PG-020] Completed ${TOTAL_RUNS} runs in ${elapsedSec}s (${runsPerMin} runs/min)`,
      );
      console.log(
        `[PG-020] Peak concurrency: ${monitorPeak}/${TOTAL_WORKER_SLOTS} slots used`,
      );
      console.log(
        `[PG-020] Worker slots: ${TOTAL_WORKER_SLOTS} | Engine latency: ${MOCK_ENGINE_SLEEP_MS}ms`,
      );

      expect(allDone).toBe(true);

      // Verify final status of each run
      const { rows: finalRows } = await pool.query<{ id: number; status: string }>(
        'SELECT id, status FROM pipeline_runs WHERE id = ANY($1) ORDER BY id',
        [loadRunIds],
      );
      expect(finalRows).toHaveLength(TOTAL_RUNS);
      for (const row of finalRows) {
        expect(row.status).toBe('done');
      }

      // ── Assert peak concurrency ≤ 6 ───────────────────────────────────────
      // With 6 worker slots and 10 jobs, peak should be ≤ 6.
      // We accept 0 only if all jobs completed before our first poll (unlikely with 2s sleep).
      expect(monitorPeak).toBeLessThanOrEqual(TOTAL_WORKER_SLOTS);

      // Save for suite-level reporting
      peakConcurrency = monitorPeak;

    } finally {
      monitorDone = true;
      clearInterval(monitorTimer);
    }
  }, 110_000);

  it('story_results has no duplicate (run_id, story_id) pairs across all 10 runs', async () => {
    expect(loadRunIds).toHaveLength(TOTAL_RUNS); // guard: execution test must have run

    const { rows: dupRows } = await pool.query<{
      run_id: number;
      story_id: string;
      cnt: string;
    }>(
      `SELECT run_id, story_id, COUNT(*) as cnt
       FROM story_results
       WHERE run_id = ANY($1)
       GROUP BY run_id, story_id
       HAVING COUNT(*) > 1`,
      [loadRunIds],
    );

    if (dupRows.length > 0) {
      console.error('[PG-020] Duplicate story_results found:', dupRows);
    }
    expect(dupRows).toHaveLength(0);
  });

  it('run_output_chunks sequences are contiguous per run (no gaps, no duplicates)', async () => {
    expect(loadRunIds).toHaveLength(TOTAL_RUNS); // guard

    const { rows: chunkRows } = await pool.query<{
      run_id: number;
      sequences: string;
    }>(
      `SELECT run_id, array_agg(sequence ORDER BY sequence)::text as sequences
       FROM run_output_chunks
       WHERE run_id = ANY($1)
       GROUP BY run_id`,
      [loadRunIds],
    );

    // Every run must have chunks
    expect(chunkRows).toHaveLength(TOTAL_RUNS);

    for (const row of chunkRows) {
      // Parse PostgreSQL array string "{1,2}" → [1, 2]
      const seqs = row.sequences
        .replace(/^\{/, '')
        .replace(/\}$/, '')
        .split(',')
        .map(Number);

      // Sequences must be 1-based and contiguous
      for (let i = 0; i < seqs.length; i++) {
        expect(seqs[i]).toBe(i + 1);
      }

      // Mock handler writes exactly 2 chunks per run (start + done)
      expect(seqs).toHaveLength(2);
    }
  });

  it('no pg-boss internal errors or pg pool exhaustion errors during the load test', () => {
    if (bossErrors.length > 0) {
      console.error('[PG-020] Errors detected during load test:', bossErrors);
    }
    expect(bossErrors).toHaveLength(0);
  });
});
