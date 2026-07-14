/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
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
import { getAgentBadgeLabel, getAgentBadgeToneClassName, normalizeAgentType } from '../lib/agent-display';

export interface RunTerminalHandle {
  scrollToStory: (storyId: string) => void;
  writeMarker: (text: string) => void;
}

interface RunTerminalProps {
  runId: number;
  workspaceId?: string | null;
  terminalMode?: TerminalMode;
  runStatus?: RunLifecycleStatus | null;
}

type TerminalMode = 'ansi-html' | 'pty';
type RunLifecycleStatus = string;

interface RunTerminalMetaState {
  requestedTerminalMode: TerminalMode;
  isPty: boolean;
  ptyAvailable?: boolean;
  ptyUnavailableHint?: string | null;
  ptySessionStatus?: string | null;
  ptyProcessAlive?: boolean | null;
  ptyLastOutputAt?: string | null;
  ptyLastHeartbeatAt?: string | null;
  ptyCompletionMarkerSeen?: boolean;
  ptyCompletionMarkerSeenAt?: string | null;
  ptyTotalOutputBytes?: number;
}

type SseConnectionState = 'connecting' | 'alive' | 'stale' | 'error' | 'closed';

function coerceTerminalMode(value: unknown): TerminalMode | null {
  return value === 'pty' || value === 'ansi-html' ? value : null;
}

function isTerminalRunStatus(status: RunLifecycleStatus | null | undefined): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled' || status === 'partial_failure';
}

function isoToMs(value?: string | null): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function isRecentMs(ts: number | null, now: number, windowMs: number): boolean {
  return ts !== null && now - ts >= 0 && now - ts <= windowMs;
}

function formatAge(ts: number | null, now: number): string {
  if (ts === null) return 'never';
  const seconds = Math.max(0, Math.floor((now - ts) / 1000));
  if (seconds < 2) return 'now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ago`;
}

function HealthPill({ label, state, title }: { label: string; state: 'ok' | 'warn' | 'muted' | 'bad'; title?: string }) {
  const tone = state === 'ok'
    ? 'var(--success)'
    : state === 'warn'
      ? 'var(--warning)'
      : state === 'bad'
        ? 'var(--error)'
        : 'var(--text-muted)';
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium"
      style={{ color: tone, borderColor: tone, background: 'color-mix(in srgb, currentColor 10%, transparent)' }}
      title={title}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: tone }} />
      {label}
    </span>
  );
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

interface PtyDisplayScrubberState {
  pendingLine: string;
  suppressingInjectedContext: boolean;
  noticeShown: boolean;
}

function createPtyDisplayScrubberState(): PtyDisplayScrubberState {
  return {
    pendingLine: '',
    suppressingInjectedContext: false,
    noticeShown: false,
  };
}

const ANSI_ESCAPE_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function normalizePtyDisplayLine(line: string): string {
  return line.replace(ANSI_ESCAPE_PATTERN, '').replace(/\r/g, '').trim();
}

function isInjectedPromptContextStart(line: string): boolean {
  return line === '=== RETRIEVED MEMORY CONTEXT ==='
    || line === '## Retrieved Memory Context'
    || line === '## Rorca Pi Story Context'
    || line === '## Acceptance Criteria'
    || line === '## Done Definition'
    || line === '## Candidate Files'
    || line === '## Candidate Tests'
    || line === '## Expected Artifacts'
    || line === '## Validation Plan'
    || line === 'You are implementing a code change in this repository.'
    || line.startsWith('Progress log path: ')
    || line.startsWith('No prompt provided. Either specify one as an argument or pipe the prompt into stdin.');
}

function isInjectedPromptContextEnd(line: string): boolean {
  return line.startsWith('{')
    || line.startsWith('[')
    || line.startsWith('Error:')
    || line.startsWith('Launching ')
    || line.startsWith('Running ')
    || line.startsWith('Done.')
    || line.startsWith('Attempt failed:')
    || line.startsWith('Validation failed:');
}

function scrubPtyDisplayLine(lineWithNewline: string, state: PtyDisplayScrubberState): string {
  const normalized = normalizePtyDisplayLine(lineWithNewline);

  if (state.suppressingInjectedContext) {
    if (isInjectedPromptContextEnd(normalized)) {
      state.suppressingInjectedContext = false;
      return scrubPtyDisplayLine(lineWithNewline, state);
    }
    return '';
  }

  if (isInjectedPromptContextStart(normalized)) {
    state.suppressingInjectedContext = true;
    if (state.noticeShown) return '';
    state.noticeShown = true;
    return '\r\n[Rorca] Suppressed injected prompt/context echo. Use Semantic/Context tabs for structured context.\r\n';
  }

  return lineWithNewline;
}

function scrubPtyDisplayText(input: string, state: PtyDisplayScrubberState): string {
  state.pendingLine += input;
  const pieces = state.pendingLine.split(/(?<=\n)/);
  const last = pieces[pieces.length - 1] ?? '';
  const hasOpenLine = last !== '' && !last.endsWith('\n');
  state.pendingLine = hasOpenLine ? last : '';
  const completeLines = hasOpenLine ? pieces.slice(0, -1) : pieces;
  return completeLines.map(line => scrubPtyDisplayLine(line, state)).join('');
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

function encodeUtf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
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

const RunTerminal = forwardRef<RunTerminalHandle, RunTerminalProps>(function RunTerminal({ runId, workspaceId, terminalMode: rendererMode = 'ansi-html', runStatus = null }, ref) {
  const preRef = useRef<HTMLPreElement>(null);
  const ptyContainerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const pendingPtyChunksRef = useRef<Uint8Array[]>([]);
  const ptyDisplayScrubberRef = useRef<PtyDisplayScrubberState>(createPtyDisplayScrubberState());
  const ptyDisplayDecoderRef = useRef(new TextDecoder());
  const ptyDisplayEncoderRef = useRef(new TextEncoder());
  const pendingPtyInputRef = useRef('');
  const ptyInputFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ptyInputQueueRef = useRef(Promise.resolve());
  const resizeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const { resolved } = useTheme();
  const resolvedRef = useRef(resolved);
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
  const [agentType, setAgentType] = useState<string>('unknown');
  const [terminalMode, setTerminalMode] = useState<TerminalMode>(rendererMode);
  const terminalModeRef = useRef<TerminalMode>(rendererMode);
  const [terminalMeta, setTerminalMeta] = useState<RunTerminalMetaState>(() => ({
    requestedTerminalMode: rendererMode,
    isPty: rendererMode === 'pty',
  }));
  const runStatusRef = useRef<RunLifecycleStatus | null>(runStatus);
  const ptySessionStatusRef = useRef<string | null | undefined>(terminalMeta.ptySessionStatus);
  const [runMetaResolved, setRunMetaResolved] = useState(false);
  const [ptyReady, setPtyReady] = useState(rendererMode !== 'pty');
  const [ptyFocused, setPtyFocused] = useState(false);
  const [ptyInputHealthy, setPtyInputHealthy] = useState(true);
  const [sseState, setSseState] = useState<SseConnectionState>('connecting');
  const [lastSseAt, setLastSseAt] = useState<number | null>(null);
  const [lastPtyByteAt, setLastPtyByteAt] = useState<number | null>(null);
  const [lastSemanticAt, setLastSemanticAt] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());

  // Toggle state — persisted per run in localStorage
  const [mode, setMode] = useState<'raw' | 'semantic'>(() => loadMode(runId));

  // Semantic step state
  const [steps, setSteps] = useState<SemanticStep[]>([]);
  const [expandedSet, setExpandedSet] = useState<Set<number>>(new Set());
  const [autoScroll, setAutoScroll] = useState(true);
  const stepListRef = useRef<HTMLDivElement>(null);
  const stepBottomRef = useRef<HTMLDivElement>(null);
  const [streamDone, setStreamDone] = useState(false);
  const [replayTruncatedFrom, setReplayTruncatedFrom] = useState<number | null>(null);

  useEffect(() => {
    resolvedRef.current = resolved;
  }, [resolved]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowTick(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    terminalModeRef.current = terminalMode;
  }, [terminalMode]);

  useEffect(() => {
    runStatusRef.current = runStatus;
    ptySessionStatusRef.current = terminalMeta.ptySessionStatus;
  }, [runStatus, terminalMeta.ptySessionStatus]);

  useEffect(() => {
    terminalModeRef.current = rendererMode;
    setTerminalMode(rendererMode);
    setTerminalMeta({
      requestedTerminalMode: rendererMode,
      isPty: rendererMode === 'pty',
      ptyAvailable: undefined,
      ptyUnavailableHint: null,
    });
    setRunMetaResolved(false);
    setPtyReady(rendererMode !== 'pty');
  }, [rendererMode]);

  // Persist mode changes
  const handleSetMode = useCallback((m: 'raw' | 'semantic') => {
    setMode(m);
    try { localStorage.setItem(lsKey(runId), m); } catch { /* noop */ }
  }, [runId]);

  const resolvedMode = terminalMode === 'pty' ? 'raw' : mode;

  // Recreate ansi-to-html converters when theme changes.
  // ansiConverter: escapeXML=true for raw terminal lines (ANSI codes, plain text).
  // ansiConverterNoEscape: escapeXML=false for lines already HTML-converted by markdownToHtml.
  const ansiConverter = useMemo(() => createAnsiConverter(resolved, true), [resolved]);
  const ansiConverterNoEscape = useMemo(() => createAnsiConverter(resolved, false), [resolved]);

  const postPtyResize = useCallback(async (cols: number, rows: number) => {
    // PTY resize is only valid while the backend PTY session is active. Finished
    // runs still render replay output, but the backend correctly rejects resize
    // mutations with 409; avoid spamming the console/network panel for archived
    // run views. Preserve test/back-compat behavior when runStatus is omitted.
    const canResize = runStatus == null || runStatus === 'running' || runStatus === 'paused' || runStatus === 'blocked';
    if (!canResize) return;

    try {
      await apiFetch(`/api/pipeline/runs/${runId}/pty/resize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cols, rows }),
        silent: true,
      });
    } catch {
      // best effort — resize retries on the next fit cycle while active
    }
  }, [runId, runStatus]);

  const flushPtyInput = useCallback(() => {
    ptyInputFlushRef.current = null;
    const data = pendingPtyInputRef.current;
    if (!data) return;
    pendingPtyInputRef.current = '';
    const dataBase64 = encodeUtf8Base64(data);
    ptyInputQueueRef.current = ptyInputQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        await apiFetch(`/api/pipeline/runs/${runId}/input`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dataBase64 }),
          silent: true,
        });
        setPtyInputHealthy(true);
      })
      .catch(() => {
        setPtyInputHealthy(false);
      });
  }, [runId]);

  const queuePtyInput = useCallback((data: string) => {
    const currentRunStatus = runStatusRef.current;
    const currentSessionStatus = ptySessionStatusRef.current;
    const runAllowsInput = currentRunStatus == null || currentRunStatus === 'running' || currentRunStatus === 'paused' || currentRunStatus === 'blocked';
    const sessionAllowsInput = currentSessionStatus === 'active'
      || (currentRunStatus == null && currentSessionStatus == null);
    if (!runAllowsInput || !sessionAllowsInput) return;
    pendingPtyInputRef.current += data;
    if (ptyInputFlushRef.current === null) {
      ptyInputFlushRef.current = setTimeout(flushPtyInput, 20);
    }
  }, [flushPtyInput]);

  const markSseEvent = useCallback(() => {
    const now = Date.now();
    setLastSseAt(now);
    setSseState('alive');
  }, []);

  const writePtyChunk = useCallback((chunk: Uint8Array) => {
    const text = ptyDisplayDecoderRef.current.decode(chunk, { stream: true });
    const scrubbed = scrubPtyDisplayText(text, ptyDisplayScrubberRef.current);
    if (!scrubbed) return;

    const displayChunk = ptyDisplayEncoderRef.current.encode(scrubbed);
    if (xtermRef.current) {
      xtermRef.current.write(displayChunk as Parameters<Terminal['write']>[0]);
      return;
    }
    pendingPtyChunksRef.current.push(displayChunk);
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
      theme: getPtyTheme(resolvedRef.current),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    const container = ptyContainerRef.current;
    terminal.open(container);
    fitAddon.fit();
    const inputDisposable = terminal.onData(queuePtyInput);
    const handleFocusIn = () => setPtyFocused(true);
    const handleFocusOut = () => setPtyFocused(false);
    container.addEventListener('focusin', handleFocusIn);
    container.addEventListener('focusout', handleFocusOut);
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
      if (ptyInputFlushRef.current) {
        clearTimeout(ptyInputFlushRef.current);
        flushPtyInput();
      }
      inputDisposable.dispose();
      container.removeEventListener('focusin', handleFocusIn);
      container.removeEventListener('focusout', handleFocusOut);
      fitAddonRef.current = null;
      xtermRef.current = null;
      setPtyFocused(false);
      terminal.dispose();
    };
  }, [flushPtyInput, postPtyResize, queuePtyInput, terminalMode]);

  useEffect(() => {
    if (terminalMode === 'pty' && xtermRef.current) {
      xtermRef.current.options.theme = getPtyTheme(resolved);
      fitAddonRef.current?.fit();
    }
  }, [resolved, terminalMode]);

  // Initial resize can race PTY creation. Retry once the backend confirms the
  // session is active so the child starts with the browser's actual dimensions.
  useEffect(() => {
    if (terminalMode !== 'pty' || terminalMeta.ptySessionStatus !== 'active') return;
    const terminal = xtermRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) return;
    fitAddon.fit();
    void postPtyResize(terminal.cols, terminal.rows);
  }, [postPtyResize, terminalMeta.ptySessionStatus, terminalMode]);

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
    ptyDisplayScrubberRef.current = createPtyDisplayScrubberState();
    ptyDisplayDecoderRef.current = new TextDecoder();
    setAgentType('claude');
    setSteps([]);
    setExpandedSet(new Set());
    setStreamDone(false);
    setReplayTruncatedFrom(null);
    setPtyInputHealthy(true);
    setSseState('connecting');
    setLastSseAt(null);
    setLastPtyByteAt(null);
    setLastSemanticAt(null);
    setTerminalMode(rendererMode);
    setTerminalMeta({
      requestedTerminalMode: rendererMode,
      isPty: rendererMode === 'pty',
      ptyAvailable: undefined,
      ptyUnavailableHint: null,
    });
    setRunMetaResolved(false);
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

    type PtyHealthMeta = {
      ptySessionStatus?: string | null;
      pty_session_status?: string | null;
      ptyProcessAlive?: boolean | null;
      pty_process_alive?: boolean | null;
      ptyLastOutputAt?: string | null;
      pty_last_output_at?: string | null;
      ptyLastHeartbeatAt?: string | null;
      pty_last_heartbeat_at?: string | null;
      ptyCompletionMarkerSeen?: boolean;
      pty_completion_marker_seen?: boolean;
      ptyCompletionMarkerSeenAt?: string | null;
      pty_completion_marker_seen_at?: string | null;
      ptyTotalOutputBytes?: number;
      pty_total_output_bytes?: number;
    };

    const applyPtyHealthMeta = (meta: PtyHealthMeta) => {
      setTerminalMeta(prev => ({
        ...prev,
        ptySessionStatus: meta.ptySessionStatus ?? meta.pty_session_status ?? prev.ptySessionStatus ?? null,
        ptyProcessAlive: meta.ptyProcessAlive ?? meta.pty_process_alive ?? prev.ptyProcessAlive ?? null,
        ptyLastOutputAt: meta.ptyLastOutputAt ?? meta.pty_last_output_at ?? prev.ptyLastOutputAt ?? null,
        ptyLastHeartbeatAt: meta.ptyLastHeartbeatAt ?? meta.pty_last_heartbeat_at ?? prev.ptyLastHeartbeatAt ?? null,
        ptyCompletionMarkerSeen: meta.ptyCompletionMarkerSeen ?? meta.pty_completion_marker_seen ?? prev.ptyCompletionMarkerSeen ?? false,
        ptyCompletionMarkerSeenAt: meta.ptyCompletionMarkerSeenAt ?? meta.pty_completion_marker_seen_at ?? prev.ptyCompletionMarkerSeenAt ?? null,
        ptyTotalOutputBytes: meta.ptyTotalOutputBytes ?? meta.pty_total_output_bytes ?? prev.ptyTotalOutputBytes ?? 0,
      }));
    };

    es.onopen = () => markSseEvent();

    // Listen for run metadata (agent type + authoritative renderer/fallback state)
    es.addEventListener('run_meta', (e: MessageEvent) => {
      markSseEvent();
      try {
        const meta = JSON.parse(e.data) as PtyHealthMeta & {
          agentType?: string;
          terminalMode?: string;
          terminal_mode?: string;
          requestedTerminalMode?: string;
          requested_terminal_mode?: string;
          isPty?: boolean;
          ptyAvailable?: boolean;
          ptyUnavailableHint?: string | null;
          pty_unavailable_hint?: string | null;
        };
        setRunMetaResolved(true);
        if (typeof meta.agentType === 'string' && meta.agentType.trim()) {
          setAgentType(meta.agentType);
        }

        const nextTerminalMode = coerceTerminalMode(meta.terminalMode ?? meta.terminal_mode);
        if (nextTerminalMode) {
          terminalModeRef.current = nextTerminalMode;
          setTerminalMode(nextTerminalMode);
          if (nextTerminalMode !== 'pty') {
            setPtyReady(true);
          }
        }

        const requestedTerminalMode = coerceTerminalMode(meta.requestedTerminalMode ?? meta.requested_terminal_mode)
          ?? nextTerminalMode
          ?? rendererMode;
        const isPty = typeof meta.isPty === 'boolean'
          ? meta.isPty
          : (nextTerminalMode ?? terminalModeRef.current) === 'pty';
        const ptyUnavailableHint = typeof (meta.ptyUnavailableHint ?? meta.pty_unavailable_hint) === 'string'
          ? (meta.ptyUnavailableHint ?? meta.pty_unavailable_hint) as string
          : null;
        setTerminalMeta(prev => ({
          ...prev,
          requestedTerminalMode,
          isPty,
          ptyAvailable: typeof meta.ptyAvailable === 'boolean' ? meta.ptyAvailable : undefined,
          ptyUnavailableHint,
        }));
        applyPtyHealthMeta(meta);
      } catch { /* ignore */ }
    });

    es.addEventListener('pty_health', (e: MessageEvent) => {
      markSseEvent();
      try {
        applyPtyHealthMeta(JSON.parse(e.data) as PtyHealthMeta);
      } catch { /* ignore malformed health */ }
    });

    es.addEventListener('replay_truncated', (e: MessageEvent) => {
      markSseEvent();
      try {
        const payload = JSON.parse(e.data) as { fromSequence?: unknown };
        const fromSequence = Number(payload.fromSequence);
        if (Number.isSafeInteger(fromSequence) && fromSequence > 1) {
          setReplayTruncatedFrom(fromSequence);
        }
      } catch { /* ignore malformed replay metadata */ }
    });

    es.addEventListener('chunk', (e: MessageEvent) => {
      markSseEvent();
      try {
        const bytes = decodeBase64Chunk(e.data);

        if (terminalModeRef.current === 'pty') {
          setLastPtyByteAt(Date.now());
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
          setLastSemanticAt(Date.now());
          setSteps(prev => [...prev, ...newSteps]);
        }
      } catch { /* ignore malformed chunk */ }
    });

    // Also accept structured semantic_step events from backend if available
    es.addEventListener('semantic_step', (e: MessageEvent) => {
      markSseEvent();
      try {
        const step: SemanticStep = JSON.parse(e.data);
        setLastSemanticAt(Date.now());
        setSteps(prev => [...prev, step]);
      } catch { /* ignore malformed step */ }
    });

    es.addEventListener('done', () => {
      markSseEvent();
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
      setSseState(es.readyState === EventSource.CLOSED ? 'closed' : 'error');
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
  }, [runId, ansiConverter, ansiConverterNoEscape, markSseEvent, ptyReady, rendererMode, scheduleFlush, workspaceId, writePtyChunk]);

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
  const normalizedAgentType = normalizeAgentType(agentType);
  const isOpenCode = normalizedAgentType === 'opencode' || normalizedAgentType === 'codex';
  const showAgentBadge = normalizedAgentType !== 'claude' && normalizedAgentType !== 'unknown';
  const ptyFallbackActive = terminalMeta.requestedTerminalMode === 'pty' && (!terminalMeta.isPty || terminalMode !== 'pty');
  const ptyFallbackReason = terminalMeta.ptyAvailable === false
    ? 'node-pty is unavailable on this server.'
    : 'The PTY session did not start or is no longer attachable.';
  const ptyFallbackHint = terminalMeta.ptyUnavailableHint?.trim();
  const streamEnded = streamDone || isTerminalRunStatus(runStatus);
  const sseRecentlyAlive = isRecentMs(lastSseAt, nowTick, 10_000);
  const effectiveSseState: SseConnectionState = streamEnded
    ? 'closed'
    : sseState === 'alive' && !sseRecentlyAlive
      ? 'stale'
      : sseState;
  const lastPtyOutputMs = isoToMs(terminalMeta.ptyLastOutputAt) ?? lastPtyByteAt;
  const ptyBytesRecent = isRecentMs(lastPtyByteAt ?? lastPtyOutputMs, nowTick, 10_000);
  const semanticRecent = isRecentMs(lastSemanticAt, nowTick, 10_000);
  const ptyProcessAlive = terminalMeta.ptyProcessAlive === true || (terminalMode === 'pty' && terminalMeta.ptySessionStatus === 'active' && !streamEnded);
  const resolvingEffectiveMode = terminalMeta.requestedTerminalMode === 'pty' && !runMetaResolved;
  const ansiSurfaceKind = resolvedMode === 'semantic' ? 'Semantic transcript' : 'ANSI transcript';
  const surfaceLabel = resolvingEffectiveMode
    ? 'Checking PTY support'
    : terminalMode === 'pty'
      ? streamEnded
        ? 'PTY terminal replay'
        : !ptyInputHealthy
          ? 'PTY live terminal • input issue'
          : ptyFocused
            ? 'PTY live terminal • focused'
            : 'PTY live terminal • click to focus'
      : ptyFallbackActive
        ? `PTY unavailable — ANSI transcript • ${streamEnded ? 'replay' : 'live'}`
        : `${ansiSurfaceKind} • ${streamEnded ? 'replay' : 'live'}`;
  const surfaceTone = resolvingEffectiveMode
    ? 'var(--text-muted)'
    : terminalMode === 'pty'
      ? streamEnded ? 'var(--text-muted)' : ptyInputHealthy ? 'var(--success)' : 'var(--warning)'
      : ptyFallbackActive ? 'var(--warning)' : resolvedMode === 'semantic' ? 'var(--accent)' : 'var(--text-muted)';
  const surfaceTitle = resolvingEffectiveMode
    ? 'Waiting for backend metadata before choosing full PTY attachment or ANSI fallback.'
    : terminalMode === 'pty'
      ? streamEnded
        ? 'The PTY session has ended; this xterm.js pane is replaying captured PTY output and keyboard input is disabled.'
        : ptyInputHealthy
          ? 'Real xterm.js PTY attachment. Focus the pane to send keyboard input.'
          : 'PTY output is visible, but input delivery failed; this may be output-only until the connection recovers.'
      : ptyFallbackActive
        ? `Requested full PTY, but ${ptyFallbackReason} Showing ${streamEnded ? 'an ANSI transcript replay' : 'a live ANSI transcript'} without terminal input.`
        : `${ansiSurfaceKind} ${streamEnded ? 'replay from saved chunks' : 'live stream'}; this is not a PTY attachment.`;
  const modeHelpText = resolvingEffectiveMode
    ? 'Checking whether a real xterm.js PTY is available. Rorca will attach to the PTY when supported, or degrade to ANSI output when it is not.'
    : terminalMode === 'pty'
      ? streamEnded
        ? 'This run used a real xterm.js PTY while active. The session is now detached or exited, so this view is replay-only.'
        : 'Full PTY attachment: Rorca is using a real xterm.js terminal with stdin/stdout when supported. If the PTY cannot start, this view degrades to ANSI output.'
      : ptyFallbackActive
        ? `PTY unavailable — ANSI transcript: Rorca degraded to ${streamEnded ? 'ANSI replay' : 'a live ANSI transcript'} because ${ptyFallbackReason.toLowerCase()} Keyboard input is not attached.${ptyFallbackHint ? ` PTY prerequisite: ${ptyFallbackHint}` : ''}`
        : `${ansiSurfaceKind} ${streamEnded ? 'replay' : 'stream'}: captured transcript output only, not a live PTY. Raw/Semantic controls are available only in ANSI mode; PTY-capable runs use xterm.js when supported and degrade here when not.`;

  return (
    <div className="h-full w-full flex flex-col">
      {/* ─── Toolbar ─────────────────────────────────────────────────────── */}
      <div className="shrink-0 px-3 py-1.5 border-b border-border bg-panel flex items-center gap-1">
        {terminalMode !== 'pty' && (
          <>
            <button
              onClick={() => handleSetMode('raw')}
              className={`px-2 py-1 text-[11px] font-medium rounded transition-colors ${
                resolvedMode === 'raw'
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
                resolvedMode === 'semantic'
                  ? 'bg-accent/15 text-accent'
                  : 'text-muted hover:text-[var(--text)]'
              }`}
            >
              <span className="flex items-center gap-1">
                <Layers size={11} />
                Semantic
              </span>
            </button>
          </>
        )}

        {/* Agent type badge (shown when not claude) */}
        {showAgentBadge && (
          <span className={`ml-1 text-[10px] px-1.5 py-0.5 rounded font-medium ${getAgentBadgeToneClassName(agentType)}`}>
            {getAgentBadgeLabel(agentType, null, { showOpenCodeModel: false })}
          </span>
        )}
        <span
          className="ml-1 text-[10px] px-1.5 py-0.5 rounded border font-medium"
          style={{
            color: surfaceTone,
            borderColor: surfaceTone,
            background: 'color-mix(in srgb, currentColor 12%, transparent)',
          }}
          title={surfaceTitle}
        >
          {surfaceLabel}
        </span>

        {/* Copy button (raw mode only) */}
        {terminalMode !== 'pty' && resolvedMode === 'raw' && (
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

      <div className="shrink-0 border-b border-border/70 bg-panel/70 px-3 py-1.5 text-[11px] leading-snug text-muted">
        {modeHelpText}
      </div>

      <div className="shrink-0 border-b border-border/60 bg-panel/50 px-3 py-1.5 flex flex-wrap items-center gap-1.5">
        <HealthPill
          label={`SSE ${effectiveSseState}`}
          state={effectiveSseState === 'alive' ? 'ok' : effectiveSseState === 'connecting' || effectiveSseState === 'stale' ? 'warn' : streamEnded ? 'muted' : 'bad'}
          title={`Backend SSE connection; last event ${formatAge(lastSseAt, nowTick)}.`}
        />
        {terminalMeta.requestedTerminalMode === 'pty' ? (
          <>
            <HealthPill
              label={ptyProcessAlive ? 'PTY process alive' : terminalMeta.ptySessionStatus ? `PTY ${terminalMeta.ptySessionStatus}` : 'PTY pending'}
              state={ptyProcessAlive ? 'ok' : streamEnded ? 'muted' : 'warn'}
              title={`PTY session status: ${terminalMeta.ptySessionStatus ?? 'unknown'}. Heartbeat: ${formatAge(isoToMs(terminalMeta.ptyLastHeartbeatAt), nowTick)}.`}
            />
            <HealthPill
              label={ptyBytesRecent ? 'PTY bytes recent' : `PTY bytes ${formatAge(lastPtyOutputMs, nowTick)}`}
              state={ptyBytesRecent ? 'ok' : streamEnded ? 'muted' : 'warn'}
              title={`Raw node-pty bytes received/persisted. Total bytes: ${terminalMeta.ptyTotalOutputBytes ?? 0}. Last byte: ${formatAge(lastPtyOutputMs, nowTick)}.`}
            />
            <HealthPill
              label={terminalMeta.ptyCompletionMarkerSeen ? 'completion marker seen' : 'completion marker pending'}
              state={terminalMeta.ptyCompletionMarkerSeen ? 'ok' : streamEnded ? 'muted' : 'warn'}
              title={`Completion marker only means the agent turn ended; story pass still requires merge + validation. Seen: ${formatAge(isoToMs(terminalMeta.ptyCompletionMarkerSeenAt), nowTick)}.`}
            />
          </>
        ) : null}
        <HealthPill
          label={semanticRecent ? 'semantic recent' : `semantic ${formatAge(lastSemanticAt, nowTick)}`}
          state={semanticRecent ? 'ok' : terminalMode === 'pty' ? 'muted' : streamEnded ? 'muted' : 'warn'}
          title={terminalMode === 'pty' ? 'Semantic events are best-effort in PTY mode; raw PTY bytes are the activity source of truth.' : `Last semantic event ${formatAge(lastSemanticAt, nowTick)}.`}
        />
      </div>

      {replayTruncatedFrom !== null && (
        <div className="shrink-0 border-b border-border bg-[var(--bg)] px-3 py-1.5 text-[11px] text-muted" role="status">
          Showing a bounded recent replay from output sequence {replayTruncatedFrom}. Live output and reconnect resume remain lossless.
        </div>
      )}

      {ptyFallbackActive && (
        <div className="shrink-0 border-b border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
          <div className="flex items-start gap-2">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <div className="space-y-0.5">
              <div className="font-semibold">PTY unavailable — ANSI transcript</div>
              <div className="text-[var(--text)]">
                {ptyFallbackReason} Showing {streamEnded ? 'ANSI replay' : 'the live ANSI transcript'} instead of a full PTY attachment; keyboard input is not attached.
                {ptyFallbackHint ? ` PTY prerequisite: ${ptyFallbackHint}` : ''}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ─── Content area ────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 relative">
        {/* Raw terminal — ansi-to-html rendered <pre> */}
        {terminalMode === 'pty' ? (
          <div
            ref={ptyContainerRef}
            className="h-full w-full overflow-hidden outline-none"
            data-terminal-input="true"
            onMouseDown={() => xtermRef.current?.focus()}
            style={{ background: 'var(--terminal-bg)' }}
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
              display: resolvedMode === 'raw' ? 'block' : 'none',
              fontFamily: '"JetBrains Mono", "Cascadia Code", "SF Mono", Menlo, Monaco, monospace',
              fontSize: window.innerWidth < 768 ? '10px' : '12px',
            }}
          />
        )}

        {/* Semantic step list */}
        {terminalMode !== 'pty' && resolvedMode === 'semantic' && (
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
