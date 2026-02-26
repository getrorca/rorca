import { Request } from 'express';
import { db } from '../db';
import type { AuthUser } from '../routes/auth';

/**
 * Auth is intentionally bypassed globally (single-user local tool).
 * Fall back to the first registered user when req.user is undefined.
 */
export function getEffectiveUser(req: Request): AuthUser | null {
  const user = (req as Request & { user: AuthUser }).user;
  if (user) return user;
  return db.prepare('SELECT id, email FROM users LIMIT 1').get() as AuthUser | null;
}
