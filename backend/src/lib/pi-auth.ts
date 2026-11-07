/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

export interface PiApiKeyProviderMeta {
  id: string;
  name: string;
  envVar: string;
}

export interface PiApiKeyProviderStatus extends PiApiKeyProviderMeta {
  configured: boolean;
  source: 'auth-file' | 'env' | null;
  maskedKey: string | null;
}

interface PiAuthApiKeyEntry {
  type: 'api_key';
  key: string;
}

const PI_API_KEY_PROVIDERS: PiApiKeyProviderMeta[] = [
  { id: 'deepseek', name: 'DeepSeek', envVar: 'DEEPSEEK_API_KEY' },
  { id: 'anthropic', name: 'Anthropic', envVar: 'ANTHROPIC_API_KEY' },
  { id: 'openai', name: 'OpenAI', envVar: 'OPENAI_API_KEY' },
  { id: 'google', name: 'Google Gemini', envVar: 'GEMINI_API_KEY' },
  { id: 'openrouter', name: 'OpenRouter', envVar: 'OPENROUTER_API_KEY' },
  { id: 'groq', name: 'Groq', envVar: 'GROQ_API_KEY' },
  { id: 'mistral', name: 'Mistral', envVar: 'MISTRAL_API_KEY' },
  { id: 'cerebras', name: 'Cerebras', envVar: 'CEREBRAS_API_KEY' },
  { id: 'xai', name: 'xAI', envVar: 'XAI_API_KEY' },
  { id: 'fireworks', name: 'Fireworks', envVar: 'FIREWORKS_API_KEY' },
  { id: 'kimi-coding', name: 'Kimi For Coding', envVar: 'KIMI_API_KEY' },
  { id: 'minimax', name: 'MiniMax', envVar: 'MINIMAX_API_KEY' },
  { id: 'opencode', name: 'OpenCode Zen', envVar: 'OPENCODE_API_KEY' },
  { id: 'opencode-go', name: 'OpenCode Go', envVar: 'OPENCODE_API_KEY' },
] as const;

function getPiConfigDir(): string {
  return process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), '.pi', 'agent');
}

export function getPiAuthFilePath(): string {
  return path.join(getPiConfigDir(), 'auth.json');
}

export function getPiApiKeyProviders(): PiApiKeyProviderMeta[] {
  return [...PI_API_KEY_PROVIDERS];
}

export function isSupportedPiApiKeyProvider(provider: string): boolean {
  return PI_API_KEY_PROVIDERS.some((entry) => entry.id === provider);
}

function maskKey(value: string): string {
  if (!value) return '****';
  if (value.startsWith('!')) return '!command';
  if (/^[A-Z0-9_]+$/.test(value)) return `env:${value}`;
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function readJsonFileSafe(filePath: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function writeJsonFileAtomic(filePath: string, data: Record<string, unknown>): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // best effort
  }

  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, encoding: 'utf8' });
  fs.renameSync(tempPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best effort
  }
}

function isApiKeyEntry(value: unknown): value is PiAuthApiKeyEntry {
  return !!value
    && typeof value === 'object'
    && (value as { type?: unknown }).type === 'api_key'
    && typeof (value as { key?: unknown }).key === 'string';
}

export function listPiApiKeyProviderStatuses(): PiApiKeyProviderStatus[] {
  const auth = readJsonFileSafe(getPiAuthFilePath());
  return PI_API_KEY_PROVIDERS.map((provider) => {
    const entry = auth[provider.id];
    const envValue = process.env[provider.envVar]?.trim() || null;

    if (isApiKeyEntry(entry) && entry.key.trim()) {
      return {
        ...provider,
        configured: true,
        source: 'auth-file' as const,
        maskedKey: maskKey(entry.key.trim()),
      };
    }

    if (envValue) {
      return {
        ...provider,
        configured: true,
        source: 'env' as const,
        maskedKey: maskKey(envValue),
      };
    }

    return {
      ...provider,
      configured: false,
      source: null,
      maskedKey: null,
    };
  });
}

export function upsertPiApiKeyProvider(provider: string, apiKey: string): PiApiKeyProviderStatus {
  const trimmedProvider = provider.trim();
  const trimmedKey = apiKey.trim();
  if (!isSupportedPiApiKeyProvider(trimmedProvider)) {
    throw new Error(`Unsupported Pi provider: ${trimmedProvider}`);
  }
  if (!trimmedKey) {
    throw new Error('API key is required');
  }

  const filePath = getPiAuthFilePath();
  const auth = readJsonFileSafe(filePath);
  auth[trimmedProvider] = { type: 'api_key', key: trimmedKey } satisfies PiAuthApiKeyEntry;
  writeJsonFileAtomic(filePath, auth);

  return listPiApiKeyProviderStatuses().find((entry) => entry.id === trimmedProvider)!;
}

export function removePiApiKeyProvider(provider: string): PiApiKeyProviderStatus {
  const trimmedProvider = provider.trim();
  if (!isSupportedPiApiKeyProvider(trimmedProvider)) {
    throw new Error(`Unsupported Pi provider: ${trimmedProvider}`);
  }

  const filePath = getPiAuthFilePath();
  const auth = readJsonFileSafe(filePath);
  delete auth[trimmedProvider];
  writeJsonFileAtomic(filePath, auth);

  return listPiApiKeyProviderStatuses().find((entry) => entry.id === trimmedProvider)!;
}
