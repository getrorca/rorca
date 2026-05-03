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
      `INSERT INTO users (id, email, display_name, password_hash, auth_id, role, plan)
       VALUES ($1, $2, $3, $4, $5::uuid, 'user', 'free')`,
      [crypto.randomUUID(), email, email.split('@')[0], 'x', authId],
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
