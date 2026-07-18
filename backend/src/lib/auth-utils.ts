/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { Request, Response, NextFunction } from 'express';
import crypto, { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';

export interface AuthUser {
  id: string;
  email: string;
  supabaseId: string;
  role: string;
  plan?: string;
}

interface AppUserRow {
  id: string;
  email: string;
  role: string;
  plan: string | null;
}

export const LOCAL_ADMIN = {
  id: 'local-admin',
  email: 'admin@rorca.local',
  supabaseId: '00000000-0000-0000-0000-000000000001',
  displayName: 'Admin',
  role: 'admin' as const,
  plan: 'pro' as const,
  githubConnected: false,
  emailVerified: true,
};

export const JWT_SECRET = process.env.JWT_SECRET || 'rorca-dev-secret-change-in-production';
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

function getDeveloperSuperuserEmails(): Set<string> {
  const configured = (process.env.RORCA_SUPERUSER_EMAILS || process.env.DEV_SUPERUSER_EMAILS || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  return new Set(['admin@rorca.local', ...configured]);
}

function isDeveloperSuperuserEmail(email: string): boolean {
  return getDeveloperSuperuserEmails().has(email.trim().toLowerCase());
}

async function getOrCreateAppUser(authId: string, email: string, emailVerifiedAt?: string | null): Promise<AppUserRow> {
  const { queryOne, execute } = await import('../db/index');

  let appUser = await queryOne<AppUserRow>(
    'SELECT id, email, role, plan FROM users WHERE auth_id = $1',
    [authId],
  );

  const existingDeveloperAdmin = await queryOne<{ id: string }>(
    "SELECT id FROM users WHERE role = 'admin' AND email <> 'admin@rorca.local' LIMIT 1"
  );
  const shouldBeAdmin = isDeveloperSuperuserEmail(email)
    || (process.env.NODE_ENV !== 'production' && !existingDeveloperAdmin);

  if (!appUser) {
    const newId = shouldBeAdmin ? `dev-admin-${authId}` : randomUUID();
    const displayName = email.split('@')[0] || 'User';
    const role = shouldBeAdmin ? 'admin' : 'user';
    const plan = shouldBeAdmin ? 'pro' : 'free';

    await execute(
      `INSERT INTO users (id, email, display_name, role, plan, email_verified_at, auth_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7::uuid)`,
      [newId, email, displayName, role, plan, emailVerifiedAt ?? null, authId],
    );

    appUser = await queryOne<AppUserRow>(
      'SELECT id, email, role, plan FROM users WHERE id = $1',
      [newId],
    );
  } else if (shouldBeAdmin && appUser.role !== 'admin') {
    await execute(
      `UPDATE users
       SET role = 'admin', plan = CASE WHEN plan = 'free' THEN 'pro' ELSE plan END, updated_at = NOW()
       WHERE id = $1`,
      [appUser.id],
    );

    appUser = await queryOne<AppUserRow>(
      'SELECT id, email, role, plan FROM users WHERE id = $1',
      [appUser.id],
    );
  }

  if (!appUser) {
    throw new Error('Failed to resolve application user');
  }

  return appUser;
}

export function isSuperUser(user: { role?: string } | null | undefined): boolean {
  return user?.role === 'admin';
}

async function resolveAuthUserFromLocalJwt(token: string): Promise<AuthUser | null> {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as jwt.JwtPayload;
    const authId = typeof payload.sub === 'string' ? payload.sub : null;
    const email = typeof payload.email === 'string' ? payload.email : null;

    if (!authId || !email) {
      return null;
    }

    const appUser = await getOrCreateAppUser(authId, email, null);
    return {
      id: appUser.id,
      email,
      supabaseId: authId,
      role: appUser.role,
      plan: appUser.plan ?? undefined,
    };
  } catch {
    return null;
  }
}

export async function resolveAuthUserFromToken(token: string): Promise<AuthUser | null> {
  if (!token) {
    return null;
  }

  if (process.env.NODE_ENV === 'test') {
    return resolveAuthUserFromLocalJwt(token);
  }

  return null;
}

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

  // Local single-user mode (AUTH_REQUIRED not set): upstream middleware already
  // populated req.user (LOCAL_ADMIN or a validated Supabase user). Pass through.
  if (process.env.AUTH_REQUIRED !== 'true') {
    if (!req.user) req.user = LOCAL_ADMIN;
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
    const resolvedUser = await resolveAuthUserFromToken(token);
    if (!resolvedUser) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    req.user = resolvedUser;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

export const requireAuth = authRequired;

export type TeamRole = 'admin' | 'editor' | 'viewer';
export type WorkspaceRole = 'owner' | 'admin' | 'member';

const ROLE_HIERARCHY: Record<TeamRole, number> = {
  viewer: 0,
  editor: 1,
  admin: 2,
};

const WORKSPACE_ROLE_HIERARCHY: Record<WorkspaceRole, number> = {
  member: 0,
  admin: 1,
  owner: 2,
};

function resolveWorkspaceId(req: Request): string | null {
  const params = req.params as Record<string, string | undefined>;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const query = req.query as Record<string, string | undefined>;

  const candidate =
    params.workspaceId ||
    params.id ||
    (typeof query.workspaceId === 'string' ? query.workspaceId : undefined) ||
    (typeof body.workspaceId === 'string' ? body.workspaceId : undefined) ||
    (typeof body.workspace_id === 'string' ? body.workspace_id : undefined);

  return candidate ? String(candidate) : null;
}

export function requireWorkspaceRole(minRole: WorkspaceRole) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (isSuperUser(user)) {
      next();
      return;
    }

    const workspaceId = resolveWorkspaceId(req);
    if (!workspaceId) {
      res.status(400).json({ error: 'Workspace ID is required' });
      return;
    }

    try {
      const { queryOne } = await import('../db/index');
      const membership = await queryOne<{ role: WorkspaceRole }>(
        'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_auth_id = $2',
        [workspaceId, user.supabaseId],
      );

      if (!membership) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      if (WORKSPACE_ROLE_HIERARCHY[membership.role] < WORKSPACE_ROLE_HIERARCHY[minRole]) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      next();
    } catch {
      res.status(500).json({ error: 'Failed to verify workspace permissions' });
    }
  };
}

export const requireWorkspaceMember = () => requireWorkspaceRole('member');
export const requireWorkspaceAdmin = () => requireWorkspaceRole('admin');
export const requireWorkspaceOwner = () => requireWorkspaceRole('owner');

export function requireRole(minRole: TeamRole) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (isSuperUser(user) || user.id === 'system') {
      next();
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
