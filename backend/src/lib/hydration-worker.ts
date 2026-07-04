/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * hydration-worker.ts — Background hydration execution via pg-boss (US-011).
 *
 * Registers a pg-boss job handler for the `workspace:hydrate` queue. When the
 * worker process picks up a hydration job it:
 *   1. Loads the hydration DB row and skips cancelled terminal states.
 *   2. Coalesces concurrent hydration: if a newer hydration is already in
 *      flight for the same workspace the current job is cancelled.
 *   3. Loads the resolved Hilo config and hands off to
 *      {@link ./hilo-hydration-runner}.runHiloHydration, which records status,
 *      git SHA, duration, and counts on success, and a sanitized error_json on
 *      failure.
 *   4. Always updates the hydration row — a stuck/killed process never leaves
 *      `running` in the DB.
 *
 * Consumers: {@link ../worker}.ts (registerHydrationWorker), US-011.
 *
 * Coalescing contract (US-011):
 *   When the hydrated workspace reaches a terminal state the handler checks
 *   whether a *newer* hydration row has appeared since the job was created. If
 *   so the current hydration row is marked `cancelled` (superseded) and the
 *   job is left to complete without further side effects. The newer job will
 *   be picked up naturally via its own queue entry.
 */

import { z } from 'zod';
import PgBoss from 'pg-boss';
import type { HiloConfig } from './hilo-config';
import { loadHiloConfig } from './hilo-config';
import { detectHilo } from './hilo-detector';
import { runHiloHydration } from './hilo-hydration-runner';
import { hydrationConcurrency } from './context-limits';
import { TooManyRequestsError } from './errors';
import {
  getHydrationById,
  getLatestHydration,
  updateHydration,
  type WorkspaceHydration,
} from '../db/workspace-hydration';
import { logger } from './logger';

// ════════════════════════════════════════════════════════════════════════════
// Job payload schema
// ════════════════════════════════════════════════════════════════════════════

const HydrationJobPayloadSchema = z.object({
  hydrationId: z.number().int().positive(),
  workspaceId: z.string().min(1),
  workspacePath: z.string().min(1),
  config: z.object({
    binaryPath: z.string().nullable().optional(),
    checkoutPath: z.string().min(1),
    outputDir: z.string().min(1),
    timeoutMs: z.number().int().positive().optional(),
  }),
});

type HydrationJobPayload = z.infer<typeof HydrationJobPayloadSchema>;

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

/**
 * Check whether a newer terminal (or running) hydration exists for the
 * workspace since this job was enqueued. Used by the coalescing guard
 * before and after execution to avoid duplicate concurrent work and to
 * cancel superseded rows.
 */
async function isSuperseded(
  hydrationId: number,
  workspaceId: string,
): Promise<boolean> {
  const latest = await getLatestHydration(workspaceId);
  if (!latest) return false;
  // A newer row exists (different id, created after ours) that is not
  // cancelled — our work is superseded.
  return latest.id > hydrationId && latest.status !== 'cancelled';
}

/**
 * Cancel a hydration row with a coalescing reason. Records a sanitized
 * error_json so the UI can distinguish cancellation from failure.
 */
async function cancelHydration(
  hydration: WorkspaceHydration,
  reason: string,
): Promise<void> {
  await updateHydration(hydration.id, {
    status: 'cancelled',
    errorJson: {
      message: reason,
      code: 'HYDRATION_SUPERSEDED',
      exitCode: null,
      signal: null,
      timedOut: false,
      stderrTail: null,
    },
    finishedAt: new Date(),
  });
}

/**
 * Build a HiloConfig-compatible object from the job payload's config block.
 * The route already resolved the config via loadHiloConfig before enqueuing,
 * so we trust the pre-resolved values but re-resolve to pick up any
 * runtime-level overrides that may have changed since enqueue time.
 */
function buildConfigFromPayload(payload: HydrationJobPayload): HiloConfig {
  // Re-load from disk in case config changed, but fall back to the
  // enqueued values if re-loading degrades (e.g. missing .rorca/config.json).
  const fresh = loadHiloConfig(payload.workspacePath);
  // Merge: payload config is the "last known good" that passed validation
  // at enqueue time; fresh values take precedence so that a config change
  // during the queue wait is honoured.
  return {
    enabled: fresh.enabled,
    binaryPath: fresh.binaryPath ?? payload.config.binaryPath ?? null,
    checkoutPath: fresh.checkoutPath || payload.config.checkoutPath,
    outputDir: fresh.outputDir || payload.config.outputDir,
    timeoutMs: fresh.timeoutMs ?? payload.config.timeoutMs ?? 120_000,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Job handler
// ════════════════════════════════════════════════════════════════════════════

async function handleHydrationJob(jobs: PgBoss.Job<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(jobs.map(async (job) => {
    const jobId = job.id;
    logger.info({ jobId, data: job.data }, '[hydration-worker] workspace:hydrate received');

    // 1. Validate payload
    const parsed = HydrationJobPayloadSchema.safeParse(job.data);
    if (!parsed.success) {
      logger.error(
        { jobId, errors: parsed.error.format() },
        '[hydration-worker] invalid hydration job payload — failing job',
      );
      throw new Error(`Invalid workspace:hydrate payload: ${parsed.error.message}`);
    }

    const payload = parsed.data;

    // 2. Load the hydration row
    const hydration = await getHydrationById(payload.hydrationId);
    if (!hydration) {
      logger.error(
        { jobId, hydrationId: payload.hydrationId },
        '[hydration-worker] hydration row not found — skipping',
      );
      return;
    }

    // 3. Skip terminal states (the row was cancelled or completed by another
    //    process while this job was in the queue).
    const terminalStatuses = new Set(['succeeded', 'failed', 'stale', 'cancelled']);
    if (terminalStatuses.has(hydration.status)) {
      logger.info(
        { jobId, hydrationId: hydration.id, status: hydration.status },
        '[hydration-worker] hydration already terminal — skipping',
      );
      return;
    }

    // 4. Coalescing guard (pre-execution): if a newer hydration exists for the
    //    same workspace, cancel this row and skip execution.
    if (await isSuperseded(hydration.id, hydration.workspaceId)) {
      await cancelHydration(hydration, 'Superseded by newer hydration request');
      logger.info(
        { jobId, hydrationId: hydration.id, workspaceId: hydration.workspaceId },
        '[hydration-worker] superseded by newer hydration — cancelled',
      );
      return;
    }

    // 5. Resolve Hilo config from payload + fresh disk config.
    const hiloConfig = buildConfigFromPayload(payload);

    // 6. Validate Hilo is available (it was checked at enqueue time, but state
    //    may have changed — binary removed, etc.).
    const hiloDetection = await detectHilo(hiloConfig);
    if (!hiloDetection.available) {
      const error: import('./hilo-hydration-runner').HiloHydrationRunError = {
        message: hiloDetection.message ?? 'Hilo is not available for this workspace',
        exitCode: null,
        signal: null,
        timedOut: false,
        stderrTail: null,
        code: 'HILO_SPAWN_FAILED',
      };
      await updateHydration(hydration.id, {
        status: 'failed',
        errorJson: error as unknown as import('../db/spec-jobs').JsonValue,
        finishedAt: new Date(),
      });
      logger.warn(
        { jobId, hydrationId: hydration.id, message: hiloDetection.message },
        '[hydration-worker] Hilo unavailable at execution time — failed',
      );
      return;
    }

    // 7. Execute hydration via the canonical runner (US-007).
    //    runHiloHydration handles all status updates, error sanitisation,
    //    and the try/finally guard that prevents dangling `running` rows.
    logger.info(
      { jobId, hydrationId: hydration.id, binaryPath: hiloConfig.binaryPath },
      '[hydration-worker] starting Hilo hydration',
    );

    // Bound hydration concurrency globally and per-workspace (US-039). Large
    // external repos can fan out heavy hydrations; the gate caps how many run
    // at once and sheds excess work with TooManyRequestsError rather than
    // exhausting memory/CPU. Per-workspace cap also reinforces coalescing.
    let result: Awaited<ReturnType<typeof runHiloHydration>>;
    try {
      result = await hydrationConcurrency().run(hydration.workspaceId, () =>
        runHiloHydration({
          hydration,
          config: hiloConfig,
        }),
      );
    } catch (error) {
      if (error instanceof TooManyRequestsError) {
        await updateHydration(hydration.id, {
          status: 'failed',
          errorJson: {
            message: error.message,
            code: 'HYDRATION_CONCURRENCY_LIMIT',
            exitCode: null,
            signal: null,
            timedOut: false,
            stderrTail: null,
          } as unknown as import('../db/spec-jobs').JsonValue,
          finishedAt: new Date(),
        });
        logger.warn(
          { jobId, hydrationId: hydration.id, workspaceId: hydration.workspaceId, error: error.message },
          '[hydration-worker] hydration concurrency queue full — failed hydration row with actionable retry error',
        );
      }
      throw error;
    }

    // 8. Coalescing guard (post-execution): if a newer hydration row appeared
    //    while we were running, mark this row as cancelled (superseded).
    if (await isSuperseded(hydration.id, hydration.workspaceId)) {
      // revert the status back to cancelled if the runner succeeded
      if (result.status === 'succeeded') {
        await cancelHydration(hydration, 'Superseded by newer hydration that completed');
        logger.info(
          { jobId, hydrationId: hydration.id },
          '[hydration-worker] hydration succeeded but was superseded — marked cancelled',
        );
      }
      return;
    }

    if (result.status === 'succeeded') {
      logger.info(
        {
          jobId,
          hydrationId: result.hydrationId,
          gitSha: result.gitSha,
          durationMs: result.durationMs,
        },
        '[hydration-worker] hydration succeeded',
      );
    } else {
      logger.warn(
        {
          jobId,
          hydrationId: result.hydrationId,
          error: result.error,
        },
        '[hydration-worker] hydration failed',
      );
      // Re-throw so pg-boss records the job failure for observability.
      throw new Error(result.error.message);
    }
  }));

  const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failed) {
    throw failed.reason instanceof Error ? failed.reason : new Error(String(failed.reason));
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Registration
// ════════════════════════════════════════════════════════════════════════════

/**
 * Register the `workspace:hydrate` job handler on the given pg-boss instance.
 * The queue must already exist (created by {@link ../db/pg-boss}.ensureQueues).
 * Safe to call multiple times — pg-boss deduplicates handlers by queue name.
 */
export async function registerHydrationWorker(boss: PgBoss): Promise<void> {
  // batchSize=1 ensures only one hydration runs at a time per worker.
  // Multiple workers can still run concurrent hydrations for different
  // workspaces, which is fine because coalescing is per-workspace.
  await boss.work('workspace:hydrate', { batchSize: 1 }, handleHydrationJob);
  logger.info('[hydration-worker] registered workspace:hydrate handler');
}
