/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Deterministic, crash-recoverable direct integration in an isolated checkout. */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { execute } from '../db/index';
import { logger } from './logger';
import { resolveMergeConflict, type MergeResolutionPosture } from './merge-conflict-resolver';
import { isGitSha } from './git-sha';
import {
  revalidateRunReleaseIdentity,
  withRunReleaseLock,
  type RunReleaseIdentity,
} from './release-identity';

const TRACKING_PATTERNS = [
  '.rorca/run-state.json',
  'progress.txt',
  '.rorca/memory/runs/',
];

export function redactMergeDiagnostics(value: string, workspacePath?: string): string {
  const withoutWorkspace = workspacePath ? value.split(workspacePath).join('<workspace>') : value;
  return withoutWorkspace
    .replace(/(?:^|\s)\/?(?:Users|private|tmp|home)\/[^\s:'"\n]+/g, ' <path>')
    .replace(/^(?:\+\+\+|---|@@|[+-](?!\s*\d)).*$/gm, '[redacted-diff]')
    .slice(0, 512);
}

export interface MergeResult {
  success: boolean;
  error?: string;
  conflictFiles?: string[];
  mergeCommitSha?: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

function tryGit(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync('git', args, {
    cwd, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return { ok: result.status === 0, stdout: String(result.stdout ?? '').trim(), stderr: String(result.stderr ?? '').trim() };
}

function registeredWorktreePaths(workspace: string): string[] {
  const output = git(workspace, ['worktree', 'list', '--porcelain']);
  return output.split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice(9));
}

function exactMarker(identity: RunReleaseIdentity): string {
  return `Rorca-Release-Identity: run=${identity.runId};source=${identity.authorizedSha};base=${identity.baseSha}`;
}

function isRecoveredIntegration(identity: RunReleaseIdentity, head: string): boolean {
  if (!isGitSha(head) || head === identity.baseSha) return false;
  if (git(identity.integrationCheckoutPath, ['status', '--porcelain']) !== '') return false;
  if (!tryGit(identity.integrationCheckoutPath, ['merge-base', '--is-ancestor', identity.baseSha, head]).ok
    || !tryGit(identity.integrationCheckoutPath, ['merge-base', '--is-ancestor', identity.authorizedSha, head]).ok) return false;
  return git(identity.integrationCheckoutPath, ['show', '-s', '--format=%B', head]).includes(exactMarker(identity));
}

function ensureIntegrationCheckout(identity: RunReleaseIdentity): void {
  const registered = registeredWorktreePaths(identity.workspaceRealpath);
  const target = identity.integrationCheckoutPath;
  const targetRegistered = registered.includes(target);
  if (!fs.existsSync(target)) {
    if (targetRegistered) {
      git(identity.workspaceRealpath, ['worktree', 'prune', '--expire', 'now']);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    git(identity.workspaceRealpath, ['worktree', 'add', '--detach', target, identity.baseSha]);
  } else if (!targetRegistered) {
    throw new Error('integration checkout exists but is not the frozen repository worktree');
  }
  const commonRaw = git(target, ['rev-parse', '--git-common-dir']);
  const expectedRaw = git(identity.workspaceRealpath, ['rev-parse', '--git-common-dir']);
  const common = fs.realpathSync(path.resolve(target, commonRaw));
  const expectedCommon = fs.realpathSync(path.resolve(identity.workspaceRealpath, expectedRaw));
  if (common !== expectedCommon) throw new Error('integration checkout belongs to a different repository');
}

function recoverUnfinishedIntegration(identity: RunReleaseIdentity): void {
  const mergeHead = tryGit(identity.integrationCheckoutPath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  if (!mergeHead.ok) return;
  // No provider/local-base effect occurs until the merge SHA is durable. A
  // crash-left index/MERGE_HEAD is therefore safely reset to the frozen base.
  tryGit(identity.integrationCheckoutPath, ['merge', '--abort']);
  git(identity.integrationCheckoutPath, ['reset', '--hard', identity.baseSha]);
}

async function executeIsolatedMerge(
  identity: RunReleaseIdentity,
  workspaceId: string,
  posture: MergeResolutionPosture | undefined,
  resolverEnv: Record<string, string>,
): Promise<MergeResult> {
  ensureIntegrationCheckout(identity);
  recoverUnfinishedIntegration(identity);

  let head = git(identity.integrationCheckoutPath, ['rev-parse', '--verify', 'HEAD^{commit}']).toLowerCase();
  if (isRecoveredIntegration(identity, head)) return { success: true, mergeCommitSha: head };
  if (head !== identity.baseSha) {
    git(identity.integrationCheckoutPath, ['reset', '--hard', identity.baseSha]);
    head = identity.baseSha;
  }

  const currentBase = git(identity.workspaceRealpath, ['rev-parse', `refs/heads/${identity.baseBranch}^{commit}`]).toLowerCase();
  const symbolicBase = git(identity.workspaceRealpath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (symbolicBase !== identity.baseBranch) return { success: false, error: 'Canonical base branch switched before integration' };
  if (currentBase !== identity.baseSha) return { success: false, error: 'Frozen local base advanced before integration' };
  if (git(identity.workspaceRealpath, ['status', '--porcelain']) !== '') {
    return { success: false, error: 'Canonical base worktree is dirty before integration' };
  }

  const merge = tryGit(identity.integrationCheckoutPath, ['merge', '--no-ff', '--no-commit', identity.authorizedSha]);
  if (!merge.ok) {
    const conflicts = tryGit(identity.integrationCheckoutPath, ['diff', '--name-only', '--diff-filter=U'])
      .stdout.split('\n').filter(Boolean);
    const realConflicts = conflicts.filter((file) => !TRACKING_PATTERNS.some((pattern) => file.includes(pattern)));
    if (realConflicts.length === 0 && conflicts.length > 0) {
      for (const file of conflicts) {
        git(identity.integrationCheckoutPath, ['checkout', '--theirs', '--', file]);
        git(identity.integrationCheckoutPath, ['add', '--', file]);
      }
    } else if (realConflicts.length > 0 && posture) {
      const resolution = await resolveMergeConflict({
        runId: identity.runId,
        workspaceId,
        cwd: identity.integrationCheckoutPath,
        branchName: identity.branchName,
        conflictFiles: realConflicts,
        logPath: path.join(identity.workspaceRealpath, '.rorca', 'logs', `run_${identity.runId}_merge_resolve.log`),
        posture,
        env: resolverEnv,
      });
      if (!resolution.ok) {
        tryGit(identity.integrationCheckoutPath, ['merge', '--abort']);
        return { success: false, error: `Code conflicts in: ${realConflicts.join(', ')}`, conflictFiles: realConflicts };
      }
    } else if (realConflicts.length > 0) {
      tryGit(identity.integrationCheckoutPath, ['merge', '--abort']);
      return { success: false, error: `Code conflicts in: ${realConflicts.join(', ')}`, conflictFiles: realConflicts };
    } else if (!/already up[ -]to[ -]date/i.test(`${merge.stdout}\n${merge.stderr}`)) {
      tryGit(identity.integrationCheckoutPath, ['merge', '--abort']);
      return { success: false, error: redactMergeDiagnostics(merge.stderr || merge.stdout, identity.workspaceRealpath) };
    }
  }

  const mergeHead = tryGit(identity.integrationCheckoutPath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  if (mergeHead.ok) {
    git(identity.integrationCheckoutPath, ['commit', '-m', `merge: ${identity.branchName} (Rorca exact release)\n\n${exactMarker(identity)}`]);
  }
  const mergedSha = git(identity.integrationCheckoutPath, ['rev-parse', '--verify', 'HEAD^{commit}']).toLowerCase();
  if (!isGitSha(mergedSha)
    || !tryGit(identity.integrationCheckoutPath, ['merge-base', '--is-ancestor', identity.baseSha, mergedSha]).ok
    || !tryGit(identity.integrationCheckoutPath, ['merge-base', '--is-ancestor', identity.authorizedSha, mergedSha]).ok) {
    return { success: false, error: 'Isolated integration result does not contain exact frozen base and source' };
  }
  return { success: true, mergeCommitSha: mergedSha };
}

export async function performMerge(
  runId: number | string,
  branchName: string,
  workspacePath: string,
  resolverPosture?: MergeResolutionPosture,
  resolverEnv: Record<string, string> = {},
  releaseIdentity?: RunReleaseIdentity,
): Promise<MergeResult> {
  if (!releaseIdentity) return { success: false, error: 'Host release identity is required for final base merge' };
  if (Number(runId) !== releaseIdentity.runId
    || branchName !== releaseIdentity.branchName
    || fs.realpathSync(workspacePath) !== releaseIdentity.workspaceRealpath) {
    return { success: false, error: 'Merge arguments differ from immutable host release identity' };
  }
  return withRunReleaseLock(releaseIdentity, async () => {
    await revalidateRunReleaseIdentity(releaseIdentity);
    await execute(`UPDATE pipeline_runs SET merge_status = 'merging' WHERE id = $1`, [releaseIdentity.runId]);
    try {
      const result = await executeIsolatedMerge(releaseIdentity, releaseIdentity.workspaceId, resolverPosture, resolverEnv);
      await execute(`UPDATE pipeline_runs SET merge_status = $1 WHERE id = $2`, [result.success ? 'merged' : 'failed', releaseIdentity.runId]);
      return result;
    } catch (error) {
      logger.warn({ runId: releaseIdentity.runId, error }, '[merge-handler] isolated exact integration deferred');
      await execute(`UPDATE pipeline_runs SET merge_status = 'failed' WHERE id = $1`, [releaseIdentity.runId]);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
