import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AppendPtyTranscriptEventInput } from './pty-transcript-store';
import { isStructuredPiModeEnabled } from './pty-feature-flags';
import type { TerminalMode } from './terminal-mode';

export const PI_STRUCTURED_PROFILE = 'rpc-jsonl-v1' as const;
// `agent_settled` (the only retry/compaction-safe completion event) was added in 0.80.4.
export const PI_STRUCTURED_MIN_VERSION = '0.80.4';

export interface PiStructuredCapability {
  supported: boolean;
  profile: typeof PI_STRUCTURED_PROFILE | null;
  reason: string;
}

function parseVersion(version: string): [number, number, number] | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function detectPiStructuredCapability(version: string | null): PiStructuredCapability {
  if (!version) {
    return { supported: false, profile: null, reason: 'Pi version could not be determined' };
  }
  const installed = parseVersion(version);
  const minimum = parseVersion(PI_STRUCTURED_MIN_VERSION)!;
  if (!installed) {
    return { supported: false, profile: null, reason: `Unparseable Pi version: ${version}` };
  }
  for (let index = 0; index < minimum.length; index += 1) {
    if (installed[index] > minimum[index]) break;
    if (installed[index] < minimum[index]) {
      return {
        supported: false,
        profile: null,
        reason: `Pi ${version} does not support the documented --mode rpc JSONL contract (requires >= ${PI_STRUCTURED_MIN_VERSION})`,
      };
    }
  }
  return {
    supported: true,
    profile: PI_STRUCTURED_PROFILE,
    reason: `Pi ${version} supports the documented --mode rpc JSONL contract`,
  };
}

/** Native PTY modes are the reviewed operator-input fallback; all other Pi runs are structured. */
export function resolvePiExecutionProfile(terminalMode: TerminalMode, operatorKeyboardInput = false): 'structured' | 'interactive' {
  return !isStructuredPiModeEnabled()
    || operatorKeyboardInput
    || terminalMode === 'native-pty'
    || terminalMode === 'pty'
    ? 'interactive'
    : 'structured';
}

export const PI_MAX_PROMPT_BYTES = 64 * 1024 * 1024;

export interface PiPromptFile {
  path: string;
  bytes: number;
  cleanup(): void;
}

export interface PiSessionDirectory {
  path: string;
  cleanup(): void;
}

export function createPiSessionDirectory(runId: number, storyId: string): PiSessionDirectory {
  const safeStory = storyId.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80) || 'story';
  const sessionPath = fs.mkdtempSync(path.join(os.tmpdir(), `rorca-pi-session-${runId}-${safeStory}-`));
  fs.chmodSync(sessionPath, 0o700);
  return {
    path: sessionPath,
    cleanup: () => fs.rmSync(sessionPath, { recursive: true, force: true }),
  };
}

/** Persist a bounded prompt without shell/argv interpolation. The caller sends its contents over RPC stdin. */
export function createPiPromptFile(runId: number, storyId: string, prompt: string): PiPromptFile {
  const safeStory = storyId.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80) || 'story';
  const bytes = Buffer.byteLength(prompt, 'utf8');
  if (bytes > PI_MAX_PROMPT_BYTES) {
    throw new RangeError(`Pi prompt exceeds the ${PI_MAX_PROMPT_BYTES}-byte autonomous delivery limit`);
  }
  const promptPath = path.join(os.tmpdir(), `rorca-pi-${runId}-${safeStory}-${process.pid}-${Date.now()}.txt`);
  const descriptor = fs.openSync(promptPath, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, prompt, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
  return {
    path: promptPath,
    bytes,
    cleanup: () => {
      try { fs.unlinkSync(promptPath); } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    },
  };
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface MappedPiStructuredEvent {
  /** First record retained for simple consumers; `transcripts` is complete. */
  transcript: AppendPtyTranscriptEventInput;
  transcripts: AppendPtyTranscriptEventInput[];
  presentation: string | null;
  usage: TokenUsage | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}

function toolName(event: Record<string, unknown>): string {
  return typeof event.toolName === 'string'
    ? event.toolName
    : typeof event.name === 'string' ? event.name : 'unknown';
}

function toolCorrelation(event: Record<string, unknown>): string {
  return typeof event.toolCallId === 'string'
    ? event.toolCallId
    : `pi-tool-${toolName(event)}`;
}

function extractUsage(event: Record<string, unknown>): TokenUsage | null {
  const message = asRecord(event.message);
  const usage = asRecord(message?.usage ?? event.usage);
  if (!usage) return null;
  const cost = asRecord(usage.cost);
  const inputTokens = Number(usage.input ?? usage.input_tokens ?? 0);
  const outputTokens = Number(usage.output ?? usage.output_tokens ?? 0);
  const costUsd = Number(cost?.total ?? usage.costUsd ?? 0);
  return inputTokens || outputTokens || costUsd
    ? { inputTokens, outputTokens, costUsd }
    : null;
}

function summarize(value: unknown, max = 240): string {
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > max ? `${text.slice(0, max - 3)}...` : text;
  } catch {
    return String(value);
  }
}

/** Map one parsed Pi JSONL event to exactly one ordered, lossless transcript record. */
export function mapPiStructuredEvent(event: unknown): MappedPiStructuredEvent {
  const data = asRecord(event) ?? { type: 'malformed_event', value: event };
  const eventType = typeof data.type === 'string' ? data.type : 'unknown';
  const usage = extractUsage(data);
  let eventRecord: AppendPtyTranscriptEventInput = {
    eventType: 'host_notice',
    eventSource: 'structured',
    role: 'system',
    payload: { piEvent: data },
    authoritative: false,
  };
  let presentation: string | null = null;

  if (eventType === 'message_update') {
    const update = asRecord(data.assistantMessageEvent);
    const delta = update?.type === 'text_delta' && typeof update.delta === 'string' ? update.delta : null;
    eventRecord = {
      eventType: update?.type === 'error' ? 'error' : 'model_message',
      eventSource: 'structured',
      role: 'assistant',
      payload: { piEvent: data },
      authoritative: false,
    };
    presentation = delta;
  } else if (eventType === 'message_start' || eventType === 'message_end' || eventType === 'turn_end') {
    eventRecord = {
      eventType: 'model_message',
      eventSource: 'structured',
      role: 'assistant',
      payload: { piEvent: data, ...(usage ? { usage } : {}) },
      authoritative: false,
    };
  } else if (eventType === 'tool_execution_start') {
    eventRecord = {
      eventType: 'tool_call',
      eventSource: 'structured',
      role: 'tool',
      correlationId: toolCorrelation(data),
      payload: { piEvent: data },
      authoritative: false,
    };
    presentation = `[Tool] ${toolName(data)}: ${summarize(data.args ?? data.input)}\n`;
  } else if (eventType === 'tool_execution_update' || eventType === 'tool_execution_end') {
    eventRecord = {
      eventType: 'tool_result',
      eventSource: 'structured',
      role: 'tool',
      correlationId: toolCorrelation(data),
      payload: { piEvent: data },
      authoritative: false,
    };
    if (eventType === 'tool_execution_end') {
      presentation = `[Tool] ${toolName(data)} ${data.isError === true ? 'failed' : 'done'}\n`;
    }
  } else if (eventType === 'error' || eventType === 'extension_error') {
    eventRecord = {
      eventType: 'error',
      eventSource: 'structured',
      role: 'system',
      payload: { piEvent: data },
      authoritative: false,
    };
    presentation = `[Pi] ${summarize(data.error ?? data.message ?? eventType)}\n`;
  } else if (usage) {
    eventRecord = {
      eventType: 'model_message',
      eventSource: 'structured',
      role: 'assistant',
      payload: { piEvent: data, usage },
      authoritative: false,
    };
  }

  const serialized = Buffer.from(JSON.stringify(data), 'utf8');
  let transcripts = [eventRecord];
  if (serialized.length > 8 * 1024) {
    const total = Math.ceil(serialized.length / (8 * 1024));
    transcripts = Array.from({ length: total }, (_, index) => ({
      ...eventRecord,
      payload: {
        piEventChunk: {
          encoding: 'base64-json',
          index,
          total,
          bytes: serialized.subarray(index * 8 * 1024, (index + 1) * 8 * 1024).toString('base64'),
        },
      },
    }));
  }

  return { transcript: transcripts[0], transcripts, presentation, usage };
}
