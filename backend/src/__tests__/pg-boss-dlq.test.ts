/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * PG-018: Dead-Letter Queue (DLQ) lifecycle integration test.
 *
 * Tests the complete DLQ lifecycle end-to-end:
 *   1. Trigger a run backed by a failing mock engine (always exits 1)
 *   2. pg-boss exhausts 3 attempts (retryLimit:2 = 1 initial + 2 retries, retryDelay:1s each)
 *   3. Job lands in pgboss.archive with state='failed'
 *   4. Worker DLQ poll detects failure → emits 'run_dlq' WAL event
 *   5. GET /api/pipeline/runs/:id/dlq returns { jobId, lastError, attempts:3, failedAt, originalPayload }
 *   6. POST /api/pipeline/runs/:id/dlq/retry creates new run with retried_from_run_id=original
 *   7. Retry run uses a passing mock engine → completes successfully (status='done')
 *   8. Original run status remains 'failed' (not mutated)
 *
 * Architecture notes:
 * - Uses a real PostgreSQL test database (TEST_DATABASE_URL / DATABASE_URL)
 * - In-process pg-boss (pollingIntervalSeconds: 1)
 * - Failing mock engine: temp shell script (#!/bin/sh; exit 1)
 * - Passing mock engine: mock-engine.ts fixture
 * - Mini Express server with DLQ routes (avoids production getBoss() singleton)
 * - DLQ WAL event emitted by pollDlqOnce() helper (mirrors worker.ts pollDlq())
 * - retryLimit:2 → 3 total attempts, retryDelay:1 → 1s between attempts
 *
 * pg-boss archive schema note:
 * - pgboss.archive column names use snake_case with underscores: retry_count, retry_limit, archived_on
 * - retry_count = number of retries consumed. After retryLimit:2 exhaustion: retry_count = 2.
 * - Total attempts = retry_count + 1 (for the initial attempt) = 3
 * - Use (data->>'runId') = $1 to correlate archive row to pipeline run
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as http from 'http';
import { spawn, type ChildProcess } from 'child_process';
import { Pool } from 'pg';
import PgBoss from 'pg-boss';
import express, { type Express, type Request, type Response } from 'express';
import { assertConnectedTestDatabase, resolveTestDatabaseUrl } from '../lib/test-db-safety';
import { pgBossTestSchema } from './helpers/pg-boss-test-schema';

// ── DB URL ─────────────────────────────────────────────────────────────────────

const DB_URL = resolveTestDatabaseUrl();
const BOSS_SCHEMA = pgBossTestSchema('dlq');

// ── Paths ──────────────────────────────────────────────────────────────────────

const MOCK_ENGINE_PATH = path.join(__dirname, 'fixtures', 'mock-engine.ts');
const TSX_BIN = path.join(__dirname, '..', '..', 'node_modules', '.bin', 'tsx');
const CHUNK_SIZE = 4 * 1024;

// ── Timing constants ───────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 300;
// 3 attempts × ~1-2s + maintenance cycle ~2s + startup overhead = ~10s; give 25s margin
const MAX_WAIT_DLQ_MS = 25_000;
const MAX_WAIT_RUN_MS = 20_000;   // final retry run with passing engine

// ── Jest timeout ───────────────────────────────────────────────────────────────

jest.setTimeout(90_000);

// ── Helpers ────────────────────────────────────────────────────────────────────

async function waitFor(
  predicate: () => Promise<boolean>,
  maxMs = MAX_WAIT_DLQ_MS,
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

// ── Test-scope state ───────────────────────────────────────────────────────────

let pool: Pool;
let boss: PgBoss;
let app: Express;
let server: http.Server;
let serverPort: number;

// Run IDs created per test — for cleanup
const testRunIds: number[] = [];
const testWorkspaceIds: string[] = [];
const tempSpecPaths: string[] = [];
const tempScriptPaths: string[] = [];
const activeChildren: ChildProcess[] = [];

// Seen DLQ job IDs (mirrors worker.ts seenDlqJobIds for dedup)
const seenDlqJobIds = new Set<string>();

// ── Suite setup / teardown ────────────────────────────────────────────────────

beforeAll(async () => {
  // 1. Connect pool
  pool = new Pool({ connectionString: DB_URL, max: 5 });
  await assertConnectedTestDatabase(pool, DB_URL);

  // 2. Run migrations
  const { runPgMigrations } = await import('../db/pg-index');
  await runPgMigrations(pool);

  // 3. Start mini Express server (handles WAL + story-result + DLQ routes)
  app = buildMiniServer();
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      serverPort = (server.address() as { port: number }).port;
      resolve();
    });
  });

  // 4. Start pg-boss with fast polling AND fast archiving (for DLQ tests)
  boss = new PgBoss({
    connectionString: DB_URL,
    schema: BOSS_SCHEMA,
    pollingIntervalSeconds: 1,
    maintenanceIntervalSeconds: 2,        // Run maintenance every 2s (archive failed/completed jobs)
    archiveCompletedAfterSeconds: 1,      // Archive jobs 1s after completion (minimum allowed)
  });
  boss.on('error', () => { /* suppress noise */ });
  await boss.start();

  // 5. Create queues (pg-boss v10 requires explicit creation)
  await boss.createQueue('pipeline:run');

  // 6. Register in-process worker
  await boss.work('pipeline:run', handlePipelineRunInProcess);
}, 45_000);

afterAll(async () => {
  for (const child of activeChildren) {
    try { child.kill(); } catch { /* ignore */ }
  }
  try { await boss.stop({ timeout: 5_000 }); } catch { /* ignore */ }
  await new Promise<void>((res) => server.close(() => res()));
  await pool.end();
}, 20_000);

afterEach(async () => {
  const ids = [...testRunIds];
  testRunIds.length = 0;

  if (ids.length > 0) {
    await pool.query('DELETE FROM run_output_chunks WHERE run_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM story_results WHERE run_id = ANY($1)', [ids]);
    await pool.query(
      `DELETE FROM wal_events WHERE (payload->>'runId')::text = ANY($1::text[])
          OR (payload->>'run_id')::text = ANY($1::text[])`,
      [ids.map(String)],
    );
    // Delete retry runs first (FK retried_from_run_id → pipeline_runs.id)
    await pool.query(
      'DELETE FROM pipeline_runs WHERE retried_from_run_id = ANY($1)',
      [ids],
    );
    await pool.query('DELETE FROM pipeline_runs WHERE id = ANY($1)', [ids]);
  }

  if (testWorkspaceIds.length > 0) {
    const wsIds = [...testWorkspaceIds];
    testWorkspaceIds.length = 0;
    await pool.query('DELETE FROM workspaces WHERE id = ANY($1)', [wsIds]);
  }

  for (const p of tempSpecPaths.splice(0)) {
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }

  for (const p of tempScriptPaths.splice(0)) {
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }

  seenDlqJobIds.clear();
});

// ── Failing engine script ──────────────────────────────────────────────────────

/**
 * Write a temp shell script that always exits 1.
 * The in-process worker passes FAILING_ENGINE_SCRIPT in envOverrides to indicate
 * it should spawn this script instead of mock-engine.ts.
 */
function createFailingEngineScript(): string {
  const dir = os.tmpdir();
  const scriptPath = path.join(dir, `failing-engine-${Date.now()}.sh`);
  fs.writeFileSync(scriptPath, '#!/bin/sh\necho "failing-engine: exiting with code 1" >&2\nexit 1\n');
  fs.chmodSync(scriptPath, 0o755);
  tempScriptPaths.push(scriptPath);
  return scriptPath;
}

// ── In-process worker ─────────────────────────────────────────────────────────

/**
 * Handles pipeline:run jobs in-process.
 * - If envOverrides.FAILING_ENGINE_SCRIPT is set: spawns that script (always exits 1)
 * - Otherwise: spawns mock-engine.ts (exits 0, emits WAL events)
 *
 * Uses retryLimit set on the job itself (pg-boss will retry on non-zero exit).
 */
async function handlePipelineRunInProcess(
  jobs: PgBoss.Job<Record<string, unknown>>[],
): Promise<void> {
  for (const job of jobs) {
    const data = job.data as {
      runId: number;
      specPath: string;
      workspacePath: string;
      agent: string;
      envOverrides?: Record<string, string>;
    };
    const { runId, specPath, workspacePath, envOverrides = {} } = data;
    if (!runId || !specPath || !workspacePath) continue;

    // Look up workspace_id
    const { rows: runRows } = await pool.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM pipeline_runs WHERE id = $1',
      [runId],
    );
    if (runRows.length === 0) return;
    const workspaceId = runRows[0].workspace_id;

    // Mark running
    await pool.query(
      `UPDATE pipeline_runs SET status = 'running', started_at = NOW() WHERE id = $1`,
      [runId],
    );
    await pool.query(
      `INSERT INTO wal_events (event_type, workspace_id, payload)
       VALUES ('run_started', $1, $2)`,
      [workspaceId, JSON.stringify({ run_id: runId, spec_path: specPath })],
    );

    const failingScript = envOverrides.FAILING_ENGINE_SCRIPT;

    let child: ChildProcess;
    if (failingScript) {
      // Use the shell script that exits 1
      child = spawn(failingScript, [], {
        cwd: workspacePath,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...envOverrides, RORCA_PROCESS_ROLE: 'engine' },
      });
    } else {
      // Use the passing mock-engine
      const absSpecPath = path.isAbsolute(specPath)
        ? specPath
        : path.join(workspacePath, specPath);
      child = spawn(
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
    }

    activeChildren.push(child);
    if (child.pid) {
      await pool.query('UPDATE pipeline_runs SET pid = $1 WHERE id = $2', [child.pid, runId]);
    }

    // Capture output → chunks
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
        await writeChunk(runId, seqRef, pending.slice(0, CHUNK_SIZE));
        pending = pending.slice(CHUNK_SIZE);
      }
    };
    child.stdout?.on('data', (d: Buffer) => { void handleData(d); });
    child.stderr?.on('data', (d: Buffer) => { void handleData(d); });

    // Wait for the child to exit. Capture exit code for pg-boss retry signaling.
    const exitCode = await new Promise<number>((resolve) => {
      child.on('exit', (code) => {
        const idx = activeChildren.indexOf(child);
        if (idx !== -1) activeChildren.splice(idx, 1);
        resolve(code ?? 1);
      });
      child.on('error', () => {
        const idx = activeChildren.indexOf(child);
        if (idx !== -1) activeChildren.splice(idx, 1);
        resolve(1);
      });
    });

    await flush();

    const status = exitCode === 0 ? 'done' : 'failed';
    await pool.query(
      `UPDATE pipeline_runs SET status = $1, finished_at = NOW() WHERE id = $2`,
      [status, runId],
    );
    await pool.query(
      `INSERT INTO wal_events (event_type, workspace_id, payload)
       VALUES ('run_finished', $1, $2)`,
      [workspaceId, JSON.stringify({ run_id: runId, status, exit_code: exitCode })],
    );

    // pg-boss retries the job when the handler throws.
    // Throw AFTER updating DB state so the run row is marked failed
    // on each attempt (pg-boss will re-run this handler on retry).
    if (exitCode !== 0) {
      throw new Error(`engine exited with code ${exitCode}`);
    }
  }
}

// ── DLQ poll helper ───────────────────────────────────────────────────────────

/**
 * Mirrors worker.ts pollDlq() — queries pgboss.archive for failed pipeline jobs
 * and emits run_dlq WAL events. Called manually in tests (no 60s polling wait).
 */
async function pollDlqOnce(): Promise<void> {
  type DlqRow = {
    id: string;
    name: string;
    output: unknown;
    retry_count: number;
    archived_on: string;
    data: Record<string, unknown>;
  };
  const rows = await pool.query<DlqRow>(
    `SELECT id, name, output, retry_count, archived_on, data
     FROM ${BOSS_SCHEMA}.archive
     WHERE name IN ('pipeline:run', 'pipeline:retry')
       AND state = 'failed'
       AND archived_on > NOW() - INTERVAL '1 day'
     ORDER BY archived_on DESC`,
  ).then((r) => r.rows).catch(() => [] as DlqRow[]);

  for (const row of rows) {
    if (seenDlqJobIds.has(row.id)) continue;
    seenDlqJobIds.add(row.id);

    const runId = typeof row.data?.runId === 'number' ? row.data.runId : undefined;
    if (!runId) continue;

    const runRow = await pool.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM pipeline_runs WHERE id = $1',
      [runId],
    ).then((r) => r.rows[0]).catch(() => undefined);
    if (!runRow) continue;

    const lastError = typeof row.output === 'string'
      ? row.output
      : (row.output != null ? JSON.stringify(row.output) : null);

    await pool.query(
      `INSERT INTO wal_events (event_type, workspace_id, payload)
       VALUES ('run_dlq', $1, $2)`,
      [
        runRow.workspace_id,
        JSON.stringify({
          runId,
          jobId: row.id,
          jobName: row.name,
          lastError,
          attempts: row.retry_count,
        }),
      ],
    );
  }
}

// ── Chunk writer ──────────────────────────────────────────────────────────────

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

// ── Mini Express server ───────────────────────────────────────────────────────

/**
 * Minimal server that handles the endpoints needed for this test:
 *   POST /api/wal                        — insert WAL event
 *   POST /api/pipeline/story-result      — insert story result
 *   GET  /api/pipeline/runs/:id/dlq      — DLQ lookup (mirrors pipeline.ts)
 *   POST /api/pipeline/runs/:id/dlq/retry — DLQ retry (mirrors pipeline.ts)
 *
 * The DLQ routes are implemented inline so they use the test's pool and boss
 * instance rather than the production singleton from lib/pg-boss.ts.
 */
function buildMiniServer(): Express {
  const miniApp = express();
  miniApp.use(express.json());

  // WAL event insertion
  miniApp.post('/api/wal', async (req: Request, res: Response) => {
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

  // Story result
  miniApp.post('/api/pipeline/story-result', async (req: Request, res: Response) => {
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

  // GET /api/pipeline/runs/:id/dlq — mirrors pipeline.ts implementation
  miniApp.get('/api/pipeline/runs/:id/dlq', async (req: Request, res: Response) => {
    const runId = parseInt(req.params.id as string, 10);
    if (isNaN(runId)) { res.status(400).json({ error: 'Invalid run ID' }); return; }

    try {
      const { rows } = await pool.query<{
        id: string;
        output: unknown;
        retry_count: number;
        archived_on: string;
        data: unknown;
      }>(
        `SELECT id, output, retry_count, archived_on, data
         FROM ${BOSS_SCHEMA}.archive
         WHERE name IN ('pipeline:run', 'pipeline:retry')
           AND state = 'failed'
           AND data->>'runId' = $1
         ORDER BY archived_on DESC
         LIMIT 1`,
        [String(runId)],
      ).catch(() => ({ rows: [] as { id: string; output: unknown; retry_count: number; archived_on: string; data: unknown }[] }));

      if (rows.length === 0) {
        res.status(404).json({ error: 'Run not in DLQ' });
        return;
      }

      const row = rows[0];
      const lastError = typeof row.output === 'string'
        ? row.output
        : (row.output != null ? JSON.stringify(row.output) : null);

      res.json({
        jobId: row.id,
        lastError,
        attempts: (row.retry_count ?? 0) + 1,  // retry_count=retries used; +1 for initial attempt
        failedAt: row.archived_on,
        originalPayload: row.data,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/pipeline/runs/:id/dlq/retry — mirrors pipeline.ts implementation
  miniApp.post('/api/pipeline/runs/:id/dlq/retry', async (req: Request, res: Response) => {
    const originalRunId = parseInt(req.params.id as string, 10);
    if (isNaN(originalRunId)) { res.status(400).json({ error: 'Invalid run ID' }); return; }

    try {
      const { rows: runRows } = await pool.query<{
        id: number;
        spec_path: string;
        workspace_id: string;
        status: string;
        agent: string;
        agent_type: string;
        agent_model: string | null;
        branch_name: string | null;
        worktree_path: string | null;
      }>(
        `SELECT id, spec_path, workspace_id, status, agent, agent_type, agent_model, branch_name, worktree_path
         FROM pipeline_runs WHERE id = $1`,
        [originalRunId],
      );

      if (runRows.length === 0) { res.status(404).json({ error: 'Run not found' }); return; }
      const originalRun = runRows[0];

      if (originalRun.status !== 'failed') {
        res.status(409).json({ error: `Run is in '${originalRun.status}' state — only 'failed' runs can be retried from DLQ` });
        return;
      }

      const { rows: wsRows } = await pool.query<{ path: string }>(
        'SELECT path FROM workspaces WHERE id = $1',
        [originalRun.workspace_id],
      );
      if (wsRows.length === 0) { res.status(404).json({ error: 'Workspace not found' }); return; }
      const workspacePath = wsRows[0].path;

      const { rows: newRunRows } = await pool.query<{ id: number }>(
        `INSERT INTO pipeline_runs
           (spec_path, workspace_id, status, trigger_type, retried_from_run_id, agent, agent_type, agent_model, queued_at)
         VALUES ($1, $2, 'queued', 'dlq-retry', $3, $4, $5, $6, NOW())
         RETURNING id`,
        [
          originalRun.spec_path,
          originalRun.workspace_id,
          originalRunId,
          originalRun.agent,
          originalRun.agent_type,
          originalRun.agent_model,
        ],
      );
      const newRunId = Number(newRunRows[0].id);
      testRunIds.push(newRunId);

      const jobPayload = {
        runId: newRunId,
        specPath: originalRun.spec_path,
        workspacePath,
        agent: (originalRun.agent_type ?? originalRun.agent ?? 'claude') as 'claude' | 'opencode' | 'codex',
        model: originalRun.agent_model ?? null,
        worktreePath: originalRun.worktree_path ?? null,
        branchName: originalRun.branch_name ?? null,
        autoWorktree: false,
        envOverrides: {},  // No FAILING_ENGINE_SCRIPT → uses passing mock-engine
      };

      await boss.send('pipeline:run', jobPayload);

      await pool.query(
        `INSERT INTO wal_events (event_type, workspace_id, payload)
         VALUES ('run_started', $1, $2)`,
        [
          originalRun.workspace_id,
          JSON.stringify({ runId: newRunId, originalRunId, trigger: 'dlq-retry', specPath: originalRun.spec_path }),
        ],
      );

      res.status(201).json({ ok: true, runId: newRunId, originalRunId });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return miniApp;
}

// ── HTTP helper for miniServer ────────────────────────────────────────────────

async function fetchJSON<T>(
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const data = body ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: serverPort,
        path: urlPath,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': String(Buffer.byteLength(data)) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) as T });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: raw as unknown as T });
          }
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── Test fixtures ─────────────────────────────────────────────────────────────

async function createTestFixtures(storyCount = 1): Promise<{
  workspaceId: string;
  workspacePath: string;
  specPath: string;
  absSpecPath: string;
}> {
  const workspaceId = `test-ws-dlq-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-dlq-'));

  await pool.query(
    `INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3)`,
    [workspaceId, 'DLQ Test Workspace', workspacePath],
  );
  testWorkspaceIds.push(workspaceId);

  const userStories = Array.from({ length: storyCount }, (_, i) => ({
    id: `US-${String(i + 1).padStart(3, '0')}`,
    title: `DLQ test story ${i + 1}`,
    description: 'DLQ integration test story',
    acceptanceCriteria: ['It works'],
    dependsOn: [],
    passes: false,
  }));

  const specJson = {
    title: 'dlq-test-spec',
    userStories,
    model: 'claude-sonnet-4-5-20250929',
    generatedAt: new Date().toISOString(),
  };

  const specDir = path.join(workspacePath, 'forge', 'specs', 'approved');
  fs.mkdirSync(specDir, { recursive: true });
  const absSpecPath = path.join(specDir, 'dlq-test-spec.json');
  fs.writeFileSync(absSpecPath, JSON.stringify(specJson, null, 2));
  tempSpecPaths.push(absSpecPath);

  const specPath = 'forge/specs/approved/dlq-test-spec.json';

  return { workspaceId, workspacePath, specPath, absSpecPath };
}

/**
 * Insert a pipeline_run row + pg-boss job with the failing engine configured.
 * pg-boss retryLimit:2 = 1 initial + 2 retries = 3 total attempts.
 * retryDelay:1 = 1 second between attempts.
 */
async function triggerFailingRun(
  workspaceId: string,
  workspacePath: string,
  specPath: string,
  failingScript: string,
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO pipeline_runs
       (spec_path, workspace_id, status, trigger_type, parallelism, agent, agent_type, agent_model, queued_at)
     VALUES ($1, $2, 'queued', 'manual', 1, 'claude', 'claude', NULL, NOW())
     RETURNING id`,
    [specPath, workspaceId],
  );
  const runId = Number(rows[0].id);
  testRunIds.push(runId);

  // Send job with retryLimit:2 (3 total attempts) and retryDelay:1s
  await boss.send(
    'pipeline:run',
    {
      runId,
      specPath,
      workspacePath,
      agent: 'claude',
      model: null,
      worktreePath: null,
      branchName: null,
      autoWorktree: false,
      envOverrides: { FAILING_ENGINE_SCRIPT: failingScript },
    },
    {
      retryLimit: 2,
      retryDelay: 1,
    },
  );

  return runId;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('pg-boss DLQ — complete lifecycle', () => {
  it('should exhaust 3 attempts, land in archive, emit run_dlq, support retry', async () => {
    // ── Setup ────────────────────────────────────────────────────────────────

    const { workspaceId, workspacePath, specPath } = await createTestFixtures(1);
    const failingScript = createFailingEngineScript();

    // ── Step 1: Trigger a run with the failing engine ─────────────────────────

    const runId = await triggerFailingRun(workspaceId, workspacePath, specPath, failingScript);

    // ── Step 2: Wait for pg-boss to exhaust 3 attempts → job in pgboss.archive ─

    const archivedAsFailed = await waitFor(
      async () => {
        const { rows } = await pool.query<{ state: string }>(
          `SELECT state::text FROM ${BOSS_SCHEMA}.archive
           WHERE name IN ('pipeline:run', 'pipeline:retry')
             AND state = 'failed'
             AND (data->>'runId')::int = $1
           LIMIT 1`,
          [runId],
        );
        return rows.length > 0 && rows[0].state === 'failed';
      },
      MAX_WAIT_DLQ_MS,
    );

    expect(archivedAsFailed).toBe(true);

    // ── Step 3: Verify pgboss.archive has state='failed' ─────────────────────

    const { rows: archiveRows } = await pool.query<{
      id: string;
      state: string;
      retry_count: number;
      data: Record<string, unknown>;
    }>(
      `SELECT id, state::text, retry_count, data
       FROM ${BOSS_SCHEMA}.archive
       WHERE name IN ('pipeline:run', 'pipeline:retry')
         AND state = 'failed'
         AND (data->>'runId')::int = $1
       ORDER BY archived_on DESC
       LIMIT 1`,
      [runId],
    );

    expect(archiveRows).toHaveLength(1);
    expect(archiveRows[0].state).toBe('failed');
    // retry_count reflects retries used. With retryLimit:2, after exhaustion retry_count = 2.
    // Total attempts = retry_count + 1 = 3.
    expect(archiveRows[0].retry_count).toBe(2);
    expect(archiveRows[0].data.runId).toBe(runId);

    const archivedJobId = archiveRows[0].id;

    // ── Step 4: Emit run_dlq WAL event (mirrors worker.ts pollDlq) ──────────

    await pollDlqOnce();

    // Verify WAL event was emitted
    const { rows: dlqWalRows } = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM wal_events
       WHERE event_type = 'run_dlq' AND workspace_id = $1`,
      [workspaceId],
    );

    expect(dlqWalRows).toHaveLength(1);
    const dlqWalPayload = dlqWalRows[0].payload;
    expect(dlqWalPayload.runId).toBe(runId);
    expect(dlqWalPayload.jobId).toBe(archivedJobId);

    // ── Step 5: GET /api/pipeline/runs/:id/dlq ───────────────────────────────

    const dlqResp = await fetchJSON<{
      jobId: string;
      lastError: string | null;
      attempts: number;
      failedAt: string;
      originalPayload: Record<string, unknown>;
    }>('GET', `/api/pipeline/runs/${runId}/dlq`);

    expect(dlqResp.status).toBe(200);
    expect(dlqResp.body.jobId).toBe(archivedJobId);
    expect(dlqResp.body.attempts).toBe(3);    // 1 initial + 2 retries
    expect(dlqResp.body.failedAt).toBeTruthy();
    expect(typeof dlqResp.body.originalPayload).toBe('object');
    // Deep equality of the original payload
    expect(dlqResp.body.originalPayload.runId).toBe(runId);
    expect(dlqResp.body.originalPayload.specPath).toBe(specPath);
    expect(dlqResp.body.originalPayload.workspacePath).toBe(workspacePath);
    expect(dlqResp.body.originalPayload.agent).toBe('claude');

    // Original run status must be 'failed'
    const { rows: origRows } = await pool.query<{ status: string }>(
      'SELECT status FROM pipeline_runs WHERE id = $1',
      [runId],
    );
    expect(origRows[0].status).toBe('failed');

    // ── Step 6: POST /api/pipeline/runs/:id/dlq/retry ────────────────────────

    const retryResp = await fetchJSON<{
      ok: boolean;
      runId: number;
      originalRunId: number;
    }>('POST', `/api/pipeline/runs/${runId}/dlq/retry`);

    expect(retryResp.status).toBe(201);
    expect(retryResp.body.ok).toBe(true);
    expect(retryResp.body.originalRunId).toBe(runId);

    const retryRunId = retryResp.body.runId;
    expect(retryRunId).toBeGreaterThan(0);
    expect(retryRunId).not.toBe(runId);

    // ── Step 7: Verify new run has retried_from_run_id set ───────────────────

    const { rows: newRunRows } = await pool.query<{
      status: string;
      retried_from_run_id: number;
      trigger_type: string;
    }>(
      'SELECT status, retried_from_run_id, trigger_type FROM pipeline_runs WHERE id = $1',
      [retryRunId],
    );

    expect(newRunRows).toHaveLength(1);
    expect(Number(newRunRows[0].retried_from_run_id)).toBe(runId);
    expect(newRunRows[0].trigger_type).toBe('dlq-retry');

    // ── Step 8: Original run remains 'failed' (not mutated) ──────────────────

    const { rows: origFinalRows } = await pool.query<{ status: string }>(
      'SELECT status FROM pipeline_runs WHERE id = $1',
      [runId],
    );
    expect(origFinalRows[0].status).toBe('failed');

    // ── Step 9: Retry run completes successfully with passing engine ──────────

    const retryDone = await waitFor(
      async () => {
        const { rows: r } = await pool.query<{ status: string }>(
          'SELECT status FROM pipeline_runs WHERE id = $1',
          [retryRunId],
        );
        return r.length > 0 && r[0].status === 'done';
      },
      MAX_WAIT_RUN_MS,
    );

    expect(retryDone).toBe(true);

    // Verify story results were created for the retry run
    const { rows: storyRows } = await pool.query<{ status: string }>(
      'SELECT status FROM story_results WHERE run_id = $1',
      [retryRunId],
    );
    expect(storyRows.length).toBeGreaterThan(0);
    expect(storyRows.every((r) => r.status === 'pass')).toBe(true);

    // Final check: original run still 'failed'
    const { rows: origFinalCheck } = await pool.query<{ status: string }>(
      'SELECT status FROM pipeline_runs WHERE id = $1',
      [runId],
    );
    expect(origFinalCheck[0].status).toBe('failed');
  });

  // ── Edge case: GET /dlq returns 404 for non-failed run ───────────────────────

  it('should return 404 from GET /dlq for a run not in the DLQ', async () => {
    const { workspaceId, workspacePath, specPath } = await createTestFixtures(1);

    // Insert a run row in 'queued' status (not failed, not in archive)
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO pipeline_runs
         (spec_path, workspace_id, status, trigger_type, parallelism, agent, agent_type, queued_at)
       VALUES ($1, $2, 'queued', 'manual', 1, 'claude', 'claude', NOW())
       RETURNING id`,
      [specPath, workspaceId],
    );
    const runId = Number(rows[0].id);
    testRunIds.push(runId);

    const resp = await fetchJSON<{ error: string }>('GET', `/api/pipeline/runs/${runId}/dlq`);
    expect(resp.status).toBe(404);
  });

  // ── Edge case: POST /dlq/retry returns 409 for non-failed run ────────────────

  it('should return 409 from POST /dlq/retry for a run not in failed state', async () => {
    const { workspaceId, workspacePath, specPath } = await createTestFixtures(1);

    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO pipeline_runs
         (spec_path, workspace_id, status, trigger_type, parallelism, agent, agent_type, queued_at)
       VALUES ($1, $2, 'queued', 'manual', 1, 'claude', 'claude', NOW())
       RETURNING id`,
      [specPath, workspaceId],
    );
    const runId = Number(rows[0].id);
    testRunIds.push(runId);

    const resp = await fetchJSON<{ error: string }>('POST', `/api/pipeline/runs/${runId}/dlq/retry`);
    expect(resp.status).toBe(409);
    expect(resp.body.error).toContain('queued');
  });
});
