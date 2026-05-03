import { Brain } from 'lucide-react';

export type EffortLevel = 'low' | 'medium' | 'high' | 'max';

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
  /** Accepted but unused — kept for backward compat with callers that pass thinkingBudget */
  thinkingBudget?: number;
  onThinkingBudgetChange?: (n: number) => void;
}

const EFFORT_LEVELS: { value: EffortLevel; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' },
];

function isOpus(model: string | null): boolean {
  return !!model && model.toLowerCase().includes('opus');
}

/** Returns true when ThinkingControls should be fully interactive */
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
}: ThinkingControlsProps) {
  const active = isClaudeOpusOrSonnet(engine, model);
  const disabledClass = !active ? 'opacity-50 pointer-events-none' : '';
  const opusSelected = isOpus(model);

  // Max effort is Opus-only — Sonnet caps at high
  const visibleLevels = opusSelected
    ? EFFORT_LEVELS
    : EFFORT_LEVELS.filter(l => l.value !== 'max');

  // If Sonnet is selected but effort was set to max, clamp down to high
  const effectiveEffort = (!opusSelected && effortLevel === 'max') ? 'high' : effortLevel;

  return (
    <div className={`space-y-3 ${disabledClass}`}>
      {/* Section header */}
      <div className="flex items-center gap-1.5">
        <Brain size={12} className="text-muted shrink-0" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">Thinking</span>
        {!active && engine !== 'claude' && (
          <span className="text-[9px] text-muted/60 italic ml-1">Claude only</span>
        )}
      </div>

      {/* Effort segmented control */}
      <div>
        <span className="block text-[10px] text-muted mb-1.5">Effort</span>
        <div className="flex gap-1">
          {visibleLevels.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              onClick={() => active && onEffortChange(value)}
              className={`flex-1 py-1 rounded text-[11px] font-medium transition-colors border ${
                effectiveEffort === value
                  ? 'bg-accent text-white border-accent'
                  : 'bg-[var(--bg)] text-muted border-border hover:border-accent/40 hover:text-[var(--text)]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Extended thinking toggle */}
      <label className="flex items-center gap-3 cursor-pointer py-0.5">
        <div className="relative flex items-center justify-center shrink-0">
          <input
            type="checkbox"
            checked={thinkingEnabled}
            onChange={(e) => active && onThinkingEnabledChange(e.target.checked)}
            className="peer sr-only"
          />
          <div className="w-8 h-[18px] rounded-full bg-[var(--border)] peer-checked:bg-accent transition-colors" />
          <div className="absolute left-0.5 top-0.5 w-3.5 h-3.5 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-[14px]" />
        </div>
        <span className="text-xs font-medium text-[var(--text)]">Extended thinking</span>
        {thinkingEnabled && active && (() => {
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
