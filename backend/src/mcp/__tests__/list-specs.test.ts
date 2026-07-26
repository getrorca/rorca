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

beforeEach(() => {
  mockFetch.mockReset();
  // Health check polling may fire — suppress it by default
  mockFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
});

test('rorca_list_specs is registered on the McpServer', () => {
  const tools = (server as any)._registeredTools;
  expect(tools['rorca_list_specs']).toBeDefined();
});

test('returns the exact empty list as structured JSON text', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => [],
  });

  const handler = getToolHandler('rorca_list_specs');
  const result = await handler({ workspaceId: 'ws-123', status: 'all' });

  expect(result.content[0].type).toBe('text');
  expect(JSON.parse(result.content[0].text)).toEqual([]);
});

test('preserves every spec response field without presentation rewriting', async () => {
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
  expect(parsed).toHaveLength(2);
  expect(parsed[0]).toMatchObject({ id: 'spec-1', specName: 'Auth System', status: 'pending', storyCount: 5 });
  expect(parsed[1]).toMatchObject({ id: 'spec-2', specName: 'Dashboard', status: 'approved', storyCount: 8 });
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

  expect(result.isError).toBe(true);
  expect(result.content[0].type).toBe('text');
  expect(result.content[0].text).toContain('Error (502)');
  expect(result.content[0].text).toContain('Bad Gateway');
});
