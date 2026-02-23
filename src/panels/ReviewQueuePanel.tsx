import { useState, useEffect, useCallback } from 'react';
import {
  ChevronRight,
  Inbox,
  Copy,
  Check,
  Clock,
  CheckCircle2,
  XCircle,
  MinusCircle,
  PlusCircle,
  Trash2,
  Gauge,
  Send,
  Eye,
  MessageSquare,
  AlertCircle,
} from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { apiFetch } from '../lib/apiFetch';
import { StoryCard } from '../components/StoryCard';
import type { Story } from '../components/StoryCard';
import { InlineStoryEditor } from '../components/InlineStoryEditor';
import { StoryComments } from '../components/StoryComments';
import DependencyGraph from '../components/DependencyGraph';
import MermaidDiagram from '../components/MermaidDiagram';
import { useToast, ToastContainer } from '../components/Toast';
import { ReadinessRing } from '../components/ReadinessRing';
import { TagChipsReadonly } from '../components/TagChips';
import { AssigneeDropdown, AssigneeAvatar } from '../components/AssigneeDropdown';
import type { Assignee } from '../components/AssigneeDropdown';

/* ─── Types ───────────────────────────────────────────────────────── */

type ReviewStatus = 'draft' | 'review_requested' | 'approved' | 'changes_requested';
type ReviewFilter = 'all' | 'review_requested' | 'changes_requested';

interface SpecSummary {
  id: string;
  specName: string;
  storyCount: number;
  status: 'pending' | 'approved';
  generatedAt: string;
  approvedAt?: string;
  readinessPercent?: number;
  tags?: string[];
  reviewStatus?: ReviewStatus;
  assignee?: Assignee;
}

const REVIEW_STATUS_CONFIG: Record<ReviewStatus, { label: string; className: string; icon: typeof Eye }> = {
  draft: { label: 'Draft', className: 'bg-muted/15 text-muted border-muted/30', icon: AlertCircle },
  review_requested: { label: 'Needs Review', className: 'bg-accent/15 text-accent border-accent/30', icon: Eye },
  approved: { label: 'Review Approved', className: 'bg-success/15 text-success border-success/30', icon: CheckCircle2 },
  changes_requested: { label: 'Changes Requested', className: 'bg-warning/15 text-warning border-warning/30', icon: MessageSquare },
};

const REVIEW_FILTERS: { id: ReviewFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'review_requested', label: 'Needs Review' },
  { id: 'changes_requested', label: 'Changes Requested' },
];

interface SpecDetail {
  title?: string;
  userStories?: Story[];
  stories?: Story[];
  diagrams?: Record<string, { mermaid?: string; ascii?: string }>;
  mermaidDiagram?: string;
  model?: string;
  readinessPercent?: number;
  [key: string]: unknown;
}

type PreviewTab = 'stories' | 'graph' | 'diagram' | 'json';

/* ─── Helpers ─────────────────────────────────────────────────────── */

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
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

export default function ReviewQueuePanel() {
  const { workspaceId } = useWorkspace();
  const { toasts, show: showToast, dismiss } = useToast();

  const [specs, setSpecs] = useState<SpecSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [specDetail, setSpecDetail] = useState<SpecDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [activeTab, setActiveTab] = useState<PreviewTab>('stories');
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>('all');
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [reviewComment, setReviewComment] = useState('');

  // ─── Fetch spec list ───────────────────────────────────────────────
  const fetchSpecs = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch<{ specs: SpecSummary[] }>(
        `/api/specs?workspaceId=${workspaceId}&status=pending`,
      );
      setSpecs(res.specs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load specs');
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    fetchSpecs();
  }, [fetchSpecs]);

  // ─── Fetch spec detail when selected ───────────────────────────────
  useEffect(() => {
    if (!selectedId || !workspaceId) {
      setSpecDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    apiFetch<SpecDetail>(`/api/specs/${selectedId}?workspaceId=${workspaceId}`)
      .then((detail) => {
        if (!cancelled) {
          setSpecDetail(detail);
          setActiveTab('stories');
        }
      })
      .catch(() => {
        if (!cancelled) setSpecDetail(null);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => { cancelled = true; };
  }, [selectedId, workspaceId]);

  // ─── Actions ───────────────────────────────────────────────────────
  const handleApprove = async (specId: string) => {
    setActionLoading(true);
    try {
      await apiFetch(`/api/specs/${specId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      showToast('Spec approved', 'success');
      if (selectedId === specId) {
        setSelectedId(null);
        setSpecDetail(null);
      }
      await fetchSpecs();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Approve failed', 'error');
    } finally {
      setActionLoading(false);
    }
  };

  const handleReject = async (specId: string) => {
    setActionLoading(true);
    try {
      await apiFetch(`/api/specs/${specId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, reason: rejectReason || undefined }),
      });
      showToast('Spec rejected', 'success');
      setRejectingId(null);
      setRejectReason('');
      if (selectedId === specId) {
        setSelectedId(null);
        setSpecDetail(null);
      }
      await fetchSpecs();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Reject failed', 'error');
    } finally {
      setActionLoading(false);
    }
  };

  const handleRequestReview = async (specId: string) => {
    setActionLoading(true);
    try {
      await apiFetch(`/api/specs/${specId}/request-review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      showToast('Review requested', 'success');
      await fetchSpecs();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Request review failed', 'error');
    } finally {
      setActionLoading(false);
    }
  };

  const handleReview = async (specId: string, action: 'approve' | 'request_changes') => {
    setActionLoading(true);
    try {
      await apiFetch(`/api/specs/${specId}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          action,
          comment: reviewComment || undefined,
        }),
      });
      showToast(action === 'approve' ? 'Review approved' : 'Changes requested', 'success');
      setReviewingId(null);
      setReviewComment('');
      if (selectedId === specId) {
        setSelectedId(null);
        setSpecDetail(null);
      }
      await fetchSpecs();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Review failed', 'error');
    } finally {
      setActionLoading(false);
    }
  };

  // Apply review status filter
  const filteredSpecs = reviewFilter === 'all'
    ? specs
    : specs.filter(s => (s.reviewStatus ?? 'draft') === reviewFilter);

  // ─── No workspace selected ────────────────────────────────────────
  if (!workspaceId) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        Select a workspace to view pending specs
      </div>
    );
  }

  // ─── Loading state ────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        Loading specs...
      </div>
    );
  }

  // ─── Error state ──────────────────────────────────────────────────
  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <p className="text-sm text-error mb-2">{error}</p>
          <button
            onClick={fetchSpecs}
            className="text-xs text-accent hover:text-accent-hover transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // ─── Empty state ──────────────────────────────────────────────────
  if (specs.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-4 p-8 border-2 border-dashed border-border rounded-lg max-w-xs text-center">
          <Inbox size={64} className="text-muted/40" strokeWidth={1.2} />
          <div>
            <p className="text-sm font-medium text-text mb-1">No specs pending review</p>
            <p className="text-xs text-muted">
              Generate one in Spec Forge
            </p>
          </div>
        </div>
        <ToastContainer toasts={toasts} onDismiss={dismiss} />
      </div>
    );
  }

  const selectedSpec = filteredSpecs.find((s) => s.id === selectedId);

  return (
    <div className="flex h-full">
      {/* ─── Left column: Spec list ──────────────────────────────────── */}
      <div className="w-full xl:w-[380px] xl:shrink-0 xl:border-r xl:border-border flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-border shrink-0">
          <h2 className="text-sm font-semibold text-text">
            Pending Review
          </h2>
          <p className="text-xs text-muted mt-0.5">
            {filteredSpecs.length} of {specs.length} {specs.length === 1 ? 'spec' : 'specs'}
          </p>
          <div className="flex gap-1 mt-2">
            {REVIEW_FILTERS.map((f) => {
              const count = f.id === 'all'
                ? specs.length
                : specs.filter(s => (s.reviewStatus ?? 'draft') === f.id).length;
              return (
                <button
                  key={f.id}
                  onClick={() => setReviewFilter(f.id)}
                  className={`px-2 py-1 text-[10px] font-medium rounded transition-colors ${
                    reviewFilter === f.id
                      ? 'bg-accent/15 text-accent border border-accent/30'
                      : 'text-muted border border-transparent hover:text-text hover:border-border'
                  }`}
                >
                  {f.label}
                  {count > 0 && <span className="ml-1 opacity-70">({count})</span>}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {filteredSpecs.map((spec) => (
            <button
              key={spec.id}
              onClick={() => setSelectedId(spec.id === selectedId ? null : spec.id)}
              className={`w-full text-left px-4 py-3 border-b border-border transition-colors ${
                spec.id === selectedId
                  ? 'bg-accent/10'
                  : 'hover:bg-panel'
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <span className="inline-block w-2 h-2 rounded-full bg-warning shrink-0" />
                  <span className="text-[10px] font-medium text-muted uppercase tracking-wide">
                    US
                  </span>
                  <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-accent/15 text-accent">
                    {spec.storyCount} {spec.storyCount === 1 ? 'story' : 'stories'}
                  </span>
                  {(() => {
                    const rs = spec.reviewStatus ?? 'draft';
                    const cfg = REVIEW_STATUS_CONFIG[rs];
                    const Icon = cfg.icon;
                    return (
                      <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-medium rounded border ${cfg.className}`}>
                        <Icon size={10} />
                        {cfg.label}
                      </span>
                    );
                  })()}
                </div>
                <div className="flex items-center gap-2">
                  {spec.assignee && <AssigneeAvatar assignee={spec.assignee} size="sm" />}
                  {spec.readinessPercent != null && (
                    <ReadinessRing percent={spec.readinessPercent} size={28} />
                  )}
                  <span className="text-[10px] text-muted flex items-center gap-1">
                    <Clock size={10} />
                    {relativeTime(spec.generatedAt)}
                  </span>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-mono text-text truncate pr-2">
                  {spec.id}
                </span>
                <ChevronRight
                  size={14}
                  className={`shrink-0 text-muted transition-transform ${
                    spec.id === selectedId ? 'rotate-90' : ''
                  }`}
                />
              </div>
              {spec.tags && spec.tags.length > 0 && (
                <div className="mt-1">
                  <TagChipsReadonly tags={spec.tags} />
                </div>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* ─── Right column: Spec preview (xl+ only, or replaces list) ─ */}
      <div className="hidden xl:flex flex-col flex-1 overflow-hidden">
        {!selectedId || !specDetail ? (
          <div className="flex items-center justify-center h-full text-muted text-sm">
            {detailLoading ? 'Loading spec...' : 'Select a spec to preview'}
          </div>
        ) : (
          <SpecPreview
            spec={specDetail}
            summary={selectedSpec!}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            rejectingId={rejectingId}
            rejectReason={rejectReason}
            actionLoading={actionLoading}
            onRejectReasonChange={setRejectReason}
            onStartReject={() => setRejectingId(selectedId)}
            onCancelReject={() => { setRejectingId(null); setRejectReason(''); }}
            onConfirmReject={() => handleReject(selectedId)}
            onApprove={() => handleApprove(selectedId)}
            onRequestReview={() => handleRequestReview(selectedId)}
            reviewingId={reviewingId}
            reviewComment={reviewComment}
            onReviewCommentChange={setReviewComment}
            onStartReview={() => setReviewingId(selectedId)}
            onCancelReview={() => { setReviewingId(null); setReviewComment(''); }}
            onConfirmReview={(action) => handleReview(selectedId, action)}
            workspaceId={workspaceId!}
            onAssignSpec={(a) => setSpecs(prev => prev.map(s => s.id === selectedId ? { ...s, assignee: a ?? undefined } : s))}
          />
        )}
      </div>

      {/* ─── Mobile/tablet: detail as overlay when selected ────────── */}
      {selectedId && specDetail && (
        <div className="xl:hidden fixed inset-0 z-40 bg-bg flex flex-col">
          <div className="flex items-center px-4 py-3 border-b border-border shrink-0">
            <button
              onClick={() => { setSelectedId(null); setRejectingId(null); setRejectReason(''); setReviewingId(null); setReviewComment(''); }}
              className="text-xs text-accent hover:text-accent-hover transition-colors mr-3"
            >
              &larr; Back
            </button>
            <span className="text-sm font-mono text-text truncate">{selectedId}</span>
          </div>
          <div className="flex-1 overflow-hidden">
            <SpecPreview
              spec={specDetail}
              summary={selectedSpec!}
              activeTab={activeTab}
              onTabChange={setActiveTab}
              rejectingId={rejectingId}
              rejectReason={rejectReason}
              actionLoading={actionLoading}
              onRejectReasonChange={setRejectReason}
              onStartReject={() => setRejectingId(selectedId)}
              onCancelReject={() => { setRejectingId(null); setRejectReason(''); }}
              onConfirmReject={() => handleReject(selectedId)}
              onApprove={() => handleApprove(selectedId)}
              onRequestReview={() => handleRequestReview(selectedId)}
              reviewingId={reviewingId}
              reviewComment={reviewComment}
              onReviewCommentChange={setReviewComment}
              onStartReview={() => setReviewingId(selectedId)}
              onCancelReview={() => { setReviewingId(null); setReviewComment(''); }}
              onConfirmReview={(action) => handleReview(selectedId, action)}
              workspaceId={workspaceId!}
              onAssignSpec={(a) => setSpecs(prev => prev.map(s => s.id === selectedId ? { ...s, assignee: a ?? undefined } : s))}
            />
          </div>
        </div>
      )}

      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

/* ─── Spec Preview ────────────────────────────────────────────────── */

function SpecPreview({
  spec,
  summary,
  activeTab,
  onTabChange,
  rejectingId,
  rejectReason,
  actionLoading,
  onRejectReasonChange,
  onStartReject,
  onCancelReject,
  onConfirmReject,
  onApprove,
  onRequestReview,
  reviewingId,
  reviewComment,
  onReviewCommentChange,
  onStartReview,
  onCancelReview,
  onConfirmReview,
  workspaceId,
  onAssignSpec,
}: {
  spec: SpecDetail;
  summary: SpecSummary;
  activeTab: PreviewTab;
  onTabChange: (tab: PreviewTab) => void;
  rejectingId: string | null;
  rejectReason: string;
  actionLoading: boolean;
  onRejectReasonChange: (v: string) => void;
  onStartReject: () => void;
  onCancelReject: () => void;
  onConfirmReject: () => void;
  onApprove: () => void;
  onRequestReview: () => void;
  reviewingId: string | null;
  reviewComment: string;
  onReviewCommentChange: (v: string) => void;
  onStartReview: () => void;
  onCancelReview: () => void;
  onConfirmReview: (action: 'approve' | 'request_changes') => void;
  workspaceId: string;
  onAssignSpec?: (assignee: Assignee | null) => void;
}) {
  const stories = spec.userStories ?? spec.stories ?? [];
  const diagram = extractDiagramText(spec);

  const [specAssignee, setSpecAssignee] = useState<Assignee | null>(summary.assignee ?? null);

  // Sync when summary changes
  useEffect(() => {
    setSpecAssignee(summary.assignee ?? null);
  }, [summary.assignee]);

  const handleAssignSpec = async (userId: string | null) => {
    const result = await apiFetch<{ ok: boolean; assignee?: Assignee; assigneeId?: null }>(
      `/api/specs/${summary.id}/assign`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, assigneeId: userId }),
      },
    );
    if (result.ok) {
      const newAssignee = result.assignee ?? null;
      setSpecAssignee(newAssignee);
      onAssignSpec?.(newAssignee);
    }
  };

  const tabs: { id: PreviewTab; label: string; badge?: string }[] = [
    { id: 'stories', label: 'Stories', badge: `${stories.length}` },
    { id: 'graph', label: 'Graph' },
    { id: 'diagram', label: 'Dependencies' },
    { id: 'json', label: 'Raw JSON' },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border shrink-0">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-mono font-semibold text-text">{summary.specName}</h3>
          <AssigneeDropdown
            assignee={specAssignee}
            onAssign={handleAssignSpec}
            workspaceId={workspaceId}
            size="md"
          />
        </div>
        <div className="flex items-center gap-3 mt-0.5">
          <p className="text-xs text-muted flex items-center gap-1">
            <Clock size={10} />
            Generated {relativeTime(summary.generatedAt)}
          </p>
          {spec.model && (
            <span className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-panel border border-border text-muted">
              {spec.model}
            </span>
          )}
        </div>
      </div>

      {/* Tab strip */}
      <div className="flex border-b border-border shrink-0">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 ${
              activeTab === tab.id
                ? 'text-text border-accent'
                : 'text-muted hover:text-text border-transparent'
            }`}
          >
            {tab.label}
            {tab.badge && (
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
          <PreviewStoriesTab
            stories={stories}
            specId={summary.id}
            workspaceId={workspaceId}
          />
        )}
        {activeTab === 'graph' && <DependencyGraph specId={summary.id} workspaceId={workspaceId} />}
        {activeTab === 'diagram' && <MermaidDiagram diagram={diagram} idPrefix="mermaid-review" />}
        {activeTab === 'json' && <PreviewJsonTab spec={spec} />}
      </div>

      {/* Action bar */}
      <div className="px-4 py-3 border-t border-border shrink-0 bg-bg">
        {(() => {
          const rs = summary.reviewStatus ?? 'draft';

          // Reject confirmation panel (shared across statuses)
          if (rejectingId === summary.id) {
            return (
              <div className="space-y-2">
                <textarea
                  value={rejectReason}
                  onChange={(e) => onRejectReasonChange(e.target.value)}
                  placeholder="Reason for rejection (optional)"
                  className="w-full px-3 py-2 text-sm bg-panel border border-border rounded text-text placeholder:text-muted/50 resize-none focus:outline-none focus:border-accent"
                  rows={2}
                />
                <div className="flex gap-2">
                  <button
                    onClick={onConfirmReject}
                    disabled={actionLoading}
                    className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded text-sm font-medium bg-error text-white hover:bg-error/90 transition-colors disabled:opacity-50"
                  >
                    <XCircle size={14} />
                    Confirm Reject
                  </button>
                  <button
                    onClick={onCancelReject}
                    className="px-4 py-2 rounded text-sm font-medium text-muted border border-border hover:text-text transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            );
          }

          // Review comment panel (for reviewer performing a review)
          if (reviewingId === summary.id) {
            return (
              <div className="space-y-2">
                <textarea
                  value={reviewComment}
                  onChange={(e) => onReviewCommentChange(e.target.value)}
                  placeholder="Review comment (optional)"
                  className="w-full px-3 py-2 text-sm bg-panel border border-border rounded text-text placeholder:text-muted/50 resize-none focus:outline-none focus:border-accent"
                  rows={2}
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => onConfirmReview('approve')}
                    disabled={actionLoading}
                    className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded text-sm font-medium bg-success text-white hover:bg-success/90 transition-colors disabled:opacity-50"
                  >
                    <CheckCircle2 size={14} />
                    Approve Review
                  </button>
                  <button
                    onClick={() => onConfirmReview('request_changes')}
                    disabled={actionLoading}
                    className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded text-sm font-medium bg-warning text-white hover:bg-warning/90 transition-colors disabled:opacity-50"
                  >
                    <MessageSquare size={14} />
                    Request Changes
                  </button>
                  <button
                    onClick={onCancelReview}
                    className="px-4 py-2 rounded text-sm font-medium text-muted border border-border hover:text-text transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            );
          }

          // Draft / Changes Requested: show "Request Review" + original approve/reject
          if (rs === 'draft' || rs === 'changes_requested') {
            return (
              <div className="flex gap-2">
                <button
                  onClick={onRequestReview}
                  disabled={actionLoading}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded text-sm font-medium bg-accent text-white hover:bg-accent/90 transition-colors disabled:opacity-50"
                >
                  <Send size={14} />
                  Request Review
                </button>
                <button
                  onClick={onApprove}
                  disabled={actionLoading}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded text-sm font-medium bg-success text-white hover:bg-success/90 transition-colors disabled:opacity-50"
                >
                  <CheckCircle2 size={14} />
                  Approve
                </button>
                <button
                  onClick={onStartReject}
                  disabled={actionLoading}
                  className="flex items-center justify-center gap-1.5 px-3 py-2 rounded text-sm font-medium text-error border border-error/40 hover:bg-error/10 transition-colors disabled:opacity-50"
                >
                  <XCircle size={14} />
                </button>
              </div>
            );
          }

          // Review Requested: show review actions for reviewer
          if (rs === 'review_requested') {
            return (
              <div className="flex gap-2">
                <button
                  onClick={onStartReview}
                  disabled={actionLoading}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded text-sm font-medium bg-accent text-white hover:bg-accent/90 transition-colors disabled:opacity-50"
                >
                  <Eye size={14} />
                  Review
                </button>
                <button
                  onClick={onApprove}
                  disabled={actionLoading}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded text-sm font-medium bg-success text-white hover:bg-success/90 transition-colors disabled:opacity-50"
                >
                  <CheckCircle2 size={14} />
                  Approve
                </button>
                <button
                  onClick={onStartReject}
                  disabled={actionLoading}
                  className="flex items-center justify-center gap-1.5 px-3 py-2 rounded text-sm font-medium text-error border border-error/40 hover:bg-error/10 transition-colors disabled:opacity-50"
                >
                  <XCircle size={14} />
                </button>
              </div>
            );
          }

          // Review Approved: show approve (move to approved/) + reject
          return (
            <div className="flex gap-2">
              <button
                onClick={onApprove}
                disabled={actionLoading}
                className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded text-sm font-medium bg-success text-white hover:bg-success/90 transition-colors disabled:opacity-50"
              >
                <CheckCircle2 size={14} />
                Approve
              </button>
              <button
                onClick={onStartReject}
                disabled={actionLoading}
                className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded text-sm font-medium text-error border border-error/40 hover:bg-error/10 transition-colors disabled:opacity-50"
              >
                <XCircle size={14} />
                Reject
              </button>
            </div>
          );
        })()}
      </div>
    </div>
  );
}

/* ─── Stories Tab ──────────────────────────────────────────────────── */

interface SpecAssignment {
  specId: string;
  storyId: string | null;
  assignee: Assignee;
  assignedAt: string;
}

function PreviewStoriesTab({
  stories,
  specId,
  workspaceId,
}: {
  stories: Story[];
  specId: string;
  workspaceId: string;
}) {
  const [editingStoryId, setEditingStoryId] = useState<string | null>(null);
  const [localStories, setLocalStories] = useState(stories);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);
  const [priorityValue, setPriorityValue] = useState(3);
  const [showPriorityPicker, setShowPriorityPicker] = useState(false);
  const [commentCounts, setCommentCounts] = useState<Record<string, number>>({});
  const [commentsOpenFor, setCommentsOpenFor] = useState<string | null>(null);
  const [storyAssignees, setStoryAssignees] = useState<Record<string, Assignee>>({});

  // Fetch assignments for this spec
  useEffect(() => {
    apiFetch<{ assignments: SpecAssignment[] }>(`/api/specs/${specId}/assignments?workspaceId=${workspaceId}`)
      .then(data => {
        const map: Record<string, Assignee> = {};
        for (const a of data.assignments) {
          if (a.storyId) map[a.storyId] = a.assignee;
        }
        setStoryAssignees(map);
      })
      .catch(() => {});
  }, [specId, workspaceId]);

  // Fetch unresolved comment counts per story
  useEffect(() => {
    apiFetch<{ counts: Record<string, number> }>(`/api/specs/${specId}/comments/counts`)
      .then(data => setCommentCounts(data.counts))
      .catch(() => {});
  }, [specId]);

  // Sync when prop changes
  useEffect(() => {
    setLocalStories(stories);
    setSelectedIds(new Set()); // clear selection on story data refresh
  }, [stories]);

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === localStories.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(localStories.map(s => s.id)));
    }
  };

  const executeBulkAction = async (action: string, extra?: Record<string, unknown>) => {
    if (selectedIds.size === 0) return;
    setBulkLoading(true);
    try {
      const result = await apiFetch<{ ok: boolean; stories: Story[] }>(
        `/api/specs/${specId}/stories/bulk`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspaceId,
            action,
            storyIds: [...selectedIds],
            ...extra,
          }),
        },
      );
      if (result.stories) {
        setLocalStories(result.stories);
      }
      setSelectedIds(new Set());
      setShowPriorityPicker(false);
    } catch (err) {
      console.error('Bulk action failed:', err);
    } finally {
      setBulkLoading(false);
    }
  };

  if (localStories.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        No stories found in this spec
      </div>
    );
  }

  const complexityScores = localStories.map(s => s.complexity).filter((c): c is number => c != null);
  const hasComplexity = complexityScores.length > 0;
  const totalComplexity = complexityScores.reduce((sum, c) => sum + c, 0);
  const avgComplexity = hasComplexity ? totalComplexity / complexityScores.length : 0;
  const allStoryIds = new Set(localStories.map(s => s.id));
  const readyCount = localStories.filter(s => {
    const ac = s.acceptanceCriteria ?? [];
    const deps = s.dependsOn ?? s.dependencies ?? [];
    return ac.length >= 3 && deps.every(d => allStoryIds.has(d));
  }).length;

  const hasSelection = selectedIds.size > 0;
  const allSelected = selectedIds.size === localStories.length;

  return (
    <div className="p-4 space-y-2">
      {/* Header with Select All + stats */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={allSelected}
              ref={(el) => { if (el) el.indeterminate = hasSelection && !allSelected; }}
              onChange={toggleSelectAll}
              className="w-3.5 h-3.5 rounded border-border accent-accent cursor-pointer"
            />
            <span className="text-xs text-muted">
              {hasSelection ? `${selectedIds.size} selected` : 'Select all'}
            </span>
          </label>
          <span className="text-xs text-muted/50">|</span>
          <span className="text-xs text-muted">
            {localStories.length} {localStories.length === 1 ? 'story' : 'stories'}
            <span className="ml-2 text-muted/70">{readyCount}/{localStories.length} ready</span>
          </span>
        </div>
        {hasComplexity && (
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted">
              Total: <span className="font-semibold text-text">{totalComplexity} pts</span>
            </span>
            <span className={`px-1.5 py-0.5 text-[10px] font-semibold rounded ${
              avgComplexity <= 2
                ? 'bg-success/15 text-success'
                : avgComplexity <= 3
                ? 'bg-warning/15 text-warning'
                : 'bg-error/15 text-error'
            }`}>
              Avg {avgComplexity.toFixed(1)}
            </span>
          </div>
        )}
      </div>

      {/* Bulk action toolbar */}
      {hasSelection && (
        <div className="flex items-center gap-2 px-3 py-2 rounded border border-accent/30 bg-accent/5">
          <span className="text-xs font-medium text-text mr-1">
            {selectedIds.size} selected
          </span>
          <button
            onClick={() => executeBulkAction('exclude')}
            disabled={bulkLoading}
            className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded border border-border text-warning hover:bg-warning/10 transition-colors disabled:opacity-50"
            title="Exclude selected stories"
          >
            <MinusCircle size={12} />
            Exclude
          </button>
          <button
            onClick={() => executeBulkAction('include')}
            disabled={bulkLoading}
            className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded border border-border text-success hover:bg-success/10 transition-colors disabled:opacity-50"
            title="Include selected stories"
          >
            <PlusCircle size={12} />
            Include
          </button>
          <button
            onClick={() => executeBulkAction('delete')}
            disabled={bulkLoading}
            className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded border border-border text-error hover:bg-error/10 transition-colors disabled:opacity-50"
            title="Delete selected stories"
          >
            <Trash2 size={12} />
            Delete
          </button>
          <div className="relative">
            <button
              onClick={() => setShowPriorityPicker(!showPriorityPicker)}
              disabled={bulkLoading}
              className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded border border-border text-accent hover:bg-accent/10 transition-colors disabled:opacity-50"
              title="Set priority for selected stories"
            >
              <Gauge size={12} />
              Priority
            </button>
            {showPriorityPicker && (
              <div className="absolute top-full left-0 mt-1 p-2 rounded border border-border bg-bg shadow-lg z-20 flex items-center gap-2">
                <select
                  value={priorityValue}
                  onChange={(e) => setPriorityValue(Number(e.target.value))}
                  className="px-2 py-1 text-xs rounded border border-border bg-panel text-text"
                >
                  {[1, 2, 3, 4, 5].map(v => (
                    <option key={v} value={v}>C{v}</option>
                  ))}
                </select>
                <button
                  onClick={() => executeBulkAction('set_priority', { priority: priorityValue })}
                  disabled={bulkLoading}
                  className="px-2 py-1 text-xs font-medium rounded bg-accent text-white hover:bg-accent/90 transition-colors disabled:opacity-50"
                >
                  Apply
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Story cards */}
      {localStories.map((story) =>
        editingStoryId === story.id ? (
          <InlineStoryEditor
            key={story.id}
            story={story}
            specId={specId}
            workspaceId={workspaceId}
            onSave={(updated) => {
              setLocalStories(prev => prev.map(s => s.id === updated.id ? { ...s, ...updated } : s));
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
              selected={selectedIds.has(story.id)}
              onToggleSelect={() => toggleSelect(story.id)}
              specId={specId}
              workspaceId={workspaceId}
              commentCount={commentCounts[story.id] ?? 0}
              onOpenComments={() => setCommentsOpenFor(commentsOpenFor === story.id ? null : story.id)}
              assignee={storyAssignees[story.id] ?? null}
              onAssignStory={async (userId) => {
                const result = await apiFetch<{ ok: boolean; assignee?: Assignee }>(`/api/specs/${specId}/stories/${story.id}/assign`, {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ workspaceId, assigneeId: userId }),
                });
                if (result.ok) {
                  setStoryAssignees(prev => {
                    const next = { ...prev };
                    if (result.assignee) next[story.id] = result.assignee;
                    else delete next[story.id];
                    return next;
                  });
                }
              }}
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
/* Uses shared MermaidDiagram component with zoom/pan/copy controls */

/* ─── Raw JSON Tab ────────────────────────────────────────────────── */

function PreviewJsonTab({ spec }: { spec: SpecDetail }) {
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
