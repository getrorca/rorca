import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  XCircle,
  ListChecks,
} from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { apiFetch } from '../lib/apiFetch';
import { ReadinessRing } from '../components/ReadinessRing';
import type { PanelId } from '../components/Sidebar';

/* ─── Types ───────────────────────────────────────────────────────── */

interface Story {
  id: string;
  title: string;
  description?: string;
  acceptanceCriteria: string[];
  dependencies?: string[];
  dependsOn?: string[];
  complexity?: number;
  passes?: boolean;
  excluded?: boolean;
}

interface SpecDetail {
  title?: string;
  specName?: string;
  userStories?: Story[];
  stories?: Story[];
  model?: string;
  generatedAt?: string;
  [key: string]: unknown;
}

/* ─── Complexity badge ────────────────────────────────────────────── */

function ComplexityBadge({ value }: { value: number }) {
  const style =
    value <= 2
      ? 'bg-success/15 text-success'
      : value === 3
      ? 'bg-warning/15 text-warning'
      : 'bg-error/15 text-error';
  return (
    <span className={`shrink-0 px-1.5 py-0.5 text-[10px] font-semibold rounded ${style}`}>
      C{value}
    </span>
  );
}

/* ─── Story Review Card ───────────────────────────────────────────── */

function StoryReviewCard({
  story,
  allStoryIds,
  expanded,
  focused,
  onToggle,
}: {
  story: Story;
  allStoryIds: Set<string>;
  expanded: boolean;
  focused: boolean;
  onToggle: () => void;
}) {
  const deps = story.dependsOn ?? story.dependencies ?? [];
  const ac = story.acceptanceCriteria ?? [];
  const [checkedAc, setCheckedAc] = useState<Set<number>>(new Set());
  const isDone = story.passes === true;
  const isExcluded = story.excluded === true && !isDone;

  const toggleAc = (idx: number) => {
    setCheckedAc((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  return (
    <div
      data-story-id={story.id}
      className={`border rounded-lg bg-panel transition-all ${
        focused ? 'ring-2 ring-accent/50 border-accent' : 'border-border'
      } ${isExcluded ? 'opacity-50' : ''}`}
    >
      {/* Collapsed row */}
      <button
        onClick={onToggle}
        className="w-full text-left px-4 py-3 flex items-center gap-3"
      >
        {/* Expand icon */}
        {expanded ? (
          <ChevronDown size={14} className="text-muted shrink-0" />
        ) : (
          <ChevronRight size={14} className="text-muted shrink-0" />
        )}

        {/* ID badge */}
        <span
          className={`shrink-0 px-1.5 py-0.5 text-[10px] font-mono font-semibold rounded ${
            isDone
              ? 'bg-success/15 text-success'
              : isExcluded
              ? 'bg-muted/15 text-muted'
              : 'bg-accent/15 text-accent'
          }`}
        >
          {story.id}
        </span>

        {/* Title */}
        <span
          className={`text-sm font-medium truncate flex-1 ${
            isExcluded ? 'text-muted line-through' : 'text-text'
          }`}
        >
          {story.title}
        </span>

        {/* Complexity badge */}
        {story.complexity != null && <ComplexityBadge value={story.complexity} />}

        {/* Done badge */}
        {isDone && (
          <span className="shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-semibold rounded bg-success/15 text-success">
            <CheckCircle2 size={9} />
            DONE
          </span>
        )}

        {/* Dependency indicator */}
        {deps.length > 0 && (
          <span className="shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded bg-warning/15 text-warning">
            {deps.length} dep{deps.length !== 1 ? 's' : ''}
          </span>
        )}

        {/* AC count */}
        <span className="shrink-0 text-[10px] text-muted">
          {ac.length} AC
        </span>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="px-4 pb-4 pt-0 border-t border-border/50">
          {/* Description */}
          {story.description && (
            <p className="text-sm text-muted mt-3 mb-3 leading-relaxed">
              {story.description}
            </p>
          )}

          {/* Acceptance Criteria as checklist */}
          {ac.length > 0 && (
            <div className="mt-3">
              <h4 className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">
                Acceptance Criteria
              </h4>
              <ul className="space-y-1.5">
                {ac.map((criterion, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={checkedAc.has(i)}
                      onChange={() => toggleAc(i)}
                      className="shrink-0 mt-0.5 w-3.5 h-3.5 rounded border-border accent-accent cursor-pointer"
                    />
                    <span
                      className={`text-xs leading-relaxed ${
                        checkedAc.has(i) ? 'text-muted line-through' : 'text-text'
                      }`}
                    >
                      {criterion}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Dependencies */}
          {deps.length > 0 && (
            <div className="mt-3">
              <h4 className="text-xs font-semibold text-muted uppercase tracking-wide mb-1">
                Dependencies
              </h4>
              <div className="flex flex-wrap gap-1">
                {deps.map((d) => {
                  const resolved = allStoryIds.has(d);
                  return (
                    <span
                      key={d}
                      className={`px-1.5 py-0.5 text-[10px] font-mono rounded ${
                        resolved
                          ? 'bg-accent/10 text-accent'
                          : 'bg-error/10 text-error'
                      }`}
                    >
                      {d}
                      {!resolved && ' (missing)'}
                    </span>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Main Panel ──────────────────────────────────────────────────── */

export default function SpecReviewPanel({
  specId,
  onBack,
  onNavigate,
}: {
  specId: string;
  onBack: () => void;
  onNavigate: (panel: PanelId) => void;
}) {
  const { workspaceId } = useWorkspace();
  const [spec, setSpec] = useState<SpecDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [actionLoading, setActionLoading] = useState<'approve' | 'reject' | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Fetch spec detail
  useEffect(() => {
    if (!specId || !workspaceId) return;
    setLoading(true);
    setError('');
    apiFetch<SpecDetail>(`/api/specs/${specId}?workspaceId=${workspaceId}`)
      .then((data) => {
        setSpec(data);
        setFocusedIndex(0);
        setExpandedIds(new Set());
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to load spec');
      })
      .finally(() => setLoading(false));
  }, [specId, workspaceId]);

  const stories = useMemo(() => spec?.userStories ?? spec?.stories ?? [], [spec]);
  const allStoryIds = useMemo(() => new Set(stories.map((s) => s.id)), [stories]);

  // Readiness: story is "ready" if >=3 AC and all deps resolved
  const readyCount = useMemo(
    () =>
      stories.filter((s) => {
        const ac = s.acceptanceCriteria ?? [];
        const deps = s.dependsOn ?? s.dependencies ?? [];
        return ac.length >= 3 && deps.every((d) => allStoryIds.has(d));
      }).length,
    [stories, allStoryIds],
  );
  const readinessPct = stories.length > 0 ? Math.round((readyCount / stories.length) * 100) : 0;

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't intercept if user is typing in an input
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      ) {
        return;
      }

      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        setFocusedIndex((prev) => Math.min(prev + 1, stories.length - 1));
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        setFocusedIndex((prev) => Math.max(prev - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (stories[focusedIndex]) {
          toggleExpand(stories[focusedIndex].id);
        }
      } else if (e.key === 'Escape') {
        // Collapse all
        setExpandedIds(new Set());
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [stories, focusedIndex, toggleExpand]);

  // Scroll focused card into view
  useEffect(() => {
    if (!stories[focusedIndex]) return;
    const el = containerRef.current?.querySelector(
      `[data-story-id="${stories[focusedIndex].id}"]`,
    );
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [focusedIndex, stories]);

  // Actions
  const handleApprove = async () => {
    if (!workspaceId) return;
    setActionLoading('approve');
    try {
      await apiFetch(`/api/specs/${specId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      onBack();
    } catch {
      // stay on page
    } finally {
      setActionLoading(null);
    }
  };

  const handleReject = async () => {
    if (!workspaceId) return;
    setActionLoading('reject');
    try {
      await apiFetch(`/api/specs/${specId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      onBack();
    } catch {
      // stay on page
    } finally {
      setActionLoading(null);
    }
  };

  // Loading / error / empty states
  if (!specId) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted">
        No spec selected
      </div>
    );
  }

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted">
        Loading spec...
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <p className="text-sm text-error mb-2">{error}</p>
          <button onClick={onBack} className="text-xs text-accent hover:underline">
            Go back
          </button>
        </div>
      </div>
    );
  }

  const specTitle = spec?.title ?? spec?.specName ?? specId;

  return (
    <div className="h-full flex flex-col">
      {/* ─── Header ──────────────────────────────────────────────────── */}
      <div className="px-4 sm:px-6 py-4 border-b border-border shrink-0 bg-bg">
        <div className="max-w-3xl mx-auto">
          {/* Back + title row */}
          <div className="flex items-center gap-3 mb-2">
            <button
              onClick={onBack}
              className="text-muted hover:text-text transition-colors shrink-0"
              title="Back to Hub"
            >
              <ArrowLeft size={18} />
            </button>
            <h1 className="text-lg font-semibold text-text truncate flex-1">
              {specTitle}
            </h1>
          </div>

          {/* Stats row */}
          <div className="flex items-center gap-4 ml-[30px]">
            <div className="flex items-center gap-1.5 text-xs text-muted">
              <ListChecks size={13} />
              <span>
                <span className="font-semibold text-text">{stories.length}</span>{' '}
                {stories.length === 1 ? 'story' : 'stories'}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <ReadinessRing percent={readinessPct} size={24} />
              <span className="text-xs text-muted">
                {readyCount}/{stories.length} ready
              </span>
            </div>
            {spec?.model && (
              <span className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-panel border border-border text-muted">
                {spec.model}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* ─── Story list ──────────────────────────────────────────────── */}
      <div ref={containerRef} className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-4 space-y-2">
          {stories.length === 0 ? (
            <div className="text-center text-sm text-muted py-12">
              No stories in this spec
            </div>
          ) : (
            stories.map((story, i) => (
              <StoryReviewCard
                key={story.id}
                story={story}
                allStoryIds={allStoryIds}
                expanded={expandedIds.has(story.id)}
                focused={i === focusedIndex}
                onToggle={() => {
                  toggleExpand(story.id);
                  setFocusedIndex(i);
                }}
              />
            ))
          )}
        </div>
      </div>

      {/* ─── Action bar ──────────────────────────────────────────────── */}
      <div className="px-4 sm:px-6 py-3 border-t border-border shrink-0 bg-bg">
        <div className="max-w-3xl mx-auto flex items-center gap-3">
          {/* Keyboard hint */}
          <div className="hidden sm:flex items-center gap-2 text-[10px] text-muted flex-1">
            <kbd className="px-1.5 py-0.5 rounded bg-panel border border-border font-mono">
              ↑↓
            </kbd>
            navigate
            <kbd className="px-1.5 py-0.5 rounded bg-panel border border-border font-mono">
              ↵
            </kbd>
            expand
            <kbd className="px-1.5 py-0.5 rounded bg-panel border border-border font-mono">
              esc
            </kbd>
            collapse all
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <button
              onClick={handleApprove}
              disabled={actionLoading !== null}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-success text-white hover:bg-success/90 transition-colors disabled:opacity-50"
            >
              <CheckCircle2 size={14} />
              Approve
            </button>
            <button
              onClick={handleReject}
              disabled={actionLoading !== null}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium text-error border border-error/40 hover:bg-error/10 transition-colors disabled:opacity-50"
            >
              <XCircle size={14} />
              Reject
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
