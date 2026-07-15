/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, expect, it } from 'vitest';
import {
  LIFECYCLE_VISUAL_FIXTURES,
  LIFECYCLE_VISUAL_SCENARIOS,
  LIFECYCLE_VISUAL_VIEWPORTS,
} from '../lifecycleVisualRegression';

describe('Lifecycle visual regression capture contract', () => {
  it('covers every required state at all three target viewports', () => {
    expect(LIFECYCLE_VISUAL_VIEWPORTS).toEqual([
      { id: 'desktop', width: 1440, height: 900 },
      { id: 'tablet', width: 1024, height: 768 },
      { id: 'mobile', width: 390, height: 844 },
    ]);
    expect(LIFECYCLE_VISUAL_FIXTURES).toHaveLength(
      LIFECYCLE_VISUAL_SCENARIOS.length * LIFECYCLE_VISUAL_VIEWPORTS.length,
    );

    for (const scenario of LIFECYCLE_VISUAL_SCENARIOS) {
      const captures = LIFECYCLE_VISUAL_FIXTURES.filter((fixture) => fixture.scenario === scenario.id);
      expect(captures.map((fixture) => fixture.viewport.id)).toEqual(['desktop', 'tablet', 'mobile']);
      expect(captures.every((fixture) => fixture.theme === 'light' && fixture.reducedMotion)).toBe(true);
      expect(scenario.expected.length).toBeGreaterThan(20);
    }
  });

  it('keeps operational states and governed task surfaces in the stable scenario set', () => {
    expect(LIFECYCLE_VISUAL_SCENARIOS.map((scenario) => scenario.id)).toEqual(expect.arrayContaining([
      'default-portfolio',
      'blocked-validation-drawer',
      'stale-revision',
      'awaiting-approval',
      'retry-preview',
      'evidence-inspector',
      'empty-portfolio',
      'loading-portfolio',
      'adapter-unavailable',
      'recoverable-error',
      'learn-candidate',
    ]));
  });
});
