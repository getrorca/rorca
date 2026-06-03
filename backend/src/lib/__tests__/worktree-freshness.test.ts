/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { validateReusableBranch, validateReusableWorktree } from '../worktree-freshness';

function git(cwd: string, command: string): string {
  return execSync(command, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

describe('validateReusableWorktree', () => {
  let repoDir = '';
  let worktreeDir = '';

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-worktree-freshness-'));
    git(repoDir, 'git init -b main');
    git(repoDir, 'git config user.name "Rorca Test"');
    git(repoDir, 'git config user.email "test@example.com"');
    fs.writeFileSync(path.join(repoDir, 'README.md'), 'base\n');
    git(repoDir, 'git add README.md');
    git(repoDir, 'git commit -m "base"');

    worktreeDir = path.join(os.tmpdir(), `rorca-worktree-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    git(repoDir, `git worktree add -b feat/test-branch "${worktreeDir}" HEAD`);
  });

  afterEach(() => {
    try { git(repoDir, `git worktree remove --force "${worktreeDir}"`); } catch {}
    fs.rmSync(worktreeDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  test('accepts a reusable worktree that is still based on current workspace HEAD', () => {
    const result = validateReusableWorktree({
      workspacePath: repoDir,
      worktreePath: worktreeDir,
      expectedBranchName: 'feat/test-branch',
    });

    expect(result.ok).toBe(true);
    expect(result.currentBranch).toBe('feat/test-branch');
    expect(result.mergeBase).toBe(result.workspaceHead);
  });

  test('rejects a reusable worktree after workspace main advances', () => {
    fs.writeFileSync(path.join(repoDir, 'README.md'), 'advanced\n');
    git(repoDir, 'git add README.md');
    git(repoDir, 'git commit -m "advance main"');

    const result = validateReusableWorktree({
      workspacePath: repoDir,
      worktreePath: worktreeDir,
      expectedBranchName: 'feat/test-branch',
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('stale_base');
  });

  test('rejects a reusable branch after workspace main advances even without a worktree dir', () => {
    git(repoDir, `git worktree remove --force "${worktreeDir}"`);
    fs.writeFileSync(path.join(repoDir, 'README.md'), 'advanced-branch\n');
    git(repoDir, 'git add README.md');
    git(repoDir, 'git commit -m "advance main branch only"');

    const result = validateReusableBranch({
      workspacePath: repoDir,
      branchName: 'feat/test-branch',
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('stale_base');
  });
});
