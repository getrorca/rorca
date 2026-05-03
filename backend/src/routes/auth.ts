/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { Router, Request, Response } from 'express';
import { generateCsrfToken, setCsrfCookie } from '../lib/csrf';
import { authRequired } from '../lib/auth-utils';
import { getEffectiveUser } from '../lib/get-user';
import { supabaseAdmin } from '../lib/supabase';
import { sendVerificationEmail } from '../lib/email';

const router = Router();

/**
 * @swagger
 * /api/auth/csrf-token:
 *   get:
 *     tags: [Auth]
 *     summary: Get a CSRF token
 *     operationId: getCsrfToken
 *     description: Generates a CSRF token, stores it in an HttpOnly cookie, and returns the same token for double-submit validation.
 *     security: []
 *     responses:
 *       200:
 *         description: CSRF token issued
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [token]
 *               properties:
 *                 token:
 *                   type: string
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
 *     summary: Get current authenticated user
 *     operationId: getCurrentUser
 *     description: Returns the authenticated user populated from the Supabase JWT middleware.
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Current user profile
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     email: { type: string }
 *                     supabaseId: { type: string }
 *                     role: { type: string }
 *                     plan: { type: string, nullable: true }
 *       401:
 *         description: Authentication required
 */
router.get('/me', authRequired, async (req: Request, res: Response) => {
  const user = await getEffectiveUser(req);
  res.json({ user });
});

/**
 * @swagger
 * /api/auth/resend-verification:
 *   post:
 *     tags: [Auth]
 *     summary: Resend email verification
 *     operationId: resendVerification
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email:
 *                 type: string
 *     responses:
 *       200:
 *         description: Verification email sent
 *       400:
 *         description: Invalid request
 */
router.post('/resend-verification', async (req: Request, res: Response): Promise<void> => {
  const { email } = req.body ?? {};

  if (!email || typeof email !== 'string') {
    res.status(400).json({ error: 'Email is required' });
    return;
  }

  try {
    // Generate a new email OTP link via Supabase Admin
    // Use magiclink type — generates a one-time verification link without requiring a password
    const { data, error } = await supabaseAdmin.auth.admin.generateLink({
      type: 'magiclink',
      email: email.trim(),
    });

    if (error || !data?.properties?.action_link) {
      // Return 200 regardless to avoid email enumeration
      res.json({ ok: true });
      return;
    }

    await sendVerificationEmail(email.trim(), data.properties.action_link);
    res.json({ ok: true });
  } catch (err) {
    console.error('[auth] resend-verification error:', err);
    // Return 200 to avoid leaking whether the email exists
    res.json({ ok: true });
  }
});

export default router;
