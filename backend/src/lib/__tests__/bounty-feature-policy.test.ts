/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  BOUNTY_FEATURE_DISABLED_REASON_CODE,
  BountyFeatureDisabledError,
  issueBountyMissionContext,
  isBountyMissionContext,
  parseBountyDeploymentPolicy,
  persistBountyAdminPolicy,
  resolveBountyFeaturePolicy,
} from '../bounty-feature-policy';
import { registerBountyEffectWorkers } from '../bounty-worker-boundary';

const enabledPolicy = {
  state: 'enabled' as const,
  enabled: true,
  missionMode: 'bounty' as const,
  revision: 7,
  auditIdentity: 'deployment:security-operator',
  authoritySource: 'deployment_policy' as const,
  updatedAt: null,
};

describe('operator-owned bounty feature boundary', () => {
  test('absence defaults to disabled without consulting repository config', async () => {
    const loadPersisted = jest.fn().mockResolvedValue(undefined);

    const policy = await resolveBountyFeaturePolicy({ deploymentPolicy: '', loadPersisted });

    expect(policy).toMatchObject({
      state: 'disabled',
      enabled: false,
      missionMode: 'bounty',
      revision: 0,
      authoritySource: 'system_default',
    });
    expect(loadPersisted).toHaveBeenCalledTimes(1);
  });

  test('strict deployment policy requires revision and audit identity and rejects unknown fields', () => {
    expect(() => parseBountyDeploymentPolicy(JSON.stringify({
      state: 'enabled',
      missionMode: 'bounty',
      revision: 1,
      auditIdentity: 'deployment:operator-1',
      enabledBySpec: true,
    }))).toThrow(/invalid/i);

    expect(() => parseBountyDeploymentPolicy(JSON.stringify({
      state: 'enabled',
      missionMode: 'bounty',
      revision: 1,
    }))).toThrow(/invalid/i);
  });

  test('deployment policy may force disable but can never enable without promotion', async () => {
    const loadPersisted = jest.fn();
    expect(() => parseBountyDeploymentPolicy(JSON.stringify({
      state: 'enabled', missionMode: 'bounty', revision: 3, auditIdentity: 'deployment:change-42',
    }))).toThrow(/invalid/i);
    const policy = await resolveBountyFeaturePolicy({
      deploymentPolicy: JSON.stringify({ state: 'disabled', missionMode: 'bounty', revision: 3, auditIdentity: 'deployment:rollback' }),
      loadPersisted,
    });
    expect(policy).toMatchObject({ enabled: false, revision: 3, authoritySource: 'deployment_policy' });
    expect(loadPersisted).not.toHaveBeenCalled();
  });

  test('the persistence service itself rejects non-bearer and non-admin authority', async () => {
    const mutation = { state: 'enabled' as const, missionMode: 'bounty' as const, revision: 1 };

    await expect(persistBountyAdminPolicy(mutation, {
      id: 'hermes', email: 'hermes@rorca.internal', role: 'admin', authSource: 'internal',
    })).rejects.toMatchObject({ code: 'AUTH_ERROR' });
    await expect(persistBountyAdminPolicy(mutation, {
      id: 'user-1', email: 'user@example.test', role: 'user', authSource: 'bearer',
    })).rejects.toMatchObject({ code: 'ADMIN_REQUIRED' });
  });

  test('plain JSON cannot forge the runtime mission discriminator', () => {
    const plainValues = [
      { missionMode: 'bounty', missionId: 'from-spec', policyRevision: 7 },
      JSON.parse(JSON.stringify({ missionMode: 'bounty', missionId: 'from-hermes' })),
      { policy: { missionMode: 'bounty' }, source: 'schedule' },
    ];

    for (const value of plainValues) expect(isBountyMissionContext(value)).toBe(false);

    const issued = issueBountyMissionContext(enabledPolicy, 'mission-1');
    expect(isBountyMissionContext(issued)).toBe(true);
    expect(isBountyMissionContext(JSON.parse(JSON.stringify(issued)))).toBe(false);
  });

  test('disabled mission issuance and worker registration share a stable reason code', async () => {
    const disabled = {
      ...enabledPolicy,
      state: 'disabled' as const,
      enabled: false,
    };
    const registrar = jest.fn();

    expect(() => issueBountyMissionContext(disabled, 'mission-1')).toThrow(BountyFeatureDisabledError);
    try {
      issueBountyMissionContext(disabled, 'mission-1');
    } catch (error) {
      expect((error as BountyFeatureDisabledError).code).toBe(BOUNTY_FEATURE_DISABLED_REASON_CODE);
    }

    const registration = await registerBountyEffectWorkers({
      resolvePolicy: async () => disabled,
      registrars: [registrar],
    });
    expect(registration).toEqual({ registered: false, reasonCode: BOUNTY_FEATURE_DISABLED_REASON_CODE });
    expect(registrar).not.toHaveBeenCalled();
  });

  test('enabled worker boundary passes only the resolved operator policy to registrars', async () => {
    const registrar = jest.fn().mockResolvedValue(undefined);
    const result = await registerBountyEffectWorkers({
      resolvePolicy: async () => enabledPolicy,
      registrars: [registrar],
    });

    expect(result).toEqual({ registered: true, reasonCode: null });
    expect(registrar).toHaveBeenCalledWith(enabledPolicy);
  });
});
