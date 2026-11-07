/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createHash } from 'node:crypto';
import {
  ASSURANCE_CANDIDATE_IDENTITY_FIELDS,
  validateAssuranceSubject,
  type AssuranceCandidateIdentity,
} from './assurance-candidate';

export const FEATURE_ASSURANCE_REVIEW_VERSION = 'rorca.feature-assurance-review.v1' as const;

export const FEATURE_ASSURANCE_REVIEW_AXES = ['standards', 'design', 'adversarial'] as const;
export type FeatureAssuranceReviewAxis = typeof FEATURE_ASSURANCE_REVIEW_AXES[number];

export const FEATURE_ASSURANCE_REVIEW_TRUST_STATES = [
  'independent', 'self-review', 'stale-review', 'unattributed-review',
] as const;
export type FeatureAssuranceReviewTrustState = typeof FEATURE_ASSURANCE_REVIEW_TRUST_STATES[number];

export const ADVERSARIAL_ASSURANCE_DETECTIONS = [
  'story-pass-without-tests',
  'stale-replay',
  'wrong-subject-evidence',
  'fake-output',
  'weakened-assertions',
  'missing-negative-coverage',
  'scope-expansion',
] as const;
export type AdversarialAssuranceDetection = typeof ADVERSARIAL_ASSURANCE_DETECTIONS[number];

export type FeatureAssuranceFindingDetection =
  | AdversarialAssuranceDetection
  | 'standards-nonconformance'
  | 'design-risk'
  | 'review-unresolved';
export type FeatureAssuranceFindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type FeatureAssuranceFindingDisposition = 'open' | 'resolved' | 'accepted-risk' | 'unresolved';
export type FeatureAssuranceReviewFreshness = 'current' | 'stale' | 'unverifiable';

const FINDING_DETECTIONS_BY_AXIS: Readonly<Record<
  FeatureAssuranceReviewAxis,
  Readonly<Partial<Record<FeatureAssuranceFindingDetection, true>>>
>> = {
  standards: { 'standards-nonconformance': true, 'review-unresolved': true },
  design: { 'design-risk': true, 'review-unresolved': true },
  adversarial: {
    'story-pass-without-tests': true,
    'stale-replay': true,
    'wrong-subject-evidence': true,
    'fake-output': true,
    'weakened-assertions': true,
    'missing-negative-coverage': true,
    'scope-expansion': true,
    'review-unresolved': true,
  },
};
const FEATURE_ASSURANCE_FINDING_SEVERITIES: Readonly<Record<FeatureAssuranceFindingSeverity, true>> = {
  critical: true,
  high: true,
  medium: true,
  low: true,
  info: true,
};
const FEATURE_ASSURANCE_FINDING_DISPOSITIONS: Readonly<Record<FeatureAssuranceFindingDisposition, true>> = {
  open: true,
  resolved: true,
  'accepted-risk': true,
  unresolved: true,
};

export interface FeatureAssuranceSourceLocation {
  path: string;
  startLine: number;
  endLine: number;
  startColumn?: number;
  endColumn?: number;
}

export interface FeatureAssuranceReviewSubjectInput {
  featureId: string;
  candidate: AssuranceCandidateIdentity;
  workPackageId: string;
  workPackageRevision: number;
  workPackageHash: string;
  sourceLocations: readonly FeatureAssuranceSourceLocation[];
  changedPaths: readonly string[];
  requiredTestObligationIds?: readonly string[];
  baselineAssertionIds?: readonly string[];
  requiredNegativeScenarioIds?: readonly string[];
}

/** Exact immutable input presented to every review axis. */
export interface FeatureAssuranceReviewSubject extends FeatureAssuranceReviewSubjectInput {
  subjectId: `sha256:${string}`;
  sourceLocations: readonly FeatureAssuranceSourceLocation[];
  changedPaths: readonly string[];
  requiredTestObligationIds: readonly string[];
  baselineAssertionIds: readonly string[];
  requiredNegativeScenarioIds: readonly string[];
}

export interface FeatureAssuranceReviewerProvenance {
  reviewerId: string;
  reviewerKind: 'human' | 'agent';
  executionId: string;
  model?: string;
}

export interface FeatureAssuranceFindingDraft {
  detection: FeatureAssuranceFindingDetection;
  title: string;
  description: string;
  severity: FeatureAssuranceFindingSeverity;
  disposition: FeatureAssuranceFindingDisposition;
  sourceLocations: readonly FeatureAssuranceSourceLocation[];
}

export interface FeatureAssuranceReviewSubmission {
  reviewId: string;
  axis: FeatureAssuranceReviewAxis;
  subjectId: string;
  subject: Partial<AssuranceCandidateIdentity> | null;
  reviewer: FeatureAssuranceReviewerProvenance;
  startedAt: string;
  completedAt: string;
  reviewedSourceLocations: readonly FeatureAssuranceSourceLocation[];
  findings: readonly FeatureAssuranceFindingDraft[];
}

export interface FeatureAssuranceReviewFinding extends FeatureAssuranceFindingDraft {
  findingId: `sha256:${string}`;
  axis: FeatureAssuranceReviewAxis;
  subjectId: `sha256:${string}`;
  freshness: FeatureAssuranceReviewFreshness;
  reviewer: FeatureAssuranceReviewerProvenance;
  sourceLocations: readonly FeatureAssuranceSourceLocation[];
}

export interface FeatureAssuranceReviewEvidence {
  schemaVersion: typeof FEATURE_ASSURANCE_REVIEW_VERSION;
  reviewId: string;
  axis: FeatureAssuranceReviewAxis;
  subjectId: `sha256:${string}`;
  submittedSubjectId: string;
  subjectMatches: boolean;
  reviewedSourceLocations: readonly FeatureAssuranceSourceLocation[];
  startedAt: string;
  completedAt: string;
  freshness: FeatureAssuranceReviewFreshness;
  trustState: FeatureAssuranceReviewTrustState;
  reviewer: FeatureAssuranceReviewerProvenance;
  findings: readonly FeatureAssuranceReviewFinding[];
  evidenceUsable: boolean;
  issues: readonly string[];
  evidencePurpose: 'inspection';
  authorization: 'none';
}

export interface FeatureAssuranceReviewAxisView {
  axis: FeatureAssuranceReviewAxis;
  required: boolean;
  evidenceState: 'available' | 'insufficient_evidence';
  independentReviewCount: number;
  reviews: readonly FeatureAssuranceReviewEvidence[];
}

export interface FeatureAssuranceReviewView {
  schemaVersion: typeof FEATURE_ASSURANCE_REVIEW_VERSION;
  subjectId: `sha256:${string}`;
  independentReviewRequired: boolean;
  requiredAxes: readonly FeatureAssuranceReviewAxis[];
  evidenceState: 'available' | 'insufficient_evidence';
  reason: string;
  axes: readonly FeatureAssuranceReviewAxisView[];
  trustStateCounts: Readonly<Record<FeatureAssuranceReviewTrustState, number>>;
  readOnly: true;
  approvalIssued: false;
  authorization: 'none';
}

export interface AdversarialTestObservation {
  recordId: string;
  subjectId: string;
  obligationIds: readonly string[];
  rawOutput: string;
  outputDigest: string;
  assertionIds: readonly string[];
  negativeScenarioIds: readonly string[];
  location: FeatureAssuranceSourceLocation;
}

export interface AdversarialReviewObservations {
  storyOutcome?: { status: string; location: FeatureAssuranceSourceLocation };
  testExecutions?: readonly AdversarialTestObservation[];
  replayedReview?: { subjectId: string; completedAt: string; location: FeatureAssuranceSourceLocation };
  evidenceSubjects?: readonly { evidenceId: string; subjectId: string; location: FeatureAssuranceSourceLocation }[];
  assertionInventory?: {
    baselineAssertionIds: readonly string[];
    currentAssertionIds: readonly string[];
    location: FeatureAssuranceSourceLocation;
  };
  negativeCoverage?: {
    requiredScenarioIds: readonly string[];
    coveredScenarioIds: readonly string[];
    location: FeatureAssuranceSourceLocation;
  };
  observedScope?: { changedPaths: readonly string[]; manifestLocation: FeatureAssuranceSourceLocation };
}

export interface AdversarialFeatureAssuranceReviewInput {
  reviewId: string;
  subject: FeatureAssuranceReviewSubject;
  reviewer: FeatureAssuranceReviewerProvenance;
  startedAt: string;
  completedAt: string;
  observedAt: string;
  maximumEvidenceAgeSeconds: number;
  requestedDetections: readonly AdversarialAssuranceDetection[];
  observations: AdversarialReviewObservations;
}

function lexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => lexical(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

function sortedUnique(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map(text).filter(Boolean))].sort(lexical);
}

function repositoryPath(value: unknown): string | null {
  const path = text(value).replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/\/{2,}/g, '/').replace(/\/$/, '');
  if (!path || path.startsWith('/') || /^[A-Za-z]:\//.test(path) || path.includes('\0')) return null;
  if (path.split('/').some((part) => part === '.' || part === '..')) return null;
  return path;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function normalizeLocation(value: FeatureAssuranceSourceLocation): FeatureAssuranceSourceLocation | null {
  const path = repositoryPath(value?.path);
  const startLine = positiveInteger(value?.startLine);
  const endLine = positiveInteger(value?.endLine);
  const startColumn = value?.startColumn === undefined ? undefined : positiveInteger(value.startColumn);
  const endColumn = value?.endColumn === undefined ? undefined : positiveInteger(value.endColumn);
  if (!path || !startLine || !endLine || endLine < startLine || startColumn === null || endColumn === null) return null;
  if (startLine === endLine && startColumn !== undefined && endColumn !== undefined && endColumn < startColumn) return null;
  return {
    path,
    startLine,
    endLine,
    ...(startColumn === undefined ? {} : { startColumn }),
    ...(endColumn === undefined ? {} : { endColumn }),
  };
}

function locationKey(location: FeatureAssuranceSourceLocation): string {
  return [location.path, location.startLine, location.endLine, location.startColumn ?? 0, location.endColumn ?? 0].join(':');
}

function normalizedLocations(values: readonly FeatureAssuranceSourceLocation[]): FeatureAssuranceSourceLocation[] | null {
  const byKey = new Map<string, FeatureAssuranceSourceLocation>();
  for (const value of values) {
    const location = normalizeLocation(value);
    if (!location) return null;
    byKey.set(locationKey(location), location);
  }
  return [...byKey.values()].sort((left, right) => lexical(locationKey(left), locationKey(right)));
}

function withinLocation(location: FeatureAssuranceSourceLocation, bound: FeatureAssuranceSourceLocation): boolean {
  if (location.path !== bound.path || location.startLine < bound.startLine || location.endLine > bound.endLine) return false;
  if (location.startLine === bound.startLine && bound.startColumn !== undefined
    && (location.startColumn === undefined || location.startColumn < bound.startColumn)) return false;
  if (location.endLine === bound.endLine && bound.endColumn !== undefined
    && (location.endColumn === undefined || location.endColumn > bound.endColumn)) return false;
  return true;
}

function locationsWithin(
  locations: readonly FeatureAssuranceSourceLocation[],
  bounds: readonly FeatureAssuranceSourceLocation[],
): boolean {
  return locations.every((location) => bounds.some((bound) => withinLocation(location, bound)));
}

function completeCandidate(value: Partial<AssuranceCandidateIdentity> | null | undefined): value is AssuranceCandidateIdentity {
  if (!value || ASSURANCE_CANDIDATE_IDENTITY_FIELDS.some((field) => value[field] === undefined)) return false;
  return Boolean(
    text(value.specificationRevision?.specId)
    && text(value.specificationRevision?.revision)
    && text(value.plan?.planId)
    && positiveInteger(value.plan?.planVersion)
    && text(value.commit)
    && text(value.tree)
    && text(value.diff)
    && text(value.scope),
  );
}

function parseTimestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}

function completeReviewer(value: FeatureAssuranceReviewerProvenance | null | undefined): boolean {
  return Boolean(
    value
    && text(value.reviewerId)
    && (value.reviewerKind === 'human' || value.reviewerKind === 'agent')
    && text(value.executionId),
  );
}

function exactSubject(
  subject: FeatureAssuranceReviewSubject,
  review: FeatureAssuranceReviewSubmission,
): boolean {
  return review.subjectId === subject.subjectId
    && validateAssuranceSubject(subject.candidate, 'artifact', {
      recordId: review.reviewId,
      subject: review.subject,
    }).includedInSatisfaction;
}

function findingId(
  reviewId: string,
  subjectId: string,
  axis: FeatureAssuranceReviewAxis,
  draft: FeatureAssuranceFindingDraft,
): `sha256:${string}` {
  return digest({ reviewId, subjectId, axis, draft });
}

function finding(
  subject: FeatureAssuranceReviewSubject,
  submission: FeatureAssuranceReviewSubmission,
  draft: FeatureAssuranceFindingDraft,
  locations: readonly FeatureAssuranceSourceLocation[],
  freshness: FeatureAssuranceReviewFreshness,
): FeatureAssuranceReviewFinding {
  const normalized = { ...draft, sourceLocations: locations };
  return {
    ...normalized,
    findingId: findingId(submission.reviewId, subject.subjectId, submission.axis, normalized),
    axis: submission.axis,
    subjectId: subject.subjectId,
    freshness,
    reviewer: { ...submission.reviewer },
  };
}

/** Create the exact revision-, work-package-, and source-range-bound review subject. */
export function createFeatureAssuranceReviewSubject(
  input: FeatureAssuranceReviewSubjectInput,
): Readonly<FeatureAssuranceReviewSubject> {
  if (!text(input.featureId)) throw new TypeError('featureId is required.');
  if (!completeCandidate(input.candidate)) throw new TypeError('candidate must contain the complete assurance identity.');
  if (!text(input.workPackageId) || !positiveInteger(input.workPackageRevision) || !text(input.workPackageHash)) {
    throw new TypeError('complete work-package identity is required.');
  }
  const sourceLocations = normalizedLocations(input.sourceLocations);
  if (!sourceLocations?.length) throw new TypeError('at least one exact source location is required.');
  const changedPaths = sortedUnique(input.changedPaths);
  if (changedPaths.length === 0 || changedPaths.some((path) => repositoryPath(path) !== path)) {
    throw new TypeError('changedPaths must contain canonical repository-relative paths.');
  }
  const body = {
    featureId: text(input.featureId),
    candidate: {
      specificationRevision: { ...input.candidate.specificationRevision },
      plan: { ...input.candidate.plan },
      commit: input.candidate.commit,
      tree: input.candidate.tree,
      diff: input.candidate.diff,
      scope: input.candidate.scope,
    },
    workPackageId: text(input.workPackageId),
    workPackageRevision: input.workPackageRevision,
    workPackageHash: text(input.workPackageHash),
    sourceLocations,
    changedPaths,
    requiredTestObligationIds: sortedUnique(input.requiredTestObligationIds),
    baselineAssertionIds: sortedUnique(input.baselineAssertionIds),
    requiredNegativeScenarioIds: sortedUnique(input.requiredNegativeScenarioIds),
  };
  return deepFreeze({ ...body, subjectId: digest(body) });
}

/**
 * Record one reviewer output as inspection evidence. Invalid, self-issued, and stale
 * output stays visible but cannot satisfy an independent-review requirement.
 */
export function recordFeatureAssuranceReview(input: {
  subject: FeatureAssuranceReviewSubject;
  implementerId: string;
  observedAt: string;
  maximumEvidenceAgeSeconds: number;
  submission: FeatureAssuranceReviewSubmission;
}): Readonly<FeatureAssuranceReviewEvidence> {
  const { subject, submission } = input;
  const issues: string[] = [];
  const implementerId = text(input.implementerId);
  const reviewedLocations = normalizedLocations(submission.reviewedSourceLocations);
  const startedAt = parseTimestamp(submission.startedAt);
  const completedAt = parseTimestamp(submission.completedAt);
  const observedAt = parseTimestamp(input.observedAt);
  const validAge = Number.isSafeInteger(input.maximumEvidenceAgeSeconds) && input.maximumEvidenceAgeSeconds >= 0;
  const subjectMatches = exactSubject(subject, submission);

  if (!text(submission.reviewId)) issues.push('reviewId is required.');
  if (!FEATURE_ASSURANCE_REVIEW_AXES.includes(submission.axis)) issues.push('review axis is invalid.');
  if (!completeReviewer(submission.reviewer)) issues.push('reviewer provenance is incomplete.');
  if (!implementerId) issues.push('implementer identity is required to establish reviewer independence.');
  if (!reviewedLocations?.length) issues.push('at least one exact reviewed source location is required.');
  else if (!locationsWithin(reviewedLocations, subject.sourceLocations)) issues.push('reviewed source location is outside the bounded subject.');
  if (startedAt === null || completedAt === null || completedAt < startedAt) issues.push('review timestamps are invalid.');
  if (observedAt === null || !validAge) issues.push('freshness policy is invalid.');
  if (!subjectMatches) issues.push('review does not bind the exact current subject.');

  let freshness: FeatureAssuranceReviewFreshness = 'unverifiable';
  if (completedAt !== null && observedAt !== null && validAge) {
    const ageSeconds = (observedAt - completedAt) / 1000;
    freshness = subjectMatches && ageSeconds >= 0 && ageSeconds <= input.maximumEvidenceAgeSeconds ? 'current' : 'stale';
  }

  const normalizedReviewedLocations = reviewedLocations ?? [];
  const findings: FeatureAssuranceReviewFinding[] = [];
  for (const draft of submission.findings) {
    const locations = normalizedLocations(draft.sourceLocations);
    if (!text(draft.title) || !text(draft.description)) {
      issues.push(`finding ${JSON.stringify(draft.detection)} is missing title or description.`);
      continue;
    }
    const allowedDetections: Readonly<Partial<Record<FeatureAssuranceFindingDetection, true>>> | undefined = FINDING_DETECTIONS_BY_AXIS[submission.axis];
    if (!allowedDetections || !Object.hasOwn(allowedDetections, draft.detection)) {
      issues.push(`finding ${JSON.stringify(draft.detection)} is invalid for ${submission.axis} review.`);
      continue;
    }
    if (!Object.hasOwn(FEATURE_ASSURANCE_FINDING_SEVERITIES, draft.severity)) {
      issues.push(`finding ${JSON.stringify(draft.detection)} has invalid severity ${JSON.stringify(draft.severity)}.`);
      continue;
    }
    if (!Object.hasOwn(FEATURE_ASSURANCE_FINDING_DISPOSITIONS, draft.disposition)) {
      issues.push(`finding ${JSON.stringify(draft.detection)} has invalid disposition ${JSON.stringify(draft.disposition)}.`);
      continue;
    }
    if (!locations?.length || !locationsWithin(locations, normalizedReviewedLocations)) {
      issues.push(`finding ${JSON.stringify(draft.detection)} lacks an exact location within reviewed source.`);
      continue;
    }
    findings.push(finding(subject, submission, draft, locations, freshness));
  }

  let trustState: FeatureAssuranceReviewTrustState;
  if (freshness === 'stale') trustState = 'stale-review';
  else if (!completeReviewer(submission.reviewer) || freshness === 'unverifiable' || !implementerId) trustState = 'unattributed-review';
  else if (text(submission.reviewer.reviewerId) === implementerId) trustState = 'self-review';
  else trustState = 'independent';

  return deepFreeze({
    schemaVersion: FEATURE_ASSURANCE_REVIEW_VERSION,
    reviewId: text(submission.reviewId) || 'unidentified-review',
    axis: submission.axis,
    subjectId: subject.subjectId,
    submittedSubjectId: submission.subjectId,
    subjectMatches,
    reviewedSourceLocations: normalizedReviewedLocations,
    startedAt: submission.startedAt,
    completedAt: submission.completedAt,
    freshness,
    trustState,
    reviewer: { ...submission.reviewer },
    findings,
    evidenceUsable: issues.length === 0 && freshness === 'current',
    issues,
    evidencePurpose: 'inspection',
    authorization: 'none',
  });
}

/** Build the read-only per-axis trust projection used by the Feature Assurance review view. */
export function buildFeatureAssuranceReviewView(input: {
  subject: FeatureAssuranceReviewSubject;
  implementerId: string;
  observedAt: string;
  maximumEvidenceAgeSeconds: number;
  independentReviewRequired: boolean;
  requiredAxes?: readonly FeatureAssuranceReviewAxis[];
  submissions: readonly FeatureAssuranceReviewSubmission[];
}): Readonly<FeatureAssuranceReviewView> {
  const requiredAxes = [...new Set(input.requiredAxes ?? FEATURE_ASSURANCE_REVIEW_AXES)]
    .filter((axis): axis is FeatureAssuranceReviewAxis => FEATURE_ASSURANCE_REVIEW_AXES.includes(axis))
    .sort(lexical);
  const records = input.submissions.map((submission) => recordFeatureAssuranceReview({ ...input, submission }));
  const axes = FEATURE_ASSURANCE_REVIEW_AXES.map((axis): FeatureAssuranceReviewAxisView => {
    const reviews = records.filter((review) => review.axis === axis);
    const independentReviewCount = reviews.filter((review) => review.evidenceUsable && review.trustState === 'independent').length;
    const required = input.independentReviewRequired && requiredAxes.includes(axis);
    return {
      axis,
      required,
      evidenceState: required && independentReviewCount === 0 ? 'insufficient_evidence' : 'available',
      independentReviewCount,
      reviews,
    };
  });
  const missingAxes = axes.filter((axis) => axis.evidenceState === 'insufficient_evidence').map((axis) => axis.axis);
  const trustStateCounts = Object.fromEntries(FEATURE_ASSURANCE_REVIEW_TRUST_STATES.map((state) => [
    state,
    records.filter((review) => review.trustState === state).length,
  ])) as Record<FeatureAssuranceReviewTrustState, number>;

  return deepFreeze({
    schemaVersion: FEATURE_ASSURANCE_REVIEW_VERSION,
    subjectId: input.subject.subjectId,
    independentReviewRequired: input.independentReviewRequired,
    requiredAxes,
    evidenceState: missingAxes.length > 0 ? 'insufficient_evidence' : 'available',
    reason: missingAxes.length > 0
      ? `Independent review evidence is unavailable for required axes: ${missingAxes.join(', ')}.`
      : 'Required independent review evidence is available for inspection.',
    axes,
    trustStateCounts,
    readOnly: true,
    approvalIssued: false,
    authorization: 'none',
  });
}

function unresolvedFinding(
  detection: AdversarialAssuranceDetection,
  location: FeatureAssuranceSourceLocation,
): FeatureAssuranceFindingDraft {
  return {
    detection,
    title: `${detection} could not be resolved`,
    description: `The bounded review input does not contain inspectable observations needed to resolve ${detection}.`,
    severity: 'medium',
    disposition: 'unresolved',
    sourceLocations: [location],
  };
}

function detectedFinding(
  detection: AdversarialAssuranceDetection,
  description: string,
  location: FeatureAssuranceSourceLocation,
  severity: FeatureAssuranceFindingSeverity = 'high',
): FeatureAssuranceFindingDraft {
  return {
    detection,
    title: detection,
    description,
    severity,
    disposition: 'open',
    sourceLocations: [location],
  };
}

function missing(values: readonly string[], observed: ReadonlySet<string>): string[] {
  return values.filter((value) => !observed.has(value));
}

function adversarialFinding(
  detection: AdversarialAssuranceDetection,
  input: AdversarialFeatureAssuranceReviewInput,
): FeatureAssuranceFindingDraft | null {
  const { subject, observations } = input;
  const fallback = subject.sourceLocations[0];
  if (!fallback) throw new TypeError('adversarial review subject has no source location.');

  if (detection === 'story-pass-without-tests') {
    if (!observations.storyOutcome || !observations.testExecutions) return unresolvedFinding(detection, fallback);
    if (observations.storyOutcome.status !== 'passed') return null;
    const covered = new Set(observations.testExecutions
      .filter((execution) => execution.subjectId === subject.subjectId)
      .flatMap((execution) => execution.obligationIds));
    const uncovered = missing(subject.requiredTestObligationIds, covered);
    return uncovered.length > 0
      ? detectedFinding(detection, `Story is marked passed without current test evidence for: ${uncovered.join(', ')}.`, observations.storyOutcome.location, 'critical')
      : null;
  }

  if (detection === 'stale-replay') {
    const replay = observations.replayedReview;
    if (!replay) return unresolvedFinding(detection, fallback);
    const replayedAt = parseTimestamp(replay.completedAt);
    const observedAt = parseTimestamp(input.observedAt);
    const age = replayedAt === null || observedAt === null ? Number.POSITIVE_INFINITY : (observedAt - replayedAt) / 1000;
    return replay.subjectId !== subject.subjectId || age < 0 || age > input.maximumEvidenceAgeSeconds
      ? detectedFinding(detection, 'Replayed review evidence is stale or belongs to another bounded subject.', replay.location)
      : null;
  }

  if (detection === 'wrong-subject-evidence') {
    const evidence = observations.evidenceSubjects;
    if (!evidence) return unresolvedFinding(detection, fallback);
    const wrong = evidence.filter((item) => item.subjectId !== subject.subjectId);
    return wrong.length > 0
      ? detectedFinding(detection, `Evidence is bound to another subject: ${wrong.map((item) => item.evidenceId).join(', ')}.`, wrong[0]?.location ?? fallback, 'critical')
      : null;
  }

  if (detection === 'fake-output') {
    const executions = observations.testExecutions;
    if (!executions) return unresolvedFinding(detection, fallback);
    const fake = executions.find((execution) => (
      execution.outputDigest !== `sha256:${createHash('sha256').update(execution.rawOutput).digest('hex')}`
    ));
    return fake
      ? detectedFinding(detection, `Output digest does not authenticate the captured output for ${fake.recordId}.`, fake.location, 'critical')
      : null;
  }

  if (detection === 'weakened-assertions') {
    const inventory = observations.assertionInventory;
    if (!inventory) return unresolvedFinding(detection, fallback);
    const baseline = sortedUnique([...subject.baselineAssertionIds, ...inventory.baselineAssertionIds]);
    const weakened = missing(baseline, new Set(inventory.currentAssertionIds));
    return weakened.length > 0
      ? detectedFinding(detection, `Current tests removed or weakened required assertions: ${weakened.join(', ')}.`, inventory.location)
      : null;
  }

  if (detection === 'missing-negative-coverage') {
    const coverage = observations.negativeCoverage;
    if (!coverage) return unresolvedFinding(detection, fallback);
    const required = sortedUnique([...subject.requiredNegativeScenarioIds, ...coverage.requiredScenarioIds]);
    const uncovered = missing(required, new Set(coverage.coveredScenarioIds));
    return uncovered.length > 0
      ? detectedFinding(detection, `Required negative scenarios are not covered: ${uncovered.join(', ')}.`, coverage.location)
      : null;
  }

  const scope = observations.observedScope;
  if (!scope) return unresolvedFinding(detection, fallback);
  const expanded = sortedUnique(scope.changedPaths).filter((path) => !subject.changedPaths.includes(path));
  return expanded.length > 0
    ? detectedFinding(detection, `Observed changes exceed the bounded subject: ${expanded.join(', ')}.`, scope.manifestLocation, 'critical')
    : null;
}

/** Execute deterministic adversarial checks over explicit, inspectable fixture/host observations. */
export function runAdversarialFeatureAssuranceReview(
  input: AdversarialFeatureAssuranceReviewInput,
): FeatureAssuranceReviewSubmission {
  const requested = [...new Set(input.requestedDetections)]
    .filter((detection): detection is AdversarialAssuranceDetection => ADVERSARIAL_ASSURANCE_DETECTIONS.includes(detection))
    .sort(lexical);
  const findings = requested.flatMap((detection) => {
    const value = adversarialFinding(detection, input);
    return value ? [value] : [];
  });
  return {
    reviewId: input.reviewId,
    axis: 'adversarial',
    subjectId: input.subject.subjectId,
    subject: input.subject.candidate,
    reviewer: input.reviewer,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    reviewedSourceLocations: input.subject.sourceLocations,
    findings,
  };
}
