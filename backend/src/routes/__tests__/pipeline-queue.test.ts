/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import type { Express } from 'express';
import request from 'supertest';
import { getAuthToken } from './helpers/auth-helper';
import { query, queryOne, execute } from '../../db/index';

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
jest.mock('../../lib/pg-boss', () => ({
  initBoss: jest.fn().mockResolvedValue(undefined),
  getBoss: jest.fn().mockReturnValue({
    send: jest.fn().mockResolvedValue('mock-job-id'),
    work: jest.fn(),
    stop: jest.fn().mockResolvedValue(undefined),
  }),
}));

jest.mock('../../lib/spec-readiness', () => {
  const actual = jest.requireActual('../../lib/spec-readiness');
  return {
    ...actual,
    getSpecReadiness: jest.fn().mockResolvedValue({
      persistenceState: {
        workspaceId: 'ws-queue-test',
        specId: 'queue-test',
        specPath: 'forge/specs/approved/queue-test.json',
        location: 'approved',
        exists: true,
        latestGenerationLogId: 1,
        latestGenerationLogStatus: 'completed',
        saveGeneration: 1,
        contextCapture: { status: 'provided' },
      },
      postSaveState: { mode: 'strict', source: 'workflow', latestWorkflowRunId: 1, latestWorkflowStatus: 'completed', stages: [] },
      readinessState: { status: 'ready', reason: 'strict' },
      executionGate: { status: 'allowed', overrideAllowed: false, overrideReasonCode: actual.SpecReadinessReasonCode.RunAnywayOverrideUsed },
      blockingReasons: [],
      warnings: [],
      availableActions: ['run'],
    }),
    assertSpecReadinessAllowsMutation: jest.fn(),
    recordSpecReadinessOverride: jest.fn().mockResolvedValue(undefined),
  };
});

let app: Express;
let tmpDir: string;
let wsDir: string;
let authToken: string;

const WS_ID = 'ws-queue-test';

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
  await execute(
    `INSERT INTO model_pricing (model_id, input_cost_per_1k, output_cost_per_1k, input_cost_per_1m, output_cost_per_1m)
     VALUES ('claude-sonnet-4-5-20250929', 0.003, 0.015, 3.0, 15.0)
     ON CONFLICT (model_id) DO NOTHING`
  );
});

beforeEach(async () => {
  jest.clearAllMocks();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-queue-test-'));
  wsDir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(path.join(wsDir, 'forge', 'specs', 'approved'), { recursive: true });
  fs.mkdirSync(path.join(wsDir, 'forge', 'specs', 'pending'), { recursive: true });
  // Real git init so worktree creation and branch inspection do not fail.
  fs.writeFileSync(path.join(wsDir, 'README.md'), '# Queue test workspace\n', 'utf8');
  execFileSync('git', ['init'], { cwd: wsDir, stdio: 'ignore' });
  execFileSync('git', ['checkout', '-B', 'main'], { cwd: wsDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'queue-test@rorca.local'], { cwd: wsDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Queue Test'], { cwd: wsDir, stdio: 'ignore' });
  execFileSync('git', ['add', 'README.md'], { cwd: wsDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: wsDir, stdio: 'ignore' });

  // Clean up DB state
  await execute(`DELETE FROM token_usage WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = $1)`, [WS_ID]);
  await execute(`DELETE FROM story_results WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = $1)`, [WS_ID]);
  await execute(`DELETE FROM pipeline_runs WHERE workspace_id = $1`, [WS_ID]);
  await execute(`DELETE FROM wal_events WHERE workspace_id = $1`, [WS_ID]);

  // Ensure users with plan='pro'
  await execute(
    `INSERT INTO users (id, email, display_name, password_hash, plan)
     VALUES ('local-admin', 'admin@rorca.local', 'Admin', 'x', 'pro')
     ON CONFLICT (id) DO UPDATE SET plan = 'pro', email = EXCLUDED.email`
  );
  await execute(`UPDATE users SET plan = 'pro' WHERE email = 'testauth@example.com'`);

  await execute(
    `INSERT INTO model_pricing (model_id, input_cost_per_1k, output_cost_per_1k, input_cost_per_1m, output_cost_per_1m)
     VALUES ('claude-sonnet-4-5-20250929', 0.003, 0.015, 3.0, 15.0)
     ON CONFLICT (model_id) DO NOTHING`
  );

  // Point workspace at fresh tmpDir
  await execute(
    `INSERT INTO workspaces (id, label, path) VALUES ($1, 'Queue Test WS', $2) ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path`,
    [WS_ID, wsDir]
  );

  // Ensure worker_settings have expected values
  await execute(`INSERT INTO worker_settings (key, value) VALUES ('queue_max_concurrent', '1') ON CONFLICT (key) DO UPDATE SET value = '1'`);
  await execute(`INSERT INTO worker_settings (key, value) VALUES ('run_now_max_concurrent', '3') ON CONFLICT (key) DO UPDATE SET value = '3'`);
});

afterEach(async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(async () => {
  // Clean up test data
  await execute(`DELETE FROM token_usage WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = $1)`, [WS_ID]);
  await execute(`DELETE FROM story_results WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = $1)`, [WS_ID]);
  await execute(`DELETE FROM pipeline_runs WHERE workspace_id = $1`, [WS_ID]);
  await execute(`DELETE FROM wal_events WHERE workspace_id = $1`, [WS_ID]);
  delete process.env.NODE_ENV;
});

/** Seed a spec JSON file in the workspace */
function seedSpec(slug: string) {
  const dir = path.join(wsDir, 'forge', 'specs', 'approved');
  const spec = {
    title: slug.replace(/-/g, ' '),
    userStories: [
      { id: 'US-001', title: 'Story one', description: 'Desc', acceptanceCriteria: ['AC1'], dependsOn: [], passes: false },
      { id: 'US-002', title: 'Story two', description: 'Desc 2', acceptanceCriteria: ['AC2'], dependsOn: [], passes: false },
    ],
    generatedAt: '2026-03-18T12:00:00.000Z',
  };
  fs.writeFileSync(path.join(dir, `${slug}.json`), JSON.stringify(spec, null, 2), 'utf8');
  return spec;
}

/** Seed a pipeline run directly in the DB */
async function seedRun(overrides: Partial<{
  status: string;
  workspace_id: string;
  spec_path: string;
  pid: number | null;
  triggered_via: string;
  worktree_path: string | null;
  auto_worktree: boolean;
  queue_position: number | null;
}> = {}) {
  const result = await queryOne<{ id: number }>(
    `INSERT INTO pipeline_runs (spec_path, workspace_id, status, pid, triggered_via, worktree_path, auto_worktree, queue_position)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      overrides.spec_path ?? 'forge/specs/approved/test-spec.json',
      overrides.workspace_id ?? WS_ID,
      overrides.status ?? 'running',
      overrides.pid ?? null,
      overrides.triggered_via ?? 'run_now',
      overrides.worktree_path ?? null,
      overrides.auto_worktree ?? false,
      overrides.queue_position ?? null,
    ]
  );
  return result!.id;
}

// ─── Queue Semantics ─────────────────────────────────────────────────────────

describe('Queue Semantics', () => {
  test('queue:true returns 202 with queuePosition when another run is active', async () => {
    seedSpec('queue-test-1');

    // Seed an active run
    await seedRun({ status: 'running' });

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/queue-test-1.json',
        workspaceId: WS_ID,
        queue: true,
      });

    expect(res.status).toBe(202);
    expect(res.body.queued).toBe(true);
    expect(res.body.runId).toBeDefined();
    expect(typeof res.body.queuePosition).toBe('number');
    expect(res.body.queuePosition).toBeGreaterThan(0);

    // Verify the pipeline_runs row has status='queued' and triggered_via='queue'
    const run = await queryOne<{ status: string; triggered_via: string; queue_position: number }>(
      `SELECT status, triggered_via, queue_position FROM pipeline_runs WHERE id = $1`,
      [res.body.runId]
    );
    expect(run).toBeDefined();
    expect(run!.status).toBe('queued');
    expect(run!.triggered_via).toBe('queue');
    expect(run!.queue_position).toBeGreaterThan(0);
  });

  test('queue:true returns 202 even when NO run is active (no conflict)', async () => {
    seedSpec('queue-no-active');

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/queue-no-active.json',
        workspaceId: WS_ID,
        queue: true,
      });

    // Queue operations always insert a queued row — they don't check for active runs
    expect(res.status).toBe(202);
    expect(res.body.queued).toBe(true);
    expect(res.body.queuePosition).toBe(1);
  });

  test('queue fills sequentially with correct positions', async () => {
    seedSpec('queue-seq');

    // Seed an active run so queue makes sense
    await seedRun({ status: 'running' });

    // Queue 3 runs
    const positions: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post('/api/pipeline/trigger')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          specPath: 'forge/specs/approved/queue-seq.json',
          workspaceId: WS_ID,
          queue: true,
        });

      expect(res.status).toBe(202);
      positions.push(res.body.queuePosition);
    }

    // Positions should be sequential: 1, 2, 3
    expect(positions).toEqual([1, 2, 3]);
  });

  test('queue depth limit enforced at 10 — 11th queued run returns 429', async () => {
    seedSpec('queue-full');

    // Seed 10 queued runs directly in DB
    for (let i = 0; i < 10; i++) {
      await seedRun({ status: 'queued', queue_position: i + 1 });
    }

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/queue-full.json',
        workspaceId: WS_ID,
        queue: true,
      });

    expect(res.status).toBe(429);
    expect(res.body.error).toBe('Queue full');
    expect(res.body.maxQueueDepth).toBe(10);
    expect(res.body.currentDepth).toBe(10);
  });

  test('queue:true at exactly 10 queued runs returns 429', async () => {
    seedSpec('queue-boundary');

    // Seed exactly 10 queued runs
    for (let i = 0; i < 10; i++) {
      await seedRun({ status: 'queued', queue_position: i + 1 });
    }

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/queue-boundary.json',
        workspaceId: WS_ID,
        queue: true,
      });

    expect(res.status).toBe(429);
  });

  test('queue:true at 9 queued runs still succeeds (under limit)', async () => {
    seedSpec('queue-under');

    // Seed 9 queued runs
    for (let i = 0; i < 9; i++) {
      await seedRun({ status: 'queued', queue_position: i + 1 });
    }

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/queue-under.json',
        workspaceId: WS_ID,
        queue: true,
      });

    expect(res.status).toBe(202);
    expect(res.body.queued).toBe(true);
    expect(res.body.queuePosition).toBe(10);
  });
});

// ─── Conflict Detection ──────────────────────────────────────────────────────

describe('Conflict Detection', () => {
  test('queue:false without autoWorktree returns 200 conflict when any run is active', async () => {
    seedSpec('conflict-no-wt');

    // Seed an active run
    await seedRun({ status: 'running' });

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/conflict-no-wt.json',
        workspaceId: WS_ID,
        autoWorktree: false,
      });

    expect(res.status).toBe(200);
    expect(res.body.conflict).toBe(true);
    expect(res.body.activeRunId).toBeDefined();
  });

  test('queue:false without autoWorktree succeeds when no run is active', async () => {
    seedSpec('no-conflict');

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/no-conflict.json',
        workspaceId: WS_ID,
      });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.runId).toBeDefined();
  });

  test('queue:false with autoWorktree returns 200 conflict at run_now_max_concurrent', async () => {
    seedSpec('wt-conflict');

    // run_now_max_concurrent defaults to 3 — seed 3 active worktree runs
    for (let i = 0; i < 3; i++) {
      await seedRun({
        status: 'running',
        worktree_path: `/tmp/worktree-${i}`,
        auto_worktree: true,
      });
    }

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/wt-conflict.json',
        workspaceId: WS_ID,
        autoWorktree: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.conflict).toBe(true);
    expect(res.body.reason).toMatch(/Maximum 3 concurrent worktree runs/);
  });

  test('queue:false with autoWorktree succeeds under run_now_max_concurrent', async () => {
    seedSpec('wt-ok');

    // Seed 2 active worktree runs (under the default 3 limit)
    for (let i = 0; i < 2; i++) {
      await seedRun({
        status: 'running',
        worktree_path: `/tmp/worktree-${i}`,
        auto_worktree: true,
      });
    }

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/wt-ok.json',
        workspaceId: WS_ID,
        autoWorktree: true,
      });

    // Should succeed (201) — 2 active < 3 limit
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.runId).toBeDefined();
  });

  test('paused runs count as active for conflict detection', async () => {
    seedSpec('paused-conflict');

    await seedRun({ status: 'paused' });

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/paused-conflict.json',
        workspaceId: WS_ID,
      });

    expect(res.status).toBe(200);
    expect(res.body.conflict).toBe(true);
  });

  test('done/failed/cancelled runs do NOT count as active conflicts', async () => {
    seedSpec('no-stale-conflict');

    await seedRun({ status: 'done' });
    await seedRun({ status: 'failed' });
    await seedRun({ status: 'cancelled' });

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/no-stale-conflict.json',
        workspaceId: WS_ID,
      });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
  });
});

// ─── triggered_via Routing ───────────────────────────────────────────────────

describe('triggered_via Routing', () => {
  test('direct trigger (no queue) sets triggered_via = run_now', async () => {
    seedSpec('via-run-now');

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/via-run-now.json',
        workspaceId: WS_ID,
      });

    expect(res.status).toBe(201);

    const run = await queryOne<{ triggered_via: string }>(
      `SELECT triggered_via FROM pipeline_runs WHERE id = $1`,
      [res.body.runId]
    );
    expect(run!.triggered_via).toBe('run_now');
  });

  test('queue:true sets triggered_via = queue on the queued row', async () => {
    seedSpec('via-queue');

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/via-queue.json',
        workspaceId: WS_ID,
        queue: true,
      });

    expect(res.status).toBe(202);

    const run = await queryOne<{ triggered_via: string; status: string }>(
      `SELECT triggered_via, status FROM pipeline_runs WHERE id = $1`,
      [res.body.runId]
    );
    expect(run!.triggered_via).toBe('queue');
    expect(run!.status).toBe('queued');
  });

  test('promotion via queuedRunId sets triggered_via = queue on the promoted run', async () => {
    seedSpec('via-promoted');

    // First, create a queued run directly
    const queuedRunId = await seedRun({
      status: 'queued',
      spec_path: 'forge/specs/approved/via-promoted.json',
      queue_position: 1,
      triggered_via: 'queue',
    });

    // Promote via internal trigger with queuedRunId (skips conflict check)
    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/via-promoted.json',
        workspaceId: WS_ID,
        queuedRunId: Number(queuedRunId),
      });

    expect(res.status).toBe(201);

    const run = await queryOne<{ triggered_via: string }>(
      `SELECT triggered_via FROM pipeline_runs WHERE id = $1`,
      [queuedRunId]
    );
    expect(run!.triggered_via).toBe('queue');
  });

  test('queuedRunId promotion skips conflict detection even when a run is active', async () => {
    seedSpec('promo-no-conflict');

    // Seed an active run
    await seedRun({ status: 'running' });

    // Create a queued run to promote
    const queuedRunId = await seedRun({
      status: 'queued',
      spec_path: 'forge/specs/approved/promo-no-conflict.json',
      queue_position: 1,
      triggered_via: 'queue',
    });

    // Promote — should NOT conflict despite active run
    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/promo-no-conflict.json',
        workspaceId: WS_ID,
        queuedRunId: Number(queuedRunId),
      });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.runId).toBe(Number(queuedRunId));
  });
});

// ─── autoWorktree on Runs ────────────────────────────────────────────────────

describe('autoWorktree on Runs', () => {
  test('queue:true with autoWorktree stores auto_worktree=true on queued row', async () => {
    seedSpec('queue-wt');

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/queue-wt.json',
        workspaceId: WS_ID,
        queue: true,
        autoWorktree: true,
      });

    expect(res.status).toBe(202);

    const run = await queryOne<{ auto_worktree: boolean }>(
      `SELECT auto_worktree FROM pipeline_runs WHERE id = $1`,
      [res.body.runId]
    );
    expect(run!.auto_worktree).toBe(true);
  });

  test('queue:true without autoWorktree stores auto_worktree=false', async () => {
    seedSpec('queue-no-wt');

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/queue-no-wt.json',
        workspaceId: WS_ID,
        queue: true,
      });

    expect(res.status).toBe(202);

    const run = await queryOne<{ auto_worktree: boolean }>(
      `SELECT auto_worktree FROM pipeline_runs WHERE id = $1`,
      [res.body.runId]
    );
    expect(run!.auto_worktree).toBe(false);
  });

  test('run-now trigger includes worktreePath and branchName in response', async () => {
    seedSpec('wt-response');

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/wt-response.json',
        workspaceId: WS_ID,
        autoWorktree: true,
      });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.worktreePath).toBeDefined();
    expect(typeof res.body.worktreePath).toBe('string');
    expect(res.body.branchName).toBeDefined();
    expect(res.body.branchName).toMatch(/^feat\//);
  });

  test('run-now without autoWorktree has null worktreePath', async () => {
    seedSpec('no-wt-response');

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/no-wt-response.json',
        workspaceId: WS_ID,
      });

    expect(res.status).toBe(201);
    expect(res.body.worktreePath).toBeNull();
    expect(res.body.branchName).toBeNull();
  });

  test('pg-boss job payload includes worktree fields for autoWorktree run', async () => {
    const { getBoss } = require('../../lib/pg-boss');
    seedSpec('wt-payload');

    await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/wt-payload.json',
        workspaceId: WS_ID,
        autoWorktree: true,
      });

    // Verify the pg-boss send was called with worktree payload
    const sendMock = getBoss().send as jest.Mock;
    expect(sendMock).toHaveBeenCalledWith(
      'pipeline:run',
      expect.objectContaining({
        autoWorktree: true,
        worktreePath: expect.any(String),
        branchName: expect.stringMatching(/^feat\//),
        triggeredVia: 'run_now',
      }),
      expect.any(Object)
    );
  });

  test('pg-boss job payload for non-worktree run has null worktree fields', async () => {
    const { getBoss } = require('../../lib/pg-boss');
    seedSpec('no-wt-payload');

    await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/no-wt-payload.json',
        workspaceId: WS_ID,
      });

    const sendMock = getBoss().send as jest.Mock;
    expect(sendMock).toHaveBeenCalledWith(
      'pipeline:run',
      expect.objectContaining({
        autoWorktree: false,
        worktreePath: null,
        branchName: null,
        triggeredVia: 'run_now',
      }),
      expect.any(Object)
    );
  });
});

// ─── advanceQueue() ──────────────────────────────────────────────────────────

describe('advanceQueue()', () => {
  test('promotes exactly queue_max_concurrent queued runs', async () => {
    seedSpec('advance-test');

    // Set queue_max_concurrent to 1 (default)
    await execute(`UPDATE worker_settings SET value = '1' WHERE key = 'queue_max_concurrent'`);

    // Seed 3 queued runs
    const queuedIds: number[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await seedRun({
        status: 'queued',
        spec_path: 'forge/specs/approved/advance-test.json',
        queue_position: i + 1,
        triggered_via: 'queue',
      });
      queuedIds.push(id);
      // Small delay so queued_at ordering is deterministic
      await new Promise((r) => setTimeout(r, 50));
    }

    // Mock fetch to capture the internal trigger call advanceQueue makes
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify({ ok: true, runId: queuedIds[0] }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    // Import and call advanceQueue
    const { advanceQueue } = require('../../lib/run-queue');
    await advanceQueue(WS_ID);

    // Wait for the fire-and-forget fetch to resolve
    await new Promise((r) => setTimeout(r, 200));

    // Should have called fetch exactly once (promotes 1 run since queue_max_concurrent=1, 0 active)
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/pipeline/trigger');
    const body = JSON.parse(options.body as string);
    expect(body.queuedRunId).toBe(Number(queuedIds[0])); // Oldest first; pg BIGINT ids are serialized as strings by pg
    expect(body.specPath).toBe('forge/specs/approved/advance-test.json');
    expect(body.workspaceId).toBe(WS_ID);

    // Verify WAL event was emitted
    const walEvents = await query<{ event_type: string; payload: string }>(
      `SELECT event_type, payload FROM wal_events WHERE workspace_id = $1 AND event_type = 'run_queued_promoted'`,
      [WS_ID]
    );
    expect(walEvents.length).toBe(1);
    const walPayload = typeof walEvents[0].payload === 'string'
      ? JSON.parse(walEvents[0].payload)
      : walEvents[0].payload;
    expect(walPayload.runId).toBe(queuedIds[0]);

    fetchSpy.mockRestore();
  });

  test('does not promote when active queue runs >= queue_max_concurrent', async () => {
    seedSpec('advance-full');

    await execute(`UPDATE worker_settings SET value = '1' WHERE key = 'queue_max_concurrent'`);

    // Seed an active queue-triggered run
    await seedRun({
      status: 'running',
      triggered_via: 'queue',
    });

    // Seed a queued run waiting to be promoted
    await seedRun({
      status: 'queued',
      spec_path: 'forge/specs/approved/advance-full.json',
      queue_position: 1,
      triggered_via: 'queue',
    });

    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
    });

    const { advanceQueue } = require('../../lib/run-queue');
    await advanceQueue(WS_ID);
    await new Promise((r) => setTimeout(r, 200));

    // Should NOT have called fetch — already at capacity
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  test('promotes when queue_max_concurrent is increased to 2', async () => {
    seedSpec('advance-multi');

    await execute(`UPDATE worker_settings SET value = '2' WHERE key = 'queue_max_concurrent'`);

    // 1 active queue run (under limit of 2)
    await seedRun({
      status: 'running',
      triggered_via: 'queue',
    });

    // 2 queued runs
    const queuedId = await seedRun({
      status: 'queued',
      spec_path: 'forge/specs/approved/advance-multi.json',
      queue_position: 1,
      triggered_via: 'queue',
    });

    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify({ ok: true, runId: queuedId }), { status: 201 });
    });

    const { advanceQueue } = require('../../lib/run-queue');
    await advanceQueue(WS_ID);
    await new Promise((r) => setTimeout(r, 200));

    // Should promote 1 (1 active < 2 limit)
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    fetchSpy.mockRestore();
  });

  test('does not promote when no queued runs exist', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
    });

    const { advanceQueue } = require('../../lib/run-queue');
    await advanceQueue(WS_ID);
    await new Promise((r) => setTimeout(r, 200));

    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  test('advanceQueue passes auto_worktree from the queued run row', async () => {
    seedSpec('advance-wt');

    await execute(`UPDATE worker_settings SET value = '1' WHERE key = 'queue_max_concurrent'`);

    // Seed a queued run with auto_worktree=true
    const queuedId = await seedRun({
      status: 'queued',
      spec_path: 'forge/specs/approved/advance-wt.json',
      queue_position: 1,
      triggered_via: 'queue',
      auto_worktree: true,
    });

    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify({ ok: true, runId: queuedId }), { status: 201 });
    });

    const { advanceQueue } = require('../../lib/run-queue');
    await advanceQueue(WS_ID);
    await new Promise((r) => setTimeout(r, 200));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.autoWorktree).toBe(true);
    expect(body.queuedRunId).toBe(Number(queuedId));

    fetchSpy.mockRestore();
  });

  test('replays the full queued trigger contract when promoting a run', async () => {
    seedSpec('advance-contract');

    await execute(`UPDATE worker_settings SET value = '1' WHERE key = 'queue_max_concurrent'`);
    const triggerOptions = {
      autoWorktree: true,
      autoMerge: false,
      mergeStrategy: 'pr',
      forceSequential: true,
      agentOverride: 'pi',
      modelOverride: 'openai-codex/gpt-5.5',
      includeGraph: true,
      effortLevel: 'xhigh',
      reasoningEffort: 'xhigh',
      terminal_mode: 'ansi-html',
      executionEnvironment: 'local-user',
      readinessOverride: true,
    };
    const queuedId = await queryOne<{ id: number }>(
      `INSERT INTO pipeline_runs (
         spec_path, workspace_id, status, triggered_via, auto_worktree,
         auto_merge, include_graph, parallelism, agent, agent_type, agent_model,
         merge_strategy, terminal_mode, execution_environment, queue_position, trigger_options
       ) VALUES ($1, $2, 'queued', 'queue', true, false, true, 1,
         'pi', 'pi', 'openai-codex/gpt-5.5', 'pr', 'ansi-html', 'local-user', 1, $3::jsonb)
       RETURNING id`,
      ['forge/specs/approved/advance-contract.json', WS_ID, JSON.stringify(triggerOptions)],
    );

    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify({ ok: true, runId: queuedId!.id }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const { advanceQueue } = require('../../lib/run-queue');
    await advanceQueue(WS_ID);
    await new Promise((r) => setTimeout(r, 200));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string);
    expect(body).toEqual(expect.objectContaining({
      specPath: 'forge/specs/approved/advance-contract.json',
      workspaceId: WS_ID,
      queuedRunId: Number(queuedId!.id),
      autoWorktree: true,
      autoMerge: false,
      mergeStrategy: 'pr',
      forceSequential: true,
      agentOverride: 'pi',
      modelOverride: 'openai-codex/gpt-5.5',
      includeGraph: true,
      effortLevel: 'xhigh',
      reasoningEffort: 'xhigh',
      terminal_mode: 'ansi-html',
      executionEnvironment: 'local-user',
      readinessOverride: true,
    }));

    fetchSpy.mockRestore();
  });
});
