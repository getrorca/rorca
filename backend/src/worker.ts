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
import * as os from 'os';
import * as crypto from 'crypto';
import { spawn, type ChildProcess } from 'child_process';
import { z } from 'zod';
import PgBoss from 'pg-boss';
import {
  PipelineRunJobPayload,
  type PipelineRunJobPayloadType,
  PipelineRetryJobPayload,
  type PipelineRetryJobPayloadType,
  PipelineCancelJobPayload,
} from './lib/pg-boss-schemas';
import { initDb, query, queryOne, execute } from './db/index';
import { initBoss, getBoss } from './lib/pg-boss';
import { registerSchedulesWithBoss, triggerScheduledRun, checkAndFireDueSchedules } from './lib/scheduler';
import { logger } from './lib/logger';

// ── Worker identity (stable for the lifetime of this process) ────────────────

const WORKER_ID: string = crypto.randomUUID();
const WORKER_HOSTNAME: string = os.hostname();
const WORKER_STARTED_AT: Date = new Date();

const HEARTBEAT_INTERVAL_MS = 30_000; // 30 s

// ── Active process map (runId → ChildProcess) ────────────────────────────
// Declared early so writeHeartbeat() can read .size before activeProcesses
// is mutated by job handlers. Cleaned up when the process exits.

const activeProcesses = new Map<number, ChildProcess>();

// ── Cancelling runs set (runId) ───────────────────────────────────────────
// Tracks which runs are being intentionally cancelled so the exit handler
// writes status='cancelled' (not 'failed') and emits run_cancelled WAL event.

const cancellingRuns = new Set<number>();

// ── Reconciliation error counter (updated by reconcileState) ─────────────────
// Surfaced on the health endpoint as lastReconciliationErrors.

let lastReconciliationErrors = 0;

// ── pg-boss self-check (consecutive failure counter) ─────────────────────────
// If boss.getQueueSize throws 3 consecutive times the pg-boss connection is
// considered dead; we log FATAL and exit(1) so the supervisor restarts us.

let pgBossHealthFailures = 0;
const PG_BOSS_HEALTH_MAX_FAILURES = 3;

async function pgBossHealthCheck(): Promise<void> {
  try {
    const boss = getBoss();
    await boss.getQueueSize('pipeline:run');
    // Success — reset the counter
    pgBossHealthFailures = 0;
  } catch (err) {
    pgBossHealthFailures += 1;
    logger.warn(
      { err, consecutiveFailures: pgBossHealthFailures },
      '[worker] pg-boss getQueueSize failed',
    );
    if (pgBossHealthFailures >= PG_BOSS_HEALTH_MAX_FAILURES) {
      logger.fatal(
        { consecutiveFailures: pgBossHealthFailures },
        '[worker] FATAL — pg-boss connection dead (3 consecutive getQueueSize failures) — exiting for supervisor restart',
      );
      process.exit(1);
    }
  }
}

async function writeHeartbeat(): Promise<void> {
  try {
    await execute(
      `INSERT INTO worker_heartbeat (worker_id, pid, hostname, started_at, last_seen, active_jobs)
       VALUES ($1, $2, $3, $4, NOW(), $5)
       ON CONFLICT (worker_id) DO UPDATE SET last_seen = NOW(), pid = EXCLUDED.pid, active_jobs = EXCLUDED.active_jobs`,
      [WORKER_ID, process.pid, WORKER_HOSTNAME, WORKER_STARTED_AT, activeProcesses.size],
    );
  } catch (err) {
    logger.warn({ err }, '[worker] heartbeat write failed');
  }
}

// ── Validate environment ─────────────────────────────────────────────────

if (!process.env.DATABASE_URL) {
  logger.error('[worker] DATABASE_URL is not set — exiting');
  process.exit(1);
}

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
    // Spread process.env first so child inherits PATH, HOME, DATABASE_URL, etc.
    // Then strip the 4 Claude vars that must not propagate to nested invocations.
    const { CLAUDECODE, CLAUDE_CODE_ENTRYPOINT, CLAUDE_AGENT_SDK_VERSION, CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING, ...inheritedEnv } = process.env as Record<string, string>;
    const env: Record<string, string> = {
      ...inheritedEnv,
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

        const wasCancelled = cancellingRuns.delete(runId);
        const status = wasCancelled ? 'cancelled' : (code === 0 ? 'done' : 'failed');
        logger.info({ runId, code, status, wasCancelled }, '[worker] execution-engine exited');

        try {
          await execute(
            `UPDATE pipeline_runs SET status = $1, finished_at = NOW() WHERE id = $2`,
            [status, runId],
          );

          if (wasCancelled) {
            await emitWalEvent('run_cancelled', workspaceId, {
              run_id: runId,
              cancelledAt: new Date().toISOString(),
              source: 'worker',
            });
          } else {
            await emitWalEvent('run_finished', workspaceId, {
              run_id: runId,
              status,
              exit_code: code,
              source: 'worker',
            });
          }
        } catch (err) {
          logger.error({ err, runId }, '[worker] Failed to update run status on exit');
        }

        resolve();
      });

      child.on('error', async (err) => {
        logger.error({ err, runId }, '[worker] execution-engine spawn error');
        await flushPending();
        activeProcesses.delete(runId);
        cancellingRuns.delete(runId);

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
    const jobId = job.id;
    logger.info({ jobId, data: job.data }, '[worker] pipeline:retry received');

    // 1. Validate payload via Zod
    const parsed = PipelineRetryJobPayload.safeParse(job.data);
    if (!parsed.success) {
      logger.error({ jobId, errors: parsed.error.format() }, '[worker] pipeline:retry invalid payload — failing job');
      throw new Error(`Invalid pipeline:retry payload: ${parsed.error.message}`);
    }

    const payload: PipelineRetryJobPayloadType = parsed.data;
    const { runId, originalRunId, workspacePath, retrySpecPath, agent, model, worktreePath, sequenceOffset, envOverrides } = payload;

    // Effective working directory (worktree or main workspace)
    const cwd = worktreePath ?? workspacePath;

    // 2. Look up workspace_id and parallelism from the NEW run row (created by route handler)
    const runRow = await queryOne<{ workspace_id: string; parallelism: number }>(
      'SELECT workspace_id, parallelism FROM pipeline_runs WHERE id = $1',
      [runId],
    );
    if (!runRow) {
      logger.error({ jobId, runId }, '[worker] pipeline:retry run row not found — skipping');
      return;
    }
    const { workspace_id: workspaceId, parallelism } = runRow;

    // 3. Mark the new run as running (route handler set status='running' but worker confirms)
    await execute(
      `UPDATE pipeline_runs SET status = 'running', started_at = NOW() WHERE id = $1`,
      [runId],
    );

    await emitWalEvent('run_started', workspaceId, {
      run_id: runId,
      original_run_id: originalRunId,
      source: 'worker_retry',
    });

    // 4. Build execution-engine args with the temp retry spec
    const executionEngineTs = path.join(__dirname, 'lib', 'execution-engine.ts');
    const tsxBin = path.join(__dirname, '..', 'node_modules', '.bin', 'tsx');
    const backendPort = process.env.PORT ?? '3030';

    // Verify the temp retry spec file still exists (route handler should have written it)
    if (!fs.existsSync(retrySpecPath)) {
      logger.error({ jobId, runId, retrySpecPath }, '[worker] retry spec file not found — failing run');
      await execute(
        `UPDATE pipeline_runs SET status = 'failed', finished_at = NOW() WHERE id = $1`,
        [runId],
      );
      await emitWalEvent('run_finished', workspaceId, { run_id: runId, status: 'failed', reason: 'retry_spec_missing' });
      return;
    }

    const engineArgs = [
      executionEngineTs,
      '--json', retrySpecPath,
      '--cwd', cwd,
      '--run-id', String(runId),
      '--port', backendPort,
      '--parallelism', String(parallelism ?? 1),
      '--agent', agent,
    ];
    if (model) {
      engineArgs.push('--model', model);
    }

    // 5. Spawn execution-engine with pipe stdio for chunk capture
    // Spread process.env first so child inherits PATH, HOME, DATABASE_URL, etc.
    // Strip the 4 Claude vars that must not propagate to nested invocations.
    const { CLAUDECODE: _a, CLAUDE_CODE_ENTRYPOINT: _b, CLAUDE_AGENT_SDK_VERSION: _c, CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: _d, ...inheritedEnvRetry } = process.env as Record<string, string>;
    const env = { ...inheritedEnvRetry, ...envOverrides, RORCA_PROCESS_ROLE: 'engine' };

    logger.info({ runId, agent, model, cwd }, '[worker] Spawning execution-engine.ts for retry');

    const child = spawn(tsxBin, engineArgs, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    if (child.pid) {
      await execute('UPDATE pipeline_runs SET pid = $1 WHERE id = $2', [child.pid, runId]);
    }

    activeProcesses.set(runId, child);

    // 6. Pipe stdout/stderr to run_output_chunks, continuing sequence from sequenceOffset
    const sequenceRef = { value: sequenceOffset + 1 };
    let pending = Buffer.alloc(0);

    const flushPending = async (): Promise<void> => {
      if (pending.length === 0) return;
      await writeBufferAsChunks(runId, pending, sequenceRef);
      pending = Buffer.alloc(0);
    };

    const handleData = async (data: Buffer): Promise<void> => {
      pending = Buffer.concat([pending, data]);
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
        // Flush bytes < CHUNK_SIZE remaining in the buffer before marking done
        await flushPending();

        activeProcesses.delete(runId);

        const wasCancelled = cancellingRuns.delete(runId);

        // Derive final status
        let finalStatus: string;
        if (wasCancelled) {
          finalStatus = 'cancelled';
        } else {
          try {
            const currentStories = await query<{ story_id: string; status: string }>(
              'SELECT story_id, status FROM story_results WHERE run_id = $1 ORDER BY id ASC',
              [runId],
            );
            const latest = new Map<string, string>();
            for (const s of currentStories) latest.set(s.story_id, s.status);
            const hasFailures = Array.from(latest.values()).some(st => st === 'fail');
            finalStatus = hasFailures ? 'partial_failure' : (code === 0 ? 'done' : 'partial_failure');
          } catch {
            finalStatus = code === 0 ? 'done' : 'failed';
          }
        }

        logger.info({ runId, code, finalStatus, wasCancelled }, '[worker] retry execution-engine exited');

        try {
          await execute(
            `UPDATE pipeline_runs SET status = $1, finished_at = NOW() WHERE id = $2`,
            [finalStatus, runId],
          );

          if (wasCancelled) {
            await emitWalEvent('run_cancelled', workspaceId, {
              run_id: runId,
              cancelledAt: new Date().toISOString(),
              source: 'worker_retry',
            });
          } else {
            await emitWalEvent('run_finished', workspaceId, {
              run_id: runId,
              original_run_id: originalRunId,
              status: finalStatus,
              exit_code: code,
              source: 'worker_retry',
            });
          }
        } catch (err) {
          logger.error({ err, runId }, '[worker] Failed to update retry run status on exit');
        }

        // Clean up the temporary retry spec file
        try { fs.unlinkSync(retrySpecPath); } catch { /* best-effort */ }

        resolve();
      });

      child.on('error', async (err) => {
        logger.error({ err, runId }, '[worker] retry execution-engine spawn error');
        await flushPending();
        activeProcesses.delete(runId);
        cancellingRuns.delete(runId);

        try {
          await execute(
            `UPDATE pipeline_runs SET status = 'failed', finished_at = NOW() WHERE id = $1`,
            [runId],
          );
          await emitWalEvent('run_finished', workspaceId, {
            run_id: runId,
            original_run_id: originalRunId,
            status: 'failed',
            error: (err as Error).message,
            source: 'worker_retry',
          });
        } catch (dbErr) {
          logger.error({ dbErr, runId }, '[worker] Failed to update retry run status after spawn error');
        }

        try { fs.unlinkSync(retrySpecPath); } catch { /* best-effort */ }

        resolve();
      });
    });
  }
}

// ── Job handler: pipeline:cron ────────────────────────────────────────────
// Handles two variants:
//
//  a) Meta-cron (queue: pipeline:cron, data: {}):
//     Fires every minute via pg-boss native schedule. Calls
//     checkAndFireDueSchedules() which checks all enabled pipeline_schedules
//     against their cron expressions and triggers due ones. pg-boss distributed
//     lock ensures exactly one fire per minute across all worker instances.
//
//  b) Per-schedule (queue: pipeline:cron:<id>, data: { scheduleId, specId, ... }):
//     Fires directly for a specific schedule. Delegates to triggerScheduledRun().
//     Per-schedule distributed lock ensures exactly one trigger per schedule interval.

const PipelineCronJobData = z.object({
  scheduleId: z.number().int().positive(),
  specId: z.string().min(1),
  workspaceId: z.string().min(1),
  agent: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
});

async function handlePipelineCron(jobs: PgBoss.Job<Record<string, unknown>>[]): Promise<void> {
  for (const job of jobs) {
    logger.info({ jobId: job.id, name: job.name, data: job.data }, '[worker] pipeline:cron received');

    // Detect variant: if data has scheduleId it's a per-schedule direct fire
    const parsed = PipelineCronJobData.safeParse(job.data);
    if (parsed.success) {
      // Per-schedule direct fire
      const { scheduleId, specId, workspaceId, agent, model } = parsed.data;
      await triggerScheduledRun({
        id: scheduleId,
        spec_id: specId,
        workspace_id: workspaceId,
        agent: agent ?? null,
        model: model ?? null,
      });
    } else {
      // Meta-cron: check all enabled schedules for due entries
      logger.info({ jobId: job.id }, '[worker] pipeline:cron meta-tick — checking all due schedules');
      await checkAndFireDueSchedules();
    }
  }
}

// ── Job handler: pipeline:cancel ──────────────────────────────────────────

async function handlePipelineCancel(jobs: PgBoss.Job<Record<string, unknown>>[]): Promise<void> {
  for (const job of jobs) {
    logger.info({ jobId: job.id, data: job.data }, '[worker] pipeline:cancel received');

    const parsed = PipelineCancelJobPayload.safeParse(job.data);
    if (!parsed.success) {
      logger.warn({ jobId: job.id, errors: parsed.error.format() }, '[worker] pipeline:cancel invalid payload — skipping');
      return;
    }

    const runId = parsed.data.runId;
    const child = activeProcesses.get(runId);
    if (child) {
      // Mark as intentionally cancelled so the exit handler sets status='cancelled'
      cancellingRuns.add(runId);
      child.kill('SIGTERM');
      setTimeout(() => {
        // Only SIGKILL if the process is still in the active map (not yet exited)
        if (activeProcesses.has(runId)) child.kill('SIGKILL');
      }, 10_000);
    } else {
      logger.warn({ jobId: job.id, runId }, '[worker] pipeline:cancel — no active process found for runId');
    }
  }
}

// ── Stale job recovery ───────────────────────────────────────────────────
// Called once at startup, before boss.work() registers handlers.
// Finds any pgboss.job rows that were left in state='active' by a previous
// worker that crashed (or was SIGKILL'd before draining). These jobs will
// never be retried because pg-boss only expires them after expireInSeconds
// (set to 7200s / 2hr by WR-003), meaning new jobs would be blocked by the
// occupied teamSize slots until expiry.
//
// Safe cutoff: we use WORKER_STARTED_AT as the boundary. Any job whose
// startedon < WORKER_STARTED_AT could not have been started by this process
// instance, so it is definitively orphaned.
//
// We do NOT re-queue — a partially-executed run may have committed code;
// re-running it would create duplicate commits.

async function recoverStaleJobs(): Promise<void> {
  type StaleJobRow = {
    id: string;
    name: string;
    data: Record<string, unknown>;
  };

  let staleJobs: StaleJobRow[];
  try {
    staleJobs = await query<StaleJobRow>(
      `SELECT id, name, data
       FROM pgboss.job
       WHERE name IN ('pipeline:run', 'pipeline:retry')
         AND state = 'active'
         AND started_on < $1`,
      [WORKER_STARTED_AT],
    );
  } catch (err) {
    // pgboss schema may not exist yet on a completely fresh DB — safe to skip
    logger.warn({ err }, '[worker] recoverStaleJobs — pgboss.job query failed, skipping');
    return;
  }

  if (staleJobs.length === 0) {
    logger.info('[worker] recoverStaleJobs — no stale active jobs found');
    return;
  }

  logger.warn({ count: staleJobs.length }, '[worker] recoverStaleJobs — found stale active jobs from crashed worker');

  for (const job of staleJobs) {
    const runId = typeof job.data?.runId === 'number' ? job.data.runId : undefined;

    // 1. Fail the pg-boss job so the slot is freed
    try {
      await execute(
        `UPDATE pgboss.job
         SET state = 'failed', completedon = NOW()
         WHERE id = $1 AND state = 'active'`,
        [job.id],
      );
    } catch (err) {
      logger.warn({ err, jobId: job.id }, '[worker] recoverStaleJobs — failed to update pgboss.job state');
      continue;
    }

    if (!runId) {
      logger.warn({ jobId: job.id, jobName: job.name }, '[worker] recoverStaleJobs — job has no runId in data, skipping pipeline_runs update');
      continue;
    }

    // 2. Look up workspaceId before updating the run
    const runRow = await queryOne<{ workspace_id: number | string }>(
      `SELECT workspace_id FROM pipeline_runs WHERE id = $1`,
      [runId],
    ).catch(() => undefined);

    // 3. Mark pipeline_runs as failed
    try {
      await execute(
        `UPDATE pipeline_runs SET status = 'failed', finished_at = NOW() WHERE id = $1 AND status = 'running'`,
        [runId],
      );
    } catch (err) {
      logger.warn({ err, runId }, '[worker] recoverStaleJobs — failed to update pipeline_runs');
    }

    // 4. Emit WAL event for UI notification
    if (runRow) {
      await emitWalEvent('run_finished', runRow.workspace_id, {
        run_id: runId,
        status: 'failed',
        reason: 'worker_crash_recovery',
        pgboss_job_id: job.id,
        recovered_at: new Date().toISOString(),
      });
    }

    logger.warn(
      { pgbossJobId: job.id, jobName: job.name, runId },
      '[worker] recoverStaleJobs — stale job failed, pipeline_runs updated',
    );
  }

  logger.info({ recovered: staleJobs.length }, '[worker] recoverStaleJobs — recovery complete');
}

// ── State reconciliation ─────────────────────────────────────────────────
// Detects and repairs mismatches between pipeline_runs and pgboss.job.
//
// Case A: pipeline_runs.status IN ('running', 'queued') but no matching
//   pgboss.job in state ('created', 'active', 'retry'). The job is gone
//   (completed, failed, or manually deleted) but the run row is stuck.
//   Fix: mark the run 'failed', emit WAL.
//
// Case B: pgboss.job state='active' for pipeline:run/pipeline:retry but
//   pipeline_runs.status is NOT 'running'. The run row was already resolved
//   (e.g. manually via SQL) but the job is still consuming a worker slot.
//   Fix: fail the pgboss job so the slot is freed.
//
// Runs at startup (after recoverStaleJobs) and every 60s.

const RECONCILE_INTERVAL_MS = 60_000;

async function reconcileState(): Promise<void> {
  logger.info('[worker] reconcileState — starting check');

  // ── Case A: pipeline_runs stuck in running/queued with no live pgboss job ──

  type StuckRunRow = {
    id: number;
    workspace_id: number | string;
  };

  let stuckRuns: StuckRunRow[];
  try {
    stuckRuns = await query<StuckRunRow>(
      `SELECT pr.id, pr.workspace_id
       FROM pipeline_runs pr
       WHERE pr.status IN ('running', 'queued')
         AND NOT EXISTS (
           SELECT 1 FROM pgboss.job j
           WHERE j.name IN ('pipeline:run', 'pipeline:retry')
             AND j.state IN ('created', 'active', 'retry')
             AND (j.data->>'runId')::int = pr.id
         )`,
    );
  } catch (err) {
    logger.warn({ err }, '[worker] reconcileState — Case A query failed, skipping');
    stuckRuns = [];
  }

  for (const run of stuckRuns) {
    logger.warn(
      { runId: run.id, currentStatus: 'running/queued' },
      '[worker] reconcileState — Case A: pipeline_run has no live pgboss job, marking failed',
    );

    try {
      await execute(
        `UPDATE pipeline_runs
         SET status = 'failed', finished_at = NOW()
         WHERE id = $1 AND status IN ('running', 'queued')`,
        [run.id],
      );

      await emitWalEvent('run_finished', run.workspace_id, {
        run_id: run.id,
        status: 'failed',
        reason: 'state_reconciliation',
        reconciled_at: new Date().toISOString(),
      });

      logger.warn(
        { runId: run.id, workspaceId: run.workspace_id },
        '[worker] reconcileState — Case A: run marked failed, WAL emitted',
      );
    } catch (err) {
      logger.warn({ err, runId: run.id }, '[worker] reconcileState — Case A: failed to update run');
    }
  }

  // ── Case B: pgboss.job active but pipeline_run already resolved ──

  type OrphanJobRow = {
    id: string;
    name: string;
    run_id: number | null;
  };

  let orphanJobs: OrphanJobRow[];
  try {
    orphanJobs = await query<OrphanJobRow>(
      `SELECT j.id, j.name, (j.data->>'runId')::int AS run_id
       FROM pgboss.job j
       WHERE j.name IN ('pipeline:run', 'pipeline:retry')
         AND j.state = 'active'
         AND (j.data->>'runId') IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM pipeline_runs pr
           WHERE pr.id = (j.data->>'runId')::int
             AND pr.status = 'running'
         )`,
    );
  } catch (err) {
    logger.warn({ err }, '[worker] reconcileState — Case B query failed, skipping');
    orphanJobs = [];
  }

  for (const job of orphanJobs) {
    logger.warn(
      { jobId: job.id, jobName: job.name, runId: job.run_id },
      '[worker] reconcileState — Case B: active pgboss job has no running pipeline_run, failing job',
    );

    try {
      await execute(
        `UPDATE pgboss.job
         SET state = 'failed', completedon = NOW()
         WHERE id = $1 AND state = 'active'`,
        [job.id],
      );

      logger.warn(
        { jobId: job.id, jobName: job.name, runId: job.run_id },
        '[worker] reconcileState — Case B: pgboss job failed to free slot',
      );
    } catch (err) {
      logger.warn({ err, jobId: job.id }, '[worker] reconcileState — Case B: failed to update pgboss.job');
    }
  }

  const totalFixed = stuckRuns.length + orphanJobs.length;
  lastReconciliationErrors = totalFixed;

  if (totalFixed > 0) {
    logger.warn({ caseA: stuckRuns.length, caseB: orphanJobs.length }, '[worker] reconcileState — mismatches resolved');
  } else {
    logger.info('[worker] reconcileState — no mismatches found');
  }
}

// ── Graceful shutdown ────────────────────────────────────────────────────

let stopping = false;
let reconcileIntervalHandle: ReturnType<typeof setInterval> | undefined;

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;

  if (reconcileIntervalHandle !== undefined) {
    clearInterval(reconcileIntervalHandle);
    reconcileIntervalHandle = undefined;
  }

  logger.info(`[worker] received ${signal} — starting graceful shutdown`);

  // 1. SIGTERM all active child processes
  const activeRunIds = Array.from(activeProcesses.keys());
  if (activeRunIds.length > 0) {
    logger.info({ count: activeRunIds.length, runIds: activeRunIds }, '[worker] shutdown — sending SIGTERM to active child processes');
    for (const [, child] of activeProcesses) {
      try { child.kill('SIGTERM'); } catch { /* best-effort */ }
    }
  }

  // 2. Wait up to 15s for child processes to exit (poll every 500ms)
  const DRAIN_TIMEOUT_MS = 15_000;
  const DRAIN_POLL_MS = 500;
  const drainDeadline = Date.now() + DRAIN_TIMEOUT_MS;

  while (activeProcesses.size > 0 && Date.now() < drainDeadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
  }

  // 3. SIGKILL any remaining child processes that did not exit in time
  if (activeProcesses.size > 0) {
    const remaining = Array.from(activeProcesses.keys());
    logger.warn({ remaining }, '[worker] shutdown — children did not exit in 15s, sending SIGKILL');
    for (const [, child] of activeProcesses) {
      try { child.kill('SIGKILL'); } catch { /* best-effort */ }
    }
    // Give SIGKILL a moment to land before we proceed
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
  }

  // 4. Mark any still-running pipeline_runs as failed
  const inflightRunIds = Array.from(activeProcesses.keys());
  if (inflightRunIds.length > 0) {
    logger.warn({ runIds: inflightRunIds }, '[worker] shutdown — marking in-flight runs as failed');
    for (const runId of inflightRunIds) {
      try {
        await execute(
          `UPDATE pipeline_runs SET status = 'failed', finished_at = NOW() WHERE id = $1 AND status = 'running'`,
          [runId],
        );
      } catch (err) {
        logger.warn({ err, runId }, '[worker] shutdown — failed to update pipeline_run status');
      }
    }
  }

  // 5. Delete this worker's heartbeat row so the health endpoint shows no stale data
  try {
    await execute('DELETE FROM worker_heartbeat WHERE worker_id = $1', [WORKER_ID]);
    logger.info('[worker] shutdown — heartbeat row deleted');
  } catch (err) {
    logger.warn({ err }, '[worker] shutdown — failed to delete heartbeat row');
  }

  // 6. Stop pg-boss (drains any remaining queued work up to 15s)
  logger.info('[worker] shutdown — stopping pg-boss (timeout: 15s)');
  try {
    await getBoss().stop({ timeout: 15_000 });
    logger.info('[worker] pg-boss stopped cleanly — exiting');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, '[worker] error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('uncaughtException', (err) => {
  logger.error({ err }, '[worker] uncaughtException — triggering shutdown');
  void shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, '[worker] unhandledRejection — triggering shutdown');
  void shutdown('unhandledRejection');
});

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

  // 3. Recover stale jobs left by a previously crashed worker instance.
  // Must run after initBoss() (pg-boss schema exists) but before boss.work()
  // (so freed slots are available when handlers start polling).
  await recoverStaleJobs();

  // 3b. Reconcile state between pipeline_runs and pgboss.job.
  // Runs once at startup, then every 60s during normal operation.
  await reconcileState();
  reconcileIntervalHandle = setInterval(() => { void reconcileState(); }, RECONCILE_INTERVAL_MS);

  // 4. Register job queue handlers.
  // Queues are already created by ensureQueues() inside initBoss() — just register handlers.
  const boss = getBoss();
  const maxConcurrent = parseInt(process.env.RORCA_MAX_CONCURRENT_RUNS ?? '5', 10);
  await boss.work('pipeline:run', { batchSize: maxConcurrent }, handlePipelineRun);
  await boss.work('pipeline:retry', { batchSize: maxConcurrent }, handlePipelineRetry);
  await boss.work('pipeline:cancel', { batchSize: 10 }, handlePipelineCancel);

  // 4b. DLQ polling — pg-boss does not emit a 'failed' event for job exhaustion.
  // Instead, poll pgboss.archive every 60 s for newly-failed pipeline jobs and emit
  // run_dlq WAL events. Seen job IDs are tracked in a Set to avoid duplicate events.
  const seenDlqJobIds = new Set<string>();

  async function pollDlq(): Promise<void> {
    try {
      type DlqRow = { id: string; name: string; output: unknown; retry_count: number; archived_on: string; data: Record<string, unknown> };
      const rows = await query<DlqRow>(
        `SELECT id, name, output, retry_count, archived_on, data
         FROM pgboss.archive
         WHERE name IN ('pipeline:run', 'pipeline:retry')
           AND state = 'failed'
           AND archived_on > NOW() - INTERVAL '1 day'
         ORDER BY archived_on DESC`,
      ).catch(() => [] as DlqRow[]);

      for (const row of rows) {
        if (seenDlqJobIds.has(row.id)) continue;
        seenDlqJobIds.add(row.id);

        const runId = typeof row.data?.runId === 'number' ? row.data.runId : undefined;
        if (!runId) continue;

        const run = await queryOne<{ workspace_id: string }>(
          `SELECT workspace_id FROM pipeline_runs WHERE id = $1`,
          [runId],
        ).catch(() => undefined);
        if (!run) continue;

        const lastError = typeof row.output === 'string'
          ? row.output
          : (row.output != null ? JSON.stringify(row.output) : null);

        logger.warn({ jobId: row.id, name: row.name, runId }, '[worker] DLQ poll — emitting run_dlq WAL event');

        await emitWalEvent('run_dlq', run.workspace_id, {
          runId,
          jobId: row.id,
          jobName: row.name,
          lastError,
          attempts: (row.retry_count ?? 0) + 1,
        });
      }
    } catch (err) {
      logger.warn({ err }, '[worker] DLQ poll error');
    }
  }

  void pollDlq();
  setInterval(() => { void pollDlq(); }, 60_000);

  // 4. Bulk-register all enabled pipeline_schedules with pg-boss native scheduling.
  // Also registers the meta-cron (pipeline:cron, every minute) and per-schedule
  // boss.work() subscriptions (pipeline:cron:<id>). Re-registration is idempotent.
  await registerSchedulesWithBoss(boss, handlePipelineCron);

  // 5. Start heartbeat — write immediately, then every 30 s.
  // Also runs pg-boss connection self-check on each tick; exits on 3 consecutive failures.
  await writeHeartbeat();
  setInterval(() => {
    void writeHeartbeat();
    void pgBossHealthCheck();
  }, HEARTBEAT_INTERVAL_MS);

  logger.info('[worker] ready — listening for pipeline:run, pipeline:retry, pipeline:cancel, pipeline:cron');
}

start().catch((err) => {
  logger.error({ err }, '[worker] startup failed');
  process.exit(1);
});
