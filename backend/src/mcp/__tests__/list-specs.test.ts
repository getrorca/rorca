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
  // Health check polling may fire — suppress it by default
  mockFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
});

test('rorca_list_specs is registered on the McpServer', () => {
  const tools = (server as any)._registeredTools;
  expect(tools['rorca_list_specs']).toBeDefined();
});

test('returns "No specs found" message when API returns empty array', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => [],
  });

  const handler = getToolHandler('rorca_list_specs');
  const result = await handler({ workspaceId: 'ws-123', status: 'all' });

  expect(result.content[0].type).toBe('text');
  const parsed = JSON.parse(result.content[0].text);
  expect(parsed.ok).toBe(true);
  expect(parsed.specs).toEqual([]);
  expect(parsed.message).toContain('No specs found');
  expect(parsed.message).toContain('ws-123');
});

test('formats spec list with status, title, story count, and id', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => [
      { id: 'spec-1', specName: 'Auth System', status: 'pending', storyCount: 5, createdAt: '2026-01-01' },
      { id: 'spec-2', specName: 'Dashboard', status: 'approved', storyCount: 8, createdAt: '2026-01-02' },
    ],
  });

  const handler = getToolHandler('rorca_list_specs');
  const result = await handler({ workspaceId: 'ws-123', status: 'all' });

  expect(result.content[0].type).toBe('text');
  const parsed = JSON.parse(result.content[0].text);
  expect(parsed.ok).toBe(true);
  expect(parsed.specs).toHaveLength(2);
  expect(parsed.summary).toContain('[PENDING] Auth System (5 stories) — spec-1');
  expect(parsed.summary).toContain('[APPROVED] Dashboard (8 stories) — spec-2');
});

test('passes status filter to API as query param', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => [],
  });

  const handler = getToolHandler('rorca_list_specs');
  await handler({ workspaceId: 'ws-456', status: 'pending' });

  // timedFetch wraps fetch with AbortSignal — check that the URL is correct
  expect(mockFetch).toHaveBeenCalledWith(
    `${RORCA_API}/api/specs?workspaceId=ws-456&status=pending`,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});

test('returns error result when API returns non-200', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status: 502,
    statusText: 'Bad Gateway',
    text: async () => 'Bad Gateway',
    json: async () => ({ error: 'Bad Gateway' }),
  });

  const handler = getToolHandler('rorca_list_specs');
  const result = await handler({ workspaceId: 'ws-123', status: 'all' });

  // Handler returns isError content (not throw) for HTTP errors
  expect(result.content[0].type).toBe('text');
  const parsed = JSON.parse(result.content[0].text);
  expect(parsed.ok).toBe(false);
  expect(parsed.tool).toBe('rorca_list_specs');
});
