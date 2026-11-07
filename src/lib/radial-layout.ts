/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * radial-layout.ts — Deterministic radial/ring layout engine for the
 * spec-centric memory relevance graph.
 *
 * Layout rules:
 *  - Hub (ring 0): always at center (0, 0).
 *  - Ring 1 (files): fixed radius, evenly spaced by angle.
 *  - Ring 2 (memories): radius inversely proportional to relevance score
 *    (higher score = closer to hub). Evenly spaced by angle within the ring.
 *  - Deterministic: same input always produces same output (nodes sorted by id
 *    before angle assignment).
 */

import type {
  RelevanceNode,
  RelevanceEdge,
  PositionedNode,
  PositionedEdge,
  RadialLayoutResult,
} from '../types/spec-relevance-graph';

// ─── Layout constants ───────────────────────────────────────────────────────

/** Radius for ring 1 (file targets). */
export const RING_1_RADIUS = 140;

/** Inner boundary of ring 2 (high-relevance memories). */
export const RING_2_MIN_RADIUS = 200;

/** Outer boundary of ring 2 (low-relevance or dropped memories). */
export const RING_2_MAX_RADIUS = 320;

/** Padding around the computed layout for viewBox. */
export const LAYOUT_PADDING = 60;

/** Node render size used for viewBox boundary calculations. */
export const NODE_VISUAL_RADIUS = 24;

// ─── Layout engine ──────────────────────────────────────────────────────────

/**
 * Compute deterministic radial positions for a set of relevance nodes.
 *
 * Sorting by `id` before assigning angles guarantees the same input always
 * produces identical coordinates regardless of API response ordering.
 */
export function computeRadialLayout(
  nodes: RelevanceNode[],
  edges: RelevanceEdge[],
): RadialLayoutResult {
  // Partition nodes by ring.
  const hubNodes = nodes.filter((n) => n.ring === 0);
  const ring1Nodes = [...nodes.filter((n) => n.ring === 1)].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const ring2Nodes = [...nodes.filter((n) => n.ring === 2)].sort((a, b) =>
    a.id.localeCompare(b.id),
  );

  const positioned: PositionedNode[] = [];
  const nodeMap = new Map<string, PositionedNode>();

  // Hub at center.
  for (const hub of hubNodes) {
    const pn: PositionedNode = {
      ...hub,
      cx: 0,
      cy: 0,
      angle: 0,
      radius: 0,
    };
    positioned.push(pn);
    nodeMap.set(pn.id, pn);
  }

  // Ring 1: evenly spaced at fixed radius.
  placeRing(ring1Nodes, RING_1_RADIUS, positioned, nodeMap);

  // Ring 2: radius based on relevance score.
  placeRingWithScoreRadius(ring2Nodes, positioned, nodeMap);

  // Resolve edge positions.
  const positionedEdges: PositionedEdge[] = [];
  for (const edge of edges) {
    const src = nodeMap.get(edge.source);
    const tgt = nodeMap.get(edge.target);
    if (!src || !tgt) continue;
    positionedEdges.push({
      ...edge,
      x1: src.cx,
      y1: src.cy,
      x2: tgt.cx,
      y2: tgt.cy,
    });
  }

  // Compute viewBox.
  const viewBox = computeViewBox(positioned);

  return { nodes: positioned, edges: positionedEdges, viewBox };
}

// ─── Internal helpers ───────────────────────────────────────────────────────

function placeRing(
  nodes: RelevanceNode[],
  radius: number,
  out: PositionedNode[],
  map: Map<string, PositionedNode>,
): void {
  const count = nodes.length;
  if (count === 0) return;
  const angleStep = (2 * Math.PI) / count;

  for (let i = 0; i < count; i++) {
    const angle = -Math.PI / 2 + i * angleStep; // Start from top.
    const pn: PositionedNode = {
      ...nodes[i],
      cx: Math.cos(angle) * radius,
      cy: Math.sin(angle) * radius,
      angle,
      radius,
    };
    out.push(pn);
    map.set(pn.id, pn);
  }
}

/**
 * Place ring-2 nodes with radius inversely proportional to relevance score.
 * Higher score => smaller radius (closer to hub).
 */
function placeRingWithScoreRadius(
  nodes: RelevanceNode[],
  out: PositionedNode[],
  map: Map<string, PositionedNode>,
): void {
  const count = nodes.length;
  if (count === 0) return;
  const angleStep = (2 * Math.PI) / count;

  for (let i = 0; i < count; i++) {
    const angle = -Math.PI / 2 + i * angleStep;
    const score = nodes[i].relevanceScore ?? 0;
    const radius = scoreToRadius(score);
    const pn: PositionedNode = {
      ...nodes[i],
      cx: Math.cos(angle) * radius,
      cy: Math.sin(angle) * radius,
      angle,
      radius,
    };
    out.push(pn);
    map.set(pn.id, pn);
  }
}

/**
 * Map a 0–1 relevance score to a radius between RING_2_MIN and RING_2_MAX.
 * Score 1.0 => RING_2_MIN_RADIUS (closest to hub).
 * Score 0.0 => RING_2_MAX_RADIUS (furthest from hub).
 */
export function scoreToRadius(score: number): number {
  const clamped = Math.max(0, Math.min(1, score));
  return RING_2_MAX_RADIUS - clamped * (RING_2_MAX_RADIUS - RING_2_MIN_RADIUS);
}

function computeViewBox(nodes: PositionedNode[]): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  if (nodes.length === 0) {
    return { x: -200, y: -200, width: 400, height: 400 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.cx - NODE_VISUAL_RADIUS);
    minY = Math.min(minY, n.cy - NODE_VISUAL_RADIUS);
    maxX = Math.max(maxX, n.cx + NODE_VISUAL_RADIUS);
    maxY = Math.max(maxY, n.cy + NODE_VISUAL_RADIUS);
  }
  return {
    x: minX - LAYOUT_PADDING,
    y: minY - LAYOUT_PADDING,
    width: maxX - minX + 2 * LAYOUT_PADDING,
    height: maxY - minY + 2 * LAYOUT_PADDING,
  };
}
