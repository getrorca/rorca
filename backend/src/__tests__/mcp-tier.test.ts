import { swaggerSpec } from '../lib/swagger';
import { createMcpHttpServer, getMcpToolDefinitions } from '../lib/mcp-http';

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

describe('MCP tier exposure', () => {
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

  it('includes only public and auth operations in the MCP tool catalog', () => {
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
      },
    };

    const tools = getMcpToolDefinitions(spec as any);

    expect(tools.map(tool => tool.toolName)).toEqual([
      'rorca_specs',
      'rorca_profile',
    ]);
  });

  it('enforces admin tier again inside tool dispatch', async () => {
    const spec = {
      paths: {
        '/api/specs': {
          get: {
            summary: 'List specs',
            'x-rorca-tier': 'public',
            parameters: [],
          },
        },
        '/api/pipeline/trigger': {
          post: {
            summary: 'Trigger run',
            'x-rorca-tier': 'public',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      specId: { type: 'string' },
                    },
                  },
                },
              },
            },
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

    const deniedResult = await publicTools.rorca_pipeline_trigger.handler({ specId: 'spec-1' }, { sessionId: 'public-session', requestId: '2' });
    expect(deniedResult.isError).toBe(true);
    expect(deniedResult.content[0].text).toContain('requires admin tier');

    const adminServer = createMcpHttpServer(spec as any, {
      resolveSessionTier: () => 'admin',
    });
    const adminTools = (adminServer as any)._registeredTools as Record<string, { handler: Function }>;
    const adminResult = await adminTools.rorca_pipeline_trigger.handler({ specId: 'spec-1' }, { sessionId: 'admin-session', requestId: '3' });
    expect(adminResult.isError).toBeUndefined();
  });
});
