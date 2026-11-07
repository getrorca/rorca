/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { CanonicalLifecycleEvidence } from '../../lib/ssdlc-evidence';
import {
  createHermesQaReviewer,
  type QaAssessmentInput,
} from '../hermes-qa-review';

const NOW = new Date('2026-03-16T00:06:29.000Z');
const candidate = {
  candidateId: 'rc-2026.03.16.1',
  commitSha: 'a'.repeat(40),
  artifactDigest: `sha256:${'b'.repeat(64)}`,
  preparedBy: 'delivery:release-builder',
};
const scope = {
  workspaceId: 'workspace-1', specSlug: 'source-verified-delivery', runId: 16,
  storyId: 'AAV-016', phaseId: 'testing', gateId: 'release-candidate',
};

function findings(status: 'pass' | 'fail' = 'pass') {
  return [
    {
      findingId: 'QA-WORKFLOW-1', candidateId: candidate.candidateId, area: 'workflow-check', status,
      summary: 'Primary delivery workflow completed as an operator would execute it.',
      expected: 'The release workflow completes and preserves evidence links.',
      observed: 'The candidate completed the workflow with linked evidence.',
      evidenceRefs: ['qa-session:workflow-1'],
    },
    {
      findingId: 'QA-REGRESSION-1', candidateId: candidate.candidateId, area: 'regression-assessment', status: 'pass',
      summary: 'Affected existing workflows show no candidate regression.',
      expected: 'Existing release workflows retain prior behavior.',
      observed: 'Regression scenarios retained their accepted behavior.',
      evidenceRefs: ['qa-session:regression-1'],
    },
    {
      findingId: 'QA-ACCEPTANCE-1', candidateId: candidate.candidateId, area: 'release-candidate-acceptance', status: 'pass',
      summary: 'The identified candidate is acceptable for release.',
      expected: 'No unresolved release-blocking QA findings.',
      observed: 'All release acceptance checks passed.',
      evidenceRefs: ['qa-session:acceptance-1'],
    },
  ];
}

function input() {
  return {
    scope: { ...scope },
    candidate,
    actor: 'hermes:independent-qa',
    rawReference: 'qa://sessions/rc-2026.03.16.1',
  };
}

test('runs an independent release-candidate review and emits candidate-bound QA evidence', async () => {
  let assessment: QaAssessmentInput | undefined;
  const emitted: CanonicalLifecycleEvidence[] = [];
  const reviewer = createHermesQaReviewer({
    async assessCandidate(value) { assessment = value; return findings(); },
    async emitQaEvidence(evidence) { emitted.push(evidence); },
  }, { now: () => NOW });

  const result = await reviewer.review(input());

  assert.equal(assessment?.reviewer, 'hermes:independent-qa');
  assert.deepEqual(assessment?.candidate, candidate);
  assert.equal(result.decision, 'accepted');
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0], result.evidence);
  assert.equal(result.evidence.source.type, 'manual_qa');
  assert.equal(result.evidence.classification, 'qa');
  assert.equal(result.evidence.status, 'passed');
  assert.equal(result.evidence.scope.phaseId, 'qa');
  assert.deepEqual(result.evidence.subject, { type: 'artifact_digest', value: candidate.artifactDigest });
  assert.deepEqual(result.evidence.releaseIdentity, {
    commitSha: candidate.commitSha, artifactDigest: candidate.artifactDigest, deploymentId: null,
  });
  assert.equal(result.evidence.lineageVerified, true);
  assert.equal(result.evidence.details.distinctFromValidation, true);
  assert.deepEqual(result.evidence.details.structuredFindings, findings());
});

test('emits rejected QA evidence when a structured workflow finding fails', async () => {
  const emitted: CanonicalLifecycleEvidence[] = [];
  const reviewer = createHermesQaReviewer({
    async assessCandidate() { return findings('fail'); },
    async emitQaEvidence(evidence) { emitted.push(evidence); },
  }, { now: () => NOW });

  const result = await reviewer.review(input());

  assert.equal(result.decision, 'rejected');
  assert.equal(result.evidence.status, 'story_caused_failure');
  assert.equal(emitted.length, 1);
});

test('rejects non-independent reviewers before assessment or evidence emission', async () => {
  let calls = 0;
  const reviewer = createHermesQaReviewer({
    async assessCandidate() { calls += 1; return findings(); },
    async emitQaEvidence() { calls += 1; },
  });

  await assert.rejects(
    reviewer.review({ ...input(), actor: candidate.preparedBy }),
    /independent from the release-candidate preparer/,
  );
  assert.equal(calls, 0);
});

test('rejects findings bound to another candidate and does not emit evidence', async () => {
  let emitted = false;
  const mismatched = findings().map((finding, index) => index === 0
    ? { ...finding, candidateId: 'rc-other' }
    : finding);
  const reviewer = createHermesQaReviewer({
    async assessCandidate() { return mismatched; },
    async emitQaEvidence() { emitted = true; },
  });

  await assert.rejects(reviewer.review(input()), /every QA finding must bind/);
  assert.equal(emitted, false);
});

test('fails closed when an assessment omits a required QA review area', async () => {
  let emitted = false;
  const reviewer = createHermesQaReviewer({
    async assessCandidate() {
      return findings().filter(({ area }) => area !== 'regression-assessment');
    },
    async emitQaEvidence() { emitted = true; },
  });

  await assert.rejects(reviewer.review(input()), /must include regression-assessment/);
  assert.equal(emitted, false);
});

test('rejects duplicate finding identities before evidence emission', async () => {
  let emitted = false;
  const duplicated = findings().map((finding, index) => index === 1
    ? { ...finding, findingId: 'QA-WORKFLOW-1' }
    : finding);
  const reviewer = createHermesQaReviewer({
    async assessCandidate() { return duplicated; },
    async emitQaEvidence() { emitted = true; },
  });

  await assert.rejects(reviewer.review(input()), /findingId values must be unique/);
  assert.equal(emitted, false);
});

test('snapshots QA scope before asynchronous assessment', async () => {
  const reviewInput = input();
  const reviewer = createHermesQaReviewer({
    async assessCandidate(assessment) {
      reviewInput.scope.phaseId = 'validation';
      assert.equal(assessment.scope.phaseId, 'qa');
      return findings();
    },
    async emitQaEvidence() {},
  }, { now: () => NOW });

  const result = await reviewer.review(reviewInput);

  assert.equal(result.evidence.scope.phaseId, 'qa');
  assert.equal(result.evidence.details.phase, 'qa');
});

test('gives distinct QA sessions distinct evidence source identities', async () => {
  const emitted: CanonicalLifecycleEvidence[] = [];
  const reviewer = createHermesQaReviewer({
    async assessCandidate() { return findings(); },
    async emitQaEvidence(evidence) { emitted.push(evidence); },
  }, { now: () => NOW });

  const first = await reviewer.review(input());
  const retry = await reviewer.review(input());
  const secondSession = await reviewer.review({ ...input(), rawReference: 'qa://sessions/rc-2026.03.16.1-rerun' });

  assert.equal(retry.evidence.source.eventId, first.evidence.source.eventId);
  assert.notEqual(secondSession.evidence.source.eventId, first.evidence.source.eventId);
  assert.equal(emitted.length, 3);
});
