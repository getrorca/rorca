/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Search,
  X,
  Clock,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Archive,
  Download,
  Copy,
  Check,
  ChevronRight,
  Play,
  GitBranch,
  GitFork,
  Loader2,
  Plus,
  Sparkles,
  Upload,
  ExternalLink,
  History,
} from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useAuth } from '../contexts/AuthContext';
import { apiFetch } from '../lib/apiFetch';
import { useNavigate } from 'react-router';
import { triggerPipeline, triggerReceiptRunId } from '../api/pipeline';
import TriggerPopover, { type TriggerOptions } from '../components/TriggerPopover';
import PricingModal from '../components/PricingModal';
import { StoryCard } from '../components/StoryCard';
import type { Story } from '../components/StoryCard';
import { InlineStoryEditor } from '../components/InlineStoryEditor';
import { StoryComments } from '../components/StoryComments';
import DependencyGraph from '../components/DependencyGraph';
import MermaidDiagram from '../components/MermaidDiagram';
import { ReadinessRing } from '../components/ReadinessRing';
import { TagChipsReadonly, TagChips } from '../components/TagChips';
import { SpecVersionHistory } from '../components/SpecVersionHistory';
import AppHeader from '../components/AppHeader';

/* ─── Types ───────────────────────────────────────────────────────── */

type SpecStatus = 'pending' | 'approved' | 'rejected' | 'completed';
type StatusFilter = 'all' | SpecStatus;
type PreviewTab = 'stories' | 'graph' | 'diagram' | 'json' | 'history';

type ReviewStatus = 'draft' | 'review_requested' | 'approved' | 'changes_requested';

interface ArchiveSpec {
  id: string;
  specName: string;
  storyCount: number;
  status: SpecStatus;
  generatedAt: string;
  approvedAt?: string;
  rejectedAt?: string;
  rejectReason?: string;
  storyTitles: string[];
  repoName?: string;
  branchName?: string;
  readinessPercent?: number;
  tags: string[];
  forkedFrom?: string;
  reviewStatus?: ReviewStatus;
  source?: string;
  model?: string;
}

interface ArchiveResponse {
  items: ArchiveSpec[];
  total: number;
  hasMore: boolean;
  cursor?: string;
}

interface SpecDetail {
  title?: string;
  userStories?: Story[];
  stories?: Story[];
  diagrams?: Record<string, { mermaid?: string; ascii?: string }>;
  mermaidDiagram?: string;
  readinessPercent?: number;
  [key: string]: unknown;
}

/* ─── Constants ──────────────────────────────────────────────────── */

const PAGE_SIZE = 20;

const STATUS_FILTERS: { id: StatusFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'completed', label: 'Completed' },
  { id: 'approved', label: 'Approved' },
  { id: 'pending', label: 'Pending' },
  { id: 'rejected', label: 'Rejected' },
];

const STATUS_CONFIG: Record<SpecStatus, { label: string; icon: typeof CheckCircle2; className: string; dotClass: string }> = {
  completed: {
    label: 'COMPLETED',
    icon: CheckCircle2,
    className: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    dotClass: 'bg-emerald-500',
  },
  approved: {
    label: 'APPROVED',
    icon: CheckCircle2,
    className: 'bg-success/15 text-success border-success/30',
    dotClass: 'bg-success',
  },
  pending: {
    label: 'PENDING',
    icon: AlertCircle,
    className: 'bg-warning/15 text-warning border-warning/30',
    dotClass: 'bg-warning',
  },
  rejected: {
    label: 'REJECTED',
    icon: XCircle,
    className: 'bg-error/15 text-error border-error/30',
    dotClass: 'bg-error',
  },
};

/* ─── Helpers ─────────────────────────────────────────────────────── */

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

function extractDiagramText(spec: SpecDetail): { text: string; type: 'mermaid' | 'ascii' } | null {
  // Prefer the dedicated mermaidDiagram field (story dependency diagram)
  if (spec.mermaidDiagram && typeof spec.mermaidDiagram === 'string' && spec.mermaidDiagram.trim()) {
    return { text: spec.mermaidDiagram, type: 'mermaid' };
  }
  if (!spec.diagrams) return null;
  for (const value of Object.values(spec.diagrams)) {
    if (typeof value === 'object' && value !== null) {
      if (value.mermaid) return { text: value.mermaid, type: 'mermaid' };
      if (value.ascii) return { text: value.ascii, type: 'ascii' };
    }
  }
  return null;
}

/* ─── Main Component ──────────────────────────────────────────────── */

export default function ArchivePanel() {
  const { workspaceId } = useWorkspace();

  const [specs, setSpecs] = useState<ArchiveSpec[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');

  const [searchText, setSearchText] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [tagFilter, setTagFilter] = useState<string[]>([]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [specDetail, setSpecDetail] = useState<SpecDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ─── Debounce search ────────────────────────────────────────────
  useEffect(() => {
    clearTimeout(debounceRef.current ?? undefined);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(searchText);
    }, 300);
    return () => clearTimeout(debounceRef.current ?? undefined);
  }, [searchText]);

  // ─── Fetch specs ────────────────────────────────────────────────
  const fetchSpecs = useCallback(async (offset = 0, append = false) => {
    if (!workspaceId) return;
    if (!append) setLoading(true);
    else setLoadingMore(true);
    setError('');

    try {
      const params = new URLSearchParams({
        workspaceId,
        status: statusFilter,
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      if (debouncedSearch) params.set('q', debouncedSearch);
      if (tagFilter.length > 0) params.set('tags', tagFilter.join(','));

      const res = await apiFetch<ArchiveResponse>(`/api/specs/archive?${params}`);
      if (append) {
        setSpecs(prev => [...prev, ...res.items]);
      } else {
        setSpecs(res.items);
      }
      setTotal(res.total);
      setHasMore(res.hasMore);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load specs');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [workspaceId, statusFilter, debouncedSearch, tagFilter]);

  useEffect(() => {
    setSelectedId(null);
    setSpecDetail(null);
    fetchSpecs(0, false);
  }, [fetchSpecs]);

  // ─── Fetch detail when selected ─────────────────────────────────
  useEffect(() => {
    if (!selectedId || !workspaceId) {
      setSpecDetail(null);
      return;
    }

    const selected = specs.find(s => s.id === selectedId);
    if (selected?.status === 'rejected') {
      setSpecDetail(null);
      return;
    }

    let cancelled = false;
    setDetailLoading(true);
    apiFetch<SpecDetail>(`/api/specs/${selectedId}?workspaceId=${workspaceId}`)
      .then(detail => {
        if (!cancelled) setSpecDetail(detail);
      })
      .catch(() => {
        if (!cancelled) setSpecDetail(null);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => { cancelled = true; };
  }, [selectedId, workspaceId, specs]);

  // ─── Load more handler ─────────────────────────────────────────
  const handleLoadMore = () => {
    fetchSpecs(specs.length, true);
  };

  // ─── No workspace ──────────────────────────────────────────────
  if (!workspaceId) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        Select a workspace to view the spec archive
      </div>
    );
  }

  // ─── Error state ───────────────────────────────────────────────
  if (error && !loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <p className="text-sm text-error mb-2">{error}</p>
          <button
            onClick={() => fetchSpecs()}
            className="text-xs text-accent hover:text-accent-hover transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const selectedSpec = specs.find(s => s.id === selectedId);

  const allTags = Array.from(new Set(specs.flatMap(s => s.tags || []))).sort();

  return (
    <div className="flex flex-col h-full bg-bg overflow-hidden">
      <AppHeader
        breadcrumbs={
          <div className="flex items-center gap-2">
            <span className="font-medium text-[var(--text)] text-sm tracking-tight">
              {workspaceId ? 'Workspace' : 'Global'}
            </span>
            <ChevronRight size={14} className="text-muted" />
            <span className="text-sm text-muted">Archive</span>
          </div>
        }
        actions={
          <div className="flex items-center gap-2 flex-wrap flex-1 max-w-full justify-end pb-1 pt-1 pr-2">
            {/* Search bar */}
            <div className="relative w-48 shrink-0">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
              <input
                type="text"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                placeholder="Search archive..."
                className="w-full h-8 pl-8 pr-8 bg-panel border gap-3 border-border rounded text-sm text-text placeholder-muted/60 focus:outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/40 transition-shadow transition-colors"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    setSearchText(e.currentTarget.value);
                  }
                }}
              />
              {searchText && (
                <button
                  onClick={() => setSearchText('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-text transition-colors"
                  title="Clear search"
                >
                  <X size={14} />
                </button>
              )}
            </div>

            {/* Filters */}
            <div className="flex gap-2 shrink-0">
              {/* Type Filter */}
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                className="h-8 px-2 pr-8 bg-transparent border border-border/50 rounded text-sm text-muted hover:text-text focus:outline-none focus:border-accent/40 transition-colors cursor-pointer appearance-none"
                style={{
                  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`,
                  backgroundRepeat: 'no-repeat',
                  backgroundPosition: 'right 8px center',
                }}
              >
                {STATUS_FILTERS.map(f => (
                  <option key={f.id} value={f.id}>
                    {f.id === 'all' ? 'Any Status' : f.label}
                  </option>
                ))}
              </select>

              {/* Tag Filter */}
              <select
                value={tagFilter.length > 0 ? tagFilter[0] : 'all'}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val === 'all') setTagFilter([]);
                  else setTagFilter([val]);
                }}
                className="h-8 px-2 pr-8 bg-transparent border border-border/50 rounded text-sm text-muted hover:text-text focus:outline-none focus:border-accent/40 transition-colors cursor-pointer appearance-none max-w-[100px]"
                style={{
                  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`,
                  backgroundRepeat: 'no-repeat',
                  backgroundPosition: 'right 8px center',
                }}
              >
                <option value="all">Any Tag</option>
                {allTags.map(tag => (
                  <option key={tag} value={tag}>{tag}</option>
                ))}
              </select>
            </div>
          </div>
        }
      />

      <div className="flex flex-1 overflow-hidden">
        {/* ─── Left: Split List ────────────────────────────────────────── */}
        <div
          className={`flex-col border-r border-border transition-all duration-300 ${selectedId ? 'w-1/3 min-w-[320px] max-w-[500px]' : 'w-full'
            }`}
        >
          <div className="flex flex-col h-full bg-panel">
            {/* Results */}
            <div className="flex-1 overflow-y-auto">
              {loading ? (
                <div className="flex items-center justify-center h-full text-muted text-sm">
                  Loading specs...
                </div>
              ) : specs.length === 0 ? (
                <div className="flex items-center justify-center h-full">
                  <div className="flex flex-col items-center gap-4 p-8 border-2 border-dashed border-border rounded-lg max-w-xs text-center">
                    <Archive size={64} className="text-muted/40" strokeWidth={1.2} />
                    <div>
                      {debouncedSearch ? (
                        <>
                          <p className="text-sm font-medium text-text mb-1">
                            No specs match &ldquo;{debouncedSearch}&rdquo;
                          </p>
                          <p className="text-xs text-muted">Try a different keyword</p>
                        </>
                      ) : (
                        <>
                          <p className="text-sm font-medium text-text mb-1">
                            No specs generated yet
                          </p>
                          <p className="text-xs text-muted">
                            Create your first in Spec Forge
                          </p>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <div>
                  {specs.map(spec => {
                    const cfg = STATUS_CONFIG[spec.status];
                    const Icon = cfg.icon;
                    return (
                      <button
                        key={spec.id}
                        onClick={() => setSelectedId(spec.id === selectedId ? null : spec.id)}
                        className={`w-full text-left px-4 py-3 border-b border-border transition-colors ${spec.id === selectedId ? 'bg-accent/10' : 'hover:bg-panel'
                          }`}
                      >
                        {/* Row 1: status badge + date + story count + readiness */}
                        <div className="flex items-center justify-between mb-1.5">
                          <div className="flex items-center gap-2">
                            <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold rounded border ${cfg.className}`}>
                              <Icon size={10} />
                              {cfg.label}
                            </span>
                            <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-accent/15 text-accent">
                              {spec.storyCount} {spec.storyCount === 1 ? 'story' : 'stories'}
                            </span>
                            {spec.reviewStatus && spec.reviewStatus !== 'draft' && (
                              <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded border ${spec.reviewStatus === 'review_requested' ? 'bg-accent/15 text-accent border-accent/30' :
                                spec.reviewStatus === 'approved' ? 'bg-success/15 text-success border-success/30' :
                                  'bg-warning/15 text-warning border-warning/30'
                                }`}>
                                {spec.reviewStatus === 'review_requested' ? 'Needs Review' :
                                  spec.reviewStatus === 'approved' ? 'Review OK' :
                                    'Changes Req.'}
                              </span>
                            )}
                            {spec.source === 'quick-run' && (
                              <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-purple-500/15 text-purple-400 border border-purple-500/30">
                                Quick Run
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            {spec.readinessPercent != null && (
                              <ReadinessRing percent={spec.readinessPercent} size={28} />
                            )}
                            <span className="text-[10px] text-muted flex items-center gap-1">
                              <Clock size={10} />
                              {formatDate(spec.generatedAt)}
                            </span>
                            <ChevronRight
                              size={14}
                              className={`shrink-0 text-muted transition-transform ${spec.id === selectedId ? 'rotate-90' : ''
                                }`}
                            />
                          </div>
                        </div>

                        {/* Row 2: spec name + repo badge + branch badge */}
                        <div className="flex items-center gap-2 mb-1 min-w-0">
                          <span className="text-sm font-mono font-semibold text-text truncate">
                            {spec.specName}
                          </span>
                          {spec.repoName && (
                            <span className="shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded bg-panel border border-border text-muted font-mono">
                              {spec.repoName}
                            </span>
                          )}
                          {spec.branchName && (
                            <span className="shrink-0 flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded bg-panel border border-border text-muted font-mono">
                              <GitBranch className="w-2.5 h-2.5" />
                              {spec.branchName.replace('feat/', '')}
                            </span>
                          )}
                          {spec.forkedFrom && (
                            <span className="shrink-0 flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded bg-accent/10 border border-accent/20 text-accent font-mono">
                              <GitFork className="w-2.5 h-2.5" />
                              {spec.forkedFrom}
                            </span>
                          )}
                        </div>

                        {/* Tags */}
                        {spec.tags?.length > 0 && (
                          <div className="mb-1">
                            <TagChipsReadonly
                              tags={spec.tags}
                              onTagClick={tag => {
                                if (!tagFilter.includes(tag)) {
                                  setTagFilter(prev => [...prev, tag]);
                                }
                              }}
                            />
                          </div>
                        )}

                        {/* Row 3: first 2 story titles */}
                        {spec.storyTitles.length > 0 && (
                          <div className="space-y-0.5">
                            {spec.storyTitles.slice(0, 2).map((title, i) => (
                              <p key={i} className="text-xs text-muted truncate">
                                {spec.storyTitles.length > 0 ? `US-${String(i + 1).padStart(3, '0')}: ` : ''}{title}
                              </p>
                            ))}
                          </div>
                        )}

                        {/* Reject reason (if rejected) */}
                        {spec.status === 'rejected' && spec.rejectReason && (
                          <p className="text-xs text-error/70 mt-1 truncate">
                            Reason: {spec.rejectReason}
                          </p>
                        )}
                      </button>
                    );
                  })}

                  {/* Pagination footer */}
                  <div className="px-4 py-3 border-b border-border text-center">
                    <p className="text-xs text-muted mb-2">
                      Showing {specs.length} of {total} specs
                    </p>
                    {hasMore && (
                      <button
                        onClick={handleLoadMore}
                        disabled={loadingMore}
                        className="px-4 py-1.5 text-xs font-medium rounded bg-panel border border-border text-text hover:bg-accent/10 transition-colors disabled:opacity-50"
                      >
                        {loadingMore ? 'Loading...' : 'Load more'}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* ─── Right: Spec Detail ─────────────────────────────────── */}
          {selectedId && (
            <SpecPreviewDrawer
              specId={selectedId}
              summary={selectedSpec ?? null}
              detail={specDetail}
              detailLoading={detailLoading}
              onClose={() => { setSelectedId(null); setSpecDetail(null); }}
              onTagsChange={(newTags) => {
                setSpecs(prev => prev.map(s => s.id === selectedId ? { ...s, tags: newTags } : s));
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Spec Preview Drawer ──────────────────────────────────────────── */

type RunState = 'idle' | 'triggering' | 'conflict' | 'success' | 'error';

function SpecPreviewDrawer({
  specId,
  summary,
  detail,
  detailLoading,
  onClose,
  onTagsChange,
}: {
  specId: string;
  summary: ArchiveSpec | null;
  detail: SpecDetail | null;
  detailLoading: boolean;
  onClose: () => void;
  onTagsChange: (tags: string[]) => void;
}) {
  const { workspaceId } = useWorkspace();
  const { user } = useAuth();
  const routerNavigate = useNavigate();
  const [showPricing, setShowPricing] = useState(false);
  const userPlan = user?.app_metadata?.plan as string | undefined;
  const isFreePlan = !userPlan || userPlan === 'free';
  const [activeTab, setActiveTab] = useState<PreviewTab>('stories');
  const [runState, setRunState] = useState<RunState>('idle');
  const [runError, setRunError] = useState('');
  const [showTriggerPopover, setShowTriggerPopover] = useState(false);
  const [addState, setAddState] = useState<'idle' | 'form' | 'generating' | 'done' | 'error'>('idle');
  const [addCount, setAddCount] = useState(3);
  const [addBrief, setAddBrief] = useState('');
  const [addError, setAddError] = useState('');
  const [forkState, setForkState] = useState<'idle' | 'forking' | 'done' | 'error'>('idle');
  const [forkError, setForkError] = useState('');
  const [forkId, setForkId] = useState('');
  // Import stories state
  const [importState, setImportState] = useState<'idle' | 'form' | 'loading' | 'preview' | 'importing' | 'done' | 'error'>('idle');
  const [importSource, setImportSource] = useState<'linear' | 'github'>('linear');
  const [importError, setImportError] = useState('');
  const [importPreviewStories, setImportPreviewStories] = useState<Array<{ id: string; title: string; description: string; sourceUrl: string; tags: string[] }>>([]);
  // Linear fields
  const [linearApiKey, setLinearApiKey] = useState('');
  const [linearTeamId, setLinearTeamId] = useState('');
  const [linearProjectId, setLinearProjectId] = useState('');
  // GitHub fields
  const [importGithubToken, setImportGithubToken] = useState('');
  const [importGithubOwner, setImportGithubOwner] = useState('');
  const [importGithubRepo, setImportGithubRepo] = useState('');
  const [importGithubMilestone, setImportGithubMilestone] = useState('');
  const [localStories, setLocalStories] = useState<Story[]>([]);

  // Sync localStories when spec detail loads or changes
  useEffect(() => {
    setLocalStories(detail?.userStories ?? detail?.stories ?? []);
  }, [detail]);

  const handleToggleExclude = async (storyId: string) => {
    if (!workspaceId) return;
    const story = localStories.find(s => s.id === storyId);
    if (!story) return;
    const newExcluded = !story.excluded;
    // Optimistic update
    setLocalStories(prev => prev.map(s => s.id === storyId ? { ...s, excluded: newExcluded } : s));
    try {
      await apiFetch(`/api/specs/${specId}/stories/${storyId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, excluded: newExcluded }),
      });
    } catch {
      // Revert on failure
      setLocalStories(prev => prev.map(s => s.id === storyId ? { ...s, excluded: story.excluded } : s));
    }
  };

  const handleAddStories = async () => {
    if (!workspaceId || !summary) return;
    setAddState('generating');
    setAddError('');
    try {
      const res = await apiFetch<{ ok: boolean; addedCount: number }>(
        `/api/specs/${summary.id}/add-stories`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId, count: addCount, brief: addBrief || undefined }),
        }
      );
      if (res.ok) {
        setAddState('done');
        setAddBrief('');
        setTimeout(() => setAddState('idle'), 3000);
      }
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Failed to generate stories');
      setAddState('error');
    }
  };

  const handleImportPreview = async () => {
    if (!workspaceId || !summary) return;
    setImportState('loading');
    setImportError('');
    try {
      const payload: Record<string, unknown> = {
        workspaceId,
        source: importSource,
        preview: true,
      };
      if (importSource === 'linear') {
        if (!linearApiKey) { setImportError('Linear API key is required'); setImportState('form'); return; }
        payload.linearApiKey = linearApiKey;
        if (linearTeamId) payload.linearTeamId = linearTeamId;
        if (linearProjectId) payload.linearProjectId = linearProjectId;
      } else {
        if (!importGithubToken || !importGithubOwner || !importGithubRepo) {
          setImportError('GitHub token, owner, and repo are required');
          setImportState('form');
          return;
        }
        payload.githubToken = importGithubToken;
        payload.githubOwner = importGithubOwner;
        payload.githubRepo = importGithubRepo;
        if (importGithubMilestone) payload.githubMilestone = importGithubMilestone;
      }

      const res = await apiFetch<{ ok: boolean; stories: Array<{ id: string; title: string; description: string; sourceUrl: string; tags: string[] }>; errors: string[] }>(
        `/api/specs/${summary.id}/import`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
      );
      if (res.ok) {
        setImportPreviewStories(res.stories);
        setImportState('preview');
      }
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Failed to fetch issues');
      setImportState('form');
    }
  };

  const handleImportCommit = async () => {
    if (!workspaceId || !summary) return;
    setImportState('importing');
    setImportError('');
    try {
      const payload: Record<string, unknown> = {
        workspaceId,
        source: importSource,
        preview: false,
      };
      if (importSource === 'linear') {
        payload.linearApiKey = linearApiKey;
        if (linearTeamId) payload.linearTeamId = linearTeamId;
        if (linearProjectId) payload.linearProjectId = linearProjectId;
      } else {
        payload.githubToken = importGithubToken;
        payload.githubOwner = importGithubOwner;
        payload.githubRepo = importGithubRepo;
        if (importGithubMilestone) payload.githubMilestone = importGithubMilestone;
      }

      const res = await apiFetch<{ ok: boolean; importedCount: number }>(
        `/api/specs/${summary.id}/import`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
      );
      if (res.ok) {
        setImportState('done');
        setImportPreviewStories([]);
        setTimeout(() => setImportState('idle'), 3000);
      }
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Failed to import issues');
      setImportState('error');
    }
  };

  // Canonical dispatch: strict preflight + immutable receipt, then navigate to
  // the exact returned run identity — never to the Runs root.
  const handleRun = async (autoWorktree: boolean, options?: TriggerOptions) => {
    if (!workspaceId || !summary) return;
    setShowTriggerPopover(false);
    setRunState('triggering');
    setRunError('');
    try {
      const result = await triggerPipeline({
        specPath: `forge/specs/approved/${summary.id}.json`,
        workspaceId,
        autoWorktree,
        autoMerge: options?.autoMerge,
        mergeStrategy: options?.mergeStrategy,
        forceSequential: options?.forceSequential,
        orchestrationMode: options?.orchestrationMode,
        parallelism: options?.parallelism,
        qualificationReceiptId: options?.qualificationReceiptId,
        rolloutCohort: options?.rolloutCohort,
        includeGraph: options?.includeGraph,
        terminal_mode: options?.terminal_mode,
        effortLevel: options?.effortLevel,
        thinkingEnabled: options?.thinkingEnabled,
        thinkingBudget: options?.thinkingBudget,
        reasoning: options?.reasoningOverride,
        agentOverride: options?.agentOverride,
        executionEnvironment: options?.executionEnvironment,
      });
      if ('conflict' in result) {
        setRunState('conflict');
        return;
      }
      const destinationRunId = triggerReceiptRunId(result);
      if (destinationRunId === null) throw new Error('Dispatch did not return a run identity');
      setRunState('success');
      setTimeout(() => routerNavigate(`/runs/${destinationRunId}`), 1200);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'Failed to trigger run');
      setRunState('error');
    }
  };

  // Reset tab when spec changes
  useEffect(() => {
    setActiveTab('stories');
  }, [specId]);

  const stories = localStories;
  const diagram = detail ? extractDiagramText(detail) : null;
  const deferredCount = stories.filter(s => s.excluded && !s.passes).length;

  const tabs: { id: PreviewTab; label: string; badge?: string; icon?: typeof History }[] = [
    { id: 'stories', label: 'Stories', badge: `${stories.length}` },
    { id: 'history', label: 'History', icon: History },
    { id: 'graph', label: 'Graph' },
    { id: 'diagram', label: 'Dependencies' },
    { id: 'json', label: 'Raw JSON' },
  ];

  const handleExportJson = () => {
    if (!detail) return;
    const blob = new Blob([JSON.stringify(detail, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${specId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleFork = async () => {
    if (!workspaceId || !summary) return;
    setForkState('forking');
    setForkError('');
    try {
      const res = await apiFetch<{ ok: boolean; forkId: string }>(
        `/api/specs/${summary.id}/fork`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId }),
        }
      );
      if (res.ok) {
        setForkId(res.forkId);
        setForkState('done');
        setTimeout(() => setForkState('idle'), 3000);
      }
    } catch (err) {
      setForkError(err instanceof Error ? err.message : 'Failed to fork spec');
      setForkState('error');
    }
  };

  const cfg = summary ? STATUS_CONFIG[summary.status] : null;

  return (
    <>
      {/* Backdrop (click to close) */}
      <div
        className="fixed inset-0 z-40 bg-black/20 xl:hidden"
        onClick={onClose}
      />

      {/* Drawer */}
      <div className="fixed right-0 top-0 bottom-0 z-50 w-[480px] max-w-full bg-bg border-l border-border flex flex-col shadow-2xl animate-[slideInRight_200ms_ease-out]">
        {/* Header */}
        <div className="px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-2 min-w-0">
              {cfg && (
                <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold rounded border shrink-0 ${cfg.className}`}>
                  {cfg.label}
                </span>
              )}
              <h3 className="text-base font-mono font-semibold text-text truncate">
                {summary?.specName ?? specId}
              </h3>
            </div>
            <button
              onClick={onClose}
              className="p-1 rounded text-muted hover:text-text hover:bg-panel transition-colors shrink-0"
            >
              <X size={16} />
            </button>
          </div>
          {summary && (
            <div className="flex items-center gap-3 text-xs text-muted">
              <span className="flex items-center gap-1">
                <Clock size={10} />
                {formatDate(summary.generatedAt)}
              </span>
              <span>{summary.storyCount} {summary.storyCount === 1 ? 'story' : 'stories'}</span>
            </div>
          )}
          {summary && workspaceId && (
            <div className="mt-2">
              <TagChips
                specId={specId}
                workspaceId={workspaceId}
                tags={summary.tags ?? []}
                onTagsChange={onTagsChange}
              />
            </div>
          )}
        </div>

        {/* Content */}
        {summary?.status === 'rejected' ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center p-8">
              <XCircle size={48} className="text-error/30 mx-auto mb-3" />
              <p className="text-sm text-muted mb-1">This spec was rejected</p>
              {summary.rejectReason && (
                <p className="text-xs text-error/70 mt-2">Reason: {summary.rejectReason}</p>
              )}
              <p className="text-xs text-muted mt-3">
                The spec file was removed. Only metadata remains in the event log.
              </p>
            </div>
          </div>
        ) : detailLoading ? (
          <div className="flex-1 flex items-center justify-center text-muted text-sm">
            Loading spec...
          </div>
        ) : !detail ? (
          <div className="flex-1 flex items-center justify-center text-muted text-sm">
            Failed to load spec detail
          </div>
        ) : (
          <>
            {/* Tab strip */}
            <div className="flex border-b border-border shrink-0">
              {tabs.map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 ${activeTab === tab.id
                    ? 'text-text border-accent'
                    : 'text-muted hover:text-text border-transparent'
                    }`}
                >
                  {tab.icon && <tab.icon size={12} />}
                  {tab.label}
                  {tab.badge && tab.badge !== '0' && (
                    <span className="ml-1 px-1.5 py-0.5 text-[10px] font-semibold rounded-full bg-accent/15 text-accent">
                      {tab.badge}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* Tab content */}
            <div className="flex-1 overflow-y-auto">
              {activeTab === 'stories' && (
                <StoriesTab
                  stories={stories}
                  specId={specId}
                  workspaceId={workspaceId ?? ''}
                  onToggleExclude={summary?.status === 'approved' ? handleToggleExclude : undefined}
                  onStoryUpdated={(updated) => {
                    setLocalStories(prev => prev.map(s => s.id === updated.id ? { ...s, ...updated } : s));
                  }}
                />
              )}
              {activeTab === 'history' && workspaceId && (
                <SpecVersionHistory specId={specId} workspaceId={workspaceId} />
              )}
              {activeTab === 'graph' && workspaceId && <DependencyGraph specId={specId} workspaceId={workspaceId} />}
              {activeTab === 'diagram' && <MermaidDiagram diagram={diagram} idPrefix="mermaid-archive" />}
              {activeTab === 'json' && <JsonTab spec={detail} />}
            </div>
          </>
        )}

        {/* Footer actions */}
        {detail && summary?.status !== 'rejected' && (
          <div className="px-4 py-3 border-t border-border shrink-0 bg-bg space-y-2">
            {/* Run in Pipeline button — approved or completed specs */}
            {(summary?.status === 'approved' || summary?.status === 'completed') && (
              <div className="relative">
                {runState === 'conflict' ? (
                  <div className="rounded border border-warning/30 bg-warning/10 p-3 space-y-2">
                    <p className="text-xs text-warning font-medium">Active run in progress. Run in a new worktree?</p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleRun(true)}
                        className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded text-xs font-medium bg-accent text-white hover:opacity-90 transition-opacity"
                      >
                        <GitBranch size={12} />
                        Run in worktree
                      </button>
                      <button
                        onClick={() => setRunState('idle')}
                        className="px-3 py-1.5 rounded text-xs font-medium bg-panel border border-border text-muted hover:text-text transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : runState === 'success' ? (
                  <div className="flex items-center justify-center gap-1.5 w-full py-2 rounded text-sm font-medium bg-success/15 text-success border border-success/30">
                    <Check size={14} />
                    Switching to Pipeline Monitor...
                  </div>
                ) : (
                  <>
                    {showTriggerPopover && !isFreePlan && (
                      <TriggerPopover
                        loading={runState === 'triggering'}
                        onTrigger={handleRun}
                        onClose={() => setShowTriggerPopover(false)}
                        specPath={`forge/specs/approved/${summary.id}.json`}
                        workspaceId={workspaceId ?? undefined}
                        specModel={summary.model}
                      />
                    )}
                    <button
                      onClick={() => isFreePlan ? setShowPricing(true) : setShowTriggerPopover(true)}
                      disabled={runState === 'triggering'}
                      className={`flex items-center justify-center gap-1.5 w-full py-2 rounded text-sm font-medium transition-opacity disabled:opacity-60 ${isFreePlan
                        ? 'bg-amber-500/15 text-amber-600 border border-amber-500/30 hover:bg-amber-500/25'
                        : 'bg-accent text-white hover:opacity-90'
                        }`}
                    >
                      {runState === 'triggering' ? (
                        <><Loader2 size={14} className="animate-spin" /> Starting run...</>
                      ) : isFreePlan ? (
                        <>
                          <Play size={14} /> Upgrade to Run
                        </>
                      ) : (
                        <>
                          <Play size={14} /> Run in Pipeline
                          {deferredCount > 0 && (
                            <span className="ml-1 px-1.5 py-0.5 text-[10px] font-semibold rounded-full bg-white/20">
                              {deferredCount} deferred
                            </span>
                          )}
                        </>
                      )}
                    </button>
                  </>
                )}
                {runState === 'error' && (
                  <p className="text-xs text-error mt-1">{runError}</p>
                )}
              </div>
            )}

            {/* Add Stories — approved specs only */}
            {summary?.status === 'approved' && (
              <div>
                {addState === 'idle' && (
                  <button
                    onClick={() => setAddState('form')}
                    className="flex items-center justify-center gap-1.5 w-full py-2 rounded text-sm font-medium bg-panel border border-border text-text hover:bg-accent/10 transition-colors"
                  >
                    <Plus size={14} />
                    Add More Stories
                  </button>
                )}
                {addState === 'form' && (
                  <div className="rounded border border-border bg-panel p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-muted shrink-0">Stories to add</label>
                      <input
                        type="number"
                        min={1}
                        max={10}
                        value={addCount}
                        onChange={e => setAddCount(Math.min(10, Math.max(1, parseInt(e.target.value) || 1)))}
                        className="w-16 px-2 py-1 text-xs font-mono rounded border border-border bg-bg text-text text-center"
                      />
                    </div>
                    <textarea
                      placeholder="Optional: describe what to focus on..."
                      value={addBrief}
                      onChange={e => setAddBrief(e.target.value)}
                      rows={2}
                      className="w-full px-2 py-1.5 text-xs rounded border border-border bg-bg text-text resize-none placeholder:text-muted"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={handleAddStories}
                        className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded text-xs font-medium bg-accent text-white hover:opacity-90 transition-opacity"
                      >
                        <Sparkles size={12} />
                        Generate
                      </button>
                      <button
                        onClick={() => { setAddState('idle'); setAddBrief(''); }}
                        className="px-3 py-1.5 rounded text-xs font-medium bg-panel border border-border text-muted hover:text-text transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
                {addState === 'generating' && (
                  <div className="flex items-center justify-center gap-1.5 w-full py-2 rounded text-sm font-medium bg-panel border border-border text-muted">
                    <Loader2 size={14} className="animate-spin" />
                    Generating stories...
                  </div>
                )}
                {addState === 'done' && (
                  <div className="flex items-center justify-center gap-1.5 w-full py-2 rounded text-sm font-medium bg-success/15 text-success border border-success/30">
                    <Check size={14} />
                    Stories added — reload to see them
                  </div>
                )}
                {addState === 'error' && (
                  <p className="text-xs text-error">{addError}</p>
                )}
              </div>
            )}

            {/* Import Stories from Linear / GitHub */}
            {summary?.status === 'approved' && (
              <div>
                {importState === 'idle' && (
                  <button
                    onClick={() => setImportState('form')}
                    className="flex items-center justify-center gap-1.5 w-full py-2 rounded text-sm font-medium bg-panel border border-border text-text hover:bg-accent/10 transition-colors"
                  >
                    <Upload size={14} />
                    Import from Linear / GitHub
                  </button>
                )}
                {importState === 'form' && (
                  <div className="rounded border border-border bg-panel p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-muted shrink-0">Source</label>
                      <select
                        value={importSource}
                        onChange={e => setImportSource(e.target.value as 'linear' | 'github')}
                        className="flex-1 px-2 py-1 text-xs rounded border border-border bg-bg text-text"
                      >
                        <option value="linear">Linear</option>
                        <option value="github">GitHub Issues</option>
                      </select>
                    </div>
                    {importSource === 'linear' ? (
                      <>
                        <input
                          type="password"
                          placeholder="Linear API Key *"
                          value={linearApiKey}
                          onChange={e => setLinearApiKey(e.target.value)}
                          className="w-full px-2 py-1.5 text-xs rounded border border-border bg-bg text-text placeholder:text-muted"
                        />
                        <input
                          placeholder="Team ID (optional)"
                          value={linearTeamId}
                          onChange={e => setLinearTeamId(e.target.value)}
                          className="w-full px-2 py-1.5 text-xs rounded border border-border bg-bg text-text placeholder:text-muted"
                        />
                        <input
                          placeholder="Project ID (optional)"
                          value={linearProjectId}
                          onChange={e => setLinearProjectId(e.target.value)}
                          className="w-full px-2 py-1.5 text-xs rounded border border-border bg-bg text-text placeholder:text-muted"
                        />
                      </>
                    ) : (
                      <>
                        <input
                          type="password"
                          placeholder="GitHub Token *"
                          value={importGithubToken}
                          onChange={e => setImportGithubToken(e.target.value)}
                          className="w-full px-2 py-1.5 text-xs rounded border border-border bg-bg text-text placeholder:text-muted"
                        />
                        <div className="flex gap-2">
                          <input
                            placeholder="Owner *"
                            value={importGithubOwner}
                            onChange={e => setImportGithubOwner(e.target.value)}
                            className="flex-1 px-2 py-1.5 text-xs rounded border border-border bg-bg text-text placeholder:text-muted"
                          />
                          <input
                            placeholder="Repo *"
                            value={importGithubRepo}
                            onChange={e => setImportGithubRepo(e.target.value)}
                            className="flex-1 px-2 py-1.5 text-xs rounded border border-border bg-bg text-text placeholder:text-muted"
                          />
                        </div>
                        <input
                          placeholder="Milestone (optional)"
                          value={importGithubMilestone}
                          onChange={e => setImportGithubMilestone(e.target.value)}
                          className="w-full px-2 py-1.5 text-xs rounded border border-border bg-bg text-text placeholder:text-muted"
                        />
                      </>
                    )}
                    {importError && <p className="text-xs text-error">{importError}</p>}
                    <div className="flex gap-2">
                      <button
                        onClick={handleImportPreview}
                        className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded text-xs font-medium bg-accent text-white hover:opacity-90 transition-opacity"
                      >
                        Preview
                      </button>
                      <button
                        onClick={() => { setImportState('idle'); setImportError(''); }}
                        className="px-3 py-1.5 rounded text-xs font-medium bg-panel border border-border text-muted hover:text-text transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
                {importState === 'loading' && (
                  <div className="flex items-center justify-center gap-1.5 w-full py-2 rounded text-sm font-medium bg-panel border border-border text-muted">
                    <Loader2 size={14} className="animate-spin" />
                    Fetching {importSource === 'linear' ? 'Linear' : 'GitHub'} issues...
                  </div>
                )}
                {importState === 'preview' && (
                  <div className="rounded border border-border bg-panel p-3 space-y-2">
                    <p className="text-xs font-medium text-text">
                      {importPreviewStories.length} {importPreviewStories.length === 1 ? 'issue' : 'issues'} found:
                    </p>
                    <div className="max-h-48 overflow-y-auto space-y-1.5">
                      {importPreviewStories.map(s => (
                        <div key={s.id} className="flex items-start gap-2 text-xs p-1.5 rounded bg-bg border border-border/50">
                          <span className="font-mono text-muted shrink-0">{s.id}</span>
                          <span className="text-text flex-1 truncate">{s.title}</span>
                          <a href={s.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline shrink-0">
                            <ExternalLink size={12} />
                          </a>
                        </div>
                      ))}
                    </div>
                    {importPreviewStories.length === 0 && (
                      <p className="text-xs text-muted">No issues matched your filters.</p>
                    )}
                    <div className="flex gap-2">
                      {importPreviewStories.length > 0 && (
                        <button
                          onClick={handleImportCommit}
                          className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded text-xs font-medium bg-accent text-white hover:opacity-90 transition-opacity"
                        >
                          Import {importPreviewStories.length} {importPreviewStories.length === 1 ? 'story' : 'stories'}
                        </button>
                      )}
                      <button
                        onClick={() => { setImportState('form'); setImportPreviewStories([]); }}
                        className="px-3 py-1.5 rounded text-xs font-medium bg-panel border border-border text-muted hover:text-text transition-colors"
                      >
                        Back
                      </button>
                    </div>
                  </div>
                )}
                {importState === 'importing' && (
                  <div className="flex items-center justify-center gap-1.5 w-full py-2 rounded text-sm font-medium bg-panel border border-border text-muted">
                    <Loader2 size={14} className="animate-spin" />
                    Importing stories...
                  </div>
                )}
                {importState === 'done' && (
                  <div className="flex items-center justify-center gap-1.5 w-full py-2 rounded text-sm font-medium bg-success/15 text-success border border-success/30">
                    <Check size={14} />
                    Stories imported — reload to see them
                  </div>
                )}
                {importState === 'error' && (
                  <div>
                    <p className="text-xs text-error">{importError}</p>
                    <button
                      onClick={() => setImportState('form')}
                      className="text-xs text-accent hover:underline mt-1"
                    >
                      Try again
                    </button>
                  </div>
                )}
              </div>
            )}

            <button
              onClick={handleExportJson}
              className="flex items-center justify-center gap-1.5 w-full py-2 rounded text-sm font-medium bg-panel border border-border text-text hover:bg-accent/10 transition-colors"
            >
              <Download size={14} />
              Export JSON
            </button>

            {/* Fork Spec */}
            {forkState === 'done' ? (
              <div className="flex items-center justify-center gap-1.5 w-full py-2 rounded text-sm font-medium bg-success/15 text-success border border-success/30">
                <Check size={14} />
                Forked as {forkId}
              </div>
            ) : (
              <button
                onClick={handleFork}
                disabled={forkState === 'forking'}
                className="flex items-center justify-center gap-1.5 w-full py-2 rounded text-sm font-medium bg-panel border border-border text-text hover:bg-accent/10 transition-colors disabled:opacity-60"
              >
                {forkState === 'forking' ? (
                  <><Loader2 size={14} className="animate-spin" /> Forking...</>
                ) : (
                  <><GitFork size={14} /> Fork Spec</>
                )}
              </button>
            )}
            {forkState === 'error' && (
              <p className="text-xs text-error">{forkError}</p>
            )}
          </div>
        )}
      </div>
      {showPricing && <PricingModal onClose={() => setShowPricing(false)} />}
    </>
  );
}

/* ─── Stories Tab ──────────────────────────────────────────────────── */

function StoriesTab({
  stories,
  specId,
  workspaceId,
  onToggleExclude,
  onStoryUpdated,
}: {
  stories: Story[];
  specId: string;
  workspaceId: string;
  onToggleExclude?: (storyId: string) => void;
  onStoryUpdated?: (story: Story) => void;
}) {
  const [editingStoryId, setEditingStoryId] = useState<string | null>(null);
  const [commentCounts, setCommentCounts] = useState<Record<string, number>>({});
  const [commentsOpenFor, setCommentsOpenFor] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ counts: Record<string, number> }>(`/api/specs/${specId}/comments/counts`)
      .then(data => setCommentCounts(data.counts))
      .catch(() => { });
  }, [specId]);

  if (stories.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        No stories found in this spec
      </div>
    );
  }

  const deferredCount = stories.filter(s => s.excluded && !s.passes).length;
  const allStoryIds = new Set(stories.map(s => s.id));

  return (
    <div className="p-4 space-y-2">
      <span className="text-xs text-muted">
        {stories.length} {stories.length === 1 ? 'story' : 'stories'}
        {deferredCount > 0 && (
          <span className="ml-2 text-muted/60">· {deferredCount} deferred</span>
        )}
      </span>
      {stories.map(story =>
        editingStoryId === story.id ? (
          <InlineStoryEditor
            key={story.id}
            story={story}
            specId={specId}
            workspaceId={workspaceId}
            onSave={(updated) => {
              onStoryUpdated?.(updated);
              setEditingStoryId(null);
            }}
            onCancel={() => setEditingStoryId(null)}
          />
        ) : (
          <div key={story.id}>
            <StoryCard
              story={story}
              allStoryIds={allStoryIds}
              onEdit={() => setEditingStoryId(story.id)}
              onToggleExclude={onToggleExclude ? () => onToggleExclude(story.id) : undefined}
              specId={specId}
              workspaceId={workspaceId}
              commentCount={commentCounts[story.id] ?? 0}
              onOpenComments={() => setCommentsOpenFor(commentsOpenFor === story.id ? null : story.id)}
            />
            {commentsOpenFor === story.id && (
              <StoryComments
                specId={specId}
                storyId={story.id}
                onClose={() => setCommentsOpenFor(null)}
                onCountChange={(count) => setCommentCounts(prev => {
                  const next = { ...prev };
                  if (count > 0) next[story.id] = count;
                  else delete next[story.id];
                  return next;
                })}
              />
            )}
          </div>
        )
      )}
    </div>
  );
}

/* ─── Diagram Tab ─────────────────────────────────────────────────── */

/* DiagramTab replaced by shared MermaidDiagram component */

/* ─── Raw JSON Tab ────────────────────────────────────────────────── */

function JsonTab({ spec }: { spec: SpecDetail }) {
  const [copied, setCopied] = useState(false);
  const rawJson = JSON.stringify(spec, null, 2);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(rawJson);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [rawJson]);

  return (
    <div className="p-4">
      <div className="relative">
        <button
          onClick={handleCopy}
          className="absolute top-2 right-2 p-1.5 rounded bg-panel border border-border text-muted hover:text-text transition-colors z-10"
          title="Copy JSON"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
        <pre className="p-4 text-xs font-mono bg-panel border border-border rounded overflow-x-auto text-text whitespace-pre max-h-[70vh] overflow-y-auto">
          {rawJson}
        </pre>
      </div>
    </div>
  );
}
