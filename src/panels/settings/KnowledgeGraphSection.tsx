import { useState, useEffect } from 'react';
import { CheckCircle2, XCircle, Loader2, Share2 } from 'lucide-react';
import { apiFetch } from '../../lib/apiFetch';

/* ─── Types ───────────────────────────────────────────────────────────────── */

interface GraphStatsResponse {
  available: boolean;
  vertexCount: number;
  edgeCount: number;
  graphName: string;
  lastPopulatedAt: string | null;
}

/* ─── Helpers ─────────────────────────────────────────────────────────────── */

function formatTimestamp(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

/* ─── Component ───────────────────────────────────────────────────────────── */

export function KnowledgeGraphSection() {
  const [stats, setStats] = useState<GraphStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function fetch() {
      try {
        const data = await apiFetch<GraphStatsResponse>('/api/graph/stats');
        if (!cancelled) setStats(data);
      } catch (err) {
        if (!cancelled) setError('Failed to load graph stats');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetch();
    return () => { cancelled = true; };
  }, []);

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-primary">Knowledge Graph</h2>
        <p className="text-xs text-muted mt-0.5">
          Apache AGE graph database for codebase relationship tracking
        </p>
      </div>

      <div className="border border-border rounded-lg p-4 bg-bg">
        {loading && (
          <div className="flex items-center gap-2 text-muted">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-xs">Loading graph stats…</span>
          </div>
        )}

        {error && !loading && (
          <div className="flex items-center gap-2 text-muted">
            <XCircle className="w-4 h-4 text-red-400" />
            <span className="text-xs">{error}</span>
          </div>
        )}

        {stats && !loading && !error && (
          <>
            {/* Status badge */}
            <div className="flex items-center gap-2 mb-4">
              <Share2 size={16} className="text-muted" />
              <span className="text-sm font-medium text-[var(--text)]">Status</span>
              <span className="ml-auto">
                {stats.available ? (
                  <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium bg-green-500/10 text-green-400 border border-green-500/20">
                    <CheckCircle2 className="w-3 h-3" />
                    Available
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium bg-red-500/10 text-red-400 border border-red-500/20">
                    <XCircle className="w-3 h-3" />
                    Unavailable
                  </span>
                )}
              </span>
            </div>

            {stats.available ? (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="bg-surface border border-border rounded-lg p-3">
                  <p className="text-[10px] uppercase tracking-wide text-muted mb-1">Vertices</p>
                  <p className="text-lg font-semibold text-primary">{stats.vertexCount.toLocaleString()}</p>
                </div>
                <div className="bg-surface border border-border rounded-lg p-3">
                  <p className="text-[10px] uppercase tracking-wide text-muted mb-1">Edges</p>
                  <p className="text-lg font-semibold text-primary">{stats.edgeCount.toLocaleString()}</p>
                </div>
                <div className="bg-surface border border-border rounded-lg p-3">
                  <p className="text-[10px] uppercase tracking-wide text-muted mb-1">Graph Name</p>
                  <p className="text-sm font-mono text-primary">{stats.graphName}</p>
                </div>
                <div className="bg-surface border border-border rounded-lg p-3">
                  <p className="text-[10px] uppercase tracking-wide text-muted mb-1">Last Populated</p>
                  <p className="text-xs text-primary">{formatTimestamp(stats.lastPopulatedAt)}</p>
                </div>
              </div>
            ) : (
              <div className="bg-surface border border-border rounded-lg p-4 text-center">
                <p className="text-sm text-muted">
                  Knowledge graph not available — install Apache AGE extension
                </p>
                <p className="text-xs text-muted/60 mt-1">
                  Use self-hosted PostgreSQL with AGE for full graph support.
                  The graph layer is optional — core functionality works without it.
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

export default KnowledgeGraphSection;
