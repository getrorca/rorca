/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useCallback, useRef, useMemo, type ReactNode } from 'react';
import { AlertTriangle, BookOpen, Trash2, Pencil, Search, Pin, Save, X, Check, Bot, Undo2 } from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { apiFetch } from '../lib/apiFetch';
import { MEMORY_ANALYTICS_DRILLDOWN_STORAGE_KEY, type MemoryAnalyticsDrilldown } from '../lib/memoryAnalyticsDrilldown';

// ─── Types ──────────────────────────────────────────────────────────────────

interface MemoryItem {
  id: number;
  workspaceId: string;
  category: string;
  content: string;
  sourceStoryId: string | null;
  sourceSpecId: string | null;
  sourceRunId: number | null;
  confidence: string;
  relatedFiles: string[];
  pinned: boolean;
  sourceType: string | null;
  createdAt: string;
}

interface MemoryListResponse {
  items: MemoryItem[];
  total: number;
  pinned: number;
  recentRunIds: number[];
  categories: string[];
}

interface MemoryRelationListItem {
  id: number;
  relationType: 'SUPERSEDES' | 'CONFLICTS_WITH';
  status: 'active' | 'superseded' | 'deleted';
  sourceMemoryId: number;
  targetMemoryId: number;
}

interface MemoryRelationsResponse {
  items: MemoryRelationListItem[];
  total: number;
}

type MemoryReviewAction = 'archive' | 'delete' | 'keep' | 'revisit' | 'restore';
type MemoryReviewStatus = 'candidate' | 'kept' | 'revisit' | 'archived' | 'deleted';

interface MemoryReviewReason {
  code: string;
  label: string;
}

interface MemoryReviewItem extends MemoryItem {
  source: string | null;
  updatedAt: string;
  deletedAt: string | null;
  staleScore: number;
  reasons: MemoryReviewReason[];
  status: MemoryReviewStatus;
  lastAction: {
    action: MemoryReviewAction;
    at: string;
    previousStatus: string | null;
    nextStatus: MemoryReviewStatus | null;
  } | null;
}

interface MemoryHotspotItem {
  scopeType: 'file' | 'spec';
  key: string;
  label: string;
  memoryCount: number;
  conflictCount: number;
  supersededCount: number;
  lastTouchedAt: string | null;
  sampleMemoryIds: number[];
}

interface MemoryReviewResponse {
  available: boolean;
  staleCandidates: {
    items: MemoryReviewItem[];
    total: number;
    truncated: boolean;
    heuristics: {
      scanLimit: number;
      resultLimit: number;
      scoreThreshold: number;
      staleAfterDays: number;
      lowConfidenceAfterDays: number;
    };
    ageAvailable: boolean;
    mode: string;
    reason?: string | null;
  };
  hotspots: {
    files: MemoryHotspotItem[];
    specs: MemoryHotspotItem[];
    total: number;
    truncated: boolean;
    ageAvailable: boolean;
    mode: string;
    reason?: string | null;
    windowSize: number;
    resultLimit: number;
  };
}

interface MemoryOntologyExplanation {
  tone: 'active' | 'suppressed' | 'conflict';
  label: string;
  relatedMemoryId: string;
}

type MemoryViewMode = 'list' | 'graph' | 'split';

type MemoryGraphNodeType = 'Memory' | 'Story' | 'Spec' | 'File';

type MemoryGraphEdgeType = 'ABOUT' | 'LEARNED_FROM' | 'FROM_SPEC' | 'TOUCHES' | 'BELONGS_TO' | 'DEPENDS_ON' | 'SUPERSEDES' | 'CONFLICTS_WITH';

interface MemoryGraphCaps {
  memories: number;
  stories: number;
  files: number;
  specs: number;
  edges: number;
  dependencies: number;
}

interface MemoryGraphNode {
  id: string;
  type: MemoryGraphNodeType;
  entityId: string;
  label: string;
  selected: boolean;
  category?: string;
  pinned?: boolean;
  storyId?: string;
  specId?: string;
  title?: string;
  path?: string;
}

interface MemoryGraphEdge {
  id: string;
  type: MemoryGraphEdgeType;
  source: string;
  target: string;
}

interface MemoryGraphSummary {
  nodeCount: number;
  edgeCount: number;
  countsByType: Record<string, number>;
  countsByEdgeType: Record<MemoryGraphEdgeType, number>;
  caps?: MemoryGraphCaps;
  truncated: {
    nodes: boolean;
    edges: boolean;
  };
}

interface MemoryGraphSelection {
  selectedMemoryId: string | null;
  suggestedMemoryIds: string[];
  relatedStoryIds: string[];
  relatedSpecIds: string[];
  relatedFilePaths: string[];
}

interface MemoryGraphResponse {
  available: boolean;
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  summary: MemoryGraphSummary;
  selection: MemoryGraphSelection;
  error?: string;
  hint?: string;
}

interface FilteredGraphData {
  available: boolean;
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  summary: MemoryGraphSummary;
  selection: MemoryGraphSelection;
  error?: string;
  hint?: string;
}

interface PositionedMemoryGraphNode extends MemoryGraphNode {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface MemoryGraphLayout {
  width: number;
  height: number;
  nodes: PositionedMemoryGraphNode[];
  edges: Array<MemoryGraphEdge & { sourceNode: PositionedMemoryGraphNode; targetNode: PositionedMemoryGraphNode }>;
}

const CATEGORIES = ['Architecture', 'Convention', 'Bug Fix', 'Decision', 'Pattern', 'Gotcha', 'Run Synthesis'] as const;

const CATEGORY_COLORS: Record<string, string> = {
  Architecture: 'bg-blue-500/10 text-blue-500',
  Convention: 'bg-purple-500/10 text-purple-500',
  'Bug Fix': 'bg-red-500/10 text-red-500',
  Decision: 'bg-amber-500/10 text-amber-500',
  Pattern: 'bg-emerald-500/10 text-emerald-500',
  Gotcha: 'bg-orange-500/10 text-orange-500',
  'Run Synthesis': 'bg-cyan-500/10 text-cyan-500',
};

const CONFIDENCE_COLORS: Record<string, string> = {
  high: 'text-emerald-500',
  medium: 'text-amber-500',
  low: 'text-red-400',
};

const SOURCE_TYPES = ['synthesis', 'manual', 'mcp', 'auto-extracted', 'import'] as const;

const SOURCE_TYPE_LABELS: Record<string, string> = {
  synthesis: 'Synthesis',
  manual: 'Manual',
  mcp: 'MCP',
  'auto-extracted': 'Auto-extracted',
  import: 'Import',
};

const SOURCE_TYPE_COLORS: Record<string, string> = {
  synthesis: 'bg-cyan-500/10 text-cyan-500',
  manual: 'bg-violet-500/10 text-violet-500',
  mcp: 'bg-indigo-500/10 text-indigo-500',
  'auto-extracted': 'bg-teal-500/10 text-teal-500',
  import: 'bg-pink-500/10 text-pink-500',
};

const VIEW_MODES: Array<{ id: MemoryViewMode; label: string; description: string }> = [
  { id: 'list', label: 'List', description: 'Ledger-first reading view' },
  { id: 'graph', label: 'Graph', description: 'Knowledge Web only' },
  { id: 'split', label: 'Split', description: 'Ledger and Web together' },
];

const GRAPH_NODE_META: Record<MemoryGraphNodeType, { label: string; badgeClass: string; tintClass: string }> = {
  Memory: { label: 'Memories', badgeClass: 'border-blue-500/20 bg-blue-500/10 text-blue-500', tintClass: 'text-blue-500' },
  Story: { label: 'Stories', badgeClass: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-500', tintClass: 'text-emerald-500' },
  Spec: { label: 'Specs', badgeClass: 'border-violet-500/20 bg-violet-500/10 text-violet-500', tintClass: 'text-violet-500' },
  File: { label: 'Files', badgeClass: 'border-amber-500/20 bg-amber-500/10 text-amber-500', tintClass: 'text-amber-500' },
};

const GRAPH_EDGE_META: Record<MemoryGraphEdgeType, { label: string; badgeClass: string; tintClass: string; dash: string }> = {
  ABOUT: { label: 'About', badgeClass: 'border-sky-500/20 bg-sky-500/10 text-sky-500', tintClass: 'text-sky-500', dash: '0' },
  LEARNED_FROM: { label: 'Learned from', badgeClass: 'border-teal-500/20 bg-teal-500/10 text-teal-500', tintClass: 'text-teal-500', dash: '8 6' },
  FROM_SPEC: { label: 'From spec', badgeClass: 'border-purple-500/20 bg-purple-500/10 text-purple-500', tintClass: 'text-purple-500', dash: '0' },
  TOUCHES: { label: 'Touches', badgeClass: 'border-amber-500/20 bg-amber-500/10 text-amber-500', tintClass: 'text-amber-500', dash: '4 6' },
  BELONGS_TO: { label: 'Belongs to', badgeClass: 'border-cyan-500/20 bg-cyan-500/10 text-cyan-500', tintClass: 'text-cyan-500', dash: '0' },
  DEPENDS_ON: { label: 'Depends on', badgeClass: 'border-rose-500/20 bg-rose-500/10 text-rose-500', tintClass: 'text-rose-500', dash: '10 5' },
  SUPERSEDES: { label: 'Supersedes', badgeClass: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-500', tintClass: 'text-emerald-500', dash: '0' },
  CONFLICTS_WITH: { label: 'Conflicts', badgeClass: 'border-red-500/20 bg-red-500/10 text-red-400', tintClass: 'text-red-400', dash: '2 6' },
};

const GRAPH_TYPE_ORDER: MemoryGraphNodeType[] = ['Memory', 'Story', 'Spec', 'File'];
const GRAPH_EDGE_ORDER: MemoryGraphEdgeType[] = ['ABOUT', 'LEARNED_FROM', 'FROM_SPEC', 'TOUCHES', 'BELONGS_TO', 'DEPENDS_ON', 'SUPERSEDES', 'CONFLICTS_WITH'];
const GRAPH_NODE_SIZES: Record<MemoryGraphNodeType, { width: number; height: number }> = {
  Memory: { width: 182, height: 60 },
  Story: { width: 166, height: 54 },
  Spec: { width: 166, height: 54 },
  File: { width: 190, height: 54 },
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function basename(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function formatMemoryOptionLabel(item: MemoryItem): string {
  return `#${item.id} · ${item.category} · ${truncateText(item.content.replace(/\s+/g, ' '), 64)}`;
}

function matchesRelationPair(
  relation: MemoryRelationListItem,
  relationType: MemoryRelationListItem['relationType'],
  sourceMemoryId: number,
  targetMemoryId: number,
): boolean {
  if (relation.relationType !== relationType) return false;
  if (relationType === 'CONFLICTS_WITH') {
    return [relation.sourceMemoryId, relation.targetMemoryId].sort((left, right) => left - right).join(':')
      === [sourceMemoryId, targetMemoryId].sort((left, right) => left - right).join(':');
  }

  return relation.sourceMemoryId === sourceMemoryId && relation.targetMemoryId === targetMemoryId;
}

function buildRelationDraftError(
  relationType: MemoryRelationListItem['relationType'],
  sourceMemoryId: number | null,
  targetMemoryId: number | null,
  relations: MemoryRelationListItem[],
): string | null {
  if (!sourceMemoryId) return 'Select a memory to curate.';
  if (!targetMemoryId) return null;
  if (sourceMemoryId === targetMemoryId) {
    return relationType === 'SUPERSEDES'
      ? 'A memory cannot supersede itself.'
      : 'Memory relations require two distinct memories.';
  }

  const activeRelations = relations.filter((relation) => relation.status === 'active');
  if (activeRelations.some((relation) => matchesRelationPair(relation, relationType, sourceMemoryId, targetMemoryId))) {
    return relationType === 'SUPERSEDES'
      ? 'This supersession is already recorded.'
      : 'These memories already conflict.';
  }

  if (
    relationType === 'SUPERSEDES'
    && activeRelations.some((relation) => matchesRelationPair(relation, 'SUPERSEDES', targetMemoryId, sourceMemoryId))
  ) {
    return 'Archive the existing supersession before reversing it.';
  }

  return null;
}

function describeRelationForSelection(relation: MemoryRelationListItem, selectedMemoryId: number): {
  label: string;
  counterpartId: number;
  tone: MemoryOntologyExplanation['tone'];
} {
  if (relation.relationType === 'SUPERSEDES') {
    if (relation.sourceMemoryId === selectedMemoryId) {
      return {
        label: `Supersedes memory #${relation.targetMemoryId}`,
        counterpartId: relation.targetMemoryId,
        tone: 'active',
      };
    }

    return {
      label: `Superseded by memory #${relation.sourceMemoryId}`,
      counterpartId: relation.sourceMemoryId,
      tone: 'suppressed',
    };
  }

  const counterpartId = relation.sourceMemoryId === selectedMemoryId ? relation.targetMemoryId : relation.sourceMemoryId;
  return {
    label: `Conflicts with memory #${counterpartId}`,
    counterpartId,
    tone: 'conflict',
  };
}

function createEmptyCaps(): MemoryGraphCaps {
  return {
    memories: 0,
    stories: 0,
    files: 0,
    specs: 0,
    edges: 0,
    dependencies: 0,
  };
}

function createEmptySummary(): MemoryGraphSummary {
  return {
    nodeCount: 0,
    edgeCount: 0,
    countsByType: { Memory: 0, Story: 0, Spec: 0, File: 0 },
    countsByEdgeType: { ABOUT: 0, LEARNED_FROM: 0, FROM_SPEC: 0, TOUCHES: 0, BELONGS_TO: 0, DEPENDS_ON: 0, SUPERSEDES: 0, CONFLICTS_WITH: 0 },
    caps: createEmptyCaps(),
    truncated: { nodes: false, edges: false },
  };
}

function summarizeGraph(
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
  truncated: MemoryGraphSummary['truncated'],
  caps?: MemoryGraphCaps,
): MemoryGraphSummary {
  const summary = createEmptySummary();
  summary.nodeCount = nodes.length;
  summary.edgeCount = edges.length;
  summary.truncated = truncated;
  summary.caps = caps ?? createEmptyCaps();

  for (const node of nodes) {
    summary.countsByType[node.type] = (summary.countsByType[node.type] ?? 0) + 1;
  }

  for (const edge of edges) {
    summary.countsByEdgeType[edge.type] = (summary.countsByEdgeType[edge.type] ?? 0) + 1;
  }

  return summary;
}

function formatGraphCaps(caps?: MemoryGraphCaps): string {
  if (!caps) return 'bounded before rendering';
  return `${caps.memories} memories, ${caps.stories} stories, ${caps.specs} specs, ${caps.files} files, ${caps.edges} edges`;
}

function pushMemoryExplanation(map: Map<string, MemoryOntologyExplanation[]>, memoryId: string, explanation: MemoryOntologyExplanation) {
  const existing = map.get(memoryId) ?? [];
  if (existing.some((item) => item.label === explanation.label)) return;
  map.set(memoryId, [...existing, explanation]);
}

function buildMemoryExplainabilityMap(relations: MemoryRelationListItem[]): Map<string, MemoryOntologyExplanation[]> {
  const map = new Map<string, MemoryOntologyExplanation[]>();

  for (const relation of relations) {
    if (relation.status !== 'active') continue;
    const sourceMemoryId = String(relation.sourceMemoryId);
    const targetMemoryId = String(relation.targetMemoryId);

    if (relation.relationType === 'SUPERSEDES') {
      pushMemoryExplanation(map, sourceMemoryId, {
        tone: 'active',
        label: `Active rule — supersedes memory #${targetMemoryId}`,
        relatedMemoryId: targetMemoryId,
      });
      pushMemoryExplanation(map, targetMemoryId, {
        tone: 'suppressed',
        label: `Superseded by memory #${sourceMemoryId}`,
        relatedMemoryId: sourceMemoryId,
      });
      continue;
    }

    pushMemoryExplanation(map, sourceMemoryId, {
      tone: 'conflict',
      label: `Conflicts with memory #${targetMemoryId}`,
      relatedMemoryId: targetMemoryId,
    });
    pushMemoryExplanation(map, targetMemoryId, {
      tone: 'conflict',
      label: `Conflicts with memory #${sourceMemoryId}`,
      relatedMemoryId: sourceMemoryId,
    });
  }

  return new Map(
    [...map.entries()].map(([memoryId, explanations]) => [
      memoryId,
      explanations.sort((left, right) => {
        const order = { suppressed: 0, conflict: 1, active: 2 } as const;
        return order[left.tone] - order[right.tone] || left.label.localeCompare(right.label);
      }),
    ]),
  );
}

function buildBlastRadiusSummary(graph: FilteredGraphData, selectedMemoryId: string | null) {
  const relatedMemoryIds = graph.nodes
    .filter((node) => node.type === 'Memory' && node.entityId !== selectedMemoryId)
    .map((node) => node.entityId);
  const relatedStoryIds = unique(graph.selection.relatedStoryIds);
  const relatedSpecIds = unique(graph.selection.relatedSpecIds);
  const relatedFilePaths = unique(graph.selection.relatedFilePaths);
  const totalReach = relatedMemoryIds.length + relatedStoryIds.length + relatedSpecIds.length + relatedFilePaths.length;

  if (!selectedMemoryId) {
    return {
      assessment: 'Workspace overview',
      detail: 'Showing the bounded Knowledge Web for the current filtered memory corpus.',
      relatedMemoryIds,
      relatedStoryIds,
      relatedSpecIds,
      relatedFilePaths,
    };
  }

  if (totalReach <= 2) {
    return {
      assessment: 'Focused',
      detail: 'Changes appear tightly scoped around this memory selection.',
      relatedMemoryIds,
      relatedStoryIds,
      relatedSpecIds,
      relatedFilePaths,
    };
  }

  if (totalReach <= 6) {
    return {
      assessment: 'Moderate',
      detail: 'Expect follow-on checks in nearby stories, specs, and files.',
      relatedMemoryIds,
      relatedStoryIds,
      relatedSpecIds,
      relatedFilePaths,
    };
  }

  return {
    assessment: 'Wide',
    detail: 'This memory touches a broad neighborhood; validate the wider surface before shipping.',
    relatedMemoryIds,
    relatedStoryIds,
    relatedSpecIds,
    relatedFilePaths,
  };
}

function sortGraphNodes(nodes: MemoryGraphNode[], selectedMemoryId: string | null): MemoryGraphNode[] {
  return [...nodes].sort((a, b) => {
    if (a.type !== b.type) return GRAPH_TYPE_ORDER.indexOf(a.type) - GRAPH_TYPE_ORDER.indexOf(b.type);

    if (a.type === 'Memory' && b.type === 'Memory') {
      if (a.entityId === selectedMemoryId) return -1;
      if (b.entityId === selectedMemoryId) return 1;
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
    }

    const aLabel = a.title ?? a.path ?? a.storyId ?? a.specId ?? a.label;
    const bLabel = b.title ?? b.path ?? b.storyId ?? b.specId ?? b.label;
    return aLabel.localeCompare(bLabel);
  });
}

function buildFilteredGraphData(
  overviewGraph: MemoryGraphResponse | null,
  neighborhoodGraph: MemoryGraphResponse | null,
  filteredItems: MemoryItem[],
  selectedMemoryId: string | null,
): FilteredGraphData | null {
  if (!overviewGraph) return null;
  if (!overviewGraph.available) return overviewGraph;

  const allowedMemoryIds = new Set(filteredItems.map((item) => String(item.id)));
  const selectedAllowed = selectedMemoryId ? allowedMemoryIds.has(selectedMemoryId) : false;
  const nodeMap = new Map<string, MemoryGraphNode>();
  const edgeMap = new Map<string, MemoryGraphEdge>();
  const overviewNodeMap = new Map(overviewGraph.nodes.map((node) => [node.id, node]));
  const neighborhoodNodeMap = new Map((neighborhoodGraph?.nodes ?? []).map((node) => [node.id, node]));
  const allowedMemoryNodeIds = new Set(
    overviewGraph.nodes
      .filter((node) => node.type === 'Memory' && allowedMemoryIds.has(node.entityId))
      .map((node) => node.id),
  );

  const addNode = (node: MemoryGraphNode | undefined) => {
    if (!node) return;
    if (node.type === 'Memory' && !allowedMemoryIds.has(node.entityId)) return;
    nodeMap.set(node.id, node);
  };

  const addEdge = (edge: MemoryGraphEdge) => {
    edgeMap.set(edge.id, edge);
  };

  overviewGraph.nodes
    .filter((node) => node.type === 'Memory' && allowedMemoryIds.has(node.entityId))
    .forEach(addNode);

  for (const edge of overviewGraph.edges) {
    const touchesAllowedMemory = allowedMemoryNodeIds.has(edge.source) || allowedMemoryNodeIds.has(edge.target);
    if (!touchesAllowedMemory) continue;
    addNode(overviewNodeMap.get(edge.source));
    addNode(overviewNodeMap.get(edge.target));
    addEdge(edge);
  }

  if (selectedAllowed && neighborhoodGraph?.available) {
    for (const node of neighborhoodGraph.nodes) addNode(node);
    for (const edge of neighborhoodGraph.edges) {
      addNode(neighborhoodNodeMap.get(edge.source));
      addNode(neighborhoodNodeMap.get(edge.target));
      addEdge(edge);
    }
  }

  const nodes = sortGraphNodes(Array.from(nodeMap.values()), selectedMemoryId);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = Array.from(edgeMap.values()).filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
  const selectionSource = selectedAllowed && neighborhoodGraph?.available ? neighborhoodGraph.selection : overviewGraph.selection;
  const selection = {
    selectedMemoryId: selectedAllowed ? selectedMemoryId : null,
    suggestedMemoryIds: unique((overviewGraph.selection.suggestedMemoryIds ?? []).filter((memoryId) => allowedMemoryIds.has(memoryId))),
    relatedStoryIds: unique(selectionSource.relatedStoryIds ?? []),
    relatedSpecIds: unique(selectionSource.relatedSpecIds ?? []),
    relatedFilePaths: unique(selectionSource.relatedFilePaths ?? []),
  };

  return {
    available: true,
    nodes,
    edges,
    selection,
    summary: summarizeGraph(
      nodes,
      edges,
      {
        nodes: overviewGraph.summary.truncated.nodes || Boolean(neighborhoodGraph?.available && neighborhoodGraph.summary.truncated.nodes),
        edges: overviewGraph.summary.truncated.edges || Boolean(neighborhoodGraph?.available && neighborhoodGraph.summary.truncated.edges),
      },
      overviewGraph.summary.caps,
    ),
  };
}

function buildGraphLayout(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[], selectedMemoryId: string | null): MemoryGraphLayout {
  const sortedNodes = sortGraphNodes(nodes, selectedMemoryId);
  const grouped = GRAPH_TYPE_ORDER.map((type) => ({
    type,
    nodes: sortedNodes.filter((node) => node.type === type),
  })).filter((group) => group.nodes.length > 0);

  const maxRows = Math.max(...grouped.map((group) => group.nodes.length), 1);
  const width = Math.max(820, grouped.length * 240 + 120);
  const height = Math.max(340, maxRows * 84 + 120);
  const startX = 110;
  const columnGap = grouped.length > 1 ? (width - startX * 2) / (grouped.length - 1) : 0;

  const positionedNodes: PositionedMemoryGraphNode[] = grouped.flatMap((group, columnIndex) => {
    const size = GRAPH_NODE_SIZES[group.type];
    const totalHeight = group.nodes.length * size.height + Math.max(group.nodes.length - 1, 0) * 26;
    const startY = (height - totalHeight) / 2 + size.height / 2;

    return group.nodes.map((node, rowIndex) => ({
      ...node,
      width: size.width,
      height: size.height,
      x: startX + columnIndex * columnGap,
      y: startY + rowIndex * (size.height + 26),
    }));
  });

  const nodeMap = new Map(positionedNodes.map((node) => [node.id, node]));
  const positionedEdges = edges
    .map((edge) => {
      const sourceNode = nodeMap.get(edge.source);
      const targetNode = nodeMap.get(edge.target);
      if (!sourceNode || !targetNode) return null;
      return { ...edge, sourceNode, targetNode };
    })
    .filter((edge): edge is NonNullable<typeof edge> => Boolean(edge));

  return {
    width,
    height,
    nodes: positionedNodes,
    edges: positionedEdges,
  };
}

function edgePath(sourceNode: PositionedMemoryGraphNode, targetNode: PositionedMemoryGraphNode): string {
  const sourceX = sourceNode.x + sourceNode.width / 2 - 12;
  const targetX = targetNode.x - targetNode.width / 2 + 12;
  const sourceY = sourceNode.y;
  const targetY = targetNode.y;

  if (Math.abs(sourceNode.x - targetNode.x) < 8) {
    const bend = sourceNode.width / 2 + 48;
    return [
      `M ${sourceNode.x} ${sourceY}`,
      `C ${sourceNode.x + bend} ${sourceY}, ${targetNode.x + bend} ${targetY}, ${targetNode.x} ${targetY}`,
    ].join(' ');
  }

  const curve = Math.max(48, Math.abs(targetX - sourceX) * 0.35);
  return [
    `M ${sourceX} ${sourceY}`,
    `C ${sourceX + curve} ${sourceY}, ${targetX - curve} ${targetY}, ${targetX} ${targetY}`,
  ].join(' ');
}

function getNodeTitle(node: MemoryGraphNode): string {
  if (node.type === 'Memory') return `Memory #${node.entityId}`;
  if (node.type === 'Story') return node.storyId ?? node.label;
  if (node.type === 'Spec') return node.title ?? node.label;
  return basename(node.path ?? node.label);
}

function getNodeSubtitle(node: MemoryGraphNode, memoryById: Map<string, MemoryItem>): string {
  if (node.type === 'Memory') {
    const memory = memoryById.get(node.entityId);
    return truncateText(memory?.content ?? node.category ?? 'Memory', 38);
  }
  if (node.type === 'Story') return truncateText(node.title ?? node.label, 38);
  if (node.type === 'Spec') return truncateText(node.specId ?? node.label, 38);
  return truncateText(node.path ?? node.label, 38);
}

// ─── Undo Toast ─────────────────────────────────────────────────────────────

function UndoToast({ message, onUndo, onDismiss }: {
  message: string;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 10000);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  return (
    <div className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg bg-[var(--text)] px-4 py-2.5 text-xs font-medium text-bg shadow-lg animate-in slide-in-from-bottom-2">
      <span>{message}</span>
      <button
        onClick={onUndo}
        className="inline-flex items-center gap-1 rounded bg-white/20 px-2 py-1 transition-colors hover:bg-white/30"
      >
        <Undo2 size={11} />
        Undo
      </button>
      <button onClick={onDismiss} className="p-0.5 hover:opacity-70">
        <X size={12} />
      </button>
    </div>
  );
}

// ─── Inline Edit Textarea ───────────────────────────────────────────────────

function InlineEditor({ value, onSave, onCancel }: {
  value: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  return (
    <div className="space-y-2">
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        className="w-full resize-y rounded border border-accent/50 bg-bg px-3 py-2 text-xs text-[var(--text)] focus:border-accent focus:ring-1 focus:ring-accent"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSave(text);
          }
          if (e.key === 'Escape') onCancel();
        }}
      />
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => onSave(text)}
          disabled={!text.trim()}
          className="inline-flex items-center gap-1 rounded bg-accent px-2 py-1 text-[10px] font-medium text-white hover:bg-accent/90 disabled:opacity-50"
        >
          <Save size={10} />
          Save
        </button>
        <button
          onClick={onCancel}
          className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] font-medium text-muted hover:bg-surface-200"
        >
          <X size={10} />
          Cancel
        </button>
        <span className="ml-1 text-[9px] text-muted">Cmd+Enter to save</span>
      </div>
    </div>
  );
}

function MemoryRelationPreviewCard({
  label,
  item,
  emptyMessage,
}: {
  label: string;
  item: MemoryItem | null;
  emptyMessage: string;
}) {
  if (!item) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-bg px-3 py-3 text-[11px] text-muted">
        <p className="font-medium text-[var(--text)]">{label}</p>
        <p className="mt-2 leading-relaxed">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-bg px-3 py-3 text-[11px] text-muted">
      <div className="flex flex-wrap items-center gap-1.5">
        <p className="font-medium text-[var(--text)]">{label}</p>
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${CATEGORY_COLORS[item.category] ?? 'bg-gray-500/10 text-gray-500'}`}>
          {item.category}
        </span>
        {item.pinned && <Pin size={10} className="fill-amber-500 text-amber-500" />}
      </div>
      <p className="mt-2 text-xs leading-relaxed text-[var(--text)]/80">{truncateText(item.content, 180)}</p>
      <div className="mt-2 flex flex-wrap gap-1">
        <span className="rounded bg-surface-200 px-1.5 py-0.5 text-[10px] text-muted">Memory #{item.id}</span>
        {item.sourceStoryId && <span className="rounded bg-cyan-500/10 px-1.5 py-0.5 text-[10px] text-cyan-500">Story {item.sourceStoryId}</span>}
        {item.sourceSpecId && <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-400">Spec {item.sourceSpecId}</span>}
        {item.sourceRunId && <span className="rounded bg-surface-200 px-1.5 py-0.5 font-mono text-[10px] text-muted">Run #{item.sourceRunId}</span>}
        {item.sourceType && <span className={`rounded px-1.5 py-0.5 text-[10px] ${SOURCE_TYPE_COLORS[item.sourceType] ?? 'bg-gray-500/10 text-gray-500'}`}>{SOURCE_TYPE_LABELS[item.sourceType] ?? item.sourceType}</span>}
      </div>
      {(item.relatedFiles?.length ?? 0) > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {(item.relatedFiles ?? []).slice(0, 3).map((file) => (
            <span key={file} className="rounded bg-surface-200 px-1.5 py-0.5 font-mono text-[10px] text-muted">{file}</span>
          ))}
          {(item.relatedFiles?.length ?? 0) > 3 && (
            <span className="rounded bg-surface-200 px-1.5 py-0.5 text-[10px] text-muted">+{(item.relatedFiles?.length ?? 0) - 3} more</span>
          )}
        </div>
      )}
    </div>
  );
}

function OntologyCurationSection({
  items,
  selectedMemoryId,
  relations,
  targetMemoryId,
  busyKey,
  notice,
  onTargetMemoryChange,
  onCreateRelation,
  onRemoveRelation,
}: {
  items: MemoryItem[];
  selectedMemoryId: string | null;
  relations: MemoryRelationListItem[];
  targetMemoryId: string;
  busyKey: string | null;
  notice: { tone: 'success' | 'error'; message: string } | null;
  onTargetMemoryChange: (memoryId: string) => void;
  onCreateRelation: (relationType: MemoryRelationListItem['relationType']) => void;
  onRemoveRelation: (relationId: number) => void;
}) {
  const selectedMemory = items.find((item) => String(item.id) === selectedMemoryId) ?? null;
  const targetMemory = items.find((item) => String(item.id) === targetMemoryId) ?? null;
  const selectedId = selectedMemory?.id ?? null;
  const targetId = targetMemory?.id ?? null;
  const supersedesError = buildRelationDraftError('SUPERSEDES', selectedId, targetId, relations);
  const conflictError = buildRelationDraftError('CONFLICTS_WITH', selectedId, targetId, relations);
  const activeRelations = selectedId === null
    ? []
    : relations
      .filter((relation) => relation.status === 'active' && (relation.sourceMemoryId === selectedId || relation.targetMemoryId === selectedId))
      .sort((left, right) => left.relationType.localeCompare(right.relationType) || left.id - right.id);
  const candidateTargets = items.filter((item) => item.id !== selectedId);

  return (
    <section className="rounded-xl border border-border bg-surface-100/70 p-3 sm:p-4" aria-label="Ontology curation">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-[var(--text)]">Ontology curation</h2>
          <p className="mt-0.5 max-w-2xl text-[11px] leading-relaxed text-muted">
            Relate the focused memory to another workspace memory, preserve relation history through soft deletion, and keep the Knowledge Web in sync.
          </p>
        </div>
        {selectedMemory && <span className="rounded-full border border-border bg-bg px-2 py-0.5 text-[10px] text-muted">Focused memory #{selectedMemory.id}</span>}
      </div>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <label className="text-[11px] font-medium text-[var(--text)]" htmlFor="ontology-target-memory">Target memory</label>
        <select
          id="ontology-target-memory"
          value={targetMemoryId}
          onChange={(event) => onTargetMemoryChange(event.target.value)}
          aria-label="Target memory"
          disabled={Boolean(busyKey) || candidateTargets.length === 0}
          className="min-w-0 flex-1 rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-[var(--text)] focus:border-accent focus:ring-1 focus:ring-accent disabled:cursor-not-allowed disabled:opacity-60"
        >
          <option value="">Choose another memory…</option>
          {candidateTargets.map((item) => (
            <option key={item.id} value={item.id}>{formatMemoryOptionLabel(item)}</option>
          ))}
        </select>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <MemoryRelationPreviewCard label="Focused memory" item={selectedMemory} emptyMessage="Select a memory from the ledger or Knowledge Web to start curation." />
        <MemoryRelationPreviewCard label="Target memory" item={targetMemory} emptyMessage="Choose the other memory you want to supersede or mark as conflicting." />
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onCreateRelation('SUPERSEDES')}
          disabled={Boolean(busyKey) || !targetMemory || Boolean(supersedesError)}
          className="rounded-md bg-emerald-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-500/90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Mark as superseding
        </button>
        <button
          type="button"
          onClick={() => onCreateRelation('CONFLICTS_WITH')}
          disabled={Boolean(busyKey) || !targetMemory || Boolean(conflictError)}
          className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-300 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Mark conflict
        </button>
      </div>

      <div className="mt-2 space-y-1 text-[11px] text-muted">
        {targetMemory ? (
          <>
            {supersedesError && <p>Supersedes: {supersedesError}</p>}
            {conflictError && conflictError !== supersedesError && <p>Conflicts: {conflictError}</p>}
            {!supersedesError && !conflictError && selectedMemory && (
              <p>Choose supersedes when the focused memory is the newer rule. Choose conflict when both memories must stay visible but cannot both be applied cleanly.</p>
            )}
          </>
        ) : (
          <p>Choose a second memory to compare provenance, spec scope, and file context before adding an ontology edge.</p>
        )}
      </div>

      {notice && (
        <div className={`mt-3 rounded-lg border px-3 py-2 text-xs ${notice.tone === 'success' ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300' : 'border-red-500/20 bg-red-500/10 text-red-300'}`}>
          {notice.message}
        </div>
      )}

      <div className="mt-4 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Active relations for the focused memory</p>
          <span className="rounded-full border border-border bg-bg px-2 py-0.5 text-[10px] text-muted">{activeRelations.length}</span>
        </div>
        {activeRelations.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border bg-bg px-3 py-2 text-[11px] text-muted">No active supersession or conflict edges recorded for this memory yet.</p>
        ) : (
          <ul className="space-y-2" role="list" aria-label="Active ontology relations">
            {activeRelations.map((relation) => {
              const summary = describeRelationForSelection(relation, selectedId as number);
              const counterpart = items.find((item) => item.id === summary.counterpartId) ?? null;
              const toneClass = {
                active: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400',
                suppressed: 'border-amber-500/20 bg-amber-500/10 text-amber-400',
                conflict: 'border-red-500/20 bg-red-500/10 text-red-300',
              } as const;

              return (
                <li key={relation.id} className="rounded-lg border border-border bg-bg px-3 py-3 text-[11px] text-muted">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${toneClass[summary.tone]}`}>{summary.label}</span>
                        <span className="rounded-full border border-border bg-surface-100 px-2 py-0.5 text-[10px] text-muted">Relation #{relation.id}</span>
                      </div>
                      {counterpart && (
                        <>
                          <p className="mt-2 text-xs leading-relaxed text-[var(--text)]/80">{truncateText(counterpart.content, 160)}</p>
                          <div className="mt-2 flex flex-wrap gap-1">
                            {counterpart.sourceStoryId && <span className="rounded bg-cyan-500/10 px-1.5 py-0.5 text-[10px] text-cyan-500">Story {counterpart.sourceStoryId}</span>}
                            {counterpart.sourceSpecId && <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-400">Spec {counterpart.sourceSpecId}</span>}
                            {counterpart.relatedFiles.slice(0, 2).map((file) => (
                              <span key={file} className="rounded bg-surface-200 px-1.5 py-0.5 font-mono text-[10px] text-muted">{file}</span>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => onRemoveRelation(relation.id)}
                      disabled={Boolean(busyKey)}
                      className="rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted transition-colors hover:bg-surface-200 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Remove
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

function ReviewWorkflowSection({
  data,
  loading,
  error,
  busyKey,
  onAction,
  onFocusMemory,
}: {
  data: MemoryReviewResponse | null;
  loading: boolean;
  error: string | null;
  busyKey: string | null;
  onAction: (memoryId: number, action: MemoryReviewAction) => void;
  onFocusMemory: (memoryId: string) => void;
}) {
  if (loading) {
    return (
      <section className="rounded-xl border border-border bg-surface-100/70 p-3 sm:p-4" aria-label="Stale memory review workflow">
        <div className="flex min-h-[180px] flex-col items-center justify-center text-center">
          <div className="mb-3 h-5 w-5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          <p className="text-sm font-medium text-[var(--text)]">Loading stale-memory review queue</p>
          <p className="mt-1 max-w-md text-xs leading-relaxed text-muted">Preparing bounded stale-memory heuristics and hotspot summaries for operator review.</p>
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="rounded-xl border border-border bg-surface-100/70 p-3 sm:p-4" aria-label="Stale memory review workflow">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-[var(--text)]">Stale memory review</h2>
              <p className="mt-0.5 text-[11px] text-muted">Review candidates, hotspots, and recoverable memory decisions.</p>
            </div>
            <span className="rounded-full border border-border bg-bg px-2 py-0.5 text-[10px] text-muted">Unavailable</span>
          </div>
          <p className="rounded-lg border border-border bg-bg px-3 py-2 text-xs text-muted">{error}</p>
        </div>
      </section>
    );
  }

  if (!data) return null;

  const queueItems = data.staleCandidates.items.filter((item) => item.status !== 'archived' && item.status !== 'deleted');
  const recoverableItems = data.staleCandidates.items.filter((item) => item.status === 'archived' || item.status === 'deleted');
  const boundedCopy = `Review queue is intentionally bounded to ${data.staleCandidates.heuristics.scanLimit} low-recency memories and ${data.hotspots.windowSize} recent active memories.`;
  const statusClass: Record<MemoryReviewStatus, string> = {
    candidate: 'border-amber-500/20 bg-amber-500/10 text-amber-400',
    kept: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400',
    revisit: 'border-cyan-500/20 bg-cyan-500/10 text-cyan-400',
    archived: 'border-violet-500/20 bg-violet-500/10 text-violet-400',
    deleted: 'border-red-500/20 bg-red-500/10 text-red-300',
  };
  const statusLabel: Record<MemoryReviewStatus, string> = {
    candidate: 'Candidate',
    kept: 'Kept',
    revisit: 'Revisit',
    archived: 'Archived',
    deleted: 'Deleted',
  };
  const filesHot = data.hotspots.files;
  const specsHot = data.hotspots.specs;

  return (
    <section className="rounded-xl border border-border bg-surface-100/70 p-3 sm:p-4" aria-label="Stale memory review workflow">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-[var(--text)]">Stale memory review</h2>
          <p className="mt-0.5 max-w-2xl text-[11px] leading-relaxed text-muted">Archive or soft-delete stale memories, keep or revisit live ones, restore recoverable decisions, and inspect direct file/spec hotspots before cleanup.</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted">
          <span className="rounded-full border border-border bg-bg px-2 py-0.5">{queueItems.length} in queue</span>
          <span className="rounded-full border border-border bg-bg px-2 py-0.5">{recoverableItems.length} recoverable</span>
          <span className="rounded-full border border-border bg-bg px-2 py-0.5">{filesHot.length + specsHot.length} hotspots</span>
        </div>
      </div>

      <div className="mt-3 space-y-2">
        <div className="rounded-lg border border-border bg-bg px-3 py-2 text-xs text-muted">{boundedCopy}</div>
        {data.staleCandidates.reason && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-[var(--text)]">
            {data.staleCandidates.reason}
          </div>
        )}
      </div>

      <div className="mt-4 grid gap-3 xl:grid-cols-[minmax(0,1.15fr)_minmax(280px,0.85fr)]">
        <div className="space-y-3">
          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Review queue</p>
              <span className="rounded-full border border-border bg-bg px-2 py-0.5 text-[10px] text-muted">{data.staleCandidates.total} items</span>
            </div>
            {queueItems.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border bg-bg px-3 py-3 text-[11px] text-muted">No stale review candidates surfaced inside the current bounded heuristic window.</p>
            ) : (
              <ul className="space-y-3" role="list" aria-label="Stale memory review queue">
                {queueItems.map((item) => {
                  const lastActionAt = item.lastAction?.at ? new Date(item.lastAction.at).toLocaleString() : null;
                  return (
                    <li key={item.id} className="rounded-lg border border-border bg-bg px-3 py-3 text-[11px] text-muted">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${statusClass[item.status]}`}>{statusLabel[item.status]}</span>
                            <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${CATEGORY_COLORS[item.category] ?? 'bg-gray-500/10 text-gray-500'}`}>{item.category}</span>
                            <span className="rounded bg-surface-200 px-1.5 py-0.5 text-[10px] text-muted">score {item.staleScore}</span>
                            {item.sourceType && <span className={`rounded px-1.5 py-0.5 text-[10px] ${SOURCE_TYPE_COLORS[item.sourceType] ?? 'bg-gray-500/10 text-gray-500'}`}>{SOURCE_TYPE_LABELS[item.sourceType] ?? item.sourceType}</span>}
                          </div>
                          <p className="mt-2 text-xs leading-relaxed text-[var(--text)]/85">{item.content}</p>
                          <div className="mt-2 flex flex-wrap gap-1">
                            {item.sourceStoryId && <span className="rounded bg-cyan-500/10 px-1.5 py-0.5 text-[10px] text-cyan-500">Story {item.sourceStoryId}</span>}
                            {item.sourceSpecId && <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-400">Spec {item.sourceSpecId}</span>}
                            {item.sourceRunId && <span className="rounded bg-surface-200 px-1.5 py-0.5 font-mono text-[10px] text-muted">Run #{item.sourceRunId}</span>}
                            {(item.relatedFiles ?? []).slice(0, 2).map((file) => (
                              <span key={file} className="rounded bg-surface-200 px-1.5 py-0.5 font-mono text-[10px] text-muted">{file}</span>
                            ))}
                          </div>
                          <div className="mt-2 flex flex-wrap gap-1">
                            {item.reasons.map((reason) => (
                              <span key={reason.code} className="rounded-full border border-border bg-surface-100 px-2 py-0.5 text-[10px] text-muted">{reason.label}</span>
                            ))}
                          </div>
                          {lastActionAt && (
                            <p className="mt-2 text-[10px] text-muted">Last review action: {item.lastAction?.action} · {lastActionAt}</p>
                          )}
                        </div>
                        <div className="flex shrink-0 flex-col gap-2">
                          <button
                            type="button"
                            onClick={() => onFocusMemory(String(item.id))}
                            className="rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted transition-colors hover:bg-surface-200"
                          >
                            Focus
                          </button>
                          <button
                            type="button"
                            onClick={() => onAction(item.id, 'keep')}
                            disabled={busyKey === `review:${item.id}`}
                            className="rounded-md bg-emerald-500 px-2 py-1 text-[11px] font-medium text-white transition-colors hover:bg-emerald-500/90 disabled:opacity-60"
                          >
                            Keep
                          </button>
                          <button
                            type="button"
                            onClick={() => onAction(item.id, 'revisit')}
                            disabled={busyKey === `review:${item.id}`}
                            className="rounded-md border border-cyan-500/30 bg-cyan-500/10 px-2 py-1 text-[11px] font-medium text-cyan-300 transition-colors hover:bg-cyan-500/20 disabled:opacity-60"
                          >
                            Revisit
                          </button>
                          <button
                            type="button"
                            onClick={() => onAction(item.id, 'archive')}
                            disabled={busyKey === `review:${item.id}`}
                            className="rounded-md border border-violet-500/30 bg-violet-500/10 px-2 py-1 text-[11px] font-medium text-violet-300 transition-colors hover:bg-violet-500/20 disabled:opacity-60"
                          >
                            Archive
                          </button>
                          <button
                            type="button"
                            onClick={() => onAction(item.id, 'delete')}
                            disabled={busyKey === `review:${item.id}`}
                            className="rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1 text-[11px] font-medium text-red-300 transition-colors hover:bg-red-500/20 disabled:opacity-60"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Recoverable decisions</p>
              <span className="rounded-full border border-border bg-bg px-2 py-0.5 text-[10px] text-muted">{recoverableItems.length}</span>
            </div>
            {recoverableItems.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border bg-bg px-3 py-3 text-[11px] text-muted">Nothing is archived or soft-deleted from this bounded review window right now.</p>
            ) : (
              <ul className="space-y-2" role="list" aria-label="Recoverable memory decisions">
                {recoverableItems.map((item) => (
                  <li key={item.id} className="rounded-lg border border-border bg-bg px-3 py-3 text-[11px] text-muted">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${statusClass[item.status]}`}>{statusLabel[item.status]}</span>
                          <span className="rounded bg-surface-200 px-1.5 py-0.5 text-[10px] text-muted">Memory #{item.id}</span>
                          {item.sourceSpecId && <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-400">Spec {item.sourceSpecId}</span>}
                        </div>
                        <p className="mt-2 text-xs leading-relaxed text-[var(--text)]/85">{truncateText(item.content, 180)}</p>
                        {item.lastAction?.at && <p className="mt-2 text-[10px] text-muted">Last action: {item.lastAction.action} · {new Date(item.lastAction.at).toLocaleString()}</p>}
                      </div>
                      <button
                        type="button"
                        onClick={() => onAction(item.id, 'restore')}
                        disabled={busyKey === `review:${item.id}`}
                        className="inline-flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-60"
                      >
                        <Undo2 size={11} />
                        Restore
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="space-y-3">
          <div className="rounded-xl border border-border bg-bg p-3 text-[11px] text-muted">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="font-medium text-[var(--text)]">Hotspot files</p>
                <p className="mt-0.5 text-[10px] uppercase tracking-wide text-muted">Bounded direct-provenance activity</p>
              </div>
              <span className="rounded-full border border-border bg-surface-100 px-2 py-0.5 text-[10px] text-muted">{filesHot.length}</span>
            </div>
            {filesHot.length === 0 ? (
              <p className="mt-3 text-xs text-muted">No hotspot files surfaced within the current bounded workspace window.</p>
            ) : (
              <ul className="mt-3 space-y-2" role="list" aria-label="Hotspot files">
                {filesHot.map((item) => (
                  <li key={item.key} className="rounded-lg border border-border bg-surface-100/60 px-3 py-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-mono text-[10px] text-[var(--text)]">{item.label}</p>
                        <p className="mt-1 text-[10px] text-muted">{item.memoryCount} memories · {item.conflictCount} conflicts · {item.supersededCount} superseded links</p>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {item.sampleMemoryIds.map((memoryId) => (
                          <button
                            key={memoryId}
                            type="button"
                            onClick={() => onFocusMemory(String(memoryId))}
                            className="rounded-full border border-border bg-bg px-2 py-0.5 text-[10px] text-muted transition-colors hover:bg-surface-200"
                          >
                            #{memoryId}
                          </button>
                        ))}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-xl border border-border bg-bg p-3 text-[11px] text-muted">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="font-medium text-[var(--text)]">Hotspot specs</p>
                <p className="mt-0.5 text-[10px] uppercase tracking-wide text-muted">Specs with repeated memory pressure</p>
              </div>
              <span className="rounded-full border border-border bg-surface-100 px-2 py-0.5 text-[10px] text-muted">{specsHot.length}</span>
            </div>
            {specsHot.length === 0 ? (
              <p className="mt-3 text-xs text-muted">No hotspot specs surfaced within the current bounded workspace window.</p>
            ) : (
              <ul className="mt-3 space-y-2" role="list" aria-label="Hotspot specs">
                {specsHot.map((item) => (
                  <li key={item.key} className="rounded-lg border border-border bg-surface-100/60 px-3 py-2">
                    <p className="text-[11px] font-medium text-[var(--text)]">{item.label}</p>
                    <p className="mt-1 text-[10px] text-muted">{item.memoryCount} memories · {item.conflictCount} conflicts · {item.supersededCount} superseded links</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── Entry Row ──────────────────────────────────────────────────────────────

function EntryRow({ item, isSelected, isEditing, isFocused, explainability, onToggleSelect, onFocus, onEdit, onSaveEdit, onCancelEdit, onDelete, onTogglePin }: {
  item: MemoryItem;
  isSelected: boolean;
  isEditing: boolean;
  isFocused: boolean;
  explainability: MemoryOntologyExplanation[];
  onToggleSelect: () => void;
  onFocus: () => void;
  onEdit: () => void;
  onSaveEdit: (text: string) => void;
  onCancelEdit: () => void;
  onDelete: () => void;
  onTogglePin: () => void;
}) {
  const dateStr = new Date(item.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  return (
    <div
      onClick={onFocus}
      className={`group cursor-pointer rounded-lg border p-3 transition-colors ${
        isFocused
          ? 'border-accent bg-accent/5'
          : item.pinned
            ? 'border-amber-500/30 bg-amber-500/5'
            : 'border-border hover:bg-surface-200'
      }`}
    >
      <div className="flex items-start gap-2">
        <label className="mt-0.5 shrink-0">
          <input
            type="checkbox"
            checked={isSelected}
            onChange={onToggleSelect}
            className="h-3.5 w-3.5 cursor-pointer rounded border-border text-accent focus:ring-accent/50"
          />
        </label>

        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${CATEGORY_COLORS[item.category] ?? 'bg-gray-500/10 text-gray-500'}`}>
              {item.category}
            </span>
            <span className={`text-[10px] font-medium ${CONFIDENCE_COLORS[item.confidence] ?? 'text-muted'}`}>
              {item.confidence}
            </span>
            {item.pinned && <Pin size={10} className="fill-amber-500 text-amber-500" />}
            {item.sourceStoryId && (
              <span className="inline-flex items-center gap-0.5 rounded bg-cyan-500/10 px-1 py-0.5 text-[9px] font-medium text-cyan-500">
                <Bot size={9} />
                {item.sourceStoryId}
              </span>
            )}
            {item.sourceSpecId && (
              <span className="rounded bg-violet-500/10 px-1 py-0.5 text-[9px] font-medium text-violet-400">
                {item.sourceSpecId}
              </span>
            )}
            {item.sourceRunId && <span className="font-mono text-[9px] text-muted">run #{item.sourceRunId}</span>}
            {item.sourceType && (
              <span className={`rounded px-1 py-0.5 text-[9px] font-medium ${SOURCE_TYPE_COLORS[item.sourceType] ?? 'bg-gray-500/10 text-gray-500'}`}>
                {SOURCE_TYPE_LABELS[item.sourceType] ?? item.sourceType}
              </span>
            )}
            {isFocused && (
              <span className="rounded bg-accent/10 px-1 py-0.5 text-[9px] font-medium text-accent">
                Web focus
              </span>
            )}
            <span className="ml-auto shrink-0 tabular-nums text-[10px] text-muted">{dateStr}</span>
          </div>

          {isEditing ? (
            <InlineEditor value={item.content} onSave={onSaveEdit} onCancel={onCancelEdit} />
          ) : (
            <p className="whitespace-pre-wrap text-xs leading-relaxed text-[var(--text)]/80">{item.content}</p>
          )}

          {(item.relatedFiles?.length ?? 0) > 0 && !isEditing && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {(item.relatedFiles ?? []).slice(0, 3).map((file) => (
                <span key={file} className="rounded bg-surface-200 px-1 py-0.5 font-mono text-[9px] text-muted">{file}</span>
              ))}
              {(item.relatedFiles?.length ?? 0) > 3 && (
                <span className="text-[9px] text-muted">+{(item.relatedFiles?.length ?? 0) - 3} more</span>
              )}
            </div>
          )}

          {!isEditing && explainability.length > 0 && (
            <div className="mt-2 space-y-1">
              <p className="text-[10px] uppercase tracking-wide text-muted">Ontology</p>
              <OntologyExplanationChips explanations={explainability} />
            </div>
          )}
        </div>

        {!isEditing && (
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            <button onClick={onEdit} className="rounded p-1.5 transition-colors hover:bg-bg" title="Edit content">
              <Pencil size={12} className="text-muted" />
            </button>
            <button
              onClick={onTogglePin}
              className="rounded p-1.5 transition-colors hover:bg-amber-500/10"
              title={item.pinned ? 'Unpin' : 'Pin — always include in prompts'}
            >
              <Pin size={12} className={item.pinned ? 'fill-amber-500 text-amber-500' : 'text-muted'} />
            </button>
            <button onClick={onDelete} className="rounded p-1.5 transition-colors hover:bg-red-500/10" title="Delete">
              <Trash2 size={12} className="text-red-500/60" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Floating Action Bar ────────────────────────────────────────────────────

function BulkActionBar({ count, onDelete, onPin, onClear }: {
  count: number;
  onDelete: () => void;
  onPin: () => void;
  onClear: () => void;
}) {
  if (count === 0) return null;

  return (
    <div className="fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-lg bg-[var(--text)] px-4 py-2 text-xs font-medium text-bg shadow-lg">
      <Check size={12} />
      <span>{count} selected</span>
      <div className="mx-1 h-4 w-px bg-bg/30" />
      <button
        onClick={onDelete}
        className="inline-flex items-center gap-1 rounded bg-red-500/20 px-2 py-1 text-red-300 transition-colors hover:bg-red-500/30"
      >
        <Trash2 size={11} />
        Delete
      </button>
      <button
        onClick={onPin}
        className="inline-flex items-center gap-1 rounded bg-amber-500/20 px-2 py-1 text-amber-300 transition-colors hover:bg-amber-500/30"
      >
        <Pin size={11} />
        Pin
      </button>
      <button onClick={onClear} className="p-1 hover:opacity-70">
        <X size={12} />
      </button>
    </div>
  );
}

// ─── View Tabs ──────────────────────────────────────────────────────────────

function ViewModeTabs({ value, onChange }: { value: MemoryViewMode; onChange: (mode: MemoryViewMode) => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface-100/70 p-3">
      <div>
        <h2 className="text-sm font-semibold text-[var(--text)]">Views</h2>
        <p className="mt-0.5 text-[11px] text-muted">Search and filters stay in sync across List, Graph, and Split.</p>
      </div>
      <div role="tablist" aria-label="Memory view modes" className="inline-flex rounded-lg border border-border bg-bg p-1">
        {VIEW_MODES.map((mode) => {
          const active = value === mode.id;
          return (
            <button
              key={mode.id}
              role="tab"
              aria-selected={active}
              aria-controls={`memory-view-${mode.id}`}
              id={`memory-view-tab-${mode.id}`}
              onClick={() => onChange(mode.id)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                active ? 'bg-accent text-white shadow-sm' : 'text-muted hover:bg-surface-200 hover:text-[var(--text)]'
              }`}
              title={mode.description}
            >
              {mode.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Graph View ─────────────────────────────────────────────────────────────

function GraphMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-surface-100/60 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 text-lg font-semibold text-[var(--text)]">{value}</p>
    </div>
  );
}

function GraphRelationGroup({
  label,
  items,
  renderItem,
}: {
  label: string;
  items: string[];
  renderItem: (item: string) => string;
}) {
  if (items.length === 0) return null;

  const visibleItems = items.slice(0, 4);
  const remaining = items.length - visibleItems.length;

  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-muted">{label}</p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {visibleItems.map((item) => (
          <span key={item} className="rounded-full border border-border bg-bg px-2 py-0.5 text-[10px] text-muted">
            {renderItem(item)}
          </span>
        ))}
        {remaining > 0 && <span className="rounded-full bg-surface-200 px-2 py-0.5 text-[10px] text-muted">+{remaining} more</span>}
      </div>
    </div>
  );
}

function GraphNotice({ tone = 'default', children }: { tone?: 'default' | 'warning'; children: ReactNode }) {
  const toneClass = tone === 'warning'
    ? 'border-amber-500/30 bg-amber-500/10 text-[var(--text)]'
    : 'border-border bg-bg text-muted';

  return (
    <div className={`rounded-lg border px-3 py-2 text-xs ${toneClass}`}>
      <div className="flex items-start gap-2">
        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
        <p className="leading-relaxed">{children}</p>
      </div>
    </div>
  );
}

function OntologyExplanationChips({ explanations, emptyMessage }: { explanations: MemoryOntologyExplanation[]; emptyMessage?: string }) {
  if (explanations.length === 0) {
    return emptyMessage ? <p className="text-[11px] text-muted">{emptyMessage}</p> : null;
  }

  const visible = explanations.slice(0, 2);
  const overflow = explanations.length - visible.length;
  const toneClass = {
    active: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400',
    suppressed: 'border-amber-500/20 bg-amber-500/10 text-amber-400',
    conflict: 'border-red-500/20 bg-red-500/10 text-red-300',
  } as const;

  return (
    <div className="flex flex-wrap gap-1.5">
      {visible.map((explanation) => (
        <span key={`${explanation.tone}:${explanation.label}`} className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${toneClass[explanation.tone]}`}>
          {explanation.label}
        </span>
      ))}
      {overflow > 0 && <span className="rounded-full bg-surface-200 px-2 py-0.5 text-[10px] text-muted">+{overflow} more</span>}
    </div>
  );
}

function GraphView({
  graph,
  selectedMemoryId,
  selectedExplainability,
  ontologyError,
  onSelectMemory,
  filteredItems,
  memoryById,
  loading,
  overviewGraph,
  overviewError,
  neighborhoodGraph,
  neighborhoodError,
  loadingNeighborhood,
}: {
  graph: FilteredGraphData | null;
  selectedMemoryId: string | null;
  selectedExplainability: MemoryOntologyExplanation[];
  ontologyError: string | null;
  onSelectMemory: (memoryId: string) => void;
  filteredItems: MemoryItem[];
  memoryById: Map<string, MemoryItem>;
  loading: boolean;
  overviewGraph: MemoryGraphResponse | null;
  overviewError: string | null;
  neighborhoodGraph: MemoryGraphResponse | null;
  neighborhoodError: string | null;
  loadingNeighborhood: boolean;
}) {
  const layout = useMemo(() => {
    if (!graph?.available || graph.nodes.length === 0) return null;
    return buildGraphLayout(graph.nodes, graph.edges, selectedMemoryId);
  }, [graph, selectedMemoryId]);

  const presentNodeTypes = GRAPH_TYPE_ORDER.filter((type) => (graph?.summary.countsByType[type] ?? 0) > 0);
  const presentEdgeTypes = GRAPH_EDGE_ORDER.filter((type) => (graph?.summary.countsByEdgeType[type] ?? 0) > 0);
  const suggestedMemoryIds = (graph?.selection.suggestedMemoryIds ?? []).filter((memoryId) => memoryById.has(memoryId));
  const focusedMemory = selectedMemoryId ? memoryById.get(selectedMemoryId) : null;
  const blastRadius = graph?.available ? buildBlastRadiusSummary(graph, selectedMemoryId) : null;
  const overviewBounded = Boolean(overviewGraph?.available && (overviewGraph.summary.truncated.nodes || overviewGraph.summary.truncated.edges));
  const neighborhoodBounded = Boolean(
    selectedMemoryId
    && neighborhoodGraph?.available
    && (neighborhoodGraph.summary.truncated.nodes || neighborhoodGraph.summary.truncated.edges),
  );
  const neighborhoodUnavailableMessage = selectedMemoryId && neighborhoodGraph && !neighborhoodGraph.available
    ? `${neighborhoodGraph.error ?? 'Focused neighborhood unavailable.'}${neighborhoodGraph.hint ? ` ${neighborhoodGraph.hint}` : ''}`
    : neighborhoodError;

  if (loading) {
    return (
      <section className="rounded-xl border border-border bg-surface-100/70 p-4" aria-label="Knowledge Web graph">
        <div className="flex min-h-[240px] flex-col items-center justify-center text-center">
          <div className="mb-3 h-5 w-5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          <p className="text-sm font-medium text-[var(--text)]">Loading Knowledge Web</p>
          <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted">
            Preparing the bounded V1 Knowledge Web from existing ontology edges for this workspace.
          </p>
        </div>
      </section>
    );
  }

  if (!graph && overviewError) {
    return (
      <section className="rounded-xl border border-border bg-surface-100/70 p-4" aria-label="Knowledge Web graph">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-[var(--text)]">Knowledge Web</h2>
              <p className="mt-0.5 text-[11px] text-muted">V1 is a bounded Knowledge Web built from existing ontology edges.</p>
            </div>
            <span className="rounded-full border border-border bg-bg px-2 py-0.5 text-[10px] text-muted">Unavailable</span>
          </div>
          <p className="rounded-lg border border-border bg-bg px-3 py-2 text-xs text-muted">{overviewError}</p>
        </div>
      </section>
    );
  }

  if (!graph) {
    return (
      <section className="rounded-xl border border-border bg-surface-100/70 p-4" aria-label="Knowledge Web graph">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-[var(--text)]">Knowledge Web</h2>
              <p className="mt-0.5 text-[11px] text-muted">V1 is a bounded Knowledge Web built from existing ontology edges.</p>
            </div>
            <span className="rounded-full border border-border bg-bg px-2 py-0.5 text-[10px] text-muted">Unavailable</span>
          </div>
          <p className="rounded-lg border border-border bg-bg px-3 py-2 text-xs text-muted">Knowledge Web data is unavailable right now.</p>
        </div>
      </section>
    );
  }

  if (!graph.available) {
    return (
      <section className="rounded-xl border border-border bg-surface-100/70 p-4" aria-label="Knowledge Web graph">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-[var(--text)]">Knowledge Web</h2>
              <p className="mt-0.5 text-[11px] text-muted">V1 is a bounded Knowledge Web built from existing ontology edges.</p>
            </div>
            <span className="rounded-full border border-border bg-bg px-2 py-0.5 text-[10px] text-muted">Unavailable</span>
          </div>
          <p className="rounded-lg border border-border bg-bg px-3 py-2 text-xs text-muted">
            {graph.error ?? 'Knowledge Web unavailable in lite mode.'}
            {graph.hint ? ` ${graph.hint}` : ''}
          </p>
        </div>
      </section>
    );
  }

  if (filteredItems.length === 0) {
    return (
      <section className="rounded-xl border border-border bg-surface-100/70 p-4" aria-label="Knowledge Web graph">
        <div className="flex min-h-[240px] flex-col items-center justify-center text-center">
          <BookOpen size={24} className="mb-3 text-muted" />
          <p className="text-sm font-medium text-[var(--text)]">No graph results for the current filters</p>
          <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted">
            Clear or change the search and filters to repopulate the bounded V1 Knowledge Web.
          </p>
        </div>
      </section>
    );
  }

  if (!layout || layout.nodes.length === 0) {
    return (
      <section className="rounded-xl border border-border bg-surface-100/70 p-4" aria-label="Knowledge Web graph">
        <div className="flex min-h-[240px] flex-col items-center justify-center text-center">
          <BookOpen size={24} className="mb-3 text-muted" />
          <p className="text-sm font-medium text-[var(--text)]">No graph links available yet</p>
          <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted">
            The current bounded selection does not expose existing ontology edges to stories, files, or specs.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-border bg-surface-100/70 p-3 sm:p-4" aria-label="Knowledge Web graph">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-[var(--text)]">Knowledge Web</h2>
          <p className="mt-0.5 text-[11px] text-muted">V1 is a bounded Knowledge Web built from existing ontology edges and the current filtered memory corpus.</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted">
          <span className="rounded-full border border-border bg-bg px-2 py-0.5">{graph.summary.nodeCount} nodes</span>
          <span className="rounded-full border border-border bg-bg px-2 py-0.5">{graph.summary.edgeCount} edges</span>
          {graph.summary.truncated.nodes || graph.summary.truncated.edges ? (
            <span className="rounded-full border border-border bg-bg px-2 py-0.5">bounded</span>
          ) : null}
        </div>
      </div>

      <div className="mt-3 space-y-2">
        {overviewBounded && (
          <GraphNotice tone="warning">
            Workspace overview is intentionally capped before rendering at {formatGraphCaps(overviewGraph?.summary.caps)} so large workspaces stay responsive.
          </GraphNotice>
        )}
        {neighborhoodBounded && (
          <GraphNotice tone="warning">
            Focused neighborhood is intentionally capped before rendering at {formatGraphCaps(neighborhoodGraph?.summary.caps)} for the current selection.
          </GraphNotice>
        )}
        {neighborhoodUnavailableMessage && (
          <GraphNotice>
            Focused neighborhood unavailable; showing the bounded workspace overview for this selection. {neighborhoodUnavailableMessage}
          </GraphNotice>
        )}
        {ontologyError && (
          <GraphNotice>
            Ontology explanations unavailable; showing graph topology without precedence summaries. {ontologyError}
          </GraphNotice>
        )}
      </div>

      <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(0,1fr)_320px] xl:items-start">
        <div className="flex flex-wrap gap-1.5">
          {presentNodeTypes.map((type) => (
            <span key={type} className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${GRAPH_NODE_META[type].badgeClass}`}>
              {GRAPH_NODE_META[type].label} {graph.summary.countsByType[type]}
            </span>
          ))}
          {presentEdgeTypes.map((type) => (
            <span key={type} className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${GRAPH_EDGE_META[type].badgeClass}`}>
              {GRAPH_EDGE_META[type].label} {graph.summary.countsByEdgeType[type]}
            </span>
          ))}
        </div>

        <div className="rounded-xl border border-border bg-bg p-3 text-[11px] text-muted" aria-label="Blast radius summary">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-medium text-[var(--text)]">Blast radius</p>
              <p className="mt-0.5 text-[10px] uppercase tracking-wide text-muted">
                {selectedMemoryId ? `Centered on memory #${selectedMemoryId}` : 'Workspace overview'}
              </p>
            </div>
            <span className="rounded-full border border-border bg-surface-100 px-2 py-0.5 text-[10px] font-medium text-[var(--text)]">
              {blastRadius?.assessment ?? 'Unknown'}
            </span>
          </div>

          <p className="mt-2 leading-relaxed">
            {focusedMemory
              ? truncateText(focusedMemory.content, 120)
              : 'Select a memory from the ledger or graph to inspect its bounded neighborhood.'}
          </p>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <GraphMetric label="Related memories" value={blastRadius?.relatedMemoryIds.length ?? 0} />
            <GraphMetric label="Related stories" value={blastRadius?.relatedStoryIds.length ?? 0} />
            <GraphMetric label="Related specs" value={blastRadius?.relatedSpecIds.length ?? 0} />
            <GraphMetric label="Related files" value={blastRadius?.relatedFilePaths.length ?? 0} />
          </div>

          <p className="mt-3 text-xs leading-relaxed text-muted">{blastRadius?.detail}</p>

          <div className="mt-3 space-y-2">
            <p className="text-[10px] uppercase tracking-wide text-muted">Ontology</p>
            <OntologyExplanationChips
              explanations={selectedExplainability}
              emptyMessage={selectedMemoryId ? 'No supersession or conflict edges recorded for this memory.' : 'Select a memory to inspect ontology precedence and conflicts.'}
            />
          </div>

          <div className="mt-3 space-y-3">
            <GraphRelationGroup label="Related memories" items={blastRadius?.relatedMemoryIds ?? []} renderItem={(memoryId) => `Memory #${memoryId}`} />
            <GraphRelationGroup label="Related stories" items={blastRadius?.relatedStoryIds ?? []} renderItem={(storyId) => `Story ${storyId}`} />
            <GraphRelationGroup label="Related specs" items={blastRadius?.relatedSpecIds ?? []} renderItem={(specId) => `Spec ${specId}`} />
            <GraphRelationGroup label="Related files" items={blastRadius?.relatedFilePaths ?? []} renderItem={(path) => basename(path)} />
          </div>

          {(blastRadius?.relatedMemoryIds.length ?? 0) === 0
            && (blastRadius?.relatedStoryIds.length ?? 0) === 0
            && (blastRadius?.relatedSpecIds.length ?? 0) === 0
            && (blastRadius?.relatedFilePaths.length ?? 0) === 0 && (
              <p className="mt-3 text-xs text-muted">No related memories, stories, specs, or files were surfaced for this bounded selection.</p>
          )}

          {loadingNeighborhood && selectedMemoryId && <p className="mt-3 text-[10px] text-muted">Refreshing focused neighborhood…</p>}
        </div>
      </div>

      {suggestedMemoryIds.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-muted">Suggested</span>
          {suggestedMemoryIds.slice(0, 6).map((memoryId) => (
            <button
              key={memoryId}
              onClick={() => onSelectMemory(memoryId)}
              className={`rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors ${
                selectedMemoryId === memoryId
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border text-muted hover:bg-surface-200'
              }`}
            >
              Memory #{memoryId}
            </button>
          ))}
        </div>
      )}

      <div className="mt-3 rounded-xl border border-border bg-bg p-2 sm:p-3">
        <div className="overflow-hidden rounded-lg border border-border/70 bg-surface-100/50">
          <svg
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            className="h-[320px] w-full sm:h-[400px]"
            role="img"
            aria-label="Knowledge Web graph canvas"
            preserveAspectRatio="xMidYMid meet"
          >
            <defs>
              <marker id="memory-graph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" className="text-muted" />
              </marker>
            </defs>

            {layout.edges.map((edge) => {
              const edgeMeta = GRAPH_EDGE_META[edge.type];
              return (
                <path
                  key={edge.id}
                  d={edgePath(edge.sourceNode, edge.targetNode)}
                  className={edgeMeta.tintClass}
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeDasharray={edgeMeta.dash === '0' ? undefined : edgeMeta.dash}
                  strokeLinecap="round"
                  fill="none"
                  opacity={0.8}
                  markerEnd="url(#memory-graph-arrow)"
                />
              );
            })}

            {layout.nodes.map((node) => {
              const meta = GRAPH_NODE_META[node.type];
              const title = truncateText(getNodeTitle(node), 26);
              const subtitle = getNodeSubtitle(node, memoryById);
              const selected = node.type === 'Memory' && selectedMemoryId === node.entityId;
              const clickable = node.type === 'Memory';
              const radius = node.type === 'Memory' ? 16 : 14;

              return (
                <g
                  key={node.id}
                  role={clickable ? 'button' : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  aria-label={clickable ? `Focus memory ${node.entityId} from graph` : undefined}
                  aria-pressed={clickable ? selected : undefined}
                  className={clickable ? 'cursor-pointer' : undefined}
                  onClick={() => {
                    if (clickable) onSelectMemory(node.entityId);
                  }}
                  onKeyDown={(event) => {
                    if (!clickable) return;
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onSelectMemory(node.entityId);
                    }
                  }}
                >
                  {selected && (
                    <rect
                      x={node.x - node.width / 2 - 4}
                      y={node.y - node.height / 2 - 4}
                      width={node.width + 8}
                      height={node.height + 8}
                      rx={radius + 2}
                      fill="none"
                      stroke="var(--accent)"
                      strokeWidth={3}
                    />
                  )}

                  <rect
                    x={node.x - node.width / 2}
                    y={node.y - node.height / 2}
                    width={node.width}
                    height={node.height}
                    rx={radius}
                    className={meta.tintClass}
                    fill="currentColor"
                    fillOpacity={0.12}
                    stroke="currentColor"
                    strokeWidth={selected ? 2.5 : 1.5}
                  />

                  {node.pinned && (
                    <circle
                      cx={node.x + node.width / 2 - 14}
                      cy={node.y - node.height / 2 + 14}
                      r={4}
                      className="fill-amber-500"
                    />
                  )}

                  <text x={node.x - node.width / 2 + 12} y={node.y - 4} fontSize={11} fontWeight={600} fill="var(--text)">
                    {title}
                  </text>
                  <text x={node.x - node.width / 2 + 12} y={node.y + 12} fontSize={10} fill="var(--text-muted)">
                    {truncateText(subtitle, 32)}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3 text-[10px] text-muted">
        <div className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-accent" />
          <span>Selected memory</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-amber-500" />
          <span>Pinned memory</span>
        </div>
        <span>Tap any memory node to sync the ledger selection without mutating the ledger state.</span>
      </div>
    </section>
  );
}

// ─── Entries Section ────────────────────────────────────────────────────────

function EntriesSection({
  filteredItems,
  totalCount,
  selectedIds,
  editingId,
  selectedMemoryId,
  explainabilityByMemory,
  onToggleSelect,
  onFocusMemory,
  onEdit,
  onSaveEdit,
  onCancelEdit,
  onDelete,
  onTogglePin,
  compact,
}: {
  filteredItems: MemoryItem[];
  totalCount: number;
  selectedIds: Set<number>;
  editingId: number | null;
  selectedMemoryId: string | null;
  explainabilityByMemory: Map<string, MemoryOntologyExplanation[]>;
  onToggleSelect: (id: number) => void;
  onFocusMemory: (memoryId: string) => void;
  onEdit: (id: number) => void;
  onSaveEdit: (id: number, content: string) => void;
  onCancelEdit: () => void;
  onDelete: (id: number) => void;
  onTogglePin: (item: MemoryItem) => void;
  compact: boolean;
}) {
  const content = filteredItems.length === 0 ? (
    <li role="listitem" className="py-12 text-center">
      {totalCount === 0 ? (
        <div className="mx-auto flex max-w-[400px] flex-col items-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/10">
            <BookOpen size={28} className="text-accent" />
          </div>
          <h3 className="mb-1.5 text-base font-semibold text-[var(--text)]">No memory entries yet</h3>
          <p className="text-sm leading-relaxed text-muted">
            Memory entries are created automatically as specs run. They capture patterns, conventions, and decisions learned from each story.
          </p>
        </div>
      ) : (
        <>
          <BookOpen size={24} className="mx-auto mb-3 text-muted" />
          <p className="text-sm text-muted">No entries match your filters.</p>
        </>
      )}
    </li>
  ) : (
    filteredItems.map((item) => (
      <li key={item.id} role="listitem">
        <EntryRow
          item={item}
          isSelected={selectedIds.has(item.id)}
          isEditing={editingId === item.id}
          isFocused={selectedMemoryId === String(item.id)}
          explainability={explainabilityByMemory.get(String(item.id)) ?? []}
          onToggleSelect={() => onToggleSelect(item.id)}
          onFocus={() => onFocusMemory(String(item.id))}
          onEdit={() => onEdit(item.id)}
          onSaveEdit={(text) => onSaveEdit(item.id, text)}
          onCancelEdit={onCancelEdit}
          onDelete={() => onDelete(item.id)}
          onTogglePin={() => onTogglePin(item)}
        />
      </li>
    ))
  );

  if (!compact) {
    return <ul role="list" aria-label="Memory entries" className="space-y-2">{content}</ul>;
  }

  return (
    <section className="rounded-xl border border-border bg-surface-100/70 p-3 sm:p-4" aria-label="Memory ledger list">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-[var(--text)]">Ledger</h2>
          <p className="mt-0.5 text-[11px] text-muted">The same filtered memory list, kept in sync with the graph selection.</p>
        </div>
        <span className="rounded-full border border-border bg-bg px-2 py-0.5 text-[10px] text-muted">
          {filteredItems.length} shown
        </span>
      </div>
      <ul role="list" aria-label="Memory entries" className="space-y-2">{content}</ul>
    </section>
  );
}

// ─── Main Panel ─────────────────────────────────────────────────────────────

export default function MemoryPanel() {
  const { workspaceId } = useWorkspace();
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [pinnedCount, setPinnedCount] = useState(0);
  const [recentRunIds, setRecentRunIds] = useState<number[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Filters
  const [filterCategory, setFilterCategory] = useState<string>('');
  const [filterConfidence, setFilterConfidence] = useState<string>('');
  const [filterRunId, setFilterRunId] = useState<string>('');
  const [filterSourceType, setFilterSourceType] = useState<string>('');
  const [searchInput, setSearchInput] = useState('');
  const [searchText, setSearchText] = useState('');
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // View state
  const [viewMode, setViewMode] = useState<MemoryViewMode>('list');

  // Knowledge Web
  const [selectedMemoryId, setSelectedMemoryId] = useState<string | null>(null);
  const [overviewGraph, setOverviewGraph] = useState<MemoryGraphResponse | null>(null);
  const [neighborhoodGraph, setNeighborhoodGraph] = useState<MemoryGraphResponse | null>(null);
  const [overviewGraphLoading, setOverviewGraphLoading] = useState(false);
  const [neighborhoodGraphLoading, setNeighborhoodGraphLoading] = useState(false);
  const [overviewGraphError, setOverviewGraphError] = useState<string | null>(null);
  const [neighborhoodGraphError, setNeighborhoodGraphError] = useState<string | null>(null);
  const [relations, setRelations] = useState<MemoryRelationListItem[]>([]);
  const [relationsError, setRelationsError] = useState<string | null>(null);
  const [targetMemoryId, setTargetMemoryId] = useState('');
  const [relationMutationKey, setRelationMutationKey] = useState<string | null>(null);
  const [relationNotice, setRelationNotice] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);
  const [reviewData, setReviewData] = useState<MemoryReviewResponse | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewBusyKey, setReviewBusyKey] = useState<string | null>(null);
  const [analyticsDrilldown, setAnalyticsDrilldown] = useState<MemoryAnalyticsDrilldown | null>(null);
  const [analyticsDrilldownActive, setAnalyticsDrilldownActive] = useState(false);

  // Selection
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  // Editing
  const [editingId, setEditingId] = useState<number | null>(null);

  // Undo
  const [undoState, setUndoState] = useState<{ id: number; message: string } | null>(null);

  useEffect(() => {
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, []);

  useEffect(() => {
    setFilterCategory('');
    setFilterConfidence('');
    setFilterRunId('');
    setFilterSourceType('');
    setSearchInput('');
    setSearchText('');
    setViewMode('list');
    setSelectedMemoryId(null);
    setOverviewGraph(null);
    setNeighborhoodGraph(null);
    setOverviewGraphError(null);
    setNeighborhoodGraphError(null);
    setSelectedIds(new Set());
    setEditingId(null);
    setRelations([]);
    setRelationsError(null);
    setTargetMemoryId('');
    setRelationMutationKey(null);
    setRelationNotice(null);
    setReviewData(null);
    setReviewLoading(false);
    setReviewError(null);
    setReviewBusyKey(null);
    setAnalyticsDrilldown(null);
    setAnalyticsDrilldownActive(false);
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId) {
      setAnalyticsDrilldown(null);
      setAnalyticsDrilldownActive(false);
      return;
    }

    try {
      const raw = sessionStorage.getItem(MEMORY_ANALYTICS_DRILLDOWN_STORAGE_KEY);
      if (!raw) {
        setAnalyticsDrilldown(null);
        setAnalyticsDrilldownActive(false);
        return;
      }

      const parsed = JSON.parse(raw) as MemoryAnalyticsDrilldown;
      if (parsed?.source !== 'ontology-health' || parsed.workspaceId !== workspaceId) {
        setAnalyticsDrilldown(null);
        setAnalyticsDrilldownActive(false);
        return;
      }

      setAnalyticsDrilldown(parsed);
      setAnalyticsDrilldownActive(true);
      setViewMode('split');
    } catch {
      setAnalyticsDrilldown(null);
      setAnalyticsDrilldownActive(false);
    }
  }, [workspaceId]);

  const fetchItems = useCallback(async () => {
    if (!workspaceId) return;
    const params = new URLSearchParams({ workspaceId, limit: '500' });
    if (filterCategory) params.set('category', filterCategory);
    if (filterConfidence) params.set('confidence', filterConfidence);
    if (filterRunId) params.set('sourceRunId', filterRunId);
    if (searchText) params.set('search', searchText);

    try {
      const data = await apiFetch<MemoryListResponse>(`/api/memory/items?${params.toString()}`);
      const nextItems = Array.isArray(data?.items) ? data.items : [];
      setItems(nextItems);
      setTotalCount(Number(data?.total ?? 0));
      setPinnedCount(Number(data?.pinned ?? 0));
      setRecentRunIds(Array.isArray(data?.recentRunIds) ? data.recentRunIds : []);
    } catch {
      setItems([]);
      setTotalCount(0);
      setPinnedCount(0);
      setRecentRunIds([]);
    }
    setLoaded(true);
  }, [workspaceId, filterCategory, filterConfidence, filterRunId, searchText]);

  useEffect(() => {
    void fetchItems();
  }, [fetchItems]);

  const fetchReviewData = useCallback(async () => {
    if (!workspaceId) return;
    setReviewLoading(true);
    setReviewError(null);

    try {
      const data = await apiFetch<MemoryReviewResponse>(`/api/memory/review?workspaceId=${encodeURIComponent(workspaceId)}`);
      setReviewData(data);
    } catch (error) {
      setReviewData(null);
      setReviewError(error instanceof Error ? error.message : 'Memory review queue unavailable right now.');
    } finally {
      setReviewLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void fetchReviewData();
  }, [fetchReviewData]);

  const fetchRelations = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const data = await apiFetch<MemoryRelationsResponse>(`/api/memory/relations?workspaceId=${encodeURIComponent(workspaceId)}`);
      setRelations(Array.isArray(data?.items) ? data.items : []);
      setRelationsError(null);
    } catch (error) {
      setRelations([]);
      setRelationsError(error instanceof Error ? error.message : 'Ontology explanations unavailable right now.');
    }
  }, [workspaceId]);

  useEffect(() => {
    void fetchRelations();
  }, [fetchRelations]);

  const shouldShowGraph = viewMode !== 'list';

  const fetchOverviewGraph = useCallback(async () => {
    if (!workspaceId || !shouldShowGraph) return;
    setOverviewGraphLoading(true);
    setOverviewGraphError(null);

    try {
      const data = await apiFetch<MemoryGraphResponse>(`/api/memory/graph/overview?workspaceId=${encodeURIComponent(workspaceId)}`);
      setOverviewGraph(data);
    } catch (error) {
      setOverviewGraph(null);
      setOverviewGraphError(error instanceof Error ? error.message : 'Knowledge Web unavailable right now.');
    } finally {
      setOverviewGraphLoading(false);
    }
  }, [workspaceId, shouldShowGraph]);

  useEffect(() => {
    if (!shouldShowGraph) return;
    void fetchOverviewGraph();
  }, [fetchOverviewGraph, shouldShowGraph]);

  const sourceTypeFilteredItems = useMemo(
    () => (filterSourceType ? items.filter((item) => (item.sourceType ?? 'manual') === filterSourceType) : items),
    [items, filterSourceType],
  );

  const filteredItems = useMemo(() => {
    if (!analyticsDrilldownActive || !analyticsDrilldown) return sourceTypeFilteredItems;

    const memoryIdSet = new Set(analyticsDrilldown.memoryIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0));
    const specIdSet = new Set(analyticsDrilldown.specIds.filter((value) => value.trim().length > 0));
    const filePathSet = new Set(analyticsDrilldown.filePaths.filter((value) => value.trim().length > 0));

    return sourceTypeFilteredItems.filter((item) => {
      if (memoryIdSet.has(item.id)) return true;
      if (item.sourceSpecId && specIdSet.has(item.sourceSpecId)) return true;
      return item.relatedFiles.some((file) => filePathSet.has(file));
    });
  }, [analyticsDrilldown, analyticsDrilldownActive, sourceTypeFilteredItems]);

  useEffect(() => {
    setSelectedMemoryId((current) => {
      if (current && filteredItems.some((item) => String(item.id) === current)) return current;
      return filteredItems[0] ? String(filteredItems[0].id) : null;
    });
  }, [filteredItems]);

  useEffect(() => {
    if (!selectedMemoryId) {
      setTargetMemoryId('');
      return;
    }

    setTargetMemoryId((current) => {
      if (current && current !== selectedMemoryId && items.some((item) => String(item.id) === current)) {
        return current;
      }
      return '';
    });
    setRelationNotice(null);
  }, [items, selectedMemoryId]);

  const fetchNeighborhoodGraph = useCallback(async () => {
    if (!workspaceId || !selectedMemoryId || !shouldShowGraph) {
      setNeighborhoodGraph(null);
      setNeighborhoodGraphError(null);
      return;
    }

    setNeighborhoodGraphLoading(true);
    setNeighborhoodGraph(null);
    setNeighborhoodGraphError(null);
    try {
      const params = new URLSearchParams({ workspaceId, memoryId: selectedMemoryId });
      const data = await apiFetch<MemoryGraphResponse>(`/api/memory/graph/neighborhood?${params.toString()}`);
      setNeighborhoodGraph(data);
    } catch (error) {
      setNeighborhoodGraph(null);
      setNeighborhoodGraphError(error instanceof Error ? error.message : 'Focused neighborhood unavailable right now.');
    } finally {
      setNeighborhoodGraphLoading(false);
    }
  }, [workspaceId, selectedMemoryId, shouldShowGraph]);

  useEffect(() => {
    if (!shouldShowGraph) return;
    void fetchNeighborhoodGraph();
  }, [fetchNeighborhoodGraph, shouldShowGraph]);

  const refreshOntologyState = useCallback(async () => {
    await fetchRelations();
    if (!shouldShowGraph) return;
    await fetchOverviewGraph();
    await fetchNeighborhoodGraph();
  }, [fetchNeighborhoodGraph, fetchOverviewGraph, fetchRelations, shouldShowGraph]);

  const handleReviewAction = async (memoryId: number, action: MemoryReviewAction) => {
    if (!workspaceId) return;

    try {
      setReviewBusyKey(`review:${memoryId}`);
      await apiFetch(`/api/memory/review/${memoryId}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, action }),
      });
      await Promise.all([fetchItems(), fetchReviewData(), refreshOntologyState()]);
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : 'Unable to apply the memory review action right now.');
    } finally {
      setReviewBusyKey(null);
    }
  };

  const handleCreateRelation = async (relationType: MemoryRelationListItem['relationType']) => {
    if (!workspaceId || !selectedMemoryId) return;

    const sourceMemoryId = Number(selectedMemoryId);
    const parsedTargetMemoryId = Number(targetMemoryId);
    const normalizedSourceMemoryId = Number.isInteger(sourceMemoryId) ? sourceMemoryId : null;
    const normalizedTargetMemoryId = Number.isInteger(parsedTargetMemoryId) && parsedTargetMemoryId > 0 ? parsedTargetMemoryId : null;

    if (!normalizedTargetMemoryId) {
      setRelationNotice({ tone: 'error', message: 'Choose another memory to relate.' });
      return;
    }

    const validationError = buildRelationDraftError(
      relationType,
      normalizedSourceMemoryId,
      normalizedTargetMemoryId,
      relations,
    );

    if (validationError) {
      setRelationNotice({ tone: 'error', message: validationError });
      return;
    }

    try {
      setRelationMutationKey(`create:${relationType}`);
      await apiFetch('/api/memory/relations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          sourceMemoryId,
          targetMemoryId: normalizedTargetMemoryId,
          relationType,
        }),
      });
      setTargetMemoryId('');
      setRelationNotice({
        tone: 'success',
        message: relationType === 'SUPERSEDES'
          ? `Memory #${sourceMemoryId} now supersedes memory #${normalizedTargetMemoryId}.`
          : `Memory #${sourceMemoryId} now conflicts with memory #${normalizedTargetMemoryId}.`,
      });
      await refreshOntologyState();
    } catch (error) {
      setRelationNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Unable to save the ontology relation right now.',
      });
    } finally {
      setRelationMutationKey(null);
    }
  };

  const handleRemoveRelation = async (relationId: number) => {
    if (!workspaceId) return;

    try {
      setRelationMutationKey(`delete:${relationId}`);
      await apiFetch(`/api/memory/relations/${relationId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      setRelationNotice({ tone: 'success', message: `Relation #${relationId} removed from the active ontology.` });
      await refreshOntologyState();
    } catch (error) {
      setRelationNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Unable to remove the ontology relation right now.',
      });
    } finally {
      setRelationMutationKey(null);
    }
  };

  const handleSearchChange = (value: string) => {
    setSearchInput(value);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => setSearchText(value), 300);
  };

  const handleDelete = async (id: number) => {
    try {
      await apiFetch(`/api/memory/items/${id}`, { method: 'DELETE' });
      setUndoState({ id, message: 'Memory deleted. Undo?' });
      await fetchItems();
    } catch {
      // ignore
    }
  };

  const handleUndelete = async (id: number) => {
    try {
      await apiFetch(`/api/memory/items/${id}/undelete`, { method: 'POST' });
      setUndoState(null);
      await fetchItems();
    } catch {
      // ignore
    }
  };

  const handleTogglePin = async (item: MemoryItem) => {
    try {
      await apiFetch(`/api/memory/items/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned: !item.pinned }),
      });
      await fetchItems();
    } catch {
      // ignore
    }
  };

  const handleSaveEdit = async (id: number, content: string) => {
    try {
      await apiFetch(`/api/memory/items/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      setEditingId(null);
      await fetchItems();
    } catch {
      // ignore
    }
  };

  const handleBulkDelete = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    try {
      await apiFetch('/api/memory/items/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, action: 'delete' }),
      });
      setSelectedIds(new Set());
      await fetchItems();
    } catch {
      // ignore
    }
  };

  const handleBulkPin = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    try {
      await apiFetch('/api/memory/items/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, action: 'pin' }),
      });
      setSelectedIds(new Set());
      await fetchItems();
    } catch {
      // ignore
    }
  };

  const toggleSelect = (id: number) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const categoryCounts = filteredItems.reduce<Record<string, number>>((acc, item) => {
    acc[item.category] = (acc[item.category] ?? 0) + 1;
    return acc;
  }, {});

  const sourceTypeCounts = items.reduce<Record<string, number>>((acc, item) => {
    const sourceType = item.sourceType ?? 'manual';
    acc[sourceType] = (acc[sourceType] ?? 0) + 1;
    return acc;
  }, {});

  const analyticsDrilldownCounts = useMemo(() => ({
    memories: analyticsDrilldown?.memoryIds.length ?? 0,
    specs: analyticsDrilldown?.specIds.length ?? 0,
    files: analyticsDrilldown?.filePaths.length ?? 0,
  }), [analyticsDrilldown]);

  const currentRunCount = recentRunIds.length > 0 ? filteredItems.filter((item) => item.sourceRunId === recentRunIds[0]).length : 0;
  const memoryById = useMemo(() => new Map(items.map((item) => [String(item.id), item])), [items]);
  const explainabilityByMemory = useMemo(() => buildMemoryExplainabilityMap(relations), [relations]);
  const selectedExplainability = selectedMemoryId ? (explainabilityByMemory.get(selectedMemoryId) ?? []) : [];
  const filteredGraph = useMemo(
    () => buildFilteredGraphData(overviewGraph, neighborhoodGraph, filteredItems, selectedMemoryId),
    [overviewGraph, neighborhoodGraph, filteredItems, selectedMemoryId],
  );
  const graphLoading = shouldShowGraph && (overviewGraphLoading || (!overviewGraph && !overviewGraphError));

  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      </div>
    );
  }

  const listSection = (
    <EntriesSection
      filteredItems={filteredItems}
      totalCount={totalCount}
      selectedIds={selectedIds}
      editingId={editingId}
      selectedMemoryId={selectedMemoryId}
      explainabilityByMemory={explainabilityByMemory}
      onToggleSelect={toggleSelect}
      onFocusMemory={setSelectedMemoryId}
      onEdit={setEditingId}
      onSaveEdit={handleSaveEdit}
      onCancelEdit={() => setEditingId(null)}
      onDelete={handleDelete}
      onTogglePin={handleTogglePin}
      compact={viewMode === 'split'}
    />
  );

  const graphSection = shouldShowGraph ? (
    <GraphView
      graph={filteredGraph}
      selectedMemoryId={selectedMemoryId}
      selectedExplainability={selectedExplainability}
      ontologyError={relationsError}
      onSelectMemory={setSelectedMemoryId}
      filteredItems={filteredItems}
      memoryById={memoryById}
      loading={graphLoading}
      overviewGraph={overviewGraph}
      overviewError={overviewGraphError}
      neighborhoodGraph={neighborhoodGraph}
      neighborhoodError={neighborhoodGraphError}
      loadingNeighborhood={neighborhoodGraphLoading}
    />
  ) : null;

  return (
    <div role="main" aria-label="Memory Ledger" className="flex h-full flex-col overflow-hidden bg-bg">
      <div className="h-full overflow-y-auto">
        <div className={`mx-auto space-y-4 px-4 py-6 sm:px-6 ${viewMode === 'list' ? 'max-w-3xl' : 'max-w-7xl'}`}>
          <div className="flex flex-wrap items-center gap-3 text-[11px]">
            <span className="font-medium text-[var(--text)]">{totalCount} memories</span>
            {pinnedCount > 0 && (
              <span className="inline-flex items-center gap-1 text-amber-500">
                <Pin size={10} className="fill-amber-500" />
                {pinnedCount} pinned
              </span>
            )}
            {currentRunCount > 0 && <span className="text-cyan-500">{currentRunCount} this run</span>}
          </div>

          {analyticsDrilldown && (
            <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/10 px-3 py-3 text-xs text-[var(--text)]">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-semibold">Analytics drill-down: {analyticsDrilldown.label}</p>
                  <p className="mt-1 max-w-3xl leading-relaxed text-[var(--text)]/80">{analyticsDrilldown.description}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-cyan-100/90">
                    {analyticsDrilldownCounts.memories > 0 && <span className="rounded-full border border-cyan-400/30 px-2 py-0.5">{analyticsDrilldownCounts.memories} memories</span>}
                    {analyticsDrilldownCounts.specs > 0 && <span className="rounded-full border border-cyan-400/30 px-2 py-0.5">{analyticsDrilldownCounts.specs} specs</span>}
                    {analyticsDrilldownCounts.files > 0 && <span className="rounded-full border border-cyan-400/30 px-2 py-0.5">{analyticsDrilldownCounts.files} files</span>}
                    <span className="rounded-full border border-cyan-400/30 px-2 py-0.5">{analyticsDrilldownActive ? `${filteredItems.length} in focus` : 'Focus cleared'}</span>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setAnalyticsDrilldownActive((current) => !current)}
                    className="rounded-md border border-cyan-400/30 px-2.5 py-1 text-[11px] font-medium text-cyan-100 transition-colors hover:bg-cyan-500/10"
                  >
                    {analyticsDrilldownActive ? 'Show all memories' : 'Refocus drill-down'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      sessionStorage.removeItem(MEMORY_ANALYTICS_DRILLDOWN_STORAGE_KEY);
                      setAnalyticsDrilldown(null);
                      setAnalyticsDrilldownActive(false);
                    }}
                    className="rounded-md border border-cyan-400/30 px-2.5 py-1 text-[11px] font-medium text-cyan-100 transition-colors hover:bg-cyan-500/10"
                  >
                    Clear drill-down
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[180px] flex-1">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
              <input
                type="text"
                value={searchInput}
                placeholder="Search memories..."
                onChange={(e) => handleSearchChange(e.target.value)}
                aria-label="Search memories"
                className="w-full rounded-md border border-border bg-bg py-1.5 pl-8 pr-3 text-xs text-[var(--text)] placeholder:text-muted focus:border-accent focus:ring-1 focus:ring-accent"
              />
            </div>

            <select
              value={filterCategory}
              onChange={(e) => setFilterCategory(e.target.value)}
              aria-label="Filter by category"
              className="rounded border border-border bg-bg px-2 py-1.5 text-xs text-[var(--text)] focus:border-accent focus:ring-1 focus:ring-accent"
            >
              <option value="">All categories</option>
              {CATEGORIES.map((category) => (
                <option key={category} value={category}>{category}</option>
              ))}
            </select>

            <select
              value={filterConfidence}
              onChange={(e) => setFilterConfidence(e.target.value)}
              aria-label="Filter by confidence"
              className="rounded border border-border bg-bg px-2 py-1.5 text-xs text-[var(--text)] focus:border-accent focus:ring-1 focus:ring-accent"
            >
              <option value="">All confidence</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>

            {recentRunIds.length > 0 && (
              <select
                value={filterRunId}
                onChange={(e) => setFilterRunId(e.target.value)}
                aria-label="Filter by source run"
                className="rounded border border-border bg-bg px-2 py-1.5 text-xs text-[var(--text)] focus:border-accent focus:ring-1 focus:ring-accent"
              >
                <option value="">All runs</option>
                {recentRunIds.map((id) => (
                  <option key={id} value={id}>Run #{id}</option>
                ))}
              </select>
            )}

            <select
              value={filterSourceType}
              onChange={(e) => setFilterSourceType(e.target.value)}
              aria-label="Filter by source type"
              className="rounded border border-border bg-bg px-2 py-1.5 text-xs text-[var(--text)] focus:border-accent focus:ring-1 focus:ring-accent"
            >
              <option value="">All sources</option>
              {SOURCE_TYPES.map((sourceType) => (
                <option key={sourceType} value={sourceType}>{SOURCE_TYPE_LABELS[sourceType]}</option>
              ))}
            </select>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {CATEGORIES.map((category) => {
              const count = categoryCounts[category] ?? 0;
              if (count === 0) return null;
              const active = filterCategory === category;
              return (
                <button
                  key={category}
                  onClick={() => setFilterCategory(active ? '' : category)}
                  className={`rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ${
                    active ? CATEGORY_COLORS[category] : 'bg-surface-200 text-muted hover:bg-surface-300'
                  }`}
                >
                  {category} ({count})
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {SOURCE_TYPES.map((sourceType) => {
              const count = sourceTypeCounts[sourceType] ?? 0;
              if (count === 0) return null;
              const active = filterSourceType === sourceType;
              return (
                <button
                  key={sourceType}
                  onClick={() => setFilterSourceType(active ? '' : sourceType)}
                  className={`rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ${
                    active ? SOURCE_TYPE_COLORS[sourceType] : 'bg-surface-200 text-muted hover:bg-surface-300'
                  }`}
                >
                  {SOURCE_TYPE_LABELS[sourceType]} ({count})
                </button>
              );
            })}
          </div>

          <ReviewWorkflowSection
            data={reviewData}
            loading={reviewLoading}
            error={reviewError}
            busyKey={reviewBusyKey}
            onAction={handleReviewAction}
            onFocusMemory={setSelectedMemoryId}
          />

          <ViewModeTabs value={viewMode} onChange={setViewMode} />

          {relationsError && (
            <div className="rounded-lg border border-border bg-surface-100/70 px-3 py-2 text-xs text-muted">
              Ontology explanations unavailable right now. {relationsError}
            </div>
          )}

          <OntologyCurationSection
            items={items}
            selectedMemoryId={selectedMemoryId}
            relations={relations}
            targetMemoryId={targetMemoryId}
            busyKey={relationMutationKey}
            notice={relationNotice}
            onTargetMemoryChange={setTargetMemoryId}
            onCreateRelation={handleCreateRelation}
            onRemoveRelation={handleRemoveRelation}
          />

          <div
            id={`memory-view-${viewMode}`}
            role="tabpanel"
            aria-labelledby={`memory-view-tab-${viewMode}`}
            className="space-y-4"
          >
            {viewMode === 'list' && listSection}
            {viewMode === 'graph' && graphSection}
            {viewMode === 'split' && (
              <div className="grid gap-4 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] xl:items-start">
                <div className="min-w-0">{listSection}</div>
                <div className="min-w-0">{graphSection}</div>
              </div>
            )}
          </div>
        </div>
      </div>

      <BulkActionBar
        count={selectedIds.size}
        onDelete={handleBulkDelete}
        onPin={handleBulkPin}
        onClear={() => setSelectedIds(new Set())}
      />

      {undoState && (
        <UndoToast
          message={undoState.message}
          onUndo={() => handleUndelete(undoState.id)}
          onDismiss={() => setUndoState(null)}
        />
      )}
    </div>
  );
}
