/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const queryOne = jest.fn();
const transaction = jest.fn();
const broadcastAll = jest.fn();

jest.mock('../../db/index', () => ({
  queryOne: (...args: unknown[]) => queryOne(...args),
  execute: jest.fn(),
  transaction: (...args: unknown[]) => transaction(...args),
}));
jest.mock('../sse-hub', () => ({ broadcastAll: (...args: unknown[]) => broadcastAll(...args) }));

import { replayFallbackResults } from '../fallback-replay';
import { flushFallbackWrites, writeFallbackResult, type FallbackResultEntry } from '../resilient-post';

function entry(key: string, storyId: string): FallbackResultEntry {
  return {
    type: 'wal', storyId, status: 'story_token_update', runId: 7,
    retries: 1, ts: '2026-07-15T00:00:00.000Z', idempotencyKey: key,
    coalesceKey: `7:${storyId}`, sequence: 1,
    payload: {
      event_type: 'story_token_update', workspace_id: 'test-ws', story_id: storyId,
      idempotency_key: key, occurred_at: '2026-07-15T00:00:00.000Z',
      payload: { run_id: 7, story_id: storyId, cumulative_input: 10 },
    },
  };
}

describe('fallback replay idempotency', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-fallback-replay-'));
    queryOne.mockReset();
    transaction.mockReset();
    broadcastAll.mockReset();
  });

  afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

  test('retains an interrupted journal and safely skips prior inserts on retry', async () => {
    await writeFallbackResult(cwd, entry('key-1', 'US-001'));
    await writeFallbackResult(cwd, entry('key-2', 'US-002'));
    await flushFallbackWrites(cwd);

    const persisted = new Set<string>();
    let failSecondOnce = true;
    queryOne.mockImplementation(async (sql: string, values: unknown[]) => {
      if (!sql.includes('INSERT INTO wal_events')) return undefined;
      const key = values[5] as string;
      if (key === 'key-2' && failSecondOnce) {
        failSecondOnce = false;
        throw new Error('isolated test pool pressure');
      }
      if (persisted.has(key)) return undefined;
      persisted.add(key);
      return {
        id: persisted.size, ts: values[6], event_type: values[0],
        workspace_id: values[1], spec_id: null, story_id: values[3],
        actor: 'ralph', payload: values[4],
      };
    });

    const first = await replayFallbackResults(cwd, 'test-ws');
    expect(first.retained).toBe(true);
    expect(fs.existsSync(path.join(cwd, '.rorca-results.jsonl'))).toBe(true);

    const second = await replayFallbackResults(cwd, 'test-ws');
    expect(second).toMatchObject({ total: 2, inserted: 1, duplicates: 1, retained: false });
    expect(fs.existsSync(path.join(cwd, '.rorca-results.jsonl'))).toBe(false);
    expect(persisted).toEqual(new Set(['key-1', 'key-2']));
    expect(broadcastAll).toHaveBeenCalledTimes(2);
  });

  test('replays a complete story result through the canonical atomic projection', async () => {
    const sha = 'a'.repeat(40);
    const storyEntry: FallbackResultEntry = {
      type: 'story_result',
      storyId: 'US-FALLBACK-001',
      status: 'pass',
      runId: 7,
      retries: 3,
      ts: '2026-07-15T00:01:02.000Z',
      idempotencyKey: 'story-result:fallback-atomic-1',
      payload: {
        runId: 7,
        storyId: 'US-FALLBACK-001',
        status: 'pass',
        worktreePath: '/tmp/fallback-story',
        worktreeBranch: 'run/fallback-integrated',
        commitSha: sha,
        commitMessage: 'integrated story(US-FALLBACK-001): fallback exact head',
        inputTokens: 321,
        outputTokens: 54,
        reasoningTokens: 11,
        modelUsed: 'pi/fallback-model',
        costUsd: 0.1234567,
        logPath: '/tmp/fallback-story.log',
        blockedBy: ['US-000'],
        activeSkills: ['release-review'],
        completionPacket: { status: 'completed', closeout: { accepted: true } },
        idempotencyKey: 'story-result:fallback-atomic-1',
      },
    };
    await writeFallbackResult(cwd, storyEntry);
    await flushFallbackWrites(cwd);

    const persisted: { result?: Record<string, unknown>; commit?: Record<string, unknown>; usage?: Record<string, unknown> } = {};
    const client = {
      query: jest.fn(async (sqlValue: unknown, values: unknown[] = []) => {
        const sql = String(sqlValue);
        if (sql.includes('SELECT pr.workspace_id, pr.spec_path')) {
          return { rows: [{
            workspace_id: 'test-ws',
            spec_path: 'forge/specs/approved/fallback-spec.json',
            branch_name: 'run/default',
            manifest_hash: `sha256:${'1'.repeat(64)}`,
            spec_revision: `sha256:${'2'.repeat(64)}`,
            story_revision: `sha256:${'3'.repeat(64)}`,
            closeout_decision_id: `CLO-sha256:${'4'.repeat(64)}`,
          }] };
        }
        if (sql.includes('INSERT INTO story_results')) {
          persisted.result = {
            runId: values[0], storyId: values[1], status: values[2], finishedAt: values[3],
            worktreePath: values[4], worktreeBranch: values[5], inputTokens: values[6],
            outputTokens: values[7], modelUsed: values[8], costUsd: values[9], logPath: values[10],
            blockedBy: values[11], activeSkills: values[12], completionPacket: JSON.parse(String(values[13])),
            specId: values[14], specRevision: values[15], storyRevision: values[16],
            manifestHash: values[17], closeoutDecisionId: values[18], ingestKey: values[19],
          };
          return { rows: [{ id: 1 }] };
        }
        if (sql.includes('FROM model_pricing')) return { rows: [] };
        if (sql.includes('INSERT INTO story_commits')) {
          persisted.commit = {
            storyId: values[0], specId: values[1], workspaceId: values[2], runId: values[3],
            commitSha: values[4], commitMessage: values[5], author: values[6],
            branchName: values[7], observedSource: values[8],
          };
          return { rows: [{
            id: 1,
            story_id: values[0], spec_id: values[1], workspace_id: values[2], run_id: values[3],
            commit_sha: values[4], commit_message: values[5], author: values[6],
            branch_name: values[7], observed_source: values[8],
          }] };
        }
        if (sql.includes('INSERT INTO token_usage')) {
          persisted.usage = {
            runId: values[0], storyId: values[1], workspaceId: values[2], model: values[3],
            inputTokens: values[4], outputTokens: values[5], reasoningTokens: values[6], costUsd: values[7],
          };
          return { rows: [], rowCount: 1 };
        }
        return { rows: [] };
      }),
    };
    transaction.mockImplementation(async (fn: (dbClient: typeof client) => Promise<unknown>) => fn(client));

    const replayed = await replayFallbackResults(cwd, 'test-ws');

    expect(replayed).toMatchObject({ total: 1, inserted: 1, duplicates: 0, invalid: 0, retained: false });
    expect(persisted.result).toEqual({
      runId: 7,
      storyId: 'US-FALLBACK-001',
      status: 'pass',
      finishedAt: storyEntry.ts,
      worktreePath: '/tmp/fallback-story',
      worktreeBranch: 'run/fallback-integrated',
      inputTokens: 321,
      outputTokens: 54,
      modelUsed: 'pi/fallback-model',
      costUsd: 0.1234567,
      logPath: '/tmp/fallback-story.log',
      blockedBy: JSON.stringify(['US-000']),
      activeSkills: JSON.stringify(['release-review']),
      completionPacket: { status: 'completed', closeout: { accepted: true } },
      specId: 'fallback-spec',
      specRevision: `sha256:${'2'.repeat(64)}`,
      storyRevision: `sha256:${'3'.repeat(64)}`,
      manifestHash: `sha256:${'1'.repeat(64)}`,
      closeoutDecisionId: `CLO-sha256:${'4'.repeat(64)}`,
      ingestKey: storyEntry.idempotencyKey,
    });
    expect(persisted.commit).toEqual({
      storyId: 'US-FALLBACK-001',
      specId: 'fallback-spec',
      workspaceId: 'test-ws',
      runId: 7,
      commitSha: sha,
      commitMessage: 'integrated story(US-FALLBACK-001): fallback exact head',
      author: 'rorca-execution-engine',
      branchName: 'run/fallback-integrated',
      observedSource: 'worktree_branch',
    });
    expect(persisted.usage).toEqual({
      runId: 7,
      storyId: 'US-FALLBACK-001',
      workspaceId: 'test-ws',
      model: 'pi/fallback-model',
      inputTokens: 321,
      outputTokens: 54,
      reasoningTokens: 11,
      costUsd: 0.123457,
    });
    expect(fs.existsSync(path.join(cwd, '.rorca-results.jsonl'))).toBe(false);
  });
});
