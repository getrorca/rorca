/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fallbackReplayBlocksCompletion, type FallbackReplayResult } from '../lib/fallback-replay';

const WORKER_SOURCE = fs.readFileSync(path.resolve(__dirname, '..', 'worker.ts'), 'utf8');

function result(overrides: Partial<FallbackReplayResult>): FallbackReplayResult {
  return {
    total: 0,
    inserted: 0,
    duplicates: 0,
    invalid: 0,
    retained: false,
    incomplete: false,
    criticalTotal: 0,
    criticalCompleted: 0,
    criticalInvalid: 0,
    criticalIncomplete: false,
    blocksCompletion: false,
    atomicFinalizations: 0,
    ...overrides,
  };
}

describe('worker fallback terminal gate', () => {
  test.each([
    result({ retained: true, criticalTotal: 1, criticalCompleted: 1 }),
    result({ invalid: 1, retained: true, criticalTotal: 1, criticalInvalid: 1 }),
    result({ incomplete: true, criticalTotal: 1, criticalIncomplete: true }),
  ])('blocks retained, invalid, or incomplete critical replay', (replay) => {
    expect(fallbackReplayBlocksCompletion(replay)).toBe(true);
  });

  test('startup refinalizes pass authority before stale-job, orphan, or state terminal decisions', () => {
    const startupRecovery = WORKER_SOURCE.lastIndexOf('const firstPassRecovery = await recoverUnreleasedIntegratedPasses();');
    const staleRecovery = WORKER_SOURCE.indexOf('await recoverStaleJobs();', startupRecovery);
    const orphanSweep = WORKER_SOURCE.indexOf('await sweepOrphanProcesses();', startupRecovery);
    const stateReconcile = WORKER_SOURCE.indexOf('await reconcileState();', startupRecovery);
    expect(startupRecovery).toBeGreaterThan(0);
    expect(staleRecovery).toBeGreaterThan(startupRecovery);
    expect(orphanSweep).toBeGreaterThan(staleRecovery);
    expect(stateReconcile).toBeGreaterThan(orphanSweep);
  });

  test('does not block a retained telemetry-only journal', () => {    expect(fallbackReplayBlocksCompletion(result({ retained: true, incomplete: true }))).toBe(false);
  });

  test('both normal and retry workers apply replay before terminal success/sync', () => {
    expect(WORKER_SOURCE.match(/fallbackReplayBlocksCompletion\(fallbackReplay\)/g)).toHaveLength(2);
    const normalReplay = WORKER_SOURCE.indexOf('const fallbackReplay = await replayWorkerFallbackResults(cwd');
    const normalStatus = WORKER_SOURCE.indexOf("let status = wasCancelled ? 'cancelled'", normalReplay);
    const normalGate = WORKER_SOURCE.indexOf('fallbackReplayBlocksCompletion(fallbackReplay)', normalStatus);
    expect(normalReplay).toBeGreaterThan(0);
    expect(normalGate).toBeGreaterThan(normalStatus);
    expect(WORKER_SOURCE).toContain("hostAuthority?.releaseEligible === true");
    expect(WORKER_SOURCE).not.toContain('All stories passed on the run branch despite exit');

    const retryReplay = WORKER_SOURCE.indexOf('const fallbackReplay = await replayWorkerFallbackResults(cwd', normalReplay + 1);
    const retryStatus = WORKER_SOURCE.indexOf('let finalStatus: string;', retryReplay);
    const retryGate = WORKER_SOURCE.indexOf('fallbackReplayBlocksCompletion(fallbackReplay)', retryStatus);
    const governedFinalization = WORKER_SOURCE.indexOf('const governedFinalizedStoryIds', retryGate);
    expect(retryReplay).toBeGreaterThan(normalReplay);
    expect(retryGate).toBeGreaterThan(retryStatus);
    expect(governedFinalization).toBeGreaterThan(retryGate);
    expect(WORKER_SOURCE).not.toContain('syncRetrySpecPassesToOriginalSpec');
  });
});
