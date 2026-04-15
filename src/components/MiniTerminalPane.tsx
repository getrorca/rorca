import { useEffect, useRef, useState, useCallback } from 'react';
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

const TERMINAL_THEME_DARK = {
  background: '#0d1117',
  foreground: '#e6edf3',
  cursor: '#58a6ff',
  cursorAccent: '#0d1117',
  selection: 'rgba(38,79,120,0.5)',
  black: '#484f58',
  red: '#ff7b72',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39c5cf',
  white: '#b1bac4',
  brightBlack: '#6e7681',
  brightRed: '#ffa198',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd',
  brightWhite: '#f0f6fc',
};

const TERMINAL_THEME_LIGHT = {
  background: '#ffffff',
  foreground: '#24292f',
  cursor: '#0969da',
  cursorAccent: '#ffffff',
  selection: 'rgba(9,105,218,0.1)',
  black: '#24292f',
  red: '#cf222e',
  green: '#116329',
  yellow: '#9a6700',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#6e7781',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#1a7f37',
  brightYellow: '#7d4e00',
  brightBlue: '#218bff',
  brightMagenta: '#a475f9',
  brightCyan: '#3192aa',
  brightWhite: '#8c959f',
};

// ─── ANSI converter singleton ────────────────────────────────────────────────

const ansiConverter = new AnsiToHtml({
  fg: TERMINAL_THEME_DARK.foreground,
  bg: TERMINAL_THEME_DARK.background,
  escapeXML: true,
  newline: true,
});

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_BUFFER_LINES = 5_000;
const FLUSH_INTERVAL_MS = 80;
const FALLBACK_TIMEOUT_MS = 3_000;
const SCROLL_LOCK_THRESHOLD = 50;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Decode a base64-encoded SSE data field to a UTF-8 string. */
function decodeBase64Chunk(data: string): string {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Trim a buffer string array to at most MAX_BUFFER_LINES lines (in-place). */
function trimBuffer(buf: string[]): void {
  if (buf.length > MAX_BUFFER_LINES) {
    buf.splice(0, buf.length - MAX_BUFFER_LINES);
  }
}

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

  // Buffer for accumulating raw text before batch flush
  const pendingTextRef = useRef('');
  const bufferLinesRef = useRef<string[]>([]);
  const flushedHtmlLenRef = useRef(0);

  // Auto-scroll semantic list
  useEffect(() => {
    if (mode === 'semantic' && stepListRef.current) {
      stepListRef.current.scrollTop = stepListRef.current.scrollHeight;
    }
  }, [steps, mode]);

  // SSE setup — connects to /stream first, falls back to /log after 3s
  useEffect(() => {
    if (status === 'waiting') return;

    // Reset state
    esRef.current?.close();
    if (preRef.current) preRef.current.innerHTML = '';
    pendingTextRef.current = '';
    bufferLinesRef.current = [];
    flushedHtmlLenRef.current = 0;
    setSteps([]);
    setStreamDone(false);

    const converter = resolved === 'light'
      ? new AnsiToHtml({ fg: TERMINAL_THEME_LIGHT.foreground, bg: TERMINAL_THEME_LIGHT.background, escapeXML: true, newline: true })
      : ansiConverter;

    let receivedData = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    let flushTimer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;

    // ── Batch flush: convert only new pending text every 80ms ──
    const flush = () => {
      const text = pendingTextRef.current;
      if (!text || !preRef.current) return;
      pendingTextRef.current = '';

      // Split into lines for buffer cap tracking
      const newLines = text.split('\n');
      bufferLinesRef.current.push(...newLines);
      trimBuffer(bufferLinesRef.current);

      // Check if we've exceeded the cap and need to re-render from buffer
      // (only happens after a trim — lines were dropped from the front)
      const totalBufferedText = bufferLinesRef.current.join('\n');
      const expectedHtmlLen = flushedHtmlLenRef.current;

      // Normal path: append only new HTML
      const html = converter.toHtml(text);
      preRef.current.innerHTML += html;
      flushedHtmlLenRef.current = preRef.current.innerHTML.length;

      // If buffer was trimmed, rebuild from the full buffer to stay in sync
      if (bufferLinesRef.current.length === MAX_BUFFER_LINES && expectedHtmlLen > 0) {
        const fullHtml = converter.toHtml(totalBufferedText);
        preRef.current.innerHTML = fullHtml;
        flushedHtmlLenRef.current = fullHtml.length;
      }

      if (autoScrollRef.current) {
        preRef.current.scrollTop = preRef.current.scrollHeight;
      }
    };

    // ── Attach chunk/output + semantic_step + done handlers to an EventSource ──
    const attachHandlers = (es: EventSource, chunkEvent: string) => {
      let lineBuf = '';
      es.addEventListener(chunkEvent, (e: MessageEvent) => {
        try {
          receivedData = true;
          const text = decodeBase64Chunk(e.data);
          // Filter OpenCode JSON events line-by-line — same logic as RunTerminal.
          // step_finish and tool_result contain large JSON blobs; suppress them.
          lineBuf += text;
          const lines = lineBuf.split('\n');
          lineBuf = lines.pop() ?? '';
          const display: string[] = [];
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) { display.push(''); continue; }
            if (trimmed.startsWith('{')) {
              try {
                const ev = JSON.parse(trimmed) as { type?: string };
                if (ev.type === 'step_finish' || ev.type === 'step_start' || ev.type === 'tool_result' || ev.type === 'system' || ev.type === 'user') continue;
              } catch { /* not valid JSON — pass through */ }
            }
            display.push(line);
          }
          if (display.length > 0) pendingTextRef.current += display.join('\n') + '\n';
        } catch { /* ignore malformed chunk */ }
      });

      es.addEventListener('semantic_step', (e: MessageEvent) => {
        try {
          const step: SemanticStep = JSON.parse(e.data);
          setSteps(prev => [...prev, step]);
        } catch { /* ignore */ }
      });

      es.addEventListener('done', () => {
        // Final flush before marking done
        flush();
        setStreamDone(true);
        es.close();
      });

      es.onerror = () => {
        if (es.readyState === EventSource.CLOSED) {
          flush();
          setStreamDone(true);
        }
      };
    };

    // ── Start flush interval ──
    flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);

    // ── Try /stream endpoint first (DB-backed filtered prose) ──
    const streamUrl = `${BASE_URL}/api/pipeline/runs/${runId}/stories/${storyId}/stream`;
    const es = new EventSource(streamUrl);
    esRef.current = es;
    attachHandlers(es, 'output');

    // ── Fallback: if /stream returns no data within 3s, switch to /log ──
    fallbackTimer = setTimeout(() => {
      if (cancelled || receivedData) return;
      // No data from /stream — close it and connect to /log
      es.close();
      const logEs = new EventSource(`${BASE_URL}/api/pipeline/runs/${runId}/stories/${storyId}/log`);
      esRef.current = logEs;
      attachHandlers(logEs, 'chunk');
    }, FALLBACK_TIMEOUT_MS);

    return () => {
      cancelled = true;
      esRef.current?.close();
      if (fallbackTimer) clearTimeout(fallbackTimer);
      if (flushTimer) clearInterval(flushTimer);
      // Final flush on cleanup
      flush();
    };
  }, [runId, storyId, resolved, status]);

  // Track scroll position for auto-scroll (50px threshold)
  const handlePreScroll = useCallback(() => {
    const el = preRef.current;
    if (!el) return;
    autoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_LOCK_THRESHOLD;
  }, []);

  const statusBanner = status === 'passed' || status === 'failed';
  const themeColors = resolved === 'light' ? TERMINAL_THEME_LIGHT : TERMINAL_THEME_DARK;

  return (
    <div className="flex flex-col border border-[var(--border)] rounded-lg overflow-hidden bg-[var(--bg)] h-full">
      {/* ─── Header ─────────────────────────────────────────────────────── */}
      <div className="shrink-0 px-2 py-1.5 border-b border-[var(--border)] bg-[var(--surface)] flex items-center gap-2 min-h-[32px]">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)] shrink-0">
          Story Trace
        </span>
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
