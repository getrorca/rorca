/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

jest.mock('../lib/pty-manager', () => ({
  killSessionsForWorkspace: jest.fn(),
}));

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
  });

  afterAll(async () => {
    await pool.end();
  });

  it("authenticated user A can't see user B workspaces", async () => {
    const workspaceA = `ws-route-rls-a-${Date.now()}`;
    const workspaceB = `ws-route-rls-b-${Date.now()}`;

    await pool.query('SET search_path = rorca, public');
    await pool.query(
      `INSERT INTO workspaces (id, label, path)
       VALUES ($1, $2, $3), ($4, $5, $6)`,
      [
        workspaceA, 'Workspace Route A', `/tmp/${workspaceA}`,
        workspaceB, 'Workspace Route B', `/tmp/${workspaceB}`,
      ],
    );

    await pool.query(
      `INSERT INTO workspace_members (workspace_id, user_auth_id, role)
       VALUES ($1, $2::uuid, 'owner'), ($3, $4::uuid, 'owner')`,
      [workspaceA, USER_ONE, workspaceB, USER_TWO],
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

    try {
      const response = await request(app).get('/api/workspaces');

      expect(response.status).toBe(200);
      expect(response.body.items.map((row: { id: string }) => row.id)).toEqual([workspaceA]);
    } finally {
      await pool.query('DELETE FROM workspace_members WHERE workspace_id IN ($1, $2)', [workspaceA, workspaceB]);
      await pool.query('DELETE FROM workspaces WHERE id IN ($1, $2)', [workspaceA, workspaceB]);
    }
  });
});
