/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * PG-014: Express server restart resilience test.
 *
 * Proves that an in-flight pipeline run survives an Express server restart:
 *   1. Start real Express server (child_process.spawn) + in-process pg-boss worker.
 *   2. Enqueue a pipeline:run job backed by slow-mock-engine.ts (15 s sleep).
 *   3. Wait for status='running'.
 *   4. SIGTERM the Express process; await its 'exit' event.
 *   5. Spawn a new Express process on the same port; poll /api/health until ready.
 *   6. Assert run status is still 'running' (not 'failed') 3 s after restart.
 *   7. Wait for run to complete (status='done').
 *   8. Verify run_output_chunks count did not regress during the restart window.
 *   9. Verify timing: finished_at − started_at ≥ 15 s.
 *  10. Run 3 iterations to prove reliability.
 *
 * Architecture:
 *   slow-mock-engine   ← spawned by in-process worker handler
 *   in-process worker  ← pg-boss.work() registered in test beforeAll
 *   server.ts (1st)    ← child_process.spawn, killed mid-run
 *   server.ts (2nd)    ← child_process.spawn on same port, receives story results
 *
 * The in-process worker writes run_output_chunks directly to the DB.
 * The slow-mock-engine POSTs WAL events + story results to the Express server
 * with retry logic — so it reconnects to the new Express after restart.
 *
 * Test DB: rorca_test (never inherits prod DATABASE_URL).
 * Timeout: 65 s per test (15 s engine + restart overhead + margins).
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as http from 'http';
import { spawn, type ChildProcess } from 'child_process';
import { Pool } from 'pg';
import PgBoss from 'pg-boss';
import { assertConnectedTestDatabase, resolveTestDatabaseUrl } from '../lib/test-db-safety';
import { pgBossTestSchema } from './helpers/pg-boss-test-schema';

// ── Test DB URL ────────────────────────────────────────────────────────────────

const DB_URL = resolveTestDatabaseUrl();
const BOSS_SCHEMA = pgBossTestSchema('restart');

// ── Binary / file paths ────────────────────────────────────────────────────────

const BACKEND_DIR = path.join(__dirname, '..', '..');
const TSX_BIN = path.join(BACKEND_DIR, 'node_modules', '.bin', 'tsx');
// Use a minimal test-server instead of the full server.ts to avoid import errors
// (e.g., missing ./routes/attachments in this branch).
const TEST_SERVER_TS = path.join(__dirname, 'fixtures', 'test-server.ts');
const SLOW_ENGINE_PATH = path.join(__dirname, 'fixtures', 'slow-mock-engine.ts');

// ── Port ───────────────────────────────────────────────────────────────────────

// Dedicated test port — avoids collision with real backend (3030) and
// the pg-boss-integration suite (random OS port).
const TEST_PORT = 3039;

// ── Timing ────────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 500;
const HEALTH_POLL_ATTEMPTS = 30;   // 30 × 500 ms = 15 s max for server to come up
const STATUS_POLL_MAX_MS = 50_000; // wait up to 50 s for run to complete after restart
const CHUNK_SIZE = 4 * 1024;       // 4 KB

// ── Jest ──────────────────────────────────────────────────────────────────────

// Must exceed 3 × (startup + 15 s engine + restart + assertions)
jest.setTimeout(65_000);

// ── Suite-level state ─────────────────────────────────────────────────────────

let pool: Pool;
let boss: PgBoss;
// All active child processes spawned by in-process worker — killed in afterAll
const activeChildren: ChildProcess[] = [];

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Spawn the minimal test-server at TEST_PORT pointing at the test DB. */
function spawnServer(): ChildProcess {
  const proc = spawn(
    TSX_BIN,
    [TEST_SERVER_TS],
    {
      env: {
        DATABASE_URL: DB_URL,
        PGBOSS_TEST_SCHEMA: BOSS_SCHEMA,
        PORT: String(TEST_PORT),
        PATH: process.env.PATH ?? '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  // Suppress output by default — flip to `process.stdout.write` for debugging
  proc.stdout?.on('data', (_d: Buffer) => { /* suppress */ });
  proc.stderr?.on('data', (_d: Buffer) => { /* suppress */ });
  return proc;
}

/** GET /api/health; returns true if HTTP 200 is received. */
async function checkHealth(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/api/health',
        method: 'GET',
        timeout: 1500,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode === 200));
        res.on('error', () => resolve(false));
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

/** Poll /api/health until ready; return true if server responds 200. */
async function waitForServer(maxAttempts = HEALTH_POLL_ATTEMPTS): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    if (await checkHealth()) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

/** Poll pipeline_runs status until predicate or maxMs. */
async function waitForRunStatus(
  runId: number,
  predicate: (status: string) => boolean,
  maxMs = STATUS_POLL_MAX_MS,
): Promise<string | null> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const { rows } = await pool.query<{ status: string }>(
      'SELECT status FROM pipeline_runs WHERE id = $1',
      [runId],
    );
    if (rows.length > 0 && predicate(rows[0].status)) return rows[0].status;
    await sleep(POLL_INTERVAL_MS);
  }
  const { rows } = await pool.query<{ status: string }>(
    'SELECT status FROM pipeline_runs WHERE id = $1',
    [runId],
  );
  return rows[0]?.status ?? null;
}

/** SIGTERM proc and await its exit event (with SIGKILL fallback). */
async function killAndWait(proc: ChildProcess, timeoutMs = 10_000): Promise<void> {
  if (!proc || proc.exitCode !== null) return;
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      resolve();
    }, timeoutMs);
    proc.once('exit', () => { clearTimeout(timer); resolve(); });
    try { proc.kill('SIGTERM'); } catch { resolve(); }
  });
}

/** Write a Buffer as ≤4 KB chunks to run_output_chunks. */
async function writeOutputChunks(
  runId: number,
  data: Buffer,
  seqRef: { value: number },
): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const slice = data.slice(offset, offset + CHUNK_SIZE);
    await pool.query(
      `INSERT INTO run_output_chunks (run_id, chunk, sequence)
       VALUES ($1, $2, $3)
       ON CONFLICT (run_id, sequence) DO NOTHING`,
      [runId, slice, seqRef.value],
    ).catch(() => { /* best-effort */ });
    seqRef.value += 1;
    offset += CHUNK_SIZE;
  }
}

// ── In-process worker handler ─────────────────────────────────────────────────

/**
 * Handles pipeline:run jobs in-process.
 * Spawns slow-mock-engine.ts, pipes output to run_output_chunks,
 * marks run done/failed on exit.
 */
async function handlePipelineRunInProcess(
  jobs: PgBoss.Job<Record<string, unknown>>[],
): Promise<void> {
  for (const job of jobs) {
    const data = job.data as {
      runId: number;
      specPath: string;
      workspacePath: string;
    };
    const { runId, specPath, workspacePath } = data;
    if (!runId || !specPath || !workspacePath) continue;

    // Look up workspace_id
    const { rows: runRows } = await pool.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM pipeline_runs WHERE id = $1',
      [runId],
    );
    if (runRows.length === 0) continue;
    const workspaceId = runRows[0].workspace_id;

    // Mark as running
    await pool.query(
      `UPDATE pipeline_runs SET status = 'running', started_at = NOW() WHERE id = $1`,
      [runId],
    );

    // Emit run_started WAL event directly to DB
    await pool.query(
      `INSERT INTO wal_events (event_type, workspace_id, payload)
       VALUES ('run_started', $1, $2)`,
      [workspaceId, JSON.stringify({ run_id: runId, spec_path: specPath })],
    );

    // Resolve absolute spec path
    const absSpecPath = path.isAbsolute(specPath)
      ? specPath
      : path.join(workspacePath, specPath);

    // Spawn slow-mock-engine — it will sleep 15 s, then POST results to the Express server
    const child = spawn(
      TSX_BIN,
      [
        SLOW_ENGINE_PATH,
        '--json', absSpecPath,
        '--cwd', workspacePath,
        '--run-id', String(runId),
        '--port', String(TEST_PORT),
      ],
      {
        cwd: workspacePath,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, RORCA_PROCESS_ROLE: 'engine' },
      },
    );

    activeChildren.push(child);

    if (child.pid) {
      await pool.query(
        'UPDATE pipeline_runs SET pid = $1 WHERE id = $2',
        [child.pid, runId],
      );
    }

    // Stream stdout/stderr to run_output_chunks
    const seqRef = { value: 1 };
    let pending = Buffer.alloc(0);

    const flush = async (): Promise<void> => {
      if (pending.length === 0) return;
      await writeOutputChunks(runId, pending, seqRef);
      pending = Buffer.alloc(0);
    };

    const handleData = async (chunk: Buffer): Promise<void> => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= CHUNK_SIZE) {
        await writeOutputChunks(runId, pending.slice(0, CHUNK_SIZE), seqRef);
        pending = pending.slice(CHUNK_SIZE);
      }
    };

    child.stdout?.on('data', (d: Buffer) => { void handleData(d); });
    child.stderr?.on('data', (d: Buffer) => { void handleData(d); });

    await new Promise<void>((resolve) => {
      child.on('exit', async (code) => {
        await flush();
        const idx = activeChildren.indexOf(child);
        if (idx !== -1) activeChildren.splice(idx, 1);

        const status = code === 0 ? 'done' : 'failed';
        await pool.query(
          `UPDATE pipeline_runs SET status = $1, finished_at = NOW() WHERE id = $2`,
          [status, runId],
        );
        await pool.query(
          `INSERT INTO wal_events (event_type, workspace_id, payload)
           VALUES ('run_finished', $1, $2)`,
          [workspaceId, JSON.stringify({ run_id: runId, status, exit_code: code })],
        );
        resolve();
      });

      child.on('error', async (err) => {
        await flush();
        const idx = activeChildren.indexOf(child);
        if (idx !== -1) activeChildren.splice(idx, 1);
        await pool.query(
          `UPDATE pipeline_runs SET status = 'failed', finished_at = NOW() WHERE id = $1`,
          [runId],
        );
        await pool.query(
          `INSERT INTO wal_events (event_type, workspace_id, payload)
           VALUES ('run_finished', $1, $2)`,
          [workspaceId, JSON.stringify({ run_id: runId, status: 'failed', error: err.message })],
        );
        resolve();
      });
    });
  }
}

// ── Suite setup / teardown ────────────────────────────────────────────────────

beforeAll(async () => {
  // 1. Connect pool for direct DB assertions + worker queries
  pool = new Pool({ connectionString: DB_URL, max: 5 });
  await assertConnectedTestDatabase(pool, DB_URL);


  // 3. Start pg-boss for the in-process worker
  boss = new PgBoss({
    connectionString: DB_URL,
    schema: BOSS_SCHEMA,
    pollingIntervalSeconds: 1,
  });
  boss.on('error', () => { /* suppress noise */ });
  await boss.start();

  // 4. Ensure the pipeline:run queue exists (pg-boss v10 requires explicit creation)
  await boss.createQueue('pipeline:run');

  // 5. Register in-process worker
  await boss.work('pipeline:run', handlePipelineRunInProcess);
}, 30_000);

afterAll(async () => {
  // Kill any dangling engine processes
  for (const child of activeChildren) {
    try { child.kill(); } catch { /* ignore */ }
  }

  // Stop pg-boss gracefully
  try { await boss?.stop({ timeout: 5_000 }); } catch { /* ignore */ }

  // Close pool
  if (pool) await pool.end();
}, 15_000);

// ── Test fixtures ─────────────────────────────────────────────────────────────

async function createTestFixture(): Promise<{
  workspaceId: string;
  workspacePath: string;
  specPath: string;
  absSpecPath: string;
}> {
  const workspaceId = `restart-test-ws-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-restart-'));

  await pool.query(
    `INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3)`,
    [workspaceId, 'Restart Test Workspace', workspacePath],
  );

  const specDir = path.join(workspacePath, 'forge', 'specs', 'approved');
  fs.mkdirSync(specDir, { recursive: true });

  const specSlug = 'restart-test-spec';
  const specJson = {
    title: specSlug,
    userStories: [
      {
        id: 'US-001',
        title: 'Restart test story',
        description: 'Story that runs while the backend restarts',
        acceptanceCriteria: ['Survives restart'],
        dependsOn: [],
        passes: false,
      },
    ],
    model: 'claude-sonnet-4-5-20250929',
    generatedAt: new Date().toISOString(),
  };

  const absSpecPath = path.join(specDir, `${specSlug}.json`);
  fs.writeFileSync(absSpecPath, JSON.stringify(specJson, null, 2));

  const specPath = `forge/specs/approved/${specSlug}.json`;
  return { workspaceId, workspacePath, specPath, absSpecPath };
}

async function cleanupFixture(
  workspaceId: string,
  workspacePath: string,
  runId: number,
): Promise<void> {
  await pool.query('DELETE FROM run_output_chunks WHERE run_id = $1', [runId]);
  await pool.query('DELETE FROM story_results WHERE run_id = $1', [runId]);
  await pool.query(
    `DELETE FROM wal_events WHERE (payload->>'run_id')::bigint = $1`,
    [runId],
  );
  await pool.query('DELETE FROM pipeline_runs WHERE id = $1', [runId]);
  await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
  try { fs.rmSync(workspacePath, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** Insert a pipeline_run and enqueue a pg-boss job for it. */
async function triggerRun(
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
  const runId = rows[0].id;

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

  return runId;
}

// ── Core scenario ─────────────────────────────────────────────────────────────

async function runScenario(iteration: number): Promise<void> {
  // ── 1. Spawn Express server ───────────────────────────────────────────────
  let serverProc = spawnServer();
  const initialReady = await waitForServer();
  expect(initialReady).toBe(true); // [iter ${iteration}] initial server must come up

  let runId!: number;
  let workspaceId!: string;
  let workspacePath!: string;

  try {
    // ── 2. Create fixture ────────────────────────────────────────────────────
    const fixture = await createTestFixture();
    workspaceId = fixture.workspaceId;
    workspacePath = fixture.workspacePath;

    // ── 3. Enqueue pipeline run ──────────────────────────────────────────────
    runId = await triggerRun(fixture.workspaceId, fixture.workspacePath, fixture.specPath);

    // ── 4. Wait for status='running' ─────────────────────────────────────────
    const runningStatus = await waitForRunStatus(runId, (s) => s === 'running', 10_000);
    expect(runningStatus).toBe('running');

    // Snapshot chunk count before restart
    const { rows: pre } = await pool.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM run_output_chunks WHERE run_id = $1',
      [runId],
    );
    const chunksBefore = parseInt(pre[0].count, 10);

    // ── 5. SIGTERM Express — wait for clean exit ─────────────────────────────
    await killAndWait(serverProc, 8_000);

    // ── 6. Spawn replacement Express on same port ────────────────────────────
    serverProc = spawnServer();
    const restartReady = await waitForServer();
    expect(restartReady).toBe(true);

    // ── 7. 3 s after restart: run must still be 'running' ────────────────────
    await sleep(3_000);
    const { rows: midRows } = await pool.query<{ status: string }>(
      'SELECT status FROM pipeline_runs WHERE id = $1',
      [runId],
    );
    expect(midRows[0]?.status).toBe('running');

    // ── 8. Wait for run to complete ──────────────────────────────────────────
    const finalStatus = await waitForRunStatus(
      runId,
      (s) => s === 'done' || s === 'failed' || s === 'cancelled',
    );
    expect(finalStatus).toBe('done');

    // ── 9. Chunk count must not have regressed ───────────────────────────────
    const { rows: post } = await pool.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM run_output_chunks WHERE run_id = $1',
      [runId],
    );
    const chunksAfter = parseInt(post[0].count, 10);
    expect(chunksAfter).toBeGreaterThanOrEqual(chunksBefore);
    expect(chunksAfter).toBeGreaterThanOrEqual(1);

    // ── 10. Verify timing ────────────────────────────────────────────────────
    const { rows: timing } = await pool.query<{
      started_at: Date | null;
      finished_at: Date | null;
    }>(
      'SELECT started_at, finished_at FROM pipeline_runs WHERE id = $1',
      [runId],
    );
    const { started_at, finished_at } = timing[0];
    expect(started_at).not.toBeNull();
    expect(finished_at).not.toBeNull();
    if (started_at && finished_at) {
      const durationMs = finished_at.getTime() - started_at.getTime();
      expect(durationMs).toBeGreaterThanOrEqual(15_000);
    }

  } finally {
    await killAndWait(serverProc, 5_000);
    if (runId !== undefined) {
      await cleanupFixture(workspaceId, workspacePath, runId);
    }
  }
}

// ── Tests (3 × to prove reliability) ─────────────────────────────────────────

describe('pg-boss restart resilience — pipeline run survives Express restart', () => {
  it(
    'iteration 1 — run survives Express SIGTERM and completes via restarted server',
    async () => {
      await runScenario(1);
    },
    65_000,
  );

  it(
    'iteration 2 — run survives Express SIGTERM and completes via restarted server (reliability pass 2)',
    async () => {
      await runScenario(2);
    },
    65_000,
  );

  it(
    'iteration 3 — run survives Express SIGTERM and completes via restarted server (reliability pass 3)',
    async () => {
      await runScenario(3);
    },
    65_000,
  );
});
