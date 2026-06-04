/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * PreFlightGraph — Collapsible pre-flight context neighborhood graph shown
 * above the Run/Trigger controls in SpecDetailSlideOver.
 *
 * Uses useSpecRelevanceGraph (by spec slug) to fetch the spec-centric memory
 * relevance graph and renders:
 *  - A compact health summary bar (selected/dropped/truncation/availability)
 *  - The RelevanceGraphView radial SVG (from SMG-002)
 *  - Node action menu: copy memory ID, open Memory Ledger filtered to candidate
 *
 * Non-mutating: no state is persisted, no manual attachment created.
 */

import { useState, useCallback, useMemo } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Network,
  Copy,
  Check,
  Search,
  ExternalLink,
  AlertTriangle,
  Loader2,
} from 'lucide-react';
import RelevanceGraphView from './RelevanceGraphView';
import { useSpecRelevanceGraph } from '../hooks/useSpecRelevanceGraph';
import type { PositionedNode } from '../types/spec-relevance-graph';
import type { PanelId } from './Sidebar';

/* ─── Types ───────────────────────────────────────────────────────── */

export interface PreFlightGraphProps {
  specSlug: string;
  workspaceId: string;
  onNavigate?: (panel: PanelId) => void;
}

type CopiedId = string | null;

/* ─── Health badge helpers ────────────────────────────────────────── */

interface HealthIndicator {
  label: string;
  value: string | number;
  severity: 'good' | 'warn' | 'bad' | 'muted';
}

function computeHealth(
  data: import('../types/spec-relevance-graph').SpecRelevanceGraphResponse | null,
  status: import('../types/spec-relevance-graph').GraphLoadingState,
): HealthIndicator[] {
  if (!data || status === 'loading' || status === 'error') return [];

  const indicators: HealthIndicator[] = [];

  if (!data.available) {
    indicators.push({ label: 'Graph', value: 'unavailable', severity: 'muted' });
    if (!data.fallback.telemetryAvailable) {
      indicators.push({ label: 'Telemetry', value: 'unavailable', severity: 'muted' });
    }
    return indicators;
  }

  // Selected count
  const sel = data.summary.selectedCount;
  indicators.push({
    label: 'Selected',
    value: sel,
    severity: sel > 0 ? 'good' : 'warn',
  });

  // Dropped count
  const dropped = data.summary.droppedCount;
  if (dropped > 0) {
    indicators.push({
      label: 'Dropped',
      value: dropped,
      severity: dropped > sel ? 'bad' : 'warn',
    });
  }

  // Avg relevance
  if (data.summary.avgRelevanceScore != null) {
    const pct = Math.round(data.summary.avgRelevanceScore * 100);
    indicators.push({
      label: 'Avg score',
      value: `${pct}%`,
      severity: pct >= 50 ? 'good' : pct >= 25 ? 'warn' : 'bad',
    });
  }

  // Truncation
  if (data.truncation.filesTruncated || data.truncation.memoriesTruncated) {
    indicators.push({
      label: 'Capped',
      value: `${data.truncation.returnedCandidates}/${data.truncation.totalCandidates}`,
      severity: 'warn',
    });
  }

  // Telemetry / AGE availability
  if (!data.fallback.telemetryAvailable) {
    indicators.push({ label: 'Telemetry', value: 'n/a', severity: 'muted' });
  }
  if (!data.fallback.graphPathsAvailable) {
    indicators.push({ label: 'Graph paths', value: 'semantic-only', severity: 'muted' });
  }

  return indicators;
}

const SEVERITY_COLORS: Record<string, string> = {
  good: 'text-emerald-400',
  warn: 'text-amber-400',
  bad: 'text-rose-400',
  muted: 'text-muted/60',
};

/* ─── Node action popover ────────────────────────────────────────── */

function NodeActions({
  node,
  copiedId,
  onCopy,
  onOpenLedger,
}: {
  node: PositionedNode;
  copiedId: CopiedId;
  onCopy: (id: string) => void;
  onOpenLedger: (entityId: string) => void;
}) {
  const isMemory = node.type === 'memory' || node.type === 'context';
  if (!isMemory && node.type !== 'file') return null;

  const isCopied = copiedId === node.entityId;

  return (
    <div
      className="flex items-center gap-3 px-3 py-2 border-t border-border/50 bg-panel/80 text-[10px]"
      data-testid="preflight-node-actions"
    >
      <span className="font-medium text-muted truncate max-w-[180px]" title={node.label}>
        {node.label}
      </span>
      <div className="flex items-center gap-1.5 ml-auto shrink-0">
        {/* Copy entity ID */}
        <button
          onClick={() => onCopy(node.entityId)}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-accent/10 text-muted hover:text-text transition-colors"
          title={`Copy ID: ${node.entityId}`}
          data-testid="preflight-action-copy"
        >
          {isCopied ? <Check size={10} className="text-emerald-400" /> : <Copy size={10} />}
          <span>{isCopied ? 'Copied' : 'Copy ID'}</span>
        </button>

        {/* Open Memory Ledger filtered */}
        {isMemory && (
          <button
            onClick={() => onOpenLedger(node.entityId)}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-accent/10 text-muted hover:text-text transition-colors"
            title="Open Memory Ledger for this candidate"
            data-testid="preflight-action-ledger"
          >
            <Search size={10} />
            <span>Ledger</span>
          </button>
        )}
      </div>
    </div>
  );
}

/* ─── Main component ──────────────────────────────────────────────── */

export default function PreFlightGraph({
  specSlug,
  workspaceId,
  onNavigate,
}: PreFlightGraphProps) {
  const [expanded, setExpanded] = useState(false);
  const [selectedNode, setSelectedNode] = useState<PositionedNode | null>(null);
  const [copiedId, setCopiedId] = useState<CopiedId>(null);

  const graphState = useSpecRelevanceGraph({
    workspaceId: expanded ? workspaceId : null, // only fetch when expanded
    specSlug,
  });

  const health = useMemo(
    () => computeHealth(graphState.data, graphState.status),
    [graphState.data, graphState.status],
  );

  const handleNodeClick = useCallback((node: PositionedNode) => {
    setSelectedNode((prev) => (prev?.id === node.id ? null : node));
  }, []);

  const handleCopy = useCallback((entityId: string) => {
    navigator.clipboard.writeText(entityId).catch(() => {});
    setCopiedId(entityId);
    setTimeout(() => setCopiedId(null), 1500);
  }, []);

  const handleOpenLedger = useCallback(
    (entityId: string) => {
      // Navigate to Memory panel. The Memory panel supports query params
      // for filtering — we encode the entityId as a search query.
      if (onNavigate) {
        onNavigate('memory' as PanelId);
      }
      // Also copy to clipboard so the user can paste into the search bar
      navigator.clipboard.writeText(entityId).catch(() => {});
    },
    [onNavigate],
  );

  const toggle = useCallback(() => {
    setExpanded((v) => !v);
    setSelectedNode(null);
  }, []);

  return (
    <div
      className="border border-border/60 rounded bg-panel/40"
      data-testid="preflight-graph"
    >
      {/* Collapsed header */}
      <button
        onClick={toggle}
        className="flex items-center gap-2 w-full px-3 py-2 text-left text-xs hover:bg-accent/5 transition-colors rounded"
        aria-expanded={expanded}
        data-testid="preflight-toggle"
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Network size={12} className="text-muted" />
        <span className="font-medium text-text">Context Neighborhood</span>

        {/* Inline health badges (shown collapsed or expanded) */}
        {health.length > 0 && (
          <span className="flex items-center gap-2 ml-auto text-[10px]" data-testid="preflight-health">
            {health.map((h) => (
              <span key={h.label} className={SEVERITY_COLORS[h.severity]} title={h.label}>
                {h.value}
              </span>
            ))}
          </span>
        )}

        {/* Loading spinner in header */}
        {expanded && graphState.status === 'loading' && (
          <Loader2 size={10} className="animate-spin text-muted ml-auto" />
        )}
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-border/40">
          {/* Health summary bar */}
          {health.length > 0 && (
            <div
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-[10px] border-b border-border/30"
              data-testid="preflight-health-bar"
            >
              {health.map((h) => (
                <span key={h.label} className="flex items-center gap-1">
                  <span className="text-muted">{h.label}:</span>
                  <span className={SEVERITY_COLORS[h.severity]}>{h.value}</span>
                </span>
              ))}
            </div>
          )}

          {/* Graph view */}
          <div className="max-h-[280px] overflow-auto" data-testid="preflight-graph-view">
            <RelevanceGraphView
              state={{ status: graphState.status, data: graphState.data, error: graphState.error }}
              onNodeClick={handleNodeClick}
            />
          </div>

          {/* Node actions bar */}
          {selectedNode && (
            <NodeActions
              node={selectedNode}
              copiedId={copiedId}
              onCopy={handleCopy}
              onOpenLedger={handleOpenLedger}
            />
          )}
        </div>
      )}
    </div>
  );
}
