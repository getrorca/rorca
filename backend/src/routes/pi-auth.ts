/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authRequired } from '../lib/auth-utils';
import { handleRouteError } from '../lib/async-handler';
import { ValidationError } from '../lib/errors';
import {
  getPiAuthFilePath,
  isSupportedPiApiKeyProvider,
  listPiApiKeyProviderStatuses,
  removePiApiKeyProvider,
  upsertPiApiKeyProvider,
} from '../lib/pi-auth';

const router = Router();

const SavePiProviderSchema = z.object({
  apiKey: z.string().min(1),
});

router.use(authRequired);

/**
 * @swagger
 * /api/pi/auth/providers:
 *   get:
 *     tags: [Pi]
 *     summary: List Pi API-key provider auth status
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "User-owned local Pi provider authentication state. Safe to read for the authenticated local operator."
 *     responses:
 *       200:
 *         description: Provider auth statuses
 */
router.get('/providers', async (_req: Request, res: Response) => {
  try {
    res.json({
      authFilePath: getPiAuthFilePath(),
      providers: listPiApiKeyProviderStatuses(),
    });
  } catch (error) {
    handleRouteError(res, error, '[PiAuth] List providers');
  }
});

/**
 * @swagger
 * /api/pi/auth/providers/{provider}:
 *   put:
 *     tags: [Pi]
 *     summary: Save a Pi API-key provider credential
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Writes the local user's Pi auth.json entry for an API-key-backed provider. Restricted to authenticated local settings management."
 *     parameters:
 *       - in: path
 *         name: provider
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Saved }
 */
router.put('/providers/:provider', async (req: Request, res: Response) => {
  try {
    const provider = String(req.params.provider || '').trim();
    if (!isSupportedPiApiKeyProvider(provider)) {
      throw new ValidationError(`Unsupported Pi provider: ${provider}`);
    }

    const parsed = SavePiProviderSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid request body', { issues: JSON.stringify(parsed.error.issues) });
    }

    const status = upsertPiApiKeyProvider(provider, parsed.data.apiKey);
    res.json({ ok: true, provider: status, authFilePath: getPiAuthFilePath() });
  } catch (error) {
    handleRouteError(res, error, '[PiAuth] Save provider');
  }
});

/**
 * @swagger
 * /api/pi/auth/providers/{provider}:
 *   delete:
 *     tags: [Pi]
 *     summary: Remove a Pi API-key provider credential
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Deletes the local user's Pi auth.json entry for an API-key-backed provider. Restricted to authenticated local settings management."
 *     parameters:
 *       - in: path
 *         name: provider
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Removed }
 */
router.delete('/providers/:provider', async (req: Request, res: Response) => {
  try {
    const provider = String(req.params.provider || '').trim();
    if (!isSupportedPiApiKeyProvider(provider)) {
      throw new ValidationError(`Unsupported Pi provider: ${provider}`);
    }

    const status = removePiApiKeyProvider(provider);
    res.json({ ok: true, provider: status, authFilePath: getPiAuthFilePath() });
  } catch (error) {
    handleRouteError(res, error, '[PiAuth] Remove provider');
  }
});

export default router;
