/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const GUARD_DIR_PREFIX = 'rorca-autonomous-guard-';
const AUTONOMOUS_SECRET_ENV_KEYS = new Set([
  'DATABASE_URL', 'DATABASE_URL_TEST', 'TEST_DATABASE_URL',
  'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE',
  'JWT_SECRET', 'VAULT_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET',
  'GITHUB_TOKEN', 'GH_TOKEN', 'GIT_ASKPASS', 'SSH_ASKPASS', 'SSH_AUTH_SOCK',
  'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_SSH', 'GIT_SSH_COMMAND',
  'RORCA_MCP_TOKEN', 'RORCA_MCP_ADMIN_TOKEN',
  'RORCA_OPERATOR_CAPABILITY', 'RORCA_OPERATOR_CAPABILITY_SHA256',
]);

export interface AutonomousCommandGuardOptions {
  cwd: string;
  env: Record<string, string>;
  profile?: 'general' | 'conflict-resolution';
  commandDenylist?: string[];
}

export interface AutonomousCommandGuardResult {
  env: Record<string, string>;
  guardBinDir: string;
}

export interface AutonomousBackendJestEnv {
  databaseUrl: string;
  pgHost: string;
  pgPort: string;
  pgUser: string;
  pgPassword: string;
  pgDatabase: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function parseUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    return new URL(value.trim());
  } catch {
    return null;
  }
}

function getDatabaseName(url: URL): string {
  return url.pathname.replace(/^\//, '');
}

function buildAutonomousBackendJestEnv(url: URL): AutonomousBackendJestEnv | null {
  const pgDatabase = getDatabaseName(url);
  if (!pgDatabase.endsWith('_test')) return null;

  return {
    databaseUrl: url.toString(),
    pgHost: url.hostname,
    pgPort: url.port || '5432',
    pgUser: decodeURIComponent(url.username || 'rorca'),
    pgPassword: decodeURIComponent(url.password || 'rorca'),
    pgDatabase,
  };
}

export function deriveAutonomousBackendJestEnv(env: Record<string, string | undefined>): AutonomousBackendJestEnv | null {
  // Never transform production credentials into test credentials. Autonomous
  // runners require an explicit dedicated target, matching the Jest contract.
  const explicitTestUrl = parseUrl(env.RORCA_TEST_DATABASE_URL || env.DATABASE_URL_TEST);
  return explicitTestUrl ? buildAutonomousBackendJestEnv(explicitTestUrl) : null;
}

function resolveRealCommand(command: string, searchPath: string | undefined): string | null {
  const pathParts = (searchPath ?? '').split(path.delimiter).filter(Boolean);
  for (const part of pathParts) {
    if (part.includes(GUARD_DIR_PREFIX)) continue;
    const candidate = path.join(part, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // continue
    }
  }
  return null;
}

function writeExecutable(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o755 });
}

function buildWrapper(
  command: string,
  realCommand: string | null,
  profile: 'general' | 'conflict-resolution',
  commandDenylist: string[],
): string {
  return `#!/usr/bin/env bash
set -euo pipefail

cmd_name=${shellQuote(command)}
real_command=${shellQuote(realCommand ?? '')}
workspace_root="\${RORCA_AUTONOMOUS_WORKSPACE_ROOT:-}"
allow_backend_jest="\${RORCA_ALLOW_BACKEND_JEST:-}"
database_url="\${DATABASE_URL:-}"
autonomous_jest_db_url="\${RORCA_AUTONOMOUS_BACKEND_JEST_DATABASE_URL:-}"
pwd_now="$(pwd -P)"
args_joined=" $* "
profile=${shellQuote(profile)}
${commandDenylist.length > 0 ? `manifest_denylist=(${commandDenylist.map(shellQuote).join(' ')})
full_command="$cmd_name $*"
full_command_lower="${'${full_command,,}'}"
for denied in "${'${manifest_denylist[@]}'}"; do
  denied_lower="${'${denied,,}'}"
  if [[ -n "$denied_lower" && "$full_command_lower" == *"$denied_lower"* ]]; then
    echo "[Rorca autonomous command guard] Command blocked by host-frozen TaskManifest command denylist." >&2
    exit 126
  fi
done
` : ''}
case "$cmd_name" in
  npm|npx|yarn|pnpm)
    if [[ "$args_joined" =~ (^|[[:space:]])(gh|git|ssh|scp|sftp|rsync|curl|wget)([[:space:]]|$) ]]; then
      echo "[Rorca autonomous command guard] Package-runner remote command bypass is blocked." >&2
      exit 126
    fi
    ;;
  gh|ssh|scp|sftp|rsync)
    echo "[Rorca autonomous command guard] Remote mutation command is host-owned and blocked." >&2
    exit 126
    ;;
  mkfs|sudo)
    echo "[Rorca autonomous command guard] Privileged/destructive host command is blocked." >&2
    exit 126
    ;;
  dd)
    if [[ "$args_joined" =~ [[:space:]]if= ]]; then
      echo "[Rorca autonomous command guard] Raw device/data copy command is blocked." >&2
      exit 126
    fi
    ;;
  docker)
    if [[ "$args_joined" =~ [[:space:]]login([[:space:]]|$) ]]; then
      echo "[Rorca autonomous command guard] Docker credential mutation is blocked." >&2
      exit 126
    fi
    ;;
  kubectl)
    if [[ "$args_joined" =~ [[:space:]](apply|delete)([[:space:]]|$) ]]; then
      echo "[Rorca autonomous command guard] Cluster mutation is blocked." >&2
      exit 126
    fi
    ;;
  terraform)
    if [[ "$args_joined" =~ [[:space:]]apply([[:space:]]|$) ]]; then
      echo "[Rorca autonomous command guard] Infrastructure apply is blocked." >&2
      exit 126
    fi
    ;;
  rm)
    if [[ "$args_joined" =~ [[:space:]](-[^[:space:]]*r[^[:space:]]*f|-rf|-fr)([[:space:]]+--no-preserve-root)?[[:space:]]+/([[:space:]]|$) ]]; then
      echo "[Rorca autonomous command guard] Filesystem-root deletion is blocked." >&2
      exit 126
    fi
    ;;
  curl|wget)
    # Autonomous shells do not receive general network mutation authority.
    # Read-only HTTP is also denied because method inference, redirects, upload
    # flags, and credential-helper state make a shell-level allowlist unsafe.
    echo "[Rorca autonomous command guard] Network command is blocked; use a host-owned capability." >&2
    exit 126
    ;;
  git)
    case "\${1:-}" in
      push|fetch|pull|remote|send-pack|receive-pack|ls-remote|submodule)
        echo "[Rorca autonomous command guard] Remote git operation is host-owned and blocked." >&2
        exit 126
        ;;
      commit|merge|rebase|checkout|switch|reset|clean|worktree|tag)
        if [[ "$profile" == "conflict-resolution" ]]; then
          echo "[Rorca autonomous command guard] Host-owned git operation blocked during conflict resolution." >&2
          exit 126
        fi
        ;;
    esac
    ;;
esac

is_backend_dir=0
if [[ -n "$workspace_root" ]]; then
  case "$pwd_now" in
    "$workspace_root/backend"|"$workspace_root/backend/"*) is_backend_dir=1 ;;
  esac
fi

is_jest_like=0
case "$cmd_name" in
  jest) is_jest_like=1 ;;
  npx)
    if [[ "$args_joined" =~ [[:space:]]jest([[:space:]]|$) ]] || [[ "$args_joined" =~ [[:space:]]--testPathPattern ]]; then
      is_jest_like=1
    fi
    ;;
  npm|yarn|pnpm)
    if [[ "$args_joined" =~ [[:space:]]test([[:space:]]|$) ]] && [[ $is_backend_dir -eq 1 ]]; then
      is_jest_like=1
    fi
    if [[ "$args_joined" =~ [[:space:]]jest([[:space:]]|$) ]] || [[ "$args_joined" =~ [[:space:]]--testPathPattern ]]; then
      is_jest_like=1
    fi
    ;;
esac

if [[ $is_jest_like -eq 1 ]]; then
  if [[ $is_backend_dir -eq 1 && "$autonomous_jest_db_url" =~ _test($|[?&/]) ]]; then
    export RORCA_TEST_DATABASE_URL="$autonomous_jest_db_url"
    export DATABASE_URL="$autonomous_jest_db_url"
    export DATABASE_URL_TEST="$autonomous_jest_db_url"
    export NODE_ENV=test
    if [[ -n "\${RORCA_AUTONOMOUS_BACKEND_JEST_PGHOST:-}" ]]; then export PGHOST="$RORCA_AUTONOMOUS_BACKEND_JEST_PGHOST"; fi
    if [[ -n "\${RORCA_AUTONOMOUS_BACKEND_JEST_PGPORT:-}" ]]; then export PGPORT="$RORCA_AUTONOMOUS_BACKEND_JEST_PGPORT"; fi
    if [[ -n "\${RORCA_AUTONOMOUS_BACKEND_JEST_PGUSER:-}" ]]; then export PGUSER="$RORCA_AUTONOMOUS_BACKEND_JEST_PGUSER"; fi
    if [[ -n "\${RORCA_AUTONOMOUS_BACKEND_JEST_PGPASSWORD:-}" ]]; then export PGPASSWORD="$RORCA_AUTONOMOUS_BACKEND_JEST_PGPASSWORD"; fi
    if [[ -n "\${RORCA_AUTONOMOUS_BACKEND_JEST_PGDATABASE:-}" ]]; then export PGDATABASE="$RORCA_AUTONOMOUS_BACKEND_JEST_PGDATABASE"; fi
    if [[ -z "$real_command" ]]; then echo "[Rorca autonomous command guard] Allowed test command is unavailable outside the guard PATH." >&2; exit 127; fi
    exec "$real_command" "$@"
  fi

  if [[ "$allow_backend_jest" == "true" && "$database_url" =~ _test($|[?&/]) ]]; then
    if [[ -z "$real_command" ]]; then echo "[Rorca autonomous command guard] Allowed test command is unavailable outside the guard PATH." >&2; exit 127; fi
    exec "$real_command" "$@"
  fi
  cat >&2 <<'RORCA_GUARD_MESSAGE'
[Rorca autonomous command guard] Blocked backend/Jest-style test command.
Autonomous agents must not run backend Jest or live-DB destructive tests unless the command guard can route the command to a database ending in _test, or it is explicitly allowed with RORCA_ALLOW_BACKEND_JEST=true and DATABASE_URL points to a database ending in _test.
Use safe validation instead, such as:
  - npx tsc --noEmit
  - cd backend && npx tsc --noEmit
  - npx vitest run <frontend test file>
  - narrowly scoped non-DB checks proven safe
RORCA_GUARD_MESSAGE
  exit 126
fi

if [[ -z "$real_command" ]]; then echo "[Rorca autonomous command guard] Command is unavailable outside the guard PATH." >&2; exit 127; fi
exec "$real_command" "$@"
`;
}

export function sanitizeAutonomousAgentEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !AUTONOMOUS_SECRET_ENV_KEYS.has(key)),
  );
}

export function createAutonomousCommandGuard(options: AutonomousCommandGuardOptions): AutonomousCommandGuardResult {
  const guardBinDir = fs.mkdtempSync(path.join(os.tmpdir(), GUARD_DIR_PREFIX));
  const profile = options.profile ?? 'general';
  const commandDenylist = [...new Set((options.commandDenylist ?? [])
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean))];
  // Both profiles deny ambient provider/network authority. Conflict resolution
  // additionally denies host-owned local history mutation.
  const commands = [...new Set([
    'npm', 'npx', 'jest', 'yarn', 'pnpm',
    'git', 'gh', 'curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync',
    'rm', 'mkfs', 'dd', 'sudo', 'docker', 'kubectl', 'terraform',
    ...commandDenylist
      .map((pattern) => pattern.split(/\s+/)[0] ?? '')
      .filter((command) => /^[A-Za-z0-9._+-]+$/.test(command)),
  ])];

  for (const command of commands) {
    writeExecutable(
      path.join(guardBinDir, command),
      buildWrapper(command, resolveRealCommand(command, options.env.PATH), profile, commandDenylist),
    );
  }

  const autonomousBackendJestEnv = deriveAutonomousBackendJestEnv(options.env);
  const sanitizedEnv = sanitizeAutonomousAgentEnv(options.env);

  return {
    guardBinDir,
    env: {
      ...sanitizedEnv,
      PATH: `${guardBinDir}${path.delimiter}${sanitizedEnv.PATH ?? process.env.PATH ?? ''}`,
      RORCA_AUTONOMOUS_COMMAND_GUARD: '1',
      RORCA_AUTONOMOUS_WORKSPACE_ROOT: fs.realpathSync(options.cwd),
      // Prevent git from consulting user/system helpers even for commands not
      // covered by a future wrapper version. Host release code supplies its own
      // isolated config and one-shot askpass environment.
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: path.join(guardBinDir, 'ssh'),
      GIT_SSH_COMMAND: path.join(guardBinDir, 'ssh'),
      GCM_INTERACTIVE: 'Never',
      GH_CONFIG_DIR: guardBinDir,
      ...(autonomousBackendJestEnv
        ? {
          // The only database credential exposed to an autonomous CLI is a
          // guard-validated database whose name ends in _test.
          DATABASE_URL: autonomousBackendJestEnv.databaseUrl,
          DATABASE_URL_TEST: autonomousBackendJestEnv.databaseUrl,
          RORCA_AUTONOMOUS_BACKEND_JEST_DATABASE_URL: autonomousBackendJestEnv.databaseUrl,
          RORCA_AUTONOMOUS_BACKEND_JEST_PGHOST: autonomousBackendJestEnv.pgHost,
          RORCA_AUTONOMOUS_BACKEND_JEST_PGPORT: autonomousBackendJestEnv.pgPort,
          RORCA_AUTONOMOUS_BACKEND_JEST_PGUSER: autonomousBackendJestEnv.pgUser,
          RORCA_AUTONOMOUS_BACKEND_JEST_PGPASSWORD: autonomousBackendJestEnv.pgPassword,
          RORCA_AUTONOMOUS_BACKEND_JEST_PGDATABASE: autonomousBackendJestEnv.pgDatabase,
        }
        : {}),
    },
  };
}
