import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { pool } from './index';
import { AuthError } from '../lib/errors';

function buildRequestJwtClaims(req: Request): string {
  if (!req.user) {
    throw new AuthError();
  }

  return JSON.stringify({
    sub: req.user.supabaseId,
    email: req.user.email,
    role: req.user.role ?? 'authenticated',
    app_metadata: {
      role: req.user.role ?? 'authenticated',
    },
    user_metadata: {
      id: req.user.id,
      plan: req.user.plan ?? null,
    },
  });
}

async function resetRequestJwtClaims(client: PoolClient): Promise<void> {
  await client.query('RESET request.jwt.claims');
}

export async function getUserClient(req: Request): Promise<PoolClient> {
  const claims = buildRequestJwtClaims(req);
  const client = await pool.connect();

  try {
    await client.query('SET request.jwt.claims = $1', [claims]);
    return client;
  } catch (error) {
    try {
      await resetRequestJwtClaims(client);
    } catch {
    }
    client.release();
    throw error;
  }
}

export async function withUserClient<T>(req: Request, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getUserClient(req);

  try {
    return await fn(client);
  } finally {
    try {
      await resetRequestJwtClaims(client);
    } finally {
      client.release();
    }
  }
}
