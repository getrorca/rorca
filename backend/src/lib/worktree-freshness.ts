/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import { execFileSync } from 'child_process';
import { isDeterministicRunArtifactPath } from './run-spec-snapshot';

export type WorktreeFreshnessClassification =
  | 'fresh'
  | 'stale_base'
  | 'missing_branch'
  | 'dirty_expected_work'
  | 'dirty_unrelated_work'
  | 'conflict_risk'
  | 'invalid_ownership_safe_directory';

export interface ReusableWorktreeValidationInput {
  workspacePath: string;
  worktreePath: string;
  expectedBranchName?: string | null;
  expectedDirtyPaths?: string[];
  /** Permit only deterministic, host-owned per-run projections—not arbitrary runtime files. */
  allowRorcaRuntimeMetadata?: boolean;
}

export interface ReusableWorktreeValidationResult {
  ok: boolean;
  classification: WorktreeFreshnessClassification;
  reason?: 'missing_worktree' | 'not_a_git_worktree' | 'branch_mismatch' | 'stale_base' | 'dirty_worktree' | 'conflict_risk' | 'invalid_ownership';
  workspaceHead?: string;
  worktreeHead?: string;
  mergeBase?: string;
  currentBranch?: string;
  dirtyPaths?: string[];
  detail?: string;
}

export interface ReusableBranchValidationInput {
  workspacePath: string;
  branchName: string;
}

export interface ReusableBranchValidationResult {
  ok: boolean;
  classification: WorktreeFreshnessClassification;
  reason?: 'missing_branch' | 'stale_base' | 'invalid_ownership';
  workspaceHead?: string;
  branchHead?: string;
  mergeBase?: string;
  detail?: string;
}

export interface WorktreeRefreshEvidence {
  operation: 'rebase';
  status: 'refreshed' | 'not_needed' | 'operator_action_required';
  classificationBefore: WorktreeFreshnessClassification;
  beforeHead?: string;
  afterHead?: string;
  workspaceHead?: string;
  preservedCommits: string[];
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
 * Untrimmed git output. Porcelain status is line-oriented: a worktree-modified
 * first line (` M path`) starts with a space, and trimming the whole blob would
 * eat that leading byte before the per-line `slice(3)` status prefix is
 * removed, corrupting the path (`progress.txt` -> `rogress.txt`).
 */
function gitRaw(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', `safe.directory=${cwd}`, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const stderr = (error as Error & { stderr?: Buffer | string }).stderr;
  return `${error.message}${stderr ? ` ${String(stderr)}` : ''}`.trim();
}

function isOwnershipError(detail: string): boolean {
  return /dubious ownership|safe\.directory|unsafe repository/i.test(detail);
}

function dirtyPaths(cwd: string): string[] {
  const output = gitRaw(cwd, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (!output) return [];
  return output.split('\n').map((line) => line.slice(3).trim()).filter(Boolean);
}

/** Match only filenames Rorca deterministically owns before worker preflight. */
export { isDeterministicRunArtifactPath as isRorcaRuntimeMetadataPath } from './run-spec-snapshot';

function conflictsWithWorkspaceHead(worktreePath: string, workspaceHead: string, worktreeHead: string): boolean {
  if (workspaceHead === worktreeHead) return false;
  try {
    execFileSync('git', ['merge-tree', '--write-tree', workspaceHead, worktreeHead], {
      cwd: worktreePath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    });
    return false;
  } catch (error) {
    const detail = errorText(error);
    // Older Git versions may not support --write-tree. Do not misclassify the
    // capability error as a content conflict.
    return !/unknown option|usage: git merge-tree/i.test(detail);
  }
}

/** Classify reusable worktree state without mutating refs, files, or commits. */
export function validateReusableWorktree(input: ReusableWorktreeValidationInput): ReusableWorktreeValidationResult {
  const { workspacePath, worktreePath, expectedBranchName } = input;
  if (!fs.existsSync(worktreePath)) {
    return {
      ok: false,
      classification: 'missing_branch',
      reason: 'missing_worktree',
      detail: `worktree path does not exist: ${worktreePath}`,
    };
  }

  let workspaceHead = '';
  let worktreeHead = '';
  let mergeBase = '';
  let currentBranch = '';
  let paths: string[] = [];
  try {
    git(worktreePath, ['rev-parse', '--is-inside-work-tree']);
    workspaceHead = git(workspacePath, ['rev-parse', 'HEAD']);
    worktreeHead = git(worktreePath, ['rev-parse', 'HEAD']);
    currentBranch = git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    paths = dirtyPaths(worktreePath);
  } catch (error) {
    const detail = errorText(error);
    return {
      ok: false,
      classification: isOwnershipError(detail) ? 'invalid_ownership_safe_directory' : 'missing_branch',
      reason: isOwnershipError(detail) ? 'invalid_ownership' : 'not_a_git_worktree',
      detail,
    };
  }

  if (expectedBranchName && currentBranch !== expectedBranchName) {
    return {
      ok: false,
      classification: 'missing_branch',
      reason: 'branch_mismatch',
      workspaceHead,
      worktreeHead,
      currentBranch,
      dirtyPaths: paths,
      detail: `expected ${expectedBranchName} but found ${currentBranch}`,
    };
  }

  const expected = input.expectedDirtyPaths ?? [];
  const unrelated = paths.filter((dirtyPath) => {
    if (expected.some((prefix) => dirtyPath === prefix || dirtyPath.startsWith(`${prefix}/`))) return false;
    return !(input.allowRorcaRuntimeMetadata && isDeterministicRunArtifactPath(dirtyPath));
  });
  if (unrelated.length > 0) {
    return {
      ok: false,
      classification: 'dirty_unrelated_work',
      reason: 'dirty_worktree',
      workspaceHead,
      worktreeHead,
      currentBranch,
      dirtyPaths: paths,
      detail: `unrelated dirty paths require operator action: ${unrelated.join(', ')}`,
    };
  }

  try {
    mergeBase = git(workspacePath, ['merge-base', workspaceHead, worktreeHead]);
  } catch (error) {
    const detail = errorText(error);
    return {
      ok: false,
      classification: isOwnershipError(detail) ? 'invalid_ownership_safe_directory' : 'missing_branch',
      reason: isOwnershipError(detail) ? 'invalid_ownership' : 'not_a_git_worktree',
      workspaceHead,
      worktreeHead,
      currentBranch,
      dirtyPaths: paths,
      detail,
    };
  }

  if (mergeBase !== workspaceHead && conflictsWithWorkspaceHead(worktreePath, workspaceHead, worktreeHead)) {
    return {
      ok: false,
      classification: 'conflict_risk',
      reason: 'conflict_risk',
      workspaceHead,
      worktreeHead,
      mergeBase,
      currentBranch,
      dirtyPaths: paths,
      detail: 'refresh would conflict; preserve the worktree and request operator action',
    };
  }
  if (mergeBase !== workspaceHead) {
    return {
      ok: false,
      classification: 'stale_base',
      reason: 'stale_base',
      workspaceHead,
      worktreeHead,
      mergeBase,
      currentBranch,
      dirtyPaths: paths,
      detail: 'worktree merge-base no longer matches current workspace HEAD',
    };
  }
  if (paths.length > 0) {
    return {
      ok: true,
      classification: 'dirty_expected_work',
      workspaceHead,
      worktreeHead,
      mergeBase,
      currentBranch,
      dirtyPaths: paths,
      detail: 'dirty paths are expected story/checkpoint work and are preserved',
    };
  }
  return { ok: true, classification: 'fresh', workspaceHead, worktreeHead, mergeBase, currentBranch, dirtyPaths: [] };
}

export function validateReusableBranch(input: ReusableBranchValidationInput): ReusableBranchValidationResult {
  const { workspacePath, branchName } = input;
  let workspaceHead = '';
  let branchHead = '';
  let mergeBase = '';
  try {
    workspaceHead = git(workspacePath, ['rev-parse', 'HEAD']);
    branchHead = git(workspacePath, ['rev-parse', branchName]);
    mergeBase = git(workspacePath, ['merge-base', workspaceHead, branchHead]);
  } catch (error) {
    const detail = errorText(error);
    return {
      ok: false,
      classification: isOwnershipError(detail) ? 'invalid_ownership_safe_directory' : 'missing_branch',
      reason: isOwnershipError(detail) ? 'invalid_ownership' : 'missing_branch',
      detail,
    };
  }
  if (mergeBase !== workspaceHead) {
    return { ok: false, classification: 'stale_base', reason: 'stale_base', workspaceHead, branchHead, mergeBase, detail: 'branch merge-base no longer matches current workspace HEAD' };
  }
  return { ok: true, classification: 'fresh', workspaceHead, branchHead, mergeBase };
}

/**
 * Refresh a clean stale worktree with a normal rebase. This preserves commits
 * and aborts on conflicts; it never resets, deletes a branch, or force-pushes.
 */
export function safelyRefreshReusableWorktree(input: ReusableWorktreeValidationInput): WorktreeRefreshEvidence {
  const before = validateReusableWorktree(input);
  const preservedCommits = before.mergeBase && before.worktreeHead
    ? git(input.worktreePath, ['rev-list', '--reverse', `${before.mergeBase}..${before.worktreeHead}`]).split('\n').filter(Boolean)
    : [];
  if (before.ok) {
    return { operation: 'rebase', status: 'not_needed', classificationBefore: before.classification, beforeHead: before.worktreeHead, afterHead: before.worktreeHead, workspaceHead: before.workspaceHead, preservedCommits };
  }
  if (before.classification !== 'stale_base' || !before.workspaceHead || !before.worktreeHead) {
    return { operation: 'rebase', status: 'operator_action_required', classificationBefore: before.classification, beforeHead: before.worktreeHead, workspaceHead: before.workspaceHead, preservedCommits, detail: before.detail };
  }
  try {
    git(input.worktreePath, ['rebase', before.workspaceHead]);
    const afterHead = git(input.worktreePath, ['rev-parse', 'HEAD']);
    const afterSubjects = git(input.worktreePath, ['log', '--format=%s', `${before.workspaceHead}..${afterHead}`]).split('\n').filter(Boolean);
    if (afterSubjects.length < preservedCommits.length) {
      throw new Error('rebase did not preserve every story/checkpoint commit');
    }
    return { operation: 'rebase', status: 'refreshed', classificationBefore: before.classification, beforeHead: before.worktreeHead, afterHead, workspaceHead: before.workspaceHead, preservedCommits, detail: `rebased ${preservedCommits.length} commit(s) without reset or force push` };
  } catch (error) {
    try { git(input.worktreePath, ['rebase', '--abort']); } catch { /* preserve best available state */ }
    return { operation: 'rebase', status: 'operator_action_required', classificationBefore: before.classification, beforeHead: before.worktreeHead, workspaceHead: before.workspaceHead, preservedCommits, detail: errorText(error) };
  }
}
