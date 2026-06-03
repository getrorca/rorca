import { test, expect } from '@playwright/test';

test('suppressed memory shows ontology reason in memory UI', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('rorca_workspaceId', 'ws-1');
    sessionStorage.setItem('rorca_workspaceId', 'ws-1');
  });

  await page.route('**/api/workspaces', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [{ id: 'ws-1', label: 'My Repo', path: '/tmp/repo', domains: [] }],
        total: 1,
        hasMore: false,
      }),
    });
  });

  await page.route('**/api/memory/items?*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          {
            id: 1,
            workspaceId: 'ws-1',
            category: 'Architecture',
            content: 'Direction Stack layers cascade L1 → L5.',
            sourceStoryId: 'MOG-001',
            sourceRunId: 42,
            confidence: 'high',
            relatedFiles: ['backend/src/routes/memory.ts'],
            pinned: true,
            sourceType: 'manual',
            createdAt: '2026-06-02T10:00:00.000Z',
          },
          {
            id: 2,
            workspaceId: 'ws-1',
            category: 'Decision',
            content: 'Bound node and edge counts in the query layer.',
            sourceStoryId: 'MOG-001',
            sourceRunId: 42,
            confidence: 'high',
            relatedFiles: ['backend/src/lib/memory-graph.ts'],
            pinned: false,
            sourceType: 'synthesis',
            createdAt: '2026-06-02T09:00:00.000Z',
          },
        ],
        total: 2,
        pinned: 1,
        recentRunIds: [42],
        categories: ['Architecture', 'Decision'],
      }),
    });
  });

  await page.route('**/api/memory/relations?*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          {
            id: 91,
            relationType: 'SUPERSEDES',
            status: 'active',
            sourceMemoryId: 2,
            targetMemoryId: 1,
          },
        ],
        total: 1,
      }),
    });
  });

  await page.route('**/api/memory/graph/overview?*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        available: true,
        scope: { workspaceId: 'ws-1', view: 'overview', memoryId: null },
        nodes: [
          { id: 'memory:ws-1::1', type: 'Memory', entityId: '1', label: '1', workspaceId: 'ws-1', selected: true, category: 'Architecture', pinned: true },
          { id: 'memory:ws-1::2', type: 'Memory', entityId: '2', label: '2', workspaceId: 'ws-1', selected: true, category: 'Decision', pinned: false },
        ],
        edges: [
          { id: 'SUPERSEDES:memory:ws-1::2->memory:ws-1::1', type: 'SUPERSEDES', source: 'memory:ws-1::2', target: 'memory:ws-1::1' },
        ],
        summary: {
          nodeCount: 2,
          edgeCount: 1,
          countsByType: { Memory: 2, Story: 0, Spec: 0, File: 0 },
          countsByEdgeType: { ABOUT: 0, LEARNED_FROM: 0, FROM_SPEC: 0, TOUCHES: 0, BELONGS_TO: 0, DEPENDS_ON: 0, SUPERSEDES: 1, CONFLICTS_WITH: 0 },
          caps: { memories: 12, stories: 18, files: 24, specs: 8, edges: 72, dependencies: 8 },
          truncated: { nodes: false, edges: false },
        },
        selection: {
          selectedMemoryId: null,
          suggestedMemoryIds: ['1', '2'],
          relatedStoryIds: [],
          relatedSpecIds: [],
          relatedFilePaths: [],
        },
      }),
    });
  });

  await page.route('**/api/memory/graph/neighborhood?*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        available: true,
        scope: { workspaceId: 'ws-1', view: 'neighborhood', memoryId: '1' },
        nodes: [
          { id: 'memory:ws-1::1', type: 'Memory', entityId: '1', label: '1', workspaceId: 'ws-1', selected: true, category: 'Architecture', pinned: true },
          { id: 'memory:ws-1::2', type: 'Memory', entityId: '2', label: '2', workspaceId: 'ws-1', selected: false, category: 'Decision', pinned: false },
        ],
        edges: [
          { id: 'SUPERSEDES:memory:ws-1::2->memory:ws-1::1', type: 'SUPERSEDES', source: 'memory:ws-1::2', target: 'memory:ws-1::1' },
        ],
        summary: {
          nodeCount: 2,
          edgeCount: 1,
          countsByType: { Memory: 2, Story: 0, Spec: 0, File: 0 },
          countsByEdgeType: { ABOUT: 0, LEARNED_FROM: 0, FROM_SPEC: 0, TOUCHES: 0, BELONGS_TO: 0, DEPENDS_ON: 0, SUPERSEDES: 1, CONFLICTS_WITH: 0 },
          caps: { memories: 1, stories: 10, files: 12, specs: 6, edges: 40, dependencies: 10 },
          truncated: { nodes: false, edges: false },
        },
        selection: {
          selectedMemoryId: '1',
          suggestedMemoryIds: ['1', '2'],
          relatedStoryIds: [],
          relatedSpecIds: [],
          relatedFilePaths: [],
        },
      }),
    });
  });

  await page.goto('/memory');

  await expect(page.getByText('Superseded by memory #2')).toBeVisible();
  await page.getByRole('tab', { name: 'Split' }).click();
  await expect(page.getByText('Active rule — supersedes memory #1')).toBeVisible();
});
