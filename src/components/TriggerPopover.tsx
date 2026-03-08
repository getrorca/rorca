import { useState, useEffect, useRef } from 'react';
import { Play, GitBranch, Loader2, ListPlus, AlertTriangle, Cpu, Layers, ArrowRight, HeartPulse, FileText, ChevronDown, ChevronRight, ShieldAlert } from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';
import { preflightCheck, type CapabilityWarning } from '../api/pipeline';
import type { PanelId } from './Sidebar';

interface HealthBadge {
  score: number;
  scannedAt: string;
}

interface AgentConfigSummary {
  agentType: 'claude' | 'opencode' | 'codex';
  agentModel: string | null;
  modelDisplayName: string | null;
  hasApiKey: boolean;
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

interface TriggerPopoverProps {
  /** Whether a trigger is currently in progress */
  loading?: boolean;
  /** Called when user clicks Run Now */
  onTrigger: (autoWorktree: boolean, options?: { forceSequential?: boolean }) => void;
  /** Called when user clicks Add to Queue */
  onAddToQueue?: (autoWorktree: boolean, options?: { forceSequential?: boolean }) => void;
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
}: TriggerPopoverProps) {
  const [autoWorktree, setAutoWorktree] = useState(false);
  const [agentConfig, setAgentConfig] = useState<AgentConfigSummary | null>(null);
  const [capWarnings, setCapWarnings] = useState<CapabilityWarning[]>([]);
  const [capMismatchMode, setCapMismatchMode] = useState<string>('warn');
  const [orchestration, setOrchestration] = useState<OrchestrationPreview | null>(null);
  const [healthBadge, setHealthBadge] = useState<HealthBadge | null>(null);
  const [contextPreview, setContextPreview] = useState<ContextPreviewData | null>(null);
  const [contextExpanded, setContextExpanded] = useState(false);
  const [expandedStory, setExpandedStory] = useState<string | null>(null);
  const [driftData, setDriftData] = useState<DriftReportData | null>(null);
  const [driftCheckEnabled, setDriftCheckEnabled] = useState(false);
  const [forceSequential, setForceSequential] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Fetch workspace health badge on mount
  useEffect(() => {
    if (!workspaceId) return;
    apiFetch<HealthBadge>(`/api/workspaces/${workspaceId}/health`)
      .then(setHealthBadge)
      .catch(() => {});
  }, [workspaceId]);

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
        setCapMismatchMode(report.mismatchMode);
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
      .then((result) => {
        setOrchestration(result);
        // Auto-enable worktrees for wave-parallel
        if (result.mode === 'wave-parallel') setAutoWorktree(true);
      })
      .catch(() => {});
  }, [specPath, workspaceId]);

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
  const isBlocked = capMismatchMode === 'block' && capWarnings.length > 0;
  const triggerDisabled = loading || queueLoading || noModelConfigured || noApiKey || isBlocked;

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

  // Build orchestration badge text
  const orchBadgeText = orchestration
    ? isWaveParallel
      ? `Wave parallel \u00b7 ${orchestration.waveCount} waves \u00b7 max ${orchestration.maxWaveSize} parallel`
      : `Sequential \u00b7 ${orchestration.totalStories} stories`
    : null;

  return (
    <div
      ref={ref}
      className="absolute bottom-full left-0 right-0 mb-2 rounded-lg border border-border bg-panel shadow-lg z-50 p-3 space-y-3"
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

      {/* OC-031: Capability warnings */}
      {capWarnings.length > 0 && (
        <div>
          <label className="block text-xs text-muted mb-1">
            {isBlocked ? 'Incompatible stories' : 'Capability warnings'}
          </label>
          <div className="space-y-1 max-h-24 overflow-y-auto">
            {capWarnings.map((w) => (
              <div
                key={w.storyId}
                className={`flex items-start gap-1.5 ${isBlocked ? 'text-red-400' : 'text-amber-500'}`}
              >
                <AlertTriangle size={11} className="shrink-0 mt-0.5" />
                <span className="text-[10px] leading-tight">
                  {w.storyId} uses {w.missingTools.join(', ')} — not supported by {w.engine}
                  {capMismatchMode === 'reroute' && ', will reroute to Claude'}
                </span>
              </div>
            ))}
          </div>
          {isBlocked && (
            <p className="text-[10px] text-red-400 mt-1">
              Run blocked — change engine or set capabilityMismatch to &quot;warn&quot; or &quot;reroute&quot;
            </p>
          )}
        </div>
      )}

      {/* Orchestration mode — toggleable between wave-parallel and sequential */}
      <div>
        <label className="block text-xs text-muted mb-1.5">Execution</label>
        {orchestration ? (
          <div>
            {isWaveParallel ? (
              <div className="flex items-center gap-2">
                <Layers size={13} className={forceSequential ? 'text-muted shrink-0' : 'text-accent shrink-0'} />
                <button
                  onClick={() => setForceSequential(!forceSequential)}
                  className={`text-xs font-medium hover:underline cursor-pointer ${forceSequential ? 'text-[var(--text)]' : 'text-accent'}`}
                  title={forceSequential ? 'Click to enable wave parallel' : 'Click to force sequential'}
                >
                  {forceSequential
                    ? `Sequential · ${orchestration.totalStories} stories`
                    : orchBadgeText}
                </button>
                <span className="text-[9px] text-muted ml-auto">(click to toggle)</span>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Layers size={13} className="text-muted shrink-0" />
                <span className="text-xs font-medium text-[var(--text)]">{orchBadgeText}</span>
              </div>
            )}
            {/* Show wave breakdown when wave-parallel and not forced sequential */}
            {isWaveParallel && !forceSequential && orchestration && (
              <div className="mt-1.5 space-y-0.5">
                {orchestration.waves.map((w) => (
                  <div key={w.index} className="flex items-center gap-1 text-[10px] text-muted">
                    <span className="font-medium tabular-nums w-12 shrink-0">Wave {w.index}</span>
                    <ArrowRight size={8} className="shrink-0" />
                    <span className="truncate">{w.storyIds.join(', ')}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Layers size={13} className="text-muted shrink-0 animate-pulse" />
            <span className="text-xs text-muted">Analyzing dependencies...</span>
          </div>
        )}
      </div>

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

      {/* Use worktrees checkbox */}
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={autoWorktree || (isWaveParallel && !forceSequential)}
          onChange={(e) => {
            if (isWaveParallel && !forceSequential) return;
            setAutoWorktree(e.target.checked);
          }}
          disabled={isWaveParallel && !forceSequential}
          className="rounded border-border accent-[var(--accent)]"
        />
        <span className="text-xs text-[var(--text)] flex items-center gap-1">
          <GitBranch size={12} className="text-muted" />
          Use worktrees
        </span>
        {isWaveParallel && !forceSequential && (
          <span className="text-[10px] text-muted">(required for parallel)</span>
        )}
      </label>

      {/* Action buttons */}
      <div className="space-y-2">
        {/* Run Now — primary */}
        <button
          onClick={() => {
            const effectiveWorktree = autoWorktree || (isWaveParallel && !forceSequential);
            onTrigger(effectiveWorktree, { forceSequential: forceSequential || undefined });
          }}
          disabled={triggerDisabled}
          className="flex items-center justify-center gap-1.5 w-full py-2 rounded text-sm font-medium bg-accent text-white hover:opacity-90 disabled:opacity-60 transition-opacity"
        >
          {loading ? (
            <><Loader2 size={14} className="animate-spin" /> Starting run...</>
          ) : (
            <><Play size={14} /> Run Now</>
          )}
        </button>

        {/* Add to Queue — secondary */}
        {onAddToQueue && (
          <button
            onClick={() => {
              const effectiveWorktree = autoWorktree || (isWaveParallel && !forceSequential);
              onAddToQueue(effectiveWorktree, { forceSequential: forceSequential || undefined });
            }}
            disabled={triggerDisabled}
            title="Will run after the active spec completes"
            className="flex items-center justify-center gap-1.5 w-full py-2 rounded text-sm font-medium border border-border text-[var(--text)] hover:bg-bg disabled:opacity-60 transition-colors"
          >
            {queueLoading ? (
              <><Loader2 size={14} className="animate-spin" /> Adding to queue...</>
            ) : (
              <><ListPlus size={14} /> Add to Queue</>
            )}
          </button>
        )}
      </div>
    </div>
  );
}
