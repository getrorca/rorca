import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import request from 'supertest';
import { getAuthToken } from './helpers/auth-helper';

// Mock llm-client before any imports that use it
jest.mock('../../lib/llm-client', () => ({
  chatComplete: jest.fn(),
  getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
  isValidModel: jest.fn().mockImplementation((m: string) =>
    ['claude-sonnet-4-5-20250929', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'].includes(m)
  ),
  resolveVaultProvider: jest.fn().mockReturnValue(null),
  getModelInfo: jest.fn().mockReturnValue(undefined),
  DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
  SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'],
}));

let app: Express;
let db: Database.Database;
let tmpDir: string;
let mockChatComplete: jest.Mock;
let authToken: string;

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

beforeEach(async () => {
  jest.resetModules();

  // Keep the mock across resets
  jest.mock('../../lib/llm-client', () => ({
    chatComplete: jest.fn(),
    getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
    isValidModel: jest.fn().mockImplementation((m: string) =>
      ['claude-sonnet-4-5-20250929', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'].includes(m)
    ),
    resolveVaultProvider: jest.fn().mockReturnValue(null),
    getModelInfo: jest.fn().mockReturnValue(undefined),
    DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
    SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'],
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

  // Clean up any stale spec files from prior test suites that share os.tmpdir()
  const specsRoot = path.join(os.tmpdir(), 'scripts', 'ralph', 'specs');
  if (fs.existsSync(specsRoot)) {
    fs.rmSync(specsRoot, { recursive: true, force: true });
  }

  // Seed a workspace for tests
  db.prepare(
    "INSERT INTO workspaces (id, label, path) VALUES ('ws-test', 'Test WS', ?)"
  ).run(os.tmpdir());

  authToken = await getAuthToken(app);
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
  mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 100, outputTokens: 200 } });

  const res = await request(app)
    .post('/api/specs/generate')
    .set('Authorization', `Bearer ${authToken}`)
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
  expect(res.body.provider).toBe('claude-cli');
  expect(res.body.model).toBe('claude-sonnet-4-5-20250929');
  expect(res.body.usage).toEqual({ inputTokens: 100, outputTokens: 200 });
  expect(res.body.specPath).toBeDefined();
  expect(res.body.specPath).toContain('auth-system.json');
  expect(res.body.diagramsPath).toBeDefined();
  expect(res.body.diagramsPath).toContain('auth-system-diagrams.md');
});

test('LLM returns non-JSON → 500 with error and raw', async () => {
  mockChatComplete.mockResolvedValue({ text: 'This is not JSON at all', usage: { inputTokens: 50, outputTokens: 10 } });

  const res = await request(app)
    .post('/api/specs/generate')
    .set('Authorization', `Bearer ${authToken}`)
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
    .set('Authorization', `Bearer ${authToken}`)
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
    .set('Authorization', `Bearer ${authToken}`)
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
  mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 100, outputTokens: 200 } });

  await request(app)
    .post('/api/specs/generate')
    .set('Authorization', `Bearer ${authToken}`)
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
  expect(payload.provider).toBe('claude-cli');
  expect(payload.model).toBe('claude-sonnet-4-5-20250929');
  expect(payload.storyCount).toBe(2);
  expect(payload.inputTokens).toBe(100);
  expect(payload.outputTokens).toBe(200);
});

test('WAL event has hasSchema:true and hasGitMemory:true when workspace has hydrated context', async () => {
  mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 100, outputTokens: 200 } });

  // Seed workspace_context with schema + git
  db.prepare(
    `INSERT INTO workspace_context (workspace_id, schema_snapshot, schema_table_count, git_memory, git_commit_count)
     VALUES (?, ?, ?, ?, ?)`
  ).run('ws-test', 'CREATE TABLE users (id TEXT);', 1, 'conventions:\n  - use snake_case', 10);

  await request(app)
    .post('/api/specs/generate')
    .set('Authorization', `Bearer ${authToken}`)
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
  mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 100, outputTokens: 200 } });

  // No workspace_context seeded — should gracefully default to false

  await request(app)
    .post('/api/specs/generate')
    .set('Authorization', `Bearer ${authToken}`)
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

test('POST /api/specs/generate with existing slug snapshots old version and succeeds', async () => {
  mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 100, outputTokens: 200 } });

  // First call succeeds
  const res1 = await request(app)
    .post('/api/specs/generate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: 'ws-test',
      domain: 'backend',
      title: 'Duplicate Check',
      brief: 'Build something',
    });
  expect(res1.status).toBe(200);

  // Second call with same title → succeeds, old version is snapshotted
  const res2 = await request(app)
    .post('/api/specs/generate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: 'ws-test',
      domain: 'backend',
      title: 'Duplicate Check',
      brief: 'Build something again',
    });
  expect(res2.status).toBe(200);
  expect(res2.body.slug).toBe('duplicate-check');

  // Verify version was created in DB
  const version = db.prepare(
    "SELECT * FROM spec_versions WHERE spec_slug = 'duplicate-check'"
  ).get() as { version: number; status: string; content_json: string } | undefined;
  expect(version).toBeDefined();
  expect(version!.version).toBe(1);
  expect(version!.status).toBe('pending');
  const content = JSON.parse(version!.content_json);
  expect(content.title).toBe('Duplicate Check');
});

// ─── US-003: Model Selection ──────────────────────────────────────────────────

test('POST /api/specs/generate with explicit model uses that model', async () => {
  mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 50, outputTokens: 100 } });

  const res = await request(app)
    .post('/api/specs/generate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: 'ws-test',
      title: 'Model Test',
      brief: 'Test model selection',
      model: 'claude-opus-4-6',
    });

  expect(res.status).toBe(200);
  expect(res.body.model).toBe('claude-opus-4-6');
  expect(res.body.usage).toEqual({ inputTokens: 50, outputTokens: 100 });

  // chatComplete should have been called with the model in options object
  expect(mockChatComplete).toHaveBeenCalledWith(
    expect.any(Array),
    expect.objectContaining({ model: 'claude-opus-4-6' }),
  );
});

test('POST /api/specs/generate accepts any model string (pass-through for openai-compat)', async () => {
  mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 10, outputTokens: 20 } });

  const res = await request(app)
    .post('/api/specs/generate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: 'ws-test',
      title: 'Custom Model',
      brief: 'Test custom model pass-through',
      model: 'my-custom-model-v1',
    });

  // Should not return 400 — any model string is accepted for openai-compat pass-through
  expect(res.status).not.toBe(400);
});

test('POST /api/specs/generate without model uses workspace L3 preferred_model', async () => {
  mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 10, outputTokens: 20 } });

  // Set workspace L3 preferred_model
  db.prepare(`
    INSERT INTO direction_layers (layer, workspace_id, content_yaml, preferred_model, updated_at)
    VALUES (3, 'ws-test', 'project: test', 'claude-haiku-4-5-20251001', datetime('now'))
  `).run();

  const res = await request(app)
    .post('/api/specs/generate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: 'ws-test',
      title: 'Default Model Test',
      brief: 'Test default model from L3',
    });

  expect(res.status).toBe(200);
  expect(res.body.model).toBe('claude-haiku-4-5-20251001');
  expect(mockChatComplete).toHaveBeenCalledWith(
    expect.any(Array),
    expect.objectContaining({ model: 'claude-haiku-4-5-20251001' }),
  );
});

test('POST /api/specs/generate with explicit model overrides workspace default', async () => {
  mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 10, outputTokens: 20 } });

  // Set workspace L3 preferred_model
  db.prepare(`
    INSERT INTO direction_layers (layer, workspace_id, content_yaml, preferred_model, updated_at)
    VALUES (3, 'ws-test', 'project: test', 'claude-haiku-4-5-20251001', datetime('now'))
    ON CONFLICT (layer, COALESCE(workspace_id,''), COALESCE(domain,''))
    DO UPDATE SET preferred_model = 'claude-haiku-4-5-20251001'
  `).run();

  const res = await request(app)
    .post('/api/specs/generate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: 'ws-test',
      title: 'Override Model Test',
      brief: 'Test explicit model overrides workspace',
      model: 'claude-opus-4-6',
    });

  expect(res.status).toBe(200);
  expect(res.body.model).toBe('claude-opus-4-6');
});

test('WAL event payload includes token usage', async () => {
  mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 500, outputTokens: 1000 } });

  await request(app)
    .post('/api/specs/generate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: 'ws-test',
      title: 'Token Usage Test',
      brief: 'Test token tracking',
    });

  const event = db.prepare(
    "SELECT payload FROM wal_events WHERE event_type = 'generate' AND spec_id = 'token-usage-test'"
  ).get() as { payload: string };

  expect(event).toBeDefined();
  const payload = JSON.parse(event.payload);
  expect(payload.inputTokens).toBe(500);
  expect(payload.outputTokens).toBe(1000);
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
    // Clean dirs to avoid cross-suite contamination (batch tests share os.tmpdir())
    const specsRoot = path.join(os.tmpdir(), 'scripts', 'ralph', 'specs');
    if (fs.existsSync(specsRoot)) fs.rmSync(specsRoot, { recursive: true, force: true });

    const pendingDir = path.join(specsRoot, 'pending');
    const approvedDir = path.join(specsRoot, 'approved');

    seedSpecFile(pendingDir, 'my-pending-spec');
    seedSpecFile(approvedDir, 'my-approved-spec', { generatedAt: '2026-02-19T10:00:00.000Z' });

    const res = await request(app).get('/api/specs?workspaceId=ws-test').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);

    const pending = res.body.items.find((s: any) => s.id === 'my-pending-spec');
    const approved = res.body.items.find((s: any) => s.id === 'my-approved-spec');

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

    const res = await request(app).get('/api/specs?workspaceId=ws-test&status=pending').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('pend-only');
  });

  test('filters by status=approved', async () => {
    const pendingDir = path.join(os.tmpdir(), 'scripts', 'ralph', 'specs', 'pending');
    const approvedDir = path.join(os.tmpdir(), 'scripts', 'ralph', 'specs', 'approved');

    seedSpecFile(pendingDir, 'pend-only2');
    seedSpecFile(approvedDir, 'appr-only2');

    const res = await request(app).get('/api/specs?workspaceId=ws-test&status=approved').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('appr-only2');
  });

  test('returns empty array when no specs exist', async () => {
    const res = await request(app).get('/api/specs?workspaceId=ws-test').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  test('missing workspaceId → 400', async () => {
    const res = await request(app).get('/api/specs').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(400);
  });

  test('unknown workspaceId → 404', async () => {
    const res = await request(app).get('/api/specs?workspaceId=nonexistent').set('Authorization', `Bearer ${authToken}`);
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
      .set('Authorization', `Bearer ${authToken}`)
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
      .set('Authorization', `Bearer ${authToken}`)
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
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test' });

    expect(res.status).toBe(200);
    expect(fs.existsSync(approvedDir)).toBe(true);
  });

  test('spec not found → 404', async () => {
    const res = await request(app)
      .post('/api/specs/ghost/approve')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test' });

    expect(res.status).toBe(404);
  });

  test('missing workspaceId → 400', async () => {
    const res = await request(app)
      .post('/api/specs/whatever/approve')
      .set('Authorization', `Bearer ${authToken}`)
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
      .set('Authorization', `Bearer ${authToken}`)
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
      .set('Authorization', `Bearer ${authToken}`)
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
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test' });

    expect(res.status).toBe(404);
  });
});

describe('GET /api/specs/:specId (detail)', () => {
  test('returns full spec JSON from pending', async () => {
    const pendingDir = path.join(os.tmpdir(), 'scripts', 'ralph', 'specs', 'pending');
    const seeded = seedSpecFile(pendingDir, 'detail-spec');

    const res = await request(app).get('/api/specs/detail-spec?workspaceId=ws-test').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.title).toBe(seeded.title);
    expect(res.body.userStories).toHaveLength(1);
  });

  test('returns full spec JSON from approved', async () => {
    const approvedDir = path.join(os.tmpdir(), 'scripts', 'ralph', 'specs', 'approved');
    const seeded = seedSpecFile(approvedDir, 'approved-detail');

    const res = await request(app).get('/api/specs/approved-detail?workspaceId=ws-test').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.title).toBe(seeded.title);
  });

  test('spec not found → 404', async () => {
    const res = await request(app).get('/api/specs/nonexistent?workspaceId=ws-test').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(404);
  });

  test('missing workspaceId → 400', async () => {
    const res = await request(app).get('/api/specs/some-spec').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(400);
  });
});

// ─── US-001: Version History + Diff ───────────────────────────────────────────

describe('GET /api/specs/:specId/versions', () => {
  test('returns empty array when no versions exist', async () => {
    const res = await request(app).get('/api/specs/nonexistent-slug/versions').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    
    expect(res.body.items).toEqual([]);
  });

  test('returns versions after rejection creates a snapshot', async () => {
    const pendingDir = path.join(os.tmpdir(), 'scripts', 'ralph', 'specs', 'pending');
    seedSpecFile(pendingDir, 'versioned-spec', {
      title: 'Versioned Spec',
      userStories: [
        { id: 'US-001', title: 'Story one', description: 'Desc', acceptanceCriteria: ['AC1'], dependsOn: [], passes: false },
        { id: 'US-002', title: 'Story two', description: 'Desc2', acceptanceCriteria: ['AC2'], dependsOn: [], passes: false },
      ],
    });

    // Reject the spec (creates a version snapshot)
    await request(app)
      .post('/api/specs/versioned-spec/reject')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test', reason: 'Needs more stories' });

    const res = await request(app).get('/api/specs/versioned-spec/versions').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].version).toBe(1);
    expect(res.body.items[0].status).toBe('rejected');
    expect(res.body.items[0].rejectionReason).toBe('Needs more stories');
    expect(res.body.items[0].title).toBe('Versioned Spec');
    expect(res.body.items[0].storyCount).toBe(2);
    expect(res.body.items[0].createdAt).toBeDefined();
  });

  test('returns multiple versions in ascending order', async () => {
    // Manually insert two versions
    db.prepare(
      `INSERT INTO spec_versions (spec_slug, version, content_json, status) VALUES (?, ?, ?, ?)`
    ).run('multi-ver', 1, JSON.stringify({ title: 'V1', userStories: [] }), 'rejected');
    db.prepare(
      `INSERT INTO spec_versions (spec_slug, version, content_json, status) VALUES (?, ?, ?, ?)`
    ).run('multi-ver', 2, JSON.stringify({ title: 'V2', userStories: [{ id: 'US-001', title: 'S1' }] }), 'pending');

    const res = await request(app).get('/api/specs/multi-ver/versions').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0].version).toBe(1);
    expect(res.body.items[0].title).toBe('V1');
    expect(res.body.items[0].storyCount).toBe(0);
    expect(res.body.items[1].version).toBe(2);
    expect(res.body.items[1].title).toBe('V2');
    expect(res.body.items[1].storyCount).toBe(1);
  });
});

describe('GET /api/specs/:specId/diff', () => {
  beforeEach(() => {
    // Seed two versions with different stories
    const v1 = {
      title: 'Auth System',
      userStories: [
        { id: 'US-001', title: 'Login', description: 'Login flow', acceptanceCriteria: ['AC1', 'AC2'], dependsOn: [] },
        { id: 'US-002', title: 'Signup', description: 'Signup flow', acceptanceCriteria: ['AC3'], dependsOn: ['US-001'] },
      ],
    };
    const v2 = {
      title: 'Auth System v2',
      userStories: [
        { id: 'US-001', title: 'Login', description: 'Improved login', acceptanceCriteria: ['AC1', 'AC2', 'AC4'], dependsOn: [] },
        { id: 'US-003', title: 'Password Reset', description: 'Reset flow', acceptanceCriteria: ['AC5'], dependsOn: ['US-001'] },
      ],
    };
    db.prepare(
      `INSERT INTO spec_versions (spec_slug, version, content_json, status) VALUES (?, ?, ?, ?)`
    ).run('diff-test', 1, JSON.stringify(v1), 'rejected');
    db.prepare(
      `INSERT INTO spec_versions (spec_slug, version, content_json, status, rejection_reason) VALUES (?, ?, ?, ?, ?)`
    ).run('diff-test', 2, JSON.stringify(v2), 'pending', null);
  });

  test('returns structured diff with added, removed, modified, unchanged stories', async () => {
    const res = await request(app).get('/api/specs/diff-test/diff?v1=1&v2=2').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);

    expect(res.body.specSlug).toBe('diff-test');
    expect(res.body.v1.version).toBe(1);
    expect(res.body.v2.version).toBe(2);

    const { diff } = res.body;
    expect(diff.titleChanged).toBe(true);
    expect(diff.oldTitle).toBe('Auth System');
    expect(diff.newTitle).toBe('Auth System v2');

    // US-001: modified (description + AC changed)
    const us001 = diff.stories.find((s: any) => s.id === 'US-001');
    expect(us001.changeType).toBe('modified');
    expect(us001.deltas).toBeDefined();
    const descDelta = us001.deltas.find((d: any) => d.field === 'description');
    expect(descDelta.old).toBe('Login flow');
    expect(descDelta.new).toBe('Improved login');
    const acDelta = us001.deltas.find((d: any) => d.field === 'acceptanceCriteria');
    expect(acDelta.added).toContain('AC4');
    expect(acDelta.removed).toEqual([]);

    // US-002: removed
    const us002 = diff.stories.find((s: any) => s.id === 'US-002');
    expect(us002.changeType).toBe('removed');
    expect(us002.story).toBeDefined();

    // US-003: added
    const us003 = diff.stories.find((s: any) => s.id === 'US-003');
    expect(us003.changeType).toBe('added');
    expect(us003.story.title).toBe('Password Reset');

    // Summary
    expect(diff.summary).toEqual({ added: 1, removed: 1, modified: 1, unchanged: 0 });
  });

  test('missing v1/v2 → 400', async () => {
    const res = await request(app).get('/api/specs/diff-test/diff?v1=1').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('v1 and v2');
  });

  test('same v1 and v2 → 400', async () => {
    const res = await request(app).get('/api/specs/diff-test/diff?v1=1&v2=1').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('different');
  });

  test('nonexistent version → 404', async () => {
    const res = await request(app).get('/api/specs/diff-test/diff?v1=1&v2=99').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('v99');
  });

  test('both versions missing → 404 mentioning both', async () => {
    const res = await request(app).get('/api/specs/diff-test/diff?v1=98&v2=99').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('v98');
    expect(res.body.error).toContain('v99');
  });
});

// ─── US-005: Full-Text Search Archive ──────────────────────────────────────────

/** Seed a spec with rich content for search tests */
function seedRichSpec(dir: string, slug: string, overrides?: Record<string, unknown>) {
  fs.mkdirSync(dir, { recursive: true });
  const spec = {
    title: overrides?.title ?? slug.replace(/-/g, ' '),
    userStories: overrides?.userStories ?? [
      {
        id: 'US-001',
        title: 'Story one',
        description: 'A basic description',
        acceptanceCriteria: ['Criterion alpha', 'Criterion beta'],
        dependsOn: [],
        passes: false,
      },
    ],
    generatedAt: overrides?.generatedAt ?? '2026-02-20T12:00:00.000Z',
  };
  fs.writeFileSync(path.join(dir, `${slug}.json`), JSON.stringify(spec, null, 2), 'utf8');
  return spec;
}

describe('GET /api/specs/archive (US-005 full-text search)', () => {
  test('q param searches across spec title', async () => {
    const pendingDir = path.join(os.tmpdir(), 'scripts', 'ralph', 'specs', 'pending');
    seedRichSpec(pendingDir, 'auth-system', { title: 'Authentication System' });
    seedRichSpec(pendingDir, 'payment-flow', { title: 'Payment Processing' });

    const res = await request(app).get('/api/specs/archive?workspaceId=ws-test&q=authentication').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('auth-system');
    expect(res.body.items[0].matchSnippets).toBeDefined();
    expect(res.body.items[0].matchSnippets.length).toBeGreaterThan(0);
    expect(res.body.items[0].matchSnippets[0].field).toBe('title');
    expect(res.body.items[0].matchSnippets[0].text).toContain('<mark>');
  });

  test('q param searches across story titles', async () => {
    const approvedDir = path.join(os.tmpdir(), 'scripts', 'ralph', 'specs', 'approved');
    seedRichSpec(approvedDir, 'dashboard-spec', {
      title: 'Dashboard Features',
      userStories: [
        { id: 'US-001', title: 'User Analytics Widget', description: 'Shows analytics', acceptanceCriteria: ['Loads fast'], dependsOn: [] },
        { id: 'US-002', title: 'Notification Panel', description: 'Shows notifications', acceptanceCriteria: ['Real-time updates'], dependsOn: [] },
      ],
    });

    const res = await request(app).get('/api/specs/archive?workspaceId=ws-test&q=analytics').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('dashboard-spec');
    const storySnippet = res.body.items[0].matchSnippets.find((s: any) => s.field === 'storyTitle');
    expect(storySnippet).toBeDefined();
    expect(storySnippet.storyId).toBe('US-001');
  });

  test('q param searches across story descriptions', async () => {
    const pendingDir = path.join(os.tmpdir(), 'scripts', 'ralph', 'specs', 'pending');
    seedRichSpec(pendingDir, 'api-spec', {
      title: 'API Endpoints',
      userStories: [
        { id: 'US-001', title: 'Create user', description: 'Implement OAuth2 token-based authentication flow', acceptanceCriteria: ['Returns JWT'], dependsOn: [] },
      ],
    });

    const res = await request(app).get('/api/specs/archive?workspaceId=ws-test&q=OAuth2').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('api-spec');
    const descSnippet = res.body.items[0].matchSnippets.find((s: any) => s.field === 'storyDescription');
    expect(descSnippet).toBeDefined();
    expect(descSnippet.text).toContain('<mark>OAuth2</mark>');
  });

  test('q param searches across acceptance criteria', async () => {
    const pendingDir = path.join(os.tmpdir(), 'scripts', 'ralph', 'specs', 'pending');
    seedRichSpec(pendingDir, 'perf-spec', {
      title: 'Performance Improvements',
      userStories: [
        { id: 'US-001', title: 'Caching', description: 'Add cache', acceptanceCriteria: ['Response time under 50ms for cached queries', 'Cache invalidation on write'], dependsOn: [] },
      ],
    });

    const res = await request(app).get('/api/specs/archive?workspaceId=ws-test&q=invalidation').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('perf-spec');
    const acSnippet = res.body.items[0].matchSnippets.find((s: any) => s.field === 'acceptanceCriteria');
    expect(acSnippet).toBeDefined();
    expect(acSnippet.storyId).toBe('US-001');
  });

  test('results ranked by relevance — title matches rank higher', async () => {
    const pendingDir = path.join(os.tmpdir(), 'scripts', 'ralph', 'specs', 'pending');
    // This spec has "login" only in a story description
    seedRichSpec(pendingDir, 'general-spec', {
      title: 'General Features',
      userStories: [
        { id: 'US-001', title: 'Authentication', description: 'Implement login functionality', acceptanceCriteria: ['Works'], dependsOn: [] },
      ],
    });
    // This spec has "login" in the title
    seedRichSpec(pendingDir, 'login-system', {
      title: 'Login System',
      userStories: [
        { id: 'US-001', title: 'Basic form', description: 'A form', acceptanceCriteria: ['Renders'], dependsOn: [] },
      ],
    });

    const res = await request(app).get('/api/specs/archive?workspaceId=ws-test&q=login').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    // Title match should rank first
    expect(res.body.items[0].id).toBe('login-system');
    expect(res.body.items[0].relevanceScore).toBeGreaterThan(res.body.items[1].relevanceScore);
  });

  test('date range filter: createdAfter', async () => {
    const pendingDir = path.join(os.tmpdir(), 'scripts', 'ralph', 'specs', 'pending');
    seedRichSpec(pendingDir, 'old-spec', { title: 'Old Spec', generatedAt: '2026-01-01T00:00:00.000Z' });
    seedRichSpec(pendingDir, 'new-spec', { title: 'New Spec', generatedAt: '2026-02-15T00:00:00.000Z' });

    const res = await request(app).get('/api/specs/archive?workspaceId=ws-test&createdAfter=2026-02-01T00:00:00.000Z').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('new-spec');
  });

  test('date range filter: createdBefore', async () => {
    const pendingDir = path.join(os.tmpdir(), 'scripts', 'ralph', 'specs', 'pending');
    seedRichSpec(pendingDir, 'jan-spec', { title: 'January Spec', generatedAt: '2026-01-15T00:00:00.000Z' });
    seedRichSpec(pendingDir, 'feb-spec', { title: 'February Spec', generatedAt: '2026-02-15T00:00:00.000Z' });

    const res = await request(app).get('/api/specs/archive?workspaceId=ws-test&createdBefore=2026-02-01T00:00:00.000Z').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('jan-spec');
  });

  test('date range combined with text search', async () => {
    const pendingDir = path.join(os.tmpdir(), 'scripts', 'ralph', 'specs', 'pending');
    seedRichSpec(pendingDir, 'auth-old', { title: 'Auth Module', generatedAt: '2026-01-10T00:00:00.000Z' });
    seedRichSpec(pendingDir, 'auth-new', { title: 'Auth System v2', generatedAt: '2026-02-20T00:00:00.000Z' });
    seedRichSpec(pendingDir, 'payment-new', { title: 'Payment System', generatedAt: '2026-02-20T00:00:00.000Z' });

    const res = await request(app)
      .get('/api/specs/archive?workspaceId=ws-test&q=auth&createdAfter=2026-02-01T00:00:00.000Z')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('auth-new');
  });

  test('empty search returns all specs without snippets', async () => {
    const pendingDir = path.join(os.tmpdir(), 'scripts', 'ralph', 'specs', 'pending');
    seedRichSpec(pendingDir, 'spec-a', { title: 'Spec A' });
    seedRichSpec(pendingDir, 'spec-b', { title: 'Spec B' });

    const res = await request(app).get('/api/specs/archive?workspaceId=ws-test').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    // No matchSnippets or relevanceScore when no query
    expect(res.body.items[0].matchSnippets).toBeUndefined();
    expect(res.body.items[0].relevanceScore).toBeUndefined();
  });

  test('no results for unmatched query', async () => {
    const pendingDir = path.join(os.tmpdir(), 'scripts', 'ralph', 'specs', 'pending');
    seedRichSpec(pendingDir, 'some-spec', { title: 'Some Feature' });

    const res = await request(app).get('/api/specs/archive?workspaceId=ws-test&q=zzzznonexistent').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });

  test('search respects status filter', async () => {
    const pendingDir = path.join(os.tmpdir(), 'scripts', 'ralph', 'specs', 'pending');
    const approvedDir = path.join(os.tmpdir(), 'scripts', 'ralph', 'specs', 'approved');
    seedRichSpec(pendingDir, 'auth-pending', { title: 'Auth Pending' });
    seedRichSpec(approvedDir, 'auth-approved', { title: 'Auth Approved' });

    const res = await request(app).get('/api/specs/archive?workspaceId=ws-test&q=auth&status=approved').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('auth-approved');
  });

  test('pagination works with search results', async () => {
    const pendingDir = path.join(os.tmpdir(), 'scripts', 'ralph', 'specs', 'pending');
    seedRichSpec(pendingDir, 'auth-one', { title: 'Auth One', generatedAt: '2026-02-20T12:00:00.000Z' });
    seedRichSpec(pendingDir, 'auth-two', { title: 'Auth Two', generatedAt: '2026-02-21T12:00:00.000Z' });
    seedRichSpec(pendingDir, 'auth-three', { title: 'Auth Three', generatedAt: '2026-02-22T12:00:00.000Z' });

    const res = await request(app).get('/api/specs/archive?workspaceId=ws-test&q=auth&limit=2&offset=0').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.total).toBe(3);
    expect(res.body.hasMore).toBe(true);

    // Second page
    const res2 = await request(app).get('/api/specs/archive?workspaceId=ws-test&q=auth&limit=2&offset=2').set('Authorization', `Bearer ${authToken}`);
    expect(res2.status).toBe(200);
    expect(res2.body.items).toHaveLength(1);
    expect(res2.body.hasMore).toBe(false);
  });
});

// ─── US-008: Batch Spec Generation with Brief Queue ────────────────────────────

describe('POST /api/specs/generate/batch', () => {
  test('accepts array of briefs and returns batchId + briefCount', async () => {
    mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 100, outputTokens: 200 } });

    const res = await request(app)
      .post('/api/specs/generate/batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        briefs: [
          { brief: 'Build user auth', workspaceId: 'ws-test', title: 'Auth Feature' },
          { brief: 'Build payments', workspaceId: 'ws-test', title: 'Payment Feature' },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.batchId).toBeDefined();
    expect(typeof res.body.batchId).toBe('string');
    expect(res.body.briefCount).toBe(2);
  });

  test('missing briefs array → 400', async () => {
    const res = await request(app)
      .post('/api/specs/generate/batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('briefs');
  });

  test('empty briefs array → 400', async () => {
    const res = await request(app)
      .post('/api/specs/generate/batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ briefs: [] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('empty');
  });

  test('brief missing required fields → 400 with index', async () => {
    const res = await request(app)
      .post('/api/specs/generate/batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        briefs: [
          { title: 'Valid', brief: 'Valid brief', workspaceId: 'ws-test' },
          { title: 'Missing WS', brief: 'Missing workspace' },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('index 1');
    expect(res.body.error).toContain('workspaceId');
  });

  test('brief with custom model is accepted (pass-through)', async () => {
    mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 100, outputTokens: 200 } });

    const res = await request(app)
      .post('/api/specs/generate/batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        briefs: [
          { title: 'Test Spec', brief: 'Test', workspaceId: 'ws-test', model: 'custom-model-v1' },
        ],
      });

    // Any model string is accepted for openai-compat pass-through
    expect(res.status).not.toBe(400);
  });

  test('emits batch_started WAL event', async () => {
    mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 100, outputTokens: 200 } });

    const res = await request(app)
      .post('/api/specs/generate/batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        briefs: [
          { brief: 'Build auth', workspaceId: 'ws-test', title: 'Batch WAL Test' },
        ],
      });

    expect(res.status).toBe(201);

    const event = db.prepare(
      "SELECT * FROM wal_events WHERE event_type = 'batch_started'"
    ).get() as { event_type: string; payload: string };

    expect(event).toBeDefined();
    const payload = JSON.parse(event.payload);
    expect(payload.batchId).toBe(res.body.batchId);
    expect(payload.briefCount).toBe(1);
  });
});

describe('GET /api/specs/generate/batch/:batchId', () => {
  test('returns batch status with per-brief progress', async () => {
    mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 100, outputTokens: 200 } });

    const createRes = await request(app)
      .post('/api/specs/generate/batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        briefs: [
          { brief: 'Build auth', workspaceId: 'ws-test', title: 'Batch Status A' },
          { brief: 'Build payments', workspaceId: 'ws-test', title: 'Batch Status B' },
        ],
      });

    expect(createRes.status).toBe(201);
    const { batchId } = createRes.body;

    // Wait for processing to complete
    await new Promise(resolve => setTimeout(resolve, 500));

    const statusRes = await request(app).get(`/api/specs/generate/batch/${batchId}`).set('Authorization', `Bearer ${authToken}`);

    expect(statusRes.status).toBe(200);
    expect(statusRes.body.batchId).toBe(batchId);
    expect(statusRes.body.createdAt).toBeDefined();
    expect(statusRes.body.totalBriefs).toBe(2);
    expect(statusRes.body.items).toHaveLength(2);
    expect(statusRes.body.summary).toBeDefined();
    expect(typeof statusRes.body.summary.completed).toBe('number');
    expect(typeof statusRes.body.summary.failed).toBe('number');
    expect(typeof statusRes.body.summary.generating).toBe('number');
    expect(typeof statusRes.body.summary.queued).toBe('number');
  });

  test('nonexistent batchId → 404', async () => {
    const res = await request(app).get('/api/specs/generate/batch/nonexistent-id').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('not found');
  });

  test('completed batch has finishedAt and all items completed', async () => {
    mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 50, outputTokens: 100 } });

    const createRes = await request(app)
      .post('/api/specs/generate/batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        briefs: [
          { brief: 'Single brief', workspaceId: 'ws-test', title: 'Finished Batch' },
        ],
      });

    const { batchId } = createRes.body;

    // Wait for processing to complete
    await new Promise(resolve => setTimeout(resolve, 1000));

    const statusRes = await request(app).get(`/api/specs/generate/batch/${batchId}`).set('Authorization', `Bearer ${authToken}`);

    expect(statusRes.status).toBe(200);
    expect(statusRes.body.finishedAt).toBeDefined();
    expect(statusRes.body.summary.completed).toBe(1);
    expect(statusRes.body.summary.queued).toBe(0);
    expect(statusRes.body.summary.generating).toBe(0);
    expect(statusRes.body.items[0].status).toBe('completed');
    expect(statusRes.body.items[0].slug).toBeDefined();
  });

  test('failed briefs captured with errors, do not block remaining briefs', async () => {
    // First call fails, second succeeds
    mockChatComplete
      .mockRejectedValueOnce(new Error('LLM timeout'))
      .mockResolvedValueOnce({ text: validLlmResponse, usage: { inputTokens: 50, outputTokens: 100 } });

    const createRes = await request(app)
      .post('/api/specs/generate/batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        briefs: [
          { brief: 'Will fail', workspaceId: 'ws-test', title: 'Failing Brief' },
          { brief: 'Will succeed', workspaceId: 'ws-test', title: 'Succeeding Brief' },
        ],
      });

    const { batchId } = createRes.body;

    // Wait for both to process
    await new Promise(resolve => setTimeout(resolve, 1500));

    const statusRes = await request(app).get(`/api/specs/generate/batch/${batchId}`).set('Authorization', `Bearer ${authToken}`);

    expect(statusRes.status).toBe(200);
    expect(statusRes.body.finishedAt).toBeDefined();
    expect(statusRes.body.summary.failed).toBe(1);
    expect(statusRes.body.summary.completed).toBe(1);

    // First item failed with error message
    const failedItem = statusRes.body.items.find((i: any) => i.status === 'failed');
    expect(failedItem).toBeDefined();
    expect(failedItem.error).toContain('LLM timeout');

    // Second item completed successfully
    const completedItem = statusRes.body.items.find((i: any) => i.status === 'completed');
    expect(completedItem).toBeDefined();
    expect(completedItem.slug).toBeDefined();
  });

  test('workspace not found for a brief sets status to failed', async () => {
    mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 50, outputTokens: 100 } });

    const createRes = await request(app)
      .post('/api/specs/generate/batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        briefs: [
          { brief: 'Bad workspace', workspaceId: 'nonexistent-ws', title: 'Bad WS' },
          { brief: 'Good workspace', workspaceId: 'ws-test', title: 'Good WS' },
        ],
      });

    const { batchId } = createRes.body;
    await new Promise(resolve => setTimeout(resolve, 1000));

    const statusRes = await request(app).get(`/api/specs/generate/batch/${batchId}`).set('Authorization', `Bearer ${authToken}`);

    expect(statusRes.status).toBe(200);
    expect(statusRes.body.summary.failed).toBe(1);
    expect(statusRes.body.summary.completed).toBe(1);

    const failedItem = statusRes.body.items[0];
    expect(failedItem.status).toBe('failed');
    expect(failedItem.error).toContain('Workspace not found');
  });

  test('emits batch_progress WAL events during processing', async () => {
    mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 50, outputTokens: 100 } });

    const createRes = await request(app)
      .post('/api/specs/generate/batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        briefs: [
          { brief: 'Progress test', workspaceId: 'ws-test', title: 'Progress Brief' },
        ],
      });

    await new Promise(resolve => setTimeout(resolve, 1000));

    const events = db.prepare(
      "SELECT * FROM wal_events WHERE event_type = 'batch_progress' ORDER BY id ASC"
    ).all() as { payload: string }[];

    // Should have at least 2 progress events: generating + completed/failed
    expect(events.length).toBeGreaterThanOrEqual(2);

    const firstPayload = JSON.parse(events[0].payload);
    expect(firstPayload.batchId).toBe(createRes.body.batchId);
    expect(firstPayload.briefIndex).toBe(0);
    expect(firstPayload.totalBriefs).toBe(1);
    expect(firstPayload.status).toBe('generating');

    const secondPayload = JSON.parse(events[1].payload);
    expect(secondPayload.status).toBe('completed');
    expect(secondPayload.slug).toBeDefined();
  });
});

// ─── V2-083: Story Exclusion ─────────────────────────────────────────────────

describe('V2-083: Story exclusion', () => {
  function seedSpecWithStories(dir: string, slug: string) {
    fs.mkdirSync(dir, { recursive: true });
    const spec = {
      title: slug.replace(/-/g, ' '),
      userStories: [
        { id: 'US-001', title: 'Story one', description: 'Desc 1', acceptanceCriteria: ['AC1'], dependsOn: [], passes: false },
        { id: 'US-002', title: 'Story two', description: 'Desc 2', acceptanceCriteria: ['AC2'], dependsOn: ['US-001'], passes: false },
        { id: 'US-003', title: 'Story three', description: 'Desc 3', acceptanceCriteria: ['AC3'], dependsOn: [], passes: false },
      ],
      generatedAt: '2026-02-20T12:00:00.000Z',
    };
    const specPath = path.join(dir, `${slug}.json`);
    fs.writeFileSync(specPath, JSON.stringify(spec, null, 2), 'utf8');
    return { spec, specPath };
  }

  test('PATCH /:specId/stories/:storyId toggles excluded flag', async () => {
    const approvedDir = path.join(os.tmpdir(), 'scripts', 'ralph', 'specs', 'approved');
    seedSpecWithStories(approvedDir, 'excl-test');

    // Exclude US-002
    const res = await request(app)
      .patch('/api/specs/excl-test/stories/US-002')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test', excluded: true });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.story.excluded).toBe(true);

    // Verify persisted to JSON
    const content = JSON.parse(fs.readFileSync(path.join(approvedDir, 'excl-test.json'), 'utf8'));
    expect(content.userStories[1].excluded).toBe(true);
    expect(content.userStories[0].excluded).toBeFalsy();

    // Re-include US-002
    const res2 = await request(app)
      .patch('/api/specs/excl-test/stories/US-002')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test', excluded: false });

    expect(res2.status).toBe(200);
    expect(res2.body.story.excluded).toBe(false);
  });

  test('PATCH emits WAL event for exclusion toggle', async () => {
    const approvedDir = path.join(os.tmpdir(), 'scripts', 'ralph', 'specs', 'approved');
    seedSpecWithStories(approvedDir, 'excl-wal');

    await request(app)
      .patch('/api/specs/excl-wal/stories/US-001')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test', excluded: true });

    const events = db.prepare(
      "SELECT * FROM wal_events WHERE event_type = 'story_excluded' AND spec_id = 'excl-wal'"
    ).all() as { story_id: string; payload: string }[];

    expect(events).toHaveLength(1);
    expect(events[0].story_id).toBe('US-001');
  });

  test('PATCH returns 404 for non-existent story', async () => {
    const approvedDir = path.join(os.tmpdir(), 'scripts', 'ralph', 'specs', 'approved');
    seedSpecWithStories(approvedDir, 'excl-404');

    const res = await request(app)
      .patch('/api/specs/excl-404/stories/US-999')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test', excluded: true });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Story not found');
  });

  test('bulk exclude marks multiple stories as excluded', async () => {
    const approvedDir = path.join(os.tmpdir(), 'scripts', 'ralph', 'specs', 'approved');
    seedSpecWithStories(approvedDir, 'bulk-excl');

    const res = await request(app)
      .post('/api/specs/bulk-excl/stories/bulk')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test', action: 'exclude', storyIds: ['US-001', 'US-003'] });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.affectedCount).toBe(2);

    const content = JSON.parse(fs.readFileSync(path.join(approvedDir, 'bulk-excl.json'), 'utf8'));
    expect(content.userStories[0].excluded).toBe(true);
    expect(content.userStories[1].excluded).toBeFalsy();
    expect(content.userStories[2].excluded).toBe(true);
  });

  test('bulk include re-includes excluded stories', async () => {
    const approvedDir = path.join(os.tmpdir(), 'scripts', 'ralph', 'specs', 'approved');
    seedSpecWithStories(approvedDir, 'bulk-incl');

    // First exclude
    await request(app)
      .post('/api/specs/bulk-incl/stories/bulk')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test', action: 'exclude', storyIds: ['US-001', 'US-002'] });

    // Then re-include
    const res = await request(app)
      .post('/api/specs/bulk-incl/stories/bulk')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test', action: 'include', storyIds: ['US-001'] });

    expect(res.status).toBe(200);

    const content = JSON.parse(fs.readFileSync(path.join(approvedDir, 'bulk-incl.json'), 'utf8'));
    expect(content.userStories[0].excluded).toBe(false);
    expect(content.userStories[1].excluded).toBe(true);
  });

  test('story_results accepts excluded status', () => {
    // Create a pipeline run to reference
    const runResult = db.prepare(
      "INSERT INTO pipeline_runs (spec_path, workspace_id, status) VALUES ('test.json', 'ws-test', 'running')"
    ).run();
    const runId = runResult.lastInsertRowid as number;

    // Insert excluded story result
    db.prepare(
      "INSERT INTO story_results (run_id, story_id, status, finished_at) VALUES (?, 'US-001', 'excluded', datetime('now'))"
    ).run(runId);

    const row = db.prepare(
      "SELECT * FROM story_results WHERE run_id = ? AND story_id = 'US-001'"
    ).get(runId) as { status: string };

    expect(row.status).toBe('excluded');
  });
});
