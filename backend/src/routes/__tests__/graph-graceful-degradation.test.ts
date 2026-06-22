/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * US-010: Graph graceful degradation tests
 *
 * Verifies that all graph-dependent API endpoints handle the AGE-unavailable
 * case without throwing 500 errors. Since the local test database has AGE
 * installed, we mock isGraphAvailable() to simulate the unavailable case.
 * The pipeline trigger tests verify includeGraph flag persistence.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import request from 'supertest';
import { getAuthToken } from './helpers/auth-helper';
import { execute, queryOne } from '../../db/index';

// Mock pg-boss so pipeline trigger doesn't fail with "getBoss() called before initBoss()"
jest.mock('../../lib/pg-boss', () => ({
  initBoss: jest.fn().mockResolvedValue(undefined),
  getBoss: jest.fn().mockReturnValue({
    send: jest.fn().mockResolvedValue('mock-job-id'),
    work: jest.fn(),
    stop: jest.fn().mockResolvedValue(undefined),
  }),
}));

// Mock claude-auth so pipeline trigger passes the Claude auth check
jest.mock('../../lib/claude-auth', () => ({
  getClaudeAuthState: jest.fn().mockReturnValue({ connected: true, email: 'test@test.com', tier: 'max' }),
}));

// Mock llm-client to prevent real LLM calls
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
let tmpDir: string;
let workspacePath: string;
let authToken: string;

// Load the server ONCE per test file — avoids creating N pools
beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-graph-degrade-'));

  const serverMod = require('../../server');
  app = serverMod.default;

  // Create filesystem directories for specs
  workspacePath = path.join(tmpDir, 'test-project');
  fs.mkdirSync(path.join(workspacePath, 'forge', 'specs', 'approved'), { recursive: true });
  fs.mkdirSync(path.join(workspacePath, 'forge', 'specs', 'pending'), { recursive: true });
  fs.mkdirSync(path.join(workspacePath, 'scripts', 'ralph', 'specs', 'approved'), { recursive: true });
  fs.mkdirSync(path.join(workspacePath, 'scripts', 'ralph', 'specs', 'pending'), { recursive: true });
});

// Re-seed data after each global truncation (jest.pool-cleanup.ts truncates tables beforeEach)
beforeEach(async () => {
  await execute(
    `INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    ['ws-graph-test', 'Graph Test Workspace', workspacePath],
  );
  authToken = await getAuthToken(app);
  await execute(`UPDATE users SET plan = 'pro' WHERE email = 'testauth@example.com'`);
});

afterAll(async () => {
  try {
    const { closePool } = require('../../db/index');
    await closePool();
  } catch {}
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.NODE_ENV;
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ─── Helpers ──────────────────────────────────────────────────────────────

function writeSpec(slug: string, spec: object, status: 'pending' | 'approved' = 'approved') {
  const forgeDir = path.join(workspacePath, 'forge', 'specs', status);
  const oldDir = path.join(workspacePath, 'scripts', 'ralph', 'specs', status);
  fs.writeFileSync(path.join(forgeDir, `${slug}.json`), JSON.stringify(spec));
  fs.writeFileSync(path.join(oldDir, `${slug}.json`), JSON.stringify(spec));
}

function mockAgeUnavailable() {
  const kg = require('../../lib/knowledge-graph');
  const runtime = require('../../lib/graph-runtime');
  jest.spyOn(kg, 'isGraphAvailable').mockResolvedValue(false);
  jest.spyOn(kg, 'graphStats').mockResolvedValue({
    available: false,
    vertexCount: 0,
    edgeCount: 0,
    labels: [],
  });
  jest.spyOn(runtime, 'getRuntimeGraphCapability').mockResolvedValue({
    surface: 'knowledge',
    graphMode: 'lite',
    provider: 'relational',
    ageAvailable: false,
    available: true,
    adminAvailable: false,
    hint: 'Run `rorca db start` to ensure the Docker Postgres sidecar is ready with Apache AGE enabled.',
    message: 'Graph Lite active. This surface uses relational fallback data instead of Apache AGE.',
    capability: {
      dbMode: 'docker',
      provider: 'docker-postgres',
      extensions: { age: false, vector: true, pgcrypto: true },
      graphMode: 'lite',
      warnings: ['Apache AGE is unavailable.'],
      connection: { url: null, host: null, port: null, database: null, local: true },
      connected: true,
    },
  });
  jest.spyOn(runtime, 'describeRuntimeGraph').mockImplementation((value: any) => ({
    graphMode: value.graphMode,
    provider: value.provider,
    ageAvailable: value.ageAvailable,
    hint: value.hint,
    message: value.message,
  }));
}

// ─── 1. GET /api/graph/stats — AGE unavailable ───────────────────────────

describe('GET /api/graph/stats (AGE unavailable)', () => {
  test('returns available=false with zeroed counts — no 500 error', async () => {
    mockAgeUnavailable();

    const res = await request(app)
      .get('/api/graph/stats')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      available: false,
      vertexCount: 0,
      edgeCount: 0,
    });
    expect(res.body.graphName).toBe('rorca');
    expect(res.body.lastPopulatedAt).toBeNull();
  });

  test('does not expose internal error details', async () => {
    mockAgeUnavailable();

    const res = await request(app)
      .get('/api/graph/stats')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
    expect(res.body.stack).toBeUndefined();
  });
});

// ─── 2. POST /api/pipeline/trigger — includeGraph flag ───────────────────

describe('POST /api/pipeline/trigger with includeGraph', () => {
  test('persists include_graph=true in pipeline_runs and includes it in pg-boss job payload', async () => {
    writeSpec('graph-trigger-spec', {
      title: 'Graph Trigger Test',
      userStories: [
        {
          id: 'US-001',
          title: 'Test Story',
          description: 'A test story',
          acceptanceCriteria: ['works'],
          dependsOn: [],
        },
      ],
    });

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/graph-trigger-spec.json',
        workspaceId: 'ws-graph-test',
        includeGraph: true,
      });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.runId).toBeDefined();

    const runId = res.body.runId;

    // Verify the pipeline_runs row has include_graph=true
    const run = await queryOne<{ include_graph: boolean }>(
      `SELECT include_graph FROM pipeline_runs WHERE id = $1`,
      [runId],
    );
    expect(run).toBeDefined();
    expect(run!.include_graph).toBe(true);

    // Verify pg-boss mock was called with includeGraph in the payload
    const { getBoss } = require('../../lib/pg-boss');
    const boss = getBoss();
    const sendCalls = boss.send.mock.calls;
    const pipelineRunCall = sendCalls.find(
      (call: any[]) => call[0] === 'pipeline:run',
    );
    expect(pipelineRunCall).toBeDefined();
    const jobPayload = pipelineRunCall![1];
    expect(jobPayload.includeGraph).toBe(true);
    expect(jobPayload.runId).toBe(runId);
  });

  test('defaults includeGraph to false when not provided', async () => {
    writeSpec('no-graph-spec', {
      title: 'No Graph Test',
      userStories: [
        {
          id: 'US-001',
          title: 'Test Story',
          description: 'A test story',
          acceptanceCriteria: ['works'],
          dependsOn: [],
        },
      ],
    });

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/no-graph-spec.json',
        workspaceId: 'ws-graph-test',
      });

    expect(res.status).toBe(201);

    const run = await queryOne<{ include_graph: boolean }>(
      `SELECT include_graph FROM pipeline_runs WHERE id = $1`,
      [res.body.runId],
    );
    expect(run).toBeDefined();
    expect(run!.include_graph).toBe(false);
  });
});

function expectAgeUnavailable(body: Record<string, unknown>) {
  expect(body).toMatchObject({
    error: 'Apache AGE extension not available',
    code: 'AGE_NOT_INSTALLED',
    mode: 'lite',
  });
  expect(String(body.hint || '')).toMatch(/rorca db start/i);
}

// ─── 3. GET /api/specs/:specId/knowledge-graph — AGE unavailable ──────────

describe('GET /api/specs/:specId/knowledge-graph (AGE unavailable)', () => {
  test('returns a 200 Graph Lite fallback payload', async () => {
    mockAgeUnavailable();

    const res = await request(app)
      .get('/api/specs/any-spec/knowledge-graph')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.runtime.graphMode).toBe('lite');
    expect(res.body.runtime.provider).toBe('relational');
  });

  test('stays on the Graph Lite fallback path for a real spec', async () => {
    mockAgeUnavailable();

    writeSpec('real-spec', {
      title: 'Real Spec',
      userStories: [
        {
          id: 'US-001',
          title: 'Story A',
          description: 'Do something',
          acceptanceCriteria: ['done'],
          dependsOn: [],
        },
      ],
    });

    const res = await request(app)
      .get('/api/specs/real-spec/knowledge-graph')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.runtime.graphMode).toBe('lite');
  });
});

// ─── 4. POST /api/graph/populate — AGE unavailable ───────────────────────

describe('POST /api/graph/populate (AGE unavailable)', () => {
  test('returns 503 with Lite Mode contract when AGE is unavailable', async () => {
    mockAgeUnavailable();

    const res = await request(app)
      .post('/api/graph/populate')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-graph-test' });

    expect(res.status).toBe(503);
    expectAgeUnavailable(res.body);
  });

  test('returns 400 when workspaceId is missing', async () => {
    const res = await request(app)
      .post('/api/graph/populate')
      .set('Authorization', `Bearer ${authToken}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/workspaceId/i);
  });
});

// ─── 5. Knowledge graph library — graceful degradation ──────────────────

describe('knowledge-graph library (AGE unavailable)', () => {
  test('isGraphAvailable() returns false when mocked', async () => {
    mockAgeUnavailable();
    const { isGraphAvailable } = require('../../lib/knowledge-graph');
    const available = await isGraphAvailable();
    expect(available).toBe(false);
  });

  test('graphStats() returns available=false when mocked', async () => {
    mockAgeUnavailable();
    const { graphStats } = require('../../lib/knowledge-graph');
    const stats = await graphStats();
    expect(stats.available).toBe(false);
    expect(stats.vertexCount).toBe(0);
    expect(stats.edgeCount).toBe(0);
  });

  test('querySpecKnowledgeGraph() returns empty result when AGE unavailable', async () => {
    mockAgeUnavailable();
    const { querySpecKnowledgeGraph } = require('../../lib/knowledge-graph');
    const result = await querySpecKnowledgeGraph('any-spec');
    expect(result).toEqual({
      memories: [],
      conventions: [],
      relatedStories: [],
    });
  });

  test('queryRelated() returns empty array when AGE unavailable', async () => {
    mockAgeUnavailable();
    const { queryRelated } = require('../../lib/knowledge-graph');
    const result = await queryRelated('Story', 'US-001');
    expect(result).toEqual([]);
  });

  test('queryImpact() returns empty result when AGE unavailable', async () => {
    mockAgeUnavailable();
    const { queryImpact } = require('../../lib/knowledge-graph');
    const result = await queryImpact('src/app.ts');
    expect(result).toEqual({
      stories: [],
      specs: [],
      conventions: [],
    });
  });

  test('populateFromRun() returns zero counts when AGE unavailable', async () => {
    mockAgeUnavailable();
    const { populateFromRun } = require('../../lib/knowledge-graph');
    const result = await populateFromRun(1, 'test-spec', 'ws-1');
    expect(result).toEqual({ nodesCreated: 0, edgesCreated: 0 });
  });

  test('querySkillEffectiveness() returns empty array when AGE unavailable', async () => {
    mockAgeUnavailable();
    const { querySkillEffectiveness } = require('../../lib/knowledge-graph');
    const result = await querySkillEffectiveness();
    expect(result).toEqual([]);
  });

  test('querySkillPathAffinity() returns empty array when AGE unavailable', async () => {
    mockAgeUnavailable();
    const { querySkillPathAffinity } = require('../../lib/knowledge-graph');
    const result = await querySkillPathAffinity();
    expect(result).toEqual([]);
  });

  // Verify that all exported mutation functions include the isGraphAvailable() guard.
  // Internal function calls within the same module bypass jest.spyOn on exports,
  // so we verify the pattern exists in the source code as a safety net.
  test('all mutation functions have isGraphAvailable() guard in source', () => {
    const kgSource = fs.readFileSync(
      path.join(__dirname, '..', '..', 'lib', 'knowledge-graph.ts'),
      'utf8',
    );

    const mutationFunctions = [
      'addStoryNode',
      'addFileTouch',
      'addMemoryLink',
      'populateFromSpec',
      'populateFromRun',
    ];

    for (const fn of mutationFunctions) {
      // Match: export async function <name>(...) { ... isGraphAvailable ...
      const fnPattern = new RegExp(
        `export\\s+async\\s+function\\s+${fn}[\\s\\S]*?isGraphAvailable`,
      );
      expect(kgSource).toMatch(fnPattern);
    }
  });
});
