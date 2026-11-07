/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import express from 'express';
import request from 'supertest';

jest.mock('../../db/index', () => ({
  queryOne: jest.fn(),
  query: jest.fn(),
  execute: jest.fn(),
}));

const { queryOne, query } = require('../../db/index');
const analyticsRouter = require('../analytics').default;

describe('analytics finops run regressions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/analytics', analyticsRouter);
    app.use((err: any, _req: any, res: any, _next: any) => {
      res.status(err.statusCode || err.status || 500).json({ error: err.message || 'error' });
    });
    return app;
  }

  test('prefers concrete story models over unknown token usage rows without inventing sonnet usage', async () => {
    queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM pipeline_runs WHERE id = $1')) {
        return {
          id: 42,
          agent: 'claude',
          agent_type: 'claude',
          agent_model: 'claude-opus-4.8',
          workspace_id: 'ws-1',
          spec_path: 'forge/specs/approved/spec.json',
          status: 'done',
        };
      }
      return null;
    });

    query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM token_usage') && sql.includes('WHERE run_id = $1')) {
        return [
          { story_id: 'SMG-001', model: 'unknown', input_tokens: 6487, output_tokens: 24683, cost_usd: 0 },
          { story_id: 'SMG-002', model: 'unknown', input_tokens: 23, output_tokens: 24152, cost_usd: 0 },
        ];
      }
      if (sql.includes('FROM story_results')) {
        return [
          { story_id: 'SMG-001', model: 'claude-opus-4.8', input_tokens: 6487, output_tokens: 24683, cost_usd: 0 },
          { story_id: 'SMG-002', model: 'claude-opus-4.8', input_tokens: 23, output_tokens: 24152, cost_usd: 0 },
        ];
      }
      if (sql.includes("WHERE event_type = 'story_token_update'")) {
        return [];
      }
      if (sql.includes('FROM model_pricing')) {
        return [];
      }
      if (sql.includes("WHERE event_type = 'story_escalated'")) {
        return [];
      }
      return [];
    });

    const response = await request(makeApp()).get('/api/analytics/finops/run/42');

    expect(response.status).toBe(200);
    expect(response.body.agentModel).toBe('claude-opus-4.8');
    expect(response.body.runSummary).toEqual([
      expect.objectContaining({
        model: 'claude-opus-4.8',
        tier: 'opus',
        stories: 2,
        inputTokens: 6510,
        outputTokens: 48835,
      }),
    ]);
    expect(response.body.modelDistribution).toEqual([
      expect.objectContaining({ tier: 'opus', count: 2, percentage: 100 }),
    ]);
    expect(response.body.perStory).toEqual([
      expect.objectContaining({ storyId: 'SMG-001', model: 'claude-opus-4.8', tier: 'opus' }),
      expect.objectContaining({ storyId: 'SMG-002', model: 'claude-opus-4.8', tier: 'opus' }),
    ]);
  });

  test('deduplicates mirrored Pi token rows and preserves CLI-reported cost as unclassified', async () => {
    queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM pipeline_runs WHERE id = $1')) {
        return {
          id: 44,
          agent: 'pi',
          agent_type: 'pi',
          agent_model: 'openai-codex/gpt-5.5',
          workspace_id: 'ws-1',
          spec_path: 'forge/specs/approved/spec.json',
          status: 'done',
          started_at: '2026-07-02T00:00:00.000Z',
          finished_at: '2026-07-02T00:10:00.000Z',
        };
      }
      return null;
    });

    query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM token_usage') && sql.includes('WHERE run_id = $1')) {
        return [
          { story_id: 'US-001', model: 'openai-codex/gpt-5.5', input_tokens: 100, output_tokens: 20, cost_usd: 0.12 },
          { story_id: 'US-001', model: 'openai-codex/gpt-5.5', input_tokens: 100, output_tokens: 20, cost_usd: 0.12 },
          { story_id: 'US-002', model: 'openai-codex/gpt-5.5', input_tokens: 200, output_tokens: 30, cost_usd: 0.34 },
          { story_id: 'US-002', model: 'openai-codex/gpt-5.5', input_tokens: 200, output_tokens: 30, cost_usd: 0.34 },
        ];
      }
      if (sql.includes('FROM story_results')) {
        return [
          { story_id: 'US-001', model: 'openai-codex/gpt-5.5', input_tokens: 100, output_tokens: 20, cost_usd: 0.12 },
          { story_id: 'US-002', model: 'openai-codex/gpt-5.5', input_tokens: 200, output_tokens: 30, cost_usd: 0.34 },
        ];
      }
      if (sql.includes("WHERE event_type = 'story_token_update'")) return [];
      if (sql.includes('FROM model_pricing')) return [];
      if (sql.includes('FROM billing_profiles')) return [];
      if (sql.includes("WHERE event_type = 'story_escalated'")) return [];
      return [];
    });

    const response = await request(makeApp()).get('/api/analytics/finops/run/44');

    expect(response.status).toBe(200);
    expect(response.body.totals.stories).toBe(2);
    expect(response.body.totals.inputTokens).toBe(300);
    expect(response.body.totals.outputTokens).toBe(50);
    expect(response.body.totals.reportedCostUsd).toBe(0.46);
    expect(response.body.totals.meteredCostUsd).toBe(0);
    expect(response.body.billingMode).toBe('unknown');
    expect(response.body.savings).toBeNull();
    expect(response.body.provenance.unclassifiedRecords).toBe(2);
    expect(response.body.runSummary).toEqual([
      expect.objectContaining({
        model: 'openai-codex/gpt-5.5',
        tier: 'codex',
        stories: 2,
        inputTokens: 300,
        outputTokens: 50,
        reportedCost: 0.46,
      }),
    ]);
  });

  test('uses cumulative_input and cumulative_output WAL fields from the execution engine', async () => {
    queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM pipeline_runs WHERE id = $1')) {
        return {
          id: 43,
          agent: 'pi',
          agent_type: 'pi',
          agent_model: 'openai/gpt-4o',
          workspace_id: 'ws-1',
          spec_path: 'forge/specs/approved/spec.json',
          status: 'running',
        };
      }
      return null;
    });

    query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM token_usage') && sql.includes('WHERE run_id = $1')) {
        return [];
      }
      if (sql.includes('FROM story_results')) {
        return [];
      }
      if (sql.includes("WHERE event_type = 'story_token_update'")) {
        return [
          {
            story_id: 'US-001',
            payload: {
              run_id: 43,
              model: 'openai/gpt-4o',
              cumulative_input: 100,
              cumulative_output: 20,
              cumulative_cost_usd: 0.001,
              turn: 1,
            },
            ts: new Date().toISOString(),
          },
          {
            story_id: 'US-001',
            payload: {
              run_id: 43,
              model: 'openai/gpt-4o',
              cumulative_input: 125,
              cumulative_output: 35,
              cumulative_cost_usd: 0.0015,
              turn: 1,
            },
            ts: new Date().toISOString(),
          },
          {
            story_id: 'US-001',
            payload: {
              run_id: 43,
              model: 'openai/gpt-4o',
              cumulative_input: 125,
              cumulative_output: 35,
              cumulative_cost_usd: 0.0015,
              turn: 1,
            },
            ts: new Date().toISOString(),
          },
        ];
      }
      if (sql.includes('FROM model_pricing')) {
        return [];
      }
      if (sql.includes("WHERE event_type = 'story_escalated'")) {
        return [];
      }
      return [];
    });

    const response = await request(makeApp()).get('/api/analytics/finops/run/43');

    expect(response.status).toBe(200);
    expect(response.body.totals.stories).toBe(1);
    expect(response.body.totals.inputTokens).toBe(225);
    expect(response.body.totals.outputTokens).toBe(55);
    expect(response.body.perStory).toEqual([
      expect.objectContaining({
        storyId: 'US-001',
        model: 'openai/gpt-4o',
        inputTokens: 225,
        outputTokens: 55,
      }),
    ]);
  });

  test('reconciles false-zero completion rows with idempotent mixed-provider retry launches', async () => {
    queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM pipeline_runs WHERE id = $1')) {
        return {
          id: 44,
          agent: 'omp',
          agent_type: 'omp',
          agent_model: null,
          workspace_id: 'ws-1',
          spec_path: 'forge/specs/approved/spec.json',
          status: 'running',
        };
      }
      return null;
    });
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM token_usage') && sql.includes('WHERE run_id = $1')) return [];
      if (sql.includes('FROM story_results')) {
        return [{ story_id: 'US-002', model: null, input_tokens: 0, output_tokens: 0, cost_usd: 0 }];
      }
      if (sql.includes("WHERE event_type = 'story_token_update'")) {
        return [
          { story_id: 'US-002', payload: { run_id: 44, launch_id: 'primary', turn: 1, model: 'openai-codex/gpt-5.6-sol', launch_cumulative_input: 100, launch_cumulative_output: 20, launch_cumulative_cost_usd: 0.01 }, ts: '2026-08-18T00:00:00.000Z' },
          { story_id: 'US-002', payload: { run_id: 44, launch_id: 'primary', turn: 2, model: 'openai-codex/gpt-5.6-sol', launch_cumulative_input: 150, launch_cumulative_output: 25, launch_cumulative_cost_usd: 0.015 }, ts: '2026-08-18T00:00:01.000Z' },
          { story_id: 'US-002', payload: { run_id: 44, launch_id: 'primary', turn: 1, model: 'openai-codex/gpt-5.6-sol', launch_cumulative_input: 100, launch_cumulative_output: 20, launch_cumulative_cost_usd: 0.01 }, ts: '2026-08-18T00:00:02.000Z' },
          { story_id: 'US-002', payload: { run_id: 44, launch_id: 'fallback', turn: 1, model: 'anthropic/claude-sonnet-4-5', launch_cumulative_input: 40, launch_cumulative_output: 10, launch_cumulative_cost_usd: 0 }, ts: '2026-08-18T00:00:03.000Z' },
          { story_id: 'US-002', payload: { run_id: 44, launch_id: 'primary', turn: 2, model: 'openai-codex/gpt-5.6-sol', launch_cumulative_input: 150, launch_cumulative_output: 25, launch_cumulative_cost_usd: 0.015 }, ts: '2026-08-18T00:00:04.000Z' },
        ];
      }
      if (sql.includes('FROM model_pricing')) return [];
      if (sql.includes("WHERE event_type = 'story_escalated'")) return [];
      return [];
    });

    const response = await request(makeApp()).get('/api/analytics/finops/run/44');

    expect(response.status).toBe(200);
    expect(response.body.totals).toEqual(expect.objectContaining({ stories: 1, inputTokens: 190, outputTokens: 35 }));
    expect(response.body.perStory).toEqual([
      expect.objectContaining({
        storyId: 'US-002',
        model: 'anthropic/claude-sonnet-4-5',
        inputTokens: 190,
        outputTokens: 35,
      }),
    ]);
  });
});
