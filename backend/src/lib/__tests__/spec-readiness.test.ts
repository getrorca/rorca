/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { applyEngineeringCanonDiagnostics, evaluateSpecReadiness, SpecReadinessReasonCode, type EvaluateSpecReadinessInput } from '../spec-readiness';

const base = (overrides: Partial<EvaluateSpecReadinessInput> = {}): EvaluateSpecReadinessInput => ({
  workspaceId: 'ws-1',
  specId: 'spec-1',
  specPath: 'forge/specs/approved/spec-1.json',
  location: 'approved',
  specExists: true,
  generationLog: {
    id: 10,
    status: 'persisted',
    saveGeneration: 10,
    contextSummaryJson: {
      contextCaptureStatus: { status: 'provided', reason: 'caller_supplied_context' },
    },
  },
  workflowRun: { id: 20, status: 'completed' } as any,
  workflowStages: [
    { stage: 'context', requested: true, status: 'completed', reason: 'context_captured' },
    { stage: 'enrich', requested: true, status: 'completed', reason: 'job_completed' },
    { stage: 'matchSkills', requested: true, status: 'completed', reason: 'job_completed' },
    { stage: 'memorySynthesis', requested: false, status: 'skipped', reason: 'disabled_by_policy' },
  ],
  ...overrides,
});

describe('spec readiness evaluator', () => {
  it('returns strict runnable readiness when durable workflow completed', () => {
    const readiness = evaluateSpecReadiness(base());

    expect(readiness.persistenceState).toMatchObject({ exists: true, location: 'approved', latestGenerationLogId: 10 });
    expect(readiness.postSaveState).toMatchObject({ source: 'workflow', mode: 'strict', latestWorkflowRunId: 20 });
    expect(readiness.readinessState).toEqual({ status: 'ready', reason: 'strict' });
    expect(readiness.executionGate.status).toBe('allowed');
    expect(readiness.blockingReasons).toEqual([]);
    expect(readiness.availableActions).toContain('run');
  });

  it('returns best-effort readiness from legacy generation-log stage state', () => {
    const readiness = evaluateSpecReadiness(base({
      workflowRun: null,
      workflowStages: [],
      generationLog: {
        id: 11,
        status: 'persisted',
        saveGeneration: 11,
        contextSummaryJson: {
          contextCaptureStatus: { status: 'provided' },
          postSaveStages: {
            enrich: { requested: true, status: 'completed', reason: 'job_completed' },
            matchSkills: { requested: true, status: 'completed', reason: 'job_completed' },
          },
        },
      },
    }));

    expect(readiness.postSaveState).toMatchObject({ source: 'generation_log', mode: 'best_effort' });
    expect(readiness.readinessState).toEqual({ status: 'ready', reason: 'best_effort' });
    expect(readiness.executionGate.status).toBe('allowed');
  });

  it('allows policy-skipped post-save stages with canonical warnings', () => {
    const readiness = evaluateSpecReadiness(base({
      workflowStages: [
        { stage: 'context', requested: true, status: 'completed', reason: 'context_captured' },
        { stage: 'enrich', requested: true, status: 'skipped', reason: 'disabled_by_policy' },
        { stage: 'matchSkills', requested: true, status: 'skipped', reason: 'fingerprint_unchanged' },
      ],
    }));

    expect(readiness.postSaveState.mode).toBe('skipped');
    expect(readiness.executionGate.status).toBe('allowed');
    expect(readiness.warnings.map((warning) => warning.code)).toContain(SpecReadinessReasonCode.PolicySkipped);
  });

  it('blocks failed stages and dependency failures', () => {
    const readiness = evaluateSpecReadiness(base({
      workflowRun: { id: 21, status: 'failed' } as any,
      workflowStages: [
        { stage: 'enrich', requested: true, status: 'failed', reason: 'job_failed', error: 'timeout' },
        { stage: 'matchSkills', requested: true, status: 'failed', reason: 'blocked_by_required_stage_failed' },
      ],
    }));

    expect(readiness.postSaveState.mode).toBe('failed');
    expect(readiness.executionGate.status).toBe('blocked');
    expect(readiness.blockingReasons.map((r) => r.code)).toEqual(expect.arrayContaining([
      SpecReadinessReasonCode.StageFailed,
      SpecReadinessReasonCode.BlockedByDependency,
    ]));
    expect(readiness.availableActions).toEqual(expect.arrayContaining(['repair_post_save', 'retry_failed_stage']));
    expect(readiness.availableActions).not.toContain('run_anyway');
    expect(readiness.executionGate.overrideAllowed).toBe(false);
  });

  it('treats best-effort memory provider/storage failure as advisory without weakening strict policy', () => {
    const advisory = evaluateSpecReadiness(base({
      workflowRun: { id: 23, status: 'failed', effectivePolicy: { onFailure: 'continue' } } as any,
      workflowStages: [
        { stage: 'context', requested: true, status: 'completed', reason: 'context_captured' },
        { stage: 'memorySynthesis', requested: true, status: 'failed', reason: 'job_failed', error: 'Required spec memory synthesis did not complete (provider_or_storage_failure)' },
      ],
    }));
    expect(advisory.executionGate.status).toBe('allowed');
    expect(advisory.readinessState).toEqual({ status: 'degraded', reason: 'degraded' });
    expect(advisory.blockingReasons).toEqual([]);
    expect(advisory.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: SpecReadinessReasonCode.StageFailed, severity: 'warning', details: expect.objectContaining({ advisory: true }) }),
    ]));

    const strict = evaluateSpecReadiness(base({
      workflowRun: { id: 24, status: 'failed', effectivePolicy: { onFailure: 'fail' } } as any,
      workflowStages: [
        { stage: 'memorySynthesis', requested: true, status: 'failed', reason: 'job_failed', error: 'Required spec memory synthesis did not complete (provider_or_storage_failure)' },
      ],
    }));
    expect(strict.executionGate.status).toBe('blocked');
    expect(strict.blockingReasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: SpecReadinessReasonCode.StageFailed, severity: 'blocking' }),
    ]));
  });

  it('blocks pending post-save, active workflow, and active pipeline conflicts', () => {
    const readiness = evaluateSpecReadiness(base({
      workflowRun: { id: 22, status: 'running' } as any,
      workflowStages: [
        { stage: 'enrich', requested: true, status: 'running', reason: 'job_started' },
      ],
      activeWorkflowConflicts: [{ id: 22, status: 'running' }],
      activePipelineConflicts: [{ id: 30, status: 'running' }],
    }));

    expect(readiness.executionGate.status).toBe('blocked');
    expect(readiness.blockingReasons.map((r) => r.code)).toEqual(expect.arrayContaining([
      SpecReadinessReasonCode.PostSavePending,
      SpecReadinessReasonCode.ActiveWorkflowConflict,
      SpecReadinessReasonCode.ActivePipelineConflict,
    ]));
  });

  it('keeps legacy specs usable while exposing needs compilation and a lazy action', () => {
    const readiness = evaluateSpecReadiness(base({
      planCompilationState: {
        status: 'needs_compilation',
        label: 'needs compilation',
        currentPlan: null,
        retryableReason: null,
        compilePath: '/api/specs/spec-1/lifecycle/compile',
      },
    }));

    expect(readiness.lifecyclePlanState.label).toBe('needs compilation');
    expect(readiness.readinessState).toEqual({ status: 'degraded', reason: 'degraded' });
    expect(readiness.executionGate.status).toBe('allowed');
    expect(readiness.warnings.map((warning) => warning.code)).toContain(SpecReadinessReasonCode.PlanCompilationNeeded);
    expect(readiness.availableActions).toContain('compile_plan');
  });

  it('keeps the default-disabled optional canon neutral to legacy readiness', () => {
    const readiness = evaluateSpecReadiness(base());
    applyEngineeringCanonDiagnostics(readiness, {
      adapterStatus: 'degraded', reasonCode: 'disabled', message: 'Engineering canon integration is disabled.', receipt: null,
      selectedLayers: [], coveredCells: [], uncoveredCells: [], omissions: [], domainAuthority: { requestedDomains: [], approvedAuthorityIds: [] },
      evidenceProvenance: { evidenceIds: [], genesisPackageIds: [], redacted: true }, compatibility: { compatible: false, versionSkew: [], conflicts: [] },
      version: { canon: null, taxonomy: null, receiptHash: null }, nextActions: [],
    });
    expect(readiness.readinessState).toEqual({ status: 'ready', reason: 'strict' });
    expect(readiness.warnings).toEqual([]);
  });

  it('maps canon gaps to explicit non-fabricating diagnostics without adding a blocking gate', () => {
    const readiness = evaluateSpecReadiness(base());
    applyEngineeringCanonDiagnostics(readiness, {
      adapterStatus: 'available', receipt: { status: 'missing_domain_authority' }, selectedLayers: [], coveredCells: [],
      uncoveredCells: [{ gaps: ['missing_skill', 'missing_domain_authority', 'insufficient_evidence', 'conflict', 'version_skew', 'token_omission'] }], omissions: [],
      domainAuthority: { requestedDomains: ['healthcare'], approvedAuthorityIds: [] }, evidenceProvenance: { evidenceIds: [], genesisPackageIds: [], redacted: true },
      compatibility: { compatible: false, versionSkew: ['1.x/2.x'], conflicts: ['binding conflict'] }, version: { canon: '1.0.0', taxonomy: '1.0.0', receiptHash: 'sha256:receipt' }, nextActions: [],
    });
    expect(readiness.readinessState.status).toBe('degraded');
    expect(readiness.executionGate.status).toBe('allowed');
    expect(readiness.blockingReasons).toEqual([]);
    expect(readiness.warnings.map(item => item.code)).toEqual(expect.arrayContaining([
      SpecReadinessReasonCode.MissingRequiredSkill, SpecReadinessReasonCode.MissingDomainAuthority,
      SpecReadinessReasonCode.InsufficientEvidence, SpecReadinessReasonCode.CanonCompatibilityConflict,
      SpecReadinessReasonCode.CanonTokenOmission,
    ]));
    expect(readiness.availableActions).toEqual(expect.arrayContaining(['review_required_skills', 'attach_domain_authority', 'attach_approved_evidence', 'resolve_canon_compatibility', 'adjust_canon_token_budget']));
  });

  it('allows degraded-but-runnable specs with backfilled context and no installed skills', () => {
    const readiness = evaluateSpecReadiness(base({
      generationLog: {
        id: 12,
        status: 'persisted',
        saveGeneration: 12,
        contextSummaryJson: {
          contextCaptureStatus: { status: 'backfilled', reason: 'context_summary_derived_from_context_used_meta' },
        },
      },
      workflowStages: [
        { stage: 'context', requested: true, status: 'completed', reason: 'context_captured' },
        { stage: 'matchSkills', requested: true, status: 'skipped', reason: SpecReadinessReasonCode.NoInstalledSkills },
      ],
    }));

    expect(readiness.readinessState).toEqual({ status: 'degraded', reason: 'degraded' });
    expect(readiness.executionGate.status).toBe('allowed');
    expect(readiness.warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining([
      SpecReadinessReasonCode.ContextBackfilled,
      SpecReadinessReasonCode.NoInstalledSkills,
    ]));
    expect(readiness.availableActions).toContain('install_skills');
  });
});
