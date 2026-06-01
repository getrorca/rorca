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
import { execute, queryOne } from '../db/index';
import {
  GOLDEN_ENGINES,
  assertGoldenReplay,
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

let app: Express;
let tmpDir: string;
let wsDir: string;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  const serverMod = require('../server');
  app = serverMod.default;
});

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-golden-terminal-'));
  wsDir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(path.join(wsDir, 'forge', 'specs', 'approved'), { recursive: true });

  await execute(`DELETE FROM run_pty_output_chunks WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = 'ws-golden')`);
  await execute(`DELETE FROM run_pty_sessions WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = 'ws-golden')`);
  await execute(`DELETE FROM run_output_chunks WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = 'ws-golden')`);
  await execute(`DELETE FROM pipeline_runs WHERE workspace_id = 'ws-golden'`);
  await execute(
    `INSERT INTO workspaces (id, label, path) VALUES ('ws-golden', 'Golden WS', $1)
     ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path`,
    [wsDir],
  );
});

afterEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(async () => {
  delete process.env.NODE_ENV;
});

async function seedRun(agentType: string): Promise<number> {
  const row = await queryOne<{ id: number }>(
    `INSERT INTO pipeline_runs (spec_path, workspace_id, status, pid, terminal_mode, agent_type)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    ['forge/specs/approved/test-spec.json', 'ws-golden', 'done', null, 'pty', agentType],
  );
  return row!.id;
}

async function streamOutput(runId: number): Promise<string> {
  const response = await request(app)
    .get(`/api/pipeline/runs/${runId}/output?workspaceId=ws-golden`)
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
    const runTest = availability.available ? test : test.skip;
    const title = availability.available
      ? `${engine} replay matches direct capture at pinned terminal size`
      : `${engine} replay matches direct capture at pinned terminal size [skip: ${availability.reason}]`;

    runTest(title, async () => {
      const fixture = loadGoldenFixture(engine);
      const runId = await seedRun(fixture.manifest.agentType);

      await execute(
        `INSERT INTO run_pty_sessions
          (run_id, workspace_id, cwd, agent_type, cols, rows, child_pid, status, started_at, last_output_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW(), NOW())`,
        [
          runId,
          'ws-golden',
          wsDir,
          fixture.manifest.agentType,
          fixture.manifest.terminal.cols,
          fixture.manifest.terminal.rows,
          null,
          'exited',
        ],
      );

      for (const chunk of fixture.replayChunks) {
        await execute(`INSERT INTO run_pty_output_chunks (run_id, sequence, chunk) VALUES ($1, $2, $3)`, [
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
      expect(comparison.chunkIds).toEqual(comparison.expectedChunkIds);
      expect(comparison.rawMatches).toBe(true);

      if (!comparison.contracts.version) {
        console.warn(buildGoldenDiffReport(fixture, replayed, comparison.chunkIds, availability));
      }

      assertGoldenReplay(fixture, replayed, comparison.chunkIds, availability);
    });
  }
});
