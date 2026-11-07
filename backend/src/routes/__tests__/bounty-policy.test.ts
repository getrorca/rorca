/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import express from 'express';
import request from 'supertest';
import { errorHandler } from '../../lib/error-handler';
import { requireBountyEffectsEnabled } from '../../lib/bounty-effect-boundary';
import { BOUNTY_FEATURE_DISABLED_REASON_CODE } from '../../lib/bounty-feature-policy';

jest.mock('../../lib/bounty-feature-policy', () => {
  const actual = jest.requireActual('../../lib/bounty-feature-policy');
  return {
    ...actual,
    resolveBountyFeaturePolicy: jest.fn(),
    persistBountyAdminPolicy: jest.fn(),
  };
});

import bountyPolicyRouter from '../bounty-policy';
import {
  persistBountyAdminPolicy,
  resolveBountyFeaturePolicy,
} from '../../lib/bounty-feature-policy';

const mockedResolve = resolveBountyFeaturePolicy as jest.MockedFunction<typeof resolveBountyFeaturePolicy>;
const mockedPersist = persistBountyAdminPolicy as jest.MockedFunction<typeof persistBountyAdminPolicy>;

function buildApp(options: { role?: string; authSource?: 'bearer' | 'internal' | 'local-fallback' }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      id: 'operator-1',
      email: 'operator@example.test',
      supabaseId: '11111111-1111-4111-8111-111111111111',
      role: options.role,
    };
    req.authSource = options.authSource;
    next();
  });
  app.use('/api/admin/bounty', bountyPolicyRouter);
  app.use(errorHandler);
  return app;
}

describe('bounty effect route boundary', () => {
  test('disabled policy returns the stable reason code and never invokes the effect', async () => {
    const app = express();
    const effect = jest.fn((_req, res) => res.status(202).json({ accepted: true }));
    app.post('/api/bounty/effects', requireBountyEffectsEnabled(async () => ({
      state: 'disabled', enabled: false, missionMode: 'bounty', revision: 0,
      auditIdentity: 'system:default-disabled', authoritySource: 'system_default', updatedAt: null,
    })), effect);
    app.use(errorHandler);

    const response = await request(app).post('/api/bounty/effects');

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      code: BOUNTY_FEATURE_DISABLED_REASON_CODE,
      details: { reasonCode: BOUNTY_FEATURE_DISABLED_REASON_CODE },
    });
    expect(effect).not.toHaveBeenCalled();
  });
});

describe('admin bounty policy route boundary', () => {
  beforeEach(() => jest.resetAllMocks());

  test('reads a non-enabling qualification posture for an admin', async () => {
    const response = await request(buildApp({ role: 'admin', authSource: 'local-fallback' }))
      .get('/api/admin/bounty/qualification');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      state: 'requalification-required',
      featureState: 'disabled',
      releaseEnableAvailable: false,
      qualificationMode: 'hermetic',
      requiredSuiteCount: 14,
      fixturePassedSuiteCount: 14,
      requiredControlProofCount: 7,
    });
  });

  test('does not expose qualification posture to a non-admin', async () => {
    const response = await request(buildApp({ role: 'user', authSource: 'bearer' }))
      .get('/api/admin/bounty/qualification');

    expect(response.status).toBe(403);
  });

  test('reads the disabled default for an admin', async () => {
    mockedResolve.mockResolvedValueOnce({
      state: 'disabled', enabled: false, missionMode: 'bounty', revision: 0,
      auditIdentity: 'system:default-disabled', authoritySource: 'system_default', updatedAt: null,
    });

    const response = await request(buildApp({ role: 'admin', authSource: 'local-fallback' }))
      .get('/api/admin/bounty/policy');

    expect(response.status).toBe(200);
    expect(response.body.enabled).toBe(false);
  });

  test.each(['local-fallback', 'internal'] as const)(
    'rejects %s authority before a policy mutation',
    async (authSource) => {
      const response = await request(buildApp({ role: 'admin', authSource }))
        .put('/api/admin/bounty/policy')
        .send({ state: 'enabled', missionMode: 'bounty', revision: 1, promotionReceiptId: '11111111-1111-4111-8111-111111111111' });

      expect(response.status).toBe(401);
      expect(response.body.code).toBe('AUTH_ERROR');
      expect(mockedPersist).not.toHaveBeenCalled();
    },
  );

  test('rejects a credential-authenticated non-admin', async () => {
    const response = await request(buildApp({ role: 'user', authSource: 'bearer' }))
      .put('/api/admin/bounty/policy')
      .send({ state: 'enabled', missionMode: 'bounty', revision: 1, promotionReceiptId: '11111111-1111-4111-8111-111111111111' });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('ADMIN_REQUIRED');
    expect(mockedPersist).not.toHaveBeenCalled();
  });

  test('rejects unknown mutation fields before persistence', async () => {
    const response = await request(buildApp({ role: 'admin', authSource: 'bearer' }))
      .put('/api/admin/bounty/policy')
      .send({ state: 'enabled', missionMode: 'bounty', revision: 1, promotionReceiptId: '11111111-1111-4111-8111-111111111111', fromSpec: true });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(mockedPersist).not.toHaveBeenCalled();
  });

  test('passes only credential-authenticated admin identity to the audited service', async () => {
    mockedPersist.mockResolvedValueOnce({
      state: 'enabled', enabled: true, missionMode: 'bounty', revision: 1,
      auditIdentity: 'operator-1:operator@example.test', authoritySource: 'admin_mutation',
      updatedAt: '2026-07-30T12:00:00.000Z',
    });

    const response = await request(buildApp({ role: 'admin', authSource: 'bearer' }))
      .put('/api/admin/bounty/policy')
      .send({ state: 'enabled', missionMode: 'bounty', revision: 1, promotionReceiptId: '11111111-1111-4111-8111-111111111111' });

    expect(response.status).toBe(200);
    expect(mockedPersist).toHaveBeenCalledWith(
      { state: 'enabled', missionMode: 'bounty', revision: 1, promotionReceiptId: '11111111-1111-4111-8111-111111111111' },
      {
        id: 'operator-1',
        email: 'operator@example.test',
        role: 'admin',
        authSource: 'bearer',
      },
    );
  });
});
