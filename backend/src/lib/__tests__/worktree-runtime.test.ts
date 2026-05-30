/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensureWorktreeRuntimeSupport } from '../worktree-runtime';

describe('worktree-runtime', () => {
  test('links node_modules, copies env files, and updates gitignore idempotently', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-worktree-runtime-'));
    const workspace = path.join(root, 'workspace');
    const worktree = path.join(root, 'worktree');

    fs.mkdirSync(path.join(workspace, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'backend', 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.env'), 'ROOT_ENV=1\n', 'utf8');
    fs.writeFileSync(path.join(workspace, 'backend', '.env'), 'BACKEND_ENV=1\n', 'utf8');
    fs.mkdirSync(worktree, { recursive: true });

    const first = ensureWorktreeRuntimeSupport(workspace, worktree);

    expect(first.linkedDirs).toEqual(['node_modules', path.join('backend', 'node_modules')]);
    expect(first.copiedEnvFiles).toEqual(['.env', path.join('backend', '.env')]);
    expect(first.gitignoreUpdated).toBe(true);
    expect(fs.lstatSync(path.join(worktree, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(worktree, 'backend', 'node_modules')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(worktree, '.env'), 'utf8')).toContain('ROOT_ENV=1');
    expect(fs.readFileSync(path.join(worktree, 'backend', '.env'), 'utf8')).toContain('BACKEND_ENV=1');
    expect(fs.readFileSync(path.join(worktree, '.gitignore'), 'utf8')).toContain('progress.txt');

    const second = ensureWorktreeRuntimeSupport(workspace, worktree);

    expect(second.linkedDirs).toEqual([]);
    expect(second.copiedEnvFiles).toEqual([]);
    expect(second.gitignoreUpdated).toBe(false);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
