import { useState, useEffect, useRef, useCallback } from 'react';

export type GenerationStage = 'analyzing' | 'context' | 'generating' | 'validating';

interface StageConfig {
  id: string;
  label: string;
  icon: React.ReactNode;
}

// Icons reused across modes
const SearchIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
    <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
  </svg>
);
const BoxIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
    <path strokeLinecap="round" strokeLinejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
  </svg>
);
const BoltIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
    <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
  </svg>
);
const CheckCircleIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
);
const PenIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
    <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
  </svg>
);
const EyeIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
  </svg>
);
const ShieldIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
  </svg>
);
const ClipboardCheckIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
  </svg>
);

// Single-pass simulated stages (legacy)
const SINGLE_PASS_STAGES: StageConfig[] = [
  { id: 'analyzing', label: 'Analyzing Brief', icon: SearchIcon },
  { id: 'context', label: 'Building Context', icon: BoxIcon },
  { id: 'generating', label: 'Generating Stories', icon: BoltIcon },
  { id: 'validating', label: 'Validating Output', icon: CheckCircleIcon },
];

// Multi-pass 6-stage pipeline
const MULTI_PASS_STAGES: StageConfig[] = [
  { id: 'pass1', label: 'Pass 1: PM Agent', icon: SearchIcon },
  { id: 'pass2', label: 'Pass 2: Spec Writer', icon: PenIcon },
  { id: 'pass3', label: 'Pass 3: UX Designer', icon: EyeIcon },
  { id: 'pass4', label: 'Pass 4: Best Practices', icon: BoxIcon },
  { id: 'pass5', label: 'Pass 5: Adversarial Review', icon: ShieldIcon },
  { id: 'pass6', label: 'Pass 6: Spec Verifier', icon: ClipboardCheckIcon },
];

const STAGE_TRANSITIONS: Record<GenerationStage, number> = {
  analyzing: 0,
  context: 2500,
  generating: 6000,
  validating: 0,
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
  /** When true, shows 6-pass pipeline stages driven by SSE events */
  multiPass?: boolean;
  /** Spec slug for SSE event filtering in multi-pass mode */
  specSlug?: string;
}

export default function SpecForgeProgress({ isActive, onCancel, error, apiDone, multiPass, specSlug }: SpecForgeProgressProps) {
  const stages = multiPass ? MULTI_PASS_STAGES : SINGLE_PASS_STAGES;

  // Single-pass: simulated index-based stage tracking
  const [currentStage, setCurrentStage] = useState<string>(stages[0].id);
  const [stageStartTimes, setStageStartTimes] = useState<Record<string, number>>({});
  const [elapsed, setElapsed] = useState<Record<string, number>>({});
  const [completedPasses, setCompletedPasses] = useState<Set<string>>(new Set());
  const startTimeRef = useRef(Date.now());
  const timerRef = useRef<ReturnType<typeof setInterval>>();
  const sseRef = useRef<EventSource | null>(null);

  // Reset on activation
  useEffect(() => {
    if (!isActive) return;
    const now = Date.now();
    startTimeRef.current = now;
    setCurrentStage(stages[0].id);
    setStageStartTimes({ [stages[0].id]: now });
    setElapsed({});
    setCompletedPasses(new Set());
  }, [isActive, stages]);

  // Multi-pass: listen to SSE events for real pass progress
  useEffect(() => {
    if (!isActive || !multiPass) return;

    const es = new EventSource('/api/pipeline/stream');
    sseRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.event_type !== 'spec_generation_pass') return;

        const payload = typeof data.payload === 'string' ? JSON.parse(data.payload) : data.payload;
        const passNum = payload.pass;
        const status = payload.status;

        // Filter by spec slug if available
        if (specSlug && data.spec_id && data.spec_id !== specSlug) return;

        const passId = `pass${passNum}`;

        if (status === 'started') {
          const now = Date.now();
          setCurrentStage(passId);
          setStageStartTimes((prev) => ({ ...prev, [passId]: now }));
        } else if (status === 'completed') {
          const now = Date.now();
          setCompletedPasses((prev) => new Set([...prev, passId]));
          setStageStartTimes((prev) => {
            const startTime = prev[passId];
            if (startTime) {
              setElapsed((el) => ({ ...el, [passId]: now - startTime }));
            }
            return prev;
          });
        }
      } catch {
        // Ignore parse errors from non-JSON SSE data (heartbeats, etc.)
      }
    };

    return () => {
      es.close();
      sseRef.current = null;
    };
  }, [isActive, multiPass, specSlug]);

  // Tick elapsed times
  useEffect(() => {
    if (!isActive) return;
    timerRef.current = setInterval(() => {
      const now = Date.now();
      setElapsed((prev) => {
        const next = { ...prev };
        const startTime = stageStartTimes[currentStage];
        if (startTime && !completedPasses.has(currentStage)) {
          next[currentStage] = now - startTime;
        }
        return next;
      });
    }, 200);
    return () => clearInterval(timerRef.current);
  }, [isActive, currentStage, stageStartTimes, completedPasses]);

  // Single-pass: simulated stage advancement
  const advanceStage = useCallback((toStage: string) => {
    if (multiPass) return; // Multi-pass advances via SSE, not timers
    setCurrentStage((prev) => {
      const prevIdx = stages.findIndex((s) => s.id === prev);
      const nextIdx = stages.findIndex((s) => s.id === toStage);
      if (nextIdx <= prevIdx) return prev;
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
  }, [multiPass, stages, stageStartTimes]);

  // Single-pass: timer-based transitions
  useEffect(() => {
    if (!isActive || multiPass) return;
    const t1 = setTimeout(() => advanceStage('context'), STAGE_TRANSITIONS.context);
    const t2 = setTimeout(() => advanceStage('generating'), STAGE_TRANSITIONS.generating);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [isActive, multiPass, advanceStage]);

  // When API call completes (single-pass: jump to validating; multi-pass: mark all done)
  useEffect(() => {
    if (!apiDone || !isActive) return;
    if (!multiPass) {
      advanceStage('validating');
    }
  }, [apiDone, isActive, multiPass, advanceStage]);

  if (!isActive && !error) return null;

  const currentIdx = stages.findIndex((s) => s.id === currentStage);

  return (
    <div className="space-y-3">
      {multiPass && (
        <div className="text-xs text-accent font-medium px-1">6-Pass Pipeline</div>
      )}
      <div
        className="rounded-lg border border-border bg-panel/50 overflow-hidden"
        role="progressbar"
        aria-valuenow={currentIdx + 1}
        aria-valuemin={1}
        aria-valuemax={stages.length}
        aria-valuetext={`${stages[currentIdx]?.label ?? 'Processing'} (step ${currentIdx + 1} of ${stages.length})`}
        aria-label="Spec generation progress"
      >
        {stages.map((stage, idx) => {
          const isCompleted = multiPass
            ? completedPasses.has(stage.id) || (apiDone && !error)
            : idx < currentIdx || (apiDone && !error);
          const isCurrent = multiPass
            ? stage.id === currentStage && !completedPasses.has(stage.id) && !apiDone
            : idx === currentIdx && !apiDone;
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
