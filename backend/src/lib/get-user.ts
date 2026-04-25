import { Request } from 'express';
import type { AuthUser } from '../lib/auth-utils';

export async function getEffectiveUser(req: Request): Promise<AuthUser | null> {
  if (req.user) {
    return { id: req.user.id, email: req.user.email, supabaseId: req.user.supabaseId, role: req.user.role ?? 'admin', plan: req.user.plan };
  }
  return null;
}
