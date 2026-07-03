/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import { execFileSync } from 'child_process';

export interface ReusableWorktreeValidationInput {
  workspacePath: string;
  worktreePath: string;
  expectedBranchName?: string | null;
}

export interface ReusableWorktreeValidationResult {
  ok: boolean;
  reason?: 'missing_worktree' | 'not_a_git_worktree' | 'branch_mismatch' | 'stale_base';
  workspaceHead?: string;
  worktreeHead?: string;
  mergeBase?: string;
  currentBranch?: string;
  detail?: string;
}

export interface ReusableBranchValidationInput {
  workspacePath: string;
  branchName: string;
}

export interface ReusableBranchValidationResult {
  ok: boolean;
  reason?: 'missing_branch' | 'stale_base';
  workspaceHead?: string;
  branchHead?: string;
  mergeBase?: string;
  detail?: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', `safe.directory=${cwd}`, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  }).trim();
}

/**
 * Validate that an existing reusable worktree is still based on the current
 * workspace HEAD. This blocks retries/reruns from executing inside stale
 * worktrees that were created before safety-critical fixes landed on main.
 */
export function validateReusableWorktree(
  input: ReusableWorktreeValidationInput,
): ReusableWorktreeValidationResult {
  const { workspacePath, worktreePath, expectedBranchName } = input;

  if (!fs.existsSync(worktreePath)) {
    return {
      ok: false,
      reason: 'missing_worktree',
      detail: `worktree path does not exist: ${worktreePath}`,
    };
  }

  let workspaceHead = '';
  let worktreeHead = '';
  let mergeBase = '';
  let currentBranch = '';

  try {
    git(worktreePath, ['rev-parse', '--is-inside-work-tree']);
    workspaceHead = git(workspacePath, ['rev-parse', 'HEAD']);
    worktreeHead = git(worktreePath, ['rev-parse', 'HEAD']);
    currentBranch = git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  } catch (error) {
    return {
      ok: false,
      reason: 'not_a_git_worktree',
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  if (expectedBranchName && currentBranch !== expectedBranchName) {
    return {
      ok: false,
      reason: 'branch_mismatch',
      workspaceHead,
      worktreeHead,
      currentBranch,
      detail: `expected ${expectedBranchName} but found ${currentBranch}`,
    };
  }

  try {
    mergeBase = git(workspacePath, ['merge-base', workspaceHead, worktreeHead]);
  } catch (error) {
    return {
      ok: false,
      reason: 'not_a_git_worktree',
      workspaceHead,
      worktreeHead,
      currentBranch,
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  if (mergeBase !== workspaceHead) {
    return {
      ok: false,
      reason: 'stale_base',
      workspaceHead,
      worktreeHead,
      mergeBase,
      currentBranch,
      detail: 'worktree merge-base no longer matches current workspace HEAD',
    };
  }

  return {
    ok: true,
    workspaceHead,
    worktreeHead,
    mergeBase,
    currentBranch,
  };
}

export function validateReusableBranch(
  input: ReusableBranchValidationInput,
): ReusableBranchValidationResult {
  const { workspacePath, branchName } = input;

  let workspaceHead = '';
  let branchHead = '';
  let mergeBase = '';

  try {
    workspaceHead = git(workspacePath, ['rev-parse', 'HEAD']);
    branchHead = git(workspacePath, ['rev-parse', branchName]);
  } catch (error) {
    return {
      ok: false,
      reason: 'missing_branch',
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    mergeBase = git(workspacePath, ['merge-base', workspaceHead, branchHead]);
  } catch (error) {
    return {
      ok: false,
      reason: 'missing_branch',
      workspaceHead,
      branchHead,
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  if (mergeBase !== workspaceHead) {
    return {
      ok: false,
      reason: 'stale_base',
      workspaceHead,
      branchHead,
      mergeBase,
      detail: 'branch merge-base no longer matches current workspace HEAD',
    };
  }

  return {
    ok: true,
    workspaceHead,
    branchHead,
    mergeBase,
  };
}
