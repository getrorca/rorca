import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useGlobalToast } from '../contexts/ToastContext';
import { apiFetch } from '../lib/apiFetch';
import BatchForge from './BatchForge';
import SpecForgeProgress from '../components/SpecForgeProgress';
import SpecForgePreview from '../components/SpecForgePreview';
import TemplatePickerModal from '../components/TemplatePickerModal';
import AppHeader from '../components/AppHeader';
import { SpecPreview, REVIEW_STATUS_CONFIG, relativeTime } from '../components/SpecReviewInline';
import type { SpecSummary, SpecDetail, ReviewStatus } from '../components/SpecReviewInline';
import { SpecConfirmDialog } from '../components/SpecConfirmDialog';
import { ReadinessRing } from '../components/ReadinessRing';
import { TagChipsReadonly } from '../components/TagChips';
import { AssigneeAvatar } from '../components/AssigneeDropdown';
import type { Assignee } from '../components/AssigneeDropdown';
import { useHotkeys } from '../hooks/useHotkeys';

import { ChevronRight, ChevronDown, Clock, Plus, Inbox } from 'lucide-react';
import type { PanelId } from '../components/Sidebar';
import { briefToSlug, KEBAB_RE } from '../lib/slugify';
import type { GeneratedSpec } from './SpecForgeOutput';
import AgentPicker, { type AgentType } from '../components/AgentPicker';
import ModelSearchSelect, { type ModelOption } from '../components/ModelSearchSelect';

type ForgeMode = 'single' | 'batch';
type ReviewFilter = 'all' | 'review_requested' | 'changes_requested';

const REVIEW_FILTERS: { id: ReviewFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'review_requested', label: 'Needs Review' },
  { id: 'changes_requested', label: 'Changes Requested' },
];

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

const CONTEXT_DOTS = [
  { key: 'l1' as const, layer: 1, label: 'Standards', emptyHeading: 'Standards not configured', emptyDesc: 'Engineering principles and coding style — applied across all workspaces.' },
  { key: 'l2' as const, layer: 2, label: 'Conventions', emptyHeading: 'Conventions not configured', emptyDesc: 'Patterns for this type of project — detected from your codebase or entered manually.' },
  { key: 'l3' as const, layer: 3, label: 'Project', emptyHeading: 'Project context not configured', emptyDesc: 'Stack, architecture, and key constraints specific to this workspace.' },
] as const;

export default function SpecForgePanelPage({ onNavigate, onNavigateToRun, initialBrief, onBriefConsumed, showPending }: { onNavigate?: (panel: PanelId) => void; onNavigateToRun?: (runId: number) => void; initialBrief?: string | null; onBriefConsumed?: () => void; showPending?: boolean }) {
  const { workspaceId, workspaces } = useWorkspace();
  const workspace = workspaces.find((w) => w.id === workspaceId);
  const [forgeMode, setForgeMode] = useState<ForgeMode>('single');

  // Spec Identity
  const [specName, setSpecName] = useState('');
  const [specNameError, setSpecNameError] = useState('');

  // Spec generation model selection (persisted in localStorage)
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState(() => {
    try { return localStorage.getItem('rorca:forge:model') ?? ''; } catch { return ''; }
  });
  const [defaultModelId, setDefaultModelId] = useState<string | null>(null);
  const [activeProvider, setActiveProvider] = useState<string>('claude-cli');

  // Workspace execution agent config (from Settings)
  const [wsAgentType, setWsAgentType] = useState<AgentType>('claude');
  const [wsAgentModel, setWsAgentModel] = useState<string | null>(null);
  const [wsModelDisplayName, setWsModelDisplayName] = useState<string | null>(null);
  const [wsAgentBinaries, setWsAgentBinaries] = useState<{ claudeInstalled?: boolean; opencodeInstalled?: boolean; codexInstalled?: boolean }>({});

  // Per-spec execution agent override
  const [overrideAgent, setOverrideAgent] = useState(false);
  const [overrideAgentType, setOverrideAgentType] = useState<AgentType>('claude');
  const [overrideAgentModel, setOverrideAgentModel] = useState<string | null>(null);

  // OpenCode model catalog (for AgentPicker)
  const [opencodeModels, setOpencodeModels] = useState<ModelOption[]>([]);

  // Fetch available spec generation models, active provider, workspace agent config, and opencode models
  useEffect(() => {
    if (!workspaceId) return;
    Promise.all([
      apiFetch<{ models: ModelOption[]; defaultModel: string }>(`/api/direction/models?workspaceId=${workspaceId}`),
      apiFetch<{ provider: string }>(`/api/vault/keys/default-provider?workspaceId=${workspaceId}`),
      apiFetch<{
        agentType: AgentType; agentModel: string | null; modelDisplayName: string | null;
        opencodeInstalled?: boolean; codexInstalled?: boolean;
      }>('/api/config'),
      apiFetch<{ models: Array<{ id: string; name: string; provider: string; contextWindow: number; costPer1kInput?: number; costPer1kOutput?: number; speedTier?: string; costTier?: string }> }>('/api/config/opencode-models'),
    ]).then(([modelData, providerData, configData, ocModels]) => {
      setAvailableModels(modelData.models);
      setDefaultModelId(modelData.defaultModel);
      setActiveProvider(providerData.provider);
      // Workspace agent config
      setWsAgentType(configData.agentType);
      setWsAgentModel(configData.agentModel);
      setWsModelDisplayName(configData.modelDisplayName);
      setWsAgentBinaries({
        claudeInstalled: true, // Claude CLI is always assumed present
        opencodeInstalled: configData.opencodeInstalled,
        codexInstalled: configData.codexInstalled,
      });
      // Initialize override defaults from workspace config
      setOverrideAgentType(configData.agentType);
      setOverrideAgentModel(configData.agentModel);
      // Transform opencode models to ModelOption format
      setOpencodeModels(ocModels.models.map(m => ({
        id: m.id,
        label: m.name,
        provider: m.provider,
        providerType: undefined,
        costPer1kInput: m.costPer1kInput ?? 0,
        costPer1kOutput: m.costPer1kOutput ?? 0,
        contextWindow: m.contextWindow,
        speedTier: m.speedTier,
        costTier: m.costTier,
        recommended: false,
      })));
    }).catch(() => { });
  }, [workspaceId]);

  // Persist model selection to localStorage
  useEffect(() => {
    try {
      if (selectedModel) {
        localStorage.setItem('rorca:forge:model', selectedModel);
      } else {
        localStorage.removeItem('rorca:forge:model');
      }
    } catch { /* quota */ }
  }, [selectedModel]);

  // Advanced Options
  const [advancedOpen, setAdvancedOpen] = useState(() => {
    try { return localStorage.getItem('rorca:forge:advancedOpen') === 'true'; } catch { return false; }
  });

  // Story Count
  const STORY_COUNT_PRESETS = [3, 5, 8, 10, 15, 20] as const;
  const [storyCount, setStoryCount] = useState(() => {
    try {
      const saved = localStorage.getItem('rorca:forge:storyCount');
      if (saved) { const n = parseInt(saved, 10); if (!isNaN(n) && n >= 0) return n; }
    } catch { /* ignore */ }
    return 0; // Auto
  });
  const isCustomCount = storyCount !== 0 && !STORY_COUNT_PRESETS.includes(storyCount as typeof STORY_COUNT_PRESETS[number]);
  const [showCustomInput, setShowCustomInput] = useState(isCustomCount);
  const [storyCountRaw, setStoryCountRaw] = useState(String(storyCount));

  // Brief (persisted in localStorage)
  const [specBrief, setSpecBrief] = useState(() => {
    try { return localStorage.getItem('rorca:forge:brief') ?? ''; } catch { return ''; }
  });
  const briefRef = useRef<HTMLTextAreaElement>(null);

  // Debounced slug preview derived from brief
  const [previewSlug, setPreviewSlug] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => {
      setPreviewSlug(specName ? '' : briefToSlug(specBrief));
    }, 300);
    return () => clearTimeout(timer);
  }, [specBrief, specName]);

  const effectiveSlug = useMemo(() => specName || previewSlug, [specName, previewSlug]);

  // Auto-resize textarea between 6 and 20 rows
  const autoResizeBrief = useCallback(() => {
    const el = briefRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 20;
    const minH = lineHeight * 6;
    const maxH = lineHeight * 20;
    el.style.height = `${Math.min(maxH, Math.max(minH, el.scrollHeight))}px`;
  }, []);

  // Persist brief to localStorage
  useEffect(() => {
    try { localStorage.setItem('rorca:forge:brief', specBrief); } catch { /* quota */ }
  }, [specBrief]);

  // Auto-resize on mount and when brief changes
  useEffect(() => { autoResizeBrief(); }, [specBrief, autoResizeBrief]);

  // Auto-focus brief on mount (only if not showing pending view)
  useEffect(() => {
    if (!initialBrief && !showPending) {
      setTimeout(() => briefRef.current?.focus(), 50);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Apply initialBrief from command palette
  useEffect(() => {
    if (initialBrief != null) {
      if (initialBrief.length > 0) {
        setSpecBrief(initialBrief);
      }
      setTimeout(() => briefRef.current?.focus(), 100);
      onBriefConsumed?.();
    }
  }, [initialBrief, onBriefConsumed]);

  // Generation state
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedSpec, setGeneratedSpec] = useState<GeneratedSpec | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [apiDone, setApiDone] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const advancedInnerRef = useRef<HTMLDivElement>(null);
  const [advancedHeight, setAdvancedHeight] = useState<number>(0);
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);

  // Brief collapse state — collapsed after spec generation, expanded on click
  const [briefExpanded, setBriefExpanded] = useState(false);

  // Context health dots state
  const [directionLayers, setDirectionLayers] = useState<DirectionAllResponse['layers'] | null>(null);
  const [contextPopover, setContextPopover] = useState<string | null>(null);
  const [quickDirectionText, setQuickDirectionText] = useState('');

  // ─── Pending specs state (merged from ReviewQueuePanel) ──────────
  const [pendingSpecs, setPendingSpecs] = useState<SpecSummary[]>([]);
  const [pendingLoading, setPendingLoading] = useState(true);
  const [selectedSpecId, setSelectedSpecId] = useState<string | null>(null);
  const [specDetail, setSpecDetail] = useState<SpecDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'stories' | 'graph' | 'diagram' | 'json'>('stories');
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>('all');
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [reviewComment, setReviewComment] = useState('');
  const [dialogMode, setDialogMode] = useState<'approve' | 'reject' | 'post-approve' | null>(null);
  const [hasUnsavedEdits, setHasUnsavedEdits] = useState(false);
  // Track whether the brief/create area is expanded vs collapsed
  const [createExpanded, setCreateExpanded] = useState(!showPending);

  // ⌘↩ approve, ⌘⌫ reject — only when a spec is selected
  useHotkeys(useMemo(() => [
    { key: 'mod+enter', handler: () => { if (selectedSpecId && !dialogMode) setDialogMode('approve'); } },
    { key: 'mod+backspace', handler: () => { if (selectedSpecId && !dialogMode) setDialogMode('reject'); } },
  ], [selectedSpecId, dialogMode]));

  // Fetch direction layers for context health dots
  useEffect(() => {
    if (!workspaceId) { setDirectionLayers(null); return; }
    apiFetch<DirectionAllResponse>(`/api/direction/all?workspaceId=${workspaceId}`)
      .then(res => setDirectionLayers(res.layers))
      .catch(() => setDirectionLayers(null));
  }, [workspaceId]);

  // Measure inner content height for smooth transition
  useEffect(() => {
    if (!advancedOpen) return;
    const measure = () => {
      if (advancedInnerRef.current) {
        // Add buffer for mt-4 margin (not included in scrollHeight) + breathing room
        setAdvancedHeight(advancedInnerRef.current.scrollHeight + 32);
      }
    };
    measure();
    // Re-measure after a frame in case async content (models dropdown) loaded late
    const raf = requestAnimationFrame(measure);
    window.addEventListener('resize', measure);
    return () => { window.removeEventListener('resize', measure); cancelAnimationFrame(raf); };
  }, [advancedOpen, showCustomInput, availableModels.length, overrideAgent, overrideAgentType]);

  const validateSpecName = useCallback((value: string) => {
    if (!value) {
      setSpecNameError('');
      return;
    }
    if (!KEBAB_RE.test(value)) {
      setSpecNameError('Must be kebab-case (e.g. user-auth-oauth)');
    } else {
      setSpecNameError('');
    }
  }, []);

  // Persist story count to localStorage
  useEffect(() => {
    try { localStorage.setItem('rorca:forge:storyCount', String(storyCount)); } catch { /* quota */ }
  }, [storyCount]);

  // Persist advancedOpen to localStorage
  useEffect(() => {
    try { localStorage.setItem('rorca:forge:advancedOpen', String(advancedOpen)); } catch { /* quota */ }
  }, [advancedOpen]);

  // Count how many advanced fields differ from defaults
  const customizedCount = useMemo(() => {
    let count = 0;
    if (specName) count++;
    if (selectedModel) count++;
    if (storyCount !== 0) count++;
    if (overrideAgent) count++;
    return count;
  }, [specName, selectedModel, storyCount, overrideAgent]);

  const handleStoryCountSelect = (value: string) => {
    if (value === 'custom') {
      setShowCustomInput(true);
      setStoryCountRaw(String(storyCount || 8));
    } else if (value === '0') {
      setShowCustomInput(false);
      setStoryCount(0);
      setStoryCountRaw('0');
    } else {
      setShowCustomInput(false);
      const n = parseInt(value, 10);
      if (!isNaN(n)) {
        setStoryCount(n);
        setStoryCountRaw(value);
      }
    }
  };

  const handleCustomCountChange = (value: string) => {
    setStoryCountRaw(value);
    const n = parseInt(value, 10);
    if (!isNaN(n) && n >= 1) setStoryCount(n);
  };

  const handleCustomCountBlur = () => {
    const clamped = Math.min(500, Math.max(1, storyCount || 1));
    setStoryCount(clamped);
    setStoryCountRaw(String(clamped));
  };

  // Quick Run state
  const [isQuickRunning, setIsQuickRunning] = useState(false);
  const { show: showToast } = useGlobalToast();

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
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          workspaceId,
          specName: specName || undefined,
          storyCount,
          specBrief,
          model: selectedModel || undefined,
        }),
      });
      setApiDone(true);
      setGeneratedSpec(result);
      setTimeout(() => {
        setIsGenerating(false);
        // Refresh pending list — newly generated spec shows up
        fetchPendingSpecs();
      }, 800);
    } catch (err: unknown) {
      if (controller.signal.aborted) return;
      setApiDone(true);
      const message = err instanceof Error ? err.message : String(err);
      const alternatives = availableModels
        .filter(m => m.id !== modelUsed)
        .map(m => m.label);
      const suggestion = alternatives.length > 0
        ? ` Try an alternative model: ${alternatives.join(', ')}.`
        : '';
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
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspaceId,
            brief: specBrief.trim(),
            model: selectedModel || undefined,
          }),
        },
      );
      if (res.conflict) {
        showToast('Another run is active in this workspace', 'error');
        if (res.activeRunId && onNavigateToRun) {
          onNavigateToRun(res.activeRunId);
        }
      } else if (res.runId) {
        showToast('Quick run started', 'success');
        if (onNavigateToRun) onNavigateToRun(res.runId);
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Quick run failed', 'error');
    } finally {
      setIsQuickRunning(false);
    }
  };

  const handleContextDotClick = (dotKey: string) => {
    setContextPopover(contextPopover === dotKey ? null : dotKey);
    setQuickDirectionText('');
  };

  const handleQuickDirectionSave = async (layerNum: number) => {
    if (!quickDirectionText.trim() || !workspaceId) return;
    try {
      await apiFetch('/api/direction', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          layer: layerNum,
          contentYaml: quickDirectionText.trim(),
          skipValidation: true,
        }),
      });
      const res = await apiFetch<DirectionAllResponse>(`/api/direction/all?workspaceId=${workspaceId}`);
      setDirectionLayers(res.layers);
      setContextPopover(null);
      setQuickDirectionText('');
      showToast('Direction saved', 'success');
    } catch {
      showToast('Failed to save direction', 'error');
    }
  };

  // Auto-detect direction for a single layer via scan-direction
  const [autoDetecting, setAutoDetecting] = useState<string | null>(null);
  const handleAutoDetect = async (dot: typeof CONTEXT_DOTS[number]) => {
    if (!workspaceId || autoDetecting) return;
    setAutoDetecting(dot.key);
    try {
      const res = await apiFetch<{ l1Draft: string; l2Draft: string; l3Draft: string }>(
        `/api/workspaces/${workspaceId}/scan-direction`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      );
      const draftMap: Record<string, string> = { l1: res.l1Draft, l2: res.l2Draft, l3: res.l3Draft };
      const draft = draftMap[dot.key];
      if (draft) {
        setQuickDirectionText(draft);
      } else {
        showToast('Auto-detect returned no content for this layer', 'error');
      }
    } catch {
      showToast('Auto-detect failed', 'error');
    } finally {
      setAutoDetecting(null);
    }
  };

  // ─── Pending specs: fetch, actions ───────────────────────────────
  const fetchPendingSpecs = useCallback(async () => {
    if (!workspaceId) return;
    setPendingLoading(true);
    try {
      const res = await apiFetch<{ items: SpecSummary[]; total: number }>(`/api/specs?workspaceId=${workspaceId}&status=pending`);
      setPendingSpecs(res.items);
    } catch {
      // silently fail — empty list is fine
    } finally {
      setPendingLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { fetchPendingSpecs(); }, [fetchPendingSpecs]);

  // Fetch spec detail when selected
  useEffect(() => {
    if (!selectedSpecId || !workspaceId) {
      setSpecDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    apiFetch<SpecDetail>(`/api/specs/${selectedSpecId}?workspaceId=${workspaceId}`)
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
  }, [selectedSpecId, workspaceId]);

  // ─── Spec actions (approve, reject, review) ──────────────────────
  const handleApprove = async (specId: string) => {
    if (hasUnsavedEdits) {
      if (!window.confirm('You have unsaved story edits. Approve without saving?')) return;
      setHasUnsavedEdits(false);
    }
    setActionLoading(true);
    try {
      await apiFetch(`/api/specs/${specId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      showToast('Spec approved', 'success');
      if (selectedSpecId === specId) {
        setSelectedSpecId(null);
        setSpecDetail(null);
      }
      await fetchPendingSpecs();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Approve failed', 'error');
    } finally {
      setActionLoading(false);
    }
  };

  const handleDialogApprove = async () => {
    if (!selectedSpecId) return;
    if (hasUnsavedEdits) {
      if (!window.confirm('You have unsaved story edits. Approve without saving?')) return;
      setHasUnsavedEdits(false);
    }
    setActionLoading(true);
    try {
      await apiFetch(`/api/specs/${selectedSpecId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      showToast('Spec approved', 'success');
      setDialogMode('post-approve');
      await fetchPendingSpecs();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Approve failed', 'error');
      setDialogMode(null);
    } finally {
      setActionLoading(false);
    }
  };

  const handleDialogReject = async (reason?: string) => {
    if (!selectedSpecId) return;
    setActionLoading(true);
    try {
      await apiFetch(`/api/specs/${selectedSpecId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, reason: reason || undefined }),
      });
      showToast('Spec rejected', 'success');
      setDialogMode(null);
      setSelectedSpecId(null);
      setSpecDetail(null);
      await fetchPendingSpecs();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Reject failed', 'error');
      setDialogMode(null);
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
      if (selectedSpecId === specId) {
        setSelectedSpecId(null);
        setSpecDetail(null);
      }
      await fetchPendingSpecs();
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
      await fetchPendingSpecs();
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
        body: JSON.stringify({ workspaceId, action, comment: reviewComment || undefined }),
      });
      showToast(action === 'approve' ? 'Review approved' : 'Changes requested', 'success');
      setReviewingId(null);
      setReviewComment('');
      if (selectedSpecId === specId) {
        setSelectedSpecId(null);
        setSpecDetail(null);
      }
      await fetchPendingSpecs();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Review failed', 'error');
    } finally {
      setActionLoading(false);
    }
  };

  const filteredPending = reviewFilter === 'all'
    ? pendingSpecs
    : pendingSpecs.filter(s => (s.reviewStatus ?? 'draft') === reviewFilter);

  const selectedSpec = filteredPending.find((s) => s.id === selectedSpecId);

  // When showPending prop changes and pending specs exist, collapse the create area
  useEffect(() => {
    if (showPending && pendingSpecs.length > 0) {
      setCreateExpanded(false);
    }
  }, [showPending, pendingSpecs.length]);

  if (!workspaceId) {
    return (
      <div className="flex items-center justify-center h-full text-muted">
        Select a workspace to use Spec Forge.
      </div>
    );
  }

  const hasPending = pendingSpecs.length > 0;

  return (
    <div className="flex flex-col h-full bg-bg">
      <AppHeader
        breadcrumbs={
          <div className="flex items-center gap-2">
            <span className="font-medium text-[var(--text)] text-sm tracking-tight">
              {workspace?.name ?? 'Workspace'}
            </span>
            <ChevronRight size={14} className="text-muted" />
            <span className="text-sm text-muted">Spec</span>
            {hasPending && (
              <>
                <span className="ml-1 px-1.5 py-0.5 text-[10px] font-semibold rounded-full bg-warning/15 text-warning">
                  {pendingSpecs.length} pending
                </span>
              </>
            )}
          </div>
        }
        actions={
          <div className="flex bg-panel rounded-lg border border-border p-0.5">
            {(['single', 'batch'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setForgeMode(mode)}
                aria-current={forgeMode === mode ? 'page' : undefined}
                className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${forgeMode === mode
                    ? 'bg-accent text-white shadow-sm'
                    : 'text-muted hover:text-[var(--text)] hover:bg-surface-200'
                  }`}
              >
                {mode === 'single' ? 'Single' : 'Batch'}
              </button>
            ))}
          </div>
        }
      />

      {forgeMode === 'batch' ? (
        <BatchForge />
      ) : selectedSpecId ? (
        /* ─── Expanded spec review (full panel) ──────────────────────── */
        <div className="flex flex-col flex-1 min-h-0">
          {/* Back bar */}
          <div className="flex items-center gap-3 px-4 py-2 border-b border-border shrink-0 bg-panel">
            <button
              onClick={() => {
                if (hasUnsavedEdits) {
                  if (!window.confirm('You have unsaved story edits. Discard them?')) return;
                  setHasUnsavedEdits(false);
                }
                setSelectedSpecId(null);
                setSpecDetail(null);
                setRejectingId(null);
                setRejectReason('');
                setReviewingId(null);
                setReviewComment('');
              }}
              className="text-xs text-accent hover:text-accent-hover transition-colors"
            >
              &larr; Back to Forge
            </button>
            <span className="text-sm font-mono text-text truncate">{selectedSpecId}</span>
          </div>
          <div className="flex-1 overflow-hidden">
            {detailLoading ? (
              <div className="flex items-center justify-center h-full text-muted text-sm">Loading spec...</div>
            ) : specDetail && selectedSpec ? (
              <SpecPreview
                spec={specDetail}
                summary={selectedSpec}
                activeTab={activeTab}
                onTabChange={setActiveTab}
                rejectingId={rejectingId}
                rejectReason={rejectReason}
                actionLoading={actionLoading}
                onRejectReasonChange={setRejectReason}
                onStartReject={() => setRejectingId(selectedSpecId)}
                onCancelReject={() => { setRejectingId(null); setRejectReason(''); }}
                onConfirmReject={() => handleReject(selectedSpecId)}
                onApprove={() => handleApprove(selectedSpecId)}
                onRequestReview={() => handleRequestReview(selectedSpecId)}
                reviewingId={reviewingId}
                reviewComment={reviewComment}
                onReviewCommentChange={setReviewComment}
                onStartReview={() => setReviewingId(selectedSpecId)}
                onCancelReview={() => { setReviewingId(null); setReviewComment(''); }}
                onConfirmReview={(action) => handleReview(selectedSpecId, action)}
                workspaceId={workspaceId}
                onAssignSpec={(a) => setPendingSpecs(prev => prev.map(s => s.id === selectedSpecId ? { ...s, assignee: a ?? undefined } : s))}
                onDirtyChange={setHasUnsavedEdits}
              />
            ) : (
              <div className="flex items-center justify-center h-full text-muted text-sm">Spec not found</div>
            )}
          </div>

          {/* Keyboard-triggered confirmation dialog */}
          {dialogMode && selectedSpecId && (
            <SpecConfirmDialog
              mode={dialogMode}
              specName={selectedSpec?.specName ?? selectedSpecId}
              loading={actionLoading}
              onConfirm={(reason) => {
                if (dialogMode === 'approve') handleDialogApprove();
                else if (dialogMode === 'reject') handleDialogReject(reason);
              }}
              onCancel={() => setDialogMode(null)}
              onGoToForge={() => { setDialogMode(null); setSelectedSpecId(null); setSpecDetail(null); }}
              onTriggerRun={() => { setDialogMode(null); setSelectedSpecId(null); setSpecDetail(null); }}
            />
          )}
        </div>
      ) : (
        /* ─── Main Forge view: Create + Pending ──────────────────────── */
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-2xl mx-auto px-6 pt-10 pb-20 space-y-6">

            {/* Create area — collapsible when pending specs exist */}
            {hasPending && !createExpanded && !generatedSpec && !isGenerating ? (
              <button
                onClick={() => setCreateExpanded(true)}
                className="w-full flex items-center gap-2 px-4 py-3 text-sm bg-panel border border-border rounded-lg text-left text-accent hover:border-accent/30 transition-colors group"
              >
                <Plus size={14} className="shrink-0" />
                <span className="font-medium">New Spec</span>
              </button>
            ) : (
              <>
                {/* Template prompt — visible when brief is empty */}
                {!specBrief.trim() && !generatedSpec && !isGenerating && (
                  <button
                    onClick={() => setShowTemplatePicker(true)}
                    className="w-full flex items-center gap-3 px-4 py-3 text-left bg-panel border border-dashed border-border rounded-lg hover:border-accent/40 hover:bg-accent/5 transition-colors group"
                  >
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

                {/* Brief textarea — collapses to single line after generation */}
                {generatedSpec && !isGenerating && !briefExpanded ? (
                  <button
                    onClick={() => setBriefExpanded(true)}
                    className="w-full flex items-center gap-2 px-4 py-3 text-sm bg-panel border border-border rounded-lg text-left text-muted hover:text-text hover:border-accent/30 transition-colors group"
                  >
                    <ChevronRight size={14} className="shrink-0 text-muted group-hover:text-accent transition-colors" />
                    <span className="truncate">{specBrief}</span>
                  </button>
                ) : (
                  <div className="relative">
                    {(generatedSpec && !isGenerating) || (hasPending && createExpanded) ? (
                      <button
                        onClick={() => {
                          if (generatedSpec && !isGenerating) {
                            setBriefExpanded(false);
                          } else if (hasPending) {
                            setCreateExpanded(false);
                          }
                        }}
                        className="absolute top-2 right-2 z-10 p-1 text-muted hover:text-text rounded transition-colors"
                        title={generatedSpec ? 'Collapse brief' : 'Close'}
                      >
                        <ChevronDown size={14} />
                      </button>
                    ) : null}
                    <textarea
                      ref={briefRef}
                      rows={6}
                      value={specBrief}
                      onChange={(e) => setSpecBrief(e.target.value.slice(0, 4000))}
                      placeholder="What do you want to build?"
                      className="w-full px-4 py-4 text-sm bg-panel border border-border rounded-lg text-text placeholder:text-muted/50 outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors resize-none leading-relaxed"
                    />
                  </div>
                )}

                {/* Context health dots — hidden after generation */}
                {!generatedSpec && <>
                  {/* All-grey banner */}
                  {directionLayers && !directionLayers.l1.content && !directionLayers.l2.content && !directionLayers.l3.content && (
                    <div className="px-3 py-2 rounded-lg bg-surface-200 border border-border text-xs text-muted">
                      No direction configured yet — your specs will be better with context.{' '}
                      <button
                        onClick={() => onNavigate?.('stack')}
                        className="text-accent hover:text-accent-hover transition-colors"
                      >
                        Set up now
                      </button>
                    </div>
                  )}

                  <div className="flex items-center justify-center gap-6 relative">
                    {CONTEXT_DOTS.map(dot => {
                      const layerData = directionLayers?.[dot.key];
                      const populated = !!layerData?.content;
                      return (
                        <div key={dot.key} className="relative">
                          <button
                            onClick={() => handleContextDotClick(dot.key)}
                            className="flex items-center gap-1.5 group"
                            title={populated ? `${dot.label} configured` : dot.emptyHeading}
                          >
                            <span className={`w-1.5 h-1.5 rounded-full transition-colors ${populated ? 'bg-emerald-500' : 'bg-border group-hover:bg-muted/50'}`} />
                            <span className={`text-xs transition-colors ${populated ? 'text-muted' : 'text-muted/50 group-hover:text-muted'}`}>
                              {dot.label}
                            </span>
                          </button>

                          {/* Populated popover — preview of content */}
                          {contextPopover === dot.key && populated && (
                            <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 w-72 bg-bg border border-border rounded-lg shadow-lg z-50 p-3 space-y-2">
                              <p className="text-xs font-medium text-text">{dot.label}</p>
                              <p className="text-xs text-muted whitespace-pre-wrap break-words leading-relaxed">
                                {layerData!.content!.length > 200
                                  ? layerData!.content!.slice(0, 200) + '...'
                                  : layerData!.content}
                              </p>
                              <button
                                onClick={() => { setContextPopover(null); onNavigate?.('stack'); }}
                                className="text-[10px] text-accent hover:text-accent-hover transition-colors"
                              >
                                View full &rarr;
                              </button>
                            </div>
                          )}

                          {/* Empty popover — configure layer */}
                          {contextPopover === dot.key && !populated && (
                            <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 w-72 bg-bg border border-border rounded-lg shadow-lg z-50 p-3 space-y-2">
                              <p className="text-xs font-medium text-text">{dot.emptyHeading}</p>
                              <p className="text-[10px] text-muted leading-relaxed">{dot.emptyDesc}</p>
                              <button
                                onClick={() => handleAutoDetect(dot)}
                                disabled={autoDetecting === dot.key}
                                className="w-full px-2 py-1.5 text-[10px] font-medium rounded border border-border bg-panel text-text hover:border-accent/30 hover:bg-accent/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
                              >
                                {autoDetecting === dot.key ? (
                                  <>
                                    <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
                                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                    </svg>
                                    Scanning...
                                  </>
                                ) : 'Auto-detect'}
                              </button>
                              <textarea
                                rows={3}
                                value={quickDirectionText}
                                onChange={(e) => setQuickDirectionText(e.target.value)}
                                placeholder={`Add ${dot.label.toLowerCase()}...`}
                                className="w-full px-2 py-1.5 text-xs bg-panel border border-border rounded text-text placeholder:text-muted/50 outline-none focus:border-accent transition-colors resize-none"
                                autoFocus
                              />
                              <div className="flex items-center justify-between">
                                <button
                                  onClick={() => { setContextPopover(null); onNavigate?.('stack'); }}
                                  className="text-[10px] text-accent hover:text-accent-hover transition-colors"
                                >
                                  Set up in Direction
                                </button>
                                <div className="flex gap-1.5">
                                  <button
                                    onClick={() => setContextPopover(null)}
                                    className="px-2 py-1 text-[10px] text-muted hover:text-text rounded transition-colors"
                                  >
                                    Cancel
                                  </button>
                                  <button
                                    onClick={() => handleQuickDirectionSave(dot.layer)}
                                    disabled={!quickDirectionText.trim()}
                                    className={`px-2 py-1 text-[10px] rounded transition-colors ${quickDirectionText.trim() ? 'bg-accent text-white hover:bg-accent-hover' : 'bg-accent/30 text-white/40 cursor-not-allowed'}`}
                                  >
                                    Save
                                  </button>
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {contextPopover && (
                    <div className="fixed inset-0 z-40" onClick={() => setContextPopover(null)} />
                  )}
                </>}

                {/* Workspace execution agent indicator */}
                {!generatedSpec && (
                  <div className="flex items-center justify-center gap-1.5 text-xs text-muted/60">
                    <span className={`w-1.5 h-1.5 rounded-full ${
                      wsAgentType === 'claude' ? 'bg-purple-400/60' :
                      wsAgentType === 'codex' ? 'bg-green-400/60' :
                      'bg-accent/60'
                    }`} />
                    Running with{' '}
                    <span className="font-medium text-muted">
                      {wsAgentType === 'claude' ? 'Claude' : wsAgentType === 'codex' ? 'Codex' : 'OpenCode'}
                      {wsAgentType === 'opencode' && wsModelDisplayName ? ` · ${wsModelDisplayName}` : ''}
                    </span>
                    {wsAgentType !== 'opencode' && (
                      <span className="text-muted/40">(subscription)</span>
                    )}
                    {overrideAgent && (
                      <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
                        Override
                      </span>
                    )}
                  </div>
                )}

                {/* Generate Spec + Quick Run buttons — hidden after generation */}
                {(!generatedSpec || isGenerating) && (
                <div className="space-y-2">
                  {isGenerating || (generateError && !generatedSpec) ? (
                    <SpecForgeProgress
                      isActive={isGenerating}
                      onCancel={handleCancel}
                      error={generateError}
                      apiDone={apiDone}
                      multiPass={false}
                      specSlug={effectiveSlug}
                    />
                  ) : !generatedSpec ? (
                    <>
                      <button
                        onClick={handleGenerate}
                        disabled={!canGenerate || isGenerating}
                        className={`w-full py-2.5 rounded-lg text-sm font-medium transition-colors ${canGenerate && !isGenerating
                            ? 'bg-accent text-white hover:bg-accent-hover cursor-pointer'
                            : 'bg-accent/30 text-white/40 cursor-not-allowed'
                          }`}
                      >
                        Generate Spec
                      </button>
                      {canQuickRun && (
                        <button
                          onClick={handleQuickRun}
                          disabled={isQuickRunning || isGenerating}
                          className={`w-full py-2 rounded-lg text-sm font-medium transition-colors border ${isQuickRunning || isGenerating
                              ? 'bg-panel/50 border-border/50 text-muted/40 cursor-not-allowed'
                              : 'bg-panel border-border text-text hover:bg-accent/10 hover:border-accent/30 cursor-pointer'
                            }`}
                        >
                          {isQuickRunning ? (
                            <span className="flex items-center justify-center gap-2">
                              <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                              </svg>
                              Generating & running...
                            </span>
                          ) : (
                            'Quick Run'
                          )}
                        </button>
                      )}
                    </>
                  ) : null}
                </div>
                )}

                {/* Advanced Options — below buttons, collapsed by default, hidden after generation */}
                {!generatedSpec && <section>
                  <button
                    onClick={() => setAdvancedOpen(o => !o)}
                    aria-expanded={advancedOpen}
                    aria-label="Toggle advanced options"
                    className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted hover:text-text transition-colors w-full"
                  >
                    <svg
                      className={`w-3 h-3 transition-transform duration-200 ${advancedOpen ? 'rotate-90' : ''}`}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                    Advanced Options
                    {customizedCount > 0 ? (
                      <span className="ml-1 px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-accent/15 text-accent normal-case tracking-normal">
                        {customizedCount} customized
                      </span>
                    ) : (
                      <span className="ml-1 text-[10px] font-normal text-muted/50 normal-case tracking-normal">
                        Using defaults
                      </span>
                    )}
                  </button>
                  <div
                    className="overflow-hidden transition-[max-height] duration-300 ease-in-out"
                    style={{ maxHeight: advancedOpen ? advancedHeight || 2000 : 0 }}
                  >
                    <div ref={advancedInnerRef} className="mt-4 space-y-4">
                      <Field label="Spec Name (optional)" error={specNameError}>
                        <input
                          type="text"
                          value={specName}
                          onChange={(e) => setSpecName(e.target.value)}
                          onBlur={() => validateSpecName(specName)}
                          placeholder={effectiveSlug || 'auto-generated from brief'}
                          className="w-full px-3 py-2 text-sm bg-panel border border-border rounded text-text placeholder:text-muted/50 outline-none focus:border-accent transition-colors"
                        />
                        <p className="text-xs text-muted/60 mt-1">
                          Leave blank to auto-generate from your brief
                        </p>
                      </Field>

                      {/* Execution Engine Override */}
                      <div className="space-y-2">
                        <label className="flex items-center gap-2 cursor-pointer group">
                          <button
                            type="button"
                            role="switch"
                            aria-checked={overrideAgent}
                            onClick={() => setOverrideAgent(o => !o)}
                            className={`relative w-8 h-[18px] rounded-full transition-colors ${
                              overrideAgent ? 'bg-accent' : 'bg-border group-hover:bg-muted/40'
                            }`}
                          >
                            <span className={`absolute top-0.5 left-0.5 w-3.5 h-3.5 rounded-full bg-white transition-transform ${
                              overrideAgent ? 'translate-x-[14px]' : ''
                            }`} />
                          </button>
                          <span className="text-xs font-medium text-text">Override execution engine</span>
                        </label>
                        {!overrideAgent && (
                          <p className="text-[11px] text-muted/50 ml-10">
                            Using workspace default: {wsAgentType === 'claude' ? 'Claude (subscription)' :
                              wsAgentType === 'codex' ? 'Codex (subscription)' :
                              `OpenCode${wsModelDisplayName ? ` · ${wsModelDisplayName}` : ''}`}
                          </p>
                        )}
                        {overrideAgent && (
                          <AgentPicker
                            agentType={overrideAgentType}
                            agentModel={overrideAgentModel}
                            onAgentTypeChange={setOverrideAgentType}
                            onModelChange={setOverrideAgentModel}
                            models={opencodeModels}
                            defaultModelId={wsAgentModel}
                            compact
                            claudeInstalled={wsAgentBinaries.claudeInstalled}
                            opencodeInstalled={wsAgentBinaries.opencodeInstalled}
                            codexInstalled={wsAgentBinaries.codexInstalled}
                          />
                        )}
                      </div>

                      {/* Spec Generation Model */}
                      <Field label={
                        <span className="flex items-center gap-2">
                          Spec Generation Model
                          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded ${activeProvider === 'claude-cli'
                              ? 'bg-green-500/10 text-green-400 border border-green-500/20'
                              : 'bg-accent/10 text-accent border border-accent/20'
                            }`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${activeProvider === 'claude-cli' ? 'bg-green-500' : 'bg-accent'
                              }`} />
                            {activeProvider === 'claude-cli' ? 'Subscription' :
                              activeProvider === 'anthropic' ? 'Anthropic API' :
                                activeProvider === 'openai-compat' ? 'OpenAI Compat' :
                                  activeProvider === 'openrouter' ? 'OpenRouter' :
                                    activeProvider}
                          </span>
                        </span>
                      }>
                        <ModelSearchSelect
                          models={availableModels}
                          value={selectedModel || defaultModelId || ''}
                          defaultModelId={defaultModelId}
                          onChange={setSelectedModel}
                        />
                      </Field>

                      <Field label="Story Count" className="max-w-xs">
                        <div className="flex gap-2">
                          <select
                            value={showCustomInput ? 'custom' : String(storyCount)}
                            onChange={(e) => handleStoryCountSelect(e.target.value)}
                            className="flex-1 px-3 py-2 text-sm bg-panel border border-border rounded text-text outline-none focus:border-accent transition-colors appearance-none cursor-pointer bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%2212%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%23888%22%20stroke-width%3D%222%22%3E%3Cpath%20d%3D%22M6%209l6%206%206-6%22%2F%3E%3C%2Fsvg%3E')] bg-no-repeat bg-[right_0.5rem_center]"
                            aria-label="Select story count"
                          >
                            <option value="0">Auto</option>
                            {STORY_COUNT_PRESETS.map((n) => (
                              <option key={n} value={n}>{n} stories</option>
                            ))}
                            <option value="custom">Custom</option>
                          </select>
                          {showCustomInput && (
                            <input
                              type="text"
                              inputMode="numeric"
                              value={storyCountRaw}
                              onChange={(e) => handleCustomCountChange(e.target.value)}
                              onBlur={handleCustomCountBlur}
                              className="w-16 px-2 py-2 text-sm bg-panel border border-border rounded text-text outline-none focus:border-accent transition-colors text-center"
                              aria-label="Custom story count"
                              autoFocus
                            />
                          )}
                        </div>
                      </Field>

                      <Field label="Target Workspace">
                        <span className="inline-flex items-center px-2.5 py-1 rounded text-xs font-medium bg-accent/10 text-accent border border-accent/20">
                          {workspace?.name ?? workspaceId}
                        </span>
                      </Field>
                    </div>
                  </div>
                </section>}

                {/* Inline spec preview after generation */}
                {generatedSpec && !isGenerating && (
                  <SpecForgePreview
                    spec={generatedSpec}
                    workspaceId={workspaceId}
                    onRegenerate={handleGenerate}
                    onEditBrief={() => {
                      setGeneratedSpec(null);
                      setGenerateError(null);
                      setApiDone(false);
                      setBriefExpanded(false);
                      setTimeout(() => briefRef.current?.focus(), 50);
                    }}
                    isRegenerating={isGenerating}
                    onNavigate={onNavigate}
                    onNavigateToRun={onNavigateToRun}
                    onReset={() => {
                      setGeneratedSpec(null);
                      setGenerateError(null);
                      setApiDone(false);
                      setSpecBrief('');
                      setBriefExpanded(false);
                      try { localStorage.removeItem('rorca:forge:brief'); } catch { /* ignore */ }
                      setTimeout(() => briefRef.current?.focus(), 50);
                      fetchPendingSpecs();
                    }}
                  />
                )}
              </>
            )}

            {/* ─── Pending Specs Section ──────────────────────────────── */}
            {hasPending && !generatedSpec && !isGenerating && (
              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
                    Pending Review
                    <span className="ml-2 text-[10px] font-normal text-muted/70 normal-case tracking-normal">
                      {filteredPending.length} of {pendingSpecs.length}
                    </span>
                  </h3>
                  <div className="flex gap-1">
                    {REVIEW_FILTERS.map((f) => {
                      const count = f.id === 'all'
                        ? pendingSpecs.length
                        : pendingSpecs.filter(s => (s.reviewStatus ?? 'draft') === f.id).length;
                      return (
                        <button
                          key={f.id}
                          onClick={() => setReviewFilter(f.id)}
                          className={`px-2 py-1 text-[10px] font-medium rounded transition-colors ${reviewFilter === f.id
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

                {filteredPending.length === 0 ? (
                  <div className="text-center py-6 text-muted text-xs">
                    No specs match this filter
                  </div>
                ) : (
                  <div className="space-y-2">
                    {filteredPending.map((spec) => (
                      <button
                        key={spec.id}
                        onClick={() => {
                          if (hasUnsavedEdits && spec.id !== selectedSpecId) {
                            if (!window.confirm('You have unsaved story edits. Discard them?')) return;
                            setHasUnsavedEdits(false);
                          }
                          setSelectedSpecId(spec.id);
                        }}
                        className="w-full text-left px-4 py-3 bg-panel border border-border rounded-lg hover:border-accent/30 transition-colors group"
                      >
                        <div className="flex items-center justify-between mb-1">
                          <div className="flex items-center gap-2">
                            <span className="inline-block w-2 h-2 rounded-full bg-warning shrink-0" />
                            <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-accent/15 text-accent">
                              {spec.storyCount} {spec.storyCount === 1 ? 'story' : 'stories'}
                            </span>
                            {(() => {
                              const rs = (spec.reviewStatus ?? 'draft') as ReviewStatus;
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
                            className="shrink-0 text-muted group-hover:text-accent transition-colors"
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
                )}
              </section>
            )}

            {/* Empty pending state when loading */}
            {pendingLoading && !hasPending && (
              <div className="text-center py-4 text-muted text-xs">Loading pending specs...</div>
            )}
          </div>
        </div>
      )}

      {showTemplatePicker && (
        <TemplatePickerModal
          onClose={() => setShowTemplatePicker(false)}
          onSelect={(tpl) => {
            setSpecBrief(tpl.brief);
            setStoryCount(tpl.storyCount);
            setShowTemplatePicker(false);
            setTimeout(() => briefRef.current?.focus(), 50);
          }}
        />
      )}
    </div>
  );
}

/* ─── Helpers ──────────────────────────────────────────────────────── */

function Field({
  label,
  error,
  className,
  children,
}: {
  label: React.ReactNode;
  error?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <label className="block text-xs font-medium text-muted mb-1.5">{label}</label>
      {children}
      {error && <p className="mt-1 text-xs text-error">{error}</p>}
    </div>
  );
}
