/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  getLatestRunForSpec,
  listStagesByRun,
  type PostSaveWorkflowQueueStatus,
  type PostSaveWorkflowRun,
  type PostSaveWorkflowRunStatus,
  type PostSaveWorkflowStage,
  type PostSaveWorkflowStageKey,
} from '../db/spec-post-save';
import {
  getSpecReadiness,
  type SpecPersistenceLocation,
  type SpecReadinessPayload,
  type SpecReadinessReason,
  type SpecReadinessStageState,
} from './spec-readiness';
import { SpecReadinessReasonCode } from '../reason-codes';

export const WORKFLOW_STAGE_KEYS = ['context', 'enrich', 'matchSkills', 'memorySynthesis'] as const;

export type WorkflowStageKey = typeof WORKFLOW_STAGE_KEYS[number];
export type WorkflowStageStatus = 'missing' | PostSaveWorkflowStage['status'] | 'superseded';
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
  queueStatus: PostSaveWorkflowQueueStatus | null;
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
  status: PostSaveWorkflowRunStatus | null;
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
  persistence: SpecReadinessPayload['persistenceState'];
  workflow: SpecWorkflowRunSnapshot;
  stages: SpecWorkflowStageSnapshot[];
  readinessState: SpecReadinessPayload['readinessState'];
  executionGate: SpecReadinessPayload['executionGate'];
  blockingReasons: SpecReadinessReason[];
  warnings: SpecReadinessReason[];
  availableActions: SpecReadinessPayload['availableActions'];
  reasonCodes: string[];
  safeActionHints: WorkflowActionHint[];
}

export interface SpecOperationalSurface {
  workflow: SpecWorkflowInspectionPayload;
  readiness: SpecReadinessInspectionPayload;
}

function toIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))];
}

function firstReasonCode(readiness: SpecReadinessPayload, fallback = 'inspection_available'): string {
  return readiness.blockingReasons[0]?.code ?? readiness.warnings[0]?.code ?? fallback;
}

function stagePath(specId: string, stageKey: WorkflowStageKey): string {
  return `/api/specs/${encodeURIComponent(specId)}/workflow/stages/${encodeURIComponent(stageKey)}/retry`;
}

function workflowPath(specId: string): string {
  return `/api/specs/${encodeURIComponent(specId)}/workflow`;
}

function readinessPath(specId: string): string {
  return `/api/specs/${encodeURIComponent(specId)}/readiness`;
}

function repairPath(specId: string): string {
  return `/api/specs/${encodeURIComponent(specId)}/repair`;
}

function stageStateByKey(readiness: SpecReadinessPayload): Map<WorkflowStageKey, SpecReadinessStageState> {
  const mapped = new Map<WorkflowStageKey, SpecReadinessStageState>();
  for (const stage of readiness.postSaveState.stages) {
    if ((WORKFLOW_STAGE_KEYS as readonly string[]).includes(stage.stage)) {
      mapped.set(stage.stage as WorkflowStageKey, stage);
    }
  }
  return mapped;
}

function buildStageHints(input: {
  specId: string;
  stageKey: WorkflowStageKey;
  requested: boolean;
  status: WorkflowStageStatus;
  reasonCode: string | null;
  readiness: SpecReadinessPayload;
}): WorkflowActionHint[] {
  const hints: WorkflowActionHint[] = [];

  if (input.requested && ['pending', 'queued', 'running'].includes(input.status)) {
    hints.push({
      action: 'wait_for_post_save',
      target: 'stage',
      stageKey: input.stageKey,
      allowed: true,
      label: `Wait for ${input.stageKey} to finish`,
      reasonCode: input.reasonCode ?? SpecReadinessReasonCode.PostSavePending,
      request: {
        method: 'GET',
        path: workflowPath(input.specId),
        workspaceIdLocation: 'query',
      },
    });
  }

  if (input.requested && input.status === 'failed') {
    hints.push({
      action: 'retry_stage',
      target: 'stage',
      stageKey: input.stageKey,
      allowed: true,
      label: `Retry ${input.stageKey}`,
      reasonCode: input.reasonCode ?? SpecReadinessReasonCode.StageFailed,
      request: {
        method: 'POST',
        path: stagePath(input.specId, input.stageKey),
        workspaceIdLocation: 'body',
      },
    });
  }

  return hints;
}

function buildTopLevelHints(input: {
  specId: string;
  readiness: SpecReadinessPayload;
  stages: SpecWorkflowStageSnapshot[];
}): WorkflowActionHint[] {
  const hints: WorkflowActionHint[] = [
    {
      action: 'inspect_workflow',
      target: 'spec',
      allowed: true,
      label: 'Inspect workflow state',
      reasonCode: 'inspection_available',
      request: {
        method: 'GET',
        path: workflowPath(input.specId),
        workspaceIdLocation: 'query',
      },
    },
    {
      action: 'inspect_readiness',
      target: 'spec',
      allowed: true,
      label: 'Inspect readiness state',
      reasonCode: 'inspection_available',
      request: {
        method: 'GET',
        path: readinessPath(input.specId),
        workspaceIdLocation: 'query',
      },
    },
  ];

  if (input.readiness.availableActions.includes('wait_for_post_save')) {
    hints.push({
      action: 'wait_for_post_save',
      target: 'spec',
      allowed: true,
      label: 'Wait for post-save work to finish',
      reasonCode: firstReasonCode(input.readiness, SpecReadinessReasonCode.PostSavePending),
      request: {
        method: 'GET',
        path: workflowPath(input.specId),
        workspaceIdLocation: 'query',
      },
    });
  }

  if (input.readiness.availableActions.includes('repair_post_save') || input.readiness.availableActions.includes('backfill_context')) {
    hints.push({
      action: 'repair_spec',
      target: 'spec',
      allowed: true,
      label: 'Repair post-save state',
      reasonCode: firstReasonCode(input.readiness),
      request: {
        method: 'POST',
        path: repairPath(input.specId),
        workspaceIdLocation: 'body',
      },
    });
  }

  if (input.readiness.availableActions.includes('approve')) {
    hints.push({
      action: 'approve',
      target: 'spec',
      allowed: true,
      label: 'Approve spec',
      reasonCode: 'ready_for_approval',
      request: {
        method: 'POST',
        path: `/api/specs/${encodeURIComponent(input.specId)}/approve`,
        workspaceIdLocation: 'body',
      },
    });
  }

  if (input.readiness.availableActions.includes('run')) {
    hints.push({
      action: 'run',
      target: 'spec',
      allowed: true,
      label: 'Run spec',
      reasonCode: 'ready_for_run',
      request: {
        method: 'POST',
        path: '/api/pipeline/trigger',
        workspaceIdLocation: 'body',
      },
    });
  }

  if (input.readiness.availableActions.includes('run_anyway')) {
    hints.push({
      action: 'run_anyway',
      target: 'spec',
      allowed: true,
      label: 'Run with readiness override',
      reasonCode: firstReasonCode(input.readiness, SpecReadinessReasonCode.RunAnywayOverrideUsed),
      request: {
        method: 'POST',
        path: '/api/pipeline/trigger',
        workspaceIdLocation: 'body',
      },
    });
  }

  for (const stage of input.stages) {
    hints.push(...stage.safeActionHints);
  }

  return hints;
}

function buildStageSnapshot(input: {
  specId: string;
  workflowRunId: number | null;
  readiness: SpecReadinessPayload;
  workflowStage?: PostSaveWorkflowStage;
  readinessStage?: SpecReadinessStageState;
  stageKey: WorkflowStageKey;
}): SpecWorkflowStageSnapshot {
  const workflowStage = input.workflowStage;
  const readinessStage = input.readinessStage;
  const requested = workflowStage?.requested ?? readinessStage?.requested ?? false;
  const status = (workflowStage?.status ?? readinessStage?.status ?? 'missing') as WorkflowStageStatus;
  const reasonCode = workflowStage?.reason ?? readinessStage?.reason ?? (status === 'missing' ? 'stage_state_missing' : null);
  const snapshot: SpecWorkflowStageSnapshot = {
    key: input.stageKey,
    requested,
    status,
    reasonCode,
    reason: workflowStage?.reason ?? readinessStage?.reason ?? null,
    workflowRunId: workflowStage ? input.workflowRunId : input.readiness.postSaveState.latestWorkflowRunId,
    jobId: workflowStage?.jobId ?? readinessStage?.jobId ?? null,
    bossJobId: workflowStage?.bossJobId ?? readinessStage?.bossJobId ?? null,
    queueName: workflowStage?.queueName ?? null,
    queueStatus: workflowStage?.queueStatus ?? null,
    queuePosition: workflowStage?.queuePosition ?? null,
    activeJobsAhead: workflowStage?.activeJobsAhead ?? null,
    queuePriority: workflowStage?.queuePriority ?? null,
    singletonKey: workflowStage?.singletonKey ?? null,
    error: workflowStage?.errorMessage ?? readinessStage?.error ?? null,
    updatedAt: workflowStage ? toIso(workflowStage.updatedAt) : readinessStage?.updatedAt ?? null,
    startedAt: workflowStage ? toIso(workflowStage.startedAt) : null,
    finishedAt: workflowStage ? toIso(workflowStage.finishedAt) : null,
    safeActionHints: [],
  };

  snapshot.safeActionHints = buildStageHints({
    specId: input.specId,
    stageKey: input.stageKey,
    requested,
    status,
    reasonCode,
    readiness: input.readiness,
  });

  return snapshot;
}

export function buildSpecWorkflowInspection(input: {
  specId: string;
  workspaceId: string;
  readiness: SpecReadinessPayload;
  workflowRun: PostSaveWorkflowRun | null;
  workflowStages: PostSaveWorkflowStage[];
}): SpecWorkflowInspectionPayload {
  const readinessStages = stageStateByKey(input.readiness);
  const workflowStageMap = new Map<PostSaveWorkflowStageKey, PostSaveWorkflowStage>(
    input.workflowStages.map((stage) => [stage.stageKey, stage]),
  );

  const workflow: SpecWorkflowRunSnapshot = {
    runId: input.workflowRun?.id ?? input.readiness.postSaveState.latestWorkflowRunId,
    status: input.workflowRun?.status ?? input.readiness.postSaveState.latestWorkflowStatus,
    source: input.workflowRun?.source ?? null,
    saveGeneration: input.workflowRun?.saveGeneration ?? input.readiness.persistenceState.saveGeneration,
    effectivePolicy: input.workflowRun?.effectivePolicy ?? null,
    idempotencyKey: input.workflowRun?.idempotencyKey ?? null,
    createdAt: toIso(input.workflowRun?.createdAt),
    updatedAt: toIso(input.workflowRun?.updatedAt),
    finishedAt: toIso(input.workflowRun?.finishedAt),
  };

  const stages = WORKFLOW_STAGE_KEYS.map((stageKey) => buildStageSnapshot({
    specId: input.specId,
    workflowRunId: workflow.runId,
    readiness: input.readiness,
    workflowStage: workflowStageMap.get(stageKey),
    readinessStage: readinessStages.get(stageKey),
    stageKey,
  }));

  const safeActionHints = buildTopLevelHints({
    specId: input.specId,
    readiness: input.readiness,
    stages,
  });

  return {
    specId: input.specId,
    workspaceId: input.workspaceId,
    persistence: {
      specPath: input.readiness.persistenceState.specPath,
      location: input.readiness.persistenceState.location,
      exists: input.readiness.persistenceState.exists,
      latestGenerationLogId: input.readiness.persistenceState.latestGenerationLogId,
      latestGenerationLogStatus: input.readiness.persistenceState.latestGenerationLogStatus,
      saveGeneration: input.readiness.persistenceState.saveGeneration,
    },
    workflow,
    reasonCodes: uniqueStrings([
      ...stages.map((stage) => stage.reasonCode),
      ...input.readiness.blockingReasons.map((reason) => reason.code),
      ...input.readiness.warnings.map((warning) => warning.code),
    ]),
    stages,
    safeActionHints,
  };
}

export function buildSpecReadinessInspection(input: {
  specId: string;
  workspaceId: string;
  readiness: SpecReadinessPayload;
  workflow: SpecWorkflowInspectionPayload;
}): SpecReadinessInspectionPayload {
  return {
    specId: input.specId,
    workspaceId: input.workspaceId,
    persistence: input.readiness.persistenceState,
    workflow: input.workflow.workflow,
    stages: input.workflow.stages,
    readinessState: input.readiness.readinessState,
    executionGate: input.readiness.executionGate,
    blockingReasons: input.readiness.blockingReasons,
    warnings: input.readiness.warnings,
    availableActions: input.readiness.availableActions,
    reasonCodes: uniqueStrings([
      ...input.workflow.reasonCodes,
      ...input.readiness.blockingReasons.map((reason) => reason.code),
      ...input.readiness.warnings.map((warning) => warning.code),
    ]),
    safeActionHints: input.workflow.safeActionHints,
  };
}

export async function getSpecOperationalSurface(input: {
  workspaceId: string;
  workspacePath: string;
  specId: string;
  specPath?: string | null;
}): Promise<SpecOperationalSurface> {
  const readiness = await getSpecReadiness(input);
  const workflowRun = await getLatestRunForSpec(input.specId, {
    workspaceId: input.workspaceId,
    saveGeneration: readiness.persistenceState.saveGeneration,
  });
  const workflowStages = workflowRun ? await listStagesByRun(workflowRun.id) : [];
  const workflow = buildSpecWorkflowInspection({
    specId: input.specId,
    workspaceId: input.workspaceId,
    readiness,
    workflowRun,
    workflowStages,
  });

  return {
    workflow,
    readiness: buildSpecReadinessInspection({
      specId: input.specId,
      workspaceId: input.workspaceId,
      readiness,
      workflow,
    }),
  };
}
