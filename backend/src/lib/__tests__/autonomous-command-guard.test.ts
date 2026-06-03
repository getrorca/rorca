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
import { createAutonomousCommandGuard } from '../autonomous-command-guard';

describe('autonomous-command-guard', () => {
  test('blocks backend Jest/npm-test commands unless explicitly allowed on a _test database', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-guard-ws-'));
    const backend = path.join(workspace, 'backend');
    fs.mkdirSync(backend, { recursive: true });

    const guarded = createAutonomousCommandGuard({
      cwd: workspace,
      env: {
        ...process.env,
        DATABASE_URL: 'postgres://rorca:rorca@127.0.0.1:5433/rorca',
      } as Record<string, string>,
    });

    const blocked = spawnSync('npm', ['test'], {
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

    const allowed = spawnSync('npx', ['jest', '--version'], {
      cwd: backend,
      env: {
        ...guarded.env,
        RORCA_ALLOW_BACKEND_JEST: 'true',
        DATABASE_URL: 'postgres://rorca:rorca@127.0.0.1:5433/rorca_test',
      },
      encoding: 'utf8',
    });

    expect(allowed.status).toBe(0);

    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(guarded.guardBinDir, { recursive: true, force: true });
  });
});
