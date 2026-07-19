/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  assertExpectedParentHead,
  assertSingletonRunWorktree,
  cleanupOwnedStoryWorktree,
  commitGuardedMerge,
  createOwnedStoryWorktree,
  verifyOwnedStoryWorktree,
  type StoryWorktreeOwnership,
} from '../story-worktree-lifecycle';

const gitEnvironment = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Rorca Lifecycle Test',
  GIT_AUTHOR_EMAIL: 'lifecycle@rorca.invalid',
  GIT_COMMITTER_NAME: 'Rorca Lifecycle Test',
  GIT_COMMITTER_EMAIL: 'lifecycle@rorca.invalid',
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: gitEnvironment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

interface RepositoryInventory {
  worktrees: Array<{ path: string; head: string; branch: string; status: string }>;
  refs: Record<string, string>;
  activeOperations: string[];
  commits: string[];
}

function inventory(repository: string): RepositoryInventory {
  const commonRaw = git(repository, ['rev-parse', '--git-common-dir']);
  const common = fs.realpathSync(path.resolve(repository, commonRaw));
  const records = git(repository, ['worktree', 'list', '--porcelain']).split(/\n\n+/).filter(Boolean);
  const worktrees = records.map(record => {
    const lines = record.split('\n');
    const worktreePath = lines.find(line => line.startsWith('worktree '))!.slice(9);
    return {
      path: fs.realpathSync(worktreePath),
      head: lines.find(line => line.startsWith('HEAD '))!.slice(5),
      branch: lines.find(line => line.startsWith('branch '))?.slice(7) ?? 'detached',
      status: git(worktreePath, ['status', '--porcelain=v1', '--untracked-files=all']),
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const refs = Object.fromEntries(git(repository, ['for-each-ref', '--format=%(refname) %(objectname)'])
    .split('\n').filter(Boolean).map(line => {
      const separator = line.indexOf(' ');
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
  const activeOperations = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD']
    .filter(name => fs.existsSync(path.join(common, name)));
  const commits = git(repository, ['rev-list', '--all', '--topo-order']).split('\n').filter(Boolean);
  return { worktrees, refs, activeOperations, commits };
}

function createRepository(): { root: string; repository: string; base: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-owned-worktree-'));
  const repository = path.join(root, 'repository');
  fs.mkdirSync(repository);
  git(repository, ['init', '--initial-branch=run']);
  git(repository, ['config', 'user.name', 'Rorca Lifecycle Test']);
  git(repository, ['config', 'user.email', 'lifecycle@rorca.invalid']);
  fs.writeFileSync(path.join(repository, 'README.md'), 'base\n');
  fs.writeFileSync(path.join(repository, '.gitignore'), '*.ignored\n');
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'base']);
  return { root, repository, base: git(repository, ['rev-parse', 'HEAD']) };
}

function owned(repository: string, root: string, base: string, suffix = 'one'): StoryWorktreeOwnership {
  return createOwnedStoryWorktree({
    repositoryPath: repository,
    worktreePath: path.join(root, `story-${suffix}`),
    branchName: `rorca/tmp/run-91/wave-2/STORY-${suffix}/attempt-3`,
    runId: 91,
    waveIndex: 2,
    storyId: `STORY-${suffix}`,
    attempt: 3,
    baseRevision: base,
    qualificationNamespace: 'qrun_0123456789abcdef01234567',
  });
}

function dispose(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

test('owned lifecycle records complete metadata and removes only the integrated temporary resources', () => {
  const { root, repository, base } = createRepository();
  try {
    const unrelatedPath = path.join(root, 'unrelated');
    git(repository, ['worktree', 'add', '-b', 'unrelated/pre-existing', unrelatedPath, base]);
    fs.writeFileSync(path.join(unrelatedPath, 'sentinel.bin'), Buffer.from([0, 1, 2, 255]));
    const unrelatedBefore = inventory(repository);
    const ownership = owned(repository, root, base);
    const metadata = JSON.parse(fs.readFileSync(ownership.metadataPath, 'utf8')) as StoryWorktreeOwnership;

    assert.equal(metadata.runId, 91);
    assert.equal(metadata.waveIndex, 2);
    assert.equal(metadata.storyId, 'STORY-one');
    assert.equal(metadata.attempt, 3);
    assert.equal(metadata.baseRevision, base);
    assert.equal(metadata.repositoryCommonDirectory, fs.realpathSync(path.join(repository, '.git')));
    assert.equal(metadata.qualificationNamespace, 'qrun_0123456789abcdef01234567');
    verifyOwnedStoryWorktree(repository, ownership, new Set([ownership.ownershipId]), base);

    fs.writeFileSync(path.join(ownership.worktreeRealpath, 'accepted.txt'), 'accepted\n');
    git(ownership.worktreeRealpath, ['add', 'accepted.txt']);
    git(ownership.worktreeRealpath, ['commit', '-m', 'accepted story']);
    const expectedParent = git(repository, ['rev-parse', 'HEAD']);
    assertExpectedParentHead(repository, expectedParent);
    git(repository, ['merge', '--no-ff', '--no-commit', ownership.branchName]);
    const acceptedRunHead = commitGuardedMerge(repository, 'merge accepted story', expectedParent);
    assert.equal(git(repository, ['rev-parse', 'HEAD^1']), expectedParent);

    const result = cleanupOwnedStoryWorktree({
      repositoryPath: repository,
      ownership,
      currentWaveAllowlist: new Set([ownership.ownershipId]),
      expectedBaseRevision: base,
      preserve: false,
      outcome: 'integrated',
    });
    assert.equal(result.ok, true);
    assert.equal(result.removed, true);
    assert.equal(fs.existsSync(ownership.worktreeRealpath), false);
    assert.throws(() => git(repository, ['rev-parse', '--verify', `refs/heads/${ownership.branchName}`]));

    const after = inventory(repository);
    assert.equal(after.refs['refs/heads/unrelated/pre-existing'], unrelatedBefore.refs['refs/heads/unrelated/pre-existing']);
    assert.deepEqual(after.worktrees.find(item => item.branch.endsWith('unrelated/pre-existing')),
      unrelatedBefore.worktrees.find(item => item.branch.endsWith('unrelated/pre-existing')));
    assert.deepEqual(fs.readFileSync(path.join(unrelatedPath, 'sentinel.bin')), Buffer.from([0, 1, 2, 255]));
    assert.deepEqual(after.activeOperations, []);
    assert.ok(after.commits.includes(acceptedRunHead), 'accepted run history disappeared');
  } finally { dispose(root); }
});

test('rejected committed and dirty work receives immutable scoped recovery artifacts and cleanup is idempotent', () => {
  const { root, repository, base } = createRepository();
  try {
    const before = inventory(repository);
    const ownership = owned(repository, root, base, 'rejected');
    fs.writeFileSync(path.join(ownership.worktreeRealpath, 'committed.txt'), 'committed\n');
    git(ownership.worktreeRealpath, ['add', 'committed.txt']);
    git(ownership.worktreeRealpath, ['commit', '-m', 'rejected commit']);
    const rejectedHead = git(ownership.worktreeRealpath, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(ownership.worktreeRealpath, 'dirty.txt'), 'safe untracked payload\n');
    fs.writeFileSync(path.join(ownership.worktreeRealpath, 'excluded.ignored'), 'must not be captured\n');

    const result = cleanupOwnedStoryWorktree({
      repositoryPath: repository,
      ownership,
      currentWaveAllowlist: new Set([ownership.ownershipId]),
      expectedBaseRevision: base,
      preserve: false,
      outcome: 'rejected',
    });
    assert.equal(result.ok, true);
    assert.equal(result.removed, true);
    assert.match(result.recoveryRef!, /^refs\/heads\/rorca\/recovery\/run-91\/wave-2\/STORY-rejected\/attempt-3\/[a-f0-9]{20}$/);
    assert.equal(git(repository, ['rev-parse', result.recoveryRef!]), rejectedHead);
    const snapshot = fs.readFileSync(result.snapshotPath!, 'utf8');
    assert.match(snapshot, /dirty\.txt/);
    assert.doesNotMatch(snapshot, /excluded\.ignored|must not be captured/);
    const recovered = inventory(repository);
    assert.deepEqual(recovered.worktrees, before.worktrees);
    assert.deepEqual(recovered.activeOperations, before.activeOperations);
    for (const [ref, oid] of Object.entries(before.refs)) assert.equal(recovered.refs[ref], oid);
    assert.deepEqual(
      Object.keys(recovered.refs).filter(ref => !(ref in before.refs)),
      [result.recoveryRef],
      'every additional ref must be an identified recovery artifact',
    );
    assert.deepEqual(recovered.commits.filter(commit => !before.commits.includes(commit)), [rejectedHead]);

    // Simulate a later unrelated actor reusing the old name. Restart cleanup must
    // trust its receipt and never delete the newly created ref.
    git(repository, ['branch', ownership.branchName, base]);
    const reusedHead = git(repository, ['rev-parse', ownership.branchName]);
    const repeated = cleanupOwnedStoryWorktree({
      repositoryPath: repository,
      ownership,
      currentWaveAllowlist: new Set([ownership.ownershipId]),
      expectedBaseRevision: base,
      preserve: false,
      outcome: 'rejected',
    });
    assert.equal(repeated.alreadyCleaned, true);
    assert.equal(git(repository, ['rev-parse', ownership.branchName]), reusedHead);
    assert.equal(git(repository, ['rev-parse', result.recoveryRef!]), rejectedHead);
  } finally { dispose(root); }
});

test('secret-bearing dirty state and preserve decisions retain the worktree with bounded redacted evidence', () => {
  const { root, repository, base } = createRepository();
  try {
    const before = inventory(repository);
    const ownership = owned(repository, root, base, 'secret');
    fs.writeFileSync(path.join(ownership.worktreeRealpath, 'credentials'), 'password=not-safe-to-copy\n');
    const result = cleanupOwnedStoryWorktree({
      repositoryPath: repository,
      ownership,
      currentWaveAllowlist: new Set([ownership.ownershipId]),
      expectedBaseRevision: base,
      preserve: false,
      outcome: 'rejected',
    });
    assert.equal(result.ok, false);
    assert.equal(result.preserved, true);
    assert.equal(fs.existsSync(ownership.worktreeRealpath), true);
    assert.ok(result.diagnostics.join('').length <= 512);
    assert.doesNotMatch(result.diagnostics.join(' '), /not-safe-to-copy/);
    const afterFallback = inventory(repository);
    for (const [ref, oid] of Object.entries(before.refs)) assert.equal(afterFallback.refs[ref], oid);
    assert.deepEqual(afterFallback.activeOperations, before.activeOperations);
    assert.equal(afterFallback.worktrees.length, before.worktrees.length + 1);
    assert.ok(afterFallback.worktrees.some(item => item.path === ownership.worktreeRealpath));
    assert.equal(afterFallback.refs[`refs/heads/${ownership.branchName}`], base);

    const preserve = cleanupOwnedStoryWorktree({
      repositoryPath: repository,
      ownership,
      currentWaveAllowlist: new Set(),
      expectedBaseRevision: 'not-a-revision',
      preserve: true,
      outcome: 'rejected',
    });
    assert.equal(preserve.ok, true);
    assert.equal(preserve.preserved, true);
    assert.equal(fs.existsSync(ownership.worktreeRealpath), true);
  } finally { dispose(root); }
});

test('singleton selection creates no isolation resources and rejects a frozen alternate directory', () => {
  const { root, repository } = createRepository();
  try {
    const before = inventory(repository);
    assertSingletonRunWorktree(repository, {
      enabled: false,
      path: null,
      guardedWorkingDirectory: repository,
    });
    assert.deepEqual(inventory(repository), before);
    assert.throws(() => assertSingletonRunWorktree(repository, {
      enabled: true,
      path: path.join(root, 'required-story-worktree'),
      guardedWorkingDirectory: path.join(root, 'required-story-worktree'),
    }), /requires another/);
    assert.deepEqual(inventory(repository), before);
  } finally { dispose(root); }
});

test('tampered metadata, wrong allowlist/base, and concurrently advanced parent fail closed', () => {
  const { root, repository, base } = createRepository();
  try {
    const ownership = owned(repository, root, base, 'guard');
    assert.throws(() => verifyOwnedStoryWorktree(repository, ownership, new Set(), base), /not allowlisted/);
    assert.throws(() => verifyOwnedStoryWorktree(repository, ownership, new Set([ownership.ownershipId]), 'HEAD~1'), /rev-parse|unknown revision/i);

    const expectedParent = git(repository, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(repository, 'advance.txt'), 'advance\n');
    git(repository, ['add', 'advance.txt']);
    git(repository, ['commit', '-m', 'concurrent advance']);
    assert.throws(() => assertExpectedParentHead(repository, expectedParent), /advanced concurrently/);

    const metadata = fs.readFileSync(ownership.metadataPath, 'utf8');
    fs.writeFileSync(ownership.metadataPath, metadata.replace('STORY-guard', 'STORY-tampered'));
    const cleanup = cleanupOwnedStoryWorktree({
      repositoryPath: repository,
      ownership,
      currentWaveAllowlist: new Set([ownership.ownershipId]),
      expectedBaseRevision: base,
      preserve: false,
      outcome: 'rejected',
    });
    assert.equal(cleanup.ok, false);
    assert.equal(cleanup.preserved, true);
    assert.equal(fs.existsSync(ownership.worktreeRealpath), true);
  } finally { dispose(root); }
});
