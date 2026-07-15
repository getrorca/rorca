/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Stable capture contract consumed by Lifecycle screenshot harnesses and human QA. */
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
    id: `${scenario.id}-${viewport.id}`,
    scenario: scenario.id,
    viewport,
    theme: 'light' as const,
    selection: scenario.selection,
    expected: scenario.expected,
    reducedMotion: true,
    textScalePercent: 100,
  }))
));
