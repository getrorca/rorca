/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * PG-016: Cancel integration tests — run cancellation via pg-boss.
 *
 * Test A — Cancel queued run:
 *   1. Stop the worker (boss.stop()) so jobs stay in 'queued' state.
 *   2. Trigger a run via the mini-server trigger endpoint (inserts run row + pg-boss job
 *      with an auto-generated UUID and the bigint run ID in its data payload).
 *   3. Poll pipeline_runs.status until 'queued' is confirmed.
 *   4. Call POST /api/pipeline/runs/:runId/cancel on the mini-server.
 *   5. Assert pipeline_runs.status = 'cancelled' with finished_at set.
 *   6. Assert pg-boss job is absent or in cancelled/failed state.
 *   7. Restart worker (new boss instance + boss.work()); wait one poll interval.
 *   8. Assert worker did NOT execute the cancelled job (status stays 'cancelled').
 *
 * Test B — Cancel running run:
 *   1. Trigger a run backed by cancel-mock-engine.ts (60 s sleep, SIGTERM → exit 143).
 *   2. Poll pipeline_runs.status until 'running'.
 *   3. Record timestamp, call POST /api/pipeline/runs/:runId/cancel.
 *   4. Assert SIGTERM sentinel line appears in stdout within 2 s of cancel call.
 *   5. Assert process exits within 12 s (10 s SIGTERM → SIGKILL window + 2 s buffer).
 *   6. Assert pipeline_runs.status = 'cancelled', finished_at set.
 *   7. Assert WAL event 'run_cancelled' present in wal_events.
 *   8. Assert run_output_chunks count > 0 and sequence numbers form a contiguous range.
 *
 * Uses:
 *   - Real PostgreSQL (TEST_DATABASE_URL / DATABASE_URL)
 *   - In-process pg-boss (500 ms polling for the 2-second signal SLA)
 *   - cancel-mock-engine.ts fixture for Test B
 *   - Mini Express server with trigger + cancel endpoints (no import of production server)
 *
 * NOTE on job IDs:
 *   pg-boss v10 requires job IDs to be valid UUIDs (AGENTS.md gotcha). Production and
 *   this harness omit the `id` option so pg-boss generates a UUID, while the bigint
 *   Rorca run ID remains in the job data payload for correlation and cancellation.
 *
 * NOTE on WAL column:
 *   wal_events uses `ts` as the timestamp column, NOT `created_at`. All queries use `ts`.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as http from 'http';
import { spawn, type ChildProcess } from 'child_process';
import { Pool } from 'pg';
import type PgBoss from 'pg-boss';
import express, { type Express } from 'express';
import { assertConnectedTestDatabase, resolveTestDatabaseUrl } from '../lib/test-db-safety';
import { pgBossTestSchema } from './helpers/pg-boss-test-schema';

// This integration suite must bypass the repository's default no-op manual mock.
const RealPgBoss = jest.requireActual<typeof import('pg-boss')>('pg-boss');

// ── DB URL ─────────────────────────────────────────────────────────────────────

const DB_URL = resolveTestDatabaseUrl();

// PgBoss alone owns this suite's schema; this isolates cancellation evidence
// from legacy unit fixtures that created a partial `pgboss` schema.
const BOSS_SCHEMA = pgBossTestSchema('cancel');

// ── Paths ──────────────────────────────────────────────────────────────────────

const CANCEL_ENGINE_PATH = path.join(__dirname, 'fixtures', 'cancel-mock-engine.ts');
const TSX_BIN = path.join(__dirname, '..', '..', 'node_modules', '.bin', 'tsx');
const CHUNK_SIZE = 4 * 1024;

// ── Timing constants ───────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 200;
const MAX_WAIT_MS = 15_000;
const SIGTERM_ASSERT_MS = 2_000;   // SIGTERM must be received within 2 s
const EXIT_ASSERT_MS = 12_000;     // Process must exit within 12 s (SIGKILL after 10 s + 2 s buffer)

// ── Jest timeout ───────────────────────────────────────────────────────────────

jest.setTimeout(60_000);

// ── Helpers ────────────────────────────────────────────────────────────────────

async function waitFor(
  predicate: () => Promise<boolean>,
  maxMs = MAX_WAIT_MS,
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
        // ignore transient DB errors during polling
      }
      if (Date.now() >= deadline) {
        clearInterval(timer);
        resolve(false);
      }
    }, intervalMs);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Suite state ────────────────────────────────────────────────────────────────

let pool: Pool;
// Primary boss used for job enqueueing (Test A and B)
let boss: PgBoss;
// Secondary boss used in Test A after restart to verify non-execution
let bossResume: PgBoss | null = null;
let runningCancelHandler: ((jobs: PgBoss.Job<Record<string, unknown>>[]) => Promise<void>) | null = null;
let app: Express;
let server: http.Server;
let serverPort: number;

// Tracking for cleanup
const testRunIds: number[] = [];
const testWorkspaceIds: string[] = [];
const tempSpecPaths: string[] = [];
const activeChildren: ChildProcess[] = [];

// Sentinel files created by cancel-mock-engine on SIGTERM — cleaned up in afterAll
const tempSentinelPaths: string[] = [];

// ── Suite setup ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // 1. Connect pool
  pool = new Pool({ connectionString: DB_URL, max: 5 });
  await assertConnectedTestDatabase(pool, DB_URL);

  // 2. Run migrations
  const { runPgMigrations } = await import('../db/pg-index');
  await runPgMigrations(pool);

  // 3. Start mini Express server
  app = buildMiniServer();
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      serverPort = (server.address() as { port: number }).port;
      resolve();
    });
  });

  // 4. Start pg-boss with fast polling
  boss = new RealPgBoss({
    connectionString: DB_URL,
    schema: BOSS_SCHEMA,
    pollingIntervalSeconds: 0.5,
  });
  boss.on('error', () => { /* suppress noise in test output */ });
  await boss.start();

  // 5. Create required queues (pg-boss v10 requires explicit queue creation)
  await boss.createQueue('pipeline:run');
  await boss.createQueue('pipeline:cancel');
}, 30_000);

afterAll(async () => {
  // Kill any dangling child processes
  for (const child of activeChildren) {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
  }

  // Stop boss instances
  try { await boss.stop({ timeout: 5_000 }); } catch { /* ignore */ }
  try { if (bossResume) await bossResume.stop({ timeout: 5_000 }); } catch { /* ignore */ }

  // Close HTTP server
  await new Promise<void>((res) => server.close(() => res()));

  // Clean up DB data in FK-safe order
  if (testRunIds.length > 0) {
    const ids = [...testRunIds];
    await pool.query('DELETE FROM run_output_chunks WHERE run_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM story_results WHERE run_id = ANY($1)', [ids]);
    await pool.query(
      "DELETE FROM wal_events WHERE (payload->>'run_id')::bigint = ANY($1::bigint[])",
      [ids],
    );
    await pool.query('DELETE FROM pipeline_runs WHERE id = ANY($1)', [ids]);
  }
  if (testWorkspaceIds.length > 0) {
    await pool.query('DELETE FROM workspaces WHERE id = ANY($1)', [testWorkspaceIds]);
  }
  for (const p of tempSpecPaths.splice(0)) {
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }
  for (const p of tempSentinelPaths.splice(0)) {
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }

  await pool.end();
}, 15_000);

afterEach(async () => {
  // Noop — cleanup deferred to afterAll to keep accumulated run IDs accessible
  // for verification across test assertions.
});

// ── Fixtures ───────────────────────────────────────────────────────────────────

async function createTestFixtures(tag = ''): Promise<{
  workspaceId: string;
  workspacePath: string;
  specPath: string;
  absSpecPath: string;
}> {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}${tag ? `-${tag}` : ''}`;
  const workspaceId = `test-cancel-${suffix}`;
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-cancel-'));

  await pool.query(
    'INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3)',
    [workspaceId, `Cancel Test WS ${suffix}`, workspacePath],
  );
  testWorkspaceIds.push(workspaceId);

  const specJson = {
    title: `cancel-test-spec-${suffix}`,
    userStories: [{
      id: 'US-001',
      title: 'Cancel test story',
      description: 'Integration test for run cancellation',
      acceptanceCriteria: ['It works'],
      dependsOn: [],
      passes: false,
    }],
    model: 'claude-sonnet-4-5-20250929',
    generatedAt: new Date().toISOString(),
  };

  const specDir = path.join(workspacePath, 'forge', 'specs', 'approved');
  fs.mkdirSync(specDir, { recursive: true });
  const specFilename = `cancel-test-spec-${suffix}.json`;
  const absSpecPath = path.join(specDir, specFilename);
  fs.writeFileSync(absSpecPath, JSON.stringify(specJson, null, 2));
  tempSpecPaths.push(absSpecPath);

  const specPath = `forge/specs/approved/${specFilename}`;

  return { workspaceId, workspacePath, specPath, absSpecPath };
}

// ── Mini Express server ────────────────────────────────────────────────────────

/**
 * Mini server exposing:
 *   POST /api/wal                          — WAL event insertion (for mock engine)
 *   POST /api/pipeline/story-result        — story result insertion (for mock engine)
 *   POST /api/pipeline/trigger             — insert run + enqueue pg-boss job
 *   POST /api/pipeline/runs/:runId/cancel  — cancel endpoint (queued + running paths)
 *
 * The cancel endpoint replicates the production pipeline.ts logic:
 *   - Queued: boss.cancel('pipeline:run', String(runId)) + DB update + WAL event
 *   - Running: boss.send('pipeline:cancel', { runId }) + return 'cancelling'
 */
function buildMiniServer(): Express {
  const miniApp = express();
  miniApp.use(express.json());

  // POST /api/wal
  miniApp.post('/api/wal', async (req, res) => {
    try {
      const { event_type, workspace_id, spec_id, story_id, payload } = req.body as {
        event_type: string;
        workspace_id?: string;
        spec_id?: string;
        story_id?: string;
        payload?: Record<string, unknown>;
      };
      await pool.query(
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

  // POST /api/pipeline/story-result
  miniApp.post('/api/pipeline/story-result', async (req, res) => {
    try {
      const { runId, storyId, status } = req.body as {
        runId: number;
        storyId: string;
        status: string;
      };
      await pool.query(
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

  // POST /api/pipeline/trigger — insert run + enqueue pg-boss job (auto-UUID)
  miniApp.post('/api/pipeline/trigger', async (req, res) => {
    try {
      const { workspaceId, specPath, workspacePath } = req.body as {
        workspaceId: string;
        specPath: string;
        workspacePath: string;
      };
      if (!workspaceId || !specPath || !workspacePath) {
        res.status(400).json({ error: 'workspaceId, specPath, workspacePath are required' });
        return;
      }

      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO pipeline_runs
           (spec_path, workspace_id, status, trigger_type, parallelism, agent, agent_type, agent_model, queued_at)
         VALUES ($1, $2, 'queued', 'manual', 1, 'claude', 'claude', NULL, NOW())
         RETURNING id`,
        [specPath, workspaceId],
      );
      // pg returns BIGINT as a string by default; normalize before using the
      // value as an in-memory child-map key or pg-boss payload correlation ID.
      const runId = Number(rows[0].id);
      testRunIds.push(runId);

      // Enqueue WITHOUT a custom `id` — pg-boss auto-generates a valid UUID.
      // The bigint run ID remains in data so cancellation can correlate the job.
      await boss.send('pipeline:run', {
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

      res.json({ ok: true, runId, queued: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/pipeline/runs/:runId/cancel — cancel endpoint
  miniApp.post('/api/pipeline/runs/:runId/cancel', async (req, res) => {
    try {
      const runId = parseInt(String(req.params.runId), 10);
      if (isNaN(runId)) {
        res.status(400).json({ error: 'Invalid runId' });
        return;
      }

      const { rows: runRows } = await pool.query<{ id: number; status: string; workspace_id: string }>(
        'SELECT id, status, workspace_id FROM pipeline_runs WHERE id = $1',
        [runId],
      );
      if (runRows.length === 0) {
        res.status(404).json({ error: 'Run not found' });
        return;
      }
      const run = runRows[0];

      if (run.status !== 'queued' && run.status !== 'running' && run.status !== 'paused') {
        res.status(409).json({ error: `Run is already ${run.status} and cannot be cancelled` });
        return;
      }

      if (run.status === 'queued') {
        // Find the pg-boss job UUID for this run by querying pgboss.job.
        // We cannot use String(runId) as the job ID because pg-boss v10 requires
        // a valid UUID — passing an integer string causes a PostgreSQL cast error.
        // Instead we look up the actual UUID by data->>'runId'.
        const { rows: jobRows } = await pool.query<{ id: string }>(
          `SELECT id FROM ${BOSS_SCHEMA}.job WHERE name = 'pipeline:run' AND (data->>'runId')::bigint = $1 LIMIT 1`,
          [runId],
        );
        if (jobRows.length > 0) {
          await boss.cancel('pipeline:run', jobRows[0].id);
        }

        // Re-read status: worker may have picked up the job between check and cancel
        const { rows: refreshed } = await pool.query<{ status: string }>(
          'SELECT status FROM pipeline_runs WHERE id = $1',
          [runId],
        );
        if (refreshed.length > 0 && (refreshed[0].status === 'running' || refreshed[0].status === 'paused')) {
          // Worker picked it up — send cancel signal
          await boss.send('pipeline:cancel', { runId });
          res.json({ ok: true, runId, status: 'cancelling' });
          return;
        }

        // Mark as cancelled
        await pool.query(
          `UPDATE pipeline_runs SET status = 'cancelled', finished_at = NOW(), queue_position = NULL WHERE id = $1`,
          [runId],
        );

        // Emit WAL event
        await pool.query(
          `INSERT INTO wal_events (event_type, workspace_id, payload)
           VALUES ('run_cancelled', $1, $2)`,
          [run.workspace_id, JSON.stringify({ run_id: runId, cancelledAt: new Date().toISOString() })],
        );

        res.json({ ok: true, runId, status: 'cancelled' });
        return;
      }

      // Running/paused path — persist the control job, then deterministically
      // fetch it through real pg-boss for this in-process integration harness.
      await boss.send('pipeline:cancel', { runId });
      if (runningCancelHandler) {
        const jobs = await boss.fetch<Record<string, unknown>>('pipeline:cancel');
        if (jobs.length > 0) {
          await runningCancelHandler(jobs);
          await boss.complete('pipeline:cancel', jobs.map((job) => job.id));
        }
      }
      res.json({ ok: true, runId, status: 'cancelling' });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return miniApp;
}

// ── HTTP helpers ───────────────────────────────────────────────────────────────

async function httpPost(
  path_: string,
  body: Record<string, unknown>,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: serverPort,
        path: path_,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve({ statusCode: res.statusCode ?? 0, body: JSON.parse(data) as Record<string, unknown> });
          } catch {
            resolve({ statusCode: res.statusCode ?? 0, body: {} });
          }
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function triggerRun(
  workspaceId: string,
  workspacePath: string,
  specPath: string,
): Promise<number> {
  const response = await httpPost('/api/pipeline/trigger', {
    workspaceId,
    specPath,
    workspacePath,
  });
  if (response.statusCode !== 200) {
    throw new Error(`Trigger failed: ${JSON.stringify(response.body)}`);
  }
  return response.body.runId as number;
}

async function cancelRun(runId: number): Promise<Record<string, unknown>> {
  const response = await httpPost(`/api/pipeline/runs/${runId}/cancel`, {});
  return response.body;
}

// ── In-process worker (Test B only) ────────────────────────────────────────────

/**
 * Worker handler that spawns cancel-mock-engine.ts (60 s sleep, SIGTERM-aware).
 * Tracks the child process in childMap so the cancel handler can send SIGTERM.
 * Also handles the pipeline:cancel job by sending SIGTERM + scheduling SIGKILL.
 *
 * sentinelMap: maps runId → sentinel file path. The cancel-mock-engine writes
 * this file when it receives SIGTERM. The test polls for file existence to
 * confirm SIGTERM delivery independently of stdout stream state.
 */
function buildCancelWorkerHandlers(
  childMap: Map<number, ChildProcess>,
  sentinelMap: Map<number, string>,
): {
  handleRun: (jobs: PgBoss.Job<Record<string, unknown>>[]) => Promise<void>;
  handleCancel: (jobs: PgBoss.Job<Record<string, unknown>>[]) => Promise<void>;
} {
  // Tracks which runs are being intentionally cancelled (to emit correct WAL event)
  const cancellingRuns = new Set<number>();

  const handleRun = async (jobs: PgBoss.Job<Record<string, unknown>>[]): Promise<void> => {
    for (const job of jobs) {
      const data = job.data as { runId: number; specPath: string; workspacePath: string };
      const { runId, specPath, workspacePath } = data;
      if (!runId || !specPath || !workspacePath) continue;

      // Look up workspace_id
      const { rows: runRows } = await pool.query<{ workspace_id: string }>(
        'SELECT workspace_id FROM pipeline_runs WHERE id = $1',
        [runId],
      );
      if (runRows.length === 0) return;
      const workspaceId = runRows[0].workspace_id;

      // Mark as running
      await pool.query(
        "UPDATE pipeline_runs SET status = 'running', started_at = NOW() WHERE id = $1",
        [runId],
      );

      // Emit run_started WAL event
      await pool.query(
        `INSERT INTO wal_events (event_type, workspace_id, payload)
         VALUES ('run_started', $1, $2)`,
        [workspaceId, JSON.stringify({ run_id: runId, spec_path: specPath })],
      );

      // Create a sentinel file path for this run. The engine writes it on SIGTERM.
      const sentinelPath = path.join(os.tmpdir(), `rorca-cancel-sentinel-${runId}-${Date.now()}.txt`);
      sentinelMap.set(runId, sentinelPath);
      tempSentinelPaths.push(sentinelPath);

      // Spawn cancel-mock-engine (60 s sleep, SIGTERM handler, sentinel file)
      const child = spawn(
        TSX_BIN,
        [
          CANCEL_ENGINE_PATH,
          '--run-id', String(runId),
          '--sentinel', sentinelPath,
        ],
        {
          cwd: workspacePath,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, RORCA_PROCESS_ROLE: 'engine' },
        },
      );

      // Do not expose the child as cancellable until the fixture has installed
      // its SIGTERM handler and emitted the startup line. Otherwise a fast
      // cancel can terminate the tsx bootstrap process before the fixture runs.
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 3_000);
        child.stdout?.once('data', () => {
          clearTimeout(timeout);
          resolve();
        });
        child.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      activeChildren.push(child);
      childMap.set(runId, child);

      if (child.pid) {
        await pool.query('UPDATE pipeline_runs SET pid = $1 WHERE id = $2', [child.pid, runId]);
      }

      // Stream stdout/stderr to run_output_chunks
      const seqRef = { value: 1 };
      let pending = Buffer.alloc(0);

      const flush = async (): Promise<void> => {
        if (pending.length === 0) return;
        await writeChunk(runId, seqRef, pending);
        pending = Buffer.alloc(0);
      };

      const handleData = async (chunk: Buffer): Promise<void> => {
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= CHUNK_SIZE) {
          const slice = pending.slice(0, CHUNK_SIZE);
          await writeChunk(runId, seqRef, slice);
          pending = pending.slice(CHUNK_SIZE);
        }
      };

      child.stdout?.on('data', (d: Buffer) => { void handleData(d); });
      child.stderr?.on('data', (d: Buffer) => { void handleData(d); });

      await new Promise<void>((resolve) => {
        child.on('exit', async (code) => {
          await flush();
          childMap.delete(runId);
          const idx = activeChildren.indexOf(child);
          if (idx !== -1) activeChildren.splice(idx, 1);

          const wasCancelled = cancellingRuns.delete(runId);
          const status = wasCancelled ? 'cancelled' : (code === 0 ? 'done' : 'failed');

          await pool.query(
            'UPDATE pipeline_runs SET status = $1, finished_at = NOW() WHERE id = $2',
            [status, runId],
          );

          if (wasCancelled) {
            await pool.query(
              `INSERT INTO wal_events (event_type, workspace_id, payload)
               VALUES ('run_cancelled', $1, $2)`,
              [workspaceId, JSON.stringify({ run_id: runId, cancelledAt: new Date().toISOString() })],
            );
          } else {
            await pool.query(
              `INSERT INTO wal_events (event_type, workspace_id, payload)
               VALUES ('run_finished', $1, $2)`,
              [workspaceId, JSON.stringify({ run_id: runId, status, exit_code: code })],
            );
          }

          resolve();
        });

        child.on('error', async (err) => {
          await flush();
          childMap.delete(runId);
          const idx = activeChildren.indexOf(child);
          if (idx !== -1) activeChildren.splice(idx, 1);
          cancellingRuns.delete(runId);
          await pool.query(
            "UPDATE pipeline_runs SET status = 'failed', finished_at = NOW() WHERE id = $1",
            [runId],
          );
          resolve();
        });
      });
    }
  };

  const handleCancel = async (jobs: PgBoss.Job<Record<string, unknown>>[]): Promise<void> => {
    for (const job of jobs) {
      const data = job.data as { runId: number };
      const { runId } = data;
      if (!runId) continue;

      const child = childMap.get(runId);
      if (!child) continue;

      cancellingRuns.add(runId);
      child.kill('SIGTERM');

      // Schedule SIGKILL after 10 s if process is still alive
      const killTimer = setTimeout(() => {
        if (childMap.has(runId)) {
          child.kill('SIGKILL');
        }
      }, 10_000);

      // Clear the timer if the process exits before SIGKILL fires
      child.once('exit', () => {
        clearTimeout(killTimer);
      });
    }
  };

  return { handleRun, handleCancel };
}

async function writeChunk(
  runId: number,
  seqRef: { value: number },
  data: Buffer,
): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const slice = data.slice(offset, offset + CHUNK_SIZE);
    await pool.query(
      `INSERT INTO run_output_chunks (run_id, chunk, sequence)
       VALUES ($1, $2, $3)
       ON CONFLICT (run_id, sequence) DO NOTHING`,
      [runId, slice, seqRef.value],
    );
    seqRef.value += 1;
    offset += CHUNK_SIZE;
  }
}

// ── Test A — Cancel queued run ─────────────────────────────────────────────────

describe('Test A — cancel queued run (worker stopped)', () => {
  let testRunId: number;
  let testWorkspaceId: string;
  let testWorkspacePath: string;
  let testSpecPath: string;

  beforeAll(async () => {
    // Stop the boss before this test so jobs stay in 'queued' state.
    // We stop the primary boss (which has no workers registered at suite start)
    // and replace it with a fresh instance for the resume step.
    // Note: boss was started in suite beforeAll with NO boss.work() calls,
    // so no workers are active — jobs will stay queued naturally.
    // We explicitly stop it here to simulate "worker offline" and start a fresh
    // boss later for the "worker resumed" assertion.
    await boss.stop({ timeout: 3_000 });

    // Start a new boss instance for enqueueing (no workers registered)
    boss = new RealPgBoss({
      connectionString: DB_URL,
      schema: BOSS_SCHEMA,
      pollingIntervalSeconds: 0.5,
    });
    boss.on('error', () => { /* suppress */ });
    await boss.start();
    await boss.createQueue('pipeline:run');
    await boss.createQueue('pipeline:cancel');
  }, 15_000);

  it('should cancel a queued run: job removed, status=cancelled, worker does not execute', async () => {
    const fixtures = await createTestFixtures('a');
    testWorkspaceId = fixtures.workspaceId;
    testWorkspacePath = fixtures.workspacePath;
    testSpecPath = fixtures.specPath;

    // 1. Trigger run — job goes to pg-boss but no worker picks it up
    testRunId = await triggerRun(testWorkspaceId, testWorkspacePath, testSpecPath);

    // 2. Confirm status is 'queued' (with timeout poll since the INSERT is immediate)
    const isQueued = await waitFor(async () => {
      const { rows } = await pool.query<{ status: string }>(
        'SELECT status FROM pipeline_runs WHERE id = $1',
        [testRunId],
      );
      return rows.length > 0 && rows[0].status === 'queued';
    }, 5_000);
    expect(isQueued).toBe(true);

    // Also verify pg-boss job exists before cancellation
    const { rows: jobRowsBefore } = await pool.query<{ id: string; state: string }>(
      `SELECT id, state FROM ${BOSS_SCHEMA}.job WHERE name = 'pipeline:run' AND (data->>'runId')::bigint = $1`,
      [testRunId],
    );
    expect(jobRowsBefore.length).toBeGreaterThanOrEqual(1);

    // 3. Call cancel endpoint
    const cancelResponse = await cancelRun(testRunId);
    expect(cancelResponse.ok).toBe(true);
    expect(cancelResponse.status).toBe('cancelled');

    // 4. Assert pipeline_runs.status = 'cancelled' with finished_at set
    const { rows: runRows } = await pool.query<{
      status: string;
      finished_at: Date | null;
    }>(
      'SELECT status, finished_at FROM pipeline_runs WHERE id = $1',
      [testRunId],
    );
    expect(runRows).toHaveLength(1);
    expect(runRows[0].status).toBe('cancelled');
    expect(runRows[0].finished_at).not.toBeNull();

    // 5. Assert pg-boss job is absent or in cancelled/failed state
    // Give pg-boss a moment to propagate the cancellation state
    const jobRemoved = await waitFor(async () => {
      const { rows: jobRows } = await pool.query<{ id: string; state: string }>(
        `SELECT id, state FROM ${BOSS_SCHEMA}.job WHERE name = 'pipeline:run' AND (data->>'runId')::bigint = $1`,
        [testRunId],
      );
      if (jobRows.length === 0) return true; // Job was removed
      // Job still exists but in a terminal state
      return jobRows.every((r) => r.state === 'cancelled' || r.state === 'failed');
    }, 5_000);
    expect(jobRemoved).toBe(true);

    // 6. Start a fresh worker and verify the cancelled job is NOT executed
    // (status remains 'cancelled', not 'running' or 'done')
    bossResume = new RealPgBoss({
      connectionString: DB_URL,
      schema: BOSS_SCHEMA,
      pollingIntervalSeconds: 0.5,
    });
    bossResume.on('error', () => { /* suppress */ });
    await bossResume.start();

    // Register a worker that would execute the job if it was still in the queue
    let resumeWorkerExecuted = false;
    await bossResume.work('pipeline:run', async (jobs) => {
      for (const job of jobs) {
        const data = job.data as { runId?: number };
        if (data.runId === testRunId) {
          resumeWorkerExecuted = true;
        }
      }
    });

    // Wait 2 polling intervals to give the worker a chance to pick up any jobs
    await sleep(2_500);

    // Assert: worker did NOT execute the cancelled job
    expect(resumeWorkerExecuted).toBe(false);

    // Assert: status is still 'cancelled' (not changed to 'running' or 'done')
    const { rows: finalRows } = await pool.query<{ status: string }>(
      'SELECT status FROM pipeline_runs WHERE id = $1',
      [testRunId],
    );
    expect(finalRows[0].status).toBe('cancelled');
  }, 30_000);
});

// ── Test B — Cancel running run ────────────────────────────────────────────────

describe('Test B — cancel running run (SIGTERM + SIGKILL)', () => {
  // Child process map shared between the run worker and the cancel handler
  const childMap = new Map<number, ChildProcess>();
  // Sentinel file path map: runId → sentinel file path
  // The cancel-mock-engine writes this file on SIGTERM receipt.
  const sentinelMap = new Map<number, string>();

  beforeAll(async () => {
    // Stop current boss (which may be the resume boss from Test A or the original)
    try {
      await boss.stop({ timeout: 3_000 });
    } catch { /* ignore if already stopped */ }
    if (bossResume) {
      try { await bossResume.stop({ timeout: 3_000 }); } catch { /* ignore */ }
      bossResume = null;
    }

    // Start a fresh boss for Test B
    boss = new RealPgBoss({
      connectionString: DB_URL,
      schema: BOSS_SCHEMA,
      pollingIntervalSeconds: 0.5,
    });
    boss.on('error', () => { /* suppress */ });
    await boss.start();
    await boss.createQueue('pipeline:run');
    await boss.createQueue('pipeline:cancel');

    // Register the run worker and expose the in-process cancellation handler.
    // The mini control route uses real pg-boss send/fetch/complete operations
    // before invoking this worker handler, avoiding timing-only polling races.
    const { handleRun, handleCancel } = buildCancelWorkerHandlers(childMap, sentinelMap);
    runningCancelHandler = handleCancel;
    await boss.work('pipeline:run', { pollingIntervalSeconds: 0.5 }, handleRun);
  }, 15_000);

  it('should deliver SIGTERM within 2s and cancel within 12s with correct DB and WAL state', async () => {
    const { workspaceId, workspacePath, specPath } = await createTestFixtures('b');

    // 1. Trigger run — worker will pick it up and spawn cancel-mock-engine (60 s sleep)
    const runId = await triggerRun(workspaceId, workspacePath, specPath);

    // 2. Wait for process to register in childMap (worker sets it after spawn)
    //    AND pipeline_runs.status = 'running'
    const isRunning = await waitFor(async () => {
      const { rows } = await pool.query<{ status: string }>(
        'SELECT status FROM pipeline_runs WHERE id = $1',
        [runId],
      );
      return rows.length > 0 && rows[0].status === 'running' && childMap.has(runId);
    }, 10_000);
    expect(isRunning).toBe(true);

    // Sanity: process map has the child
    const child = childMap.get(runId);
    expect(child).toBeDefined();
    expect(child!.pid).toBeTruthy();

    // Get the sentinel path that the engine will write on SIGTERM
    const sentinelPath = sentinelMap.get(runId);
    expect(sentinelPath).toBeTruthy();

    // 3. Record time and call cancel
    const cancelTime = Date.now();
    const cancelResponse = await cancelRun(runId);
    expect(['cancelling', 'cancelled']).toContain(cancelResponse.status as string);

    // 4. Assert SIGTERM sentinel file appears within 2 s of cancel call.
    //    The cancel-mock-engine writes sentinelPath when it receives SIGTERM.
    //    We poll for file existence rather than stdout (avoids stream ordering issues).
    const sigtermDelivered = await waitFor(
      async () => {
        try {
          fs.accessSync(sentinelPath!);
          return true;
        } catch {
          return false;
        }
      },
      SIGTERM_ASSERT_MS,
      50,
    );
    expect(sigtermDelivered).toBe(true);

    if (sigtermDelivered) {
      // Verify sentinel content and measure latency
      const content = fs.readFileSync(sentinelPath!, 'utf8');
      expect(content).toContain(`SIGTERM runId=${runId}`);
      const match = content.match(/ts=(\d+)/);
      if (match) {
        const sigtermTs = parseInt(match[1], 10);
        const latencyMs = sigtermTs - cancelTime;
        expect(latencyMs).toBeLessThanOrEqual(SIGTERM_ASSERT_MS);
      }
    }

    // 5. Assert process exits within 12 s (SIGKILL after 10 s + 2 s buffer)
    const exitedWithinWindow = await new Promise<boolean>((resolve) => {
      const deadline = setTimeout(() => resolve(false), EXIT_ASSERT_MS);
      // If child already exited (sentinel file written = SIGTERM received = exit imminent)
      if (child!.exitCode !== null) {
        clearTimeout(deadline);
        resolve(true);
        return;
      }
      child!.once('exit', () => {
        clearTimeout(deadline);
        resolve(true);
      });
    });
    expect(exitedWithinWindow).toBe(true);

    // Allow DB writes to flush after process exit
    await sleep(500);

    // 6. Assert pipeline_runs.status = 'cancelled' with finished_at set
    const { rows: runRows } = await pool.query<{
      status: string;
      finished_at: Date | null;
    }>(
      'SELECT status, finished_at FROM pipeline_runs WHERE id = $1',
      [runId],
    );
    expect(runRows).toHaveLength(1);
    expect(runRows[0].status).toBe('cancelled');
    expect(runRows[0].finished_at).not.toBeNull();

    // 7. Assert WAL event 'run_cancelled' is present
    //    NOTE: wal_events uses `ts` as the timestamp column, NOT `created_at`
    const { rows: walRows } = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM wal_events
       WHERE event_type = 'run_cancelled'
         AND (payload->>'run_id')::bigint = $1
       ORDER BY ts DESC
       LIMIT 1`,
      [runId],
    );
    expect(walRows).toHaveLength(1);
    expect(walRows[0].event_type).toBe('run_cancelled');

    // 8. Assert run_output_chunks: count > 0 and sequences are contiguous
    const { rows: chunkRows } = await pool.query<{ sequence: number }>(
      'SELECT sequence FROM run_output_chunks WHERE run_id = $1 ORDER BY sequence ASC',
      [runId],
    );
    // At minimum, "cancel-mock-engine: started runId=..." must be flushed
    expect(chunkRows.length).toBeGreaterThan(0);

    // Verify contiguous sequences (no gaps)
    for (let i = 0; i < chunkRows.length; i++) {
      expect(chunkRows[i].sequence).toBe(i + 1);
    }
  }, 30_000);
});
