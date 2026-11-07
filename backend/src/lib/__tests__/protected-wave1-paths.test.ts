/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';

const dbRead = jest.fn((..._args: unknown[]) => { throw new Error('DB_READ_OCCURRED'); });
const dbTransaction = jest.fn((..._args: unknown[]) => { throw new Error('DB_LOCK_OCCURRED'); });
jest.mock('../../db/index', () => ({
  query: (text: unknown, values?: unknown) => dbRead(text, values),
  queryOne: (text: unknown, values?: unknown) => dbRead(text, values),
  execute: (text: unknown, values?: unknown) => dbRead(text, values),
  transaction: (operation: unknown) => dbTransaction(operation),
  withPgAdvisoryLock: (key: unknown, operation: unknown) => dbTransaction(key, operation),
}));

import {
  finalizeHostStoryAttempt,
  finalizeUnfinishedHostAttemptGeneration,
  persistHostAttemptLaunches,
  requireSuccessfulHostStoryAttempt,
} from '../host-story-attempt-envelope';
import { inspectRunHostAuthority } from '../run-host-authority';
import { persistHostRunCloseout } from '../run-closeout-authority';
import { terminalizeCanonicalCancellation } from '../pipeline-cancellation';
import { requestGovernedRetryRunCancellation } from '../governed-retry-publication';
import { publishCloseoutReconciliation } from '../run-closeout-reconciliation';
import { WAVE_1_PROTECTED_GENESIS_RUN_ID } from '../wave-1-stabilization';

const runId = WAVE_1_PROTECTED_GENESIS_RUN_ID;
const fence = `sha256:${'a'.repeat(64)}`;

it('denies protected Genesis before every Wave host/retry/cancel/reconciliation read or lock', async () => {
  const operations: Array<Promise<unknown>> = [
    persistHostAttemptLaunches({
      workspaceId: 'protected', runId, launchGeneration: crypto.randomUUID(),
      cancellationFence: fence, canonicalSpecPath: 'forge/specs/pending/protected.json',
      runSpecPath: '/tmp/protected', repositoryPath: '/tmp', worktreePath: '/tmp',
      expectedGitSha: 'a'.repeat(40), expectedGitBranch: 'protected',
      runtime: { processRole: 'story-provider', workerId: 'worker', engineEntrypoint: '/tmp/engine', agent: 'pi', model: null, terminalMode: 'ansi-html', processPid: process.pid },
      manifests: [],
    }),
    finalizeHostStoryAttempt({
      workspaceId: 'protected', runId, storyId: 'W1', attempt: 1,
      launchGeneration: crypto.randomUUID(), cancellationFence: fence,
      manifestHash: fence, outcome: 'success', provenance: 'host_process', exitCode: 0,
    }),
    finalizeUnfinishedHostAttemptGeneration({
      workspaceId: 'protected', runId, cancellationFence: fence,
      outcome: 'crash', provenance: 'host_recovery',
    }),
    requireSuccessfulHostStoryAttempt({
      workspaceId: 'protected', runId, storyId: 'W1', attempt: 1,
      launchGeneration: crypto.randomUUID(), cancellationFence: fence, manifestHash: fence,
    }),
    inspectRunHostAuthority(runId),
    persistHostRunCloseout({ runId, status: 'failed', terminalizeRun: true }),
    terminalizeCanonicalCancellation({ runId, source: 'test', processQuiescent: true }),
    requestGovernedRetryRunCancellation({ runId, workspaceId: 'protected', requestedBy: 'test', reason: 'test' }),
    publishCloseoutReconciliation(crypto.randomUUID(), runId),
  ];
  for (const operation of operations) {
    await expect(operation).rejects.toMatchObject({
      code: 'WAVE_1_INTAKE_BLOCKED',
      details: { reason: 'PROTECTED_GENESIS_RUN' },
    });
  }
  expect(dbRead).not.toHaveBeenCalled();
  expect(dbTransaction).not.toHaveBeenCalled();
});
