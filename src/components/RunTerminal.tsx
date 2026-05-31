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

export interface RunTerminalHandle {
  scrollToStory: (storyId: string) => void;
  writeMarker: (text: string) => void;
}

interface RunTerminalProps {
  runId: number;
  workspaceId?: string | null;
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

// ─── Markdown → HTML converter (for terminal display) ────────────────────────

/**
 * Convert basic markdown to HTML for terminal display.
 * Must be called on RAW text BEFORE ansi-to-html, because ansi-to-html
 * replaces \n with <br> tags, breaking ^/$ multiline anchors.
 * We HTML-escape the text ourselves first, then apply markdown patterns.
 */
function markdownToHtml(text: string): string {
  // HTML-escape first so our injected tags aren't re-escaped downstream.
  // We set escapeXML:false on the ansi converter when using this path,
  // OR we call this before the ansi converter on plain text segments.
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return escaped
    // Headings: ### text (at line start)
    .replace(/^#{1,3}\s+(.+)$/gm, '<span style="color:#93c5fd;font-weight:bold">$1</span>')
    // Bold **text**
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    // Bold __text__
    .replace(/__(.+?)__/g, '<b>$1</b>')
    // Italic *text* (single asterisk, not double)
    .replace(/\*([^*\n]+?)\*/g, '<i>$1</i>')
    // Inline code `code`
    .replace(/`([^`\n]+)`/g, '<code style="background:rgba(255,255,255,0.08);padding:0 3px;border-radius:3px;color:#fbbf24">$1</code>')
    // Horizontal rule ---
    .replace(/^[-]{3,}\s*$/gm, '<span style="color:#4b5563">────────────────────────────────</span>')
    // Bullet list items: "- item" or "– item" at line start
    .replace(/^[-–]\s+(.+)$/gm, '  <span style="color:#6b7280">•</span> $1');
}

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
          // Convert markdown → HTML, prefix so flushBuffer skips XML escaping
          const text = block.text.trim();
          if (text) {
            const truncated = text.length > 500 ? text.slice(0, 500) + '...' : text;
            // markdownToHtml already HTML-escapes the text, so prefix each output line
            const converted = markdownToHtml(truncated);
            parts.push(...converted.split('\n').map(l => HTML_LINE_PREFIX + l));
          }
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

    // ── OpenCode --format json events ──────────────────────────────────────
    // Step lifecycle — always suppress first (step_finish can be large JSON)
    if (ev.type === 'step_start' || ev.type === 'step_finish') return null;

    // Text output from the model — blank line before for visual breathing room
    if (ev.type === 'text' && ev.part?.text) {
      const text = (ev.part.text as string).trim();
      if (!text) return null;
      // Don't truncate — model text is the primary signal, show it all
      const converted = markdownToHtml(text);
      // Prepend a blank line so each model response is visually separated
      const lines = converted.split('\n').map((l: string) => HTML_LINE_PREFIX + l);
      return '\n' + lines.join('\n') + '\n';
    }

    // Tool calls — render with icons like Claude's output
    if (ev.type === 'tool_use' && ev.part) {
      const tool: string = ev.part.tool ?? ev.part.state?.tool ?? '';
      const state = ev.part.state ?? {};
      const input = state.input ?? {};
      const status: string = state.status ?? '';
      // Only show completed tool calls (not pending — those show twice otherwise)
      if (status === 'pending') return null;
      const fp: string = input.filePath ?? input.file_path ?? input.path ?? '';
      const cmd: string = input.command ?? '';
      const pattern: string = input.pattern ?? input.query ?? '';
      // Shorten path to last 2 segments for readability
      const shortFp = fp ? fp.split('/').slice(-2).join('/') : '';
      switch (tool) {
        case 'read':      return `  📖 Read ${shortFp}`;
        case 'write':     return `  📝 Write ${shortFp}`;
        case 'edit':      return `  ✏️  Edit ${shortFp}`;
        case 'bash':      return `  🔧 ${cmd.split('\n')[0].slice(0, 160)}`;
        case 'glob':      return `  🔍 Glob ${pattern}`;
        case 'grep':      return `  🔍 Grep ${pattern}`;
        case 'webfetch':  return `  🌐 ${input.url ?? ''}`;
        case 'websearch': return `  🔍 ${pattern}`;
        default:          return tool ? `  🔧 ${tool}${shortFp ? ' ' + shortFp : ''}` : null;
      }
    }

    // Error events — show prominently with spacing
    if (ev.type === 'error') {
      const errData = ev.error ?? ev.part?.error ?? ev.data ?? {};
      const msg = typeof errData === 'string' ? errData
        : (errData as any).message ?? (errData as any).name ?? JSON.stringify(errData).slice(0, 300);
      return `\n❌ ${msg}\n`;
    }

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

/** Parse a single line into a SemanticStep. Handles both Claude --verbose text and OpenCode JSON. */
function parseVerboseLine(line: string): SemanticStep | null {
  const clean = stripAnsi(line).trim();
  if (!clean || clean.length < 4) return null;

  // ── OpenCode JSON event parsing ──
  if (clean.startsWith('{')) {
    try {
      const ev = JSON.parse(clean);

      // OpenCode tool_use event → semantic step
      if (ev.type === 'tool_use' && ev.part) {
        const tool: string = ev.part.tool ?? '';
        const state = ev.part.state ?? {};
        const input = state.input ?? {};
        const status: string = state.status ?? '';
        if (status === 'pending') return null;
        const fp: string = input.filePath ?? input.file_path ?? '';
        const shortFp = fp.split('/').slice(-2).join('/');
        const cmd: string = input.command ?? '';
        const pattern: string = input.pattern ?? input.query ?? '';

        const TOOL_MAP: Record<string, SemanticStep['type']> = {
          read: 'read', write: 'write', edit: 'edit', bash: 'bash',
          glob: 'search', grep: 'search', webfetch: 'unknown', websearch: 'search',
        };
        const stepType = TOOL_MAP[tool] ?? 'unknown';
        let label: string;
        switch (tool) {
          case 'read':      label = `Read ${shortFp}`; break;
          case 'write':     label = `Write ${shortFp}`; break;
          case 'edit':      label = `Edit ${shortFp}`; break;
          case 'bash':      label = cmd.slice(0, 100) || 'Bash'; break;
          case 'glob':      label = `Glob: ${pattern}`; break;
          case 'grep':      label = `Grep: ${pattern}`; break;
          case 'webfetch':  label = `WebFetch: ${(input.url ?? '').slice(0, 80)}`; break;
          case 'websearch': label = `WebSearch: ${pattern}`; break;
          default:          label = tool || 'Unknown tool';
        }
        return { type: stepType, label: label.slice(0, 100), ts: new Date().toISOString(), toolName: tool };
      }

      // OpenCode text event → plan step (model is reasoning/responding)
      if (ev.type === 'text' && ev.part?.text) {
        const text = (ev.part.text as string).trim();
        if (text.length > 10) {
          return { type: 'plan', label: text.slice(0, 80), ts: new Date().toISOString() };
        }
      }

      // OpenCode error → error step
      if (ev.type === 'error') {
        const errData = ev.error ?? ev.data ?? {};
        const msg = typeof errData === 'string' ? errData
          : errData.message ?? errData.name ?? 'Unknown error';
        return { type: 'unknown', label: `Error: ${String(msg).slice(0, 80)}`, ts: new Date().toISOString(), isError: true };
      }
    } catch {
      // Not valid JSON — fall through to regex matching
    }
  }

  // ── Claude --verbose text patterns ──
  for (const [pattern, type] of VERBOSE_PATTERNS) {
    const m = clean.match(pattern);
    if (m) {
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

// Lines with this prefix are pre-converted HTML — skip XML escaping in the ANSI converter.
const HTML_LINE_PREFIX = '\x01';

// ─── Flush buffer interval ───────────────────────────────────────────────────

const FLUSH_INTERVAL_MS = 80;
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

const RunTerminal = forwardRef<RunTerminalHandle, RunTerminalProps>(function RunTerminal({ runId, workspaceId }, ref) {
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
  const [terminalMode, setTerminalMode] = useState<TerminalMode>('ansi-html');
  const terminalModeRef = useRef<TerminalMode>('ansi-html');

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

  // Persist mode changes
  const handleSetMode = useCallback((m: 'raw' | 'semantic') => {
    setMode(m);
    try { localStorage.setItem(lsKey(runId), m); } catch { /* noop */ }
  }, [runId]);

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

  useEffect(() => {
    if (terminalMode !== 'pty' || !ptyContainerRef.current) return;

    const terminal = new Terminal({
      fontFamily: 'JetBrains Mono, Fira Code, monospace',
      fontSize: window.innerWidth < 768 ? 10 : 12,
      lineHeight: 1.3,
      convertEol: false,
      cursorBlink: true,
      theme: getPtyTheme(resolved),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(ptyContainerRef.current);
    fitAddon.fit();
    xtermRef.current = terminal;
    fitAddonRef.current = fitAddon;
    for (const chunk of pendingPtyChunksRef.current) {
      terminal.write(chunk as unknown as string);
    }
    pendingPtyChunksRef.current = [];

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
      resizeDebounceRef.current = setTimeout(syncSize, 80);
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
    terminalModeRef.current = 'ansi-html';
    pendingPtyChunksRef.current = [];
    setAgentType('claude');
    setSteps([]);
    setExpandedSet(new Set());
    setStreamDone(false);
    setTerminalMode('ansi-html');
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
        const meta = JSON.parse(e.data) as { agentType?: string; terminalMode?: TerminalMode; terminal_mode?: TerminalMode; isPty?: boolean };
        if (meta.agentType === 'opencode' || meta.agentType === 'codex') {
          setAgentType(meta.agentType);
        }
        const nextMode = meta.terminalMode ?? meta.terminal_mode;
        const isPty = meta.isPty ?? nextMode === 'pty';
        terminalModeRef.current = isPty ? 'pty' : 'ansi-html';
        setTerminalMode(isPty ? 'pty' : 'ansi-html');
        if (isPty) {
          setMode('raw');
        }
      } catch { /* ignore */ }
    });

    es.addEventListener('chunk', (e: MessageEvent) => {
      try {
        const binary = atob(e.data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

        if (terminalModeRef.current === 'pty') {
          if (xtermRef.current) xtermRef.current.write(bytes as unknown as string);
          else pendingPtyChunksRef.current.push(bytes);
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
  }, [runId, ansiConverter, ansiConverterNoEscape, workspaceId, scheduleFlush]);

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
