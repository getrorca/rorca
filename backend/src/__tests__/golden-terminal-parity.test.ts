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
import { Pool } from 'pg';
import request from 'supertest';
import {
  GOLDEN_ENGINES,
  buildGoldenDiffReport,
  compareGoldenReplay,
  getGoldenAvailability,
  loadGoldenFixture,
} from './helpers/golden-terminal-harness';

jest.setTimeout(90_000);

jest.mock('../lib/llm-client', () => ({
  chatComplete: jest.fn(),
  getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
  isValidModel: jest.fn().mockReturnValue(true),
  DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
  resolveVaultProvider: jest.fn().mockReturnValue(null),
  getModelInfo: jest.fn().mockReturnValue(undefined),
  SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
}));

jest.mock('../lib/pg-boss', () => ({
  initBoss: jest.fn().mockResolvedValue(undefined),
  getBoss: jest.fn().mockReturnValue({
    send: jest.fn().mockResolvedValue('mock-job-id'),
    work: jest.fn(),
    stop: jest.fn().mockResolvedValue(undefined),
  }),
}));

jest.mock('../lib/pty-manager', () => ({
  PTY_AVAILABLE: true,
  PTY_UNAVAILABLE_HINT: 'Run: cd backend && npm rebuild node-pty',
}));

const GOLDEN_WORKSPACE_ID = 'ws-golden';
const ENVIRONMENT_KEYS = ['NODE_ENV', 'RORCA_TEST_DATABASE_WORKSPACE_SCOPE'] as const;
const originalEnvironment = Object.fromEntries(
  ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENVIRONMENT_KEYS)[number], string | undefined>;

// db/index captures the workspace fence when the server is loaded.
process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE = GOLDEN_WORKSPACE_ID;

const migrationDatabaseUrl = process.env.WAVE2_TEST_MIGRATION_DATABASE_URL;
if (!migrationDatabaseUrl) throw new Error('WAVE2_TEST_MIGRATION_DATABASE_URL is required');
const ownerPool = new Pool({
  connectionString: migrationDatabaseUrl,
  max: 1,
  options: `--search_path=rorca,public -c rorca.migration_mode=on -c rorca.workspace_id=${GOLDEN_WORKSPACE_ID}`,
});

let app: Express;
let tmpDir: string;
let wsDir: string;

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

async function cleanupGoldenFixtures(): Promise<void> {
  await ownerExecute(
    'DELETE FROM run_pty_output_chunks WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = $1)',
    [GOLDEN_WORKSPACE_ID],
  );
  await ownerExecute(
    'DELETE FROM run_pty_sessions WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = $1)',
    [GOLDEN_WORKSPACE_ID],
  );
  await ownerExecute(
    'DELETE FROM run_output_chunks WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = $1)',
    [GOLDEN_WORKSPACE_ID],
  );
  await ownerExecute('DELETE FROM pipeline_runs WHERE workspace_id = $1', [GOLDEN_WORKSPACE_ID]);
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE = GOLDEN_WORKSPACE_ID;
  const serverMod = require('../server');
  app = serverMod.default;
});

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-golden-terminal-'));
  wsDir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(path.join(wsDir, 'forge', 'specs', 'approved'), { recursive: true });

  await cleanupGoldenFixtures();
  await ownerExecute(
    `INSERT INTO workspaces (id, label, path) VALUES ($1, 'Golden WS', $2)
     ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path`,
    [GOLDEN_WORKSPACE_ID, wsDir],
  );
});

afterEach(async () => {
  await cleanupGoldenFixtures();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(async () => {
  try {
    await ownerExecute('DELETE FROM workspaces WHERE id = $1', [GOLDEN_WORKSPACE_ID]);
  } finally {
    await ownerPool.end();
    restoreEnvironment();
  }
});

async function seedRun(agentType: string): Promise<number> {
  const row = await ownerQueryOne<{ id: number }>(
    `INSERT INTO pipeline_runs (spec_path, workspace_id, status, pid, terminal_mode, agent_type)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    ['forge/specs/approved/test-spec.json', GOLDEN_WORKSPACE_ID, 'done', null, 'pty', agentType],
  );
  return row!.id;
}

async function streamOutput(runId: number): Promise<string> {
  const response = await request(app)
    .get(`/api/pipeline/runs/${runId}/output?workspaceId=${GOLDEN_WORKSPACE_ID}`)
    .buffer(true)
    .parse((res, callback) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
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

describe('golden PTY terminal parity harness', () => {
  for (const engine of GOLDEN_ENGINES) {
    const availability = getGoldenAvailability(engine);
    const title = `${engine} replay matches direct capture at pinned terminal size`;

    test(title, async () => {
      const fixture = loadGoldenFixture(engine);
      const runId = await seedRun(fixture.manifest.agentType);

      await ownerExecute(
        `INSERT INTO run_pty_sessions
          (run_id, workspace_id, cwd, agent_type, cols, rows, child_pid, status, started_at, last_output_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW(), NOW())`,
        [
          runId,
          GOLDEN_WORKSPACE_ID,
          wsDir,
          fixture.manifest.agentType,
          fixture.manifest.terminal.cols,
          fixture.manifest.terminal.rows,
          null,
          'exited',
        ],
      );

      for (const chunk of fixture.replayChunks) {
        await ownerExecute(`INSERT INTO run_pty_output_chunks (run_id, sequence, chunk) VALUES ($1, $2, $3)`, [
          runId,
          chunk.sequence,
          chunk.chunk,
        ]);
      }

      const body = await streamOutput(runId);
      const events = parseSseEvents(body);
      const chunkEvents = events.filter((event) => event.event === 'chunk');
      const replayed = Buffer.concat(chunkEvents.map((event) => Buffer.from(event.data, 'base64')));
      const comparison = compareGoldenReplay(
        fixture,
        replayed,
        chunkEvents.map((event) => event.id),
        availability,
      );

      expect(events.find((event) => event.event === 'run_meta')?.data).toContain('"terminalMode":"pty"');
      expect(events.find((event) => event.event === 'run_meta')?.data).toContain(`"agentType":"${engine}"`);
      expect(events.at(-1)?.event).toBe('done');
      expect(comparison.contracts).toMatchObject({
        layout: true,
        eventOrder: true,
        terminalState: true,
        byteOrder: true,
      });

      if (!comparison.contracts.version) {
        console.warn(buildGoldenDiffReport(fixture, replayed, comparison.chunkIds, availability));
      }

    });
  }
});
