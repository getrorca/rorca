/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

process.env.NODE_ENV = 'test';

import { server } from '../server';
const RORCA_API = process.env.RORCA_API_URL || 'http://localhost:3030';

function getToolHandler(toolName: string) {
  const tools = (server as any)._registeredTools as Record<string, { handler: Function }>;
  const tool = tools[toolName];
  if (!tool) throw new Error(`Tool ${toolName} not registered`);
  return tool.handler;
}

beforeEach(() => {
  mockFetch.mockReset();
});

// ─── rorca_trigger_run ──────────────────────────────────────────────────────

describe('rorca_trigger_run', () => {
  test('is registered on the McpServer', () => {
    const tools = (server as any)._registeredTools;
    expect(tools['rorca_trigger_run']).toBeDefined();
  });

  test('triggers a pipeline run with correct spec path', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, runId: 42 }),
    });

    const handler = getToolHandler('rorca_trigger_run');
    const result = await handler({ workspaceId: 'ws-1', specId: 'my-feature' });

    expect(mockFetch).toHaveBeenCalledWith(`${RORCA_API}/api/pipeline/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'ws-1',
        specPath: 'ralph/specs/approved/my-feature.json',
        dryRun: false,
        autoWorktree: false,
      }),
    });
    expect(result.content[0].text).toContain('Pipeline run #42 started');
  });

  test('returns conflict message when workspace has active run', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ conflict: true, activeRunId: 10 }),
    });

    const handler = getToolHandler('rorca_trigger_run');
    const result = await handler({ workspaceId: 'ws-1', specId: 'auth' });

    expect(result.content[0].text).toContain('Conflict');
    expect(result.content[0].text).toContain('run #10');
  });

  test('returns dry-run estimate when dryRun=true', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        dryRun: true,
        estimate: { stories: 5, estimatedTokens: 50000, estimatedCost: 0.15 },
      }),
    });

    const handler = getToolHandler('rorca_trigger_run');
    const result = await handler({ workspaceId: 'ws-1', specId: 'auth', dryRun: true });

    expect(result.content[0].text).toContain('Dry run estimate');
    expect(result.content[0].text).toContain('auth');
  });

  test('includes worktree info when autoWorktree=true', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        runId: 55,
        branchName: 'feat/auth-1708700000',
        worktreePath: '/tmp/worktrees/auth',
      }),
    });

    const handler = getToolHandler('rorca_trigger_run');
    const result = await handler({ workspaceId: 'ws-1', specId: 'auth', autoWorktree: true });

    expect(result.content[0].text).toContain('feat/auth-1708700000');
    expect(result.content[0].text).toContain('/tmp/worktrees/auth');
  });

  test('throws on API error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Workspace not found' }),
    });

    const handler = getToolHandler('rorca_trigger_run');
    await expect(handler({ workspaceId: 'bad', specId: 'x' })).rejects.toThrow('Pipeline trigger failed');
  });
});

// ─── rorca_run_status ───────────────────────────────────────────────────────

describe('rorca_run_status', () => {
  test('is registered on the McpServer', () => {
    const tools = (server as any)._registeredTools;
    expect(tools['rorca_run_status']).toBeDefined();
  });

  test('returns detailed run status with per-story progress', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        run: {
          id: 10, status: 'done', spec_path: 'ralph/specs/approved/auth.json',
          workspace_id: 'ws-1', pid: null, branch_name: null, worktree_path: null,
          started_at: '2026-02-21T10:00:00Z', finished_at: '2026-02-21T10:30:00Z',
        },
        stories: [
          { story_id: 'US-001', status: 'pass', retries: 0, started_at: '2026-02-21T10:01:00Z', finished_at: '2026-02-21T10:10:00Z', elapsed_seconds: 540, input_tokens: 1000, output_tokens: 500 },
          { story_id: 'US-002', status: 'fail', retries: 1, started_at: '2026-02-21T10:10:00Z', finished_at: '2026-02-21T10:20:00Z', elapsed_seconds: 600, input_tokens: 2000, output_tokens: 800 },
          { story_id: 'US-003', status: 'skip', retries: 0, started_at: null, finished_at: null, elapsed_seconds: null, input_tokens: null, output_tokens: null },
        ],
      }),
    });

    const handler = getToolHandler('rorca_run_status');
    const result = await handler({ runId: 10 });

    const text = result.content[0].text;
    expect(text).toContain('Run #10: DONE (30m)');
    expect(text).toContain('1 pass / 1 fail / 1 skip');
    expect(text).toContain('US-001: PASS');
    expect(text).toContain('US-002: FAIL retry#1');
    expect(text).toContain('[1000/500 tokens]');
    expect(text).toContain('US-003: SKIP');
  });

  test('shows branch name when present', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        run: {
          id: 20, status: 'running', spec_path: 'ralph/specs/approved/feat.json',
          workspace_id: 'ws-1', pid: 12345, branch_name: 'feat/my-branch',
          worktree_path: '/tmp/wt', started_at: new Date().toISOString(), finished_at: null,
        },
        stories: [],
      }),
    });

    const handler = getToolHandler('rorca_run_status');
    const result = await handler({ runId: 20 });

    expect(result.content[0].text).toContain('Branch: feat/my-branch');
  });

  test('throws on API error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => 'Run not found',
    });

    const handler = getToolHandler('rorca_run_status');
    await expect(handler({ runId: 999 })).rejects.toThrow('Failed to get run status');
  });
});

// ─── rorca_usage_stats ──────────────────────────────────────────────────────

describe('rorca_usage_stats', () => {
  test('is registered on the McpServer', () => {
    const tools = (server as any)._registeredTools;
    expect(tools['rorca_usage_stats']).toBeDefined();
  });

  test('returns formatted usage summary grouped by model', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        grouped: [
          { group_key: 'claude-sonnet-4-5-20250929', total_input_tokens: 100000, total_output_tokens: 50000, total_cost_usd: 1.5, count: 10 },
          { group_key: 'claude-haiku-4-5-20251001', total_input_tokens: 20000, total_output_tokens: 10000, total_cost_usd: 0.05, count: 5 },
        ],
        timeSeries: [],
        totals: { total_input_tokens: 120000, total_output_tokens: 60000, total_cost_usd: 1.55, total_records: 15 },
      }),
    });

    const handler = getToolHandler('rorca_usage_stats');
    const result = await handler({ workspaceId: 'ws-1' });

    const text = result.content[0].text;
    expect(text).toContain('Token Usage');
    expect(text).toContain('claude-sonnet-4-5-20250929');
    expect(text).toContain('$1.5');
    expect(text).toContain('Totals:');
  });

  test('passes date range and groupBy to API', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        grouped: [],
        timeSeries: [],
        totals: { total_input_tokens: 0, total_output_tokens: 0, total_cost_usd: 0, total_records: 0 },
      }),
    });

    const handler = getToolHandler('rorca_usage_stats');
    await handler({
      workspaceId: 'ws-1',
      from: '2026-01-01',
      to: '2026-02-01',
      groupBy: 'spec',
    });

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('workspace_id=ws-1');
    expect(url).toContain('group_by=spec');
    expect(url).toContain('from=2026-01-01');
    expect(url).toContain('to=2026-02-01');
  });

  test('handles empty usage data', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        grouped: [],
        timeSeries: [],
        totals: { total_input_tokens: 0, total_output_tokens: 0, total_cost_usd: 0, total_records: 0 },
      }),
    });

    const handler = getToolHandler('rorca_usage_stats');
    const result = await handler({ workspaceId: 'ws-1' });

    expect(result.content[0].text).toContain('No usage data found');
  });
});

// ─── rorca_retry_story ──────────────────────────────────────────────────────

describe('rorca_retry_story', () => {
  test('is registered on the McpServer', () => {
    const tools = (server as any)._registeredTools;
    expect(tools['rorca_retry_story']).toBeDefined();
  });

  test('retries specific story IDs', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        runId: 15,
        retriedStories: [
          { storyId: 'US-003', attempt: 2 },
        ],
      }),
    });

    const handler = getToolHandler('rorca_retry_story');
    const result = await handler({ runId: 15, storyIds: ['US-003'] });

    expect(mockFetch).toHaveBeenCalledWith(`${RORCA_API}/api/pipeline/runs/15/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storyIds: ['US-003'] }),
    });
    expect(result.content[0].text).toContain('US-003 (attempt #2)');
  });

  test('retries all failed stories when storyIds omitted', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        runId: 15,
        retriedStories: [
          { storyId: 'US-002', attempt: 1 },
          { storyId: 'US-005', attempt: 1 },
        ],
      }),
    });

    const handler = getToolHandler('rorca_retry_story');
    const result = await handler({ runId: 15 });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.storyIds).toBeUndefined();
    expect(result.content[0].text).toContain('US-002');
    expect(result.content[0].text).toContain('US-005');
  });

  test('throws on API error (e.g. run still running)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      text: async () => JSON.stringify({ error: "Cannot retry run with status 'running'" }),
    });

    const handler = getToolHandler('rorca_retry_story');
    await expect(handler({ runId: 5 })).rejects.toThrow('Retry failed');
  });
});

// ─── rorca_list_runs ────────────────────────────────────────────────────────

describe('rorca_list_runs', () => {
  test('is registered on the McpServer', () => {
    const tools = (server as any)._registeredTools;
    expect(tools['rorca_list_runs']).toBeDefined();
  });

  test('returns formatted list of recent runs', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        runs: [
          { id: 20, status: 'done', spec_path: 'ralph/specs/approved/auth.json', branch_name: null, trigger_type: 'manual', started_at: '2026-02-21T10:00:00Z', finished_at: '2026-02-21T10:15:00Z' },
          { id: 19, status: 'failed', spec_path: 'ralph/specs/approved/payments.json', branch_name: 'feat/pay-123', trigger_type: 'manual', started_at: '2026-02-20T09:00:00Z', finished_at: '2026-02-20T09:05:00Z' },
        ],
      }),
    });

    const handler = getToolHandler('rorca_list_runs');
    const result = await handler({ workspaceId: 'ws-1' });

    const text = result.content[0].text;
    expect(text).toContain('#20: DONE — auth');
    expect(text).toContain('#19: FAILED — payments');
    expect(text).toContain('[feat/pay-123]');
  });

  test('passes limit param and defaults to 10', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ runs: [] }),
    });

    const handler = getToolHandler('rorca_list_runs');
    await handler({ workspaceId: 'ws-1' });

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('limit=10');
  });

  test('returns empty message when no runs found', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ runs: [] }),
    });

    const handler = getToolHandler('rorca_list_runs');
    const result = await handler({ workspaceId: 'ws-empty' });

    expect(result.content[0].text).toContain('No pipeline runs found');
  });

  test('throws on API error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal error',
    });

    const handler = getToolHandler('rorca_list_runs');
    await expect(handler({ workspaceId: 'ws-1' })).rejects.toThrow('Failed to list runs');
  });
});
