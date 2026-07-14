/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
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
  startupDelayMs?: number;
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

export interface PtyCompletionState {
  completionMarker: string;
  tail: string;
  markerSeen: boolean;
}

export interface PtyCompletionSignal {
  type: 'marker';
  marker: string;
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
  detectCompletion?(chunk: string, state: PtyCompletionState): PtyCompletionSignal | null;
  cleanup?(state: PtyRunState): Promise<void>;
}

export const BRACKETED_PASTE_START = '\x1b[200~';
export const BRACKETED_PASTE_END = '\x1b[201~';
export const DEFAULT_PTY_STARTUP_DELAY_MS = 700;
export const DEFAULT_PTY_TYPE_CHUNK_SIZE = 4096;
export const DEFAULT_PTY_TYPE_DELAY_MS = 5;

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

function describeMarkerWithoutEcho(marker: string): string {
  const parts = marker.match(/.{1,12}/g) ?? [marker];
  return JSON.stringify(parts);
}

export function appendPtyCompletionInstructions(input: PtyPromptInput): string {
  const markerPartsJson = describeMarkerWithoutEcho(input.completionMarker);
  const markerFileJson = JSON.stringify(input.markerFilePath);
  const instructions = [
    '## Rorca PTY Completion Contract',
    'You are running inside a real interactive PTY. When your implementation turn is complete, do BOTH of the following as the final visible actions:',
    `1. Print the completion marker on its own line. Build it by concatenating these JSON string parts in order, with no quotes, spaces, or separators: ${markerPartsJson}`,
    `2. Write a small JSON status file at ${input.markerFilePath} with at least: {"storyId": ${JSON.stringify(input.storyId)}, "runId": ${input.runId}, "marker": "<the same concatenated completion marker>"}.`,
    'The marker only tells Rorca that your agent turn is complete. It does not mean the story passed; Rorca will still run merge and validation gates before marking the story passed.',
    'If you are blocked, still print the same completion marker after clearly explaining the blocker so Rorca can stop the interactive turn safely.',
    `Shell-safe marker path reference: ${markerFileJson}`,
  ].join('\n');

  return [input.basePrompt.trimEnd(), '', instructions].filter(Boolean).join('\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function injectPromptWithBracketedPaste(
  pty: InteractivePtyProcess,
  prompt: string,
  opts: { startupDelayMs?: number } = {},
): Promise<void> {
  const startupDelayMs = opts.startupDelayMs ?? DEFAULT_PTY_STARTUP_DELAY_MS;
  if (startupDelayMs > 0) await sleep(startupDelayMs);

  pty.write(BRACKETED_PASTE_START);
  pty.write(prompt);
  pty.write(BRACKETED_PASTE_END);
  pty.write('\r');
}

export async function injectPromptWithChunkedTyping(
  pty: InteractivePtyProcess,
  prompt: string,
  opts: { startupDelayMs?: number; chunkSize?: number; chunkDelayMs?: number } = {},
): Promise<void> {
  const startupDelayMs = opts.startupDelayMs ?? DEFAULT_PTY_STARTUP_DELAY_MS;
  const chunkSize = opts.chunkSize ?? DEFAULT_PTY_TYPE_CHUNK_SIZE;
  const chunkDelayMs = opts.chunkDelayMs ?? DEFAULT_PTY_TYPE_DELAY_MS;
  if (startupDelayMs > 0) await sleep(startupDelayMs);

  for (let offset = 0; offset < prompt.length; offset += chunkSize) {
    pty.write(prompt.slice(offset, offset + chunkSize));
    if (chunkDelayMs > 0) await sleep(chunkDelayMs);
  }
  pty.write('\r');
}

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
    detectCompletion: detectCompletionMarkerAcrossChunks,
  };
}
