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
import request from 'supertest';
import { getAuthToken } from './helpers/auth-helper';
import * as db from '../../db/index';
import { claimLatestRunPtyResize, completeRunPtySession, startRunPtySession, type PtyGenerationIdentity } from '../../lib/run-pty-store';

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
  getBoss: jest.fn().mockReturnValue({
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

interface PipelineRunModeRow {
  terminal_mode: string | null;
  parallelism?: number | null;
}

interface CountRow {
  count: string;
}

let app: Express;
let authToken: string;
let tmpDir = '';
let wsDir = '';
const originalPtyOutputPollInterval = process.env.RORCA_PTY_OUTPUT_POLL_INTERVAL_MS;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  // Minimum supported cadence makes a lost-notification fallback observable
  // quickly without turning this into an arbitrary long-timeout test.
  process.env.RORCA_PTY_OUTPUT_POLL_INTERVAL_MS = '250';
  const serverMod = require('../../server');
  app = serverMod.default;
  authToken = await getAuthToken(app);
});

beforeEach(async () => {
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

  await db.execute(`DELETE FROM run_pty_resize_requests WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = 'ws-pty-attach')`);
  await db.execute(`DELETE FROM run_pty_output_chunks WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = 'ws-pty-attach')`);
  await db.execute(`DELETE FROM run_pty_sessions WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = 'ws-pty-attach')`);
  await db.execute(`DELETE FROM run_output_chunks WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = 'ws-pty-attach')`);
  await db.execute(`DELETE FROM pipeline_runs WHERE workspace_id = 'ws-pty-attach'`);
  await db.execute(`INSERT INTO workspaces (id, label, path) VALUES ('ws-pty-attach', 'PTY Attach WS', $1)
    ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path`, [wsDir]);
});

afterEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
  jest.restoreAllMocks();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(() => {
  delete process.env.NODE_ENV;
  if (originalPtyOutputPollInterval === undefined) delete process.env.RORCA_PTY_OUTPUT_POLL_INTERVAL_MS;
  else process.env.RORCA_PTY_OUTPUT_POLL_INTERVAL_MS = originalPtyOutputPollInterval;
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

async function seedRun(status: string, terminalMode: 'ansi-html' | 'pty' | 'native-pty'): Promise<number> {
  const row = await db.queryOne<{ id: number }>(
    `INSERT INTO pipeline_runs (spec_path, workspace_id, status, terminal_mode, agent, agent_type)
     VALUES ('forge/specs/approved/pty-attach.json', 'ws-pty-attach', $1, $2, 'claude', 'claude')
     RETURNING id`,
    [status, terminalMode],
  );
  return Number(row!.id);
}

async function seedPtyGeneration(runId: number, status: 'active' | 'exited' = 'active'): Promise<PtyGenerationIdentity> {
  const generation = await startRunPtySession({
    runId, workspaceId: 'ws-pty-attach', storyId: 'US-001', attempt: 1,
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
    .get(`/api/pipeline/runs/${runId}/output?workspaceId=ws-pty-attach`)
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
  test('rejects output attachment through a different workspace identity before SSE headers', async () => {
    const runId = await seedRun('done', 'pty');
    const response = await request(app)
      .get(`/api/pipeline/runs/${runId}/output?workspaceId=another-workspace`)
      .set('Authorization', `Bearer ${authToken}`);
    expect(response.status).toBe(403);
    expect(response.headers['content-type']).toContain('application/json');
  });

  test('trigger accepts camelCase terminalMode=pty, persists the run mode, and forwards the pg-boss payload', async () => {
    seedSpec('trigger-pty-payload');
    const pgBossMock = jest.requireMock('../../lib/pg-boss');
    const mockSend = pgBossMock.getBoss().send as jest.Mock;
    mockSend.mockClear();

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/trigger-pty-payload.json',
        workspaceId: 'ws-pty-attach',
        terminalMode: 'pty',
        readinessOverride: true,
      });

    expect(res.status).toBe(201);
    expect(res.body.terminalMode).toBe('pty');
    expect(res.body.terminal_mode).toBe('pty');
    expect(res.body.lifecycleStatus).toBe('queued');
    expect(res.body.lifecycle_status).toBe('queued');
    expect(typeof res.body.runId).toBe('number');

    const run = await db.queryOne<PipelineRunModeRow>('SELECT terminal_mode FROM pipeline_runs WHERE id = $1', [res.body.runId]);
    expect(run?.terminal_mode).toBe('pty');
    expect(mockSend).toHaveBeenCalledWith(
      'pipeline:run',
      expect.objectContaining({ runId: res.body.runId, terminalMode: 'pty' }),
      expect.any(Object),
    );
  });

  test('PTY trigger remains sequential even for wave-parallel story graphs', async () => {
    seedSpec('trigger-pty-sequential', [
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
      .send({
        specPath: 'forge/specs/approved/trigger-pty-sequential.json',
        workspaceId: 'ws-pty-attach',
        terminalMode: 'pty',
        readinessOverride: true,
      });

    expect(res.status).toBe(201);
    const run = await db.queryOne<PipelineRunModeRow>('SELECT terminal_mode, parallelism FROM pipeline_runs WHERE id = $1', [res.body.runId]);
    expect(run?.terminal_mode).toBe('pty');
    expect(Number(run?.parallelism)).toBe(1);
    expect(mockSend).toHaveBeenCalledWith(
      'pipeline:run',
      expect.objectContaining({ runId: res.body.runId, terminalMode: 'pty' }),
      expect.any(Object),
    );
  });

  test('PTY-backed replay emits isPty=true and reads only the dedicated PTY chunk table', async () => {
    const runId = await seedRun('done', 'pty');
    const ansiFallbackChunk = Buffer.from('ansi table should not render\n', 'utf8');
    const ptyChunk = Buffer.from('\u001b[32mreal pty bytes\u001b[0m\r\n', 'utf8');

    const generation = await seedPtyGeneration(runId, 'exited');
    await db.execute(
      'INSERT INTO run_pty_output_chunks (run_id, generation_id, sequence, chunk) VALUES ($1, $2, 1, $3)',
      [runId, generation.generationId, ptyChunk],
    );
    await db.execute('INSERT INTO run_output_chunks (run_id, sequence, chunk) VALUES ($1, 1, $2)', [runId, ansiFallbackChunk]);

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
                  await db.execute(
                    'INSERT INTO run_pty_output_chunks (run_id, generation_id, sequence, chunk) VALUES ($1, $2, 1, $3)',
                    [runId, generation.generationId, chunks[0]],
                  );
                  await db.execute(
                    'INSERT INTO run_pty_output_chunks (run_id, generation_id, sequence, chunk) VALUES ($1, $2, 2, $3)',
                    [runId, generation.generationId, chunks[1]],
                  );
                  await completeRunPtySession({
                    runId, generationId: generation.generationId, generationToken: generation.generationToken,
                  }, 'exited', 0, null);
                  await db.execute(`UPDATE pipeline_runs SET status = 'done', finished_at = NOW() WHERE id = $1`, [runId]);
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
    await db.execute(
      'INSERT INTO run_pty_output_chunks (run_id, generation_id, sequence, chunk) VALUES ($1, $2, 1, $3)',
      [runId, previous.generationId, previousChunk],
    );

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
                await db.execute(
                  'INSERT INTO run_pty_output_chunks (run_id, generation_id, sequence, chunk) VALUES ($1, $2, 1, $3)',
                  [runId, current.generationId, currentChunk],
                );
                await completeRunPtySession({
                  runId, generationId: current.generationId, generationToken: current.generationToken,
                }, 'exited', 0, null);
                await db.execute("UPDATE pipeline_runs SET status = 'done', finished_at = NOW() WHERE id = $1", [runId]);
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
                await db.execute(
                  'INSERT INTO run_output_chunks (run_id, sequence, chunk) VALUES ($1, 1, $2)',
                  [runId, fallbackChunk],
                );
                await db.execute("UPDATE pipeline_runs SET status = 'failed', finished_at = NOW() WHERE id = $1", [runId]);
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
    await db.execute(
      `INSERT INTO run_pty_output_chunks (run_id, generation_id, sequence, chunk) VALUES
       ($1, $2, 1, $3), ($1, $2, 2, $4)`,
      [runId, generation.generationId, Buffer.from('already-seen\n'), Buffer.from('resume-here\n')],
    );

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
    await db.execute(
      `INSERT INTO run_pty_output_chunks (run_id, generation_id, sequence, chunk) VALUES
       ($1, $2, 1, $3), ($1, $2, 2, $4)`,
      [runId, generation.generationId, Buffer.from('scoped-seen\n'), Buffer.from('scoped-resume\n')],
    );

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
    await db.execute(
      `INSERT INTO run_pty_output_chunks (run_id, generation_id, sequence, chunk) VALUES
       ($1, $2, 1, $3), ($1, $2, 2, $4), ($1, $2, 3, $5)`,
      [runId, generation.generationId, Buffer.from('zero\n'), Buffer.from('old-event-source\n'), Buffer.from('refresh-resume\n')],
    );

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
    await db.execute(
      'INSERT INTO run_pty_output_chunks (run_id, generation_id, sequence, chunk) VALUES ($1, $2, 1, $3)',
      [runId, generation.generationId, ptyChunk],
    );

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
    await db.execute(
      'INSERT INTO run_pty_output_chunks (run_id, generation_id, sequence, chunk) VALUES ($1, $2, 1, $3)',
      [runId, generation.generationId, currentChunk],
    );
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
    await db.execute(
      `INSERT INTO pty_checkpoints
        (id, generation_id, run_id, story_id, checkpoint_seq, first_retained_seq,
         compressed_blob, checksum, version, terminal_cols, terminal_rows)
       VALUES ($1, $2, $3, 'US-001', 4, 5, $4, $5, 1, 80, 24)`,
      [crypto.randomUUID(), generation.generationId, runId, Buffer.from('not-a-valid-checkpoint'), '0'.repeat(64)],
    );
    await db.execute(
      `UPDATE pty_generations SET checkpoint_sequence = 4, first_retained_sequence = 5
       WHERE id = $1`,
      [generation.generationId],
    );
    await db.execute(
      'INSERT INTO run_pty_output_chunks (run_id, generation_id, sequence, chunk) VALUES ($1, $2, 5, $3)',
      [runId, generation.generationId, retained],
    );

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
    await db.execute(
      'INSERT INTO run_pty_output_chunks (run_id, generation_id, sequence, chunk) VALUES ($1, $2, 1, $3)',
      [runId, generation.generationId, ptyChunk],
    );

    const body = await streamOutput(runId);

    expect(body).toContain('event: run_meta');
    expect(body).toContain('"terminalMode":"native-pty"');
    expect(body).toContain('"requestedTerminalMode":"native-pty"');
    expect(body).toContain('"isPty":true');
    expect(body).toContain(`event: chunk\ndata: ${ptyChunk.toString('base64')}`);
  });

  test('legacy PTY transcript without a session is recovered into synthetic PTY replay metadata', async () => {
    const runId = await seedRun('done', 'pty');
    const legacyChunk = Buffer.from('legacy PTY transcript bytes\n', 'utf8');
    await db.execute('INSERT INTO run_output_chunks (run_id, sequence, chunk) VALUES ($1, 1, $2)', [runId, legacyChunk]);

    const body = await streamOutput(runId);

    expect(body).toContain('event: run_meta');
    expect(body).toContain('"terminalMode":"pty"');
    expect(body).toContain('"requestedTerminalMode":"pty"');
    expect(body).toContain('"isPty":true');
    expect(body).toContain('"ptyFallbackActive":false');
    expect(body).toContain('"storyId":"__legacy__"');
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

    try {
      const port = (server.address() as AddressInfo).port;
      const body = await new Promise<string>((resolve, reject) => {
        let received = '';
        let closed = false;
        const clientReq = http.get({
          port,
          path: `/api/pipeline/runs/${runId}/output?workspaceId=ws-pty-attach`,
          headers: { Authorization: `Bearer ${authToken}` },
        }, (clientRes) => {
          clientRes.setEncoding('utf8');
          clientRes.on('data', (chunk: string) => {
            received += chunk;
            if (!closed && received.includes('event: run_meta')) {
              closed = true;
              clientReq.destroy();
              setTimeout(() => {
                const callsAfterClose = querySpy.mock.calls.length + queryOneSpy.mock.calls.length;
                setTimeout(() => {
                  const callsAfterWait = querySpy.mock.calls.length + queryOneSpy.mock.calls.length;
                  try {
                    expect(callsAfterWait).toBe(callsAfterClose);
                    resolve(received);
                  } catch (err) {
                    reject(err);
                  }
                }, 450);
              }, 75);
            }
          });
        });
        clientReq.on('error', (err) => {
          if (closed) return;
          reject(err);
        });
        clientReq.setTimeout(5_000, () => {
          clientReq.destroy();
          reject(new Error('Timed out waiting for run_meta SSE event'));
        });
      });

      expect(body).toContain('event: run_meta');
      expect(body).toContain('"isPty":true');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
