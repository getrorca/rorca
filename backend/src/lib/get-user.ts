import { Request } from 'express';
import { queryOne } from '../db/index';
import type { AuthUser } from '../routes/auth';

/**
 * Auth is intentionally bypassed globally (single-user local tool).
 * Fall back to the first registered user when req.user is undefined.
 */
export async function getEffectiveUser(req: Request): Promise<AuthUser | null> {
  const user = (req as Request & { user: AuthUser }).user;
  if (user) return user;
  return (await queryOne<AuthUser>('SELECT id, email FROM users LIMIT 1', [])) ?? null;
}
