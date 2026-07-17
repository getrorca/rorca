/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import {
  createAutonomousCommandGuard,
  deriveAutonomousBackendJestEnv,
  sanitizeAutonomousAgentEnv,
} from '../autonomous-command-guard';

describe('autonomous-command-guard', () => {
  test('does not derive test credentials from a local production DATABASE_URL', () => {
    expect(
      deriveAutonomousBackendJestEnv({
        DATABASE_URL: 'postgres://rorca:rorca@127.0.0.1:5433/rorca',
      })
    ).toBeNull();
  });

  test('prefers an explicit dedicated test database override', () => {
    expect(
      deriveAutonomousBackendJestEnv({
        DATABASE_URL: 'postgres://rorca:rorca@db.example.com:5432/rorca',
        RORCA_TEST_DATABASE_URL: 'postgres://rorca:rorca@db.example.com:5432/rorca_test',
      })
    ).toEqual({
      databaseUrl: 'postgres://rorca:rorca@db.example.com:5432/rorca_test',
      pgHost: 'db.example.com',
      pgPort: '5432',
      pgUser: 'rorca',
      pgPassword: 'rorca',
      pgDatabase: 'rorca_test',
    });
  });

  test('does not auto-derive a backend Jest database for remote non-test DATABASE_URL values', () => {
    expect(
      deriveAutonomousBackendJestEnv({
        DATABASE_URL: 'postgres://rorca:rorca@db.example.com:5432/rorca',
      })
    ).toBeNull();
  });

  test('strips Rorca infrastructure credentials from autonomous CLI environments', () => {
    expect(sanitizeAutonomousAgentEnv({
      PATH: '/usr/bin',
      DATABASE_URL: 'postgres://prod-secret',
      PGPASSWORD: 'db-secret',
      JWT_SECRET: 'jwt-secret',
      GITHUB_TOKEN: 'github-secret',
      ANTHROPIC_API_KEY: 'provider-key-required-by-selected-cli',
    })).toEqual({
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'provider-key-required-by-selected-cli',
    });
  });

  test('auto-routes backend Jest commands to the explicit dedicated _test database', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-guard-ws-'));
    const backend = path.join(workspace, 'backend');
    const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-guard-bin-'));
    const fakeJestPath = path.join(fakeBinDir, 'jest');
    const originalPath = process.env.PATH;

    fs.mkdirSync(backend, { recursive: true });
    fs.writeFileSync(
      fakeJestPath,
      '#!/usr/bin/env bash\nset -euo pipefail\nprintf "PGUSER=%s\\nPGDATABASE=%s\\nNODE_ENV=%s\\n" "${PGUSER:-}" "${PGDATABASE:-}" "${NODE_ENV:-}"\n',
      { mode: 0o755 },
    );

    process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath ?? ''}`;

    let guarded: ReturnType<typeof createAutonomousCommandGuard> | null = null;
    try {
      guarded = createAutonomousCommandGuard({
        cwd: workspace,
        env: {
          ...process.env,
          DATABASE_URL: 'postgres://rorca:rorca@127.0.0.1:5433/rorca',
          DATABASE_URL_TEST: '',
        } as Record<string, string>,
      });

      const routed = spawnSync('jest', ['--version'], {
        cwd: backend,
        env: guarded.env,
        encoding: 'utf8',
      });

      expect(routed.status).toBe(0);
      const expectedTestUrl = new URL(process.env.RORCA_TEST_DATABASE_URL!);
      expect(routed.stdout).toContain(`PGUSER=${expectedTestUrl.username}`);
      expect(routed.stdout).toContain(`PGDATABASE=${expectedTestUrl.pathname.slice(1)}`);
      expect(routed.stdout).toContain('NODE_ENV=test');
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(fakeBinDir, { recursive: true, force: true });
      if (guarded) {
        fs.rmSync(guarded.guardBinDir, { recursive: true, force: true });
      }
    }
  });

  test('conflict-resolution profile blocks agent-owned network and remote git operations', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-conflict-guard-ws-'));
    const guarded = createAutonomousCommandGuard({
      cwd: workspace,
      env: process.env as Record<string, string>,
      profile: 'conflict-resolution',
    });
    try {
      for (const [command, args] of [
        ['git', ['push', 'origin', 'HEAD']],
        ['git', ['fetch', 'origin']],
        ['gh', ['pr', 'merge', '1']],
        ['curl', ['https://example.com']],
      ] as Array<[string, string[]]>) {
        const result = spawnSync(command, args, { cwd: workspace, env: guarded.env, encoding: 'utf8' });
        expect(result.status).toBe(126);
        expect(result.stderr).toMatch(/blocked/i);
      }
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(guarded.guardBinDir, { recursive: true, force: true });
    }
  });

  test('still blocks backend Jest commands when no safe test database can be derived', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-guard-ws-'));
    const backend = path.join(workspace, 'backend');
    fs.mkdirSync(backend, { recursive: true });

    const untrustedEnv = {
      ...process.env,
      DATABASE_URL: 'postgres://rorca:rorca@db.example.com:5432/rorca',
    } as Record<string, string>;
    delete untrustedEnv.RORCA_TEST_DATABASE_URL;
    delete untrustedEnv.DATABASE_URL_TEST;

    const guarded = createAutonomousCommandGuard({
      cwd: workspace,
      env: untrustedEnv,
    });

    try {
      const blocked = spawnSync('jest', ['--version'], {
        cwd: backend,
        env: guarded.env,
        encoding: 'utf8',
      });

      expect(blocked.status).toBe(126);
      expect(blocked.stderr).toContain('Blocked backend/Jest-style test command');

      const safe = spawnSync('npm', ['--version'], {
        cwd: backend,
        env: guarded.env,
        encoding: 'utf8',
      });

      expect(safe.status).toBe(0);

      const explicitlyAllowed = spawnSync('jest', ['--version'], {
        cwd: backend,
        env: {
          ...guarded.env,
          RORCA_ALLOW_BACKEND_JEST: 'true',
          DATABASE_URL: 'postgres://rorca:rorca@db.example.com:5432/rorca_test',
        },
        encoding: 'utf8',
      });

      expect(explicitlyAllowed.status).toBe(0);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(guarded.guardBinDir, { recursive: true, force: true });
    }
  });
});
