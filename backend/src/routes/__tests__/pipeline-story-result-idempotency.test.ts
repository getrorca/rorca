
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

jest.mock('../../db/index', () => ({
  query: jest.fn(),
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
  execute: (...args: unknown[]) => mockExecute(...args),
  transaction: jest.fn(),
}));

import { deriveIntegratedPassStoryResultIdempotencyKey } from '../../lib/execution-engine';
import pipelineRouter from '../pipeline';

const app = express();
app.use(express.json());
app.use('/api/pipeline', pipelineRouter);

const storyResults = new Set<string>();
const storyCommits = new Set<string>();
let tokenUsageRows = 0;

describe('story-result integrated-pass retry boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    storyResults.clear();
    storyCommits.clear();
    tokenUsageRows = 0;

    mockQueryOne.mockImplementation(async (sqlValue: unknown, params: unknown[] = []) => {
      const sql = String(sqlValue);
      if (sql.includes('SELECT pr.workspace_id, pr.spec_path')) {
        return {
          workspace_id: 'ws-integrated-result',
          spec_path: 'forge/specs/approved/integrated-result.json',
          branch_name: 'run/integrated-result',
          manifest_hash: 'sha256:manifest',
          spec_revision: 'sha256:spec',
          story_revision: 'sha256:story',
          closeout_decision_id: 'decision-1',
        };
      }
      if (sql.includes('INSERT INTO story_results')) {
        const ingestKey = String(params[18]);
        if (storyResults.has(ingestKey)) return undefined;
        storyResults.add(ingestKey);
        return { id: storyResults.size };
      }
      if (sql.includes('SELECT workspace_id FROM pipeline_runs')) {
        return { workspace_id: 'ws-integrated-result' };
      }
      if (sql.includes('SELECT * FROM model_pricing')) return undefined;
      return undefined;
    });

    mockExecute.mockImplementation(async (sqlValue: unknown, params: unknown[] = []) => {
      const sql = String(sqlValue);
      if (sql.includes('INSERT INTO story_commits')) {
        storyCommits.add([params[2], params[3], params[0], params[4]].join(':'));
      }
      if (sql.includes('INSERT INTO token_usage')) tokenUsageRows += 1;
      return { rowCount: 1 };
    });
  });

  it('returns duplicate success without repeating result, commit, or accounting projections', async () => {
    const integratedSha = 'a'.repeat(40);
    const idempotencyKey = deriveIntegratedPassStoryResultIdempotencyKey({
      workspaceId: 'ws-integrated-result',
      runId: 41,
      storyId: 'US-INTEGRATED-001',
      integratedSha,
    });
    const body = {
      runId: 41,
      storyId: 'US-INTEGRATED-001',
      status: 'pass',
      commitSha: integratedSha,
      commitMessage: 'integrated story(US-INTEGRATED-001): exact head',
      worktreeBranch: 'run/integrated-result',
      inputTokens: 100,
      outputTokens: 25,
      modelUsed: 'pi/test-model',
      costUsd: 0.01,
      idempotencyKey,
    };

    const first = await request(app).post('/api/pipeline/story-result').send(body);
    const replay = await request(app).post('/api/pipeline/story-result').send({ ...body });

    expect(first.status).toBe(201);
    expect(first.body).toEqual({ ok: true, duplicate: false });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ok: true, duplicate: true });
    expect(storyResults).toEqual(new Set([idempotencyKey]));
    expect(storyCommits.size).toBe(1);
    expect(tokenUsageRows).toBe(1);
  });
});
