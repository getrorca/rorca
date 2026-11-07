/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** CI autofix completion is local/WAL-only; it never resolves provider authority. */

jest.mock('../../../db/index', () => ({ queryOne: jest.fn(), query: jest.fn(), execute: jest.fn() }));
jest.mock('../../sse-hub', () => ({ broadcastAll: jest.fn(), subscribe: jest.fn() }));
jest.mock('../../logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../pg-boss', () => ({ getBoss: jest.fn() }));

import { queryOne, query, execute } from '../../../db/index';
import { broadcastAll } from '../../sse-hub';
import { handleRunFinished } from '../fix-orchestrator';
import type { WalEvent } from '../../sse-hub';

const mockQueryOne = queryOne as jest.MockedFunction<typeof queryOne>;
const mockQuery = query as jest.MockedFunction<typeof query>;
const mockExecute = execute as jest.MockedFunction<typeof execute>;
const mockBroadcastAll = broadcastAll as jest.MockedFunction<typeof broadcastAll>;
const mockFetch = jest.fn();
global.fetch = mockFetch;

beforeEach(() => jest.clearAllMocks());

function event(runId: number, type = 'run_finished'): WalEvent {
  return {
    id: 100, ts: new Date().toISOString(), event_type: type,
    workspace_id: 'ws-1', spec_id: null, story_id: null, actor: 'worker',
    payload: JSON.stringify({ run_id: runId, status: 'done', source: 'worker' }),
  };
}

function arrange(runId: number, id: number, stories: Array<Record<string, unknown>>): void {
  mockQueryOne
    .mockResolvedValueOnce({ id: runId, status: 'done', trigger_type: 'ci-autofix' })
    .mockResolvedValueOnce({
      id, workspace_id: 'ws-1', head_sha: 'a'.repeat(40), branch_name: 'feat/fix',
      check_run_name: 'build', run_id: runId, agent_type: 'claude',
    })
    .mockResolvedValueOnce({ id: 200 + id, event_type: 'ci_autofix_completed', workspace_id: 'ws-1' });
  mockQuery.mockResolvedValueOnce(stories as never);
}

test('all stories passed updates local completion and emits WAL without provider mutation', async () => {
  arrange(42, 7, [{ story_id: 'CAF-FIX-001', status: 'pass', reason: null }]);
  await handleRunFinished(event(42));
  expect(mockFetch).not.toHaveBeenCalled();
  expect(mockExecute.mock.calls[0][0]).toContain('UPDATE ci_autofix_runs');
  expect(mockExecute.mock.calls[0][1]).toEqual(['completed', null, 7]);
  const payload = JSON.parse(mockQueryOne.mock.calls[2][1]![1] as string);
  expect(payload).toMatchObject({ runId: 42, success: true, storiesPassed: 1, storiesFailed: 0 });
  expect(mockBroadcastAll).toHaveBeenCalledTimes(1);
});

test('failed and timeout stories remain local failures with bounded diagnostics and no provider mutation', async () => {
  arrange(43, 8, [
    { story_id: 'CAF-FIX-001', status: 'fail', reason: 'Type errors remain' },
    { story_id: 'CAF-FIX-002', status: 'timeout', reason: 'A'.repeat(600) },
  ]);
  await handleRunFinished(event(43));
  expect(mockFetch).not.toHaveBeenCalled();
  expect(mockExecute.mock.calls[0][1]![0]).toBe('failed');
  const summary = mockExecute.mock.calls[0][1]![1] as string;
  expect(summary).toContain('CAF-FIX-001 (fail: Type errors remain)');
  expect(summary).toContain('CAF-FIX-002 (timeout:');
  expect(summary.length).toBeLessThanOrEqual(500);
});

test('automatic feedback code contains no token resolver or GitHub status actuator', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'fix-orchestrator.ts'), 'utf8');
  const completion = source.slice(source.indexOf('export async function handleRunFinished'));
  expect(completion).not.toContain('resolveWorkspaceGitHubToken');
  expect(completion).not.toContain('/statuses/');
  expect(completion).not.toContain('fetchGithubWithTimeout');
});

test('non-autofix and non-run_finished events are ignored', async () => {
  mockQueryOne.mockResolvedValueOnce({ id: 50, status: 'done', trigger_type: 'manual' });
  await handleRunFinished(event(50));
  await handleRunFinished(event(50, 'story_passed'));
  expect(mockQueryOne).toHaveBeenCalledTimes(1);
  expect(mockQuery).not.toHaveBeenCalled();
  expect(mockExecute).not.toHaveBeenCalled();
  expect(mockFetch).not.toHaveBeenCalled();
});

test('missing completion payload is ignored', async () => {
  await handleRunFinished({ ...event(51), payload: null });
  expect(mockQueryOne).not.toHaveBeenCalled();
});

test('missing ci_autofix_runs row returns without completion mutation', async () => {
  mockQueryOne
    .mockResolvedValueOnce({ id: 51, status: 'done', trigger_type: 'ci-autofix' })
    .mockResolvedValueOnce(undefined);
  await handleRunFinished(event(51));
  expect(mockQuery).not.toHaveBeenCalled();
  expect(mockExecute).not.toHaveBeenCalled();
  expect(mockFetch).not.toHaveBeenCalled();
});
