/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { DENIED_EFFECT_ACTIONS, decideEffect, type EffectAdmission, type EffectRequest } from '../bounty-effect-policy';

const request: EffectRequest = { workspaceId: 'w', missionId: 'm', workPackageId: 'p', target: 'https://example.test', action: 'target.observe', credentialRole: 'scanner', costCents: 5, concurrency: 1, repeatable: true, expiresAt: '2099-01-01T00:00:00.000Z', input: { method: 'GET' } };
const admission: EffectAdmission = { missionState: 'active', targets: [request.target], actions: [request.action], credentialRoles: [request.credentialRole], remainingCents: 5, availableConcurrency: 1, lifecycleStates: ['prepared'] };

describe('pure bounty effect policy', () => {
  test('allows only an exact, current, budgeted request and hashes normalization deterministically', () => {
    const first = decideEffect(request, admission, 0);
    const second = decideEffect({ ...request, input: { method: 'GET' } }, admission, 0);
    expect(first).toMatchObject({ allowed: true, code: 'ALLOW' });
    expect(first.requestHash).toBe(second.requestHash);
  });

  test.each(DENIED_EFFECT_ACTIONS)('default-denies destructive action %s even if admitted', (action) => {
    expect(decideEffect({ ...request, action }, { ...admission, actions: [action] }, 0).code).toBe('ACTION_DENIED');
  });

  test.each([
    [{ ...admission, missionState: 'held' as const }, 'MISSION_INACTIVE'],
    [{ ...admission, targets: [] }, 'SCOPE_DENIED'],
    [{ ...admission, credentialRoles: [] }, 'ROLE_DENIED'],
    [{ ...admission, remainingCents: 4 }, 'BUDGET_DENIED'],
    [{ ...admission, lifecycleStates: [] }, 'LIFECYCLE_DENIED'],
  ])('fails closed when an authority dimension is absent', (candidate, code) => {
    expect(decideEffect(request, candidate as EffectAdmission, 0).code).toBe(code);
  });
});
