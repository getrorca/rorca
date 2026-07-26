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

export const INTERNAL_SERVICE_USER_ID = 'rorca-internal-service';

function resolveInternalServiceToken(): string {
  const configured = String(process.env.RORCA_INTERNAL_SERVICE_TOKEN ?? '').trim();
  if (configured) {
    if (Buffer.byteLength(configured, 'utf8') < 32
      || /^rorca-internal-(?:\d+|change-me|default)$/i.test(configured)) {
      throw new Error('RORCA_INTERNAL_SERVICE_TOKEN must be an unpredictable secret of at least 32 bytes');
    }
    return configured;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('RORCA_INTERNAL_SERVICE_TOKEN is required in production');
  }
  // Non-production processes get an unpredictable process-local token. It is
  // intentionally not derivable from PID and cannot authenticate another process.
  return crypto.randomBytes(32).toString('base64url');
}

export const INTERNAL_SERVICE_TOKEN = resolveInternalServiceToken();

function sameInternalToken(supplied: unknown): boolean {
  if (typeof supplied !== 'string') return false;
  const expected = Buffer.from(INTERNAL_SERVICE_TOKEN, 'utf8');
  const actual = Buffer.from(supplied, 'utf8');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function internalServiceUser(req: Request): AuthUser {
  const service = String(req.headers['x-rorca-service'] ?? '').trim().toLowerCase();
  if (service && service !== 'hermes' && service !== 'scheduler') {
    throw new Error('Unsupported internal service identity');
  }
  const hermes = service === 'hermes';
  return {
    id: hermes ? 'rorca-hermes-service' : INTERNAL_SERVICE_USER_ID,
    email: hermes ? 'hermes@rorca.internal' : 'scheduler@rorca.internal',
    supabaseId: hermes
      ? '00000000-0000-0000-0000-000000000002'
      : '00000000-0000-0000-0000-000000000000',
    role: 'admin',
  };
}

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

/**
 * The unauthenticated local topology has one explicit human principal. This
 * helper must stay narrower than a generic admin check: hosted/authenticated
 * users and internal services require their provider-bound approval authority.
 */
export function isLocalHumanApprovalPrincipal(
  user: { id?: string; email?: string; supabaseId?: string; role?: string } | null | undefined,
): boolean {
  return process.env.AUTH_REQUIRED !== 'true'
    && user?.id === LOCAL_ADMIN.id
    && user.email === LOCAL_ADMIN.email
    && user.supabaseId === LOCAL_ADMIN.supabaseId
    && user.role === LOCAL_ADMIN.role;
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
  const internalHeader = req.headers['x-rorca-internal'];
  const serviceHeader = req.headers['x-rorca-service'];
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  const validInternalHeader = internalHeader !== undefined && sameInternalToken(internalHeader);
  const validInternalBearer = bearerToken !== null && sameInternalToken(bearerToken);
  const claimsServiceIdentity = serviceHeader !== undefined || internalHeader !== undefined || validInternalBearer;

  // Internal service identity is resolved before the local-human fallback in every
  // supported topology. Every supplied service credential must be valid; a service
  // label without a credential or contradictory credentials fail closed.
  if (claimsServiceIdentity) {
    const invalidInternalHeader = internalHeader !== undefined && !validInternalHeader;
    const invalidBearer = bearerToken !== null && !validInternalBearer;
    const missingServiceCredential = serviceHeader !== undefined && !validInternalHeader && !validInternalBearer;
    if (invalidInternalHeader || invalidBearer || missingServiceCredential) {
      res.status(401).json({ error: 'Unauthorized', code: 'AUTH_ERROR' });
      return;
    }
    try {
      req.user = internalServiceUser(req);
      next();
    } catch {
      res.status(401).json({ error: 'Unauthorized', code: 'AUTH_ERROR' });
    }
    return;
  }

  if (process.env.AUTH_REQUIRED !== 'true' && !bearerToken) {
    if (!req.user) req.user = LOCAL_ADMIN;
    next();
    return;
  }

  if (!bearerToken) {
    res.status(401).json({ error: 'Authentication required', code: 'AUTH_ERROR' });
    return;
  }

  try {
    const resolvedUser = await resolveAuthUserFromToken(bearerToken);
    if (!resolvedUser) {
      res.status(401).json({ error: 'Unauthorized', code: 'AUTH_ERROR' });
      return;
    }

    req.user = resolvedUser;
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized', code: 'AUTH_ERROR' });
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
      res.status(401).json({ error: 'Authentication required', code: 'AUTH_ERROR' });
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

export function requirePlatformAdmin() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required', code: 'AUTH_ERROR' });
      return;
    }
    if (!isSuperUser(req.user)) {
      res.status(403).json({ error: 'Platform administrator authority required' });
      return;
    }
    next();
  };
}

export const requireWorkspaceMember = () => requireWorkspaceRole('member');
export const requireWorkspaceAdmin = () => requireWorkspaceRole('admin');
export const requireWorkspaceOwner = () => requireWorkspaceRole('owner');

export function requireRole(minRole: TeamRole) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: 'Authentication required', code: 'AUTH_ERROR' });
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
