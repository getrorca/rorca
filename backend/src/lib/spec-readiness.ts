/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as path from 'path';
import { query, queryOne, execute } from '../db/index';
import { listStagesByRun, type PostSaveWorkflowRun, type PostSaveWorkflowStage, type PostSaveWorkflowRunStatus } from '../db/spec-post-save';
import { SpecReadinessReasonCode, type SpecReadinessReason } from '../reason-codes';
import { UnprocessableError } from './errors';
import { SkillRegistry } from './skill-registry';
import { resolveEngineeringCanonCoverage, deriveCoverageByPhase, type EngineeringCanonCoverage, type SpecCoverageByPhase } from './engineering-canon';
import {
  getSpecPlanCompilationState,
  type SpecPlanCompilationState,
} from './ssdlc-plan-service';

export { SpecReadinessReasonCode, type SpecReadinessReason } from '../reason-codes';

export type SpecPersistenceLocation = 'pending' | 'approved' | 'missing';
export type SpecPostSaveReadinessMode = 'strict' | 'best_effort' | 'skipped' | 'failed' | 'pending' | 'unknown';
export type SpecReadinessStatus = 'ready' | 'degraded' | 'blocked';
export type SpecExecutionGateStatus = 'allowed' | 'blocked';
export type SpecReadinessAction =
  | 'approve'
  | 'run'
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
  latestWorkflowStatus: PostSaveWorkflowRunStatus | null;
  stages: SpecReadinessStageState[];
}

export interface SpecReadinessStatePayload {
  status: SpecReadinessStatus;
  reason: 'strict' | 'best_effort' | 'skipped' | 'degraded' | 'blocked';
}

export interface SpecExecutionGate {
  status: SpecExecutionGateStatus;
  overrideAllowed: boolean;
  overrideReasonCode: typeof SpecReadinessReasonCode.RunAnywayOverrideUsed;
}

export interface SpecReadinessPayload {
  persistenceState: SpecReadinessPersistenceState;
  lifecyclePlanState: SpecPlanCompilationState;
  postSaveState: SpecReadinessPostSaveState;
  readinessState: SpecReadinessStatePayload;
  executionGate: SpecExecutionGate;
  blockingReasons: SpecReadinessReason[];
  warnings: SpecReadinessReason[];
  availableActions: SpecReadinessAction[];
  engineeringCanon?: EngineeringCanonCoverage;
  /** Compiled per-phase coverage projection (all 11 phases; degraded when canon is absent). */
  coverageByPhase?: SpecCoverageByPhase;
}

export interface LatestGenerationLogSnapshot {
  id: number | null;
  status: string | null;
  contextSummaryJson?: Record<string, unknown> | null;
  saveGeneration?: number | null;
}

export interface EvaluateSpecReadinessInput {
  workspaceId: string;
  specId: string;
  specPath?: string | null;
  location?: SpecPersistenceLocation;
  specExists?: boolean;
  generationLog?: LatestGenerationLogSnapshot | null;
  workflowRun?: Pick<PostSaveWorkflowRun, 'id' | 'status' | 'effectivePolicy'> | null;
  workflowStages?: SpecReadinessStageState[];
  legacyPostSaveStages?: Record<string, unknown> | null;
  activeWorkflowConflicts?: Array<{ id: number; status: string }>;
  activePipelineConflicts?: Array<{ id: number; status: string }>;
  planCompilationState?: SpecPlanCompilationState;
}

function reason(
  code: typeof SpecReadinessReasonCode[keyof typeof SpecReadinessReasonCode],
  message: string,
  severity: SpecReadinessReason['severity'],
  details?: Record<string, unknown>,
): SpecReadinessReason {
  return { code, message, severity, ...(details ? { details } : {}) };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

function normalizeContextCapture(summary: Record<string, unknown> | null | undefined): SpecReadinessContextCaptureState {
  const capture = asRecord(summary?.contextCaptureStatus);
  const status = capture?.status;
  const reasonValue = capture?.reason;
  if (status === 'provided' || status === 'backfilled' || status === 'missing') {
    return {
      status,
      ...(typeof reasonValue === 'string' ? { reason: reasonValue } : {}),
    };
  }
  return { status: 'unknown' };
}

function normalizeLegacyStages(stages: Record<string, unknown> | null | undefined): SpecReadinessStageState[] {
  if (!stages) return [];
  return Object.entries(stages).map(([stage, raw]) => {
    const record = asRecord(raw) ?? {};
    return {
      stage,
      requested: Boolean(record.requested),
      status: typeof record.status === 'string' ? record.status : 'unknown',
      reason: typeof record.reason === 'string' ? record.reason : null,
      ...(typeof record.jobId === 'string' ? { jobId: record.jobId } : {}),
      ...(typeof record.bossJobId === 'string' || record.bossJobId === null ? { bossJobId: record.bossJobId as string | null } : {}),
      ...(typeof record.error === 'string' || record.error === null ? { error: record.error as string | null } : {}),
      ...(typeof record.updatedAt === 'string' ? { updatedAt: record.updatedAt } : {}),
    };
  });
}

function normalizeWorkflowStages(stages: PostSaveWorkflowStage[]): SpecReadinessStageState[] {
  return stages.map((stage) => ({
    stage: stage.stageKey,
    requested: stage.requested,
    status: stage.status,
    reason: stage.reason,
    ...(stage.jobId !== null ? { jobId: stage.jobId } : {}),
    ...(stage.bossJobId !== null ? { bossJobId: stage.bossJobId } : {}),
    ...(stage.errorMessage !== null ? { error: stage.errorMessage } : {}),
    updatedAt: stage.updatedAt.toISOString(),
  }));
}

function stageIsLive(stage: SpecReadinessStageState): boolean {
  return stage.requested && ['pending', 'queued', 'running'].includes(stage.status);
}

function stageIsFailed(stage: SpecReadinessStageState): boolean {
  return stage.requested && stage.status === 'failed';
}

function isDependencyBlock(reasonValue: string | null): boolean {
  return reasonValue === 'blocked_by_required_stage_failed'
    || reasonValue === 'blocked_by_enrich_failure'
    || reasonValue === 'blocked_by_enrich_enqueue_failure';
}

function isPolicySkipped(reasonValue: string | null): boolean {
  return reasonValue === 'disabled_by_policy'
    || reasonValue === 'fingerprint_unchanged'
    || reasonValue === 'metadata_only_skip';
}

function advisoryMemoryFailure(
  stage: SpecReadinessStageState,
  workflowRun: Pick<PostSaveWorkflowRun, 'effectivePolicy'> | null | undefined,
): boolean {
  const policy = asRecord(workflowRun?.effectivePolicy);
  return stage.stage === 'memorySynthesis'
    && stageIsFailed(stage)
    && policy?.onFailure === 'continue';
}

function derivePostSaveMode(
  source: SpecReadinessPostSaveState['source'],
  workflowRun: Pick<PostSaveWorkflowRun, 'id' | 'status' | 'effectivePolicy'> | null | undefined,
  stages: SpecReadinessStageState[],
): SpecPostSaveReadinessMode {
  if (workflowRun && ['pending', 'queued', 'running'].includes(workflowRun.status)) return 'pending';
  if (workflowRun && workflowRun.status === 'failed') return 'failed';
  if (stages.some(stageIsLive)) return 'pending';
  if (stages.some(stageIsFailed)) return 'failed';

  const requestedStages = stages.filter((stage) => stage.requested);
  const requestedPostSaveStages = requestedStages.filter((stage) => stage.stage !== 'context');
  if (requestedPostSaveStages.length > 0 && requestedPostSaveStages.every((stage) => stage.status === 'skipped')) return 'skipped';
  if (requestedStages.length > 0 && requestedStages.every((stage) => stage.status === 'skipped')) return 'skipped';

  if (source === 'workflow') return 'strict';
  if (source === 'generation_log' && stages.length > 0) return 'best_effort';
  if (source === 'generation_log') return 'best_effort';
  return 'unknown';
}

export function evaluateSpecReadiness(input: EvaluateSpecReadinessInput): SpecReadinessPayload {
  const summary = input.generationLog?.contextSummaryJson ?? null;
  const contextCapture = normalizeContextCapture(summary);
  const workflowStages = input.workflowStages ?? [];
  const legacyStages = normalizeLegacyStages(input.legacyPostSaveStages ?? asRecord(summary?.postSaveStages));
  const source: SpecReadinessPostSaveState['source'] = workflowStages.length > 0 || input.workflowRun
    ? 'workflow'
    : legacyStages.length > 0 || input.generationLog
      ? 'generation_log'
      : 'none';
  const stages = source === 'workflow' ? workflowStages : legacyStages;
  const postSaveMode = derivePostSaveMode(source, input.workflowRun, stages);

  const blockingReasons: SpecReadinessReason[] = [];
  const warnings: SpecReadinessReason[] = [];

  if (input.specExists === false || input.location === 'missing') {
    blockingReasons.push(reason(
      SpecReadinessReasonCode.MissingContext,
      'Spec file is missing from pending/ and approved/ storage.',
      'blocking',
      { specId: input.specId },
    ));
  }

  if (!input.generationLog || contextCapture.status === 'missing' || contextCapture.status === 'unknown') {
    blockingReasons.push(reason(
      SpecReadinessReasonCode.MissingContext,
      'Spec is missing canonical context capture metadata.',
      'blocking',
      { generationLogId: input.generationLog?.id ?? null, contextCaptureStatus: contextCapture.status },
    ));
  } else if (contextCapture.status === 'backfilled') {
    warnings.push(reason(
      SpecReadinessReasonCode.ContextBackfilled,
      'Context capture was server-backfilled; run is allowed but degraded.',
      'warning',
      { generationLogId: input.generationLog.id },
    ));
  }

  if ((input.activeWorkflowConflicts ?? []).length > 0) {
    blockingReasons.push(reason(
      SpecReadinessReasonCode.ActiveWorkflowConflict,
      'Another durable post-save workflow is active for this spec.',
      'blocking',
      { conflicts: input.activeWorkflowConflicts },
    ));
  }

  if ((input.activePipelineConflicts ?? []).length > 0) {
    blockingReasons.push(reason(
      SpecReadinessReasonCode.ActivePipelineConflict,
      'A pipeline run is already active for this spec.',
      'blocking',
      { conflicts: input.activePipelineConflicts },
    ));
  }

  const lifecyclePlanState = input.planCompilationState ?? {
    status: 'needs_compilation' as const,
    label: 'needs compilation' as const,
    currentPlan: null,
    retryableReason: null,
    compilePath: `/api/specs/${encodeURIComponent(input.specId)}/lifecycle/compile`,
  };
  if (input.planCompilationState && lifecyclePlanState.status !== 'current') {
    const failed = lifecyclePlanState.status === 'compilation_failed';
    warnings.push(reason(
      failed ? SpecReadinessReasonCode.PlanCompilationFailed : SpecReadinessReasonCode.PlanCompilationNeeded,
      failed
        ? 'Lifecycle plan compilation failed and can be retried.'
        : 'Lifecycle plan needs compilation before lifecycle evidence can be evaluated.',
      'warning',
      { lifecyclePlanState },
    ));
  }

  for (const stage of stages) {
    if (stageIsLive(stage)) {
      blockingReasons.push(reason(
        SpecReadinessReasonCode.PostSavePending,
        `Post-save stage ${stage.stage} is still ${stage.status}.`,
        'blocking',
        { stage: stage.stage, status: stage.status, reason: stage.reason },
      ));
      continue;
    }
    if (stageIsFailed(stage)) {
      const advisory = advisoryMemoryFailure(stage, input.workflowRun);
      const target = advisory ? warnings : blockingReasons;
      target.push(reason(
        isDependencyBlock(stage.reason) ? SpecReadinessReasonCode.BlockedByDependency : SpecReadinessReasonCode.StageFailed,
        advisory
          ? 'Advisory memory synthesis failed under a continue-on-failure policy; execution remains allowed.'
          : `Post-save stage ${stage.stage} failed.`,
        advisory ? 'warning' : 'blocking',
        { stage: stage.stage, status: stage.status, reason: stage.reason, error: stage.error ?? null, advisory },
      ));
      continue;
    }
    if (stage.requested && stage.status === 'skipped' && stage.reason === SpecReadinessReasonCode.NoInstalledSkills) {
      warnings.push(reason(
        SpecReadinessReasonCode.NoInstalledSkills,
        'Skill matching was skipped because no installed skills were available.',
        'warning',
        { stage: stage.stage },
      ));
    } else if (stage.requested && stage.status === 'skipped' && isPolicySkipped(stage.reason)) {
      warnings.push(reason(
        SpecReadinessReasonCode.PolicySkipped,
        `Post-save stage ${stage.stage} was skipped by policy.`,
        'warning',
        { stage: stage.stage, reason: stage.reason },
      ));
    }
  }

  const blocked = blockingReasons.length > 0;
  const degraded = !blocked && warnings.length > 0;
  const readinessState: SpecReadinessStatePayload = blocked
    ? { status: 'blocked', reason: 'blocked' }
    : degraded
      ? { status: 'degraded', reason: 'degraded' }
      : { status: 'ready', reason: postSaveMode === 'skipped' ? 'skipped' : postSaveMode === 'best_effort' ? 'best_effort' : 'strict' };

  const availableActions = new Set<SpecReadinessAction>();
  if (blockingReasons.some((r) => r.code === SpecReadinessReasonCode.PostSavePending || r.code === SpecReadinessReasonCode.ActiveWorkflowConflict)) availableActions.add('wait_for_post_save');
  if (blockingReasons.some((r) => r.code === SpecReadinessReasonCode.StageFailed || r.code === SpecReadinessReasonCode.BlockedByDependency)) {
    availableActions.add('repair_post_save');
    availableActions.add('retry_failed_stage');
  }
  if (blockingReasons.some((r) => r.code === SpecReadinessReasonCode.MissingContext)) availableActions.add('backfill_context');
  if (warnings.some((r) => r.code === SpecReadinessReasonCode.NoInstalledSkills)) availableActions.add('install_skills');
  if (lifecyclePlanState.status !== 'current') availableActions.add('compile_plan');
  if (!blocked) {
    availableActions.add(input.location === 'pending' ? 'approve' : 'run');
  }

  return {
    persistenceState: {
      workspaceId: input.workspaceId,
      specId: input.specId,
      specPath: input.specPath ?? null,
      location: input.location ?? 'missing',
      exists: input.specExists ?? input.location !== 'missing',
      latestGenerationLogId: input.generationLog?.id ?? null,
      latestGenerationLogStatus: input.generationLog?.status ?? null,
      saveGeneration: input.generationLog?.saveGeneration ?? null,
      contextCapture,
    },
    lifecyclePlanState,
    postSaveState: {
      mode: postSaveMode,
      source,
      latestWorkflowRunId: input.workflowRun?.id ?? null,
      latestWorkflowStatus: input.workflowRun?.status ?? null,
      stages,
    },
    readinessState,
    executionGate: {
      status: blocked ? 'blocked' : 'allowed',
      overrideAllowed: false,
      overrideReasonCode: SpecReadinessReasonCode.RunAnywayOverrideUsed,
    },
    blockingReasons,
    warnings,
    availableActions: [...availableActions],
  };
}

function resolveSpecFile(workspacePath: string, specId: string, requestedSpecPath?: string | null): { specPath: string | null; location: SpecPersistenceLocation; exists: boolean } {
  if (requestedSpecPath) {
    const exists = fs.existsSync(path.join(workspacePath, requestedSpecPath));
    const location: SpecPersistenceLocation = requestedSpecPath.includes('/approved/')
      ? 'approved'
      : requestedSpecPath.includes('/pending/')
        ? 'pending'
        : exists ? 'approved' : 'missing';
    return { specPath: requestedSpecPath, location: exists ? location : 'missing', exists };
  }

  const approvedPath = `forge/specs/approved/${specId}.json`;
  if (fs.existsSync(path.join(workspacePath, approvedPath))) return { specPath: approvedPath, location: 'approved', exists: true };
  const pendingPath = `forge/specs/pending/${specId}.json`;
  if (fs.existsSync(path.join(workspacePath, pendingPath))) return { specPath: pendingPath, location: 'pending', exists: true };
  return { specPath: null, location: 'missing', exists: false };
}

export function applyEngineeringCanonDiagnostics(readiness: SpecReadinessPayload, coverage: EngineeringCanonCoverage): void {
  const addWarning = (code: SpecReadinessReason['code'], message: string, details?: Record<string, unknown>): void => {
    if (!readiness.warnings.some(item => item.code === code)) readiness.warnings.push(reason(code, message, 'warning', details));
  };
  if (coverage.adapterStatus === 'degraded' && coverage.reasonCode === 'disabled') {
    return;
  }
  if (coverage.adapterStatus === 'degraded') {
    addWarning(SpecReadinessReasonCode.EngineeringCanonUnavailable, coverage.message ?? 'Engineering canon coverage is degraded.', { reasonCode: coverage.reasonCode });
    if (!readiness.availableActions.includes('configure_engineering_canon')) readiness.availableActions.push('configure_engineering_canon');
  } else {
    const receiptStatus = coverage.receipt && typeof coverage.receipt.status === 'string' ? coverage.receipt.status : null;
    const gaps = new Set(coverage.uncoveredCells.flatMap(raw => {
      const cell = asRecord(raw);
      return Array.isArray(cell?.gaps) ? cell.gaps.filter((value): value is string => typeof value === 'string') : [];
    }));
    if (receiptStatus === 'missing_required_skill' || gaps.has('missing_skill')) {
      addWarning(SpecReadinessReasonCode.MissingRequiredSkill, 'Bounded coverage is missing a promoted required skill.');
      readiness.availableActions.push('review_required_skills');
    }
    if (receiptStatus === 'missing_domain_authority' || gaps.has('missing_domain_authority')) {
      addWarning(SpecReadinessReasonCode.MissingDomainAuthority, 'Bounded coverage is missing approved domain authority.');
      readiness.availableActions.push('attach_domain_authority');
    }
    if (receiptStatus === 'insufficient_evidence' || gaps.has('insufficient_evidence') || gaps.has('unknown')) {
      addWarning(SpecReadinessReasonCode.InsufficientEvidence, 'Bounded coverage has insufficient approved evidence or unknown cells.');
      readiness.availableActions.push('attach_approved_evidence');
    }
    if (gaps.has('conflict') || gaps.has('version_skew') || !coverage.compatibility.compatible) {
      addWarning(SpecReadinessReasonCode.CanonCompatibilityConflict, 'Engineering canon compatibility conflicts or version skew require review.');
      readiness.availableActions.push('resolve_canon_compatibility');
    }
    if (gaps.has('token_omission')) {
      addWarning(SpecReadinessReasonCode.CanonTokenOmission, 'Required canon coverage was omitted under the bounded token budget.');
      readiness.availableActions.push('adjust_canon_token_budget');
    }
  }
  readiness.availableActions = [...new Set(readiness.availableActions)];
  // Coverage diagnostics follow existing governed policy. They do not create a
  // new blocking gate and readiness overrides cannot alter evidence/activation.
  if (readiness.readinessState.status === 'ready' && readiness.warnings.length > 0) {
    readiness.readinessState = { status: 'degraded', reason: 'degraded' };
  }
}

export async function getSpecReadiness(input: {
  workspaceId: string;
  workspacePath: string;
  specId: string;
  specPath?: string | null;
}): Promise<SpecReadinessPayload> {
  const resolved = resolveSpecFile(input.workspacePath, input.specId, input.specPath);
  const generationLog = await queryOne<{
    id: number | string;
    status: string | null;
    context_summary_json: unknown;
    save_generation: number | string | null;
  }>(
    `SELECT id, status, context_summary_json,
        COALESCE(
          save_generation,
          CASE
            WHEN context_summary_json->>'saveGeneration' ~ '^\\d+$'
            THEN (context_summary_json->>'saveGeneration')::bigint
            ELSE NULL
          END,
          id::bigint
        ) AS save_generation
     FROM spec_generation_logs
     WHERE spec_slug = $1
       AND (context_summary_json->>'workspaceId' IS NULL OR context_summary_json->>'workspaceId' = $2)
     ORDER BY
      CASE
        WHEN context_summary_json->>'workspaceId' = $2
          OR save_generation IS NOT NULL
          OR context_summary_json->>'saveGeneration' ~ '^\\d+$'
        THEN 0
        ELSE 1
      END,
      COALESCE(
        save_generation,
        CASE
          WHEN context_summary_json->>'saveGeneration' ~ '^\\d+$'
          THEN (context_summary_json->>'saveGeneration')::bigint
          ELSE NULL
        END,
        id::bigint
      ) DESC, created_at DESC, id DESC
     LIMIT 1`,
    [input.specId, input.workspaceId],
  );

  const workflowRun = await queryOne<{
    id: number | string;
    status: PostSaveWorkflowRunStatus;
    effective_policy: PostSaveWorkflowRun['effectivePolicy'];
  }>(
    `SELECT id, status, effective_policy
     FROM spec_post_save_workflow_runs
     WHERE workspace_id = $1
       AND spec_id = $2
       AND ($3::bigint IS NULL OR save_generation = $3::bigint)
     ORDER BY save_generation DESC NULLS LAST, created_at DESC, id DESC
     LIMIT 1`,
    [input.workspaceId, input.specId, generationLog?.save_generation ?? null],
  );

  const workflowStages = workflowRun ? normalizeWorkflowStages(await listStagesByRun(Number(workflowRun.id))) : [];
  const activeWorkflowConflicts = await query<{ id: number | string; status: string }>(
    `SELECT id, status
     FROM spec_post_save_workflow_runs
     WHERE workspace_id = $1
       AND spec_id = $2
       AND status IN ('pending', 'queued', 'running')
     ORDER BY created_at DESC, id DESC`,
    [input.workspaceId, input.specId],
  );

  const candidateSpecPaths = [
    resolved.specPath,
    `forge/specs/approved/${input.specId}.json`,
    `forge/specs/pending/${input.specId}.json`,
  ].filter((value, index, arr): value is string => typeof value === 'string' && arr.indexOf(value) === index);

  const activePipelineConflicts = candidateSpecPaths.length > 0
    ? await query<{ id: number | string; status: string }>(
      `SELECT id, status
       FROM pipeline_runs
       WHERE workspace_id = $1
         AND spec_path = ANY($2::text[])
         AND status IN ('running', 'paused', 'pi_native')
       ORDER BY started_at DESC NULLS LAST, id DESC`,
      [input.workspaceId, candidateSpecPaths],
    )
    : [];

  const contextSummaryJson = asRecord(generationLog?.context_summary_json) ?? null;
  const planCompilationState = resolved.exists
    ? await getSpecPlanCompilationState({
      workspaceId: input.workspaceId,
      workspacePath: input.workspacePath,
      specSlug: input.specId,
    })
    : undefined;

  const readiness = evaluateSpecReadiness({
    workspaceId: input.workspaceId,
    specId: input.specId,
    specPath: resolved.specPath,
    location: resolved.location,
    specExists: resolved.exists,
    generationLog: generationLog ? {
      id: Number(generationLog.id),
      status: generationLog.status,
      contextSummaryJson,
      saveGeneration: generationLog.save_generation === null ? null : Number(generationLog.save_generation),
    } : null,
    workflowRun: workflowRun ? {
      id: Number(workflowRun.id),
      status: workflowRun.status,
      effectivePolicy: workflowRun.effective_policy,
    } as Pick<PostSaveWorkflowRun, 'id' | 'status' | 'effectivePolicy'> : null,
    workflowStages,
    activeWorkflowConflicts: activeWorkflowConflicts.map((row) => ({ id: Number(row.id), status: row.status })),
    activePipelineConflicts: activePipelineConflicts.map((row) => ({ id: Number(row.id), status: row.status })),
    planCompilationState,
  });

  let specContent: Record<string, unknown> = {};
  if (resolved.specPath) {
    try { specContent = JSON.parse(fs.readFileSync(path.join(input.workspacePath, resolved.specPath), 'utf8')) as Record<string, unknown>; } catch { /* readiness already reports missing/invalid storage elsewhere */ }
  }
  const canonMetadata = asRecord(specContent.engineeringCanon)
    ?? asRecord(specContent.coverage)
    ?? asRecord(contextSummaryJson?.engineeringCanon)
    ?? {};
  const registry = await new SkillRegistry().discover(input.workspacePath, input.workspaceId);
  const coverage = await resolveEngineeringCanonCoverage({
    workspacePath: input.workspacePath,
    workspaceId: input.workspaceId,
    specId: input.specId,
    metadata: canonMetadata,
    skills: registry.getAll(),
  });
  readiness.engineeringCanon = coverage;
  readiness.coverageByPhase = deriveCoverageByPhase(coverage, canonMetadata);
  applyEngineeringCanonDiagnostics(readiness, coverage);
  return readiness;
}

export function assertSpecReadinessAllowsMutation(readiness: SpecReadinessPayload, _override?: boolean): void {
  if (readiness.executionGate.status !== 'blocked') return;
  throw new UnprocessableError('Spec readiness gate blocked', 'SPEC_READINESS_BLOCKED', {
    readiness,
    blockingReasons: readiness.blockingReasons,
    availableActions: readiness.availableActions,
  });
}

export async function recordSpecReadinessOverride(input: {
  workspaceId: string;
  specId: string;
  action: 'approve' | 'run';
  readiness: SpecReadinessPayload;
  actor?: string;
}): Promise<void> {
  await execute(
    `INSERT INTO wal_events (event_type, spec_id, workspace_id, actor, payload)
     VALUES ('spec_readiness_override_used', $1, $2, $3, $4)`,
    [
      input.specId,
      input.workspaceId,
      input.actor ?? 'user',
      JSON.stringify({
        reasonCode: SpecReadinessReasonCode.RunAnywayOverrideUsed,
        action: input.action,
        blockingReasons: input.readiness.blockingReasons,
        warnings: input.readiness.warnings,
        readinessState: input.readiness.readinessState,
        executionGate: input.readiness.executionGate,
      }),
    ],
  );
}
