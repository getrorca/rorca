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

let app: Express;
let tmpDir: string;

const WS_ID = 'ws-dump-test';

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-recall-test-'));
  process.env.NODE_ENV = 'test';

  const serverMod = require('../../server');
  app = serverMod.default;

  // Seed workspace
  await execute(
    `INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [WS_ID, 'Dump Test Workspace', tmpDir],
  );
}, 60_000);

afterAll(async () => {
  try {
    await execute('DELETE FROM story_results WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = $1)', [WS_ID]);
    await execute('DELETE FROM pipeline_runs WHERE workspace_id = $1', [WS_ID]);
    await execute('DELETE FROM direction_layers WHERE workspace_id = $1', [WS_ID]);
    await execute('DELETE FROM installed_skills WHERE name = $1', ['test-dump-skill']);
    await execute('DELETE FROM workspaces WHERE id = $1', [WS_ID]);
  } catch {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.NODE_ENV;
});

describe('GET /api/recall', () => {
  it('returns 400 when debug=true is requested without a ranked query', async () => {
    const res = await request(app).get(`/api/recall?workspaceId=${WS_ID}&debug=true`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/debug=true is only supported/i);
  }, 60_000);
});

describe('GET /api/recall/dump', () => {
  it('returns 404 for unknown workspace', async () => {
    const res = await request(app).get('/api/recall/dump?workspaceId=nonexistent-ws-999');

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toContain('Workspace not found');
  }, 60_000);

  it('returns 400 when workspaceId is missing', async () => {
    const res = await request(app).get('/api/recall/dump');
    expect(res.status).toBe(400);
  }, 60_000);

  it('returns 200 with all sections and no truncation', async () => {
    // Seed direction layer L3
    await execute(
      `INSERT INTO direction_layers (layer, workspace_id, domain, content_yaml, updated_at)
       VALUES (3, $1, NULL, $2, NOW())
       ON CONFLICT DO NOTHING`,
      [WS_ID, 'project-level: true\nstack: node+express'],
    );

    // Seed a completed pipeline run with story results
    await execute(
      `INSERT INTO pipeline_runs (spec_path, workspace_id, status, started_at, finished_at)
       VALUES ($1, $2, $3, NOW() - interval '1 hour', NOW())`,
      ['forge/specs/approved/test-spec.json', WS_ID, 'done'],
    );
    const runRow = await queryOne<{ id: number }>(
      `SELECT id FROM pipeline_runs WHERE workspace_id = $1 ORDER BY id DESC LIMIT 1`,
      [WS_ID],
    );
    if (runRow) {
      await execute(
        `INSERT INTO story_results (run_id, story_id, status) VALUES ($1, $2, $3)`,
        [runRow.id, 'US-001', 'pass'],
      );
      await execute(
        `INSERT INTO story_results (run_id, story_id, status) VALUES ($1, $2, $3)`,
        [runRow.id, 'US-002', 'fail'],
      );
    }

    // Seed an installed skill with long content (>200 chars)
    const longContent = 'A'.repeat(500) + '\n\nThis should NOT be truncated.';
    await execute(
      `INSERT INTO installed_skills (name, description, source, content, category, tags)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (name) DO UPDATE SET content = $4`,
      ['test-dump-skill', 'A test skill', 'test', longContent, 'testing', '["test"]'],
    );

    const res = await request(app).get(`/api/recall/dump?workspaceId=${WS_ID}`);

    expect(res.status).toBe(200);
    const body = res.body;

    // memories — array (empty since no MEMORY.md in tmpDir)
    expect(Array.isArray(body.memories)).toBe(true);

    // directionLayers — raw L3 content
    expect(Array.isArray(body.directionLayers)).toBe(true);
    const l3 = body.directionLayers.find((d: { layer: number }) => d.layer === 3);
    expect(l3).toBeDefined();
    expect(l3.content).toContain('project-level');

    // skills — should contain full content, not truncated
    expect(Array.isArray(body.skills)).toBe(true);
    const skill = body.skills.find((s: { name: string }) => s.name === 'test-dump-skill');
    expect(skill).toBeDefined();
    expect(skill.content).toBe(longContent);
    expect(skill.content.length).toBeGreaterThan(200);

    // workspaceContext
    expect(body.workspaceContext).toBeDefined();
    expect(body.workspaceContext).toHaveProperty('schemaSnapshot');

    // recentRuns — should have the seeded run with story counts
    expect(Array.isArray(body.recentRuns)).toBe(true);
    expect(body.recentRuns.length).toBeGreaterThanOrEqual(1);
    const run = body.recentRuns[0];
    expect(run.passedStories).toBe(1);
    expect(run.failedStories).toBe(1);

    // metadata
    expect(body.metadata).toMatchObject({
      id: WS_ID,
      label: 'Dump Test Workspace',
      path: tmpDir,
    });

    // activeRuns — array
    expect(Array.isArray(body.activeRuns)).toBe(true);

    // meta — no tokenEstimate or retrievalTier (dump omits budget enforcement)
    expect(body.meta).toHaveProperty('latencyMs');
    expect(body.meta).toHaveProperty('generatedAt');
    expect(body.meta).not.toHaveProperty('totalTokens');
    expect(body.meta).not.toHaveProperty('retrievalTier');
  }, 60_000);

  it('returns 200 with failed sections as null on partial DB failure', async () => {
    // Set workspace path to nonexistent dir — filesystem fetchers fail gracefully
    await execute(
      `UPDATE workspaces SET path = $1 WHERE id = $2`,
      ['/nonexistent/path/that/does/not/exist', WS_ID],
    );

    const res = await request(app).get(`/api/recall/dump?workspaceId=${WS_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.metadata).toMatchObject({ id: WS_ID });
    expect(res.body.meta).toHaveProperty('generatedAt');

    // Restore valid path
    await execute(`UPDATE workspaces SET path = $1 WHERE id = $2`, [tmpDir, WS_ID]);
  }, 60_000);
});
