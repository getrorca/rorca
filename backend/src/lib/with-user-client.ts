import type { Request } from 'express';
import type { PoolClient, QueryResult } from 'pg';
import { getPool } from '../db/index';
import { getEffectiveUser } from './get-user';
import { AuthError } from './errors';

export interface UserDbClient {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  release(): Promise<void>;
  userAuthId: string;
}

export async function withUserClient(req: Request): Promise<UserDbClient> {
  const user = await getEffectiveUser(req);
  const userAuthId = user?.supabaseId ?? user?.id;

  if (!userAuthId) {
    throw new AuthError('No user found');
  }

  const client: PoolClient = await getPool().connect();

  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [userAuthId]);
    await client.query("SELECT set_config('request.jwt.claim.role', 'authenticated', true)");
    await client.query("SET LOCAL ROLE authenticated");
  } catch (error) {
    client.release();
    throw error;
  }

  return {
    query<T = unknown>(sql: string, params: unknown[] = []) {
      return client.query<T>(sql, params);
    },
    async release() {
      try {
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    },
    userAuthId,
  };
}
