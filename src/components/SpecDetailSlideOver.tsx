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
  Download, Copy, Check, Play, GitFork,
  Loader2, Plus, Sparkles, Trash2, History, FileSearch, Paperclip,
  FileText, FileImage, File, ZoomIn,
} from 'lucide-react';
import type { Attachment } from '../types/attachment';
import { BASE_URL } from '../lib/apiFetch';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useAuth } from '../contexts/AuthContext';
import { useGlobalToast } from '../contexts/ToastContext';
import { apiFetch } from '../lib/apiFetch';
import { StoryCard } from './StoryCard';
import type { Story } from './StoryCard';
import { InlineStoryEditor } from './InlineStoryEditor';
import { StoryComments } from './StoryComments';
import DependencyGraph from './DependencyGraph';
import MermaidDiagram from './MermaidDiagram';
import { SpecVersionHistory } from './SpecVersionHistory';
import { TagChips } from './TagChips';
import TriggerPopover from './TriggerPopover';
import { ImagePreviewModal } from './ImagePreviewModal';
import type { PanelId } from './Sidebar';
import ContextSummaryCard from './ContextSummaryCard';
import type { ContextSummary } from '../panels/SpecForgeOutput';

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

  // Backdrop click
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
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
}) {
  const { workspaceId } = useWorkspace();
  const { user } = useAuth();
  const toast = useGlobalToast();
  const isFreePlan = !user?.plan || user.plan === 'free';

  // Summary + detail
  const [summary, setSummary] = useState<SpecSlideOverSummary | null>(initialSummary);
  const [detail, setDetail] = useState<SpecDetailData | null>(null);
  const [detailLoading, setDetailLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<PreviewTab>(initialTab ?? 'stories');

  // Stories
  const [localStories, setLocalStories] = useState<Story[]>([]);

  // Run state
  const [runState, setRunState] = useState<'idle' | 'triggering' | 'conflict' | 'queued' | 'success' | 'error'>('idle');
  const [queuePosition, setQueuePosition] = useState(0);
  const [runError, setRunError] = useState('');
  const [showTriggerPopover, setShowTriggerPopover] = useState(false);
  const [hasActiveRun, setHasActiveRun] = useState(false);

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

  // Approve/Reject
  const [actionLoading, setActionLoading] = useState(false);

  // Focus trap ref
  const firstFocusRef = useRef<HTMLButtonElement>(null);

  // Auto-focus on mount
  useEffect(() => {
    firstFocusRef.current?.focus();
  }, [specId]);

  // Fetch detail + summary
  useEffect(() => {
    if (!specId || !workspaceId) return;
    let cancelled = false;
    setDetailLoading(true);

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
  }, [specId, workspaceId, initialSummary]);

  // Sync stories from detail
  useEffect(() => { setLocalStories(detail?.userStories ?? detail?.stories ?? []); }, [detail]);

  // Reset tab on spec change
  useEffect(() => { setActiveTab(initialTab ?? 'stories'); }, [specId, initialTab]);

  // Check if workspace has an active run (so we can show Queue button upfront)
  useEffect(() => {
    if (!workspaceId) return;
    apiFetch<{ items: Array<{ status: string }> }>(`/api/pipeline/runs?workspaceId=${workspaceId}&limit=5`)
      .then(res => setHasActiveRun(res.items?.some(r => r.status === 'running' || r.status === 'paused') ?? false))
      .catch(() => { /* ignore */ });
  }, [workspaceId]);

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

  const handleRun = async (autoWorktree: boolean, options?: { forceSequential?: boolean; queue?: boolean }) => {
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
        }) },
      );
      if (res.conflict) setRunState('conflict');
      else if (res.queued) { setQueuePosition(res.position ?? 1); setRunState('queued'); setTimeout(() => { onClose(); onNavigate?.('runs'); }, 2000); }
      else { setRunState('success'); setTimeout(() => { onClose(); onNavigate?.('runs'); }, 1200); }
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
  const cfg = summary ? STATUS_CONFIG[summary.status] : null;
  const isDraft = summary?.status === 'pending';
  const canRun = summary?.status === 'approved' || summary?.status === 'completed';

  const specSkillCount = useMemo(() => {
    const seen = new Set<string>();
    for (const s of stories) {
      for (const sk of (s as any).suggestedSkills ?? []) seen.add(sk.name ?? sk);
    }
    return seen.size;
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
            {activeTab === 'stories' && (
              <StoriesTabContent stories={stories} specId={specId} workspaceId={workspaceId ?? ''}
                onToggleExclude={summary?.status === 'approved' ? handleToggleExclude : undefined}
                onStoryUpdated={(updated) => setLocalStories(prev => prev.map(s => s.id === updated.id ? { ...s, ...updated } : s))} />
            )}
            {activeTab === 'history' && workspaceId && <SpecVersionHistory specId={specId} workspaceId={workspaceId} />}
            {activeTab === 'context' && <GenerationLogTab specId={specId} />}
            {activeTab === 'skills' && <SpecSkillsTab stories={stories} workspaceId={workspaceId ?? ''} />}
            {activeTab === 'graph' && workspaceId && <DependencyGraph specId={specId} workspaceId={workspaceId} />}
            {activeTab === 'diagram' && <MermaidDiagram diagram={diagram} idPrefix="mermaid-slideover" />}
            {activeTab === 'json' && <JsonTab spec={detail} specId={specId} />}
            {activeTab === 'attachments' && <AttachmentsTab specId={specId} />}
          </div>
        </>
      )}

      {/* Footer actions */}
      {detail && (
        <div className="px-4 py-3 border-t border-border shrink-0 bg-bg space-y-2">
          {/* Run in Pipeline */}
          {canRun && (
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
                  {showTriggerPopover && !isFreePlan && (
                    <TriggerPopover loading={runState === 'triggering'} onTrigger={handleRun} onClose={() => setShowTriggerPopover(false)}
                      specPath={`forge/specs/approved/${summary!.id}.json`} workspaceId={workspaceId ?? undefined} />
                  )}
                  {hasActiveRun && runState !== 'triggering' && (
                    <div className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 mb-2 flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shrink-0" />
                      <span className="text-xs text-amber-300 flex-1">A run is active in this workspace</span>
                    </div>
                  )}
                  <div className={hasActiveRun ? 'flex gap-2' : ''}>
                    <button onClick={() => setShowTriggerPopover(true)} disabled={runState === 'triggering'}
                      className={`flex items-center justify-center gap-1.5 py-2 rounded text-sm font-medium bg-accent text-white hover:opacity-90 disabled:opacity-60 transition-opacity ${hasActiveRun ? 'flex-1' : 'w-full'}`}>
                      {runState === 'triggering' ? <><Loader2 size={14} className="animate-spin" /> Starting...</> : <><Play size={14} /> {hasActiveRun ? 'Run Now' : 'Run in Pipeline'}{deferredCount > 0 && <span className="ml-1 px-1.5 py-0.5 text-[10px] font-semibold rounded-full bg-[var(--kbd-bg)]">{deferredCount} deferred</span>}</>}
                    </button>
                    {hasActiveRun && (
                      <button
                        onClick={() => handleRun(false, { queue: true })}
                        disabled={runState === 'triggering'}
                        className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded text-sm font-medium bg-amber-500/15 text-amber-300 border border-amber-500/30 hover:bg-amber-500/25 disabled:opacity-60 transition-colors"
                      >
                        <Clock size={14} /> Queue Next
                      </button>
                    )}
                  </div>
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
        </div>
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
        {deferredCount > 0 && <span className="ml-2 text-muted/60">&middot; {deferredCount} deferred</span>}
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
        ),
      )}
    </div>
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

interface GenerationLog {
  id: number;
  spec_slug: string;
  model: string;
  provider: string | null;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  context_summary: string;
  error: string | null;
  error_category: string | null;
  status: string;
  created_at: string;
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

function GenerationLogTab({ specId }: { specId: string }) {
  const [logs, setLogs] = useState<GenerationLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    apiFetch<GenerationLog | { logs: GenerationLog[] }>(
      `/api/specs/${specId}/generation-log${showAll ? '?all=true' : ''}`
    )
      .then(res => {
        if (cancelled) return;
        if ('logs' in res) setLogs(res.logs);
        else setLogs([res]);
      })
      .catch(() => { if (!cancelled) setLogs([]); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [specId, showAll]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted text-sm">
        <Loader2 size={16} className="animate-spin mr-2" />Loading generation data...
      </div>
    );
  }

  if (logs.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-sm text-muted">No generation data available</p>
          <p className="text-xs text-muted/60 mt-1 text-center max-w-[280px]">Context logging was introduced in a recent update. Specs generated after that point will show direction layers, token usage, and model details here.</p>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      {logs.map((log, i) => {
        const cost = log.input_tokens && log.output_tokens
          ? estimateCost(log.model, log.input_tokens, log.output_tokens)
          : null;

        // Parse context_summary from JSON string (may be "{}" for pre-migration specs)
        let contextSummary: ContextSummary | null = null;
        if (log.context_summary) {
          try {
            const parsed = typeof log.context_summary === 'string'
              ? JSON.parse(log.context_summary)
              : log.context_summary;
            if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
              contextSummary = parsed as ContextSummary;
            }
          } catch {
            // ignore parse errors
          }
        }

        return (
          <div key={log.id} className="border border-border rounded-lg bg-panel overflow-hidden">
            {/* Context summary card — PRIMARY content, shown above generation header */}
            {contextSummary && (
              <div className="px-4 pt-3 pb-0">
                <ContextSummaryCard summary={contextSummary} />
              </div>
            )}

            {/* Generation header */}
            <div className={`px-4 py-3 ${contextSummary ? 'border-t border-border/50 mt-3' : ''}`}>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  {log.status === 'completed' ? (
                    <CheckCircle2 size={14} className="text-success" />
                  ) : (
                    <XCircle size={14} className="text-error" />
                  )}
                  <span className="text-xs font-medium text-text">
                    {log.status === 'completed' ? 'Generation Succeeded' : 'Generation Failed'}
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
