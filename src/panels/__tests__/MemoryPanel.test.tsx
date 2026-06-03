/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
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
  ],
  summary: {
    nodeCount: 3,
    edgeCount: 1,
    countsByType: { Memory: 2, Story: 1, Spec: 0, File: 0 },
    countsByEdgeType: { ABOUT: 0, LEARNED_FROM: 1, FROM_SPEC: 0, TOUCHES: 0, BELONGS_TO: 0, DEPENDS_ON: 0 },
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
}) {
  mockApiFetch.mockImplementation(async (path: string) => {
    if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
    if (path.startsWith('/api/memory/items?')) return overrides?.memoryList ?? MEMORY_LIST_RESPONSE;
    if (path.startsWith('/api/memory/graph/overview?')) return overrides?.overviewGraph ?? OVERVIEW_GRAPH_RESPONSE;
    if (path.startsWith('/api/memory/graph/neighborhood?')) return overrides?.neighborhoodGraph ?? NEIGHBORHOOD_GRAPH_RESPONSE;
    return {};
  });
}

describe('MemoryPanel', () => {
  it('renders memory entries alongside Knowledge Web summaries', async () => {
    mockPanelData();

    renderWithProviders(<MemoryPanel />);

    await screen.findByText('Knowledge Web');
    expect(screen.getByText('Direction Stack layers cascade L1 → L5.')).toBeTruthy();
    expect(screen.getByText('3 overview nodes')).toBeTruthy();
    expect(await screen.findByText('Focused memory #1')).toBeTruthy();
    expect(screen.getAllByText('backend/src/routes/memory.ts').length).toBeGreaterThan(0);
  });

  it('shows a graceful lite-mode fallback when the graph is unavailable', async () => {
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

    await screen.findByText('Knowledge Web');
    expect(screen.getByText(/Apache AGE extension not available/)).toBeTruthy();
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
