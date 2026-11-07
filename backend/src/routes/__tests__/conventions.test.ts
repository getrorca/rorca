/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'crypto';
import { once } from 'events';
import * as fs from 'fs';
import type { Server } from 'http';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import request from 'supertest';
import { execute, queryOne } from '../../db/index';
import { getAuthToken } from './helpers/auth-helper';

const mockDiscoverConventions = jest.fn().mockResolvedValue({
  stack: [{ name: 'React', version: '18', role: 'ui', confidence: 'high', evidence: ['package.json'] }],
  conventions: [{ category: 'naming', observation: 'camelCase', source: 'src/', confidence: 'high' }],
  architecture: { pattern: 'SPA', entryPoints: ['src/main.tsx'], directories: [] },
  fileGovernance: [{ glob: 'src/**', owner: 'Frontend specialist', rules: ['Use TypeScript'] }],
  directionL3: '## Stack\nReact + TypeScript',
  claudeMd: null,
  agentsMd: '# AGENTS.md\n\nFile governance.',
  skills: [],
});

jest.mock('../../lib/convention-agent', () => ({
  discoverConventions: (...args: unknown[]) => mockDiscoverConventions(...args),
}));

jest.mock('../../lib/llm-client', () => ({
  chatComplete: jest.fn(),
  getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
  isValidModel: jest.fn().mockReturnValue(true),
  DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
  resolveVaultProvider: jest.fn().mockReturnValue(null),
  getModelInfo: jest.fn().mockReturnValue(undefined),
  SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
}));

const fixtureId = crypto.randomUUID();
const workspaceId = `ws-conventions-${fixtureId}`;
const authEmail = `conventions-${fixtureId}@test.rorca.local`;
let app: Server;
let tmpDir: string;
let authToken: string;

function api() {
  return request(app);
}

async function cleanFixture(): Promise<void> {
  await execute('DELETE FROM convention_proposals WHERE workspace_id = $1', [workspaceId]);
  await execute('DELETE FROM wal_events WHERE workspace_id = $1', [workspaceId]);
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-conventions-test-'));
  const serverMod = require('../../server');
  const expressApp = serverMod.default as Express;
  authToken = await getAuthToken(expressApp, {
    email: authEmail,
    authId: crypto.randomUUID(),
    role: 'admin',
  });
  await execute('INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3)', [
    workspaceId,
    'Conventions Test Workspace',
    tmpDir,
  ]);
  app = expressApp.listen(0, '127.0.0.1');
  await once(app, 'listening');
});

beforeEach(async () => {
  mockDiscoverConventions.mockClear();
  await cleanFixture();
});

afterEach(cleanFixture);

afterAll(async () => {
  await cleanFixture();
  await execute('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
  if (app) {
    app.closeAllConnections();
    await new Promise<void>((resolve, reject) => app.close(error => error ? reject(error) : resolve()));
  }
  await execute('DELETE FROM users WHERE email = $1', [authEmail]);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.NODE_ENV;
});

describe('POST /api/conventions/discover', () => {
  test('returns 400 when workspaceId is missing', async () => {
    const res = await api()
      .post('/api/conventions/discover')
      .set('Authorization', `Bearer ${authToken}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/workspaceId/i);
  });

  test('returns 404 for unknown workspace', async () => {
    const res = await api()
      .post('/api/conventions/discover')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'nonexistent-ws' });

    expect(res.status).toBe(404);
  });

  test('creates one pending convention proposal with an exact WAL identity', async () => {
    const res = await api()
      .post('/api/conventions/discover')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: expect.any(Number),
      workspaceId,
      status: 'pending',
      proposal: expect.objectContaining({ directionL3: '## Stack\nReact + TypeScript' }),
    });
    expect(mockDiscoverConventions).toHaveBeenCalledWith(tmpDir);

    const proposal = await queryOne<{ status: string }>(
      'SELECT status FROM convention_proposals WHERE id = $1 AND workspace_id = $2',
      [res.body.id, workspaceId],
    );
    const wal = await queryOne<{ payload: Record<string, unknown> | string }>(
      "SELECT payload FROM wal_events WHERE workspace_id = $1 AND event_type = 'convention_discovered' ORDER BY id DESC LIMIT 1",
      [workspaceId],
    );
    const payload = typeof wal?.payload === 'string' ? JSON.parse(wal.payload) : wal?.payload;
    expect(proposal?.status).toBe('pending');
    expect(payload).toMatchObject({ proposalId: res.body.id, conventionCount: 1, skillCount: 0 });
  });
});

describe('GET /api/conventions/proposals/:workspaceId', () => {
  test('returns the canonical empty pageless collection shape', async () => {
    const res = await api()
      .get(`/api/conventions/proposals/${workspaceId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], total: 0 });
  });
});

describe('POST /api/conventions/proposals/:id/reject', () => {
  test('returns 404 for a positive proposal id that does not exist', async () => {
    const res = await api()
      .post('/api/conventions/proposals/999999/reject')
      .set('Authorization', `Bearer ${authToken}`)
      .send({});

    expect(res.status).toBe(404);
  });

  test('rejects a non-numeric proposal id at the route boundary before SQL', async () => {
    const res = await api()
      .post('/api/conventions/proposals/nonexistent-id/reject')
      .set('Authorization', `Bearer ${authToken}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/positive integer/i);
  });
});

describe('GET /api/conventions/drift/:workspaceId', () => {
  test('returns the explicit not-yet-implemented report shape', async () => {
    const res = await api()
      .get(`/api/conventions/drift/${workspaceId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ report: null });
  });
});
