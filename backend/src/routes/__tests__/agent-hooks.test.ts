/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import request from 'supertest';
import { getAuthToken } from './helpers/auth-helper';
import { queryOne, execute } from '../../db/index';

let app: Express;
let tmpDir: string;
let authToken: string;

const WORKSPACE_ID = 'ws-hooks-test';

beforeEach(async () => {
  jest.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-hooks-test-'));
  const _dbPath = path.join(tmpDir, 'test.db');
process.env.NODE_ENV = 'test';

  const serverMod = require('../../server');
  app = serverMod.default;
await execute(`INSERT INTO workspaces (id, label, path) VALUES ($1, 'Test Workspace', $2) ON CONFLICT (id) DO NOTHING`, [WORKSPACE_ID, tmpDir]);

  authToken = await getAuthToken(app);
});

afterEach(() => {
fs.rmSync(tmpDir, { recursive: true, force: true });
delete process.env.NODE_ENV;
});

describe('GET /api/workspaces/:id/agent-hooks', () => {
  it('returns empty hooks list for workspace with no hooks', async () => {
    const res = await request(app)
      .get(`/api/workspaces/${WORKSPACE_ID}/agent-hooks`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.hooks).toEqual([]);
  });

  it('returns hooks ordered by event_type and id', async () => {
    await execute(`INSERT INTO agent_hooks (workspace_id, event_type, command, enabled, timeout_seconds) VALUES ($1, $2, $3, 1, 30)`, [WORKSPACE_ID, 'on_run_start', 'echo start']);
    await execute(`INSERT INTO agent_hooks (workspace_id, event_type, command, enabled, timeout_seconds) VALUES ($1, $2, $3, 1, 30)`, [WORKSPACE_ID, 'on_generate', 'echo generate']);

    const res = await request(app)
      .get(`/api/workspaces/${WORKSPACE_ID}/agent-hooks`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.hooks).toHaveLength(2);
    // ordered by event_type: on_generate < on_run_start alphabetically
    expect(res.body.hooks[0].event_type).toBe('on_generate');
    expect(res.body.hooks[1].event_type).toBe('on_run_start');
  });
});

describe('POST /api/workspaces/:id/agent-hooks', () => {
  it('creates a new agent hook', async () => {
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/agent-hooks`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ event_type: 'on_story_pass', command: 'echo story passed' });

    expect(res.status).toBe(201);
    expect(res.body.hook.event_type).toBe('on_story_pass');
    expect(res.body.hook.command).toBe('echo story passed');
    expect(res.body.hook.enabled).toBe(1);
    expect(res.body.hook.timeout_seconds).toBe(30);
  });

  it('creates hook with custom enabled and timeout', async () => {
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/agent-hooks`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ event_type: 'on_run_start', command: 'notify.sh', enabled: false, timeout_seconds: 60 });

    expect(res.status).toBe(201);
    expect(res.body.hook.enabled).toBe(0);
    expect(res.body.hook.timeout_seconds).toBe(60);
  });

  it('returns 400 for missing event_type', async () => {
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/agent-hooks`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ command: 'echo hello' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/missing required fields/i);
  });

  it('returns 400 for invalid event_type', async () => {
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/agent-hooks`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ event_type: 'on_invalid_event', command: 'echo hello' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid event_type/i);
  });

  it('returns 404 for nonexistent workspace', async () => {
    const res = await request(app)
      .post('/api/workspaces/nonexistent-ws/agent-hooks')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ event_type: 'on_generate', command: 'echo hello' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/workspace not found/i);
  });
});

describe('PUT /api/workspaces/:id/agent-hooks/:hookId', () => {
  it('updates an existing hook', async () => {
    const result = await queryOne<{ id: number }>(`INSERT INTO agent_hooks (workspace_id, event_type, command, enabled, timeout_seconds) VALUES ($1, 'on_generate', 'echo old', 1, 30) RETURNING id`, [WORKSPACE_ID]);
    const hookId = result!.id;

    const res = await request(app)
      .put(`/api/workspaces/${WORKSPACE_ID}/agent-hooks/${hookId}`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ command: 'echo updated', enabled: false });

    expect(res.status).toBe(200);
    expect(res.body.hook.command).toBe('echo updated');
    expect(res.body.hook.enabled).toBe(0);
    expect(res.body.hook.event_type).toBe('on_generate'); // unchanged
  });

  it('returns 404 for nonexistent hook', async () => {
    const res = await request(app)
      .put(`/api/workspaces/${WORKSPACE_ID}/agent-hooks/99999`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ command: 'echo hello' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/hook not found/i);
  });

  it('returns 400 for invalid hook ID', async () => {
    const res = await request(app)
      .put(`/api/workspaces/${WORKSPACE_ID}/agent-hooks/notanumber`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ command: 'echo hello' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid hook id/i);
  });
});

describe('DELETE /api/workspaces/:id/agent-hooks/:hookId', () => {
  it('deletes an existing hook', async () => {
    const result = await queryOne<{ id: number }>(`INSERT INTO agent_hooks (workspace_id, event_type, command, enabled, timeout_seconds) VALUES ($1, 'on_approve', 'echo approved', 1, 30) RETURNING id`, [WORKSPACE_ID]);
    const hookId = result!.id;

    const res = await request(app)
      .delete(`/api/workspaces/${WORKSPACE_ID}/agent-hooks/${hookId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(204);

    const gone = await queryOne(`SELECT id FROM agent_hooks WHERE id = $1`, [hookId]);
    expect(gone).toBeUndefined();
  });

  it('returns 404 for nonexistent hook', async () => {
    const res = await request(app)
      .delete(`/api/workspaces/${WORKSPACE_ID}/agent-hooks/99999`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid hook ID', async () => {
    const res = await request(app)
      .delete(`/api/workspaces/${WORKSPACE_ID}/agent-hooks/notanumber`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(400);
  });
});
