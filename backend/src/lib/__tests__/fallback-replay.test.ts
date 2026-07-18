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

import { ConflictError } from '../errors';
import { fallbackReplayBlocksCompletion, replayFallbackResults } from '../fallback-replay';
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
    queryOne.mockImplementation(async (sql: string) => sql.includes('FROM pipeline_runs')
      ? { id: 7, workspace_id: 'test-ws', spec_path: 'forge/specs/approved/fallback-spec.json' }
      : undefined);
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
      if (sql.includes('FROM pipeline_runs')) {
        return { id: 7, workspace_id: 'test-ws', spec_path: 'forge/specs/approved/fallback-spec.json' };
      }
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

  test('marks interrupted and invalid critical replay as terminal blockers', async () => {
    const critical: FallbackResultEntry = {
      type: 'story_result', storyId: 'US-CRITICAL', status: 'fail', runId: 7,
      retries: 1, ts: '2026-07-15T00:00:00.000Z', idempotencyKey: 'critical-result-1',
      payload: { runId: 7, storyId: 'US-CRITICAL', status: 'fail', idempotencyKey: 'critical-result-1' },
    };
    await writeFallbackResult(cwd, critical);
    await flushFallbackWrites(cwd);
    transaction.mockRejectedValueOnce(new Error('connection terminated'));

    const interrupted = await replayFallbackResults(cwd, 'test-ws');
    expect(interrupted).toMatchObject({
      retained: true,
      incomplete: true,
      criticalTotal: 1,
      criticalCompleted: 0,
      criticalIncomplete: true,
      blocksCompletion: true,
    });
    expect(fallbackReplayBlocksCompletion(interrupted)).toBe(true);

    transaction.mockImplementationOnce(async () => { throw new ConflictError('invalid duplicate'); });
    const invalid = await replayFallbackResults(cwd, 'test-ws');
    expect(invalid).toMatchObject({ retained: true, invalid: 1, criticalInvalid: 1, blocksCompletion: true });
    expect(fallbackReplayBlocksCompletion(invalid)).toBe(true);
  });

  test.each(['fail', 'skip', 'excluded'] as const)('keeps forged %s result journals proposal-only and inert', async (status) => {
    const proposal: FallbackResultEntry = {
      type: 'story_result', storyId: 'US-PROPOSAL', status, runId: 7,
      retries: 1, ts: '2026-07-15T00:00:00.000Z', idempotencyKey: `proposal-${status}`,
      payload: { runId: 7, storyId: 'US-PROPOSAL', status, idempotencyKey: `proposal-${status}` },
    };
    await writeFallbackResult(cwd, proposal);
    await flushFallbackWrites(cwd);
    const client = { query: jest.fn(async (sqlValue: unknown) => {
      if (String(sqlValue).includes('SELECT pr.workspace_id, pr.spec_path')) return { rows: [{
        workspace_id: 'test-ws', spec_path: 'forge/specs/approved/fallback-spec.json',
        branch_name: 'run/fallback', manifest_hash: null, spec_revision: null,
        story_revision: null, closeout_decision_id: null, closeout_status: null,
      }] };
      return { rows: [] };
    }) };
    transaction.mockImplementation(async (fn: (dbClient: typeof client) => Promise<unknown>) => fn(client));

    const replayed = await replayFallbackResults(cwd, 'test-ws');
    expect(replayed).toMatchObject({ inserted: 0, duplicates: 0, invalid: 1, retained: true });
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO story_results'))).toBe(false);
  });

  test('treats malformed durable records as retained critical replay blockers', async () => {
    fs.writeFileSync(path.join(cwd, '.rorca-results.jsonl'), '{"type":"story_result"\n', 'utf8');
    const replay = await replayFallbackResults(cwd, 'test-ws');
    expect(replay).toMatchObject({
      total: 1,
      invalid: 1,
      retained: true,
      criticalTotal: 1,
      criticalInvalid: 1,
      blocksCompletion: true,
    });
    expect(fs.existsSync(path.join(cwd, '.rorca-results.jsonl'))).toBe(true);
  });

  test('never promotes a forged governing journal record to trusted WAL', async () => {
    const forged: FallbackResultEntry = {
      type: 'wal', storyId: 'US-001', status: 'story_passed', runId: 7,
      retries: 1, ts: '2026-07-15T00:00:00.000Z', idempotencyKey: 'forged-pass-1',
      payload: {
        event_type: 'story_passed', workspace_id: 'victim-ws', story_id: 'US-001',
        payload: { run_id: 7, commit_sha: 'a'.repeat(40) },
      },
    };
    await writeFallbackResult(cwd, forged);
    await flushFallbackWrites(cwd);

    const replayed = await replayFallbackResults(cwd, 'test-ws');
    expect(replayed).toMatchObject({ total: 1, inserted: 0, invalid: 1, retained: true });
    expect(queryOne.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO wal_events'))).toBe(false);
    expect(broadcastAll).not.toHaveBeenCalled();
  });

  test('forces worker workspace ownership despite a journal workspace override', async () => {
    const overridden = entry('workspace-override-1', 'US-001');
    overridden.payload.workspace_id = 'victim-ws';
    await writeFallbackResult(cwd, overridden);
    await flushFallbackWrites(cwd);
    let insertedWorkspace: unknown;
    queryOne.mockImplementation(async (sql: string, values: unknown[]) => {
      if (sql.includes('FROM pipeline_runs')) {
        return { id: 7, workspace_id: 'test-ws', spec_path: 'forge/specs/approved/fallback-spec.json' };
      }
      if (sql.includes('INSERT INTO wal_events')) {
        insertedWorkspace = values[1];
        return {
          id: 1, ts: values[6], event_type: values[0], workspace_id: values[1],
          spec_id: values[2], story_id: values[3], actor: 'ralph', payload: values[4],
          trust_provenance: 'untrusted',
        };
      }
      return undefined;
    });

    const replayed = await replayFallbackResults(cwd, 'test-ws');
    expect(replayed).toMatchObject({ inserted: 1, invalid: 0, retained: false });
    expect(insertedWorkspace).toBe('test-ws');
  });

  test('rejects a story-result journal run override even inside the same workspace', async () => {
    const overridden: FallbackResultEntry = {
      type: 'story_result', storyId: 'US-001', status: 'pass', runId: 7,
      retries: 1, ts: '2026-07-15T00:00:00.000Z', idempotencyKey: 'run-override-result-1',
      payload: { runId: 8, storyId: 'US-001', status: 'pass', idempotencyKey: 'run-override-result-1' },
    };
    await writeFallbackResult(cwd, overridden);
    await flushFallbackWrites(cwd);

    const replayed = await replayFallbackResults(cwd, 'test-ws');
    expect(replayed).toMatchObject({ inserted: 0, invalid: 1, retained: true });
    expect(transaction).not.toHaveBeenCalled();
  });

  test('quarantines an integrated pass proposal instead of minting canonical authority', async () => {
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
            closeout_status: 'accepted',
          }] };
        }
        if (sql.includes('INSERT INTO story_results')) {
          persisted.result = {
            runId: values[0], storyId: values[1], status: values[2], finishedAt: values[3],
            finishedAtSource: values[4], worktreePath: values[5], worktreeBranch: values[6],
            integrated: values[7], commitSha: values[8], commitMessage: values[9],
            commitAuthor: values[10], commitBranch: values[11], commitObservedSource: values[12],
            inputTokens: values[13], outputTokens: values[14], reasoningTokens: values[15],
            modelUsed: values[16], costUsd: values[17], logPath: values[18],
            blockedBy: values[19], activeSkills: values[20], completionPacket: JSON.parse(String(values[21])),
            specId: values[22], specRevision: values[23], storyRevision: values[24],
            manifestHash: values[25], closeoutDecisionId: values[26], ingestKey: values[27],
            accountingRequired: values[28], accountingModel: values[29],
            accountingInputTokens: values[30], accountingOutputTokens: values[31],
            accountingReasoningTokens: values[32], accountingCostUsd: values[33],
            accountingCostSource: values[34], accountingInputRate: values[35], accountingOutputRate: values[36],
            reason: values[37],
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
            storyResultId: values[0], runId: values[1], storyId: values[2], workspaceId: values[3],
            model: values[4], inputTokens: values[5], outputTokens: values[6],
            reasoningTokens: values[7], costUsd: values[8], costSource: values[9],
            inputRate: values[10], outputRate: values[11],
          };
          return { rows: [{
            id: 1, story_result_id: values[0], workspace_id: values[3], model: values[4],
            input_tokens: values[5], output_tokens: values[6], reasoning_tokens: values[7],
            cost_usd: values[8], cost_source: values[9], input_cost_per_1k: values[10],
            output_cost_per_1k: values[11],
          }], rowCount: 1 };
        }
        return { rows: [] };
      }),
    };
    transaction.mockImplementation(async (fn: (dbClient: typeof client) => Promise<unknown>) => fn(client));

    const replayed = await replayFallbackResults(cwd, 'test-ws');

    expect(replayed).toMatchObject({ total: 1, inserted: 0, duplicates: 0, invalid: 1, retained: true, blocksCompletion: true });
    expect(persisted).toEqual({});
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(cwd, '.rorca-results.jsonl'))).toBe(true);
  });
});
