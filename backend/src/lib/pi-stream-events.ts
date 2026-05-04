// ─── Pi CLI JSON-L Stream Schema ────────────────────────────────────────────
// Captured from `pi --print --mode json` v0.67.2.
// Pi emits one JSON object per line; types here mirror that wire format.

export interface PiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export type PiContentPart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; thinkingSignature?: string }
  | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> };

export interface PiAssistantMessage {
  role: 'assistant';
  content: PiContentPart[];
  api: string;
  provider: string;
  model: string;
  usage: PiUsage;
  stopReason: 'stop' | 'toolUse' | 'maxTokens' | string;
  timestamp: number;
  responseId?: string;
}

export interface PiUserMessage {
  role: 'user';
  content: { type: 'text'; text: string }[];
  timestamp: number;
}

export interface PiToolResultMessage {
  role: 'toolResult';
  toolCallId: string;
  toolName: string;
  content: { type: 'text'; text: string }[];
  isError: boolean;
  timestamp: number;
}

export type PiMessage = PiUserMessage | PiAssistantMessage | PiToolResultMessage;

export type PiUpdateSubtype =
  | 'text_start' | 'text_delta' | 'text_end'
  | 'thinking_start' | 'thinking_delta' | 'thinking_end'
  | 'toolcall_start' | 'toolcall_delta' | 'toolcall_end';

export type PiStreamEvent =
  | { type: 'session'; version: number; id: string; timestamp: string; cwd: string }
  | { type: 'agent_start' }
  | { type: 'agent_end' }
  | { type: 'turn_start' }
  | { type: 'turn_end'; message: PiAssistantMessage; toolResults: PiToolResultMessage[] }
  | { type: 'message_start'; message: PiMessage }
  | { type: 'message_end'; message: PiMessage }
  | {
      type: 'message_update';
      assistantMessageEvent: {
        type: PiUpdateSubtype;
        contentIndex: number;
        delta?: string;
        partial: PiAssistantMessage;
      };
      message: PiAssistantMessage;
    }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; arguments?: Record<string, unknown> }
  | { type: 'tool_execution_end'; toolCallId: string; toolName: string; isError: boolean };
