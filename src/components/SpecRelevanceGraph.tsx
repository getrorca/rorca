/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * SpecRelevanceGraph — Radial, deterministic, accessible SVG visualization
 * of the spec-centric memory relevance graph.
 *
 * Composed of:
 *  - GraphNode: renders hub/file/memory/context nodes as SVG circles with badges
 *  - GraphEdge: renders edges with thickness/dash/opacity from backend hints
 *  - ScoreLegend: explains score component fields
 *  - TruncationBanner: shows cap warnings when candidates are truncated
 *  - FallbackStates: loading / empty / unavailable / error / partial states
 */

import React, { useMemo, useState, useRef, useCallback } from 'react';
import { computeRadialLayout } from '../lib/radial-layout';
import { GraphCapabilityNotice, runtimeToNoticeProps } from './GraphCapabilityNotice';
import {
  nodeVisualState,
  edgeCssClass,
  edgeAriaLabel,
  edgeStrokeDasharray,
  formatScoreBreakdown,
  truncationWarnings,
  badgeLabel,
} from '../lib/relevance-visual';
import type {
  SpecRelevanceGraphResponse,
  PositionedNode,
  PositionedEdge,
  RadialLayoutResult,
  RelevanceScoreLegend,
  RelevanceGraphTruncation,
  RelevanceGraphFallback,
  GraphLoadingState,
} from '../types/spec-relevance-graph';

// ─── Sub-components ─────────────────────────────────────────────────────────

interface GraphNodeProps {
  node: PositionedNode;
  focused: boolean;
  onFocus: (id: string) => void;
  onBlur: () => void;
  onClick?: (node: PositionedNode) => void;
}

const NODE_RADIUS: Record<string, number> = {
  hub: 24,
  file: 16,
  memory: 14,
  context: 14,
};

function GraphNode({ node, focused, onFocus, onBlur, onClick }: GraphNodeProps) {
  const vs = nodeVisualState(node);
  const r = NODE_RADIUS[node.type] ?? 14;
  const badge = vs.badge;
  const showBadge = badge !== 'unknown' && node.type !== 'hub' && node.type !== 'file';

  return (
    <g
      className={`${vs.cssClass}${onClick ? ' cursor-pointer' : ''}`}
      role="img"
      aria-label={vs.ariaLabel}
      tabIndex={0}
      onFocus={() => onFocus(node.id)}
      onBlur={onBlur}
      onClick={onClick ? () => onClick(node) : undefined}
      data-testid={`srg-node-${node.id}`}
      data-node-type={node.type}
      data-node-badge={badge}
    >
      <circle
        cx={node.cx}
        cy={node.cy}
        r={r}
        className="srg-node__circle"
        stroke={focused ? 'var(--accent-border)' : 'var(--border)'}
        strokeWidth={focused ? 2.5 : 1.5}
        fill={node.type === 'hub' ? 'var(--accent)' : 'var(--surface-200)'}
      />
      {/* Label text below the node */}
      <text
        x={node.cx}
        y={node.cy + r + 14}
        textAnchor="middle"
        className="srg-node__label"
        fill="var(--text-muted)"
        fontSize={10}
        aria-hidden="true"
      >
        {truncateLabel(node.label, 20)}
      </text>
      {/* Badge above the node */}
      {showBadge && (
        <text
          x={node.cx}
          y={node.cy - r - 6}
          textAnchor="middle"
          className="srg-node__badge"
          fill={badgeColor(badge)}
          fontSize={9}
          fontWeight={600}
          aria-hidden="true"
        >
          {badgeLabel(badge)}
        </text>
      )}
    </g>
  );
}

interface GraphEdgeProps {
  edge: PositionedEdge;
}

function GraphEdge({ edge }: GraphEdgeProps) {
  const css = edgeCssClass(edge);
  const aria = edgeAriaLabel(edge);
  const dash = edgeStrokeDasharray(edge);

  return (
    <line
      x1={edge.x1}
      y1={edge.y1}
      x2={edge.x2}
      y2={edge.y2}
      className={css}
      stroke="var(--border)"
      strokeWidth={edge.visualHints.thickness}
      strokeDasharray={dash}
      opacity={edge.visualHints.opacity}
      role="img"
      aria-label={aria}
      data-testid={`srg-edge-${edge.id}`}
      data-edge-relation={edge.relation}
    />
  );
}

interface ScoreLegendProps {
  legend: RelevanceScoreLegend[];
}

function ScoreLegend({ legend }: ScoreLegendProps) {
  return (
    <div className="srg-legend" role="region" aria-label="Score legend">
      <h4 className="text-xs font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>
        Score Components
      </h4>
      <dl className="srg-legend__list">
        {legend.map((item) => (
          <div key={item.field} className="srg-legend__item flex gap-2 text-xs mb-1">
            <dt className="font-medium" style={{ color: 'var(--text)', minWidth: 120 }}>
              {item.label}
            </dt>
            <dd style={{ color: 'var(--text-muted)' }}>{item.description}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

interface TruncationBannerProps {
  truncation: RelevanceGraphTruncation;
}

function TruncationBanner({ truncation }: TruncationBannerProps) {
  const warnings = truncationWarnings(truncation);
  if (warnings.length === 0) return null;

  return (
    <div
      className="srg-truncation"
      role="alert"
      aria-label="Graph truncation warnings"
      data-testid="srg-truncation-banner"
    >
      {warnings.map((w, i) => (
        <p
          key={i}
          className="text-xs py-1 px-2"
          style={{
            color: w.severity === 'warning' ? 'var(--warning)' : 'var(--text-muted)',
          }}
        >
          {w.message}
        </p>
      ))}
    </div>
  );
}

interface NodeDetailPopoverProps {
  node: PositionedNode;
}

function NodeDetailPopover({ node }: NodeDetailPopoverProps) {
  const scores = formatScoreBreakdown(node.scoreBreakdown);
  return (
    <div
      className="srg-popover p-3 rounded border"
      role="tooltip"
      aria-label={`Details for ${node.label}`}
      style={{
        background: 'var(--panel)',
        borderColor: 'var(--border)',
        color: 'var(--text)',
        maxWidth: 300,
      }}
      data-testid="srg-node-popover"
    >
      <p className="text-sm font-medium mb-1">{node.label}</p>
      {node.category && (
        <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>
          Category: {node.category}
        </p>
      )}
      {node.snippet && (
        <p
          className="text-xs mb-2 italic"
          style={{ color: 'var(--text-muted)' }}
        >
          {truncateLabel(node.snippet, 120)}
        </p>
      )}
      {node.keptOrDroppedReason && (
        <p className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
          Reason: {node.keptOrDroppedReason}
        </p>
      )}
      {scores.length > 0 && (
        <dl className="text-xs">
          {scores.map((s) => (
            <div key={s.field} className="flex justify-between gap-2">
              <dt style={{ color: 'var(--text-muted)' }}>{s.label}</dt>
              <dd className="font-mono">{s.formatted}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

// ─── Fallback state renders ─────────────────────────────────────────────────

interface FallbackProps {
  state: GraphLoadingState;
  error?: string | null;
  fallback?: RelevanceGraphFallback;
  runtime?: SpecRelevanceGraphResponse['runtime'] | null;
}

function FallbackState({ state, error, fallback, runtime }: FallbackProps) {
  switch (state) {
    case 'loading':
      return (
        <div
          className="srg-fallback flex items-center justify-center p-8"
          role="status"
          aria-label="Loading relevance graph"
          data-testid="srg-state-loading"
        >
          <div
            className="w-6 h-6 rounded-full border-2 animate-spin"
            style={{
              borderColor: 'var(--border)',
              borderTopColor: 'var(--accent)',
            }}
          />
          <span className="ml-3 text-sm" style={{ color: 'var(--text-muted)' }}>
            Loading relevance graph...
          </span>
        </div>
      );

    case 'empty':
      return (
        <div
          className="srg-fallback flex flex-col items-center justify-center gap-3 p-8"
          role="status"
          aria-label="No graph data available"
          data-testid="srg-state-empty"
        >
          {runtime ? <GraphCapabilityNotice {...(runtimeToNoticeProps(runtime) ?? { graphMode: runtime.graphMode })} compact className="w-full max-w-2xl text-left" /> : null}
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            {runtime?.graphMode === 'lite'
              ? 'Graph Lite is active, but no relevance graph data was captured for this context yet.'
              : 'No relevance data available for this context.'}
          </p>
        </div>
      );

    case 'unavailable':
      return (
        <div
          className="srg-fallback flex flex-col items-center justify-center gap-3 p-8"
          role="status"
          aria-label="Relevance graph unavailable"
          data-testid="srg-state-unavailable"
        >
          {runtime ? <GraphCapabilityNotice {...(runtimeToNoticeProps(runtime) ?? { graphMode: runtime.graphMode })} className="w-full max-w-2xl text-left" /> : null}
          <p className="text-sm mb-1" style={{ color: 'var(--text-muted)' }}>
            {runtime?.graphMode === 'lite'
              ? 'Full graph-path evidence was unavailable for this result.'
              : fallback?.missingReasons[0] ?? 'Relevance graph is currently unavailable.'}
          </p>
          {fallback && fallback.missingReasons.length > 0 && (
            <ul className="text-xs list-disc pl-4" style={{ color: 'var(--text-muted)' }}>
              {fallback.missingReasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
        </div>
      );

    case 'error':
      return (
        <div
          className="srg-fallback flex flex-col items-center justify-center p-8"
          role="alert"
          aria-label="Error loading relevance graph"
          data-testid="srg-state-error"
        >
          <p className="text-sm mb-1" style={{ color: 'var(--error)' }}>
            Failed to load relevance graph.
          </p>
          {error && (
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {error}
            </p>
          )}
        </div>
      );

    default:
      return null;
  }
}

// ─── Main component ─────────────────────────────────────────────────────────

export interface SpecRelevanceGraphProps {
  data: SpecRelevanceGraphResponse | null;
  state: GraphLoadingState;
  error?: string | null;
  onNodeClick?: (node: PositionedNode) => void;
}

export default function SpecRelevanceGraph({
  data,
  state,
  error,
  onNodeClick,
}: SpecRelevanceGraphProps) {
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const handleNodeFocus = useCallback((id: string) => setFocusedNodeId(id), []);
  const handleNodeBlur = useCallback(() => setFocusedNodeId(null), []);

  const layout: RadialLayoutResult | null = useMemo(() => {
    if (!data || state !== 'ready' && state !== 'partial') return null;
    return computeRadialLayout(data.nodes, data.edges);
  }, [data, state]);

  // Non-ready states render fallbacks.
  if (state !== 'ready' && state !== 'partial') {
    return (
      <FallbackState
        state={state}
        error={error}
        fallback={data?.fallback}
        runtime={data?.runtime ?? null}
      />
    );
  }

  if (!data || !layout) return null;

  const focusedNode = focusedNodeId
    ? layout.nodes.find((n) => n.id === focusedNodeId) ?? null
    : null;

  return (
    <div className="srg-container flex flex-col gap-3" data-testid="srg-container">
      {data.runtime.graphMode !== 'full' && (
        <GraphCapabilityNotice
          {...(runtimeToNoticeProps(data.runtime) ?? { graphMode: data.runtime.graphMode })}
          compact
        />
      )}

      {/* Summary header */}
      <div
        className="srg-summary flex flex-wrap gap-4 text-xs px-2"
        style={{ color: 'var(--text-muted)' }}
        role="region"
        aria-label="Graph summary"
        data-testid="srg-summary"
      >
        <span>{data.summary.nodeCount} nodes</span>
        <span>{data.summary.edgeCount} edges</span>
        <span>{data.summary.selectedCount} selected</span>
        <span>{data.summary.droppedCount} dropped</span>
        {data.runtime.graphMode !== 'full' && <span>{data.runtime.graphMode} / {data.runtime.provider}</span>}
        {data.summary.avgRelevanceScore != null && (
          <span>Avg score: {data.summary.avgRelevanceScore.toFixed(3)}</span>
        )}
      </div>

      {/* Partial state banner */}
      {state === 'partial' && data.fallback.missingReasons.length > 0 && (
        <div
          className="srg-partial-banner px-2 py-1 text-xs rounded"
          style={{ color: 'var(--warning)', background: 'var(--surface-200)' }}
          role="status"
          aria-label="Partial data notice"
          data-testid="srg-state-partial"
        >
          Partial data: {data.fallback.missingReasons[0]}
          {data.fallback.missingReasons.length > 1 &&
            ` (+${data.fallback.missingReasons.length - 1} more)`}
        </div>
      )}

      {/* Truncation warnings */}
      <TruncationBanner truncation={data.truncation} />

      {/* SVG graph */}
      <svg
        ref={svgRef}
        viewBox={`${layout.viewBox.x} ${layout.viewBox.y} ${layout.viewBox.width} ${layout.viewBox.height}`}
        className="srg-svg w-full"
        style={{ maxHeight: 500, background: 'var(--bg)' }}
        role="img"
        aria-label={`Spec relevance graph: ${data.summary.hubLabel}`}
        data-testid="srg-svg"
      >
        {/* Ring guides (decorative) */}
        <circle cx={0} cy={0} r={140} fill="none" stroke="var(--border)" strokeWidth={0.5} opacity={0.3} aria-hidden="true" />
        <circle cx={0} cy={0} r={200} fill="none" stroke="var(--border)" strokeWidth={0.5} opacity={0.2} aria-hidden="true" />
        <circle cx={0} cy={0} r={320} fill="none" stroke="var(--border)" strokeWidth={0.5} opacity={0.15} aria-hidden="true" />

        {/* Edges (rendered behind nodes) */}
        {layout.edges.map((edge) => (
          <GraphEdge key={edge.id} edge={edge} />
        ))}

        {/* Nodes */}
        {layout.nodes.map((node) => (
          <GraphNode
            key={node.id}
            node={node}
            focused={focusedNodeId === node.id}
            onFocus={handleNodeFocus}
            onBlur={handleNodeBlur}
            onClick={onNodeClick}
          />
        ))}
      </svg>

      {/* Node detail popover (shown on focus) */}
      {focusedNode && focusedNode.type !== 'hub' && (
        <NodeDetailPopover node={focusedNode} />
      )}

      {data.runtime.graphMode !== 'full' && data.fallback.missingReasons.length > 0 && (
        <div
          className="px-2 py-1 text-xs rounded"
          style={{ color: 'var(--text-muted)', background: 'var(--surface-200)' }}
          role="status"
          aria-label="Graph runtime"
        >
          {data.fallback.missingReasons[0]}
        </div>
      )}

      {/* Score legend */}
      <ScoreLegend legend={data.scoreLegend} />
    </div>
  );
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function truncateLabel(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '\u2026';
}

function badgeColor(badge: string): string {
  switch (badge) {
    case 'enteredPrompt':
      return 'var(--accent-border)';
    case 'selected':
      return 'var(--success)';
    case 'dropped':
      return 'var(--error)';
    default:
      return 'var(--text-muted)';
  }
}
