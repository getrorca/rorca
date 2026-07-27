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
  | 'retry_failed_stage'
  | 'compile_plan'
  | 'configure_engineering_canon'
  | 'review_required_skills'
  | 'attach_domain_authority'
  | 'attach_approved_evidence'
  | 'resolve_canon_compatibility'
  | 'adjust_canon_token_budget';

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

export interface EngineeringCanonCoveragePayload {
  adapterStatus: 'available' | 'degraded';
  reasonCode?: string;
  message?: string;
  receipt: Record<string, unknown> | null;
  selectedLayers: Array<{ id: string; version: string; layer: string; hash: string }>;
  coveredCells: Array<{ requirementId: string; overlayId: string; operation: string; resolution: 'covered' | 'not_applicable_confirmed' }>;
  uncoveredCells: unknown[];
  omissions: unknown[];
  domainAuthority: { requestedDomains: string[]; approvedAuthorityIds: string[] };
  evidenceProvenance: { evidenceIds: string[]; genesisPackageIds: string[]; redacted: true };
  compatibility: { compatible: boolean; versionSkew: string[]; conflicts: string[] };
  version: { canon: string | null; taxonomy: string | null; receiptHash: string | null };
  nextActions: Array<{ code: string; label: string; blocking: false }>;
}

export interface SpecReadinessPayload {
  persistenceState: SpecReadinessPersistenceState;
  lifecyclePlanState: Record<string, unknown>;
  postSaveState: SpecReadinessPostSaveState;
  readinessState: SpecReadinessStatePayload;
  executionGate: SpecExecutionGate;
  blockingReasons: import('./readinessReasonCodes').SpecReadinessReason[];
  warnings: import('./readinessReasonCodes').SpecReadinessReason[];
  availableActions: SpecReadinessAction[];
  engineeringCanon?: EngineeringCanonCoveragePayload;
}
