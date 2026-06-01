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

export interface WorktreeRuntimeSupportResult {
  linkedDirs: string[];
  copiedEnvFiles: string[];
  gitignoreUpdated: boolean;
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
