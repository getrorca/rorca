import { useState, useEffect, useRef, useCallback } from 'react';

export type GenerationStage = 'analyzing' | 'context' | 'generating' | 'validating';

interface StageConfig {
  id: GenerationStage;
  label: string;
  icon: React.ReactNode;
}

const STAGES: StageConfig[] = [
  {
    id: 'analyzing',
    label: 'Analyzing Brief',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
      </svg>
    ),
  },
  {
    id: 'context',
    label: 'Building Context',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
        <path strokeLinecap="round" strokeLinejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
      </svg>
    ),
  },
  {
    id: 'generating',
    label: 'Generating Stories',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
        <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
      </svg>
    ),
  },
  {
    id: 'validating',
    label: 'Validating Output',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
];

// Simulated stage durations (ms) — transitions happen at these offsets
const STAGE_TRANSITIONS: Record<GenerationStage, number> = {
  analyzing: 0,
  context: 2500,
  generating: 6000,
  validating: 0, // set dynamically when generation completes
};

function formatElapsed(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="w-4 h-4 text-green-400">
    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
  </svg>
);

interface SpecForgeProgressProps {
  isActive: boolean;
  onCancel: () => void;
  error: string | null;
  /** Signal that the API call has completed (success or fail) — triggers validating stage */
  apiDone: boolean;
}

export default function SpecForgeProgress({ isActive, onCancel, error, apiDone }: SpecForgeProgressProps) {
  const [currentStage, setCurrentStage] = useState<GenerationStage>('analyzing');
  const [stageStartTimes, setStageStartTimes] = useState<Record<string, number>>({});
  const [elapsed, setElapsed] = useState<Record<string, number>>({});
  const startTimeRef = useRef(Date.now());
  const timerRef = useRef<ReturnType<typeof setInterval>>();

  // Reset on activation
  useEffect(() => {
    if (!isActive) return;
    const now = Date.now();
    startTimeRef.current = now;
    setCurrentStage('analyzing');
    setStageStartTimes({ analyzing: now });
    setElapsed({});
  }, [isActive]);

  // Tick elapsed times
  useEffect(() => {
    if (!isActive) return;
    timerRef.current = setInterval(() => {
      const now = Date.now();
      setElapsed((prev) => {
        const next = { ...prev };
        // Update current stage elapsed
        for (const [stage, start] of Object.entries(stageStartTimes)) {
          if (stage === currentStage) {
            next[stage] = now - start;
          }
        }
        return next;
      });
    }, 200);
    return () => clearInterval(timerRef.current);
  }, [isActive, currentStage, stageStartTimes]);

  // Advance through simulated stages based on elapsed time
  const advanceStage = useCallback((toStage: GenerationStage) => {
    setCurrentStage((prev) => {
      if (prev === toStage) return prev;
      const prevIdx = STAGES.findIndex((s) => s.id === prev);
      const nextIdx = STAGES.findIndex((s) => s.id === toStage);
      if (nextIdx <= prevIdx) return prev;
      // Freeze previous stage elapsed
      const now = Date.now();
      setStageStartTimes((st) => {
        const updated = { ...st };
        if (!updated[toStage]) updated[toStage] = now;
        return updated;
      });
      setElapsed((el) => {
        const updated = { ...el };
        if (stageStartTimes[prev]) {
          updated[prev] = now - stageStartTimes[prev];
        }
        return updated;
      });
      return toStage;
    });
  }, [stageStartTimes]);

  // Timer-based stage transitions (simulated)
  useEffect(() => {
    if (!isActive) return;
    const t1 = setTimeout(() => advanceStage('context'), STAGE_TRANSITIONS.context);
    const t2 = setTimeout(() => advanceStage('generating'), STAGE_TRANSITIONS.generating);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [isActive, advanceStage]);

  // When API call completes, jump to validating
  useEffect(() => {
    if (apiDone && isActive && currentStage !== 'validating') {
      advanceStage('validating');
    }
  }, [apiDone, isActive, currentStage, advanceStage]);

  if (!isActive && !error) return null;

  const currentIdx = STAGES.findIndex((s) => s.id === currentStage);

  return (
    <div className="space-y-3">
      <div
        className="rounded-lg border border-border bg-panel/50 overflow-hidden"
        role="progressbar"
        aria-valuenow={currentIdx + 1}
        aria-valuemin={1}
        aria-valuemax={STAGES.length}
        aria-valuetext={`${STAGES[currentIdx]?.label ?? 'Processing'} (step ${currentIdx + 1} of ${STAGES.length})`}
        aria-label="Spec generation progress"
      >
        {STAGES.map((stage, idx) => {
          const isCompleted = idx < currentIdx || (apiDone && !error);
          const isCurrent = idx === currentIdx && !apiDone;
          const isPending = idx > currentIdx;
          const stageElapsed = elapsed[stage.id] ?? 0;

          return (
            <div
              key={stage.id}
              className={`flex items-center gap-3 px-4 py-2.5 transition-all duration-300 ${
                idx > 0 ? 'border-t border-border/50' : ''
              } ${isCurrent ? 'bg-accent/5' : ''}`}
            >
              {/* Icon */}
              <div className={`shrink-0 transition-all duration-300 ${
                isCompleted
                  ? 'text-green-400'
                  : isCurrent
                    ? 'text-accent animate-pulse'
                    : 'text-muted/30'
              }`}>
                {isCompleted ? <CheckIcon /> : stage.icon}
              </div>

              {/* Label */}
              <span className={`text-sm flex-1 transition-colors duration-300 ${
                isCompleted
                  ? 'text-muted'
                  : isCurrent
                    ? 'text-text font-medium'
                    : 'text-muted/40'
              }`}>
                {stage.label}
              </span>

              {/* Elapsed time */}
              {(isCurrent || isCompleted) && stageElapsed > 0 && (
                <span className={`text-xs tabular-nums ${
                  isCurrent ? 'text-accent' : 'text-muted/50'
                }`}>
                  {formatElapsed(stageElapsed)}
                </span>
              )}

              {/* Pulse dot for current */}
              {isCurrent && (
                <span className="relative flex h-2 w-2 shrink-0">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-accent" />
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Error state */}
      {error && (
        <div className="px-3 py-2.5 rounded border border-error/30 bg-error/5 text-xs text-error space-y-1.5">
          <div className="font-medium">Generation failed</div>
          <div className="text-error/80">{error}</div>
        </div>
      )}

      {/* Cancel button */}
      {isActive && !error && (
        <button
          onClick={onCancel}
          className="w-full py-2 rounded text-sm font-medium text-muted hover:text-text border border-border hover:border-muted transition-colors cursor-pointer"
        >
          Cancel
        </button>
      )}
    </div>
  );
}
