/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { CanonicalLifecycleEvidence } from '../../../lib/ssdlc-evidence';
import type { PhaseControlGroup } from '../../gates/gate-compiler';
import type { ControlRecord, EvidenceRequirement, Phase } from '../../schema/control-schema';
import { evaluateGate, type EvaluateGateInput } from '../gate-evaluator';

const requirement: EvidenceRequirement = {
  classification: 'artifact',
  allowedSourceTypes: ['wal_validation'],
  requiredBindings: { subject: true, release: true },
  minimumTrust: 'tool-verified',
  evidenceDepth: 'demonstrated',
  freshness: { maxAgeSeconds: 3_600 },
};

function control(phase: Phase = 'development'): ControlRecord {
  return {
    schemaVersion: 'rorca.ssdlc-control-record.v1', version: '1.0.0', controlId: `CTRL-${phase}`,
    phase, objective: 'Prove the current delivery subject',
    applicability: { universal: true, productProfiles: [], riskProfiles: [], domainRegulatory: [] },
    sourceReferences: [{ genesisEvidenceId: 'GEN-1', citation: 'Canonical authority section 1' }],
    sourceStrength: 'primary', requiredEvidence: [requirement], failureSeverity: 'blocking',
    exceptionPolicy: { allowed: true, approvalRequired: true, justificationRequired: true, maxDurationDays: 7 },
    skillRefs: ['skill:evaluate-current-proof'],
  };
}

function group(item: ControlRecord): PhaseControlGroup {
  return {
    phase: item.phase, controlIds: [item.controlId], families: { proof: [item.controlId] }, missingFamilies: [],
    evidenceRequirements: [{ ...requirement, controlId: item.controlId, sourceReferences: item.sourceReferences }],
  };
}

function evidence(overrides: Partial<CanonicalLifecycleEvidence> = {}): CanonicalLifecycleEvidence {
  return {
    schemaVersion: 'rorca.lifecycle-evidence.v1',
    source: { type: 'wal_validation', system: 'rorca-host', eventId: 'event-1' },
    observedAt: '2026-01-01T00:20:00.000Z',
    scope: { workspaceId: 'ws-1', specSlug: 'spec-1', runId: 9, storyId: 'US-5', phaseId: null, gateId: null },
    subject: { type: 'spec_hash', value: 'sha256:spec' }, phaseSubject: null,
    releaseIdentity: { commitSha: 'abc123', artifactDigest: 'sha256:artifact', deploymentId: 'deploy-1' },
    classification: 'testing', status: 'passed', trustLevel: 'host_observed', confidence: 1,
    excerpt: 'validation passed', rawReference: 'wal:9:validation', provenanceChain: [], actor: 'host', rationale: null,
    details: { evidenceDepth: 'demonstrated' }, revisionMismatch: false, lineageVerified: true,
    sourcePayloadHash: null, payloadHash: 'sha256:payload',
    ...overrides,
  };
}

function input(item = control(), records: CanonicalLifecycleEvidence[] = [evidence()]): EvaluateGateInput {
  return {
    stage: item.phase === 'maintenance' ? 'maintenance' : 'development', compilation: { phaseGroups: [group(item)] }, controls: [item], evidence: records,
    subject: {
      specHash: 'sha256:spec', commitSha: 'abc123', artifactDigest: 'sha256:artifact', deploymentId: 'deploy-1',
      mutatedAt: '2026-01-01T00:10:00.000Z', workspaceId: 'ws-1', specSlug: 'spec-1', runId: 9,
    },
    evaluatedAt: '2026-01-01T00:30:00.000Z',
  };
}

test('passes matching canonical evidence and records authority, evidence, and skill support', () => {
  const result = evaluateGate(input());
  assert.equal(result.status, 'pass');
  assert.equal(result.stageProjection.status, 'ready');
  const outcome = result.controlResults[0];
  assert.equal(outcome.status, 'pass');
  assert.deepEqual(outcome.authoritySupport, [{ genesisEvidenceId: 'GEN-1', citation: 'Canonical authority section 1' }]);
  assert.equal(outcome.demonstratedEvidence.length, 1);
  assert.deepEqual(outcome.evaluatedSkills, ['skill:evaluate-current-proof']);
});

test('rejects non-canonical envelopes and blocks absent canonical evidence with the requirement named', () => {
  assert.throws(() => evaluateGate(input(control(), [{ ...evidence(), schemaVersion: 'hermes.evidence.v1' } as unknown as CanonicalLifecycleEvidence])), /only rorca.lifecycle-evidence.v1/);
  const result = evaluateGate(input(control(), []));
  assert.equal(result.status, 'blocked');
  assert.match(result.controlResults[0].reasons[0], /Missing matching current evidence requirement 1.*artifact.*wal_validation.*demonstrated/);
});

test('rejects evidence whose canonical classification does not match the control requirement', () => {
  const result = evaluateGate(input(control(), [evidence({ classification: 'approval' })]));
  assert.equal(result.status, 'blocked');
  assert.match(result.controlResults[0].reasons.join(' '), /Missing matching current evidence requirement 1.*artifact/);
});

test('rejects absent or mismatched spec, commit, required release identity, and lineage', () => {
  const record = evidence({
    subject: { type: 'spec_hash', value: 'sha256:other' },
    releaseIdentity: { commitSha: null, artifactDigest: 'sha256:other', deploymentId: null },
    revisionMismatch: true, lineageVerified: false,
  });
  const result = evaluateGate(input(control(), [record]));
  const reason = result.controlResults[0].reasons.join(' ');
  assert.equal(result.status, 'blocked');
  assert.match(reason, /spec hash/);
  assert.match(reason, /commit SHA/);
  assert.match(reason, /artifact digest/);
  assert.match(reason, /deployment id/);
  assert.match(reason, /lineage/);
});

test('rejects insufficient trust, resolver-assigned independent depth, and stale/freshness evidence', () => {
  const independent = control();
  const independentGroup = group(independent);
  independentGroup.evidenceRequirements[0].evidenceDepth = 'independent-verification';
  const independentInput = input(independent, [evidence({ trustLevel: 'provider_verified', details: { evidenceDepth: 'demonstrated' } })]);
  independentInput.compilation = { phaseGroups: [independentGroup] };
  let result = evaluateGate(independentInput);
  assert.match(result.controlResults[0].reasons.join(' '), /independent verification is required/);
  assert.doesNotMatch(result.controlResults[0].reasons.join(' '), /trust level/);

  const lowTrustInput = input(independent, [evidence({ trustLevel: 'agent_proposed' })]);
  result = evaluateGate(lowTrustInput);
  assert.match(result.controlResults[0].reasons.join(' '), /trust level/);

  result = evaluateGate(input(control(), [evidence({ observedAt: '2026-01-01T00:05:00.000Z' })]));
  assert.match(result.controlResults[0].reasons.join(' '), /stale relative to subject mutation/);

  const freshInput = input(control(), [evidence({ observedAt: '2026-01-01T00:11:00.000Z' })]);
  freshInput.evaluatedAt = '2026-01-01T02:00:00.000Z';
  result = evaluateGate(freshInput);
  assert.match(result.controlResults[0].reasons.join(' '), /exceeds freshness requirement/);
});

test('accepts only an allowed, evidence-backed not-applicable determination', () => {
  const item = control();
  const na = evidence({
    classification: 'completion', status: 'skipped_with_rationale', rationale: null,
    details: {
      controlId: item.controlId, disposition: 'not-applicable', evidenceDepth: 'demonstrated',
      reason: 'No runtime dependency is present.',
    },
  });
  const denied = evaluateGate(input(item, [na]));
  assert.equal(denied.status, 'blocked');
  assert.match(denied.controlResults[0].reasons[0], /not allowed/);

  const allowedInput = input(item, [na]);
  allowedInput.policies = { [item.controlId]: { allowedNotApplicable: true } };
  const allowed = evaluateGate(allowedInput);
  assert.equal(allowed.status, 'pass');
  assert.equal(allowed.controlResults[0].status, 'not-applicable');

  const staleInput = input(item, [evidence({
    ...na,
    observedAt: '2026-01-01T00:05:00.000Z',
    details: { ...na.details, reason: undefined },
  })]);
  staleInput.policies = { [item.controlId]: { allowedNotApplicable: true } };
  const stale = evaluateGate(staleInput);
  assert.equal(stale.status, 'blocked');
  assert.match(stale.controlResults[0].reasons.join(' '), /Not-applicable evidence.*rationale is absent.*stale relative to subject mutation/);
});

test('accepts a current authorized exception but names disallowed authority and expired expiry', () => {
  const item = control();
  const exception = evidence({
    classification: 'approval', actor: null, rationale: null,
    details: {
      controlId: item.controlId, disposition: 'exception', exceptionAuthority: 'release-board',
      expiresAt: '2026-01-03T00:00:00.000Z', evidenceDepth: 'demonstrated',
      rationale: 'Temporary approved risk acceptance.',
    },
  });
  const invalidEarlierException = evidence({
    ...exception, source: { ...exception.source, eventId: 'expired-event' }, payloadHash: 'sha256:expired',
    details: { ...exception.details, expiresAt: '2026-01-01T00:25:00.000Z' },
  });
  let result = evaluateGate(input(item, [invalidEarlierException, exception]));
  assert.equal(result.status, 'pass');
  assert.equal(result.controlResults[0].status, 'exception');
  assert.deepEqual(result.controlResults[0].demonstratedEvidence, ['rorca-host:event-1:sha256:payload']);

  const disallowed = control();
  disallowed.exceptionPolicy = { allowed: false, approvalRequired: false, justificationRequired: false };
  result = evaluateGate(input(disallowed, [exception]));
  assert.match(result.controlResults[0].reasons[0], /release-board.*disallowed/);

  const expired = evidence({ ...exception, details: { ...exception.details, expiresAt: '2026-01-01T00:25:00.000Z' } });
  result = evaluateGate(input(item, [expired]));
  assert.match(result.controlResults[0].reasons[0], /release-board.*expired expiry/);
});

test('evaluates missing maintenance outcomes for traceability without blocking the completed release', () => {
  const maintenance = control('maintenance');
  const result = evaluateGate(input(maintenance, []));
  assert.equal(result.controlResults[0].status, 'blocked');
  assert.equal(result.controlResults[0].blocking, false);
  assert.equal(result.status, 'pass');
  assert.equal(result.stageProjection.status, 'non-blocking');
  assert.deepEqual(result.unresolvedControlIds, [maintenance.controlId]);
});
