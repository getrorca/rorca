/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  type LifecyclePlan,
  type PhaseId,
  type ReleaseSubject,
} from '../../ssdlc-contracts';
import {
  type PhaseDecision,
  type PhaseEvaluationRunState,
  type PhaseEvidence,
} from '../../ssdlc-phase-evaluator';
import { compileLifecyclePlan, type AssembledLifecycleCompileInput } from '../../ssdlc-plan-compiler';

export const EVALUATION_TIME = new Date('2026-07-15T12:00:00.000Z');
export const SPEC_SUBJECT = {
  type: 'spec_hash',
  value: `sha256:${'2'.repeat(64)}`,
} as const satisfies ReleaseSubject;
export const COMMIT_SUBJECT = {
  type: 'commit_sha',
  value: 'a'.repeat(40),
} as const satisfies ReleaseSubject;
export const ARTIFACT_SUBJECT = {
  type: 'artifact_digest',
  value: `sha256:${'b'.repeat(64)}`,
} as const satisfies ReleaseSubject;
export const DEPLOYMENT_SUBJECT = {
  type: 'deployment_id',
  value: 'deployment-fixture-17',
} as const satisfies ReleaseSubject;

export const EVALUATOR_PLAN_SOURCE: AssembledLifecycleCompileInput = {
  schemaVersion: 1,
  workspaceId: 'workspace-evaluator',
  canonicalSpec: {
    specId: 'fixture-phase-evaluator',
    version: '17',
    contentHash: SPEC_SUBJECT.value,
    json: {
      tags: ['frontend'],
      userStories: [{
        id: 'LFC-006',
        title: 'Evaluate lifecycle phases',
        description: 'Derive lifecycle state from bounded evidence.',
        acceptanceCriteria: ['Every blocking gate uses current immutable evidence.'],
        tags: ['backend'],
        fileHints: ['backend/src/lib/ssdlc-phase-evaluator.ts'],
      }],
    },
  },
  workspaceTags: [],
  riskAssignments: [],
  ownerAssignments: [],
  policyAnnotations: [],
  compilerAnnotations: [],
  compilerVersion: 'ssdlc-plan-compiler-5',
  policyVersion: 'fixture-policy-1',
  compiledAt: '2026-07-14T12:00:00.000Z',
};

export const EVALUATOR_PLAN: LifecyclePlan = compileLifecyclePlan(EVALUATOR_PLAN_SOURCE).plan;

function subjectForGate(gate: LifecyclePlan['gates'][number]): ReleaseSubject {
  switch (gate.subjectRevisionRequirement) {
    case 'current_spec_revision': return SPEC_SUBJECT;
    case 'current_commit': return COMMIT_SUBJECT;
    case 'current_artifact': return ARTIFACT_SUBJECT;
    case 'current_deployment': return DEPLOYMENT_SUBJECT;
  }
}

export function evaluatorRunState(phaseId: PhaseId = 'planning'): PhaseEvaluationRunState {
  return {
    phaseId,
    activeReleaseSubject: DEPLOYMENT_SUBJECT,
    activeSubjects: {
      spec_hash: SPEC_SUBJECT,
      commit_sha: COMMIT_SUBJECT,
      artifact_digest: ARTIFACT_SUBJECT,
      deployment_id: DEPLOYMENT_SUBJECT,
    },
    releaseLineage: {
      commitSha: COMMIT_SUBJECT.value,
      artifactDigest: ARTIFACT_SUBJECT.value,
      deploymentId: DEPLOYMENT_SUBJECT.value,
      artifactCommitSha: COMMIT_SUBJECT.value,
      deploymentArtifactDigest: ARTIFACT_SUBJECT.value,
    },
    evidenceHighWaterMark: 'evidence-sequence-100',
    decisionHighWaterMark: 'decision-sequence-20',
    invalidations: [],
    changedGateIds: [],
    changedRequirementReferences: [],
    changedStoryReferences: [],
    changedSubjectTypes: [],
    inProgressGateIds: [],
  };
}

function passingEvidenceForGate(
  gate: LifecyclePlan['gates'][number],
  overrides: Partial<PhaseEvidence> = {},
): PhaseEvidence {
  const requirement = EVALUATOR_PLAN.evidenceRequirements.find((candidate) =>
    candidate.evidenceRequirementId === gate.evidenceRequirementIds[0])!;
  return {
    evidenceId: `evidence-${gate.gateId.replace(/^gate-/, '')}`,
    gateId: gate.gateId,
    source: 'ci',
    collectedAt: '2026-07-15T10:00:00.000Z',
    subjectRevision: subjectForGate(gate),
    policyVersion: EVALUATOR_PLAN.policyVersion,
    compilerVersion: EVALUATOR_PLAN.compilerVersion,
    status: 'passed',
    classification: requirement.classification,
    trustLevel: requirement.minimumTrustLevel,
    evidenceRequirementIds: [...gate.evidenceRequirementIds],
    dependencyReferences: [],
    ...(['deployment', 'testing', 'deployment', 'deployment'].includes(gate.phaseId)
      ? { releaseLineage: evaluatorRunState().releaseLineage }
      : {}),
    ...overrides,
  };
}

export function passingEvidence(phaseId: PhaseId, overrides: Partial<PhaseEvidence> = {}): PhaseEvidence {
  const gate = EVALUATOR_PLAN.gates.find((candidate) => candidate.phaseId === phaseId)!;
  return passingEvidenceForGate(gate, {
    evidenceId: `evidence-${phaseId}`,
    ...overrides,
  });
}

function passingPhaseEvidence(phaseId: PhaseId): PhaseEvidence[] {
  return EVALUATOR_PLAN.gates
    .filter((gate) => gate.phaseId === phaseId)
    .map((gate) => passingEvidenceForGate(gate));
}

function approvalDecisionForGate(
  gate: LifecyclePlan['gates'][number],
  overrides: Partial<PhaseDecision> = {},
): PhaseDecision {
  return {
    decisionId: `decision-${gate.gateId.replace(/^gate-/, '')}`,
    phaseId: gate.phaseId,
    gateId: gate.gateId,
    decisionType: gate.approvalRequirement === 'human' ? 'human_approval' : 'policy_approval',
    outcome: 'approved',
    subjectRevision: subjectForGate(gate),
    policyVersion: EVALUATOR_PLAN.policyVersion,
    compilerVersion: EVALUATOR_PLAN.compilerVersion,
    ...(gate.approvalRequirement === 'policy' ? { planId: EVALUATOR_PLAN.planId } : {}),
    decidedAt: '2026-07-15T10:30:00.000Z',
    rationale: `${gate.approvalRequirement} approval is evidence-backed.`,
    provenance: { adapter: 'fixture-review', immutable: true },
    ...overrides,
  };
}

export function approvalDecisionsForPhase(phaseId: PhaseId): PhaseDecision[] {
  const phaseGates = EVALUATOR_PLAN.gates.filter((candidate) => candidate.phaseId === phaseId);
  const approvalGates = phaseGates.filter((candidate) => candidate.approvalRequirement !== 'none');
  return (approvalGates.length > 0 ? approvalGates : phaseGates.slice(0, 1)).map((gate) =>
    approvalDecisionForGate(gate, { decisionId: `decision-${gate.gateId.replace(/^gate-/, '')}` }));
}

export function approvalDecision(phaseId: PhaseId, overrides: Partial<PhaseDecision> = {}): PhaseDecision {
  const phaseGates = EVALUATOR_PLAN.gates.filter((candidate) => candidate.phaseId === phaseId);
  const gate = phaseGates.find((candidate) => candidate.approvalRequirement !== 'none') ?? phaseGates[0]!;
  return approvalDecisionForGate(gate, {
    decisionId: `decision-${phaseId}`,
    ...overrides,
  });
}

export const COMPLETE_EVIDENCE: PhaseEvidence[] = EVALUATOR_PLAN.gates.map((gate) =>
  passingEvidenceForGate(gate));
export const COMPLETE_DECISIONS: PhaseDecision[] = EVALUATOR_PLAN.gates
  .filter((gate) => gate.approvalRequirement !== 'none')
  .map((gate) => approvalDecisionForGate(gate));

export type EvaluatorFixtureName =
  | 'no_evidence'
  | 'partial_gates'
  | 'blocker_required'
  | 'warning_only_baseline'
  | 'approval_waiting'
  | 'revision_mismatch'
  | 'expired_evidence'
  | 'revoked_decision'
  | 'complete_release'
  | 'blocked_validation_2_of_4'
  | 'stale_revision'
  | 'approved_qa'
  | 'merge_ready'
  | 'production_awaiting_approval';

export interface EvaluatorFixture {
  name: EvaluatorFixtureName;
  phaseId: PhaseId;
  evidence: unknown[];
  decisions: unknown[];
  expectedStatus: string;
}

export const PHASE_EVALUATOR_FIXTURES: EvaluatorFixture[] = [
  {
    name: 'no_evidence',
    phaseId: 'planning',
    evidence: [{ agentText: 'done', processExitCode: 0, cleanWorktree: true, uiState: 'passed' }],
    decisions: [],
    expectedStatus: 'in_progress',
  },
  {
    name: 'partial_gates',
    phaseId: 'testing',
    evidence: [
      ...passingPhaseEvidence('requirements'),
      passingEvidence('testing'),
    ],
    decisions: [],
    expectedStatus: 'in_progress',
  },
  {
    name: 'blocker_required',
    phaseId: 'testing',
    evidence: [
      ...passingPhaseEvidence('planning'),
      ...passingPhaseEvidence('requirements'),
      ...passingPhaseEvidence('design'),
      ...passingPhaseEvidence('development'),
      passingEvidence('testing', { status: 'story_caused_failure', failureReason: 'focused tests failed' }),
    ],
    decisions: [
      ...approvalDecisionsForPhase('planning'),
      ...approvalDecisionsForPhase('design'),
    ],
    expectedStatus: 'blocked',
  },
  {
    name: 'warning_only_baseline',
    phaseId: 'testing',
    evidence: [
      ...passingPhaseEvidence('planning'),
      ...passingPhaseEvidence('requirements'),
      ...passingPhaseEvidence('design'),
      ...passingPhaseEvidence('development'),
      ...passingPhaseEvidence('testing'),
      passingEvidence('testing', {
        evidenceId: 'evidence-testing-baseline-warning',
        status: 'unrelated_baseline',
        failureReason: 'pre-existing browser warning',
      }),
    ],
    decisions: [
      ...approvalDecisionsForPhase('planning'),
      ...approvalDecisionsForPhase('design'),
      ...approvalDecisionsForPhase('testing'),
    ],
    expectedStatus: 'passed',
  },
  {
    name: 'approval_waiting',
    phaseId: 'design',
    evidence: passingPhaseEvidence('design'),
    decisions: [],
    expectedStatus: 'awaiting_approval',
  },
  {
    name: 'revision_mismatch',
    phaseId: 'planning',
    evidence: [passingEvidence('planning', {
      subjectRevision: { type: 'spec_hash', value: `sha256:${'9'.repeat(64)}` },
    })],
    decisions: [],
    expectedStatus: 'stale',
  },
  {
    name: 'expired_evidence',
    phaseId: 'planning',
    evidence: [passingEvidence('planning', { expiresAt: '2026-07-15T11:00:00.000Z' })],
    decisions: [],
    expectedStatus: 'stale',
  },
  {
    name: 'revoked_decision',
    phaseId: 'design',
    evidence: [passingEvidence('design')],
    decisions: [approvalDecision('design', { revokedAt: '2026-07-15T11:00:00.000Z' })],
    expectedStatus: 'stale',
  },
  {
    name: 'complete_release',
    phaseId: 'deployment',
    evidence: COMPLETE_EVIDENCE,
    decisions: COMPLETE_DECISIONS,
    expectedStatus: 'passed',
  },
];

/** Named delivery-state fixtures used by route/UI contracts and evaluator regressions. */
export const LIFECYCLE_DELIVERY_FIXTURES: EvaluatorFixture[] = [
  {
    name: 'blocked_validation_2_of_4',
    phaseId: 'testing',
    evidence: [
      passingEvidence('requirements'),
      passingEvidence('testing'),
      passingEvidence('testing', {
        evidenceId: 'evidence-validation-failed',
        status: 'story_caused_failure',
        failureReason: 'Two of four required validation observations are blocked.',
      }),
      { agentText: 'forged fourth validation', processExitCode: 0 },
    ],
    decisions: [],
    expectedStatus: 'blocked',
  },
  {
    name: 'stale_revision',
    phaseId: 'testing',
    evidence: [passingEvidence('testing', {
      subjectRevision: { type: 'commit_sha', value: 'f'.repeat(40) },
    })],
    decisions: [],
    expectedStatus: 'stale',
  },
  {
    name: 'approved_qa',
    phaseId: 'testing',
    evidence: COMPLETE_EVIDENCE,
    decisions: COMPLETE_DECISIONS,
    expectedStatus: 'passed',
  },
  {
    name: 'merge_ready',
    phaseId: 'deployment',
    evidence: COMPLETE_EVIDENCE,
    decisions: COMPLETE_DECISIONS,
    expectedStatus: 'passed',
  },
  {
    name: 'production_awaiting_approval',
    phaseId: 'deployment',
    evidence: COMPLETE_EVIDENCE,
    decisions: COMPLETE_DECISIONS.filter((decision) => decision.phaseId !== 'deployment'),
    expectedStatus: 'awaiting_approval',
  },
];
