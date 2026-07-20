/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { isUtf8 } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  DeterministicFixtureHarness,
  recordFixtureHostPhase,
  type FixtureExecutionEvidence,
} from '../../test-helpers/deterministic-fixture-agent';
import {
  cleanupOwnedStoryWorktree,
  createOwnedStoryWorktree,
  type StoryWorktreeOwnership,
} from '../story-worktree-lifecycle';
import {
  LOCAL_REJECTION_DIAGNOSTIC_BYTES,
  PUBLIC_REJECTION_REASON_BYTES,
  PUBLIC_REJECTION_STACK_BYTES,
  closeoutRejectedStory,
  computeBlockedDependencyClosure,
  createRejectedWaveAccounting,
  normalizeRejectedStoryEvidence,
  rejectedWaveDispatchDecision,
  sanitizeStoredRejectedStoryEvidence,
  settleStoriesCorrelated,
  writeLocalRejectedStoryDiagnostic,
  type RejectionEvidenceChannel,
} from '../rejected-wave-closeout';
import { WaveIntegrationLedger, type WaveContributionIdentity } from '../wave-integration-protocol';

const gitEnvironment = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Rorca Rejected Wave',
  GIT_AUTHOR_EMAIL: 'wave-rejection@rorca.invalid',
  GIT_COMMITTER_NAME: 'Rorca Rejected Wave',
  GIT_COMMITTER_EMAIL: 'wave-rejection@rorca.invalid',
  GIT_AUTHOR_DATE: '2002-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2002-01-01T00:00:00Z',
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: gitEnvironment,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function createRepository(root: string): { repository: string; revision: string } {
  const repository = path.join(root, 'run-repository');
  fs.mkdirSync(repository);
  git(repository, ['init', '--initial-branch=qualification/run']);
  git(repository, ['config', 'user.name', 'Rorca Rejected Wave']);
  git(repository, ['config', 'user.email', 'wave-rejection@rorca.invalid']);
  fs.writeFileSync(path.join(repository, 'README.md'), 'rejected wave qualification\n');
  git(repository, ['add', 'README.md']);
  git(repository, ['commit', '-m', 'test(qualification): rejected wave base']);
  return { repository, revision: git(repository, ['rev-parse', 'HEAD']) };
}

function createStoryWorktree(
  root: string,
  repository: string,
  revision: string,
  storyId: string,
): StoryWorktreeOwnership {
  return createOwnedStoryWorktree({
    repositoryPath: repository,
    worktreePath: path.join(root, 'worktrees', storyId),
    branchName: `qualification/qrun_0123456789abcdef01234567/${storyId}/attempt-1`,
    runId: 907,
    waveIndex: 0,
    storyId,
    attempt: 1,
    baseRevision: revision,
    qualificationNamespace: 'qrun_0123456789abcdef01234567',
  });
}

class FixturePostCommitRejection extends Error {
  constructor(readonly fixtureEvidence: FixtureExecutionEvidence) {
    super('TOKEN=super-secret rejected at /Users/private/worktree and C:\\private\\checkout');
    this.name = 'FixturePostCommitRejection';
    this.stack = `${this.name}: ${this.message}\n    at reject (/Users/private/worktree/agent.ts:8:2)`;
  }
}

test('post-commit rejection fails closed while an already-running independent sibling finalizes exactly once', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-rejected-wave-'));
  const harness = new DeterministicFixtureHarness(root);
  try {
    const { repository, revision } = createRepository(root);
    const barrierDirectory = path.join(root, 'barrier');
    const worktreeDirectory = path.join(root, 'worktrees');
    fs.mkdirSync(barrierDirectory);
    fs.mkdirSync(worktreeDirectory);
    const rejectedOwnership = createStoryWorktree(root, repository, revision, 'WPE-REJECTED');
    const siblingOwnership = createStoryWorktree(root, repository, revision, 'WPE-SIBLING');
    const allowlist = new Set([rejectedOwnership.ownershipId, siblingOwnership.ownershipId]);
    const fixtureStarts: string[] = [];

    const rejectedPromise = harness.run({
      storyId: 'WPE-REJECTED',
      scenarioId: 'same-wave-post-commit-rejection',
      seed: 'rejected-wave-seed-v1',
      revision,
      cwd: rejectedOwnership.worktreeRealpath,
      barrierDirectory,
      timeoutMs: 5_000,
    }, { onEvent: event => { if (event.type === 'story-started') fixtureStarts.push('WPE-REJECTED'); } }).then(evidence => {
      assert.equal(evidence.status, 'rejected');
      assert.equal(evidence.lifecycle.committed, true);
      throw new FixturePostCommitRejection(evidence);
    });
    const siblingPromise = harness.run({
      storyId: 'WPE-SIBLING',
      scenarioId: 'same-wave-independent-sibling',
      seed: 'rejected-wave-seed-v1',
      revision,
      cwd: siblingOwnership.worktreeRealpath,
      barrierDirectory,
      timeoutMs: 5_000,
    }, { onEvent: event => { if (event.type === 'story-started') fixtureStarts.push('WPE-SIBLING'); } });

    // Deliberately list the slower/successful sibling first. Correlation must be
    // by immutable entry identity, never by rejection or completion arrival.
    const settled = await settleStoriesCorrelated([
      { storyId: 'WPE-SIBLING', promise: siblingPromise },
      { storyId: 'WPE-REJECTED', promise: rejectedPromise },
    ]);
    assert.deepEqual(settled.map(item => [item.storyId, item.status]), [
      ['WPE-SIBLING', 'fulfilled'],
      ['WPE-REJECTED', 'rejected'],
    ]);
    assert.deepEqual(new Set(fixtureStarts), new Set(['WPE-REJECTED', 'WPE-SIBLING']));
    const siblingEvidence = settled[0].status === 'fulfilled' ? settled[0].value : assert.fail('sibling rejected');
    const rejection = settled[1].status === 'rejected' ? settled[1].reason : assert.fail('rejected story fulfilled');
    assert.equal(siblingEvidence.status, 'passed');

    const compiledDag = [
      { id: 'WPE-REJECTED', dependsOn: [] },
      { id: 'WPE-SIBLING', dependsOn: [] },
      { id: 'WPE-DIRECT', dependsOn: ['WPE-REJECTED'] },
      { id: 'WPE-TRANSITIVE', dependsOn: ['WPE-DIRECT'] },
      { id: 'WPE-UNRELATED-LATER', dependsOn: [] },
    ];
    const accounting = createRejectedWaveAccounting();
    const projections = new Map<RejectionEvidenceChannel, unknown>();
    const evidenceDirectory = path.join(root, 'durable-rejection-projections');
    fs.mkdirSync(evidenceDirectory, { mode: 0o700 });
    const diagnosticsPath = path.join(root, 'diagnostics', 'WPE-REJECTED.raw.json');
    const project = (channel: RejectionEvidenceChannel) => async (value: unknown): Promise<void> => {
      projections.set(channel, value);
      if (channel === 'localDiagnostics') {
        writeLocalRejectedStoryDiagnostic(diagnosticsPath, 'WPE-REJECTED', rejection);
      } else {
        fs.writeFileSync(path.join(evidenceDirectory, `${channel}.json`), `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
      }
    };
    const closeout = await closeoutRejectedStory({
      storyId: 'WPE-REJECTED',
      rejection,
      compiledStories: compiledDag,
      accounting,
      projectors: {
        specState: project('specState'),
        runState: project('runState'),
        wal: project('wal'),
        storyResult: project('storyResult'),
        localDiagnostics: project('localDiagnostics'),
      },
    });
    assert.deepEqual(accounting.accountingOrder.slice(0, 5), [
      'failed:WPE-REJECTED',
      'rejected:WPE-REJECTED',
      'processed:WPE-REJECTED',
      'dispatch_closed:WPE-REJECTED',
      'dependency_analysis:WPE-REJECTED',
    ]);
    assert.equal(closeout.evidenceGap, false);
    assert.equal(projections.size, 5);
    for (const channel of ['specState', 'runState', 'wal', 'storyResult'] as const) {
      const persisted = JSON.parse(fs.readFileSync(path.join(evidenceDirectory, `${channel}.json`), 'utf8'));
      assert.equal(persisted.semanticStatus, 'failed');
      assert.deepEqual(persisted.blockedBy, {
        'WPE-DIRECT': ['WPE-REJECTED'],
        'WPE-TRANSITIVE': ['WPE-REJECTED'],
      });
    }
    assert.deepEqual(closeout.blockedBy, {
      'WPE-DIRECT': ['WPE-REJECTED'],
      'WPE-TRANSITIVE': ['WPE-REJECTED'],
    });
    assert.doesNotMatch(closeout.evidence.reason + closeout.evidence.stack, /super-secret|\/Users\/private|C:\\private/);

    const dependentSideEffects = Object.fromEntries(['process', 'worktree', 'queueClaim', 'commit', 'validation', 'merge']
      .map(name => [name, 0]));
    for (const dependent of ['WPE-DIRECT', 'WPE-TRANSITIVE']) {
      assert.equal(rejectedWaveDispatchDecision({
        dispatchClosed: accounting.dispatchClosed,
        alreadyRunning: false,
        blockedBy: closeout.blockedBy[dependent],
      }), 'do_not_start');
    }
    assert.equal(rejectedWaveDispatchDecision({
      dispatchClosed: true,
      alreadyRunning: false,
      blockedBy: [],
    }), 'do_not_start', 'an unstarted independent/later-wave story was dispatched');
    assert.equal(rejectedWaveDispatchDecision({
      dispatchClosed: true,
      alreadyRunning: true,
      blockedBy: [],
    }), 'drain_running_sibling');
    assert.deepEqual(dependentSideEffects, { process: 0, worktree: 0, queueClaim: 0, commit: 0, validation: 0, merge: 0 });
    const qualificationRefs = git(repository, ['for-each-ref', '--format=%(refname)', 'refs/heads/qualification/']);
    assert.doesNotMatch(qualificationRefs, /WPE-DIRECT|WPE-TRANSITIVE/);

    const rejectedCommit = git(rejectedOwnership.worktreeRealpath, ['rev-parse', 'HEAD']);
    assert.notEqual(rejectedCommit, revision);
    const rejectedCleanup = cleanupOwnedStoryWorktree({
      repositoryPath: repository,
      ownership: rejectedOwnership,
      currentWaveAllowlist: allowlist,
      expectedBaseRevision: revision,
      preserve: false,
      outcome: 'rejected',
    });
    assert.equal(rejectedCleanup.ok, true);
    assert.equal(rejectedCleanup.removed, true);
    assert.ok(rejectedCleanup.recoveryRef);
    assert.equal(git(repository, ['rev-parse', rejectedCleanup.recoveryRef!]), rejectedCommit);
    assert.equal(fs.existsSync(rejectedOwnership.worktreeRealpath), false);
    assert.throws(() => git(repository, ['rev-parse', `refs/heads/${rejectedOwnership.branchName}`]));

    const manifestPath = path.join(root, 'frozen-manifest.json');
    fs.writeFileSync(manifestPath, '{"schemaVersion":1,"wave":0}\n', { mode: 0o600 });
    const siblingCommit = git(siblingOwnership.worktreeRealpath, ['rev-parse', 'HEAD']);
    const identity: WaveContributionIdentity = {
      runId: 907,
      waveIndex: 0,
      storyId: 'WPE-SIBLING',
      attempt: 1,
      sourceRef: `refs/heads/${siblingOwnership.branchName}`,
      sourceCommit: siblingCommit,
      sourceBaseCommit: revision,
      expectedParentHead: revision,
      frozenManifestPath: manifestPath,
      frozenManifestHash: sha256(fs.readFileSync(manifestPath)),
    };
    const ledger = new WaveIntegrationLedger(repository);
    ledger.prepare(identity);
    const integrated = ledger.integrate(identity);
    const validation = {
      validator: 'canonical-host-validation-v1',
      revision: integrated.resultingHead!,
      treeHash: git(repository, ['rev-parse', 'HEAD^{tree}']),
      contractHash: sha256('rejected-wave-sibling-contract-v1'),
    };
    ledger.markIntegratedValidated(identity, validation);
    let passFinalizations = 0;
    const finalized = ledger.finalize(identity, (idempotencyKey, finalRevision) => {
      passFinalizations += 1;
      const receipt = `${idempotencyKey}:${finalRevision}`;
      return { idempotencyKey, revision: finalRevision, receiptHash: sha256(receipt) };
    });
    ledger.finalize(identity, () => { throw new Error('exactly-once finalizer replayed'); });
    assert.equal(finalized.state, 'finalized');
    assert.equal(passFinalizations, 1);
    const finalizedSiblingEvidence = recordFixtureHostPhase(
      recordFixtureHostPhase(recordFixtureHostPhase(siblingEvidence, 'hostValidation'), 'integration'),
      'finalCloseout',
    );
    assert.equal(finalizedSiblingEvidence.lifecycle.finalCloseout, true);
    const siblingCleanup = cleanupOwnedStoryWorktree({
      repositoryPath: repository,
      ownership: siblingOwnership,
      currentWaveAllowlist: allowlist,
      expectedBaseRevision: revision,
      preserve: false,
      outcome: 'integrated',
    });
    assert.equal(siblingCleanup.ok, true);
    assert.equal(siblingCleanup.removed, true);
    assert.equal(fs.existsSync(siblingOwnership.worktreeRealpath), false);
    assert.throws(() => git(repository, ['rev-parse', `refs/heads/${siblingOwnership.branchName}`]));

    const semanticTrace = {
      pipelineStatus: 'failed',
      runState: 'failed',
      wal: 'story_rejected',
      storyResult: 'fail',
      processExitCode: 1,
      processEvents: [] as string[],
      runCloseout: { authoritative: true, status: 'failed', reason: closeout.evidence.reason },
      siblingStatus: 'pass',
      cleanupStatus: 'ok',
      agentExitCode: 0,
    };
    assert.equal(semanticTrace.pipelineStatus, 'failed');
    assert.equal(semanticTrace.runState, 'failed');
    assert.equal(semanticTrace.processExitCode, 1);
    assert.equal(semanticTrace.runCloseout.status, 'failed');
    assert.equal(semanticTrace.processEvents.includes('run_finished'), false);
    assert.equal(fs.statSync(diagnosticsPath).mode & 0o777, 0o600);
    assert.ok(fs.statSync(diagnosticsPath).size <= LOCAL_REJECTION_DIAGNOSTIC_BYTES);
    assert.match(fs.readFileSync(diagnosticsPath, 'utf8'), /NON-PORTABLE LOCAL DIAGNOSTIC/);
    assert.equal(git(repository, ['status', '--porcelain=v1', '--untracked-files=all']), '');
  } finally {
    await harness.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('portable rejection evidence covers arbitrary values, redacts secrets and paths, and remains bounded valid UTF-8', () => {
  const oversized = new Error('PASSWORD=hunter2 /home/private/project C:\\private\\repo ' + '🙂'.repeat(8_000));
  oversized.stack = `TOKEN=abc123\n${'界'.repeat(8_000)}\n    at x (/var/private/source.ts:1:1)`;
  const circular: Record<string, unknown> = { code: 31 };
  circular.self = circular;
  const serializationFailure = { toJSON(): never { throw new Error('API_KEY=must-not-escape'); } };
  const values: unknown[] = [
    new Error('SECRET=value /Users/alice/repo C:\\Users\\alice\\repo'),
    'TOKEN=string-secret at /tmp/private/file and D:\\private\\file',
    { reason: 'PASSWORD=object-secret', path: '/opt/private/file' },
    oversized,
    circular,
    serializationFailure,
    31,
  ];
  for (const value of values) {
    const evidence = normalizeRejectedStoryEvidence('WPE-EDGE', value);
    assert.ok(Buffer.byteLength(evidence.reason, 'utf8') <= PUBLIC_REJECTION_REASON_BYTES);
    assert.ok(Buffer.byteLength(evidence.stack, 'utf8') <= PUBLIC_REJECTION_STACK_BYTES);
    assert.equal(isUtf8(Buffer.from(evidence.reason)), true);
    assert.equal(isUtf8(Buffer.from(evidence.stack)), true);
    assert.doesNotMatch(`${evidence.reason}\n${evidence.stack}`, /hunter2|abc123|must-not-escape|\/Users\/alice|\/home\/private|\/var\/private|C:\\Users|D:\\private/);
  }
  assert.equal(normalizeRejectedStoryEvidence('WPE-EDGE', serializationFailure).kind, 'serialization_failure');
  assert.equal(normalizeRejectedStoryEvidence('WPE-EDGE', circular).kind, 'serialization_failure');

  const revalidated = sanitizeStoredRejectedStoryEvidence('WPE-EDGE', {
    schemaVersion: 1,
    storyId: 'WPE-EDGE',
    kind: 'error',
    reason: 'TOKEN=stored-secret /Users/private/repo',
    stack: `C:\\private\\repo\\agent.ts\n${'🙂'.repeat(8_000)}`,
    reasonTruncated: false,
    stackTruncated: false,
    portable: true,
  });
  assert.ok(revalidated);
  assert.doesNotMatch(`${revalidated.reason}${revalidated.stack}`, /stored-secret|\/Users\/private|C:\\private/);
  assert.ok(Buffer.byteLength(revalidated.stack, 'utf8') <= PUBLIC_REJECTION_STACK_BYTES);
});

test('dependency closure uses canonical IDs, terminates on malformed cycles, and leaves unrelated stories unblocked', () => {
  const closure = computeBlockedDependencyClosure([
    { id: 'ROOT', dependsOn: [] },
    { id: 'A', dependsOn: ['ROOT', 42] },
    { id: 'B', dependsOn: ['A', 'C'] },
    { id: 'C', dependsOn: ['B'] },
    { id: 'UNRELATED', dependsOn: [] },
    { id: 'root', dependsOn: [] },
    { id: '../invalid', dependsOn: ['ROOT'] },
    { id: 42, dependsOn: ['ROOT'] },
    { id: 'MALFORMED', dependsOn: 'ROOT' },
  ], ['ROOT', 'UNKNOWN']);
  assert.deepEqual(closure, { A: ['ROOT'], B: ['ROOT'], C: ['ROOT'] });
  assert.equal('UNRELATED' in closure, false);
  assert.equal('root' in closure, false, 'case-folded alias was treated as a canonical story ID');
});

test('a projection failure attempts every remaining channel and forces evidence-gap semantic failure', async () => {
  const accounting = createRejectedWaveAccounting();
  const attempted: RejectionEvidenceChannel[] = [];
  const projector = (channel: RejectionEvidenceChannel, fail = false) => async (): Promise<void> => {
    attempted.push(channel);
    if (fail) throw new Error(`${channel} unavailable`);
  };
  const result = await closeoutRejectedStory({
    storyId: 'ROOT',
    rejection: 'rejected',
    compiledStories: [{ id: 'ROOT', dependsOn: [] }, { id: 'CHILD', dependsOn: ['ROOT'] }],
    accounting,
    projectors: {
      specState: projector('specState'),
      runState: projector('runState'),
      wal: projector('wal', true),
      storyResult: projector('storyResult'),
      localDiagnostics: projector('localDiagnostics'),
    },
  });
  assert.deepEqual(attempted, ['specState', 'runState', 'wal', 'storyResult', 'localDiagnostics']);
  assert.deepEqual(result.channelAttempts, attempted);
  assert.deepEqual(result.failedChannels, ['wal']);
  assert.equal(result.evidenceGap, true);
  assert.equal(result.semanticStatus, 'failed');
  assert.deepEqual(result.blockedBy, { CHILD: ['ROOT'] });
  assert.ok(accounting.failed.has('ROOT') && accounting.rejected.has('ROOT') && accounting.processed.has('ROOT'));
});

test('settled story identities do not depend on completion order', async () => {
  let resolveSlow!: (value: string) => void;
  const slow = new Promise<string>(resolve => { resolveSlow = resolve; });
  const fast = Promise.reject('fast rejection');
  const settling = settleStoriesCorrelated([
    { storyId: 'SLOW-SIBLING', promise: slow },
    { storyId: 'FAST-REJECTED', promise: fast },
  ]);
  await new Promise(resolve => setImmediate(resolve));
  resolveSlow('done');
  const result = await settling;
  assert.deepEqual(result.map(item => [item.storyId, item.status]), [
    ['SLOW-SIBLING', 'fulfilled'],
    ['FAST-REJECTED', 'rejected'],
  ]);
});
