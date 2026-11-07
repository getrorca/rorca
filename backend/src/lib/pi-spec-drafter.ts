/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { detectPi } from './pi-detector';
import { prepareAutonomousModelSandboxLaunch } from './autonomous-sandbox';

export interface PiDraftUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

export interface PiDraftSpecResult {
  text: string;
  usage: PiDraftUsage;
  sessionId?: string;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface RpcState {
  process: ReturnType<typeof spawn>;
  requestId: number;
  pending: Map<string, PendingRequest>;
  stderr: string;
  lineBuffer: string;
}

function serializeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function buildPiForgeSkillMarkdown(): string {
  return [
    '---',
    'name: rorca-backend-forge-drafter',
    'description: Draft a canonical Rorca spec JSON from a brief using skill-first reasoning. Backend persistence and enrichment happen outside the skill.',
    '---',
    '',
    '# Rorca Backend Forge Drafter',
    '',
    'You are the spec author for Rorca backend forge requests.',
    '',
    '## Core rule',
    'You are responsible for the reasoning and drafting. Do not hand spec generation back to a backend generation endpoint.',
    '',
    '## Workflow',
    '1. Understand the brief and requested scope.',
    '2. Read the provided direction/context bundle carefully.',
    '3. Inspect the repository with tools when local code context would improve the spec.',
    '4. Validate whether the provided context is actually relevant; ignore noisy context when necessary.',
    '5. Draft the best possible canonical spec JSON.',
    '6. Self-check the JSON for structural validity, story quality, and dependency correctness before finishing.',
    '',
    '## Quality bar',
    '- Produce implementation-ready user stories, not vague product prose.',
    '- Keep stories concrete, testable, and reasonably scoped for autonomous execution.',
    '- Dependencies must reflect actual implementation order.',
    '- Acceptance criteria must be specific and binary/testable.',
    '- Include suggestedSkills / suggestedPersona / suggestedReviewers when the prompt requests them.',
    '',
    '## Output contract',
    '- Your final answer must be ONLY a raw JSON object.',
    '- No markdown fences.',
    '- No explanation before or after the JSON.',
    '- Start with { and end with }.',
  ].join('\n');
}

function writeForgeSkillFile(scratchDir: string): string {
  const filePath = path.join(scratchDir, 'forge-skill.md');
  fs.writeFileSync(filePath, buildPiForgeSkillMarkdown(), { encoding: 'utf8', mode: 0o600 });
  return filePath;
}

function setupRpcStream(state: RpcState): void {
  state.process.stdout?.on('data', (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    state.lineBuffer += text;

    while (true) {
      const newlineIdx = state.lineBuffer.indexOf('\n');
      if (newlineIdx === -1) break;
      const line = state.lineBuffer.slice(0, newlineIdx).replace(/\r$/, '').trim();
      state.lineBuffer = state.lineBuffer.slice(newlineIdx + 1);
      if (!line) continue;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (parsed.type === 'response') {
        const id = typeof parsed.id === 'string' ? parsed.id : undefined;
        if (!id) continue;
        const pending = state.pending.get(id);
        if (!pending) continue;
        state.pending.delete(id);
        if (parsed.success === false) {
          const message = typeof parsed.error === 'string'
            ? parsed.error
            : `pi RPC command failed (${String(parsed.command ?? 'unknown')})`;
          pending.reject(new Error(message));
        } else {
          pending.resolve(parsed);
        }
      }
    }
  });

  state.process.stderr?.on('data', (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    state.stderr += text;
    if (state.stderr.length > 16384) state.stderr = state.stderr.slice(-16384);
  });

  const rejectPending = (error: Error): void => {
    for (const pending of state.pending.values()) pending.reject(error);
    state.pending.clear();
  };
  state.process.once('error', error => rejectPending(new Error(`Pi forge process failed: ${error.message}`)));
  state.process.once('close', code => {
    if (state.pending.size > 0) {
      const stderrTail = state.stderr.trim().slice(-400);
      rejectPending(new Error(`Pi forge process closed before RPC completion (${String(code)})${stderrTail ? `: ${stderrTail}` : ''}`));
    }
  });
}

function sendRpcCommand(state: RpcState, command: object, timeoutMs: number = 30_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = `req_${++state.requestId}`;
    const timer = setTimeout(() => {
      state.pending.delete(id);
      reject(new Error(`pi RPC command timed out after ${timeoutMs}ms. stderr tail:\n${state.stderr.slice(-4096)}`));
    }, timeoutMs);

    state.pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });

    try {
      state.process.stdin?.write(serializeJsonLine({ ...command, id }));
    } catch (error) {
      state.pending.delete(id);
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function extractSessionId(response: unknown): string | undefined {
  if (!response || typeof response !== 'object') return undefined;
  const data = (response as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return undefined;
  return typeof (data as { sessionId?: unknown }).sessionId === 'string'
    ? (data as { sessionId: string }).sessionId
    : undefined;
}

export async function draftSpecWithPi(opts: {
  cwd: string;
  prompt: string;
  model?: string | null;
  timeoutMs?: number;
}): Promise<PiDraftSpecResult> {
  const status = detectPi();
  if (!status.piInstalled || !status.piBinPath) {
    throw new Error('Pi CLI not installed or not discoverable');
  }

  const scratchDir = fs.mkdtempSync(path.join(opts.cwd, '.rorca-pi-draft-'));
  const skillFile = writeForgeSkillFile(scratchDir);
  const args = ['--mode', 'rpc', '--no-session', ...(opts.model ? ['--model', opts.model] : []), '--skill', skillFile];
  const timeoutMs = opts.timeoutMs ?? 300_000;
  let sessionId: string | undefined;
  let state: RpcState | null = null;
  let closeModelEgress: (() => Promise<void>) | null = null;

  try {
    const launch = await prepareAutonomousModelSandboxLaunch({
      command: status.piBinPath,
      args,
      cwd: opts.cwd,
      env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    });
    closeModelEgress = launch.closeModelEgress;
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const rpcState: RpcState = {
      process: child,
      requestId: 0,
      pending: new Map(),
      stderr: '',
      lineBuffer: '',
    };
    state = rpcState;
    setupRpcStream(rpcState);
    await sendRpcCommand(rpcState, { type: 'new_session' });
    sessionId = extractSessionId(await sendRpcCommand(rpcState, { type: 'get_state' }));

    let settled = false;
    let text = '';
    let usage: PiDraftUsage = { inputTokens: 0, outputTokens: 0 };

    const streamDone = new Promise<void>((resolve, reject) => {
      const onEventData = (chunk: Buffer | string): void => {
        const raw = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        for (const line of raw.split('\n')) {
          const trimmed = line.replace(/\r$/, '').trim();
          if (!trimmed) continue;

          let event: Record<string, unknown>;
          try {
            event = JSON.parse(trimmed) as Record<string, unknown>;
          } catch {
            continue;
          }

          if (event.type === 'message_update') {
            const assistantMessageEvent = event.assistantMessageEvent as Record<string, unknown> | undefined;
            if (assistantMessageEvent?.type === 'text_delta' && typeof assistantMessageEvent.delta === 'string') {
              text += assistantMessageEvent.delta;
            }
            continue;
          }

          if (event.type === 'turn_end' || event.type === 'agent_end') {
            // Final-message fallback: thinking-heavy models may deliver the
            // complete text only in the final frame (agent_end messages[] /
            // turn_end message), not as text_delta events.
            const frame = event.message ?? event.messages;
            const candidates = Array.isArray(frame) ? frame : (frame != null ? [frame] : []);
            let finalText = '';
            for (const candidate of candidates) {
              if (!candidate || typeof candidate !== 'object' || !('role' in candidate) || candidate.role !== 'assistant') continue;
              if (!('content' in candidate) || !Array.isArray(candidate.content)) continue;
              for (const block of candidate.content) {
                if (block && typeof block === 'object' && 'type' in block && block.type === 'text' && 'text' in block && typeof block.text === 'string') {
                  finalText += block.text;
                }
              }
            }
            if (finalText && finalText.length > text.length) {
              text = finalText;
            }
            if (event.type === 'turn_end') {
              const message = event.message;
              if (message && typeof message === 'object' && 'usage' in message && message.usage && typeof message.usage === 'object') {
                const rawUsage = message.usage;
                const cost = 'cost' in rawUsage && rawUsage.cost && typeof rawUsage.cost === 'object' && 'total' in rawUsage.cost
                  ? Number(rawUsage.cost.total)
                  : undefined;
                usage = {
                  inputTokens: 'input' in rawUsage ? Number(rawUsage.input) : 0,
                  outputTokens: 'output' in rawUsage ? Number(rawUsage.output) : 0,
                  ...(cost != null ? { costUsd: cost } : {}),
                };
              }
            }
            if (!settled) {
              settled = true;
              resolve();
            }
            continue;
          }

          if (event.type === 'error' && !settled) {
            settled = true;
            reject(new Error(typeof event.message === 'string' ? event.message : 'pi forge draft failed'));
          }
        }
      };

      child.stdout?.on('data', onEventData);
      child.once('error', error => {
        if (!settled) {
          settled = true;
          reject(new Error(`Pi forge process failed: ${error.message}`));
        }
      });
      child.once('close', code => {
        if (!settled) {
          settled = true;
          reject(new Error(`Pi forge process closed before draft completion (${String(code)})`));
        }
      });
    });

    // Attach observers to both terminal inputs before awaiting either one. The
    // timeout is a separate terminal signal: it must not reject streamDone
    // while the prompt acknowledgment is being awaited independently, because
    // that leaves a competing unobserved rejection under Node's strict/default
    // unhandled-rejection policy.
    let timer: NodeJS.Timeout;
    const operationTimeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        void sendRpcCommand(rpcState, { type: 'abort' }).catch(() => undefined);
        reject(new Error(`Pi forge draft timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    const promptAcknowledged = sendRpcCommand(
      rpcState,
      { type: 'prompt', message: opts.prompt },
      timeoutMs,
    );
    const promptAndStreamDone = Promise.all([promptAcknowledged, streamDone]);

    try {
      await Promise.race([promptAndStreamDone, operationTimeout]);
    } finally {
      clearTimeout(timer!);
    }

    return { text: text.trim(), usage, sessionId };
  } finally {
    if (state) {
      for (const pending of state.pending.values()) {
        pending.reject(new Error('pi forge draft aborted during shutdown'));
      }
      state.pending.clear();
      try { state.process.kill('SIGTERM'); } catch { /* already exited */ }
      setTimeout(() => {
        try { state?.process.kill('SIGKILL'); } catch { /* already exited */ }
      }, 2000).unref();
    }
    if (closeModelEgress) await closeModelEgress();
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}
