import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db';
import type { AuthUser } from './auth';

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

// ─── GET /api/settings/profile ─────────────────────────────────────────────

router.get('/profile', (req: Request, res: Response) => {
  const user = (req as Request & { user: AuthUser }).user;

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

// ─── PUT /api/settings/profile ─────────────────────────────────────────────

router.put('/profile', (req: Request, res: Response) => {
  const user = (req as Request & { user: AuthUser }).user;
  const { displayName, avatarUrl } = req.body;

  if (displayName !== undefined && (typeof displayName !== 'string' || displayName.trim().length === 0)) {
    res.status(400).json({ error: 'displayName must be a non-empty string' });
    return;
  }

  if (avatarUrl !== undefined && avatarUrl !== null && typeof avatarUrl !== 'string') {
    res.status(400).json({ error: 'avatarUrl must be a string or null' });
    return;
  }

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

// ─── PUT /api/settings/password ────────────────────────────────────────────

router.put('/password', (req: Request, res: Response) => {
  const user = (req as Request & { user: AuthUser }).user;
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

// ─── GET /api/settings/display ─────────────────────────────────────────────

router.get('/display', (req: Request, res: Response) => {
  const user = (req as Request & { user: AuthUser }).user;

  const row = db.prepare(
    'SELECT * FROM user_settings WHERE user_id = ?'
  ).get(user.id) as UserSettingsRow | undefined;

  res.json({
    defaultModel: row?.default_model ?? 'claude-sonnet-4-5-20250929',
    itemsPerPage: row?.items_per_page ?? 20,
  });
});

// ─── PUT /api/settings/display ─────────────────────────────────────────────

router.put('/display', (req: Request, res: Response) => {
  const user = (req as Request & { user: AuthUser }).user;
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
