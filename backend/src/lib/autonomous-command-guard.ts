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
const LOCAL_DB_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export interface AutonomousCommandGuardOptions {
  cwd: string;
  env: Record<string, string>;
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
  const explicitTestUrl = parseUrl(env.DATABASE_URL_TEST);
  const explicitTestEnv = explicitTestUrl ? buildAutonomousBackendJestEnv(explicitTestUrl) : null;
  if (explicitTestEnv) return explicitTestEnv;

  const databaseUrl = parseUrl(env.DATABASE_URL);
  if (!databaseUrl) return null;
  if (!LOCAL_DB_HOSTS.has(databaseUrl.hostname.toLowerCase())) return null;

  const pgDatabase = getDatabaseName(databaseUrl);
  if (!pgDatabase) return null;
  if (!pgDatabase.endsWith('_test')) {
    databaseUrl.pathname = `/${pgDatabase}_test`;
  }

  return buildAutonomousBackendJestEnv(databaseUrl);
}

function resolveRealCommand(command: string): string | null {
  const pathParts = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
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

function buildWrapper(command: string, realCommand: string | null): string {
  const execTarget = realCommand ? shellQuote(realCommand) : command;
  return `#!/usr/bin/env bash
set -euo pipefail

cmd_name=${shellQuote(command)}
workspace_root="\${RORCA_AUTONOMOUS_WORKSPACE_ROOT:-}"
allow_backend_jest="\${RORCA_ALLOW_BACKEND_JEST:-}"
database_url="\${DATABASE_URL:-}"
autonomous_jest_db_url="\${RORCA_AUTONOMOUS_BACKEND_JEST_DATABASE_URL:-}"
pwd_now="$(pwd -P)"
args_joined=" $* "

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
    export DATABASE_URL="$autonomous_jest_db_url"
    export DATABASE_URL_TEST="$autonomous_jest_db_url"
    export NODE_ENV=test
    if [[ -n "\${RORCA_AUTONOMOUS_BACKEND_JEST_PGHOST:-}" ]]; then export PGHOST="$RORCA_AUTONOMOUS_BACKEND_JEST_PGHOST"; fi
    if [[ -n "\${RORCA_AUTONOMOUS_BACKEND_JEST_PGPORT:-}" ]]; then export PGPORT="$RORCA_AUTONOMOUS_BACKEND_JEST_PGPORT"; fi
    if [[ -n "\${RORCA_AUTONOMOUS_BACKEND_JEST_PGUSER:-}" ]]; then export PGUSER="$RORCA_AUTONOMOUS_BACKEND_JEST_PGUSER"; fi
    if [[ -n "\${RORCA_AUTONOMOUS_BACKEND_JEST_PGPASSWORD:-}" ]]; then export PGPASSWORD="$RORCA_AUTONOMOUS_BACKEND_JEST_PGPASSWORD"; fi
    if [[ -n "\${RORCA_AUTONOMOUS_BACKEND_JEST_PGDATABASE:-}" ]]; then export PGDATABASE="$RORCA_AUTONOMOUS_BACKEND_JEST_PGDATABASE"; fi
    exec ${execTarget} "$@"
  fi

  if [[ "$allow_backend_jest" == "true" && "$database_url" =~ _test($|[?&/]) ]]; then
    exec ${execTarget} "$@"
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

exec ${execTarget} "$@"
`;
}

export function createAutonomousCommandGuard(options: AutonomousCommandGuardOptions): AutonomousCommandGuardResult {
  const guardBinDir = fs.mkdtempSync(path.join(os.tmpdir(), GUARD_DIR_PREFIX));
  const commands = ['npm', 'npx', 'jest', 'yarn', 'pnpm'];

  for (const command of commands) {
    writeExecutable(path.join(guardBinDir, command), buildWrapper(command, resolveRealCommand(command)));
  }

  const autonomousBackendJestEnv = deriveAutonomousBackendJestEnv(options.env);

  return {
    guardBinDir,
    env: {
      ...options.env,
      PATH: `${guardBinDir}${path.delimiter}${options.env.PATH ?? process.env.PATH ?? ''}`,
      RORCA_AUTONOMOUS_COMMAND_GUARD: '1',
      RORCA_AUTONOMOUS_WORKSPACE_ROOT: fs.realpathSync(options.cwd),
      ...(autonomousBackendJestEnv
        ? {
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
