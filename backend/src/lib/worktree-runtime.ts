/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as path from 'path';

const WORKTREE_NODE_MODULE_DIRS = ['node_modules', path.join('backend', 'node_modules')];
const WORKTREE_ENV_FILES = ['.env', path.join('backend', '.env')];
const RUN_TRACKING_PATTERNS = '\n# Rorca run-tracking files (parallel-safe)\nprogress.txt\n.rorca/run-state.json\n.rorca/memory/health-log.json\n';
const RUNTIME_BACKUP_GITIGNORE_PATTERN = '.rorca-runtime-backup-*\n';

export interface WorktreeRuntimeSupportResult {
  linkedDirs: string[];
  copiedEnvFiles: string[];
  gitignoreUpdated: boolean;
}

export interface WorktreeRuntimeRepairResult {
  verifiedDirs: string[];
  repairedDirs: string[];
  failures: string[];
}

function ensureParentDir(targetPath: string): void {
  const parent = path.dirname(targetPath);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
}

function ensureSymlinkDir(sourcePath: string, targetPath: string): boolean {
  if (!fs.existsSync(sourcePath) || fs.existsSync(targetPath)) return false;
  ensureParentDir(targetPath);
  fs.symlinkSync(sourcePath, targetPath, 'dir');
  return true;
}

function ensureCopiedFile(sourcePath: string, targetPath: string): boolean {
  if (!fs.existsSync(sourcePath) || fs.existsSync(targetPath)) return false;
  ensureParentDir(targetPath);
  fs.copyFileSync(sourcePath, targetPath);
  return true;
}

export function ensureWorktreeRuntimeSupport(
  workspacePath: string,
  worktreePath: string,
): WorktreeRuntimeSupportResult {
  const linkedDirs: string[] = [];
  const copiedEnvFiles: string[] = [];

  for (const rel of WORKTREE_NODE_MODULE_DIRS) {
    const src = path.join(workspacePath, rel);
    const dst = path.join(worktreePath, rel);
    try {
      if (ensureSymlinkDir(src, dst)) linkedDirs.push(rel);
    } catch {
      // Non-fatal — runner may still install dependencies manually if needed.
    }
  }

  for (const rel of WORKTREE_ENV_FILES) {
    const src = path.join(workspacePath, rel);
    const dst = path.join(worktreePath, rel);
    try {
      if (ensureCopiedFile(src, dst)) copiedEnvFiles.push(rel);
    } catch {
      // Non-fatal — process env may still satisfy runtime needs.
    }
  }

  let gitignoreUpdated = false;
  const gitignorePath = path.join(worktreePath, '.gitignore');
  try {
    const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
    if (!existing.includes('progress.txt')) {
      fs.appendFileSync(gitignorePath, RUN_TRACKING_PATTERNS);
      gitignoreUpdated = true;
    }
  } catch {
    // Non-fatal — worktree can still execute without gitignore hygiene.
  }
  return { linkedDirs, copiedEnvFiles, gitignoreUpdated };
}

/**
 * Idempotently restore canonical runtime support in a story worktree.
 *
 * Agents may churn `npm install` inside a worktree, replacing the provisioned
 * node_modules symlink with a real (often partial, platform-wrong) directory.
 * Before any host validation the engine repairs this so builds run against the
 * canonical workspace dependency tree. A non-conforming directory is renamed
 * aside (never deleted) so agent-created artifacts remain inspectable.
 */
export function repairWorktreeRuntimeSupport(
  workspacePath: string,
  worktreePath: string,
): WorktreeRuntimeRepairResult {
  const verifiedDirs: string[] = [];
  const repairedDirs: string[] = [];
  const failures: string[] = [];

  for (const rel of WORKTREE_NODE_MODULE_DIRS) {
    const src = path.join(workspacePath, rel);
    const dst = path.join(worktreePath, rel);
    if (!fs.existsSync(src)) {
      failures.push(`${rel}: workspace source missing`);
      continue;
    }
    try {
      let link: string | null = null;
      try { link = fs.readlinkSync(dst); } catch { /* absent or real directory */ }
      const isCorrectLink = link !== null
        && path.resolve(path.dirname(dst), link) === path.resolve(src);
      if (isCorrectLink) {
        verifiedDirs.push(rel);
        continue;
      }
      if (link !== null || fs.existsSync(dst)) {
        const backup = `${dst}.agent-churn-backup-${Date.now()}`;
        fs.renameSync(dst, backup);
        repairedDirs.push(`${rel} (backed up to ${path.basename(backup)})`);
      } else {
        repairedDirs.push(rel);
      }
      ensureParentDir(dst);
      fs.symlinkSync(src, dst, 'dir');
    } catch (error) {
      failures.push(`${rel}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const gitignorePath = path.join(worktreePath, '.gitignore');
  try {
    const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
    if (!existing.includes('.rorca-runtime-backup-')) {
      fs.appendFileSync(gitignorePath, RUNTIME_BACKUP_GITIGNORE_PATTERN);
    }
  } catch {
    // Non-fatal — backups are inspectable artifacts even if gitignore hygiene fails.
  }

  return { verifiedDirs, repairedDirs, failures };
}
