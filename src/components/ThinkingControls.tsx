/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useEffect } from 'react';
import { Brain } from 'lucide-react';

export type EffortLevel = 'low' | 'medium' | 'high' | 'max' | 'xhigh';

import type { EngineValue } from './EngineSelector';

export interface ThinkingControlsProps {
  /** Current agent engine type */
  engine: EngineValue | null;
  /** Current model string (e.g. 'claude-opus-4-6', 'claude-sonnet-4-5-...') */
  model: string | null;
  /** Effort level selection */
  effortLevel: EffortLevel;
  onEffortChange: (level: EffortLevel) => void;
  /** Whether extended thinking is enabled */
  thinkingEnabled: boolean;
  onThinkingEnabledChange: (enabled: boolean) => void;
  /** Cost multiplier per effort level from ReasoningCapability. Used to render cost impact label. */
  costMultiplier?: Record<string, number>;
  /**
   * Effort levels supported by the current model, sourced from
   * /api/config/model-capability. When provided, this drives the visible
   * segmented control instead of the hardcoded Claude defaults.
   */
  supportedEffortLevels?: string[];
  /** Whether the current model supports any reasoning at all (drives interactivity). */
  supportsReasoning?: boolean;
  /** Accepted but unused — kept for backward compat with callers that pass thinkingBudget */
  thinkingBudget?: number;
  onThinkingBudgetChange?: (n: number) => void;
}

const EFFORT_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  max: 'Max',
  xhigh: 'X-High',
};

function effortLabelForModel(model: string | null, value: string): string {
  const id = model?.toLowerCase() ?? '';
  const isDeepSeekV4 = id.endsWith('deepseek-v4-pro') || id.endsWith('deepseek-v4-flash') || id === 'deepseek-v4-pro' || id === 'deepseek-v4-flash';
  if (isDeepSeekV4) {
    if (value === 'low') return 'Non-Think';
    if (value === 'high') return 'Think High';
    if (value === 'max' || value === 'xhigh') return 'Think Max';
  }
  return EFFORT_LABELS[value] ?? value;
}

const CLAUDE_DEFAULT_LEVELS: string[] = ['low', 'medium', 'high', 'max'];

function isOpus(model: string | null): boolean {
  return !!model && model.toLowerCase().includes('opus');
}

/** Claude is the only engine that supports the Extended Thinking toggle. */
function isClaudeOpusOrSonnet(engine: string | null, model: string | null): boolean {
  if (engine !== 'claude') return false;
  if (!model) return false;
  const m = model.toLowerCase();
  return m.includes('opus') || m.includes('sonnet');
}

export default function ThinkingControls({
  engine,
  model,
  effortLevel,
  onEffortChange,
  thinkingEnabled,
  onThinkingEnabledChange,
  costMultiplier,
  supportedEffortLevels,
  supportsReasoning,
}: ThinkingControlsProps) {
  // Resolve which levels to render. Priority:
  //   1. supportedEffortLevels prop (from /api/config/model-capability) — most accurate
  //   2. Claude opus → all 4; Claude sonnet/haiku → low/medium/high
  //   3. Empty → control inert
  const resolvedLevels: string[] = (() => {
    if (supportedEffortLevels && supportedEffortLevels.length > 0) {
      return supportedEffortLevels;
    }
    if (engine === 'claude' && model) {
      return isOpus(model) ? CLAUDE_DEFAULT_LEVELS : CLAUDE_DEFAULT_LEVELS.filter(l => l !== 'max');
    }
    return [];
  })();

  const visibleLevels = resolvedLevels.map(value => ({ value, label: effortLabelForModel(model, value) }));

  // Effort selector is active whenever we have at least one supported level.
  // Extended-thinking toggle is still Claude-only (it's an Anthropic API feature).
  const effortActive = visibleLevels.length > 0 && (supportsReasoning ?? true);
  const thinkingToggleActive = isClaudeOpusOrSonnet(engine, model);
  const effortDisabledClass = !effortActive ? 'opacity-50 pointer-events-none' : '';

  // If the current effortLevel isn't in the supported set, snap to a sensible default.
  const effectiveEffort = visibleLevels.some(l => l.value === effortLevel)
    ? effortLevel
    : (visibleLevels.find(l => l.value === 'medium')?.value ?? visibleLevels[0]?.value ?? effortLevel);

  useEffect(() => {
    if (effortActive && effectiveEffort !== effortLevel) {
      onEffortChange(effectiveEffort as EffortLevel);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveEffort, effortActive]);

  return (
    <div className="space-y-3">
      {/* Section header */}
      <div className="flex items-center gap-1.5">
        <Brain size={12} className="text-muted shrink-0" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">Thinking</span>
        {!effortActive && (
          <span className="text-[9px] text-muted/60 italic ml-1">No reasoning support</span>
        )}
      </div>

      {/* Effort segmented control */}
      <div className={effortDisabledClass}>
        <span className="block text-[10px] text-muted mb-1.5">Effort</span>
        <div className="flex gap-1">
          {visibleLevels.length === 0 ? (
            <span className="text-[10px] text-muted/60 italic">Model has no reasoning effort levels</span>
          ) : (
            visibleLevels.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                onClick={() => effortActive && onEffortChange(value as EffortLevel)}
                className={`flex-1 py-1 rounded text-[11px] font-medium transition-colors border ${
                  effectiveEffort === value
                    ? 'bg-accent text-white border-accent'
                    : 'bg-[var(--bg)] text-muted border-border hover:border-accent/40 hover:text-[var(--text)]'
                }`}
              >
                {label}
              </button>
            ))
          )}
        </div>
      </div>

      {/* Extended thinking toggle — Claude-only feature */}
      <label className={`flex items-center gap-3 cursor-pointer py-0.5 ${thinkingToggleActive ? '' : 'opacity-50 pointer-events-none'}`}>
        <div className="relative flex items-center justify-center shrink-0">
          <input
            type="checkbox"
            checked={thinkingEnabled}
            onChange={(e) => thinkingToggleActive && onThinkingEnabledChange(e.target.checked)}
            className="peer sr-only"
          />
          <div className="w-8 h-[18px] rounded-full bg-[var(--border)] peer-checked:bg-accent transition-colors" />
          <div className="absolute left-0.5 top-0.5 w-3.5 h-3.5 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-[14px]" />
        </div>
        <span className="text-xs font-medium text-[var(--text)]">Extended thinking</span>
        {!thinkingToggleActive && (
          <span className="text-[9px] text-muted/60 italic">Claude only</span>
        )}
        {thinkingEnabled && thinkingToggleActive && (() => {
          const multiplier = costMultiplier
            ? (costMultiplier[effectiveEffort] ?? costMultiplier['default'])
            : undefined;
          return multiplier !== undefined
            ? <span className="ml-auto text-[10px] font-medium text-amber-400/80">~{multiplier}x base cost</span>
            : <span className="ml-auto text-[10px] text-muted/60">Cost impact unknown</span>;
        })()}
      </label>
    </div>
  );
}
