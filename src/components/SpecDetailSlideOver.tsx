/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * SpecDetailSlideOver — Single source of truth for spec review UI.
 *
 * Slides in from the right (480px desktop, full-width mobile).
 * Tabs: Stories (default), History, Dependencies, Raw JSON.
 * Actions: Approve, Reject, Run, Fork, Export, Delete.
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  X, Clock, CheckCircle2, XCircle, AlertCircle,
  Download, Copy, Check, Play, GitFork, GitBranch,
  Loader2, Plus, Sparkles, Trash2, History, FileSearch, Paperclip,
  FileText, FileImage, File, ZoomIn, Cpu, Globe, RotateCcw,
} from 'lucide-react';
import type { Attachment } from '../types/attachment';
import { BASE_URL } from '../lib/apiFetch';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useAuth } from '../contexts/AuthContext';
import { useGlobalToast } from '../contexts/ToastContext';
import { apiFetch } from '../lib/apiFetch';
import {
  getSpecReadinessInspection,
  getSpecWorkflow,
  retrySpecWorkflowStage,
} from '../api/specs';
import { StoryCard } from './StoryCard';
import type { Story } from './StoryCard';
import { InlineStoryEditor } from './InlineStoryEditor';
import { StoryComments } from './StoryComments';
import { GraphTabWithSubTabs } from './GraphTabWithSubTabs';
import MermaidDiagram from './MermaidDiagram';
import { SpecVersionHistory } from './SpecVersionHistory';
import { TagChips } from './TagChips';
import TriggerPopover from './TriggerPopover';
import PreFlightGraph from './PreFlightGraph';
import { ImagePreviewModal } from './ImagePreviewModal';
import type { PanelId } from './Sidebar';
import ContextSummaryCard from './ContextSummaryCard';
import type { ContextSummary } from '../panels/SpecForgeOutput';
import { SpecModelControlBar } from './SpecModelControlBar';
import type { SpecModelFields } from './SpecModelControlBar';
import type { EngineValue } from './EngineSelector';
import { isRunStatusBlocking } from '../lib/kanbanRunStatus';
import { SpecReadinessReasonCode } from '../lib/readinessReasonCodes';
import type {
  SpecReadinessInspectionPayload,
  SpecWorkflowInspectionPayload,
  SpecWorkflowStageSnapshot,
  WorkflowActionHint,
  WorkflowActionKey,
  WorkflowStageKey,
} from '../lib/specWorkflow';
import { useWalSSE, type WalEvent } from '../hooks/useWalSSE';

/* ─── Types ───────────────────────────────────────────────────────── */

type SpecStatus = 'pending' | 'approved' | 'rejected' | 'completed';
export type PreviewTab = 'stories' | 'history' | 'context' | 'skills' | 'graph' | 'diagram' | 'json' | 'attachments';

export interface SpecSlideOverSummary {
  id: string;
  specName: string;
  storyCount: number;
  status: SpecStatus;
  generatedAt: string;
  approvedAt?: string;
  rejectedAt?: string;
  rejectReason?: string;
  tags: string[];
  model?: string;
  reviewStatus?: string;
  repoName?: string;
  branchName?: string;
}

interface SpecDetailData {
  title?: string;
  userStories?: Story[];
  stories?: Story[];
  diagrams?: Record<string, { mermaid?: string; ascii?: string }>;
  mermaidDiagram?: string;
  model?: string;
  agentOverride?: EngineValue | null;
  thinkingEnabled?: boolean;
  thinkingBudget?: number;
  effortLevel?: 'low' | 'medium' | 'high' | 'max' | 'xhigh';
  reasoning?: { enabled: boolean; effort?: string };
  readinessPercent?: number;
  [key: string]: unknown;
}

interface ArchiveResponse {
  items: SpecSlideOverSummary[];
  total: number;
  hasMore: boolean;
  cursor?: string;
}

/* ─── Status Config ───────────────────────────────────────────────── */

const STATUS_CONFIG: Record<SpecStatus, { label: string; className: string }> = {
  completed: { label: 'COMPLETED', className: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' },
  approved: { label: 'APPROVED', className: 'bg-success/15 text-success border-success/30' },
  pending: { label: 'PENDING', className: 'bg-warning/15 text-warning border-warning/30' },
  rejected: { label: 'REJECTED', className: 'bg-error/15 text-error border-error/30' },
};

/* ─── Helpers ─────────────────────────────────────────────────────── */

function formatDate(iso: string): string {
  try { return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }); }
  catch { return iso; }
}

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function humanizeCode(code: string): string {
  return code
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function extractDiagramText(spec: SpecDetailData): { text: string; type: 'mermaid' | 'ascii' } | null {
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

/* ─── Props ───────────────────────────────────────────────────────── */

export interface SpecDetailSlideOverProps {
  isOpen: boolean;
  specId: string | null;
  initialSummary?: SpecSlideOverSummary | null;
  /** Which tab to open initially (defaults to 'stories') */
  initialTab?: PreviewTab;
  onClose: () => void;
  onNavigate?: (panel: PanelId) => void;
  onNavigateToRun?: (runId: number) => void;
  /** Called when spec is deleted so parent can remove it from lists */
  onDeleted?: (specId: string) => void;
  /** Called when tags change so parent can sync */
  onTagsChange?: (specId: string, tags: string[]) => void;
  /** Called when spec is approved so parent can update status */
  onApproved?: (specId: string) => void;
  /** Called when spec is rejected so parent can update */
  onRejected?: (specId: string) => void;
  /** Active run status — disables Enrich/repair controls when running or queued */
  activeRunStatus?: 'running' | 'queued';
}

/* ─── Spec Skills Tab ─────────────────────────────────────────────── */

interface SuggestedSkill { name: string; relevance?: number; reason?: string; }

function SpecSkillsTab({ stories, workspaceId }: { stories: Story[]; workspaceId: string }) {
  const [installedNames, setInstalledNames] = useState<Set<string>>(new Set());
  const [loadingInstalled, setLoadingInstalled] = useState(true);

  useEffect(() => {
    if (!workspaceId) return;
    apiFetch<{ items: { name: string }[] }>(`/api/skills?workspaceId=${workspaceId}`)
      .then(d => setInstalledNames(new Set((d.items ?? []).map((s: any) => s.name))))
      .catch(() => {})
      .finally(() => setLoadingInstalled(false));
  }, [workspaceId]);

  // Normalize a skill entry — may be a plain string or an object
  const toSkill = (raw: unknown): SuggestedSkill =>
    typeof raw === 'string' ? { name: raw } : (raw as SuggestedSkill);

  // Collect all suggested skills across stories, deduplicate by name
  const byStory: { storyId: string; storyTitle: string; skills: SuggestedSkill[] }[] = useMemo(() =>
    stories
      .map(s => ({
        storyId: s.id,
        storyTitle: s.title,
        skills: ((s as any).suggestedSkills ?? []).map(toSkill) as SuggestedSkill[],
      }))
      .filter(s => s.skills.length > 0),
    [stories],
  );

  const allSkills = useMemo(() => {
    const map = new Map<string, SuggestedSkill & { storyCount: number }>();
    for (const story of byStory) {
      for (const sk of story.skills) {
        const existing = map.get(sk.name);
        if (existing) { existing.storyCount++; }
        else { map.set(sk.name, { ...sk, storyCount: 1 }); }
      }
    }
    return Array.from(map.values()).sort((a, b) => b.storyCount - a.storyCount);
  }, [byStory]);

  if (loadingInstalled) {
    return <div className="flex-1 flex items-center justify-center text-muted text-sm gap-2"><Loader2 size={14} className="animate-spin" />Loading…</div>;
  }

  if (allSkills.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center text-muted">
        <Sparkles size={28} className="opacity-30" />
        <p className="text-sm font-medium">No skills matched to this spec yet</p>
        <p className="text-xs">Generate the spec with skill matching enabled, or use Match Skills from the Marketplace tab.</p>
      </div>
    );
  }

  const installed = allSkills.filter(s => installedNames.has(s.name));
  const notInstalled = allSkills.filter(s => !installedNames.has(s.name));

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {/* Summary badges */}
      <div className="flex items-center gap-2 text-xs text-muted flex-wrap">
        <span>{allSkills.length} skills suggested</span>
        <span className="text-emerald-500">{installed.length} installed</span>
        {notInstalled.length > 0 && <span className="text-amber-500">{notInstalled.length} not installed</span>}
      </div>

      {/* Installed */}
      {installed.length > 0 && (
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted mb-2">Installed — ready to inject</div>
          <div className="space-y-1.5">
            {installed.map(sk => (
              <div key={sk.name} className="flex items-start gap-2 p-2 rounded bg-emerald-500/5 border border-emerald-500/15">
                <CheckCircle2 size={13} className="text-emerald-500 mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono font-medium">{sk.name}</span>
                    {sk.relevance != null && <span className="text-[10px] text-emerald-500">{sk.relevance}/10</span>}
                    <span className="text-[10px] text-muted ml-auto">{sk.storyCount} {sk.storyCount === 1 ? 'story' : 'stories'}</span>
                  </div>
                  {sk.reason && <p className="text-[11px] text-muted mt-0.5 leading-relaxed">{sk.reason}</p>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Not installed */}
      {notInstalled.length > 0 && (
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted mb-2">Not installed — install from Marketplace</div>
          <div className="space-y-1.5">
            {notInstalled.map(sk => (
              <div key={sk.name} className="flex items-start gap-2 p-2 rounded bg-panel border border-border/50">
                <AlertCircle size={13} className="text-amber-500 mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono font-medium text-muted">{sk.name}</span>
                    {sk.relevance != null && <span className="text-[10px] text-muted">{sk.relevance}/10</span>}
                    <span className="text-[10px] text-muted ml-auto">{sk.storyCount} {sk.storyCount === 1 ? 'story' : 'stories'}</span>
                  </div>
                  {sk.reason && <p className="text-[11px] text-muted/70 mt-0.5 leading-relaxed">{sk.reason}</p>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Per-story breakdown */}
      {byStory.length > 0 && (
        <details className="group">
          <summary className="text-[10px] font-semibold uppercase tracking-wide text-muted cursor-pointer select-none hover:text-[var(--text)] transition-colors">
            Per-story breakdown
          </summary>
          <div className="mt-2 space-y-2">
            {byStory.map(story => (
              <div key={story.storyId} className="p-2 rounded bg-panel border border-border/40">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="font-mono text-[10px] text-muted">{story.storyId}</span>
                  <span className="text-xs truncate">{story.storyTitle}</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {story.skills.map(sk => (
                    <span key={sk.name} className={`text-[10px] font-mono px-1.5 py-0.5 rounded-full ${installedNames.has(sk.name) ? 'bg-emerald-500/10 text-emerald-500' : 'bg-gray-500/10 text-gray-400'}`}>
                      {sk.name}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

/* ─── Main Component ──────────────────────────────────────────────── */

export default function SpecDetailSlideOver({
  isOpen,
  specId,
  initialSummary,
  initialTab,
  onClose,
  onNavigate,
  onNavigateToRun,
  onDeleted,
  onTagsChange,
  onApproved,
  onRejected,
  activeRunStatus,
}: SpecDetailSlideOverProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Backdrop click — only close when clicking the backdrop itself, not portals rendered outside the panel
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('backdrop-blur-sm')) {
      onClose();
    }
  };

  if (!isOpen || !specId) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex justify-end"
      onClick={handleBackdropClick}
      aria-modal="true"
      role="dialog"
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity" />

      {/* Panel — 800px desktop, full-width mobile */}
      <div
        ref={panelRef}
        className="relative flex flex-col w-full max-w-[800px] h-full bg-bg border-l border-border animate-slideInRight shadow-[0_0_64px_rgba(0,0,0,0.8)]"
      >
        <SpecDetailContent
          specId={specId}
          initialSummary={initialSummary ?? null}
          initialTab={initialTab}
          onClose={onClose}
          onNavigate={onNavigate}
          onNavigateToRun={onNavigateToRun}
          onDeleted={onDeleted}
          onTagsChange={onTagsChange}
          onApproved={onApproved}
          onRejected={onRejected}
          activeRunStatus={activeRunStatus}
        />
      </div>
    </div>,
    document.body,
  );
}

/* ─── Content (inner component, always mounted when open) ─────────── */

function SpecDetailContent({
  specId,
  initialSummary,
  initialTab,
  onClose,
  onNavigate,
  onNavigateToRun: _onNavigateToRun,
  onDeleted,
  onTagsChange,
  onApproved,
  onRejected,
  activeRunStatus,
}: {
  specId: string;
  initialSummary: SpecSlideOverSummary | null;
  initialTab?: PreviewTab;
  onClose: () => void;
  onNavigate?: (panel: PanelId) => void;
  onNavigateToRun?: (runId: number) => void;
  onDeleted?: (specId: string) => void;
  onTagsChange?: (specId: string, tags: string[]) => void;
  onApproved?: (specId: string) => void;
  onRejected?: (specId: string) => void;
  activeRunStatus?: 'running' | 'queued';
}) {
  const { workspaceId } = useWorkspace();
  const { user } = useAuth();
  const toast = useGlobalToast();
  const userPlan = user?.app_metadata?.plan as string | undefined;
  const isFreePlan = !userPlan || userPlan === 'free';

  // Summary + detail
  const [summary, setSummary] = useState<SpecSlideOverSummary | null>(initialSummary);
  const [detail, setDetail] = useState<SpecDetailData | null>(null);
  const [detailLoading, setDetailLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<PreviewTab>(initialTab ?? 'stories');

  // Stories
  const [localStories, setLocalStories] = useState<Story[]>([]);
  const storiesInitialized = useRef(false);

  // Run state
  const [runState, setRunState] = useState<'idle' | 'triggering' | 'conflict' | 'queued' | 'success' | 'error'>('idle');
  const [queuePosition, setQueuePosition] = useState(0);
  const [runError, setRunError] = useState('');
  const [showTriggerPopover, setShowTriggerPopover] = useState(false);
  const [hasActiveRun, setHasActiveRun] = useState(false);

  // Branch isolation preference (persisted to spec JSON)
  const [isolateInBranch, setIsolateInBranch] = useState(true);

  // Add stories
  const [addState, setAddState] = useState<'idle' | 'form' | 'generating' | 'done' | 'error'>('idle');
  const [addCount, setAddCount] = useState(3);
  const [addBrief, setAddBrief] = useState('');
  const [addError, setAddError] = useState('');

  // Fork / Delete
  const [forkState, setForkState] = useState<'idle' | 'forking' | 'done' | 'error'>('idle');
  const [forkError, setForkError] = useState('');
  const [forkId, setForkId] = useState('');
  const [deleteState, setDeleteState] = useState<'idle' | 'confirm' | 'deleting'>('idle');

  // Enrich
  const [enrichState, setEnrichState] = useState<'idle' | 'enriching'>('idle');
  const [enrichRefreshKey, setEnrichRefreshKey] = useState(0);

  // Above-the-fold context summary — parsed from the latest generation log so
  // context usage is visible without opening the Context tab. Null when no
  // persisted context exists yet (older specs predate context logging).
  const [headlineContext, setHeadlineContext] = useState<ContextSummary | null>(null);
  const [workflowInspection, setWorkflowInspection] = useState<SpecWorkflowInspectionPayload | null>(null);
  const [readinessInspection, setReadinessInspection] = useState<SpecReadinessInspectionPayload | null>(null);
  const [activePostSaveJob, setActivePostSaveJob] = useState<CanonicalPostSaveStageState | null>(null);

  // Approve/Reject
  const [actionLoading, setActionLoading] = useState(false);

  // Focus trap ref
  const firstFocusRef = useRef<HTMLButtonElement>(null);
  const liveRefreshTimerRef = useRef<number | null>(null);

  // Auto-focus on mount
  useEffect(() => {
    firstFocusRef.current?.focus();
  }, [specId]);

  // Fetch detail + summary
  useEffect(() => {
    if (!specId || !workspaceId) return;
    let cancelled = false;
    setDetailLoading(true);
    storiesInitialized.current = false; // reset so fresh fetch re-populates stories

    apiFetch<SpecDetailData>(`/api/specs/${specId}?workspaceId=${workspaceId}`)
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
  }, [specId, workspaceId, initialSummary, enrichRefreshKey]);

  // Sync stories from detail — only on initial load, not on spec-level field updates
  // (spec model/engine changes update `detail` but should not clobber story model overrides)
  useEffect(() => {
    const raw = detail?.userStories ?? detail?.stories ?? [];
    const incoming = raw.map((s: any) => ({
      ...s,
      acceptanceCriteria: s.acceptanceCriteria ?? s.steps ?? (s.acceptance ? [s.acceptance] : []),
    }));
    if (!storiesInitialized.current && incoming.length > 0) {
      setLocalStories(incoming);
      storiesInitialized.current = true;
    }
  }, [detail]);

  // Sync autoWorktree from detail (default true for specs without the field)
  useEffect(() => { setIsolateInBranch(detail?.autoWorktree !== false); }, [detail]);

  // Reset tab on spec change
  useEffect(() => { setActiveTab(initialTab ?? 'stories'); }, [specId, initialTab]);

  // Fetch the latest generation log for rich context summary rendering, plus the
  // exact workflow/readiness surfaces so UI state does not depend on log parsing.
  useEffect(() => {
    if (!specId || !workspaceId) return;
    let cancelled = false;

    Promise.all([
      apiFetch<GenerationLog | { logs: GenerationLog[] }>(`/api/specs/${specId}/generation-log`).catch(() => null),
      getSpecWorkflow(specId, workspaceId).catch(() => null),
      getSpecReadinessInspection(specId, workspaceId).catch(() => null),
    ]).then(([logResponse, workflowResponse, readinessResponse]) => {
      if (cancelled) return;
      const latest = logResponse && 'logs' in logResponse ? logResponse.logs[0] : logResponse;
      setHeadlineContext(latest ? parseContextSummary(latest as GenerationLog) : null);
      setWorkflowInspection(workflowResponse);
      setReadinessInspection(readinessResponse);
      setActivePostSaveJob(getCurrentPostSaveStateFromWorkflow(workflowResponse));
    }).catch(() => {
      if (!cancelled) {
        setHeadlineContext(null);
        setWorkflowInspection(null);
        setReadinessInspection(null);
        setActivePostSaveJob(null);
      }
    });

    return () => { cancelled = true; };
  }, [specId, workspaceId, enrichRefreshKey]);

  useEffect(() => () => {
    if (liveRefreshTimerRef.current !== null) {
      window.clearTimeout(liveRefreshTimerRef.current);
    }
  }, []);

  useWalSSE((event) => {
    if (!workspaceId || !specId) return;
    if (!shouldRefreshSpecDetailFromWalEvent(event, specId, workspaceId)) return;
    if (liveRefreshTimerRef.current !== null) {
      window.clearTimeout(liveRefreshTimerRef.current);
    }
    liveRefreshTimerRef.current = window.setTimeout(() => {
      setEnrichRefreshKey((value) => value + 1);
    }, 200);
  });

  // Check if workspace has an active run (so we can show Queue button upfront)
  useEffect(() => {
    if (!workspaceId) return;
    apiFetch<{ items: Array<{ status: string }> }>(`/api/pipeline/runs?workspaceId=${workspaceId}&limit=5`)
      .then(res => setHasActiveRun(res.items?.some(r => r.status === 'running' || r.status === 'paused') ?? false))
      .catch(() => { /* ignore */ });
  }, [workspaceId, enrichRefreshKey]);

  /* ─── Actions ─────────────────────────────────────────────────────── */

  const handleApprove = async () => {
    if (!workspaceId) return;
    setActionLoading(true);
    try {
      await apiFetch(`/api/specs/${specId}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId }) });
      toast.show('Spec approved', 'success');
      setSummary(prev => prev ? { ...prev, status: 'approved' as SpecStatus } : prev);
      onApproved?.(specId);
    } catch (err: unknown) { toast.show(err instanceof Error ? err.message : 'Approve failed', 'error'); }
    finally { setActionLoading(false); }
  };

  const handleReject = async () => {
    if (!workspaceId) return;
    setActionLoading(true);
    try {
      await apiFetch(`/api/specs/${specId}/reject`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId }) });
      toast.show('Spec rejected', 'success');
      onRejected?.(specId);
      onClose();
    } catch (err: unknown) { toast.show(err instanceof Error ? err.message : 'Reject failed', 'error'); }
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

  const handleRun = async (autoWorktree: boolean, options?: { forceSequential?: boolean; queue?: boolean; autoMerge?: boolean; mergeStrategy?: 'direct' | 'pr' | 'draft-pr' | 'branch-only'; includeGraph?: boolean; effortLevel?: 'low' | 'medium' | 'high' | 'max' | 'xhigh'; thinkingEnabled?: boolean; thinkingBudget?: number; reasoningOverride?: { enabled: boolean; effort?: string }; forceRerun?: boolean; readinessOverride?: boolean }) => {
    if (!workspaceId || !summary) return;
    setShowTriggerPopover(false);
    setRunState('triggering');
    setRunError('');
    try {
      const res = await apiFetch<{ ok?: boolean; conflict?: boolean; activeRunId?: number; runId?: number; queued?: boolean; position?: number }>(
        '/api/pipeline/trigger',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          specPath: `forge/specs/approved/${summary.id}.json`, workspaceId, autoWorktree,
          ...(options?.forceSequential ? { forceSequential: true } : {}),
          ...(options?.queue ? { queue: true } : {}),
          ...(autoWorktree && options?.autoMerge !== undefined ? { autoMerge: options.autoMerge } : {}),
          ...(autoWorktree && options?.mergeStrategy ? { mergeStrategy: options.mergeStrategy } : {}),
          ...(options?.includeGraph ? { includeGraph: true } : {}),
          ...(options?.effortLevel ? { effortLevel: options.effortLevel } : {}),
          ...(options?.thinkingEnabled !== undefined ? { thinkingEnabled: options.thinkingEnabled } : {}),
          ...(options?.thinkingBudget !== undefined ? { thinkingBudget: options.thinkingBudget } : {}),
          ...(options?.reasoningOverride !== undefined ? { reasoning: options.reasoningOverride } : {}),
          ...(options?.forceRerun ? { forceRerun: true } : {}),
          ...(options?.readinessOverride ? { readinessOverride: true } : {}),
        }) },
      );
      if (res.conflict) setRunState('conflict');
      else if (res.queued) { setQueuePosition(res.position ?? 1); setRunState('queued'); setTimeout(() => { onClose(); onNavigate?.('runs'); }, 2000); }
      else { setRunState('success'); setTimeout(() => { onClose(); onNavigate?.('runs'); }, 1200); }
    } catch (err) { setRunError(err instanceof Error ? err.message : 'Failed to trigger run'); setRunState('error'); }
  };

  const handleToggleIsolation = async (enabled: boolean) => {
    setIsolateInBranch(enabled);
    if (!workspaceId || !specId) return;
    try {
      await apiFetch(`/api/specs/${specId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, autoWorktree: enabled }),
      });
    } catch {
      setIsolateInBranch(!enabled); // revert on failure
    }
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
    if (!summary || !workspaceId) return;
    setDeleteState('deleting');
    try {
      await apiFetch(`/api/specs/${summary.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId }) });
      toast.show(`Spec "${summary.specName}" deleted`, 'success');
      onDeleted?.(specId);
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

  const handleEnrich = async () => {
    if (!workspaceId) return;
    setEnrichState('enriching');
    try {
      // Backend contract: { success, retrieval_method, storiesEnriched }. We only
      // read this lightweight metadata — never any raw retrieval blob — so the
      // Context tab summary refresh stays compare/replay/export safe.
      const res = await apiFetch<{ success?: boolean; retrieval_method?: string; storiesEnriched?: number }>(
        `/api/specs/${specId}/enrich`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId }),
        },
      );
      const method = res.retrieval_method ?? 'direction-only';
      const count = res.storiesEnriched ?? 0;
      toast.show(
        count > 0
          ? `Enriched ${count} ${count === 1 ? 'story' : 'stories'} via ${method}`
          : `Spec enriched via ${method}`,
        'success',
      );
      // Refresh the headline + Context tab summary so the new retrieval badge and
      // per-story annotations appear without a manual reload.
      setEnrichRefreshKey(k => k + 1);
    } catch (err: unknown) {
      toast.show(err instanceof Error ? err.message : 'Enrichment failed', 'error');
    } finally {
      setEnrichState('idle');
    }
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

  /* ─── Derived data ──────────────────────────────────────────────── */

  const stories = localStories;
  const diagram = detail ? extractDiagramText(detail) : null;
  const deferredCount = stories.filter(s => s.excluded && !s.passes).length;
  const allPassed = stories.length > 0 && stories.every(s => s.passes === true);
  const cfg = summary ? STATUS_CONFIG[summary.status] : null;
  const isDraft = summary?.status === 'pending';
  const canRun = summary?.status === 'approved' || summary?.status === 'completed';
  const runAllowed = canRun && (readinessInspection ? workflowTopLevelActionAllowed(workflowInspection, readinessInspection, 'run') : true);
  const runAnywayAllowed = canRun && workflowTopLevelActionAllowed(workflowInspection, readinessInspection, 'run_anyway');
  const hasBlockingPostSaveJob = activePostSaveJob !== null;
  const postSaveBlockCopy = activePostSaveJob ? postSaveActiveJobCopy(activePostSaveJob) : null;

  const specSkillCount = useMemo(() => {
    const seen = new Set<string>();
    for (const s of stories) {
      for (const sk of (s as any).suggestedSkills ?? []) seen.add(sk.name ?? sk);
    }
    return seen.size;
  }, [stories]);

  // Skill relevance details for the above-the-fold context card — derived from
  // story suggestedSkills (max relevance per unique name).
  const headlineSkillDetails = useMemo(() => {
    const toSkill = (raw: unknown): SuggestedSkill =>
      typeof raw === 'string' ? { name: raw } : (raw as SuggestedSkill);
    const map = new Map<string, SuggestedSkill>();
    for (const story of stories) {
      for (const raw of ((story as any).suggestedSkills ?? [])) {
        const sk = toSkill(raw);
        const existing = map.get(sk.name);
        if (!existing || (sk.relevance ?? 0) > (existing.relevance ?? 0)) {
          map.set(sk.name, sk);
        }
      }
    }
    return Array.from(map.values());
  }, [stories]);

  const tabs: { id: PreviewTab; label: string; badge?: string; icon?: typeof History }[] = [
    { id: 'stories', label: 'Stories', badge: `${stories.length}` },
    { id: 'history', label: 'History', icon: History },
    { id: 'context', label: 'Context', icon: FileSearch },
    { id: 'skills', label: 'Skills', badge: specSkillCount > 0 ? `${specSkillCount}` : undefined },
    { id: 'graph', label: 'Graph' },
    { id: 'diagram', label: 'Dependencies' },
    { id: 'json', label: 'Raw JSON' },
    { id: 'attachments', label: 'Attachments', icon: Paperclip },
  ];

  /* ─── Render ────────────────────────────────────────────────────── */

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
          <button ref={firstFocusRef} onClick={onClose} aria-label="Close spec detail" className="p-1 rounded text-muted hover:text-text hover:bg-panel transition-colors shrink-0">
            <X size={16} />
          </button>
        </div>
        {summary && (
          <div className="flex items-center gap-3 text-xs text-muted">
            <span className="flex items-center gap-1"><Clock size={10} />{formatDate(summary.generatedAt)}</span>
            <span>{summary.storyCount} {summary.storyCount === 1 ? 'story' : 'stories'}</span>
            {(detail?.model ?? summary.model) && (
              <span className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-panel border border-border">
                {detail?.model ?? summary.model}
              </span>
            )}
            {(detail?.browserMcp as boolean) === true && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-purple-500/10 text-purple-400 border border-purple-500/20">
                <Globe className="w-3 h-3" />
                Browser MCP
              </span>
            )}
          </div>
        )}

        {/* Approve/Reject for pending specs */}
        {isDraft && (
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

        {/* Tags */}
        {summary && workspaceId && (
          <div className="mt-2">
            <TagChips specId={specId} workspaceId={workspaceId} tags={summary.tags ?? []}
              onTagsChange={(newTags) => {
                setSummary(prev => prev ? { ...prev, tags: newTags } : prev);
                onTagsChange?.(specId, newTags);
              }} />
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
        <div className="flex-1 flex items-center justify-center text-muted text-sm">
          <Loader2 size={16} className="animate-spin mr-2" />Loading spec...
        </div>
      ) : !detail ? (
        <div className="flex-1 flex items-center justify-center text-muted text-sm">Failed to load spec detail</div>
      ) : (
        <>
          {/* Above-the-fold context summary — visible regardless of active tab
              whenever persisted context exists, so users see direction layers,
              skill relevance, and injected files without opening the Context tab. */}
          {headlineContext && (
            <div className="px-4 pt-3 pb-1 shrink-0 border-b border-border">
              <ContextSummaryCard
                summary={headlineContext}
                skillDetails={headlineSkillDetails.length > 0 ? headlineSkillDetails : undefined}
              />
            </div>
          )}

          {/* Tab strip */}
          <div role="tablist" className="flex border-b border-border shrink-0 overflow-x-auto">
            {tabs.map(tab => (
              <button key={tab.id} role="tab" aria-selected={activeTab === tab.id} onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors border-b-2 whitespace-nowrap ${activeTab === tab.id ? 'text-text border-accent' : 'text-muted hover:text-text border-transparent'}`}>
                {tab.icon && <tab.icon size={12} />}
                {tab.label}
                {tab.badge && tab.badge !== '0' && <span className="ml-1 px-1.5 py-0.5 text-[10px] font-semibold rounded-full bg-accent/15 text-accent">{tab.badge}</span>}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div role="tabpanel" className="flex-1 overflow-y-auto">
            {activeTab === 'stories' && workspaceId && (
              <StoriesTabContent stories={stories} specId={specId} workspaceId={workspaceId}
                onToggleExclude={summary?.status === 'approved' ? handleToggleExclude : undefined}
                onStoryUpdated={(updated) => setLocalStories(prev => prev.map(s => s.id === updated.id ? { ...s, ...updated } : s))}
                specModelFields={{
                  agentOverride: detail?.agentOverride,
                  model: detail?.model,
                  thinkingEnabled: detail?.thinkingEnabled,
                  thinkingBudget: detail?.thinkingBudget,
                  effortLevel: detail?.effortLevel,
                  reasoning: detail?.reasoning,
                }}
                onSpecModelUpdated={(fields) => setDetail(prev => prev ? { ...prev, ...fields, model: fields.model ?? undefined } : prev)} />
            )}
            {activeTab === 'history' && workspaceId && <SpecVersionHistory specId={specId} workspaceId={workspaceId} />}
            {activeTab === 'context' && <GenerationLogTab specId={specId} stories={stories} refreshKey={enrichRefreshKey} workspaceId={workspaceId ?? ''} activeRunStatus={activeRunStatus} blockingPostSaveJob={activePostSaveJob} workflowInspection={workflowInspection} readinessInspection={readinessInspection} onWorkflowRefresh={() => setEnrichRefreshKey((value) => value + 1)} onOpenSkillsTab={() => setActiveTab('skills')} />}
            {activeTab === 'skills' && <SpecSkillsTab stories={stories} workspaceId={workspaceId ?? ''} />}
            {activeTab === 'graph' && workspaceId && <GraphTabWithSubTabs specId={specId} workspaceId={workspaceId} />}
            {activeTab === 'diagram' && <MermaidDiagram diagram={diagram} idPrefix="mermaid-slideover" />}
            {activeTab === 'json' && <JsonTab spec={detail} specId={specId} />}
            {activeTab === 'attachments' && <AttachmentsTab specId={specId} />}
          </div>
        </>
      )}

      {/* Footer actions */}
      {detail && (
        <div className="px-4 py-3 border-t border-border shrink-0 bg-bg space-y-2">
          {postSaveBlockCopy && (
            <div className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 flex items-start gap-2" data-testid="post-save-blocking-banner">
              <AlertCircle size={13} className="text-amber-300 mt-0.5 shrink-0" />
              <div className="min-w-0">
                <p className="text-xs font-medium text-amber-300">Post-save job active — standard controls gated</p>
                <p className="text-[10px] text-amber-200/80">{postSaveBlockCopy}</p>
              </div>
            </div>
          )}
          {/* Pre-flight context neighborhood graph */}
          {canRun && workspaceId && summary?.id && (
            <PreFlightGraph
              specSlug={summary.id}
              workspaceId={workspaceId}
              onNavigate={onNavigate}
            />
          )}
          {/* Branch isolation toggle */}
          {canRun && (
            <label className="flex items-center justify-between gap-2 px-1 cursor-pointer">
              <span className="flex items-center gap-1.5 text-xs text-[var(--text)]">
                <GitBranch size={12} className="text-muted" />
                Isolate in branch
              </span>
              <div className="flex items-center gap-2">
                {isolateInBranch && summary?.id && (
                  <span className="text-[10px] font-mono text-muted truncate max-w-[180px]">feat/{summary.id}</span>
                )}
                <button
                  type="button"
                  role="switch"
                  aria-checked={isolateInBranch}
                  onClick={() => handleToggleIsolation(!isolateInBranch)}
                  className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors ${isolateInBranch ? 'bg-accent' : 'bg-[var(--border)]'}`}
                >
                  <span className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${isolateInBranch ? 'translate-x-4' : 'translate-x-0'}`} />
                </button>
              </div>
            </label>
          )}

          {/* Run in Pipeline */}
          {canRun && (runAllowed || runAnywayAllowed) && (
            <div className="relative">
              {runState === 'queued' ? (
                <div className="flex items-center justify-center gap-1.5 w-full py-2 rounded text-sm font-medium bg-amber-500/15 text-amber-400 border border-amber-500/30">
                  <Clock size={14} /> Queued at position {queuePosition} — switching to Runs...
                </div>
              ) : runState === 'success' ? (
                <div className="flex items-center justify-center gap-1.5 w-full py-2 rounded text-sm font-medium bg-success/15 text-success border border-success/30">
                  <Check size={14} /> Switching to Pipeline Monitor...
                </div>
              ) : (
                <>
                  {showTriggerPopover && runAllowed && (
                    <TriggerPopover loading={runState === 'triggering'} onTrigger={handleRun} onClose={() => setShowTriggerPopover(false)}
                      specPath={`forge/specs/approved/${summary!.id}.json`} workspaceId={workspaceId ?? undefined}
                      initialEffortLevel={detail?.effortLevel}
                      initialThinkingEnabled={detail?.thinkingEnabled}
                      initialThinkingBudget={detail?.thinkingBudget}
                      initialReasoning={detail?.reasoning}
                      specModel={detail?.model ?? summary?.model ?? undefined} />
                  )}
                  {hasActiveRun && runState !== 'triggering' && runAllowed && (
                    <div className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 mb-2 flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shrink-0" />
                      <span className="text-xs text-amber-300 flex-1">A run is active in this workspace</span>
                    </div>
                  )}
                  {runAnywayAllowed && !runAllowed && (
                    <div className="rounded border border-error/30 bg-error/10 px-3 py-2 mb-2">
                      <p className="text-xs font-medium text-error">Execution gate is blocked</p>
                      <p className="text-[10px] text-error/80">The backend exposed a run-anyway override for this spec. Normal run controls stay hidden until readiness clears.</p>
                    </div>
                  )}
                  {runAllowed ? (
                    <div className={hasActiveRun ? 'flex gap-2' : ''}>
                      <button onClick={() => setShowTriggerPopover(true)} disabled={runState === 'triggering'}
                        className={`flex items-center justify-center gap-1.5 py-2 rounded text-sm font-medium bg-accent text-white hover:opacity-90 disabled:opacity-60 transition-opacity ${hasActiveRun ? 'flex-1' : 'w-full'}`}>
                        {runState === 'triggering' ? <><Loader2 size={14} className="animate-spin" /> Starting...</> : <><Play size={14} /> {hasActiveRun ? 'Run Now' : 'Run in Pipeline'}{deferredCount > 0 && <span className="ml-1 px-1.5 py-0.5 text-[10px] font-semibold rounded-full bg-[var(--kbd-bg)]">{deferredCount} deferred</span>}</>}
                      </button>
                      {hasActiveRun && (
                        <button
                          onClick={() => handleRun(isolateInBranch, { queue: true })}
                          disabled={runState === 'triggering'}
                          className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded text-sm font-medium bg-amber-500/15 text-amber-300 border border-amber-500/30 hover:bg-amber-500/25 disabled:opacity-60 transition-colors"
                        >
                          <Clock size={14} /> Queue Next
                        </button>
                      )}
                    </div>
                  ) : (
                    <button
                      onClick={() => handleRun(isolateInBranch, { readinessOverride: true })}
                      disabled={runState === 'triggering'}
                      className="w-full flex items-center justify-center gap-1.5 py-2 rounded text-sm font-medium bg-error text-white hover:opacity-90 disabled:opacity-60 transition-opacity"
                      data-testid="run-anyway-button"
                    >
                      {runState === 'triggering' ? <><Loader2 size={14} className="animate-spin" /> Starting...</> : <><Play size={14} /> Run Anyway</>}
                    </button>
                  )}
                  {allPassed && runAllowed && (
                    <button
                      onClick={() => handleRun(isolateInBranch, { forceRerun: true })}
                      disabled={runState === 'triggering' || hasBlockingPostSaveJob}
                      title={hasBlockingPostSaveJob ? 'Re-run is gated while a post-save job is queued or running for this spec' : 'Re-run this spec from scratch'}
                      className="w-full flex items-center justify-center gap-1.5 py-2 mt-1 rounded text-sm font-medium bg-[var(--surface-2)] text-[var(--text-muted)] border border-[var(--border)] hover:text-[var(--text)] hover:border-[var(--border-hover)] disabled:opacity-60 transition-colors"
                    >
                      <RotateCcw size={13} /> Re-run from scratch
                    </button>
                  )}
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

          {/* Enrich with Context */}
          {(() => {
            const enrichDisabled = isRunStatusBlocking(activeRunStatus) || enrichState === 'enriching' || hasBlockingPostSaveJob;
            return (
              <button
                onClick={handleEnrich}
                disabled={enrichDisabled}
                title={hasBlockingPostSaveJob ? 'Cannot enrich while another post-save job is active for this spec' : isRunStatusBlocking(activeRunStatus) ? 'Cannot enrich while a run is active' : 'Enrich stories with contextual annotations'}
                className={`flex items-center justify-center gap-1.5 w-full py-2 rounded text-sm font-medium bg-panel border border-border text-text hover:bg-accent/10 transition-colors ${enrichDisabled ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                {enrichState === 'enriching'
                  ? <><Loader2 size={14} className="animate-spin" /> Enriching…</>
                  : <><Sparkles size={14} /> Enrich with Context</>}
              </button>
            );
          })()}
        </div>
      )}
    </div>
  );
}

/* ─── Stories Tab Content ──────────────────────────────────────────── */

/** Compact chip showing a story's assigned model (or the spec-level model if none, or 'auto' if neither). */
function ModelBadge({ story, specId, workspaceId, specModel, onModelChanged }: {
  story: Story;
  specId: string;
  workspaceId: string;
  /** Spec-level model to display as fallback when story has no individual override */
  specModel?: string | null;
  onModelChanged: (updated: Story) => void;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onClick); };
  }, [open]);

  // Lazy-load model list when popover opens
  useEffect(() => {
    if (!open || models.length > 0) return;
    apiFetch<{ models: Array<{ id: string } | string> }>('/api/direction/models')
      .then(d => setModels((d.models ?? []).map(m => (typeof m === 'string' ? m : m.id))))
      .catch(() => setModels(['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001']));
  }, [open, models.length]);

  const patchModel = async (model: string | null) => {
    console.log('[ModelBadge] patchModel called', { model, specId, storyId: story.id, workspaceId });
    setSaving(true);
    try {
      const result = await apiFetch<{ ok: boolean; story: Story }>(`/api/specs/${specId}/stories/${story.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, model: model ?? '' }),
      });
      console.log('[ModelBadge] patchModel success', result);
      onModelChanged(result.story);
      setOpen(false);
    } catch (err) {
      console.error('[ModelBadge] patchModel failed', err);
    } finally {
      setSaving(false);
    }
  };

  // Story-level override takes precedence; fall back to spec-level model, then 'auto'
  const hasStoryOverride = !!story.model;
  const displayLabel = story.model ?? specModel ?? 'auto';
  const isAuto = !story.model && !specModel;
  const isSpecLevel = !story.model && !!specModel;

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono border transition-colors ${
          hasStoryOverride
            ? 'bg-accent/10 text-accent border-accent/30'
            : isSpecLevel
              ? 'bg-blue-500/10 text-blue-400 border-blue-500/30'
              : 'bg-muted/10 text-muted border-border'
        }`}
        title={
          hasStoryOverride
            ? `Story override: ${story.model}`
            : isSpecLevel
              ? `Spec-level model: ${specModel} — click to override for this story`
              : 'Auto-assigned model — click to override'
        }
      >
        <Cpu size={9} />
        {displayLabel}
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 w-64 bg-panel border border-border rounded-md shadow-lg p-2 space-y-2">
          <p className="text-[10px] text-muted px-1">Model override for this story</p>
          <div className="w-full text-xs bg-bg border border-border rounded overflow-y-auto max-h-40">
            <button
              type="button"
              disabled={saving}
              onClick={() => patchModel(null)}
              className={`w-full text-left px-2 py-1.5 hover:bg-accent/10 transition-colors disabled:opacity-50 ${
                !story.model ? 'bg-accent/15 text-accent' : 'text-text'
              }`}
            >
              {specModel ? `spec default (${specModel})` : 'auto (let pipeline decide)'}
            </button>
            {models.map(m => (
              <button
                key={m}
                type="button"
                disabled={saving}
                onClick={() => patchModel(m)}
                className={`w-full text-left px-2 py-1.5 hover:bg-accent/10 transition-colors disabled:opacity-50 ${
                  story.model === m ? 'bg-accent/15 text-accent' : 'text-text'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
          <button
            onClick={() => patchModel(null)}
            disabled={saving || !hasStoryOverride}
            className="w-full text-xs px-2 py-1 rounded border border-border text-muted hover:text-text disabled:opacity-40 transition-colors"
          >
            {saving ? <Loader2 size={10} className="animate-spin mx-auto" /> : 'Clear override'}
          </button>
        </div>
      )}
    </div>
  );
}

function StoriesTabContent({ stories, specId, workspaceId, onToggleExclude, onStoryUpdated, specModelFields, onSpecModelUpdated }: {
  stories: Story[];
  specId: string;
  workspaceId: string;
  onToggleExclude?: (storyId: string) => void;
  onStoryUpdated?: (story: Story) => void;
  specModelFields?: {
    agentOverride?: EngineValue | null;
    model?: string | null;
    thinkingEnabled?: boolean;
    thinkingBudget?: number;
    effortLevel?: 'low' | 'medium' | 'high' | 'max' | 'xhigh';
    reasoning?: { enabled: boolean; effort?: string };
  };
  onSpecModelUpdated?: (fields: SpecModelFields) => void;
}) {
  const toast = useGlobalToast();
  const [editingStoryId, setEditingStoryId] = useState<string | null>(null);
  const [commentCounts, setCommentCounts] = useState<Record<string, number>>({});
  const [commentsOpenFor, setCommentsOpenFor] = useState<string | null>(null);
  const [assigningModels, setAssigningModels] = useState(false);

  useEffect(() => {
    apiFetch<{ counts: Record<string, number> }>(`/api/specs/${specId}/comments/counts`)
      .then(data => setCommentCounts(data.counts)).catch(() => { });
  }, [specId]);

  const handleAutoAssign = async () => {
    setAssigningModels(true);
    try {
      const result = await apiFetch<{ storiesAssigned: number; skipped: boolean; reason?: string }>(
        `/api/specs/${specId}/assign-models`,
        { method: 'POST', body: JSON.stringify({ workspaceId }) },
      );
      if (result.skipped) {
        toast.show(result.reason ?? 'Codex does not support per-story model selection', 'warning');
      } else {
        toast.show(`${result.storiesAssigned} ${result.storiesAssigned === 1 ? 'story' : 'stories'} assigned optimal models`, 'success');
        // Refresh stories by re-fetching spec detail — signal parent
        // Parent will pick it up via onStoryUpdated on individual edits;
        // for bulk refresh we reload the page data by refetching the spec
        const fresh = await apiFetch<{ userStories?: Story[]; stories?: Story[] }>(`/api/specs/${specId}?workspaceId=${workspaceId}`).catch(() => null);
        const freshRaw = fresh?.userStories ?? fresh?.stories ?? [];
        const freshStories = freshRaw.map((s: any) => ({ ...s, acceptanceCriteria: s.acceptanceCriteria ?? s.steps ?? (s.acceptance ? [s.acceptance] : []) }));
        freshStories.forEach(s => onStoryUpdated?.(s));
      }
    } catch (err: unknown) {
      toast.show((err as Error).message ?? 'Failed to assign models', 'error');
    } finally {
      setAssigningModels(false);
    }
  };

  if (stories.length === 0) {
    return (
      <>
        <SpecModelControlBar
          specId={specId}
          workspaceId={workspaceId}
          initialEngine={specModelFields?.agentOverride ?? undefined}
          initialModel={specModelFields?.model ?? undefined}
          initialThinkingEnabled={specModelFields?.thinkingEnabled}
          initialThinkingBudget={specModelFields?.thinkingBudget}
          initialEffortLevel={specModelFields?.effortLevel}
          initialReasoning={specModelFields?.reasoning}
          onSpecUpdated={onSpecModelUpdated}
        />
        <div className="flex items-center justify-center h-full text-muted text-sm">No stories found in this spec</div>
      </>
    );
  }

  const deferredCount = stories.filter(s => s.excluded && !s.passes).length;
  const allStoryIds = new Set(stories.map(s => s.id));

  return (
    <>
      <SpecModelControlBar
        specId={specId}
        workspaceId={workspaceId}
        initialEngine={specModelFields?.agentOverride ?? undefined}
        initialModel={specModelFields?.model ?? undefined}
        initialThinkingEnabled={specModelFields?.thinkingEnabled}
        initialThinkingBudget={specModelFields?.thinkingBudget}
        initialEffortLevel={specModelFields?.effortLevel}
        onSpecUpdated={onSpecModelUpdated}
      />
    <div className="p-4 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted">
          {stories.length} {stories.length === 1 ? 'story' : 'stories'}
          {deferredCount > 0 && <span className="ml-2 text-muted/60">&middot; {deferredCount} deferred</span>}
        </span>
        <button
          onClick={handleAutoAssign}
          disabled={assigningModels}
          className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs border border-border text-muted hover:text-text hover:border-text/30 disabled:opacity-50 transition-colors"
          title="Auto-assign optimal model per story based on complexity"
        >
          {assigningModels
            ? <><Loader2 size={11} className="animate-spin" /> Assigning…</>
            : <><Cpu size={11} /> Auto-assign All</>}
        </button>
      </div>
      {stories.map(story =>
        editingStoryId === story.id ? (
          <InlineStoryEditor key={story.id} story={story} specId={specId} workspaceId={workspaceId}
            onSave={(updated) => { onStoryUpdated?.(updated); setEditingStoryId(null); }}
            onCancel={() => setEditingStoryId(null)} />
        ) : (
          <div key={story.id}>
            <div>
              <StoryCard story={story} allStoryIds={allStoryIds} onEdit={() => setEditingStoryId(story.id)}
                onToggleExclude={onToggleExclude ? () => onToggleExclude(story.id) : undefined}
                specId={specId} workspaceId={workspaceId}
                commentCount={commentCounts[story.id] ?? 0}
                onOpenComments={() => setCommentsOpenFor(commentsOpenFor === story.id ? null : story.id)}
                rightSlot={
                  <ModelBadge
                    story={story}
                    specId={specId}
                    workspaceId={workspaceId}
                    specModel={specModelFields?.model ?? undefined}
                    onModelChanged={(updated) => onStoryUpdated?.(updated)}
                  />
                } />
            </div>
            {commentsOpenFor === story.id && (
              <StoryComments specId={specId} storyId={story.id} onClose={() => setCommentsOpenFor(null)}
                onCountChange={(count) => setCommentCounts(prev => { const next = { ...prev }; if (count > 0) next[story.id] = count; else delete next[story.id]; return next; })} />
            )}
          </div>
        ),
      )}
    </div>
    </>
  );
}

/* ─── JSON Tab ─────────────────────────────────────────────────────── */

function JsonTab({ spec, specId: _specId }: { spec: SpecDetailData; specId: string }) {
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
        <pre className="p-4 text-xs font-mono bg-panel border border-border rounded overflow-x-auto text-text whitespace-pre max-h-[60vh] overflow-y-auto">
          {rawJson}
        </pre>
      </div>
    </div>
  );
}

/* ─── LST-004: Generation Log Tab ──────────────────────────────── */

/** PSE-003: Per-stage status for post-save enrichment pipeline. */
export type PostSaveStageStatus = 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'skipped' | 'superseded';
export type CanonicalPostSaveStatus =
  | 'queued'
  | 'running'
  | 'waiting-for-worker'
  | 'superseded'
  | 'skipped-unchanged'
  | 'blocked-by-active-job'
  | 'completed'
  | 'failed';
export type CanonicalPostSaveStage = 'enrich' | 'matchSkills' | 'memorySynthesis';
export interface CanonicalPostSaveStageState {
  stage: CanonicalPostSaveStage;
  status: CanonicalPostSaveStatus;
  reason: string;
  requested: boolean;
  jobId?: string;
  queuePosition?: number;
  activeJobsAhead?: number;
}
export interface PostSaveStageState {
  requested: boolean;
  status: PostSaveStageStatus;
  reason: string;
  jobId?: string;
  bossJobId?: string | null;
  error?: string | null;
  updatedAt?: string;
  queueName?: string;
  queueStatus?: 'waiting' | 'queued' | 'running';
  queuePosition?: number;
  activeJobsAhead?: number;
  canonicalStatus?: CanonicalPostSaveStatus;
}
export type PostSaveStageMap = {
  enrich: PostSaveStageState;
  matchSkills: PostSaveStageState;
  memorySynthesis: PostSaveStageState;
};

/** PSE-004: Context capture classification surfaced from backend. */
export type ContextCaptureState = 'provided' | 'backfilled' | 'missing';
export interface ContextCaptureStatus {
  status: ContextCaptureState;
  reason: string;
  contextUsed: 'provided' | 'missing';
  contextSummary: 'provided' | 'backfilled' | 'missing';
}

interface GenerationLog {
  id: number;
  spec_slug: string;
  model: string;
  provider: string | null;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  context_summary: string;
  context_summary_json?: string | null;
  error: string | null;
  error_category: string | null;
  status: string;
  created_at: string;
  retrieval_method?: string | null;
  enriched?: boolean;
  /** PSE-003: Canonical per-stage status surfaced from backend. */
  postSaveStages?: PostSaveStageMap;
  /** PSE-004: Context capture classification surfaced from backend. */
  contextCaptureStatus?: ContextCaptureStatus;
  /** RER-006: Canonical post-save status surfaced from backend. */
  postSaveStatus?: CanonicalPostSaveStatus;
  postSaveStage?: CanonicalPostSaveStage;
  postSaveJobId?: string;
  postSaveQueuePosition?: number;
  postSaveActiveJobsAhead?: number;
  postSaveBlockingStatus?: 'blocked-by-active-job';
  postSaveStageStates?: CanonicalPostSaveStageState[];
}

export interface GenerationLogPresentation {
  tone: 'success' | 'error';
  title: string;
  badgeLabel: string;
  badgeClassName: string;
}

export function getGenerationLogPresentation(log: Pick<GenerationLog, 'status' | 'enriched' | 'postSaveStages'>): GenerationLogPresentation {
  const isEnriched = !!log.enriched;
  const stages = log.postSaveStages;
  const requestedStages = stages ? Object.values(stages).filter(stage => stage.requested) : [];
  const hasActiveStage = requestedStages.some(stage => stage.status === 'pending' || stage.status === 'queued' || stage.status === 'running');
  const allSuperseded = requestedStages.length > 0 && requestedStages.every(stage => stage.status === 'superseded' || !stage.requested);
  const allSkippedUnchanged = requestedStages.length > 0 && requestedStages.every(stage => stage.status === 'skipped' && stage.reason === 'fingerprint_unchanged');

  if (log.status === 'pending_enrichment' && allSuperseded) {
    return {
      tone: 'success',
      title: 'Draft Persisted · Superseded by Newer Edit',
      badgeLabel: 'Superseded',
      badgeClassName: 'bg-muted/15 text-muted border border-muted/30',
    };
  }

  if (log.status === 'pending_enrichment' && allSkippedUnchanged) {
    return {
      tone: 'success',
      title: 'Draft Persisted · Inputs Unchanged',
      badgeLabel: 'Skipped',
      badgeClassName: 'bg-muted/15 text-muted border border-muted/30',
    };
  }

  if (log.status === 'pending_enrichment' && requestedStages.length > 0 && !hasActiveStage) {
    return {
      tone: 'success',
      title: 'Draft Persisted · Post-save Complete',
      badgeLabel: 'Persisted',
      badgeClassName: 'bg-blue-500/15 text-blue-400 border border-blue-500/30',
    };
  }

  if (isEnriched) {
    return log.status === 'completed'
      ? {
          tone: 'success',
          title: 'Enrichment Succeeded',
          badgeLabel: 'Enriched',
          badgeClassName: 'bg-amber-500/15 text-amber-400 border border-amber-500/30',
        }
      : {
          tone: 'error',
          title: 'Enrichment Failed',
          badgeLabel: 'Enriched',
          badgeClassName: 'bg-amber-500/15 text-amber-400 border border-amber-500/30',
        };
  }

  if (log.status === 'completed') {
    return {
      tone: 'success',
      title: 'Generation Succeeded',
      badgeLabel: 'Generated',
      badgeClassName: 'bg-success/15 text-success border border-success/30',
    };
  }

  if (log.status === 'persisted') {
    return {
      tone: 'success',
      title: 'Draft Persisted',
      badgeLabel: 'Persisted',
      badgeClassName: 'bg-blue-500/15 text-blue-400 border border-blue-500/30',
    };
  }

  if (log.status === 'pending_enrichment') {
    return {
      tone: 'success',
      title: 'Draft Persisted · Enrichment Pending',
      badgeLabel: 'Persisted',
      badgeClassName: 'bg-blue-500/15 text-blue-400 border border-blue-500/30',
    };
  }

  return {
    tone: 'error',
    title: 'Generation Failed',
    badgeLabel: 'Generated',
    badgeClassName: 'bg-success/15 text-success border border-success/30',
  };
}

/* ─── CTM-008: Retrieval-method badge + per-story annotation preview ───────── */

const RETRIEVAL_METHOD_BADGE_CLASSES: Record<string, string> = {
  pgvector: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  graph: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
  fulltext: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  'direction-only': 'bg-gray-500/15 text-gray-400 border-gray-500/30',
};

/**
 * Map an enrichment retrieval method to its display label + badge classes.
 * Unknown methods fall back to the neutral direction-only styling so the badge
 * always renders rather than crashing on a method the UI hasn't seen yet.
 */
export function getRetrievalMethodPresentation(method: string): { label: string; badgeClassName: string } {
  return {
    label: method,
    badgeClassName: RETRIEVAL_METHOD_BADGE_CLASSES[method] ?? RETRIEVAL_METHOD_BADGE_CLASSES['direction-only'],
  };
}

export interface StoryContextAnnotation {
  storyId: string;
  storyTitle: string;
  /** First 3 lines of the ## Context section — safe to render inline. */
  preview: string;
  /** Whether the annotation has more than the previewed lines. */
  hasMore: boolean;
  /** Full ## Context section text — derived on demand, never persisted to global state. */
  fullText: string;
}

/**
 * Extract per-story ## Context annotations from the local story list.
 *
 * Trace-safe by construction: this reads the already-loaded story descriptions
 * (metadata) and returns only short preview slices. It never reaches into any
 * raw retrieval blob nor stows anything on `window`/global state — the inspector
 * stays compare/replay/export friendly because only derived metadata is exposed.
 */
export function extractStoryContextAnnotations(
  stories: Array<{ id: string; title?: string; description?: unknown }>,
): StoryContextAnnotation[] {
  const annotations: StoryContextAnnotation[] = [];
  for (const story of stories) {
    const desc = story.description;
    if (typeof desc !== 'string' || !desc.includes('## Context')) continue;
    const ctxMatch = desc.match(/## Context\n([\s\S]*?)(?:\n##|$)/);
    const fullText = ctxMatch ? ctxMatch[1].trim() : '';
    if (!fullText) continue;
    const lines = fullText.split('\n');
    annotations.push({
      storyId: story.id,
      storyTitle: story.title ?? story.id,
      preview: lines.slice(0, 3).join('\n'),
      hasMore: lines.length > 3,
      fullText,
    });
  }
  return annotations;
}

/**
 * Parse a context summary from a generation log row.
 * Priority: context_summary_json > context_summary (JSON parse).
 * Handles two shapes:
 *   - Standard generate shape: { directionLayers: { l1, l2, l3 }, skills, retrieval, ... }
 *   - Enrich shape: { directionLayers: [...], memory: { cagHits, ragHits, graphHits, tier, latencyMs }, tokenBudget, flags }
 * Returns null if neither field is parseable or contains meaningful data.
 */
function normalizeContextSummaryPayload(parsed: unknown): ContextSummary | null {
  if (!parsed || typeof parsed !== 'object' || Object.keys(parsed).length === 0) return null;

  const record = parsed as Record<string, any>;

  // Already in standard ContextSummary shape (has { l1, l2, l3 } object)
  if (record.directionLayers && !Array.isArray(record.directionLayers)) {
    return record as ContextSummary;
  }

  // Persisted explicit-draft wrapper shape: { ..., contextSummary: { ... } }
  if (record.contextSummary && typeof record.contextSummary === 'object') {
    const nested = normalizeContextSummaryPayload(record.contextSummary);
    if (nested) return nested;
  }

  // Enrich shape: directionLayers is an array, memory holds retrieval metrics
  if (Array.isArray(record.directionLayers) && record.memory) {
    const mem = record.memory as {
      cagHits?: number; ragHits?: number; graphHits?: number;
      tier?: string; latencyMs?: number; count?: number;
    };
    const layerPresent = (lyr: string) => {
      const found = (record.directionLayers as any[]).find((d: any) => d.layer === lyr);
      return found?.present ?? false;
    };
    const normalized: ContextSummary = {
      directionLayers: {
        l1: layerPresent('L1'),
        l2: { present: layerPresent('L2'), domain: null },
        l3: layerPresent('L3'),
      },
      skills: record.skills ?? [],
      memoryEntries: mem.count ?? 0,
      agentsMd: record.flags?.agent ?? false,
      template: null,
      schemaSnapshot: record.flags?.schema ?? false,
      gitMemory: record.flags?.gitMemory ?? false,
      estimatedTokens: record.tokenBudget?.used ?? 0,
      modelContextWindow: record.tokenBudget?.limit ?? 200000,
      retrieval: {
        cagHits: mem.cagHits ?? 0,
        ragHits: mem.ragHits ?? 0,
        graphHits: mem.graphHits ?? 0,
        tier: (mem.tier as 'cache' | 'search' | 'hybrid') ?? 'cache',
        latencyMs: mem.latencyMs ?? 0,
      },
    };
    return normalized;
  }

  // Fallback explicit-draft payload carrying only contextUsed/meta.
  const meta = record.contextUsed?.meta;
  if (meta && typeof meta === 'object') {
    const metaRecord = meta as Record<string, any>;
    return {
      directionLayers: {
        l1: metaRecord.standards === true,
        l2: { present: metaRecord.conventions === true, domain: typeof metaRecord.domain === 'string' ? metaRecord.domain : null },
        l3: metaRecord.project === true,
        ...(typeof metaRecord.l1Title === 'string' ? { l1Title: metaRecord.l1Title } : {}),
        ...(typeof metaRecord.l2Title === 'string' ? { l2Title: metaRecord.l2Title } : {}),
        ...(typeof metaRecord.l3Title === 'string' ? { l3Title: metaRecord.l3Title } : {}),
        ...(typeof metaRecord.l1Tokens === 'number' ? { l1Tokens: metaRecord.l1Tokens } : {}),
        ...(typeof metaRecord.l2Tokens === 'number' ? { l2Tokens: metaRecord.l2Tokens } : {}),
        ...(typeof metaRecord.l3Tokens === 'number' ? { l3Tokens: metaRecord.l3Tokens } : {}),
      },
      skills: Array.isArray(metaRecord.skills) ? metaRecord.skills.filter((item: unknown): item is string => typeof item === 'string') : [],
      memoryEntries: typeof metaRecord.memoryEntries === 'number' ? metaRecord.memoryEntries : 0,
      agentsMd: metaRecord.agentsMd === true,
      template: typeof metaRecord.template === 'string' ? metaRecord.template : null,
      schemaSnapshot: metaRecord.schema === true || metaRecord.schemaSnapshot === true,
      gitMemory: metaRecord.gitMemory === true,
      estimatedTokens: typeof metaRecord.totalTokens === 'number' ? metaRecord.totalTokens : 0,
      modelContextWindow: typeof metaRecord.modelContextWindow === 'number' ? metaRecord.modelContextWindow : 200000,
      ...(Array.isArray(metaRecord.predictedFiles) ? { predictedFiles: metaRecord.predictedFiles.filter((item: unknown): item is string => typeof item === 'string') } : {}),
      ...(metaRecord.retrieval && typeof metaRecord.retrieval === 'object' ? {
        retrieval: {
          cagHits: typeof metaRecord.retrieval.cagHits === 'number' ? metaRecord.retrieval.cagHits : 0,
          ragHits: typeof metaRecord.retrieval.ragHits === 'number' ? metaRecord.retrieval.ragHits : 0,
          graphHits: typeof metaRecord.retrieval.graphHits === 'number' ? metaRecord.retrieval.graphHits : 0,
          tier: metaRecord.retrieval.tier === 'search' || metaRecord.retrieval.tier === 'hybrid' ? metaRecord.retrieval.tier : 'cache',
          latencyMs: typeof metaRecord.retrieval.latencyMs === 'number' ? metaRecord.retrieval.latencyMs : 0,
        },
        vectorHits: typeof metaRecord.retrieval.ragHits === 'number' ? metaRecord.retrieval.ragHits : 0,
        graphHits: typeof metaRecord.retrieval.graphHits === 'number' ? metaRecord.retrieval.graphHits : 0,
        retrievalTier: metaRecord.retrieval.tier === 'search' || metaRecord.retrieval.tier === 'hybrid' ? metaRecord.retrieval.tier : 'cache',
        retrievalLatencyMs: typeof metaRecord.retrieval.latencyMs === 'number' ? metaRecord.retrieval.latencyMs : 0,
      } : {}),
    };
  }

  return null;
}

export function parseContextSummary(log: GenerationLog): ContextSummary | null {
  const jsonStr = log.context_summary_json ?? log.context_summary;
  if (!jsonStr) return null;

  let parsed: unknown;
  try {
    parsed = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
  } catch {
    return null;
  }

  return normalizeContextSummaryPayload(parsed);
}

/**
 * PSE-003: Extract postSaveStages from a generation log row.
 * Priority: top-level postSaveStages field (surfaced by backend route),
 * then fallback to nested context_summary_json.postSaveStages for older
 * responses or backward compatibility.
 */
export function parsePostSaveStages(log: GenerationLog): PostSaveStageMap | null {
  if (log.postSaveStages) return log.postSaveStages;

  const jsonStr = log.context_summary_json;
  if (!jsonStr) return null;

  let parsed: unknown;
  try {
    parsed = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  const stages = record.postSaveStages;
  if (!stages || typeof stages !== 'object') return null;

  const stageMap = stages as Record<string, unknown>;
  if (!stageMap.enrich || !stageMap.matchSkills || !stageMap.memorySynthesis) return null;

  return stages as PostSaveStageMap;
}

/**
 * PSE-004: Extract contextCaptureStatus from a generation log row.
 * Priority: top-level contextCaptureStatus field (surfaced by backend route),
 * then fallback to nested context_summary_json.contextCaptureStatus.
 */
export function getCanonicalPostSaveStatus(stage: PostSaveStageState): CanonicalPostSaveStatus {
  if (stage.canonicalStatus) return stage.canonicalStatus;
  if (stage.status === 'running') return 'running';
  if (stage.status === 'queued') return stage.queueStatus === 'waiting' || (stage.activeJobsAhead ?? 0) > 0 ? 'waiting-for-worker' : 'queued';
  if (stage.status === 'pending') return 'waiting-for-worker';
  if (stage.status === 'superseded') return 'superseded';
  if (stage.status === 'skipped') return stage.reason === 'fingerprint_unchanged' ? 'skipped-unchanged' : 'completed';
  if (stage.status === 'completed') return 'completed';
  if (stage.reason === 'blocked_by_enrich_failure' || stage.reason === 'blocked_by_enrich_enqueue_failure') return 'blocked-by-active-job';
  return 'failed';
}

export function getCanonicalPostSaveStageStates(log: GenerationLog): CanonicalPostSaveStageState[] {
  if (Array.isArray(log.postSaveStageStates) && log.postSaveStageStates.length > 0) return log.postSaveStageStates;
  const stages = parsePostSaveStages(log);
  if (!stages) return [];
  return (['enrich', 'matchSkills', 'memorySynthesis'] as CanonicalPostSaveStage[]).map((stageName) => {
    const stage = stages[stageName];
    return {
      stage: stageName,
      status: getCanonicalPostSaveStatus(stage),
      reason: stage.reason,
      requested: stage.requested,
      ...(stage.jobId ? { jobId: stage.jobId } : {}),
      ...(stage.queuePosition !== undefined ? { queuePosition: stage.queuePosition } : {}),
      ...(stage.activeJobsAhead !== undefined ? { activeJobsAhead: stage.activeJobsAhead } : {}),
    };
  });
}

export function getCurrentPostSaveState(log: GenerationLog): CanonicalPostSaveStageState | null {
  if (log.postSaveBlockingStatus === 'blocked-by-active-job' && log.postSaveStatus && log.postSaveStage) {
    return {
      stage: log.postSaveStage,
      status: log.postSaveStatus,
      reason: 'blocked-by-active-job',
      requested: true,
      ...(log.postSaveJobId ? { jobId: log.postSaveJobId } : {}),
      ...(log.postSaveQueuePosition !== undefined ? { queuePosition: log.postSaveQueuePosition } : {}),
      ...(log.postSaveActiveJobsAhead !== undefined ? { activeJobsAhead: log.postSaveActiveJobsAhead } : {}),
    };
  }
  return getCanonicalPostSaveStageStates(log).find(
    (state) => state.requested && (state.status === 'running' || state.status === 'queued' || state.status === 'waiting-for-worker'),
  ) ?? null;
}

export function postSaveActiveJobCopy(state: CanonicalPostSaveStageState): string {
  const stageLabel = STAGE_LABELS[state.stage];
  if (state.status === 'running') return `${stageLabel} is running. Wait for it to finish before retrying, repairing, or rerunning.`;
  if (state.status === 'waiting-for-worker') return `${stageLabel} is waiting for a worker${state.activeJobsAhead ? ` (${state.activeJobsAhead} job${state.activeJobsAhead === 1 ? '' : 's'} ahead)` : ''}.`;
  return `${stageLabel} is queued${state.queuePosition ? ` at position ${state.queuePosition}` : ''}.`;
}

export function parseContextCaptureStatus(log: GenerationLog): ContextCaptureStatus | null {
  if (log.contextCaptureStatus) return log.contextCaptureStatus;

  const jsonStr = log.context_summary_json;
  if (!jsonStr) return null;

  let parsed: unknown;
  try {
    parsed = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  const ccs = record.contextCaptureStatus;
  if (!ccs || typeof ccs !== 'object') return null;
  const ccsRecord = ccs as Record<string, unknown>;
  if (typeof ccsRecord.status !== 'string') return null;

  return ccs as ContextCaptureStatus;
}

export function workflowInspectionToPostSaveStages(workflow: SpecWorkflowInspectionPayload | null): PostSaveStageMap | null {
  if (!workflow) return null;
  const build = (key: CanonicalPostSaveStage): PostSaveStageState => {
    const stage = workflow.stages.find((entry) => entry.key === key);
    return {
      requested: stage?.requested ?? false,
      status: (stage?.status === 'missing' ? 'skipped' : (stage?.status ?? 'skipped')) as PostSaveStageStatus,
      reason: stage?.reasonCode ?? stage?.reason ?? 'stage_state_missing',
      ...(stage?.jobId ? { jobId: stage.jobId } : {}),
      ...(stage?.bossJobId !== null && stage?.bossJobId !== undefined ? { bossJobId: stage.bossJobId } : {}),
      ...(stage?.error ? { error: stage.error } : {}),
      ...(stage?.updatedAt ? { updatedAt: stage.updatedAt } : {}),
      ...(stage?.queueName ? { queueName: stage.queueName } : {}),
      ...(stage?.queueStatus ? { queueStatus: stage.queueStatus } : {}),
      ...(stage?.queuePosition !== null && stage?.queuePosition !== undefined ? { queuePosition: stage.queuePosition } : {}),
      ...(stage?.activeJobsAhead !== null && stage?.activeJobsAhead !== undefined ? { activeJobsAhead: stage.activeJobsAhead } : {}),
    };
  };

  return {
    enrich: build('enrich'),
    matchSkills: build('matchSkills'),
    memorySynthesis: build('memorySynthesis'),
  };
}

export function readinessInspectionToContextCaptureStatus(readiness: SpecReadinessInspectionPayload | null): ContextCaptureStatus | null {
  const capture = readiness?.persistence.contextCapture;
  if (!capture || capture.status === 'unknown') return null;
  return {
    status: capture.status,
    reason: capture.reason ?? 'unknown',
    contextUsed: capture.status === 'provided' ? 'provided' : 'missing',
    contextSummary: capture.status === 'provided' ? 'provided' : capture.status === 'backfilled' ? 'backfilled' : 'missing',
  };
}

export function getCurrentPostSaveStateFromWorkflow(workflow: SpecWorkflowInspectionPayload | null): CanonicalPostSaveStageState | null {
  const stages = workflowInspectionToPostSaveStages(workflow);
  if (!stages) return null;
  return getCurrentPostSaveState({ postSaveStages: stages } as GenerationLog);
}

const WORKFLOW_CHECKLIST_STAGE_ORDER = ['context', 'enrich', 'matchSkills', 'memorySynthesis'] as const;
const WORKFLOW_CHECKLIST_STAGE_LABELS: Record<WorkflowStageKey, string> = {
  context: 'Context',
  enrich: 'Enrich',
  matchSkills: 'Match Skills',
  memorySynthesis: 'Memory Synthesis',
};

const LIVE_WORKFLOW_EVENT_TYPES = new Set([
  'spec_job_progress',
  'spec_enriched',
  'skill_matched',
  'spec_repair_action',
  'spec_repaired',
  'spec_readiness_override_used',
  'spec_updated',
  'spec_approved',
  'spec_rejected',
  'run_started',
  'run_finished',
  'run_queued_trigger',
  'run_queued_promoted',
]);

function parseWalPayload(payload: string | null): Record<string, unknown> | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function shouldRefreshSpecDetailFromWalEvent(event: WalEvent, specId: string, workspaceId?: string | null): boolean {
  if (!LIVE_WORKFLOW_EVENT_TYPES.has(event.event_type)) return false;
  if (workspaceId && event.workspace_id && String(event.workspace_id) !== String(workspaceId)) return false;
  if (event.spec_id && event.spec_id === specId) return true;
  const payload = parseWalPayload(event.payload);
  return payload?.spec_id === specId || payload?.specId === specId;
}

export function workflowTopLevelActionAllowed(
  workflow: SpecWorkflowInspectionPayload | null,
  readiness: SpecReadinessInspectionPayload | null,
  action: 'repair_spec' | 'run_anyway' | 'run' | 'approve' | 'wait_for_post_save' | 'install_skills',
): boolean {
  if (action === 'install_skills') {
    return readiness?.availableActions.includes('install_skills') ?? false;
  }

  const hintMatch = workflow?.safeActionHints.some((hint) => hint.action === action && hint.allowed) ?? false;
  if (hintMatch) return true;

  if (!readiness) return false;
  if (action === 'repair_spec') return readiness.availableActions.includes('repair_post_save') || readiness.availableActions.includes('backfill_context');
  if (action === 'run_anyway') return readiness.availableActions.includes('run_anyway');
  if (action === 'run') return readiness.availableActions.includes('run');
  if (action === 'approve') return readiness.availableActions.includes('approve');
  return readiness.availableActions.includes('wait_for_post_save');
}

export function workflowStageActionAllowed(
  workflow: SpecWorkflowInspectionPayload | null,
  stageKey: WorkflowStageKey,
  action: WorkflowActionKey,
): boolean {
  return workflow?.stages.find((stage) => stage.key === stageKey)?.safeActionHints.some((hint) => hint.action === action && hint.allowed) ?? false;
}

function workflowPolicyLabel(workflow: SpecWorkflowInspectionPayload | null): string {
  const effectivePolicy = workflow?.workflow.effectivePolicy;
  if (!effectivePolicy || typeof effectivePolicy !== 'object') return 'default';
  const record = effectivePolicy as Record<string, unknown>;
  return typeof record.presetId === 'string'
    ? record.presetId
    : typeof record.version === 'string'
      ? record.version
      : 'custom';
}

function stageReasonCode(stage: SpecWorkflowStageSnapshot): string {
  return stage.reasonCode ?? stage.reason ?? 'stage_state_missing';
}

function stageReasonLabel(stage: SpecWorkflowStageSnapshot): string {
  return reasonLabel(stageReasonCode(stage));
}

function stageStatusView(stage: SpecWorkflowStageSnapshot): { label: string; dotClass: string; textClass: string } {
  const code = stageReasonCode(stage);
  if (stage.status === 'missing') return { label: 'Not started', dotClass: 'bg-muted/40', textClass: 'text-muted/70' };
  if (stage.status === 'pending') return { label: 'Pending', dotClass: 'bg-amber-400 animate-pulse', textClass: 'text-amber-300' };
  if (stage.status === 'queued') return { label: 'Queued', dotClass: 'bg-blue-400 animate-pulse', textClass: 'text-blue-300' };
  if (stage.status === 'running') return { label: 'Running', dotClass: 'bg-amber-400 animate-pulse', textClass: 'text-amber-300' };
  if (stage.status === 'completed') return { label: 'Completed', dotClass: 'bg-success', textClass: 'text-success' };
  if (stage.status === 'superseded') return { label: 'Superseded', dotClass: 'bg-muted/40', textClass: 'text-muted/70' };
  if (stage.status === 'skipped' && code === SpecReadinessReasonCode.NoInstalledSkills) {
    return { label: 'No installed skills', dotClass: 'bg-purple-400', textClass: 'text-purple-300' };
  }
  if (stage.status === 'skipped' && ['disabled_by_policy', 'fingerprint_unchanged', 'metadata_only_skip'].includes(code)) {
    return { label: 'Skipped by policy', dotClass: 'bg-muted/40', textClass: 'text-muted/70' };
  }
  if (stage.status === 'failed' && [SpecReadinessReasonCode.BlockedByDependency, 'blocked_by_required_stage_failed', 'blocked_by_enrich_failure', 'blocked_by_enrich_enqueue_failure'].includes(code)) {
    return { label: 'Blocked by dependency', dotClass: 'bg-error', textClass: 'text-error' };
  }
  if (stage.status === 'failed') return { label: 'Failed', dotClass: 'bg-error', textClass: 'text-error' };
  return { label: humanizeCode(stage.status), dotClass: 'bg-muted/40', textClass: 'text-muted/70' };
}

function stageTimestampLabel(stage: SpecWorkflowStageSnapshot): string {
  if (stage.status === 'running') return stage.startedAt ? `Started ${formatDateTime(stage.startedAt)}` : 'In flight';
  if (stage.status === 'queued') {
    if (stage.queueStatus === 'waiting') {
      return stage.activeJobsAhead != null
        ? `Waiting for worker · ${stage.activeJobsAhead} ahead`
        : 'Waiting for worker';
    }
    return stage.queuePosition != null ? `Queued · position ${stage.queuePosition}` : 'Queued';
  }
  if (stage.status === 'pending') return stage.updatedAt ? `Pending since ${formatDateTime(stage.updatedAt)}` : 'Pending';
  if (stage.status === 'completed') return stage.finishedAt ? `Finished ${formatDateTime(stage.finishedAt)}` : stage.updatedAt ? `Updated ${formatDateTime(stage.updatedAt)}` : 'Completed';
  if (stage.status === 'failed') return stage.finishedAt ? `Failed ${formatDateTime(stage.finishedAt)}` : stage.updatedAt ? `Failed ${formatDateTime(stage.updatedAt)}` : 'Failed';
  if (stage.status === 'skipped') return stage.updatedAt ? `Skipped ${formatDateTime(stage.updatedAt)}` : 'No worker started';
  if (stage.status === 'superseded') return stage.updatedAt ? `Superseded ${formatDateTime(stage.updatedAt)}` : 'Superseded by a newer save';
  return 'Not started';
}

/** Rough per-1K-token cost estimates by model family (input/output). */
function estimateCost(model: string, inputTokens: number, outputTokens: number): number | null {
  const rates: Record<string, [number, number]> = {
    'claude-opus': [0.015, 0.075],
    'claude-sonnet': [0.003, 0.015],
    'claude-haiku': [0.00025, 0.00125],
    'gpt-4o': [0.0025, 0.01],
    'gpt-4': [0.03, 0.06],
    'o3': [0.01, 0.04],
    'gemini': [0.00025, 0.001],
  };
  const m = model.toLowerCase();
  for (const [key, [inRate, outRate]] of Object.entries(rates)) {
    if (m.includes(key)) {
      return (inputTokens / 1000) * inRate + (outputTokens / 1000) * outRate;
    }
  }
  return null;
}

function StoryAnnotationPreview({ preview, hasMore, fullText }: { preview: string; hasMore: boolean; fullText: string }) {
  const [expanded, setExpanded] = useState(false);
  const text = expanded ? fullText : preview;
  return (
    <div className="mt-1">
      <pre className="text-[10px] text-muted/80 font-mono whitespace-pre-wrap break-words leading-relaxed">
        {text}
      </pre>
      {hasMore && (
        <button
          onClick={() => setExpanded(e => !e)}
          className="text-[10px] text-accent hover:text-accent/80 mt-1 transition-colors"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

/* ─── PSE-003: Post-save stage status display ──────────────────── */

const STAGE_LABELS: Record<keyof PostSaveStageMap, string> = {
  enrich: 'Enrich',
  matchSkills: 'Match Skills',
  memorySynthesis: 'Memory Synthesis',
};

const STAGE_STATUS_CONFIG: Record<CanonicalPostSaveStatus, { label: string; dotClass: string; textClass: string }> = {
  queued: { label: 'Queued', dotClass: 'bg-blue-400', textClass: 'text-blue-400' },
  running: { label: 'Running', dotClass: 'bg-amber-400 animate-pulse', textClass: 'text-amber-400' },
  'waiting-for-worker': { label: 'Waiting for worker', dotClass: 'bg-blue-400/70 animate-pulse', textClass: 'text-blue-300' },
  superseded: { label: 'Superseded', dotClass: 'bg-muted/50', textClass: 'text-muted/70' },
  'skipped-unchanged': { label: 'Skipped — unchanged', dotClass: 'bg-muted/40', textClass: 'text-muted/60' },
  'blocked-by-active-job': { label: 'Blocked', dotClass: 'bg-error', textClass: 'text-error' },
  completed: { label: 'Completed', dotClass: 'bg-success', textClass: 'text-success' },
  failed: { label: 'Failed', dotClass: 'bg-error', textClass: 'text-error' },
};

function reasonLabel(reason: string): string {
  const map: Record<string, string> = {
    requested_by_caller: 'Requested',
    requested_by_policy: 'Requested by policy',
    disabled_by_caller: 'Not requested',
    disabled_by_policy: 'Skipped by policy',
    waiting_for_enrich: 'Waiting for enrich',
    durable_job_enqueued: 'Job enqueued',
    durable_job_enqueued_after_enrich: 'Enqueued after enrich',
    durable_job_enqueued_after_dependency: 'Enqueued after dependency',
    job_started: 'Processing',
    job_completed: 'Done',
    context_captured: 'Context captured',
    stage_state_missing: 'Not started yet',
    enqueue_failed: 'Enqueue failed',
    job_failed: 'Job failed',
    superseded_by_newer_save: 'Superseded by a newer spec edit; this older revision is not the current active enrichment.',
    blocked_by_required_stage_failed: 'Blocked because a required stage failed',
    blocked_by_enrich_failure: 'Blocked because the enrich stage failed',
    blocked_by_enrich_enqueue_failure: 'Blocked because enrich could not start',
    fingerprint_unchanged: 'Skipped because the stage inputs did not change',
    metadata_only_skip: 'Skipped because only metadata changed',
    [SpecReadinessReasonCode.NoInstalledSkills]: 'Skipped because no matching installed skills were available',
    [SpecReadinessReasonCode.MissingContext]: 'Missing context metadata',
    [SpecReadinessReasonCode.PostSavePending]: 'Post-save work is still in flight',
    [SpecReadinessReasonCode.BlockedByDependency]: 'Blocked by a failed dependency',
    [SpecReadinessReasonCode.StageFailed]: 'A workflow stage failed',
    [SpecReadinessReasonCode.ActiveWorkflowConflict]: 'Another workflow run is already active',
    [SpecReadinessReasonCode.ActivePipelineConflict]: 'A pipeline run is already active',
    [SpecReadinessReasonCode.PolicySkipped]: 'Skipped by policy',
    [SpecReadinessReasonCode.ContextBackfilled]: 'Context was server-backfilled',
    [SpecReadinessReasonCode.RunAnywayOverrideUsed]: 'Run anyway override is available',
  };
  return map[reason] ?? humanizeCode(reason);
}

/* ─── PSE-004: Context capture status display ──────────────────── */

const CONTEXT_CAPTURE_CONFIG: Record<ContextCaptureState, { label: string; dotClass: string; textClass: string }> = {
  provided:   { label: 'Caller-supplied', dotClass: 'bg-success',  textClass: 'text-success' },
  backfilled: { label: 'Server-backfilled', dotClass: 'bg-amber-400', textClass: 'text-amber-400' },
  missing:    { label: 'Missing',         dotClass: 'bg-muted/40', textClass: 'text-muted/60' },
};

const CONTEXT_CAPTURE_REASON_LABELS: Record<string, string> = {
  caller_supplied_context: 'Caller provided context summary',
  context_summary_derived_from_context_used_meta: 'Derived from contextUsed metadata',
  context_used_missing_meta: 'Context payload lacked metadata',
  caller_context_not_supplied: 'Caller omitted drafting context',
};

function ContextCaptureCard({ status }: { status: ContextCaptureStatus }) {
  const config = CONTEXT_CAPTURE_CONFIG[status.status];
  return (
    <div className="px-4 py-3 border-t border-border/50" data-testid="context-capture-status">
      <p className="text-[10px] text-muted uppercase tracking-wider font-semibold mb-2">Context Source</p>
      <div className="flex items-start gap-2">
        <span className={`mt-1 shrink-0 w-2 h-2 rounded-full ${config.dotClass}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={`text-xs font-medium ${config.textClass}`}>{config.label}</span>
          </div>
          <p className="text-[10px] text-muted/70">
            {CONTEXT_CAPTURE_REASON_LABELS[status.reason] ?? status.reason}
          </p>
        </div>
      </div>
    </div>
  );
}

export function WorkflowChecklistCard({
  specId,
  workspaceId,
  workflow,
  readiness,
  activeRunStatus,
  onRetried,
  onOpenSkillsTab,
}: {
  specId: string;
  workspaceId: string;
  workflow: SpecWorkflowInspectionPayload | null;
  readiness: SpecReadinessInspectionPayload | null;
  activeRunStatus?: 'running' | 'queued';
  onRetried?: () => void;
  onOpenSkillsTab?: () => void;
}) {
  const toast = useGlobalToast();
  const [retryingStage, setRetryingStage] = useState<WorkflowStageKey | null>(null);
  const isRunActive = isRunStatusBlocking(activeRunStatus);
  const stagesByKey = new Map((workflow?.stages ?? readiness?.stages ?? []).map((stage) => [stage.key, stage]));
  const stages = WORKFLOW_CHECKLIST_STAGE_ORDER.map((key) => stagesByKey.get(key) ?? {
    key,
    requested: false,
    status: 'missing',
    reasonCode: 'stage_state_missing',
    reason: 'stage_state_missing',
    workflowRunId: workflow?.workflow.runId ?? readiness?.workflow.runId ?? null,
    jobId: null,
    bossJobId: null,
    queueName: null,
    queueStatus: null,
    queuePosition: null,
    activeJobsAhead: null,
    queuePriority: null,
    singletonKey: null,
    error: null,
    updatedAt: null,
    startedAt: null,
    finishedAt: null,
    safeActionHints: [],
  } satisfies SpecWorkflowStageSnapshot);
  const persistence = workflow?.persistence ?? readiness?.persistence;
  const summaryReason = readiness?.blockingReasons[0] ?? readiness?.warnings[0] ?? null;
  const installSkillsAllowed = workflowTopLevelActionAllowed(workflow, readiness, 'install_skills');

  const handleRetryStage = async (stageKey: WorkflowStageKey) => {
    if (!workspaceId || retryingStage || isRunActive || !workflowStageActionAllowed(workflow, stageKey, 'retry_stage')) return;
    setRetryingStage(stageKey);
    try {
      await retrySpecWorkflowStage(specId, stageKey, { workspaceId });
      toast.show(`Retry initiated for ${WORKFLOW_CHECKLIST_STAGE_LABELS[stageKey]}`, 'success');
      onRetried?.();
    } catch (err: unknown) {
      toast.show(err instanceof Error ? err.message : 'Retry failed', 'error');
    } finally {
      setRetryingStage(null);
    }
  };

  return (
    <div className="border border-border rounded-lg bg-panel overflow-hidden" data-testid="workflow-checklist">
      <div className="px-4 py-3 border-b border-border/50">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-text">Workflow checklist</span>
          <span className="inline-flex px-2 py-0.5 text-[10px] font-semibold rounded border border-accent/30 bg-accent/10 text-accent" data-testid="workflow-policy-label">
            Policy · {workflowPolicyLabel(workflow)}
          </span>
          {workflow?.workflow.runId != null && (
            <span className="inline-flex px-2 py-0.5 text-[10px] font-medium rounded border border-border text-muted">
              Workflow #{workflow.workflow.runId}
            </span>
          )}
          {persistence?.saveGeneration != null && (
            <span className="inline-flex px-2 py-0.5 text-[10px] font-medium rounded border border-border text-muted">
              Save #{persistence.saveGeneration}
            </span>
          )}
        </div>
      </div>

      <div className="divide-y divide-border/50">
        <div className="px-4 py-3" data-testid="workflow-summary-saved">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] uppercase tracking-wider font-semibold text-muted">Saved</span>
            <span className={`inline-flex px-2 py-0.5 text-[10px] font-semibold rounded ${persistence?.exists ? 'bg-success/15 text-success border border-success/30' : 'bg-error/15 text-error border border-error/30'}`}>
              {!persistence?.exists ? 'Missing'
                : persistence.location === 'approved' ? 'Approved'
                  : persistence.location === 'pending' ? 'Pending'
                    : 'Saved'}
            </span>
          </div>
          <p className="text-xs text-muted/80">
            {persistence?.exists
              ? `${persistence.specPath ?? 'Spec file'} is stored in ${persistence.location}.`
              : 'Spec file is missing from pending/approved storage.'}
          </p>
        </div>

        <div className="px-4 py-3" data-testid="workflow-summary-readiness">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] uppercase tracking-wider font-semibold text-muted">Readiness</span>
            {readiness && (
              <span className={`inline-flex px-2 py-0.5 text-[10px] font-semibold rounded ${readiness.readinessState.status === 'ready' ? 'bg-success/15 text-success border border-success/30' : readiness.readinessState.status === 'degraded' ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30' : 'bg-error/15 text-error border border-error/30'}`}>
                {humanizeCode(readiness.readinessState.status)}
              </span>
            )}
          </div>
          <p className="text-xs text-muted/80">
            {summaryReason ? `${humanizeCode(summaryReason.code)} · ${summaryReason.message}` : 'No readiness blockers reported.'}
          </p>
        </div>

        <div className="px-4 py-3" data-testid="workflow-summary-gate">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] uppercase tracking-wider font-semibold text-muted">Execution gate</span>
            {readiness && (
              <span className={`inline-flex px-2 py-0.5 text-[10px] font-semibold rounded ${readiness.executionGate.status === 'allowed' ? 'bg-success/15 text-success border border-success/30' : 'bg-error/15 text-error border border-error/30'}`}>
                {readiness.executionGate.status === 'allowed' ? 'Allowed' : 'Blocked'}
              </span>
            )}
          </div>
          <p className="text-xs text-muted/80">
            {readiness?.executionGate.status === 'blocked'
              ? readiness.executionGate.overrideAllowed
                ? `Blocked, but ${humanizeCode(readiness.executionGate.overrideReasonCode)} is available.`
                : 'Blocked until readiness issues are resolved.'
              : 'Ready for normal execution.'}
          </p>
        </div>

        <div className="px-4 py-3 space-y-2" data-testid="workflow-stage-checklist">
          {stages.map((stage) => {
            const status = stageStatusView(stage);
            const retryAllowed = workflowStageActionAllowed(workflow, stage.key, 'retry_stage');
            return (
              <div key={stage.key} className="rounded border border-border/50 bg-bg/40 px-3 py-2" data-testid={`workflow-stage-${stage.key}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${status.dotClass}`} />
                  <span className="text-xs font-medium text-text">{WORKFLOW_CHECKLIST_STAGE_LABELS[stage.key]}</span>
                  <span className="inline-flex px-2 py-0.5 text-[10px] font-semibold rounded border border-border text-muted">
                    {stage.requested ? 'Requested' : 'Not requested'}
                  </span>
                  <span className={`inline-flex px-2 py-0.5 text-[10px] font-semibold rounded ${status.textClass} bg-bg border border-current/20`}>
                    {status.label}
                  </span>
                  {retryAllowed && (
                    <button
                      onClick={() => handleRetryStage(stage.key)}
                      disabled={retryingStage !== null || isRunActive}
                      className={`ml-auto text-[10px] font-medium text-accent hover:text-accent/80 ${retryingStage !== null || isRunActive ? 'opacity-50 cursor-not-allowed' : ''}`}
                      data-testid={`workflow-stage-retry-${stage.key}`}
                    >
                      {retryingStage === stage.key ? 'Retrying…' : 'Retry stage'}
                    </button>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-muted/80">
                  <span className="inline-flex px-1.5 py-0.5 rounded bg-panel border border-border/60 font-mono" data-testid={`workflow-stage-reason-code-${stage.key}`}>
                    {stageReasonCode(stage)}
                  </span>
                  <span>{stageReasonLabel(stage)}</span>
                </div>
                <p className="mt-1 text-[10px] text-muted/70">{stageTimestampLabel(stage)}</p>
                {stage.error && <p className="mt-1 text-[10px] text-error/80 break-words">{stage.error}</p>}
              </div>
            );
          })}
        </div>

        {installSkillsAllowed && (
          <div className="px-4 py-3 flex items-center justify-between gap-3" data-testid="workflow-install-skills-help">
            <div>
              <p className="text-xs font-medium text-text">Install skills help available</p>
              <p className="text-[10px] text-muted/70">Skill matching reported no installed skills for this spec.</p>
            </div>
            <button
              type="button"
              onClick={onOpenSkillsTab}
              className="px-3 py-1.5 rounded text-xs font-medium bg-panel border border-border text-text hover:bg-accent/10 transition-colors"
            >
              Review skills
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

interface RepairResponse {
  specId: string;
  healthy: boolean;
  diagnosis: {
    missingGenerationLog: boolean;
    missingContextSummary: boolean;
    enrichNeedsRepair: boolean;
    matchSkillsNeedsRepair: boolean;
  };
  actions: Array<{ action: string; status: string; reason: string; jobId?: string }>;
  dryRun: boolean;
}

function PostSaveStagesCard({ stages, specId, workspaceId, activeRunStatus, blockingPostSaveJob, stageActionHints, onRetried }: {
  stages: PostSaveStageMap;
  specId?: string;
  workspaceId?: string;
  activeRunStatus?: 'running' | 'queued';
  blockingPostSaveJob?: CanonicalPostSaveStageState | null;
  stageActionHints?: Partial<Record<keyof PostSaveStageMap, WorkflowActionHint[]>>;
  onRetried?: () => void;
}) {
  const toast = useGlobalToast();
  const [retrying, setRetrying] = useState<string | null>(null);
  const stageNames = Object.keys(stages) as (keyof PostSaveStageMap)[];
  const hasAnyRequested = stageNames.some(name => stages[name].requested);
  if (!hasAnyRequested) return null;

  const isRunActive = isRunStatusBlocking(activeRunStatus);
  const isBlockedByActivePostSave = blockingPostSaveJob !== null && blockingPostSaveJob !== undefined;

  const handleRetryStage = async (stageName: keyof PostSaveStageMap) => {
    if (!specId || !workspaceId || retrying || isRunActive || isBlockedByActivePostSave) return;
    setRetrying(stageName);
    try {
      await retrySpecWorkflowStage(specId, stageName, { workspaceId });
      toast.show(`Retry initiated for ${STAGE_LABELS[stageName]}`, 'success');
      onRetried?.();
    } catch (err: unknown) {
      toast.show(err instanceof Error ? err.message : 'Retry failed', 'error');
    } finally {
      setRetrying(null);
    }
  };

  return (
    <div className="px-4 py-3 border-t border-border/50" data-testid="post-save-stages">
      <p className="text-[10px] text-muted uppercase tracking-wider font-semibold mb-2">Post-Save Pipeline</p>
      <div className="space-y-1.5">
        {stageNames.map(name => {
          const stage = stages[name];
          const canonicalStatus = getCanonicalPostSaveStatus(stage);
          const statusConfig = STAGE_STATUS_CONFIG[canonicalStatus];
          const canRetry = specId
            && workspaceId
            && stage.requested
            && stage.status === 'failed'
            && !isBlockedByActivePostSave
            && (stageActionHints?.[name]?.some((hint) => hint.action === 'retry_stage' && hint.allowed) ?? false);
          return (
            <div key={name} className="flex items-start gap-2" data-testid={`stage-${name}`}>
              <span className={`mt-1 shrink-0 w-2 h-2 rounded-full ${statusConfig.dotClass}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-text">{STAGE_LABELS[name]}</span>
                  <span className={`text-[10px] font-semibold ${statusConfig.textClass}`}>
                    {statusConfig.label}
                  </span>
                  {stage.jobId && (
                    <span className="text-[9px] font-mono text-muted/50 truncate max-w-[120px]" title={stage.jobId}>
                      {stage.jobId.slice(0, 8)}
                    </span>
                  )}
                  {canRetry && (
                    <button
                      onClick={() => handleRetryStage(name)}
                      disabled={!!retrying || isRunActive || isBlockedByActivePostSave}
                      title={isBlockedByActivePostSave ? 'Cannot retry while another post-save job is active for this spec' : isRunActive ? 'Cannot retry while a run is active' : `Retry ${STAGE_LABELS[name]}`}
                      className={`text-[10px] font-medium text-accent hover:text-accent/80 transition-colors ${retrying || isRunActive || isBlockedByActivePostSave ? 'opacity-50 cursor-not-allowed' : ''}`}
                      data-testid={`stage-retry-${name}`}
                    >
                      {retrying === name ? 'Retrying…' : 'Retry'}
                    </button>
                  )}
                </div>
                <p className="text-[10px] text-muted/70">{reasonLabel(stage.reason)}</p>
                {stage.error && (
                  <p className="text-[10px] text-error/80 mt-0.5 break-words">{stage.error}</p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─── PSE-007: Context tab failure classification & diagnostic empty state ── */

export type ContextClassification =
  | 'legacy_no_log'
  | 'persisted_without_context'
  | 'pending_post_save'
  | 'post_save_failed';

/**
 * Classify what diagnostic state the Context tab should show.
 * Returns null when context is fully available (no banner needed).
 */
export function classifyContextState(
  context: ContextSummary | null,
  stages: PostSaveStageMap | null,
  capture: ContextCaptureStatus | null,
): ContextClassification | null {
  // If we have a context summary, the tab has real data — no diagnostic needed.
  if (context) return null;

  // Check post-save stage states for pending or failed
  if (stages) {
    const allStages = [stages.enrich, stages.matchSkills, stages.memorySynthesis];
    const hasRunningOrQueued = allStages.some(
      s => s.requested && (s.status === 'pending' || s.status === 'queued' || s.status === 'running'),
    );
    if (hasRunningOrQueued) return 'pending_post_save';

    const hasFailed = allStages.some(
      s => s.requested && (s.status === 'failed'),
    );
    if (hasFailed) return 'post_save_failed';
  }

  // Has a capture status but context is missing — persisted without context
  if (capture && capture.status === 'missing') return 'persisted_without_context';

  // Fallback: no stages, no capture — legacy spec pre-context-logging
  return 'persisted_without_context';
}

const CONTEXT_CLASSIFICATION_CONFIG: Record<ContextClassification, {
  icon: 'history' | 'alert' | 'loader' | 'x-circle';
  title: string;
  description: string;
  iconClass: string;
}> = {
  legacy_no_log: {
    icon: 'history',
    title: 'Legacy spec — no generation log',
    description: 'This spec was generated before context logging was introduced. Use Repair to seed a generation log and trigger enrichment.',
    iconClass: 'text-muted/50',
  },
  persisted_without_context: {
    icon: 'alert',
    title: 'Persisted without context',
    description: 'This spec was saved without drafting context. Use any allowed recovery action below to backfill context or requeue post-save work.',
    iconClass: 'text-amber-400',
  },
  pending_post_save: {
    icon: 'loader',
    title: 'Post-save pipeline in progress',
    description: 'Enrichment, skill matching, or memory synthesis is still running. This tab will update automatically when the pipeline completes.',
    iconClass: 'text-blue-400',
  },
  post_save_failed: {
    icon: 'x-circle',
    title: 'Post-save pipeline failed',
    description: 'One or more post-save stages failed. Review the workflow checklist and use any allowed recovery action below to recover.',
    iconClass: 'text-error',
  },
};

function ContextTabEmptyState({ specId, workspaceId, classification, activeRunStatus, blockingPostSaveJob, repairAllowed, retryEnrichAllowed, onRepaired }: {
  specId: string;
  workspaceId: string;
  classification: ContextClassification;
  activeRunStatus?: 'running' | 'queued';
  blockingPostSaveJob?: CanonicalPostSaveStageState | null;
  repairAllowed: boolean;
  retryEnrichAllowed: boolean;
  onRepaired: () => void;
}) {
  const toast = useGlobalToast();
  const [repairState, setRepairState] = useState<'idle' | 'repairing' | 'retrying'>('idle');
  const config = CONTEXT_CLASSIFICATION_CONFIG[classification];
  const isRunActive = isRunStatusBlocking(activeRunStatus);
  const isBlockedByActivePostSave = blockingPostSaveJob !== null && blockingPostSaveJob !== undefined;
  const isBusy = repairState !== 'idle';
  const isPending = classification === 'pending_post_save';

  const handleRepair = async () => {
    if (!workspaceId || isBusy || isRunActive || isBlockedByActivePostSave) return;
    setRepairState('repairing');
    try {
      const res = await apiFetch<RepairResponse>(
        `/api/specs/${specId}/repair`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId }),
        },
      );
      const appliedCount = res.actions.filter(a => a.status === 'repaired').length;
      toast.show(
        appliedCount > 0
          ? `Repair applied ${appliedCount} action${appliedCount === 1 ? '' : 's'}`
          : res.healthy ? 'Spec is already healthy' : 'No repairs could be applied',
        appliedCount > 0 ? 'success' : 'info',
      );
      onRepaired();
    } catch (err: unknown) {
      toast.show(err instanceof Error ? err.message : 'Repair failed', 'error');
    } finally {
      setRepairState('idle');
    }
  };

  const handleRetryEnrich = async () => {
    if (!workspaceId || isBusy || isRunActive || isBlockedByActivePostSave) return;
    setRepairState('retrying');
    try {
      await retrySpecWorkflowStage(specId, 'enrich', { workspaceId });
      toast.show('Retry initiated for Enrich', 'success');
      onRepaired();
    } catch (err: unknown) {
      toast.show(err instanceof Error ? err.message : 'Retry failed', 'error');
    } finally {
      setRepairState('idle');
    }
  };

  const IconComponent = config.icon === 'history' ? History
    : config.icon === 'loader' ? Loader2
    : config.icon === 'x-circle' ? XCircle
    : AlertCircle;

  return (
    <div className="border border-border rounded-lg bg-panel overflow-hidden" data-testid="context-empty-state">
      <div className="flex flex-col items-center justify-center gap-3 px-6 py-8 text-center">
        <IconComponent
          size={28}
          className={`${config.iconClass} ${config.icon === 'loader' ? 'animate-spin' : ''}`}
        />
        <div>
          <p className="text-sm font-medium text-text" data-testid="context-empty-title">{config.title}</p>
          <p className="text-xs text-muted/60 mt-1 max-w-[320px]">{config.description}</p>
        </div>
        <span className={`inline-flex px-2 py-0.5 text-[10px] font-semibold rounded ${
          classification === 'legacy_no_log' ? 'bg-muted/15 text-muted border border-muted/30'
            : classification === 'persisted_without_context' ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
            : classification === 'pending_post_save' ? 'bg-blue-500/15 text-blue-400 border border-blue-500/30'
            : 'bg-error/15 text-error border border-error/30'
        }`} data-testid="context-empty-badge">
          {classification === 'legacy_no_log' ? 'Legacy'
            : classification === 'persisted_without_context' ? 'No Context'
            : classification === 'pending_post_save' ? 'In Progress'
            : 'Failed'}
        </span>

        {/* Action buttons — hidden for pending state, disabled during active runs */}
        {!isPending && (repairAllowed || retryEnrichAllowed) && (
          <div className="flex items-center gap-2 mt-2">
            {repairAllowed && (
              <button
                onClick={handleRepair}
                disabled={isBusy || isRunActive || isBlockedByActivePostSave}
                title={isBlockedByActivePostSave ? 'Cannot repair while another post-save job is active for this spec' : isRunActive ? 'Cannot repair while a run is active' : 'Diagnose and repair post-save state'}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-panel border border-border text-text hover:bg-accent/10 transition-colors ${isBusy || isRunActive || isBlockedByActivePostSave ? 'opacity-50 cursor-not-allowed' : ''}`}
                data-testid="context-repair-btn"
              >
                {repairState === 'repairing'
                  ? <><Loader2 size={12} className="animate-spin" /> Repairing…</>
                  : <><RotateCcw size={12} /> Repair Spec</>}
              </button>
            )}
            {retryEnrichAllowed && (
              <button
                onClick={handleRetryEnrich}
                disabled={isBusy || isRunActive || isBlockedByActivePostSave}
                title={isBlockedByActivePostSave ? 'Cannot retry while another post-save job is active for this spec' : isRunActive ? 'Cannot enrich while a run is active' : 'Re-enqueue enrichment job'}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-panel border border-border text-text hover:bg-accent/10 transition-colors ${isBusy || isRunActive || isBlockedByActivePostSave ? 'opacity-50 cursor-not-allowed' : ''}`}
                data-testid="context-retry-enrich-btn"
              >
                {repairState === 'retrying'
                  ? <><Loader2 size={12} className="animate-spin" /> Retrying…</>
                  : <><Sparkles size={12} /> Retry Enrich</>}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function GenerationLogTab({ specId, stories, refreshKey, workspaceId, activeRunStatus, blockingPostSaveJob, workflowInspection, readinessInspection, onWorkflowRefresh, onOpenSkillsTab }: { specId: string; stories: Story[]; refreshKey?: number; workspaceId: string; activeRunStatus?: 'running' | 'queued'; blockingPostSaveJob?: CanonicalPostSaveStageState | null; workflowInspection?: SpecWorkflowInspectionPayload | null; readinessInspection?: SpecReadinessInspectionPayload | null; onWorkflowRefresh?: () => void; onOpenSkillsTab?: () => void }) {
  const [logs, setLogs] = useState<GenerationLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [workflowState, setWorkflowState] = useState<SpecWorkflowInspectionPayload | null>(workflowInspection ?? null);
  const [readinessState, setReadinessState] = useState<SpecReadinessInspectionPayload | null>(readinessInspection ?? null);

  // Aggregate skillDetails from all stories' suggestedSkills, taking max relevance per unique name
  const skillDetails = useMemo(() => {
    const toSkill = (raw: unknown): SuggestedSkill =>
      typeof raw === 'string' ? { name: raw } : (raw as SuggestedSkill);
    const map = new Map<string, SuggestedSkill>();
    for (const story of stories) {
      for (const raw of (story as any).suggestedSkills ?? []) {
        const sk = toSkill(raw);
        const existing = map.get(sk.name);
        if (!existing || (sk.relevance ?? 0) > (existing.relevance ?? 0)) {
          map.set(sk.name, sk);
        }
      }
    }
    return Array.from(map.values());
  }, [stories]);

  useEffect(() => {
    setWorkflowState(workflowInspection ?? null);
    setReadinessState(readinessInspection ?? null);
  }, [workflowInspection, readinessInspection]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    Promise.all([
      apiFetch<GenerationLog | { logs: GenerationLog[] }>(`/api/specs/${specId}/generation-log${showAll ? '?all=true' : ''}`).catch(() => null),
      getSpecWorkflow(specId, workspaceId).catch(() => null),
      getSpecReadinessInspection(specId, workspaceId).catch(() => null),
    ])
      .then(([logResponse, workflowResponse, readinessResponse]) => {
        if (cancelled) return;
        if (!logResponse) setLogs([]);
        else if ('logs' in logResponse) setLogs(logResponse.logs);
        else setLogs([logResponse]);
        setWorkflowState(workflowResponse);
        setReadinessState(readinessResponse);
      })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [specId, workspaceId, showAll, refreshKey]);

  const repairAllowed = workflowTopLevelActionAllowed(workflowState, readinessState, 'repair_spec');
  const retryEnrichAllowed = workflowStageActionAllowed(workflowState, 'enrich', 'retry_stage');
  const stageActionHints = workflowState ? {
    enrich: workflowState.stages.find((stage) => stage.key === 'enrich')?.safeActionHints ?? [],
    matchSkills: workflowState.stages.find((stage) => stage.key === 'matchSkills')?.safeActionHints ?? [],
    memorySynthesis: workflowState.stages.find((stage) => stage.key === 'memorySynthesis')?.safeActionHints ?? [],
  } : undefined;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted text-sm">
        <Loader2 size={16} className="animate-spin mr-2" />Loading generation data...
      </div>
    );
  }

  if (logs.length === 0) {
    return (
      <div className="p-4 space-y-4">
        <WorkflowChecklistCard
          specId={specId}
          workspaceId={workspaceId}
          workflow={workflowState}
          readiness={readinessState}
          activeRunStatus={activeRunStatus}
          onRetried={onWorkflowRefresh}
          onOpenSkillsTab={onOpenSkillsTab}
        />
        <ContextTabEmptyState
          specId={specId}
          workspaceId={workspaceId}
          classification="legacy_no_log"
          activeRunStatus={activeRunStatus}
          blockingPostSaveJob={blockingPostSaveJob}
          repairAllowed={repairAllowed}
          retryEnrichAllowed={retryEnrichAllowed}
          onRepaired={() => { setLogs([]); onWorkflowRefresh?.(); }}
        />
      </div>
    );
  }

  // Determine if the latest log is persisted-without-context or has pending/failed post-save
  const latestLog = logs[0];
  const latestContext = parseContextSummary(latestLog);
  const latestStages = workflowInspectionToPostSaveStages(workflowState) ?? parsePostSaveStages(latestLog);
  const latestCapture = readinessInspectionToContextCaptureStatus(readinessState) ?? parseContextCaptureStatus(latestLog);

  const emptyClassification = classifyContextState(latestContext, latestStages, latestCapture);

  return (
    <div className="p-4 space-y-4">
      <WorkflowChecklistCard
        specId={specId}
        workspaceId={workspaceId}
        workflow={workflowState}
        readiness={readinessState}
        activeRunStatus={activeRunStatus}
        onRetried={onWorkflowRefresh}
        onOpenSkillsTab={onOpenSkillsTab}
      />
      {emptyClassification && (
        <ContextTabEmptyState
          specId={specId}
          workspaceId={workspaceId}
          classification={emptyClassification}
          activeRunStatus={activeRunStatus}
          blockingPostSaveJob={blockingPostSaveJob}
          repairAllowed={repairAllowed}
          retryEnrichAllowed={retryEnrichAllowed}
          onRepaired={() => { setShowAll(s => !s); onWorkflowRefresh?.(); }}
        />
      )}
      {logs.map((log, i) => {
        const cost = log.input_tokens && log.output_tokens
          ? estimateCost(log.model, log.input_tokens, log.output_tokens)
          : null;

        const contextSummary = parseContextSummary(log);
        const isEnriched = !!log.enriched;
        const effectiveLog = i === 0 && workflowState
          ? {
            ...log,
            postSaveStages: workflowInspectionToPostSaveStages(workflowState) ?? log.postSaveStages,
            contextCaptureStatus: readinessInspectionToContextCaptureStatus(readinessState) ?? log.contextCaptureStatus,
          }
          : log;
        const presentation = getGenerationLogPresentation(effectiveLog);
        const postSaveStages = parsePostSaveStages(effectiveLog);
        const contextCaptureStatus = parseContextCaptureStatus(effectiveLog);

        return (
          <div key={log.id} className="border border-border rounded-lg bg-panel overflow-hidden">
            {/* Context summary card — PRIMARY content, shown above generation header */}
            {contextSummary && (
              <div className="px-4 pt-3 pb-0">
                <ContextSummaryCard summary={contextSummary} skillDetails={!isEnriched && skillDetails.length > 0 ? skillDetails : undefined} />
              </div>
            )}

            {/* Generation header */}
            <div className={`px-4 py-3 ${contextSummary ? 'border-t border-border/50 mt-3' : ''}`}>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  {presentation.tone === 'success' ? (
                    <CheckCircle2 size={14} className="text-success" />
                  ) : (
                    <XCircle size={14} className="text-error" />
                  )}
                  <span className="text-xs font-medium text-text">
                    {presentation.title}
                  </span>
                  <span className={`px-1.5 py-0.5 text-[10px] font-semibold rounded ${presentation.badgeClassName}`}>
                    {presentation.badgeLabel}
                  </span>
                  {i === 0 && logs.length > 1 && (
                    <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-accent/15 text-accent">Latest</span>
                  )}
                </div>
                <span className="text-[10px] text-muted">{formatDate(log.created_at)}</span>
              </div>

              {/* Stats row */}
              <div className="flex flex-wrap items-center gap-3 text-xs text-muted mt-1">
                <span className="px-1.5 py-0.5 font-mono rounded bg-panel border border-border text-[10px]">
                  {log.model}
                </span>
                {log.provider && (
                  <span>via {log.provider}</span>
                )}
                {log.duration_ms != null && (
                  <span className="flex items-center gap-1">
                    <Clock size={10} />
                    {log.duration_ms < 1000
                      ? `${log.duration_ms}ms`
                      : `${(log.duration_ms / 1000).toFixed(1)}s`}
                  </span>
                )}
              </div>

              {/* Token usage */}
              {(log.input_tokens != null || log.output_tokens != null) && (
                <div className="flex items-center gap-3 text-xs text-muted mt-2">
                  {log.input_tokens != null && (
                    <span>Input: {(log.input_tokens / 1000).toFixed(1)}K tokens</span>
                  )}
                  {log.output_tokens != null && (
                    <span>Output: {(log.output_tokens / 1000).toFixed(1)}K tokens</span>
                  )}
                  {cost != null && (
                    <span className="text-text font-medium">Cost: ~${cost.toFixed(3)}</span>
                  )}
                </div>
              )}
            </div>

            {/* Error detail (for failed generations) */}
            {log.error && (
              <div className="px-4 py-2 bg-error/5 border-t border-error/20">
                <div className="flex items-start gap-2">
                  <AlertCircle size={12} className="text-error mt-0.5 shrink-0" />
                  <div className="text-xs">
                    {log.error_category && (
                      <span className="inline-block px-1.5 py-0.5 mb-1 text-[10px] font-medium rounded bg-error/15 text-error">
                        {log.error_category}
                      </span>
                    )}
                    <p className="text-error/80 break-words">{log.error}</p>
                  </div>
                </div>
              </div>
            )}

            {/* PSE-004: Context capture classification */}
            {contextCaptureStatus && <ContextCaptureCard status={contextCaptureStatus} />}

            {/* PSE-003: Per-stage post-save pipeline status */}
            {postSaveStages && <PostSaveStagesCard stages={postSaveStages} specId={specId} workspaceId={workspaceId} activeRunStatus={activeRunStatus} blockingPostSaveJob={blockingPostSaveJob} stageActionHints={i === 0 ? stageActionHints : undefined} onRetried={() => { setShowAll(s => !s); onWorkflowRefresh?.(); }} />}

            {/* Retrieval method badge + per-story annotation preview (enriched entries) */}
            {log.enriched && log.retrieval_method && (() => {
              const { label, badgeClassName } = getRetrievalMethodPresentation(log.retrieval_method);
              // Derive annotations from already-loaded story metadata only — no raw
              // retrieval blobs are read or stashed in global state (trace-safe).
              const annotations = extractStoryContextAnnotations(stories);

              return (
                <div className="px-4 py-3 border-t border-border/50" data-testid="retrieval-method-section">
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-semibold rounded border ${badgeClassName}`} data-testid="retrieval-method-badge">
                      {label}
                    </span>
                    <span className="text-[10px] text-muted">retrieval method</span>
                  </div>
                  {annotations.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-[10px] text-muted mb-1">Story annotations ({annotations.length})</p>
                      {annotations.map(annotation => (
                        <details key={annotation.storyId} className="group rounded border border-border/50 bg-bg/50 overflow-hidden">
                          <summary className="flex items-center gap-2 px-2 py-1.5 text-xs cursor-pointer select-none list-none hover:bg-panel transition-colors">
                            <span className="font-mono text-[10px] text-accent shrink-0">{annotation.storyId}</span>
                            <span className="text-muted truncate">{annotation.storyTitle}</span>
                          </summary>
                          <div className="px-2 pb-2">
                            <StoryAnnotationPreview preview={annotation.preview} hasMore={annotation.hasMore} fullText={annotation.fullText} />
                          </div>
                        </details>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}

          </div>
        );
      })}

      {/* Show all toggle */}
      {!showAll && (
        <button
          onClick={() => setShowAll(true)}
          className="w-full text-center text-xs text-accent hover:text-accent/80 py-2 transition-colors"
        >
          Show all generation attempts
        </button>
      )}
    </div>
  );
}

/* ─── Attachments Tab ───────────────────────────────────────────── */

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentTypeIcon({ contentType }: { contentType: string }) {
  if (contentType.startsWith('image/')) return <FileImage size={14} className="text-accent" />;
  if (contentType === 'application/pdf' || contentType.includes('word')) return <FileText size={14} className="text-warning" />;
  return <File size={14} className="text-muted" />;
}

function AttachmentsTab({ specId }: { specId: string }) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [previewImage, setPreviewImage] = useState<{ url: string; filename: string } | null>(null);
  const toast = useGlobalToast();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiFetch<Attachment[]>(`/api/specs/${specId}/attachments`)
      .then(data => { if (!cancelled) setAttachments(data); })
      .catch(() => { if (!cancelled) setAttachments([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [specId]);

  async function handleDelete(id: string) {
    setDeleting(id);
    try {
      await apiFetch(`/api/specs/${specId}/attachments/${id}`, { method: 'DELETE' });
      setAttachments(prev => prev.filter(a => a.id !== id));
      toast.show('Attachment deleted', 'success');
    } catch {
      toast.show('Failed to delete attachment', 'error');
    } finally {
      setDeleting(null);
      setDeleteConfirm(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted text-sm">
        <Loader2 size={16} className="animate-spin mr-2" />Loading attachments...
      </div>
    );
  }

  if (attachments.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center px-6">
        <Paperclip size={32} className="text-muted/30 mb-3" />
        <p className="text-sm text-muted">No attachments.</p>
        <p className="text-xs text-muted/60 mt-1">Go to Spec Forge to add files.</p>
      </div>
    );
  }

  return (
    <>
      <div className="divide-y divide-border">
        {attachments.map(a => {
          const isImage = a.contentType.startsWith('image/');
          const attachmentUrl = `${BASE_URL}/api/specs/${encodeURIComponent(specId)}/attachments/${a.id}`;
          return (
            <div key={a.id} className="flex items-center gap-3 px-4 py-3 hover:bg-panel/50 transition-colors">
              {isImage ? (
                <button
                  type="button"
                  onClick={() => setPreviewImage({ url: attachmentUrl, filename: a.filename })}
                  className="shrink-0 rounded overflow-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  title="Preview image"
                  aria-label={`Preview ${a.filename}`}
                >
                  <img
                    src={attachmentUrl}
                    alt={a.filename}
                    className="w-10 h-10 object-cover rounded"
                  />
                </button>
              ) : (
                <AttachmentTypeIcon contentType={a.contentType} />
              )}
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-text truncate">{a.filename}</p>
                <p className="text-[10px] text-muted mt-0.5">
                  {formatFileSize(a.fileSize)} · {new Date(a.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  {a.uploadedBy?.name && ` · ${a.uploadedBy.name}`}
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {isImage && (
                  <button
                    onClick={() => setPreviewImage({ url: attachmentUrl, filename: a.filename })}
                    title="Preview"
                    aria-label={`Preview ${a.filename}`}
                    className="p-1.5 rounded text-muted hover:text-text hover:bg-panel transition-colors"
                  >
                    <ZoomIn size={13} />
                  </button>
                )}
                <a
                  href={attachmentUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Download"
                  className="p-1.5 rounded text-muted hover:text-text hover:bg-panel transition-colors"
                >
                  <Download size={13} />
                </a>
                {deleteConfirm === a.id ? (
                  <div className="flex items-center gap-1">
                    <span className="text-[10px] text-muted whitespace-nowrap">Delete {a.filename.length > 12 ? a.filename.slice(0, 12) + '…' : a.filename}?</span>
                    <button
                      onClick={() => handleDelete(a.id)}
                      disabled={deleting === a.id}
                      className="px-2 py-0.5 text-[10px] rounded bg-error/15 text-error border border-error/30 hover:bg-error/25 transition-colors disabled:opacity-50"
                    >
                      {deleting === a.id ? <Loader2 size={10} className="animate-spin" /> : 'Yes'}
                    </button>
                    <button
                      onClick={() => setDeleteConfirm(null)}
                      className="px-2 py-0.5 text-[10px] rounded bg-panel border border-border text-muted hover:text-text transition-colors"
                    >
                      No
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setDeleteConfirm(a.id)}
                    title="Delete"
                    className="p-1.5 rounded text-muted hover:text-error hover:bg-error/10 transition-colors"
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <ImagePreviewModal
        isOpen={previewImage !== null}
        onClose={() => setPreviewImage(null)}
        imageUrl={previewImage?.url ?? ''}
        filename={previewImage?.filename ?? ''}
      />
    </>
  );
}
