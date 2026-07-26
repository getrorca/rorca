/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Exact local Git checkout authority shared by pass finalization and release. */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

const FULL_SHA_1 = /^[0-9a-f]{40}$/;
const BRANCH = /^(?!-)[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

export interface CanonicalRunCheckoutInput {
  cwd: string;
  repositoryTopLevel: string;
  branchName: string;
  expectedHead?: string;
}

export interface FrozenRunExecutionIdentityInput {
  payloadWorkspacePath: string;
  payloadWorktreePath: string | null;
  frozenWorkspacePath: string | null;
  frozenWorktreePath: string | null;
}

export interface CanonicalRunCheckout {
  cwd: string;
  repositoryTopLevel: string;
  branchName: string;
  headSha: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function realDirectory(value: string, label: string): string {
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`${label} is unavailable`);
  }
  return fs.realpathSync(resolved);
}

function parseWorktrees(cwd: string): Array<{ worktree: string; head: string; branch: string | null }> {
  const records: Array<{ worktree: string; head: string; branch: string | null }> = [];
  let current: { worktree?: string; head?: string; branch?: string | null } = {};
  for (const line of `${git(cwd, ['worktree', 'list', '--porcelain'])}\n`.split('\n')) {
    if (line.startsWith('worktree ')) current.worktree = line.slice('worktree '.length);
    else if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length).toLowerCase();
    else if (line.startsWith('branch ')) current.branch = line.slice('branch '.length);
    else if (line === '' && current.worktree) {
      records.push({
        worktree: current.worktree,
        head: current.head ?? '',
        branch: current.branch ?? null,
      });
      current = {};
    }
  }
  return records;
}

/** Bind an untrusted queue payload to the exact DB-frozen realpaths. */
export function assertFrozenRunExecutionIdentity(input: FrozenRunExecutionIdentityInput): {
  workspacePath: string;
  worktreePath: string;
} {
  if (!input.frozenWorkspacePath || !input.frozenWorktreePath) {
    throw new Error('run has no DB-frozen workspace/worktree realpath identity');
  }
  const payloadWorkspace = realDirectory(input.payloadWorkspacePath, 'payload workspace');
  const payloadWorktree = realDirectory(input.payloadWorktreePath ?? input.payloadWorkspacePath, 'payload worktree');
  const frozenWorkspace = realDirectory(input.frozenWorkspacePath, 'frozen workspace');
  const frozenWorktree = realDirectory(input.frozenWorktreePath, 'frozen worktree');
  if (payloadWorkspace !== frozenWorkspace || payloadWorktree !== frozenWorktree) {
    throw new Error('queue payload workspace/worktree differs from DB-frozen run identity');
  }
  return { workspacePath: frozenWorkspace, worktreePath: frozenWorktree };
}

/**
 * Prove that the current checkout is the registered canonical run worktree,
 * repository, symbolic branch, and (when supplied) exact terminal HEAD.
 */
export function assertCanonicalRunCheckout(input: CanonicalRunCheckoutInput): CanonicalRunCheckout {
  if (!BRANCH.test(input.branchName)) throw new Error('canonical run branch is invalid');
  const cwd = realDirectory(input.cwd, 'run checkout');
  const repositoryTopLevel = realDirectory(input.repositoryTopLevel, 'run repository top-level');
  const gitTop = realDirectory(git(cwd, ['rev-parse', '--show-toplevel']), 'git top-level');
  if (gitTop !== cwd) throw new Error('run checkout does not match its git top-level');

  const canonicalGitTop = realDirectory(git(repositoryTopLevel, ['rev-parse', '--show-toplevel']), 'canonical repository top-level');
  if (canonicalGitTop !== repositoryTopLevel) {
    throw new Error('registered repository top-level is not canonical');
  }
  const currentCommonDir = path.resolve(cwd, git(cwd, ['rev-parse', '--git-common-dir']));
  const canonicalCommonDir = path.resolve(repositoryTopLevel, git(repositoryTopLevel, ['rev-parse', '--git-common-dir']));
  if (fs.realpathSync(currentCommonDir) !== fs.realpathSync(canonicalCommonDir)) {
    throw new Error('run checkout is registered to a different repository');
  }

  const branchName = git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const headSha = git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']).toLowerCase();
  if (branchName !== input.branchName) throw new Error('run symbolic branch differs from pipeline authority');
  if (!FULL_SHA_1.test(headSha)) throw new Error('run HEAD is not a supported 40-hex Git object id');
  if (input.expectedHead && headSha !== input.expectedHead.toLowerCase()) {
    throw new Error('run branch HEAD differs from exact terminal authority');
  }

  const registration = parseWorktrees(repositoryTopLevel).filter((record) => {
    try { return fs.realpathSync(record.worktree) === cwd; } catch { return false; }
  });
  if (registration.length !== 1
    || registration[0].branch !== `refs/heads/${input.branchName}`
    || registration[0].head !== headSha) {
    throw new Error('run worktree registration differs from branch/HEAD authority');
  }

  try {
    git(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
    throw new Error('run branch has an unfinished merge');
  } catch (error) {
    if (error instanceof Error && error.message === 'run branch has an unfinished merge') throw error;
  }

  return { cwd, repositoryTopLevel, branchName, headSha };
}

export function assertOrderedCommitAncestry(cwd: string, orderedShas: readonly string[], terminalHead: string): void {
  if (!FULL_SHA_1.test(terminalHead)) throw new Error('terminal HEAD is not a supported 40-hex Git object id');
  let previous: string | null = null;
  for (const rawSha of orderedShas) {
    const sha = rawSha.toLowerCase();
    if (!FULL_SHA_1.test(sha)) throw new Error('ordered result contains an unsupported Git object id');
    if (previous && previous !== sha) {
      try { git(cwd, ['merge-base', '--is-ancestor', previous, sha]); }
      catch { throw new Error('integrated story commits are not exact ordered descendants'); }
    }
    previous = sha;
  }
  if (previous && previous !== terminalHead) {
    try { git(cwd, ['merge-base', '--is-ancestor', previous, terminalHead]); }
    catch { throw new Error('terminal HEAD is not a legitimate descendant of integrated story authority'); }
  }
}

export function isSupportedGitCommitSha(value: unknown): value is string {
  return typeof value === 'string' && FULL_SHA_1.test(value);
}
