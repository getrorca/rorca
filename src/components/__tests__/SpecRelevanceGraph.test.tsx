/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../../test/helpers';
import SpecRelevanceGraph from '../SpecRelevanceGraph';
import { computeRadialLayout, scoreToRadius, RING_1_RADIUS, RING_2_MIN_RADIUS, RING_2_MAX_RADIUS } from '../../lib/radial-layout';
import {
  classifyNodeBadge,
  nodeVisualState,
  edgeCssClass,
  edgeAriaLabel,
  truncationWarnings,
  deriveGraphState,
  formatScoreBreakdown,
  badgeLabel,
} from '../../lib/relevance-visual';
import type {
  RelevanceNode,
  RelevanceEdge,
  SpecRelevanceGraphResponse,
  RelevanceGraphTruncation,
  RelevanceScoreBreakdown,
} from '../../types/spec-relevance-graph';

// ─── Fixtures ───────────────────────────────────────────────────────────────

function makeHub(overrides: Partial<RelevanceNode> = {}): RelevanceNode {
  return {
    id: 'hub:ws::test-spec',
    type: 'hub',
    ring: 0,
    label: 'Spec: test-spec',
    entityId: 'test-spec',
    ...overrides,
  };
}

function makeFileNode(path: string, overrides: Partial<RelevanceNode> = {}): RelevanceNode {
  return {
    id: `file:ws::${path}`,
    type: 'file',
    ring: 1,
    label: path.split('/').pop() ?? path,
    entityId: path,
    path,
    ...overrides,
  };
}

function makeMemoryNode(
  key: string,
  opts: { selected?: boolean; dropped?: boolean; enteredPrompt?: boolean; score?: number } = {},
): RelevanceNode {
  return {
    id: `memory:ws::${key}`,
    type: 'memory',
    ring: 2,
    label: `Memory: ${key}`,
    entityId: key,
    selected: opts.selected ?? false,
    dropped: opts.dropped ?? false,
    enteredPrompt: opts.enteredPrompt ?? false,
    relevanceScore: opts.score ?? 0.5,
    category: 'Architecture',
    scoreBreakdown: {
      semantic: 0.8,
      graph: null,
      recency: 0.6,
      skill: 0.4,
      arbiter: 0.7,
      keyword: 0.3,
    },
  };
}

function makeEdge(
  source: string,
  target: string,
  relation: RelevanceEdge['relation'] = 'selected_memory',
  score: number | null = 0.5,
): RelevanceEdge {
  return {
    id: `edge:${relation}:${source}->${target}`,
    source,
    target,
    relation,
    scoreContribution: score,
    evidence: `Score: ${score?.toFixed(3) ?? 'n/a'}`,
    visualHints: {
      thickness: relation === 'dropped_memory' ? 1 : 2,
      dashed: relation === 'dropped_memory' || relation === 'graph_path',
      opacity: relation === 'dropped_memory' ? 0.4 : 0.8,
    },
  };
}

function makeGraphResponse(
  overrides: Partial<SpecRelevanceGraphResponse> = {},
): SpecRelevanceGraphResponse {
  const hub = makeHub();
  const file1 = makeFileNode('src/app.ts');
  const file2 = makeFileNode('src/lib/utils.ts');
  const mem1 = makeMemoryNode('mem-1', { selected: true, enteredPrompt: true, score: 0.9 });
  const mem2 = makeMemoryNode('mem-2', { selected: true, score: 0.6 });
  const mem3 = makeMemoryNode('mem-3', { dropped: true, score: 0.2 });

  const nodes = [hub, file1, file2, mem1, mem2, mem3];
  const edges = [
    makeEdge(hub.id, file1.id, 'routed_to', null),
    makeEdge(hub.id, file2.id, 'routed_to', null),
    makeEdge(hub.id, mem1.id, 'selected_memory', 0.9),
    makeEdge(hub.id, mem2.id, 'selected_memory', 0.6),
    makeEdge(hub.id, mem3.id, 'dropped_memory', 0.2),
  ];

  return {
    available: true,
    runtime: {
      graphMode: 'lite',
      provider: 'semantic',
      ageAvailable: false,
      hint: 'Install Apache AGE on the current Postgres instance or switch to `rorca db start` for the full graph stack.',
      message: 'Graph Lite active. Relevance graph uses semantic and telemetry evidence without AGE graph paths.',
    },
    hub,
    nodes,
    edges,
    scoreLegend: [
      { field: 'semantic', label: 'Semantic / Vector', description: 'Embedding similarity' },
      { field: 'graph', label: 'Graph / Path', description: 'AGE graph proximity' },
      { field: 'recency', label: 'Recency', description: 'How recently created' },
      { field: 'skill', label: 'Skill Alignment', description: 'Skill match' },
      { field: 'arbiter', label: 'Arbiter / Selection', description: 'Final arbiter weight' },
      { field: 'keyword', label: 'Keyword', description: 'Keyword overlap' },
    ],
    summary: {
      hubLabel: 'Spec: test-spec',
      nodeCount: nodes.length,
      edgeCount: edges.length,
      selectedCount: 2,
      droppedCount: 1,
      avgRelevanceScore: 0.567,
    },
    caps: { maxFiles: 20, maxMemories: 30, maxEdges: 80 },
    truncation: {
      filesTruncated: false,
      memoriesTruncated: false,
      edgesTruncated: false,
      totalCandidates: 3,
      returnedCandidates: 3,
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

// ─── Layout tests ───────────────────────────────────────────────────────────

describe('computeRadialLayout', () => {
  it('places hub at center (0, 0)', () => {
    const hub = makeHub();
    const result = computeRadialLayout([hub], []);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].cx).toBe(0);
    expect(result.nodes[0].cy).toBe(0);
    expect(result.nodes[0].radius).toBe(0);
  });

  it('places ring-1 (file) nodes at RING_1_RADIUS', () => {
    const nodes = [
      makeHub(),
      makeFileNode('a.ts'),
      makeFileNode('b.ts'),
    ];
    const result = computeRadialLayout(nodes, []);
    const fileNodes = result.nodes.filter((n) => n.ring === 1);
    expect(fileNodes).toHaveLength(2);
    for (const fn of fileNodes) {
      expect(fn.radius).toBe(RING_1_RADIUS);
      const dist = Math.sqrt(fn.cx ** 2 + fn.cy ** 2);
      expect(dist).toBeCloseTo(RING_1_RADIUS, 5);
    }
  });

  it('places ring-2 nodes with radius inversely proportional to score', () => {
    const highScore = makeMemoryNode('high', { score: 1.0, selected: true });
    const lowScore = makeMemoryNode('low', { score: 0.0, dropped: true });
    const nodes = [makeHub(), highScore, lowScore];
    const result = computeRadialLayout(nodes, []);
    const ring2 = result.nodes.filter((n) => n.ring === 2);
    const high = ring2.find((n) => n.entityId === 'high')!;
    const low = ring2.find((n) => n.entityId === 'low')!;
    expect(high.radius).toBe(RING_2_MIN_RADIUS);
    expect(low.radius).toBe(RING_2_MAX_RADIUS);
    expect(high.radius).toBeLessThan(low.radius);
  });

  it('produces deterministic output for shuffled inputs', () => {
    const nodesA = [
      makeHub(),
      makeFileNode('z.ts'),
      makeFileNode('a.ts'),
      makeMemoryNode('mem-z', { score: 0.3 }),
      makeMemoryNode('mem-a', { score: 0.7 }),
    ];
    const nodesB = [
      makeHub(),
      makeFileNode('a.ts'),
      makeMemoryNode('mem-a', { score: 0.7 }),
      makeFileNode('z.ts'),
      makeMemoryNode('mem-z', { score: 0.3 }),
    ];

    const resultA = computeRadialLayout(nodesA, []);
    const resultB = computeRadialLayout(nodesB, []);

    for (const nodeA of resultA.nodes) {
      const nodeB = resultB.nodes.find((n) => n.id === nodeA.id)!;
      expect(nodeA.cx).toBeCloseTo(nodeB.cx, 5);
      expect(nodeA.cy).toBeCloseTo(nodeB.cy, 5);
    }
  });

  it('resolves edge positions from node positions', () => {
    const hub = makeHub();
    const file = makeFileNode('app.ts');
    const edge = makeEdge(hub.id, file.id, 'routed_to');
    const result = computeRadialLayout([hub, file], [edge]);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].x1).toBe(0);
    expect(result.edges[0].y1).toBe(0);
    expect(result.edges[0].x2).not.toBe(0);
  });

  it('computes a viewBox that contains all nodes', () => {
    const nodes = [
      makeHub(),
      makeFileNode('a.ts'),
      makeMemoryNode('m1', { score: 0.1 }),
    ];
    const result = computeRadialLayout(nodes, []);
    for (const node of result.nodes) {
      expect(node.cx).toBeGreaterThanOrEqual(result.viewBox.x);
      expect(node.cy).toBeGreaterThanOrEqual(result.viewBox.y);
      expect(node.cx).toBeLessThanOrEqual(result.viewBox.x + result.viewBox.width);
      expect(node.cy).toBeLessThanOrEqual(result.viewBox.y + result.viewBox.height);
    }
  });
});

describe('scoreToRadius', () => {
  it('maps score 1.0 to RING_2_MIN_RADIUS', () => {
    expect(scoreToRadius(1.0)).toBe(RING_2_MIN_RADIUS);
  });

  it('maps score 0.0 to RING_2_MAX_RADIUS', () => {
    expect(scoreToRadius(0.0)).toBe(RING_2_MAX_RADIUS);
  });

  it('maps score 0.5 to midpoint', () => {
    const mid = (RING_2_MIN_RADIUS + RING_2_MAX_RADIUS) / 2;
    expect(scoreToRadius(0.5)).toBeCloseTo(mid, 5);
  });

  it('clamps out-of-range values', () => {
    expect(scoreToRadius(2.0)).toBe(RING_2_MIN_RADIUS);
    expect(scoreToRadius(-1.0)).toBe(RING_2_MAX_RADIUS);
  });
});

// ─── Visual classification tests ────────────────────────────────────────────

describe('classifyNodeBadge', () => {
  it('returns "enteredPrompt" for memory nodes that entered the prompt', () => {
    const node = makeMemoryNode('x', { enteredPrompt: true, selected: true });
    expect(classifyNodeBadge(node)).toBe('enteredPrompt');
  });

  it('returns "selected" for selected nodes that did not enter prompt', () => {
    const node = makeMemoryNode('x', { selected: true });
    expect(classifyNodeBadge(node)).toBe('selected');
  });

  it('returns "dropped" for dropped nodes', () => {
    const node = makeMemoryNode('x', { dropped: true });
    expect(classifyNodeBadge(node)).toBe('dropped');
  });

  it('returns "unknown" for hub and file nodes', () => {
    expect(classifyNodeBadge(makeHub())).toBe('unknown');
    expect(classifyNodeBadge(makeFileNode('x.ts'))).toBe('unknown');
  });
});

describe('nodeVisualState', () => {
  it('produces correct CSS class for entered-prompt memory', () => {
    const vs = nodeVisualState(makeMemoryNode('x', { enteredPrompt: true }));
    expect(vs.cssClass).toContain('srg-node--memory');
    expect(vs.cssClass).toContain('srg-node--entered-prompt');
  });

  it('produces correct CSS class for hub', () => {
    const vs = nodeVisualState(makeHub());
    expect(vs.cssClass).toContain('srg-node--hub');
  });

  it('generates an aria-label with node type and label', () => {
    const vs = nodeVisualState(makeMemoryNode('x', { selected: true, score: 0.75 }));
    expect(vs.ariaLabel).toContain('Memory');
    expect(vs.ariaLabel).toContain('Memory: x');
    expect(vs.ariaLabel).toContain('Selected');
    expect(vs.ariaLabel).toContain('0.750');
  });

  it('includes file path in aria-label for file nodes', () => {
    const vs = nodeVisualState(makeFileNode('src/foo/bar.ts'));
    expect(vs.ariaLabel).toContain('File target');
    expect(vs.ariaLabel).toContain('src/foo/bar.ts');
  });
});

describe('edgeCssClass', () => {
  it('maps relation to CSS class', () => {
    expect(edgeCssClass(makeEdge('a', 'b', 'routed_to'))).toContain('srg-edge--routed');
    expect(edgeCssClass(makeEdge('a', 'b', 'dropped_memory'))).toContain('srg-edge--dropped');
    expect(edgeCssClass(makeEdge('a', 'b', 'selected_memory'))).toContain('srg-edge--selected');
    expect(edgeCssClass(makeEdge('a', 'b', 'graph_path'))).toContain('srg-edge--graph-path');
  });
});

describe('edgeAriaLabel', () => {
  it('includes relation and evidence', () => {
    const edge = makeEdge('a', 'b', 'selected_memory', 0.85);
    const label = edgeAriaLabel(edge);
    expect(label).toContain('selected memory');
    expect(label).toContain('0.850');
  });
});

// ─── Score breakdown formatting ─────────────────────────────────────────────

describe('formatScoreBreakdown', () => {
  it('formats all fields with 3 decimal places', () => {
    const breakdown: RelevanceScoreBreakdown = {
      semantic: 0.8,
      graph: null,
      recency: 0.6,
      skill: 0.4,
      arbiter: 0.7,
      keyword: 0.3,
    };
    const formatted = formatScoreBreakdown(breakdown);
    expect(formatted).toHaveLength(6);
    expect(formatted[0].formatted).toBe('0.800');
    expect(formatted[1].formatted).toBe('n/a');
    expect(formatted[2].formatted).toBe('0.600');
  });

  it('returns empty array for undefined breakdown', () => {
    expect(formatScoreBreakdown(undefined)).toEqual([]);
  });
});

// ─── Score legend test ──────────────────────────────────────────────────────

describe('ScoreLegend (rendered)', () => {
  it('renders all legend items', () => {
    const data = makeGraphResponse();
    renderWithProviders(<SpecRelevanceGraph data={data} state="ready" />);
    expect(screen.getByText('Score Components')).toBeInTheDocument();
    expect(screen.getByText('Semantic / Vector')).toBeInTheDocument();
    expect(screen.getByText('Graph / Path')).toBeInTheDocument();
    expect(screen.getByText('Recency')).toBeInTheDocument();
    expect(screen.getByText('Skill Alignment')).toBeInTheDocument();
    expect(screen.getByText('Arbiter / Selection')).toBeInTheDocument();
    expect(screen.getByText('Keyword')).toBeInTheDocument();
  });
});

// ─── Truncation warnings ───────────────────────────────────────────────────

describe('truncationWarnings', () => {
  it('returns empty array when nothing is truncated', () => {
    const t: RelevanceGraphTruncation = {
      filesTruncated: false,
      memoriesTruncated: false,
      edgesTruncated: false,
      totalCandidates: 5,
      returnedCandidates: 5,
    };
    expect(truncationWarnings(t)).toEqual([]);
  });

  it('returns warnings for each truncated dimension', () => {
    const t: RelevanceGraphTruncation = {
      filesTruncated: true,
      memoriesTruncated: true,
      edgesTruncated: true,
      totalCandidates: 100,
      returnedCandidates: 30,
    };
    const warnings = truncationWarnings(t);
    expect(warnings).toHaveLength(3);
    expect(warnings[0].severity).toBe('warning');
    expect(warnings[1].message).toContain('30 of 100');
  });
});

describe('TruncationBanner (rendered)', () => {
  it('renders truncation warnings when candidates are capped', () => {
    const data = makeGraphResponse({
      truncation: {
        filesTruncated: true,
        memoriesTruncated: true,
        edgesTruncated: false,
        totalCandidates: 100,
        returnedCandidates: 30,
      },
    });
    renderWithProviders(<SpecRelevanceGraph data={data} state="ready" />);
    const banner = screen.getByTestId('srg-truncation-banner');
    expect(banner).toBeInTheDocument();
    expect(banner.textContent).toContain('30 of 100');
    expect(banner.textContent).toContain('capped');
  });
});

// ─── Fallback state tests ───────────────────────────────────────────────────

describe('deriveGraphState', () => {
  it('returns "loading" when isLoading is true', () => {
    expect(deriveGraphState(null, true, null)).toBe('loading');
  });

  it('returns "error" when error is set', () => {
    expect(deriveGraphState(null, false, 'Network failure')).toBe('error');
  });

  it('returns "empty" when data is null', () => {
    expect(deriveGraphState(null, false, null)).toBe('empty');
  });

  it('returns "unavailable" when data.available is false', () => {
    const data = makeGraphResponse({ available: false });
    expect(deriveGraphState(data, false, null)).toBe('unavailable');
  });

  it('returns "empty" when nodes array is empty', () => {
    const data = makeGraphResponse({ nodes: [] });
    expect(deriveGraphState(data, false, null)).toBe('empty');
  });

  it('returns "partial" when there are missing reasons but data present', () => {
    const data = makeGraphResponse({
      fallback: {
        ageAvailable: false,
        telemetryAvailable: true,
        graphPathsAvailable: false,
        missingReasons: ['AGE not available'],
      },
    });
    expect(deriveGraphState(data, false, null)).toBe('partial');
  });

  it('returns "ready" for a full valid response', () => {
    const data = makeGraphResponse();
    expect(deriveGraphState(data, false, null)).toBe('ready');
  });
});

describe('Fallback state rendering', () => {
  it('renders loading state', () => {
    renderWithProviders(<SpecRelevanceGraph data={null} state="loading" />);
    expect(screen.getByTestId('srg-state-loading')).toBeInTheDocument();
    expect(screen.getByText('Loading relevance graph...')).toBeInTheDocument();
  });

  it('renders empty state', () => {
    renderWithProviders(<SpecRelevanceGraph data={null} state="empty" />);
    expect(screen.getByTestId('srg-state-empty')).toBeInTheDocument();
  });

  it('renders error state with message', () => {
    renderWithProviders(
      <SpecRelevanceGraph data={null} state="error" error="Request timed out" />,
    );
    expect(screen.getByTestId('srg-state-error')).toBeInTheDocument();
    expect(screen.getByText('Request timed out')).toBeInTheDocument();
  });

  it('renders unavailable state with missing reasons', () => {
    const data = makeGraphResponse({
      available: false,
      fallback: {
        ageAvailable: false,
        telemetryAvailable: false,
        graphPathsAvailable: false,
        missingReasons: ['No retrieval telemetry available'],
      },
    });
    renderWithProviders(<SpecRelevanceGraph data={data} state="unavailable" />);
    expect(screen.getByTestId('srg-state-unavailable')).toBeInTheDocument();
    expect(screen.getAllByText('No retrieval telemetry available')).toHaveLength(2);
  });

  it('renders partial state banner', () => {
    const data = makeGraphResponse({
      fallback: {
        ageAvailable: false,
        telemetryAvailable: true,
        graphPathsAvailable: false,
        missingReasons: ['AGE not connected'],
      },
    });
    renderWithProviders(<SpecRelevanceGraph data={data} state="partial" />);
    expect(screen.getByTestId('srg-state-partial')).toBeInTheDocument();
    expect(screen.getByText(/AGE not connected/)).toBeInTheDocument();
  });
});

// ─── Accessibility tests ────────────────────────────────────────────────────

describe('Accessibility', () => {
  it('renders graph nodes with tabIndex for keyboard focus', () => {
    const data = makeGraphResponse();
    renderWithProviders(<SpecRelevanceGraph data={data} state="ready" />);
    const hubNode = screen.getByTestId('srg-node-hub:ws::test-spec');
    expect(hubNode).toHaveAttribute('tabindex', '0');
  });

  it('renders graph nodes with aria-label', () => {
    const data = makeGraphResponse();
    renderWithProviders(<SpecRelevanceGraph data={data} state="ready" />);
    const hubNode = screen.getByTestId('srg-node-hub:ws::test-spec');
    expect(hubNode.getAttribute('aria-label')).toContain('Hub');
  });

  it('renders edges with aria-label', () => {
    const data = makeGraphResponse();
    renderWithProviders(<SpecRelevanceGraph data={data} state="ready" />);
    const edges = screen.getAllByTestId(/^srg-edge-/);
    expect(edges.length).toBeGreaterThan(0);
    for (const edge of edges) {
      expect(edge).toHaveAttribute('aria-label');
    }
  });

  it('SVG has an accessible label', () => {
    const data = makeGraphResponse();
    renderWithProviders(<SpecRelevanceGraph data={data} state="ready" />);
    const svg = screen.getByTestId('srg-svg');
    expect(svg.getAttribute('aria-label')).toContain('Spec relevance graph');
  });

  it('score legend region has aria-label', () => {
    const data = makeGraphResponse();
    renderWithProviders(<SpecRelevanceGraph data={data} state="ready" />);
    expect(screen.getByRole('region', { name: 'Score legend' })).toBeInTheDocument();
  });
});

// ─── Badge label helper ─────────────────────────────────────────────────────

describe('badgeLabel', () => {
  it('returns correct display labels', () => {
    expect(badgeLabel('enteredPrompt')).toBe('In Prompt');
    expect(badgeLabel('selected')).toBe('Selected');
    expect(badgeLabel('dropped')).toBe('Dropped');
    expect(badgeLabel('unknown')).toBe('');
  });
});

// ─── Ready-state rendering ──────────────────────────────────────────────────

describe('SpecRelevanceGraph (ready state)', () => {
  it('renders SVG with nodes and edges', () => {
    const data = makeGraphResponse();
    renderWithProviders(<SpecRelevanceGraph data={data} state="ready" />);
    expect(screen.getByTestId('srg-container')).toBeInTheDocument();
    expect(screen.getByTestId('srg-svg')).toBeInTheDocument();
    // 6 nodes: 1 hub + 2 files + 3 memories
    const allNodes = screen.getAllByTestId(/^srg-node-/);
    expect(allNodes).toHaveLength(6);
    // 5 edges
    const allEdges = screen.getAllByTestId(/^srg-edge-/);
    expect(allEdges).toHaveLength(5);
  });

  it('renders summary with correct counts', () => {
    const data = makeGraphResponse();
    renderWithProviders(<SpecRelevanceGraph data={data} state="ready" />);
    const summary = screen.getByTestId('srg-summary');
    expect(summary.textContent).toContain('6 nodes');
    expect(summary.textContent).toContain('5 edges');
    expect(summary.textContent).toContain('2 selected');
    expect(summary.textContent).toContain('1 dropped');
  });

  it('annotates nodes with data-node-type and data-node-badge', () => {
    const data = makeGraphResponse();
    renderWithProviders(<SpecRelevanceGraph data={data} state="ready" />);
    const hubNode = screen.getByTestId('srg-node-hub:ws::test-spec');
    expect(hubNode.getAttribute('data-node-type')).toBe('hub');

    const fileNode = screen.getByTestId('srg-node-file:ws::src/app.ts');
    expect(fileNode.getAttribute('data-node-type')).toBe('file');
  });

  it('annotates edges with data-edge-relation', () => {
    const data = makeGraphResponse();
    renderWithProviders(<SpecRelevanceGraph data={data} state="ready" />);
    const edges = screen.getAllByTestId(/^srg-edge-/);
    const relations = edges.map((e) => e.getAttribute('data-edge-relation'));
    expect(relations).toContain('routed_to');
    expect(relations).toContain('selected_memory');
    expect(relations).toContain('dropped_memory');
  });
});
