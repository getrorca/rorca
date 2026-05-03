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
import { execute, queryOne } from '../../db/index';

jest.mock('../../lib/llm-client', () => ({
  chatComplete: jest.fn(),
  getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
  isValidModel: jest.fn().mockReturnValue(true),
  DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
  resolveVaultProvider: jest.fn().mockReturnValue(null),
  getModelInfo: jest.fn().mockReturnValue(undefined),
  SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
}));

let app: Express;
let tmpDir: string;
let authToken: string;

const workspaceId = 'export-test-ws';
let runId: number;

beforeEach(async () => {
  jest.resetModules();

  jest.mock('../../lib/llm-client', () => ({
    chatComplete: jest.fn(),
    getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
    isValidModel: jest.fn().mockReturnValue(true),
    DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
    resolveVaultProvider: jest.fn().mockReturnValue(null),
    getModelInfo: jest.fn().mockReturnValue(undefined),
    SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
  }));

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-export-test-'));
  const _dbPath = path.join(tmpDir, 'test.db');
process.env.NODE_ENV = 'test';

  const serverMod = require('../../server');
  app = serverMod.default;
authToken = await getAuthToken(app);

  // Seed test data
  await execute(`INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`, [workspaceId, 'Export Test', '/tmp/export-test']);

  const result = await queryOne<{ id: number }>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status, started_at, finished_at)
     VALUES ($1, $2, $3, NOW() - INTERVAL '1 day', NOW()) RETURNING id`, ['ralph/specs/approved/test-export.json', workspaceId, 'done']);
  runId = result!.id;

  // Insert 5 token_usage rows
  for (let i = 1; i <= 5; i++) {
    await execute(`INSERT INTO token_usage (run_id, story_id, workspace_id, model, input_tokens, output_tokens, cost_usd, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() - ($8 || ' hours')::INTERVAL)`, [runId, `US-${String(i).padStart(3, '0')}`, workspaceId, 'claude-sonnet-4-5-20250929', 10000 * i, 2000 * i, 0.05 * i, i]);
  }

  // Insert 5 story_results rows
  const statuses = ['pass', 'pass', 'fail', 'pass', 'skip'];
  for (let i = 1; i <= 5; i++) {
    await execute(`INSERT INTO story_results (run_id, story_id, status, finished_at, elapsed_seconds, input_tokens, output_tokens)
       VALUES ($1, $2, $3, NOW() - ($4 || ' hours')::INTERVAL, $5, $6, $7)`, [runId, `US-${String(i).padStart(3, '0')}`, statuses[i - 1], i, 60 * i, 10000 * i, 2000 * i]);
  }
});

afterEach(() => {
fs.rmSync(tmpDir, { recursive: true, force: true });
delete process.env.NODE_ENV;
});

function get(urlPath: string) {
  return request(app).get(urlPath).set('Authorization', `Bearer ${authToken}`);
}

describe('GET /api/analytics/export (V2-050)', () => {
  // ─── Validation ────────────────────────────────────────────────────

  it('returns 400 if format is missing', async () => {
    const res = await get('/api/analytics/export?data_type=usage');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/format/);
  });

  it('returns 400 if format is invalid', async () => {
    const res = await get('/api/analytics/export?format=xml&data_type=usage');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/format/);
  });

  it('returns 400 if data_type is missing', async () => {
    const res = await get('/api/analytics/export?format=csv');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/data_type/);
  });

  it('returns 400 if data_type is invalid', async () => {
    const res = await get('/api/analytics/export?format=csv&data_type=foobar');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/data_type/);
  });

  // ─── CSV Exports ───────────────────────────────────────────────────

  it('exports usage data as CSV with proper headers', async () => {
    const res = await get('/api/analytics/export?format=csv&data_type=usage&workspace_id=' + workspaceId);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment.*\.csv/);

    const lines = res.text.trim().split('\r\n');
    expect(lines[0]).toBe('model,story_id,input_tokens,output_tokens,cost_usd,recorded_at,workspace_id,user_id');
    expect(lines.length).toBe(6); // header + 5 data rows
  });

  it('exports costs data as CSV', async () => {
    const res = await get('/api/analytics/export?format=csv&data_type=costs&workspace_id=' + workspaceId);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);

    const lines = res.text.trim().split('\r\n');
    expect(lines[0]).toContain('model');
    expect(lines[0]).toContain('input_cost_usd');
    expect(lines[0]).toContain('output_cost_usd');
  });

  it('exports velocity data as CSV', async () => {
    const res = await get('/api/analytics/export?format=csv&data_type=velocity&workspace_id=' + workspaceId);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);

    const lines = res.text.trim().split('\r\n');
    expect(lines[0]).toContain('story_id');
    expect(lines[0]).toContain('status');
    expect(lines[0]).toContain('week');
  });

  it('exports completion data as CSV', async () => {
    const res = await get('/api/analytics/export?format=csv&data_type=completion&workspace_id=' + workspaceId);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);

    const lines = res.text.trim().split('\r\n');
    expect(lines[0]).toContain('story_id');
    expect(lines[0]).toContain('status');
  });

  // ─── JSON Exports ──────────────────────────────────────────────────

  it('exports usage data as JSON with meta', async () => {
    const res = await get('/api/analytics/export?format=json&data_type=usage&workspace_id=' + workspaceId);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['content-disposition']).toMatch(/attachment.*\.json/);

    expect(res.body.data).toBeDefined();
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(5);
    expect(res.body.meta).toBeDefined();
    expect(res.body.meta.dataType).toBe('usage');
    expect(res.body.meta.total).toBe(5);
    expect(res.body.meta.page).toBe(1);
  });

  it('exports costs data as JSON', async () => {
    const res = await get('/api/analytics/export?format=json&data_type=costs&workspace_id=' + workspaceId);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(5);
    expect(res.body.data[0]).toHaveProperty('input_cost_usd');
  });

  // ─── RFC 4180 CSV compliance ───────────────────────────────────────

  it('properly quotes CSV fields containing commas', async () => {
    // Insert a token_usage row with a user_id containing a comma
    await execute(`INSERT INTO token_usage (run_id, story_id, workspace_id, user_id, model, input_tokens, output_tokens, cost_usd, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`, [runId, 'US-COMMA', workspaceId, 'user,with,commas', 'claude-sonnet-4-5-20250929', 1000, 200, 0.01]);

    const res = await get('/api/analytics/export?format=csv&data_type=usage&workspace_id=' + workspaceId);
    expect(res.status).toBe(200);

    // The field with commas should be double-quoted per RFC 4180
    expect(res.text).toContain('"user,with,commas"');
  });

  // ─── Content-Disposition ───────────────────────────────────────────

  it('includes timestamp in filename', async () => {
    const res = await get('/api/analytics/export?format=csv&data_type=usage&workspace_id=' + workspaceId);
    expect(res.status).toBe(200);

    const disposition = res.headers['content-disposition'];
    // Should match: rorca-usage-YYYY-MM-DDTHH-MM-SS.csv
    expect(disposition).toMatch(/rorca-usage-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.csv/);
  });

  // ─── Pagination ────────────────────────────────────────────────────

  it('paginates results and sets Link header when truncated', async () => {
    const res = await get('/api/analytics/export?format=json&data_type=usage&workspace_id=' + workspaceId + '&limit=2&page=1');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(2);
    expect(res.body.meta.page).toBe(1);
    expect(res.body.meta.limit).toBe(2);

    // Should have Link header pointing to next page
    expect(res.headers['link']).toMatch(/page=2/);
    expect(res.headers['link']).toMatch(/rel="next"/);

    // X-Total-Count header
    expect(parseInt(res.headers['x-total-count'], 10)).toBe(5);
  });

  it('does not set Link header on the last page', async () => {
    const res = await get('/api/analytics/export?format=json&data_type=usage&workspace_id=' + workspaceId + '&limit=100&page=1');
    expect(res.status).toBe(200);
    expect(res.headers['link']).toBeUndefined();
  });

  it('returns non-overlapping data across pages', async () => {
    const page1 = await get('/api/analytics/export?format=json&data_type=usage&workspace_id=' + workspaceId + '&limit=2&page=1');
    const page2 = await get('/api/analytics/export?format=json&data_type=usage&workspace_id=' + workspaceId + '&limit=2&page=2');

    expect(page1.status).toBe(200);
    expect(page2.status).toBe(200);

    // Recorded_at values should not overlap between pages
    const times1 = page1.body.data.map((r: any) => r.recorded_at);
    const times2 = page2.body.data.map((r: any) => r.recorded_at);
    const timeOverlap = times1.filter((t: string) => times2.includes(t));
    expect(timeOverlap.length).toBe(0);
  });

  // ─── Date range filtering ─────────────────────────────────────────

  it('respects date range filters', async () => {
    const futureDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const farFuture = new Date(Date.now() + 730 * 24 * 60 * 60 * 1000).toISOString();

    const res = await get(`/api/analytics/export?format=json&data_type=usage&from=${futureDate}&to=${farFuture}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.meta.total).toBe(0);
  });
});
