/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * merge-handler.ts — Reusable worktree merge logic.
 *
 * Extracted from pipeline.ts autoMergeWorktree() so it can be called by:
 *   1. The post-run completion path (inline in pipeline routes)
 *   2. The worker's pipeline:merge handler (retry-merge endpoint)
 *
 * Self-contained: owns its own DB queries and git operations.
 * No imports from pipeline.ts or worker.ts to avoid circular deps.
 */

import * as fs from 'fs';
import * as path from 'path';
import simpleGit from 'simple-git';
import { queryOne, execute } from '../db/index';
import { broadcastAll, type WalEvent } from './sse-hub';
import { logger } from './logger';

// ── Tracking-only files that are always safe to resolve with --theirs ────────
const TRACKING_PATTERNS = [
  '.rorca/run-state.json',
  'progress.txt',
  '.rorca/memory/runs/',
];

export interface MergeResult {
  success: boolean;
  /** Set when success=false — describes what went wrong */
  error?: string;
  /** Files with real code conflicts (not auto-resolvable tracking files) */
  conflictFiles?: string[];
  /** Git SHA of the merge commit (on success) */
  mergeCommitSha?: string;
}

/**
 * performMerge — merge a worktree branch back into the main workspace.
 *
 * Strategy:
 *   1. Stash any uncommitted workspace changes
 *   2. Dry-run merge (safety pre-check) — bail out if real code conflicts
 *   3. Try --ff-only (cleanest)
 *   4. Fall back to --no-ff; auto-resolve tracking files
 *   5. On success: emit worktree_merged WAL + remove the worktree directory
 *   6. On failure: emit worktree_merge_failed WAL
 *   7. Always restore stash
 *   8. Update pipeline_runs.merge_status accordingly
 */
export async function performMerge(
  runId: number | string,
  branchName: string,
  workspacePath: string,
): Promise<MergeResult> {
  // Look up run row for worktree_path and workspace_id
  const run = await queryOne<{
    workspace_id: string;
    worktree_path: string | null;
    branch_name: string | null;
  }>(
    'SELECT workspace_id, worktree_path, branch_name FROM pipeline_runs WHERE id = $1',
    [runId],
  );

  if (!run) {
    return { success: false, error: 'Run not found' };
  }

  const worktreePath = run.worktree_path;
  const workspaceId = run.workspace_id;
  const effectiveBranch = branchName || run.branch_name;

  if (!effectiveBranch) {
    await execute(
      `UPDATE pipeline_runs SET merge_status = 'failed' WHERE id = $1`,
      [runId],
    );
    return { success: false, error: 'No branch name available for merge' };
  }

  // Mark as merging
  await execute(
    `UPDATE pipeline_runs SET merge_status = 'merging' WHERE id = $1`,
    [runId],
  );

  const git = simpleGit(workspacePath);

  // 1. Stash any uncommitted workspace changes
  let stashed = false;
  try {
    const status = await git.status();
    if (status.files.length > 0) {
      await git.stash(['push', '--include-untracked', '-m', `rorca-autostash-before-merge-${effectiveBranch}`]);
      stashed = true;
      logger.info({ runId, branchName: effectiveBranch }, '[merge-handler] Stashed uncommitted workspace changes');
    }
  } catch (err: any) {
    logger.warn({ err, runId }, '[merge-handler] Stash failed — proceeding without stash');
  }

  let result: MergeResult;

  try {
    result = await executeMerge(git, effectiveBranch, worktreePath, workspacePath, workspaceId, runId);
  } finally {
    // Always restore stash
    if (stashed) {
      try {
        await git.stash(['pop']);
        logger.info({ runId }, '[merge-handler] Restored stashed workspace changes');
      } catch (popErr: any) {
        logger.warn({ err: popErr, runId }, '[merge-handler] Stash pop conflict — run git stash pop manually');
      }
    }
  }

  // Update merge_status based on result
  const mergeStatus = result.success ? 'merged' : 'failed';
  await execute(
    `UPDATE pipeline_runs SET merge_status = $1 WHERE id = $2`,
    [mergeStatus, runId],
  );

  return result;
}

async function executeMerge(
  git: ReturnType<typeof simpleGit>,
  branchName: string,
  worktreePath: string | null,
  workspacePath: string,
  workspaceId: string,
  runId: number | string,
): Promise<MergeResult> {
  // 2. Safety pre-check: dry-run merge
  let preCheckConflictFiles: string[] = [];
  let preCheckIsClean = false;

  try {
    await git.merge([branchName, '--no-commit', '--no-ff']);
    preCheckIsClean = true;
    try { await git.merge(['--abort']); } catch { /* nothing to abort on clean merge */ }
  } catch (dryRunErr: any) {
    if (
      dryRunErr.message?.includes('CONFLICT') ||
      dryRunErr.message?.includes('Automatic merge failed') ||
      dryRunErr.message?.includes('fix conflicts')
    ) {
      try {
        const diffOut = await git.raw(['diff', '--name-only', '--diff-filter=U']);
        preCheckConflictFiles = diffOut.trim().split('\n').filter(Boolean);
      } catch { /* continue */ }
      try { await git.merge(['--abort']); } catch { /* already clean */ }

      const realConflicts = preCheckConflictFiles.filter(
        f => !TRACKING_PATTERNS.some(tp => f.includes(tp)),
      );

      if (realConflicts.length === 0) {
        preCheckIsClean = true;
        logger.info(
          { runId, trackingConflicts: preCheckConflictFiles },
          '[merge-handler] Only tracking file conflicts — auto-resolvable',
        );
      } else {
        // Real code conflicts — emit WAL and bail
        const walEvent = await queryOne<WalEvent>(
          `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('worktree_merge_failed', $1, $2) RETURNING *`,
          [workspaceId, JSON.stringify({
            run_id: runId,
            branchName,
            worktreePath,
            conflictFiles: realConflicts,
            message: 'Auto-merge failed — code conflicts detected. Resolve manually or retry after fixing.',
          })],
        );
        if (walEvent) broadcastAll(walEvent);

        return {
          success: false,
          error: `Code conflicts in: ${realConflicts.join(', ')}`,
          conflictFiles: realConflicts,
        };
      }
    } else if (dryRunErr.message?.includes('Already up to date')) {
      preCheckIsClean = true;
    } else {
      return { success: false, error: `Pre-check error: ${dryRunErr.message}` };
    }
  }

  if (!preCheckIsClean) {
    return { success: false, error: 'Pre-check did not pass' };
  }

  // 3. Execute the real merge
  let mergeSuccess = false;
  try {
    // Try fast-forward first
    try {
      await git.merge([branchName, '--ff-only']);
      mergeSuccess = true;
    } catch {
      // ff-only failed — do no-ff merge with tracking-file auto-resolution
      try {
        await git.merge([branchName, '--no-ff', '--no-commit']);
      } catch (mergeErr: any) {
        if (
          mergeErr.message?.includes('CONFLICT') ||
          mergeErr.message?.includes('Automatic merge failed')
        ) {
          for (const file of preCheckConflictFiles) {
            try {
              await git.raw(['checkout', '--theirs', '--', file]);
              await git.add(file);
            } catch { /* best-effort */ }
          }
        } else {
          throw mergeErr;
        }
      }

      // Commit the merge
      try {
        await git.commit(`merge: ${branchName} (auto)`);
        mergeSuccess = true;
      } catch (commitErr: any) {
        if (commitErr.message?.includes('nothing to commit') || commitErr.message?.includes('nothing added')) {
          mergeSuccess = true;
        } else {
          try { await git.merge(['--abort']); } catch { /* already clean */ }
          return { success: false, error: `Commit failed: ${commitErr.message}` };
        }
      }
    }
  } catch (unexpectedErr: any) {
    try { await git.merge(['--abort']); } catch { /* already clean */ }
    return { success: false, error: `Unexpected merge error: ${unexpectedErr.message}` };
  }

  if (!mergeSuccess) {
    return { success: false, error: 'Merge did not succeed' };
  }

  // 4. Success: get merge commit SHA
  let mergeCommitSha = '';
  try { mergeCommitSha = (await git.raw(['rev-parse', 'HEAD'])).trim(); } catch { /* non-fatal */ }

  // 5. Emit worktree_merged WAL event
  const walEvent = await queryOne<WalEvent>(
    `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('worktree_merged', $1, $2) RETURNING *`,
    [workspaceId, JSON.stringify({ run_id: runId, branchName, mergeCommitSha })],
  );
  if (walEvent) broadcastAll(walEvent);

  // 6. Remove the worktree directory if it still exists
  if (worktreePath && fs.existsSync(worktreePath)) {
    try {
      await git.raw(['worktree', 'remove', '--force', worktreePath]);
      logger.info({ runId, worktree: path.basename(worktreePath) }, '[merge-handler] Worktree removed');
    } catch (rmErr: any) {
      logger.warn({ err: rmErr, runId }, '[merge-handler] Worktree removal skipped');
    }
  }

  // 7. Clear worktree_path from pipeline_runs so UI knows it's merged
  try {
    await execute(`UPDATE pipeline_runs SET worktree_path = NULL WHERE id = $1`, [runId]);
  } catch { /* non-fatal */ }

  return { success: true, mergeCommitSha };
}
