/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createHermesArchitectureReviewer,
  threatModelApplies,
  type ThreatModelPassInput,
} from '../hermes-architecture-review';

const NOW = new Date('2026-03-16T00:06:29.000Z');
const SPEC_HASH = `sha256:${'a'.repeat(64)}`;
const scope = {
  workspaceId: 'workspace-1', specSlug: 'payment-executor', runId: 14,
  storyId: 'AAV-014', phaseId: 'design', gateId: 'plan',
};
const decision = {
  decisionId: 'ADR-014',
  stakeholder: 'Platform operator',
  concern: 'Commands must not cross an unreviewed trust boundary.',
  decision: 'Run commands through the bounded execution adapter.',
  rationale: 'A single adapter keeps invocation policy and audit evidence consistent.',
  status: 'pass',
  evidenceRefs: ['spec:ADR-014'],
};

function input(changeSurfaces: Array<'auth' | 'secrets' | 'network-egress' | 'execution-boundary' | 'interface'> = ['interface']) {
  return {
    scope,
    specHash: SPEC_HASH,
    changeSurfaces,
    decisions: [decision],
    rawReference: 'forge/specs/approved/payment-executor.json',
    actor: 'hermes:architecture-reviewer',
  };
}

test('emits architecture-phase evidence with stakeholder concerns and decision rationale', async () => {
  let threatCalls = 0;
  const emitted = [] as unknown[];
  const reviewer = createHermesArchitectureReviewer({
    async runThreatModel() { threatCalls += 1; return []; },
    async emitArchitectureEvidence(evidence) { emitted.push(evidence); },
  }, { now: () => NOW });

  const result = await reviewer.review(input());

  assert.equal(threatCalls, 0);
  assert.deepEqual(emitted, [result.evidence]);
  assert.equal(result.evidence.schemaVersion, 'rorca.lifecycle-evidence.v1');
  assert.equal(result.evidence.scope.phaseId, 'architecture');
  assert.equal(result.evidence.classification, 'documentation');
  assert.equal(result.evidence.status, 'passed');
  assert.match(result.evidence.rationale ?? '', /single adapter keeps invocation policy/);
  assert.deepEqual(result.evidence.details.decisions, [decision]);
  assert.deepEqual(result.threatModel, { applicable: false, executed: false, surfaces: [] });
});

test('threat pass applicability covers every mandated sensitive boundary and excludes ordinary surfaces', () => {
  for (const surface of ['auth', 'secrets', 'network-egress', 'execution-boundary'] as const) {
    assert.equal(threatModelApplies([surface]), true, surface);
  }
  assert.equal(threatModelApplies(['interface', 'storage', 'other']), false);
});

test('runs the threat-model pass for a sensitive surface and surfaces each failing finding as a structured gap', async () => {
  let passInput: ThreatModelPassInput | undefined;
  const finding = {
    findingId: 'TM-014-1',
    threat: 'Untrusted arguments can alter command behavior.',
    affectedBoundary: 'spec to command runner',
    mitigation: 'Use direct executable arguments and an allowlist.',
    residualRisk: 'Allowlist configuration drift remains.',
    status: 'blocker',
    evidenceRefs: ['threat-model:TM-014-1'],
  };
  const emitted = [] as unknown[];
  const reviewer = createHermesArchitectureReviewer({
    async runThreatModel(value) { passInput = value; return [finding]; },
    async emitArchitectureEvidence(evidence) { emitted.push(evidence); },
  }, { now: () => NOW });

  const result = await reviewer.review(input(['execution-boundary', 'network-egress']));

  assert.deepEqual(passInput?.changeSurfaces, ['execution-boundary', 'network-egress']);
  assert.deepEqual(result.threatFindings, [finding]);
  assert.equal(result.evidence.status, 'story_caused_failure');
  assert.deepEqual(result.gaps, [{
    gapId: 'threat-model:TM-014-1',
    category: 'threat-model',
    status: 'blocker',
    controlId: 'CTRL-DESIGN-THREAT-BOUNDARIES',
    message: 'Untrusted arguments can alter command behavior.; boundary: spec to command runner; mitigation: Use direct executable arguments and an allowlist.',
    decisionRationale: 'Residual risk: Allowlist configuration drift remains.',
    evidenceRefs: ['threat-model:TM-014-1'],
  }]);
  assert.deepEqual(result.evidence.details.structuredGaps, result.gaps);
  assert.deepEqual(emitted, [result.evidence]);
  assert.deepEqual(result.threatModel, {
    applicable: true, executed: true, surfaces: ['execution-boundary', 'network-egress'],
  });
});

test('fails closed with a structured blocker when a mandatory threat pass returns no findings', async () => {
  let calls = 0;
  const reviewer = createHermesArchitectureReviewer({
    async runThreatModel() { calls += 1; return []; },
    async emitArchitectureEvidence() {},
  }, { now: () => NOW });

  const result = await reviewer.review(input(['auth']));

  assert.equal(calls, 1);
  assert.equal(result.gaps.length, 1);
  assert.equal(result.gaps[0].gapId, 'threat-model:missing-findings');
  assert.equal(result.gaps[0].status, 'blocker');
  assert.equal(result.evidence.status, 'story_caused_failure');
  assert.deepEqual(result.evidence.details.structuredGaps, result.gaps);
});

test('emits structured blocker evidence instead of dropping malformed or failed threat passes', async () => {
  const emitted = [] as unknown[];
  const malformedReviewer = createHermesArchitectureReviewer({
    async runThreatModel() { return [{ findingId: 'TM-INCOMPLETE' }]; },
    async emitArchitectureEvidence(evidence) { emitted.push(evidence); },
  }, { now: () => NOW });
  const failedReviewer = createHermesArchitectureReviewer({
    async runThreatModel() { throw new Error('provider unavailable'); },
    async emitArchitectureEvidence(evidence) { emitted.push(evidence); },
  }, { now: () => NOW });

  const malformed = await malformedReviewer.review(input(['secrets']));
  const failed = await failedReviewer.review(input(['network-egress']));

  assert.equal(malformed.gaps[0].gapId, 'threat-model:invalid-findings');
  assert.equal(failed.gaps[0].gapId, 'threat-model:pass-failed');
  assert.deepEqual(emitted, [malformed.evidence, failed.evidence]);
  for (const result of [malformed, failed]) {
    assert.equal(result.threatModel.executed, true);
    assert.equal(result.gaps[0].category, 'threat-model');
    assert.equal(result.gaps[0].status, 'blocker');
    assert.equal(result.evidence.status, 'story_caused_failure');
    assert.deepEqual(result.evidence.details.structuredGaps, result.gaps);
  }
});
