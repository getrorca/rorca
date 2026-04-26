import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  X, Search, CheckSquare, Square, Loader2,
  AlertCircle, RefreshCw, ExternalLink, Tag, User,
  ChevronLeft, Plus,
} from 'lucide-react';
import { Github } from './icons/GithubIcon';
import { apiFetch } from '../lib/apiFetch';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useGlobalToast } from '../contexts/ToastContext';

/* ─── Types ───────────────────────────────────────────────────────── */

interface GitHubRepo {
  id: number;
  fullName: string;
  name: string;
  owner: string;
  description: string | null;
  private: boolean;
  openIssuesCount: number;
  updatedAt: string;
  htmlUrl: string;
}

interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  body: string;
  htmlUrl: string;
  labels: Array<{ name: string; color: string }>;
  assignee: { login: string; avatarUrl: string } | null;
  createdAt: string;
}

interface GitHubImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSpecCreated: (specId: string) => void;
}

type ModalStep = 'repos' | 'issues' | 'creating';

/* ─── Skeleton List Item ─────────────────────────────────────────── */

function SkeletonItem() {
  return (
    <div className="flex items-start gap-3 px-4 py-3 border-b border-border last:border-0 animate-pulse">
      <div className="mt-0.5 w-4 h-4 rounded bg-border shrink-0" />
      <div className="flex-1 min-w-0 space-y-1.5">
        <div className="h-3.5 bg-border rounded w-3/5" />
        <div className="h-3 bg-border rounded w-4/5" />
        <div className="h-3 bg-border rounded w-2/5" />
      </div>
    </div>
  );
}

/* ─── Main Component ─────────────────────────────────────────────── */

export default function GitHubImportModal({ isOpen, onClose, onSpecCreated }: GitHubImportModalProps) {
  const { workspaceId } = useWorkspace();
  const toast = useGlobalToast();

  const [step, setStep] = useState<ModalStep>('repos');

  // Repos state
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [reposError, setReposError] = useState<string | null>(null);
  const [repoSearch, setRepoSearch] = useState('');
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepo | null>(null);

  // Issues state
  const [issues, setIssues] = useState<GitHubIssue[]>([]);
  const [issuesLoading, setIssuesLoading] = useState(false);
  const [issuesError, setIssuesError] = useState<string | null>(null);
  const [issueSearch, setIssueSearch] = useState('');
  const [selectedIssueIds, setSelectedIssueIds] = useState<Set<number>>(new Set());

  // Create state
  const [creating, setCreating] = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);

  // ─── Fetch repos ─────────────────────────────────────────────────

  const fetchRepos = useCallback(async () => {
    if (!workspaceId) return;
    setReposLoading(true);
    setReposError(null);
    try {
      const data = await apiFetch<{ repos: GitHubRepo[] }>(
        `/api/workspaces/${workspaceId}/github/repos`
      );
      setRepos(data.repos);
    } catch (err: any) {
      setReposError(err.message || 'Failed to load repositories — check GitHub connection');
    } finally {
      setReposLoading(false);
    }
  }, [workspaceId]);

  // ─── Fetch issues for selected repo ──────────────────────────────

  const fetchIssues = useCallback(async (repo: GitHubRepo) => {
    if (!workspaceId) return;
    setIssuesLoading(true);
    setIssuesError(null);
    setIssues([]);
    setSelectedIssueIds(new Set());
    try {
      const data = await apiFetch<{ issues: GitHubIssue[] }>(
        `/api/workspaces/${workspaceId}/github/repos/${repo.owner}/${repo.name}/issues`
      );
      setIssues(data.issues);
    } catch (err: any) {
      setIssuesError(err.message || 'Failed to load issues — check GitHub connection');
    } finally {
      setIssuesLoading(false);
    }
  }, [workspaceId]);

  // Load repos when modal opens
  useEffect(() => {
    if (isOpen && workspaceId) {
      fetchRepos();
    }
  }, [isOpen, workspaceId, fetchRepos]);

  // Focus search on step change
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => searchRef.current?.focus(), 100);
    }
  }, [isOpen, step]);

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setStep('repos');
      setSelectedRepo(null);
      setRepoSearch('');
      setIssueSearch('');
      setSelectedIssueIds(new Set());
      setRepos([]);
      setIssues([]);
    }
  }, [isOpen]);

  // Escape key handler
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  // ─── Handlers ────────────────────────────────────────────────────

  const handleSelectRepo = useCallback((repo: GitHubRepo) => {
    setSelectedRepo(repo);
    setStep('issues');
    setIssueSearch('');
    fetchIssues(repo);
  }, [fetchIssues]);

  const handleBackToRepos = useCallback(() => {
    setStep('repos');
    setSelectedRepo(null);
    setIssues([]);
    setIssuesError(null);
  }, []);

  const toggleIssue = useCallback((issueNumber: number) => {
    setSelectedIssueIds(prev => {
      const next = new Set(prev);
      if (next.has(issueNumber)) {
        next.delete(issueNumber);
      } else {
        next.add(issueNumber);
      }
      return next;
    });
  }, []);

  const toggleAllIssues = useCallback(() => {
    const filteredNums = issues
      .filter(i => !issueSearch || i.title.toLowerCase().includes(issueSearch.toLowerCase()))
      .map(i => i.number);

    setSelectedIssueIds(prev => {
      const allSelected = filteredNums.every(n => prev.has(n));
      if (allSelected) {
        const next = new Set(prev);
        filteredNums.forEach(n => next.delete(n));
        return next;
      } else {
        const next = new Set(prev);
        filteredNums.forEach(n => next.add(n));
        return next;
      }
    });
  }, [issues, issueSearch]);

  const handleCreateSpec = useCallback(async () => {
    if (!workspaceId || !selectedRepo || selectedIssueIds.size === 0) return;
    setCreating(true);
    setStep('creating');

    try {
      const result = await apiFetch<{ specId: string; storyCount: number }>(
        `/api/workspaces/${workspaceId}/github/import-issues`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            owner: selectedRepo.owner,
            repo: selectedRepo.name,
            issueNumbers: Array.from(selectedIssueIds),
          }),
        }
      );
      toast.success(`Created spec with ${result.storyCount} stories from GitHub`);
      onSpecCreated(result.specId);
      onClose();
    } catch (err: any) {
      toast.error(err.message || 'Failed to create spec from issues');
      // Go back to issues step so user can retry
      setStep('issues');
    } finally {
      setCreating(false);
    }
  }, [workspaceId, selectedRepo, selectedIssueIds, toast, onSpecCreated, onClose]);

  // ─── Filtered lists ───────────────────────────────────────────────

  const filteredRepos = repos.filter(r =>
    !repoSearch || r.fullName.toLowerCase().includes(repoSearch.toLowerCase())
  );

  const filteredIssues = issues.filter(i =>
    !issueSearch || i.title.toLowerCase().includes(issueSearch.toLowerCase())
  );

  const filteredSelectedCount = filteredIssues.filter(i => selectedIssueIds.has(i.number)).length;
  const allFilteredSelected = filteredIssues.length > 0 && filteredSelectedCount === filteredIssues.length;

  if (!isOpen) return null;

  // ─── Render ───────────────────────────────────────────────────────

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label="Import from GitHub"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal */}
      <div className="relative z-10 w-full max-w-xl mx-4 bg-panel border border-border rounded-xl shadow-2xl flex flex-col max-h-[80vh] overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0">
          {step === 'issues' && (
            <button
              onClick={handleBackToRepos}
              className="p-1 rounded hover:bg-surface text-muted hover:text-[var(--text)] transition-colors"
              title="Back to repositories"
              aria-label="Back to repositories"
            >
              <ChevronLeft size={16} />
            </button>
          )}
          <Github size={16} className="text-muted shrink-0" />
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-[var(--text)] truncate">
              {step === 'repos' && 'Import from GitHub'}
              {step === 'issues' && selectedRepo && `${selectedRepo.fullName}`}
              {step === 'creating' && 'Creating Spec…'}
            </h2>
            {step === 'issues' && selectedRepo && (
              <p className="text-xs text-muted">Select issues to import as stories</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-surface text-muted hover:text-[var(--text)] transition-colors"
            aria-label="Close"
          >
            <X size={15} />
          </button>
        </div>

        {/* ─── Step: Repos ─── */}
        {step === 'repos' && (
          <>
            {/* Search */}
            <div className="px-4 py-2 border-b border-border shrink-0">
              <div className="relative">
                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
                <input
                  ref={searchRef}
                  type="text"
                  placeholder="Filter repositories…"
                  value={repoSearch}
                  onChange={e => setRepoSearch(e.target.value)}
                  className="w-full pl-8 pr-3 py-1.5 text-sm bg-surface border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-accent text-[var(--text)] placeholder:text-muted"
                />
              </div>
            </div>

            {/* Repo list */}
            <div className="flex-1 overflow-y-auto min-h-0">
              {reposLoading && (
                <div className="divide-y divide-border">
                  {Array.from({ length: 6 }).map((_, i) => <SkeletonItem key={i} />)}
                </div>
              )}

              {reposError && (
                <div className="flex flex-col items-center justify-center gap-3 py-12 px-6 text-center">
                  <AlertCircle size={20} className="text-error" />
                  <p className="text-sm text-[var(--text)]">Failed to load — check GitHub connection</p>
                  <p className="text-xs text-muted">{reposError}</p>
                  <button
                    onClick={fetchRepos}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-surface border border-border hover:bg-panel transition-colors text-[var(--text)]"
                  >
                    <RefreshCw size={12} />
                    Retry
                  </button>
                </div>
              )}

              {!reposLoading && !reposError && filteredRepos.length === 0 && (
                <div className="flex flex-col items-center justify-center gap-2 py-12 px-6 text-center">
                  <Github size={20} className="text-muted" />
                  <p className="text-sm text-muted">
                    {repoSearch ? `No repositories matching "${repoSearch}"` : 'No repositories found'}
                  </p>
                  {!repoSearch && (
                    <p className="text-xs text-muted">
                      Make sure your GitHub account has repositories and the OAuth token has <code>repo</code> scope.
                    </p>
                  )}
                </div>
              )}

              {!reposLoading && !reposError && filteredRepos.length > 0 && (
                <ul className="divide-y divide-border">
                  {filteredRepos.map(repo => (
                    <li key={repo.id}>
                      <button
                        onClick={() => handleSelectRepo(repo)}
                        className="w-full text-left flex items-start gap-3 px-4 py-3 hover:bg-surface transition-colors group"
                      >
                        <Github size={14} className="mt-0.5 text-muted group-hover:text-[var(--text)] shrink-0 transition-colors" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-sm font-medium text-[var(--text)] truncate">{repo.fullName}</span>
                            {repo.private && (
                              <span className="text-[10px] px-1 py-px rounded bg-border text-muted shrink-0">private</span>
                            )}
                          </div>
                          {repo.description && (
                            <p className="text-xs text-muted mt-0.5 line-clamp-1">{repo.description}</p>
                          )}
                          <p className="text-xs text-muted mt-0.5">
                            {repo.openIssuesCount} open issue{repo.openIssuesCount !== 1 ? 's' : ''}
                          </p>
                        </div>
                        <ChevronLeft size={13} className="mt-1 rotate-180 text-muted group-hover:text-accent shrink-0 transition-colors" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}

        {/* ─── Step: Issues ─── */}
        {step === 'issues' && (
          <>
            {/* Search + select-all */}
            <div className="px-4 py-2 border-b border-border shrink-0 space-y-2">
              <div className="relative">
                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
                <input
                  ref={searchRef}
                  type="text"
                  placeholder="Filter issues…"
                  value={issueSearch}
                  onChange={e => setIssueSearch(e.target.value)}
                  className="w-full pl-8 pr-3 py-1.5 text-sm bg-surface border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-accent text-[var(--text)] placeholder:text-muted"
                />
              </div>

              {!issuesLoading && !issuesError && filteredIssues.length > 0 && (
                <button
                  onClick={toggleAllIssues}
                  className="flex items-center gap-1.5 text-xs text-muted hover:text-[var(--text)] transition-colors"
                >
                  {allFilteredSelected ? <CheckSquare size={13} className="text-accent" /> : <Square size={13} />}
                  {allFilteredSelected ? 'Deselect all' : `Select all (${filteredIssues.length})`}
                </button>
              )}
            </div>

            {/* Issue list */}
            <div className="flex-1 overflow-y-auto min-h-0">
              {issuesLoading && (
                <div className="divide-y divide-border">
                  {Array.from({ length: 5 }).map((_, i) => <SkeletonItem key={i} />)}
                </div>
              )}

              {issuesError && (
                <div className="flex flex-col items-center justify-center gap-3 py-12 px-6 text-center">
                  <AlertCircle size={20} className="text-error" />
                  <p className="text-sm text-[var(--text)]">Failed to load — check GitHub connection</p>
                  <p className="text-xs text-muted">{issuesError}</p>
                  <button
                    onClick={() => selectedRepo && fetchIssues(selectedRepo)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-surface border border-border hover:bg-panel transition-colors text-[var(--text)]"
                  >
                    <RefreshCw size={12} />
                    Retry
                  </button>
                </div>
              )}

              {!issuesLoading && !issuesError && filteredIssues.length === 0 && (
                <div className="flex flex-col items-center justify-center gap-2 py-12 px-6 text-center">
                  <AlertCircle size={20} className="text-muted" />
                  <p className="text-sm text-muted">
                    {issueSearch
                      ? `No issues matching "${issueSearch}"`
                      : 'No open issues in this repo'}
                  </p>
                  {!issueSearch && (
                    <p className="text-xs text-muted">
                      There are no open issues in <strong>{selectedRepo?.fullName}</strong>.
                    </p>
                  )}
                </div>
              )}

              {!issuesLoading && !issuesError && filteredIssues.length > 0 && (
                <ul className="divide-y divide-border">
                  {filteredIssues.map(issue => {
                    const selected = selectedIssueIds.has(issue.number);
                    return (
                      <li key={issue.id}>
                        <button
                          onClick={() => toggleIssue(issue.number)}
                          className={`w-full text-left flex items-start gap-3 px-4 py-3 transition-colors ${selected ? 'bg-accent/5 hover:bg-accent/10' : 'hover:bg-surface'}`}
                        >
                          <span className="mt-0.5 shrink-0">
                            {selected
                              ? <CheckSquare size={14} className="text-accent" />
                              : <Square size={14} className="text-muted" />
                            }
                          </span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-start justify-between gap-2">
                              <span className={`text-sm font-medium ${selected ? 'text-[var(--text)]' : 'text-[var(--text)]'}`}>
                                {issue.title}
                              </span>
                              <a
                                href={issue.htmlUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={e => e.stopPropagation()}
                                className="shrink-0 text-muted hover:text-accent transition-colors mt-0.5"
                                aria-label={`Open issue #${issue.number} on GitHub`}
                              >
                                <ExternalLink size={11} />
                              </a>
                            </div>
                            <div className="flex items-center gap-2 mt-1 flex-wrap">
                              <span className="text-xs text-muted">#{issue.number}</span>
                              {issue.assignee && (
                                <span className="flex items-center gap-1 text-xs text-muted">
                                  <User size={10} />
                                  {issue.assignee.login}
                                </span>
                              )}
                              {issue.labels.slice(0, 3).map(label => (
                                <span
                                  key={label.name}
                                  className="flex items-center gap-1 text-[10px] px-1.5 py-px rounded-full font-medium"
                                  style={{
                                    backgroundColor: `#${label.color}22`,
                                    color: `#${label.color}`,
                                    border: `1px solid #${label.color}44`,
                                  }}
                                >
                                  <Tag size={9} />
                                  {label.name}
                                </span>
                              ))}
                            </div>
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-border shrink-0">
              <p className="text-xs text-muted">
                {selectedIssueIds.size === 0
                  ? 'Select issues to import'
                  : `${selectedIssueIds.size} issue${selectedIssueIds.size !== 1 ? 's' : ''} selected`
                }
              </p>
              <button
                onClick={handleCreateSpec}
                disabled={selectedIssueIds.size === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-accent text-white hover:bg-accent-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Plus size={13} />
                Create Spec
              </button>
            </div>
          </>
        )}

        {/* ─── Step: Creating ─── */}
        {step === 'creating' && (
          <div className="flex flex-col items-center justify-center gap-4 py-16 px-6 text-center">
            <Loader2 size={24} className="text-accent animate-spin" />
            <div>
              <p className="text-sm font-medium text-[var(--text)]">Creating spec…</p>
              <p className="text-xs text-muted mt-1">
                Importing {selectedIssueIds.size} issue{selectedIssueIds.size !== 1 ? 's' : ''} from {selectedRepo?.fullName}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
