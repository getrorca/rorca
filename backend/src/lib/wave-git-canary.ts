/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import {
  cleanupOwnedStoryWorktree,
  createOwnedStoryWorktree,
  type StoryWorktreeOwnership,
} from './story-worktree-lifecycle';
import {
  deterministicWaveIntegrationOrder,
  WaveIntegrationLedger,
  type WaveContributionIdentity,
} from './wave-integration-protocol';
import {
  canonicalJson,
  MEASURED_EVIDENCE_AUTHORITY,
  type QualificationEvidenceAssertion,
} from './wave-qualification-evidence';
import {
  signWaveReleaseEvidence,
  verifyWaveReleaseEvidence,
  WAVE_RELEASE_EVIDENCE_SCHEMA,
  type WaveReleaseEvidenceAttestation,
} from './wave-release-readiness';

const execFileAsync = promisify(execFile);
const PARALLELISM = 2 as const;
const NAMESPACE = 'qrun_0123456789abcdef01234567';
const STORY_COUNT = 4;
const SAFE_ISSUER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;
const GIT_OID = /^[0-9a-f]{40,64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

const gitEnvironment = {
  PATH: process.env.PATH ?? '',
  HOME: os.tmpdir(),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Rorca Git Wave Canary',
  GIT_AUTHOR_EMAIL: 'wave-canary@rorca.invalid',
  GIT_COMMITTER_NAME: 'Rorca Git Wave Canary',
  GIT_COMMITTER_EMAIL: 'wave-canary@rorca.invalid',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
};

interface CanaryStory {
  storyId: string;
  expectedFile: string;
  waveIndex: 0;
  attempt: 1;
}

interface ExecutedCanaryStory extends CanaryStory {
  ownership: StoryWorktreeOwnership;
  sourceCommit: string;
}

export interface GitWorktreeSnapshot {
  baseHead: string;
  baseTree: string;
  materialRevision: string;
  materialTree: string;
  inventoryDigest: string;
  representedPathCount: number;
}

export interface GitWaveCanaryMeasurement {
  canaryId: string;
  workspaceId: string;
  sourceRevision: string;
  sourceTree: string;
  sourceMaterialRevision: string;
  sourceMaterialTree: string;
  sourceInventoryDigest: string;
  representedSourcePathCount: number;
  storyCount: 4;
  requestedParallelism: 2;
  effectiveParallelism: 2;
  maximumActiveStories: 2;
  baseRevision: string;
  storySourceRevisions: Record<string, string>;
  integrationOrder: string[];
  integrationRevisions: string[];
  finalRevision: string;
  sourceCommitCount: 4;
  mergeCommitCount: 4;
  integratedTransitionCount: 4;
  finalizationReceiptCount: 4;
  idempotentReplayCount: 4;
  replayAdditionalTransitionCount: 0;
  cleanTarget: true;
  remainingWorktreeCount: 1;
  remainingStoryRefCount: 0;
  temporaryRootRemoved: true;
  databaseExercised: false;
  queueExercised: false;
  productionEnableAvailable: false;
}

export interface GitWaveCanaryEvidence {
  assertion: QualificationEvidenceAssertion;
  measurement: GitWaveCanaryMeasurement;
}

export interface GitWaveCanaryReceipt {
  attestation: WaveReleaseEvidenceAttestation;
  authorization: string;
}

export interface GitWaveCanaryResult {
  evidence: GitWaveCanaryEvidence;
  receipt: GitWaveCanaryReceipt;
  evidencePath: string;
  receiptPath: string;
  evidenceDigest: string;
  evidenceFileDigest: string;
  receiptFileDigest: string;
}

export interface RunGitWaveCanaryInput {
  repositoryRoot: string;
  signingKey: string;
  issuer: string;
  workspaceId: string;
  artifactDirectory?: string;
  attestedAt?: string;
  afterArtifactPublished?: (paths: Readonly<{ evidencePath: string; receiptPath: string }>) => void;
}

const stories: CanaryStory[] = [
  { storyId: 'WPE-CANARY-A', expectedFile: 'canary-output/story-a.txt', waveIndex: 0, attempt: 1 },
  { storyId: 'WPE-CANARY-B', expectedFile: 'canary-output/story-b.txt', waveIndex: 0, attempt: 1 },
  { storyId: 'WPE-CANARY-C', expectedFile: 'canary-output/story-c.txt', waveIndex: 0, attempt: 1 },
  { storyId: 'WPE-CANARY-D', expectedFile: 'canary-output/story-d.txt', waveIndex: 0, attempt: 1 },
];

function sha256(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function rawSha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalGitPathManifest(paths: readonly Buffer[]): string {
  return canonicalJson({
    encoding: 'base64',
    paths: [...paths].sort(Buffer.compare).map(bytes => bytes.toString('base64')),
  });
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: gitEnvironment,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function gitAsync(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: gitEnvironment,
    encoding: 'utf8',
  });
  return stdout.trim();
}

export function captureGitWorktreeSnapshot(repositoryRoot: string): GitWorktreeSnapshot {
  const root = fs.realpathSync(repositoryRoot);
  const baseHead = git(root, ['rev-parse', 'HEAD']);
  const baseTree = git(root, ['rev-parse', 'HEAD^{tree}']);
  const commonDirectory = path.resolve(root, git(root, ['rev-parse', '--git-common-dir']));
  const alternateObjects = path.join(commonDirectory, 'objects');
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-wave-source-snapshot-'));
  const temporaryIndex = path.join(temporaryRoot, 'index');
  const temporaryObjects = path.join(temporaryRoot, 'objects');
  fs.mkdirSync(path.join(temporaryObjects, 'info'), { recursive: true, mode: 0o700 });
  const snapshotEnvironment = {
    ...gitEnvironment,
    GIT_INDEX_FILE: temporaryIndex,
    GIT_OBJECT_DIRECTORY: temporaryObjects,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: alternateObjects,
  };
  const snapshotGit = (args: string[], encoding: BufferEncoding | 'buffer' = 'utf8'): string | Buffer => execFileSync('git', args, {
    cwd: root,
    env: snapshotEnvironment,
    encoding: encoding === 'buffer' ? undefined : encoding,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const splitNulPaths = (bytes: Buffer): Buffer[] => {
    const paths: Buffer[] = [];
    let start = 0;
    for (let end = bytes.indexOf(0, start); end >= 0; end = bytes.indexOf(0, start)) {
      if (end > start) paths.push(Buffer.from(bytes.subarray(start, end)));
      start = end + 1;
    }
    if (start < bytes.length) paths.push(Buffer.from(bytes.subarray(start)));
    return paths;
  };
  const qualificationDirectory = Buffer.from('.rorca/qualification');
  const qualificationPrefix = Buffer.from('.rorca/qualification/');
  const isQualificationArtifact = (relative: Buffer): boolean => relative.equals(qualificationDirectory)
    || (relative.length > qualificationPrefix.length && relative.subarray(0, qualificationPrefix.length).equals(qualificationPrefix));
  const pathManifest = canonicalGitPathManifest;
  const nulPathSeparator = Buffer.alloc(1);
  const listRepresentedPaths = (): Buffer[] => {
    const tracked = splitNulPaths(execFileSync('git', ['ls-files', '--cached', '-z'], {
      cwd: root,
      env: gitEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
    const untracked = splitNulPaths(execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
      cwd: root,
      env: gitEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
    const unique = new Map<string, Buffer>();
    for (const relative of [...tracked, ...untracked.filter(candidate => !isQualificationArtifact(candidate))]) {
      try {
        fs.lstatSync(Buffer.concat([Buffer.from(`${root}${path.sep}`), relative]));
        unique.set(relative.toString('base64'), relative);
      } catch {
        // Missing tracked paths are exact worktree deletions and stay absent.
      }
    }
    return [...unique.values()].sort(Buffer.compare);
  };
  const stageRepresentedPaths = (representedPaths: readonly Buffer[]): void => {
    snapshotGit(['read-tree', '--empty']);
    const input = Buffer.concat(representedPaths.flatMap(relative => [relative, nulPathSeparator]));
    execFileSync('git', ['update-index', '--add', '--remove', '-z', '--stdin'], {
      cwd: root,
      env: snapshotEnvironment,
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  };

  try {
    const representedPaths = listRepresentedPaths();
    stageRepresentedPaths(representedPaths);
    const firstTree = String(snapshotGit(['write-tree'])).trim();
    const firstInventory = snapshotGit(['ls-files', '--stage', '-z'], 'buffer') as Buffer;
    const secondRepresentedPaths = listRepresentedPaths();
    stageRepresentedPaths(secondRepresentedPaths);
    const secondTree = String(snapshotGit(['write-tree'])).trim();
    const secondInventory = snapshotGit(['ls-files', '--stage', '-z'], 'buffer') as Buffer;
    if (
      pathManifest(representedPaths) !== pathManifest(secondRepresentedPaths)
      || firstTree !== secondTree
      || !firstInventory.equals(secondInventory)
    ) {
      throw new Error('[wave-git-canary] source worktree changed while its immutable snapshot was captured');
    }
    try {
      snapshotGit(['diff-files', '--quiet']);
    } catch {
      throw new Error('[wave-git-canary] source worktree changed after its immutable snapshot was staged');
    }

    const indexedPaths = splitNulPaths(snapshotGit(['ls-files', '--cached', '-z'], 'buffer') as Buffer)
      .sort(Buffer.compare);
    if (
      pathManifest(indexedPaths) !== pathManifest(representedPaths)
      || pathManifest(listRepresentedPaths()) !== pathManifest(representedPaths)
    ) {
      throw new Error('[wave-git-canary] immutable source snapshot omitted or added a non-ignored worktree path');
    }
    const materialRevision = String(snapshotGit([
      'commit-tree',
      secondTree,
      '-p',
      baseHead,
      '-m',
      'chore(canary): immutable worktree source snapshot',
    ])).trim();
    if (![baseHead, baseTree, materialRevision, secondTree].every(value => GIT_OID.test(value))) {
      throw new Error('[wave-git-canary] immutable source snapshot identity is malformed');
    }
    return {
      baseHead,
      baseTree,
      materialRevision,
      materialTree: secondTree,
      inventoryDigest: sha256(secondInventory),
      representedPathCount: indexedPaths.length,
    };
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function createRepository(root: string): { repository: string; baseRevision: string } {
  const repository = path.join(root, 'repository');
  fs.mkdirSync(repository, { mode: 0o700 });
  git(repository, ['init', '--initial-branch=canary/main']);
  fs.writeFileSync(path.join(repository, 'README.md'), 'isolated real Git wave canary\n', { mode: 0o600 });
  git(repository, ['add', 'README.md']);
  git(repository, ['commit', '-m', 'chore(canary): establish isolated base']);
  return { repository, baseRevision: git(repository, ['rev-parse', 'HEAD']) };
}

async function executeContributions(
  repository: string,
  root: string,
  baseRevision: string,
): Promise<ExecutedCanaryStory[]> {
  const worktreeRoot = path.join(root, 'worktrees');
  fs.mkdirSync(worktreeRoot, { mode: 0o700 });
  const ownerships = stories.map(story => ({
    story,
    ownership: createOwnedStoryWorktree({
      repositoryPath: repository,
      worktreePath: path.join(worktreeRoot, story.storyId),
      branchName: `qualification/${NAMESPACE}/${story.storyId}/attempt-1`,
      runId: 1,
      waveIndex: story.waveIndex,
      storyId: story.storyId,
      attempt: story.attempt,
      baseRevision,
      qualificationNamespace: NAMESPACE,
    }),
  }));

  let cursor = 0;
  let active = 0;
  let maximumActiveStories = 0;
  const output: ExecutedCanaryStory[] = [];
  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= ownerships.length) return;
      const { story, ownership } = ownerships[index];
      active += 1;
      maximumActiveStories = Math.max(maximumActiveStories, active);
      try {
        const absolute = path.join(ownership.worktreeRealpath, story.expectedFile);
        fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
        fs.writeFileSync(absolute, `${story.storyId}\n`, { mode: 0o600 });
        await gitAsync(ownership.worktreeRealpath, ['add', story.expectedFile]);
        await gitAsync(ownership.worktreeRealpath, ['commit', '-m', `feat(canary): ${story.storyId}`]);
        const sourceCommit = await gitAsync(ownership.worktreeRealpath, ['rev-parse', 'HEAD']);
        assert.notEqual(sourceCommit, baseRevision);
        assert.deepEqual(
          (await gitAsync(ownership.worktreeRealpath, ['diff-tree', '--no-commit-id', '--name-only', '-r', sourceCommit])).split('\n'),
          [story.expectedFile],
        );
        output[index] = { ...story, ownership, sourceCommit };
      } finally {
        active -= 1;
      }
    }
  }
  await Promise.all(Array.from({ length: PARALLELISM }, () => worker()));
  assert.equal(output.length, STORY_COUNT);
  assert.equal(maximumActiveStories, PARALLELISM, 'the canary did not exercise parallelism exactly two');
  return output;
}

function durableFinalize(root: string, storyId: string, idempotencyKey: string, revision: string) {
  const directory = path.join(root, 'finalization-receipts');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const body = canonicalJson({ idempotencyKey, revision, storyId });
  const receiptPath = path.join(directory, `${storyId}.json`);
  fs.writeFileSync(receiptPath, body, { flag: 'wx', mode: 0o600 });
  return { idempotencyKey, revision, receiptHash: rawSha256(body) };
}

async function measureGitWave(
  canaryId: string,
  workspaceId: string,
  sourceSnapshot: GitWorktreeSnapshot,
): Promise<GitWaveCanaryMeasurement> {
  const { baseHead, baseTree, materialRevision, materialTree, inventoryDigest, representedPathCount } = sourceSnapshot;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-real-git-wave-canary-'));
  let measured: Omit<GitWaveCanaryMeasurement, 'temporaryRootRemoved'> | undefined;
  try {
    const { repository, baseRevision } = createRepository(root);
    const manifestPath = path.join(root, 'frozen-manifest.json');
    fs.writeFileSync(manifestPath, canonicalJson({ parallelism: PARALLELISM, stories }), { mode: 0o600 });
    const manifestHash = rawSha256(fs.readFileSync(manifestPath));
    const executed = await executeContributions(repository, root, baseRevision);
    const integrationOrder = deterministicWaveIntegrationOrder(executed);
    assert.deepEqual(integrationOrder.map(story => story.storyId), stories.map(story => story.storyId));

    const ledger = new WaveIntegrationLedger(repository);
    const integrationRevisions: string[] = [];
    let expectedParentHead = baseRevision;
    let integratedTransitionCount = 0;
    let finalizationReceiptCount = 0;
    let idempotentReplayCount = 0;
    let replayAdditionalTransitionCount = 0;

    for (const story of integrationOrder) {
      const identity: WaveContributionIdentity = {
        runId: 1,
        waveIndex: story.waveIndex,
        storyId: story.storyId,
        attempt: story.attempt,
        sourceRef: `refs/heads/${story.ownership.branchName}`,
        sourceCommit: story.sourceCommit,
        sourceBaseCommit: baseRevision,
        expectedParentHead,
        frozenManifestPath: manifestPath,
        frozenManifestHash: manifestHash,
      };
      const prepared = ledger.prepare(identity);
      assert.equal(prepared.state, 'prepared');
      assert.equal(ledger.prepare(identity).transitions.length, prepared.transitions.length);
      let record = ledger.integrate(identity);
      assert.equal(record.state, 'integrated');
      assert.equal(git(repository, ['show', '-s', '--format=%P', record.resultingHead!]).split(' ')[1], story.sourceCommit);
      integratedTransitionCount += record.transitions.filter(transition => transition.state === 'integrated').length;
      const revision = record.resultingHead!;
      const validation = {
        validator: 'isolated-real-git-wave-canary-v1',
        revision,
        treeHash: git(repository, ['rev-parse', 'HEAD^{tree}']),
        contractHash: rawSha256('git-fsck\ngit-diff-tree-check\nclean-target\n'),
      };
      execFileSync('git', ['fsck', '--no-dangling'], { cwd: repository, env: gitEnvironment, stdio: 'ignore' });
      execFileSync('git', ['diff-tree', '--check', 'HEAD'], { cwd: repository, env: gitEnvironment, stdio: 'ignore' });
      record = ledger.markIntegratedValidated(identity, validation);
      record = ledger.finalize(identity, (idempotencyKey, finalizedRevision) => {
        finalizationReceiptCount += 1;
        return durableFinalize(root, story.storyId, idempotencyKey, finalizedRevision);
      });
      assert.equal(record.state, 'finalized');
      const beforeReplay = record.transitions.length;
      record = ledger.integrate(identity);
      record = ledger.markIntegratedValidated(identity, validation);
      record = ledger.finalize(identity, () => { throw new Error('idempotent replay repeated finalization'); });
      idempotentReplayCount += 1;
      replayAdditionalTransitionCount += record.transitions.length - beforeReplay;
      integrationRevisions.push(revision);
      expectedParentHead = revision;
    }

    const allowlist = new Set(integrationOrder.map(story => story.ownership.ownershipId));
    for (const story of integrationOrder) {
      const cleanup = cleanupOwnedStoryWorktree({
        repositoryPath: repository,
        ownership: story.ownership,
        currentWaveAllowlist: allowlist,
        expectedBaseRevision: baseRevision,
        preserve: false,
        outcome: 'integrated',
      });
      assert.equal(cleanup.ok, true);
      assert.equal(cleanup.removed, true);
    }

    const finalRevision = git(repository, ['rev-parse', 'HEAD']);
    const status = git(repository, ['status', '--porcelain=v1', '--untracked-files=all']);
    const remainingWorktreeCount = git(repository, ['worktree', 'list', '--porcelain']).split('\n\n').filter(Boolean).length;
    const storyRefs = git(repository, ['for-each-ref', '--format=%(refname)', `refs/heads/qualification/${NAMESPACE}/`]);
    const remainingStoryRefCount = storyRefs ? storyRefs.split('\n').length : 0;
    const mergeCommitCount = Number(git(repository, ['rev-list', '--first-parent', '--merges', '--count', `${baseRevision}..${finalRevision}`]));
    const sourceCommitCount = integrationOrder.filter(story => git(repository, ['merge-base', '--is-ancestor', story.sourceCommit, finalRevision]) === '').length;

    assert.equal(status, '');
    assert.equal(remainingWorktreeCount, 1);
    assert.equal(remainingStoryRefCount, 0);
    assert.equal(mergeCommitCount, STORY_COUNT);
    assert.equal(sourceCommitCount, STORY_COUNT);
    assert.equal(integratedTransitionCount, STORY_COUNT);
    assert.equal(finalizationReceiptCount, STORY_COUNT);
    assert.equal(idempotentReplayCount, STORY_COUNT);
    assert.equal(replayAdditionalTransitionCount, 0);

    measured = {
      canaryId,
      workspaceId,
      sourceRevision: baseHead,
      sourceTree: baseTree,
      sourceMaterialRevision: materialRevision,
      sourceMaterialTree: materialTree,
      sourceInventoryDigest: inventoryDigest,
      representedSourcePathCount: representedPathCount,
      storyCount: STORY_COUNT,
      requestedParallelism: PARALLELISM,
      effectiveParallelism: PARALLELISM,
      maximumActiveStories: PARALLELISM,
      baseRevision,
      storySourceRevisions: Object.fromEntries(integrationOrder.map(story => [story.storyId, story.sourceCommit])),
      integrationOrder: integrationOrder.map(story => story.storyId),
      integrationRevisions,
      finalRevision,
      sourceCommitCount: STORY_COUNT,
      mergeCommitCount: STORY_COUNT,
      integratedTransitionCount: STORY_COUNT,
      finalizationReceiptCount: STORY_COUNT,
      idempotentReplayCount: STORY_COUNT,
      replayAdditionalTransitionCount: 0,
      cleanTarget: true,
      remainingWorktreeCount: 1,
      remainingStoryRefCount: 0,
      databaseExercised: false,
      queueExercised: false,
      productionEnableAvailable: false,
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.equal(fs.existsSync(root), false, 'isolated canary root survived cleanup');
  if (!measured) throw new Error('[wave-git-canary] measurement did not complete');
  return { ...measured, temporaryRootRemoved: true };
}

function verifyEvidence(evidence: GitWaveCanaryEvidence, expectedSourceRevision: string): void {
  const { assertion, measurement } = evidence;
  assert.deepEqual(Object.keys(evidence).sort(), ['assertion', 'measurement']);
  assert.equal(assertion.evidenceClass, 'canary_soak');
  assert.equal(assertion.authority, MEASURED_EVIDENCE_AUTHORITY);
  assert.equal(assertion.durable, true);
  assert.equal(assertion.verdict, 'passed');
  assert.equal(assertion.sourceRevision, expectedSourceRevision);
  assert.equal(assertion.sourceDigest, sha256(canonicalJson(measurement)));
  assert.equal(measurement.sourceRevision, expectedSourceRevision);
  assert.match(measurement.sourceTree, GIT_OID);
  assert.match(measurement.sourceMaterialRevision, GIT_OID);
  assert.match(measurement.sourceMaterialTree, GIT_OID);
  assert.match(measurement.sourceInventoryDigest, DIGEST);
  assert.match(measurement.workspaceId, SAFE_ISSUER);
  assert.ok(Number.isSafeInteger(measurement.representedSourcePathCount) && measurement.representedSourcePathCount > 0);
  assert.equal(measurement.storyCount, STORY_COUNT);
  assert.equal(measurement.requestedParallelism, PARALLELISM);
  assert.equal(measurement.effectiveParallelism, PARALLELISM);
  assert.equal(measurement.maximumActiveStories, PARALLELISM);
  assert.deepEqual(measurement.integrationOrder, stories.map(story => story.storyId));
  assert.equal(new Set(measurement.storySourceRevisions ? Object.values(measurement.storySourceRevisions) : []).size, STORY_COUNT);
  assert.equal(new Set(measurement.integrationRevisions).size, STORY_COUNT);
  assert.equal(measurement.sourceCommitCount, STORY_COUNT);
  assert.equal(measurement.mergeCommitCount, STORY_COUNT);
  assert.equal(measurement.integratedTransitionCount, STORY_COUNT);
  assert.equal(measurement.finalizationReceiptCount, STORY_COUNT);
  assert.equal(measurement.idempotentReplayCount, STORY_COUNT);
  assert.equal(measurement.replayAdditionalTransitionCount, 0);
  assert.equal(measurement.cleanTarget, true);
  assert.equal(measurement.remainingWorktreeCount, 1);
  assert.equal(measurement.remainingStoryRefCount, 0);
  assert.equal(measurement.temporaryRootRemoved, true);
  assert.equal(measurement.databaseExercised, false);
  assert.equal(measurement.queueExercised, false);
  assert.equal(measurement.productionEnableAvailable, false);
}

function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('[wave-git-canary] artifact directory is unsafe');
  fs.chmodSync(directory, 0o700);
}

function atomicWritePrivate(destination: string, content: string): void {
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, destination);
    fs.chmodSync(destination, 0o600);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function removePublishedArtifactSet(artifactDirectory: string, destinationDirectory: string): void {
  fs.rmSync(destinationDirectory, { recursive: true, force: true });
  fsyncDirectory(artifactDirectory);
}

function atomicPersistArtifactSet(
  artifactDirectory: string,
  basename: string,
  evidenceBytes: string,
  receiptBytes: string,
): { evidencePath: string; receiptPath: string } {
  const stagingDirectory = path.join(artifactDirectory, `.${basename}.${process.pid}.tmp`);
  const destinationDirectory = path.join(artifactDirectory, basename);
  let renamed = false;
  try {
    fs.mkdirSync(stagingDirectory, { mode: 0o700 });
    atomicWritePrivate(path.join(stagingDirectory, 'evidence.json'), evidenceBytes);
    atomicWritePrivate(path.join(stagingDirectory, 'receipt.json'), receiptBytes);
    fsyncDirectory(stagingDirectory);
    fs.renameSync(stagingDirectory, destinationDirectory);
    renamed = true;
    fsyncDirectory(artifactDirectory);
    return {
      evidencePath: path.join(destinationDirectory, 'evidence.json'),
      receiptPath: path.join(destinationDirectory, 'receipt.json'),
    };
  } catch (error) {
    if (renamed) removePublishedArtifactSet(artifactDirectory, destinationDirectory);
    throw error;
  } finally {
    fs.rmSync(stagingDirectory, { recursive: true, force: true });
  }
}

export function verifyPersistedGitWaveCanaryArtifacts(input: {
  evidencePath: string;
  receiptPath: string;
  signingKey: string;
  expectedSourceRevision: string;
  expectedIssuer: string;
  expectedWorkspaceId: string;
}): { evidence: GitWaveCanaryEvidence; receipt: GitWaveCanaryReceipt } {
  const evidence = JSON.parse(fs.readFileSync(input.evidencePath, 'utf8')) as GitWaveCanaryEvidence;
  const receipt = JSON.parse(fs.readFileSync(input.receiptPath, 'utf8')) as GitWaveCanaryReceipt;
  verifyEvidence(evidence, input.expectedSourceRevision);
  assert.deepEqual(Object.keys(receipt).sort(), ['attestation', 'authorization']);
  assert.equal(receipt.attestation.digest, evidence.assertion.sourceDigest);
  assert.equal(receipt.attestation.sourceRevision, input.expectedSourceRevision);
  assert.equal(receipt.attestation.kind, 'canary');
  assert.equal(receipt.attestation.workspaceId, input.expectedWorkspaceId);
  assert.equal(receipt.attestation.operatorId, input.expectedIssuer);
  assert.equal(receipt.attestation.subjectId, evidence.assertion.id);
  assert.deepEqual(verifyWaveReleaseEvidence({
    attestation: receipt.attestation,
    authorization: receipt.authorization,
    trustedKey: input.signingKey,
  }), receipt.attestation);
  return { evidence, receipt };
}

export async function runGitWaveCanary(input: RunGitWaveCanaryInput): Promise<GitWaveCanaryResult> {
  if (Buffer.byteLength(input.signingKey) < 32) throw new Error('[wave-git-canary] signing key must be at least 32 bytes');
  if (!SAFE_ISSUER.test(input.issuer)) throw new Error('[wave-git-canary] issuer is malformed');
  if (!SAFE_ISSUER.test(input.workspaceId)) throw new Error('[wave-git-canary] workspace ID is malformed');
  const repositoryRoot = fs.realpathSync(input.repositoryRoot);
  const sourceSnapshot = captureGitWorktreeSnapshot(repositoryRoot);
  const sourceRevision = sourceSnapshot.baseHead;
  const attestedAt = input.attestedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(attestedAt))) throw new Error('[wave-git-canary] attestation time is invalid');
  const canaryId = `git-wave-${randomUUID()}`;
  const measurement = await measureGitWave(canaryId, input.workspaceId, sourceSnapshot);
  const postCanarySnapshot = captureGitWorktreeSnapshot(repositoryRoot);
  if (canonicalJson(postCanarySnapshot) !== canonicalJson(sourceSnapshot)) {
    throw new Error('[wave-git-canary] source worktree changed while the canary was executing');
  }
  const assertion: QualificationEvidenceAssertion = {
    id: 'WPE-A-012-R06-NONPRODUCTION-CANARY-AND-BOUNDED-SOAK',
    invariantId: 'WPE-INV-007',
    scenarioId: 'WPE-Q-REAL-GIT-WAVE-CANARY',
    evidenceClass: 'canary_soak',
    verdict: 'passed',
    sourceDigest: sha256(canonicalJson(measurement)),
    sourceRevision,
    authority: MEASURED_EVIDENCE_AUTHORITY,
    durable: true,
    assertionCode: 'isolated-four-story-parallelism-two-git-wave-validated',
  };
  const evidence: GitWaveCanaryEvidence = { assertion, measurement };
  verifyEvidence(evidence, sourceRevision);

  const attestation: WaveReleaseEvidenceAttestation = {
    schemaVersion: WAVE_RELEASE_EVIDENCE_SCHEMA,
    workspaceId: input.workspaceId,
    digest: assertion.sourceDigest,
    sourceRevision,
    kind: 'canary',
    subjectId: assertion.id,
    operatorId: input.issuer,
    attestedAt,
  };
  const receipt: GitWaveCanaryReceipt = {
    attestation,
    authorization: signWaveReleaseEvidence(attestation, input.signingKey),
  };
  verifyWaveReleaseEvidence({ attestation, authorization: receipt.authorization, trustedKey: input.signingKey });

  const artifactDirectory = path.resolve(input.artifactDirectory ?? path.join(repositoryRoot, '.rorca', 'qualification'));
  ensurePrivateDirectory(artifactDirectory);
  const basename = `real-git-wave-canary-${sourceRevision}-${canaryId.slice('git-wave-'.length)}`;
  let publishedPaths: { evidencePath: string; receiptPath: string } | undefined;
  try {
    publishedPaths = atomicPersistArtifactSet(
      artifactDirectory,
      basename,
      canonicalJson(evidence),
      canonicalJson(receipt),
    );
    input.afterArtifactPublished?.(publishedPaths);
    verifyPersistedGitWaveCanaryArtifacts({
      ...publishedPaths,
      signingKey: input.signingKey,
      expectedSourceRevision: sourceRevision,
      expectedIssuer: input.issuer,
      expectedWorkspaceId: input.workspaceId,
    });

    const evidenceFileDigest = sha256(fs.readFileSync(publishedPaths.evidencePath));
    const receiptFileDigest = sha256(fs.readFileSync(publishedPaths.receiptPath));
    if (!DIGEST.test(evidenceFileDigest) || !DIGEST.test(receiptFileDigest)) throw new Error('[wave-git-canary] artifact digest is malformed');
    const finalSourceSnapshot = captureGitWorktreeSnapshot(repositoryRoot);
    if (canonicalJson(finalSourceSnapshot) !== canonicalJson(sourceSnapshot)) {
      throw new Error('[wave-git-canary] source worktree changed while durable canary artifacts were published');
    }
    return {
      evidence,
      receipt,
      ...publishedPaths,
      evidenceDigest: assertion.sourceDigest,
      evidenceFileDigest,
      receiptFileDigest,
    };
  } catch (error) {
    if (publishedPaths) removePublishedArtifactSet(artifactDirectory, path.dirname(publishedPaths.evidencePath));
    throw error;
  }
}
