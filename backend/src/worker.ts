/**
 * worker.ts — Standalone pg-boss worker process for Rorca.
 *
 * This process is completely independent of the Express server. It connects
 * to the same DATABASE_URL and owns the execution-engine job lifecycle:
 *
 *   pipeline:run    — trigger a new pipeline run
 *   pipeline:retry  — retry failed stories in a completed run
 *   pipeline:cancel — cancel an active run
 *
 * Start: npm run worker
 * Stop:  SIGTERM (graceful) — drains in-flight jobs up to 30s, then exits
 */

import 'dotenv/config';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, type ChildProcess } from 'child_process';
import { z } from 'zod';
import PgBoss from 'pg-boss';
import { initDb, query, queryOne, execute } from './db/index';
import { initBoss, getBoss } from './lib/pg-boss';
import { logger } from './lib/logger';

// ── Validate environment ─────────────────────────────────────────────────

if (!process.env.DATABASE_URL) {
  logger.error('[worker] DATABASE_URL is not set — exiting');
  process.exit(1);
}

// ── Zod schema for pipeline:run job payload ───────────────────────────────

const PipelineRunJobPayload = z.object({
  runId: z.number().int().positive(),
  specPath: z.string().min(1),
  workspacePath: z.string().min(1),
  agent: z.enum(['claude', 'opencode', 'codex']),
  model: z.string().nullable(),
  worktreePath: z.string().nullable(),
  branchName: z.string().nullable(),
  autoWorktree: z.boolean().optional().default(false),
  envOverrides: z.record(z.string(), z.string()).optional().default({}),
});

type PipelineRunJobPayloadType = z.infer<typeof PipelineRunJobPayload>;

// ── Active process map (runId → ChildProcess) ────────────────────────────
// Used for cancellation. Cleaned up when the process exits.

const activeProcesses = new Map<number, ChildProcess>();

// ── Chunk size constant ───────────────────────────────────────────────────

const CHUNK_SIZE = 4 * 1024; // 4 KB

// ── Helper: write a single chunk to run_output_chunks ────────────────────

async function writeChunk(runId: number, sequence: number, data: Buffer): Promise<void> {
  try {
    await execute(
      `INSERT INTO run_output_chunks (run_id, chunk, sequence)
       VALUES ($1, $2, $3)
       ON CONFLICT (run_id, sequence) DO NOTHING`,
      [runId, data, sequence],
    );
  } catch (err) {
    logger.warn({ err, runId, sequence }, '[worker] Failed to write output chunk');
  }
}

// ── Helper: split a Buffer into ≤CHUNK_SIZE pieces and write them all ────

async function writeBufferAsChunks(
  runId: number,
  buf: Buffer,
  sequenceRef: { value: number },
): Promise<void> {
  let offset = 0;
  while (offset < buf.length) {
    const slice = buf.slice(offset, offset + CHUNK_SIZE);
    await writeChunk(runId, sequenceRef.value, slice);
    sequenceRef.value += 1;
    offset += CHUNK_SIZE;
  }
}

// ── Helper: emit a WAL event ──────────────────────────────────────────────

async function emitWalEvent(
  eventType: string,
  workspaceId: number | string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await execute(
      `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ($1, $2, $3)`,
      [eventType, workspaceId, JSON.stringify(payload)],
    );
  } catch (err) {
    logger.warn({ err, eventType }, '[worker] Failed to emit WAL event');
  }
}

// ── Job handler: pipeline:run ─────────────────────────────────────────────

async function handlePipelineRun(jobs: PgBoss.Job<Record<string, unknown>>[]): Promise<void> {
  for (const job of jobs) {
    const jobId = job.id;
    logger.info({ jobId, data: job.data }, '[worker] pipeline:run received');

    // 1. Validate payload via Zod
    const parsed = PipelineRunJobPayload.safeParse(job.data);
    if (!parsed.success) {
      logger.error({ jobId, errors: parsed.error.format() }, '[worker] pipeline:run invalid payload — failing job');
      throw new Error(`Invalid pipeline:run payload: ${parsed.error.message}`);
    }

    const payload: PipelineRunJobPayloadType = parsed.data;
    const { runId, specPath, workspacePath, agent, model, worktreePath, envOverrides } = payload;

    // Determine effective working directory (worktree or main workspace)
    const cwd = worktreePath ?? workspacePath;

    // Look up workspaceId for WAL events
    const runRow = await queryOne<{ workspace_id: number; parallelism: number }>(
      'SELECT workspace_id, parallelism FROM pipeline_runs WHERE id = $1',
      [runId],
    );
    if (!runRow) {
      logger.error({ jobId, runId }, '[worker] pipeline_runs row not found — skipping');
      return;
    }
    const { workspace_id: workspaceId, parallelism } = runRow;

    // 2. Mark run as running
    await execute(
      `UPDATE pipeline_runs SET status = 'running', started_at = NOW() WHERE id = $1`,
      [runId],
    );

    await emitWalEvent('run_started', workspaceId, { run_id: runId, spec_path: specPath });

    // 3. Build engine args
    const executionEngineTs = path.join(__dirname, 'lib', 'execution-engine.ts');
    const tsxBin = path.join(__dirname, '..', 'node_modules', '.bin', 'tsx');
    const backendPort = process.env.PORT ?? '3030';

    const engineArgs = [
      executionEngineTs,
      '--json', path.join(workspacePath, specPath),
      '--cwd', cwd,
      '--run-id', String(runId),
      '--port', backendPort,
      '--parallelism', String(parallelism ?? 1),
      '--agent', agent,
    ];
    if (model) {
      engineArgs.push('--model', model);
    }

    // 4. Spawn execution-engine.ts with pipe stdio so we can capture chunks
    const env: Record<string, string> = {
      ...envOverrides,
      RORCA_PROCESS_ROLE: 'engine',
    };

    logger.info({ runId, agent, model, cwd }, '[worker] Spawning execution-engine.ts');

    const child = spawn(tsxBin, engineArgs, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    // 5. Record PID
    if (child.pid) {
      await execute('UPDATE pipeline_runs SET pid = $1 WHERE id = $2', [child.pid, runId]);
    }

    // Register in active processes map for cancellation
    activeProcesses.set(runId, child);

    // 6. Pipe stdout/stderr to run_output_chunks in ≤4 KB chunks
    const sequenceRef = { value: 1 };
    let pending = Buffer.alloc(0);

    const flushPending = async (): Promise<void> => {
      if (pending.length === 0) return;
      await writeBufferAsChunks(runId, pending, sequenceRef);
      pending = Buffer.alloc(0);
    };

    const handleData = async (data: Buffer): Promise<void> => {
      pending = Buffer.concat([pending, data]);
      // Write complete 4KB chunks immediately; keep the tail for next round
      while (pending.length >= CHUNK_SIZE) {
        const slice = pending.slice(0, CHUNK_SIZE);
        await writeChunk(runId, sequenceRef.value, slice);
        sequenceRef.value += 1;
        pending = pending.slice(CHUNK_SIZE);
      }
    };

    child.stdout?.on('data', (data: Buffer) => { void handleData(data); });
    child.stderr?.on('data', (data: Buffer) => { void handleData(data); });

    // 7. Wait for exit, flush remaining bytes, update run status
    await new Promise<void>((resolve) => {
      child.on('exit', async (code) => {
        // Flush any remaining bytes < 4 KB
        await flushPending();

        activeProcesses.delete(runId);

        const status = code === 0 ? 'done' : 'failed';
        logger.info({ runId, code, status }, '[worker] execution-engine exited');

        try {
          await execute(
            `UPDATE pipeline_runs SET status = $1, finished_at = NOW() WHERE id = $2`,
            [status, runId],
          );

          await emitWalEvent('run_finished', workspaceId, {
            run_id: runId,
            status,
            exit_code: code,
            source: 'worker',
          });
        } catch (err) {
          logger.error({ err, runId }, '[worker] Failed to update run status on exit');
        }

        resolve();
      });

      child.on('error', async (err) => {
        logger.error({ err, runId }, '[worker] execution-engine spawn error');
        await flushPending();
        activeProcesses.delete(runId);

        try {
          await execute(
            `UPDATE pipeline_runs SET status = 'failed', finished_at = NOW() WHERE id = $1`,
            [runId],
          );
          await emitWalEvent('run_finished', workspaceId, {
            run_id: runId,
            status: 'failed',
            error: (err as Error).message,
            source: 'worker',
          });
        } catch (dbErr) {
          logger.error({ dbErr, runId }, '[worker] Failed to update run status after spawn error');
        }

        resolve();
      });
    });
  }
}

// ── Job handler: pipeline:retry ───────────────────────────────────────────

async function handlePipelineRetry(jobs: PgBoss.Job<Record<string, unknown>>[]): Promise<void> {
  for (const job of jobs) {
    logger.info({ jobId: job.id, data: job.data }, '[worker] pipeline:retry received');
    // TODO: retry logic — delegate to pipeline:run handler with retry spec in future story
  }
}

// ── Job handler: pipeline:cancel ──────────────────────────────────────────

async function handlePipelineCancel(jobs: PgBoss.Job<Record<string, unknown>>[]): Promise<void> {
  for (const job of jobs) {
    logger.info({ jobId: job.id, data: job.data }, '[worker] pipeline:cancel received');

    const data = job.data as { runId?: number };
    if (typeof data.runId !== 'number') {
      logger.warn({ jobId: job.id }, '[worker] pipeline:cancel missing runId — skipping');
      return;
    }

    const child = activeProcesses.get(data.runId);
    if (child) {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (activeProcesses.has(data.runId!)) child.kill('SIGKILL');
      }, 10_000);
    }
  }
}

// ── Graceful shutdown ────────────────────────────────────────────────────

let stopping = false;

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info(`[worker] received ${signal} — stopping pg-boss (waiting up to 30s for in-flight jobs)`);
  try {
    await getBoss().stop({ timeout: 30_000 });
    logger.info('[worker] pg-boss stopped cleanly — exiting');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, '[worker] error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });

// ── Startup ──────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  // 1. Run pending SQL migrations (001–NNN) against the main public schema
  try {
    await initDb();
  } catch (err) {
    logger.error({ err }, '[worker] database initialisation failed');
    process.exit(1);
  }

  // 2. Start pg-boss — creates/upgrades pgboss.* schema automatically
  try {
    await initBoss();
  } catch (err) {
    logger.error({ err }, '[worker] pg-boss initialisation failed');
    process.exit(1);
  }

  // 3. Register job queue handlers
  const boss = getBoss();
  await boss.work('pipeline:run', handlePipelineRun);
  await boss.work('pipeline:retry', handlePipelineRetry);
  await boss.work('pipeline:cancel', handlePipelineCancel);

  logger.info('[worker] ready — listening for pipeline:run, pipeline:retry, pipeline:cancel');
}

start().catch((err) => {
  logger.error({ err }, '[worker] startup failed');
  process.exit(1);
});
