/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * BL-002 retirement contract: the OSS/local-first edition has no subscription
 * table and does not auto-provision or enforce a hosted billing trial.
 */
import crypto from 'crypto';
import { once } from 'events';
import type { Express, NextFunction, Request, Response } from 'express';
import * as fs from 'fs';
import type { Server } from 'http';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { execute, queryOne } from '../../db/index';
import { requirePlan } from '../../lib/require-plan';
import { getAuthToken } from './helpers/auth-helper';

const mockAutoHydrateWorkspaceContext = jest.fn().mockResolvedValue(undefined);
jest.mock('../../lib/auto-memory', () => ({
  ...jest.requireActual('../../lib/auto-memory'),
  autoHydrateWorkspaceContext: (...args: unknown[]) => mockAutoHydrateWorkspaceContext(...args),
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
const workspaceIds = [
  `billing-oss-a-${fixtureId}`,
  `billing-oss-b-${fixtureId}`,
  `billing-oss-c-${fixtureId}`,
];
const adminEmail = `billing-oss-${fixtureId}@test.rorca.local`;
let server: Server;
let tmpDir: string;
let authToken: string;
let adminUserId: string;
let previousAuthRequired: string | undefined;

function api() {
  return request(server);
}

function workspaceBody(index: number) {
  const workspacePath = path.join(tmpDir, `workspace-${index}`);
  fs.mkdirSync(workspacePath, { recursive: true });
  return {
    id: workspaceIds[index],
    label: `OSS workspace ${index}`,
    path: workspacePath,
    domains: ['saas'],
  };
}

async function cleanFixture(): Promise<void> {
  await execute('DELETE FROM agent_profiles WHERE workspace_id = ANY($1::text[])', [workspaceIds]);
  await execute('DELETE FROM workspace_context WHERE workspace_id = ANY($1::text[])', [workspaceIds]);
  await execute('DELETE FROM workspace_members WHERE workspace_id = ANY($1::text[])', [workspaceIds]);
  await execute('DELETE FROM wal_events WHERE workspace_id = ANY($1::text[])', [workspaceIds]);
  await execute('DELETE FROM workspaces WHERE id = ANY($1::text[])', [workspaceIds]);
}

beforeAll(async () => {
  previousAuthRequired = process.env.AUTH_REQUIRED;
  process.env.NODE_ENV = 'test';
  process.env.AUTH_REQUIRED = 'true';
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-billing-oss-'));

  const serverModule = require('../../server');
  const app = serverModule.default as Express;
  authToken = await getAuthToken(app, {
    email: adminEmail,
    authId: crypto.randomUUID(),
    role: 'admin',
  });
  const user = await queryOne<{ id: string }>('SELECT id FROM users WHERE email = $1', [adminEmail]);
  if (!user) throw new Error('billing fixture user was not created');
  adminUserId = user.id;
  await execute("UPDATE users SET plan = 'free' WHERE id = $1", [adminUserId]);

  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
});

beforeEach(async () => {
  mockAutoHydrateWorkspaceContext.mockClear();
  await cleanFixture();
  await execute("UPDATE users SET plan = 'free' WHERE id = $1", [adminUserId]);
});

afterEach(cleanFixture);

afterAll(async () => {
  await cleanFixture();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await execute('DELETE FROM users WHERE id = $1', [adminUserId]);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (previousAuthRequired === undefined) delete process.env.AUTH_REQUIRED;
  else process.env.AUTH_REQUIRED = previousAuthRequired;
});

describe('BL-002 retired hosted-trial behavior in the OSS edition', () => {
  test('first workspace registration succeeds without creating hosted billing state', async () => {
    const relationBefore = await queryOne<{ relation: string | null }>(
      "SELECT to_regclass('rorca.subscriptions')::text AS relation",
    );
    expect(relationBefore?.relation).toBeNull();

    const res = await api()
      .post('/api/workspaces')
      .set('Authorization', `Bearer ${authToken}`)
      .send(workspaceBody(0));

    expect(res.status).toBe(201);
    expect(res.body.workspace.id).toBe(workspaceIds[0]);
    expect(mockAutoHydrateWorkspaceContext).toHaveBeenCalledTimes(1);
    expect((await queryOne<{ plan: string }>('SELECT plan FROM users WHERE id = $1', [adminUserId]))?.plan).toBe('free');
  });

  test('multiple workspace registrations do not synthesize a subscription table or mutate the user plan', async () => {
    const first = await api()
      .post('/api/workspaces')
      .set('Authorization', `Bearer ${authToken}`)
      .send(workspaceBody(0));
    const second = await api()
      .post('/api/workspaces')
      .set('Authorization', `Bearer ${authToken}`)
      .send(workspaceBody(1));

    expect([first.status, second.status]).toEqual([201, 201]);
    expect((await queryOne<{ relation: string | null }>(
      "SELECT to_regclass('rorca.subscriptions')::text AS relation",
    ))?.relation).toBeNull();
    expect((await queryOne<{ plan: string }>('SELECT plan FROM users WHERE id = $1', [adminUserId]))?.plan).toBe('free');
  });

  test('the compatibility requirePlan middleware remains a no-op instead of inventing trial-expiry authority', async () => {
    const next = jest.fn() as NextFunction;
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    } as unknown as Response;

    await requirePlan('workspaces')({} as Request, response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).not.toHaveBeenCalled();
  });
});
