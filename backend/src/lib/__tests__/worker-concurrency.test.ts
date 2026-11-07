/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  PIPELINE_WORK_CONSUMER_CAPACITY,
  PipelineExecutionBudget,
  executeWithPipelineBudget,
  pipelineWorkerSubscriptionPlan,
  pipelineWorkSubscriptionCapacity,
  resolveWorkerConcurrencySettings,
} from '../worker-concurrency';

const repositoryRoot = fs.existsSync(path.resolve(process.cwd(), 'backend/src'))
  ? process.cwd()
  : path.resolve(process.cwd(), '..');

it('uses one bounded capacity contract for queued and immediate pipeline work', () => {
  expect(resolveWorkerConcurrencySettings([])).toEqual({
    queueMaxConcurrent: 1,
    runNowMaxConcurrent: 3,
  });
  expect(resolveWorkerConcurrencySettings([
    { key: 'queue_max_concurrent', value: '2' },
    { key: 'run_now_max_concurrent', value: '7' },
  ])).toEqual({ queueMaxConcurrent: 2, runNowMaxConcurrent: 7 });
  expect(pipelineWorkSubscriptionCapacity({
    queueMaxConcurrent: 2,
    runNowMaxConcurrent: 7,
  })).toBe(7);
  expect(pipelineWorkerSubscriptionPlan({
    queueMaxConcurrent: 2,
    runNowMaxConcurrent: 7,
  })).toEqual({
    executionCapacity: 7,
    isolatedRunConsumers: 7,
    directRunConsumers: 2,
    retryConsumers: 7,
    callbackQueueDepth: 16,
  });
});

it('hot reload lowers one process-lifetime budget before replacement callbacks can start', async () => {
  const budget = new PipelineExecutionBudget(3);
  const gates = Array.from({ length: 3 }, () => Promise.withResolvers<void>());
  let active = 0;
  let maximum = 0;
  const running = gates.map(({ promise }, index) => budget.run(async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await promise;
    active -= 1;
    return index;
  }));
  expect(budget.snapshot()).toEqual({ active: 3, queued: 0, capacity: 3 });

  budget.reconfigure(1);
  let replacementStarted = false;
  const replacement = budget.run(async () => {
    replacementStarted = true;
    active += 1;
    maximum = Math.max(maximum, active);
    active -= 1;
  });
  await Promise.resolve();
  expect(replacementStarted).toBe(false);

  gates[0].resolve();
  gates[1].resolve();
  await Promise.all([running[0], running[1]]);
  expect(replacementStarted).toBe(false);
  gates[2].resolve();
  await Promise.all([...running, replacement]);

  expect(maximum).toBe(3);

  expect(budget.snapshot()).toEqual({ active: 0, queued: 0, capacity: 1 });
});
it('acquires a fresh execution lease only after a budget wait longer than the lease duration', async () => {
  const budget = new PipelineExecutionBudget(1);
  const blocker = Promise.withResolvers<void>();
  let clockMs = 0;
  let leaseExpiresAt = 0;
  let authorityCalls = 0;
  const occupyingRetry = budget.run(async () => blocker.promise);

  const freshRun = executeWithPipelineBudget(
    budget,
    async () => {
      authorityCalls += 1;
      leaseExpiresAt = clockMs + 300_000;
      return 'claimed';
    },
    async () => {
      expect(clockMs).toBeLessThan(leaseExpiresAt);
    },
    async () => undefined,
  );
  await Promise.resolve();
  expect(authorityCalls).toBe(0);

  clockMs = 301_000;
  blocker.resolve();
  await Promise.all([occupyingRetry, freshRun]);
  expect(authorityCalls).toBe(1);
  expect(leaseExpiresAt).toBe(601_000);
});

it('releases the process slot before a direct capacity retry wait', async () => {
  const budget = new PipelineExecutionBudget(1);
  const capacityGate = Promise.withResolvers<void>();
  const started: string[] = [];
  let claims = 0;
  const waitingDirect = executeWithPipelineBudget(
    budget,
    async () => (++claims === 1 ? 'capacity_exhausted' : 'claimed'),
    async () => { started.push('direct'); },
    async () => capacityGate.promise,
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(budget.snapshot()).toEqual({ active: 0, queued: 0, capacity: 1 });

  await budget.run(async () => { started.push('isolated-or-retry'); });
  expect(started).toEqual(['isolated-or-retry']);
  capacityGate.resolve();
  await waitingDirect;
  expect(started).toEqual(['isolated-or-retry', 'direct']);
  expect(claims).toBe(2);
});

it('clamps legacy and split settings to the documented worker-settings cap', () => {
  expect(PIPELINE_WORK_CONSUMER_CAPACITY).toBe(10);
  expect(resolveWorkerConcurrencySettings([
    { key: 'max_concurrent_runs', value: '99' },
  ])).toEqual({ queueMaxConcurrent: 10, runNowMaxConcurrent: 10 });
  expect(resolveWorkerConcurrencySettings([
    { key: 'queue_max_concurrent', value: '11' },
    { key: 'run_now_max_concurrent', value: '500' },
  ])).toEqual({ queueMaxConcurrent: 10, runNowMaxConcurrent: 10 });
  expect(pipelineWorkSubscriptionCapacity({
    queueMaxConcurrent: 10,
    runNowMaxConcurrent: 10,
  })).toBe(10);
});

it('worker and queue promotion consume the same settings contract', () => {
  const worker = fs.readFileSync(path.join(repositoryRoot, 'backend/src/worker.ts'), 'utf8');
  const queue = fs.readFileSync(path.join(repositoryRoot, 'backend/src/lib/run-queue.ts'), 'utf8');
  const registration = worker.slice(
    worker.indexOf('export async function registerRunQueueConsumers'),
    worker.indexOf('// ── Graceful shutdown'),
  );

  expect(registration).toContain('pipelineWorkerSubscriptionPlan(settings)');
  expect(registration).toContain('executionBudget: PipelineExecutionBudget');
  expect(registration).toContain('boss.work<Record<string, unknown>>(PIPELINE_RUN_QUEUE');
  expect(registration).toContain('boss.work<Record<string, unknown>>(PIPELINE_DIRECT_RUN_QUEUE');
  expect(registration).toContain("boss.work<Record<string, unknown>>('pipeline:retry'");
  expect(registration).toContain('executionBudget.run(() => handlePipelineRetry(jobs))');
  expect(worker).toContain('executeWithPipelineBudget(');
  expect(queue).toContain('const { queueMaxConcurrent } = await getWorkerConcurrencySettings()');
  expect(queue).toContain('releaseDispatchPublication(runId, publicationOwner, reason)');
  expect(queue).not.toContain('releaseDispatchPublication(Number(runId)');
  expect(worker).not.toContain('RUN_QUEUE_CONSUMER_LIMIT');
  expect(worker).toContain('await registerRunQueueConsumers(boss, previousSettings, executionBudget)');
});
