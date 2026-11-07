/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Canonical machine-readable readiness reason codes.
 *
 * Keep these stable: backend gates, MCP/API payloads, repair diagnostics, and UI
 * rendering should exchange these values instead of inventing prose strings.
 */
export const SpecReadinessReasonCode = {
  MissingContext: 'missing_context',
  ContextBackfilled: 'context_backfilled',
  PostSavePending: 'post_save_pending',
  NoInstalledSkills: 'no_installed_skills',
  BlockedByDependency: 'blocked_by_dependency',
  StageFailed: 'stage_failed',
  ActiveWorkflowConflict: 'active_workflow_conflict',
  ActivePipelineConflict: 'active_pipeline_conflict',
  PolicySkipped: 'policy_skipped',
  RunAnywayOverrideUsed: 'run_anyway_override_used',
  PlanCompilationNeeded: 'plan_compilation_needed',
  PlanCompilationFailed: 'plan_compilation_failed',
  EngineeringCanonUnavailable: 'engineering_canon_unavailable',
  MissingRequiredSkill: 'missing_required_skill',
  MissingDomainAuthority: 'missing_domain_authority',
  InsufficientEvidence: 'insufficient_evidence',
  CanonCompatibilityConflict: 'canon_compatibility_conflict',
  CanonTokenOmission: 'canon_token_omission',
} as const;

/** Stable denial codes shared by every bounty mutation/effect boundary. */
export const BountyOperationalReasonCode = {
  FeatureDisabled: 'BOUNTY_FEATURE_DISABLED',
} as const;

export type BountyOperationalReasonCode = typeof BountyOperationalReasonCode[keyof typeof BountyOperationalReasonCode];

export const SpecWorkflowReasonCode = {
  InspectionAvailable: 'inspection_available',
  ReadyForApproval: 'ready_for_approval',
  ReadyForRun: 'ready_for_run',
  StageStateMissing: 'stage_state_missing',
} as const;

export type SpecReadinessReasonCode = typeof SpecReadinessReasonCode[keyof typeof SpecReadinessReasonCode];
export type SpecWorkflowReasonCode = typeof SpecWorkflowReasonCode[keyof typeof SpecWorkflowReasonCode];
export type SpecOperationalReasonCode = SpecReadinessReasonCode | SpecWorkflowReasonCode;

export type SpecReadinessReasonSeverity = 'blocking' | 'warning' | 'audit';

export interface SpecReadinessReason {
  code: SpecReadinessReasonCode;
  message: string;
  severity: SpecReadinessReasonSeverity;
  details?: Record<string, unknown>;
}

export function isSpecReadinessReasonCode(value: unknown): value is SpecReadinessReasonCode {
  return typeof value === 'string'
    && (Object.values(SpecReadinessReasonCode) as string[]).includes(value);
}

export function isSpecWorkflowReasonCode(value: unknown): value is SpecWorkflowReasonCode {
  return typeof value === 'string'
    && (Object.values(SpecWorkflowReasonCode) as string[]).includes(value);
}

export function isSpecOperationalReasonCode(value: unknown): value is SpecOperationalReasonCode {
  return isSpecReadinessReasonCode(value) || isSpecWorkflowReasonCode(value);
}
