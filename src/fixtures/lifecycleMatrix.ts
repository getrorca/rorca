/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  LIFECYCLE_PHASES,
  type LifecycleEvaluatedStatus,
  type LifecycleLiveness,
  type LifecyclePhaseCell,
  type LifecyclePortfolioItem,
} from '../types/lifecycle';

const ACTIVE_LIVENESS: LifecycleLiveness = {
  state: 'active',
  evaluatedAt: '2026-07-15T12:00:00.000Z',
  lastMeaningfulActivity: '2026-07-15T11:59:00.000Z',
  confidence: 0.98,
  evidence: [],
  blocker: null,
  nextSafeAction: { action: 'wait', explanation: 'The current validation run is making progress.' },
  policy: { inactivityThresholdMs: 300_000, lookbackMs: 3_600_000, evidenceLimit: 16 },
};

function phaseCell(
  phaseId: LifecyclePhaseCell['phaseId'],
  status: LifecycleEvaluatedStatus,
  passed: number,
  required: number,
  options: Partial<Pick<LifecyclePhaseCell, 'disposition' | 'rationale' | 'blocker' | 'nextSafeAction'>> = {},
): LifecyclePhaseCell {
  return {
    phaseId,
    displayName: LIFECYCLE_PHASES.find((phase) => phase.id === phaseId)?.displayName ?? phaseId,
    status,
    disposition: options.disposition ?? 'required',
    gateProgress: { passed, required },
    rationale: options.rationale ?? 'Required by the default SSDLC policy.',
    blocker: options.blocker ?? null,
    nextSafeAction: options.nextSafeAction ?? null,
  };
}

/** Canonical selected wireframe fixture used by component and Chromium tests. */
export const BILLING_ANOMALY_LIFECYCLE_ITEM: LifecyclePortfolioItem = {
  specId: 'billing-anomaly-alerts',
  title: 'Billing anomaly alerts',
  specStatus: 'approved',
  state: 'current',
  overallStatus: 'blocked',
  risk: 'medium',
  owner: { id: 'ada', label: 'Ada' },
  storySummary: { total: 6, passed: 3, failed: 1 },
  currentPhaseId: 'testing',
  blocked: true,
  blockers: [{ phaseId: 'testing', reason: 'Tenant-isolation integration test is failing.' }],
  liveness: ACTIVE_LIVENESS,
  currentRevision: { specVersion: '7', inputHash: 'sha256:billing', planVersion: 3 },
  phases: [
    phaseCell('planning', 'passed', 2, 2),
    phaseCell('requirements', 'passed', 4, 4),
    phaseCell('design', 'awaiting_approval', 1, 2, { nextSafeAction: 'Request design approval.' }),
    phaseCell('development', 'in_progress', 4, 6, { nextSafeAction: 'Complete the alert evaluator.' }),
    phaseCell('testing', 'blocked', 2, 4, {
      blocker: 'Tenant-isolation integration test is failing.',
      nextSafeAction: 'Retry the smallest testing scope.',
    }),
    phaseCell('deployment', 'deferred', 0, 2, {
      disposition: 'deferred',
      rationale: 'Approved until the shared staging environment is restored.',
    }),
    phaseCell('maintenance', 'not_started', 0, 1),
  ],
  delivery: { status: 'in_progress', rationale: 'Current delivery run is active.', reconciledAt: null },
  assurance: { status: 'partial', passedControls: 7, totalControls: 11, coverage: 7 / 11, rationale: 'Seven of eleven controls are satisfied.' },
  reconciliation: null,
  snapshotId: 'snapshot:billing',
  evidenceHighWaterMark: 'evidence:12',
  decisionHighWaterMark: 'decision:4',
  updatedAt: '2026-07-15T12:00:00.000Z',
};

export function createLifecycleMatrixFixture(count = 50): LifecyclePortfolioItem[] {
  return Array.from({ length: count }, (_, position) => {
    if (position === 0) return BILLING_ANOMALY_LIFECYCLE_ITEM;
    const ordinal = position + 1;
    return {
      ...BILLING_ANOMALY_LIFECYCLE_ITEM,
      specId: `seeded-lifecycle-spec-${String(ordinal).padStart(2, '0')}`,
      title: `Seeded lifecycle spec ${ordinal}`,
      owner: position % 3 === 0 ? null : { id: `owner-${position % 4}`, label: `Owner ${position % 4}` },
      risk: (['low', 'medium', 'high', 'critical'] as const)[position % 4],
      liveness: position % 2 === 0 ? ACTIVE_LIVENESS : null,
      phases: BILLING_ANOMALY_LIFECYCLE_ITEM.phases.map((phase) => ({ ...phase })),
      snapshotId: `snapshot:seed-${ordinal}`,
    };
  });
}
