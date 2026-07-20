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
  DeterministicFixtureHarness,
  normalizeFixtureEvidence,
  recordFixtureHostPhase,
  type FixtureEvent,
  type FixtureExecutionEvidence,
  type FixtureExecutionInput,
} from '../../test-helpers/deterministic-fixture-agent';

const backendSourceDirectory = fs.existsSync(path.resolve(process.cwd(), 'backend', 'src'))
  ? path.resolve(process.cwd(), 'backend', 'src')
  : path.resolve(process.cwd(), 'src');
const fixturesDirectory = path.join(backendSourceDirectory, '__tests__', 'fixtures');
const scenarioManifestPath = path.join(fixturesDirectory, 'wave-agent-scenarios.json');
const faultCatalogPath = path.join(fixturesDirectory, 'wave-fault-points.json');
const agentPath = path.join(fixturesDirectory, 'wave-fixture-agent.mjs');
// Fixture Git subprocesses must not receive credentials from the parent test process.
const deterministicGitEnv = {
  PATH: process.env.PATH ?? '',
  HOME: os.tmpdir(),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Rorca Fixture Base',
  GIT_AUTHOR_EMAIL: 'fixture-base@rorca.invalid',
  GIT_COMMITTER_NAME: 'Rorca Fixture Base',
  GIT_COMMITTER_EMAIL: 'fixture-base@rorca.invalid',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: deterministicGitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function createBaseRepository(root: string): { repository: string; revision: string } {
  const repository = path.join(root, 'base');
  fs.mkdirSync(repository);
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repository, env: deterministicGitEnv, stdio: 'ignore' });
  fs.writeFileSync(path.join(repository, 'README.md'), 'deterministic fixture repository\n');
  fs.writeFileSync(path.join(repository, 'shared-conflict.txt'), 'base\n');
  execFileSync('git', ['add', '.'], { cwd: repository, env: deterministicGitEnv, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'test(fixture): deterministic base'], {
    cwd: repository,
    env: deterministicGitEnv,
    stdio: 'ignore',
  });
  return { repository, revision: git(repository, ['rev-parse', 'HEAD']) };
}

function cloneRepository(base: string, root: string, name: string): string {
  const target = path.join(root, name);
  execFileSync('git', ['clone', '--quiet', '--no-hardlinks', base, target], { env: deterministicGitEnv, stdio: 'ignore' });
  return target;
}

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-wave-fixture-'));
}

async function withHarness(
  callback: (context: { root: string; harness: DeterministicFixtureHarness; base: string; revision: string }) => Promise<void>,
): Promise<void> {
  const root = tempRoot();
  const { repository: base, revision } = createBaseRepository(root);
  const harness = new DeterministicFixtureHarness(root);
  try {
    await callback({ root, harness, base, revision });
  } finally {
    await harness.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function input(repository: string, revision: string, scenarioId: string, extra: Partial<FixtureExecutionInput> = {}): FixtureExecutionInput {
  return {
    storyId: `story-${scenarioId}`,
    scenarioId,
    seed: 'qualification-seed-001',
    revision,
    cwd: repository,
    timeoutMs: 5_000,
    ...extra,
  };
}

function event(evidence: FixtureExecutionEvidence, type: string): FixtureEvent {
  const found = evidence.events.find(item => item.type === type);
  assert.ok(found, `missing explicit ${type} event`);
  return found;
}

function assertReaped(evidence: FixtureExecutionEvidence): void {
  assert.deepEqual(evidence.unreapedPids, [], `${evidence.scenarioId} leaked process IDs`);
  assert.equal(evidence.lifecycle.exited, true);
}

test('versioned manifests cover every behavior and catalog every durable boundary', () => {
  const manifest = JSON.parse(fs.readFileSync(scenarioManifestPath, 'utf8')) as Record<string, any>;
  const catalog = JSON.parse(fs.readFileSync(faultCatalogPath, 'utf8')) as Record<string, any>;
  const behaviors = new Set(Object.values(manifest.scenarios as Record<string, any>).map(item => item.behavior));
  for (const required of [
    'pass', 'reject-before-commit', 'reject-after-commit', 'dirty-worktree-rejection',
    'bounded-sleep', 'barrier-pass', 'timeout', 'cancellation', 'abrupt-exit', 'restart-resume',
  ]) assert.ok(behaviors.has(required), `missing behavior ${required}`);

  assert.deepEqual(catalog.faultPoints.map((item: any) => item.boundary), [
    'queue_claim', 'agent_start', 'agent_commit', 'host_validation', 'integration_preparation',
    'integration_apply', 'integrated_validation', 'evidence_persistence', 'run_closeout',
  ]);
  const catalogIds = new Set(catalog.faultPoints.map((item: any) => item.id));
  for (const scenario of Object.values(manifest.scenarios as Record<string, any>)) {
    assert.ok(catalogIds.has(scenario.faultPoint), `${scenario.faultPoint} is not cataloged`);
    for (const forbidden of ['command', 'args', 'shell', 'script', 'url', 'host']) {
      assert.equal(Object.hasOwn(scenario, forbidden), false);
    }
  }
  assert.deepEqual(catalog.volatileEvidenceAllowlist, [
    'executionId', 'pid', 'descendantPids', 'startedAt', 'finishedAt', 'event.at',
    'event.wallClockMs', 'elapsedMs', 'exitSignal',
  ]);
});

test('identical seed, revision, and scenario produce identical normalized evidence and commits', async () => {
  await withHarness(async ({ root, harness, base, revision }) => {
    const firstRepo = cloneRepository(base, root, 'repeat-one');
    const secondRepo = cloneRepository(base, root, 'repeat-two');
    const first = await harness.run(input(firstRepo, revision, 'pass'));
    const second = await harness.run(input(secondRepo, revision, 'pass'));

    assert.equal(first.status, 'passed');
    assert.equal(second.status, 'passed');
    assert.notEqual(first.executionId, second.executionId);
    assert.ok(first.pid && second.pid && first.pid !== second.pid);
    assert.ok(first.outputBytes > 0 && first.outputBytes <= 64 * 1024);
    assert.equal(Date.parse(first.finishedAt) >= Date.parse(first.startedAt), true);
    assert.deepEqual(normalizeFixtureEvidence(first), normalizeFixtureEvidence(second));
    assert.equal(git(firstRepo, ['rev-parse', 'HEAD']), git(secondRepo, ['rev-parse', 'HEAD']));
    assert.equal(git(firstRepo, ['show', '-s', '--format=%s', 'HEAD']), 'test(fixture): deterministic pass');
    assert.equal(fs.readFileSync(path.join(firstRepo, 'fixture-output/pass.txt'), 'utf8'), fs.readFileSync(path.join(secondRepo, 'fixture-output/pass.txt'), 'utf8'));
    assertReaped(first);
    assertReaped(second);
  });
});

test('barrier evidence proves two real fixture subprocesses overlap before either release', async () => {
  await withHarness(async ({ root, harness, base, revision }) => {
    const barrierDirectory = path.join(root, 'barrier');
    fs.mkdirSync(barrierDirectory);
    const leftRepo = cloneRepository(base, root, 'barrier-left');
    const rightRepo = cloneRepository(base, root, 'barrier-right');
    const [left, right] = await Promise.all([
      harness.run(input(leftRepo, revision, 'barrier-pass', { storyId: 'barrier-left', barrierDirectory })),
      harness.run(input(rightRepo, revision, 'barrier-pass', { storyId: 'barrier-right', barrierDirectory })),
    ]);

    const arrivals = [event(left, 'barrier-arrived').wallClockMs, event(right, 'barrier-arrived').wallClockMs] as number[];
    const releases = [event(left, 'barrier-released').wallClockMs, event(right, 'barrier-released').wallClockMs] as number[];
    assert.ok(Math.max(...arrivals) <= Math.min(...releases), 'a process released before both arrivals existed');
    assert.ok(Date.parse(left.startedAt) < Date.parse(right.finishedAt));
    assert.ok(Date.parse(right.startedAt) < Date.parse(left.finishedAt));
    assert.notEqual(left.pid, right.pid);
    assert.equal(left.status, 'passed');
    assert.equal(right.status, 'passed');
  });
});

test('only manifest scenarios run; payload shell fields, credentials, routes, and network code are unavailable', async () => {
  await withHarness(async ({ root, harness, base, revision }) => {
    const repository = cloneRepository(base, root, 'safe-request');
    const sentinel = path.join(root, 'payload-shell-ran');
    const unsafe = {
      ...input(repository, revision, 'pass'),
      command: `touch ${sentinel}`,
      shell: true,
      env: { OPENAI_API_KEY: 'production-secret' },
      url: 'https://example.com',
    } as FixtureExecutionInput;
    const result = await harness.run(unsafe);
    const started = event(result, 'story-started');
    assert.equal(fs.existsSync(sentinel), false);
    assert.deepEqual(started.inheritedSensitiveKeys, []);
    assert.equal(started.networkPolicy, 'external-services-disabled');
    await assert.rejects(harness.run(input(repository, revision, 'not-versioned')), /unknown versioned scenario/);

    const agentSource = fs.readFileSync(agentPath, 'utf8');
    assert.doesNotMatch(agentSource, /node:(?:net|http|https|dns|tls)/);
    const routesDirectory = path.join(backendSourceDirectory, 'routes');
    const routeFiles = fs.readdirSync(routesDirectory).filter(name => name.endsWith('.ts'));
    for (const routeFile of routeFiles) {
      const source = fs.readFileSync(path.join(routesDirectory, routeFile), 'utf8');
      assert.doesNotMatch(source, /wave-fixture-agent|wave-agent-scenarios|DeterministicFixtureHarness/);
    }
  });
});

test('rejections, dirty worktrees, bounded sleep, timeout, cancellation, and abrupt exits are explicit', async () => {
  await withHarness(async ({ root, harness, base, revision }) => {
    const runFresh = async (scenarioId: string, extra: Partial<FixtureExecutionInput> = {}, options: Parameters<typeof harness.run>[1] = {}) => {
      const repository = cloneRepository(base, root, `case-${scenarioId}`);
      return { repository, evidence: await harness.run(input(repository, revision, scenarioId, extra), options) };
    };

    const before = await runFresh('reject-before-commit');
    assert.equal(before.evidence.status, 'rejected');
    assert.equal(before.evidence.lifecycle.committed, false);
    assert.equal(git(before.repository, ['rev-parse', 'HEAD']), revision);
    assert.equal(git(before.repository, ['status', '--porcelain']), '');

    const after = await runFresh('reject-after-commit');
    assert.equal(after.evidence.status, 'rejected');
    assert.equal(after.evidence.lifecycle.committed, true);
    assert.notEqual(git(after.repository, ['rev-parse', 'HEAD']), revision);

    const dirty = await runFresh('dirty-worktree-rejection');
    assert.equal(dirty.evidence.status, 'rejected');
    assert.equal(dirty.evidence.lifecycle.committed, false);
    assert.match(git(dirty.repository, ['status', '--porcelain']), /fixture-output/);
    assert.equal(fs.existsSync(path.join(dirty.repository, 'fixture-output', 'dirty.txt')), true);

    const bounded = await runFresh('bounded-sleep');
    assert.equal(bounded.evidence.status, 'passed');
    assert.ok(bounded.evidence.elapsedMs >= 35 && bounded.evidence.elapsedMs < 2_000);
    event(bounded.evidence, 'bounded-sleep-completed');

    const timed = await runFresh('timeout', { timeoutMs: 2_500 });
    assert.equal(timed.evidence.status, 'timed_out');
    assert.equal(timed.evidence.exitCode, 124);
    assert.equal(timed.evidence.lifecycle.signalled, true);

    const controller = new AbortController();
    let cancelScheduled = false;
    const cancelled = await runFresh('cancellation', {}, {
      abortSignal: controller.signal,
      onEvent(observed) {
        if (observed.type === 'story-started' && !cancelScheduled) {
          cancelScheduled = true;
          setTimeout(() => controller.abort(), 10);
        }
      },
    });
    assert.equal(cancelled.evidence.status, 'cancelled');
    assert.equal(cancelled.evidence.exitCode, 130);
    assert.equal(cancelled.evidence.lifecycle.signalled, true);

    const abrupt = await runFresh('abrupt-exit');
    assert.equal(abrupt.evidence.status, 'abrupt_exit');
    assert.equal(abrupt.evidence.exitCode, 86);
    assert.equal(abrupt.evidence.lifecycle.committed, false);

    for (const result of [before.evidence, after.evidence, dirty.evidence, bounded.evidence, timed.evidence, cancelled.evidence, abrupt.evidence]) {
      assert.equal(result.lifecycle.started, true);
      assert.equal(result.lifecycle.hostValidation, false);
      assert.equal(result.lifecycle.integration, false);
      assert.equal(result.lifecycle.finalCloseout, false);
      assertReaped(result);
    }
  });
});

test('explicit lifecycle evidence gates host validation, integration, and final closeout', async () => {
  await withHarness(async ({ root, harness, base, revision }) => {
    const repository = cloneRepository(base, root, 'lifecycle');
    const childOnly = await harness.run(input(repository, revision, 'pass'));
    assert.deepEqual(childOnly.lifecycle, {
      queueClaimed: true,
      started: true,
      committed: true,
      signalled: false,
      exited: true,
      hostValidation: false,
      integration: false,
      finalCloseout: false,
    });
    assert.throws(() => recordFixtureHostPhase(childOnly, 'integration'), /requires explicit host validation/);
    const validated = recordFixtureHostPhase(childOnly, 'hostValidation');
    const integrated = recordFixtureHostPhase(validated, 'integration');
    const closed = recordFixtureHostPhase(integrated, 'finalCloseout');
    assert.equal(closed.lifecycle.hostValidation, true);
    assert.equal(closed.lifecycle.integration, true);
    assert.equal(closed.lifecycle.finalCloseout, true);
  });
});

test('merge-conflict scenarios deterministically conflict at integration apply', async () => {
  await withHarness(async ({ root, harness, base, revision }) => {
    const leftRepo = cloneRepository(base, root, 'conflict-left');
    const rightRepo = cloneRepository(base, root, 'conflict-right');
    const integrationRepo = cloneRepository(base, root, 'integration');
    const left = await harness.run(input(leftRepo, revision, 'merge-conflict-left'));
    const right = await harness.run(input(rightRepo, revision, 'merge-conflict-right'));
    assert.equal(left.faultPoint, 'WPE-FP-006');
    assert.equal(right.faultPoint, 'WPE-FP-006');
    execFileSync('git', ['fetch', '--quiet', leftRepo, 'HEAD'], { cwd: integrationRepo, env: deterministicGitEnv, stdio: 'ignore' });
    execFileSync('git', ['cherry-pick', 'FETCH_HEAD'], { cwd: integrationRepo, env: deterministicGitEnv, stdio: 'ignore' });
    execFileSync('git', ['fetch', '--quiet', rightRepo, 'HEAD'], { cwd: integrationRepo, env: deterministicGitEnv, stdio: 'ignore' });
    assert.throws(
      () => execFileSync('git', ['cherry-pick', 'FETCH_HEAD'], { cwd: integrationRepo, env: deterministicGitEnv, stdio: 'pipe' }),
    );
    assert.match(git(integrationRepo, ['status', '--porcelain']), /^UU shared-conflict\.txt$/m);
    execFileSync('git', ['cherry-pick', '--abort'], { cwd: integrationRepo, env: deterministicGitEnv, stdio: 'ignore' });
  });
});

test('restart-resume cites evidence persistence and resumes from the deterministic checkpoint', async () => {
  await withHarness(async ({ root, harness, base, revision }) => {
    const repository = cloneRepository(base, root, 'restart');
    const first = await harness.run(input(repository, revision, 'restart-resume', { attempt: 1 }));
    assert.equal(first.status, 'restart_pending');
    assert.equal(first.faultPoint, 'WPE-FP-008');
    event(first, 'restart-checkpoint-persisted');
    assert.equal(git(repository, ['rev-parse', 'HEAD']), revision);

    const resumed = await harness.run(input(repository, revision, 'restart-resume', { attempt: 2 }));
    assert.equal(resumed.status, 'passed');
    assert.equal(resumed.lifecycle.committed, true);
    event(resumed, 'restart-checkpoint-resumed');
    assert.equal(git(repository, ['show', '-s', '--format=%s', 'HEAD']), 'test(fixture): deterministic restart resume');
    assert.equal(git(repository, ['status', '--porcelain']), '');
    assertReaped(first);
    assertReaped(resumed);
  });
});

test('completion, failure, timeout, cancellation, abrupt exit, adapter error, and teardown reap descendants', async () => {
  await withHarness(async ({ root, harness, base, revision }) => {
    const cases: FixtureExecutionEvidence[] = [];
    for (const scenarioId of ['pass', 'reject-before-commit', 'abrupt-exit']) {
      const repository = cloneRepository(base, root, `reap-${scenarioId}`);
      cases.push(await harness.run(input(repository, revision, scenarioId)));
    }
    const timeoutRepo = cloneRepository(base, root, 'reap-timeout');
    cases.push(await harness.run(input(timeoutRepo, revision, 'timeout', { timeoutMs: 2_500 })));

    const cancelRepo = cloneRepository(base, root, 'reap-cancel');
    const controller = new AbortController();
    cases.push(await harness.run(input(cancelRepo, revision, 'cancellation'), {
      abortSignal: controller.signal,
      onEvent(observed) { if (observed.type === 'descendant-started') controller.abort(); },
    }));

    const errorRepo = cloneRepository(base, root, 'reap-adapter-error');
    const adapterError = await harness.run(input(errorRepo, revision, 'timeout'), {
      onEvent(observed) { if (observed.type === 'descendant-started') throw new Error('injected adapter observer failure'); },
    });
    assert.equal(adapterError.status, 'adapter_error');
    cases.push(adapterError);

    const teardownRepo = cloneRepository(base, root, 'reap-teardown');
    let notifyStarted: () => void = () => {};
    const started = new Promise<void>(resolve => { notifyStarted = resolve; });
    const teardownRun = harness.run(input(teardownRepo, revision, 'timeout', { timeoutMs: 10_000 }), {
      onEvent(observed) { if (observed.type === 'descendant-started') notifyStarted(); },
    });
    await started;
    await harness.dispose();
    cases.push(await teardownRun);

    for (const result of cases) {
      assert.equal(result.descendantPids.length, 1, `${result.scenarioId} did not create a real descendant`);
      assertReaped(result);
    }
  });
});
