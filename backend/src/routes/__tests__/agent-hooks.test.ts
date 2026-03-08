import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import request from 'supertest';
import { getAuthToken } from './helpers/auth-helper';

let app: Express;
let db: Database.Database;
let tmpDir: string;
let authToken: string;

const WORKSPACE_ID = 'ws-hooks-test';

beforeEach(async () => {
  jest.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-hooks-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  process.env.DB_PATH = dbPath;
  process.env.NODE_ENV = 'test';

  const serverMod = require('../../server');
  app = serverMod.default;
  const dbMod = require('../../db/index');
  db = dbMod.db;

  db.prepare(
    "INSERT INTO workspaces (id, label, path) VALUES (?, 'Test Workspace', ?)"
  ).run(WORKSPACE_ID, tmpDir);

  authToken = await getAuthToken(app);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
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
    db.prepare(
      "INSERT INTO agent_hooks (workspace_id, event_type, command, enabled, timeout_seconds) VALUES (?, ?, ?, 1, 30)"
    ).run(WORKSPACE_ID, 'on_run_start', 'echo start');
    db.prepare(
      "INSERT INTO agent_hooks (workspace_id, event_type, command, enabled, timeout_seconds) VALUES (?, ?, ?, 1, 30)"
    ).run(WORKSPACE_ID, 'on_generate', 'echo generate');

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
    const result = db.prepare(
      "INSERT INTO agent_hooks (workspace_id, event_type, command, enabled, timeout_seconds) VALUES (?, 'on_generate', 'echo old', 1, 30)"
    ).run(WORKSPACE_ID);
    const hookId = result.lastInsertRowid;

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
    const result = db.prepare(
      "INSERT INTO agent_hooks (workspace_id, event_type, command, enabled, timeout_seconds) VALUES (?, 'on_approve', 'echo approved', 1, 30)"
    ).run(WORKSPACE_ID);
    const hookId = result.lastInsertRowid;

    const res = await request(app)
      .delete(`/api/workspaces/${WORKSPACE_ID}/agent-hooks/${hookId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(204);

    const gone = db.prepare('SELECT id FROM agent_hooks WHERE id = ?').get(hookId);
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
