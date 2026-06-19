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
} as const;

export type SpecReadinessReasonCode = typeof SpecReadinessReasonCode[keyof typeof SpecReadinessReasonCode];

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
