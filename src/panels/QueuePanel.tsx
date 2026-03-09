import { useState, useEffect, useCallback } from 'react';
import { Clock, Inbox, ArrowRight, FileText, Play, CheckCircle2, Layers } from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';
import { useWorkspace } from '../contexts/WorkspaceContext';
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
}

function KanbanSpecCard({ spec, passedCount, onClick, column }: KanbanSpecCardProps) {
  const total = spec.storyCount;
  const passed = passedCount ?? 0;
  const hasProgress = passedCount !== undefined && column !== 'draft';
  const progressPct = total > 0 ? Math.round((passed / total) * 100) : 0;

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full h-[120px] bg-panel border border-border rounded-lg p-3 text-left
        flex flex-col justify-between overflow-hidden
        transition-all duration-150 hover:shadow-md hover:shadow-black/20 hover:border-accent/40
        hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
    >
      {/* Top: title + slug */}
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-[var(--text)] line-clamp-2 leading-[1.3]">
          {slugToTitle(spec.id)}
        </h3>
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
}

function KanbanColumn({ config, specs, onReviewClick, storyProgress }: KanbanColumnProps) {
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

export default function QueuePanel({ onNavigate, onNavigateToSpecReview }: QueuePanelProps) {
  const { workspaceId } = useWorkspace();
  const [specs, setSpecs] = useState<SpecSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [storyProgress, setStoryProgress] = useState<Record<string, number>>({});

  const fetchSpecs = useCallback(async () => {
    if (!workspaceId) { setSpecs([]); setLoading(false); return; }
    try {
      const res = await apiFetch<{ items: SpecSummary[]; total: number }>(
        `/api/specs?workspaceId=${workspaceId}&status=all`
      );
      // Sort newest first within each group
      const sorted = [...res.items].sort(
        (a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime()
      );
      setSpecs(sorted);

      // Fetch story progress for non-draft specs
      const nonDraft = sorted.filter((s) => s.status !== 'pending');
      if (nonDraft.length > 0) {
        try {
          const runs = await apiFetch<{ items: Array<{ spec_path: string; id: number }> }>(
            `/api/pipeline/runs?workspaceId=${workspaceId}&limit=100`
          );
          const progress: Record<string, number> = {};
          for (const run of runs.items) {
            // Extract spec slug from path like "forge/specs/approved/my-spec.json"
            const slug = run.spec_path.replace(/^.*\//, '').replace(/\.json$/, '');
            if (!progress[slug]) {
              try {
                const results = await apiFetch<{ items: Array<{ status: string }> }>(
                  `/api/pipeline/runs/${run.id}/story-results`
                );
                progress[slug] = results.items.filter((r) => r.status === 'pass').length;
              } catch {
                // Story results not available for this run
              }
            }
          }
          setStoryProgress(progress);
        } catch {
          // Pipeline runs endpoint may not be available
        }
      }
    } catch {
      // Silently fail — no toast spam on background poll
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    setLoading(true);
    fetchSpecs();
    const interval = setInterval(fetchSpecs, 10_000);
    return () => clearInterval(interval);
  }, [fetchSpecs]);

  const handleReviewClick = useCallback((specId: string) => {
    if (onNavigateToSpecReview) {
      onNavigateToSpecReview(specId);
    } else {
      onNavigate('forge');
    }
  }, [onNavigateToSpecReview, onNavigate]);

  // Bucket specs into columns
  const draftSpecs = specs.filter((s) => s.status === 'pending');
  const inProgressSpecs = specs.filter((s) => s.status === 'approved');
  const doneSpecs = specs.filter((s) => s.status === 'completed');

  const totalCount = specs.length;

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
          <div className="grid grid-cols-3 gap-0 h-full divide-x divide-border">
            {[0, 1, 2].map((col) => (
              <div key={col} className="flex flex-col min-h-0">
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
        ) : totalCount === 0 ? (
          /* Full empty state */
          <div className="flex flex-col items-center justify-center h-full min-h-[300px] gap-4 text-center">
            <Inbox size={48} className="text-muted/40" />
            <div>
              <p className="text-base font-medium text-[var(--text)]">No specs awaiting review</p>
              <p className="text-sm text-muted mt-1">Generated specs will appear here for approval</p>
            </div>
            <button
              onClick={() => onNavigate('forge')}
              className="flex items-center gap-2 px-4 py-2 rounded text-sm font-medium bg-accent text-white hover:bg-accent/90 transition-colors"
            >
              Go to Forge
              <ArrowRight size={14} />
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-0 h-full divide-x divide-border">
            {COLUMNS.map((col, idx) => {
              const colSpecs = idx === 0 ? draftSpecs : idx === 1 ? inProgressSpecs : doneSpecs;
              return (
                <KanbanColumn
                  key={col.key}
                  config={col}
                  specs={colSpecs}
                  onReviewClick={handleReviewClick}
                  storyProgress={storyProgress}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
