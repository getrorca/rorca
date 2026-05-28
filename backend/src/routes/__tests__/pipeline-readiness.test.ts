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
import { getAuthToken } from './helpers/auth-helper';
import { execute } from '../../db/index';

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

let app: Express;
let tmpDir: string;
let wsDir: string;
let authToken: string;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  const serverMod = require('../../server');
  app = serverMod.default;
  authToken = await getAuthToken(app);

  await execute(`UPDATE users SET plan = 'pro' WHERE email = 'testauth@example.com'`);
  await execute(
    `INSERT INTO users (id, email, display_name, password_hash, plan)
     VALUES ('local-admin', 'admin@rorca.local', 'Admin', 'x', 'pro')
     ON CONFLICT (id) DO UPDATE SET plan = 'pro'`
  );
});

beforeEach(async () => {
  jest.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-pipeline-readiness-'));
  wsDir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(path.join(wsDir, 'forge', 'specs', 'approved'), { recursive: true });

  await execute(`DELETE FROM token_usage WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = 'ws-ready')`);
  await execute(`DELETE FROM story_results WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = 'ws-ready')`);
  await execute(`DELETE FROM pipeline_runs WHERE workspace_id = 'ws-ready'`);
  await execute(`DELETE FROM wal_events WHERE workspace_id = 'ws-ready'`);
  await execute(`INSERT INTO workspaces (id, label, path) VALUES ('ws-ready', 'Pipeline Ready', $1) ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path`, [wsDir]);
});

afterEach(async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 100));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(() => {
  delete process.env.NODE_ENV;
});

function writeSpec(slug: string, spec: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(wsDir, 'forge', 'specs', 'approved', `${slug}.json`),
    JSON.stringify(spec, null, 2),
    'utf8',
  );
}

describe('pipeline execution readiness', () => {
  test('POST /api/pipeline/preflight includes executionReadiness story scores', async () => {
    writeSpec('readiness-preflight', {
      title: 'readiness preflight',
      userStories: [
        {
          id: 'US-001',
          title: 'Investigate baseline behavior',
          description: 'Analyze and document the current system behavior before implementation.',
          acceptanceCriteria: ['Summarize findings'],
          dependsOn: [],
          passes: false,
        },
        {
          id: 'US-002',
          title: 'Add failing regression test',
          description: 'Update backend/src/routes/pipeline.ts and backend/src/routes/__tests__/pipeline-readiness.test.ts with a regression test.',
          acceptanceCriteria: ['Add test', 'Pass targeted checks'],
          dependsOn: [],
          passes: false,
        },
      ],
    });

    const res = await request(app)
      .post('/api/pipeline/preflight')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ specPath: 'forge/specs/approved/readiness-preflight.json', workspaceId: 'ws-ready' });

    expect(res.status).toBe(200);
    expect(res.body.executionReadiness).toBeDefined();
    expect(res.body.executionReadiness.stories).toHaveLength(2);
    expect(res.body.executionReadiness.stories[0].grade).toBe('weak');
    expect(res.body.executionReadiness.stories[1].recommendedFallbackEngine).toBe('codex');
  });

  test('POST /api/pipeline/trigger includes executionReadiness in the response', async () => {
    writeSpec('readiness-trigger', {
      title: 'readiness trigger',
      userStories: [
        {
          id: 'US-001',
          title: 'Patch backend pipeline route',
          description: 'Update backend/src/routes/pipeline.ts and extend backend/src/routes/__tests__/pipeline-readiness.test.ts.',
          acceptanceCriteria: ['Apply the route patch', 'Keep tests green'],
          dependsOn: [],
          passes: false,
        },
      ],
    });

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ specPath: 'forge/specs/approved/readiness-trigger.json', workspaceId: 'ws-ready', agentOverride: 'pi' });

    expect(res.status).toBe(201);
    expect(res.body.executionReadiness).toBeDefined();
    expect(res.body.executionReadiness.mode).toBe('impl');
    expect(res.body.executionReadiness.stories[0].recommendedFallbackEngine).toBe('codex');
  });
});
