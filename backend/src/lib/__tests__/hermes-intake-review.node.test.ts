/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HERMES_INTAKE_CONCERNS,
  hashHermesBrief,
  reviewHermesIntake,
  type HermesIntakeDecision,
} from '../hermes-intake-review';

const INPUT = {
  workspaceId: 'workspace-1',
  specSlug: 'source-verified-delivery',
  brief: 'Deliver source-verified intake. In scope: persisted specs. Out of scope: deployment. Risk: high because approval is safety critical.',
  observedAt: '2026-03-16T00:06:29.000Z',
};

test('persist intake emits one structured finding for each Hermes concern', () => {
  const result = reviewHermesIntake(INPUT);

  assert.deepEqual(result.findings.map(({ concern }) => concern), [...HERMES_INTAKE_CONCERNS]);
  assert.ok(result.findings.every(({ state, status }) => state === 'unreviewed' && status === 'blocker'));
  assert.ok(result.findings.every(({ skillId }) => skillId.startsWith('family:intake/')));
  assert.ok(result.findings.every(({ evidenceRefs }) => evidenceRefs.length === 1 && evidenceRefs[0] === `brief:${result.briefHash}`));
  assert.equal(new Set(result.findings.map(({ findingId }) => findingId)).size, 3);
  assert.equal(result.approval.status, 'blocked');
  assert.deepEqual(result.approval.blockingFindingIds, result.findings.map(({ findingId }) => findingId));
});

test('brief identity covers the complete normalized persisted brief', () => {
  const sharedPrefix = 'x'.repeat(64 * 1_024);

  assert.notEqual(hashHermesBrief(`${sharedPrefix} first ending`), hashHermesBrief(`${sharedPrefix} second ending`));
  assert.equal(hashHermesBrief('  normalized brief\n'), hashHermesBrief('normalized brief'));
});

test('findings surface as canonical intake evidence exactly bound to the brief', () => {
  const result = reviewHermesIntake(INPUT);

  assert.match(result.briefHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.evidence.length, result.findings.length);
  for (const [index, evidence] of result.evidence.entries()) {
    const finding = result.findings[index];
    assert.equal(evidence.schemaVersion, 'rorca.lifecycle-evidence.v1');
    assert.equal(evidence.scope.phaseId, 'intake');
    assert.equal(evidence.scope.storyId, 'AAV-012');
    assert.deepEqual(evidence.subject, { type: 'spec_hash', value: result.briefHash });
    assert.deepEqual(evidence.phaseSubject, evidence.subject);
    assert.equal(evidence.details.contract, 'rorca.hermes-intake-finding.v1');
    assert.equal(evidence.details.findingId, finding.findingId);
    assert.equal(evidence.details.briefHash, result.briefHash);
    assert.equal(evidence.status, 'unknown');
  }
});

test('contested findings remain blocking while satisfied and justified waivers permit approval', () => {
  const initial = reviewHermesIntake(INPUT);
  const decisions: HermesIntakeDecision[] = initial.findings.map(({ findingId }, index) => ({
    findingId,
    state: index === 1 ? 'waived' : 'satisfied',
    reviewerId: 'reviewer:local-human',
    ...(index === 1 ? { rationale: 'Scope boundary accepted for this time-boxed research forge.' } : {}),
  }));
  const approved = reviewHermesIntake({ ...INPUT, decisions });

  assert.equal(approved.approval.status, 'approved');
  assert.deepEqual(approved.approval.waivedFindingIds, [initial.findings[1].findingId]);
  assert.equal(approved.evidence[1].status, 'skipped_with_rationale');
  assert.equal(approved.evidence[1].details.reviewState, 'waived');
  assert.ok(approved.findings.every(({ status }) => status === 'pass'));
  assert.ok(approved.evidence.filter(({ status }) => status === 'passed').length === 2);

  const contested = reviewHermesIntake({
    ...INPUT,
    decisions: [{
      findingId: initial.findings[0].findingId,
      state: 'contested',
      reviewerId: 'reviewer:local-human',
      rationale: 'The outcome measure needs product-owner clarification.',
    }],
  });
  assert.equal(contested.approval.status, 'blocked');
  assert.ok(contested.approval.blockingFindingIds.includes(initial.findings[0].findingId));
  assert.throws(() => reviewHermesIntake({
    ...INPUT,
    decisions: [{ findingId: initial.findings[1].findingId, state: 'waived', reviewerId: 'reviewer:local-human' }],
  }), /requires a rationale/);
});

test('waiver inputs fail closed and remain bounded in lifecycle evidence', () => {
  const initial = reviewHermesIntake(INPUT);
  const findingId = initial.findings[0].findingId;

  assert.throws(() => reviewHermesIntake({
    ...INPUT,
    decisions: [{ findingId, state: 'ignored', reviewerId: 'reviewer:local-human' } as unknown as HermesIntakeDecision],
  }), /invalid intake finding state ignored/);

  const bounded = reviewHermesIntake({
    ...INPUT,
    decisions: [{ findingId, state: 'waived', reviewerId: 'reviewer:local-human', rationale: 'x'.repeat(5_000) }],
  });
  assert.equal(bounded.findings[0].rationale?.length, 4_096);
  assert.equal(bounded.evidence[0].details.rationale, bounded.findings[0].rationale);
  assert.equal(bounded.approval.status, 'blocked', 'remaining unreviewed findings still block intake');
});
