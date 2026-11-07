/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { once } from 'events';
import * as fs from 'fs';
import type { Server } from 'http';
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

jest.mock('../../lib/execution-environment-registry', () => ({
  assertExecutionEnvironmentReadyForRun: jest.fn().mockResolvedValue({ ready: true }),
}));

const fixtureId = crypto.randomUUID();
const workspaceId = `ws-readiness-${fixtureId}`;
const authEmail = `pipeline-readiness-${fixtureId}@test.rorca.local`;
const preflightSlug = `readiness-preflight-${fixtureId}`;
const triggerSlug = `readiness-trigger-${fixtureId}`;
let app: Server;
let tmpDir: string;
let wsDir: string;
let authToken: string;

function api() {
  return request(app);
}

async function cleanFixture(): Promise<void> {
  await execute('DELETE FROM token_usage WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = $1)', [workspaceId]);
  await execute('DELETE FROM story_results WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = $1)', [workspaceId]);
  await execute('DELETE FROM pipeline_dispatch_publications WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = $1)', [workspaceId]);
  await execute('DELETE FROM pipeline_runs WHERE workspace_id = $1', [workspaceId]);
  await execute('DELETE FROM wal_events WHERE workspace_id = $1', [workspaceId]);
  await execute('DELETE FROM spec_generation_logs WHERE spec_slug = ANY($1::text[])', [[preflightSlug, triggerSlug]]);
  await execute('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  const serverMod = require('../../server');
  const expressApp = serverMod.default as Express;
  authToken = await getAuthToken(expressApp, {
    email: authEmail,
    authId: crypto.randomUUID(),
    role: 'admin',
  });
  app = expressApp.listen(0, '127.0.0.1');
  await once(app, 'listening');
});

beforeEach(async () => {
  jest.clearAllMocks();
  await cleanFixture();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-pipeline-readiness-'));
  wsDir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(path.join(wsDir, 'forge', 'specs', 'approved'), { recursive: true });
  execFileSync('git', ['init', '-q', wsDir]);
  execFileSync('git', ['-C', wsDir, '-c', 'user.name=Rorca Tests', '-c', 'user.email=tests@rorca.local', 'commit', '--allow-empty', '-qm', 'test baseline']);
  await execute('INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3)', [workspaceId, 'Pipeline Ready', wsDir]);
});

afterEach(async () => {
  await cleanFixture();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(async () => {
  await cleanFixture();
  app.closeAllConnections();
  await new Promise<void>((resolve, reject) => app.close(error => error ? reject(error) : resolve()));
  await execute('DELETE FROM users WHERE email = $1', [authEmail]);
  delete process.env.NODE_ENV;
});

function writeSpec(slug: string, spec: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(wsDir, 'forge', 'specs', 'approved', `${slug}.json`),
    JSON.stringify(spec, null, 2),
    'utf8',
  );
}

async function seedSpecReadinessLog(specSlug: string): Promise<void> {
  await execute(
    `INSERT INTO spec_generation_logs (spec_slug, model, provider, duration_ms, context_summary, enriched, retrieval_method, context_summary_json, status, save_generation)
     VALUES ($1, 'claude-sonnet-4-5-20250929', 'api', 0, 'test', false, 'none', $2, 'persisted', 1)`,
    [
      specSlug,
      JSON.stringify({
        workspaceId,
        contextCaptureStatus: { status: 'provided', reason: 'caller_supplied_context' },
        postSaveStages: {
          enrich: { requested: true, status: 'completed', reason: 'job_completed' },
          matchSkills: { requested: true, status: 'completed', reason: 'job_completed' },
        },
      }),
    ],
  );
}

describe('pipeline execution readiness', () => {
  test('POST /api/pipeline/preflight includes executionReadiness story scores', async () => {
    writeSpec(preflightSlug, {
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

    const res = await api()
      .post('/api/pipeline/preflight')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ specPath: `forge/specs/approved/${preflightSlug}.json`, workspaceId });

    expect(res.status).toBe(200);
    expect(res.body.executionReadiness.stories).toHaveLength(2);
    expect(res.body.executionReadiness.stories[0].grade).toBe('weak');
    expect(res.body.executionReadiness.stories[1].recommendedFallbackEngine).toBe('codex');
  });

  test('non-mutating trigger planning includes executionReadiness without bypassing TaskManifest execution authority', async () => {
    writeSpec(triggerSlug, {
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
    await seedSpecReadinessLog(triggerSlug);

    const res = await api()
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: `forge/specs/approved/${triggerSlug}.json`,
        workspaceId,
        agentOverride: 'pi',
        dryRun: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.executionReadiness.mode).toBe('impl');
    expect(res.body.executionReadiness.stories[0].recommendedFallbackEngine).toBe('codex');
  });
});
