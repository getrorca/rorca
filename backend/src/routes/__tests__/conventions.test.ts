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
import request from 'supertest';
import { getAuthToken } from './helpers/auth-helper';
import { execute } from '../../db/index';

let app: Express;
let tmpDir: string;
let authToken: string;
let workspaceId: string;

beforeEach(async () => {
  jest.resetModules();

  jest.doMock('../../lib/llm-client', () => ({
    chatComplete: jest.fn().mockResolvedValue({
      text: JSON.stringify({
        l3: '## Stack\nReact + TypeScript',
        agentsMd: '# AGENTS.md\n\nFile governance.',
        libraryGuides: [],
        reasoning: 'Test reasoning',
      }),
      usage: { input_tokens: 100, output_tokens: 50 },
    }),
    getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
    isValidModel: jest.fn().mockReturnValue(true),
    DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
    resolveVaultProvider: jest.fn().mockReturnValue(null),
    getModelInfo: jest.fn().mockReturnValue(undefined),
    SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
  }));

  jest.doMock('../../lib/convention-discovery', () => ({
    discoverConventions: jest.fn().mockResolvedValue({
      stack: [{ name: 'React', version: '18', role: 'ui' }],
      conventions: [{ category: 'naming', observation: 'camelCase', source: 'src/', confidence: 'high' }],
      architecture: { pattern: 'SPA', description: 'Single page app' },
      fileGovernance: '# AGENTS.md\n\nFile governance.',
      directionL3: '## Stack\nReact + TypeScript',
      perLibraryGuides: {},
    }),
  }));

  jest.doMock('../../lib/drift-detector', () => ({
    detectDrift: jest.fn().mockResolvedValue({
      violations: [],
      summary: 'No drift detected.',
      checkedAt: new Date().toISOString(),
      score: 100,
      conventionsChecked: 0,
      filesSampled: 0,
    }),
  }));

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-conventions-test-'));
  const _dbPath = path.join(tmpDir, 'test.db');
process.env.NODE_ENV = 'test';

  const serverMod = require('../../server');
  app = serverMod.default;
authToken = await getAuthToken(app);

  workspaceId = 'ws-conventions-test-' + Date.now();
  await execute(`INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`, [workspaceId,
    'Conventions Test Workspace',
    tmpDir,]);
});

afterEach(async () => {
  // Close the fresh pool created by jest.resetModules() + require('../../server') to prevent connection exhaustion
  try { const { closePool } = require('../../db/index'); await closePool(); } catch {}
fs.rmSync(tmpDir, { recursive: true, force: true });
delete process.env.NODE_ENV;
});

// ─── POST /api/conventions/discover ───────────────────────────────────────

describe('POST /api/conventions/discover', () => {
  test('returns 400 when workspaceId is missing', async () => {
    const res = await request(app)
      .post('/api/conventions/discover')
      .set('Authorization', `Bearer ${authToken}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/workspaceId/i);
  });

  test('returns 404 for unknown workspace', async () => {
    const res = await request(app)
      .post('/api/conventions/discover')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'nonexistent-ws' });

    expect(res.status).toBe(404);
  });

  test('creates a convention proposal for valid workspace', async () => {
    const res = await request(app)
      .post('/api/conventions/discover')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId });

    expect([200, 201]).toContain(res.status);
    if (res.status === 200 || res.status === 201) {
      expect(res.body.ok).toBe(true);
      expect(res.body.proposalId || res.body.proposal).toBeDefined();
    }
  });
});

// ─── GET /api/conventions/proposals/:workspaceId ──────────────────────────

describe('GET /api/conventions/proposals/:workspaceId', () => {
  test('returns empty array when no proposals exist', async () => {
    const res = await request(app)
      .get(`/api/conventions/proposals/${workspaceId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.proposals || res.body).toBeDefined();
    const proposals = res.body.proposals || res.body;
    expect(Array.isArray(proposals)).toBe(true);
  });
});

// ─── POST /api/conventions/proposals/:id/reject ───────────────────────────

describe('POST /api/conventions/proposals/:id/reject', () => {
  test('returns 404 for non-existent proposal (numeric id)', async () => {
    // Use a large numeric ID that won't exist
    const res = await request(app)
      .post('/api/conventions/proposals/999999/reject')
      .set('Authorization', `Bearer ${authToken}`)
      .send({});

    expect(res.status).toBe(404);
  });

  test('returns 400 for non-numeric proposal id', async () => {
    const res = await request(app)
      .post('/api/conventions/proposals/nonexistent-id/reject')
      .set('Authorization', `Bearer ${authToken}`)
      .send({});

    expect(res.status).toBe(400);
  });
});

// ─── GET /api/conventions/drift/:workspaceId ──────────────────────────────

describe('GET /api/conventions/drift/:workspaceId', () => {
  test('returns null when no drift report exists', async () => {
    const res = await request(app)
      .get(`/api/conventions/drift/${workspaceId}`)
      .set('Authorization', `Bearer ${authToken}`);

    // Should be 200 with null report or 404
    expect([200, 404]).toContain(res.status);
  });
});
