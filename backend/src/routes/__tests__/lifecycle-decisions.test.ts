/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import express from 'express';
import request from 'supertest';

const mockRecord = jest.fn();
const mockRevoke = jest.fn();
const mockState = jest.fn();

jest.mock('../../lib/ssdlc-decisions', () => {
  const actual = jest.requireActual('../../lib/ssdlc-decisions');
  return {
    ...actual,
    recordSsdlcDecision: (...args: unknown[]) => mockRecord(...args),
    revokeSsdlcDecision: (...args: unknown[]) => mockRevoke(...args),
    getSsdlcDecisionState: (...args: unknown[]) => mockState(...args),
  };
});

import lifecycleDecisionsRouter from '../lifecycle-decisions';
import { errorHandler } from '../../lib/error-handler';

function appWithUser(user?: Express.UserShape) {
  const app = express();
  app.use(express.json());
  if (user) {
    app.use((req, _res, next) => {
      req.user = user;
      next();
    });
  }
  app.use('/api/lifecycle', lifecycleDecisionsRouter);
  app.use(errorHandler);
  return app;
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: 'workspace-evaluator',
    specSlug: 'fixture-phase-evaluator',
    phaseId: 'implementation',
    decisionType: 'defer',
    rationale: 'Implementation is paused for a bounded dependency review.',
    expiresAt: '2026-07-20T12:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRecord.mockResolvedValue({ decision: { id: '1' }, replayed: false });
  mockRevoke.mockResolvedValue({ decision: { id: '1', revokedAt: '2026-07-15T12:00:00.000Z' }, replayed: false });
  mockState.mockResolvedValue({ state: 'pending', effectiveDecisions: [], history: [] });
});

describe('lifecycle decision route authority boundary', () => {
  test('requires an authenticated server request identity', async () => {
    const response = await request(appWithUser()).post('/api/lifecycle/decisions').send(body());
    expect(response.status).toBe(401);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test('requires a client idempotency key before calling the decision service', async () => {
    const response = await request(appWithUser({
      id: 'local-admin',
      email: 'admin@rorca.local',
      supabaseId: 'local-auth',
      role: 'admin',
    })).post('/api/lifecycle/decisions').send(body());

    expect(response.status).toBe(400);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test.each(['actor', 'principalId', 'principalType', 'authority', 'role'])(
    'rejects request-body authority field %s',
    async (field) => {
      const response = await request(appWithUser({
        id: 'local-admin',
        email: 'admin@rorca.local',
        supabaseId: 'local-auth',
        role: 'admin',
      })).post('/api/lifecycle/decisions').send(body({ [field]: 'attacker-claim' }));
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('derived server-side');
      expect(mockRecord).not.toHaveBeenCalled();
    },
  );

  test('derives local-admin provenance and request id from server context/headers', async () => {
    const response = await request(appWithUser({
      id: 'local-admin',
      email: 'admin@rorca.local',
      supabaseId: 'local-auth',
      role: 'admin',
    }))
      .post('/api/lifecycle/decisions')
      .set('Idempotency-Key', 'decision-request-77')
      .send(body());

    expect(response.status).toBe(201);
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({ sourceRequestId: 'decision-request-77' }),
      expect.objectContaining({
        principalType: 'local_admin',
        principalId: 'local-admin',
        displayLabel: 'admin@rorca.local',
        sourceChannel: 'local',
      }),
    );
  });

  test('records delegated human identity only for authenticated Hermes mediation', async () => {
    await request(appWithUser({
      id: 'hermes-service',
      email: 'hermes@rorca.internal',
      supabaseId: 'auth-hermes',
      role: 'admin',
    })).post('/api/lifecycle/decisions')
      .set('Idempotency-Key', 'decision-hermes-1')
      .send(body({
        delegatedOnBehalfOf: { principalId: 'human-9', displayLabel: 'Release Approver' },
      }));

    expect(mockRecord.mock.calls[0][1]).toMatchObject({
      principalType: 'hermes',
      principalId: 'hermes-service',
      sourceChannel: 'hermes',
      delegatedOnBehalfOf: { principalId: 'human-9', displayLabel: 'Release Approver' },
    });

    const rejected = await request(appWithUser({
      id: 'user-1',
      email: 'user@example.test',
      supabaseId: 'auth-user-1',
      role: 'admin',
    })).post('/api/lifecycle/decisions')
      .set('Idempotency-Key', 'decision-user-1')
      .send(body({
        delegatedOnBehalfOf: { principalId: 'claimed-human', displayLabel: 'Claimed Human' },
      }));
    expect(rejected.status).toBe(400);
  });
});
