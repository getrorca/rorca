/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import request from 'supertest';
import { getAuthToken } from './helpers/auth-helper';
import { query, queryOne, execute } from '../../db/index';
import { updateJobStatus } from '../../db/spec-jobs';
import { advancePersistPostSaveDependencies, syncPersistPostSaveStageFromJob } from '../../lib/spec-post-save';

/** pg returns jsonb columns as already-parsed objects; this handles both cases */
function parsePayload(p: unknown): Record<string, unknown> {
  if (typeof p === 'string') return JSON.parse(p);
  return p as Record<string, unknown>;
}

// Mock llm-client before any imports that use it
jest.mock('../../lib/llm-client', () => ({
  chatComplete: jest.fn(),
  getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
  isValidModel: jest.fn().mockImplementation((m: string) =>
    ['claude-sonnet-4-5-20250929', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'].includes(m)
  ),
  resolveVaultProvider: jest.fn().mockReturnValue(null),
  getModelInfo: jest.fn().mockReturnValue(undefined),
  DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
  SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'],
}));

jest.mock('../../lib/pi-spec-drafter', () => ({
  draftSpecWithPi: jest.fn(),
}));

jest.mock('../../lib/codex-spec-drafter', () => ({
  draftSpecWithCodex: jest.fn(),
}));

jest.mock('../../lib/pg-boss', () => {
  const send = jest.fn().mockResolvedValue('11111111-1111-4111-8111-111111111111');
  return {
    initBoss: jest.fn().mockResolvedValue(undefined),
    getBoss: jest.fn(() => ({ send })),
  };
});

let app: Express;
let tmpDir: string;
let mockChatComplete: jest.Mock;
let mockDraftSpecWithPi: jest.Mock;
let mockDraftSpecWithCodex: jest.Mock;
let mockBossSend: jest.Mock;
let authToken: string;

const validLlmResponse = JSON.stringify({
  stories: [
    {
      id: 'US-001',
      title: 'User login',
      description: 'Allow users to log in with email and password',
      acceptanceCriteria: ['Given valid creds, user is authenticated', 'Given invalid creds, error shown', 'Session persists across refresh'],
      dependsOn: [],
    },
    {
      id: 'US-002',
      title: 'Dashboard view',
      description: 'Show user dashboard after login',
      acceptanceCriteria: ['Dashboard shows user name', 'Shows recent activity', 'Loads within 2s'],
      dependsOn: ['US-001'],
    },
  ],
  diagrams: {
    architecture: { mermaid: 'graph LR\n  A-->B', ascii: 'A -> B' },
    userFlow: { mermaid: 'graph TD\n  login-->dash', ascii: 'login -> dash' },
  },
});

// Load the server ONCE per test file to avoid 87 separate DB connection pools
// (one per jest.resetModules() + require('../../server') call).
// PG_POOL_SIZE=1 in jest.env.ts caps each pool at 1 connection; 87 pools = 87 conns
// plus TRUNCATE deadlocks between module-0 cleanup queries and module-N migrations.
beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  const serverMod = require('../../server');
  app = serverMod.default;
  const llmClient = require('../../lib/llm-client');
  const piDrafter = require('../../lib/pi-spec-drafter');
  const codexDrafter = require('../../lib/codex-spec-drafter');
  const pgBoss = require('../../lib/pg-boss');
  mockChatComplete = llmClient.chatComplete;
  mockDraftSpecWithPi = piDrafter.draftSpecWithPi;
  mockDraftSpecWithCodex = codexDrafter.draftSpecWithCodex;
  mockBossSend = pgBoss.getBoss().send;
});

beforeEach(async () => {
  jest.clearAllMocks();
  // PSE-002: mockReset clears the .mockResolvedValueOnce queue which clearAllMocks
  // does not clear. Without this, unconsumed "once" values from previous tests leak
  // into subsequent tests and cause boss_job_id mismatches.
  mockBossSend.mockReset();
  mockBossSend.mockResolvedValue('11111111-1111-4111-8111-111111111111');

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-specs-test-'));

  // Clean up any stale spec files from prior test suites that share os.tmpdir()
  const specsRoot = path.join(os.tmpdir(), 'forge', 'specs');
  if (fs.existsSync(specsRoot)) {
    fs.rmSync(specsRoot, { recursive: true, force: true });
  }

  // Clean up DB tables that accumulate between tests within the same run.
  const tablesToClean = [
    'story_results', 'story_commits', 'story_comments', 'pipeline_runs',
    'wal_events', 'spec_versions', 'spec_search_index', 'spec_generation_logs',
    'workspace_context', 'direction_layers', 'batch_spec_generation',
    'spec_post_save_stage_dependencies', 'spec_post_save_workflow_stages', 'spec_post_save_workflow_runs',
    'spec_jobs',
  ];
  for (const t of tablesToClean) {
    await execute(`TRUNCATE ${t} CASCADE`).catch(() => {});
  }

  // Seed a workspace for tests
  await execute(`INSERT INTO workspaces (id, label, path) VALUES ('ws-test', 'Test WS', $1) ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path`, [os.tmpdir()]);

  authToken = await getAuthToken(app);
});

afterEach(async () => {
  // Clean up any spec files written to os.tmpdir()
  const specsRoot = path.join(os.tmpdir(), 'forge', 'specs');
  if (fs.existsSync(specsRoot)) {
    fs.rmSync(specsRoot, { recursive: true, force: true });
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('POST /api/specs/generate with valid body returns slug, stories, diagrams, provider, model', async () => {
  mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 100, outputTokens: 200 } });

  const res = await request(app)
    .post('/api/specs/generate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: 'ws-test',
      domain: 'backend',
      title: 'Auth System',
      brief: 'Build login and signup',
    });

  expect(res.status).toBe(200);
  expect(res.body.slug).toBe('auth-system');
  expect(res.body.title).toBe('Auth System');
  expect(res.body.stories).toHaveLength(2);
  expect(res.body.stories[0]).toMatchObject({
    id: 'US-001',
    title: 'User login',
    description: expect.any(String),
    acceptanceCriteria: expect.any(Array),
    dependsOn: [],
  });
  expect(res.body.diagrams).toBeDefined();
  expect(res.body.diagrams.storyDeps).toBeDefined();
  expect(res.body.diagrams.storyDeps.mermaid).toContain('US-001');
  expect(res.body.provider).toBe('claude-cli');
  expect(res.body.model).toBe('claude-sonnet-4-5-20250929');
  expect(res.body.usage).toEqual({ inputTokens: 100, outputTokens: 200 });
  expect(res.body.specPath).toBeDefined();
  expect(res.body.specPath).toContain('auth-system.json');
  expect(res.body.diagramsPath).toBeDefined();
  expect(res.body.diagramsPath).toContain('auth-system-diagrams.md');
  expect(res.body.postSavePolicy).toMatchObject({
    callerPolicy: null,
    effectivePolicy: { version: 'v1', presetId: 'best_effort' },
    legacyOptions: { enrich: true, matchSkills: true, memorySynthesis: true },
  });
  expect(res.body.workflow).toMatchObject({
    engine: 'spec-post-save-v1',
    runId: expect.any(Number),
    saveGeneration: expect.any(Number),
  });
  const workflowStages = await query(
    `SELECT stage_key FROM spec_post_save_workflow_stages WHERE run_id = $1 ORDER BY stage_key`,
    [res.body.workflow.runId],
  ) as Array<{ stage_key: string }>;
  expect(workflowStages.map((stage) => stage.stage_key).sort()).toEqual(['context', 'enrich', 'matchSkills', 'memorySynthesis']);
});

test('POST /api/specs/generate rejects invalid postSave enum values with ValidationError details', async () => {
  const res = await request(app)
    .post('/api/specs/generate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: 'ws-test',
      domain: 'backend',
      title: 'Bad Generate Policy',
      brief: 'Build invalid policy validation',
      postSave: { skills: 'sometimes' },
    });

  expect(res.status).toBe(400);
  expect(res.body.code).toBe('VALIDATION_ERROR');
  expect(res.body.details).toMatchObject({
    field: 'postSave.skills',
    value: 'sometimes',
    allowedValues: 'match,skip',
  });
  expect(mockChatComplete).not.toHaveBeenCalled();
});

test('POST /api/specs/generate surfaces gitRehydration state in contextSummary (CTM-005)', async () => {
  mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 100, outputTokens: 200 } });

  const res = await request(app)
    .post('/api/specs/generate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: 'ws-test',
      domain: 'backend',
      title: 'Hydration Trace',
      brief: 'Observe hydration state',
    });

  expect(res.status).toBe(200);
  expect(res.body.contextSummary).toBeDefined();
  expect(res.body.contextSummary.gitRehydration).toBeDefined();
  expect(typeof res.body.contextSummary.gitRehydration.triggered).toBe('boolean');
  // tmpdir workspace is not a git repo, so HEAD cannot be resolved → no rehydration.
  expect(res.body.contextSummary.gitRehydration.triggered).toBe(false);
  expect(res.body.contextSummary.gitRehydration.reason).toBe('no_head');
});

test('POST /api/specs/generate with agentOverride=pi uses the Pi forge drafter path', async () => {
  mockDraftSpecWithPi.mockResolvedValue({
    text: validLlmResponse,
    usage: { inputTokens: 33, outputTokens: 44 },
  });

  const res = await request(app)
    .post('/api/specs/generate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: 'ws-test',
      domain: 'backend',
      title: 'Pi Forge',
      brief: 'Generate via Pi',
      agentOverride: 'pi',
    });

  expect(res.status).toBe(200);
  expect(res.body.slug).toBe('pi-forge');
  expect(res.body.provider).toBe('pi');
  expect(res.body.model).toBe('claude-sonnet-4-5-20250929');
  expect(res.body.usage).toEqual({ inputTokens: 33, outputTokens: 44 });
  expect(mockDraftSpecWithPi).toHaveBeenCalledTimes(1);
  const draftingCalls = mockChatComplete.mock.calls.filter((call) => {
    const messages = call[0] as Array<{ content?: string }> | undefined;
    return Array.isArray(messages)
      && messages.some((message) => typeof message?.content === 'string' && message.content.includes('TASK: Generate a software specification JSON'));
  });
  expect(draftingCalls).toHaveLength(0);
});

test('POST /api/specs/generation-context returns a prompt bundle for skill-first callers', async () => {
  const res = await request(app)
    .post('/api/specs/generation-context')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: 'ws-test',
      title: 'Context Bundle',
      brief: 'Draft a context-aware spec',
      agentOverride: 'pi',
    });

  expect(res.status).toBe(200);
  expect(res.body.title).toBe('Context Bundle');
  expect(res.body.slug).toBe('context-bundle');
  expect(res.body.agentType).toBe('pi');
  expect(typeof res.body.prompt).toBe('string');
  expect(res.body.prompt).toContain('Spec brief: Draft a context-aware spec');
  expect(res.body.contextSummary).toBeDefined();
});

test('POST /api/specs/forge uses Pi drafting and persists via the explicit-draft path', async () => {
  mockDraftSpecWithPi.mockResolvedValue({
    text: validLlmResponse,
    usage: { inputTokens: 55, outputTokens: 66 },
  });

  const res = await request(app)
    .post('/api/specs/forge')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: 'ws-test',
      title: 'Shared Pi Forge',
      brief: 'Create a skill-first forge route',
      agentOverride: 'pi',
      postSave: { enrich: false, matchSkills: false, memorySynthesis: false },
    });

  expect(res.status).toBe(200);
  expect(res.body.slug).toBe('shared-pi-forge');
  expect(res.body.provider).toBe('pi');
  expect(res.body.draftingAgent).toBe('pi');
  expect(res.body.source).toBe('skill-first-backend');
  expect(res.body.postSave).toEqual({ enrich: false, matchSkills: false, memorySynthesis: false });
  expect(mockDraftSpecWithPi).toHaveBeenCalledTimes(1);

  const saved = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'forge', 'specs', 'pending', 'shared-pi-forge.json'), 'utf8'));
  expect(saved.source).toBe('skill-first-backend');
  expect(saved.userStories).toHaveLength(2);
});

test('POST /api/specs/forge uses Codex drafting when requested', async () => {
  mockDraftSpecWithCodex.mockResolvedValue({
    text: validLlmResponse,
    usage: { inputTokens: 11, outputTokens: 22 },
  });

  const res = await request(app)
    .post('/api/specs/forge')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: 'ws-test',
      title: 'Codex Shared Forge',
      brief: 'Create a skill-first forge route through codex',
      agentOverride: 'codex',
      postSave: { enrich: false, matchSkills: false, memorySynthesis: false },
    });

  expect(res.status).toBe(200);
  expect(res.body.slug).toBe('codex-shared-forge');
  expect(res.body.provider).toBe('codex');
  expect(res.body.draftingAgent).toBe('codex');
  expect(mockDraftSpecWithCodex).toHaveBeenCalledTimes(1);
});

test('LLM returns non-JSON → 500 with error and raw', async () => {
  mockChatComplete.mockResolvedValue({ text: 'This is not JSON at all', usage: { inputTokens: 50, outputTokens: 10 } });

  const res = await request(app)
    .post('/api/specs/generate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: 'ws-test',
      domain: 'backend',
      title: 'Bad Spec',
      brief: 'Something',
    });

  expect(res.status).toBe(500);
  expect(res.body.error).toBe('LLM returned non-JSON');
  expect(res.body.rawResponse).toBe('This is not JSON at all');
});

test('Missing workspaceId in body → 422', async () => {
  const res = await request(app)
    .post('/api/specs/generate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      domain: 'backend',
      title: 'No Workspace',
      brief: 'Missing workspace',
    });

  expect(res.status).toBe(422);
  expect(res.body.error).toContain('Validation failed');
});

test('workspaceId not in DB → 404', async () => {
  const res = await request(app)
    .post('/api/specs/generate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: 'nonexistent',
      domain: 'backend',
      title: 'Ghost',
      brief: 'Workspace does not exist',
    });

  expect(res.status).toBe(404);
  expect(res.body.error).toBe('Workspace not found');
});

test('WAL event inserted with event_type=generate and payload includes provider', async () => {
  mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 100, outputTokens: 200 } });

  await request(app)
    .post('/api/specs/generate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: 'ws-test',
      domain: 'backend',
      title: 'Wal Test',
      brief: 'Build auth',
    });

  const event = await queryOne(`SELECT * FROM wal_events WHERE event_type = 'generate' AND spec_id = 'wal-test'`) as { event_type: string; spec_id: string; payload: string };

  expect(event).toBeDefined();
  expect(event.event_type).toBe('generate');
  expect(event.spec_id).toBe('wal-test');
  const payload = parsePayload(event.payload);
  expect(payload.provider).toBe('claude-cli');
  expect(payload.model).toBe('claude-sonnet-4-5-20250929');
  expect(payload.storyCount).toBe(2);
  expect(payload.inputTokens).toBe(100);
  expect(payload.outputTokens).toBe(200);
});

test('WAL event has hasSchema:true when workspace has hydrated context', async () => {
  mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 100, outputTokens: 200 } });

  // Seed workspace_context with schema
  await execute(`INSERT INTO workspace_context (workspace_id, schema_snapshot, schema_table_count, git_commit_count)
     VALUES ($1, $2, $3, $4)`, ['ws-test', 'CREATE TABLE users (id TEXT);', 1, 10]);

  await request(app)
    .post('/api/specs/generate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: 'ws-test',
      domain: 'backend',
      title: 'Hydrated Spec',
      brief: 'Build with context',
    });

  const event = await queryOne(`SELECT payload FROM wal_events WHERE event_type = 'generate' AND spec_id = 'hydrated-spec'`) as { payload: string };

  expect(event).toBeDefined();
  const payload = parsePayload(event.payload);
  expect(payload.hasSchema).toBe(true);
});

test('WAL event has hasSchema:false when workspace has no hydrated context', async () => {
  mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 100, outputTokens: 200 } });

  // No workspace_context seeded — should gracefully default to false

  await request(app)
    .post('/api/specs/generate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: 'ws-test',
      domain: 'backend',
      title: 'No Context Spec',
      brief: 'Build without context',
    });

  const event = await queryOne(`SELECT payload FROM wal_events WHERE event_type = 'generate' AND spec_id = 'no-context-spec'`) as { payload: string };

  expect(event).toBeDefined();
  const payload = parsePayload(event.payload);
  expect(payload.hasSchema).toBe(false);
  // hasGitMemory is no longer emitted — git_memory column was dropped (migration 070)
  expect(payload.hasGitMemory).toBeUndefined();
});

test('POST /api/specs/generate with existing slug snapshots old version and succeeds', async () => {
  mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 100, outputTokens: 200 } });

  // First call succeeds
  const res1 = await request(app)
    .post('/api/specs/generate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: 'ws-test',
      domain: 'backend',
      title: 'Duplicate Check',
      brief: 'Build something',
    });
  expect(res1.status).toBe(200);

  // Second call with same title → succeeds, old version is snapshotted
  const res2 = await request(app)
    .post('/api/specs/generate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: 'ws-test',
      domain: 'backend',
      title: 'Duplicate Check',
      brief: 'Build something again',
    });
  expect(res2.status).toBe(200);
  expect(res2.body.slug).toBe('duplicate-check');

  // Verify version was created in DB
  const version = await queryOne(`SELECT * FROM spec_versions WHERE spec_slug = 'duplicate-check'`) as { version: number; status: string; content_json: unknown } | undefined;
  expect(version).toBeDefined();
  expect(version!.version).toBe(1);
  expect(version!.status).toBe('pending');
  const content = parsePayload(version!.content_json);
  expect(content.title).toBe('Duplicate Check');
});

// ─── US-003: Model Selection ──────────────────────────────────────────────────

test('POST /api/specs/generate with explicit model uses that model', async () => {
  mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 50, outputTokens: 100 } });

  const res = await request(app)
    .post('/api/specs/generate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: 'ws-test',
      title: 'Model Test',
      brief: 'Test model selection',
      model: 'claude-opus-4-6',
    });

  expect(res.status).toBe(200);
  expect(res.body.model).toBe('claude-opus-4-6');
  expect(res.body.usage).toEqual({ inputTokens: 50, outputTokens: 100 });

  // chatComplete should have been called with the model in options object
  expect(mockChatComplete).toHaveBeenCalledWith(
    expect.any(Array),
    expect.objectContaining({ model: 'claude-opus-4-6' }),
  );
});

test('POST /api/specs/generate accepts any model string (pass-through for openai-compat)', async () => {
  mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 10, outputTokens: 20 } });

  const res = await request(app)
    .post('/api/specs/generate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: 'ws-test',
      title: 'Custom Model',
      brief: 'Test custom model pass-through',
      model: 'my-custom-model-v1',
    });

  // Should not return 400 — any model string is accepted for openai-compat pass-through
  expect(res.status).not.toBe(400);
});

test('POST /api/specs/generate without model uses workspace L3 preferred_model', async () => {
  mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 10, outputTokens: 20 } });

  // Set workspace L3 preferred_model
  await execute(`
    INSERT INTO direction_layers (layer, workspace_id, content_yaml, preferred_model, updated_at)
    VALUES (3, 'ws-test', 'project: test', 'claude-haiku-4-5-20251001', NOW())
  `);

  const res = await request(app)
    .post('/api/specs/generate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: 'ws-test',
      title: 'Default Model Test',
      brief: 'Test default model from L3',
    });

  expect(res.status).toBe(200);
  expect(res.body.model).toBe('claude-haiku-4-5-20251001');
  expect(mockChatComplete).toHaveBeenCalledWith(
    expect.any(Array),
    expect.objectContaining({ model: 'claude-haiku-4-5-20251001' }),
  );
});

test('POST /api/specs/generate with explicit model overrides workspace default', async () => {
  mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 10, outputTokens: 20 } });

  // Set workspace L3 preferred_model
  await execute(`
    INSERT INTO direction_layers (layer, workspace_id, content_yaml, preferred_model, updated_at)
    VALUES (3, 'ws-test', 'project: test', 'claude-haiku-4-5-20251001', NOW())
    ON CONFLICT (layer, COALESCE(workspace_id,''), COALESCE(domain,''), COALESCE(team_id,''))
    DO UPDATE SET preferred_model = 'claude-haiku-4-5-20251001'
  `);

  const res = await request(app)
    .post('/api/specs/generate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: 'ws-test',
      title: 'Override Model Test',
      brief: 'Test explicit model overrides workspace',
      model: 'claude-opus-4-6',
    });

  expect(res.status).toBe(200);
  expect(res.body.model).toBe('claude-opus-4-6');
});

test('WAL event payload includes token usage', async () => {
  mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 500, outputTokens: 1000 } });

  await request(app)
    .post('/api/specs/generate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: 'ws-test',
      title: 'Token Usage Test',
      brief: 'Test token tracking',
    });

  const event = await queryOne(`SELECT payload FROM wal_events WHERE event_type = 'generate' AND spec_id = 'token-usage-test'`) as { payload: string };

  expect(event).toBeDefined();
  const payload = parsePayload(event.payload);
  expect(payload.inputTokens).toBe(500);
  expect(payload.outputTokens).toBe(1000);
});

// ─── PSE-002: Generate-path durable post-save orchestration ────────────────────

describe('POST /api/specs/generate post-save durable enqueue (PSE-002)', () => {
  test('seeds postSaveStages and enqueues durable enrich + deferred match-skills', async () => {
    mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 100, outputTokens: 200 } });
    mockBossSend
      .mockResolvedValueOnce('aaa11111-1111-4111-8111-111111111111')
      .mockResolvedValueOnce('bbb22222-2222-4222-8222-222222222222');

    const res = await request(app)
      .post('/api/specs/generate')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-test',
        title: 'Generate Post Save',
        brief: 'Test durable post-save from generate path',
      });

    expect(res.status).toBe(200);
    expect(res.body.slug).toBe('generate-post-save');

    // Verify enrich was enqueued through pg-boss
    expect(mockBossSend).toHaveBeenCalledWith(
      'spec:enrich',
      expect.objectContaining({
        specId: 'generate-post-save',
        workspaceId: 'ws-test',
        jobId: expect.any(String),
      }),
      expect.objectContaining({ priority: 1, singletonKey: 'persist-post-save:ws-test:generate-post-save' }),
    );

    // Verify spec_jobs rows were created
    const jobs = await query(
      `SELECT job_type, status, boss_job_id, request_payload, error_message
       FROM spec_jobs
       WHERE workspace_id = 'ws-test' AND spec_id = 'generate-post-save'
       ORDER BY created_at ASC`,
    ) as Array<{ job_type: string; status: string; boss_job_id: string | null; request_payload: unknown; error_message: string | null }>;

    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({ job_type: 'enrich', status: 'pending', boss_job_id: 'aaa11111-1111-4111-8111-111111111111', error_message: null });
    expect(parsePayload(jobs[0].request_payload)).toMatchObject({ origin: 'persist-post-save', stage: 'enrich' });
    expect(jobs[1]).toMatchObject({ job_type: 'match-skills', status: 'pending', boss_job_id: null, error_message: null });
    expect(parsePayload(jobs[1].request_payload)).toMatchObject({ origin: 'persist-post-save', stage: 'matchSkills', waitForStage: 'enrich' });

    // Verify generation log has postSaveStages in context_summary_json
    const logRes = await request(app)
      .get('/api/specs/generate-post-save/generation-log')
      .set('Authorization', `Bearer ${authToken}`);

    expect(logRes.status).toBe(200);
    expect(logRes.body.status).toBe('pending_enrichment');
    const summary = parsePayload(logRes.body.context_summary_json);
    expect(summary.postSaveStages).toBeDefined();
    expect(summary.postSaveStages).toEqual({
      enrich: expect.objectContaining({ requested: true, status: 'queued', reason: 'durable_job_enqueued', bossJobId: 'aaa11111-1111-4111-8111-111111111111' }),
      matchSkills: expect.objectContaining({ requested: true, status: 'pending', reason: 'waiting_for_enrich', bossJobId: null }),
      memorySynthesis: expect.objectContaining({ requested: true, status: 'pending', reason: 'requested_by_caller' }),
    });
    expect(summary.workspaceId).toBe('ws-test');
    expect(summary.source).toBe('generate');
  });

  test('persists enqueue failure to stage state when boss.send returns null in generate path', async () => {
    mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 100, outputTokens: 200 } });
    mockBossSend.mockResolvedValueOnce(null);

    const res = await request(app)
      .post('/api/specs/generate')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-test',
        title: 'Generate Failed Queue',
        brief: 'Test enqueue failure persistence from generate path',
      });

    expect(res.status).toBe(200);

    // Verify both jobs marked as failed in spec_jobs
    const jobs = await query(
      `SELECT job_type, status, boss_job_id, error_message
       FROM spec_jobs
       WHERE workspace_id = 'ws-test' AND spec_id = 'generate-failed-queue'
       ORDER BY created_at ASC`,
    ) as Array<{ job_type: string; status: string; boss_job_id: string | null; error_message: string | null }>;

    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({ job_type: 'enrich', status: 'failed', boss_job_id: null });
    expect(jobs[0].error_message).toContain('boss.send() returned null for enrich');
    expect(jobs[1]).toMatchObject({ job_type: 'match-skills', status: 'failed', boss_job_id: null });
    expect(jobs[1].error_message).toContain('Blocked because enrich could not be enqueued');

    // Verify failure is visible through generation-log API (not just logger)
    const logRes = await request(app)
      .get('/api/specs/generate-failed-queue/generation-log')
      .set('Authorization', `Bearer ${authToken}`);

    expect(logRes.status).toBe(200);
    expect(logRes.body.status).toBe('failed');
    const summary = parsePayload(logRes.body.context_summary_json);
    expect(summary.postSaveStages).toEqual({
      enrich: expect.objectContaining({ requested: true, status: 'failed', reason: 'enqueue_failed', error: expect.stringContaining('boss.send() returned null for enrich') }),
      matchSkills: expect.objectContaining({ requested: true, status: 'failed', reason: 'blocked_by_enrich_enqueue_failure', error: 'Blocked because enrich could not be enqueued' }),
      memorySynthesis: expect.objectContaining({ requested: true, status: 'pending', reason: 'requested_by_caller' }),
    });
  });

  test('advances deferred match-skills after enrich completes in generate path', async () => {
    mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 100, outputTokens: 200 } });
    mockBossSend
      .mockResolvedValueOnce('ccc33333-3333-4333-8333-333333333333')
      .mockResolvedValueOnce('ddd44444-4444-4444-8444-444444444444');

    const res = await request(app)
      .post('/api/specs/generate')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-test',
        title: 'Generate Advance Deps',
        brief: 'Test enrich completion advances match-skills',
      });

    expect(res.status).toBe(200);

    // Simulate enrich job completion
    const enrichJob = await queryOne(
      `SELECT id FROM spec_jobs WHERE workspace_id = 'ws-test' AND spec_id = 'generate-advance-deps' AND job_type = 'enrich'`,
    ) as { id: string } | undefined;
    expect(enrichJob).toBeDefined();

    await updateJobStatus(enrichJob!.id, 'completed', { finishedAt: new Date() });
    await syncPersistPostSaveStageFromJob(enrichJob!.id);
    await advancePersistPostSaveDependencies(enrichJob!.id);

    // match-skills should now be enqueued
    expect(mockBossSend).toHaveBeenCalledTimes(2);
    expect(mockBossSend).toHaveBeenLastCalledWith(
      'spec:match-skills',
      expect.objectContaining({
        specId: 'generate-advance-deps',
        workspaceId: 'ws-test',
      }),
      expect.objectContaining({ priority: 1, singletonKey: 'persist-post-save:ws-test:generate-advance-deps' }),
    );

    const matchJob = await queryOne(
      `SELECT boss_job_id, status FROM spec_jobs WHERE workspace_id = 'ws-test' AND spec_id = 'generate-advance-deps' AND job_type = 'match-skills'`,
    ) as { boss_job_id: string | null; status: string } | undefined;
    expect(matchJob).toEqual({ boss_job_id: 'ddd44444-4444-4444-8444-444444444444', status: 'pending' });

    // Verify generation log reflects the state transition
    const logRes = await request(app)
      .get('/api/specs/generate-advance-deps/generation-log')
      .set('Authorization', `Bearer ${authToken}`);

    const summary = parsePayload(logRes.body.context_summary_json);
    expect(summary.postSaveStages).toEqual({
      enrich: expect.objectContaining({ requested: true, status: 'completed', reason: 'job_completed' }),
      matchSkills: expect.objectContaining({ requested: true, status: 'queued', reason: 'durable_job_enqueued_after_enrich', bossJobId: 'ddd44444-4444-4444-8444-444444444444' }),
      memorySynthesis: expect.objectContaining({ requested: true, status: 'pending', reason: 'requested_by_caller' }),
    });
  });
});

// ─── R-001: List / Approve / Reject / Get Detail ──────────────────────────────

/** Seed a spec file on disk for R-001 tests */
function seedSpecFile(dir: string, slug: string, overrides?: Record<string, unknown>) {
  fs.mkdirSync(dir, { recursive: true });
  const spec = {
    title: slug.replace(/-/g, ' '),
    userStories: [
      { id: 'US-001', title: 'Story one', description: 'Desc', acceptanceCriteria: ['AC1'], dependsOn: [], passes: false },
    ],
    generatedAt: '2026-02-20T12:00:00.000Z',
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, `${slug}.json`), JSON.stringify(spec, null, 2), 'utf8');
  return spec;
}

describe('POST /api/specs/persist', () => {
  test('persists an explicit drafted spec to pending with canonical source metadata', async () => {
    const res = await request(app)
      .post('/api/specs/persist')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-test',
        title: 'Explicit Draft',
        stories: [
          { id: 'US-001', title: 'Login', description: 'Build login flow', acceptanceCriteria: ['User can submit credentials'], dependsOn: [] },
          { id: 'US-002', title: 'Session', description: 'Persist authenticated session', acceptanceCriteria: ['Session persists across refresh'], dependsOn: ['US-001'] },
        ],
        postSave: { enrich: false, matchSkills: false, memorySynthesis: false },
      });

    expect(res.status).toBe(200);
    expect(res.body.slug).toBe('explicit-draft');
    expect(res.body.status).toBe('pending');
    expect(res.body.source).toBe('explicit-draft');
    expect(res.body.stories).toHaveLength(2);
    expect(res.body.postSave).toEqual({ enrich: false, matchSkills: false, memorySynthesis: false });
    expect(res.body.workflow).toMatchObject({
      engine: 'spec-post-save-v1',
      runId: expect.any(Number),
      saveGeneration: expect.any(Number),
    });

    const saved = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'forge', 'specs', 'pending', 'explicit-draft.json'), 'utf8'));
    expect(saved.source).toBe('explicit-draft');
    expect(saved.userStories).toHaveLength(2);
    expect(saved.contextUsed).toBeUndefined();
    expect(saved.contextSummary).toBeUndefined();
    expect(saved.postSavePolicy).toMatchObject({
      callerPolicy: { enrich: false, matchSkills: false, memorySynthesis: false },
      effectivePolicy: { version: 'v1', enrich: 'skip', skills: 'skip', memory: 'skip' },
      legacyOptions: { enrich: false, matchSkills: false, memorySynthesis: false },
    });

    const logRes = await request(app)
      .get('/api/specs/explicit-draft/generation-log')
      .set('Authorization', `Bearer ${authToken}`);

    expect(logRes.status).toBe(200);
    const summary = parsePayload(logRes.body.context_summary_json);
    expect(summary.sourceMode).toBe('explicit-draft');
    expect(summary.invocationSurface).toBe('api.specs.persist');
    expect(summary.contextCaptureStatus).toEqual({
      status: 'missing',
      reason: 'caller_context_not_supplied',
      contextUsed: 'missing',
      contextSummary: 'missing',
    });
    expect(summary.postSavePolicy).toMatchObject({
      callerPolicy: { enrich: false, matchSkills: false, memorySynthesis: false },
      effectivePolicy: { version: 'v1', enrich: 'skip', skills: 'skip', memory: 'skip' },
      legacyOptions: { enrich: false, matchSkills: false, memorySynthesis: false },
    });
    expect(summary.postSaveStages).toEqual({
      enrich: { requested: false, status: 'skipped', reason: 'disabled_by_caller' },
      matchSkills: { requested: false, status: 'skipped', reason: 'disabled_by_caller' },
      memorySynthesis: { requested: false, status: 'skipped', reason: 'disabled_by_caller' },
    });
    expect(summary.contextSummary).toBeUndefined();
    expect(summary.contextUsed).toBeUndefined();
  });

  test('rejects invalid postSave preset ids with ValidationError details', async () => {
    const res = await request(app)
      .post('/api/specs/persist')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-test',
        title: 'Invalid Policy Draft',
        stories: [
          { id: 'US-001', title: 'Login', description: 'Build login flow', acceptanceCriteria: ['User can submit credentials'], dependsOn: [] },
        ],
        postSave: 'unknown_preset',
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.details).toMatchObject({
      field: 'postSave',
      value: 'unknown_preset',
      allowedValues: 'fast_import,best_effort,skill_first_strict,enterprise_governed,repair_only',
    });
  });

  test('seeds a generation log immediately so the Context tab is non-null before enrich completes', async () => {
    const callerContextSummary = {
      directionLayers: {
        l1: true,
        l2: { present: true, domain: 'devtools' },
        l3: true,
      },
      skills: ['rorca-forge'],
      memoryEntries: 3,
      agentsMd: true,
      template: null,
      schemaSnapshot: true,
      gitMemory: false,
      estimatedTokens: 1234,
      modelContextWindow: 200000,
      retrieval: {
        cagHits: 2,
        ragHits: 5,
        graphHits: 1,
        tier: 'hybrid',
        latencyMs: 31,
      },
    };

    const persistRes = await request(app)
      .post('/api/specs/persist')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-test',
        title: 'Immediate Context Draft',
        stories: [
          { id: 'US-001', title: 'Login', description: 'Build login flow', acceptanceCriteria: ['User can submit credentials'], dependsOn: [] },
        ],
        contextUsed: {
          text: 'SYNTHESIZED CONTEXT',
          meta: {
            standards: true,
            conventions: true,
            project: true,
            schema: true,
            totalTokens: 1234,
            scopesMatched: [],
          },
        },
        contextSummary: callerContextSummary,
      });

    expect(persistRes.status).toBe(200);
    expect(persistRes.body.postSave).toEqual({ enrich: true, matchSkills: true, memorySynthesis: true });

    const saved = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'forge', 'specs', 'pending', 'immediate-context-draft.json'), 'utf8'));
    expect(saved.contextSummary).toEqual(callerContextSummary);
    expect(saved.contextUsed.text).toBe('SYNTHESIZED CONTEXT');

    const logRes = await request(app)
      .get('/api/specs/immediate-context-draft/generation-log')
      .set('Authorization', `Bearer ${authToken}`);

    expect(logRes.status).toBe(200);
    expect(logRes.body).toBeTruthy();
    expect(logRes.body.spec_slug).toBe('immediate-context-draft');
    expect(logRes.body.status).toBe('pending_enrichment');
    expect(logRes.body.enriched).toBe(false);
    expect(logRes.body.retrieval_method).toBe('none');
    expect(logRes.body.context_summary).toContain('caller-provided context');

    const summary = parsePayload(logRes.body.context_summary_json);
    expect(summary.source).toBe('explicit-draft');
    expect(summary.sourceMode).toBe('explicit-draft');
    expect(summary.invocationSurface).toBe('api.specs.persist');
    expect(summary.storyCount).toBe(1);
    expect(summary.pendingEnrichment).toBe(true);
    expect(summary.postSave).toEqual({ enrich: true, matchSkills: true, memorySynthesis: true });
    expect(summary.contextCaptureStatus).toEqual({
      status: 'provided',
      reason: 'caller_supplied_context',
      contextUsed: 'provided',
      contextSummary: 'provided',
    });
    expect(summary.postSaveStages).toEqual({
      enrich: expect.objectContaining({ requested: true, status: 'queued', reason: 'durable_job_enqueued', bossJobId: '11111111-1111-4111-8111-111111111111' }),
      matchSkills: expect.objectContaining({ requested: true, status: 'pending', reason: 'waiting_for_enrich', bossJobId: null }),
      memorySynthesis: { requested: true, status: 'pending', reason: 'requested_by_caller' },
    });
    const contextUsed = summary.contextUsed as { text: string };
    const contextSummary = summary.contextSummary as {
      directionLayers: unknown;
      retrieval: unknown;
    };
    expect(contextUsed.text).toBe('SYNTHESIZED CONTEXT');
    expect(contextSummary.directionLayers).toEqual({
      l1: true,
      l2: { present: true, domain: 'devtools' },
      l3: true,
    });
    expect(contextSummary.retrieval).toEqual({
      cagHits: 2,
      ragHits: 5,
      graphHits: 1,
      tier: 'hybrid',
      latencyMs: 31,
    });
  });

  test('enqueues persist post-save enrich durably and defers match-skills until enrich finishes', async () => {
    mockBossSend
      .mockResolvedValueOnce('22222222-2222-4222-8222-222222222222')
      .mockResolvedValueOnce('33333333-3333-4333-8333-333333333333');

    const res = await request(app)
      .post('/api/specs/persist')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-test',
        title: 'Queued Post Save Draft',
        stories: [
          { id: 'US-001', title: 'Login', description: 'Build login flow', acceptanceCriteria: ['User can submit credentials'], dependsOn: [] },
        ],
        postSave: { enrich: true, matchSkills: true, memorySynthesis: false },
      });

    expect(res.status).toBe(200);
    expect(mockBossSend).toHaveBeenCalledTimes(1);
    expect(mockBossSend).toHaveBeenCalledWith(
      'spec:enrich',
      expect.objectContaining({
        specId: 'queued-post-save-draft',
        workspaceId: 'ws-test',
        jobId: expect.any(String),
      }),
      expect.objectContaining({ priority: 1, singletonKey: 'persist-post-save:ws-test:queued-post-save-draft' }),
    );

    const jobs = await query(
      `SELECT job_type, status, boss_job_id, request_payload, error_message
       FROM spec_jobs
       WHERE workspace_id = 'ws-test' AND spec_id = 'queued-post-save-draft'
       ORDER BY created_at ASC`,
    ) as Array<{ job_type: string; status: string; boss_job_id: string | null; request_payload: unknown; error_message: string | null }>;

    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({ job_type: 'enrich', status: 'pending', boss_job_id: '22222222-2222-4222-8222-222222222222', error_message: null });
    expect(parsePayload(jobs[0].request_payload)).toMatchObject({ origin: 'persist-post-save', stage: 'enrich' });
    expect(jobs[1]).toMatchObject({ job_type: 'match-skills', status: 'pending', boss_job_id: null, error_message: null });
    expect(parsePayload(jobs[1].request_payload)).toMatchObject({ origin: 'persist-post-save', stage: 'matchSkills', waitForStage: 'enrich' });

    const logRes = await request(app)
      .get('/api/specs/queued-post-save-draft/generation-log')
      .set('Authorization', `Bearer ${authToken}`);

    expect(logRes.status).toBe(200);
    const summary = parsePayload(logRes.body.context_summary_json);
    expect(logRes.body.status).toBe('pending_enrichment');
    expect(summary.postSaveStages).toEqual({
      enrich: expect.objectContaining({ requested: true, status: 'queued', reason: 'durable_job_enqueued', bossJobId: '22222222-2222-4222-8222-222222222222' }),
      matchSkills: expect.objectContaining({ requested: true, status: 'pending', reason: 'waiting_for_enrich', bossJobId: null }),
      memorySynthesis: { requested: false, status: 'skipped', reason: 'disabled_by_caller' },
    });

    const enrichJob = await queryOne(
      `SELECT id FROM spec_jobs WHERE workspace_id = 'ws-test' AND spec_id = 'queued-post-save-draft' AND job_type = 'enrich'`,
    ) as { id: string } | undefined;
    expect(enrichJob).toBeDefined();

    await updateJobStatus(enrichJob!.id, 'completed', { finishedAt: new Date() });
    await syncPersistPostSaveStageFromJob(enrichJob!.id);
    await advancePersistPostSaveDependencies(enrichJob!.id);

    expect(mockBossSend).toHaveBeenCalledTimes(2);
    expect(mockBossSend).toHaveBeenLastCalledWith(
      'spec:match-skills',
      expect.objectContaining({
        specId: 'queued-post-save-draft',
        workspaceId: 'ws-test',
        jobId: expect.any(String),
      }),
      expect.objectContaining({ priority: 1, singletonKey: 'persist-post-save:ws-test:queued-post-save-draft' }),
    );

    const releasedMatchJob = await queryOne(
      `SELECT boss_job_id, status FROM spec_jobs WHERE workspace_id = 'ws-test' AND spec_id = 'queued-post-save-draft' AND job_type = 'match-skills'`,
    ) as { boss_job_id: string | null; status: string } | undefined;
    expect(releasedMatchJob).toEqual({ boss_job_id: '33333333-3333-4333-8333-333333333333', status: 'pending' });

    const afterReleaseLogRes = await request(app)
      .get('/api/specs/queued-post-save-draft/generation-log')
      .set('Authorization', `Bearer ${authToken}`);

    const releasedSummary = parsePayload(afterReleaseLogRes.body.context_summary_json);
    expect(releasedSummary.postSaveStages).toEqual({
      enrich: expect.objectContaining({ requested: true, status: 'completed', reason: 'job_completed' }),
      matchSkills: expect.objectContaining({ requested: true, status: 'queued', reason: 'durable_job_enqueued_after_enrich', bossJobId: '33333333-3333-4333-8333-333333333333' }),
      memorySynthesis: { requested: false, status: 'skipped', reason: 'disabled_by_caller' },
    });
  });

  test('persists enqueue failures and exposes them through generation-log stage state', async () => {
    mockBossSend.mockResolvedValueOnce(null);

    const res = await request(app)
      .post('/api/specs/persist')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-test',
        title: 'Failed Queue Draft',
        stories: [
          { id: 'US-001', title: 'Login', description: 'Build login flow', acceptanceCriteria: ['User can submit credentials'], dependsOn: [] },
        ],
        postSave: { enrich: true, matchSkills: true, memorySynthesis: false },
      });

    expect(res.status).toBe(200);

    const jobs = await query(
      `SELECT job_type, status, boss_job_id, error_message
       FROM spec_jobs
       WHERE workspace_id = 'ws-test' AND spec_id = 'failed-queue-draft'
       ORDER BY created_at ASC`,
    ) as Array<{ job_type: string; status: string; boss_job_id: string | null; error_message: string | null }>;

    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({ job_type: 'enrich', status: 'failed', boss_job_id: null });
    expect(jobs[0].error_message).toContain('boss.send() returned null for enrich');
    expect(jobs[1]).toMatchObject({ job_type: 'match-skills', status: 'failed', boss_job_id: null });
    expect(jobs[1].error_message).toContain('Blocked because enrich could not be enqueued');

    const logRes = await request(app)
      .get('/api/specs/failed-queue-draft/generation-log')
      .set('Authorization', `Bearer ${authToken}`);

    expect(logRes.status).toBe(200);
    expect(logRes.body.status).toBe('failed');
    const summary = parsePayload(logRes.body.context_summary_json);
    expect(summary.postSaveStages).toEqual({
      enrich: expect.objectContaining({ requested: true, status: 'failed', reason: 'enqueue_failed', error: expect.stringContaining('boss.send() returned null for enrich') }),
      matchSkills: expect.objectContaining({ requested: true, status: 'failed', reason: 'blocked_by_enrich_enqueue_failure', error: 'Blocked because enrich could not be enqueued' }),
      memorySynthesis: { requested: false, status: 'skipped', reason: 'disabled_by_caller' },
    });
  });

  test('blocks deferred match-skills and surfaces failure when enrich fails during execution', async () => {
    mockBossSend.mockResolvedValueOnce('44444444-4444-4444-8444-444444444444');

    const res = await request(app)
      .post('/api/specs/persist')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-test',
        title: 'Failed Enrich Draft',
        stories: [
          { id: 'US-001', title: 'Login', description: 'Build login flow', acceptanceCriteria: ['User can submit credentials'], dependsOn: [] },
        ],
        postSave: { enrich: true, matchSkills: true, memorySynthesis: false },
      });

    expect(res.status).toBe(200);

    const enrichJob = await queryOne(
      `SELECT id FROM spec_jobs WHERE workspace_id = 'ws-test' AND spec_id = 'failed-enrich-draft' AND job_type = 'enrich'`,
    ) as { id: string } | undefined;
    expect(enrichJob).toBeDefined();

    await updateJobStatus(enrichJob!.id, 'failed', {
      errorMessage: 'LLM provider timeout',
      finishedAt: new Date(),
    });
    await syncPersistPostSaveStageFromJob(enrichJob!.id);
    await advancePersistPostSaveDependencies(enrichJob!.id);

    expect(mockBossSend).toHaveBeenCalledTimes(1);

    const matchJob = await queryOne(
      `SELECT status, boss_job_id, error_message FROM spec_jobs WHERE workspace_id = 'ws-test' AND spec_id = 'failed-enrich-draft' AND job_type = 'match-skills'`,
    ) as { status: string; boss_job_id: string | null; error_message: string | null } | undefined;
    expect(matchJob).toEqual({ status: 'failed', boss_job_id: null, error_message: 'LLM provider timeout' });

    const logRes = await request(app)
      .get('/api/specs/failed-enrich-draft/generation-log')
      .set('Authorization', `Bearer ${authToken}`);

    expect(logRes.status).toBe(200);
    expect(logRes.body.status).toBe('failed');
    const summary = parsePayload(logRes.body.context_summary_json);
    expect(summary.postSaveStages).toEqual({
      enrich: expect.objectContaining({ requested: true, status: 'failed', reason: 'job_failed', error: 'LLM provider timeout' }),
      matchSkills: expect.objectContaining({ requested: true, status: 'failed', reason: 'blocked_by_enrich_failure', error: 'LLM provider timeout' }),
      memorySynthesis: { requested: false, status: 'skipped', reason: 'disabled_by_caller' },
    });
  });

  test('backfills a canonical context summary from contextUsed metadata when callers omit contextSummary', async () => {
    const res = await request(app)
      .post('/api/specs/persist')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-test',
        title: 'Backfilled Context Draft',
        stories: [
          { id: 'US-001', title: 'Login', description: 'Build login flow', acceptanceCriteria: ['User can submit credentials'], dependsOn: [] },
        ],
        contextUsed: {
          text: 'SYNTHESIZED CONTEXT',
          meta: {
            standards: true,
            conventions: false,
            project: true,
            schema: true,
            totalTokens: 222,
            memoryEntries: 2,
            skills: ['rorca-forge'],
            predictedFiles: ['backend/src/routes/specs.ts'],
          },
        },
        postSave: { enrich: false, matchSkills: true, memorySynthesis: false },
      });

    expect(res.status).toBe(200);
    expect(res.body.contextSummary).toMatchObject({
      directionLayers: {
        l1: true,
        l2: { present: false, domain: null },
        l3: true,
      },
      memoryEntries: 2,
      estimatedTokens: 222,
      predictedFiles: ['backend/src/routes/specs.ts'],
    });

    const saved = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'forge', 'specs', 'pending', 'backfilled-context-draft.json'), 'utf8'));
    expect(saved.contextSummary).toMatchObject({
      directionLayers: {
        l1: true,
        l2: { present: false, domain: null },
        l3: true,
      },
      memoryEntries: 2,
      estimatedTokens: 222,
      predictedFiles: ['backend/src/routes/specs.ts'],
    });

    const logRes = await request(app)
      .get('/api/specs/backfilled-context-draft/generation-log')
      .set('Authorization', `Bearer ${authToken}`);

    expect(logRes.status).toBe(200);
    const summary = parsePayload(logRes.body.context_summary_json);
    expect(summary.contextCaptureStatus).toEqual({
      status: 'backfilled',
      reason: 'context_summary_derived_from_context_used_meta',
      contextUsed: 'provided',
      contextSummary: 'backfilled',
    });
    expect(summary.postSaveStages).toEqual({
      enrich: { requested: false, status: 'skipped', reason: 'disabled_by_caller' },
      matchSkills: expect.objectContaining({ requested: true, status: 'queued', reason: 'durable_job_enqueued', bossJobId: '11111111-1111-4111-8111-111111111111' }),
      memorySynthesis: { requested: false, status: 'skipped', reason: 'disabled_by_caller' },
    });
    expect(summary.contextSummary).toMatchObject({
      directionLayers: {
        l1: true,
        l2: { present: false, domain: null },
        l3: true,
      },
      memoryEntries: 2,
      estimatedTokens: 222,
      predictedFiles: ['backend/src/routes/specs.ts'],
    });
  });

  test('normalizes duplicate and missing story IDs while preserving valid dependencies', async () => {
    const res = await request(app)
      .post('/api/specs/persist')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-test',
        title: 'Normalize Draft',
        stories: [
          { id: 'US-001', title: 'First', description: 'First story', acceptanceCriteria: ['AC1'], dependsOn: [] },
          { id: 'US-001', title: 'Second', description: 'Second story', acceptanceCriteria: ['AC2'], dependsOn: ['US-001'] },
          { title: 'Third', description: 'Third story', acceptanceCriteria: ['AC3'], dependsOn: ['US-001'] },
        ],
        postSave: { enrich: false, matchSkills: false, memorySynthesis: false },
      });

    expect(res.status).toBe(200);
    expect(res.body.stories.map((story: any) => story.id)).toEqual(['US-001', 'US-002', 'US-003']);
    expect(res.body.stories[1].dependsOn).toEqual(['US-001']);
    expect(res.body.stories[2].dependsOn).toEqual(['US-001']);
    expect(res.body.normalization.changes).toEqual([
      { from: 'US-001', to: 'US-002', reason: 'duplicate_id' },
      { to: 'US-003', reason: 'missing_id' },
    ]);
  });

  test('returns 409 when a spec already exists and overwrite=false', async () => {
    seedSpecFile(path.join(os.tmpdir(), 'forge', 'specs', 'pending'), 'persist-conflict');

    const res = await request(app)
      .post('/api/specs/persist')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-test',
        title: 'Persist Conflict',
        stories: [
          { id: 'US-001', title: 'Replacement', description: 'Replacement story', acceptanceCriteria: ['AC1'], dependsOn: [] },
        ],
        postSave: { enrich: false, matchSkills: false, memorySynthesis: false },
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("Spec 'persist-conflict' already exists");
  });

  test('overwrite=true snapshots the previous spec and emits a spec_generated WAL event', async () => {
    seedSpecFile(path.join(os.tmpdir(), 'forge', 'specs', 'pending'), 'persist-overwrite', { title: 'Old Draft' });

    const res = await request(app)
      .post('/api/specs/persist')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-test',
        title: 'Persist Overwrite',
        overwrite: true,
        source: 'skill-first',
        stories: [
          { id: 'US-001', title: 'New Story', description: 'Fresh story', acceptanceCriteria: ['AC1'], dependsOn: [] },
        ],
        postSave: { enrich: false, matchSkills: false, memorySynthesis: false },
      });

    expect(res.status).toBe(200);
    expect(res.body.overwrote).toBe(true);
    expect(res.body.source).toBe('skill-first');

    const version = await queryOne(`SELECT content_json, status FROM spec_versions WHERE spec_slug = 'persist-overwrite' ORDER BY version DESC LIMIT 1`) as { content_json: unknown; status: string } | undefined;
    expect(version).toBeDefined();
    expect(version?.status).toBe('pending');
    const oldContent = typeof version?.content_json === 'string' ? JSON.parse(version.content_json) : version?.content_json as Record<string, unknown>;
    expect(oldContent.title).toBe('Old Draft');

    const event = await queryOne(`SELECT payload FROM wal_events WHERE event_type = 'spec_generated' AND spec_id = 'persist-overwrite'`) as { payload: string } | undefined;
    expect(event).toBeDefined();
    const payload = parsePayload(event!.payload);
    expect(payload.source).toBe('skill-first');
    expect(payload.overwrite).toBe(true);
  });

  test('repair dry-run diagnoses memory synthesis retry through workflow stage names', async () => {
    seedSpecFile(path.join(os.tmpdir(), 'forge', 'specs', 'pending'), 'repair-memory', {
      title: 'Repair Memory',
      userStories: [
        { id: 'US-001', title: 'Story', description: 'Desc', acceptanceCriteria: ['AC1'], dependsOn: [] },
      ],
    });
    await execute(
      `INSERT INTO spec_generation_logs (spec_slug, model, provider, duration_ms, context_summary, context_summary_json, status, save_generation)
       VALUES ($1, 'explicit-draft', 'api', 0, 'legacy', $2, 'failed', 9001)`,
      ['repair-memory', JSON.stringify({
        source: 'explicit-draft',
        workspaceId: 'ws-test',
        saveGeneration: 9001,
        contextCaptureStatus: { status: 'provided', reason: 'caller_supplied_context', contextUsed: 'provided', contextSummary: 'provided' },
        postSaveStages: {
          enrich: { requested: false, status: 'skipped', reason: 'disabled_by_caller' },
          matchSkills: { requested: false, status: 'skipped', reason: 'disabled_by_caller' },
          memorySynthesis: { requested: true, status: 'failed', reason: 'job_failed', error: 'prior failure' },
        },
      })],
    );

    const res = await request(app)
      .post('/api/specs/repair-memory/repair')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test', stages: ['memorySynthesis'], dryRun: true });

    expect(res.status).toBe(200);
    expect(res.body.diagnosis).toMatchObject({
      missingWorkflowRun: true,
      memorySynthesisNeedsRepair: true,
    });
    expect(res.body.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'enqueue_memory_synthesis', status: 'skipped', reason: expect.stringContaining('Dry run') }),
    ]));
  });

  test('repair backfills a legacy generation log by starting a durable workflow run', async () => {
    mockBossSend.mockResolvedValueOnce('55555555-5555-4555-8555-555555555555');
    seedSpecFile(path.join(os.tmpdir(), 'forge', 'specs', 'pending'), 'repair-legacy', {
      title: 'Repair Legacy',
      userStories: [
        { id: 'US-001', title: 'Story', description: 'Desc', acceptanceCriteria: ['AC1'], dependsOn: [] },
      ],
    });
    await execute(
      `INSERT INTO spec_generation_logs (spec_slug, model, provider, duration_ms, context_summary, context_summary_json, status, save_generation)
       VALUES ($1, 'explicit-draft', 'api', 0, 'legacy', $2, 'failed', 9002)`,
      ['repair-legacy', JSON.stringify({
        source: 'explicit-draft',
        workspaceId: 'ws-test',
        saveGeneration: 9002,
        contextCaptureStatus: { status: 'provided', reason: 'caller_supplied_context', contextUsed: 'provided', contextSummary: 'provided' },
        postSaveStages: {
          enrich: { requested: true, status: 'failed', reason: 'job_failed', error: 'prior failure' },
          matchSkills: { requested: false, status: 'skipped', reason: 'disabled_by_caller' },
          memorySynthesis: { requested: false, status: 'skipped', reason: 'disabled_by_caller' },
        },
      })],
    );

    const res = await request(app)
      .post('/api/specs/repair-legacy/repair')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test', stages: ['enrich'] });

    expect(res.status).toBe(200);
    expect(res.body.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'enqueue_enrich', status: 'repaired' }),
    ]));
    const run = await queryOne(
      `SELECT id FROM spec_post_save_workflow_runs WHERE workspace_id = 'ws-test' AND spec_id = 'repair-legacy' AND save_generation = 9002`,
    ) as { id: number } | undefined;
    expect(run).toBeDefined();

    const updatedLog = await queryOne(
      `SELECT context_summary_json FROM spec_generation_logs WHERE spec_slug = 'repair-legacy' AND save_generation = 9002`,
    ) as { context_summary_json: unknown } | undefined;
    const updatedSummary = parsePayload(updatedLog?.context_summary_json);
    expect(updatedSummary.workflow).toMatchObject({
      engine: 'spec-post-save-v1',
      source: 'repair',
      postSave: { enrich: true, matchSkills: false, memorySynthesis: false },
      postSavePolicy: {
        callerPolicy: {
          version: 'v1',
          presetId: 'repair_only',
          enrich: 'enqueue',
          skills: 'skip',
          memory: 'skip',
          onFailure: 'continue',
        },
        effectivePolicy: {
          version: 'v1',
          presetId: 'repair_only',
          enrich: 'enqueue',
          skills: 'skip',
          memory: 'skip',
          onFailure: 'continue',
        },
        legacyOptions: { enrich: true, matchSkills: false, memorySynthesis: false },
      },
    });
  });
});

describe('GET /api/specs (list)', () => {
  test('returns pending and approved specs with correct status', async () => {
    // Clean dirs to avoid cross-suite contamination (batch tests share os.tmpdir())
    const specsRoot = path.join(os.tmpdir(), 'forge', 'specs');
    if (fs.existsSync(specsRoot)) fs.rmSync(specsRoot, { recursive: true, force: true });

    const pendingDir = path.join(specsRoot, 'pending');
    const approvedDir = path.join(specsRoot, 'approved');

    seedSpecFile(pendingDir, 'my-pending-spec');
    seedSpecFile(approvedDir, 'my-approved-spec', { generatedAt: '2026-02-19T10:00:00.000Z' });

    const res = await request(app).get('/api/specs?workspaceId=ws-test').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);

    const pending = res.body.items.find((s: any) => s.id === 'my-pending-spec');
    const approved = res.body.items.find((s: any) => s.id === 'my-approved-spec');

    expect(pending).toBeDefined();
    expect(pending.status).toBe('pending');
    expect(pending.storyCount).toBe(1);

    expect(approved).toBeDefined();
    expect(approved.status).toBe('approved');
    expect(approved.approvedAt).toBeDefined();
  });

  test('filters by status=pending', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    const approvedDir = path.join(os.tmpdir(), 'forge', 'specs', 'approved');

    seedSpecFile(pendingDir, 'pend-only');
    seedSpecFile(approvedDir, 'appr-only');

    const res = await request(app).get('/api/specs?workspaceId=ws-test&status=pending').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('pend-only');
  });

  test('filters by status=approved', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    const approvedDir = path.join(os.tmpdir(), 'forge', 'specs', 'approved');

    seedSpecFile(pendingDir, 'pend-only2');
    seedSpecFile(approvedDir, 'appr-only2');

    const res = await request(app).get('/api/specs?workspaceId=ws-test&status=approved').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('appr-only2');
  });

  test('returns empty array when no specs exist', async () => {
    const res = await request(app).get('/api/specs?workspaceId=ws-test').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  test('missing workspaceId → 400', async () => {
    const res = await request(app).get('/api/specs').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(400);
  });

  test('unknown workspaceId → 404', async () => {
    const res = await request(app).get('/api/specs?workspaceId=nonexistent').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/specs/:id/approve', () => {
  test('moves file to approved/ and returns ok', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    const approvedDir = path.join(os.tmpdir(), 'forge', 'specs', 'approved');

    seedSpecFile(pendingDir, 'to-approve');

    const res = await request(app)
      .post('/api/specs/to-approve/approve')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.approvedPath).toContain('approved');
    expect(res.body.approvedPath).toContain('to-approve.json');

    // File moved: no longer in pending, exists in approved
    expect(fs.existsSync(path.join(pendingDir, 'to-approve.json'))).toBe(false);
    expect(fs.existsSync(path.join(approvedDir, 'to-approve.json'))).toBe(true);
  });

  test('emits WAL event with event_type=spec_approved', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    seedSpecFile(pendingDir, 'wal-approve');

    await request(app)
      .post('/api/specs/wal-approve/approve')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test' });

    const event = await queryOne(`SELECT * FROM wal_events WHERE event_type = 'spec_approved'`) as { event_type: string; spec_id: string; actor: string; payload: string };

    expect(event).toBeDefined();
    expect(event.spec_id).toBe('wal-approve');
    expect(event.actor).toBe('user');
    const payload = parsePayload(event.payload);
    expect(payload.workspaceId).toBe('ws-test');
  });

  test('creates approved/ directory if it does not exist', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    const approvedDir = path.join(os.tmpdir(), 'forge', 'specs', 'approved');

    seedSpecFile(pendingDir, 'auto-mkdir');
    // Ensure approved/ doesn't exist
    expect(fs.existsSync(approvedDir)).toBe(false);

    const res = await request(app)
      .post('/api/specs/auto-mkdir/approve')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test' });

    expect(res.status).toBe(200);
    expect(fs.existsSync(approvedDir)).toBe(true);
  });

  test('spec not found → 404', async () => {
    const res = await request(app)
      .post('/api/specs/ghost/approve')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test' });

    expect(res.status).toBe(404);
  });

  test('missing workspaceId → 400', async () => {
    const res = await request(app)
      .post('/api/specs/whatever/approve')
      .set('Authorization', `Bearer ${authToken}`)
      .send({});

    expect(res.status).toBe(400);
  });
});

describe('POST /api/specs/:id/reject', () => {
  test('deletes file and returns ok', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    seedSpecFile(pendingDir, 'to-reject');

    const res = await request(app)
      .post('/api/specs/to-reject/reject')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(fs.existsSync(path.join(pendingDir, 'to-reject.json'))).toBe(false);
  });

  test('emits WAL event with event_type=spec_rejected and reason', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    seedSpecFile(pendingDir, 'wal-reject');

    await request(app)
      .post('/api/specs/wal-reject/reject')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test', reason: 'Too many stories' });

    const event = await queryOne(`SELECT * FROM wal_events WHERE event_type = 'spec_rejected'`) as { event_type: string; spec_id: string; actor: string; payload: string };

    expect(event).toBeDefined();
    expect(event.spec_id).toBe('wal-reject');
    expect(event.actor).toBe('user');
    const payload = parsePayload(event.payload);
    expect(payload.reason).toBe('Too many stories');
  });

  test('spec not found → 404', async () => {
    const res = await request(app)
      .post('/api/specs/ghost/reject')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test' });

    expect(res.status).toBe(404);
  });
});

describe('GET /api/specs/:specId (detail)', () => {
  test('returns full spec JSON from pending', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    const seeded = seedSpecFile(pendingDir, 'detail-spec');

    const res = await request(app).get('/api/specs/detail-spec?workspaceId=ws-test').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.title).toBe(seeded.title);
    expect(res.body.userStories).toHaveLength(1);
  });

  test('returns full spec JSON from approved', async () => {
    const approvedDir = path.join(os.tmpdir(), 'forge', 'specs', 'approved');
    const seeded = seedSpecFile(approvedDir, 'approved-detail');

    const res = await request(app).get('/api/specs/approved-detail?workspaceId=ws-test').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.title).toBe(seeded.title);
  });

  test('spec not found → 404', async () => {
    const res = await request(app).get('/api/specs/nonexistent?workspaceId=ws-test').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(404);
  });

  test('missing workspaceId → 400', async () => {
    const res = await request(app).get('/api/specs/some-spec').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(400);
  });
});

// ─── US-001: Version History + Diff ───────────────────────────────────────────

describe('GET /api/specs/:specId/versions', () => {
  test('returns empty array when no versions exist', async () => {
    const res = await request(app).get('/api/specs/nonexistent-slug/versions').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    
    expect(res.body.items).toEqual([]);
  });

  test('returns versions after rejection creates a snapshot', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    seedSpecFile(pendingDir, 'versioned-spec', {
      title: 'Versioned Spec',
      userStories: [
        { id: 'US-001', title: 'Story one', description: 'Desc', acceptanceCriteria: ['AC1'], dependsOn: [], passes: false },
        { id: 'US-002', title: 'Story two', description: 'Desc2', acceptanceCriteria: ['AC2'], dependsOn: [], passes: false },
      ],
    });

    // Reject the spec (creates a version snapshot)
    await request(app)
      .post('/api/specs/versioned-spec/reject')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test', reason: 'Needs more stories' });

    const res = await request(app).get('/api/specs/versioned-spec/versions').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].version).toBe(1);
    expect(res.body.items[0].status).toBe('rejected');
    expect(res.body.items[0].rejectionReason).toBe('Needs more stories');
    expect(res.body.items[0].title).toBe('Versioned Spec');
    expect(res.body.items[0].storyCount).toBe(2);
    expect(res.body.items[0].createdAt).toBeDefined();
  });

  test('returns multiple versions in ascending order', async () => {
    // Manually insert two versions
    await execute(`INSERT INTO spec_versions (spec_slug, version, content_json, status) VALUES ($1, $2, $3, $4)`, ['multi-ver', 1, JSON.stringify({ title: 'V1', userStories: [] }), 'rejected']);
    await execute(`INSERT INTO spec_versions (spec_slug, version, content_json, status) VALUES ($1, $2, $3, $4)`, ['multi-ver', 2, JSON.stringify({ title: 'V2', userStories: [{ id: 'US-001', title: 'S1' }] }), 'pending']);

    const res = await request(app).get('/api/specs/multi-ver/versions').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0].version).toBe(1);
    expect(res.body.items[0].title).toBe('V1');
    expect(res.body.items[0].storyCount).toBe(0);
    expect(res.body.items[1].version).toBe(2);
    expect(res.body.items[1].title).toBe('V2');
    expect(res.body.items[1].storyCount).toBe(1);
  });
});

describe('GET /api/specs/:specId/diff', () => {
  beforeEach(async () => {
    // Seed two versions with different stories
    const v1 = {
      title: 'Auth System',
      userStories: [
        { id: 'US-001', title: 'Login', description: 'Login flow', acceptanceCriteria: ['AC1', 'AC2'], dependsOn: [] },
        { id: 'US-002', title: 'Signup', description: 'Signup flow', acceptanceCriteria: ['AC3'], dependsOn: ['US-001'] },
      ],
    };
    const v2 = {
      title: 'Auth System v2',
      userStories: [
        { id: 'US-001', title: 'Login', description: 'Improved login', acceptanceCriteria: ['AC1', 'AC2', 'AC4'], dependsOn: [] },
        { id: 'US-003', title: 'Password Reset', description: 'Reset flow', acceptanceCriteria: ['AC5'], dependsOn: ['US-001'] },
      ],
    };
    await execute(`INSERT INTO spec_versions (spec_slug, version, content_json, status) VALUES ($1, $2, $3, $4)`, ['diff-test', 1, JSON.stringify(v1), 'rejected']);
    await execute(`INSERT INTO spec_versions (spec_slug, version, content_json, status, rejection_reason) VALUES ($1, $2, $3, $4, $5)`, ['diff-test', 2, JSON.stringify(v2), 'pending', null]);
  });

  test('returns structured diff with added, removed, modified, unchanged stories', async () => {
    const res = await request(app).get('/api/specs/diff-test/diff?v1=1&v2=2').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);

    expect(res.body.specSlug).toBe('diff-test');
    expect(res.body.v1.version).toBe(1);
    expect(res.body.v2.version).toBe(2);

    const { diff } = res.body;
    expect(diff.titleChanged).toBe(true);
    expect(diff.oldTitle).toBe('Auth System');
    expect(diff.newTitle).toBe('Auth System v2');

    // US-001: modified (description + AC changed)
    const us001 = diff.stories.find((s: any) => s.id === 'US-001');
    expect(us001.changeType).toBe('modified');
    expect(us001.deltas).toBeDefined();
    const descDelta = us001.deltas.find((d: any) => d.field === 'description');
    expect(descDelta.old).toBe('Login flow');
    expect(descDelta.new).toBe('Improved login');
    const acDelta = us001.deltas.find((d: any) => d.field === 'acceptanceCriteria');
    expect(acDelta.added).toContain('AC4');
    expect(acDelta.removed).toEqual([]);

    // US-002: removed
    const us002 = diff.stories.find((s: any) => s.id === 'US-002');
    expect(us002.changeType).toBe('removed');
    expect(us002.story).toBeDefined();

    // US-003: added
    const us003 = diff.stories.find((s: any) => s.id === 'US-003');
    expect(us003.changeType).toBe('added');
    expect(us003.story.title).toBe('Password Reset');

    // Summary
    expect(diff.summary).toEqual({ added: 1, removed: 1, modified: 1, unchanged: 0 });
  });

  test('missing v1/v2 → 400', async () => {
    const res = await request(app).get('/api/specs/diff-test/diff?v1=1').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('v1 and v2');
  });

  test('same v1 and v2 → 400', async () => {
    const res = await request(app).get('/api/specs/diff-test/diff?v1=1&v2=1').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('different');
  });

  test('nonexistent version → 404', async () => {
    const res = await request(app).get('/api/specs/diff-test/diff?v1=1&v2=99').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('v99');
  });

  test('both versions missing → 404 mentioning both', async () => {
    const res = await request(app).get('/api/specs/diff-test/diff?v1=98&v2=99').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('v98');
    expect(res.body.error).toContain('v99');
  });
});

// ─── US-005: Full-Text Search Archive ──────────────────────────────────────────

/** Seed a spec with rich content for search tests */
function seedRichSpec(dir: string, slug: string, overrides?: Record<string, unknown>) {
  fs.mkdirSync(dir, { recursive: true });
  const spec = {
    title: overrides?.title ?? slug.replace(/-/g, ' '),
    userStories: overrides?.userStories ?? [
      {
        id: 'US-001',
        title: 'Story one',
        description: 'A basic description',
        acceptanceCriteria: ['Criterion alpha', 'Criterion beta'],
        dependsOn: [],
        passes: false,
      },
    ],
    generatedAt: overrides?.generatedAt ?? '2026-02-20T12:00:00.000Z',
  };
  fs.writeFileSync(path.join(dir, `${slug}.json`), JSON.stringify(spec, null, 2), 'utf8');
  return spec;
}

describe('GET /api/specs/archive (US-005 full-text search)', () => {
  test('q param searches across spec title', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    seedRichSpec(pendingDir, 'auth-system', { title: 'Authentication System' });
    seedRichSpec(pendingDir, 'payment-flow', { title: 'Payment Processing' });

    const res = await request(app).get('/api/specs/archive?workspaceId=ws-test&q=authentication').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('auth-system');
    expect(res.body.items[0].matchSnippets).toBeDefined();
    expect(res.body.items[0].matchSnippets.length).toBeGreaterThan(0);
    expect(res.body.items[0].matchSnippets[0].field).toBe('title');
    expect(res.body.items[0].matchSnippets[0].text).toContain('<mark>');
  });

  test('q param searches across story titles', async () => {
    const approvedDir = path.join(os.tmpdir(), 'forge', 'specs', 'approved');
    seedRichSpec(approvedDir, 'dashboard-spec', {
      title: 'Dashboard Features',
      userStories: [
        { id: 'US-001', title: 'User Analytics Widget', description: 'Shows analytics', acceptanceCriteria: ['Loads fast'], dependsOn: [] },
        { id: 'US-002', title: 'Notification Panel', description: 'Shows notifications', acceptanceCriteria: ['Real-time updates'], dependsOn: [] },
      ],
    });

    const res = await request(app).get('/api/specs/archive?workspaceId=ws-test&q=analytics').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('dashboard-spec');
    const storySnippet = res.body.items[0].matchSnippets.find((s: any) => s.field === 'storyTitle');
    expect(storySnippet).toBeDefined();
    expect(storySnippet.storyId).toBe('US-001');
  });

  test('q param searches across story descriptions', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    seedRichSpec(pendingDir, 'api-spec', {
      title: 'API Endpoints',
      userStories: [
        { id: 'US-001', title: 'Create user', description: 'Implement OAuth2 token-based authentication flow', acceptanceCriteria: ['Returns JWT'], dependsOn: [] },
      ],
    });

    const res = await request(app).get('/api/specs/archive?workspaceId=ws-test&q=OAuth2').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('api-spec');
    const descSnippet = res.body.items[0].matchSnippets.find((s: any) => s.field === 'storyDescription');
    expect(descSnippet).toBeDefined();
    expect(descSnippet.text).toContain('<mark>OAuth2</mark>');
  });

  test('q param searches across acceptance criteria', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    seedRichSpec(pendingDir, 'perf-spec', {
      title: 'Performance Improvements',
      userStories: [
        { id: 'US-001', title: 'Caching', description: 'Add cache', acceptanceCriteria: ['Response time under 50ms for cached queries', 'Cache invalidation on write'], dependsOn: [] },
      ],
    });

    const res = await request(app).get('/api/specs/archive?workspaceId=ws-test&q=invalidation').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('perf-spec');
    const acSnippet = res.body.items[0].matchSnippets.find((s: any) => s.field === 'acceptanceCriteria');
    expect(acSnippet).toBeDefined();
    expect(acSnippet.storyId).toBe('US-001');
  });

  test('results ranked by relevance — title matches rank higher', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    // This spec has "login" only in a story description
    seedRichSpec(pendingDir, 'general-spec', {
      title: 'General Features',
      userStories: [
        { id: 'US-001', title: 'Authentication', description: 'Implement login functionality', acceptanceCriteria: ['Works'], dependsOn: [] },
      ],
    });
    // This spec has "login" in the title
    seedRichSpec(pendingDir, 'login-system', {
      title: 'Login System',
      userStories: [
        { id: 'US-001', title: 'Basic form', description: 'A form', acceptanceCriteria: ['Renders'], dependsOn: [] },
      ],
    });

    const res = await request(app).get('/api/specs/archive?workspaceId=ws-test&q=login').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    // Title match should rank first
    expect(res.body.items[0].id).toBe('login-system');
    expect(res.body.items[0].relevanceScore).toBeGreaterThan(res.body.items[1].relevanceScore);
  });

  test('date range filter: createdAfter', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    seedRichSpec(pendingDir, 'old-spec', { title: 'Old Spec', generatedAt: '2026-01-01T00:00:00.000Z' });
    seedRichSpec(pendingDir, 'new-spec', { title: 'New Spec', generatedAt: '2026-02-15T00:00:00.000Z' });

    const res = await request(app).get('/api/specs/archive?workspaceId=ws-test&createdAfter=2026-02-01T00:00:00.000Z').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('new-spec');
  });

  test('date range filter: createdBefore', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    seedRichSpec(pendingDir, 'jan-spec', { title: 'January Spec', generatedAt: '2026-01-15T00:00:00.000Z' });
    seedRichSpec(pendingDir, 'feb-spec', { title: 'February Spec', generatedAt: '2026-02-15T00:00:00.000Z' });

    const res = await request(app).get('/api/specs/archive?workspaceId=ws-test&createdBefore=2026-02-01T00:00:00.000Z').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('jan-spec');
  });

  test('date range combined with text search', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    seedRichSpec(pendingDir, 'auth-old', { title: 'Auth Module', generatedAt: '2026-01-10T00:00:00.000Z' });
    seedRichSpec(pendingDir, 'auth-new', { title: 'Auth System v2', generatedAt: '2026-02-20T00:00:00.000Z' });
    seedRichSpec(pendingDir, 'payment-new', { title: 'Payment System', generatedAt: '2026-02-20T00:00:00.000Z' });

    const res = await request(app)
      .get('/api/specs/archive?workspaceId=ws-test&q=auth&createdAfter=2026-02-01T00:00:00.000Z')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('auth-new');
  });

  test('empty search returns all specs without snippets', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    seedRichSpec(pendingDir, 'spec-a', { title: 'Spec A' });
    seedRichSpec(pendingDir, 'spec-b', { title: 'Spec B' });

    const res = await request(app).get('/api/specs/archive?workspaceId=ws-test').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    // No matchSnippets or relevanceScore when no query
    expect(res.body.items[0].matchSnippets).toBeUndefined();
    expect(res.body.items[0].relevanceScore).toBeUndefined();
  });

  test('no results for unmatched query', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    seedRichSpec(pendingDir, 'some-spec', { title: 'Some Feature' });

    const res = await request(app).get('/api/specs/archive?workspaceId=ws-test&q=zzzznonexistent').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });

  test('search respects status filter', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    const approvedDir = path.join(os.tmpdir(), 'forge', 'specs', 'approved');
    seedRichSpec(pendingDir, 'auth-pending', { title: 'Auth Pending' });
    seedRichSpec(approvedDir, 'auth-approved', { title: 'Auth Approved' });

    const res = await request(app).get('/api/specs/archive?workspaceId=ws-test&q=auth&status=approved').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('auth-approved');
  });

  test('pagination works with search results', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    seedRichSpec(pendingDir, 'auth-one', { title: 'Auth One', generatedAt: '2026-02-20T12:00:00.000Z' });
    seedRichSpec(pendingDir, 'auth-two', { title: 'Auth Two', generatedAt: '2026-02-21T12:00:00.000Z' });
    seedRichSpec(pendingDir, 'auth-three', { title: 'Auth Three', generatedAt: '2026-02-22T12:00:00.000Z' });

    const res = await request(app).get('/api/specs/archive?workspaceId=ws-test&q=auth&limit=2&offset=0').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.total).toBe(3);
    expect(res.body.hasMore).toBe(true);

    // Second page
    const res2 = await request(app).get('/api/specs/archive?workspaceId=ws-test&q=auth&limit=2&offset=2').set('Authorization', `Bearer ${authToken}`);
    expect(res2.status).toBe(200);
    expect(res2.body.items).toHaveLength(1);
    expect(res2.body.hasMore).toBe(false);
  });
});

// ─── US-008: Batch Spec Generation with Brief Queue ────────────────────────────

describe('POST /api/specs/generate/batch', () => {
  test('accepts array of briefs and returns batchId + briefCount', async () => {
    mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 100, outputTokens: 200 } });

    const res = await request(app)
      .post('/api/specs/generate/batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        briefs: [
          { brief: 'Build user auth', workspaceId: 'ws-test', title: 'Auth Feature' },
          { brief: 'Build payments', workspaceId: 'ws-test', title: 'Payment Feature' },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.batchId).toBeDefined();
    expect(typeof res.body.batchId).toBe('string');
    expect(res.body.briefCount).toBe(2);
  });

  test('batch generation calls the Pi forge drafter when a brief sets agentOverride=pi', async () => {
    mockDraftSpecWithPi.mockResolvedValue({
      text: validLlmResponse,
      usage: { inputTokens: 11, outputTokens: 22 },
    });

    const createRes = await request(app)
      .post('/api/specs/generate/batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        briefs: [
          { brief: 'Build user auth', workspaceId: 'ws-test', title: 'Auth Feature', agentOverride: 'pi' },
        ],
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.batchId).toBeDefined();

    await new Promise((resolve) => setTimeout(resolve, 150));

    const statusRes = await request(app)
      .get(`/api/specs/generate/batch/${createRes.body.batchId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(statusRes.status).toBe(200);
    expect(mockDraftSpecWithPi).toHaveBeenCalled();
    expect(['generating', 'completed']).toContain(statusRes.body.items[0].status);
  });

  test('missing briefs array → 400', async () => {
    const res = await request(app)
      .post('/api/specs/generate/batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('briefs');
  });

  test('empty briefs array → 400', async () => {
    const res = await request(app)
      .post('/api/specs/generate/batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ briefs: [] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('empty');
  });

  test('brief missing required fields → 400 with index', async () => {
    const res = await request(app)
      .post('/api/specs/generate/batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        briefs: [
          { title: 'Valid', brief: 'Valid brief', workspaceId: 'ws-test' },
          { title: 'Missing WS', brief: 'Missing workspace' },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('index 1');
    expect(res.body.error).toContain('workspaceId');
  });

  test('brief with custom model is accepted (pass-through)', async () => {
    mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 100, outputTokens: 200 } });

    const res = await request(app)
      .post('/api/specs/generate/batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        briefs: [
          { title: 'Test Spec', brief: 'Test', workspaceId: 'ws-test', model: 'custom-model-v1' },
        ],
      });

    // Any model string is accepted for openai-compat pass-through
    expect(res.status).not.toBe(400);
  });

  test('emits batch_started WAL event', async () => {
    mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 100, outputTokens: 200 } });

    const res = await request(app)
      .post('/api/specs/generate/batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        briefs: [
          { brief: 'Build auth', workspaceId: 'ws-test', title: 'Batch WAL Test' },
        ],
      });

    expect(res.status).toBe(201);

    const event = await queryOne(`SELECT * FROM wal_events WHERE event_type = 'batch_started'`) as { event_type: string; payload: string };

    expect(event).toBeDefined();
    const payload = parsePayload(event.payload);
    expect(payload.batchId).toBe(res.body.batchId);
    expect(payload.briefCount).toBe(1);
  });
});

/** Poll batch status until finishedAt is set or timeout expires */
async function waitForBatch(batchId: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await request(app).get(`/api/specs/generate/batch/${batchId}`).set('Authorization', `Bearer ${authToken}`);
    if (res.status === 200 && res.body.finishedAt) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Batch ${batchId} did not finish within ${timeoutMs}ms`);
}

describe('GET /api/specs/generate/batch/:batchId', () => {
  test('returns batch status with per-brief progress', async () => {
    mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 100, outputTokens: 200 } });

    const createRes = await request(app)
      .post('/api/specs/generate/batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        briefs: [
          { brief: 'Build auth', workspaceId: 'ws-test', title: 'Batch Status A' },
          { brief: 'Build payments', workspaceId: 'ws-test', title: 'Batch Status B' },
        ],
      });

    expect(createRes.status).toBe(201);
    const { batchId } = createRes.body;

    // Wait for processing to complete
    await waitForBatch(batchId);

    const statusRes = await request(app).get(`/api/specs/generate/batch/${batchId}`).set('Authorization', `Bearer ${authToken}`);

    expect(statusRes.status).toBe(200);
    expect(statusRes.body.batchId).toBe(batchId);
    expect(statusRes.body.createdAt).toBeDefined();
    expect(statusRes.body.totalBriefs).toBe(2);
    expect(statusRes.body.items).toHaveLength(2);
    expect(statusRes.body.summary).toBeDefined();
    expect(typeof statusRes.body.summary.completed).toBe('number');
    expect(typeof statusRes.body.summary.failed).toBe('number');
    expect(typeof statusRes.body.summary.generating).toBe('number');
    expect(typeof statusRes.body.summary.queued).toBe('number');
  });

  test('nonexistent batchId → 404', async () => {
    const res = await request(app).get('/api/specs/generate/batch/nonexistent-id').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('not found');
  });

  test('completed batch has finishedAt and all items completed', async () => {
    mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 50, outputTokens: 100 } });

    const createRes = await request(app)
      .post('/api/specs/generate/batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        briefs: [
          { brief: 'Single brief', workspaceId: 'ws-test', title: 'Finished Batch' },
        ],
      });

    const { batchId } = createRes.body;

    // Wait for processing to complete
    await waitForBatch(batchId);

    const statusRes = await request(app).get(`/api/specs/generate/batch/${batchId}`).set('Authorization', `Bearer ${authToken}`);

    expect(statusRes.status).toBe(200);
    expect(statusRes.body.finishedAt).toBeDefined();
    expect(statusRes.body.summary.completed).toBe(1);
    expect(statusRes.body.summary.queued).toBe(0);
    expect(statusRes.body.summary.generating).toBe(0);
    expect(statusRes.body.items[0].status).toBe('completed');
    expect(statusRes.body.items[0].slug).toBeDefined();
  });

  test('failed briefs captured with errors, do not block remaining briefs', async () => {
    // First call fails, second succeeds
    mockChatComplete
      .mockRejectedValueOnce(new Error('LLM timeout'))
      .mockResolvedValueOnce({ text: validLlmResponse, usage: { inputTokens: 50, outputTokens: 100 } });

    const createRes = await request(app)
      .post('/api/specs/generate/batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        briefs: [
          { brief: 'Will fail', workspaceId: 'ws-test', title: 'Failing Brief' },
          { brief: 'Will succeed', workspaceId: 'ws-test', title: 'Succeeding Brief' },
        ],
      });

    const { batchId } = createRes.body;

    // Wait for both to process
    await waitForBatch(batchId);

    const statusRes = await request(app).get(`/api/specs/generate/batch/${batchId}`).set('Authorization', `Bearer ${authToken}`);

    expect(statusRes.status).toBe(200);
    expect(statusRes.body.finishedAt).toBeDefined();
    expect(statusRes.body.summary.failed).toBe(1);
    expect(statusRes.body.summary.completed).toBe(1);

    // First item failed with error message
    const failedItem = statusRes.body.items.find((i: any) => i.status === 'failed');
    expect(failedItem).toBeDefined();
    expect(failedItem.error).toContain('LLM timeout');

    // Second item completed successfully
    const completedItem = statusRes.body.items.find((i: any) => i.status === 'completed');
    expect(completedItem).toBeDefined();
    expect(completedItem.slug).toBeDefined();
  });

  test('workspace not found for a brief sets status to failed', async () => {
    mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 50, outputTokens: 100 } });

    const createRes = await request(app)
      .post('/api/specs/generate/batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        briefs: [
          { brief: 'Bad workspace', workspaceId: 'nonexistent-ws', title: 'Bad WS' },
          { brief: 'Good workspace', workspaceId: 'ws-test', title: 'Good WS' },
        ],
      });

    const { batchId } = createRes.body;
    await waitForBatch(batchId);

    const statusRes = await request(app).get(`/api/specs/generate/batch/${batchId}`).set('Authorization', `Bearer ${authToken}`);

    expect(statusRes.status).toBe(200);
    expect(statusRes.body.summary.failed).toBe(1);
    expect(statusRes.body.summary.completed).toBe(1);

    const failedItem = statusRes.body.items[0];
    expect(failedItem.status).toBe('failed');
    expect(failedItem.error).toContain('Workspace not found');
  });

  test('emits batch_progress WAL events during processing', async () => {
    mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 50, outputTokens: 100 } });

    const createRes = await request(app)
      .post('/api/specs/generate/batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        briefs: [
          { brief: 'Progress test', workspaceId: 'ws-test', title: 'Progress Brief' },
        ],
      });

    const batchId = createRes.body.batchId;
    await waitForBatch(batchId);
    const allEvents = await query(`SELECT * FROM wal_events WHERE event_type = 'batch_progress' ORDER BY id ASC`) as { payload: string }[];
    // Filter to only events from this batch (avoids cross-test contamination)
    const events = allEvents.filter(e => {
      try { return parsePayload(e.payload).batchId === batchId; } catch { return false; }
    });

    // Should have at least 2 progress events: generating + completed/failed
    expect(events.length).toBeGreaterThanOrEqual(2);

    const firstPayload = parsePayload(events[0].payload);
    expect(firstPayload.batchId).toBe(batchId);
    expect(firstPayload.briefIndex).toBe(0);
    expect(firstPayload.totalBriefs).toBe(1);
    expect(firstPayload.status).toBe('generating');

    const secondPayload = parsePayload(events[1].payload);
    expect(secondPayload.status).toBe('completed');
    expect(secondPayload.slug).toBeDefined();
  });
});

// ─── V2-083: Story Exclusion ─────────────────────────────────────────────────

describe('V2-083: Story exclusion', () => {
  function seedSpecWithStories(dir: string, slug: string) {
    fs.mkdirSync(dir, { recursive: true });
    const spec = {
      title: slug.replace(/-/g, ' '),
      userStories: [
        { id: 'US-001', title: 'Story one', description: 'Desc 1', acceptanceCriteria: ['AC1'], dependsOn: [], passes: false },
        { id: 'US-002', title: 'Story two', description: 'Desc 2', acceptanceCriteria: ['AC2'], dependsOn: ['US-001'], passes: false },
        { id: 'US-003', title: 'Story three', description: 'Desc 3', acceptanceCriteria: ['AC3'], dependsOn: [], passes: false },
      ],
      generatedAt: '2026-02-20T12:00:00.000Z',
    };
    const specPath = path.join(dir, `${slug}.json`);
    fs.writeFileSync(specPath, JSON.stringify(spec, null, 2), 'utf8');
    return { spec, specPath };
  }

  test('PATCH /:specId/stories/:storyId toggles excluded flag', async () => {
    const approvedDir = path.join(os.tmpdir(), 'forge', 'specs', 'approved');
    seedSpecWithStories(approvedDir, 'excl-test');

    // Exclude US-002
    const res = await request(app)
      .patch('/api/specs/excl-test/stories/US-002')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test', excluded: true });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.story.excluded).toBe(true);

    // Verify persisted to JSON
    const content = JSON.parse(fs.readFileSync(path.join(approvedDir, 'excl-test.json'), 'utf8'));
    expect(content.userStories[1].excluded).toBe(true);
    expect(content.userStories[0].excluded).toBeFalsy();

    // Re-include US-002
    const res2 = await request(app)
      .patch('/api/specs/excl-test/stories/US-002')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test', excluded: false });

    expect(res2.status).toBe(200);
    expect(res2.body.story.excluded).toBe(false);
  });

  test('PATCH emits WAL event for exclusion toggle', async () => {
    const approvedDir = path.join(os.tmpdir(), 'forge', 'specs', 'approved');
    seedSpecWithStories(approvedDir, 'excl-wal');

    await request(app)
      .patch('/api/specs/excl-wal/stories/US-001')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test', excluded: true });

    const events = await query(`SELECT * FROM wal_events WHERE event_type = 'story_excluded' AND spec_id = 'excl-wal'`) as { story_id: string; payload: string }[];

    expect(events).toHaveLength(1);
    expect(events[0].story_id).toBe('US-001');
  });

  test('PATCH returns 404 for non-existent story', async () => {
    const approvedDir = path.join(os.tmpdir(), 'forge', 'specs', 'approved');
    seedSpecWithStories(approvedDir, 'excl-404');

    const res = await request(app)
      .patch('/api/specs/excl-404/stories/US-999')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test', excluded: true });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Story not found');
  });

  test('bulk exclude marks multiple stories as excluded', async () => {
    const approvedDir = path.join(os.tmpdir(), 'forge', 'specs', 'approved');
    seedSpecWithStories(approvedDir, 'bulk-excl');

    const res = await request(app)
      .post('/api/specs/bulk-excl/stories/bulk')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test', action: 'exclude', storyIds: ['US-001', 'US-003'] });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.affectedCount).toBe(2);

    const content = JSON.parse(fs.readFileSync(path.join(approvedDir, 'bulk-excl.json'), 'utf8'));
    expect(content.userStories[0].excluded).toBe(true);
    expect(content.userStories[1].excluded).toBeFalsy();
    expect(content.userStories[2].excluded).toBe(true);
  });

  test('bulk include re-includes excluded stories', async () => {
    const approvedDir = path.join(os.tmpdir(), 'forge', 'specs', 'approved');
    seedSpecWithStories(approvedDir, 'bulk-incl');

    // First exclude
    await request(app)
      .post('/api/specs/bulk-incl/stories/bulk')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test', action: 'exclude', storyIds: ['US-001', 'US-002'] });

    // Then re-include
    const res = await request(app)
      .post('/api/specs/bulk-incl/stories/bulk')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test', action: 'include', storyIds: ['US-001'] });

    expect(res.status).toBe(200);

    const content = JSON.parse(fs.readFileSync(path.join(approvedDir, 'bulk-incl.json'), 'utf8'));
    expect(content.userStories[0].excluded).toBe(false);
    expect(content.userStories[1].excluded).toBe(true);
  });

  test('story_results accepts excluded status', async () => {
    // Create a pipeline run to reference
    const runResult = await queryOne<{ id: number }>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status) VALUES ('test.json', 'ws-test', 'running') RETURNING id`);
    const runId = runResult!.id;

    // Insert excluded story result
    await execute(`INSERT INTO story_results (run_id, story_id, status, finished_at) VALUES ($1, 'US-001', 'excluded', NOW())`, [runId]);

    const row = await queryOne(`SELECT * FROM story_results WHERE run_id = $1 AND story_id = 'US-001'`, [runId]) as { status: string };

    expect(row.status).toBe('excluded');
  });
});

describe('PUT /api/specs/:specId/stories/:storyId', () => {
  function seedEditableSpec(dir: string, slug: string) {
    fs.mkdirSync(dir, { recursive: true });
    const spec = {
      title: slug,
      userStories: [
        {
          id: 'US-001',
          title: 'Original title',
          description: 'Original description',
          acceptanceCriteria: ['AC1'],
          complexity: 2,
          dependsOn: [],
          passes: false,
        },
      ],
      generatedAt: '2026-03-12T00:00:00.000Z',
    };
    fs.writeFileSync(path.join(dir, `${slug}.json`), JSON.stringify(spec, null, 2), 'utf8');
  }

  test('updates title and complexity for a single story', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    seedEditableSpec(pendingDir, 'story-edit-test');

    const res = await request(app)
      .put('/api/specs/story-edit-test/stories/US-001')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-test',
        title: 'Edited title',
        complexity: 5,
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.story.title).toBe('Edited title');
    expect(res.body.story.complexity).toBe(5);

    const content = JSON.parse(fs.readFileSync(path.join(pendingDir, 'story-edit-test.json'), 'utf8'));
    expect(content.userStories[0].title).toBe('Edited title');
    expect(content.userStories[0].complexity).toBe(5);
  });
});

// ─── SV-001: GET /:specId/check — Structural spec validation ──────────────────

describe('GET /api/specs/:id/check', () => {
  // The global beforeEach re-requires the server (DB migrations) — allow extra time
  jest.setTimeout(60_000);

  function seedCheckSpec(dir: string, slug: string, overrides?: Record<string, unknown>) {
    fs.mkdirSync(dir, { recursive: true });
    const spec = {
      title: slug.replace(/-/g, ' '),
      userStories: [
        {
          id: 'US-001',
          title: 'Story one',
          description: 'A valid description',
          acceptanceCriteria: ['Criterion one', 'Criterion two'],
          dependsOn: [],
          passes: false,
        },
      ],
      generatedAt: '2026-03-12T00:00:00.000Z',
      ...overrides,
    };
    fs.writeFileSync(path.join(dir, `${slug}.json`), JSON.stringify(spec, null, 2), 'utf8');
    return spec;
  }

  test('GET /api/specs/:id/check returns 404 for unknown spec', async () => {
    const res = await request(app)
      .get('/api/specs/nonexistent-spec-xyz/check?workspaceId=ws-test')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/spec not found/i);
  });

  test('GET /api/specs/:id/check returns {valid: true} for valid spec', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    seedCheckSpec(pendingDir, 'valid-check-spec');

    const res = await request(app)
      .get('/api/specs/valid-check-spec/check?workspaceId=ws-test')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.errors).toEqual([]);
    expect(res.body.warnings).toBeDefined();
    expect(res.body.stats).toBeDefined();
    expect(res.body.stats.totalStories).toBe(1);
  });

  test('GET /api/specs/:id/check returns errors for spec with missing required fields', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });
    const badSpec = {
      title: 'Bad Spec',
      userStories: [
        {
          id: 'US-001',
          // missing title, description, acceptanceCriteria
        },
      ],
      generatedAt: '2026-03-12T00:00:00.000Z',
    };
    fs.writeFileSync(path.join(pendingDir, 'bad-check-spec.json'), JSON.stringify(badSpec, null, 2), 'utf8');

    const res = await request(app)
      .get('/api/specs/bad-check-spec/check?workspaceId=ws-test')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.errors.length).toBeGreaterThan(0);
    const titleError = res.body.errors.find((e: any) => e.field === 'title');
    expect(titleError).toBeDefined();
  });

  test('GET /api/specs/:id/check returns 404 when workspaceId is not in DB', async () => {
    const res = await request(app)
      .get('/api/specs/some-spec/check?workspaceId=nonexistent-ws')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/workspace not found/i);
  });

  test('GET /api/specs/:id/check returns 400 when workspaceId is missing', async () => {
    const res = await request(app)
      .get('/api/specs/some-spec/check')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(400);
  });

  test('GET /api/specs/:id/check finds spec in approved dir', async () => {
    const approvedDir = path.join(os.tmpdir(), 'forge', 'specs', 'approved');
    seedCheckSpec(approvedDir, 'approved-check-spec');

    const res = await request(app)
      .get('/api/specs/approved-check-spec/check?workspaceId=ws-test')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });

  test('GET /api/specs/:id/check detects orphaned dependsOn references', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });
    const orphanSpec = {
      title: 'Orphan Spec',
      userStories: [
        {
          id: 'US-001',
          title: 'Story one',
          description: 'Desc',
          acceptanceCriteria: ['AC1'],
          dependsOn: ['US-999'], // US-999 does not exist
          passes: false,
        },
      ],
      generatedAt: '2026-03-12T00:00:00.000Z',
    };
    fs.writeFileSync(path.join(pendingDir, 'orphan-check-spec.json'), JSON.stringify(orphanSpec, null, 2), 'utf8');

    const res = await request(app)
      .get('/api/specs/orphan-check-spec/check?workspaceId=ws-test')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    const orphanError = res.body.errors.find((e: any) => e.field === 'dependsOn');
    expect(orphanError).toBeDefined();
    expect(orphanError.message).toContain('US-999');
  });
});

describe('POST /api/specs/:id/assign-models', () => {
  const specId = 'assign-models-test-spec';

  // Ensure RORCA_AGENT is always a valid value for server module load
  beforeEach(() => {
    process.env.RORCA_AGENT = 'claude';
    delete process.env.RORCA_MODEL;
  });

  afterEach(async () => {
    process.env.RORCA_AGENT = 'claude';
    delete process.env.RORCA_MODEL;
    // Remove any workspace env vars seeded for these tests
    await execute(`DELETE FROM workspace_env_vars WHERE workspace_id = 'ws-test'`).catch(() => {});
  });

  function makeSpecFile(stories: object[], dir: 'pending' | 'approved') {
    for (const existingDir of ['pending', 'approved'] as const) {
      const existingPath = path.join(os.tmpdir(), 'forge', 'specs', existingDir, `${specId}.json`);
      if (fs.existsSync(existingPath)) {
        fs.rmSync(existingPath, { force: true });
      }
    }
    const specsDir = path.join(os.tmpdir(), 'forge', 'specs', dir);
    fs.mkdirSync(specsDir, { recursive: true });
    const specContent = {
      title: specId,
      userStories: stories,
      generatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(specsDir, `${specId}.json`), JSON.stringify(specContent, null, 2), 'utf8');
    return path.join(specsDir, `${specId}.json`);
  }

  test('returns 400 when workspaceId is missing', async () => {
    const res = await request(app)
      .post(`/api/specs/${specId}/assign-models`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/workspaceId/i);
  });

  test('returns 404 when spec does not exist', async () => {
    const res = await request(app)
      .post('/api/specs/nonexistent-spec/assign-models')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test' });

    expect(res.status).toBe(404);
  });

  test('returns { storiesAssigned: 0, skipped: false, breakdown: [] } for empty spec', async () => {
    makeSpecFile([], 'pending');

    const res = await request(app)
      .post(`/api/specs/${specId}/assign-models`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test' });

    expect(res.status).toBe(200);
    expect(res.body.storiesAssigned).toBe(0);
    expect(res.body.skipped).toBe(false);
    expect(res.body.breakdown).toEqual([]);
  });

  test('RORCA_AGENT=claude: returns complexity breakdown using the configured model', async () => {
    makeSpecFile([
      {
        id: 'US-001',
        title: 'Update config label',
        description: 'Update config label copy for onboarding',
        acceptanceCriteria: ['Label reads "Get Started"'],
        dependsOn: [],
        passes: false,
      },
      {
        id: 'US-002',
        title: 'Implement security architecture',
        description: 'Design and implement security architecture for authentication and payments migration',
        acceptanceCriteria: ['All auth flows are secured', 'Payment data encrypted'],
        dependsOn: ['US-001'],
        passes: false,
      },
    ], 'pending');

    // RORCA_AGENT=claude already set by beforeEach
    const res = await request(app)
      .post(`/api/specs/${specId}/assign-models`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test' });

    expect(res.status).toBe(200);
    expect(res.body.storiesAssigned).toBe(2);
    expect(res.body.skipped).toBe(false);
    expect(res.body.breakdown).toHaveLength(2);

    for (const entry of res.body.breakdown) {
      expect(entry).toHaveProperty('storyId');
      expect(entry).toHaveProperty('complexity');
      expect(['low', 'medium', 'high']).toContain(entry.complexity);
      expect(entry).toHaveProperty('model');
      expect(entry.model).toBe('(user-configured)');
      expect(entry).toHaveProperty('reason');
      expect(typeof entry.reason).toBe('string');
    }
  });

  test('RORCA_AGENT=codex: returns skipped=true without modifying spec', async () => {
    const specFile = makeSpecFile([
      {
        id: 'US-001',
        title: 'Add feature',
        description: 'Add a basic feature',
        acceptanceCriteria: ['Feature works'],
        dependsOn: [],
        passes: false,
      },
    ], 'pending');

    const beforeContent = fs.readFileSync(specFile, 'utf8');

    process.env.RORCA_AGENT = 'codex';

    const res = await request(app)
      .post(`/api/specs/${specId}/assign-models`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test' });

    expect(res.status).toBe(200);
    expect(res.body.storiesAssigned).toBe(0);
    expect(res.body.skipped).toBe(true);
    expect(res.body.reason).toMatch(/codex/i);
    expect(res.body.reason).toMatch(/ChatGPT subscription/i);

    // Spec file must NOT be modified
    const afterContent = fs.readFileSync(specFile, 'utf8');
    expect(afterContent).toBe(beforeContent);
  });

  test('dryRun=true: returns breakdown without writing story.model to spec file', async () => {
    const specFile = makeSpecFile([
      {
        id: 'US-001',
        title: 'Implement architecture for payments',
        description: 'Design architecture for payments system migration',
        acceptanceCriteria: ['Architecture documented'],
        dependsOn: [],
        passes: false,
      },
    ], 'pending');

    const beforeContent = JSON.parse(fs.readFileSync(specFile, 'utf8'));
    expect(beforeContent.userStories[0].model).toBeUndefined();

    // RORCA_AGENT=claude already set by beforeEach
    const res = await request(app)
      .post(`/api/specs/${specId}/assign-models`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test', dryRun: true });

    expect(res.status).toBe(200);
    expect(res.body.breakdown).toHaveLength(1);

    // File must NOT have story.model written
    const afterContent = JSON.parse(fs.readFileSync(specFile, 'utf8'));
    expect(afterContent.userStories[0].model).toBeUndefined();
  });

  test('dryRun=false (default): does not write per-story model overrides to spec file', async () => {
    makeSpecFile([
      {
        id: 'US-001',
        title: 'Add CRUD endpoints',
        description: 'Add CRUD endpoints for config resource',
        acceptanceCriteria: ['GET/POST/PUT/DELETE all work'],
        dependsOn: [],
        passes: false,
      },
    ], 'pending');

    // RORCA_AGENT=claude already set by beforeEach
    const res = await request(app)
      .post(`/api/specs/${specId}/assign-models`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test' });

    expect(res.status).toBe(200);
    expect(res.body.storiesAssigned).toBe(1);

    // Per-story model cascading was removed — the configured run model is used.
    const specFile = path.join(os.tmpdir(), 'forge', 'specs', 'pending', `${specId}.json`);
    const afterContent = JSON.parse(fs.readFileSync(specFile, 'utf8'));
    expect(afterContent.userStories[0].model).toBeUndefined();
  });

  test('RORCA_AGENT=opencode with openai/gpt-4o: all stories use the configured model', async () => {
    makeSpecFile([
      {
        id: 'US-001',
        title: 'Update config label',
        description: 'Update the CRUD config label copy',
        acceptanceCriteria: ['Label updated'],
        dependsOn: [],
        passes: false,
      },
      {
        id: 'US-002',
        title: 'Security architecture for payments',
        description: 'Implement security architecture for authentication payments migration',
        acceptanceCriteria: ['Security audit passes', 'Payment flows encrypted', 'Architecture reviewed'],
        dependsOn: [],
        passes: false,
      },
    ], 'pending');

    process.env.RORCA_AGENT = 'opencode';
    process.env.RORCA_MODEL = 'openai/gpt-4o';

    const res = await request(app)
      .post(`/api/specs/${specId}/assign-models`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test' });

    expect(res.status).toBe(200);
    expect(res.body.storiesAssigned).toBe(2);

    const lowStory = res.body.breakdown.find((b: any) => b.storyId === 'US-001');
    const highStory = res.body.breakdown.find((b: any) => b.storyId === 'US-002');

    expect(lowStory).toBeDefined();
    expect(highStory).toBeDefined();
    expect(lowStory.model).toBe('openai/gpt-4o');
    expect(highStory.model).toBe('openai/gpt-4o');
  });

  test('keywords architecture/security/payments/migration in title+description score high; copy/config/CRUD/label score low', async () => {
    makeSpecFile([
      {
        id: 'US-001',
        title: 'Implement security architecture',
        description: 'Design security architecture for payments system migration',
        acceptanceCriteria: ['All routes secured'],
        dependsOn: [],
        passes: false,
      },
      {
        id: 'US-002',
        title: 'Update CRUD config',
        description: 'Update the config label copy for onboarding',
        acceptanceCriteria: ['Label shows correct text'],
        dependsOn: [],
        passes: false,
      },
    ], 'pending');

    // RORCA_AGENT=claude already set by beforeEach
    const res = await request(app)
      .post(`/api/specs/${specId}/assign-models`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test' });

    expect(res.status).toBe(200);

    const highStory = res.body.breakdown.find((b: any) => b.storyId === 'US-001');
    const lowStory = res.body.breakdown.find((b: any) => b.storyId === 'US-002');

    expect(highStory.complexity).toBe('high');
    expect(lowStory.complexity).toBe('low');
  });

  test('falls back to process.env when workspace_env_vars do not override agent config', async () => {
    makeSpecFile([
      {
        id: 'US-001',
        title: 'Add feature',
        description: 'Add a basic feature',
        acceptanceCriteria: ['Feature works'],
        dependsOn: [],
        passes: false,
      },
    ], 'pending');

    // RORCA_AGENT=claude set by beforeEach; no workspace env var means process.env is used
    // Insert raw (non-encrypted) value via direct DB insert won't work with decryptToken,
    // so test the fallback: no workspace env var means process.env is used
    const res = await request(app)
      .post(`/api/specs/${specId}/assign-models`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test' });

    // Should use process.env.RORCA_AGENT=claude fallback
    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe(false);
    for (const entry of res.body.breakdown) {
      expect(entry.model).toBe('(user-configured)');
    }
  });

  test('works with spec in approved directory', async () => {
    makeSpecFile([
      {
        id: 'US-001',
        title: 'Simple feature',
        description: 'A simple feature implementation',
        acceptanceCriteria: ['Works correctly'],
        dependsOn: [],
        passes: false,
      },
    ], 'approved');

    // RORCA_AGENT=claude already set by beforeEach
    const res = await request(app)
      .post(`/api/specs/${specId}/assign-models`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test' });


    expect(res.status).toBe(200);
    expect(res.body.storiesAssigned).toBe(1);
  });
});

describe('POST /api/specs/:specId/enrich (CTM-007 canonical context parity)', () => {
  const specId = 'enrich-parity-spec';

  function makeSpecFile(stories: object[], dir: 'pending' | 'approved' = 'pending') {
    for (const existingDir of ['pending', 'approved'] as const) {
      const existingPath = path.join(os.tmpdir(), 'forge', 'specs', existingDir, `${specId}.json`);
      if (fs.existsSync(existingPath)) {
        fs.rmSync(existingPath, { force: true });
      }
    }
    const specsDir = path.join(os.tmpdir(), 'forge', 'specs', dir);
    fs.mkdirSync(specsDir, { recursive: true });
    const specContent = {
      title: 'Enrich Parity Spec',
      userStories: stories,
      generatedAt: new Date().toISOString(),
    };
    const file = path.join(specsDir, `${specId}.json`);
    fs.writeFileSync(file, JSON.stringify(specContent, null, 2), 'utf8');
    return file;
  }

  test('persists a canonical context_summary_json matching the generate/persist contract', async () => {
    mockChatComplete.mockResolvedValue({
      text: '- Relevant convention: use apiFetch\n- Gotcha: strip claude env vars',
      usage: { inputTokens: 12, outputTokens: 34 },
    });

    makeSpecFile([
      { id: 'US-001', title: 'Login', description: 'Build login flow', acceptanceCriteria: ['User can submit credentials'], dependsOn: [] },
      { id: 'US-002', title: 'Dashboard', description: 'Show dashboard', acceptanceCriteria: ['Shows recent activity'], dependsOn: ['US-001'] },
    ]);

    const res = await request(app)
      .post(`/api/specs/${specId}/enrich`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.storiesEnriched).toBe(2);
    // retrieval_method must use the canonical vocabulary shared with
    // memory-router / generate / persist, never a bespoke string.
    expect(['cache', 'search', 'hybrid', 'none']).toContain(res.body.retrieval_method);

    const logRes = await request(app)
      .get(`/api/specs/${specId}/generation-log`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(logRes.status).toBe(200);
    expect(logRes.body).toBeTruthy();
    expect(logRes.body.spec_slug).toBe(specId);
    expect(logRes.body.status).toBe('completed');
    expect(logRes.body.enriched).toBe(true);
    expect(['cache', 'search', 'hybrid', 'none']).toContain(logRes.body.retrieval_method);
    expect(logRes.body.retrieval_method).toBe(res.body.retrieval_method);

    const summary = parsePayload(logRes.body.context_summary_json) as {
      directionLayers: { l1: unknown; l2: { present: unknown; domain: unknown }; l3: unknown };
      skills: unknown;
      memoryEntries: unknown;
      modelContextWindow: unknown;
      memory?: unknown;
      tokenBudget?: unknown;
      flags?: unknown;
    };

    // Canonical directionLayers is an OBJECT ({l1, l2:{present,domain}, l3}),
    // not the legacy array-of-{layer,present} shape.
    expect(Array.isArray(summary.directionLayers)).toBe(false);
    expect(typeof summary.directionLayers.l1).toBe('boolean');
    expect(typeof summary.directionLayers.l2.present).toBe('boolean');
    expect('domain' in summary.directionLayers.l2).toBe(true);
    expect(typeof summary.directionLayers.l3).toBe('boolean');

    // Canonical scalar fields present; divergent enrich-only fields absent.
    expect(Array.isArray(summary.skills)).toBe(true);
    expect(typeof summary.memoryEntries).toBe('number');
    expect(summary.modelContextWindow).toBe(200000);
    expect(summary.memory).toBeUndefined();
    expect(summary.tokenBudget).toBeUndefined();
    expect(summary.flags).toBeUndefined();

    // The annotation came from chatComplete().text (ChatResult), not a stringified
    // ChatResult — verify it was appended under a Context heading on disk.
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(os.tmpdir(), 'forge', 'specs', 'pending', `${specId}.json`), 'utf8'),
    ) as { userStories: Array<{ description: string }> };
    expect(onDisk.userStories[0].description).toContain('## Context');
    expect(onDisk.userStories[0].description).toContain('use apiFetch');
    expect(onDisk.userStories[0].description).not.toContain('[object Object]');
  });

  test('reports retrieval_method none and omits retrieval block when no stories', async () => {
    makeSpecFile([]);

    const res = await request(app)
      .post(`/api/specs/${specId}/enrich`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test' });

    expect(res.status).toBe(200);
    expect(res.body.storiesEnriched).toBe(0);
    expect(res.body.retrieval_method).toBe('none');
  });

  test('survives per-story chatComplete failures and still writes a completed log (fallback)', async () => {
    // First story annotation rejects, second resolves — enrich must skip the
    // failed story rather than failing the whole run.
    mockChatComplete
      .mockRejectedValueOnce(new Error('Rate limit reached'))
      .mockResolvedValue({ text: '- annotation ok', usage: { inputTokens: 5, outputTokens: 7 } });

    makeSpecFile([
      { id: 'US-001', title: 'First', description: 'First story', acceptanceCriteria: ['AC1'], dependsOn: [] },
      { id: 'US-002', title: 'Second', description: 'Second story', acceptanceCriteria: ['AC2'], dependsOn: [] },
    ]);

    const res = await request(app)
      .post(`/api/specs/${specId}/enrich`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // One story failed → only one enriched, run still succeeds.
    expect(res.body.storiesEnriched).toBe(1);

    const logRes = await request(app)
      .get(`/api/specs/${specId}/generation-log`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(logRes.status).toBe(200);
    expect(logRes.body.status).toBe('completed');
    expect(logRes.body.enriched).toBe(true);
  });
});
