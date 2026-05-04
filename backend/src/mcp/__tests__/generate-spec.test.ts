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

beforeEach(() => {
  mockFetch.mockReset();
});

test('rorca_generate_spec is registered on the McpServer', () => {
  const tools = (server as any)._registeredTools;
  expect(tools['rorca_generate_spec']).toBeDefined();
});

test('calls POST /api/specs/generate with correct body', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => MOCK_SPEC,
  });

  const handler = getToolHandler('rorca_generate_spec');
  await handler({
    workspaceId: 'ws-456',
    specBrief: 'Build an auth system',
    title: 'Auth System',
    storyCount: 5,
    includeDiagrams: false,
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
    includeDiagrams: false,
  });
});

test('storyCount defaults to 8 when not provided', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => MOCK_SPEC,
  });

  const handler = getToolHandler('rorca_generate_spec');
  await handler({
    workspaceId: 'ws-456',
    specBrief: 'Build an auth system',
    title: 'Auth System',
  });

  const body = JSON.parse(mockFetch.mock.calls[0][1].body);
  expect(body.storyCount).toBe(8);
});

test('includeDiagrams defaults to true when not provided', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => MOCK_SPEC,
  });

  const handler = getToolHandler('rorca_generate_spec');
  await handler({
    workspaceId: 'ws-456',
    specBrief: 'Build an auth system',
    title: 'Auth System',
  });

  const body = JSON.parse(mockFetch.mock.calls[0][1].body);
  expect(body.includeDiagrams).toBe(true);
});

test('returns content with spec title in text', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => MOCK_SPEC,
  });

  const handler = getToolHandler('rorca_generate_spec');
  const result = await handler({
    workspaceId: 'ws-456',
    specBrief: 'Build an auth system',
    title: 'Auth System',
  });

  expect(result.content).toHaveLength(1);
  expect(result.content[0].type).toBe('text');
  expect(result.content[0].text).toContain('Generated spec: Auth System');
  expect(result.content[0].text).toContain('"userStories"');
});

test('throws with error message when API returns non-200', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status: 422,
    text: async () => 'Invalid workspace ID',
  });

  const handler = getToolHandler('rorca_generate_spec');
  await expect(
    handler({
      workspaceId: 'bad-id',
      specBrief: 'Build something',
      title: 'Test',
    })
  ).rejects.toThrow('Spec generation failed (422): Invalid workspace ID');
});
