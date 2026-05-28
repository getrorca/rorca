/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/* @refresh reset */
import React, { useState, useEffect, useCallback, useRef, useMemo, memo } from 'react';
import { useDebounce } from '../hooks/useDebounce';
import { useLazyVisible } from '../hooks/useLazyVisible';
import {
  Search, X, Clock, CheckCircle2, XCircle, AlertCircle,
  Check, ChevronRight, ChevronLeft, Play, GitBranch, GitFork,
  Loader2, Plus, ExternalLink,
  FileText, File as FileIcon, FileType, Layers, Archive, Inbox, ArrowRight,
  RefreshCw, AlertTriangle, ChevronDown, LayoutGrid, List,
  GripVertical, Trash2, Palette, Pencil, AlignJustify,
  Sparkles,
  Paperclip,
} from 'lucide-react';
import { Github } from '../components/icons/GithubIcon';
import EmptyState from '../components/EmptyState';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { apiFetch, ApiError, BASE_URL } from '../lib/apiFetch';
import { useGlobalToast } from '../contexts/ToastContext';
import { useWalSSE } from '../hooks/useWalSSE';
import type { PanelId } from '../components/Sidebar';
import { TagChipsReadonly, TagChips } from '../components/TagChips';
import AppHeader from '../components/AppHeader';
import AgentBadge from '../components/AgentBadge';
import { SkeletonColumn } from '../components/skeletons';
import SlideOver from '../components/SlideOver';
import SpecDetailSlideOver from '../components/SpecDetailSlideOver';
import type { SpecSlideOverSummary, PreviewTab } from '../components/SpecDetailSlideOver';
import { relativeTime, REVIEW_STATUS_CONFIG } from '../components/SpecReviewInline';
import type { SpecSummary, ReviewStatus } from '../components/SpecReviewInline';
import SpecForgeProgress, { type SpecGenerationError } from '../components/SpecForgeProgress';
import SpecForgePreview from '../components/SpecForgePreview';
import TemplatePickerModal from '../components/TemplatePickerModal';
import { briefToSlug, KEBAB_RE } from '../lib/slugify';
import type { GeneratedSpec } from './SpecForgeOutput';
import AgentPicker, { type AgentType } from '../components/AgentPicker';
import ModelSearchSelect, { type ModelOption } from '../components/ModelSearchSelect';
import { useBoardNav, type BoardNavColumn } from '../hooks/useBoardNav';
import ContextSummaryCard from '../components/ContextSummaryCard';
import GitHubImportModal from '../components/GitHubImportModal';

/* ─── Types ───────────────────────────────────────────────────────── */

type ViewMode = 'board' | 'list';
type SpecStatus = 'pending' | 'approved' | 'rejected' | 'completed';
type StatusFilter = 'all' | SpecStatus;

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
  failedStories?: number;
  activeRunId?: number;
  activeRunStatus?: 'running' | 'queued';
  queuePosition?: number;
  triggeredVia?: 'queue' | 'run_now';
  isParallelRun?: boolean;
  model?: string;
  attachments?: import('../types').Attachment[];
  attachmentCount?: number;
  source?: string;
}

interface CustomColumnData {
  id: number;
  name: string;
  color: string;
  position: number;
  specs: KanbanSpec[];
}

interface KanbanResponse {
  draft: KanbanSpec[];
  inProgress: KanbanSpec[];
  done: KanbanSpec[];
  customColumns?: CustomColumnData[];
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
const COMPACT_MODE_KEY = 'rorca:specs:compactMode';
const COLLAPSE_KEY_PREFIX = 'rorca:specs:collapsed:';

/** Short model display name from full model string */
function modelShortName(model?: string): string | null {
  if (!model) return null;
  // "claude-sonnet-4-5-20250929" → "sonnet-4-5"
  // "claude-opus-4-6" → "opus-4-6"
  // "openai/gpt-4o" → "gpt-4o"
  const last = model.split('/').pop() ?? model;
  return last
    .replace(/^claude-/, '')
    .replace(/-\d{8,}$/, '');
}

/** Provider color class for model badge */
function modelColorClass(model?: string): string {
  if (!model) return 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30';
  const m = model.toLowerCase();
  if (m.includes('claude') || m.includes('anthropic') || m.includes('opus') || m.includes('sonnet') || m.includes('haiku'))
    return 'bg-purple-500/15 text-purple-400 border-purple-500/30';
  if (m.includes('openai') || m.includes('gpt') || m.includes('o3') || m.includes('o1'))
    return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30';
  if (m.includes('google') || m.includes('gemini'))
    return 'bg-blue-500/15 text-blue-400 border-blue-500/30';
  return 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30';
}

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

const SYSTEM_COLUMNS = [
  { key: 'draft' as const, label: 'Draft', icon: FileText, emptyMessage: 'No draft specs', accentClass: 'bg-muted/15 text-muted', iconClass: 'text-muted', headerBg: '', color: '#71717a', system: true },
  { key: 'in-progress' as const, label: 'In Progress', icon: Play, emptyMessage: 'No specs in progress', accentClass: 'bg-accent/15 text-accent', iconClass: 'text-accent', headerBg: '', color: '#4f46e5', system: true },
  { key: 'done' as const, label: 'Done', icon: CheckCircle2, emptyMessage: 'No completed specs', accentClass: 'bg-success/15 text-success', iconClass: 'text-success', headerBg: '', color: '#10b981', system: true },
];

// Legacy compat reference (used by keyboard nav and some helpers)
const BOARD_COLUMNS = SYSTEM_COLUMNS;

const COLUMN_COLORS: { name: string; hex: string }[] = [
  { name: 'indigo', hex: '#6366f1' },
  { name: 'blue', hex: '#3b82f6' },
  { name: 'cyan', hex: '#06b6d4' },
  { name: 'teal', hex: '#14b8a6' },
  { name: 'emerald', hex: '#10b981' },
  { name: 'green', hex: '#22c55e' },
  { name: 'lime', hex: '#84cc16' },
  { name: 'yellow', hex: '#eab308' },
  { name: 'amber', hex: '#f59e0b' },
  { name: 'orange', hex: '#f97316' },
  { name: 'red', hex: '#ef4444' },
  { name: 'pink', hex: '#ec4899' },
];

const MAX_CUSTOM_COLUMNS = 8;

function colorHex(name: string): string {
  return COLUMN_COLORS.find(c => c.name === name)?.hex ?? '#6366f1';
}

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

/** Board card wrapper that uses IntersectionObserver to defer rendering of off-screen cards. */
function LazyBoardCard({ children, height }: { children: React.ReactNode; height: number }) {
  const [ref, visible] = useLazyVisible<HTMLDivElement>();
  return (
    <div ref={ref} style={visible ? undefined : { minHeight: height }}>
      {visible ? children : null}
    </div>
  );
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

/* ─── Main Component ──────────────────────────────────────────────── */

interface SpecsPanelProps {
  onNavigate: (panel: PanelId) => void;
  onNavigateToRun?: (runId: number) => void;
  onNavigateToSpecReview?: (specId: string) => void;
  initialBrief?: string | null;
  onBriefConsumed?: () => void;
  initialView?: ViewMode;
}

export default function SpecsPanel({ onNavigate, onNavigateToRun, onNavigateToSpecReview, initialBrief, onBriefConsumed, initialView }: SpecsPanelProps) {
  const { workspaceId } = useWorkspace();
  const toast = useGlobalToast();

  // View mode: board or list (persisted in localStorage)
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    if (initialView) return initialView;
    try { return (localStorage.getItem(VIEW_MODE_KEY) as ViewMode) || 'board'; } catch { return 'board'; }
  });

  // New Spec slide-over
  const [showNewSpec, setShowNewSpec] = useState(false);

  // GitHub Import modal
  const [showGitHubImport, setShowGitHubImport] = useState(false);
  const [githubConnected, setGithubConnected] = useState(false);

  // Spec detail slide-over
  const [detailSpecId, setDetailSpecId] = useState<string | null>(null);
  const [detailSpecSummary, setDetailSpecSummary] = useState<ArchiveSpec | null>(null);
  const [detailInitialTab, setDetailInitialTab] = useState<PreviewTab | undefined>(undefined);

  // Persist view mode
  useEffect(() => {
    try { localStorage.setItem(VIEW_MODE_KEY, viewMode); } catch { /* quota */ }
  }, [viewMode]);

  // Check GitHub connection status for Import button visibility
  useEffect(() => {
    if (!workspaceId) return;
    apiFetch<{ connected: boolean }>(`/api/workspaces/${workspaceId}/github`, { silent: true })
      .then(data => setGithubConnected(data.connected))
      .catch(() => setGithubConnected(false));
  }, [workspaceId]);

  // Apply initialBrief from command palette
  useEffect(() => {
    if (initialBrief != null) {
      setShowNewSpec(true);
      onBriefConsumed?.();
    }
  }, [initialBrief, onBriefConsumed]);

  const handleSpecClick = useCallback((specId: string, summary?: ArchiveSpec, initialTab?: PreviewTab) => {
    setDetailSpecId(specId);
    setDetailSpecSummary(summary ?? null);
    setDetailInitialTab(initialTab);
  }, []);

  const handleDetailClose = useCallback(() => {
    setDetailSpecId(null);
    setDetailSpecSummary(null);
    setDetailInitialTab(undefined);
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
      <h1 className="sr-only">Specs</h1>
      {/* Header */}
      <AppHeader
        breadcrumbs={
          <div className="flex items-center gap-2">
            <span className="font-medium text-[var(--text)] text-sm tracking-tight">Specs</span>
          </div>
        }
        actions={
          <div className="flex items-center gap-2">
            {/* View mode toggle: Board | List */}
            <div className="flex bg-panel rounded-lg border border-border p-0.5">
              <button
                onClick={() => setViewMode('board')}
                aria-current={viewMode === 'board' ? 'page' : undefined}
                title="Board view"
                className={`flex items-center gap-1 px-2 py-1.5 rounded-md text-xs font-medium transition-colors ${viewMode === 'board' ? 'bg-accent text-white shadow-sm' : 'text-muted hover:text-[var(--text)]'}`}
              >
                <LayoutGrid size={13} />
                <span className="hidden sm:inline">Board</span>
              </button>
              <button
                onClick={() => setViewMode('list')}
                aria-current={viewMode === 'list' ? 'page' : undefined}
                title="List view"
                className={`flex items-center gap-1 px-2 py-1.5 rounded-md text-xs font-medium transition-colors ${viewMode === 'list' ? 'bg-accent text-white shadow-sm' : 'text-muted hover:text-[var(--text)]'}`}
              >
                <List size={13} />
                <span className="hidden sm:inline">List</span>
              </button>
            </div>

            {/* Import from GitHub button — only shown when GitHub is connected */}
            {githubConnected && (
              <button
                onClick={() => setShowGitHubImport(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-surface border border-border hover:bg-panel transition-colors text-[var(--text)]"
                title="Import issues from GitHub as spec stories"
              >
                <Github size={14} />
                <span className="hidden sm:inline">Import from GitHub</span>
              </button>
            )}

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
            onNewSpec={() => setShowNewSpec(true)}
          />
        ) : (
          <ListView
            workspaceId={workspaceId}
            onSpecClick={handleSpecClick}
            onNavigate={onNavigate}
            onNewSpec={() => setShowNewSpec(true)}
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
      <SpecDetailSlideOver
        isOpen={detailSpecId !== null}
        specId={detailSpecId}
        initialSummary={detailSpecSummary as SpecSlideOverSummary | null}
        initialTab={detailInitialTab}
        onClose={handleDetailClose}
        onNavigate={onNavigate}
        onNavigateToRun={onNavigateToRun}
        onDeleted={(id) => { handleDetailClose(); }}
      />

      {/* GitHub Import Modal */}
      <GitHubImportModal
        isOpen={showGitHubImport}
        onClose={() => setShowGitHubImport(false)}
        onSpecCreated={(specId) => {
          setShowGitHubImport(false);
          handleSpecClick(specId);
        }}
      />
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════
   BOARD VIEW — Kanban columns (Draft, In Progress, [Custom...], Done)
   ════════════════════════════════════════════════════════════════════ */

/* ─── Add Column Popover ─── */
function AddColumnPopover({ onAdd, disabled }: { onAdd: (name: string, color: string) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState('indigo');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleSubmit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onAdd(trimmed, color);
    setName('');
    setColor('indigo');
    setOpen(false);
  };

  return (
    <div className="relative shrink-0 flex items-stretch" ref={ref}>
      <button
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        title={disabled ? 'Maximum 8 columns reached' : 'Add custom column'}
        aria-label={disabled ? 'Maximum 8 columns reached' : 'Add custom column'}
        className={`flex items-center justify-center w-10 border-l border-border transition-colors
          ${disabled ? 'text-muted/30 cursor-not-allowed' : 'text-muted hover:text-accent hover:bg-surface-100/30 cursor-pointer'}`}
      >
        <Plus size={16} aria-hidden="true" />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 z-50 w-64 bg-panel border border-border rounded-lg shadow-xl p-3 space-y-3">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); if (e.key === 'Escape') setOpen(false); }}
            placeholder="Column name..."
            aria-label="Column name"
            className="w-full px-3 py-1.5 rounded-md border border-border bg-bg text-sm text-[var(--text)] placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/50"
          />
          <div className="grid grid-cols-6 gap-1.5">
            {COLUMN_COLORS.map((c) => (
              <button
                key={c.name}
                onClick={() => setColor(c.name)}
                className={`w-7 h-7 rounded-md transition-all ${color === c.name ? 'ring-2 ring-offset-1 ring-offset-bg scale-110' : 'hover:scale-105'}`}
                style={{ backgroundColor: c.hex, ...(color === c.name ? { boxShadow: `0 0 0 2px ${c.hex}` } : {}) }}
                title={c.name}
                aria-label={`Color: ${c.name}${color === c.name ? ' (selected)' : ''}`}
              />
            ))}
          </div>
          <button
            onClick={handleSubmit}
            disabled={!name.trim()}
            className="w-full py-1.5 rounded-md text-sm font-medium text-white transition-colors disabled:opacity-40"
            style={{ backgroundColor: colorHex(color) }}
          >
            Add
          </button>
        </div>
      )}
    </div>
  );
}

/* ─── Color Picker Popover (for existing columns) ─── */
function ColorPickerPopover({ currentColor, onChange }: { currentColor: string; onChange: (color: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        className="p-1 rounded hover:bg-surface-100/50 transition-colors"
        title="Change color"
      >
        <div className="w-3 h-3 rounded-full" style={{ backgroundColor: colorHex(currentColor) }} />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 z-50 bg-panel border border-border rounded-lg shadow-xl p-2"
          onClick={(e) => e.stopPropagation()}>
          <div className="grid grid-cols-6 gap-1.5">
            {COLUMN_COLORS.map((c) => (
              <button
                key={c.name}
                onClick={() => { onChange(c.name); setOpen(false); }}
                className={`w-6 h-6 rounded-md transition-all ${currentColor === c.name ? 'ring-2 ring-offset-1 ring-offset-bg scale-110' : 'hover:scale-105'}`}
                style={{ backgroundColor: c.hex }}
                title={c.name}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Delete Column Confirmation ─── */
function DeleteColumnDialog({ columnName, specCount, onConfirm, onCancel }: {
  columnName: string; specCount: number; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50" onClick={onCancel}>
      <div className="bg-panel border border-border rounded-xl shadow-2xl p-5 w-[380px] space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <AlertTriangle size={20} className="text-warning" />
          <h3 className="text-sm font-semibold text-[var(--text)]">Delete "{columnName}"?</h3>
        </div>
        <p className="text-sm text-muted">
          {specCount > 0
            ? `${specCount} spec${specCount === 1 ? '' : 's'} will be moved back to In Progress.`
            : 'This column is empty.'}
        </p>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="px-3 py-1.5 rounded-md text-sm text-muted hover:text-[var(--text)] transition-colors">Cancel</button>
          <button onClick={onConfirm} className="px-3 py-1.5 rounded-md text-sm font-medium bg-error/15 text-error border border-error/30 hover:bg-error/25 transition-colors">Delete</button>
        </div>
      </div>
    </div>
  );
}

function BoardView({ workspaceId, onSpecClick, onNavigate, onNewSpec }: {
  workspaceId: string;
  onSpecClick: (specId: string, summary?: ArchiveSpec, initialTab?: PreviewTab) => void;
  onNavigate: (panel: PanelId) => void;
  onNewSpec?: () => void;
}) {
  const toast = useGlobalToast();
  const [kanban, setKanban] = useState<KanbanResponse>({ draft: [], inProgress: [], done: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const hasLoadedOnce = useRef(false);
  const [actionLoadingMap, setActionLoadingMap] = useState<Record<string, 'approve' | 'deny' | null>>({});
  const [activeRunSpecs, setActiveRunSpecs] = useState<Map<string, 'running' | 'queued'>>(new Map());
  const sseFetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Drag state — refs for performance (no re-renders during drag)
  const dragSpecIdRef = useRef<string | null>(null);
  const dragFromColumnRef = useRef<string | null>(null);
  const dragOverColumnRef = useRef<string | null>(null);
  const dragOverCardRef = useRef<{ specId: string; position: 'before' | 'after' } | null>(null);
  const dragLeaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragGhostRef = useRef<HTMLDivElement | null>(null);
  const [dragRenderKey, setDragRenderKey] = useState(0);
  // Column header drag state
  const dragColumnIdRef = useRef<number | null>(null);
  const dragColumnOverIdRef = useRef<number | null>(null);
  // Touch drag refs
  const touchDragTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchDragActiveRef = useRef(false);
  const touchStartPosRef = useRef<{ x: number; y: number } | null>(null);
  const touchCloneRef = useRef<HTMLDivElement | null>(null);
  // Keyboard focus tracking
  const focusedCardRef = useRef<{ specId: string; columnKey: string } | null>(null);
  // Optimistic kanban state for rollback
  const [optimisticKanban, setOptimisticKanban] = useState<KanbanResponse | null>(null);
  const effectiveKanban = optimisticKanban ?? kanban;

  // Compact mode — reduce cards to title-only single line
  const [compactMode, setCompactMode] = useState(() => {
    try { return localStorage.getItem(COMPACT_MODE_KEY) === 'true'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(COMPACT_MODE_KEY, String(compactMode)); } catch { /* quota */ }
  }, [compactMode]);

  // Custom column management state
  const [editingColumnId, setEditingColumnId] = useState<number | null>(null);
  const [editingColumnName, setEditingColumnName] = useState('');
  const [deleteDialog, setDeleteDialog] = useState<{ id: number; name: string; specCount: number } | null>(null);

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
      // Sync active run statuses from kanban response
      const runStatuses = new Map<string, 'running' | 'queued'>();
      for (const spec of res.inProgress) {
        if (spec.activeRunId) runStatuses.set(spec.id, spec.activeRunStatus ?? 'running');
      }
      setActiveRunSpecs(runStatuses);
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
    clearTimeout(sseFetchTimer.current ?? undefined);
    sseFetchTimer.current = setTimeout(() => fetchKanban(), 300);
  }, [fetchKanban]);

  useEffect(() => () => clearTimeout(sseFetchTimer.current ?? undefined), []);

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
    const KANBAN_EVENTS = ['spec_approved', 'run_started', 'run_finished', 'run_queued_promoted', 'spec_rejected', 'story_passed', 'story_failed', 'spec_discovered', 'spec_updated'];
    if (!KANBAN_EVENTS.includes(event.event_type)) return;
    if (event.event_type === 'run_started' && event.spec_id) {
      setActiveRunSpecs((prev) => new Map(prev).set(event.spec_id!, 'running'));
    }
    if (event.event_type === 'run_finished' && event.spec_id) {
      setActiveRunSpecs((prev) => { const next = new Map(prev); next.delete(event.spec_id!); return next; });
    }
    debouncedFetchKanban();
  });

  // ─── Custom column CRUD ───
  const handleAddColumn = useCallback(async (name: string, color: string) => {
    try {
      await apiFetch('/api/specs/kanban/columns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, name, color }),
      });
      toast.show(`Column "${name}" added`, 'success');
      fetchKanban();
    } catch (err: any) {
      toast.show(err?.message || 'Failed to add column', 'error');
    }
  }, [workspaceId, fetchKanban, toast]);

  const handleRenameColumn = useCallback(async (colId: number, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) { setEditingColumnId(null); return; }
    try {
      await apiFetch(`/api/specs/kanban/columns/${colId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      fetchKanban();
    } catch (err: any) {
      toast.show(err?.message || 'Failed to rename column', 'error');
    } finally {
      setEditingColumnId(null);
    }
  }, [fetchKanban, toast]);

  const handleChangeColor = useCallback(async (colId: number, color: string) => {
    try {
      await apiFetch(`/api/specs/kanban/columns/${colId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ color }),
      });
      fetchKanban();
    } catch (err: any) {
      toast.show(err?.message || 'Failed to change color', 'error');
    }
  }, [fetchKanban, toast]);

  const handleDeleteColumn = useCallback(async (colId: number) => {
    try {
      await apiFetch(`/api/specs/kanban/columns/${colId}`, { method: 'DELETE' });
      toast.show('Column deleted', 'success');
      fetchKanban();
    } catch (err: any) {
      toast.show(err?.message || 'Failed to delete column', 'error');
    } finally {
      setDeleteDialog(null);
    }
  }, [fetchKanban, toast]);

  const handleReorderColumn = useCallback(async (colId: number, newPosition: number) => {
    try {
      await apiFetch(`/api/specs/kanban/columns/${colId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ position: newPosition }),
      });
      fetchKanban();
    } catch (err: any) {
      toast.show(err?.message || 'Failed to reorder column', 'error');
    }
  }, [fetchKanban, toast]);

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

  // Within-column reorder (client-side only, no backend persistence)
  const reorderWithinColumn = useCallback((specId: string, columnKey: string, dropTarget: { specId: string; position: 'before' | 'after' } | null) => {
    if (!dropTarget || dropTarget.specId === specId) return;
    const colKey = columnKey === 'in-progress' ? 'inProgress' : columnKey as 'draft' | 'done';
    const base = effectiveKanban;
    let specs = [...(base[colKey] as KanbanSpec[])];
    const fromIdx = specs.findIndex(s => s.id === specId);
    if (fromIdx === -1) return;
    const [card] = specs.splice(fromIdx, 1);
    let toIdx = specs.findIndex(s => s.id === dropTarget.specId);
    if (toIdx === -1) return;
    if (dropTarget.position === 'after') toIdx++;
    specs.splice(toIdx, 0, card);
    const optimistic: KanbanResponse = { ...base, customColumns: base.customColumns ? [...base.customColumns] : [] };
    (optimistic[colKey] as KanbanSpec[]) = specs;
    setKanban(optimistic);
  }, [effectiveKanban]);

  // Execute card drop transition (source→target) with optimistic UI
  const executeMove = useCallback(async (specId: string, sourceColumn: string, targetColumn: string) => {
    // Within-column reorder
    if (sourceColumn === targetColumn) {
      reorderWithinColumn(specId, sourceColumn, dragOverCardRef.current);
      return;
    }

    // Handle custom column assignments
    const isCustomSource = sourceColumn.startsWith('custom-');
    const isCustomTarget = targetColumn.startsWith('custom-');

    if (isCustomSource || isCustomTarget) {
      // Unmark done if coming from done
      if (sourceColumn === 'done') {
        await apiFetch(`/api/specs/${encodeURIComponent(specId)}/unmark-done`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId }),
        });
      }
      // Mark done if going to done (custom-to-done not typical but handle anyway)
      const targetColumnId = isCustomTarget ? Number(targetColumn.replace('custom-', '')) : null;
      try {
        await apiFetch('/api/specs/kanban/columns/assign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId, specId, columnId: targetColumnId }),
        });
        fetchKanban();
      } catch (err: any) {
        toast.show(err?.message || 'Move failed', 'error');
      }
      return;
    }

    // System column moves
    const sourceKey = sourceColumn === 'in-progress' ? 'inProgress' : sourceColumn as 'draft' | 'done';
    const targetKey = targetColumn === 'in-progress' ? 'inProgress' : targetColumn as 'draft' | 'done';
    const base = effectiveKanban;
    const spec = (base[sourceKey] as KanbanSpec[]).find(s => s.id === specId);
    if (!spec) return;

    // Optimistic update
    const optimistic: KanbanResponse = {
      draft: [...base.draft],
      inProgress: [...base.inProgress],
      done: [...base.done],
      customColumns: base.customColumns ? [...base.customColumns] : [],
    };
    (optimistic[sourceKey] as KanbanSpec[]) = (optimistic[sourceKey] as KanbanSpec[]).filter(s => s.id !== specId);
    (optimistic[targetKey] as KanbanSpec[]) = [...(optimistic[targetKey] as KanbanSpec[]), spec];
    setOptimisticKanban(optimistic);

    const specTitle = slugToTitle(specId);

    try {
      if (targetColumn === 'done') {
        // Any → Done: approve if in draft first, then mark done
        if (sourceColumn === 'draft') {
          await apiFetch(`/api/specs/${encodeURIComponent(specId)}/approve`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId }),
          });
        }
        await apiFetch(`/api/specs/${encodeURIComponent(specId)}/mark-done`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId }),
        });
        toast.show(`Spec "${specTitle}" marked done`, 'success');
      } else if (sourceColumn === 'done') {
        // Done → any: unmark done first
        await apiFetch(`/api/specs/${encodeURIComponent(specId)}/unmark-done`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId }),
        });
        if (targetColumn === 'draft') {
          await apiFetch(`/api/specs/${encodeURIComponent(specId)}/reject`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId }),
          });
          toast.show(`Spec "${specTitle}" moved to Draft`, 'success');
        } else {
          toast.show(`Spec "${specTitle}" reopened`, 'success');
        }
      } else if (sourceColumn === 'draft' && targetColumn === 'in-progress') {
        await apiFetch(`/api/specs/${encodeURIComponent(specId)}/approve`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId }),
        });
        toast.show(`Spec "${specTitle}" approved`, 'success');
      } else if (sourceColumn === 'in-progress' && targetColumn === 'draft') {
        await apiFetch(`/api/specs/${encodeURIComponent(specId)}/reject`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId }),
        });
        toast.show(`Spec "${specTitle}" moved back to Draft`, 'success');
      }
      announce(`Moved ${specTitle}`);
      fetchKanban();
    } catch (err: any) {
      toast.show(err?.message || 'Move failed — reverted', 'error');
      setOptimisticKanban(null);
    }
  }, [effectiveKanban, workspaceId, toast, fetchKanban, announce, reorderWithinColumn]);

  // Clean up ghost element
  const cleanupGhost = useCallback(() => {
    if (dragGhostRef.current) {
      document.body.removeChild(dragGhostRef.current);
      dragGhostRef.current = null;
    }
  }, []);

  // Card drag handlers (HTML5 API)
  const handleDragStart = useCallback((e: React.DragEvent, specId: string, columnKey: string, colColor: string) => {
    dragSpecIdRef.current = specId;
    dragFromColumnRef.current = columnKey;

    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', specId);

    const ghost = document.createElement('div');
    ghost.style.cssText = `position:fixed;top:-9999px;left:-9999px;padding:8px 14px;border-radius:8px;background:var(--surface-200);color:var(--text);font-size:13px;font-weight:600;border-left:3px solid ${colColor};box-shadow:0 4px 16px rgba(0,0,0,0.3);white-space:nowrap;pointer-events:none;z-index:99999;`;
    ghost.textContent = slugToTitle(specId);
    document.body.appendChild(ghost);
    dragGhostRef.current = ghost;
    e.dataTransfer.setDragImage(ghost, 10, 10);

    const target = e.currentTarget as HTMLElement;
    requestAnimationFrame(() => { target.style.opacity = '0.5'; target.style.transform = 'scale(0.98)'; });
    setDragRenderKey(k => k + 1);
  }, []);

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    (e.currentTarget as HTMLElement).style.opacity = '';
    (e.currentTarget as HTMLElement).style.transform = '';
    dragSpecIdRef.current = null;
    dragFromColumnRef.current = null;
    dragOverColumnRef.current = null;
    dragOverCardRef.current = null;
    // Remove all drop indicators
    document.querySelectorAll('[data-drop-indicator]').forEach(el => el.remove());
    clearTimeout(dragLeaveTimerRef.current ?? undefined);
    cleanupGhost();
    setDragRenderKey(k => k + 1);
  }, [cleanupGhost]);

  // Card-level dragOver — detect top/bottom half for within-column reorder
  const handleCardDragOver = useCallback((e: React.DragEvent, specId: string) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (dragSpecIdRef.current === specId) return; // hovering over self

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const position: 'before' | 'after' = e.clientY < midY ? 'before' : 'after';
    dragOverCardRef.current = { specId, position };

    // Show visual drop indicator line
    const el = e.currentTarget as HTMLElement;
    const parent = el.parentElement;
    if (!parent) return;
    // Remove old indicators
    parent.querySelectorAll('[data-drop-indicator]').forEach(ind => ind.remove());
    const indicator = document.createElement('div');
    indicator.setAttribute('data-drop-indicator', 'true');
    indicator.style.cssText = 'height:2px;background:var(--accent,#6366f1);border-radius:1px;margin:2px 0;pointer-events:none;';
    if (position === 'before') {
      el.parentElement?.insertBefore(indicator, el);
    } else {
      el.parentElement?.insertBefore(indicator, el.nextSibling);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, columnKey: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearTimeout(dragLeaveTimerRef.current ?? undefined);
    if (dragOverColumnRef.current !== columnKey) {
      dragOverColumnRef.current = columnKey;
      setDragRenderKey(k => k + 1);
    }
  }, []);

  const handleDragLeave = useCallback(() => {
    clearTimeout(dragLeaveTimerRef.current ?? undefined);
    dragLeaveTimerRef.current = setTimeout(() => {
      dragOverColumnRef.current = null;
      setDragRenderKey(k => k + 1);
    }, 50);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent, targetColumn: string) => {
    e.preventDefault();
    clearTimeout(dragLeaveTimerRef.current ?? undefined);
    // Clean up drop indicators
    document.querySelectorAll('[data-drop-indicator]').forEach(el => el.remove());

    // Check if this is a column header reorder
    if (dragColumnIdRef.current !== null) {
      const fromColId = dragColumnIdRef.current;
      dragColumnIdRef.current = null;
      dragColumnOverIdRef.current = null;
      setDragRenderKey(k => k + 1);

      // Target must be a custom column key like "custom-123"
      if (targetColumn.startsWith('custom-')) {
        const customCols = effectiveKanban.customColumns || [];
        const targetIdx = customCols.findIndex(c => `custom-${c.id}` === targetColumn);
        if (targetIdx !== -1) {
          handleReorderColumn(fromColId, targetIdx);
        }
      }
      return;
    }

    const specId = dragSpecIdRef.current;
    const sourceColumn = dragFromColumnRef.current;
    dragSpecIdRef.current = null;
    dragFromColumnRef.current = null;
    dragOverColumnRef.current = null;
    cleanupGhost();
    setDragRenderKey(k => k + 1);

    if (!specId || !sourceColumn || !workspaceId) return;
    await executeMove(specId, sourceColumn, targetColumn);
  }, [workspaceId, executeMove, cleanupGhost, effectiveKanban, handleReorderColumn]);

  // Column header drag handlers
  const handleColumnDragStart = useCallback((e: React.DragEvent, colId: number, colName: string, colColor: string) => {
    e.stopPropagation();
    dragColumnIdRef.current = colId;

    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', `col-${colId}`);

    const ghost = document.createElement('div');
    ghost.style.cssText = `position:fixed;top:-9999px;left:-9999px;padding:6px 12px;border-radius:6px;background:var(--surface-200);color:var(--text);font-size:12px;font-weight:600;border-left:3px solid ${colColor};box-shadow:0 4px 16px rgba(0,0,0,0.3);pointer-events:none;z-index:99999;`;
    ghost.textContent = colName;
    document.body.appendChild(ghost);
    dragGhostRef.current = ghost;
    e.dataTransfer.setDragImage(ghost, 10, 10);

    setDragRenderKey(k => k + 1);
  }, []);

  const handleColumnDragEnd = useCallback(() => {
    dragColumnIdRef.current = null;
    dragColumnOverIdRef.current = null;
    cleanupGhost();
    setDragRenderKey(k => k + 1);
  }, [cleanupGhost]);

  // Touch drag handlers
  const handleTouchStart = useCallback((e: React.TouchEvent, specId: string, columnKey: string, colColor: string) => {
    const touch = e.touches[0];
    touchStartPosRef.current = { x: touch.clientX, y: touch.clientY };
    touchDragActiveRef.current = false;

    touchDragTimerRef.current = setTimeout(() => {
      touchDragActiveRef.current = true;
      dragSpecIdRef.current = specId;
      dragFromColumnRef.current = columnKey;

      // Vibration feedback for touch drag initiation
      if (navigator.vibrate) navigator.vibrate(30);

      const target = e.currentTarget as HTMLElement;
      const rect = target.getBoundingClientRect();
      const clone = document.createElement('div');
      clone.style.cssText = `position:fixed;top:${rect.top}px;left:${rect.left}px;width:${rect.width}px;padding:8px 14px;border-radius:8px;background:var(--surface-200);color:var(--text);font-size:13px;font-weight:600;border-left:3px solid ${colColor};box-shadow:0 8px 24px rgba(0,0,0,0.4);pointer-events:none;z-index:99999;opacity:0.9;`;
      clone.textContent = slugToTitle(specId);
      document.body.appendChild(clone);
      touchCloneRef.current = clone;

      target.style.opacity = '0.5';
      setDragRenderKey(k => k + 1);
    }, 300);
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!touchDragActiveRef.current) {
      if (touchStartPosRef.current) {
        const touch = e.touches[0];
        const dx = touch.clientX - touchStartPosRef.current.x;
        const dy = touch.clientY - touchStartPosRef.current.y;
        if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
          clearTimeout(touchDragTimerRef.current ?? undefined);
        }
      }
      return;
    }
    e.preventDefault();
    const touch = e.touches[0];
    if (touchCloneRef.current) {
      touchCloneRef.current.style.top = `${touch.clientY - 20}px`;
      touchCloneRef.current.style.left = `${touch.clientX - 20}px`;
    }
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
    clearTimeout(touchDragTimerRef.current ?? undefined);
    (e.currentTarget as HTMLElement).style.opacity = '';
    if (touchDragActiveRef.current && dragSpecIdRef.current && dragFromColumnRef.current) {
      const specId = dragSpecIdRef.current;
      const sourceColumn = dragFromColumnRef.current;
      const targetColumn = dragOverColumnRef.current;
      dragSpecIdRef.current = null;
      dragFromColumnRef.current = null;
      dragOverColumnRef.current = null;
      touchDragActiveRef.current = false;
      if (touchCloneRef.current) { document.body.removeChild(touchCloneRef.current); touchCloneRef.current = null; }
      setDragRenderKey(k => k + 1);
      if (targetColumn && targetColumn !== sourceColumn && workspaceId) {
        executeMove(specId, sourceColumn, targetColumn);
      }
    } else {
      touchDragActiveRef.current = false;
      if (touchCloneRef.current) { document.body.removeChild(touchCloneRef.current); touchCloneRef.current = null; }
    }
  }, [workspaceId, executeMove]);

  // Helper: find kanban spec by ID and build summary for the slide-over
  const findAndOpenSpec = useCallback((specId: string, columnKey?: string, initialTab?: PreviewTab) => {
    // Determine status from column key
    const colKey = columnKey || (() => {
      if (effectiveKanban.draft.some(s => s.id === specId)) return 'draft';
      if (effectiveKanban.inProgress.some(s => s.id === specId)) return 'in-progress';
      if (effectiveKanban.done.some(s => s.id === specId)) return 'done';
      return undefined;
    })();
    const allSpecs = [...effectiveKanban.draft, ...effectiveKanban.inProgress, ...effectiveKanban.done,
      ...(effectiveKanban.customColumns?.flatMap(c => c.specs) || [])];
    const spec = allSpecs.find(s => s.id === specId);
    if (spec && colKey) {
      const status = colKey === 'draft' ? 'pending' : colKey === 'done' ? 'completed' : 'approved';
      onSpecClick(specId, {
        id: spec.id,
        specName: spec.title || slugToTitle(spec.id),
        storyCount: spec.storyCount,
        status: status as SpecStatus,
        generatedAt: spec.generatedAt,
        approvedAt: spec.approvedAt,
        tags: spec.tags || [],
        storyTitles: spec.storyTitles || [],
        reviewStatus: spec.reviewStatus as ArchiveSpec['reviewStatus'],
      }, initialTab);
    } else {
      onSpecClick(specId, undefined, initialTab);
    }
  }, [effectiveKanban, onSpecClick]);

  // Keyboard card movement
  const handleCardKeyDown = useCallback((e: React.KeyboardEvent, specId: string, columnKey: string) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); findAndOpenSpec(specId, columnKey); return; }
    if (!e.ctrlKey && !e.metaKey) return;

    // Build full column key list for keyboard nav
    const customCols = effectiveKanban.customColumns || [];
    const allKeys = ['draft', 'in-progress', ...customCols.map(c => `custom-${c.id}`), 'done'];
    const colIdx = allKeys.indexOf(columnKey);
    if (colIdx === -1) return;

    let targetIdx = -1;
    if (e.key === 'ArrowRight' && colIdx < allKeys.length - 1) targetIdx = colIdx + 1;
    if (e.key === 'ArrowLeft' && colIdx > 0) targetIdx = colIdx - 1;
    if (targetIdx === -1) return;

    e.preventDefault();
    executeMove(specId, columnKey, allKeys[targetIdx]);
  }, [executeMove, findAndOpenSpec, effectiveKanban]);

  // Cleanup on unmount
  useEffect(() => () => {
    cleanupGhost();
    clearTimeout(dragLeaveTimerRef.current ?? undefined);
    clearTimeout(touchDragTimerRef.current ?? undefined);
    if (touchCloneRef.current) { document.body.removeChild(touchCloneRef.current); touchCloneRef.current = null; }
  }, [cleanupGhost]);

  // Reset optimistic state when real kanban updates
  useEffect(() => { setOptimisticKanban(null); }, [kanban]);

  // Build story progress from all column data
  const storyProgress: Record<string, number> = {};
  const storyFailures: Record<string, number> = {};
  for (const k of [...effectiveKanban.inProgress, ...effectiveKanban.done]) {
    if (k.passedStories !== undefined) storyProgress[k.id] = k.passedStories;
    if (k.failedStories !== undefined) storyFailures[k.id] = k.failedStories;
  }
  for (const cc of (effectiveKanban.customColumns || [])) {
    for (const s of cc.specs) {
      if (s.passedStories !== undefined) storyProgress[s.id] = s.passedStories;
      if (s.failedStories !== undefined) storyFailures[s.id] = s.failedStories;
    }
  }

  // Click vs drag distinction — track mousedown position
  const mouseDownPosRef = useRef<{ x: number; y: number } | null>(null);

  const customCols = effectiveKanban.customColumns || [];
  const customSpecCount = customCols.reduce((n, c) => n + c.specs.length, 0);
  const totalCount = effectiveKanban.draft.length + effectiveKanban.inProgress.length + effectiveKanban.done.length + customSpecCount;

  // Build unified column list: Draft, In Progress, [custom...], Done
  type ColumnDef = {
    key: string;
    label: string;
    icon: typeof FileText;
    emptyMessage: string;
    accentClass: string;
    iconClass: string;
    color: string;
    system: boolean;
    customId?: number;
    specs: KanbanSpec[];
  };

  const allColumns: ColumnDef[] = useMemo(() => {
    const cols: ColumnDef[] = [
      { ...SYSTEM_COLUMNS[0], specs: effectiveKanban.draft },
      { ...SYSTEM_COLUMNS[1], specs: effectiveKanban.inProgress },
    ];
    for (const cc of customCols) {
      cols.push({
        key: `custom-${cc.id}`,
        label: cc.name,
        icon: Layers,
        emptyMessage: 'Drag specs here or click + to add cards',
        accentClass: '',
        iconClass: '',
        color: colorHex(cc.color),
        system: false,
        customId: cc.id,
        specs: cc.specs,
      });
    }
    cols.push({ ...SYSTEM_COLUMNS[2], specs: effectiveKanban.done });
    return cols;
  }, [effectiveKanban, customCols]);

  // ULT-013: Board keyboard navigation (j/k/h/l/Enter/a/x/e/d)
  const boardNavColumns = useMemo<BoardNavColumn[]>(() =>
    allColumns.filter(c => !collapsedColumns[c.key]).map(c => ({
      key: c.key,
      cardIds: c.specs.map(s => s.id),
    })),
  [allColumns, collapsedColumns]);

  const boardNavCallbacks = useMemo(() => ({
    onOpen: (id: string) => findAndOpenSpec(id),
    onApprove: (id: string) => handleApprove(id),
    onReject: (id: string) => {
      if (window.confirm(`Reject spec "${slugToTitle(id)}"?`)) handleDeny(id);
    },
    onEdit: (id: string) => findAndOpenSpec(id),
    onDelete: (id: string) => {
      if (window.confirm(`Delete spec "${slugToTitle(id)}"? This cannot be undone.`)) handleDeny(id);
    },
  }), [findAndOpenSpec, handleApprove, handleDeny]);

  // Tag overflow popover state — MUST be before any early returns (Rules of Hooks)
  const [tagPopoverSpecId, setTagPopoverSpecId] = useState<string | null>(null);

  const { focusedCardId, focusedColumnKey } = useBoardNav(
    boardNavColumns,
    boardNavCallbacks,
    !loading && !error,
  );

  if (loading) {
    return (
      <div className="flex h-full gap-4 p-4">
        <SkeletonColumn cards={3} className="flex-1" />
        <SkeletonColumn cards={2} className="flex-1" />
        <SkeletonColumn cards={4} className="flex-1" />
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

  if (totalCount === 0 && customCols.length === 0) {
    return (
      <EmptyState
        icon={Sparkles}
        heading="No specs yet"
        subtext="Create your first spec by clicking + New Spec. Describe what you want to build and Rorca will generate user stories automatically."
        action={onNewSpec ? { label: 'New Spec', onClick: onNewSpec, icon: Plus } : undefined}
      />
    );
  }

  // Status icon for card
  const statusIcon = (colKey: string, colColor: string, hasActiveRun: boolean, isQueued: boolean, isParallel = false) => {
    if (hasActiveRun && isQueued) return <Clock size={10} className="text-amber-400" />;
    if (hasActiveRun && isParallel) return <Play size={10} className="fill-blue-400 text-blue-400" />;
    if (hasActiveRun) return <Play size={10} className="fill-accent text-accent" />;
    if (colKey === 'draft') return <Pencil size={10} className="text-muted" />;
    if (colKey === 'done') return <CheckCircle2 size={10} className="text-success" />;
    if (colKey === 'in-progress') return <Play size={10} className="text-accent" />;
    // Custom column — colored dot
    return <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: colColor }} />;
  };

  // Render a spec card (shared between all columns)
  const renderCard = (spec: KanbanSpec, colKey: string, colColor: string, isDraft: boolean) => {
    const total = spec.storyCount;
    const passed = storyProgress[spec.id] ?? 0;
    const failed = storyFailures[spec.id] ?? 0;
    const pending = total - passed - failed;
    const hasProgress = storyProgress[spec.id] !== undefined && colKey !== 'draft';
    const actionLoading = actionLoadingMap[spec.id] ?? null;
    const isActioning = actionLoading !== null;
    const runStatus = activeRunSpecs.get(spec.id);
    const hasActiveRun = runStatus !== undefined;
    const isQueued = runStatus === 'queued';
    const isParallelRun = spec.isParallelRun === true;
    const modelName = modelShortName(spec.model);
    const tags = spec.tags || [];
    const visibleTags = tags.slice(0, 2);
    const overflowCount = tags.length - 2;
    const isBoardFocused = focusedCardId === spec.id && focusedColumnKey === colKey;

    // Click vs drag: only fire click if mouse moved < 5px
    const handleMouseDown = (e: React.MouseEvent) => {
      mouseDownPosRef.current = { x: e.clientX, y: e.clientY };
    };
    const handleClick = (e: React.MouseEvent) => {
      if (isActioning) return;
      if (mouseDownPosRef.current) {
        const dx = e.clientX - mouseDownPosRef.current.x;
        const dy = e.clientY - mouseDownPosRef.current.y;
        if (Math.sqrt(dx * dx + dy * dy) > 5) return; // was a drag, not a click
      }
      findAndOpenSpec(spec.id, colKey);
    };

    // ── Compact mode: title-only single line ──
    if (compactMode) {
      return (
        <div key={spec.id} className="group relative">
          <div
            role="button"
            tabIndex={0}
            draggable
            data-board-card={spec.id}
            data-board-col={colKey}
            aria-label={`${slugToTitle(spec.id)}, ${total} stories. j/k to navigate, Enter to open, a to approve.`}
            onDragStart={(e) => handleDragStart(e, spec.id, colKey, colColor)}
            onDragEnd={handleDragEnd}
            onTouchStart={(e) => handleTouchStart(e, spec.id, colKey, colColor)}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onKeyDown={(e) => handleCardKeyDown(e, spec.id, colKey)}
            onFocus={() => { focusedCardRef.current = { specId: spec.id, columnKey: colKey }; }}
            onMouseDown={handleMouseDown}
            onClick={handleClick}
            className={`w-full bg-panel border rounded-md px-2.5 py-1.5 text-left
              flex items-center gap-2 overflow-hidden cursor-grab select-none
              transition-all duration-150 hover:shadow-sm hover:shadow-black/10
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50
              ${isBoardFocused ? 'ring-2 ring-accent/70 border-accent/50' : ''}
              ${isActioning ? 'opacity-60 pointer-events-none' : ''} border-border`}
            style={{ borderLeftWidth: 3, borderLeftColor: colColor }}
          >
            {statusIcon(colKey, colColor, hasActiveRun, isQueued, isParallelRun)}
            <span className="text-[13px] font-medium text-[var(--text)] truncate flex-1">{slugToTitle(spec.id)}</span>
            <span className="shrink-0 text-[10px] text-muted">{total}s</span>
          </div>
        </div>
      );
    }

    // ── Full card mode ──
    return (
      <div key={spec.id} className="group relative">
        <div
          role="button"
          tabIndex={0}
          draggable
          data-board-card={spec.id}
          data-board-col={colKey}
          aria-label={`${slugToTitle(spec.id)}, ${total} stories. j/k to navigate, Enter to open, a to approve.`}
          onDragStart={(e) => handleDragStart(e, spec.id, colKey, colColor)}
          onDragEnd={handleDragEnd}
          onTouchStart={(e) => handleTouchStart(e, spec.id, colKey, colColor)}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onKeyDown={(e) => handleCardKeyDown(e, spec.id, colKey)}
          onFocus={() => { focusedCardRef.current = { specId: spec.id, columnKey: colKey }; }}
          onMouseDown={handleMouseDown}
          onClick={handleClick}
          className={`w-full bg-panel border rounded-lg p-3 text-left
            flex flex-col gap-2 overflow-hidden cursor-grab select-none
            transition-all duration-150
            hover:shadow-md hover:shadow-black/20 hover:scale-[1.02] hover:-translate-y-0.5
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50
            ${isBoardFocused ? 'ring-2 ring-accent/70 border-accent/50' : ''}
            ${isActioning ? 'opacity-60 pointer-events-none' : ''} border-border`}
          style={{
            borderLeftWidth: 3,
            borderLeftColor: colColor,
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = `${colColor}0d`; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = ''; }}
        >
          {/* Row 1: Status icon + Title + Running badge */}
          <div className="min-w-0">
            <div className="flex items-start gap-1.5">
              <span className="shrink-0 mt-0.5">{statusIcon(colKey, colColor, hasActiveRun, isQueued, isParallelRun)}</span>
              <h3 className="text-[14px] font-bold text-[var(--text)] line-clamp-2 leading-[1.3] flex-1">
                {slugToTitle(spec.id)}
              </h3>
              {hasActiveRun && (
                <span className={`shrink-0 mt-0.5 inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full border ${
                  isQueued
                    ? 'bg-amber-400/15 text-amber-400 border-amber-400/30'
                    : isParallelRun
                      ? 'bg-blue-400/15 text-blue-400 border-blue-400/30 animate-pulse'
                      : 'bg-accent/15 text-accent border-accent/30 animate-pulse'
                }`}>
                  {isQueued
                    ? <><Clock size={8} /> Queued{spec.queuePosition ? ` #${spec.queuePosition}` : ''}</>
                    : isParallelRun
                      ? <><Play size={8} className="fill-current" /> Running (parallel)</>
                      : <><Play size={8} className="fill-current" /> Running</>
                  }
                </span>
              )}
            </div>
          </div>

          {/* Row 2: Segmented story progress bar */}
          {hasProgress ? (
            <div
              className="w-full h-1 rounded-full bg-surface-200 overflow-hidden flex"
              title={`${passed} passed, ${failed} failed, ${pending} pending`}
            >
              {passed > 0 && (
                <div
                  className="h-full bg-emerald-500 transition-all duration-300"
                  style={{ width: `${(passed / total) * 100}%` }}
                />
              )}
              {failed > 0 && (
                <div
                  className="h-full bg-red-500 transition-all duration-300"
                  style={{ width: `${(failed / total) * 100}%` }}
                />
              )}
              {pending > 0 && (
                <div
                  className="h-full bg-zinc-600 transition-all duration-300"
                  style={{ width: `${(pending / total) * 100}%` }}
                />
              )}
            </div>
          ) : (
            <div className="w-full h-1 rounded-full bg-surface-200 overflow-hidden">
              <div className="h-full bg-zinc-600 w-full" />
            </div>
          )}

          {/* Row 3: Model badge + source badge + time-ago + tag pills + attachment badge */}
          <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
            {modelName && (
              <span className={`shrink-0 inline-flex items-center text-[10px] font-semibold px-1.5 py-0.5 rounded border ${modelColorClass(spec.model)}`}>
                {modelName}
              </span>
            )}
            {spec.source === 'github' && (
              <span className="shrink-0 inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-purple-500/15 text-purple-400 border border-purple-500/30">
                <Github size={8} />
                From GitHub
              </span>
            )}
            <span className="shrink-0 text-[10px] text-muted flex items-center gap-0.5">
              <Clock size={9} />
              {relativeTime(spec.approvedAt || spec.generatedAt)}
            </span>
            {visibleTags.map(tag => (
              <span
                key={tag}
                className="shrink-0 inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-accent/10 text-accent border border-accent/20 truncate max-w-[80px]"
                title={tag}
              >
                {tag}
              </span>
            ))}
            {overflowCount > 0 && (
              <span
                role="button"
                tabIndex={0}
                className="shrink-0 inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-surface-100 text-muted border border-border cursor-pointer hover:text-[var(--text)] transition-colors"
                onClick={(e) => { e.stopPropagation(); setTagPopoverSpecId(tagPopoverSpecId === spec.id ? null : spec.id); }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); setTagPopoverSpecId(tagPopoverSpecId === spec.id ? null : spec.id); } }}
              >
                +{overflowCount}
              </span>
            )}
            {(spec.attachmentCount ?? 0) > 0 && (
              <span
                role="button"
                tabIndex={0}
                title={`${spec.attachmentCount} attachment${spec.attachmentCount === 1 ? '' : 's'}`}
                className="shrink-0 inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-surface-100 text-muted border border-border cursor-pointer hover:text-[var(--text)] transition-colors"
                onClick={(e) => { e.stopPropagation(); findAndOpenSpec(spec.id, colKey, 'attachments'); }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); findAndOpenSpec(spec.id, colKey, 'attachments'); } }}
              >
                <Paperclip size={8} />
                {spec.attachmentCount}
              </span>
            )}
          </div>

          {/* Tag overflow popover */}
          {tagPopoverSpecId === spec.id && tags.length > 2 && (
            <div className="flex flex-wrap gap-1 p-2 bg-surface-100 rounded-md border border-border -mt-1">
              {tags.map(tag => (
                <span
                  key={tag}
                  className="inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-accent/10 text-accent border border-accent/20"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Approve / Deny action buttons — Draft column only, shown on hover */}
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
  };

  return (
    <div className="flex flex-col h-full">
      {/* Board header — compact toggle */}
      <div className="flex items-center justify-end px-3 py-1.5 border-b border-border shrink-0">
        <button
          onClick={() => setCompactMode(!compactMode)}
          title={compactMode ? 'Detailed cards' : 'Compact cards'}
          className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium transition-colors
            ${compactMode ? 'bg-accent/15 text-accent border border-accent/30' : 'text-muted hover:text-[var(--text)] border border-transparent hover:border-border'}`}
        >
          {compactMode ? <LayoutGrid size={12} /> : <AlignJustify size={12} />}
          {compactMode ? 'Detailed' : 'Compact'}
        </button>
      </div>
      <div className="flex flex-1 min-h-0 board-columns-container">
      <div ref={announceRef} aria-live="assertive" aria-atomic="true" className="sr-only" />

      {allColumns.map((col, colIdx) => {
        const specs = col.specs;
        const Icon = col.icon;
        const isDragOver = dragOverColumnRef.current === col.key && (dragSpecIdRef.current != null || dragColumnIdRef.current != null);
        const isCollapsed = !!collapsedColumns[col.key];
        const isDraft = col.key === 'draft';
        const isCustom = !col.system;
        const isDoneColumn = col.key === 'done';

        return (
          <React.Fragment key={col.key}>
          {/* Add column button — render before Done column */}
          {isDoneColumn && (
            <AddColumnPopover
              onAdd={handleAddColumn}
              disabled={customCols.length >= MAX_CUSTOM_COLUMNS}
            />
          )}
          <div
            key={col.key}
            data-column-key={col.key}
            className={`flex flex-col min-h-0 transition-colors
              ${colIdx > 0 ? 'border-l border-border' : ''}`}
            style={{
              width: isCollapsed ? 40 : undefined,
              minWidth: isCollapsed ? 40 : 220,
              maxWidth: isCollapsed ? 40 : undefined,
              flex: isCollapsed ? '0 0 40px' : '1 1 0%',
              transition: 'flex 300ms cubic-bezier(0.34, 1.56, 0.64, 1), width 300ms, min-width 300ms, max-width 300ms',
              overflow: 'hidden',
              ...(isDragOver && !isCollapsed ? { border: `2px dashed ${col.color}`, backgroundColor: `${col.color}0d`, boxShadow: `inset 0 0 20px ${col.color}15` } : {}),
            }}
            onDragOver={isCollapsed ? undefined : (e) => handleDragOver(e, col.key)}
            onDragLeave={isCollapsed ? undefined : handleDragLeave}
            onDrop={isCollapsed ? undefined : (e) => handleDrop(e, col.key)}
          >
            {isCollapsed ? (
              <div
                role="button"
                tabIndex={0}
                aria-label={`Expand ${col.label} column (${specs.length} specs)`}
                onClick={() => toggleCollapse(col.key)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCollapse(col.key); } }}
                className="flex flex-col items-center h-full cursor-pointer hover:bg-surface-100/50 transition-colors select-none"
                style={{ width: 40 }}
              >
                <div className="shrink-0 mt-3 mb-1.5 w-2 h-2 rounded-full" style={{ backgroundColor: col.color }} />
                <span className="shrink-0 text-[10px] font-semibold px-1 py-0.5 rounded" style={{ color: col.color }}>
                  {specs.length}
                </span>
                <span
                  className="text-[11px] font-medium text-muted mt-3 whitespace-nowrap"
                  style={{ writingMode: 'vertical-rl', textOrientation: 'mixed' }}
                >
                  {col.label}
                </span>
                <ChevronRight size={12} className="shrink-0 text-muted/50 mt-auto mb-2" />
              </div>
            ) : (
              <>
                {/* Column header */}
                <div
                  className={`flex items-center gap-2 px-3 py-2.5 border-b border-border shrink-0 select-none
                    ${isCustom ? 'cursor-grab' : 'cursor-pointer hover:bg-surface-100/30'} transition-colors`}
                  draggable={isCustom}
                  onDragStart={isCustom && col.customId ? (e) => handleColumnDragStart(e, col.customId!, col.label, col.color) : undefined}
                  onDragEnd={isCustom ? handleColumnDragEnd : undefined}
                  onClick={isCustom ? undefined : () => toggleCollapse(col.key)}
                  onKeyDown={!isCustom ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCollapse(col.key); } } : undefined}
                  role={isCustom ? undefined : 'button'}
                  tabIndex={isCustom ? undefined : 0}
                  aria-label={isCustom ? undefined : `Collapse ${col.label} column`}
                >
                  {isCustom ? (
                    <ColorPickerPopover currentColor={customCols.find(c => c.id === col.customId)?.color || 'indigo'} onChange={(c) => col.customId && handleChangeColor(col.customId, c)} />
                  ) : (
                    <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: col.color }} />
                  )}

                  {isCustom && col.customId != null ? (
                    <GripVertical size={12} className="text-muted/30 shrink-0" />
                  ) : (
                    <Icon size={14} style={{ color: col.color }} />
                  )}

                  {/* Inline rename for custom columns */}
                  {isCustom && editingColumnId === col.customId ? (
                    <input
                      autoFocus
                      value={editingColumnName}
                      onChange={(e) => setEditingColumnName(e.target.value)}
                      onBlur={() => col.customId != null && handleRenameColumn(col.customId, editingColumnName)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') col.customId != null && handleRenameColumn(col.customId, editingColumnName);
                        if (e.key === 'Escape') setEditingColumnId(null);
                      }}
                      onClick={(e) => e.stopPropagation()}
                      className="flex-1 min-w-0 px-1 py-0 rounded text-sm font-medium bg-bg border border-accent/50 text-[var(--text)] focus:outline-none focus:ring-1 focus:ring-accent/50"
                    />
                  ) : (
                    <span
                      className="text-sm font-medium text-[var(--text)] truncate"
                      onDoubleClick={isCustom && col.customId != null ? (e) => {
                        e.stopPropagation();
                        setEditingColumnId(col.customId!);
                        setEditingColumnName(col.label);
                      } : undefined}
                      title={isCustom ? 'Double-click to rename' : undefined}
                    >
                      {col.label}
                    </span>
                  )}

                  <span className="text-[11px] font-medium px-1.5 py-0.5 rounded-full" style={{ color: col.color, backgroundColor: `${col.color}20` }}>
                    {specs.length}
                  </span>

                  {/* Delete button for custom columns */}
                  {isCustom && col.customId != null && (
                    <button
                      onClick={(e) => { e.stopPropagation(); setDeleteDialog({ id: col.customId!, name: col.label, specCount: specs.length }); }}
                      className="ml-auto p-1 rounded text-muted/40 hover:text-error hover:bg-error/10 transition-colors opacity-0 group-hover:opacity-100"
                      title="Delete column"
                      style={{ opacity: undefined }}
                      onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
                      onMouseLeave={(e) => (e.currentTarget.style.opacity = '')}
                    >
                      <Trash2 size={12} />
                    </button>
                  )}

                  {col.system && <ChevronLeft size={12} className="ml-auto text-muted/40 shrink-0" />}
                </div>

                {/* Column body */}
                <div className="flex-1 overflow-y-auto min-h-0 p-3 space-y-2">
                  {specs.length === 0 ? (
                    isCustom ? (
                      <div
                        className="flex flex-col items-center justify-center py-12 text-center border-2 border-dashed rounded-lg mx-1"
                        style={{ borderColor: `${col.color}40` }}
                      >
                        <p className="text-sm" style={{ color: `${col.color}66` }}>Drag specs here</p>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center justify-center py-12 text-center">
                        <Icon size={32} className="text-muted/30 mb-2" />
                        <p className="text-sm text-muted">{col.emptyMessage}</p>
                      </div>
                    )
                  ) : (
                    specs.map((spec) => (
                      <div key={spec.id} onDragOver={(e) => handleCardDragOver(e, spec.id)}>
                        <LazyBoardCard height={compactMode ? 36 : 120}>
                          {renderCard(spec, col.key, col.color, isDraft)}
                        </LazyBoardCard>
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
          </div>
          </React.Fragment>
        );
      })}

      {/* Delete confirmation dialog */}
      {deleteDialog && (
        <DeleteColumnDialog
          columnName={deleteDialog.name}
          specCount={deleteDialog.specCount}
          onConfirm={() => handleDeleteColumn(deleteDialog.id)}
          onCancel={() => setDeleteDialog(null)}
        />
      )}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════
   LIST VIEW — Searchable archive table
   ════════════════════════════════════════════════════════════════════ */

function ListView({ workspaceId, onSpecClick, onNavigate, onNewSpec }: {
  workspaceId: string;
  onSpecClick: (specId: string, summary?: ArchiveSpec) => void;
  onNavigate: (panel: PanelId) => void;
  onNewSpec?: () => void;
}) {
  const [specs, setSpecs] = useState<ArchiveSpec[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');

  const [searchText, setSearchText] = useState('');
  const debouncedSearch = useDebounce(searchText, 300);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [tagFilter, setTagFilter] = useState<string[]>([]);

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

  const allTags = useMemo(() => Array.from(new Set(specs.flatMap(s => s.tags || []))).sort(), [specs]);

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
            aria-label="Search specs"
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
          aria-label="Filter by status"
          className="h-8 px-2 pr-8 bg-transparent border border-border/50 rounded text-sm text-muted hover:text-text focus:outline-none focus:border-accent/40 transition-colors cursor-pointer appearance-none"
          style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 8px center' }}
        >
          {STATUS_FILTERS.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>

        <select
          value={tagFilter.length > 0 ? tagFilter[0] : 'all'}
          onChange={(e) => { const val = e.target.value; if (val === 'all') setTagFilter([]); else setTagFilter([val]); }}
          aria-label="Filter by tag"
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
          <div className="p-4 space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 px-4 py-3 border border-border rounded-lg">
                <div className="skeleton-shimmer rounded h-4 w-2/5" />
                <div className="skeleton-shimmer rounded h-3 w-1/5" />
                <div className="flex-1" />
                <div className="skeleton-shimmer rounded-full h-5 w-16" />
              </div>
            ))}
          </div>
        ) : specs.length === 0 ? (
          debouncedSearch ? (
            <div className="flex items-center justify-center h-full">
              <div className="flex flex-col items-center gap-4 p-8 border-2 border-dashed border-border rounded-lg max-w-xs text-center">
                <Archive size={64} className="text-muted/40" strokeWidth={1.2} />
                <div>
                  <p className="text-sm font-medium text-text mb-1">No specs match &ldquo;{debouncedSearch}&rdquo;</p>
                  <p className="text-xs text-muted">Try a different keyword</p>
                </div>
              </div>
            </div>
          ) : (
            <EmptyState
              icon={Sparkles}
              heading="No specs yet"
              subtext="Create your first spec by clicking + New Spec. Describe what you want to build and Rorca will generate user stories automatically."
              action={onNewSpec ? { label: 'New Spec', onClick: onNewSpec, icon: Plus } : undefined}
            />
          )
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
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Model
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [configuredProviders, setConfiguredProviders] = useState<string[]>([]);
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

  // Reasoning — per-model preferences stored in localStorage under rorca:reasoning:<modelId>
  // Derives effective modelId (selected or default) for keying prefs
  const effectiveModelId = useMemo(
    () => selectedModel || defaultModelId || 'claude-sonnet-4-6',
    [selectedModel, defaultModelId]
  );

  // Capability of the currently selected model (derived from availableModels)
  const reasoningCapability = useMemo(() => {
    const m = availableModels.find(m => m.id === effectiveModelId);
    return m?.reasoningCapability ?? { supportsReasoning: false, reasoningType: 'none' as const, effortLevels: [] as string[], defaultEffort: null, budgetTokensSupported: false, budgetRange: null, costMultiplier: {} as Record<string, number> };
  }, [availableModels, effectiveModelId]);

  // Load saved prefs for a model from localStorage
  const loadReasoningPrefs = useCallback((modelId: string) => {
    try {
      const raw = localStorage.getItem(`rorca:reasoning:${modelId}`);
      if (raw) return JSON.parse(raw) as { enabled: boolean; effort: string };
    } catch { /* ignore */ }
    return null;
  }, []);

  const [reasoningEnabled, setReasoningEnabled] = useState(false);
  // 'auto' means compute effort from spec complexity; other values are explicit selections
  const [reasoningEffort, setReasoningEffort] = useState<string>('medium');
  const [effortIsAuto, setEffortIsAuto] = useState(false);

  // When model changes, load saved prefs (or fall back to capability defaults)
  useEffect(() => {
    const cap = availableModels.find(m => m.id === effectiveModelId)?.reasoningCapability;
    if (!cap?.supportsReasoning) {
      setReasoningEnabled(false);
      return;
    }
    const saved = loadReasoningPrefs(effectiveModelId);
    if (saved) {
      setReasoningEnabled(saved.enabled);
      // Clamp effort to what the model actually supports
      const validEffort = cap.effortLevels.includes(saved.effort) ? saved.effort : (cap.defaultEffort ?? 'medium');
      setReasoningEffort(validEffort);
    } else {
      setReasoningEnabled(false);
      setReasoningEffort(cap.defaultEffort ?? 'medium');
    }
  }, [effectiveModelId, availableModels, loadReasoningPrefs]);

  // Persist reasoning prefs whenever they change
  useEffect(() => {
    if (!reasoningCapability.supportsReasoning) return;
    try { localStorage.setItem(`rorca:reasoning:${effectiveModelId}`, JSON.stringify({ enabled: reasoningEnabled, effort: reasoningEffort })); } catch { /* ignore */ }
  }, [reasoningEnabled, reasoningEffort, effectiveModelId, reasoningCapability.supportsReasoning]);

  // Auto-effort: compute suggested effort from spec size when effortIsAuto is true.
  // We synthesize a proxy story list from storyCount (0 = auto → assume ~10 stories).
  const autoEffortResult = useMemo(() => {
    if (!effortIsAuto || !reasoningEnabled || !reasoningCapability.supportsReasoning) return null;
    const count = storyCount > 0 ? storyCount : 10;
    // Build proxy stories: no dependsOn info available pre-generation, so depth = 0.
    const proxyStories = Array.from({ length: count }, () => ({}));
    // We import computeAutoEffort inline to avoid a backend import — inline the same logic.
    let effort: 'low' | 'medium' | 'high';
    let rationale: string;
    if (count > 20) {
      effort = 'high';
      rationale = `This ${count}-story spec is complex. Reasoning: high recommended. ~4x base cost`;
    } else if (count >= 10) {
      effort = 'medium';
      rationale = `This ${count}-story spec is moderate. Reasoning: medium recommended. ~2x base cost`;
    } else {
      effort = 'low';
      rationale = `This ${count}-story spec is straightforward. Reasoning: low recommended.`;
    }
    void proxyStories; // suppress unused var
    return { effort, rationale };
  }, [effortIsAuto, reasoningEnabled, reasoningCapability.supportsReasoning, storyCount]);

  // Auto-match & auto-suggest toggles (persisted in localStorage)
  const [autoMatchSkills, setAutoMatchSkills] = useState(() => {
    try { const v = localStorage.getItem('rorca:forge:autoMatchSkills'); return v !== 'false'; } catch { return true; }
  });
  const [autoSuggestModels, setAutoSuggestModels] = useState(() => {
    try { const v = localStorage.getItem('rorca:forge:autoSuggestModels'); return v !== 'false'; } catch { return true; }
  });
  useEffect(() => { try { localStorage.setItem('rorca:forge:autoMatchSkills', String(autoMatchSkills)); } catch {} }, [autoMatchSkills]);
  useEffect(() => { try { localStorage.setItem('rorca:forge:autoSuggestModels', String(autoSuggestModels)); } catch {} }, [autoSuggestModels]);

  // Skills count
  const [skillsCount, setSkillsCount] = useState<number | null>(null);

  // Context health checklist
  interface ContextHealth { l3Present: boolean; gitMemoryCount: number; schemaPresent: boolean; claudeMdPresent: boolean; skillsCount: number; contextScore: number; }
  const [contextHealth, setContextHealth] = useState<ContextHealth | null>(null);
  const [contextHealthLoading, setContextHealthLoading] = useState(false);
  const [contextHealthOpen, setContextHealthOpen] = useState(false);
  const [hydratingGit, setHydratingGit] = useState(false);

  // Auto-match/suggest loading state
  const [autoMatchStatus, setAutoMatchStatus] = useState<'idle' | 'matching' | 'suggesting' | 'done'>('idle');
  const [modelSuggestions, setModelSuggestions] = useState<Array<{ storyId: string; suggestedModel: string; reason: string; confidence: number }> | null>(null);

  // Generation state
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedSpec, setGeneratedSpec] = useState<GeneratedSpec | null>(null);
  const [generateError, setGenerateError] = useState<SpecGenerationError | null>(null);
  const [apiDone, setApiDone] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Quick run
  const [isQuickRunning, setIsQuickRunning] = useState(false);

  // Template picker
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);

  // Pasted image attachments (uploaded to backend, associated by specId after generation)
  const [pendingAttachments, setPendingAttachments] = useState<Array<{ filename: string; contentType: string; size: number }>>([]);

  // Saved attachments fetched from backend (for existing specs)
  interface SavedAttachment { id: string; filename: string; contentType: string; fileSize: number; createdAt: string; }
  const [savedAttachments, setSavedAttachments] = useState<SavedAttachment[]>([]);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());

  // Slug preview — declared here so handlePaste/handleFileSelect can reference effectiveSlug
  const [previewSlug, setPreviewSlug] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setPreviewSlug(specName ? '' : briefToSlug(specBrief)), 300);
    return () => clearTimeout(timer);
  }, [specBrief, specName]);
  const effectiveSlug = useMemo(() => specName || previewSlug, [specName, previewSlug]);

  const handlePaste = useCallback(async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData.items);
    const imageItem = items.find((item) => item.type.startsWith('image/'));
    if (!imageItem) return;

    const file = imageItem.getAsFile();
    if (!file) return;

    const ext = file.type.split('/')[1] ?? 'png';
    const filename = `pasted-image-${Date.now()}.${ext}`;
    const namedFile = new File([file], filename, { type: file.type });

    showToast('Image pasted, uploading...', 'info');

    try {
      const formData = new FormData();
      formData.append('file', namedFile);
      if (effectiveSlug) formData.append('specSlug', effectiveSlug);
      await apiFetch('/api/attachments/pending', { method: 'POST', body: formData });
      setPendingAttachments((prev) => [...prev, { filename, contentType: file.type, size: file.size }]);
    } catch {
      showToast('Image upload failed', 'error');
    }
  }, [showToast, effectiveSlug]);

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    // Reset so the same file can be re-selected
    e.target.value = '';
    for (const file of files) {
      showToast(`Uploading ${file.name}...`, 'info');
      try {
        const formData = new FormData();
        formData.append('file', file);
        if (effectiveSlug) formData.append('specSlug', effectiveSlug);
        await apiFetch('/api/attachments/pending', { method: 'POST', body: formData });
        setPendingAttachments((prev) => [...prev, { filename: file.name, contentType: file.type, size: file.size }]);
        showToast(`Uploaded ${file.name}`, 'success');
      } catch {
        showToast(`Upload failed: ${file.name}`, 'error');
      }
    }
  }, [showToast, effectiveSlug]);

  // Model accept handler — PUTs the accepted model to the story on disk
  const handleModelAccepted = useCallback(async (storyId: string, model: string) => {
    if (!generatedSpec || !workspaceId) return;
    try {
      await apiFetch(`/api/specs/${encodeURIComponent(generatedSpec.specName)}/stories/${encodeURIComponent(storyId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, model }),
      });
    } catch {
      // Silent — local state already updated in preview
    }
  }, [generatedSpec, workspaceId]);

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

  // Fetch saved attachments when spec slug is known (editing existing spec)
  useEffect(() => {
    if (!effectiveSlug) { setSavedAttachments([]); return; }
    apiFetch<SavedAttachment[]>(`/api/specs/${encodeURIComponent(effectiveSlug)}/attachments`, { silent: true })
      .then(setSavedAttachments)
      .catch(() => setSavedAttachments([]));
  }, [effectiveSlug]);

  const handleDeleteAttachment = useCallback(async (id: string) => {
    if (!effectiveSlug) return;
    setDeletingIds((prev) => new Set(prev).add(id));
    try {
      await apiFetch(`/api/specs/${encodeURIComponent(effectiveSlug)}/attachments/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setSavedAttachments((prev) => prev.filter((a) => a.id !== id));
    } catch {
      showToast('Failed to delete attachment', 'error');
    } finally {
      setDeletingIds((prev) => { const s = new Set(prev); s.delete(id); return s; });
    }
  }, [effectiveSlug, showToast]);

  // Fetch models and config
  useEffect(() => {
    if (!workspaceId) return;
    Promise.all([
      apiFetch<{ models: ModelOption[]; defaultModel: string; configuredProviders?: string[] }>(`/api/direction/models?workspaceId=${workspaceId}`),
      apiFetch<{ provider: string }>(`/api/vault/keys/default-provider?workspaceId=${workspaceId}`),
      apiFetch<{ agentType: AgentType; agentModel: string | null; modelDisplayName: string | null; opencodeInstalled?: boolean; codexInstalled?: boolean }>('/api/config'),
      apiFetch<{ models: Array<{ id: string; name: string; provider: string; contextWindow: number; costPer1kInput?: number; costPer1kOutput?: number; speedTier?: string; costTier?: string }> }>('/api/config/opencode-models'),
      apiFetch<{ model: string | null }>('/api/workflow-router/resolved/spec_generation').catch(() => null),
    ]).then(([modelData, providerData, configData, ocModels, resolvedWf]) => {
      setAvailableModels(modelData.models);
      setConfiguredProviders(modelData.configuredProviders ?? []);
      // Workflow router model takes priority over direction models default
      const wrModel = resolvedWf?.model ?? null;
      setDefaultModelId(wrModel || modelData.defaultModel);
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

  // Fetch skills count
  useEffect(() => {
    if (!workspaceId) { setSkillsCount(null); return; }
    apiFetch<{ skills: unknown[] }>(`/api/skills?workspaceId=${workspaceId}`)
      .then(res => setSkillsCount(Array.isArray(res.skills) ? res.skills.length : (Array.isArray(res) ? (res as unknown[]).length : 0)))
      .catch(() => setSkillsCount(0));
  }, [workspaceId]);

  // Fetch context health
  useEffect(() => {
    if (!workspaceId) { setContextHealth(null); return; }
    setContextHealthLoading(true);
    apiFetch<ContextHealth>(`/api/workspaces/${workspaceId}/context-health`)
      .then(res => setContextHealth(res))
      .catch(() => setContextHealth(null))
      .finally(() => setContextHealthLoading(false));
  }, [workspaceId]);

  const handleHydrateGit = useCallback(async () => {
    if (!workspaceId || hydratingGit) return;
    setHydratingGit(true);
    try {
      await apiFetch(`/api/workspaces/${workspaceId}/hydrate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ types: ['git'] }) });
      const res = await apiFetch<ContextHealth>(`/api/workspaces/${workspaceId}/context-health`);
      setContextHealth(res);
    } catch { /* silent */ }
    finally { setHydratingGit(false); }
  }, [workspaceId, hydratingGit]);

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

  /** Switch model and retry — clears error, opens advanced, scrolls to model picker */
  const handleRetryWithModel = useCallback(() => {
    setGenerateError(null);
    setApiDone(false);
    setAdvancedOpen(true);
  }, []);

  const handleGenerate = async () => {
    if (!canGenerate || isGenerating) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setIsGenerating(true);
    setGenerateError(null);
    setApiDone(false);
    const forgeAgent = overrideAgent ? overrideAgentType : wsAgentType;
    const forgeModel = overrideAgent && overrideAgentType === 'opencode'
      ? (overrideAgentModel || selectedModel || undefined)
      : (selectedModel || undefined);
    const modelUsed = forgeModel || defaultModelId || 'claude-sonnet-4-6';
    try {
      const result = await apiFetch<GeneratedSpec>('/api/specs/forge', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({
          workspaceId,
          domain: workspace?.domain || undefined,
          specName: specName || undefined,
          storyCount,
          specBrief,
          model: forgeModel,
          agentOverride: forgeAgent,
          postSave: { matchSkills: autoMatchSkills, enrich: true, memorySynthesis: true },
          ...(reasoningCapability.supportsReasoning && reasoningEnabled ? { reasoning: { enabled: true, effort: effortIsAuto ? (autoEffortResult?.effort ?? 'medium') : reasoningEffort } } : {}),
        }),
      });
      setApiDone(true);
      // Map backend response fields: backend returns { slug, title } but GeneratedSpec expects { slug, specName }
      const raw = result as unknown as Record<string, unknown>;
      if (raw.slug && !result.specName) {
        result.slug = raw.slug as string;
        result.specName = (raw.title as string) || (raw.slug as string);
      }
      setGeneratedSpec(result);
      setModelSuggestions(null);
      setTimeout(() => setIsGenerating(false), 800);

      const specId = result.slug || result.specName;
      (async () => {
        if (autoMatchSkills) {
          setAutoMatchStatus('matching');
          await new Promise(r => setTimeout(r, 800));
        }

        // Auto-suggest models
        if (autoSuggestModels && workspaceId) {
          setAutoMatchStatus('suggesting');
          try {
            const suggestRes = await apiFetch<{ suggestions: Array<{ storyId: string; suggestedModel: string; reason: string; confidence: number }> }>(
              `/api/specs/${encodeURIComponent(specId)}/suggest-models`,
              { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId }) },
            );
            setModelSuggestions(suggestRes.suggestions ?? null);
          } catch {
            showToast('Model suggestion failed — you can retry from the spec review', 'warning');
          }
        }

        setAutoMatchStatus('done');
        setTimeout(() => setAutoMatchStatus('idle'), 1500);
      })();
    } catch (err: unknown) {
      if (controller.signal.aborted) return;
      setApiDone(true);
      const message = err instanceof Error ? err.message : String(err);

      // Extract structured error details from ApiError if available
      const details = err instanceof ApiError ? err.details : {};
      setGenerateError({
        message,
        category: (details.category as SpecGenerationError['category']) || 'unknown',
        model: (details.model as string) || modelUsed,
        provider: (details.provider as string) || undefined,
        suggestion: (details.suggestion as string) || undefined,
        rawResponse: (details.rawResponse as string) || undefined,
        contextSummary: (details.contextSummary as Record<string, unknown>) || undefined,
      });
      setIsGenerating(false);
    }
  };

  /** Retry with same settings — clears error and re-triggers generation */
  const handleRetry = () => {
    setGenerateError(null);
    setApiDone(false);
    // Defer so state clears, then call generate
    setTimeout(() => handleGenerate(), 0);
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
        <div>
          <textarea
            ref={briefRef} rows={6} value={specBrief}
            onChange={(e) => setSpecBrief(e.target.value.slice(0, 4000))}
            onPaste={handlePaste}
            placeholder="What do you want to build?"
            aria-label="Spec brief — describe what you want to build"
            className="w-full px-4 py-4 text-sm bg-panel border border-border rounded-lg text-text placeholder:text-muted/50 outline-none focus:border-accent focus:ring-2 focus:ring-accent/50 transition-colors resize-none leading-relaxed"
          />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,.pdf,.md,.txt,.docx"
            className="hidden"
            onChange={handleFileSelect}
          />
          <div className="mt-1.5 flex items-center">
            <button
              type="button"
              aria-label="Attach files"
              disabled={isGenerating || !workspaceId}
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 px-2 py-1 text-xs text-muted hover:text-accent disabled:opacity-40 disabled:cursor-not-allowed transition-colors rounded"
            >
              <Paperclip size={13} />
              Attach files
            </button>
          </div>
          {/* Attachment list — saved (from backend) + pending (local uploads) */}
          {(() => {
            const formatSize = (bytes: number) => bytes < 1024 * 1024
              ? `${(bytes / 1024).toFixed(1)} KB`
              : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

            const getFileIcon = (contentType: string, filename: string) => {
              if (contentType.startsWith('image/')) return null;
              if (contentType === 'application/pdf' || filename.endsWith('.pdf')) return <FileType size={14} className="text-muted shrink-0" />;
              if (contentType === 'text/markdown' || filename.endsWith('.md') || contentType === 'text/plain' || filename.endsWith('.txt')) return <FileText size={14} className="text-muted shrink-0" />;
              return <FileIcon size={14} className="text-muted shrink-0" />;
            };

            const hasSaved = savedAttachments.length > 0;
            const hasPending = pendingAttachments.length > 0;

            if (!hasSaved && !hasPending) {
              return (
                <p className="mt-2 text-[11px] text-muted/60 italic px-1">
                  No attachments yet. Paste an image or click paperclip to attach files.
                </p>
              );
            }

            return (
              <div className="mt-2 space-y-1.5">
                {savedAttachments.map((att) => (
                  <div key={att.id} className="flex items-center gap-2 px-2 py-1.5 bg-panel border border-border rounded-lg group">
                    {att.contentType.startsWith('image/') ? (
                      <img
                        src={`${BASE_URL}/api/specs/${encodeURIComponent(effectiveSlug)}/attachments/${encodeURIComponent(att.id)}`}
                        alt={att.filename}
                        style={{ maxHeight: 80 }}
                        className="rounded object-contain shrink-0"
                      />
                    ) : (
                      getFileIcon(att.contentType, att.filename)
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-text truncate">{att.filename}</p>
                      <p className="text-[10px] text-muted">{formatSize(att.fileSize)} · {relativeTime(att.createdAt)}</p>
                    </div>
                    <button
                      type="button"
                      aria-label={`Delete ${att.filename}`}
                      disabled={deletingIds.has(att.id)}
                      onClick={() => handleDeleteAttachment(att.id)}
                      className="opacity-0 group-hover:opacity-100 p-1 rounded text-muted hover:text-red-500 disabled:opacity-40 transition-all"
                    >
                      {deletingIds.has(att.id) ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
                    </button>
                  </div>
                ))}
                {pendingAttachments.map((att) => (
                  <div key={att.filename} className="flex items-center gap-2 px-2 py-1.5 bg-accent/5 border border-accent/20 rounded-lg">
                    {att.contentType.startsWith('image/') ? (
                      <div className="w-10 h-10 rounded bg-accent/10 flex items-center justify-center shrink-0">
                        <FileText size={14} className="text-accent" />
                      </div>
                    ) : (
                      getFileIcon(att.contentType, att.filename)
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-accent truncate">{att.filename}</p>
                      <p className="text-[10px] text-muted">{formatSize(att.size)} · pending</p>
                    </div>
                  </div>
                ))}
              </div>
            );
          })()}
          {/* Skills count indicator */}
          {skillsCount !== null && (
            <div className="mt-1.5 px-1">
              {skillsCount > 0 ? (
                <span className="text-[11px] text-muted">{skillsCount} skill{skillsCount !== 1 ? 's' : ''} available</span>
              ) : (
                <button onClick={() => { onNavigate?.('marketplace' as PanelId); onClose(); }}
                  className="text-[11px] text-muted hover:text-accent transition-colors">
                  No skills installed — add skills from the Marketplace
                </button>
              )}
            </div>
          )}
        </div>
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
                    <button onClick={() => { setContextPopover(null); onNavigate?.('direction'); onClose(); }} className="text-[10px] text-accent hover:text-accent-hover transition-colors">View full &rarr;</button>
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
                      aria-label={`Add ${dot.label.toLowerCase()}`}
                      className="w-full px-2 py-1.5 text-xs bg-panel border border-border rounded text-text placeholder:text-muted/50 outline-none focus:border-accent transition-colors resize-none" autoFocus />
                    <div className="flex items-center justify-between">
                      <button onClick={() => { setContextPopover(null); onNavigate?.('direction'); onClose(); }} className="text-[10px] text-accent hover:text-accent-hover transition-colors">Set up in Direction</button>
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

      {/* Context summary card — shown during generation (once result arrives) */}
      {isGenerating && generatedSpec?.contextSummary && (
        <ContextSummaryCard summary={generatedSpec.contextSummary} isGenerating />
      )}

      {/* Context readiness checklist — shown before generation */}
      {!generatedSpec && !isGenerating && workspaceId && (
        <div className="border border-border rounded-lg overflow-hidden">
          {/* Summary header — always visible, click to expand */}
          <button
            type="button"
            onClick={() => setContextHealthOpen(v => !v)}
            className="w-full flex items-center justify-between px-3 py-2 text-xs text-muted hover:bg-accent/5 transition-colors"
          >
            <span className="flex items-center gap-1.5">
              {contextHealthLoading ? (
                <Loader2 size={12} className="animate-spin" />
              ) : contextHealth ? (
                (() => {
                  const ready = [contextHealth.l3Present, contextHealth.gitMemoryCount > 0, contextHealth.schemaPresent, contextHealth.claudeMdPresent, contextHealth.skillsCount > 0].filter(Boolean).length;
                  return ready === 5
                    ? <CheckCircle2 size={12} className="text-emerald-500" />
                    : <AlertTriangle size={12} className="text-amber-500" />;
                })()
              ) : null}
              {contextHealthLoading ? 'Checking context...' : contextHealth ? (() => {
                const ready = [contextHealth.l3Present, contextHealth.gitMemoryCount > 0, contextHealth.schemaPresent, contextHealth.claudeMdPresent, contextHealth.skillsCount > 0].filter(Boolean).length;
                return `${ready}/5 context items ready`;
              })() : 'Context readiness'}
            </span>
            <ChevronDown size={12} className={`transition-transform ${contextHealthOpen ? 'rotate-180' : ''}`} />
          </button>

          {/* Circular score indicator — shown when expanded and data loaded */}
          {contextHealthOpen && contextHealth && !contextHealthLoading && (() => {
            const score = contextHealth.contextScore;
            const radius = 28;
            const circumference = 2 * Math.PI * radius;
            const finalOffset = circumference - (score / 100) * circumference;
            const strokeColor = score >= 70 ? '#10b981' : score >= 40 ? '#f59e0b' : '#ef4444';
            const animId = `ctx-score-anim-${score}`;
            return (
              <div className="border-t border-border flex flex-col items-center py-3 gap-1">
                <style>{`
                  @keyframes ${animId} {
                    from { stroke-dashoffset: ${circumference}; }
                    to   { stroke-dashoffset: ${finalOffset}; }
                  }
                `}</style>
                <svg width="80" height="80" viewBox="0 0 80 80">
                  {/* Track */}
                  <circle
                    cx="40" cy="40" r={radius}
                    fill="none"
                    stroke="var(--color-border, #e5e7eb)"
                    strokeWidth="6"
                  />
                  {/* Progress arc */}
                  <circle
                    cx="40" cy="40" r={radius}
                    fill="none"
                    stroke={strokeColor}
                    strokeWidth="6"
                    strokeLinecap="round"
                    strokeDasharray={circumference}
                    strokeDashoffset={finalOffset}
                    transform="rotate(-90 40 40)"
                    style={{ animation: `${animId} 600ms ease-out` }}
                  />
                  {/* Score number */}
                  <text
                    x="40" y="37"
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fontSize="15"
                    fontWeight="600"
                    fill={strokeColor}
                  >{score}</text>
                  {/* /100 label */}
                  <text
                    x="40" y="52"
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fontSize="8"
                    fill="var(--color-muted, #6b7280)"
                  >/ 100</text>
                </svg>
                <span className="text-[10px] text-muted">Context Score</span>
              </div>
            );
          })()}

          {/* Expanded checklist rows */}
          {contextHealthOpen && (
            <div className="border-t border-border divide-y divide-border/50">
              {contextHealthLoading ? (
                <div className="px-3 py-3 space-y-2">
                  {[1,2,3,4,5].map(i => (
                    <div key={i} className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full bg-border animate-pulse" />
                      <div className="h-3 bg-border rounded animate-pulse flex-1" />
                    </div>
                  ))}
                </div>
              ) : contextHealth ? (
                <>
                  {/* L3 direction */}
                  <div className="flex items-center gap-2 px-3 py-2">
                    {contextHealth.l3Present
                      ? <CheckCircle2 size={13} className="text-emerald-500 shrink-0" />
                      : <AlertTriangle size={13} className="text-amber-500 shrink-0" />}
                    <span className="text-xs text-text flex-1">L3 project direction</span>
                    {!contextHealth.l3Present && (
                      <button type="button" onClick={() => { onNavigate?.('direction'); onClose(); }}
                        className="text-[10px] text-accent hover:text-accent-hover transition-colors shrink-0">
                        Configure &rarr;
                      </button>
                    )}
                  </div>

                  {/* Git memory */}
                  <div
                    className={`flex items-center gap-2 px-3 py-2 ${contextHealth.gitMemoryCount === 0 && !hydratingGit ? 'cursor-pointer hover:bg-accent/5 transition-colors' : ''}`}
                    onClick={contextHealth.gitMemoryCount === 0 && !hydratingGit ? handleHydrateGit : undefined}
                  >
                    {contextHealth.gitMemoryCount > 0
                      ? <CheckCircle2 size={13} className="text-emerald-500 shrink-0" />
                      : <AlertTriangle size={13} className="text-amber-500 shrink-0" />}
                    <span className="text-xs text-text flex-1 flex items-center gap-1">
                      {contextHealth.gitMemoryCount > 0
                        ? `Git memory (${contextHealth.gitMemoryCount} commits)`
                        : <>No git memory &mdash; click to hydrate{hydratingGit && <Loader2 size={10} className="animate-spin ml-1" />}</>}
                    </span>
                  </div>

                  {/* Schema snapshot */}
                  <div className="flex items-center gap-2 px-3 py-2">
                    {contextHealth.schemaPresent
                      ? <CheckCircle2 size={13} className="text-emerald-500 shrink-0" />
                      : <AlertTriangle size={13} className="text-amber-500 shrink-0" />}
                    <span className="text-xs text-text flex-1">Schema snapshot</span>
                    {!contextHealth.schemaPresent && (
                      <button type="button" onClick={async () => {
                        try { await apiFetch(`/api/workspaces/${workspaceId}/hydrate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ types: ['schema'] }) }); const res = await apiFetch<ContextHealth>(`/api/workspaces/${workspaceId}/context-health`); setContextHealth(res); } catch { /* silent */ }
                      }} className="text-[10px] text-accent hover:text-accent-hover transition-colors shrink-0">
                        Hydrate &rarr;
                      </button>
                    )}
                  </div>

                  {/* CLAUDE.md */}
                  <div className="flex items-center gap-2 px-3 py-2">
                    {contextHealth.claudeMdPresent
                      ? <CheckCircle2 size={13} className="text-emerald-500 shrink-0" />
                      : <AlertTriangle size={13} className="text-amber-500 shrink-0" />}
                    <span className="text-xs text-text flex-1">CLAUDE.md</span>
                    {!contextHealth.claudeMdPresent && (
                      <button type="button" onClick={() => { onNavigate?.('settings'); onClose(); }}
                        className="text-[10px] text-accent hover:text-accent-hover transition-colors shrink-0">
                        Settings &rarr;
                      </button>
                    )}
                  </div>

                  {/* Skills */}
                  <div className="flex items-center gap-2 px-3 py-2">
                    {contextHealth.skillsCount > 0
                      ? <CheckCircle2 size={13} className="text-emerald-500 shrink-0" />
                      : <AlertTriangle size={13} className="text-amber-500 shrink-0" />}
                    <span className="text-xs text-text flex-1">
                      {contextHealth.skillsCount > 0 ? `${contextHealth.skillsCount} skill${contextHealth.skillsCount !== 1 ? 's' : ''} installed` : 'No skills installed'}
                    </span>
                    {contextHealth.skillsCount === 0 && (
                      <button type="button" onClick={() => { onNavigate?.('marketplace' as PanelId); onClose(); }}
                        className="text-[10px] text-accent hover:text-accent-hover transition-colors shrink-0">
                        Marketplace &rarr;
                      </button>
                    )}
                  </div>
                </>
              ) : null}
            </div>
          )}
        </div>
      )}

      {/* Generate + Quick Run buttons */}
      {(!generatedSpec || isGenerating) && (
        <div className="space-y-2">
          {isGenerating || (generateError && !generatedSpec) ? (
            <SpecForgeProgress isActive={isGenerating} onCancel={handleCancel} error={generateError} apiDone={apiDone} multiPass={false} specSlug={effectiveSlug} onRetry={handleRetry} onRetryWithModel={handleRetryWithModel} model={selectedModel || defaultModelId || 'claude-sonnet-4-6'} provider={activeProvider} hasAttachments={pendingAttachments.length > 0 || savedAttachments.length > 0} />
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

      {/* Auto-match / auto-suggest loading indicators */}
      {autoMatchStatus === 'matching' && (
        <div className="flex items-center gap-1.5 px-1">
          <Loader2 size={10} className="animate-spin text-muted" />
          <span className="text-[11px] text-muted">
            {skillsCount && skillsCount > 0 ? 'Matching skills...' : 'No skills to match'}
          </span>
        </div>
      )}
      {autoMatchStatus === 'suggesting' && (
        <div className="flex items-center gap-1.5 px-1">
          <Loader2 size={10} className="animate-spin text-muted" />
          <span className="text-[11px] text-muted">Suggesting models...</span>
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
                    <span className={`absolute top-0.5 left-0.5 w-3.5 h-3.5 rounded-full bg-switch-knob transition-transform ${overrideAgent ? 'translate-x-[14px]' : ''}`} />
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
                <p className="mt-1.5 text-[11px] text-muted/70">
                  Showing the full model catalog. Configured providers: {configuredProviders.length > 0 ? configuredProviders.join(', ') : 'none'}.
                </p>
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
                      aria-label="Custom story count"
                      className="w-16 px-2 py-2 text-sm bg-panel border border-border rounded text-text outline-none focus:border-accent transition-colors text-center" autoFocus />
                  )}
                </div>
              </div>

              {/* Reasoning Mode — only shown when selected model supports reasoning */}
              {reasoningCapability.supportsReasoning && (
                <div className="border-t border-border mt-4 pt-4 space-y-3">
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted">Reasoning Mode</span>

                  {/* Enable/disable toggle */}
                  <label className="flex items-center gap-2 cursor-pointer group">
                    <button type="button" role="switch" aria-checked={reasoningEnabled} onClick={() => setReasoningEnabled(v => !v)}
                      className={`relative w-8 h-[18px] rounded-full transition-colors ${reasoningEnabled ? 'bg-accent' : 'bg-border group-hover:bg-muted/40'}`}>
                      <span className={`absolute top-0.5 left-0.5 w-3.5 h-3.5 rounded-full bg-switch-knob transition-transform ${reasoningEnabled ? 'translate-x-[14px]' : ''}`} />
                    </button>
                    <span className="text-xs font-medium text-text">Enable reasoning</span>
                    {reasoningCapability.reasoningType === 'anthropic-thinking' && (
                      <span className="text-[10px] text-muted">(extended thinking)</span>
                    )}
                    {/* Cost impact label — shown when reasoning is enabled */}
                    {reasoningEnabled && (() => {
                      const effectiveEffort = effortIsAuto
                        ? (autoEffortResult?.effort ?? reasoningEffort)
                        : reasoningEffort;
                      const multiplier = reasoningCapability.costMultiplier
                        ? (reasoningCapability.costMultiplier[effectiveEffort] ?? reasoningCapability.costMultiplier['default'])
                        : undefined;
                      return multiplier !== undefined
                        ? <span className="ml-auto text-[10px] font-medium text-amber-400/80">~{multiplier}x base cost</span>
                        : <span className="ml-auto text-[10px] text-muted/60">Cost impact unknown</span>;
                    })()}
                  </label>

                  {/* Effort level segmented control — only when enabled and effortLevels available */}
                  {reasoningEnabled && reasoningCapability.effortLevels.length > 0 && (
                    <div className="ml-10 space-y-1.5">
                      <label className="block text-xs font-medium text-muted">Effort Level</label>
                      <div className="flex gap-1">
                        {/* Auto chip — computes effort from spec size */}
                        <button
                          key="auto"
                          type="button"
                          onClick={() => { setEffortIsAuto(true); setReasoningEffort('medium'); }}
                          className={`px-2.5 py-1 text-xs rounded transition-colors ${effortIsAuto ? 'bg-accent text-white' : 'bg-panel border border-border text-text hover:border-accent/50'}`}
                        >
                          Auto
                        </button>
                        {reasoningCapability.effortLevels.map(level => (
                          <button key={level} type="button" onClick={() => { setEffortIsAuto(false); setReasoningEffort(level); }}
                            className={`px-2.5 py-1 text-xs rounded capitalize transition-colors ${!effortIsAuto && reasoningEffort === level ? 'bg-accent text-white' : 'bg-panel border border-border text-text hover:border-accent/50'}`}>
                            {level}
                          </button>
                        ))}
                      </div>
                      {/* Auto-effort rationale banner */}
                      {effortIsAuto && autoEffortResult && (
                        <div className="mt-2 px-3 py-2 rounded bg-accent/10 border border-accent/20 text-xs text-text leading-relaxed">
                          {autoEffortResult.rationale}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Skills & Models */}
              <div className="border-t border-border mt-4 pt-4 space-y-3">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted">Skills &amp; Models</span>

                {/* Toggle: Auto-match skills */}
                <label className="flex items-center gap-2 cursor-pointer group">
                  <button type="button" role="switch" aria-checked={autoMatchSkills} onClick={() => setAutoMatchSkills(v => !v)}
                    className={`relative w-8 h-[18px] rounded-full transition-colors ${autoMatchSkills ? 'bg-accent' : 'bg-border group-hover:bg-muted/40'}`}>
                    <span className={`absolute top-0.5 left-0.5 w-3.5 h-3.5 rounded-full bg-switch-knob transition-transform ${autoMatchSkills ? 'translate-x-[14px]' : ''}`} />
                  </button>
                  <span className="text-xs font-medium text-text">Auto-match skills after generation</span>
                </label>

                {/* Toggle: Auto-suggest models */}
                <label className="flex items-center gap-2 cursor-pointer group">
                  <button type="button" role="switch" aria-checked={autoSuggestModels} onClick={() => setAutoSuggestModels(v => !v)}
                    className={`relative w-8 h-[18px] rounded-full transition-colors ${autoSuggestModels ? 'bg-accent' : 'bg-border group-hover:bg-muted/40'}`}>
                    <span className={`absolute top-0.5 left-0.5 w-3.5 h-3.5 rounded-full bg-switch-knob transition-transform ${autoSuggestModels ? 'translate-x-[14px]' : ''}`} />
                  </button>
                  <span className="text-xs font-medium text-text">Auto-suggest models per story</span>
                </label>
              </div>
            </div>
          )}
        </section>
      )}

      {/* Context summary card — persists after generation, collapsed */}
      {generatedSpec?.contextSummary && !isGenerating && (
        <ContextSummaryCard summary={generatedSpec.contextSummary} />
      )}

      {/* Post-generation preview */}
      {generatedSpec && !isGenerating && (
        <SpecForgePreview
          spec={generatedSpec} workspaceId={workspaceId ?? ''} onRegenerate={handleGenerate}
          onEditBrief={() => { setGeneratedSpec(null); setGenerateError(null); setApiDone(false); setTimeout(() => briefRef.current?.focus(), 50); }}
          isRegenerating={isGenerating} onNavigate={onNavigate}
          onNavigateToRun={(runId) => { onClose(); onNavigateToRun?.(runId); }}
          onReset={() => { setGeneratedSpec(null); setGenerateError(null); setApiDone(false); setSpecBrief(''); setPendingAttachments([]); setTimeout(() => briefRef.current?.focus(), 50); }}
          modelSuggestions={modelSuggestions}
          onModelAccepted={handleModelAccepted}
        />
      )}

      {showTemplatePicker && (
        <TemplatePickerModal onClose={() => setShowTemplatePicker(false)}
          onSelect={(tpl) => { setSpecBrief(tpl.brief); setStoryCount(tpl.storyCount); setShowTemplatePicker(false); setTimeout(() => briefRef.current?.focus(), 50); }} />
      )}
    </div>
  );
}
