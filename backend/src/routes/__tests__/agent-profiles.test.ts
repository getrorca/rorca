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

const WORKSPACE_ID = 'ws-profiles-test';

beforeEach(async () => {
  jest.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-profiles-test-'));
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

describe('GET /api/workspaces/:id/agent-profiles', () => {
  it('returns empty profiles list', async () => {
    const res = await request(app)
      .get(`/api/workspaces/${WORKSPACE_ID}/agent-profiles`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.profiles).toEqual([]);
  });

  it('returns profiles ordered by active first, then name', async () => {
    db.prepare(
      "INSERT INTO agent_profiles (workspace_id, name, allowed_tools, is_active) VALUES (?, 'Beta', '[]', 0)"
    ).run(WORKSPACE_ID);
    db.prepare(
      "INSERT INTO agent_profiles (workspace_id, name, allowed_tools, is_active) VALUES (?, 'Alpha', '[]', 1)"
    ).run(WORKSPACE_ID);

    const res = await request(app)
      .get(`/api/workspaces/${WORKSPACE_ID}/agent-profiles`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.profiles).toHaveLength(2);
    expect(res.body.profiles[0].name).toBe('Alpha'); // active first
    expect(res.body.profiles[1].name).toBe('Beta');
  });
});

describe('GET /api/workspaces/:id/agent-profiles/active', () => {
  it('returns null when no active profile', async () => {
    const res = await request(app)
      .get(`/api/workspaces/${WORKSPACE_ID}/agent-profiles/active`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.profile).toBeNull();
  });

  it('returns the active profile', async () => {
    db.prepare(
      "INSERT INTO agent_profiles (workspace_id, name, allowed_tools, is_active) VALUES (?, 'Active Profile', '[]', 1)"
    ).run(WORKSPACE_ID);

    const res = await request(app)
      .get(`/api/workspaces/${WORKSPACE_ID}/agent-profiles/active`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.profile).not.toBeNull();
    expect(res.body.profile.name).toBe('Active Profile');
    expect(res.body.profile.is_active).toBe(true);
  });
});

describe('POST /api/workspaces/:id/agent-profiles', () => {
  it('creates a profile with default values', async () => {
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/agent-profiles`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ name: 'My Profile' });

    expect(res.status).toBe(201);
    expect(res.body.profile.name).toBe('My Profile');
    expect(res.body.profile.is_active).toBe(false);
    expect(res.body.profile.allowed_tools).toEqual([]);
    expect(res.body.profile.system_prompt_override).toBeNull();
  });

  it('creates profile with all fields', async () => {
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/agent-profiles`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        name: 'Full Profile',
        system_prompt_override: 'You are a specialist',
        allowed_tools: ['read', 'write'],
        model_override: 'claude-opus-4-6',
        is_active: true,
      });

    expect(res.status).toBe(201);
    expect(res.body.profile.name).toBe('Full Profile');
    expect(res.body.profile.is_active).toBe(true);
    expect(res.body.profile.allowed_tools).toEqual(['read', 'write']);
    expect(res.body.profile.system_prompt_override).toBe('You are a specialist');
  });

  it('deactivates other profiles when creating active one', async () => {
    db.prepare(
      "INSERT INTO agent_profiles (workspace_id, name, allowed_tools, is_active) VALUES (?, 'Existing Active', '[]', 1)"
    ).run(WORKSPACE_ID);

    await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/agent-profiles`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ name: 'New Active', is_active: true });

    const profiles = db.prepare(
      'SELECT name, is_active FROM agent_profiles WHERE workspace_id = ? ORDER BY name'
    ).all(WORKSPACE_ID) as { name: string; is_active: number }[];

    const existingActive = profiles.find(p => p.name === 'Existing Active');
    expect(existingActive!.is_active).toBe(0);
  });

  it('returns 400 for missing name', async () => {
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/agent-profiles`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ system_prompt_override: 'some prompt' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/missing required field: name/i);
  });

  it('returns 404 for nonexistent workspace', async () => {
    const res = await request(app)
      .post('/api/workspaces/nonexistent/agent-profiles')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ name: 'Profile' });

    expect(res.status).toBe(404);
  });
});

describe('PUT /api/workspaces/:id/agent-profiles/:profileId', () => {
  it('updates an existing profile', async () => {
    const result = db.prepare(
      "INSERT INTO agent_profiles (workspace_id, name, allowed_tools, is_active) VALUES (?, 'Old Name', '[]', 0)"
    ).run(WORKSPACE_ID);
    const profileId = result.lastInsertRowid;

    const res = await request(app)
      .put(`/api/workspaces/${WORKSPACE_ID}/agent-profiles/${profileId}`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ name: 'New Name', allowed_tools: ['bash'] });

    expect(res.status).toBe(200);
    expect(res.body.profile.name).toBe('New Name');
    expect(res.body.profile.allowed_tools).toEqual(['bash']);
  });

  it('returns 404 for nonexistent profile', async () => {
    const res = await request(app)
      .put(`/api/workspaces/${WORKSPACE_ID}/agent-profiles/99999`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ name: 'Updated' });

    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid profile ID', async () => {
    const res = await request(app)
      .put(`/api/workspaces/${WORKSPACE_ID}/agent-profiles/notanumber`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ name: 'Updated' });

    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/workspaces/:id/agent-profiles/:profileId', () => {
  it('deletes an existing profile', async () => {
    const result = db.prepare(
      "INSERT INTO agent_profiles (workspace_id, name, allowed_tools, is_active) VALUES (?, 'ToDelete', '[]', 0)"
    ).run(WORKSPACE_ID);
    const profileId = result.lastInsertRowid;

    const res = await request(app)
      .delete(`/api/workspaces/${WORKSPACE_ID}/agent-profiles/${profileId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(204);

    const gone = db.prepare('SELECT id FROM agent_profiles WHERE id = ?').get(profileId);
    expect(gone).toBeUndefined();
  });

  it('returns 404 for nonexistent profile', async () => {
    const res = await request(app)
      .delete(`/api/workspaces/${WORKSPACE_ID}/agent-profiles/99999`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(404);
  });
});
