import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { db } from '../db';
import { validateBody } from '../lib/validate';
import type { AuthUser } from './auth';
import { getEffectiveUser } from '../lib/get-user';

const router = Router();

const BCRYPT_COST = 12;

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  avatar_url: string | null;
}

interface UserSettingsRow {
  user_id: string;
  default_model: string;
  items_per_page: number;
  updated_at: string;
}

/**
 * @swagger
 * /api/settings/profile:
 *   get:
 *     tags: [Settings]
 *     summary: Get user profile
 *     operationId: getUserProfile
 *     description: Returns the current user's profile information including display name, email, and avatar URL.
 *     responses:
 *       200:
 *         description: User profile
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string }
 *                 email: { type: string }
 *                 displayName: { type: string }
 *                 avatarUrl: { type: string, nullable: true }
 *       404:
 *         description: User not found
 *       500:
 *         description: No user configured
 */
router.get('/profile', async (req: Request, res: Response) => {
  const user = await getEffectiveUser(req);
  if (!user) { res.status(500).json({ error: 'No user configured' }); return; }

  const row = db.prepare(
    'SELECT id, email, display_name, avatar_url FROM users WHERE id = ?'
  ).get(user.id) as Omit<UserRow, 'password_hash'> | undefined;

  if (!row) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  res.json({
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
  });
});

/**
 * @swagger
 * /api/settings/profile:
 *   put:
 *     tags: [Settings]
 *     summary: Update user profile
 *     operationId: updateUserProfile
 *     description: Updates the current user's display name and/or avatar URL.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               displayName: { type: string, minLength: 1 }
 *               avatarUrl: { type: string, nullable: true }
 *     responses:
 *       200:
 *         description: Profile updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *       400:
 *         description: Invalid field values or no fields to update
 *       500:
 *         description: No user configured
 */
const ProfileUpdateSchema = z.object({
  displayName: z.string().min(1, 'displayName must be a non-empty string').optional(),
  avatarUrl: z.string().nullable().optional(),
});

router.put('/profile', validateBody(ProfileUpdateSchema), async (req: Request, res: Response) => {
  const user = await getEffectiveUser(req);
  if (!user) { res.status(500).json({ error: 'No user configured' }); return; }
  const { displayName, avatarUrl } = req.body;

  const updates: string[] = [];
  const params: (string | null)[] = [];

  if (displayName !== undefined) {
    updates.push('display_name = ?');
    params.push(displayName.trim());
  }
  if (avatarUrl !== undefined) {
    updates.push('avatar_url = ?');
    params.push(avatarUrl === '' ? null : avatarUrl);
  }

  if (updates.length === 0) {
    res.status(400).json({ error: 'No fields to update' });
    return;
  }

  updates.push("updated_at = datetime('now')");
  params.push(user.id);

  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  res.json({ ok: true });
});

/**
 * @swagger
 * /api/settings/password:
 *   put:
 *     tags: [Settings]
 *     summary: Change user password
 *     operationId: changeUserPassword
 *     description: Changes the current user's password. Requires the current password for verification.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [currentPassword, newPassword]
 *             properties:
 *               currentPassword: { type: string }
 *               newPassword: { type: string, minLength: 6 }
 *     responses:
 *       200:
 *         description: Password changed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *       400:
 *         description: Missing or invalid password fields
 *       403:
 *         description: Current password is incorrect
 *       404:
 *         description: User not found
 *       500:
 *         description: No user configured
 */
router.put('/password', async (req: Request, res: Response) => {
  const user = await getEffectiveUser(req);
  if (!user) { res.status(500).json({ error: 'No user configured' }); return; }
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || typeof currentPassword !== 'string') {
    res.status(400).json({ error: 'currentPassword is required' });
    return;
  }
  if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 6) {
    res.status(400).json({ error: 'newPassword must be at least 6 characters' });
    return;
  }

  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id) as Pick<UserRow, 'password_hash'> | undefined;
  if (!row) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  if (!bcrypt.compareSync(currentPassword, row.password_hash)) {
    res.status(403).json({ error: 'Current password is incorrect' });
    return;
  }

  const hash = bcrypt.hashSync(newPassword, BCRYPT_COST);
  db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").run(hash, user.id);

  res.json({ ok: true });
});

/**
 * @swagger
 * /api/settings/display:
 *   get:
 *     tags: [Settings]
 *     summary: Get display preferences
 *     operationId: getDisplaySettings
 *     description: Returns the current user's display preferences including default model and items per page.
 *     responses:
 *       200:
 *         description: Display settings
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 defaultModel: { type: string }
 *                 itemsPerPage: { type: integer }
 *       500:
 *         description: No user configured
 */
router.get('/display', async (req: Request, res: Response) => {
  const user = await getEffectiveUser(req);
  if (!user) { res.status(500).json({ error: 'No user configured' }); return; }

  const row = db.prepare(
    'SELECT * FROM user_settings WHERE user_id = ?'
  ).get(user.id) as UserSettingsRow | undefined;

  res.json({
    defaultModel: row?.default_model ?? 'claude-sonnet-4-5-20250929',
    itemsPerPage: row?.items_per_page ?? 20,
  });
});

/**
 * @swagger
 * /api/settings/display:
 *   put:
 *     tags: [Settings]
 *     summary: Update display preferences
 *     operationId: updateDisplaySettings
 *     description: Updates the current user's display preferences. Upserts into user_settings table.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               defaultModel: { type: string }
 *               itemsPerPage: { type: integer, minimum: 5, maximum: 100 }
 *     responses:
 *       200:
 *         description: Display settings updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 defaultModel: { type: string }
 *                 itemsPerPage: { type: integer }
 *       500:
 *         description: No user configured
 */
router.put('/display', async (req: Request, res: Response) => {
  const user = await getEffectiveUser(req);
  if (!user) { res.status(500).json({ error: 'No user configured' }); return; }
  const { defaultModel, itemsPerPage } = req.body;

  const model = typeof defaultModel === 'string' ? defaultModel.trim() : 'claude-sonnet-4-5-20250929';
  const perPage = typeof itemsPerPage === 'number' && itemsPerPage >= 5 && itemsPerPage <= 100
    ? Math.round(itemsPerPage)
    : 20;

  db.prepare(`
    INSERT INTO user_settings (user_id, default_model, items_per_page, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      default_model = excluded.default_model,
      items_per_page = excluded.items_per_page,
      updated_at = excluded.updated_at
  `).run(user.id, model, perPage);

  res.json({ ok: true, defaultModel: model, itemsPerPage: perPage });
});

export default router;
