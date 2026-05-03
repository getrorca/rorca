import { swaggerSpec } from '../lib/swagger';
import { getMcpToolDefinitions } from '../lib/mcp-http';

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
});
