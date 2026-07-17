/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, expect, it } from 'vitest';
import {
  LIFECYCLE_DARK_VISUAL_FIXTURES,
  LIFECYCLE_DARK_VISUAL_SCENARIOS,
  LIFECYCLE_VISUAL_FIXTURES,
  LIFECYCLE_VISUAL_QA_REJECTIONS,
  LIFECYCLE_VISUAL_SCENARIOS,
  LIFECYCLE_VISUAL_SOURCES,
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
      expect(captures.every((fixture) => fixture.screenshot.endsWith('-light-chromium.png'))).toBe(true);
      expect(scenario.expected.length).toBeGreaterThan(20);
    }
  });

  it('defines representative dark parity for every mandatory visual state', () => {
    expect(LIFECYCLE_DARK_VISUAL_SCENARIOS).toEqual([
      'default-portfolio',
      'blocked-validation-drawer',
      'retry-preview',
      'empty-portfolio',
      'loading-portfolio',
      'recoverable-error',
      'stale-revision',
    ]);
    expect(LIFECYCLE_DARK_VISUAL_FIXTURES).toHaveLength(LIFECYCLE_DARK_VISUAL_SCENARIOS.length);
    expect(LIFECYCLE_DARK_VISUAL_FIXTURES.every((fixture) => (
      fixture.theme === 'dark'
      && fixture.viewport.id === 'desktop'
      && fixture.reducedMotion
      && fixture.screenshot.endsWith('-dark-chromium.png')
    ))).toBe(true);
  });

  it('pins wireframe comparison sources and the visual rejection checklist', () => {
    expect(LIFECYCLE_VISUAL_SOURCES).toEqual([
      'docs/diagrams/rorca-ssdlc-lifecycle-board-wireframe.excalidraw',
      'docs/diagrams/rorca-ssdlc-lifecycle-board-wireframe.png',
    ]);
    expect(LIFECYCLE_VISUAL_QA_REJECTIONS).toEqual([
      'placeholder copy',
      'uneven spacing',
      'clipped labels',
      'layout shift',
      'nested-card clutter',
      'heavy shadows',
      'uncontrolled gradients',
      'low-contrast status tints',
      'ambiguous primary actions',
    ]);
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
