/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../test/helpers';
import PreFlightGraph from '../PreFlightGraph';
import type { SpecRelevanceGraphResponse } from '../../types/spec-relevance-graph';

// ─── Mock useSpecRelevanceGraph ──────────────────────────────────────────────

const mockRefetch = vi.fn();

let mockGraphReturn: {
  status: import('../../types/spec-relevance-graph').GraphLoadingState;
  data: SpecRelevanceGraphResponse | null;
  error: string | null;
  refetch: Mock;
};

vi.mock('../../hooks/useSpecRelevanceGraph', () => ({
  useSpecRelevanceGraph: () => mockGraphReturn,
}));

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeGraphResponse(
  overrides: Partial<SpecRelevanceGraphResponse> = {},
): SpecRelevanceGraphResponse {
  return {
    available: true,
    hub: {
      id: 'hub:ws::test-spec',
      type: 'hub',
      ring: 0,
      label: 'Spec: test-spec',
      entityId: 'test-spec',
    },
    nodes: [
      {
        id: 'hub:ws::test-spec',
        type: 'hub',
        ring: 0,
        label: 'Spec: test-spec',
        entityId: 'test-spec',
      },
      {
        id: 'file:ws::src/app.ts',
        type: 'file',
        ring: 1,
        label: 'app.ts',
        entityId: 'src/app.ts',
        path: 'src/app.ts',
      },
      {
        id: 'memory:ws::mem-1',
        type: 'memory',
        ring: 2,
        label: 'Memory: mem-1',
        entityId: 'mem-1',
        selected: true,
        enteredPrompt: true,
        relevanceScore: 0.9,
        category: 'Architecture',
      },
      {
        id: 'memory:ws::mem-2',
        type: 'memory',
        ring: 2,
        label: 'Memory: mem-2',
        entityId: 'mem-2',
        dropped: true,
        relevanceScore: 0.2,
        category: 'Bug Fix',
      },
    ],
    edges: [
      {
        id: 'edge:routed_to:hub->file1',
        source: 'hub:ws::test-spec',
        target: 'file:ws::src/app.ts',
        relation: 'routed_to',
        scoreContribution: null,
        evidence: null,
        visualHints: { thickness: 2, dashed: false, opacity: 0.8 },
      },
      {
        id: 'edge:selected:hub->mem1',
        source: 'hub:ws::test-spec',
        target: 'memory:ws::mem-1',
        relation: 'selected_memory',
        scoreContribution: 0.9,
        evidence: 'Score: 0.900',
        visualHints: { thickness: 2, dashed: false, opacity: 0.8 },
      },
      {
        id: 'edge:dropped:hub->mem2',
        source: 'hub:ws::test-spec',
        target: 'memory:ws::mem-2',
        relation: 'dropped_memory',
        scoreContribution: 0.2,
        evidence: 'Score: 0.200',
        visualHints: { thickness: 1, dashed: true, opacity: 0.4 },
      },
    ],
    scoreLegend: [
      { field: 'semantic', label: 'Semantic', description: 'Embedding similarity' },
    ],
    summary: {
      hubLabel: 'Spec: test-spec',
      nodeCount: 4,
      edgeCount: 3,
      selectedCount: 1,
      droppedCount: 1,
      avgRelevanceScore: 0.55,
    },
    caps: { maxFiles: 20, maxMemories: 30, maxEdges: 80 },
    truncation: {
      filesTruncated: false,
      memoriesTruncated: false,
      edgesTruncated: false,
      totalCandidates: 2,
      returnedCandidates: 2,
    },
    fallback: {
      ageAvailable: false,
      telemetryAvailable: true,
      graphPathsAvailable: false,
      missingReasons: [],
    },
    ...overrides,
  };
}

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockRefetch.mockClear();
  // Default: empty state (not yet expanded)
  mockGraphReturn = {
    status: 'empty',
    data: null,
    error: null,
    refetch: mockRefetch,
  };
});

// ─── Rendering tests ─────────────────────────────────────────────────────────

describe('PreFlightGraph', () => {
  it('renders collapsed by default with toggle button', () => {
    renderWithProviders(
      <PreFlightGraph specSlug="test-spec" workspaceId="ws-1" />,
    );
    const toggle = screen.getByTestId('preflight-toggle');
    expect(toggle).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('Context Neighborhood')).toBeInTheDocument();
  });

  it('expands on click to show graph view area', () => {
    renderWithProviders(
      <PreFlightGraph specSlug="test-spec" workspaceId="ws-1" />,
    );
    const toggle = screen.getByTestId('preflight-toggle');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('preflight-graph-view')).toBeInTheDocument();
  });

  it('collapses on second click', () => {
    renderWithProviders(
      <PreFlightGraph specSlug="test-spec" workspaceId="ws-1" />,
    );
    const toggle = screen.getByTestId('preflight-toggle');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('preflight-graph-view')).not.toBeInTheDocument();
  });
});

// ─── Health summary tests ────────────────────────────────────────────────────

describe('PreFlightGraph — health summary', () => {
  it('shows health indicators for a ready graph', () => {
    mockGraphReturn = {
      status: 'ready',
      data: makeGraphResponse(),
      error: null,
      refetch: mockRefetch,
    };

    renderWithProviders(
      <PreFlightGraph specSlug="test-spec" workspaceId="ws-1" />,
    );
    // Expand
    fireEvent.click(screen.getByTestId('preflight-toggle'));
    const healthBar = screen.getByTestId('preflight-health-bar');
    expect(healthBar).toBeInTheDocument();
    expect(healthBar.textContent).toContain('Selected');
    expect(healthBar.textContent).toContain('1');
    expect(healthBar.textContent).toContain('Dropped');
    expect(healthBar.textContent).toContain('55%');
  });

  it('shows truncation info when candidates are capped', () => {
    mockGraphReturn = {
      status: 'ready',
      data: makeGraphResponse({
        truncation: {
          filesTruncated: true,
          memoriesTruncated: true,
          edgesTruncated: false,
          totalCandidates: 100,
          returnedCandidates: 30,
        },
      }),
      error: null,
      refetch: mockRefetch,
    };

    renderWithProviders(
      <PreFlightGraph specSlug="test-spec" workspaceId="ws-1" />,
    );
    fireEvent.click(screen.getByTestId('preflight-toggle'));
    const healthBar = screen.getByTestId('preflight-health-bar');
    expect(healthBar.textContent).toContain('30/100');
  });

  it('shows unavailable indicators when graph is not available', () => {
    mockGraphReturn = {
      status: 'unavailable',
      data: makeGraphResponse({
        available: false,
        fallback: {
          ageAvailable: false,
          telemetryAvailable: false,
          graphPathsAvailable: false,
          missingReasons: ['No telemetry'],
        },
      }),
      error: null,
      refetch: mockRefetch,
    };

    renderWithProviders(
      <PreFlightGraph specSlug="test-spec" workspaceId="ws-1" />,
    );
    fireEvent.click(screen.getByTestId('preflight-toggle'));
    const health = screen.getByTestId('preflight-health-bar');
    expect(health.textContent).toContain('unavailable');
    expect(health.textContent).toContain('Telemetry');
  });
});

// ─── Empty / unavailable state tests ─────────────────────────────────────────

describe('PreFlightGraph — empty/unavailable states', () => {
  it('renders graph-empty state when no data', () => {
    mockGraphReturn = {
      status: 'empty',
      data: null,
      error: null,
      refetch: mockRefetch,
    };

    renderWithProviders(
      <PreFlightGraph specSlug="test-spec" workspaceId="ws-1" />,
    );
    fireEvent.click(screen.getByTestId('preflight-toggle'));
    // RelevanceGraphView renders empty state
    expect(screen.getByTestId('graph-empty')).toBeInTheDocument();
  });

  it('renders loading state', () => {
    mockGraphReturn = {
      status: 'loading',
      data: null,
      error: null,
      refetch: mockRefetch,
    };

    renderWithProviders(
      <PreFlightGraph specSlug="test-spec" workspaceId="ws-1" />,
    );
    fireEvent.click(screen.getByTestId('preflight-toggle'));
    expect(screen.getByTestId('graph-loading')).toBeInTheDocument();
  });

  it('renders error state', () => {
    mockGraphReturn = {
      status: 'error',
      data: null,
      error: 'Network failure',
      refetch: mockRefetch,
    };

    renderWithProviders(
      <PreFlightGraph specSlug="test-spec" workspaceId="ws-1" />,
    );
    fireEvent.click(screen.getByTestId('preflight-toggle'));
    expect(screen.getByTestId('graph-error')).toBeInTheDocument();
  });
});

// ─── Node action tests ───────────────────────────────────────────────────────

describe('PreFlightGraph — node actions', () => {
  it('shows action bar when a node is clicked', () => {
    mockGraphReturn = {
      status: 'ready',
      data: makeGraphResponse(),
      error: null,
      refetch: mockRefetch,
    };

    renderWithProviders(
      <PreFlightGraph specSlug="test-spec" workspaceId="ws-1" />,
    );
    fireEvent.click(screen.getByTestId('preflight-toggle'));

    // Click on a memory node in the graph
    const memNode = screen.getByTestId('graph-node-memory:ws::mem-1');
    fireEvent.click(memNode);

    expect(screen.getByTestId('preflight-node-actions')).toBeInTheDocument();
    expect(screen.getByTestId('preflight-action-copy')).toBeInTheDocument();
    expect(screen.getByTestId('preflight-action-ledger')).toBeInTheDocument();
  });

  it('copies entity ID on copy action click', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText },
    });

    mockGraphReturn = {
      status: 'ready',
      data: makeGraphResponse(),
      error: null,
      refetch: mockRefetch,
    };

    renderWithProviders(
      <PreFlightGraph specSlug="test-spec" workspaceId="ws-1" />,
    );
    fireEvent.click(screen.getByTestId('preflight-toggle'));
    fireEvent.click(screen.getByTestId('graph-node-memory:ws::mem-1'));
    fireEvent.click(screen.getByTestId('preflight-action-copy'));

    expect(writeText).toHaveBeenCalledWith('mem-1');
  });

  it('calls onNavigate with memory panel on ledger action', () => {
    const onNavigate = vi.fn();

    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });

    mockGraphReturn = {
      status: 'ready',
      data: makeGraphResponse(),
      error: null,
      refetch: mockRefetch,
    };

    renderWithProviders(
      <PreFlightGraph specSlug="test-spec" workspaceId="ws-1" onNavigate={onNavigate} />,
    );
    fireEvent.click(screen.getByTestId('preflight-toggle'));
    fireEvent.click(screen.getByTestId('graph-node-memory:ws::mem-1'));
    fireEvent.click(screen.getByTestId('preflight-action-ledger'));

    expect(onNavigate).toHaveBeenCalledWith('memory');
  });

  it('deselects node on second click', () => {
    mockGraphReturn = {
      status: 'ready',
      data: makeGraphResponse(),
      error: null,
      refetch: mockRefetch,
    };

    renderWithProviders(
      <PreFlightGraph specSlug="test-spec" workspaceId="ws-1" />,
    );
    fireEvent.click(screen.getByTestId('preflight-toggle'));
    fireEvent.click(screen.getByTestId('graph-node-memory:ws::mem-1'));
    expect(screen.getByTestId('preflight-node-actions')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('graph-node-memory:ws::mem-1'));
    expect(screen.queryByTestId('preflight-node-actions')).not.toBeInTheDocument();
  });

  it('does not show ledger action for file nodes', () => {
    mockGraphReturn = {
      status: 'ready',
      data: makeGraphResponse(),
      error: null,
      refetch: mockRefetch,
    };

    renderWithProviders(
      <PreFlightGraph specSlug="test-spec" workspaceId="ws-1" />,
    );
    fireEvent.click(screen.getByTestId('preflight-toggle'));
    fireEvent.click(screen.getByTestId('graph-node-file:ws::src/app.ts'));

    expect(screen.getByTestId('preflight-node-actions')).toBeInTheDocument();
    expect(screen.getByTestId('preflight-action-copy')).toBeInTheDocument();
    expect(screen.queryByTestId('preflight-action-ledger')).not.toBeInTheDocument();
  });
});

// ─── Trigger controls preservation test ──────────────────────────────────────

describe('PreFlightGraph — does not break trigger flow', () => {
  it('renders without errors alongside other components', () => {
    mockGraphReturn = {
      status: 'empty',
      data: null,
      error: null,
      refetch: mockRefetch,
    };

    // Just verify it renders without throwing
    const { container } = renderWithProviders(
      <PreFlightGraph specSlug="test-spec" workspaceId="ws-1" />,
    );
    expect(container.querySelector('[data-testid="preflight-graph"]')).toBeInTheDocument();
  });
});
