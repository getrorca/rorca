import { Request } from 'express';
import { queryOne } from '../db/index';
import type { AuthUser } from '../routes/auth';

/**
 * Auth is intentionally bypassed globally (single-user local tool).
 * Fall back to the first registered user when req.user is undefined.
 */
export async function getEffectiveUser(req: Request): Promise<AuthUser | null> {
  if (req.user) {
    return { id: req.user.id, email: req.user.email, supabaseId: req.user.supabaseId, role: req.user.role ?? 'admin', plan: req.user.plan };
  }
  return (await queryOne<AuthUser>('SELECT id, email FROM users LIMIT 1', [])) ?? null;
}
