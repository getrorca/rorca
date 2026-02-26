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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-retry-test-'));
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

// ─── Test 1: Retry all failed stories creates new run ──────────────────────────

test('POST /api/pipeline/runs/:runId/retry creates new run and retries all failed stories when storyIds omitted', async () => {
  createWorkspace();
  const originalRunId = createRunWithStories();

  const res = await request(app)
    .post(`/api/pipeline/runs/${originalRunId}/retry`)
    .set('Authorization', `Bearer ${authToken}`)
    .send({});

  expect(res.status).toBe(201);
  expect(res.body.ok).toBe(true);
  expect(res.body.originalRunId).toBe(originalRunId);
  expect(res.body.runId).not.toBe(originalRunId); // New run created
  expect(res.body.retriedStories).toHaveLength(2);
  expect(res.body.retriedStories.map((s: any) => s.storyId).sort()).toEqual(['US-002', 'US-003']);
  expect(res.body.retriedStories[0].attempt).toBe(1);
  expect(res.body.copiedStories).toEqual(['US-001']); // Passed story copied

  // New run should be 'running' with retried_from_run_id
  const newRun = db.prepare('SELECT * FROM pipeline_runs WHERE id = ?').get(res.body.runId) as any;
  expect(newRun.status).toBe('running');
  expect(newRun.retried_from_run_id).toBe(originalRunId);

  // Original run stays as 'failed'
  const originalRun = db.prepare('SELECT * FROM pipeline_runs WHERE id = ?').get(originalRunId) as any;
  expect(originalRun.status).toBe('failed');
});

// ─── Test 2: Retry specific stories via storyIds ─────────────────────────────

test('POST /api/pipeline/runs/:runId/retry retries only specified storyIds', async () => {
  createWorkspace();
  const originalRunId = createRunWithStories();

  const res = await request(app)
    .post(`/api/pipeline/runs/${originalRunId}/retry`)
    .set('Authorization', `Bearer ${authToken}`)
    .send({ storyIds: ['US-002'] });

  expect(res.status).toBe(201);
  expect(res.body.retriedStories).toHaveLength(1);
  expect(res.body.retriedStories[0].storyId).toBe('US-002');
  expect(res.body.retriedStories[0].attempt).toBe(1);
});

// ─── Test 3: New run gets copied pass results + retry placeholders ────────────

test('Retry creates new run with copied pass results and retry placeholders', async () => {
  createWorkspace();
  const originalRunId = createRunWithStories();

  const res = await request(app)
    .post(`/api/pipeline/runs/${originalRunId}/retry`)
    .set('Authorization', `Bearer ${authToken}`)
    .send({ storyIds: ['US-002'] });

  const newRunId = res.body.runId;

  // New run should have: 1 copied pass (US-001) + 1 retry placeholder (US-002)
  const newStories = db.prepare(
    `SELECT * FROM story_results WHERE run_id = ? ORDER BY story_id ASC`
  ).all(newRunId) as any[];

  expect(newStories).toHaveLength(2);

  const us001 = newStories.find((s: any) => s.story_id === 'US-001');
  expect(us001.status).toBe('pass'); // Copied from original
  expect(us001.retries).toBe(0);

  const us002 = newStories.find((s: any) => s.story_id === 'US-002');
  expect(us002.status).toBe('retry');
  expect(us002.retries).toBe(1);
});

// ─── Test 4: Original run's story results are untouched ─────────────────────

test('Original run story_result rows are preserved unchanged', async () => {
  createWorkspace();
  const originalRunId = createRunWithStories();

  const beforeStories = db.prepare(
    `SELECT * FROM story_results WHERE run_id = ?`
  ).all(originalRunId) as any[];
  expect(beforeStories).toHaveLength(3);

  await request(app)
    .post(`/api/pipeline/runs/${originalRunId}/retry`)
    .set('Authorization', `Bearer ${authToken}`)
    .send({});

  // Original run should still have exactly 3 stories, unchanged
  const afterStories = db.prepare(
    `SELECT * FROM story_results WHERE run_id = ?`
  ).all(originalRunId) as any[];
  expect(afterStories).toHaveLength(3);

  const originals = afterStories.filter((s: any) => s.retries === 0);
  expect(originals).toHaveLength(3);
});

// ─── Test 5: story_retried WAL events emitted with new run ID ────────────────

test('Retry emits story_retried WAL events referencing the new run', async () => {
  createWorkspace();
  const originalRunId = createRunWithStories();

  const res = await request(app)
    .post(`/api/pipeline/runs/${originalRunId}/retry`)
    .set('Authorization', `Bearer ${authToken}`)
    .send({});

  const newRunId = res.body.runId;

  const events = db.prepare(
    `SELECT * FROM wal_events WHERE event_type = 'story_retried'`
  ).all() as any[];

  expect(events).toHaveLength(2);

  const payloads = events.map((e: any) => JSON.parse(e.payload));
  expect(payloads[0].run_id).toBe(newRunId);
  expect(payloads[0].original_run_id).toBe(originalRunId);
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
  const originalRunId = createRunWithStories();

  const sseHub = require('../../lib/sse-hub');
  const received: any[] = [];
  const unsubscribe = sseHub.subscribe((event: any) => {
    received.push(event);
  });

  const res = await request(app)
    .post(`/api/pipeline/runs/${originalRunId}/retry`)
    .set('Authorization', `Bearer ${authToken}`)
    .send({ storyIds: ['US-002'] });

  const newRunId = res.body.runId;

  const retryEvents = received.filter((e: any) => e.event_type === 'story_retried');
  expect(retryEvents).toHaveLength(1);
  expect(retryEvents[0].story_id).toBe('US-002');

  const payload = JSON.parse(retryEvents[0].payload);
  expect(payload.attempt).toBe(1);
  expect(payload.run_id).toBe(newRunId);

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

// ─── Test 12: Retry uses same spec_path and direction as original ─────────────

test('New retry run uses the same spec_path as the original run', async () => {
  createWorkspace();
  const originalRunId = createRunWithStories();

  const res = await request(app)
    .post(`/api/pipeline/runs/${originalRunId}/retry`)
    .set('Authorization', `Bearer ${authToken}`)
    .send({});

  const newRunId = res.body.runId;
  const originalRun = db.prepare('SELECT * FROM pipeline_runs WHERE id = ?').get(originalRunId) as any;
  const newRun = db.prepare('SELECT * FROM pipeline_runs WHERE id = ?').get(newRunId) as any;

  expect(newRun.spec_path).toBe(originalRun.spec_path);
  expect(newRun.workspace_id).toBe(originalRun.workspace_id);
  expect(newRun.retried_from_run_id).toBe(originalRunId);
  expect(newRun.trigger_type).toBe('retry');
});

// ─── Test 13: run_started WAL event emitted for new retry run ─────────────────

test('run_started WAL event is emitted for the new retry run', async () => {
  createWorkspace();
  const originalRunId = createRunWithStories();

  const res = await request(app)
    .post(`/api/pipeline/runs/${originalRunId}/retry`)
    .set('Authorization', `Bearer ${authToken}`)
    .send({});

  const newRunId = res.body.runId;

  const events = db.prepare(
    `SELECT * FROM wal_events WHERE event_type = 'run_started'`
  ).all() as any[];

  expect(events.length).toBeGreaterThanOrEqual(1);

  const retryRunEvent = events.find((e: any) => {
    const payload = JSON.parse(e.payload);
    return payload.run_id === newRunId;
  });
  expect(retryRunEvent).toBeDefined();

  const payload = JSON.parse(retryRunEvent.payload);
  expect(payload.retried_from_run_id).toBe(originalRunId);
  expect(payload.retried_stories).toEqual(expect.arrayContaining(['US-002', 'US-003']));
});
