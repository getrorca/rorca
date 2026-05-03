/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

// ─── OpenCode Streaming JSON Parser ──────────────────────────────────────────
//
// Parses the `opencode run --format json` event stream into:
//   1. SemanticStep entries (for the Run View semantic log)
//   2. Human-readable terminal lines (for xterm.js display)
//   3. Story completion / error signals (for execution-engine.ts)
//
// Handles partial/chunked JSON — each chunk may contain zero, one, or multiple
// newline-delimited JSON objects, possibly split mid-line across chunks.

import type { SemanticStep } from './semantic-log-parser';
import { logger } from './logger';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Parsed event from OpenCode's JSON stream */
export interface OpenCodeEvent {
  type: string;
  tool?: string;
  name?: string;
  args?: Record<string, unknown>;
  input?: Record<string, unknown>;
  content?: string;
  result?: string;
  message?: string;
  error?: string;
  timestamp?: string;
  exitCode?: number;
  exit_code?: number;
  status?: string;
  [key: string]: unknown;
}

/** Token usage extracted from OpenCode events */
export interface OpenCodeTokenUsage {
  inputTokens: number;
  outputTokens: number;
  model?: string;
}

/** Signals detected from the event stream */
export interface StreamSignal {
  completed: boolean;
  failed: boolean;
  error?: string;
}

/** Result from processing a single event */
export interface ParsedEvent {
  /** Original parsed JSON object */
  raw: OpenCodeEvent;
  /** Semantic log entry (null if event is not semantically interesting) */
  semantic: SemanticStep | null;
  /** Human-readable terminal line for xterm.js */
  terminal: string;
  /** Signal if this event indicates completion or failure */
  signal: StreamSignal;
  /** Token usage from this event (null if not a usage-bearing event) */
  tokenUsage: OpenCodeTokenUsage | null;
}

// ─── Tool Mapping ────────────────────────────────────────────────────────────

const TOOL_MAP: Record<string, SemanticStep['type']> = {
  read: 'read',
  write: 'write',
  edit: 'edit',
  bash: 'bash',
  glob: 'search',
  grep: 'search',
  webfetch: 'read',
  websearch: 'search',
};

// ANSI color codes for terminal output
const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
};

// ─── Token Usage Extraction ─────────────────────────────────────────────────

/**
 * Extract token usage from an OpenCode event, if present.
 * OpenCode may report usage in completion events, dedicated usage events,
 * or as nested fields (e.g. event.usage, event.stats, event.tokens).
 */
function extractTokenUsage(event: OpenCodeEvent): OpenCodeTokenUsage | null {
  // Direct fields on the event
  const usage = (event as Record<string, unknown>).usage as Record<string, unknown> | undefined;
  const stats = (event as Record<string, unknown>).stats as Record<string, unknown> | undefined;
  const tokens = (event as Record<string, unknown>).tokens as Record<string, unknown> | undefined;

  const source = usage ?? stats ?? tokens;
  if (source) {
    const input = (source.input_tokens ?? source.inputTokens ?? source.prompt_tokens ?? 0) as number;
    const output = (source.output_tokens ?? source.outputTokens ?? source.completion_tokens ?? 0) as number;
    const model = (source.model ?? event.model ?? undefined) as string | undefined;
    if (input > 0 || output > 0) {
      return { inputTokens: input, outputTokens: output, model };
    }
  }

  // Top-level input_tokens / output_tokens (some providers flatten these)
  const topInput = (event as Record<string, unknown>).input_tokens as number | undefined;
  const topOutput = (event as Record<string, unknown>).output_tokens as number | undefined;
  if ((topInput && topInput > 0) || (topOutput && topOutput > 0)) {
    return {
      inputTokens: topInput ?? 0,
      outputTokens: topOutput ?? 0,
      model: (event as Record<string, unknown>).model as string | undefined,
    };
  }

  return null;
}

// ─── Single Event Parser ─────────────────────────────────────────────────────

/**
 * Parse a single OpenCode JSON event into semantic + terminal + signal.
 * Never throws — returns a fallback ParsedEvent on malformed input.
 */
export function parseOpenCodeEvent(event: OpenCodeEvent): ParsedEvent {
  const ts = event.timestamp ?? new Date().toISOString();
  const noSignal: StreamSignal = { completed: false, failed: false };
  const tokenUsage = extractTokenUsage(event);

  // ── tool_call ──────────────────────────────────────────────────────
  if (event.type === 'tool_call') {
    const toolName = (event.tool ?? event.name ?? '').toLowerCase();
    const stepType = TOOL_MAP[toolName] ?? 'unknown';
    const args = event.args ?? event.input ?? {};

    let label: string;
    let detail: string | undefined;
    let terminalLine: string;

    switch (stepType) {
      case 'read': {
        const filePath = (args.file_path ?? args.path ?? args.url ?? '') as string;
        label = `Read ${filePath}`;
        terminalLine = `${ANSI.cyan}[Read]${ANSI.reset} ${filePath}`;
        break;
      }
      case 'write': {
        const filePath = (args.file_path ?? args.path ?? '') as string;
        label = `Write ${filePath}`;
        terminalLine = `${ANSI.green}[Write]${ANSI.reset} ${filePath}`;
        break;
      }
      case 'edit': {
        const filePath = (args.file_path ?? args.path ?? '') as string;
        label = `Edit ${filePath}`;
        terminalLine = `${ANSI.yellow}[Edit]${ANSI.reset} ${filePath}`;
        break;
      }
      case 'bash': {
        const cmd = typeof args.command === 'string' ? args.command : '';
        const desc = typeof args.description === 'string' ? args.description : '';
        label = desc || cmd.slice(0, 80) || 'Bash';
        detail = cmd;
        terminalLine = `${ANSI.magenta}[Bash]${ANSI.reset} ${ANSI.dim}$${ANSI.reset} ${cmd.slice(0, 120)}`;
        break;
      }
      case 'search': {
        const displayTool = event.tool ?? 'Search';
        const pattern = (args.pattern ?? args.query ?? '') as string;
        label = `${displayTool} ${pattern}`;
        detail = args.path as string | undefined;
        terminalLine = `${ANSI.blue}[Search]${ANSI.reset} ${displayTool} ${pattern}${detail ? ` in ${detail}` : ''}`;
        break;
      }
      default: {
        label = event.tool ?? event.name ?? 'Unknown tool';
        terminalLine = `${ANSI.gray}[Tool]${ANSI.reset} ${label}`;
      }
    }

    return {
      raw: event,
      semantic: { type: stepType, label, detail, ts },
      terminal: terminalLine,
      signal: noSignal,
      tokenUsage,
    };
  }

  // ── tool_result ────────────────────────────────────────────────────
  if (event.type === 'tool_result') {
    const output = (event.content ?? event.result ?? '') as string;
    const truncated = output.length > 200 ? output.slice(0, 200) + '...' : output;
    const terminalLine = `${ANSI.gray}  → ${truncated.split('\n')[0]}${ANSI.reset}`;

    return {
      raw: event,
      semantic: null, // tool_result is not a separate semantic step
      terminal: terminalLine,
      signal: noSignal,
      tokenUsage,
    };
  }

  // ── assistant (reasoning) ──────────────────────────────────────────
  if (event.type === 'assistant') {
    const content = (event.content ?? event.message ?? '') as string;
    if (content.length <= 10) {
      return { raw: event, semantic: null, terminal: '', signal: noSignal, tokenUsage };
    }

    return {
      raw: event,
      semantic: {
        type: 'plan',
        label: 'Reasoning',
        detail: content.slice(0, 200),
        ts,
      },
      terminal: `${ANSI.dim}[Planning]${ANSI.reset} ${content.slice(0, 120)}`,
      signal: noSignal,
      tokenUsage,
    };
  }

  // ── completion ─────────────────────────────────────────────────────
  if (event.type === 'completion') {
    const text = (event.content ?? event.result ?? '') as string;
    const exitCode = event.exitCode ?? event.exit_code;
    const isFailed = exitCode !== undefined && exitCode !== 0;

    return {
      raw: event,
      semantic: {
        type: isFailed ? 'unknown' : 'commit',
        label: isFailed ? 'Failed' : 'Run completed',
        detail: text.slice(0, 200),
        ts,
      },
      terminal: isFailed
        ? `${ANSI.red}${ANSI.bold}[Completed]${ANSI.reset} ${ANSI.red}Exit code: ${exitCode}${ANSI.reset}`
        : `${ANSI.green}${ANSI.bold}[Completed]${ANSI.reset} ${text.slice(0, 120)}`,
      signal: {
        completed: !isFailed,
        failed: isFailed,
        error: isFailed ? `Exit code: ${exitCode}` : undefined,
      },
      tokenUsage,
    };
  }

  // ── usage (dedicated token usage event) ────────────────────────────
  if (event.type === 'usage') {
    return {
      raw: event,
      semantic: null,
      terminal: '',
      signal: noSignal,
      tokenUsage,
    };
  }

  // ── error ──────────────────────────────────────────────────────────
  if (event.type === 'error') {
    const errMsg = (event.message ?? event.error ?? 'Unknown error') as string;

    return {
      raw: event,
      semantic: {
        type: 'unknown',
        label: 'Error',
        detail: errMsg.slice(0, 200),
        ts,
      },
      terminal: `${ANSI.red}${ANSI.bold}[Error]${ANSI.reset} ${ANSI.red}${errMsg.slice(0, 200)}${ANSI.reset}`,
      signal: {
        completed: false,
        failed: true,
        error: errMsg,
      },
      tokenUsage,
    };
  }

  // ── status ─────────────────────────────────────────────────────────
  if (event.type === 'status') {
    const status = (event.status ?? event.message ?? '') as string;
    return {
      raw: event,
      semantic: null,
      terminal: `${ANSI.gray}[Status]${ANSI.reset} ${status}`,
      signal: noSignal,
      tokenUsage,
    };
  }

  // ── system / heartbeat / unknown ───────────────────────────────────
  return {
    raw: event,
    semantic: null,
    terminal: '',
    signal: noSignal,
    tokenUsage,
  };
}

// ─── Streaming JSON Line Parser ──────────────────────────────────────────────

/**
 * Streaming parser for OpenCode's newline-delimited JSON output.
 *
 * Buffers partial lines across chunks. Call `push(chunk)` with each data
 * chunk from stdout. Returns an array of parsed events for each push.
 * Call `flush()` at stream end to process any remaining buffered data.
 */
export class OpenCodeStreamParser {
  private buffer = '';
  private _totalInputTokens = 0;
  private _totalOutputTokens = 0;
  private _lastModel: string | undefined;

  /**
   * Feed a raw chunk from the OpenCode process stdout.
   * Returns parsed events for all complete JSON lines in this chunk.
   */
  push(chunk: string): ParsedEvent[] {
    this.buffer += chunk;
    const results: ParsedEvent[] = [];

    // Process all complete newline-delimited lines
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIdx);
      this.buffer = this.buffer.slice(newlineIdx + 1);

      const parsed = this.parseLine(line);
      if (parsed) {
        results.push(parsed);
        this.accumulateTokens(parsed);
      }
    }

    return results;
  }

  /**
   * Flush any remaining buffered data (call at stream end).
   * Returns parsed events for the final partial line, if any.
   */
  flush(): ParsedEvent[] {
    if (!this.buffer.trim()) {
      this.buffer = '';
      return [];
    }

    const line = this.buffer;
    this.buffer = '';

    const parsed = this.parseLine(line);
    return parsed ? [parsed] : [];
  }

  /**
   * Reset parser state (clear buffer).
   */
  reset(): void {
    this.buffer = '';
    this._totalInputTokens = 0;
    this._totalOutputTokens = 0;
    this._lastModel = undefined;
  }

  /** Count of malformed lines since last valid JSON — for recovery diagnostics */
  private malformedCount = 0;

  /** Get the count of malformed lines encountered */
  getMalformedCount(): number {
    return this.malformedCount;
  }

  /** Get accumulated token usage across all parsed events */
  getTokenUsage(): OpenCodeTokenUsage {
    return {
      inputTokens: this._totalInputTokens,
      outputTokens: this._totalOutputTokens,
      model: this._lastModel,
    };
  }

  /** Accumulate token usage from a parsed event */
  private accumulateTokens(event: ParsedEvent): void {
    if (event.tokenUsage) {
      this._totalInputTokens += event.tokenUsage.inputTokens;
      this._totalOutputTokens += event.tokenUsage.outputTokens;
      if (event.tokenUsage.model) {
        this._lastModel = event.tokenUsage.model;
      }
    }
  }

  /**
   * Parse a single complete line. Returns null for empty/unparseable lines.
   * Malformed JSON is logged and emitted as raw terminal output for recovery.
   */
  private parseLine(line: string): ParsedEvent | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    // Skip SSE comment lines
    if (trimmed.startsWith(':')) return null;

    try {
      const event: OpenCodeEvent = JSON.parse(trimmed);
      // Valid JSON resets malformed counter
      if (this.malformedCount > 0) {
        this.malformedCount = 0;
      }
      return parseOpenCodeEvent(event);
    } catch {
      this.malformedCount++;

      // Detect rate limit errors in raw text output (some providers return
      // plain text 429 errors that aren't wrapped in JSON)
      const lower = trimmed.toLowerCase();
      if (lower.includes('429') || lower.includes('rate limit') || lower.includes('too many requests')
          || lower.includes('quota exceeded') || lower.includes('tokens per min')) {
        const waitMatch = trimmed.match(/(?:retry[- ]after|wait|reset in)[:\s]+(\d+)/i);
        const waitSec = waitMatch ? parseInt(waitMatch[1], 10) : null;
        return {
          raw: { type: 'error', message: trimmed, error: 'rate_limit' },
          semantic: {
            type: 'unknown',
            label: 'Rate Limited',
            detail: waitSec ? `Rate limited — waiting ${waitSec}s` : 'Rate limited by provider',
            ts: new Date().toISOString(),
          },
          terminal: `${ANSI.yellow}${ANSI.bold}[Rate Limited]${ANSI.reset} ${ANSI.yellow}${waitSec ? `Waiting ${waitSec}s...` : trimmed.slice(0, 120)}${ANSI.reset}`,
          signal: { completed: false, failed: false, error: `rate_limit:${waitSec ?? ''}` },
          tokenUsage: null,
        };
      }

      // Not valid JSON — emit as raw terminal output (some opencode versions
      // may emit plain text status lines mixed with JSON)
      if (trimmed.length > 0) {
        // Log malformed lines for diagnostics (first occurrence per burst)
        if (this.malformedCount === 1) {
          logger.error(`[opencode-parser] Malformed JSON line: ${trimmed.slice(0, 200)}`);
        }
        return {
          raw: { type: 'raw', content: trimmed },
          semantic: null,
          terminal: trimmed,
          signal: { completed: false, failed: false },
          tokenUsage: null,
        };
      }
      return null;
    }
  }
}

// ─── Convenience: Parse complete JSON string (for testing / log replay) ──────

/**
 * Parse a complete multi-line JSON event stream (e.g., from a log file).
 * Returns all parsed events. Does NOT handle partial lines — use
 * OpenCodeStreamParser for streaming data.
 */
export function parseOpenCodeStream(data: string): ParsedEvent[] {
  const parser = new OpenCodeStreamParser();
  const results = parser.push(data);
  results.push(...parser.flush());
  return results;
}

/**
 * Extract the aggregate signal from a stream of parsed events.
 * Returns true for completed if ANY event signaled completion,
 * true for failed if ANY event signaled failure (failure overrides completion).
 */
export function aggregateSignals(events: ParsedEvent[]): StreamSignal {
  let completed = false;
  let failed = false;
  let lastError: string | undefined;

  for (const event of events) {
    if (event.signal.completed) completed = true;
    if (event.signal.failed) {
      failed = true;
      lastError = event.signal.error;
    }
  }

  return { completed: completed && !failed, failed, error: lastError };
}

/**
 * Aggregate token usage from a list of parsed events.
 * Sums all token counts and takes the last non-null model.
 */
export function aggregateTokenUsage(events: ParsedEvent[]): OpenCodeTokenUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  let model: string | undefined;

  for (const event of events) {
    if (event.tokenUsage) {
      inputTokens += event.tokenUsage.inputTokens;
      outputTokens += event.tokenUsage.outputTokens;
      if (event.tokenUsage.model) model = event.tokenUsage.model;
    }
  }

  return { inputTokens, outputTokens, model };
}
