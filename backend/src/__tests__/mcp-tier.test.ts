/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { swaggerSpec } from '../lib/swagger';
import { createMcpHttpServer, getMcpToolDefinitions } from '../lib/mcp-http';

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

describe('MCP tier exposure', () => {
  afterEach(() => {
    jest.useRealTimers();
    mockFetch.mockReset();
  });

  it('preserves x-rorca-* extensions in the generated OpenAPI spec', () => {
    const spec = swaggerSpec as { paths?: Record<string, Record<string, any>> };
    const operation = spec.paths?.['/api/specs']?.get;

    expect(operation).toBeDefined();
    expect(operation?.['x-rorca-tier']).toBe('public');
    expect(operation?.['x-rorca-rationale']).toContain('Read-only spec listing');
    expect(operation?.['x-rorca-public-api']).toBe(true);
  });

  it('registers zero MCP tools for a spec with no tier annotations', () => {
    const spec = {
      paths: {
        '/api/specs': {
          get: {
            summary: 'List specs without explicit tier',
            parameters: [],
          },
        },
        '/api/teams': {
          post: {
            summary: 'Create team without explicit tier',
          },
        },
      },
    };

    expect(getMcpToolDefinitions(spec as any)).toHaveLength(0);
  });

  it('includes public/auth operations plus explicit admin MCP overrides in the tool catalog', () => {
    const spec = {
      paths: {
        '/api/specs': {
          get: {
            summary: 'List specs',
            'x-rorca-tier': 'public',
            parameters: [],
          },
        },
        '/api/profile': {
          get: {
            summary: 'Get profile',
            'x-rorca-tier': 'auth',
            parameters: [],
          },
        },
        '/api/teams': {
          post: {
            summary: 'Create team',
            'x-rorca-tier': 'paid',
          },
        },
        '/api/admin/backups': {
          post: {
            summary: 'Create backup',
            'x-rorca-tier': 'admin',
          },
        },
        '/api/admin/mcp-audit': {
          get: {
            summary: 'List MCP audit entries',
            'x-rorca-tier': 'admin',
            'x-mcp-tier': 'admin',
            parameters: [],
          },
        },
      },
    };

    const tools = getMcpToolDefinitions(spec as any);

    expect(tools.map(tool => tool.toolName)).toEqual([
      'rorca_specs',
      'rorca_profile',
      'rorca_admin_mcp_audit',
    ]);
  });

  it('enforces admin tier again inside tool dispatch for admin MCP overrides while allowing public tools', async () => {
    const spec = {
      paths: {
        '/api/specs': {
          get: {
            summary: 'List specs',
            'x-rorca-tier': 'public',
            parameters: [],
          },
        },
        '/api/admin/mcp-audit': {
          get: {
            summary: 'List MCP audit entries',
            'x-rorca-tier': 'admin',
            'x-mcp-tier': 'admin',
            parameters: [],
          },
        },
      },
    };

    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ ok: true }),
      text: async () => '{"ok":true}',
    });

    const publicServer = createMcpHttpServer(spec as any, {
      resolveSessionTier: () => 'public',
    });
    const publicTools = (publicServer as any)._registeredTools as Record<string, { handler: Function }>;
    const publicResult = await publicTools.rorca_specs.handler({}, { sessionId: 'public-session', requestId: '1' });
    expect(publicResult.isError).toBeUndefined();

    const deniedResult = await publicTools.rorca_admin_mcp_audit.handler({}, { sessionId: 'public-session', requestId: '2' });
    expect(deniedResult.isError).toBe(true);
    expect(deniedResult.content[0].text).toContain('requires admin tier');

    const adminServer = createMcpHttpServer(spec as any, {
      resolveSessionTier: () => 'admin',
    });
    const adminTools = (adminServer as any)._registeredTools as Record<string, { handler: Function }>;
    const adminResult = await adminTools.rorca_admin_mcp_audit.handler({}, { sessionId: 'admin-session', requestId: '3' });
    expect(adminResult.isError).toBeUndefined();
  });

  it('routes enrich MCP calls through /async and returns the completed job result shape', async () => {
    jest.useFakeTimers();

    const spec = {
      paths: {
        '/api/specs/{specId}/enrich': {
          post: {
            summary: 'Enrich spec',
            'x-rorca-tier': 'public',
            parameters: [
              { name: 'specId', in: 'path', required: true, schema: { type: 'string' } },
            ],
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['workspaceId'],
                    properties: {
                      workspaceId: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 202,
        headers: { get: () => 'application/json' },
        json: async () => ({ jobId: 'job-123', pollUrl: '/api/spec-jobs/job-123', status: 'pending' }),
        text: async () => '{"jobId":"job-123","pollUrl":"/api/spec-jobs/job-123","status":"pending"}',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({
          id: 'job-123',
          specId: 'spec-1',
          workspaceId: 'ws-1',
          jobType: 'enrich',
          status: 'pending',
          progress: { current: 10, total: 53, message: 'working' },
          result: null,
          error: null,
          startedAt: null,
          finishedAt: null,
          createdAt: '2026-05-03T00:00:00.000Z',
        }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({
          id: 'job-123',
          specId: 'spec-1',
          workspaceId: 'ws-1',
          jobType: 'enrich',
          status: 'completed',
          progress: { current: 53, total: 53, message: 'done' },
          result: { matched: 9, storiesAffected: 3, stories: [{ storyId: 'US-001' }] },
          error: null,
          startedAt: null,
          finishedAt: null,
          createdAt: '2026-05-03T00:00:00.000Z',
        }),
        text: async () => '',
      });

    const server = createMcpHttpServer(spec as any, {
      resolveSessionTier: () => 'admin',
    });
    const tools = (server as any)._registeredTools as Record<string, { handler: Function }>;
    expect(tools.rorca_enrich_spec).toBeDefined();

    const resultPromise = tools.rorca_specs_by_specId_enrich.handler(
      { specId: 'spec-1', workspaceId: 'ws-1' },
      { sessionId: 'admin-session', requestId: 'enrich-1' },
    );

    await Promise.resolve();
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      'http://localhost:3030/api/specs/spec-1/enrich/async',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ workspaceId: 'ws-1' }),
      }),
    );

    await jest.advanceTimersByTimeAsync(2_000);
    const result = await resultPromise;

    expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3030/api/spec-jobs/job-123');
    expect(mockFetch).toHaveBeenNthCalledWith(3, 'http://localhost:3030/api/spec-jobs/job-123');
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe(JSON.stringify({
      matched: 9,
      storiesAffected: 3,
      stories: [{ storyId: 'US-001' }],
    }, null, 2));
  });

  it('surfaces spec_jobs.error_message when an async MCP spec job fails', async () => {
    const spec = {
      paths: {
        '/api/specs/{specId}/match-skills': {
          post: {
            summary: 'Match skills',
            'x-rorca-tier': 'public',
            parameters: [
              { name: 'specId', in: 'path', required: true, schema: { type: 'string' } },
            ],
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['workspaceId'],
                    properties: {
                      workspaceId: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 202,
        headers: { get: () => 'application/json' },
        json: async () => ({ jobId: 'job-456', pollUrl: '/api/spec-jobs/job-456', status: 'pending' }),
        text: async () => '{"jobId":"job-456","pollUrl":"/api/spec-jobs/job-456","status":"pending"}',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({
          id: 'job-456',
          specId: 'spec-2',
          workspaceId: 'ws-1',
          jobType: 'match-skills',
          status: 'failed',
          progress: { current: 12, total: 53, message: 'failed' },
          result: null,
          error: 'Anthropic upstream error',
          startedAt: null,
          finishedAt: null,
          createdAt: '2026-05-03T00:00:00.000Z',
        }),
        text: async () => '',
      });

    const server = createMcpHttpServer(spec as any, {
      resolveSessionTier: () => 'admin',
    });
    const tools = (server as any)._registeredTools as Record<string, { handler: Function }>;
    expect(tools.rorca_match_skills).toBeDefined();
    const result = await tools.rorca_specs_by_specId_match_skills.handler(
      { specId: 'spec-2', workspaceId: 'ws-1' },
      { sessionId: 'admin-session', requestId: 'match-1' },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Anthropic upstream error');
  });
});
