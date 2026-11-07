/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const worker = fs.readFileSync(path.resolve(__dirname, '..', '..', 'worker.ts'), 'utf8');
const fresh = worker.slice(
  worker.indexOf('export async function handlePipelineRun'),
  worker.indexOf('// ── Job handler: pipeline:retry'),
);
const retry = worker.slice(
  worker.indexOf('export async function handlePipelineRetry'),
  worker.indexOf('// ── Job handler: pipeline:cron'),
);

function assertImmediateChildOwnership(handler: string): void {
  const spawnAt = handler.indexOf('const child = spawn(');
  const ownAt = handler.indexOf('resources.ownChild(child, runId)', spawnAt);
  expect(spawnAt).toBeGreaterThan(0);
  expect(ownAt).toBeGreaterThan(spawnAt);
  const executableSlice = handler.slice(spawnAt, ownAt).replace(/\/\/.*$/gm, '');
  expect(executableSlice).not.toMatch(/\bawait\b/);
}

test('fresh and retry jobs each have one lexical exact-once owner and no detached terminal handlers', () => {
  for (const handler of [fresh, retry]) {
    expect(handler).toContain('const resources = new WorkerRunResourceOwner({');
    expect(handler).toContain('} finally {\n      await resources.dispose();\n    }');
    expect(handler).toContain("resources.own('run-private Git state'");
    expect(handler).toContain("resources.own('model egress broker'");
    expect(handler).not.toMatch(/child\.on\(['"](?:close|error|exit)['"]/);
    expect(handler).toContain('const childTerminal = resources.ownChildDeadline(');
    assertImmediateChildOwnership(handler);
  }
  expect(fresh).toContain("resources.own('ordinary-local Pi runtime'");
  expect(retry).toContain('resources.ownTimer(leaseRenewal)');
});

test('fresh budget execution remains inside the lexical resource owner lifetime', () => {
  expect(fresh).toContain('return await executeWithPipelineBudget(');
  expect(fresh).not.toContain('return executeWithPipelineBudget(');
});

test('worker process handlers are direct-entrypoint-only and cannot trap a Jest worker shutdown', () => {
  const handlersAt = worker.indexOf('function installWorkerProcessHandlers(): void');
  const mainGuardAt = worker.indexOf('if (require.main === module) {');
  const installAt = worker.indexOf('installWorkerProcessHandlers();', mainGuardAt);
  expect(handlersAt).toBeGreaterThan(0);
  expect(mainGuardAt).toBeGreaterThan(handlersAt);
  expect(installAt).toBeGreaterThan(mainGuardAt);
  expect(worker.slice(0, handlersAt)).not.toContain("process.on('SIGTERM'");
  expect(worker.slice(mainGuardAt, installAt)).not.toContain("process.on('SIGTERM'");
});

test('fresh cancellation after spawn proves bounded owner quiescence before canonical terminalization', () => {
  expect(fresh).toContain("await resources.dispose();\n        await finalizeFreshRunCancellation(runId, 'worker_before_launch_lifecycle_advance');\n        return;");
  expect(fresh).toContain("await resources.dispose();\n        await finalizeFreshRunCancellation(runId, 'worker_before_launch_gate_release');\n        return;");
  expect(fresh).not.toContain("await childTerminal;\n        await finalizeFreshRunCancellation");
  expect(fresh).toContain('const terminal = await childTerminal;');
});

test('retry pre-spawn return and terminal paths stay inside the same owner finally', () => {
  const brokerAt = retry.indexOf("resources.own('model egress broker'");
  const missingAt = retry.indexOf("'[worker] retry spec path disappeared after the governed execution claim'");
  const spawnAt = retry.indexOf('const child = spawn(');
  const terminalAt = retry.indexOf('const terminal = await childTerminal;');
  const finallyAt = retry.lastIndexOf('await resources.dispose();');
  expect(brokerAt).toBeGreaterThan(0);
  expect(missingAt).toBeGreaterThan(brokerAt);
  expect(spawnAt).toBeGreaterThan(missingAt);
  expect(terminalAt).toBeGreaterThan(spawnAt);
  expect(finallyAt).toBeGreaterThan(terminalAt);
});

test('post-claim retry snapshot disappearance throws through canonical exact-owner terminalization and queue advancement', () => {
  const recheck = retry.indexOf('// Recheck the snapshot immediately before spawn.');
  const missingThrow = retry.indexOf("throw new Error('retry_spec_missing')", recheck);
  const catchAt = retry.indexOf('// Dispose first:', missingThrow);
  const terminalizer = retry.indexOf('terminalizeGovernedRetryRun({', catchAt);
  const advance = retry.indexOf('await advanceQueue(claimedWorkspaceId)', terminalizer);
  expect(recheck).toBeGreaterThan(0);
  expect(missingThrow).toBeGreaterThan(recheck);
  expect(retry.slice(recheck, missingThrow)).not.toContain('UPDATE pipeline_runs');
  expect(retry.slice(recheck, missingThrow)).not.toContain("emitWalEvent('run_finished'");
  expect(catchAt).toBeGreaterThan(missingThrow);
  expect(terminalizer).toBeGreaterThan(catchAt);
  expect(advance).toBeGreaterThan(terminalizer);
  expect(retry.slice(catchAt, terminalizer)).toContain("failureReason = errorMessage === 'retry_spec_missing'");
});

test('child errors prove quiescence before canonical persistence and propagate persistence failures', () => {
  const freshError = fresh.indexOf('const handleChildError');
  const freshDispose = fresh.indexOf('await resources.dispose();', freshError);
  const freshThrow = fresh.indexOf('execution_engine_child_error:', freshDispose);
  expect(freshDispose).toBeGreaterThan(freshError);
  expect(freshThrow).toBeGreaterThan(freshDispose);
  expect(fresh.slice(freshError, freshThrow)).not.toContain('UPDATE pipeline_runs');
  expect(fresh).toContain('includesWorkerChildQuiescenceError(outcome.reason)');
  expect(fresh).toContain('includesWorkerResourceCleanupError(outcome.reason)');
  expect(fresh).toContain('outcome.reason instanceof WorkerTerminalPersistenceError');
  expect(worker).toContain("run.status IN ('starting', 'running')");
  expect(worker).toContain('synthesizeAllMissingFrozenStoryFailures(id, failureWorkspaceId, failureReason)');

  const retryError = retry.indexOf('const handleChildError');
  const retryDispose = retry.indexOf('await resources.dispose();', retryError);
  const retryTerminalizer = retry.indexOf('terminalizeGovernedRetryRun({', retryDispose);
  expect(retryDispose).toBeGreaterThan(retryError);
  expect(retryTerminalizer).toBeGreaterThan(retryDispose);
  expect(retry).not.toContain('void childTerminal.then');
  expect(retry).toContain('throw terminalUpdateError;');
  expect(retry).toContain('await advanceQueue(workspaceId);');
  expect(retry).toContain('Retry child quiescence was not proved; durable terminalization is forbidden');
  expect(retry).toContain('Retry terminalized after resource cleanup failure');
});
