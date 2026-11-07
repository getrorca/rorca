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
import type {
  execute as executeType,
  queryOne as queryOneType,
} from '../../db/index';
import type { getAuthToken as getAuthTokenType } from './helpers/auth-helper';
import request from 'supertest';

jest.mock('../../lib/llm-client', () => ({
  chatComplete: jest.fn(),
  getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
  isValidModel: jest.fn().mockReturnValue(true),
  DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
  resolveVaultProvider: jest.fn().mockReturnValue(null),
  getModelInfo: jest.fn().mockReturnValue(undefined),
  SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
}));

let app: Express;
let tmpDir: string;
let authToken: string;
let workspaceId: string;
let getAuthToken: typeof getAuthTokenType;
let queryOne: typeof queryOneType;
let execute: typeof executeType;

// Note: frontmatter name overrides the input name in SkillRegistry.install
// Use unique frontmatter names per test to avoid collisions
function makeSkillContent(name: string, description: string): string {
  return `---
name: ${name}
description: ${description}
version: 1.0.0
---

# ${name}

This skill is for testing purposes.

## Usage

Use this skill when testing.
`;
}

beforeAll(() => {
  process.env.NODE_ENV = 'test';

  const serverMod = require('../../server');
  app = serverMod.default;
  ({ getAuthToken } = require('./helpers/auth-helper'));
  ({ queryOne, execute } = require('../../db/index'));
});

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-skills-test-'));

  const fixtureId = path.basename(tmpDir);
  authToken = await getAuthToken(app, {
    email: `${fixtureId}@skills.test`,
    role: 'admin',
  });

  workspaceId = `ws-skills-test-${fixtureId}`;
  await execute(
    'INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3)',
    [workspaceId, 'Skills Test Workspace', tmpDir],
  );
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(async () => {
  const { closePool } = require('../../db/index');
  await closePool();
});

// ─── GET /api/skills ──────────────────────────────────────────────────────

describe('GET /api/skills', () => {
  test('returns empty skills array when no workspace skills exist', async () => {
    const res = await request(app)
      .get('/api/skills')
      .set('Authorization', `Bearer ${authToken}`)
      .query({ workspaceId });

    expect(res.status).toBe(200);
    expect(res.body.skills).toBeDefined();
    expect(Array.isArray(res.body.skills)).toBe(true);
    expect(res.body.warnings).toBeDefined();
  });

  test('discovers skill files from workspace .rorca/skills/', async () => {
    // Create a skill file in the workspace
    const skillsDir = path.join(tmpDir, '.rorca', 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'test-skill.md'), makeSkillContent('test-skill', 'A test skill'));

    const res = await request(app)
      .get('/api/skills')
      .set('Authorization', `Bearer ${authToken}`)
      .query({ workspaceId });

    expect(res.status).toBe(200);
    expect(res.body.skills.length).toBeGreaterThanOrEqual(1);
    const names = res.body.skills.map((s: any) => s.name);
    expect(names).toContain('test-skill');
  });
});

// ─── POST /api/skills/install ─────────────────────────────────────────────

describe('POST /api/skills/install', () => {
  test('installs a skill from content and creates DB entry', async () => {
    const skillName = 'my-test-skill';
    const res = await request(app)
      .post('/api/skills/install')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        name: skillName,
        content: makeSkillContent(skillName, 'A test skill'),
        source: 'user',
        workspaceId,
      });

    expect(res.status).toBe(201);
    expect(res.body.name).toBeDefined();
    expect(res.body.description).toBeDefined();

    // Verify DB entry was created (name comes from frontmatter)
    const row = await queryOne<{ content: string }>(
      `SELECT content FROM installed_skills WHERE workspace_id = $1 AND name = $2`,
      [workspaceId, skillName],
    );
    expect(row).toBeDefined();
    expect(row?.content).toContain(skillName);
  });

  test('returns 400 when name is missing', async () => {
    const res = await request(app)
      .post('/api/skills/install')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ content: '# skill content', workspaceId });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/i);
  });

  test('returns 400 when content is missing', async () => {
    const res = await request(app)
      .post('/api/skills/install')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ name: 'my-skill', workspaceId });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/content/i);
  });
  test('returns 400 when workspaceId is missing instead of selecting the first workspace', async () => {
    const res = await request(app)
      .post('/api/skills/install')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        name: 'unscoped-skill',
        content: makeSkillContent('unscoped-skill', 'Must remain uninstalled'),
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/workspaceId/i);
  });

});
describe('workspace-scoped registry installs', () => {
  test.each([
    ['/api/skills/install-from-sh', { name: 'secure-review' }],
    ['/api/skills/install-from-github', { repoUrl: 'owner/repo', skillPath: 'skills/secure-review/SKILL.md' }],
  ])('%s rejects an omitted workspaceId before fetching upstream content', async (route, body) => {
    const res = await request(app)
      .post(route)
      .set('Authorization', `Bearer ${authToken}`)
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/workspaceId/i);
  });
});


// ─── GET /api/skills/:name/content ────────────────────────────────────────

describe('POST /api/skills/search', () => {
  test('returns 400 for queries shorter than 2 characters', async () => {
    const res = await request(app)
      .post('/api/skills/search')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ query: 'g' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least 2 characters/i);
  });
});

// ─── GET /api/skills/:name/content ────────────────────────────────────────

describe('GET /api/skills/:name/content', () => {
  test('returns content for an installed skill', async () => {
    // Install a skill first
    const skillName = 'content-test-skill';
    await request(app)
      .post('/api/skills/install')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        name: skillName,
        content: makeSkillContent(skillName, 'Content test skill'),
        source: 'user',
        workspaceId,
      });

    const res = await request(app)
      .get(`/api/skills/${skillName}/content`)
      .set('Authorization', `Bearer ${authToken}`)
      .query({ workspaceId });

    expect(res.status).toBe(200);
    expect(res.body.content).toBeDefined();
    expect(res.body.name).toBeDefined();
  });

  test('returns 404 for non-existent skill', async () => {
    const res = await request(app)
      .get('/api/skills/nonexistent-skill-xyz/content')
      .set('Authorization', `Bearer ${authToken}`)
      .query({ workspaceId });

    expect(res.status).toBe(404);
  });
});

// ─── DELETE /api/skills/:name ─────────────────────────────────────────────

describe('DELETE /api/skills/:name', () => {
  test('removes an installed skill from DB', async () => {
    const skillName = 'skill-to-delete';
    // Install a skill first
    await request(app)
      .post('/api/skills/install')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        name: skillName,
        content: makeSkillContent(skillName, 'Skill to delete'),
        source: 'user',
        workspaceId,
      });

    // Verify it exists
    const before = await queryOne(`SELECT * FROM installed_skills WHERE workspace_id = $1 AND name = $2`, [workspaceId, skillName]);
    expect(before).toBeDefined();

    const res = await request(app)
      .delete(`/api/skills/${skillName}`)
      .set('Authorization', `Bearer ${authToken}`)
      .query({ workspaceId });

    expect(res.status).toBe(200);

    // Verify it's gone from DB
    const after = await queryOne(`SELECT * FROM installed_skills WHERE workspace_id = $1 AND name = $2`, [workspaceId, skillName]);
    expect(after).toBeUndefined();
  });

  test('returns 404 for non-existent skill', async () => {
    const res = await request(app)
      .delete('/api/skills/does-not-exist-xyz')
      .set('Authorization', `Bearer ${authToken}`)
      .query({ workspaceId });

    expect(res.status).toBe(404);
  });
});

describe('workspace isolation', () => {
  test('isolates same-name install, list, content, and removal across workspaces', async () => {
    const workspaceBId = `${workspaceId}-b`;
    const workspaceBPath = path.join(tmpDir, 'workspace-b');
    fs.mkdirSync(workspaceBPath, { recursive: true });
    await execute(
      'INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3)',
      [workspaceBId, 'Skills Test Workspace B', workspaceBPath],
    );

    const skillName = `shared-skill-${Date.now()}`;
    const contentA = makeSkillContent(skillName, 'Workspace A guidance');
    const contentB = makeSkillContent(skillName, 'Workspace B guidance');

    for (const [scope, content] of [[workspaceId, contentA], [workspaceBId, contentB]]) {
      const install = await request(app)
        .post('/api/skills/install')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ name: skillName, content, source: 'user', workspaceId: scope });
      expect(install.status).toBe(201);
    }

    const rows = await queryOne<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM installed_skills WHERE name = $1 AND workspace_id IN ($2, $3)',
      [skillName, workspaceId, workspaceBId],
    );
    expect(rows?.count).toBe('2');

    const [listA, listB] = await Promise.all([
      request(app).get('/api/skills').set('Authorization', `Bearer ${authToken}`).query({ workspaceId }),
      request(app).get('/api/skills').set('Authorization', `Bearer ${authToken}`).query({ workspaceId: workspaceBId }),
    ]);
    expect(listA.status).toBe(200);
    expect(listB.status).toBe(200);
    expect(listA.body.skills.find((skill: { name: string }) => skill.name === skillName)?.description).toBe('Workspace A guidance');
    expect(listB.body.skills.find((skill: { name: string }) => skill.name === skillName)?.description).toBe('Workspace B guidance');

    const [readA, readB] = await Promise.all([
      request(app).get(`/api/skills/${skillName}/content`).set('Authorization', `Bearer ${authToken}`).query({ workspaceId }),
      request(app).get(`/api/skills/${skillName}/content`).set('Authorization', `Bearer ${authToken}`).query({ workspaceId: workspaceBId }),
    ]);
    expect(readA.status).toBe(200);
    expect(readA.body.content).toBe(contentA);
    expect(readB.status).toBe(200);
    expect(readB.body.content).toBe(contentB);

    const removeB = await request(app)
      .delete(`/api/skills/${skillName}`)
      .set('Authorization', `Bearer ${authToken}`)
      .query({ workspaceId: workspaceBId });
    expect(removeB.status).toBe(200);

    const inspectB = await request(app)
      .get(`/api/skills/${skillName}/content`)
      .set('Authorization', `Bearer ${authToken}`)
      .query({ workspaceId: workspaceBId });
    expect(inspectB.status).toBe(404);

    const removeAcrossB = await request(app)
      .delete(`/api/skills/${skillName}`)
      .set('Authorization', `Bearer ${authToken}`)
      .query({ workspaceId: workspaceBId });
    expect(removeAcrossB.status).toBe(404);

    const retainedA = await request(app)
      .get(`/api/skills/${skillName}/content`)
      .set('Authorization', `Bearer ${authToken}`)
      .query({ workspaceId });
    expect(retainedA.status).toBe(200);
    expect(retainedA.body.content).toBe(contentA);
  });

  test('keeps retained legacy rows inaccessible from user-workspace reads and mutations', async () => {
    const legacyWorkspaceId = 'rorca:system:legacy-installed-skills';
    const legacySkillName = `legacy-unscoped-${Date.now()}`;
    await execute(
      `INSERT INTO workspaces (id, label, path)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [
        legacyWorkspaceId,
        '[System] Legacy Installed Skills (unscoped)',
        'system://legacy-installed-skills',
      ],
    );
    await execute(
      `INSERT INTO installed_skills (workspace_id, name, description, source, content)
       VALUES ($1, $2, $3, $4, $5)`,
      [legacyWorkspaceId, legacySkillName, 'Legacy unscoped skill', 'legacy', '# legacy'],
    );

    const scopedList = await request(app)
      .get('/api/skills')
      .set('Authorization', `Bearer ${authToken}`)
      .query({ workspaceId });
    expect(scopedList.status).toBe(200);
    expect(scopedList.body.skills.some((skill: { name: string }) => skill.name === legacySkillName)).toBe(false);

    const legacyRead = await request(app)
      .get(`/api/skills/${legacySkillName}/content`)
      .set('Authorization', `Bearer ${authToken}`)
      .query({ workspaceId: legacyWorkspaceId });
    expect(legacyRead.status).toBe(400);

    const legacyRemove = await request(app)
      .delete(`/api/skills/${legacySkillName}`)
      .set('Authorization', `Bearer ${authToken}`)
      .query({ workspaceId: legacyWorkspaceId });
    expect(legacyRemove.status).toBe(400);

    const retained = await queryOne<{ name: string }>(
      'SELECT name FROM installed_skills WHERE workspace_id = $1 AND name = $2',
      [legacyWorkspaceId, legacySkillName],
    );
    expect(retained?.name).toBe(legacySkillName);
  });

  test('rejects install into an invalid workspace', async () => {
    const response = await request(app)
      .post('/api/skills/install')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        name: 'invalid-workspace-skill',
        content: makeSkillContent('invalid-workspace-skill', 'Must not persist'),
        workspaceId: 'workspace-does-not-exist',
      });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/workspace/i);
  });

  test('cascades installed skills when their owning workspace is deleted', async () => {
    const ownedWorkspaceId = `${workspaceId}-cascade`;
    await execute(
      'INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3)',
      [ownedWorkspaceId, 'Cascade Workspace', path.join(tmpDir, 'cascade-workspace')],
    );
    const skillName = `cascade-skill-${Date.now()}`;
    const install = await request(app)
      .post('/api/skills/install')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        name: skillName,
        content: makeSkillContent(skillName, 'Workspace-owned'),
        workspaceId: ownedWorkspaceId,
      });
    expect(install.status).toBe(201);

    await execute('DELETE FROM workspaces WHERE id = $1', [ownedWorkspaceId]);
    const retained = await queryOne<{ name: string }>(
      'SELECT name FROM installed_skills WHERE workspace_id = $1 AND name = $2',
      [ownedWorkspaceId, skillName],
    );
    expect(retained).toBeUndefined();
  });

  test.each([
    ['GET', '/api/skills'],
    ['GET', '/api/skills/unknown/content'],
    ['DELETE', '/api/skills/unknown'],
  ])('%s %s rejects an invalid workspace', async (method, route) => {
    const scopedRequest = method === 'DELETE'
      ? request(app).delete(route)
      : request(app).get(route);
    const response = await scopedRequest
      .set('Authorization', `Bearer ${authToken}`)
      .query({ workspaceId: 'workspace-does-not-exist' });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/workspace/i);
  });
});
