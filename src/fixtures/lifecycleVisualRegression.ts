/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Stable capture contract consumed by Lifecycle screenshot harnesses and human QA.
 * Layout comparison sources (behavior remains governed by canonical contracts):
 * - docs/diagrams/rorca-ssdlc-lifecycle-board-wireframe.excalidraw
 * - docs/diagrams/rorca-ssdlc-lifecycle-board-wireframe.png
 */
export const LIFECYCLE_VISUAL_SOURCES = [
  'docs/diagrams/rorca-ssdlc-lifecycle-board-wireframe.excalidraw',
  'docs/diagrams/rorca-ssdlc-lifecycle-board-wireframe.png',
] as const;

export const LIFECYCLE_VISUAL_VIEWPORTS = [
  { id: 'desktop', width: 1440, height: 900 },
  { id: 'tablet', width: 1024, height: 768 },
  { id: 'mobile', width: 390, height: 844 },
] as const;

export const LIFECYCLE_VISUAL_SCENARIOS = [
  { id: 'default-portfolio', selection: null, expected: 'Portfolio KPIs, controls, complete phase matrix, and legend' },
  { id: 'blocked-validation-drawer', selection: 'billing-anomaly-alerts:validation', expected: 'Blocked status, 2 of 4 gates, blocker, next safe action, and permitted actions' },
  { id: 'stale-revision', selection: 'billing-anomaly-alerts:security', expected: 'Non-blocking revision warning and preserved prior metrics' },
  { id: 'awaiting-approval', selection: 'billing-anomaly-alerts:architecture', expected: 'Awaiting approval label, consequence, and request approval path' },
  { id: 'retry-preview', selection: 'billing-anomaly-alerts:validation', expected: 'Exact smallest retry scope, policy, confirmation, cancel, and queue action' },
  { id: 'evidence-inspector', selection: 'billing-anomaly-alerts:validation', expected: 'Authoritative source, revision eligibility, timestamp, reference, and bounded payload disclosure' },
  { id: 'empty-portfolio', selection: null, expected: 'No lifecycle plan explanation and Open Specs action without zero KPIs' },
  { id: 'loading-portfolio', selection: null, expected: 'Header, KPI, toolbar, and all-phase matrix geometry skeleton' },
  { id: 'adapter-unavailable', selection: null, expected: 'Adapter explanation and retry connection action without zero KPIs' },
  { id: 'permission-restricted', selection: null, expected: 'Permission explanation and administrator next action without zero KPIs' },
  { id: 'recoverable-error', selection: null, expected: 'Connection explanation and retry action without zero KPIs' },
  { id: 'learn-candidate', selection: 'billing-anomaly-alerts:learn', expected: 'Candidate provenance, review state, source evidence, and next action' },
] as const;

export const LIFECYCLE_VISUAL_FIXTURES = LIFECYCLE_VISUAL_SCENARIOS.flatMap((scenario) => (
  LIFECYCLE_VISUAL_VIEWPORTS.map((viewport) => ({
    id: `${scenario.id}-${viewport.id}-light`,
    screenshot: `tests/lifecycle-visual.spec.ts-snapshots/${scenario.id}-${viewport.id}-light-chromium.png`,
    scenario: scenario.id,
    viewport,
    theme: 'light' as const,
    selection: scenario.selection,
    expected: scenario.expected,
    reducedMotion: true,
    textScalePercent: 100,
  }))
));

/** Representative dark parity keeps state semantics stable without tripling every baseline. */
export const LIFECYCLE_DARK_VISUAL_SCENARIOS = [
  'default-portfolio',
  'blocked-validation-drawer',
  'retry-preview',
  'empty-portfolio',
  'loading-portfolio',
  'recoverable-error',
  'stale-revision',
] as const;

export const LIFECYCLE_DARK_VISUAL_FIXTURES = LIFECYCLE_DARK_VISUAL_SCENARIOS.map((scenario) => {
  const definition = LIFECYCLE_VISUAL_SCENARIOS.find((candidate) => candidate.id === scenario);
  if (!definition) throw new Error(`Unknown Lifecycle visual scenario: ${scenario}`);
  return {
    id: `${scenario}-desktop-dark`,
    screenshot: `tests/lifecycle-visual.spec.ts-snapshots/${scenario}-desktop-dark-chromium.png`,
    scenario,
    viewport: LIFECYCLE_VISUAL_VIEWPORTS[0],
    theme: 'dark' as const,
    selection: definition.selection,
    expected: definition.expected,
    reducedMotion: true,
    textScalePercent: 100,
  };
});

export const LIFECYCLE_VISUAL_QA_REJECTIONS = [
  'placeholder copy',
  'uneven spacing',
  'clipped labels',
  'layout shift',
  'nested-card clutter',
  'heavy shadows',
  'uncontrolled gradients',
  'low-contrast status tints',
  'ambiguous primary actions',
] as const;
