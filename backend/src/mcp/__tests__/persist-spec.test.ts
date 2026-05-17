/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
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
  slug: 'explicit-draft',
  title: 'Explicit Draft',
  status: 'pending',
  stories: [
    {
      id: 'US-001',
      title: 'User login',
      description: 'As a user I can log in with email and password',
      acceptanceCriteria: ['Login form exists'],
      dependsOn: [],
      passes: false,
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

test('explicit spec persistence aliases are registered on the McpServer', () => {
  const tools = (server as any)._registeredTools;
  expect(tools['rorca_create_spec']).toBeDefined();
  expect(tools['rorca_persist_spec']).toBeDefined();
});

test('calls POST /api/specs/persist with the explicit drafted spec body', async () => {
  mockJsonResponse(MOCK_SPEC);

  const handler = getToolHandler('rorca_create_spec');
  await handler({
    workspaceId: 'ws-456',
    title: 'Explicit Draft',
    specBrief: 'Draft a skill-first spec',
    stories: [
      {
        id: 'US-001',
        title: 'User login',
        description: 'As a user I can log in with email and password',
        acceptanceCriteria: ['Login form exists'],
        dependsOn: [],
      },
    ],
    overwrite: true,
    source: 'skill-first',
  });

  expect(mockFetch).toHaveBeenCalledWith(
    `${RORCA_API}/api/specs/persist`,
    expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
  );

  const body = JSON.parse(mockFetch.mock.calls[0][1].body);
  expect(body).toEqual({
    workspaceId: 'ws-456',
    title: 'Explicit Draft',
    specBrief: 'Draft a skill-first spec',
    stories: [
      {
        id: 'US-001',
        title: 'User login',
        description: 'As a user I can log in with email and password',
        acceptanceCriteria: ['Login form exists'],
        dependsOn: [],
      },
    ],
    overwrite: true,
    source: 'skill-first',
  });
});

test('returns content with persisted spec slug in text', async () => {
  mockJsonResponse(MOCK_SPEC);

  const handler = getToolHandler('rorca_persist_spec');
  const result = await handler({
    workspaceId: 'ws-456',
    title: 'Explicit Draft',
    stories: [
      {
        id: 'US-001',
        title: 'User login',
        description: 'As a user I can log in with email and password',
        acceptanceCriteria: ['Login form exists'],
        dependsOn: [],
      },
    ],
  });

  expect(result.isError).toBeUndefined();
  expect(result.content).toHaveLength(1);
  expect(result.content[0].type).toBe('text');
  expect(result.content[0].text).toContain('explicit-draft');
  expect(result.content[0].text).toContain('"stories"');
});

test('returns MCP error content when persist API returns non-200', async () => {
  mockJsonResponse({ error: 'Spec already exists' }, 409);

  const handler = getToolHandler('rorca_persist_spec');
  const result = await handler({
    workspaceId: 'ws-456',
    title: 'Explicit Draft',
    stories: [
      {
        id: 'US-001',
        title: 'User login',
        description: 'As a user I can log in with email and password',
        acceptanceCriteria: ['Login form exists'],
        dependsOn: [],
      },
    ],
  });

  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('Spec already exists');
});
