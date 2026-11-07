/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  buildMaintenanceLifecycleInvalidation,
  MAINTENANCE_OUTCOME_GATE_ID,
} from '../lib/ssdlc-contracts';

it('builds the canonical maintenance invalidation identity used by worker closeout', () => {
  expect(buildMaintenanceLifecycleInvalidation({
    workspaceId: 'workspace-maintenance',
    specId: 'completed-spec',
    runId: 42,
    changeKind: 'evidence_persisted',
  })).toEqual({
    workspaceId: 'workspace-maintenance',
    specId: 'completed-spec',
    runId: 42,
    changeKind: 'evidence_persisted',
    phaseId: 'maintenance',
    gateId: MAINTENANCE_OUTCOME_GATE_ID,
    affectedCell: {
      phaseId: 'maintenance',
      gateId: MAINTENANCE_OUTCOME_GATE_ID,
    },
  });
});

it('preserves exact workspace, spec, and bigint-safe run identities', () => {
  const payload = buildMaintenanceLifecycleInvalidation({
    workspaceId: 'workspace-alpha-not-a-number',
    specId: 'retry-spec',
    runId: '9007199254740993',
    changeKind: 'evidence_persisted',
  });

  expect(payload.workspaceId).toBe('workspace-alpha-not-a-number');
  expect(payload.specId).toBe('retry-spec');
  expect(payload.runId).toBe('9007199254740993');
  expect(payload.gateId).not.toBeNull();
  expect(payload.affectedCell).toEqual({
    phaseId: payload.phaseId,
    gateId: payload.gateId,
  });
});
