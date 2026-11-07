/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import controlsArtifact from '../catalog/controls.json';
import { compileAssuranceProfile, getCanonicalControl } from '../assurance-profile';
import { declareHermesAuthority } from '../../lib/hermes-authority';
import type { CanonicalLifecycleEvidence } from '../../lib/ssdlc-evidence';
import type { StageReadiness } from '../gates/gate-compiler';
import { parseControl } from '../schema/control-schema';
import { createHermesAssuranceAdapter } from '../hermes-assurance-adapter';

const NOW = new Date('2026-03-16T00:06:29.000Z');
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const hash = (character: string): string => `sha256:${character.repeat(64)}`;
const controls = controlsArtifact.map((control) => parseControl(control));
const traceability = getCanonicalControl('CTRL-REQUIREMENTS-TRACEABILITY')!;

function profile() {
  return compileAssuranceProfile({
    profileId: 'profile:payment-api:17',
    specRef: {
      schemaVersion: 'rorca.entity-ref.v1', workspaceId: 'workspace-1', kind: 'spec', id: 'payment-api',
      label: 'Payment API', revision: { kind: 'spec_version', value: '17' },
    },
    specRevision: { kind: 'spec_version', value: '17' },
    repositoryContextHash: hash('a'),
    riskProfile: { level: 'high', tags: ['payments'], rationale: 'Payment integrity is material.' },
    controlInstances: [{
      controlId: traceability.controlId,
      mechanismBindings: [
        { mechanismId: 'mechanism:tests', kind: 'command', locator: 'npm run test:payments' },
        { mechanismId: 'mechanism:manifest', kind: 'repository-path', locator: 'release/manifest.json' },
      ],
      criteria: [{ criterionId: 'exit-zero', description: 'The mechanism exits successfully.', evaluator: 'exit-code', expected: '0' }],
      evidenceRequirements: structuredClone(traceability.requiredEvidence),
    }],
  });
}

const scope = {
  workspaceId: 'workspace-1', specSlug: 'payment-api', runId: 17, storyId: 'AAV-006', phaseId: 'requirements', gateId: 'plan',
};
const identity = {
  specHash: hash('b'), commitSha: COMMIT,
  releaseIdentity: { artifactDigest: hash('c'), deploymentId: 'deployment-17' },
};
const auditAuthority = () => declareHermesAuthority('subscription', 'service-audit');
const persistAuthority = () => declareHermesAuthority('persist', 'operator-dispatch');
const dispatchAuthority = () => declareHermesAuthority('dispatch', 'operator-dispatch');

function input() {
  return {
    profile: profile(), identity, scope, actor: 'hermes:assurance-service',
    auditAuthority: auditAuthority(), persistenceAuthority: persistAuthority(), reevaluationAuthority: dispatchAuthority(),
  };
}

test('executes every compiled mechanism and emits one matching canonical record with exact identity', async () => {
  const calls: string[] = [];
  const persisted: CanonicalLifecycleEvidence[] = [];
  let reevaluation: Parameters<ReturnType<typeof createHermesAssuranceAdapter>['execute']>[0] | undefined;
  const adapter = createHermesAssuranceAdapter({
    async runMechanism(binding) {
      calls.push(binding.mechanismId);
      return { summary: `${binding.mechanismId} passed`, exitCode: 0, rawReference: `hermes:${binding.mechanismId}` };
    },
    async persistEvidence(evidence, authority) {
      assert.equal(authority.authorityMode, 'operator-dispatch');
      persisted.push(evidence);
    },
    async requestStageReevaluation(request, authority) {
      assert.equal(authority.action, 'dispatch');
      reevaluation = request as unknown as typeof reevaluation;
    },
  }, { now: () => NOW });

  const result = await adapter.execute(input());
  assert.deepEqual(calls, ['mechanism:tests', 'mechanism:manifest']);
  assert.equal(result.evidence.length, 2);
  assert.deepEqual(persisted, result.evidence);
  assert.ok(reevaluation, 'US-005 reevaluation must be requested after persistence');
  for (const [index, evidence] of result.evidence.entries()) {
    const binding = profile().controlInstances[0].mechanismBindings[index];
    assert.equal(evidence.schemaVersion, 'rorca.lifecycle-evidence.v1');
    assert.equal(evidence.details.controlId, traceability.controlId);
    assert.equal(evidence.details.mechanismIdentity, binding.mechanismId);
    assert.equal(evidence.details.mechanismKind, binding.kind);
    assert.equal(evidence.details.mechanismLocator, binding.locator);
    assert.equal(evidence.details.specRevision, 'spec_version:17');
    assert.equal(evidence.subject.value, identity.specHash);
    assert.deepEqual(evidence.releaseIdentity, { commitSha: COMMIT, ...identity.releaseIdentity });
    assert.equal(evidence.status, 'passed');
    assert.equal('mechanismOutcome' in evidence.details, false, 'unbounded kernel output is not copied');
  }
});

test('uses a distinct immutable source event when the exact commit or release identity changes', async () => {
  const adapter = createHermesAssuranceAdapter({
    async runMechanism(binding) { return { summary: `${binding.mechanismId} passed`, exitCode: 0 }; },
    async persistEvidence() {},
    async requestStageReevaluation() {},
  }, { now: () => NOW });

  const first = await adapter.execute(input());
  const nextCommit = '1123456789abcdef0123456789abcdef01234567';
  const second = await adapter.execute({
    ...input(),
    identity: {
      ...identity,
      commitSha: nextCommit,
      releaseIdentity: { ...identity.releaseIdentity, deploymentId: 'deployment-18' },
    },
  });

  assert.notEqual(first.evidence[0].source.eventId, second.evidence[0].source.eventId);
  assert.equal(second.evidence[0].details.commitSha, nextCommit);
  assert.deepEqual(second.evidence[0].releaseIdentity, {
    commitSha: nextCommit,
    artifactDigest: identity.releaseIdentity.artifactDigest,
    deploymentId: 'deployment-18',
  });
});

test('evaluates compiled criteria deterministically without exposing raw mechanism output', async () => {
  const adapter = createHermesAssuranceAdapter({
    async runMechanism(binding) {
      return { summary: `${binding.mechanismId} returned a nonzero status`, exitCode: 2 };
    },
    async persistEvidence() {},
    async requestStageReevaluation() {},
  }, { now: () => NOW });

  const result = await adapter.execute(input());
  assert.equal(result.evidence.length, 2);
  assert.ok(result.evidence.every(({ status }) => status === 'story_caused_failure'));
  assert.ok(result.evidence.every(({ details }) => String(details.actionableGap).includes('exit-zero expected "0", observed "2"')));
  assert.ok(result.evidence.every(({ details }) => !('mechanismOutcome' in details)));
});

test('turns execution failure into actionable blocked evidence and reevaluates US-005', async () => {
  let reevaluated: { blockedControlIds: readonly string[]; evidence: readonly CanonicalLifecycleEvidence[] } | undefined;
  const adapter = createHermesAssuranceAdapter({
    async runMechanism(binding) {
      if (binding.mechanismId === 'mechanism:tests') throw new Error('provider details stay internal');
      return { summary: 'manifest available', exitCode: 0 };
    },
    async persistEvidence() {},
    async requestStageReevaluation(request) { reevaluated = request; },
  }, { now: () => NOW });

  const result = await adapter.execute(input());
  assert.deepEqual(result.blockedControlIds, [traceability.controlId]);
  const blocked = result.evidence.find(({ status }) => status === 'environment_credential_blocker');
  assert.ok(blocked);
  assert.match(String(blocked.details.actionableGap), /^Restore the verification mechanism and retry execution/);
  assert.deepEqual(reevaluated?.blockedControlIds, [traceability.controlId]);
  assert.equal(reevaluated?.evidence.length, 2, 'new pass and blocked evidence are reevaluated together');
});

test('validates AAV-012 through AAV-018 exclusively as StructuredFinding', () => {
  const control = controls.find(({ controlId }) => controlId === traceability.controlId)!;
  const readiness: StageReadiness[] = [{
    stage: 'requirements', phases: ['requirements'], controlIds: [control.controlId], unresolvedControlIds: [],
    approvalControlIds: [], blocking: false, status: 'ready',
  }];
  const adapter = createHermesAssuranceAdapter({
    async runMechanism() { return { summary: 'unused' }; },
    async persistEvidence() {},
    async requestStageReevaluation() {},
  });
  const common = { controls, activeControlIds: [control.controlId], compilation: { readiness }, auditAuthority: auditAuthority() };
  const finding = {
    findingId: 'finding:AAV-012:1', controlId: control.controlId, skillId: control.skillRefs[0], storyId: 'US-006',
    status: 'blocker', evidenceRefs: ['evidence:1'], message: 'Restore requirement-to-test traceability.',
  };

  for (const agentStoryId of ['AAV-012', 'AAV-013', 'AAV-014', 'AAV-015', 'AAV-016', 'AAV-017', 'AAV-018']) {
    const attributed = { ...finding, findingId: `finding:${agentStoryId}:1` };
    const result = adapter.ingestPhaseReview({ ...common, agentStoryId, findings: [attributed] });
    assert.equal(result.gateVerdict, 'blocked');
    assert.deepEqual(result.findings[0], attributed);
  }
  assert.throws(() => adapter.ingestPhaseReview({
    ...common, agentStoryId: 'AAV-012', findings: [{ ...finding, findingId: 'finding:legacy', verdict: 'fail' }],
  }), /unrecognized key/i);
  assert.throws(() => adapter.ingestPhaseReview({
    ...common, agentStoryId: 'AAV-012', findings: [{ ...finding, findingId: 'finding:wrong-story', storyId: 'AAV-012' }],
  }), /attributed to US-006/);
  const { storyId: _storyId, ...unattributed } = finding;
  assert.throws(() => adapter.ingestPhaseReview({
    ...common, agentStoryId: 'AAV-012', findings: [{ ...unattributed, findingId: 'finding:unattributed' }],
  }), /attributed to US-006/);
  assert.throws(() => adapter.ingestPhaseReview({
    ...common, agentStoryId: 'AAV-019', findings: [{ ...finding, findingId: 'finding:out-of-range' }],
  }), /AAV-012 through AAV-018/);
  assert.throws(() => adapter.ingestPhaseReview({
    ...common, agentStoryId: 'AAV-012', findings: [{ ...finding, findingId: 'finding:elevated' }],
    auditAuthority: persistAuthority(),
  }), /does not permit this action/);
});

test('rejects accidental authority fallback before executing a mechanism', async () => {
  let calls = 0;
  const adapter = createHermesAssuranceAdapter({
    async runMechanism() { calls += 1; return { summary: 'must not execute', exitCode: 0 }; },
    async persistEvidence() {},
    async requestStageReevaluation() {},
  });
  await assert.rejects(adapter.execute({ ...input(), auditAuthority: persistAuthority() }), /does not permit this action/);
  await assert.rejects(adapter.execute({ ...input(), persistenceAuthority: dispatchAuthority() }), /does not permit this action/);
  await assert.rejects(adapter.execute({ ...input(), reevaluationAuthority: persistAuthority() }), /does not permit this action/);
  assert.equal(calls, 0);
});
