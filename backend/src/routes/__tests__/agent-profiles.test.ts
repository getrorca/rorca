/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Server } from 'http';
import { once } from 'events';
import type { Express } from 'express';
import request from 'supertest';
import { getAuthToken } from './helpers/auth-helper';
import { query, queryOne, execute } from '../../db/index';

let app: Server;
let tmpDir: string;
let authToken: string;

const WORKSPACE_ID = 'ws-profiles-test';

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-profiles-test-'));
  process.env.NODE_ENV = 'test';
  const serverMod = require('../../server');
  const expressApp = serverMod.default as Express;
  await execute(
    `INSERT INTO workspaces (id, label, path) VALUES ($1, 'Test Workspace', $2)
     ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path`,
    [WORKSPACE_ID, tmpDir],
  );
  authToken = await getAuthToken(expressApp);
  app = expressApp.listen(0, '127.0.0.1');
  await once(app, 'listening');
});

beforeEach(async () => {
  await execute('DELETE FROM agent_profiles WHERE workspace_id = $1', [WORKSPACE_ID]);
});

afterAll(async () => {
  app.closeAllConnections();
  await new Promise<void>((resolve, reject) => app.close((error) => error ? reject(error) : resolve()));
  await execute('DELETE FROM agent_profiles WHERE workspace_id = $1', [WORKSPACE_ID]);
  fs.rmSync(tmpDir, { recursive: true, force: true });
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
    await execute(`INSERT INTO agent_profiles (workspace_id, name, allowed_tools, is_active) VALUES ($1, 'Beta', '[]', false)`, [WORKSPACE_ID]);
    await execute(`INSERT INTO agent_profiles (workspace_id, name, allowed_tools, is_active) VALUES ($1, 'Alpha', '[]', true)`, [WORKSPACE_ID]);

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
    await execute(`INSERT INTO agent_profiles (workspace_id, name, allowed_tools, is_active) VALUES ($1, 'Active Profile', '[]', true)`, [WORKSPACE_ID]);

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
    await execute(`INSERT INTO agent_profiles (workspace_id, name, allowed_tools, is_active) VALUES ($1, 'Existing Active', '[]', true)`, [WORKSPACE_ID]);

    await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/agent-profiles`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ name: 'New Active', is_active: true });

    const profiles = await query(`SELECT name, is_active FROM agent_profiles WHERE workspace_id = $1 ORDER BY name`, [WORKSPACE_ID]) as { name: string; is_active: boolean }[];

    const existingActive = profiles.find(p => p.name === 'Existing Active');
    expect(existingActive!.is_active).toBe(false);
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
    const result = await queryOne<{ id: number }>(`INSERT INTO agent_profiles (workspace_id, name, allowed_tools, is_active) VALUES ($1, 'Old Name', '[]', false) RETURNING id`, [WORKSPACE_ID]);
    const profileId = result!.id;

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
    const result = await queryOne<{ id: number }>(`INSERT INTO agent_profiles (workspace_id, name, allowed_tools, is_active) VALUES ($1, 'ToDelete', '[]', false) RETURNING id`, [WORKSPACE_ID]);
    const profileId = result!.id;

    const res = await request(app)
      .delete(`/api/workspaces/${WORKSPACE_ID}/agent-profiles/${profileId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(204);

    const gone = await queryOne(`SELECT id FROM agent_profiles WHERE id = $1`, [profileId]);
    expect(gone).toBeUndefined();
  });

  it('returns 404 for nonexistent profile', async () => {
    const res = await request(app)
      .delete(`/api/workspaces/${WORKSPACE_ID}/agent-profiles/99999`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(404);
  });
});
