import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { pool } from './index';
import { AuthError } from '../lib/errors';

function buildJwtClaims(req: Request): Record<string, unknown> {
  const user = req.user;
  if (!user) {
    throw new AuthError('Authentication required');
  }

  return {
    sub: user.supabaseId || user.id,
    email: user.email,
    role: user.role ?? 'authenticated',
    app_metadata: {
      role: user.role ?? 'authenticated',
    },
    user_metadata: {
      plan: user.plan ?? null,
    },
  };
}

export async function getUserClient(req: Request): Promise<PoolClient> {
  const claims = buildJwtClaims(req);
  const client = await pool.connect();

  try {
    await client.query('SET request.jwt.claims = $1', [JSON.stringify(claims)]);
    return client;
  } catch (error) {
    try {
      await client.query('RESET request.jwt.claims');
    } catch {
      // Best-effort cleanup before releasing a failed client setup.
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
      await client.query('RESET request.jwt.claims');
    } finally {
      client.release();
    }
  }
}
