import { useState, useEffect, useCallback } from 'react';
import { Clock, CheckCircle, XCircle, Eye, Inbox, ArrowRight, FileText, Play, CheckCircle2 } from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useGlobalToast } from '../contexts/ToastContext';
import { relativeTime } from '../components/SpecReviewInline';
import type { SpecSummary } from '../components/SpecReviewInline';
import type { PanelId } from '../components/Sidebar';

function slugToTitle(slug: string): string {
  return slug
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function reviewStatusLabel(status?: string): string | null {
  if (!status || status === 'draft') return null;
  if (status === 'review_requested') return 'Needs Review';
  if (status === 'changes_requested') return 'Changes Requested';
  if (status === 'approved') return 'Review Approved';
  return status;
}

interface SpecCardProps {
  spec: SpecSummary;
  workspaceId: string;
  onReviewClick: (specId: string) => void;
  onRemove: (specId: string) => void;
  column: 'draft' | 'in-progress' | 'done';
}

function SpecCard({ spec, workspaceId, onReviewClick, onRemove, column }: SpecCardProps) {
  const { show: showToast } = useGlobalToast();
  const [actionLoading, setActionLoading] = useState<'approve' | 'reject' | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [removing, setRemoving] = useState(false);

  const handleApprove = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setActionLoading('approve');
    try {
      await apiFetch(`/api/specs/${spec.id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      showToast('Spec approved', 'success');
      setRemoving(true);
      setTimeout(() => onRemove(spec.id), 300);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Approve failed';
      showToast(msg, 'error');
      setActionLoading(null);
    }
  };

  const handleRejectClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setRejecting(true);
  };

  const handleRejectCancel = (e: React.MouseEvent) => {
    e.stopPropagation();
    setRejecting(false);
    setRejectReason('');
  };

  const handleRejectConfirm = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setActionLoading('reject');
    try {
      await apiFetch(`/api/specs/${spec.id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, reason: rejectReason || undefined }),
      });
      showToast('Spec rejected', 'success');
      setRemoving(true);
      setTimeout(() => onRemove(spec.id), 300);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Reject failed';
      showToast(msg, 'error');
      setActionLoading(null);
    }
  };

  return (
    <div
      className={`bg-panel border border-border rounded-lg overflow-hidden transition-all duration-300 ${removing ? 'opacity-0 scale-95' : 'opacity-100 scale-100'}`}
    >
      {/* Card header */}
      <div className="p-3">
        <h3 className="text-sm font-semibold text-[var(--text)] truncate">
          {slugToTitle(spec.id)}
        </h3>
        <p className="text-xs text-muted mt-0.5 truncate">{spec.id}</p>

        <div className="flex items-center gap-1.5 mt-2 flex-wrap">
          {/* Story count badge */}
          <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-accent/10 text-accent border border-accent/20">
            {spec.storyCount} {spec.storyCount === 1 ? 'story' : 'stories'}
          </span>
          {/* Review status badge */}
          {reviewStatusLabel(spec.reviewStatus) && (
            <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-surface-100 text-muted border border-border">
              {reviewStatusLabel(spec.reviewStatus)}
            </span>
          )}
        </div>

        {/* Timestamp */}
        <p className="text-xs text-muted mt-2 flex items-center gap-1">
          <Clock size={11} />
          {column === 'done' && spec.approvedAt
            ? `Completed ${relativeTime(spec.approvedAt)}`
            : `Generated ${relativeTime(spec.generatedAt)}`}
        </p>
      </div>

      {/* Reject reason input (shown inline when rejecting) */}
      {rejecting && (
        <div
          className="px-3 pb-3 space-y-2"
          onClick={(e) => e.stopPropagation()}
        >
          <textarea
            autoFocus
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="Reason for rejection (optional)"
            rows={2}
            className="w-full text-sm px-3 py-2 rounded bg-surface-100 border border-border text-[var(--text)] placeholder:text-muted focus:outline-none focus:border-accent resize-none"
          />
          <div className="flex gap-2">
            <button
              onClick={handleRejectConfirm}
              disabled={actionLoading === 'reject'}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-error/10 text-error border border-error/30 hover:bg-error/20 disabled:opacity-50 transition-colors"
            >
              <XCircle size={13} />
              {actionLoading === 'reject' ? 'Rejecting…' : 'Confirm Reject'}
            </button>
            <button
              onClick={handleRejectCancel}
              className="px-3 py-1.5 rounded text-xs font-medium border border-border text-muted hover:text-[var(--text)] hover:bg-surface-100 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Action buttons — only show for draft column */}
      {column === 'draft' && !rejecting && (
        <div className="px-3 pb-3 flex gap-2">
          <button
            onClick={(e) => { e.stopPropagation(); onReviewClick(spec.id); }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium border border-border text-muted hover:text-[var(--text)] hover:bg-surface-100 transition-colors"
          >
            <Eye size={13} />
            Review
          </button>
          <button
            onClick={handleApprove}
            disabled={actionLoading === 'approve'}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-success/10 text-success border border-success/30 hover:bg-success/20 disabled:opacity-50 transition-colors"
          >
            <CheckCircle size={13} />
            {actionLoading === 'approve' ? 'Approving…' : 'Approve'}
          </button>
          <button
            onClick={handleRejectClick}
            disabled={actionLoading !== null}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-error/10 text-error border border-error/30 hover:bg-error/20 disabled:opacity-50 transition-colors"
          >
            <XCircle size={13} />
            Reject
          </button>
        </div>
      )}

      {/* View button for in-progress and done columns */}
      {column !== 'draft' && (
        <div className="px-3 pb-3">
          <button
            onClick={(e) => { e.stopPropagation(); onReviewClick(spec.id); }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium border border-border text-muted hover:text-[var(--text)] hover:bg-surface-100 transition-colors"
          >
            <Eye size={13} />
            View
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
  workspaceId: string;
  onReviewClick: (specId: string) => void;
  onRemove: (specId: string) => void;
}

function KanbanColumn({ config, specs, workspaceId, onReviewClick, onRemove }: KanbanColumnProps) {
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
      <div className="flex-1 overflow-y-auto min-h-0 p-3 space-y-3">
        {specs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Icon size={32} className="text-muted/30 mb-2" />
            <p className="text-sm text-muted">{config.emptyMessage}</p>
          </div>
        ) : (
          specs.map((spec) => (
            <SpecCard
              key={spec.id}
              spec={spec}
              workspaceId={workspaceId}
              onReviewClick={onReviewClick}
              onRemove={onRemove}
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

  const handleRemove = useCallback((specId: string) => {
    setSpecs((prev) => prev.filter((s) => s.id !== specId));
  }, []);

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
                <div className="flex-1 p-3 space-y-3">
                  {[1, 2].map((i) => (
                    <div key={i} className="bg-panel border border-border rounded-lg h-28 animate-pulse" />
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
                  workspaceId={workspaceId!}
                  onReviewClick={handleReviewClick}
                  onRemove={handleRemove}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
