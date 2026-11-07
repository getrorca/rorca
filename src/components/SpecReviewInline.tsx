/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * SpecReviewInline — Extracted from ReviewQueuePanel.tsx (UX-007)
 *
 * Shared components for inline spec review in Forge:
 *   - SpecPreview (header + tabs + action bar)
 *   - PreviewStoriesTab (story list with inline editing)
 *   - PreviewJsonTab (raw JSON viewer)
 *   - Types + helpers
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import {
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
  Share2,
  Link2,
  ExternalLink,
} from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';
import { StoryCard } from './StoryCard';
import type { Story } from './StoryCard';
import { InlineStoryEditor } from './InlineStoryEditor';
import { StoryComments } from './StoryComments';
import DependencyGraph from './DependencyGraph';
import MermaidDiagram from './MermaidDiagram';
import { AssigneeDropdown } from './AssigneeDropdown';
import type { Assignee } from './AssigneeDropdown';

/* ─── Types ───────────────────────────────────────────────────────── */

export type ReviewStatus = 'draft' | 'review_requested' | 'approved' | 'changes_requested';

export interface SpecSummary {
  id: string;
  specName: string;
  storyCount: number;
  status: 'pending' | 'approved' | 'completed';
  generatedAt: string;
  approvedAt?: string;
  readinessPercent?: number;
  tags?: string[];
  reviewStatus?: ReviewStatus;
  assignee?: Assignee;
  attachments?: import('../types').Attachment[];
}

export const REVIEW_STATUS_CONFIG: Record<ReviewStatus, { label: string; className: string; icon: typeof Eye }> = {
  draft: { label: 'Draft', className: 'bg-muted/15 text-muted border-muted/30', icon: AlertCircle },
  review_requested: { label: 'Needs Review', className: 'bg-accent/15 text-accent border-accent/30', icon: Eye },
  approved: { label: 'Review Approved', className: 'bg-success/15 text-success border-success/30', icon: CheckCircle2 },
  changes_requested: { label: 'Changes Requested', className: 'bg-warning/15 text-warning border-warning/30', icon: MessageSquare },
};

export interface SpecDetail {
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

export function relativeTime(iso: string): string {
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

/* ─── SpecPreview ─────────────────────────────────────────────────── */

export function SpecPreview({
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
  onDirtyChange,
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
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const stories = spec.userStories ?? spec.stories ?? [];
  const diagram = extractDiagramText(spec);

  const [specAssignee, setSpecAssignee] = useState<Assignee | null>(summary.assignee ?? null);

  // Share for Review
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareLoading, setShareLoading] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [hasNewComments, setHasNewComments] = useState(false);

  // Check for new review comments by polling comment counts
  const prevCommentCountRef = useRef<number | null>(null);
  useEffect(() => {
    setShareUrl(null);
    setHasNewComments(false);
    prevCommentCountRef.current = null;

    const checkNewComments = () => {
      apiFetch<{ counts: Record<string, number> }>(`/api/specs/${summary.id}/comments/counts`)
        .then(data => {
          const total = Object.values(data.counts).reduce((s, c) => s + c, 0);
          if (prevCommentCountRef.current !== null && total > prevCommentCountRef.current) {
            setHasNewComments(true);
          }
          prevCommentCountRef.current = total;
        })
        .catch(() => { });
    };

    checkNewComments();
    const interval = setInterval(checkNewComments, 15_000);
    return () => clearInterval(interval);
  }, [summary.id]);

  useEffect(() => {
    setSpecAssignee(summary.assignee ?? null);
  }, [summary.assignee]);

  const handleShareForReview = async () => {
    if (shareLoading) return;
    setShareLoading(true);
    try {
      const result = await apiFetch<{ url: string; token: string; expiresAt: string }>(
        `/api/specs/${summary.id}/review-link`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId }),
        },
      );
      setShareUrl(result.url);
      await navigator.clipboard.writeText(result.url);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 3000);
    } catch {
      // Error handled by global toast
    } finally {
      setShareLoading(false);
    }
  };

  const handleCopyShareUrl = async () => {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
    setShareCopied(true);
    setTimeout(() => setShareCopied(false), 2000);
  };

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
          <div className="flex items-center gap-2">
            <div className="relative">
              <button
                onClick={handleShareForReview}
                disabled={shareLoading}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded border border-border text-muted hover:text-text hover:border-accent/40 transition-colors disabled:opacity-50"
                title="Share for external review"
              >
                <Share2 size={12} />
                {shareLoading ? 'Generating...' : 'Share'}
              </button>
              {hasNewComments && (
                <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-accent animate-pulse" />
              )}
            </div>
            <AssigneeDropdown
              assignee={specAssignee}
              onAssign={handleAssignSpec}
              workspaceId={workspaceId}
              size="md"
            />
          </div>
        </div>
        {shareUrl && (
          <div className="flex items-center gap-2 mt-2 px-2.5 py-2 rounded bg-panel border border-border">
            <Link2 size={12} className="text-muted shrink-0" />
            <span className="text-xs font-mono text-text truncate flex-1">{shareUrl}</span>
            <button
              onClick={handleCopyShareUrl}
              className="shrink-0 flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
            >
              {shareCopied ? <><Check size={10} /> Copied</> : <><Copy size={10} /> Copy</>}
            </button>
            <a
              href={shareUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 p-1 text-muted hover:text-text transition-colors"
              title="Open review page"
            >
              <ExternalLink size={12} />
            </a>
          </div>
        )}
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
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 ${activeTab === tab.id
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
            onDirtyChange={onDirtyChange}
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
  onDirtyChange,
}: {
  stories: Story[];
  specId: string;
  workspaceId: string;
  onDirtyChange?: (dirty: boolean) => void;
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
  const [modifiedIds, setModifiedIds] = useState<Set<string>>(new Set());
  const [editorDirty, setEditorDirty] = useState(false);

  useEffect(() => {
    apiFetch<{ assignments: SpecAssignment[] }>(`/api/specs/${specId}/assignments?workspaceId=${workspaceId}`)
      .then(data => {
        const map: Record<string, Assignee> = {};
        for (const a of data.assignments) {
          if (a.storyId) map[a.storyId] = a.assignee;
        }
        setStoryAssignees(map);
      })
      .catch(() => { });
  }, [specId, workspaceId]);

  useEffect(() => {
    apiFetch<{ counts: Record<string, number> }>(`/api/specs/${specId}/comments/counts`)
      .then(data => setCommentCounts(data.counts))
      .catch(() => { });
  }, [specId]);

  useEffect(() => {
    setLocalStories(stories);
    setSelectedIds(new Set());
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
            <span className={`px-1.5 py-0.5 text-[10px] font-semibold rounded ${avgComplexity <= 2
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

      {localStories.map((story) =>
        editingStoryId === story.id ? (
          <InlineStoryEditor
            key={story.id}
            story={story}
            specId={specId}
            workspaceId={workspaceId}
            usePatch
            onDirtyChange={(dirty) => {
              setEditorDirty(dirty);
              onDirtyChange?.(dirty);
            }}
            onSave={(updated) => {
              setLocalStories(prev => prev.map(s => s.id === updated.id ? { ...s, ...updated } : s));
              setModifiedIds(prev => new Set([...prev, updated.id]));
              setEditingStoryId(null);
              setEditorDirty(false);
              onDirtyChange?.(false);
            }}
            onCancel={() => {
              setEditingStoryId(null);
              setEditorDirty(false);
              onDirtyChange?.(false);
            }}
          />
        ) : (
          <div key={story.id}>
            <StoryCard
              story={story}
              allStoryIds={allStoryIds}
              onEdit={() => {
                if (editorDirty) {
                  if (!window.confirm('You have unsaved changes. Discard them?')) return;
                }
                setEditorDirty(false);
                onDirtyChange?.(false);
                setEditingStoryId(story.id);
              }}
              selected={selectedIds.has(story.id)}
              onToggleSelect={() => toggleSelect(story.id)}
              specId={specId}
              workspaceId={workspaceId}
              commentCount={commentCounts[story.id] ?? 0}
              onOpenComments={() => setCommentsOpenFor(commentsOpenFor === story.id ? null : story.id)}
              assignee={storyAssignees[story.id] ?? null}
              modified={modifiedIds.has(story.id)}
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
