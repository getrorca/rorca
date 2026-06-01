/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * file-watch.ts — CIE-009: File watcher status endpoint.
 *
 * GET /api/workspace/file-watch-status
 * Returns watcher health and watched file list per workspace.
 */

import { Router } from 'express';
import { getFileWatchStatus } from '../lib/file-watcher';

const router = Router();

/**
 * @swagger
 * /api/workspace/file-watch-status:
 *   get:
 *     tags: [Workspaces]
 *     summary: Get file watcher health and watched file list
 *     operationId: getFileWatchStatus
 *     description: >
 *       Returns the current state of all file watchers: which workspaces
 *       are being watched, which files are tracked, and whether watchers
 *       are ready. Also lists any paths currently suppressed (being
 *       written by Rorca).
 *     responses:
 *       200:
 *         description: File watcher status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 active:
 *                   type: boolean
 *                   description: Whether any watchers are running
 *                 watchers:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       workspaceId: { type: string }
 *                       workspacePath: { type: string }
 *                       watchedFiles:
 *                         type: array
 *                         items: { type: string }
 *                       ready: { type: boolean }
 *                 suppressedPaths:
 *                   type: array
 *                   items: { type: string }
 */
router.get('/file-watch-status', (_req, res) => {
  const status = getFileWatchStatus();
  res.json(status);
});

export default router;
