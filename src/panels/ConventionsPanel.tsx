/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * CA-005: Convention Proposals Panel
 *
 * Displays convention proposals for review, with discover trigger,
 * approve/reject actions, and proposal detail view.
 */
import { useState, useEffect, useCallback } from 'react';
import {
  FileSearch, CheckCircle2, XCircle, Inbox, ChevronRight,
  Loader2, Code2, FolderTree, Shield, BookOpen, Sparkles,
} from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { apiFetch } from '../lib/apiFetch';
import { useGlobalToast } from '../contexts/ToastContext';
import AppHeader from '../components/AppHeader';

// ─── Types ──────────────────────────────────────────────────────────────────

interface StackItem {
  name: string;
  version?: string;
  source: string;
}

interface DirectoryInfo {
  path: string;
  purpose: string;
  fileCount: number;
}

interface ConventionObservation {
  category: string;
  observation: string;
  source: string;
  confidence: string;
}

interface FileGovernanceEntry {
  glob: string;
  owner: string;
  rules: string[];
}

interface SkillFile {
  filename: string;
  content: string;
}

interface ConventionProposal {
  stack: StackItem[];
  architecture: {
    pattern: string;
    entryPoints: string[];
    directories: DirectoryInfo[];
  };
  conventions: ConventionObservation[];
  fileGovernance: FileGovernanceEntry[];
  directionL3: string;
  claudeMd: string | null;
  agentsMd: string;
  skills: SkillFile[];
}

interface ProposalItem {
  id: number;
  workspaceId: string;
  proposal: ConventionProposal;
  status: 'pending' | 'approved' | 'rejected';
  rejectReason: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

// ─── Category badge colors ──────────────────────────────────────────────────

const CATEGORY_COLORS: Record<string, string> = {
  naming: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  structure: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
  testing: 'bg-green-500/15 text-green-400 border-green-500/30',
  styling: 'bg-pink-500/15 text-pink-400 border-pink-500/30',
  tooling: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  api: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30',
  database: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  general: 'bg-gray-500/15 text-gray-400 border-gray-500/30',
};

const CONFIDENCE_COLORS: Record<string, string> = {
  high: 'text-green-400',
  medium: 'text-yellow-400',
  low: 'text-red-400',
};

// ─── Component ──────────────────────────────────────────────────────────────

export default function ConventionsPanel() {
  const { workspaceId } = useWorkspace();
  const toast = useGlobalToast();
  const showToast = toast.show;

  const [proposals, setProposals] = useState<ProposalItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [discovering, setDiscovering] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [rejectingId, setRejectingId] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  // ─── Fetch proposals ──────────────────────────────────────────────────────

  const fetchProposals = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const res = await apiFetch<{ items: ProposalItem[]; total: number }>(
        `/api/conventions/proposals/${workspaceId}`,
      );
      setProposals(res.items);
    } catch {
      // Error handled by global error wiring
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    fetchProposals();
  }, [fetchProposals]);

  // ─── Discover conventions ─────────────────────────────────────────────────

  const handleDiscover = async () => {
    if (!workspaceId) return;
    setDiscovering(true);
    try {
      const res = await apiFetch<{ id: number; proposal: ConventionProposal }>('/api/conventions/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      showToast(`Discovered ${res.proposal.stack.length} stack items, ${res.proposal.conventions.length} conventions`, 'success');
      await fetchProposals();
      setSelectedId(res.id);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Discovery failed', 'error');
    } finally {
      setDiscovering(false);
    }
  };

  // ─── Approve ──────────────────────────────────────────────────────────────

  const handleApprove = async (proposalId: number) => {
    setActionLoading(true);
    try {
      const res = await apiFetch<{ ok: boolean; applied: string[] }>(
        `/api/conventions/proposals/${proposalId}/approve`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) },
      );
      showToast(`Approved: ${res.applied.join(', ')}`, 'success');
      await fetchProposals();
      setSelectedId(null);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Approve failed', 'error');
    } finally {
      setActionLoading(false);
    }
  };

  // ─── Reject ───────────────────────────────────────────────────────────────

  const handleReject = async (proposalId: number) => {
    setActionLoading(true);
    try {
      await apiFetch(`/api/conventions/proposals/${proposalId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: rejectReason || undefined }),
      });
      showToast('Proposal rejected', 'success');
      await fetchProposals();
      setSelectedId(null);
      setRejectingId(null);
      setRejectReason('');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Reject failed', 'error');
    } finally {
      setActionLoading(false);
    }
  };

  // ─── Render ───────────────────────────────────────────────────────────────

  if (!workspaceId) {
    return (
      <div className="flex flex-col h-full">
        <AppHeader
          breadcrumbs={
            <div className="flex items-center gap-2 text-sm">
              <FileSearch size={16} className="text-accent" />
              <span className="font-medium">Conventions</span>
            </div>
          }
        />
        <div className="flex items-center justify-center flex-1 text-muted text-sm">
          Select a workspace to discover conventions
        </div>
      </div>
    );
  }

  const selected = proposals.find(p => p.id === selectedId);

  return (
    <div className="flex flex-col h-full">
      <AppHeader
        breadcrumbs={
          <div className="flex items-center gap-2 text-sm">
            <FileSearch size={16} className="text-accent" />
            <span className="font-medium">Conventions</span>
            <ChevronRight size={14} className="text-muted" />
            <span className="text-muted">Proposals</span>
          </div>
        }
        actions={
          <button
            onClick={handleDiscover}
            disabled={discovering}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-accent text-white hover:bg-accent/90 disabled:opacity-50 transition-colors"
          >
            {discovering ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
            {discovering ? 'Analyzing...' : 'Discover Conventions'}
          </button>
        }
      />

      {loading ? (
        <div className="flex items-center justify-center flex-1 text-muted text-sm">
          <Loader2 size={16} className="animate-spin mr-2" />
          Loading proposals...
        </div>
      ) : proposals.length === 0 ? (
        <div className="flex items-center justify-center flex-1">
          <div className="flex flex-col items-center gap-4 p-8 border-2 border-dashed border-border rounded-lg max-w-md text-center">
            <Inbox size={48} className="text-muted/40" strokeWidth={1.2} />
            <div>
              <p className="text-sm font-medium text-text mb-1">No convention proposals</p>
              <p className="text-xs text-muted">
                Click "Discover Conventions" to analyze your workspace and generate convention artifacts for review.
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-1 min-h-0">
          {/* Left: Proposal list */}
          <div className={`flex flex-col overflow-hidden shrink-0 border-r border-border ${selected ? 'w-[320px]' : 'w-full max-w-2xl mx-auto'}`}>
            <div className="flex-1 overflow-y-auto">
              {proposals.map(p => (
                <button
                  key={p.id}
                  onClick={() => setSelectedId(p.id)}
                  className={`w-full text-left px-4 py-3 border-b border-border transition-colors ${
                    p.id === selectedId ? 'bg-accent/10' : 'hover:bg-panel'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-mono text-muted">#{p.id}</span>
                    <StatusBadge status={p.status} />
                  </div>
                  <div className="text-sm font-medium text-text mb-0.5">
                    {p.proposal.architecture.pattern} &middot; {p.proposal.stack.length} stack items
                  </div>
                  <div className="text-xs text-muted">
                    {p.proposal.conventions.length} conventions &middot; {p.proposal.skills.length} skills
                  </div>
                  <div className="text-[10px] text-muted/60 mt-1">
                    {new Date(p.createdAt).toLocaleString()}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Right: Detail view */}
          {selected && (
            <div className="flex flex-col flex-1 overflow-hidden">
              <div className="flex-1 overflow-y-auto p-4 space-y-6">
                <ProposalDetail proposal={selected.proposal} />
              </div>

              {/* Action bar */}
              {selected.status === 'pending' && (
                <div className="px-4 py-3 border-t border-border bg-bg shrink-0">
                  {rejectingId === selected.id ? (
                    <div className="space-y-2">
                      <textarea
                        value={rejectReason}
                        onChange={(e) => setRejectReason(e.target.value)}
                        placeholder="Reason for rejection (optional)"
                        className="w-full px-3 py-2 text-sm bg-panel border border-border rounded text-text placeholder:text-muted/50 focus:outline-none focus:border-accent"
                        rows={2}
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleReject(selected.id)}
                          disabled={actionLoading}
                          className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded text-sm font-medium bg-error text-white hover:bg-error/90 disabled:opacity-50"
                        >
                          <XCircle size={14} />
                          Confirm Reject
                        </button>
                        <button
                          onClick={() => { setRejectingId(null); setRejectReason(''); }}
                          className="px-4 py-2 rounded text-sm font-medium text-muted border border-border hover:text-text"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleApprove(selected.id)}
                        disabled={actionLoading}
                        className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded text-sm font-medium bg-success text-white hover:bg-success/90 disabled:opacity-50"
                      >
                        {actionLoading ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                        Approve & Apply
                      </button>
                      <button
                        onClick={() => setRejectingId(selected.id)}
                        disabled={actionLoading}
                        className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded text-sm font-medium text-error border border-error/40 hover:bg-error/10 disabled:opacity-50"
                      >
                        <XCircle size={14} />
                        Reject
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
    approved: 'bg-green-500/15 text-green-400 border-green-500/30',
    rejected: 'bg-red-500/15 text-red-400 border-red-500/30',
  };
  return (
    <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded border ${colors[status] || 'bg-gray-500/15 text-gray-400'}`}>
      {status}
    </span>
  );
}

function ProposalDetail({ proposal }: { proposal: ConventionProposal }) {
  return (
    <>
      {/* Stack */}
      <section>
        <h3 className="flex items-center gap-2 text-sm font-semibold text-text mb-2">
          <Code2 size={14} className="text-accent" />
          Detected Stack
        </h3>
        <div className="flex flex-wrap gap-1.5">
          {proposal.stack.map((s, i) => (
            <span key={i} className="px-2 py-0.5 text-xs rounded-full bg-accent/10 text-accent border border-accent/20">
              {s.name}{s.version ? ` ${s.version}` : ''}
            </span>
          ))}
        </div>
      </section>

      {/* Architecture */}
      <section>
        <h3 className="flex items-center gap-2 text-sm font-semibold text-text mb-2">
          <FolderTree size={14} className="text-accent" />
          Architecture
        </h3>
        <div className="text-xs text-muted mb-2">
          Pattern: <span className="font-medium text-text">{proposal.architecture.pattern}</span>
          {proposal.architecture.entryPoints.length > 0 && (
            <span className="ml-2">
              Entry: {proposal.architecture.entryPoints.map(e => <code key={e} className="ml-1 px-1 py-0.5 rounded bg-panel text-accent text-[10px]">{e}</code>)}
            </span>
          )}
        </div>
        {proposal.architecture.directories.length > 0 && (
          <div className="text-xs space-y-0.5">
            {proposal.architecture.directories.slice(0, 12).map(d => (
              <div key={d.path} className="flex items-center gap-2 text-muted">
                <code className="text-text w-28 shrink-0 truncate">{d.path}/</code>
                <span className="truncate">{d.purpose}</span>
                <span className="ml-auto text-muted/60 shrink-0">{d.fileCount} files</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Conventions */}
      <section>
        <h3 className="flex items-center gap-2 text-sm font-semibold text-text mb-2">
          <BookOpen size={14} className="text-accent" />
          Conventions ({proposal.conventions.length})
        </h3>
        <div className="space-y-1.5">
          {proposal.conventions.map((c, i) => (
            <div key={i} className="flex items-start gap-2 text-xs">
              <span className={`px-1.5 py-0.5 rounded border shrink-0 ${CATEGORY_COLORS[c.category] || CATEGORY_COLORS.general}`}>
                {c.category}
              </span>
              <span className="text-text">{c.observation}</span>
              <span className={`ml-auto shrink-0 ${CONFIDENCE_COLORS[c.confidence] || ''}`}>
                {c.confidence}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* File Governance */}
      <section>
        <h3 className="flex items-center gap-2 text-sm font-semibold text-text mb-2">
          <Shield size={14} className="text-accent" />
          File Governance ({proposal.fileGovernance.length} zones)
        </h3>
        <div className="space-y-2">
          {proposal.fileGovernance.map((fg, i) => (
            <div key={i} className="text-xs">
              <div className="flex items-center gap-2 mb-0.5">
                <code className="text-accent">{fg.glob}</code>
                <span className="text-muted">&rarr;</span>
                <span className="text-text font-medium">{fg.owner}</span>
              </div>
              {fg.rules.length > 0 && (
                <ul className="ml-4 text-muted space-y-0.5">
                  {fg.rules.map((r, j) => <li key={j}>- {r}</li>)}
                </ul>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Skills */}
      {proposal.skills.length > 0 && (
        <section>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-text mb-2">
            <Sparkles size={14} className="text-accent" />
            Skill Files ({proposal.skills.length})
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {proposal.skills.map((s, i) => (
              <span key={i} className="px-2 py-0.5 text-xs rounded bg-panel border border-border text-text">
                {s.filename}
              </span>
            ))}
          </div>
        </section>
      )}

      {/* Artifacts preview */}
      <section>
        <h3 className="text-sm font-semibold text-text mb-2">Generated Artifacts</h3>
        <div className="space-y-2">
          <ArtifactPreview title="Direction L3" content={proposal.directionL3} />
          <ArtifactPreview title="AGENTS.md" content={proposal.agentsMd} />
          {proposal.claudeMd && <ArtifactPreview title="CLAUDE.md (new)" content={proposal.claudeMd} />}
        </div>
      </section>
    </>
  );
}

function ArtifactPreview({ title, content }: { title: string; content: string }) {
  const [expanded, setExpanded] = useState(false);
  const preview = content.slice(0, 200);
  const hasMore = content.length > 200;

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-text bg-panel hover:bg-panel/80 transition-colors"
      >
        <span>{title}</span>
        <span className="text-muted text-[10px]">{expanded ? 'Collapse' : 'Expand'}</span>
      </button>
      {expanded ? (
        <pre className="p-3 text-[11px] text-muted bg-bg overflow-x-auto max-h-64 whitespace-pre-wrap">{content}</pre>
      ) : (
        <pre className="px-3 py-2 text-[11px] text-muted bg-bg whitespace-pre-wrap">{preview}{hasMore ? '...' : ''}</pre>
      )}
    </div>
  );
}
