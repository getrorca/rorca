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
  Trash2,
  Globe,
} from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useAuth } from '../contexts/AuthContext';
import { apiFetch } from '../lib/apiFetch';
import { useGlobalToast } from '../contexts/ToastContext';
import TriggerPopover from '../components/TriggerPopover';
import PricingModal from '../components/PricingModal';
import { StoryCard } from '../components/StoryCard';
import type { Story } from '../components/StoryCard';
import { InlineStoryEditor } from '../components/InlineStoryEditor';
import { StoryComments } from '../components/StoryComments';
import DependencyGraph from '../components/DependencyGraph';
import MermaidDiagram from '../components/MermaidDiagram';
import type { PanelId } from '../components/Sidebar';
import { ReadinessRing } from '../components/ReadinessRing';
import { TagChipsReadonly, TagChips } from '../components/TagChips';
import { SpecVersionHistory } from '../components/SpecVersionHistory';
import AppHeader from '../components/AppHeader';
import AgentBadge from '../components/AgentBadge';
import PublishModal from '../components/PublishModal';
import { ProBadge, UpgradePromptModal } from '../components/UpgradePrompt';
import SpecDetailSlideOver from '../components/SpecDetailSlideOver';

/* ─── Types ───────────────────────────────────────────────────────── */

type SpecStatus = 'pending' | 'approved' | 'rejected' | 'completed';
type StatusFilter = 'all' | SpecStatus;
type PreviewTab = 'stories' | 'graph' | 'diagram' | 'json' | 'history';

type ReviewStatus = 'draft' | 'review_requested' | 'approved' | 'changes_requested';

interface RunTelemetry {
  runId: number;
  runStatus: string;
  startedAt: string;
  finishedAt: string | null;
  durationSeconds: number | null;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  totalCostUsd: number | null;
  agentType: string;
  agentModel: string | null;
  storyOutcomes: {
    pass: number;
    fail: number;
    skip: number;
    timeout: number;
    excluded: number;
  };
}

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
  runTelemetry?: RunTelemetry | null;
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
  { id: 'all', label: 'All Specs' },
  { id: 'pending', label: 'Pending Review' },
  { id: 'approved', label: 'Approved' },
  { id: 'completed', label: 'Completed' },
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

function formatDurationShort(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatTokensCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCostCompact(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

function StoryOutcomeBar({ outcomes, storyCount }: { outcomes: RunTelemetry['storyOutcomes']; storyCount: number }) {
  if (storyCount === 0) return null;
  const segments = [
    { count: outcomes.pass, color: 'bg-emerald-500' },
    { count: outcomes.fail, color: 'bg-red-500' },
    { count: outcomes.skip + outcomes.timeout, color: 'bg-amber-500' },
    { count: outcomes.excluded, color: 'bg-zinc-500' },
  ].filter(s => s.count > 0);

  return (
    <div
      className="flex h-1 rounded-full overflow-hidden bg-border"
      title={`${outcomes.pass} passed, ${outcomes.fail} failed, ${outcomes.skip + outcomes.timeout} skipped`}
    >
      {segments.map((seg, i) => (
        <div
          key={i}
          className={`${seg.color} transition-all`}
          style={{ width: `${(seg.count / storyCount) * 100}%` }}
        />
      ))}
    </div>
  );
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

export default function ArchivePanel({ onNavigate }: { onNavigate: (panel: PanelId) => void }) {
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

  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  // ─── Resizable split pane ────────────────────────────────────────
  const [leftWidth, setLeftWidth] = useState(380);
  const isDragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);

  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    dragStartX.current = e.clientX;
    dragStartWidth.current = leftWidth;

    const onMouseMove = (ev: MouseEvent) => {
      if (!isDragging.current) return;
      const delta = ev.clientX - dragStartX.current;
      const next = Math.min(Math.max(dragStartWidth.current + delta, 260), 700);
      setLeftWidth(next);
    };
    const onMouseUp = () => {
      isDragging.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [leftWidth]);

  // ─── Debounce search ────────────────────────────────────────────
  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(searchText);
    }, 300);
    return () => clearTimeout(debounceRef.current);
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
    <div role="main" aria-label="Archive panel - search and browse archived specs" className="flex flex-col h-full bg-bg overflow-hidden">
      <AppHeader
        breadcrumbs={
          <div className="flex items-center gap-2">
            <span className="font-medium text-[var(--text)] text-sm tracking-tight">
              {workspaceId ? 'Workspace' : 'Global'}
            </span>
            <ChevronRight size={14} className="text-muted" />
            <span className="text-sm text-muted">Wake</span>
          </div>
        }
        actions={
          <div className="flex items-center gap-2 flex-wrap flex-1 max-w-full justify-end pb-1 pt-1 pr-2">
            {/* Search bar */}
            <div className="relative w-full sm:w-48 shrink-0">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
              <input
                type="text"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                placeholder="Search archive..."
                data-archive-search
                className="w-full h-8 pl-8 pr-8 bg-panel border gap-3 border-border rounded text-sm text-text placeholder-muted/60 focus:outline-none focus:border-accent/40 focus:ring-2 focus:ring-accent/50 transition-shadow transition-colors"
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
                  aria-label="Clear search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-text transition-colors focus:outline-none focus:ring-2 focus:ring-accent/50 rounded"
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
                  <option key={f.id} value={f.id}>{f.label}</option>
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

      <div className="flex flex-1 overflow-hidden relative">
        {/* ─── Left: Split List ────────────────────────────────────────── */}
        <div
          className={`flex-col border-r border-border flex-shrink-0 ${selectedId ? 'hidden md:flex' : 'flex w-full'}`}
          style={{ width: selectedId ? leftWidth : undefined }}
        >
          <div className="flex flex-col h-full bg-panel">
            {/* Results */}
            <div className="flex-1 overflow-y-auto">
              {loading ? (
                <div aria-live="polite" className="flex items-center justify-center h-full text-muted text-sm">
                  <span className="sr-only">Loading...</span>
                  Loading specs...
                </div>
              ) : specs.length === 0 ? (
                <div aria-live="polite" className="flex items-center justify-center h-full">
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
                    const tel = spec.runTelemetry;
                    return (
                      <button
                        key={spec.id}
                        onClick={() => setSelectedId(spec.id === selectedId ? null : spec.id)}
                        aria-expanded={spec.id === selectedId}
                        aria-label={`${spec.specName} - ${spec.status}`}
                        className={`w-full text-left px-4 py-2.5 border-b border-border transition-colors focus:outline-none focus:ring-2 focus:ring-inset focus:ring-accent/50 ${
                          spec.id === selectedId ? 'bg-accent/10' : 'hover:bg-panel'
                        } ${spec.status === 'completed' ? 'opacity-80' : ''}`}
                      >
                        {/* Row 1: Status dot + Spec name + Quick badge + Date + Chevron */}
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${cfg.dotClass}`} />
                          <span className="text-sm font-mono font-semibold text-text truncate flex-1">
                            {spec.specName}
                          </span>
                          {spec.source === 'quick-run' && (
                            <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-purple-500/15 text-purple-400">
                              Quick
                            </span>
                          )}
                          <span className="text-[10px] text-muted tabular-nums shrink-0">
                            {formatDate(spec.generatedAt)}
                          </span>
                          <ChevronRight
                            size={14}
                            className={`shrink-0 text-muted transition-transform ${
                              spec.id === selectedId ? 'rotate-90' : ''
                            }`}
                          />
                        </div>

                        {/* Row 2: Repo + Branch + Spacer + Outcome bar + Pass rate */}
                        <div className="flex items-center gap-2 mb-1 ml-3.5 min-w-0">
                          {spec.repoName && (
                            <span className="text-[10px] text-muted font-mono truncate">
                              {spec.repoName}
                            </span>
                          )}
                          {spec.branchName && (
                            <span className="flex items-center gap-0.5 text-[10px] text-muted font-mono truncate">
                              <GitBranch className="w-2.5 h-2.5" />
                              {spec.branchName.replace('feat/', '')}
                            </span>
                          )}
                          {spec.forkedFrom && (
                            <span className="flex items-center gap-0.5 text-[10px] text-accent font-mono">
                              <GitFork className="w-2.5 h-2.5" />
                              {spec.forkedFrom}
                            </span>
                          )}
                          <div className="flex-1" />
                          {tel ? (
                            <div className="flex items-center gap-2 shrink-0">
                              <div className="w-16">
                                <StoryOutcomeBar outcomes={tel.storyOutcomes} storyCount={spec.storyCount} />
                              </div>
                              <span className="text-[10px] font-mono tabular-nums text-muted">
                                {tel.storyOutcomes.pass}/{spec.storyCount}
                              </span>
                            </div>
                          ) : (
                            <span className="text-[10px] text-muted tabular-nums shrink-0">
                              {spec.storyCount} {spec.storyCount === 1 ? 'story' : 'stories'}
                            </span>
                          )}
                        </div>

                        {/* Row 3: Telemetry (if run data) or Tags + Review status */}
                        {tel ? (
                          <div className="flex items-center gap-3 ml-3.5 text-[10px] text-muted">
                            {tel.durationSeconds != null && (
                              <span className="font-mono tabular-nums">
                                {formatDurationShort(tel.durationSeconds)}
                              </span>
                            )}
                            {(tel.totalInputTokens != null || tel.totalOutputTokens != null) && (
                              <span className="font-mono tabular-nums">
                                {formatTokensCompact((tel.totalInputTokens ?? 0) + (tel.totalOutputTokens ?? 0))} tok
                              </span>
                            )}
                            {tel.totalCostUsd != null && tel.totalCostUsd > 0 && (
                              <span className="font-mono tabular-nums">
                                {formatCostCompact(tel.totalCostUsd)}
                              </span>
                            )}
                            <AgentBadge agentType={tel.agentType} agentModel={tel.agentModel} size="sm" />
                            {spec.tags?.length > 0 && (
                              <div className="flex-1 min-w-0 overflow-hidden">
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
                          </div>
                        ) : (
                          <>
                            {spec.tags?.length > 0 && (
                              <div className="ml-3.5">
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
                            {spec.reviewStatus && spec.reviewStatus !== 'draft' && (
                              <div className="ml-3.5 mt-0.5">
                                <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded ${
                                  spec.reviewStatus === 'review_requested' ? 'bg-accent/15 text-accent' :
                                  spec.reviewStatus === 'approved' ? 'bg-success/15 text-success' :
                                  'bg-warning/15 text-warning'
                                }`}>
                                  {spec.reviewStatus === 'review_requested' ? 'Needs Review' :
                                   spec.reviewStatus === 'approved' ? 'Review OK' : 'Changes Req.'}
                                </span>
                              </div>
                            )}
                          </>
                        )}

                        {/* Reject reason */}
                        {spec.status === 'rejected' && spec.rejectReason && (
                          <p className="text-xs text-error/70 mt-1 ml-3.5 truncate">
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
        </div>

      </div>

      {/* Spec Detail Slide-Over */}
      <SpecDetailSlideOver
        isOpen={selectedId !== null}
        specId={selectedId}
        initialSummary={selectedSpec as import('../components/SpecDetailSlideOver').SpecSlideOverSummary | undefined}
        onClose={() => { setSelectedId(null); setSpecDetail(null); }}
        onNavigate={onNavigate}
        onTagsChange={(specId, newTags) => {
          setSpecs(prev => prev.map(s => s.id === specId ? { ...s, tags: newTags } : s));
        }}
        onDeleted={(deletedId) => {
          setSelectedId(null);
          setSpecDetail(null);
          setSpecs(prev => prev.filter(s => s.id !== deletedId));
        }}
      />
    </div>
  );
}

/* Dead code removed — SpecPreviewDrawer replaced by SpecDetailSlideOver */

