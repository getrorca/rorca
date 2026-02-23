import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import request from 'supertest';

// Mock llm-client before any imports that use it
jest.mock('../../lib/llm-client', () => ({
  chatComplete: jest.fn(),
  getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
  isValidModel: jest.fn().mockImplementation((m: string) =>
    ['claude-sonnet-4-5-20250929', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'].includes(m)
  ),
  DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
  SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'],
}));

let app: Express;
let db: Database.Database;
let tmpDir: string;
let mockChatComplete: jest.Mock;

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

beforeEach(() => {
  jest.resetModules();

  jest.mock('../../lib/llm-client', () => ({
    chatComplete: jest.fn(),
    getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
    isValidModel: jest.fn().mockImplementation((m: string) =>
      ['claude-sonnet-4-5-20250929', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'].includes(m)
    ),
    DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
    SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'],
  }));

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorcha-templates-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  process.env.DB_PATH = dbPath;
  process.env.NODE_ENV = 'test';

  const serverMod = require('../../server');
  app = serverMod.default;
  const dbMod = require('../../db/index');
  db = dbMod.db;

  const llmClient = require('../../lib/llm-client');
  mockChatComplete = llmClient.chatComplete;
});

afterEach(() => {
  const specsRoot = path.join(os.tmpdir(), 'scripts', 'ralph', 'specs');
  if (fs.existsSync(specsRoot)) {
    fs.rmSync(specsRoot, { recursive: true, force: true });
  }

  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
  delete process.env.NODE_ENV;
});

// ─── POST /api/templates ──────────────────────────────────────────────────────

describe('POST /api/templates', () => {
  test('creates a template and returns 201 with full body', async () => {
    const res = await request(app)
      .post('/api/templates')
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
  });

  test('creates template without optional fields', async () => {
    const res = await request(app)
      .post('/api/templates')
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

  test('missing required fields → 400', async () => {
    const res = await request(app)
      .post('/api/templates')
      .send({ name: 'Incomplete' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Missing required fields');
  });

  test('empty storyStructure array → 400', async () => {
    const res = await request(app)
      .post('/api/templates')
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

// ─── GET /api/templates ───────────────────────────────────────────────────────

describe('GET /api/templates', () => {
  test('returns empty array when no templates exist', async () => {
    const res = await request(app).get('/api/templates');
    expect(res.status).toBe(200);
    expect(res.body.templates).toEqual([]);
  });

  test('lists all templates with summary fields', async () => {
    // Create two templates
    await request(app).post('/api/templates').send({
      name: 'Template A',
      sourceSpecId: 'spec-a',
      brief: 'Brief A',
      storyStructure: sampleStoryStructure,
    });
    await request(app).post('/api/templates').send({
      name: 'Template B',
      description: 'Desc B',
      sourceSpecId: 'spec-b',
      brief: 'Brief B',
      storyStructure: [{ id: 'US-001', title: 'S1', description: 'D1' }],
    });

    const res = await request(app).get('/api/templates');
    expect(res.status).toBe(200);
    expect(res.body.templates).toHaveLength(2);

    // Check summary fields are present
    const tpl = res.body.templates[0];
    expect(tpl.id).toBeDefined();
    expect(tpl.name).toBeDefined();
    expect(tpl.sourceSpecId).toBeDefined();
    expect(tpl.storyCount).toBeDefined();
    expect(tpl.createdAt).toBeDefined();

    // List endpoint should NOT include full storyStructure or brief
    expect(tpl.storyStructure).toBeUndefined();
    expect(tpl.brief).toBeUndefined();
  });
});

// ─── GET /api/templates/:id ───────────────────────────────────────────────────

describe('GET /api/templates/:id', () => {
  test('returns full template details', async () => {
    const createRes = await request(app).post('/api/templates').send({
      name: 'Detail Template',
      sourceSpecId: 'spec-d',
      brief: 'Detailed brief',
      storyStructure: sampleStoryStructure,
    });

    const res = await request(app).get(`/api/templates/${createRes.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Detail Template');
    expect(res.body.brief).toBe('Detailed brief');
    expect(res.body.storyStructure).toEqual(sampleStoryStructure);
  });

  test('not found → 404', async () => {
    const res = await request(app).get('/api/templates/nonexistent-id');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Template not found');
  });
});

// ─── DELETE /api/templates/:id ────────────────────────────────────────────────

describe('DELETE /api/templates/:id', () => {
  test('deletes template and returns 204', async () => {
    const createRes = await request(app).post('/api/templates').send({
      name: 'To Delete',
      sourceSpecId: 'spec-del',
      brief: 'Brief',
      storyStructure: sampleStoryStructure,
    });

    const deleteRes = await request(app).delete(`/api/templates/${createRes.body.id}`);
    expect(deleteRes.status).toBe(204);

    // Verify it's gone
    const getRes = await request(app).get(`/api/templates/${createRes.body.id}`);
    expect(getRes.status).toBe(404);
  });

  test('not found → 404', async () => {
    const res = await request(app).delete('/api/templates/nonexistent-id');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Template not found');
  });
});

// ─── Templates are workspace-agnostic ─────────────────────────────────────────

describe('workspace-agnostic templates', () => {
  test('templates are available without any workspace context', async () => {
    // Create template — no workspaceId needed
    const createRes = await request(app).post('/api/templates').send({
      name: 'Global Template',
      sourceSpecId: 'any-spec',
      brief: 'Works anywhere',
      storyStructure: sampleStoryStructure,
    });
    expect(createRes.status).toBe(201);

    // List returns it without filtering by workspace
    const listRes = await request(app).get('/api/templates');
    expect(listRes.body.templates).toHaveLength(1);
    expect(listRes.body.templates[0].name).toBe('Global Template');
  });
});

// ─── templateId in spec generation ────────────────────────────────────────────

describe('POST /api/specs/generate with templateId', () => {
  test('includes template context in LLM prompt when templateId is valid', async () => {
    mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 10, outputTokens: 20 } });

    // Seed workspace
    db.prepare(
      "INSERT INTO workspaces (id, label, path) VALUES ('ws-tpl', 'TPL WS', ?)"
    ).run(os.tmpdir());

    // Create a template
    const tplRes = await request(app).post('/api/templates').send({
      name: 'Auth Pattern',
      sourceSpecId: 'auth-v1',
      brief: 'Build auth with login and signup',
      storyStructure: sampleStoryStructure,
    });

    // Generate spec using template
    const res = await request(app)
      .post('/api/specs/generate')
      .send({
        workspaceId: 'ws-tpl',
        title: 'New Auth',
        brief: 'Build new auth feature',
        templateId: tplRes.body.id,
      });

    expect(res.status).toBe(200);

    // Verify the LLM was called with template context in the prompt
    const calledPrompt = mockChatComplete.mock.calls[0][0][0].content;
    expect(calledPrompt).toContain('REFERENCE TEMPLATE');
    expect(calledPrompt).toContain('Build auth with login and signup');
    expect(calledPrompt).toContain('User login');
    expect(calledPrompt).toContain('Dashboard');
  });

  test('generates normally when templateId is not provided', async () => {
    mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 10, outputTokens: 20 } });

    db.prepare(
      "INSERT OR IGNORE INTO workspaces (id, label, path) VALUES ('ws-tpl2', 'TPL WS2', ?)"
    ).run(os.tmpdir());

    const res = await request(app)
      .post('/api/specs/generate')
      .send({
        workspaceId: 'ws-tpl2',
        title: 'No Template',
        brief: 'Build something',
      });

    expect(res.status).toBe(200);

    const calledPrompt = mockChatComplete.mock.calls[0][0][0].content;
    expect(calledPrompt).not.toContain('REFERENCE TEMPLATE');
  });

  test('generates normally when templateId does not exist in DB', async () => {
    mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 10, outputTokens: 20 } });

    db.prepare(
      "INSERT OR IGNORE INTO workspaces (id, label, path) VALUES ('ws-tpl3', 'TPL WS3', ?)"
    ).run(os.tmpdir());

    const res = await request(app)
      .post('/api/specs/generate')
      .send({
        workspaceId: 'ws-tpl3',
        title: 'Bad Template Ref',
        brief: 'Build something',
        templateId: 'nonexistent-template-id',
      });

    expect(res.status).toBe(200);

    const calledPrompt = mockChatComplete.mock.calls[0][0][0].content;
    expect(calledPrompt).not.toContain('REFERENCE TEMPLATE');
  });
});
