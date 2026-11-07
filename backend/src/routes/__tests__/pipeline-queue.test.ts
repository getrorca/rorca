/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import type { Server } from 'http';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { execute, query, queryOne } from '../../db/index';
import { getAuthToken } from './helpers/auth-helper';

jest.setTimeout(90_000);

jest.mock('../../lib/llm-client', () => ({
  chatComplete: jest.fn(),
  getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
  isValidModel: jest.fn().mockReturnValue(true),
  DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
  resolveVaultProvider: jest.fn().mockReturnValue(null),
  getModelInfo: jest.fn().mockReturnValue(undefined),
  SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
}));

const mockBossCreateQueue = jest.fn().mockResolvedValue(undefined);
const mockBossSend = jest.fn().mockImplementation(
  async (_name: string, _data: unknown, options?: { id?: string }) => options?.id ?? randomUUID(),
);
jest.mock('../../lib/pg-boss', () => ({
  initBoss: jest.fn().mockResolvedValue(undefined),
  getPgBossSchemaSql: jest.fn(() => '"pgboss"'),
  getBoss: jest.fn().mockReturnValue({
    createQueue: mockBossCreateQueue,
    send: mockBossSend,
    work: jest.fn(),
    stop: jest.fn().mockResolvedValue(undefined),
  }),
}));

let app: Server;
let authToken: string;
let tmpDir: string;
let wsDir: string;
const workspaceId = `queue-suite-${randomUUID()}`;
const fixtureEmail = `queue-suite-${randomUUID()}@example.com`;
const workerSettingBaseline = new Map<string, string | null>();

async function cleanupRunState(): Promise<void> {
  await execute('DELETE FROM pipeline_run_cancellation_requests WHERE workspace_id = $1', [workspaceId]);
  await execute('DELETE FROM pipeline_dispatch_publications WHERE workspace_id = $1', [workspaceId]);
  await execute(`DELETE FROM story_results WHERE run_id IN (
    SELECT id FROM pipeline_runs WHERE workspace_id = $1
  )`, [workspaceId]);
  await execute(`DELETE FROM token_usage WHERE run_id IN (
    SELECT id FROM pipeline_runs WHERE workspace_id = $1
  )`, [workspaceId]);
  await execute('DELETE FROM wal_events WHERE workspace_id = $1', [workspaceId]);
  await execute('DELETE FROM pipeline_runs WHERE workspace_id = $1', [workspaceId]);
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-queue-suite-'));
  wsDir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(path.join(wsDir, 'forge', 'specs', 'approved'), { recursive: true });
  fs.mkdirSync(path.join(wsDir, 'forge', 'specs', 'pending'), { recursive: true });
  execFileSync('git', ['init', '-q', wsDir]);
  execFileSync('git', ['-C', wsDir, 'add', '-A']);
  execFileSync('git', [
    '-C', wsDir, '-c', 'user.name=Rorca Tests', '-c', 'user.email=tests@rorca.local',
    'commit', '--allow-empty', '-qm', 'test baseline',
  ]);

  const expressApp = require('../../server').default;
  authToken = await getAuthToken(expressApp, { email: fixtureEmail, role: 'admin' });
  app = expressApp.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    app.once('listening', resolve);
    app.once('error', reject);
  });

  await execute(
    `INSERT INTO workspaces (id, label, path) VALUES ($1, 'Queue Test Workspace', $2)`,
    [workspaceId, wsDir],
  );
  for (const key of ['queue_max_concurrent', 'run_now_max_concurrent']) {
    const row = await queryOne<{ value: string }>('SELECT value FROM worker_settings WHERE key = $1', [key]);
    workerSettingBaseline.set(key, row?.value ?? null);
  }
});

beforeEach(async () => {
  jest.clearAllMocks();
  await cleanupRunState();
  await execute(
    `INSERT INTO worker_settings (key, value) VALUES ('queue_max_concurrent', '1')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  );
  await execute(
    `INSERT INTO worker_settings (key, value) VALUES ('run_now_max_concurrent', '3')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  );
});

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.RORCA_PIPELINE_DISPATCH_FAILPOINT;
});

afterAll(async () => {
  await cleanupRunState();
  await execute('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
  await execute('DELETE FROM users WHERE email = $1', [fixtureEmail]);
  for (const [key, value] of workerSettingBaseline) {
    if (value === null) {
      await execute('DELETE FROM worker_settings WHERE key = $1', [key]);
    } else {
      await execute(
        `INSERT INTO worker_settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, value],
      );
    }
  }
  app.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => {
    app.close((error) => error ? reject(error) : resolve());
  });
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedSpec(slug: string): void {
  const spec = {
    title: slug.replace(/-/g, ' '),
    userStories: [
      { id: 'US-001', title: 'Story one', description: 'Desc', acceptanceCriteria: ['AC1'], dependsOn: [], passes: false },
      { id: 'US-002', title: 'Story two', description: 'Desc 2', acceptanceCriteria: ['AC2'], dependsOn: [], passes: false },
    ],
    generatedAt: '2026-03-18T12:00:00.000Z',
  };
  fs.writeFileSync(
    path.join(wsDir, 'forge', 'specs', 'approved', `${slug}.json`),
    JSON.stringify(spec, null, 2),
    'utf8',
  );
}

async function seedRun(overrides: Partial<{
  status: string;
  specPath: string;
  triggeredVia: 'queue' | 'run_now';
  worktreePath: string | null;
  autoWorktree: boolean;
  queuePosition: number | null;
}> = {}): Promise<number> {
  const autoWorktree = overrides.autoWorktree ?? false;
  const worktreePath = overrides.worktreePath ?? null;
  const effectiveOptions = {
    model: null,
    effort: null,
    worktree: { enabled: autoWorktree, path: worktreePath, branch: null },
    merge: { strategy: 'branch-only', autoMerge: false },
    graph: { enabled: false },
    terminal: 'ansi-html',
    safety: {
      guard: 'autonomous-command-guard-v1',
      allowBackendJest: false,
      deploy: false,
      externalSend: false,
      policyLocked: true,
    },
  };
  const row = await queryOne<{ id: number }>(
    `INSERT INTO pipeline_runs (
       spec_path, workspace_id, status, triggered_via, worktree_path,
       auto_worktree, auto_merge, merge_strategy, include_graph, queue_position,
       idempotency_key, effective_options
     ) VALUES ($1, $2, $3, $4, $5, $6, false, 'branch-only', false, $7, $8, $9::jsonb)
     RETURNING id`,
    [
      overrides.specPath ?? 'forge/specs/approved/test-spec.json',
      workspaceId,
      overrides.status ?? 'running',
      overrides.triggeredVia ?? 'run_now',
      worktreePath,
      autoWorktree,
      overrides.queuePosition ?? null,
      randomUUID(),
      JSON.stringify(effectiveOptions),
    ],
  );
  return Number(row!.id);
}

const retiredGenericCases: Array<{ name: string; body: Record<string, unknown> }> = [
  { name: 'queue:true with another active run', body: { queue: true } },
  { name: 'queue:true with no active run', body: { queue: true } },
  { name: 'sequential queue filling request', body: { queue: true, idempotencyKey: randomUUID() } },
  { name: 'queue-depth overflow request', body: { queue: true } },
  { name: 'exact queue-depth boundary request', body: { queue: true } },
  { name: 'under-limit queue request', body: { queue: true } },
  { name: 'non-worktree conflict request', body: { autoWorktree: false } },
  { name: 'non-worktree run-now request', body: { autoWorktree: false } },
  { name: 'worktree concurrency conflict request', body: { autoWorktree: true } },
  { name: 'worktree under-limit request', body: { autoWorktree: true } },
  { name: 'request beside a paused run', body: {} },
  { name: 'request beside terminal runs', body: {} },
  { name: 'direct run-now request', body: {} },
  { name: 'generic idempotency request', body: { idempotencyKey: randomUUID(), includeGraph: false } },
  { name: 'generic publication-state replay request', body: { idempotencyKey: randomUUID() } },
  { name: 'generic send-before-published failpoint request', body: { idempotencyKey: randomUUID() } },
  { name: 'generic queue triggered_via request', body: { queue: true } },
  { name: 'generic queuedRunId promotion request', body: { queuedRunId: 42 } },
  { name: 'generic promotion beside an active run', body: { queuedRunId: 43 } },
  { name: 'generic authority-broadening promotion request', body: { queuedRunId: 44, includeGraph: true, autoMerge: true } },
  { name: 'generic queued auto-worktree request', body: { queue: true, autoWorktree: true } },
  { name: 'generic queued non-worktree request', body: { queue: true, autoWorktree: false } },
  { name: 'generic run-now worktree response request', body: { autoWorktree: true } },
  { name: 'generic run-now non-worktree response request', body: { autoWorktree: false } },
  { name: 'generic worktree pg-boss payload request', body: { autoWorktree: true } },
  { name: 'generic non-worktree pg-boss payload request', body: { autoWorktree: false } },
];

describe('Release-1 retired generic queue/run surface', () => {
  test.each(retiredGenericCases)('$name fails closed before application or transport mutation', async ({ body }) => {
    const before = Number((await queryOne<{ count: string }>(
      'SELECT COUNT(*) AS count FROM pipeline_runs WHERE workspace_id = $1',
      [workspaceId],
    ))?.count ?? '0');
    const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : randomUUID();

    const response = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .set('Idempotency-Key', idempotencyKey)
      .send({
        specPath: 'forge/specs/approved/must-not-be-read.json',
        workspaceId,
        autoWorktree: true,
        autoMerge: false,
        mergeStrategy: 'draft-pr',
        idempotencyKey,
        ...body,
      });

    expect(response.status).toBe(422);
    expect(response.body.code).toMatch(/^RELEASE_ONE_/);
    expect(response.body).not.toHaveProperty('runId');
    expect(mockBossCreateQueue).not.toHaveBeenCalled();
    expect(mockBossSend).not.toHaveBeenCalled();
    const after = Number((await queryOne<{ count: string }>(
      'SELECT COUNT(*) AS count FROM pipeline_runs WHERE workspace_id = $1',
      [workspaceId],
    ))?.count ?? '0');
    expect(after).toBe(before);
  });
});

test('retired readiness override is rejected by the exact trigger schema before any mutation', async () => {
  const before = Number((await queryOne<{ count: string }>('SELECT COUNT(*) AS count FROM pipeline_runs WHERE workspace_id=$1',[workspaceId]))?.count ?? '0');
  const idempotencyKey = randomUUID();
  const response = await request(app)
    .post('/api/pipeline/trigger')
    .set('Authorization', `Bearer ${authToken}`)
    .set('Idempotency-Key', idempotencyKey)
    .send({
      specPath: 'forge/specs/approved/must-not-be-read.json',
      workspaceId,
      idempotencyKey,
      readinessOverride: true,
      autoWorktree: true,
      autoMerge: false,
      mergeStrategy: 'draft-pr',
    });
  expect(response.status).toBe(422);
  expect(response.body.code).toBe('REQUEST_SCHEMA_INVALID');
  expect(mockBossCreateQueue).not.toHaveBeenCalled();
  expect(mockBossSend).not.toHaveBeenCalled();
  const after = Number((await queryOne<{ count: string }>('SELECT COUNT(*) AS count FROM pipeline_runs WHERE workspace_id=$1',[workspaceId]))?.count ?? '0');
  expect(after).toBe(before);
});

test('queued cancellation terminalizes application state without relying on a cancel notification', async () => {
  const runId = await seedRun({
    status: 'queued',
    specPath: 'forge/specs/approved/cancel-before-preparation.json',
    queuePosition: 1,
    triggeredVia: 'queue',
  });

  const response = await request(app)
    .post(`/api/pipeline/runs/${runId}/cancel`)
    .set('Authorization', `Bearer ${authToken}`)
    .send({});

  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ ok: true, runId, status: 'cancelled' });
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

describe('advanceQueue application-owned promotion', () => {
  test('promotes exactly queue_max_concurrent queued runs', async () => {
    seedSpec('advance-test');
    const queuedIds: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      queuedIds.push(await seedRun({
        status: 'queued',
        specPath: 'forge/specs/approved/advance-test.json',
        queuePosition: index + 1,
        triggeredVia: 'queue',
      }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ ok: true, runId: queuedIds[0] }),
      { status: 201, headers: { 'Content-Type': 'application/json' } },
    ));

    const { advanceQueue } = require('../../lib/run-queue');
    await advanceQueue(workspaceId);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/pipeline/trigger');
    const body = JSON.parse(options.body as string);
    expect(Number(body.queuedRunId)).toBe(queuedIds[0]);
    expect(body.specPath).toBe('forge/specs/approved/advance-test.json');
    expect(body.workspaceId).toBe(workspaceId);
    const walEvents = await query<{ payload: Record<string, unknown> | string }>(
      `SELECT payload FROM wal_events
       WHERE workspace_id = $1 AND event_type = 'run_queued_promoted'`,
      [workspaceId],
    );
    expect(walEvents).toHaveLength(1);
    const walPayload = typeof walEvents[0].payload === 'string'
      ? JSON.parse(walEvents[0].payload)
      : walEvents[0].payload;
    expect(Number(walPayload.runId)).toBe(queuedIds[0]);
  });

  test('does not promote when active queue runs meet queue_max_concurrent', async () => {
    seedSpec('advance-full');
    await seedRun({ status: 'running', triggeredVia: 'queue' });
    await seedRun({
      status: 'queued',
      specPath: 'forge/specs/approved/advance-full.json',
      queuePosition: 1,
      triggeredVia: 'queue',
    });
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 201 }));

    const { advanceQueue } = require('../../lib/run-queue');
    await advanceQueue(workspaceId);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('counts pi-native queue work as active capacity', async () => {
    seedSpec('advance-pi-native-full');
    await seedRun({ status: 'pi_native', triggeredVia: 'queue' });
    await seedRun({
      status: 'queued',
      specPath: 'forge/specs/approved/advance-pi-native-full.json',
      queuePosition: 1,
      triggeredVia: 'queue',
    });
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 201 }));

    const { advanceQueue } = require('../../lib/run-queue');
    await advanceQueue(workspaceId);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('does not let an expired starting claim block the next queued dispatch', async () => {
    seedSpec('advance-stale-starting');
    const staleRunId = await seedRun({ status: 'starting', triggeredVia: 'queue' });
    await execute(
      `UPDATE pipeline_runs SET dispatch_lease_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`,
      [staleRunId],
    );
    const queuedId = await seedRun({
      status: 'queued',
      specPath: 'forge/specs/approved/advance-stale-starting.json',
      queuePosition: 1,
      triggeredVia: 'queue',
    });
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ ok: true, runId: queuedId }),
      { status: 201 },
    ));

    const { advanceQueue } = require('../../lib/run-queue');
    await advanceQueue(workspaceId);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('promotes when queue_max_concurrent is increased to 2', async () => {
    seedSpec('advance-multi');
    await execute(`UPDATE worker_settings SET value = '2' WHERE key = 'queue_max_concurrent'`);
    await seedRun({ status: 'running', triggeredVia: 'queue' });
    const queuedId = await seedRun({
      status: 'queued',
      specPath: 'forge/specs/approved/advance-multi.json',
      queuePosition: 1,
      triggeredVia: 'queue',
    });
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ ok: true, runId: queuedId }),
      { status: 201 },
    ));

    const { advanceQueue } = require('../../lib/run-queue');
    await advanceQueue(workspaceId);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('does not promote when no queued runs exist', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 201 }));
    const { advanceQueue } = require('../../lib/run-queue');

    await advanceQueue(workspaceId);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('concurrent promoters acquire exactly one publication owner', async () => {
    seedSpec('advance-concurrent');
    const queuedId = await seedRun({
      status: 'queued',
      specPath: 'forge/specs/approved/advance-concurrent.json',
      queuePosition: 1,
      triggeredVia: 'queue',
    });
    let releaseFetch!: () => void;
    const fetchBarrier = new Promise<void>((resolve) => { releaseFetch = resolve; });
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async () => {
      await fetchBarrier;
      return new Response(JSON.stringify({ ok: true, runId: queuedId }), { status: 201 });
    });

    const { advanceQueue } = require('../../lib/run-queue');
    const promotions = [advanceQueue(workspaceId), advanceQueue(workspaceId)];
    await new Promise((resolve) => setTimeout(resolve, 100));
    releaseFetch();
    await Promise.all(promotions);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('passes frozen auto_worktree from the queued application row', async () => {
    seedSpec('advance-wt');
    const queuedId = await seedRun({
      status: 'queued',
      specPath: 'forge/specs/approved/advance-wt.json',
      queuePosition: 1,
      triggeredVia: 'queue',
      autoWorktree: true,
    });
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ ok: true, runId: queuedId }),
      { status: 201 },
    ));

    const { advanceQueue } = require('../../lib/run-queue');
    await advanceQueue(workspaceId);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.autoWorktree).toBe(true);
    expect(Number(body.queuedRunId)).toBe(queuedId);
  });
});
