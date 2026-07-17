/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import express from 'express';
import request from 'supertest';

const mockCreatePolicy = jest.fn();
const mockActivatePolicy = jest.fn();
const mockRevokePolicy = jest.fn();
const mockListPolicies = jest.fn();
const mockObserveEvidence = jest.fn();
const mockListEvidence = jest.fn();

jest.mock('../../lib/autonomous-delivery-policy', () => ({
  ...jest.requireActual('../../lib/autonomous-delivery-policy'),
  createAutonomousDeliveryPolicy: (...args: unknown[]) => mockCreatePolicy(...args),
  activateAutonomousDeliveryPolicy: (...args: unknown[]) => mockActivatePolicy(...args),
  revokeAutonomousDeliveryPolicy: (...args: unknown[]) => mockRevokePolicy(...args),
  listAutonomousDeliveryPolicies: (...args: unknown[]) => mockListPolicies(...args),
}));

jest.mock('../../lib/github-pr-delivery-evidence', () => ({
  observeGithubPrDeliveryEvidence: (...args: unknown[]) => mockObserveEvidence(...args),
  listGithubPrDeliveryEvidence: (...args: unknown[]) => mockListEvidence(...args),
}));

import deliveryGovernanceRouter from '../delivery-governance';
import { errorHandler } from '../../lib/error-handler';

const admin: Express.UserShape = {
  id: 'operator-1',
  email: 'operator@example.test',
  supabaseId: 'operator-auth-1',
  role: 'admin',
};

function app(user?: Express.UserShape) {
  const instance = express();
  instance.use(express.json());
  if (user) instance.use((req, _res, next) => { req.user = user; next(); });
  instance.use('/api/workspaces', deliveryGovernanceRouter);
  instance.use(errorHandler);
  return instance;
}

function policyDraft(overrides: Record<string, unknown> = {}) {
  return {
    baseBranch: 'main',
    allowedRiskLevels: ['low'],
    requiredChecks: ['Backend Tests'],
    reviewRules: {
      minimumApprovals: 1,
      requireCodeOwnerReview: false,
      dismissStaleApprovals: true,
      requiredReviewers: ['release-owner'],
    },
    mergeMethod: 'squash',
    retryBudget: { maxAttempts: 2, maxElapsedMinutes: 90 },
    expiresAt: '2026-08-01T12:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCreatePolicy.mockResolvedValue({ policy: { id: 'policy-1', status: 'disabled', deploymentAllowed: false }, replayed: false });
  mockActivatePolicy.mockResolvedValue({ policy: { id: 'policy-1', status: 'active' }, replayed: false });
  mockRevokePolicy.mockResolvedValue({ policy: { id: 'policy-1', status: 'revoked' }, replayed: false });
  mockListPolicies.mockResolvedValue({ active: null, policies: [] });
  mockObserveEvidence.mockResolvedValue({ evidence: { id: 'evidence-1', pullRequest: { headSha: 'a'.repeat(40) } }, replayed: false });
  mockListEvidence.mockResolvedValue({ items: [] });
});

describe('autonomous delivery governance routes', () => {
  test('requires authenticated workspace authority', async () => {
    const response = await request(app()).get('/api/workspaces/ws-1/github/delivery-policies');
    expect(response.status).toBe(401);
    expect(mockListPolicies).not.toHaveBeenCalled();
  });

  test('creates only a disabled policy and derives the operator principal server-side', async () => {
    const response = await request(app(admin))
      .post('/api/workspaces/ws-1/github/delivery-policies')
      .set('Idempotency-Key', 'policy-create-001')
      .send(policyDraft());

    expect(response.status).toBe(201);
    expect(response.body.policy).toMatchObject({ status: 'disabled', deploymentAllowed: false });
    expect(mockCreatePolicy).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-1',
      sourceRequestId: 'policy-create-001',
      principal: { principalId: 'operator-1', displayLabel: 'operator@example.test' },
    }));
  });

  test.each(['actor', 'principalId', 'authority', 'deploymentAllowed', 'deploy'])(
    'rejects request-body authority field %s',
    async (field) => {
      const response = await request(app(admin))
        .post('/api/workspaces/ws-1/github/delivery-policies')
        .set('Idempotency-Key', `policy-${field}-001`)
        .send(policyDraft({ [field]: field === 'deploymentAllowed' || field === 'deploy' ? true : 'claimed' }));
      expect(response.status).toBe(400);
      expect(mockCreatePolicy).not.toHaveBeenCalled();
    },
  );

  test('requires an explicit exact-digest activation confirmation', async () => {
    const missing = await request(app(admin))
      .post('/api/workspaces/ws-1/github/delivery-policies/policy-1/activate')
      .set('Idempotency-Key', 'policy-activate-001')
      .send({ expectedPolicyDigest: `sha256:${'a'.repeat(64)}` });
    expect(missing.status).toBe(400);
    expect(mockActivatePolicy).not.toHaveBeenCalled();

    const accepted = await request(app(admin))
      .post('/api/workspaces/ws-1/github/delivery-policies/policy-1/activate')
      .set('Idempotency-Key', 'policy-activate-001')
      .send({
        expectedPolicyDigest: `sha256:${'a'.repeat(64)}`,
        confirmation: 'ENABLE_AUTONOMOUS_PR_DELIVERY',
      });
    expect(accepted.status).toBe(200);
    expect(mockActivatePolicy).toHaveBeenCalledWith(expect.objectContaining({
      policyId: 'policy-1',
      expectedPolicyDigest: `sha256:${'a'.repeat(64)}`,
      confirmation: 'ENABLE_AUTONOMOUS_PR_DELIVERY',
    }));
  });

  test('revokes through a one-way idempotent operator action', async () => {
    const response = await request(app(admin))
      .post('/api/workspaces/ws-1/github/delivery-policies/policy-1/revoke')
      .set('Idempotency-Key', 'policy-revoke-001')
      .send({ reason: 'Operator disabled autonomous delivery after review.' });
    expect(response.status).toBe(200);
    expect(mockRevokePolicy).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-1', policyId: 'policy-1', sourceRequestId: 'policy-revoke-001',
    }));
  });

  test('observes provider evidence only for a canonical run and caller-pinned full SHA', async () => {
    const response = await request(app(admin))
      .post('/api/workspaces/ws-1/github/delivery-evidence')
      .send({ runId: 20260316000001, expectedHeadSha: 'a'.repeat(40) });
    expect(response.status).toBe(201);
    expect(mockObserveEvidence).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      runId: 20260316000001,
      expectedHeadSha: 'a'.repeat(40),
      principal: { principalId: 'operator-1', displayLabel: 'operator@example.test' },
    });
  });
});
