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
} from '../autonomous-command-guard';

describe('autonomous-command-guard', () => {
  test('derives a safe backend Jest test database from a local DATABASE_URL', () => {
    expect(
      deriveAutonomousBackendJestEnv({
        DATABASE_URL: 'postgres://rorca:rorca@127.0.0.1:5433/rorca',
      })
    ).toEqual({
      databaseUrl: 'postgres://rorca:rorca@127.0.0.1:5433/rorca_test',
      pgHost: '127.0.0.1',
      pgPort: '5433',
      pgUser: 'rorca',
      pgPassword: 'rorca',
      pgDatabase: 'rorca_test',
    });
  });

  test('prefers an explicit DATABASE_URL_TEST override', () => {
    expect(
      deriveAutonomousBackendJestEnv({
        DATABASE_URL: 'postgres://rorca:rorca@db.example.com:5432/rorca',
        DATABASE_URL_TEST: 'postgres://rorca:rorca@db.example.com:5432/rorca_test',
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

  test('auto-routes backend Jest commands to a derived _test database', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-guard-ws-'));
    const backend = path.join(workspace, 'backend');
    const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-guard-bin-'));
    const fakeJestPath = path.join(fakeBinDir, 'jest');
    const originalPath = process.env.PATH;

    fs.mkdirSync(backend, { recursive: true });
    fs.writeFileSync(
      fakeJestPath,
      '#!/usr/bin/env bash\nset -euo pipefail\nprintf "DATABASE_URL=%s\\nPGDATABASE=%s\\nNODE_ENV=%s\\n" "${DATABASE_URL:-}" "${PGDATABASE:-}" "${NODE_ENV:-}"\n',
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
        } as Record<string, string>,
      });

      const routed = spawnSync('jest', ['--version'], {
        cwd: backend,
        env: guarded.env,
        encoding: 'utf8',
      });

      expect(routed.status).toBe(0);
      expect(routed.stdout).toContain('DATABASE_URL=postgres://rorca:rorca@127.0.0.1:5433/rorca_test');
      expect(routed.stdout).toContain('PGDATABASE=rorca_test');
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

  test('still blocks backend Jest commands when no safe test database can be derived', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-guard-ws-'));
    const backend = path.join(workspace, 'backend');
    fs.mkdirSync(backend, { recursive: true });

    const guarded = createAutonomousCommandGuard({
      cwd: workspace,
      env: {
        ...process.env,
        DATABASE_URL: 'postgres://rorca:rorca@db.example.com:5432/rorca',
      } as Record<string, string>,
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
