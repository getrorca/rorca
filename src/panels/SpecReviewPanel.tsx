import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  XCircle,
  ListChecks,
  Search,
  X,
  SlidersHorizontal,
  AlertTriangle,
  GitBranch,
  Loader2,
  Play,
  Pencil,
  Trash2,
} from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useGlobalToast } from '../contexts/ToastContext';
import { apiFetch } from '../lib/apiFetch';
import { ReadinessRing } from '../components/ReadinessRing';
import { SpecConfirmDialog } from '../components/SpecConfirmDialog';
import { useHotkeys, modLabel } from '../hooks/useHotkeys';
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
  /** Per-story execution model override (e.g. 'claude-opus-4-6'). */
  model?: string;
}

interface SpecDetail {
  title?: string;
  specName?: string;
  userStories?: Story[];
  stories?: Story[];
  model?: string;
  generatedAt?: string;
  _status?: 'pending' | 'approved';
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

/* ─── Filter types ────────────────────────────────────────────────── */

type StatusFilter = 'all' | 'excluded' | 'has-deps';
type ComplexityFilter = 'all' | 'low' | 'medium' | 'high';

const STATUS_CHIPS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'excluded', label: 'Excluded' },
  { value: 'has-deps', label: 'Has Dependencies' },
];

const COMPLEXITY_CHIPS: { value: ComplexityFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

function activeFilterCount(
  search: string,
  status: StatusFilter,
  complexity: ComplexityFilter,
): number {
  let count = 0;
  if (search.trim()) count++;
  if (status !== 'all') count++;
  if (complexity !== 'all') count++;
  return count;
}

function matchesFilters(
  story: Story,
  search: string,
  status: StatusFilter,
  complexity: ComplexityFilter,
): boolean {
  // Text search — title + description
  if (search.trim()) {
    const q = search.toLowerCase();
    const titleMatch = story.title.toLowerCase().includes(q);
    const descMatch = (story.description ?? '').toLowerCase().includes(q);
    if (!titleMatch && !descMatch) return false;
  }

  // Status filter
  if (status === 'excluded' && story.excluded !== true) return false;
  if (status === 'has-deps') {
    const deps = story.dependsOn ?? story.dependencies ?? [];
    if (deps.length === 0) return false;
  }

  // Complexity filter
  if (complexity !== 'all') {
    const c = story.complexity ?? 0;
    if (complexity === 'low' && c > 2) return false;
    if (complexity === 'medium' && c !== 3) return false;
    if (complexity === 'high' && c < 4) return false;
  }

  return true;
}

/* ─── Filter Bar ─────────────────────────────────────────────────── */

function StoryFilterBar({
  search,
  onSearchChange,
  status,
  onStatusChange,
  complexity,
  onComplexityChange,
  activeCount,
  onClearAll,
  filtersOpen,
  onToggleFilters,
}: {
  search: string;
  onSearchChange: (v: string) => void;
  status: StatusFilter;
  onStatusChange: (v: StatusFilter) => void;
  complexity: ComplexityFilter;
  onComplexityChange: (v: ComplexityFilter) => void;
  activeCount: number;
  onClearAll: () => void;
  filtersOpen: boolean;
  onToggleFilters: () => void;
}) {
  return (
    <div className="space-y-2">
      {/* Search + filter toggle row */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none"
          />
          <input
            type="text"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search stories..."
            className="w-full pl-8 pr-8 py-1.5 text-sm rounded-lg bg-panel border border-border text-text placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-accent"
          />
          {search && (
            <button
              onClick={() => onSearchChange('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-text"
            >
              <X size={13} />
            </button>
          )}
        </div>

        <button
          onClick={onToggleFilters}
          className={`relative flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-colors ${filtersOpen || activeCount > 0
              ? 'border-accent bg-accent/10 text-accent'
              : 'border-border bg-panel text-muted hover:text-text'
            }`}
        >
          <SlidersHorizontal size={13} />
          Filters
          {activeCount > 0 && (
            <span className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-accent text-white text-[10px] font-bold flex items-center justify-center">
              {activeCount}
            </span>
          )}
        </button>
      </div>

      {/* Filter chips — collapsible */}
      {filtersOpen && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-1">
          {/* Status chips */}
          <div className="flex items-center gap-1">
            <span className="text-[10px] font-semibold text-muted uppercase tracking-wide mr-1">
              Status
            </span>
            {STATUS_CHIPS.map((chip) => (
              <button
                key={chip.value}
                onClick={() => onStatusChange(chip.value)}
                className={`px-2 py-0.5 text-[11px] rounded-full border transition-colors ${status === chip.value
                    ? 'border-accent bg-accent/15 text-accent font-medium'
                    : 'border-border bg-panel text-muted hover:text-text'
                  }`}
              >
                {chip.label}
              </button>
            ))}
          </div>

          {/* Complexity chips */}
          <div className="flex items-center gap-1">
            <span className="text-[10px] font-semibold text-muted uppercase tracking-wide mr-1">
              Complexity
            </span>
            {COMPLEXITY_CHIPS.map((chip) => (
              <button
                key={chip.value}
                onClick={() => onComplexityChange(chip.value)}
                className={`px-2 py-0.5 text-[11px] rounded-full border transition-colors ${complexity === chip.value
                    ? 'border-accent bg-accent/15 text-accent font-medium'
                    : 'border-border bg-panel text-muted hover:text-text'
                  }`}
              >
                {chip.label}
              </button>
            ))}
          </div>

          {/* Clear all */}
          {activeCount > 0 && (
            <button
              onClick={onClearAll}
              className="ml-auto text-[11px] text-muted hover:text-error transition-colors"
            >
              Clear all
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Story Review Card ───────────────────────────────────────────── */

const STORY_MODEL_OPTIONS = [
  { value: '', label: 'Default (run-level)' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 — fast' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6 — balanced' },
  { value: 'claude-opus-4-6', label: 'Opus 4.6 — powerful' },
];

function StoryReviewCard({
  story,
  allStoryIds,
  expanded,
  focused,
  highlighted,
  onToggle,
  onScrollToStory,
  onModelChange,
}: {
  story: Story;
  allStoryIds: Set<string>;
  expanded: boolean;
  focused: boolean;
  highlighted: boolean;
  onToggle: () => void;
  onScrollToStory: (id: string) => void;
  onModelChange: (storyId: string, model: string) => void;
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
      className={`border rounded-lg bg-panel transition-all ${highlighted
          ? 'ring-2 ring-warning/60 border-warning animate-pulse'
          : focused
            ? 'ring-2 ring-accent/50 border-accent'
            : 'border-border'
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
          className={`shrink-0 px-1.5 py-0.5 text-[10px] font-mono font-semibold rounded ${isDone
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
          className={`text-sm font-medium truncate flex-1 ${isExcluded ? 'text-muted line-through' : 'text-text'
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

        {/* Dependency count indicator */}
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

      {/* Always-visible dependency line */}
      <div className="px-4 pb-2 -mt-1">
        {deps.length > 0 ? (
          <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
            <span className="text-muted font-medium">Depends on:</span>
            {deps.map((d) => {
              const resolved = allStoryIds.has(d);
              return (
                <button
                  key={d}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (resolved) onScrollToStory(d);
                  }}
                  className={`px-1.5 py-0.5 text-[10px] font-mono font-semibold rounded transition-colors ${resolved
                      ? 'bg-accent/10 text-accent hover:bg-accent/25 cursor-pointer'
                      : 'bg-error/10 text-error cursor-default'
                    }`}
                  title={resolved ? `Jump to ${d}` : `${d} not found in spec`}
                >
                  {d}
                  {!resolved && ' (missing)'}
                </button>
              );
            })}
          </div>
        ) : (
          <span className="text-[11px] text-muted/60">No dependencies</span>
        )}
      </div>

      {/* Expanded content */}
      {expanded && (
        <div className="px-4 pb-4 pt-0 border-t border-border/50">
          {/* Description */}
          {story.description && (
            <p className="text-sm text-muted mt-3 mb-3 leading-relaxed">
              {story.description}
            </p>
          )}

          {/* Per-story model override */}
          <div className="mt-3 flex items-center gap-2">
            <label className="text-xs font-semibold text-muted uppercase tracking-wide shrink-0">
              Model
            </label>
            <select
              value={story.model ?? ''}
              onChange={(e) => {
                e.stopPropagation();
                onModelChange(story.id, e.target.value);
              }}
              onClick={(e) => e.stopPropagation()}
              className="flex-1 text-xs rounded bg-panel border border-border text-text px-2 py-1 focus:outline-none focus:ring-1 focus:ring-accent"
            >
              {STORY_MODEL_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
              {/* Show current model as option if it's not in the preset list */}
              {story.model && !STORY_MODEL_OPTIONS.some((o) => o.value === story.model) && (
                <option value={story.model}>{story.model}</option>
              )}
            </select>
          </div>

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
                      className={`text-xs leading-relaxed ${checkedAc.has(i) ? 'text-muted line-through' : 'text-text'
                        }`}
                    >
                      {criterion}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Circular dependency detection ──────────────────────────────── */

function detectCycles(stories: Story[]): string[][] {
  const adj = new Map<string, string[]>();
  for (const s of stories) {
    adj.set(s.id, s.dependsOn ?? s.dependencies ?? []);
  }
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const path: string[] = [];

  function dfs(node: string) {
    if (inStack.has(node)) {
      // Found a cycle — extract it
      const cycleStart = path.indexOf(node);
      if (cycleStart >= 0) {
        cycles.push(path.slice(cycleStart));
      }
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    inStack.add(node);
    path.push(node);
    for (const dep of adj.get(node) ?? []) {
      if (adj.has(dep)) dfs(dep);
    }
    path.pop();
    inStack.delete(node);
  }

  for (const s of stories) {
    if (!visited.has(s.id)) dfs(s.id);
  }
  return cycles;
}

/* ─── DAG Modal (lazy-loads DependencyGraph) ─────────────────────── */

function DagModal({
  specId,
  workspaceId,
  onClose,
}: {
  specId: string;
  workspaceId: string;
  onClose: () => void;
}) {
  const [DependencyGraph, setDependencyGraph] = useState<React.ComponentType<{
    specId: string;
    workspaceId: string;
    runId?: number;
  }> | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    import('../components/DependencyGraph')
      .then((mod) => setDependencyGraph(() => mod.default))
      .catch(() => setLoadError(true));
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-bg border border-border rounded-xl w-[90vw] max-w-4xl h-[80vh] flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <GitBranch size={16} className="text-accent" />
            <h2 className="text-sm font-semibold text-text">Dependency Chain</h2>
          </div>
          <button
            onClick={onClose}
            className="text-muted hover:text-text transition-colors"
          >
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-auto">
          {loadError ? (
            <div className="flex items-center justify-center h-full text-sm text-error">
              Failed to load dependency graph
            </div>
          ) : !DependencyGraph ? (
            <div className="flex items-center justify-center h-full text-sm text-muted gap-2">
              <Loader2 size={14} className="animate-spin" />
              Loading graph...
            </div>
          ) : (
            <DependencyGraph specId={specId} workspaceId={workspaceId} />
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Main Panel ──────────────────────────────────────────────────── */

export default function SpecReviewPanel({
  specId,
  onBack,
  onNavigate,
  onNavigateToRun,
}: {
  specId: string;
  onBack: () => void;
  onNavigate: (panel: PanelId) => void;
  onNavigateToRun?: (runId: number) => void;
}) {
  const { workspaceId } = useWorkspace();
  const toast = useGlobalToast();
  const [spec, setSpec] = useState<SpecDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [actionLoading, setActionLoading] = useState<'approve' | 'reject' | null>(null);
  const [dialogMode, setDialogMode] = useState<'approve' | 'reject' | 'post-approve' | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [complexityFilter, setComplexityFilter] = useState<ComplexityFilter>('all');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [highlightedStoryId, setHighlightedStoryId] = useState<string | null>(null);
  const [dagModalOpen, setDagModalOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const mod = modLabel();

  // Keyboard shortcuts: ⌘↩ approve, ⌘⌫ reject
  useHotkeys(useMemo(() => [
    { key: 'mod+enter', handler: () => { if (!dialogMode && spec) setDialogMode('approve'); } },
    { key: 'mod+backspace', handler: () => { if (!dialogMode && spec) setDialogMode('reject'); } },
  ], [dialogMode, spec]));

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

  // Circular dependency detection
  const cycles = useMemo(() => detectCycles(stories), [stories]);

  // Scroll to and highlight a story by ID
  const scrollToStory = useCallback((targetId: string) => {
    // Clear filters so the target is visible
    setSearchQuery('');
    setStatusFilter('all');
    setComplexityFilter('all');

    // Wait for re-render, then scroll
    requestAnimationFrame(() => {
      const el = containerRef.current?.querySelector(`[data-story-id="${targetId}"]`);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        setHighlightedStoryId(targetId);
        // Clear highlight after animation
        setTimeout(() => setHighlightedStoryId(null), 1500);
      }
    });
  }, []);

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

  // Filtered stories
  const filteredStories = useMemo(
    () => stories.filter((s) => matchesFilters(s, searchQuery, statusFilter, complexityFilter)),
    [stories, searchQuery, statusFilter, complexityFilter],
  );
  const filterCount = activeFilterCount(searchQuery, statusFilter, complexityFilter);

  // Reset focused index when filter results change
  useEffect(() => {
    setFocusedIndex(0);
  }, [searchQuery, statusFilter, complexityFilter]);

  const clearAllFilters = useCallback(() => {
    setSearchQuery('');
    setStatusFilter('all');
    setComplexityFilter('all');
  }, []);

  // Reset filters when spec changes (navigation)
  useEffect(() => {
    clearAllFilters();
    setFiltersOpen(false);
  }, [specId, clearAllFilters]);

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
        setFocusedIndex((prev) => Math.min(prev + 1, filteredStories.length - 1));
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        setFocusedIndex((prev) => Math.max(prev - 1, 0));
      } else if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        if (filteredStories[focusedIndex]) {
          toggleExpand(filteredStories[focusedIndex].id);
        }
      } else if (e.key === 'Escape') {
        // Collapse all
        setExpandedIds(new Set());
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [filteredStories, focusedIndex, toggleExpand]);

  // Scroll focused card into view
  useEffect(() => {
    if (!filteredStories[focusedIndex]) return;
    const el = containerRef.current?.querySelector(
      `[data-story-id="${filteredStories[focusedIndex].id}"]`,
    );
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [focusedIndex, filteredStories]);

  // Per-story model change — save to spec JSON via API, update local state
  const handleStoryModelChange = useCallback(async (storyId: string, model: string) => {
    if (!workspaceId || !spec) return;
    try {
      await apiFetch(`/api/specs/${specId}/stories/${storyId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, model: model || null }),
      });
      // Update local spec state
      setSpec((prev) => {
        if (!prev) return prev;
        const stories = (prev.userStories ?? prev.stories ?? []).map((s: Story) =>
          s.id === storyId ? { ...s, model: model || undefined } : s,
        );
        return { ...prev, userStories: stories };
      });
    } catch {
      // Silently fail — model selector will revert on next render
    }
  }, [workspaceId, spec, specId]);

  // Actions — called from confirmation dialog
  const handleConfirmApprove = async () => {
    if (!workspaceId) return;
    setActionLoading('approve');
    try {
      await apiFetch(`/api/specs/${specId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      setDialogMode('post-approve');
    } catch {
      setDialogMode(null);
    } finally {
      setActionLoading(null);
    }
  };

  const handleConfirmReject = async (reason?: string) => {
    if (!workspaceId) return;
    setActionLoading('reject');
    try {
      await apiFetch(`/api/specs/${specId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, reason: reason || undefined }),
      });
      setDialogMode(null);
      onBack();
    } catch {
      setDialogMode(null);
    } finally {
      setActionLoading(null);
    }
  };

  const [pipelineLoading, setPipelineLoading] = useState(false);

  const handleRunPipeline = useCallback(async () => {
    if (!workspaceId || pipelineLoading) return;
    const status = spec?._status;
    const specDir = status === 'approved' ? 'approved' : 'pending';
    const specPath = `forge/specs/${specDir}/${specId}.json`;
    setPipelineLoading(true);
    try {
      const result = await apiFetch<{ ok?: boolean; conflict?: boolean; queued?: boolean; runId?: number; activeRunId?: number; position?: number }>('/api/pipeline/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ specPath, workspaceId, autoWorktree: true }),
      });
      if (result.conflict) {
        toast.show('A pipeline run is already active', 'error');
        if (result.activeRunId && onNavigateToRun) {
          onNavigateToRun(result.activeRunId);
        }
      } else if (result.queued) {
        toast.show(`Run queued at position ${result.position}`, 'success');
      } else if (result.runId) {
        toast.show('Pipeline started', 'success');
        if (onNavigateToRun) {
          onNavigateToRun(result.runId);
        }
      }
    } catch (err: any) {
      toast.show(err?.message || 'Failed to trigger pipeline', 'error');
    } finally {
      setPipelineLoading(false);
    }
  }, [workspaceId, spec, specId, pipelineLoading, toast, onNavigateToRun]);

  const handleEdit = useCallback(() => {
    onNavigate('specs');
  }, [onNavigate]);

  const handleDelete = useCallback(async () => {
    if (!workspaceId) return;
    setDeleteLoading(true);
    try {
      await apiFetch(`/api/specs/${encodeURIComponent(specId)}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      toast.show('Spec deleted', 'success');
      onBack();
    } catch (err: any) {
      toast.show(err?.message || 'Failed to delete spec', 'error');
    } finally {
      setDeleteLoading(false);
    }
  }, [workspaceId, specId, toast, onBack]);

  const isPending = spec?._status === 'pending';
  const isApproved = spec?._status === 'approved';

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
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-lg font-semibold text-text truncate flex-1">
              {specTitle}
            </h1>
            <button
              onClick={onBack}
              className="text-muted hover:text-text transition-colors shrink-0"
              title="Close review"
            >
              <X size={18} />
            </button>
          </div>

          {/* Stats row */}
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5 text-xs text-muted">
              <ListChecks size={13} />
              <span>
                {filterCount > 0 ? (
                  <>
                    <span className="font-semibold text-text">{filteredStories.length}</span>
                    /{stories.length} stories
                  </>
                ) : (
                  <>
                    <span className="font-semibold text-text">{stories.length}</span>{' '}
                    {stories.length === 1 ? 'story' : 'stories'}
                  </>
                )}
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
            {/* Dependency chain button */}
            {stories.length > 0 && workspaceId && (
              <button
                onClick={() => setDagModalOpen(true)}
                className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded bg-accent/10 text-accent hover:bg-accent/20 transition-colors border border-accent/20"
              >
                <GitBranch size={12} />
                Dependency chain
              </button>
            )}
          </div>

          {/* Circular dependency warning */}
          {cycles.length > 0 && (
            <div className="mt-3 ml-[30px] rounded border border-error/30 bg-error/10 p-3">
              <div className="flex items-center gap-2 mb-1.5">
                <AlertTriangle size={14} className="text-error shrink-0" />
                <span className="text-xs font-semibold text-error">
                  Circular dependency detected
                </span>
              </div>
              {cycles.map((cycle, ci) => (
                <div key={ci} className="flex flex-wrap items-center gap-1 mt-1">
                  {cycle.map((id, i) => (
                    <span key={`${ci}-${i}`} className="inline-flex items-center gap-1">
                      <button
                        onClick={() => scrollToStory(id)}
                        className="px-1.5 py-0.5 text-[10px] font-mono font-semibold rounded bg-error/15 text-error hover:bg-error/25 transition-colors cursor-pointer"
                      >
                        {id}
                      </button>
                      {i < cycle.length - 1 && (
                        <span className="text-error/60 text-xs">&rarr;</span>
                      )}
                    </span>
                  ))}
                  <span className="text-error/60 text-xs">&rarr;</span>
                  <span className="px-1.5 py-0.5 text-[10px] font-mono font-semibold rounded bg-error/15 text-error">
                    {cycle[0]}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ─── Filter bar ─────────────────────────────────────────────── */}
      <div className="px-4 sm:px-6 py-3 border-b border-border/50 shrink-0 bg-bg">
        <div className="max-w-3xl mx-auto">
          <StoryFilterBar
            search={searchQuery}
            onSearchChange={setSearchQuery}
            status={statusFilter}
            onStatusChange={setStatusFilter}
            complexity={complexityFilter}
            onComplexityChange={setComplexityFilter}
            activeCount={filterCount}
            onClearAll={clearAllFilters}
            filtersOpen={filtersOpen}
            onToggleFilters={() => setFiltersOpen((p) => !p)}
          />
        </div>
      </div>

      {/* ─── Story list ──────────────────────────────────────────────── */}
      <div ref={containerRef} className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-4 space-y-2">
          {stories.length === 0 ? (
            <div className="text-center text-sm text-muted py-12">
              No stories in this spec
            </div>
          ) : filteredStories.length === 0 ? (
            <div className="text-center text-sm text-muted py-12">
              No stories match your filters
            </div>
          ) : (
            filteredStories.map((story, i) => (
              <StoryReviewCard
                key={story.id}
                story={story}
                allStoryIds={allStoryIds}
                expanded={expandedIds.has(story.id)}
                focused={i === focusedIndex}
                highlighted={highlightedStoryId === story.id}
                onToggle={() => {
                  toggleExpand(story.id);
                  setFocusedIndex(i);
                }}
                onScrollToStory={scrollToStory}
                onModelChange={handleStoryModelChange}
              />
            ))
          )}
        </div>
      </div>

      {/* ─── Action bar ──────────────────────────────────────────────── */}
      <div className="px-4 sm:px-6 py-3 border-t border-border shrink-0 bg-bg">
        <div className="max-w-3xl mx-auto flex items-center gap-3">
          {/* Left: secondary actions */}
          <div className="flex items-center gap-2">
            <button
              onClick={handleEdit}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium text-muted border border-border hover:text-text hover:border-accent/40 transition-colors"
            >
              <Pencil size={14} />
              Edit
            </button>
            <button
              onClick={handleDelete}
              disabled={deleteLoading}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium text-muted border border-border hover:text-error hover:border-error/40 transition-colors disabled:opacity-50"
            >
              <Trash2 size={14} />
              Delete
            </button>
          </div>

          {/* Right: primary actions */}
          <div className="flex items-center gap-2 ml-auto">
            {(isPending || isApproved) ? (
              <button
                onClick={handleRunPipeline}
                disabled={pipelineLoading}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-accent text-white hover:bg-accent/90 transition-colors disabled:opacity-50"
              >
                {pipelineLoading ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                {pipelineLoading ? 'Starting…' : 'Run Pipeline'}
              </button>
            ) : (
              <button
                disabled
                title="Archived specs cannot be run — approve a new version first"
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-accent/40 text-white/60 cursor-not-allowed"
              >
                <Play size={14} />
                Run Pipeline
              </button>
            )}
            {isPending && (
              <>
                <button
                  onClick={() => setDialogMode('approve')}
                  disabled={actionLoading !== null}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-success text-white hover:bg-success/90 transition-colors disabled:opacity-50"
                >
                  <CheckCircle2 size={14} />
                  Approve
                  <kbd className="ml-1 px-1 py-0.5 text-[10px] rounded bg-[var(--kbd-bg)] font-mono">
                    {mod}↵
                  </kbd>
                </button>
                <button
                  onClick={() => setDialogMode('reject')}
                  disabled={actionLoading !== null}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium text-error border border-error/40 hover:bg-error/10 transition-colors disabled:opacity-50"
                >
                  <XCircle size={14} />
                  Reject
                  <kbd className="ml-1 px-1 py-0.5 text-[10px] rounded bg-error/15 font-mono">
                    {mod}⌫
                  </kbd>
                </button>
              </>
            )}
            {!isPending && !isApproved && (
              <>
                <button
                  onClick={() => setDialogMode('approve')}
                  disabled={actionLoading !== null}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-success text-white hover:bg-success/90 transition-colors disabled:opacity-50"
                >
                  <CheckCircle2 size={14} />
                  Approve
                </button>
                <button
                  onClick={() => setDialogMode('reject')}
                  disabled={actionLoading !== null}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium text-error border border-error/40 hover:bg-error/10 transition-colors disabled:opacity-50"
                >
                  <XCircle size={14} />
                  Reject
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ─── Confirmation dialogs ─────────────────────────────────────── */}
      {dialogMode && (
        <SpecConfirmDialog
          mode={dialogMode}
          specName={specTitle}
          loading={actionLoading !== null}
          onConfirm={(reason) => {
            if (dialogMode === 'approve') handleConfirmApprove();
            else if (dialogMode === 'reject') handleConfirmReject(reason);
          }}
          onCancel={() => setDialogMode(null)}
          onGoToForge={() => { setDialogMode(null); onNavigate('specs'); }}
          onTriggerRun={() => { setDialogMode(null); onNavigate('runs'); }}
        />
      )}

      {/* ─── DAG modal ────────────────────────────────────────────────── */}
      {dagModalOpen && workspaceId && (
        <DagModal
          specId={specId}
          workspaceId={workspaceId}
          onClose={() => setDagModalOpen(false)}
        />
      )}
    </div>
  );
}
