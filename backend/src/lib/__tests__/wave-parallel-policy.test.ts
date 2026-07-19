/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  EXPERIMENTAL_WAVE_PARALLEL_ENV,
  WAVE_PARALLEL_POLICY_ERROR_CODE,
  enforceWaveDispatchConsistency,
  enforceWaveParallelPolicy,
  evaluateWaveParallelPolicy,
} from '../wave-parallel-policy';

describe('wave-parallel control-plane policy', () => {
  test('defaults ordinary requests to truthful sequential execution', () => {
    expect(enforceWaveParallelPolicy({ source: 'api-trigger' }, {})).toEqual({
      mode: 'sequential',
      parallelism: 1,
      experimental: false,
      optInIgnored: false,
      source: 'api-trigger',
    });
  });

  test('rejects explicit parallel execution with a typed actionable policy error', () => {
    expect(() => enforceWaveParallelPolicy({
      source: 'api-trigger',
      requestedMode: 'wave-parallel',
      requestedParallelism: 4,
    }, {})).toThrow(expect.objectContaining({
      code: WAVE_PARALLEL_POLICY_ERROR_CODE,
      statusCode: 422,
      details: expect.objectContaining({
        reason: 'experimental_opt_in_required',
        action: expect.stringContaining(`${EXPERIMENTAL_WAVE_PARALLEL_ENV}=true`),
      }),
    }));
  });

  test('rejects contradictory mode and parallelism claims instead of normalizing silently', () => {
    expect(() => enforceWaveParallelPolicy({
      source: 'direct-job',
      requestedMode: 'sequential',
      requestedParallelism: 2,
    }, { nodeEnv: 'test', experimentalOptIn: 'true' })).toThrow(expect.objectContaining({
      code: WAVE_PARALLEL_POLICY_ERROR_CODE,
      details: expect.objectContaining({ reason: 'conflicting_request' }),
    }));
  });

  test('allows the explicitly named experiment only outside production', () => {
    expect(enforceWaveParallelPolicy({
      source: 'api-trigger',
      requestedMode: 'wave-parallel',
      requestedParallelism: 3,
    }, {
      nodeEnv: 'development',
      experimentalOptIn: 'true',
    })).toEqual({
      mode: 'wave-parallel',
      parallelism: 3,
      experimental: true,
      optInIgnored: false,
      source: 'api-trigger',
    });
  });

  test('production refuses parallel execution despite the experimental opt-in', () => {
    const decision = evaluateWaveParallelPolicy({
      source: 'api-trigger',
      requestedMode: 'wave-parallel',
      requestedParallelism: 2,
    }, {
      nodeEnv: 'production',
      experimentalOptIn: 'true',
    });

    expect(decision).toEqual(expect.objectContaining({
      allowed: false,
      reason: 'production_forbidden',
      details: expect.objectContaining({ experimentalOptInIgnored: true }),
    }));
  });

  test('production ignores an idle opt-in while preserving safe sequential defaults', () => {
    expect(enforceWaveParallelPolicy({ source: 'api-trigger' }, {
      nodeEnv: 'production',
      experimentalOptIn: 'true',
    })).toEqual(expect.objectContaining({
      mode: 'sequential',
      parallelism: 1,
      experimental: false,
      optInIgnored: true,
    }));
  });

  test('refuses retry/direct-job bypasses and inconsistent trigger claims', () => {
    expect(() => enforceWaveDispatchConsistency({
      source: 'worker-retry',
      payloadMode: 'sequential',
      payloadParallelism: 1,
      rowParallelism: 5,
      triggerOptions: { orchestrationMode: 'wave-parallel', parallelism: 5 },
      environment: { nodeEnv: 'production', experimentalOptIn: 'true' },
    })).toThrow(expect.objectContaining({ code: WAVE_PARALLEL_POLICY_ERROR_CODE }));

    expect(() => enforceWaveDispatchConsistency({
      source: 'worker-direct-job',
      payloadMode: 'wave-parallel',
      payloadParallelism: 2,
      rowParallelism: 2,
      triggerOptions: { orchestrationMode: 'wave-parallel', parallelism: 2 },
      environment: { nodeEnv: 'production' },
    })).toThrow(expect.objectContaining({
      details: expect.objectContaining({ reason: 'production_forbidden' }),
    }));
  });

  test('all dispatch ingress paths invoke the shared policy before engine spawn', () => {
    const sourceRoot = path.resolve(__dirname, '..', '..');
    const pipelineSource = fs.readFileSync(path.join(sourceRoot, 'routes', 'pipeline.ts'), 'utf8');
    const workerSource = fs.readFileSync(path.join(sourceRoot, 'worker.ts'), 'utf8');
    const localRunnerSource = fs.readFileSync(path.join(sourceRoot, 'runner', 'local-runner.ts'), 'utf8');
    const queueConsumerSource = fs.readFileSync(path.join(sourceRoot, 'lib', 'queue-consumer.ts'), 'utf8');
    const runQueueSource = fs.readFileSync(path.join(sourceRoot, 'routes', 'run-queue.ts'), 'utf8');

    expect(pipelineSource).toContain("source: 'pipeline-trigger'");
    expect(pipelineSource).toContain("source: 'pipeline-retry'");
    expect(workerSource).toContain("source: 'worker-run'");
    expect(workerSource).toContain("source: 'worker-retry'");
    expect(workerSource.match(/enforceWorkerWavePolicy\(/g)).toHaveLength(3); // definition + two handlers
    expect(localRunnerSource).toContain("source: 'local-runner-job'");
    expect(queueConsumerSource).toContain("source: 'run-queue-consumer'");
    expect(runQueueSource).toContain("source: 'run-queue-api'");
  });

  test('accepts only truthful effective trigger options for experimental direct jobs', () => {
    const environment = { nodeEnv: 'test', experimentalOptIn: 'true' };
    expect(enforceWaveDispatchConsistency({
      source: 'worker-direct-job',
      payloadMode: 'wave-parallel',
      payloadParallelism: 2,
      rowParallelism: 2,
      triggerOptions: {
        orchestrationMode: 'wave-parallel',
        parallelism: 2,
        orchestration: { mode: 'wave-parallel', parallelism: 2 },
      },
      environment,
    })).toEqual(expect.objectContaining({ mode: 'wave-parallel', parallelism: 2 }));

    expect(() => enforceWaveDispatchConsistency({
      source: 'worker-direct-job',
      payloadMode: 'wave-parallel',
      payloadParallelism: 2,
      rowParallelism: 2,
      triggerOptions: { orchestrationMode: 'sequential', parallelism: 1 },
      environment,
    })).toThrow(expect.objectContaining({
      details: expect.objectContaining({
        effectiveMode: 'wave-parallel',
        claimedMode: 'sequential',
      }),
    }));
  });
});
