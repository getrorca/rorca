/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * RelevanceGraphView — Radial SVG rendering of the spec-centric memory
 * relevance graph inside the Context Inspector.
 *
 * Responsibilities:
 *  - Accept pre-fetched graph data and compute radial layout via computeRadialLayout.
 *  - Render nodes with accessible visual encoding: color by type, badge by status.
 *  - Edges drawn as SVG lines with thickness/dash/opacity from visual hints.
 *  - Node click dispatches to the parent for retrieval detail synchronization.
 *  - Fallback states: loading, unavailable, empty, error.
 *  - Missing graph evidence labeled as "unavailable / semantic-only".
 */

import { useMemo } from 'react';
import { Loader2, AlertTriangle, Network } from 'lucide-react';
import { computeRadialLayout } from '../lib/radial-layout';
import type {
  SpecRelevanceGraphResponse,
  GraphFetchState,
  PositionedNode,
  PositionedEdge,
  RelevanceNodeType,
} from '../types/spec-relevance-graph';

// ─── Visual constants ────────────────────────────────────────────────────────

const NODE_RADIUS: Record<RelevanceNodeType, number> = {
  hub: 28,
  file: 16,
  memory: 18,
  context: 16,
};

const NODE_COLOR: Record<RelevanceNodeType, string> = {
  hub: 'var(--accent)',
  file: '#60a5fa',      // blue-400
  memory: '#a78bfa',    // violet-400
  context: '#34d399',   // emerald-400
};

function nodeStatusColor(node: PositionedNode): string {
  if (node.dropped) return '#f87171';   // rose-400
  if (node.enteredPrompt) return '#34d399'; // emerald-400
  if (node.selected) return '#fbbf24';  // amber-400
  return NODE_COLOR[node.type] ?? '#9ca3af';
}

function nodeAriaLabel(node: PositionedNode): string {
  const status = node.dropped
    ? 'dropped'
    : node.enteredPrompt
      ? 'entered prompt'
      : node.selected
        ? 'selected'
        : 'candidate';
  const score = node.relevanceScore != null ? ` (${Math.round(node.relevanceScore * 100)}%)` : '';
  return `${node.type}: ${node.label}${score} — ${status}`;
}

// ─── Component ───────────────────────────────────────────────────────────────

interface RelevanceGraphViewProps {
  state: GraphFetchState;
  onNodeClick?: (node: PositionedNode) => void;
}

export default function RelevanceGraphView({ state, onNodeClick }: RelevanceGraphViewProps) {
  // Loading
  if (state.status === 'loading') {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 py-10" data-testid="graph-loading">
        <Loader2 size={20} className="animate-spin text-muted" />
        <span className="text-xs text-muted">Loading relevance graph…</span>
      </div>
    );
  }

  // Error
  if (state.status === 'error') {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 py-10" data-testid="graph-error">
        <AlertTriangle size={20} className="text-rose-400" />
        <span className="text-xs text-rose-400">Could not load relevance graph</span>
        <span className="text-[10px] text-muted">{state.error}</span>
      </div>
    );
  }

  // Unavailable (backend has no telemetry / AGE data)
  if (state.status === 'unavailable') {
    const reasons = state.data?.fallback?.missingReasons ?? [];
    const runtimeMessage = state.data?.runtime?.message;
    const runtimeHint = state.data?.runtime?.hint;
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 py-10" data-testid="graph-unavailable">
        <Network size={20} className="text-muted opacity-40" />
        <span className="text-xs text-muted">Graph evidence unavailable</span>
        <span className="text-[10px] text-muted/70 max-w-xs text-center">
          {runtimeMessage ?? 'This run has semantic-only retrieval data. Graph neighborhood evidence requires retrieval telemetry or Apache AGE graph paths.'}
        </span>
        {runtimeHint && <span className="text-[10px] text-muted/60 max-w-xs text-center">{runtimeHint}</span>}
        {reasons.length > 0 && (
          <ul className="text-[10px] text-muted/60 list-disc pl-4 mt-1">
            {reasons.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        )}
      </div>
    );
  }

  // Empty (available but zero nodes)
  if (state.status === 'empty' || !state.data) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 py-10" data-testid="graph-empty">
        <Network size={20} className="text-muted opacity-40" />
        <span className="text-xs text-muted">No graph data for this run</span>
      </div>
    );
  }

  return <GraphCanvas data={state.data} onNodeClick={onNodeClick} />;
}

// ─── SVG Canvas ──────────────────────────────────────────────────────────────

function GraphCanvas({
  data,
  onNodeClick,
}: {
  data: SpecRelevanceGraphResponse;
  onNodeClick?: (node: PositionedNode) => void;
}) {
  const layout = useMemo(
    () => computeRadialLayout(data.nodes, data.edges),
    [data.nodes, data.edges],
  );

  const { nodes, edges, viewBox } = layout;
  const vb = `${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`;

  return (
    <div className="flex-1 flex flex-col min-h-0" data-testid="graph-canvas">
      {/* Summary bar */}
      <div className="shrink-0 px-4 py-2 border-b border-border flex items-center gap-4 text-[10px] text-muted">
        <span>{data.summary.nodeCount} nodes</span>
        <span>{data.summary.edgeCount} edges</span>
        <span className="text-emerald-500">{data.summary.selectedCount} selected</span>
        <span className="text-rose-400">{data.summary.droppedCount} dropped</span>
        {data.summary.avgRelevanceScore != null && (
          <span>avg score: {Math.round(data.summary.avgRelevanceScore * 100)}%</span>
        )}
        {data.truncation.filesTruncated && (
          <span className="text-amber-500" title="File nodes truncated to cap">truncated</span>
        )}
        {data.runtime.graphMode !== 'full' && (
          <span className="text-amber-500/80" title={data.runtime.message}>{data.runtime.graphMode}</span>
        )}
        {!data.fallback.graphPathsAvailable && (
          <span className="text-muted/60" title="No Apache AGE graph paths">semantic-only</span>
        )}
      </div>

      {/* Score legend */}
      {data.scoreLegend.length > 0 && (
        <div className="shrink-0 px-4 py-1.5 border-b border-border/50 flex flex-wrap gap-3 text-[10px] text-muted" data-testid="graph-score-legend">
          {data.scoreLegend.map((l) => (
            <span key={l.field} title={l.description}>
              <span className="font-medium">{l.label}</span>: {l.description}
            </span>
          ))}
        </div>
      )}

      {/* SVG */}
      <div className="flex-1 overflow-auto min-h-0 p-2">
        <svg
          viewBox={vb}
          className="w-full h-full"
          role="img"
          aria-label="Spec-centric memory relevance graph"
          data-testid="graph-svg"
        >
          {/* Edges */}
          <g data-testid="graph-edges">
            {edges.map((e) => (
              <EdgeLine key={e.id} edge={e} />
            ))}
          </g>
          {/* Nodes */}
          <g data-testid="graph-nodes">
            {nodes.map((n) => (
              <NodeCircle key={n.id} node={n} onClick={onNodeClick} />
            ))}
          </g>
        </svg>
      </div>
    </div>
  );
}

// ─── Edge rendering ──────────────────────────────────────────────────────────

function EdgeLine({ edge }: { edge: PositionedEdge }) {
  return (
    <line
      x1={edge.x1}
      y1={edge.y1}
      x2={edge.x2}
      y2={edge.y2}
      stroke="currentColor"
      className="text-muted/30"
      strokeWidth={edge.visualHints.thickness}
      strokeDasharray={edge.visualHints.dashed ? '4 3' : undefined}
      opacity={edge.visualHints.opacity}
      data-testid={`graph-edge-${edge.id}`}
    />
  );
}

// ─── Node rendering ──────────────────────────────────────────────────────────

function NodeCircle({
  node,
  onClick,
}: {
  node: PositionedNode;
  onClick?: (node: PositionedNode) => void;
}) {
  const r = NODE_RADIUS[node.type] ?? 16;
  const color = nodeStatusColor(node);
  const isClickable = node.type === 'memory' || node.type === 'context' || node.type === 'file';
  const label = node.label.length > 16 ? node.label.slice(0, 14) + '…' : node.label;

  return (
    <g
      role={isClickable ? 'button' : undefined}
      tabIndex={isClickable ? 0 : undefined}
      aria-label={nodeAriaLabel(node)}
      className={isClickable ? 'cursor-pointer' : undefined}
      onClick={isClickable && onClick ? () => onClick(node) : undefined}
      onKeyDown={isClickable && onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') onClick(node); } : undefined}
      data-testid={`graph-node-${node.id}`}
    >
      <circle
        cx={node.cx}
        cy={node.cy}
        r={r}
        fill={color}
        fillOpacity={node.dropped ? 0.3 : 0.8}
        stroke={node.dropped ? '#f87171' : color}
        strokeWidth={node.enteredPrompt ? 3 : 1.5}
        strokeDasharray={node.dropped ? '3 2' : undefined}
      />
      {/* Score percentage for memory/context nodes */}
      {(node.type === 'memory' || node.type === 'context') && node.relevanceScore != null && (
        <text
          x={node.cx}
          y={node.cy + 1}
          textAnchor="middle"
          dominantBaseline="middle"
          className="text-[8px] font-mono font-bold fill-white pointer-events-none"
        >
          {Math.round(node.relevanceScore * 100)}
        </text>
      )}
      {/* Hub label inside */}
      {node.type === 'hub' && (
        <text
          x={node.cx}
          y={node.cy + 1}
          textAnchor="middle"
          dominantBaseline="middle"
          className="text-[9px] font-semibold fill-white pointer-events-none"
        >
          Hub
        </text>
      )}
      {/* Label below node */}
      <text
        x={node.cx}
        y={node.cy + r + 12}
        textAnchor="middle"
        className="text-[8px] fill-current text-muted pointer-events-none"
      >
        {label}
      </text>
    </g>
  );
}
