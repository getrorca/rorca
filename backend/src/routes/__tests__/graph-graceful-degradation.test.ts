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
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { once } from 'events';
import * as fs from 'fs';
import type { Server } from 'http';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import { Pool } from 'pg';
import request from 'supertest';
import type * as AuthHelperModule from './helpers/auth-helper';
import type * as DatabaseModule from '../../db/index';

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

const WORKSPACE_ID = 'ws-graph-test';
const AUTH_ID = crypto.randomUUID();
const authEmail = `graph-degrade-${crypto.randomUUID()}@test.rorca.local`;
const ENVIRONMENT_KEYS = ['NODE_ENV', 'RORCA_TEST_DATABASE_WORKSPACE_SCOPE'] as const;
type EnvironmentKey = (typeof ENVIRONMENT_KEYS)[number];
const originalEnvironment = Object.fromEntries(
  ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
) as Record<EnvironmentKey, string | undefined>;

process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE = WORKSPACE_ID;
const { getAuthToken } = require('./helpers/auth-helper') as typeof AuthHelperModule;
const { queryOne } = require('../../db/index') as typeof DatabaseModule;

const migrationDatabaseUrl = process.env.WAVE2_TEST_MIGRATION_DATABASE_URL;
if (!migrationDatabaseUrl) throw new Error('WAVE2_TEST_MIGRATION_DATABASE_URL is required');
const ownerPool = new Pool({
  connectionString: migrationDatabaseUrl,
  max: 1,
  options: `--search_path=rorca,public -c rorca.migration_mode=on -c rorca.workspace_id=${WORKSPACE_ID}`,
});

let app: Server;
let tmpDir: string;
let workspacePath: string;
let authToken: string;

function restoreEnvironment(): void {
  for (const key of ENVIRONMENT_KEYS) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function ownerExecute(sql: string, params: unknown[] = []): Promise<void> {
  await ownerPool.query(sql, params);
}

async function cleanGraphFixture(): Promise<void> {
  await ownerExecute(
    'DELETE FROM token_usage WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = $1)',
    [WORKSPACE_ID],
  );
  await ownerExecute(
    'DELETE FROM story_results WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = $1)',
    [WORKSPACE_ID],
  );
  await ownerExecute(
    'DELETE FROM pipeline_dispatch_publications WHERE workspace_id = $1',
    [WORKSPACE_ID],
  );
  await ownerExecute('DELETE FROM pipeline_runs WHERE workspace_id = $1', [WORKSPACE_ID]);
  await ownerExecute('DELETE FROM wal_events WHERE workspace_id = $1', [WORKSPACE_ID]);
}

// Load one exact-workspace server for the entire suite.
beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE = WORKSPACE_ID;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-graph-degrade-'));

  workspacePath = path.join(tmpDir, 'test-project');
  fs.mkdirSync(path.join(workspacePath, 'forge', 'specs', 'approved'), { recursive: true });
  fs.mkdirSync(path.join(workspacePath, 'forge', 'specs', 'pending'), { recursive: true });
  execFileSync('git', ['init', '-q', workspacePath]);
  execFileSync('git', ['-C', workspacePath, '-c', 'user.name=Rorca Tests', '-c', 'user.email=tests@rorca.local', 'commit', '--allow-empty', '-qm', 'test baseline']);

  await ownerExecute(
    `INSERT INTO users (id, email, display_name, password_hash, auth_id, role, plan)
     VALUES ($1, $2, 'Graph Degradation Suite', 'x', $3::uuid, 'admin', 'free')`,
    [crypto.randomUUID(), authEmail, AUTH_ID],
  );
  await ownerExecute(
    `INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3)`,
    [WORKSPACE_ID, 'Graph Test Workspace', workspacePath],
  );

  const serverMod = require('../../server');
  const expressApp = serverMod.default as Express;
  authToken = await getAuthToken(expressApp, {
    email: authEmail,
    authId: AUTH_ID,
    role: 'admin',
  });
  app = expressApp.listen(0, '127.0.0.1');
  await once(app, 'listening');
});

beforeEach(async () => {
  jest.clearAllMocks();
  await cleanGraphFixture();
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  try {
    await cleanGraphFixture();
    if (app) {
      app.closeAllConnections();
      await new Promise<void>((resolve, reject) => app.close(error => error ? reject(error) : resolve()));
    }
    await ownerExecute('DELETE FROM workspaces WHERE id = $1', [WORKSPACE_ID]);
    await ownerExecute('DELETE FROM users WHERE email = $1', [authEmail]);
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  } finally {
    await ownerPool.end();
    restoreEnvironment();
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────

function writeSpec(slug: string, spec: object, status: 'pending' | 'approved' = 'approved') {
  const forgeDir = path.join(workspacePath, 'forge', 'specs', status);
  fs.writeFileSync(path.join(forgeDir, `${slug}.json`), JSON.stringify(spec));
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
    expect(res.body.graphName).toBe('rorca_v2');
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
  test('includeGraph=true cannot bypass Release-1 TaskManifest execution authority', async () => {
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
      .set('Idempotency-Key', `graph-trigger:${crypto.randomUUID()}`)
      .send({
        specPath: 'forge/specs/approved/graph-trigger-spec.json',
        workspaceId: 'ws-graph-test',
        includeGraph: true,
        autoWorktree: true,
        autoMerge: false,
        mergeStrategy: 'draft-pr',
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/TaskManifest/i);
    expect(await queryOne("SELECT id FROM pipeline_runs WHERE workspace_id = 'ws-graph-test' LIMIT 1")).toBeUndefined();
    expect(require('../../lib/pg-boss').getBoss().send).not.toHaveBeenCalled();
  });

  test('omitting includeGraph also cannot revive manifestless execution', async () => {
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
      .set('Idempotency-Key', `graph-trigger:${crypto.randomUUID()}`)
      .send({
        specPath: 'forge/specs/approved/no-graph-spec.json',
        workspaceId: 'ws-graph-test',
        autoWorktree: true,
        autoMerge: false,
        mergeStrategy: 'draft-pr',
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/TaskManifest/i);
    expect(await queryOne("SELECT id FROM pipeline_runs WHERE workspace_id = 'ws-graph-test' LIMIT 1")).toBeUndefined();
    expect(require('../../lib/pg-boss').getBoss().send).not.toHaveBeenCalled();
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
