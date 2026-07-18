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
import { persistCanonicalStoryResult } from '../../lib/story-result-persistence';
import pipelineRouter from '../pipeline';

interface StoredResult {
  id: number;
  run_id: number;
  story_id: string;
  status: string;
  finished_at: string | null;
  finished_at_source: string;
  worktree_path: string | null;
  worktree_branch: string | null;
  integrated: boolean;
  commit_sha: string | null;
  commit_message: string | null;
  commit_author: string | null;
  commit_branch: string | null;
  commit_observed_source: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  model_used: string | null;
  cost_usd: number | null;
  log_path: string | null;
  reason: string | null;
  blocked_by: string | null;
  active_skills: string | null;
  completion_packet: unknown;
  spec_id: string;
  spec_revision: string | null;
  story_revision: string | null;
  manifest_hash: string | null;
  closeout_decision_id: string | null;
  ingest_key: string | null;
  accounting_required: boolean;
  accounting_model: string | null;
  accounting_input_tokens: number | null;
  accounting_output_tokens: number | null;
  accounting_reasoning_tokens: number | null;
  accounting_cost_usd: number | null;
  accounting_cost_source: string | null;
  accounting_input_rate: number | null;
  accounting_output_rate: number | null;
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
  story_result_id: number;
  run_id: number;
  story_id: string;
  workspace_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cost_usd: number;
  cost_source: string;
  input_cost_per_1k: number | null;
  output_cost_per_1k: number | null;
}

const state: {
  results: StoredResult[];
  commits: StoredCommit[];
  usage: StoredUsage[];
} = { results: [], commits: [], usage: [] };
let failOnceAt: 'commit' | 'accounting' | null = null;
let projectionSpecRevision = `sha256:${'2'.repeat(64)}`;
let transactionTail: Promise<void> = Promise.resolve();

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
        spec_revision: projectionSpecRevision,
        story_revision: `sha256:${'3'.repeat(64)}`,
        closeout_decision_id: `CLO-sha256:${'4'.repeat(64)}`,
        closeout_status: 'accepted',
      }] };
    }
    if (sql.includes('INSERT INTO story_results')) {
      const ingestKey = params[27] as string | null;
      if (ingestKey && state.results.some(row => row.ingest_key === ingestKey)) return { rows: [] };
      const row: StoredResult = {
        id: state.results.length + 1,
        run_id: Number(params[0]),
        story_id: String(params[1]),
        status: String(params[2]),
        finished_at: (params[3] as string | null) ?? '2026-07-18T12:00:00.000Z',
        finished_at_source: String(params[4]),
        worktree_path: params[5] as string | null,
        worktree_branch: params[6] as string | null,
        integrated: Boolean(params[7]),
        commit_sha: params[8] as string | null,
        commit_message: params[9] as string | null,
        commit_author: params[10] as string | null,
        commit_branch: params[11] as string | null,
        commit_observed_source: params[12] as string | null,
        input_tokens: params[13] as number | null,
        output_tokens: params[14] as number | null,
        reasoning_tokens: params[15] as number | null,
        model_used: params[16] as string | null,
        cost_usd: params[17] as number | null,
        log_path: params[18] as string | null,
        blocked_by: params[19] as string | null,
        active_skills: params[20] as string | null,
        completion_packet: params[21] ? JSON.parse(String(params[21])) : null,
        spec_id: String(params[22]),
        spec_revision: params[23] as string | null,
        story_revision: params[24] as string | null,
        manifest_hash: params[25] as string | null,
        closeout_decision_id: params[26] as string | null,
        ingest_key: ingestKey,
        accounting_required: Boolean(params[28]),
        accounting_model: params[29] as string | null,
        accounting_input_tokens: params[30] as number | null,
        accounting_output_tokens: params[31] as number | null,
        accounting_reasoning_tokens: params[32] as number | null,
        accounting_cost_usd: params[33] as number | null,
        accounting_cost_source: params[34] as string | null,
        accounting_input_rate: params[35] as number | null,
        accounting_output_rate: params[36] as number | null,
        reason: params[37] as string | null,
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
      const row: StoredUsage = {
        id: state.usage.length + 1,
        story_result_id: Number(params[0]),
        run_id: Number(params[1]),
        story_id: String(params[2]),
        workspace_id: String(params[3]),
        model: String(params[4]),
        input_tokens: Number(params[5]),
        output_tokens: Number(params[6]),
        reasoning_tokens: Number(params[7]),
        cost_usd: Number(params[8]),
        cost_source: String(params[9]),
        input_cost_per_1k: params[10] as number | null,
        output_cost_per_1k: params[11] as number | null,
      };
      state.usage.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes('FROM story_results') && sql.includes('ingest_key = $1')) {
      return { rows: state.results.filter(row => row.ingest_key === params[0]) };
    }
    if (sql.includes('FROM story_results') && sql.includes('WHERE run_id = $1 AND story_id = $2')) {
      return { rows: state.results.filter(row => row.run_id === Number(params[0]) && row.story_id === params[1]).reverse() };
    }
    if (sql.includes('SELECT workspace_id FROM pipeline_runs')) {
      return { rows: [{ workspace_id: 'ws-integrated-result' }] };
    }
    if (sql.includes('UPDATE story_results') && sql.includes('accounting_required = TRUE')) {
      const row = state.results.find(candidate => candidate.id === Number(params[13]));
      if (row) {
        row.input_tokens = params[0] as number | null;
        row.output_tokens = params[1] as number | null;
        row.reasoning_tokens = params[2] as number | null;
        row.model_used = params[3] as string | null;
        row.cost_usd = params[4] as number | null;
        row.accounting_required = true;
        row.accounting_model = params[5] as string;
        row.accounting_input_tokens = params[6] as number;
        row.accounting_output_tokens = params[7] as number;
        row.accounting_reasoning_tokens = params[8] as number;
        row.accounting_cost_usd = params[9] as number;
        row.accounting_cost_source = params[10] as string;
        row.accounting_input_rate = params[11] as number | null;
        row.accounting_output_rate = params[12] as number | null;
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('FROM token_usage')) {
      return { rows: state.usage.filter(row => row.story_result_id === Number(params[0])) };
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
    integrated: true,
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
    integrated: true,
    commit_sha: body.commitSha,
    commit_message: body.commitMessage,
    commit_author: 'rorca-execution-engine',
    commit_branch: body.worktreeBranch,
    commit_observed_source: 'worktree_branch',
    input_tokens: body.inputTokens,
    output_tokens: body.outputTokens,
    reasoning_tokens: body.reasoningTokens,
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
    accounting_required: true,
    accounting_model: body.modelUsed,
    accounting_input_tokens: body.inputTokens,
    accounting_output_tokens: body.outputTokens,
    accounting_reasoning_tokens: body.reasoningTokens,
    accounting_cost_usd: 0.012346,
    accounting_cost_source: 'explicit',
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
    story_result_id: state.results[0].id,
    run_id: body.runId,
    story_id: body.storyId,
    workspace_id: 'ws-integrated-result',
    model: body.modelUsed,
    input_tokens: body.inputTokens,
    output_tokens: body.outputTokens,
    reasoning_tokens: body.reasoningTokens,
    cost_usd: 0.012346,
    cost_source: 'explicit',
  })]);
}

describe('story-result integrated-pass atomic retry boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    state.results.length = 0;
    state.commits.length = 0;
    state.usage.length = 0;
    failOnceAt = null;
    projectionSpecRevision = `sha256:${'2'.repeat(64)}`;
    transactionTail = Promise.resolve();
    mockTransaction.mockImplementation(async (fn: (dbClient: typeof client) => Promise<unknown>) => {
      const prior = transactionTail;
      let release!: () => void;
      transactionTail = new Promise<void>(resolve => { release = resolve; });
      await prior;
      const snapshot = structuredClone(state);
      try {
        return await fn(client);
      } catch (error) {
        restore(state.results, snapshot.results);
        restore(state.commits, snapshot.commits);
        restore(state.usage, snapshot.usage);
        throw error;
      } finally {
        release();
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

  it('serializes concurrent identical ingestion to one result and one accounting identity', async () => {
    const body = integratedBody();
    const [left, right] = await Promise.all([
      request(app).post('/api/pipeline/story-result').send(body),
      request(app).post('/api/pipeline/story-result').send(body),
    ]);
    expect([left.status, right.status].sort()).toEqual([200, 201]);
    expectCompleteProjection(body);
    expect(new Set(state.usage.map(row => row.story_result_id))).toEqual(new Set([state.results[0].id]));
  });

  it('rejects a changed retry that omits the integrated commit identity', async () => {
    const body = integratedBody();
    expect((await request(app).post('/api/pipeline/story-result').send(body)).status).toBe(201);
    const { integrated: _integrated, commitSha: _sha, commitMessage: _message, ...omitted } = body;
    const response = await request(app).post('/api/pipeline/story-result').send(omitted);
    expect(response.status).toBe(409);
    expectCompleteProjection(body);
  });

  it('rejects reuse of a result key with changed failure provenance', async () => {
    const body = {
      runId: 41,
      storyId: 'US-FAILURE-REASON-001',
      status: 'fail',
      reason: 'validation_failed',
      idempotencyKey: 'failure-reason-result-1',
    };
    expect((await request(app).post('/api/pipeline/story-result').send(body)).status).toBe(201);
    expect((await request(app).post('/api/pipeline/story-result').send({
      ...body,
      reason: 'timeout',
    })).status).toBe(409);
  });

  it('rejects asymmetric accounting retries in both directions', async () => {
    const body = integratedBody();
    expect((await request(app).post('/api/pipeline/story-result').send(body)).status).toBe(201);
    const { reasoningTokens: _reasoning, ...missingReasoning } = body;
    expect((await request(app).post('/api/pipeline/story-result').send(missingReasoning)).status).toBe(409);

    const noAccounting = {
      runId: 41,
      storyId: 'US-NO-ACCOUNTING-001',
      status: 'fail',
      idempotencyKey: 'no-accounting-result-1',
    };
    expect((await request(app).post('/api/pipeline/story-result').send(noAccounting)).status).toBe(201);
    expect((await request(app).post('/api/pipeline/story-result').send({ ...noAccounting, costUsd: 0.5 })).status).toBe(409);
  });

  it('rejects duplicate acknowledgement after immutable revision provenance changes', async () => {
    const body = integratedBody();
    expect((await request(app).post('/api/pipeline/story-result').send(body)).status).toBe(201);
    projectionSpecRevision = `sha256:${'9'.repeat(64)}`;
    expect((await request(app).post('/api/pipeline/story-result').send(body)).status).toBe(409);
  });

  it('treats an observed fallback finished-at timestamp as immutable', async () => {
    const input = {
      runId: 41,
      storyId: 'US-FINISHED-AT-001',
      status: 'fail' as const,
      idempotencyKey: 'finished-at-result-1',
      finishedAt: '2026-07-18T12:34:56.000Z',
    };
    await expect(persistCanonicalStoryResult(input)).resolves.toMatchObject({ duplicate: false });
    await expect(persistCanonicalStoryResult({
      ...input,
      finishedAt: '2026-07-18T12:34:57.000Z',
    })).rejects.toThrow('different immutable payload');
  });

  it.each([
    { storyId: 'US-REASONING-ONLY', reasoningTokens: 17, costUsd: undefined },
    { storyId: 'US-COST-ONLY', reasoningTokens: undefined, costUsd: 0.75 },
  ])('creates keyed accounting for $storyId', async ({ storyId, reasoningTokens, costUsd }) => {
    const response = await request(app).post('/api/pipeline/story-result').send({
      runId: 41,
      storyId,
      status: 'fail',
      reasoningTokens,
      costUsd,
      modelUsed: 'pi/accounting-only',
      idempotencyKey: `accounting-only:${storyId}`,
    });
    expect(response.status).toBe(201);
    expect(state.results).toHaveLength(1);
    expect(state.usage).toEqual([expect.objectContaining({
      story_result_id: state.results[0].id,
      reasoning_tokens: reasoningTokens ?? 0,
      cost_usd: costUsd ?? 0,
    })]);
  });

  it.each(['pass', 'fail', 'skip', 'excluded'] as const)('preserves the non-integrated %s status without integrated projections', async (status) => {
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

  it('routes the token endpoint through one locked legacy story_result_id and deduplicates retries', async () => {
    const seed = {
      runId: 41,
      storyId: 'US-LEGACY-TOKENS-001',
      status: 'fail',
      idempotencyKey: 'legacy-token-seed',
    };
    expect((await request(app).post('/api/pipeline/story-result').send(seed)).status).toBe(201);
    state.results[0].ingest_key = null; // model an upgrade-safe legacy unkeyed row

    const first = await request(app)
      .post('/api/pipeline/runs/41/stories/US-LEGACY-TOKENS-001/tokens')
      .send({ reasoningTokens: 23, model: 'pi/legacy' });
    const duplicate = await request(app)
      .post('/api/pipeline/runs/41/stories/US-LEGACY-TOKENS-001/tokens')
      .send({ reasoningTokens: 23, model: 'pi/legacy' });
    expect(first.status).toBe(200);
    expect(first.body.duplicate).toBe(false);
    expect(duplicate.body.duplicate).toBe(true);
    expect(state.usage).toEqual([expect.objectContaining({
      story_result_id: state.results[0].id,
      reasoning_tokens: 23,
    })]);
  });

  it('prevents the token endpoint from satisfying or mutating canonical completeness', async () => {
    const seed = {
      runId: 41,
      storyId: 'US-CANONICAL-TOKENS-001',
      status: 'fail',
      idempotencyKey: 'canonical-token-seed',
    };
    expect((await request(app).post('/api/pipeline/story-result').send(seed)).status).toBe(201);
    const response = await request(app)
      .post('/api/pipeline/runs/41/stories/US-CANONICAL-TOKENS-001/tokens')
      .send({ costUsd: 0.5 });
    expect(response.status).toBe(409);
    expect(state.usage).toHaveLength(0);
    expect(state.results[0].accounting_required).toBe(false);
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
