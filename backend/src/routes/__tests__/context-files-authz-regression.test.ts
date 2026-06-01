/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import express from 'express';
import request from 'supertest';

jest.mock('../../db/index', () => ({
  queryOne: jest.fn(),
  query: jest.fn(),
}));

jest.mock('../../lib/rorca-config', () => ({ loadRorcaConfig: jest.fn(() => ({})) }));
jest.mock('../../lib/file-watcher', () => ({ markWriting: jest.fn() }));

const { queryOne } = require('../../db/index');
const contextFilesRouter = require('../context-files').default;

describe('context-files route auth regression', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function makeApp(role: 'member' | 'admin' | 'owner' | null) {
    queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT role FROM workspace_members')) {
        return role ? { role } : null;
      }
      return null;
    });

    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.user = {
        id: 'app-user-1',
        email: 'member@example.com',
        supabaseId: 'auth-user-1',
        role: 'user',
      };
      next();
    });
    app.use('/api/workspaces', contextFilesRouter);
    app.use((err: any, _req: any, res: any, _next: any) => {
      res.status(err.statusCode || err.status || 500).json({ error: err.message || 'error' });
    });
    return app;
  }

  test('non-member cannot read context files', async () => {
    const app = makeApp(null);
    const response = await request(app).get('/api/workspaces/ws-1/context-files');

    expect(response.status).toBe(403);
  });

  test('member cannot write context files', async () => {
    const app = makeApp('member');
    const response = await request(app)
      .put('/api/workspaces/ws-1/context-files/write')
      .send({ filePath: 'CLAUDE.md', content: 'x' });

    expect(response.status).toBe(403);
  });
});
