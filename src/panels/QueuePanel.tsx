import { useState, useEffect, useCallback } from 'react';
import { Clock, CheckCircle, XCircle, Eye, Inbox, ArrowRight } from 'lucide-react';
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
}

function SpecCard({ spec, workspaceId, onReviewClick, onRemove }: SpecCardProps) {
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
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-[var(--text)] truncate">
              {slugToTitle(spec.id)}
            </h3>
            <p className="text-xs text-muted mt-0.5 truncate">{spec.id}</p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
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
        </div>

        {/* Timestamp */}
        <p className="text-xs text-muted mt-2 flex items-center gap-1">
          <Clock size={11} />
          Generated {relativeTime(spec.generatedAt)}
        </p>
      </div>

      {/* Reject reason input (shown inline when rejecting) */}
      {rejecting && (
        <div
          className="px-4 pb-3 space-y-2"
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

      {/* Action buttons */}
      {!rejecting && (
        <div className="px-4 pb-4 flex gap-2">
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
    </div>
  );
}

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
        `/api/specs?workspaceId=${workspaceId}&status=pending`
      );
      // Sort newest first
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

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border shrink-0">
        <h1 className="text-lg font-semibold text-[var(--text)]">Review Queue</h1>
        <p className="text-sm text-muted mt-0.5">
          {loading ? 'Loading…' : `${specs.length} spec${specs.length === 1 ? '' : 's'} awaiting review`}
        </p>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto min-h-0 p-6">
        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="bg-panel border border-border rounded-lg h-32 animate-pulse" />
            ))}
          </div>
        ) : specs.length === 0 ? (
          /* Empty state */
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
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {specs.map((spec) => (
              <SpecCard
                key={spec.id}
                spec={spec}
                workspaceId={workspaceId!}
                onReviewClick={(id) => onNavigateToSpecReview ? onNavigateToSpecReview(id) : onNavigate('forge')}
                onRemove={handleRemove}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
