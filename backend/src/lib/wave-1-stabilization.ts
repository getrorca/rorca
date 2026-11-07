/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { AppError } from './errors';

export const WAVE_1_STABILIZATION_CONTRACT_VERSION = 'rorca.wave-1-stabilization-contract.v1' as const;
export const WAVE_1_IMPLEMENTATION_BASELINE_SHA = '407752564e654e1bc8d83af4d9f5154f6807f307' as const;
export const WAVE_1_SOURCE_REPOSITORY = 'https://github.com/getrorca/rorca.git' as const;
export const WAVE_1_SPEC_PATH = 'forge/specs/pending/wave-1-stabilize-evidence-closeout-and-managed-branch-delivery.json' as const;
export const WAVE_1_SPEC_REFERENCE = 'SPEC-9831E07EA1D42497' as const;
export const WAVE_1_SPEC_CONTENT_HASH = 'sha256:1f35f8f67b4c3a56291ed55af33680ae0513c5d5705ac939b2334fbb0166a319' as const;
export const WAVE_1_PROTECTED_GENESIS_RUN_ID = 20260316000549 as const;
export const WAVE_1_MANAGED_PROOF_RUN_ID = 20260316000550 as const;

export type Wave1IntakeReason =
  | 'PROTECTED_GENESIS_RUN'
  | 'RUN_NOT_SELECTED_FOR_WAVE_1'
  | 'PROOF_DEPLOYMENT_AUTHORITY_REQUIRED'
  | 'BASELINE_MISMATCH'
  | 'SPEC_REVISION_MISMATCH'
  | 'SPEC_PATH_MISMATCH'
  | 'REPOSITORY_MISMATCH'
  | 'WORKSPACE_MISMATCH';

/** Stable fail-closed diagnostic; never implies lifecycle or provider authority. */
export class Wave1IntakeBlockedError extends AppError {
  readonly statusCode = 409 as const;

  constructor(readonly reason: Wave1IntakeReason, message: string) {
    super(message, 'WAVE_1_INTAKE_BLOCKED', { reason });
  }
}

export interface Wave1DeploymentBinding {
  implementationBaselineSha: string;
  waveSpecRevision: string;
  sourceRepository: string;
}

/**
 * First selector fence. Call this before any run/evidence query or mutation
 * lock. The externally owned Genesis run is structurally ineligible forever.
 */
export function assertNotProtectedWave1Run(runId: number): void {
  if (runId === WAVE_1_PROTECTED_GENESIS_RUN_ID) {
    throw new Wave1IntakeBlockedError(
      'PROTECTED_GENESIS_RUN',
      'Externally owned Genesis run is structurally ineligible for Wave 1 selection',
    );
  }
}

/** Reconciliation is campaign-bounded to the reviewed proof identity. */
export function assertWave1ReconciliationSelector(
  runId: number,
  deployment: Wave1DeploymentBinding | null,
): void {
  assertNotProtectedWave1Run(runId);
  if (runId !== WAVE_1_MANAGED_PROOF_RUN_ID) {
    throw new Wave1IntakeBlockedError(
      'RUN_NOT_SELECTED_FOR_WAVE_1',
      'Run is not the exact Wave 1 managed proof identity',
    );
  }
  if (!deployment) {
    throw new Wave1IntakeBlockedError(
      'PROOF_DEPLOYMENT_AUTHORITY_REQUIRED',
      'Proof run remains ineligible until reviewed code is separately merged and deployed by authorized humans',
    );
  }
  assertWave1DeploymentBinding(deployment);
}

export function assertWave1DeploymentBinding(input: Wave1DeploymentBinding): void {
  if (input.implementationBaselineSha !== WAVE_1_IMPLEMENTATION_BASELINE_SHA) {
    throw new Wave1IntakeBlockedError('BASELINE_MISMATCH', 'Wave 1 implementation baseline does not match the reviewed contract');
  }
  if (input.waveSpecRevision !== WAVE_1_SPEC_CONTENT_HASH) {
    throw new Wave1IntakeBlockedError('SPEC_REVISION_MISMATCH', 'Wave 1 spec revision does not match the reviewed contract');
  }
  if (input.sourceRepository !== WAVE_1_SOURCE_REPOSITORY) {
    throw new Wave1IntakeBlockedError('REPOSITORY_MISMATCH', 'Wave 1 repository does not match the reviewed contract');
  }
}

export function assertWave1CanonicalTarget(input: {
  workspaceId: string;
  expectedWorkspaceId: string;
  canonicalSpecPath: string;
}): void {
  if (!input.workspaceId || input.workspaceId !== input.expectedWorkspaceId) {
    throw new Wave1IntakeBlockedError('WORKSPACE_MISMATCH', 'Wave 1 workspace does not match the exact selected workspace');
  }
  if (input.canonicalSpecPath !== WAVE_1_SPEC_PATH) {
    throw new Wave1IntakeBlockedError('SPEC_PATH_MISMATCH', 'Wave 1 canonical spec path does not match the reviewed contract');
  }
}
