/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import type { Express } from 'express';
import { execute, queryOne } from '../../../db/index';
import { JWT_SECRET } from '../../../lib/auth-utils';

export function buildTestAuthHeaders(user: { id: string; email: string }) {
  return {
    'x-test-user-id': user.id,
    'x-test-user-email': user.email,
  };
}

export async function getAuthToken(_app?: Express, overrides?: { email?: string; authId?: string }) {
  const email = overrides?.email ?? 'testauth@example.com';
  const authId = overrides?.authId ?? crypto.randomUUID();

  let row = await queryOne<{ id: string; auth_id: string | null }>(
    'SELECT id, auth_id FROM users WHERE email = $1',
    [email],
  );

  if (!row) {
    await execute(
      `INSERT INTO users (id, email, display_name, auth_id, role, plan)
       VALUES ($1, $2, $3, $4::uuid, 'user', 'free')`,
      [crypto.randomUUID(), email, email.split('@')[0], authId],
    );
    row = await queryOne<{ id: string; auth_id: string | null }>(
      'SELECT id, auth_id FROM users WHERE email = $1',
      [email],
    );
  } else if (!row.auth_id) {
    await execute('UPDATE users SET auth_id = $1::uuid WHERE id = $2', [authId, row.id]);
    row = { ...row, auth_id: authId };
  }

  const effectiveAuthId = row?.auth_id ?? authId;
  return jwt.sign({ sub: effectiveAuthId, email }, JWT_SECRET, { expiresIn: '15m' });
}

export async function ensureTestUser(overrides?: {
  email?: string;
  authId?: string;
  plan?: string;
  role?: string;
}): Promise<{ id: string; authId: string; email: string }> {
  const email = overrides?.email ?? 'testauth@example.com';
  const authId = overrides?.authId ?? crypto.randomUUID();
  const plan = overrides?.plan ?? 'free';
  const role = overrides?.role ?? 'user';

  let row = await queryOne<{ id: string; auth_id: string | null }>(
    'SELECT id, auth_id FROM users WHERE email = $1',
    [email],
  );

  if (!row) {
    const id = crypto.randomUUID();
    await execute(
      `INSERT INTO users (id, email, display_name, auth_id, role, plan)
       VALUES ($1, $2, $3, $4::uuid, $5, $6)`,
      [id, email, email.split('@')[0], authId, role, plan],
    );
    row = { id, auth_id: authId };
  } else {
    await execute(
      `UPDATE users
       SET auth_id = COALESCE(auth_id, $1::uuid), role = $2, plan = $3, updated_at = NOW()
       WHERE id = $4`,
      [authId, role, plan, row.id],
    );
    row = { ...row, auth_id: row.auth_id ?? authId };
  }

  return { id: row.id, authId: row.auth_id ?? authId, email };
}
