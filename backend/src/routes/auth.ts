import { Router, type Request, type Response } from 'express';
import { queryOne } from '../db/index';
import { generateCsrfToken, setCsrfCookie } from '../lib/csrf';
import { LOCAL_ADMIN, authRequired, requireAuth, INTERNAL_SERVICE_TOKEN, type AuthUser } from '../lib/auth-middleware';
import { encryptToken, decryptToken } from '../lib/token-crypto';

const router = Router();

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  github_id: string | null;
  email_verified_at: string | null;
  plan?: string | null;
}

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
 *     description: Returns the profile of the currently authenticated user, including GitHub connection status.
 *     responses:
 *       200:
 *         description: Current user info
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
 *                     displayName: { type: string }
 *                     githubConnected: { type: boolean }
 *       401: { description: "Not authenticated" }
 */
router.get('/me', async (req: Request, res: Response) => {
  const authReq = req as Request & { user?: AuthUser };
  const fallbackUser = authReq.user?.id
    ? undefined
    : await queryOne<{ id: string }>('SELECT id FROM users LIMIT 1');
  const userId = authReq.user?.id ?? fallbackUser?.id;

  if (!userId) {
    if (process.env.AUTH_REQUIRED !== 'true') {
      res.json({ user: LOCAL_ADMIN });
      return;
    }
    res.status(401).json({ error: 'No user configured' });
    return;
  }

  const user = await queryOne<UserRow>(
    'SELECT id, email, display_name, github_id, email_verified_at, plan FROM users WHERE id = $1',
    [userId]
  );

  if (!user) {
    res.status(401).json({ error: 'User not found' });
    return;
  }

  res.json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      githubConnected: !!user.github_id,
      emailVerified: !!user.email_verified_at,
      plan: user.plan || 'free',
    },
  });
});

export default router;

export type { AuthUser };
export { authRequired, requireAuth, INTERNAL_SERVICE_TOKEN, LOCAL_ADMIN, encryptToken, decryptToken };

export function requireRole(..._roles: string[]) {
  return authRequired;
}
