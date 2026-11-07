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
  preparedMarkerFilePath?: string;
  generationId?: string;
  generationToken?: string;
  attempt?: number;
  executionProfile?: 'interactive-pty' | 'structured-rpc';
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
  handledStartupPrompts: Set<string>;
}

export interface PtyReadinessSignal {
  type: 'ready';
  reason: string;
}

export interface PtyPostInjectionState {
  agentType: AgentType;
  tail: string;
  chooserEnterSent: boolean;
  submitEnterSent: boolean;
  handledInteractivePrompts: Set<string>;
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
  handleStartupPrompt?(pty: InteractivePtyProcess, chunk: string, state: PtyReadinessState): boolean;
  /** Recovery for CLIs whose prompt injection can stall in a paste dialog. */
  handlePostInjectionOutput?(pty: InteractivePtyProcess, chunk: string, state: PtyPostInjectionState): boolean;
  detectReadiness?(chunk: string, state: PtyReadinessState): PtyReadinessSignal | null;
  detectCompletion?(chunk: string, state: PtyCompletionState): PtyCompletionSignal | null;
  cleanup?(state: PtyRunState): Promise<void>;
}

export const BRACKETED_PASTE_START = '\x1b[200~';
export const BRACKETED_PASTE_END = '\x1b[201~';
export const DEFAULT_PTY_TYPE_CHUNK_SIZE = 4096;
export const DEFAULT_PTY_TYPE_DELAY_MS = 5;
export const DEFAULT_PTY_READINESS_TIMEOUT_MS = 12_000;
export const DEFAULT_PTY_SUBMIT_DELAY_MS = 75;
export const OMP_PTY_SUBMIT_DELAY_MS = 500;
export function getPtySubmitDelayMs(agentType: AgentType): number {
  // OMP materializes large bracketed pastes as a composer attachment. Enter
  // sent during that render is discarded, leaving the autonomous turn idle.
  return agentType === 'omp' ? OMP_PTY_SUBMIT_DELAY_MS : DEFAULT_PTY_SUBMIT_DELAY_MS;
}
export function getPtyReadinessTimeoutMs(agentType: AgentType): number {
  // OMP can spend more than twelve seconds loading its subscription profile,
  // explicit Rorca extension, and MCP clients before the composer is stable.
  // Injecting during that redraw loses the story prompt and makes the CLI exit
  // without ever producing agent output.
  if (agentType === 'codex' || agentType === 'omp') return 60_000;
  if (agentType === 'opencode' || agentType === 'claude') return 30_000;
  return DEFAULT_PTY_READINESS_TIMEOUT_MS;
}
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
  return { agentType, tail: '', ready: false, readyReason: null, handledStartupPrompts: new Set() };
}

export function createPtyPostInjectionState(agentType: AgentType): PtyPostInjectionState {
  return {
    agentType,
    tail: '',
    chooserEnterSent: false,
    submitEnterSent: false,
    handledInteractivePrompts: new Set(),
  };
}

function describeMarkerWithoutEcho(marker: string): string {
  const parts = marker.match(/.{1,12}/g) ?? [marker];
  return JSON.stringify(parts);
}

export function appendPtyCompletionInstructions(input: PtyPromptInput): string {
  const markerPartsJson = describeMarkerWithoutEcho(input.completionMarker);
  const markerFileJson = JSON.stringify(input.markerFilePath);
  const structured = input.executionProfile === 'structured-rpc';
  const preparedMarkerFileJson = input.preparedMarkerFilePath
    ? JSON.stringify(input.preparedMarkerFilePath)
    : null;
  const instructions = preparedMarkerFileJson
    ? [
        structured ? '## Rorca Structured Completion Contract' : '## Rorca PTY Completion Contract',
        'Rorca has staged a host-bound completion receipt for this exact run, story, generation, and attempt.',
        `1. When your implementation turn is complete, atomically move ${preparedMarkerFileJson} to ${markerFileJson}. Do not recreate, edit, or transcribe the receipt.`,
        ...(structured
          ? ['2. End with your final response. Rorca also promotes the staged receipt when it observes the provider terminal event, so opaque authority identifiers never depend on model transcription.']
          : [
              `2. Build the visible completion marker by concatenating these JSON string parts in order, with no quotes, spaces, or separators: ${markerPartsJson}`,
              '3. Print that marker as your final visible action. If the atomic move was lost, Rorca can promote the exact staged receipt only after observing this non-echoed terminal marker.',
            ]),
        'The status file only tells Rorca that your agent turn is complete. It does not mean the story passed; Rorca will still run merge and validation gates before marking the story passed.',
        structured
          ? 'If you are blocked, explain the blocker and perform the same atomic move so Rorca can stop the turn safely.'
          : 'If you are blocked, explain the blocker, perform the same atomic move, then print the constructed marker so Rorca can stop the interactive turn safely.',
      ]
    : [
        structured ? '## Rorca Structured Completion Contract' : '## Rorca PTY Completion Contract',
        structured
          ? 'You are running through Pi RPC in a non-interactive autonomous pipeline. When your implementation turn is complete, write the completion status file; a final printed marker is corroborating presentation only.'
          : 'You are running inside a real interactive PTY. When your implementation turn is complete, write the completion status file, then print the completion marker as your final visible action.',
        `1. Build it by concatenating these JSON string parts in order, with no quotes, spaces, or separators: ${markerPartsJson}`,
        `2. Create the parent directory and write a small JSON status file at ${input.markerFilePath} with storyId ${JSON.stringify(input.storyId)}, runId ${input.runId}, marker equal to that constructed value${input.generationId ? `, generationId ${JSON.stringify(input.generationId)}` : ''}${input.generationToken ? `, generationToken ${JSON.stringify(input.generationToken)}` : ''}${input.attempt !== undefined ? `, and attempt ${input.attempt}` : ''}.`,
        'The status file is Rorca\'s primary turn-completion signal. The printed marker only corroborates it.',
        'The marker only tells Rorca that your agent turn is complete. It does not mean the story passed; Rorca will still run merge and validation gates before marking the story passed.',
        'If you are blocked, explain the blocker, write the same status file, then print the constructed marker so Rorca can stop the interactive turn safely.',
        `Shell-safe marker path reference: ${markerFileJson}`,
      ];

  return [input.basePrompt.trimEnd(), '', instructions.join('\n')].filter(Boolean).join('\n');
}

/** Remove ANSI control sequences before looking for a visible interactive prompt. */
function plainTerminalText(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

/**
 * Handle exact first-run confirmation screens before considering a CLI ready.
 * Fresh branch-only worktrees trigger Claude's folder-trust screen, and fresh
 * isolated homes trigger its bypass-permissions acknowledgement. Injecting the
 * story prompt into either selector would deadlock until the PTY watchdog fires.
 */
export function handlePtyCliStartupPrompt(
  pty: InteractivePtyProcess,
  chunk: string,
  state: PtyReadinessState,
): boolean {
  if (state.ready) return false;
  const previousTail = state.tail;

  if (state.agentType === 'omp') {
    state.tail = `${state.tail}${plainTerminalText(chunk)}`.slice(-READINESS_TAIL_BYTES);
    const toolboxKey = 'omp-lsp-toolbox';
    if (/\bLSP Servers\b/i.test(state.tail)) {
      if (!state.handledStartupPrompts.has(toolboxKey)) {
        state.handledStartupPrompts.add(toolboxKey);
        pty.write('\x1b');
      }
      state.tail = '';
      return true;
    }
    state.tail = previousTail;
    return false;
  }

  if (state.agentType !== 'claude') return false;
  state.tail = `${state.tail}${plainTerminalText(chunk)}`.slice(-READINESS_TAIL_BYTES);
  const tail = state.tail;
  const trustKey = 'claude-folder-trust';
  const bypassKey = 'claude-bypass-acknowledgement';
  const trustScreen = /Accessing\s+workspace:/i.test(tail)
    || /project\s+you\s+created\s+or\s+one\s+you\s+trust/i.test(tail);
  const bypassScreen = /Claude\s+Code\s+running\s+in\s+Bypass\s+Permissions\s+mode/i.test(tail);

  if (trustScreen) {
    if (/Yes,\s*I\s+trust\s+this\s+folder/i.test(tail) && !state.handledStartupPrompts.has(trustKey)) {
      state.handledStartupPrompts.add(trustKey);
      pty.write('\r');
    }
    state.tail = '';
    return true;
  }

  if (bypassScreen) {
    if (/Yes,\s*I\s+accept/i.test(tail) && !state.handledStartupPrompts.has(bypassKey)) {
      state.handledStartupPrompts.add(bypassKey);
      // Claude defaults this warning to "No, exit"; select the second row.
      pty.write('\x1b[B\r');
    }
    state.tail = '';
    return true;
  }

  // Readiness detection owns the normal rolling tail; avoid appending this
  // chunk twice when it was not a confirmation screen.
  state.tail = previousTail;
  return false;
}

/**
 * Recover OMP UI states that otherwise strand an autonomous PTY turn:
 * large-paste chooser/composer, startup toolbox, and crash-report consent.
 * Every key sequence is idempotently emitted at most once per generation.
 */
export function handleOmpPasteChooserOutput(
  pty: InteractivePtyProcess,
  chunk: string,
  state: PtyPostInjectionState,
): boolean {
  if (state.agentType !== 'omp') return false;
  state.tail = `${state.tail}${plainTerminalText(chunk)}`.slice(-READINESS_TAIL_BYTES);
  const tail = state.tail;

  const crashReporterKey = 'omp-crash-reporter';
  const crashReporter = /agent is melting down over a tool[\s\S]*alerting the devs[\s\S]*\bYes\b[\s\S]*\bNo\b/i.test(tail);
  if (crashReporter && !state.handledInteractivePrompts.has(crashReporterKey)) {
    state.handledInteractivePrompts.add(crashReporterKey);
    // The observed selector defaults to Yes. Choose No: local diagnostics stay
    // in the PTY archive and autonomous execution resumes without telemetry.
    pty.write('\x1b[B\r');
    state.tail = '';
    return true;
  }

  const toolboxKey = 'omp-lsp-toolbox';
  if (/\bLSP Servers\b/i.test(tail) && !state.handledInteractivePrompts.has(toolboxKey)) {
    state.handledInteractivePrompts.add(toolboxKey);
    pty.write('\x1b');
    state.tail = '';
    return true;
  }

  const chooserMenu = /Pasted \d+ lines[\s\S]*Attach as a wrapped block[\s\S]*Paste inline[\s\S]*Esc to paste inline/i.test(tail);
  const composerMarker = /\[Paste #\d+, \+?\d+ lines?\]/.test(tail);

  if (chooserMenu && !state.chooserEnterSent) {
    state.chooserEnterSent = true;
    pty.write('\r');
    return true;
  }
  // Some OMP repaints omit the chooser bytes and expose only the staged
  // attachment. Because this handler is armed only after Rorca injected the
  // story prompt, one bounded Enter is the deterministic submit recovery.
  if (composerMarker && !state.submitEnterSent) {
    state.submitEnterSent = true;
    pty.write('\r');
    return true;
  }
  return false;
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
    omp: /(?:\bomp\b|oh\s+my\s+pi|›)/i,
  };
  const matched = state.agentType === 'claude'
    // Claude prints its brand on folder-trust and startup-transition screens.
    // Require the rendered permission-mode footer before injecting into the
    // actual composer; otherwise prompt bytes can be lost during the redraw.
    ? rules.claude.test(tail) && /(?:accept\s+edits|shift\+tab\s+to\s+cycle)/i.test(tail)
    : state.agentType === 'codex'
      // Codex renders its brand while MCP clients are still starting. Wait for
      // the final composer footer so the startup redraw cannot discard input.
      ? rules.codex.test(tail)
        && /[›>]\s*/.test(tail)
        && /(?:default|tokens\s+left)/i.test(tail)
        && (/(?:MCP\s+startup\s+(?:incomplete|complete)|MCP\s+servers\s+ready)/i.test(tail)
          || !/Starting\s+MCP\s+servers/i.test(tail))
      : rules[state.agentType].test(tail);
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
  opts: { startupDelayMs?: number; submitDelayMs?: number } = {},
): Promise<void> {
  if ((opts.startupDelayMs ?? 0) > 0) await sleep(opts.startupDelayMs!);
  pty.write(BRACKETED_PASTE_START);
  pty.write(prompt);
  pty.write(BRACKETED_PASTE_END);
  // Claude's Ink input widget needs one render turn after bracketed paste;
  // an immediate Enter leaves the paste preview in the composer indefinitely.
  await sleep(opts.submitDelayMs ?? DEFAULT_PTY_SUBMIT_DELAY_MS);
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
    injectPrompt: (pty, prompt) => injectPromptWithBracketedPaste(pty, prompt, {
      submitDelayMs: getPtySubmitDelayMs(agentType),
    }),
    handleStartupPrompt: handlePtyCliStartupPrompt,
    handlePostInjectionOutput: handleOmpPasteChooserOutput,
    detectReadiness: detectPtyCliReadiness,
    detectCompletion: detectCompletionMarkerAcrossChunks,
  };
}
