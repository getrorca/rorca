/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

process.env.NODE_ENV = 'test';

import { server, RORCA_API } from '../server';

function getToolHandler(toolName: string) {
  const tools = (server as any)._registeredTools as Record<string, { handler: Function }>;
  const tool = tools[toolName];
  if (!tool) throw new Error(`Tool ${toolName} not registered`);
  return tool.handler;
}

beforeEach(() => {
  mockFetch.mockReset();
});

test('rorca_pipeline_status is registered on the McpServer', () => {
  const tools = (server as any)._registeredTools;
  expect(tools['rorca_pipeline_status']).toBeDefined();
});

test('fetches most recent run when runId not provided (uses ?limit=1 param)', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => [{
      id: 42, status: 'running', specPath: 'specs/approved/auth.json',
      startedAt: new Date(Date.now() - 5 * 60000).toISOString(),
      stories: [
        { storyId: 'US-001', status: 'pass', retries: 0 },
        { storyId: 'US-002', status: 'pending', retries: 0 },
      ],
    }],
  });

  const handler = getToolHandler('rorca_pipeline_status');
  await handler({ workspaceId: 'ws-123' });

  expect(mockFetch).toHaveBeenCalledWith(
    `${RORCA_API}/api/pipeline-runs?workspaceId=ws-123&limit=1`
  );
});

test('fetches specific run by ID when runId provided', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      id: 7, status: 'done', specPath: 'specs/approved/dashboard.json',
      startedAt: '2026-02-21T10:00:00Z', finishedAt: '2026-02-21T10:15:00Z',
      stories: [
        { storyId: 'US-001', status: 'pass', retries: 0 },
      ],
    }),
  });

  const handler = getToolHandler('rorca_pipeline_status');
  await handler({ workspaceId: 'ws-123', runId: 7 });

  expect(mockFetch).toHaveBeenCalledWith(
    `${RORCA_API}/api/pipeline-runs/7`
  );
});

test('correctly counts pass/fail/skip from stories array', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      id: 10, status: 'done', specPath: 'specs/approved/payments.json',
      startedAt: '2026-02-21T10:00:00Z', finishedAt: '2026-02-21T10:30:00Z',
      stories: [
        { storyId: 'US-001', status: 'pass', retries: 0 },
        { storyId: 'US-002', status: 'pass', retries: 1 },
        { storyId: 'US-003', status: 'fail', retries: 2 },
        { storyId: 'US-004', status: 'skip', retries: 0 },
        { storyId: 'US-005', status: 'pass', retries: 0 },
      ],
    }),
  });

  const handler = getToolHandler('rorca_pipeline_status');
  const result = await handler({ workspaceId: 'ws-123', runId: 10 });

  expect(result).toEqual({
    content: [{
      type: 'text',
      text: 'Run #10: DONE (30m)\nSpec: specs/approved/payments.json\nStories: 3 pass / 1 fail / 1 skip / 5 total',
    }],
  });
});

test('shows elapsed time as "running" for active runs (no finishedAt)', async () => {
  const startedAt = new Date(Date.now() - 12 * 60000).toISOString();
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => [{
      id: 99, status: 'running', specPath: 'specs/approved/luca.json',
      startedAt,
      stories: [
        { storyId: 'US-001', status: 'pass', retries: 0 },
        { storyId: 'US-002', status: 'pending', retries: 0 },
      ],
    }],
  });

  const handler = getToolHandler('rorca_pipeline_status');
  const result = await handler({ workspaceId: 'ws-123' });

  const text = result.content[0].text;
  expect(text).toContain('Run #99: RUNNING');
  expect(text).toContain('(running)');
  expect(text).toContain('Spec: specs/approved/luca.json');
});

test('returns "No pipeline runs found" when API returns empty array', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => [],
  });

  const handler = getToolHandler('rorca_pipeline_status');
  const result = await handler({ workspaceId: 'ws-empty' });

  expect(result).toEqual({
    content: [{ type: 'text', text: 'No pipeline runs found for workspace ws-empty' }],
  });
});

test('throws when API returns non-200', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status: 500,
  });

  const handler = getToolHandler('rorca_pipeline_status');
  await expect(handler({ workspaceId: 'ws-123' })).rejects.toThrow(
    'Failed to get pipeline status: 500'
  );
});
