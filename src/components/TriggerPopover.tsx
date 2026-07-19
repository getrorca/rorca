/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Play, GitBranch, Loader2, ListPlus, AlertTriangle, Cpu, Layers, HeartPulse, FileText, ChevronDown, ChevronRight, ShieldAlert, Info, DollarSign, Server } from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';
import { preflightCheck, type CapabilityWarning } from '../api/pipeline';
import type { PanelId } from './Sidebar';
import ThinkingControls, { type EffortLevel } from './ThinkingControls';
import type { ReasoningConfig } from './SpecModelControlBar';

// ── Client-side reasoning cost multiplier lookup ──────────────────────────────
// Mirrors backend reasoning-detector.ts logic without importing it.
function getReasoningCostMultipliers(modelId: string | null): Record<string, number> | undefined {
  if (!modelId) return undefined;
  const m = modelId.toLowerCase();
  // Claude 4.x
  if (/^claude-[a-z]+-4[-.]/.test(m)) {
    const isOpus = /opus/i.test(m);
    const mult: Record<string, number> = { low: 1.5, medium: 2.0, high: 3.0 };
    if (isOpus) mult['max'] = 4.0;
    return mult;
  }
  // OpenAI o-series
  const bare = m.includes('/') ? m.split('/').pop()! : m;
  if (/^o\d/i.test(bare)) return { low: 1.0, medium: 1.5, high: 2.5 };
  // Native CoT keywords
  if (/think|r1\b|qwq|reasoning/.test(m)) return { default: 1.5 };
  return undefined;
}

interface HealthBadge {
  score: number;
  scannedAt: string;
}

interface AgentConfigSummary {
  agentType: 'claude' | 'opencode' | 'codex' | 'pi';
  agentModel: string | null;
  modelDisplayName: string | null;
  hasApiKey: boolean;
}


interface ExecutionEnvironmentAgentReadiness {
  agent: string;
  installed: boolean;
  credentialsReady: boolean;
  ready: boolean;
  version?: string;
}

interface ExecutionEnvironmentReadiness {
  id: string;
  label: string;
  kind: 'remote-rorca' | 'local-runner' | 'ci-runner';
  enabled: boolean;
  ready: boolean;
  reason?: string;
  networkMode: string;
  lastHeartbeatAt: string | null;
  agents: Record<string, ExecutionEnvironmentAgentReadiness>;
  supportedAgents: string[];
  secretProfileId: string | null;
}

interface WaveProductionStatus {
  status: 'sequential-default' | 'experimental-nonproduction' | 'production-disabled' | 'receipt-missing' | 'receipt-stale' | 'canary-enabled' | 'halted' | 'draining' | 'enabled';
  effective: { orchestrationMode: 'sequential' | 'wave-parallel'; parallelism: number };
  reason: string;
  receipt: { id: string; reportHash: string; sourceRevision: string } | null;
  rollout: { cohort: string; maxParallelism: number };
  productionEnableAvailable: boolean;
}

interface OrchestrationPreview {
  mode: 'sequential' | 'wave-parallel';
  parallelism: number;
  reason: string;
  waveCount: number;
  maxWaveSize: number;
  totalStories: number;
  waves: { index: number; storyIds: string[] }[];
}

interface ContextFileEntry {
  path: string;
  tokens: number;
  matchedScope?: string;
  matchedTag?: string;
}

interface ContextStoryPreview {
  storyId: string;
  title: string;
  predictedPaths: string[];
  globalFiles: ContextFileEntry[];
  scopedFiles: ContextFileEntry[];
  taggedFiles: ContextFileEntry[];
  globalTokens: number;
  scopedTokens: number;
  taggedTokens: number;
  totalTokens: number;
  exceeded: boolean;
  droppedFiles: string[];
}

interface ContextPreviewData {
  tokenBudget: number;
  anyExceeded: boolean;
  globalFileCount: number;
  scopeCount: number;
  tagCount: number;
  stories: ContextStoryPreview[];
}

interface DriftViolation {
  file: string;
  line: number;
  convention: string;
  description: string;
  severity: 'warning' | 'error';
}

interface DriftReportData {
  id: number;
  workspaceId: string;
  triggerType: string;
  report: {
    violations: DriftViolation[];
    score: number;
    conventionsChecked: number;
    filesSampled: number;
    checkedAt: string;
  };
}

interface WorkspaceConfig {
  execution?: {
    driftCheck?: boolean;
  };
}

interface ModelCapability {
  supportsReasoning: boolean;
  reasoningType: 'anthropic-thinking' | 'effort-levels' | 'native-cot' | 'none';
  effortLevels: string[];
  defaultEffort: string | null;
  costMultiplier?: Record<string, number>;
}

interface DryRunCostEstimate {
  model: string;
  totalEstimatedCostUsd: number;
  reasoningCostMultiplier?: number;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function TokenBar({ global, scoped, tagged, budget }: { global: number; scoped: number; tagged: number; budget: number }) {
  const total = global + scoped + tagged;
  const max = Math.max(total, budget);
  const gPct = max > 0 ? (global / max) * 100 : 0;
  const sPct = max > 0 ? (scoped / max) * 100 : 0;
  const tPct = max > 0 ? (tagged / max) * 100 : 0;
  const budgetPct = max > 0 ? (budget / max) * 100 : 100;
  const exceeded = total > budget;

  return (
    <div className="space-y-1">
      <div className="relative h-2 rounded-full bg-bg overflow-hidden">
        <div className="absolute inset-y-0 left-0 bg-blue-500 rounded-l-full" style={{ width: `${gPct}%` }} />
        <div className="absolute inset-y-0 bg-emerald-500" style={{ left: `${gPct}%`, width: `${sPct}%` }} />
        <div className="absolute inset-y-0 bg-purple-500 rounded-r-full" style={{ left: `${gPct + sPct}%`, width: `${tPct}%` }} />
        {/* Budget marker */}
        <div
          className={`absolute inset-y-0 w-0.5 ${exceeded ? 'bg-red-500' : 'bg-muted/50'}`}
          style={{ left: `${Math.min(budgetPct, 100)}%` }}
        />
      </div>
      <div className="flex items-center gap-3 text-[9px] text-muted">
        <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-blue-500 inline-block" /> Global {formatTokenCount(global)}</span>
        <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" /> Scoped {formatTokenCount(scoped)}</span>
        <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-purple-500 inline-block" /> Tagged {formatTokenCount(tagged)}</span>
        <span className={`ml-auto tabular-nums ${exceeded ? 'text-red-400 font-medium' : ''}`}>
          {formatTokenCount(total)} / {formatTokenCount(budget)}
        </span>
      </div>
    </div>
  );
}

export interface TriggerOptions {
  forceSequential?: boolean;
  orchestrationMode?: 'sequential' | 'wave-parallel';
  parallelism?: number;
  qualificationReceiptId?: string;
  rolloutCohort?: string;
  autoMerge?: boolean;
  mergeStrategy?: 'direct' | 'pr' | 'draft-pr' | 'branch-only';
  includeGraph?: boolean;
  terminal_mode?: 'ansi-html' | 'pty' | 'native-pty';
  effortLevel?: EffortLevel;
  thinkingEnabled?: boolean;
  thinkingBudget?: number;
  /** Override reasoning config for this run without mutating spec JSON */
  reasoningOverride?: ReasoningConfig;
  executionEnvironment?: string;
}

interface TriggerPopoverProps {
  /** Whether a trigger is currently in progress */
  loading?: boolean;
  /** Called when user clicks Run Now */
  onTrigger: (autoWorktree: boolean, options?: TriggerOptions) => void;
  /** Called when user clicks Add to Queue */
  onAddToQueue?: (autoWorktree: boolean, options?: TriggerOptions) => void;
  /** Whether Add to Queue action is loading */
  queueLoading?: boolean;
  /** Called when popover is dismissed */
  onClose: () => void;
  /** Navigate to another panel (e.g. settings) */
  onNavigate?: (panel: PanelId) => void;
  /** Spec path for capability preflight check + orchestration preview */
  specPath?: string;
  /** Workspace ID for capability preflight check + orchestration preview */
  workspaceId?: string;
  /** Pre-populate effort level from spec JSON */
  initialEffortLevel?: EffortLevel;
  /** Pre-populate thinking enabled from spec JSON */
  initialThinkingEnabled?: boolean;
  /** Pre-populate thinking budget from spec JSON */
  initialThinkingBudget?: number;
  /** Reasoning config from spec generation — shown as badge and editable before run */
  initialReasoning?: ReasoningConfig;
  /** Model ID from spec JSON — used to fetch reasoning capability */
  specModel?: string | null;
}

export default function TriggerPopover({
  loading = false,
  onTrigger,
  onAddToQueue,
  queueLoading = false,
  onClose,
  onNavigate,
  specPath,
  workspaceId,
  initialEffortLevel,
  initialThinkingEnabled,
  initialThinkingBudget,
  initialReasoning,
  specModel,
}: TriggerPopoverProps) {
  const [autoWorktree, setAutoWorktree] = useState(false);
  const [autoMerge, setAutoMerge] = useState(true);
  const [mergeStrategy, setMergeStrategy] = useState<'direct' | 'pr' | 'draft-pr' | 'branch-only'>('direct');
  const [agentConfig, setAgentConfig] = useState<AgentConfigSummary | null>(null);
  const [capWarnings, setCapWarnings] = useState<CapabilityWarning[]>([]);
  const [orchestration, setOrchestration] = useState<OrchestrationPreview | null>(null);
  const [waveStatus, setWaveStatus] = useState<WaveProductionStatus | null>(null);
  const [healthBadge, setHealthBadge] = useState<HealthBadge | null>(null);
  const [contextPreview, setContextPreview] = useState<ContextPreviewData | null>(null);
  const [contextExpanded, setContextExpanded] = useState(false);
  const [expandedStory, setExpandedStory] = useState<string | null>(null);
  const [driftData, setDriftData] = useState<DriftReportData | null>(null);
  const [driftCheckEnabled, setDriftCheckEnabled] = useState(false);
  const [forceSequential, setForceSequential] = useState(true);
  const [includeGraph, setIncludeGraph] = useState(false);
  const [terminalMode, setTerminalMode] = useState<'ansi-html' | 'pty' | 'native-pty'>('pty');
  const [effortLevel, setEffortLevel] = useState<EffortLevel>(initialEffortLevel ?? 'medium');
  const [thinkingEnabled, setThinkingEnabled] = useState(initialThinkingEnabled ?? false);
  const [thinkingBudget, setThinkingBudget] = useState(initialThinkingBudget ?? 5000);
  // Reasoning override — mirrors spec.reasoning but editable per-run without saving to spec
  const [reasoningEnabled, setReasoningEnabled] = useState(initialReasoning?.enabled ?? false);
  const [reasoningEffort, setReasoningEffort] = useState(initialReasoning?.effort ?? 'medium');
  const [modelCapability, setModelCapability] = useState<ModelCapability | null>(null);
  const [reasoningSectionExpanded, setReasoningSectionExpanded] = useState(false);
  const [dryRunEstimate, setDryRunEstimate] = useState<DryRunCostEstimate | null>(null);
  const [dryRunLoading, setDryRunLoading] = useState(false);
  const [executionEnvironments, setExecutionEnvironments] = useState<ExecutionEnvironmentReadiness[]>([]);
  const [executionEnvironment, setExecutionEnvironment] = useState('remote-rorca');
  const ref = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const [portalStyle, setPortalStyle] = useState<React.CSSProperties>({ visibility: 'hidden' });

  // Position the portal above the anchor element, within the viewport
  useLayoutEffect(() => {
    if (!anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    const maxH = Math.min(rect.top - 12, window.innerHeight * 0.85);
    setPortalStyle({
      position: 'fixed',
      left: rect.left,
      right: window.innerWidth - rect.right,
      bottom: window.innerHeight - rect.top + 8,
      maxHeight: `${maxH}px`,
      visibility: 'visible',
    });
  }, []);

  // Fetch persisted pipeline-config on mount (includeGraph preference)
  useEffect(() => {
    if (!workspaceId) return;
    apiFetch<{ config: { includeGraph?: boolean; mergeStrategy?: string } }>(`/api/workspaces/${workspaceId}/pipeline-config`)
      .then((data) => {
        setIncludeGraph(data.config.includeGraph ?? false);
        if (data.config.mergeStrategy) {
          setMergeStrategy(data.config.mergeStrategy as any);
          setAutoMerge(data.config.mergeStrategy === 'direct');
        }
      })
      .catch(() => {});
  }, [workspaceId]);

  // Fetch workspace health badge on mount
  useEffect(() => {
    if (!workspaceId) return;
    apiFetch<HealthBadge>(`/api/workspaces/${workspaceId}/health`)
      .then(setHealthBadge)
      .catch(() => {});
  }, [workspaceId]);

  // Fetch execution environments on mount
  useEffect(() => {
    apiFetch<{ environments: ExecutionEnvironmentReadiness[] }>('/api/execution-environments')
      .then((data) => {
        const environments = data.environments ?? [];
        setExecutionEnvironments(environments);
        if (!environments.some((env) => env.id === executionEnvironment)) {
          setExecutionEnvironment(environments.find((env) => env.ready)?.id ?? environments[0]?.id ?? 'remote-rorca');
        }
      })
      .catch(() => {});
  }, [executionEnvironment]);

  // Fetch agent config on mount
  useEffect(() => {
    apiFetch<AgentConfigSummary>('/api/config')
      .then(setAgentConfig)
      .catch(() => {});
  }, []);

  // Fetch capability preflight on mount (if spec info provided)
  useEffect(() => {
    if (!specPath || !workspaceId) return;
    preflightCheck({ specPath, workspaceId })
      .then((report) => {
        setCapWarnings(report.stories);
      })
      .catch(() => {});
  }, [specPath, workspaceId]);

  // Fetch orchestration preview on mount
  useEffect(() => {
    if (!specPath || !workspaceId) return;
    apiFetch<OrchestrationPreview>('/api/pipeline/orchestration-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ specPath, workspaceId }),
    })
      .then(setOrchestration)
      .catch(() => {});
  }, [specPath, workspaceId]);

  // Fetch governed wave status. The status/receipt/cohort are evidence; the
  // environment variable is intentionally never returned or displayed.
  useEffect(() => {
    if (!workspaceId) return;
    apiFetch<WaveProductionStatus>(`/api/admin/wave-qualification/status?workspaceId=${encodeURIComponent(workspaceId)}`)
      .then(setWaveStatus)
      .catch(() => setWaveStatus(null));
  }, [workspaceId]);

  // Fetch drift report + config on mount
  useEffect(() => {
    if (!workspaceId) return;
    // Fetch latest drift report
    apiFetch<DriftReportData | { report: null }>(`/api/conventions/drift/${workspaceId}`)
      .then((res) => { if ('report' in res && res.report === null) return; setDriftData(res as DriftReportData); })
      .catch(() => {});
    // Fetch workspace config to check if driftCheck is enabled
    apiFetch<{ config: WorkspaceConfig }>(`/api/workspaces/${workspaceId}/rorca-config`)
      .then((res) => {
        setDriftCheckEnabled(res.config?.execution?.driftCheck === true);
      })
      .catch(() => {});
  }, [workspaceId]);

  // Fetch model reasoning capability on mount.
  // Prefer the currently-selected agent model (which the user can switch in this
  // popover), falling back to the spec's stored model. This keeps the Effort
  // segmented control in sync with whichever model will actually run.
  useEffect(() => {
    const targetModel = agentConfig?.agentModel ?? specModel;
    if (!targetModel) return;
    apiFetch<ModelCapability>(`/api/config/model-capability?modelId=${encodeURIComponent(targetModel)}`)
      .then((cap) => {
        setModelCapability(cap);
        // If the model supports reasoning and spec has reasoning config, pre-expand the section
        if (cap.supportsReasoning) {
          setReasoningSectionExpanded(initialReasoning?.enabled ?? false);
          // If no initial reasoning, use model default effort
          if (!initialReasoning?.enabled && cap.defaultEffort) {
            setReasoningEffort(cap.defaultEffort);
          }
        }
      })
      .catch(() => {});
  }, [agentConfig?.agentModel, specModel, initialReasoning?.enabled, initialReasoning?.effort]);

  // Fetch context preview on mount
  useEffect(() => {
    if (!specPath || !workspaceId) return;
    apiFetch<ContextPreviewData>('/api/pipeline/context-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ specPath, workspaceId }),
    })
      .then(setContextPreview)
      .catch(() => {});
  }, [specPath, workspaceId]);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  // Derive engine display string and whether trigger should be disabled
  const isOpenCode = agentConfig?.agentType === 'opencode';
  const noModelConfigured = isOpenCode && !agentConfig?.agentModel;
  const noApiKey = isOpenCode && !noModelConfigured && !agentConfig?.hasApiKey;
  const selectedExecutionEnvironment = executionEnvironments.find((env) => env.id === executionEnvironment) ?? null;
  const selectedAgentReadiness = agentConfig?.agentType && selectedExecutionEnvironment?.agents ? selectedExecutionEnvironment.agents[agentConfig.agentType] : null;
  const executionEnvironmentBlocked = selectedExecutionEnvironment ? (!selectedExecutionEnvironment.ready || (selectedAgentReadiness ? !selectedAgentReadiness.ready : false)) : false;
  const triggerDisabled = loading || queueLoading || noModelConfigured || noApiKey || executionEnvironmentBlocked;

  const isCodex = agentConfig?.agentType === 'codex';
  const isOpenRouterModel = isOpenCode && agentConfig?.agentModel?.startsWith('openrouter/');

  const engineLabel = agentConfig
    ? isCodex
      ? 'Codex CLI (ChatGPT)'
      : isOpenCode
        ? isOpenRouterModel && agentConfig.modelDisplayName
          ? `OpenRouter — ${agentConfig.modelDisplayName}`
          : agentConfig.modelDisplayName
            ? `OpenCode — ${agentConfig.modelDisplayName}`
            : 'OpenCode'
        : 'Claude (Pro/Max)'
    : null;

  // Drift warning: show if driftCheck is enabled AND there are error-severity violations
  const driftErrors = driftData?.report.violations.filter(v => v.severity === 'error') ?? [];
  const showDriftWarning = driftCheckEnabled && driftErrors.length > 0;

  const isWaveParallel = orchestration?.mode === 'wave-parallel';
  const waveOptInAvailable = waveStatus != null && ['experimental-nonproduction', 'canary-enabled', 'enabled'].includes(waveStatus.status);
  const waveRequested = isWaveParallel && waveOptInAvailable && !forceSequential;

  // Reasoning cost multipliers for the current model (used in ThinkingControls and dry-run preview)
  const reasoningCostMultipliers = getReasoningCostMultipliers(agentConfig?.agentModel ?? null);

  const handleDryRun = async () => {
    if (!specPath || !workspaceId) return;
    setDryRunLoading(true);
    try {
      const isClaude = agentConfig?.agentType === 'claude';
      const m = agentConfig?.agentModel?.toLowerCase() ?? '';
      const thinkingApplies = isClaude && (m.includes('opus') || m.includes('sonnet'));
      const res = await apiFetch<{ dryRun: true; estimate: DryRunCostEstimate }>(
        '/api/pipeline/trigger',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            specPath,
            workspaceId,
            dryRun: true,
            thinkingEnabled: thinkingApplies ? thinkingEnabled : undefined,
            reasoningEffort: thinkingApplies ? effortLevel : undefined,
            executionEnvironment,
          }),
        }
      );
      if ('estimate' in res) setDryRunEstimate(res.estimate);
    } catch {
      // Ignore errors silently — the UI shows nothing if estimate is null
    } finally {
      setDryRunLoading(false);
    }
  };

  return (
    <>
      {/* Zero-height anchor in the normal flow — used to measure position */}
      <div ref={anchorRef} className="absolute bottom-full left-0 right-0" />
      {createPortal(
        <div
          ref={ref}
          style={portalStyle}
          className="overflow-y-auto rounded-lg border border-border bg-panel shadow-lg z-[500] p-3 space-y-3"
        >
      {/* CIE-012: Health badge — warns if score < 50% */}
      {healthBadge && (
        <div className="flex items-center gap-2">
          <HeartPulse size={13} className={
            healthBadge.score >= 80 ? 'text-emerald-500 shrink-0' :
            healthBadge.score >= 50 ? 'text-yellow-500 shrink-0' :
            'text-red-500 shrink-0'
          } />
          <span className={`text-xs font-medium tabular-nums ${
            healthBadge.score >= 80 ? 'text-emerald-500' :
            healthBadge.score >= 50 ? 'text-yellow-500' :
            'text-red-500'
          }`}>
            Health {healthBadge.score}%
          </span>
          {healthBadge.score < 50 && (
            <span className="flex items-center gap-1 text-[10px] text-red-400">
              <AlertTriangle size={10} />
              Low context — add CLAUDE.md or run scaffolding
            </span>
          )}
        </div>
      )}

      {/* CA-017: Convention drift warning banner */}
      {showDriftWarning && (
        <div className="flex items-start gap-2 p-2.5 rounded-md bg-amber-500/10 border border-amber-500/30">
          <ShieldAlert size={14} className="text-amber-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-xs font-medium text-amber-500">
              Convention drift detected — {driftErrors.length} error{driftErrors.length !== 1 ? 's' : ''}
            </p>
            <p className="text-[10px] text-amber-500/80 mt-0.5">
              Drift check is enabled. {driftErrors.length} violation{driftErrors.length !== 1 ? 's' : ''} with error severity found. You can still run, but consider fixing violations first.
            </p>
          </div>
        </div>
      )}

      {/* Engine info row */}
      {agentConfig && (
        <div>
          <label className="block text-xs text-muted mb-1.5">Engine</label>
          <div className="flex items-center gap-2">
            <Cpu size={13} className="text-muted shrink-0" />
            {onNavigate ? (
              <button
                onClick={() => { onClose(); onNavigate('settings'); }}
                className="text-xs font-medium text-accent hover:underline truncate"
                title="Go to Settings > Execution Engine"
              >
                {engineLabel}
              </button>
            ) : (
              <span className="text-xs font-medium text-[var(--text)] truncate">{engineLabel}</span>
            )}
          </div>

          {/* Warning: no model configured */}
          {noModelConfigured && (
            <div className="mt-1.5 flex items-start gap-1.5 text-amber-500">
              <AlertTriangle size={12} className="shrink-0 mt-0.5" />
              <span className="text-[10px] leading-tight">
                No model configured —{' '}
                {onNavigate ? (
                  <button
                    onClick={() => { onClose(); onNavigate('settings'); }}
                    className="underline hover:text-amber-400"
                  >
                    go to Settings
                  </button>
                ) : (
                  'go to Settings'
                )}
              </span>
            </div>
          )}

          {/* Warning: no API key */}
          {noApiKey && (
            <div className="mt-1.5 flex items-start gap-1.5 text-amber-500">
              <AlertTriangle size={12} className="shrink-0 mt-0.5" />
              <span className="text-[10px] leading-tight">
                No API key for this provider —{' '}
                {onNavigate ? (
                  <button
                    onClick={() => { onClose(); onNavigate('settings'); }}
                    className="underline hover:text-amber-400"
                  >
                    go to Settings
                  </button>
                ) : (
                  'go to Settings'
                )}
              </span>
            </div>
          )}
        </div>
      )}


      {/* Execution environment selector */}
      <div>
        <label htmlFor="trigger-execution-environment" className="block text-xs text-muted mb-1.5">Execution environment</label>
        <div className="flex items-center gap-2">
          <Server size={13} className="text-muted shrink-0" />
          <select
            id="trigger-execution-environment"
            value={executionEnvironment}
            onChange={(event) => { setExecutionEnvironment(event.target.value); setDryRunEstimate(null); }}
            className="min-w-0 flex-1 px-2.5 py-1.5 text-xs bg-[var(--bg-secondary,var(--bg))] border border-border rounded-md focus:border-accent outline-none text-[var(--text)]"
          >
            {executionEnvironments.length === 0 && <option value="remote-rorca">Remote Rorca worker</option>}
            {executionEnvironments.map((env) => (
              <option key={env.id} value={env.id}>
                {env.label} {env.ready ? '✓' : '— not ready'}
              </option>
            ))}
          </select>
        </div>
        {selectedExecutionEnvironment && (
          <p className={`mt-1 text-[10px] leading-tight ${executionEnvironmentBlocked ? 'text-amber-500' : 'text-muted'}`}>
            {selectedExecutionEnvironment.ready
              ? selectedAgentReadiness && !selectedAgentReadiness.ready
                ? `${agentConfig?.agentType} is not ready on ${selectedExecutionEnvironment.label}`
                : `${selectedExecutionEnvironment.kind} · ${selectedExecutionEnvironment.networkMode}`
              : selectedExecutionEnvironment.reason ?? 'execution environment is not ready'}
          </p>
        )}
      </div>

      {/* OC-031: Capability warnings */}
      {capWarnings.length > 0 && (
        <div>
          <label className="block text-xs text-muted mb-1">Capability warnings</label>
          <div className="space-y-1 max-h-24 overflow-y-auto">
            {capWarnings.map((w) => (
              <div key={w.storyId} className="flex items-start gap-1.5 text-amber-500">
                <AlertTriangle size={11} className="shrink-0 mt-0.5" />
                <span className="text-[10px] leading-tight">
                  {w.storyId} uses {w.missingTools.join(', ')} — not supported by {w.engine}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}


      {/* CIE-016: Context Preview — expandable section */}
      <div>
        <button
          onClick={() => setContextExpanded(!contextExpanded)}
          className="flex items-center gap-1.5 w-full text-left"
        >
          {contextExpanded
            ? <ChevronDown size={12} className="text-muted shrink-0" />
            : <ChevronRight size={12} className="text-muted shrink-0" />
          }
          <FileText size={13} className="text-muted shrink-0" />
          <span className="text-xs text-muted">Context Preview</span>
          {contextPreview ? (
            <span className="ml-auto flex items-center gap-1.5">
              <span className="text-[10px] tabular-nums text-muted">
                {contextPreview.stories.length} {contextPreview.stories.length === 1 ? 'story' : 'stories'}
              </span>
              {contextPreview.anyExceeded && (
                <AlertTriangle size={10} className="text-amber-500" />
              )}
            </span>
          ) : (
            <Loader2 size={10} className="ml-auto animate-spin text-muted" />
          )}
        </button>

        {contextExpanded && contextPreview && (
          <div className="mt-2 space-y-2">
            {/* Aggregate token bar across all stories (average) */}
            {(() => {
              const totalGlobal = contextPreview.stories.reduce((s, st) => s + st.globalTokens, 0);
              const totalScoped = contextPreview.stories.reduce((s, st) => s + st.scopedTokens, 0);
              const totalTagged = contextPreview.stories.reduce((s, st) => s + st.taggedTokens, 0);
              const storyCount = contextPreview.stories.length || 1;
              return (
                <div>
                  <div className="text-[10px] text-muted mb-1">Average per story</div>
                  <TokenBar
                    global={Math.round(totalGlobal / storyCount)}
                    scoped={Math.round(totalScoped / storyCount)}
                    tagged={Math.round(totalTagged / storyCount)}
                    budget={contextPreview.tokenBudget}
                  />
                </div>
              );
            })()}

            {/* Budget exceeded warning */}
            {contextPreview.anyExceeded && (() => {
              const anyRealDrops = contextPreview.stories.some(s => s.droppedFiles.length > 0);
              const onlyGlobalsOverBudget = !anyRealDrops;
              const isClaudeAgent = agentConfig?.agentType === 'claude';
              const exceededCount = contextPreview.stories.filter(s => s.exceeded).length;

              if (onlyGlobalsOverBudget && isClaudeAgent) {
                // Global files (CLAUDE.md) are large but nothing was actually dropped.
                // Claude CLI auto-injects CLAUDE.md natively — this is not a real problem.
                return (
                  <div className="flex items-start gap-1.5 text-blue-400">
                    <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
                    <span className="text-[10px] leading-tight">
                      Global files exceed the {formatTokenCount(contextPreview.tokenBudget)} CIE budget, but CLAUDE.md is auto-injected by the Claude CLI — supplemental context unaffected.{' '}
                      <span className="opacity-60">Raise <code className="font-mono">routing.tokenBudget</code> in .rorca/config.json to suppress.</span>
                    </span>
                  </div>
                );
              }

              return (
                <div className="flex items-start gap-1.5 text-amber-500">
                  <AlertTriangle size={11} className="shrink-0 mt-0.5" />
                  <span className="text-[10px] leading-tight">
                    {exceededCount} {exceededCount === 1 ? 'story' : 'stories'}: supplemental context files were dropped to fit the {formatTokenCount(contextPreview.tokenBudget)} token budget.
                  </span>
                </div>
              );
            })()}

            {/* Per-story breakdown */}
            <div className="space-y-0.5 max-h-40 overflow-y-auto">
              {contextPreview.stories.map((story) => (
                <div key={story.storyId}>
                  <button
                    onClick={() => setExpandedStory(expandedStory === story.storyId ? null : story.storyId)}
                    className="flex items-center gap-1.5 w-full text-left py-0.5 hover:bg-bg/50 rounded px-1 -mx-1 transition-colors"
                  >
                    {expandedStory === story.storyId
                      ? <ChevronDown size={9} className="text-muted shrink-0" />
                      : <ChevronRight size={9} className="text-muted shrink-0" />
                    }
                    <span className="text-[10px] font-mono text-muted shrink-0">{story.storyId}</span>
                    <span className="text-[10px] text-[var(--text)] truncate flex-1">{story.title}</span>
                    <span className={`text-[10px] tabular-nums shrink-0 ${story.exceeded ? (story.droppedFiles.length > 0 ? 'text-amber-500 font-medium' : 'text-blue-400') : 'text-muted'}`}>
                      {formatTokenCount(story.totalTokens)}
                    </span>
                    {story.exceeded && story.droppedFiles.length > 0 && <AlertTriangle size={9} className="text-amber-500 shrink-0" />}
                  </button>

                  {/* Expanded story detail */}
                  {expandedStory === story.storyId && (
                    <div className="ml-4 mt-1 mb-2 space-y-1.5">
                      <TokenBar
                        global={story.globalTokens}
                        scoped={story.scopedTokens}
                        tagged={story.taggedTokens}
                        budget={contextPreview.tokenBudget}
                      />

                      {/* Global files */}
                      {story.globalFiles.length > 0 && (
                        <div>
                          <div className="text-[9px] text-blue-400 font-medium mb-0.5">Global files</div>
                          {story.globalFiles.map((f) => (
                            <div key={f.path} className="flex items-center gap-1 text-[9px] text-muted pl-1">
                              <span className="w-1 h-1 rounded-full bg-blue-500 shrink-0" />
                              <span className="font-mono truncate flex-1">{f.path}</span>
                              <span className="tabular-nums shrink-0">{formatTokenCount(f.tokens)}</span>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Scoped files */}
                      {story.scopedFiles.length > 0 && (
                        <div>
                          <div className="text-[9px] text-emerald-400 font-medium mb-0.5">Scope matches</div>
                          {story.scopedFiles.map((f, i) => (
                            <div key={`${f.path}-${i}`} className="flex items-center gap-1 text-[9px] text-muted pl-1">
                              <span className="w-1 h-1 rounded-full bg-emerald-500 shrink-0" />
                              <span className="font-mono truncate flex-1">{f.path}</span>
                              <span className="tabular-nums shrink-0">{formatTokenCount(f.tokens)}</span>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Tagged files */}
                      {story.taggedFiles.length > 0 && (
                        <div>
                          <div className="text-[9px] text-purple-400 font-medium mb-0.5">Tag matches</div>
                          {story.taggedFiles.map((f, i) => (
                            <div key={`${f.path}-${i}`} className="flex items-center gap-1 text-[9px] text-muted pl-1">
                              <span className="w-1 h-1 rounded-full bg-purple-500 shrink-0" />
                              <span className="font-mono truncate flex-1">{f.path}</span>
                              <span className="tabular-nums shrink-0">{formatTokenCount(f.tokens)}</span>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Predicted paths */}
                      {story.predictedPaths.length > 0 && (
                        <div>
                          <div className="text-[9px] text-muted font-medium mb-0.5">Predicted paths</div>
                          <div className="text-[9px] text-muted font-mono pl-1">
                            {story.predictedPaths.join(', ')}
                          </div>
                        </div>
                      )}

                      {/* Dropped files warning */}
                      {story.droppedFiles.length > 0 && (
                        <div className="flex items-start gap-1 text-amber-500">
                          <AlertTriangle size={9} className="shrink-0 mt-0.5" />
                          <div className="text-[9px]">
                            <span className="font-medium">Dropped:</span>{' '}
                            <span className="font-mono">{story.droppedFiles.join(', ')}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ─── Run Options ─────────────────────────────────────────────── */}
      <div className="rounded-lg border border-border bg-[var(--bg)] p-3 space-y-2.5">
        <span className="block text-[10px] font-semibold uppercase tracking-wider text-muted mb-1">Run Options</span>

        {/* Execution mode — segmented control: Sequential | Wave Parallel */}
        <div className="space-y-2">
          <div className="flex gap-1">
            {/* Sequential pill */}
            <button
              type="button"
              onClick={() => { if (isWaveParallel) setForceSequential(true); }}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded text-[11px] font-medium transition-colors border ${
                !isWaveParallel || forceSequential
                  ? 'bg-accent text-white border-accent'
                  : 'bg-[var(--bg)] text-muted border-border hover:border-accent/40 hover:text-[var(--text)]'
              }`}
            >
              <span>Sequential</span>
            </button>
            {/* Wave Parallel pill */}
            <button
              type="button"
              onClick={() => {
                if (isWaveParallel && waveOptInAvailable) {
                  setForceSequential(false);
                  setTerminalMode('ansi-html');
                  setAutoMerge(false);
                  setMergeStrategy('branch-only');
                }
              }}
              disabled={!isWaveParallel || !waveOptInAvailable}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded text-[11px] font-medium transition-colors border ${
                waveRequested
                  ? 'bg-accent text-white border-accent'
                  : isWaveParallel && waveOptInAvailable
                    ? 'bg-[var(--bg)] text-muted border-border hover:border-accent/40 hover:text-[var(--text)]'
                    : 'bg-[var(--bg)] text-muted/40 border-border/40 cursor-not-allowed'
              }`}
            >
              <Layers size={11} className="shrink-0" />
              <span>Wave Parallel</span>
              {!isWaveParallel && orchestration && (
                <span className="text-[9px] opacity-60 italic">no parallel stories</span>
              )}
              {!orchestration && (
                <span className="text-[9px] opacity-60 animate-pulse">analyzing…</span>
              )}
            </button>
          </div>

          <p className="text-[10px] text-muted leading-tight">
            Governed status: <span className="font-medium text-[var(--text)]">{waveStatus?.status ?? 'sequential-default'}</span>
          </p>

          {/* Context below the segmented control */}
          {waveRequested && orchestration && (
            <div className="space-y-1.5 pt-0.5">
              {orchestration.waves.map((w) => (
                <div key={w.index}>
                  <div className="text-[10px] font-medium text-muted mb-0.5">Wave {w.index}</div>
                  <div className="flex flex-wrap gap-1">
                    {w.storyIds.map((id) => (
                      <span key={id} className="px-1.5 py-0.5 rounded bg-accent/10 text-accent font-mono text-[9px]">{id}</span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          {!waveRequested && orchestration && (
            <p className="text-[10px] text-muted leading-tight">
              {orchestration.totalStories} {orchestration.totalStories === 1 ? 'story' : 'stories'} · one at a time
            </p>
          )}
        </div>

        {/* Divider */}
        <div className="border-t border-border/50" />

        {/* Worktrees */}
        <label className="flex items-center gap-3 cursor-pointer group py-1">
          <div className="relative flex items-center justify-center">
            <input
              type="checkbox"
              checked={autoWorktree || waveRequested}
              onChange={(e) => {
                if (waveRequested) return;
                setAutoWorktree(e.target.checked);
                if (e.target.checked) setAutoMerge(true);
                else setAutoMerge(false);
              }}
              disabled={waveRequested}
              className="peer sr-only"
            />
            <div className="w-8 h-[18px] rounded-full bg-[var(--border)] peer-checked:bg-accent transition-colors" />
            <div className="absolute left-0.5 top-0.5 w-3.5 h-3.5 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-[14px]" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <GitBranch size={12} className="text-muted shrink-0" />
              <span className="text-xs font-medium text-[var(--text)]">Isolate in worktree</span>
              {waveRequested && (
                <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-accent/15 text-accent font-medium">required</span>
              )}
            </div>
          </div>
        </label>

        {/* Merge Strategy — nested under worktrees */}
        {(autoWorktree || waveRequested) && (
          <div className="ml-11 py-1.5">
            <label htmlFor="trigger-merge-strategy" className="text-[11px] text-muted mb-1.5 block font-medium">Completion action</label>
            <select
              id="trigger-merge-strategy"
              value={mergeStrategy}
              onChange={e => {
                const val = e.target.value as any;
                setMergeStrategy(val);
                setAutoMerge(val === 'direct');
              }}
              className="w-full px-2.5 py-1.5 text-xs bg-[var(--bg-secondary,var(--bg))] border border-border rounded-md focus:border-accent outline-none text-[var(--text)] appearance-none cursor-pointer"
              style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 8px center', paddingRight: '28px' }}
            >
              <option value="direct">Merge directly to main</option>
              <option value="pr">Open Pull Request</option>
              <option value="draft-pr">Open Draft PR</option>
              <option value="branch-only">Leave on branch</option>
            </select>
            <p className="text-[10px] text-muted mt-1 leading-tight">
              {mergeStrategy === 'direct' && 'Fastest \u2014 merges worktree and pushes main immediately'}
              {mergeStrategy === 'pr' && 'Recommended \u2014 creates a PR for CI checks and review'}
              {mergeStrategy === 'draft-pr' && 'Review later \u2014 creates a draft PR for async review'}
              {mergeStrategy === 'branch-only' && 'Manual control \u2014 pushes branch, you decide what\u2019s next'}
            </p>
          </div>
        )}

        {/* Divider */}
        <div className="border-t border-border/50" />

        {/* Knowledge Graph */}
        <label className="flex items-center gap-3 cursor-pointer group py-1">
          <div className="relative flex items-center justify-center">
            <input
              type="checkbox"
              checked={includeGraph}
              onChange={(e) => {
                const val = e.target.checked;
                setIncludeGraph(val);
                if (workspaceId) {
                  apiFetch(`/api/workspaces/${workspaceId}/pipeline-config`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ includeGraph: val }),
                  }).catch(() => {});
                }
              }}
              className="peer sr-only"
            />
            <div className="w-8 h-[18px] rounded-full bg-[var(--border)] peer-checked:bg-violet-500 transition-colors" />
            <div className="absolute left-0.5 top-0.5 w-3.5 h-3.5 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-[14px]" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-medium text-[var(--text)]">Knowledge Graph</span>
              <span className="relative group/tip">
                <Info size={11} className="text-muted/60 cursor-help" />
                <span className="absolute left-full top-1/2 -translate-y-1/2 ml-2 px-2.5 py-2 rounded-md bg-[var(--bg-elevated)] border border-border text-[10px] text-muted leading-snug w-60 opacity-0 pointer-events-none group-hover/tip:opacity-100 group-hover/tip:pointer-events-auto transition-opacity z-[200] shadow-xl">
                  Traverses file-to-story and memory edges to surface prior context for each story.
                </span>
              </span>
            </div>
            <p className="text-[10px] text-muted leading-tight mt-0.5">
              Enrich stories with graph-linked memories and file history
            </p>
          </div>
        </label>

        {/* Native/live terminal mode */}
        <div className="space-y-2 rounded-lg border border-border/60 bg-[var(--bg)] p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium text-[var(--text)]">Terminal Stream</span>
                <span className="relative group/tip">
                  <Info size={11} className="text-muted/60 cursor-help" />
                  <span className="absolute left-full top-1/2 -translate-y-1/2 ml-2 px-2.5 py-2 rounded-md bg-[var(--bg-elevated)] border border-border text-[10px] text-muted leading-snug w-72 opacity-0 pointer-events-none group-hover/tip:opacity-100 group-hover/tip:pointer-events-auto transition-opacity z-[200] shadow-xl">
                    PTY Print keeps the reliable autonomous print/exec contract. Native PTY runs the real interactive CLI in xterm and uses a marker file to detect story completion.
                  </span>
                </span>
              </div>
              <p className="text-[10px] text-muted leading-tight mt-0.5">
                Choose reliability-first output or the native interactive CLI experience.
              </p>
            </div>
            <select
              aria-label="Terminal stream"
              value={terminalMode}
              onChange={(event) => {
                const nextMode = event.target.value as 'ansi-html' | 'pty' | 'native-pty';
                setTerminalMode(nextMode);
                if (nextMode === 'native-pty') setForceSequential(true);
              }}
              className="shrink-0 rounded-md border border-border bg-[var(--bg-elevated)] px-2 py-1 text-[11px] text-[var(--text)]"
            >
              <option value="pty">PTY Print</option>
              <option value="native-pty">Native PTY</option>
              <option value="ansi-html">ANSI Replay</option>
            </select>
          </div>
          {terminalMode === 'native-pty' && (
            <p className="text-[10px] leading-snug text-amber-400/90">
              Native PTY is best for supervised/debug runs. If the interactive CLI never creates the completion marker, Rorca falls back to the story timeout.
            </p>
          )}
        </div>

        {/* Divider */}
        <div className="border-t border-border/50" />

        {/* Thinking controls — effort levels are driven by the model's capability */}
        <ThinkingControls
          engine={agentConfig?.agentType ?? null}
          model={agentConfig?.agentModel ?? null}
          effortLevel={effortLevel}
          onEffortChange={(level) => { setEffortLevel(level); setDryRunEstimate(null); }}
          thinkingEnabled={thinkingEnabled}
          onThinkingEnabledChange={(enabled) => { setThinkingEnabled(enabled); setDryRunEstimate(null); }}
          thinkingBudget={thinkingBudget}
          onThinkingBudgetChange={setThinkingBudget}
          costMultiplier={modelCapability?.costMultiplier ?? reasoningCostMultipliers}
          supportedEffortLevels={modelCapability?.effortLevels}
          supportsReasoning={modelCapability?.supportsReasoning}
        />

      </div>

      {/* Action buttons */}
      <div className="space-y-2 pt-1">
        {/* Run Now — primary */}
        <button
          onClick={() => {
            const effectiveWorktree = autoWorktree || waveRequested;
            const isClaude = agentConfig?.agentType === 'claude';
            const m = agentConfig?.agentModel?.toLowerCase() ?? '';
            const thinkingApplies = isClaude && (m.includes('opus') || m.includes('sonnet'));
            onTrigger(effectiveWorktree, {
              forceSequential: !waveRequested || terminalMode === 'native-pty' || undefined,
              orchestrationMode: waveRequested ? 'wave-parallel' : 'sequential',
              parallelism: waveRequested ? Math.min(orchestration?.parallelism ?? 1, waveStatus?.rollout.maxParallelism ?? 1) : 1,
              qualificationReceiptId: waveRequested ? waveStatus?.receipt?.id : undefined,
              rolloutCohort: waveRequested ? waveStatus?.rollout.cohort : undefined,
              autoMerge: effectiveWorktree ? autoMerge : undefined,
              mergeStrategy: effectiveWorktree ? mergeStrategy : undefined,
              includeGraph: includeGraph || undefined,
              terminal_mode: terminalMode,
              effortLevel: thinkingApplies ? effortLevel : undefined,
              thinkingEnabled: thinkingApplies ? thinkingEnabled : undefined,
              thinkingBudget: thinkingApplies && thinkingEnabled ? thinkingBudget : undefined,
              reasoningOverride: modelCapability?.supportsReasoning ? { enabled: reasoningEnabled, effort: reasoningEnabled ? reasoningEffort : undefined } : undefined,
              executionEnvironment,
            });
          }}
          disabled={triggerDisabled}
          className="flex items-center justify-center gap-2 w-full py-2.5 rounded-lg text-sm font-semibold bg-accent text-white hover:brightness-110 disabled:opacity-50 transition-all shadow-sm shadow-accent/20"
        >
          {loading ? (
            <><Loader2 size={15} className="animate-spin" /> Starting run...</>
          ) : (
            <><Play size={15} /> Run Now</>
          )}
        </button>

        {/* Add to Queue — secondary */}
        {onAddToQueue && (
          <button
            onClick={() => {
              const effectiveWorktree = autoWorktree;
              const isClaude = agentConfig?.agentType === 'claude';
              const m = agentConfig?.agentModel?.toLowerCase() ?? '';
              const thinkingApplies = isClaude && (m.includes('opus') || m.includes('sonnet'));
              onAddToQueue(effectiveWorktree, {
                forceSequential: true,
                orchestrationMode: 'sequential',
                parallelism: 1,
                autoMerge: effectiveWorktree ? autoMerge : undefined,
                mergeStrategy: effectiveWorktree ? mergeStrategy : undefined,
                includeGraph: includeGraph || undefined,
                terminal_mode: terminalMode,
                effortLevel: thinkingApplies ? effortLevel : undefined,
                thinkingEnabled: thinkingApplies ? thinkingEnabled : undefined,
                thinkingBudget: thinkingApplies && thinkingEnabled ? thinkingBudget : undefined,
                reasoningOverride: modelCapability?.supportsReasoning ? { enabled: reasoningEnabled, effort: reasoningEnabled ? reasoningEffort : undefined } : undefined,
                executionEnvironment,
              });
            }}
            disabled={triggerDisabled}
            title="Will run after the active spec completes"
            className="flex items-center justify-center gap-2 w-full py-2.5 rounded-lg text-sm font-medium border border-border text-[var(--text)] hover:bg-[var(--bg)] disabled:opacity-50 transition-all"
          >
            {queueLoading ? (
              <><Loader2 size={15} className="animate-spin" /> Adding to queue...</>
            ) : (
              <><ListPlus size={15} /> Add to Queue</>
            )}
          </button>
        )}

        {/* Preview Cost — dry-run estimate (only when specPath is available) */}
        {specPath && workspaceId && (
          <button
            onClick={handleDryRun}
            disabled={dryRunLoading}
            className="flex items-center justify-center gap-2 w-full py-2 rounded-lg text-xs font-medium border border-border/60 text-muted hover:text-[var(--text)] hover:border-border disabled:opacity-40 transition-all"
          >
            {dryRunLoading ? (
              <><Loader2 size={12} className="animate-spin" /> Estimating...</>
            ) : (
              <><DollarSign size={12} /> Preview Cost</>
            )}
          </button>
        )}

        {/* Dry-run cost preview panel */}
        {dryRunEstimate && (
          <div className="rounded-lg border border-border/60 bg-[var(--bg)] p-3 space-y-1.5 text-xs">
            <div className="flex items-center gap-1.5 mb-2">
              <DollarSign size={11} className="text-muted" />
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">Cost Estimate</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted">Base cost</span>
              <span className="font-medium tabular-nums text-[var(--text)]">
                {dryRunEstimate.totalEstimatedCostUsd >= 0.01
                  ? `$${dryRunEstimate.totalEstimatedCostUsd.toFixed(3)}`
                  : `$${dryRunEstimate.totalEstimatedCostUsd.toFixed(5)}`}
              </span>
            </div>
            {dryRunEstimate.reasoningCostMultiplier !== undefined && (
              <div className="flex items-center justify-between">
                <span className="text-muted">With reasoning ({dryRunEstimate.reasoningCostMultiplier}x)</span>
                <span className="font-medium tabular-nums text-amber-400">
                  {(() => {
                    const withReasoning = dryRunEstimate.totalEstimatedCostUsd * dryRunEstimate.reasoningCostMultiplier!;
                    return withReasoning >= 0.01
                      ? `$${withReasoning.toFixed(3)}`
                      : `$${withReasoning.toFixed(5)}`;
                  })()}
                </span>
              </div>
            )}
            <p className="text-[9px] text-muted/50 pt-1">Estimate only — actual cost depends on story complexity</p>
          </div>
        )}
      </div>
        </div>,
        document.body,
      )}
    </>
  );
}
