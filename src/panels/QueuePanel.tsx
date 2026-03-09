import { useState, useEffect, useCallback, useRef } from 'react';
import { Clock, Inbox, ArrowRight, FileText, Play, CheckCircle2, Layers, AlertTriangle, RefreshCw, Check, X, Loader2 } from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useGlobalToast } from '../contexts/ToastContext';
import { useWalSSE } from '../hooks/useWalSSE';
import { relativeTime } from '../components/SpecReviewInline';
import type { SpecSummary } from '../components/SpecReviewInline';
import type { PanelId } from '../components/Sidebar';

function slugToTitle(slug: string): string {
  return slug
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/* ─── Compact Kanban Card ──────────────────────────────────────── */

interface KanbanSpecCardProps {
  spec: SpecSummary;
  passedCount?: number;
  onClick: () => void;
  column: 'draft' | 'in-progress' | 'done';
  onApprove?: () => void;
  onDeny?: () => void;
  actionLoading?: 'approve' | 'deny' | null;
  hasActiveRun?: boolean;
}

function KanbanSpecCard({ spec, passedCount, onClick, column, onApprove, onDeny, actionLoading, hasActiveRun }: KanbanSpecCardProps) {
  const total = spec.storyCount;
  const passed = passedCount ?? 0;
  const hasProgress = passedCount !== undefined && column !== 'draft';
  const progressPct = total > 0 ? Math.round((passed / total) * 100) : 0;
  const isDraft = column === 'draft';
  const isActioning = actionLoading !== null && actionLoading !== undefined;

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onClick}
        disabled={isActioning}
        className="w-full h-[120px] bg-panel border border-border rounded-lg p-3 text-left
          flex flex-col justify-between overflow-hidden
          transition-all duration-150 hover:shadow-md hover:shadow-black/20 hover:border-accent/40
          hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50
          disabled:opacity-60 disabled:pointer-events-none"
      >
        {/* Top: title + active run badge */}
        <div className="min-w-0">
          <div className="flex items-start gap-1.5">
            <h3 className="text-sm font-semibold text-[var(--text)] line-clamp-2 leading-[1.3] flex-1">
              {slugToTitle(spec.id)}
            </h3>
            {hasActiveRun && (
              <span className="shrink-0 mt-0.5 inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-accent/15 text-accent border border-accent/30 animate-pulse">
                <Play size={8} className="fill-current" />
                Running
              </span>
            )}
          </div>
        </div>

        {/* Bottom: badges + timestamp */}
        <div className="flex items-center justify-between gap-2 mt-auto min-w-0">
          {/* Story count badge */}
          <span className="shrink-0 inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-accent/10 text-accent border border-accent/20">
            <Layers size={10} />
            {hasProgress
              ? `${passed}/${total} stories`
              : `${total} ${total === 1 ? 'story' : 'stories'}`}
          </span>

          {/* Timestamp */}
          <span className="shrink-0 text-[11px] text-muted flex items-center gap-1">
            <Clock size={10} />
            {column === 'done' && spec.approvedAt
              ? relativeTime(spec.approvedAt)
              : relativeTime(spec.generatedAt)}
          </span>
        </div>

        {/* Progress bar (only for in-progress / done with data) */}
        {hasProgress && (
          <div className="w-full h-1 rounded-full bg-surface-200 mt-1.5 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-300 ${
                progressPct === 100 ? 'bg-success' : 'bg-accent'
              }`}
              style={{ width: `${progressPct}%` }}
            />
          </div>
        )}
      </button>

      {/* Approve / Deny action buttons — Draft column only.
          Desktop: hover-reveal. Touch/mobile: always visible. */}
      {isDraft && (
        <div className={`absolute top-2 right-2 flex items-center gap-1
          ${isActioning ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}
          touch-action-visible
          transition-opacity duration-150`}
        >
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onApprove?.(); }}
            disabled={isActioning}
            title="Approve spec"
            className="min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 p-2 sm:p-1.5 rounded-md bg-success/15 text-success border border-success/30
              hover:bg-success/25 transition-colors flex items-center justify-center
              disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {actionLoading === 'approve' ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onDeny?.(); }}
            disabled={isActioning}
            title="Deny spec"
            className="min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 p-2 sm:p-1.5 rounded-md bg-error/15 text-error border border-error/30
              hover:bg-error/25 transition-colors flex items-center justify-center
              disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {actionLoading === 'deny' ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}
          </button>
        </div>
      )}
    </div>
  );
}


/* ─── Column Component ──────────────────────────────────────────── */

interface ColumnConfig {
  key: 'draft' | 'in-progress' | 'done';
  label: string;
  icon: React.ElementType;
  emptyMessage: string;
  accentClass: string;
  iconClass: string;
}

const COLUMNS: ColumnConfig[] = [
  {
    key: 'draft',
    label: 'Draft',
    icon: FileText,
    emptyMessage: 'No draft specs',
    accentClass: 'bg-muted/15 text-muted',
    iconClass: 'text-muted',
  },
  {
    key: 'in-progress',
    label: 'In Progress',
    icon: Play,
    emptyMessage: 'No specs in progress',
    accentClass: 'bg-accent/15 text-accent',
    iconClass: 'text-accent',
  },
  {
    key: 'done',
    label: 'Done',
    icon: CheckCircle2,
    emptyMessage: 'No completed specs',
    accentClass: 'bg-success/15 text-success',
    iconClass: 'text-success',
  },
];

interface KanbanColumnProps {
  config: ColumnConfig;
  specs: SpecSummary[];
  onReviewClick: (specId: string) => void;
  storyProgress?: Record<string, number>;
  onApprove?: (specId: string) => void;
  onDeny?: (specId: string) => void;
  actionLoadingMap?: Record<string, 'approve' | 'deny' | null>;
  activeRunSpecs?: Set<string>;
}

function KanbanColumn({ config, specs, onReviewClick, storyProgress, onApprove, onDeny, actionLoadingMap, activeRunSpecs }: KanbanColumnProps) {
  const Icon = config.icon;

  return (
    <div className="flex flex-col min-h-0 min-w-0">
      {/* Column header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border shrink-0">
        <Icon size={14} className={config.iconClass} />
        <span className="text-sm font-medium text-[var(--text)]">{config.label}</span>
        <span className={`text-[11px] font-medium px-1.5 py-0.5 rounded-full ${config.accentClass}`}>
          {specs.length}
        </span>
      </div>

      {/* Column body */}
      <div className="flex-1 overflow-y-auto min-h-0 p-3 space-y-2">
        {specs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Icon size={32} className="text-muted/30 mb-2" />
            <p className="text-sm text-muted">{config.emptyMessage}</p>
          </div>
        ) : (
          specs.map((spec) => (
            <KanbanSpecCard
              key={spec.id}
              spec={spec}
              passedCount={storyProgress?.[spec.id]}
              onClick={() => onReviewClick(spec.id)}
              column={config.key}
              onApprove={onApprove ? () => onApprove(spec.id) : undefined}
              onDeny={onDeny ? () => onDeny(spec.id) : undefined}
              actionLoading={actionLoadingMap?.[spec.id] ?? null}
              hasActiveRun={activeRunSpecs?.has(spec.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

/* ─── Main Panel ────────────────────────────────────────────────── */

interface QueuePanelProps {
  onNavigate: (panel: PanelId) => void;
  onNavigateToSpecReview?: (specId: string) => void;
}

interface KanbanSpec {
  id: string;
  title: string;
  storyCount: number;
  generatedAt: string;
  approvedAt?: string;
  readinessPercent: number;
  tags: string[];
  reviewStatus: string;
  storyTitles?: string[];
  passedStories?: number;
  activeRunId?: number;
}

interface KanbanResponse {
  draft: KanbanSpec[];
  inProgress: KanbanSpec[];
  done: KanbanSpec[];
}

/** Adapt KanbanSpec to SpecSummary for the card component */
function toSpecSummary(k: KanbanSpec, status: 'pending' | 'approved' | 'completed'): SpecSummary {
  return {
    id: k.id,
    specName: k.title,
    storyCount: k.storyCount,
    status,
    generatedAt: k.generatedAt,
    approvedAt: k.approvedAt,
    readinessPercent: k.readinessPercent,
    tags: k.tags,
  } as SpecSummary;
}

export default function QueuePanel({ onNavigate, onNavigateToSpecReview }: QueuePanelProps) {
  const { workspaceId } = useWorkspace();
  const toast = useGlobalToast();
  const [kanban, setKanban] = useState<KanbanResponse>({ draft: [], inProgress: [], done: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const hasLoadedOnce = useRef(false);
  const [actionLoadingMap, setActionLoadingMap] = useState<Record<string, 'approve' | 'deny' | null>>({});

  const fetchKanban = useCallback(async () => {
    if (!workspaceId) { setKanban({ draft: [], inProgress: [], done: [] }); setLoading(false); setError(null); return; }
    try {
      const res = await apiFetch<KanbanResponse>(
        `/api/specs/kanban?workspaceId=${workspaceId}`
      );
      setKanban(res);
      setError(null);
      hasLoadedOnce.current = true;
    } catch (err: any) {
      // Only show error UI if we haven't loaded data yet — background poll failures are silent
      if (!hasLoadedOnce.current) {
        setError(err?.message || 'Failed to load specs');
      }
    } finally {
      setLoading(false);
      setRetrying(false);
    }
  }, [workspaceId]);

  const handleRetry = useCallback(() => {
    setRetrying(true);
    setError(null);
    setLoading(true);
    fetchKanban();
  }, [fetchKanban]);

  useEffect(() => {
    hasLoadedOnce.current = false;
    setLoading(true);
    setError(null);
    fetchKanban();
    const interval = setInterval(fetchKanban, 10_000);
    return () => clearInterval(interval);
  }, [fetchKanban]);

  // SSE: react to WAL events that affect kanban column placement
  const [activeRunSpecs, setActiveRunSpecs] = useState<Set<string>>(new Set());
  const sseFetchTimer = useRef<ReturnType<typeof setTimeout>>();

  /** Debounced re-fetch — coalesces rapid SSE bursts into a single API call */
  const debouncedFetchKanban = useCallback(() => {
    clearTimeout(sseFetchTimer.current);
    sseFetchTimer.current = setTimeout(() => fetchKanban(), 300);
  }, [fetchKanban]);

  // Clean up debounce timer on unmount
  useEffect(() => () => clearTimeout(sseFetchTimer.current), []);

  useWalSSE((event) => {
    // Only process events for the current workspace
    if (workspaceId && event.workspace_id && event.workspace_id !== String(workspaceId)) return;

    const KANBAN_EVENTS = ['spec_approved', 'run_started', 'run_finished', 'spec_rejected', 'story_passed', 'story_failed'];
    if (!KANBAN_EVENTS.includes(event.event_type)) return;

    switch (event.event_type) {
      case 'spec_approved':
        // Card moves from Draft → In Progress
        debouncedFetchKanban();
        break;

      case 'run_started': {
        // Mark spec as having an active run (for badge display)
        const specId = event.spec_id;
        if (specId) {
          setActiveRunSpecs((prev) => new Set(prev).add(specId));
        }
        debouncedFetchKanban();
        break;
      }

      case 'run_finished':
        // Card moves from In Progress → Done — clear active badge
        if (event.spec_id) {
          setActiveRunSpecs((prev) => {
            const next = new Set(prev);
            next.delete(event.spec_id!);
            return next;
          });
        }
        debouncedFetchKanban();
        break;

      case 'spec_rejected':
        // Card removed from Draft
        debouncedFetchKanban();
        break;

      case 'story_passed':
      case 'story_failed':
        // Story progress changed — update progress bars
        debouncedFetchKanban();
        break;
    }
  });

  const handleReviewClick = useCallback((specId: string) => {
    if (onNavigateToSpecReview) {
      onNavigateToSpecReview(specId);
    } else {
      onNavigate('forge');
    }
  }, [onNavigateToSpecReview, onNavigate]);

  const handleApprove = useCallback(async (specId: string) => {
    if (!workspaceId) return;
    setActionLoadingMap((prev) => ({ ...prev, [specId]: 'approve' }));
    try {
      await apiFetch(`/api/specs/${encodeURIComponent(specId)}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      toast.show(`Spec "${slugToTitle(specId)}" approved`, 'success');
      fetchKanban();
    } catch (err: any) {
      toast.show(err?.message || 'Failed to approve spec', 'error');
    } finally {
      setActionLoadingMap((prev) => ({ ...prev, [specId]: null }));
    }
  }, [workspaceId, fetchKanban, toast]);

  const handleDeny = useCallback(async (specId: string) => {
    if (!workspaceId) return;
    setActionLoadingMap((prev) => ({ ...prev, [specId]: 'deny' }));
    try {
      await apiFetch(`/api/specs/${encodeURIComponent(specId)}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      toast.show(`Spec "${slugToTitle(specId)}" denied`, 'success');
      fetchKanban();
    } catch (err: any) {
      toast.show(err?.message || 'Failed to deny spec', 'error');
    } finally {
      setActionLoadingMap((prev) => ({ ...prev, [specId]: null }));
    }
  }, [workspaceId, fetchKanban, toast]);

  const draftSpecs = kanban.draft.map(k => toSpecSummary(k, 'pending'));
  const inProgressSpecs = kanban.inProgress.map(k => toSpecSummary(k, 'approved'));
  const doneSpecs = kanban.done.map(k => toSpecSummary(k, 'completed'));

  // Build story progress from kanban data
  const storyProgress: Record<string, number> = {};
  for (const k of [...kanban.inProgress, ...kanban.done]) {
    if (k.passedStories !== undefined) storyProgress[k.id] = k.passedStories;
  }

  const totalCount = draftSpecs.length + inProgressSpecs.length + doneSpecs.length;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border shrink-0 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-[var(--text)]">Review Queue</h1>
          <p className="text-sm text-muted mt-0.5">
            {loading ? 'Loading…' : `${totalCount} spec${totalCount === 1 ? '' : 's'} across all stages`}
          </p>
        </div>
        {!loading && totalCount === 0 && (
          <button
            onClick={() => onNavigate('forge')}
            className="flex items-center gap-2 px-4 py-2 rounded text-sm font-medium bg-accent text-white hover:bg-accent/90 transition-colors"
          >
            Go to Forge
            <ArrowRight size={14} />
          </button>
        )}
      </div>

      {/* Kanban board */}
      <div className="flex-1 overflow-hidden min-h-0">
        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-0 h-full kanban-grid">
            {[0, 1, 2].map((col) => (
              <div key={col} className="flex flex-col min-h-0 border-l border-border first:border-l-0">
                <div className="px-3 py-2.5 border-b border-border shrink-0">
                  <div className="h-5 w-24 bg-surface-100 rounded animate-pulse" />
                </div>
                <div className="flex-1 p-3 space-y-2">
                  {[1, 2].map((i) => (
                    <div key={i} className="bg-panel border border-border rounded-lg h-[120px] animate-pulse" />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : error ? (
          /* Error state with retry */
          <div className="flex flex-col items-center justify-center h-full min-h-[300px] gap-4 text-center px-4">
            <AlertTriangle size={48} className="text-warning/60" />
            <div>
              <p className="text-base font-medium text-[var(--text)]">Failed to load specs</p>
              <p className="text-sm text-muted mt-1">{error}</p>
            </div>
            <button
              onClick={handleRetry}
              disabled={retrying}
              className="flex items-center gap-2 px-4 py-2 min-h-[44px] rounded text-sm font-medium bg-accent text-white hover:bg-accent/90 transition-colors disabled:opacity-50"
            >
              <RefreshCw size={14} className={retrying ? 'animate-spin' : ''} />
              {retrying ? 'Retrying…' : 'Retry'}
            </button>
          </div>
        ) : totalCount === 0 ? (
          /* Full empty state */
          <div className="flex flex-col items-center justify-center h-full min-h-[300px] gap-4 text-center px-4">
            <Inbox size={48} className="text-muted/40" />
            <div>
              <p className="text-base font-medium text-[var(--text)]">No specs awaiting review</p>
              <p className="text-sm text-muted mt-1">Generated specs will appear here for approval</p>
            </div>
            <button
              onClick={() => onNavigate('forge')}
              className="flex items-center gap-2 px-4 py-2 min-h-[44px] rounded text-sm font-medium bg-accent text-white hover:bg-accent/90 transition-colors"
            >
              Go to Forge
              <ArrowRight size={14} />
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-0 h-full kanban-grid scrollbar-none">
            {COLUMNS.map((col, idx) => {
              const colSpecs = idx === 0 ? draftSpecs : idx === 1 ? inProgressSpecs : doneSpecs;
              return (
                <KanbanColumn
                  key={col.key}
                  config={col}
                  specs={colSpecs}
                  onReviewClick={handleReviewClick}
                  storyProgress={storyProgress}
                  onApprove={col.key === 'draft' ? handleApprove : undefined}
                  onDeny={col.key === 'draft' ? handleDeny : undefined}
                  actionLoadingMap={col.key === 'draft' ? actionLoadingMap : undefined}
                  activeRunSpecs={activeRunSpecs}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
