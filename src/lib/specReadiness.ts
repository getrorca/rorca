/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

export { SpecReadinessReasonCode } from './readinessReasonCodes';
export type {
  SpecReadinessReason,
  SpecReadinessReasonSeverity,
} from './readinessReasonCodes';

/** Frontend-local mirror of backend spec-readiness JSON contracts. */
export type SpecPersistenceLocation = 'pending' | 'approved' | 'missing';
export type SpecPostSaveReadinessMode = 'strict' | 'best_effort' | 'skipped' | 'failed' | 'pending' | 'unknown';
export type SpecReadinessStatus = 'ready' | 'degraded' | 'blocked';
export type SpecExecutionGateStatus = 'allowed' | 'blocked';
export type SpecReadinessAction =
  | 'approve'
  | 'run'
  | 'run_anyway'
  | 'wait_for_post_save'
  | 'repair_post_save'
  | 'install_skills'
  | 'backfill_context'
  | 'retry_failed_stage';

export interface SpecReadinessContextCaptureState {
  status: 'provided' | 'backfilled' | 'missing' | 'unknown';
  reason?: string;
}

export interface SpecReadinessPersistenceState {
  workspaceId: string;
  specId: string;
  specPath: string | null;
  location: SpecPersistenceLocation;
  exists: boolean;
  latestGenerationLogId: number | null;
  latestGenerationLogStatus: string | null;
  saveGeneration: number | null;
  contextCapture: SpecReadinessContextCaptureState;
}

export interface SpecReadinessStageState {
  stage: string;
  requested: boolean;
  status: string;
  reason: string | null;
  jobId?: string | null;
  bossJobId?: string | null;
  error?: string | null;
  updatedAt?: string;
}

export interface SpecReadinessPostSaveState {
  mode: SpecPostSaveReadinessMode;
  source: 'workflow' | 'generation_log' | 'none';
  latestWorkflowRunId: number | null;
  latestWorkflowStatus: string | null;
  stages: SpecReadinessStageState[];
}

export interface SpecReadinessStatePayload {
  status: SpecReadinessStatus;
  reason: 'strict' | 'best_effort' | 'skipped' | 'degraded' | 'blocked';
}

export interface SpecExecutionGate {
  status: SpecExecutionGateStatus;
  overrideAllowed: boolean;
  overrideReasonCode: string;
  reason?: string;
}

export interface SpecReadinessPayload {
  persistenceState: SpecReadinessPersistenceState;
  postSaveState: SpecReadinessPostSaveState;
  readinessState: SpecReadinessStatePayload;
  executionGate: SpecExecutionGate;
  blockingReasons: import('./readinessReasonCodes').SpecReadinessReason[];
  warnings: import('./readinessReasonCodes').SpecReadinessReason[];
  availableActions: SpecReadinessAction[];
}
