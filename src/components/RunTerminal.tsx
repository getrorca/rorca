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
  FilePlus, Globe, Clock, BookOpen,
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
import RunTranscript from './RunTranscript';

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

type TerminalMode = 'ansi-html' | 'pty' | 'native-pty';
type RunLifecycleStatus = string;

interface RunTerminalMetaState {
  requestedTerminalMode: TerminalMode;
  isPty: boolean;
  ptyAvailable?: boolean;
  ptyUnavailableHint?: string | null;
  ptyGenerationId?: string | null;
  ptyGenerationToken?: string | null;
  ptyStoryId?: string | null;
  ptyAttempt?: number | null;
  ptyGenerationStatus?: string | null;
  ptyGenerationActive?: boolean;
  ptyGenerationSource?: 'native' | 'legacy' | null;
  ptyGenerationReplaySource?: 'generation' | 'legacy_run_output' | 'legacy_pty_output' | null;
  ptySessionStatus?: string | null;
  ptyProcessAlive?: boolean | null;
  ptyLastOutputAt?: string | null;
  ptyLastHeartbeatAt?: string | null;
  ptyCompletionMarkerSeen?: boolean;
  ptyCompletionMarkerSeenAt?: string | null;
  /** Primary turn-completion evidence; never a story pass/fail signal. */
  ptyCompletionFileSeen?: boolean;
  ptyCompletionFileSeenAt?: string | null;
  ptyCompletionFileError?: string | null;
  ptyPromptReadinessStatus?: string | null;
  ptyPromptReadinessReason?: string | null;
  ptyTotalOutputBytes?: number;
  ptyNextOutputSequence?: number;
  ptyCheckpointSequence?: number;
  ptyFirstRetainedSequence?: number;
  ptyCompactedByteCount?: number;
  ptyDroppedOutputBytes?: number;
  ptyOutputTruncated?: boolean;
  ptyOutputTruncatedAt?: string | null;
  transcriptAvailable?: boolean;
  archiveAvailable?: boolean;
  expectedMaxLatencyMs?: number | null;
}

type SseConnectionState = 'connecting' | 'alive' | 'reconnecting' | 'closed';
type TerminalLifecycleState = 'live' | 'waiting' | 'compacted' | 'gap' | 'reconnecting' | 'ended' | 'unavailable';
type TerminalViewMode = 'raw' | 'semantic' | 'transcript';

function coerceTerminalMode(value: unknown): TerminalMode | null {
  return value === 'pty' || value === 'native-pty' || value === 'ansi-html' ? value : null;
}

function isPtyTerminalMode(value: unknown): value is Extract<TerminalMode, 'pty' | 'native-pty'> {
  return value === 'pty' || value === 'native-pty';
}

function isTerminalRunStatus(status: RunLifecycleStatus | null | undefined): boolean {
  return status === 'finished' || status === 'done' || status === 'failed' || status === 'cancelled' || status === 'partial_failure';
}

function isoToMs(value?: string | null): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function isRecentMs(ts: number | null, now: number, windowMs: number): boolean {
  // `nowTick` updates once per second, so a just-arrived server timestamp can
  // be slightly ahead of it. Treat that as current rather than falsely stale.
  return ts !== null && now - ts >= -1_000 && now - ts <= windowMs;
}

function formatAge(ts: number | null, now: number): string {
  if (ts === null) return 'never';
  const seconds = Math.max(0, Math.floor((now - ts) / 1000));
  if (seconds < 2) return 'now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ago`;
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

function isHeartbeatStep(step: SemanticStep): boolean {
  return step.toolName === 'system' && /Agent (?:still )?running|PTY heartbeat/i.test(step.label + ' ' + (step.detail ?? ''));
}

function mergeSemanticSteps(prev: SemanticStep[], incoming: SemanticStep[]): SemanticStep[] {
  if (incoming.length === 0) return prev;
  const next = [...prev];
  for (const step of incoming) {
    if (isHeartbeatStep(step)) {
      const existingIndex = next.findIndex(isHeartbeatStep);
      if (existingIndex >= 0) {
        next[existingIndex] = step;
      } else {
        next.push(step);
      }
      continue;
    }
    next.push(step);
  }
  return next;
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

type OutputReplaySource = 'run_pty_output_chunks' | 'run_output_chunks';

function sourceStorageKey(runId: number): string {
  return `rorca:terminal-output-source:${runId}`;
}

function generationStorageKey(runId: number): string {
  return `rorca:terminal-output-generation:${runId}`;
}

function cursorStorageKey(runId: number, source: OutputReplaySource, generationId: string | null): string {
  return `rorca:terminal-output-cursor:${runId}:${source}:${generationId ?? 'legacy'}`;
}

function loadReceivedGenerationId(runId: number): string | null {
  try {
    return sessionStorage.getItem(generationStorageKey(runId));
  } catch {
    return null;
  }
}

function persistReceivedGenerationId(runId: number, generationId: string | null): void {
  try {
    if (generationId) sessionStorage.setItem(generationStorageKey(runId), generationId);
    else sessionStorage.removeItem(generationStorageKey(runId));
  } catch {
    // Session storage is an optimization for durable SSE replay, never a requirement.
  }
}

function isOutputReplaySource(value: unknown): value is OutputReplaySource {
  return value === 'run_pty_output_chunks' || value === 'run_output_chunks';
}

function loadReceivedOutputSource(runId: number): OutputReplaySource | null {
  try {
    const value = sessionStorage.getItem(sourceStorageKey(runId));
    return isOutputReplaySource(value) ? value : null;
  } catch {
    return null;
  }
}

function persistReceivedOutputSource(runId: number, source: OutputReplaySource): void {
  try {
    sessionStorage.setItem(sourceStorageKey(runId), source);
  } catch {
    // Session storage is an optimization for durable SSE replay, never a requirement.
  }
}

function clearReceivedSequence(runId: number, source: OutputReplaySource | null, generationId: string | null): void {
  if (!source) return;
  try {
    sessionStorage.removeItem(cursorStorageKey(runId, source, generationId));
  } catch {
    // Session storage is an optimization for durable SSE replay, never a requirement.
  }
}

function loadReceivedSequence(runId: number, source: OutputReplaySource | null, generationId: string | null): number {
  if (!source) return 0;
  try {
    const value = Number(sessionStorage.getItem(cursorStorageKey(runId, source, generationId)) ?? '');
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function persistReceivedSequence(
  runId: number,
  source: OutputReplaySource | null,
  generationId: string | null,
  sequence: number,
): void {
  if (!source || !Number.isSafeInteger(sequence) || sequence <= 0) return;
  try {
    sessionStorage.setItem(cursorStorageKey(runId, source, generationId), String(sequence));
  } catch {
    // Session storage is an optimization for durable SSE replay, never a requirement.
  }
}

function readChunkSequence(event: MessageEvent): number | null {
  const raw = event.lastEventId;
  const scoped = /^v1\|(?:run_pty_output_chunks|run_output_chunks)\|(?:legacy|[0-9a-f-]{36})\|(\d+)$/i.exec(raw);
  const sequence = Number(scoped?.[1] ?? raw);
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : null;
}

function loadMode(runId: number): TerminalViewMode {
  try {
    const value = localStorage.getItem(lsKey(runId));
    return value === 'semantic' || value === 'transcript' ? value : 'raw';
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
  const shouldHoldOpenLine = hasOpenLine && (
    state.suppressingInjectedContext || isInjectedPromptContextStart(normalizePtyDisplayLine(last))
  );
  state.pendingLine = shouldHoldOpenLine ? last : '';
  // PTYs frequently update prompts and progress without newlines. Do not hold
  // ordinary terminal bytes until a line terminator arrives: it looks like a
  // stalled terminal and can leave a split UTF-8 sequence out of order.
  const completeLines = shouldHoldOpenLine ? pieces.slice(0, -1) : pieces;
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
const PTY_INPUT_FLUSH_MS = 100;
const MAX_QUEUED_PTY_INPUT_BYTES = 256 * 1024;
const MAX_PTY_INPUT_REQUEST_BYTES = 64 * 1024;
const PTY_RECONNECT_DELAY_MS = 500;
const PTY_WRITE_FRAME_BUDGET_BYTES = 64 * 1024;
const MAX_PENDING_PTY_BYTES = 1024 * 1024;
const PTY_SCRUBBER_EXPANSION_HEADROOM_BYTES = 512;
const MAX_PENDING_ANSI_CHARS = 512 * 1024;
const MAX_ANSI_FLUSH_CHARS = 64 * 1024;
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
  const pendingPtyBytesRef = useRef(0);
  const ptyWriteFrameRef = useRef<number | null>(null);
  const ptyDisplayScrubberRef = useRef<PtyDisplayScrubberState>(createPtyDisplayScrubberState());
  const ptyDisplayDecoderRef = useRef(new TextDecoder());
  const ptyDisplayEncoderRef = useRef(new TextEncoder());
  const ansiDisplayDecoderRef = useRef(new TextDecoder());
  const pendingPtyInputRef = useRef('');
  const queuedPtyInputBytesRef = useRef(0);
  const ptyInputFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ptyInputQueueRef = useRef(Promise.resolve());
  const resizeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamKeyRef = useRef<string | null>(null);
  const recoverTerminalOnNextConnectRef = useRef(true);
  const lastReceivedSequenceRef = useRef(0);
  const outputReplaySourceRef = useRef<OutputReplaySource | null>(null);
  const ptyGenerationIdRef = useRef<string | null>(null);
  const ptyGenerationTokenRef = useRef<string | null>(null);
  const ptyProcessAliveRef = useRef(false);
  const activeResizeRetryRef = useRef(false);
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
  // Chunk ids already rendered for this EventSource lifecycle. The backend
  // replays historical PTY chunks before polling live chunks; this prevents a
  // replay/live race or browser reconnect from painting the same sequence twice.
  const seenChunkIdsRef = useRef(new Set<string>());

  // Agent type detected from backend run_meta SSE event
  const [agentType, setAgentType] = useState<string>('unknown');
  const [agentModel, setAgentModel] = useState<string | null>(null);
  const [terminalMode, setTerminalMode] = useState<TerminalMode>(rendererMode);
  const terminalModeRef = useRef<TerminalMode>(rendererMode);
  const [terminalMeta, setTerminalMeta] = useState<RunTerminalMetaState>(() => ({
    requestedTerminalMode: rendererMode,
    isPty: isPtyTerminalMode(rendererMode),
  }));
  const runStatusRef = useRef<RunLifecycleStatus | null>(runStatus);
  const ptySessionStatusRef = useRef<string | null | undefined>(terminalMeta.ptySessionStatus);
  const [runMetaResolved, setRunMetaResolved] = useState(false);
  const [ptyReady, setPtyReady] = useState(!isPtyTerminalMode(rendererMode));
  const [ptyFocused, setPtyFocused] = useState(false);
  const [ptyInputHealthy, setPtyInputHealthy] = useState(true);
  const [sseState, setSseState] = useState<SseConnectionState>('connecting');
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [ptyRenderBackpressure, setPtyRenderBackpressure] = useState(false);
  const [lastSseAt, setLastSseAt] = useState<number | null>(null);
  const [lastPtyByteAt, setLastPtyByteAt] = useState<number | null>(null);
  const [lastSemanticAt, setLastSemanticAt] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());

  const [hasViewportContent, setHasViewportContent] = useState(false);
  const hasViewportContentRef = useRef(false);
  const [checkpointRecoveryFailed, setCheckpointRecoveryFailed] = useState(false);
  const [statusAnnouncement, setStatusAnnouncement] = useState('');

  // Toggle state — persisted per run in localStorage
  const [mode, setMode] = useState<TerminalViewMode>(() => loadMode(runId));

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
      isPty: isPtyTerminalMode(rendererMode),
      ptyAvailable: undefined,
      ptyUnavailableHint: null,
    });
    setRunMetaResolved(false);
    setPtyReady(!isPtyTerminalMode(rendererMode));
  }, [rendererMode]);

  // Persist mode changes
  const handleSetMode = useCallback((m: TerminalViewMode) => {
    setMode(m);
    try { localStorage.setItem(lsKey(runId), m); } catch { /* noop */ }
  }, [runId]);

  const resolvedMode = mode;

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
    const generationToken = ptyGenerationTokenRef.current;
    const exactGenerationActive = ptySessionStatusRef.current === 'active' && ptyProcessAliveRef.current;
    if (!canResize || !exactGenerationActive || !generationToken) return;

    try {
      await apiFetch(`/api/pipeline/runs/${runId}/pty/resize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ generationToken, cols, rows }),
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
    const chunks: string[] = [];
    let chunk = '';
    let chunkBytes = 0;
    const encoder = new TextEncoder();
    for (const symbol of data) {
      const symbolBytes = encoder.encode(symbol).byteLength;
      if (chunk && chunkBytes + symbolBytes > MAX_PTY_INPUT_REQUEST_BYTES) {
        chunks.push(chunk);
        chunk = '';
        chunkBytes = 0;
      }
      chunk += symbol;
      chunkBytes += symbolBytes;
    }
    if (chunk) chunks.push(chunk);

    const generationToken = ptyGenerationTokenRef.current;
    if (!generationToken) return;
    for (const inputChunk of chunks) {
      const dataBase64 = encodeUtf8Base64(inputChunk);
      const dataBytes = encoder.encode(inputChunk).byteLength;
      ptyInputQueueRef.current = ptyInputQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          await apiFetch(`/api/pipeline/runs/${runId}/input`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ generationToken, dataBase64 }),
            silent: true,
          });
          setPtyInputHealthy(true);
        })
        .catch(() => {
          setPtyInputHealthy(false);
        })
        .finally(() => {
          queuedPtyInputBytesRef.current = Math.max(0, queuedPtyInputBytesRef.current - dataBytes);
        });
    }
  }, [runId]);

  const queuePtyInput = useCallback((data: string) => {
    const currentRunStatus = runStatusRef.current;
    const currentSessionStatus = ptySessionStatusRef.current;
    const runAllowsInput = currentRunStatus == null || currentRunStatus === 'running' || currentRunStatus === 'paused' || currentRunStatus === 'blocked';
    const sessionAllowsInput = currentSessionStatus === 'active' && ptyProcessAliveRef.current;
    if (!runAllowsInput || !sessionAllowsInput || !ptyGenerationTokenRef.current) return;
    const dataBytes = new TextEncoder().encode(data).byteLength;
    if (queuedPtyInputBytesRef.current + dataBytes > MAX_QUEUED_PTY_INPUT_BYTES) {
      setPtyInputHealthy(false);
      return;
    }
    queuedPtyInputBytesRef.current += dataBytes;
    pendingPtyInputRef.current += data;
    if (ptyInputFlushRef.current === null) {
      ptyInputFlushRef.current = setTimeout(flushPtyInput, PTY_INPUT_FLUSH_MS);
    }
  }, [flushPtyInput]);

  const markSseEvent = useCallback(() => {
    const now = Date.now();
    setLastSseAt(now);
    setSseState('alive');
  }, []);

  const schedulePtyWriteFlush = useCallback(() => {
    if (ptyWriteFrameRef.current !== null) return;
    ptyWriteFrameRef.current = window.requestAnimationFrame(() => {
      ptyWriteFrameRef.current = null;
      const terminal = xtermRef.current;
      if (!terminal) return;

      let written = 0;
      while (pendingPtyChunksRef.current.length > 0 && written < PTY_WRITE_FRAME_BUDGET_BYTES) {
        const chunk = pendingPtyChunksRef.current.shift()!;
        pendingPtyBytesRef.current -= chunk.byteLength;
        written += chunk.byteLength;
        terminal.write(chunk as Parameters<Terminal['write']>[0]);
      }

      if (pendingPtyChunksRef.current.length > 0) schedulePtyWriteFlush();
    });
  }, []);

  /**
   * xterm writes are intentionally frame-coalesced. EventSource can dispatch a
   * durable replay much faster than xterm can parse it; writing one chunk per
   * SSE callback starves input and paint. The byte cap gives the stream a
   * bounded, ordered backpressure boundary instead of an unbounded JS queue.
   */
  const writePtyChunk = useCallback((chunk: Uint8Array): boolean => {
    // Reject before advancing TextDecoder state so a durable replay starts at a
    // UTF-8 boundary identical to the one this terminal has already accepted.
    if (pendingPtyBytesRef.current + chunk.byteLength + PTY_SCRUBBER_EXPANSION_HEADROOM_BYTES > MAX_PENDING_PTY_BYTES) {
      setPtyRenderBackpressure(true);
      return false;
    }

    const text = ptyDisplayDecoderRef.current.decode(chunk, { stream: true });
    const scrubbed = scrubPtyDisplayText(text, ptyDisplayScrubberRef.current);
    if (!scrubbed) return true;

    const displayChunk = ptyDisplayEncoderRef.current.encode(scrubbed);
    if (pendingPtyBytesRef.current + displayChunk.byteLength > MAX_PENDING_PTY_BYTES) {
      setPtyRenderBackpressure(true);
      return false;
    }

    pendingPtyChunksRef.current.push(displayChunk);
    pendingPtyBytesRef.current += displayChunk.byteLength;
    schedulePtyWriteFlush();
    return true;
  }, [schedulePtyWriteFlush]);

  useEffect(() => {
    if (!isPtyTerminalMode(terminalMode) || !ptyContainerRef.current) return;

    const terminal = new Terminal({
      fontFamily: 'JetBrains Mono, Fira Code, monospace',
      fontSize: window.innerWidth < 768 ? 10 : 12,
      lineHeight: 1.3,
      convertEol: true,
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
    schedulePtyWriteFlush();
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
      if (ptyWriteFrameRef.current !== null) {
        window.cancelAnimationFrame(ptyWriteFrameRef.current);
        ptyWriteFrameRef.current = null;
      }
      inputDisposable.dispose();
      container.removeEventListener('focusin', handleFocusIn);
      container.removeEventListener('focusout', handleFocusOut);
      fitAddonRef.current = null;
      xtermRef.current = null;
      setPtyFocused(false);
      terminal.dispose();
    };
  }, [flushPtyInput, postPtyResize, queuePtyInput, schedulePtyWriteFlush, terminalMode]);

  useEffect(() => {
    if (isPtyTerminalMode(terminalMode) && xtermRef.current) {
      xtermRef.current.options.theme = getPtyTheme(resolved);
      fitAddonRef.current?.fit();
    }
  }, [resolved, terminalMode]);

  useEffect(() => {
    activeResizeRetryRef.current = false;
  }, [runId, rendererMode]);

  // Initial resize can race PTY creation. Retry exactly once after authoritative
  // active health arrives so the child starts with the browser's actual size.
  useEffect(() => {
    if (activeResizeRetryRef.current || terminalMode !== 'pty' || terminalMeta.ptySessionStatus !== 'active') return;
    const terminal = xtermRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) return;
    activeResizeRetryRef.current = true;
    fitAddon.fit();
    void postPtyResize(terminal.cols, terminal.rows);
  }, [postPtyResize, ptyReady, terminalMeta.ptySessionStatus, terminalMode]);

  // Flush pending text buffer → convert via ansi-to-html → append to accumulated HTML.
  // Lines prefixed with HTML_LINE_PREFIX are pre-HTML (markdown already converted) — use no-escape converter.
  const flushBuffer = useCallback(() => {
    flushTimerRef.current = null;
    const pending = pendingTextRef.current.slice(0, MAX_ANSI_FLUSH_CHARS);
    if (!pending) return;
    pendingTextRef.current = pendingTextRef.current.slice(pending.length);

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

    if (pendingTextRef.current && flushTimerRef.current === null) {
      flushTimerRef.current = setTimeout(flushBuffer, 0);
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
      if (isPtyTerminalMode(terminalMode)) {
        xtermRef.current?.writeln(text);
        return;
      }
      const markerHtml = `<div style="padding:4px 8px;margin:4px 0;background:color-mix(in srgb, var(--accent) 15%, transparent);border-left:3px solid var(--accent);color:var(--text);font-size:11px;font-family:monospace;">${text.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>`;
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

  // SSE setup — durable replay resumes after the last committed chunk sequence.
  // With no session cursor the backend intentionally supplies only a bounded tail.
  useEffect(() => {
    esRef.current?.close();
    const streamKey = `${runId}:${rendererMode}`;
    const isNewTerminal = streamKeyRef.current !== streamKey;
    if (isNewTerminal) {
      streamKeyRef.current = streamKey;
      recoverTerminalOnNextConnectRef.current = true;
      pendingTextRef.current = '';
      accumulatedHtmlRef.current = '';
      seenStoryIdsRef.current = new Set();
      lineBufferRef.current = '';
      terminalModeRef.current = rendererMode;
      pendingPtyChunksRef.current = [];
      pendingPtyBytesRef.current = 0;
      pendingPtyInputRef.current = '';
      queuedPtyInputBytesRef.current = 0;
      ptyDisplayScrubberRef.current = createPtyDisplayScrubberState();
      ptyDisplayDecoderRef.current = new TextDecoder();
      ansiDisplayDecoderRef.current = new TextDecoder();
      outputReplaySourceRef.current = loadReceivedOutputSource(runId);
      ptyGenerationIdRef.current = loadReceivedGenerationId(runId);
      lastReceivedSequenceRef.current = loadReceivedSequence(
        runId,
        outputReplaySourceRef.current,
        ptyGenerationIdRef.current,
      );
      ptyGenerationTokenRef.current = null;
      ptyProcessAliveRef.current = false;
      setAgentType('unknown');
      setAgentModel(null);
      setSteps([]);
      setExpandedSet(new Set());
      setStreamDone(false);
      setReplayTruncatedFrom(null);
      hasViewportContentRef.current = false;
      setHasViewportContent(false);
      setCheckpointRecoveryFailed(false);
      setStatusAnnouncement('');
      setPtyInputHealthy(true);
      setPtyRenderBackpressure(false);
      setLastSseAt(null);
      setLastPtyByteAt(null);
      setLastSemanticAt(null);
      setTerminalMode(rendererMode);
      setTerminalMeta({
        requestedTerminalMode: rendererMode,
        isPty: isPtyTerminalMode(rendererMode),
        ptyAvailable: undefined,
        ptyUnavailableHint: null,
      });
      setRunMetaResolved(false);
      if (flushTimerRef.current !== null) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      xtermRef.current?.clear();
      if (preRef.current) preRef.current.innerHTML = '';
    }
    if (isPtyTerminalMode(rendererMode) && !ptyReady) return;

    setSseState(reconnectAttempt > 0 ? 'reconnecting' : 'connecting');
    const outputParams = new URLSearchParams();
    if (workspaceId) outputParams.set('workspaceId', workspaceId);
    if (recoverTerminalOnNextConnectRef.current && isPtyTerminalMode(rendererMode)) {
      // A browser refresh creates an empty xterm even when sessionStorage has a
      // durable cursor. Ask for checkpoint-plus-delta reconstruction instead of
      // silently resuming into a blank terminal.
      outputParams.set('recoverTerminal', 'true');
    }
    if (lastReceivedSequenceRef.current > 0) {
      outputParams.set('afterSequence', String(lastReceivedSequenceRef.current));
      if (outputReplaySourceRef.current) outputParams.set('outputSource', outputReplaySourceRef.current);
      if (ptyGenerationIdRef.current) outputParams.set('outputGenerationId', ptyGenerationIdRef.current);
    }
    const outputUrl = `${BASE_URL}/api/pipeline/runs/${runId}/output${outputParams.toString() ? '?' + outputParams : ''}`;
    const es = new EventSource(outputUrl);
    recoverTerminalOnNextConnectRef.current = false;
    esRef.current = es;
    let disposed = false;
    let receivedDone = false;
    const scheduleReconnect = () => {
      if (disposed || receivedDone || reconnectTimerRef.current !== null) return;
      es.close();
      setSseState('reconnecting');
      setStatusAnnouncement('Terminal output connection interrupted. Reconnecting from the current source and generation cursor.');
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        if (!disposed && !receivedDone) setReconnectAttempt(previous => previous + 1);
      }, PTY_RECONNECT_DELAY_MS);
    };
    const commitChunkSequence = (event: MessageEvent) => {
      const sequence = readChunkSequence(event);
      if (sequence !== null && sequence > lastReceivedSequenceRef.current) {
        lastReceivedSequenceRef.current = sequence;
        persistReceivedSequence(
          runId,
          outputReplaySourceRef.current,
          ptyGenerationIdRef.current,
          sequence,
        );
      }
    };

    type PtyHealthMeta = {
      ptyGenerationId?: string | null;
      pty_generation_id?: string | null;
      ptyGenerationToken?: string | null;
      pty_generation_token?: string | null;
      ptyStoryId?: string | null;
      pty_story_id?: string | null;
      ptyAttempt?: number | null;
      pty_attempt?: number | null;
      ptyGenerationStatus?: string | null;
      pty_generation_status?: string | null;
      ptyGenerationActive?: boolean;
      pty_generation_active?: boolean;
      ptyGenerationSource?: 'native' | 'legacy' | null;
      pty_generation_source?: 'native' | 'legacy' | null;
      ptyGenerationReplaySource?: 'generation' | 'legacy_run_output' | 'legacy_pty_output' | null;
      pty_generation_replay_source?: 'generation' | 'legacy_run_output' | 'legacy_pty_output' | null;
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
      ptyCompletionFileSeen?: boolean;
      pty_completion_file_seen?: boolean;
      ptyCompletionFileSeenAt?: string | null;
      pty_completion_file_seen_at?: string | null;
      ptyCompletionFileError?: string | null;
      pty_completion_file_error?: string | null;
      ptyPromptReadinessStatus?: string | null;
      pty_prompt_readiness_status?: string | null;
      ptyPromptReadinessReason?: string | null;
      pty_prompt_readiness_reason?: string | null;
      ptyTotalOutputBytes?: number;
      pty_total_output_bytes?: number;
      ptyNextOutputSequence?: number;
      pty_next_output_sequence?: number;
      ptyCheckpointSequence?: number;
      pty_checkpoint_sequence?: number;
      ptyFirstRetainedSequence?: number;
      pty_first_retained_sequence?: number;
      ptyCompactedByteCount?: number;
      pty_compacted_byte_count?: number;
      ptyDroppedOutputBytes?: number;
      pty_dropped_output_bytes?: number;
      ptyOutputTruncated?: boolean;
      pty_output_truncated?: boolean;
      ptyOutputTruncatedAt?: string | null;
      pty_output_truncated_at?: string | null;
    };

    const applyPtyHealthMeta = (meta: PtyHealthMeta) => {
      const authoritativeSessionStatus = meta.ptySessionStatus ?? meta.pty_session_status;
      if (authoritativeSessionStatus !== undefined) {
        ptySessionStatusRef.current = authoritativeSessionStatus;
      }
      const authoritativeProcessAlive = meta.ptyProcessAlive ?? meta.pty_process_alive;
      if (authoritativeProcessAlive !== undefined && authoritativeProcessAlive !== null) {
        ptyProcessAliveRef.current = authoritativeProcessAlive;
      }
      setTerminalMeta(prev => ({
        ...prev,
        ptyGenerationId: meta.ptyGenerationId ?? meta.pty_generation_id ?? prev.ptyGenerationId ?? null,
        ptyGenerationToken: meta.ptyGenerationToken ?? meta.pty_generation_token ?? prev.ptyGenerationToken ?? null,
        ptyStoryId: meta.ptyStoryId ?? meta.pty_story_id ?? prev.ptyStoryId ?? null,
        ptyAttempt: meta.ptyAttempt ?? meta.pty_attempt ?? prev.ptyAttempt ?? null,
        ptyGenerationStatus: meta.ptyGenerationStatus ?? meta.pty_generation_status ?? prev.ptyGenerationStatus ?? null,
        ptyGenerationActive: meta.ptyGenerationActive ?? meta.pty_generation_active ?? prev.ptyGenerationActive ?? false,
        ptyGenerationSource: meta.ptyGenerationSource ?? meta.pty_generation_source ?? prev.ptyGenerationSource ?? null,
        ptyGenerationReplaySource: meta.ptyGenerationReplaySource ?? meta.pty_generation_replay_source ?? prev.ptyGenerationReplaySource ?? null,
        ptySessionStatus: meta.ptySessionStatus ?? meta.pty_session_status ?? prev.ptySessionStatus ?? null,
        ptyProcessAlive: meta.ptyProcessAlive ?? meta.pty_process_alive ?? prev.ptyProcessAlive ?? null,
        ptyLastOutputAt: meta.ptyLastOutputAt ?? meta.pty_last_output_at ?? prev.ptyLastOutputAt ?? null,
        ptyLastHeartbeatAt: meta.ptyLastHeartbeatAt ?? meta.pty_last_heartbeat_at ?? prev.ptyLastHeartbeatAt ?? null,
        ptyCompletionMarkerSeen: meta.ptyCompletionMarkerSeen ?? meta.pty_completion_marker_seen ?? prev.ptyCompletionMarkerSeen ?? false,
        ptyCompletionMarkerSeenAt: meta.ptyCompletionMarkerSeenAt ?? meta.pty_completion_marker_seen_at ?? prev.ptyCompletionMarkerSeenAt ?? null,
        ptyCompletionFileSeen: meta.ptyCompletionFileSeen ?? meta.pty_completion_file_seen ?? prev.ptyCompletionFileSeen ?? false,
        ptyCompletionFileSeenAt: meta.ptyCompletionFileSeenAt ?? meta.pty_completion_file_seen_at ?? prev.ptyCompletionFileSeenAt ?? null,
        ptyCompletionFileError: meta.ptyCompletionFileError ?? meta.pty_completion_file_error ?? prev.ptyCompletionFileError ?? null,
        ptyPromptReadinessStatus: meta.ptyPromptReadinessStatus ?? meta.pty_prompt_readiness_status ?? prev.ptyPromptReadinessStatus ?? null,
        ptyPromptReadinessReason: meta.ptyPromptReadinessReason ?? meta.pty_prompt_readiness_reason ?? prev.ptyPromptReadinessReason ?? null,
        ptyTotalOutputBytes: meta.ptyTotalOutputBytes ?? meta.pty_total_output_bytes ?? prev.ptyTotalOutputBytes ?? 0,
        ptyNextOutputSequence: meta.ptyNextOutputSequence ?? meta.pty_next_output_sequence ?? prev.ptyNextOutputSequence ?? 1,
        ptyCheckpointSequence: meta.ptyCheckpointSequence ?? meta.pty_checkpoint_sequence ?? prev.ptyCheckpointSequence ?? 0,
        ptyFirstRetainedSequence: meta.ptyFirstRetainedSequence ?? meta.pty_first_retained_sequence ?? prev.ptyFirstRetainedSequence ?? 1,
        ptyCompactedByteCount: meta.ptyCompactedByteCount ?? meta.pty_compacted_byte_count ?? prev.ptyCompactedByteCount ?? 0,
        ptyDroppedOutputBytes: meta.ptyDroppedOutputBytes ?? meta.pty_dropped_output_bytes ?? prev.ptyDroppedOutputBytes ?? 0,
        ptyOutputTruncated: meta.ptyOutputTruncated ?? meta.pty_output_truncated ?? prev.ptyOutputTruncated ?? false,
        ptyOutputTruncatedAt: meta.ptyOutputTruncatedAt ?? meta.pty_output_truncated_at ?? prev.ptyOutputTruncatedAt ?? null,
      }));
    };

    es.onopen = () => {
      setPtyRenderBackpressure(false);
      markSseEvent();
    };

    // Listen for run metadata (agent type + authoritative renderer/fallback state)
    es.addEventListener('run_meta', (e: MessageEvent) => {
      markSseEvent();
      try {
        const meta = JSON.parse(e.data) as PtyHealthMeta & {
          agentType?: string;
          agentModel?: string | null;
          terminalMode?: string;
          terminal_mode?: string;
          requestedTerminalMode?: string;
          requested_terminal_mode?: string;
          isPty?: boolean;
          ptyAvailable?: boolean;
          ptyUnavailableHint?: string | null;
          pty_unavailable_hint?: string | null;
          outputSource?: unknown;
          output_source?: unknown;
          ptyReplaySource?: unknown;
          pty_replay_source?: unknown;
          outputGenerationId?: string | null;
          output_generation_id?: string | null;
          transcriptAvailable?: boolean;
          transcript_available?: boolean;
          archiveAvailable?: boolean;
          archive_available?: boolean;
          ptyExpectedMaxLatencyMs?: number | null;
          pty_expected_max_latency_ms?: number | null;
          cursorReset?: boolean;
          cursor_reset?: boolean;
        };
        const nextReplaySource = meta.outputSource ?? meta.output_source ?? meta.ptyReplaySource ?? meta.pty_replay_source;
        const nextGenerationId = meta.outputGenerationId ?? meta.output_generation_id
          ?? meta.ptyGenerationId ?? meta.pty_generation_id ?? null;
        const nextGenerationToken = meta.ptyGenerationToken ?? meta.pty_generation_token ?? null;
        const generationChanged = typeof nextGenerationId === 'string'
          && ptyGenerationIdRef.current !== null
          && ptyGenerationIdRef.current !== nextGenerationId;
        const cursorReset = meta.cursorReset === true || meta.cursor_reset === true;
        const previousGenerationId = ptyGenerationIdRef.current;
        const previousReplaySource = outputReplaySourceRef.current;
        const sourceChanged = isOutputReplaySource(nextReplaySource)
          && previousReplaySource !== null
          && previousReplaySource !== nextReplaySource;
        if (generationChanged) {
          // A later story/retry is the sole live-terminal clear boundary. A
          // transport reconnect within this generation never resets xterm.
          xtermRef.current?.reset();
          pendingPtyChunksRef.current = [];
          pendingPtyBytesRef.current = 0;
          seenChunkIdsRef.current.clear();
          ptyDisplayScrubberRef.current = createPtyDisplayScrubberState();
          ptyDisplayDecoderRef.current = new TextDecoder();
          ansiDisplayDecoderRef.current = new TextDecoder();
          lineBufferRef.current = '';
          hasViewportContentRef.current = false;
          setHasViewportContent(false);
          setCheckpointRecoveryFailed(false);
          setReplayTruncatedFrom(null);
          setLastPtyByteAt(null);
          setLastSemanticAt(null);
          ptyProcessAliveRef.current = false;
          setStatusAnnouncement(`Terminal generation changed to ${nextGenerationId}. Restoring the newest validated viewport.`);
        }
        if (cursorReset || sourceChanged || generationChanged) {
          // Switch the in-memory cursor synchronously, but retain a superseded
          // tuple's durable value for authorized historical replay. Only an
          // invalid cursor within the same identity is discarded.
          if (cursorReset && !sourceChanged && !generationChanged) {
            clearReceivedSequence(runId, previousReplaySource, previousGenerationId);
          }
          lastReceivedSequenceRef.current = 0;
        }
        ptyGenerationIdRef.current = typeof nextGenerationId === 'string' ? nextGenerationId : null;
        persistReceivedGenerationId(runId, ptyGenerationIdRef.current);
        ptyGenerationTokenRef.current = typeof nextGenerationToken === 'string' ? nextGenerationToken : null;
        if (isOutputReplaySource(nextReplaySource)) {
          outputReplaySourceRef.current = nextReplaySource;
          persistReceivedOutputSource(runId, nextReplaySource);
        }
        setRunMetaResolved(true);
        if (typeof meta.agentType === 'string' && meta.agentType.trim()) {
          setAgentType(meta.agentType);
        }
        if (typeof meta.agentModel === 'string' && meta.agentModel.trim()) {
          setAgentModel(meta.agentModel);
        }

        const nextTerminalMode = coerceTerminalMode(meta.terminalMode ?? meta.terminal_mode);
        if (nextTerminalMode) {
          terminalModeRef.current = nextTerminalMode;
          setTerminalMode(nextTerminalMode);
          if (!isPtyTerminalMode(nextTerminalMode)) {
            setPtyReady(true);
          }
        }

        const requestedTerminalMode = coerceTerminalMode(meta.requestedTerminalMode ?? meta.requested_terminal_mode)
          ?? nextTerminalMode
          ?? rendererMode;
        const isPty = typeof meta.isPty === 'boolean'
          ? meta.isPty
          : isPtyTerminalMode(nextTerminalMode ?? terminalModeRef.current);
        const ptyUnavailableHint = typeof (meta.ptyUnavailableHint ?? meta.pty_unavailable_hint) === 'string'
          ? (meta.ptyUnavailableHint ?? meta.pty_unavailable_hint) as string
          : null;
        setTerminalMeta(prev => ({
          ...prev,
          requestedTerminalMode,
          isPty,
          ptyAvailable: typeof meta.ptyAvailable === 'boolean' ? meta.ptyAvailable : undefined,
          ptyUnavailableHint,
          ptyGenerationId: typeof nextGenerationId === 'string' ? nextGenerationId : null,
          transcriptAvailable: meta.transcriptAvailable ?? meta.transcript_available ?? false,
          archiveAvailable: meta.archiveAvailable ?? meta.archive_available ?? false,
          expectedMaxLatencyMs: meta.ptyExpectedMaxLatencyMs ?? meta.pty_expected_max_latency_ms ?? null,
        }));
        applyPtyHealthMeta(meta);
      } catch { /* ignore */ }
    });

    es.addEventListener('terminal_reset', (e: MessageEvent) => {
      markSseEvent();
      let reason = 'authoritative replay';
      try {
        const payload = JSON.parse(e.data) as { reason?: unknown };
        if (typeof payload.reason === 'string') reason = payload.reason.replace(/_/g, ' ');
      } catch { /* a legacy empty reset frame remains valid */ }

      // `terminal_reset` selects a replay cursor; it is not permission to clear
      // a visible same-generation xterm. Generation rollover above and a
      // validated checkpoint below are the only xterm reset boundaries.
      clearReceivedSequence(runId, outputReplaySourceRef.current, ptyGenerationIdRef.current);
      lastReceivedSequenceRef.current = 0;
      seenChunkIdsRef.current.clear();
      if (!hasViewportContentRef.current) {
        pendingPtyChunksRef.current = [];
        pendingPtyBytesRef.current = 0;
        ptyDisplayScrubberRef.current = createPtyDisplayScrubberState();
        ptyDisplayDecoderRef.current = new TextDecoder();
        ansiDisplayDecoderRef.current = new TextDecoder();
        lineBufferRef.current = '';
      }
      if (!isPtyTerminalMode(terminalModeRef.current)) {
        pendingTextRef.current = '';
        accumulatedHtmlRef.current = '';
        hasViewportContentRef.current = false;
        setHasViewportContent(false);
        if (preRef.current) preRef.current.innerHTML = '';
      }
      setStatusAnnouncement(`Terminal replay restarted at the ${reason} boundary.`);
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
          setStatusAnnouncement(`Earlier viewport history was compacted. Live replay begins at output sequence ${fromSequence}; complete structured history remains available in Transcript.`);
        }
      } catch { /* ignore malformed replay metadata */ }
    });

    type CheckpointReadyPayload = {
      checkpoint_id?: unknown;
      checkpoint_seq?: unknown;
      first_retained_seq?: unknown;
      generation_id?: unknown;
    };
    type CheckpointResponse = {
      checkpointId: string;
      generationId: string;
      checkpointSeq: number;
      firstRetainedSeq: number;
      compactedByteCount: number;
      version: number;
      checksum: string;
      terminalCols: number;
      terminalRows: number;
      dataBase64: string;
    };
    let checkpointRecovery: {
      checkpointId: string;
      generationId: string;
      checkpointSequence: number;
      queued: MessageEvent[];
    } | null = null;
    let lastAppliedCheckpointSequence = 0;

    const processChunkEvent = (e: MessageEvent) => {
      const sequence = readChunkSequence(e);
      if (sequence !== null && sequence <= lastReceivedSequenceRef.current) return;
      try {
        const chunkId = e.lastEventId || '';
        if (chunkId) {
          if (seenChunkIdsRef.current.has(chunkId)) return;
          seenChunkIdsRef.current.add(chunkId);
        }

        const bytes = decodeBase64Chunk(e.data);
        const isPtyChunk = isPtyTerminalMode(terminalModeRef.current);
        if (isPtyChunk) {
          if (!writePtyChunk(bytes)) {
            // Do not advance the durable cursor for an unadmitted chunk. A fresh
            // EventSource with afterSequence will replay it after xterm catches up.
            scheduleReconnect();
            return;
          }
          setLastPtyByteAt(Date.now());
        }
        if (bytes.byteLength > 0) {
          // Mark content only after the renderer admitted the bytes. A rejected
          // first chunk must leave the actionable blank diagnostic visible.
          hasViewportContentRef.current = true;
          setHasViewportContent(true);
          setCheckpointRecoveryFailed(false);
        }

        const text = ansiDisplayDecoderRef.current.decode(bytes, { stream: true });
        lineBufferRef.current += text;
        const parts = lineBufferRef.current.split('\n');
        lineBufferRef.current = parts.pop() ?? '';
        const displayLines: string[] = [];
        const newSteps: SemanticStep[] = [];
        for (const part of parts) {
          const step = parseVerboseLine(part);
          if (step) newSteps.push(step);
          if (!isPtyChunk) {
            const formatted = formatStreamJsonForDisplay(part);
            if (formatted !== null) displayLines.push(formatted);
          }
        }
        if (!isPtyChunk && displayLines.length > 0) {
          const displayText = displayLines.join('\n') + '\n';
          if (pendingTextRef.current.length + displayText.length > MAX_PENDING_ANSI_CHARS) flushBuffer();
          pendingTextRef.current += displayText;
          scheduleFlush();
        }
        if (newSteps.length > 0) {
          setLastSemanticAt(Date.now());
          setSteps(prev => mergeSemanticSteps(prev, newSteps));
        }
        commitChunkSequence(e);
      } catch { /* ignore malformed chunk */ }
    };

    es.addEventListener('checkpoint_ready', (e: MessageEvent) => {
      markSseEvent();
      try {
        const payload = JSON.parse(e.data) as CheckpointReadyPayload;
        const checkpointId = typeof payload.checkpoint_id === 'string' ? payload.checkpoint_id : '';
        const generationId = typeof payload.generation_id === 'string' ? payload.generation_id : '';
        const checkpointSequence = Number(payload.checkpoint_seq);
        if (!checkpointId
          || !generationId
          || generationId !== ptyGenerationIdRef.current
          || !Number.isSafeInteger(checkpointSequence)
          || checkpointSequence <= lastAppliedCheckpointSequence) {
          setCheckpointRecoveryFailed(true);
          setStatusAnnouncement('A malformed or mismatched terminal checkpoint was ignored; durable deltas continue to replay.');
          return;
        }
        const recovery = { checkpointId, generationId, checkpointSequence, queued: [] as MessageEvent[] };
        checkpointRecovery = recovery;
        void apiFetch<CheckpointResponse>(`/api/pipeline/runs/${runId}/pty/checkpoints/${checkpointId}`, { silent: true })
          .then(checkpoint => {
            if (disposed || checkpointRecovery !== recovery) return;
            if (checkpoint.checkpointId !== checkpointId
              || checkpoint.generationId !== generationId
              || checkpoint.checkpointSeq !== checkpointSequence
              || checkpoint.version !== 1) {
              throw new Error('PTY checkpoint response identity mismatch');
            }
            const terminal = xtermRef.current;
            if (!terminal) throw new Error('PTY terminal is unavailable');
            const serializedState = decodeBase64Chunk(checkpoint.dataBase64);
            // The backend has already verified checksum/decompression. Reset only
            // after that successful response; corruption can never erase the
            // currently visible terminal.
            terminal.reset();
            pendingPtyChunksRef.current = [];
            pendingPtyBytesRef.current = 0;
            seenChunkIdsRef.current.clear();
            ptyDisplayScrubberRef.current = createPtyDisplayScrubberState();
            ptyDisplayDecoderRef.current = new TextDecoder();
            ansiDisplayDecoderRef.current = new TextDecoder();
            if (typeof terminal.resize === 'function') {
              terminal.resize(checkpoint.terminalCols, checkpoint.terminalRows);
            }
            terminal.write(serializedState as Parameters<Terminal['write']>[0], () => {
              // Deserialize at the checkpoint's recorded dimensions, then fit
              // the recovered screen to the currently attached viewport.
              fitAddonRef.current?.fit();
            });
            lastAppliedCheckpointSequence = checkpointSequence;
            lastReceivedSequenceRef.current = checkpointSequence;
            persistReceivedSequence(
              runId,
              outputReplaySourceRef.current,
              ptyGenerationIdRef.current,
              checkpointSequence,
            );
            hasViewportContentRef.current = serializedState.byteLength > 0;
            setHasViewportContent(serializedState.byteLength > 0);
            setCheckpointRecoveryFailed(false);
            setTerminalMeta(previous => ({
              ...previous,
              ptyCheckpointSequence: checkpoint.checkpointSeq,
              ptyFirstRetainedSequence: checkpoint.firstRetainedSeq,
              ptyCompactedByteCount: checkpoint.compactedByteCount,
            }));
            setStatusAnnouncement(`Validated terminal checkpoint ${checkpointSequence} restored; later deltas are being appended.`);
            setReplayTruncatedFrom(null);
            checkpointRecovery = null;
            for (const queued of recovery.queued) processChunkEvent(queued);
          })
          .catch(() => {
            if (checkpointRecovery !== recovery) return;
            checkpointRecovery = null;
            setCheckpointRecoveryFailed(true);
            setStatusAnnouncement('Terminal checkpoint validation failed; the visible viewport was preserved and later durable deltas continue.');
            const firstRetained = Number(payload.first_retained_seq);
            if (Number.isSafeInteger(firstRetained) && firstRetained > 1) setReplayTruncatedFrom(firstRetained);
            // Keep the existing terminal intact and admit newer deltas. The next
            // valid checkpoint event can recover it without blocking live output.
            for (const queued of recovery.queued) processChunkEvent(queued);
          });
      } catch { /* ignore malformed checkpoint signal */ }
    });

    es.addEventListener('chunk', (e: MessageEvent) => {
      markSseEvent();
      const sequence = readChunkSequence(e);
      const recovery = checkpointRecovery;
      if (recovery && sequence !== null) {
        if (sequence <= recovery.checkpointSequence) return;
        const queuedBytes = recovery.queued.reduce((sum, item) => sum + item.data.length, 0);
        if (queuedBytes + e.data.length > MAX_PENDING_PTY_BYTES * 2) {
          scheduleReconnect();
          return;
        }
        recovery.queued.push(e);
        return;
      }
      processChunkEvent(e);
    });

    // Also accept structured semantic_step events from backend if available
    es.addEventListener('semantic_step', (e: MessageEvent) => {
      markSseEvent();
      try {
        const step: SemanticStep = JSON.parse(e.data);
        setLastSemanticAt(Date.now());
        setSteps(prev => mergeSemanticSteps(prev, [step]));
      } catch { /* ignore malformed step */ }
    });

    es.addEventListener('done', () => {
      receivedDone = true;
      markSseEvent();
      const isPtyStream = isPtyTerminalMode(terminalModeRef.current);
      lineBufferRef.current += ansiDisplayDecoderRef.current.decode();
      if (flushTimerRef.current !== null) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      if (lineBufferRef.current) {
        const finalStep = parseVerboseLine(lineBufferRef.current);
        if (finalStep) setSteps(prev => mergeSemanticSteps(prev, [finalStep]));
        if (!isPtyStream) {
          const formatted = formatStreamJsonForDisplay(lineBufferRef.current);
          if (formatted !== null) pendingTextRef.current += formatted + '\n';
        }
        lineBufferRef.current = '';
      }
      if (!isPtyStream) {
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
      ptyGenerationTokenRef.current = null;
      ptyProcessAliveRef.current = false;
      setTerminalMeta(previous => ({
        ...previous,
        ptyGenerationActive: false,
        ptyProcessAlive: false,
        ptySessionStatus: previous.ptySessionStatus === 'active' ? 'exited' : previous.ptySessionStatus,
      }));
      setStatusAnnouncement('Terminal generation ended. Captured output remains available as replay.');
      setStreamDone(true);
      es.close();
    });

    es.onerror = () => {
      // Recreate with the persisted cursor rather than relying only on browser
      // Last-Event-ID behavior. This also covers a page refresh and proxies that
      // discard SSE resume headers.
      scheduleReconnect();
    };

    return () => {
      disposed = true;
      es.close();
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (flushTimerRef.current !== null) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
    };
  }, [reconnectAttempt, runId, ansiConverter, ansiConverterNoEscape, flushBuffer, markSseEvent, ptyReady, rendererMode, scheduleFlush, workspaceId, writePtyChunk]);

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
  const showAgentBadge = true;
  const ptyFallbackActive = isPtyTerminalMode(terminalMeta.requestedTerminalMode) && (!terminalMeta.isPty || !isPtyTerminalMode(terminalMode));
  const ptyFallbackReason = terminalMeta.ptyAvailable === false
    ? 'node-pty is unavailable on this server.'
    : 'The PTY session did not start or is no longer attachable.';
  const ptyFallbackHint = terminalMeta.ptyUnavailableHint?.trim();
  const streamEnded = streamDone || isTerminalRunStatus(runStatus);
  const expectedLatencyMs = Math.max(1_000, terminalMeta.expectedMaxLatencyMs ?? 4_000);
  const recencyWindowMs = Math.max(10_000, expectedLatencyMs * 2);
  const sseRecentlyAlive = isRecentMs(lastSseAt, nowTick, recencyWindowMs);
  const heartbeatMs = isoToMs(terminalMeta.ptyLastHeartbeatAt);
  const heartbeatRecent = isRecentMs(heartbeatMs, nowTick, recencyWindowMs);
  const transportRecentlyAlive = sseRecentlyAlive || heartbeatRecent;
  const effectiveSseState: SseConnectionState = streamEnded
    ? 'closed'
    : sseState === 'alive' && !transportRecentlyAlive
      ? 'reconnecting'
      : sseState;
  const serverPtyOutputMs = isoToMs(terminalMeta.ptyLastOutputAt);
  const newestPtyOutputMs = Math.max(serverPtyOutputMs ?? 0, lastPtyByteAt ?? 0);
  const lastPtyOutputMs = newestPtyOutputMs > 0 ? newestPtyOutputMs : null;
  const ptyBytesRecent = isRecentMs(lastPtyOutputMs, nowTick, recencyWindowMs);
  const semanticRecent = isRecentMs(lastSemanticAt, nowTick, recencyWindowMs);
  const ptyProcessAlive = terminalMeta.ptyProcessAlive === true
    && terminalMeta.ptyGenerationActive !== false
    && terminalMeta.ptySessionStatus === 'active'
    && !streamEnded;
  const hasGenerationIdentity = typeof terminalMeta.ptyGenerationId === 'string';
  const ptyExplicitlyWaiting = ptyProcessAlive
    && hasGenerationIdentity
    && (terminalMeta.ptyPromptReadinessStatus === 'waiting' || (!ptyBytesRecent && heartbeatRecent));
  const ptySilent = isPtyTerminalMode(terminalMode) && ptyExplicitlyWaiting;
  const compactedBytes = terminalMeta.ptyCompactedByteCount ?? 0;
  const captureLostBytes = terminalMeta.ptyDroppedOutputBytes ?? 0;
  const hasTrueCaptureGap = captureLostBytes > 0 || terminalMeta.ptyOutputTruncated === true;
  const hasCompactedHistory = !hasTrueCaptureGap && (compactedBytes > 0 || replayTruncatedFrom !== null);
  const resolvingEffectiveMode = isPtyTerminalMode(terminalMeta.requestedTerminalMode) && !runMetaResolved;
  const lifecycleState: TerminalLifecycleState = ptyFallbackActive
    ? 'unavailable'
    : streamEnded
      ? 'ended'
      : hasTrueCaptureGap
        ? 'gap'
        : ptyRenderBackpressure || !transportRecentlyAlive
          ? 'reconnecting'
          : hasCompactedHistory
            ? 'compacted'
            : isPtyTerminalMode(terminalMode)
              ? ptyProcessAlive && hasGenerationIdentity && ptyBytesRecent && hasViewportContent
                ? 'live'
                : ptyExplicitlyWaiting
                  ? 'waiting'
                  : 'reconnecting'
              : sseRecentlyAlive && hasViewportContent
                ? 'live'
                : 'reconnecting';
  const connectionState = lifecycleState.charAt(0).toUpperCase() + lifecycleState.slice(1);
  const connectionTone = lifecycleState === 'live'
    ? 'var(--terminal-state-live)'
    : lifecycleState === 'ended'
      ? 'var(--text-muted)'
      : lifecycleState === 'compacted'
        ? 'var(--terminal-state-notice)'
        : 'var(--terminal-state-warning)';
  const connectionTitle = lifecycleState === 'live'
    ? `The active generation has a live process and output within ${recencyWindowMs}ms.`
    : lifecycleState === 'waiting'
      ? 'The active generation is explicitly waiting; its process and heartbeat are current, but no recent output bytes were observed.'
      : lifecycleState === 'compacted'
        ? 'Earlier viewport deltas were compacted or omitted from the bounded replay; live output and the complete structured transcript continue.'
        : lifecycleState === 'gap'
          ? 'Capture telemetry reports true output loss. Inspect the affected byte and sequence ranges below.'
          : lifecycleState === 'reconnecting'
            ? lastReceivedSequenceRef.current > 0
              ? `Reconnecting within the current output identity after sequence ${lastReceivedSequenceRef.current}.`
              : 'Reconnecting and requesting an authoritative current-generation viewport.'
            : lifecycleState === 'unavailable'
              ? 'The requested PTY is unavailable; an actionable ANSI fallback is shown.'
              : 'The process ended; captured output remains available as replay.';
  const ansiSurfaceKind = resolvedMode === 'semantic' ? 'Semantic summary' : resolvedMode === 'transcript' ? 'Structured transcript' : 'ANSI transcript';
  const surfaceLabel = resolvingEffectiveMode
    ? 'Checking PTY support'
    : resolvedMode === 'transcript'
      ? `Complete transcript · ${streamEnded ? 'ended' : 'incremental'}`
      : isPtyTerminalMode(terminalMode)
        ? streamEnded
          ? 'PTY terminal replay'
          : !ptyInputHealthy
            ? 'PTY terminal · input issue'
            : ptySilent
              ? `PTY terminal · waiting · last byte ${formatAge(lastPtyOutputMs, nowTick)}`
              : ptyFocused
                ? 'PTY terminal · focused'
                : 'PTY terminal · click to focus'
        : ptyFallbackActive
          ? 'PTY unavailable · ANSI transcript'
          : `${ansiSurfaceKind} · ${streamEnded ? 'replay' : 'stream'}`;
  const surfaceTitle = resolvingEffectiveMode
    ? 'Waiting for backend metadata before choosing full PTY attachment or ANSI fallback.'
    : resolvedMode === 'transcript'
      ? 'Authorized generation-scoped structured history; pages load incrementally and terminal ANSI is never rendered here.'
      : isPtyTerminalMode(terminalMode)
        ? resolvedMode === 'semantic'
          ? 'Best-effort semantic execution summary parsed from the live output stream.'
          : streamEnded
            ? 'The PTY session ended; xterm is replay-only and keyboard/resize controls are disabled.'
            : ptyInputHealthy
              ? 'Real xterm.js PTY attachment. Input and resize target only the exact active generation token.'
              : 'PTY output is visible, but input delivery failed; inspect diagnostics.'
        : ptyFallbackActive
          ? `Requested full PTY, but ${ptyFallbackReason} Showing ${streamEnded ? 'an ANSI transcript replay' : 'a live ANSI transcript'} without terminal input.`
          : `${ansiSurfaceKind} ${streamEnded ? 'replay from saved chunks' : 'stream'}; this is not a PTY attachment.`;
  const modeHelpText = resolvingEffectiveMode
    ? 'Checking whether a real xterm.js PTY is available. Rorca will attach when supported or show an actionable ANSI fallback.'
    : resolvedMode === 'transcript'
      ? 'Transcript view loads the complete authorized structured history 50 events at a time, preserving model, tool, host, and error semantics without raw ANSI.'
      : isPtyTerminalMode(terminalMode)
        ? resolvedMode === 'semantic'
          ? 'Semantic view is a best-effort live summary. Use Transcript for complete structured history or Terminal for the exact current viewport.'
          : streamEnded
            ? 'This generation ended. The terminal is replay-only; use Transcript for complete structured history.'
            : 'Terminal view follows the exact active generation. Use Transcript for incrementally paged complete history.'
        : ptyFallbackActive
          ? `PTY unavailable — ANSI transcript: ${ptyFallbackReason}${ptyFallbackHint ? ` PTY prerequisite: ${ptyFallbackHint}` : ''}`
          : `${ansiSurfaceKind} ${streamEnded ? 'replay' : 'stream'}: captured output only, not an interactive PTY.`;
  const totalOutputBytes = terminalMeta.ptyTotalOutputBytes ?? 0;
  const nextOutputSequence = terminalMeta.ptyNextOutputSequence ?? Math.max(1, lastReceivedSequenceRef.current + 1);
  const possibleGapByteEnd = Math.max(0, totalOutputBytes - 1);
  const possibleGapSequenceEnd = Math.max(1, nextOutputSequence - 1);
  const blankDiagnostic = checkpointRecoveryFailed
    ? 'The newest checkpoint was rejected. Rorca preserved the current screen and is replaying later durable deltas; open Transcript for complete structured history.'
    : lifecycleState === 'ended'
      ? 'This generation ended without a recoverable terminal viewport. Open Transcript for captured structured history or Connection diagnostics for the replay source.'
      : lifecycleState === 'unavailable'
        ? 'The PTY could not be attached. The ANSI fallback and Connection diagnostics explain the missing capability.'
        : lifecycleState === 'waiting'
          ? 'The active process is waiting and has not emitted terminal bytes yet. Connection diagnostics show heartbeat and prompt readiness.'
          : 'No current-generation viewport is visible yet. Rorca is reconnecting from the scoped cursor; open Connection diagnostics or Transcript if this persists.';

  return (
    <div className="h-full w-full flex flex-col">
      <div className="sr-only" aria-live="polite" aria-atomic="true">{statusAnnouncement}</div>
      {/* ─── Toolbar ─────────────────────────────────────────────────────── */}
      <div className="shrink-0 px-2 sm:px-3 py-1.5 border-b border-border bg-panel flex flex-wrap sm:flex-nowrap items-center gap-1">
        {!resolvingEffectiveMode && (
          <button
            onClick={() => handleSetMode('raw')}
            aria-pressed={resolvedMode === 'raw'}
            className={`px-2 py-1 text-[11px] font-medium rounded transition-colors focus-visible:outline focus-visible:outline-2 ${
              resolvedMode === 'raw'
                ? 'bg-accent/15 text-accent'
                : 'text-muted hover:text-[var(--text)]'
            }`}
          >
            <span className="flex items-center gap-1">
              <TerminalIcon size={11} />
              {isPtyTerminalMode(terminalMode) ? 'Terminal' : 'Raw'}
            </span>
          </button>
        )}
        <button
          onClick={() => handleSetMode('semantic')}
          aria-pressed={resolvedMode === 'semantic'}
          className={`px-2 py-1 text-[11px] font-medium rounded transition-colors focus-visible:outline focus-visible:outline-2 ${
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
        {isPtyTerminalMode(terminalMeta.requestedTerminalMode) && (
          <button
            onClick={() => handleSetMode('transcript')}
            aria-pressed={resolvedMode === 'transcript'}
            className={`px-2 py-1 text-[11px] font-medium rounded transition-colors focus-visible:outline focus-visible:outline-2 ${
              resolvedMode === 'transcript'
                ? 'bg-accent/15 text-accent'
                : 'text-muted hover:text-[var(--text)]'
            }`}
          >
            <span className="flex items-center gap-1">
              <BookOpen size={11} />
              Transcript
            </span>
          </button>
        )}

        {/* Agent type badge (shown when not claude) */}
        {showAgentBadge && (
          <span className={`ml-1 text-[10px] px-1.5 py-0.5 rounded font-medium ${getAgentBadgeToneClassName(agentType)}`}>
            {getAgentBadgeLabel(agentType, agentModel, { showOpenCodeModel: false, showPiModel: true })}
          </span>
        )}
        <span
          className="ml-1 text-[10px] px-1.5 py-0.5 rounded border font-medium"
          style={{
            color: connectionTone,
            borderColor: connectionTone,
            background: 'color-mix(in srgb, currentColor 12%, transparent)',
          }}
          title={connectionTitle}
          aria-label={`Terminal connection: ${connectionState}. ${connectionTitle}`}
        >
          {connectionState}
        </span>
        <span
          className="basis-full sm:basis-auto order-last sm:order-none text-[10px] text-muted truncate"
          title={surfaceTitle}
        >
          {surfaceLabel}
        </span>

        {/* Copy button (raw mode only) */}
        {!isPtyTerminalMode(terminalMode) && !resolvingEffectiveMode && resolvedMode === 'raw' && (
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

      <details className="shrink-0 border-b border-border/60 bg-panel/50 px-3 py-1.5 text-[11px] text-muted">
        <summary className="cursor-pointer select-none">Connection diagnostics</summary>
        <dl className="mt-1 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 leading-snug">
          <dt>SSE transport</dt>
          <dd>{effectiveSseState}; last event {formatAge(lastSseAt, nowTick)}.</dd>
          <dt>Resume identity</dt>
          <dd>{outputReplaySourceRef.current ?? 'pending source'} / {ptyGenerationIdRef.current ?? 'legacy'} / {lastReceivedSequenceRef.current > 0 ? `after sequence ${lastReceivedSequenceRef.current}` : 'no admitted sequence'}.</dd>
          <dt>Latency contract</dt>
          <dd>Current story viewport is expected within {expectedLatencyMs}ms after durable output; stale state changes to Reconnecting.</dd>
          {isPtyTerminalMode(terminalMeta.requestedTerminalMode) ? (
            <>
              <dt>PTY process</dt>
              <dd>{ptyProcessAlive ? 'alive' : terminalMeta.ptySessionStatus ?? 'pending'}; heartbeat {formatAge(heartbeatMs, nowTick)}.</dd>
              <dt>Raw PTY bytes</dt>
              <dd>{ptyBytesRecent ? 'recent' : `last byte ${formatAge(lastPtyOutputMs, nowTick)}`}; {terminalMeta.ptyTotalOutputBytes ?? 0} total bytes.</dd>
              <dt>Recovery state</dt>
              <dd>checkpoint {terminalMeta.ptyCheckpointSequence ?? 0}; first retained sequence {terminalMeta.ptyFirstRetainedSequence ?? 1}; {compactedBytes} compacted bytes.</dd>
              <dt>Capture integrity</dt>
              <dd>{hasTrueCaptureGap ? `${captureLostBytes} bytes reported lost; possible byte offsets 0–${possibleGapByteEnd}, sequences 1–${possibleGapSequenceEnd}.` : 'No true capture loss reported.'}</dd>
              <dt>Completion file</dt>
              <dd>{terminalMeta.ptyCompletionFileSeen ? `seen ${formatAge(isoToMs(terminalMeta.ptyCompletionFileSeenAt), nowTick)}` : 'not seen'}; primary turn-completion evidence only, never story pass/fail.{terminalMeta.ptyCompletionFileError ? ` Last file diagnostic: ${terminalMeta.ptyCompletionFileError}.` : ''}</dd>
              <dt>Terminal marker</dt>
              <dd>{terminalMeta.ptyCompletionMarkerSeen ? `seen ${formatAge(isoToMs(terminalMeta.ptyCompletionMarkerSeenAt), nowTick)}` : 'not seen'}; corroborating only, never story pass/fail.</dd>
              <dt>Prompt readiness</dt>
              <dd>{terminalMeta.ptyPromptReadinessStatus ?? 'pending'}; {terminalMeta.ptyPromptReadinessReason ?? 'awaiting CLI output'}.</dd>
            </>
          ) : null}
          <dt>Semantic events</dt>
          <dd>{isPtyTerminalMode(terminalMode) ? 'best-effort; raw PTY bytes are authoritative.' : `${semanticRecent ? 'recent' : 'last event ' + formatAge(lastSemanticAt, nowTick)}.`}</dd>
          {ptyRenderBackpressure ? (
            <><dt>Renderer</dt><dd>Output was paused and will resume from the durable cursor after xterm catches up.</dd></>
          ) : null}
        </dl>
      </details>

      {hasCompactedHistory && (
        <div
          className="shrink-0 border-b px-2 sm:px-3 py-1.5 text-[11px]"
          style={{ color: 'var(--terminal-state-notice)', background: 'var(--terminal-state-notice-bg)', borderColor: 'var(--terminal-state-notice)' }}
          role="status"
        >
          Earlier viewport history was compacted{replayTruncatedFrom !== null ? `; this bounded replay begins at output sequence ${replayTruncatedFrom}` : ` (${compactedBytes} bytes)`}. Live output continues from the current generation.{' '}
          <button className="font-semibold underline focus-visible:outline focus-visible:outline-2" onClick={() => handleSetMode('transcript')}>Open complete Transcript</button>.
        </div>
      )}

      {hasTrueCaptureGap && (
        <div
          className="shrink-0 border-b px-2 sm:px-3 py-2 text-xs"
          style={{ color: 'var(--terminal-state-warning)', background: 'var(--terminal-state-warning-bg)', borderColor: 'var(--terminal-state-warning)' }}
          role="alert"
        >
          <strong>Terminal capture loss detected.</strong> {captureLostBytes} bytes are missing within affected byte offsets 0–{possibleGapByteEnd}; logical output sequences 1–{possibleGapSequenceEnd} may be affected. This is distinct from safe checkpoint compaction. Open Transcript for explicit structured sequence gaps.
        </div>
      )}

      {checkpointRecoveryFailed && hasViewportContent && (
        <div className="shrink-0 border-b px-3 py-1.5 text-[11px]" style={{ color: 'var(--terminal-state-warning)', background: 'var(--terminal-state-warning-bg)', borderColor: 'var(--terminal-state-warning)' }} role="status">
          The newest checkpoint was invalid or mismatched, so Rorca preserved the visible viewport and continued with admitted deltas. Open Transcript if earlier context is needed.
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
        {isPtyTerminalMode(terminalMode) ? (
          <div
            ref={ptyContainerRef}
            className="h-full w-full overflow-hidden outline-none"
            data-terminal-input="true"
            data-terminal-input-enabled={ptyProcessAlive && terminalMeta.ptyGenerationId === ptyGenerationIdRef.current ? 'true' : 'false'}
            aria-label={streamEnded ? 'Ended PTY terminal replay' : 'Interactive PTY terminal for the active generation'}
            onMouseDown={() => xtermRef.current?.focus()}
            style={{
              background: 'var(--terminal-bg)',
              display: resolvedMode === 'raw' ? 'block' : 'none',
              boxShadow: ptyFocused ? 'inset 0 0 0 2px var(--terminal-focus-ring)' : 'none',
            }}
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

        {resolvedMode === 'raw' && runMetaResolved && !hasViewportContent && (
          <div
            className="absolute inset-0 z-10 flex items-center justify-center px-4 text-center pointer-events-none"
            style={{ background: 'var(--terminal-bg)', color: 'var(--terminal-fg)' }}
            role="status"
            aria-label={`Terminal viewport empty. ${blankDiagnostic}`}
          >
            <div className="max-w-lg rounded border border-border bg-panel/95 px-4 py-3 text-sm shadow-sm">
              <div className="font-semibold">No current terminal viewport yet</div>
              <p className="mt-1 text-xs text-muted">{blankDiagnostic}</p>
            </div>
          </div>
        )}

        {/* Semantic step list */}
        {resolvedMode === 'semantic' && (
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

        {resolvedMode === 'transcript' && (
          <RunTranscript
            key={`${runId}:${terminalMeta.ptyGenerationId ?? 'legacy'}`}
            runId={runId}
            generationId={terminalMeta.ptyGenerationId ?? null}
            available={terminalMeta.transcriptAvailable === true}
            archiveAvailable={terminalMeta.archiveAvailable === true}
            active={!streamEnded && terminalMeta.ptyGenerationActive === true}
          />
        )}
      </div>
    </div>
  );
});

export default RunTerminal;
