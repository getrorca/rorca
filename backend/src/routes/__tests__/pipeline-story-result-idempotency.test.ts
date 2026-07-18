/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import express from 'express';
import request from 'supertest';

const mockQueryOne = jest.fn();
const mockExecute = jest.fn();
const mockTransaction = jest.fn();

jest.mock('../../db/index', () => ({
  query: jest.fn(),
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
  execute: (...args: unknown[]) => mockExecute(...args),
  transaction: (...args: unknown[]) => mockTransaction(...args),
}));

import { deriveIntegratedPassStoryResultIdempotencyKey } from '../../lib/execution-engine';
import pipelineRouter from '../pipeline';

interface StoredResult {
  id: number;
  run_id: number;
  story_id: string;
  status: string;
  finished_at: string | null;
  worktree_path: string | null;
  worktree_branch: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  model_used: string | null;
  cost_usd: number | null;
  log_path: string | null;
  blocked_by: string | null;
  active_skills: string | null;
  completion_packet: unknown;
  spec_id: string;
  spec_revision: string | null;
  story_revision: string | null;
  manifest_hash: string | null;
  closeout_decision_id: string | null;
  ingest_key: string | null;
}

interface StoredCommit {
  id: number;
  story_id: string;
  spec_id: string;
  workspace_id: string;
  run_id: number;
  commit_sha: string;
  commit_message: string;
  author: string;
  branch_name: string | null;
  observed_source: string;
}

interface StoredUsage {
  id: number;
  run_id: number;
  story_id: string;
  workspace_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cost_usd: number;
}

const state: {
  results: StoredResult[];
  commits: StoredCommit[];
  usage: StoredUsage[];
} = { results: [], commits: [], usage: [] };
let failOnceAt: 'commit' | 'accounting' | null = null;

function restore<T>(target: T[], snapshot: T[]): void {
  target.splice(0, target.length, ...structuredClone(snapshot));
}

const client = {
  query: jest.fn(async (sqlValue: unknown, params: unknown[] = []) => {
    const sql = String(sqlValue);
    if (sql.includes('SELECT pr.workspace_id, pr.spec_path')) {
      return { rows: [{
        workspace_id: 'ws-integrated-result',
        spec_path: 'forge/specs/approved/integrated-result.json',
        branch_name: 'run/integrated-result',
        manifest_hash: `sha256:${'1'.repeat(64)}`,
        spec_revision: `sha256:${'2'.repeat(64)}`,
        story_revision: `sha256:${'3'.repeat(64)}`,
        closeout_decision_id: `CLO-sha256:${'4'.repeat(64)}`,
      }] };
    }
    if (sql.includes('INSERT INTO story_results')) {
      const ingestKey = params[19] as string | null;
      if (ingestKey && state.results.some(row => row.ingest_key === ingestKey)) return { rows: [] };
      const row: StoredResult = {
        id: state.results.length + 1,
        run_id: Number(params[0]),
        story_id: String(params[1]),
        status: String(params[2]),
        finished_at: params[3] as string | null,
        worktree_path: params[4] as string | null,
        worktree_branch: params[5] as string | null,
        input_tokens: params[6] as number | null,
        output_tokens: params[7] as number | null,
        model_used: params[8] as string | null,
        cost_usd: params[9] as number | null,
        log_path: params[10] as string | null,
        blocked_by: params[11] as string | null,
        active_skills: params[12] as string | null,
        completion_packet: params[13] ? JSON.parse(String(params[13])) : null,
        spec_id: String(params[14]),
        spec_revision: params[15] as string | null,
        story_revision: params[16] as string | null,
        manifest_hash: params[17] as string | null,
        closeout_decision_id: params[18] as string | null,
        ingest_key: ingestKey,
      };
      state.results.push(row);
      return { rows: [{ id: row.id }] };
    }
    if (sql.includes('FROM model_pricing')) {
      return { rows: params[0] === 'priced/model'
        ? [{ input_cost_per_1k: 0.002, output_cost_per_1k: 0.006 }]
        : [] };
    }
    if (sql.includes('INSERT INTO story_commits')) {
      if (failOnceAt === 'commit') {
        failOnceAt = null;
        throw new Error('injected failure after result insertion before commit projection');
      }
      const existing = state.commits.find(row => row.workspace_id === params[2]
        && row.spec_id === params[1] && row.run_id === params[3]
        && row.story_id === params[0] && row.commit_sha === params[4]);
      if (existing) return { rows: [] };
      const row: StoredCommit = {
        id: state.commits.length + 1,
        story_id: String(params[0]),
        spec_id: String(params[1]),
        workspace_id: String(params[2]),
        run_id: Number(params[3]),
        commit_sha: String(params[4]),
        commit_message: String(params[5]),
        author: String(params[6]),
        branch_name: params[7] as string | null,
        observed_source: String(params[8]),
      };
      state.commits.push(row);
      return { rows: [row] };
    }
    if (sql.includes('FROM story_commits')) {
      return { rows: state.commits.filter(row => row.workspace_id === params[0]
        && row.spec_id === params[1] && row.run_id === params[2]
        && row.story_id === params[3] && row.commit_sha === params[4]) };
    }
    if (sql.includes('INSERT INTO token_usage')) {
      if (failOnceAt === 'accounting') {
        failOnceAt = null;
        throw new Error('injected failure after commit projection before accounting');
      }
      state.usage.push({
        id: state.usage.length + 1,
        run_id: Number(params[0]),
        story_id: String(params[1]),
        workspace_id: String(params[2]),
        model: String(params[3]),
        input_tokens: Number(params[4]),
        output_tokens: Number(params[5]),
        reasoning_tokens: Number(params[6]),
        cost_usd: Number(params[7]),
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('FROM story_results') && sql.includes('ingest_key = $1')) {
      return { rows: state.results.filter(row => row.ingest_key === params[0]) };
    }
    if (sql.includes('FROM token_usage')) {
      return { rows: state.usage.filter(row => row.run_id === params[0] && row.story_id === params[1]) };
    }
    return { rows: [] };
  }),
};

const app = express();
app.use(express.json());
app.use('/api/pipeline', pipelineRouter);

function integratedBody() {
  const integratedSha = 'a'.repeat(40);
  return {
    runId: 41,
    storyId: 'US-INTEGRATED-001',
    status: 'pass',
    commitSha: integratedSha,
    commitMessage: 'integrated story(US-INTEGRATED-001): exact head',
    worktreePath: '/tmp/story-worktree',
    worktreeBranch: 'run/integrated-result',
    inputTokens: 100,
    outputTokens: 25,
    reasoningTokens: 7,
    modelUsed: 'pi/test-model',
    costUsd: 0.01234567,
    logPath: '/tmp/story.log',
    blockedBy: ['US-000'],
    activeSkills: ['release-review'],
    completionPacket: { status: 'completed', closeout: { accepted: true } },
    idempotencyKey: deriveIntegratedPassStoryResultIdempotencyKey({
      workspaceId: 'ws-integrated-result',
      runId: 41,
      storyId: 'US-INTEGRATED-001',
      integratedSha,
    }),
  };
}

function expectCompleteProjection(body: ReturnType<typeof integratedBody>): void {
  expect(state.results).toHaveLength(1);
  expect(state.results[0]).toMatchObject({
    run_id: body.runId,
    story_id: body.storyId,
    status: body.status,
    worktree_path: body.worktreePath,
    worktree_branch: body.worktreeBranch,
    input_tokens: body.inputTokens,
    output_tokens: body.outputTokens,
    model_used: body.modelUsed,
    cost_usd: body.costUsd,
    log_path: body.logPath,
    blocked_by: JSON.stringify(body.blockedBy),
    active_skills: JSON.stringify(body.activeSkills),
    completion_packet: body.completionPacket,
    spec_id: 'integrated-result',
    manifest_hash: `sha256:${'1'.repeat(64)}`,
    closeout_decision_id: `CLO-sha256:${'4'.repeat(64)}`,
    ingest_key: body.idempotencyKey,
  });
  expect(state.commits).toEqual([expect.objectContaining({
    story_id: body.storyId,
    spec_id: 'integrated-result',
    workspace_id: 'ws-integrated-result',
    run_id: body.runId,
    commit_sha: body.commitSha,
    commit_message: body.commitMessage,
    author: 'rorca-execution-engine',
    branch_name: body.worktreeBranch,
    observed_source: 'worktree_branch',
  })]);
  expect(state.usage).toEqual([expect.objectContaining({
    run_id: body.runId,
    story_id: body.storyId,
    workspace_id: 'ws-integrated-result',
    model: body.modelUsed,
    input_tokens: body.inputTokens,
    output_tokens: body.outputTokens,
    reasoning_tokens: body.reasoningTokens,
    cost_usd: 0.012346,
  })]);
}

describe('story-result integrated-pass atomic retry boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    state.results.length = 0;
    state.commits.length = 0;
    state.usage.length = 0;
    failOnceAt = null;
    mockTransaction.mockImplementation(async (fn: (dbClient: typeof client) => Promise<unknown>) => {
      const snapshot = structuredClone(state);
      try {
        return await fn(client);
      } catch (error) {
        restore(state.results, snapshot.results);
        restore(state.commits, snapshot.commits);
        restore(state.usage, snapshot.usage);
        throw error;
      }
    });
  });

  it('rolls back a failure after result insertion and retries to one complete projection', async () => {
    const body = integratedBody();
    failOnceAt = 'commit';

    const failed = await request(app).post('/api/pipeline/story-result').send(body);
    expect(failed.status).toBe(500);
    expect(state).toEqual({ results: [], commits: [], usage: [] });

    const retry = await request(app).post('/api/pipeline/story-result').send(body);
    const duplicate = await request(app).post('/api/pipeline/story-result').send(body);
    expect(retry.status).toBe(201);
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toEqual({ ok: true, duplicate: true });
    expectCompleteProjection(body);
  });

  it('rolls back a failure after commit and retries to one complete projection', async () => {
    const body = integratedBody();
    failOnceAt = 'accounting';

    const failed = await request(app).post('/api/pipeline/story-result').send(body);
    expect(failed.status).toBe(500);
    expect(state).toEqual({ results: [], commits: [], usage: [] });

    const retry = await request(app).post('/api/pipeline/story-result').send(body);
    const duplicate = await request(app).post('/api/pipeline/story-result').send(body);
    expect(retry.status).toBe(201);
    expect(duplicate.status).toBe(200);
    expectCompleteProjection(body);
  });

  it('rejects reuse of an ingest key with a changed immutable payload', async () => {
    const body = integratedBody();
    expect((await request(app).post('/api/pipeline/story-result').send(body)).status).toBe(201);

    const conflict = await request(app).post('/api/pipeline/story-result').send({
      ...body,
      commitMessage: 'changed payload under the same key',
    });
    expect(conflict.status).toBe(409);
    expectCompleteProjection(body);
  });

  it('does not acknowledge a pre-existing duplicate with incomplete dependent projections', async () => {
    const body = integratedBody();
    expect((await request(app).post('/api/pipeline/story-result').send(body)).status).toBe(201);
    state.commits.length = 0;
    state.usage.length = 0;

    const incomplete = await request(app).post('/api/pipeline/story-result').send(body);
    expect(incomplete.status).toBe(409);
    expect(incomplete.body.error).toContain('commit projection');
    expect(state.results).toHaveLength(1);
    expect(state.commits).toHaveLength(0);
    expect(state.usage).toHaveLength(0);
  });

  it('does not acknowledge a duplicate with a missing accounting projection', async () => {
    const body = integratedBody();
    expect((await request(app).post('/api/pipeline/story-result').send(body)).status).toBe(201);
    state.usage.length = 0;

    const incomplete = await request(app).post('/api/pipeline/story-result').send(body);
    expect(incomplete.status).toBe(409);
    expect(incomplete.body.error).toContain('accounting projection');
    expect(state.results).toHaveLength(1);
    expect(state.commits).toHaveLength(1);
    expect(state.usage).toHaveLength(0);
  });

  it.each(['fail', 'skip', 'excluded'] as const)('preserves the %s status without pass-only projections', async (status) => {
    const response = await request(app).post('/api/pipeline/story-result').send({
      runId: 41,
      storyId: `US-${status.toUpperCase()}-001`,
      status,
      idempotencyKey: `status-result-${status}`,
    });
    expect(response.status).toBe(201);
    expect(state.results).toEqual([expect.objectContaining({ status })]);
    expect(state.commits).toHaveLength(0);
    expect(state.usage).toHaveLength(0);
  });

  it('retains model pricing when explicit cost is absent', async () => {
    const body = {
      runId: 41,
      storyId: 'US-PRICED-001',
      status: 'fail',
      inputTokens: 1_000,
      outputTokens: 500,
      modelUsed: 'priced/model',
      idempotencyKey: 'priced-result-1',
    };
    expect((await request(app).post('/api/pipeline/story-result').send(body)).status).toBe(201);
    expect(state.results).toHaveLength(1);
    expect(state.commits).toHaveLength(0);
    expect(state.usage).toEqual([expect.objectContaining({
      model: 'priced/model',
      input_tokens: 1_000,
      output_tokens: 500,
      cost_usd: 0.005,
    })]);
  });
});
