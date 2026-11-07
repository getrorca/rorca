/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import express from 'express';
import type { Server } from 'http';
import request from 'supertest';

const mockRecord = jest.fn();
const mockRevoke = jest.fn();
const mockState = jest.fn();
const mockVerifyProviderHuman = jest.fn();
const mockQueryOne = jest.fn();

jest.mock('../../db/index', () => ({
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
}));

jest.mock('../../lib/ssdlc-decisions', () => {
  const actual = jest.requireActual('../../lib/ssdlc-decisions');
  return {
    ...actual,
    recordSsdlcDecision: (...args: unknown[]) => mockRecord(...args),
    revokeSsdlcDecision: (...args: unknown[]) => mockRevoke(...args),
    getSsdlcDecisionState: (...args: unknown[]) => mockState(...args),
  };
});

jest.mock('../../lib/provider-human-authority', () => {
  const actual = jest.requireActual('../../lib/provider-human-authority');
  return {
    ...actual,
    verifyAndPersistProviderHumanAuthority: (...args: unknown[]) => mockVerifyProviderHuman(...args),
  };
});

import lifecycleDecisionsRouter from '../lifecycle-decisions';
import { errorHandler } from '../../lib/error-handler';

let app: Server;

function buildApp() {
  const expressApp = express();
  expressApp.use(express.json());
  expressApp.use((req, _res, next) => {
    const id = req.header('x-fixture-user-id');
    if (id) {
      req.user = {
        id,
        email: req.header('x-fixture-user-email') ?? '',
        supabaseId: req.header('x-fixture-user-auth-id') ?? '',
        role: req.header('x-fixture-user-role') ?? 'user',
      } as Express.UserShape;
    }
    next();
  });
  expressApp.use('/api/lifecycle', lifecycleDecisionsRouter);
  expressApp.use(errorHandler);
  return expressApp;
}

function requestAs(user?: Express.UserShape, endpoint = '/api/lifecycle/decisions') {
  let pending = request(app).post(endpoint);
  if (user) {
    pending = pending
      .set('x-fixture-user-id', user.id)
      .set('x-fixture-user-email', user.email)
      .set('x-fixture-user-auth-id', user.supabaseId ?? '')
      .set('x-fixture-user-role', user.role ?? 'user');
  }
  return pending;
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: 'workspace-evaluator',
    specSlug: 'fixture-phase-evaluator',
    phaseId: 'development',
    decisionType: 'defer',
    rationale: 'Implementation is paused for a bounded dependency review.',
    expiresAt: '2026-07-20T12:00:00.000Z',
    ...overrides,
  };
}

beforeAll(async () => {
  app = await new Promise<Server>((resolve, reject) => {
    const listener = buildApp().listen(0, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });
});

afterAll(async () => {
  app.closeAllConnections();
  await new Promise<void>((resolve, reject) => app.close((error) => error ? reject(error) : resolve()));
});

beforeEach(() => {
  jest.clearAllMocks();
  mockRecord.mockResolvedValue({ decision: { id: '1' }, replayed: false });
  mockRevoke.mockResolvedValue({ decision: { id: '1', revokedAt: '2026-07-15T12:00:00.000Z' }, replayed: false });
  mockState.mockResolvedValue({ state: 'pending', effectiveDecisions: [], history: [] });
  mockVerifyProviderHuman.mockResolvedValue({
    receiptId: '11111111-1111-4111-8111-111111111111',
    replayed: false,
    actorId: 'human-9',
  });
  mockQueryOne.mockResolvedValue(null);
});

describe('lifecycle decision route authority boundary', () => {
  test('requires an authenticated server request identity', async () => {
    const response = await requestAs().send(body());
    expect(response.status).toBe(401);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test('requires a client idempotency key before calling the decision service', async () => {
    const response = await requestAs({
      id: 'local-admin',
      email: 'admin@rorca.local',
      supabaseId: 'local-auth',
      role: 'admin',
    }).send(body());

    expect(response.status).toBe(400);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test.each(['actor', 'principalId', 'principalType', 'authority', 'role', 'delegatedOnBehalfOf'])(
    'rejects request-body authority field %s',
    async (field) => {
      const response = await requestAs({
        id: 'local-admin',
        email: 'admin@rorca.local',
        supabaseId: 'local-auth',
        role: 'admin',
      }).send(body({ [field]: 'attacker-claim' }));
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('derived server-side');
      expect(mockRecord).not.toHaveBeenCalled();
    },
  );

  test('rejects the internal policy_approval type at the public decision boundary', async () => {
    const response = await requestAs({
      id: 'local-admin',
      email: 'admin@rorca.local',
      supabaseId: 'local-auth',
      role: 'admin',
    })
      .set('Idempotency-Key', 'decision-policy-forgery-1')
      .send(body({ decisionType: 'policy_approval' }));

    expect(response.status).toBe(400);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test('derives local-admin provenance and request id from server context/headers', async () => {
    const response = await requestAs({
      id: 'local-admin',
      email: 'admin@rorca.local',
      supabaseId: 'local-auth',
      role: 'admin',
    })
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

  test('denies Hermes mediation without a separately verified provider-human event', async () => {
    const response = await requestAs({
      id: 'rorca-hermes-service',
      email: 'hermes@rorca.internal',
      supabaseId: 'auth-hermes',
      role: 'admin',
    })
      .set('Idempotency-Key', 'decision-hermes-1')
      .send(body());

    expect(response.status).toBe(401);
    expect(mockVerifyProviderHuman).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test('resolves a canonical signed-command target without recording authority', async () => {
    const response = await requestAs({
      id: 'rorca-hermes-service', email: 'hermes@rorca.internal', supabaseId: 'auth-hermes', role: 'admin',
    }, '/api/lifecycle/decisions/target').send(body({
      phaseId: 'deployment', gateId: 'merge-gate', decisionType: 'deployment_approval',
      subject: { type: 'commit_sha', value: 'a'.repeat(40) },
    }));
    expect(response.status).toBe(200);
    expect(response.body.targetHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(response.body.command).toBe(`approve lifecycle decision ${response.body.targetHash}`);
    expect(response.body.responseIdentity).toEqual(expect.objectContaining({
      schemaVersion: 'rorca.lifecycle-decision-target-identity.v1',
      workspaceId: 'workspace-evaluator',
      specSlug: 'fixture-phase-evaluator',
      phaseId: 'deployment',
      gateId: 'merge-gate',
      decisionType: 'deployment_approval',
      targetHash: response.body.targetHash,
    }));
    expect(mockVerifyProviderHuman).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test('records only the verified provider-human principal for Hermes-relayed authority', async () => {
    const humanApproval = {
      schemaVersion: 'provider-human-event.v1',
      issuerId: 'slack-issuer',
      keyId: 'key-1',
      provider: 'slack',
      providerTenantId: 'team-1',
      actorId: 'human-9',
      conversationId: 'channel-1',
      threadId: 'thread-1',
      messageId: 'message-1',
      occurredAt: '2026-07-20T10:00:00.000Z',
      normalizedCommandHash: `sha256:${'0'.repeat(64)}`,
      ingressIdempotencyKey: 'ingress-human-9',
      signature: 'signed-provider-event-material-with-sufficient-length',
    };
    const response = await requestAs({
      id: 'rorca-hermes-service',
      email: 'hermes@rorca.internal',
      supabaseId: 'auth-hermes',
      role: 'admin',
    })
      .set('Idempotency-Key', 'decision-hermes-signed-1')
      .send(body({ humanApproval }));

    expect(response.status).toBe(201);
    expect(mockVerifyProviderHuman).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'workspace-evaluator',
      purpose: 'lifecycle_decision',
      targetHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      event: humanApproval,
    }));
    expect(response.body.responseIdentity).toEqual(expect.objectContaining({
      schemaVersion: 'rorca.lifecycle-decision-response-identity.v1',
      workspaceId: 'workspace-evaluator',
      specSlug: 'fixture-phase-evaluator',
      phaseId: 'development',
      decisionType: 'defer',
      sourceRequestId: 'decision-hermes-signed-1',
      actorId: 'human-9',
      providerHumanReceiptId: '11111111-1111-4111-8111-111111111111',
      decisionId: '1',
    }));
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({ sourceRequestId: 'decision-hermes-signed-1' }),
      expect.objectContaining({
        principalType: 'provider_human',
        principalId: 'human-9',
        sourceChannel: 'provider',
        providerHumanReceiptId: '11111111-1111-4111-8111-111111111111',
      }),
    );
  });

  test('does not resolve or record decisions for a foreign workspace', async () => {
    mockQueryOne.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('workspace_members') && params[0] === 'workspace-evaluator') return { role: 'member' };
      return null;
    });
    const member = {
      id: 'member-1',
      email: 'member@example.test',
      supabaseId: 'auth-member-1',
      role: 'user',
    } as Express.UserShape;

    const allowedTarget = await requestAs(member, '/api/lifecycle/decisions/target').send(body());
    const foreignDecision = await requestAs(member)
      .set('Idempotency-Key', 'foreign-decision-1')
      .send(body({ workspaceId: 'workspace-foreign' }));

    expect(allowedTarget.status).toBe(200);
    expect(foreignDecision.status).toBe(403);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test('requires administrator membership in the exact workspace before revocation', async () => {
    mockQueryOne.mockImplementation(async (sql: string, params: unknown[]) => {
      if (!sql.includes('workspace_members')) return null;
      return params[0] === 'workspace-evaluator' ? { role: 'admin' } : null;
    });
    const member = {
      id: 'workspace-admin',
      email: 'workspace-admin@example.test',
      supabaseId: 'auth-workspace-admin',
      role: 'user',
    } as Express.UserShape;
    const allowed = await requestAs(member, '/api/lifecycle/decisions/1/revoke')
      .set('Idempotency-Key', 'revoke-workspace-evaluator')
      .send({ workspaceId: 'workspace-evaluator', rationale: 'Superseded approval.' });
    const foreign = await requestAs(member, '/api/lifecycle/decisions/1/revoke')
      .set('Idempotency-Key', 'revoke-workspace-foreign')
      .send({ workspaceId: 'workspace-foreign', rationale: 'Superseded approval.' });

    expect(allowed.status).toBe(200);
    expect(foreign.status).toBe(403);
    expect(mockRevoke).toHaveBeenCalledTimes(1);
    expect(mockRevoke).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'workspace-evaluator' }), expect.anything());
  });

  test('does not disclose decision state from a foreign workspace', async () => {
    mockQueryOne.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('workspace_members') && params[0] === 'workspace-evaluator') return { role: 'member' };
      return null;
    });
    const headers = {
      'x-fixture-user-id': 'member-1',
      'x-fixture-user-email': 'member@example.test',
      'x-fixture-user-auth-id': 'auth-member-1',
      'x-fixture-user-role': 'user',
    };
    const allowed = await request(app)
      .get('/api/lifecycle/decisions/state?workspaceId=workspace-evaluator&specSlug=fixture-phase-evaluator&phaseId=implementation')
      .set(headers);
    const foreign = await request(app)
      .get('/api/lifecycle/decisions/state?workspaceId=workspace-foreign&specSlug=fixture-phase-evaluator&phaseId=implementation')
      .set(headers);

    expect(allowed.status).toBe(200);
    expect(foreign.status).toBe(403);
    expect(mockState).toHaveBeenCalledTimes(1);
    expect(mockState).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'workspace-evaluator' }));
  });
});
