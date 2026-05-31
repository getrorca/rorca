/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

// ─── Semantic Log Parser ──────────────────────────────────────────────────────
// Parses structured JSON output from claude (--output-format stream-json) and
// OpenCode (--format json) into SemanticStep objects for the Run View UI.
// Never throws — malformed or non-semantic lines return [].

export interface SemanticStep {
  type: 'read' | 'write' | 'edit' | 'bash' | 'plan' | 'commit' | 'test' | 'search' | 'unknown';
  label: string;
  detail?: string;
  ts: string;
  /** Original tool name (e.g. 'webfetch', 'grep') — used by frontend for icon mapping */
  toolName?: string;
  /** Duration in milliseconds (populated when tool_result follows tool_call) */
  durationMs?: number;
  /** Whether this step represents an error */
  isError?: boolean;
  /** Tool output (stdout/stderr for bash, result text for others) */
  output?: string;
}

// ─── Claude stream-json tool name → SemanticStep type mapping ─────────────────

const CLAUDE_TOOL_MAP: Record<string, SemanticStep['type']> = {
  Read: 'read',
  Write: 'write',
  Edit: 'edit',
  Bash: 'bash',
  Glob: 'search',
  Grep: 'search',
  WebSearch: 'search',
  WebFetch: 'read',
  Task: 'plan',
  TodoWrite: 'plan',
  NotebookEdit: 'edit',
};

/**
 * Parse a single content block from a Claude tool_use block into a SemanticStep.
 */
function parseClaudeToolBlock(block: Record<string, unknown>, ts: string): SemanticStep {
  const toolName: string = (block.name as string) ?? '';
  const stepType = CLAUDE_TOOL_MAP[toolName] ?? 'unknown';
  const input = (block.input as Record<string, unknown>) ?? {};

  let label = toolName;
  let detail: string | undefined;

  switch (stepType) {
    case 'read':
      label = `Read ${(input.file_path as string) ?? (input.url as string) ?? ''}`;
      break;
    case 'write':
      label = `Write ${(input.file_path as string) ?? ''}`;
      break;
    case 'edit':
      label = `Edit ${(input.file_path as string) ?? (input.notebook_path as string) ?? ''}`;
      break;
    case 'bash':
      label = (input.description as string) ?? ((input.command as string)?.slice(0, 80)) ?? 'Bash';
      detail = input.command as string;
      break;
    case 'search':
      label = `${toolName} ${(input.pattern as string) ?? (input.query as string) ?? ''}`;
      detail = input.path as string;
      break;
    case 'plan':
      label = toolName === 'Task' ? `Task: ${((input.description as string) ?? '').slice(0, 60)}` : 'Planning';
      break;
    default:
      label = toolName;
  }

  return { type: stepType, label, detail, ts, toolName };
}

/**
 * Parse a single line of claude `--output-format stream-json` output.
 *
 * Claude stream-json emits one JSON object per line with a `type` field.
 * Tool calls are embedded inside the `assistant` event at `message.content[]`
 * (NOT as standalone top-level `tool_use` events). Each assistant event can
 * contain multiple tool_use blocks, so this returns SemanticStep[].
 *
 * Event shapes:
 * - `assistant`: reasoning + tool calls in message.content[] array
 *   - content blocks: { type: 'tool_use', name, input } or { type: 'text', text }
 * - `result`: final result with `subtype` ('success'|'error')
 * - `system`, `tool_result`, etc.: ignored
 */
export function parseStreamJsonLine(line: string): SemanticStep[] {
  try {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':')) return [];

    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const ts = new Date().toISOString();

    // assistant event — tool calls and text reasoning are in message.content[]
    if (obj.type === 'assistant') {
      const message = obj.message as Record<string, unknown> | undefined;
      const content = message?.content;
      if (!Array.isArray(content)) return [];

      const steps: SemanticStep[] = [];
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === 'tool_use') {
          steps.push(parseClaudeToolBlock(block, ts));
        } else if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 20) {
          steps.push({
            type: 'plan',
            label: 'Reasoning',
            detail: block.text.slice(0, 200),
            ts,
          });
        }
      }
      return steps;
    }

    // result → commit (if success) or error
    if (obj.type === 'result') {
      if (obj.subtype === 'success') {
        const resultText: string = (obj.result as string) ?? (obj.text as string) ?? '';
        const commitMatch = resultText.match(/commit\s+([a-f0-9]{7,})/i)
          ?? resultText.match(/\[(?:feat|fix|chore|test|refactor)[^\]]*\]\s+(.{1,80})/);
        if (commitMatch) {
          return [{ type: 'commit', label: commitMatch[1] ?? 'Commit', detail: resultText.slice(0, 200), ts }];
        }
        return [{ type: 'commit', label: 'Run completed', detail: resultText.slice(0, 200), ts }];
      }
      if (obj.subtype === 'error') {
        return [{ type: 'unknown', label: 'Error', detail: ((obj.error as string) ?? (obj.result as string) ?? '').slice(0, 200), ts, isError: true }];
      }
    }

    return [];
  } catch {
    return [];
  }
}

// ─── OpenCode event type → SemanticStep type mapping ──────────────────────────

const OPENCODE_TOOL_MAP: Record<string, SemanticStep['type']> = {
  read: 'read',
  write: 'write',
  edit: 'edit',
  bash: 'bash',
  glob: 'search',
  grep: 'search',
  webfetch: 'read',
  websearch: 'search',
};

/**
 * Parse a single line of OpenCode `--format json` output.
 *
 * OpenCode JSON events have a `type` field with values like:
 * - `tool_call`: tool invocation with `tool` and `args`
 * - `tool_result`: tool output
 * - `assistant`: model reasoning
 * - `completion`: final result
 * - `error`: error
 */
export function parseOpenCodeLine(line: string): SemanticStep[] {
  try {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':')) return [];

    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const ts = (obj.timestamp as string) ?? new Date().toISOString();

    // tool_call → map tool name to step type
    if (obj.type === 'tool_call') {
      const rawToolName: string = ((obj.tool as string) ?? (obj.name as string) ?? '').toLowerCase();
      const stepType = OPENCODE_TOOL_MAP[rawToolName] ?? 'unknown';
      const args = (obj.args as Record<string, unknown>) ?? (obj.input as Record<string, unknown>) ?? {};

      let label = (obj.tool as string) ?? (obj.name as string) ?? rawToolName;
      let detail: string | undefined;

      switch (stepType) {
        case 'read':
          label = `Read ${(args.file_path as string) ?? (args.path as string) ?? (args.url as string) ?? ''}`;
          break;
        case 'write':
          label = `Write ${(args.file_path as string) ?? (args.path as string) ?? ''}`;
          break;
        case 'edit':
          label = `Edit ${(args.file_path as string) ?? (args.path as string) ?? ''}`;
          break;
        case 'bash':
          label = (args.description as string) ?? (typeof args.command === 'string' ? (args.command as string).slice(0, 80) : 'Bash');
          detail = args.command as string;
          break;
        case 'search':
          label = `${(obj.tool as string) ?? 'Search'} ${(args.pattern as string) ?? (args.query as string) ?? ''}`;
          detail = args.path as string;
          break;
        default:
          label = (obj.tool as string) ?? (obj.name as string) ?? 'Unknown tool';
      }

      return [{ type: stepType, label, detail, ts, toolName: rawToolName }];
    }

    // tool_result → enrich previous step with output and duration
    if (obj.type === 'tool_result') {
      const output: string = ((obj.content as string) ?? (obj.result as string) ?? '') as string;
      const durationMs: number | undefined = typeof obj.duration_ms === 'number' ? (obj.duration_ms as number) : undefined;
      const toolName: string = ((obj.tool as string) ?? (obj.name as string) ?? '').toLowerCase();
      const stepType = OPENCODE_TOOL_MAP[toolName] || undefined;
      if (toolName) {
        return [{
          type: stepType ?? 'unknown',
          label: `${(obj.tool as string) ?? toolName} result`,
          detail: output.slice(0, 500),
          ts,
          toolName,
          durationMs,
          output: output.slice(0, 2000),
        }];
      }
      return [];
    }

    // assistant → plan
    if (obj.type === 'assistant' && typeof obj.content === 'string' && (obj.content as string).length > 10) {
      return [{
        type: 'plan',
        label: 'Reasoning',
        detail: (obj.content as string).slice(0, 200),
        ts,
      }];
    }

    // completion → commit
    if (obj.type === 'completion') {
      const text: string = (obj.content as string) ?? (obj.result as string) ?? '';
      const exitCode = (obj.exitCode as number) ?? (obj.exit_code as number);
      const isFailed = exitCode !== undefined && exitCode !== 0;
      return [{
        type: isFailed ? 'unknown' : 'commit',
        label: isFailed ? 'Failed' : 'Run completed',
        detail: text.slice(0, 200),
        ts,
        isError: isFailed || undefined,
      }];
    }

    // error
    if (obj.type === 'error') {
      return [{
        type: 'unknown',
        label: 'Error',
        detail: ((obj.message as string) ?? (obj.error as string) ?? '').slice(0, 200),
        ts,
        isError: true,
      }];
    }

    return [];
  } catch {
    return [];
  }
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

function normalizeCodexLine(line: string): string {
  const clean = stripAnsi(line);
  return clean.split('\r').at(-1)?.trim() ?? '';
}

export function parseCodexLine(line: string): SemanticStep[] {
  const clean = normalizeCodexLine(line);
  if (!clean) return [];

  const match = clean.match(/^\[([A-Za-z]+)\]\s*(.*)$/);
  if (!match) return [];

  const [, rawPrefix, rawDetail] = match;
  const prefix = rawPrefix.toLowerCase();
  const detail = rawDetail.trim();
  const ts = new Date().toISOString();

  switch (prefix) {
    case 'read':
      return [{ type: 'read', label: `Read ${detail}`.trim(), detail: detail || undefined, ts, toolName: 'read' }];
    case 'write':
      return [{ type: 'write', label: `Write ${detail}`.trim(), detail: detail || undefined, ts, toolName: 'write' }];
    case 'edit':
      return [{ type: 'edit', label: `Edit ${detail}`.trim(), detail: detail || undefined, ts, toolName: 'edit' }];
    case 'planning':
    case 'plan':
      return [{ type: 'plan', label: detail ? `Task: ${detail.slice(0, 60)}` : 'Reasoning', detail: detail || undefined, ts, toolName: prefix }];
    case 'command':
    case 'bash':
      return [{ type: 'bash', label: detail || 'Bash', detail: detail || undefined, ts, toolName: prefix }];
    case 'grep':
    case 'search':
      return [{ type: 'search', label: `${rawPrefix} ${detail}`.trim(), detail: detail || undefined, ts, toolName: prefix }];
    case 'test':
      return [{ type: 'test', label: detail ? `Test ${detail}` : 'Test', detail: detail || undefined, ts, toolName: prefix }];
    default:
      return [];
  }
}

/**
 * Parse a log line using the appropriate parser based on agent type.
 * Returns an array of SemanticStep objects (empty array if nothing to emit).
 * Falls back to claude parser if agent is unknown.
 */
export function parseLine(line: string, agent: string): SemanticStep[] {
  if (agent === 'opencode') {
    return parseOpenCodeLine(line);
  }
  if (agent === 'codex') {
    return parseCodexLine(line);
  }
  return parseStreamJsonLine(line);
}
