import { useState, useEffect, useRef, useCallback } from 'react';
import { useWalSSE } from '../hooks/useWalSSE';

export type GenerationStage = 'analyzing' | 'context' | 'generating' | 'validating';

export type SpecErrorCategory =
  | 'model_error'
  | 'api_key_error'
  | 'rate_limit'
  | 'context_too_large'
  | 'timeout'
  | 'parse_error'
  | 'network_error'
  | 'unknown';

export interface SpecGenerationError {
  message: string;
  category?: SpecErrorCategory;
  model?: string;
  provider?: string;
  suggestion?: string;
  rawResponse?: string;
  contextSummary?: Record<string, unknown>;
}

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

// ─── Error category display config ──────────────────────────────────────────

interface ErrorCategoryConfig {
  label: string;
  icon: React.ReactNode;
}

const ErrorCategoryIcon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
    <path strokeLinecap="round" strokeLinejoin="round" d={d} />
  </svg>
);

const ERROR_CATEGORY_CONFIG: Record<SpecErrorCategory, ErrorCategoryConfig> = {
  model_error: {
    label: 'Model Error',
    icon: <ErrorCategoryIcon d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />,
  },
  api_key_error: {
    label: 'API Key Error',
    icon: <ErrorCategoryIcon d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />,
  },
  rate_limit: {
    label: 'Rate Limit',
    icon: <ErrorCategoryIcon d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />,
  },
  context_too_large: {
    label: 'Context Too Large',
    icon: <ErrorCategoryIcon d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />,
  },
  timeout: {
    label: 'Timeout',
    icon: <ErrorCategoryIcon d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />,
  },
  parse_error: {
    label: 'Parse Error',
    icon: <ErrorCategoryIcon d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />,
  },
  network_error: {
    label: 'Network Error',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
        <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 5.636a9 9 0 010 12.728m0 0l-2.829-2.829m2.829 2.829L21 21M15.536 8.464a5 5 0 010 7.072m0 0l-2.829-2.829m-4.243 2.829a5 5 0 01-1.414-3.536" />
        <line x1="4" y1="4" x2="20" y2="20" strokeLinecap="round" />
      </svg>
    ),
  },
  unknown: {
    label: 'Error',
    icon: <ErrorCategoryIcon d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />,
  },
};

// ─── Structured Error Card ──────────────────────────────────────────────────

function SpecErrorCard({
  error,
  onRetry,
  onRetryWithModel,
}: {
  error: SpecGenerationError;
  onRetry?: () => void;
  onRetryWithModel?: () => void;
}) {
  const [rawExpanded, setRawExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const category = error.category || 'unknown';
  const config = ERROR_CATEGORY_CONFIG[category];

  const handleCopy = async () => {
    const details = [
      `Category: ${config.label}`,
      `Error: ${error.message}`,
      error.model ? `Model: ${error.model}` : null,
      error.provider ? `Provider: ${error.provider}` : null,
      error.suggestion ? `Suggestion: ${error.suggestion}` : null,
      error.rawResponse ? `\nRaw response (first 500 chars):\n${error.rawResponse}` : null,
    ].filter(Boolean).join('\n');

    try {
      await navigator.clipboard.writeText(details);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API not available
    }
  };

  return (
    <div className="rounded-lg border border-error/30 bg-error/5 overflow-hidden">
      {/* Header: category + icon */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-error/15">
        <div className="text-error shrink-0">{config.icon}</div>
        <span className="text-sm font-semibold text-error">{config.label}</span>
        {error.model && (
          <span className="ml-auto text-xs text-muted bg-surface px-1.5 py-0.5 rounded font-mono">
            {error.model}
          </span>
        )}
      </div>

      <div className="px-3 py-2.5 space-y-2.5">
        {/* Raw error message */}
        <div className="text-xs font-mono text-error/80 bg-error/5 rounded px-2 py-1.5 max-h-24 overflow-y-auto break-all whitespace-pre-wrap">
          {error.message}
        </div>

        {/* Model + Provider info */}
        {(error.model || error.provider) && (
          <div className="flex gap-3 text-xs text-muted">
            {error.provider && (
              <span>Provider: <span className="text-text font-medium">{error.provider}</span></span>
            )}
          </div>
        )}

        {/* Suggestion */}
        {error.suggestion && (
          <div className="flex gap-2 text-xs bg-accent/5 border border-accent/15 rounded px-2.5 py-2">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-3.5 h-3.5 text-accent shrink-0 mt-0.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
            </svg>
            <span className="text-text/80">{error.suggestion}</span>
          </div>
        )}

        {/* Context summary (if available) */}
        {error.contextSummary && (
          <div className="text-xs text-muted space-y-0.5">
            <span className="font-medium text-text/60">Context injected:</span>
            <div className="flex flex-wrap gap-x-3 gap-y-0.5">
              {(error.contextSummary as any).estimatedTokens != null && (
                <span>~{Math.round(((error.contextSummary as any).estimatedTokens) / 1000)}K tokens</span>
              )}
              {(error.contextSummary as any).skills?.length > 0 && (
                <span>{(error.contextSummary as any).skills.length} skills</span>
              )}
              {(error.contextSummary as any).memoryEntries > 0 && (
                <span>{(error.contextSummary as any).memoryEntries} memory entries</span>
              )}
              {(error.contextSummary as any).agentsMd && <span>AGENTS.md</span>}
            </div>
          </div>
        )}

        {/* Parse error: show raw LLM output */}
        {category === 'parse_error' && error.rawResponse && (
          <div>
            <button
              onClick={() => setRawExpanded(!rawExpanded)}
              className="text-xs text-muted hover:text-text flex items-center gap-1 cursor-pointer"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={`w-3 h-3 transition-transform ${rawExpanded ? 'rotate-90' : ''}`}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
              Raw LLM response ({error.rawResponse.length} chars)
            </button>
            {rawExpanded && (
              <div className="mt-1 text-xs font-mono text-muted/70 bg-surface rounded px-2 py-1.5 max-h-32 overflow-y-auto whitespace-pre-wrap break-all">
                {error.rawResponse}
              </div>
            )}
          </div>
        )}

        {/* Action buttons */}
        <div className="flex gap-2 pt-1">
          {onRetry && (
            <button
              onClick={onRetry}
              className="flex-1 py-1.5 rounded text-xs font-medium bg-accent text-white hover:bg-accent-hover transition-colors cursor-pointer"
            >
              Retry with same settings
            </button>
          )}
          {onRetryWithModel && (
            <button
              onClick={onRetryWithModel}
              className="flex-1 py-1.5 rounded text-xs font-medium text-muted hover:text-text border border-border hover:border-muted transition-colors cursor-pointer"
            >
              Try different model
            </button>
          )}
          <button
            onClick={handleCopy}
            className="px-2 py-1.5 rounded text-xs text-muted hover:text-text border border-border hover:border-muted transition-colors cursor-pointer"
            title="Copy error details"
          >
            {copied ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-3.5 h-3.5 text-green-400">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-3.5 h-3.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

interface AttachmentStep {
  filename: string;
  status: 'extracting_text' | 'complete';
}

interface SpecForgeProgressProps {
  isActive: boolean;
  onCancel: () => void;
  error: SpecGenerationError | null;
  /** Signal that the API call has completed (success or fail) — triggers validating stage */
  apiDone: boolean;
  /** When true, shows 6-pass pipeline stages driven by SSE events */
  multiPass?: boolean;
  /** Spec slug for SSE event filtering in multi-pass mode */
  specSlug?: string;
  /** Retry with same settings */
  onRetry?: () => void;
  /** Open model picker for retry with different model */
  onRetryWithModel?: () => void;
  /** Model used for generation (displayed as badge) */
  model?: string;
  /** Provider used for generation */
  provider?: string;
  /** When true, shows attachment processing steps before generating */
  hasAttachments?: boolean;
}

export default function SpecForgeProgress({ isActive, onCancel, error, apiDone, multiPass, specSlug, onRetry, onRetryWithModel, model, provider, hasAttachments }: SpecForgeProgressProps) {
  const stages = multiPass ? MULTI_PASS_STAGES : SINGLE_PASS_STAGES;

  // Single-pass: simulated index-based stage tracking
  const [currentStage, setCurrentStage] = useState<string>(stages[0].id);
  const [stageStartTimes, setStageStartTimes] = useState<Record<string, number>>({});
  const [elapsed, setElapsed] = useState<Record<string, number>>({});
  const [completedPasses, setCompletedPasses] = useState<Set<string>>(new Set());
  const [totalElapsed, setTotalElapsed] = useState(0);
  const startTimeRef = useRef(Date.now());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const _sseRef = useRef<EventSource | null>(null);

  // Attachment processing steps (populated via SSE)
  const [attachmentSteps, setAttachmentSteps] = useState<AttachmentStep[]>([]);

  // Reset on activation
  useEffect(() => {
    if (!isActive) return;
    const now = Date.now();
    startTimeRef.current = now;
    setCurrentStage(stages[0].id);
    setStageStartTimes({ [stages[0].id]: now });
    setElapsed({});
    setCompletedPasses(new Set());
    setAttachmentSteps([]);
  }, [isActive, stages]);

  // Listen to SSE events for attachment processing and multi-pass progress
  useWalSSE((event) => {
    // Handle attachment_processing events (single-pass and multi-pass)
    if (isActive && event.event_type === 'attachment_processing') {
      try {
        const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
        const filename = payload.filename as string;
        const status = payload.status as 'extracting_text' | 'complete';
        if (specSlug && event.spec_id && event.spec_id !== specSlug) return;
        setAttachmentSteps((prev) => {
          const idx = prev.findIndex((s) => s.filename === filename);
          if (idx >= 0) {
            const updated = [...prev];
            updated[idx] = { filename, status };
            return updated;
          }
          return [...prev, { filename, status }];
        });
      } catch {
        // Ignore parse errors
      }
    }

    if (!isActive || !multiPass) return;
    if (event.event_type !== 'spec_generation_pass') return;

    try {
      const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
      const passNum = payload.pass;
      const status = payload.status;

      // Filter by spec slug if available
      if (specSlug && event.spec_id && event.spec_id !== specSlug) return;

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
      // Ignore parse errors
    }
  });

  // Tick elapsed times + total wall clock
  useEffect(() => {
    if (!isActive) return;
    timerRef.current = setInterval(() => {
      const now = Date.now();
      setTotalElapsed(now - startTimeRef.current);
      setElapsed((prev) => {
        const next = { ...prev };
        const startTime = stageStartTimes[currentStage];
        if (startTime && !completedPasses.has(currentStage)) {
          next[currentStage] = now - startTime;
        }
        return next;
      });
    }, 200);
    return () => clearInterval(timerRef.current ?? undefined);
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

  // Single-pass: advance to 'context' immediately (context assembly is synchronous on the backend),
  // then to 'generating' 2s later (LLM is now processing). No fake delays.
  useEffect(() => {
    if (!isActive || multiPass) return;
    // Context assembly happens instantly on backend — advance right away
    advanceStage('context');
    // After 2s the LLM is processing — this is a real minimum (POST fires, backend assembles context ~instantly)
    const t = setTimeout(() => advanceStage('generating'), 2000);
    return () => clearTimeout(t);
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

  const totalSecs = Math.floor(totalElapsed / 1000);

  return (
    <div className="space-y-3">
      {/* Header: model badge + elapsed time */}
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-2">
          {multiPass && (
            <span className="text-xs text-accent font-medium">6-Pass Pipeline</span>
          )}
          {model && (
            <span className="inline-flex items-center gap-1.5 text-xs bg-surface border border-border rounded-full px-2.5 py-0.5">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-3 h-3 text-accent">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
              <span className="font-medium text-text">{model}</span>
              {provider && <span className="text-muted">({provider})</span>}
            </span>
          )}
        </div>
        {isActive && (
          <span className="text-xs font-mono tabular-nums text-muted">
            {formatElapsed(totalElapsed)}
          </span>
        )}
      </div>

      {/* Attachment processing steps — shown when attachments exist */}
      {(hasAttachments || attachmentSteps.length > 0) && (
        <div className="rounded-lg border border-border bg-panel/50 overflow-hidden">
          <div className="flex items-center gap-3 px-4 py-2 border-b border-border/50">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4 shrink-0 text-muted">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
            </svg>
            <span className="text-xs font-medium text-muted">Processing attachments</span>
          </div>
          {attachmentSteps.length === 0 ? (
            <div className="flex items-center gap-3 px-4 py-2.5">
              <span className="relative flex h-2 w-2 shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-accent" />
              </span>
              <span className="text-sm text-text font-medium">Preparing attachments...</span>
            </div>
          ) : (
            attachmentSteps.map((step) => {
              const isDone = step.status === 'complete';
              return (
                <div key={step.filename} className="flex items-center gap-3 px-4 py-2 border-t border-border/50 first:border-t-0">
                  <div className={`shrink-0 ${isDone ? 'text-green-400' : 'text-accent animate-pulse'}`}>
                    {isDone ? <CheckIcon /> : (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                    )}
                  </div>
                  <span className={`text-sm flex-1 truncate ${isDone ? 'text-muted' : 'text-text font-medium'}`}>
                    {isDone ? step.filename : `Extracting text from ${step.filename}...`}
                  </span>
                  {isDone && (
                    <span className="text-xs text-muted/50">Complete</span>
                  )}
                </div>
              );
            })
          )}
        </div>
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

              {/* Label — show model name in "Generating" stage */}
              <span className={`text-sm flex-1 transition-colors duration-300 ${
                isCompleted
                  ? 'text-muted'
                  : isCurrent
                    ? 'text-text font-medium'
                    : 'text-muted/40'
              }`}>
                {stage.id === 'generating' && model ? `Calling ${model}...` : stage.label}
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

      {/* Indeterminate progress bar when generating */}
      {isActive && currentStage === 'generating' && !apiDone && (
        <div className="h-0.5 w-full bg-border/30 rounded-full overflow-hidden">
          <div className="h-full w-1/3 bg-accent rounded-full animate-[shimmer_1.5s_ease-in-out_infinite]"
            style={{ animation: 'shimmer 1.5s ease-in-out infinite' }}
          />
          <style>{`@keyframes shimmer { 0% { transform: translateX(-100%); } 100% { transform: translateX(400%); } }`}</style>
        </div>
      )}

      {/* Reassurance messages for long generations */}
      {isActive && !error && totalSecs > 90 && totalSecs <= 180 && (
        <p className="text-xs text-muted px-1">Complex specs take longer — still working...</p>
      )}
      {isActive && !error && totalSecs > 180 && (
        <p className="text-xs text-amber-400 px-1">This is taking unusually long. You can cancel and retry with a simpler brief.</p>
      )}

      {/* Error state — structured error card */}
      {error && (
        <SpecErrorCard
          error={error}
          onRetry={onRetry}
          onRetryWithModel={onRetryWithModel}
        />
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
