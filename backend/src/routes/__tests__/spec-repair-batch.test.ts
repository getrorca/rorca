/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * PSE-006: Tests for workspace-scope repair candidate discovery and batch repair
 *
 * Tests cover:
 *   GET /api/specs/repair-candidates:
 *   (1) 400 when workspaceId is missing
 *   (2) 404 when workspace does not exist
 *   (3) Returns empty candidates when no specs need repair
 *   (4) Discovers specs with missing generation logs
 *   (5) Discovers specs with failed enrichment
 *   (6) Discovers specs with stuck pending enrichment
 *   (7) Discovers specs with missing context summary
 *   (8) Filters by category parameter
 *
 *   POST /api/specs/repair-batch:
 *   (9) 400 when workspaceId is missing
 *   (10) 400 when categories is missing or empty
 *   (11) Dry run reports what would be repaired
 *   (12) Batch repair seeds missing generation logs
 *   (13) Batch repair re-enqueues failed enrichment
 *   (14) Blocked specs with active pipeline runs are reported
 *   (15) Limit parameter bounds the batch size
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Server } from 'node:http';
import request from 'supertest';
import { getAuthToken } from './helpers/auth-helper';
import { query, queryOne, execute } from '../../db/index';
import { SpecReadinessReasonCode } from '../../reason-codes';

// Mock llm-client before any imports that use it
jest.mock('../../lib/llm-client', () => ({
  chatComplete: jest.fn(),
  getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
  isValidModel: jest.fn().mockReturnValue(true),
  resolveVaultProvider: jest.fn().mockReturnValue(null),
  getModelInfo: jest.fn().mockReturnValue(undefined),
  DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
  SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
  ALL_MODELS: ['claude-sonnet-4-5-20250929'],
}));

jest.mock('../../lib/pi-spec-drafter', () => ({
  draftSpecWithPi: jest.fn(),
}));

jest.mock('../../lib/codex-spec-drafter', () => ({
  draftSpecWithCodex: jest.fn(),
}));

jest.mock('../../lib/pg-boss', () => {
  let callCount = 0;
  const send = jest.fn().mockImplementation(() => {
    callCount++;
    return Promise.resolve(`33333333-3333-4333-8333-${String(callCount).padStart(12, '0')}`);
  });
  return {
    initBoss: jest.fn().mockResolvedValue(undefined),
    getBoss: jest.fn(() => ({ send })),
    __resetCallCount: () => { callCount = 0; },
  };
});

let app: Server;
let mockBossSend: jest.Mock;
let authToken: string;

const WORKSPACE_ID = 'ws-repair-batch-test';

function specsDir(workspacePath: string) {
  return {
    pendingDir: path.join(workspacePath, 'forge', 'specs', 'pending'),
    approvedDir: path.join(workspacePath, 'forge', 'specs', 'approved'),
  };
}

function writeSpecFile(workspacePath: string, specId: string, content: Record<string, unknown> = {}) {
  const { pendingDir } = specsDir(workspacePath);
  fs.mkdirSync(pendingDir, { recursive: true });
  const specContent = {
    title: content.title ?? `Test Spec ${specId}`,
    userStories: content.userStories ?? [
      { id: 'US-001', title: 'Story 1', description: 'Test story', acceptanceCriteria: ['AC1'], dependsOn: [] },
    ],
    model: content.model ?? 'claude-sonnet-4-5-20250929',
    source: content.source ?? 'test',
    ...content,
  };
  fs.writeFileSync(path.join(pendingDir, `${specId}.json`), JSON.stringify(specContent, null, 2));
}

async function seedGenerationLog(specId: string, options: {
  withPostSaveStages?: boolean;
  withContextCaptureStatus?: boolean;
  enrichStatus?: string;
  enrichReason?: string;
  matchSkillsStatus?: string;
  matchSkillsReason?: string;
  workspaceId?: string;
} = {}) {
  const enrichStatus = options.enrichStatus ?? 'completed';
  const matchSkillsStatus = options.matchSkillsStatus ?? 'completed';

  const postSaveStages = options.withPostSaveStages !== false ? {
    enrich: {
      requested: true,
      status: enrichStatus,
      reason: options.enrichReason ?? (enrichStatus === 'failed' ? 'job_failed' : enrichStatus === 'pending' ? 'requested_by_caller' : 'job_completed'),
    },
    matchSkills: {
      requested: true,
      status: matchSkillsStatus,
      reason: options.matchSkillsReason ?? (matchSkillsStatus === 'failed' ? 'job_failed' : matchSkillsStatus === 'skipped' ? 'no_installed_skills' : 'job_completed'),
    },
    memorySynthesis: {
      requested: false,
      status: 'skipped',
      reason: 'disabled_by_caller',
    },
  } : undefined;

  const contextCaptureStatus = options.withContextCaptureStatus !== false ? {
    status: 'provided',
    reason: 'caller_supplied_context',
    contextUsed: 'provided',
    contextSummary: 'provided',
  } : undefined;

  const summaryJson: Record<string, unknown> = {
    source: 'test',
    workspaceId: options.workspaceId ?? WORKSPACE_ID,
    title: `Test Spec ${specId}`,
    storyCount: 1,
    postSave: { enrich: true, matchSkills: true, memorySynthesis: false },
    ...(postSaveStages ? { postSaveStages } : {}),
    ...(contextCaptureStatus ? { contextCaptureStatus } : {}),
  };

  await execute(
    `INSERT INTO spec_generation_logs (spec_slug, model, provider, duration_ms, context_summary, enriched, retrieval_method, context_summary_json, status)
     VALUES ($1, 'claude-sonnet-4-5-20250929', 'api', 0, 'test', false, 'none', $2, 'persisted')`,
    [specId, JSON.stringify(summaryJson)],
  );
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  const serverMod = require('../../server');
  const expressApp = serverMod.default;
  authToken = await getAuthToken(expressApp);
  app = expressApp.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    app.once('listening', resolve);
    app.once('error', reject);
  });
  const pgBoss = require('../../lib/pg-boss');
  mockBossSend = pgBoss.getBoss().send;
});

beforeEach(async () => {
  jest.clearAllMocks();
  const pgBossMod = require('../../lib/pg-boss');
  pgBossMod.__resetCallCount();
  mockBossSend = pgBossMod.getBoss().send;
  mockBossSend.mockClear();

  const tablesToClean = [
    'story_results', 'story_commits', 'story_comments', 'pipeline_runs',
    'wal_events', 'spec_versions', 'spec_search_index', 'spec_generation_logs',
    'workspace_context', 'direction_layers', 'batch_spec_generation', 'spec_jobs',
  ];
  for (const t of tablesToClean) {
    await execute(`TRUNCATE ${t} CASCADE`).catch(() => {});
  }

  await execute(
    `INSERT INTO workspaces (id, label, path) VALUES ($1, 'Repair Batch Test WS', $2) ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path`,
    [WORKSPACE_ID, os.tmpdir()],
  );

  // Clean up spec files from prior tests
  const specsRoot = path.join(os.tmpdir(), 'forge', 'specs');
  if (fs.existsSync(specsRoot)) {
    fs.rmSync(specsRoot, { recursive: true, force: true });
  }
});

afterEach(async () => {
  const specsRoot = path.join(os.tmpdir(), 'forge', 'specs');
  if (fs.existsSync(specsRoot)) {
    fs.rmSync(specsRoot, { recursive: true, force: true });
  }
});

afterAll(async () => {
  app.closeAllConnections();
  await new Promise<void>((resolve, reject) => app.close((error) => error ? reject(error) : resolve()));
  try { const { closePool } = require('../../db/index'); await closePool(); } catch {}
  delete process.env.NODE_ENV;
});

describe('PSE-006: GET /api/specs/repair-candidates', () => {
  test('returns 400 when workspaceId is missing', async () => {
    const res = await request(app)
      .get('/api/specs/repair-candidates')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/workspaceId/i);
  });

  test('returns 404 when workspace does not exist', async () => {
    const res = await request(app)
      .get('/api/specs/repair-candidates?workspaceId=ws-nonexistent')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  test('returns empty candidates when all specs are healthy', async () => {
    writeSpecFile(os.tmpdir(), 'healthy-spec-1');
    await seedGenerationLog('healthy-spec-1', {
      enrichStatus: 'completed',
      matchSkillsStatus: 'completed',
    });

    const res = await request(app)
      .get(`/api/specs/repair-candidates?workspaceId=${WORKSPACE_ID}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.candidates).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  test('discovers specs with missing generation logs', async () => {
    writeSpecFile(os.tmpdir(), 'no-log-spec-1');
    writeSpecFile(os.tmpdir(), 'no-log-spec-2');
    // No generation logs seeded — these are filesystem-only specs

    const res = await request(app)
      .get(`/api/specs/repair-candidates?workspaceId=${WORKSPACE_ID}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(2);
    const noLogCandidates = res.body.candidates.filter(
      (c: { issues: string[] }) => c.issues.includes(SpecReadinessReasonCode.MissingContext),
    );
    expect(noLogCandidates.length).toBeGreaterThanOrEqual(2);
  });

  test('discovers specs with failed enrichment', async () => {
    writeSpecFile(os.tmpdir(), 'failed-enrich-spec');
    await seedGenerationLog('failed-enrich-spec', {
      enrichStatus: 'failed',
      matchSkillsStatus: 'failed',
    });

    const res = await request(app)
      .get(`/api/specs/repair-candidates?workspaceId=${WORKSPACE_ID}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    const failedCandidate = res.body.candidates.find(
      (c: { specId: string }) => c.specId === 'failed-enrich-spec',
    );
    expect(failedCandidate).toBeDefined();
    expect(failedCandidate.issues).toContain(SpecReadinessReasonCode.StageFailed);
  });

  test('discovers specs with stuck pending enrichment', async () => {
    writeSpecFile(os.tmpdir(), 'stuck-spec');
    await seedGenerationLog('stuck-spec', {
      enrichStatus: 'pending',
      enrichReason: 'requested_by_caller',
      matchSkillsStatus: 'pending',
      matchSkillsReason: 'waiting_for_enrich',
    });

    const res = await request(app)
      .get(`/api/specs/repair-candidates?workspaceId=${WORKSPACE_ID}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    const stuckCandidate = res.body.candidates.find(
      (c: { specId: string }) => c.specId === 'stuck-spec',
    );
    expect(stuckCandidate).toBeDefined();
    expect(stuckCandidate.issues).toContain(SpecReadinessReasonCode.PostSavePending);
  });

  test('discovers specs with missing context summary', async () => {
    writeSpecFile(os.tmpdir(), 'no-ctx-spec');
    await seedGenerationLog('no-ctx-spec', {
      withContextCaptureStatus: false,
      enrichStatus: 'completed',
      matchSkillsStatus: 'completed',
    });

    const res = await request(app)
      .get(`/api/specs/repair-candidates?workspaceId=${WORKSPACE_ID}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    const noCtxCandidate = res.body.candidates.find(
      (c: { specId: string }) => c.specId === 'no-ctx-spec',
    );
    expect(noCtxCandidate).toBeDefined();
    expect(noCtxCandidate.issues).toContain(SpecReadinessReasonCode.MissingContext);
  });

  test('filters by category parameter', async () => {
    writeSpecFile(os.tmpdir(), 'failed-spec');
    await seedGenerationLog('failed-spec', {
      enrichStatus: 'failed',
      matchSkillsStatus: 'completed',
    });

    writeSpecFile(os.tmpdir(), 'no-ctx-spec-filter');
    await seedGenerationLog('no-ctx-spec-filter', {
      withContextCaptureStatus: false,
      enrichStatus: 'completed',
      matchSkillsStatus: 'completed',
    });

    // Only request stage_failed category
    const res = await request(app)
      .get(`/api/specs/repair-candidates?workspaceId=${WORKSPACE_ID}&category=${SpecReadinessReasonCode.StageFailed}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    // Should include failed-spec but not no-ctx-spec-filter
    const failedCandidate = res.body.candidates.find(
      (c: { specId: string }) => c.specId === 'failed-spec',
    );
    expect(failedCandidate).toBeDefined();

    const ctxCandidate = res.body.candidates.find(
      (c: { specId: string }) => c.specId === 'no-ctx-spec-filter',
    );
    expect(ctxCandidate).toBeUndefined();
  });

  test('returns 400 for invalid category', async () => {
    const res = await request(app)
      .get(`/api/specs/repair-candidates?workspaceId=${WORKSPACE_ID}&category=invalid_category`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid category/i);
  });
});

describe('PSE-006: POST /api/specs/repair-batch', () => {
  test('returns 400 when workspaceId is missing', async () => {
    const res = await request(app)
      .post('/api/specs/repair-batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ categories: [SpecReadinessReasonCode.StageFailed] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/workspaceId/i);
  });

  test('returns 400 when categories is missing', async () => {
    const res = await request(app)
      .post('/api/specs/repair-batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: WORKSPACE_ID });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/categories/i);
  });

  test('returns 400 when categories is empty', async () => {
    const res = await request(app)
      .post('/api/specs/repair-batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: WORKSPACE_ID, categories: [] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/categories/i);
  });

  test('dryRun reports what would be repaired without modifying state', async () => {
    writeSpecFile(os.tmpdir(), 'dry-batch-spec');
    await seedGenerationLog('dry-batch-spec', {
      enrichStatus: 'failed',
      matchSkillsStatus: 'failed',
    });

    const res = await request(app)
      .post('/api/specs/repair-batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: WORKSPACE_ID,
        categories: [SpecReadinessReasonCode.StageFailed],
        dryRun: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.skipped).toBeGreaterThanOrEqual(1);
    expect(res.body.details.some(
      (d: { specId: string; status: string; repairStatus: string }) => d.specId === 'dry-batch-spec' && d.status === 'skipped' && d.repairStatus === 'dry_run',
    )).toBe(true);

    // Verify no actual repair was done — no new spec_jobs created
    const jobs = await query<{ id: string }>(
      `SELECT id FROM spec_jobs WHERE spec_id = 'dry-batch-spec' AND workspace_id = $1`,
      [WORKSPACE_ID],
    );
    expect(jobs.length).toBe(0);
  });

  test('batch repair seeds missing generation logs', async () => {
    writeSpecFile(os.tmpdir(), 'batch-no-log-spec');
    // No generation log — filesystem-only spec

    const res = await request(app)
      .post('/api/specs/repair-batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: WORKSPACE_ID,
        categories: [SpecReadinessReasonCode.MissingContext],
      });

    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);

    // Verify generation log was created
    const log = await queryOne<{ spec_slug: string; context_summary_json: unknown }>(
      'SELECT spec_slug, context_summary_json FROM spec_generation_logs WHERE spec_slug = $1',
      ['batch-no-log-spec'],
    );
    expect(log).toBeDefined();
    expect(log!.spec_slug).toBe('batch-no-log-spec');
  });

  test('batch repair re-enqueues failed enrichment', async () => {
    writeSpecFile(os.tmpdir(), 'batch-failed-spec');
    await seedGenerationLog('batch-failed-spec', {
      enrichStatus: 'failed',
      matchSkillsStatus: 'completed',
    });

    const res = await request(app)
      .post('/api/specs/repair-batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: WORKSPACE_ID,
        categories: [SpecReadinessReasonCode.StageFailed],
      });

    expect(res.status).toBe(200);
    expect(res.body.queued).toBeGreaterThanOrEqual(1);

    const detail = res.body.details.find(
      (d: { specId: string }) => d.specId === 'batch-failed-spec',
    );
    expect(detail).toBeDefined();
    expect(detail.status).toBe('queued');
    expect(detail.reason).toMatch(/Re-enqueued enrich repair/);
  });

  test('blocked specs with active pipeline runs are reported', async () => {
    writeSpecFile(os.tmpdir(), 'blocked-batch-spec');
    await seedGenerationLog('blocked-batch-spec', {
      enrichStatus: 'failed',
      matchSkillsStatus: 'failed',
    });

    await execute(
      `INSERT INTO pipeline_runs (workspace_id, spec_path, status) VALUES ($1, $2, 'running')`,
      [WORKSPACE_ID, 'forge/specs/pending/blocked-batch-spec.json'],
    );

    const res = await request(app)
      .post('/api/specs/repair-batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: WORKSPACE_ID,
        categories: [SpecReadinessReasonCode.StageFailed],
      });

    expect(res.status).toBe(200);
    expect(res.body.blocked).toBeGreaterThanOrEqual(1);

    const blockedDetail = res.body.details.find(
      (d: { specId: string }) => d.specId === 'blocked-batch-spec',
    );
    expect(blockedDetail).toBeDefined();
    expect(blockedDetail.status).toBe('blocked');
    expect(blockedDetail.reason).toMatch(/active pipeline run/i);
  });

  test('limit parameter bounds the batch size', async () => {
    // Create 5 specs with failed enrichment
    for (let i = 1; i <= 5; i++) {
      writeSpecFile(os.tmpdir(), `limit-spec-${i}`);
      await seedGenerationLog(`limit-spec-${i}`, {
        enrichStatus: 'failed',
        matchSkillsStatus: 'failed',
      });
    }

    const res = await request(app)
      .post('/api/specs/repair-batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: WORKSPACE_ID,
        categories: [SpecReadinessReasonCode.StageFailed],
        limit: 2,
      });

    expect(res.status).toBe(200);
    // total reflects discovery (capped at limit), details reflects processed
    expect(res.body.details.length).toBeLessThanOrEqual(2);
    expect(res.body.total).toBeLessThanOrEqual(2);
  });

  test('emits WAL event on successful batch repair', async () => {
    writeSpecFile(os.tmpdir(), 'wal-batch-spec');
    await seedGenerationLog('wal-batch-spec', {
      enrichStatus: 'failed',
      matchSkillsStatus: 'completed',
    });

    const res = await request(app)
      .post('/api/specs/repair-batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: WORKSPACE_ID,
        categories: [SpecReadinessReasonCode.StageFailed],
      });

    expect(res.status).toBe(200);
    expect(res.body.queued).toBeGreaterThanOrEqual(1);

    // Verify WAL event was emitted
    const walEvent = await queryOne<{ event_type: string; payload: unknown }>(
      `SELECT event_type, payload FROM wal_events WHERE event_type = 'specs_repair_batch' AND workspace_id = $1`,
      [WORKSPACE_ID],
    );
    expect(walEvent).toBeDefined();
    expect(walEvent!.event_type).toBe('specs_repair_batch');
  });
});
