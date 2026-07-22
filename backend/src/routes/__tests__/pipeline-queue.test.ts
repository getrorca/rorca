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
import { claimDispatchForWorker } from '../../lib/dispatch-publication';

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
    createQueue: jest.fn().mockResolvedValue(undefined),
    send: jest.fn().mockImplementation(async (_name: string, _data: unknown, options?: { id?: string }) => options?.id ?? 'mock-job-id'),
    work: jest.fn(),
    stop: jest.fn().mockResolvedValue(undefined),
  }),
}));

let app: Express;
let tmpDir: string;
let wsDir: string;
let authToken: string;

let workspaceSequence = 0;
let WS_ID = '';

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
  workspaceSequence += 1;
  WS_ID = `ws-queue-test-${process.pid}-${workspaceSequence}`;

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-queue-test-'));
  wsDir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(path.join(wsDir, 'forge', 'specs', 'approved'), { recursive: true });
  fs.mkdirSync(path.join(wsDir, 'forge', 'specs', 'pending'), { recursive: true });
  // Use a real repository so worktree/branch discovery exercises the production path.
  execFileSync('git', ['init', '-q', wsDir]);
  execFileSync('git', ['-C', wsDir, 'add', '-A']);
  execFileSync('git', ['-C', wsDir, '-c', 'user.name=Rorca Tests', '-c', 'user.email=tests@rorca.local', 'commit', '--allow-empty', '-qm', 'test baseline']);

  // Each test receives a fresh workspace identity. Canonical runs and evidence
  // are append-only, so fixture isolation never deletes a prior run graph.

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
  await execute(
    `UPDATE pipeline_runs
        SET status = 'failed', finished_at = COALESCE(finished_at, NOW())
      WHERE workspace_id = $1 AND status NOT IN ('done', 'failed', 'cancelled', 'partial_failure')`,
    [WS_ID],
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(() => {
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
  auto_merge: boolean;
  merge_strategy: 'direct' | 'pr' | 'draft-pr' | 'branch-only';
  include_graph: boolean;
  queue_position: number | null;
}> = {}) {
  const autoWorktree = overrides.auto_worktree ?? false;
  const autoMerge = overrides.auto_merge ?? false;
  const mergeStrategy = overrides.merge_strategy ?? 'branch-only';
  const worktreePath = overrides.worktree_path ?? null;
  const includeGraph = overrides.include_graph ?? false;
  const effectiveOptions = {
    model: null,
    effort: null,
    worktree: { enabled: autoWorktree, path: worktreePath, branch: null },
    merge: { strategy: mergeStrategy, autoMerge },
    graph: { enabled: includeGraph },
    terminal: 'ansi-html',
    safety: {
      guard: 'autonomous-command-guard-v1',
      allowBackendJest: false,
      deploy: false,
      externalSend: false,
      policyLocked: true,
    },
  };
  const result = await queryOne<{ id: number }>(
    `INSERT INTO pipeline_runs (
       spec_path, workspace_id, status, pid, triggered_via, worktree_path,
       auto_worktree, auto_merge, merge_strategy, include_graph, queue_position, effective_options
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb) RETURNING id`,
    [
      overrides.spec_path ?? 'forge/specs/approved/test-spec.json',
      overrides.workspace_id ?? WS_ID,
      overrides.status ?? 'running',
      overrides.pid ?? null,
      overrides.triggered_via ?? 'run_now',
      worktreePath,
      autoWorktree,
      autoMerge,
      mergeStrategy,
      includeGraph,
      overrides.queue_position ?? null,
      JSON.stringify(effectiveOptions),
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
        readinessOverride: true,
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
        readinessOverride: true,
        queue: true,
      });

    // Queue operations always insert a queued row — they don't check for active runs
    expect(res.status).toBe(202);
    expect(res.body.queued).toBe(true);
    expect(res.body.queuePosition).toBe(1);
  });

  test('queued cancellation terminalizes application state without relying on a cancel notification', async () => {
    const runId = await seedRun({
      status: 'queued',
      spec_path: 'forge/specs/approved/cancel-before-preparation.json',
      queue_position: 1,
      triggered_via: 'queue',
    });

    const response = await request(app)
      .post(`/api/pipeline/runs/${runId}/cancel`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({});

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, runId: Number(runId), status: 'cancelled' });
    await expect(queryOne(
      `SELECT run.status, publication.state AS publication_state,
              cancellation.terminalized_at
         FROM pipeline_runs run
         JOIN pipeline_dispatch_publications publication ON publication.run_id = run.id
         JOIN pipeline_run_cancellation_requests cancellation ON cancellation.run_id = run.id
        WHERE run.id = $1`,
      [runId],
    )).resolves.toMatchObject({
      status: 'cancelled',
      publication_state: 'cancelled',
      terminalized_at: expect.anything(),
    });
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
          readinessOverride: true,
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
        readinessOverride: true,
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
        readinessOverride: true,
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
        readinessOverride: true,
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
        readinessOverride: true,
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
        readinessOverride: true,
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
        readinessOverride: true,
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
        readinessOverride: true,
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
        readinessOverride: true,
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
        readinessOverride: true,
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
        readinessOverride: true,
      });

    expect(res.status).toBe(201);

    const run = await queryOne<{ triggered_via: string }>(
      `SELECT triggered_via FROM pipeline_runs WHERE id = $1`,
      [res.body.runId]
    );
    expect(run!.triggered_via).toBe('run_now');
  });

  test('generic idempotency rejects reuse with different effective trigger options', async () => {
    seedSpec('generic-idempotency-options');
    const idempotencyKey = '11111111-1111-4111-8111-111111111991';
    const first = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/generic-idempotency-options.json',
        workspaceId: WS_ID,
        readinessOverride: true,
        includeGraph: false,
        idempotencyKey,
      });
    expect(first.status).toBe(201);

    const conflictingReplay = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/generic-idempotency-options.json',
        workspaceId: WS_ID,
        readinessOverride: true,
        includeGraph: true,
        idempotencyKey,
      });

    expect(conflictingReplay.status).toBe(409);
    const rows = await query<{ id: number }>(
      'SELECT id FROM pipeline_runs WHERE workspace_id = $1 AND idempotency_key = $2',
      [WS_ID, idempotencyKey],
    );
    expect(rows).toHaveLength(1);
    const publication = await queryOne<{
      state: string; boss_job_id: string; request_hash: string; effective_options_hash: string;
      payload_hash: string; payload: Record<string, unknown>;
    }>(
      `SELECT state, boss_job_id::text, request_hash, effective_options_hash, payload_hash, payload
         FROM pipeline_dispatch_publications WHERE run_id = $1`,
      [first.body.runId],
    );
    expect(publication).toMatchObject({
      state: 'published',
      request_hash: expect.stringMatching(/^sha256:/),
      effective_options_hash: expect.stringMatching(/^sha256:/),
      payload_hash: expect.stringMatching(/^sha256:/),
    });
    const workerClaim = await claimDispatchForWorker({
      runId: first.body.runId,
      bossJobId: publication!.boss_job_id,
      payload: publication!.payload,
      workerId: '11111111-1111-4111-8111-111111111992',
    });
    expect(workerClaim.claimed).toBe(true);
    const duplicate = await claimDispatchForWorker({
      runId: first.body.runId,
      bossJobId: publication!.boss_job_id,
      payload: publication!.payload,
      workerId: '11111111-1111-4111-8111-111111111993',
    });
    expect(duplicate).toMatchObject({ claimed: false, reason: 'duplicate_delivery' });
  });

  test('exact replay reconciles reserved, preparing, published, and claimed application publication states', async () => {
    seedSpec('dispatch-replay-states');
    const idempotencyKey = '11111111-1111-4111-8111-111111111996';
    const requestBody = {
      specPath: 'forge/specs/approved/dispatch-replay-states.json',
      workspaceId: WS_ID,
      readinessOverride: true,
      idempotencyKey,
    };
    const first = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send(requestBody);
    expect(first.status).toBe(201);

    await execute(
      `UPDATE pipeline_dispatch_publications
          SET state = 'reserved', payload = NULL, payload_hash = NULL,
              lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
        WHERE run_id = $1`,
      [first.body.runId],
    );
    const reservedReplay = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send(requestBody);
    expect(reservedReplay.status).toBe(201);
    expect(reservedReplay.body.runId).toBe(first.body.runId);
    await expect(queryOne<{ state: string }>(
      'SELECT state FROM pipeline_dispatch_publications WHERE run_id = $1',
      [first.body.runId],
    )).resolves.toMatchObject({ state: 'published' });

    await execute(
      `UPDATE pipeline_dispatch_publications
          SET state = 'preparing', payload = NULL, payload_hash = NULL,
              lease_owner = 'other-live-publisher', lease_expires_at = NOW() + INTERVAL '5 minutes',
              updated_at = NOW()
        WHERE run_id = $1`,
      [first.body.runId],
    );
    const preparingReplay = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send(requestBody);
    expect(preparingReplay.status).toBe(202);
    expect(preparingReplay.body.dispatchOutcome).toMatchObject({
      disposition: 'pending_publication',
      runId: first.body.runId,
      replayed: true,
    });

    await execute(
      `UPDATE pipeline_dispatch_publications
          SET state = 'published', payload = '{}'::jsonb,
              payload_hash = 'sha256:' || repeat('a', 64), lease_owner = NULL,
              lease_expires_at = NULL, updated_at = NOW()
        WHERE run_id = $1`,
      [first.body.runId],
    );
    const publishedReplay = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send(requestBody);
    expect(publishedReplay.status).toBe(200);
    expect(publishedReplay.body.dispatchOutcome).toMatchObject({
      disposition: 'already_queued',
      runId: first.body.runId,
      replayed: true,
    });

    await execute(
      `UPDATE pipeline_dispatch_publications
          SET state = 'claimed', lease_owner = 'worker-owner',
              lease_expires_at = NOW() + INTERVAL '10 minutes', updated_at = NOW()
        WHERE run_id = $1`,
      [first.body.runId],
    );
    const claimedReplay = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send(requestBody);
    expect(claimedReplay.status).toBe(200);
    expect(claimedReplay.body.dispatchOutcome).toMatchObject({
      disposition: 'running',
      runId: first.body.runId,
      replayed: true,
    });
  });

  test('worker pickup repairs application authority after send-before-published crash', async () => {
    seedSpec('dispatch-after-send-crash');
    process.env.RORCA_PIPELINE_DISPATCH_FAILPOINT = 'after_send_before_published';
    try {
      const response = await request(app)
        .post('/api/pipeline/trigger')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          specPath: 'forge/specs/approved/dispatch-after-send-crash.json',
          workspaceId: WS_ID,
          readinessOverride: true,
          idempotencyKey: '11111111-1111-4111-8111-111111111994',
        });
      expect(response.status).toBe(500);
      const run = await queryOne<{ id: number }>(
        'SELECT id FROM pipeline_runs WHERE workspace_id = $1 AND idempotency_key = $2',
        [WS_ID, '11111111-1111-4111-8111-111111111994'],
      );
      const publication = await queryOne<{ state: string; boss_job_id: string; payload: Record<string, unknown> }>(
        'SELECT state, boss_job_id::text, payload FROM pipeline_dispatch_publications WHERE run_id = $1',
        [run!.id],
      );
      expect(publication!.state).toBe('preparing');

      const replay = await request(app)
        .post('/api/pipeline/trigger')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          specPath: 'forge/specs/approved/dispatch-after-send-crash.json',
          workspaceId: WS_ID,
          readinessOverride: true,
          idempotencyKey: '11111111-1111-4111-8111-111111111994',
        });
      expect(replay.status).toBe(202);
      expect(replay.body.dispatchOutcome).toMatchObject({
        disposition: 'pending_publication',
        runId: Number(run!.id),
        replayed: true,
      });

      await expect(claimDispatchForWorker({
        runId: run!.id,
        bossJobId: publication!.boss_job_id,
        payload: publication!.payload,
        workerId: '11111111-1111-4111-8111-111111111995',
      })).resolves.toMatchObject({ claimed: true });
    } finally {
      delete process.env.RORCA_PIPELINE_DISPATCH_FAILPOINT;
    }
  });

  test('queue:true sets triggered_via = queue on the queued row', async () => {
    seedSpec('via-queue');

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/via-queue.json',
        workspaceId: WS_ID,
        readinessOverride: true,
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
        readinessOverride: true,
        queuedRunId,
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
        readinessOverride: true,
        queuedRunId,
      });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.runId).toBe(Number(queuedRunId));
  });

  test('queuedRunId promotion cannot broaden frozen merge or graph authority', async () => {
    seedSpec('promo-frozen-authority');
    const queued = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/promo-frozen-authority.json',
        workspaceId: WS_ID,
        readinessOverride: true,
        queue: true,
        autoWorktree: true,
        autoMerge: false,
        mergeStrategy: 'branch-only',
        includeGraph: false,
      });
    expect(queued.status).toBe(202);

    const promoted = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/promo-frozen-authority.json',
        workspaceId: WS_ID,
        readinessOverride: true,
        queuedRunId: queued.body.runId,
        autoWorktree: true,
        autoMerge: true,
        mergeStrategy: 'direct',
        includeGraph: true,
      });
    expect(promoted.status).toBe(201);
    expect(promoted.body.effectiveOptions).toMatchObject({
      merge: { strategy: 'branch-only', autoMerge: false },
      graph: { enabled: false },
    });

    const row = await queryOne<{ auto_merge: boolean; merge_strategy: string; include_graph: boolean }>(
      'SELECT auto_merge, merge_strategy, include_graph FROM pipeline_runs WHERE id = $1',
      [queued.body.runId],
    );
    expect(row).toEqual(expect.objectContaining({
      auto_merge: false,
      merge_strategy: 'branch-only',
      include_graph: false,
    }));
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
        readinessOverride: true,
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
        readinessOverride: true,
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
        readinessOverride: true,
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
        readinessOverride: true,
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
        readinessOverride: true,
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
        readinessOverride: true,
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
    expect(body.queuedRunId).toBe(queuedIds[0]); // Oldest first
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

  test('concurrent promoters acquire exactly one publication owner', async () => {
    seedSpec('advance-concurrent');
    await execute(`UPDATE worker_settings SET value = '1' WHERE key = 'queue_max_concurrent'`);
    const queuedId = await seedRun({
      status: 'queued',
      spec_path: 'forge/specs/approved/advance-concurrent.json',
      queue_position: 1,
      triggered_via: 'queue',
    });
    let releaseFetch!: () => void;
    const fetchBarrier = new Promise<void>((resolve) => { releaseFetch = resolve; });
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async () => {
      await fetchBarrier;
      return new Response(JSON.stringify({ ok: true, runId: queuedId }), { status: 201 });
    });

    const { advanceQueue } = require('../../lib/run-queue');
    const promotions = [advanceQueue(WS_ID), advanceQueue(WS_ID)];
    await new Promise((resolve) => setTimeout(resolve, 100));
    releaseFetch();
    await Promise.all(promotions);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
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
    expect(body.queuedRunId).toBe(queuedId);

    fetchSpy.mockRestore();
  });
});
