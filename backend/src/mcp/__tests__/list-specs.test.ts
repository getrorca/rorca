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

test('rorca_list_specs is registered on the McpServer', () => {
  const tools = (server as any)._registeredTools;
  expect(tools['rorca_list_specs']).toBeDefined();
});

test('returns "No specs found" message when API returns empty array', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => [],
  });

  const handler = getToolHandler('rorca_list_specs');
  const result = await handler({ workspaceId: 'ws-123', status: 'all' });

  expect(result).toEqual({
    content: [{ type: 'text', text: 'No specs found for workspace ws-123 (filter: all)' }],
  });
});

test('formats spec list with status, title, story count, and id', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => [
      { id: 'spec-1', title: 'Auth System', status: 'pending', storyCount: 5, createdAt: '2026-01-01' },
      { id: 'spec-2', title: 'Dashboard', status: 'approved', storyCount: 8, createdAt: '2026-01-02' },
    ],
  });

  const handler = getToolHandler('rorca_list_specs');
  const result = await handler({ workspaceId: 'ws-123', status: 'all' });

  expect(result).toEqual({
    content: [{
      type: 'text',
      text: '[PENDING] Auth System (5 stories) — spec-1\n[APPROVED] Dashboard (8 stories) — spec-2',
    }],
  });
});

test('passes status filter to API as query param', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => [],
  });

  const handler = getToolHandler('rorca_list_specs');
  await handler({ workspaceId: 'ws-456', status: 'pending' });

  expect(mockFetch).toHaveBeenCalledWith(
    `${RORCA_API}/api/specs?workspaceId=ws-456&status=pending`
  );
});

test('throws when API returns non-200', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status: 502,
  });

  const handler = getToolHandler('rorca_list_specs');
  await expect(handler({ workspaceId: 'ws-123', status: 'all' })).rejects.toThrow(
    'Failed to list specs: 502'
  );
});
