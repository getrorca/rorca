import { useState, useEffect, useRef } from 'react';
import { Play, Minus, Plus, GitBranch, Loader2, ListPlus, AlertTriangle, Cpu } from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';
import { preflightCheck, type CapabilityWarning } from '../api/pipeline';
import type { PanelId } from './Sidebar';

interface AgentConfigSummary {
  agentType: 'claude' | 'opencode' | 'codex';
  agentModel: string | null;
  modelDisplayName: string | null;
  hasApiKey: boolean;
}

interface TriggerPopoverProps {
  /** Default parallelism from workspace settings */
  defaultParallelism?: number;
  /** Whether a trigger is currently in progress */
  loading?: boolean;
  /** Called when user clicks Run Now */
  onTrigger: (parallelism: number, autoWorktree: boolean) => void;
  /** Called when user clicks Add to Queue */
  onAddToQueue?: (parallelism: number, autoWorktree: boolean) => void;
  /** Whether Add to Queue action is loading */
  queueLoading?: boolean;
  /** Called when popover is dismissed */
  onClose: () => void;
  /** Navigate to another panel (e.g. settings) */
  onNavigate?: (panel: PanelId) => void;
  /** Spec path for capability preflight check */
  specPath?: string;
  /** Workspace ID for capability preflight check */
  workspaceId?: string;
}

export default function TriggerPopover({
  defaultParallelism = 1,
  loading = false,
  onTrigger,
  onAddToQueue,
  queueLoading = false,
  onClose,
  onNavigate,
  specPath,
  workspaceId,
}: TriggerPopoverProps) {
  const [parallelism, setParallelism] = useState(defaultParallelism);
  const [autoWorktree, setAutoWorktree] = useState(defaultParallelism > 1);
  const [agentConfig, setAgentConfig] = useState<AgentConfigSummary | null>(null);
  const [capWarnings, setCapWarnings] = useState<CapabilityWarning[]>([]);
  const [capMismatchMode, setCapMismatchMode] = useState<string>('warn');
  const ref = useRef<HTMLDivElement>(null);

  // Auto-check worktrees when parallelism > 1
  useEffect(() => {
    if (parallelism > 1) setAutoWorktree(true);
  }, [parallelism]);

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

  const decrement = () => setParallelism((p) => Math.max(1, p - 1));
  const increment = () => setParallelism((p) => Math.min(10, p + 1));

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

  return (
    <div
      ref={ref}
      className="absolute bottom-full left-0 right-0 mb-2 rounded-lg border border-border bg-panel shadow-lg z-50 p-3 space-y-3"
    >
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

      {/* Parallelism stepper */}
      <div>
        <label className="block text-xs text-muted mb-1.5">Parallelism</label>
        <div className="flex items-center gap-2">
          <button
            onClick={decrement}
            disabled={parallelism <= 1}
            className="p-1 rounded border border-border hover:bg-bg disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <Minus size={14} />
          </button>
          <span className="w-8 text-center text-sm font-semibold text-[var(--text)] tabular-nums">
            {parallelism}
          </span>
          <button
            onClick={increment}
            disabled={parallelism >= 10}
            className="p-1 rounded border border-border hover:bg-bg disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <Plus size={14} />
          </button>
          <span className="text-[10px] text-muted ml-1">
            {parallelism === 1 ? 'sequential' : `${parallelism} parallel`}
          </span>
        </div>
      </div>

      {/* Use worktrees checkbox */}
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={autoWorktree}
          onChange={(e) => {
            // Don't allow unchecking when parallelism > 1
            if (parallelism > 1) return;
            setAutoWorktree(e.target.checked);
          }}
          disabled={parallelism > 1}
          className="rounded border-border accent-[var(--accent)]"
        />
        <span className="text-xs text-[var(--text)] flex items-center gap-1">
          <GitBranch size={12} className="text-muted" />
          Use worktrees
        </span>
        {parallelism > 1 && (
          <span className="text-[10px] text-muted">(required for parallel)</span>
        )}
      </label>

      {/* Action buttons */}
      <div className="space-y-2">
        {/* Run Now — primary */}
        <button
          onClick={() => onTrigger(parallelism, autoWorktree)}
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
            onClick={() => onAddToQueue(parallelism, autoWorktree)}
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
