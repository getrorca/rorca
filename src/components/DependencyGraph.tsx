/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { AlertTriangle, Loader2, Sparkles, Check, X, RotateCcw } from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';

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

interface GraphErrorResponse {
  error: string;
  cycle?: string[];
}

interface DependencySuggestion {
  from: string;
  to: string;
  reason: string;
}

interface DetectResponse {
  suggestions: DependencySuggestion[];
}

interface DependencyGraphProps {
  specId: string;
  workspaceId: string;
  runId?: number;
}

/* ─── Status → Mermaid style mapping ─────────────────────────────── */

const STATUS_STYLES: Record<GraphNode['status'], string> = {
  pending:  'fill:#3f3f46,stroke:#71717a,color:#fafafa',
  running:  'fill:#1e3a5f,stroke:#3b82f6,color:#93c5fd',
  passed:   'fill:#14532d,stroke:#22c55e,color:#86efac',
  failed:   'fill:#450a0a,stroke:#ef4444,color:#fca5a5',
  skipped:  'fill:#422006,stroke:#eab308,color:#fde68a',
};

/* ─── Build Mermaid diagram text from graph response ─────────────── */

function buildMermaidText(
  graph: GraphResponse,
  suggestions?: DependencySuggestion[],
  acceptedSet?: Set<string>,
  rejectedSet?: Set<string>,
): string {
  const lines: string[] = ['graph TD'];

  for (const node of graph.nodes) {
    // Escape quotes in title
    const safeTitle = node.title.replace(/"/g, '#quot;');
    lines.push(`  ${node.id}["${node.id}: ${safeTitle}"]`);
  }

  for (const edge of graph.edges) {
    lines.push(`  ${edge.from} --> ${edge.to}`);
  }

  // Add suggested edges as dotted lines (only pending/accepted ones)
  if (suggestions) {
    for (const s of suggestions) {
      const key = `${s.from}->${s.to}`;
      if (rejectedSet?.has(key)) continue;
      if (acceptedSet?.has(key)) {
        // Accepted suggestions show as solid green arrows
        lines.push(`  ${s.from} -->|accepted| ${s.to}`);
      } else {
        // Pending suggestions show as dotted arrows
        lines.push(`  ${s.from} -.->|suggested| ${s.to}`);
      }
    }
  }

  // Apply status styles
  for (const node of graph.nodes) {
    const style = STATUS_STYLES[node.status];
    lines.push(`  style ${node.id} ${style}`);
  }

  return lines.join('\n');
}

/* ─── Component ───────────────────────────────────────────────────── */

export default function DependencyGraph({ specId, workspaceId, runId }: DependencyGraphProps) {
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [cycle, setCycle] = useState<string[] | null>(null);
  const [svgContent, setSvgContent] = useState('');
  const [renderError, setRenderError] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  // Suggestion state
  const [suggestions, setSuggestions] = useState<DependencySuggestion[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState('');
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [rejected, setRejected] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);

  // Fetch graph data
  useEffect(() => {
    if (!specId || !workspaceId) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    setCycle(null);

    const params = new URLSearchParams({ workspaceId });
    if (runId) params.set('runId', String(runId));

    apiFetch<GraphResponse>(`/api/specs/${specId}/graph?${params}`)
      .then(data => {
        if (!cancelled) {
          setGraph(data);
          setError('');
        }
      })
      .catch(async (err) => {
        if (cancelled) return;
        // Try to parse cycle error from response
        try {
          const text = err instanceof Error ? err.message : String(err);
          // The apiFetch throws with response text on non-ok status
          const parsed = JSON.parse(text) as GraphErrorResponse;
          if (parsed.cycle) {
            setCycle(parsed.cycle);
            setError(parsed.error);
          } else {
            setError(parsed.error || text);
          }
        } catch {
          setError(err instanceof Error ? err.message : 'Failed to load graph');
        }
        setGraph(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [specId, workspaceId, runId]);

  // Render Mermaid when graph data or suggestions change
  useEffect(() => {
    if (!graph || graph.nodes.length === 0) {
      setSvgContent('');
      return;
    }

    let cancelled = false;
    const pendingSuggestions = suggestions.filter(
      s => !rejected.has(`${s.from}->${s.to}`)
    );
    const mermaidText = buildMermaidText(graph, pendingSuggestions, accepted, rejected);

    (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: 'dark',
          themeVariables: {
            primaryColor: '#6366f1',
            primaryTextColor: '#fafafa',
            primaryBorderColor: '#3f3f46',
            lineColor: '#a1a1aa',
            secondaryColor: '#1c1c21',
            tertiaryColor: '#0f0f11',
          },
        });
        const id = `mermaid-dag-${Date.now()}`;
        const { svg } = await mermaid.render(id, mermaidText);
        if (!cancelled) {
          setSvgContent(svg);
          setRenderError('');
        }
      } catch (err) {
        if (!cancelled) {
          setRenderError(err instanceof Error ? err.message : 'Failed to render graph');
          setSvgContent('');
        }
      }
    })();

    return () => { cancelled = true; };
  }, [graph, suggestions, accepted, rejected]);

  // Detect dependencies via LLM
  const handleDetect = useCallback(async () => {
    setDetecting(true);
    setDetectError('');
    setSuggestions([]);
    setAccepted(new Set());
    setRejected(new Set());

    try {
      const data = await apiFetch<DetectResponse>(`/api/specs/${specId}/detect-dependencies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      setSuggestions(data.suggestions);
    } catch (err) {
      setDetectError(err instanceof Error ? err.message : 'Detection failed');
    } finally {
      setDetecting(false);
    }
  }, [specId, workspaceId]);

  // Accept a suggestion
  const handleAccept = useCallback((from: string, to: string) => {
    const key = `${from}->${to}`;
    setAccepted(prev => new Set(prev).add(key));
    setRejected(prev => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, []);

  // Reject a suggestion
  const handleReject = useCallback((from: string, to: string) => {
    const key = `${from}->${to}`;
    setRejected(prev => new Set(prev).add(key));
    setAccepted(prev => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, []);

  // Apply accepted dependencies
  const handleApply = useCallback(async () => {
    if (accepted.size === 0) return;
    setApplying(true);

    const deps = suggestions
      .filter(s => accepted.has(`${s.from}->${s.to}`))
      .map(s => ({ from: s.from, to: s.to }));

    try {
      await apiFetch(`/api/specs/${specId}/apply-dependencies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, dependencies: deps }),
      });
      // Clear suggestions and reload graph
      setSuggestions([]);
      setAccepted(new Set());
      setRejected(new Set());
      // Re-trigger graph fetch
      setLoading(true);
      const params = new URLSearchParams({ workspaceId });
      if (runId) params.set('runId', String(runId));
      const data = await apiFetch<GraphResponse>(`/api/specs/${specId}/graph?${params}`);
      setGraph(data);
    } catch (err) {
      setDetectError(err instanceof Error ? err.message : 'Failed to apply dependencies');
    } finally {
      setApplying(false);
      setLoading(false);
    }
  }, [accepted, suggestions, specId, workspaceId, runId]);

  const pendingSuggestions = suggestions.filter(
    s => !accepted.has(`${s.from}->${s.to}`) && !rejected.has(`${s.from}->${s.to}`)
  );

  // Loading
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm gap-2">
        <Loader2 size={14} className="animate-spin" />
        Loading dependency graph...
      </div>
    );
  }

  // Cycle error
  if (cycle) {
    return (
      <div className="p-4">
        <div className="rounded border border-error/30 bg-error/10 p-4">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle size={16} className="text-error" />
            <p className="text-sm font-medium text-error">Circular dependency detected</p>
          </div>
          <p className="text-xs text-muted mb-2">The following stories form a cycle:</p>
          <div className="flex flex-wrap gap-1.5">
            {cycle.map((id, i) => (
              <span key={i} className="inline-flex items-center gap-1">
                <span className="px-1.5 py-0.5 text-[10px] font-mono font-semibold rounded bg-error/15 text-error">
                  {id}
                </span>
                {i < cycle.length - 1 && (
                  <span className="text-muted text-xs">&rarr;</span>
                )}
              </span>
            ))}
            <span className="text-muted text-xs">&rarr;</span>
            <span className="px-1.5 py-0.5 text-[10px] font-mono font-semibold rounded bg-error/15 text-error">
              {cycle[0]}
            </span>
          </div>
        </div>
      </div>
    );
  }

  // Generic error
  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <p className="text-sm text-error mb-1">{error}</p>
          <p className="text-xs text-muted">Could not load the dependency graph</p>
        </div>
      </div>
    );
  }

  // Empty graph
  if (!graph || graph.nodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        No stories found in this spec
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      {/* Detect Dependencies button */}
      <div className="flex items-center gap-2">
        <button
          onClick={handleDetect}
          disabled={detecting}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded bg-accent/15 text-accent hover:bg-accent/25 transition-colors disabled:opacity-50"
        >
          {detecting ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Sparkles size={12} />
          )}
          {detecting ? 'Analyzing stories...' : 'Detect Missing Dependencies'}
        </button>
        {suggestions.length > 0 && (
          <span className="text-xs text-muted">
            {suggestions.length} suggestion{suggestions.length !== 1 ? 's' : ''} found
          </span>
        )}
      </div>

      {/* Detection error */}
      {detectError && (
        <div className="rounded border border-error/30 bg-error/10 p-3">
          <p className="text-xs text-error">{detectError}</p>
        </div>
      )}

      {/* Suggestion list with accept/reject controls */}
      {suggestions.length > 0 && (
        <div className="rounded border border-accent/30 bg-accent/5 p-3 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-accent">
              Suggested Dependencies
            </p>
            <div className="flex items-center gap-2">
              {accepted.size > 0 && (
                <button
                  onClick={handleApply}
                  disabled={applying}
                  className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold rounded bg-green-500/15 text-green-400 hover:bg-green-500/25 transition-colors disabled:opacity-50"
                >
                  {applying ? (
                    <Loader2 size={10} className="animate-spin" />
                  ) : (
                    <Check size={10} />
                  )}
                  Apply {accepted.size} accepted
                </button>
              )}
              <button
                onClick={() => { setSuggestions([]); setAccepted(new Set()); setRejected(new Set()); }}
                className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold rounded bg-panel border border-border text-muted hover:text-text transition-colors"
              >
                <RotateCcw size={10} />
                Dismiss all
              </button>
            </div>
          </div>

          <div className="space-y-2">
            {suggestions.map((s) => {
              const key = `${s.from}->${s.to}`;
              const isAccepted = accepted.has(key);
              const isRejected = rejected.has(key);

              return (
                <div
                  key={key}
                  className={`flex items-start gap-2 p-2 rounded border transition-colors ${
                    isAccepted
                      ? 'border-green-500/30 bg-green-500/10'
                      : isRejected
                        ? 'border-border/50 bg-panel/50 opacity-50'
                        : 'border-border bg-panel'
                  }`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span className="px-1.5 py-0.5 text-[10px] font-mono font-semibold rounded bg-accent/15 text-accent">
                        {s.from}
                      </span>
                      <span className="text-muted text-xs">&rarr;</span>
                      <span className="px-1.5 py-0.5 text-[10px] font-mono font-semibold rounded bg-accent/15 text-accent">
                        {s.to}
                      </span>
                    </div>
                    <p className="text-[11px] text-muted leading-tight">{s.reason}</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => handleAccept(s.from, s.to)}
                      className={`p-1 rounded transition-colors ${
                        isAccepted
                          ? 'bg-green-500/25 text-green-400'
                          : 'hover:bg-green-500/15 text-muted hover:text-green-400'
                      }`}
                      title="Accept"
                    >
                      <Check size={14} />
                    </button>
                    <button
                      onClick={() => handleReject(s.from, s.to)}
                      className={`p-1 rounded transition-colors ${
                        isRejected
                          ? 'bg-red-500/25 text-red-400'
                          : 'hover:bg-red-500/15 text-muted hover:text-red-400'
                      }`}
                      title="Reject"
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Summary */}
          {(accepted.size > 0 || rejected.size > 0) && (
            <div className="flex gap-3 text-[10px] text-muted pt-1 border-t border-border/50">
              <span className="text-green-400">{accepted.size} accepted</span>
              <span className="text-red-400">{rejected.size} rejected</span>
              <span>{pendingSuggestions.length} pending</span>
            </div>
          )}
        </div>
      )}

      {/* Mermaid DAG */}
      {renderError ? (
        <div className="text-sm text-error">
          <p className="font-medium mb-1">Render error</p>
          <pre className="text-xs font-mono whitespace-pre-wrap">{renderError}</pre>
        </div>
      ) : (
        <div
          ref={containerRef}
          className="border border-border rounded bg-panel p-4 overflow-x-auto"
          dangerouslySetInnerHTML={{ __html: svgContent }}
        />
      )}

      {/* Parallel groups legend */}
      {graph.parallelGroups.length > 0 && (
        <div className="border border-border rounded bg-panel p-3">
          <p className="text-xs font-medium text-text mb-2">Execution order</p>
          <div className="space-y-1.5">
            {graph.parallelGroups.map((group, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="shrink-0 w-5 h-5 flex items-center justify-center text-[10px] font-bold rounded bg-accent/15 text-accent">
                  {i + 1}
                </span>
                <div className="flex flex-wrap gap-1">
                  {group.map(id => (
                    <span
                      key={id}
                      className="px-1.5 py-0.5 text-[10px] font-mono font-semibold rounded bg-panel border border-border text-text"
                    >
                      {id}
                    </span>
                  ))}
                </div>
                {group.length > 1 && (
                  <span className="text-[10px] text-muted">(parallel)</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Status legend */}
      <div className="flex flex-wrap gap-3 text-[10px]">
        {[
          { status: 'pending', label: 'Pending', className: 'bg-[#3f3f46] border-[#71717a]' },
          { status: 'running', label: 'Running', className: 'bg-[#1e3a5f] border-[#3b82f6]' },
          { status: 'passed', label: 'Passed', className: 'bg-[#14532d] border-[#22c55e]' },
          { status: 'failed', label: 'Failed', className: 'bg-[#450a0a] border-[#ef4444]' },
          { status: 'skipped', label: 'Skipped', className: 'bg-[#422006] border-[#eab308]' },
        ].map(item => (
          <div key={item.status} className="flex items-center gap-1.5">
            <span className={`inline-block w-3 h-3 rounded border ${item.className}`} />
            <span className="text-muted">{item.label}</span>
          </div>
        ))}
        {suggestions.length > 0 && (
          <div className="flex items-center gap-1.5 ml-2 pl-2 border-l border-border">
            <span className="inline-block w-5 h-0.5 border-t-2 border-dashed border-accent" />
            <span className="text-muted">Suggested</span>
          </div>
        )}
      </div>
    </div>
  );
}
