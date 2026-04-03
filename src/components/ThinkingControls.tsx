import { Brain } from 'lucide-react';

export type EffortLevel = 'low' | 'medium' | 'high';

export interface ThinkingControlsProps {
  /** Current agent engine type */
  engine: 'claude' | 'opencode' | 'codex' | null;
  /** Current model string (e.g. 'claude-opus-4-6', 'claude-sonnet-4-5-...') */
  model: string | null;
  /** Effort level selection */
  effortLevel: EffortLevel;
  onEffortChange: (level: EffortLevel) => void;
  /** Whether extended thinking is enabled */
  thinkingEnabled: boolean;
  onThinkingEnabledChange: (enabled: boolean) => void;
  /** Thinking budget in tokens (only relevant when thinkingEnabled=true) */
  thinkingBudget: number;
  onThinkingBudgetChange: (budget: number) => void;
}

const EFFORT_LEVELS: { value: EffortLevel; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

const BUDGET_STEPS = [1000, 5000, 10000, 25000, 50000];

function formatBudgetLabel(tokens: number): string {
  if (tokens >= 1000) return `${tokens / 1000}K tokens`;
  return `${tokens} tokens`;
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
  thinkingBudget,
  onThinkingBudgetChange,
}: ThinkingControlsProps) {
  const active = isClaudeOpusOrSonnet(engine, model);
  const disabledClass = !active ? 'opacity-50 pointer-events-none' : '';

  const currentBudgetIndex = BUDGET_STEPS.indexOf(thinkingBudget);
  const sliderIndex = currentBudgetIndex >= 0 ? currentBudgetIndex : 1; // default to 5K

  return (
    <div className={`space-y-3 ${disabledClass}`}>
      {/* Section header */}
      <div className="flex items-center gap-1.5">
        <Brain size={12} className="text-muted shrink-0" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">Thinking</span>
        {!active && engine === 'claude' && (
          <span className="text-[9px] text-muted/60 italic ml-1">Haiku only — not available</span>
        )}
        {!active && engine !== 'claude' && (
          <span className="text-[9px] text-muted/60 italic ml-1">Claude only</span>
        )}
      </div>

      {/* Effort segmented control */}
      <div>
        <span className="block text-[10px] text-muted mb-1.5">Effort</span>
        <div className="flex gap-1">
          {EFFORT_LEVELS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              onClick={() => active && onEffortChange(value)}
              className={`flex-1 py-1 rounded text-[11px] font-medium transition-colors border ${
                effortLevel === value
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
      </label>

      {/* Thinking budget slider — only shown when thinkingEnabled */}
      {thinkingEnabled && (
        <div className="ml-11">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] text-muted">Budget</span>
            <span className="text-[10px] font-mono text-[var(--text)] tabular-nums">
              {formatBudgetLabel(BUDGET_STEPS[sliderIndex])}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={BUDGET_STEPS.length - 1}
            step={1}
            value={sliderIndex}
            onChange={(e) => {
              const idx = parseInt(e.target.value, 10);
              onThinkingBudgetChange(BUDGET_STEPS[idx]);
            }}
            className="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-accent bg-border"
          />
          <div className="flex justify-between mt-1">
            {BUDGET_STEPS.map((step) => (
              <span key={step} className="text-[9px] text-muted/60 tabular-nums">
                {step >= 1000 ? `${step / 1000}K` : step}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
