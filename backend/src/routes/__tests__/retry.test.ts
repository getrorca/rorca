import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import request from 'supertest';
import { getAuthToken } from './helpers/auth-helper';

let app: Express;
let db: Database.Database;
let tmpDir: string;
let authToken: string;

beforeEach(async () => {
  jest.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorcha-retry-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  process.env.DB_PATH = dbPath;
  process.env.NODE_ENV = 'test';
  const serverMod = require('../../server');
  app = serverMod.default;
  const dbMod = require('../../db/index');
  db = dbMod.db;
  authToken = await getAuthToken(app);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
  delete process.env.NODE_ENV;
});

function createWorkspace(id = 'ws-retry-1') {
  // Create workspace dir with run-loop.sh and spec file
  const scriptsDir = path.join(tmpDir, 'scripts', 'ralph', 'specs', 'approved');
  fs.mkdirSync(scriptsDir, { recursive: true });

  // Create a minimal run-loop.sh that exits immediately
  fs.writeFileSync(path.join(tmpDir, 'scripts', 'run-loop.sh'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });

  // Create a spec file
  const spec = {
    title: 'test-spec',
    userStories: [
      { id: 'US-001', title: 'Story 1', description: 'First', acceptanceCriteria: [], dependsOn: [], passes: false },
      { id: 'US-002', title: 'Story 2', description: 'Second', acceptanceCriteria: [], dependsOn: [], passes: false },
      { id: 'US-003', title: 'Story 3', description: 'Third', acceptanceCriteria: [], dependsOn: [], passes: false },
    ],
  };
  fs.writeFileSync(path.join(scriptsDir, 'test-spec.json'), JSON.stringify(spec));

  db.prepare(
    `INSERT INTO workspaces (id, label, path) VALUES (?, ?, ?)`
  ).run(id, 'Retry Test Workspace', tmpDir);
}

function createRunWithStories(workspaceId = 'ws-retry-1') {
  const result = db.prepare(
    `INSERT INTO pipeline_runs (spec_path, workspace_id, status, finished_at) VALUES (?, ?, 'failed', datetime('now'))`
  ).run('ralph/specs/approved/test-spec.json', workspaceId);
  const runId = result.lastInsertRowid as number;

  // US-001 passed, US-002 failed, US-003 failed
  db.prepare(
    `INSERT INTO story_results (run_id, story_id, status, retries, finished_at) VALUES (?, 'US-001', 'pass', 0, datetime('now'))`
  ).run(runId);
  db.prepare(
    `INSERT INTO story_results (run_id, story_id, status, retries, finished_at) VALUES (?, 'US-002', 'fail', 0, datetime('now'))`
  ).run(runId);
  db.prepare(
    `INSERT INTO story_results (run_id, story_id, status, retries, finished_at) VALUES (?, 'US-003', 'fail', 0, datetime('now'))`
  ).run(runId);

  return runId;
}

// ─── Test 1: Retry all failed stories when storyIds omitted ──────────────────

test('POST /api/pipeline/runs/:runId/retry retries all failed stories when storyIds omitted', async () => {
  createWorkspace();
  const runId = createRunWithStories();

  const res = await request(app)
    .post(`/api/pipeline/runs/${runId}/retry`)
    .set('Authorization', `Bearer ${authToken}`)
    .send({});

  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(res.body.runId).toBe(runId);
  expect(res.body.retriedStories).toHaveLength(2);
  expect(res.body.retriedStories.map((s: any) => s.storyId).sort()).toEqual(['US-002', 'US-003']);
  expect(res.body.retriedStories[0].attempt).toBe(1);

  // Run should be back to 'running'
  const run = db.prepare('SELECT * FROM pipeline_runs WHERE id = ?').get(runId) as any;
  expect(run.status).toBe('running');
});

// ─── Test 2: Retry specific stories via storyIds ─────────────────────────────

test('POST /api/pipeline/runs/:runId/retry retries only specified storyIds', async () => {
  createWorkspace();
  const runId = createRunWithStories();

  const res = await request(app)
    .post(`/api/pipeline/runs/${runId}/retry`)
    .set('Authorization', `Bearer ${authToken}`)
    .send({ storyIds: ['US-002'] });

  expect(res.status).toBe(200);
  expect(res.body.retriedStories).toHaveLength(1);
  expect(res.body.retriedStories[0].storyId).toBe('US-002');
  expect(res.body.retriedStories[0].attempt).toBe(1);
});

// ─── Test 3: New story_result rows created with incremented retry count ──────

test('Retry creates new story_result rows with incremented retry count', async () => {
  createWorkspace();
  const runId = createRunWithStories();

  await request(app)
    .post(`/api/pipeline/runs/${runId}/retry`)
    .set('Authorization', `Bearer ${authToken}`)
    .send({ storyIds: ['US-002'] });

  const stories = db.prepare(
    `SELECT * FROM story_results WHERE run_id = ? AND story_id = 'US-002' ORDER BY id ASC`
  ).all(runId) as any[];

  // Original + retry
  expect(stories).toHaveLength(2);
  expect(stories[0].status).toBe('fail');
  expect(stories[0].retries).toBe(0);
  expect(stories[1].status).toBe('retry');
  expect(stories[1].retries).toBe(1);
});

// ─── Test 4: Original failed story_result rows preserved ─────────────────────

test('Original failed story_result rows are preserved (audit trail)', async () => {
  createWorkspace();
  const runId = createRunWithStories();

  const beforeStories = db.prepare(
    `SELECT * FROM story_results WHERE run_id = ?`
  ).all(runId) as any[];
  expect(beforeStories).toHaveLength(3);

  await request(app)
    .post(`/api/pipeline/runs/${runId}/retry`)
    .set('Authorization', `Bearer ${authToken}`)
    .send({});

  const afterStories = db.prepare(
    `SELECT * FROM story_results WHERE run_id = ?`
  ).all(runId) as any[];

  // Original 3 + 2 retry rows = 5
  expect(afterStories).toHaveLength(5);

  // Original rows still present
  const originals = afterStories.filter((s: any) => s.retries === 0);
  expect(originals).toHaveLength(3);
});

// ─── Test 5: story_retried WAL events emitted ────────────────────────────────

test('Retry emits story_retried WAL events for each retried story', async () => {
  createWorkspace();
  const runId = createRunWithStories();

  await request(app)
    .post(`/api/pipeline/runs/${runId}/retry`)
    .set('Authorization', `Bearer ${authToken}`)
    .send({});

  const events = db.prepare(
    `SELECT * FROM wal_events WHERE event_type = 'story_retried'`
  ).all() as any[];

  expect(events).toHaveLength(2);

  const payloads = events.map((e: any) => JSON.parse(e.payload));
  expect(payloads[0].run_id).toBe(runId);
  expect(payloads[0].attempt).toBe(1);
  expect(payloads.map((p: any) => p.story_id).sort()).toEqual(['US-002', 'US-003']);
});

// ─── Test 6: Cannot retry a running run ──────────────────────────────────────

test('POST /api/pipeline/runs/:runId/retry returns 409 for running run', async () => {
  createWorkspace();
  const result = db.prepare(
    `INSERT INTO pipeline_runs (spec_path, workspace_id, status) VALUES (?, ?, 'running')`
  ).run('ralph/specs/approved/test-spec.json', 'ws-retry-1');
  const runId = result.lastInsertRowid as number;

  const res = await request(app)
    .post(`/api/pipeline/runs/${runId}/retry`)
    .set('Authorization', `Bearer ${authToken}`)
    .send({});

  expect(res.status).toBe(409);
  expect(res.body.error).toContain('Cannot retry');
});

// ─── Test 7: Returns 404 for nonexistent run ─────────────────────────────────

test('POST /api/pipeline/runs/:runId/retry returns 404 for nonexistent run', async () => {
  const res = await request(app)
    .post('/api/pipeline/runs/99999/retry')
    .set('Authorization', `Bearer ${authToken}`)
    .send({});

  expect(res.status).toBe(404);
  expect(res.body.error).toBe('Run not found');
});

// ─── Test 8: Returns 422 when no failed stories exist ────────────────────────

test('POST /api/pipeline/runs/:runId/retry returns 422 when no stories have failed', async () => {
  createWorkspace();
  const result = db.prepare(
    `INSERT INTO pipeline_runs (spec_path, workspace_id, status, finished_at) VALUES (?, ?, 'done', datetime('now'))`
  ).run('ralph/specs/approved/test-spec.json', 'ws-retry-1');
  const runId = result.lastInsertRowid as number;

  // All stories passed
  db.prepare(
    `INSERT INTO story_results (run_id, story_id, status, retries) VALUES (?, 'US-001', 'pass', 0)`
  ).run(runId);

  const res = await request(app)
    .post(`/api/pipeline/runs/${runId}/retry`)
    .set('Authorization', `Bearer ${authToken}`)
    .send({});

  expect(res.status).toBe(422);
  expect(res.body.error).toContain('No failed stories');
});

// ─── Test 9: Returns 422 when specified storyIds don't match failed stories ──

test('POST /api/pipeline/runs/:runId/retry returns 422 when storyIds do not match any failed stories', async () => {
  createWorkspace();
  const runId = createRunWithStories();

  const res = await request(app)
    .post(`/api/pipeline/runs/${runId}/retry`)
    .set('Authorization', `Bearer ${authToken}`)
    .send({ storyIds: ['US-001'] }); // US-001 passed, not failed

  expect(res.status).toBe(422);
  expect(res.body.error).toContain('None of the specified storyIds');
});

// ─── Test 10: SSE stream broadcasts story_retried events ─────────────────────

test('story_retried events are broadcast to SSE subscribers', async () => {
  createWorkspace();
  const runId = createRunWithStories();

  const sseHub = require('../../lib/sse-hub');
  const received: any[] = [];
  const unsubscribe = sseHub.subscribe((event: any) => {
    received.push(event);
  });

  await request(app)
    .post(`/api/pipeline/runs/${runId}/retry`)
    .set('Authorization', `Bearer ${authToken}`)
    .send({ storyIds: ['US-002'] });

  const retryEvents = received.filter((e: any) => e.event_type === 'story_retried');
  expect(retryEvents).toHaveLength(1);
  expect(retryEvents[0].story_id).toBe('US-002');

  const payload = JSON.parse(retryEvents[0].payload);
  expect(payload.attempt).toBe(1);
  expect(payload.run_id).toBe(runId);

  unsubscribe();
});

// ─── Test 11: partial_failure status in pipeline_runs ────────────────────────

test('partial_failure status is accepted in pipeline_runs table', () => {
  createWorkspace();
  const result = db.prepare(
    `INSERT INTO pipeline_runs (spec_path, workspace_id, status) VALUES (?, ?, 'partial_failure')`
  ).run('ralph/specs/approved/test-spec.json', 'ws-retry-1');

  const run = db.prepare('SELECT * FROM pipeline_runs WHERE id = ?').get(result.lastInsertRowid) as any;
  expect(run.status).toBe('partial_failure');
});

// ─── Test 12: Retry increments attempt on subsequent retries ─────────────────

test('Second retry increments attempt number to 2', async () => {
  createWorkspace();
  const runId = createRunWithStories();

  // First retry
  await request(app)
    .post(`/api/pipeline/runs/${runId}/retry`)
    .set('Authorization', `Bearer ${authToken}`)
    .send({ storyIds: ['US-002'] });

  // Simulate the retry failing again: update the retry row to 'fail'
  db.prepare(
    `UPDATE story_results SET status = 'fail', finished_at = datetime('now') WHERE run_id = ? AND story_id = 'US-002' AND retries = 1`
  ).run(runId);

  // Set run back to failed so we can retry again
  db.prepare(`UPDATE pipeline_runs SET status = 'failed', finished_at = datetime('now') WHERE id = ?`).run(runId);

  // Second retry
  const res = await request(app)
    .post(`/api/pipeline/runs/${runId}/retry`)
    .set('Authorization', `Bearer ${authToken}`)
    .send({ storyIds: ['US-002'] });

  expect(res.status).toBe(200);
  expect(res.body.retriedStories[0].attempt).toBe(2);

  const stories = db.prepare(
    `SELECT * FROM story_results WHERE run_id = ? AND story_id = 'US-002' ORDER BY id ASC`
  ).all(runId) as any[];

  expect(stories).toHaveLength(3); // original fail + retry 1 + retry 2
  expect(stories[0].retries).toBe(0);
  expect(stories[1].retries).toBe(1);
  expect(stories[2].retries).toBe(2);
});
