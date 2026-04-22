import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { pool } from './index';
import { AuthError } from '../lib/errors';

function getRequestClaims(req: Request): string {
  const user = req.user;
  if (!user) {
    throw new AuthError('Authentication required');
  }

  return JSON.stringify({
    sub: user.supabaseId || user.id,
    email: user.email,
    role: user.role ?? 'authenticated',
  });
}

export async function getUserClient(req: Request): Promise<PoolClient> {
  const claims = getRequestClaims(req);
  const client = await pool.connect();

  try {
    await client.query('SET request.jwt.claims = $1', [claims]);
    return client;
  } catch (error) {
    try {
      await client.query('RESET request.jwt.claims');
    } catch {
    }
    client.release();
    throw error;
  }
}

export async function withUserClient<T>(
  req: Request,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
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
