/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, Request, Response } from 'express';
import simpleGit from 'simple-git';
import fs from 'fs';
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
function isExistingGitWorktree(wtPath: string): boolean {
  return fs.existsSync(path.join(wtPath, '.git'));
}

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
    try {
      await git.raw(['worktree', 'prune']);
    } catch {
      // Non-fatal: list can still be parsed and stale paths filtered below.
    }
    const output = await git.raw(['worktree', 'list', '--porcelain']);
    const worktrees = parsePorcelain(output).filter((wt) => isExistingGitWorktree(wt.path));

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

/**
 * @swagger
 * /api/worktrees/merge/preview:
 *   post:
 *     tags: [Worktrees]
 *     summary: Retired canonical-workspace merge preview
 *     operationId: previewWorktreeMerge
 *     description: Retired. Exact release integration previews/merges only in the immutable isolated release checkout.
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
 *       409: { description: Canonical release intent is required }
 */
router.post('/merge/preview', (_req: Request, res: Response) => {
  res.status(409).json({
    error: 'RELEASE_INTENT_REQUIRED',
    message: 'Canonical-workspace merge preview is retired; release integration uses an isolated exact-intent checkout.',
  });
});

/**
 * @swagger
 * /api/worktrees/merge:
 *   post:
 *     tags: [Worktrees]
 *     summary: Retired arbitrary worktree merge actuator
 *     operationId: mergeWorktree
 *     description: Retired. Final base integration requires an immutable run release intent and the canonical release reconciler.
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
 *       409: { description: Canonical release intent is required }
 */
router.post('/merge', (_req: Request, res: Response) => {
  res.status(409).json({
    error: 'RELEASE_INTENT_REQUIRED',
    message: 'Arbitrary worktree merge is retired; use the canonical run release reconciler.',
  });
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

    const workspaceGit = simpleGit(workspace.path);
    try {
      await workspaceGit.raw(['worktree', 'prune']);
    } catch {
      // Non-fatal: validation below still protects callers from stale paths.
    }

    const listed = parsePorcelain(await workspaceGit.raw(['worktree', 'list', '--porcelain']));
    const normalizedRequested = path.resolve(worktreePath);
    const listedWorktree = listed.find((wt) => path.resolve(wt.path) === normalizedRequested);

    if (!listedWorktree || !isExistingGitWorktree(listedWorktree.path)) {
      throw new NotFoundError('Worktree path is stale or no longer exists');
    }

    const git = simpleGit(listedWorktree.path);
    const status = await git.status();

    res.json({
      branch: status.current,
      ahead: status.ahead,
      behind: status.behind,
      isClean: status.isClean(),
      modifiedFiles: status.modified,
    });
  } catch (error: any) {
    if (error.message?.includes('not a git repository')) {
      handleRouteError(res, new NotFoundError('Worktree path is stale or no longer a git repository'), '[Worktrees] Status');
      return;
    }
    handleRouteError(res, error, '[Worktrees] Status');
  }
});

export default router;
