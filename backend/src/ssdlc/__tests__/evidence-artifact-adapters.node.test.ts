/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CANONICAL_ADAPTER_MAPPINGS,
  executeBounded,
  mapAdapterOutcomeToCanonicalEvidence,
  runArtifactDigestAdapter,
  runDeploymentReceiptAdapter,
  runTestResultAdapter,
  type ExecutableMechanism,
} from '../evidence-artifact-adapters';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const ARTIFACT = `sha256:${'a'.repeat(64)}`;
const scope = {
  workspaceId: 'workspace-1', specSlug: 'delivery-api', runId: 19, storyId: 'AAV-019', phaseId: 'delivery', gateId: 'release',
};
const nodeCommand = (cwd: string, source: string, exitCode = 0): ExecutableMechanism => ({
  executable: process.execPath,
  args: ['-e', `${source};process.exit(${exitCode})`],
  cwd,
});

function jestOutput(): string {
  return JSON.stringify({
    numTotalTests: 2,
    numPassedTests: 2,
    numFailedTests: 0,
    numPendingTests: 0,
    testResults: [{ assertionResults: [
      { fullName: '[REQ-AAV-019-TEST] parses real Jest output' },
      { fullName: '[REQ-AAV-019-MAP] maps lifecycle evidence' },
    ] }],
  });
}

test('runs an executable+args vector and parses real Jest JSON into an AAV-002 outcome', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'rorca-test-result-'));
  try {
    const outcome = await runTestResultAdapter({
      mechanism: nodeCommand(cwd, `process.stdout.write(${JSON.stringify(jestOutput())})`),
      requiredRequirementIds: ['REQ-AAV-019-TEST', 'REQ-AAV-019-MAP'],
    });
    assert.equal(outcome.adapter, 'test_result');
    assert.deepEqual(outcome.testSummary, { framework: 'jest', total: 2, passed: 2, failed: 0, skipped: 0 });
    assert.deepEqual(outcome.requirementCoverage.missing, []);
    assert.equal(outcome.command.executable, process.execPath);
    assert.deepEqual(outcome.command.args.slice(0, 1), ['-e']);
    assert.equal(outcome.passed, true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('recognizes a real-format Vitest JSON vector and counts pending plus todo tests', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'rorca-vitest-result-'));
  try {
    const output = JSON.stringify({
      numTotalTests: 4, numPassedTests: 2, numFailedTests: 0, numPendingTests: 1, numTodoTests: 1,
      testResults: [{ assertionResults: [{ fullName: '[REQ-VITEST] runs' }] }],
    });
    const runner = path.join(cwd, 'vitest-runner.js');
    await writeFile(runner, `process.stdout.write(${JSON.stringify(output)})`);
    const outcome = await runTestResultAdapter({
      mechanism: { executable: process.execPath, args: [runner], cwd },
      requiredRequirementIds: ['REQ-VITEST'],
    });
    assert.deepEqual(outcome.testSummary, { framework: 'vitest', total: 4, passed: 2, failed: 0, skipped: 2 });
    assert.equal(outcome.passed, true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('returns a deterministic failed test outcome for nonzero real command execution', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'rorca-test-failure-'));
  try {
    const failedJson = JSON.stringify({
      numTotalTests: 1, numPassedTests: 0, numFailedTests: 1, numPendingTests: 0,
      testResults: [{ assertionResults: [{ fullName: '[REQ-FAIL] fails' }] }],
    });
    const outcome = await runTestResultAdapter({ mechanism: nodeCommand(cwd, `process.stdout.write(${JSON.stringify(failedJson)})`, 2) });
    assert.equal(outcome.command.exitCode, 2);
    assert.equal(outcome.testSummary.failed, 1);
    assert.equal(outcome.passed, false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('captures explicit byte-level truncation records without terminating the command early', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'rorca-truncation-'));
  try {
    const capture = await executeBounded(nodeCommand(cwd, "process.stdout.write('x'.repeat(100));process.stderr.write('y'.repeat(70))"), 16);
    assert.equal(capture.stdout, 'x'.repeat(16));
    assert.deepEqual(capture.truncation, [
      { field: 'stdout', truncated: true, capturedBytes: 16, omittedBytes: 84, originalBytes: 100 },
      { field: 'stderr', truncated: true, capturedBytes: 16, omittedBytes: 54, originalBytes: 70 },
    ]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('digests build outputs deterministically and records bounded manifest truncation', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'rorca-artifacts-'));
  try {
    const source = "require('node:fs').mkdirSync('dist');require('node:fs').writeFileSync('dist/a.js','a');require('node:fs').writeFileSync('dist/b.js','b')";
    const outcome = await runArtifactDigestAdapter({
      mechanism: nodeCommand(cwd, source), outputPaths: ['dist'], maximumManifestFiles: 1,
    });
    assert.match(outcome.artifactDigest ?? '', /^sha256:[0-9a-f]{64}$/);
    assert.equal(outcome.passed, true);
    assert.equal(outcome.files.length, 1);
    assert.deepEqual(outcome.manifestTruncation, {
      field: 'artifactManifest', truncated: true, capturedBytes: 1, omittedBytes: 1, originalBytes: 2,
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('returns a bounded failed artifact outcome when a build does not produce configured output', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'rorca-artifact-failure-'));
  try {
    const outcome = await runArtifactDigestAdapter({
      mechanism: nodeCommand(cwd, "process.stderr.write('build failed')", 2),
      outputPaths: ['dist/missing.js'],
      maximumCaptureBytes: 5,
    });
    assert.equal(outcome.passed, false);
    assert.equal(outcome.artifactDigest, null);
    assert.deepEqual(outcome.missingOutputPaths, ['dist/missing.js']);
    assert.deepEqual(outcome.command.truncation[1], {
      field: 'stderr', truncated: true, capturedBytes: 5, omittedBytes: 7, originalBytes: 12,
    });

    const partial = await runArtifactDigestAdapter({
      mechanism: nodeCommand(cwd, "require('node:fs').writeFileSync('present.js','present')"),
      outputPaths: ['present.js', 'missing.js'],
    });
    assert.match(partial.artifactDigest ?? '', /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(partial.missingOutputPaths, ['missing.js']);
    assert.equal(partial.passed, false, 'every configured build output is required');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('maps all adapters to declared canonical lifecycle classifications and required identities', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'rorca-mappings-'));
  try {
    const testOutcome = await runTestResultAdapter({ mechanism: nodeCommand(cwd, `process.stdout.write(${JSON.stringify(jestOutput())})`) });
    const testEvidence = mapAdapterOutcomeToCanonicalEvidence({
      outcome: testOutcome, scope, observedAt: '2026-03-16T00:06:29.000Z', sourceSystem: 'ci:local',
      releaseIdentity: { commitSha: COMMIT, artifactDigest: null, deploymentId: null },
    });
    assert.equal(testEvidence.source.type, 'wal_validation');
    assert.equal(testEvidence.classification, 'validation');
    assert.deepEqual(testEvidence.subject, { type: 'commit_sha', value: COMMIT });

    const artifactOutcome = await runArtifactDigestAdapter({
      mechanism: nodeCommand(cwd, "require('node:fs').writeFileSync('bundle.js','bundle')"), outputPaths: ['bundle.js'],
    });
    const artifactEvidence = mapAdapterOutcomeToCanonicalEvidence({
      outcome: artifactOutcome, scope, observedAt: '2026-03-16T00:06:29.000Z', sourceSystem: 'builder:local',
      releaseIdentity: { commitSha: COMMIT, artifactDigest: artifactOutcome.artifactDigest, deploymentId: null },
    });
    assert.equal(artifactEvidence.source.type, 'staging_result');
    assert.equal(artifactEvidence.classification, 'staging');
    assert.equal(artifactEvidence.subject.type, 'artifact_digest');
    assert.equal(artifactEvidence.lineageVerified, true);

    const receiptJson = JSON.stringify({ deploymentId: 'deploy-19', commitSha: COMMIT, artifactDigest: ARTIFACT, environment: 'production' });
    const receiptOutcome = await runDeploymentReceiptAdapter({
      mechanism: nodeCommand(cwd, `process.stdout.write(${JSON.stringify(receiptJson)})`),
      expected: { deploymentId: 'deploy-19', commitSha: COMMIT, artifactDigest: ARTIFACT },
    });
    const deploymentEvidence = mapAdapterOutcomeToCanonicalEvidence({
      outcome: receiptOutcome, scope, observedAt: '2026-03-16T00:06:29.000Z', sourceSystem: 'deployer:local',
      releaseIdentity: { commitSha: COMMIT, artifactDigest: ARTIFACT, deploymentId: 'deploy-19' },
    });
    assert.equal(deploymentEvidence.source.type, 'deployment_proof');
    assert.equal(deploymentEvidence.classification, 'deployment');
    assert.deepEqual(deploymentEvidence.subject, { type: 'deployment_id', value: 'deploy-19' });
    assert.equal(deploymentEvidence.lineageVerified, true);

    assert.deepEqual(CANONICAL_ADAPTER_MAPPINGS.deployment_receipt.requiredReleaseBindings, ['commitSha', 'artifactDigest', 'deploymentId']);
    assert.throws(() => mapAdapterOutcomeToCanonicalEvidence({
      outcome: receiptOutcome, scope, observedAt: '2026-03-16T00:06:29.000Z', sourceSystem: 'deployer:local',
      releaseIdentity: { commitSha: COMMIT, artifactDigest: null, deploymentId: 'deploy-19' },
    }), /requires releaseIdentity.artifactDigest/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('maps bounded adapter failures against required release subjects without elevating claims', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'rorca-receipt-failure-'));
  try {
    const receiptOutcome = await runDeploymentReceiptAdapter({
      mechanism: nodeCommand(cwd, "process.stdout.write('{not-json')"),
      expected: { commitSha: COMMIT, artifactDigest: ARTIFACT },
    });
    assert.equal(receiptOutcome.passed, false);
    assert.equal(receiptOutcome.deploymentId, null);
    const receiptEvidence = mapAdapterOutcomeToCanonicalEvidence({
      outcome: receiptOutcome, scope, observedAt: '2026-03-16T00:06:29.000Z', sourceSystem: 'deployer:local',
      releaseIdentity: { commitSha: COMMIT, artifactDigest: ARTIFACT, deploymentId: 'deploy-target' },
    });
    assert.equal(receiptEvidence.status, 'story_caused_failure');
    assert.deepEqual(receiptEvidence.subject, { type: 'deployment_id', value: 'deploy-target' });

    const artifactOutcome = await runArtifactDigestAdapter({
      mechanism: nodeCommand(cwd, '', 1), outputPaths: ['missing.js'],
    });
    const artifactEvidence = mapAdapterOutcomeToCanonicalEvidence({
      outcome: artifactOutcome, scope, observedAt: '2026-03-16T00:06:29.000Z', sourceSystem: 'builder:local',
      releaseIdentity: { commitSha: COMMIT, artifactDigest: ARTIFACT, deploymentId: null },
    });
    assert.equal(artifactEvidence.status, 'story_caused_failure');
    assert.deepEqual(artifactEvidence.subject, { type: 'artifact_digest', value: ARTIFACT });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
