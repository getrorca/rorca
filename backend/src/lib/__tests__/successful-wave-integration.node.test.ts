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
import {
  DeterministicFixtureHarness,
  recordFixtureHostPhase,
  type FixtureExecutionEvidence,
} from '../../test-helpers/deterministic-fixture-agent';
import {
  cleanupOwnedStoryWorktree,
  commitGuardedMerge,
  createOwnedStoryWorktree,
  type StoryWorktreeOwnership,
} from '../story-worktree-lifecycle';
import {
  deterministicWaveIntegrationOrder,
  waveIntegrationLedgerKey,
  WaveIntegrationLedger,
  type WaveContributionIdentity,
  type WaveIntegrationRecord,
} from '../wave-integration-protocol';

const checkerPath = path.resolve(process.cwd(), 'backend', 'src', '__tests__', 'fixtures', 'independent-wave-trace-checker.mjs');
const migrationPath = path.resolve(process.cwd(), 'backend', 'src', 'db', 'pg-migrations', '20260719090000_wave_story_integration_ledger.sql');
const gitEnvironment = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Rorca Successful Wave',
  GIT_AUTHOR_EMAIL: 'wave-success@rorca.invalid',
  GIT_COMMITTER_NAME: 'Rorca Successful Wave',
  GIT_COMMITTER_EMAIL: 'wave-success@rorca.invalid',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
};

interface StoryFixture {
  storyId: string;
  scenarioId: string;
  expectedFile: string;
  waveIndex: number;
  attempt: number;
}

interface ExecutedStory extends StoryFixture {
  ownership: StoryWorktreeOwnership;
  sourceCommit: string;
  evidence: FixtureExecutionEvidence;
}

interface TraceEvent {
  type: string;
  storyId?: string;
  state?: string;
  attempt?: number;
  sourceCommit?: string;
  expectedParentHead?: string;
  resultingHead?: string;
  revision?: string;
  status?: string;
  [key: string]: unknown;
}

interface QualificationTrace {
  schemaVersion: 1;
  stories: Array<StoryFixture & { sourceCommit: string }>;
  baseRevision: string;
  finalRevision: string;
  processExitCode: number;
  pipelineRun: { status: 'passed'; revision: string };
  runState: { status: 'passed'; revision: string };
  events: TraceEvent[];
}

interface ScenarioVerdict {
  acceptedStoryIds: string[];
  integrationOrder: string[];
  treeHash: string;
  normalizedFiles: Record<string, string>;
  trace: QualificationTrace;
}

const stories: StoryFixture[] = [
  { storyId: 'WPE-SUCCESS-A', scenarioId: 'parallel-a', expectedFile: 'fixture-output/parallel-a.txt', waveIndex: 0, attempt: 1 },
  { storyId: 'WPE-SUCCESS-B', scenarioId: 'parallel-b', expectedFile: 'fixture-output/parallel-b.txt', waveIndex: 0, attempt: 1 },
  { storyId: 'WPE-SUCCESS-C', scenarioId: 'parallel-c', expectedFile: 'fixture-output/parallel-c.txt', waveIndex: 0, attempt: 1 },
  { storyId: 'WPE-SUCCESS-D', scenarioId: 'parallel-d', expectedFile: 'fixture-output/parallel-d.txt', waveIndex: 0, attempt: 1 },
];

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

function createBaseRepository(root: string): { repository: string; revision: string } {
  const repository = path.join(root, 'source');
  fs.mkdirSync(repository);
  git(repository, ['init', '--initial-branch=qualification-base']);
  git(repository, ['config', 'user.name', 'Rorca Successful Wave']);
  git(repository, ['config', 'user.email', 'wave-success@rorca.invalid']);
  fs.writeFileSync(path.join(repository, 'README.md'), 'successful wave qualification\n');
  git(repository, ['add', 'README.md']);
  git(repository, ['commit', '-m', 'test(qualification): deterministic successful wave base']);
  return { repository, revision: git(repository, ['rev-parse', 'HEAD']) };
}

function cloneRunRepository(source: string, root: string, parallelism: number): string {
  const repository = path.join(root, `run-p${parallelism}`);
  execFileSync('git', ['clone', '--quiet', '--no-hardlinks', source, repository], { stdio: 'ignore' });
  git(repository, ['checkout', '-b', `qualification/run-p${parallelism}`]);
  return repository;
}

async function bounded<T>(tasks: Array<() => Promise<T>>, parallelism: number): Promise<T[]> {
  const output: T[] = [];
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= tasks.length) return;
      output[index] = await tasks[index]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(parallelism, tasks.length) }, () => worker()));
  return output;
}

function appendNewTransitions(trace: TraceEvent[], record: WaveIntegrationRecord, previousCount: number): void {
  for (const transition of record.transitions.slice(previousCount)) {
    trace.push({
      type: 'integration_state',
      storyId: record.storyId,
      state: transition.state,
      attempt: record.attempt,
      sourceCommit: record.sourceCommit,
      expectedParentHead: record.expectedParentHead,
      resultingHead: transition.state === 'integrated' ? record.resultingHead ?? undefined : undefined,
      revision: transition.revision,
    });
  }
}

function writeIdempotentReceipt(root: string, storyId: string, idempotencyKey: string, revision: string) {
  const projectionRoot = path.join(root, 'durable-projections');
  fs.mkdirSync(projectionRoot, { recursive: true });
  const receiptPath = path.join(projectionRoot, `${storyId}.json`);
  const body = `${JSON.stringify({ idempotencyKey, revision, storyId })}\n`;
  try {
    fs.writeFileSync(receiptPath, body, { flag: 'wx', mode: 0o600 });
  } catch {
    assert.equal(fs.readFileSync(receiptPath, 'utf8'), body, 'idempotent finalization replay changed its durable receipt');
  }
  return { idempotencyKey, revision, receiptHash: sha256(body) };
}

function engineFacingTraceVerdict(trace: QualificationTrace): { integrationOrder: string[]; finalRevision: string } {
  const ordered = [...trace.stories].sort((left, right) => left.waveIndex - right.waveIndex || left.storyId.localeCompare(right.storyId));
  const integrationOrder = trace.events
    .filter(event => event.type === 'integration_state' && event.state === 'integrated')
    .map(event => event.storyId!);
  assert.deepEqual(integrationOrder, ordered.map(story => story.storyId));
  let revision = trace.baseRevision;
  for (const story of ordered) {
    const states = trace.events
      .filter(event => event.type === 'integration_state' && event.storyId === story.storyId)
      .map(event => event.state);
    assert.deepEqual(states, ['prepared', 'integrating', 'integrated', 'integrated_validated', 'finalized']);
    const integrated = trace.events.find(event => event.type === 'integration_state' && event.storyId === story.storyId && event.state === 'integrated')!;
    assert.equal(integrated.expectedParentHead, revision);
    revision = integrated.resultingHead!;
    for (const projection of ['spec_story_passed', 'run_story_passed', 'story_result_passed', 'wal_story_passed']) {
      const matches = trace.events.filter(event => event.type === projection && event.storyId === story.storyId);
      assert.equal(matches.length, 1);
      assert.equal(matches[0].revision, revision);
    }
  }
  assert.equal(trace.finalRevision, revision);
  assert.deepEqual(trace.pipelineRun, { status: 'passed', revision });
  assert.deepEqual(trace.runState, { status: 'passed', revision });
  assert.equal(trace.processExitCode, 0);
  return { integrationOrder, finalRevision: revision };
}

async function runSuccessfulWave(root: string, source: string, baseRevision: string, manifestPath: string, parallelism: 2 | 4): Promise<ScenarioVerdict> {
  const repository = cloneRunRepository(source, root, parallelism);
  const harness = new DeterministicFixtureHarness(root);
  const barrierDirectory = path.join(root, `barrier-p${parallelism}`);
  fs.mkdirSync(barrierDirectory);
  const queueName = `qualification:qrun_0123456789abcdef01234567:wave-success-p${parallelism}`;
  const queueJobs = stories.flatMap(story => [story, story]); // deliberate duplicate delivery
  const claimed = new Set<string>();
  const executed = new Map<string, ExecutedStory>();
  const traceEvents: TraceEvent[] = [];
  const ownerships = new Map<string, StoryWorktreeOwnership>();
  const allowlist = new Set<string>();

  fs.mkdirSync(path.join(root, `worktrees-p${parallelism}`));
  for (const story of stories) {
    const ownership = createOwnedStoryWorktree({
      repositoryPath: repository,
      worktreePath: path.join(root, `worktrees-p${parallelism}`, story.storyId),
      branchName: `qualification/qrun_0123456789abcdef01234567/p${parallelism}/${story.storyId}/attempt-1`,
      runId: 904,
      waveIndex: story.waveIndex,
      storyId: story.storyId,
      attempt: story.attempt,
      baseRevision,
      qualificationNamespace: 'qrun_0123456789abcdef01234567',
    });
    ownerships.set(story.storyId, ownership);
    allowlist.add(ownership.ownershipId);
  }

  try {
    await bounded(queueJobs.map(story => async () => {
      traceEvents.push({ type: 'queue_claimed', storyId: story.storyId, queueName });
      if (claimed.has(story.storyId)) {
        traceEvents.push({ type: 'duplicate_delivery_ignored', storyId: story.storyId, queueName });
        return;
      }
      claimed.add(story.storyId);
      const ownership = ownerships.get(story.storyId)!;
      traceEvents.push({ type: 'worker_dispatched', storyId: story.storyId, queueName });
      const evidence = await harness.run({
        storyId: story.storyId,
        scenarioId: story.scenarioId,
        seed: 'successful-wave-seed-v1',
        revision: baseRevision,
        cwd: ownership.worktreeRealpath,
        barrierDirectory,
        timeoutMs: 5_000,
        attempt: 1,
      });
      assert.equal(evidence.status, 'passed');
      assert.deepEqual(evidence.unreapedPids, []);
      const sourceCommit = git(ownership.worktreeRealpath, ['rev-parse', 'HEAD']);
      assert.notEqual(sourceCommit, baseRevision);
      assert.deepEqual(git(ownership.worktreeRealpath, ['diff-tree', '--no-commit-id', '--name-only', '-r', sourceCommit]).split('\n'), [story.expectedFile]);
      executed.set(story.storyId, { ...story, ownership, sourceCommit, evidence: recordFixtureHostPhase(evidence, 'hostValidation') });
    }), parallelism);

    assert.equal(executed.size, stories.length);
    assert.equal(claimed.size, stories.length);
    assert.equal(traceEvents.filter(event => event.type === 'duplicate_delivery_ignored').length, stories.length);
    const evidence = [...executed.values()].map(item => item.evidence);
    const arrivals = evidence.map(item => Number(item.events.find(event => event.type === 'barrier-arrived')?.wallClockMs));
    const releases = evidence.map(item => Number(item.events.find(event => event.type === 'barrier-released')?.wallClockMs));
    assert.ok(Math.min(...releases) >= Math.min(...arrivals));
    assert.ok(evidence.some((left, index) => evidence.some((right, rightIndex) => index !== rightIndex
      && Date.parse(left.startedAt) < Date.parse(right.finishedAt)
      && Date.parse(right.startedAt) < Date.parse(left.finishedAt))), 'no fixture subprocess overlap was observed');

    const ledger = new WaveIntegrationLedger(repository);
    const manifestHash = sha256(fs.readFileSync(manifestPath));
    let expectedParentHead = baseRevision;
    const order = deterministicWaveIntegrationOrder([...executed.values()]);
    for (const contribution of order) {
      const identity: WaveContributionIdentity = {
        runId: 904,
        waveIndex: contribution.waveIndex,
        storyId: contribution.storyId,
        attempt: contribution.attempt,
        sourceRef: `refs/heads/${contribution.ownership.branchName}`,
        sourceCommit: contribution.sourceCommit,
        sourceBaseCommit: baseRevision,
        expectedParentHead,
        frozenManifestPath: manifestPath,
        frozenManifestHash: manifestHash,
      };
      let record = ledger.prepare(identity);
      appendNewTransitions(traceEvents, record, 0);
      assert.equal(record.state, 'prepared');
      const prepareTransitions = record.transitions.length;
      assert.equal(ledger.prepare(identity).transitions.length, prepareTransitions, 'duplicate preparation appended a transition');

      let previous = record.transitions.length;
      record = ledger.integrate(identity);
      appendNewTransitions(traceEvents, record, previous);
      assert.equal(record.state, 'integrated');
      assert.equal(git(repository, ['show', '-s', '--format=%P', record.resultingHead!]).split(' ')[1], contribution.sourceCommit);
      assert.equal(git(repository, ['rev-list', '--count', record.resultingHead!, '--', contribution.expectedFile]), '1');

      const validationIdentity = {
        validator: 'canonical-host-validation-v1',
        revision: record.resultingHead!,
        treeHash: git(repository, ['rev-parse', 'HEAD^{tree}']),
        contractHash: sha256('git-fsck\ngit-diff-tree-check\nprojection-contract-v1\n'),
      };
      execFileSync('git', ['fsck', '--no-dangling'], { cwd: repository, stdio: 'ignore' });
      execFileSync('git', ['diff-tree', '--check', 'HEAD'], { cwd: repository, stdio: 'ignore' });
      previous = record.transitions.length;
      record = ledger.markIntegratedValidated(identity, validationIdentity);
      appendNewTransitions(traceEvents, record, previous);

      previous = record.transitions.length;
      record = ledger.finalize(identity, (idempotencyKey, revision) => writeIdempotentReceipt(path.join(root, `projection-p${parallelism}`), contribution.storyId, idempotencyKey, revision));
      appendNewTransitions(traceEvents, record, previous);
      assert.equal(record.state, 'finalized');
      const finalizedTransitionCount = record.transitions.length;
      assert.equal(ledger.integrate(identity).transitions.length, finalizedTransitionCount);
      assert.equal(ledger.markIntegratedValidated(identity, validationIdentity).transitions.length, finalizedTransitionCount);
      assert.equal(ledger.finalize(identity, () => { throw new Error('finalizer must not repeat'); }).transitions.length, finalizedTransitionCount);

      contribution.evidence = recordFixtureHostPhase(recordFixtureHostPhase(contribution.evidence, 'integration'), 'finalCloseout');
      for (const type of ['spec_story_passed', 'run_story_passed', 'story_result_passed', 'wal_story_passed']) {
        traceEvents.push({ type, storyId: contribution.storyId, revision: record.resultingHead! });
      }
      expectedParentHead = record.resultingHead!;
    }

    for (const contribution of order) {
      const cleanup = cleanupOwnedStoryWorktree({
        repositoryPath: repository,
        ownership: contribution.ownership,
        currentWaveAllowlist: allowlist,
        expectedBaseRevision: baseRevision,
        preserve: false,
        outcome: 'integrated',
      });
      assert.equal(cleanup.ok, true);
      assert.equal(cleanup.removed, true);
    }

    const finalRevision = git(repository, ['rev-parse', 'HEAD']);
    traceEvents.push({ type: 'run_closeout', status: 'passed', revision: finalRevision });
    const trace: QualificationTrace = {
      schemaVersion: 1,
      stories: order.map(item => ({
        storyId: item.storyId,
        scenarioId: item.scenarioId,
        expectedFile: item.expectedFile,
        waveIndex: item.waveIndex,
        attempt: item.attempt,
        sourceCommit: item.sourceCommit,
      })),
      baseRevision,
      finalRevision,
      processExitCode: 0,
      pipelineRun: { status: 'passed', revision: finalRevision },
      runState: { status: 'passed', revision: finalRevision },
      events: traceEvents,
    };
    const engineVerdict = engineFacingTraceVerdict(trace);
    const independent = JSON.parse(execFileSync(process.execPath, [checkerPath], {
      input: JSON.stringify(trace),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })) as { verdict: string; integrationOrder: string[]; finalRevision: string };
    assert.equal(independent.verdict, 'accept');
    assert.deepEqual(independent.integrationOrder, engineVerdict.integrationOrder);
    assert.equal(independent.finalRevision, engineVerdict.finalRevision);

    assert.equal(git(repository, ['status', '--porcelain=v1', '--untracked-files=all']), '');
    assert.equal(git(repository, ['worktree', 'list', '--porcelain']).split('\n\n').filter(Boolean).length, 1);
    assert.equal(git(repository, ['for-each-ref', '--format=%(refname)', 'refs/heads/qualification/qrun_']).trim(), '');
    assert.equal(git(repository, ['branch', '--show-current']), `qualification/run-p${parallelism}`);
    assert.ok([...executed.values()].every(item => item.evidence.lifecycle.finalCloseout));

    const normalizedFiles = Object.fromEntries(stories.map(story => [story.expectedFile, fs.readFileSync(path.join(repository, story.expectedFile), 'utf8')]));
    return {
      acceptedStoryIds: order.map(item => item.storyId),
      integrationOrder: engineVerdict.integrationOrder,
      treeHash: git(repository, ['rev-parse', 'HEAD^{tree}']),
      normalizedFiles,
      trace,
    };
  } finally {
    await harness.dispose();
  }
}

test('parallelism two and four produce the same successful exactly-once integrated wave', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-success-wave-'));
  try {
    const { repository: source, revision } = createBaseRepository(root);
    const manifestPath = path.join(root, 'frozen-execution-manifest.json');
    fs.writeFileSync(manifestPath, `${JSON.stringify({ schemaVersion: 1, stories })}\n`, { mode: 0o600 });
    const atTwo = await runSuccessfulWave(root, source, revision, manifestPath, 2);
    const atFour = await runSuccessfulWave(root, source, revision, manifestPath, 4);

    assert.deepEqual(atTwo.acceptedStoryIds, atFour.acceptedStoryIds);
    assert.deepEqual(atTwo.integrationOrder, atFour.integrationOrder);
    assert.deepEqual(atTwo.normalizedFiles, atFour.normalizedFiles);
    assert.equal(atTwo.treeHash, atFour.treeHash);
    assert.equal(atTwo.trace.events.filter(event => event.type === 'story_result_passed').length, stories.length);
    assert.equal(atFour.trace.events.filter(event => event.type === 'story_result_passed').length, stories.length);

    // Every known writable qualification identity is rooted in this disposable
    // namespace. The harness has no DB client and queue names are trace-audited.
    for (const event of [...atTwo.trace.events, ...atFour.trace.events]) {
      if (event.queueName) assert.match(String(event.queueName), /^qualification:qrun_0123456789abcdef01234567:/);
    }
    const testSource = fs.readFileSync(path.resolve(process.cwd(), 'backend', 'src', 'lib', '__tests__', 'successful-wave-integration.node.test.ts'), 'utf8');
    assert.doesNotMatch(testSource, /from ['"]\.\.\/\.\.\/db|new (?:Pool|PgBoss)\s*\(/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    assert.equal(fs.existsSync(root), false);
  }
});

test('restart reconciles every successful durable state from exact Git and idempotency identities', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-integration-restart-'));
  try {
    const { repository, revision } = createBaseRepository(root);
    const manifestPath = path.join(root, 'manifest.json');
    fs.writeFileSync(manifestPath, '{"frozen":true}\n');
    const ownership = createOwnedStoryWorktree({
      repositoryPath: repository,
      worktreePath: path.join(root, 'restart-story'),
      branchName: 'qualification/restart/story',
      runId: 906,
      waveIndex: 0,
      storyId: 'RESTART',
      attempt: 2,
      baseRevision: revision,
      qualificationNamespace: 'qrun_0123456789abcdef01234567',
    });
    fs.writeFileSync(path.join(ownership.worktreeRealpath, 'restart.txt'), 'restart-safe\n');
    git(ownership.worktreeRealpath, ['add', 'restart.txt']);
    git(ownership.worktreeRealpath, ['commit', '-m', 'restart source']);
    const identity: WaveContributionIdentity = {
      runId: 906,
      waveIndex: 0,
      storyId: 'RESTART',
      attempt: 2,
      sourceRef: `refs/heads/${ownership.branchName}`,
      sourceCommit: git(ownership.worktreeRealpath, ['rev-parse', 'HEAD']),
      sourceBaseCommit: revision,
      expectedParentHead: revision,
      frozenManifestPath: manifestPath,
      frozenManifestHash: sha256(fs.readFileSync(manifestPath)),
    };

    assert.equal(new WaveIntegrationLedger(repository).prepare(identity).state, 'prepared');
    const integrating = new WaveIntegrationLedger(repository).beginIntegration(identity);
    assert.equal(integrating.state, 'integrating');
    execFileSync('git', ['merge', '--no-ff', '--no-commit', identity.sourceCommit], { cwd: repository, env: gitEnvironment, stdio: 'ignore' });
    const appliedRevision = commitGuardedMerge(repository, 'merge(wave-0): RESTART attempt 2', revision);

    const integrated = new WaveIntegrationLedger(repository).integrate(identity);
    assert.equal(integrated.state, 'integrated');
    assert.equal(integrated.resultingHead, appliedRevision);
    assert.deepEqual(integrated.transitions.map(item => item.state), ['prepared', 'integrating', 'integrated']);
    const validation = {
      validator: 'restart-validator-v1',
      revision: appliedRevision,
      treeHash: git(repository, ['rev-parse', 'HEAD^{tree}']),
      contractHash: sha256('restart-validation-contract'),
    };
    assert.equal(new WaveIntegrationLedger(repository).markIntegratedValidated(identity, validation).state, 'integrated_validated');
    let finalizerCalls = 0;
    const finalized = new WaveIntegrationLedger(repository).finalize(identity, (idempotencyKey, finalRevision) => {
      finalizerCalls += 1;
      return writeIdempotentReceipt(root, 'RESTART', idempotencyKey, finalRevision);
    });
    assert.equal(finalized.state, 'finalized');
    assert.equal(new WaveIntegrationLedger(repository).finalize(identity, () => {
      finalizerCalls += 1;
      throw new Error('must not run');
    }).state, 'finalized');
    assert.equal(finalizerCalls, 1);
    assert.deepEqual(finalized.transitions.map(item => item.state), ['prepared', 'integrating', 'integrated', 'integrated_validated', 'finalized']);

    const staleLock = path.join(repository, '.git', 'rorca', 'wave-integration-ledger', `${waveIntegrationLedgerKey(identity)}.json.lock`);
    fs.writeFileSync(staleLock, `${JSON.stringify({ pid: 2_147_483_647, ledgerKey: waveIntegrationLedgerKey(identity) })}\n`);
    assert.equal(new WaveIntegrationLedger(repository).finalize(identity, () => { throw new Error('finalized replay must not call back'); }).state, 'finalized');
    assert.equal(fs.existsSync(staleLock), false, 'restart did not reconcile a dead mutation owner');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('integration preparation fails closed on dirty target, active Git operation, target advance, and changed manifest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-integration-guards-'));
  try {
    const { repository, revision } = createBaseRepository(root);
    const manifestPath = path.join(root, 'manifest.json');
    fs.writeFileSync(manifestPath, '{"frozen":true}\n');
    const manifestHash = sha256(fs.readFileSync(manifestPath));
    const ownership = createOwnedStoryWorktree({
      repositoryPath: repository,
      worktreePath: path.join(root, 'guard-story'),
      branchName: 'qualification/guard/story',
      runId: 905,
      waveIndex: 0,
      storyId: 'GUARD',
      attempt: 1,
      baseRevision: revision,
      qualificationNamespace: 'qrun_0123456789abcdef01234567',
    });
    fs.writeFileSync(path.join(ownership.worktreeRealpath, 'guard.txt'), 'guard\n');
    git(ownership.worktreeRealpath, ['add', 'guard.txt']);
    git(ownership.worktreeRealpath, ['commit', '-m', 'guard source']);
    const identity: WaveContributionIdentity = {
      runId: 905,
      waveIndex: 0,
      storyId: 'GUARD',
      attempt: 1,
      sourceRef: `refs/heads/${ownership.branchName}`,
      sourceCommit: git(ownership.worktreeRealpath, ['rev-parse', 'HEAD']),
      sourceBaseCommit: revision,
      expectedParentHead: revision,
      frozenManifestPath: manifestPath,
      frozenManifestHash: manifestHash,
    };
    const ledger = new WaveIntegrationLedger(repository);

    fs.writeFileSync(path.join(repository, 'dirty.txt'), 'dirty\n');
    assert.throws(() => ledger.prepare(identity), /not clean/);
    fs.unlinkSync(path.join(repository, 'dirty.txt'));

    const mergeHeadPath = path.resolve(repository, git(repository, ['rev-parse', '--git-path', 'MERGE_HEAD']));
    fs.writeFileSync(mergeHeadPath, `${identity.sourceCommit}\n`);
    assert.throws(() => ledger.prepare(identity), /already in progress/);
    fs.unlinkSync(mergeHeadPath);

    const prepared = ledger.prepare(identity);
    assert.equal(prepared.state, 'prepared');
    fs.writeFileSync(manifestPath, '{"frozen":false}\n');
    assert.throws(() => ledger.integrate(identity), /manifest changed/);
    fs.writeFileSync(manifestPath, '{"frozen":true}\n');

    fs.writeFileSync(path.join(repository, 'advance.txt'), 'advance\n');
    git(repository, ['add', 'advance.txt']);
    git(repository, ['commit', '-m', 'unexpected target advance']);
    assert.throws(() => ledger.integrate(identity), /target head changed/);
    assert.equal(ledger.get(identity)?.state, 'prepared');

    git(repository, ['reset', '--hard', revision]);
    assert.equal(ledger.beginIntegration(identity).state, 'integrating');
    const activeLock = path.join(repository, '.git', 'rorca', 'wave-integration-ledger', `${waveIntegrationLedgerKey(identity)}.json.lock`);
    fs.writeFileSync(activeLock, `${JSON.stringify({ pid: process.pid, ledgerKey: waveIntegrationLedgerKey(identity) })}\n`);
    assert.throws(() => ledger.integrate(identity), /already active/);
    fs.unlinkSync(activeLock);
    fs.writeFileSync(path.join(repository, 'post-intent-dirty.txt'), 'unsafe during apply\n');
    assert.throws(() => ledger.integrate(identity), /failed closed/);
    const failed = ledger.get(identity)!;
    assert.equal(failed.state, 'failed');
    assert.equal(failed.sourceCommit, identity.sourceCommit);
    assert.equal(failed.expectedParentHead, revision);
    assert.match(failed.failureReason ?? '', /not clean/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('PostgreSQL ledger migration encodes six-state identity and exactly-once constraints without pgboss changes', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');
  for (const state of ['prepared', 'integrating', 'integrated', 'integrated_validated', 'finalized', 'failed']) {
    assert.match(sql, new RegExp(`'${state}'`));
  }
  for (const column of ['run_id', 'story_id', 'attempt', 'source_commit', 'expected_parent_head', 'resulting_head', 'frozen_manifest_hash', 'validation_identity', 'finalization_identity']) {
    assert.match(sql, new RegExp(`\\b${column}\\b`));
  }
  assert.match(sql, /PRIMARY KEY \(run_id, story_id, attempt\)/);
  assert.match(sql, /UNIQUE \(run_id, integration_order\)/);
  assert.match(sql, /idx_story_integration_finalization_idempotency/);
  assert.match(sql, /enforce_story_integration_transition/);
  assert.match(sql, /illegal story integration transition/);
  assert.match(sql, /story integration identity is immutable/);
  assert.doesNotMatch(sql, /(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)[^;]*pgboss\./i);
});
