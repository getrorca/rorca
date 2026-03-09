import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  Search, X, Clock, CheckCircle2, XCircle, AlertCircle,
  Download, Copy, Check, ChevronRight, ChevronLeft, Play, GitBranch, GitFork,
  Loader2, Plus, Sparkles, Upload, ExternalLink, History, Trash2,
  Globe, FileText, Layers, Archive, Inbox, ArrowRight,
  RefreshCw, AlertTriangle, ChevronDown, LayoutGrid, List,
  GripVertical,
} from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useAuth } from '../contexts/AuthContext';
import { apiFetch } from '../lib/apiFetch';
import { useGlobalToast } from '../contexts/ToastContext';
import { useWalSSE } from '../hooks/useWalSSE';
import { useHotkeys } from '../hooks/useHotkeys';
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
import SlideOver from '../components/SlideOver';
import { relativeTime, SpecPreview, REVIEW_STATUS_CONFIG } from '../components/SpecReviewInline';
import type { SpecSummary, SpecDetail, ReviewStatus } from '../components/SpecReviewInline';
import { SpecConfirmDialog } from '../components/SpecConfirmDialog';
import { AssigneeAvatar } from '../components/AssigneeDropdown';
import type { Assignee } from '../components/AssigneeDropdown';
import BatchForge from './BatchForge';
import SpecForgeProgress from '../components/SpecForgeProgress';
import SpecForgePreview from '../components/SpecForgePreview';
import TemplatePickerModal from '../components/TemplatePickerModal';
import { briefToSlug, KEBAB_RE } from '../lib/slugify';
import type { GeneratedSpec } from './SpecForgeOutput';
import AgentPicker, { type AgentType } from '../components/AgentPicker';
import ModelSearchSelect, { type ModelOption } from '../components/ModelSearchSelect';

/* ─── Types ───────────────────────────────────────────────────────── */

type ViewMode = 'board' | 'list';
type SpecStatus = 'pending' | 'approved' | 'rejected' | 'completed';
type StatusFilter = 'all' | SpecStatus;
type PreviewTab = 'stories' | 'graph' | 'diagram' | 'json' | 'history';

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

interface DirectionLayerData {
  content: string | null;
}

interface DirectionAllResponse {
  layers: {
    l1: DirectionLayerData;
    l2: DirectionLayerData;
    l3: DirectionLayerData;
  };
}

/* ─── Constants ──────────────────────────────────────────────────── */

const PAGE_SIZE = 20;
const VIEW_MODE_KEY = 'rorca:specs:viewMode';
const COLLAPSE_KEY_PREFIX = 'rorca:specs:collapsed:';

const STATUS_FILTERS: { id: StatusFilter; label: string }[] = [
  { id: 'all', label: 'All Specs' },
  { id: 'pending', label: 'Pending Review' },
  { id: 'approved', label: 'Approved' },
  { id: 'completed', label: 'Completed' },
  { id: 'rejected', label: 'Rejected' },
];

const STATUS_CONFIG: Record<SpecStatus, { label: string; icon: typeof CheckCircle2; className: string; dotClass: string }> = {
  completed: { label: 'COMPLETED', icon: CheckCircle2, className: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30', dotClass: 'bg-emerald-500' },
  approved: { label: 'APPROVED', icon: CheckCircle2, className: 'bg-success/15 text-success border-success/30', dotClass: 'bg-success' },
  pending: { label: 'PENDING', icon: AlertCircle, className: 'bg-warning/15 text-warning border-warning/30', dotClass: 'bg-warning' },
  rejected: { label: 'REJECTED', icon: XCircle, className: 'bg-error/15 text-error border-error/30', dotClass: 'bg-error' },
};

const BOARD_COLUMNS = [
  { key: 'draft' as const, label: 'Draft', icon: FileText, emptyMessage: 'No draft specs', accentClass: 'bg-muted/15 text-muted', iconClass: 'text-muted', headerBg: '', color: '#71717a' },
  { key: 'in-progress' as const, label: 'In Progress', icon: Play, emptyMessage: 'No specs in progress', accentClass: 'bg-accent/15 text-accent', iconClass: 'text-accent', headerBg: '', color: '#4f46e5' },
  { key: 'done' as const, label: 'Done', icon: CheckCircle2, emptyMessage: 'No completed specs', accentClass: 'bg-success/15 text-success', iconClass: 'text-success', headerBg: '', color: '#10b981' },
];

/* ─── Helpers ─────────────────────────────────────────────────────── */

function slugToTitle(slug: string): string {
  return slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDate(iso: string): string {
  try { return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }); }
  catch { return iso; }
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
    <div className="flex h-1 rounded-full overflow-hidden bg-border" title={`${outcomes.pass} passed, ${outcomes.fail} failed, ${outcomes.skip + outcomes.timeout} skipped`}>
      {segments.map((seg, i) => (
        <div key={i} className={`${seg.color} transition-all`} style={{ width: `${(seg.count / storyCount) * 100}%` }} />
      ))}
    </div>
  );
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

/* ─── Main Component ──────────────────────────────────────────────── */

interface SpecsPanelProps {
  onNavigate: (panel: PanelId) => void;
  onNavigateToRun?: (runId: number) => void;
  onNavigateToSpecReview?: (specId: string) => void;
  initialBrief?: string | null;
  onBriefConsumed?: () => void;
}

export default function SpecsPanel({ onNavigate, onNavigateToRun, onNavigateToSpecReview, initialBrief, onBriefConsumed }: SpecsPanelProps) {
  const { workspaceId } = useWorkspace();
  const toast = useGlobalToast();

  // View mode: board or list (persisted in localStorage)
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try { return (localStorage.getItem(VIEW_MODE_KEY) as ViewMode) || 'board'; } catch { return 'board'; }
  });

  // New Spec slide-over
  const [showNewSpec, setShowNewSpec] = useState(false);

  // Spec detail slide-over
  const [detailSpecId, setDetailSpecId] = useState<string | null>(null);
  const [detailSpecSummary, setDetailSpecSummary] = useState<ArchiveSpec | null>(null);

  // Persist view mode
  useEffect(() => {
    try { localStorage.setItem(VIEW_MODE_KEY, viewMode); } catch { /* quota */ }
  }, [viewMode]);

  // Apply initialBrief from command palette
  useEffect(() => {
    if (initialBrief != null) {
      setShowNewSpec(true);
      onBriefConsumed?.();
    }
  }, [initialBrief, onBriefConsumed]);

  const handleSpecClick = useCallback((specId: string, summary?: ArchiveSpec) => {
    setDetailSpecId(specId);
    setDetailSpecSummary(summary ?? null);
  }, []);

  const handleDetailClose = useCallback(() => {
    setDetailSpecId(null);
    setDetailSpecSummary(null);
  }, []);

  if (!workspaceId) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        Select a workspace to manage specs
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-bg overflow-hidden">
      {/* Header */}
      <AppHeader
        breadcrumbs={
          <div className="flex items-center gap-2">
            <span className="font-medium text-[var(--text)] text-sm tracking-tight">Specs</span>
          </div>
        }
        actions={
          <div className="flex items-center gap-2">
            {/* View mode toggle */}
            <div className="flex bg-panel rounded-lg border border-border p-0.5">
              <button
                onClick={() => setViewMode('board')}
                aria-current={viewMode === 'board' ? 'page' : undefined}
                title="Board view"
                className={`p-1.5 rounded-md transition-colors ${viewMode === 'board' ? 'bg-accent text-white shadow-sm' : 'text-muted hover:text-[var(--text)]'}`}
              >
                <LayoutGrid size={14} />
              </button>
              <button
                onClick={() => setViewMode('list')}
                aria-current={viewMode === 'list' ? 'page' : undefined}
                title="List view"
                className={`p-1.5 rounded-md transition-colors ${viewMode === 'list' ? 'bg-accent text-white shadow-sm' : 'text-muted hover:text-[var(--text)]'}`}
              >
                <List size={14} />
              </button>
            </div>

            {/* New Spec button */}
            <button
              onClick={() => setShowNewSpec(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-accent text-white hover:bg-accent-hover transition-colors"
            >
              <Plus size={14} />
              New Spec
            </button>
          </div>
        }
      />

      {/* Content */}
      <div className="flex-1 overflow-hidden min-h-0">
        {viewMode === 'board' ? (
          <BoardView
            workspaceId={workspaceId}
            onSpecClick={handleSpecClick}
            onNavigate={onNavigate}
          />
        ) : (
          <ListView
            workspaceId={workspaceId}
            onSpecClick={handleSpecClick}
            onNavigate={onNavigate}
          />
        )}
      </div>

      {/* New Spec Slide-Over */}
      <SlideOver isOpen={showNewSpec} onClose={() => setShowNewSpec(false)} title="New Spec">
        <NewSpecForm
          onClose={() => setShowNewSpec(false)}
          onNavigate={onNavigate}
          onNavigateToRun={onNavigateToRun}
          initialBrief={initialBrief}
        />
      </SlideOver>

      {/* Spec Detail Slide-Over */}
      <SlideOver isOpen={detailSpecId !== null} onClose={handleDetailClose} hideHeader>
        {detailSpecId && (
          <SpecDetailView
            specId={detailSpecId}
            initialSummary={detailSpecSummary}
            onClose={handleDetailClose}
            onNavigate={onNavigate}
            onNavigateToRun={onNavigateToRun}
          />
        )}
      </SlideOver>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════
   BOARD VIEW — Kanban columns (Draft, In Progress, Done)
   ════════════════════════════════════════════════════════════════════ */

function BoardView({ workspaceId, onSpecClick, onNavigate }: {
  workspaceId: string;
  onSpecClick: (specId: string, summary?: ArchiveSpec) => void;
  onNavigate: (panel: PanelId) => void;
}) {
  const toast = useGlobalToast();
  const [kanban, setKanban] = useState<KanbanResponse>({ draft: [], inProgress: [], done: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const hasLoadedOnce = useRef(false);
  const [actionLoadingMap, setActionLoadingMap] = useState<Record<string, 'approve' | 'deny' | null>>({});
  const [activeRunSpecs, setActiveRunSpecs] = useState<Set<string>>(new Set());
  const sseFetchTimer = useRef<ReturnType<typeof setTimeout>>();

  // Drag state — refs for performance (no re-renders during drag)
  const dragSpecIdRef = useRef<string | null>(null);
  const dragFromColumnRef = useRef<string | null>(null);
  const dragOverColumnRef = useRef<string | null>(null);
  const dragLeaveTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const dragGhostRef = useRef<HTMLDivElement | null>(null);
  const [dragRenderKey, setDragRenderKey] = useState(0); // single state bump for visual updates
  // Touch drag refs
  const touchDragTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const touchDragActiveRef = useRef(false);
  const touchStartPosRef = useRef<{ x: number; y: number } | null>(null);
  const touchCloneRef = useRef<HTMLDivElement | null>(null);
  // Keyboard focus tracking
  const focusedCardRef = useRef<{ specId: string; columnKey: string } | null>(null);
  // Optimistic kanban state for rollback
  const [optimisticKanban, setOptimisticKanban] = useState<KanbanResponse | null>(null);
  const effectiveKanban = optimisticKanban ?? kanban;

  // Column collapse state — persisted per workspace
  const collapseKey = `${COLLAPSE_KEY_PREFIX}${workspaceId}`;
  const [collapsedColumns, setCollapsedColumns] = useState<Record<string, boolean>>(() => {
    try {
      const stored = localStorage.getItem(collapseKey);
      return stored ? JSON.parse(stored) : {};
    } catch { return {}; }
  });

  useEffect(() => {
    try { localStorage.setItem(collapseKey, JSON.stringify(collapsedColumns)); } catch { /* quota */ }
  }, [collapseKey, collapsedColumns]);

  const toggleCollapse = useCallback((columnKey: string) => {
    setCollapsedColumns(prev => ({ ...prev, [columnKey]: !prev[columnKey] }));
  }, []);

  const fetchKanban = useCallback(async () => {
    if (!workspaceId) { setKanban({ draft: [], inProgress: [], done: [] }); setLoading(false); setError(null); return; }
    try {
      const res = await apiFetch<KanbanResponse>(`/api/specs/kanban?workspaceId=${workspaceId}`);
      setKanban(res);
      setError(null);
      hasLoadedOnce.current = true;
    } catch (err: any) {
      if (!hasLoadedOnce.current) setError(err?.message || 'Failed to load specs');
    } finally {
      setLoading(false);
      setRetrying(false);
    }
  }, [workspaceId]);

  const debouncedFetchKanban = useCallback(() => {
    clearTimeout(sseFetchTimer.current);
    sseFetchTimer.current = setTimeout(() => fetchKanban(), 300);
  }, [fetchKanban]);

  useEffect(() => () => clearTimeout(sseFetchTimer.current), []);

  useEffect(() => {
    hasLoadedOnce.current = false;
    setLoading(true);
    setError(null);
    fetchKanban();
    const interval = setInterval(fetchKanban, 10_000);
    return () => clearInterval(interval);
  }, [fetchKanban]);

  useWalSSE((event) => {
    if (workspaceId && event.workspace_id && event.workspace_id !== String(workspaceId)) return;
    const KANBAN_EVENTS = ['spec_approved', 'run_started', 'run_finished', 'spec_rejected', 'story_passed', 'story_failed'];
    if (!KANBAN_EVENTS.includes(event.event_type)) return;
    if (event.event_type === 'run_started' && event.spec_id) {
      setActiveRunSpecs((prev) => new Set(prev).add(event.spec_id!));
    }
    if (event.event_type === 'run_finished' && event.spec_id) {
      setActiveRunSpecs((prev) => { const next = new Set(prev); next.delete(event.spec_id!); return next; });
    }
    debouncedFetchKanban();
  });

  const handleApprove = useCallback(async (specId: string) => {
    if (!workspaceId) return;
    setActionLoadingMap((prev) => ({ ...prev, [specId]: 'approve' }));
    try {
      await apiFetch(`/api/specs/${encodeURIComponent(specId)}/approve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
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
        method: 'POST', headers: { 'Content-Type': 'application/json' },
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

  // aria-live announcer ref
  const announceRef = useRef<HTMLDivElement | null>(null);
  const announce = useCallback((msg: string) => {
    if (announceRef.current) { announceRef.current.textContent = ''; requestAnimationFrame(() => { if (announceRef.current) announceRef.current.textContent = msg; }); }
  }, []);

  // Column label helper
  const columnLabel = useCallback((key: string) => BOARD_COLUMNS.find(c => c.key === key)?.label ?? key, []);

  // Execute drop transition (source→target) with optimistic UI
  const executeMove = useCallback(async (specId: string, sourceColumn: string, targetColumn: string) => {
    if (sourceColumn === targetColumn) return;

    // Determine the spec and build optimistic state
    const sourceKey = sourceColumn === 'in-progress' ? 'inProgress' : sourceColumn as 'draft' | 'done';
    const targetKey = targetColumn === 'in-progress' ? 'inProgress' : targetColumn as 'draft' | 'done';
    const base = effectiveKanban;
    const spec = (base[sourceKey] as KanbanSpec[]).find(s => s.id === specId);
    if (!spec) return;

    // Block moves TO done (read-only from pipeline completion)
    if (targetColumn === 'done') {
      toast.show('Done column is read-only — specs move here automatically on pipeline completion', 'error');
      return;
    }

    // Optimistic update
    const optimistic: KanbanResponse = {
      draft: [...base.draft],
      inProgress: [...base.inProgress],
      done: [...base.done],
    };
    (optimistic[sourceKey] as KanbanSpec[]) = (optimistic[sourceKey] as KanbanSpec[]).filter(s => s.id !== specId);
    (optimistic[targetKey] as KanbanSpec[]) = [...(optimistic[targetKey] as KanbanSpec[]), spec];
    setOptimisticKanban(optimistic);

    const specTitle = slugToTitle(specId);

    try {
      // draft → in-progress = approve
      if (sourceColumn === 'draft' && targetColumn === 'in-progress') {
        await apiFetch(`/api/specs/${encodeURIComponent(specId)}/approve`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId }),
        });
        toast.show(`Spec "${specTitle}" approved`, 'success');
      } else {
        toast.show('Invalid move — only Draft → In Progress (approve) is supported', 'error');
        setOptimisticKanban(null);
        return;
      }
      announce(`Moved ${specTitle} from ${columnLabel(sourceColumn)} to ${columnLabel(targetColumn)}`);
      fetchKanban();
    } catch (err: any) {
      toast.show(err?.message || 'Move failed — reverted', 'error');
      setOptimisticKanban(null);
    }
  }, [effectiveKanban, workspaceId, toast, fetchKanban, announce, columnLabel]);

  // Clean up ghost element
  const cleanupGhost = useCallback(() => {
    if (dragGhostRef.current) {
      document.body.removeChild(dragGhostRef.current);
      dragGhostRef.current = null;
    }
  }, []);

  // Drag and drop handlers (HTML5 API, using refs for zero re-renders during drag)
  const handleDragStart = useCallback((e: React.DragEvent, specId: string, columnKey: string) => {
    dragSpecIdRef.current = specId;
    dragFromColumnRef.current = columnKey;

    // Set dataTransfer payload
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/json', JSON.stringify({ specId, fromColumnId: columnKey, fromColumnType: columnKey }));

    // Custom drag ghost
    const colDef = BOARD_COLUMNS.find(c => c.key === columnKey);
    const ghost = document.createElement('div');
    ghost.style.cssText = `position:fixed;top:-9999px;left:-9999px;padding:8px 14px;border-radius:8px;background:var(--surface-100,#1e1e2e);color:var(--text,#e2e2e2);font-size:13px;font-weight:600;border-left:3px solid ${colDef?.color ?? '#4f46e5'};box-shadow:0 4px 16px rgba(0,0,0,0.3);white-space:nowrap;pointer-events:none;z-index:99999;`;
    ghost.textContent = slugToTitle(specId);
    document.body.appendChild(ghost);
    dragGhostRef.current = ghost;
    e.dataTransfer.setDragImage(ghost, 10, 10);

    // Apply opacity to source card via DOM (no re-render)
    const target = e.currentTarget as HTMLElement;
    requestAnimationFrame(() => { target.style.opacity = '0.5'; });

    setDragRenderKey(k => k + 1);
  }, []);

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    // Restore source card opacity
    (e.currentTarget as HTMLElement).style.opacity = '';
    dragSpecIdRef.current = null;
    dragFromColumnRef.current = null;
    dragOverColumnRef.current = null;
    clearTimeout(dragLeaveTimerRef.current);
    cleanupGhost();
    setDragRenderKey(k => k + 1);
  }, [cleanupGhost]);

  const handleDragOver = useCallback((e: React.DragEvent, columnKey: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearTimeout(dragLeaveTimerRef.current);
    if (dragOverColumnRef.current !== columnKey) {
      dragOverColumnRef.current = columnKey;
      setDragRenderKey(k => k + 1);
    }
  }, []);

  const handleDragLeave = useCallback(() => {
    // 50ms debounce to prevent flicker between child elements
    clearTimeout(dragLeaveTimerRef.current);
    dragLeaveTimerRef.current = setTimeout(() => {
      dragOverColumnRef.current = null;
      setDragRenderKey(k => k + 1);
    }, 50);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent, targetColumn: string) => {
    e.preventDefault();
    clearTimeout(dragLeaveTimerRef.current);
    const specId = dragSpecIdRef.current;
    const sourceColumn = dragFromColumnRef.current;
    dragSpecIdRef.current = null;
    dragFromColumnRef.current = null;
    dragOverColumnRef.current = null;
    cleanupGhost();
    setDragRenderKey(k => k + 1);

    if (!specId || !sourceColumn || !workspaceId) return;
    await executeMove(specId, sourceColumn, targetColumn);
  }, [workspaceId, executeMove, cleanupGhost]);

  // Touch drag handlers (long-press 300ms to initiate)
  const handleTouchStart = useCallback((e: React.TouchEvent, specId: string, columnKey: string) => {
    const touch = e.touches[0];
    touchStartPosRef.current = { x: touch.clientX, y: touch.clientY };
    touchDragActiveRef.current = false;

    touchDragTimerRef.current = setTimeout(() => {
      touchDragActiveRef.current = true;
      dragSpecIdRef.current = specId;
      dragFromColumnRef.current = columnKey;

      // Create floating clone
      const target = e.currentTarget as HTMLElement;
      const rect = target.getBoundingClientRect();
      const clone = document.createElement('div');
      const colDef = BOARD_COLUMNS.find(c => c.key === columnKey);
      clone.style.cssText = `position:fixed;top:${rect.top}px;left:${rect.left}px;width:${rect.width}px;padding:8px 14px;border-radius:8px;background:var(--surface-100,#1e1e2e);color:var(--text,#e2e2e2);font-size:13px;font-weight:600;border-left:3px solid ${colDef?.color ?? '#4f46e5'};box-shadow:0 8px 24px rgba(0,0,0,0.4);pointer-events:none;z-index:99999;opacity:0.9;`;
      clone.textContent = slugToTitle(specId);
      document.body.appendChild(clone);
      touchCloneRef.current = clone;

      target.style.opacity = '0.5';
      setDragRenderKey(k => k + 1);
    }, 300);
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!touchDragActiveRef.current) {
      // If finger moved > 10px before 300ms, cancel long-press
      if (touchStartPosRef.current) {
        const touch = e.touches[0];
        const dx = touch.clientX - touchStartPosRef.current.x;
        const dy = touch.clientY - touchStartPosRef.current.y;
        if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
          clearTimeout(touchDragTimerRef.current);
        }
      }
      return;
    }

    e.preventDefault();
    const touch = e.touches[0];

    // Move floating clone
    if (touchCloneRef.current) {
      touchCloneRef.current.style.top = `${touch.clientY - 20}px`;
      touchCloneRef.current.style.left = `${touch.clientX - 20}px`;
    }

    // Detect which column is under the finger
    const el = document.elementFromPoint(touch.clientX, touch.clientY);
    if (el) {
      const colEl = el.closest('[data-column-key]');
      const key = colEl?.getAttribute('data-column-key') ?? null;
      if (dragOverColumnRef.current !== key) {
        dragOverColumnRef.current = key;
        setDragRenderKey(k => k + 1);
      }
    }
  }, []);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    clearTimeout(touchDragTimerRef.current);
    (e.currentTarget as HTMLElement).style.opacity = '';

    if (touchDragActiveRef.current && dragSpecIdRef.current && dragFromColumnRef.current) {
      const specId = dragSpecIdRef.current;
      const sourceColumn = dragFromColumnRef.current;
      const targetColumn = dragOverColumnRef.current;

      dragSpecIdRef.current = null;
      dragFromColumnRef.current = null;
      dragOverColumnRef.current = null;
      touchDragActiveRef.current = false;

      if (touchCloneRef.current) {
        document.body.removeChild(touchCloneRef.current);
        touchCloneRef.current = null;
      }
      setDragRenderKey(k => k + 1);

      if (targetColumn && targetColumn !== sourceColumn && workspaceId) {
        executeMove(specId, sourceColumn, targetColumn);
      }
    } else {
      touchDragActiveRef.current = false;
      if (touchCloneRef.current) {
        document.body.removeChild(touchCloneRef.current);
        touchCloneRef.current = null;
      }
    }
  }, [workspaceId, executeMove]);

  // Keyboard card movement: Ctrl+ArrowLeft/Right moves card to adjacent column
  const handleCardKeyDown = useCallback((e: React.KeyboardEvent, specId: string, columnKey: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSpecClick(specId);
      return;
    }

    if (!e.ctrlKey && !e.metaKey) return;
    const colIdx = BOARD_COLUMNS.findIndex(c => c.key === columnKey);
    if (colIdx === -1) return;

    let targetIdx = -1;
    if (e.key === 'ArrowRight' && colIdx < BOARD_COLUMNS.length - 1) targetIdx = colIdx + 1;
    if (e.key === 'ArrowLeft' && colIdx > 0) targetIdx = colIdx - 1;
    if (targetIdx === -1) return;

    e.preventDefault();
    const targetCol = BOARD_COLUMNS[targetIdx].key;
    executeMove(specId, columnKey, targetCol);
  }, [executeMove, onSpecClick]);

  // Cleanup on unmount
  useEffect(() => () => {
    cleanupGhost();
    clearTimeout(dragLeaveTimerRef.current);
    clearTimeout(touchDragTimerRef.current);
    if (touchCloneRef.current) { document.body.removeChild(touchCloneRef.current); touchCloneRef.current = null; }
  }, [cleanupGhost]);

  // Reset optimistic state when real kanban updates
  useEffect(() => { setOptimisticKanban(null); }, [kanban]);

  // Build story progress from effective (possibly optimistic) kanban data
  const storyProgress: Record<string, number> = {};
  for (const k of [...effectiveKanban.inProgress, ...effectiveKanban.done]) {
    if (k.passedStories !== undefined) storyProgress[k.id] = k.passedStories;
  }

  const totalCount = effectiveKanban.draft.length + effectiveKanban.inProgress.length + effectiveKanban.done.length;

  if (loading) {
    return (
      <div className="flex h-full">
        {[0, 1, 2].map((col) => {
          const isCollapsed = !!collapsedColumns[BOARD_COLUMNS[col].key];
          return (
            <div
              key={col}
              className={`flex flex-col min-h-0 ${col > 0 ? 'border-l border-border' : ''}`}
              style={{
                flex: isCollapsed ? '0 0 40px' : '1 1 0%',
                minWidth: isCollapsed ? 40 : 280,
                maxWidth: isCollapsed ? 40 : undefined,
              }}
            >
              {isCollapsed ? (
                <div className="flex flex-col items-center pt-3 gap-2">
                  <div className="w-2 h-2 rounded-full bg-surface-100 animate-pulse" />
                  <div className="h-3 w-3 bg-surface-100 rounded animate-pulse" />
                </div>
              ) : (
                <>
                  <div className="px-3 py-2.5 border-b border-border shrink-0">
                    <div className="h-5 w-24 bg-surface-100 rounded animate-pulse" />
                  </div>
                  <div className="flex-1 p-3 space-y-2">
                    {[1, 2].map((i) => (
                      <div key={i} className="bg-panel border border-border rounded-lg h-[120px] animate-pulse" />
                    ))}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[300px] gap-4 text-center">
        <AlertTriangle size={48} className="text-warning/60" />
        <div>
          <p className="text-base font-medium text-[var(--text)]">Failed to load specs</p>
          <p className="text-sm text-muted mt-1">{error}</p>
        </div>
        <button
          onClick={() => { setRetrying(true); setError(null); setLoading(true); fetchKanban(); }}
          disabled={retrying}
          className="flex items-center gap-2 px-4 py-2 rounded text-sm font-medium bg-accent text-white hover:bg-accent/90 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={14} className={retrying ? 'animate-spin' : ''} />
          {retrying ? 'Retrying...' : 'Retry'}
        </button>
      </div>
    );
  }

  if (totalCount === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[300px] gap-4 text-center">
        <Inbox size={48} className="text-muted/40" />
        <div>
          <p className="text-base font-medium text-[var(--text)]">No specs yet</p>
          <p className="text-sm text-muted mt-1">Create your first spec to get started</p>
        </div>
      </div>
    );
  }

  const columnData: Record<string, KanbanSpec[]> = {
    'draft': effectiveKanban.draft,
    'in-progress': effectiveKanban.inProgress,
    'done': effectiveKanban.done,
  };

  // Max card count across all columns — for progress bar height scaling
  const maxCardCount = Math.max(1, ...BOARD_COLUMNS.map(c => (columnData[c.key] || []).length));

  return (
    <div className="flex h-full board-columns-container">
      {/* aria-live region for screen reader announcements */}
      <div ref={announceRef} aria-live="assertive" aria-atomic="true" className="sr-only" />

      {BOARD_COLUMNS.map((col, colIdx) => {
        const specs = columnData[col.key] || [];
        const Icon = col.icon;
        const isDragOver = dragOverColumnRef.current === col.key && dragSpecIdRef.current != null;
        const isCollapsed = !!collapsedColumns[col.key];
        const progressBarHeight = Math.min(50, (specs.length / maxCardCount) * 50); // vh, max 50

        return (
          <div
            key={col.key}
            data-column-key={col.key}
            className={`flex flex-col min-h-0 transition-colors
              ${colIdx > 0 ? 'border-l border-border' : ''}`}
            style={{
              width: isCollapsed ? 40 : undefined,
              minWidth: isCollapsed ? 40 : 280,
              maxWidth: isCollapsed ? 40 : undefined,
              flex: isCollapsed ? '0 0 40px' : '1 1 0%',
              transition: 'flex 300ms cubic-bezier(0.34, 1.56, 0.64, 1), width 300ms cubic-bezier(0.34, 1.56, 0.64, 1), min-width 300ms cubic-bezier(0.34, 1.56, 0.64, 1), max-width 300ms cubic-bezier(0.34, 1.56, 0.64, 1)',
              overflow: 'hidden',
              ...(isDragOver && !isCollapsed ? { border: `2px dashed ${col.color}`, backgroundColor: `${col.color}26` } : {}),
            }}
            onDragOver={isCollapsed ? undefined : (e) => handleDragOver(e, col.key)}
            onDragLeave={isCollapsed ? undefined : handleDragLeave}
            onDrop={isCollapsed ? undefined : (e) => handleDrop(e, col.key)}
          >
            {isCollapsed ? (
              /* ─── Collapsed column ─── */
              <div
                role="button"
                tabIndex={0}
                aria-label={`Expand ${col.label} column (${specs.length} specs)`}
                onClick={() => toggleCollapse(col.key)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCollapse(col.key); } }}
                className="flex flex-col items-center h-full cursor-pointer hover:bg-surface-100/50 transition-colors select-none"
                style={{ width: 40 }}
              >
                {/* Color dot */}
                <div className="shrink-0 mt-3 mb-1.5 w-2 h-2 rounded-full" style={{ backgroundColor: col.color }} />

                {/* Count badge */}
                <span className={`shrink-0 text-[10px] font-semibold px-1 py-0.5 rounded ${col.accentClass}`}>
                  {specs.length}
                </span>

                {/* Vertical label */}
                <span
                  className="text-[11px] font-medium text-muted mt-3 whitespace-nowrap"
                  style={{ writingMode: 'vertical-rl', textOrientation: 'mixed' }}
                >
                  {col.label}
                </span>

                {/* Progress bar — height proportional to card count */}
                {specs.length > 0 && (
                  <div
                    className="mt-auto mb-3 w-1 rounded-full overflow-hidden"
                    style={{ height: `${progressBarHeight}vh` }}
                  >
                    <div
                      className="w-full h-full rounded-full"
                      style={{
                        background: `linear-gradient(to bottom, ${col.color}, color-mix(in srgb, ${col.color} 20%, transparent))`,
                      }}
                    />
                  </div>
                )}

                {/* Expand chevron */}
                <ChevronRight size={12} className="shrink-0 text-muted/50 mb-2" />
              </div>
            ) : (
              /* ─── Expanded column ─── */
              <>
                {/* Column header */}
                <div
                  role="button"
                  tabIndex={0}
                  aria-label={`Collapse ${col.label} column`}
                  onClick={() => toggleCollapse(col.key)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCollapse(col.key); } }}
                  className="flex items-center gap-2 px-3 py-2.5 border-b border-border shrink-0 cursor-pointer hover:bg-surface-100/30 transition-colors select-none"
                >
                  <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: col.color }} />
                  <Icon size={14} className={col.iconClass} />
                  <span className="text-sm font-medium text-[var(--text)]">{col.label}</span>
                  <span className={`text-[11px] font-medium px-1.5 py-0.5 rounded-full ${col.accentClass}`}>
                    {specs.length}
                  </span>
                  <ChevronLeft size={12} className="ml-auto text-muted/40 shrink-0" />
                </div>

                {/* Column body */}
                <div className="flex-1 overflow-y-auto min-h-0 p-3 space-y-2">
                  {specs.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-12 text-center">
                      <Icon size={32} className="text-muted/30 mb-2" />
                      <p className="text-sm text-muted">{col.emptyMessage}</p>
                    </div>
                  ) : (
                    specs.map((spec) => {
                      const total = spec.storyCount;
                      const passed = storyProgress[spec.id] ?? 0;
                      const hasProgress = storyProgress[spec.id] !== undefined && col.key !== 'draft';
                      const progressPct = total > 0 ? Math.round((passed / total) * 100) : 0;
                      const isDraft = col.key === 'draft';
                      const actionLoading = actionLoadingMap[spec.id] ?? null;
                      const isActioning = actionLoading !== null;
                      const hasActiveRun = activeRunSpecs.has(spec.id);

                      return (
                        <div key={spec.id} className="group relative">
                          {/* div[role=button][draggable] — no nested <button> to swallow drag events */}
                          <div
                            role="button"
                            tabIndex={0}
                            draggable
                            aria-label={`${slugToTitle(spec.id)}, ${total} stories, in ${col.label} column. Ctrl+Arrow to move.`}
                            onDragStart={(e) => handleDragStart(e, spec.id, col.key)}
                            onDragEnd={handleDragEnd}
                            onTouchStart={(e) => handleTouchStart(e, spec.id, col.key)}
                            onTouchMove={handleTouchMove}
                            onTouchEnd={handleTouchEnd}
                            onKeyDown={(e) => handleCardKeyDown(e, spec.id, col.key)}
                            onFocus={() => { focusedCardRef.current = { specId: spec.id, columnKey: col.key }; }}
                            onClick={() => !isActioning && onSpecClick(spec.id)}
                            className={`w-full h-[120px] bg-panel border rounded-lg p-3 text-left
                              flex flex-col justify-between overflow-hidden cursor-grab select-none
                              transition-all duration-150 hover:shadow-md hover:shadow-black/20 hover:border-accent/40
                              hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50
                              ${isActioning ? 'opacity-60 pointer-events-none' : ''}
                              border-border`}
                          >
                            <div className="min-w-0">
                              <div className="flex items-start gap-1.5">
                                <GripVertical size={12} className="text-muted/30 mt-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                                <h3 className="text-sm font-semibold text-[var(--text)] line-clamp-2 leading-[1.3] flex-1">
                                  {slugToTitle(spec.id)}
                                </h3>
                                {hasActiveRun && (
                                  <span className="shrink-0 mt-0.5 inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-accent/15 text-accent border border-accent/30 animate-pulse">
                                    <Play size={8} className="fill-current" /> Running
                                  </span>
                                )}
                              </div>
                            </div>

                            <div className="flex items-center justify-between gap-2 mt-auto min-w-0">
                              <span className="shrink-0 inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-accent/10 text-accent border border-accent/20">
                                <Layers size={10} />
                                {hasProgress ? `${passed}/${total} stories` : `${total} ${total === 1 ? 'story' : 'stories'}`}
                              </span>
                              <span className="shrink-0 text-[11px] text-muted flex items-center gap-1">
                                <Clock size={10} />
                                {col.key === 'done' && spec.approvedAt ? relativeTime(spec.approvedAt) : relativeTime(spec.generatedAt)}
                              </span>
                            </div>

                            {hasProgress && (
                              <div className="w-full h-1 rounded-full bg-surface-200 mt-1.5 overflow-hidden">
                                <div
                                  className={`h-full rounded-full transition-all duration-300 ${progressPct === 100 ? 'bg-success' : 'bg-accent'}`}
                                  style={{ width: `${progressPct}%` }}
                                />
                              </div>
                            )}
                          </div>

                          {/* Approve / Deny actions — Draft column only */}
                          {isDraft && (
                            <div className={`absolute top-2 right-2 flex items-center gap-1 ${isActioning ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} transition-opacity duration-150`}>
                              <button type="button" onClick={(e) => { e.stopPropagation(); handleApprove(spec.id); }} disabled={isActioning} title="Approve spec"
                                className="p-1.5 rounded-md bg-success/15 text-success border border-success/30 hover:bg-success/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                                {actionLoading === 'approve' ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                              </button>
                              <button type="button" onClick={(e) => { e.stopPropagation(); handleDeny(spec.id); }} disabled={isActioning} title="Deny spec"
                                className="p-1.5 rounded-md bg-error/15 text-error border border-error/30 hover:bg-error/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                                {actionLoading === 'deny' ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════
   LIST VIEW — Searchable archive table
   ════════════════════════════════════════════════════════════════════ */

function ListView({ workspaceId, onSpecClick, onNavigate }: {
  workspaceId: string;
  onSpecClick: (specId: string, summary?: ArchiveSpec) => void;
  onNavigate: (panel: PanelId) => void;
}) {
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

  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedSearch(searchText), 300);
    return () => clearTimeout(debounceRef.current);
  }, [searchText]);

  const fetchSpecs = useCallback(async (offset = 0, append = false) => {
    if (!workspaceId) return;
    if (!append) setLoading(true);
    else setLoadingMore(true);
    setError('');

    try {
      const params = new URLSearchParams({ workspaceId, status: statusFilter, limit: String(PAGE_SIZE), offset: String(offset) });
      if (debouncedSearch) params.set('q', debouncedSearch);
      if (tagFilter.length > 0) params.set('tags', tagFilter.join(','));

      const res = await apiFetch<ArchiveResponse>(`/api/specs/archive?${params}`);
      if (append) setSpecs(prev => [...prev, ...res.items]);
      else setSpecs(res.items);
      setTotal(res.total);
      setHasMore(res.hasMore);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load specs');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [workspaceId, statusFilter, debouncedSearch, tagFilter]);

  useEffect(() => { fetchSpecs(0, false); }, [fetchSpecs]);

  const allTags = Array.from(new Set(specs.flatMap(s => s.tags || []))).sort();

  if (error && !loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <p className="text-sm text-error mb-2">{error}</p>
          <button onClick={() => fetchSpecs()} className="text-xs text-accent hover:text-accent-hover transition-colors">Retry</button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Search + Filters bar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border shrink-0 flex-wrap">
        <div className="relative w-full sm:w-48 shrink-0">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
          <input
            type="text" value={searchText} onChange={(e) => setSearchText(e.target.value)}
            placeholder="Search specs..."
            className="w-full h-8 pl-8 pr-8 bg-panel border border-border rounded text-sm text-text placeholder-muted/60 focus:outline-none focus:border-accent/40 focus:ring-2 focus:ring-accent/50 transition-shadow transition-colors"
          />
          {searchText && (
            <button onClick={() => setSearchText('')} aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-text transition-colors">
              <X size={14} />
            </button>
          )}
        </div>

        <select
          value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          className="h-8 px-2 pr-8 bg-transparent border border-border/50 rounded text-sm text-muted hover:text-text focus:outline-none focus:border-accent/40 transition-colors cursor-pointer appearance-none"
          style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 8px center' }}
        >
          {STATUS_FILTERS.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>

        <select
          value={tagFilter.length > 0 ? tagFilter[0] : 'all'}
          onChange={(e) => { const val = e.target.value; if (val === 'all') setTagFilter([]); else setTagFilter([val]); }}
          className="h-8 px-2 pr-8 bg-transparent border border-border/50 rounded text-sm text-muted hover:text-text focus:outline-none focus:border-accent/40 transition-colors cursor-pointer appearance-none max-w-[100px]"
          style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 8px center' }}
        >
          <option value="all">Any Tag</option>
          {allTags.map(tag => <option key={tag} value={tag}>{tag}</option>)}
        </select>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-full text-muted text-sm">Loading specs...</div>
        ) : specs.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="flex flex-col items-center gap-4 p-8 border-2 border-dashed border-border rounded-lg max-w-xs text-center">
              <Archive size={64} className="text-muted/40" strokeWidth={1.2} />
              <div>
                {debouncedSearch ? (
                  <>
                    <p className="text-sm font-medium text-text mb-1">No specs match &ldquo;{debouncedSearch}&rdquo;</p>
                    <p className="text-xs text-muted">Try a different keyword</p>
                  </>
                ) : (
                  <>
                    <p className="text-sm font-medium text-text mb-1">No specs generated yet</p>
                    <p className="text-xs text-muted">Create your first spec</p>
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
                  onClick={() => onSpecClick(spec.id, spec)}
                  aria-label={`${spec.specName} - ${spec.status}`}
                  className={`w-full text-left px-4 py-2.5 border-b border-border transition-colors focus:outline-none focus:ring-2 focus:ring-inset focus:ring-accent/50 hover:bg-panel ${spec.status === 'completed' ? 'opacity-80' : ''}`}
                >
                  {/* Row 1 */}
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${cfg.dotClass}`} />
                    <span className="text-sm font-mono font-semibold text-text truncate flex-1">{spec.specName}</span>
                    {spec.source === 'quick-run' && (
                      <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-purple-500/15 text-purple-400">Quick</span>
                    )}
                    <span className="text-[10px] text-muted tabular-nums shrink-0">{formatDate(spec.generatedAt)}</span>
                    <ChevronRight size={14} className="shrink-0 text-muted" />
                  </div>

                  {/* Row 2 */}
                  <div className="flex items-center gap-2 mb-1 ml-3.5 min-w-0">
                    {spec.repoName && <span className="text-[10px] text-muted font-mono truncate">{spec.repoName}</span>}
                    {spec.branchName && (
                      <span className="flex items-center gap-0.5 text-[10px] text-muted font-mono truncate">
                        <GitBranch className="w-2.5 h-2.5" />{spec.branchName.replace('feat/', '')}
                      </span>
                    )}
                    {spec.forkedFrom && (
                      <span className="flex items-center gap-0.5 text-[10px] text-accent font-mono">
                        <GitFork className="w-2.5 h-2.5" />{spec.forkedFrom}
                      </span>
                    )}
                    <div className="flex-1" />
                    {tel ? (
                      <div className="flex items-center gap-2 shrink-0">
                        <div className="w-16"><StoryOutcomeBar outcomes={tel.storyOutcomes} storyCount={spec.storyCount} /></div>
                        <span className="text-[10px] font-mono tabular-nums text-muted">{tel.storyOutcomes.pass}/{spec.storyCount}</span>
                      </div>
                    ) : (
                      <span className="text-[10px] text-muted tabular-nums shrink-0">{spec.storyCount} {spec.storyCount === 1 ? 'story' : 'stories'}</span>
                    )}
                  </div>

                  {/* Row 3 */}
                  {tel ? (
                    <div className="flex items-center gap-3 ml-3.5 text-[10px] text-muted">
                      {tel.durationSeconds != null && <span className="font-mono tabular-nums">{formatDurationShort(tel.durationSeconds)}</span>}
                      {(tel.totalInputTokens != null || tel.totalOutputTokens != null) && (
                        <span className="font-mono tabular-nums">{formatTokensCompact((tel.totalInputTokens ?? 0) + (tel.totalOutputTokens ?? 0))} tok</span>
                      )}
                      {tel.totalCostUsd != null && tel.totalCostUsd > 0 && <span className="font-mono tabular-nums">{formatCostCompact(tel.totalCostUsd)}</span>}
                      <AgentBadge agentType={tel.agentType} agentModel={tel.agentModel} size="sm" />
                      {spec.tags?.length > 0 && (
                        <div className="flex-1 min-w-0 overflow-hidden">
                          <TagChipsReadonly tags={spec.tags} onTagClick={tag => { if (!tagFilter.includes(tag)) setTagFilter(prev => [...prev, tag]); }} />
                        </div>
                      )}
                    </div>
                  ) : (
                    <>
                      {spec.tags?.length > 0 && <div className="ml-3.5"><TagChipsReadonly tags={spec.tags} onTagClick={tag => { if (!tagFilter.includes(tag)) setTagFilter(prev => [...prev, tag]); }} /></div>}
                      {spec.reviewStatus && spec.reviewStatus !== 'draft' && (
                        <div className="ml-3.5 mt-0.5">
                          <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded ${
                            spec.reviewStatus === 'review_requested' ? 'bg-accent/15 text-accent' :
                            spec.reviewStatus === 'approved' ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning'
                          }`}>
                            {spec.reviewStatus === 'review_requested' ? 'Needs Review' : spec.reviewStatus === 'approved' ? 'Review OK' : 'Changes Req.'}
                          </span>
                        </div>
                      )}
                    </>
                  )}

                  {spec.status === 'rejected' && spec.rejectReason && (
                    <p className="text-xs text-error/70 mt-1 ml-3.5 truncate">Reason: {spec.rejectReason}</p>
                  )}
                </button>
              );
            })}

            {/* Pagination */}
            <div className="px-4 py-3 border-b border-border text-center">
              <p className="text-xs text-muted mb-2">Showing {specs.length} of {total} specs</p>
              {hasMore && (
                <button onClick={() => fetchSpecs(specs.length, true)} disabled={loadingMore}
                  className="px-4 py-1.5 text-xs font-medium rounded bg-panel border border-border text-text hover:bg-accent/10 transition-colors disabled:opacity-50">
                  {loadingMore ? 'Loading...' : 'Load more'}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════
   NEW SPEC FORM — Slide-over content
   ════════════════════════════════════════════════════════════════════ */

const CONTEXT_DOTS = [
  { key: 'l1' as const, layer: 1, label: 'Standards', emptyHeading: 'Standards not configured', emptyDesc: 'Engineering principles and coding style — applied across all workspaces.' },
  { key: 'l2' as const, layer: 2, label: 'Conventions', emptyHeading: 'Conventions not configured', emptyDesc: 'Patterns for this type of project — detected from your codebase or entered manually.' },
  { key: 'l3' as const, layer: 3, label: 'Project', emptyHeading: 'Project context not configured', emptyDesc: 'Stack, architecture, and key constraints specific to this workspace.' },
] as const;

function NewSpecForm({ onClose, onNavigate, onNavigateToRun, initialBrief }: {
  onClose: () => void;
  onNavigate?: (panel: PanelId) => void;
  onNavigateToRun?: (runId: number) => void;
  initialBrief?: string | null;
}) {
  const { workspaceId, workspaces } = useWorkspace();
  const workspace = workspaces.find((w) => w.id === workspaceId);
  const { show: showToast } = useGlobalToast();

  // Spec fields
  const [specName, setSpecName] = useState('');
  const [specNameError, setSpecNameError] = useState('');
  const [specBrief, setSpecBrief] = useState(() => initialBrief ?? '');
  const briefRef = useRef<HTMLTextAreaElement>(null);

  // Model
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState(() => {
    try { return localStorage.getItem('rorca:forge:model') ?? ''; } catch { return ''; }
  });
  const [defaultModelId, setDefaultModelId] = useState<string | null>(null);
  const [activeProvider, setActiveProvider] = useState<string>('claude-cli');

  // Agent override
  const [wsAgentType, setWsAgentType] = useState<AgentType>('claude');
  const [wsAgentModel, setWsAgentModel] = useState<string | null>(null);
  const [wsModelDisplayName, setWsModelDisplayName] = useState<string | null>(null);
  const [wsAgentBinaries, setWsAgentBinaries] = useState<{ claudeInstalled?: boolean; opencodeInstalled?: boolean; codexInstalled?: boolean }>({});
  const [overrideAgent, setOverrideAgent] = useState(false);
  const [overrideAgentType, setOverrideAgentType] = useState<AgentType>('claude');
  const [overrideAgentModel, setOverrideAgentModel] = useState<string | null>(null);
  const [opencodeModels, setOpencodeModels] = useState<ModelOption[]>([]);

  // Story count
  const STORY_COUNT_PRESETS = [3, 5, 8, 10, 15, 20] as const;
  const [storyCount, setStoryCount] = useState(() => {
    try { const saved = localStorage.getItem('rorca:forge:storyCount'); if (saved) { const n = parseInt(saved, 10); if (!isNaN(n) && n >= 0) return n; } } catch { /* ignore */ }
    return 0;
  });
  const [showCustomInput, setShowCustomInput] = useState(false);
  const [storyCountRaw, setStoryCountRaw] = useState(String(storyCount));

  // Advanced options
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Generation state
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedSpec, setGeneratedSpec] = useState<GeneratedSpec | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [apiDone, setApiDone] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Quick run
  const [isQuickRunning, setIsQuickRunning] = useState(false);

  // Template picker
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);

  // Slug preview
  const [previewSlug, setPreviewSlug] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setPreviewSlug(specName ? '' : briefToSlug(specBrief)), 300);
    return () => clearTimeout(timer);
  }, [specBrief, specName]);
  const effectiveSlug = useMemo(() => specName || previewSlug, [specName, previewSlug]);

  // Direction layers
  const [directionLayers, setDirectionLayers] = useState<DirectionAllResponse['layers'] | null>(null);
  const [contextPopover, setContextPopover] = useState<string | null>(null);
  const [quickDirectionText, setQuickDirectionText] = useState('');
  const [autoDetecting, setAutoDetecting] = useState<string | null>(null);

  // Auto-focus brief
  useEffect(() => { setTimeout(() => briefRef.current?.focus(), 100); }, []);

  // Auto-resize textarea
  const autoResizeBrief = useCallback(() => {
    const el = briefRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 20;
    const minH = lineHeight * 6;
    const maxH = lineHeight * 20;
    el.style.height = `${Math.min(maxH, Math.max(minH, el.scrollHeight))}px`;
  }, []);

  useEffect(() => { autoResizeBrief(); }, [specBrief, autoResizeBrief]);

  // Fetch models and config
  useEffect(() => {
    if (!workspaceId) return;
    Promise.all([
      apiFetch<{ models: ModelOption[]; defaultModel: string }>(`/api/direction/models?workspaceId=${workspaceId}`),
      apiFetch<{ provider: string }>(`/api/vault/keys/default-provider?workspaceId=${workspaceId}`),
      apiFetch<{ agentType: AgentType; agentModel: string | null; modelDisplayName: string | null; opencodeInstalled?: boolean; codexInstalled?: boolean }>('/api/config'),
      apiFetch<{ models: Array<{ id: string; name: string; provider: string; contextWindow: number; costPer1kInput?: number; costPer1kOutput?: number; speedTier?: string; costTier?: string }> }>('/api/config/opencode-models'),
    ]).then(([modelData, providerData, configData, ocModels]) => {
      setAvailableModels(modelData.models);
      setDefaultModelId(modelData.defaultModel);
      setActiveProvider(providerData.provider);
      setWsAgentType(configData.agentType);
      setWsAgentModel(configData.agentModel);
      setWsModelDisplayName(configData.modelDisplayName);
      setWsAgentBinaries({ claudeInstalled: true, opencodeInstalled: configData.opencodeInstalled, codexInstalled: configData.codexInstalled });
      setOverrideAgentType(configData.agentType);
      setOverrideAgentModel(configData.agentModel);
      setOpencodeModels(ocModels.models.map(m => ({ id: m.id, label: m.name, provider: m.provider, providerType: undefined, costPer1kInput: m.costPer1kInput ?? 0, costPer1kOutput: m.costPer1kOutput ?? 0, contextWindow: m.contextWindow, speedTier: m.speedTier, costTier: m.costTier, recommended: false })));
    }).catch(() => { });
  }, [workspaceId]);

  // Fetch direction layers
  useEffect(() => {
    if (!workspaceId) { setDirectionLayers(null); return; }
    apiFetch<DirectionAllResponse>(`/api/direction/all?workspaceId=${workspaceId}`)
      .then(res => setDirectionLayers(res.layers))
      .catch(() => setDirectionLayers(null));
  }, [workspaceId]);

  const validateSpecName = useCallback((value: string) => {
    if (!value) { setSpecNameError(''); return; }
    if (!KEBAB_RE.test(value)) setSpecNameError('Must be kebab-case (e.g. user-auth-oauth)');
    else setSpecNameError('');
  }, []);

  const canGenerate = !specNameError && specBrief.length > 0;
  const canQuickRun = specBrief.trim().length > 0 && !!workspaceId;

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsGenerating(false);
    setApiDone(false);
    setGenerateError(null);
  }, []);

  const handleGenerate = async () => {
    if (!canGenerate || isGenerating) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setIsGenerating(true);
    setGenerateError(null);
    setApiDone(false);
    const modelUsed = selectedModel || defaultModelId || 'claude-sonnet-4-5-20250929';
    try {
      const result = await apiFetch<GeneratedSpec>('/api/specs/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ workspaceId, specName: specName || undefined, storyCount, specBrief, model: selectedModel || undefined }),
      });
      setApiDone(true);
      setGeneratedSpec(result);
      setTimeout(() => setIsGenerating(false), 800);
    } catch (err: unknown) {
      if (controller.signal.aborted) return;
      setApiDone(true);
      const message = err instanceof Error ? err.message : String(err);
      const alternatives = availableModels.filter(m => m.id !== modelUsed).map(m => m.label);
      const suggestion = alternatives.length > 0 ? ` Try an alternative model: ${alternatives.join(', ')}.` : '';
      setGenerateError(`Generation failed with ${availableModels.find(m => m.id === modelUsed)?.label || modelUsed}: ${message}.${suggestion}`);
      setIsGenerating(false);
    }
  };

  const handleQuickRun = async () => {
    if (!canQuickRun || isQuickRunning) return;
    setIsQuickRunning(true);
    try {
      const res = await apiFetch<{ runId?: number; specId?: string; conflict?: boolean; activeRunId?: number }>(
        '/api/pipeline/quick-run',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId, brief: specBrief.trim(), model: selectedModel || undefined }) },
      );
      if (res.conflict) {
        showToast('Another run is active in this workspace', 'error');
        if (res.activeRunId && onNavigateToRun) onNavigateToRun(res.activeRunId);
      } else if (res.runId) {
        showToast('Quick run started', 'success');
        onClose();
        if (onNavigateToRun) onNavigateToRun(res.runId);
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Quick run failed', 'error');
    } finally {
      setIsQuickRunning(false);
    }
  };

  const handleAutoDetect = async (dot: typeof CONTEXT_DOTS[number]) => {
    if (!workspaceId || autoDetecting) return;
    setAutoDetecting(dot.key);
    try {
      const res = await apiFetch<{ l1Draft: string; l2Draft: string; l3Draft: string }>(`/api/workspaces/${workspaceId}/scan-direction`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const draftMap: Record<string, string> = { l1: res.l1Draft, l2: res.l2Draft, l3: res.l3Draft };
      const draft = draftMap[dot.key];
      if (draft) setQuickDirectionText(draft);
      else showToast('Auto-detect returned no content for this layer', 'error');
    } catch {
      showToast('Auto-detect failed', 'error');
    } finally {
      setAutoDetecting(null);
    }
  };

  const handleQuickDirectionSave = async (layerNum: number) => {
    if (!quickDirectionText.trim() || !workspaceId) return;
    try {
      await apiFetch('/api/direction', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId, layer: layerNum, contentYaml: quickDirectionText.trim(), skipValidation: true }) });
      const res = await apiFetch<DirectionAllResponse>(`/api/direction/all?workspaceId=${workspaceId}`);
      setDirectionLayers(res.layers);
      setContextPopover(null);
      setQuickDirectionText('');
      showToast('Direction saved', 'success');
    } catch {
      showToast('Failed to save direction', 'error');
    }
  };

  const handleStoryCountSelect = (value: string) => {
    if (value === 'custom') { setShowCustomInput(true); setStoryCountRaw(String(storyCount || 8)); }
    else if (value === '0') { setShowCustomInput(false); setStoryCount(0); setStoryCountRaw('0'); }
    else { setShowCustomInput(false); const n = parseInt(value, 10); if (!isNaN(n)) { setStoryCount(n); setStoryCountRaw(value); } }
  };

  return (
    <div className="p-6 space-y-6">
      {/* Template prompt */}
      {!specBrief.trim() && !generatedSpec && !isGenerating && (
        <button onClick={() => setShowTemplatePicker(true)}
          className="w-full flex items-center gap-3 px-4 py-3 text-left bg-panel border border-dashed border-border rounded-lg hover:border-accent/40 hover:bg-accent/5 transition-colors group">
          <div className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center shrink-0 group-hover:bg-accent/20 transition-colors">
            <Inbox size={16} className="text-accent" />
          </div>
          <div>
            <span className="text-sm font-medium text-[var(--text)]">Start from a template</span>
            <p className="text-xs text-muted mt-0.5">Pick a saved spec template to pre-fill your brief</p>
          </div>
          <ChevronRight size={14} className="ml-auto text-muted group-hover:text-accent transition-colors" />
        </button>
      )}

      {/* Brief textarea */}
      {(!generatedSpec || isGenerating) && (
        <textarea
          ref={briefRef} rows={6} value={specBrief}
          onChange={(e) => setSpecBrief(e.target.value.slice(0, 4000))}
          placeholder="What do you want to build?"
          className="w-full px-4 py-4 text-sm bg-panel border border-border rounded-lg text-text placeholder:text-muted/50 outline-none focus:border-accent focus:ring-2 focus:ring-accent/50 transition-colors resize-none leading-relaxed"
        />
      )}

      {/* Context health dots */}
      {!generatedSpec && directionLayers && (
        <div className="flex flex-wrap items-center gap-4 relative">
          {CONTEXT_DOTS.map(dot => {
            const layerData = directionLayers[dot.key];
            const populated = !!layerData?.content;
            return (
              <div key={dot.key} className="relative">
                <button onClick={() => { setContextPopover(contextPopover === dot.key ? null : dot.key); setQuickDirectionText(''); }}
                  className="flex items-center gap-1.5 group min-h-[44px] px-2" title={populated ? `${dot.label} configured` : dot.emptyHeading}>
                  <span className={`w-1.5 h-1.5 rounded-full transition-colors ${populated ? 'bg-emerald-500' : 'bg-border group-hover:bg-muted/50'}`} />
                  <span className={`text-xs transition-colors ${populated ? 'text-muted' : 'text-muted/50 group-hover:text-muted'}`}>{dot.label}</span>
                </button>

                {contextPopover === dot.key && populated && (
                  <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 w-[min(18rem,90vw)] bg-bg border border-border rounded-lg shadow-lg z-50 p-3 space-y-2">
                    <p className="text-xs font-medium text-text">{dot.label}</p>
                    <p className="text-xs text-muted whitespace-pre-wrap break-words leading-relaxed">
                      {layerData!.content!.length > 200 ? layerData!.content!.slice(0, 200) + '...' : layerData!.content}
                    </p>
                    <button onClick={() => { setContextPopover(null); onNavigate?.('stack'); onClose(); }} className="text-[10px] text-accent hover:text-accent-hover transition-colors">View full &rarr;</button>
                  </div>
                )}

                {contextPopover === dot.key && !populated && (
                  <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 w-[min(18rem,90vw)] bg-bg border border-border rounded-lg shadow-lg z-50 p-3 space-y-2">
                    <p className="text-xs font-medium text-text">{dot.emptyHeading}</p>
                    <p className="text-[10px] text-muted leading-relaxed">{dot.emptyDesc}</p>
                    <button onClick={() => handleAutoDetect(dot)} disabled={autoDetecting === dot.key}
                      className="w-full px-2 py-1.5 text-[10px] font-medium rounded border border-border bg-panel text-text hover:border-accent/30 hover:bg-accent/5 transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5">
                      {autoDetecting === dot.key ? 'Scanning...' : 'Auto-detect'}
                    </button>
                    <textarea rows={3} value={quickDirectionText} onChange={(e) => setQuickDirectionText(e.target.value)}
                      placeholder={`Add ${dot.label.toLowerCase()}...`}
                      className="w-full px-2 py-1.5 text-xs bg-panel border border-border rounded text-text placeholder:text-muted/50 outline-none focus:border-accent transition-colors resize-none" autoFocus />
                    <div className="flex items-center justify-between">
                      <button onClick={() => { setContextPopover(null); onNavigate?.('stack'); onClose(); }} className="text-[10px] text-accent hover:text-accent-hover transition-colors">Set up in Direction</button>
                      <div className="flex gap-1.5">
                        <button onClick={() => setContextPopover(null)} className="px-2 py-1 text-[10px] text-muted hover:text-text rounded transition-colors">Cancel</button>
                        <button onClick={() => handleQuickDirectionSave(dot.layer)} disabled={!quickDirectionText.trim()}
                          className={`px-2 py-1 text-[10px] rounded transition-colors ${quickDirectionText.trim() ? 'bg-accent text-white hover:bg-accent-hover' : 'bg-accent/30 text-white/40 cursor-not-allowed'}`}>Save</button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {contextPopover && <div className="fixed inset-0 z-40" onClick={() => setContextPopover(null)} />}

      {/* Generate + Quick Run buttons */}
      {(!generatedSpec || isGenerating) && (
        <div className="space-y-2">
          {isGenerating || (generateError && !generatedSpec) ? (
            <SpecForgeProgress isActive={isGenerating} onCancel={handleCancel} error={generateError} apiDone={apiDone} multiPass={false} specSlug={effectiveSlug} />
          ) : !generatedSpec ? (
            <>
              <button onClick={handleGenerate} disabled={!canGenerate || isGenerating}
                className={`w-full py-2.5 rounded-lg text-sm font-medium transition-colors ${canGenerate && !isGenerating ? 'bg-accent text-white hover:bg-accent-hover cursor-pointer' : 'bg-accent/30 text-white/40 cursor-not-allowed'}`}>
                Generate Spec
              </button>
              {canQuickRun && (
                <button onClick={handleQuickRun} disabled={isQuickRunning || isGenerating}
                  className={`w-full py-2 rounded-lg text-sm font-medium transition-colors border ${isQuickRunning || isGenerating ? 'bg-panel/50 border-border/50 text-muted/40 cursor-not-allowed' : 'bg-panel border-border text-text hover:bg-accent/10 hover:border-accent/30 cursor-pointer'}`}>
                  {isQuickRunning ? 'Generating & running...' : 'Quick Run'}
                </button>
              )}
            </>
          ) : null}
        </div>
      )}

      {/* Advanced Options */}
      {!generatedSpec && (
        <section>
          <button onClick={() => setAdvancedOpen(o => !o)} aria-expanded={advancedOpen}
            className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted hover:text-text transition-colors w-full">
            <svg className={`w-3 h-3 transition-transform duration-200 ${advancedOpen ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
            Advanced Options
          </button>
          {advancedOpen && (
            <div className="mt-4 space-y-4">
              <div>
                <label className="block text-xs font-medium text-muted mb-1.5">Spec Name (optional)</label>
                <input type="text" value={specName} onChange={(e) => setSpecName(e.target.value)} onBlur={() => validateSpecName(specName)}
                  placeholder={effectiveSlug || 'auto-generated from brief'}
                  className="w-full px-3 py-2 text-sm bg-panel border border-border rounded text-text placeholder:text-muted/50 outline-none focus:border-accent transition-colors" />
                {specNameError && <p className="mt-1 text-xs text-error">{specNameError}</p>}
              </div>

              {/* Execution Engine Override */}
              <div className="space-y-2">
                <label className="flex items-center gap-2 cursor-pointer group">
                  <button type="button" role="switch" aria-checked={overrideAgent} onClick={() => setOverrideAgent(o => !o)}
                    className={`relative w-8 h-[18px] rounded-full transition-colors ${overrideAgent ? 'bg-accent' : 'bg-border group-hover:bg-muted/40'}`}>
                    <span className={`absolute top-0.5 left-0.5 w-3.5 h-3.5 rounded-full bg-white transition-transform ${overrideAgent ? 'translate-x-[14px]' : ''}`} />
                  </button>
                  <span className="text-xs font-medium text-text">Override execution engine</span>
                </label>
                {overrideAgent && (
                  <AgentPicker agentType={overrideAgentType} agentModel={overrideAgentModel}
                    onAgentTypeChange={setOverrideAgentType} onModelChange={setOverrideAgentModel}
                    models={opencodeModels} defaultModelId={wsAgentModel} compact
                    claudeInstalled={wsAgentBinaries.claudeInstalled} opencodeInstalled={wsAgentBinaries.opencodeInstalled} codexInstalled={wsAgentBinaries.codexInstalled} />
                )}
              </div>

              {/* Model */}
              <div>
                <label className="block text-xs font-medium text-muted mb-1.5">Spec Generation Model</label>
                <ModelSearchSelect models={availableModels} value={selectedModel || defaultModelId || ''} defaultModelId={defaultModelId} onChange={setSelectedModel} />
              </div>

              {/* Story Count */}
              <div>
                <label className="block text-xs font-medium text-muted mb-1.5">Story Count</label>
                <div className="flex gap-2">
                  <select value={showCustomInput ? 'custom' : String(storyCount)} onChange={(e) => handleStoryCountSelect(e.target.value)}
                    className="flex-1 px-3 py-2 text-sm bg-panel border border-border rounded text-text outline-none focus:border-accent transition-colors appearance-none cursor-pointer">
                    <option value="0">Auto</option>
                    {STORY_COUNT_PRESETS.map((n) => <option key={n} value={n}>{n} stories</option>)}
                    <option value="custom">Custom</option>
                  </select>
                  {showCustomInput && (
                    <input type="text" inputMode="numeric" value={storyCountRaw}
                      onChange={(e) => { setStoryCountRaw(e.target.value); const n = parseInt(e.target.value, 10); if (!isNaN(n) && n >= 1) setStoryCount(n); }}
                      onBlur={() => { const c = Math.min(500, Math.max(1, storyCount || 1)); setStoryCount(c); setStoryCountRaw(String(c)); }}
                      className="w-16 px-2 py-2 text-sm bg-panel border border-border rounded text-text outline-none focus:border-accent transition-colors text-center" autoFocus />
                  )}
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      {/* Post-generation preview */}
      {generatedSpec && !isGenerating && (
        <SpecForgePreview
          spec={generatedSpec} workspaceId={workspaceId ?? ''} onRegenerate={handleGenerate}
          onEditBrief={() => { setGeneratedSpec(null); setGenerateError(null); setApiDone(false); setTimeout(() => briefRef.current?.focus(), 50); }}
          isRegenerating={isGenerating} onNavigate={onNavigate}
          onNavigateToRun={(runId) => { onClose(); onNavigateToRun?.(runId); }}
          onReset={() => { setGeneratedSpec(null); setGenerateError(null); setApiDone(false); setSpecBrief(''); setTimeout(() => briefRef.current?.focus(), 50); }}
        />
      )}

      {showTemplatePicker && (
        <TemplatePickerModal onClose={() => setShowTemplatePicker(false)}
          onSelect={(tpl) => { setSpecBrief(tpl.brief); setStoryCount(tpl.storyCount); setShowTemplatePicker(false); setTimeout(() => briefRef.current?.focus(), 50); }} />
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════
   SPEC DETAIL VIEW — Slide-over content (replaces ArchivePanel drawer + SpecReviewPanel)
   ════════════════════════════════════════════════════════════════════ */

function SpecDetailView({ specId, initialSummary, onClose, onNavigate, onNavigateToRun }: {
  specId: string;
  initialSummary: ArchiveSpec | null;
  onClose: () => void;
  onNavigate: (panel: PanelId) => void;
  onNavigateToRun?: (runId: number) => void;
}) {
  const { workspaceId } = useWorkspace();
  const { user } = useAuth();
  const toast = useGlobalToast();
  const isFreePlan = !user?.plan || user.plan === 'free';

  // Summary + detail
  const [summary, setSummary] = useState<ArchiveSpec | null>(initialSummary);
  const [detail, setDetail] = useState<SpecDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<PreviewTab>('stories');

  // Stories
  const [localStories, setLocalStories] = useState<Story[]>([]);

  // Run state
  const [runState, setRunState] = useState<'idle' | 'triggering' | 'conflict' | 'success' | 'error'>('idle');
  const [runError, setRunError] = useState('');
  const [showTriggerPopover, setShowTriggerPopover] = useState(false);

  // Add stories
  const [addState, setAddState] = useState<'idle' | 'form' | 'generating' | 'done' | 'error'>('idle');
  const [addCount, setAddCount] = useState(3);
  const [addBrief, setAddBrief] = useState('');
  const [addError, setAddError] = useState('');

  // Import
  const [importState, setImportState] = useState<'idle' | 'form' | 'loading' | 'preview' | 'importing' | 'done' | 'error'>('idle');
  const [importSource, setImportSource] = useState<'linear' | 'github'>('linear');
  const [importError, setImportError] = useState('');
  const [importPreviewStories, setImportPreviewStories] = useState<Array<{ id: string; title: string; description: string; sourceUrl: string; tags: string[] }>>([]);
  const [linearApiKey, setLinearApiKey] = useState('');
  const [linearTeamId, setLinearTeamId] = useState('');
  const [linearProjectId, setLinearProjectId] = useState('');
  const [importGithubToken, setImportGithubToken] = useState('');
  const [importGithubOwner, setImportGithubOwner] = useState('');
  const [importGithubRepo, setImportGithubRepo] = useState('');
  const [importGithubMilestone, setImportGithubMilestone] = useState('');

  // Fork / Delete / Publish
  const [forkState, setForkState] = useState<'idle' | 'forking' | 'done' | 'error'>('idle');
  const [forkError, setForkError] = useState('');
  const [forkId, setForkId] = useState('');
  const [deleteState, setDeleteState] = useState<'idle' | 'confirm' | 'deleting'>('idle');
  const [showPricing, setShowPricing] = useState(false);
  const [showPublishModal, setShowPublishModal] = useState(false);
  const [showPublishUpgrade, setShowPublishUpgrade] = useState(false);
  const [publicationId, setPublicationId] = useState<string | null>(null);
  const [publicationCheckDone, setPublicationCheckDone] = useState(false);

  // Approve/Reject state
  const [actionLoading, setActionLoading] = useState(false);

  // Fetch detail + summary
  useEffect(() => {
    if (!specId || !workspaceId) return;
    let cancelled = false;
    setDetailLoading(true);

    // Fetch full detail
    apiFetch<SpecDetail>(`/api/specs/${specId}?workspaceId=${workspaceId}`)
      .then(d => { if (!cancelled) setDetail(d); })
      .catch(() => { if (!cancelled) setDetail(null); })
      .finally(() => { if (!cancelled) setDetailLoading(false); });

    // If no initial summary, fetch from archive
    if (!initialSummary) {
      apiFetch<ArchiveResponse>(`/api/specs/archive?workspaceId=${workspaceId}&q=${encodeURIComponent(specId)}&limit=1`)
        .then(res => { if (!cancelled && res.items.length > 0) setSummary(res.items[0]); })
        .catch(() => { /* ignore */ });
    }

    return () => { cancelled = true; };
  }, [specId, workspaceId, initialSummary]);

  // Sync stories
  useEffect(() => { setLocalStories(detail?.userStories ?? detail?.stories ?? []); }, [detail]);

  // Check publication
  useEffect(() => {
    if (!specId || !workspaceId) return;
    setPublicationCheckDone(false);
    setPublicationId(null);
    apiFetch<{ published: boolean; publication: { id: string } | null }>(`/api/marketplace?spec_id=${encodeURIComponent(specId)}`)
      .then(res => { setPublicationId(res.published && res.publication ? res.publication.id : null); setPublicationCheckDone(true); })
      .catch(() => setPublicationCheckDone(true));
  }, [specId, workspaceId]);

  // Reset tab on spec change
  useEffect(() => { setActiveTab('stories'); }, [specId]);

  const handleApprove = async () => {
    if (!workspaceId) return;
    setActionLoading(true);
    try {
      await apiFetch(`/api/specs/${specId}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId }) });
      toast.show('Spec approved', 'success');
      setSummary(prev => prev ? { ...prev, status: 'approved' as SpecStatus } : prev);
    } catch (err: any) { toast.show(err?.message || 'Approve failed', 'error'); }
    finally { setActionLoading(false); }
  };

  const handleReject = async () => {
    if (!workspaceId) return;
    setActionLoading(true);
    try {
      await apiFetch(`/api/specs/${specId}/reject`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId }) });
      toast.show('Spec rejected', 'success');
      onClose();
    } catch (err: any) { toast.show(err?.message || 'Reject failed', 'error'); }
    finally { setActionLoading(false); }
  };

  const handleToggleExclude = async (storyId: string) => {
    if (!workspaceId) return;
    const story = localStories.find(s => s.id === storyId);
    if (!story) return;
    const newExcluded = !story.excluded;
    setLocalStories(prev => prev.map(s => s.id === storyId ? { ...s, excluded: newExcluded } : s));
    try {
      await apiFetch(`/api/specs/${specId}/stories/${storyId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId, excluded: newExcluded }) });
    } catch { setLocalStories(prev => prev.map(s => s.id === storyId ? { ...s, excluded: story.excluded } : s)); }
  };

  const handleRun = async (autoWorktree: boolean, options?: { forceSequential?: boolean }) => {
    if (!workspaceId || !summary) return;
    setShowTriggerPopover(false);
    setRunState('triggering');
    setRunError('');
    try {
      const res = await apiFetch<{ ok?: boolean; conflict?: boolean; activeRunId?: number; runId?: number }>(
        '/api/pipeline/trigger',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ specPath: `forge/specs/approved/${summary.id}.json`, workspaceId, autoWorktree, ...(options?.forceSequential ? { forceSequential: true } : {}) }) },
      );
      if (res.conflict) setRunState('conflict');
      else { setRunState('success'); setTimeout(() => { onClose(); onNavigate('pipeline'); }, 1200); }
    } catch (err) { setRunError(err instanceof Error ? err.message : 'Failed to trigger run'); setRunState('error'); }
  };

  const handleExportJson = () => {
    if (!detail) return;
    const blob = new Blob([JSON.stringify(detail, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${specId}.json`; a.click();
    URL.revokeObjectURL(url);
  };

  const handleDelete = async () => {
    if (!summary) return;
    setDeleteState('deleting');
    try {
      await apiFetch(`/api/specs/${summary.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId }) });
      toast.show(`Spec "${summary.specName}" deleted`, 'success');
      onClose();
    } catch { setDeleteState('idle'); toast.show('Failed to delete spec', 'error'); }
  };

  const handleFork = async () => {
    if (!workspaceId || !summary) return;
    setForkState('forking');
    setForkError('');
    try {
      const res = await apiFetch<{ ok: boolean; forkId: string }>(`/api/specs/${summary.id}/fork`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId }) });
      if (res.ok) { setForkId(res.forkId); setForkState('done'); setTimeout(() => setForkState('idle'), 3000); }
    } catch (err) { setForkError(err instanceof Error ? err.message : 'Failed to fork spec'); setForkState('error'); }
  };

  const handleAddStories = async () => {
    if (!workspaceId || !summary) return;
    setAddState('generating');
    setAddError('');
    try {
      const res = await apiFetch<{ ok: boolean; addedCount: number }>(`/api/specs/${summary.id}/add-stories`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId, count: addCount, brief: addBrief || undefined }) });
      if (res.ok) { setAddState('done'); setAddBrief(''); setTimeout(() => setAddState('idle'), 3000); }
    } catch (err) { setAddError(err instanceof Error ? err.message : 'Failed to generate stories'); setAddState('error'); }
  };

  const stories = localStories;
  const diagram = detail ? extractDiagramText(detail) : null;
  const deferredCount = stories.filter(s => s.excluded && !s.passes).length;
  const cfg = summary ? STATUS_CONFIG[summary.status] : null;

  const tabs: { id: PreviewTab; label: string; badge?: string; icon?: typeof History }[] = [
    { id: 'stories', label: 'Stories', badge: `${stories.length}` },
    { id: 'history', label: 'History', icon: History },
    { id: 'graph', label: 'Graph' },
    { id: 'diagram', label: 'Dependencies' },
    { id: 'json', label: 'Raw JSON' },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border shrink-0">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2 min-w-0">
            {cfg && (
              <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold rounded border shrink-0 ${cfg.className}`}>
                {cfg.label}
              </span>
            )}
            <h3 className="text-base font-mono font-semibold text-text truncate">
              {summary?.specName ?? specId}
            </h3>
          </div>
          <button onClick={onClose} aria-label="Close spec preview" className="p-1 rounded text-muted hover:text-text hover:bg-panel transition-colors shrink-0">
            <X size={16} />
          </button>
        </div>
        {summary && (
          <div className="flex items-center gap-3 text-xs text-muted">
            <span className="flex items-center gap-1"><Clock size={10} />{formatDate(summary.generatedAt)}</span>
            <span>{summary.storyCount} {summary.storyCount === 1 ? 'story' : 'stories'}</span>
          </div>
        )}
        {/* Approve/Reject for pending specs */}
        {summary?.status === 'pending' && (
          <div className="flex items-center gap-2 mt-2">
            <button onClick={handleApprove} disabled={actionLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-success/15 text-success border border-success/30 hover:bg-success/25 transition-colors disabled:opacity-50">
              {actionLoading ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Approve
            </button>
            <button onClick={handleReject} disabled={actionLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-error/15 text-error border border-error/30 hover:bg-error/25 transition-colors disabled:opacity-50">
              <X size={12} /> Reject
            </button>
          </div>
        )}
        {summary && workspaceId && (
          <div className="mt-2">
            <TagChips specId={specId} workspaceId={workspaceId} tags={summary.tags ?? []}
              onTagsChange={(newTags) => setSummary(prev => prev ? { ...prev, tags: newTags } : prev)} />
          </div>
        )}
      </div>

      {/* Content */}
      {summary?.status === 'rejected' ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center p-8">
            <XCircle size={48} className="text-error/30 mx-auto mb-3" />
            <p className="text-sm text-muted mb-1">This spec was rejected</p>
            {summary.rejectReason && <p className="text-xs text-error/70 mt-2">Reason: {summary.rejectReason}</p>}
          </div>
        </div>
      ) : detailLoading ? (
        <div className="flex-1 flex items-center justify-center text-muted text-sm">Loading spec...</div>
      ) : !detail ? (
        <div className="flex-1 flex items-center justify-center text-muted text-sm">Failed to load spec detail</div>
      ) : (
        <>
          {/* Tab strip */}
          <div role="tablist" className="flex border-b border-border shrink-0 overflow-x-auto">
            {tabs.map(tab => (
              <button key={tab.id} role="tab" aria-selected={activeTab === tab.id} onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 ${activeTab === tab.id ? 'text-text border-accent' : 'text-muted hover:text-text border-transparent'}`}>
                {tab.icon && <tab.icon size={12} />}
                {tab.label}
                {tab.badge && tab.badge !== '0' && <span className="ml-1 px-1.5 py-0.5 text-[10px] font-semibold rounded-full bg-accent/15 text-accent">{tab.badge}</span>}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div role="tabpanel" className="flex-1 overflow-y-auto">
            {activeTab === 'stories' && (
              <StoriesTabContent stories={stories} specId={specId} workspaceId={workspaceId ?? ''}
                onToggleExclude={summary?.status === 'approved' ? handleToggleExclude : undefined}
                onStoryUpdated={(updated) => setLocalStories(prev => prev.map(s => s.id === updated.id ? { ...s, ...updated } : s))} />
            )}
            {activeTab === 'history' && workspaceId && <SpecVersionHistory specId={specId} workspaceId={workspaceId} />}
            {activeTab === 'graph' && workspaceId && <DependencyGraph specId={specId} workspaceId={workspaceId} />}
            {activeTab === 'diagram' && <MermaidDiagram diagram={diagram} idPrefix="mermaid-detail" />}
            {activeTab === 'json' && <JsonTab spec={detail} specId={specId} />}
          </div>
        </>
      )}

      {/* Footer actions */}
      {detail && (
        <div className="px-4 py-3 border-t border-border shrink-0 bg-bg space-y-2">
          {/* Run in Pipeline */}
          {(summary?.status === 'approved' || summary?.status === 'completed') && (
            <div className="relative">
              {runState === 'conflict' ? (
                <div className="rounded border border-warning/30 bg-warning/10 p-3 space-y-2">
                  <p className="text-xs text-warning font-medium">Active run in progress. Run in a new worktree?</p>
                  <div className="flex gap-2">
                    <button onClick={() => handleRun(true)} className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded text-xs font-medium bg-accent text-white hover:opacity-90">
                      <GitBranch size={12} /> Run in worktree
                    </button>
                    <button onClick={() => setRunState('idle')} className="px-3 py-1.5 rounded text-xs font-medium bg-panel border border-border text-muted hover:text-text">Cancel</button>
                  </div>
                </div>
              ) : runState === 'success' ? (
                <div className="flex items-center justify-center gap-1.5 w-full py-2 rounded text-sm font-medium bg-success/15 text-success border border-success/30">
                  <Check size={14} /> Switching to Pipeline Monitor...
                </div>
              ) : (
                <>
                  {showTriggerPopover && !isFreePlan && (
                    <TriggerPopover loading={runState === 'triggering'} onTrigger={handleRun} onClose={() => setShowTriggerPopover(false)}
                      specPath={`forge/specs/approved/${summary!.id}.json`} workspaceId={workspaceId ?? undefined} />
                  )}
                  <button onClick={() => isFreePlan ? setShowPricing(true) : setShowTriggerPopover(true)} disabled={runState === 'triggering'}
                    className={`flex items-center justify-center gap-1.5 w-full py-2 rounded text-sm font-medium transition-opacity disabled:opacity-60 ${isFreePlan ? 'bg-amber-500/15 text-amber-600 border border-amber-500/30 hover:bg-amber-500/25' : 'bg-accent text-white hover:opacity-90'}`}>
                    {runState === 'triggering' ? <><Loader2 size={14} className="animate-spin" /> Starting run...</> : isFreePlan ? <><Play size={14} /> Upgrade to Run</> : <><Play size={14} /> Run in Pipeline{deferredCount > 0 && <span className="ml-1 px-1.5 py-0.5 text-[10px] font-semibold rounded-full bg-white/20">{deferredCount} deferred</span>}</>}
                  </button>
                </>
              )}
              {runState === 'error' && <p className="text-xs text-error mt-1">{runError}</p>}
            </div>
          )}

          {/* Add Stories */}
          {summary?.status === 'approved' && (
            <div>
              {addState === 'idle' && (
                <button onClick={() => setAddState('form')} className="flex items-center justify-center gap-1.5 w-full py-2 rounded text-sm font-medium bg-panel border border-border text-text hover:bg-accent/10 transition-colors">
                  <Plus size={14} /> Add More Stories
                </button>
              )}
              {addState === 'form' && (
                <div className="rounded border border-border bg-panel p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-muted shrink-0">Stories to add</label>
                    <input type="number" min={1} max={10} value={addCount} onChange={e => setAddCount(Math.min(10, Math.max(1, parseInt(e.target.value) || 1)))}
                      className="w-16 px-2 py-1 text-xs font-mono rounded border border-border bg-bg text-text text-center" />
                  </div>
                  <textarea placeholder="Optional: describe what to focus on..." value={addBrief} onChange={e => setAddBrief(e.target.value)} rows={2}
                    className="w-full px-2 py-1.5 text-xs rounded border border-border bg-bg text-text resize-none placeholder:text-muted" />
                  <div className="flex gap-2">
                    <button onClick={handleAddStories} className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded text-xs font-medium bg-accent text-white hover:opacity-90">
                      <Sparkles size={12} /> Generate
                    </button>
                    <button onClick={() => { setAddState('idle'); setAddBrief(''); }} className="px-3 py-1.5 rounded text-xs font-medium bg-panel border border-border text-muted hover:text-text">Cancel</button>
                  </div>
                </div>
              )}
              {addState === 'generating' && <div className="flex items-center justify-center gap-1.5 w-full py-2 rounded text-sm font-medium bg-panel border border-border text-muted"><Loader2 size={14} className="animate-spin" /> Generating stories...</div>}
              {addState === 'done' && <div className="flex items-center justify-center gap-1.5 w-full py-2 rounded text-sm font-medium bg-success/15 text-success border border-success/30"><Check size={14} /> Stories added</div>}
              {addState === 'error' && <p className="text-xs text-error">{addError}</p>}
            </div>
          )}

          {/* Export JSON */}
          <button onClick={handleExportJson} className="flex items-center justify-center gap-1.5 w-full py-2 rounded text-sm font-medium bg-panel border border-border text-text hover:bg-accent/10 transition-colors">
            <Download size={14} /> Export JSON
          </button>

          {/* Publish */}
          {(summary?.status === 'approved' || summary?.status === 'completed') && publicationCheckDone && (
            publicationId ? (
              <div className="flex items-center gap-2">
                <div className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded text-sm font-medium bg-success/15 text-success border border-success/30">
                  <Globe size={14} /> Published
                </div>
                <button onClick={async () => {
                  try { await apiFetch(`/api/marketplace/${publicationId}`, { method: 'DELETE' }); setPublicationId(null); toast.show('Unpublished', 'success'); }
                  catch { toast.show('Failed to unpublish', 'error'); }
                }} className="px-3 py-2 rounded text-xs font-medium bg-panel border border-border text-muted hover:text-error hover:border-error/50 transition-colors">Unpublish</button>
              </div>
            ) : (
              <button onClick={() => { if (isFreePlan) setShowPublishUpgrade(true); else setShowPublishModal(true); }}
                className="flex items-center justify-center gap-1.5 w-full py-2 rounded text-sm font-medium bg-panel border border-border text-text hover:bg-accent/10 transition-colors">
                <Globe size={14} /> Publish to Community {isFreePlan && <ProBadge />}
              </button>
            )
          )}

          {/* Fork */}
          {forkState === 'done' ? (
            <div className="flex items-center justify-center gap-1.5 w-full py-2 rounded text-sm font-medium bg-success/15 text-success border border-success/30"><Check size={14} /> Forked as {forkId}</div>
          ) : (
            <button onClick={handleFork} disabled={forkState === 'forking'} className="flex items-center justify-center gap-1.5 w-full py-2 rounded text-sm font-medium bg-panel border border-border text-text hover:bg-accent/10 disabled:opacity-60">
              {forkState === 'forking' ? <><Loader2 size={14} className="animate-spin" /> Forking...</> : <><GitFork size={14} /> Fork Spec</>}
            </button>
          )}
          {forkState === 'error' && <p className="text-xs text-error">{forkError}</p>}

          {/* Delete */}
          {deleteState === 'confirm' ? (
            <div className="rounded border border-error/30 bg-error/10 p-3 space-y-2">
              <p className="text-xs text-error font-medium">Delete this spec? This cannot be undone.</p>
              <div className="flex gap-2">
                <button onClick={handleDelete} className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded text-xs font-medium bg-error text-white hover:opacity-90"><Trash2 size={12} /> Yes, delete</button>
                <button onClick={() => setDeleteState('idle')} className="px-3 py-1.5 rounded text-xs font-medium bg-panel border border-border text-muted hover:text-text">Cancel</button>
              </div>
            </div>
          ) : (
            <button onClick={() => setDeleteState('confirm')} disabled={deleteState === 'deleting'}
              className="flex items-center justify-center gap-1.5 w-full py-2 rounded text-sm font-medium bg-panel border border-error/30 text-error hover:bg-error/10 disabled:opacity-60">
              {deleteState === 'deleting' ? <><Loader2 size={14} className="animate-spin" /> Deleting...</> : <><Trash2 size={14} /> Delete Spec</>}
            </button>
          )}
        </div>
      )}

      {showPricing && <PricingModal onClose={() => setShowPricing(false)} />}
      <UpgradePromptModal feature="marketplace_publish" featureName="Publish to Community"
        description="Share your specs with the community. Available on Pro and Team plans."
        open={showPublishUpgrade} onClose={() => setShowPublishUpgrade(false)}
        onUpgrade={() => { setShowPublishUpgrade(false); window.location.hash = '#billing'; }} />
      {showPublishModal && detail && workspaceId && (
        <PublishModal specId={specId} specName={summary?.specName ?? specId} workspaceId={workspaceId} specDetail={detail}
          onClose={() => setShowPublishModal(false)}
          onPublished={() => {
            apiFetch<{ published: boolean; publication: { id: string } | null }>(`/api/marketplace?spec_id=${encodeURIComponent(specId)}`)
              .then(res => setPublicationId(res.published && res.publication ? res.publication.id : null))
              .catch(() => {});
          }} />
      )}
    </div>
  );
}

/* ─── Stories Tab Content ──────────────────────────────────────────── */

function StoriesTabContent({ stories, specId, workspaceId, onToggleExclude, onStoryUpdated }: {
  stories: Story[];
  specId: string;
  workspaceId: string;
  onToggleExclude?: (storyId: string) => void;
  onStoryUpdated?: (story: Story) => void;
}) {
  const [editingStoryId, setEditingStoryId] = useState<string | null>(null);
  const [commentCounts, setCommentCounts] = useState<Record<string, number>>({});
  const [commentsOpenFor, setCommentsOpenFor] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ counts: Record<string, number> }>(`/api/specs/${specId}/comments/counts`)
      .then(data => setCommentCounts(data.counts)).catch(() => { });
  }, [specId]);

  if (stories.length === 0) {
    return <div className="flex items-center justify-center h-full text-muted text-sm">No stories found in this spec</div>;
  }

  const deferredCount = stories.filter(s => s.excluded && !s.passes).length;
  const allStoryIds = new Set(stories.map(s => s.id));

  return (
    <div className="p-4 space-y-2">
      <span className="text-xs text-muted">
        {stories.length} {stories.length === 1 ? 'story' : 'stories'}
        {deferredCount > 0 && <span className="ml-2 text-muted/60">· {deferredCount} deferred</span>}
      </span>
      {stories.map(story =>
        editingStoryId === story.id ? (
          <InlineStoryEditor key={story.id} story={story} specId={specId} workspaceId={workspaceId}
            onSave={(updated) => { onStoryUpdated?.(updated); setEditingStoryId(null); }}
            onCancel={() => setEditingStoryId(null)} />
        ) : (
          <div key={story.id}>
            <StoryCard story={story} allStoryIds={allStoryIds} onEdit={() => setEditingStoryId(story.id)}
              onToggleExclude={onToggleExclude ? () => onToggleExclude(story.id) : undefined}
              specId={specId} workspaceId={workspaceId}
              commentCount={commentCounts[story.id] ?? 0}
              onOpenComments={() => setCommentsOpenFor(commentsOpenFor === story.id ? null : story.id)} />
            {commentsOpenFor === story.id && (
              <StoryComments specId={specId} storyId={story.id} onClose={() => setCommentsOpenFor(null)}
                onCountChange={(count) => setCommentCounts(prev => { const next = { ...prev }; if (count > 0) next[story.id] = count; else delete next[story.id]; return next; })} />
            )}
          </div>
        )
      )}
    </div>
  );
}

/* ─── JSON Tab ─────────────────────────────────────────────────────── */

function JsonTab({ spec, specId }: { spec: SpecDetail; specId: string }) {
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
        <button onClick={handleCopy} className="absolute top-2 right-2 p-1.5 rounded bg-panel border border-border text-muted hover:text-text transition-colors z-10" title="Copy JSON">
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
        <pre className="p-4 text-xs font-mono bg-panel border border-border rounded overflow-x-auto text-text whitespace-pre max-h-[70vh] overflow-y-auto">
          {rawJson}
        </pre>
      </div>
    </div>
  );
}
