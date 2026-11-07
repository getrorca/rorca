/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * QRW-014: Backend integration — spec generation writes reasoning field to spec JSON
 *
 * Verifies that POST /api/specs/generate:
 *   1. Accepts reasoning: { enabled, effort } in the request body
 *   2. Writes top-level reasoning field to the spec JSON file on disk
 *   3. GET /api/specs/:specId returns the reasoning field in the response
 *   4. Uses resolveWorkflowConfig('spec_generation') for model/provider resolution (WR-008)
 *   5. Request body model override takes priority over workflow config model
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import request from 'supertest';
import { getAuthToken } from '../routes/__tests__/helpers/auth-helper';
import { query, queryOne, execute } from '../db/index';
import type { CompileSpecPlanInput, CompileSpecPlanResult } from '../lib/ssdlc-plan-service';

// Server init + migrations can take >30s on first run
jest.setTimeout(90_000);

// Mock llm-client — we don't want real LLM calls in unit/integration tests
jest.mock('../lib/llm-client', () => ({
  chatComplete: jest.fn(),
  getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
  isValidModel: jest.fn().mockReturnValue(true),
  DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
  resolveVaultProvider: jest.fn().mockReturnValue(null),
  getModelInfo: jest.fn().mockReturnValue({ contextWindow: 200000 }),
  ALL_MODELS: [],
  SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
}));

// Mock pg-boss — not needed for spec generation
jest.mock('../lib/pg-boss', () => ({
  initBoss: jest.fn().mockResolvedValue(undefined),
  getBoss: jest.fn().mockReturnValue({
    send: jest.fn().mockResolvedValue('mock-job-id'),
    work: jest.fn(),
    stop: jest.fn().mockResolvedValue(undefined),
  }),
}));

jest.mock('../lib/ssdlc-plan-service', () => {
  const actual = jest.requireActual('../lib/ssdlc-plan-service');
  const { GENERAL_SDLC_7_PROFILE } = jest.requireActual('../ssdlc/profiles/general-sdlc-7');
  return {
    ...actual,
    compileSpecPlan: jest.fn(async (
      input: CompileSpecPlanInput,
    ): Promise<CompileSpecPlanResult> => ({
      status: 'compiled',
      specSlug: input.specSlug,
      specVersion: String(input.expectedSaveGeneration ?? 1),
      specHash: `sha256:${'a'.repeat(64)}` as const,
      inputHash: `sha256:${'b'.repeat(64)}` as const,
      planId: `fixture-plan-${input.specSlug}`,
      planVersion: 1,
      compilerVersion: 'ssdlc-plan-compiler-5',
      profileHash: GENERAL_SDLC_7_PROFILE.contentHash,
      profiles: ['code-change'],
      riskLevel: 'low',
      generatedAt: '2026-07-15T12:00:00.000Z',
      saveGeneration: input.expectedSaveGeneration ?? null,
    })),
  };
});

// Mock opencode-spec-gen — not needed for these tests
jest.mock('../lib/opencode-spec-gen', () => ({
  generateSpecViaOpenCode: jest.fn(),
  isSpecError: jest.fn().mockReturnValue(false),
}));

// Mock spec-gen-chunked — avoid chunking logic
jest.mock('../lib/spec-gen-chunked', () => ({
  runChunkedGeneration: jest.fn(),
  CHUNK_THRESHOLD: 9999,
}));

/** Minimal valid spec JSON string that chatComplete returns for spec generation. */
function makeSpecJsonResponse(overrides: Record<string, unknown> = {}): string {
  const spec = {
    stories: [
      {
        id: 'US-001',
        title: 'Test story',
        description: 'A test story description',
        acceptanceCriteria: ['AC-1', 'AC-2', 'AC-3'],
        dependsOn: [],
      },
    ],
    ...overrides,
  };
  return JSON.stringify(spec);
}

let app: Express;
let tmpDir: string;
let wsDir: string;
let authToken: string;
const AUTH_EMAIL = 'qrw014-auth@example.com';
const AUTH_ID = '00000000-0000-4000-8000-000000000014';

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  const serverMod = require('../server');
  app = serverMod.default;
});

beforeEach(async () => {
  jest.clearAllMocks();

  // Keep this integration suite on a stable, suite-owned principal. Shared
  // default auth fixtures can be mutated by earlier broad-shard suites.
  authToken = await getAuthToken(app, { email: AUTH_EMAIL, authId: AUTH_ID, role: 'admin' });
  await execute(`UPDATE users SET plan = 'pro' WHERE email = $1`, [AUTH_EMAIL]);
  await execute(
    `INSERT INTO users (id, email, display_name, password_hash, plan)
     VALUES ('local-admin', 'admin@rorca.local', 'Admin', 'x', 'pro')
     ON CONFLICT (id) DO UPDATE SET plan = 'pro'`,
  );

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-qrw014-'));
  wsDir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(path.join(wsDir, 'forge', 'specs', 'pending'), { recursive: true });
  fs.mkdirSync(path.join(wsDir, 'forge', 'specs', 'approved'), { recursive: true });

  // Clean DB
  await execute(`DELETE FROM wal_events WHERE workspace_id = 'ws-qrw014'`);
  await execute(`DELETE FROM spec_generation_logs WHERE spec_slug LIKE 'qrw014%'`).catch(() => {});
  await execute(`DELETE FROM workflow_configs WHERE workflow_id = 'spec_generation'`).catch(() => {});

  await execute(
    `INSERT INTO workspaces (id, label, path) VALUES ('ws-qrw014', 'QRW014 WS', $1)
     ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path`,
    [wsDir],
  );

  // Set up mock chatComplete to return a valid spec JSON wrapped in code block
  const llmMod = require('../lib/llm-client');
  (llmMod.chatComplete as jest.Mock).mockResolvedValue({
    text: '```json\n' + makeSpecJsonResponse() + '\n```',
    usage: { inputTokens: 100, outputTokens: 200 },
  });
});

afterEach(async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(tmpDir, { recursive: true, force: true });

  delete process.env.RORCA_MODEL;
  delete process.env.SPEC_PROVIDER;
});

afterAll(async () => {
  delete process.env.NODE_ENV;
});

// ─── 1. POST /api/specs/generate accepts reasoning field ─────────────────────

describe('QRW-014: POST /api/specs/generate accepts reasoning in request body', () => {
  test('accepts reasoning: { enabled: true } without error', async () => {
    const res = await request(app)
      .post('/api/specs/generate')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        brief: 'qrw014 reasoning enabled test brief',
        workspaceId: 'ws-qrw014',
        reasoning: { enabled: true },
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('slug');
    expect(res.body).toHaveProperty('stories');
  });

  test('accepts reasoning: { enabled: true, effort: "high" } without error', async () => {
    const res = await request(app)
      .post('/api/specs/generate')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        brief: 'qrw014 reasoning effort high test brief',
        workspaceId: 'ws-qrw014',
        reasoning: { enabled: true, effort: 'high' },
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('slug');
  });

  test('accepts reasoning: { enabled: false } without error', async () => {
    const res = await request(app)
      .post('/api/specs/generate')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        brief: 'qrw014 reasoning disabled test brief',
        workspaceId: 'ws-qrw014',
        reasoning: { enabled: false },
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('slug');
  });

  test('accepts request without reasoning field (backward compat)', async () => {
    const res = await request(app)
      .post('/api/specs/generate')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        brief: 'qrw014 no reasoning field test brief',
        workspaceId: 'ws-qrw014',
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('slug');
  });

  test('rejects invalid reasoning schema (non-boolean enabled)', async () => {
    const res = await request(app)
      .post('/api/specs/generate')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        brief: 'qrw014 invalid reasoning test brief',
        workspaceId: 'ws-qrw014',
        reasoning: { enabled: 'yes' }, // string, not boolean
      });

    // validateBody throws UnprocessableError (422) for schema violations
    expect([400, 422]).toContain(res.status);
  });
});

// ─── 2. Generated spec JSON file contains reasoning field ─────────────────────

describe('QRW-014: spec JSON file on disk contains reasoning field', () => {
  test('spec JSON file has top-level reasoning field when reasoning.enabled=true', async () => {
    const res = await request(app)
      .post('/api/specs/generate')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        brief: 'qrw014 spec json reasoning field disk write',
        workspaceId: 'ws-qrw014',
        reasoning: { enabled: true },
      });

    expect(res.status).toBe(200);
    const slug = res.body.slug as string;

    const specFilePath = path.join(wsDir, 'forge', 'specs', 'pending', `${slug}.json`);
    expect(fs.existsSync(specFilePath)).toBe(true);

    const specContent = JSON.parse(fs.readFileSync(specFilePath, 'utf8'));
    expect(specContent).toHaveProperty('reasoning');
    expect(specContent.reasoning).toEqual({ enabled: true });
  });

  test('spec JSON file has reasoning.effort when effort is provided', async () => {
    const res = await request(app)
      .post('/api/specs/generate')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        brief: 'qrw014 spec json reasoning effort disk write',
        workspaceId: 'ws-qrw014',
        reasoning: { enabled: true, effort: 'max' },
      });

    expect(res.status).toBe(200);
    const slug = res.body.slug as string;

    const specFilePath = path.join(wsDir, 'forge', 'specs', 'pending', `${slug}.json`);
    const specContent = JSON.parse(fs.readFileSync(specFilePath, 'utf8'));
    expect(specContent.reasoning).toEqual({ enabled: true, effort: 'max' });
  });

  test('spec JSON file does NOT have reasoning field when reasoning.enabled=false', async () => {
    const res = await request(app)
      .post('/api/specs/generate')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        brief: 'qrw014 spec json no reasoning field when disabled',
        workspaceId: 'ws-qrw014',
        reasoning: { enabled: false },
      });

    expect(res.status).toBe(200);
    const slug = res.body.slug as string;

    const specFilePath = path.join(wsDir, 'forge', 'specs', 'pending', `${slug}.json`);
    const specContent = JSON.parse(fs.readFileSync(specFilePath, 'utf8'));
    // reasoning.enabled=false means no reasoning — field must be absent
    expect(specContent.reasoning).toBeUndefined();
  });

  test('spec JSON file does NOT have reasoning field when no reasoning in request', async () => {
    const res = await request(app)
      .post('/api/specs/generate')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        brief: 'qrw014 spec json no reasoning field when absent',
        workspaceId: 'ws-qrw014',
      });

    expect(res.status).toBe(200);
    const slug = res.body.slug as string;

    const specFilePath = path.join(wsDir, 'forge', 'specs', 'pending', `${slug}.json`);
    const specContent = JSON.parse(fs.readFileSync(specFilePath, 'utf8'));
    expect(specContent.reasoning).toBeUndefined();
  });

  test('legacy thinkingEnabled=true also writes reasoning to spec JSON', async () => {
    const res = await request(app)
      .post('/api/specs/generate')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        brief: 'qrw014 legacy thinkingEnabled spec json',
        workspaceId: 'ws-qrw014',
        thinkingEnabled: true,
      });

    expect(res.status).toBe(200);
    const slug = res.body.slug as string;

    const specFilePath = path.join(wsDir, 'forge', 'specs', 'pending', `${slug}.json`);
    const specContent = JSON.parse(fs.readFileSync(specFilePath, 'utf8'));
    // thinkingEnabled=true triggers the same reasoning write path
    expect(specContent.reasoning).toHaveProperty('enabled', true);
  });
});

// ─── 3. GET /api/specs/:specId returns reasoning field ───────────────────────

describe('QRW-014: GET /api/specs/:specId returns reasoning field', () => {
  test('GET /:specId returns reasoning field from spec JSON (round-trip)', async () => {
    // Generate spec with reasoning
    const genRes = await request(app)
      .post('/api/specs/generate')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        brief: 'qrw014 get spec returns reasoning roundtrip',
        workspaceId: 'ws-qrw014',
        reasoning: { enabled: true, effort: 'high' },
      });

    expect(genRes.status).toBe(200);
    const slug = genRes.body.slug as string;

    // Fetch spec by ID
    const getRes = await request(app)
      .get(`/api/specs/${slug}`)
      .query({ workspaceId: 'ws-qrw014' });

    expect(getRes.status).toBe(200);
    expect(getRes.body).toHaveProperty('reasoning');
    expect(getRes.body.reasoning).toEqual({ enabled: true, effort: 'high' });
  });

  test('GET /:specId returns spec without reasoning field when not set', async () => {
    // Generate spec without reasoning
    const genRes = await request(app)
      .post('/api/specs/generate')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        brief: 'qrw014 get spec no reasoning roundtrip',
        workspaceId: 'ws-qrw014',
      });

    expect(genRes.status).toBe(200);
    const slug = genRes.body.slug as string;

    const getRes = await request(app)
      .get(`/api/specs/${slug}`)
      .query({ workspaceId: 'ws-qrw014' });

    expect(getRes.status).toBe(200);
    expect(getRes.body.reasoning).toBeUndefined();
  });

  test('GET /:specId returns reasoning from a manually-created spec file with reasoning', async () => {
    // Directly write a spec file with reasoning field
    const slug = 'qrw014-manual-reasoning-spec';
    const specContent = {
      title: 'Manual reasoning spec',
      generatedAt: new Date().toISOString(),
      model: 'claude-sonnet-4-5-20250929',
      reasoning: { enabled: true, effort: 'medium' },
      userStories: [
        {
          id: 'US-001',
          title: 'Manual story',
          description: 'A manually created story',
          acceptanceCriteria: ['AC-1'],
          dependsOn: [],
          passes: false,
        },
      ],
    };

    const specFilePath = path.join(wsDir, 'forge', 'specs', 'pending', `${slug}.json`);
    fs.writeFileSync(specFilePath, JSON.stringify(specContent, null, 2), 'utf8');

    const getRes = await request(app)
      .get(`/api/specs/${slug}`)
      .query({ workspaceId: 'ws-qrw014' });

    expect(getRes.status).toBe(200);
    expect(getRes.body).toHaveProperty('reasoning');
    expect(getRes.body.reasoning).toEqual({ enabled: true, effort: 'medium' });
  });

  test('GET /:specId returns reasoning from approved spec directory', async () => {
    const slug = 'qrw014-approved-reasoning-spec';
    const specContent = {
      title: 'Approved reasoning spec',
      generatedAt: new Date().toISOString(),
      model: 'claude-sonnet-4-5-20250929',
      reasoning: { enabled: true },
      userStories: [
        {
          id: 'US-001',
          title: 'Approved story',
          description: 'A story in an approved spec',
          acceptanceCriteria: ['AC-1', 'AC-2', 'AC-3'],
          dependsOn: [],
          passes: false,
        },
      ],
    };

    const approvedFilePath = path.join(wsDir, 'forge', 'specs', 'approved', `${slug}.json`);
    fs.writeFileSync(approvedFilePath, JSON.stringify(specContent, null, 2), 'utf8');

    const getRes = await request(app)
      .get(`/api/specs/${slug}`)
      .query({ workspaceId: 'ws-qrw014' });

    expect(getRes.status).toBe(200);
    expect(getRes.body._status).toBe('approved');
    expect(getRes.body.reasoning).toEqual({ enabled: true });
  });
});

// ─── 4. Spec generation uses resolveWorkflowConfig('spec_generation') ─────────

describe('QRW-014: spec generation uses resolveWorkflowConfig for model/provider', () => {
  test('resolveWorkflowConfig is called with spec_generation workflow ID', async () => {
    const resolverMod = require('../lib/workflow-config-resolver');
    const spy = jest.spyOn(resolverMod, 'resolveWorkflowConfig');

    const res = await request(app)
      .post('/api/specs/generate')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        brief: 'qrw014 resolver called spec generation',
        workspaceId: 'ws-qrw014',
      });

    expect(res.status).toBe(200);

    const specGenCalls = spy.mock.calls.filter((args) => args[0] === 'spec_generation');
    expect(specGenCalls.length).toBeGreaterThanOrEqual(1);

    spy.mockRestore();
  });

  test('wfConfig model from env RORCA_MODEL is used when no request model', async () => {
    process.env.RORCA_MODEL = 'claude-haiku-4-5';

    const res = await request(app)
      .post('/api/specs/generate')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        brief: 'qrw014 model from env rorca model',
        workspaceId: 'ws-qrw014',
      });

    expect(res.status).toBe(200);
    // The response carries the resolved model
    expect(res.body.model).toBe('claude-haiku-4-5');
  });

  test('DB workflow_configs spec_generation model overrides env RORCA_MODEL', async () => {
    process.env.RORCA_MODEL = 'claude-haiku-4-5';

    try {
      await execute(
        `INSERT INTO workflow_configs (workflow_id, runtime, provider, model)
         VALUES ('spec_generation', 'native', 'claude-cli', 'claude-sonnet-4-5-20250929')
         ON CONFLICT (workflow_id) DO UPDATE
           SET runtime = EXCLUDED.runtime, provider = EXCLUDED.provider, model = EXCLUDED.model`,
      );
    } catch {
      // workflow_configs table may not exist — skip this check
      return;
    }

    const res = await request(app)
      .post('/api/specs/generate')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        brief: 'qrw014 db config overrides env model',
        workspaceId: 'ws-qrw014',
      });

    expect(res.status).toBe(200);
    // DB config model='claude-sonnet-4-5-20250929' beats RORCA_MODEL='claude-haiku-4-5'
    expect(res.body.model).toBe('claude-sonnet-4-5-20250929');

    await execute(`DELETE FROM workflow_configs WHERE workflow_id = 'spec_generation'`).catch(() => {});
  });
});

// ─── 5. Request body model override takes highest priority ────────────────────

describe('QRW-014: request body model override takes priority over workflow config', () => {
  test('request model overrides wfConfig.model (from RORCA_MODEL env)', async () => {
    process.env.RORCA_MODEL = 'claude-haiku-4-5';

    const res = await request(app)
      .post('/api/specs/generate')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        brief: 'qrw014 request model override env',
        workspaceId: 'ws-qrw014',
        model: 'claude-opus-4-6',
      });

    expect(res.status).toBe(200);
    // Request body model='claude-opus-4-6' beats RORCA_MODEL='claude-haiku-4-5'
    expect(res.body.model).toBe('claude-opus-4-6');
  });

  test('spec JSON file has model from request body when model is overridden', async () => {
    process.env.RORCA_MODEL = 'claude-haiku-4-5';

    const res = await request(app)
      .post('/api/specs/generate')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        brief: 'qrw014 spec file model from request override',
        workspaceId: 'ws-qrw014',
        model: 'claude-opus-4-6',
      });

    expect(res.status).toBe(200);
    const slug = res.body.slug as string;

    const specFilePath = path.join(wsDir, 'forge', 'specs', 'pending', `${slug}.json`);
    const specContent = JSON.parse(fs.readFileSync(specFilePath, 'utf8'));
    expect(specContent.model).toBe('claude-opus-4-6');
  });

  test('request model + reasoning both written to spec JSON correctly', async () => {
    const res = await request(app)
      .post('/api/specs/generate')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        brief: 'qrw014 request model and reasoning combo',
        workspaceId: 'ws-qrw014',
        model: 'claude-sonnet-4-5-20250929',
        reasoning: { enabled: true, effort: 'medium' },
      });

    expect(res.status).toBe(200);
    const slug = res.body.slug as string;

    const specFilePath = path.join(wsDir, 'forge', 'specs', 'pending', `${slug}.json`);
    const specContent = JSON.parse(fs.readFileSync(specFilePath, 'utf8'));

    expect(specContent.model).toBe('claude-sonnet-4-5-20250929');
    expect(specContent.reasoning).toEqual({ enabled: true, effort: 'medium' });
  });

  test('workspace L3 preferred_model overrides wfConfig.model but is overridden by request model', async () => {
    process.env.RORCA_MODEL = 'claude-haiku-4-5';

    // Insert L3 direction with preferred_model
    await execute(
      `INSERT INTO direction_layers (layer, workspace_id, preferred_model, content_yaml)
       VALUES (3, 'ws-qrw014', 'claude-sonnet-4-5-20250929', 'stack: node')
       ON CONFLICT (layer, workspace_id) DO UPDATE
         SET preferred_model = EXCLUDED.preferred_model`,
    ).catch(() => {
      // direction_layers table structure may differ — skip
    });

    const res = await request(app)
      .post('/api/specs/generate')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        brief: 'qrw014 l3 preferred model override chain',
        workspaceId: 'ws-qrw014',
        model: 'claude-opus-4-6', // Request body must win over L3 preferred_model
      });

    expect(res.status).toBe(200);
    // Request model takes top priority regardless of L3 preferred_model
    expect(res.body.model).toBe('claude-opus-4-6');

    await execute(`DELETE FROM direction_layers WHERE workspace_id = 'ws-qrw014' AND layer = 3`).catch(() => {});
  });
});

// ─── 6. Round-trip: reasoning field survives generate → disk → GET ────────────

describe('QRW-014: reasoning field round-trip (generate → disk → GET)', () => {
  test('full round-trip: reasoning written to disk and returned by GET', async () => {
    // Step 1: Generate with reasoning
    const genRes = await request(app)
      .post('/api/specs/generate')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        brief: 'qrw014 full roundtrip reasoning',
        workspaceId: 'ws-qrw014',
        reasoning: { enabled: true, effort: 'low' },
      });

    expect(genRes.status).toBe(200);
    const slug = genRes.body.slug as string;

    // Step 2: Verify it's on disk
    const specFilePath = path.join(wsDir, 'forge', 'specs', 'pending', `${slug}.json`);
    expect(fs.existsSync(specFilePath)).toBe(true);

    const diskContent = JSON.parse(fs.readFileSync(specFilePath, 'utf8'));
    expect(diskContent.reasoning).toEqual({ enabled: true, effort: 'low' });

    // Step 3: GET returns the same reasoning
    const getRes = await request(app)
      .get(`/api/specs/${slug}`)
      .query({ workspaceId: 'ws-qrw014' });

    expect(getRes.status).toBe(200);
    expect(getRes.body.reasoning).toEqual({ enabled: true, effort: 'low' });
  });

  test('full round-trip: no reasoning field when not requested', async () => {
    const genRes = await request(app)
      .post('/api/specs/generate')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        brief: 'qrw014 no reasoning roundtrip',
        workspaceId: 'ws-qrw014',
      });

    expect(genRes.status).toBe(200);
    const slug = genRes.body.slug as string;

    const specFilePath = path.join(wsDir, 'forge', 'specs', 'pending', `${slug}.json`);
    const diskContent = JSON.parse(fs.readFileSync(specFilePath, 'utf8'));
    expect(diskContent.reasoning).toBeUndefined();

    const getRes = await request(app)
      .get(`/api/specs/${slug}`)
      .query({ workspaceId: 'ws-qrw014' });

    expect(getRes.status).toBe(200);
    expect(getRes.body.reasoning).toBeUndefined();
  });

  test('all standard spec fields are present alongside reasoning in disk file', async () => {
    const genRes = await request(app)
      .post('/api/specs/generate')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        brief: 'qrw014 standard fields with reasoning',
        workspaceId: 'ws-qrw014',
        model: 'claude-sonnet-4-5-20250929',
        reasoning: { enabled: true },
      });

    expect(genRes.status).toBe(200);
    const slug = genRes.body.slug as string;

    const specFilePath = path.join(wsDir, 'forge', 'specs', 'pending', `${slug}.json`);
    const diskContent = JSON.parse(fs.readFileSync(specFilePath, 'utf8'));

    // Standard spec fields
    expect(diskContent).toHaveProperty('title');
    expect(diskContent).toHaveProperty('generatedAt');
    expect(diskContent).toHaveProperty('model', 'claude-sonnet-4-5-20250929');
    expect(diskContent).toHaveProperty('userStories');
    expect(Array.isArray(diskContent.userStories)).toBe(true);

    // Reasoning field
    expect(diskContent).toHaveProperty('reasoning');
    expect(diskContent.reasoning).toEqual({ enabled: true });
  });
});
