import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { supabaseAdmin } from '../lib/supabase';

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

export const JWT_SECRET = process.env.JWT_SECRET || 'rorca-dev-secret-change-in-production';
const SUPABASE_AUTH_ENABLED = Boolean(process.env.SUPABASE_URL?.trim());
const ENCRYPTION_KEY = crypto.createHash('sha256').update(JWT_SECRET).digest();
const ENCRYPTION_ALGO = 'aes-256-gcm' as const;

export function encryptToken(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGO, ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptToken(encryptedStr: string): string {
  const [ivHex, authTagHex, ciphertextHex] = encryptedStr.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGO, ENCRYPTION_KEY, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}

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

    req.user = {
      id: user.id,
      email: user.email,
      supabaseId: user.id,
      role: 'admin',
    };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

export const requireAuth = authRequired;

export type TeamRole = 'admin' | 'editor' | 'viewer';

const ROLE_HIERARCHY: Record<TeamRole, number> = {
  viewer: 0,
  editor: 1,
  admin: 2,
};

export function requireRole(minRole: TeamRole) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const teamId =
      req.params.teamId ||
      req.params.id ||
      (req.query.teamId as string) ||
      req.body?.teamId;

    if (!teamId) {
      res.status(400).json({ error: 'Team ID is required' });
      return;
    }

    if (user.id === 'system') {
      next();
      return;
    }

    try {
      const { queryOne } = await import('../db/index');
      const membership = await queryOne<{ role: TeamRole }>(
        'SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2',
        [teamId, user.id],
      );

      if (!membership) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      if (ROLE_HIERARCHY[membership.role] < ROLE_HIERARCHY[minRole]) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      next();
    } catch {
      res.status(500).json({ error: 'Failed to verify team permissions' });
    }
  };
}
