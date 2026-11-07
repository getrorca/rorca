/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { installMcpFetchFixture } from './fetch-fixture';

const mockFetch = jest.fn();
installMcpFetchFixture(mockFetch);

process.env.NODE_ENV = 'test';

import { server } from '../server';
const RORCA_API = process.env.RORCA_API_URL || 'http://localhost:3030';

function getToolHandler(toolName: string) {
  const tools = (server as any)._registeredTools as Record<string, { handler: Function }>;
  const tool = tools[toolName];
  if (!tool) throw new Error(`Tool ${toolName} not registered`);
  return tool.handler;
}

function expectJsonResult(result: { content: Array<{ text: string }> }, expected: unknown): void {
  expect(JSON.parse(result.content[0].text)).toEqual(expected);
}

beforeEach(() => {
  mockFetch.mockReset();
});

const TRIGGER_PREVIEW_HASH = `sha256:${'a'.repeat(64)}`;
const TRIGGER_EXPIRES_AT = '2026-08-06T20:00:00.000Z';

function triggerArgs(specSlug: string, overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: 'ws-1',
    specPath: `forge/specs/approved/${specSlug}.json`,
    previewHash: TRIGGER_PREVIEW_HASH,
    previewExpiresAt: TRIGGER_EXPIRES_AT,
    idempotencyKey: `mcp-trigger:ws-1:${specSlug}`,
    ...overrides,
  };
}

// ─── rorca_trigger_run ──────────────────────────────────────────────────────

describe('rorca_trigger_run', () => {
  test('is registered on the McpServer', () => {
    const tools = (server as any)._registeredTools;
    expect(tools['rorca_trigger_run']).toBeDefined();
  });

  test('forwards only caller-provided trigger fields and returns exact JSON', async () => {
    const response = { ok: true, runId: 42 };
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => response });

    const handler = getToolHandler('rorca_trigger_run');
    const result = await handler(triggerArgs('my-feature'));

    expect(mockFetch).toHaveBeenCalledWith(
      `${RORCA_API}/api/pipeline/trigger`,
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'mcp-trigger:ws-1:my-feature',
        },
        body: expect.any(String),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(JSON.parse(String(mockFetch.mock.calls[0][1].body))).toEqual(triggerArgs('my-feature'));
    expectJsonResult(result, response);
  });

  test('preserves conflict responses without presentation rewriting', async () => {
    const response = { conflict: true, activeRunId: 10 };
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => response });

    const handler = getToolHandler('rorca_trigger_run');
    const result = await handler(triggerArgs('auth'));

    expectJsonResult(result, response);
  });

  test('forwards an explicit dryRun and preserves the estimate', async () => {
    const response = {
      dryRun: true,
      estimate: { stories: 5, estimatedTokens: 50000, estimatedCost: 0.15 },
    };
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => response });

    const handler = getToolHandler('rorca_trigger_run');
    const result = await handler(triggerArgs('auth', { dryRun: true }));

    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual(triggerArgs('auth', {
      dryRun: true,
    }));
    expectJsonResult(result, response);
  });

  test('preserves worktree response identity', async () => {
    const response = {
      ok: true,
      runId: 55,
      branchName: 'feat/auth-1708700000',
      worktreePath: '/tmp/worktrees/auth',
    };
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => response });

    const handler = getToolHandler('rorca_trigger_run');
    const result = await handler(triggerArgs('auth', { autoWorktree: true }));

    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual(triggerArgs('auth', {
      autoWorktree: true,
    }));
    expectJsonResult(result, response);
  });

  test('returns an MCP error result on API error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Workspace not found' }),
    });

    const handler = getToolHandler('rorca_trigger_run');
    const result = await handler(triggerArgs('x', { workspaceId: 'bad' }));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Error (404): {\n  "error": "Workspace not found"\n}');
  });
});

// ─── rorca_run_status ───────────────────────────────────────────────────────

describe('rorca_run_status', () => {
  test('is registered on the McpServer', () => {
    const tools = (server as any)._registeredTools;
    expect(tools['rorca_run_status']).toBeDefined();
  });

  test('returns every run and story field as exact structured JSON', async () => {
    const response = {
      run: {
        id: 10, status: 'done', spec_path: 'ralph/specs/approved/auth.json',
        workspace_id: 'ws-1', pid: null, branch_name: null, worktree_path: null,
        started_at: '2026-02-21T10:00:00Z', finished_at: '2026-02-21T10:30:00Z',
      },
      stories: [
        { story_id: 'US-001', status: 'pass', retries: 0, input_tokens: 1000, output_tokens: 500 },
        { story_id: 'US-002', status: 'fail', retries: 1, input_tokens: 2000, output_tokens: 800 },
        { story_id: 'US-003', status: 'skip', retries: 0, input_tokens: null, output_tokens: null },
      ],
    };
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => response });

    const handler = getToolHandler('rorca_run_status');
    const result = await handler({ runId: 10 });

    expect(mockFetch).toHaveBeenCalledWith(
      `${RORCA_API}/api/pipeline/runs/10`,
      expect.objectContaining({ method: 'GET', signal: expect.any(AbortSignal) }),
    );
    expectJsonResult(result, response);
  });

  test('preserves branch and worktree identity', async () => {
    const response = {
      run: {
        id: 20,
        status: 'running',
        branch_name: 'feat/my-branch',
        worktree_path: '/tmp/wt',
      },
      stories: [],
    };
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => response });

    const handler = getToolHandler('rorca_run_status');
    const result = await handler({ runId: 20 });

    expectJsonResult(result, response);
  });

  test('returns an MCP error result on API error', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'Run not found' });

    const handler = getToolHandler('rorca_run_status');
    const result = await handler({ runId: 999 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Error (404): Run not found');
  });
});

// ─── retired tools ──────────────────────────────────────────────────────────

describe('retired MCP tools', () => {
  test('does not expose the unavailable rorca_usage_stats tool', () => {
    const tools = (server as any)._registeredTools;
    expect(tools).not.toHaveProperty('rorca_usage_stats');
  });
});

// ─── rorca_retry_story ──────────────────────────────────────────────────────

describe('rorca_retry_story', () => {
  test('is registered on the McpServer', () => {
    const tools = (server as any)._registeredTools;
    expect(tools['rorca_retry_story']).toBeDefined();
  });

  test('forwards specific story IDs and preserves retry response identity', async () => {
    const response = { ok: true, runId: 15, retriedStories: [{ storyId: 'US-003', attempt: 2 }] };
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => response });

    const handler = getToolHandler('rorca_retry_story');
    const result = await handler({ runId: 15, storyIds: ['US-003'] });

    expect(mockFetch).toHaveBeenCalledWith(
      `${RORCA_API}/api/pipeline/runs/15/retry`,
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storyIds: ['US-003'] }),
        signal: expect.any(AbortSignal),
      }),
    );
    expectJsonResult(result, response);
  });

  test('does not synthesize a body when optional retry fields are omitted', async () => {
    const response = {
      ok: true,
      runId: 15,
      retriedStories: [
        { storyId: 'US-002', attempt: 1 },
        { storyId: 'US-005', attempt: 1 },
      ],
    };
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => response });

    const handler = getToolHandler('rorca_retry_story');
    const result = await handler({ runId: 15 });

    expect(mockFetch.mock.calls[0][1]).not.toHaveProperty('body');
    expectJsonResult(result, response);
  });

  test('returns an MCP error result when retry is rejected', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      text: async () => JSON.stringify({ error: "Cannot retry run with status 'running'" }),
    });

    const handler = getToolHandler('rorca_retry_story');
    const result = await handler({ runId: 5 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Error (409)');
    expect(result.content[0].text).toContain("Cannot retry run with status 'running'");
  });
});

// ─── rorca_list_runs ────────────────────────────────────────────────────────

describe('rorca_list_runs', () => {
  test('is registered on the McpServer', () => {
    const tools = (server as any)._registeredTools;
    expect(tools['rorca_list_runs']).toBeDefined();
  });

  test('returns the exact recent-run list without presentation rewriting', async () => {
    const response = {
      runs: [
        { id: 20, status: 'done', spec_path: 'ralph/specs/approved/auth.json', branch_name: null },
        { id: 19, status: 'failed', spec_path: 'ralph/specs/approved/payments.json', branch_name: 'feat/pay-123' },
      ],
    };
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => response });

    const handler = getToolHandler('rorca_list_runs');
    const result = await handler({ workspaceId: 'ws-1' });

    expect(mockFetch).toHaveBeenCalledWith(
      `${RORCA_API}/api/pipeline/runs?workspaceId=ws-1`,
      expect.objectContaining({ method: 'GET', signal: expect.any(AbortSignal) }),
    );
    expectJsonResult(result, response);
  });

  test('forwards a caller-provided limit and does not invent defaults', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ runs: [] }) });

    const handler = getToolHandler('rorca_list_runs');
    await handler({ workspaceId: 'ws-1', limit: 7 });

    expect(mockFetch.mock.calls[0][0]).toBe(`${RORCA_API}/api/pipeline/runs?workspaceId=ws-1&limit=7`);
  });

  test('preserves an empty run response', async () => {
    const response = { runs: [] };
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => response });

    const handler = getToolHandler('rorca_list_runs');
    const result = await handler({ workspaceId: 'ws-empty' });

    expectJsonResult(result, response);
  });

  test('returns an MCP error result on API error', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'Internal error' });

    const handler = getToolHandler('rorca_list_runs');
    const result = await handler({ workspaceId: 'ws-1' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Error (500): Internal error');
  });
});
