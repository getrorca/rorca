/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const source = (relative: string): string => fs.readFileSync(path.resolve(__dirname, '..', '..', relative), 'utf8');
const ENGINE = source('lib/execution-engine.ts');
const RELEASE = source('lib/release-authority.ts');
const PIPELINE = source('routes/pipeline.ts');
const WORKER = source('worker.ts');
const LOCAL_RUNNER = source('runner/local-runner.ts');
const RUNNER_JOBS = source('lib/execution-runner-jobs.ts');

describe('GitHub authority × parallel-wave reconciliation collisions', () => {
  test('freezes authority and wave metadata into the same fresh and retry dispatches', () => {
    const freshPayload = PIPELINE.slice(
      PIPELINE.indexOf('const jobPayload = {'),
      PIPELINE.indexOf('let runnerJobId:', PIPELINE.indexOf('const jobPayload = {')),
    );
    for (const field of [
      'workspaceId,', 'runSpecPath,', 'executionManifestPath:',
      'orchestrationMode:', 'parallelism:', 'triggerOptions:',
    ]) {
      expect(freshPayload).toContain(field);
    }

    const retryInsert = PIPELINE.slice(
      PIPELINE.indexOf('const newRunResult = await queryOne'),
      PIPELINE.indexOf('const newRunId =', PIPELINE.indexOf('const newRunResult = await queryOne')),
    );
    for (const column of [
      'trigger_options', 'expected_story_ids', 'excluded_story_ids',
      'execution_workspace_path', 'execution_worktree_path',
      'predecessor_pass_story_ids', 'predecessor_authority_hash',
    ]) {
      expect(retryInsert).toContain(column);
    }
    expect(retryInsert).toContain('JSON.stringify(retryTriggerOptions)');
  });

  test('worker policy cannot bypass frozen paths, sandbox preflight, or exact manifests', () => {
    const handler = WORKER.slice(
      WORKER.indexOf('async function handlePipelineRun('),
      WORKER.indexOf('// ── Job handler: pipeline:retry'),
    );
    const frozenIdentity = handler.indexOf('assertFrozenRunExecutionIdentity({');
    const wavePolicy = handler.indexOf('enforceWorkerWavePolicy({', frozenIdentity);
    const boundary = handler.indexOf('assertAutonomousExecutionBoundary({', wavePolicy);
    const egress = handler.indexOf('await ensureAutonomousModelEgress()', boundary);
    const snapshot = handler.indexOf('path.resolve(runSpecPath) !== expectedRunSpecPath', egress);
    const manifestArg = handler.indexOf("engineArgs.push('--execution-manifests'", snapshot);
    const spawn = handler.indexOf('const child = spawn(', manifestArg);

    expect(frozenIdentity).toBeGreaterThan(0);
    expect(wavePolicy).toBeGreaterThan(frozenIdentity);
    expect(boundary).toBeGreaterThan(wavePolicy);
    expect(egress).toBeGreaterThan(boundary);
    expect(snapshot).toBeGreaterThan(egress);
    expect(manifestArg).toBeGreaterThan(snapshot);
    expect(spawn).toBeGreaterThan(manifestArg);
    const outcomes = handler.indexOf('const outcomes = await Promise.allSettled');
    const terminalization = handler.indexOf("process: 'fresh_run_preflight'", outcomes);
    const failedUpdate = handler.indexOf("SET status = 'failed'", outcomes);
    const unboundReject = handler.indexOf('throw new AggregateError', terminalization);
    expect(outcomes).toBeGreaterThan(0);
    expect(failedUpdate).toBeGreaterThan(outcomes);
    expect(terminalization).toBeGreaterThan(failedUpdate);
    expect(unboundReject).toBeGreaterThan(terminalization);
  });

  test('wave settlement cannot become pass before integration and durable result authority', () => {
    const parallel = ENGINE.slice(ENGINE.indexOf('async function runParallel('));
    const settlement = parallel.indexOf('accountWaveSettlement({');
    const rejectionEvidence = parallel.indexOf("reasonCode: 'wave_promise_rejected'", settlement);
    const blocked = parallel.indexOf('await persistNewlyBlockedStories(wave.index)', rejectionEvidence);
    const merge = parallel.indexOf('await mergeWave(', blocked);
    const integratedFinalizer = parallel.indexOf('await finalizeMergedWorktree(', merge);
    const cleanup = parallel.indexOf('selectWaveWorktreeCleanup(', integratedFinalizer);

    expect(settlement).toBeGreaterThan(0);
    expect(rejectionEvidence).toBeGreaterThan(settlement);
    expect(blocked).toBeGreaterThan(rejectionEvidence);
    expect(merge).toBeGreaterThan(blocked);
    expect(integratedFinalizer).toBeGreaterThan(merge);
    expect(cleanup).toBeGreaterThan(integratedFinalizer);
    expect(parallel).toContain('pendingCloseoutIds: new Set(pendingIntegratedPasses.keys())');
    expect(parallel).toContain('evidenceFailureIds');
  });

  test('public done follows durable closeout while retired local-user transport terminates failed', () => {
    const reconcile = RELEASE.slice(RELEASE.indexOf('export async function reconcileRunReleaseIntent('));
    const closeout = reconcile.indexOf("VALUES ('run_closeout'");
    const terminal = reconcile.indexOf('terminal = await persistTerminalIntent(row)', closeout);
    const publicDone = reconcile.indexOf('await commitPublicDoneAndTerminalReady(row, terminal)', terminal);
    const relay = reconcile.indexOf('await relayTrustedWalEvent(terminal)', publicDone);
    expect(closeout).toBeGreaterThan(0);
    expect(terminal).toBeGreaterThan(closeout);
    expect(publicDone).toBeGreaterThan(terminal);
    expect(relay).toBeGreaterThan(publicDone);
    expect(RELEASE).toContain('semantic_closeout: true');

    const completion = RUNNER_JOBS.slice(
      RUNNER_JOBS.indexOf('export async function completeRunnerJob('),
      RUNNER_JOBS.indexOf('export async function cancelRunnerJobForRun('),
    );
    expect(completion).toContain("input.status === 'cancelled' ? 'cancelled' : 'failed'");
    expect(completion).toContain('local_user_execution_unavailable');
    expect(completion).not.toContain("? 'release_pending'");
    expect(completion).not.toContain("? 'done'");
  });

  test('local runner uses frozen artifacts and never invokes package-manager fallback', () => {
    const runJob = LOCAL_RUNNER.slice(
      LOCAL_RUNNER.indexOf('async function runJob('),
      LOCAL_RUNNER.indexOf('async function main('),
    );
    expect(runJob).toContain('value: payload.runSpecPath');
    expect(runJob).toContain('value: payload.executionManifestPath');
    expect(runJob).toContain("args.push('--workspace-id', payload.workspaceId)");
    expect(runJob).toContain("args.push('--execution-manifests', executionManifestPath)");
    expect(runJob).toContain("args.push('--workspace-path', repositoryRoot)");
    expect(runJob).not.toContain("'npx'");
    expect(ENGINE).toContain('config.parallelism > 1 && !isPtyTerminalMode(config.terminalMode)');
  });
});
