/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import { createHash } from 'node:crypto';
import {
  validateAssuranceCandidate,
  validateAssuranceSubject,
  type AssuranceCandidateIdentity,
  type AssuranceCandidateInput,
  type AssuranceCandidateValidation,
  type AssuranceSubjectRecordType,
} from './assurance-candidate';

export const ASSURED_CANDIDATE_VERSION = 'rorca.assured-candidate.v1' as const;

export type AssuranceObligationOutcome = 'satisfied' | 'missing' | 'stale' | 'rejected' | 'insufficient';
export type AssuranceAttemptState = 'complete' | 'partial' | 'failed';
export type AssuranceObservationEvaluation = 'accepted' | 'rejected' | 'insufficient';
export type AssuranceFreshnessState = 'current' | 'stale' | 'unverifiable';
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface AssuredFeatureBinding {
  featureId: string;
  specificationRevision: AssuranceCandidateIdentity['specificationRevision'];
  featureRevisionHash: string;
}

export interface AssuredPlanBinding {
  planId: string;
  planVersion: number;
  planHash: string;
}

export interface AssuranceObligationInput {
  obligationId: string;
  kind: string;
  required: boolean;
  description: string;
  evidenceRecordType: AssuranceSubjectRecordType;
  maximumAgeSeconds?: number;
}

export interface AssuranceEvidenceLink {
  evidenceId: string;
  href: string;
  digest: string;
}

/** Immutable host observation. Evaluation is evidence, never lifecycle authorization. */
export interface AssuranceEvidenceObservationInput {
  observationId: string;
  attemptId: string;
  obligationId: string;
  subject: Partial<AssuranceCandidateIdentity> | null;
  evidence: AssuranceEvidenceLink;
  evaluation: AssuranceObservationEvaluation;
  evaluatorId: string;
  observedAt: string;
  detail: string;
}

export interface AssuranceRecoveryDecision {
  recoveryDecisionId: string;
  attemptId: string;
  kind: 'initial' | 'replay' | 'restart' | 'partial_failure';
  decision:
    | 'start_initial_attempt'
    | 'reuse_complete_attempt'
    | 'start_new_attempt'
    | 'retain_partial_attempt'
    | 'discard_failed_attempt';
  priorAttemptId: string | null;
  recordedAt: string;
  rationale: string;
}

export interface AssuranceDogfoodAttemptInput {
  attemptId: string;
  sequence: number;
  candidateId: string;
  state: AssuranceAttemptState;
  observationIds: readonly string[];
  recoveryDecision: AssuranceRecoveryDecision;
}

export interface AssuranceIncidentObservation {
  incidentId: string;
  observationId: string;
  occurredAt: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  summary: string;
}

export interface AssuranceTrendSnapshot {
  snapshotId: string;
  featureId: string;
  recordedAt: string;
  totalRequired: number;
  satisfied: number;
  unresolved: number;
}

export interface FeatureAssuranceDogfoodInput {
  generatedAt: string;
  maximumEvidenceAgeSeconds: number;
  feature: AssuredFeatureBinding;
  plan: AssuredPlanBinding;
  candidate: AssuranceCandidateInput;
  obligations: readonly AssuranceObligationInput[];
  observations: readonly AssuranceEvidenceObservationInput[];
  attempts: readonly AssuranceDogfoodAttemptInput[];
  incidents?: readonly AssuranceIncidentObservation[];
  priorTrendSnapshots?: readonly AssuranceTrendSnapshot[];
  upstreamLifecycleFacts: JsonObject;
}

export interface AssuredCandidateFinding {
  code: string;
  message: string;
  obligationId?: string;
  observationId?: string;
  attemptId?: string;
}

export interface AssuredEvidenceLink extends AssuranceEvidenceLink {
  observationId: string;
  observationHash: `sha256:${string}`;
  attemptId: string;
  obligationId: string;
  includedInSelectedAttempt: boolean;
  eligibleForSatisfaction: boolean;
}

export interface AssuredEvidenceEvaluation {
  observationId: string;
  obligationId: string;
  attemptId: string;
  subjectMatches: boolean;
  submittedEvaluation: AssuranceObservationEvaluation;
  freshness: AssuranceFreshnessState;
  ageSeconds: number | null;
  outcome: AssuranceObligationOutcome | 'ignored_non_selected_attempt';
}

export interface AssuredObligationEvaluation extends AssuranceObligationInput {
  outcome: AssuranceObligationOutcome;
  conditionCodes: readonly AssuranceObligationOutcome[];
  evidenceObservationIds: readonly string[];
}

export interface AssuredAttemptRecord extends AssuranceDogfoodAttemptInput {
  observationIds: readonly string[];
  recoveryDecision: Readonly<AssuranceRecoveryDecision>;
  promotion: 'selected_complete' | 'complete_not_selected' | 'partial_not_promoted' | 'failed_not_promoted';
}

export interface GovernedAssuranceImprovementInput {
  improvementInputId: `sha256:${string}`;
  sourceIncidentId: string;
  sourceObservationId: string;
  sourceObservationHash: `sha256:${string}` | null;
  route: 'assurance-governance-review';
  governanceState: 'pending_governance' | 'rejected_invalid_source';
  authority: 'none';
  lifecycleMutation: false;
}

export interface AssuredCandidate {
  schemaVersion: typeof ASSURED_CANDIDATE_VERSION;
  handoffId: `sha256:${string}`;
  generatedAt: string;
  revisionBindingHash: `sha256:${string}`;
  outcome: 'all_satisfied' | 'not_all_satisfied';
  allSatisfied: boolean;
  selectedAttemptId: string | null;
  boundFeature: Readonly<AssuredFeatureBinding>;
  boundPlan: Readonly<AssuredPlanBinding>;
  candidate: Readonly<AssuranceCandidateValidation>;
  obligations: readonly Readonly<AssuredObligationEvaluation>[];
  evidenceLinks: readonly Readonly<AssuredEvidenceLink>[];
  evaluationOutcomes: readonly Readonly<AssuredEvidenceEvaluation>[];
  unresolvedFindings: readonly Readonly<AssuredCandidateFinding>[];
  freshness: {
    asOf: string;
    maximumEvidenceAgeSeconds: number;
    overall: AssuranceFreshnessState | 'no_selected_evidence';
    currentObservationIds: readonly string[];
    staleObservationIds: readonly string[];
    unverifiableObservationIds: readonly string[];
  };
  immutableObservations: readonly Readonly<AssuranceEvidenceObservationInput & { observationHash: `sha256:${string}` }>[];
  attemptHistory: readonly Readonly<AssuredAttemptRecord>[];
  assuranceTrends: {
    direction: 'improving' | 'stable' | 'degrading' | 'not_comparable';
    history: readonly Readonly<AssuranceTrendSnapshot>[];
    current: Readonly<AssuranceTrendSnapshot>;
  };
  incidentObservations: readonly Readonly<AssuranceIncidentObservation>[];
  governedImprovementInputs: readonly Readonly<GovernedAssuranceImprovementInput>[];
  upstreamLifecycleFacts: Readonly<JsonObject>;
  authority: {
    dataProduct: 'read_only';
    lifecycle: 'none';
    merge: 'none';
    production: 'none';
    governanceBypass: false;
  };
  effects: {
    lifecycleStatusChanged: false;
    codeMerged: false;
    productionActionPerformed: false;
    governanceBypassed: false;
  };
}

interface ObservationSnapshot extends AssuranceEvidenceObservationInput {
  observationHash: `sha256:${string}`;
}

interface FreshnessEvaluation {
  state: AssuranceFreshnessState;
  ageSeconds: number | null;
}

function lexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort(lexical).filter((key) => object[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => clone(item)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])) as T;
  }
  return value;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function timestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${field} must be a valid timestamp.`);
  return parsed;
}

function positiveSeconds(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${field} must be a positive integer.`);
  return value;
}

function observationFreshness(
  observation: AssuranceEvidenceObservationInput,
  generatedAt: number,
  maximumAgeSeconds: number,
): FreshnessEvaluation {
  const observedAt = Date.parse(observation.observedAt);
  if (!Number.isFinite(observedAt) || observedAt > generatedAt) return { state: 'unverifiable', ageSeconds: null };
  const ageSeconds = Math.floor((generatedAt - observedAt) / 1_000);
  return { state: ageSeconds > maximumAgeSeconds ? 'stale' : 'current', ageSeconds };
}

function candidateBindingFindings(
  feature: AssuredFeatureBinding,
  plan: AssuredPlanBinding,
  candidate: AssuranceCandidateValidation,
): AssuredCandidateFinding[] {
  const findings = candidate.findings.map((finding) => ({
    code: `candidate:${finding.kind}`,
    message: finding.message,
    ...(finding.recordId ? { observationId: finding.recordId } : {}),
  }));
  const specification = candidate.identity.specificationRevision;
  if (!specification || specification.specId !== feature.specificationRevision.specId
      || specification.revision !== feature.specificationRevision.revision) {
    findings.push({ code: 'binding:feature-mismatch', message: 'The selected candidate does not bind the exact feature specification revision.' });
  }
  const candidatePlan = candidate.identity.plan;
  if (!candidatePlan || candidatePlan.planId !== plan.planId || candidatePlan.planVersion !== plan.planVersion) {
    findings.push({ code: 'binding:plan-mismatch', message: 'The selected candidate does not bind the exact assurance plan revision.' });
  }
  return findings;
}

function recoveryMatchesAttemptState(attempt: AssuranceDogfoodAttemptInput): boolean {
  const { kind, decision } = attempt.recoveryDecision;
  if (attempt.state === 'complete') {
    return (kind === 'initial' && decision === 'start_initial_attempt')
      || (kind === 'replay' && decision === 'reuse_complete_attempt')
      || (kind === 'restart' && decision === 'start_new_attempt');
  }
  if (attempt.state === 'partial') return kind === 'partial_failure' && decision === 'retain_partial_attempt';
  return kind === 'partial_failure' && decision === 'discard_failed_attempt';
}

function selectedCompleteAttempt(
  attempts: readonly AssuranceDogfoodAttemptInput[],
  candidateId: string,
  findings: AssuredCandidateFinding[],
): AssuranceDogfoodAttemptInput | null {
  const ids = new Set<string>();
  let duplicateId = false;
  for (const attempt of attempts) {
    if (ids.has(attempt.attemptId)) {
      duplicateId = true;
      findings.push({ code: 'attempt:duplicate-id', message: `Attempt ${JSON.stringify(attempt.attemptId)} is not unique.`, attemptId: attempt.attemptId });
    }
    ids.add(attempt.attemptId);
  }
  if (duplicateId) return null;
  for (const attempt of attempts) {
    if (attempt.recoveryDecision.attemptId !== attempt.attemptId || !recoveryMatchesAttemptState(attempt)) {
      findings.push({
        code: 'attempt:inconsistent-recovery-decision',
        message: `Attempt ${JSON.stringify(attempt.attemptId)} state ${JSON.stringify(attempt.state)} conflicts with its recovery decision.`,
        attemptId: attempt.attemptId,
      });
    }
  }
  const complete = attempts.filter((attempt) => attempt.state === 'complete' && attempt.candidateId === candidateId
    && attempt.recoveryDecision.attemptId === attempt.attemptId && recoveryMatchesAttemptState(attempt));
  if (complete.length === 0) {
    findings.push({ code: 'attempt:no-complete-attempt', message: 'No complete attempt exists for the selected candidate; partial and failed attempts are not promoted.' });
    return null;
  }
  const maximumSequence = Math.max(...complete.map((attempt) => attempt.sequence));
  const latest = complete.filter((attempt) => attempt.sequence === maximumSequence);
  if (latest.length !== 1) {
    findings.push({ code: 'attempt:ambiguous-complete-attempt', message: 'The latest complete attempt is ambiguous and cannot be selected.' });
    return null;
  }
  return latest[0]!;
}

function conditionFor(
  observation: ObservationSnapshot,
  selectedAttemptId: string | null,
  selectedObservationIds: ReadonlySet<string>,
  candidateIdentity: Partial<AssuranceCandidateIdentity> | null,
  obligation: AssuranceObligationInput,
  generatedAt: number,
  defaultMaximumAgeSeconds: number,
): AssuredEvidenceEvaluation {
  const included = selectedAttemptId === observation.attemptId && selectedObservationIds.has(observation.observationId);
  const subject = validateAssuranceSubject(candidateIdentity, obligation.evidenceRecordType, {
    recordId: observation.observationId,
    subject: observation.subject,
  });
  const freshness = observationFreshness(
    observation,
    generatedAt,
    obligation.maximumAgeSeconds ?? defaultMaximumAgeSeconds,
  );
  let outcome: AssuredEvidenceEvaluation['outcome'] = 'ignored_non_selected_attempt';
  if (included) {
    if (!subject.includedInSatisfaction || observation.evaluation === 'rejected') outcome = 'rejected';
    else if (freshness.state === 'stale') outcome = 'stale';
    else if (freshness.state === 'unverifiable' || observation.evaluation === 'insufficient') outcome = 'insufficient';
    else outcome = 'satisfied';
  }
  return {
    observationId: observation.observationId,
    obligationId: observation.obligationId,
    attemptId: observation.attemptId,
    subjectMatches: subject.includedInSatisfaction,
    submittedEvaluation: observation.evaluation,
    freshness: freshness.state,
    ageSeconds: freshness.ageSeconds,
    outcome,
  };
}

const CONDITION_ORDER: readonly AssuranceObligationOutcome[] = ['rejected', 'stale', 'insufficient'];

function obligationEvaluation(
  obligation: AssuranceObligationInput,
  evaluations: readonly AssuredEvidenceEvaluation[],
): AssuredObligationEvaluation {
  const applicable = evaluations.filter((evaluation) => evaluation.obligationId === obligation.obligationId
    && evaluation.outcome !== 'ignored_non_selected_attempt');
  const observedConditions = new Set(applicable.map((evaluation) => evaluation.outcome as AssuranceObligationOutcome));
  let outcome: AssuranceObligationOutcome = 'missing';
  if (observedConditions.has('satisfied')) outcome = 'satisfied';
  else outcome = CONDITION_ORDER.find((condition) => observedConditions.has(condition)) ?? 'missing';
  const conditionCodes = outcome === 'missing'
    ? ['missing' as const]
    : [...observedConditions].sort((left, right) => lexical(left, right));
  return {
    ...clone(obligation),
    outcome,
    conditionCodes,
    evidenceObservationIds: applicable.map((evaluation) => evaluation.observationId).sort(lexical),
  };
}

function trendDirection(
  previous: AssuranceTrendSnapshot | undefined,
  current: AssuranceTrendSnapshot,
): AssuredCandidate['assuranceTrends']['direction'] {
  if (!previous || previous.totalRequired <= 0 || current.totalRequired <= 0) return 'not_comparable';
  const previousRatio = previous.satisfied / previous.totalRequired;
  const currentRatio = current.satisfied / current.totalRequired;
  if (currentRatio > previousRatio) return 'improving';
  if (currentRatio < previousRatio) return 'degrading';
  return 'stable';
}

/**
 * Compile Rorca's dogfood assurance handoff. This function is deliberately pure:
 * it cannot mutate lifecycle state, merge code, perform production actions, or authorize evidence.
 */
export function compileFeatureAssuranceDogfood(input: FeatureAssuranceDogfoodInput): Readonly<AssuredCandidate> {
  const generatedAtEpoch = timestamp(input.generatedAt, 'generatedAt');
  const maximumEvidenceAgeSeconds = positiveSeconds(input.maximumEvidenceAgeSeconds, 'maximumEvidenceAgeSeconds');
  const candidate = validateAssuranceCandidate(input.candidate);
  const findings = candidateBindingFindings(input.feature, input.plan, candidate);
  const obligationIds = new Set<string>();
  let requiredObligationCount = 0;
  for (const obligation of input.obligations) {
    if (obligationIds.has(obligation.obligationId)) findings.push({
      code: 'obligation:duplicate-id',
      message: `Obligation ${JSON.stringify(obligation.obligationId)} is not unique.`,
      obligationId: obligation.obligationId,
    });
    obligationIds.add(obligation.obligationId);
    if (obligation.required) requiredObligationCount += 1;
  }
  if (requiredObligationCount === 0) findings.push({
    code: 'obligation:none-required',
    message: 'The bound assurance plan has no required obligations to satisfy.',
  });
  const selectedAttempt = selectedCompleteAttempt(input.attempts, candidate.candidateId, findings);
  const selectedObservationIds = new Set(selectedAttempt?.observationIds ?? []);
  const observations: ObservationSnapshot[] = input.observations.map((observation) => {
    const snapshot = clone(observation);
    return { ...snapshot, observationHash: digest(snapshot) };
  });
  const observationIds = new Map<string, number>();
  for (const observation of observations) {
    observationIds.set(observation.observationId, (observationIds.get(observation.observationId) ?? 0) + 1);
  }
  for (const [observationId, count] of observationIds) {
    if (count > 1) findings.push({
      code: 'observation:duplicate-id',
      message: `Observation ${JSON.stringify(observationId)} is not unique and cannot satisfy an obligation.`,
      observationId,
    });
  }
  for (const observation of observations) {
    if (!obligationIds.has(observation.obligationId)) findings.push({
      code: 'observation:unknown-obligation',
      message: `Observation ${JSON.stringify(observation.observationId)} references an unknown obligation.`,
      observationId: observation.observationId,
    });
  }
  if (selectedAttempt) {
    for (const observationId of selectedObservationIds) {
      if (!observationIds.has(observationId)) findings.push({
        code: 'attempt:observation-missing',
        message: `Selected attempt references missing observation ${JSON.stringify(observationId)}.`,
        observationId,
        attemptId: selectedAttempt.attemptId,
      });
    }
  }

  const evaluationOutcomes = input.obligations.flatMap((obligation) => observations
    .filter((observation) => observation.obligationId === obligation.obligationId)
    .map((observation) => conditionFor(
      observation,
      selectedAttempt?.attemptId ?? null,
      selectedObservationIds,
      candidate.identity,
      obligation,
      generatedAtEpoch,
      maximumEvidenceAgeSeconds,
    )));
  const obligations = input.obligations.map((obligation) => obligationEvaluation(obligation, evaluationOutcomes));
  for (const obligation of obligations) {
    if (obligation.required && obligation.outcome !== 'satisfied') findings.push({
      code: `obligation:${obligation.outcome}`,
      message: `Required obligation ${JSON.stringify(obligation.obligationId)} is ${obligation.outcome}.`,
      obligationId: obligation.obligationId,
    });
  }

  const evaluationByObservation = new Map(evaluationOutcomes.map((evaluation) => [evaluation.observationId, evaluation]));
  const evidenceLinks = observations.map((observation): AssuredEvidenceLink => {
    const evaluation = evaluationByObservation.get(observation.observationId);
    const includedInSelectedAttempt = selectedAttempt?.attemptId === observation.attemptId
      && selectedObservationIds.has(observation.observationId);
    return {
      ...clone(observation.evidence),
      observationId: observation.observationId,
      observationHash: observation.observationHash,
      attemptId: observation.attemptId,
      obligationId: observation.obligationId,
      includedInSelectedAttempt,
      eligibleForSatisfaction: includedInSelectedAttempt && evaluation?.outcome === 'satisfied'
        && observationIds.get(observation.observationId) === 1,
    };
  });
  const selectedEvaluations = evaluationOutcomes.filter((evaluation) => evaluation.outcome !== 'ignored_non_selected_attempt');
  const currentObservationIds = selectedEvaluations.filter((evaluation) => evaluation.freshness === 'current')
    .map((evaluation) => evaluation.observationId).sort(lexical);
  const staleObservationIds = selectedEvaluations.filter((evaluation) => evaluation.freshness === 'stale')
    .map((evaluation) => evaluation.observationId).sort(lexical);
  const unverifiableObservationIds = selectedEvaluations.filter((evaluation) => evaluation.freshness === 'unverifiable')
    .map((evaluation) => evaluation.observationId).sort(lexical);
  const overallFreshness = selectedEvaluations.length === 0
    ? 'no_selected_evidence' as const
    : unverifiableObservationIds.length > 0 ? 'unverifiable' as const
      : staleObservationIds.length > 0 ? 'stale' as const : 'current' as const;

  const attemptHistory = [...input.attempts].sort((left, right) => left.sequence - right.sequence || lexical(left.attemptId, right.attemptId))
    .map((attempt): AssuredAttemptRecord => ({
      ...clone(attempt),
      promotion: attempt === selectedAttempt
        ? 'selected_complete'
        : attempt.state === 'complete' ? 'complete_not_selected'
          : attempt.state === 'partial' ? 'partial_not_promoted' : 'failed_not_promoted',
    }));
  const incidentObservations = clone(input.incidents ?? []);
  const observationById = new Map(observations.map((observation) => [observation.observationId, observation]));
  const governedImprovementInputs = incidentObservations.map((incident): GovernedAssuranceImprovementInput => {
    const source = observationIds.get(incident.observationId) === 1
      ? observationById.get(incident.observationId)
      : undefined;
    if (!source) findings.push({
      code: 'incident:source-observation-invalid',
      message: `Incident ${JSON.stringify(incident.incidentId)} must reference exactly one immutable observation.`,
      observationId: incident.observationId,
    });
    const improvement = {
      sourceIncidentId: incident.incidentId,
      sourceObservationId: incident.observationId,
      sourceObservationHash: source?.observationHash ?? null,
      route: 'assurance-governance-review' as const,
      governanceState: source ? 'pending_governance' as const : 'rejected_invalid_source' as const,
      authority: 'none' as const,
      lifecycleMutation: false as const,
    };
    return { improvementInputId: digest(improvement), ...improvement };
  });

  const required = obligations.filter((obligation) => obligation.required);
  const satisfied = required.filter((obligation) => obligation.outcome === 'satisfied').length;
  const currentTrendMaterial = {
    featureId: input.feature.featureId,
    recordedAt: input.generatedAt,
    totalRequired: required.length,
    satisfied,
    unresolved: required.length - satisfied,
  };
  const currentTrend: AssuranceTrendSnapshot = {
    snapshotId: digest(currentTrendMaterial),
    ...currentTrendMaterial,
  };
  const priorTrends = [...clone(input.priorTrendSnapshots ?? [])].sort((left, right) =>
    lexical(left.recordedAt, right.recordedAt) || lexical(left.snapshotId, right.snapshotId));
  const comparablePrior = [...priorTrends].reverse().find((snapshot) => snapshot.featureId === input.feature.featureId);
  const revisionBindingHash = digest({
    feature: input.feature,
    plan: input.plan,
    candidateId: candidate.candidateId,
    candidateIdentity: candidate.identity,
    scopeIdentity: candidate.scope.scopeIdentity,
    selectedAttemptId: selectedAttempt?.attemptId ?? null,
  });
  const allSatisfied = findings.length === 0 && required.every((obligation) => obligation.outcome === 'satisfied');
  const body = {
    schemaVersion: ASSURED_CANDIDATE_VERSION,
    generatedAt: input.generatedAt,
    revisionBindingHash,
    outcome: allSatisfied ? 'all_satisfied' as const : 'not_all_satisfied' as const,
    allSatisfied,
    selectedAttemptId: selectedAttempt?.attemptId ?? null,
    boundFeature: clone(input.feature),
    boundPlan: clone(input.plan),
    candidate: clone(candidate),
    obligations,
    evidenceLinks,
    evaluationOutcomes,
    unresolvedFindings: findings,
    freshness: {
      asOf: input.generatedAt,
      maximumEvidenceAgeSeconds,
      overall: overallFreshness,
      currentObservationIds,
      staleObservationIds,
      unverifiableObservationIds,
    },
    immutableObservations: observations,
    attemptHistory,
    assuranceTrends: {
      direction: trendDirection(comparablePrior, currentTrend),
      history: [...priorTrends, currentTrend],
      current: currentTrend,
    },
    incidentObservations,
    governedImprovementInputs,
    upstreamLifecycleFacts: clone(input.upstreamLifecycleFacts),
    authority: {
      dataProduct: 'read_only' as const,
      lifecycle: 'none' as const,
      merge: 'none' as const,
      production: 'none' as const,
      governanceBypass: false as const,
    },
    effects: {
      lifecycleStatusChanged: false as const,
      codeMerged: false as const,
      productionActionPerformed: false as const,
      governanceBypassed: false as const,
    },
  };
  return deepFreeze({ handoffId: digest(body), ...body });
}
