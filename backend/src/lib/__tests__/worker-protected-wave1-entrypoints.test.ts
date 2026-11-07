/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import type PgBoss from 'pg-boss';

const dbAccess = jest.fn((..._args: unknown[]) => { throw new Error('DB_ACCESS_OCCURRED'); });
const dispatchClaim = jest.fn((..._args: unknown[]) => { throw new Error('DISPATCH_CLAIM_OCCURRED'); });

jest.mock('../../db/index', () => ({
  query: (text: unknown, values?: unknown) => dbAccess('query', text, values),
  queryOne: (text: unknown, values?: unknown) => dbAccess('queryOne', text, values),
  execute: (text: unknown, values?: unknown) => dbAccess('execute', text, values),
  transaction: (operation: unknown) => dbAccess('transaction', operation),
  withPgAdvisoryLock: (key: unknown, operation: unknown) => dbAccess('lock', key, operation),
}));

jest.mock('../dispatch-publication', () => ({
  claimDispatchForWorker: (...args: unknown[]) => dispatchClaim(...args),
  recoverPendingDispatchPublications: jest.fn(),
}));

import {
  handlePipelineCancel,
  handlePipelineRetry,
  handlePipelineRun,
} from '../../worker';
import { WAVE_1_PROTECTED_GENESIS_RUN_ID } from '../wave-1-stabilization';

const runId = WAVE_1_PROTECTED_GENESIS_RUN_ID;

function job(data: Record<string, unknown>): PgBoss.Job<Record<string, unknown>> {
  return { id: '00000000-0000-4000-8000-000000000001', name: 'test', data } as PgBoss.Job<Record<string, unknown>>;
}

const runPayload = {
  runId,
  specPath: 'forge/specs/approved/protected.json',
  runSpecPath: '/tmp/protected/.rorca/run-specs/run.json',
  workspacePath: '/tmp/protected',
  agent: 'pi',
  model: null,
  worktreePath: null,
  branchName: null,
  autoWorktree: false,
  envOverrides: {},
};

const retryPayload = {
  runId,
  originalRunId: runId,
  storyIds: ['W1-PROTECTED'],
  scopeHash: `sha256:${'a'.repeat(64)}`,
  previewHash: `sha256:${'b'.repeat(64)}`,
  approvedPreview: { schemaVersion: 'retry-preview.v1' },
  generatedPlanHash: `sha256:${'c'.repeat(64)}`,
  dispatchIdentity: {
    schemaVersion: 'rorca.governed-retry-dispatch.v1',
    identityHash: `sha256:${'d'.repeat(64)}`,
  },
  workspacePath: '/tmp/protected',
  specPath: 'forge/specs/approved/protected.json',
  runSpecPath: '/tmp/protected/.rorca/run-specs/retry.json',
  retrySpecPath: '/tmp/protected/.rorca/run-specs/retry.json',
  agent: 'pi',
  model: null,
  worktreePath: null,
  branchName: null,
  terminalMode: 'ansi-html',
  sequenceOffset: 0,
  envOverrides: {},
};

it('actual worker run/retry/cancel handlers deny protected Genesis before claims, reads, writes, or locks', async () => {
  const operations = [
    handlePipelineRun([job(runPayload)]),
    handlePipelineRetry([job(retryPayload)]),
    handlePipelineCancel([job({ runId })]),
  ];
  for (const operation of operations) {
    await expect(operation).rejects.toMatchObject({
      code: 'WAVE_1_INTAKE_BLOCKED',
      details: { reason: 'PROTECTED_GENESIS_RUN' },
    });
  }
  expect(dispatchClaim).not.toHaveBeenCalled();
  expect(dbAccess).not.toHaveBeenCalled();
});
