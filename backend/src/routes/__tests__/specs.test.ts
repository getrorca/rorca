import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import request from 'supertest';

// Mock llm-client before any imports that use it
jest.mock('../../lib/llm-client', () => ({
  chatComplete: jest.fn(),
  getActiveProvider: jest.fn().mockReturnValue('anthropic'),
  getActiveModel: jest.fn().mockReturnValue('claude-sonnet-4-6'),
}));

let app: Express;
let db: Database.Database;
let tmpDir: string;
let mockChatComplete: jest.Mock;

const validLlmResponse = JSON.stringify({
  stories: [
    {
      id: 'US-001',
      title: 'User login',
      description: 'Allow users to log in with email and password',
      acceptanceCriteria: ['Given valid creds, user is authenticated', 'Given invalid creds, error shown', 'Session persists across refresh'],
      dependsOn: [],
    },
    {
      id: 'US-002',
      title: 'Dashboard view',
      description: 'Show user dashboard after login',
      acceptanceCriteria: ['Dashboard shows user name', 'Shows recent activity', 'Loads within 2s'],
      dependsOn: ['US-001'],
    },
  ],
  diagrams: {
    architecture: { mermaid: 'graph LR\n  A-->B', ascii: 'A -> B' },
    userFlow: { mermaid: 'graph TD\n  login-->dash', ascii: 'login -> dash' },
  },
});

beforeEach(() => {
  jest.resetModules();

  // Keep the mock across resets
  jest.mock('../../lib/llm-client', () => ({
    chatComplete: jest.fn(),
    getActiveProvider: jest.fn().mockReturnValue('anthropic'),
    getActiveModel: jest.fn().mockReturnValue('claude-sonnet-4-6'),
  }));

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorcha-specs-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  process.env.DB_PATH = dbPath;
  process.env.NODE_ENV = 'test';

  const serverMod = require('../../server');
  app = serverMod.default;
  const dbMod = require('../../db/index');
  db = dbMod.db;

  const llmClient = require('../../lib/llm-client');
  mockChatComplete = llmClient.chatComplete;

  // Seed a workspace for tests
  db.prepare(
    "INSERT INTO workspaces (id, label, path) VALUES ('ws-test', 'Test WS', ?)"
  ).run(os.tmpdir());
});

afterEach(() => {
  // Clean up any spec files written to os.tmpdir()
  const pendingDir = path.join(os.tmpdir(), 'scripts', 'ralph', 'specs', 'pending');
  if (fs.existsSync(pendingDir)) {
    fs.rmSync(pendingDir, { recursive: true, force: true });
  }

  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
  delete process.env.NODE_ENV;
});

test('POST /api/specs/generate with valid body returns slug, stories, diagrams, provider, model', async () => {
  mockChatComplete.mockResolvedValue(validLlmResponse);

  const res = await request(app)
    .post('/api/specs/generate')
    .send({
      workspaceId: 'ws-test',
      domain: 'backend',
      title: 'Auth System',
      brief: 'Build login and signup',
    });

  expect(res.status).toBe(200);
  expect(res.body.slug).toBe('auth-system');
  expect(res.body.title).toBe('Auth System');
  expect(res.body.stories).toHaveLength(2);
  expect(res.body.stories[0]).toMatchObject({
    id: 'US-001',
    title: 'User login',
    description: expect.any(String),
    acceptanceCriteria: expect.any(Array),
    dependsOn: [],
  });
  expect(res.body.diagrams).toBeDefined();
  expect(res.body.diagrams.storyDeps).toBeDefined();
  expect(res.body.diagrams.storyDeps.mermaid).toContain('US-001');
  expect(res.body.provider).toBe('anthropic');
  expect(res.body.model).toBe('claude-sonnet-4-6');
  expect(res.body.specPath).toBeDefined();
  expect(res.body.specPath).toContain('auth-system.json');
  expect(res.body.diagramsPath).toBeDefined();
  expect(res.body.diagramsPath).toContain('auth-system-diagrams.md');
});

test('LLM returns non-JSON → 500 with error and raw', async () => {
  mockChatComplete.mockResolvedValue('This is not JSON at all');

  const res = await request(app)
    .post('/api/specs/generate')
    .send({
      workspaceId: 'ws-test',
      domain: 'backend',
      title: 'Bad Spec',
      brief: 'Something',
    });

  expect(res.status).toBe(500);
  expect(res.body.error).toBe('LLM returned non-JSON');
  expect(res.body.raw).toBe('This is not JSON at all');
});

test('Missing workspaceId in body → 400', async () => {
  const res = await request(app)
    .post('/api/specs/generate')
    .send({
      domain: 'backend',
      title: 'No Workspace',
      brief: 'Missing workspace',
    });

  expect(res.status).toBe(400);
  expect(res.body.error).toContain('Missing required fields');
});

test('workspaceId not in DB → 404', async () => {
  const res = await request(app)
    .post('/api/specs/generate')
    .send({
      workspaceId: 'nonexistent',
      domain: 'backend',
      title: 'Ghost',
      brief: 'Workspace does not exist',
    });

  expect(res.status).toBe(404);
  expect(res.body.error).toBe('Workspace not found');
});

test('WAL event inserted with event_type=generate and payload includes provider', async () => {
  mockChatComplete.mockResolvedValue(validLlmResponse);

  await request(app)
    .post('/api/specs/generate')
    .send({
      workspaceId: 'ws-test',
      domain: 'backend',
      title: 'Wal Test',
      brief: 'Build auth',
    });

  const event = db.prepare(
    "SELECT * FROM wal_events WHERE event_type = 'generate'"
  ).get() as { event_type: string; spec_id: string; payload: string };

  expect(event).toBeDefined();
  expect(event.event_type).toBe('generate');
  expect(event.spec_id).toBe('wal-test');
  const payload = JSON.parse(event.payload);
  expect(payload.provider).toBe('anthropic');
  expect(payload.model).toBe('claude-sonnet-4-6');
  expect(payload.storyCount).toBe(2);
});

test('POST /api/specs/generate returns 409 when slug already exists on disk', async () => {
  mockChatComplete.mockResolvedValue(validLlmResponse);

  // First call succeeds
  const res1 = await request(app)
    .post('/api/specs/generate')
    .send({
      workspaceId: 'ws-test',
      domain: 'backend',
      title: 'Duplicate Check',
      brief: 'Build something',
    });
  expect(res1.status).toBe(200);

  // Second call with same title → 409
  const res2 = await request(app)
    .post('/api/specs/generate')
    .send({
      workspaceId: 'ws-test',
      domain: 'backend',
      title: 'Duplicate Check',
      brief: 'Build something again',
    });
  expect(res2.status).toBe(409);
  expect(res2.body.error).toContain('duplicate-check');
});
