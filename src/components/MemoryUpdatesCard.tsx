/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useCallback } from 'react';
import { BookOpen, Check, X, Pencil, ChevronRight, ChevronDown, CheckCheck, Undo2 } from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';

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
  status: 'pending' | 'approved' | 'rejected' | 'dismissed';
  runId?: number;
}

const CATEGORY_COLORS: Record<string, string> = {
  Architecture: 'bg-blue-500/10 text-blue-500',
  Convention: 'bg-purple-500/10 text-purple-500',
  'Bug Fix': 'bg-red-500/10 text-red-500',
  Decision: 'bg-amber-500/10 text-amber-500',
  Pattern: 'bg-emerald-500/10 text-emerald-500',
  Gotcha: 'bg-orange-500/10 text-orange-500',
  'Follow-up': 'bg-amber-500/10 text-amber-500',
  'Run Synthesis': 'bg-cyan-500/10 text-cyan-500',
};

const CATEGORIES = ['Architecture', 'Convention', 'Bug Fix', 'Decision', 'Pattern', 'Gotcha', 'Follow-up', 'Run Synthesis'];

// ─── Inline Edit Form ───────────────────────────────────────────────────────

function InlineEditForm({ proposal, onSave, onCancel }: {
  proposal: MemoryProposal;
  onSave: (edits: { title: string; rule: string; context: string; category: string }) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(proposal.title);
  const [rule, setRule] = useState(proposal.rule);
  const [context, setContext] = useState(proposal.context);
  const [category, setCategory] = useState(proposal.category);

  return (
    <div className="p-3 border border-accent/30 rounded-lg bg-accent/5 space-y-2">
      <div className="flex items-center gap-2">
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-bg border border-border text-[var(--text)]"
        >
          {CATEGORIES.map(c => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <span className="text-[10px] text-muted font-mono">{proposal.source}</span>
      </div>
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="w-full px-2 py-1 text-xs font-medium bg-bg border border-border rounded text-[var(--text)] focus:border-accent focus:ring-1 focus:ring-accent"
        placeholder="Title"
      />
      <input
        type="text"
        value={rule}
        onChange={(e) => setRule(e.target.value)}
        className="w-full px-2 py-1 text-[11px] bg-bg border border-border rounded text-[var(--text)] focus:border-accent focus:ring-1 focus:ring-accent"
        placeholder="Rule"
      />
      <input
        type="text"
        value={context}
        onChange={(e) => setContext(e.target.value)}
        className="w-full px-2 py-1 text-[11px] bg-bg border border-border rounded text-[var(--text)] focus:border-accent focus:ring-1 focus:ring-accent"
        placeholder="Context"
      />
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => onSave({ title, rule, context, category })}
          className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded bg-emerald-600 text-white hover:bg-emerald-500 transition-colors"
        >
          <Check size={10} />
          Save
        </button>
        <button
          onClick={onCancel}
          className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded border border-border text-muted hover:bg-bg transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── Hub Card ───────────────────────────────────────────────────────────────

export default function MemoryUpdatesCard({ workspaceId, onNavigateToMemory }: {
  workspaceId: string;
  onNavigateToMemory?: () => void;
}) {
  const [proposals, setProposals] = useState<MemoryProposal[]>([]);
  const [recentEntries, setRecentEntries] = useState<MemoryEntry[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [processing, setProcessing] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [batchProcessing, setBatchProcessing] = useState(false);
  const [dismissedCount, setDismissedCount] = useState(0);

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

  // Fetch persisted proposals from DB on mount and after actions
  const fetchProposals = useCallback(async () => {
    try {
      const data = await apiFetch<{ items: MemoryProposal[] }>(
        `/api/memory/proposals?workspaceId=${workspaceId}&status=pending`,
        { silent: true },
      );
      setProposals(data.items);
    } catch { /* ignore */ }

    // Also check dismissed count for the "restore" button
    try {
      const dismissed = await apiFetch<{ items: MemoryProposal[] }>(
        `/api/memory/proposals?workspaceId=${workspaceId}&status=dismissed`,
        { silent: true },
      );
      setDismissedCount(dismissed.items.length);
    } catch { /* ignore */ }
  }, [workspaceId]);

  // Poll for new memory proposals every 30s (avoids opening a dedicated SSE connection)
  useEffect(() => {
    const interval = setInterval(fetchProposals, 30_000);
    return () => clearInterval(interval);
  }, [fetchProposals]);

  useEffect(() => { fetchData(); fetchProposals(); }, [fetchData, fetchProposals]);

  const handleProposal = async (proposal: MemoryProposal, action: 'approve' | 'reject', edits?: { title: string; rule: string; context: string; category: string }) => {
    setProcessing(prev => new Set(prev).add(proposal.proposalId));
    try {
      const payload: Record<string, unknown> = {
        proposalId: proposal.proposalId,
        action: edits ? 'edit' : action,
        entry: {
          date: proposal.date,
          category: edits?.category ?? proposal.category,
          title: edits?.title ?? proposal.title,
          rule: edits?.rule ?? proposal.rule,
          context: edits?.context ?? proposal.context,
          source: proposal.source,
        },
      };
      if (edits) {
        payload.edits = edits;
      }

      await apiFetch('/api/memory/proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          proposals: [payload],
        }),
      });
      setProposals(prev => prev.filter(p => p.proposalId !== proposal.proposalId));
      setEditingId(null);
      if (action === 'approve' || edits) fetchData();
    } catch { /* ignore */ }
    setProcessing(prev => {
      const next = new Set(prev);
      next.delete(proposal.proposalId);
      return next;
    });
  };

  const handleBatchApprove = async () => {
    const pending = proposals.filter(p => p.status === 'pending');
    if (pending.length === 0) return;

    setBatchProcessing(true);
    try {
      const batchPayload = pending.map(p => ({
        proposalId: p.proposalId,
        action: 'approve' as const,
        entry: {
          date: p.date,
          category: p.category,
          title: p.title,
          rule: p.rule,
          context: p.context,
          source: p.source,
        },
      }));

      await apiFetch('/api/memory/proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, proposals: batchPayload }),
      });
      setProposals([]);
      fetchData();
    } catch { /* ignore */ }
    setBatchProcessing(false);
  };

  const handleDismissAll = async () => {
    const pending = proposals.filter(p => p.status === 'pending');
    if (pending.length === 0) return;

    setBatchProcessing(true);
    try {
      await apiFetch('/api/memory/proposals/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          proposalIds: pending.map(p => p.proposalId),
        }),
      });
      setProposals([]);
      setDismissedCount(prev => prev + pending.length);
    } catch { /* ignore */ }
    setBatchProcessing(false);
  };

  const handleRestoreDismissed = async () => {
    setBatchProcessing(true);
    try {
      await apiFetch('/api/memory/proposals/undismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      setDismissedCount(0);
      fetchProposals();
    } catch { /* ignore */ }
    setBatchProcessing(false);
  };

  const pendingProposals = proposals.filter(p => p.status === 'pending');
  const hasContent = pendingProposals.length > 0 || recentEntries.length > 0 || dismissedCount > 0;

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
              <div className="flex items-center justify-between">
                <p className="text-[11px] font-medium text-accent uppercase tracking-wider">Proposed Memory Updates</p>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={(e) => { e.stopPropagation(); handleBatchApprove(); }}
                    disabled={batchProcessing}
                    className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded bg-emerald-600 text-white hover:bg-emerald-500 transition-colors disabled:opacity-50"
                    title="Approve all proposals"
                  >
                    <CheckCheck size={10} />
                    Approve all
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDismissAll(); }}
                    disabled={batchProcessing}
                    className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded border border-border text-muted hover:bg-bg transition-colors disabled:opacity-50"
                    title="Dismiss all — you can review later"
                  >
                    <X size={10} />
                    Dismiss
                  </button>
                </div>
              </div>
              {pendingProposals.map(p => (
                editingId === p.proposalId ? (
                  <InlineEditForm
                    key={p.proposalId}
                    proposal={p}
                    onSave={(edits) => handleProposal(p, 'approve', edits)}
                    onCancel={() => setEditingId(null)}
                  />
                ) : (
                  <div key={p.proposalId} className="p-3 border border-accent/20 rounded-lg bg-accent/5">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`px-1.5 py-0.5 text-[10px] font-semibold rounded ${CATEGORY_COLORS[p.category] ?? 'bg-gray-500/10 text-gray-500'}`}>
                        {p.category}
                      </span>
                      <span className="text-[10px] text-muted font-mono">{p.source}</span>
                      {p.runId && (
                        <span className="text-[10px] text-muted font-mono">run #{p.runId}</span>
                      )}
                    </div>
                    <p className="text-xs font-medium text-[var(--text)] mb-0.5">{p.title}</p>
                    <p className="text-[11px] text-muted">{p.rule}</p>
                    {p.context && (
                      <p className="text-[10px] text-muted/70 mt-0.5 italic">{p.context}</p>
                    )}
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
                        onClick={(e) => { e.stopPropagation(); setEditingId(p.proposalId); }}
                        disabled={processing.has(p.proposalId)}
                        className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded border border-border text-muted hover:bg-bg transition-colors disabled:opacity-50"
                      >
                        <Pencil size={10} />
                        Edit
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
                )
              ))}
            </div>
          )}

          {/* Dismissed proposals restore option */}
          {dismissedCount > 0 && pendingProposals.length === 0 && (
            <div className="px-4 py-3">
              <button
                onClick={(e) => { e.stopPropagation(); handleRestoreDismissed(); }}
                disabled={batchProcessing}
                className="inline-flex items-center gap-1.5 text-xs text-accent hover:underline disabled:opacity-50"
              >
                <Undo2 size={12} />
                {dismissedCount} dismissed {dismissedCount === 1 ? 'proposal' : 'proposals'} — click to review
              </button>
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
