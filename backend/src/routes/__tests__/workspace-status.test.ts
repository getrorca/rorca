/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import request from 'supertest';
import { execute } from '../../db/index';
import { getAuthToken } from './helpers/auth-helper';

let app: Express;
let tmpDir: string;
let authToken: string;

beforeEach(async () => {
  jest.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-ws-status-test-'));
  process.env.NODE_ENV = 'test';
  const serverMod = require('../../server');
  app = serverMod.default;
  authToken = await getAuthToken(app);
  await execute("UPDATE users SET plan = 'pro' WHERE email = 'testauth@example.com'", []);
  await execute(
    `INSERT INTO workspaces (id, label, path, domains)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label, path = EXCLUDED.path, domains = EXCLUDED.domains`,
    ['ws-status-1', 'Workspace Status Test', tmpDir, '[]'],
  );
});

afterEach(async () => {
  try { const { closePool } = require('../../db/index'); await closePool(); } catch {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.NODE_ENV;
});

describe('GET /api/workspaces/:id/status', () => {
  it('returns canonical database capability data with redacted connection metadata', async () => {
    const res = await request(app)
      .get('/api/workspaces/ws-status-1/status')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.workspaceId).toBe('ws-status-1');
    expect(res.body.databaseCapability).toMatchObject({
      dbMode: expect.any(String),
      provider: expect.any(String),
      graphMode: expect.any(String),
    });
    expect(res.body.databaseCapability.extensions).toHaveProperty('age');
    expect(Array.isArray(res.body.databaseCapability.warnings)).toBe(true);
    expect(String(res.body.databaseCapability.connection.url ?? '')).not.toContain('@');
    expect(res.body.graph.graphMode).toBe(res.body.databaseCapability.graphMode);
  });
});
