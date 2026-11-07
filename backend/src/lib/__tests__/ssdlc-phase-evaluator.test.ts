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
  LEGACY_ELEVEN_PHASE_IDS,
  LEGACY_GATE_TO_CANONICAL_GATE,
  LEGACY_PHASE_TO_CANONICAL_PHASE,
  projectLifecyclePlanCompatibility,
} from '../ssdlc-contracts';
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

function legacyPhaseForGateId(gateId: string): (typeof LEGACY_ELEVEN_PHASE_IDS)[number] {
  const phase = LEGACY_ELEVEN_PHASE_IDS.find((candidate) =>
    gateId.startsWith(`gate-ctrl-${candidate === 'requirements' ? 'req' : candidate}-`));
  if (phase) return phase;
  if (gateId.startsWith('gate-ctrl-arch-')) return 'architecture';
  if (gateId.startsWith('gate-ctrl-impl-')) return 'implementation';
  if (gateId.startsWith('gate-ctrl-val-')) return 'validation';
  if (gateId.startsWith('gate-ctrl-sec-')) return 'security';
  if (gateId.startsWith('gate-ctrl-stage-')) return 'staging';
  if (gateId.startsWith('gate-ctrl-prod-')) return 'production';
  throw new Error(`Unknown historical gate phase for ${gateId}`);
}

function compatibilityProjectedEvaluatorPlan() {
  const canonicalToLegacyGate = new Map<string, string>(
    Object.entries(LEGACY_GATE_TO_CANONICAL_GATE)
      .map(([legacyGateId, canonicalGateId]) => [canonicalGateId, legacyGateId]),
  );
  const legacyGates = EVALUATOR_PLAN.gates.map((gate) => {
    const gateId = canonicalToLegacyGate.get(gate.gateId);
    if (!gateId) throw new Error(`Missing historical gate identity for ${gate.gateId}`);
    const phaseId = legacyPhaseForGateId(gateId);
    return {
      ...structuredClone(gate),
      gateId,
      phaseId,
      subjectRevisionRequirement: phaseId === 'merge'
        ? 'current_commit'
        : phaseId === 'staging'
          ? 'current_artifact'
          : phaseId === 'production'
            ? 'current_deployment'
            : gate.subjectRevisionRequirement,
    };
  });
  const historical = {
    ...structuredClone(EVALUATOR_PLAN),
    phaseOrder: [...LEGACY_ELEVEN_PHASE_IDS],
    phases: LEGACY_ELEVEN_PHASE_IDS.map((phaseId) => {
      const canonicalPhase = EVALUATOR_PLAN.phases.find((candidate) =>
        candidate.phaseId === LEGACY_PHASE_TO_CANONICAL_PHASE[phaseId]);
      if (!canonicalPhase) throw new Error(`Missing canonical phase for ${phaseId}`);
      return {
        ...structuredClone(canonicalPhase),
        phaseId,
        gateIds: legacyGates.filter((gate) => gate.phaseId === phaseId).map((gate) => gate.gateId),
      };
    }),
    gates: legacyGates,
    evidenceRequirements: EVALUATOR_PLAN.evidenceRequirements.map((requirement) => ({
      ...structuredClone(requirement),
      gateId: canonicalToLegacyGate.get(requirement.gateId) ?? requirement.gateId,
    })),
    requirementMappings: EVALUATOR_PLAN.requirementMappings.map((mapping) => ({
      ...structuredClone(mapping),
      gateIds: mapping.gateIds.map((gateId) => canonicalToLegacyGate.get(gateId) ?? gateId),
    })),
  };
  return projectLifecyclePlanCompatibility(historical);
}

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
      blockerGateId: 'gate-ctrl-testing-req-regression',
    });
    expect(result.blockerReason).toContain('evidence-testing');
    expect(result.blockerReason).toContain('focused tests failed');
    expect(result.nextSafeAction).toMatch(/Collect new automated validation evidence.*then re-evaluate/);
    expect(result.nextUnmetGate).toMatchObject({
      gateId: 'gate-ctrl-testing-req-regression',
      status: 'blocked',
    });
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
        passingEvidence('testing', {
          status: 'failed',
          failureReason: 'current validation failed',
        }),
      ],
      [],
      evaluatorRunState('testing'),
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
      evaluatorRunState('planning'),
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

  test('keeps host execution observations visible without letting them satisfy an unnamed gate', () => {
    const { gateId: _gateId, ...observation } = passingEvidence('testing');
    const result = evaluatePhase(
      EVALUATOR_PLAN,
      [observation],
      [],
      evaluatorRunState('testing'),
      EVALUATION_TIME,
    );

    expect(result.evidence).toEqual([expect.objectContaining({
      gateId: null,
      valid: true,
      satisfiesGate: false,
      invalidReasons: [],
    })]);
    expect(result.gates[0]?.status).toBe('not_started');
  });

  test('rejects a gate-scoped observation when its gate is absent from the current plan', () => {
    const result = evaluatePhase(
      EVALUATOR_PLAN,
      [{ ...passingEvidence('testing'), gateId: 'removed-gate' }],
      [],
      evaluatorRunState('testing'),
      EVALUATION_TIME,
    );

    expect(result.status).not.toBe('passed');
    expect(result.gates.some((gate) => gate.evidenceIds.includes('evidence-validation')) || result.gates.some((gate) => gate.evidenceIds.includes('evidence-testing'))).toBe(false);
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
      fixture.decisions,
      evaluatorRunState('testing'),
      EVALUATION_TIME,
    );
    expect(result.status).toBe('passed');
    expect(result.evidence.filter((item) => item.normalizedOutcome === 'warning'))
      .toEqual([expect.objectContaining({ valid: true, satisfiesGate: false })]);
  });

  test('a newer same-source same-SHA observation supersedes an older pass without deleting history', () => {
    const oldPass = passingEvidence('testing', {
      evidenceId: 'github-pr-old-pass',
      source: 'github_check:github-pr-delivery',
      collectedAt: '2026-07-15T10:00:00.000Z',
      sequence: '100',
    });
    const regression = passingEvidence('testing', {
      evidenceId: 'github-pr-current-regression',
      source: 'github_check:github-pr-delivery',
      collectedAt: '2026-07-15T10:05:00.000Z',
      sequence: '101',
      status: 'unknown',
    });
    const result = evaluatePhase(
      EVALUATOR_PLAN,
      [oldPass, regression],
      [],
      evaluatorRunState('testing'),
      EVALUATION_TIME,
    );
    expect(result.status).toBe('in_progress');
    expect(result.evidence).toHaveLength(2);
    expect(result.gates[0].evidenceIds).toEqual(['github-pr-current-regression']);
  });

  test('stales evidence collected under a superseded gate policy without deleting it', () => {
    const result = evaluatePhase(
      EVALUATOR_PLAN,
      [passingEvidence('planning', { policyVersion: 'fixture-policy-superseded' })],
      [],
      evaluatorRunState('planning'),
      EVALUATION_TIME,
    );
    expect(result.status).toBe('stale');
    expect(result.evidence[0]).toMatchObject({
      valid: false,
      invalidReasons: ['policy_version_mismatch'],
    });
  });
  test('rejects a policy approval issued for a different compiled plan', () => {
    const result = evaluatePhase(
      EVALUATOR_PLAN,
      [passingEvidence('design')],
      [approvalDecision('design', { planId: 'plan-superseded' })],
      evaluatorRunState('design'),
      EVALUATION_TIME,
    );
    expect(result.status).toBe('stale');
    expect(result.decisions[0]).toMatchObject({
      valid: false,
      active: false,
      invalidReasons: ['plan_identity_mismatch'],
    });
  });


  test('treats an expired required approval as stale rather than approved', () => {
    const result = evaluatePhase(
      EVALUATOR_PLAN,
      [passingEvidence('design')],
      [approvalDecision('design', { expiresAt: '2026-07-15T11:00:00.000Z' })],
      evaluatorRunState('design'),
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
    expect(dependencies.testing).toContain('gate:gate-ctrl-requirements-complete-verifiable');
    expect(dependencies.testing).toContain('gate:gate-ctrl-testing-req-regression');
    expect(dependencies.deployment).toContain('subject:artifact_digest');
    expect(dependencies.development).not.toContain('gate:gate-ctrl-testing-req-regression');
  });

  test('stales only dependent downstream phases and leaves sibling evidence valid', () => {
    const runState = {
      ...evaluatorRunState(),
      changedGateIds: ['gate-ctrl-testing-req-regression'],
    };
    const result = evaluateLifecycle(
      EVALUATOR_PLAN,
      COMPLETE_EVIDENCE,
      COMPLETE_DECISIONS,
      runState,
      EVALUATION_TIME,
    );
    const statuses = Object.fromEntries(result.phases.map((phase) => [phase.phaseId, phase.status]));

    expect(statuses.testing).toBe('stale');
    expect(statuses.deployment).toBe('stale');
    expect(statuses.planning).toBe('passed');
    expect(statuses.requirements).toBe('passed');
    expect(statuses.design).toBe('passed');
    expect(statuses.development).toBe('passed');
    expect(statuses.maintenance).toBe('passed');
    // req-regression lives in the merged testing phase, so its change stales
    // the whole phase — sibling testing evidence is stale alongside it.
    const siblingEvidence = result.phases.find((phase) => phase.phaseId === 'testing')!.evidence
      .find((evidence) => evidence.gateId === 'gate-ctrl-testing-threat-authz-secrets');
    expect(siblingEvidence?.valid).toBe(false);
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

    expect(statuses.deployment).toBe('stale');
    expect(statuses.testing).toBe('passed');
    expect(statuses.planning).toBe('passed');
    expect(statuses.requirements).toBe('passed');
    expect(statuses.design).toBe('passed');
    expect(statuses.development).toBe('passed');
    expect(statuses.maintenance).toBe('passed');
  });

  test('preserves gate-specific lineage requirements inside canonical deployment', () => {
    const deploymentGates = EVALUATOR_PLAN.gates.filter((gate) => gate.phaseId === 'deployment');
    const deploymentGateIds = new Set(deploymentGates.map((gate) => gate.gateId));
    const productionGateIds = new Set(deploymentGates
      .filter((gate) => gate.subjectRevisionRequirement === 'current_deployment')
      .map((gate) => gate.gateId));
    const evidence = COMPLETE_EVIDENCE.map((item) =>
      item.gateId && deploymentGateIds.has(item.gateId)
        ? { ...item, releaseLineage: { commitSha: COMMIT_SUBJECT.value, artifactDigest: ARTIFACT_SUBJECT.value } }
        : item);
    const result = evaluatePhase(
      EVALUATOR_PLAN,
      evidence,
      COMPLETE_DECISIONS,
      evaluatorRunState('deployment'),
      EVALUATION_TIME,
    );
    for (const projected of result.evidence.filter((item) =>
      item.gateId !== null && deploymentGateIds.has(item.gateId))) {
      if (productionGateIds.has(projected.gateId!)) {
        expect(projected).toMatchObject({ valid: false, invalidReasons: ['lineage_mismatch'] });
      } else {
        expect(projected).toMatchObject({ valid: true, invalidReasons: [] });
      }
    }
  });

  test('does not accept commit-only evidence for a compatibility-projected merge gate', () => {
    const projectedPlan = compatibilityProjectedEvaluatorPlan();
    const mergeGateId = LEGACY_GATE_TO_CANONICAL_GATE['gate-ctrl-merge-evidence-complete'];
    const mergeGate = projectedPlan.gates.find((gate) => gate.gateId === mergeGateId)!;
    expect(mergeGate).toMatchObject({
      phaseId: 'deployment',
      subjectRevisionRequirement: 'current_commit',
    });
    const evidence = COMPLETE_EVIDENCE.map((item) => item.gateId === mergeGate.gateId
      ? {
        ...item,
        subjectRevision: COMMIT_SUBJECT,
        releaseLineage: { commitSha: COMMIT_SUBJECT.value },
      }
      : item);
    const result = evaluatePhase(
      projectedPlan, evidence, COMPLETE_DECISIONS,
      evaluatorRunState('deployment'), EVALUATION_TIME,
    );
    expect(result.evidence.find((item) => item.gateId === mergeGate.gateId))
      .toMatchObject({ valid: false, invalidReasons: ['lineage_mismatch'] });
  });

  test('does not let memory closeout observations satisfy maintenance measurement gates', () => {
    const maintenanceGate = EVALUATOR_PLAN.gates.find((gate) =>
      gate.gateId === 'gate-ctrl-maintenance-outcome-metrics')!;
    const evidence = COMPLETE_EVIDENCE.map((item) => item.gateId === maintenanceGate.gateId
      ? { ...item, classification: 'memory_closeout' as const }
      : item);
    const result = evaluatePhase(
      EVALUATOR_PLAN, evidence, COMPLETE_DECISIONS,
      evaluatorRunState('maintenance'), EVALUATION_TIME,
    );
    expect(result.evidence.find((item) => item.gateId === maintenanceGate.gateId))
      .toMatchObject({ valid: false, invalidReasons: ['classification_mismatch'] });
  });
});

describe('dispositions, shared counts, and snapshot consistency', () => {
  test('excludes deferred and not-applicable phases with rationale and active provenance', () => {
    const plan = structuredClone(EVALUATOR_PLAN);
    const deferredReference = `DEC-sha256:${'d'.repeat(64)}`;
    plan.phases.find((phase) => phase.phaseId === 'testing')!.disposition = {
      disposition: 'deferred',
      rationale: 'Security review is deferred by an expiring governed decision.',
      approvalReference: deferredReference,
      expiryPolicy: 'until 2026-07-20',
    };
    plan.phases.find((phase) => phase.phaseId === 'deployment')!.disposition = {
      disposition: 'not_applicable',
      rationale: 'This delivery has no staging environment.',
    };
    const deferral: PhaseDecision = {
      ...approvalDecision('testing'),
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
    const security = result.phases.find((phase) => phase.phaseId === 'testing')!;
    const staging = result.phases.find((phase) => phase.phaseId === 'deployment')!;

    expect(security).toMatchObject({ status: 'deferred', excluded: true });
    expect(security.rationale).toContain('deferred');
    expect(security.decisionProvenance).toMatchObject({
      source: 'governed_decision', decisionId: deferredReference, active: true,
    });
    expect(staging).toMatchObject({ status: 'not_applicable', excluded: true });
    expect(staging.decisionProvenance).toMatchObject({ source: 'compiled_plan', active: true });
    expect(result.counts).toMatchObject({ total: 7, excluded: 2, denominator: 5, passed: 5 });
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
