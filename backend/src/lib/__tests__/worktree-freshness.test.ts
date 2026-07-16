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
import { safelyRefreshReusableWorktree, validateReusableBranch, validateReusableWorktree } from '../worktree-freshness';

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
    expect(result.classification).toBe('fresh');
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
    expect(result.classification).toBe('stale_base');
  });

  test('safe stale refresh rebases and preserves story commits without destructive reset', () => {
    fs.writeFileSync(path.join(worktreeDir, 'story.txt'), 'checkpoint\n');
    git(worktreeDir, 'git add story.txt');
    git(worktreeDir, 'git commit -m "story checkpoint"');
    fs.writeFileSync(path.join(repoDir, 'README.md'), 'advanced safely\n');
    git(repoDir, 'git add README.md');
    git(repoDir, 'git commit -m "advance main safely"');

    const evidence = safelyRefreshReusableWorktree({
      workspacePath: repoDir,
      worktreePath: worktreeDir,
      expectedBranchName: 'feat/test-branch',
    });

    expect(evidence.status).toBe('refreshed');
    expect(evidence.operation).toBe('rebase');
    expect(evidence.preservedCommits).toHaveLength(1);
    expect(git(worktreeDir, 'git log -1 --format=%s')).toBe('story checkpoint');
    expect(validateReusableWorktree({ workspacePath: repoDir, worktreePath: worktreeDir }).classification).toBe('fresh');
  });

  test('classifies expected and unrelated dirty work separately', () => {
    fs.mkdirSync(path.join(worktreeDir, '.rorca', 'progress'), { recursive: true });
    fs.writeFileSync(path.join(worktreeDir, '.rorca', 'progress', 'LFC-011.md'), 'progress\n');
    const expected = validateReusableWorktree({
      workspacePath: repoDir,
      worktreePath: worktreeDir,
      expectedDirtyPaths: ['.rorca/progress'],
    });
    expect(expected.ok).toBe(true);
    expect(expected.classification).toBe('dirty_expected_work');

    fs.writeFileSync(path.join(worktreeDir, 'unrelated.txt'), 'operator work\n');
    const unrelated = validateReusableWorktree({
      workspacePath: repoDir,
      worktreePath: worktreeDir,
      expectedDirtyPaths: ['.rorca/progress'],
    });
    expect(unrelated.ok).toBe(false);
    expect(unrelated.classification).toBe('dirty_unrelated_work');
    expect(safelyRefreshReusableWorktree({ workspacePath: repoDir, worktreePath: worktreeDir }).status).toBe('operator_action_required');
  });

  test('classifies refresh conflict risk and leaves commits intact', () => {
    fs.writeFileSync(path.join(worktreeDir, 'README.md'), 'story change\n');
    git(worktreeDir, 'git add README.md');
    git(worktreeDir, 'git commit -m "story changes readme"');
    const storyHead = git(worktreeDir, 'git rev-parse HEAD');
    fs.writeFileSync(path.join(repoDir, 'README.md'), 'main change\n');
    git(repoDir, 'git add README.md');
    git(repoDir, 'git commit -m "main changes readme"');

    const result = validateReusableWorktree({ workspacePath: repoDir, worktreePath: worktreeDir });
    expect(result.classification).toBe('conflict_risk');
    const evidence = safelyRefreshReusableWorktree({ workspacePath: repoDir, worktreePath: worktreeDir });
    expect(evidence.status).toBe('operator_action_required');
    expect(git(worktreeDir, 'git rev-parse HEAD')).toBe(storyHead);
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
