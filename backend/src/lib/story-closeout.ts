
/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * LFC-008: bounded story closeout contracts and reconciliation.
 *
 * This module deliberately has no execution loop, queue, scheduler, mode
 * detector, retry planner, worktree manager, lifecycle evaluator, approval,
 * merge, deploy, or external-send capability. Callers collect host facts and
 * pass them in; this gate only reconciles those immutable facts.
 */

import crypto from 'node:crypto';
import { execute, query, queryOne } from '../db/index';
import {
  canonicalizeStoryContract,
  deriveStoryCommandHash,
  verifyStoryExecutionManifest,
  type ImmutableStoryExecutionManifest,
  type StoryExecutionManifest,
  type StoryManifestIdentity,
  type StoryManifestRevisions,
} from './story-execution-packet';
import {
  createCanonicalEvidence,
  persistCanonicalEvidence,
  type CanonicalLifecycleEvidence,
  type EvidencePersistenceResult,
} from './ssdlc-evidence';

export const STORY_ATTEMPT_RESULT_VERSION = 'rorca.story-attempt-result.v1' as const;
export const STORY_CLOSEOUT_DECISION_VERSION = 'rorca.story-closeout-decision.v1' as const;
export const LEGACY_CLOSEOUT_RULE_NAME = 'pre-manifest-v0-before-cutoff' as const;
export const MAX_CLOSEOUT_OUTPUT_EXCERPT_BYTES = 8_192;
export const MAX_CLOSEOUT_REFERENCE_BYTES = 4_096;
export const MAX_CLOSEOUT_ISSUE_BYTES = 4_096;
export const MAX_CLOSEOUT_OUTPUT_REFERENCES = 64;
export const MAX_CLOSEOUT_VALIDATION_OBSERVATIONS = 128;

export type StoryManifest = StoryExecutionManifest | ImmutableStoryExecutionManifest;
export type StoryValidationClassification =
  | 'passed'
  | 'story_caused_failure'
  | 'unrelated_baseline'
  | 'blocked_by_policy'
  | 'environment_unavailable';

export type StoryCloseoutReasonCode =
  | 'ACCEPTED'
  | 'LEGACY_COMPATIBILITY_APPLIED'
  | 'MISSING_MANIFEST'
  | 'LEGACY_COMPATIBILITY_DENIED'
  | 'STALE_MANIFEST_HASH'
  | 'IDENTITY_MISMATCH'
  | 'REVISION_MISMATCH'
  | 'ATTEMPT_CONTRADICTION'
  | 'PROCESS_NOT_SUCCESSFUL'
  | 'MISSING_COMPLETION_PACKET'
  | 'PACKET_CONTRADICTION'
  | 'PROGRESS_CONTRADICTION'
  | 'STORY_RESULT_CONTRADICTION'
  | 'STORY_COMMIT_CONTRADICTION'
  | 'MISSING_REQUIRED_VALIDATION'
  | 'FORGED_VALIDATION'
  | 'VALIDATION_COMMAND_MISMATCH'
  | 'VALIDATION_CWD_MISMATCH'
  | 'VALIDATION_BLOCKED_BY_POLICY'
  | 'VALIDATION_ENVIRONMENT_UNAVAILABLE'
  | 'VALIDATION_FAILED_STORY_CAUSED'
  | 'BASELINE_FAILURE_UNSUPPORTED'
  | 'REVISION_MUTATED_DURING_VALIDATION'
  | 'STALE_VALIDATION_REVISION'
  | 'MISSING_OBSERVED_OUTPUT'
  | 'METADATA_ONLY_OUTPUT'
  | 'DIRTY_WORKTREE'
  | 'MISSING_CRITERION_EVIDENCE';

export interface StorySubjectRevision {
  commitSha: string;
  worktreePath: string;
  branch: string;
}

export interface BoundedOutputReference {
  kind: 'run_output' | 'story_log' | 'validation_output' | 'artifact';
  reference: string;
  byteLength: number;
  sha256: string | null;
  redactedExcerpt: string | null;
  truncated: boolean;
}

export type StoryProcessTermination =
  | { kind: 'exited'; exitCode: number }
  | { kind: 'signaled'; signal: string }
  | { kind: 'timed_out'; timeoutMs: number }
  | { kind: 'cancelled'; reason: string };

export interface ProposedCriterionEvidence {
  criterionId: string;
  evidenceReferences: string[];
}

/** Agent proposal only. The gate never treats this packet as host evidence. */
export interface AgentProposedCompletionPacket {
  manifestHash: string;
  identity: StoryManifestIdentity;
  revisions: StoryManifestRevisions;
  proposal: 'complete' | 'blocked';
  summary: string;
  criterionEvidence: ProposedCriterionEvidence[];
}

export interface ObservedStoryFile {
  path: string;
  changeType: 'added' | 'modified' | 'deleted' | 'renamed';
  runtimeMetadata: boolean;
  observer: 'host' | 'agent';
}

export interface ObservedStoryCommit {
  workspaceId: string;
  specId: string;
  runId: number;
  storyId: string;
  sha: string;
  branch: string;
  message: string;
  author: string;
  committedAt: string;
  observedBy: 'story_commits' | 'worktree_branch';
}

export interface RedactedEnvironmentProfile {
  profileId: string;
  fingerprint: string;
  redactedKeys: string[];
}

export interface HostValidationObservation {
  observationId: string;
  requirementId: string;
  observer: 'rorca_host';
  command: string;
  args: string[];
  commandHash: string;
  guardedWorkingDirectory: string;
  environment: RedactedEnvironmentProfile;
  startedAt: string;
  finishedAt: string;
  termination: StoryProcessTermination;
  classification: StoryValidationClassification;
  output: BoundedOutputReference;
  subject: StorySubjectRevision;
  repositoryRevisionBefore: string;
  repositoryRevisionAfter: string;
  criterionIds: string[];
  baselineEvidenceReferences: string[];
  policyTreatmentReference: string | null;
  remediation: string | null;
}

export interface StoryAttemptResultInput {
  identity: StoryManifestIdentity;
  revisions: StoryManifestRevisions;
  manifestHash: string;
  agentProcess: {
    agent: string;
    model: string | null;
    effort: string | null;
    processId: number | null;
    sessionId: string | null;
  };
  startedAt: string;
  finishedAt: string;
  termination: StoryProcessTermination;
  outputReferences: BoundedOutputReference[];
  proposedCompletionPacket: AgentProposedCompletionPacket | null;
  observedFiles: ObservedStoryFile[];
  observedCommits: ObservedStoryCommit[];
  hostValidationObservations: HostValidationObservation[];
  knownIssues: string[];
}

export interface StoryAttemptResult extends StoryAttemptResultInput {
  schemaVersion: typeof STORY_ATTEMPT_RESULT_VERSION;
  attemptResultId: string;
}

export interface HostCriterionEvidence {
  criterionId: string;
  evidenceReferences: string[];
  subjectRevision: string;
  observedBy: 'rorca_host';
}

export interface ScopedCloseoutRecord {
  workspaceId: string;
  specId: string;
  runId: number;
  storyId: string;
  manifestHash: string;
  specRevision: string;
  storyRevision: string;
}

export interface HostRepositoryObservation {
  worktreeClean: boolean;
  changedFiles: string[];
  runtimeMetadataFiles: string[];
  headBeforeValidation: string;
  headAfterValidation: string;
}

export interface StoryCloseoutHostFacts {
  identity: StoryManifestIdentity;
  activeSubjectRevision: StorySubjectRevision;
  repository: HostRepositoryObservation;
  validations: HostValidationObservation[];
  criterionEvidence: HostCriterionEvidence[];
  storyCommits: ObservedStoryCommit[];
  progress: (ScopedCloseoutRecord & { reportsComplete: boolean }) | null;
  storyResult: (ScopedCloseoutRecord & { status: 'pass' | 'fail' | 'skip' | 'timeout' }) | null;
}

export interface LegacyCloseoutCompatibility {
  ruleName: typeof LEGACY_CLOSEOUT_RULE_NAME;
  manifestVersion: 0;
  runCreatedAt: string;
  cutoff: string;
  auditReference: string;
  workspaceId: string;
  specId: string;
  runId: number;
  storyId: string;
  activeSubjectRevision: StorySubjectRevision;
  hostEvidenceReferences: string[];
}

export interface AcceptanceCriterionEvidenceMapping {
  criterionId: string;
  status: 'satisfied' | 'blocked';
  evidenceReferences: string[];
  blockerReasonCodes: StoryCloseoutReasonCode[];
}

export interface StoryCloseoutDecision {
  schemaVersion: typeof STORY_CLOSEOUT_DECISION_VERSION;
  decisionId: string;
  status: 'accepted' | 'blocked';
  reasonCodes: StoryCloseoutReasonCode[];
  acceptanceCriteria: AcceptanceCriterionEvidenceMapping[];
  normalizedEvidenceReferences: string[];
  activeSubjectRevision: StorySubjectRevision;
  nextSafeAction: {
    code: 'persist_closeout' | 'collect_host_evidence' | 'rerun_validation' | 'repair_identity' | 'remediate_environment' | 'inspect_worktree';
    remediation: string;
  };
  compatibility: { ruleName: string; auditReference: string } | null;
}

export interface StoryCloseoutGateInput {
  manifest: StoryManifest | null;
  attempt: StoryAttemptResult | null;
  host: StoryCloseoutHostFacts | null;
  legacyCompatibility?: LegacyCloseoutCompatibility | null;
}

export interface PersistedCloseoutBundle {
  manifest: StoryManifest;
  attempt: StoryAttemptResult;
  decision: StoryCloseoutDecision;
  evidence: CanonicalLifecycleEvidence[];
}

export interface CloseoutDb {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;
}

const DEFAULT_DB: CloseoutDb = { query, queryOne, execute };

function stableHash(prefix: string, value: unknown): string {
  return `${prefix}${crypto.createHash('sha256').update(canonicalizeStoryContract(value), 'utf8').digest('hex')}`;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${field} must be a non-empty string`);
  return value.trim();
}

function iso(value: string, field: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`${field} must be an ISO timestamp`);
  return parsed.toISOString();
}

function utf8Bound(value: string | null, maxBytes: number, field: string): string | null {
  if (value === null) return null;
  if (Buffer.byteLength(value, 'utf8') > maxBytes) throw new TypeError(`${field} exceeds ${maxBytes} bytes`);
  return value;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) freeze(item);
  }
  return value;
}

function normalizeOutput(output: BoundedOutputReference, field: string): BoundedOutputReference {
  if (!Number.isSafeInteger(output.byteLength) || output.byteLength < 0) throw new TypeError(`${field}.byteLength must be non-negative`);
  if (output.sha256 && !/^sha256:[0-9a-f]{64}$/.test(output.sha256)) throw new TypeError(`${field}.sha256 must be a canonical SHA-256 digest`);
  return {
    kind: output.kind,
    reference: utf8Bound(text(output.reference, `${field}.reference`), MAX_CLOSEOUT_REFERENCE_BYTES, `${field}.reference`)! ,
    byteLength: output.byteLength,
    sha256: output.sha256 ? text(output.sha256, `${field}.sha256`) : null,
    redactedExcerpt: utf8Bound(output.redactedExcerpt, MAX_CLOSEOUT_OUTPUT_EXCERPT_BYTES, `${field}.redactedExcerpt`),
    truncated: output.truncated,
  };
}

function normalizeTermination(termination: StoryProcessTermination): StoryProcessTermination {
  switch (termination.kind) {
    case 'exited':
      if (!Number.isInteger(termination.exitCode)) throw new TypeError('termination.exitCode must be an integer');
      return { ...termination };
    case 'signaled': return { kind: 'signaled', signal: text(termination.signal, 'termination.signal') };
    case 'timed_out':
      if (!Number.isSafeInteger(termination.timeoutMs) || termination.timeoutMs <= 0) throw new TypeError('termination.timeoutMs must be positive');
      return { ...termination };
    case 'cancelled': return { kind: 'cancelled', reason: text(termination.reason, 'termination.reason') };
  }
}

function normalizeValidation(observation: HostValidationObservation, field: string): HostValidationObservation {
  const startedAt = iso(observation.startedAt, `${field}.startedAt`);
  const finishedAt = iso(observation.finishedAt, `${field}.finishedAt`);
  if (finishedAt < startedAt) throw new TypeError(`${field}.finishedAt precedes startedAt`);
  return {
    observationId: text(observation.observationId, `${field}.observationId`),
    requirementId: text(observation.requirementId, `${field}.requirementId`),
    observer: observation.observer,
    command: text(observation.command, `${field}.command`),
    args: observation.args.map(String),
    commandHash: text(observation.commandHash, `${field}.commandHash`),
    guardedWorkingDirectory: text(observation.guardedWorkingDirectory, `${field}.guardedWorkingDirectory`),
    environment: {
      profileId: text(observation.environment.profileId, `${field}.environment.profileId`),
      fingerprint: text(observation.environment.fingerprint, `${field}.environment.fingerprint`),
      redactedKeys: uniqueSorted(observation.environment.redactedKeys.map(String)),
    },
    startedAt,
    finishedAt,
    termination: normalizeTermination(observation.termination),
    classification: observation.classification,
    output: normalizeOutput(observation.output, `${field}.output`),
    subject: {
      commitSha: text(observation.subject.commitSha, `${field}.subject.commitSha`),
      worktreePath: text(observation.subject.worktreePath, `${field}.subject.worktreePath`),
      branch: text(observation.subject.branch, `${field}.subject.branch`),
    },
    repositoryRevisionBefore: text(observation.repositoryRevisionBefore, `${field}.repositoryRevisionBefore`),
    repositoryRevisionAfter: text(observation.repositoryRevisionAfter, `${field}.repositoryRevisionAfter`),
    criterionIds: uniqueSorted(observation.criterionIds.map(String)),
    baselineEvidenceReferences: uniqueSorted(observation.baselineEvidenceReferences.map(String)),
    policyTreatmentReference: observation.policyTreatmentReference?.trim() || null,
    remediation: observation.remediation?.trim() || null,
  };
}

/** Build the bounded host-runner observation consumed by closeout reconciliation. */
export function createHostValidationObservation(observation: HostValidationObservation): HostValidationObservation {
  return freeze(normalizeValidation(observation, 'hostValidation'));
}

/** Create an immutable append-only attempt result; none of its prose is authoritative. */
export function createStoryAttemptResult(input: StoryAttemptResultInput): StoryAttemptResult {
  const startedAt = iso(input.startedAt, 'startedAt');
  const finishedAt = iso(input.finishedAt, 'finishedAt');
  if (finishedAt < startedAt) throw new TypeError('finishedAt precedes startedAt');
  if (input.outputReferences.length > MAX_CLOSEOUT_OUTPUT_REFERENCES) {
    throw new TypeError(`outputReferences exceeds ${MAX_CLOSEOUT_OUTPUT_REFERENCES} entries`);
  }
  if (input.hostValidationObservations.length > MAX_CLOSEOUT_VALIDATION_OBSERVATIONS) {
    throw new TypeError(`hostValidationObservations exceeds ${MAX_CLOSEOUT_VALIDATION_OBSERVATIONS} entries`);
  }
  if (input.agentProcess.processId !== null
    && (!Number.isSafeInteger(input.agentProcess.processId) || input.agentProcess.processId <= 0)) {
    throw new TypeError('agentProcess.processId must be a positive safe integer or null');
  }
  const normalized: StoryAttemptResultInput = {
    identity: { ...input.identity },
    revisions: { ...input.revisions },
    manifestHash: text(input.manifestHash, 'manifestHash'),
    agentProcess: {
      agent: text(input.agentProcess.agent, 'agentProcess.agent'),
      model: input.agentProcess.model?.trim() || null,
      effort: input.agentProcess.effort?.trim() || null,
      processId: input.agentProcess.processId,
      sessionId: input.agentProcess.sessionId?.trim() || null,
    },
    startedAt,
    finishedAt,
    termination: normalizeTermination(input.termination),
    outputReferences: input.outputReferences.map((output, index) => normalizeOutput(output, `outputReferences.${index}`)),
    proposedCompletionPacket: input.proposedCompletionPacket ? {
      ...input.proposedCompletionPacket,
      identity: { ...input.proposedCompletionPacket.identity },
      revisions: { ...input.proposedCompletionPacket.revisions },
      summary: utf8Bound(text(input.proposedCompletionPacket.summary, 'proposedCompletionPacket.summary'), MAX_CLOSEOUT_ISSUE_BYTES, 'proposedCompletionPacket.summary')!,
      criterionEvidence: input.proposedCompletionPacket.criterionEvidence.map((mapping) => ({
        criterionId: text(mapping.criterionId, 'proposedCompletionPacket.criterionEvidence.criterionId'),
        evidenceReferences: uniqueSorted(mapping.evidenceReferences.map(String)),
      })),
    } : null,
    observedFiles: input.observedFiles.map((file) => ({ ...file, path: text(file.path, 'observedFiles.path') })),
    observedCommits: input.observedCommits.map((commit) => ({ ...commit, committedAt: iso(commit.committedAt, 'observedCommits.committedAt') })),
    hostValidationObservations: input.hostValidationObservations.map((item, index) => normalizeValidation(item, `hostValidationObservations.${index}`)),
    knownIssues: input.knownIssues.map((issue, index) => utf8Bound(text(issue, `knownIssues.${index}`), MAX_CLOSEOUT_ISSUE_BYTES, `knownIssues.${index}`)!),
  };
  return freeze({
    schemaVersion: STORY_ATTEMPT_RESULT_VERSION,
    ...normalized,
    attemptResultId: stableHash('ATR-sha256:', { schemaVersion: STORY_ATTEMPT_RESULT_VERSION, ...normalized }),
  });
}

export function verifyStoryAttemptResult(result: StoryAttemptResult): boolean {
  if (result.schemaVersion !== STORY_ATTEMPT_RESULT_VERSION) return false;
  const { attemptResultId: _attemptResultId, ...payload } = result;
  return result.attemptResultId === stableHash('ATR-sha256:', payload);
}

/** Exact restart replay is a no-op; a changed result can never replace an attempt. */
export function appendStoryAttemptResult(
  attempts: readonly StoryAttemptResult[],
  candidate: StoryAttemptResult,
): readonly StoryAttemptResult[] {
  if (!verifyStoryAttemptResult(candidate)) throw new TypeError('Cannot append a stale or forged attempt result');
  const sameAttempt = attempts.find((item) =>
    item.identity.workspaceId === candidate.identity.workspaceId
    && item.identity.runId === candidate.identity.runId
    && item.identity.storyId === candidate.identity.storyId
    && item.identity.attempt === candidate.identity.attempt);
  if (sameAttempt) {
    if (sameAttempt.attemptResultId === candidate.attemptResultId) return attempts;
    throw new TypeError(`Attempt ${candidate.identity.attempt} already exists with different immutable content`);
  }
  const maxAttempt = attempts.reduce((max, item) => Math.max(max, item.identity.attempt), 0);
  if (candidate.identity.attempt <= maxAttempt) throw new TypeError('Attempts must append in increasing order');
  return freeze([...attempts, candidate]);
}

function identityMatches(expected: StoryManifestIdentity, actual: StoryManifestIdentity): boolean {
  return expected.workspaceId === actual.workspaceId
    && expected.specId === actual.specId
    && expected.storyId === actual.storyId
    && expected.runId === actual.runId
    && expected.attempt === actual.attempt;
}

function scopedRecordMatches(manifest: StoryManifest, record: ScopedCloseoutRecord): boolean {
  return manifest.identity.workspaceId === record.workspaceId
    && manifest.identity.specId === record.specId
    && manifest.identity.storyId === record.storyId
    && manifest.identity.runId === record.runId
    && manifest.manifestHash === record.manifestHash
    && manifest.revisions.specRevision === record.specRevision
    && manifest.revisions.storyRevision === record.storyRevision;
}

function commitMatches(manifest: StoryManifest, commit: ObservedStoryCommit): boolean {
  return commit.workspaceId === manifest.identity.workspaceId
    && commit.specId === manifest.identity.specId
    && commit.runId === manifest.identity.runId
    && commit.storyId === manifest.identity.storyId;
}

function validationStatus(classification: StoryValidationClassification): 'passed' | 'story_caused_failure' | 'unrelated_baseline' | 'environment_credential_blocker' | 'unknown' {
  if (classification === 'passed') return 'passed';
  if (classification === 'story_caused_failure') return 'story_caused_failure';
  if (classification === 'unrelated_baseline') return 'unrelated_baseline';
  if (classification === 'environment_unavailable') return 'environment_credential_blocker';
  return 'unknown';
}

/** Adapt reconciled host facts to the existing normalized evidence contract. */
export function adaptStoryCloseoutEvidence(
  manifest: StoryManifest,
  host: StoryCloseoutHostFacts,
): CanonicalLifecycleEvidence[] {
  const scope = {
    workspaceId: manifest.identity.workspaceId,
    specSlug: manifest.identity.specId,
    runId: manifest.identity.runId,
    storyId: manifest.identity.storyId,
    phaseId: null,
    gateId: null,
  };
  const subject = { type: 'commit_sha' as const, value: host.activeSubjectRevision.commitSha };
  const validations = host.validations
    .filter((observation) => observation.observer === 'rorca_host')
    .map((observation) => createCanonicalEvidence({
    sourceType: 'wal_validation',
    sourceSystem: 'rorca:story-closeout-host-runner',
    sourceEventId: `story-closeout-validation:${manifest.manifestHash}:${observation.observationId}`,
    observedAt: observation.finishedAt,
    scope,
    subject: { type: 'commit_sha', value: observation.subject.commitSha },
    phaseSubject: subject,
    releaseIdentity: { commitSha: observation.subject.commitSha },
    classification: 'testing',
    status: validationStatus(observation.classification),
    trustLevel: 'host_observed',
    confidence: observation.classification === 'blocked_by_policy' ? 0 : 1,
    excerpt: observation.output.redactedExcerpt,
    rawReference: observation.output.reference,
    provenanceChain: [{
      system: 'rorca:story-closeout-host-runner',
      eventId: observation.observationId,
      observedAt: observation.finishedAt,
      verification: `guard:${manifest.commandSafety.guardVersion};command:${observation.commandHash};env:${observation.environment.fingerprint}`,
    }],
    details: {
      requirementId: observation.requirementId,
      guardedWorkingDirectory: observation.guardedWorkingDirectory,
      environmentProfileId: observation.environment.profileId,
      termination: observation.termination,
      repositoryRevisionBefore: observation.repositoryRevisionBefore,
      repositoryRevisionAfter: observation.repositoryRevisionAfter,
      criterionIds: observation.criterionIds,
      baselineEvidenceReferences: observation.baselineEvidenceReferences,
      policyTreatmentReference: observation.policyTreatmentReference,
      remediation: observation.remediation,
    },
  }));
  const commits = host.storyCommits.filter((commit) => commitMatches(manifest, commit)).map((commit) => createCanonicalEvidence({
    sourceType: 'story_commit',
    sourceSystem: `rorca:${commit.observedBy}`,
    sourceEventId: `story-closeout-commit:${manifest.identity.runId}:${manifest.identity.storyId}:${commit.sha}`,
    observedAt: commit.committedAt,
    scope,
    subject: { type: 'commit_sha', value: commit.sha },
    phaseSubject: subject,
    releaseIdentity: { commitSha: commit.sha },
    classification: 'revision',
    status: 'passed',
    trustLevel: 'host_observed',
    confidence: 1,
    excerpt: commit.message,
    rawReference: `git:commit:${commit.sha}`,
    provenanceChain: [{
      system: `rorca:${commit.observedBy}`,
      eventId: commit.sha,
      observedAt: commit.committedAt,
      principal: commit.author,
      verification: `workspace-run-story-scoped;branch:${commit.branch}`,
    }],
  }));
  return [...validations, ...commits];
}

function evidenceReference(evidence: CanonicalLifecycleEvidence): string {
  return `EVD-sha256:${evidence.payloadHash}`;
}

function legacyDecision(input: StoryCloseoutGateInput): StoryCloseoutDecision {
  const legacy = input.legacyCompatibility;
  const fallbackRevision = legacy?.activeSubjectRevision ?? { commitSha: 'unknown', worktreePath: 'unknown', branch: 'unknown' };
  const valid = Boolean(
    legacy
    && legacy.ruleName === LEGACY_CLOSEOUT_RULE_NAME
    && legacy.manifestVersion === 0
    && legacy.auditReference.trim()
    && legacy.hostEvidenceReferences.length > 0
    && new Date(legacy.runCreatedAt).getTime() <= new Date(legacy.cutoff).getTime(),
  );
  const base: Omit<StoryCloseoutDecision, 'decisionId'> = {
    schemaVersion: STORY_CLOSEOUT_DECISION_VERSION,
    status: valid ? 'accepted' : 'blocked',
    reasonCodes: valid ? ['LEGACY_COMPATIBILITY_APPLIED'] : [legacy ? 'LEGACY_COMPATIBILITY_DENIED' : 'MISSING_MANIFEST'],
    acceptanceCriteria: [{
      criterionId: 'legacy-closeout',
      status: valid ? 'satisfied' : 'blocked',
      evidenceReferences: valid ? uniqueSorted(legacy!.hostEvidenceReferences) : [],
      blockerReasonCodes: valid ? [] : [legacy ? 'LEGACY_COMPATIBILITY_DENIED' : 'MISSING_MANIFEST'],
    }],
    normalizedEvidenceReferences: valid ? uniqueSorted(legacy!.hostEvidenceReferences) : [],
    activeSubjectRevision: fallbackRevision,
    nextSafeAction: valid
      ? { code: 'persist_closeout', remediation: 'Persist the named compatibility decision and audit reference.' }
      : { code: 'collect_host_evidence', remediation: 'Supply a version-bounded audited legacy rule, or restore the canonical manifest and packet.' },
    compatibility: valid ? { ruleName: legacy!.ruleName, auditReference: legacy!.auditReference } : null,
  };
  return freeze({ ...base, decisionId: stableHash('CLO-sha256:', base) });
}

export function verifyStoryCloseoutDecision(decision: StoryCloseoutDecision): boolean {
  if (decision.schemaVersion !== STORY_CLOSEOUT_DECISION_VERSION) return false;
  const { decisionId: _decisionId, ...payload } = decision;
  return decision.decisionId === stableHash('CLO-sha256:', payload);
}

function nextAction(reasons: readonly StoryCloseoutReasonCode[]): StoryCloseoutDecision['nextSafeAction'] {
  if (reasons.some((reason) => reason.includes('IDENTITY') || reason.includes('CONTRADICTION') || reason === 'STALE_MANIFEST_HASH' || reason === 'REVISION_MISMATCH')) {
    return { code: 'repair_identity', remediation: 'Reconcile packet, progress, result, commit, manifest, and active revision identities before retrying closeout.' };
  }
  if (reasons.includes('DIRTY_WORKTREE') || reasons.includes('METADATA_ONLY_OUTPUT') || reasons.includes('MISSING_OBSERVED_OUTPUT')) {
    return { code: 'inspect_worktree', remediation: 'Inspect the story branch/worktree and record meaningful story-scoped output or an explicit no-code profile.' };
  }
  if (reasons.includes('VALIDATION_BLOCKED_BY_POLICY') || reasons.includes('VALIDATION_ENVIRONMENT_UNAVAILABLE')) {
    return { code: 'remediate_environment', remediation: 'Apply the validation remediation, preserve the typed blocker, then run the required command under the host guard.' };
  }
  if (reasons.some((reason) => reason.includes('VALIDATION') || reason.includes('BASELINE'))) {
    return { code: 'rerun_validation', remediation: 'Rerun required revision-sensitive checks with the guarded host runner against the active subject revision.' };
  }
  if (reasons.length > 0) return { code: 'collect_host_evidence', remediation: 'Collect missing host-observed criterion evidence; agent claims and exit zero are not sufficient.' };
  return { code: 'persist_closeout', remediation: 'Persist the immutable closeout decision and normalized evidence records.' };
}

/** Deterministic, side-effect-free story closeout reconciliation. */
export function evaluateStoryCloseout(input: StoryCloseoutGateInput): StoryCloseoutDecision {
  if (!input.manifest) return legacyDecision(input);
  const manifest = input.manifest;
  const reasons = new Set<StoryCloseoutReasonCode>();
  const criterionReasons = new Map<string, Set<StoryCloseoutReasonCode>>();
  const add = (reason: StoryCloseoutReasonCode, criterionIds: readonly string[] = []) => {
    reasons.add(reason);
    for (const criterionId of criterionIds) {
      const current = criterionReasons.get(criterionId) ?? new Set<StoryCloseoutReasonCode>();
      current.add(reason);
      criterionReasons.set(criterionId, current);
    }
  };

  if (!verifyStoryExecutionManifest(manifest)) add('STALE_MANIFEST_HASH');
  const attempt = input.attempt;
  const host = input.host;
  if (!attempt) add('ATTEMPT_CONTRADICTION');
  if (!host) add('MISSING_CRITERION_EVIDENCE', manifest.evidenceExpectations.map((item) => item.criterionId));

  if (attempt) {
    if (!identityMatches(manifest.identity, attempt.identity)) add('IDENTITY_MISMATCH');
    if (attempt.manifestHash !== manifest.manifestHash) add('ATTEMPT_CONTRADICTION');
    if (attempt.revisions.specRevision !== manifest.revisions.specRevision || attempt.revisions.storyRevision !== manifest.revisions.storyRevision) add('REVISION_MISMATCH');
    if (attempt.termination.kind !== 'exited' || attempt.termination.exitCode !== 0) add('PROCESS_NOT_SUCCESSFUL');
    const packet = attempt.proposedCompletionPacket;
    if (!packet) add('MISSING_COMPLETION_PACKET');
    else {
      if (packet.manifestHash !== manifest.manifestHash || !identityMatches(manifest.identity, packet.identity)) add('PACKET_CONTRADICTION');
      if (packet.revisions.specRevision !== manifest.revisions.specRevision || packet.revisions.storyRevision !== manifest.revisions.storyRevision) add('PACKET_CONTRADICTION');
      if (packet.proposal !== 'complete') add('PACKET_CONTRADICTION');
      const expectedCriteria = uniqueSorted(manifest.evidenceExpectations.map((item) => item.criterionId));
      const packetCriteria = packet.criterionEvidence.map((item) => item.criterionId);
      if (packetCriteria.length !== new Set(packetCriteria).size
        || canonicalizeStoryContract(uniqueSorted(packetCriteria)) !== canonicalizeStoryContract(expectedCriteria)) {
        add('PACKET_CONTRADICTION');
      }
    }
  }

  let normalizedEvidence: CanonicalLifecycleEvidence[] = [];
  if (host) {
    if (!identityMatches(manifest.identity, host.identity)) add('IDENTITY_MISMATCH');
    if (host.progress && !scopedRecordMatches(manifest, host.progress)) add('PROGRESS_CONTRADICTION');
    if (host.storyResult && !scopedRecordMatches(manifest, host.storyResult)) add('STORY_RESULT_CONTRADICTION');
    if (host.storyResult && host.storyResult.status !== 'pass') add('STORY_RESULT_CONTRADICTION');
    if (host.progress && !host.progress.reportsComplete) add('PROGRESS_CONTRADICTION');
    if (host.storyCommits.some((commit) => !commitMatches(manifest, commit))) add('STORY_COMMIT_CONTRADICTION');
    if (attempt?.observedCommits.some((proposed) => !host.storyCommits.some((observed) => (
      commitMatches(manifest, proposed)
      && proposed.sha === observed.sha
      && proposed.branch === observed.branch
    )))) add('STORY_COMMIT_CONTRADICTION');
    if (attempt?.hostValidationObservations.some((proposed) => !host.validations.some((observed) => (
      proposed.observationId === observed.observationId
      && canonicalizeStoryContract(proposed) === canonicalizeStoryContract(observed)
    )))) add('FORGED_VALIDATION');

    const active = host.activeSubjectRevision;
    const revisionMutated = host.repository.headBeforeValidation !== host.repository.headAfterValidation;
    if (revisionMutated) add('REVISION_MUTATED_DURING_VALIDATION');
    if (host.repository.headAfterValidation !== active.commitSha) add('REVISION_MISMATCH');
    if (!host.repository.worktreeClean) add('DIRTY_WORKTREE');

    const meaningfulFiles = host.repository.changedFiles.filter((file) => !host.repository.runtimeMetadataFiles.includes(file));
    const directCommits = host.storyCommits.filter((commit) => commitMatches(manifest, commit) && commit.sha === active.commitSha && commit.branch === active.branch);
    if (manifest.repositoryProfile.changePolicy === 'code_required' && meaningfulFiles.length === 0 && directCommits.length === 0) {
      add(host.repository.changedFiles.length > 0 ? 'METADATA_ONLY_OUTPUT' : 'MISSING_OBSERVED_OUTPUT');
    }

    for (const requirement of manifest.validationPlan.filter((item) => item.required)) {
      const candidates = host.validations.filter((item) => item.requirementId === requirement.id);
      if (candidates.length === 0) {
        add('MISSING_REQUIRED_VALIDATION');
        continue;
      }
      const observation = candidates[candidates.length - 1];
      if (observation.observer !== 'rorca_host') add('FORGED_VALIDATION', observation.criterionIds);
      if (observation.environment.profileId !== manifest.commandSafety.profileId
        || manifest.commandSafety.redactedEnvironmentKeys.some((key) => !observation.environment.redactedKeys.includes(key))) {
        add('FORGED_VALIDATION', observation.criterionIds);
      }
      const expectedHash = deriveStoryCommandHash(observation.command, observation.args);
      if (observation.commandHash !== expectedHash || observation.commandHash !== requirement.commandHash) add('VALIDATION_COMMAND_MISMATCH', observation.criterionIds);
      if (observation.guardedWorkingDirectory !== manifest.commandSafety.guardedWorkingDirectory
        || !manifest.commandSafety.allowedWorkingDirectories.includes(observation.guardedWorkingDirectory)) {
        add('VALIDATION_CWD_MISMATCH', observation.criterionIds);
      }
      if (observation.subject.commitSha !== active.commitSha
        || observation.subject.worktreePath !== active.worktreePath
        || observation.subject.branch !== active.branch) {
        add('STALE_VALIDATION_REVISION', observation.criterionIds);
      }
      if (requirement.revisionSensitive
        && (observation.repositoryRevisionBefore !== active.commitSha || observation.repositoryRevisionAfter !== active.commitSha)) {
        add('STALE_VALIDATION_REVISION', observation.criterionIds);
      }
      if (observation.classification === 'blocked_by_policy') add('VALIDATION_BLOCKED_BY_POLICY', observation.criterionIds);
      if (observation.classification === 'environment_unavailable') add('VALIDATION_ENVIRONMENT_UNAVAILABLE', observation.criterionIds);
      if (observation.classification === 'story_caused_failure') add('VALIDATION_FAILED_STORY_CAUSED', observation.criterionIds);
      if (observation.classification === 'unrelated_baseline'
        && (manifest.commandSafety.baselineFailurePolicy !== 'allow_with_host_evidence'
          || observation.baselineEvidenceReferences.length === 0
          || !observation.policyTreatmentReference)) {
        add('BASELINE_FAILURE_UNSUPPORTED', observation.criterionIds);
      }
    }

    const hostCriterionIds = new Set(host.criterionEvidence.map((item) => item.criterionId));
    for (const expectation of manifest.evidenceExpectations) {
      const records = host.criterionEvidence.filter((item) => item.criterionId === expectation.criterionId);
      const valid = records.filter((item) => item.observedBy === 'rorca_host'
        && item.subjectRevision === active.commitSha
        && item.evidenceReferences.length > 0);
      if (valid.length === 0) add('MISSING_CRITERION_EVIDENCE', [expectation.criterionId]);
      hostCriterionIds.delete(expectation.criterionId);
    }
    if (hostCriterionIds.size > 0) add('PACKET_CONTRADICTION');
    normalizedEvidence = adaptStoryCloseoutEvidence(manifest, host);
  }

  const reasonCodes = uniqueSorted([...reasons]) as StoryCloseoutReasonCode[];
  const accepted = reasonCodes.length === 0;
  const mappings: AcceptanceCriterionEvidenceMapping[] = manifest.evidenceExpectations.map((expectation) => {
    const hostEvidence = host?.criterionEvidence
      .filter((item) => item.criterionId === expectation.criterionId
        && item.observedBy === 'rorca_host'
        && item.subjectRevision === host.activeSubjectRevision.commitSha)
      .flatMap((item) => item.evidenceReferences) ?? [];
    const blockers = uniqueSorted([...(criterionReasons.get(expectation.criterionId) ?? [])]) as StoryCloseoutReasonCode[];
    if (!accepted && blockers.length === 0 && hostEvidence.length === 0) blockers.push('MISSING_CRITERION_EVIDENCE');
    return {
      criterionId: expectation.criterionId,
      status: blockers.length === 0 && hostEvidence.length > 0 ? 'satisfied' : 'blocked',
      evidenceReferences: uniqueSorted(hostEvidence),
      blockerReasonCodes: blockers,
    };
  });
  const finalReasons = accepted ? ['ACCEPTED' as const] : reasonCodes;
  const base: Omit<StoryCloseoutDecision, 'decisionId'> = {
    schemaVersion: STORY_CLOSEOUT_DECISION_VERSION,
    status: accepted ? 'accepted' : 'blocked',
    reasonCodes: finalReasons,
    acceptanceCriteria: mappings,
    normalizedEvidenceReferences: uniqueSorted(normalizedEvidence.map(evidenceReference)),
    activeSubjectRevision: host?.activeSubjectRevision ?? {
      commitSha: manifest.execution.worktree.baseRevision,
      worktreePath: manifest.execution.worktree.path ?? manifest.commandSafety.guardedWorkingDirectory,
      branch: manifest.execution.worktree.branch ?? 'unknown',
    },
    nextSafeAction: nextAction(reasonCodes),
    compatibility: null,
  };
  return freeze({ ...base, decisionId: stableHash('CLO-sha256:', base) });
}

export async function persistStoryExecutionManifest(
  manifest: StoryManifest,
  db: CloseoutDb = DEFAULT_DB,
): Promise<'inserted' | 'replayed'> {
  if (!verifyStoryExecutionManifest(manifest)) throw new TypeError('Cannot persist a stale or invalid story execution manifest');
  const payload = canonicalizeStoryContract(manifest);
  const inserted = await db.queryOne<{ manifest_hash: string }>(`
    INSERT INTO story_execution_manifests (
      manifest_hash, schema_version, workspace_id, spec_id, run_id, story_id, attempt, spec_revision, story_revision, payload
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
    ON CONFLICT (manifest_hash) DO NOTHING RETURNING manifest_hash
  `, [
    manifest.manifestHash, manifest.schemaVersion, manifest.identity.workspaceId,
    manifest.identity.specId, manifest.identity.runId, manifest.identity.storyId,
    manifest.identity.attempt, manifest.revisions.specRevision, manifest.revisions.storyRevision,
    payload,
  ]);
  if (inserted) return 'inserted';
  const existing = await db.queryOne<{ payload: unknown }>('SELECT payload FROM story_execution_manifests WHERE manifest_hash = $1', [manifest.manifestHash]);
  if (!existing || canonicalizeStoryContract(existing.payload) !== payload) {
    throw new TypeError('Manifest hash replay conflicts with immutable stored payload');
  }
  return 'replayed';
}

/**
 * Idempotent persistence boundary. Attempts are never updated; a same-key,
 * different-payload replay is rejected so restart cannot erase audit history.
 */
export async function persistStoryCloseoutBundle(
  bundle: PersistedCloseoutBundle,
  db: CloseoutDb = DEFAULT_DB,
): Promise<{ manifest: 'inserted' | 'replayed'; attempt: 'inserted' | 'replayed'; decision: 'inserted' | 'replayed'; evidence: EvidencePersistenceResult[] }> {
  if (!verifyStoryAttemptResult(bundle.attempt)) throw new TypeError('Cannot persist a stale or forged attempt result');
  if (!verifyStoryCloseoutDecision(bundle.decision)) throw new TypeError('Cannot persist a stale or forged closeout decision');
  if (!identityMatches(bundle.manifest.identity, bundle.attempt.identity)
    || bundle.attempt.manifestHash !== bundle.manifest.manifestHash
    || bundle.attempt.revisions.specRevision !== bundle.manifest.revisions.specRevision
    || bundle.attempt.revisions.storyRevision !== bundle.manifest.revisions.storyRevision) {
    throw new TypeError('Closeout bundle identity contradicts the immutable manifest');
  }
  const manifestStatus = await persistStoryExecutionManifest(bundle.manifest, db);

  const attemptPayload = canonicalizeStoryContract(bundle.attempt);
  const attemptInserted = await db.queryOne<{ attempt_result_id: string }>(`
    INSERT INTO story_attempt_results (
      attempt_result_id, manifest_hash, workspace_id, spec_id, run_id, story_id, attempt, payload
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
    ON CONFLICT (attempt_result_id) DO NOTHING RETURNING attempt_result_id
  `, [
    bundle.attempt.attemptResultId, bundle.attempt.manifestHash, bundle.attempt.identity.workspaceId,
    bundle.attempt.identity.specId, bundle.attempt.identity.runId, bundle.attempt.identity.storyId,
    bundle.attempt.identity.attempt, attemptPayload,
  ]);
  if (!attemptInserted) {
    const existing = await db.queryOne<{ payload: unknown }>('SELECT payload FROM story_attempt_results WHERE attempt_result_id = $1', [bundle.attempt.attemptResultId]);
    if (!existing || canonicalizeStoryContract(existing.payload) !== attemptPayload) throw new TypeError('Attempt replay conflicts with immutable stored payload');
  }

  const decisionPayload = canonicalizeStoryContract(bundle.decision);
  const decisionInserted = await db.queryOne<{ decision_id: string }>(`
    INSERT INTO story_closeout_decisions (
      decision_id, manifest_hash, attempt_result_id, workspace_id, spec_id, run_id, story_id, attempt, status, payload
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
    ON CONFLICT (decision_id) DO NOTHING RETURNING decision_id
  `, [
    bundle.decision.decisionId, bundle.manifest.manifestHash, bundle.attempt.attemptResultId,
    bundle.manifest.identity.workspaceId, bundle.manifest.identity.specId, bundle.manifest.identity.runId,
    bundle.manifest.identity.storyId, bundle.manifest.identity.attempt, bundle.decision.status, decisionPayload,
  ]);
  if (!decisionInserted) {
    const existing = await db.queryOne<{ payload: unknown }>('SELECT payload FROM story_closeout_decisions WHERE decision_id = $1', [bundle.decision.decisionId]);
    if (!existing || canonicalizeStoryContract(existing.payload) !== decisionPayload) throw new TypeError('Decision replay conflicts with immutable stored payload');
  }

  const evidenceResults: EvidencePersistenceResult[] = [];
  for (const evidence of bundle.evidence) {
    evidenceResults.push(await persistCanonicalEvidence(evidence, db === DEFAULT_DB ? undefined : db));
  }
  return {
    manifest: manifestStatus,
    attempt: attemptInserted ? 'inserted' : 'replayed',
    decision: decisionInserted ? 'inserted' : 'replayed',
    evidence: evidenceResults,
  };
}

export async function loadScopedStoryCommits(
  identity: Pick<StoryManifestIdentity, 'workspaceId' | 'specId' | 'runId' | 'storyId'>,
  db: CloseoutDb = DEFAULT_DB,
): Promise<ObservedStoryCommit[]> {
  const rows = await db.query<{
    workspace_id: string;
    spec_id: string;
    run_id: number;
    story_id: string;
    commit_sha: string;
    branch_name: string | null;
    commit_message: string;
    author: string;
    pushed_at: string | Date;
    observed_source: string;
  }>(`
    SELECT workspace_id, spec_id, run_id, story_id, commit_sha, branch_name,
           commit_message, author, pushed_at, observed_source
    FROM story_commits
    WHERE workspace_id = $1 AND spec_id = $2 AND run_id = $3 AND story_id = $4
    ORDER BY pushed_at, id
  `, [identity.workspaceId, identity.specId, identity.runId, identity.storyId]);
  return rows.map((row) => ({
    workspaceId: row.workspace_id,
    specId: row.spec_id,
    runId: Number(row.run_id),
    storyId: row.story_id,
    sha: row.commit_sha,
    branch: row.branch_name ?? 'unknown',
    message: row.commit_message,
    author: row.author,
    committedAt: new Date(row.pushed_at).toISOString(),
    observedBy: row.observed_source === 'worktree_branch' ? 'worktree_branch' : 'story_commits',
  }));
}

export async function listStoryAttempts(
  identity: Pick<StoryManifestIdentity, 'workspaceId' | 'specId' | 'runId' | 'storyId'>,
  db: CloseoutDb = DEFAULT_DB,
): Promise<StoryAttemptResult[]> {
  const rows = await db.query<{ payload: StoryAttemptResult }>(`
    SELECT payload FROM story_attempt_results
    WHERE workspace_id = $1 AND spec_id = $2 AND run_id = $3 AND story_id = $4
    ORDER BY attempt, created_at
  `, [identity.workspaceId, identity.specId, identity.runId, identity.storyId]);
  return rows.map((row) => freeze(row.payload));
}
