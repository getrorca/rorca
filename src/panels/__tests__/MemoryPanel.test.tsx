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

const MEMORY_REVIEW_RESPONSE: any = {
  available: true,
  staleCandidates: {
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
        pinned: false,
        sourceType: 'manual',
        source: 'MOG-001',
        createdAt: '2026-06-02T10:00:00.000Z',
        updatedAt: '2026-04-02T10:00:00.000Z',
        deletedAt: null,
        staleScore: 68,
        reasons: [
          { code: 'superseded_by_newer_memory', label: 'Superseded by a newer canonical memory.' },
          { code: 'untouched_for_45d', label: 'Not updated for 62 days.' },
        ],
        status: 'candidate',
        lastAction: null,
      },
      {
        id: 3,
        workspaceId: 'ws-1',
        category: 'Decision',
        content: 'Archived memory for restore drills.',
        sourceStoryId: 'MOG-002',
        sourceSpecId: 'spec-a',
        sourceRunId: 41,
        confidence: 'medium',
        relatedFiles: ['backend/src/lib/memory-graph.ts'],
        pinned: false,
        sourceType: 'synthesis',
        source: 'MOG-002',
        createdAt: '2026-05-10T10:00:00.000Z',
        updatedAt: '2026-05-12T10:00:00.000Z',
        deletedAt: '2026-05-15T10:00:00.000Z',
        staleScore: 0,
        reasons: [],
        status: 'archived',
        lastAction: { action: 'archive', at: '2026-05-15T10:00:00.000Z', previousStatus: 'candidate', nextStatus: 'archived' },
      },
    ],
    total: 2,
    truncated: false,
    heuristics: {
      scanLimit: 120,
      resultLimit: 12,
      scoreThreshold: 30,
      staleAfterDays: 45,
      lowConfidenceAfterDays: 21,
    },
    ageAvailable: true,
    mode: 'bounded-sql',
    reason: null,
  },
  provenanceCandidates: {
    items: [],
    total: 0,
    truncated: false,
    heuristics: {
      scanLimit: 200,
      resultLimit: 12,
      scoreThreshold: 20,
    },
    mode: 'bounded-sql',
    reason: null,
  },
  hotspots: {
    files: [
      {
        scopeType: 'file',
        key: 'backend/src/routes/memory.ts',
        label: 'backend/src/routes/memory.ts',
        memoryCount: 3,
        conflictCount: 1,
        supersededCount: 1,
        lastTouchedAt: '2026-06-02T10:00:00.000Z',
        sampleMemoryIds: [1, 2],
      },
    ],
    specs: [
      {
        scopeType: 'spec',
        key: 'spec-a',
        label: 'spec-a',
        memoryCount: 4,
        conflictCount: 1,
        supersededCount: 2,
        lastTouchedAt: '2026-06-02T10:00:00.000Z',
        sampleMemoryIds: [1, 2],
      },
    ],
    total: 2,
    truncated: false,
    ageAvailable: true,
    mode: 'bounded-sql',
    reason: null,
    windowSize: 400,
    resultLimit: 6,
  },
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
  sessionStorage.removeItem('rorca_memory_analytics_drilldown');
});

function mockPanelData(overrides?: {
  memoryList?: typeof MEMORY_LIST_RESPONSE;
  reviewData?: typeof MEMORY_REVIEW_RESPONSE;
  overviewGraph?: any;
  neighborhoodGraph?: any;
  relations?: typeof MEMORY_RELATIONS_RESPONSE;
}) {
  mockApiFetch.mockImplementation(async (path: string) => {
    if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
    if (path.startsWith('/api/memory/items?')) return overrides?.memoryList ?? MEMORY_LIST_RESPONSE;
    if (path.startsWith('/api/memory/review?')) return overrides?.reviewData ?? MEMORY_REVIEW_RESPONSE;
    if (path.startsWith('/api/memory/relations?')) return overrides?.relations ?? MEMORY_RELATIONS_RESPONSE;
    if (path.startsWith('/api/memory/graph/overview?')) return overrides?.overviewGraph ?? OVERVIEW_GRAPH_RESPONSE;
    if (path.startsWith('/api/memory/graph/neighborhood?')) return overrides?.neighborhoodGraph ?? NEIGHBORHOOD_GRAPH_RESPONSE;
    return {};
  });
}

describe('MemoryPanel', () => {
  it('applies analytics drill-down focus from ontology health without breaking ledger and graph workflows', async () => {
    mockPanelData();
    sessionStorage.setItem('rorca_memory_analytics_drilldown', JSON.stringify({
      source: 'ontology-health',
      workspaceId: 'ws-1',
      metric: 'conflicts',
      label: 'Active conflicts',
      description: 'Conflict drill-down from analytics.',
      memoryIds: [2],
      specIds: [],
      filePaths: [],
      createdAt: '2026-06-03T12:00:00.000Z',
    }));

    renderWithProviders(<MemoryPanel />);

    expect(await screen.findByText('Analytics drill-down: Active conflicts')).toBeTruthy();
    expect(screen.getByText('Conflict drill-down from analytics.')).toBeTruthy();
    const memoryList = screen.getByRole('list', { name: 'Memory entries' });
    expect(within(memoryList).getByText('Bound node and edge counts in the query layer.')).toBeTruthy();
    expect(within(memoryList).queryByText('Direction Stack layers cascade L1 → L5.')).toBeNull();
    await waitFor(() => {
      expect(screen.getByText('Centered on memory #2')).toBeTruthy();
    });
  });

  it('defaults to list mode and lets operators switch to graph and split views', async () => {
    const user = userEvent.setup();
    mockPanelData();

    renderWithProviders(<MemoryPanel />);

    await screen.findAllByText('Direction Stack layers cascade L1 → L5.');
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

    await screen.findAllByText('Direction Stack layers cascade L1 → L5.');
    await user.click(screen.getByRole('tab', { name: 'Split' }));

    expect(await screen.findByText('Centered on memory #1')).toBeTruthy();

    const memoryList = screen.getByRole('list', { name: 'Memory entries' });
    const secondEntry = within(memoryList).getByText('Bound node and edge counts in the query layer.').closest('li');
    expect(secondEntry).toBeTruthy();

    await user.click(screen.getByLabelText('Focus memory 2 from graph'));

    await waitFor(() => {
      expect(screen.getByText('Centered on memory #2')).toBeTruthy();
      expect(within(secondEntry as HTMLElement).getByText('Active node')).toBeTruthy();
    });

    const firstEntry = within(memoryList).getByText('Direction Stack layers cascade L1 → L5.').closest('li');
    expect(firstEntry).toBeTruthy();

    await user.click(within(memoryList).getByText('Direction Stack layers cascade L1 → L5.'));

    await waitFor(() => {
      expect(screen.getByText('Centered on memory #1')).toBeTruthy();
      expect(within(firstEntry as HTMLElement).getByText('Active node')).toBeTruthy();
    });
  });

  it('shows superseded ontology reasoning in the ledger and graph surfaces', async () => {
    const user = userEvent.setup();
    mockPanelData();

    renderWithProviders(<MemoryPanel />);

    await screen.findAllByText('Direction Stack layers cascade L1 → L5.');
    expect(screen.getAllByText('Superseded by memory #2').length).toBeGreaterThan(0);

    await user.click(screen.getByRole('tab', { name: 'Split' }));
    expect((await screen.findAllByText('Superseded by memory #2')).length).toBeGreaterThan(0);
    expect(screen.getByText('Active rule — supersedes memory #1')).toBeTruthy();
  });

  it('shows a graph empty state when filters remove the current corpus', async () => {
    const user = userEvent.setup();
    mockPanelData();

    renderWithProviders(<MemoryPanel />);

    await screen.findAllByText('Direction Stack layers cascade L1 → L5.');
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

    await screen.findAllByText('Direction Stack layers cascade L1 → L5.');
    await user.click(screen.getByRole('tab', { name: 'Graph' }));

    expect(await screen.findByText(/Apache AGE extension not available/)).toBeTruthy();
  });

  it('renders the stale review workflow with bounded hotspot summaries and explicit fallback messaging', async () => {
    mockPanelData({
      reviewData: {
        ...MEMORY_REVIEW_RESPONSE,
        staleCandidates: {
          ...MEMORY_REVIEW_RESPONSE.staleCandidates,
          ageAvailable: false,
          mode: 'bounded-sql-fallback',
          reason: 'Apache AGE extension is unavailable. Review candidates and hotspots are using direct SQL provenance and relation fallbacks only.',
        },
        hotspots: {
          ...MEMORY_REVIEW_RESPONSE.hotspots,
          ageAvailable: false,
          mode: 'bounded-sql-fallback',
          reason: 'Apache AGE extension is unavailable. Review candidates and hotspots are using direct SQL provenance and relation fallbacks only.',
        },
      },
    });

    renderWithProviders(<MemoryPanel />);

    expect(await screen.findByText('Stale memory review')).toBeTruthy();
    expect(screen.getByText(/Review queue is intentionally bounded to 120/)).toBeTruthy();
    expect(screen.getByText(/Provenance cleanup is separately bounded to 200/)).toBeTruthy();
    expect(screen.getAllByTitle(/Apache AGE extension is unavailable/).length).toBeGreaterThan(0);
    expect(screen.getByRole('list', { name: 'Hotspot files' })).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Hotspot specs' })).toBeTruthy();
    expect(screen.getByText('Archived memory for restore drills.')).toBeTruthy();
  });

  it('renders provenance cleanup separately when imported memories need anchoring', async () => {
    mockPanelData({
      reviewData: {
        ...MEMORY_REVIEW_RESPONSE,
        staleCandidates: {
          ...MEMORY_REVIEW_RESPONSE.staleCandidates,
          items: [],
          total: 0,
        },
        provenanceCandidates: {
          items: [
            {
              id: 9,
              workspaceId: 'ws-1',
              category: 'Decision',
              content: 'Imported memory needs source anchors.',
              sourceStoryId: null,
              sourceSpecId: null,
              sourceRunId: null,
              confidence: 'medium',
              relatedFiles: [],
              pinned: false,
              sourceType: 'import',
              source: 'import-batch',
              createdAt: '2026-06-02T10:00:00.000Z',
              updatedAt: '2026-06-03T10:00:00.000Z',
              deletedAt: null,
              staleScore: 50,
              reasons: [
                { code: 'import_requires_provenance_triage', label: 'Imported memory should be anchored to local provenance before long-term retention.' },
                { code: 'missing_file_provenance', label: 'No related file provenance is attached.' },
              ],
              status: 'candidate',
              lastAction: null,
            },
          ],
          total: 1,
          truncated: false,
          heuristics: {
            scanLimit: 200,
            resultLimit: 12,
            scoreThreshold: 20,
          },
          mode: 'bounded-sql',
          reason: null,
        },
        hotspots: {
          ...MEMORY_REVIEW_RESPONSE.hotspots,
          files: [],
          specs: [],
          total: 0,
        },
      },
    });

    renderWithProviders(<MemoryPanel />);

    expect(await screen.findByText('Provenance cleanup')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Provenance cleanup queue' })).toBeTruthy();
    expect(screen.getByText('Imported memory needs source anchors.')).toBeTruthy();
    expect(screen.getByText(/Imported memory should be anchored to local provenance/i)).toBeTruthy();
  });

  it('lets operators keep, revisit, archive, delete, and restore review candidates', async () => {
    const user = userEvent.setup();
    let reviewData = structuredClone(MEMORY_REVIEW_RESPONSE);

    mockApiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.startsWith('/api/memory/items?')) return MEMORY_LIST_RESPONSE;
      if (path.startsWith('/api/memory/review?')) return reviewData;
      if (path.startsWith('/api/memory/relations?')) return MEMORY_RELATIONS_RESPONSE;
      if (path.startsWith('/api/memory/graph/overview?')) return OVERVIEW_GRAPH_RESPONSE;
      if (path.startsWith('/api/memory/graph/neighborhood?')) return NEIGHBORHOOD_GRAPH_RESPONSE;
      if (path === '/api/memory/review/1/action' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        const item = reviewData.staleCandidates.items.find((candidate: any) => candidate.id === 1)!;
        item.lastAction = { action: body.action, at: '2026-06-03T10:00:00.000Z', previousStatus: item.status, nextStatus: body.action === 'archive' ? 'archived' : body.action === 'delete' ? 'deleted' : body.action === 'keep' ? 'kept' : 'revisit' };
        item.status = body.action === 'archive' ? 'archived' : body.action === 'delete' ? 'deleted' : body.action === 'keep' ? 'kept' : 'revisit';
        item.deletedAt = body.action === 'archive' || body.action === 'delete' ? '2026-06-03T10:00:00.000Z' : null;
        return { ok: true };
      }
      if (path === '/api/memory/review/3/action' && init?.method === 'POST') {
        reviewData.staleCandidates.items = reviewData.staleCandidates.items.map((candidate: any) => candidate.id === 3
          ? { ...candidate, status: 'candidate', deletedAt: null, lastAction: { action: 'restore', at: '2026-06-03T11:00:00.000Z', previousStatus: 'archived', nextStatus: 'candidate' } }
          : candidate);
        return { ok: true };
      }
      return {};
    });

    renderWithProviders(<MemoryPanel />);

    expect(await screen.findByText('Stale memory review')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Keep' }));
    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/memory/review/1/action', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ workspaceId: 'ws-1', action: 'keep' }),
      }));
    });

    await user.click(screen.getByRole('button', { name: 'Revisit' }));
    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/memory/review/1/action', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ workspaceId: 'ws-1', action: 'revisit' }),
      }));
    });

    await user.click(screen.getByRole('button', { name: 'Archive' }));
    expect((await screen.findAllByRole('button', { name: 'Restore' })).length).toBeGreaterThan(0);

    reviewData = {
      ...reviewData,
      staleCandidates: {
        ...reviewData.staleCandidates,
        items: reviewData.staleCandidates.items.map((candidate: any) => candidate.id === 1
          ? { ...candidate, status: 'candidate', deletedAt: null, lastAction: { action: 'restore', at: '2026-06-03T11:30:00.000Z', previousStatus: 'archived', nextStatus: 'candidate' } }
          : candidate),
      },
    };

    const recoverableList = screen.getByRole('list', { name: 'Recoverable memory decisions' });
    const archivedItem = within(recoverableList).getByText('Archived memory for restore drills.').closest('li') as HTMLElement;
    await user.click(within(archivedItem).getByRole('button', { name: 'Restore' }));
    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/memory/review/3/action', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ workspaceId: 'ws-1', action: 'restore' }),
      }));
    });

    const reviewQueue = screen.getByRole('list', { name: 'Stale memory review queue' });
    const candidateItem = within(reviewQueue).getByText('Direction Stack layers cascade L1 → L5.').closest('li') as HTMLElement;
    await user.click(within(candidateItem).getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/memory/review/1/action', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ workspaceId: 'ws-1', action: 'delete' }),
      }));
    });
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

    await screen.findAllByText('Direction Stack layers cascade L1 → L5.');
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
      if (path.startsWith('/api/memory/review?')) return MEMORY_REVIEW_RESPONSE;
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

    await screen.findAllByText('Direction Stack layers cascade L1 → L5.');
    await user.click(screen.getByRole('tab', { name: 'Graph' }));

    expect(await screen.findByText('Loading Knowledge Web')).toBeTruthy();

    resolveOverview(OVERVIEW_GRAPH_RESPONSE);

    expect(await screen.findByText('Blast radius')).toBeTruthy();
  });

  it('shows an explicit unavailable ontology state when relation reasons cannot be loaded', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.startsWith('/api/memory/items?')) return MEMORY_LIST_RESPONSE;
      if (path.startsWith('/api/memory/review?')) return MEMORY_REVIEW_RESPONSE;
      if (path.startsWith('/api/memory/relations?')) throw new Error('Ontology relation fetch failed');
      if (path.startsWith('/api/memory/graph/overview?')) return OVERVIEW_GRAPH_RESPONSE;
      if (path.startsWith('/api/memory/graph/neighborhood?')) return NEIGHBORHOOD_GRAPH_RESPONSE;
      return {};
    });

    renderWithProviders(<MemoryPanel />);

    await waitFor(() => expect(screen.getAllByTitle(/Ontology relation fetch failed/).length).toBeGreaterThan(0));
  });

  it('shows a distinct unavailable state when the overview request fails', async () => {
    const user = userEvent.setup();

    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.startsWith('/api/memory/items?')) return MEMORY_LIST_RESPONSE;
      if (path.startsWith('/api/memory/review?')) return MEMORY_REVIEW_RESPONSE;
      if (path.startsWith('/api/memory/relations?')) return MEMORY_RELATIONS_RESPONSE;
      if (path.startsWith('/api/memory/graph/overview?')) throw new Error('Overview request failed');
      if (path.startsWith('/api/memory/graph/neighborhood?')) return NEIGHBORHOOD_GRAPH_RESPONSE;
      return {};
    });

    renderWithProviders(<MemoryPanel />);

    await screen.findAllByText('Direction Stack layers cascade L1 → L5.');
    await user.click(screen.getByRole('tab', { name: 'Graph' }));

    expect(await screen.findByText('Unavailable')).toBeTruthy();
    expect(screen.getAllByText('Overview request failed').length).toBeGreaterThan(0);
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
      if (path.startsWith('/api/memory/review?')) return MEMORY_REVIEW_RESPONSE;
      if (path.startsWith('/api/memory/relations?')) return MEMORY_RELATIONS_RESPONSE;
      if (path.startsWith('/api/memory/graph/overview?')) return OVERVIEW_GRAPH_RESPONSE;
      if (path.startsWith('/api/memory/graph/neighborhood?')) return NEIGHBORHOOD_GRAPH_RESPONSE;
      if (path === '/api/memory/items/1' && init?.method === 'PATCH') return {};
      if (path === '/api/memory/items/1' && init?.method === 'DELETE') return {};
      return {};
    });

    renderWithProviders(<MemoryPanel />);

    await screen.findAllByText('Direction Stack layers cascade L1 → L5.');
    await user.click(screen.getByRole('tab', { name: 'Split' }));
    await user.click(screen.getByLabelText('Focus memory 2 from graph'));

    await waitFor(() => {
      expect(screen.getByText('Centered on memory #2')).toBeTruthy();
    });

    const memoryList = screen.getByRole('list', { name: 'Memory entries' });
    const search = screen.getByLabelText('Search memories');
    await user.type(search, 'Bound node');
    await waitFor(() => {
      expect(within(memoryList).queryByText('Direction Stack layers cascade L1 → L5.')).toBeNull();
    });

    await user.clear(search);
    await waitFor(() => {
      expect(within(memoryList).getByText('Direction Stack layers cascade L1 → L5.')).toBeTruthy();
    });

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
      if (path.startsWith('/api/memory/review?')) return MEMORY_REVIEW_RESPONSE;
      if (path.startsWith('/api/memory/relations?')) return { items: relationItems, total: relationItems.length };
      if (path === '/api/memory/relations' && init?.method === 'POST') {
        relationItems = [{ id: 92, relationType: 'CONFLICTS_WITH', status: 'active', sourceMemoryId: 1, targetMemoryId: 2 }];
        return { relation: relationItems[0] };
      }
      return {};
    });

    renderWithProviders(<MemoryPanel />);

    await screen.findAllByText('Direction Stack layers cascade L1 → L5.');
    await user.click(screen.getAllByRole('button', { name: 'Curate' })[0]);
    expect(await screen.findByText('No active supersession or conflict edges recorded for this memory yet.')).toBeTruthy();

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

    await screen.findAllByText('Direction Stack layers cascade L1 → L5.');
    await user.click(screen.getAllByRole('button', { name: 'Curate' })[0]);
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
      if (path.startsWith('/api/memory/review?')) return MEMORY_REVIEW_RESPONSE;
      if (path.startsWith('/api/memory/relations?')) return { items: relationItems, total: relationItems.length };
      if (path === '/api/memory/relations/91' && init?.method === 'DELETE') {
        relationItems = [];
        return {};
      }
      return {};
    });

    renderWithProviders(<MemoryPanel />);

    await screen.findAllByText('Direction Stack layers cascade L1 → L5.');
    expect((await screen.findAllByText(/supersedes memory #2/i)).length).toBeGreaterThan(0);
    await user.click(screen.getAllByRole('button', { name: 'Curate' })[0]);

    await user.click(await screen.findByRole('button', { name: 'Remove' }));

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

  // ─── SMG-005: Spec-centric relevance graph in Memory Ledger split view ─────

  const SPEC_RELEVANCE_GRAPH_RESPONSE = {
    available: true,
    hub: { id: 'hub:spec-a', type: 'hub', ring: 0, label: 'spec-a', entityId: 'spec-a' },
    nodes: [
      { id: 'hub:spec-a', type: 'hub', ring: 0, label: 'spec-a', entityId: 'spec-a' },
      { id: 'memory:1', type: 'memory', ring: 2, label: 'Memory #1', entityId: '1', category: 'Architecture', relevanceScore: 0.85, selected: true },
      { id: 'file:memory.ts', type: 'file', ring: 1, label: 'memory.ts', entityId: 'backend/src/routes/memory.ts', path: 'backend/src/routes/memory.ts' },
    ],
    edges: [
      { id: 'e1', source: 'hub:spec-a', target: 'file:memory.ts', relation: 'routed_to', scoreContribution: null, evidence: null, visualHints: { thickness: 2, dashed: false, opacity: 1 } },
      { id: 'e2', source: 'file:memory.ts', target: 'memory:1', relation: 'selected_memory', scoreContribution: 0.85, evidence: null, visualHints: { thickness: 1.5, dashed: false, opacity: 0.8 } },
    ],
    scoreLegend: [{ field: 'semantic', label: 'Semantic', description: 'Embedding similarity' }],
    summary: { hubLabel: 'spec-a', nodeCount: 3, edgeCount: 2, selectedCount: 1, droppedCount: 0, avgRelevanceScore: 0.85 },
    caps: { maxFiles: 20, maxMemories: 30, maxEdges: 80 },
    truncation: { filesTruncated: false, memoriesTruncated: false, edgesTruncated: false, totalCandidates: 1, returnedCandidates: 1 },
    fallback: { ageAvailable: true, telemetryAvailable: true, graphPathsAvailable: true, missingReasons: [] },
  };

  function mockPanelDataWithSpecGraph(overrides?: {
    specRelevanceGraph?: any;
  }) {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.startsWith('/api/memory/items?')) return MEMORY_LIST_RESPONSE;
      if (path.startsWith('/api/memory/review?')) return MEMORY_REVIEW_RESPONSE;
      if (path.startsWith('/api/memory/relations?')) return MEMORY_RELATIONS_RESPONSE;
      if (path.startsWith('/api/memory/graph/overview?')) return OVERVIEW_GRAPH_RESPONSE;
      if (path.startsWith('/api/memory/graph/neighborhood?')) return NEIGHBORHOOD_GRAPH_RESPONSE;
      if (path.startsWith('/api/spec-relevance-graph/by-spec/')) return overrides?.specRelevanceGraph ?? SPEC_RELEVANCE_GRAPH_RESPONSE;
      return {};
    });
  }

  it('shows a spec context selector in split view when memory items have spec sources', async () => {
    const user = userEvent.setup();
    mockPanelDataWithSpecGraph();

    renderWithProviders(<MemoryPanel />);

    await screen.findAllByText('Direction Stack layers cascade L1 → L5.');
    await user.click(screen.getByRole('tab', { name: 'Split' }));

    expect(await screen.findByTestId('spec-context-selector')).toBeTruthy();
    expect(screen.getByLabelText('Select spec context for relevance graph')).toBeTruthy();
  });

  it('renders the spec-centric relevance graph in the right pane when a spec context is selected', async () => {
    const user = userEvent.setup();
    mockPanelDataWithSpecGraph();

    renderWithProviders(<MemoryPanel />);

    await screen.findAllByText('Direction Stack layers cascade L1 → L5.');
    await user.click(screen.getByRole('tab', { name: 'Split' }));

    const selector = screen.getByLabelText('Select spec context for relevance graph');
    await user.selectOptions(selector, 'spec-a');

    expect(await screen.findByTestId('spec-context-mode-indicator')).toBeTruthy();
    expect(screen.getByTestId('spec-relevance-graph-pane')).toBeTruthy();
    expect(screen.getAllByText(/Spec Relevance Graph/i).length).toBeGreaterThan(0);
    expect(mockApiFetch).toHaveBeenCalledWith(expect.stringContaining('/api/spec-relevance-graph/by-spec/spec-a?workspaceId='));
  });

  it('switches back to memory neighborhood when spec context is cleared', async () => {
    const user = userEvent.setup();
    mockPanelDataWithSpecGraph();

    renderWithProviders(<MemoryPanel />);

    await screen.findAllByText('Direction Stack layers cascade L1 → L5.');
    await user.click(screen.getByRole('tab', { name: 'Split' }));

    const selector = screen.getByLabelText('Select spec context for relevance graph');
    await user.selectOptions(selector, 'spec-a');

    expect(await screen.findByTestId('spec-relevance-graph-pane')).toBeTruthy();

    await user.selectOptions(selector, '');

    await waitFor(() => {
      expect(screen.queryByTestId('spec-relevance-graph-pane')).toBeNull();
      expect(screen.queryByTestId('spec-context-mode-indicator')).toBeNull();
    });

    expect(screen.getByText('Knowledge Web')).toBeTruthy();
  });

  it('shows empty state when the spec relevance graph has no data', async () => {
    const user = userEvent.setup();
    mockPanelDataWithSpecGraph({
      specRelevanceGraph: {
        ...SPEC_RELEVANCE_GRAPH_RESPONSE,
        available: false,
        nodes: [],
        edges: [],
        summary: { ...SPEC_RELEVANCE_GRAPH_RESPONSE.summary, nodeCount: 0, edgeCount: 0 },
        fallback: { ...SPEC_RELEVANCE_GRAPH_RESPONSE.fallback, missingReasons: ['No retrieval telemetry found'] },
      },
    });

    renderWithProviders(<MemoryPanel />);

    await screen.findAllByText('Direction Stack layers cascade L1 → L5.');
    await user.click(screen.getByRole('tab', { name: 'Split' }));

    const selector = screen.getByLabelText('Select spec context for relevance graph');
    await user.selectOptions(selector, 'spec-a');

    expect(await screen.findByTestId('spec-relevance-graph-pane')).toBeTruthy();
    await waitFor(() => {
      const pane = screen.getByTestId('spec-relevance-graph-pane');
      expect(pane.querySelector('[data-testid="srg-state-unavailable"], [data-testid="srg-state-empty"]')).toBeTruthy();
    });
  });

  it('preserves existing memory curation behavior when spec context selector is present', async () => {
    const user = userEvent.setup();
    mockPanelDataWithSpecGraph();

    renderWithProviders(<MemoryPanel />);

    await screen.findAllByText('Direction Stack layers cascade L1 → L5.');
    await user.click(screen.getByRole('tab', { name: 'Split' }));

    // Memory curation still works
    expect(screen.getByText('Centered on memory #1')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Curate' }).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Superseded by memory #2').length).toBeGreaterThan(0);
  });

  it('does not show spec context selector when no items have spec sources', async () => {
    const user = userEvent.setup();
    mockPanelData({
      memoryList: {
        ...MEMORY_LIST_RESPONSE,
        items: MEMORY_LIST_RESPONSE.items.map((item) => ({ ...item, sourceSpecId: null as any, sourceStoryId: null as any })),
      },
    });

    renderWithProviders(<MemoryPanel />);

    await screen.findAllByText('Direction Stack layers cascade L1 → L5.');
    await user.click(screen.getByRole('tab', { name: 'Split' }));

    await waitFor(() => {
      expect(screen.queryByTestId('spec-context-selector')).toBeNull();
    });
  });
});
