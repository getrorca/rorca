import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import {
  Terminal as TerminalIcon, Layers, CheckCircle2, XCircle,
  FileText, Pencil, Brain, GitCommitHorizontal, Search, Hash, AlertCircle,
  Loader2,
} from 'lucide-react';
import { useTheme } from '../contexts/ThemeContext';
import { BASE_URL } from '../lib/apiFetch';
import '@xterm/xterm/css/xterm.css';

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

// ─── xterm themes ────────────────────────────────────────────────────────────

const darkTheme = {
  background: '#0d0d0d',
  foreground: '#d4d4d4',
  cursor: '#d4d4d4',
  black: '#1e1e1e', brightBlack: '#808080',
  red: '#f44747', brightRed: '#f44747',
  green: '#4ec9b0', brightGreen: '#4ec9b0',
  yellow: '#dcdcaa', brightYellow: '#dcdcaa',
  blue: '#569cd6', brightBlue: '#9cdcfe',
  magenta: '#c586c0', brightMagenta: '#c586c0',
  cyan: '#9cdcfe', brightCyan: '#9cdcfe',
  white: '#d4d4d4', brightWhite: '#e6e6e6',
};

const lightTheme = {
  background: '#f5f5f5',
  foreground: '#1e1e1e',
  cursor: '#1e1e1e',
  black: '#1e1e1e', brightBlack: '#6e6e6e',
  red: '#cd3131', brightRed: '#cd3131',
  green: '#00873a', brightGreen: '#00873a',
  yellow: '#795e26', brightYellow: '#795e26',
  blue: '#0451a5', brightBlue: '#0451a5',
  magenta: '#af00db', brightMagenta: '#af00db',
  cyan: '#0598bc', brightCyan: '#0598bc',
  white: '#d4d4d4', brightWhite: '#1e1e1e',
};

// ─── Component ───────────────────────────────────────────────────────────────

export default function MiniTerminalPane({ runId, storyId, storyTitle, status }: MiniTerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const esRef = useRef<EventSource | null>(null);
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

  // xterm + SSE setup
  useEffect(() => {
    if (!containerRef.current || status === 'waiting') return;

    termRef.current?.dispose();
    esRef.current?.close();

    const xtermTheme = resolved === 'light' ? lightTheme : darkTheme;

    const term = new Terminal({
      theme: xtermTheme,
      fontSize: 10,
      fontFamily: '"JetBrains Mono", "Cascadia Code", "SF Mono", Menlo, Monaco, monospace',
      lineHeight: 1.2,
      scrollback: 10000,
      convertEol: true,
      cursorBlink: false,
      disableStdin: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    requestAnimationFrame(() => fitAddon.fit());

    termRef.current = term;
    fitRef.current = fitAddon;

    // Connect to per-story log stream
    const es = new EventSource(`${BASE_URL}/api/pipeline/runs/${runId}/stories/${storyId}/log`);
    esRef.current = es;

    es.addEventListener('chunk', (e: MessageEvent) => {
      try {
        const binary = atob(e.data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        term.write(bytes);
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

    const ro = new ResizeObserver(() => fitAddon.fit());
    ro.observe(containerRef.current);

    return () => {
      es.close();
      term.dispose();
      ro.disconnect();
    };
  }, [runId, storyId, resolved, status]);

  // Re-fit xterm when switching back to raw mode
  useEffect(() => {
    if (mode === 'raw') {
      requestAnimationFrame(() => fitRef.current?.fit());
    }
  }, [mode]);

  const statusBanner = status === 'passed' || status === 'failed';

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

        {/* Raw terminal */}
        {status !== 'waiting' && (
          <div
            ref={containerRef}
            className="h-full w-full"
            style={{
              background: resolved === 'light' ? lightTheme.background : darkTheme.background,
              padding: '4px 2px',
              display: mode === 'raw' ? 'block' : 'none',
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
