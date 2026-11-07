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

test('rorca_pipeline_status is registered on the McpServer', () => {
  const tools = (server as any)._registeredTools;
  expect(tools['rorca_pipeline_status']).toBeDefined();
});

test('lists runs through the canonical route without inventing a limit', async () => {
  const response = [{
    id: 42,
    status: 'running',
    specPath: 'specs/approved/auth.json',
    stories: [
      { storyId: 'US-001', status: 'pass', retries: 0 },
      { storyId: 'US-002', status: 'pending', retries: 0 },
    ],
  }];
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => response });

  const handler = getToolHandler('rorca_pipeline_status');
  const result = await handler({ workspaceId: 'ws-123' });

  expect(mockFetch).toHaveBeenCalledWith(
    `${RORCA_API}/api/pipeline/runs?workspaceId=ws-123`,
    expect.objectContaining({
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: expect.any(AbortSignal),
    }),
  );
  expectJsonResult(result, response);
});

test('forwards a caller-provided runId as the list-route query contract', async () => {
  const response = {
    id: 7,
    status: 'done',
    specPath: 'specs/approved/dashboard.json',
    stories: [{ storyId: 'US-001', status: 'pass', retries: 0 }],
  };
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => response });

  const handler = getToolHandler('rorca_pipeline_status');
  const result = await handler({ workspaceId: 'ws-123', runId: 7 });

  expect(mockFetch).toHaveBeenCalledWith(
    `${RORCA_API}/api/pipeline/runs?workspaceId=ws-123&runId=7`,
    expect.objectContaining({ method: 'GET', signal: expect.any(AbortSignal) }),
  );
  expectJsonResult(result, response);
});

test('preserves every story state rather than reducing it to presentation counts', async () => {
  const response = {
    id: 10,
    status: 'done',
    specPath: 'specs/approved/payments.json',
    startedAt: '2026-02-21T10:00:00Z',
    finishedAt: '2026-02-21T10:30:00Z',
    stories: [
      { storyId: 'US-001', status: 'pass', retries: 0 },
      { storyId: 'US-002', status: 'pass', retries: 1 },
      { storyId: 'US-003', status: 'fail', retries: 2 },
      { storyId: 'US-004', status: 'skip', retries: 0 },
      { storyId: 'US-005', status: 'pass', retries: 0 },
    ],
  };
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => response });

  const handler = getToolHandler('rorca_pipeline_status');
  const result = await handler({ workspaceId: 'ws-123', runId: 10 });

  expectJsonResult(result, response);
});

test('preserves active-run timestamps and pending stories exactly', async () => {
  const response = [{
    id: 99,
    status: 'running',
    specPath: 'specs/approved/luca.json',
    startedAt: '2026-02-21T10:00:00Z',
    stories: [
      { storyId: 'US-001', status: 'pass', retries: 0 },
      { storyId: 'US-002', status: 'pending', retries: 0 },
    ],
  }];
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => response });

  const handler = getToolHandler('rorca_pipeline_status');
  const result = await handler({ workspaceId: 'ws-123' });

  expectJsonResult(result, response);
});

test('preserves an exact empty list', async () => {
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });

  const handler = getToolHandler('rorca_pipeline_status');
  const result = await handler({ workspaceId: 'ws-empty' });

  expectJsonResult(result, []);
});

test('returns an MCP error result when API returns non-200', async () => {
  mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'Internal error' });

  const handler = getToolHandler('rorca_pipeline_status');
  const result = await handler({ workspaceId: 'ws-123' });

  expect(result.isError).toBe(true);
  expect(result.content[0].text).toBe('Error (500): Internal error');
});
