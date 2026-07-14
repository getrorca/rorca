/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import type { AgentType } from './config';

export interface InteractivePtyProcess {
  write(data: string): void;
}

export interface PtyLaunchInput {
  agentType: AgentType;
  prompt: string;
  cwd: string;
  runId: number;
  storyId: string;
}

export interface PtyLaunchCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
  prompt: string;
  injectionMode?: 'bracketed-paste' | 'chunked-typing';
  cleanup?: () => void;
}

export interface PtyPromptInput {
  basePrompt: string;
  runId: number;
  storyId: string;
  agentType: AgentType;
  completionMarker: string;
  markerFilePath: string;
}

/** Terminal marker state is deliberately separate from marker-file completion. */
export interface PtyCompletionState {
  completionMarker: string;
  tail: string;
  markerSeen: boolean;
}

export interface PtyCompletionSignal {
  type: 'marker';
  marker: string;
}

export interface PtyReadinessState {
  agentType: AgentType;
  tail: string;
  ready: boolean;
  readyReason: string | null;
}

export interface PtyReadinessSignal {
  type: 'ready';
  reason: string;
}

export interface PtyRunState {
  runId: number;
  storyId: string;
  cwd: string;
}

export interface InteractivePtyAgentAdapter {
  agentType: AgentType;
  resolveCommand(input: PtyLaunchInput): PtyLaunchCommand;
  preparePrompt(input: PtyPromptInput): string;
  injectPrompt(pty: InteractivePtyProcess, prompt: string): Promise<void>;
  detectReadiness?(chunk: string, state: PtyReadinessState): PtyReadinessSignal | null;
  detectCompletion?(chunk: string, state: PtyCompletionState): PtyCompletionSignal | null;
  cleanup?(state: PtyRunState): Promise<void>;
}

export const BRACKETED_PASTE_START = '\x1b[200~';
export const BRACKETED_PASTE_END = '\x1b[201~';
export const DEFAULT_PTY_TYPE_CHUNK_SIZE = 4096;
export const DEFAULT_PTY_TYPE_DELAY_MS = 5;
export const DEFAULT_PTY_READINESS_TIMEOUT_MS = 12_000;
const READINESS_TAIL_BYTES = 8 * 1024;

function sanitizeMarkerComponent(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_');
}

export function buildPtyCompletionMarker(runId: number, storyId: string): string {
  return `__RORCA_STORY_DONE_${runId}_${sanitizeMarkerComponent(storyId)}__`;
}

export function buildPtyMarkerFilePath(runId: number, storyId: string): string {
  return `.rorca/progress/run-${runId}/${sanitizeMarkerComponent(storyId)}.done.json`;
}

export function createPtyCompletionState(completionMarker: string): PtyCompletionState {
  return { completionMarker, tail: '', markerSeen: false };
}

export function createPtyReadinessState(agentType: AgentType): PtyReadinessState {
  return { agentType, tail: '', ready: false, readyReason: null };
}

function describeMarkerWithoutEcho(marker: string): string {
  const parts = marker.match(/.{1,12}/g) ?? [marker];
  return JSON.stringify(parts);
}

export function appendPtyCompletionInstructions(input: PtyPromptInput): string {
  const markerPartsJson = describeMarkerWithoutEcho(input.completionMarker);
  const markerFileJson = JSON.stringify(input.markerFilePath);
  const instructions = [
    '## Rorca PTY Completion Contract',
    'You are running inside a real interactive PTY. When your implementation turn is complete, write the completion status file, then print the completion marker as your final visible action.',
    `1. Build it by concatenating these JSON string parts in order, with no quotes, spaces, or separators: ${markerPartsJson}`,
    `2. Create the parent directory and write a small JSON status file at ${input.markerFilePath} with storyId ${JSON.stringify(input.storyId)}, runId ${input.runId}, and marker equal to that constructed value.`,
    'The status file is Rorca\'s primary turn-completion signal. The printed marker only corroborates it.',
    'The marker only tells Rorca that your agent turn is complete. It does not mean the story passed; Rorca will still run merge and validation gates before marking the story passed.',
    'If you are blocked, explain the blocker, write the same status file, then print the constructed marker so Rorca can stop the interactive turn safely.',
    `Shell-safe marker path reference: ${markerFileJson}`,
  ].join('\n');

  return [input.basePrompt.trimEnd(), '', instructions].filter(Boolean).join('\n');
}

/** Remove ANSI control sequences before looking for a visible interactive prompt. */
function plainTerminalText(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

/**
 * CLI-specific readiness evidence. We deliberately require terminal output from
 * the spawned CLI rather than sleeping after spawn: a slow banner is safe, and
 * a missing banner degrades through the caller's bounded fallback timeout.
 */
export function detectPtyCliReadiness(
  chunk: string,
  state: PtyReadinessState,
): PtyReadinessSignal | null {
  if (state.ready) return null;
  state.tail = `${state.tail}${plainTerminalText(chunk)}`.slice(-READINESS_TAIL_BYTES);
  const tail = state.tail;
  const promptAtEnd = /(?:^|[\r\n])\s*(?:[>❯›]|\$)\s*$/m.test(tail);
  const rules: Record<AgentType, RegExp> = {
    claude: /(?:claude\s+code|anthropic|❯)/i,
    opencode: /(?:open\s*code|opencode|›)/i,
    codex: /(?:openai\s+codex|codex|›)/i,
    pi: /(?:\bpi\b|pi\s+coding|›)/i,
  };
  const matched = rules[state.agentType].test(tail);
  if (!matched && !promptAtEnd) return null;

  // A branded banner is enough for CLIs that render their input widget later;
  // a visible prompt is accepted only after the CLI has emitted some bytes.
  const reason = matched ? `${state.agentType}_banner_or_prompt` : `${state.agentType}_interactive_prompt`;
  state.ready = true;
  state.readyReason = reason;
  return { type: 'ready', reason };
}

export async function injectPromptWithBracketedPaste(
  pty: InteractivePtyProcess,
  prompt: string,
  // Kept as a no-op compatibility option for adapters/tests built before
  // readiness-driven injection. Delaying here would reintroduce blind timing.
  _opts: { startupDelayMs?: number } = {},
): Promise<void> {
  pty.write(BRACKETED_PASTE_START);
  pty.write(prompt);
  pty.write(BRACKETED_PASTE_END);
  pty.write('\r');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function injectPromptWithChunkedTyping(
  pty: InteractivePtyProcess,
  prompt: string,
  opts: { startupDelayMs?: number; chunkSize?: number; chunkDelayMs?: number } = {},
): Promise<void> {
  const chunkSize = opts.chunkSize ?? DEFAULT_PTY_TYPE_CHUNK_SIZE;
  const chunkDelayMs = opts.chunkDelayMs ?? DEFAULT_PTY_TYPE_DELAY_MS;
  for (let offset = 0; offset < prompt.length; offset += chunkSize) {
    pty.write(prompt.slice(offset, offset + chunkSize));
    if (chunkDelayMs > 0) await sleep(chunkDelayMs);
  }
  pty.write('\r');
}

/**
 * Detect a marker that an agent printed after completing its turn. This is
 * corroborating telemetry only: the engine never resolves a turn from it.
 * Because the prompt never contains the contiguous marker, terminal echo also
 * cannot self-complete the turn.
 */
export function detectCompletionMarkerAcrossChunks(
  chunk: string,
  state: PtyCompletionState,
): PtyCompletionSignal | null {
  if (state.markerSeen) return null;

  const search = `${state.tail}${chunk}`;
  if (search.includes(state.completionMarker)) {
    state.markerSeen = true;
    state.tail = '';
    return { type: 'marker', marker: state.completionMarker };
  }

  const keep = Math.max(0, state.completionMarker.length - 1);
  state.tail = keep > 0 ? search.slice(-keep) : '';
  return null;
}

export function createBaseInteractivePtyAdapter(
  agentType: AgentType,
  resolveCommand: (input: PtyLaunchInput) => PtyLaunchCommand,
): InteractivePtyAgentAdapter {
  return {
    agentType,
    resolveCommand,
    preparePrompt: appendPtyCompletionInstructions,
    injectPrompt: (pty, prompt) => injectPromptWithBracketedPaste(pty, prompt),
    detectReadiness: detectPtyCliReadiness,
    detectCompletion: detectCompletionMarkerAcrossChunks,
  };
}
