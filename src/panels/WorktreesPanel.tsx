/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  GitBranch, ChevronRight, Plus, X, Copy, Check,
  Terminal, Trash2, AlertTriangle, Loader2,
  FileWarning, ChevronDown, ChevronUp, Eye, EyeOff, Merge, GitFork,
} from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { usePipelineSSE } from '../hooks/usePipelineSSE';
import { apiFetch } from '../lib/apiFetch';
import ErrorBanner from '../components/ErrorBanner';

// ─── Types ───────────────────────────────────────────────────────────────────

interface GitWorktree {
  path: string;
  branch: string;
  headSha: string;
  isLocked: boolean;
  isBare: boolean;
}

interface WorktreeStatus {
  branch: string;
  ahead: number;
  behind: number;
  isClean: boolean;
  modifiedFiles: string[];
}

interface ConflictFile {
  path: string;
  markers: string;
}

interface MergePreview {
  canMerge: boolean;
  hasConflicts: boolean;
  conflictFiles: ConflictFile[];
  filesChanged: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const BRANCH_RE = /^[a-z0-9]+([/\-_.][a-z0-9]+)*$/i;

function statusBadge(status: WorktreeStatus | null): { label: string; cls: string } {
  if (!status) return { label: 'loading', cls: 'bg-zinc-500/20 text-zinc-400' };
  if (!status.isClean) return { label: 'dirty', cls: 'bg-yellow-500/20 text-yellow-400' };
  if (status.ahead > 0) return { label: `ahead ${status.ahead}`, cls: 'bg-blue-500/20 text-blue-400' };
  return { label: 'clean', cls: 'bg-emerald-500/20 text-emerald-400' };
}

const MAX_FILES = 10;

// ─── Component ───────────────────────────────────────────────────────────────

export default function WorktreesPanel() {
  const { workspaceId } = useWorkspace();

  // List state
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  // Detail state
  const [detailStatus, setDetailStatus] = useState<WorktreeStatus | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Inline form
  const [showForm, setShowForm] = useState(false);
  const [formBranch, setFormBranch] = useState('');
  const [formBase, setFormBase] = useState('main');
  const [formPath, setFormPath] = useState('');
  const [formAutoPath, setFormAutoPath] = useState(true);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Remove confirmation
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
  const [removing, setRemoving] = useState(false);

  // Merge state
  type MergeState = 'idle' | 'previewing' | 'preview' | 'merging' | 'done' | 'conflict' | 'error';
  const [mergeState, setMergeState] = useState<MergeState>('idle');
  const [mergeError, setMergeError] = useState('');
  const [mergePreview, setMergePreview] = useState<MergePreview | null>(null);
  const [mergeCommitSha, setMergeCommitSha] = useState<string | null>(null);

  // Per-file conflict expand/skip state
  const [expandedConflicts, setExpandedConflicts] = useState<Record<string, boolean>>({});
  const [skippedFiles, setSkippedFiles] = useState<Record<string, boolean>>({});

  // Copy states
  const [copiedPath, setCopiedPath] = useState(false);
  const [copiedTerminal, setCopiedTerminal] = useState(false);

  // SSE for real-time updates
  const sseEvents = usePipelineSSE('all');

  const selectedWorktree = worktrees.find((w) => w.path === selectedPath) ?? null;

  // ─── Fetch worktree list ────────────────────────────────────────────────

  const fetchWorktrees = useCallback(async () => {
    if (!workspaceId) return;
    setError(null);
    try {
      const data = await apiFetch<{ items?: GitWorktree[]; worktrees?: GitWorktree[] }>(
        `/api/worktrees?workspaceId=${workspaceId}`,
      );
      setWorktrees(data.items ?? data.worktrees ?? []);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load worktrees';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    setLoading(true);
    setSelectedPath(null);
    setDetailStatus(null);
    fetchWorktrees();
  }, [fetchWorktrees]);

  // SSE: refresh list on worktree events
  useEffect(() => {
    const relevant = sseEvents.filter(
      (e) => e.event_type === 'worktree_created' || e.event_type === 'worktree_removed',
    );
    if (relevant.length > 0) {
      fetchWorktrees();
    }
  }, [sseEvents, fetchWorktrees]);

  // Reset merge state when selection changes
  useEffect(() => {
    setMergeState('idle');
    setMergeError('');
    setMergePreview(null);
    setMergeCommitSha(null);
    setExpandedConflicts({});
    setSkippedFiles({});
  }, [selectedPath]);

  // ─── Fetch detail status when selection changes ─────────────────────────

  useEffect(() => {
    if (!selectedPath || !workspaceId) {
      setDetailStatus(null);
      return;
    }
    setDetailLoading(true);
    apiFetch<WorktreeStatus>(
      `/api/worktrees/status?workspaceId=${workspaceId}&path=${encodeURIComponent(selectedPath)}`,
    )
      .then(setDetailStatus)
      .catch(() => setDetailStatus(null))
      .finally(() => setDetailLoading(false));
  }, [selectedPath, workspaceId]);

  // ─── Auto-fill worktree path from branch name ──────────────────────────

  useEffect(() => {
    if (formAutoPath && formBranch) {
      const slug = formBranch.replace(/\//g, '-');
      setFormPath(`../<repo>-${slug}`);
    }
  }, [formBranch, formAutoPath]);

  // ─── Create worktree ───────────────────────────────────────────────────

  const handleCreate = async () => {
    setFormError(null);
    if (!formBranch.trim()) {
      setFormError('Branch name is required');
      return;
    }
    if (!BRANCH_RE.test(formBranch)) {
      setFormError('Invalid branch name (use kebab-case with optional slashes)');
      return;
    }

    setCreating(true);
    try {
      const body: Record<string, string> = {
        workspaceId: workspaceId!,
        branchName: formBranch.trim(),
        baseBranch: formBase.trim() || 'main',
      };
      // Only pass worktreePath if user manually edited it
      if (!formAutoPath && formPath.trim()) {
        body.worktreePath = formPath.trim();
      }

      const result = await apiFetch<{ ok: boolean; worktreePath: string; branchName: string }>(
        '/api/worktrees',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );

      // Reset form
      setShowForm(false);
      setFormBranch('');
      setFormBase('main');
      setFormPath('');
      setFormAutoPath(true);

      // Refresh and select new worktree
      await fetchWorktrees();
      setSelectedPath(result.worktreePath);
    } catch (err: any) {
      setFormError(err.message || 'Failed to create worktree');
    } finally {
      setCreating(false);
    }
  };

  // ─── Remove worktree ──────────────────────────────────────────────────

  const handleRemove = async (force: boolean) => {
    if (!selectedPath || !workspaceId) return;
    setRemoving(true);
    try {
      const encoded = encodeURIComponent(selectedPath);
      await apiFetch(`/api/worktrees/${encoded}?workspaceId=${workspaceId}&force=${force}`, {
        method: 'DELETE',
      });
      setShowRemoveConfirm(false);
      setSelectedPath(null);
      setDetailStatus(null);
      await fetchWorktrees();
    } catch (err: any) {
      // If 409 (dirty), we shouldn't get here in non-force mode since we show the dialog
      console.error('[WorktreesPanel] remove error:', err);
      setFormError(err.message || 'Failed to remove worktree');
    } finally {
      setRemoving(false);
    }
  };

  // ─── Copy helper ──────────────────────────────────────────────────────

  const copyToClipboard = (text: string, setter: (v: boolean) => void) => {
    navigator.clipboard.writeText(text);
    setter(true);
    setTimeout(() => setter(false), 2000);
  };

  // ─── Empty states ─────────────────────────────────────────────────────

  if (!workspaceId) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--text-muted)]">
        Select a workspace to manage worktrees.
      </div>
    );
  }

  if (loading) {
    return (
      <div aria-live="polite" className="flex items-center justify-center h-full text-[var(--text-muted)]">
        <span className="sr-only">Loading...</span>
        <Loader2 className="w-5 h-5 animate-spin mr-2" aria-hidden="true" />
        Loading worktrees...
      </div>
    );
  }

  if (error) {
    return <ErrorBanner message={error} onRetry={fetchWorktrees} variant="fullscreen" />;
  }

  // ─── Main Layout ──────────────────────────────────────────────────────

  return (
    <div role="main" aria-label="Worktrees panel - manage git worktrees" className="flex flex-col md:flex-row h-full">
      {/* ── Left column: Worktree list ── */}
      <div className="w-full md:w-72 border-b md:border-b-0 md:border-r border-[var(--border)] flex flex-col md:max-h-full max-h-48 shrink-0">
        <div className="p-3 border-b border-[var(--border)] flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
            Worktrees
          </span>
          <button
            onClick={() => setShowForm(!showForm)}
            aria-label={showForm ? 'Cancel new worktree' : 'New worktree'}
            aria-expanded={showForm}
            className="p-1 rounded hover:bg-[var(--border)] transition-colors focus:outline-none focus:ring-2 focus:ring-accent/50"
            title="New Worktree"
          >
            {showForm ? (
              <X className="w-3.5 h-3.5 text-[var(--text-muted)]" />
            ) : (
              <Plus className="w-3.5 h-3.5 text-[var(--text-muted)]" />
            )}
          </button>
        </div>

        {/* ── Inline create form ── */}
        {showForm && (
          <div className="p-3 border-b border-[var(--border)] bg-[var(--surface)] space-y-2">
            <div>
              <label className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] block mb-0.5">
                Branch Name
              </label>
              <input
                type="text"
                value={formBranch}
                onChange={(e) => setFormBranch(e.target.value)}
                placeholder="feat/my-feature"
                className="w-full px-2 py-1 text-xs font-mono rounded bg-[var(--bg)] border border-[var(--border)] text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
                autoFocus
                onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] block mb-0.5">
                Base Branch
              </label>
              <input
                type="text"
                value={formBase}
                onChange={(e) => setFormBase(e.target.value)}
                placeholder="main"
                className="w-full px-2 py-1 text-xs font-mono rounded bg-[var(--bg)] border border-[var(--border)] text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
              />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] block mb-0.5">
                Worktree Path
                <span className="normal-case tracking-normal ml-1 opacity-60">(auto)</span>
              </label>
              <input
                type="text"
                value={formPath}
                onChange={(e) => {
                  setFormPath(e.target.value);
                  setFormAutoPath(false);
                }}
                placeholder="auto-derived from branch"
                className="w-full px-2 py-1 text-xs font-mono rounded bg-[var(--bg)] border border-[var(--border)] text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] opacity-70"
              />
            </div>
            {formError && (
              <p className="text-[10px] text-red-400">{formError}</p>
            )}
            <button
              onClick={handleCreate}
              disabled={creating || !formBranch.trim()}
              className="w-full px-3 py-1.5 text-xs font-medium bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {creating ? (
                <><Loader2 className="w-3 h-3 inline animate-spin mr-1" /> Creating...</>
              ) : (
                'Create'
              )}
            </button>
          </div>
        )}

        {/* ── Worktree rows ── */}
        <div className="flex-1 overflow-y-auto">
          {worktrees.length === 0 ? (
            <div className="flex items-center justify-center h-full py-16">
              <div className="flex flex-col items-center text-center max-w-md px-6">
                <GitFork size={48} className="text-[var(--text-muted)] opacity-40 mb-4" />
                <h3 className="text-lg font-semibold text-[var(--text)] mb-2">No worktrees yet</h3>
                <p className="text-sm text-[var(--text-muted)]">
                  Run a spec with auto-worktree enabled to isolate each story in its own branch. Worktrees let multiple stories execute in parallel without conflicts.
                </p>
              </div>
            </div>
          ) : (
            worktrees.map((wt) => (
              <button
                key={wt.path}
                onClick={() => setSelectedPath(wt.path)}
                aria-pressed={selectedPath === wt.path}
                aria-label={`Worktree: ${wt.branch || '(detached)'}`}
                className={`w-full text-left px-3 py-2.5 border-b border-[var(--border)] transition-colors focus:outline-none focus:ring-2 focus:ring-inset focus:ring-accent/50 ${
                  selectedPath === wt.path
                    ? 'bg-[var(--accent)]/10'
                    : 'hover:bg-[var(--surface)]'
                }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <GitBranch className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />
                  <span className="text-sm font-mono truncate flex-1">{wt.branch || '(detached)'}</span>
                  <ChevronRight className="w-3.5 h-3.5 text-[var(--text-muted)] flex-shrink-0" />
                </div>
                <div className="mt-0.5 text-[10px] text-[var(--text-muted)] truncate pl-[22px]">
                  {wt.path}
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* ── Right column: Worktree detail ── */}
      <div aria-live="polite" className="flex-1 flex flex-col min-w-0">
        {!selectedWorktree ? (
          <div className="flex items-center justify-center h-full text-[var(--text-muted)] text-sm">
            <GitBranch className="w-5 h-5 mr-2 opacity-50" />
            Select a worktree to view details
          </div>
        ) : (
          <>
            {/* ── Header ── */}
            <div className="p-4 border-b border-[var(--border)]">
              <div className="flex items-center gap-3">
                <h2 className="text-base font-mono font-medium truncate">{selectedWorktree.branch || '(detached)'}</h2>
                {detailLoading ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--text-muted)]" />
                ) : (
                  <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${statusBadge(detailStatus).cls}`}>
                    {statusBadge(detailStatus).label}
                  </span>
                )}
              </div>
            </div>

            {/* ── Info grid ── */}
            <div className="p-4 border-b border-[var(--border)] grid grid-cols-1 sm:grid-cols-2 gap-3">
              <InfoItem label="HEAD SHA" value={selectedWorktree.headSha.slice(0, 8)} mono />
              <InfoItem
                label="Worktree Path"
                value={selectedWorktree.path}
                mono
                copyable
                onCopy={() => copyToClipboard(selectedWorktree.path, setCopiedPath)}
                copied={copiedPath}
              />
              <InfoItem
                label="Branch"
                value={
                  detailStatus
                    ? `ahead ${detailStatus.ahead} | behind ${detailStatus.behind}`
                    : '...'
                }
              />
              <InfoItem
                label="Modified Files"
                value={
                  detailStatus
                    ? detailStatus.isClean
                      ? '0 (clean)'
                      : String(detailStatus.modifiedFiles.length)
                    : '...'
                }
              />
            </div>

            {/* ── Modified files list ── */}
            {detailStatus && !detailStatus.isClean && detailStatus.modifiedFiles.length > 0 && (
              <div className="border-b border-[var(--border)]">
                <div className="px-4 py-2">
                  <span className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
                    Modified Files
                  </span>
                </div>
                <div className="px-4 pb-3 space-y-0.5">
                  {detailStatus.modifiedFiles.slice(0, MAX_FILES).map((file) => (
                    <div key={file} className="text-xs font-mono text-[var(--text-muted)] flex items-center gap-1.5">
                      <span className="text-yellow-400 flex-shrink-0">M</span>
                      <span className="truncate">{file}</span>
                    </div>
                  ))}
                  {detailStatus.modifiedFiles.length > MAX_FILES && (
                    <div className="text-[10px] text-[var(--text-muted)] pl-4">
                      + {detailStatus.modifiedFiles.length - MAX_FILES} more
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── Action buttons ── */}
            <div className="p-4 space-y-2">
              {/* Copy Path */}
              <button
                onClick={() => copyToClipboard(selectedWorktree.path, setCopiedPath)}
                aria-label="Copy worktree path to clipboard"
                className="w-full flex items-center gap-2 px-3 py-2 text-xs rounded border border-[var(--border)] hover:bg-[var(--surface)] transition-colors focus:outline-none focus:ring-2 focus:ring-accent/50"
              >
                {copiedPath ? (
                  <Check className="w-3.5 h-3.5 text-emerald-500" />
                ) : (
                  <Copy className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                )}
                <span>{copiedPath ? 'Copied!' : 'Copy Path'}</span>
              </button>

              {/* Open in Terminal */}
              <button
                onClick={() => copyToClipboard(`cd ${selectedWorktree.path}`, setCopiedTerminal)}
                aria-label="Copy terminal cd command to clipboard"
                className="w-full flex items-center gap-2 px-3 py-2 text-xs rounded border border-[var(--border)] hover:bg-[var(--surface)] transition-colors focus:outline-none focus:ring-2 focus:ring-accent/50"
              >
                {copiedTerminal ? (
                  <Check className="w-3.5 h-3.5 text-emerald-500" />
                ) : (
                  <Terminal className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                )}
                <span>{copiedTerminal ? 'Copied!' : 'Open in Terminal'}</span>
                <code className="ml-auto text-[10px] font-mono text-[var(--text-muted)] truncate hidden sm:block max-w-[200px]">
                  cd {selectedWorktree.path}
                </code>
              </button>

              {/* Merge to main — only for non-main worktrees */}
              {worktrees[0]?.path !== selectedWorktree.path && selectedWorktree.branch && selectedWorktree.branch !== '(detached)' && (
                <div className="space-y-2">
                  {mergeState === 'done' ? (
                    <div className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs rounded border border-emerald-500/30 bg-emerald-500/10 text-emerald-400">
                      <Check className="w-3.5 h-3.5" />
                      <span>Merged successfully{mergeCommitSha ? ` (${mergeCommitSha.slice(0, 8)})` : ''}</span>
                    </div>
                  ) : mergeState === 'error' ? (
                    <div className="rounded border border-red-500/30 bg-red-500/10 p-2 space-y-1.5">
                      <p className="text-xs text-red-400 font-medium">Merge failed</p>
                      {mergeError && (
                        <p className="text-[10px] text-red-400/70 font-mono break-all line-clamp-3">{mergeError}</p>
                      )}
                      <button
                        onClick={() => { setMergeState('idle'); setMergeError(''); setMergePreview(null); }}
                        className="text-[10px] text-red-400 hover:text-red-300 underline"
                      >
                        Dismiss
                      </button>
                    </div>
                  ) : mergeState === 'preview' && mergePreview?.hasConflicts ? (
                    /* ── Conflict detail panel ── */
                    <div className="rounded border border-amber-500/30 bg-amber-500/5 overflow-hidden">
                      <div className="px-3 py-2 border-b border-amber-500/20 flex items-center gap-2">
                        <FileWarning className="w-3.5 h-3.5 text-amber-400" />
                        <span className="text-xs font-medium text-amber-400">
                          {mergePreview.conflictFiles.length} conflicting file{mergePreview.conflictFiles.length !== 1 ? 's' : ''}
                        </span>
                        <button
                          onClick={() => { setMergeState('idle'); setMergePreview(null); setExpandedConflicts({}); setSkippedFiles({}); }}
                          className="ml-auto text-[10px] text-amber-400 hover:text-amber-300 underline"
                        >
                          Cancel
                        </button>
                      </div>

                      {/* Per-file conflict list */}
                      <div className="max-h-64 overflow-y-auto divide-y divide-[var(--border)]">
                        {mergePreview.conflictFiles.map((cf) => (
                          <div key={cf.path} className={`${skippedFiles[cf.path] ? 'opacity-50' : ''}`}>
                            <div className="flex items-center gap-2 px-3 py-1.5">
                              {/* Expand/collapse toggle */}
                              <button
                                onClick={() => setExpandedConflicts((prev) => ({ ...prev, [cf.path]: !prev[cf.path] }))}
                                className="p-0.5 rounded hover:bg-[var(--border)]"
                              >
                                {expandedConflicts[cf.path] ? (
                                  <ChevronUp className="w-3 h-3 text-[var(--text-muted)]" />
                                ) : (
                                  <ChevronDown className="w-3 h-3 text-[var(--text-muted)]" />
                                )}
                              </button>
                              <span className="text-xs font-mono truncate flex-1">{cf.path}</span>
                              {/* Skip toggle */}
                              <button
                                onClick={() => setSkippedFiles((prev) => ({ ...prev, [cf.path]: !prev[cf.path] }))}
                                className="p-1 rounded hover:bg-[var(--border)] flex items-center gap-1"
                                title={skippedFiles[cf.path] ? 'Include this file' : 'Skip this file'}
                              >
                                {skippedFiles[cf.path] ? (
                                  <EyeOff className="w-3 h-3 text-zinc-500" />
                                ) : (
                                  <Eye className="w-3 h-3 text-amber-400" />
                                )}
                                <span className="text-[10px] text-[var(--text-muted)]">
                                  {skippedFiles[cf.path] ? 'skipped' : 'resolve'}
                                </span>
                              </button>
                            </div>

                            {/* Expanded conflict markers */}
                            {expandedConflicts[cf.path] && cf.markers && (
                              <div className="mx-3 mb-2 rounded bg-[var(--bg)] border border-[var(--border)] overflow-x-auto">
                                <pre className="text-[10px] font-mono p-2 leading-relaxed whitespace-pre-wrap">
                                  {cf.markers.split('\n').map((line, i) => {
                                    let cls = 'text-[var(--text-muted)]';
                                    if (line.startsWith('<<<<<<<')) cls = 'text-red-400 font-bold';
                                    else if (line.startsWith('=======')) cls = 'text-amber-400 font-bold';
                                    else if (line.startsWith('>>>>>>>')) cls = 'text-emerald-400 font-bold';
                                    else if (line === '---') cls = 'text-zinc-600';
                                    return (
                                      <span key={i} className={cls}>
                                        {line}
                                        {'\n'}
                                      </span>
                                    );
                                  })}
                                </pre>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>

                      {/* Force merge action */}
                      <div className="px-3 py-2 border-t border-amber-500/20 flex gap-2">
                        <button
                          disabled={mergeState === 'merging' as MergeState}
                          onClick={async () => {
                            if (!workspaceId || !selectedWorktree.branch) return;
                            setMergeState('merging');
                            setMergeError('');
                            try {
                              const result = await apiFetch<{ ok: boolean; mergeCommitSha?: string }>('/api/worktrees/merge', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ workspaceId, branchName: selectedWorktree.branch, force: true }),
                              });
                              setMergeCommitSha(result.mergeCommitSha ?? null);
                              setMergeState('done');
                            } catch (err: any) {
                              setMergeState('error');
                              setMergeError(err instanceof Error ? err.message : String(err));
                            }
                          }}
                          className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs font-medium rounded bg-amber-600 hover:bg-amber-700 text-white transition-colors disabled:opacity-50"
                        >
                          <Merge className="w-3 h-3" />
                          Force Merge (accept theirs)
                        </button>
                      </div>
                    </div>
                  ) : mergeState === 'preview' && mergePreview && !mergePreview.hasConflicts ? (
                    /* ── Clean preview — confirm merge ── */
                    <div className="rounded border border-blue-500/30 bg-blue-500/5 p-3 space-y-2">
                      <div className="flex items-center gap-2">
                        <Check className="w-3.5 h-3.5 text-blue-400" />
                        <span className="text-xs text-blue-400 font-medium">No conflicts detected</span>
                        <span className="text-[10px] text-[var(--text-muted)]">
                          ({mergePreview.filesChanged} file{mergePreview.filesChanged !== 1 ? 's' : ''} changed)
                        </span>
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => { setMergeState('idle'); setMergePreview(null); }}
                          className="px-3 py-1.5 text-xs rounded border border-[var(--border)] hover:bg-[var(--surface)] transition-colors"
                        >
                          Cancel
                        </button>
                        <button
                          disabled={mergeState === 'merging' as MergeState}
                          onClick={async () => {
                            if (!workspaceId || !selectedWorktree.branch) return;
                            setMergeState('merging');
                            setMergeError('');
                            try {
                              const result = await apiFetch<{ ok: boolean; mergeCommitSha?: string }>('/api/worktrees/merge', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ workspaceId, branchName: selectedWorktree.branch }),
                              });
                              setMergeCommitSha(result.mergeCommitSha ?? null);
                              setMergeState('done');
                            } catch (err: any) {
                              const isConflict = err?.message?.includes('CONFLICT') || err?.message?.includes('409');
                              setMergeState(isConflict ? 'conflict' : 'error');
                              setMergeError(err instanceof Error ? err.message : String(err));
                            }
                          }}
                          className="flex-1 px-3 py-1.5 text-xs font-medium rounded bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
                        >
                          Confirm Merge
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* ── Initial "Merge to main" button → triggers preview ── */
                    <button
                      disabled={mergeState === 'previewing' || mergeState === 'merging'}
                      onClick={async () => {
                        if (!workspaceId || !selectedWorktree.branch) return;
                        setMergeState('previewing');
                        setMergeError('');
                        try {
                          const preview = await apiFetch<MergePreview>('/api/worktrees/merge/preview', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ workspaceId, branchName: selectedWorktree.branch }),
                          });
                          setMergePreview(preview);
                          setMergeState('preview');
                          // Auto-expand first conflict for visibility
                          if (preview.hasConflicts && preview.conflictFiles.length > 0) {
                            setExpandedConflicts({ [preview.conflictFiles[0].path]: true });
                          }
                        } catch (err: any) {
                          setMergeState('error');
                          setMergeError(err instanceof Error ? err.message : String(err));
                        }
                      }}
                      className="w-full flex items-center gap-2 px-3 py-2 text-xs rounded border border-blue-500/30 text-blue-400 hover:bg-blue-500/10 transition-colors disabled:opacity-50"
                    >
                      {mergeState === 'previewing' ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : mergeState === 'merging' ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <GitBranch className="w-3.5 h-3.5" />
                      )}
                      <span>{mergeState === 'previewing' ? 'Checking for conflicts...' : mergeState === 'merging' ? 'Merging...' : 'Merge to main'}</span>
                    </button>
                  )}
                </div>
              )}

              {/* Remove Worktree */}
              {!selectedWorktree.isBare && (
                <button
                  onClick={() => setShowRemoveConfirm(true)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs rounded border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Remove Worktree</span>
                </button>
              )}
            </div>

            {/* ── Remove confirmation dialog ── */}
            {showRemoveConfirm && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
                <div className="bg-[var(--panel)] border border-[var(--border)] rounded-lg p-4 max-w-sm w-full mx-4 shadow-xl">
                  <div className="flex items-start gap-3 mb-3">
                    <AlertTriangle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
                    <div>
                      <h3 className="text-sm font-medium">Remove Worktree</h3>
                      <p className="text-xs text-[var(--text-muted)] mt-1">
                        This will remove the worktree at:
                      </p>
                      <code className="text-xs font-mono text-[var(--text)] block mt-1 break-all">
                        {selectedWorktree.path}
                      </code>
                      {detailStatus && !detailStatus.isClean && (
                        <div className="mt-2 p-2 rounded bg-yellow-500/10 border border-yellow-500/20">
                          <p className="text-xs text-yellow-400">
                            This worktree has unsaved changes ({detailStatus.modifiedFiles.length} modified files). Use --force?
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-2 justify-end">
                    <button
                      onClick={() => setShowRemoveConfirm(false)}
                      className="px-3 py-1.5 text-xs rounded border border-[var(--border)] hover:bg-[var(--surface)] transition-colors"
                      disabled={removing}
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => handleRemove(detailStatus ? !detailStatus.isClean : false)}
                      disabled={removing}
                      className="px-3 py-1.5 text-xs font-medium rounded bg-red-600 hover:bg-red-700 text-white transition-colors disabled:opacity-50"
                    >
                      {removing ? (
                        <><Loader2 className="w-3 h-3 inline animate-spin mr-1" /> Removing...</>
                      ) : detailStatus && !detailStatus.isClean ? (
                        'Force Remove'
                      ) : (
                        'Remove'
                      )}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── InfoItem sub-component ──────────────────────────────────────────────────

function InfoItem({
  label,
  value,
  mono,
  copyable,
  onCopy,
  copied,
}: {
  label: string;
  value: string;
  mono?: boolean;
  copyable?: boolean;
  onCopy?: () => void;
  copied?: boolean;
}) {
  return (
    <div className="min-w-0">
      <span className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] block mb-0.5">
        {label}
      </span>
      <div className="flex items-center gap-1 min-w-0">
        <span className={`text-xs truncate ${mono ? 'font-mono' : ''}`}>{value}</span>
        {copyable && onCopy && (
          <button
            onClick={onCopy}
            className="p-0.5 rounded hover:bg-[var(--border)] flex-shrink-0"
          >
            {copied ? (
              <Check className="w-3 h-3 text-emerald-500" />
            ) : (
              <Copy className="w-3 h-3 text-[var(--text-muted)]" />
            )}
          </button>
        )}
      </div>
    </div>
  );
}
