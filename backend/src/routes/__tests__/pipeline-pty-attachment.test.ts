/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import type { AddressInfo } from 'net';
import type { Express } from 'express';
import type * as AuthHelperModule from './helpers/auth-helper';
import type * as DatabaseModule from '../../db/index';
import type * as RunPtyStoreModule from '../../lib/run-pty-store';
import type { PtyGenerationIdentity } from '../../lib/run-pty-store';
import { Pool } from 'pg';
import request from 'supertest';

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

jest.mock('../../lib/pg-boss', () => ({
  initBoss: jest.fn().mockResolvedValue(undefined),
  getPgBossSchemaSql: jest.fn(() => '"pgboss"'),
  getBoss: jest.fn().mockReturnValue({
    createQueue: jest.fn().mockResolvedValue(undefined),
    send: jest.fn().mockResolvedValue('mock-job-id'),
    work: jest.fn(),
    stop: jest.fn().mockResolvedValue(undefined),
  }),
}));

jest.mock('../../lib/pty-manager', () => ({
  PTY_AVAILABLE: true,
  PTY_UNAVAILABLE_HINT: 'Run: cd backend && npm rebuild node-pty',
}));

// Keep the polling fallback deterministic: this suite deliberately attaches
// without a LISTEN/NOTIFY wakeup so delayed durable commits must be discovered
// by cursor polling in their committed sequence order.
jest.mock('../../lib/run-output-listener', () => ({
  startRunOutputListener: jest.fn(),
  stopRunOutputListener: jest.fn().mockResolvedValue(undefined),
  subscribeRunOutput: jest.fn().mockReturnValue(() => {}),
}));

jest.mock('../../lib/execution-environment-registry', () => ({
  assertExecutionEnvironmentReadyForRun: jest.fn().mockResolvedValue({ ready: true }),
}));

jest.mock('../../lib/claude-auth', () => ({
  getClaudeAuthState: jest.fn().mockReturnValue({ connected: true, cliInstalled: true }),
}));

interface CountRow {
  count: string;
}

const PTY_WORKSPACE_ID = 'ws-pty-attach';
const PTY_OTHER_WORKSPACE_ID = 'ws-pty-attach-other';
const PTY_USER_ID = crypto.randomUUID();
const PTY_USER_AUTH_ID = crypto.randomUUID();
const PTY_USER_EMAIL = `pipeline-pty-attachment-${process.pid}@rorca.internal`;
const ENVIRONMENT_KEYS = [
  'NODE_ENV',
  'RORCA_TEST_DATABASE_WORKSPACE_SCOPE',
  'RORCA_PTY_OUTPUT_POLL_INTERVAL_MS',
] as const;
type EnvironmentKey = (typeof ENVIRONMENT_KEYS)[number];
const originalEnvironment = Object.fromEntries(
  ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
) as Record<EnvironmentKey, string | undefined>;

// db/index and the server capture this exact suite boundary when lazily loaded.
process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE = PTY_WORKSPACE_ID;

const migrationDatabaseUrl = process.env.WAVE2_TEST_MIGRATION_DATABASE_URL;
if (!migrationDatabaseUrl) throw new Error('WAVE2_TEST_MIGRATION_DATABASE_URL is required');
const ownerPool = new Pool({
  connectionString: migrationDatabaseUrl,
  max: 1,
  options: `--search_path=rorca,public -c rorca.migration_mode=on -c rorca.workspace_id=${PTY_WORKSPACE_ID}`,
});

let app: Express;
let authToken: string;
let tmpDir = '';
let wsDir = '';
let db: typeof DatabaseModule;
let getAuthToken: typeof AuthHelperModule.getAuthToken;
let claimLatestRunPtyResize: typeof RunPtyStoreModule.claimLatestRunPtyResize;
let completeRunPtySession: typeof RunPtyStoreModule.completeRunPtySession;
let startRunPtySession: typeof RunPtyStoreModule.startRunPtySession;

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

async function ownerQueryOne<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  const result = await ownerPool.query(sql, params);
  return result.rows[0] as T | undefined;
}

async function cleanupPtyFixtures(): Promise<void> {
  const workspaceIds = [PTY_WORKSPACE_ID, PTY_OTHER_WORKSPACE_ID];
  await ownerExecute(
    `DELETE FROM run_pty_resize_requests
      WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = ANY($1::text[]))`,
    [workspaceIds],
  );
  await ownerExecute(
    `DELETE FROM run_pty_input_requests
      WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = ANY($1::text[]))`,
    [workspaceIds],
  );
  await ownerExecute(
    `DELETE FROM run_pty_output_chunks
      WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = ANY($1::text[]))`,
    [workspaceIds],
  );
  await ownerExecute(
    `DELETE FROM run_pty_sessions
      WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = ANY($1::text[]))`,
    [workspaceIds],
  );
  await ownerExecute(
    `DELETE FROM run_output_chunks
      WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = ANY($1::text[]))`,
    [workspaceIds],
  );
  await ownerExecute('DELETE FROM pipeline_runs WHERE workspace_id = ANY($1::text[])', [workspaceIds]);
  await ownerExecute(
    'DELETE FROM workspaces WHERE id = $1',
    [PTY_OTHER_WORKSPACE_ID],
  );
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE = PTY_WORKSPACE_ID;
  // Minimum supported cadence makes a lost-notification fallback observable
  // quickly without turning this into an arbitrary long-timeout test.
  process.env.RORCA_PTY_OUTPUT_POLL_INTERVAL_MS = '250';
  ({ getAuthToken } = require('./helpers/auth-helper') as typeof AuthHelperModule);
  db = require('../../db/index') as typeof DatabaseModule;
  ({
    claimLatestRunPtyResize,
    completeRunPtySession,
    startRunPtySession,
  } = require('../../lib/run-pty-store') as typeof RunPtyStoreModule);

  await ownerExecute(
    `INSERT INTO users (id, email, display_name, password_hash, auth_id, role, plan)
     VALUES ($1, $2, 'Pipeline PTY Attachment User', 'x', $3::uuid, 'admin', 'pro')
     ON CONFLICT (id) DO UPDATE
       SET email = EXCLUDED.email, auth_id = EXCLUDED.auth_id, role = EXCLUDED.role, plan = EXCLUDED.plan`,
    [PTY_USER_ID, PTY_USER_EMAIL, PTY_USER_AUTH_ID],
  );

  const expressApp = require('../../server').default as Express;
  app = expressApp;
  authToken = await getAuthToken(expressApp, {
    email: PTY_USER_EMAIL,
    authId: PTY_USER_AUTH_ID,
    role: 'admin',
    displayName: 'Pipeline PTY Attachment User',
  });
});

beforeEach(async () => {
  process.env.NODE_ENV = 'test';
  process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE = PTY_WORKSPACE_ID;
  process.env.RORCA_PTY_OUTPUT_POLL_INTERVAL_MS = '250';
  jest.clearAllMocks();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-pipeline-pty-attachment-'));
  wsDir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(path.join(wsDir, 'forge', 'specs', 'approved'), { recursive: true });

  execSync('git init -b main', { cwd: wsDir, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: wsDir, stdio: 'pipe' });
  execSync('git config user.name "Test User"', { cwd: wsDir, stdio: 'pipe' });
  fs.writeFileSync(path.join(wsDir, 'README.md'), '# test workspace\n', 'utf8');
  execSync('git add README.md', { cwd: wsDir, stdio: 'pipe' });
  execSync('git commit -m "init"', { cwd: wsDir, stdio: 'pipe' });

  await cleanupPtyFixtures();
  await ownerExecute(
    `INSERT INTO workspaces (id, label, path)
     VALUES ($1, 'PTY Attach WS', $2)
     ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path`,
    [PTY_WORKSPACE_ID, wsDir],
  );
  await ownerExecute(
    `INSERT INTO workspace_members (workspace_id, user_auth_id, role)
     VALUES ($1, $2::uuid, 'owner')
     ON CONFLICT (workspace_id, user_auth_id) DO UPDATE SET role = 'owner'`,
    [PTY_WORKSPACE_ID, PTY_USER_AUTH_ID],
  );
});

afterEach(async () => {
  try {
    const immediate = Promise.withResolvers<void>();
    setImmediate(immediate.resolve);
    await immediate.promise;
    jest.restoreAllMocks();
    await cleanupPtyFixtures();
  } finally {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    restoreEnvironment();
  }
});

afterAll(async () => {
  try {
    // Every explicitly opened SSE listener is closed by its owning test.
    await ownerExecute('DELETE FROM workspace_members WHERE workspace_id = $1', [PTY_WORKSPACE_ID]);
    await ownerExecute('DELETE FROM workspaces WHERE id = $1', [PTY_WORKSPACE_ID]);
    await ownerExecute('DELETE FROM users WHERE id = $1', [PTY_USER_ID]);
  } finally {
    await ownerPool.end();
    restoreEnvironment();
  }
});

function seedSpec(slug: string, stories = [
  { id: 'US-001', title: 'Story', description: 'Desc', acceptanceCriteria: ['AC'], dependsOn: [] },
]): void {
  fs.writeFileSync(
    path.join(wsDir, 'forge', 'specs', 'approved', `${slug}.json`),
    JSON.stringify({
      title: slug,
      userStories: stories,
    }),
    'utf8',
  );
}

function extractChunkPayloads(body: string): string[] {
  const payloads: string[] = [];
  const regex = /event: chunk\ndata: ([A-Za-z0-9+/=]+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(body)) !== null) {
    payloads.push(match[1]);
  }
  return payloads;
}

async function seedRun(
  status: string,
  terminalMode: 'ansi-html' | 'pty' | 'native-pty',
  workspaceId = PTY_WORKSPACE_ID,
): Promise<number> {
  const row = await ownerQueryOne<{ id: number }>(
    `INSERT INTO pipeline_runs (spec_path, workspace_id, status, terminal_mode, agent, agent_type)
     VALUES ('forge/specs/approved/pty-attach.json', $1, $2, $3, 'claude', 'claude')
     RETURNING id`,
    [workspaceId, status, terminalMode],
  );
  return Number(row!.id);
}

async function seedPtyGeneration(runId: number, status: 'active' | 'exited' = 'active'): Promise<PtyGenerationIdentity> {
  const generation = await startRunPtySession({
    runId, workspaceId: PTY_WORKSPACE_ID, storyId: 'US-001', attempt: 1,
    cwd: wsDir, agentType: 'claude', cols: 80, rows: 24, childPid: null,
  });
  if (status === 'exited') {
    await completeRunPtySession({
      runId, generationId: generation.generationId, generationToken: generation.generationToken,
    }, 'exited', 0, null);
  }
  return generation;
}

async function streamOutput(runId: number): Promise<string> {
  const response = await request(app)
    .get(`/api/pipeline/runs/${runId}/output?workspaceId=${PTY_WORKSPACE_ID}`)
    .set('Authorization', `Bearer ${authToken}`)
    .buffer(true)
    .parse((res, callback) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => callback(null, body));
    });

  expect(response.status).toBe(200);
  return response.body as string;
}

describe('PTY attachment trigger and fallback discrimination', () => {
  test('rejects mismatched identity and cannot observe another workspace before SSE headers', async () => {
    const runId = await seedRun('done', 'pty');
    const mismatchedIdentity = await request(app)
      .get(`/api/pipeline/runs/${runId}/output?workspaceId=another-workspace`)
      .set('Authorization', `Bearer ${authToken}`);
    expect(mismatchedIdentity.status).toBe(403);
    expect(mismatchedIdentity.headers['content-type']).toContain('application/json');

    await ownerExecute(
      `INSERT INTO workspaces (id, label, path)
       VALUES ($1, 'PTY Other Workspace', $2)
       ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path`,
      [PTY_OTHER_WORKSPACE_ID, wsDir],
    );
    const otherRunId = await seedRun('done', 'pty', PTY_OTHER_WORKSPACE_ID);
    expect(await db.queryOne(
      'SELECT id FROM pipeline_runs WHERE id = $1 AND workspace_id = $2',
      [otherRunId, PTY_WORKSPACE_ID],
    )).toBeUndefined();

    const hiddenRun = await request(app)
      .get(`/api/pipeline/runs/${otherRunId}/output?workspaceId=${PTY_WORKSPACE_ID}`)
      .set('Authorization', `Bearer ${authToken}`);
    expect(hiddenRun.status).toBe(403);
    expect(hiddenRun.headers['content-type']).toContain('application/json');
  });

  test('dry-run accepts camelCase terminalMode=pty without creating or dispatching a run', async () => {
    seedSpec('trigger-pty-preview');
    const pgBossMock = jest.requireMock('../../lib/pg-boss');
    const mockSend = pgBossMock.getBoss().send as jest.Mock;
    mockSend.mockClear();

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/trigger-pty-preview.json',
        workspaceId: 'ws-pty-attach',
        terminalMode: 'pty',
        dryRun: true,
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      dryRun: true,
      terminalMode: 'pty',
      terminal_mode: 'pty',
    }));
    expect(await db.queryOne(
      `SELECT id FROM pipeline_runs WHERE workspace_id = 'ws-pty-attach'`,
    )).toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('manifestless PTY execution cannot dispatch a multi-story graph', async () => {
    seedSpec('trigger-pty-manifestless', [
      { id: 'US-001', title: 'Story 1', description: 'Desc', acceptanceCriteria: ['AC'], dependsOn: [] },
      { id: 'US-002', title: 'Story 2', description: 'Desc', acceptanceCriteria: ['AC'], dependsOn: [] },
      { id: 'US-003', title: 'Story 3', description: 'Desc', acceptanceCriteria: ['AC'], dependsOn: [] },
      { id: 'US-004', title: 'Story 4', description: 'Desc', acceptanceCriteria: ['AC'], dependsOn: [] },
      { id: 'US-005', title: 'Story 5', description: 'Desc', acceptanceCriteria: ['AC'], dependsOn: [] },
    ]);
    const pgBossMock = jest.requireMock('../../lib/pg-boss');
    const mockSend = pgBossMock.getBoss().send as jest.Mock;
    mockSend.mockClear();

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .set('Idempotency-Key', 'pipeline-pty-manifestless')
      .send({
        specPath: 'forge/specs/approved/trigger-pty-manifestless.json',
        workspaceId: 'ws-pty-attach',
        terminalMode: 'pty',
        autoWorktree: true,
        autoMerge: false,
        mergeStrategy: 'draft-pr',
      });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      code: 'RELEASE_ONE_TASK_MANIFEST_REQUIRED',
      details: {
        profileId: 'release-1-supervised-core',
        capabilityId: 'bounded_task_manifest',
        endpoint: '/api/pipeline/task-manifests/trigger',
      },
    });
    expect(await db.queryOne(
      `SELECT id FROM pipeline_runs WHERE workspace_id = 'ws-pty-attach'`,
    )).toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('PTY-backed replay emits isPty=true and reads only the dedicated PTY chunk table', async () => {
    const runId = await seedRun('done', 'pty');
    const ansiFallbackChunk = Buffer.from('ansi table should not render\n', 'utf8');
    const ptyChunk = Buffer.from('\u001b[32mreal pty bytes\u001b[0m\r\n', 'utf8');

    const generation = await seedPtyGeneration(runId, 'exited');
    await ownerExecute('INSERT INTO run_pty_output_chunks (run_id, generation_id, sequence, chunk) VALUES ($1, $2, 1, $3)',
    [runId, generation.generationId, ptyChunk],);
    await ownerExecute('INSERT INTO run_output_chunks (run_id, sequence, chunk) VALUES ($1, 1, $2)', [runId, ansiFallbackChunk]);

    const [ptyCount, ansiCount] = await Promise.all([
      db.queryOne<CountRow>('SELECT COUNT(*)::text AS count FROM run_pty_output_chunks WHERE run_id = $1', [runId]),
      db.queryOne<CountRow>('SELECT COUNT(*)::text AS count FROM run_output_chunks WHERE run_id = $1', [runId]),
    ]);
    expect(ptyCount?.count).toBe('1');
    expect(ansiCount?.count).toBe('1');

    const body = await streamOutput(runId);

    expect(body).toContain('event: run_meta');
    expect(body).toContain('"contractVersion":2');
    expect(body).toContain(`"outputGenerationId":"${generation.generationId}"`);
    expect(body).toContain('"storyId":"US-001"');
    expect(body).toContain('"attempt":1');
    expect(body).toContain('"checkpointSequence":0');
    expect(body).toContain('"firstRetainedSequence":1');
    expect(body).toContain('"active":false');
    expect(body).toContain('"transcriptAvailable":false');
    expect(body).toContain('"archiveAvailable":false');
    expect(body).toContain('event: terminal_reset');
    expect(body.indexOf('event: run_meta')).toBeLessThan(body.indexOf('event: terminal_reset'));
    expect(body.indexOf('event: terminal_reset')).toBeLessThan(body.indexOf('event: chunk'));
    expect(body).toContain('"terminalMode":"pty"');
    expect(body).toContain('"lifecycleStatus":"finished"');
    expect(body).toContain('"isPty":true');
    expect(body).toContain('"ptyLiveTransport":"postgres-notify+db-replay"');
    expect(body).toContain('"ptyReplaySource":"run_pty_output_chunks"');
    expect(body).toContain('"ptyPollIntervalMs":');
    expect(body).toContain(`event: chunk\ndata: ${ptyChunk.toString('base64')}`);
    expect(body).not.toContain(ansiFallbackChunk.toString('base64'));
    expect(body).not.toContain('event: semantic_step');
  });

  test('PTY polling recovers delayed incremental bytes without a notifier and replays them exactly', async () => {
    const runId = await seedRun('running', 'pty');
    const chunks = [
      Buffer.from('delayed fake CLI banner\r\n', 'utf8'),
      Buffer.from('\u001b[33mincremental terminal bytes\u001b[0m\r\n', 'utf8'),
    ];
    const generation = await seedPtyGeneration(runId);

    const server = app.listen(0);
    try {
      const port = (server.address() as AddressInfo).port;
      const liveBody = await new Promise<string>((resolve, reject) => {
        let received = '';
        let inserted = false;
        const clientReq = http.get({
          port,
          path: `/api/pipeline/runs/${runId}/output?workspaceId=ws-pty-attach`,
          headers: { Authorization: `Bearer ${authToken}` },
        }, (clientRes) => {
          clientRes.setEncoding('utf8');
          clientRes.on('data', (chunk: string) => {
            received += chunk;
            if (!inserted && received.includes('event: run_meta')) {
              inserted = true;
              setTimeout(() => {
                void (async () => {
                  await ownerExecute('INSERT INTO run_pty_output_chunks (run_id, generation_id, sequence, chunk) VALUES ($1, $2, 1, $3)',
                  [runId, generation.generationId, chunks[0]],);
                  await ownerExecute('INSERT INTO run_pty_output_chunks (run_id, generation_id, sequence, chunk) VALUES ($1, $2, 2, $3)',
                  [runId, generation.generationId, chunks[1]],);
                  await completeRunPtySession({
                    runId, generationId: generation.generationId, generationToken: generation.generationToken,
                  }, 'exited', 0, null);
                  await ownerExecute(`UPDATE pipeline_runs SET status = 'done', finished_at = NOW() WHERE id = $1`, [runId]);
                })().catch(reject);
              }, 75);
            }
            if (extractChunkPayloads(received).length >= 2 && received.includes('event: done')) {
              resolve(received);
              clientReq.destroy();
            }
          });
        });
        clientReq.on('error', (err) => {
          if (extractChunkPayloads(received).length >= 2) resolve(received);
          else reject(err);
        });
        clientReq.setTimeout(8_000, () => {
          clientReq.destroy();
          reject(new Error(`Timed out waiting for live PTY chunks; received: ${received}`));
        });
      });

      const expectedPayloads = chunks.map((chunk) => chunk.toString('base64'));
      expect(extractChunkPayloads(liveBody)).toEqual(expectedPayloads);
      expect(liveBody).toContain('"ptyLiveTransport":"postgres-notify+db-replay"');
      expect(liveBody).toContain('"ptyPollIntervalMs":250');
      const outputListenerMock = jest.requireMock('../../lib/run-output-listener');
      expect(outputListenerMock.subscribeRunOutput).toHaveBeenCalledWith(runId, expect.any(Function));
      expect(liveBody).not.toContain('Agent process is still running');
      expect(liveBody).not.toContain('event: semantic_step');

      const replayBody = await streamOutput(runId);
      expect(extractChunkPayloads(replayBody)).toEqual(expectedPayloads);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('active-generation rollover emits metadata then reset before current deltas', async () => {
    const runId = await seedRun('running', 'pty');
    const previous = await seedPtyGeneration(runId);
    const previousChunk = Buffer.from('previous-generation\n');
    const currentChunk = Buffer.from('current-generation\n');
    await ownerExecute('INSERT INTO run_pty_output_chunks (run_id, generation_id, sequence, chunk) VALUES ($1, $2, 1, $3)',
    [runId, previous.generationId, previousChunk],);

    const server = app.listen(0);
    try {
      const port = (server.address() as AddressInfo).port;
      const body = await new Promise<string>((resolve, reject) => {
        let received = '';
        let replacementStarted = false;
        const clientReq = http.get({
          port,
          path: `/api/pipeline/runs/${runId}/output?workspaceId=ws-pty-attach`,
          headers: { Authorization: `Bearer ${authToken}` },
        }, (clientRes) => {
          clientRes.setEncoding('utf8');
          clientRes.on('data', (chunk: string) => {
            received += chunk;
            if (!replacementStarted && received.includes(previousChunk.toString('base64'))) {
              replacementStarted = true;
              void (async () => {
                const current = await startRunPtySession({
                  runId, workspaceId: 'ws-pty-attach', storyId: 'US-002', attempt: 2,
                  cwd: wsDir, agentType: 'claude', cols: 80, rows: 24, childPid: null,
                });
                await ownerExecute('INSERT INTO run_pty_output_chunks (run_id, generation_id, sequence, chunk) VALUES ($1, $2, 1, $3)',
                [runId, current.generationId, currentChunk],);
                await completeRunPtySession({
                  runId, generationId: current.generationId, generationToken: current.generationToken,
                }, 'exited', 0, null);
                await ownerExecute("UPDATE pipeline_runs SET status = 'done', finished_at = NOW() WHERE id = $1", [runId]);
              })().catch(reject);
            }
            if (received.includes(currentChunk.toString('base64')) && received.includes('event: done')) resolve(received);
          });
        });
        clientReq.on('error', (error) => {
          if (received.includes(currentChunk.toString('base64'))) resolve(received);
          else reject(error);
        });
        clientReq.setTimeout(8_000, () => {
          clientReq.destroy();
          reject(new Error(`Timed out during generation rollover: ${received}`));
        });
      });

      const currentMeta = body.lastIndexOf('"storyId":"US-002"');
      const reset = body.indexOf('event: terminal_reset', currentMeta);
      const currentDelta = body.indexOf(currentChunk.toString('base64'));
      expect(currentMeta).toBeGreaterThan(-1);
      expect(reset).toBeGreaterThan(currentMeta);
      expect(currentDelta).toBeGreaterThan(reset);
      expect(extractChunkPayloads(body)).toEqual([previousChunk.toString('base64'), currentChunk.toString('base64')]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('active requested PTY remains session-pending instead of permanently demoting during startup', async () => {
    const runId = await seedRun('running', 'pty');
    const server = app.listen(0);
    try {
      const port = (server.address() as AddressInfo).port;
      const body = await new Promise<string>((resolve, reject) => {
        let received = '';
        const clientReq = http.get({
          port,
          path: `/api/pipeline/runs/${runId}/output?workspaceId=ws-pty-attach`,
          headers: { Authorization: `Bearer ${authToken}` },
        }, (clientRes) => {
          clientRes.setEncoding('utf8');
          clientRes.on('data', (chunk: string) => {
            received += chunk;
            if (received.includes('event: run_meta')) {
              resolve(received);
              clientReq.destroy();
            }
          });
        });
        clientReq.on('error', (err) => {
          if (received.includes('event: run_meta')) resolve(received);
          else reject(err);
        });
      });

      expect(body).toContain('"terminalMode":"pty"');
      expect(body).toContain('"isPty":true');
      expect(body).toContain('"ptyFallbackActive":false');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('pending PTY demotes in-place and replays diagnostics if the run terminates without a session', async () => {
    const runId = await seedRun('running', 'pty');
    const fallbackChunk = Buffer.from('node-pty startup failed\n', 'utf8');
    const server = app.listen(0);
    try {
      const port = (server.address() as AddressInfo).port;
      const body = await new Promise<string>((resolve, reject) => {
        let received = '';
        let terminalUpdateStarted = false;
        const clientReq = http.get({
          port,
          path: `/api/pipeline/runs/${runId}/output?workspaceId=ws-pty-attach`,
          headers: { Authorization: `Bearer ${authToken}` },
        }, (clientRes) => {
          clientRes.setEncoding('utf8');
          clientRes.on('data', (chunk: string) => {
            received += chunk;
            if (!terminalUpdateStarted && received.includes('"terminalMode":"pty"')) {
              terminalUpdateStarted = true;
              void (async () => {
                await ownerExecute('INSERT INTO run_output_chunks (run_id, sequence, chunk) VALUES ($1, 1, $2)',
                [runId, fallbackChunk],);
                await ownerExecute("UPDATE pipeline_runs SET status = 'failed', finished_at = NOW() WHERE id = $1", [runId]);
              })().catch(reject);
            }
            if (received.includes('event: done') && received.includes(fallbackChunk.toString('base64'))) {
              resolve(received);
            }
          });
        });
        clientReq.on('error', (err) => {
          if (received.includes('event: done') && received.includes(fallbackChunk.toString('base64'))) resolve(received);
          else reject(err);
        });
        clientReq.setTimeout(8_000, () => {
          clientReq.destroy();
          reject(new Error(`Timed out waiting for PTY fallback replay; received: ${received}`));
        });
      });

      expect(body).toContain('"terminalMode":"pty"');
      expect(body).toContain('"terminalMode":"ansi-html"');
      expect(body).toContain('"ptyFallbackActive":true');
      expect(body).toContain(`event: chunk\ndata: ${fallbackChunk.toString('base64')}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('Last-Event-ID resumes PTY replay without duplicating acknowledged chunks', async () => {
    const runId = await seedRun('done', 'pty');
    const generation = await seedPtyGeneration(runId, 'exited');
    await ownerExecute(`INSERT INTO run_pty_output_chunks (run_id, generation_id, sequence, chunk) VALUES
     ($1, $2, 1, $3), ($1, $2, 2, $4)`,
    [runId, generation.generationId, Buffer.from('already-seen\n'), Buffer.from('resume-here\n')],);

    const response = await request(app)
      .get(`/api/pipeline/runs/${runId}/output?workspaceId=ws-pty-attach`)
      .set('Authorization', `Bearer ${authToken}`)
      .set('Last-Event-ID', '1');

    expect(response.status).toBe(200);
    expect(response.text).not.toContain(Buffer.from('already-seen\n').toString('base64'));
    expect(response.text).toContain(Buffer.from('resume-here\n').toString('base64'));
  });

  test('a scoped EventSource cursor resumes exactly once in its matching generation', async () => {
    const runId = await seedRun('done', 'pty');
    const generation = await seedPtyGeneration(runId, 'exited');
    await ownerExecute(`INSERT INTO run_pty_output_chunks (run_id, generation_id, sequence, chunk) VALUES
     ($1, $2, 1, $3), ($1, $2, 2, $4)`,
    [runId, generation.generationId, Buffer.from('scoped-seen\n'), Buffer.from('scoped-resume\n')],);

    const response = await request(app)
      .get(`/api/pipeline/runs/${runId}/output?workspaceId=ws-pty-attach`)
      .set('Authorization', `Bearer ${authToken}`)
      .set('Last-Event-ID', `v1|run_pty_output_chunks|${generation.generationId}|1`);

    expect(response.status).toBe(200);
    expect(response.text).not.toContain('event: terminal_reset');
    expect(response.text).not.toContain(Buffer.from('scoped-seen\n').toString('base64'));
    expect(extractChunkPayloads(response.text)).toEqual([Buffer.from('scoped-resume\n').toString('base64')]);
    expect(response.text).toContain(`id: v1|run_pty_output_chunks|${generation.generationId}|2`);
  });

  test('explicit afterSequence refresh cursor overrides Last-Event-ID and never replays from zero', async () => {
    const runId = await seedRun('done', 'pty');
    const generation = await seedPtyGeneration(runId, 'exited');
    await ownerExecute(`INSERT INTO run_pty_output_chunks (run_id, generation_id, sequence, chunk) VALUES
     ($1, $2, 1, $3), ($1, $2, 2, $4), ($1, $2, 3, $5)`,
    [runId, generation.generationId, Buffer.from('zero\n'), Buffer.from('old-event-source\n'), Buffer.from('refresh-resume\n')],);

    const response = await request(app)
      .get(`/api/pipeline/runs/${runId}/output?workspaceId=ws-pty-attach&afterSequence=2`)
      .set('Authorization', `Bearer ${authToken}`)
      .set('Last-Event-ID', '1');

    expect(response.status).toBe(200);
    expect(response.text).not.toContain(Buffer.from('zero\n').toString('base64'));
    expect(response.text).not.toContain(Buffer.from('old-event-source\n').toString('base64'));
    expect(response.text).toContain(Buffer.from('refresh-resume\n').toString('base64'));
  });

  test('resets a persisted cursor when its replay source differs from the selected PTY store', async () => {
    const runId = await seedRun('done', 'pty');
    const ptyChunk = Buffer.from('must-not-be-suppressed-by-ansi-cursor\n');
    const generation = await seedPtyGeneration(runId, 'exited');
    await ownerExecute('INSERT INTO run_pty_output_chunks (run_id, generation_id, sequence, chunk) VALUES ($1, $2, 1, $3)',
    [runId, generation.generationId, ptyChunk],);

    const response = await request(app)
      .get(`/api/pipeline/runs/${runId}/output?workspaceId=ws-pty-attach&afterSequence=1&outputSource=run_output_chunks`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(response.status).toBe(200);
    expect(response.text).toContain('"cursorReset":true');
    expect(response.text).toContain('event: terminal_reset');
    expect(response.text).toContain('"reason":"cursor_scope_changed"');
    expect(response.text).toContain(`event: chunk\ndata: ${ptyChunk.toString('base64')}`);
  });

  test('resets a cursor from an older PTY generation before replaying current sequence one', async () => {
    const runId = await seedRun('done', 'pty');
    const currentChunk = Buffer.from('current-generation-sequence-one\n');
    const generation = await seedPtyGeneration(runId, 'exited');
    await ownerExecute('INSERT INTO run_pty_output_chunks (run_id, generation_id, sequence, chunk) VALUES ($1, $2, 1, $3)',
    [runId, generation.generationId, currentChunk],);
    const staleGenerationId = crypto.randomUUID();

    const response = await request(app)
      .get(`/api/pipeline/runs/${runId}/output?workspaceId=ws-pty-attach`)
      .set('Authorization', `Bearer ${authToken}`)
      .set('Last-Event-ID', `v1|run_pty_output_chunks|${staleGenerationId}|999`);

    expect(response.status).toBe(200);
    expect(response.text).toContain('"cursorReset":true');
    expect(response.text).toContain('event: terminal_reset');
    expect(response.text).toContain(`"outputGenerationId":"${generation.generationId}"`);
    expect(extractChunkPayloads(response.text)).toEqual([currentChunk.toString('base64')]);
  });

  test('does not let a corrupt checkpoint suppress retained deltas', async () => {
    const runId = await seedRun('done', 'pty');
    const generation = await seedPtyGeneration(runId, 'exited');
    const retained = Buffer.from('retained-after-corrupt-checkpoint\n');
    await ownerExecute(`INSERT INTO pty_checkpoints
      (id, generation_id, run_id, story_id, checkpoint_seq, first_retained_seq,
       compressed_blob, checksum, version, terminal_cols, terminal_rows)
     VALUES ($1, $2, $3, 'US-001', 4, 5, $4, $5, 1, 80, 24)`,
    [crypto.randomUUID(), generation.generationId, runId, Buffer.from('not-a-valid-checkpoint'), '0'.repeat(64)],);
    await ownerExecute(`UPDATE pty_generations SET checkpoint_sequence = 4, first_retained_sequence = 5
     WHERE id = $1`,
    [generation.generationId],);
    await ownerExecute('INSERT INTO run_pty_output_chunks (run_id, generation_id, sequence, chunk) VALUES ($1, $2, 5, $3)',
    [runId, generation.generationId, retained],);

    const body = await streamOutput(runId);
    expect(body).toContain('"checkpointSequence":4');
    expect(body).not.toContain('event: checkpoint_ready');
    expect(body).toContain('event: terminal_reset');
    expect(body).toContain('event: replay_truncated');
    expect(extractChunkPayloads(body)).toEqual([retained.toString('base64')]);
  });

  test('native PTY-backed replay preserves requested native mode and reads PTY chunks', async () => {
    const runId = await seedRun('done', 'native-pty');
    const ptyChunk = Buffer.from('\u001b[36mnative cli bytes\u001b[0m\r\n', 'utf8');

    const generation = await seedPtyGeneration(runId, 'exited');
    await ownerExecute('INSERT INTO run_pty_output_chunks (run_id, generation_id, sequence, chunk) VALUES ($1, $2, 1, $3)',
    [runId, generation.generationId, ptyChunk],);

    const body = await streamOutput(runId);

    expect(body).toContain('event: run_meta');
    expect(body).toContain('"terminalMode":"native-pty"');
    expect(body).toContain('"requestedTerminalMode":"native-pty"');
    expect(body).toContain('"isPty":true');
    expect(body).toContain(`event: chunk\ndata: ${ptyChunk.toString('base64')}`);
  });

  test('legacy PTY transcript without a session is exposed as explicit ANSI fallback evidence', async () => {
    const runId = await seedRun('done', 'pty');
    const legacyChunk = Buffer.from('legacy PTY transcript bytes\n', 'utf8');
    await ownerExecute('INSERT INTO run_output_chunks (run_id, sequence, chunk) VALUES ($1, 1, $2)', [runId, legacyChunk]);

    const body = await streamOutput(runId);

    expect(body).toContain('event: run_meta');
    expect(body).toContain('"terminalMode":"ansi-html"');
    expect(body).toContain('"requestedTerminalMode":"pty"');
    expect(body).toContain('"isPty":false');
    expect(body).toContain('"ptyFallbackActive":true');
    expect(body).toContain('"ptyFallbackReason":"pty-session-unavailable"');
    expect(body).toContain('"evidenceStoryId":"__legacy__"');
    expect(body).toContain(`event: chunk\ndata: ${legacyChunk.toString('base64')}`);
  });
});

describe('PTY resize forwarding and SSE attach/disconnect', () => {
  test('rejects input and resize for terminal partial-failure PTY runs', async () => {
    const runId = await seedRun('partial_failure', 'pty');
    const generationToken = crypto.randomUUID();

    const [resize, input] = await Promise.all([
      request(app)
        .post(`/api/pipeline/runs/${runId}/pty/resize`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ generationToken, cols: 132, rows: 43 }),
      request(app)
        .post(`/api/pipeline/runs/${runId}/input`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ generationToken, dataBase64: Buffer.from('must-not-send', 'utf8').toString('base64') }),
    ]);

    expect(resize.status).toBe(409);
    expect(input.status).toBe(409);
  });

  test('resize requests are consumed only by the exact PTY generation', async () => {
    const runId = await seedRun('running', 'pty');
    const generation = await startRunPtySession({
      runId, workspaceId: 'ws-pty-attach', storyId: 'US-001', attempt: 1,
      cwd: wsDir, agentType: 'claude', cols: 80, rows: 24, childPid: null,
    });
    const generationRef = {
      runId, generationId: generation.generationId, generationToken: generation.generationToken,
    };

    const res = await request(app)
      .post(`/api/pipeline/runs/${runId}/pty/resize`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ generationToken: generation.generationToken, cols: 132, rows: 43 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      ok: true, runId, cols: 132, rows: 43,
      generation: expect.objectContaining({ generationId: generation.generationId }),
    }));

    const claimed = await claimLatestRunPtyResize(generationRef);
    expect(claimed).toEqual(expect.objectContaining({ cols: 132, rows: 43 }));
    const remaining = await db.queryOne<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM run_pty_resize_requests WHERE run_id = $1',
      [runId],
    );
    expect(remaining?.count).toBe('0');
  });

  test('clamps unsafe dimensions while rejecting oversized dimensions and invalid UTF-8', async () => {
    const runId = await seedRun('running', 'pty');
    const generation = await startRunPtySession({
      runId, workspaceId: 'ws-pty-attach', storyId: 'US-001', attempt: 1,
      cwd: wsDir, agentType: 'claude', cols: 80, rows: 24, childPid: null,
    });
    const generationToken = generation.generationToken;
    const resize = await request(app)
      .post(`/api/pipeline/runs/${runId}/pty/resize`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ generationToken, cols: 501, rows: 24 });
    const undersizedResize = await request(app)
      .post(`/api/pipeline/runs/${runId}/pty/resize`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ generationToken, cols: 11, rows: 5 });
    const input = await request(app)
      .post(`/api/pipeline/runs/${runId}/input`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ generationToken, dataBase64: Buffer.from([0xc3, 0x28]).toString('base64') });

    expect(resize.status).toBe(400);
    expect(undersizedResize.status).toBe(200);
    expect(input.status).toBe(400);
    const claimed = await claimLatestRunPtyResize({
      runId,
      generationId: generation.generationId,
      generationToken,
    });
    expect(claimed).toEqual(expect.objectContaining({ cols: 80, rows: 12 }));
    const controls = await db.queryOne<{ inputs: string; resizes: string }>(
      `SELECT
         (SELECT COUNT(*)::text FROM run_pty_input_requests WHERE run_id = $1) AS inputs,
         (SELECT COUNT(*)::text FROM run_pty_resize_requests WHERE run_id = $1) AS resizes`,
      [runId],
    );
    expect(controls).toEqual({ inputs: '0', resizes: '0' });
  });

  test('closing the SSE output attachment clears polling and stops further DB reads', async () => {
    const runId = await seedRun('running', 'pty');
    await startRunPtySession({
      runId, workspaceId: 'ws-pty-attach', storyId: 'US-001', attempt: 1,
      cwd: wsDir, agentType: 'claude', cols: 80, rows: 24, childPid: null,
    });

    const querySpy = jest.spyOn(db, 'query');
    const queryOneSpy = jest.spyOn(db, 'queryOne');
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    const completion = Promise.withResolvers<string>();
    let received = '';
    let closed = false;
    const clientReq = http.get({
      port,
      path: `/api/pipeline/runs/${runId}/output?workspaceId=${PTY_WORKSPACE_ID}`,
      headers: { Authorization: `Bearer ${authToken}` },
    }, (clientRes) => {
      clientRes.setEncoding('utf8');
      clientRes.on('data', (chunk: string) => {
        received += chunk;
        if (!closed && received.includes('event: run_meta')) {
          closed = true;
          clientReq.destroy();
          // This contract observes the real polling interval: after disconnect,
          // a complete interval must pass without another database read.
          setTimeout(() => {
            const callsAfterClose = querySpy.mock.calls.length + queryOneSpy.mock.calls.length;
            setTimeout(() => {
              const callsAfterWait = querySpy.mock.calls.length + queryOneSpy.mock.calls.length;
              try {
                expect(callsAfterWait).toBe(callsAfterClose);
                completion.resolve(received);
              } catch (error) {
                completion.reject(error);
              }
            }, 450);
          }, 75);
        }
      });
    });
    clientReq.on('error', (error) => {
      if (closed) return;
      completion.reject(error);
    });
    clientReq.setTimeout(5_000, () => {
      clientReq.destroy();
      completion.reject(new Error('Timed out waiting for run_meta SSE event'));
    });

    try {
      const body = await completion.promise;
      expect(body).toContain('event: run_meta');
      expect(body).toContain('"isPty":true');
    } finally {
      const serverClosed = Promise.withResolvers<void>();
      server.close(error => error ? serverClosed.reject(error) : serverClosed.resolve());
      await serverClosed.promise;
    }
  });
});
