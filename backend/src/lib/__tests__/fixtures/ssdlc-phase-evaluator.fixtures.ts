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
import { compileLifecyclePlan } from '../../ssdlc-plan-compiler';

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

export const EVALUATOR_PLAN: LifecyclePlan = compileLifecyclePlan({
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
  compilerVersion: 'ssdlc-plan-compiler-1',
  policyVersion: 'fixture-policy-1',
  compiledAt: '2026-07-14T12:00:00.000Z',
}).plan;

function subjectForPhase(phaseId: PhaseId): ReleaseSubject {
  if (['intake', 'requirements', 'architecture'].includes(phaseId)) return SPEC_SUBJECT;
  if (['implementation', 'validation', 'security', 'merge'].includes(phaseId)) return COMMIT_SUBJECT;
  if (['staging', 'qa'].includes(phaseId)) return ARTIFACT_SUBJECT;
  return DEPLOYMENT_SUBJECT;
}

export function evaluatorRunState(phaseId: PhaseId = 'intake'): PhaseEvaluationRunState {
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

export function passingEvidence(phaseId: PhaseId, overrides: Partial<PhaseEvidence> = {}): PhaseEvidence {
  const gate = EVALUATOR_PLAN.gates.find((candidate) => candidate.phaseId === phaseId)!;
  const requirement = EVALUATOR_PLAN.evidenceRequirements.find((candidate) =>
    candidate.evidenceRequirementId === gate.evidenceRequirementIds[0])!;
  return {
    evidenceId: `evidence-${phaseId}`,
    gateId: gate.gateId,
    source: 'ci',
    collectedAt: '2026-07-15T10:00:00.000Z',
    subjectRevision: subjectForPhase(phaseId),
    policyVersion: EVALUATOR_PLAN.policyVersion,
    compilerVersion: EVALUATOR_PLAN.compilerVersion,
    status: 'passed',
    classification: requirement.classification,
    trustLevel: requirement.minimumTrustLevel,
    evidenceRequirementIds: [...gate.evidenceRequirementIds],
    dependencyReferences: [],
    ...(phaseId === 'staging' || phaseId === 'qa' || phaseId === 'merge' || phaseId === 'production'
      ? { releaseLineage: evaluatorRunState().releaseLineage }
      : {}),
    ...overrides,
  };
}

export function approvalDecision(phaseId: PhaseId, overrides: Partial<PhaseDecision> = {}): PhaseDecision {
  const gate = EVALUATOR_PLAN.gates.find((candidate) => candidate.phaseId === phaseId)!;
  return {
    decisionId: `decision-${phaseId}`,
    phaseId,
    gateId: gate.gateId,
    decisionType: gate.approvalRequirement === 'human' ? 'human_approval' : 'policy_approval',
    outcome: 'approved',
    subjectRevision: subjectForPhase(phaseId),
    policyVersion: EVALUATOR_PLAN.policyVersion,
    compilerVersion: EVALUATOR_PLAN.compilerVersion,
    decidedAt: '2026-07-15T10:30:00.000Z',
    rationale: `${gate.approvalRequirement} approval is evidence-backed.`,
    provenance: { adapter: 'fixture-review', immutable: true },
    ...overrides,
  };
}

export const COMPLETE_EVIDENCE: PhaseEvidence[] = EVALUATOR_PLAN.phaseOrder.map((phaseId) => passingEvidence(phaseId));
export const COMPLETE_DECISIONS: PhaseDecision[] = EVALUATOR_PLAN.gates
  .filter((gate) => gate.approvalRequirement !== 'none')
  .map((gate) => approvalDecision(gate.phaseId));

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
    phaseId: 'intake',
    evidence: [{ agentText: 'done', processExitCode: 0, cleanWorktree: true, uiState: 'passed' }],
    decisions: [],
    expectedStatus: 'in_progress',
  },
  {
    name: 'partial_gates',
    phaseId: 'validation',
    evidence: [passingEvidence('requirements')],
    decisions: [],
    expectedStatus: 'in_progress',
  },
  {
    name: 'blocker_required',
    phaseId: 'validation',
    evidence: [
      passingEvidence('requirements'),
      passingEvidence('validation', { status: 'story_caused_failure', failureReason: 'focused tests failed' }),
    ],
    decisions: [],
    expectedStatus: 'blocked',
  },
  {
    name: 'warning_only_baseline',
    phaseId: 'validation',
    evidence: [
      passingEvidence('requirements'),
      passingEvidence('validation'),
      passingEvidence('validation', {
        evidenceId: 'evidence-validation-baseline-warning',
        status: 'unrelated_baseline',
        failureReason: 'pre-existing browser warning',
      }),
    ],
    decisions: [],
    expectedStatus: 'passed',
  },
  {
    name: 'approval_waiting',
    phaseId: 'architecture',
    evidence: [passingEvidence('architecture')],
    decisions: [],
    expectedStatus: 'awaiting_approval',
  },
  {
    name: 'revision_mismatch',
    phaseId: 'intake',
    evidence: [passingEvidence('intake', {
      subjectRevision: { type: 'spec_hash', value: `sha256:${'9'.repeat(64)}` },
    })],
    decisions: [],
    expectedStatus: 'stale',
  },
  {
    name: 'expired_evidence',
    phaseId: 'intake',
    evidence: [passingEvidence('intake', { expiresAt: '2026-07-15T11:00:00.000Z' })],
    decisions: [],
    expectedStatus: 'stale',
  },
  {
    name: 'revoked_decision',
    phaseId: 'architecture',
    evidence: [passingEvidence('architecture')],
    decisions: [approvalDecision('architecture', { revokedAt: '2026-07-15T11:00:00.000Z' })],
    expectedStatus: 'stale',
  },
  {
    name: 'complete_release',
    phaseId: 'production',
    evidence: COMPLETE_EVIDENCE,
    decisions: COMPLETE_DECISIONS,
    expectedStatus: 'passed',
  },
];

/** Named delivery-state fixtures used by route/UI contracts and evaluator regressions. */
export const LIFECYCLE_DELIVERY_FIXTURES: EvaluatorFixture[] = [
  {
    name: 'blocked_validation_2_of_4',
    phaseId: 'validation',
    evidence: [
      passingEvidence('requirements'),
      passingEvidence('validation'),
      passingEvidence('validation', {
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
    phaseId: 'validation',
    evidence: [passingEvidence('validation', {
      subjectRevision: { type: 'commit_sha', value: 'f'.repeat(40) },
    })],
    decisions: [],
    expectedStatus: 'stale',
  },
  {
    name: 'approved_qa',
    phaseId: 'qa',
    evidence: COMPLETE_EVIDENCE,
    decisions: COMPLETE_DECISIONS,
    expectedStatus: 'passed',
  },
  {
    name: 'merge_ready',
    phaseId: 'merge',
    evidence: COMPLETE_EVIDENCE,
    decisions: COMPLETE_DECISIONS,
    expectedStatus: 'passed',
  },
  {
    name: 'production_awaiting_approval',
    phaseId: 'production',
    evidence: COMPLETE_EVIDENCE,
    decisions: COMPLETE_DECISIONS.filter((decision) => decision.phaseId !== 'production'),
    expectedStatus: 'awaiting_approval',
  },
];
