/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { useEffect, useRef, useState, useCallback, useImperativeHandle, forwardRef, useMemo } from 'react';
import AnsiToHtml from 'ansi-to-html';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import {
  Copy, Check, Terminal as TerminalIcon, Layers,
  ChevronDown, ChevronRight,
  FileText, Pencil, Brain, GitCommitHorizontal, Search, Hash, AlertCircle,
  FilePlus, Globe, Clock,
} from 'lucide-react';
import { useTheme } from '../contexts/ThemeContext';
import { apiFetch, BASE_URL } from '../lib/apiFetch';
import {
  HTML_LINE_PREFIX,
  formatStreamJsonForDisplay,
  parseVerboseLine,
  decodeBase64Chunk,
} from '../lib/run-terminal-parity';

export interface RunTerminalHandle {
  scrollToStory: (storyId: string) => void;
  writeMarker: (text: string) => void;
}

interface RunTerminalProps {
  runId: number;
  workspaceId?: string | null;
  terminalMode?: TerminalMode;
}

type TerminalMode = 'ansi-html' | 'pty';

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

// ─── ANSI color palettes per theme ───────────────────────────────────────────
// Indices 0-7: standard colors, 8-15: bright variants

const ANSI_COLORS_DARK: Record<number, string> = {
  0: '#1e1e1e',   // black
  1: '#f87171',   // red
  2: '#4ade80',   // green
  3: '#facc15',   // yellow
  4: '#60a5fa',   // blue
  5: '#c084fc',   // magenta
  6: '#22d3ee',   // cyan
  7: '#d4d4d4',   // white
  8: '#525252',   // bright black
  9: '#fca5a5',   // bright red
  10: '#86efac',  // bright green
  11: '#fde68a',  // bright yellow
  12: '#93c5fd',  // bright blue
  13: '#d8b4fe',  // bright magenta
  14: '#67e8f9',  // bright cyan
  15: '#fafafa',  // bright white
};

const ANSI_COLORS_LIGHT: Record<number, string> = {
  0: '#1e1e1e',   // black
  1: '#dc2626',   // red
  2: '#16a34a',   // green
  3: '#ca8a04',   // yellow
  4: '#2563eb',   // blue
  5: '#9333ea',   // magenta
  6: '#0891b2',   // cyan
  7: '#f5f5f5',   // white
  8: '#737373',   // bright black
  9: '#ef4444',   // bright red
  10: '#22c55e',  // bright green
  11: '#eab308',  // bright yellow
  12: '#3b82f6',  // bright blue
  13: '#a855f7',  // bright magenta
  14: '#06b6d4',  // bright cyan
  15: '#fafafa',  // bright white
};

function getPtyTheme(mode: 'light' | 'dark') {
  return mode === 'dark'
    ? {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#58a6ff',
        cursorAccent: '#0d1117',
        selectionBackground: 'rgba(38,79,120,0.5)',
      }
    : {
        background: '#ffffff',
        foreground: '#111827',
        cursor: '#2563eb',
        cursorAccent: '#ffffff',
        selectionBackground: 'rgba(147,197,253,0.45)',
      };
}

// ─── Transcript + semantic replay helpers live in src/lib/run-terminal-parity.ts ─
// ─── Story ID detection ──────────────────────────────────────────────────────

/** Match story IDs like US-001, CIE-014, SL-003 etc. in text */
const STORY_ID_PATTERN = /\b([A-Z]{1,6}-\d{3,4})\b/g;

/**
 * Inject data-story-id anchor spans at story boundary mentions in HTML.
 * Only injects an anchor for the FIRST occurrence of each story ID.
 */
function injectStoryAnchors(html: string, seenIds: Set<string>): string {
  return html.replace(STORY_ID_PATTERN, (match, id: string) => {
    if (seenIds.has(id)) return match;
    seenIds.add(id);
    return `<span data-story-id="${id}">${match}</span>`;
  });
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

// ─── ANSI converter factory ──────────────────────────────────────────────────

function createAnsiConverter(theme: 'light' | 'dark', escapeXml = true): AnsiToHtml {
  const isLight = theme === 'light';
  return new AnsiToHtml({
    fg: isLight ? '#1e1e1e' : '#d4d4d4',
    bg: isLight ? '#f5f5f5' : '#0d0d1a',
    escapeXML: escapeXml,
    newline: true,
    colors: isLight ? ANSI_COLORS_LIGHT : ANSI_COLORS_DARK,
  });
}

// HTML_LINE_PREFIX is shared with the parity helper so transcript tests and UI use identical replay semantics.

// ─── Flush buffer interval ───────────────────────────────────────────────────

const FLUSH_INTERVAL_MS = 80;
const PTY_RESIZE_DEBOUNCE_MS = 100;
const SCROLL_LOCK_THRESHOLD = 50;
const MAX_LINES = 20_000;

/**
 * Trim the oldest lines from an accumulated HTML string so the total
 * newline count stays at or below MAX_LINES.  Truncation always happens
 * at a newline boundary so we never break a mid-tag ANSI-color span.
 */
function trimOldestLines(html: string): string {
  // Count total newlines
  let count = 0;
  for (let i = 0; i < html.length; i++) {
    if (html.charCodeAt(i) === 10) count++;
  }
  if (count <= MAX_LINES) return html;

  // Need to drop (count - MAX_LINES) oldest lines — find the byte offset
  // just past the (count - MAX_LINES)-th newline from the start.
  const toDrop = count - MAX_LINES;
  let dropped = 0;
  let offset = 0;
  for (; offset < html.length; offset++) {
    if (html.charCodeAt(offset) === 10) {
      dropped++;
      if (dropped === toDrop) {
        offset++; // skip past the newline itself
        break;
      }
    }
  }
  return html.slice(offset);
}

// ─── Main Component ───────────────────────────────────────────────────────────

const RunTerminal = forwardRef<RunTerminalHandle, RunTerminalProps>(function RunTerminal({ runId, workspaceId, terminalMode: rendererMode = 'ansi-html' }, ref) {
  const preRef = useRef<HTMLPreElement>(null);
  const ptyContainerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const pendingPtyChunksRef = useRef<Uint8Array[]>([]);
  const resizeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const { resolved } = useTheme();
  const [copied, setCopied] = useState(false);
  const autoScrollRef = useRef(true);

  // Accumulated raw text buffer (pending flush)
  const pendingTextRef = useRef('');
  // Timer ID for the 80ms flush
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Accumulated HTML string rendered so far
  const accumulatedHtmlRef = useRef('');
  // Set of story IDs already anchored (to avoid duplicate anchors)
  const seenStoryIdsRef = useRef(new Set<string>());
  // SSE line buffer for incomplete lines across chunks
  const lineBufferRef = useRef('');

  // Agent type detected from backend run_meta SSE event
  const [agentType, setAgentType] = useState<'claude' | 'opencode' | 'codex'>('claude');
  const [terminalMode, setTerminalMode] = useState<TerminalMode>(rendererMode);
  const terminalModeRef = useRef<TerminalMode>(rendererMode);
  const [ptyReady, setPtyReady] = useState(rendererMode !== 'pty');

  // Toggle state — persisted per run in localStorage
  const [mode, setMode] = useState<'raw' | 'semantic'>(() => loadMode(runId));

  // Semantic step state
  const [steps, setSteps] = useState<SemanticStep[]>([]);
  const [expandedSet, setExpandedSet] = useState<Set<number>>(new Set());
  const [autoScroll, setAutoScroll] = useState(true);
  const stepListRef = useRef<HTMLDivElement>(null);
  const stepBottomRef = useRef<HTMLDivElement>(null);
  const [streamDone, setStreamDone] = useState(false);

  useEffect(() => {
    terminalModeRef.current = terminalMode;
  }, [terminalMode]);

  useEffect(() => {
    terminalModeRef.current = rendererMode;
    setTerminalMode(rendererMode);
    setPtyReady(rendererMode !== 'pty');
  }, [rendererMode]);

  // Persist mode changes
  const handleSetMode = useCallback((m: 'raw' | 'semantic') => {
    setMode(m);
    try { localStorage.setItem(lsKey(runId), m); } catch { /* noop */ }
  }, [runId]);

  useEffect(() => {
    if (terminalMode === 'pty' && mode !== 'raw') {
      handleSetMode('raw');
    }
  }, [handleSetMode, mode, terminalMode]);

  // Recreate ansi-to-html converters when theme changes.
  // ansiConverter: escapeXML=true for raw terminal lines (ANSI codes, plain text).
  // ansiConverterNoEscape: escapeXML=false for lines already HTML-converted by markdownToHtml.
  const ansiConverter = useMemo(() => createAnsiConverter(resolved, true), [resolved]);
  const ansiConverterNoEscape = useMemo(() => createAnsiConverter(resolved, false), [resolved]);

  const postPtyResize = useCallback(async (cols: number, rows: number) => {
    try {
      await apiFetch(`/api/pipeline/runs/${runId}/pty/resize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cols, rows }),
        silent: true,
      });
    } catch {
      // best effort — resize retries on the next fit cycle
    }
  }, [runId]);

  const writePtyChunk = useCallback((chunk: Uint8Array) => {
    if (xtermRef.current) {
      xtermRef.current.write(chunk as Parameters<Terminal['write']>[0]);
      return;
    }
    pendingPtyChunksRef.current.push(chunk);
  }, []);

  useEffect(() => {
    if (terminalMode !== 'pty' || !ptyContainerRef.current) return;

    const terminal = new Terminal({
      fontFamily: 'JetBrains Mono, Fira Code, monospace',
      fontSize: window.innerWidth < 768 ? 10 : 12,
      lineHeight: 1.3,
      convertEol: false,
      cursorBlink: true,
      scrollback: 10_000,
      allowProposedApi: false,
      theme: getPtyTheme(resolved),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(ptyContainerRef.current);
    fitAddon.fit();
    xtermRef.current = terminal;
    fitAddonRef.current = fitAddon;
    for (const chunk of pendingPtyChunksRef.current) {
      terminal.write(chunk as Parameters<Terminal['write']>[0]);
    }
    pendingPtyChunksRef.current = [];
    setPtyReady(true);

    const syncSize = () => {
      if (!fitAddonRef.current || !xtermRef.current) return;
      fitAddonRef.current.fit();
      const cols = xtermRef.current.cols;
      const rows = xtermRef.current.rows;
      if (cols > 0 && rows > 0) {
        void postPtyResize(cols, rows);
      }
    };

    syncSize();
    const observer = new ResizeObserver(() => {
      if (resizeDebounceRef.current) clearTimeout(resizeDebounceRef.current);
      resizeDebounceRef.current = setTimeout(syncSize, PTY_RESIZE_DEBOUNCE_MS);
    });
    observer.observe(ptyContainerRef.current);

    return () => {
      observer.disconnect();
      if (resizeDebounceRef.current) {
        clearTimeout(resizeDebounceRef.current);
        resizeDebounceRef.current = null;
      }
      fitAddonRef.current = null;
      xtermRef.current = null;
      terminal.dispose();
    };
  }, [postPtyResize, terminalMode]);

  useEffect(() => {
    if (terminalMode === 'pty' && xtermRef.current) {
      xtermRef.current.options.theme = getPtyTheme(resolved);
      fitAddonRef.current?.fit();
    }
  }, [resolved, terminalMode]);

  // Flush pending text buffer → convert via ansi-to-html → append to accumulated HTML.
  // Lines prefixed with HTML_LINE_PREFIX are pre-HTML (markdown already converted) — use no-escape converter.
  const flushBuffer = useCallback(() => {
    flushTimerRef.current = null;
    const pending = pendingTextRef.current;
    if (!pending) return;
    pendingTextRef.current = '';

    // Process line by line: pre-HTML lines go through no-escape converter, raw lines escape normally.
    const lines = pending.split('\n');
    const htmlLines = lines.map(line => {
      if (line.startsWith(HTML_LINE_PREFIX)) {
        return ansiConverterNoEscape.toHtml(line.slice(HTML_LINE_PREFIX.length));
      }
      return ansiConverter.toHtml(line);
    });
    let newHtml = htmlLines.join('\n');

    // Inject story ID anchors at first occurrence of each story ID
    newHtml = injectStoryAnchors(newHtml, seenStoryIdsRef.current);

    accumulatedHtmlRef.current += newHtml;
    accumulatedHtmlRef.current = trimOldestLines(accumulatedHtmlRef.current);

    const pre = preRef.current;
    if (pre) {
      pre.innerHTML = accumulatedHtmlRef.current;
      if (autoScrollRef.current) {
        pre.scrollTop = pre.scrollHeight;
      }
    }
  }, [ansiConverter, ansiConverterNoEscape]);

  // Schedule a flush if not already scheduled
  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current === null) {
      flushTimerRef.current = setTimeout(flushBuffer, FLUSH_INTERVAL_MS);
    }
  }, [flushBuffer]);

  // Expose scrollToStory + writeMarker via ref
  useImperativeHandle(ref, () => ({
    scrollToStory(storyId: string) {
      const pre = preRef.current;
      if (!pre) return;
      const anchor = pre.querySelector(`[data-story-id="${storyId}"]`);
      if (anchor) {
        anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      // Fallback: search text content for the story ID
      const text = pre.textContent ?? '';
      const idx = text.indexOf(storyId);
      if (idx === -1) return;
      const totalHeight = pre.scrollHeight;
      const totalLen = text.length;
      const ratio = idx / totalLen;
      pre.scrollTop = ratio * totalHeight;
    },
    writeMarker(text: string) {
      if (terminalMode === 'pty') {
        xtermRef.current?.writeln(text);
        return;
      }
      const markerHtml = `<div style="padding:4px 8px;margin:4px 0;background:rgba(59,130,246,0.15);border-left:3px solid #3b82f6;color:#93c5fd;font-size:11px;font-family:monospace;">${text.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>`;
      accumulatedHtmlRef.current += markerHtml;
      accumulatedHtmlRef.current = trimOldestLines(accumulatedHtmlRef.current);
      const pre = preRef.current;
      if (pre) {
        pre.innerHTML = accumulatedHtmlRef.current;
        if (autoScrollRef.current) {
          pre.scrollTop = pre.scrollHeight;
        }
      }
    },
  }), [terminalMode]);

  const handleCopy = useCallback(async () => {
    const pre = preRef.current;
    if (!pre) return;
    const text = pre.textContent ?? '';
    if (!text.trim()) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard not available */ }
  }, []);

  // SSE setup — streams output chunks into pending buffer, flushes every 80ms
  useEffect(() => {
    esRef.current?.close();
    pendingTextRef.current = '';
    accumulatedHtmlRef.current = '';
    seenStoryIdsRef.current = new Set();
    lineBufferRef.current = '';
    terminalModeRef.current = rendererMode;
    pendingPtyChunksRef.current = [];
    setAgentType('claude');
    setSteps([]);
    setExpandedSet(new Set());
    setStreamDone(false);
    setTerminalMode(rendererMode);
    if (rendererMode === 'pty' && !ptyReady) return;
    xtermRef.current?.clear();
    if (flushTimerRef.current !== null) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    if (preRef.current) preRef.current.innerHTML = '';

    // Connect to live output stream — scoped to workspace
    const outputParams = new URLSearchParams();
    if (workspaceId) outputParams.set('workspaceId', workspaceId);
    const outputUrl = `${BASE_URL}/api/pipeline/runs/${runId}/output${outputParams.toString() ? '?' + outputParams : ''}`;
    const es = new EventSource(outputUrl);
    esRef.current = es;

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
        const bytes = decodeBase64Chunk(e.data);

        if (terminalModeRef.current === 'pty') {
          writePtyChunk(bytes);
          return;
        }

        const text = new TextDecoder().decode(bytes);

        // Split into lines for semantic parsing and stream-json formatting
        lineBufferRef.current += text;
        const parts = lineBufferRef.current.split('\n');
        lineBufferRef.current = parts.pop() ?? '';

        const displayLines: string[] = [];
        const newSteps: SemanticStep[] = [];

        for (const part of parts) {
          const step = parseVerboseLine(part);
          if (step) newSteps.push(step);

          const formatted = formatStreamJsonForDisplay(part);
          if (formatted !== null) {
            displayLines.push(formatted);
          }
        }

        if (displayLines.length > 0) {
          pendingTextRef.current += displayLines.join('\n') + '\n';
          scheduleFlush();
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
      if (terminalModeRef.current !== 'pty') {
        if (flushTimerRef.current !== null) {
          clearTimeout(flushTimerRef.current);
          flushTimerRef.current = null;
        }
        if (lineBufferRef.current) {
          const finalStep = parseVerboseLine(lineBufferRef.current);
          if (finalStep) {
            setSteps(prev => [...prev, finalStep]);
          }
          const formatted = formatStreamJsonForDisplay(lineBufferRef.current);
          if (formatted !== null) {
            pendingTextRef.current += formatted + '\n';
          }
          lineBufferRef.current = '';
        }
        const pending = pendingTextRef.current;
        if (pending) {
          pendingTextRef.current = '';
          const lines = pending.split('\n');
          const htmlLines = lines.map(line => {
            if (line.startsWith(HTML_LINE_PREFIX)) {
              return ansiConverterNoEscape.toHtml(line.slice(HTML_LINE_PREFIX.length));
            }
            return ansiConverter.toHtml(line);
          });
          const newHtml = injectStoryAnchors(htmlLines.join('\n'), seenStoryIdsRef.current);
          accumulatedHtmlRef.current += newHtml;
          accumulatedHtmlRef.current = trimOldestLines(accumulatedHtmlRef.current);
          const pre = preRef.current;
          if (pre) {
            pre.innerHTML = accumulatedHtmlRef.current;
            if (autoScrollRef.current) {
              pre.scrollTop = pre.scrollHeight;
            }
          }
        }
      }
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

    return () => {
      es.close();
      if (flushTimerRef.current !== null) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
    };
  }, [runId, ansiConverter, ansiConverterNoEscape, ptyReady, rendererMode, scheduleFlush, workspaceId, writePtyChunk]);

  // Track scroll position for auto-scroll on raw <pre>
  const handlePreScroll = useCallback(() => {
    const el = preRef.current;
    if (!el) return;
    autoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_LOCK_THRESHOLD;
  }, []);

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
        {terminalMode !== 'pty' && (
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
        )}

        {/* Agent type badge (shown when not claude) */}
        {isOpenCode && (
          <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-400 font-medium">
            OpenCode
          </span>
        )}
        {terminalMode === 'pty' && (
          <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-medium">
            Native PTY
          </span>
        )}

        {/* Copy button (raw mode only) */}
        {terminalMode !== 'pty' && mode === 'raw' && (
          <button
            onClick={handleCopy}
            className="ml-auto p-1.5 rounded-md text-muted hover:text-[var(--text)] transition-colors"
            title="Copy execution trace output"
            aria-label="Copy execution trace output"
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
        )}
      </div>

      {/* ─── Content area ────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 relative">
        {/* Raw terminal — ansi-to-html rendered <pre> */}
        {terminalMode === 'pty' ? (
          <div
            ref={ptyContainerRef}
            className="h-full w-full overflow-hidden"
            style={{ background: resolved === 'dark' ? '#0d1117' : '#ffffff' }}
          />
        ) : (
          <pre
            ref={preRef}
            onScroll={handlePreScroll}
            className="h-full w-full overflow-y-auto font-mono text-xs leading-[1.3] whitespace-pre-wrap break-words"
            style={{
              background: 'var(--terminal-bg)',
              color: 'var(--terminal-fg)',
              padding: '8px 12px',
              margin: 0,
              display: mode === 'raw' ? 'block' : 'none',
              fontFamily: '"JetBrains Mono", "Cascadia Code", "SF Mono", Menlo, Monaco, monospace',
              fontSize: window.innerWidth < 768 ? '10px' : '12px',
            }}
          />
        )}

        {/* Semantic step list */}
        {terminalMode !== 'pty' && mode === 'semantic' && (
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
