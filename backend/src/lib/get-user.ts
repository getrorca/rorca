/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Request } from 'express';
import { queryOne } from '../db/index';
import { LOCAL_ADMIN, type AuthUser } from '../lib/auth-utils';

interface CachedUser {
  user: AuthUser;
  expiresAt: number;
}

interface UserRow {
  id: string;
  email: string;
  role: string;
  plan: string | null;
}

const USER_CACHE_TTL_MS = parseInt(process.env.RORCA_USER_CACHE_TTL_MS || String(5 * 60 * 1000), 10);
const userCache = new Map<string, CachedUser>();

function cloneUser(user: AuthUser): AuthUser {
  return {
    id: user.id,
    email: user.email,
    supabaseId: user.supabaseId,
    role: user.role,
    plan: user.plan,
  };
}

function getCacheKey(user: Pick<AuthUser, 'id' | 'supabaseId'>): string {
  return user.id === LOCAL_ADMIN.id ? LOCAL_ADMIN.id : `${user.id}:${user.supabaseId}`;
}

export function resetEffectiveUserCache(): void {
  userCache.clear();
}

export async function getEffectiveUser(req: Request): Promise<AuthUser | null> {
  if (!req.user) {
    return null;
  }

  if (req.user.id === LOCAL_ADMIN.id) {
    return cloneUser(LOCAL_ADMIN);
  }

  const cacheKey = getCacheKey(req.user);
  const cached = userCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cloneUser(cached.user);
  }

  const row = await queryOne<UserRow>(
    `SELECT id, email, role, plan
     FROM users
     WHERE id = $1
     LIMIT 1`,
    [req.user.id],
  );

  if (!row) {
    return null;
  }

  const effectiveUser: AuthUser = {
    id: row.id,
    email: row.email,
    supabaseId: req.user.supabaseId,
    role: row.role ?? req.user.role ?? 'user',
    plan: row.plan ?? 'free',
  };

  userCache.set(cacheKey, {
    user: effectiveUser,
    expiresAt: Date.now() + USER_CACHE_TTL_MS,
  });

  return cloneUser(effectiveUser);
}
