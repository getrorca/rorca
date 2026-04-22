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
    sub: user.supabaseId || user.id,
    email: user.email,
    role: user.role ?? 'authenticated',
  });
}

async function setRequestJwtClaims(client: PoolClient, claimsJson: string): Promise<void> {
  await client.query('SET request.jwt.claims = $1', [claimsJson]);
}

export async function resetUserClient(client: PoolClient): Promise<void> {
  await client.query('RESET request.jwt.claims');
}

export async function getUserClient(req: Request): Promise<PoolClient> {
  const claimsJson = buildJwtClaims(req);
  const client = await pool.connect();

  try {
    await setRequestJwtClaims(client, claimsJson);
    return client;
  } catch (error) {
    try {
      await resetUserClient(client);
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
      await resetUserClient(client);
    } finally {
      client.release();
    }
  }
}
