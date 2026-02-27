// ─── Semantic Log Parser ──────────────────────────────────────────────────────
// Parses structured JSON output from claude (--output-format stream-json) and
// OpenCode (--format json) into SemanticStep objects for the Run View UI.
// Never throws — malformed or non-semantic lines return null.

export interface SemanticStep {
  type: 'read' | 'write' | 'edit' | 'bash' | 'plan' | 'commit' | 'test' | 'search' | 'unknown';
  label: string;
  detail?: string;
  ts: string;
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
 * Parse a single line of claude `--output-format stream-json` output.
 *
 * Claude stream-json emits one JSON object per line with a `type` field:
 * - `tool_use`: tool invocation with `name` and `input`
 * - `assistant`: text reasoning (maps to 'plan')
 * - `result`: final result with `subtype` ('success'|'error')
 * - `system`, `content_block_start`, `content_block_delta`, etc.
 */
export function parseStreamJsonLine(line: string): SemanticStep | null {
  try {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':')) return null;

    const obj = JSON.parse(trimmed);
    const ts = new Date().toISOString();

    // tool_use → map tool name to step type
    if (obj.type === 'tool_use') {
      const toolName: string = obj.name ?? '';
      const stepType = CLAUDE_TOOL_MAP[toolName] ?? 'unknown';
      const input = obj.input ?? {};

      let label = toolName;
      let detail: string | undefined;

      switch (stepType) {
        case 'read':
          label = `Read ${input.file_path ?? input.url ?? ''}`;
          break;
        case 'write':
          label = `Write ${input.file_path ?? ''}`;
          break;
        case 'edit':
          label = `Edit ${input.file_path ?? input.notebook_path ?? ''}`;
          break;
        case 'bash':
          label = input.description ?? input.command?.slice(0, 80) ?? 'Bash';
          detail = input.command;
          break;
        case 'search':
          label = `${toolName} ${input.pattern ?? input.query ?? ''}`;
          detail = input.path;
          break;
        case 'plan':
          label = toolName === 'Task' ? `Task: ${(input.description ?? '').slice(0, 60)}` : 'Planning';
          break;
        default:
          label = toolName;
      }

      return { type: stepType, label, detail, ts };
    }

    // assistant text → plan step (only if there's substantial content)
    if (obj.type === 'assistant' && typeof obj.message === 'string' && obj.message.length > 10) {
      return {
        type: 'plan',
        label: 'Reasoning',
        detail: obj.message.slice(0, 200),
        ts,
      };
    }

    // result → commit (if success) or test (if error)
    if (obj.type === 'result') {
      if (obj.subtype === 'success') {
        const resultText: string = obj.result ?? obj.text ?? '';
        // Check if the result mentions a git commit
        const commitMatch = resultText.match(/commit\s+([a-f0-9]{7,})/i)
          ?? resultText.match(/\[(?:feat|fix|chore|test|refactor)[^\]]*\]\s+(.{1,80})/);
        if (commitMatch) {
          return {
            type: 'commit',
            label: commitMatch[1] ?? 'Commit',
            detail: resultText.slice(0, 200),
            ts,
          };
        }
        return { type: 'commit', label: 'Run completed', detail: resultText.slice(0, 200), ts };
      }
      if (obj.subtype === 'error') {
        return { type: 'unknown', label: 'Error', detail: (obj.error ?? obj.result ?? '').slice(0, 200), ts };
      }
    }

    return null;
  } catch {
    return null;
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
export function parseOpenCodeLine(line: string): SemanticStep | null {
  try {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':')) return null;

    const obj = JSON.parse(trimmed);
    const ts = obj.timestamp ?? new Date().toISOString();

    // tool_call → map tool name to step type
    if (obj.type === 'tool_call') {
      const toolName: string = (obj.tool ?? obj.name ?? '').toLowerCase();
      const stepType = OPENCODE_TOOL_MAP[toolName] ?? 'unknown';
      const args = obj.args ?? obj.input ?? {};

      let label = obj.tool ?? obj.name ?? toolName;
      let detail: string | undefined;

      switch (stepType) {
        case 'read':
          label = `Read ${args.file_path ?? args.path ?? args.url ?? ''}`;
          break;
        case 'write':
          label = `Write ${args.file_path ?? args.path ?? ''}`;
          break;
        case 'edit':
          label = `Edit ${args.file_path ?? args.path ?? ''}`;
          break;
        case 'bash':
          label = args.description ?? (typeof args.command === 'string' ? args.command.slice(0, 80) : 'Bash');
          detail = args.command;
          break;
        case 'search':
          label = `${obj.tool ?? 'Search'} ${args.pattern ?? args.query ?? ''}`;
          detail = args.path;
          break;
        default:
          label = obj.tool ?? obj.name ?? 'Unknown tool';
      }

      return { type: stepType, label, detail, ts };
    }

    // assistant → plan
    if (obj.type === 'assistant' && typeof obj.content === 'string' && obj.content.length > 10) {
      return {
        type: 'plan',
        label: 'Reasoning',
        detail: obj.content.slice(0, 200),
        ts,
      };
    }

    // completion → commit
    if (obj.type === 'completion') {
      const text: string = obj.content ?? obj.result ?? '';
      return { type: 'commit', label: 'Run completed', detail: text.slice(0, 200), ts };
    }

    // error
    if (obj.type === 'error') {
      return {
        type: 'unknown',
        label: 'Error',
        detail: (obj.message ?? obj.error ?? '').slice(0, 200),
        ts,
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Parse a log line using the appropriate parser based on agent type.
 * Falls back to claude parser if agent is unknown.
 */
export function parseLine(line: string, agent: string): SemanticStep | null {
  if (agent === 'opencode') {
    return parseOpenCodeLine(line);
  }
  return parseStreamJsonLine(line);
}
