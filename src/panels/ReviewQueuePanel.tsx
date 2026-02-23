import { useState, useEffect, useCallback } from 'react';
import {
  ChevronRight,
  Inbox,
  Copy,
  Check,
  Clock,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { apiFetch } from '../lib/apiFetch';
import { StoryCard } from '../components/StoryCard';
import type { Story } from '../components/StoryCard';
import { InlineStoryEditor } from '../components/InlineStoryEditor';
import DependencyGraph from '../components/DependencyGraph';
import MermaidDiagram from '../components/MermaidDiagram';
import { useToast, ToastContainer } from '../components/Toast';
import { ReadinessRing } from '../components/ReadinessRing';

/* ─── Types ───────────────────────────────────────────────────────── */

interface SpecSummary {
  id: string;
  specName: string;
  storyCount: number;
  status: 'pending' | 'approved';
  generatedAt: string;
  approvedAt?: string;
  readinessPercent?: number;
}

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

  const selectedSpec = specs.find((s) => s.id === selectedId);

  return (
    <div className="flex h-full">
      {/* ─── Left column: Spec list ──────────────────────────────────── */}
      <div className="w-full xl:w-[380px] xl:shrink-0 xl:border-r xl:border-border flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-border shrink-0">
          <h2 className="text-sm font-semibold text-text">
            Pending Review
          </h2>
          <p className="text-xs text-muted mt-0.5">
            {specs.length} {specs.length === 1 ? 'spec' : 'specs'} awaiting approval
          </p>
        </div>

        <div className="flex-1 overflow-y-auto">
          {specs.map((spec) => (
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
                </div>
                <div className="flex items-center gap-2">
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
            workspaceId={workspaceId!}
          />
        )}
      </div>

      {/* ─── Mobile/tablet: detail as overlay when selected ────────── */}
      {selectedId && specDetail && (
        <div className="xl:hidden fixed inset-0 z-40 bg-bg flex flex-col">
          <div className="flex items-center px-4 py-3 border-b border-border shrink-0">
            <button
              onClick={() => { setSelectedId(null); setRejectingId(null); setRejectReason(''); }}
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
              workspaceId={workspaceId!}
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
  workspaceId,
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
  workspaceId: string;
}) {
  const stories = spec.userStories ?? spec.stories ?? [];
  const diagram = extractDiagramText(spec);

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
        <h3 className="text-base font-mono font-semibold text-text">{summary.specName}</h3>
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
        {rejectingId === summary.id ? (
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
        ) : (
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
        )}
      </div>
    </div>
  );
}

/* ─── Stories Tab ──────────────────────────────────────────────────── */

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

  // Sync when prop changes
  useEffect(() => { setLocalStories(stories); }, [stories]);

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

  return (
    <div className="p-4 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted">
          {localStories.length} {localStories.length === 1 ? 'story' : 'stories'}
          <span className="ml-2 text-muted/70">{readyCount}/{localStories.length} ready</span>
        </span>
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
          <StoryCard
            key={story.id}
            story={story}
            allStoryIds={allStoryIds}
            onEdit={() => setEditingStoryId(story.id)}
          />
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
