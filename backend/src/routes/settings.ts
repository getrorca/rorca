import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query, queryOne, execute } from '../db/index';
import { validateBody } from '../lib/validate';
import { getEffectiveUser } from '../lib/get-user';
import { ForbiddenError, NotFoundError, ValidationError } from '../lib/errors';

const router = Router();

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
}

interface UserSettingsRow {
  user_id: string;
  default_model: string;
  items_per_page: number;
  reasoning_defaults: ReasoningDefaults | null;
  updated_at: string;
}

interface ReasoningModelDefault {
  effort: string;
  override: 'auto' | 'force-on' | 'force-off';
}

interface ReasoningDefaults {
  globalAutoEnable: boolean;
  models: Record<string, ReasoningModelDefault>;
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

  const row = await queryOne<UserRow>(
    'SELECT id, email, display_name, avatar_url FROM users WHERE id = $1',
    [user.id],
  );

  if (!row) {
    throw new NotFoundError('User not found');
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
    throw new ValidationError('No fields to update');
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
  res.status(410).json({ error: 'Password changes are handled by Supabase auth.' });
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

  const defaultReasoningDefaults: ReasoningDefaults = { globalAutoEnable: false, models: {} };

  res.json({
    defaultModel: row?.default_model ?? 'claude-sonnet-4-5-20250929',
    itemsPerPage: row?.items_per_page ?? 20,
    reasoningDefaults: row?.reasoning_defaults ?? defaultReasoningDefaults,
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
  const { defaultModel, itemsPerPage, reasoningDefaults } = req.body;

  const model = typeof defaultModel === 'string' ? defaultModel.trim() : 'claude-sonnet-4-5-20250929';
  const perPage = typeof itemsPerPage === 'number' && itemsPerPage >= 5 && itemsPerPage <= 100
    ? Math.round(itemsPerPage)
    : 20;

  // Validate and sanitize reasoningDefaults
  const defaultRd: ReasoningDefaults = { globalAutoEnable: false, models: {} };
  let rd: ReasoningDefaults = defaultRd;
  if (reasoningDefaults && typeof reasoningDefaults === 'object') {
    rd = {
      globalAutoEnable: reasoningDefaults.globalAutoEnable === true,
      models: {},
    };
    if (reasoningDefaults.models && typeof reasoningDefaults.models === 'object') {
      for (const [modelId, v] of Object.entries(reasoningDefaults.models)) {
        if (v && typeof v === 'object') {
          const entry = v as Record<string, unknown>;
          const effort = typeof entry.effort === 'string' ? entry.effort : 'medium';
          const override = ['auto', 'force-on', 'force-off'].includes(entry.override as string)
            ? (entry.override as ReasoningModelDefault['override'])
            : 'auto';
          rd.models[modelId] = { effort, override };
        }
      }
    }
  }

  await execute(
    `INSERT INTO user_settings (user_id, default_model, items_per_page, reasoning_defaults, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT(user_id) DO UPDATE SET
       default_model = excluded.default_model,
       items_per_page = excluded.items_per_page,
       reasoning_defaults = excluded.reasoning_defaults,
       updated_at = excluded.updated_at`,
    [user.id, model, perPage, JSON.stringify(rd)],
  );

  res.json({ ok: true, defaultModel: model, itemsPerPage: perPage, reasoningDefaults: rd });
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
 *                   description: "Deprecated — kept for backwards compatibility. Use queue_max_concurrent and run_now_max_concurrent instead."
 *                 queue_max_concurrent:
 *                   type: integer
 *                   minimum: 1
 *                   maximum: 10
 *                   example: 1
 *                   description: "Max concurrent queued (non-worktree) pipeline:run jobs"
 *                 run_now_max_concurrent:
 *                   type: integer
 *                   minimum: 1
 *                   maximum: 10
 *                   example: 3
 *                   description: "Max concurrent immediate worktree-isolated runs"
 */
router.get('/worker', async (_req: Request, res: Response) => {
  const rows = await query<WorkerSettingRow>(
    "SELECT key, value FROM worker_settings WHERE key IN ('max_concurrent_runs', 'queue_max_concurrent', 'run_now_max_concurrent')",
  );
  const settings = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const max_concurrent_runs = settings['max_concurrent_runs'] ? parseInt(settings['max_concurrent_runs'], 10) : 3;
  const queue_max_concurrent = settings['queue_max_concurrent'] ? parseInt(settings['queue_max_concurrent'], 10) : 1;
  const run_now_max_concurrent = settings['run_now_max_concurrent'] ? parseInt(settings['run_now_max_concurrent'], 10) : 3;
  res.json({ max_concurrent_runs, queue_max_concurrent, run_now_max_concurrent });
});

/**
 * @swagger
 * /api/settings/worker:
 *   put:
 *     tags: [Settings]
 *     summary: Update worker settings
 *     operationId: updateWorkerSettings
 *     description: Persists configurable worker parameters to the database. Changes take effect on the next worker poll cycle (~30s).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               max_concurrent_runs:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 10
 *                 example: 3
 *                 description: "Deprecated — kept for backwards compatibility"
 *               queue_max_concurrent:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 10
 *                 example: 1
 *                 description: "Max concurrent queued (non-worktree) pipeline:run jobs"
 *               run_now_max_concurrent:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 10
 *                 example: 3
 *                 description: "Max concurrent immediate worktree-isolated runs"
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
 *                 queue_max_concurrent:
 *                   type: integer
 *                 run_now_max_concurrent:
 *                   type: integer
 *       422:
 *         description: Value out of range (must be 1–10)
 */
const WorkerSettingsSchema = z.object({
  max_concurrent_runs: z
    .number()
    .int('max_concurrent_runs must be an integer')
    .min(1, 'max_concurrent_runs must be at least 1')
    .max(10, 'max_concurrent_runs must be at most 10')
    .optional(),
  queue_max_concurrent: z
    .number()
    .int('queue_max_concurrent must be an integer')
    .min(1, 'queue_max_concurrent must be at least 1')
    .max(5, 'queue_max_concurrent must be at most 5')
    .optional(),
  run_now_max_concurrent: z
    .number()
    .int('run_now_max_concurrent must be an integer')
    .min(1, 'run_now_max_concurrent must be at least 1')
    .max(10, 'run_now_max_concurrent must be at most 10')
    .optional(),
}).refine(
  data => data.max_concurrent_runs !== undefined || data.queue_max_concurrent !== undefined || data.run_now_max_concurrent !== undefined,
  { message: 'At least one setting must be provided' },
);

router.put('/worker', validateBody(WorkerSettingsSchema), async (req: Request, res: Response) => {
  const { max_concurrent_runs, queue_max_concurrent, run_now_max_concurrent } = req.body as z.infer<typeof WorkerSettingsSchema>;

  const upsert = async (key: string, value: number) => {
    await execute(
      `INSERT INTO worker_settings (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, String(value)],
    );
  };

  if (max_concurrent_runs !== undefined) await upsert('max_concurrent_runs', max_concurrent_runs);
  if (queue_max_concurrent !== undefined) await upsert('queue_max_concurrent', queue_max_concurrent);
  if (run_now_max_concurrent !== undefined) await upsert('run_now_max_concurrent', run_now_max_concurrent);

  // Return current state of all settings
  const rows = await query<WorkerSettingRow>(
    "SELECT key, value FROM worker_settings WHERE key IN ('max_concurrent_runs', 'queue_max_concurrent', 'run_now_max_concurrent')",
  );
  const settings = Object.fromEntries(rows.map(r => [r.key, r.value]));
  res.json({
    max_concurrent_runs: settings['max_concurrent_runs'] ? parseInt(settings['max_concurrent_runs'], 10) : 3,
    queue_max_concurrent: settings['queue_max_concurrent'] ? parseInt(settings['queue_max_concurrent'], 10) : 1,
    run_now_max_concurrent: settings['run_now_max_concurrent'] ? parseInt(settings['run_now_max_concurrent'], 10) : 3,
  });
});

export default router;
