/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import request from 'supertest';
import { getAuthToken } from './helpers/auth-helper';
import { query, queryOne, execute } from '../../db/index';

const mockBossSend = jest.fn();
jest.mock('../../lib/pg-boss', () => ({
  initBoss: jest.fn().mockResolvedValue(undefined),
  ensureQueues: jest.fn().mockResolvedValue(undefined),
  getBoss: () => ({ createQueue: jest.fn().mockResolvedValue(undefined), send: mockBossSend }),
}));

let app: Express;
let tmpDir: string;
let authToken: string;
let fixtureWorkspaceId: string;
let fixtureSequence = 0;

beforeEach(async () => {
  mockBossSend.mockReset().mockImplementation(async () => randomUUID());
  fixtureWorkspaceId = `ws-retry-${Date.now()}-${++fixtureSequence}`;
  jest.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-retry-test-'));
  const _dbPath = path.join(tmpDir, 'test.db');
process.env.NODE_ENV = 'test';
  const serverMod = require('../../server');
  app = serverMod.default;
authToken = await getAuthToken(app);
});

afterEach(async () => {
  // Close the fresh pool created by jest.resetModules() + require('../../server') to prevent connection exhaustion
  try { const { closePool } = require('../../db/index'); await closePool(); } catch {}
fs.rmSync(tmpDir, { recursive: true, force: true });
delete process.env.NODE_ENV;
});

async function createWorkspace(id = fixtureWorkspaceId) {
  // Create the canonical workspace-relative approved spec used by retry reconciliation.
  const specDir = path.join(tmpDir, 'forge', 'specs', 'approved');
  fs.mkdirSync(specDir, { recursive: true });

  // Create a spec file
  const spec = {
    title: 'test-spec',
    userStories: [
      { id: 'US-001', title: 'Story 1', description: 'First', acceptanceCriteria: [], dependsOn: [], passes: false },
      { id: 'US-002', title: 'Story 2', description: 'Second', acceptanceCriteria: [], dependsOn: [], passes: false },
      { id: 'US-003', title: 'Story 3', description: 'Third', acceptanceCriteria: [], dependsOn: [], passes: false },
    ],
  };
  fs.writeFileSync(path.join(specDir, 'test-spec.json'), JSON.stringify(spec));
  execFileSync('git', ['init', '--quiet'], { cwd: tmpDir });
  execFileSync('git', ['config', 'user.email', 'retry-test@rorca.local'], { cwd: tmpDir });
  execFileSync('git', ['config', 'user.name', 'Rorca Retry Test'], { cwd: tmpDir });
  execFileSync('git', ['add', 'forge/specs/approved/test-spec.json'], { cwd: tmpDir });
  execFileSync('git', ['commit', '--quiet', '-m', 'retry fixture'], { cwd: tmpDir });

  await execute(`INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path`, [id, 'Retry Test Workspace', tmpDir]);
}

function payload(value: unknown): Record<string, unknown> {
  return typeof value === 'string' ? JSON.parse(value) : value as Record<string, unknown>;
}

async function dispatchRetry(runId: number, body: Record<string, unknown> = {}) {
  const preview = await request(app)
    .post(`/api/pipeline/runs/${runId}/retry`)
    .set('Authorization', `Bearer ${authToken}`)
    .send({ ...body, safeMode: true });
  if (preview.status !== 200 || !preview.body.preview) return preview;
  return request(app)
    .post(`/api/pipeline/runs/${runId}/retry`)
    .set('Authorization', `Bearer ${authToken}`)
    .set('Idempotency-Key', `retry-test-${runId}-${fixtureSequence}`)
    .send({
      ...body,
      safeMode: true,
      previewHash: preview.body.preview.previewHash,
      approvedPreview: preview.body.preview,
      previewIdentity: preview.body.previewIdentity,
    });
}

async function createRunWithStories(workspaceId = fixtureWorkspaceId) {
  const result = await queryOne<{ id: number }>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status, finished_at) VALUES ($1, $2, 'failed', NOW()) RETURNING id`, ['forge/specs/approved/test-spec.json', workspaceId]);
  const runId = result!.id;

  // US-001 passed, US-002 failed, US-003 failed
  await execute(`INSERT INTO story_results (run_id, story_id, status, retries, finished_at) VALUES ($1, 'US-001', 'pass', 0, NOW())`, [runId]);
  await execute(`INSERT INTO story_results (run_id, story_id, status, retries, finished_at) VALUES ($1, 'US-002', 'fail', 0, NOW())`, [runId]);
  await execute(`INSERT INTO story_results (run_id, story_id, status, retries, finished_at) VALUES ($1, 'US-003', 'fail', 0, NOW())`, [runId]);

  return runId;
}

// ─── Test 1: Retry all failed stories creates new run ──────────────────────────

test('POST /api/pipeline/runs/:runId/retry creates new run and retries all failed stories when storyIds omitted', async () => {
  await createWorkspace();
  const originalRunId = await createRunWithStories();

  const res = await dispatchRetry(originalRunId);

  expect(res.status).toBe(201);
  expect(res.body.ok).toBe(true);
  expect(res.body.originalRunId).toBe(Number(originalRunId));
  expect(res.body.runId).not.toBe(originalRunId); // New run created
  expect(res.body.retriedStories).toHaveLength(2);
  expect(res.body.retriedStories.map((s: any) => s.storyId).sort()).toEqual(['US-002', 'US-003']);
  expect(res.body.retriedStories[0].attempt).toBe(1);
  expect(res.body.copiedStories).toEqual([]); // Passed evidence is not projected into the retry run
  expect(res.body.effectiveOptions).toMatchObject({
    merge: { strategy: 'branch-only', autoMerge: false },
    safety: { deploy: false, externalSend: false, allowBackendJest: false },
  });

  // Dispatch persists the new run as queued; only the canonical worker may
  // transition it to running after validating the approved preview/job.
  const newRun = await queryOne(`SELECT * FROM pipeline_runs WHERE id = $1`, [res.body.runId]) as any;
  expect(newRun.status).toBe('queued');
  expect(newRun.retried_from_run_id).toBe(originalRunId);

  // Original run stays as 'failed'
  const originalRun = await queryOne(`SELECT * FROM pipeline_runs WHERE id = $1`, [originalRunId]) as any;
  expect(originalRun.status).toBe('failed');
});

test('TaskManifest retry preview uses failed application truth without importing approved-spec pass authority', async () => {
  await createWorkspace();
  const manifestId = randomUUID();
  const syntheticPath = `forge/task-manifests/${manifestId}/hermes-task-manifest-${manifestId}.json`;
  const absolute = path.join(tmpDir, syntheticPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, JSON.stringify({
    title: 'Synthetic task manifest',
    userStories: [{ id: 'TM-001', title: 'Manifest task', description: 'Execute bounded work', acceptanceCriteria: [], dependsOn: [], passes: false }],
  }));
  const run = await queryOne<{ id: number }>(`
    INSERT INTO pipeline_runs (spec_path, workspace_id, status, finished_at, task_manifest_id)
    VALUES ($1, $2, 'failed', NOW(), $3) RETURNING id
  `, [syntheticPath, fixtureWorkspaceId, manifestId]);
  await execute(`INSERT INTO story_results (run_id, story_id, status, retries, finished_at)
    VALUES ($1, 'TM-001', 'fail', 0, NOW())`, [run!.id]);

  const preview = await request(app)
    .post(`/api/pipeline/runs/${run!.id}/retry`)
    .set('Authorization', `Bearer ${authToken}`)
    .send({ storyIds: ['TM-001'], safeMode: true, forceSequential: true });

  expect(preview.status).toBe(200);
  expect(preview.body.preview).toEqual(expect.objectContaining({
    originalRunId: Number(run!.id),
    requiresApproval: false,
    scope: expect.objectContaining({
      executable: [{ storyId: 'TM-001', reasonCode: 'EXECUTABLE_RETRY_WORK' }],
      copiedPassed: [],
    }),
  }));
  expect(preview.body.passReconciliation).toEqual(expect.objectContaining({
    specRevision: `task-manifest:${manifestId}`,
    stories: [],
    blocking: false,
  }));
  expect(mockBossSend).not.toHaveBeenCalled();
});

// ─── Test 2: Retry specific stories via storyIds ─────────────────────────────

test('POST /api/pipeline/runs/:runId/retry retries only specified storyIds', async () => {
  await createWorkspace();
  const originalRunId = await createRunWithStories();

  const res = await dispatchRetry(originalRunId, { storyIds: ['US-002'] });

  expect(res.status).toBe(201);
  expect(res.body.retriedStories).toHaveLength(1);
  expect(res.body.retriedStories[0].storyId).toBe('US-002');
  expect(res.body.retriedStories[0].attempt).toBe(1);
});

// ─── Test 3: New run gets copied pass results + retry placeholders ────────────

test('Retry records only executable placeholders and does not project copied pass rows', async () => {
  await createWorkspace();
  const originalRunId = await createRunWithStories();

  const res = await dispatchRetry(originalRunId, { storyIds: ['US-002'] });

  const newRunId = res.body.runId;

  // Passed evidence cannot become an executable/copy-authority row.
  const newStories = await query(`SELECT * FROM story_results WHERE run_id = $1 ORDER BY story_id ASC`, [newRunId]) as any[];

  expect(res.body.copiedStories).toEqual([]);
  expect(newStories).toHaveLength(1);

  const us002 = newStories.find((s: any) => s.story_id === 'US-002');
  expect(us002.status).toBe('retry');
  expect(us002.retries).toBe(1);
});

// ─── Test 4: Original run's story results are untouched ─────────────────────

test('Original run story_result rows are preserved unchanged', async () => {
  await createWorkspace();
  const originalRunId = await createRunWithStories();

  const beforeStories = await query(`SELECT * FROM story_results WHERE run_id = $1`, [originalRunId]) as any[];
  expect(beforeStories).toHaveLength(3);

  await request(app)
    .post(`/api/pipeline/runs/${originalRunId}/retry`)
    .set('Authorization', `Bearer ${authToken}`)
    .send({});

  // Original run should still have exactly 3 stories, unchanged
  const afterStories = await query(`SELECT * FROM story_results WHERE run_id = $1`, [originalRunId]) as any[];
  expect(afterStories).toHaveLength(3);

  const originals = afterStories.filter((s: any) => s.retries === 0);
  expect(originals).toHaveLength(3);
});

// ─── Test 5: story_retried WAL events emitted with new run ID ────────────────

test('Retry emits story_retried WAL events referencing the new run', async () => {
  await createWorkspace();
  const originalRunId = await createRunWithStories();

  const res = await dispatchRetry(originalRunId);

  const newRunId = res.body.runId;

  const events = await query(`SELECT * FROM wal_events WHERE event_type = 'story_retried' AND workspace_id = $1`, [fixtureWorkspaceId]) as any[];

  expect(events).toHaveLength(2);

  const payloads = events.map((e: any) => payload(e.payload));
  expect(payloads[0].run_id).toBe(newRunId);
  expect(payloads[0].original_run_id).toBe(Number(originalRunId));
  expect(payloads[0].attempt).toBe(1);
  expect(payloads.map((p: any) => p.story_id).sort()).toEqual(['US-002', 'US-003']);
});

// ─── Test 6: Cannot retry a running run ──────────────────────────────────────

test('POST /api/pipeline/runs/:runId/retry returns 409 for running run', async () => {
  await createWorkspace();
  const result = await queryOne<{ id: number }>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status) VALUES ($1, $2, 'running') RETURNING id`, ['forge/specs/approved/test-spec.json', fixtureWorkspaceId]);
  const runId = result!.id;

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
  await createWorkspace();
  const result = await queryOne<{ id: number }>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status, finished_at) VALUES ($1, $2, 'done', NOW()) RETURNING id`, ['forge/specs/approved/test-spec.json', fixtureWorkspaceId]);
  const runId = result!.id;

  // All stories passed
  await execute(`INSERT INTO story_results (run_id, story_id, status, retries) VALUES ($1, 'US-001', 'pass', 0)`, [runId]);

  const res = await request(app)
    .post(`/api/pipeline/runs/${runId}/retry`)
    .set('Authorization', `Bearer ${authToken}`)
    .send({});

  expect(res.status).toBe(422);
  expect(res.body.error).toContain('No failed stories');
});

// ─── Test 9: Returns 422 when specified storyIds don't match failed stories ──

test('POST /api/pipeline/runs/:runId/retry returns 422 when storyIds do not match any failed stories', async () => {
  await createWorkspace();
  const runId = await createRunWithStories();

  const res = await request(app)
    .post(`/api/pipeline/runs/${runId}/retry`)
    .set('Authorization', `Bearer ${authToken}`)
    .send({ storyIds: ['US-001'] }); // US-001 passed, not failed

  expect(res.status).toBe(422);
  expect(res.body.error).toContain('None of the specified storyIds');
});

// ─── Test 10: SSE stream broadcasts story_retried events ─────────────────────

test('story_retried events are broadcast to SSE subscribers', async () => {
  await createWorkspace();
  const originalRunId = await createRunWithStories();

  const sseHub = require('../../lib/sse-hub');
  const received: any[] = [];
  const unsubscribe = sseHub.subscribe((event: any) => {
    received.push(event);
  });

  const res = await dispatchRetry(originalRunId, { storyIds: ['US-002'] });

  const newRunId = res.body.runId;

  const retryEvents = received.filter((e: any) => e.event_type === 'story_retried');
  expect(retryEvents).toHaveLength(1);
  expect(retryEvents[0].story_id).toBe('US-002');

  const eventPayload = payload(retryEvents[0].payload);
  expect(eventPayload.attempt).toBe(1);
  expect(eventPayload.run_id).toBe(newRunId);

  unsubscribe();
});

// ─── Test 11: partial_failure status in pipeline_runs ────────────────────────

test('partial_failure status is accepted in pipeline_runs table', async () => {
  await createWorkspace();
  const result = await queryOne<{ id: number }>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status) VALUES ($1, $2, 'partial_failure') RETURNING id`, ['forge/specs/approved/test-spec.json', fixtureWorkspaceId]);

  const run = await queryOne(`SELECT * FROM pipeline_runs WHERE id = $1`, [result!.id]) as any;
  expect(run.status).toBe('partial_failure');
});

// ─── Test 12: Retry uses same spec_path and direction as original ─────────────

test('New retry run uses the same spec_path as the original run', async () => {
  await createWorkspace();
  const originalRunId = await createRunWithStories();

  const res = await dispatchRetry(originalRunId);

  const newRunId = res.body.runId;
  const originalRun = await queryOne(`SELECT * FROM pipeline_runs WHERE id = $1`, [originalRunId]) as any;
  const newRun = await queryOne(`SELECT * FROM pipeline_runs WHERE id = $1`, [newRunId]) as any;

  expect(newRun.spec_path).toBe(originalRun.spec_path);
  expect(newRun.workspace_id).toBe(originalRun.workspace_id);
  expect(newRun.retried_from_run_id).toBe(originalRunId);
  expect(newRun.trigger_type).toBe('retry');
});

// ─── Test 13: run_started WAL event emitted for new retry run ─────────────────

test('retry dispatch emits canonical lifecycle invalidation for the new run', async () => {
  await createWorkspace();
  const originalRunId = await createRunWithStories();

  const res = await dispatchRetry(originalRunId);

  const newRunId = res.body.runId;

  const events = await query(`SELECT * FROM wal_events WHERE event_type = 'lifecycle_changed' AND workspace_id = $1`, [fixtureWorkspaceId]) as any[];

  const retryEvent = events.find((event: any) => {
    const value = payload(event.payload);
    return value.changeKind === 'retry_dispatched' && value.runId === newRunId;
  });
  expect(retryEvent).toBeDefined();
});
