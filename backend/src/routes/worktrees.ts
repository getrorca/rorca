/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { Router, Request, Response } from 'express';
import simpleGit from 'simple-git';
import path from 'path';
import { queryOne } from '../db/index';
import { broadcastAll, type WalEvent } from '../lib/sse-hub';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors';
import { handleRouteError } from '../lib/async-handler';

const router = Router();

// ─── Types ───────────────────────────────────────────────────────────────────

interface GitWorktree {
  path: string;
  branch: string;
  headSha: string;
  isLocked: boolean;
  isBare: boolean;
  addedAt?: string;
}

interface WorkspaceRow {
  id: string;
  label: string;
  path: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getWorkspace(workspaceId: string): Promise<WorkspaceRow | undefined> {
  return await queryOne<WorkspaceRow>('SELECT * FROM workspaces WHERE id = $1', [workspaceId]);
}

async function emitWalEvent(eventType: string, workspaceId: string, payload: Record<string, unknown>): Promise<void> {
  const inserted = await queryOne<WalEvent>(
    'INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ($1, $2, $3) RETURNING *',
    [eventType, workspaceId, JSON.stringify(payload)]
  );

  if (inserted) {
    broadcastAll(inserted);
  }
}

/**
 * Parse `git worktree list --porcelain` output into structured objects.
 *
 * Porcelain format:
 *   worktree /path/to/worktree
 *   HEAD abc123
 *   branch refs/heads/main
 *   <blank line>
 */
function parsePorcelain(output: string): GitWorktree[] {
  const worktrees: GitWorktree[] = [];
  const blocks = output.trim().split('\n\n');

  for (const block of blocks) {
    if (!block.trim()) continue;

    const lines = block.trim().split('\n');
    let wtPath = '';
    let headSha = '';
    let branch = '';
    let isLocked = false;
    let isBare = false;

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        wtPath = line.slice('worktree '.length);
      } else if (line.startsWith('HEAD ')) {
        headSha = line.slice('HEAD '.length);
      } else if (line.startsWith('branch ')) {
        branch = line.slice('branch '.length).replace('refs/heads/', '');
      } else if (line === 'locked') {
        isLocked = true;
      } else if (line === 'bare') {
        isBare = true;
      } else if (line === 'detached') {
        branch = '(detached)';
      }
    }

    if (wtPath) {
      worktrees.push({ path: wtPath, branch, headSha, isLocked, isBare });
    }
  }

  return worktrees;
}

/**
 * @swagger
 * /api/worktrees:
 *   get:
 *     tags: [Worktrees]
 *     summary: List git worktrees for a workspace
 *     operationId: listWorktrees
 *     description: Returns all git worktrees for the specified workspace by parsing porcelain output.
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: List of worktrees
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 worktrees:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/GitWorktree' }
 *       404: { description: "Workspace not found" }
 *   post:
 *     tags: [Worktrees]
 *     summary: Create a new git worktree
 *     operationId: createWorktree
 *     description: Creates a new git worktree with a new branch in the workspace repository.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, branchName]
 *             properties:
 *               workspaceId: { type: string }
 *               branchName: { type: string }
 *               baseBranch: { type: string }
 *               worktreePath: { type: string }
 *     responses:
 *       201:
 *         description: Worktree created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 worktreePath: { type: string }
 *                 branchName: { type: string }
 *       409: { description: "Branch already exists" }
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string;
    if (!workspaceId) {
      throw new ValidationError('Missing required query param: workspaceId');
      return;
    }

    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const git = simpleGit(workspace.path);
    const output = await git.raw(['worktree', 'list', '--porcelain']);
    const worktrees = parsePorcelain(output);

    res.json({ worktrees });
  } catch (error: any) {
    // Xcode license not accepted (common after macOS/Xcode updates) — return empty list
    if (error.message?.includes('Xcode') || error.message?.includes('xcodebuild')) {
      res.json({ worktrees: [], warning: 'Git unavailable: run `sudo xcodebuild -license accept` in your terminal to fix.' });
      return;
    }
    handleRouteError(res, error, '[Worktrees] List');
  }
});

// ─── POST /api/worktrees ────────────────────────────────────────────────────

/**
 * @swagger
 * /api/worktrees:
 *   post:
 *     tags: [Worktrees]
 *     summary: Create a new git worktree
 *     operationId: createWorktree
 *     description: >
 *       Creates a new git worktree branch in the specified workspace repository.
 *       Worktrees enable parallel spec execution without branch conflicts — each
 *       story run can be isolated in its own worktree. The branch is created from
 *       baseBranch (default: main) and checked out at worktreePath.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, branchName]
 *             properties:
 *               workspaceId:
 *                 type: string
 *                 description: Workspace to create the worktree in
 *                 example: cashflow-ai
 *               branchName:
 *                 type: string
 *                 description: Name of the new branch for the worktree
 *                 example: feat/stripe-billing-1700000000
 *               baseBranch:
 *                 type: string
 *                 description: Base branch to create from (defaults to main)
 *                 example: main
 *               worktreePath:
 *                 type: string
 *                 description: Filesystem path for the worktree (auto-generated if omitted)
 *                 example: /tmp/rorca-worktrees/stripe-billing-1700000000
 *     responses:
 *       201:
 *         description: Worktree created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean, example: true }
 *                 worktreePath:
 *                   type: string
 *                   description: Absolute path to the created worktree
 *                 branchName:
 *                   type: string
 *                   description: Name of the created branch
 *       400:
 *         description: Missing workspaceId or branchName
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Workspace not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       409:
 *         description: Worktree path already exists
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { workspaceId, branchName, baseBranch, worktreePath } = req.body;

    if (!workspaceId || !branchName) {
      throw new ValidationError('Missing required fields: workspaceId, branchName');
      return;
    }

    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const git = simpleGit(workspace.path);

    // Derive worktree path: {workspacePath}/../{repoName}-{branchSlug}
    const repoName = path.basename(workspace.path);
    const branchSlug = branchName.replace(/\//g, '-');
    const targetPath = worktreePath || path.resolve(workspace.path, '..', `${repoName}-${branchSlug}`);

    const base = baseBranch || 'HEAD';

    await git.raw(['worktree', 'add', '-b', branchName, targetPath, base]);

    await emitWalEvent('worktree_created', workspaceId, { branchName, worktreePath: targetPath });

    res.status(201).json({ ok: true, worktreePath: targetPath, branchName });
  } catch (error: any) {
    if (error.message?.includes('already exists')) {
      handleRouteError(res, new ConflictError(error.message), '[Worktrees] Create');
      return;
    }
    handleRouteError(res, error, '[Worktrees] Create');
  }
});

/**
 * @swagger
 * /api/worktrees/{encodedPath}:
 *   delete:
 *     tags: [Worktrees]
 *     summary: Remove a git worktree
 *     operationId: removeWorktree
 *     description: Removes a git worktree by its URL-encoded path, optionally forcing removal of dirty worktrees.
 *     parameters:
 *       - in: path
 *         name: encodedPath
 *         required: true
 *         schema: { type: string }
 *         description: URL-encoded worktree path
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: force
 *         schema: { type: boolean, default: false }
 *     responses:
 *       200: { description: "Removed" }
 *       409: { description: "Worktree has uncommitted changes" }
 */
router.delete('/:encodedPath', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string;
    if (!workspaceId) {
      throw new ValidationError('Missing required query param: workspaceId');
      return;
    }

    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const encodedPath = req.params.encodedPath as string;
    const decodedPath = decodeURIComponent(encodedPath);
    const force = req.query.force === 'true';
    const git = simpleGit(workspace.path);

    const args = ['worktree', 'remove', decodedPath];
    if (force) {
      args.push('--force');
    }

    await git.raw(args);

    await emitWalEvent('worktree_removed', workspaceId, { worktreePath: decodedPath });

    res.json({ ok: true });
  } catch (error: any) {
    if (error.message?.includes('dirty') || error.message?.includes('untracked') || error.message?.includes('modified')) {
      handleRouteError(res, new ConflictError(error.message), '[Worktrees] Remove');
      return;
    }
    handleRouteError(res, error, '[Worktrees] Remove');
  }
});

// ─── Conflict parsing helper ────────────────────────────────────────────────

interface ConflictFile {
  path: string;
  markers: string;
}

/**
 * Parse conflict markers from files in the working directory after a failed merge.
 * Reads each conflicting file and extracts the sections between <<<<<<< and >>>>>>>
 */
async function extractConflictMarkers(git: ReturnType<typeof simpleGit>, repoPath: string, conflictPaths: string[]): Promise<ConflictFile[]> {
  const fs = await import('fs/promises');
  const results: ConflictFile[] = [];

  for (const filePath of conflictPaths) {
    const absPath = path.join(repoPath, filePath);
    try {
      const content = await fs.readFile(absPath, 'utf-8');
      // Extract conflict sections (everything between <<<<<<< and >>>>>>>)
      const markers: string[] = [];
      const lines = content.split('\n');
      let inConflict = false;
      let section: string[] = [];

      for (const line of lines) {
        if (line.startsWith('<<<<<<<')) {
          inConflict = true;
          section = [line];
        } else if (line.startsWith('>>>>>>>') && inConflict) {
          section.push(line);
          markers.push(section.join('\n'));
          inConflict = false;
          section = [];
        } else if (inConflict) {
          section.push(line);
        }
      }

      results.push({ path: filePath, markers: markers.join('\n\n---\n\n') || '(conflict markers not found)' });
    } catch {
      results.push({ path: filePath, markers: '(unable to read file)' });
    }
  }

  return results;
}

/**
 * @swagger
 * /api/worktrees/merge/preview:
 *   post:
 *     tags: [Worktrees]
 *     summary: Dry-run merge to detect conflicts
 *     operationId: previewWorktreeMerge
 *     description: Performs a dry-run merge attempt to detect conflicts before actually merging a worktree branch.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, branchName]
 *             properties:
 *               workspaceId: { type: string }
 *               branchName: { type: string }
 *     responses:
 *       200:
 *         description: Merge preview result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 canMerge: { type: boolean }
 *                 hasConflicts: { type: boolean }
 *                 conflictFiles: { type: array, items: { type: object, properties: { path: { type: string }, markers: { type: string } } } }
 *                 filesChanged: { type: number }
 */
router.post('/merge/preview', async (req: Request, res: Response) => {
  try {
    const { workspaceId, branchName } = req.body;

    if (!workspaceId || !branchName) {
      throw new ValidationError('Missing required fields: workspaceId, branchName');
      return;
    }

    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const git = simpleGit(workspace.path);

    // Auto-stash dirty working tree so dry-run merge can proceed
    let stashed = false;
    const statusResult = await git.status();
    if (statusResult.files.length > 0) {
      await git.stash(['push', '--include-untracked', '-m', `rorca-autostash-preview-${branchName}`]);
      stashed = true;
    }

    // Get diff stats to show what would change
    let filesChanged = 0;
    try {
      const diffOutput = await git.raw(['diff', '--stat', `HEAD...${branchName}`]);
      const statLine = diffOutput.trim().split('\n').pop() || '';
      const match = statLine.match(/(\d+)\s+files?\s+changed/);
      filesChanged = match ? parseInt(match[1], 10) : 0;
    } catch {
      // If diff fails (e.g., branch doesn't exist), we'll catch it in the merge attempt below
    }

    // Attempt a dry-run merge using --no-commit --no-ff, then abort
    try {
      await git.merge([branchName, '--no-commit', '--no-ff']);
      // If merge succeeds without conflicts, abort it (dry-run)
      await git.merge(['--abort']);
      if (stashed) { try { await git.stash(['pop']); } catch { /* ignore */ } }
      res.json({ canMerge: true, hasConflicts: false, conflictFiles: [], filesChanged });
    } catch (mergeError: any) {
      if (mergeError.message?.includes('CONFLICT') || mergeError.message?.includes('Automatic merge failed')) {
        // Merge failed with conflicts — extract conflict info before aborting
        let conflictFiles: ConflictFile[] = [];
        try {
          // Get list of unmerged files
          const statusOutput = await git.raw(['diff', '--name-only', '--diff-filter=U']);
          const conflictPaths = statusOutput.trim().split('\n').filter(Boolean);
          conflictFiles = await extractConflictMarkers(git, workspace.path, conflictPaths);
        } catch {
          // Fallback: parse conflict file list from error message
          const conflictMatch = mergeError.message.match(/CONFLICT \([^)]+\): Merge conflict in (.+)/g);
          if (conflictMatch) {
            conflictFiles = conflictMatch.map((line: string) => {
              const fileMatch = line.match(/Merge conflict in (.+)/);
              return { path: fileMatch?.[1] || 'unknown', markers: '' };
            });
          }
        }

        // Always abort the failed merge to restore clean state
        try { await git.merge(['--abort']); } catch { /* already aborted */ }
        if (stashed) { try { await git.stash(['pop']); } catch { /* ignore */ } }

        res.json({ canMerge: false, hasConflicts: true, conflictFiles, filesChanged });
      } else {
        // Non-conflict error — try to abort and propagate
        try { await git.merge(['--abort']); } catch { /* nothing to abort */ }
        if (stashed) { try { await git.stash(['pop']); } catch { /* ignore */ } }
        throw mergeError;
      }
    }
  } catch (error: any) {
    handleRouteError(res, error, '[Worktrees] Merge preview');
  }
});

/**
 * @swagger
 * /api/worktrees/merge:
 *   post:
 *     tags: [Worktrees]
 *     summary: Merge a worktree branch to main
 *     operationId: mergeWorktree
 *     description: Merges a worktree branch into the current branch using --no-ff, with optional force resolution using --theirs strategy.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, branchName]
 *             properties:
 *               workspaceId: { type: string }
 *               branchName: { type: string }
 *               force: { type: boolean, description: "Accept target branch version for all conflicts" }
 *     responses:
 *       200:
 *         description: Merged
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 mergeCommitSha: { type: string }
 *       409:
 *         description: Merge conflict
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 conflict: { type: boolean }
 *                 details: { type: string }
 *                 conflictFiles: { type: array, items: { type: object } }
 */
router.post('/merge', async (req: Request, res: Response) => {
  try {
    const { workspaceId, branchName, force } = req.body;

    if (!workspaceId || !branchName) {
      throw new ValidationError('Missing required fields: workspaceId, branchName');
      return;
    }

    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const git = simpleGit(workspace.path);

    // Auto-stash any uncommitted local changes so the merge can proceed cleanly
    let stashed = false;
    const statusResult = await git.status();
    const hasDirtyWorkingTree = statusResult.files.length > 0;
    if (hasDirtyWorkingTree) {
      await git.stash(['push', '--include-untracked', '-m', `rorca-autostash-before-merge-${branchName}`]);
      stashed = true;
    }

    try {
      if (force) {
        // Force merge: use -X theirs to auto-resolve conflicts in favor of the incoming branch
        try {
          await git.merge([branchName, '--no-ff', '-X', 'theirs']);
        } catch (mergeError: any) {
          // Even -X theirs can fail on delete/modify conflicts; handle those
          if (mergeError.message?.includes('CONFLICT')) {
            try { await git.merge(['--abort']); } catch { /* already clean */ }
            // NOTE: intentional raw res.status — carries { conflict: true, conflictFiles } for client UI; ConflictError lacks this shape.
            res.status(409).json({ conflict: true, details: mergeError.message, conflictFiles: [] }); // intentional: merge-conflict structured response
            return;
          }
          throw mergeError;
        }
      } else {
        try {
          await git.merge([branchName, '--no-ff']);
        } catch (mergeError: any) {
          if (mergeError.message?.includes('CONFLICT') || mergeError.message?.includes('Automatic merge failed')) {
            // Extract conflict file list before aborting
            let conflictFiles: ConflictFile[] = [];
            try {
              const statusOutput = await git.raw(['diff', '--name-only', '--diff-filter=U']);
              const conflictPaths = statusOutput.trim().split('\n').filter(Boolean);
              conflictFiles = await extractConflictMarkers(git, workspace.path, conflictPaths);
            } catch { /* fallback without conflict details */ }

            try { await git.merge(['--abort']); } catch { /* already aborted */ }

            // NOTE: intentional raw res.status — carries { conflict: true, conflictFiles } for client UI; ConflictError lacks this shape.
            res.status(409).json({ conflict: true, details: mergeError.message, conflictFiles }); // intentional: merge-conflict structured response
            return;
          }
          throw mergeError;
        }
      }
    } finally {
      // Always restore stashed changes after merge attempt (success or failure)
      if (stashed) {
        try {
          await git.stash(['pop']);
        } catch {
          // Stash pop can conflict with merged files — not fatal, user can resolve
        }
      }
    }

    // Get the merge commit SHA
    const logOutput = await git.raw(['rev-parse', 'HEAD']);
    const mergeCommitSha = logOutput.trim();

    await emitWalEvent('worktree_merged', workspaceId, { branchName, mergeCommitSha });

    res.json({ ok: true, mergeCommitSha, stashedAndRestored: stashed });
  } catch (error: any) {
    handleRouteError(res, error, '[Worktrees] Merge');
  }
});

/**
 * @swagger
 * /api/worktrees/status:
 *   get:
 *     tags: [Worktrees]
 *     summary: Get worktree branch status
 *     operationId: getWorktreeStatus
 *     description: Returns the git status of a specific worktree including branch name, ahead/behind counts, and modified files.
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: path
 *         required: true
 *         schema: { type: string }
 *         description: Worktree path
 *     responses:
 *       200:
 *         description: Branch status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 branch: { type: string }
 *                 ahead: { type: integer }
 *                 behind: { type: integer }
 *                 isClean: { type: boolean }
 *                 modifiedFiles: { type: array, items: { type: string } }
 */
router.get('/status', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string;
    const worktreePath = req.query.path as string;

    if (!workspaceId || !worktreePath) {
      throw new ValidationError('Missing required query params: workspaceId, path');
      return;
    }

    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const git = simpleGit(worktreePath);
    const status = await git.status();

    res.json({
      branch: status.current,
      ahead: status.ahead,
      behind: status.behind,
      isClean: status.isClean(),
      modifiedFiles: status.modified,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Worktrees] Status');
  }
});

export default router;
