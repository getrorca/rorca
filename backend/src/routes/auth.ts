/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, Request, Response } from 'express';
import { generateCsrfToken, setCsrfCookie } from '../lib/csrf';
import { authRequired, LOCAL_ADMIN } from '../lib/auth-utils';
import { getEffectiveUser } from '../lib/get-user';

const router = Router();

/**
 * @swagger
 * /api/auth/csrf-token:
 *   get:
 *     tags: [Auth]
 *     summary: Issue a browser CSRF token
 *     description: Browser-only local session bootstrap. This sensitive auth route is intentionally default-denied from native and MCP contract exposure.
 *     x-rorca-mcp: false
 *     responses:
 *       200: { description: CSRF token and matching secure cookie issued }
 */
router.get('/csrf-token', (_req: Request, res: Response) => {
  const token = generateCsrfToken();
  setCsrfCookie(res, token);
  res.json({ token });
});

/**
 * @swagger
 * /api/auth/me:
 *   get:
 *     tags: [Auth]
 *     summary: Read the current browser session principal
 *     description: Sensitive browser-session identity route; intentionally default-denied from native and MCP contract exposure.
 *     x-rorca-mcp: false
 *     responses:
 *       200: { description: Current effective user }
 *       401: { description: Authentication required }
 */
router.get('/me', authRequired, async (req: Request, res: Response) => {
  const user = await getEffectiveUser(req);
  res.json({ user: user ?? LOCAL_ADMIN });
});

/**
 * @swagger
 * /api/auth/resend-verification:
 *   post:
 *     tags: [Auth]
 *     summary: Acknowledge the local-OSS verification compatibility action
 *     description: Sensitive auth compatibility route; intentionally default-denied from native and MCP contract exposure.
 *     x-rorca-mcp: false
 *     responses:
 *       200: { description: Local-OSS compatibility acknowledgement }
 */
router.post('/resend-verification', (_req: Request, res: Response) => {
  res.json({ ok: true, mode: 'local-oss' });
});

export default router;
