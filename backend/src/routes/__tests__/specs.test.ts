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
    getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
    isValidModel: jest.fn().mockImplementation((m: string) =>
      ['claude-sonnet-4-5-20250929', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'].includes(m)
    ),
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
  mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 100, outputTokens: 200 } });

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
  mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 100, outputTokens: 200 } });

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
    .send({
      workspaceId: 'ws-test',
      title: 'Model Test',
      brief: 'Test model selection',
      model: 'claude-opus-4-6',
    });

  expect(res.status).toBe(200);
  expect(res.body.model).toBe('claude-opus-4-6');
  expect(res.body.usage).toEqual({ inputTokens: 50, outputTokens: 100 });

  // chatComplete should have been called with the model
  expect(mockChatComplete).toHaveBeenCalledWith(
    expect.any(Array),
    'claude-opus-4-6',
  );
});

test('POST /api/specs/generate with invalid model returns 400', async () => {
  const res = await request(app)
    .post('/api/specs/generate')
    .send({
      workspaceId: 'ws-test',
      title: 'Bad Model',
      brief: 'Test bad model',
      model: 'gpt-4o',
    });

  expect(res.status).toBe(400);
  expect(res.body.error).toContain('Invalid model');
  expect(res.body.error).toContain('gpt-4o');
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
    .send({
      workspaceId: 'ws-test',
      title: 'Default Model Test',
      brief: 'Test default model from L3',
    });

  expect(res.status).toBe(200);
  expect(res.body.model).toBe('claude-haiku-4-5-20251001');
  expect(mockChatComplete).toHaveBeenCalledWith(
    expect.any(Array),
    'claude-haiku-4-5-20251001',
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

// ─── US-001: Version History + Diff ───────────────────────────────────────────

describe('GET /api/specs/:specId/versions', () => {
  test('returns empty array when no versions exist', async () => {
    const res = await request(app).get('/api/specs/nonexistent-slug/versions');
    expect(res.status).toBe(200);
    expect(res.body.specSlug).toBe('nonexistent-slug');
    expect(res.body.versions).toEqual([]);
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
      .send({ workspaceId: 'ws-test', reason: 'Needs more stories' });

    const res = await request(app).get('/api/specs/versioned-spec/versions');
    expect(res.status).toBe(200);
    expect(res.body.versions).toHaveLength(1);
    expect(res.body.versions[0].version).toBe(1);
    expect(res.body.versions[0].status).toBe('rejected');
    expect(res.body.versions[0].rejectionReason).toBe('Needs more stories');
    expect(res.body.versions[0].title).toBe('Versioned Spec');
    expect(res.body.versions[0].storyCount).toBe(2);
    expect(res.body.versions[0].createdAt).toBeDefined();
  });

  test('returns multiple versions in ascending order', async () => {
    // Manually insert two versions
    db.prepare(
      `INSERT INTO spec_versions (spec_slug, version, content_json, status) VALUES (?, ?, ?, ?)`
    ).run('multi-ver', 1, JSON.stringify({ title: 'V1', userStories: [] }), 'rejected');
    db.prepare(
      `INSERT INTO spec_versions (spec_slug, version, content_json, status) VALUES (?, ?, ?, ?)`
    ).run('multi-ver', 2, JSON.stringify({ title: 'V2', userStories: [{ id: 'US-001', title: 'S1' }] }), 'pending');

    const res = await request(app).get('/api/specs/multi-ver/versions');
    expect(res.status).toBe(200);
    expect(res.body.versions).toHaveLength(2);
    expect(res.body.versions[0].version).toBe(1);
    expect(res.body.versions[0].title).toBe('V1');
    expect(res.body.versions[0].storyCount).toBe(0);
    expect(res.body.versions[1].version).toBe(2);
    expect(res.body.versions[1].title).toBe('V2');
    expect(res.body.versions[1].storyCount).toBe(1);
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
    const res = await request(app).get('/api/specs/diff-test/diff?v1=1&v2=2');
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
    const res = await request(app).get('/api/specs/diff-test/diff?v1=1');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('v1 and v2');
  });

  test('same v1 and v2 → 400', async () => {
    const res = await request(app).get('/api/specs/diff-test/diff?v1=1&v2=1');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('different');
  });

  test('nonexistent version → 404', async () => {
    const res = await request(app).get('/api/specs/diff-test/diff?v1=1&v2=99');
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('v99');
  });

  test('both versions missing → 404 mentioning both', async () => {
    const res = await request(app).get('/api/specs/diff-test/diff?v1=98&v2=99');
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('v98');
    expect(res.body.error).toContain('v99');
  });
});
