/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { detectCodex } from './codex-detector';
import { prepareAutonomousModelSandboxLaunch } from './autonomous-sandbox';

export interface CodexDraftUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

export interface CodexDraftSpecResult {
  text: string;
  usage: CodexDraftUsage;
}

function writeOutputSchemaFile(scratchDir: string): string {
  const filePath = path.join(scratchDir, 'output-schema.json');
  const schema = {
    type: 'object',
    additionalProperties: true,
    required: ['stories'],
    properties: {
      stories: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['title', 'description', 'acceptanceCriteria'],
          additionalProperties: true,
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            description: { type: 'string' },
            acceptanceCriteria: {
              type: 'array',
              minItems: 1,
              items: { type: 'string' },
            },
            dependsOn: {
              oneOf: [
                { type: 'array', items: { type: 'string' } },
                { type: 'string' },
              ],
            },
            complexity: { type: 'number' },
            suggestedSkills: { type: 'array' },
            suggestedPersona: { type: 'string' },
            suggestedReviewers: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      diagrams: { type: 'object' },
      mermaidDiagram: { type: 'string' },
    },
  };
  fs.writeFileSync(filePath, JSON.stringify(schema, null, 2), { encoding: 'utf8', mode: 0o600 });
  return filePath;
}

function readLastMessage(lastMessageFile: string): string {
  const text = fs.readFileSync(lastMessageFile, 'utf8').trim();
  if (!text) {
    throw new Error('Codex completed without returning a final message');
  }
  return text;
}

function extractUsage(stdout: string): CodexDraftUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd: number | undefined;

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      const usage = (event.usage ?? event.token_usage ?? event.metrics) as Record<string, unknown> | undefined;
      if (usage) {
        inputTokens = Number(usage.input_tokens ?? usage.input ?? inputTokens ?? 0) || inputTokens;
        outputTokens = Number(usage.output_tokens ?? usage.output ?? outputTokens ?? 0) || outputTokens;
        const rawCost = usage.cost_usd ?? usage.cost;
        if (rawCost != null && Number.isFinite(Number(rawCost))) {
          costUsd = Number(rawCost);
        }
      }
    } catch {
      // Ignore non-JSON lines.
    }
  }

  return {
    inputTokens,
    outputTokens,
    ...(costUsd != null ? { costUsd } : {}),
  };
}

export async function draftSpecWithCodex(opts: {
  cwd: string;
  prompt: string;
  model?: string | null;
  timeoutMs?: number;
}): Promise<CodexDraftSpecResult> {
  const status = detectCodex();
  if (!status.codexInstalled || !status.codexBinPath) {
    throw new Error('Codex CLI not installed or not discoverable');
  }

  const scratchDir = fs.mkdtempSync(path.join(opts.cwd, '.rorca-codex-draft-'));
  const outputSchemaFile = writeOutputSchemaFile(scratchDir);
  const lastMessageFile = path.join(scratchDir, 'last-message.txt');
  const args = [
    'exec',
    '--json',
    '--ephemeral',
    '--skip-git-repo-check',
    '--output-last-message', lastMessageFile,
    '--output-schema', outputSchemaFile,
    '--cd', opts.cwd,
    ...(opts.model ? ['--model', opts.model] : []),
  ];

  const timeoutMs = opts.timeoutMs ?? 300_000;
  let closeModelEgress: (() => Promise<void>) | null = null;

  try {
    const launch = await prepareAutonomousModelSandboxLaunch({
      command: status.codexBinPath,
      args,
      cwd: opts.cwd,
      env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    });
    closeModelEgress = launch.closeModelEgress;
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(launch.command, launch.args, {
        cwd: launch.cwd,
        env: launch.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let finished = false;
      let forceKillTimer: NodeJS.Timeout | null = null;

      const timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        try {
          child.kill('SIGTERM');
          forceKillTimer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { /* already exited */ }
          }, 5_000);
          forceKillTimer.unref();
        } catch { /* already exited */ }
        reject(new Error(`Codex spec drafting timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      });

      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      });

      child.on('error', (error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        reject(error);
      });

      child.on('close', (code) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        resolve({ code, stdout, stderr });
      });

      child.stdin?.write(opts.prompt);
      child.stdin?.end();
    });

    if (result.code !== 0) {
      const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n').slice(-4000);
      throw new Error(detail || `Codex spec drafting failed with exit code ${String(result.code)}`);
    }

    return {
      text: readLastMessage(lastMessageFile),
      usage: extractUsage(result.stdout),
    };
  } finally {
    if (closeModelEgress) await closeModelEgress();
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}
