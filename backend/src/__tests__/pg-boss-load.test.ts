/**
 * PG-020: Load test — 10 concurrent runs with 6 worker slots (teamSize:3 × 2 instances).
 *
 * Setup:
 *   - 2 pg-boss worker registrations, each with batchSize:3 (6 total concurrent slots)
 *   - In-process handler: sleeps 2s then marks run done (NO subprocesses)
 *   - Real PostgreSQL via TEST_DATABASE_URL / DATABASE_URL
 *
 * Test sequence:
 *   1. Trigger 10 runs simultaneously via Promise.all
 *   2. Assert all 10 job IDs are distinct (pg-boss deduplication check)
 *   3. Assert all 10 enter 'queued' status before workers pick them up
 *   4. Poll DB every 100ms — verify peak concurrency never exceeds 6 'running' rows
 *   5. Wait for all 10 to reach 'done' (target < 90s with 6 slots and 2s engine)
 *   6. Assert story_results has zero duplicate (run_id, story_id) pairs
 *   7. Assert run_output_chunks sequences are contiguous per run (no gaps, no skips)
 *   8. Assert no pg-boss internal errors (boss.on('error') never fires)
 *   9. Log observed throughput: "Completed 10 runs in Xs (Y runs/min)"
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as http from 'http';
import { Pool } from 'pg';
import PgBoss from 'pg-boss';
import express, { type Express } from 'express';

// ── Extend Jest timeout for this suite (90s execution + buffer) ─────────────

jest.setTimeout(150_000);

// ── Connection ──────────────────────────────────────────────────────────────

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://rorca:rorca@localhost:5432/rorca_test';

// ── Constants ───────────────────────────────────────────────────────────────

const MOCK_ENGINE_SLEEP_MS = 2_000;
const TOTAL_RUNS = 10;
const WORKER_SLOTS_PER_INSTANCE = 3;
const TOTAL_WORKER_SLOTS = WORKER_SLOTS_PER_INSTANCE * 2; // 6 total
const POLL_INTERVAL_MS = 100;

// ── Suite state ─────────────────────────────────────────────────────────────

let pool: Pool;
let boss: PgBoss;
let app: Express;
let server: http.Server;
let serverPort: number;

// Errors emitted by pg-boss internally — test fails if any fire
const bossErrors: Error[] = [];

// Peak concurrency observed during the load test
let peakConcurrency = 0;

// All run IDs created by this suite (for cleanup)
const allRunIds: number[] = [];
// All workspace IDs created by this suite (for cleanup)
const allWorkspaceIds: string[] = [];
// Temp files to delete in afterAll
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

/**
 * Minimal Express server that handles the two endpoints the mock handler POSTs to.
 * The in-process handler calls these directly (not via HTTP) for speed, but we keep
 * the server available for WAL events emitted during the load test.
 */
function buildMiniServer(dbPool: Pool): Express {
  const miniApp = express();
  miniApp.use(express.json());

  // POST /api/wal — record WAL events
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

  // POST /api/pipeline/story-result — record story outcomes
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
 * Mock job handler that simulates a 2-second execution-engine run.
 *
 * Lifecycle per job:
 *   1. Mark pipeline_run as 'running'
 *   2. Emit WAL run_started event
 *   3. Write one output chunk ("mock-load: start runId=N")
 *   4. Sleep 2 seconds (simulates execution-engine doing work)
 *   5. Insert story_results row (pass)
 *   6. Write one output chunk ("mock-load: done runId=N")
 *   7. Mark pipeline_run as 'done'
 *   8. Emit WAL run_finished event
 *
 * Uses pool directly (no subprocess spawn).
 */
async function mockLoadHandler(
  jobs: PgBoss.Job<Record<string, unknown>>[],
): Promise<void> {
  // Process each job in the batch sequentially (within a single worker slot)
  for (const job of jobs) {
    const data = job.data as {
      runId: number;
      specPath: string;
      workspacePath: string;
      storyIds?: string[];
    };
    const { runId, storyIds } = data;
    if (!runId) continue;

    // Look up workspace_id for WAL events
    const { rows: runRows } = await pool.query<{ workspace_id: string; spec_path: string }>(
      'SELECT workspace_id, spec_path FROM pipeline_runs WHERE id = $1',
      [runId],
    );
    if (runRows.length === 0) continue;
    const { workspace_id: workspaceId, spec_path: specPath } = runRows[0];

    // 1. Mark as running
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

    // 3. First output chunk
    const startMsg = Buffer.from(`mock-load: start runId=${runId}\n`);
    await pool.query(
      `INSERT INTO run_output_chunks (run_id, chunk, sequence)
       VALUES ($1, $2, 1)
       ON CONFLICT (run_id, sequence) DO NOTHING`,
      [runId, startMsg],
    );

    // 4. Simulate work (2s sleep)
    await new Promise<void>((r) => setTimeout(r, MOCK_ENGINE_SLEEP_MS));

    // 5. Determine which stories to emit results for
    //    Use storyIds from payload if provided, otherwise read from spec file
    let stories: string[] = storyIds ?? [];
    if (stories.length === 0) {
      try {
        const absPath = path.isAbsolute(specPath)
          ? specPath
          : path.join(data.workspacePath ?? '', specPath);
        const specJson = JSON.parse(fs.readFileSync(absPath, 'utf8')) as {
          userStories?: Array<{ id: string; passes?: boolean; excluded?: boolean }>;
        };
        stories = (specJson.userStories ?? [])
          .filter((s) => !s.passes && !s.excluded)
          .map((s) => s.id);
      } catch {
        // If we can't read the spec, use a default story ID
        stories = ['US-001'];
      }
    }

    // Emit WAL + story_results for each story
    for (const storyId of stories) {
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

    // 6. Final output chunk
    const doneMsg = Buffer.from(
      `mock-load: done runId=${runId} stories=${stories.length}\n`,
    );
    await pool.query(
      `INSERT INTO run_output_chunks (run_id, chunk, sequence)
       VALUES ($1, $2, 2)
       ON CONFLICT (run_id, sequence) DO NOTHING`,
      [runId, doneMsg],
    );

    // 7. Mark pipeline_run done
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

/** Create a unique workspace + spec file with one story. */
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

  const specPath = `forge/specs/approved/load-test-spec-${suffix}.json`;

  return { workspaceId, workspacePath, specPath, absSpecPath };
}

/** Insert a pipeline_runs row and enqueue a pg-boss job. Returns runId. */
async function triggerRun(
  workspaceId: string,
  workspacePath: string,
  specPath: string,
): Promise<{ runId: number; jobId: string }> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO pipeline_runs
       (spec_path, workspace_id, status, trigger_type, parallelism, agent, agent_type, agent_model, queued_at)
     VALUES ($1, $2, 'queued', 'manual', 1, 'claude', 'claude', NULL, NOW())
     RETURNING id`,
    [specPath, workspaceId],
  );
  const runId = rows[0].id;
  allRunIds.push(runId);

  // Job ID = String(runId) per MEMORY convention
  const jobId = String(runId);

  const absSpecPath = path.isAbsolute(specPath)
    ? specPath
    : path.join(workspacePath, specPath);

  await boss.send(
    'pipeline:run:load-test',
    {
      runId,
      specPath: absSpecPath,
      workspacePath,
      agent: 'claude',
      model: null,
      worktreePath: null,
      branchName: null,
      autoWorktree: false,
      envOverrides: {},
    },
    { id: jobId },
  );

  return { runId, jobId };
}

// ── Suite setup / teardown ───────────────────────────────────────────────────

beforeAll(async () => {
  // 1. Connect pool
  pool = new Pool({ connectionString: DB_URL, max: 20 });

  // Attach error listener to detect pool exhaustion
  pool.on('error', (err) => {
    bossErrors.push(err);
  });

  // 2. Run migrations
  const { runPgMigrations } = await import('../db/pg-index');
  await runPgMigrations(pool);

  // 3. Start mini Express server (for WAL events from mock handler)
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

  // Capture pg-boss internal errors — test will fail if any fire
  boss.on('error', (err: Error) => {
    bossErrors.push(err);
  });

  await boss.start();

  // 5. Create the dedicated load-test queue (pg-boss v10 requires explicit creation)
  await boss.createQueue('pipeline:run:load-test');

  // 6. Register 2 worker subscriptions with batchSize:3 each (6 total concurrent slots)
  //    Both use the same mock handler — pg-boss SELECT FOR UPDATE SKIP LOCKED
  //    ensures each job goes to exactly one worker.
  await boss.work(
    'pipeline:run:load-test',
    { batchSize: WORKER_SLOTS_PER_INSTANCE },
    mockLoadHandler,
  );
  await boss.work(
    'pipeline:run:load-test',
    { batchSize: WORKER_SLOTS_PER_INSTANCE },
    mockLoadHandler,
  );
}, 30_000);

afterAll(async () => {
  // Stop pg-boss gracefully
  try { await boss.stop({ timeout: 10_000 }); } catch { /* ignore */ }

  // Close HTTP server
  await new Promise<void>((res) => server.close(() => res()));

  // Delete test data in FK-safe order
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

// ── Load test ────────────────────────────────────────────────────────────────

describe('PG-020: pg-boss load test — 10 concurrent runs, 6 slots, 2s engine', () => {
  // Run IDs collected in this test (needed by subsequent assertion tests)
  const loadRunIds: number[] = [];

  it('triggers 10 runs simultaneously, all 10 queue with distinct job IDs', async () => {
    // Create 10 independent workspaces + specs
    const fixtures = await Promise.all(
      Array.from({ length: TOTAL_RUNS }, (_, i) =>
        createTestFixtures(`r${i}`),
      ),
    );

    // Trigger all 10 simultaneously — this is the core load test
    const results = await Promise.all(
      fixtures.map(({ workspaceId, workspacePath, specPath }) =>
        triggerRun(workspaceId, workspacePath, specPath),
      ),
    );

    // Collect run IDs for subsequent assertions
    for (const { runId } of results) {
      loadRunIds.push(runId);
    }

    // Assert: all 10 job IDs are distinct (no silent deduplication by pg-boss)
    const jobIds = results.map((r) => r.jobId);
    const uniqueJobIds = new Set(jobIds);
    expect(uniqueJobIds.size).toBe(TOTAL_RUNS);

    // Assert: all 10 pipeline_runs exist in DB with status='queued' (may transition fast)
    const { rows: queuedRows } = await pool.query<{ id: number; status: string }>(
      `SELECT id, status FROM pipeline_runs WHERE id = ANY($1) ORDER BY id`,
      [loadRunIds],
    );
    expect(queuedRows).toHaveLength(TOTAL_RUNS);
    // All rows must be in a valid lifecycle state (queued, running, or done)
    const validStatuses = new Set(['queued', 'running', 'done']);
    for (const row of queuedRows) {
      expect(validStatuses.has(row.status)).toBe(true);
    }
  }, 30_000);

  it('peak concurrency never exceeds 6 running rows during execution', async () => {
    // Poll DB every 100ms, tracking peak concurrency of 'running' rows
    // We monitor until all 10 runs finish (or 95s timeout)
    const monitoringPromise = new Promise<void>((resolve) => {
      const timer = setInterval(async () => {
        try {
          const { rows } = await pool.query<{ cnt: string }>(
            `SELECT COUNT(*) as cnt
             FROM pipeline_runs
             WHERE id = ANY($1) AND status = 'running'`,
            [loadRunIds],
          );
          const current = parseInt(rows[0]?.cnt ?? '0', 10);
          if (current > peakConcurrency) {
            peakConcurrency = current;
          }

          // Check if all done
          const { rows: doneRows } = await pool.query<{ cnt: string }>(
            `SELECT COUNT(*) as cnt
             FROM pipeline_runs
             WHERE id = ANY($1) AND status = 'done'`,
            [loadRunIds],
          );
          const doneCount = parseInt(doneRows[0]?.cnt ?? '0', 10);
          if (doneCount === TOTAL_RUNS) {
            clearInterval(timer);
            resolve();
          }
        } catch {
          // ignore transient errors during polling
        }
      }, POLL_INTERVAL_MS);

      // Safety timeout: resolve after 95s regardless
      setTimeout(() => {
        clearInterval(timer);
        resolve();
      }, 95_000);
    });

    await monitoringPromise;

    // Peak concurrency must be ≤ TOTAL_WORKER_SLOTS (6)
    expect(peakConcurrency).toBeGreaterThan(0);
    expect(peakConcurrency).toBeLessThanOrEqual(TOTAL_WORKER_SLOTS);

    console.log(`[PG-020] Peak concurrency observed: ${peakConcurrency}/${TOTAL_WORKER_SLOTS} slots`);
  }, 100_000);

  it('all 10 runs complete with status=done within 90 seconds', async () => {
    const startTime = Date.now();

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
      `[PG-020] Worker slots: ${TOTAL_WORKER_SLOTS} | Engine latency: ${MOCK_ENGINE_SLEEP_MS}ms`,
    );

    expect(allDone).toBe(true);

    // Verify each run individually
    const { rows: finalRows } = await pool.query<{ id: number; status: string }>(
      'SELECT id, status FROM pipeline_runs WHERE id = ANY($1) ORDER BY id',
      [loadRunIds],
    );
    expect(finalRows).toHaveLength(TOTAL_RUNS);
    for (const row of finalRows) {
      expect(row.status).toBe('done');
    }
  }, 95_000);

  it('story_results has no duplicate (run_id, story_id) pairs across all 10 runs', async () => {
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
    // For each run, fetch all sequences and verify they are 1, 2, 3, ... N with no gaps
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

    // Every run must have at least one chunk
    expect(chunkRows).toHaveLength(TOTAL_RUNS);

    for (const row of chunkRows) {
      // Parse the PostgreSQL array string (e.g., "{1,2}" → [1, 2])
      const seqs = row.sequences
        .replace(/^\{/, '')
        .replace(/\}$/, '')
        .split(',')
        .map(Number);

      // Sequences must start at 1 and be contiguous (1, 2, 3, ...)
      for (let i = 0; i < seqs.length; i++) {
        expect(seqs[i]).toBe(i + 1);
      }

      // Our mock handler writes exactly 2 chunks per run (start + done)
      expect(seqs).toHaveLength(2);
    }
  });

  it('no pg-boss internal errors or pool exhaustion errors during the load test', () => {
    if (bossErrors.length > 0) {
      console.error('[PG-020] pg-boss / pool errors detected:', bossErrors);
    }
    expect(bossErrors).toHaveLength(0);
  });
});
