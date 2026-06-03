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

export interface AutonomousCommandGuardOptions {
  cwd: string;
  env: Record<string, string>;
}

export interface AutonomousCommandGuardResult {
  env: Record<string, string>;
  guardBinDir: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
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
  if [[ "$allow_backend_jest" == "true" && "$database_url" =~ _test($|[?&/]) ]]; then
    exec ${execTarget} "$@"
  fi
  cat >&2 <<'RORCA_GUARD_MESSAGE'
[Rorca autonomous command guard] Blocked backend/Jest-style test command.
Autonomous agents must not run backend Jest or live-DB destructive tests unless explicitly allowed with RORCA_ALLOW_BACKEND_JEST=true and DATABASE_URL points to a database ending in _test.
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

  return {
    guardBinDir,
    env: {
      ...options.env,
      PATH: `${guardBinDir}${path.delimiter}${options.env.PATH ?? process.env.PATH ?? ''}`,
      RORCA_AUTONOMOUS_COMMAND_GUARD: '1',
      RORCA_AUTONOMOUS_WORKSPACE_ROOT: fs.realpathSync(options.cwd),
    },
  };
}
