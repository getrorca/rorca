/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createHash } from 'node:crypto';

export const ASSURANCE_CANDIDATE_IDENTITY_FIELDS = [
  'specificationRevision',
  'plan',
  'commit',
  'tree',
  'diff',
  'scope',
] as const;

export type AssuranceCandidateIdentityField = typeof ASSURANCE_CANDIDATE_IDENTITY_FIELDS[number];
export type AssuranceSubjectRecordType = 'evidence' | 'decision' | 'test-execution' | 'artifact';
export type AssurancePathCategory = 'changed' | 'required' | 'allowed' | 'forbidden';

export interface AssuranceSpecificationRevisionIdentity {
  specId: string;
  revision: string;
}

export interface AssurancePlanIdentity {
  planId: string;
  planVersion: number;
}

/** The complete immutable subject shared by a candidate and every bound observation. */
export interface AssuranceCandidateIdentity {
  specificationRevision: AssuranceSpecificationRevisionIdentity;
  plan: AssurancePlanIdentity;
  commit: string;
  tree: string;
  diff: string;
  scope: string;
}

export interface AssuranceWorkPackageScope {
  workPackageId: string;
  workPackageRevision: number;
  workPackageHash: string;
  changedPaths: readonly string[];
  requiredPaths: readonly string[];
  allowedPaths: readonly string[];
  forbiddenPaths: readonly string[];
}

export interface CandidateBoundSubjectRecord {
  recordId: string;
  subject: Partial<AssuranceCandidateIdentity> | null;
}

export interface AssuranceCandidateInput {
  candidateId: string;
  identity: Partial<AssuranceCandidateIdentity> | null;
  scope: AssuranceWorkPackageScope;
  evidence?: readonly CandidateBoundSubjectRecord[];
  decisions?: readonly CandidateBoundSubjectRecord[];
  testExecutions?: readonly CandidateBoundSubjectRecord[];
  producedArtifacts?: readonly CandidateBoundSubjectRecord[];
}

export type AssuranceCandidateFindingKind =
  | 'missing-identity'
  | 'scope-identity-mismatch'
  | 'invalid-scope'
  | 'invalid-scope-path'
  | 'unexpected-path'
  | 'forbidden-path'
  | 'missing-path'
  | 'rejected-subject';

export interface AssuranceCandidateFinding {
  kind: AssuranceCandidateFindingKind;
  message: string;
  field?: AssuranceCandidateIdentityField;
  path?: string;
  pathCategory?: AssurancePathCategory;
  recordType?: AssuranceSubjectRecordType;
  recordId?: string;
  mismatchedFields?: AssuranceCandidateIdentityField[];
}

export interface InvalidAssuranceScopePath {
  category: AssurancePathCategory;
  path: string;
  reason: string;
}

export interface AssuranceScopeEvaluation {
  valid: boolean;
  workPackage: {
    workPackageId: string | null;
    workPackageRevision: number | null;
    workPackageHash: string | null;
  };
  scopeIdentity: `sha256:${string}`;
  changedPaths: string[];
  requiredPaths: string[];
  allowedPaths: string[];
  forbiddenPaths: string[];
  unexpectedPaths: string[];
  forbiddenChangedPaths: string[];
  missingPaths: string[];
  invalidPaths: InvalidAssuranceScopePath[];
  findings: AssuranceCandidateFinding[];
}

export interface AssuranceSubjectValidation {
  recordType: AssuranceSubjectRecordType;
  recordId: string;
  status: 'accepted-subject' | 'rejected-subject';
  includedInSatisfaction: boolean;
  mismatchedFields: AssuranceCandidateIdentityField[];
  finding: AssuranceCandidateFinding | null;
}

export interface AssuranceCandidateValidation {
  candidateId: string;
  valid: boolean;
  status: 'accepted' | 'rejected';
  identity: Partial<AssuranceCandidateIdentity>;
  scope: AssuranceScopeEvaluation;
  subjectResults: {
    evidence: AssuranceSubjectValidation[];
    decisions: AssuranceSubjectValidation[];
    testExecutions: AssuranceSubjectValidation[];
    producedArtifacts: AssuranceSubjectValidation[];
  };
  satisfiedRecordIds: {
    evidence: string[];
    decisions: string[];
    testExecutions: string[];
    producedArtifacts: string[];
  };
  findings: AssuranceCandidateFinding[];
}

type NormalizedPath = { path: string; valid: boolean; reason: string | null };
type NormalizedPathList = { present: boolean; paths: string[]; validPaths: string[]; invalidPaths: InvalidAssuranceScopePath[] };

interface NormalizedScope {
  workPackageId: string | null;
  workPackageRevision: number | null;
  workPackageHash: string | null;
  changed: NormalizedPathList;
  required: NormalizedPathList;
  allowed: NormalizedPathList;
  forbidden: NormalizedPathList;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function normalizedPath(value: unknown): NormalizedPath {
  if (typeof value !== 'string') {
    return { path: `<non-string:${typeof value}>`, valid: false, reason: 'path must be a string' };
  }
  const path = value.trim()
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/$/, '');
  if (!path) return { path, valid: false, reason: 'path must not be empty' };
  if (path.includes('\0')) return { path, valid: false, reason: 'path must not contain a null byte' };
  if (path.startsWith('/') || /^[A-Za-z]:\//.test(path)) {
    return { path, valid: false, reason: 'path must be repository-relative' };
  }
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) {
    return { path, valid: false, reason: 'path must not traverse the repository' };
  }
  return { path, valid: true, reason: null };
}

function normalizedPathList(value: unknown, category: AssurancePathCategory): NormalizedPathList {
  const present = Array.isArray(value);
  const values = present ? value : [];
  const byPath = new Map<string, NormalizedPath>();
  for (const item of values) {
    const normalized = normalizedPath(item);
    const prior = byPath.get(normalized.path);
    if (!prior || (!normalized.valid && prior.valid)) byPath.set(normalized.path, normalized);
  }
  const normalized = [...byPath.values()].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return {
    present,
    paths: normalized.map((item) => item.path),
    validPaths: normalized.filter((item) => item.valid).map((item) => item.path),
    invalidPaths: normalized
      .filter((item): item is NormalizedPath & { reason: string } => !item.valid && item.reason !== null)
      .map((item) => ({ category, path: item.path, reason: item.reason })),
  };
}

function normalizedScope(scope: AssuranceWorkPackageScope): NormalizedScope {
  const value = record(scope);
  return {
    workPackageId: text(value.workPackageId),
    workPackageRevision: positiveInteger(value.workPackageRevision),
    workPackageHash: text(value.workPackageHash),
    changed: normalizedPathList(value.changedPaths, 'changed'),
    required: normalizedPathList(value.requiredPaths, 'required'),
    allowed: normalizedPathList(value.allowedPaths, 'allowed'),
    forbidden: normalizedPathList(value.forbiddenPaths, 'forbidden'),
  };
}

function scopeIdentity(scope: NormalizedScope): `sha256:${string}` {
  const serialized = JSON.stringify({
    workPackageId: scope.workPackageId,
    workPackageRevision: scope.workPackageRevision,
    workPackageHash: scope.workPackageHash,
    changedPaths: scope.changed.paths,
    requiredPaths: scope.required.paths,
    allowedPaths: scope.allowed.paths,
    forbiddenPaths: scope.forbidden.paths,
  });
  return `sha256:${createHash('sha256').update(serialized).digest('hex')}`;
}

function pathWithinScope(path: string, scope: string): boolean {
  return path === scope || path.startsWith(`${scope}/`);
}

/** Return the deterministic identity that binds a work package and all four path manifests. */
export function assuranceScopeIdentity(scope: AssuranceWorkPackageScope): `sha256:${string}` {
  return scopeIdentity(normalizedScope(scope));
}

/** Record the complete scope, then classify every forbidden, unexpected, and missing change. */
export function evaluateAssuranceScope(scope: AssuranceWorkPackageScope): AssuranceScopeEvaluation {
  const normalized = normalizedScope(scope);
  const invalidPaths = [
    ...normalized.changed.invalidPaths,
    ...normalized.required.invalidPaths,
    ...normalized.allowed.invalidPaths,
    ...normalized.forbidden.invalidPaths,
  ];
  const validChanged = new Set(normalized.changed.validPaths);
  const unexpectedPaths = normalized.changed.paths.filter((path) =>
    !validChanged.has(path) || !normalized.allowed.validPaths.some((allowed) => pathWithinScope(path, allowed)));
  const forbiddenChangedPaths = normalized.changed.validPaths.filter((path) =>
    normalized.forbidden.validPaths.some((forbidden) => pathWithinScope(path, forbidden)));
  const missingPaths = normalized.required.paths.filter((required) =>
    !normalized.required.validPaths.includes(required)
      || !normalized.changed.validPaths.some((changed) => pathWithinScope(changed, required)));
  const findings: AssuranceCandidateFinding[] = [];

  if (!normalized.workPackageId) findings.push({ kind: 'invalid-scope', message: 'Bound scope is missing workPackageId.' });
  if (!normalized.workPackageRevision) findings.push({ kind: 'invalid-scope', message: 'Bound scope is missing a positive workPackageRevision.' });
  if (!normalized.workPackageHash) findings.push({ kind: 'invalid-scope', message: 'Bound scope is missing workPackageHash.' });
  for (const [category, paths] of [
    ['changed', normalized.changed],
    ['required', normalized.required],
    ['allowed', normalized.allowed],
    ['forbidden', normalized.forbidden],
  ] as const) {
    if (!paths.present) {
      findings.push({
        kind: 'invalid-scope',
        pathCategory: category,
        message: `Bound scope is missing the ${category} path manifest.`,
      });
    }
  }
  for (const invalid of invalidPaths) {
    findings.push({
      kind: 'invalid-scope-path',
      path: invalid.path,
      pathCategory: invalid.category,
      message: `The ${invalid.category} path ${JSON.stringify(invalid.path)} is invalid: ${invalid.reason}.`,
    });
  }
  for (const path of unexpectedPaths) {
    findings.push({
      kind: 'unexpected-path',
      path,
      pathCategory: 'changed',
      message: `Changed path ${JSON.stringify(path)} is outside every allowed path.`,
    });
  }
  for (const path of forbiddenChangedPaths) {
    findings.push({
      kind: 'forbidden-path',
      path,
      pathCategory: 'changed',
      message: `Changed path ${JSON.stringify(path)} is within a forbidden path.`,
    });
  }
  for (const path of missingPaths) {
    findings.push({
      kind: 'missing-path',
      path,
      pathCategory: 'required',
      message: `Required path ${JSON.stringify(path)} has no bound change.`,
    });
  }

  return {
    valid: findings.length === 0,
    workPackage: {
      workPackageId: normalized.workPackageId,
      workPackageRevision: normalized.workPackageRevision,
      workPackageHash: normalized.workPackageHash,
    },
    scopeIdentity: scopeIdentity(normalized),
    changedPaths: normalized.changed.paths,
    requiredPaths: normalized.required.paths,
    allowedPaths: normalized.allowed.paths,
    forbiddenPaths: normalized.forbidden.paths,
    unexpectedPaths,
    forbiddenChangedPaths,
    missingPaths,
    invalidPaths,
    findings,
  };
}

function normalizeIdentity(value: Partial<AssuranceCandidateIdentity> | null | undefined): Partial<AssuranceCandidateIdentity> {
  const identity = record(value);
  const revision = record(identity.specificationRevision);
  const specId = text(revision.specId);
  const revisionValue = text(revision.revision);
  const plan = record(identity.plan);
  const planId = text(plan.planId);
  const planVersion = positiveInteger(plan.planVersion);
  const normalized: Partial<AssuranceCandidateIdentity> = {};

  if (specId && revisionValue) normalized.specificationRevision = { specId, revision: revisionValue };
  if (planId && planVersion) normalized.plan = { planId, planVersion };
  for (const field of ['commit', 'tree', 'diff', 'scope'] as const) {
    const fieldValue = text(identity[field]);
    if (fieldValue) normalized[field] = fieldValue;
  }
  return normalized;
}

function missingIdentityFindings(identity: Partial<AssuranceCandidateIdentity>): AssuranceCandidateFinding[] {
  return ASSURANCE_CANDIDATE_IDENTITY_FIELDS
    .filter((field) => identity[field] === undefined)
    .map((field) => ({
      kind: 'missing-identity' as const,
      field,
      message: `Assurance candidate is missing required ${field} identity.`,
    }));
}

function matchingIdentityField(
  field: AssuranceCandidateIdentityField,
  candidate: Partial<AssuranceCandidateIdentity>,
  subject: Partial<AssuranceCandidateIdentity>,
): boolean {
  if (field === 'specificationRevision') {
    const expected = candidate.specificationRevision;
    const observed = subject.specificationRevision;
    return Boolean(expected && observed && expected.specId === observed.specId && expected.revision === observed.revision);
  }
  if (field === 'plan') {
    const expected = candidate.plan;
    const observed = subject.plan;
    return Boolean(expected && observed && expected.planId === observed.planId && expected.planVersion === observed.planVersion);
  }
  return candidate[field] !== undefined && candidate[field] === subject[field];
}

/** Validate one observation against every field of the candidate's immutable subject. */
export function validateAssuranceSubject(
  candidateIdentity: Partial<AssuranceCandidateIdentity> | null,
  recordType: AssuranceSubjectRecordType,
  boundRecord: CandidateBoundSubjectRecord,
): AssuranceSubjectValidation {
  const candidate = normalizeIdentity(candidateIdentity);
  const subject = normalizeIdentity(boundRecord.subject);
  const recordId = text(boundRecord.recordId) ?? `${recordType}:unidentified`;
  const mismatchedFields = ASSURANCE_CANDIDATE_IDENTITY_FIELDS.filter((field) =>
    !matchingIdentityField(field, candidate, subject));
  if (mismatchedFields.length === 0) {
    return {
      recordType,
      recordId,
      status: 'accepted-subject',
      includedInSatisfaction: true,
      mismatchedFields: [],
      finding: null,
    };
  }
  const finding: AssuranceCandidateFinding = {
    kind: 'rejected-subject',
    recordType,
    recordId,
    mismatchedFields,
    message: `${recordType} ${JSON.stringify(recordId)} does not bind the candidate's exact ${mismatchedFields.join(', ')} subject.`,
  };
  return {
    recordType,
    recordId,
    status: 'rejected-subject',
    includedInSatisfaction: false,
    mismatchedFields,
    finding,
  };
}

function validateSubjectRecords(
  identity: Partial<AssuranceCandidateIdentity>,
  type: AssuranceSubjectRecordType,
  records: readonly CandidateBoundSubjectRecord[] | undefined,
): AssuranceSubjectValidation[] {
  return (records ?? []).map((item) => validateAssuranceSubject(identity, type, item));
}

function satisfiedIds(results: readonly AssuranceSubjectValidation[]): string[] {
  return results.filter((result) => result.includedInSatisfaction).map((result) => result.recordId);
}

/** Validate completeness, bound scope, and every supplied candidate-subject record in one deterministic pass. */
export function validateAssuranceCandidate(candidate: AssuranceCandidateInput): AssuranceCandidateValidation {
  const identity = normalizeIdentity(candidate.identity);
  const scope = evaluateAssuranceScope(candidate.scope);
  const identityFindings = missingIdentityFindings(identity);
  if (identity.scope !== undefined && identity.scope !== scope.scopeIdentity) {
    identityFindings.push({
      kind: 'scope-identity-mismatch',
      field: 'scope',
      message: `Candidate scope identity ${JSON.stringify(identity.scope)} does not match bound scope ${scope.scopeIdentity}.`,
    });
  }
  const evidence = validateSubjectRecords(identity, 'evidence', candidate.evidence);
  const decisions = validateSubjectRecords(identity, 'decision', candidate.decisions);
  const testExecutions = validateSubjectRecords(identity, 'test-execution', candidate.testExecutions);
  const producedArtifacts = validateSubjectRecords(identity, 'artifact', candidate.producedArtifacts);
  const subjectFindings = [...evidence, ...decisions, ...testExecutions, ...producedArtifacts]
    .flatMap((result) => result.finding ? [result.finding] : []);
  const findings = [...identityFindings, ...scope.findings, ...subjectFindings];

  return {
    candidateId: text(candidate.candidateId) ?? 'unidentified-candidate',
    valid: findings.length === 0,
    status: findings.length === 0 ? 'accepted' : 'rejected',
    identity,
    scope,
    subjectResults: { evidence, decisions, testExecutions, producedArtifacts },
    satisfiedRecordIds: {
      evidence: satisfiedIds(evidence),
      decisions: satisfiedIds(decisions),
      testExecutions: satisfiedIds(testExecutions),
      producedArtifacts: satisfiedIds(producedArtifacts),
    },
    findings,
  };
}
