export type EngineValue = 'claude' | 'opencode' | 'codex';

export interface EngineStatus {
  claudeAvailable?: boolean;
  opencodeAvailable?: boolean;
  codexAvailable?: boolean;
}

interface EngineSelectorProps {
  value: EngineValue;
  onChange: (engine: EngineValue) => void;
  engineStatus?: EngineStatus;
}

interface Pill {
  value: EngineValue;
  label: string;
  available: boolean;
}

export function EngineSelector({ value, onChange, engineStatus }: EngineSelectorProps) {
  const pills: Pill[] = [
    {
      value: 'claude',
      label: 'Claude (Sub)',
      available: engineStatus?.claudeAvailable ?? false,
    },
    {
      value: 'opencode',
      label: 'OpenCode (API)',
      available: engineStatus?.opencodeAvailable ?? false,
    },
    {
      value: 'codex',
      label: 'Codex (Sub)',
      available: engineStatus?.codexAvailable ?? false,
    },
  ];

  return (
    <div
      role="group"
      aria-label="Execution engine"
      className="inline-flex rounded-lg border border-[var(--border)] bg-[var(--surface-200)] p-0.5 gap-0.5"
    >
      {pills.map((pill) => {
        const isActive = value === pill.value;
        return (
          <button
            key={pill.value}
            type="button"
            role="radio"
            aria-checked={isActive}
            onClick={() => onChange(pill.value)}
            className={[
              'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-border)]',
              isActive
                ? 'bg-[var(--accent)] text-white shadow-sm'
                : 'text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--border)]',
            ].join(' ')}
          >
            <span
              aria-hidden="true"
              className={[
                'inline-block h-1.5 w-1.5 rounded-full shrink-0',
                pill.available ? 'bg-[var(--success)]' : 'bg-[var(--text-muted)]',
              ].join(' ')}
            />
            {pill.label}
          </button>
        );
      })}
    </div>
  );
}
