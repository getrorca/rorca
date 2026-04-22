import { Router, Request, Response } from 'express';
import { generateCsrfToken, setCsrfCookie } from '../lib/csrf';
import { authRequired } from '../lib/auth-utils';

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
  res.json({ user: req.user ?? null });
});

export default router;
