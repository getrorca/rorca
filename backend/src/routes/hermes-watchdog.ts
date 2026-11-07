/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

// ─── Hermes Watchdog Control (HW-002) ───────────────────────────────────────
// Operator surface to register a spec for Hermes-supervised healing. Once
// registered, the watchdog diagnoses run failures, applies fixes, and restarts
// the spec until it completes or the attempt budget is exhausted.

import { Router, type Request, type Response } from 'express';
import { ValidationError } from '../lib/errors';
import { requireHermesAction } from '../lib/hermes-authority';
import {
  registerWatchdogWatch,
  watchdogState,
  stopWatchdogWatch,
} from '../lib/hermes-watchdog';

const router = Router();

function parseBody(req: Request): Record<string, unknown> {
  return typeof req.body === 'object' && req.body !== null ? req.body : {};
}

/**
 * @swagger
 * /api/hermes/watchdog:
 *   post:
 *     summary: Register a spec for Hermes-supervised self-healing
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Local operator control for the Hermes watchdog; never MCP-exposed."
 *     responses:
 *       201: { description: Watch registered }
 */
router.post('/', (req: Request, res: Response) => {
  requireHermesAction(req.hermesAuthority, 'watchdog', 'operator-dispatch');
  const body = parseBody(req);
  const workspaceId = typeof body.workspaceId === 'string' && body.workspaceId.trim() ? body.workspaceId.trim() : null;
  const specPath = typeof body.specPath === 'string' && body.specPath.trim() ? body.specPath.trim() : null;
  const specSlug = typeof body.specSlug === 'string' && body.specSlug.trim() ? body.specSlug.trim() : null;
  if (!workspaceId || !specPath || !specSlug) {
    throw new ValidationError('workspaceId, specPath, and specSlug are required');
  }
  const maxAttempts = typeof body.maxAttempts === 'number' ? Math.min(10, Math.max(1, Math.floor(body.maxAttempts))) : undefined;
  const registration = registerWatchdogWatch({
    workspaceId,
    specPath,
    specSlug,
    maxAttempts,
    authority: req.hermesAuthority!,
  });
  res.status(201).json({ watch: registration });
});

/**
 * @swagger
 * /api/hermes/watchdog:
 *   get:
 *     summary: List active Hermes watchdog watches
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Read-only local operator visibility into watchdog state."
 *     responses:
 *       200: { description: Watch state }
 */
router.get('/', (req: Request, res: Response) => {
  requireHermesAction(req.hermesAuthority, 'subscription', 'service-audit');
  res.json({ watches: watchdogState(req.hermesAuthority!) });
});

/**
 * @swagger
 * /api/hermes/watchdog:
 *   delete:
 *     summary: Stop watching a spec
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Local operator stop control for the Hermes watchdog."
 *     responses:
 *       200: { description: Watch removed }
 */
router.delete('/', (req: Request, res: Response) => {
  requireHermesAction(req.hermesAuthority, 'watchdog', 'operator-dispatch');
  const body = parseBody(req);
  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : '';
  const specSlug = typeof body.specSlug === 'string' ? body.specSlug : '';
  const removed = stopWatchdogWatch(workspaceId, specSlug, req.hermesAuthority!);
  res.json({ removed });
});

export default router;
