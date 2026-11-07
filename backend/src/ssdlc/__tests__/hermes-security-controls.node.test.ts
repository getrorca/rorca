/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { BoundedCommandCapture } from '../evidence-artifact-adapters';
import { createHermesSecurityControls, HERMES_SECURITY_CONTROLS } from '../hermes-security-controls';

const NOW = new Date('2026-03-16T00:06:29.000Z');
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const scope = {
  workspaceId: 'workspace-1', specSlug: 'payment-api', runId: 15,
  storyId: 'AAV-015', phaseId: 'testing', gateId: 'implementation',
};
const mechanisms = {
  secrets: { mechanismId: 'gitleaks:v8', executable: 'gitleaks', args: ['detect', '--report-format=json'], cwd: '/workspace' },
  dependencies: { mechanismId: 'npm-audit:v10', executable: 'npm', args: ['audit', '--json'], cwd: '/workspace' },
  threats: { mechanismId: 'threat-check:v1', executable: 'node', args: ['scripts/verify-threats.js'], cwd: '/workspace' },
};

function capture(executable: string, exitCode = 0, stdout = '{"findings":[]}'): BoundedCommandCapture {
  return {
    executable, args: [], exitCode, outputDigest: `sha256:${'a'.repeat(64)}`, stdout, stderr: '',
    truncation: [
      { field: 'stdout', truncated: false, capturedBytes: Buffer.byteLength(stdout), omittedBytes: 0, originalBytes: Buffer.byteLength(stdout) },
      { field: 'stderr', truncated: false, capturedBytes: 0, omittedBytes: 0, originalBytes: 0 },
    ],
  };
}

function input() {
  return {
    scope, specRevision: { kind: 'spec_version' as const, value: '15' }, commitSha: COMMIT,
    actor: 'hermes:security-reviewer', mechanisms,
  };
}

test('runs secrets, dependency, and threat controls and emits artifact-backed security evidence', async () => {
  const calls: string[] = [];
  let emitted: readonly unknown[] | undefined;
  const controls = createHermesSecurityControls({
    async resolveCommitSha() { return COMMIT; },
    async executeCommand(mechanism) {
      calls.push(mechanism.executable);
      return capture(mechanism.executable);
    },
    async emitSecurityEvidence(evidence) { emitted = evidence; },
  }, { now: () => NOW });

  const result = await controls.execute(input());

  assert.deepEqual(calls, ['gitleaks', 'npm', 'node']);
  assert.equal(emitted, result.evidence, 'the returned records are the exact emitted evidence batch');
  assert.equal(result.decision, 'passed');
  assert.equal(result.evidence.length, 3);
  assert.deepEqual(result.gaps, []);
  assert.deepEqual(result.evidence.map((item) => item.details.controlId), [
    HERMES_SECURITY_CONTROLS.secrets.controlId,
    HERMES_SECURITY_CONTROLS.dependencies.controlId,
    HERMES_SECURITY_CONTROLS.threats.controlId,
  ]);
  for (const evidence of result.evidence) {
    assert.equal(evidence.scope.phaseId, 'security');
    assert.equal(evidence.status, 'passed');
    assert.equal(evidence.subject.type, 'commit_sha');
    assert.equal(evidence.subject.value, COMMIT);
    assert.equal(evidence.releaseIdentity?.commitSha, COMMIT);
    assert.match(String(evidence.details.mechanismIdentity), /^hermes-security:(secrets|dependencies|threats):sha256:[0-9a-f]{64}$/);
    assert.match(String(evidence.details.artifactOutputDigest), /^sha256:[0-9a-f]{64}$/);
    assert.match(evidence.rawReference ?? '', /^security-artifact:sha256:[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(evidence).includes('findings'), false, 'scanner output is represented by a digest, not copied');
  }
});

test('judges nonzero real scan output as a failed control with a remediation gap', async () => {
  const controls = createHermesSecurityControls({
    async resolveCommitSha() { return COMMIT; },
    async executeCommand(mechanism) {
      return capture(mechanism.executable, mechanism.executable === 'gitleaks' ? 1 : 0, 'finding output');
    },
    async emitSecurityEvidence() {},
  }, { now: () => NOW });

  const result = await controls.execute(input());

  assert.equal(result.decision, 'failed');
  assert.equal(result.gaps.length, 1);
  assert.equal(result.gaps[0].controlId, HERMES_SECURITY_CONTROLS.secrets.controlId);
  assert.match(result.gaps[0].action, /Remediate the secrets scan findings/);
  assert.equal(result.evidence[0].status, 'story_caused_failure');
  assert.equal(result.evidence[0].details.exitCode, 1);
});

test('emits blocked evidence and actionable gaps when a security mechanism cannot execute', async () => {
  let emitted: readonly unknown[] | undefined;
  const controls = createHermesSecurityControls({
    async resolveCommitSha() { return COMMIT; },
    async executeCommand(mechanism) {
      if (mechanism.executable === 'npm') throw new Error('ENOENT details remain internal');
      return capture(mechanism.executable);
    },
    async emitSecurityEvidence(evidence) { emitted = evidence; },
  }, { now: () => NOW });

  const result = await controls.execute(input());
  assert.equal(emitted, result.evidence);

  assert.equal(result.decision, 'blocked');
  assert.equal(result.gaps.length, 1);
  assert.equal(result.gaps[0].status, 'blocked');
  assert.equal(result.gaps[0].controlId, HERMES_SECURITY_CONTROLS.dependencies.controlId);
  assert.match(result.gaps[0].action, /Restore the dependency check mechanism npm-audit:v10/);
  const blocked = result.evidence.find((item) => item.status === 'environment_credential_blocker');
  assert.ok(blocked);
  assert.equal(blocked.details.mechanismIdentity, result.gaps[0].mechanismIdentity);
  assert.equal(blocked.rawReference, null);
});

test('binds stale repository identity as blocked evidence instead of accepting scan success', async () => {
  const staleCommit = 'f'.repeat(40);
  const controls = createHermesSecurityControls({
    async resolveCommitSha() { return staleCommit; },
    async executeCommand(mechanism) { return capture(mechanism.executable); },
    async emitSecurityEvidence() {},
  }, { now: () => NOW });

  const result = await controls.execute(input());

  assert.equal(result.decision, 'blocked');
  assert.equal(result.gaps.length, 3);
  assert.ok(result.gaps.every((gap) => gap.action.includes(`commitSha expected ${COMMIT}, observed ${staleCommit}`)));
  assert.ok(result.evidence.every((item) => item.status === 'environment_credential_blocker'));
  assert.ok(result.evidence.every((item) => item.subject.value === COMMIT));
});

test('blocks successful scanner output when the checkout changes during execution', async () => {
  const changedCommit = 'e'.repeat(40);
  let observation = 0;
  const controls = createHermesSecurityControls({
    async resolveCommitSha() {
      observation += 1;
      return observation % 2 === 1 ? COMMIT : changedCommit;
    },
    async executeCommand(mechanism) { return capture(mechanism.executable); },
    async emitSecurityEvidence() {},
  }, { now: () => NOW });

  const result = await controls.execute(input());

  assert.equal(observation, 6, 'each control observes the commit before and after execution');
  assert.equal(result.decision, 'blocked');
  assert.equal(result.gaps.length, 3);
  assert.ok(result.gaps.every((gap) => gap.action.includes(`commitSha expected ${COMMIT}, observed ${changedCommit}`)));
  assert.ok(result.evidence.every((item) => item.status === 'environment_credential_blocker'));
  assert.ok(result.evidence.every((item) => item.rawReference?.startsWith('security-artifact:sha256:')));
});

test('gives identical scanner output on a different commit distinct evidence identities', async () => {
  let observedCommit = COMMIT;
  const controls = createHermesSecurityControls({
    async resolveCommitSha() { return observedCommit; },
    async executeCommand(mechanism) { return capture(mechanism.executable); },
    async emitSecurityEvidence() {},
  }, { now: () => NOW });

  const first = await controls.execute(input());
  observedCommit = 'b'.repeat(40);
  const second = await controls.execute({ ...input(), commitSha: observedCommit });

  assert.equal(first.evidence.length, 3);
  assert.ok(first.evidence.every((item, index) => item.source.eventId !== second.evidence[index].source.eventId));
  assert.ok(second.evidence.every((item) => item.subject.value === observedCommit));
});

test('fails closed when security evidence cannot be emitted', async () => {
  const controls = createHermesSecurityControls({
    async resolveCommitSha() { return COMMIT; },
    async executeCommand(mechanism) { return capture(mechanism.executable); },
    async emitSecurityEvidence() { throw new Error('evidence store unavailable'); },
  }, { now: () => NOW });

  await assert.rejects(controls.execute(input()), /evidence store unavailable/);
});

test('snapshots the contracted commit and mechanism identity before asynchronous execution', async () => {
  const mutableInput = structuredClone(input());
  const calls: string[] = [];
  const controls = createHermesSecurityControls({
    async resolveCommitSha() { return COMMIT; },
    async executeCommand(mechanism) {
      calls.push(mechanism.executable);
      mutableInput.commitSha = 'd'.repeat(40);
      mutableInput.mechanisms.dependencies.executable = 'substituted-auditor';
      mutableInput.mechanisms.dependencies.mechanismId = 'substituted:v1';
      return capture(mechanism.executable);
    },
    async emitSecurityEvidence() {},
  }, { now: () => NOW });

  const result = await controls.execute(mutableInput);

  assert.deepEqual(calls, ['gitleaks', 'npm', 'node']);
  assert.equal(result.decision, 'passed');
  assert.ok(result.evidence.every((item) => item.subject.value === COMMIT));
  assert.equal(result.evidence[1].details.mechanismId, 'npm-audit:v10');
  assert.match(String(result.evidence[1].details.mechanismIdentity), /^hermes-security:dependencies:sha256:[0-9a-f]{64}$/);
});
