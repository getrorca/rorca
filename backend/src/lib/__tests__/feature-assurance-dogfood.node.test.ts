/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assuranceScopeIdentity, type AssuranceCandidateInput, type AssuranceCandidateIdentity } from '../assurance-candidate';
import {
  compileFeatureAssuranceDogfood,
  type AssuranceDogfoodAttemptInput,
  type AssuranceEvidenceObservationInput,
  type AssuranceObligationInput,
  type FeatureAssuranceDogfoodInput,
} from '../feature-assurance-dogfood';

const GENERATED_AT = '2026-08-19T15:00:00.000Z';
const CURRENT_OBSERVATION = '2026-08-19T14:59:00.000Z';
const STALE_OBSERVATION = '2026-08-19T12:00:00.000Z';
const HASH = `sha256:${'a'.repeat(64)}`;
const FEATURE = {
  featureId: 'feature:assurance-dogfood',
  specificationRevision: {
    specId: 'rorca-spec-aligned-feature-assurance-ssdlc',
    revision: 'revision:AFM-007:1',
  },
  featureRevisionHash: `sha256:${'b'.repeat(64)}`,
};
const PLAN = {
  planId: 'plan:feature-assurance',
  planVersion: 7,
  planHash: `sha256:${'c'.repeat(64)}`,
};
const SCOPE = {
  workPackageId: 'WP-AFM-007',
  workPackageRevision: 1,
  workPackageHash: `sha256:${'d'.repeat(64)}`,
  changedPaths: ['backend/src/lib/feature-assurance-dogfood.ts'],
  requiredPaths: ['backend/src/lib/feature-assurance-dogfood.ts'],
  allowedPaths: ['backend/src/lib'],
  forbiddenPaths: ['backend/src/routes'],
};
const IDENTITY: AssuranceCandidateIdentity = {
  specificationRevision: FEATURE.specificationRevision,
  plan: { planId: PLAN.planId, planVersion: PLAN.planVersion },
  commit: '0123456789abcdef0123456789abcdef01234567',
  tree: '1123456789abcdef0123456789abcdef01234567',
  diff: `sha256:${'e'.repeat(64)}`,
  scope: assuranceScopeIdentity(SCOPE),
};
const CANDIDATE: AssuranceCandidateInput = {
  candidateId: 'candidate:AFM-007',
  identity: IDENTITY,
  scope: SCOPE,
};

function obligation(obligationId: string): AssuranceObligationInput {
  return {
    obligationId,
    kind: 'host-validation',
    required: true,
    description: `Required evidence for ${obligationId}.`,
    evidenceRecordType: 'evidence',
  };
}

function observation(input: {
  observationId: string;
  obligationId: string;
  attemptId?: string;
  evaluation?: AssuranceEvidenceObservationInput['evaluation'];
  observedAt?: string;
  subject?: Partial<AssuranceCandidateIdentity> | null;
}): AssuranceEvidenceObservationInput {
  return {
    observationId: input.observationId,
    attemptId: input.attemptId ?? 'attempt:complete',
    obligationId: input.obligationId,
    subject: input.subject === undefined ? IDENTITY : input.subject,
    evidence: {
      evidenceId: `evidence:${input.observationId}`,
      href: `rorca://evidence/${input.observationId}`,
      digest: HASH,
    },
    evaluation: input.evaluation ?? 'accepted',
    evaluatorId: 'host:rorca-dogfood',
    observedAt: input.observedAt ?? CURRENT_OBSERVATION,
    detail: `Immutable observation ${input.observationId}.`,
  };
}

function attempt(overrides: Partial<AssuranceDogfoodAttemptInput> = {}): AssuranceDogfoodAttemptInput {
  const attemptId = overrides.attemptId ?? 'attempt:complete';
  return {
    attemptId,
    sequence: overrides.sequence ?? 1,
    candidateId: overrides.candidateId ?? CANDIDATE.candidateId,
    state: overrides.state ?? 'complete',
    observationIds: overrides.observationIds ?? ['observation:requirements', 'observation:validation'],
    recoveryDecision: overrides.recoveryDecision ?? {
      recoveryDecisionId: 'recovery:initial',
      attemptId,
      kind: 'initial',
      decision: 'start_initial_attempt',
      priorAttemptId: null,
      recordedAt: '2026-08-19T14:55:00.000Z',
      rationale: 'Start the dogfood attempt from the bound candidate.',
    },
  };
}

function completeInput(): FeatureAssuranceDogfoodInput {
  const observations = [
    observation({ observationId: 'observation:requirements', obligationId: 'OBL:REQUIREMENTS' }),
    observation({ observationId: 'observation:validation', obligationId: 'OBL:VALIDATION' }),
  ];
  return {
    generatedAt: GENERATED_AT,
    maximumEvidenceAgeSeconds: 300,
    feature: FEATURE,
    plan: PLAN,
    candidate: CANDIDATE,
    obligations: [obligation('OBL:REQUIREMENTS'), obligation('OBL:VALIDATION')],
    observations,
    attempts: [attempt()],
    incidents: [{
      incidentId: 'incident:dogfood-flake',
      observationId: 'observation:validation',
      occurredAt: CURRENT_OBSERVATION,
      severity: 'medium',
      summary: 'A transient validation failure was observed and later resolved.',
    }],
    priorTrendSnapshots: [{
      snapshotId: 'trend:prior',
      featureId: FEATURE.featureId,
      recordedAt: '2026-08-18T15:00:00.000Z',
      totalRequired: 2,
      satisfied: 1,
      unresolved: 1,
    }],
    upstreamLifecycleFacts: {
      storyStatus: 'implemented',
      mergeStatus: 'not_merged',
      productionStatus: 'not_deployed',
      revision: FEATURE.specificationRevision.revision,
      nested: { immutable: true },
    },
  };
}

describe('Feature Assurance dogfood handoff', () => {
  it('emits a revision-bound AssuredCandidate with complete evidence and no authority', () => {
    const input = completeInput();
    const result = compileFeatureAssuranceDogfood(input);

    assert.equal(result.schemaVersion, 'rorca.assured-candidate.v1');
    assert.match(result.handoffId, /^sha256:[0-9a-f]{64}$/);
    assert.match(result.revisionBindingHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(result.outcome, 'all_satisfied');
    assert.equal(result.allSatisfied, true);
    assert.equal(result.selectedAttemptId, 'attempt:complete');
    assert.deepEqual(result.boundFeature, FEATURE);
    assert.deepEqual(result.boundPlan, PLAN);
    assert.equal(result.candidate.candidateId, CANDIDATE.candidateId);
    assert.deepEqual(result.obligations.map(({ obligationId, outcome }) => ({ obligationId, outcome })), [
      { obligationId: 'OBL:REQUIREMENTS', outcome: 'satisfied' },
      { obligationId: 'OBL:VALIDATION', outcome: 'satisfied' },
    ]);
    assert.equal(result.evidenceLinks.length, 2);
    assert.ok(result.evidenceLinks.every((link) => link.eligibleForSatisfaction));
    assert.ok(result.evaluationOutcomes.every((evaluation) => evaluation.outcome === 'satisfied'));
    assert.deepEqual(result.unresolvedFindings, []);
    assert.deepEqual(result.freshness, {
      asOf: GENERATED_AT,
      maximumEvidenceAgeSeconds: 300,
      overall: 'current',
      currentObservationIds: ['observation:requirements', 'observation:validation'],
      staleObservationIds: [],
      unverifiableObservationIds: [],
    });
    assert.equal(result.assuranceTrends.direction, 'improving');
    assert.equal(result.assuranceTrends.current.satisfied, 2);
    assert.deepEqual(result.governedImprovementInputs[0], {
      improvementInputId: result.governedImprovementInputs[0]?.improvementInputId,
      sourceIncidentId: 'incident:dogfood-flake',
      sourceObservationId: 'observation:validation',
      sourceObservationHash: result.immutableObservations[1]?.observationHash,
      route: 'assurance-governance-review',
      governanceState: 'pending_governance',
      authority: 'none',
      lifecycleMutation: false,
    });
    assert.deepEqual(result.upstreamLifecycleFacts, input.upstreamLifecycleFacts);
    assert.deepEqual(result.authority, {
      dataProduct: 'read_only', lifecycle: 'none', merge: 'none', production: 'none', governanceBypass: false,
    });
    assert.deepEqual(result.effects, {
      lifecycleStatusChanged: false, codeMerged: false, productionActionPerformed: false, governanceBypassed: false,
    });
  });

  it('records missing, stale, rejected, and insufficient obligations as a non-all-satisfied outcome', () => {
    const input = completeInput();
    input.obligations = [
      obligation('OBL:MISSING'),
      obligation('OBL:STALE'),
      obligation('OBL:REJECTED'),
      obligation('OBL:INSUFFICIENT'),
    ];
    input.observations = [
      observation({ observationId: 'observation:stale', obligationId: 'OBL:STALE', observedAt: STALE_OBSERVATION }),
      observation({ observationId: 'observation:rejected', obligationId: 'OBL:REJECTED', evaluation: 'rejected' }),
      observation({ observationId: 'observation:insufficient', obligationId: 'OBL:INSUFFICIENT', evaluation: 'insufficient' }),
    ];
    input.attempts = [attempt({
      observationIds: ['observation:stale', 'observation:rejected', 'observation:insufficient'],
    })];
    input.incidents = [];

    const result = compileFeatureAssuranceDogfood(input);
    assert.equal(result.outcome, 'not_all_satisfied');
    assert.equal(result.allSatisfied, false);
    assert.deepEqual(Object.fromEntries(result.obligations.map((item) => [item.obligationId, item.outcome])), {
      'OBL:MISSING': 'missing',
      'OBL:STALE': 'stale',
      'OBL:REJECTED': 'rejected',
      'OBL:INSUFFICIENT': 'insufficient',
    });
    assert.deepEqual(new Set(result.unresolvedFindings.map((finding) => finding.code)), new Set([
      'obligation:missing', 'obligation:stale', 'obligation:rejected', 'obligation:insufficient',
    ]));
    assert.equal(result.freshness.overall, 'stale');
    assert.deepEqual(result.freshness.staleObservationIds, ['observation:stale']);
  });

  it('is byte-stable on replay and returns immutable snapshots without freezing caller inputs', () => {
    const input = completeInput();
    input.attempts = [attempt({
      recoveryDecision: {
        recoveryDecisionId: 'recovery:replay',
        attemptId: 'attempt:complete',
        kind: 'replay',
        decision: 'reuse_complete_attempt',
        priorAttemptId: 'attempt:complete',
        recordedAt: '2026-08-19T14:59:30.000Z',
        rationale: 'Reuse the already complete immutable attempt.',
      },
    })];

    const first = compileFeatureAssuranceDogfood(input);
    const replay = compileFeatureAssuranceDogfood(input);
    assert.deepEqual(replay, first);
    assert.equal(replay.attemptHistory[0]?.recoveryDecision.kind, 'replay');
    assert.equal(replay.attemptHistory[0]?.recoveryDecision.decision, 'reuse_complete_attempt');
    assert.ok(Object.isFrozen(replay));
    assert.ok(Object.isFrozen(replay.immutableObservations[0]));
    assert.ok(Object.isFrozen(replay.upstreamLifecycleFacts.nested));
    assert.equal(Object.isFrozen(input.upstreamLifecycleFacts), false);
    assert.equal(Object.isFrozen(input.observations[0]), false);
  });

  it('preserves a partial attempt across restart but satisfies obligations only from the new complete attempt', () => {
    const input = completeInput();
    const partialObservation = observation({
      observationId: 'observation:partial',
      obligationId: 'OBL:REQUIREMENTS',
      attemptId: 'attempt:partial',
    });
    input.observations = [partialObservation, ...input.observations];
    input.attempts = [
      attempt({
        attemptId: 'attempt:partial',
        sequence: 1,
        state: 'partial',
        observationIds: ['observation:partial'],
        recoveryDecision: {
          recoveryDecisionId: 'recovery:partial',
          attemptId: 'attempt:partial',
          kind: 'partial_failure',
          decision: 'retain_partial_attempt',
          priorAttemptId: null,
          recordedAt: '2026-08-19T14:56:00.000Z',
          rationale: 'Retain partial observations without promoting the attempt.',
        },
      }),
      attempt({
        sequence: 2,
        recoveryDecision: {
          recoveryDecisionId: 'recovery:restart',
          attemptId: 'attempt:complete',
          kind: 'restart',
          decision: 'start_new_attempt',
          priorAttemptId: 'attempt:partial',
          recordedAt: '2026-08-19T14:57:00.000Z',
          rationale: 'Restart with a new attempt and fresh evidence.',
        },
      }),
    ];

    const result = compileFeatureAssuranceDogfood(input);
    assert.equal(result.allSatisfied, true);
    assert.equal(result.selectedAttemptId, 'attempt:complete');
    assert.equal(result.immutableObservations.length, 3);
    assert.equal(result.attemptHistory[0]?.promotion, 'partial_not_promoted');
    assert.equal(result.attemptHistory[0]?.recoveryDecision.kind, 'partial_failure');
    assert.equal(result.attemptHistory[1]?.promotion, 'selected_complete');
    assert.equal(result.attemptHistory[1]?.recoveryDecision.kind, 'restart');
    assert.equal(
      result.evaluationOutcomes.find((evaluation) => evaluation.observationId === 'observation:partial')?.outcome,
      'ignored_non_selected_attempt',
    );
    assert.equal(result.evidenceLinks.find((link) => link.observationId === 'observation:partial')?.eligibleForSatisfaction, false);
  });

  it('never promotes a partial-failure attempt even when its observations would otherwise satisfy every obligation', () => {
    const input = completeInput();
    input.observations = input.observations.map((item) => ({ ...item, attemptId: 'attempt:partial-only' }));
    input.attempts = [attempt({
      attemptId: 'attempt:partial-only',
      state: 'partial',
      recoveryDecision: {
        recoveryDecisionId: 'recovery:partial-only',
        attemptId: 'attempt:partial-only',
        kind: 'partial_failure',
        decision: 'retain_partial_attempt',
        priorAttemptId: null,
        recordedAt: '2026-08-19T14:59:30.000Z',
        rationale: 'Retain immutable observations and refuse partial promotion.',
      },
    })];

    const result = compileFeatureAssuranceDogfood(input);
    assert.equal(result.selectedAttemptId, null);
    assert.equal(result.allSatisfied, false);
    assert.equal(result.outcome, 'not_all_satisfied');
    assert.ok(result.obligations.every((item) => item.outcome === 'missing'));
    assert.ok(result.evaluationOutcomes.every((item) => item.outcome === 'ignored_non_selected_attempt'));
    assert.equal(result.attemptHistory[0]?.promotion, 'partial_not_promoted');
    assert.equal(result.attemptHistory[0]?.recoveryDecision.kind, 'partial_failure');
    assert.ok(result.unresolvedFindings.some((finding) => finding.code === 'attempt:no-complete-attempt'));
  });

  it('never promotes a complete-labeled attempt whose recovery decision retains a partial attempt', () => {
    const input = completeInput();
    input.attempts = [attempt({
      recoveryDecision: {
        recoveryDecisionId: 'recovery:inconsistent-complete',
        attemptId: 'attempt:complete',
        kind: 'partial_failure',
        decision: 'retain_partial_attempt',
        priorAttemptId: null,
        recordedAt: '2026-08-19T14:59:30.000Z',
        rationale: 'Conflicting recovery metadata must fail closed.',
      },
    })];

    const result = compileFeatureAssuranceDogfood(input);
    assert.equal(result.selectedAttemptId, null);
    assert.equal(result.allSatisfied, false);
    assert.equal(result.outcome, 'not_all_satisfied');
    assert.deepEqual(result.attemptHistory.map((item) => item.promotion), ['complete_not_selected']);
    assert.ok(result.unresolvedFindings.some((finding) =>
      finding.code === 'attempt:inconsistent-recovery-decision'));
  });

  it('fails closed on duplicate attempt identity without labeling the partial record as selected', () => {
    const input = completeInput();
    input.attempts = [
      attempt(),
      attempt({
        sequence: 2,
        state: 'partial',
        recoveryDecision: {
          recoveryDecisionId: 'recovery:duplicate-partial',
          attemptId: 'attempt:complete',
          kind: 'partial_failure',
          decision: 'retain_partial_attempt',
          priorAttemptId: 'attempt:complete',
          recordedAt: '2026-08-19T14:59:45.000Z',
          rationale: 'Retain the conflicting record for investigation without promotion.',
        },
      }),
    ];

    const result = compileFeatureAssuranceDogfood(input);
    assert.equal(result.selectedAttemptId, null);
    assert.equal(result.allSatisfied, false);
    assert.deepEqual(result.attemptHistory.map((item) => item.promotion), [
      'complete_not_selected',
      'partial_not_promoted',
    ]);
    assert.ok(result.unresolvedFindings.some((finding) => finding.code === 'attempt:duplicate-id'));
  });
});
