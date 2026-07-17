/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  AUTONOMOUS_DELIVERY_POLICY_SCHEMA_VERSION,
  normalizeAutonomousDeliveryPolicy,
} from '../autonomous-delivery-policy';

const now = new Date('2026-07-16T12:00:00.000Z');

function draft(overrides: Record<string, unknown> = {}) {
  return {
    baseBranch: 'main',
    allowedRiskLevels: ['medium', 'low'],
    requiredChecks: ['Backend Tests', 'Frontend Tests'],
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

describe('standing autonomous delivery policy contract', () => {
  test('normalizes an operator policy deterministically and never grants deployment authority', () => {
    const first = normalizeAutonomousDeliveryPolicy(
      { owner: 'getrorca', name: 'rorca' },
      draft() as any,
      now,
    );
    const second = normalizeAutonomousDeliveryPolicy(
      { owner: 'getrorca', name: 'rorca' },
      draft({
        allowedRiskLevels: ['low', 'medium'],
        requiredChecks: ['Backend Tests', 'Frontend Tests'],
      }) as any,
      now,
    );

    expect(first).toMatchObject({
      schemaVersion: AUTONOMOUS_DELIVERY_POLICY_SCHEMA_VERSION,
      repository: { owner: 'getrorca', name: 'rorca' },
      baseBranch: 'main',
      allowedRiskLevels: ['low', 'medium'],
      deploymentAllowed: false,
      policyDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    expect(first.policyDigest).toBe(second.policyDigest);
  });

  test.each(['high', 'critical'])('hard-denies %s risk from standing autonomy', (risk) => {
    expect(() => normalizeAutonomousDeliveryPolicy(
      { owner: 'getrorca', name: 'rorca' },
      draft({ allowedRiskLevels: ['low', risk] }) as any,
      now,
    )).toThrow('Autonomous delivery policy is invalid');
  });

  test('requires at least one current-SHA review and explicit required checks', () => {
    expect(() => normalizeAutonomousDeliveryPolicy(
      { owner: 'getrorca', name: 'rorca' },
      draft({ reviewRules: { ...draft().reviewRules, minimumApprovals: 0 } }) as any,
      now,
    )).toThrow('Autonomous delivery policy is invalid');

    expect(() => normalizeAutonomousDeliveryPolicy(
      { owner: 'getrorca', name: 'rorca' },
      draft({ requiredChecks: [] }) as any,
      now,
    )).toThrow('Autonomous delivery policy is invalid');
  });

  test('rejects duplicate checks/reviewers, unsafe refs, expired policies, and excess lifetime', () => {
    expect(() => normalizeAutonomousDeliveryPolicy(
      { owner: 'getrorca', name: 'rorca' },
      draft({ requiredChecks: ['Backend Tests', 'Backend Tests'] }) as any,
      now,
    )).toThrow('requiredChecks must not contain duplicates');
    expect(() => normalizeAutonomousDeliveryPolicy(
      { owner: 'getrorca', name: 'rorca' },
      draft({ reviewRules: { ...draft().reviewRules, requiredReviewers: ['Owner', 'owner'] } }) as any,
      now,
    )).toThrow('reviewRules.requiredReviewers must not contain duplicates');
    expect(() => normalizeAutonomousDeliveryPolicy(
      { owner: 'getrorca', name: 'rorca' },
      draft({ baseBranch: '../main' }) as any,
      now,
    )).toThrow('Autonomous delivery policy is invalid');
    expect(() => normalizeAutonomousDeliveryPolicy(
      { owner: 'getrorca', name: 'rorca' },
      draft({ expiresAt: '2026-07-16T11:59:59.000Z' }) as any,
      now,
    )).toThrow('expiresAt must be in the future');
    expect(() => normalizeAutonomousDeliveryPolicy(
      { owner: 'getrorca', name: 'rorca' },
      draft({ expiresAt: '2027-07-16T12:00:00.000Z' }) as any,
      now,
    )).toThrow('expiresAt cannot exceed 90 days');
  });

  test('rejects deployment and unknown authority fields instead of ignoring them', () => {
    expect(() => normalizeAutonomousDeliveryPolicy(
      { owner: 'getrorca', name: 'rorca' },
      draft({ deploymentAllowed: true }) as any,
      now,
    )).toThrow('Autonomous delivery policy is invalid');
  });
});
