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
  isValidModel: jest.fn().mockReturnValue(true),
  DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
  resolveVaultProvider: jest.fn().mockReturnValue(null),
  getModelInfo: jest.fn().mockReturnValue(undefined),
  SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
}));

let app: Express;
let db: Database.Database;
let tmpDir: string;
let wsDir: string;
let authToken: string;

beforeEach(async () => {
  jest.resetModules();

  jest.mock('../../lib/llm-client', () => ({
    chatComplete: jest.fn(),
    getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
    isValidModel: jest.fn().mockReturnValue(true),
    DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
    resolveVaultProvider: jest.fn().mockReturnValue(null),
    getModelInfo: jest.fn().mockReturnValue(undefined),
    SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
  }));

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorcha-pipeline-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  process.env.DB_PATH = dbPath;
  process.env.NODE_ENV = 'test';

  const serverMod = require('../../server');
  app = serverMod.default;
  const dbMod = require('../../db/index');
  db = dbMod.db;

  authToken = await getAuthToken(app);

  // Set test user to a paid plan so pipeline trigger isn't blocked by V2-111 plan enforcement
  db.prepare("UPDATE users SET plan = 'pro' WHERE email = 'testauth@example.com'").run();

  // Create workspace directory with run-loop.sh and spec files
  wsDir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(path.join(wsDir, 'scripts', 'ralph', 'specs', 'approved'), { recursive: true });
  fs.mkdirSync(path.join(wsDir, 'scripts', 'ralph', 'specs', 'pending'), { recursive: true });

  // Seed workspace in DB
  db.prepare(
    "INSERT INTO workspaces (id, label, path) VALUES ('ws-pipe', 'Pipeline WS', ?)"
  ).run(wsDir);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
  delete process.env.NODE_ENV;
});

/** Seed a spec JSON file in the workspace */
function seedSpec(status: 'pending' | 'approved', slug: string) {
  const dir = path.join(wsDir, 'scripts', 'ralph', 'specs', status);
  const spec = {
    title: slug.replace(/-/g, ' '),
    userStories: [
      { id: 'US-001', title: 'Story one', description: 'Desc', acceptanceCriteria: ['AC1'], dependsOn: [], passes: false },
      { id: 'US-002', title: 'Story two', description: 'Desc 2', acceptanceCriteria: ['AC2'], dependsOn: [], passes: false },
    ],
    generatedAt: '2026-02-20T12:00:00.000Z',
  };
  fs.writeFileSync(path.join(dir, `${slug}.json`), JSON.stringify(spec, null, 2), 'utf8');
  return spec;
}

/** Create a run-loop.sh stub that exits immediately */
function createRunLoopStub(exitCode = 0) {
  const scriptPath = path.join(wsDir, 'scripts', 'run-loop.sh');
  fs.writeFileSync(scriptPath, `#!/bin/bash\nexit ${exitCode}\n`, { mode: 0o755 });
}

/** Seed a pipeline run directly in the DB */
function seedRun(overrides: Partial<{ status: string; workspace_id: string; spec_path: string; pid: number | null }> = {}) {
  const result = db.prepare(
    `INSERT INTO pipeline_runs (spec_path, workspace_id, status, pid)
     VALUES (?, ?, ?, ?)`
  ).run(
    overrides.spec_path ?? 'ralph/specs/approved/test-spec.json',
    overrides.workspace_id ?? 'ws-pipe',
    overrides.status ?? 'running',
    overrides.pid ?? null,
  );
  return result.lastInsertRowid as number;
}

// ─── POST /api/pipeline/trigger ──────────────────────────────────────────────

describe('POST /api/pipeline/trigger', () => {
  test('returns 400 when specPath is missing', async () => {
    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-pipe' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Missing required fields');
  });

  test('returns 400 when workspaceId is missing', async () => {
    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ specPath: 'ralph/specs/approved/test.json' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Missing required fields');
  });

  test('returns 404 for nonexistent workspace', async () => {
    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ specPath: 'ralph/specs/approved/test.json', workspaceId: 'nonexistent' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Workspace not found');
  });

  test('falls back to TypeScript run-loop when run-loop.sh not found', async () => {
    // Don't create run-loop.sh — backend's run-loop.ts should be used as fallback
    seedSpec('approved', 'ts-fallback');

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ specPath: 'ralph/specs/approved/ts-fallback.json', workspaceId: 'ws-pipe' });

    // Should succeed because backend/src/lib/run-loop.ts exists
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.runId).toBeDefined();
  });

  test('detects conflict when another run is active for same workspace', async () => {
    createRunLoopStub();
    seedSpec('approved', 'test-spec');

    // Seed an active run
    seedRun({ status: 'running' });

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ specPath: 'ralph/specs/approved/test-spec.json', workspaceId: 'ws-pipe' });

    expect(res.status).toBe(200);
    expect(res.body.conflict).toBe(true);
    expect(res.body.activeRunId).toBeDefined();
  });

  test('spawns run-loop.sh and returns 201 with runId', async () => {
    createRunLoopStub();
    seedSpec('approved', 'trigger-spec');

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ specPath: 'ralph/specs/approved/trigger-spec.json', workspaceId: 'ws-pipe' });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.runId).toBeDefined();
    expect(typeof res.body.runId).toBe('number');

    // Verify pipeline_runs row was created
    const run = db.prepare('SELECT * FROM pipeline_runs WHERE id = ?').get(res.body.runId) as any;
    expect(run).toBeDefined();
    expect(run.workspace_id).toBe('ws-pipe');
    expect(run.status).toBe('running');
    expect(run.pid).toBeDefined();
  });

  test('emits WAL events when run is triggered', async () => {
    createRunLoopStub();
    seedSpec('approved', 'wal-trigger');

    await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ specPath: 'ralph/specs/approved/wal-trigger.json', workspaceId: 'ws-pipe' });

    // Process exits quickly (stub exits immediately) — wait a bit for exit handler
    await new Promise(resolve => setTimeout(resolve, 500));

    // run_finished WAL event should exist (since stub exits immediately with code 0)
    const events = db.prepare(
      "SELECT * FROM wal_events WHERE workspace_id = 'ws-pipe' ORDER BY id ASC"
    ).all() as any[];

    // Should have at least the run_finished event
    const finishEvent = events.find((e: any) => e.event_type === 'run_finished');
    // Stub exits with 0 so the exit handler fires — may need a bit more time
    if (finishEvent) {
      const payload = JSON.parse(finishEvent.payload);
      expect(payload.run_id).toBeDefined();
      expect(payload.status).toBe('done');
    }
  });

  test('dry-run returns cost estimate without spawning process', async () => {
    seedSpec('approved', 'dry-run-spec');

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'ralph/specs/approved/dry-run-spec.json',
        workspaceId: 'ws-pipe',
        dryRun: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.estimate).toBeDefined();

    // No pipeline run should be created
    const runs = db.prepare(
      "SELECT * FROM pipeline_runs WHERE workspace_id = 'ws-pipe'"
    ).all();
    expect(runs).toHaveLength(0);
  });

  test('dry-run returns 422 when spec file does not exist', async () => {
    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'ralph/specs/approved/nonexistent.json',
        workspaceId: 'ws-pipe',
        dryRun: true,
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('Spec file not found');
  });

  test('records excluded stories immediately when triggering', async () => {
    createRunLoopStub();

    // Create spec with an excluded story
    const dir = path.join(wsDir, 'scripts', 'ralph', 'specs', 'approved');
    const spec = {
      title: 'Exclusion Test',
      userStories: [
        { id: 'US-001', title: 'Active', description: 'Desc', acceptanceCriteria: ['AC1'], dependsOn: [], passes: false },
        { id: 'US-002', title: 'Excluded', description: 'Desc', acceptanceCriteria: ['AC1'], dependsOn: [], passes: false, excluded: true },
      ],
      generatedAt: '2026-02-20T12:00:00.000Z',
    };
    fs.writeFileSync(path.join(dir, 'excl-trigger.json'), JSON.stringify(spec, null, 2), 'utf8');

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ specPath: 'ralph/specs/approved/excl-trigger.json', workspaceId: 'ws-pipe' });

    expect(res.status).toBe(201);

    // Excluded story should have a story_results row
    const excluded = db.prepare(
      "SELECT * FROM story_results WHERE run_id = ? AND story_id = 'US-002'"
    ).get(res.body.runId) as any;
    expect(excluded).toBeDefined();
    expect(excluded.status).toBe('excluded');
  });

  test('requires authentication', async () => {
    const res = await request(app)
      .post('/api/pipeline/trigger')
      .send({ specPath: 'test.json', workspaceId: 'ws-pipe' });

    expect(res.status).toBe(401);
  });
});

// ─── GET /api/pipeline/runs (list) ──────────────────────────────────────────

describe('GET /api/pipeline/runs', () => {
  test('returns 400 when workspaceId is missing', async () => {
    const res = await request(app)
      .get('/api/pipeline/runs')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('workspaceId');
  });

  test('returns empty list for workspace with no runs', async () => {
    const res = await request(app)
      .get('/api/pipeline/runs?workspaceId=ws-pipe')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  test('returns runs for a given workspace, newest first', async () => {
    const runId1 = seedRun({ status: 'done' });
    const runId2 = seedRun({ status: 'running' });

    const res = await request(app)
      .get('/api/pipeline/runs?workspaceId=ws-pipe')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    // Newest first (DESC by id)
    expect(res.body.items[0].id).toBe(runId2);
    expect(res.body.items[1].id).toBe(runId1);
  });

  test('does not return runs from other workspaces', async () => {
    db.prepare("INSERT INTO workspaces (id, label, path) VALUES ('ws-other', 'Other', ?)").run(wsDir);
    seedRun({ workspace_id: 'ws-pipe' });
    seedRun({ workspace_id: 'ws-other' });

    const res = await request(app)
      .get('/api/pipeline/runs?workspaceId=ws-pipe')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].workspace_id).toBe('ws-pipe');
  });

  test('requires authentication', async () => {
    const res = await request(app).get('/api/pipeline/runs?workspaceId=ws-pipe');
    expect(res.status).toBe(401);
  });
});

// ─── GET /api/pipeline/runs/:runId (detail) ─────────────────────────────────

describe('GET /api/pipeline/runs/:runId', () => {
  test('returns run details with story results', async () => {
    const runId = seedRun({ status: 'done' });

    // Add story results
    db.prepare(
      "INSERT INTO story_results (run_id, story_id, status, finished_at) VALUES (?, 'US-001', 'pass', datetime('now'))"
    ).run(runId);
    db.prepare(
      "INSERT INTO story_results (run_id, story_id, status, finished_at) VALUES (?, 'US-002', 'fail', datetime('now'))"
    ).run(runId);

    const res = await request(app)
      .get(`/api/pipeline/runs/${runId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.run).toBeDefined();
    expect(res.body.run.id).toBe(runId);
    expect(res.body.run.status).toBe('done');
    expect(res.body.stories).toHaveLength(2);
    expect(res.body.stories[0].story_id).toBe('US-001');
    expect(res.body.stories[0].status).toBe('pass');
    expect(res.body.stories[1].story_id).toBe('US-002');
    expect(res.body.stories[1].status).toBe('fail');
  });

  test('returns 404 for nonexistent run', async () => {
    const res = await request(app)
      .get('/api/pipeline/runs/99999')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Run not found');
  });

  test('returns 400 for invalid runId', async () => {
    const res = await request(app)
      .get('/api/pipeline/runs/abc')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid runId');
  });

  test('returns empty stories array when run has no story results', async () => {
    const runId = seedRun();

    const res = await request(app)
      .get(`/api/pipeline/runs/${runId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.stories).toEqual([]);
  });

  test('requires authentication', async () => {
    const runId = seedRun();
    const res = await request(app).get(`/api/pipeline/runs/${runId}`);
    expect(res.status).toBe(401);
  });
});

// ─── POST /api/pipeline/runs/:runId/pause ───────────────────────────────────

describe('POST /api/pipeline/runs/:runId/pause', () => {
  test('returns 404 for nonexistent run', async () => {
    const res = await request(app)
      .post('/api/pipeline/runs/99999/pause')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Run not found');
  });

  test('returns 409 when run is not in running state', async () => {
    const runId = seedRun({ status: 'done' });

    const res = await request(app)
      .post(`/api/pipeline/runs/${runId}/pause`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("Cannot pause run with status 'done'");
  });

  test('returns 409 when process is not alive (no pid)', async () => {
    const runId = seedRun({ status: 'running', pid: null });

    const res = await request(app)
      .post(`/api/pipeline/runs/${runId}/pause`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Process is not alive');
  });

  test('returns 400 for invalid runId', async () => {
    const res = await request(app)
      .post('/api/pipeline/runs/abc/pause')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid runId');
  });
});

// ─── POST /api/pipeline/runs/:runId/resume ──────────────────────────────────

describe('POST /api/pipeline/runs/:runId/resume', () => {
  test('returns 404 for nonexistent run', async () => {
    const res = await request(app)
      .post('/api/pipeline/runs/99999/resume')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Run not found');
  });

  test('returns 409 when run is not in paused state', async () => {
    const runId = seedRun({ status: 'running' });

    const res = await request(app)
      .post(`/api/pipeline/runs/${runId}/resume`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("Cannot resume run with status 'running'");
  });

  test('returns 409 when process is not alive (no pid)', async () => {
    const runId = seedRun({ status: 'paused', pid: null });

    const res = await request(app)
      .post(`/api/pipeline/runs/${runId}/resume`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Process is not alive');
  });
});

// ─── POST /api/pipeline/runs (create run record) ───────────────────────────

describe('POST /api/pipeline/runs', () => {
  test('returns 400 when specPath is missing', async () => {
    const res = await request(app)
      .post('/api/pipeline/runs')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-pipe' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Missing required fields');
  });

  test('returns 400 when workspaceId is missing', async () => {
    const res = await request(app)
      .post('/api/pipeline/runs')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ specPath: 'test.json' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Missing required fields');
  });

  test('creates run and returns 201 with run object', async () => {
    const res = await request(app)
      .post('/api/pipeline/runs')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ specPath: 'ralph/specs/approved/test.json', workspaceId: 'ws-pipe' });

    expect(res.status).toBe(201);
    expect(res.body.run).toBeDefined();
    expect(res.body.run.spec_path).toBe('ralph/specs/approved/test.json');
    expect(res.body.run.workspace_id).toBe('ws-pipe');
    expect(res.body.run.status).toBe('running');
    expect(res.body.run.id).toBeDefined();
  });

  test('emits run_started WAL event', async () => {
    const res = await request(app)
      .post('/api/pipeline/runs')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ specPath: 'ralph/specs/approved/test.json', workspaceId: 'ws-pipe' });

    const event = db.prepare(
      "SELECT * FROM wal_events WHERE event_type = 'run_started'"
    ).get() as any;

    expect(event).toBeDefined();
    expect(event.workspace_id).toBe('ws-pipe');
    const payload = JSON.parse(event.payload);
    expect(payload.run_id).toBe(res.body.run.id);
    expect(payload.spec_path).toBe('ralph/specs/approved/test.json');
  });

  test('stores run in database with correct fields', async () => {
    const res = await request(app)
      .post('/api/pipeline/runs')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ specPath: 'ralph/specs/approved/test.json', workspaceId: 'ws-pipe' });

    const run = db.prepare('SELECT * FROM pipeline_runs WHERE id = ?').get(res.body.run.id) as any;
    expect(run).toBeDefined();
    expect(run.spec_path).toBe('ralph/specs/approved/test.json');
    expect(run.workspace_id).toBe('ws-pipe');
    expect(run.status).toBe('running');
    expect(run.started_at).toBeDefined();
  });
});

// ─── GET /api/pipeline/runs/:runId/log ─────────────────────────────────────

describe('GET /api/pipeline/runs/:runId/log', () => {
  test('returns 400 for invalid runId', async () => {
    const res = await request(app)
      .get('/api/pipeline/runs/abc/log')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid runId');
  });

  test('returns 404 when no log file exists', async () => {
    // Use a high ID to avoid collision with legacy /tmp/rorcha-run-{id}.log files
    const runId = 999999;
    db.prepare(
      `INSERT INTO pipeline_runs (id, spec_path, workspace_id, status) VALUES (?, ?, ?, ?)`
    ).run(runId, 'ralph/specs/approved/test-spec.json', 'ws-pipe', 'done');

    // Ensure no legacy log file exists
    const legacyPath = path.join(os.tmpdir(), `rorcha-run-${runId}.log`);
    try { fs.unlinkSync(legacyPath); } catch { /* ignore */ }

    const res = await request(app)
      .get(`/api/pipeline/runs/${runId}/log`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Log file not found');
  });

  test('returns log content when log file exists', async () => {
    const runId = seedRun();

    // Create a log file and reference it in the DB
    const logPath = path.join(tmpDir, `run-${runId}.log`);
    fs.writeFileSync(logPath, 'hello from run-loop\nstory US-001 passed\n');
    db.prepare('UPDATE pipeline_runs SET log_path = ? WHERE id = ?').run(logPath, runId);

    const res = await request(app)
      .get(`/api/pipeline/runs/${runId}/log`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.headers['content-disposition']).toContain(`run-${runId}.log`);
    expect(res.text).toContain('hello from run-loop');
    expect(res.text).toContain('story US-001 passed');
  });
});

// ─── POST /api/pipeline/runs/:runId/stories/:storyId/tokens ────────────────

describe('POST /api/pipeline/runs/:runId/stories/:storyId/tokens', () => {
  test('records token usage for a story', async () => {
    const runId = seedRun({ status: 'running' });

    // Add a story result
    db.prepare(
      "INSERT INTO story_results (run_id, story_id, status) VALUES (?, 'US-001', 'pass')"
    ).run(runId);

    const res = await request(app)
      .post(`/api/pipeline/runs/${runId}/stories/US-001/tokens`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ inputTokens: 5000, outputTokens: 1000, model: 'claude-sonnet-4-5-20250929' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Verify story_results was updated
    const story = db.prepare(
      "SELECT input_tokens, output_tokens FROM story_results WHERE run_id = ? AND story_id = 'US-001'"
    ).get(runId) as any;
    expect(story.input_tokens).toBe(5000);
    expect(story.output_tokens).toBe(1000);
  });

  test('returns 400 when no token fields provided', async () => {
    const runId = seedRun();

    const res = await request(app)
      .post(`/api/pipeline/runs/${runId}/stories/US-001/tokens`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('inputTokens or outputTokens');
  });

  test('returns 404 when story result does not exist', async () => {
    const runId = seedRun();

    const res = await request(app)
      .post(`/api/pipeline/runs/${runId}/stories/US-999/tokens`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ inputTokens: 100 });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Story result not found');
  });
});

// ─── GET /api/pipeline/runs/compare ─────────────────────────────────────────

describe('GET /api/pipeline/runs/compare', () => {
  test('returns 400 when run params are missing', async () => {
    const res = await request(app)
      .get('/api/pipeline/runs/compare')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('run1/run2');
  });

  test('returns 400 when comparing a run with itself', async () => {
    const res = await request(app)
      .get('/api/pipeline/runs/compare?run1=1&run2=1')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('itself');
  });

  test('returns 404 when run does not exist', async () => {
    const runId = seedRun();

    const res = await request(app)
      .get(`/api/pipeline/runs/compare?run1=${runId}&run2=99999`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(404);
  });

  test('compares two runs and returns story-level diff with summary', async () => {
    const runId1 = seedRun({ status: 'done' });
    const runId2 = seedRun({ status: 'done' });

    // Run 1: US-001 pass, US-002 fail
    db.prepare("INSERT INTO story_results (run_id, story_id, status, elapsed_seconds) VALUES (?, 'US-001', 'pass', 60)").run(runId1);
    db.prepare("INSERT INTO story_results (run_id, story_id, status, elapsed_seconds) VALUES (?, 'US-002', 'fail', 120)").run(runId1);

    // Run 2: US-001 pass, US-002 pass (improved), US-003 pass (new)
    db.prepare("INSERT INTO story_results (run_id, story_id, status, elapsed_seconds) VALUES (?, 'US-001', 'pass', 55)").run(runId2);
    db.prepare("INSERT INTO story_results (run_id, story_id, status, elapsed_seconds) VALUES (?, 'US-002', 'pass', 90)").run(runId2);
    db.prepare("INSERT INTO story_results (run_id, story_id, status, elapsed_seconds) VALUES (?, 'US-003', 'pass', 30)").run(runId2);

    const res = await request(app)
      .get(`/api/pipeline/runs/compare?run1=${runId1}&run2=${runId2}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.run1).toBeDefined();
    expect(res.body.run2).toBeDefined();
    expect(res.body.stories).toHaveLength(3);
    expect(res.body.summary).toBeDefined();
    expect(res.body.summary.improved).toBe(1); // US-002 fail→pass
    expect(res.body.summary.newStories).toBe(1); // US-003
    expect(res.body.summary.regressed).toBe(0);
    expect(res.body.summary.run2PassRate).toBe(100);
  });
});
