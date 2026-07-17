/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Pure, derive-on-read SSDLC phase evaluation.
 *
 * The caller owns snapshot-bounded I/O. This module owns parsing, evidence and
 * decision validity, dependency-scoped invalidation, status precedence, and
 * summary counts. It never reads or mutates persistence records.
 */

import crypto from 'node:crypto';
import { z } from 'zod';
import {
  EvidenceClassificationSchema,
  EvidenceTrustLevelSchema,
  LifecyclePlanSchema,
  PhaseIdSchema,
  ReleaseSubjectSchema,
  ReleaseSubjectTypeSchema,
  deriveEvaluationSnapshotIdentity,
  normalizeSsdlcContractJson,
  type EvaluatedStatus,
  type EvaluationSnapshotIdentity,
  type LifecyclePlan,
  type PhaseDisposition,
  type PhaseId,
  type ReleaseSubject,
  type ReleaseSubjectType,
} from './ssdlc-contracts';

const TimestampSchema = z.union([
  z.date(),
  z.string().datetime({ offset: true }),
]).transform((value) => {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Timestamp must be valid');
  return date.toISOString();
});

const NonEmptyStringSchema = z.string().trim().min(1);
const HashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const ReleaseLineageSchema = z.object({
  commitSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).optional(),
  artifactDigest: HashSchema.optional(),
  deploymentId: NonEmptyStringSchema.optional(),
  /** Commit that produced artifactDigest. A mismatch is a broken lineage link. */
  artifactCommitSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).optional(),
  /** Artifact used by deploymentId. A mismatch is a broken lineage link. */
  deploymentArtifactDigest: HashSchema.optional(),
}).strict();
export type ReleaseLineage = z.infer<typeof ReleaseLineageSchema>;

const TRUST_LEVELS = [
  'untrusted',
  'local',
  'verified',
  'privileged',
  'agent_proposed',
  'host_observed',
  'provider_verified',
  'authenticated_manual',
] as const;

const EVIDENCE_OUTCOMES = [
  'passed',
  'failed',
  'warning',
  'blocked',
  'story_caused_failure',
  'unrelated_baseline',
  'environment_credential_blocker',
  'skipped_with_rationale',
  'unknown',
] as const;

/**
 * Evaluator evidence is deliberately narrower than arbitrary run output. The
 * required source, collection time, gate, immutable subject, policy, outcome,
 * classification, and trust fields prevent agent prose, an exit code, a clean
 * worktree, or a UI flag from becoming gate evidence by itself.
 */
export const PhaseEvidenceSchema = z.object({
  evidenceId: NonEmptyStringSchema,
  gateId: NonEmptyStringSchema,
  source: NonEmptyStringSchema,
  collectedAt: TimestampSchema,
  subjectRevision: ReleaseSubjectSchema,
  policyVersion: NonEmptyStringSchema,
  compilerVersion: NonEmptyStringSchema.optional(),
  status: z.enum(EVIDENCE_OUTCOMES).optional(),
  outcome: z.enum(EVIDENCE_OUTCOMES).optional(),
  classification: z.union([
    EvidenceClassificationSchema,
    z.enum(['validation', 'revision', 'completion', 'risk_judgment', 'qa', 'staging', 'deployment', 'memory_closeout']),
  ]),
  trustLevel: z.enum(TRUST_LEVELS),
  evidenceRequirementIds: z.array(NonEmptyStringSchema).default([]),
  dependencyReferences: z.array(NonEmptyStringSchema).default([]),
  expiresAt: TimestampSchema.optional(),
  releaseLineage: ReleaseLineageSchema.optional(),
  failureReason: NonEmptyStringSchema.optional(),
  sequence: z.union([z.number().int().nonnegative(), NonEmptyStringSchema]).optional(),
}).strict().superRefine((evidence, context) => {
  if (!evidence.status && !evidence.outcome) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'Evidence needs a structured status or outcome' });
  }
  if (evidence.status && evidence.outcome && evidence.status !== evidence.outcome) {
    context.addIssue({ code: 'custom', path: ['outcome'], message: 'Evidence status and outcome must agree' });
  }
  const normalizedSource = evidence.source.toLowerCase().replace(/[ -]+/g, '_');
  if (/^(?:agent(?:_|$)|process(?:_|$)|clean_worktree$|ui(?:_|$)|manual_ui_state$)/.test(normalizedSource)) {
    context.addIssue({
      code: 'custom',
      path: ['source'],
      message: `${evidence.source} is not an independently observed evidence source`,
    });
  }
});
export type PhaseEvidence = z.infer<typeof PhaseEvidenceSchema>;

const DECISION_TYPES = [
  'approve',
  'reject',
  'policy_approval',
  'human_approval',
  'gate_override',
  'qa_approval',
  'merge_approval',
  'production_approval',
  'defer',
  'not_applicable',
  'not_applicable_confirmation',
] as const;

export const PhaseDecisionSchema = z.object({
  decisionId: NonEmptyStringSchema,
  phaseId: PhaseIdSchema,
  gateId: NonEmptyStringSchema.optional(),
  decisionType: z.enum(DECISION_TYPES),
  outcome: z.enum(['approved', 'rejected']),
  subjectRevision: ReleaseSubjectSchema,
  policyVersion: NonEmptyStringSchema,
  compilerVersion: NonEmptyStringSchema.optional(),
  decidedAt: TimestampSchema,
  expiresAt: TimestampSchema.optional(),
  revokedAt: TimestampSchema.optional(),
  rationale: NonEmptyStringSchema,
  provenance: z.record(z.string(), z.unknown()),
}).strict();
export type PhaseDecision = z.infer<typeof PhaseDecisionSchema>;

export const DependencyInvalidationSchema = z.object({
  kind: z.enum(['gate', 'requirement', 'story', 'architecture_decision', 'subject', 'policy']),
  reference: NonEmptyStringSchema,
  changedAt: TimestampSchema.optional(),
  rationale: NonEmptyStringSchema.optional(),
}).strict();
export type DependencyInvalidation = z.infer<typeof DependencyInvalidationSchema>;

const ActiveSubjectsSchema = z.object({
  spec_hash: ReleaseSubjectSchema.optional(),
  commit_sha: ReleaseSubjectSchema.optional(),
  artifact_digest: ReleaseSubjectSchema.optional(),
  deployment_id: ReleaseSubjectSchema.optional(),
}).strict().superRefine((subjects, context) => {
  for (const [key, value] of Object.entries(subjects)) {
    if (value && value.type !== key) {
      context.addIssue({ code: 'custom', path: [key], message: `Active ${key} subject must have type ${key}` });
    }
  }
});

export const PhaseEvaluationRunStateSchema = z.object({
  phaseId: PhaseIdSchema,
  activeReleaseSubject: ReleaseSubjectSchema,
  activeSubjects: ActiveSubjectsSchema.default({}),
  releaseLineage: ReleaseLineageSchema.default({}),
  evidenceHighWaterMark: NonEmptyStringSchema,
  decisionHighWaterMark: NonEmptyStringSchema,
  invalidations: z.array(DependencyInvalidationSchema).default([]),
  changedGateIds: z.array(NonEmptyStringSchema).default([]),
  changedRequirementReferences: z.array(NonEmptyStringSchema).default([]),
  changedStoryReferences: z.array(NonEmptyStringSchema).default([]),
  changedSubjectTypes: z.array(ReleaseSubjectTypeSchema).default([]),
  inProgressGateIds: z.array(NonEmptyStringSchema).default([]),
  /** Optional optimistic-consistency values observed after the bounded read. */
  expectedSnapshotId: HashSchema.optional(),
  currentEvidenceHighWaterMark: NonEmptyStringSchema.optional(),
  currentDecisionHighWaterMark: NonEmptyStringSchema.optional(),
}).strict();
export type PhaseEvaluationRunStateInput = z.input<typeof PhaseEvaluationRunStateSchema>;
export type PhaseEvaluationRunState = z.infer<typeof PhaseEvaluationRunStateSchema>;
export type LifecycleEvaluationRunState = Omit<PhaseEvaluationRunStateInput, 'phaseId'> & { phaseId?: PhaseId };

/**
 * A total, strongest-first status order. Every gate and required phase status
 * is reduced through this map; no summary path independently assigns status.
 * Governed dispositions are terminal exclusions and only apply when a phase is
 * not made stale by invalid decision provenance.
 */
export const PHASE_STATUS_PRECEDENCE = [
  'stale',
  'blocked',
  'awaiting_approval',
  'in_progress',
  'passed',
  'deferred',
  'not_applicable',
  'not_started',
] as const satisfies readonly EvaluatedStatus[];

export const PHASE_STATUS_RANK: Readonly<Record<EvaluatedStatus, number>> = Object.freeze(
  Object.fromEntries(PHASE_STATUS_PRECEDENCE.map((status, rank) => [status, rank])) as Record<EvaluatedStatus, number>,
);

export type EvidenceInvalidReason =
  | 'schema_invalid'
  | 'unknown_gate'
  | 'subject_revision_mismatch'
  | 'active_subject_missing'
  | 'policy_version_mismatch'
  | 'compiler_version_mismatch'
  | 'expired'
  | 'dependency_changed'
  | 'classification_mismatch'
  | 'insufficient_trust'
  | 'lineage_incomplete'
  | 'lineage_mismatch'
  | 'lineage_broken';

export type DecisionInvalidReason =
  | 'schema_invalid'
  | 'unknown_gate'
  | 'phase_gate_mismatch'
  | 'subject_revision_mismatch'
  | 'policy_version_mismatch'
  | 'compiler_version_mismatch'
  | 'expired'
  | 'revoked'
  | 'dependency_changed';

export interface EvaluatedEvidence {
  record: unknown;
  evidenceId: string | null;
  gateId: string | null;
  valid: boolean;
  satisfiesGate: boolean;
  normalizedOutcome: 'passed' | 'failed' | 'warning' | null;
  invalidReasons: EvidenceInvalidReason[];
}

export interface EvaluatedDecision {
  record: unknown;
  decisionId: string | null;
  gateId: string | null;
  phaseId: PhaseId | null;
  valid: boolean;
  active: boolean;
  invalidReasons: DecisionInvalidReason[];
}

export interface GateStatusEvaluation {
  gateId: string;
  phaseId: PhaseId;
  status: EvaluatedStatus;
  expectedSubjectRevision: ReleaseSubject | null;
  evidenceIds: string[];
  decisionIds: string[];
  rationale: string;
  blockerReason?: string;
  nextSafeAction?: string;
}

export interface PhaseGateCounts {
  total: number;
  passed: number;
  stale: number;
  blocked: number;
  awaitingApproval: number;
  inProgress: number;
}

export interface DecisionProvenance {
  source: 'governed_decision' | 'compiled_plan';
  decisionId?: string;
  actor?: unknown;
  provenance: unknown;
  active: boolean;
}

export interface PhaseEvaluation {
  phaseId: PhaseId;
  status: EvaluatedStatus;
  /** Wire-contract compatibility; always identical to status. */
  evaluatedStatus: EvaluatedStatus;
  disposition: PhaseDisposition;
  excluded: boolean;
  rationale: string;
  decisionProvenance: DecisionProvenance | null;
  gates: GateStatusEvaluation[];
  counts: PhaseGateCounts;
  dependencies: string[];
  evidence: EvaluatedEvidence[];
  decisions: EvaluatedDecision[];
  nextUnmetGate: { gateId: string; status: EvaluatedStatus; nextSafeAction: string } | null;
  blockerGateId?: string;
  blockerReason?: string;
  nextSafeAction?: string;
  snapshot: EvaluationSnapshotIdentity;
  snapshotChanged: boolean;
  refetchRequired: boolean;
}

export interface LifecyclePhaseCounts {
  total: number;
  excluded: number;
  denominator: number;
  passed: number;
  completionRate: number;
  byStatus: Record<EvaluatedStatus, number>;
}

export interface LifecycleEvaluation {
  snapshot: EvaluationSnapshotIdentity;
  snapshotChanged: boolean;
  refetchRequired: boolean;
  phases: PhaseEvaluation[];
  counts: LifecyclePhaseCounts;
  /** Matrix cells and detail consume the exact same reduced phase results. */
  matrixCellCounts: Record<EvaluatedStatus, number>;
}

export interface PortfolioEvaluation {
  evaluations: LifecycleEvaluation[];
  snapshotSetId: `sha256:${string}`;
  snapshotChanged: boolean;
  refetchRequired: boolean;
  counts: LifecyclePhaseCounts;
  matrixCellCounts: Record<EvaluatedStatus, number>;
}

interface ParsedInputs {
  plan: LifecyclePlan;
  evidence: unknown[];
  decisions: unknown[];
  runState: PhaseEvaluationRunState;
  now: Date;
  snapshot: EvaluationSnapshotIdentity;
  snapshotChanged: boolean;
}

interface DependencyIndex {
  byPhase: Map<PhaseId, Set<string>>;
  gateOrder: string[];
}

const TRUST_RANK: Record<(typeof TRUST_LEVELS)[number], number> = {
  untrusted: 0,
  agent_proposed: 0,
  local: 1,
  host_observed: 1,
  verified: 2,
  provider_verified: 2,
  authenticated_manual: 2,
  privileged: 3,
};

const NORMALIZED_CLASSIFICATION: Record<string, z.infer<typeof EvidenceClassificationSchema>> = {
  validation: 'test_result',
  revision: 'code_change',
  completion: 'runtime_observation',
  risk_judgment: 'security_finding',
  qa: 'test_result',
  staging: 'release_operation',
  deployment: 'release_operation',
  memory_closeout: 'runtime_observation',
};

const APPROVAL_DECISIONS = new Set<string>([
  'approve',
  'policy_approval',
  'human_approval',
  'gate_override',
  'qa_approval',
  'merge_approval',
  'production_approval',
]);

const STALE_EVIDENCE_REASONS = new Set<EvidenceInvalidReason>([
  'subject_revision_mismatch',
  'policy_version_mismatch',
  'compiler_version_mismatch',
  'expired',
  'dependency_changed',
  'lineage_incomplete',
  'lineage_mismatch',
  'lineage_broken',
]);

function parseEvaluationTime(now: Date): Date {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('now must be a valid Date');
  return new Date(now.getTime());
}

function cloneRecord(record: unknown): unknown {
  try {
    return structuredClone(record);
  } catch {
    return { preserved: false, type: typeof record, reason: 'record_is_not_structured-cloneable' };
  }
}

function reduceStatus(statuses: EvaluatedStatus[]): EvaluatedStatus {
  return statuses.reduce<EvaluatedStatus>((strongest, status) =>
    PHASE_STATUS_RANK[status] < PHASE_STATUS_RANK[strongest] ? status : strongest,
  'not_started');
}

function subjectTypeForRequirement(requirement: LifecyclePlan['gates'][number]['subjectRevisionRequirement']): ReleaseSubjectType {
  switch (requirement) {
    case 'current_spec_revision': return 'spec_hash';
    case 'current_commit': return 'commit_sha';
    case 'current_artifact': return 'artifact_digest';
    case 'current_deployment': return 'deployment_id';
  }
}

function activeSubjectMap(runState: PhaseEvaluationRunState): Map<ReleaseSubjectType, ReleaseSubject> {
  const subjects = new Map<ReleaseSubjectType, ReleaseSubject>();
  subjects.set(runState.activeReleaseSubject.type, runState.activeReleaseSubject);
  for (const value of Object.values(runState.activeSubjects)) {
    if (value) subjects.set(value.type, value);
  }
  const lineageSubjects: ReleaseSubject[] = [];
  if (runState.releaseLineage.commitSha) {
    lineageSubjects.push({ type: 'commit_sha', value: runState.releaseLineage.commitSha });
  }
  if (runState.releaseLineage.artifactDigest) {
    lineageSubjects.push({ type: 'artifact_digest', value: runState.releaseLineage.artifactDigest });
  }
  if (runState.releaseLineage.deploymentId) {
    lineageSubjects.push({ type: 'deployment_id', value: runState.releaseLineage.deploymentId });
  }
  for (const subject of lineageSubjects) subjects.set(subject.type, subject);
  return subjects;
}

function sameSubject(left: ReleaseSubject | undefined, right: ReleaseSubject | undefined): boolean {
  return Boolean(left && right && left.type === right.type && left.value === right.value);
}

function gateMappingDependencies(plan: LifecyclePlan): Map<string, Set<string>> {
  const dependencies = new Map(plan.gates.map((gate) => [gate.gateId, new Set<string>()]));
  for (const mapping of plan.requirementMappings) {
    for (const gateId of mapping.gateIds) {
      const gateDependencies = dependencies.get(gateId);
      if (!gateDependencies) continue;
      gateDependencies.add(`requirement:${mapping.requirementReference}`);
      for (const target of mapping.targetReferences) {
        gateDependencies.add(`${target.type === 'story' ? 'story' : 'architecture_decision'}:${target.reference}`);
      }
    }
  }
  return dependencies;
}

/** Derive gate, requirement, story, and immutable-subject dependencies solely from the plan. */
export function derivePhaseDependencyMap(planInput: LifecyclePlan): Readonly<Record<PhaseId, readonly string[]>> {
  const plan = LifecyclePlanSchema.parse(planInput);
  const mappingDependencies = gateMappingDependencies(plan);
  const phaseIndex = new Map(plan.phaseOrder.map((phaseId, index) => [phaseId, index]));
  const byPhase = new Map<PhaseId, Set<string>>();

  for (const phase of plan.phases) {
    const dependencies = new Set<string>([`phase:${phase.phaseId}`, `policy:${plan.policyVersion}`]);
    const ownMappingDependencies = new Set<string>();
    for (const gateId of phase.gateIds) {
      dependencies.add(`gate:${gateId}`);
      const gate = plan.gates.find((candidate) => candidate.gateId === gateId)!;
      dependencies.add(`subject:${subjectTypeForRequirement(gate.subjectRevisionRequirement)}`);
      for (const dependency of mappingDependencies.get(gateId) ?? []) {
        dependencies.add(dependency);
        ownMappingDependencies.add(dependency);
      }
    }

    for (const upstream of plan.gates) {
      if ((phaseIndex.get(upstream.phaseId) ?? 0) >= (phaseIndex.get(phase.phaseId) ?? 0)) continue;
      const upstreamMappings = mappingDependencies.get(upstream.gateId) ?? new Set<string>();
      const sharesMappedInput = [...upstreamMappings].some((dependency) => ownMappingDependencies.has(dependency));
      const coherenceTarget = phase.phaseId === 'qa' || phase.phaseId === 'merge' || phase.phaseId === 'production'
        ? phase.phaseId
        : null;
      const hasDeclaredCoherenceDependency = coherenceTarget !== null
        && upstream.downstreamSubjectCoherence[coherenceTarget] !== 'not_applicable';
      if (!sharesMappedInput && !hasDeclaredCoherenceDependency) continue;
      dependencies.add(`gate:${upstream.gateId}`);
      dependencies.add(`subject:${subjectTypeForRequirement(upstream.subjectRevisionRequirement)}`);
    }
    byPhase.set(phase.phaseId, dependencies);
  }

  return Object.freeze(Object.fromEntries(
    plan.phaseOrder.map((phaseId) => [phaseId, Object.freeze([...(byPhase.get(phaseId) ?? [])].sort())]),
  )) as Readonly<Record<PhaseId, readonly string[]>>;
}

function buildDependencyIndex(plan: LifecyclePlan): DependencyIndex {
  const projected = derivePhaseDependencyMap(plan);
  const gateOrder = plan.phaseOrder.flatMap((phaseId) =>
    plan.phases.find((phase) => phase.phaseId === phaseId)?.gateIds ?? []);
  return {
    byPhase: new Map(plan.phaseOrder.map((phaseId) => [phaseId, new Set(projected[phaseId])])),
    gateOrder,
  };
}

function normalizedInvalidations(runState: PhaseEvaluationRunState): DependencyInvalidation[] {
  const direct: DependencyInvalidation[] = [
    ...runState.changedGateIds.map((reference) => ({ kind: 'gate' as const, reference })),
    ...runState.changedRequirementReferences.map((reference) => ({ kind: 'requirement' as const, reference })),
    ...runState.changedStoryReferences.map((reference) => ({ kind: 'story' as const, reference })),
    ...runState.changedSubjectTypes.map((reference) => ({ kind: 'subject' as const, reference })),
  ];
  return [...runState.invalidations, ...direct];
}

function invalidationDependency(invalidation: DependencyInvalidation): string {
  return `${invalidation.kind}:${invalidation.reference}`;
}

function isInvalidatedAt(
  phaseDependencies: Set<string>,
  invalidations: DependencyInvalidation[],
  recordTime: string,
): boolean {
  const collectedAt = new Date(recordTime).getTime();
  return invalidations.some((invalidation) => {
    if (!phaseDependencies.has(invalidationDependency(invalidation))) return false;
    return !invalidation.changedAt || collectedAt <= new Date(invalidation.changedAt).getTime();
  });
}

function expectedSubject(
  plan: LifecyclePlan,
  gateId: string,
  subjects: Map<ReleaseSubjectType, ReleaseSubject>,
): ReleaseSubject | undefined {
  const gate = plan.gates.find((candidate) => candidate.gateId === gateId);
  return gate ? subjects.get(subjectTypeForRequirement(gate.subjectRevisionRequirement)) : undefined;
}

function minimumTrustRank(value: z.infer<typeof EvidenceTrustLevelSchema>): number {
  return TRUST_RANK[value];
}

function evidenceOutcome(evidence: PhaseEvidence): 'passed' | 'failed' | 'warning' {
  const outcome = evidence.status ?? evidence.outcome!;
  if (['failed', 'blocked', 'story_caused_failure', 'environment_credential_blocker'].includes(outcome)) return 'failed';
  if (outcome === 'passed') return 'passed';
  return 'warning';
}

function normalizedClassification(evidence: PhaseEvidence): z.infer<typeof EvidenceClassificationSchema> {
  return NORMALIZED_CLASSIFICATION[evidence.classification] ?? evidence.classification as z.infer<typeof EvidenceClassificationSchema>;
}

function lineageReasons(
  phaseId: PhaseId,
  evidence: PhaseEvidence,
  active: ReleaseLineage,
): EvidenceInvalidReason[] {
  if (!['staging', 'qa', 'merge', 'production'].includes(phaseId)) return [];
  const needsArtifact = ['staging', 'qa', 'merge', 'production'].includes(phaseId);
  const needsDeployment = phaseId === 'production';
  if (!active.commitSha || (needsArtifact && !active.artifactDigest) || (needsDeployment && !active.deploymentId)) {
    return ['lineage_incomplete'];
  }
  if ((active.artifactCommitSha && active.artifactCommitSha !== active.commitSha)
    || (active.deploymentArtifactDigest && active.deploymentArtifactDigest !== active.artifactDigest)) {
    return ['lineage_broken'];
  }
  const observed = evidence.releaseLineage;
  if (!observed?.commitSha || observed.commitSha !== active.commitSha
    || (needsArtifact && (!observed.artifactDigest || observed.artifactDigest !== active.artifactDigest))
    || (needsDeployment && (!observed.deploymentId || observed.deploymentId !== active.deploymentId))) {
    return ['lineage_mismatch'];
  }
  if ((observed.artifactCommitSha && observed.artifactCommitSha !== observed.commitSha)
    || (observed.deploymentArtifactDigest && observed.deploymentArtifactDigest !== observed.artifactDigest)) {
    return ['lineage_broken'];
  }
  return [];
}

function projectEvidence(
  rawEvidence: unknown[],
  plan: LifecyclePlan,
  runState: PhaseEvaluationRunState,
  now: Date,
  dependencyIndex: DependencyIndex,
): EvaluatedEvidence[] {
  const subjects = activeSubjectMap(runState);
  const invalidations = normalizedInvalidations(runState);
  return rawEvidence.map((record): EvaluatedEvidence => {
    const parsed = PhaseEvidenceSchema.safeParse(record);
    if (!parsed.success) {
      return {
        record: cloneRecord(record),
        evidenceId: null,
        gateId: null,
        valid: false,
        satisfiesGate: false,
        normalizedOutcome: null,
        invalidReasons: ['schema_invalid'],
      };
    }
    const evidence = parsed.data;
    const gate = plan.gates.find((candidate) => candidate.gateId === evidence.gateId);
    const reasons: EvidenceInvalidReason[] = [];
    if (!gate) reasons.push('unknown_gate');
    if (gate) {
      const expected = expectedSubject(plan, gate.gateId, subjects);
      if (!expected) reasons.push('active_subject_missing');
      else if (!sameSubject(evidence.subjectRevision, expected)) reasons.push('subject_revision_mismatch');
      if (evidence.policyVersion !== plan.policyVersion) reasons.push('policy_version_mismatch');
      if (evidence.compilerVersion && evidence.compilerVersion !== plan.compilerVersion) {
        reasons.push('compiler_version_mismatch');
      }
      if (evidence.expiresAt && new Date(evidence.expiresAt).getTime() < now.getTime()) reasons.push('expired');
      if (gate.expirationPolicy === 'after_30_days'
        && new Date(evidence.collectedAt).getTime() + 30 * 24 * 60 * 60 * 1_000 < now.getTime()) {
        reasons.push('expired');
      }
      const dependencies = dependencyIndex.byPhase.get(gate.phaseId) ?? new Set<string>();
      const directlyInvalidated = invalidations.some((invalidation) =>
        evidence.dependencyReferences.includes(invalidationDependency(invalidation))
        && (!invalidation.changedAt
          || new Date(evidence.collectedAt).getTime() <= new Date(invalidation.changedAt).getTime()));
      if (isInvalidatedAt(dependencies, invalidations, evidence.collectedAt) || directlyInvalidated) {
        reasons.push('dependency_changed');
      }

      const requirements = plan.evidenceRequirements.filter((requirement) =>
        gate.evidenceRequirementIds.includes(requirement.evidenceRequirementId));
      const evidenceClassification = normalizedClassification(evidence);
      const matchingRequirements = requirements.filter((requirement) =>
        (evidence.evidenceRequirementIds.length === 0
          || evidence.evidenceRequirementIds.includes(requirement.evidenceRequirementId))
        && requirement.classification === evidenceClassification);
      if (matchingRequirements.length === 0) reasons.push('classification_mismatch');
      else if (!matchingRequirements.some((requirement) =>
        TRUST_RANK[evidence.trustLevel] >= minimumTrustRank(requirement.minimumTrustLevel))) {
        reasons.push('insufficient_trust');
      }
      reasons.push(...lineageReasons(gate.phaseId, evidence, runState.releaseLineage));
    }
    const uniqueReasons = [...new Set(reasons)];
    const normalizedOutcome = evidenceOutcome(evidence);
    return {
      record: cloneRecord(record),
      evidenceId: evidence.evidenceId,
      gateId: evidence.gateId,
      valid: uniqueReasons.length === 0,
      satisfiesGate: uniqueReasons.length === 0 && normalizedOutcome === 'passed',
      normalizedOutcome,
      invalidReasons: uniqueReasons,
    };
  });
}

function projectDecisions(
  rawDecisions: unknown[],
  plan: LifecyclePlan,
  runState: PhaseEvaluationRunState,
  now: Date,
  dependencyIndex: DependencyIndex,
): EvaluatedDecision[] {
  const subjects = activeSubjectMap(runState);
  const invalidations = normalizedInvalidations(runState);
  return rawDecisions.map((record): EvaluatedDecision => {
    const parsed = PhaseDecisionSchema.safeParse(record);
    if (!parsed.success) {
      return {
        record: cloneRecord(record),
        decisionId: null,
        gateId: null,
        phaseId: null,
        valid: false,
        active: false,
        invalidReasons: ['schema_invalid'],
      };
    }
    const decision = parsed.data;
    const reasons: DecisionInvalidReason[] = [];
    const gate = decision.gateId
      ? plan.gates.find((candidate) => candidate.gateId === decision.gateId)
      : undefined;
    if (decision.gateId && !gate) reasons.push('unknown_gate');
    if (gate && gate.phaseId !== decision.phaseId) reasons.push('phase_gate_mismatch');
    const subject = gate
      ? expectedSubject(plan, gate.gateId, subjects)
      : runState.activeReleaseSubject;
    if (!sameSubject(decision.subjectRevision, subject)) reasons.push('subject_revision_mismatch');
    if (decision.policyVersion !== plan.policyVersion) reasons.push('policy_version_mismatch');
    if (decision.compilerVersion && decision.compilerVersion !== plan.compilerVersion) {
      reasons.push('compiler_version_mismatch');
    }
    if (decision.expiresAt && new Date(decision.expiresAt).getTime() < now.getTime()) reasons.push('expired');
    if (decision.revokedAt && new Date(decision.revokedAt).getTime() <= now.getTime()) reasons.push('revoked');
    const dependencies = dependencyIndex.byPhase.get(decision.phaseId) ?? new Set<string>();
    if (isInvalidatedAt(dependencies, invalidations, decision.decidedAt)) reasons.push('dependency_changed');
    const uniqueReasons = [...new Set(reasons)];
    return {
      record: cloneRecord(record),
      decisionId: decision.decisionId,
      gateId: decision.gateId ?? null,
      phaseId: decision.phaseId,
      valid: uniqueReasons.length === 0,
      active: uniqueReasons.length === 0 && decision.outcome === 'approved',
      invalidReasons: uniqueReasons,
    };
  });
}

function parsedEvidence(record: EvaluatedEvidence): PhaseEvidence | undefined {
  const parsed = PhaseEvidenceSchema.safeParse(record.record);
  return parsed.success ? parsed.data : undefined;
}

function parsedDecision(record: EvaluatedDecision): PhaseDecision | undefined {
  const parsed = PhaseDecisionSchema.safeParse(record.record);
  return parsed.success ? parsed.data : undefined;
}

function nextAction(gate: LifecyclePlan['gates'][number], subject: ReleaseSubject | undefined): string {
  const target = subject ? `${subject.type} ${subject.value}` : gate.subjectRevisionRequirement;
  return `Collect new ${gate.evidenceKind} evidence for gate ${gate.gateId} on ${target}, then re-evaluate.`;
}

function laterEvidence(left: PhaseEvidence, right: PhaseEvidence): boolean {
  const leftTime = new Date(left.collectedAt).getTime();
  const rightTime = new Date(right.collectedAt).getTime();
  if (leftTime !== rightTime) return leftTime > rightTime;
  const leftSequence = String(left.sequence ?? '0');
  const rightSequence = String(right.sequence ?? '0');
  try { return BigInt(leftSequence) > BigInt(rightSequence); } catch { return leftSequence.localeCompare(rightSequence) > 0; }
}

/** Latest observation from one source for one gate/subject supersedes its old fact. */
function effectiveGateEvidence(records: EvaluatedEvidence[]): EvaluatedEvidence[] {
  const effective = new Map<string, EvaluatedEvidence>();
  const unparsed: EvaluatedEvidence[] = [];
  for (const record of records) {
    const evidence = parsedEvidence(record);
    if (!evidence) {
      unparsed.push(record);
      continue;
    }
    const supersedingSource = evidence.source === 'github_check:github-pr-delivery';
    const key = supersedingSource
      ? `${evidence.source}|${evidence.subjectRevision.type}:${evidence.subjectRevision.value}`
      : `${evidence.source}|${evidence.subjectRevision.type}:${evidence.subjectRevision.value}|${evidence.evidenceId}`;
    const current = effective.get(key);
    const currentEvidence = current && parsedEvidence(current);
    if (!currentEvidence || laterEvidence(evidence, currentEvidence)) effective.set(key, record);
  }
  return [...effective.values(), ...unparsed];
}

function evaluateGates(
  plan: LifecyclePlan,
  runState: PhaseEvaluationRunState,
  evidence: EvaluatedEvidence[],
  decisions: EvaluatedDecision[],
): Map<string, GateStatusEvaluation> {
  const subjects = activeSubjectMap(runState);
  const results = new Map<string, GateStatusEvaluation>();

  for (const gate of plan.gates) {
    const allGateEvidence = evidence.filter((candidate) => candidate.gateId === gate.gateId);
    const gateEvidence = effectiveGateEvidence(allGateEvidence);
    const gateDecisions = decisions.filter((candidate) => candidate.gateId === gate.gateId);
    const validEvidence = gateEvidence.filter((candidate) => candidate.valid);
    const passedEvidence = validEvidence.filter((candidate) => candidate.normalizedOutcome === 'passed');
    const failedEvidence = validEvidence.find((candidate) => candidate.normalizedOutcome === 'failed');
    const staleHistory = allGateEvidence.some((candidate) =>
      !candidate.valid && candidate.invalidReasons.some((reason) => STALE_EVIDENCE_REASONS.has(reason)));
    const expected = expectedSubject(plan, gate.gateId, subjects);
    const requirementIds = new Set(gate.evidenceRequirementIds);
    const satisfiedRequirements = new Set<string>();
    for (const projected of passedEvidence) {
      const item = parsedEvidence(projected)!;
      const classification = normalizedClassification(item);
      for (const requirement of plan.evidenceRequirements) {
        if (!requirementIds.has(requirement.evidenceRequirementId)) continue;
        const explicitlyApplies = item.evidenceRequirementIds.length === 0
          || item.evidenceRequirementIds.includes(requirement.evidenceRequirementId);
        if (explicitlyApplies && requirement.classification === classification
          && TRUST_RANK[item.trustLevel] >= minimumTrustRank(requirement.minimumTrustLevel)) {
          satisfiedRequirements.add(requirement.evidenceRequirementId);
        }
      }
    }
    const evidenceComplete = gate.evidenceRequirementIds.every((id) => satisfiedRequirements.has(id));
    const approvalTypeMatches = (decision: PhaseDecision): boolean => {
      if (!APPROVAL_DECISIONS.has(decision.decisionType)) return false;
      if (decision.decisionType === 'approve' || decision.decisionType === 'gate_override') return true;
      // Explicit authenticated approval is always sufficient for a policy gate;
      // policy approval never satisfies a human gate. This preserves the
      // high-risk stop while allowing low/medium standing-policy plans.
      if (['human_approval', 'qa_approval', 'merge_approval'].includes(decision.decisionType)) return true;
      return gate.approvalRequirement === 'policy'
        && ['policy_approval', 'production_approval'].includes(decision.decisionType);
    };
    const activeRejected = gateDecisions.find((candidate) => {
      const decision = parsedDecision(candidate);
      return candidate.valid && decision?.outcome === 'rejected'
        && (decision.decisionType === 'reject' || approvalTypeMatches(decision));
    });
    const activeApproval = gateDecisions.find((candidate) => {
      const decision = parsedDecision(candidate);
      return candidate.active && decision !== undefined && approvalTypeMatches(decision);
    });
    const staleApproval = gateDecisions.some((candidate) => {
      const decision = parsedDecision(candidate);
      return decision !== undefined && approvalTypeMatches(decision) && !candidate.valid;
    });

    let status: EvaluatedStatus;
    let rationale: string;
    let blockerReason: string | undefined;
    if (staleHistory && passedEvidence.length === 0 && !failedEvidence) {
      status = 'stale';
      rationale = `Historical evidence for ${gate.gateId} no longer matches the active bounded inputs.`;
    } else if (failedEvidence && gate.blockingSeverity !== 'advisory') {
      const failed = parsedEvidence(failedEvidence)!;
      status = 'blocked';
      blockerReason = `Evidence ${failed.evidenceId} failed ${gate.gateId}: ${failed.failureReason ?? failed.status ?? failed.outcome}.`;
      rationale = blockerReason;
    } else if (activeRejected && gate.blockingSeverity !== 'advisory') {
      const rejected = parsedDecision(activeRejected)!;
      status = 'blocked';
      blockerReason = `Decision ${rejected.decisionId} rejected ${gate.gateId}: ${rejected.rationale}.`;
      rationale = blockerReason;
    } else if (gate.approvalRequirement !== 'none' && staleApproval && !activeApproval) {
      status = 'stale';
      rationale = `The prior ${gate.approvalRequirement} approval for ${gate.gateId} is revoked, expired, or revision-mismatched.`;
    } else if (gate.blockingSeverity === 'advisory') {
      status = 'passed';
      rationale = failedEvidence
        ? `Advisory evidence ${failedEvidence.evidenceId} is warning-only and does not block completion.`
        : `Advisory gate ${gate.gateId} does not block completion.`;
    } else if (!evidenceComplete) {
      status = 'in_progress';
      rationale = `Gate ${gate.gateId} still needs current evidence for ${gate.evidenceRequirementIds.filter((id) => !satisfiedRequirements.has(id)).join(', ')}.`;
    } else if (gate.approvalRequirement !== 'none' && !activeApproval) {
      status = 'awaiting_approval';
      rationale = `Current evidence is complete; ${gate.approvalRequirement} approval is still required for ${gate.gateId}.`;
    } else {
      status = 'passed';
      rationale = `Every blocking evidence requirement and approval for ${gate.gateId} is current and valid.`;
    }

    results.set(gate.gateId, {
      gateId: gate.gateId,
      phaseId: gate.phaseId,
      status,
      expectedSubjectRevision: expected ?? null,
      evidenceIds: gateEvidence.flatMap((candidate) => candidate.evidenceId ? [candidate.evidenceId] : []).sort(),
      decisionIds: gateDecisions.flatMap((candidate) => candidate.decisionId ? [candidate.decisionId] : []).sort(),
      rationale,
      ...(blockerReason ? { blockerReason, nextSafeAction: nextAction(gate, expected) } : {}),
    });
  }
  return results;
}

function dispositionProvenance(
  phase: LifecyclePlan['phases'][number],
  decisions: EvaluatedDecision[],
  plan: LifecyclePlan,
): { status: EvaluatedStatus; provenance: DecisionProvenance; rationale: string } {
  const disposition = phase.disposition.disposition;
  if (disposition === 'required') {
    throw new TypeError('dispositionProvenance only accepts excluded phases');
  }
  const reference = phase.disposition.approvalReference;
  if (!reference) {
    return {
      status: disposition,
      provenance: {
        source: 'compiled_plan',
        provenance: { planId: plan.planId, planVersion: plan.planVersion, policyVersion: plan.policyVersion },
        active: true,
      },
      rationale: phase.disposition.rationale,
    };
  }
  const projected = decisions.find((candidate) => candidate.decisionId === reference);
  const decision = projected && parsedDecision(projected);
  const expectedTypes: readonly PhaseDecision['decisionType'][] = disposition === 'deferred'
    ? ['defer']
    : ['not_applicable', 'not_applicable_confirmation'];
  const typeMatches = decision !== undefined && expectedTypes.includes(decision.decisionType);
  if (!projected || !decision || !projected.active || !typeMatches) {
    return {
      status: 'stale',
      provenance: {
        source: 'governed_decision',
        decisionId: reference,
        provenance: decision?.provenance ?? { missingFromSnapshot: true },
        active: false,
      },
      rationale: `${phase.disposition.disposition} decision ${reference} is missing, expired, revoked, or revision-mismatched.`,
    };
  }
  return {
    status: disposition,
    provenance: {
      source: 'governed_decision',
      decisionId: reference,
      provenance: decision.provenance,
      active: true,
    },
    rationale: phase.disposition.rationale,
  };
}

function emptyStatusCounts(): Record<EvaluatedStatus, number> {
  return {
    not_started: 0,
    in_progress: 0,
    blocked: 0,
    awaiting_approval: 0,
    passed: 0,
    deferred: 0,
    not_applicable: 0,
    stale: 0,
  };
}

function phaseGateCounts(gates: GateStatusEvaluation[]): PhaseGateCounts {
  return {
    total: gates.length,
    passed: gates.filter((gate) => gate.status === 'passed').length,
    stale: gates.filter((gate) => gate.status === 'stale').length,
    blocked: gates.filter((gate) => gate.status === 'blocked').length,
    awaitingApproval: gates.filter((gate) => gate.status === 'awaiting_approval').length,
    inProgress: gates.filter((gate) => ['in_progress', 'not_started'].includes(gate.status)).length,
  };
}

function consistencyChanged(runState: PhaseEvaluationRunState, snapshot: EvaluationSnapshotIdentity): boolean {
  return Boolean(
    (runState.expectedSnapshotId && runState.expectedSnapshotId !== snapshot.snapshotId)
    || (runState.currentEvidenceHighWaterMark
      && runState.currentEvidenceHighWaterMark !== runState.evidenceHighWaterMark)
    || (runState.currentDecisionHighWaterMark
      && runState.currentDecisionHighWaterMark !== runState.decisionHighWaterMark),
  );
}

function parseInputs(
  planInput: LifecyclePlan,
  evidence: unknown[],
  decisions: unknown[],
  runStateInput: PhaseEvaluationRunStateInput,
  nowInput: Date,
): ParsedInputs {
  const plan = LifecyclePlanSchema.parse(planInput);
  const runState = PhaseEvaluationRunStateSchema.parse(runStateInput);
  const now = parseEvaluationTime(nowInput);
  const snapshot = Object.freeze(deriveEvaluationSnapshotIdentity({
    planId: plan.planId,
    planVersion: plan.planVersion,
    inputHash: plan.inputHash,
    evidenceHighWaterMark: runState.evidenceHighWaterMark,
    decisionHighWaterMark: runState.decisionHighWaterMark,
    activeReleaseSubject: runState.activeReleaseSubject,
    policyVersion: plan.policyVersion,
    compilerVersion: plan.compilerVersion,
    evaluatedAt: now.toISOString(),
  }));
  return {
    plan,
    evidence: [...evidence],
    decisions: [...decisions],
    runState,
    now,
    snapshot,
    snapshotChanged: consistencyChanged(runState, snapshot),
  };
}

function evaluateParsed(inputs: ParsedInputs): LifecycleEvaluation {
  const dependencyIndex = buildDependencyIndex(inputs.plan);
  const evidence = projectEvidence(inputs.evidence, inputs.plan, inputs.runState, inputs.now, dependencyIndex);
  const decisions = projectDecisions(inputs.decisions, inputs.plan, inputs.runState, inputs.now, dependencyIndex);
  const gateResults = evaluateGates(inputs.plan, inputs.runState, evidence, decisions);
  const phases: PhaseEvaluation[] = [];

  for (const phase of inputs.plan.phases) {
    const dependencies = dependencyIndex.byPhase.get(phase.phaseId) ?? new Set<string>();
    const dependentGateIds = dependencyIndex.gateOrder.filter((gateId) => dependencies.has(`gate:${gateId}`));
    const dependentGates = dependentGateIds.flatMap((gateId) => {
      const gate = gateResults.get(gateId);
      return gate ? [gate] : [];
    });
    const ownGates = phase.gateIds.flatMap((gateId) => {
      const gate = gateResults.get(gateId);
      return gate ? [gate] : [];
    });
    const relevantEvidence = evidence.filter((candidate) =>
      candidate.gateId === null || dependentGateIds.includes(candidate.gateId));
    const relevantDecisions = decisions.filter((candidate) =>
      candidate.phaseId === null
      || candidate.phaseId === phase.phaseId
      || (candidate.gateId !== null && dependentGateIds.includes(candidate.gateId)));

    let status: EvaluatedStatus;
    let rationale: string;
    let decisionProvenance: DecisionProvenance | null = null;
    if (phase.disposition.disposition !== 'required') {
      const disposition = dispositionProvenance(phase, decisions, inputs.plan);
      status = disposition.status;
      rationale = disposition.rationale;
      decisionProvenance = disposition.provenance;
    } else {
      status = reduceStatus(dependentGates.map((gate) => gate.status));
      rationale = status === 'passed'
        ? `All blocking dependencies for ${phase.phaseId} passed under snapshot ${inputs.snapshot.snapshotId}.`
        : dependentGates.find((gate) => gate.status === status)?.rationale
          ?? `${phase.phaseId} has not started.`;
    }

    const blocker = status === 'blocked'
      ? dependentGates.find((gate) => gate.status === 'blocked')
      : undefined;
    const unmet = dependentGates.find((gate) => gate.status !== 'passed');
    const unmetPlanGate = unmet && inputs.plan.gates.find((gate) => gate.gateId === unmet.gateId);
    const safeAction = blocker?.nextSafeAction
      ?? (unmetPlanGate ? nextAction(unmetPlanGate, unmet.expectedSubjectRevision ?? undefined) : 'Re-evaluate the current bounded snapshot.');
    phases.push({
      phaseId: phase.phaseId,
      status,
      evaluatedStatus: status,
      disposition: phase.disposition,
      excluded: phase.disposition.disposition !== 'required',
      rationale,
      decisionProvenance,
      gates: ownGates,
      counts: phaseGateCounts(ownGates),
      dependencies: [...dependencies].sort(),
      evidence: relevantEvidence,
      decisions: relevantDecisions,
      nextUnmetGate: unmet ? { gateId: unmet.gateId, status: unmet.status, nextSafeAction: safeAction } : null,
      ...(blocker ? {
        blockerGateId: blocker.gateId,
        blockerReason: blocker.blockerReason ?? blocker.rationale,
        nextSafeAction: safeAction,
      } : {}),
      snapshot: inputs.snapshot,
      snapshotChanged: inputs.snapshotChanged,
      refetchRequired: inputs.snapshotChanged,
    });
  }

  const counts = aggregatePhaseEvaluations(phases);
  return {
    snapshot: inputs.snapshot,
    snapshotChanged: inputs.snapshotChanged,
    refetchRequired: inputs.snapshotChanged,
    phases,
    counts,
    matrixCellCounts: { ...counts.byStatus },
  };
}

/**
 * Evaluate exactly one phase selected by runState.phaseId. Invalid evidence is
 * returned with valid=false and never removed from the historical projection.
 */
export function evaluatePhase(
  plan: LifecyclePlan,
  evidence: unknown[],
  decisions: unknown[],
  runState: PhaseEvaluationRunStateInput,
  now: Date,
): PhaseEvaluation {
  const parsed = parseInputs(plan, evidence, decisions, runState, now);
  const result = evaluateParsed(parsed).phases.find((phase) => phase.phaseId === parsed.runState.phaseId);
  if (!result) throw new RangeError(`Unknown phase ${parsed.runState.phaseId}`);
  return result;
}

/** Evaluate all 11 phase details and summary counts under one immutable snapshot. */
export function evaluateLifecycle(
  plan: LifecyclePlan,
  evidence: unknown[],
  decisions: unknown[],
  runState: LifecycleEvaluationRunState,
  now: Date,
): LifecycleEvaluation {
  const phaseId = runState.phaseId ?? plan.phaseOrder[0];
  const parsed = parseInputs(plan, evidence, decisions, { ...runState, phaseId }, now);
  return evaluateParsed(parsed);
}

/** The sole completion denominator used by lifecycle detail, matrix, and portfolio. */
export function aggregatePhaseEvaluations(phases: readonly PhaseEvaluation[]): LifecyclePhaseCounts {
  const byStatus = emptyStatusCounts();
  for (const phase of phases) byStatus[phase.status] += 1;
  const excluded = phases.filter((phase) => phase.excluded).length;
  const denominator = phases.length - excluded;
  const passed = phases.filter((phase) => !phase.excluded && phase.status === 'passed').length;
  return {
    total: phases.length,
    excluded,
    denominator,
    passed,
    completionRate: denominator === 0 ? 1 : passed / denominator,
    byStatus,
  };
}

/** Portfolio aggregation calls evaluateLifecycle; there is no independent status aggregate. */
export function evaluatePortfolio(
  entries: ReadonlyArray<{
    plan: LifecyclePlan;
    evidence: unknown[];
    decisions: unknown[];
    runState: LifecycleEvaluationRunState;
  }>,
  now: Date,
): PortfolioEvaluation {
  const evaluations = entries.map((entry) =>
    evaluateLifecycle(entry.plan, entry.evidence, entry.decisions, entry.runState, now));
  const phases = evaluations.flatMap((evaluation) => evaluation.phases);
  const counts = aggregatePhaseEvaluations(phases);
  const snapshotSetId = `sha256:${crypto.createHash('sha256').update(normalizeSsdlcContractJson(
    evaluations.map((evaluation) => evaluation.snapshot.snapshotId).sort(),
  ), 'utf8').digest('hex')}` as const;
  const snapshotChanged = evaluations.some((evaluation) => evaluation.snapshotChanged);
  return {
    evaluations,
    snapshotSetId,
    snapshotChanged,
    refetchRequired: snapshotChanged,
    counts,
    matrixCellCounts: { ...counts.byStatus },
  };
}
