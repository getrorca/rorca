import { useState, useEffect, useCallback } from 'react';
import { BookOpen, Check, X, Pencil, ChevronRight, ChevronDown } from 'lucide-react';
import { apiFetch, BASE_URL } from '../lib/apiFetch';

// ─── Types ──────────────────────────────────────────────────────────────────

interface MemoryEntry {
  date: string;
  category: string;
  title: string;
  rule: string;
  context: string;
  source: string;
}

interface MemoryProposal {
  proposalId: string;
  date: string;
  category: string;
  title: string;
  rule: string;
  context: string;
  source: string;
  status: 'pending' | 'approved' | 'rejected' | 'edited';
}

const CATEGORY_COLORS: Record<string, string> = {
  Architecture: 'bg-blue-500/10 text-blue-500',
  Convention: 'bg-purple-500/10 text-purple-500',
  'Bug Fix': 'bg-red-500/10 text-red-500',
  Decision: 'bg-amber-500/10 text-amber-500',
  Pattern: 'bg-emerald-500/10 text-emerald-500',
  Gotcha: 'bg-orange-500/10 text-orange-500',
};

// ─── Hub Card ───────────────────────────────────────────────────────────────

export default function MemoryUpdatesCard({ workspaceId, onNavigateToMemory }: {
  workspaceId: string;
  onNavigateToMemory?: () => void;
}) {
  const [proposals, setProposals] = useState<MemoryProposal[]>([]);
  const [recentEntries, setRecentEntries] = useState<MemoryEntry[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [processing, setProcessing] = useState<Set<string>>(new Set());

  const fetchData = useCallback(async () => {
    // Fetch recent entries (last 5)
    try {
      const data = await apiFetch<{ items: MemoryEntry[] }>(
        `/api/memory?workspaceId=${workspaceId}&limit=5`,
        { silent: true },
      );
      setRecentEntries(data.items);
    } catch { /* ignore */ }
  }, [workspaceId]);

  // Listen for memory_proposals WAL events via SSE
  useEffect(() => {
    const es = new EventSource(`${BASE_URL}/api/pipeline/stream`);
    es.addEventListener('wal_event', (e) => {
      try {
        const evt = JSON.parse(e.data);
        if (evt.event_type === 'memory_proposals') {
          const payload = JSON.parse(evt.payload || '{}');
          if (payload.workspace_id === workspaceId && Array.isArray(payload.proposals)) {
            setProposals(prev => {
              const existingIds = new Set(prev.map(p => p.proposalId));
              const newOnes = payload.proposals.filter(
                (p: MemoryProposal) => !existingIds.has(p.proposalId)
              );
              return [...prev, ...newOnes];
            });
          }
        }
      } catch { /* ignore */ }
    });
    return () => es.close();
  }, [workspaceId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleProposal = async (proposal: MemoryProposal, action: 'approve' | 'reject') => {
    setProcessing(prev => new Set(prev).add(proposal.proposalId));
    try {
      await apiFetch('/api/memory/proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          proposals: [{
            proposalId: proposal.proposalId,
            action,
            entry: {
              date: proposal.date,
              category: proposal.category,
              title: proposal.title,
              rule: proposal.rule,
              context: proposal.context,
              source: proposal.source,
            },
          }],
        }),
      });
      setProposals(prev => prev.filter(p => p.proposalId !== proposal.proposalId));
      if (action === 'approve') fetchData();
    } catch { /* ignore */ }
    setProcessing(prev => {
      const next = new Set(prev);
      next.delete(proposal.proposalId);
      return next;
    });
  };

  const pendingProposals = proposals.filter(p => p.status === 'pending');
  const hasContent = pendingProposals.length > 0 || recentEntries.length > 0;

  if (!hasContent) return null;

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left p-4 hover:bg-surface-200 transition-colors"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BookOpen size={16} className="text-muted" />
            <span className="text-sm font-semibold text-[var(--text)]">Memory Ledger</span>
            {pendingProposals.length > 0 && (
              <span className="px-1.5 py-0.5 text-[10px] font-semibold leading-none rounded-full bg-accent text-white">
                {pendingProposals.length} new
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted">{recentEntries.length} entries</span>
            {expanded ? <ChevronDown size={14} className="text-muted" /> : <ChevronRight size={14} className="text-muted" />}
          </div>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border">
          {/* Pending proposals */}
          {pendingProposals.length > 0 && (
            <div className="px-4 py-3 space-y-2">
              <p className="text-[11px] font-medium text-accent uppercase tracking-wider">Proposed Memory Updates</p>
              {pendingProposals.map(p => (
                <div key={p.proposalId} className="p-3 border border-accent/20 rounded-lg bg-accent/5">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`px-1.5 py-0.5 text-[10px] font-semibold rounded ${CATEGORY_COLORS[p.category] ?? 'bg-gray-500/10 text-gray-500'}`}>
                      {p.category}
                    </span>
                    <span className="text-[10px] text-muted font-mono">{p.source}</span>
                  </div>
                  <p className="text-xs font-medium text-[var(--text)] mb-0.5">{p.title}</p>
                  <p className="text-[11px] text-muted">{p.rule}</p>
                  <div className="flex items-center gap-1.5 mt-2">
                    <button
                      onClick={(e) => { e.stopPropagation(); handleProposal(p, 'approve'); }}
                      disabled={processing.has(p.proposalId)}
                      className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded bg-emerald-600 text-white hover:bg-emerald-500 transition-colors disabled:opacity-50"
                    >
                      <Check size={10} />
                      Approve
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleProposal(p, 'reject'); }}
                      disabled={processing.has(p.proposalId)}
                      className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded border border-border text-muted hover:bg-bg transition-colors disabled:opacity-50"
                    >
                      <X size={10} />
                      Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Recent entries */}
          {recentEntries.length > 0 && (
            <div className="px-4 py-3 space-y-1.5">
              <p className="text-[11px] font-medium text-muted uppercase tracking-wider">Recent</p>
              {recentEntries.slice(-5).map((e, i) => (
                <div key={`${e.date}-${e.title}-${i}`} className="flex items-start gap-2 py-1">
                  <span className={`mt-0.5 px-1 py-0.5 text-[9px] font-semibold rounded shrink-0 ${CATEGORY_COLORS[e.category] ?? 'bg-gray-500/10 text-gray-500'}`}>
                    {e.category.slice(0, 4)}
                  </span>
                  <div className="min-w-0">
                    <p className="text-xs text-[var(--text)] truncate">{e.title}</p>
                    <p className="text-[10px] text-muted truncate">{e.rule}</p>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* View all link */}
          {onNavigateToMemory && (
            <div className="px-4 py-2 border-t border-border">
              <button
                onClick={(e) => { e.stopPropagation(); onNavigateToMemory(); }}
                className="text-xs text-accent hover:underline"
              >
                View all entries &rarr;
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
