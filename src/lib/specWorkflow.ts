/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Frontend-local mirror of the spec workflow inspection contract.
 *
 * Do not import this from backend/src/lib/spec-workflow: the backend module pulls
 * in database helpers, which makes the frontend tsc job compile backend runtime
 * files without backend dev dependencies in CI. Keep this file structural and
 * JSON-shaped so the UI can type API payloads without coupling to backend code.
 */
import type {
  SpecExecutionGate,
  SpecPersistenceLocation,
  SpecReadinessAction,
  SpecReadinessPersistenceState,
  SpecReadinessReason,
  SpecReadinessStatePayload,
} from './specReadiness';

export const WORKFLOW_STAGE_KEYS = ['context', 'enrich', 'matchSkills', 'memorySynthesis'] as const;

export type WorkflowStageKey = typeof WORKFLOW_STAGE_KEYS[number];
export type WorkflowStageStatus =
  | 'missing'
  | 'pending'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'cancelled'
  | 'superseded'
  | string;

export type WorkflowActionKey =
  | 'inspect_workflow'
  | 'inspect_readiness'
  | 'wait_for_post_save'
  | 'retry_stage'
  | 'repair_spec'
  | 'approve'
  | 'run'
  | 'run_anyway';

export interface WorkflowActionHint {
  action: WorkflowActionKey;
  target: 'spec' | 'stage';
  allowed: boolean;
  label: string;
  reasonCode: string;
  stageKey?: WorkflowStageKey;
  request: {
    method: 'GET' | 'POST';
    path: string;
    workspaceIdLocation: 'query' | 'body';
  };
}

export interface SpecWorkflowStageSnapshot {
  key: WorkflowStageKey;
  requested: boolean;
  status: WorkflowStageStatus;
  reasonCode: string | null;
  reason: string | null;
  workflowRunId: number | null;
  jobId: string | null;
  bossJobId: string | null;
  queueName: string | null;
  queueStatus: 'waiting' | 'running' | 'queued' | null;
  queuePosition: number | null;
  activeJobsAhead: number | null;
  queuePriority: number | null;
  singletonKey: string | null;
  error: string | null;
  updatedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  safeActionHints: WorkflowActionHint[];
}

export interface SpecWorkflowRunSnapshot {
  runId: number | null;
  status: string | null;
  source: string | null;
  saveGeneration: number | null;
  effectivePolicy: unknown | null;
  idempotencyKey: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  finishedAt: string | null;
}

export interface SpecWorkflowInspectionPayload {
  specId: string;
  workspaceId: string;
  persistence: {
    specPath: string | null;
    location: SpecPersistenceLocation;
    exists: boolean;
    latestGenerationLogId: number | null;
    latestGenerationLogStatus: string | null;
    saveGeneration: number | null;
  };
  workflow: SpecWorkflowRunSnapshot;
  reasonCodes: string[];
  stages: SpecWorkflowStageSnapshot[];
  safeActionHints: WorkflowActionHint[];
}

export interface SpecReadinessInspectionPayload {
  specId: string;
  workspaceId: string;
  persistence: SpecReadinessPersistenceState;
  workflow: SpecWorkflowRunSnapshot;
  stages: SpecWorkflowStageSnapshot[];
  readinessState: SpecReadinessStatePayload;
  executionGate: SpecExecutionGate;
  blockingReasons: SpecReadinessReason[];
  warnings: SpecReadinessReason[];
  availableActions: SpecReadinessAction[];
  reasonCodes: string[];
  safeActionHints: WorkflowActionHint[];
}

export interface SpecOperationalSurface {
  workflow: SpecWorkflowInspectionPayload;
  readiness: SpecReadinessInspectionPayload;
}
