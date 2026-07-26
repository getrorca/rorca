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
  const launch = await prepareAutonomousModelSandboxLaunch({
    command: status.piBinPath,
    args,
    cwd: opts.cwd,
    env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
  });
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const state: RpcState = {
    process: child,
    requestId: 0,
    pending: new Map(),
    stderr: '',
    lineBuffer: '',
  };
  setupRpcStream(state);

  const timeoutMs = opts.timeoutMs ?? 300_000;
  let sessionId: string | undefined;

  try {
    await sendRpcCommand(state, { type: 'new_session' });
    sessionId = extractSessionId(await sendRpcCommand(state, { type: 'get_state' }));

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

          if (event.type === 'turn_end') {
            const message = event.message as Record<string, unknown> | undefined;
            const rawUsage = message?.usage as Record<string, unknown> | undefined;
            const costInfo = rawUsage?.cost as Record<string, unknown> | undefined;
            usage = {
              inputTokens: Number(rawUsage?.input ?? 0),
              outputTokens: Number(rawUsage?.output ?? 0),
              ...(costInfo?.total != null ? { costUsd: Number(costInfo.total) } : {}),
            };
            if (!settled) {
              settled = true;
              resolve();
            }
            continue;
          }

          if (event.type === 'agent_end' && !settled) {
            settled = true;
            resolve();
            continue;
          }

          if (event.type === 'error' && !settled) {
            settled = true;
            reject(new Error(typeof event.message === 'string' ? event.message : 'pi forge draft failed'));
          }
        }
      };

      child.stdout?.on('data', onEventData);
    });

    const timer = setTimeout(() => {
      void sendRpcCommand(state, { type: 'abort' }).catch(() => undefined);
    }, timeoutMs);

    try {
      await sendRpcCommand(state, { type: 'prompt', message: opts.prompt });
      await streamDone;
    } finally {
      clearTimeout(timer);
    }

    return { text: text.trim(), usage, sessionId };
  } finally {
    for (const pending of state.pending.values()) {
      pending.reject(new Error('pi forge draft aborted during shutdown'));
    }
    state.pending.clear();
    try { child.kill('SIGTERM'); } catch { /* already exited */ }
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
    }, 2000).unref();
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}
