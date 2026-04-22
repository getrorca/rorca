import express from 'express';
import request from 'supertest';
import { Pool } from 'pg';

import workspacesRouter from '../routes/workspaces';
import { errorHandler } from '../lib/error-handler';

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://rorca:rorca@localhost:5432/rorca_test';

const USER_ONE = '11111111-1111-1111-1111-111111111111';
const USER_TWO = '22222222-2222-2222-2222-222222222222';

let pool: Pool;

describe('MU-022 GET /api/workspaces route RLS', () => {
  beforeAll(async () => {
    process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
    pool = new Pool({ connectionString: DB_URL, max: 5 });
    const { runPgMigrations } = await import('../db/pg-index');
    await runPgMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("authenticated user A can't see user B workspaces", async () => {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL search_path = rorca, public');

      await client.query(
        `INSERT INTO workspaces (id, label, path)
         VALUES ($1, $2, $3), ($4, $5, $6)`,
        [
          'ws-route-rls-a', 'Workspace Route A', '/tmp/ws-route-rls-a',
          'ws-route-rls-b', 'Workspace Route B', '/tmp/ws-route-rls-b',
        ],
      );

      await client.query(
        `INSERT INTO workspace_members (workspace_id, user_auth_id, role)
         VALUES ($1, $2::uuid, 'owner'), ($3, $4::uuid, 'owner')`,
        ['ws-route-rls-a', USER_ONE, 'ws-route-rls-b', USER_TWO],
      );

      const app = express();
      app.use((req: any, _res, next) => {
        req.user = {
          id: USER_ONE,
          email: 'user-a@example.com',
          supabaseId: USER_ONE,
          role: 'authenticated',
        };
        next();
      });
      app.use('/api/workspaces', workspacesRouter);
      app.use(errorHandler);

      const response = await request(app).get('/api/workspaces');

      expect(response.status).toBe(200);
      expect(response.body.items.map((row: { id: string }) => row.id)).toEqual(['ws-route-rls-a']);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
