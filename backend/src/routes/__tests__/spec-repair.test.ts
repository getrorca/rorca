/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * PSE-005: Tests for POST /api/specs/:specId/repair
 *
 * Tests cover:
 *   (1) 404 when spec file does not exist
 *   (2) 404 when workspace does not exist
 *   (3) 400 when workspaceId is missing
 *   (4) 409 when spec has an active pipeline run
 *   (5) Healthy spec returns all-skipped actions
 *   (6) Missing generation log is seeded
 *   (7) Failed enrich stage is re-enqueued
 *   (8) Failed match-skills stage is re-enqueued
 *   (9) dryRun mode diagnoses without modifying state
 *   (10) Idempotency — repair on already-healthy spec is no-op
 *   (11) Active enrich job blocks re-enqueue
 *   (12) Selective stage repair via stages param
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import request from 'supertest';
import { getAuthToken } from './helpers/auth-helper';
import { queryOne, execute } from '../../db/index';

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
    // Return unique UUID on each call to avoid unique constraint violations on boss_job_id
    return Promise.resolve(`22222222-2222-4222-8222-${String(callCount).padStart(12, '0')}`);
  });
  return {
    initBoss: jest.fn().mockResolvedValue(undefined),
    getBoss: jest.fn(() => ({ send })),
    __resetCallCount: () => { callCount = 0; },
  };
});

let app: Express;
let mockBossSend: jest.Mock;
let authToken: string;

const WORKSPACE_ID = 'ws-repair-test';

function specsDirs(workspacePath: string) {
  return {
    pendingDir: path.join(workspacePath, 'forge', 'specs', 'pending'),
    approvedDir: path.join(workspacePath, 'forge', 'specs', 'approved'),
  };
}

function writeSpecFile(workspacePath: string, specId: string, content: Record<string, unknown> = {}) {
  const { pendingDir } = specsDirs(workspacePath);
  fs.mkdirSync(pendingDir, { recursive: true });
  const specContent = {
    title: content.title ?? 'Test Spec',
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
  matchSkillsStatus?: string;
  workspaceId?: string;
} = {}) {
  const postSaveStages = options.withPostSaveStages !== false ? {
    enrich: {
      requested: true,
      status: options.enrichStatus ?? 'completed',
      reason: options.enrichStatus === 'failed' ? 'job_failed' : 'job_completed',
    },
    matchSkills: {
      requested: true,
      status: options.matchSkillsStatus ?? 'completed',
      reason: options.matchSkillsStatus === 'failed' ? 'job_failed' : 'job_completed',
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
    title: 'Test Spec',
    storyCount: 1,
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
  app = serverMod.default;
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
    `INSERT INTO workspaces (id, label, path) VALUES ($1, 'Repair Test WS', $2) ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path`,
    [WORKSPACE_ID, os.tmpdir()],
  );

  // Clean up spec files from prior tests
  const specsRoot = path.join(os.tmpdir(), 'forge', 'specs');
  if (fs.existsSync(specsRoot)) {
    fs.rmSync(specsRoot, { recursive: true, force: true });
  }

  authToken = await getAuthToken(app);
});

afterEach(async () => {
  const specsRoot = path.join(os.tmpdir(), 'forge', 'specs');
  if (fs.existsSync(specsRoot)) {
    fs.rmSync(specsRoot, { recursive: true, force: true });
  }
});

describe('PSE-005: POST /api/specs/:specId/repair', () => {
  test('returns 400 when workspaceId is missing', async () => {
    const res = await request(app)
      .post('/api/specs/test-spec/repair')
      .set('Authorization', `Bearer ${authToken}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/workspaceId/i);
  });

  test('returns 404 when workspace does not exist', async () => {
    const res = await request(app)
      .post('/api/specs/test-spec/repair')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-nonexistent' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  test('returns 404 when spec file does not exist', async () => {
    const res = await request(app)
      .post('/api/specs/nonexistent-spec/repair')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: WORKSPACE_ID });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  test('returns 409 when spec has an active pipeline run', async () => {
    writeSpecFile(os.tmpdir(), 'blocked-spec');

    await execute(
      `INSERT INTO pipeline_runs (workspace_id, spec_path, status) VALUES ($1, $2, 'running')`,
      [WORKSPACE_ID, 'forge/specs/pending/blocked-spec.json'],
    );

    const res = await request(app)
      .post('/api/specs/blocked-spec/repair')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: WORKSPACE_ID });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/active pipeline run/i);
  });

  test('healthy spec returns all-skipped actions and healthy=true', async () => {
    writeSpecFile(os.tmpdir(), 'healthy-spec');
    await seedGenerationLog('healthy-spec', {
      enrichStatus: 'completed',
      matchSkillsStatus: 'completed',
    });

    const res = await request(app)
      .post('/api/specs/healthy-spec/repair')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: WORKSPACE_ID });

    expect(res.status).toBe(200);
    expect(res.body.healthy).toBe(true);
    expect(res.body.specId).toBe('healthy-spec');
    expect(res.body.diagnosis.missingGenerationLog).toBe(false);
    expect(res.body.diagnosis.missingContextSummary).toBe(false);
    expect(res.body.diagnosis.enrichNeedsRepair).toBe(false);
    expect(res.body.diagnosis.matchSkillsNeedsRepair).toBe(false);
    expect(res.body.actions.every((a: { status: string }) => a.status === 'skipped')).toBe(true);
  });

  test('missing generation log is seeded', async () => {
    writeSpecFile(os.tmpdir(), 'no-log-spec');
    // No generation log seeded

    const res = await request(app)
      .post('/api/specs/no-log-spec/repair')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: WORKSPACE_ID });

    expect(res.status).toBe(200);
    expect(res.body.healthy).toBe(false);
    expect(res.body.diagnosis.missingGenerationLog).toBe(true);

    const seedAction = res.body.actions.find((a: { action: string }) => a.action === 'seed_generation_log');
    expect(seedAction).toBeDefined();
    expect(seedAction.status).toBe('repaired');

    // Verify generation log was actually created in DB
    const log = await queryOne<{ spec_slug: string; context_summary_json: unknown }>(
      'SELECT spec_slug, context_summary_json FROM spec_generation_logs WHERE spec_slug = $1',
      ['no-log-spec'],
    );
    expect(log).toBeDefined();
    expect(log!.spec_slug).toBe('no-log-spec');
  });

  test('failed enrich stage is re-enqueued', async () => {
    writeSpecFile(os.tmpdir(), 'failed-enrich-spec');
    await seedGenerationLog('failed-enrich-spec', {
      enrichStatus: 'failed',
      matchSkillsStatus: 'failed',
    });

    const res = await request(app)
      .post('/api/specs/failed-enrich-spec/repair')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: WORKSPACE_ID });

    expect(res.status).toBe(200);
    expect(res.body.healthy).toBe(false);
    expect(res.body.diagnosis.enrichNeedsRepair).toBe(true);

    const enrichAction = res.body.actions.find((a: { action: string }) => a.action === 'enqueue_enrich');
    expect(enrichAction).toBeDefined();
    expect(enrichAction.status).toBe('repaired');
    expect(enrichAction.jobId).toBeDefined();
  });

  test('failed match-skills stage is re-enqueued', async () => {
    writeSpecFile(os.tmpdir(), 'failed-match-spec');
    await seedGenerationLog('failed-match-spec', {
      enrichStatus: 'completed',
      matchSkillsStatus: 'failed',
    });

    const res = await request(app)
      .post('/api/specs/failed-match-spec/repair')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: WORKSPACE_ID });

    expect(res.status).toBe(200);
    expect(res.body.healthy).toBe(false);
    expect(res.body.diagnosis.matchSkillsNeedsRepair).toBe(true);

    const matchAction = res.body.actions.find((a: { action: string }) => a.action === 'enqueue_match_skills');
    expect(matchAction).toBeDefined();
    expect(matchAction.status).toBe('repaired');
    expect(matchAction.jobId).toBeDefined();
  });

  test('dryRun diagnoses without modifying state', async () => {
    writeSpecFile(os.tmpdir(), 'dryrun-spec');
    // No generation log — should be diagnosed as missing

    const res = await request(app)
      .post('/api/specs/dryrun-spec/repair')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: WORKSPACE_ID, dryRun: true });

    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.diagnosis.missingGenerationLog).toBe(true);

    // Actions should be skipped (dryRun), not repaired
    const seedAction = res.body.actions.find((a: { action: string }) => a.action === 'seed_generation_log');
    expect(seedAction).toBeDefined();
    expect(seedAction.status).toBe('skipped');
    expect(seedAction.reason).toMatch(/dry run/i);

    // Verify no generation log was created
    const log = await queryOne<{ spec_slug: string }>(
      'SELECT spec_slug FROM spec_generation_logs WHERE spec_slug = $1',
      ['dryrun-spec'],
    );
    expect(log).toBeUndefined();
  });

  test('idempotency — second repair on already-repaired spec is no-op', async () => {
    writeSpecFile(os.tmpdir(), 'idem-spec');
    await seedGenerationLog('idem-spec', {
      enrichStatus: 'completed',
      matchSkillsStatus: 'completed',
    });

    // First repair
    const res1 = await request(app)
      .post('/api/specs/idem-spec/repair')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: WORKSPACE_ID });

    expect(res1.status).toBe(200);
    expect(res1.body.healthy).toBe(true);

    // Second repair — should also be healthy/no-op
    const res2 = await request(app)
      .post('/api/specs/idem-spec/repair')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: WORKSPACE_ID });

    expect(res2.status).toBe(200);
    expect(res2.body.healthy).toBe(true);
    expect(res2.body.actions.every((a: { status: string }) => a.status === 'skipped')).toBe(true);
  });

  test('selective stage repair via stages param', async () => {
    writeSpecFile(os.tmpdir(), 'selective-spec');
    await seedGenerationLog('selective-spec', {
      enrichStatus: 'failed',
      matchSkillsStatus: 'failed',
    });

    // Only request enrich repair
    const res = await request(app)
      .post('/api/specs/selective-spec/repair')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: WORKSPACE_ID, stages: ['enrich'] });

    expect(res.status).toBe(200);

    const enrichAction = res.body.actions.find((a: { action: string }) => a.action === 'enqueue_enrich');
    expect(enrichAction).toBeDefined();
    expect(enrichAction.status).toBe('repaired');

    // match-skills should not appear since it wasn't requested
    const matchAction = res.body.actions.find((a: { action: string }) => a.action === 'enqueue_match_skills');
    expect(matchAction).toBeUndefined();
  });

  test('missing context summary is backfilled when generation log exists', async () => {
    writeSpecFile(os.tmpdir(), 'no-ctx-spec');
    await seedGenerationLog('no-ctx-spec', {
      withContextCaptureStatus: false,
      enrichStatus: 'completed',
      matchSkillsStatus: 'completed',
    });

    const res = await request(app)
      .post('/api/specs/no-ctx-spec/repair')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: WORKSPACE_ID });

    expect(res.status).toBe(200);
    expect(res.body.diagnosis.missingContextSummary).toBe(true);

    const backfillAction = res.body.actions.find((a: { action: string }) => a.action === 'backfill_context_summary');
    expect(backfillAction).toBeDefined();
    expect(backfillAction.status).toBe('repaired');
  });
});

describe('workflow/readiness exact surfaces', () => {
  test('GET /api/specs/:specId/workflow returns stable stage snapshots and safe action hints', async () => {
    writeSpecFile(os.tmpdir(), 'workflow-surface-spec');
    await seedGenerationLog('workflow-surface-spec', {
      enrichStatus: 'failed',
      matchSkillsStatus: 'completed',
    });

    await request(app)
      .post('/api/specs/workflow-surface-spec/workflow/stages/enrich/retry')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: WORKSPACE_ID, policyPresetId: 'skill_first_strict' });

    const res = await request(app)
      .get(`/api/specs/workflow-surface-spec/workflow?workspaceId=${WORKSPACE_ID}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.stages.map((stage: { key: string }) => stage.key)).toEqual(['context', 'enrich', 'matchSkills', 'memorySynthesis']);
    expect(res.body.reasonCodes).toEqual(expect.arrayContaining(['post_save_pending']));
    expect(res.body.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'enrich',
        status: expect.stringMatching(/queued|pending|running/),
        workflowRunId: expect.any(Number),
        safeActionHints: expect.any(Array),
      }),
    ]));
    expect(res.body.safeActionHints).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'inspect_workflow', request: expect.objectContaining({ method: 'GET' }) }),
    ]));
  });

  test('GET /api/specs/:specId/readiness returns reason codes, stage states, and safe action hints', async () => {
    writeSpecFile(os.tmpdir(), 'readiness-surface-spec');
    await seedGenerationLog('readiness-surface-spec', {
      enrichStatus: 'failed',
      matchSkillsStatus: 'completed',
    });

    await request(app)
      .post('/api/specs/readiness-surface-spec/workflow/stages/enrich/retry')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: WORKSPACE_ID });

    const res = await request(app)
      .get(`/api/specs/readiness-surface-spec/readiness?workspaceId=${WORKSPACE_ID}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.readinessState.status).toBe('blocked');
    expect(res.body.reasonCodes).toEqual(expect.arrayContaining(['post_save_pending']));
    expect(res.body.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'enrich', status: expect.stringMatching(/queued|pending|running/) }),
    ]));
    expect(res.body.safeActionHints).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'wait_for_post_save' }),
      expect.objectContaining({ action: 'inspect_readiness' }),
    ]));
  });

  test('POST /api/specs/:specId/workflow/stages/:stageKey/retry echoes policy-aware action metadata', async () => {
    writeSpecFile(os.tmpdir(), 'stage-retry-spec');
    await seedGenerationLog('stage-retry-spec', {
      enrichStatus: 'completed',
      matchSkillsStatus: 'failed',
    });

    const res = await request(app)
      .post('/api/specs/stage-retry-spec/workflow/stages/matchSkills/retry')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: WORKSPACE_ID, policyPresetId: 'skill_first_strict' });

    expect(res.status).toBe(200);
    expect(res.body.requestedStageKey).toBe('matchSkills');
    expect(res.body.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: 'enqueue_match_skills',
        stageKey: 'matchSkills',
        status: 'repaired',
        policy: expect.objectContaining({
          effectivePolicy: expect.objectContaining({ onFailure: 'fail', presetId: 'skill_first_strict' }),
        }),
      }),
    ]));
    expect(res.body.workflow.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'matchSkills', bossJobId: expect.any(String) }),
    ]));
    expect(res.body.readiness.reasonCodes).toContain('post_save_pending');
  });

  test('POST /api/specs/repair-batch returns the same durable workflow/readiness model plus requestedPolicy', async () => {
    writeSpecFile(os.tmpdir(), 'batch-repair-spec');
    await seedGenerationLog('batch-repair-spec', {
      enrichStatus: 'failed',
      matchSkillsStatus: 'completed',
    });

    const res = await request(app)
      .post('/api/specs/repair-batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: WORKSPACE_ID,
        categories: ['stage_failed'],
        limit: 1,
        policyPresetId: 'repair_only',
      });

    expect(res.status).toBe(200);
    expect(res.body.requestedPolicy).toBe('repair_only');
    expect(res.body.details).toEqual(expect.arrayContaining([
      expect.objectContaining({
        specId: 'batch-repair-spec',
        requestedPolicy: 'repair_only',
        workflow: expect.objectContaining({
          reasonCodes: expect.arrayContaining(['post_save_pending']),
          stages: expect.arrayContaining([
            expect.objectContaining({ key: 'enrich', bossJobId: expect.any(String) }),
          ]),
        }),
        readiness: expect.objectContaining({
          reasonCodes: expect.arrayContaining(['post_save_pending']),
          safeActionHints: expect.arrayContaining([
            expect.objectContaining({ action: 'wait_for_post_save' }),
          ]),
        }),
      }),
    ]));
  });
});
