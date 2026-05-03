/**
 * SpecModelControlBar — horizontal bar composing EngineSelector + ModelPickerPopover + ThinkingControls.
 *
 * Reads initial state from spec JSON fields (agentOverride, model, thinkingEnabled,
 * effortLevel). Any change persists via PUT /api/specs/:specId.
 *
 * Layout: engine pills (left) | model picker (center) | thinking controls (right)
 * Height: ~48px collapsed, expands when thinking toggle is on.
 */
import { useState, useCallback } from 'react';
import { Loader2, Brain } from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';
import { EngineSelector } from './EngineSelector';
import type { EngineValue } from './EngineSelector';
import ModelPickerPopover from './ModelPickerPopover';
import ThinkingControls from './ThinkingControls';
import type { EffortLevel } from './ThinkingControls';

/* ─── Reasoning types ────────────────────────────────────────────────── */

export interface ReasoningConfig {
  enabled: boolean;
  effort?: string;
}

/* ─── Props ──────────────────────────────────────────────────────────────── */

export interface SpecModelControlBarProps {
  specId: string;
  workspaceId: string;
  /** Initial engine override from spec JSON */
  initialEngine?: EngineValue | null;
  /** Initial model from spec JSON */
  initialModel?: string | null;
  /** Initial thinking enabled flag from spec JSON */
  initialThinkingEnabled?: boolean;
  /** Initial thinking budget (tokens) from spec JSON — kept for backward compat but unused in UI */
  initialThinkingBudget?: number;
  /** Initial effort level from spec JSON */
  initialEffortLevel?: EffortLevel;
  /** Reasoning config from spec JSON (set at generation time) */
  initialReasoning?: ReasoningConfig;
  /** Called after a successful PUT so parent can sync local state */
  onSpecUpdated?: (fields: SpecModelFields) => void;
}

export interface SpecModelFields {
  agentOverride?: EngineValue | null;
  model?: string | null;
  thinkingEnabled?: boolean;
  thinkingBudget?: number;
  effortLevel?: EffortLevel;
}

/* ─── Defaults ───────────────────────────────────────────────────────────── */

const DEFAULT_ENGINE: EngineValue = 'claude';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_EFFORT: EffortLevel = 'medium';

/* ─── Component ──────────────────────────────────────────────────────────── */

export function SpecModelControlBar({
  specId,
  workspaceId,
  initialEngine,
  initialModel,
  initialThinkingEnabled = false,
  initialEffortLevel = DEFAULT_EFFORT,
  initialReasoning,
  onSpecUpdated,
}: SpecModelControlBarProps) {
  const [engine, setEngine] = useState<EngineValue>(initialEngine ?? DEFAULT_ENGINE);
  const [model, setModel] = useState<string>(initialModel ?? DEFAULT_MODEL);
  const [thinkingEnabled, setThinkingEnabled] = useState(initialThinkingEnabled);
  const [effortLevel, setEffortLevel] = useState<EffortLevel>(initialEffortLevel);
  const [saving, setSaving] = useState(false);

  const persist = useCallback(async (patch: SpecModelFields) => {
    setSaving(true);
    try {
      await apiFetch(`/api/specs/${specId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, ...patch }),
      });
      onSpecUpdated?.(patch);
    } catch {
      // Silently ignore — the local state is already updated; next page load will
      // re-read from spec JSON. An error here doesn't need a toast (non-critical).
    } finally {
      setSaving(false);
    }
  }, [specId, workspaceId, onSpecUpdated]);

  const handleEngineChange = useCallback((next: EngineValue) => {
    setEngine(next);
    persist({ agentOverride: next });
  }, [persist]);

  const handleModelChange = useCallback((next: string) => {
    setModel(next);
    persist({ model: next });
  }, [persist]);

  const handleEffortChange = useCallback((next: EffortLevel) => {
    setEffortLevel(next);
    persist({ effortLevel: next });
  }, [persist]);

  const handleThinkingEnabledChange = useCallback((next: boolean) => {
    setThinkingEnabled(next);
    persist({ thinkingEnabled: next });
  }, [persist]);

  return (
    <div className="flex flex-col gap-0 border-b border-border/60 bg-[var(--surface-100,var(--bg))] shrink-0">
      {/* Main row: engine | model | saving indicator */}
      <div className="flex items-center gap-2 px-3 py-2 min-h-[48px]">
        {/* Engine pills — left */}
        <div className="shrink-0">
          <EngineSelector value={engine} onChange={handleEngineChange} />
        </div>

        {/* Model picker — center, grows to fill space */}
        <div className="flex-1 min-w-0 flex justify-center">
          <ModelPickerPopover
            engine={engine}
            value={model}
            onChange={handleModelChange}
            workspaceId={workspaceId}
          />
        </div>

        {/* Reasoning badge — shown when spec was generated with reasoning enabled */}
        {initialReasoning?.enabled && (
          <div className="shrink-0 flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-purple-500/15 text-purple-400 border border-purple-500/30">
            <Brain size={10} />
            <span>Reasoning{initialReasoning.effort ? `: ${initialReasoning.effort}` : ''}</span>
          </div>
        )}

        {/* Saving indicator — right */}
        <div className="shrink-0 w-4 flex items-center justify-center">
          {saving && <Loader2 size={12} className="animate-spin text-muted" />}
        </div>
      </div>

      {/* Thinking controls — full-width row, only shown when engine is claude */}
      {engine === 'claude' && (
        <div className="px-3 pb-3">
          <ThinkingControls
            engine="claude"
            model={model}
            effortLevel={effortLevel}
            onEffortChange={handleEffortChange}
            thinkingEnabled={thinkingEnabled}
            onThinkingEnabledChange={handleThinkingEnabledChange}
          />
        </div>
      )}
    </div>
  );
}
