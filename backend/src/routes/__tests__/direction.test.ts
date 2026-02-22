import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import request from 'supertest';

let app: Express;
let db: Database.Database;
let tmpDir: string;

beforeEach(() => {
  jest.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorcha-direction-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  process.env.DB_PATH = dbPath;
  process.env.NODE_ENV = 'test';
  const serverMod = require('../../server');
  app = serverMod.default;
  const dbMod = require('../../db/index');
  db = dbMod.db;
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
  delete process.env.NODE_ENV;
});

const validWorkspace = {
  id: 'ws-dir-test',
  label: 'Direction Test',
  path: os.tmpdir(),
  domains: ['backend'],
};

// --- PUT + GET basic tests ---

test('PUT layer=1 + GET returns matching contentYaml', async () => {
  const putRes = await request(app)
    .put('/api/direction')
    .send({ layer: 1, contentYaml: 'quality: high' });
  expect(putRes.status).toBe(200);
  expect(putRes.body).toEqual({ ok: true });
});

test('PUT layer=2 with domain + GET returns correct row', async () => {
  await request(app)
    .put('/api/direction')
    .send({ layer: 2, domain: 'backend', contentYaml: 'style: concise' });

  // Verify via preview that L2 is included
  const res = await request(app)
    .get('/api/direction/preview?brief=test&domain=backend');
  expect(res.status).toBe(200);
  expect(res.body.synthesized).toContain('style: concise');
});

// --- Preview with hydrated context ---

test('GET /api/direction/preview with hydrated workspace includes schema section', async () => {
  // Create workspace
  await request(app).post('/api/workspaces').send(validWorkspace);

  // Set L3
  await request(app)
    .put('/api/direction')
    .send({ layer: 3, workspaceId: 'ws-dir-test', contentYaml: 'goal: ship v2' });

  // Seed workspace_context with schema + git
  db.prepare(
    `INSERT INTO workspace_context (workspace_id, schema_snapshot, schema_table_count, git_memory, git_commit_count)
     VALUES (?, ?, ?, ?, ?)`
  ).run('ws-dir-test', 'CREATE TABLE users (id TEXT);', 1, 'conventions:\n  - use snake_case', 42);

  const res = await request(app)
    .get('/api/direction/preview?brief=build+auth&workspaceId=ws-dir-test');

  expect(res.status).toBe(200);
  expect(res.body.synthesized).toContain('=== DATABASE SCHEMA (Auto-Hydrated) ===');
  expect(res.body.synthesized).toContain('CREATE TABLE users (id TEXT);');
  expect(res.body.synthesized).toContain('=== PROJECT MEMORY (Git History) ===');
  expect(res.body.synthesized).toContain('use snake_case');
  expect(res.body.schemaTableCount).toBe(1);
  expect(res.body.gitCommitCount).toBe(42);
});

test('GET /api/direction/preview with no workspace_context omits schema/git sections gracefully', async () => {
  // Create workspace but do NOT seed workspace_context
  await request(app).post('/api/workspaces').send(validWorkspace);

  const res = await request(app)
    .get('/api/direction/preview?brief=build+auth&workspaceId=ws-dir-test');

  expect(res.status).toBe(200);
  expect(res.body.synthesized).not.toContain('=== DATABASE SCHEMA (Auto-Hydrated) ===');
  expect(res.body.synthesized).not.toContain('=== PROJECT MEMORY (Git History) ===');
  expect(res.body.schemaTableCount).toBeNull();
  expect(res.body.gitCommitCount).toBeNull();
});

test('GET /api/direction/preview without workspaceId omits hydrated sections', async () => {
  const res = await request(app)
    .get('/api/direction/preview?brief=generic+spec');

  expect(res.status).toBe(200);
  expect(res.body.synthesized).toContain('=== SPEC BRIEF (L4) ===');
  expect(res.body.synthesized).not.toContain('=== DATABASE SCHEMA (Auto-Hydrated) ===');
  expect(res.body.schemaTableCount).toBeNull();
  expect(res.body.gitCommitCount).toBeNull();
});

// --- WAL events ---

test('WAL event logged for direction_update on PUT', async () => {
  await request(app)
    .put('/api/direction')
    .send({ layer: 1, contentYaml: 'quality: high' });

  const events = db
    .prepare("SELECT event_type FROM wal_events WHERE event_type = 'direction_update'")
    .all() as { event_type: string }[];

  expect(events).toHaveLength(1);
  expect(events[0].event_type).toBe('direction_update');
});
