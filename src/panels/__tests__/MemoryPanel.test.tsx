/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../test/helpers';
import MemoryPanel from '../MemoryPanel';

vi.mock('../../lib/apiFetch', () => ({
  apiFetch: vi.fn(),
  BASE_URL: 'http://localhost:3030',
  onApiFetchError: vi.fn(() => () => {}),
  setTokens: vi.fn(),
  clearTokens: vi.fn(),
  getAccessToken: vi.fn(() => null),
}));

import { apiFetch } from '../../lib/apiFetch';
const mockApiFetch = vi.mocked(apiFetch);

const WORKSPACE_ROW = { id: 'ws-1', label: 'My Repo', path: '/tmp/repo', domains: [] };
const WORKSPACE_RESPONSE = { items: [WORKSPACE_ROW], total: 1, hasMore: false };

const MEMORY_LIST_RESPONSE = {
  items: [
    {
      id: 1,
      workspaceId: 'ws-1',
      category: 'Architecture',
      content: 'Direction Stack layers cascade L1 → L5.',
      sourceStoryId: 'MOG-001',
      sourceSpecId: 'spec-a',
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
      sourceSpecId: 'spec-a',
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
};

const MEMORY_RELATIONS_RESPONSE = {
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
};

const OVERVIEW_GRAPH_RESPONSE = {
  available: true,
  scope: { workspaceId: 'ws-1', view: 'overview', memoryId: null },
  nodes: [
    { id: 'memory:ws-1::1', type: 'Memory', entityId: '1', label: '1', workspaceId: 'ws-1', selected: true, category: 'Architecture', pinned: true },
    { id: 'memory:ws-1::2', type: 'Memory', entityId: '2', label: '2', workspaceId: 'ws-1', selected: true, category: 'Decision', pinned: false },
    { id: 'story:ws-1::spec-a::MOG-001', type: 'Story', entityId: 'MOG-001', label: 'Build memory graph APIs', workspaceId: 'ws-1', selected: false, storyId: 'MOG-001', specId: 'spec-a', title: 'Build memory graph APIs' },
  ],
  edges: [
    { id: 'LEARNED_FROM:memory:ws-1::1->story:ws-1::spec-a::MOG-001', type: 'LEARNED_FROM', source: 'memory:ws-1::1', target: 'story:ws-1::spec-a::MOG-001' },
    { id: 'LEARNED_FROM:memory:ws-1::2->story:ws-1::spec-a::MOG-001', type: 'LEARNED_FROM', source: 'memory:ws-1::2', target: 'story:ws-1::spec-a::MOG-001' },
  ],
  summary: {
    nodeCount: 3,
    edgeCount: 2,
    countsByType: { Memory: 2, Story: 1, Spec: 0, File: 0 },
    countsByEdgeType: { ABOUT: 0, LEARNED_FROM: 2, FROM_SPEC: 0, TOUCHES: 0, BELONGS_TO: 0, DEPENDS_ON: 0 },
    caps: { memories: 12, stories: 18, files: 24, specs: 8, edges: 72, dependencies: 8 },
    truncated: { nodes: false, edges: false },
  },
  selection: {
    selectedMemoryId: null,
    suggestedMemoryIds: ['1', '2'],
    relatedStoryIds: ['MOG-001'],
    relatedSpecIds: ['spec-a'],
    relatedFilePaths: [],
  },
};

const NEIGHBORHOOD_GRAPH_RESPONSE = {
  available: true,
  scope: { workspaceId: 'ws-1', view: 'neighborhood', memoryId: '1' },
  nodes: [
    { id: 'memory:ws-1::1', type: 'Memory', entityId: '1', label: '1', workspaceId: 'ws-1', selected: true, category: 'Architecture', pinned: true },
    { id: 'file:ws-1::backend/src/routes/memory.ts', type: 'File', entityId: 'backend/src/routes/memory.ts', label: 'backend/src/routes/memory.ts', workspaceId: 'ws-1', selected: false, path: 'backend/src/routes/memory.ts' },
    { id: 'spec:ws-1::spec-a', type: 'Spec', entityId: 'spec-a', label: 'Memory Ontology Canonical', workspaceId: 'ws-1', selected: false, specId: 'spec-a', title: 'Memory Ontology Canonical' },
  ],
  edges: [
    { id: 'ABOUT:memory:ws-1::1->file:ws-1::backend/src/routes/memory.ts', type: 'ABOUT', source: 'memory:ws-1::1', target: 'file:ws-1::backend/src/routes/memory.ts' },
    { id: 'FROM_SPEC:memory:ws-1::1->spec:ws-1::spec-a', type: 'FROM_SPEC', source: 'memory:ws-1::1', target: 'spec:ws-1::spec-a' },
  ],
  summary: {
    nodeCount: 3,
    edgeCount: 2,
    countsByType: { Memory: 1, Story: 0, Spec: 1, File: 1 },
    countsByEdgeType: { ABOUT: 1, LEARNED_FROM: 0, FROM_SPEC: 1, TOUCHES: 0, BELONGS_TO: 0, DEPENDS_ON: 0 },
    caps: { memories: 1, stories: 10, files: 12, specs: 6, edges: 40, dependencies: 10 },
    truncated: { nodes: false, edges: false },
  },
  selection: {
    selectedMemoryId: '1',
    suggestedMemoryIds: ['1'],
    relatedStoryIds: [],
    relatedSpecIds: ['spec-a'],
    relatedFilePaths: ['backend/src/routes/memory.ts'],
  },
};

beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.setItem('rorca_workspaceId', 'ws-1');
  sessionStorage.setItem('rorca_workspaceId', 'ws-1');
});

function mockPanelData(overrides?: {
  memoryList?: typeof MEMORY_LIST_RESPONSE;
  overviewGraph?: any;
  neighborhoodGraph?: any;
  relations?: typeof MEMORY_RELATIONS_RESPONSE;
}) {
  mockApiFetch.mockImplementation(async (path: string) => {
    if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
    if (path.startsWith('/api/memory/items?')) return overrides?.memoryList ?? MEMORY_LIST_RESPONSE;
    if (path.startsWith('/api/memory/relations?')) return overrides?.relations ?? MEMORY_RELATIONS_RESPONSE;
    if (path.startsWith('/api/memory/graph/overview?')) return overrides?.overviewGraph ?? OVERVIEW_GRAPH_RESPONSE;
    if (path.startsWith('/api/memory/graph/neighborhood?')) return overrides?.neighborhoodGraph ?? NEIGHBORHOOD_GRAPH_RESPONSE;
    return {};
  });
}

describe('MemoryPanel', () => {
  it('defaults to list mode and lets operators switch to graph and split views', async () => {
    const user = userEvent.setup();
    mockPanelData();

    renderWithProviders(<MemoryPanel />);

    await screen.findByText('Direction Stack layers cascade L1 → L5.');
    expect(screen.queryByText('Knowledge Web')).toBeNull();

    await user.click(screen.getByRole('tab', { name: 'Graph' }));

    expect(await screen.findByText('Knowledge Web')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Knowledge Web graph canvas' })).toBeTruthy();

    await user.click(screen.getByRole('tab', { name: 'Split' }));

    expect(await screen.findByText('Ledger')).toBeTruthy();
    expect(screen.getByText('Knowledge Web')).toBeTruthy();
  });

  it('keeps list and graph selection in sync in split mode', async () => {
    const user = userEvent.setup();
    mockPanelData();

    renderWithProviders(<MemoryPanel />);

    await screen.findByText('Direction Stack layers cascade L1 → L5.');
    await user.click(screen.getByRole('tab', { name: 'Split' }));

    expect(await screen.findByText('Centered on memory #1')).toBeTruthy();

    const memoryList = screen.getByRole('list', { name: 'Memory entries' });
    const secondEntry = within(memoryList).getByText('Bound node and edge counts in the query layer.').closest('li');
    expect(secondEntry).toBeTruthy();

    await user.click(screen.getByLabelText('Focus memory 2 from graph'));

    await waitFor(() => {
      expect(screen.getByText('Centered on memory #2')).toBeTruthy();
      expect(within(secondEntry as HTMLElement).getByText('Web focus')).toBeTruthy();
    });

    const firstEntry = within(memoryList).getByText('Direction Stack layers cascade L1 → L5.').closest('li');
    expect(firstEntry).toBeTruthy();

    await user.click(within(memoryList).getByText('Direction Stack layers cascade L1 → L5.'));

    await waitFor(() => {
      expect(screen.getByText('Centered on memory #1')).toBeTruthy();
      expect(within(firstEntry as HTMLElement).getByText('Web focus')).toBeTruthy();
    });
  });

  it('shows superseded ontology reasoning in the ledger and graph surfaces', async () => {
    const user = userEvent.setup();
    mockPanelData();

    renderWithProviders(<MemoryPanel />);

    await screen.findByText('Direction Stack layers cascade L1 → L5.');
    expect(screen.getAllByText('Superseded by memory #2').length).toBeGreaterThan(0);

    await user.click(screen.getByRole('tab', { name: 'Split' }));
    expect((await screen.findAllByText('Superseded by memory #2')).length).toBeGreaterThan(0);
    expect(screen.getByText('Active rule — supersedes memory #1')).toBeTruthy();
  });

  it('shows a graph empty state when filters remove the current corpus', async () => {
    const user = userEvent.setup();
    mockPanelData();

    renderWithProviders(<MemoryPanel />);

    await screen.findByText('Direction Stack layers cascade L1 → L5.');
    await user.selectOptions(screen.getByLabelText('Filter by source type'), 'import');
    await user.click(screen.getByRole('tab', { name: 'Graph' }));

    expect(await screen.findByText('No graph results for the current filters')).toBeTruthy();
  });

  it('shows a graceful AGE-unavailable fallback in graph mode', async () => {
    const user = userEvent.setup();
    mockPanelData({
      overviewGraph: {
        ...OVERVIEW_GRAPH_RESPONSE,
        available: false,
        nodes: [],
        edges: [],
        summary: { ...OVERVIEW_GRAPH_RESPONSE.summary, nodeCount: 0, edgeCount: 0 },
        error: 'Apache AGE extension not available',
        hint: 'Run `rorca db start` to enable graph memory (requires Docker)',
      },
    });

    renderWithProviders(<MemoryPanel />);

    await screen.findByText('Direction Stack layers cascade L1 → L5.');
    await user.click(screen.getByRole('tab', { name: 'Graph' }));

    expect(await screen.findByText(/Apache AGE extension not available/)).toBeTruthy();
  });

  it('renders a bounded blast-radius summary and cap warnings for the current selection', async () => {
    const user = userEvent.setup();
    mockPanelData({
      overviewGraph: {
        ...OVERVIEW_GRAPH_RESPONSE,
        summary: {
          ...OVERVIEW_GRAPH_RESPONSE.summary,
          truncated: { nodes: true, edges: false },
        },
      },
      neighborhoodGraph: {
        ...NEIGHBORHOOD_GRAPH_RESPONSE,
        summary: {
          ...NEIGHBORHOOD_GRAPH_RESPONSE.summary,
          truncated: { nodes: false, edges: true },
        },
      },
    });

    renderWithProviders(<MemoryPanel />);

    await screen.findByText('Direction Stack layers cascade L1 → L5.');
    await user.click(screen.getByRole('tab', { name: 'Split' }));

    expect(await screen.findByLabelText('Blast radius summary')).toBeTruthy();
    expect(screen.getByText('Centered on memory #1')).toBeTruthy();
    expect(screen.getByText('Moderate')).toBeTruthy();
    expect(screen.getByText(/Workspace overview is intentionally capped before rendering/)).toBeTruthy();
    expect(screen.getByText(/Focused neighborhood is intentionally capped before rendering/)).toBeTruthy();

    const summary = screen.getByLabelText('Blast radius summary');
    expect(within(summary).getByText('Spec spec-a')).toBeTruthy();
    expect(within(summary).getByText('memory.ts')).toBeTruthy();
    expect(within(summary).getByText('Memory #2')).toBeTruthy();
    expect(within(summary).getByText('Superseded by memory #2')).toBeTruthy();
  });

  it('shows a distinct loading state before the graph resolves', async () => {
    const user = userEvent.setup();
    let resolveOverview!: (value: typeof OVERVIEW_GRAPH_RESPONSE) => void;

    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.startsWith('/api/memory/items?')) return MEMORY_LIST_RESPONSE;
      if (path.startsWith('/api/memory/relations?')) return MEMORY_RELATIONS_RESPONSE;
      if (path.startsWith('/api/memory/graph/overview?')) {
        return await new Promise<typeof OVERVIEW_GRAPH_RESPONSE>((resolve) => {
          resolveOverview = resolve;
        });
      }
      if (path.startsWith('/api/memory/graph/neighborhood?')) return NEIGHBORHOOD_GRAPH_RESPONSE;
      return {};
    });

    renderWithProviders(<MemoryPanel />);

    await screen.findByText('Direction Stack layers cascade L1 → L5.');
    await user.click(screen.getByRole('tab', { name: 'Graph' }));

    expect(await screen.findByText('Loading Knowledge Web')).toBeTruthy();

    resolveOverview(OVERVIEW_GRAPH_RESPONSE);

    expect(await screen.findByText('Blast radius')).toBeTruthy();
  });

  it('shows an explicit unavailable ontology state when relation reasons cannot be loaded', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.startsWith('/api/memory/items?')) return MEMORY_LIST_RESPONSE;
      if (path.startsWith('/api/memory/relations?')) throw new Error('Ontology relation fetch failed');
      if (path.startsWith('/api/memory/graph/overview?')) return OVERVIEW_GRAPH_RESPONSE;
      if (path.startsWith('/api/memory/graph/neighborhood?')) return NEIGHBORHOOD_GRAPH_RESPONSE;
      return {};
    });

    renderWithProviders(<MemoryPanel />);

    expect(await screen.findByText(/Ontology explanations unavailable right now/)).toBeTruthy();
  });

  it('shows a distinct unavailable state when the overview request fails', async () => {
    const user = userEvent.setup();

    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.startsWith('/api/memory/items?')) return MEMORY_LIST_RESPONSE;
      if (path.startsWith('/api/memory/relations?')) return MEMORY_RELATIONS_RESPONSE;
      if (path.startsWith('/api/memory/graph/overview?')) throw new Error('Overview request failed');
      if (path.startsWith('/api/memory/graph/neighborhood?')) return NEIGHBORHOOD_GRAPH_RESPONSE;
      return {};
    });

    renderWithProviders(<MemoryPanel />);

    await screen.findByText('Direction Stack layers cascade L1 → L5.');
    await user.click(screen.getByRole('tab', { name: 'Graph' }));

    expect(await screen.findByText('Unavailable')).toBeTruthy();
    expect(screen.getByText('Overview request failed')).toBeTruthy();
  });

  it('keeps search, edit, pin, and delete workflows working in split mode', async () => {
    const user = userEvent.setup();

    mockApiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.startsWith('/api/memory/items?')) {
        const search = new URL(`http://localhost${path}`).searchParams.get('search')?.toLowerCase() ?? '';
        if (!search) return MEMORY_LIST_RESPONSE;
        const items = MEMORY_LIST_RESPONSE.items.filter((item) => item.content.toLowerCase().includes(search));
        return {
          ...MEMORY_LIST_RESPONSE,
          items,
          total: items.length,
          pinned: items.filter((item) => item.pinned).length,
        };
      }
      if (path.startsWith('/api/memory/relations?')) return MEMORY_RELATIONS_RESPONSE;
      if (path.startsWith('/api/memory/graph/overview?')) return OVERVIEW_GRAPH_RESPONSE;
      if (path.startsWith('/api/memory/graph/neighborhood?')) return NEIGHBORHOOD_GRAPH_RESPONSE;
      if (path === '/api/memory/items/1' && init?.method === 'PATCH') return {};
      if (path === '/api/memory/items/1' && init?.method === 'DELETE') return {};
      return {};
    });

    renderWithProviders(<MemoryPanel />);

    await screen.findByText('Direction Stack layers cascade L1 → L5.');
    await user.click(screen.getByRole('tab', { name: 'Split' }));
    await user.click(screen.getByLabelText('Focus memory 2 from graph'));

    await waitFor(() => {
      expect(screen.getByText('Centered on memory #2')).toBeTruthy();
    });

    const search = screen.getByLabelText('Search memories');
    await user.type(search, 'Bound node');
    await waitFor(() => {
      expect(screen.queryByText('Direction Stack layers cascade L1 → L5.')).toBeNull();
    });

    await user.clear(search);
    await waitFor(() => {
      expect(screen.getAllByText('Direction Stack layers cascade L1 → L5.').length).toBeGreaterThan(0);
    });

    const memoryList = screen.getByRole('list', { name: 'Memory entries' });
    let firstEntry = within(memoryList).getByText('Direction Stack layers cascade L1 → L5.').closest('li') as HTMLElement;
    await user.click(within(firstEntry).getByTitle('Edit content'));
    const editor = within(firstEntry).getByRole('textbox');
    await user.clear(editor);
    await user.type(editor, 'Updated memory copy');
    await user.click(within(firstEntry).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/memory/items/1', expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ content: 'Updated memory copy' }),
      }));
    });

    firstEntry = within(memoryList).getByText('Direction Stack layers cascade L1 → L5.').closest('li') as HTMLElement;
    await user.click(within(firstEntry).getByTitle('Unpin'));
    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/memory/items/1', expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ pinned: false }),
      }));
    });

    firstEntry = within(memoryList).getByText('Direction Stack layers cascade L1 → L5.').closest('li') as HTMLElement;
    await user.click(within(firstEntry).getByTitle('Delete'));

    expect(await screen.findByText('Memory deleted. Undo?')).toBeTruthy();
    expect(mockApiFetch).toHaveBeenCalledWith('/api/memory/items/1', expect.objectContaining({ method: 'DELETE' }));
  });

  it('creates ontology relations from the focused curation workflow and synchronizes ledger state after mutation', async () => {
    const user = userEvent.setup();
    let relationItems: Array<{ id: number; relationType: 'SUPERSEDES' | 'CONFLICTS_WITH'; status: 'active' | 'superseded' | 'deleted'; sourceMemoryId: number; targetMemoryId: number }> = [];

    mockApiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.startsWith('/api/memory/items?')) return MEMORY_LIST_RESPONSE;
      if (path.startsWith('/api/memory/relations?')) return { items: relationItems, total: relationItems.length };
      if (path === '/api/memory/relations' && init?.method === 'POST') {
        relationItems = [{ id: 92, relationType: 'CONFLICTS_WITH', status: 'active', sourceMemoryId: 1, targetMemoryId: 2 }];
        return { relation: relationItems[0] };
      }
      return {};
    });

    renderWithProviders(<MemoryPanel />);

    await screen.findByText('Direction Stack layers cascade L1 → L5.');
    expect(screen.getByText('No active supersession or conflict edges recorded for this memory yet.')).toBeTruthy();

    await user.selectOptions(screen.getByLabelText('Target memory'), '2');
    await user.click(screen.getByRole('button', { name: 'Mark conflict' }));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/memory/relations', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          workspaceId: 'ws-1',
          sourceMemoryId: 1,
          targetMemoryId: 2,
          relationType: 'CONFLICTS_WITH',
        }),
      }));
    });

    expect((await screen.findAllByText('Conflicts with memory #2')).length).toBeGreaterThan(0);
  });

  it('blocks duplicate conflict edges in the UI before a mutation request is sent', async () => {
    const user = userEvent.setup();
    mockPanelData({ relations: { items: [{ id: 91, relationType: 'CONFLICTS_WITH', status: 'active', sourceMemoryId: 1, targetMemoryId: 2 }], total: 1 } });

    renderWithProviders(<MemoryPanel />);

    await screen.findByText('Direction Stack layers cascade L1 → L5.');
    await user.selectOptions(screen.getByLabelText('Target memory'), '2');

    expect(screen.getByText('Conflicts: These memories already conflict.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Mark conflict' })).toBeDisabled();
    expect(mockApiFetch).not.toHaveBeenCalledWith('/api/memory/relations', expect.objectContaining({ method: 'POST' }));
  });

  it('removes active ontology relations from the focused curation workflow and clears stale state', async () => {
    const user = userEvent.setup();
    let relationItems = [{ id: 91, relationType: 'SUPERSEDES' as const, status: 'active' as const, sourceMemoryId: 1, targetMemoryId: 2 }];

    mockApiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.startsWith('/api/memory/items?')) return MEMORY_LIST_RESPONSE;
      if (path.startsWith('/api/memory/relations?')) return { items: relationItems, total: relationItems.length };
      if (path === '/api/memory/relations/91' && init?.method === 'DELETE') {
        relationItems = [];
        return {};
      }
      return {};
    });

    renderWithProviders(<MemoryPanel />);

    await screen.findByText('Direction Stack layers cascade L1 → L5.');
    expect((await screen.findAllByText(/supersedes memory #2/i)).length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/memory/relations/91', expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ workspaceId: 'ws-1' }),
      }));
    });

    expect(await screen.findByText('No active supersession or conflict edges recorded for this memory yet.')).toBeTruthy();
    expect(screen.queryByText(/supersedes memory #2/i)).toBeNull();
  });

  it('handles empty memory lists', async () => {
    mockPanelData({
      memoryList: { ...MEMORY_LIST_RESPONSE, items: [], total: 0, pinned: 0, recentRunIds: [] },
      overviewGraph: {
        ...OVERVIEW_GRAPH_RESPONSE,
        nodes: [],
        edges: [],
        summary: { ...OVERVIEW_GRAPH_RESPONSE.summary, nodeCount: 0, edgeCount: 0 },
        selection: { ...OVERVIEW_GRAPH_RESPONSE.selection, suggestedMemoryIds: [], relatedStoryIds: [], relatedSpecIds: [], relatedFilePaths: [] },
      },
      neighborhoodGraph: {
        ...NEIGHBORHOOD_GRAPH_RESPONSE,
        nodes: [],
        edges: [],
        summary: { ...NEIGHBORHOOD_GRAPH_RESPONSE.summary, nodeCount: 0, edgeCount: 0 },
        selection: { ...NEIGHBORHOOD_GRAPH_RESPONSE.selection, suggestedMemoryIds: [], relatedStoryIds: [], relatedSpecIds: [], relatedFilePaths: [] },
      },
    });

    renderWithProviders(<MemoryPanel />);

    await waitFor(() => {
      expect(screen.getByText('No memory entries yet')).toBeTruthy();
    });
  });
});
