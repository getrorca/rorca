import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import request from 'supertest';
import { getAuthToken } from './helpers/auth-helper';

jest.mock('../../lib/llm-client', () => ({
  chatComplete: jest.fn(),
  getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
  isValidModel: jest.fn().mockReturnValue(true),
  DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
  SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
}));

let app: Express;
let db: Database.Database;
let tmpDir: string;
let authToken: string;

const spec1 = {
  title: 'Timeout Test Spec',
  userStories: [
    {
      id: 'US-001',
      title: 'Short story',
      description: 'A quick task',
      acceptanceCriteria: ['Done quickly'],
      dependsOn: [],
    },
    {
      id: 'US-002',
      title: 'Long story',
      description: 'An infrastructure task that takes a while',
      acceptanceCriteria: ['Infrastructure deployed', 'Health checks pass'],
      dependsOn: [],
      timeoutMinutes: 90,
    },
  ],
  generatedAt: '2026-02-23T00:00:00Z',
};

beforeEach(async () => {
  jest.resetModules();

  jest.mock('../../lib/llm-client', () => ({
    chatComplete: jest.fn(),
    getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
    isValidModel: jest.fn().mockReturnValue(true),
    DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
    SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
  }));

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorcha-timeout-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  process.env.DB_PATH = dbPath;
  process.env.NODE_ENV = 'test';

  const serverMod = require('../../server');
  app = serverMod.default;
  const dbMod = require('../../db/index');
  db = dbMod.db;

  // Seed workspace
  db.prepare(
    "INSERT INTO workspaces (id, label, path) VALUES ('ws-test', 'Test Workspace', ?)"
  ).run(tmpDir);

  // Create spec file on disk
  const pendingDir = path.join(tmpDir, 'scripts', 'ralph', 'specs', 'pending');
  fs.mkdirSync(pendingDir, { recursive: true });
  fs.writeFileSync(path.join(pendingDir, 'timeout-test.json'), JSON.stringify(spec1));

  authToken = await getAuthToken(app);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
  delete process.env.NODE_ENV;
});

test('PUT story update accepts timeoutMinutes', async () => {
  const res = await request(app)
    .put('/api/specs/timeout-test/stories/US-001')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ workspaceId: 'ws-test', timeoutMinutes: 15 });

  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(res.body.story.timeoutMinutes).toBe(15);

  // Verify persisted to disk
  const raw = JSON.parse(
    fs.readFileSync(path.join(tmpDir, 'scripts', 'ralph', 'specs', 'pending', 'timeout-test.json'), 'utf8')
  );
  const story = raw.userStories.find((s: any) => s.id === 'US-001');
  expect(story.timeoutMinutes).toBe(15);
});

test('PUT story update rejects timeoutMinutes below 5', async () => {
  const res = await request(app)
    .put('/api/specs/timeout-test/stories/US-001')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ workspaceId: 'ws-test', timeoutMinutes: 3 });

  expect(res.status).toBe(400);
  expect(res.body.error).toContain('timeoutMinutes');
});

test('PUT story update rejects timeoutMinutes above 120', async () => {
  const res = await request(app)
    .put('/api/specs/timeout-test/stories/US-001')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ workspaceId: 'ws-test', timeoutMinutes: 200 });

  expect(res.status).toBe(400);
  expect(res.body.error).toContain('timeoutMinutes');
});

test('PUT story update rejects non-integer timeoutMinutes', async () => {
  const res = await request(app)
    .put('/api/specs/timeout-test/stories/US-001')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ workspaceId: 'ws-test', timeoutMinutes: 30.5 });

  expect(res.status).toBe(400);
  expect(res.body.error).toContain('timeoutMinutes');
});

test('existing timeoutMinutes is preserved when not provided in update', async () => {
  // US-002 already has timeoutMinutes: 90 in the spec
  const res = await request(app)
    .put('/api/specs/timeout-test/stories/US-002')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ workspaceId: 'ws-test', title: 'Updated long story' });

  expect(res.status).toBe(200);
  expect(res.body.story.title).toBe('Updated long story');
  expect(res.body.story.timeoutMinutes).toBe(90); // preserved
});

test('story_results table accepts timeout status', async () => {
  // Create a pipeline run first
  const runResult = db.prepare(
    "INSERT INTO pipeline_runs (spec_path, workspace_id, status) VALUES ('test.json', 'ws-test', 'running')"
  ).run();
  const runId = runResult.lastInsertRowid;

  // Insert a timeout story result
  const storyResult = db.prepare(
    "INSERT INTO story_results (run_id, story_id, status, elapsed_seconds) VALUES (?, 'US-001', 'timeout', 2700)"
  ).run(runId);

  expect(storyResult.lastInsertRowid).toBeGreaterThan(0);

  // Verify it can be read back
  const row = db.prepare('SELECT * FROM story_results WHERE id = ?').get(storyResult.lastInsertRowid) as any;
  expect(row.status).toBe('timeout');
  expect(row.elapsed_seconds).toBe(2700);
});
