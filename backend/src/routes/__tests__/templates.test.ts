/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import crypto from 'crypto';
import { once } from 'events';
import type { Server } from 'http';
import type { Express } from 'express';
import request from 'supertest';
import { ensureTestUser, getAuthToken } from './helpers/auth-helper';
import { execute } from '../../db/index';
import type { CompileSpecPlanInput, CompileSpecPlanResult } from '../../lib/ssdlc-plan-service';

// Mock llm-client before any imports that use it
jest.mock('../../lib/llm-client', () => ({
  chatComplete: jest.fn(),
  getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
  isValidModel: jest.fn().mockImplementation((m: string) =>
    ['claude-sonnet-4-5-20250929', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'].includes(m)
  ),
  DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
  resolveVaultProvider: jest.fn().mockReturnValue(null),
  getModelInfo: jest.fn().mockReturnValue(undefined),
  SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'],
}));

jest.mock('../../lib/ssdlc-plan-service', () => {
  const actual = jest.requireActual('../../lib/ssdlc-plan-service');
  const { GENERAL_SDLC_7_PROFILE } = jest.requireActual('../../ssdlc/profiles/general-sdlc-7');
  return {
    ...actual,
    compileSpecPlan: jest.fn(async (
      input: CompileSpecPlanInput,
    ): Promise<CompileSpecPlanResult> => ({
      status: 'compiled',
      specSlug: input.specSlug,
      specVersion: String(input.expectedSaveGeneration ?? 1),
      specHash: `sha256:${'a'.repeat(64)}` as const,
      inputHash: `sha256:${'b'.repeat(64)}` as const,
      planId: `fixture-plan-${input.specSlug}`,
      planVersion: 1,
      compilerVersion: 'ssdlc-plan-compiler-5',
      profileHash: GENERAL_SDLC_7_PROFILE.contentHash,
      profiles: ['code-change'],
      riskLevel: 'low',
      generatedAt: '2026-07-15T12:00:00.000Z',
      saveGeneration: input.expectedSaveGeneration ?? null,
    })),
  };
});

let app: Server;
let tmpDir: string;
let mockChatComplete: jest.Mock;
let authToken: string;
let userId: string;
const otherUserIds = new Set<string>();
const TEMPLATE_WORKSPACE_IDS = {
  withTemplate: `ws-template-${crypto.randomUUID()}`,
  withoutTemplate: `ws-template-${crypto.randomUUID()}`,
  missingTemplate: `ws-template-${crypto.randomUUID()}`,
};

const sampleStoryStructure = [
  { id: 'US-001', title: 'User login', description: 'Allow users to log in' },
  { id: 'US-002', title: 'Dashboard', description: 'Show user dashboard' },
];

const validLlmResponse = JSON.stringify({
  stories: [
    {
      id: 'US-001',
      title: 'Generated story',
      description: 'A generated story',
      acceptanceCriteria: ['AC1', 'AC2', 'AC3'],
      dependsOn: [],
    },
  ],
});

async function cleanFixture(): Promise<void> {
  const ownerIds = [userId, ...otherUserIds];
  await execute('DELETE FROM templates WHERE author_id = ANY($1::text[])', [ownerIds]);
  await execute('DELETE FROM team_members WHERE user_id = ANY($1::text[])', [ownerIds]);
  await execute('DELETE FROM teams WHERE owner_id = ANY($1::text[])', [ownerIds]);
  for (const otherUserId of otherUserIds) {
    await execute('DELETE FROM users WHERE id = $1', [otherUserId]);
  }
  otherUserIds.clear();
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  const authId = crypto.randomUUID();
  const email = `templates-${crypto.randomUUID()}@test.rorca.local`;
  const user = await ensureTestUser({ email, authId, role: 'admin', plan: 'pro' });
  userId = user.id;
  const serverModule = require('../../server');
  const expressApp = serverModule.default as Express;
  const llmClient = require('../../lib/llm-client');
  mockChatComplete = llmClient.chatComplete;
  authToken = await getAuthToken(expressApp, {
    email,
    authId,
    role: 'admin',
    displayName: 'Auth Test User',
  });
  app = expressApp.listen(0, '127.0.0.1');
  await once(app, 'listening');
});

beforeEach(async () => {
  jest.clearAllMocks();
  await cleanFixture();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-templates-test-'));
});

afterEach(async () => {
  await cleanFixture();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(async () => {
  await cleanFixture();
  await execute('DELETE FROM users WHERE id = $1', [userId]);
  app.closeAllConnections();
  await new Promise<void>((resolve, reject) => app.close(error => error ? reject(error) : resolve()));
  delete process.env.NODE_ENV;
});

async function getUserId(): Promise<string> {
  return userId;
}

async function createTeam(name: string, slug: string): Promise<string> {
  const userId = await getUserId();
  const teamId = crypto.randomUUID();
  await execute(
    `INSERT INTO teams (id, name, slug, owner_id) VALUES ($1, $2, $3, $4)`,
    [teamId, name, `${slug}-${teamId}`, userId],
  );
  await execute(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'admin')`, [teamId, userId]);
  return teamId;
}

// ─── POST /api/templates ──────────────────────────────────────────────────────

describe('POST /api/templates', () => {
  test('creates a template and returns 201 with full body', async () => {
    const res = await request(app)
      .post('/api/templates')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        name: 'Auth Template',
        description: 'Template for auth features',
        sourceSpecId: 'auth-system',
        brief: 'Build authentication with login and signup',
        storyStructure: sampleStoryStructure,
        directionLayers: { l1: true, l2: 'backend' },
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.name).toBe('Auth Template');
    expect(res.body.description).toBe('Template for auth features');
    expect(res.body.sourceSpecId).toBe('auth-system');
    expect(res.body.brief).toBe('Build authentication with login and signup');
    expect(res.body.storyStructure).toEqual(sampleStoryStructure);
    expect(res.body.directionLayers).toEqual({ l1: true, l2: 'backend' });
    expect(res.body.storyCount).toBe(2);
    expect(res.body.createdAt).toBeDefined();
    expect(res.body.authorId).toBe(await getUserId());
    expect(res.body.teamId).toBeNull();
    expect(res.body.usageCount).toBe(0);
    expect(res.body.avgRating).toBe(0);
    expect(res.body.ratingCount).toBe(0);
  });

  test('creates template without optional fields', async () => {
    const res = await request(app)
      .post('/api/templates')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        name: 'Minimal Template',
        sourceSpecId: 'some-spec',
        brief: 'A brief',
        storyStructure: [{ id: 'US-001', title: 'Story', description: 'Desc' }],
      });

    expect(res.status).toBe(201);
    expect(res.body.description).toBeNull();
    expect(res.body.directionLayers).toBeNull();
    expect(res.body.storyCount).toBe(1);
  });

  test('creates team template when teamId is provided', async () => {
    const teamId = await createTeam('Test Team', 'test-team');

    const res = await request(app)
      .post('/api/templates')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        name: 'Team Template',
        sourceSpecId: 'spec-1',
        brief: 'Team brief',
        storyStructure: sampleStoryStructure,
        teamId,
      });

    expect(res.status).toBe(201);
    expect(res.body.teamId).toBe(teamId);
  });

  test('rejects teamId when user is not a member', async () => {
    // Create a team the user is NOT a member of
    const teamId = crypto.randomUUID();
    const otherUserId = crypto.randomUUID();
    otherUserIds.add(otherUserId);
    await execute(
      `INSERT INTO users (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4)`,
      [otherUserId, `templates-other-${otherUserId}@test.rorca.local`, 'Other', '$2a$12$fakeHash'],
    );
    await execute(
      `INSERT INTO teams (id, name, slug, owner_id) VALUES ($1, $2, $3, $4)`,
      [teamId, 'Other Team', `other-${teamId}`, otherUserId],
    );

    const res = await request(app)
      .post('/api/templates')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        name: 'Forbidden',
        sourceSpecId: 'spec-1',
        brief: 'brief',
        storyStructure: sampleStoryStructure,
        teamId,
      });

    expect(res.status).toBe(403);
  });

  test('missing required fields → 400', async () => {
    const res = await request(app)
      .post('/api/templates')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ name: 'Incomplete' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Missing required fields');
  });

  test('empty storyStructure array → 400', async () => {
    const res = await request(app)
      .post('/api/templates')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        name: 'Bad Template',
        sourceSpecId: 'spec-1',
        brief: 'A brief',
        storyStructure: [],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('non-empty array');
  });

  test('storyStructure not an array → 400', async () => {
    const res = await request(app)
      .post('/api/templates')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        name: 'Bad Template',
        sourceSpecId: 'spec-1',
        brief: 'A brief',
        storyStructure: 'not-array',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('non-empty array');
  });
});

// ─── GET /api/templates — scope filtering ────────────────────────────────────

describe('GET /api/templates', () => {
  test('returns empty array when no templates exist', async () => {
    const res = await request(app).get('/api/templates').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  test('scope=all returns personal and team templates', async () => {
    const teamId = await createTeam('My Team', 'my-team');

    // Personal template
    await request(app).post('/api/templates').set('Authorization', `Bearer ${authToken}`).send({
      name: 'Personal', sourceSpecId: 'spec-p', brief: 'p', storyStructure: sampleStoryStructure,
    });
    // Team template
    await request(app).post('/api/templates').set('Authorization', `Bearer ${authToken}`).send({
      name: 'Team', sourceSpecId: 'spec-t', brief: 't', storyStructure: sampleStoryStructure, teamId,
    });

    const res = await request(app).get('/api/templates?scope=all').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
  });

  test('scope=personal returns only personal templates', async () => {
    const teamId = await createTeam('T', 'team-scope');

    await request(app).post('/api/templates').set('Authorization', `Bearer ${authToken}`).send({
      name: 'Personal', sourceSpecId: 'spec-p', brief: 'p', storyStructure: sampleStoryStructure,
    });
    await request(app).post('/api/templates').set('Authorization', `Bearer ${authToken}`).send({
      name: 'Team', sourceSpecId: 'spec-t', brief: 't', storyStructure: sampleStoryStructure, teamId,
    });

    const res = await request(app).get('/api/templates?scope=personal').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].name).toBe('Personal');
  });

  test('scope=team returns only team templates', async () => {
    const teamId = await createTeam('T', 'team-scope-2');

    await request(app).post('/api/templates').set('Authorization', `Bearer ${authToken}`).send({
      name: 'Personal', sourceSpecId: 'spec-p', brief: 'p', storyStructure: sampleStoryStructure,
    });
    await request(app).post('/api/templates').set('Authorization', `Bearer ${authToken}`).send({
      name: 'Team', sourceSpecId: 'spec-t', brief: 't', storyStructure: sampleStoryStructure, teamId,
    });

    const res = await request(app).get('/api/templates?scope=team').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].name).toBe('Team');
  });

  test('featured templates (rating >= 4.0) appear first', async () => {
    // Create two templates
    const _res1 = await request(app).post('/api/templates').set('Authorization', `Bearer ${authToken}`).send({
      name: 'Low Rated', sourceSpecId: 'spec-low', brief: 'low', storyStructure: sampleStoryStructure,
    });
    const res2 = await request(app).post('/api/templates').set('Authorization', `Bearer ${authToken}`).send({
      name: 'High Rated', sourceSpecId: 'spec-high', brief: 'high', storyStructure: sampleStoryStructure,
    });

    // Rate the second one highly
    await request(app).post(`/api/templates/${res2.body.id}/rate`).set('Authorization', `Bearer ${authToken}`)
      .send({ rating: 5 });

    const listRes = await request(app).get('/api/templates').set('Authorization', `Bearer ${authToken}`);
    expect(listRes.body.items[0].name).toBe('High Rated');
    expect(listRes.body.items[0].avgRating).toBeGreaterThanOrEqual(4.0);
  });

  test('list includes author info, usage count, and rating', async () => {
    await request(app).post('/api/templates').set('Authorization', `Bearer ${authToken}`).send({
      name: 'Template A', sourceSpecId: 'spec-a', brief: 'Brief A', storyStructure: sampleStoryStructure,
    });

    const res = await request(app).get('/api/templates').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    const tpl = res.body.items[0];
    expect(tpl.authorName).toBe('Auth Test User');
    expect(tpl.usageCount).toBe(0);
    expect(tpl.avgRating).toBe(0);
    expect(tpl.ratingCount).toBe(0);
  });
});

// ─── POST /api/templates/:id/rate ────────────────────────────────────────────

describe('POST /api/templates/:id/rate', () => {
  test('rates a template and returns updated rating', async () => {
    const createRes = await request(app).post('/api/templates').set('Authorization', `Bearer ${authToken}`).send({
      name: 'Rateable', sourceSpecId: 'spec-r', brief: 'b', storyStructure: sampleStoryStructure,
    });

    const rateRes = await request(app)
      .post(`/api/templates/${createRes.body.id}/rate`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ rating: 4 });

    expect(rateRes.status).toBe(200);
    expect(rateRes.body.avgRating).toBe(4);
    expect(rateRes.body.ratingCount).toBe(1);
    expect(rateRes.body.userRating).toBe(4);
  });

  test('updates existing rating (upsert)', async () => {
    const createRes = await request(app).post('/api/templates').set('Authorization', `Bearer ${authToken}`).send({
      name: 'Rateable', sourceSpecId: 'spec-r2', brief: 'b', storyStructure: sampleStoryStructure,
    });

    await request(app).post(`/api/templates/${createRes.body.id}/rate`).set('Authorization', `Bearer ${authToken}`)
      .send({ rating: 3 });
    const rateRes = await request(app).post(`/api/templates/${createRes.body.id}/rate`).set('Authorization', `Bearer ${authToken}`)
      .send({ rating: 5 });

    expect(rateRes.body.avgRating).toBe(5);
    expect(rateRes.body.ratingCount).toBe(1); // Still 1 (same user updated)
    expect(rateRes.body.userRating).toBe(5);
  });

  test('invalid rating → 400', async () => {
    const createRes = await request(app).post('/api/templates').set('Authorization', `Bearer ${authToken}`).send({
      name: 'R', sourceSpecId: 's', brief: 'b', storyStructure: sampleStoryStructure,
    });

    const res = await request(app).post(`/api/templates/${createRes.body.id}/rate`).set('Authorization', `Bearer ${authToken}`)
      .send({ rating: 6 });
    expect(res.status).toBe(400);

    const res2 = await request(app).post(`/api/templates/${createRes.body.id}/rate`).set('Authorization', `Bearer ${authToken}`)
      .send({ rating: 0 });
    expect(res2.status).toBe(400);

    const res3 = await request(app).post(`/api/templates/${createRes.body.id}/rate`).set('Authorization', `Bearer ${authToken}`)
      .send({ rating: 3.5 });
    expect(res3.status).toBe(400);
  });

  test('nonexistent template → 404', async () => {
    const res = await request(app).post('/api/templates/nonexistent/rate').set('Authorization', `Bearer ${authToken}`)
      .send({ rating: 3 });
    expect(res.status).toBe(404);
  });

  test('non-team-member cannot rate team template', async () => {
    // Create a team the test user is NOT a member of
    const otherUserId = crypto.randomUUID();
    otherUserIds.add(otherUserId);
    await execute(
      `INSERT INTO users (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4)`,
      [otherUserId, `templates-owner-${otherUserId}@test.rorca.local`, 'Owner', '$2a$12$fakeHash'],
    );
    const teamId = crypto.randomUUID();
    await execute(
      `INSERT INTO teams (id, name, slug, owner_id) VALUES ($1, $2, $3, $4)`,
      [teamId, 'Other Team', `other-rate-${teamId}`, otherUserId],
    );

    const tplId = crypto.randomUUID();
    await execute(`INSERT INTO templates (id, name, source_spec_id, brief, story_structure, story_count, team_id, author_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [tplId, 'Team TPL', 'spec', 'b', '[]', 0, teamId, otherUserId]);

    const res = await request(app).post(`/api/templates/${tplId}/rate`).set('Authorization', `Bearer ${authToken}`)
      .send({ rating: 3 });
    expect(res.status).toBe(403);
  });
});

// ─── GET /api/templates/:id ───────────────────────────────────────────────────

describe('GET /api/templates/:id', () => {
  test('returns full template details with rating info', async () => {
    const createRes = await request(app).post('/api/templates').set('Authorization', `Bearer ${authToken}`).send({
      name: 'Detail Template', sourceSpecId: 'spec-d', brief: 'Detailed brief', storyStructure: sampleStoryStructure,
    });

    // Rate it
    await request(app).post(`/api/templates/${createRes.body.id}/rate`).set('Authorization', `Bearer ${authToken}`)
      .send({ rating: 4 });

    const res = await request(app).get(`/api/templates/${createRes.body.id}`).set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Detail Template');
    expect(res.body.brief).toBe('Detailed brief');
    expect(res.body.storyStructure).toEqual(sampleStoryStructure);
    expect(res.body.avgRating).toBe(4);
    expect(res.body.ratingCount).toBe(1);
    expect(res.body.userRating).toBe(4);
  });

  test('userRating is null when user has not rated', async () => {
    const createRes = await request(app).post('/api/templates').set('Authorization', `Bearer ${authToken}`).send({
      name: 'Unrated', sourceSpecId: 'spec-u', brief: 'b', storyStructure: sampleStoryStructure,
    });

    const res = await request(app).get(`/api/templates/${createRes.body.id}`).set('Authorization', `Bearer ${authToken}`);
    expect(res.body.userRating).toBeNull();
  });

  test('not found → 404', async () => {
    const res = await request(app).get('/api/templates/nonexistent-id').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Template not found');
  });
});

// ─── DELETE /api/templates/:id ────────────────────────────────────────────────

describe('DELETE /api/templates/:id', () => {
  test('deletes template and returns 204', async () => {
    const createRes = await request(app).post('/api/templates').set('Authorization', `Bearer ${authToken}`).send({
      name: 'To Delete', sourceSpecId: 'spec-del', brief: 'Brief', storyStructure: sampleStoryStructure,
    });

    const deleteRes = await request(app).delete(`/api/templates/${createRes.body.id}`).set('Authorization', `Bearer ${authToken}`);
    expect(deleteRes.status).toBe(204);

    // Verify it's gone
    const getRes = await request(app).get(`/api/templates/${createRes.body.id}`).set('Authorization', `Bearer ${authToken}`);
    expect(getRes.status).toBe(404);
  });

  test('not found → 404', async () => {
    const res = await request(app).delete('/api/templates/nonexistent-id').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Template not found');
  });
});

// ─── workspace-agnostic templates ─────────────────────────────────────────────

describe('workspace-agnostic templates', () => {
  test('templates are available without any workspace context', async () => {
    const createRes = await request(app).post('/api/templates').set('Authorization', `Bearer ${authToken}`).send({
      name: 'Global Template', sourceSpecId: 'any-spec', brief: 'Works anywhere', storyStructure: sampleStoryStructure,
    });
    expect(createRes.status).toBe(201);

    const listRes = await request(app).get('/api/templates').set('Authorization', `Bearer ${authToken}`);
    expect(listRes.body.items).toHaveLength(1);
    expect(listRes.body.items[0].name).toBe('Global Template');
  });
});

// ─── templateId in spec generation ────────────────────────────────────────────

describe('POST /api/specs/generate with templateId', () => {
  test('includes template context in LLM prompt when templateId is valid', async () => {
    mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 10, outputTokens: 20 } });

    // Seed workspace
    await execute(
      `INSERT INTO workspaces (id, label, path) VALUES ($1, 'TPL WS', $2)`,
      [TEMPLATE_WORKSPACE_IDS.withTemplate, tmpDir],
    );

    // Create a template
    const tplRes = await request(app).post('/api/templates').set('Authorization', `Bearer ${authToken}`).send({
      name: 'Auth Pattern', sourceSpecId: 'auth-v1', brief: 'Build auth with login and signup',
      storyStructure: sampleStoryStructure,
    });

    // Generate spec using template
    const res = await request(app)
      .post('/api/specs/generate')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: TEMPLATE_WORKSPACE_IDS.withTemplate,
        title: 'New Auth',
        brief: 'Build new auth feature',
        templateId: tplRes.body.id,
        postSave: { enrich: false, matchSkills: false, memorySynthesis: false },
      });

    expect(res.status).toBe(200);

    const calledPrompt = mockChatComplete.mock.calls[0][0][0].content;
    expect(calledPrompt).toContain('REFERENCE TEMPLATE');
    expect(calledPrompt).toContain('Build auth with login and signup');
    expect(calledPrompt).toContain('User login');
    expect(calledPrompt).toContain('Dashboard');
  });

  test('generates normally when templateId is not provided', async () => {
    mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 10, outputTokens: 20 } });

    await execute(
      `INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path`,
      [TEMPLATE_WORKSPACE_IDS.withoutTemplate, 'TPL WS2', tmpDir],
    );

    const res = await request(app)
      .post('/api/specs/generate')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: TEMPLATE_WORKSPACE_IDS.withoutTemplate,
        title: 'No Template',
        brief: 'Build something',
        postSave: { enrich: false, matchSkills: false, memorySynthesis: false },
      });

    expect(res.status).toBe(200);

    const calledPrompt = mockChatComplete.mock.calls[0][0][0].content;
    expect(calledPrompt).not.toContain('REFERENCE TEMPLATE');
  });

  test('generates normally when templateId does not exist in DB', async () => {
    mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 10, outputTokens: 20 } });

    await execute(
      `INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path`,
      [TEMPLATE_WORKSPACE_IDS.missingTemplate, 'TPL WS3', tmpDir],
    );

    const res = await request(app)
      .post('/api/specs/generate')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: TEMPLATE_WORKSPACE_IDS.missingTemplate,
        title: 'Bad Template Ref',
        brief: 'Build something',
        templateId: 'nonexistent-template-id',
        postSave: { enrich: false, matchSkills: false, memorySynthesis: false },
      });

    expect(res.status).toBe(200);

    const calledPrompt = mockChatComplete.mock.calls[0][0][0].content;
    expect(calledPrompt).not.toContain('REFERENCE TEMPLATE');
  });
});
