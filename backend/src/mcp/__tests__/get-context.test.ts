/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
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

test('rorca_get_context is registered on the McpServer', () => {
  const tools = (server as any)._registeredTools;
  expect(tools['rorca_get_context']).toBeDefined();
});

test('calls POST /api/direction/synthesize with workspaceId', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ synthesized: 'synthesized context string' }),
  });

  const handler = getToolHandler('rorca_get_context');
  await handler({ workspaceId: 'ws-123' });

  expect(mockFetch).toHaveBeenCalledWith(
    `${RORCA_API}/api/direction/synthesize`,
    expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
  );

  const body = JSON.parse(mockFetch.mock.calls[0][1].body);
  expect(body.workspaceId).toBe('ws-123');
});

test('includes specBrief as l4SpecBrief when provided', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ synthesized: 'with L4' }),
  });

  const handler = getToolHandler('rorca_get_context');
  await handler({ workspaceId: 'ws-123', specBrief: 'Build auth system' });

  const body = JSON.parse(mockFetch.mock.calls[0][1].body);
  expect(body.l4SpecBrief).toBe('Build auth system');
});

test('includes storyAnnotations as l5Annotations when provided', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ synthesized: 'with L5' }),
  });

  const handler = getToolHandler('rorca_get_context');
  await handler({
    workspaceId: 'ws-123',
    storyAnnotations: 'Must use JWT tokens',
  });

  const body = JSON.parse(mockFetch.mock.calls[0][1].body);
  expect(body.l5Annotations).toBe('Must use JWT tokens');
});

test('returns { content: [{ type: "text", text: synthesizedString }] }', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ synthesized: 'full direction stack output' }),
  });

  const handler = getToolHandler('rorca_get_context');
  const result = await handler({ workspaceId: 'ws-123' });

  expect(result).toEqual({
    content: [{ type: 'text', text: 'full direction stack output' }],
  });
});

test('throws when API returns non-200', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status: 500,
  });

  const handler = getToolHandler('rorca_get_context');
  await expect(handler({ workspaceId: 'ws-123' })).rejects.toThrow(
    'Direction Stack synthesis failed: 500'
  );
});
