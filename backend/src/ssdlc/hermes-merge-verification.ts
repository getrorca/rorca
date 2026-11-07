/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  createCanonicalEvidence,
  type CanonicalLifecycleEvidence,
  type EvidenceScope,
} from '../lib/ssdlc-evidence';

const nonEmpty = z.string().trim().min(1);
const commitSha = z.string().regex(/^[0-9a-f]{40}$/);

export interface AuthorizedMergeIdentity {
  headSha: string;
  changedFiles: readonly string[];
}

export interface MergeVerificationSnapshot {
  headSha: string;
  changedFiles: readonly string[];
  uncommittedChanges: readonly string[];
}

export type MergeVerificationDiscrepancy =
  | { code: 'HEAD_SHA_MISMATCH'; expected: string; observed: string }
  | { code: 'CHANGE_SET_MISMATCH'; missing: readonly string[]; unexpected: readonly string[] }
  | { code: 'UNCOMMITTED_DRIFT'; paths: readonly string[] };

export interface HermesMergeVerificationInput {
  scope: EvidenceScope;
  authorized: AuthorizedMergeIdentity;
  actor: string;
  rawReference: string;
}

export interface MergeSnapshotRequest {
  scope: EvidenceScope;
  authorizedHeadSha: string;
}

export interface HermesMergeVerificationDependencies {
  inspectMergeState(input: MergeSnapshotRequest): Promise<MergeVerificationSnapshot>;
  emitMergeEvidence(evidence: CanonicalLifecycleEvidence): Promise<void>;
}

export interface HermesMergeVerificationResult {
  control: 'merge_allowed' | 'merge_blocked';
  authorized: Readonly<AuthorizedMergeIdentity>;
  snapshot: Readonly<MergeVerificationSnapshot>;
  discrepancies: readonly MergeVerificationDiscrepancy[];
  evidence: CanonicalLifecycleEvidence;
}

function requiredText(value: string, field: string): string {
  const result = nonEmpty.safeParse(value);
  if (!result.success) throw new TypeError(`${field} must be a non-empty string`);
  return result.data;
}

function normalizedPaths(values: readonly string[], field: string): readonly string[] {
  const normalized = z.array(nonEmpty).parse(values).map((value) => value.replaceAll('\\', '/'));
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError(`${field} must not contain duplicate normalized paths`);
  }
  return Object.freeze(normalized.sort((left, right) => left.localeCompare(right)));
}

function exactChangeSetDiscrepancy(
  expected: readonly string[],
  observed: readonly string[],
): MergeVerificationDiscrepancy | null {
  const expectedSet = new Set(expected);
  const observedSet = new Set(observed);
  const missing = Object.freeze(expected.filter((file) => !observedSet.has(file)));
  const unexpected = Object.freeze(observed.filter((file) => !expectedSet.has(file)));
  return missing.length === 0 && unexpected.length === 0
    ? null
    : Object.freeze({ code: 'CHANGE_SET_MISMATCH', missing, unexpected });
}

function describeDiscrepancy(discrepancy: MergeVerificationDiscrepancy): string {
  switch (discrepancy.code) {
    case 'HEAD_SHA_MISMATCH':
      return `HEAD_SHA_MISMATCH expected=${discrepancy.expected} observed=${discrepancy.observed}`;
    case 'CHANGE_SET_MISMATCH':
      return `CHANGE_SET_MISMATCH missing=${JSON.stringify(discrepancy.missing)} unexpected=${JSON.stringify(discrepancy.unexpected)}`;
    case 'UNCOMMITTED_DRIFT':
      return `UNCOMMITTED_DRIFT paths=${JSON.stringify(discrepancy.paths)}`;
  }
}

function eventId(
  scope: EvidenceScope,
  authorized: AuthorizedMergeIdentity,
  snapshot: MergeVerificationSnapshot,
): string {
  const digest = createHash('sha256').update(JSON.stringify({ scope, authorized, snapshot })).digest('hex');
  return `hermes-merge-verification:${digest}`;
}

/**
 * Verify the immutable source identity immediately before merge authorization.
 * Any SHA, complete change-set, or worktree discrepancy default-denies merge and
 * is preserved verbatim in merge-phase evidence.
 */
export function createHermesMergeVerifier(
  dependencies: HermesMergeVerificationDependencies,
  options: { now?: () => Date } = {},
): { verify(input: HermesMergeVerificationInput): Promise<HermesMergeVerificationResult> } {
  const now = options.now ?? (() => new Date());
  return {
    async verify(input) {
      if (input.scope.phaseId !== 'deployment') {
        throw new TypeError('merge verification evidence requires scope.phaseId merge');
      }
      const authorized = Object.freeze({
        headSha: commitSha.parse(input.authorized.headSha),
        changedFiles: normalizedPaths(input.authorized.changedFiles, 'authorized.changedFiles'),
      });
      const actor = requiredText(input.actor, 'actor');
      const rawReference = requiredText(input.rawReference, 'rawReference');
      const inspected = await dependencies.inspectMergeState({
        scope: structuredClone(input.scope),
        authorizedHeadSha: authorized.headSha,
      });
      const snapshot = Object.freeze({
        headSha: commitSha.parse(inspected.headSha),
        changedFiles: normalizedPaths(inspected.changedFiles, 'snapshot.changedFiles'),
        uncommittedChanges: normalizedPaths(inspected.uncommittedChanges, 'snapshot.uncommittedChanges'),
      });

      const discrepancies: MergeVerificationDiscrepancy[] = [];
      if (snapshot.headSha !== authorized.headSha) {
        discrepancies.push(Object.freeze({
          code: 'HEAD_SHA_MISMATCH', expected: authorized.headSha, observed: snapshot.headSha,
        }));
      }
      const changeSetMismatch = exactChangeSetDiscrepancy(authorized.changedFiles, snapshot.changedFiles);
      if (changeSetMismatch) discrepancies.push(changeSetMismatch);
      if (snapshot.uncommittedChanges.length > 0) {
        discrepancies.push(Object.freeze({ code: 'UNCOMMITTED_DRIFT', paths: snapshot.uncommittedChanges }));
      }

      const frozenDiscrepancies = Object.freeze(discrepancies);
      const control = discrepancies.length === 0 ? 'merge_allowed' : 'merge_blocked';
      const observedAt = now();
      const sourceEventId = eventId(input.scope, authorized, snapshot);
      const evidence = createCanonicalEvidence({
        sourceType: 'story_commit',
        sourceSystem: 'hermes:merge-verification',
        sourceEventId,
        observedAt,
        scope: input.scope,
        subject: { type: 'commit_sha', value: snapshot.headSha },
        phaseSubject: { type: 'commit_sha', value: snapshot.headSha },
        releaseIdentity: { commitSha: snapshot.headSha },
        classification: 'approval',
        status: control === 'merge_allowed' ? 'passed' : 'story_caused_failure',
        trustLevel: 'host_observed',
        confidence: 1,
        excerpt: control === 'merge_allowed'
          ? `Merge allowed for exact verified head ${snapshot.headSha} and complete ${snapshot.changedFiles.length}-file change set.`
          : `Merge blocked for head ${snapshot.headSha}: ${discrepancies.map(describeDiscrepancy).join('; ')}.`,
        rawReference,
        provenanceChain: [{
          system: 'hermes:merge-verification',
          eventId: sourceEventId,
          observedAt: observedAt.toISOString(),
          principal: actor,
          verification: 'exact-sha-change-set-and-worktree-integrity',
        }],
        details: {
          phase: 'deployment',
          control,
          authorizedHeadSha: authorized.headSha,
          verifiedHeadSha: control === 'merge_allowed' ? snapshot.headSha : null,
          authorizedChangedFiles: authorized.changedFiles,
          observedChangedFiles: snapshot.changedFiles,
          rationale: control === 'merge_allowed'
            ? 'Observed head and complete change set match authorization exactly; worktree has no uncommitted drift.'
            : 'Merge default-denied because observed source state differs from its authorization.',
          discrepancies: frozenDiscrepancies,
        },
      });

      await dependencies.emitMergeEvidence(evidence);
      return Object.freeze({ control, authorized, snapshot, discrepancies: frozenDiscrepancies, evidence });
    },
  };
}
