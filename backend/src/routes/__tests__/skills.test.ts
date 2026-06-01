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
import { getAuthToken } from './helpers/auth-helper';
import { queryOne, execute } from '../../db/index';

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

beforeEach(async () => {
  jest.resetModules();

  jest.mock('../../lib/llm-client', () => ({
    chatComplete: jest.fn(),
    getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
    isValidModel: jest.fn().mockReturnValue(true),
    DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
    resolveVaultProvider: jest.fn().mockReturnValue(null),
    getModelInfo: jest.fn().mockReturnValue(undefined),
    SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
  }));

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-skills-test-'));
  const _dbPath = path.join(tmpDir, 'test.db');
process.env.NODE_ENV = 'test';

  const serverMod = require('../../server');
  app = serverMod.default;
authToken = await getAuthToken(app);

  workspaceId = 'ws-skills-test-' + Date.now();
  await execute(`INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`, [workspaceId,
    'Skills Test Workspace',
    tmpDir,]);
});

afterEach(async () => {
  // Close the fresh pool created by jest.resetModules() + require('../../server') to prevent connection exhaustion
  try { const { closePool } = require('../../db/index'); await closePool(); } catch {}
fs.rmSync(tmpDir, { recursive: true, force: true });
delete process.env.NODE_ENV;
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
      });

    expect(res.status).toBe(201);
    expect(res.body.name).toBeDefined();
    expect(res.body.description).toBeDefined();

    // Verify DB entry was created (name comes from frontmatter)
    const row = await queryOne(`SELECT * FROM installed_skills WHERE name = $1`, [skillName]) as any;
    expect(row).toBeDefined();
    expect(row.content).toContain(skillName);
  });

  test('returns 400 when name is missing', async () => {
    const res = await request(app)
      .post('/api/skills/install')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ content: '# skill content' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/i);
  });

  test('returns 400 when content is missing', async () => {
    const res = await request(app)
      .post('/api/skills/install')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ name: 'my-skill' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/content/i);
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
      });

    // Verify it exists
    const before = await queryOne(`SELECT * FROM installed_skills WHERE name = $1`, [skillName]);
    expect(before).toBeDefined();

    const res = await request(app)
      .delete(`/api/skills/${skillName}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);

    // Verify it's gone from DB
    const after = await queryOne(`SELECT * FROM installed_skills WHERE name = $1`, [skillName]);
    expect(after).toBeUndefined();
  });

  test('returns 404 for non-existent skill', async () => {
    const res = await request(app)
      .delete('/api/skills/does-not-exist-xyz')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(404);
  });
});
