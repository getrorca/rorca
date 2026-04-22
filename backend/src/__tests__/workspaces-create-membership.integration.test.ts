import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { Pool } from 'pg';

import workspacesRouter from '../routes/workspaces';
import { errorHandler } from '../lib/error-handler';

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://rorca:rorca@localhost:5432/rorca_test';

const AUTH_ID = '33333333-3333-3333-3333-333333333333';
const APP_USER_ID = 'workspace-create-membership-user';

let pool: Pool;

describe('MU-028 POST /api/workspaces membership enrollment', () => {
  beforeAll(async () => {
    process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
    pool = new Pool({ connectionString: DB_URL, max: 5 });
    const { runPgMigrations } = await import('../db/pg-index');
    await runPgMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('creates an owner membership for the creating user', async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-mu028-'));
    const workspaceId = `ws-create-membership-${Date.now()}`;
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL search_path = rorca, public');
      await client.query(
        `INSERT INTO users (id, email, display_name, password_hash, role, auth_id)
         VALUES ($1, $2, $3, $4, 'user', $5::uuid)
         ON CONFLICT (id) DO NOTHING`,
        [APP_USER_ID, 'mu028@example.com', 'MU 028 User', 'supabase-managed', AUTH_ID],
      );

      const app = express();
      app.use(express.json());
      app.use((req: any, _res, next) => {
        req.user = {
          id: APP_USER_ID,
          email: 'mu028@example.com',
          supabaseId: AUTH_ID,
          role: 'authenticated',
          plan: 'pro',
        };
        next();
      });
      app.use('/api/workspaces', workspacesRouter);
      app.use(errorHandler);

      const response = await request(app)
        .post('/api/workspaces')
        .send({
          id: workspaceId,
          label: 'Workspace Create Membership',
          path: workspacePath,
          domains: ['saas'],
        });

      expect(response.status).toBe(201);

      const membership = await client.query(
        `SELECT workspace_id, user_auth_id::text AS user_auth_id, role
         FROM workspace_members
         WHERE workspace_id = $1 AND user_auth_id = $2::uuid`,
        [workspaceId, AUTH_ID],
      );

      expect(membership.rows).toEqual([
        {
          workspace_id: workspaceId,
          user_auth_id: AUTH_ID,
          role: 'owner',
        },
      ]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
  });
});
