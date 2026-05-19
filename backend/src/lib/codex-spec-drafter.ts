/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectCodex } from './codex-detector';

export interface CodexDraftUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

export interface CodexDraftSpecResult {
  text: string;
  usage: CodexDraftUsage;
}

function writeOutputSchemaFile(): string {
  const filePath = path.join(os.tmpdir(), `rorca-codex-spec-schema-${Date.now()}-${process.pid}.json`);
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

  const outputSchemaFile = writeOutputSchemaFile();
  const lastMessageFile = path.join(os.tmpdir(), `rorca-codex-last-message-${Date.now()}-${process.pid}.txt`);
  const args = [
    'exec',
    '--json',
    '--ephemeral',
    '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox',
    '--output-last-message', lastMessageFile,
    '--output-schema', outputSchemaFile,
    '--cd', opts.cwd,
    ...(opts.model ? ['--model', opts.model] : []),
  ];

  const timeoutMs = opts.timeoutMs ?? 300_000;

  try {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(status.codexBinPath!, args, {
        cwd: opts.cwd,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let finished = false;

      const timer = setTimeout(() => {
        try {
          child.kill('SIGTERM');
          setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { /* already exited */ }
          }, 5_000).unref();
        } catch { /* already exited */ }
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
        reject(error);
      });

      child.on('close', (code) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
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
    try { fs.unlinkSync(outputSchemaFile); } catch { /* best effort */ }
    try { fs.unlinkSync(lastMessageFile); } catch { /* best effort */ }
  }
}
