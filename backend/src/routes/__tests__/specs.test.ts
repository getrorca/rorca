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
  const specsRoot = path.join(os.tmpdir(), 'scripts', 'ralph', 'specs');
  if (fs.existsSync(specsRoot)) {
    fs.rmSync(specsRoot, { recursive: true, force: true });
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

test('WAL event has hasSchema:true and hasGitMemory:true when workspace has hydrated context', async () => {
  mockChatComplete.mockResolvedValue(validLlmResponse);

  // Seed workspace_context with schema + git
  db.prepare(
    `INSERT INTO workspace_context (workspace_id, schema_snapshot, schema_table_count, git_memory, git_commit_count)
     VALUES (?, ?, ?, ?, ?)`
  ).run('ws-test', 'CREATE TABLE users (id TEXT);', 1, 'conventions:\n  - use snake_case', 10);

  await request(app)
    .post('/api/specs/generate')
    .send({
      workspaceId: 'ws-test',
      domain: 'backend',
      title: 'Hydrated Spec',
      brief: 'Build with context',
    });

  const event = db.prepare(
    "SELECT payload FROM wal_events WHERE event_type = 'generate' AND spec_id = 'hydrated-spec'"
  ).get() as { payload: string };

  expect(event).toBeDefined();
  const payload = JSON.parse(event.payload);
  expect(payload.hasSchema).toBe(true);
  expect(payload.hasGitMemory).toBe(true);
});

test('WAL event has hasSchema:false when workspace has no hydrated context', async () => {
  mockChatComplete.mockResolvedValue(validLlmResponse);

  // No workspace_context seeded — should gracefully default to false

  await request(app)
    .post('/api/specs/generate')
    .send({
      workspaceId: 'ws-test',
      domain: 'backend',
      title: 'No Context Spec',
      brief: 'Build without context',
    });

  const event = db.prepare(
    "SELECT payload FROM wal_events WHERE event_type = 'generate' AND spec_id = 'no-context-spec'"
  ).get() as { payload: string };

  expect(event).toBeDefined();
  const payload = JSON.parse(event.payload);
  expect(payload.hasSchema).toBe(false);
  expect(payload.hasGitMemory).toBe(false);
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

// ─── R-001: List / Approve / Reject / Get Detail ──────────────────────────────

/** Seed a spec file on disk for R-001 tests */
function seedSpecFile(dir: string, slug: string, overrides?: Record<string, unknown>) {
  fs.mkdirSync(dir, { recursive: true });
  const spec = {
    title: slug.replace(/-/g, ' '),
    userStories: [
      { id: 'US-001', title: 'Story one', description: 'Desc', acceptanceCriteria: ['AC1'], dependsOn: [], passes: false },
    ],
    generatedAt: '2026-02-20T12:00:00.000Z',
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, `${slug}.json`), JSON.stringify(spec, null, 2), 'utf8');
  return spec;
}

describe('GET /api/specs (list)', () => {
  test('returns pending and approved specs with correct status', async () => {
    const pendingDir = path.join(os.tmpdir(), 'scripts', 'ralph', 'specs', 'pending');
    const approvedDir = path.join(os.tmpdir(), 'scripts', 'ralph', 'specs', 'approved');

    seedSpecFile(pendingDir, 'my-pending-spec');
    seedSpecFile(approvedDir, 'my-approved-spec', { generatedAt: '2026-02-19T10:00:00.000Z' });

    const res = await request(app).get('/api/specs?workspaceId=ws-test');

    expect(res.status).toBe(200);
    expect(res.body.specs).toHaveLength(2);

    const pending = res.body.specs.find((s: any) => s.id === 'my-pending-spec');
    const approved = res.body.specs.find((s: any) => s.id === 'my-approved-spec');

    expect(pending).toBeDefined();
    expect(pending.status).toBe('pending');
    expect(pending.storyCount).toBe(1);

    expect(approved).toBeDefined();
    expect(approved.status).toBe('approved');
    expect(approved.approvedAt).toBeDefined();
  });

  test('filters by status=pending', async () => {
    const pendingDir = path.join(os.tmpdir(), 'scripts', 'ralph', 'specs', 'pending');
    const approvedDir = path.join(os.tmpdir(), 'scripts', 'ralph', 'specs', 'approved');

    seedSpecFile(pendingDir, 'pend-only');
    seedSpecFile(approvedDir, 'appr-only');

    const res = await request(app).get('/api/specs?workspaceId=ws-test&status=pending');

    expect(res.status).toBe(200);
    expect(res.body.specs).toHaveLength(1);
    expect(res.body.specs[0].id).toBe('pend-only');
  });

  test('filters by status=approved', async () => {
    const pendingDir = path.join(os.tmpdir(), 'scripts', 'ralph', 'specs', 'pending');
    const approvedDir = path.join(os.tmpdir(), 'scripts', 'ralph', 'specs', 'approved');

    seedSpecFile(pendingDir, 'pend-only2');
    seedSpecFile(approvedDir, 'appr-only2');

    const res = await request(app).get('/api/specs?workspaceId=ws-test&status=approved');

    expect(res.status).toBe(200);
    expect(res.body.specs).toHaveLength(1);
    expect(res.body.specs[0].id).toBe('appr-only2');
  });

  test('returns empty array when no specs exist', async () => {
    const res = await request(app).get('/api/specs?workspaceId=ws-test');
    expect(res.status).toBe(200);
    expect(res.body.specs).toEqual([]);
  });

  test('missing workspaceId → 400', async () => {
    const res = await request(app).get('/api/specs');
    expect(res.status).toBe(400);
  });

  test('unknown workspaceId → 404', async () => {
    const res = await request(app).get('/api/specs?workspaceId=nonexistent');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/specs/:id/approve', () => {
  test('moves file to approved/ and returns ok', async () => {
    const pendingDir = path.join(os.tmpdir(), 'scripts', 'ralph', 'specs', 'pending');
    const approvedDir = path.join(os.tmpdir(), 'scripts', 'ralph', 'specs', 'approved');

    seedSpecFile(pendingDir, 'to-approve');

    const res = await request(app)
      .post('/api/specs/to-approve/approve')
      .send({ workspaceId: 'ws-test' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.approvedPath).toContain('approved');
    expect(res.body.approvedPath).toContain('to-approve.json');

    // File moved: no longer in pending, exists in approved
    expect(fs.existsSync(path.join(pendingDir, 'to-approve.json'))).toBe(false);
    expect(fs.existsSync(path.join(approvedDir, 'to-approve.json'))).toBe(true);
  });

  test('emits WAL event with event_type=spec_approved', async () => {
    const pendingDir = path.join(os.tmpdir(), 'scripts', 'ralph', 'specs', 'pending');
    seedSpecFile(pendingDir, 'wal-approve');

    await request(app)
      .post('/api/specs/wal-approve/approve')
      .send({ workspaceId: 'ws-test' });

    const event = db.prepare(
      "SELECT * FROM wal_events WHERE event_type = 'spec_approved'"
    ).get() as { event_type: string; spec_id: string; actor: string; payload: string };

    expect(event).toBeDefined();
    expect(event.spec_id).toBe('wal-approve');
    expect(event.actor).toBe('user');
    const payload = JSON.parse(event.payload);
    expect(payload.workspaceId).toBe('ws-test');
  });

  test('creates approved/ directory if it does not exist', async () => {
    const pendingDir = path.join(os.tmpdir(), 'scripts', 'ralph', 'specs', 'pending');
    const approvedDir = path.join(os.tmpdir(), 'scripts', 'ralph', 'specs', 'approved');

    seedSpecFile(pendingDir, 'auto-mkdir');
    // Ensure approved/ doesn't exist
    expect(fs.existsSync(approvedDir)).toBe(false);

    const res = await request(app)
      .post('/api/specs/auto-mkdir/approve')
      .send({ workspaceId: 'ws-test' });

    expect(res.status).toBe(200);
    expect(fs.existsSync(approvedDir)).toBe(true);
  });

  test('spec not found → 404', async () => {
    const res = await request(app)
      .post('/api/specs/ghost/approve')
      .send({ workspaceId: 'ws-test' });

    expect(res.status).toBe(404);
  });

  test('missing workspaceId → 400', async () => {
    const res = await request(app)
      .post('/api/specs/whatever/approve')
      .send({});

    expect(res.status).toBe(400);
  });
});

describe('POST /api/specs/:id/reject', () => {
  test('deletes file and returns ok', async () => {
    const pendingDir = path.join(os.tmpdir(), 'scripts', 'ralph', 'specs', 'pending');
    seedSpecFile(pendingDir, 'to-reject');

    const res = await request(app)
      .post('/api/specs/to-reject/reject')
      .send({ workspaceId: 'ws-test' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(fs.existsSync(path.join(pendingDir, 'to-reject.json'))).toBe(false);
  });

  test('emits WAL event with event_type=spec_rejected and reason', async () => {
    const pendingDir = path.join(os.tmpdir(), 'scripts', 'ralph', 'specs', 'pending');
    seedSpecFile(pendingDir, 'wal-reject');

    await request(app)
      .post('/api/specs/wal-reject/reject')
      .send({ workspaceId: 'ws-test', reason: 'Too many stories' });

    const event = db.prepare(
      "SELECT * FROM wal_events WHERE event_type = 'spec_rejected'"
    ).get() as { event_type: string; spec_id: string; actor: string; payload: string };

    expect(event).toBeDefined();
    expect(event.spec_id).toBe('wal-reject');
    expect(event.actor).toBe('user');
    const payload = JSON.parse(event.payload);
    expect(payload.reason).toBe('Too many stories');
  });

  test('spec not found → 404', async () => {
    const res = await request(app)
      .post('/api/specs/ghost/reject')
      .send({ workspaceId: 'ws-test' });

    expect(res.status).toBe(404);
  });
});

describe('GET /api/specs/:specId (detail)', () => {
  test('returns full spec JSON from pending', async () => {
    const pendingDir = path.join(os.tmpdir(), 'scripts', 'ralph', 'specs', 'pending');
    const seeded = seedSpecFile(pendingDir, 'detail-spec');

    const res = await request(app).get('/api/specs/detail-spec?workspaceId=ws-test');

    expect(res.status).toBe(200);
    expect(res.body.title).toBe(seeded.title);
    expect(res.body.userStories).toHaveLength(1);
  });

  test('returns full spec JSON from approved', async () => {
    const approvedDir = path.join(os.tmpdir(), 'scripts', 'ralph', 'specs', 'approved');
    const seeded = seedSpecFile(approvedDir, 'approved-detail');

    const res = await request(app).get('/api/specs/approved-detail?workspaceId=ws-test');

    expect(res.status).toBe(200);
    expect(res.body.title).toBe(seeded.title);
  });

  test('spec not found → 404', async () => {
    const res = await request(app).get('/api/specs/nonexistent?workspaceId=ws-test');
    expect(res.status).toBe(404);
  });

  test('missing workspaceId → 400', async () => {
    const res = await request(app).get('/api/specs/some-spec');
    expect(res.status).toBe(400);
  });
});
