/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

const mockFetch = jest.fn();
const originalFetch = (global as any).fetch;

process.env.NODE_ENV = 'test';

// CTM-008: the enrich MCP tool forwards through the async spec-job bridge, which
// polls pollSpecJob() after enqueuing. Stub the poller so the handler resolves
// deterministically with the terminal job result instead of polling the network.
const mockPollSpecJob = jest.fn();
jest.mock('../spec-job-poller', () => ({
  pollSpecJob: (...args: unknown[]) => mockPollSpecJob(...args),
}));

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
  mockPollSpecJob.mockReset();
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
    contextUsed: {
      text: 'L1/L2/L3 context text',
      meta: { standards: true, conventions: true, project: true, totalTokens: 1234, scopesMatched: [] },
    },
    contextSummary: {
      directionLayers: { l1: true, l2: { present: true, domain: 'devtools' }, l3: true },
      skills: ['rorca-forge'],
      memoryEntries: 2,
      agentsMd: true,
      template: null,
      schemaSnapshot: true,
      gitMemory: false,
      estimatedTokens: 1234,
      modelContextWindow: 200000,
      retrieval: { cagHits: 1, ragHits: 3, graphHits: 2, tier: 'hybrid', latencyMs: 25 },
    },
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
    contextUsed: {
      text: 'L1/L2/L3 context text',
      meta: { standards: true, conventions: true, project: true, totalTokens: 1234, scopesMatched: [] },
    },
    contextSummary: {
      directionLayers: { l1: true, l2: { present: true, domain: 'devtools' }, l3: true },
      skills: ['rorca-forge'],
      memoryEntries: 2,
      agentsMd: true,
      template: null,
      schemaSnapshot: true,
      gitMemory: false,
      estimatedTokens: 1234,
      modelContextWindow: 200000,
      retrieval: { cagHits: 1, ragHits: 3, graphHits: 2, tier: 'hybrid', latencyMs: 25 },
    },
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

// ─── CTM-008: enrich MCP forwarding ─────────────────────────────────────────

test('exposes the enrich tool now that the /enrich route carries a public tier', () => {
  const tools = (server as any)._registeredTools;
  // The OpenAPI-derived tool and the friendly alias must both register. Before
  // the route gained x-rorca-tier, getRorcaTier() resolved to 'denied' and the
  // tool was skipped — this guards that regression.
  expect(tools['rorca_specs_by_specId_enrich']).toBeDefined();
  expect(tools['rorca_enrich_spec']).toBeDefined();
});

test('forwards enrich through the async spec-job bridge and returns the terminal result', async () => {
  // 1. Enqueue (POST /enrich/async) returns the job handle the bridge expects.
  mockJsonResponse({ jobId: '11111111-1111-1111-1111-111111111111', status: 'pending', pollUrl: '/api/spec-jobs/11111111-1111-1111-1111-111111111111' }, 202);
  // 2. The poller resolves to a completed job carrying enrichment metadata only.
  mockPollSpecJob.mockResolvedValueOnce({
    id: '11111111-1111-1111-1111-111111111111',
    status: 'completed',
    result: { success: true, retrieval_method: 'pgvector', storiesEnriched: 3 },
  });

  const handler = getToolHandler('rorca_enrich_spec');
  const result = await handler({ workspaceId: 'ws-789', specId: 'oauth-login' });

  // The bridge must hit the /async endpoint, not the synchronous /enrich route.
  expect(mockFetch).toHaveBeenCalledWith(
    `${RORCA_API}/api/specs/oauth-login/enrich/async`,
    expect.objectContaining({ method: 'POST' }),
  );
  const body = JSON.parse(mockFetch.mock.calls[0][1].body);
  expect(body).toEqual({ workspaceId: 'ws-789' });

  expect(mockPollSpecJob).toHaveBeenCalledWith(
    '11111111-1111-1111-1111-111111111111',
    expect.any(Object),
  );

  expect(result.isError).toBeUndefined();
  expect(result.content[0].text).toContain('pgvector');
  expect(result.content[0].text).toContain('"storiesEnriched": 3');
});

test('surfaces a failed enrichment job as MCP error content', async () => {
  mockJsonResponse({ jobId: '22222222-2222-2222-2222-222222222222', status: 'pending', pollUrl: '/api/spec-jobs/22222222-2222-2222-2222-222222222222' }, 202);
  mockPollSpecJob.mockResolvedValueOnce({
    id: '22222222-2222-2222-2222-222222222222',
    status: 'failed',
    error: 'Spec has an active pipeline run',
  });

  const handler = getToolHandler('rorca_enrich_spec');
  const result = await handler({ workspaceId: 'ws-789', specId: 'oauth-login' });

  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('Spec has an active pipeline run');
});
