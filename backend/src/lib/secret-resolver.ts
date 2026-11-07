/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Secret profile readiness helpers.
 *
 * This module never exposes secret values. It only answers whether a configured
 * execution host appears to have the references/files/env needed to run agents.
 * Infisical is optional and represented as a provider profile, not a hardcoded
 * dependency.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';

export const SecretProviderSchema = z.enum(['env', 'mounted-file', 'host-local', 'infisical']);
export type SecretProvider = z.infer<typeof SecretProviderSchema>;

export interface SecretProfile {
  id: string;
  label: string;
  provider: SecretProvider;
  config: Record<string, unknown>;
}


export interface SecretResolveOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  execFile?: typeof execFileSync;
}

export interface SecretResolutionResult {
  provider: SecretProvider;
  env: Record<string, string>;
  warnings: string[];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function parseDotenv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = value;
  }
  return out;
}

function parseInfisicalExport(content: string): Record<string, string> {
  const trimmed = content.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const item of parsed) {
        if (!item || typeof item !== 'object') continue;
        const key = String((item as any).secretKey ?? (item as any).key ?? '');
        const value = (item as any).secretValue ?? (item as any).value;
        if (key && value != null) out[key] = String(value);
      }
      return out;
    }
    if (parsed && typeof parsed === 'object') {
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string') out[key] = value;
        else if (value && typeof value === 'object' && 'secretValue' in value) out[key] = String((value as any).secretValue);
      }
      return out;
    }
  } catch {
    return parseDotenv(trimmed);
  }
  return {};
}

export interface SecretProfileReadiness {
  provider: SecretProvider;
  ready: boolean;
  reason?: string;
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
}

function expandHome(filePath: string, home = os.homedir()): string {
  if (filePath === '~') return home;
  if (filePath.startsWith('~/')) return path.join(home, filePath.slice(2));
  return filePath;
}

function envPresent(name: string, env: NodeJS.ProcessEnv): boolean {
  return Boolean(env[name]?.trim());
}

function filePresent(filePath: string, home?: string): boolean {
  try {
    return fs.existsSync(expandHome(filePath, home));
  } catch {
    return false;
  }
}

export function hasAnyEnv(names: string[], env: NodeJS.ProcessEnv = process.env): boolean {
  return names.some((name) => envPresent(name, env));
}

export function hasAnyFile(paths: string[], home = os.homedir()): boolean {
  return paths.some((candidate) => filePresent(candidate, home));
}

export function getAgentCredentialChecks(agent: string, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): Array<{ name: string; ok: boolean; detail?: string }> {
  switch (agent) {
    case 'claude': {
      const envOk = hasAnyEnv(['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'], env);
      const fileOk = hasAnyFile(['~/.claude.json', '~/.claude/.credentials.json', '~/.claude/settings.json'], home);
      return [
        { name: 'claude.env', ok: envOk, detail: 'ANTHROPIC_API_KEY or CLAUDE_API_KEY' },
        { name: 'claude.hostAuthFile', ok: fileOk, detail: '~/.claude.json or ~/.claude/* credentials' },
      ];
    }
    case 'codex': {
      const envOk = hasAnyEnv(['OPENAI_API_KEY'], env);
      const fileOk = hasAnyFile(['~/.codex/auth.json'], home);
      return [
        { name: 'codex.env', ok: envOk, detail: 'OPENAI_API_KEY' },
        { name: 'codex.hostAuthFile', ok: fileOk, detail: '~/.codex/auth.json' },
      ];
    }
    case 'opencode': {
      const envOk = hasAnyEnv(['OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY'], env);
      const fileOk = hasAnyFile(['~/.config/opencode/auth.json', '~/.local/share/opencode/auth.json'], home);
      return [
        { name: 'opencode.env', ok: envOk, detail: 'provider API key env' },
        { name: 'opencode.hostAuthFile', ok: fileOk, detail: '~/.config/opencode/auth.json' },
      ];
    }
    case 'pi':
    case 'omp': {
      const envOk = hasAnyEnv(['PI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY'], env);
      const fileOk = hasAnyFile(['~/.pi/agent/settings.json', '~/.config/pi/settings.json', '~/.config/pi-coolify/.env'], home);
      return [
        { name: `${agent}.env`, ok: envOk, detail: 'PI_API_KEY or provider API key env' },
        { name: `${agent}.hostAuthFile`, ok: fileOk, detail: '~/.pi/agent/settings.json or pi config' },
      ];
    }
    default:
      return [{ name: `${agent}.unsupported`, ok: false, detail: 'unknown agent' }];
  }
}

export function hasAgentCredentials(agent: string, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): boolean {
  return getAgentCredentialChecks(agent, env, home).some((check) => check.ok);
}

export function evaluateSecretProfileReadiness(profile: SecretProfile, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): SecretProfileReadiness {
  if (profile.provider === 'env') {
    const vars = Array.isArray(profile.config.env) ? profile.config.env.map(String) : [];
    const checks = vars.map((name) => ({ name, ok: envPresent(name, env), detail: 'environment variable' }));
    return { provider: profile.provider, ready: vars.length === 0 || checks.some((c) => c.ok), checks };
  }

  if (profile.provider === 'mounted-file') {
    const files = Array.isArray(profile.config.files) ? profile.config.files.map(String) : [];
    const checks = files.map((name) => ({ name, ok: filePresent(name, home), detail: 'mounted file' }));
    return { provider: profile.provider, ready: files.length > 0 && checks.every((c) => c.ok), checks };
  }

  if (profile.provider === 'host-local') {
    return { provider: profile.provider, ready: true, checks: [{ name: 'host-local', ok: true, detail: 'credentials are evaluated on the runner host' }] };
  }

  const checks = [
    { name: 'INFISICAL_CLIENT_ID', ok: envPresent('INFISICAL_CLIENT_ID', env), detail: 'Infisical machine identity/client id' },
    { name: 'INFISICAL_CLIENT_SECRET', ok: envPresent('INFISICAL_CLIENT_SECRET', env), detail: 'Infisical machine identity/client secret' },
    { name: 'INFISICAL_PROJECT_ID', ok: envPresent('INFISICAL_PROJECT_ID', env), detail: 'Infisical project id' },
  ];
  return {
    provider: profile.provider,
    ready: checks.every((c) => c.ok),
    reason: checks.every((c) => c.ok) ? undefined : 'infisical_credentials_missing',
    checks,
  };
}

export function resolveSecretProfileEnvironment(profile: SecretProfile, options: SecretResolveOptions = {}): SecretResolutionResult {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const execFile = options.execFile ?? execFileSync;
  const resolved: Record<string, string> = {};
  const warnings: string[] = [];

  if (profile.provider === 'env') {
    for (const name of stringArray(profile.config.env)) {
      const value = env[name];
      if (value && value.trim()) resolved[name] = value;
      else warnings.push(`env_missing:${name}`);
    }
    return { provider: profile.provider, env: resolved, warnings };
  }

  if (profile.provider === 'mounted-file') {
    const dotenvFiles = stringArray(profile.config.dotenvFiles);
    for (const file of dotenvFiles) {
      const expanded = expandHome(file, home);
      try {
        Object.assign(resolved, parseDotenv(fs.readFileSync(expanded, 'utf8')));
      } catch {
        warnings.push(`dotenv_file_unreadable:${file}`);
      }
    }

    const files = Array.isArray(profile.config.files) ? profile.config.files : [];
    for (const entry of files) {
      if (typeof entry === 'string') {
        const name = path.basename(entry).replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
        try { resolved[name] = fs.readFileSync(expandHome(entry, home), 'utf8').trim(); }
        catch { warnings.push(`file_unreadable:${entry}`); }
        continue;
      }
      if (!entry || typeof entry !== 'object') continue;
      const envName = String((entry as any).env ?? '');
      const filePath = String((entry as any).path ?? '');
      if (!envName || !filePath) continue;
      try { resolved[envName] = fs.readFileSync(expandHome(filePath, home), 'utf8').trim(); }
      catch { warnings.push(`file_unreadable:${filePath}`); }
    }
    return { provider: profile.provider, env: resolved, warnings };
  }

  if (profile.provider === 'host-local') {
    return { provider: profile.provider, env: {}, warnings };
  }

  const args = ['export', '--format=json'];
  const projectId = String(profile.config.projectId ?? env.INFISICAL_PROJECT_ID ?? '');
  const environment = String(profile.config.environment ?? profile.config.envSlug ?? env.INFISICAL_ENVIRONMENT ?? env.INFISICAL_ENV ?? '');
  const secretPath = String(profile.config.path ?? profile.config.secretPath ?? '/');
  if (projectId) args.push('--projectId', projectId);
  if (environment) args.push('--env', environment);
  if (secretPath) args.push('--path', secretPath);
  if (profile.config.recursive === true) args.push('--recursive');

  try {
    const output = execFile('infisical', args, { encoding: 'utf8', env: env as NodeJS.ProcessEnv, timeout: 15000 }) as unknown as string;
    Object.assign(resolved, parseInfisicalExport(output));
  } catch (err) {
    warnings.push(`infisical_export_failed:${err instanceof Error ? err.message : String(err)}`);
  }
  return { provider: profile.provider, env: resolved, warnings };
}
