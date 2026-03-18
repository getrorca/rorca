import { useEffect, useRef, useState } from 'react';
import AnsiToHtml from 'ansi-to-html';
import {
  Terminal as TerminalIcon, Layers, CheckCircle2, XCircle,
  FileText, Pencil, Brain, GitCommitHorizontal, Search, Hash, AlertCircle,
  Loader2,
} from 'lucide-react';
import { useTheme } from '../contexts/ThemeContext';
import { BASE_URL } from '../lib/apiFetch';

// ─── Types ───────────────────────────────────────────────────────────────────

export type StoryPaneStatus = 'running' | 'passed' | 'failed' | 'waiting';

interface MiniTerminalPaneProps {
  runId: number;
  storyId: string;
  storyTitle: string;
  status: StoryPaneStatus;
}

interface SemanticStep {
  type: 'read' | 'write' | 'edit' | 'bash' | 'plan' | 'commit' | 'test' | 'search' | 'unknown';
  label: string;
  detail?: string;
  ts: string;
}

const STEP_CONFIG: Record<SemanticStep['type'], { icon: typeof FileText; color: string }> = {
  read:    { icon: FileText,            color: 'text-blue-400' },
  write:   { icon: Pencil,              color: 'text-emerald-400' },
  edit:    { icon: Pencil,              color: 'text-emerald-400' },
  bash:    { icon: TerminalIcon,        color: 'text-amber-400' },
  plan:    { icon: Brain,               color: 'text-purple-400' },
  commit:  { icon: GitCommitHorizontal, color: 'text-cyan-400' },
  test:    { icon: Hash,                color: 'text-teal-400' },
  search:  { icon: Search,              color: 'text-orange-400' },
  unknown: { icon: AlertCircle,         color: 'text-gray-400' },
};

// ─── Theme colors ────────────────────────────────────────────────────────────

const darkTheme = {
  background: '#0d0d0d',
  foreground: '#d4d4d4',
};

const lightTheme = {
  background: '#f5f5f5',
  foreground: '#1e1e1e',
};

// ─── ANSI converter singleton ────────────────────────────────────────────────

const ansiConverter = new AnsiToHtml({
  fg: '#d4d4d4',
  bg: '#0d0d0d',
  escapeXML: true,
  newline: true,
});

// ─── Component ───────────────────────────────────────────────────────────────

export default function MiniTerminalPane({ runId, storyId, storyTitle, status }: MiniTerminalPaneProps) {
  const preRef = useRef<HTMLPreElement>(null);
  const esRef = useRef<EventSource | null>(null);
  const autoScrollRef = useRef(true);
  const { resolved } = useTheme();

  const [mode, setMode] = useState<'raw' | 'semantic'>('raw');
  const [steps, setSteps] = useState<SemanticStep[]>([]);
  const [streamDone, setStreamDone] = useState(false);
  const stepListRef = useRef<HTMLDivElement>(null);

  // Auto-scroll semantic list
  useEffect(() => {
    if (mode === 'semantic' && stepListRef.current) {
      stepListRef.current.scrollTop = stepListRef.current.scrollHeight;
    }
  }, [steps, mode]);

  // SSE setup — streams output and renders to <pre> via ansi-to-html
  useEffect(() => {
    if (status === 'waiting') return;

    esRef.current?.close();
    if (preRef.current) preRef.current.innerHTML = '';

    const converter = resolved === 'light'
      ? new AnsiToHtml({ fg: lightTheme.foreground, bg: lightTheme.background, escapeXML: true, newline: true })
      : ansiConverter;

    // Connect to per-story log stream
    const es = new EventSource(`${BASE_URL}/api/pipeline/runs/${runId}/stories/${storyId}/log`);
    esRef.current = es;

    es.addEventListener('chunk', (e: MessageEvent) => {
      try {
        const binary = atob(e.data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const text = new TextDecoder().decode(bytes);
        if (preRef.current) {
          preRef.current.innerHTML += converter.toHtml(text);
          if (autoScrollRef.current) {
            preRef.current.scrollTop = preRef.current.scrollHeight;
          }
        }
      } catch { /* ignore malformed chunk */ }
    });

    es.addEventListener('semantic_step', (e: MessageEvent) => {
      try {
        const step: SemanticStep = JSON.parse(e.data);
        setSteps(prev => [...prev, step]);
      } catch { /* ignore */ }
    });

    es.addEventListener('done', () => {
      setStreamDone(true);
      es.close();
    });

    es.onerror = () => {
      setStreamDone(true);
      es.close();
    };

    return () => {
      es.close();
    };
  }, [runId, storyId, resolved, status]);

  // Track scroll position for auto-scroll
  const handlePreScroll = () => {
    const el = preRef.current;
    if (!el) return;
    autoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const statusBanner = status === 'passed' || status === 'failed';
  const themeColors = resolved === 'light' ? lightTheme : darkTheme;

  return (
    <div className="flex flex-col border border-[var(--border)] rounded-lg overflow-hidden bg-[var(--bg)] h-full">
      {/* ─── Header ─────────────────────────────────────────────────────── */}
      <div className="shrink-0 px-2 py-1.5 border-b border-[var(--border)] bg-[var(--surface)] flex items-center gap-2 min-h-[32px]">
        {/* Story ID badge */}
        <span className="px-1.5 py-0.5 text-[10px] font-mono font-semibold rounded bg-[var(--accent)]/15 text-[var(--accent)] shrink-0">
          {storyId}
        </span>
        {/* Story title (truncated) */}
        <span className="text-[11px] text-[var(--text)] truncate flex-1 min-w-0">
          {storyTitle}
        </span>
        {/* Raw/Semantic toggle */}
        {status !== 'waiting' && (
          <div className="flex items-center gap-0.5 shrink-0">
            <button
              onClick={() => setMode('raw')}
              className={`px-1.5 py-0.5 text-[10px] font-medium rounded transition-colors ${
                mode === 'raw' ? 'bg-[var(--accent)]/15 text-[var(--accent)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]'
              }`}
            >
              <TerminalIcon size={10} className="inline -mt-0.5 mr-0.5" />
              Raw
            </button>
            <button
              onClick={() => setMode('semantic')}
              className={`px-1.5 py-0.5 text-[10px] font-medium rounded transition-colors ${
                mode === 'semantic' ? 'bg-[var(--accent)]/15 text-[var(--accent)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]'
              }`}
            >
              <Layers size={10} className="inline -mt-0.5 mr-0.5" />
              Semantic
            </button>
          </div>
        )}
      </div>

      {/* ─── Content ────────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 relative">
        {/* Waiting state */}
        {status === 'waiting' && (
          <div className="h-full flex flex-col items-center justify-center gap-2 text-[var(--text-muted)]">
            <Loader2 size={16} className="animate-spin" />
            <span className="text-[11px]">Waiting for story to start...</span>
          </div>
        )}

        {/* Raw terminal — ansi-to-html rendered <pre> */}
        {status !== 'waiting' && (
          <pre
            ref={preRef}
            onScroll={handlePreScroll}
            className="h-full w-full overflow-auto font-mono text-[10px] leading-[1.2] whitespace-pre-wrap break-words"
            style={{
              background: themeColors.background,
              color: themeColors.foreground,
              padding: '4px 8px',
              margin: 0,
              display: mode === 'raw' ? 'block' : 'none',
              fontFamily: '"JetBrains Mono", "Cascadia Code", "SF Mono", Menlo, Monaco, monospace',
            }}
          />
        )}

        {/* Semantic step list */}
        {status !== 'waiting' && mode === 'semantic' && (
          <div className="h-full flex flex-col">
            {steps.length === 0 ? (
              <div className="flex-1 flex items-center justify-center text-[var(--text-muted)] text-[11px]">
                {streamDone ? 'No semantic data' : 'Waiting for events\u2026'}
              </div>
            ) : (
              <div ref={stepListRef} className="flex-1 overflow-y-auto overflow-x-hidden">
                {steps.map((step, i) => {
                  const cfg = STEP_CONFIG[step.type];
                  const Icon = cfg.icon;
                  return (
                    <div key={i} className="px-2 py-0.5 flex items-center gap-1.5 border-b border-[var(--border)]/30">
                      <Icon size={10} className={`shrink-0 ${cfg.color}`} />
                      <span className="text-[10px] text-[var(--text)] truncate flex-1 font-mono">
                        {step.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Status banner overlay */}
        {statusBanner && (
          <div className={`absolute bottom-0 left-0 right-0 px-3 py-1.5 flex items-center gap-2 text-[11px] font-semibold ${
            status === 'passed'
              ? 'bg-emerald-500/20 text-emerald-400 border-t border-emerald-500/30'
              : 'bg-red-500/20 text-red-400 border-t border-red-500/30'
          }`}>
            {status === 'passed' ? (
              <><CheckCircle2 size={12} /> PASSED</>
            ) : (
              <><XCircle size={12} /> FAILED</>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
