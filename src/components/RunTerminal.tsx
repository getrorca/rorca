import { useEffect, useRef, useState, useCallback, useImperativeHandle, forwardRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import {
  Copy, Check, Terminal as TerminalIcon, Layers,
  ChevronDown, ChevronRight,
  FileText, Pencil, Brain, GitCommitHorizontal, Search, Hash, AlertCircle,
  FilePlus, Globe, Clock,
} from 'lucide-react';
import { useTheme } from '../contexts/ThemeContext';
import { BASE_URL } from '../lib/apiFetch';
import '@xterm/xterm/css/xterm.css';

export interface RunTerminalHandle {
  scrollToStory: (storyId: string) => void;
}

interface RunTerminalProps {
  runId: number;
  workspaceId?: string | null;
}

// ─── Semantic step type (mirrors backend SemanticStep) ────────────────────────

interface SemanticStep {
  type: 'read' | 'write' | 'edit' | 'bash' | 'plan' | 'commit' | 'test' | 'search' | 'unknown';
  label: string;
  detail?: string;
  ts: string;
  toolName?: string;
  durationMs?: number;
  isError?: boolean;
  output?: string;
}

// ─── Icon configs ────────────────────────────────────────────────────────────

type IconComponent = typeof FileText;

interface StepVisual {
  icon: IconComponent;
  label: string;
  color: string;
}

/** Default step config (used for Claude path and fallback) */
const STEP_CONFIG: Record<SemanticStep['type'], StepVisual> = {
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

/** OpenCode-specific icon overrides keyed by toolName */
const OPENCODE_TOOL_ICONS: Record<string, StepVisual> = {
  bash:      { icon: TerminalIcon, label: 'Bash',      color: 'text-amber-400' },
  edit:      { icon: Pencil,       label: 'Edit',      color: 'text-yellow-400' },
  read:      { icon: FileText,     label: 'Read',      color: 'text-blue-400' },
  write:     { icon: FilePlus,     label: 'Write',     color: 'text-emerald-400' },
  glob:      { icon: Search,       label: 'Glob',      color: 'text-orange-400' },
  grep:      { icon: Search,       label: 'Grep',      color: 'text-orange-400' },
  webfetch:  { icon: Globe,        label: 'WebFetch',  color: 'text-sky-400' },
  websearch: { icon: Globe,        label: 'WebSearch', color: 'text-sky-400' },
};

/** Resolve visual config for a step, with OpenCode tool-specific overrides */
function resolveStepVisual(step: SemanticStep, isOpenCode: boolean): StepVisual {
  if (isOpenCode && step.toolName && OPENCODE_TOOL_ICONS[step.toolName]) {
    return OPENCODE_TOOL_ICONS[step.toolName];
  }
  return STEP_CONFIG[step.type];
}

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

// ─── stream-json → readable text formatter (for Raw terminal display) ────────

/**
 * Convert a Claude `--output-format stream-json` line to human-readable text.
 * Returns null to suppress the line entirely (e.g. system init, tool results).
 * Returns the original line for non-JSON content (run-loop output, etc.).
 */
function formatStreamJsonForDisplay(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return '';
  if (!trimmed.startsWith('{')) return line; // Not JSON — pass through

  try {
    const ev = JSON.parse(trimmed);

    // System init — suppress
    if (ev.type === 'system') return null;

    // Assistant message with content blocks (tool_use + text)
    if (ev.type === 'assistant' && ev.message?.content) {
      const parts: string[] = [];
      for (const block of ev.message.content) {
        if (block.type === 'text' && block.text) {
          // Show assistant thinking/text (truncated)
          const text = block.text.trim();
          if (text) parts.push(text.length > 500 ? text.slice(0, 500) + '...' : text);
        } else if (block.type === 'tool_use') {
          const name: string = block.name ?? '';
          const input = block.input ?? {};
          switch (name) {
            case 'Read':     parts.push(`📖 Read ${input.file_path ?? ''}`); break;
            case 'Write':    parts.push(`📝 Write ${input.file_path ?? ''}`); break;
            case 'Edit':     parts.push(`✏️  Edit ${input.file_path ?? ''}`); break;
            case 'Bash':     parts.push(`🔧 Bash: ${(input.command ?? '').slice(0, 200)}`); break;
            case 'Glob':     parts.push(`🔍 Glob: ${input.pattern ?? ''}`); break;
            case 'Grep':     parts.push(`🔍 Grep: ${input.pattern ?? ''}`); break;
            case 'Task':     parts.push(`🧠 Task: ${input.description ?? ''}`); break;
            case 'TodoWrite': parts.push('📋 TodoWrite'); break;
            case 'WebFetch': parts.push(`🌐 WebFetch: ${input.url ?? ''}`); break;
            case 'WebSearch': parts.push(`🌐 WebSearch: ${input.query ?? ''}`); break;
            default:         parts.push(`🔧 ${name}`);
          }
        }
      }
      return parts.length > 0 ? parts.join('\n') : null;
    }

    // Result event (final summary)
    if (ev.type === 'result') {
      if (ev.subtype === 'success') {
        const r = typeof ev.result === 'string' ? ev.result.slice(0, 300) : '';
        return `\n✅ Completed${r ? ': ' + r.split('\n')[0].slice(0, 200) : ''}`;
      }
      if (ev.subtype === 'error') {
        return `\n❌ Error: ${ev.error ?? 'unknown'}`;
      }
      return null;
    }

    // User message (prompt injection by run-loop) — suppress
    if (ev.type === 'user') return null;

    // Anything else — suppress unknown JSON events
    return null;
  } catch {
    // Not valid JSON despite starting with { — pass through
    return line;
  }
}

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

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const remSec = Math.floor(sec % 60);
  return `${min}m${remSec}s`;
}

// ─── OpenCode Semantic Step Renderer ──────────────────────────────────────────

function OpenCodeStepRow({
  step, index, firstTs, isExpanded, onToggle,
}: {
  step: SemanticStep;
  index: number;
  firstTs: string | null;
  isExpanded: boolean;
  onToggle: (i: number) => void;
}) {
  const visual = resolveStepVisual(step, true);
  const Icon = visual.icon;
  const hasExpandable = !!(step.detail || step.output);
  const isError = step.isError || step.type === 'unknown';

  return (
    <div className={`border-b border-border/30 ${isError ? 'bg-red-500/5' : ''}`}>
      <div
        className={`px-3 py-1.5 flex items-center gap-2 ${hasExpandable ? 'cursor-pointer hover:bg-panel/50' : ''} transition-colors`}
        onClick={hasExpandable ? () => onToggle(index) : undefined}
      >
        {/* Expand/collapse chevron */}
        {hasExpandable ? (
          isExpanded
            ? <ChevronDown size={12} className="text-muted shrink-0" />
            : <ChevronRight size={12} className="text-muted shrink-0" />
        ) : (
          <span className="w-3 shrink-0" />
        )}

        {/* Tool icon */}
        <Icon size={13} className={`shrink-0 ${isError ? 'text-red-400' : visual.color}`} />

        {/* Tool name badge */}
        {step.toolName && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${
            isError
              ? 'bg-red-500/15 text-red-400'
              : 'bg-accent/10 text-accent'
          }`}>
            {visual.label}
          </span>
        )}

        {/* Label (file path / command argument) */}
        <span className={`text-xs truncate flex-1 font-mono ${
          isError ? 'text-red-400' : 'text-[var(--text)]'
        }`}>
          {step.label}
        </span>

        {/* Duration badge */}
        {step.durationMs != null && (
          <span className="flex items-center gap-0.5 text-[10px] text-muted font-mono shrink-0">
            <Clock size={9} className="text-muted" />
            {formatDuration(step.durationMs)}
          </span>
        )}

        {/* Relative timestamp */}
        <span className="text-[10px] text-muted font-mono shrink-0 ml-1">
          {formatRelativeTime(step.ts, firstTs)}
        </span>
      </div>

      {/* Collapsible output section */}
      {hasExpandable && isExpanded && (
        <div className="px-3 pb-2 pl-10">
          {/* Command detail (for bash: the full command) */}
          {step.detail && step.type === 'bash' && (
            <div className="mb-1">
              <span className="text-[10px] text-muted font-medium">$ </span>
              <code className="text-[11px] font-mono text-amber-400/80">{step.detail}</code>
            </div>
          )}
          {step.detail && step.type !== 'bash' && (
            <pre className="text-[11px] leading-[1.4] font-mono text-muted whitespace-pre-wrap break-all mb-1">
              {step.detail}
            </pre>
          )}

          {/* Tool output (collapsible stdout/stderr for bash, result text for others) */}
          {step.output && (
            <pre className={`text-[11px] leading-[1.4] font-mono whitespace-pre-wrap break-all max-h-48 overflow-y-auto rounded p-2 ${
              isError
                ? 'bg-red-500/10 text-red-300 border border-red-500/20'
                : 'bg-black/20 text-muted border border-border/20'
            }`}>
              {step.output}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Claude Semantic Step Renderer (existing, unchanged) ──────────────────────

function ClaudeStepRow({
  step, index, firstTs, isExpanded, onToggle,
}: {
  step: SemanticStep;
  index: number;
  firstTs: string | null;
  isExpanded: boolean;
  onToggle: (i: number) => void;
}) {
  const cfg = STEP_CONFIG[step.type];
  const Icon = cfg.icon;
  const hasDetail = !!step.detail;

  return (
    <div className="border-b border-border/30">
      <div
        className={`px-3 py-1.5 flex items-center gap-2 ${hasDetail ? 'cursor-pointer hover:bg-panel/50' : ''} transition-colors`}
        onClick={hasDetail ? () => onToggle(index) : undefined}
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
}

// ─── Main Component ───────────────────────────────────────────────────────────

/**
 * Embeds an xterm.js terminal that streams live stdout/stderr from a pipeline run.
 * Includes a Raw/Semantic toggle. In Semantic mode, structured `semantic_step` SSE
 * events are rendered as a step list instead of the raw terminal.
 *
 * When agent_type=opencode, the semantic view uses a richer renderer with:
 * - Tool-specific icons (Globe for webfetch, FilePlus for write, etc.)
 * - Duration badges per event
 * - Collapsible stdout/stderr for bash events
 * - Error events highlighted in red
 *
 * When agent_type=claude (default), the existing xterm-parsing semantic view is unchanged.
 */
const RunTerminal = forwardRef<RunTerminalHandle, RunTerminalProps>(function RunTerminal({ runId, workspaceId }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const { resolved } = useTheme();
  const [copied, setCopied] = useState(false);

  // Agent type detected from backend run_meta SSE event
  const [agentType, setAgentType] = useState<'claude' | 'opencode' | 'codex'>('claude');

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

    // Connect to live output stream — scoped to workspace
    const outputParams = new URLSearchParams();
    if (workspaceId) outputParams.set('workspaceId', workspaceId);
    const outputUrl = `${BASE_URL}/api/pipeline/runs/${runId}/output${outputParams.toString() ? '?' + outputParams : ''}`;
    const es = new EventSource(outputUrl);
    esRef.current = es;
    let lineBuffer = '';

    // Listen for run metadata (agent type detection)
    es.addEventListener('run_meta', (e: MessageEvent) => {
      try {
        const meta = JSON.parse(e.data) as { agentType?: string };
        if (meta.agentType === 'opencode' || meta.agentType === 'codex') {
          setAgentType(meta.agentType);
        }
      } catch { /* ignore */ }
    });

    es.addEventListener('chunk', (e: MessageEvent) => {
      try {
        const binary = atob(e.data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

        // Convert stream-json lines to readable text before writing to xterm
        const text = new TextDecoder().decode(bytes);
        lineBuffer += text;
        const parts = lineBuffer.split('\n');
        lineBuffer = parts.pop() ?? '';

        const displayLines: string[] = [];
        const newSteps: SemanticStep[] = [];

        for (const part of parts) {
          // Client-side semantic parsing
          const step = parseVerboseLine(part);
          if (step) newSteps.push(step);

          // Format stream-json for readable raw display
          const formatted = formatStreamJsonForDisplay(part);
          if (formatted !== null) {
            displayLines.push(formatted);
          }
        }

        // Write formatted text to xterm (instead of raw JSON bytes)
        if (displayLines.length > 0) {
          const output = displayLines.join('\r\n') + '\r\n';
          term.write(output);
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
      // Don't close — EventSource auto-reconnects on transient errors.
      // The server's 'done' event is the proper signal that the stream ended.
      // Only mark done if the connection is permanently dead (readyState === CLOSED).
      if (es.readyState === EventSource.CLOSED) {
        setStreamDone(true);
      }
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
  const isOpenCode = agentType === 'opencode' || agentType === 'codex';

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

        {/* Agent type badge (shown when not claude) */}
        {isOpenCode && (
          <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-400 font-medium">
            OpenCode
          </span>
        )}

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
                {steps.map((step, i) => (
                  isOpenCode ? (
                    <OpenCodeStepRow
                      key={i}
                      step={step}
                      index={i}
                      firstTs={firstTs}
                      isExpanded={expandedSet.has(i)}
                      onToggle={toggleExpand}
                    />
                  ) : (
                    <ClaudeStepRow
                      key={i}
                      step={step}
                      index={i}
                      firstTs={firstTs}
                      isExpanded={expandedSet.has(i)}
                      onToggle={toggleExpand}
                    />
                  )
                ))}
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
