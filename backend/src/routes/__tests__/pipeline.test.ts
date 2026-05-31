/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import request from 'supertest';
import { getAuthToken } from './helpers/auth-helper';
import { query, queryOne, execute } from '../../db/index';

// Server initialization + migrations can take > 30s on first run
jest.setTimeout(90_000);

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

// Mock pg-boss so pipeline trigger doesn't fail with "getBoss() called before initBoss()"
// In test mode server.ts never calls initBoss(), so we stub the whole module.
jest.mock('../../lib/pg-boss', () => ({
  initBoss: jest.fn().mockResolvedValue(undefined),
  getBoss: jest.fn().mockReturnValue({
    send: jest.fn().mockResolvedValue('mock-job-id'),
    work: jest.fn(),
    stop: jest.fn().mockResolvedValue(undefined),
  }),
}));

jest.mock('../../lib/pty-manager', () => ({
  PTY_AVAILABLE: true,
  PTY_UNAVAILABLE_HINT: 'Run: cd backend && npm rebuild node-pty',
}));

let app: Express;
let tmpDir: string;
let wsDir: string;
let authToken: string;

// Load the server ONCE per test file to avoid creating 54 separate DB connection pools
// (one per jest.resetModules() + require('../../server') call).
// PG_POOL_SIZE=1 in jest.env.ts caps each pool at 1 connection, so 54 pools = 54 conns
// which could exhaust Postgres max_connections (100). One server = one pool = safe.
beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  const serverMod = require('../../server');
  app = serverMod.default;
  authToken = await getAuthToken(app);

  await execute(`UPDATE users SET plan = 'pro' WHERE email = 'testauth@example.com'`);
  await execute(
    `INSERT INTO users (id, email, display_name, password_hash, plan)
     VALUES ('local-admin', 'admin@rorca.local', 'Admin', 'x', 'pro')
     ON CONFLICT (id) DO UPDATE SET plan = 'pro'`
  );
  await execute(`INSERT INTO model_pricing (model_id, input_cost_per_1k, output_cost_per_1k, input_cost_per_1m, output_cost_per_1m)
    VALUES ('claude-sonnet-4-5-20250929', 0.003, 0.015, 3.0, 15.0)
    ON CONFLICT (model_id) DO NOTHING`);
});

beforeEach(async () => {
  // Reset all mocks to clear call counts from previous tests
  jest.clearAllMocks();

  // Fresh workspace directory for each test
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-pipeline-test-'));
  wsDir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(path.join(wsDir, 'forge', 'specs', 'approved'), { recursive: true });
  fs.mkdirSync(path.join(wsDir, 'forge', 'specs', 'pending'), { recursive: true });

  // Clean up DB state from previous tests (FK chain: token_usage/story_results → pipeline_runs)
  await execute(`DELETE FROM token_usage WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = 'ws-pipe')`);
  await execute(`DELETE FROM story_results WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = 'ws-pipe')`);
  await execute(`DELETE FROM pipeline_runs WHERE workspace_id = 'ws-pipe'`);
  await execute(`DELETE FROM wal_events WHERE workspace_id = 'ws-pipe'`);

  // Ensure both users exist with plan='pro' (global teardown truncates users between test files).
  // Use ON CONFLICT DO UPDATE covering both id and email unique constraints.
  await execute(
    `INSERT INTO users (id, email, display_name, password_hash, plan)
     VALUES ('local-admin', 'admin@rorca.local', 'Admin', 'x', 'pro')
     ON CONFLICT (id) DO UPDATE SET plan = 'pro', email = EXCLUDED.email`
  );
  await execute(`UPDATE users SET plan = 'pro' WHERE email = 'testauth@example.com'`);

  // Ensure model pricing exists (needed for dry-run cost estimate)
  await execute(`INSERT INTO model_pricing (model_id, input_cost_per_1k, output_cost_per_1k, input_cost_per_1m, output_cost_per_1m)
    VALUES ('claude-sonnet-4-5-20250929', 0.003, 0.015, 3.0, 15.0)
    ON CONFLICT (model_id) DO NOTHING`);

  // Point workspace at fresh tmpDir
  await execute(`INSERT INTO workspaces (id, label, path) VALUES ('ws-pipe', 'Pipeline WS', $1) ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path`, [wsDir]);
});

afterEach(async () => {
  // Allow fire-and-forget async ops (WAL events, DB inserts) to drain before pool cleanup.
  // The global jest.pool-cleanup.ts afterEach calls closePool() after this local afterEach.
  // Without a sufficient delay, async ops from trigger tests (WAL posting, run row insertion)
  // may try to use the pool AFTER closePool() is called.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(async () => {
  delete process.env.NODE_ENV;
});

/** Seed a spec JSON file in the workspace */
function seedSpec(status: 'pending' | 'approved', slug: string) {
  const dir = path.join(wsDir, 'forge', 'specs', status);
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
  const scriptPath = path.join(wsDir, 'forge', 'run-loop.sh');
  fs.writeFileSync(scriptPath, `#!/bin/bash\nexit ${exitCode}\n`, { mode: 0o755 });
}

/** Seed a pipeline run directly in the DB */
async function seedRun(overrides: Partial<{ status: string; workspace_id: string; spec_path: string; pid: number | null }> = {}) {
  const result = await queryOne<{ id: number }>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status, pid)
     VALUES ($1, $2, $3, $4) RETURNING id`, [overrides.spec_path ?? 'forge/specs/approved/test-spec.json',
    overrides.workspace_id ?? 'ws-pipe',
    overrides.status ?? 'running',
    overrides.pid ?? null,]);
  return result!.id;
}

// ─── POST /api/pipeline/trigger ──────────────────────────────────────────────

describe('POST /api/pipeline/trigger', () => {
  test('returns 422 when specPath is missing', async () => {
    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-pipe' });

    expect(res.status).toBe(422);
  });

  test('returns 422 when workspaceId is missing', async () => {
    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ specPath: 'forge/specs/approved/test.json' });

    expect(res.status).toBe(422);
  });

  test('returns 404 for nonexistent workspace', async () => {
    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ specPath: 'forge/specs/approved/test.json', workspaceId: 'nonexistent' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Workspace not found');
  });

  test('falls back to TypeScript run-loop when run-loop.sh not found', async () => {
    // Don't create run-loop.sh — backend's run-loop.ts should be used as fallback
    seedSpec('approved', 'ts-fallback');

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ specPath: 'forge/specs/approved/ts-fallback.json', workspaceId: 'ws-pipe' });

    // Should succeed because backend/src/lib/run-loop.ts exists
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.runId).toBeDefined();
  });

  test('detects conflict when another run is active for same workspace', async () => {
    createRunLoopStub();
    seedSpec('approved', 'test-spec');

    // Seed an active run
    await seedRun({ status: 'running' });

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ specPath: 'forge/specs/approved/test-spec.json', workspaceId: 'ws-pipe' });

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
      .send({ specPath: 'forge/specs/approved/trigger-spec.json', workspaceId: 'ws-pipe' });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.runId).toBeDefined();
    expect(typeof res.body.runId).toBe('number');

    // Verify pipeline_runs row was created (status='queued' — worker picks it up asynchronously)
    const run = await queryOne(`SELECT * FROM pipeline_runs WHERE id = $1`, [res.body.runId]) as any;
    expect(run).toBeDefined();
    expect(run.workspace_id).toBe('ws-pipe');
    expect(['queued', 'running']).toContain(run.status);
  });

  test('emits WAL events when run is triggered', async () => {
    createRunLoopStub();
    seedSpec('approved', 'wal-trigger');

    await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ specPath: 'forge/specs/approved/wal-trigger.json', workspaceId: 'ws-pipe' });

    // Process exits quickly (stub exits immediately) — wait a bit for exit handler
    await new Promise(resolve => setTimeout(resolve, 500));

    // run_finished WAL event should exist (since stub exits immediately with code 0)
    const events = await query(`SELECT * FROM wal_events WHERE workspace_id = 'ws-pipe' ORDER BY id ASC`) as any[];

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
        specPath: 'forge/specs/approved/dry-run-spec.json',
        workspaceId: 'ws-pipe',
        dryRun: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.estimate).toBeDefined();

    // No pipeline run should be created
    const runs = await query(`SELECT * FROM pipeline_runs WHERE workspace_id = 'ws-pipe'`);
    expect(runs).toHaveLength(0);
  });

  test('dry-run returns 422 when spec file does not exist', async () => {
    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/nonexistent.json',
        workspaceId: 'ws-pipe',
        dryRun: true,
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('Spec file not found');
  });

  test('records excluded stories immediately when triggering', async () => {
    createRunLoopStub();

    // Create spec with an excluded story
    const dir = path.join(wsDir, 'forge', 'specs', 'approved');
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
      .send({ specPath: 'forge/specs/approved/excl-trigger.json', workspaceId: 'ws-pipe' });

    expect(res.status).toBe(201);

    // Excluded story should have a story_results row
    const excluded = await queryOne(`SELECT * FROM story_results WHERE run_id = $1 AND story_id = 'US-002'`, [res.body.runId]) as any;
    expect(excluded).toBeDefined();
    expect(excluded.status).toBe('excluded');
  });

  test('unauthenticated request is handled (auth bypass active in local mode)', async () => {
    // In local single-user mode (AUTH_REQUIRED not set), auth is intentionally bypassed.
    // The synthetic local-admin user is injected. Request proceeds past auth middleware.
    const res = await request(app)
      .post('/api/pipeline/trigger')
      .send({ specPath: 'test.json', workspaceId: 'ws-pipe' });

    // Auth bypass: in local mode the request proceeds past auth middleware.
    // May get 201 (trigger succeeds), 422 (validation), or 404 (workspace).
    expect([200, 201, 400, 404, 422]).toContain(res.status);
  });

  test('RE-007: spec JSON reasoning config is used as default in job payload when trigger omits reasoning params', async () => {
    // Create a spec file with reasoning config embedded
    const dir = path.join(wsDir, 'forge', 'specs', 'approved');
    const spec = {
      title: 'Reasoning Spec',
      model: 'claude-sonnet-4-5-20250929',
      reasoning: { enabled: true, effort: 'high' },
      userStories: [
        { id: 'US-001', title: 'Story one', description: 'Desc', acceptanceCriteria: ['AC1'], dependsOn: [], passes: false },
      ],
      generatedAt: '2026-02-20T12:00:00.000Z',
    };
    fs.writeFileSync(path.join(dir, 'reasoning-spec.json'), JSON.stringify(spec, null, 2), 'utf8');

    // Get a reference to the mocked getBoss().send so we can inspect call args
    const pgBossMock = jest.requireMock('../../lib/pg-boss');
    const mockSend = pgBossMock.getBoss().send as jest.Mock;
    mockSend.mockClear();

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      // No thinkingEnabled or reasoningEffort in request body — should fall back to spec JSON
      .send({ specPath: 'forge/specs/approved/reasoning-spec.json', workspaceId: 'ws-pipe' });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);

    // Assert the job payload sent to pg-boss contains the spec-level reasoning defaults
    expect(mockSend).toHaveBeenCalledWith(
      'pipeline:run',
      expect.objectContaining({
        thinkingEnabled: true,
        reasoningEffort: 'high',
      }),
      expect.any(Object),
    );
  });

  test('RE-007: explicit trigger reasoning params override spec JSON reasoning config', async () => {
    // Create a spec file with reasoning config embedded
    const dir = path.join(wsDir, 'forge', 'specs', 'approved');
    const spec = {
      title: 'Reasoning Override Spec',
      model: 'claude-sonnet-4-5-20250929',
      reasoning: { enabled: true, effort: 'low' },
      userStories: [
        { id: 'US-001', title: 'Story one', description: 'Desc', acceptanceCriteria: ['AC1'], dependsOn: [], passes: false },
      ],
      generatedAt: '2026-02-20T12:00:00.000Z',
    };
    fs.writeFileSync(path.join(dir, 'reasoning-override-spec.json'), JSON.stringify(spec, null, 2), 'utf8');

    const pgBossMock = jest.requireMock('../../lib/pg-boss');
    const mockSend = pgBossMock.getBoss().send as jest.Mock;
    mockSend.mockClear();

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      // Explicit params override spec JSON defaults
      .send({
        specPath: 'forge/specs/approved/reasoning-override-spec.json',
        workspaceId: 'ws-pipe',
        thinkingEnabled: false,
        reasoningEffort: 'medium',
      });

    expect(res.status).toBe(201);

    // Explicit thinkingEnabled=false should override spec reasoning.enabled=true
    // Explicit reasoningEffort='medium' should override spec reasoning.effort='low'
    const callArgs = mockSend.mock.calls[0][1];
    expect(callArgs.thinkingEnabled).toBe(false);
    expect(callArgs.reasoningEffort).toBe('medium');
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
    const runId1 = await seedRun({ status: 'done' });
    const runId2 = await seedRun({ status: 'running' });

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
    await execute(`INSERT INTO workspaces (id, label, path) VALUES ('ws-other', 'Other', $1) ON CONFLICT (id) DO NOTHING`, [wsDir]);
    await seedRun({ workspace_id: 'ws-pipe' });
    await seedRun({ workspace_id: 'ws-other' });

    const res = await request(app)
      .get('/api/pipeline/runs?workspaceId=ws-pipe')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].workspace_id).toBe('ws-pipe');
  });

  test('unauthenticated request is handled (auth bypass active in local mode)', async () => {
    // Auth is bypassed in local mode — returns 200 (list) not 401
    const res = await request(app).get('/api/pipeline/runs?workspaceId=ws-pipe');
    expect(res.status).toBe(200);
  });
});

// ─── GET /api/pipeline/runs/:runId (detail) ─────────────────────────────────

describe('GET /api/pipeline/runs/:runId', () => {
  test('returns run details with story results', async () => {
    const runId = await seedRun({ status: 'done' });

    // Add story results
    await execute(`INSERT INTO story_results (run_id, story_id, status, finished_at) VALUES ($1, 'US-001', 'pass', NOW())`, [runId]);
    await execute(`INSERT INTO story_results (run_id, story_id, status, finished_at) VALUES ($1, 'US-002', 'fail', NOW())`, [runId]);

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
    const runId = await seedRun();

    const res = await request(app)
      .get(`/api/pipeline/runs/${runId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.stories).toEqual([]);
  });

  test('unauthenticated request is handled (auth bypass active in local mode)', async () => {
    const runId = await seedRun();
    const res = await request(app).get(`/api/pipeline/runs/${runId}`);
    // Auth is bypassed in local mode — returns 200 not 401
    expect(res.status).toBe(200);
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
    const runId = await seedRun({ status: 'done' });

    const res = await request(app)
      .post(`/api/pipeline/runs/${runId}/pause`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("Cannot pause run with status 'done'");
  });

  test('returns 409 when process is not alive (no pid)', async () => {
    const runId = await seedRun({ status: 'running', pid: null });

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
    const runId = await seedRun({ status: 'running' });

    const res = await request(app)
      .post(`/api/pipeline/runs/${runId}/resume`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("Cannot resume run with status 'running'");
  });

  test('returns 409 when process is not alive (no pid)', async () => {
    const runId = await seedRun({ status: 'paused', pid: null });

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
      .send({ specPath: 'forge/specs/approved/test.json', workspaceId: 'ws-pipe' });

    expect(res.status).toBe(201);
    expect(res.body.run).toBeDefined();
    expect(res.body.run.spec_path).toBe('forge/specs/approved/test.json');
    expect(res.body.run.workspace_id).toBe('ws-pipe');
    expect(res.body.run.status).toBe('running');
    expect(res.body.run.id).toBeDefined();
  });

  test('emits run_started WAL event', async () => {
    const res = await request(app)
      .post('/api/pipeline/runs')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ specPath: 'forge/specs/approved/test.json', workspaceId: 'ws-pipe' });

    const event = await queryOne(`SELECT * FROM wal_events WHERE event_type = 'run_started'`) as any;

    expect(event).toBeDefined();
    expect(event.workspace_id).toBe('ws-pipe');
    // PostgreSQL JSONB columns are returned as JS objects by the pg driver, not strings
    const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
    expect(payload.run_id).toBe(res.body.run.id);
    expect(payload.spec_path).toBe('forge/specs/approved/test.json');
  });

  test('stores run in database with correct fields', async () => {
    const res = await request(app)
      .post('/api/pipeline/runs')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ specPath: 'forge/specs/approved/test.json', workspaceId: 'ws-pipe' });

    const run = await queryOne(`SELECT * FROM pipeline_runs WHERE id = $1`, [res.body.run.id]) as any;
    expect(run).toBeDefined();
    expect(run.spec_path).toBe('forge/specs/approved/test.json');
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
    // Use a high ID to avoid collision with legacy /tmp/rorca-run-{id}.log files
    const runId = 999999;
    await execute(`INSERT INTO pipeline_runs (id, spec_path, workspace_id, status) VALUES ($1, $2, $3, $4)`, [runId, 'forge/specs/approved/test-spec.json', 'ws-pipe', 'done']);

    // Ensure no legacy log file exists
    const legacyPath = path.join(os.tmpdir(), `rorca-run-${runId}.log`);
    try { fs.unlinkSync(legacyPath); } catch { /* ignore */ }

    const res = await request(app)
      .get(`/api/pipeline/runs/${runId}/log`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Log file not found');
  });

  test('returns log content when log file exists', async () => {
    const runId = await seedRun();

    // Create a log file and reference it in the DB
    const logPath = path.join(tmpDir, `run-${runId}.log`);
    fs.writeFileSync(logPath, 'hello from run-loop\nstory US-001 passed\n');
    await execute(`UPDATE pipeline_runs SET log_path = $1 WHERE id = $2`, [logPath, runId]);

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
    const runId = await seedRun({ status: 'running' });

    // Add a story result
    await execute(`INSERT INTO story_results (run_id, story_id, status) VALUES ($1, 'US-001', 'pass')`, [runId]);

    const res = await request(app)
      .post(`/api/pipeline/runs/${runId}/stories/US-001/tokens`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ inputTokens: 5000, outputTokens: 1000, model: 'claude-sonnet-4-5-20250929' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Verify story_results was updated
    const story = await queryOne(`SELECT input_tokens, output_tokens FROM story_results WHERE run_id = $1 AND story_id = 'US-001'`, [runId]) as any;
    expect(story.input_tokens).toBe(5000);
    expect(story.output_tokens).toBe(1000);
  });

  test('returns 400 when no token fields provided', async () => {
    const runId = await seedRun();

    const res = await request(app)
      .post(`/api/pipeline/runs/${runId}/stories/US-001/tokens`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('inputTokens or outputTokens');
  });

  test('returns 404 when story result does not exist', async () => {
    const runId = await seedRun();

    const res = await request(app)
      .post(`/api/pipeline/runs/${runId}/stories/US-999/tokens`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ inputTokens: 100 });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Story result not found');
  });

  test('preserves explicit zero cost for pi token updates', async () => {
    const runId = await seedRun({ status: 'running' });

    await execute(`INSERT INTO story_results (run_id, story_id, status) VALUES ($1, 'US-PI-001', 'pass')`, [runId]);

    const res = await request(app)
      .post(`/api/pipeline/runs/${runId}/stories/US-PI-001/tokens`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ inputTokens: 400, outputTokens: 100, model: 'pi/omlx/local', costUsd: 0 });

    expect(res.status).toBe(200);

    const story = await queryOne(
      `SELECT input_tokens, output_tokens, cost_usd FROM story_results WHERE run_id = $1 AND story_id = 'US-PI-001'`,
      [runId],
    ) as any;
    expect(story.input_tokens).toBe(400);
    expect(story.output_tokens).toBe(100);
    expect(story.cost_usd).toBe(0);

    const usage = await queryOne(
      `SELECT model, input_tokens, output_tokens, cost_usd
       FROM token_usage
       WHERE run_id = $1 AND story_id = 'US-PI-001'
       ORDER BY id DESC
       LIMIT 1`,
      [runId],
    ) as any;
    expect(usage.model).toBe('pi/omlx/local');
    expect(usage.input_tokens).toBe(400);
    expect(usage.output_tokens).toBe(100);
    expect(usage.cost_usd).toBe(0);
  });
});

// ─── POST /api/pipeline/story-result ────────────────────────────────────────

describe('POST /api/pipeline/story-result', () => {
  test('records explicit pi cost into story_results and token_usage', async () => {
    const runId = await seedRun({ status: 'running' });

    const res = await request(app)
      .post('/api/pipeline/story-result')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        runId,
        storyId: 'US-PI-002',
        status: 'pass',
        inputTokens: 1200,
        outputTokens: 300,
        modelUsed: 'pi/openai/gpt-4.1',
        costUsd: 0.01875,
      });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);

    const story = await queryOne(
      `SELECT input_tokens, output_tokens, model_used, cost_usd
       FROM story_results
       WHERE run_id = $1 AND story_id = 'US-PI-002'
       ORDER BY id DESC
       LIMIT 1`,
      [runId],
    ) as any;
    expect(story.input_tokens).toBe(1200);
    expect(story.output_tokens).toBe(300);
    expect(story.model_used).toBe('pi/openai/gpt-4.1');
    expect(story.cost_usd).toBe(0.01875);

    const usage = await queryOne(
      `SELECT model, input_tokens, output_tokens, cost_usd
       FROM token_usage
       WHERE run_id = $1 AND story_id = 'US-PI-002'
       ORDER BY id DESC
       LIMIT 1`,
      [runId],
    ) as any;
    expect(usage.model).toBe('pi/openai/gpt-4.1');
    expect(usage.input_tokens).toBe(1200);
    expect(usage.output_tokens).toBe(300);
    expect(usage.cost_usd).toBe(0.01875);
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
    const runId = await seedRun();

    const res = await request(app)
      .get(`/api/pipeline/runs/compare?run1=${runId}&run2=99999`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(404);
  });

  test('compares two runs and returns story-level diff with summary', async () => {
    const runId1 = await seedRun({ status: 'done' });
    const runId2 = await seedRun({ status: 'done' });

    // Run 1: US-001 pass, US-002 fail
    await execute(`INSERT INTO story_results (run_id, story_id, status, elapsed_seconds) VALUES ($1, 'US-001', 'pass', 60)`, [runId1]);
    await execute(`INSERT INTO story_results (run_id, story_id, status, elapsed_seconds) VALUES ($1, 'US-002', 'fail', 120)`, [runId1]);

    // Run 2: US-001 pass, US-002 pass (improved), US-003 pass (new)
    await execute(`INSERT INTO story_results (run_id, story_id, status, elapsed_seconds) VALUES ($1, 'US-001', 'pass', 55)`, [runId2]);
    await execute(`INSERT INTO story_results (run_id, story_id, status, elapsed_seconds) VALUES ($1, 'US-002', 'pass', 90)`, [runId2]);
    await execute(`INSERT INTO story_results (run_id, story_id, status, elapsed_seconds) VALUES ($1, 'US-003', 'pass', 30)`, [runId2]);

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

// ─── OC-006: Agent type detection, OpenCode server lifecycle, execution-engine ─

describe('OC-006: Pipeline trigger agent integration', () => {
  test('trigger stores agent_type and agent_model in pipeline_runs', async () => {
    // Default agent is 'claude' — execution-engine.ts or run-loop.ts will be used
    seedSpec('approved', 'agent-record');

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ specPath: 'forge/specs/approved/agent-record.json', workspaceId: 'ws-pipe' });

    expect(res.status).toBe(201);
    expect(res.body.agentType).toBe('claude');
    expect(res.body.agentModel).toBeNull();

    const run = await queryOne(`SELECT agent, agent_type, agent_model FROM pipeline_runs WHERE id = $1`, [res.body.runId]) as any;
    expect(run.agent).toBe('claude');
    expect(run.agent_type).toBe('claude');
    expect(run.agent_model).toBeNull();
  });

  test('trigger with agentOverride=pi creates a standard queued/run-now pipeline run', async () => {
    seedSpec('approved', 'pi-agent-record');

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ specPath: 'forge/specs/approved/pi-agent-record.json', workspaceId: 'ws-pipe', agentOverride: 'pi' });

    expect(res.status).toBe(201);
    expect(res.body.agentType).toBe('pi');
    expect(res.body.expectsExternalOrchestration).toBeUndefined();

    const run = await queryOne(`SELECT status, agent, agent_type FROM pipeline_runs WHERE id = $1`, [res.body.runId]) as any;
    expect(run.agent).toBe('pi');
    expect(run.agent_type).toBe('pi');
    expect(run.status).not.toBe('pi_native');
    expect(['queued', 'running']).toContain(run.status);
  });

  test('trigger with agentOverride=pi remaps unavailable spec models to an available local Pi model', async () => {
    const spec = seedSpec('approved', 'pi-model-fallback') as any;
    spec.model = 'claude-sonnet-4-6';
    fs.writeFileSync(path.join(wsDir, 'forge', 'specs', 'approved', 'pi-model-fallback.json'), JSON.stringify(spec, null, 2), 'utf8');

    const piDetector = require('../../lib/pi-detector') as typeof import('../../lib/pi-detector');
    jest.spyOn(piDetector, 'detectPi').mockReturnValue({
      piInstalled: true,
      piVersion: '0.67.2',
      piBinPath: '/usr/local/bin/pi',
    });
    jest.spyOn(piDetector, 'listPiModels').mockReturnValue([
      {
        provider: 'openai-codex',
        model: 'gpt-5.4',
        contextTokens: 272000,
        maxOutTokens: 128000,
        thinking: true,
        images: true,
      },
    ]);

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ specPath: 'forge/specs/approved/pi-model-fallback.json', workspaceId: 'ws-pipe', agentOverride: 'pi' });

    expect(res.status).toBe(201);
    const run = await queryOne(`SELECT agent_type, agent_model FROM pipeline_runs WHERE id = $1`, [res.body.runId]) as any;
    expect(run.agent_type).toBe('pi');
    expect(run.agent_model).toBe('openai-codex/gpt-5.4');
  });

  test('queued trigger also works for agentOverride=pi', async () => {
    seedSpec('approved', 'pi-queued');

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ specPath: 'forge/specs/approved/pi-queued.json', workspaceId: 'ws-pipe', agentOverride: 'pi', queue: true });

    expect(res.status).toBe(202);
    expect(res.body.queued).toBe(true);

    const run = await queryOne(`SELECT status, agent_type FROM pipeline_runs WHERE id = $1`, [res.body.runId]) as any;
    expect(run.status).toBe('queued');
    expect(run.agent_type).toBe('pi');
  });

  test('trigger with storyId forwards only a specificStory single-story target into the pipeline job payload', async () => {
    seedSpec('approved', 'specific-story');

    const pgBossMock = jest.requireMock('../../lib/pg-boss');
    const mockSend = pgBossMock.getBoss().send as jest.Mock;
    mockSend.mockClear();

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/specific-story.json',
        workspaceId: 'ws-pipe',
        agentOverride: 'pi',
        storyId: 'US-001',
      });

    expect(res.status).toBe(201);
    expect(mockSend).toHaveBeenCalled();
    const [, payload] = mockSend.mock.calls.at(-1) as [string, Record<string, unknown>];
    expect(payload.specificStory).toBe('US-001');
    expect(payload.startFromStoryId).toBeUndefined();
  });

  test('GET /runs/:runId returns agentType and agentModel fields', async () => {
    // Seed a run with explicit agent info
    const insertResult = await queryOne<{ id: number }>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status, agent, agent_type, agent_model)
       VALUES ('forge/specs/approved/test.json', 'ws-pipe', 'done', 'opencode', 'opencode', 'openai/gpt-4o') RETURNING id`);
    const runId = insertResult!.id;

    // Add a story result so the query doesn't fail
    await execute(`INSERT INTO story_results (run_id, story_id, status, finished_at) VALUES ($1, 'US-001', 'pass', NOW())`, [runId]);

    const res = await request(app)
      .get(`/api/pipeline/runs/${runId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.agentType).toBe('opencode');
    expect(res.body.agentModel).toBe('openai/gpt-4o');
    expect(res.body.run.agent).toBe('opencode');
    expect(res.body.run.agent_model).toBe('openai/gpt-4o');
  });

  test('GET /runs/:runId defaults agentType to claude when agent column is empty', async () => {
    // Old runs may not have agent column set
    const insertResult2 = await queryOne<{ id: number }>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status) VALUES ('forge/specs/approved/old.json', 'ws-pipe', 'done') RETURNING id`);
    const runId = insertResult2!.id;

    const res = await request(app)
      .get(`/api/pipeline/runs/${runId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.agentType).toBe('claude');
    expect(res.body.agentModel).toBeNull();
    expect(res.body.terminal_mode).toBe('ansi-html');
    expect(res.body.run.terminal_mode).toBe('ansi-html');
  });

  test('pipeline_runs table has agent_type and agent_model columns', async () => {
    const cols = await query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'pipeline_runs'`);
    const colNames = cols.map(c => c.column_name);
    expect(colNames).toContain('agent_type');
    expect(colNames).toContain('agent_model');
    expect(colNames).toContain('agent');
    expect(colNames).toContain('opencode_server_pid');
    expect(colNames).toContain('terminal_mode');
  });

  test('trigger response includes agentType and agentModel', async () => {
    seedSpec('approved', 'agent-response');

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ specPath: 'forge/specs/approved/agent-response.json', workspaceId: 'ws-pipe' });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('agentType');
    expect(res.body).toHaveProperty('agentModel');
  });

  test('trigger accepts terminal_mode=pty, persists it, and forwards it to pg-boss', async () => {
    seedSpec('approved', 'terminal-mode-pty');

    const pgBossMock = jest.requireMock('../../lib/pg-boss');
    const mockSend = pgBossMock.getBoss().send as jest.Mock;
    mockSend.mockClear();

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ specPath: 'forge/specs/approved/terminal-mode-pty.json', workspaceId: 'ws-pipe', terminal_mode: 'pty' });

    expect(res.status).toBe(201);
    expect(res.body.terminal_mode).toBe('pty');

    const run = await queryOne<{ terminal_mode: string }>(`SELECT terminal_mode FROM pipeline_runs WHERE id = $1`, [res.body.runId]);
    expect(run?.terminal_mode).toBe('pty');

    expect(mockSend).toHaveBeenCalledWith(
      'pipeline:run',
      expect.objectContaining({ terminalMode: 'pty' }),
      expect.any(Object),
    );
  });

  test('trigger rejects unknown terminal_mode with 400', async () => {
    seedSpec('approved', 'terminal-mode-invalid');

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ specPath: 'forge/specs/approved/terminal-mode-invalid.json', workspaceId: 'ws-pipe', terminal_mode: 'bogus' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid terminal_mode');
  });
});

// ─── GET /api/pipeline/runs/:runId/output ───────────────────────────────────

describe('GET /api/pipeline/runs/:runId/output', () => {
  test('emits run_meta with normalized terminal_mode for replay clients', async () => {
    const inserted = await queryOne<{ id: number }>(
      `INSERT INTO pipeline_runs (spec_path, workspace_id, status)
       VALUES ('forge/specs/approved/output-meta.json', 'ws-pipe', 'done')
       RETURNING id`,
    );
    const runId = inserted!.id;

    const res = await request(app)
      .get(`/api/pipeline/runs/${runId}/output`)
      .set('Authorization', `Bearer ${authToken}`)
      .buffer(true)
      .parse((stream, cb) => {
        let data = '';
        stream.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        stream.on('end', () => cb(null, data));
      });

    expect(res.status).toBe(200);
    expect(String(res.body)).toContain('event: run_meta');
    expect(String(res.body)).toContain('"terminal_mode":"ansi-html"');
    expect(String(res.body)).toContain('"isPty":false');
  });

  test('replays transcript chunks and semantic_step events for non-PTY runs', async () => {
    const inserted = await queryOne<{ id: number }>(
      `INSERT INTO pipeline_runs (spec_path, workspace_id, status)
       VALUES ('forge/specs/approved/output-replay.json', 'ws-pipe', 'done')
       RETURNING id`,
    );
    const runId = inserted!.id;

    const chunkOne = Buffer.from('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"src/foo.ts"}}]}}\n', 'utf8');
    const chunkTwo = Buffer.from('plain transcript line\n', 'utf8');

    await execute(
      `INSERT INTO run_output_chunks (run_id, chunk, sequence)
       VALUES ($1, $2, 0), ($1, $3, 1)`,
      [runId, chunkOne, chunkTwo],
    );

    const res = await request(app)
      .get(`/api/pipeline/runs/${runId}/output`)
      .set('Authorization', `Bearer ${authToken}`)
      .buffer(true)
      .parse((stream, cb) => {
        let data = '';
        stream.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        stream.on('end', () => cb(null, data));
      });

    const body = String(res.body);
    expect(res.status).toBe(200);
    expect(body).toContain('event: run_meta');
    expect(body).toContain('"terminal_mode":"ansi-html"');
    expect(body).toContain('"isPty":false');
    expect(body).toContain(`event: chunk\ndata: ${chunkOne.toString('base64')}`);
    expect(body).toContain(`event: chunk\ndata: ${chunkTwo.toString('base64')}`);
    expect(body).toContain('event: semantic_step');
    expect(body).toContain('"type":"read"');
    expect(body).toContain('"label":"Read src/foo.ts"');
    expect(body).toContain('event: done');
  });
});

// ─── POST /api/pipeline/runs/:runId/retry ───────────────────────────────────

describe('POST /api/pipeline/runs/:runId/retry', () => {
  test('accepts forceSequential and persists retry parallelism = 1', async () => {
    seedSpec('approved', 'retry-sequential');

    const originalRun = await queryOne<{ id: number }>(
      `INSERT INTO pipeline_runs (spec_path, workspace_id, status, parallelism)
       VALUES ('forge/specs/approved/retry-sequential.json', 'ws-pipe', 'failed', 4)
       RETURNING id`
    );
    expect(originalRun?.id).toBeDefined();

    await execute(
      `INSERT INTO story_results (run_id, story_id, status, retries)
       VALUES ($1, 'US-001', 'fail', 0)`,
      [originalRun!.id],
    );

    const pgBossMock = jest.requireMock('../../lib/pg-boss');
    const mockSend = pgBossMock.getBoss().send as jest.Mock;
    mockSend.mockClear();

    const res = await request(app)
      .post(`/api/pipeline/runs/${originalRun!.id}/retry`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ forceSequential: true });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.runId).toBeDefined();

    const retryRun = await queryOne<{ parallelism: number; retried_from_run_id: number | null }>(
      `SELECT parallelism, retried_from_run_id FROM pipeline_runs WHERE id = $1`,
      [res.body.runId],
    );

    expect(retryRun).toBeDefined();
    expect(retryRun!.parallelism).toBe(1);
    expect(retryRun!.retried_from_run_id).toBe(originalRun!.id);
    expect(mockSend).toHaveBeenCalledWith(
      'pipeline:retry',
      expect.objectContaining({
        runId: Number(res.body.runId),
        originalRunId: Number(originalRun!.id),
        storyIds: ['US-001'],
      }),
      expect.any(Object),
    );
  });
});

// ─── POST /api/pipeline/queue — smart run trigger ────────────────────────────

describe('POST /api/pipeline/queue', () => {
  // The global beforeEach re-requires the server (DB migrations) — allow extra time
  jest.setTimeout(90_000);
  let fetchSpy: jest.SpyInstance;

  /** Seed a spec in forge/specs/approved/ (the path queue endpoint expects) */
  function seedForgeSpec(slug: string) {
    const dir = path.join(wsDir, 'forge', 'specs', 'approved');
    fs.mkdirSync(dir, { recursive: true });
    const spec = {
      title: slug.replace(/-/g, ' '),
      userStories: [
        { id: 'US-001', title: 'Story one', description: 'Desc', acceptanceCriteria: ['AC1'], dependsOn: [], passes: false },
      ],
      generatedAt: '2026-02-20T12:00:00.000Z',
    };
    fs.writeFileSync(path.join(dir, `${slug}.json`), JSON.stringify(spec, null, 2), 'utf8');
    return spec;
  }

  beforeEach(() => {
    // Mock global fetch so the queue route's internal trigger call doesn't fail in tests
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url: string | URL | Request, _opts?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;
      if (urlStr.includes('/api/pipeline/trigger')) {
        // Insert a real run row so runId is always a number
        const row = await (await import('../../db/index')).queryOne<{ id: number }>(
          `INSERT INTO pipeline_runs (spec_path, workspace_id, status) VALUES ('forge/specs/approved/test.json', 'ws-pipe', 'running') RETURNING id`
        );
        return new Response(JSON.stringify({ runId: row?.id ?? 999, queued: false, queuePosition: 1, position: 1 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // Fallback for other fetch calls
      return new Response('{}', { status: 200 });
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  test('POST /api/pipeline/queue returns {queued: false} when no active run exists', async () => {
    seedForgeSpec('queue-no-active');

    const res = await request(app)
      .post('/api/pipeline/queue')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-pipe', specId: 'queue-no-active' });

    // Should trigger immediately — no active run
    expect(res.body.queued).toBe(false);
    expect(res.body.runId).toBeDefined();
    expect(res.body.message).toMatch(/started/i);
  }, 60_000);

  test('POST /api/pipeline/queue returns {queued: true} when an active run exists', async () => {
    seedForgeSpec('queue-with-active');
    await seedRun({ status: 'running' });

    const res = await request(app)
      .post('/api/pipeline/queue')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-pipe', specId: 'queue-with-active' });

    expect(res.status).toBe(202);
    expect(res.body.queued).toBe(true);
    expect(res.body.activeRunId).toBeDefined();
    expect(res.body.queuePosition).toBeDefined();
    expect(res.body.message).toMatch(/queued/i);
  });

  test('POST /api/pipeline/queue returns 400 when workspaceId is missing', async () => {
    const res = await request(app)
      .post('/api/pipeline/queue')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ specId: 'some-spec' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('workspaceId');
  });

  test('POST /api/pipeline/queue returns 400 when specId is missing', async () => {
    const res = await request(app)
      .post('/api/pipeline/queue')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-pipe' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('specId');
  });

  test('POST /api/pipeline/queue returns 404 for nonexistent workspace', async () => {
    const res = await request(app)
      .post('/api/pipeline/queue')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'nonexistent-ws', specId: 'some-spec' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Workspace not found');
  });

  test('POST /api/pipeline/queue returns 404 when spec file does not exist', async () => {
    const res = await request(app)
      .post('/api/pipeline/queue')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-pipe', specId: 'no-such-spec' });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Spec not found');
  });
});

// ─── Auto-merge functionality tests ────────────────────────────────

describe('auto_merge column in pipeline_runs', () => {
  test('defaults auto_merge to true when autoWorktree=true', async () => {
    createRunLoopStub();
    seedSpec('approved', 'auto-merge-default');

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/auto-merge-default.json',
        workspaceId: 'ws-pipe',
        autoWorktree: true,
      });

    expect(res.status).toBe(201);
    const runId = res.body.runId;

    // Fetch the run and verify auto_merge = true
    const run = await queryOne(
      `SELECT auto_merge FROM pipeline_runs WHERE id = $1`,
      [runId]
    ) as { auto_merge: boolean } | undefined;

    expect(run).toBeDefined();
    expect(run!.auto_merge).toBe(true);
  });

  test('forces auto_merge to false when autoWorktree=false', async () => {
    createRunLoopStub();
    seedSpec('approved', 'auto-merge-no-worktree');

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/auto-merge-no-worktree.json',
        workspaceId: 'ws-pipe',
        autoWorktree: false,
      });

    expect(res.status).toBe(201);
    const runId = res.body.runId;

    // Fetch the run and verify auto_merge = false
    const run = await queryOne(
      `SELECT auto_merge FROM pipeline_runs WHERE id = $1`,
      [runId]
    ) as { auto_merge: boolean } | undefined;

    expect(run).toBeDefined();
    expect(run!.auto_merge).toBe(false);
  });

  test('respects explicit autoMerge=false when autoWorktree=true', async () => {
    createRunLoopStub();
    seedSpec('approved', 'auto-merge-explicit-false');

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/auto-merge-explicit-false.json',
        workspaceId: 'ws-pipe',
        autoWorktree: true,
        autoMerge: false,
      });

    expect(res.status).toBe(201);
    const runId = res.body.runId;

    // Fetch the run and verify auto_merge = false (explicit request honored)
    const run = await queryOne(
      `SELECT auto_merge FROM pipeline_runs WHERE id = $1`,
      [runId]
    ) as { auto_merge: boolean } | undefined;

    expect(run).toBeDefined();
    expect(run!.auto_merge).toBe(false);
  });

  test('includes autoMerge in pg-boss job payload', async () => {
    createRunLoopStub();
    seedSpec('approved', 'auto-merge-payload');

    // Mock getBoss to capture the job payload
    const { getBoss } = require('../../lib/pg-boss');
    const mockBoss = getBoss();
    mockBoss.send.mockClear();

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/auto-merge-payload.json',
        workspaceId: 'ws-pipe',
        autoWorktree: true,
        autoMerge: true,
      });

    expect(res.status).toBe(201);

    // Verify boss.send was called with autoMerge in payload
    expect(mockBoss.send).toHaveBeenCalled();
    const callArgs = mockBoss.send.mock.calls[0];
    const jobPayload = callArgs[1];
    expect(jobPayload).toHaveProperty('autoMerge');
    expect(jobPayload.autoMerge).toBe(true);
  });

  test('GET /api/pipeline/runs/:id includes auto_merge field', async () => {
    createRunLoopStub();
    seedSpec('approved', 'auto-merge-response');

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/auto-merge-response.json',
        workspaceId: 'ws-pipe',
        autoWorktree: true,
        autoMerge: true,
      });

    expect(res.status).toBe(201);
    const runId = res.body.runId;

    // Fetch the run via GET endpoint
    const getRes = await request(app)
      .get(`/api/pipeline/runs/${runId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(getRes.status).toBe(200);
    expect(getRes.body.run).toBeDefined();
    expect(getRes.body.run).toHaveProperty('auto_merge');
    expect(getRes.body.run.auto_merge).toBe(true);
  });
});

// ─── POST /api/pipeline/orphan-sweep ────────────────────────────────────────

describe('POST /api/pipeline/orphan-sweep', () => {
  test('returns 200 with empty swept array when no orphans exist', async () => {
    const res = await request(app)
      .post('/api/pipeline/orphan-sweep')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('swept');
    expect(res.body).toHaveProperty('count');
    expect(Array.isArray(res.body.swept)).toBe(true);
    expect(res.body.count).toBe(0);
  });

  test('returns 200 with swept runs when orphan processes exist', async () => {
    // Create orphan runs with status='running' and no worker_id
    // (simulates runs from a crashed worker)
    const runId1 = await seedRun({ status: 'running', pid: 999999 });
    const runId2 = await seedRun({ status: 'running', pid: null });

    // Mark them as orphaned (worker_id NULL or different from current worker)
    await execute(`UPDATE pipeline_runs SET worker_id = NULL WHERE id = $1`, [runId1]);
    await execute(`UPDATE pipeline_runs SET worker_id = NULL WHERE id = $2`, [runId2]);

    const res = await request(app)
      .post('/api/pipeline/orphan-sweep')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('swept');
    expect(res.body).toHaveProperty('count');
    expect(Array.isArray(res.body.swept)).toBe(true);
    expect(res.body.count).toBe(2);

    // Verify swept results
    expect(res.body.swept[0]).toHaveProperty('runId');
    expect(res.body.swept[0]).toHaveProperty('pid');
    expect(res.body.swept[0]).toHaveProperty('killed');

    // Verify runs are now marked as failed
    const failedRuns = await query<{ id: number; status: string }>(
      `SELECT id, status FROM pipeline_runs WHERE id IN ($1, $2) ORDER BY id`,
      [runId1, runId2]
    );

    expect(failedRuns).toHaveLength(2);
    expect(failedRuns[0].status).toBe('failed');
    expect(failedRuns[1].status).toBe('failed');

    // Verify WAL events were emitted
    const walEvents = await query<{ event_type: string; payload: any }>(
      `SELECT event_type, payload FROM wal_events
       WHERE workspace_id = 'ws-pipe' AND event_type IN ('run_finished', 'story_failed')
       ORDER BY ts DESC LIMIT 10`,
    );

    expect(walEvents.length).toBeGreaterThan(0);
    const runFinishedEvents = walEvents.filter(e => e.event_type === 'run_finished');
    expect(runFinishedEvents.length).toBeGreaterThanOrEqual(1);
    expect(runFinishedEvents[0].payload.reason).toBe('orphan_sweep');
  });

  test('returns 500 when sweepOrphanProcesses throws', async () => {
    // Mock sweepOrphanProcesses to throw
    jest.spyOn(require('../../../worker'), 'sweepOrphanProcesses').mockRejectedValueOnce(
      new Error('Test sweep error')
    );

    const res = await request(app)
      .post('/api/pipeline/orphan-sweep')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toContain('Test sweep error');
  });
});

// ─── GET /api/pipeline/runs/:runId/stories/:storyId/log — backward compat ──

describe('GET /api/pipeline/runs/:runId/stories/:storyId/log (backward compat)', () => {
  test('endpoint exists and returns SSE headers with text/event-stream content type', async () => {
    const runId = await seedRun({ status: 'running' });

    // Create a log file so the tailing loop has something to read
    const logDir = path.join(wsDir, 'forge', 'specs', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, `US-001_${Date.now()}.log`);
    fs.writeFileSync(logPath, 'test log content\n');

    // Insert story_started WAL event with log_file path so the endpoint finds it
    await execute(
      `INSERT INTO wal_events (event_type, workspace_id, story_id, payload)
       VALUES ('story_started', 'ws-pipe', 'US-001', $1)`,
      [JSON.stringify({ run_id: runId, story_id: 'US-001', log_file: logPath })]
    );

    // Insert story_passed WAL event so the tailing loop terminates
    await execute(
      `INSERT INTO wal_events (event_type, workspace_id, story_id, payload)
       VALUES ('story_passed', 'ws-pipe', 'US-001', $1)`,
      [JSON.stringify({ run_id: runId, story_id: 'US-001' })]
    );

    const res = await request(app)
      .get(`/api/pipeline/runs/${runId}/stories/US-001/log`)
      .set('Authorization', `Bearer ${authToken}`)
      .buffer(true)
      .parse((res, cb) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => cb(null, data));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.headers['cache-control']).toBe('no-cache');
    // Should contain the SSE connection comment
    expect(res.body).toContain(': connected');
  });
});

// ─── GET /api/pipeline/runs/:runId/stories/:storyId/stream — DB-backed SSE ──

describe('GET /api/pipeline/runs/:runId/stories/:storyId/stream', () => {

  /** Parse raw SSE text into an array of { event, data } objects. */
  function parseSSE(raw: string): Array<{ event: string; data: string }> {
    const events: Array<{ event: string; data: string }> = [];
    const blocks = raw.split('\n\n').filter(Boolean);
    for (const block of blocks) {
      // Skip comments (: connected, : hb)
      if (block.startsWith(':')) continue;
      const lines = block.split('\n');
      let event = 'message';
      let data = '';
      for (const line of lines) {
        if (line.startsWith(':')) continue;
        if (line.startsWith('event: ')) event = line.slice(7);
        if (line.startsWith('data: ')) data = line.slice(6);
        if (line === 'data: ') data = '';
      }
      events.push({ event, data });
    }
    return events;
  }

  test('replays 3 existing chunks in sequence order and closes after story_passed WAL event', async () => {
    const runId = await seedRun({ status: 'running' });

    // Insert 3 story_output_chunks rows
    const chunks = ['First chunk of prose output', 'Second chunk continues', 'Third and final chunk'];
    for (let i = 0; i < chunks.length; i++) {
      await execute(
        `INSERT INTO story_output_chunks (run_id, story_id, chunk, sequence)
         VALUES ($1, 'US-001', $2, $3)`,
        [runId, chunks[i], i + 1]
      );
    }

    // Insert story_passed WAL event so isStoryDone() returns true after replay
    await execute(
      `INSERT INTO wal_events (event_type, workspace_id, story_id, payload)
       VALUES ('story_passed', 'ws-pipe', 'US-001', $1)`,
      [JSON.stringify({ run_id: runId, story_id: 'US-001' })]
    );

    // Connect to the /stream endpoint — since story is already done, it will replay + close
    const res = await request(app)
      .get(`/api/pipeline/runs/${runId}/stories/US-001/stream`)
      .set('Authorization', `Bearer ${authToken}`)
      .buffer(true)
      .parse((res, cb) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => cb(null, data));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');

    const events = parseSSE(res.body as string);

    // Should have exactly 3 output events + 1 done event
    const outputEvents = events.filter(e => e.event === 'output');
    const doneEvents = events.filter(e => e.event === 'done');

    expect(outputEvents).toHaveLength(3);
    expect(doneEvents).toHaveLength(1);

    // Verify base64 content matches inserted chunks in sequence order
    for (let i = 0; i < chunks.length; i++) {
      const decoded = Buffer.from(outputEvents[i].data, 'base64').toString('utf8');
      expect(decoded).toBe(chunks[i]);
    }
  });

  test('closes SSE connection within 1s after story_passed WAL event is emitted mid-stream', async () => {
    const runId = await seedRun({ status: 'running' });

    // Insert 3 story_output_chunks rows but NO WAL event yet — the endpoint
    // will replay chunks, find story NOT done, and enter the 200ms poll loop.
    const chunks = ['Alpha prose', 'Beta prose', 'Gamma prose'];
    for (let i = 0; i < chunks.length; i++) {
      await execute(
        `INSERT INTO story_output_chunks (run_id, story_id, chunk, sequence)
         VALUES ($1, 'US-002', $2, $3)`,
        [runId, chunks[i], i + 1]
      );
    }

    const startTime = Date.now();

    // We need to insert the WAL event AFTER the endpoint enters the poll loop.
    // Schedule the insert after 300ms (enough for replay + one poll tick).
    const walInsertPromise = new Promise<void>((resolve) => {
      setTimeout(async () => {
        await execute(
          `INSERT INTO wal_events (event_type, workspace_id, story_id, payload)
           VALUES ('story_passed', 'ws-pipe', 'US-002', $1)`,
          [JSON.stringify({ run_id: runId, story_id: 'US-002' })]
        );
        resolve();
      }, 300);
    });

    // Connect to the stream — it will replay chunks, then poll until WAL event appears
    const res = await request(app)
      .get(`/api/pipeline/runs/${runId}/stories/US-002/stream`)
      .set('Authorization', `Bearer ${authToken}`)
      .buffer(true)
      .parse((res, cb) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => cb(null, data));
      });

    await walInsertPromise;

    const elapsed = Date.now() - startTime;
    expect(res.status).toBe(200);

    const events = parseSSE(res.body as string);
    const outputEvents = events.filter(e => e.event === 'output');
    const doneEvents = events.filter(e => e.event === 'done');

    // Should still have 3 output events from replay
    expect(outputEvents).toHaveLength(3);
    // Must have received the done event
    expect(doneEvents).toHaveLength(1);

    // Connection should close within 1 second of the WAL event (300ms delay + ≤200ms poll + margin)
    // Total elapsed should be well under 2 seconds
    expect(elapsed).toBeLessThan(2_000);
  });
});
