/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { query, queryOne, execute } from '../../db/index';

describe('story token usage (V2-025)', () => {
  const workspaceId = 'test-tokens-ws';

  beforeAll(async () => {
    await execute(`INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`, [workspaceId, 'Test Tokens', '/tmp/test-tokens']);
  });

  afterAll(async () => {
    await execute(`DELETE FROM story_results WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = $1)`, [workspaceId]);
    await execute(`DELETE FROM pipeline_runs WHERE workspace_id = $1`, [workspaceId]);
    await execute(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
  });

  async function insertRun(status: string): Promise<number> {
    const result = await queryOne<{ id: number }>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status, finished_at) VALUES ($1, $2, $3, NOW()) RETURNING id`, ['ralph/specs/approved/test.json', workspaceId, status]);
    return result!.id;
  }

  it('stores and retrieves input_tokens and output_tokens', async () => {
    const runId = await insertRun('done');

    await execute(`INSERT INTO story_results (run_id, story_id, status, input_tokens, output_tokens) VALUES ($1, $2, $3, $4, $5)`, [runId, 'US-001', 'pass', 15000, 3000]);

    await execute(`INSERT INTO story_results (run_id, story_id, status, input_tokens, output_tokens) VALUES ($1, $2, $3, $4, $5)`, [runId, 'US-002', 'pass', 180000, 5000]);

    const stories = await query(`SELECT * FROM story_results WHERE run_id = $1 ORDER BY id ASC`, [runId]) as any[];

    expect(stories).toHaveLength(2);
    expect(stories[0].input_tokens).toBe(15000);
    expect(stories[0].output_tokens).toBe(3000);
    expect(stories[1].input_tokens).toBe(180000);
    expect(stories[1].output_tokens).toBe(5000);
  });

  it('allows null token values for stories without token data', async () => {
    const runId = await insertRun('done');

    await execute(`INSERT INTO story_results (run_id, story_id, status) VALUES ($1, $2, $3)`, [runId, 'US-003', 'pass']);

    const story = await queryOne(`SELECT * FROM story_results WHERE run_id = $1 AND story_id = $2`, [runId, 'US-003']) as any;

    expect(story.input_tokens).toBeNull();
    expect(story.output_tokens).toBeNull();
  });

  it('updates token values via COALESCE pattern', async () => {
    const runId = await insertRun('done');

    await execute(`INSERT INTO story_results (run_id, story_id, status) VALUES ($1, $2, $3)`, [runId, 'US-004', 'pass']);

    // Update with token data (simulating the POST endpoint logic)
    const row = await queryOne(`SELECT id FROM story_results WHERE run_id = $1 AND story_id = $2 ORDER BY id DESC LIMIT 1`, [runId, 'US-004']) as { id: number };

    await execute(`UPDATE story_results SET input_tokens = COALESCE($1, input_tokens), output_tokens = COALESCE($2, output_tokens) WHERE id = $3`, [50000, 8000, row.id]);

    const updated = await queryOne(`SELECT * FROM story_results WHERE id = $1`, [row.id]) as any;
    expect(updated.input_tokens).toBe(50000);
    expect(updated.output_tokens).toBe(8000);
  });

  it('computes aggregate token stats across a run', async () => {
    const runId = await insertRun('done');

    await execute(`INSERT INTO story_results (run_id, story_id, status, input_tokens, output_tokens) VALUES ($1, $2, $3, $4, $5)`, [runId, 'US-010', 'pass', 25000, 5000]);
    await execute(`INSERT INTO story_results (run_id, story_id, status, input_tokens, output_tokens) VALUES ($1, $2, $3, $4, $5)`, [runId, 'US-011', 'pass', 150000, 12000]);
    await execute(`INSERT INTO story_results (run_id, story_id, status, input_tokens, output_tokens) VALUES ($1, $2, $3, $4, $5)`, [runId, 'US-012', 'fail', 190000, 8000]);

    const agg = await queryOne(`SELECT SUM(input_tokens) as total_input, SUM(output_tokens) as total_output, COUNT(*) as count
       FROM story_results WHERE run_id = $1 AND input_tokens IS NOT NULL`, [runId]) as any;

    expect(agg.total_input).toBe(365000);
    expect(agg.total_output).toBe(25000);
    expect(agg.count).toBe(3);

    // Context window check: US-012 uses 198k/200k = 99% — should be flagged
    const contextWindow = 200000;
    const threshold = 0.8;
    const warningStories = await query(`SELECT story_id, input_tokens, output_tokens,
              (input_tokens + output_tokens) as total_tokens
       FROM story_results
       WHERE run_id = $1 AND input_tokens IS NOT NULL
         AND (input_tokens + output_tokens) >= $2`, [runId, contextWindow * threshold]) as any[];

    expect(warningStories).toHaveLength(2); // US-011 (162k) and US-012 (198k)
    expect(warningStories.map((s: any) => s.story_id).sort()).toEqual(['US-011', 'US-012']);
  });
});
