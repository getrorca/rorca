/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import express from 'express';
import request from 'supertest';

const mockQueryOne = jest.fn();
const mockCompile = jest.fn();
const mockBackfill = jest.fn();
const mockRetry = jest.fn();
const mockIdempotent = jest.fn();
const mockInvalidation = jest.fn();

jest.mock('../../db/index', () => ({
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
}));

jest.mock('../../lib/ssdlc-plan-service', () => ({
  compileSpecPlan: (...args: unknown[]) => mockCompile(...args),
  backfillWorkspacePlans: (...args: unknown[]) => mockBackfill(...args),
}));

jest.mock('../../lib/lifecycle-mutations', () => {
  const actual = jest.requireActual('../../lib/lifecycle-mutations');
  return {
    ...actual,
    emitLifecycleInvalidation: (...args: unknown[]) => mockInvalidation(...args),
    runIdempotentLifecycleMutation: (...args: unknown[]) => mockIdempotent(...args),
  };
});

jest.mock('../pipeline', () => ({
  retryPipelineRunHandler: (...args: unknown[]) => mockRetry(...args),
}));

import lifecycleMutationsRouter from '../lifecycle-mutations';
import { errorHandler } from '../../lib/error-handler';
import { UnprocessableError } from '../../lib/errors';

const user: Express.UserShape = {
  id: 'local-admin',
  email: 'admin@rorca.local',
  supabaseId: 'local-auth',
  role: 'admin',
};

function app(authenticated = true) {
  const instance = express();
  instance.use(express.json());
  if (authenticated) {
    instance.use((req, _res, next) => {
      req.user = user;
      next();
    });
  }
  instance.use('/api/lifecycle', lifecycleMutationsRouter);
  instance.use(errorHandler);
  return instance;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockQueryOne.mockResolvedValue({ path: '/workspace' });
  mockCompile.mockResolvedValue({ status: 'compiled', specSlug: 'safe-spec' });
  mockBackfill.mockResolvedValue({ compiled: ['safe-spec'], skipped: [], failed: [], nextCursor: null, limit: 20 });
  mockInvalidation.mockResolvedValue(undefined);
  mockIdempotent.mockImplementation(async (input) => ({ value: await input.mutate(), replayed: false, responseStatus: 200 }));
  mockRetry.mockImplementation(async (_req, res) => {
    res.status(200).json({ ok: true });
  });
});

describe('governed lifecycle mutation adapters', () => {
  test('requires authentication and a durable idempotency key before recompilation', async () => {
    const unauthenticated = await request(app(false))
      .post('/api/lifecycle/specs/safe-spec/recompile')
      .set('Idempotency-Key', 'recompile-001')
      .send({ workspaceId: 'ws-a' });
    const missingKey = await request(app())
      .post('/api/lifecycle/specs/safe-spec/recompile')
      .send({ workspaceId: 'ws-a' });

    expect(unauthenticated.status).toBe(401);
    expect(missingKey.status).toBe(400);
    expect(mockCompile).not.toHaveBeenCalled();
  });

  test('recompiles one spec through the shared compiler and records bounded invalidation', async () => {
    const response = await request(app())
      .post('/api/lifecycle/specs/safe-spec/recompile')
      .set('Idempotency-Key', 'recompile-001')
      .send({ workspaceId: 'ws-a', expectedSaveGeneration: 4 });

    expect(response.status).toBe(200);
    expect(mockCompile).toHaveBeenCalledWith({
      workspaceId: 'ws-a',
      workspacePath: '/workspace',
      specSlug: 'safe-spec',
      expectedSaveGeneration: 4,
      source: 'lazy-compile',
    });
    expect(mockInvalidation).toHaveBeenCalledWith({ workspaceId: 'ws-a', specId: 'safe-spec', changeKind: 'plan_recompiled' });
  });

  test('returns an idempotent failed outcome when compilation records a typed blocker', async () => {
    mockCompile.mockRejectedValueOnce(new UnprocessableError('Canonical plan is stale', 'STALE_PLAN_GENERATION'));
    const response = await request(app())
      .post('/api/lifecycle/specs/safe-spec/recompile')
      .set('Idempotency-Key', 'recompile-failed-001')
      .send({ workspaceId: 'ws-a' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'failed',
      specSlug: 'safe-spec',
      code: 'STALE_PLAN_GENERATION',
      retryable: true,
    });
    expect(mockInvalidation).toHaveBeenCalledWith({
      workspaceId: 'ws-a',
      specId: 'safe-spec',
      changeKind: 'plan_compilation_failed',
    });
  });

  test('rejects unbounded workspace pages at the route schema', async () => {
    const response = await request(app())
      .post('/api/lifecycle/recompile')
      .set('Idempotency-Key', 'backfill-001')
      .send({ workspaceId: 'ws-a', limit: 21 });

    expect(response.status).toBe(400);
    expect(mockBackfill).not.toHaveBeenCalled();
  });

  test('preview delegates read-only safe policy inputs to the canonical retry service', async () => {
    mockQueryOne.mockResolvedValue({ id: 7 });
    await request(app())
      .post('/api/lifecycle/runs/7/retry-preview')
      .send({ workspaceId: 'ws-a', storyIds: ['LFC-014'] });

    const delegatedRequest = mockRetry.mock.calls[0][0];
    expect(delegatedRequest.body).toEqual({
      storyIds: ['LFC-014'],
      forceSequential: undefined,
      safeMode: true,
    });
  });

  test('dispatch requires the exact typed identity and idempotency key before delegation', async () => {
    mockQueryOne.mockResolvedValue({ id: 7 });
    const hash = `sha256:${'a'.repeat(64)}`;
    const withoutKey = await request(app())
      .post('/api/lifecycle/runs/7/retry-dispatch')
      .send({
        workspaceId: 'ws-a',
        previewHash: hash,
        approvedPreview: { previewHash: hash },
        previewIdentity: {
          schemaVersion: 'retry-preview-identity.v1',
          previewHash: hash,
          originalRunId: 7,
          expiresAt: '2026-07-15T12:10:00.000Z',
          signature: hash,
        },
      });

    expect(withoutKey.status).toBe(400);
    expect(mockRetry).not.toHaveBeenCalled();
  });
});
