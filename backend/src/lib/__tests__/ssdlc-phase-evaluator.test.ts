/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  PHASE_STATUS_PRECEDENCE,
  aggregatePhaseEvaluations,
  derivePhaseDependencyMap,
  evaluateLifecycle,
  evaluatePhase,
  evaluatePortfolio,
  type PhaseDecision,
} from '../ssdlc-phase-evaluator';
import {
  ARTIFACT_SUBJECT,
  COMPLETE_DECISIONS,
  COMPLETE_EVIDENCE,
  COMMIT_SUBJECT,
  DEPLOYMENT_SUBJECT,
  EVALUATION_TIME,
  EVALUATOR_PLAN,
  LIFECYCLE_DELIVERY_FIXTURES,
  PHASE_EVALUATOR_FIXTURES,
  approvalDecision,
  evaluatorRunState,
  passingEvidence,
} from './fixtures/ssdlc-phase-evaluator.fixtures';

describe.each(PHASE_EVALUATOR_FIXTURES)('$name', (fixture) => {
  test(`derives ${fixture.expectedStatus} deterministically`, () => {
    const runState = evaluatorRunState(fixture.phaseId);
    const first = evaluatePhase(
      structuredClone(EVALUATOR_PLAN),
      structuredClone(fixture.evidence),
      structuredClone(fixture.decisions),
      structuredClone(runState),
      EVALUATION_TIME,
    );
    const second = evaluatePhase(
      structuredClone(EVALUATOR_PLAN),
      structuredClone(fixture.evidence),
      structuredClone(fixture.decisions),
      structuredClone(runState),
      new Date(EVALUATION_TIME),
    );

    expect(first.status).toBe(fixture.expectedStatus);
    expect(first.evaluatedStatus).toBe(first.status);
    expect(second).toEqual(first);
    expect(first.snapshot.evaluatedAt).toBe(EVALUATION_TIME.toISOString());
  });
});

describe.each(LIFECYCLE_DELIVERY_FIXTURES)('delivery fixture: $name', (fixture) => {
  test(`derives ${fixture.expectedStatus} from deterministic persisted facts`, () => {
    const result = evaluatePhase(
      structuredClone(EVALUATOR_PLAN),
      structuredClone(fixture.evidence),
      structuredClone(fixture.decisions),
      evaluatorRunState(fixture.phaseId),
      EVALUATION_TIME,
    );

    expect(result.status).toBe(fixture.expectedStatus);
    expect(result.snapshot.evaluatedAt).toBe(EVALUATION_TIME.toISOString());
  });
});

describe('blocking evidence, precedence, and invalid history', () => {
  test('returns the exact first topological blocker and one evidence-backed safe action', () => {
    const fixture = PHASE_EVALUATOR_FIXTURES.find((candidate) => candidate.name === 'blocker_required')!;
    const result = evaluatePhase(
      EVALUATOR_PLAN,
      fixture.evidence,
      fixture.decisions,
      evaluatorRunState(fixture.phaseId),
      EVALUATION_TIME,
    );

    expect(result).toMatchObject({
      status: 'blocked',
      blockerGateId: 'gate-validation',
    });
    expect(result.blockerReason).toContain('evidence-validation');
    expect(result.blockerReason).toContain('focused tests failed');
    expect(result.nextSafeAction).toMatch(/Collect new automated_validation evidence.*then re-evaluate/);
    expect(result.nextUnmetGate).toMatchObject({ gateId: 'gate-validation', status: 'blocked' });
  });

  test('uses one documented total precedence order for gate detail and phase summary', () => {
    expect(PHASE_STATUS_PRECEDENCE.slice(0, 5)).toEqual([
      'stale',
      'blocked',
      'awaiting_approval',
      'in_progress',
      'passed',
    ]);
    const result = evaluatePhase(
      EVALUATOR_PLAN,
      [
        passingEvidence('requirements', {
          subjectRevision: { type: 'spec_hash', value: `sha256:${'8'.repeat(64)}` },
        }),
        passingEvidence('validation', {
          status: 'failed',
          failureReason: 'current validation failed',
        }),
      ],
      [],
      evaluatorRunState('validation'),
      EVALUATION_TIME,
    );

    expect(result.gates[0].status).toBe('blocked');
    expect(result.status).toBe('stale');
    expect(result.blockerGateId).toBeUndefined();
  });

  test('keeps rejected agent/process/UI claims visible but invalid and ineligible', () => {
    const fixture = PHASE_EVALUATOR_FIXTURES.find((candidate) => candidate.name === 'no_evidence')!;
    const result = evaluatePhase(
      EVALUATOR_PLAN,
      fixture.evidence,
      [],
      evaluatorRunState('intake'),
      EVALUATION_TIME,
    );

    expect(result.status).toBe('in_progress');
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toMatchObject({
      valid: false,
      satisfiesGate: false,
      invalidReasons: ['schema_invalid'],
    });
  });

  test.each(['revision_mismatch', 'expired_evidence'] as const)(
    'preserves %s history while removing it from gate counts',
    (name) => {
      const fixture = PHASE_EVALUATOR_FIXTURES.find((candidate) => candidate.name === name)!;
      const result = evaluatePhase(
        EVALUATOR_PLAN,
        fixture.evidence,
        [],
        evaluatorRunState(fixture.phaseId),
        EVALUATION_TIME,
      );
      expect(result.status).toBe('stale');
      expect(result.evidence).toHaveLength(1);
      expect(result.evidence[0].valid).toBe(false);
      expect(result.evidence[0].satisfiesGate).toBe(false);
      expect(fixture.evidence).toHaveLength(1);
    },
  );

  test('does not allow a warning-only baseline event to override current passing evidence', () => {
    const fixture = PHASE_EVALUATOR_FIXTURES.find((candidate) => candidate.name === 'warning_only_baseline')!;
    const result = evaluatePhase(
      EVALUATOR_PLAN,
      fixture.evidence,
      [],
      evaluatorRunState('validation'),
      EVALUATION_TIME,
    );
    expect(result.status).toBe('passed');
    expect(result.evidence.filter((item) => item.normalizedOutcome === 'warning'))
      .toEqual([expect.objectContaining({ valid: true, satisfiesGate: false })]);
  });

  test('stales evidence collected under a superseded gate policy without deleting it', () => {
    const result = evaluatePhase(
      EVALUATOR_PLAN,
      [passingEvidence('intake', { policyVersion: 'fixture-policy-superseded' })],
      [],
      evaluatorRunState('intake'),
      EVALUATION_TIME,
    );
    expect(result.status).toBe('stale');
    expect(result.evidence[0]).toMatchObject({
      valid: false,
      invalidReasons: ['policy_version_mismatch'],
    });
  });

  test('treats an expired required approval as stale rather than approved', () => {
    const result = evaluatePhase(
      EVALUATOR_PLAN,
      [passingEvidence('architecture')],
      [approvalDecision('architecture', { expiresAt: '2026-07-15T11:00:00.000Z' })],
      evaluatorRunState('architecture'),
      EVALUATION_TIME,
    );
    expect(result.status).toBe('stale');
    expect(result.decisions[0]).toMatchObject({
      valid: false,
      active: false,
      invalidReasons: ['expired'],
    });
  });
});

describe('dependency-scoped invalidation and release lineage', () => {
  test('derives gate dependencies from requirement mappings and downstream coherence rules', () => {
    const dependencies = derivePhaseDependencyMap(EVALUATOR_PLAN);
    expect(dependencies.validation).toContain('gate:gate-requirements');
    expect(dependencies.qa).toContain('gate:gate-validation');
    expect(dependencies.merge).toContain('subject:artifact_digest');
    expect(dependencies.security).not.toContain('gate:gate-validation');
  });

  test('stales only dependent downstream phases and leaves sibling evidence valid', () => {
    const runState = {
      ...evaluatorRunState(),
      changedGateIds: ['gate-validation'],
    };
    const result = evaluateLifecycle(
      EVALUATOR_PLAN,
      COMPLETE_EVIDENCE,
      COMPLETE_DECISIONS,
      runState,
      EVALUATION_TIME,
    );
    const statuses = Object.fromEntries(result.phases.map((phase) => [phase.phaseId, phase.status]));

    expect(statuses.validation).toBe('stale');
    expect(statuses.qa).toBe('stale');
    expect(statuses.merge).toBe('stale');
    expect(statuses.production).toBe('stale');
    expect(statuses.security).toBe('passed');
    expect(statuses.staging).toBe('passed');
    const siblingEvidence = result.phases.find((phase) => phase.phaseId === 'security')!.evidence
      .find((evidence) => evidence.evidenceId === 'evidence-security');
    expect(siblingEvidence?.valid).toBe(true);
  });

  test('stales only artifact-lineage dependents when commit-to-artifact coherence changes', () => {
    const nextArtifact = `sha256:${'c'.repeat(64)}` as const;
    const runState = evaluatorRunState();
    runState.activeSubjects.artifact_digest = { type: 'artifact_digest', value: nextArtifact };
    runState.releaseLineage = {
      ...runState.releaseLineage,
      artifactDigest: nextArtifact,
      deploymentArtifactDigest: nextArtifact,
    };
    const result = evaluateLifecycle(
      EVALUATOR_PLAN,
      COMPLETE_EVIDENCE,
      COMPLETE_DECISIONS,
      runState,
      EVALUATION_TIME,
    );
    const statuses = Object.fromEntries(result.phases.map((phase) => [phase.phaseId, phase.status]));

    expect(statuses.staging).toBe('stale');
    expect(statuses.qa).toBe('stale');
    expect(statuses.merge).toBe('stale');
    expect(statuses.production).toBe('stale');
    expect(statuses.validation).toBe('passed');
    expect(statuses.security).toBe('passed');
  });

  test('requires production evidence to prove commit, artifact, and deployment identity', () => {
    const evidence = COMPLETE_EVIDENCE.map((item) =>
      item.gateId === 'gate-production'
        ? { ...item, releaseLineage: { commitSha: COMMIT_SUBJECT.value, artifactDigest: ARTIFACT_SUBJECT.value } }
        : item);
    const result = evaluatePhase(
      EVALUATOR_PLAN,
      evidence,
      COMPLETE_DECISIONS,
      evaluatorRunState('production'),
      EVALUATION_TIME,
    );
    expect(result.status).toBe('stale');
    expect(result.evidence.find((item) => item.evidenceId === 'evidence-production'))
      .toMatchObject({ valid: false, invalidReasons: ['lineage_mismatch'] });
  });
});

describe('dispositions, shared counts, and snapshot consistency', () => {
  test('excludes deferred and not-applicable phases with rationale and active provenance', () => {
    const plan = structuredClone(EVALUATOR_PLAN);
    const deferredReference = `DEC-sha256:${'d'.repeat(64)}`;
    plan.phases.find((phase) => phase.phaseId === 'security')!.disposition = {
      disposition: 'deferred',
      rationale: 'Security review is deferred by an expiring governed decision.',
      approvalReference: deferredReference,
      expiryPolicy: 'until 2026-07-20',
    };
    plan.phases.find((phase) => phase.phaseId === 'staging')!.disposition = {
      disposition: 'not_applicable',
      rationale: 'This delivery has no staging environment.',
    };
    const deferral: PhaseDecision = {
      ...approvalDecision('security'),
      decisionId: deferredReference,
      decisionType: 'defer',
      expiresAt: '2026-07-20T12:00:00.000Z',
    };
    const result = evaluateLifecycle(
      plan,
      COMPLETE_EVIDENCE,
      [...COMPLETE_DECISIONS, deferral],
      evaluatorRunState(),
      EVALUATION_TIME,
    );
    const security = result.phases.find((phase) => phase.phaseId === 'security')!;
    const staging = result.phases.find((phase) => phase.phaseId === 'staging')!;

    expect(security).toMatchObject({ status: 'deferred', excluded: true });
    expect(security.rationale).toContain('deferred');
    expect(security.decisionProvenance).toMatchObject({
      source: 'governed_decision', decisionId: deferredReference, active: true,
    });
    expect(staging).toMatchObject({ status: 'not_applicable', excluded: true });
    expect(staging.decisionProvenance).toMatchObject({ source: 'compiled_plan', active: true });
    expect(result.counts).toMatchObject({ total: 11, excluded: 2, denominator: 9, passed: 9 });
    expect(result.counts.completionRate).toBe(1);
  });

  test('derives complete release, phase detail, matrix cells, and portfolio from one evaluator', () => {
    const lifecycle = evaluateLifecycle(
      EVALUATOR_PLAN,
      COMPLETE_EVIDENCE,
      COMPLETE_DECISIONS,
      evaluatorRunState(),
      EVALUATION_TIME,
    );
    const portfolio = evaluatePortfolio([{
      plan: EVALUATOR_PLAN,
      evidence: COMPLETE_EVIDENCE,
      decisions: COMPLETE_DECISIONS,
      runState: evaluatorRunState(),
    }], EVALUATION_TIME);

    expect(lifecycle.phases.every((phase) => phase.status === 'passed')).toBe(true);
    expect(lifecycle.counts).toEqual(aggregatePhaseEvaluations(lifecycle.phases));
    expect(lifecycle.matrixCellCounts).toEqual(lifecycle.counts.byStatus);
    expect(portfolio.counts).toEqual(lifecycle.counts);
    expect(portfolio.matrixCellCounts).toEqual(lifecycle.matrixCellCounts);
    expect(portfolio.evaluations[0].snapshot.snapshotId).toBe(lifecycle.snapshot.snapshotId);
  });

  test('binds every detail to plan/input, evidence/decision bounds, release subject, versions, and time', () => {
    const result = evaluateLifecycle(
      EVALUATOR_PLAN,
      COMPLETE_EVIDENCE,
      COMPLETE_DECISIONS,
      evaluatorRunState(),
      EVALUATION_TIME,
    );

    expect(result.snapshot).toMatchObject({
      planId: EVALUATOR_PLAN.planId,
      planVersion: EVALUATOR_PLAN.planVersion,
      inputHash: EVALUATOR_PLAN.inputHash,
      evidenceHighWaterMark: 'evidence-sequence-100',
      decisionHighWaterMark: 'decision-sequence-20',
      activeReleaseSubject: DEPLOYMENT_SUBJECT,
      policyVersion: EVALUATOR_PLAN.policyVersion,
      compilerVersion: EVALUATOR_PLAN.compilerVersion,
      evaluatedAt: EVALUATION_TIME.toISOString(),
    });
    expect(new Set(result.phases.map((phase) => phase.snapshot.snapshotId)))
      .toEqual(new Set([result.snapshot.snapshotId]));
    expect(Object.isFrozen(result.snapshot)).toBe(true);
  });

  test('signals refetch instead of accepting rows observed after the bounded snapshot', () => {
    const runState = {
      ...evaluatorRunState(),
      currentEvidenceHighWaterMark: 'evidence-sequence-101',
    };
    const result = evaluateLifecycle(
      EVALUATOR_PLAN,
      COMPLETE_EVIDENCE,
      COMPLETE_DECISIONS,
      runState,
      EVALUATION_TIME,
    );

    expect(result).toMatchObject({ snapshotChanged: true, refetchRequired: true });
    expect(result.phases.every((phase) => phase.snapshotChanged && phase.refetchRequired)).toBe(true);
  });

  test('does not mutate plan, evidence, decisions, run state, or caller time', () => {
    const plan = structuredClone(EVALUATOR_PLAN);
    const evidence = structuredClone(COMPLETE_EVIDENCE);
    const decisions = structuredClone(COMPLETE_DECISIONS);
    const runState = evaluatorRunState();
    const now = new Date(EVALUATION_TIME);
    const before = structuredClone({ plan, evidence, decisions, runState, now });

    evaluateLifecycle(plan, evidence, decisions, runState, now);

    expect({ plan, evidence, decisions, runState, now }).toEqual(before);
  });
});
