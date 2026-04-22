import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { pool } from './index';
import { AuthError } from '../lib/errors';

function buildJwtClaims(req: Request): string {
  const user = req.user;
  if (!user) {
    throw new AuthError('Authentication required');
  }

  return JSON.stringify({
    sub: user.supabaseId,
    email: user.email,
    role: user.role ?? 'authenticated',
  });
}

async function resetUserClaims(client: PoolClient): Promise<void> {
  await client.query('RESET request.jwt.claims');
}

export async function getUserClient(req: Request): Promise<PoolClient> {
  const claims = buildJwtClaims(req);
  const client = await pool.connect();

  try {
    await client.query('SET request.jwt.claims = $1', [claims]);
    return client;
  } catch (error) {
    try {
      await resetUserClaims(client);
    } catch {
    }
    client.release();
    throw error;
  }
}

export async function withUserClient<T>(req: Request, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const claims = buildJwtClaims(req);
  const client = await pool.connect();

  try {
    await client.query('SET request.jwt.claims = $1', [claims]);
    return await fn(client);
  } finally {
    try {
      await resetUserClaims(client);
    } finally {
      client.release();
    }
  }
}
