/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { query } from '../db/index';
import { logger } from './logger';

export const PIPELINE_WORK_CONSUMER_CAPACITY = 10;
export const DEFAULT_QUEUE_MAX_CONCURRENT = 1;
export const DEFAULT_RUN_NOW_MAX_CONCURRENT = 3;

export interface WorkerConcurrencySettings {
  queueMaxConcurrent: number;
  runNowMaxConcurrent: number;
}

interface WorkerSettingRow {
  key: string;
  value: string;
}

function boundedPositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, PIPELINE_WORK_CONSUMER_CAPACITY);
}

export function resolveWorkerConcurrencySettings(rows: readonly WorkerSettingRow[]): WorkerConcurrencySettings {
  const settings = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const legacyMax = boundedPositiveInt(settings.max_concurrent_runs, 0);
  return {
    queueMaxConcurrent: boundedPositiveInt(
      settings.queue_max_concurrent,
      legacyMax > 0 ? legacyMax : DEFAULT_QUEUE_MAX_CONCURRENT,
    ),
    runNowMaxConcurrent: boundedPositiveInt(
      settings.run_now_max_concurrent,
      legacyMax > 0 ? legacyMax : DEFAULT_RUN_NOW_MAX_CONCURRENT,
    ),
  };
}

export async function getWorkerConcurrencySettings(): Promise<WorkerConcurrencySettings> {
  try {
    const rows = await query<WorkerSettingRow>(
      `SELECT key, value FROM worker_settings WHERE key IN ('queue_max_concurrent', 'run_now_max_concurrent', 'max_concurrent_runs')`,
    );
    return resolveWorkerConcurrencySettings(rows);
  } catch (error) {
    logger.warn({ error }, '[worker-concurrency] DB query failed, using bounded defaults');
    return {
      queueMaxConcurrent: DEFAULT_QUEUE_MAX_CONCURRENT,
      runNowMaxConcurrent: DEFAULT_RUN_NOW_MAX_CONCURRENT,
    };
  }
}

/**
 * Immediate/worktree, direct-workspace, and retry callbacks share one process
 * execution budget. The budget covers the largest independently admitted lane
 * while remaining within the operator-facing worker-settings cap.
 */
export function pipelineWorkSubscriptionCapacity(settings: WorkerConcurrencySettings): number {
  return Math.min(
    PIPELINE_WORK_CONSUMER_CAPACITY,
    Math.max(1, settings.queueMaxConcurrent, settings.runNowMaxConcurrent),
  );
}

export interface PipelineWorkerSubscriptionPlan {
  executionCapacity: number;
  isolatedRunConsumers: number;
  directRunConsumers: number;
  retryConsumers: number;
  callbackQueueDepth: number;
}

export function pipelineWorkerSubscriptionPlan(
  settings: WorkerConcurrencySettings,
): PipelineWorkerSubscriptionPlan {
  const executionCapacity = pipelineWorkSubscriptionCapacity(settings);
  const isolatedRunConsumers = Math.min(settings.runNowMaxConcurrent, PIPELINE_WORK_CONSUMER_CAPACITY);
  const directRunConsumers = Math.min(settings.queueMaxConcurrent, PIPELINE_WORK_CONSUMER_CAPACITY);
  const retryConsumers = executionCapacity;
  return {
    executionCapacity,
    isolatedRunConsumers,
    directRunConsumers,
    retryConsumers,
    callbackQueueDepth: isolatedRunConsumers + directRunConsumers + retryConsumers,
  };
}

interface PipelineBudgetWaiter {
  resolve: () => void;
}

/**
 * One process-lifetime execution budget shared by every pipeline queue lane.
 * Reconfiguration never replaces the semaphore: callbacks admitted by an old
 * pg-boss subscription remain visible while a lower limit takes effect.
 */
export class PipelineExecutionBudget {
  private active = 0;
  private capacity: number;
  private readonly waiters: PipelineBudgetWaiter[] = [];

  constructor(capacity: number, private readonly maxQueueDepth = PIPELINE_WORK_CONSUMER_CAPACITY * 6) {
    this.capacity = this.bounded(capacity);
  }

  private bounded(capacity: number): number {
    if (!Number.isInteger(capacity) || capacity < 1) return 1;
    return Math.min(capacity, PIPELINE_WORK_CONSUMER_CAPACITY);
  }

  reconfigure(capacity: number): void {
    this.capacity = this.bounded(capacity);
    this.drain();
  }

  private drain(): void {
    while (this.active < this.capacity && this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter) return;
      this.active += 1;
      waiter.resolve();
    }
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active < this.capacity) {
      this.active += 1;
    } else {
      if (this.waiters.length >= this.maxQueueDepth) {
        throw new Error(`Pipeline execution callback queue is full (${this.maxQueueDepth})`);
      }
      const { promise, resolve } = Promise.withResolvers<void>();
      this.waiters.push({ resolve });
      await promise;
    }
    try {
      return await operation();
    } finally {
      this.active = Math.max(0, this.active - 1);
      this.drain();
    }
  }

  snapshot(): { active: number; queued: number; capacity: number } {
    return { active: this.active, queued: this.waiters.length, capacity: this.capacity };
  }
}

export type PipelineAuthorityAdmission = 'claimed' | 'capacity_exhausted' | 'terminal';

/**
 * Acquire the durable queued -> starting authority only after budget admission.
 * Capacity races release the process slot before waiting and retry atomically,
 * so no execution lease can expire in the budget queue and direct waiters do
 * not starve isolated/retry work.
 */
export async function executeWithPipelineBudget<T>(
  budget: PipelineExecutionBudget,
  acquireAuthority: () => Promise<PipelineAuthorityAdmission>,
  operation: () => Promise<T>,
  waitForCapacity: () => Promise<void>,
): Promise<T | undefined> {
  while (true) {
    const attempt = await budget.run(async () => {
      const admission = await acquireAuthority();
      if (admission !== 'claimed') return { admission } as const;
      return { admission, value: await operation() } as const;
    });
    if (attempt.admission === 'claimed') return attempt.value;
    if (attempt.admission === 'terminal') return undefined;
    await waitForCapacity();
  }
}
