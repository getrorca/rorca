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
import { DEFAULT_CAPTURE_POLICY, sanitizeCapturePayload } from '../lib/context-safety';

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

function captureCapability() {
  return {
    overall: 'active',
    sources: {
      repoDaemon: { status: 'active' },
      gitHook: { status: 'active' },
      shellIntegration: { status: 'active' },
      vscodeExtension: {
        status: 'degraded',
        reason: 'extension_host_optional',
        fallbackSources: ['repoDaemon', 'gitHook', 'shellIntegration', 'mcpSlashCommand'],
      },
      mcpSlashCommand: { status: 'active' },
    },
    policy: {
      version: DEFAULT_CAPTURE_POLICY.version,
      rawContentDefault: DEFAULT_CAPTURE_POLICY.rawContentDefault,
      maxStringBytes: DEFAULT_CAPTURE_POLICY.maxStringBytes,
      maxPayloadBytes: DEFAULT_CAPTURE_POLICY.maxPayloadBytes,
      hashAlgorithm: DEFAULT_CAPTURE_POLICY.hashAlgorithm,
    },
  };
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

/**
 * @swagger
 * /api/context-capture/events:
 *   post:
 *     tags: [Context Capture]
 *     summary: Submit a redacted context capture event
 *     operationId: submitContextCaptureEvent
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Context capture events are user-owned local workspace telemetry; ingestion is callable by local sidecars but still requires the local auth boundary."
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, source, occurredAt, payload]
 *             properties:
 *               workspaceId: { type: string }
 *               source: { type: string }
 *               occurredAt: { type: string }
 *               payload: { type: object }
 *     responses:
 *       200: { description: Event accepted }
 *       400: { description: Invalid event }
 *       404: { description: Workspace not found }
 */
router.post('/events', async (req, res, next) => {
  try {
    const workspaceId = assertString(req.body.workspaceId, 'workspaceId');
    const source = assertString(req.body.source, 'source');
    const occurredAt = assertString(req.body.occurredAt, 'occurredAt');
    const workspace = await queryOne<WorkspaceRow>('SELECT id, label, path FROM workspaces WHERE id = $1', [workspaceId]);
    if (!workspace) throw new NotFoundError('Workspace', workspaceId);

    const sanitized = sanitizeCapturePayload(req.body.payload ?? {});
    res.json({
      ok: true,
      accepted: true,
      workspaceId,
      source,
      occurredAt,
      safety: sanitized.safety,
      capability: captureCapability(),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/context-capture/capability:
 *   get:
 *     tags: [Context Capture]
 *     summary: Report local context capture capability and policy
 *     operationId: getContextCaptureCapability
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Capability reporting exposes user-owned local capture health and policy with no write side effects."
 *     responses:
 *       200: { description: Capture capability }
 */
router.get('/capability', (_req, res) => {
  res.json({ captureCapability: captureCapability() });
});

export default router;
