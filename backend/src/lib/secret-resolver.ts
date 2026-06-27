/**
 * Secret profile readiness helpers.
 *
 * This module never exposes secret values. It only answers whether a configured
 * execution host appears to have the references/files/env needed to run agents.
 * Infisical is optional and represented as a provider profile, not a hardcoded
 * dependency.
 */

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
    case 'pi': {
      const envOk = hasAnyEnv(['PI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY'], env);
      const fileOk = hasAnyFile(['~/.pi/agent/settings.json', '~/.config/pi/settings.json', '~/.config/pi-coolify/.env'], home);
      return [
        { name: 'pi.env', ok: envOk, detail: 'PI_API_KEY or provider API key env' },
        { name: 'pi.hostAuthFile', ok: fileOk, detail: '~/.pi/agent/settings.json or pi config' },
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
