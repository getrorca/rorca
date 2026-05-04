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

let app: Express;
let tmpDir: string;
let workspacePath: string;
let authToken: string;

beforeEach(async () => {
  jest.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-graph-test-'));
  const _dbPath = path.join(tmpDir, 'test.db');
process.env.NODE_ENV = 'test';

  const serverMod = require('../../server');
  app = serverMod.default;
// Create a workspace with spec directories
  workspacePath = path.join(tmpDir, 'test-project');
  fs.mkdirSync(path.join(workspacePath, 'scripts', 'ralph', 'specs', 'approved'), { recursive: true });
  fs.mkdirSync(path.join(workspacePath, 'scripts', 'ralph', 'specs', 'pending'), { recursive: true });
  await execute(`INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`, ['ws-1', 'Test', workspacePath]);
  authToken = await getAuthToken(app);
});

afterEach(async () => {
  // Close the fresh pool created by jest.resetModules() + require('../../server') to prevent connection exhaustion
  try { const { closePool } = require('../../db/index'); await closePool(); } catch {}
fs.rmSync(tmpDir, { recursive: true, force: true });
delete process.env.NODE_ENV;
});

function writeSpec(slug: string, spec: object, status: 'pending' | 'approved' = 'approved') {
  const dir = path.join(workspacePath, 'scripts', 'ralph', 'specs', status);
  fs.writeFileSync(path.join(dir, `${slug}.json`), JSON.stringify(spec));
}

test('returns DAG with nodes, edges, and parallelGroups for a linear dependency chain', async () => {
  writeSpec('my-spec', {
    title: 'My Spec',
    userStories: [
      { id: 'US-001', title: 'Setup', description: 'Init', acceptanceCriteria: ['done'], dependsOn: [] },
      { id: 'US-002', title: 'Build', description: 'Build it', acceptanceCriteria: ['done'], dependsOn: ['US-001'] },
      { id: 'US-003', title: 'Deploy', description: 'Deploy it', acceptanceCriteria: ['done'], dependsOn: ['US-002'] },
    ],
  });

  const res = await request(app).get('/api/specs/my-spec/graph?workspaceId=ws-1').set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body.nodes).toHaveLength(3);
  expect(res.body.edges).toEqual([
    { from: 'US-001', to: 'US-002' },
    { from: 'US-002', to: 'US-003' },
  ]);
  // Linear chain: each story in its own group
  expect(res.body.parallelGroups).toEqual([['US-001'], ['US-002'], ['US-003']]);
});

test('groups independent stories into the same parallel group', async () => {
  writeSpec('parallel-spec', {
    title: 'Parallel Spec',
    userStories: [
      { id: 'US-001', title: 'A', description: '', acceptanceCriteria: [], dependsOn: [] },
      { id: 'US-002', title: 'B', description: '', acceptanceCriteria: [], dependsOn: [] },
      { id: 'US-003', title: 'C', description: '', acceptanceCriteria: ['done'], dependsOn: ['US-001', 'US-002'] },
    ],
  });

  const res = await request(app).get('/api/specs/parallel-spec/graph?workspaceId=ws-1').set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  // US-001 and US-002 have no deps, should be in first group
  expect(res.body.parallelGroups[0]).toEqual(expect.arrayContaining(['US-001', 'US-002']));
  expect(res.body.parallelGroups[0]).toHaveLength(2);
  // US-003 depends on both, should be in second group
  expect(res.body.parallelGroups[1]).toEqual(['US-003']);
});

test('detects circular dependencies and returns 422 with cycle path', async () => {
  writeSpec('cycle-spec', {
    title: 'Cycle Spec',
    userStories: [
      { id: 'US-001', title: 'A', description: '', acceptanceCriteria: [], dependsOn: ['US-003'] },
      { id: 'US-002', title: 'B', description: '', acceptanceCriteria: [], dependsOn: ['US-001'] },
      { id: 'US-003', title: 'C', description: '', acceptanceCriteria: [], dependsOn: ['US-002'] },
    ],
  });

  const res = await request(app).get('/api/specs/cycle-spec/graph?workspaceId=ws-1').set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(422);
  expect(res.body.error).toMatch(/[Cc]ircular dependency/);
  expect(Array.isArray(res.body.cycle)).toBe(true);
  expect(res.body.cycle.length).toBeGreaterThanOrEqual(2);
});

test('includes story status from pipeline run when runId is provided', async () => {
  writeSpec('status-spec', {
    title: 'Status Spec',
    userStories: [
      { id: 'US-001', title: 'A', description: '', acceptanceCriteria: [], dependsOn: [] },
      { id: 'US-002', title: 'B', description: '', acceptanceCriteria: [], dependsOn: [] },
      { id: 'US-003', title: 'C', description: '', acceptanceCriteria: [], dependsOn: [] },
    ],
  });

  // Create a pipeline run and story results
  await execute(`INSERT INTO pipeline_runs (id, workspace_id, spec_path, status, started_at) VALUES ($1, $2, $3, $4, NOW())`, [1, 'ws-1', 'ralph/specs/approved/status-spec.json', 'running']);

  await execute(`INSERT INTO story_results (run_id, story_id, status, started_at) VALUES ($1, $2, $3, NOW())`, [1, 'US-001', 'pass']);
  await execute(`INSERT INTO story_results (run_id, story_id, status, started_at) VALUES ($1, $2, $3, NOW())`, [1, 'US-002', 'fail']);

  const res = await request(app).get('/api/specs/status-spec/graph?workspaceId=ws-1&runId=1').set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  const nodeMap = new Map<string, any>(res.body.nodes.map((n: any) => [n.id, n]));
  expect(nodeMap.get('US-001')!.status).toBe('passed');
  expect(nodeMap.get('US-002')!.status).toBe('failed');
  expect(nodeMap.get('US-003')!.status).toBe('pending');
});

test('returns 400 when workspaceId is missing', async () => {
  const res = await request(app).get('/api/specs/some-spec/graph').set('Authorization', `Bearer ${authToken}`);
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/workspaceId/);
});

test('returns 404 when spec does not exist', async () => {
  const res = await request(app).get('/api/specs/nonexistent/graph?workspaceId=ws-1').set('Authorization', `Bearer ${authToken}`);
  expect(res.status).toBe(404);
  expect(res.body.error).toMatch(/not found/i);
});

test('returns empty graph for spec with no stories', async () => {
  writeSpec('empty-spec', { title: 'Empty', userStories: [] });

  const res = await request(app).get('/api/specs/empty-spec/graph?workspaceId=ws-1').set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body.nodes).toEqual([]);
  expect(res.body.edges).toEqual([]);
  expect(res.body.parallelGroups).toEqual([]);
});

test('ignores dependsOn references to non-existent story IDs', async () => {
  writeSpec('dangling-spec', {
    title: 'Dangling Deps',
    userStories: [
      { id: 'US-001', title: 'A', description: '', acceptanceCriteria: [], dependsOn: ['US-999'] },
      { id: 'US-002', title: 'B', description: '', acceptanceCriteria: [], dependsOn: ['US-001'] },
    ],
  });

  const res = await request(app).get('/api/specs/dangling-spec/graph?workspaceId=ws-1').set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  // US-999 doesn't exist, so US-001 has no valid deps — it's in first group
  expect(res.body.parallelGroups[0]).toContain('US-001');
  // Edge from US-001 to US-002 still exists
  expect(res.body.edges).toEqual([{ from: 'US-001', to: 'US-002' }]);
  // No edge for the dangling ref
  expect(res.body.edges).not.toContainEqual(expect.objectContaining({ from: 'US-999' }));
});

test('reads spec from pending directory when not in approved', async () => {
  writeSpec('pending-spec', {
    title: 'Pending Spec',
    userStories: [
      { id: 'US-001', title: 'A', description: '', acceptanceCriteria: [], dependsOn: [] },
    ],
  }, 'pending');

  const res = await request(app).get('/api/specs/pending-spec/graph?workspaceId=ws-1').set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body.nodes).toHaveLength(1);
  expect(res.body.nodes[0].id).toBe('US-001');
});
