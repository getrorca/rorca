/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as path from 'path';
import { shouldActuateReleaseStep } from '../release-authority';

const releaseSource = fs.readFileSync(path.join(process.cwd(), 'src/lib/release-authority.ts'), 'utf8');
const workerSource = fs.readFileSync(path.join(process.cwd(), 'src/worker.ts'), 'utf8');
const engineSource = fs.readFileSync(path.join(process.cwd(), 'src/lib/execution-engine.ts'), 'utf8');
const mergeSource = fs.readFileSync(path.join(process.cwd(), 'src/lib/merge-handler.ts'), 'utf8');
const checkSource = fs.readFileSync(path.join(process.cwd(), 'src/lib/check-run-poster.ts'), 'utf8');

test.each(['merge', 'push', 'pr', 'release_closeout', 'terminal_intent', 'cleanup', 'public_done', 'terminal_relay'])(
  'a crash before/after %s converges through durable step state',
  () => {
    expect(shouldActuateReleaseStep(undefined)).toBe(true);
    expect(shouldActuateReleaseStep('pending')).toBe(true);
    expect(shouldActuateReleaseStep('processing')).toBe(true);
    expect(shouldActuateReleaseStep('completed')).toBe(false);
    expect(shouldActuateReleaseStep('not_required')).toBe(false);
  },
);

test('terminal intent is durable before public done and relay follows done', () => {
  const reconcile = releaseSource.slice(releaseSource.indexOf('export async function reconcileRunReleaseIntent'));
  expect(reconcile.indexOf('persistTerminalIntent(row)')).toBeLessThan(reconcile.indexOf('commitPublicDoneAndTerminalReady(row, terminal)'));
  expect(reconcile.indexOf('commitPublicDoneAndTerminalReady(row, terminal)')).toBeLessThan(reconcile.indexOf('relayTrustedWalEvent(terminal)'));
  const atomic = releaseSource.slice(
    releaseSource.indexOf('async function commitPublicDoneAndTerminalReady'),
    releaseSource.indexOf('export async function reconcileRunReleaseIntent'),
  );
  expect(atomic).toContain("SET status = 'done'");
  expect(atomic).toContain('SET outbox_ready_at = COALESCE(outbox_ready_at, NOW())');
  expect(workerSource).toContain('reconcilePendingRunReleases()');
  expect(workerSource).not.toContain('gh pr');
});

test('direct merge preserves immutable execution identity until durable cleanup', () => {
  expect(mergeSource).not.toContain('SET worktree_path = NULL');
  expect(mergeSource).toContain("worktree_cleanup_status = 'pending'");
  expect(releaseSource.indexOf('persistTerminalIntent(row)')).toBeLessThan(releaseSource.indexOf('cleanupExecutionWorktree(row)'));
  expect(checkSource).toContain('terminal_checkout_sha');
  expect(checkSource).toContain('release_authorized_sha');
});

test('story commits stay local and deployment/workflow authority is absent', () => {
  const commitFunction = engineSource.slice(
    engineSource.indexOf('function gitCommitStory('),
    engineSource.indexOf('// ─── Validation Gate'),
  );
  expect(commitFunction).not.toContain('git push');
  expect(releaseSource).toContain("setStep(exact.runId, 'workflow', 'not_required')");
  expect(releaseSource).toContain('GIT_CONFIG_NOSYSTEM');
  expect(releaseSource).toContain("'-c', 'credential.helper='");
});
