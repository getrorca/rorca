#!/usr/bin/env node
/**
 * rolling-worker.ts — Minimal pg-boss worker for zero-downtime rolling deploy tests.
 *
 * Behaviour:
 *  1. Reads DATABASE_URL from env (required), WORKER_PORT for the mock server port.
 *  2. Starts pg-boss (pollingIntervalSeconds:1) and creates the pipeline:run queue.
 *  3. Registers a handler that spawns the mock engine for each job:
 *     - Validates Zod payload
 *     - Marks pipeline_runs.status='running' + records worker_id
 *     - Increments in-flight counter
 *     - Spawns the mock-engine (10s sleep) as a child process
 *     - Decrements in-flight counter on exit
 *     - Marks run 'done' or 'failed'
 *  4. On SIGTERM:
 *     - Logs "[worker] draining, waiting for N in-flight jobs..."
 *     - Calls boss.stop({ graceful: true, timeout: 60000 }) which drains in-flight
 *     - Exits 0 when done
 *
 * Invocation:
 *   DATABASE_URL=... WORKER_PORT=<port> npx tsx rolling-worker.ts
 */

import 'dotenv/config';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { spawn, type ChildProcess } from 'child_process';
import { Pool } from 'pg';
import PgBoss from 'pg-boss';
import { z } from 'zod';

// ── Config ────────────────────────────────────────────────────────────────────

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  process.stderr.write('[rolling-worker] DATABASE_URL is not set — exiting\n');
  process.exit(1);
}

const WORKER_PORT = process.env.WORKER_PORT ?? '3030';
const WORKER_ID = crypto.randomUUID();
const CHUNK_SIZE = 4 * 1024; // 4 KB

const TSX_BIN = path.join(__dirname, '..', '..', '..', 'node_modules', '.bin', 'tsx');
const MOCK_ENGINE_PATH = path.join(__dirname, 'ten-second-mock-engine.ts');

// ── Database pool ─────────────────────────────────────────────────────────────

const pool = new Pool({ connectionString: DB_URL, max: 5 });

// ── In-flight counter ─────────────────────────────────────────────────────────

let inFlightCount = 0;

// ── Zod payload schema (mirrors PipelineRunJobPayload from pg-boss-schemas.ts) ─

const PipelineRunPayloadSchema = z.object({
  runId: z.number().int().positive(),
  specPath: z.string().min(1),
  workspacePath: z.string().min(1),
  agent: z.enum(['claude', 'opencode', 'codex', 'pi']).default('claude'),
  model: z.string().nullable().default(null),
  worktreePath: z.string().nullable().default(null),
  branchName: z.string().nullable().default(null),
  autoWorktree: z.boolean().default(false),
  envOverrides: z.record(z.string(), z.string()).default({}),
});

// ── Chunk writer ──────────────────────────────────────────────────────────────

async function writeChunk(runId: number, sequence: number, data: Buffer): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO run_output_chunks (run_id, chunk, sequence)
       VALUES ($1, $2, $3)
       ON CONFLICT (run_id, sequence) DO NOTHING`,
      [runId, data, sequence],
    );
  } catch {
    // best-effort
  }
}

// ── Single-job handler (runs one job, called in parallel per batch) ───────────

async function runOneJob(job: PgBoss.Job<Record<string, unknown>>): Promise<void> {
    // 1. Validate payload — do this before incrementing in-flight counter
    const parsed = PipelineRunPayloadSchema.safeParse(job.data);
    if (!parsed.success) {
      process.stderr.write(`[rolling-worker:${WORKER_ID.slice(0, 8)}] invalid payload: ${parsed.error.message}\n`);
      throw new Error(`Invalid payload: ${parsed.error.message}`);
    }

    const { runId, specPath, workspacePath } = parsed.data;

    // 2. Increment in-flight counter BEFORE any async work.
    //    This must happen before the DB status update so that when the test
    //    sees status='running' and sends SIGTERM, the drain counter is already
    //    non-zero and boss.stop({ graceful: true }) waits for this job to finish.
    inFlightCount++;
    process.stdout.write(`[rolling-worker:${WORKER_ID.slice(0, 8)}] in-flight=${inFlightCount} after pickup of run ${runId}\n`);

    // 3. Look up workspace_id
    const runRowResult = await pool.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM pipeline_runs WHERE id = $1',
      [runId],
    );
    if (runRowResult.rows.length === 0) {
      inFlightCount--;
      process.stderr.write(`[rolling-worker:${WORKER_ID.slice(0, 8)}] run ${runId} not found — skipping\n`);
      return;
    }
    const workspaceId = runRowResult.rows[0].workspace_id;

    // 4. Mark running + record worker_id
    await pool.query(
      `UPDATE pipeline_runs SET status = 'running', started_at = NOW(), worker_id = $1 WHERE id = $2`,
      [WORKER_ID, runId],
    );

    await pool.query(
      `INSERT INTO wal_events (event_type, workspace_id, payload)
       VALUES ('run_started', $1, $2)`,
      [workspaceId, JSON.stringify({ run_id: runId, spec_path: specPath, worker_id: WORKER_ID })],
    );

    process.stdout.write(`[rolling-worker:${WORKER_ID.slice(0, 8)}] picked up run ${runId}\n`);

    // 5. Resolve absolute spec path
    const absSpecPath = path.isAbsolute(specPath)
      ? specPath
      : path.join(workspacePath, specPath);

    // 6. Spawn the mock engine (10s sleep + posts results)
    const child = spawn(
      TSX_BIN,
      [
        MOCK_ENGINE_PATH,
        '--json', absSpecPath,
        '--cwd', workspacePath,
        '--run-id', String(runId),
        '--port', WORKER_PORT,
      ],
      {
        cwd: workspacePath,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, RORCA_PROCESS_ROLE: 'engine' },
      },
    );

    // Track PID
    if (child.pid) {
      await pool.query('UPDATE pipeline_runs SET pid = $1 WHERE id = $2', [child.pid, runId]).catch(() => {});
    }

    // 7. Pipe stdout/stderr → run_output_chunks
    const seqRef = { value: 1 };
    let pending = Buffer.alloc(0);

    const flush = async (): Promise<void> => {
      if (pending.length === 0) return;
      let offset = 0;
      while (offset < pending.length) {
        const slice = pending.slice(offset, offset + CHUNK_SIZE);
        await writeChunk(runId, seqRef.value, slice);
        seqRef.value++;
        offset += CHUNK_SIZE;
      }
      pending = Buffer.alloc(0);
    };

    const handleData = async (chunk: Buffer): Promise<void> => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= CHUNK_SIZE) {
        await writeChunk(runId, seqRef.value, pending.slice(0, CHUNK_SIZE));
        seqRef.value++;
        pending = pending.slice(CHUNK_SIZE);
      }
    };

    child.stdout?.on('data', (d: Buffer) => { void handleData(d); });
    child.stderr?.on('data', (d: Buffer) => { void handleData(d); });

    // 8. Wait for engine exit
    const exitCode = await new Promise<number>((resolve) => {
      child.on('exit', (code) => resolve(code ?? 1));
      child.on('error', () => resolve(1));
    });

    await flush();

    // 9. Decrement in-flight counter
    inFlightCount--;
    process.stdout.write(`[rolling-worker:${WORKER_ID.slice(0, 8)}] in-flight=${inFlightCount} after run ${runId} exit code ${exitCode}\n`);

    // 10. Update run status
    const status = exitCode === 0 ? 'done' : 'failed';
    await pool.query(
      `UPDATE pipeline_runs SET status = $1, finished_at = NOW() WHERE id = $2`,
      [status, runId],
    );
    await pool.query(
      `INSERT INTO wal_events (event_type, workspace_id, payload)
       VALUES ('run_finished', $1, $2)`,
      [workspaceId, JSON.stringify({ run_id: runId, status, exit_code: exitCode, worker_id: WORKER_ID })],
    );

    if (exitCode !== 0) {
      throw new Error(`engine exited with code ${exitCode}`);
    }
}

// ── Batch handler (runs all jobs in the batch concurrently) ───────────────────

async function handlePipelineRun(jobs: PgBoss.Job<Record<string, unknown>>[]): Promise<void> {
  await Promise.all(jobs.map((job) => runOneJob(job)));
}

// ── Graceful shutdown (SIGTERM drain) ─────────────────────────────────────────

let stopping = false;

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;

  // Stop accepting new jobs immediately by calling offWork() before the graceful
  // boss.stop(). This prevents the worker from picking up new jobs in the window
  // between this SIGTERM handler firing and boss.stop()'s internal manager.stop()
  // setting worker.stopping=true. Without this, there's a 1-2 event loop tick
  // window where the worker can pick up new jobs after logging the drain message.
  try {
    await boss.offWork('pipeline:run');
  } catch {
    // best-effort — if offWork fails, boss.stop() will still stop everything
  }

  // Log the drain message — verified by test
  process.stdout.write(`[worker] draining, waiting for ${inFlightCount} in-flight jobs...\n`);
  process.stderr.write(`[worker] draining, waiting for ${inFlightCount} in-flight jobs...\n`);

  try {
    await boss.stop({ graceful: true, timeout: 60_000 });
    process.stdout.write(`[rolling-worker:${WORKER_ID.slice(0, 8)}] stopped cleanly\n`);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`[rolling-worker:${WORKER_ID.slice(0, 8)}] error during shutdown: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });

// ── Startup ───────────────────────────────────────────────────────────────────

const boss = new PgBoss({
  connectionString: DB_URL,
  schema: 'pgboss',
  pollingIntervalSeconds: 1,
});

boss.on('error', (err: Error) => {
  process.stderr.write(`[rolling-worker:${WORKER_ID.slice(0, 8)}] pg-boss error: ${err.message}\n`);
});

async function start(): Promise<void> {
  await boss.start();
  await boss.createQueue('pipeline:run');
  // batchSize:5 fetches up to 5 jobs per poll cycle. The batch handler runs them
  // all concurrently via Promise.all — allowing 3+ jobs to be 'running' simultaneously,
  // which is required for the zero-downtime rolling deploy test to pass.
  await boss.work('pipeline:run', { batchSize: 5 }, handlePipelineRun);

  process.stdout.write(`[rolling-worker:${WORKER_ID.slice(0, 8)}] ready worker_id=${WORKER_ID}\n`);
}

start().catch((err: Error) => {
  process.stderr.write(`[rolling-worker] startup failed: ${err.message}\n`);
  process.exit(1);
});
