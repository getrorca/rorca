/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import request from 'supertest';
import { execute, queryOne } from '../../db/index';

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

const fixturePath = path.join(__dirname, '..', '..', 'lib', '__tests__', 'fixtures', 'claude-code-parity.jsonl');
const codexFixturePath = path.join(__dirname, '..', '..', 'lib', '__tests__', 'fixtures', 'codex-parity.json');

interface CodexFixtureChunk {
  sequence: number;
  stream: 'stdout' | 'stderr';
  base64: string;
}

interface CodexFixture {
  fixture: string;
  agentType: string;
  codexVersion: string;
  terminalWidth: number;
  chunks: CodexFixtureChunk[];
}

let app: Express;
let tmpDir: string;
let wsDir: string;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  const serverMod = require('../../server');
  app = serverMod.default;
});

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-pipeline-output-parity-'));
  wsDir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(path.join(wsDir, 'forge', 'specs', 'approved'), { recursive: true });

  await execute(`DELETE FROM run_pty_output_chunks WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = 'ws-output')`);
  await execute(`DELETE FROM run_pty_sessions WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = 'ws-output')`);
  await execute(`DELETE FROM run_output_chunks WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = 'ws-output')`);
  await execute(`DELETE FROM pipeline_runs WHERE workspace_id = 'ws-output'`);
  await execute(`INSERT INTO workspaces (id, label, path) VALUES ('ws-output', 'Output WS', $1)
    ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path`, [wsDir]);
});

afterEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 150));
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(async () => {
  delete process.env.NODE_ENV;
});

async function seedRun(terminalMode: 'ansi-html' | 'pty', agentType = 'claude'): Promise<number> {
  const row = await queryOne<{ id: number }>(
    `INSERT INTO pipeline_runs (spec_path, workspace_id, status, pid, terminal_mode, agent_type)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    ['forge/specs/approved/test-spec.json', 'ws-output', 'done', null, terminalMode, agentType],
  );
  return row!.id;
}

function readFixtureBytes(): Buffer {
  return fs.readFileSync(fixturePath);
}

function readCodexFixture(): CodexFixture {
  return JSON.parse(fs.readFileSync(codexFixturePath, 'utf8')) as CodexFixture;
}

function readCodexFixtureBytes(): Buffer {
  const fixture = readCodexFixture();
  return Buffer.concat(fixture.chunks.map((chunk) => Buffer.from(chunk.base64, 'base64')));
}

function extractPtyBytesFromFixture(): Buffer {
  const lines = fs.readFileSync(fixturePath, 'utf8').trimEnd().split('\n').slice(1);
  const parts: string[] = [];
  for (const line of lines) {
    const event = JSON.parse(line) as any;
    if (event.type !== 'assistant' || !Array.isArray(event.message?.content)) continue;
    for (const block of event.message.content as Array<{ type?: string; text?: string }>) {
      if (block.type === 'text' && block.text) parts.push(block.text);
    }
  }
  return Buffer.from(parts.join(''), 'utf8');
}

async function streamOutput(runId: number): Promise<string> {
  const response = await request(app)
    .get(`/api/pipeline/runs/${runId}/output?workspaceId=ws-output`)
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

function parseSseEvents(body: string): Array<Record<string, string>> {
  return body
    .split('\n\n')
    .map((block) => block.trim())
    .filter(Boolean)
    .filter((block) => !block.startsWith(':'))
    .map((block) => {
      const event: Record<string, string> = {};
      for (const line of block.split('\n')) {
        const index = line.indexOf(':');
        if (index === -1) continue;
        event[line.slice(0, index)] = line.slice(index + 1).trimStart();
      }
      return event;
    });
}

describe('GET /api/pipeline/runs/:runId/output parity replay', () => {
  test('replays transcript chunks in sequence order without changing fixture bytes', async () => {
    const runId = await seedRun('ansi-html');
    const raw = readFixtureBytes();
    const first = raw.subarray(0, 180);
    const second = raw.subarray(180, 420);
    const third = raw.subarray(420);

    await execute(`INSERT INTO run_output_chunks (run_id, sequence, chunk) VALUES ($1, $2, $3)`, [runId, 2, second]);
    await execute(`INSERT INTO run_output_chunks (run_id, sequence, chunk) VALUES ($1, $2, $3)`, [runId, 1, first]);
    await execute(`INSERT INTO run_output_chunks (run_id, sequence, chunk) VALUES ($1, $2, $3)`, [runId, 3, third]);

    const body = await streamOutput(runId);
    const events = parseSseEvents(body);
    const chunkEvents = events.filter((event) => event.event === 'chunk');
    const replayed = Buffer.concat(chunkEvents.map((event) => Buffer.from(event.data, 'base64')));

    expect(chunkEvents.map((event) => event.id)).toEqual(['1', '2', '3']);
    expect(replayed).toEqual(raw);
    expect(events.find((event) => event.event === 'run_meta')?.data).toContain('"terminalMode":"ansi-html"');
    expect(events.at(-1)?.event).toBe('done');
  });

  test('replays PTY bytes from the same fixture with cursor and ANSI controls intact', async () => {
    const runId = await seedRun('pty');
    const raw = extractPtyBytesFromFixture();
    const first = raw.subarray(0, 45);
    const second = raw.subarray(45, 90);
    const third = raw.subarray(90);

    await execute(
      `INSERT INTO run_pty_sessions
        (run_id, workspace_id, cwd, agent_type, cols, rows, child_pid, status, started_at, last_output_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW(), NOW())`,
      [runId, 'ws-output', wsDir, 'claude', 80, 24, null, 'exited'],
    );
    await execute(`INSERT INTO run_pty_output_chunks (run_id, sequence, chunk) VALUES ($1, $2, $3)`, [runId, 3, third]);
    await execute(`INSERT INTO run_pty_output_chunks (run_id, sequence, chunk) VALUES ($1, $2, $3)`, [runId, 1, first]);
    await execute(`INSERT INTO run_pty_output_chunks (run_id, sequence, chunk) VALUES ($1, $2, $3)`, [runId, 2, second]);

    const body = await streamOutput(runId);
    const events = parseSseEvents(body);
    const chunkEvents = events.filter((event) => event.event === 'chunk');
    const replayed = Buffer.concat(chunkEvents.map((event) => Buffer.from(event.data, 'base64')));
    const text = replayed.toString('utf8');

    expect(chunkEvents.map((event) => event.id)).toEqual(['1', '2', '3']);
    expect(replayed).toEqual(raw);
    expect(text).toContain('\r');
    expect(text).toContain('\x1b[2K');
    expect(text).toContain('\x1b[A');
    expect(text).toContain('\x1b[32mPASS\x1b[0m');
    expect(text).toContain('\x1b[?1049hALT SCREEN\x1b[?1049l');
    expect(events.find((event) => event.event === 'run_meta')?.data).toContain('"terminalMode":"pty"');
  });

  test('replays Codex transcript bytes in order and emits heuristic semantic steps', async () => {
    const runId = await seedRun('ansi-html', 'codex');
    const fixture = readCodexFixture();

    for (const chunk of [fixture.chunks[3], fixture.chunks[1], fixture.chunks[0], fixture.chunks[7], fixture.chunks[2], fixture.chunks[6], fixture.chunks[5], fixture.chunks[4]]) {
      await execute(`INSERT INTO run_output_chunks (run_id, sequence, chunk) VALUES ($1, $2, $3)`, [
        runId,
        chunk.sequence,
        Buffer.from(chunk.base64, 'base64'),
      ]);
    }

    const body = await streamOutput(runId);
    const events = parseSseEvents(body);
    const chunkEvents = events.filter((event) => event.event === 'chunk');
    const semanticEvents = events.filter((event) => event.event === 'semantic_step');
    const replayed = Buffer.concat(chunkEvents.map((event) => Buffer.from(event.data, 'base64')));
    const semanticLabels = semanticEvents.map((event) => JSON.parse(event.data).label);

    expect(chunkEvents.map((event) => event.id)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    expect(replayed).toEqual(readCodexFixtureBytes());
    expect(replayed.toString('utf8')).toContain('\x1b[33mwarning\x1b[0m: fixture stderr interleave');
    expect(replayed.toString('utf8')).toContain('\r\x1b[2K');
    expect(events.find((event) => event.event === 'run_meta')?.data).toContain('"agentType":"codex"');
    expect(events.find((event) => event.event === 'run_meta')?.data).toContain('"terminalMode":"ansi-html"');
    expect(semanticLabels).toEqual([
      'Task: Evaluate replay fidelity (step 1/2)',
      'Read README.md',
      'Write notes.txt',
    ]);
  });

  test('replays Codex PTY bytes without changing stdout/stderr interleaving or ANSI redraw controls', async () => {
    const runId = await seedRun('pty', 'codex');
    const fixture = readCodexFixture();
    const raw = readCodexFixtureBytes();

    await execute(
      `INSERT INTO run_pty_sessions
        (run_id, workspace_id, cwd, agent_type, cols, rows, child_pid, status, started_at, last_output_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW(), NOW())`,
      [runId, 'ws-output', wsDir, 'codex', fixture.terminalWidth, 24, null, 'exited'],
    );
    for (const chunk of [fixture.chunks[2], fixture.chunks[0], fixture.chunks[7], fixture.chunks[5], fixture.chunks[1], fixture.chunks[4], fixture.chunks[3], fixture.chunks[6]]) {
      await execute(`INSERT INTO run_pty_output_chunks (run_id, sequence, chunk) VALUES ($1, $2, $3)`, [
        runId,
        chunk.sequence,
        Buffer.from(chunk.base64, 'base64'),
      ]);
    }

    const body = await streamOutput(runId);
    const events = parseSseEvents(body);
    const chunkEvents = events.filter((event) => event.event === 'chunk');
    const replayed = Buffer.concat(chunkEvents.map((event) => Buffer.from(event.data, 'base64')));
    const text = replayed.toString('utf8');

    expect(chunkEvents.map((event) => event.id)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    expect(replayed).toEqual(raw);
    expect(text).toContain('\x1b[33mwarning\x1b[0m: fixture stderr interleave');
    expect(text).toContain('\r\x1b[2K');
    expect(text).toContain('\x1b[32mPASS\x1b[0m byte ordering preserved');
    expect(text).toContain('\x1b[?1049hALT SCREEN\x1b[?1049l');
    expect(events.find((event) => event.event === 'run_meta')?.data).toContain('"agentType":"codex"');
    expect(events.find((event) => event.event === 'run_meta')?.data).toContain('"terminalMode":"pty"');
  });
});
