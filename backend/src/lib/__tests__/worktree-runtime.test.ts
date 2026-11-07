/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensureWorktreeRuntimeSupport, repairWorktreeRuntimeSupport } from '../worktree-runtime';

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

  test('repairs agent-churned real node_modules by restoring the canonical symlink', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-worktree-repair-'));
    const workspace = path.join(root, 'workspace');
    const worktree = path.join(root, 'worktree');

    fs.mkdirSync(path.join(workspace, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'node_modules', 'canonical-dep'), 'canonical', 'utf8');
    fs.mkdirSync(path.join(workspace, 'backend', 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'backend', 'node_modules', 'backend-canonical'), 'canonical', 'utf8');
    fs.mkdirSync(worktree, { recursive: true });

    // Correct links pass through untouched.
    ensureWorktreeRuntimeSupport(workspace, worktree);
    const untouched = repairWorktreeRuntimeSupport(workspace, worktree);
    expect(untouched.repairedDirs).toEqual([]);
    expect(untouched.verifiedDirs).toEqual(['node_modules', path.join('backend', 'node_modules')]);
    expect(untouched.failures).toEqual([]);

    // Simulate agent npm churn: replace the symlink with a real partial dir.
    fs.rmSync(path.join(worktree, 'node_modules'));
    fs.mkdirSync(path.join(worktree, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(worktree, 'node_modules', 'partial-agent-install'), 'churn', 'utf8');

    const repaired = repairWorktreeRuntimeSupport(workspace, worktree);

    expect(repaired.repairedDirs).toHaveLength(1);
    expect(repaired.repairedDirs[0]).toContain('node_modules');
    expect(fs.lstatSync(path.join(worktree, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(worktree, 'node_modules', 'canonical-dep'), 'utf8')).toBe('canonical');

    // The agent's churn is preserved aside, not deleted.
    const backups = fs.readdirSync(worktree).filter((name) => name.startsWith('node_modules.agent-churn-backup-'));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(worktree, backups[0], 'partial-agent-install'), 'utf8')).toBe('churn');

    // Missing workspace source is reported, not thrown.
    const missing = repairWorktreeRuntimeSupport(path.join(root, 'no-such-workspace'), worktree);
    expect(missing.failures.length).toBeGreaterThan(0);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
