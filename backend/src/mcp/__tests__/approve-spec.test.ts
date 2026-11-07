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
});

test('rorca_approve_spec is registered on the McpServer', () => {
  const tools = (server as any)._registeredTools;
  expect(tools['rorca_approve_spec']).toBeDefined();
});

test('calls POST /api/specs/:specId/approve with workspaceId and notes in body', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ path: 'specs/approved/auth-system.json' }),
  });

  const handler = getToolHandler('rorca_approve_spec');
  await handler({ workspaceId: 'ws-123', specId: 'spec-42', notes: 'LGTM' });

  expect(mockFetch).toHaveBeenCalledWith(
    `${RORCA_API}/api/specs/spec-42/approve`,
    expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
  );

  const body = JSON.parse(mockFetch.mock.calls[0][1].body);
  expect(body).toEqual({ workspaceId: 'ws-123', notes: 'LGTM' });
});

test('returns the exact approved-path response as structured JSON text', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ path: 'specs/approved/auth-system.json' }),
  });

  const handler = getToolHandler('rorca_approve_spec');
  const result = await handler({ workspaceId: 'ws-123', specId: 'spec-42' });

  expect(result.content).toHaveLength(1);
  expect(result.content[0].type).toBe('text');
  expect(JSON.parse(result.content[0].text)).toEqual({ path: 'specs/approved/auth-system.json' });
});

test('returns an MCP error result when API returns non-200', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status: 404,
    text: async () => 'Spec not found',
  });

  const handler = getToolHandler('rorca_approve_spec');
  const result = await handler({ workspaceId: 'ws-123', specId: 'bad-id' });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toBe('Error (404): Spec not found');
});

test('notes is optional (omit from body when not provided)', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ path: 'specs/approved/dashboard.json' }),
  });

  const handler = getToolHandler('rorca_approve_spec');
  await handler({ workspaceId: 'ws-789', specId: 'spec-99' });

  const body = JSON.parse(mockFetch.mock.calls[0][1].body);
  expect(body).toEqual({ workspaceId: 'ws-789' });
  expect(body).not.toHaveProperty('notes');
});
