/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Frontend types for the spec-centric memory relevance graph.
 *
 * These mirror the backend SpecRelevanceGraphResponse contract from
 * backend/src/lib/spec-relevance-graph.ts. Frontend-only layout types
 * (radial coordinates, positioned nodes) are also defined here.
 */

// ─── Backend-mirrored types ─────────────────────────────────────────────────

export type RelevanceNodeType = 'hub' | 'file' | 'memory' | 'context';

export type RelevanceEdgeRelation =
  | 'routed_to'
  | 'selected_memory'
  | 'dropped_memory'
  | 'learned_from'
  | 'about_file'
  | 'graph_path';

export interface RelevanceScoreBreakdown {
  semantic: number | null;
  graph: number | null;
  recency: number | null;
  skill: number | null;
  arbiter: number | null;
  keyword: number | null;
}

export interface RelevanceNode {
  id: string;
  type: RelevanceNodeType;
  ring: 0 | 1 | 2;
  label: string;
  entityId: string;
  sourceId?: string;
  title?: string;
  category?: string;
  snippet?: string;
  selected?: boolean;
  dropped?: boolean;
  enteredPrompt?: boolean;
  relevanceScore?: number;
  scoreBreakdown?: RelevanceScoreBreakdown;
  keptOrDroppedReason?: string;
  path?: string;
  specId?: string;
  storyId?: string;
  runId?: number;
}

export interface RelevanceEdgeVisualHints {
  thickness: number;
  dashed: boolean;
  opacity: number;
}

export interface RelevanceEdge {
  id: string;
  source: string;
  target: string;
  relation: RelevanceEdgeRelation;
  scoreContribution: number | null;
  evidence: string | null;
  visualHints: RelevanceEdgeVisualHints;
}

export interface RelevanceScoreLegend {
  field: string;
  label: string;
  description: string;
}

export interface RelevanceGraphCaps {
  maxFiles: number;
  maxMemories: number;
  maxEdges: number;
}

export interface RelevanceGraphTruncation {
  filesTruncated: boolean;
  memoriesTruncated: boolean;
  edgesTruncated: boolean;
  totalCandidates: number;
  returnedCandidates: number;
}

export interface RelevanceGraphFallback {
  ageAvailable: boolean;
  telemetryAvailable: boolean;
  graphPathsAvailable: boolean;
  missingReasons: string[];
}

export interface RelevanceGraphSummary {
  hubLabel: string;
  nodeCount: number;
  edgeCount: number;
  selectedCount: number;
  droppedCount: number;
  avgRelevanceScore: number | null;
}

export interface SpecRelevanceGraphResponse {
  available: boolean;
  hub: RelevanceNode | null;
  nodes: RelevanceNode[];
  edges: RelevanceEdge[];
  scoreLegend: RelevanceScoreLegend[];
  summary: RelevanceGraphSummary;
  caps: RelevanceGraphCaps;
  truncation: RelevanceGraphTruncation;
  fallback: RelevanceGraphFallback;
}

// ─── Frontend layout types ──────────────────────────────────────────────────

/** 2D position for a placed node on the radial canvas. */
export interface RadialPosition {
  x: number;
  y: number;
}

/** A node enriched with deterministic radial coordinates. */
export interface PositionedNode extends RelevanceNode {
  cx: number;
  cy: number;
  /** Angle in radians from the hub center. */
  angle: number;
  /** Distance from hub center in px. */
  radius: number;
}

/** An edge with resolved source/target positions for SVG path rendering. */
export interface PositionedEdge extends RelevanceEdge {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Result of the radial layout computation. */
export interface RadialLayoutResult {
  nodes: PositionedNode[];
  edges: PositionedEdge[];
  viewBox: { x: number; y: number; width: number; height: number };
}

// ─── Visual classification ──────────────────────────────────────────────────

/** Badge type applied to memory/context nodes based on their status. */
export type NodeBadge = 'enteredPrompt' | 'selected' | 'dropped' | 'unknown';

/** Aggregated visual state for a node. */
export interface NodeVisualState {
  badge: NodeBadge;
  cssClass: string;
  ariaLabel: string;
}

// ─── Graph component state ──────────────────────────────────────────────────

export type GraphLoadingState = 'loading' | 'empty' | 'partial' | 'unavailable' | 'error' | 'ready';

export interface GraphFetchState {
  status: GraphLoadingState;
  data: SpecRelevanceGraphResponse | null;
  error: string | null;
}
