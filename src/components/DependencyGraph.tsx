import { useState, useEffect, useRef } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
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

function buildMermaidText(graph: GraphResponse): string {
  const lines: string[] = ['graph TD'];

  for (const node of graph.nodes) {
    // Escape quotes in title
    const safeTitle = node.title.replace(/"/g, '#quot;');
    lines.push(`  ${node.id}["${node.id}: ${safeTitle}"]`);
  }

  for (const edge of graph.edges) {
    lines.push(`  ${edge.from} --> ${edge.to}`);
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

  // Render Mermaid when graph data changes
  useEffect(() => {
    if (!graph || graph.nodes.length === 0) {
      setSvgContent('');
      return;
    }

    let cancelled = false;
    const mermaidText = buildMermaidText(graph);

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
  }, [graph]);

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
                  {group.map(id => {
                    const node = graph.nodes.find(n => n.id === id);
                    return (
                      <span
                        key={id}
                        className="px-1.5 py-0.5 text-[10px] font-mono font-semibold rounded bg-panel border border-border text-text"
                      >
                        {id}
                      </span>
                    );
                  })}
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
      </div>
    </div>
  );
}
