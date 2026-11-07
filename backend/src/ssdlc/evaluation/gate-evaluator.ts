/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import {
  LIFECYCLE_EVIDENCE_SCHEMA_VERSION,
  type CanonicalLifecycleEvidence,
  type EvidenceTrustLevel,
} from '../../lib/ssdlc-evidence';
import type { ControlRecord, EvidenceRequirement, MissionStage, Phase, SourceReference } from '../schema/control-schema';
import type { GateCompilation, PhaseControlGroup } from '../gates/gate-compiler';

export type ControlEvaluationStatus = 'pass' | 'blocked' | 'not-applicable' | 'exception';
export type GateEvaluationStatus = 'pass' | 'blocked';

export interface GateSubjectContext {
  specHash: string;
  commitSha: string | null;
  artifactDigest?: string | null;
  deploymentId?: string | null;
  /** Evidence observed at or before this mutation cannot prove the current subject. */
  mutatedAt: string | Date;
  workspaceId?: string;
  specSlug?: string;
  runId?: number | null;
}

export interface ControlEvaluationPolicy {
  allowedNotApplicable?: boolean;
}

export interface EvaluateGateInput {
  stage: MissionStage;
  /** US-004 output. Only groups projected into `stage` are evaluated. */
  compilation: Pick<GateCompilation, 'phaseGroups'>;
  controls: readonly ControlRecord[];
  evidence: readonly CanonicalLifecycleEvidence[];
  subject: GateSubjectContext;
  policies?: Readonly<Record<string, ControlEvaluationPolicy>>;
  evaluatedAt?: string | Date;
}

export interface EvidenceRequirementResult {
  requirementIndex: number;
  requirement: EvidenceRequirement;
  status: 'satisfied' | 'missing';
  evidenceIds: string[];
  reason: string;
  rejections: string[];
}

export interface ControlEvaluationResult {
  controlId: string;
  phase: Phase;
  status: ControlEvaluationStatus;
  blocking: boolean;
  reasons: string[];
  requirementResults: EvidenceRequirementResult[];
  /** US-001 genesis authority supporting why this control exists. */
  authoritySupport: SourceReference[];
  /** Stable references to canonical records that demonstrated the outcome. */
  demonstratedEvidence: string[];
  /** Skills the control required the evaluator to exercise. */
  evaluatedSkills: string[];
}

export interface PhaseEvaluationResult {
  phase: Phase;
  status: GateEvaluationStatus;
  blocking: boolean;
  controlResults: ControlEvaluationResult[];
}

export interface GateEvaluationTrace {
  stage: MissionStage;
  status: GateEvaluationStatus;
  blocking: boolean;
  evaluatedAt: string;
  phaseResults: PhaseEvaluationResult[];
  controlResults: ControlEvaluationResult[];
  unresolvedControlIds: string[];
  /** US-004-compatible stage projection. Learn is always traceable and non-blocking. */
  stageProjection: {
    stage: MissionStage;
    phases: Phase[];
    controlIds: string[];
    unresolvedControlIds: string[];
    blocking: boolean;
    status: 'ready' | 'blocked' | 'non-blocking';
  };
}

const STAGE_PHASES: Readonly<Record<MissionStage, readonly Phase[]>> = {
  planning: ['planning'],
  requirements: ['requirements'],
  design: ['design'],
  development: ['development'],
  testing: ['testing'],
  deployment: ['deployment'],
  maintenance: ['maintenance'],
};

const TRUST_RANK: Readonly<Record<EvidenceTrustLevel, number>> = {
  agent_proposed: 0,
  authenticated_manual: 1,
  host_observed: 2,
  provider_verified: 2,
};
const REQUIRED_TRUST_RANK: Readonly<Record<EvidenceRequirement['minimumTrust'], number>> = {
  'self-attested': 0,
  'tool-verified': 2,
  'independently-verified': 3,
};
const DEPTH_RANK: Readonly<Record<EvidenceRequirement['evidenceDepth'], number>> = {
  declaration: 0,
  demonstrated: 1,
  'independent-verification': 2,
};

function evidenceId(evidence: CanonicalLifecycleEvidence): string {
  return `${evidence.source.system}:${evidence.source.eventId}:${evidence.payloadHash}`;
}

function textDetail(evidence: CanonicalLifecycleEvidence, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = evidence.details[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function boolDetail(evidence: CanonicalLifecycleEvidence, key: string): boolean {
  return evidence.details[key] === true;
}

function dispositionRationale(evidence: CanonicalLifecycleEvidence): string | undefined {
  return evidence.rationale ?? textDetail(evidence, 'rationale', 'reason');
}

function same(left: string | null | undefined, right: string | null | undefined): boolean {
  return Boolean(left && right) && left!.trim().toLowerCase() === right!.trim().toLowerCase();
}

function isIndependent(evidence: CanonicalLifecycleEvidence): boolean {
  return boolDetail(evidence, 'independentVerification')
    || textDetail(evidence, 'evidenceDepth') === 'independent-verification'
    || evidence.provenanceChain.some((hop) => hop.verification?.toLowerCase().includes('independent'));
}

function evidenceDepth(evidence: CanonicalLifecycleEvidence): number {
  const explicit = textDetail(evidence, 'evidenceDepth');
  if (explicit && explicit in DEPTH_RANK) return DEPTH_RANK[explicit as EvidenceRequirement['evidenceDepth']];
  if (isIndependent(evidence)) return DEPTH_RANK['independent-verification'];
  // A passed canonical record with a proof reference or payload is demonstrated evidence.
  if (evidence.status === 'passed' && (evidence.rawReference || evidence.excerpt || Object.keys(evidence.details).length > 0)) return DEPTH_RANK.demonstrated;
  return DEPTH_RANK.declaration;
}

function trustRank(evidence: CanonicalLifecycleEvidence): number {
  if (isIndependent(evidence)) return 3;
  return TRUST_RANK[evidence.trustLevel] ?? -1;
}

function classificationMatches(requirement: EvidenceRequirement, evidence: CanonicalLifecycleEvidence): boolean {
  const explicit = textDetail(evidence, 'evidenceClassification', 'requirementClassification');
  if (explicit) return explicit === requirement.classification;
  const compatible: Readonly<Record<EvidenceRequirement['classification'], readonly string[]>> = {
    artifact: ['revision', 'completion', 'testing', 'documentation', 'deployment'],
    attestation: ['completion', 'risk_judgment', 'approval'],
    measurement: ['testing', 'deployment'],
    review: ['risk_judgment', 'testing', 'documentation'],
    approval: ['approval'],
  };
  return compatible[requirement.classification].includes(evidence.classification);
}

function sourceMatches(requirement: EvidenceRequirement, evidence: CanonicalLifecycleEvidence): boolean {
  const sourceType = textDetail(evidence, 'evidenceSourceType', 'requirementSourceType') ?? evidence.source.type;
  return requirement.allowedSourceTypes.includes(sourceType);
}

function scopeMatches(evidence: CanonicalLifecycleEvidence, subject: GateSubjectContext): boolean {
  if (subject.workspaceId !== undefined && evidence.scope.workspaceId !== subject.workspaceId) return false;
  if (subject.specSlug !== undefined && evidence.scope.specSlug !== subject.specSlug) return false;
  if (subject.runId !== undefined && evidence.scope.runId !== subject.runId) return false;
  return true;
}

function identityRejections(evidence: CanonicalLifecycleEvidence, requirement: EvidenceRequirement, subject: GateSubjectContext): string[] {
  const reasons: string[] = [];
  if (requirement.requiredBindings.subject) {
    const specBinding = [evidence.subject, evidence.phaseSubject]
      .some((identity) => identity?.type === 'spec_hash' && same(identity.value, subject.specHash));
    if (!specBinding) reasons.push('absent or mismatched spec hash');
  }
  if (requirement.requiredBindings.release) {
    if (!subject.commitSha || !same(evidence.releaseIdentity.commitSha, subject.commitSha)) {
      reasons.push('absent or mismatched commit SHA');
    }
    for (const [label, expected, actual] of [
      ['artifact digest', subject.artifactDigest, evidence.releaseIdentity.artifactDigest],
      ['deployment id', subject.deploymentId, evidence.releaseIdentity.deploymentId],
    ] as const) {
      if (expected !== undefined && (!expected || !same(actual, expected))) reasons.push(`absent or mismatched ${label}`);
    }
    if (evidence.revisionMismatch || !evidence.lineageVerified) reasons.push('release lineage is not verified');
  }
  return reasons;
}

function temporalRejections(
  evidence: CanonicalLifecycleEvidence,
  requirement: EvidenceRequirement,
  subject: GateSubjectContext,
  nowMs: number,
): string[] {
  const observed = Date.parse(evidence.observedAt);
  const mutated = new Date(subject.mutatedAt).getTime();
  if (!Number.isFinite(observed)) return ['invalid observedAt timestamp'];
  const reasons: string[] = [];
  if (!Number.isFinite(mutated) || observed <= mutated) reasons.push('evidence is stale relative to subject mutation');
  if (observed > nowMs) reasons.push('evidence observedAt is in the future');
  if (nowMs - observed > requirement.freshness.maxAgeSeconds * 1_000) reasons.push('evidence exceeds freshness requirement');
  return reasons;
}

function rejectionReasons(
  evidence: CanonicalLifecycleEvidence,
  requirement: EvidenceRequirement,
  subject: GateSubjectContext,
  nowMs: number,
): string[] {
  const reasons: string[] = [];
  if (evidence.status !== 'passed') reasons.push(`status is ${evidence.status}, not passed`);
  if (!scopeMatches(evidence, subject)) reasons.push('scope does not match the evaluated subject');
  if (!sourceMatches(requirement, evidence)) reasons.push(`source type is not one of ${requirement.allowedSourceTypes.join(', ')}`);
  if (!classificationMatches(requirement, evidence)) reasons.push(`classification does not satisfy ${requirement.classification}`);
  reasons.push(...identityRejections(evidence, requirement, subject));
  if (trustRank(evidence) < REQUIRED_TRUST_RANK[requirement.minimumTrust]) reasons.push(`trust level does not satisfy ${requirement.minimumTrust}`);
  if (evidenceDepth(evidence) < DEPTH_RANK[requirement.evidenceDepth]) reasons.push(`evidence depth does not satisfy ${requirement.evidenceDepth}`);
  if (requirement.evidenceDepth === 'independent-verification' && !isIndependent(evidence)) reasons.push('independent verification is required');
  reasons.push(...temporalRejections(evidence, requirement, subject, nowMs));
  return [...new Set(reasons)];
}

function requirementLabel(requirement: EvidenceRequirement, index: number): string {
  return `evidence requirement ${index + 1} (${requirement.classification}; ${requirement.allowedSourceTypes.join('|')}; ${requirement.evidenceDepth})`;
}

function dispositionEvidence(
  evidence: readonly CanonicalLifecycleEvidence[],
  controlId: string,
  disposition: 'not-applicable' | 'exception',
): CanonicalLifecycleEvidence[] {
  return evidence.filter((item) =>
    textDetail(item, 'controlId') === controlId
    && textDetail(item, 'disposition') === disposition,
  );
}

function currentDisposition(
  candidate: CanonicalLifecycleEvidence,
  subject: GateSubjectContext,
  nowMs: number,
  maxAgeSeconds = 86_400,
): string[] {
  const syntheticRequirement: EvidenceRequirement = {
    classification: candidate.classification === 'approval' ? 'approval' : 'attestation',
    allowedSourceTypes: [textDetail(candidate, 'evidenceSourceType', 'requirementSourceType') ?? candidate.source.type],
    requiredBindings: { subject: true, release: Boolean(subject.commitSha) },
    minimumTrust: 'tool-verified',
    evidenceDepth: 'demonstrated',
    freshness: { maxAgeSeconds: Number(candidate.details.maxAgeSeconds) > 0 ? Number(candidate.details.maxAgeSeconds) : maxAgeSeconds },
  };
  const statusReasons = candidate.status === 'passed' || candidate.status === 'skipped_with_rationale'
    ? []
    : [`status is ${candidate.status}, not a disposition outcome`];
  return [...statusReasons, ...rejectionReasons({ ...candidate, status: 'passed' }, syntheticRequirement, subject, nowMs)];
}

function evaluateControl(
  control: ControlRecord,
  group: PhaseControlGroup,
  evidence: readonly CanonicalLifecycleEvidence[],
  subject: GateSubjectContext,
  policy: ControlEvaluationPolicy | undefined,
  nowMs: number,
  learn: boolean,
): ControlEvaluationResult {
  const requirements = group.evidenceRequirements.filter((item) => item.controlId === control.controlId);
  const requirementResults = requirements.map((compiled, index): EvidenceRequirementResult => {
    const { controlId: _controlId, sourceReferences: _sourceReferences, ...requirement } = compiled;
    const candidates = evidence.map((item) => ({ item, reasons: rejectionReasons(item, requirement, subject, nowMs) }));
    const matching = candidates.filter(({ reasons }) => reasons.length === 0).map(({ item }) => item);
    const label = requirementLabel(requirement, index);
    return {
      requirementIndex: index,
      requirement,
      status: matching.length > 0 ? 'satisfied' : 'missing',
      evidenceIds: matching.map(evidenceId),
      reason: matching.length > 0 ? `Satisfied ${label}` : `Missing matching current ${label}`,
      rejections: matching.length > 0 ? [] : [...new Set(candidates.flatMap(({ reasons }) => reasons))],
    };
  });
  const allSatisfied = requirementResults.length > 0 && requirementResults.every(({ status }) => status === 'satisfied');
  const authoritySupport = requirements.flatMap(({ sourceReferences }) => sourceReferences);
  const demonstratedEvidence = requirementResults.flatMap(({ evidenceIds }) => evidenceIds);

  if (allSatisfied) return {
    controlId: control.controlId, phase: group.phase, status: 'pass', blocking: false, reasons: [],
    requirementResults, authoritySupport, demonstratedEvidence, evaluatedSkills: [...control.skillRefs],
  };

  const notApplicable = dispositionEvidence(evidence, control.controlId, 'not-applicable');
  const notApplicableRejections: string[] = [];
  if (notApplicable.length > 0) {
    if (!policy?.allowedNotApplicable) {
      return {
        controlId: control.controlId, phase: group.phase, status: 'blocked', blocking: !learn,
        reasons: [`Not-applicable is not allowed for control ${control.controlId}`], requirementResults,
        authoritySupport, demonstratedEvidence: notApplicable.map(evidenceId), evaluatedSkills: [...control.skillRefs],
      };
    }
    const described = notApplicable.map((item) => ({
      item,
      invalid: [
        ...(dispositionRationale(item) ? [] : ['not-applicable rationale is absent']),
        ...currentDisposition(item, subject, nowMs),
      ],
    }));
    const valid = described.find(({ invalid }) => invalid.length === 0)?.item;
    if (valid) return {
      controlId: control.controlId, phase: group.phase, status: 'not-applicable', blocking: false,
      reasons: [`Evidence-backed not-applicable determination: ${dispositionRationale(valid)}`], requirementResults,
      authoritySupport, demonstratedEvidence: [evidenceId(valid)], evaluatedSkills: [...control.skillRefs],
    };
    notApplicableRejections.push(...described.map(({ item, invalid }) =>
      `Not-applicable evidence ${evidenceId(item)} is invalid: ${[...new Set(invalid)].join('; ')}`,
    ));
  }

  const exceptions = dispositionEvidence(evidence, control.controlId, 'exception');
  if (exceptions.length > 0) {
    const describeException = (candidate: CanonicalLifecycleEvidence) => {
      const authority = textDetail(candidate, 'exceptionAuthority') ?? candidate.actor ?? 'unknown authority';
      const expiresAt = textDetail(candidate, 'expiresAt', 'exceptionExpiresAt');
      const expiryMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
      const durationLimit = control.exceptionPolicy.maxDurationDays
        ? Date.parse(candidate.observedAt) + control.exceptionPolicy.maxDurationDays * 86_400_000
        : Number.POSITIVE_INFINITY;
      const exceptionMaxAge = (control.exceptionPolicy.maxDurationDays ?? 1) * 86_400;
      const invalid = currentDisposition(candidate, subject, nowMs, exceptionMaxAge);
      if (!expiresAt || !Number.isFinite(expiryMs) || expiryMs <= nowMs || expiryMs > durationLimit) {
        invalid.unshift(`invalid or expired expiry ${expiresAt ?? '(absent)'}`);
      }
      if (authority === 'unknown authority') invalid.push('exception authority is absent');
      if (control.exceptionPolicy.approvalRequired && candidate.classification !== 'approval') invalid.push('required approval is absent');
      if (control.exceptionPolicy.justificationRequired && !dispositionRationale(candidate)) invalid.push('required justification is absent');
      return { candidate, authority, expiryMs, invalid: [...new Set(invalid)] };
    };
    const described = exceptions.map(describeException);
    if (!control.exceptionPolicy.allowed) {
      const { candidate, authority } = described[0];
      return {
        controlId: control.controlId, phase: group.phase, status: 'blocked', blocking: !learn,
        reasons: [`Exception from ${authority} is disallowed for control ${control.controlId}`], requirementResults,
        authoritySupport, demonstratedEvidence: [evidenceId(candidate)], evaluatedSkills: [...control.skillRefs],
      };
    }
    const valid = described.find(({ invalid }) => invalid.length === 0);
    if (valid) return {
      controlId: control.controlId, phase: group.phase, status: 'exception', blocking: false,
      reasons: [`Valid exception approved by ${valid.authority} until ${new Date(valid.expiryMs).toISOString()}`], requirementResults,
      authoritySupport, demonstratedEvidence: [evidenceId(valid.candidate)], evaluatedSkills: [...control.skillRefs],
    };
    const rejected = described[0];
    return {
      controlId: control.controlId, phase: group.phase, status: 'blocked', blocking: !learn,
      reasons: [`Exception from ${rejected.authority} is invalid: ${rejected.invalid.join('; ')}`], requirementResults,
      authoritySupport, demonstratedEvidence: [evidenceId(rejected.candidate)], evaluatedSkills: [...control.skillRefs],
    };
  }

  const reasons = [
    ...requirementResults.filter(({ status }) => status === 'missing').map(({ reason, rejections }) =>
      rejections.length > 0 ? `${reason}: ${rejections.join('; ')}` : reason,
    ),
    ...notApplicableRejections,
  ];
  return {
    controlId: control.controlId, phase: group.phase, status: 'blocked', blocking: !learn,
    reasons, requirementResults, authoritySupport, demonstratedEvidence, evaluatedSkills: [...control.skillRefs],
  };
}

/**
 * Evaluate one Mission stage exclusively from canonical lifecycle evidence.
 * Hermes ingress must be authenticated and normalized before this boundary; AAV kernel outcomes
 * are deliberately rejected until AAV-006 emits the same canonical envelope.
 */
export function evaluateGate(input: EvaluateGateInput): GateEvaluationTrace {
  for (const item of input.evidence as readonly { schemaVersion?: string }[]) {
    if (item.schemaVersion !== LIFECYCLE_EVIDENCE_SCHEMA_VERSION) {
      throw new TypeError(`evaluateGate accepts only ${LIFECYCLE_EVIDENCE_SCHEMA_VERSION} evidence`);
    }
  }
  const evaluatedAt = input.evaluatedAt ? new Date(input.evaluatedAt) : new Date();
  if (Number.isNaN(evaluatedAt.getTime())) throw new TypeError('evaluatedAt must be a valid timestamp');
  if (!input.subject.specHash.trim()) throw new TypeError('subject.specHash is required');
  const allowedPhases = new Set(STAGE_PHASES[input.stage]);
  const groups = input.compilation.phaseGroups.filter(({ phase }) => allowedPhases.has(phase));
  const controlsById = new Map(input.controls.map((control) => [control.controlId, control]));
  const selectedIds = groups.flatMap(({ controlIds }) => controlIds);
  const absent = selectedIds.filter((id) => !controlsById.has(id));
  if (absent.length > 0) throw new TypeError(`Gate controls are absent from the catalog: ${[...new Set(absent)].join(', ')}`);

  const phaseResults = groups.map((group): PhaseEvaluationResult => {
    const controlResults = group.controlIds.map((controlId) => evaluateControl(
      controlsById.get(controlId)!, group, input.evidence, input.subject,
      input.policies?.[controlId], evaluatedAt.getTime(), input.stage === 'maintenance',
    ));
    const blocking = controlResults.some((result) => result.blocking);
    return { phase: group.phase, status: blocking ? 'blocked' : 'pass', blocking, controlResults };
  });
  const controlResults = phaseResults.flatMap(({ controlResults: results }) => results);
  const unresolvedControlIds = controlResults.filter(({ status }) => status === 'blocked').map(({ controlId }) => controlId);
  const blocking = input.stage !== 'maintenance' && phaseResults.some((result) => result.blocking);
  return {
    stage: input.stage,
    status: blocking ? 'blocked' : 'pass',
    blocking,
    evaluatedAt: evaluatedAt.toISOString(),
    phaseResults,
    controlResults,
    unresolvedControlIds,
    stageProjection: {
      stage: input.stage,
      phases: groups.map(({ phase }) => phase),
      controlIds: [...new Set(selectedIds)],
      unresolvedControlIds,
      blocking,
      status: input.stage === 'maintenance' ? 'non-blocking' : blocking ? 'blocked' : 'ready',
    },
  };
}
