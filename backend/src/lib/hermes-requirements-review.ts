/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Hermes per-story requirements verification (AAV-013).
 *
 * Produces only the canonical US-006 StructuredFinding shape and projects every
 * finding into exact-revision, story-scoped lifecycle evidence. The review is
 * pure and database-free so forging can fail closed before implementation.
 */
import { createHash } from 'node:crypto';
import { RevisionRefV1Schema, type RevisionRefV1 } from './mission-contracts';
import { createCanonicalEvidence, type CanonicalLifecycleEvidence, type EvidenceSubjectIdentity } from './ssdlc-evidence';
import { StructuredFindingSchema, type StructuredFinding } from '../ssdlc/skills/findings';

export interface HermesRequirementStory {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: readonly string[];
  dependsOn?: readonly string[];
}

export interface HermesStoryRequirementsReview {
  storyId: string;
  findings: readonly StructuredFinding[];
  blockingGaps: readonly string[];
  status: 'verified' | 'blocked';
}

export interface HermesRequirementsReviewResult {
  contract: 'rorca.hermes-requirements-review.v1';
  specRevision: RevisionRefV1;
  storyReviews: readonly HermesStoryRequirementsReview[];
  findings: readonly StructuredFinding[];
  evidence: readonly CanonicalLifecycleEvidence[];
  approval: {
    status: 'ready' | 'blocked';
    blockingStoryIds: readonly string[];
    blockingFindingIds: readonly string[];
  };
}

type FindingDimension = 'verifiability_atomicity' | 'traceability';

const DIMENSIONS = {
  verifiability_atomicity: {
    controlId: 'CTRL-REQUIREMENTS-COMPLETE-VERIFIABLE',
    skillId: 'aav:requirements-assurance',
    requirementId: 'ISO-29148:testable-atomic',
  },
  traceability: {
    controlId: 'CTRL-REQUIREMENTS-TRACEABILITY',
    skillId: 'rorca:requirements-traceability',
    requirementId: 'ISO-29148:traceable',
  },
} as const;

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} must be a non-empty string`);
  return normalized;
}

function revisionSubject(revision: RevisionRefV1): EvidenceSubjectIdentity {
  if (revision.kind === 'artifact_digest' || revision.kind === 'commit_sha') {
    return { type: revision.kind, value: revision.value };
  }
  return { type: 'spec_hash', value: `${revision.kind}:${revision.value}` };
}

function isObservableCriterion(criterion: string): boolean {
  const text = criterion.trim();
  if (text.length < 12) return false;
  return /\b(given|when|then|returns?|rejects?|emits?|records?|contains?|includes?|equals?|matches?|renders?|shows?|visible|readback|passes?|fails?|persists?|creates?|updates?|remains?|cannot|never|exact)\b/i.test(text);
}

function qualityGaps(story: HermesRequirementStory): string[] {
  const gaps: string[] = [];
  if (!story.title.trim()) gaps.push('Add a concise story title naming one outcome.');
  if (!story.description.trim()) gaps.push('Add a description of the single implementation outcome.');
  if (story.acceptanceCriteria.length === 0) {
    gaps.push('Add at least one observable acceptance criterion.');
  } else {
    story.acceptanceCriteria.forEach((criterion, index) => {
      if (!isObservableCriterion(criterion)) {
        gaps.push(`Acceptance criterion ${index + 1} is not observably testable; name an inspectable result or rejection.`);
      }
    });
  }
  if (/\b(unrelated|independent) (?:outcome|feature|change)s?\b/i.test(story.description)
    || /\b(and also|as well as separately)\b/i.test(story.description)) {
    gaps.push('Split the story into atomic stories; the description names separate outcomes.');
  }
  return gaps;
}

function traceabilityGaps(story: HermesRequirementStory, knownStoryIds: ReadonlySet<string>, duplicateIds: ReadonlySet<string>): string[] {
  const gaps: string[] = [];
  if (duplicateIds.has(story.id)) gaps.push(`Make story ID ${story.id} unique within this spec revision.`);
  const dependencies = story.dependsOn ?? [];
  if (dependencies.includes(story.id)) gaps.push(`Remove self-dependency ${story.id}.`);
  for (const dependency of dependencies) {
    if (!knownStoryIds.has(dependency)) gaps.push(`Replace unknown dependency ${dependency} with a story ID in this spec revision.`);
  }
  return gaps;
}

function buildFinding(
  storyId: string,
  revision: RevisionRefV1,
  dimension: FindingDimension,
  gaps: readonly string[],
  occurrence: number,
): StructuredFinding {
  const definition = DIMENSIONS[dimension];
  const digest = createHash('sha256')
    .update(JSON.stringify({ revision, storyId, dimension, occurrence }))
    .digest('hex')
    .slice(0, 24);
  return StructuredFindingSchema.parse({
    findingId: `hermes-requirements:${digest}:${dimension}`,
    controlId: definition.controlId,
    skillId: definition.skillId,
    requirementId: definition.requirementId,
    storyId,
    status: gaps.length === 0 ? 'pass' : 'blocker',
    evidenceRefs: [`spec-revision:${revision.kind}:${revision.value}`, `story:${storyId}`],
    message: gaps.length === 0
      ? `${dimension === 'traceability' ? 'Traceability' : 'Verifiability and atomicity'} checks passed for ${storyId}.`
      : gaps.join(' '),
  });
}

function findingEvidence(input: {
  finding: StructuredFinding;
  gaps: readonly string[];
  workspaceId: string;
  specSlug: string;
  specRevision: RevisionRefV1;
  observedAt: string;
}): CanonicalLifecycleEvidence {
  const subject = revisionSubject(input.specRevision);
  return createCanonicalEvidence({
    sourceType: 'wal_validation',
    sourceSystem: 'hermes:requirements-review',
    sourceEventId: `${input.finding.findingId}:${createHash('sha256').update(input.observedAt).digest('hex')}`,
    observedAt: input.observedAt,
    scope: {
      workspaceId: input.workspaceId,
      specSlug: input.specSlug,
      runId: null,
      storyId: input.finding.storyId!,
      phaseId: 'requirements',
      gateId: 'requirements-verification',
    },
    subject,
    phaseSubject: subject,
    releaseIdentity: {
      ...(subject.type === 'artifact_digest' ? { artifactDigest: subject.value } : {}),
      ...(subject.type === 'commit_sha' ? { commitSha: subject.value } : {}),
    },
    classification: 'testing',
    status: input.finding.status === 'pass' ? 'passed' : 'unknown',
    trustLevel: 'agent_proposed',
    confidence: 0.9,
    excerpt: input.finding.message,
    rawReference: `spec-revision:${input.specRevision.kind}:${input.specRevision.value}#story=${encodeURIComponent(input.finding.storyId!)}`,
    details: {
      contract: 'rorca.hermes-requirements-finding.v1',
      ...input.finding,
      specRevision: input.specRevision,
      blockingGaps: input.gaps,
      visiblyBlocked: input.finding.status === 'blocker',
    },
  });
}

/** Verify every story and emit exact-revision requirements-phase evidence. */
export function reviewHermesRequirements(input: {
  workspaceId: string;
  specSlug: string;
  specRevision: RevisionRefV1;
  stories: readonly HermesRequirementStory[];
  observedAt?: Date | string;
}): HermesRequirementsReviewResult {
  const workspaceId = requiredText(input.workspaceId, 'workspaceId');
  const specSlug = requiredText(input.specSlug, 'specSlug');
  // Parse at this boundary so findings can never claim an empty, unknown, or
  // oversized revision identity that canonical evidence cannot trace exactly.
  const specRevision = RevisionRefV1Schema.parse(input.specRevision);
  if (specRevision.value !== specRevision.value.trim()) {
    throw new TypeError('specRevision.value must not contain surrounding whitespace');
  }
  if (input.stories.length === 0) throw new TypeError('stories must contain at least one story');
  const stories = input.stories.map((story, index) => ({
    ...story,
    id: requiredText(story.id, `stories.${index}.id`),
    title: story.title ?? '',
    description: story.description ?? '',
    acceptanceCriteria: story.acceptanceCriteria ?? [],
    dependsOn: story.dependsOn ?? [],
  }));
  const idCounts = new Map<string, number>();
  stories.forEach(({ id }) => idCounts.set(id, (idCounts.get(id) ?? 0) + 1));
  const duplicateIds = new Set([...idCounts].filter(([, count]) => count > 1).map(([id]) => id));
  const knownStoryIds = new Set(stories.map(({ id }) => id));
  const observedAt = new Date(input.observedAt ?? new Date()).toISOString();

  const reviewedStories = stories.map((story, occurrence) => {
    const dimensions = [
      ['verifiability_atomicity', qualityGaps(story)],
      ['traceability', traceabilityGaps(story, knownStoryIds, duplicateIds)],
    ] as const;
    const findings = dimensions.map(([dimension, gaps]) => buildFinding(story.id, specRevision, dimension, gaps, occurrence));
    const blockingGaps = dimensions.flatMap(([, gaps]) => gaps);
    const review: HermesStoryRequirementsReview = Object.freeze({
      storyId: story.id,
      findings: Object.freeze(findings),
      blockingGaps: Object.freeze(blockingGaps),
      status: blockingGaps.length === 0 ? 'verified' : 'blocked',
    });
    return { review, dimensions };
  });
  const storyReviews = reviewedStories.map(({ review }) => review);
  const findings = storyReviews.flatMap(({ findings: storyFindings }) => storyFindings);
  const evidence = reviewedStories.flatMap(({ review, dimensions }) => review.findings.map((finding, index) => findingEvidence({
    finding,
    // Evidence is finding-scoped: a passing dimension must not inherit a gap
    // (or a visible blocker flag) from another dimension on the same story.
    gaps: dimensions[index][1],
    workspaceId,
    specSlug,
    specRevision,
    observedAt,
  })));
  const blockingStoryIds = [...new Set(storyReviews.filter(({ status }) => status === 'blocked').map(({ storyId }) => storyId))];
  const blockingFindingIds = findings.filter(({ status }) => status === 'blocker').map(({ findingId }) => findingId);

  return Object.freeze({
    contract: 'rorca.hermes-requirements-review.v1',
    specRevision: structuredClone(specRevision),
    storyReviews: Object.freeze(storyReviews),
    findings: Object.freeze(findings),
    evidence: Object.freeze(evidence),
    approval: Object.freeze({
      status: blockingFindingIds.length === 0 ? 'ready' : 'blocked',
      blockingStoryIds: Object.freeze(blockingStoryIds),
      blockingFindingIds: Object.freeze(blockingFindingIds),
    }),
  });
}
