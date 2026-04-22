import { type NextFunction, type Request, type Response } from 'express';
import { queryOne } from '../db/index';
import { supabaseAdmin } from './supabase';

export interface AuthUser {
  id: string;
  email: string;
  supabaseId: string;
  role: string;
  plan?: string;
}

export const LOCAL_ADMIN = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'admin@rorca.local',
  supabaseId: '00000000-0000-0000-0000-000000000001',
  displayName: 'Admin',
  role: 'admin' as const,
  plan: 'pro' as const,
  githubConnected: false,
  emailVerified: true,
};

const SUPABASE_AUTH_ENABLED = Boolean(process.env.SUPABASE_URL?.trim());

export const INTERNAL_SERVICE_TOKEN = `rorca-internal-${process.pid}`;

export async function authRequired(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.headers['x-rorca-internal'] === INTERNAL_SERVICE_TOKEN) {
    req.user = {
      id: '00000000-0000-0000-0000-000000000000',
      email: 'scheduler@rorca.internal',
      supabaseId: '00000000-0000-0000-0000-000000000000',
      role: 'admin',
    };
    next();
    return;
  }

  if (!SUPABASE_AUTH_ENABLED) {
    req.user = LOCAL_ADMIN;
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    const user = data.user;
    if (error || !user?.id || !user.email) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    const localUser = await queryOne<{ role: string; plan: string | null }>(
      'SELECT role, plan FROM users WHERE supabase_user_id = $1 OR email = $2 LIMIT 1',
      [user.id, user.email]
    );

    req.user = {
      id: user.id,
      email: user.email,
      supabaseId: user.id,
      role: localUser?.role || 'user',
      plan: localUser?.plan || 'free',
    };

    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

export const requireAuth = authRequired;
