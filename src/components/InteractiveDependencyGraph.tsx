/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Loader2, Maximize2, ZoomIn, ZoomOut, X } from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';
import dagre from '@dagrejs/dagre';

/* ─── Types ───────────────────────────────────────────────────────── */

interface GraphNode {
  id: string;
  title: string;
  dependsOn: string[];
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
}

interface GraphEdge {
  from: string;
  to: string;
}

interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  parallelGroups: string[][];
}

interface LayoutNode {
  id: string;
  title: string;
  status: GraphNode['status'];
  x: number;
  y: number;
  width: number;
  height: number;
}

interface LayoutEdge {
  from: string;
  to: string;
  points: { x: number; y: number }[];
  isCritical: boolean;
}

interface PopoverData {
  node: LayoutNode;
  elapsed: string;
  logTail: string[];
  screenX: number;
  screenY: number;
}

export interface DerivedStatus {
  storyId: string;
  status: GraphNode['status'];
  startedAt: string | null;
  elapsed: string;
}

interface InteractiveDependencyGraphProps {
  specId: string;
  workspaceId: string;
  runId?: number;
  /** Map of storyId → live status derived from SSE events */
  liveStatuses?: Map<string, DerivedStatus>;
}

/* ─── Status → color config ───────────────────────────────────────── */

const STATUS_COLORS: Record<GraphNode['status'], { fill: string; stroke: string; text: string }> = {
  pending:  { fill: '#3f3f46', stroke: '#71717a', text: '#fafafa' },
  running:  { fill: '#1e3a5f', stroke: '#3b82f6', text: '#93c5fd' },
  passed:   { fill: '#14532d', stroke: '#22c55e', text: '#86efac' },
  failed:   { fill: '#450a0a', stroke: '#ef4444', text: '#fca5a5' },
  skipped:  { fill: '#422006', stroke: '#eab308', text: '#fde68a' },
};

const NODE_WIDTH = 160;
const NODE_HEIGHT = 44;

/* ─── Critical path computation (longest path in DAG) ─────────────── */

function computeCriticalPath(nodes: GraphNode[], edges: GraphEdge[]): Set<string> {
  const adj = new Map<string, string[]>();
  const inDeg = new Map<string, number>();
  for (const n of nodes) {
    adj.set(n.id, []);
    inDeg.set(n.id, 0);
  }
  for (const e of edges) {
    adj.get(e.from)?.push(e.to);
    inDeg.set(e.to, (inDeg.get(e.to) || 0) + 1);
  }

  // Topological sort (Kahn's)
  const queue: string[] = [];
  for (const [id, deg] of inDeg) {
    if (deg === 0) queue.push(id);
  }
  const order: string[] = [];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    order.push(cur);
    for (const next of adj.get(cur) || []) {
      const d = (inDeg.get(next) || 1) - 1;
      inDeg.set(next, d);
      if (d === 0) queue.push(next);
    }
  }

  // Longest path via DP on topo order
  const dist = new Map<string, number>();
  const prev = new Map<string, string | null>();
  for (const id of order) {
    dist.set(id, 0);
    prev.set(id, null);
  }
  for (const id of order) {
    const d = dist.get(id)!;
    for (const next of adj.get(id) || []) {
      if (d + 1 > (dist.get(next) || 0)) {
        dist.set(next, d + 1);
        prev.set(next, id);
      }
    }
  }

  // Find the node with max distance (end of critical path)
  let maxDist = 0;
  let endNode: string | null = null;
  for (const [id, d] of dist) {
    if (d >= maxDist) {
      maxDist = d;
      endNode = id;
    }
  }

  // Trace back to build the critical path edge set
  const criticalEdges = new Set<string>();
  let cur = endNode;
  while (cur) {
    const p = prev.get(cur);
    if (p) {
      criticalEdges.add(`${p}->${cur}`);
    }
    cur = p ?? null;
  }

  return criticalEdges;
}

/* ─── Build dagre layout ──────────────────────────────────────────── */

function buildLayout(graph: GraphResponse): {
  layoutNodes: LayoutNode[];
  layoutEdges: LayoutEdge[];
  width: number;
  height: number;
} {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 40, ranksep: 60, marginx: 30, marginy: 30 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const node of graph.nodes) {
    g.setNode(node.id, { label: node.id, width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const edge of graph.edges) {
    g.setEdge(edge.from, edge.to);
  }

  dagre.layout(g);

  const criticalEdges = computeCriticalPath(graph.nodes, graph.edges);

  const layoutNodes: LayoutNode[] = graph.nodes.map(n => {
    const pos = g.node(n.id);
    return {
      id: n.id,
      title: n.title,
      status: n.status,
      x: pos.x,
      y: pos.y,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    };
  });

  const layoutEdges: LayoutEdge[] = graph.edges.map(e => {
    const edgeData = g.edge(e.from, e.to);
    return {
      from: e.from,
      to: e.to,
      points: edgeData.points || [],
      isCritical: criticalEdges.has(`${e.from}->${e.to}`),
    };
  });

  const graphLabel = g.graph();
  return {
    layoutNodes,
    layoutEdges,
    width: (graphLabel.width || 600) + 60,
    height: (graphLabel.height || 400) + 60,
  };
}

/* ─── Edge path builder ───────────────────────────────────────────── */

function edgePath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M${points[0].x},${points[0].y}`;
  if (points.length === 2) {
    return `M${points[0].x},${points[0].y}L${points[1].x},${points[1].y}`;
  }
  // Smooth curve through points
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const cx = (points[i].x + points[i + 1].x) / 2;
    const cy = (points[i].y + points[i + 1].y) / 2;
    d += `Q${points[i].x},${points[i].y},${cx},${cy}`;
  }
  const last = points[points.length - 1];
  d += `L${last.x},${last.y}`;
  return d;
}

/* ─── Component ───────────────────────────────────────────────────── */

export default function InteractiveDependencyGraph({
  specId,
  workspaceId,
  runId,
  liveStatuses,
}: InteractiveDependencyGraphProps) {
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [popover, setPopover] = useState<PopoverData | null>(null);

  // Zoom/pan state
  const [viewBox, setViewBox] = useState({ x: 0, y: 0, w: 800, h: 600 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Track graph dimensions for fit-to-screen
  const graphDims = useRef({ width: 800, height: 600 });

  // ─── Status-change ripple animation tracking ───
  // Track previous statuses to detect transitions (not initial load)
  const prevStatusesRef = useRef<Map<string, GraphNode['status']>>(new Map());
  const isInitialLoadRef = useRef(true);
  const [rippleNodes, setRippleNodes] = useState<Map<string, { status: GraphNode['status']; key: number }>>(new Map());
  const rippleKeyRef = useRef(0);

  // Fetch graph data
  useEffect(() => {
    if (!specId || !workspaceId) return;
    let cancelled = false;
    setLoading(true);
    setError('');

    const params = new URLSearchParams({ workspaceId });
    if (runId) params.set('runId', String(runId));

    apiFetch<GraphResponse>(`/api/specs/${specId}/graph?${params}`)
      .then(data => {
        if (!cancelled) {
          setGraph(data);
          setError('');
        }
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load graph');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [specId, workspaceId, runId]);

  // Detect status transitions and trigger ripple animations
  useEffect(() => {
    if (!liveStatuses || liveStatuses.size === 0) return;

    // Skip animations on initial load / bulk state restore
    if (isInitialLoadRef.current) {
      // Populate prevStatuses without triggering animations
      const initial = new Map<string, GraphNode['status']>();
      for (const [id, s] of liveStatuses) {
        initial.set(id, s.status);
      }
      prevStatusesRef.current = initial;
      isInitialLoadRef.current = false;
      return;
    }

    const newRipples = new Map<string, { status: GraphNode['status']; key: number }>();
    for (const [id, s] of liveStatuses) {
      const prev = prevStatusesRef.current.get(id);
      if (prev && prev !== s.status) {
        // Status changed — trigger ripple
        rippleKeyRef.current += 1;
        newRipples.set(id, { status: s.status, key: rippleKeyRef.current });
      }
    }

    if (newRipples.size > 0) {
      setRippleNodes(prev => {
        const merged = new Map(prev);
        for (const [id, v] of newRipples) merged.set(id, v);
        return merged;
      });

      // Clear ripples after animation completes (400ms to exceed 300ms animation)
      setTimeout(() => {
        setRippleNodes(prev => {
          const next = new Map(prev);
          for (const id of newRipples.keys()) {
            // Only remove if key matches (avoid clearing newer ripples)
            const cur = next.get(id);
            const expected = newRipples.get(id);
            if (cur && expected && cur.key === expected.key) {
              next.delete(id);
            }
          }
          return next;
        });
      }, 400);
    }

    // Update prev statuses
    const updated = new Map(prevStatusesRef.current);
    for (const [id, s] of liveStatuses) {
      updated.set(id, s.status);
    }
    prevStatusesRef.current = updated;
  }, [liveStatuses]);

  // Merge live statuses from SSE into graph nodes
  const liveGraph = useMemo((): GraphResponse | null => {
    if (!graph) return null;
    if (!liveStatuses || liveStatuses.size === 0) return graph;

    return {
      ...graph,
      nodes: graph.nodes.map(n => {
        const live = liveStatuses.get(n.id);
        if (!live) return n;
        return { ...n, status: live.status };
      }),
    };
  }, [graph, liveStatuses]);

  // Compute layout
  const layout = useMemo(() => {
    if (!liveGraph || liveGraph.nodes.length === 0) return null;
    const result = buildLayout(liveGraph);
    graphDims.current = { width: result.width, height: result.height };
    return result;
  }, [liveGraph]);

  // Fit to screen on first layout
  useEffect(() => {
    if (layout) {
      fitToScreen();
    }
  }, [layout?.layoutNodes.length]); // only re-fit when node count changes

  const fitToScreen = useCallback(() => {
    const { width, height } = graphDims.current;
    setViewBox({ x: 0, y: 0, w: width, h: height });
  }, []);

  const zoom = useCallback((factor: number) => {
    setViewBox(vb => {
      const cx = vb.x + vb.w / 2;
      const cy = vb.y + vb.h / 2;
      const nw = vb.w * factor;
      const nh = vb.h * factor;
      return { x: cx - nw / 2, y: cy - nh / 2, w: nw, h: nh };
    });
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1.1 : 0.9;
    const svg = svgRef.current;
    if (!svg) return;

    const rect = svg.getBoundingClientRect();
    const mx = (e.clientX - rect.left) / rect.width;
    const my = (e.clientY - rect.top) / rect.height;

    setViewBox(vb => {
      const nw = vb.w * factor;
      const nh = vb.h * factor;
      const nx = vb.x + (vb.w - nw) * mx;
      const ny = vb.y + (vb.h - nh) * my;
      return { x: nx, y: ny, w: nw, h: nh };
    });
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    // Only pan if clicking the background
    if ((e.target as SVGElement).tagName === 'svg' || (e.target as SVGElement).classList.contains('dag-bg')) {
      setIsPanning(true);
      setPanStart({ x: e.clientX, y: e.clientY });
      setPopover(null);
    }
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isPanning || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const dx = (e.clientX - panStart.x) / rect.width * viewBox.w;
    const dy = (e.clientY - panStart.y) / rect.height * viewBox.h;
    setViewBox(vb => ({ ...vb, x: vb.x - dx, y: vb.y - dy }));
    setPanStart({ x: e.clientX, y: e.clientY });
  }, [isPanning, panStart, viewBox.w, viewBox.h]);

  const handleMouseUp = useCallback(() => {
    setIsPanning(false);
  }, []);

  // Node click → show popover
  const handleNodeClick = useCallback((node: LayoutNode, e: React.MouseEvent) => {
    e.stopPropagation();
    const live = liveStatuses?.get(node.id);
    setPopover({
      node,
      elapsed: live?.elapsed || '',
      logTail: [],
      screenX: e.clientX,
      screenY: e.clientY,
    });
  }, [liveStatuses]);

  // Loading
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--text-muted)] text-sm gap-2">
        <Loader2 size={14} className="animate-spin" />
        Loading dependency graph...
      </div>
    );
  }

  // Error
  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <p className="text-sm text-[var(--error)] mb-1">{error}</p>
          <p className="text-xs text-[var(--text-muted)]">Could not load the dependency graph</p>
        </div>
      </div>
    );
  }

  // Empty
  if (!layout || layout.layoutNodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--text-muted)] text-sm">
        No stories found in this spec
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative w-full h-full overflow-hidden bg-[var(--bg)]">
      {/* Zoom controls */}
      <div className="absolute top-3 right-3 z-10 flex flex-col gap-1">
        <button
          onClick={() => zoom(0.8)}
          className="p-1.5 rounded bg-[var(--panel)] border border-[var(--border)] hover:bg-[var(--border)] transition-colors"
          title="Zoom in"
        >
          <ZoomIn size={14} className="text-[var(--text-muted)]" />
        </button>
        <button
          onClick={() => zoom(1.25)}
          className="p-1.5 rounded bg-[var(--panel)] border border-[var(--border)] hover:bg-[var(--border)] transition-colors"
          title="Zoom out"
        >
          <ZoomOut size={14} className="text-[var(--text-muted)]" />
        </button>
        <button
          onClick={fitToScreen}
          className="p-1.5 rounded bg-[var(--panel)] border border-[var(--border)] hover:bg-[var(--border)] transition-colors"
          title="Fit to screen"
        >
          <Maximize2 size={14} className="text-[var(--text-muted)]" />
        </button>
      </div>

      {/* Status legend */}
      <div className="absolute bottom-3 left-3 z-10 flex gap-3 px-2 py-1.5 rounded bg-[var(--panel)]/80 border border-[var(--border)] text-[10px] backdrop-blur-sm">
        {(['pending', 'running', 'passed', 'failed', 'skipped'] as const).map(status => (
          <div key={status} className="flex items-center gap-1.5">
            <span
              className="inline-block w-3 h-3 rounded border"
              style={{ background: STATUS_COLORS[status].fill, borderColor: STATUS_COLORS[status].stroke }}
            />
            <span className="text-[var(--text-muted)] capitalize">{status}</span>
          </div>
        ))}
        <div className="flex items-center gap-1.5 ml-2 pl-2 border-l border-[var(--border)]">
          <span className="inline-block w-5 h-0.5 bg-[var(--accent)]" style={{ height: 3, borderRadius: 2 }} />
          <span className="text-[var(--text-muted)]">Critical path</span>
        </div>
      </div>

      {/* SVG Canvas */}
      <svg
        ref={svgRef}
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
        className="w-full h-full"
        style={{ cursor: isPanning ? 'grabbing' : 'grab' }}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        {/* Background */}
        <rect
          className="dag-bg"
          x={viewBox.x}
          y={viewBox.y}
          width={viewBox.w}
          height={viewBox.h}
          fill="transparent"
        />

        {/* Arrow marker defs */}
        <defs>
          <marker id="arrow-normal" viewBox="0 0 10 10" refX="10" refY="5"
            markerWidth="8" markerHeight="8" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#71717a" />
          </marker>
          <marker id="arrow-critical" viewBox="0 0 10 10" refX="10" refY="5"
            markerWidth="8" markerHeight="8" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#6366f1" />
          </marker>
        </defs>

        {/* Edges */}
        {layout.layoutEdges.map((edge, i) => (
          <path
            key={i}
            d={edgePath(edge.points)}
            fill="none"
            stroke={edge.isCritical ? '#6366f1' : '#71717a'}
            strokeWidth={edge.isCritical ? 3 : 1.5}
            strokeOpacity={edge.isCritical ? 1 : 0.5}
            markerEnd={edge.isCritical ? 'url(#arrow-critical)' : 'url(#arrow-normal)'}
          />
        ))}

        {/* Nodes */}
        {layout.layoutNodes.map(node => {
          const colors = STATUS_COLORS[node.status];
          const rx = node.x - node.width / 2;
          const ry = node.y - node.height / 2;
          const isRunning = node.status === 'running';
          const ripple = rippleNodes.get(node.id);

          return (
            <g
              key={node.id}
              onClick={(e) => handleNodeClick(node, e)}
              className="cursor-pointer"
            >
              {/* Status-change ripple ring (expand + fade) */}
              {ripple && (
                <rect
                  key={`ripple-${ripple.key}`}
                  x={rx - 4}
                  y={ry - 4}
                  width={node.width + 8}
                  height={node.height + 8}
                  rx={10}
                  fill="none"
                  stroke={STATUS_COLORS[ripple.status].stroke}
                  strokeWidth={2}
                >
                  <animate attributeName="opacity" values="0.7;0" dur="300ms" fill="freeze" />
                  <animate attributeName="x" values={`${rx - 4};${rx - 10}`} dur="300ms" fill="freeze" calcMode="spline" keySplines="0 0 0.2 1" />
                  <animate attributeName="y" values={`${ry - 4};${ry - 10}`} dur="300ms" fill="freeze" calcMode="spline" keySplines="0 0 0.2 1" />
                  <animate attributeName="width" values={`${node.width + 8};${node.width + 20}`} dur="300ms" fill="freeze" calcMode="spline" keySplines="0 0 0.2 1" />
                  <animate attributeName="height" values={`${node.height + 8};${node.height + 20}`} dur="300ms" fill="freeze" calcMode="spline" keySplines="0 0 0.2 1" />
                </rect>
              )}

              {/* Running pulse ring (continuous) */}
              {isRunning && (
                <rect
                  x={rx - 3}
                  y={ry - 3}
                  width={node.width + 6}
                  height={node.height + 6}
                  rx={8}
                  fill="none"
                  stroke={colors.stroke}
                  strokeWidth={1.5}
                  opacity={0.4}
                >
                  <animate attributeName="opacity" values="0.4;0.1;0.4" dur="2s" repeatCount="indefinite" />
                </rect>
              )}

              {/* Node background — smooth fill/stroke transition on status change */}
              <rect
                x={rx}
                y={ry}
                width={node.width}
                height={node.height}
                rx={6}
                fill={colors.fill}
                stroke={colors.stroke}
                strokeWidth={2}
              >
                <animate attributeName="fill" to={colors.fill} dur="300ms" fill="freeze" />
                <animate attributeName="stroke" to={colors.stroke} dur="300ms" fill="freeze" />
              </rect>

              {/* Story ID */}
              <text
                x={node.x}
                y={node.y - 4}
                textAnchor="middle"
                fill={colors.text}
                fontSize={11}
                fontWeight={600}
                fontFamily="monospace"
              >
                {node.id}
              </text>

              {/* Title (truncated) */}
              <text
                x={node.x}
                y={node.y + 12}
                textAnchor="middle"
                fill={colors.text}
                fontSize={9}
                opacity={0.7}
              >
                {node.title.length > 22 ? node.title.slice(0, 20) + '...' : node.title}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Popover */}
      {popover && (
        <NodePopover
          popover={popover}
          onClose={() => setPopover(null)}
          containerRef={containerRef}
        />
      )}
    </div>
  );
}

/* ─── Node Popover ────────────────────────────────────────────────── */

function NodePopover({
  popover,
  onClose,
  containerRef,
}: {
  popover: PopoverData;
  onClose: () => void;
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });

  useEffect(() => {
    if (!ref.current || !containerRef.current) return;
    const container = containerRef.current.getBoundingClientRect();
    const popRect = ref.current.getBoundingClientRect();

    let left = popover.screenX - container.left + 10;
    let top = popover.screenY - container.top + 10;

    // Keep within bounds
    if (left + popRect.width > container.width) left = left - popRect.width - 20;
    if (top + popRect.height > container.height) top = top - popRect.height - 20;
    if (left < 0) left = 10;
    if (top < 0) top = 10;

    setPos({ left, top });
  }, [popover.screenX, popover.screenY, containerRef]);

  const { node, elapsed } = popover;
  const colors = STATUS_COLORS[node.status];

  return (
    <div
      ref={ref}
      className="absolute z-20 w-64 rounded-lg border border-[var(--border)] bg-[var(--panel)] shadow-xl"
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="flex items-center justify-between p-3 border-b border-[var(--border)]">
        <span className="font-mono text-xs font-semibold text-[var(--text)]">{node.id}</span>
        <button onClick={onClose} className="p-0.5 rounded hover:bg-[var(--border)]">
          <X size={12} className="text-[var(--text-muted)]" />
        </button>
      </div>
      <div className="p-3 space-y-2">
        <p className="text-sm text-[var(--text)]">{node.title}</p>
        <div className="flex items-center gap-2">
          <span
            className="px-2 py-0.5 text-[10px] font-semibold rounded capitalize"
            style={{ background: colors.fill, color: colors.text, border: `1px solid ${colors.stroke}` }}
          >
            {node.status}
          </span>
          {elapsed && (
            <span className="text-xs font-mono text-[var(--text-muted)]">{elapsed}</span>
          )}
        </div>
      </div>
    </div>
  );
}
