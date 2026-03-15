import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { queryOne, execute } from '../db/index';
import { validateBody } from '../lib/validate';
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

  const row = await queryOne<Omit<UserRow, 'password_hash'>>(
    'SELECT id, email, display_name, avatar_url FROM users WHERE id = $1',
    [user.id],
  );

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
  let paramIdx = 0;

  if (displayName !== undefined) {
    paramIdx++;
    updates.push(`display_name = $${paramIdx}`);
    params.push(displayName.trim());
  }
  if (avatarUrl !== undefined) {
    paramIdx++;
    updates.push(`avatar_url = $${paramIdx}`);
    params.push(avatarUrl === '' ? null : avatarUrl);
  }

  if (updates.length === 0) {
    res.status(400).json({ error: 'No fields to update' });
    return;
  }

  updates.push('updated_at = NOW()');
  paramIdx++;
  params.push(user.id);

  await execute(`UPDATE users SET ${updates.join(', ')} WHERE id = $${paramIdx}`, params);

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

  const row = await queryOne<Pick<UserRow, 'password_hash'>>(
    'SELECT password_hash FROM users WHERE id = $1',
    [user.id],
  );
  if (!row) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  if (!bcrypt.compareSync(currentPassword, row.password_hash)) {
    res.status(403).json({ error: 'Current password is incorrect' });
    return;
  }

  const hash = bcrypt.hashSync(newPassword, BCRYPT_COST);
  await execute(
    'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
    [hash, user.id],
  );

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

  const row = await queryOne<UserSettingsRow>(
    'SELECT * FROM user_settings WHERE user_id = $1',
    [user.id],
  );

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

  await execute(
    `INSERT INTO user_settings (user_id, default_model, items_per_page, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT(user_id) DO UPDATE SET
       default_model = excluded.default_model,
       items_per_page = excluded.items_per_page,
       updated_at = excluded.updated_at`,
    [user.id, model, perPage],
  );

  res.json({ ok: true, defaultModel: model, itemsPerPage: perPage });
});

interface WorkerSettingRow {
  key: string;
  value: string;
}

/**
 * @swagger
 * /api/settings/worker:
 *   get:
 *     tags: [Settings]
 *     summary: Get worker settings
 *     operationId: getWorkerSettings
 *     description: Returns configurable worker parameters. These settings persist across backend restarts.
 *     responses:
 *       200:
 *         description: Worker settings
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 max_concurrent_runs:
 *                   type: integer
 *                   minimum: 1
 *                   maximum: 10
 *                   example: 3
 */
router.get('/worker', async (_req: Request, res: Response) => {
  const row = await queryOne<WorkerSettingRow>(
    "SELECT value FROM worker_settings WHERE key = 'max_concurrent_runs'",
  );
  const max_concurrent_runs = row ? parseInt(row.value, 10) : 3;
  res.json({ max_concurrent_runs });
});

/**
 * @swagger
 * /api/settings/worker:
 *   put:
 *     tags: [Settings]
 *     summary: Update worker settings
 *     operationId: updateWorkerSettings
 *     description: Persists configurable worker parameters to the database. Changes take effect on the next worker poll cycle.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [max_concurrent_runs]
 *             properties:
 *               max_concurrent_runs:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 10
 *                 example: 3
 *     responses:
 *       200:
 *         description: Worker settings updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 max_concurrent_runs:
 *                   type: integer
 *       422:
 *         description: max_concurrent_runs out of range (must be 1–10)
 */
const WorkerSettingsSchema = z.object({
  max_concurrent_runs: z
    .number()
    .int('max_concurrent_runs must be an integer')
    .min(1, 'max_concurrent_runs must be at least 1')
    .max(10, 'max_concurrent_runs must be at most 10'),
});

router.put('/worker', validateBody(WorkerSettingsSchema), async (req: Request, res: Response) => {
  const { max_concurrent_runs } = req.body as z.infer<typeof WorkerSettingsSchema>;

  await execute(
    `INSERT INTO worker_settings (key, value, updated_at)
     VALUES ('max_concurrent_runs', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [String(max_concurrent_runs)],
  );

  res.json({ max_concurrent_runs });
});

export default router;
