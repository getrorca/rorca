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
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const commitSha = z.string().regex(/^[0-9a-f]{40}$/);

export const QA_REVIEW_AREAS = ['workflow-check', 'regression-assessment', 'release-candidate-acceptance'] as const;
export type QaReviewArea = (typeof QA_REVIEW_AREAS)[number];

const findingSchema = z.object({
  findingId: nonEmpty,
  candidateId: nonEmpty,
  area: z.enum(QA_REVIEW_AREAS),
  status: z.enum(['pass', 'fail', 'blocker']),
  summary: nonEmpty,
  expected: nonEmpty,
  observed: nonEmpty,
  evidenceRefs: z.array(nonEmpty).min(1),
}).strict();

const findingsSchema = z.array(findingSchema).min(1).superRefine((findings, context) => {
  const seen = new Set<string>();
  findings.forEach((finding, index) => {
    if (seen.has(finding.findingId)) {
      context.addIssue({
        code: 'custom',
        path: [index, 'findingId'],
        message: 'QA findingId values must be unique within a candidate review',
      });
    }
    seen.add(finding.findingId);
  });
});

export type QaFinding = z.infer<typeof findingSchema>;

export interface ReleaseCandidateIdentity {
  candidateId: string;
  commitSha: string;
  artifactDigest: string;
  preparedBy: string;
}

export interface HermesQaReviewInput {
  scope: EvidenceScope;
  candidate: ReleaseCandidateIdentity;
  actor: string;
  rawReference: string;
}

export interface QaAssessmentInput {
  scope: EvidenceScope;
  candidate: Readonly<ReleaseCandidateIdentity>;
  reviewer: string;
}

export interface HermesQaReviewDependencies {
  assessCandidate(input: QaAssessmentInput): Promise<readonly unknown[]>;
  emitQaEvidence(evidence: CanonicalLifecycleEvidence): Promise<void>;
}

export interface HermesQaReviewResult {
  candidate: Readonly<ReleaseCandidateIdentity>;
  findings: readonly QaFinding[];
  decision: 'accepted' | 'rejected';
  evidence: CanonicalLifecycleEvidence;
}

function requiredText(value: string, field: string): string {
  const result = nonEmpty.safeParse(value);
  if (!result.success) throw new TypeError(`${field} must be a non-empty string`);
  return result.data;
}

function validateCandidate(value: ReleaseCandidateIdentity): ReleaseCandidateIdentity {
  return Object.freeze({
    candidateId: requiredText(value.candidateId, 'candidate.candidateId'),
    commitSha: commitSha.parse(value.commitSha),
    artifactDigest: sha256.parse(value.artifactDigest),
    preparedBy: requiredText(value.preparedBy, 'candidate.preparedBy'),
  });
}

function reviewEventId(input: {
  candidate: ReleaseCandidateIdentity;
  findings: readonly QaFinding[];
  actor: string;
  rawReference: string;
}): string {
  // The external QA session and reviewer are part of source identity. Without
  // them, two independent executions that reach the same findings alias the
  // same persistence idempotency key even though they are distinct evidence.
  const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  return `hermes-qa-review:${digest}`;
}

/**
 * Run Hermes' independent QA judgment against an immutable release-candidate identity.
 * This deliberately emits manual QA evidence, not validation evidence: the assessor judges
 * workflow behavior, regressions, and candidate acceptance after build validation completes.
 */
export function createHermesQaReviewer(
  dependencies: HermesQaReviewDependencies,
  options: { now?: () => Date } = {},
): { review(input: HermesQaReviewInput): Promise<HermesQaReviewResult> } {
  const now = options.now ?? (() => new Date());
  return {
    async review(input) {
      if (input.scope.phaseId !== 'testing') throw new TypeError('QA review evidence requires scope.phaseId testing');
      const scope = Object.freeze(structuredClone(input.scope));
      const candidate = validateCandidate(input.candidate);
      const actor = requiredText(input.actor, 'actor');
      const rawReference = requiredText(input.rawReference, 'rawReference');
      if (actor === candidate.preparedBy) {
        throw new TypeError('QA reviewer must be independent from the release-candidate preparer');
      }

      const assessed = await dependencies.assessCandidate({
        scope,
        candidate,
        reviewer: actor,
      });
      const findings = findingsSchema.parse(assessed);
      if (findings.some((finding) => finding.candidateId !== candidate.candidateId)) {
        throw new TypeError('every QA finding must bind to the reviewed candidateId');
      }
      for (const area of QA_REVIEW_AREAS) {
        if (!findings.some((finding) => finding.area === area)) {
          throw new TypeError(`QA assessment must include ${area}`);
        }
      }

      const decision = findings.every((finding) => finding.status === 'pass') ? 'accepted' : 'rejected';
      const observedAt = now();
      const sourceEventId = reviewEventId({ candidate, findings, actor, rawReference });
      const rationale = findings.map((finding) => `${finding.findingId}: ${finding.summary}`).join('\n');
      const evidence = createCanonicalEvidence({
        sourceType: 'manual_qa',
        sourceSystem: 'hermes:qa-review',
        sourceEventId,
        observedAt,
        scope,
        subject: { type: 'artifact_digest', value: candidate.artifactDigest },
        phaseSubject: { type: 'artifact_digest', value: candidate.artifactDigest },
        releaseIdentity: { commitSha: candidate.commitSha, artifactDigest: candidate.artifactDigest },
        classification: 'testing',
        status: decision === 'accepted' ? 'passed' : 'story_caused_failure',
        trustLevel: 'authenticated_manual',
        confidence: 1,
        excerpt: `QA ${decision} release candidate ${candidate.candidateId}; ${findings.length} structured finding(s).`,
        rawReference,
        actor,
        rationale,
        provenanceChain: [{
          system: 'hermes:qa-review',
          eventId: sourceEventId,
          observedAt: observedAt.toISOString(),
          principal: actor,
          verification: 'independent-release-candidate-assessment',
        }],
        details: {
          phase: 'testing',
          candidate,
          decision,
          reviewAreas: QA_REVIEW_AREAS,
          structuredFindings: findings,
          distinctFromValidation: true,
        },
      });

      await dependencies.emitQaEvidence(evidence);
      return Object.freeze({
        candidate,
        findings: Object.freeze(findings.map((finding) => Object.freeze(finding))),
        decision,
        evidence,
      });
    },
  };
}
