/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import { once } from 'node:events';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  captureGitWorktreeSnapshot,
  canonicalGitPathManifest,
  runGitWaveCanary,
  verifyPersistedGitWaveCanaryArtifacts,
} from '../wave-git-canary';
import {
  buildQualificationReport,
  loadCanonicalQualificationAssertionIds,
  type QualificationEvidenceAssertion,
} from '../wave-qualification-evidence';

const signingKey = 'focused-test-only-wave-canary-signing-key-0123456789';
const gitEnvironment = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Rorca Canary Test',
  GIT_AUTHOR_EMAIL: 'canary-test@rorca.invalid',
  GIT_COMMITTER_NAME: 'Rorca Canary Test',
  GIT_COMMITTER_EMAIL: 'canary-test@rorca.invalid',
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: gitEnvironment,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createDirtySourceRepository(root: string): { repository: string; baseHead: string } {
  const repository = path.join(root, 'source');
  fs.mkdirSync(repository);
  git(repository, ['init', '--initial-branch=main']);
  fs.writeFileSync(path.join(repository, '.gitignore'), 'ignored/\n');
  fs.writeFileSync(path.join(repository, 'tracked.txt'), 'committed\n');
  git(repository, ['add', '.gitignore', 'tracked.txt']);
  git(repository, ['commit', '-m', 'test: source base']);
  const baseHead = git(repository, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(repository, 'tracked.txt'), 'dirty tracked content\n');
  fs.writeFileSync(path.join(repository, 'untracked.txt'), 'dirty untracked content\n');
  fs.mkdirSync(path.join(repository, 'ignored'));
  fs.writeFileSync(path.join(repository, 'ignored', 'generated.txt'), 'ignored content\n');
  fs.mkdirSync(path.join(repository, '.rorca', 'qualification'), { recursive: true });
  fs.writeFileSync(path.join(repository, '.rorca', 'qualification', 'prior-evidence.json'), 'generated evidence\n');
  return { repository, baseHead };
}

test('real isolated Git wave canary measures four stories at parallelism two and verifies durable evidence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-wave-canary-test-'));
  const artifactDirectory = path.join(root, 'qualification');
  try {
    const { repository, baseHead } = createDirtySourceRepository(root);
    const expectedSnapshot = captureGitWorktreeSnapshot(repository);
    assert.equal(expectedSnapshot.baseHead, baseHead);
    assert.notEqual(expectedSnapshot.materialTree, expectedSnapshot.baseTree);
    const result = await runGitWaveCanary({
      repositoryRoot: repository,
      artifactDirectory,
      signingKey,
      issuer: 'focused-test-audit-issuer',
      workspaceId: 'workspace-focused-canary',
      attestedAt: '2026-08-18T12:00:00.000Z',
    });

    assert.equal(result.evidence.assertion.evidenceClass, 'canary_soak');
    assert.equal(result.evidence.assertion.authority, 'measured');
    assert.equal(result.evidence.assertion.durable, true);
    assert.equal(result.evidence.assertion.sourceRevision, baseHead);
    assert.equal(result.evidence.measurement.workspaceId, 'workspace-focused-canary');
    assert.equal(result.evidence.measurement.sourceRevision, baseHead);
    assert.equal(result.evidence.measurement.sourceTree, expectedSnapshot.baseTree);
    assert.equal(result.evidence.measurement.sourceMaterialRevision, expectedSnapshot.materialRevision);
    assert.equal(result.evidence.measurement.sourceMaterialTree, expectedSnapshot.materialTree);
    assert.equal(result.evidence.measurement.sourceInventoryDigest, expectedSnapshot.inventoryDigest);
    assert.ok(result.evidence.measurement.representedSourcePathCount >= 3);
    assert.deepEqual(result.evidence.measurement.integrationOrder, [
      'WPE-CANARY-A', 'WPE-CANARY-B', 'WPE-CANARY-C', 'WPE-CANARY-D',
    ]);
    assert.equal(result.evidence.measurement.storyCount, 4);
    assert.equal(result.evidence.measurement.effectiveParallelism, 2);
    assert.equal(result.evidence.measurement.maximumActiveStories, 2);
    assert.equal(result.evidence.measurement.mergeCommitCount, 4);
    assert.equal(result.evidence.measurement.integratedTransitionCount, 4);
    assert.equal(result.evidence.measurement.finalizationReceiptCount, 4);
    assert.equal(result.evidence.measurement.idempotentReplayCount, 4);
    assert.equal(result.evidence.measurement.replayAdditionalTransitionCount, 0);
    assert.equal(result.evidence.measurement.cleanTarget, true);
    assert.equal(result.evidence.measurement.remainingWorktreeCount, 1);
    assert.equal(result.evidence.measurement.remainingStoryRefCount, 0);
    assert.equal(result.evidence.measurement.temporaryRootRemoved, true);
    assert.equal(result.evidence.measurement.databaseExercised, false);
    assert.equal(result.evidence.measurement.queueExercised, false);
    assert.equal(result.evidence.measurement.productionEnableAvailable, false);
    assert.equal(fs.statSync(result.evidencePath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(result.receiptPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(artifactDirectory).mode & 0o777, 0o700);
    assert.equal(fs.readdirSync(artifactDirectory).length, 1);
    assert.ok(fs.readdirSync(artifactDirectory).every(entry => !entry.startsWith('.')));
    assert.equal(fs.statSync(path.dirname(result.evidencePath)).mode & 0o777, 0o700);

    const verified = verifyPersistedGitWaveCanaryArtifacts({
      evidencePath: result.evidencePath,
      receiptPath: result.receiptPath,
      signingKey,
      expectedSourceRevision: baseHead,
      expectedIssuer: 'focused-test-audit-issuer',
      expectedWorkspaceId: 'workspace-focused-canary',
    });
    assert.deepEqual(verified.evidence, result.evidence);
    assert.deepEqual(verified.receipt, result.receipt);
    assert.equal(result.evidence.assertion.sourceDigest, result.evidenceDigest);
    assert.equal(result.receipt.attestation.digest, result.evidenceDigest);
    assert.equal(result.receipt.attestation.workspaceId, 'workspace-focused-canary');
    assert.equal(result.receipt.attestation.sourceRevision, baseHead);
    const canonicalIds = loadCanonicalQualificationAssertionIds();
    assert.ok(canonicalIds.includes(result.evidence.assertion.id));
    const portableDigest = `sha256:${'a'.repeat(64)}`;
    const assertions: QualificationEvidenceAssertion[] = canonicalIds.map(id => id === result.evidence.assertion.id
      ? result.evidence.assertion
      : {
        id,
        invariantId: 'WPE-INV-001',
        scenarioId: 'WPE-Q-CANARY-REGISTRY',
        evidenceClass: 'automated_test_output',
        verdict: 'passed',
        sourceDigest: portableDigest,
        sourceRevision: baseHead,
        authority: 'synthetic_diagnostic',
        durable: false,
        assertionCode: 'canonical-registry-inventory-placeholder',
      });
    const report = buildQualificationReport({
      localIdentity: {
        sourceRevision: baseHead,
        sourceTree: expectedSnapshot.baseTree,
        repositoryIdentity: portableDigest,
        workspaceIdentity: portableDigest,
        engineDigest: portableDigest,
        policyDigest: portableDigest,
        compilerDigest: portableDigest,
        invariantDigest: portableDigest,
        testSuiteDigest: portableDigest,
        configurationDigest: portableDigest,
        gitInventories: {
          refsDigest: portableDigest,
          worktreesDigest: portableDigest,
          refCount: 1,
          worktreeCount: 1,
        },
      },
      testDatabaseIdentityHash: portableDigest,
      queueNamespace: 'qualification-canary-registry',
      repositorySeed: 'qualification-canary-registry',
      invariantCatalog: [],
      scenarioResults: [{ id: 'WPE-Q-CANARY-REGISTRY', verdict: 'passed', assertionIds: canonicalIds }],
      commitTopologyDigest: portableDigest,
      resourceBudgets: {},
      evidenceAssertions: assertions,
      requiredAssertionIds: canonicalIds,
      telemetry: [],
      semanticCloseout: 'succeeded',
    });
    assert.ok(report.evidenceAssertions.some(assertion => assertion.id === result.evidence.assertion.id));
    assert.equal(report.productionEnableAvailable, false);
    assert.throws(() => verifyPersistedGitWaveCanaryArtifacts({
      evidencePath: result.evidencePath,
      receiptPath: result.receiptPath,
      signingKey: 'wrong-focused-test-key-with-at-least-thirty-two-bytes',
      expectedSourceRevision: baseHead,
      expectedIssuer: 'focused-test-audit-issuer',
      expectedWorkspaceId: 'workspace-focused-canary',
    }), /authorization is invalid/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.equal(fs.existsSync(root), false);
});

test('immutable source snapshot binds dirty tracked and untracked files while excluding generated artifacts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-wave-snapshot-test-'));
  try {
    const { repository, baseHead } = createDirtySourceRepository(root);
    const bothDirty = captureGitWorktreeSnapshot(repository);
    assert.equal(bothDirty.baseHead, baseHead);
    assert.ok(bothDirty.representedPathCount >= 3);

    fs.rmSync(path.join(repository, 'untracked.txt'));
    const trackedOnly = captureGitWorktreeSnapshot(repository);
    assert.notEqual(trackedOnly.materialTree, bothDirty.materialTree);

    fs.writeFileSync(path.join(repository, 'untracked.txt'), 'dirty untracked content\n');
    fs.writeFileSync(path.join(repository, 'tracked.txt'), 'committed\n');
    const untrackedOnly = captureGitWorktreeSnapshot(repository);
    assert.notEqual(untrackedOnly.materialTree, bothDirty.materialTree);
    assert.notEqual(untrackedOnly.materialTree, trackedOnly.materialTree);

    fs.writeFileSync(path.join(repository, 'tracked.txt'), 'dirty tracked content\n');
    const restoredDirty = captureGitWorktreeSnapshot(repository);
    fs.writeFileSync(path.join(repository, 'ignored', 'generated.txt'), 'changed ignored content\n');
    assert.deepEqual(captureGitWorktreeSnapshot(repository), restoredDirty);
    fs.writeFileSync(path.join(repository, '.rorca', 'qualification', 'prior-evidence.json'), 'changed generated evidence\n');
    assert.deepEqual(captureGitWorktreeSnapshot(repository), restoredDirty);

    const invalidByteManifest = canonicalGitPathManifest([Buffer.from([0x80])]);
    assert.match(invalidByteManifest, /gA==/);
    assert.notEqual(invalidByteManifest, canonicalGitPathManifest([Buffer.from([0x81])]));
    // Linux admits standalone 0x80 path bytes; Darwin/Windows reject them at the
    // filesystem boundary, so those platforms exercise the same trailing byte
    // in a valid sequence while the manifest assertions above cover standalone 0x80.
    const rawRelativePath = process.platform === 'linux'
      ? Buffer.from([0x72, 0x61, 0x77, 0x2d, 0x80])
      : Buffer.from([0x72, 0x61, 0x77, 0x2d, 0xc2, 0x80]);
    const rawAbsolutePath = Buffer.concat([Buffer.from(`${repository}${path.sep}`), rawRelativePath]);
    fs.writeFileSync(rawAbsolutePath, 'raw byte path v1\n');
    const rawPathFirst = captureGitWorktreeSnapshot(repository);
    assert.equal(rawPathFirst.representedPathCount, restoredDirty.representedPathCount + 1);
    fs.writeFileSync(rawAbsolutePath, 'raw byte path v2\n');
    const rawPathSecond = captureGitWorktreeSnapshot(repository);
    assert.notEqual(rawPathSecond.materialTree, rawPathFirst.materialTree);
    assert.notEqual(rawPathSecond.inventoryDigest, rawPathFirst.inventoryDigest);
    fs.rmSync(rawAbsolutePath);

    git(repository, ['add', '-f', '.rorca/qualification/prior-evidence.json']);
    git(repository, ['commit', '-m', 'test: track qualification policy']);
    const trackedQualification = captureGitWorktreeSnapshot(repository);
    fs.writeFileSync(path.join(repository, '.rorca', 'qualification', 'prior-evidence.json'), 'tracked policy changed\n');
    assert.notEqual(captureGitWorktreeSnapshot(repository).materialTree, trackedQualification.materialTree);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.equal(fs.existsSync(root), false);
});

test('source drift after durable publication removes invalid canary artifacts and fails closed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-wave-publication-race-test-'));
  const artifactDirectory = path.join(root, 'qualification');
  let writer: ChildProcess | undefined;
  try {
    const { repository } = createDirtySourceRepository(root);
    writer = spawn(process.execPath, ['-e', `
      const fs = require('node:fs');
      const path = require('node:path');
      const [directory, target] = process.argv.slice(1);
      let artifactWatcher;
      const inspect = () => {
        try {
          if (fs.readdirSync(directory).some(entry => !entry.startsWith('.'))) {
            artifactWatcher?.close();
            rootWatcher.close();
            fs.writeFileSync(target, 'changed after durable publication\\n');
            process.exit(0);
          }
        } catch {}
      };
      const rootWatcher = fs.watch(path.dirname(directory), () => {
        if (!artifactWatcher && fs.existsSync(directory)) {
          artifactWatcher = fs.watch(directory, inspect);
          inspect();
        }
      });
    `, artifactDirectory, path.join(repository, 'tracked.txt')], { stdio: 'ignore' });
    const writerExited = once(writer, 'exit');
    await assert.rejects(runGitWaveCanary({
      repositoryRoot: repository,
      artifactDirectory,
      signingKey,
      issuer: 'focused-test-audit-issuer',
      workspaceId: 'workspace-focused-canary',
      attestedAt: '2026-08-18T12:00:00.000Z',
    }), /source worktree changed while durable canary artifacts were published/);
    await writerExited;
    assert.deepEqual(fs.readdirSync(artifactDirectory).filter(entry => !entry.startsWith('.')), []);
  } finally {
    writer?.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.equal(fs.existsSync(root), false);
});

test('post-rename receipt verification failure removes the complete artifact set', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-wave-publication-tamper-test-'));
  const artifactDirectory = path.join(root, 'qualification');
  try {
    const { repository } = createDirtySourceRepository(root);
    await assert.rejects(runGitWaveCanary({
      repositoryRoot: repository,
      artifactDirectory,
      signingKey,
      issuer: 'focused-test-audit-issuer',
      workspaceId: 'workspace-focused-canary',
      attestedAt: '2026-08-18T12:00:00.000Z',
      afterArtifactPublished: ({ receiptPath }) => {
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as { authorization: string };
        receipt.authorization = '0'.repeat(64);
        fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
      },
    }), /authorization is invalid/);
    assert.deepEqual(fs.readdirSync(artifactDirectory).filter(entry => !entry.startsWith('.')), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.equal(fs.existsSync(root), false);
});

test('real Git wave canary rejects missing signer authority before creating artifacts', async () => {
  await assert.rejects(runGitWaveCanary({
    repositoryRoot: path.join(os.tmpdir(), `unused-repository-${process.pid}`),
    artifactDirectory: path.join(os.tmpdir(), `must-not-exist-${process.pid}`),
    signingKey: 'short',
    issuer: 'focused-test-audit-issuer',
    workspaceId: 'workspace-focused-canary',
  }), /at least 32 bytes/);
});
