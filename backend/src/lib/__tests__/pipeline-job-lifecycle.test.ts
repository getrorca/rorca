/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  MAX_PIPELINE_EXECUTION_TIMEOUT_SECONDS,
  PGBOSS_EXPIRE_IN_CEILING_SECONDS,
  computePipelineExecutionTimeoutSeconds,
  pipelineExecutionJobSendOptions,
} from '../pipeline-job-lifecycle';

const srcRoot = path.resolve(__dirname, '..', '..');

test('genuine long-running ownership always exceeds the retired 300-second transport expiry', () => {
  const spec = {
    userStories: [
      { id: 'US-001', timeoutMinutes: 90 },
      { id: 'US-002', timeoutMinutes: 240 },
    ],
  };
  const executionTimeoutSeconds = computePipelineExecutionTimeoutSeconds(spec, ['US-001', 'US-002']);
  const options = pipelineExecutionJobSendOptions({ executionTimeoutSeconds });
  expect(executionTimeoutSeconds).toBeGreaterThan(300);
  // pg-boss v10 attorney hard-asserts expiration < 24h, and the 24h closeout
  // grace already exceeds that ceiling for every spec (min 2h timeout). The
  // transport expiration is a queue-liveness signal, not the execution bound:
  // the worker's heartbeat-aware reconciliation keeps a live engine running
  // even after the job expires, and the payload timeout stays authoritative.
  expect(options.expireInSeconds).toBe(PGBOSS_EXPIRE_IN_CEILING_SECONDS);
  expect(options.expireInSeconds).toBeLessThan(24 * 60 * 60);
});

test('invalid imported timeout values are engine-aligned and the whole run remains hard bounded', () => {
  const executionTimeoutSeconds = computePipelineExecutionTimeoutSeconds({
    userStories: Array.from({ length: 1_000 }, (_, index) => ({
      id: `US-${index}`,
      timeoutMinutes: index % 2 === 0 ? Number.POSITIVE_INFINITY : 999_999,
    })),
  });
  expect(executionTimeoutSeconds).toBe(MAX_PIPELINE_EXECUTION_TIMEOUT_SECONDS);
});

test('transport expiration clamps to the pg-boss ceiling for specs exceeding 24h', () => {
  const executionTimeoutSeconds = computePipelineExecutionTimeoutSeconds({
    userStories: Array.from({ length: 20 }, (_, index) => ({
      id: `US-${index}`,
      timeoutMinutes: 240,
    })),
  });
  expect(executionTimeoutSeconds).toBe(MAX_PIPELINE_EXECUTION_TIMEOUT_SECONDS);
  const options = pipelineExecutionJobSendOptions({ executionTimeoutSeconds });
  // pg-boss attorney asserts expiration strictly below 24h; the payload timeout
  // remains the authoritative execution bound.
  expect(options.expireInSeconds).toBe(PGBOSS_EXPIRE_IN_CEILING_SECONDS);
  expect(options.expireInSeconds).toBeLessThan(24 * 60 * 60);
  expect(options.expireInSeconds).toBeLessThan(executionTimeoutSeconds);
 });

test('every production pipeline run/retry send path derives expiration from the immutable payload', () => {
  const sources = [
    path.join(srcRoot, 'worker.ts'),
    path.join(srcRoot, 'routes', 'pipeline.ts'),
    path.join(srcRoot, 'lib', 'dispatch-publication.ts'),
    path.join(srcRoot, 'lib', 'ci-autofix', 'fix-orchestrator.ts'),
  ].map(file => fs.readFileSync(file, 'utf8')).join('\n');
  expect(sources).not.toMatch(/pipeline:(?:run|retry)'[\s\S]{0,220}expireInSeconds:\s*300/);
  const sends = [...sources.matchAll(/\.send\('pipeline:(?:run|retry)'/g)];
  const boundedOptions = [...sources.matchAll(/pipelineExecutionJobSendOptions\(/g)];
  expect(sends.length).toBeGreaterThan(0);
  expect(boundedOptions.length).toBeGreaterThanOrEqual(sends.length);
});
