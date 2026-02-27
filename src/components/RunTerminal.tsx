import { useEffect, useRef, useState, useCallback, useImperativeHandle, forwardRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import {
  Copy, Check, Terminal as TerminalIcon, Layers,
  ChevronDown, ChevronRight,
  FileText, Pencil, Brain, GitCommitHorizontal, Search, Hash, AlertCircle,
} from 'lucide-react';
import { useTheme } from '../contexts/ThemeContext';
import { BASE_URL } from '../lib/apiFetch';
import '@xterm/xterm/css/xterm.css';

export interface RunTerminalHandle {
  scrollToStory: (storyId: string) => void;
}

interface RunTerminalProps {
  runId: number;
}

// ─── Semantic step type (mirrors backend SemanticStep) ────────────────────────

interface SemanticStep {
  type: 'read' | 'write' | 'edit' | 'bash' | 'plan' | 'commit' | 'test' | 'search' | 'unknown';
  label: string;
  detail?: string;
  ts: string;
}

const STEP_CONFIG: Record<SemanticStep['type'], { icon: typeof FileText; label: string; color: string }> = {
  read:    { icon: FileText,            label: 'Read',    color: 'text-blue-400' },
  write:   { icon: Pencil,              label: 'Write',   color: 'text-emerald-400' },
  edit:    { icon: Pencil,              label: 'Edit',    color: 'text-emerald-400' },
  bash:    { icon: TerminalIcon,        label: 'Bash',    color: 'text-amber-400' },
  plan:    { icon: Brain,               label: 'Plan',    color: 'text-purple-400' },
  commit:  { icon: GitCommitHorizontal, label: 'Commit',  color: 'text-cyan-400' },
  test:    { icon: Hash,                label: 'Test',    color: 'text-teal-400' },
  search:  { icon: Search,              label: 'Search',  color: 'text-orange-400' },
  unknown: { icon: AlertCircle,         label: 'Unknown', color: 'text-gray-400' },
};

// ─── xterm themes ─────────────────────────────────────────────────────────────

const darkTheme = {
  background: '#0d0d0d',
  foreground: '#d4d4d4',
  cursor: '#d4d4d4',
  black: '#1e1e1e',
  brightBlack: '#808080',
  red: '#f44747',
  brightRed: '#f44747',
  green: '#4ec9b0',
  brightGreen: '#4ec9b0',
  yellow: '#dcdcaa',
  brightYellow: '#dcdcaa',
  blue: '#569cd6',
  brightBlue: '#9cdcfe',
  magenta: '#c586c0',
  brightMagenta: '#c586c0',
  cyan: '#9cdcfe',
  brightCyan: '#9cdcfe',
  white: '#d4d4d4',
  brightWhite: '#e6e6e6',
};

const lightTheme = {
  background: '#f5f5f5',
  foreground: '#1e1e1e',
  cursor: '#1e1e1e',
  black: '#1e1e1e',
  brightBlack: '#6e6e6e',
  red: '#cd3131',
  brightRed: '#cd3131',
  green: '#00873a',
  brightGreen: '#00873a',
  yellow: '#795e26',
  brightYellow: '#795e26',
  blue: '#0451a5',
  brightBlue: '#0451a5',
  magenta: '#af00db',
  brightMagenta: '#af00db',
  cyan: '#0598bc',
  brightCyan: '#0598bc',
  white: '#d4d4d4',
  brightWhite: '#1e1e1e',
};

// ─── Verbose text parser (claude --verbose output format) ────────────────────

/** Strip ANSI escape codes */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

// Patterns ordered by priority — first match wins.
// Claude --verbose emits lines like "  🔍 Glob: pattern" or "  📖 Read: /path"
const VERBOSE_PATTERNS: [RegExp, SemanticStep['type']][] = [
  [/(?:📖\s*)?Read(?:ing)?\s*[:\s]\s*(.+)/i,         'read'],
  [/(?:📝\s*|✏️\s*|📄\s*)?Writ(?:e|ing)\s*[:\s]\s*(.+)/i, 'write'],
  [/(?:✏️\s*|📝\s*)?Edit(?:ing)?\s*[:\s]\s*(.+)/i,   'edit'],
  [/(?:🔧\s*)Bash\s*[:\s]\s*(.*)/i,                   'bash'],
  [/(?:🔍\s*)Glob\s*[:\s]\s*(.*)/i,                   'search'],
  [/(?:🔍\s*)Grep\s*[:\s]\s*(.*)/i,                   'search'],
  [/(?:🔧\s*)Task\s*[:\s]\s*(.*)/i,                   'plan'],
  [/ULTRATHINK|Let me think|Let me analyze/i,          'plan'],
  [/(?:feat|fix|chore|test|refactor|style|docs|build)(?:\([^)]*\))?:/i, 'commit'],
];

/** Parse a single line from claude --verbose output into a SemanticStep, or null. */
function parseVerboseLine(line: string): SemanticStep | null {
  const clean = stripAnsi(line).trim();
  if (!clean || clean.length < 4) return null;

  for (const [pattern, type] of VERBOSE_PATTERNS) {
    const m = clean.match(pattern);
    if (m) {
      // Build a short label from the captured group (path, command, etc.)
      const captured = m[1]?.trim() ?? '';
      let label: string;
      switch (type) {
        case 'read':    label = `Read ${captured}`.slice(0, 100); break;
        case 'write':   label = `Write ${captured}`.slice(0, 100); break;
        case 'edit':    label = `Edit ${captured}`.slice(0, 100); break;
        case 'bash':    label = captured.slice(0, 100) || 'Bash'; break;
        case 'search':  label = `${clean.match(/(?:Glob|Grep)/i)?.[0] ?? 'Search'} ${captured}`.slice(0, 100); break;
        case 'plan':    label = captured ? `Task: ${captured.slice(0, 60)}` : 'Reasoning'; break;
        case 'commit':  label = clean.slice(0, 80); break;
        default:        label = clean.slice(0, 80);
      }
      return { type, label, ts: new Date().toISOString() };
    }
  }
  return null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function lsKey(runId: number): string {
  return `rorca:terminal-mode:${runId}`;
}

function loadMode(runId: number): 'raw' | 'semantic' {
  try {
    const v = localStorage.getItem(lsKey(runId));
    return v === 'semantic' ? 'semantic' : 'raw';
  } catch {
    return 'raw';
  }
}

function formatRelativeTime(isoTs: string, baseTs: string | null): string {
  const t = new Date(isoTs).getTime();
  const base = baseTs ? new Date(baseTs).getTime() : t;
  const diffMs = t - base;
  if (diffMs < 0) return '+0s';
  const totalSec = Math.floor(diffMs / 1000);
  if (totalSec < 60) return `+${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `+${min}m${sec.toString().padStart(2, '0')}s`;
}

/**
 * Embeds an xterm.js terminal that streams live stdout/stderr from a pipeline run.
 * Includes a Raw/Semantic toggle. In Semantic mode, structured `semantic_step` SSE
 * events are rendered as a step list instead of the raw terminal.
 */
const RunTerminal = forwardRef<RunTerminalHandle, RunTerminalProps>(function RunTerminal({ runId }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const { resolved } = useTheme();
  const [copied, setCopied] = useState(false);

  // Toggle state — persisted per run in localStorage
  const [mode, setMode] = useState<'raw' | 'semantic'>(() => loadMode(runId));

  // Semantic step state
  const [steps, setSteps] = useState<SemanticStep[]>([]);
  const [expandedSet, setExpandedSet] = useState<Set<number>>(new Set());
  const [autoScroll, setAutoScroll] = useState(true);
  const stepListRef = useRef<HTMLDivElement>(null);
  const stepBottomRef = useRef<HTMLDivElement>(null);
  const [streamDone, setStreamDone] = useState(false);

  // Persist mode changes
  const handleSetMode = useCallback((m: 'raw' | 'semantic') => {
    setMode(m);
    try { localStorage.setItem(lsKey(runId), m); } catch { /* noop */ }
  }, [runId]);

  // Expose scrollToStory via ref
  useImperativeHandle(ref, () => ({
    scrollToStory(storyId: string) {
      const term = termRef.current;
      if (!term) return;
      const buffer = term.buffer.active;
      for (let i = 0; i < buffer.length; i++) {
        const line = buffer.getLine(i);
        if (!line) continue;
        const text = line.translateToString(true);
        if (text.includes(storyId)) {
          term.scrollToLine(i);
          return;
        }
      }
    },
  }), []);

  const handleCopy = useCallback(async () => {
    const term = termRef.current;
    if (!term) return;
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
      lines.pop();
    }
    const text = lines.join('\n');
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard not available */ }
  }, []);

  // xterm + SSE setup — always runs (xterm writes happen even when hidden)
  useEffect(() => {
    if (!containerRef.current) return;

    termRef.current?.dispose();
    esRef.current?.close();

    const xtermTheme = resolved === 'light' ? lightTheme : darkTheme;
    const isMobile = window.innerWidth < 768;

    const term = new Terminal({
      theme: xtermTheme,
      fontSize: isMobile ? 10 : 12,
      fontFamily: '"JetBrains Mono", "Cascadia Code", "SF Mono", Menlo, Monaco, monospace',
      lineHeight: 1.3,
      scrollback: 50000,
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

    // Connect to live output stream
    const es = new EventSource(`${BASE_URL}/api/pipeline/runs/${runId}/output`);
    esRef.current = es;

    // Line buffer for semantic parsing across chunk boundaries
    let lineBuffer = '';

    es.addEventListener('chunk', (e: MessageEvent) => {
      try {
        const binary = atob(e.data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        term.write(bytes);

        // Client-side semantic parsing from raw verbose output
        const text = new TextDecoder().decode(bytes);
        lineBuffer += text;
        const parts = lineBuffer.split('\n');
        lineBuffer = parts.pop() ?? '';
        const newSteps: SemanticStep[] = [];
        for (const part of parts) {
          const step = parseVerboseLine(part);
          if (step) newSteps.push(step);
        }
        if (newSteps.length > 0) {
          setSteps(prev => [...prev, ...newSteps]);
        }
      } catch { /* ignore malformed chunk */ }
    });

    // Also accept structured semantic_step events from backend if available
    es.addEventListener('semantic_step', (e: MessageEvent) => {
      try {
        const step: SemanticStep = JSON.parse(e.data);
        setSteps(prev => [...prev, step]);
      } catch { /* ignore malformed step */ }
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
  }, [runId, resolved]);

  // Re-fit xterm when switching back to raw mode (container was display:none)
  useEffect(() => {
    if (mode === 'raw') {
      requestAnimationFrame(() => fitRef.current?.fit());
    }
  }, [mode]);

  // Auto-scroll semantic step list
  useEffect(() => {
    if (autoScroll && stepBottomRef.current) {
      stepBottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [steps, autoScroll]);

  const handleStepListScroll = useCallback(() => {
    const el = stepListRef.current;
    if (!el) return;
    setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  }, []);

  const toggleExpand = useCallback((index: number) => {
    setExpandedSet(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  const firstTs = steps.length > 0 ? steps[0].ts : null;

  return (
    <div className="h-full w-full flex flex-col">
      {/* ─── Toolbar ─────────────────────────────────────────────────────── */}
      <div className="shrink-0 px-3 py-1.5 border-b border-border bg-panel flex items-center gap-1">
        <button
          onClick={() => handleSetMode('raw')}
          className={`px-2 py-1 text-[11px] font-medium rounded transition-colors ${
            mode === 'raw'
              ? 'bg-accent/15 text-accent'
              : 'text-muted hover:text-[var(--text)]'
          }`}
        >
          <span className="flex items-center gap-1">
            <TerminalIcon size={11} />
            Raw
          </span>
        </button>
        <button
          onClick={() => handleSetMode('semantic')}
          className={`px-2 py-1 text-[11px] font-medium rounded transition-colors ${
            mode === 'semantic'
              ? 'bg-accent/15 text-accent'
              : 'text-muted hover:text-[var(--text)]'
          }`}
        >
          <span className="flex items-center gap-1">
            <Layers size={11} />
            Semantic
          </span>
        </button>

        {/* Copy button (raw mode only) */}
        {mode === 'raw' && (
          <button
            onClick={handleCopy}
            className="ml-auto p-1.5 rounded-md text-muted hover:text-[var(--text)] transition-colors"
            title="Copy terminal output"
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
        )}
      </div>

      {/* ─── Content area ────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 relative">
        {/* Raw terminal — always mounted, hidden via CSS when semantic */}
        <div
          ref={containerRef}
          className="h-full w-full overflow-x-auto"
          style={{
            background: resolved === 'light' ? lightTheme.background : darkTheme.background,
            padding: '8px 4px',
            WebkitOverflowScrolling: 'touch',
            display: mode === 'raw' ? 'block' : 'none',
          }}
        />

        {/* Semantic step list */}
        {mode === 'semantic' && (
          <div className="h-full flex flex-col">
            {steps.length === 0 ? (
              <div className="flex-1 flex items-center justify-center text-muted text-sm">
                {streamDone
                  ? 'No semantic data available for this run'
                  : 'Waiting for semantic events\u2026'}
              </div>
            ) : (
              <div
                ref={stepListRef}
                onScroll={handleStepListScroll}
                className="flex-1 overflow-y-auto overflow-x-hidden"
              >
                {steps.map((step, i) => {
                  const cfg = STEP_CONFIG[step.type];
                  const Icon = cfg.icon;
                  const hasDetail = !!step.detail;
                  const isExpanded = expandedSet.has(i);

                  return (
                    <div key={i} className="border-b border-border/30">
                      <div
                        className={`px-3 py-1.5 flex items-center gap-2 ${hasDetail ? 'cursor-pointer hover:bg-panel/50' : ''} transition-colors`}
                        onClick={hasDetail ? () => toggleExpand(i) : undefined}
                      >
                        {/* Expand/collapse chevron */}
                        {hasDetail ? (
                          isExpanded
                            ? <ChevronDown size={12} className="text-muted shrink-0" />
                            : <ChevronRight size={12} className="text-muted shrink-0" />
                        ) : (
                          <span className="w-3 shrink-0" />
                        )}

                        {/* Step icon */}
                        <Icon size={13} className={`shrink-0 ${cfg.color}`} />

                        {/* Label */}
                        <span className="text-xs text-[var(--text)] truncate flex-1 font-mono">
                          {step.label}
                        </span>

                        {/* Relative timestamp */}
                        <span className="text-[10px] text-muted font-mono shrink-0 ml-2">
                          {formatRelativeTime(step.ts, firstTs)}
                        </span>
                      </div>

                      {/* Collapsible detail */}
                      {hasDetail && isExpanded && (
                        <pre className="px-3 pb-2 pl-10 text-[11px] leading-[1.4] font-mono text-muted whitespace-pre-wrap break-all">
                          {step.detail}
                        </pre>
                      )}
                    </div>
                  );
                })}
                <div ref={stepBottomRef} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

export default RunTerminal;
