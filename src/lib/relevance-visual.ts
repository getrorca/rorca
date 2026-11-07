/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * relevance-visual.ts — Score/visual mapping helpers for the spec-centric
 * relevance graph.
 *
 * Encodes relevance visually:
 *  - Badge classification (enteredPrompt / selected / dropped / unknown).
 *  - CSS class derivation for nodes and edges.
 *  - ARIA label generation for accessibility.
 *  - Edge dash/opacity/thickness from backend visual hints.
 *  - Score legend formatting.
 */

import type {
  RelevanceNode,
  RelevanceEdge,
  RelevanceScoreBreakdown,
  RelevanceGraphTruncation,
  NodeBadge,
  NodeVisualState,
  GraphLoadingState,
  SpecRelevanceGraphResponse,
} from '../types/spec-relevance-graph';

// ─── Node badge classification ──────────────────────────────────────────────

export function classifyNodeBadge(node: RelevanceNode): NodeBadge {
  if (node.type === 'hub' || node.type === 'file') return 'unknown';
  if (node.enteredPrompt) return 'enteredPrompt';
  if (node.selected) return 'selected';
  if (node.dropped) return 'dropped';
  return 'unknown';
}

// ─── Node CSS class ─────────────────────────────────────────────────────────

const NODE_CSS_MAP: Record<NodeBadge, string> = {
  enteredPrompt: 'srg-node--entered-prompt',
  selected: 'srg-node--selected',
  dropped: 'srg-node--dropped',
  unknown: 'srg-node--unknown',
};

const NODE_TYPE_CSS_MAP: Record<RelevanceNode['type'], string> = {
  hub: 'srg-node--hub',
  file: 'srg-node--file',
  memory: 'srg-node--memory',
  context: 'srg-node--context',
};

export function nodeVisualState(node: RelevanceNode): NodeVisualState {
  const badge = classifyNodeBadge(node);
  const typeCss = NODE_TYPE_CSS_MAP[node.type];
  const badgeCss = NODE_CSS_MAP[badge];
  const cssClass = `srg-node ${typeCss} ${badgeCss}`;
  const ariaLabel = buildNodeAriaLabel(node, badge);
  return { badge, cssClass, ariaLabel };
}

function buildNodeAriaLabel(node: RelevanceNode, badge: NodeBadge): string {
  const parts: string[] = [];

  switch (node.type) {
    case 'hub':
      parts.push(`Hub: ${node.label}`);
      break;
    case 'file':
      parts.push(`File target: ${node.label}`);
      if (node.path) parts.push(`Path: ${node.path}`);
      break;
    case 'memory':
    case 'context':
      parts.push(`${node.type === 'memory' ? 'Memory' : 'Context'}: ${node.label}`);
      if (badge === 'enteredPrompt') parts.push('Entered prompt');
      else if (badge === 'selected') parts.push('Selected');
      else if (badge === 'dropped') parts.push('Dropped');
      if (node.relevanceScore != null) {
        parts.push(`Score: ${node.relevanceScore.toFixed(3)}`);
      }
      if (node.category) parts.push(`Category: ${node.category}`);
      break;
  }

  return parts.join('. ');
}

// ─── Edge visual helpers ────────────────────────────────────────────────────

const EDGE_RELATION_CSS_MAP: Record<RelevanceEdge['relation'], string> = {
  routed_to: 'srg-edge--routed',
  selected_memory: 'srg-edge--selected',
  dropped_memory: 'srg-edge--dropped',
  learned_from: 'srg-edge--learned',
  about_file: 'srg-edge--about-file',
  graph_path: 'srg-edge--graph-path',
};

export function edgeCssClass(edge: RelevanceEdge): string {
  return `srg-edge ${EDGE_RELATION_CSS_MAP[edge.relation] ?? 'srg-edge--default'}`;
}

export function edgeAriaLabel(edge: RelevanceEdge): string {
  const parts = [`Edge: ${edge.relation.replace(/_/g, ' ')}`];
  if (edge.evidence) parts.push(edge.evidence);
  if (edge.scoreContribution != null) {
    parts.push(`Score contribution: ${edge.scoreContribution.toFixed(3)}`);
  }
  return parts.join('. ');
}

export function edgeStrokeDasharray(edge: RelevanceEdge): string {
  return edge.visualHints.dashed ? '6 3' : 'none';
}

// ─── Score breakdown formatting ─────────────────────────────────────────────

export interface FormattedScoreComponent {
  field: string;
  label: string;
  value: number | null;
  formatted: string;
}

const SCORE_FIELD_LABELS: Record<string, string> = {
  semantic: 'Semantic / Vector',
  graph: 'Graph / Path',
  recency: 'Recency',
  skill: 'Skill Alignment',
  arbiter: 'Arbiter / Selection',
  keyword: 'Keyword',
};

export function formatScoreBreakdown(
  breakdown: RelevanceScoreBreakdown | undefined,
): FormattedScoreComponent[] {
  if (!breakdown) return [];
  const fields: (keyof RelevanceScoreBreakdown)[] = [
    'semantic',
    'graph',
    'recency',
    'skill',
    'arbiter',
    'keyword',
  ];
  return fields.map((field) => ({
    field,
    label: SCORE_FIELD_LABELS[field] ?? field,
    value: breakdown[field],
    formatted: breakdown[field] != null ? breakdown[field]!.toFixed(3) : 'n/a',
  }));
}

// ─── Truncation warnings ────────────────────────────────────────────────────

export interface TruncationWarning {
  message: string;
  severity: 'info' | 'warning';
}

export function truncationWarnings(
  truncation: RelevanceGraphTruncation,
): TruncationWarning[] {
  const warnings: TruncationWarning[] = [];
  if (truncation.filesTruncated) {
    warnings.push({
      message: 'File targets were capped. Some files are not shown.',
      severity: 'warning',
    });
  }
  if (truncation.memoriesTruncated) {
    warnings.push({
      message: `Showing ${truncation.returnedCandidates} of ${truncation.totalCandidates} memory candidates.`,
      severity: 'warning',
    });
  }
  if (truncation.edgesTruncated) {
    warnings.push({
      message: 'Edge connections were capped. Some relationships are hidden.',
      severity: 'warning',
    });
  }
  return warnings;
}

// ─── Graph loading state derivation ─────────────────────────────────────────

export function deriveGraphState(
  data: SpecRelevanceGraphResponse | null,
  isLoading: boolean,
  error: string | null,
): GraphLoadingState {
  if (isLoading) return 'loading';
  if (error) return 'error';
  if (!data) return 'empty';
  if (!data.available) return 'unavailable';
  if (data.nodes.length === 0) return 'empty';
  if (data.fallback.missingReasons.length > 0 && data.nodes.length > 1) return 'partial';
  return 'ready';
}

// ─── Badge label for display ────────────────────────────────────────────────

const BADGE_LABELS: Record<NodeBadge, string> = {
  enteredPrompt: 'In Prompt',
  selected: 'Selected',
  dropped: 'Dropped',
  unknown: '',
};

export function badgeLabel(badge: NodeBadge): string {
  return BADGE_LABELS[badge];
}
