/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

const mockFetch = jest.fn();
const originalFetch = (global as any).fetch;

process.env.NODE_ENV = 'test';

import { server } from '../server';

const RORCA_API = process.env.RORCA_API_URL || 'http://localhost:3030';

function getToolHandler(toolName: string) {
  const tools = (server as any)._registeredTools as Record<string, { handler: Function }>;
  const tool = tools[toolName];
  if (!tool) throw new Error(`Tool ${toolName} not registered`);
  return tool.handler;
}

const MOCK_SPEC = {
  title: 'Auth System',
  userStories: [
    {
      id: 'US-001',
      title: 'User login',
      description: 'As a user I can log in with email and password',
      acceptanceCriteria: ['Login form exists', 'JWT token returned'],
      passes: false,
      dependsOn: [],
    },
  ],
};

function mockJsonResponse(body: unknown, status: number = 200) {
  mockFetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

beforeAll(() => {
  (global as any).fetch = mockFetch;
});

afterAll(() => {
  (global as any).fetch = originalFetch;
});

beforeEach(() => {
  mockFetch.mockReset();
});

test('rorca_generate_spec is registered on the McpServer', () => {
  const tools = (server as any)._registeredTools;
  expect(tools['rorca_generate_spec']).toBeDefined();
});

test('calls POST /api/specs/generate with correct body', async () => {
  mockJsonResponse(MOCK_SPEC);

  const handler = getToolHandler('rorca_generate_spec');
  await handler({
    workspaceId: 'ws-456',
    specBrief: 'Build an auth system',
    title: 'Auth System',
    storyCount: 5,
  });

  expect(mockFetch).toHaveBeenCalledWith(
    `${RORCA_API}/api/specs/generate`,
    expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
  );

  const body = JSON.parse(mockFetch.mock.calls[0][1].body);
  expect(body).toEqual({
    workspaceId: 'ws-456',
    specBrief: 'Build an auth system',
    title: 'Auth System',
    storyCount: 5,
  });
});

test('returns content with spec title in text', async () => {
  mockJsonResponse(MOCK_SPEC);

  const handler = getToolHandler('rorca_generate_spec');
  const result = await handler({
    workspaceId: 'ws-456',
    specBrief: 'Build an auth system',
    title: 'Auth System',
  });

  expect(result.isError).toBeUndefined();
  expect(result.content).toHaveLength(1);
  expect(result.content[0].type).toBe('text');
  expect(result.content[0].text).toContain('Auth System');
  expect(result.content[0].text).toContain('"userStories"');
});

test('returns MCP error content when API returns non-200', async () => {
  mockJsonResponse({ error: 'Invalid workspace ID' }, 422);

  const handler = getToolHandler('rorca_generate_spec');
  const result = await handler({
    workspaceId: 'bad-id',
    specBrief: 'Build something',
    title: 'Test',
  });

  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('Invalid workspace ID');
});
