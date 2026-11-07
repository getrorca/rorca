/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  LIFECYCLE_RECONCILIATION_WATERMARK_KEYS,
  lifecycleReconciliationIdentityMatches,
  type LifecycleReconciliationFreshnessIdentity,
  type LifecycleReconciliationWatermarks,
} from '../lifecycle-reconciliation-watermarks';

function hash(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}

const watermarks: LifecycleReconciliationWatermarks = {
  compiledPlan: hash('1'),
  evidence: hash('2'),
  decisions: hash('3'),
  runs: hash('4'),
  mutationState: hash('5'),
};
const current: LifecycleReconciliationFreshnessIdentity = {
  compiledPlanId: '41',
  watermarks,
};

function receipt(overrides: Partial<LifecycleReconciliationWatermarks> = {}) {
  return {
    compiledPlanId: '41',
    watermarks: { ...watermarks, ...overrides },
  };
}

describe('lifecycle reconciliation receipt freshness', () => {
  test('keeps an unchanged exact-plan receipt current', () => {
    expect(lifecycleReconciliationIdentityMatches(receipt(), current)).toBe(true);
  });

  test('makes a receipt stale when exact compiled-plan identity advances', () => {
    expect(lifecycleReconciliationIdentityMatches(receipt(), {
      ...current,
      compiledPlanId: '42',
    })).toBe(false);
  });

  test.each(LIFECYCLE_RECONCILIATION_WATERMARK_KEYS)(
    'makes a receipt stale when the %s high-water mark advances',
    (key) => {
      expect(lifecycleReconciliationIdentityMatches(receipt(), {
        ...current,
        watermarks: { ...watermarks, [key]: hash('a') },
      })).toBe(false);
    },
  );

  test('becomes current only after reapplication records every advanced identity', () => {
    const advanced: LifecycleReconciliationFreshnessIdentity = {
      compiledPlanId: '42',
      watermarks: {
        compiledPlan: hash('a'),
        evidence: hash('b'),
        decisions: hash('c'),
        runs: hash('d'),
        mutationState: hash('e'),
      },
    };
    expect(lifecycleReconciliationIdentityMatches(receipt(), advanced)).toBe(false);
    expect(lifecycleReconciliationIdentityMatches({
      compiledPlanId: advanced.compiledPlanId,
      watermarks: advanced.watermarks,
    }, advanced)).toBe(true);
  });

  test('fails closed for missing or malformed persisted watermark sets', () => {
    expect(lifecycleReconciliationIdentityMatches({
      compiledPlanId: current.compiledPlanId,
      watermarks: { ...watermarks, runs: undefined },
    }, current)).toBe(false);
    expect(lifecycleReconciliationIdentityMatches({
      compiledPlanId: current.compiledPlanId,
      watermarks: { ...watermarks, extra: hash('f') },
    }, current)).toBe(false);
    expect(lifecycleReconciliationIdentityMatches(receipt(), null)).toBe(false);
  });
});
