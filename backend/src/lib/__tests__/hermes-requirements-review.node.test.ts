/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { StructuredFindingSchema } from '../../ssdlc/skills/findings';
import { reviewHermesRequirements } from '../hermes-requirements-review';

const REVISION = { kind: 'artifact_digest', value: `sha256:${'a'.repeat(64)}` } as const;
const INPUT = {
  workspaceId: 'workspace-1',
  specSlug: 'source-verified-delivery',
  specRevision: REVISION,
  observedAt: '2026-03-16T00:06:29.000Z',
  stories: [
    {
      id: 'STORY-001',
      title: 'Persist exact source revision',
      description: 'Persist one frozen source revision for later implementation.',
      acceptanceCriteria: ['Given an artifact digest, readback returns the exact digest.'],
      dependsOn: [],
    },
    {
      id: 'STORY-002',
      title: 'Reject changed source revision',
      description: 'Reject one changed source revision before implementation.',
      acceptanceCriteria: ['When the digest changes, persistence rejects the stale revision.'],
      dependsOn: ['STORY-001'],
    },
  ],
};

test('emits canonical verifiability and traceability findings for every story', () => {
  const result = reviewHermesRequirements(INPUT);

  assert.equal(result.contract, 'rorca.hermes-requirements-review.v1');
  assert.equal(result.storyReviews.length, INPUT.stories.length);
  assert.equal(result.findings.length, INPUT.stories.length * 2);
  assert.deepEqual(result.storyReviews.map(({ storyId }) => storyId), ['STORY-001', 'STORY-002']);
  for (const review of result.storyReviews) {
    assert.equal(review.findings.length, 2);
    assert.ok(review.findings.every((finding) => StructuredFindingSchema.safeParse(finding).success));
    assert.deepEqual(review.findings.map(({ controlId }) => controlId), [
      'CTRL-REQUIREMENTS-COMPLETE-VERIFIABLE',
      'CTRL-REQUIREMENTS-TRACEABILITY',
    ]);
    assert.ok(review.findings.every(({ storyId, status }) => storyId === review.storyId && status === 'pass'));
  }
  assert.equal(result.approval.status, 'ready');
});

test('binds each requirements evidence record to its story and exact spec revision', () => {
  const result = reviewHermesRequirements(INPUT);

  assert.equal(result.evidence.length, result.findings.length);
  for (const evidence of result.evidence) {
    assert.equal(evidence.source.system, 'hermes:requirements-review');
    assert.equal(evidence.scope.phaseId, 'requirements');
    assert.ok(INPUT.stories.some(({ id }) => id === evidence.scope.storyId));
    assert.deepEqual(evidence.subject, { type: 'artifact_digest', value: REVISION.value });
    assert.deepEqual(evidence.phaseSubject, evidence.subject);
    assert.equal(evidence.releaseIdentity.artifactDigest, REVISION.value);
    assert.equal(evidence.details.contract, 'rorca.hermes-requirements-finding.v1');
    assert.deepEqual(evidence.details.specRevision, REVISION);
    assert.equal(evidence.details.storyId, evidence.scope.storyId);
    assert.match(evidence.rawReference!, new RegExp(`#story=${evidence.scope.storyId}$`));
  }
});

test('rejects an untraceable spec revision before emitting findings', () => {
  assert.throws(() => reviewHermesRequirements({
    ...INPUT,
    specRevision: { kind: 'floating-branch', value: '' } as never,
  }), /kind|value/i);
  assert.throws(() => reviewHermesRequirements({
    ...INPUT,
    specRevision: { kind: 'spec_version', value: ' branch@revision ' },
  }), /surrounding whitespace/i);
});

test('keeps gaps and visible blocker flags scoped to the finding dimension', () => {
  const result = reviewHermesRequirements({
    ...INPUT,
    stories: [{
      id: 'STORY-PARTIAL-GAP',
      title: 'Persist source revision',
      description: 'Persist one source revision.',
      acceptanceCriteria: ['Works well'],
      dependsOn: [],
    }],
  });

  const [qualityFinding, traceabilityFinding] = result.storyReviews[0].findings;
  const qualityEvidence = result.evidence.find(({ details }) => details.findingId === qualityFinding.findingId)!;
  const traceabilityEvidence = result.evidence.find(({ details }) => details.findingId === traceabilityFinding.findingId)!;

  assert.equal(qualityFinding.status, 'blocker');
  assert.equal(qualityEvidence.details.visiblyBlocked, true);
  assert.match((qualityEvidence.details.blockingGaps as string[]).join(' '), /observably testable/i);
  assert.equal(traceabilityFinding.status, 'pass');
  assert.equal(traceabilityEvidence.details.visiblyBlocked, false);
  assert.deepEqual(traceabilityEvidence.details.blockingGaps, []);
  assert.equal(traceabilityEvidence.status, 'passed');
});

test('visibly blocks stories with concrete testability, atomicity, or traceability gaps', () => {
  const result = reviewHermesRequirements({
    ...INPUT,
    stories: [
      {
        id: 'STORY-GAP',
        title: 'Do things',
        description: 'Implement authentication and also redesign billing as separate independent outcomes.',
        acceptanceCriteria: ['Works well'],
        dependsOn: ['STORY-GAP', 'STORY-MISSING'],
      },
    ],
  });

  assert.equal(result.approval.status, 'blocked');
  assert.deepEqual(result.approval.blockingStoryIds, ['STORY-GAP']);
  assert.equal(result.storyReviews[0].status, 'blocked');
  assert.ok(result.storyReviews[0].blockingGaps.length >= 3);
  assert.match(result.storyReviews[0].blockingGaps.join(' '), /observably testable/i);
  assert.match(result.storyReviews[0].blockingGaps.join(' '), /atomic stories/i);
  assert.match(result.storyReviews[0].blockingGaps.join(' '), /self-dependency/i);
  assert.match(result.storyReviews[0].blockingGaps.join(' '), /unknown dependency/i);
  assert.ok(result.findings.every(({ status }) => status === 'blocker'));
  assert.ok(result.evidence.every((evidence) => evidence.details.visiblyBlocked === true));
  assert.ok(result.evidence.every((evidence) => Array.isArray(evidence.details.blockingGaps)));
});
