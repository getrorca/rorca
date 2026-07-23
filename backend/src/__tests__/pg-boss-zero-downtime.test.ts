/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * PG-019: Zero-downtime rolling deploy integration test.
 *
 * Simulates a production rolling deploy:
 *   1. Start worker-v1 (child process running rolling-worker.ts) and a mini HTTP server.
 *   2. Trigger 3 runs backed by ten-second-mock-engine.ts (10s execution).
 *   3. Wait for all 3 runs to reach status='running'.
 *   4. Send SIGTERM to worker-v1 — it should drain (complete in-flight jobs, log drain msg).
 *   5. Simultaneously start worker-v2 (same rolling-worker.ts script, fresh process).
 *   6. Trigger 2 more runs — they must be picked up by worker-v2.
 *   7. Wait for all 5 runs to complete with status='done'.
 *   8. Assert:
 *      a. worker-v1 logged "[worker] draining, waiting for N in-flight jobs..."
 *      b. worker-v1 stopped accepting new jobs after SIGTERM (runs 4+5 handled by worker-v2)
 *      c. No job executed twice (worker_id per run unique + no duplicate story_results)
 *      d. All 5 runs have status='done'
 *      e. run_output_chunks sequences contiguous for each run (max_seq = chunk_count)
 *
 * Architecture:
 *   rolling-worker.ts (subprocess v1)  ← handles runs 1-3, drains on SIGTERM
 *   rolling-worker.ts (subprocess v2)  ← handles runs 4-5 triggered post-SIGTERM
 *   mini Express server (in-process)   ← /api/wal + /api/pipeline/story-result
 *   ten-second-mock-engine.ts          ← spawned by rolling-worker per job (10s sleep)
 *
 * Why separate child processes (not in-process boss instances)?
 *   Two in-process PgBoss instances share memory → false-positive isolation in Jest.
 *   Separate OS processes with independent memory match production worker topology.
 *
 * Test DB: rorca_test (never inherits prod DATABASE_URL).
 * Timeout: 90s.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as http from 'http';
import { spawn, type ChildProcess } from 'child_process';
import { Pool } from 'pg';
import PgBoss from 'pg-boss';
import express, { type Express } from 'express';
import { assertConnectedTestDatabase, resolveTestDatabaseUrl } from '../lib/test-db-safety';
import { pgBossTestSchema } from './helpers/pg-boss-test-schema';

jest.setTimeout(90_000);

// ── DB URL ─────────────────────────────────────────────────────────────────────

const DB_URL = resolveTestDatabaseUrl();
const BOSS_SCHEMA = pgBossTestSchema('zero_downtime');

// ── Paths ──────────────────────────────────────────────────────────────────────

const ROLLING_WORKER_PATH = path.join(__dirname, 'fixtures', 'rolling-worker.ts');
const TSX_BIN = path.join(__dirname, '..', '..', 'node_modules', '.bin', 'tsx');

// ── Constants ──────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 300;

// ── Helpers ────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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

// ── Suite state ────────────────────────────────────────────────────────────────

let pool: Pool;
let app: Express;
let server: http.Server;
let serverPort: number;

// pg-boss sender instance used only to enqueue jobs (pollingIntervalSeconds=60 so it
// never picks up jobs itself — the worker child processes do the picking)
let senderBoss: PgBoss;

// Track test data for cleanup
const allRunIds: number[] = [];
const allWorkspaceIds: string[] = [];
const tempSpecPaths: string[] = [];
const activeWorkers = new Set<ChildProcess>();

// ── Mini HTTP server (called by ten-second-mock-engine) ───────────────────────

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

// ── Fixture helpers ───────────────────────────────────────────────────────────

async function createTestFixtures(): Promise<{
  workspaceId: string;
  workspacePath: string;
  specPath: string;
}> {
  const workspaceId = `zd-ws-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-zd-'));

  await pool.query(
    `INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3)`,
    [workspaceId, 'Zero-Downtime Test Workspace', workspacePath],
  );
  allWorkspaceIds.push(workspaceId);

  const specJson = {
    title: 'zero-downtime-test-spec',
    userStories: [
      {
        id: 'US-001',
        title: 'Zero downtime story',
        description: 'Integration test story for rolling deploy',
        acceptanceCriteria: ['It works'],
        dependsOn: [],
        passes: false,
      },
    ],
    model: 'claude-sonnet-4-5-20250929',
    generatedAt: new Date().toISOString(),
  };

  const specDir = path.join(workspacePath, 'forge', 'specs', 'approved');
  fs.mkdirSync(specDir, { recursive: true });
  const absSpecPath = path.join(specDir, 'zero-downtime-test-spec.json');
  fs.writeFileSync(absSpecPath, JSON.stringify(specJson, null, 2));
  tempSpecPaths.push(absSpecPath);

  return {
    workspaceId,
    workspacePath,
    specPath: 'forge/specs/approved/zero-downtime-test-spec.json',
  };
}

async function insertAndEnqueueRun(
  workspaceId: string,
  workspacePath: string,
  specPath: string,
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO pipeline_runs
       (spec_path, workspace_id, status, trigger_type, parallelism, agent, agent_type, agent_model, queued_at)
     VALUES ($1, $2, 'queued', 'manual', 1, 'claude', 'claude', NULL, NOW())
     RETURNING id`,
    [specPath, workspaceId],
  );
  const runId = Number(rows[0].id);
  allRunIds.push(runId);

  // Enqueue via the sender boss instance (pollingIntervalSeconds=60 so it won't
  // pick up jobs itself — only the rolling-worker child processes do that)
  await senderBoss.send('pipeline:run', {
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

  return runId;
}

// ── Spawn a rolling-worker.ts subprocess ──────────────────────────────────────

function spawnWorker(): { proc: ChildProcess; logs: string[] } {
  const logs: string[] = [];
  const proc = spawn(
    TSX_BIN,
    [ROLLING_WORKER_PATH],
    {
      env: {
        DATABASE_URL: DB_URL,
        PGBOSS_TEST_SCHEMA: BOSS_SCHEMA,
        WORKER_PORT: String(serverPort),
        PATH: process.env.PATH ?? '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const capture = (data: Buffer): void => {
    const text = data.toString();
    logs.push(text);
    // Uncomment for debugging:
    // process.stderr.write(`[worker] ${text}`);
  };

  proc.stdout?.on('data', capture);
  proc.stderr?.on('data', capture);
  activeWorkers.add(proc);
  proc.once('exit', () => activeWorkers.delete(proc));

  return { proc, logs };
}

/** Wait until the rolling-worker subprocess logs a "ready" line. */
async function waitForWorkerReady(logs: string[], maxMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (logs.some((l) => l.includes('ready worker_id='))) return true;
    await sleep(200);
  }
  return false;
}

// ── Suite setup / teardown ────────────────────────────────────────────────────

beforeAll(async () => {
  pool = new Pool({ connectionString: DB_URL, max: 5 });
  await assertConnectedTestDatabase(pool, DB_URL);

  // Run migrations to ensure schema is current
  const { runPgMigrations } = await import('../db/pg-index');
  await runPgMigrations(pool);

  // Start sender boss — used only to enqueue jobs, not to work on them
  senderBoss = new PgBoss({
    connectionString: DB_URL,
    schema: BOSS_SCHEMA,
    pollingIntervalSeconds: 60,
  });
  senderBoss.on('error', () => { /* suppress */ });
  await senderBoss.start();
  await senderBoss.createQueue('pipeline:run');

  // Start mini HTTP server for WAL events + story results
  app = buildMiniServer(pool);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      serverPort = (server.address() as { port: number }).port;
      resolve();
    });
  });
}, 30_000);

afterAll(async () => {
  for (const worker of [...activeWorkers]) {
    try { worker.kill('SIGTERM'); } catch { /* ignore */ }
  }
  await sleep(500);
  for (const worker of [...activeWorkers]) {
    try { worker.kill('SIGKILL'); } catch { /* ignore */ }
  }

  // Stop sender boss
  try { if (senderBoss) await senderBoss.stop({ timeout: 5_000 }); } catch { /* ignore */ }

  // Clean up test data in FK-safe order
  if (allRunIds.length > 0) {
    await pool.query('DELETE FROM run_output_chunks WHERE run_id = ANY($1)', [allRunIds]);
    await pool.query('DELETE FROM story_results WHERE run_id = ANY($1)', [allRunIds]);
    await pool.query(
      `DELETE FROM wal_events WHERE (payload->>'run_id')::int = ANY($1)`,
      [allRunIds],
    );
    await pool.query('DELETE FROM pipeline_runs WHERE id = ANY($1)', [allRunIds]);
  }
  if (allWorkspaceIds.length > 0) {
    await pool.query('DELETE FROM workspaces WHERE id = ANY($1)', [allWorkspaceIds]);
  }
  for (const p of tempSpecPaths) {
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }

  if (server?.listening) {
    await new Promise<void>((res) => server.close(() => res()));
  }
  if (pool) await pool.end();
}, 20_000);

// ── Test ──────────────────────────────────────────────────────────────────────

describe('pg-boss rolling deploy — zero-downtime worker handoff', () => {
  it('should handle graceful worker drain and handoff without losing or duplicating jobs', async () => {
    // ── Phase 1: Create shared workspace + spec ───────────────────────────────
    const { workspaceId, workspacePath, specPath } = await createTestFixtures();

    // ── Phase 2: Enqueue 3 runs BEFORE starting worker-v1 ───────────────────
    // All 3 must be in the pg-boss queue before the first worker poll so that
    // batchSize:5 can fetch all 3 in a single poll cycle → all 3 in-flight
    // simultaneously → valid drain test when SIGTERM is sent.
    const run1 = await insertAndEnqueueRun(workspaceId, workspacePath, specPath);
    const run2 = await insertAndEnqueueRun(workspaceId, workspacePath, specPath);
    const run3 = await insertAndEnqueueRun(workspaceId, workspacePath, specPath);
    const firstThreeRunIds = [run1, run2, run3];

    // ── Phase 3: Start worker-v1 (all 3 jobs already in queue) ───────────────
    const { proc: workerV1, logs: v1Logs } = spawnWorker();

    // Wait for worker-v1 to be ready before waiting for jobs to run
    const v1Ready = await waitForWorkerReady(v1Logs, 15_000);
    expect(v1Ready).toBe(true);

    // Wait until all 3 runs are 'running' (worker-v1 picked them up in one batch)
    // pg-boss polls every 1s; batchSize:5 should grab all 3 in the first poll.
    // Give 15s for pg-boss startup + first poll + 3x DB updates.
    const allRunning = await waitFor(async () => {
      const { rows } = await pool.query<{ status: string; id: number }>(
        `SELECT id, status FROM pipeline_runs WHERE id = ANY($1)`,
        [firstThreeRunIds],
      );
      return rows.length === 3 && rows.every((r) => r.status === 'running');
    }, 15_000);

    if (!allRunning) {
      const statuses = await pool.query<{ id: number; status: string }>(
        `SELECT id, status FROM pipeline_runs WHERE id = ANY($1) ORDER BY id`,
        [firstThreeRunIds],
      );
      const jobs = await pool.query<{ state: string; count: string }>(
        `SELECT state::text, COUNT(*)::text AS count
           FROM ${BOSS_SCHEMA}.job
          WHERE name = 'pipeline:run' GROUP BY state ORDER BY state`,
      );
      throw new Error(`worker-v1 did not claim all jobs; runs=${JSON.stringify(statuses.rows)} jobs=${JSON.stringify(jobs.rows)} logs=${v1Logs.join('')}`);
    }

    // ── Phase 4: SIGTERM worker-v1 + simultaneously start worker-v2 ──────────
    workerV1.kill('SIGTERM');

    // Start worker-v2 immediately (this is the rolling deploy moment)
    const { proc: workerV2, logs: v2Logs } = spawnWorker();

    // Wait for worker-v1 to log its drain message before enqueueing new jobs.
    // This confirms SIGTERM was processed: v1 has stopped accepting new work.
    // Without this wait, new jobs can be enqueued into the DB queue and picked
    // up by v1 in its next poll cycle before the SIGTERM signal is delivered.
    const v1DrainLogged = await (async (): Promise<boolean> => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if (v1Logs.join('').match(/\[worker\] draining, waiting for \d+ in-flight jobs\.\.\./)) {
          return true;
        }
        await sleep(100);
      }
      return false;
    })();
    expect(v1DrainLogged).toBe(true);

    // Wait for worker-v2 to be ready
    const v2Ready = await waitForWorkerReady(v2Logs, 15_000);
    expect(v2Ready).toBe(true);

    // ── Phase 5: Trigger 2 more runs (worker-v2 should pick these up) ─────────
    // v1 has confirmed it received SIGTERM (drain message logged) so it will
    // not accept new jobs. v2 is ready so it will pick these up.
    const run4 = await insertAndEnqueueRun(workspaceId, workspacePath, specPath);
    const run5 = await insertAndEnqueueRun(workspaceId, workspacePath, specPath);
    const lastTwoRunIds = [run4, run5];
    const allFiveRunIds = [...firstThreeRunIds, ...lastTwoRunIds];

    // ── Phase 6: Wait for all 5 runs to complete (status='done') ─────────────
    // Budget: 10s engine + drain overhead + pg-boss polling (2s) + buffer = 60s
    const allDone = await waitFor(async () => {
      const { rows } = await pool.query<{ status: string }>(
        `SELECT status FROM pipeline_runs WHERE id = ANY($1)`,
        [allFiveRunIds],
      );
      return rows.length === 5 && rows.every((r) => r.status === 'done');
    }, 60_000);

    // Ensure worker-v2 exits cleanly after all work is done
    workerV2.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      workerV2.on('exit', () => resolve());
      // Safety timeout — don't block forever
      setTimeout(resolve, 5_000);
    });

    // Wait for worker-v1 to exit too (it was draining)
    await new Promise<void>((resolve) => {
      if (workerV1.exitCode !== null) {
        resolve();
        return;
      }
      workerV1.on('exit', () => resolve());
      setTimeout(resolve, 5_000);
    });

    // ── Phase 7: Assertions ───────────────────────────────────────────────────

    // A. All 5 runs must be done
    expect(allDone).toBe(true);

    const { rows: finalStatuses } = await pool.query<{ id: number; status: string }>(
      `SELECT id, status FROM pipeline_runs WHERE id = ANY($1) ORDER BY id`,
      [allFiveRunIds],
    );
    expect(finalStatuses).toHaveLength(5);
    for (const row of finalStatuses) {
      expect(row.status).toBe('done');
    }

    // B. worker-v1 logged the drain message before stopping
    const v1LogsJoined = v1Logs.join('');
    expect(v1LogsJoined).toMatch(/\[worker\] draining, waiting for \d+ in-flight jobs\.\.\./);

    // C. No duplicate execution — each run has exactly one worker_id set
    const { rows: workerAssignments } = await pool.query<{
      id: number;
      worker_id: string | null;
    }>(
      `SELECT id, worker_id FROM pipeline_runs WHERE id = ANY($1) ORDER BY id`,
      [allFiveRunIds],
    );

    for (const row of workerAssignments) {
      expect(row.worker_id).not.toBeNull();
    }

    // D. No duplicate story_results rows per run
    const { rows: resultRows } = await pool.query<{
      run_id: number;
      story_id: string;
      cnt: string;
    }>(
      `SELECT run_id, story_id, COUNT(*) AS cnt
       FROM story_results
       WHERE run_id = ANY($1)
       GROUP BY run_id, story_id
       HAVING COUNT(*) > 1`,
      [allFiveRunIds],
    );
    expect(resultRows).toHaveLength(0); // no duplicates

    // E. Runs 1-3 and runs 4-5 must have been handled by different workers
    //    (disjoint worker_id sets — proves SIGTERM stopped v1 from accepting new jobs)
    const v1WorkerIds = new Set(
      workerAssignments
        .filter((r) => firstThreeRunIds.includes(r.id))
        .map((r) => r.worker_id),
    );
    const v2WorkerIds = new Set(
      workerAssignments
        .filter((r) => lastTwoRunIds.includes(r.id))
        .map((r) => r.worker_id),
    );

    // v1 worker_id must not appear in v2's set — confirms handoff boundary
    for (const id of v2WorkerIds) {
      expect(v1WorkerIds.has(id)).toBe(false);
    }

    // F. run_output_chunks sequences contiguous for all 5 runs
    //    Sequences are 1-based. Contiguity: max_seq = chunk_count (no gaps).
    const { rows: chunkStats } = await pool.query<{
      run_id: number;
      max_seq: number;
      chunk_count: string;
    }>(
      `SELECT run_id, MAX(sequence) AS max_seq, COUNT(*) AS chunk_count
       FROM run_output_chunks
       WHERE run_id = ANY($1)
       GROUP BY run_id`,
      [allFiveRunIds],
    );

    // All 5 runs must have at least 1 chunk
    expect(chunkStats).toHaveLength(5);

    for (const stat of chunkStats) {
      const chunkCount = parseInt(stat.chunk_count, 10);
      // Sequences start at 1 and increment by 1 — no gaps means max_seq = chunk_count
      expect(stat.max_seq).toBe(chunkCount);
      expect(chunkCount).toBeGreaterThan(0);
    }
  });
});
