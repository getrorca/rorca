/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * PG-015: Concurrency tests — multiple worker instances never execute the same job twice.
 *
 * Three test scenarios:
 *
 *   Test A — Distinct jobs:
 *     Trigger 6 runs simultaneously via Promise.all (6 different workspaces).
 *     All 6 must complete with status='done'. story_results must have zero duplicate
 *     (run_id, story_id) pairs across all 6 runs.
 *
 *   Test B — Single spec conflict:
 *     Trigger 2 runs for the same workspace with a run already 'running'.
 *     The second trigger returns 409 Conflict.
 *     Also tests simultaneous triggers: SERIALIZABLE isolation ensures one succeeds (200)
 *     and the other is rejected (409).
 *
 *   Test C — pg-boss lock:
 *     Start 2 boss.work() subscriptions (WORKER_A, WORKER_B) each with batchSize:3.
 *     Enqueue 6 jobs. Record which worker handled each job.
 *     Assert every job was handled exactly once (no double-dispatch).
 *
 * Uses:
 *   - Real PostgreSQL (TEST_DATABASE_URL / DATABASE_URL → rorca_test)
 *   - In-process pg-boss (pollingIntervalSeconds=1)
 *   - mock-engine.ts fixture for story execution
 *   - Mini Express server (embedded, not test-server.ts subprocess)
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as http from 'http';
import { spawn, type ChildProcess } from 'child_process';
import { Pool } from 'pg';
import PgBoss from 'pg-boss';
import express, { type Express } from 'express';

// ── Connection ──────────────────────────────────────────────────────────────

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://rorca:rorca@localhost:5432/rorca_test';

// ── Constants ───────────────────────────────────────────────────────────────

const MOCK_ENGINE_PATH = path.join(__dirname, 'fixtures', 'mock-engine.ts');
const TSX_BIN = path.join(__dirname, '..', '..', 'node_modules', '.bin', 'tsx');
const CHUNK_SIZE = 4 * 1024;
const POLL_INTERVAL_MS = 200;

// ── Helpers ─────────────────────────────────────────────────────────────────

async function waitFor(
  predicate: () => Promise<boolean>,
  maxMs = 20_000,
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

// ── Suite state ──────────────────────────────────────────────────────────────

let pool: Pool;
// Primary boss for Tests A and B
let bossA: PgBoss;
// Dedicated boss for Test C (separate to avoid handler cross-contamination with Tests A/B)
let bossC: PgBoss;
let app: Express;
let server: http.Server;
let serverPort: number;

// Run IDs created across all tests — cleaned up in afterAll
const allRunIds: number[] = [];
// Workspace IDs created across all tests — cleaned up in afterAll
const allWorkspaceIds: string[] = [];
// Temp spec paths to delete in afterAll
const tempSpecPaths: string[] = [];
// Active child processes — killed in afterAll
const activeChildren: ChildProcess[] = [];

// ── Suite setup / teardown ──────────────────────────────────────────────────

beforeAll(async () => {
  // 1. Connect pool
  pool = new Pool({ connectionString: DB_URL, max: 10 });

  // 2. Run migrations
  const { runPgMigrations } = await import('../db/pg-index');
  await runPgMigrations(pool);

  // 3. Start mini Express server (handles WAL events + story results from mock-engine)
  app = buildMiniServer(pool);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      serverPort = (server.address() as { port: number }).port;
      resolve();
    });
  });

  // 4. Start pg-boss with fast polling for tests
  bossA = new PgBoss({
    connectionString: DB_URL,
    schema: 'pgboss',
    pollingIntervalSeconds: 1,
  });
  bossA.on('error', () => { /* suppress noise */ });
  await bossA.start();

  // 5. Create the pipeline:run queue (pg-boss v10 requires explicit creation)
  await bossA.createQueue('pipeline:run');
}, 30_000);

afterAll(async () => {
  // Kill dangling child processes
  for (const child of activeChildren) {
    try { child.kill(); } catch { /* ignore */ }
  }

  // Stop pg-boss instances
  try { await bossA.stop({ timeout: 5_000 }); } catch { /* ignore */ }
  try { if (bossC) await bossC.stop({ timeout: 5_000 }); } catch { /* ignore */ }

  // Close HTTP server
  await new Promise<void>((res) => server.close(() => res()));

  // Delete test data in FK-safe order (child rows first, then workspaces)
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

  // Now safe to delete workspaces (no FK references remain)
  if (allWorkspaceIds.length > 0) {
    await pool.query('DELETE FROM workspaces WHERE id = ANY($1)', [allWorkspaceIds]);
  }

  for (const p of tempSpecPaths) {
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }

  await pool.end();
}, 15_000);

// ── In-process worker handler ────────────────────────────────────────────────

/**
 * Standard worker handler that spawns mock-engine.ts and streams output
 * to run_output_chunks. Used for Tests A and B.
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

    const absSpecPath = path.isAbsolute(specPath)
      ? specPath
      : path.join(workspacePath, specPath);

    const child = spawn(
      TSX_BIN,
      [
        MOCK_ENGINE_PATH,
        '--json', absSpecPath,
        '--cwd', workspacePath,
        '--run-id', String(runId),
        '--port', String(serverPort),
      ],
      {
        cwd: workspacePath,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, RORCA_PROCESS_ROLE: 'engine' },
      },
    );
    activeChildren.push(child);

    if (child.pid) {
      await pool.query('UPDATE pipeline_runs SET pid = $1 WHERE id = $2', [child.pid, runId]);
    }

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
        const idx = activeChildren.indexOf(child);
        if (idx !== -1) activeChildren.splice(idx, 1);

        const status = code === 0 ? 'done' : 'failed';
        await pool.query(
          'UPDATE pipeline_runs SET status = $1, finished_at = NOW() WHERE id = $2',
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
          "UPDATE pipeline_runs SET status = 'failed', finished_at = NOW() WHERE id = $1",
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

// ── Mini Express server ──────────────────────────────────────────────────────

/**
 * Mini server handling the two endpoints mock-engine calls.
 * Also exposes POST /api/pipeline/trigger with conflict detection (returns 409
 * when a run for that workspace is already 'running' or 'queued').
 * Uses SERIALIZABLE isolation so simultaneous requests don't both slip past the check.
 */
function buildMiniServer(dbPool: Pool): Express {
  const miniApp = express();
  miniApp.use(express.json());

  // POST /api/wal — used by mock-engine to emit WAL events
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

  // POST /api/pipeline/story-result — used by mock-engine to record story results
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

  // POST /api/pipeline/trigger — inserts run + enqueues job.
  // Returns 409 if a run for this workspace is already 'running' or 'queued'.
  // Uses INSERT ... WHERE NOT EXISTS wrapped in SERIALIZABLE to prevent race conditions.
  miniApp.post('/api/pipeline/trigger', async (req, res) => {
    const client = await dbPool.connect();
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

      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');

      // Conflict check under serializable isolation: any run already active for this workspace?
      const { rows: existing } = await client.query<{ id: number }>(
        `SELECT id FROM pipeline_runs
         WHERE workspace_id = $1
           AND status IN ('queued', 'running')
         LIMIT 1`,
        [workspaceId],
      );

      if (existing.length > 0) {
        await client.query('ROLLBACK');
        res.status(409).json({
          error: 'A run for this workspace is already active',
          activeRunId: existing[0].id,
        });
        return;
      }

      // Insert pipeline_runs row with status='queued'
      const { rows } = await client.query<{ id: number }>(
        `INSERT INTO pipeline_runs
           (spec_path, workspace_id, status, trigger_type, parallelism, agent, agent_type, agent_model, queued_at)
         VALUES ($1, $2, 'queued', 'manual', 1, 'claude', 'claude', NULL, NOW())
         RETURNING id`,
        [specPath, workspaceId],
      );
      const runId = rows[0].id;

      await client.query('COMMIT');

      // Enqueue pg-boss job (outside the transaction — pg-boss uses its own connection)
      await bossA.send('pipeline:run', {
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
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      // PostgreSQL serialization failure (SQLSTATE 40001) → return 409
      const pgErr = err as { code?: string };
      if (pgErr.code === '40001') {
        res.status(409).json({ error: 'Serialization conflict — a concurrent trigger won the race' });
        return;
      }
      res.status(500).json({ error: (err as Error).message });
    } finally {
      client.release();
    }
  });

  return miniApp;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Create a unique workspace + spec file. Returns { workspaceId, workspacePath, specPath, absSpecPath }. */
async function createTestFixtures(storyCount = 1, tag = ''): Promise<{
  workspaceId: string;
  workspacePath: string;
  specPath: string;
  absSpecPath: string;
}> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}${tag ? `-${tag}` : ''}`;
  const workspaceId = `test-conc-${suffix}`;
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-conc-'));

  await pool.query(
    `INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3)`,
    [workspaceId, `Concurrency Test WS ${suffix}`, workspacePath],
  );
  allWorkspaceIds.push(workspaceId);

  const userStories = Array.from({ length: storyCount }, (_, i) => ({
    id: `US-${String(i + 1).padStart(3, '0')}`,
    title: `Concurrency test story ${i + 1}`,
    description: 'Concurrency test',
    acceptanceCriteria: ['It works'],
    dependsOn: [],
    passes: false,
  }));

  const specJson = {
    title: `concurrency-test-spec-${suffix}`,
    userStories,
    model: 'claude-sonnet-4-5-20250929',
    generatedAt: new Date().toISOString(),
  };

  const specDir = path.join(workspacePath, 'forge', 'specs', 'approved');
  fs.mkdirSync(specDir, { recursive: true });
  const absSpecPath = path.join(specDir, `concurrency-test-spec-${suffix}.json`);
  fs.writeFileSync(absSpecPath, JSON.stringify(specJson, null, 2));
  tempSpecPaths.push(absSpecPath);

  const specPath = `forge/specs/approved/concurrency-test-spec-${suffix}.json`;

  return { workspaceId, workspacePath, specPath, absSpecPath };
}

/** Insert pipeline_runs row + enqueue pg-boss job via bossA. Returns runId. */
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
  allRunIds.push(runId);

  await bossA.send('pipeline:run', {
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

/** HTTP POST helper — makes a request to the mini-server trigger endpoint. */
async function httpTrigger(
  workspaceId: string,
  specPath: string,
  workspacePath: string,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ workspaceId, specPath, workspacePath });
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: serverPort,
        path: '/api/pipeline/trigger',
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
            resolve({ statusCode: res.statusCode ?? 0, body: JSON.parse(data) });
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

// ── Test A — Distinct jobs ────────────────────────────────────────────────────

describe('Test A — 6 distinct runs simultaneously', () => {
  // Register a worker before these tests. batchSize:6 → can pick up 6 jobs at once.
  beforeAll(async () => {
    await bossA.work('pipeline:run', { batchSize: 6 }, handlePipelineRunInProcess);
  }, 10_000);

  it('all 6 runs complete with status=done', async () => {
    // Create 6 independent workspaces + specs
    const fixtures = await Promise.all(
      Array.from({ length: 6 }, (_, i) => createTestFixtures(1, `a${i}`)),
    );

    // Trigger all 6 simultaneously
    const runIds = await Promise.all(
      fixtures.map(({ workspaceId, workspacePath, specPath }) =>
        triggerRun(workspaceId, workspacePath, specPath),
      ),
    );

    // Wait for all 6 to reach 'done'
    const allDone = await waitFor(async () => {
      const { rows } = await pool.query<{ status: string }>(
        'SELECT status FROM pipeline_runs WHERE id = ANY($1)',
        [runIds],
      );
      return rows.length === 6 && rows.every((r) => r.status === 'done');
    }, 30_000);

    expect(allDone).toBe(true);

    // Verify each run reached 'done'
    const { rows: finalRows } = await pool.query<{ id: number; status: string }>(
      'SELECT id, status FROM pipeline_runs WHERE id = ANY($1) ORDER BY id',
      [runIds],
    );
    expect(finalRows).toHaveLength(6);
    for (const row of finalRows) {
      expect(row.status).toBe('done');
    }
  }, 35_000);

  it('story_results has no duplicate (run_id, story_id) pairs across all 6 runs', async () => {
    const { rows: dupRows } = await pool.query<{ run_id: number; story_id: string; cnt: string }>(
      `SELECT run_id, story_id, COUNT(*) as cnt
       FROM story_results
       WHERE run_id = ANY($1)
       GROUP BY run_id, story_id
       HAVING COUNT(*) > 1`,
      [allRunIds],
    );

    expect(dupRows).toHaveLength(0);
  });
});

// ── Test B — Single spec conflict ────────────────────────────────────────────

describe('Test B — same workspace trigger conflict returns 409', () => {
  let conflictWorkspaceId: string;
  let conflictWorkspacePath: string;
  let conflictSpecPath: string;
  let preRunId: number;

  beforeAll(async () => {
    const fixtures = await createTestFixtures(1, 'b');
    conflictWorkspaceId = fixtures.workspaceId;
    conflictWorkspacePath = fixtures.workspacePath;
    conflictSpecPath = fixtures.specPath;
  });

  it('second trigger for same workspace returns 409 when first is already running', async () => {
    // Pre-insert a 'running' run to simulate an already-active pipeline
    const { rows: runningRows } = await pool.query<{ id: number }>(
      `INSERT INTO pipeline_runs
         (spec_path, workspace_id, status, trigger_type, parallelism, agent, agent_type, queued_at)
       VALUES ($1, $2, 'running', 'manual', 1, 'claude', 'claude', NOW())
       RETURNING id`,
      [conflictSpecPath, conflictWorkspaceId],
    );
    preRunId = runningRows[0].id;
    allRunIds.push(preRunId);

    // Attempt to trigger a second run via the mini-server's trigger endpoint
    const response = await httpTrigger(
      conflictWorkspaceId,
      conflictSpecPath,
      conflictWorkspacePath,
    );

    // The trigger endpoint must return 409 when there's already an active run
    expect(response.statusCode).toBe(409);
    expect(response.body).toHaveProperty('error');
    expect(response.body).toHaveProperty('activeRunId', preRunId);
  });

  it('simultaneous triggers for same workspace: exactly one succeeds, the other gets 409', async () => {
    // Clean up the 'running' run from the previous test so the workspace is free
    if (preRunId) {
      await pool.query(
        "UPDATE pipeline_runs SET status = 'done', finished_at = NOW() WHERE id = $1",
        [preRunId],
      );
    }

    // Create a fresh workspace with no active runs
    const { workspaceId, workspacePath, specPath } = await createTestFixtures(1, 'b2');

    // Fire both trigger requests simultaneously
    const [r1, r2] = await Promise.all([
      httpTrigger(workspaceId, specPath, workspacePath),
      httpTrigger(workspaceId, specPath, workspacePath),
    ]);

    const statuses = [r1.statusCode, r2.statusCode].sort();

    // One must succeed (200) and the other must be rejected (409).
    // SERIALIZABLE isolation ensures the check-then-insert is atomic.
    expect(statuses).toEqual([200, 409]);

    // Track the created run ID for cleanup
    for (const r of [r1, r2]) {
      if (r.statusCode === 200 && typeof r.body.runId === 'number') {
        allRunIds.push(r.body.runId as number);
      }
    }
  });
});

// ── Test C — pg-boss lock: each job handled exactly once ─────────────────────

describe('Test C — pg-boss SELECT FOR UPDATE SKIP LOCKED: each job handled exactly once', () => {
  // In-process invocation log: runId → workerIds that handled it
  const handlerInvocations = new Map<number, string[]>();

  // Separate tracking for Test C data so we can clean it up independently
  const testCRunIds: number[] = [];
  const testCWorkspaceIds: string[] = [];
  const testCSpecPaths: string[] = [];

  afterAll(async () => {
    // Delete Test C data (FK-safe order)
    if (testCRunIds.length > 0) {
      await pool.query('DELETE FROM run_output_chunks WHERE run_id = ANY($1)', [testCRunIds]);
      await pool.query('DELETE FROM story_results WHERE run_id = ANY($1)', [testCRunIds]);
      await pool.query(
        "DELETE FROM wal_events WHERE (payload->>'run_id')::int = ANY($1)",
        [testCRunIds],
      );
      await pool.query('DELETE FROM pipeline_runs WHERE run_id = ANY($1)', [testCRunIds])
        .catch(() => {
          return pool.query('DELETE FROM pipeline_runs WHERE id = ANY($1)', [testCRunIds]);
        });
    }
    if (testCWorkspaceIds.length > 0) {
      await pool.query('DELETE FROM workspaces WHERE id = ANY($1)', [testCWorkspaceIds]);
    }
    for (const p of testCSpecPaths) {
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    }
  });

  it('6 jobs enqueued, each handled exactly once across 2 workers (batchSize:3 each)', async () => {
    // Use a dedicated pg-boss instance with a separate queue name for Test C.
    // The queue name 'pipeline:run:lock-test' is isolated from 'pipeline:run'
    // so Test A's registered handlers won't consume these jobs.
    bossC = new PgBoss({
      connectionString: DB_URL,
      schema: 'pgboss',
      pollingIntervalSeconds: 1,
    });
    bossC.on('error', () => { /* suppress */ });
    await bossC.start();
    // Use a dedicated queue name — prevents cross-contamination with Test A's 'pipeline:run' handlers
    await bossC.createQueue('pipeline:run:lock-test');

    // Build 2 instrumented handlers — each records which workerId handled the job
    const makeInstrumentedHandler = (workerId: string) =>
      async (jobs: PgBoss.Job<Record<string, unknown>>[]): Promise<void> => {
        for (const job of jobs) {
          const data = job.data as { runId: number; specPath: string; workspacePath: string };
          const { runId } = data;
          if (!runId) continue;

          // Record the invocation (in-process map, no DB query needed)
          if (!handlerInvocations.has(runId)) {
            handlerInvocations.set(runId, []);
          }
          handlerInvocations.get(runId)!.push(workerId);

          // Run the standard handler so the job completes cleanly (WAL + output chunks)
          await handlePipelineRunInProcess([job]);
        }
      };

    // Register 2 subscriptions on the dedicated lock-test queue with batchSize:3 each (6 total slots).
    // pg-boss uses SELECT FOR UPDATE SKIP LOCKED — each job dispatched to exactly one handler.
    await bossC.work('pipeline:run:lock-test', { batchSize: 3 }, makeInstrumentedHandler('WORKER_A'));
    await bossC.work('pipeline:run:lock-test', { batchSize: 3 }, makeInstrumentedHandler('WORKER_B'));

    // Create 6 independent workspaces, each with 1 story
    for (let i = 0; i < 6; i++) {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}-c${i}`;
      const workspaceId = `test-conc-c-${suffix}`;
      const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-conc-c-'));

      await pool.query(
        `INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3)`,
        [workspaceId, `Lock Test WS ${i}`, workspacePath],
      );
      testCWorkspaceIds.push(workspaceId);

      const specJson = {
        title: `lock-test-spec-${suffix}`,
        userStories: [{
          id: 'US-001',
          title: 'Lock test story',
          description: 'pg-boss lock test',
          acceptanceCriteria: ['Works'],
          dependsOn: [],
          passes: false,
        }],
        model: 'claude-sonnet-4-5-20250929',
        generatedAt: new Date().toISOString(),
      };

      const specDir = path.join(workspacePath, 'forge', 'specs', 'approved');
      fs.mkdirSync(specDir, { recursive: true });
      const absSpecPath = path.join(specDir, `lock-test-spec-${suffix}.json`);
      fs.writeFileSync(absSpecPath, JSON.stringify(specJson, null, 2));
      testCSpecPaths.push(absSpecPath);

      const specPath = `forge/specs/approved/lock-test-spec-${suffix}.json`;

      // Insert run row + enqueue via bossC
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO pipeline_runs
           (spec_path, workspace_id, status, trigger_type, parallelism, agent, agent_type, agent_model, queued_at)
         VALUES ($1, $2, 'queued', 'manual', 1, 'claude', 'claude', NULL, NOW())
         RETURNING id`,
        [specPath, workspaceId],
      );
      const runId = rows[0].id;
      testCRunIds.push(runId);

      await bossC.send('pipeline:run:lock-test', {
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
    }

    // Wait for all 6 runs to complete
    const allDone = await waitFor(async () => {
      const { rows } = await pool.query<{ status: string }>(
        'SELECT status FROM pipeline_runs WHERE id = ANY($1)',
        [testCRunIds],
      );
      return rows.length === 6 && rows.every((r) => r.status === 'done');
    }, 30_000);

    expect(allDone).toBe(true);

    // Give a brief moment for all invocations to be recorded before asserting
    await new Promise((r) => setTimeout(r, 300));

    // Assert: every job was handled exactly once — no double-dispatch
    for (const runId of testCRunIds) {
      const invocations = handlerInvocations.get(runId);
      expect(invocations).toBeDefined();
      expect(invocations!.length).toBe(1);
    }

    // Assert: total invocations = total jobs (no skipped jobs)
    let total = 0;
    for (const runId of testCRunIds) {
      total += handlerInvocations.get(runId)?.length ?? 0;
    }
    expect(total).toBe(6);

    // Assert: no story_results duplicates across all 6 runs
    const { rows: dupRows } = await pool.query<{ run_id: number; story_id: string; cnt: string }>(
      `SELECT run_id, story_id, COUNT(*) as cnt
       FROM story_results
       WHERE run_id = ANY($1)
       GROUP BY run_id, story_id
       HAVING COUNT(*) > 1`,
      [testCRunIds],
    );
    expect(dupRows).toHaveLength(0);
  }, 45_000);
});
