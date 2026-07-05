/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { queryOne } from '../db/index';
import { NotFoundError, ValidationError } from '../lib/errors';

const router = Router();

type WorkspaceRow = {
  id: string;
  label: string;
  path: string;
};

function assertString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${name} is required`);
  }
  return value;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertInsideWorkspace(workspacePath: string, candidatePath: string, name: string): void {
  if (!isInside(workspacePath, candidatePath)) {
    throw new ValidationError(`${name} must be inside the workspace path`, { workspacePath, candidatePath });
  }
}

/**
 * @swagger
 * /api/context-capture/bootstrap/verify:
 *   post:
 *     tags: [Context Capture]
 *     summary: Verify always-on capture bootstrap inputs
 *     operationId: verifyContextCaptureBootstrap
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Capture bootstrap verification reads user-owned workspace registration and local filesystem paths before an explicit setup action mutates reversible workspace files."
 *     description: Validates workspace registration, repository path, and planned capture queue/redaction/ignore paths for the explicit always-on capture setup command. This endpoint performs verification only; it does not install hooks or modify shell/editor configuration.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, workspacePath, queuePath, redactionConfigPath, captureIgnorePath]
 *             properties:
 *               workspaceId: { type: string }
 *               workspacePath: { type: string }
 *               queuePath: { type: string }
 *               redactionConfigPath: { type: string }
 *               captureIgnorePath: { type: string }
 *     responses:
 *       200:
 *         description: Bootstrap inputs verified
 *       400: { description: Invalid bootstrap input }
 *       404: { description: Workspace not found }
 */
router.post('/bootstrap/verify', async (req, res, next) => {
  try {
    const workspaceId = assertString(req.body.workspaceId, 'workspaceId');
    const workspacePath = path.resolve(assertString(req.body.workspacePath, 'workspacePath'));
    const queuePath = path.resolve(assertString(req.body.queuePath, 'queuePath'));
    const redactionConfigPath = path.resolve(assertString(req.body.redactionConfigPath, 'redactionConfigPath'));
    const captureIgnorePath = path.resolve(assertString(req.body.captureIgnorePath, 'captureIgnorePath'));

    const workspace = await queryOne<WorkspaceRow>('SELECT id, label, path FROM workspaces WHERE id = $1', [workspaceId]);
    if (!workspace) {
      throw new NotFoundError('Workspace', workspaceId);
    }

    const registeredPath = path.resolve(workspace.path);
    if (registeredPath !== workspacePath) {
      throw new ValidationError('workspacePath does not match registered workspace path', {
        registeredPath,
        workspacePath,
      });
    }

    if (!fs.existsSync(registeredPath)) {
      throw new ValidationError('Registered workspace path does not exist', { registeredPath });
    }

    assertInsideWorkspace(registeredPath, queuePath, 'queuePath');
    assertInsideWorkspace(registeredPath, redactionConfigPath, 'redactionConfigPath');
    assertInsideWorkspace(registeredPath, captureIgnorePath, 'captureIgnorePath');

    res.json({
      ok: true,
      workspace,
      checks: [
        { id: 'workspace-registration', ok: true, message: 'Workspace is registered', path: registeredPath },
        { id: 'repo-path', ok: true, message: 'Workspace path exists', path: registeredPath },
        { id: 'queue-path', ok: true, message: 'Capture queue path is workspace-scoped', path: queuePath },
        { id: 'redaction-config', ok: true, message: 'Redaction config path is workspace-scoped', path: redactionConfigPath },
        { id: 'capture-ignore', ok: true, message: '.rorca-captureignore path is workspace-scoped', path: captureIgnorePath },
      ],
    });
  } catch (err) {
    next(err);
  }
});

export default router;
