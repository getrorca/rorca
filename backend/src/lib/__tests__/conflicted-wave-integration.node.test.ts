/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { DeterministicFixtureHarness } from '../../test-helpers/deterministic-fixture-agent';
import {
  cleanupOwnedStoryWorktree,
  createOwnedStoryWorktree,
  type StoryWorktreeOwnership,
} from '../story-worktree-lifecycle';
import {
  deterministicWaveIntegrationOrder,
  waveStoryReconciliationState,
  WaveIntegrationLedger,
  type WaveConflictKind,
  type WaveContributionIdentity,
} from '../wave-integration-protocol';

const conflictMigrationPath = path.resolve(process.cwd(), 'backend', 'src', 'db', 'pg-migrations', '20260719091000_wave_conflict_recovery.sql');

// Git fixtures receive only deterministic Git settings, never the test process env.
const gitEnvironment = {
  PATH: process.env.PATH ?? '',
  HOME: os.tmpdir(),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Rorca Conflict Qualification',
  GIT_AUTHOR_EMAIL: 'wave-conflict@rorca.invalid',
  GIT_COMMITTER_NAME: 'Rorca Conflict Qualification',
  GIT_COMMITTER_EMAIL: 'wave-conflict@rorca.invalid',
  GIT_AUTHOR_DATE: '2003-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2003-01-01T00:00:00Z',
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

function createRepository(root: string): { repository: string; base: string } {
  const repository = path.join(root, 'repository');
  fs.mkdirSync(repository);
  git(repository, ['init', '--initial-branch=qualification/run']);
  git(repository, ['config', 'user.name', 'Rorca Conflict Qualification']);
  git(repository, ['config', 'user.email', 'wave-conflict@rorca.invalid']);
  fs.writeFileSync(path.join(repository, 'shared-conflict.txt'), 'stable heading\nbase value\nstable ending\n');
  fs.writeFileSync(path.join(repository, 'README.md'), 'conflicted wave qualification\n');
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'test(qualification): conflict base']);
  git(repository, ['branch', 'unrelated/preserved']);
  return { repository, base: git(repository, ['rev-parse', 'HEAD']) };
}

function createOwnership(root: string, repository: string, base: string, storyId: string): StoryWorktreeOwnership {
  return createOwnedStoryWorktree({
    repositoryPath: repository,
    worktreePath: path.join(root, 'worktrees', storyId),
    branchName: `qualification/qrun_0123456789abcdef01234567/${storyId}/attempt-1`,
    runId: 908,
    waveIndex: 0,
    storyId,
    attempt: 1,
    baseRevision: base,
    qualificationNamespace: 'qrun_0123456789abcdef01234567',
  });
}

function identity(
  manifestPath: string,
  base: string,
  ownership: StoryWorktreeOwnership,
  storyId: string,
  expectedParentHead: string,
): WaveContributionIdentity {
  return {
    runId: 908,
    waveIndex: 0,
    storyId,
    attempt: 1,
    sourceRef: `refs/heads/${ownership.branchName}`,
    sourceCommit: git(ownership.worktreeRealpath, ['rev-parse', 'HEAD']),
    sourceBaseCommit: base,
    expectedParentHead,
    frozenManifestPath: manifestPath,
    frozenManifestHash: sha256(fs.readFileSync(manifestPath)),
  };
}

function assertCleanInventory(repository: string): void {
  assert.equal(git(repository, ['status', '--porcelain=v1', '--untracked-files=all']), '');
  assert.equal(git(repository, ['ls-files', '-u']), '');
  for (const operation of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REBASE_HEAD']) {
    const operationPath = path.resolve(repository, git(repository, ['rev-parse', '--git-path', operation]));
    assert.equal(fs.existsSync(operationPath), false, `${operation} survived conflict recovery`);
  }
  const common = path.resolve(repository, git(repository, ['rev-parse', '--git-common-dir']));
  const locks: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.name.endsWith('.lock')) locks.push(candidate);
    }
  };
  visit(common);
  assert.deepEqual(locks, []);
  assert.equal(git(repository, ['worktree', 'list', '--porcelain']).split('\n\n').filter(Boolean).length, 1);
}

interface ConflictRunVerdict {
  order: string[];
  conflictAttribution: unknown;
  acceptedTree: string;
  runCloseout: { status: 'failed'; exitCode: 1 };
}

async function runConflictFixture(root: string, completionOrder: readonly string[]): Promise<ConflictRunVerdict> {
  const { repository, base } = createRepository(root);
  fs.mkdirSync(path.join(root, 'worktrees'));
  const independent = createOwnership(root, repository, base, 'WPE-CONFLICT-00-INDEPENDENT');
  const left = createOwnership(root, repository, base, 'WPE-CONFLICT-01-LEFT');
  const right = createOwnership(root, repository, base, 'WPE-CONFLICT-02-RIGHT');
  const allowlist = new Set([independent.ownershipId, left.ownershipId, right.ownershipId]);
  fs.writeFileSync(path.join(independent.worktreeRealpath, 'independent.txt'), 'accepted once\n');
  git(independent.worktreeRealpath, ['add', 'independent.txt']);
  git(independent.worktreeRealpath, ['commit', '-m', 'test(fixture): independent sibling']);

  const harness = new DeterministicFixtureHarness(root);
  const barrierDirectory = path.join(root, 'barrier');
  fs.mkdirSync(barrierDirectory);
  try {
    const executions = new Map<string, Awaited<ReturnType<DeterministicFixtureHarness['run']>>>();
    await Promise.all([
      harness.run({ storyId: 'WPE-CONFLICT-01-LEFT', scenarioId: 'merge-conflict-concurrent-left', seed: 'same-hunk-v1', revision: base, cwd: left.worktreeRealpath, barrierDirectory }),
      harness.run({ storyId: 'WPE-CONFLICT-02-RIGHT', scenarioId: 'merge-conflict-concurrent-right', seed: 'same-hunk-v1', revision: base, cwd: right.worktreeRealpath, barrierDirectory }),
    ].map(async promise => {
      const evidence = await promise;
      assert.equal(evidence.exitCode, 0, 'agent subprocess did not exit zero before integration');
      assert.equal(evidence.status, 'passed');
      executions.set(evidence.storyId, evidence);
    }));
    assert.deepEqual(new Set(executions.keys()), new Set(['WPE-CONFLICT-01-LEFT', 'WPE-CONFLICT-02-RIGHT']));

    const manifestPath = path.join(root, 'manifest.json');
    fs.writeFileSync(manifestPath, `${JSON.stringify({ completionOrder, stories: [...executions.keys()] })}\n`, { mode: 0o600 });
    const byId = new Map([
      ['WPE-CONFLICT-00-INDEPENDENT', independent],
      ['WPE-CONFLICT-01-LEFT', left],
      ['WPE-CONFLICT-02-RIGHT', right],
    ]);
    const arrivals = ['WPE-CONFLICT-00-INDEPENDENT', ...completionOrder].map(storyId => ({ storyId, waveIndex: 0 }));
    const order = deterministicWaveIntegrationOrder(arrivals).map(item => item.storyId);
    assert.deepEqual(order, ['WPE-CONFLICT-00-INDEPENDENT', 'WPE-CONFLICT-01-LEFT', 'WPE-CONFLICT-02-RIGHT']);

    const ledger = new WaveIntegrationLedger(repository);
    let parent = base;
    const accepted: Array<{ ownership: StoryWorktreeOwnership; identity: WaveContributionIdentity }> = [];
    let conflictedIdentity!: WaveContributionIdentity;
    for (const storyId of order) {
      const ownership = byId.get(storyId)!;
      const contribution = identity(manifestPath, base, ownership, storyId, parent);
      ledger.prepare(contribution);
      if (storyId === 'WPE-CONFLICT-02-RIGHT') {
        conflictedIdentity = contribution;
        assert.throws(() => ledger.integrate(contribution), /merge conflict aborted and failed closed/);
        break;
      }
      const integrated = ledger.integrate(contribution);
      assert.equal(integrated.state, 'integrated');
      parent = integrated.resultingHead!;
      const validation = {
        validator: 'canonical-integrated-validation-v1',
        revision: parent,
        treeHash: git(repository, ['rev-parse', 'HEAD^{tree}']),
        contractHash: sha256('conflict-fixture-integrated-validation-v1'),
      };
      ledger.markIntegratedValidated(contribution, validation);
      ledger.finalize(contribution, (idempotencyKey, revision) => ({
        idempotencyKey,
        revision,
        receiptHash: sha256(`${idempotencyKey}:${revision}`),
      }));
      accepted.push({ ownership, identity: contribution });
    }

    const conflict = ledger.get(conflictedIdentity)!;
    assert.equal(conflict.state, 'aborted');
    assert.equal(waveStoryReconciliationState(null), 'never_attempted');
    assert.equal(waveStoryReconciliationState({ ...conflict, state: 'conflicted' }), 'conflicted');
    assert.equal(waveStoryReconciliationState({ ...conflict, state: 'resolution_pending' }), 'resolution_pending');
    assert.equal(waveStoryReconciliationState(conflict), 'aborted');
    assert.equal(waveStoryReconciliationState(ledger.get(accepted[0].identity)), 'integrated');
    assert.deepEqual(conflict.transitions.map(item => item.state), ['prepared', 'integrating', 'conflicted', 'aborted']);
    assert.deepEqual(conflict.conflictEvidence?.conflictingFiles.map(file => [file.path, file.kind]), [['shared-conflict.txt', 'content']]);
    assert.equal(conflict.conflictEvidence?.sourceCommit, conflictedIdentity.sourceCommit);
    assert.equal(conflict.conflictEvidence?.expectedParentHead, parent);
    assert.equal(conflict.conflictEvidence?.actualParentHead, parent);
    assert.equal(conflict.conflictEvidence?.preMergeHead, parent);
    assert.equal(conflict.conflictEvidence?.postAbortHead, parent);
    assert.equal(conflict.conflictEvidence?.resolver.policy, 'disabled');
    assert.ok(Buffer.byteLength(JSON.stringify(conflict.conflictEvidence)) < 16 * 1024);
    assert.throws(() => ledger.finalize(conflictedIdentity, () => assert.fail('conflict reached canonical pass finalization')), /requires integrated validation/);
    const transitionCount = conflict.transitions.length;
    assert.throws(() => new WaveIntegrationLedger(repository).integrate(conflictedIdentity), /cannot integrate from aborted/);
    assert.equal(ledger.get(conflictedIdentity)?.transitions.length, transitionCount, 'conflict replay mutated durable attribution');

    assert.equal(fs.readFileSync(path.join(repository, 'independent.txt'), 'utf8'), 'accepted once\n');
    assert.equal(git(repository, ['rev-list', '--count', 'HEAD', '--', 'independent.txt']), '1');
    assert.equal(git(repository, ['rev-parse', 'HEAD']), parent, 'conflict changed accepted sibling history');
    const acceptedTree = git(repository, ['rev-parse', 'HEAD^{tree}']);

    const rejectedCleanup = cleanupOwnedStoryWorktree({
      repositoryPath: repository,
      ownership: right,
      currentWaveAllowlist: allowlist,
      expectedBaseRevision: base,
      preserve: false,
      outcome: 'rejected',
    });
    assert.equal(rejectedCleanup.ok, true);
    assert.equal(rejectedCleanup.removed, true);
    assert.ok(rejectedCleanup.recoveryRef);
    assert.equal(git(repository, ['rev-parse', rejectedCleanup.recoveryRef!]), conflictedIdentity.sourceCommit);
    assert.equal(fs.existsSync(right.worktreeRealpath), false);

    for (const item of accepted) {
      const cleanup = cleanupOwnedStoryWorktree({
        repositoryPath: repository,
        ownership: item.ownership,
        currentWaveAllowlist: allowlist,
        expectedBaseRevision: base,
        preserve: false,
        outcome: 'integrated',
      });
      assert.equal(cleanup.ok, true);
      assert.equal(cleanup.removed, true);
    }
    assert.equal(git(repository, ['rev-parse', 'unrelated/preserved']), base);
    const refs = git(repository, ['for-each-ref', '--format=%(refname)', 'refs/heads/qualification/qrun_']);
    assert.equal(refs, '', 'owned temporary source ref survived cleanup');
    const recoveryRefs = git(repository, ['for-each-ref', '--format=%(refname)', 'refs/heads/rorca/recovery/']).split('\n').filter(Boolean);
    assert.deepEqual(recoveryRefs, [rejectedCleanup.recoveryRef]);
    assertCleanInventory(repository);

    const partialWave = {
      storyStates: {
        'WPE-CONFLICT-00-INDEPENDENT': 'accepted',
        'WPE-CONFLICT-01-LEFT': 'accepted',
        'WPE-CONFLICT-02-RIGHT': 'failed',
        'WPE-CONFLICT-03-DEPENDENT': 'blocked',
      },
      blockedBy: { 'WPE-CONFLICT-03-DEPENDENT': ['WPE-CONFLICT-02-RIGHT'] },
    } as const;
    assert.equal(partialWave.storyStates['WPE-CONFLICT-00-INDEPENDENT'], 'accepted');
    assert.equal(partialWave.storyStates['WPE-CONFLICT-02-RIGHT'], 'failed');
    assert.deepEqual(partialWave.blockedBy, { 'WPE-CONFLICT-03-DEPENDENT': ['WPE-CONFLICT-02-RIGHT'] });
    const runCloseout = { status: 'failed' as const, exitCode: 1 as const };
    assert.equal(runCloseout.status, 'failed');
    assert.equal(runCloseout.exitCode, 1);
    return {
      order,
      conflictAttribution: {
        storyId: conflict.storyId,
        files: conflict.conflictEvidence?.conflictingFiles,
        transitions: conflict.transitions.map(item => item.state),
        resolver: conflict.conflictEvidence?.resolver,
      },
      acceptedTree,
      runCloseout,
    };
  } finally {
    await harness.dispose();
  }
}

test('same-hunk concurrent fixture is deterministic across completion permutations and replay without wave atomicity', async () => {
  const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-conflict-first-'));
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-conflict-second-'));
  try {
    const first = await runConflictFixture(firstRoot, ['WPE-CONFLICT-02-RIGHT', 'WPE-CONFLICT-01-LEFT']);
    const second = await runConflictFixture(secondRoot, ['WPE-CONFLICT-01-LEFT', 'WPE-CONFLICT-02-RIGHT']);
    assert.deepEqual(first.order, second.order);
    assert.deepEqual(first.conflictAttribution, second.conflictAttribution);
    assert.equal(first.acceptedTree, second.acceptedTree);
    assert.deepEqual(first.runCloseout, { status: 'failed', exitCode: 1 });
  } finally {
    fs.rmSync(firstRoot, { recursive: true, force: true });
    fs.rmSync(secondRoot, { recursive: true, force: true });
  }
});

interface MatrixCase {
  name: string;
  expectedKind: WaveConflictKind;
  target(repository: string): void;
  source(repository: string): void;
}

function writeAndAdd(repository: string, relativePath: string, value: string | Buffer): void {
  const absolute = path.join(repository, relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, value);
  git(repository, ['add', '--', relativePath]);
}

const conflictMatrix: MatrixCase[] = [
  {
    name: 'add-add', expectedKind: 'add_add',
    target: repository => writeAndAdd(repository, 'new-file.txt', 'target\n'),
    source: repository => writeAndAdd(repository, 'new-file.txt', 'source\n'),
  },
  {
    name: 'binary', expectedKind: 'binary',
    target: repository => writeAndAdd(repository, 'binary.dat', Buffer.from([0, 1, 2, 3])),
    source: repository => writeAndAdd(repository, 'binary.dat', Buffer.from([0, 9, 8, 7])),
  },
  {
    name: 'generated-overlap', expectedKind: 'generated',
    target: repository => writeAndAdd(repository, 'generated/client.ts', 'target generated\n'),
    source: repository => writeAndAdd(repository, 'generated/client.ts', 'source generated\n'),
  },
  {
    name: 'rename-delete', expectedKind: 'rename_delete',
    target: repository => git(repository, ['rm', 'rename-source.txt']),
    source: repository => {
      git(repository, ['mv', 'rename-source.txt', 'renamed-source.txt']);
      fs.appendFileSync(path.join(repository, 'renamed-source.txt'), 'source rename suffix\n');
      git(repository, ['add', '--', 'renamed-source.txt']);
    },
  },
];

function runMatrixCase(root: string, matrixCase: MatrixCase): void {
  const { repository, base } = createRepository(root);
  fs.writeFileSync(path.join(repository, 'rename-source.txt'), Array.from({ length: 20 }, (_, index) => `rename base line ${index}\n`).join(''));
  fs.writeFileSync(path.join(repository, 'binary.dat'), Buffer.from([0, 4, 4, 4]));
  fs.mkdirSync(path.join(repository, 'generated'));
  fs.writeFileSync(path.join(repository, 'generated/client.ts'), 'base generated\n');
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'test: matrix base files']);
  const matrixBase = git(repository, ['rev-parse', 'HEAD']);
  git(repository, ['branch', 'source/story', matrixBase]);
  matrixCase.target(repository);
  git(repository, ['commit', '-m', `test: target ${matrixCase.name}`]);
  const targetHead = git(repository, ['rev-parse', 'HEAD']);
  git(repository, ['checkout', 'source/story']);
  matrixCase.source(repository);
  git(repository, ['commit', '-m', `test: source ${matrixCase.name}`]);
  const sourceCommit = git(repository, ['rev-parse', 'HEAD']);
  git(repository, ['checkout', 'qualification/run']);

  const manifestPath = path.join(root, 'manifest.json');
  fs.writeFileSync(manifestPath, '{"conflictMatrix":true}\n');
  const contribution: WaveContributionIdentity = {
    runId: 909,
    waveIndex: 0,
    storyId: `MATRIX-${matrixCase.name}`,
    attempt: 1,
    sourceRef: 'refs/heads/source/story',
    sourceCommit,
    sourceBaseCommit: matrixBase,
    expectedParentHead: targetHead,
    frozenManifestPath: manifestPath,
    frozenManifestHash: sha256(fs.readFileSync(manifestPath)),
  };
  const ledger = new WaveIntegrationLedger(repository);
  ledger.prepare(contribution);
  let resolverCalls = 0;
  const crashingResolver = (): never => { resolverCalls += 1; throw new Error('resolver crashed'); };
  assert.equal(typeof crashingResolver, 'function');
  if (matrixCase.name === 'add-add') {
    assert.equal(ledger.beginIntegration(contribution).state, 'integrating');
    assert.throws(() => git(repository, ['merge', '--no-ff', '--no-commit', sourceCommit]));
    assert.throws(
      () => new WaveIntegrationLedger(repository).integrate(contribution),
      /cannot integrate from aborted/,
      'restart did not reconcile and abort the interrupted conflict',
    );
  } else {
    assert.throws(() => ledger.integrate(contribution), /merge conflict aborted/, `${matrixCase.name} did not create a real conflict`);
  }
  const record = ledger.get(contribution)!;
  assert.equal(record.state, 'aborted');
  assert.equal(record.conflictEvidence?.conflictingFiles[0]?.kind, matrixCase.expectedKind);
  assert.equal(record.conflictEvidence?.resolver.policy, 'disabled');
  assert.equal(resolverCalls, 0, 'disabled policy invoked an arbitrary/crashing resolver');
  assert.equal(git(repository, ['rev-parse', 'HEAD']), targetHead);
  git(repository, ['update-ref', '-d', 'refs/heads/source/story', sourceCommit]);
  assert.equal(git(repository, ['for-each-ref', '--format=%(refname)', 'refs/heads/source/']), '');
  assertCleanInventory(repository);
  assert.equal(git(repository, ['rev-parse', 'unrelated/preserved']), base);
}

test('conflict classifier fails closed for add/add, binary, generated, rename/delete, and a crashing resolver hook', () => {
  for (const matrixCase of conflictMatrix) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `rorca-${matrixCase.name}-`));
    try { runMatrixCase(root, matrixCase); } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('conflict ledger migration adds restart states and evidence without touching pgboss', () => {
  const sql = fs.readFileSync(conflictMigrationPath, 'utf8');
  for (const state of ['conflicted', 'resolution_pending', 'aborted']) assert.match(sql, new RegExp(`'${state}'`));
  assert.match(sql, /ADD COLUMN IF NOT EXISTS conflict_evidence JSONB/);
  assert.match(sql, /conflicted.*resolution_pending.*aborted/s);
  assert.match(sql, /WHEN 'aborted' THEN FALSE/);
  assert.doesNotMatch(sql, /(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)[^;]*pgboss\./i);
});

test('unsupported gitlink conflict fails closed and dirty/stale targets never begin an apply', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-unsupported-conflict-'));
  try {
    const { repository } = createRepository(root);
    const base = git(repository, ['rev-parse', 'HEAD']);
    git(repository, ['commit', '--allow-empty', '-m', 'test: gitlink object one']);
    const objectOne = git(repository, ['rev-parse', 'HEAD']);
    git(repository, ['commit', '--allow-empty', '-m', 'test: gitlink object two']);
    const matrixBase = git(repository, ['rev-parse', 'HEAD']);
    git(repository, ['branch', 'source/unsupported', matrixBase]);
    git(repository, ['update-index', '--add', '--cacheinfo', `160000,${objectOne},vendor/module`]);
    git(repository, ['commit', '-m', 'test: target gitlink']);
    const targetHead = git(repository, ['rev-parse', 'HEAD']);
    git(repository, ['checkout', 'source/unsupported']);
    git(repository, ['update-index', '--add', '--cacheinfo', `160000,${matrixBase},vendor/module`]);
    git(repository, ['commit', '-m', 'test: source gitlink']);
    const sourceCommit = git(repository, ['rev-parse', 'HEAD']);
    git(repository, ['checkout', 'qualification/run']);
    const manifestPath = path.join(root, 'manifest.json');
    fs.writeFileSync(manifestPath, '{}\n');
    const contribution: WaveContributionIdentity = {
      runId: 910, waveIndex: 0, storyId: 'UNSUPPORTED', attempt: 1,
      sourceRef: 'refs/heads/source/unsupported', sourceCommit, sourceBaseCommit: matrixBase,
      expectedParentHead: targetHead, frozenManifestPath: manifestPath,
      frozenManifestHash: sha256(fs.readFileSync(manifestPath)),
    };
    const ledger = new WaveIntegrationLedger(repository);
    fs.writeFileSync(path.join(repository, 'dirty.tmp'), 'dirty\n');
    assert.throws(() => ledger.prepare(contribution), /not clean/);
    fs.unlinkSync(path.join(repository, 'dirty.tmp'));
    git(repository, ['commit', '--allow-empty', '-m', 'test: stale target']);
    assert.throws(() => ledger.prepare(contribution), /expected target head changed/);
    git(repository, ['reset', '--hard', targetHead]);
    ledger.prepare(contribution);
    assert.throws(() => ledger.integrate(contribution), /merge conflict aborted/);
    assert.equal(ledger.get(contribution)?.conflictEvidence?.conflictingFiles[0]?.kind, 'unsupported');
    git(repository, ['update-ref', '-d', 'refs/heads/source/unsupported', sourceCommit]);
    assert.equal(git(repository, ['for-each-ref', '--format=%(refname)', 'refs/heads/source/']), '');
    assertCleanInventory(repository);
    assert.equal(git(repository, ['rev-parse', 'unrelated/preserved']), base);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
