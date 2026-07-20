/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import {
  assertPerformanceBudgets,
  assertQualificationResult,
  assertRepeatedRunLeakSentinel,
  buildQualificationFailureDiagnostic,
  QUALIFICATION_FAULT_POINTS,
  QUALIFICATION_SCENARIOS,
  runQualificationSchedule,
  type QualificationBudgetSet,
  type QualificationResult,
  type QualificationScenario,
} from '../wave-qualification-model';

const repositoryRoot = fs.existsSync(path.resolve(process.cwd(), 'backend', 'src'))
  ? process.cwd()
  : path.resolve(process.cwd(), '..');
const baselinePath = path.join(repositoryRoot, 'docs', 'qualification', 'wave-stress-baseline-v1.json');
const migrationPath = path.join(repositoryRoot, 'backend', 'src', 'db', 'pg-migrations', '20260719102000_wave_stress_qualification.sql');
const launcherPath = path.join(repositoryRoot, 'scripts', 'run-wave-stress-qualification.mjs');
const budgets = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as QualificationBudgetSet;
const requestedProfile = process.env.RORCA_WAVE_QUALIFICATION_PROFILE;
const profile: 'ci' | 'soak' | 'diagnostic' = requestedProfile === 'soak'
  ? 'soak'
  : requestedProfile === 'diagnostic' ? 'diagnostic' : 'ci';
const seedCount = profile === 'soak'
  ? Number.parseInt(process.env.RORCA_WAVE_SOAK_SEEDS ?? '100', 10)
  : profile === 'diagnostic' ? 1 : 3;
const repeatCount = profile === 'soak'
  ? Number.parseInt(process.env.RORCA_WAVE_SOAK_REPEATS ?? '5', 10)
  : 2;

function clone(result: QualificationResult): QualificationResult {
  return structuredClone(result);
}

function run(seed: string, scenario: QualificationScenario, parallelism: 2 | 4): QualificationResult {
  try {
    const result = runQualificationSchedule({ seed, scenario, parallelism });
    assertPerformanceBudgets(result, budgets);
    return result;
  } catch (error) {
    // This is a credential/path-free fallback diagnostic. Successful runs emit nothing.
    process.stderr.write(`${JSON.stringify({
      seed,
      scenario,
      parallelism,
      faultPoint: scenario.startsWith('crash-') ? scenario.slice(6) : 'WPE-FP-009',
      rerunCommand: `npm run qualify:wave:diagnostic -- --seed=${seed} --scenario=${scenario} --parallelism=${parallelism}`,
    })}\n`);
    throw error;
  }
}

test('CI/soak seeded matrix covers every scenario at parallelism two and four on its first attempt', { timeout: profile === 'soak' ? 840_000 : 60_000 }, () => {
  assert.ok(Number.isSafeInteger(seedCount) && seedCount >= (profile === 'soak' ? 20 : profile === 'ci' ? 3 : 1));
  assert.ok(Number.isSafeInteger(repeatCount) && repeatCount >= 2);
  assert.ok(QUALIFICATION_SCENARIOS.includes('sibling-success'));
  assert.ok(QUALIFICATION_SCENARIOS.includes('dependency-chain'));
  assert.ok(QUALIFICATION_SCENARIOS.includes('duplicate-queue-delivery'));
  assert.ok(QUALIFICATION_SCENARIOS.includes('restart'));
  assert.ok(QUALIFICATION_SCENARIOS.includes('retry'));
  assert.deepEqual(
    QUALIFICATION_FAULT_POINTS.map(point => `crash-${point}`),
    QUALIFICATION_SCENARIOS.filter(scenario => scenario.startsWith('crash-')),
  );

  const diagnosticScenario = process.env.RORCA_WAVE_DIAGNOSTIC_SCENARIO;
  const selectedScenarios: readonly QualificationScenario[] = profile === 'diagnostic'
    && diagnosticScenario
    && diagnosticScenario !== 'all'
    && QUALIFICATION_SCENARIOS.includes(diagnosticScenario as QualificationScenario)
    ? [diagnosticScenario as QualificationScenario]
    : QUALIFICATION_SCENARIOS;
  const diagnosticParallelism = process.env.RORCA_WAVE_DIAGNOSTIC_PARALLELISM;
  const selectedParallelism: readonly (2 | 4)[] = profile === 'diagnostic' && ['2', '4'].includes(diagnosticParallelism ?? '')
    ? [Number(diagnosticParallelism) as 2 | 4]
    : [2, 4];
  for (let seedIndex = 0; seedIndex < seedCount; seedIndex += 1) {
    const seed = profile === 'diagnostic'
      ? process.env.RORCA_WAVE_DIAGNOSTIC_SEED ?? 'diagnostic-seed'
      : `${profile}-seed-${String(seedIndex).padStart(4, '0')}`;
    for (const parallelism of selectedParallelism) {
      for (const scenario of selectedScenarios) run(seed, scenario, parallelism);
    }
  }
});

test('generated schedules compare every transition and terminal projection to the reference model', () => {
  for (let propertySeed = 0; propertySeed < Math.max(32, seedCount); propertySeed += 1) {
    const seed = `property-${propertySeed.toString(16).padStart(8, '0')}`;
    const scenario = QUALIFICATION_SCENARIOS[propertySeed % QUALIFICATION_SCENARIOS.length];
    const result = run(seed, scenario, propertySeed % 2 === 0 ? 2 : 4);
    assert.ok(result.transitions.length > 0);
    assertQualificationResult(result);
    for (const transition of result.transitions) {
      assert.match(transition.faultPoint, /^WPE-FP-00[1-9]$/);
    }
  }
});

test('same seed/scenario is normalized deterministically across repeats and completion permutations', () => {
  for (const scenario of ['success', 'completion-order-forward', 'completion-order-reverse', 'completion-order-generated'] as const) {
    const first = run('determinism-seed', scenario, 2);
    const second = run('determinism-seed', scenario, 2);
    assert.deepEqual(second, first);
  }

  const forward = run('topology-seed', 'completion-order-forward', 2).normalized;
  const reverse = run('topology-seed', 'completion-order-reverse', 4).normalized;
  for (const key of ['finalSourceTree', 'commitTopology', 'acceptedStorySet', 'blockedDependencySet', 'semanticCloseout', 'recoveryInventory'] as const) {
    assert.deepEqual(reverse[key], forward[key], `completion permutation changed ${key}`);
  }
});

test('duplicate deliveries are recorded separately from exactly-once claims', () => {
  const result = run('duplicate-seed', 'duplicate-queue-delivery', 4);
  assert.equal(result.queueDeliveryEvidence.delivered, result.queueDeliveryEvidence.claimed * 2);
  assert.equal(result.queueDeliveryEvidence.duplicateSuppressed, result.queueDeliveryEvidence.claimed);
  assert.ok(Object.values(result.terminal.stories).every(story => story.finalizationCount === 1));
  const queueCrash = run('queue-crash-seed', 'crash-WPE-FP-001', 2);
  assert.equal(queueCrash.terminal.stories['story-a'].started, false);
  assert.deepEqual(queueCrash.terminal.attempts, {});
  assert.equal(queueCrash.queueDeliveryEvidence.claimed, 1);
});

test('repeated-run sentinel rejects monotonic process, fd, worktree, ref, queue, lease, and row growth', () => {
  const repeated: QualificationResult[] = [];
  for (let iteration = 0; iteration < repeatCount; iteration += 1) {
    repeated.push(run('leak-seed', 'duplicate-queue-delivery', 4));
  }
  assertRepeatedRunLeakSentinel(repeated);

  const leaking = repeated.map((item, index) => {
    const mutated = clone(item);
    mutated.resources.final.queueJobs = index + 1;
    return mutated;
  });
  assert.throws(() => assertRepeatedRunLeakSentinel(leaking), /leaked queueJobs|monotonic growth/);
});

test('deliberate invariant mutations cannot pass the qualification oracle', () => {
  const successful = run('mutation-success', 'success', 2);
  const dependentFailure = run('mutation-dependent', 'sibling-success', 2);

  const passBeforeIntegration = clone(successful);
  passBeforeIntegration.terminal.integrations['story-a#1'] = 'validated';
  assert.throws(() => assertQualificationResult(passBeforeIntegration), /integration|pass before/);

  const missingDependencyBlock = clone(dependentFailure);
  missingDependencyBlock.terminal.stories['story-c'].blockedBy = [];
  assert.throws(() => assertQualificationResult(missingDependencyBlock), /dependency blocking/);

  const duplicateFinalization = clone(successful);
  duplicateFinalization.terminal.stories['story-a'].finalizationCount = 2;
  assert.throws(() => assertQualificationResult(duplicateFinalization), /exactly-once integration|duplicate finalization/);

  const falseCloseout = clone(dependentFailure);
  falseCloseout.terminal.run = 'succeeded';
  falseCloseout.normalized.semanticCloseout = 'succeeded';
  assert.throws(() => assertQualificationResult(falseCloseout), /terminal state diverged|false successful closeout/);

  const unsafeCleanup = clone(successful);
  unsafeCleanup.resources.final.worktrees = 1;
  assert.throws(() => assertQualificationResult(unsafeCleanup), /leaked worktrees/);
});

test('database proofs cover all owned resource kinds and unchanged protected sentinels', () => {
  const result = run('database-seed', 'success', 2);
  assert.deepEqual(new Set(result.database.rows.map(row => row.kind)), new Set([
    'workspace', 'spec', 'run', 'story_result', 'wal_event', 'lease', 'integration_record', 'queue_job',
  ]));

  const escaped = clone(result);
  escaped.database.rows[0].qualificationNamespace = 'qrun_ffffffffffffffffffffffff';
  assert.throws(() => assertQualificationResult(escaped), /escaped qualification namespace/);

  const changedSentinel = clone(result);
  changedSentinel.database.protectedSentinelAfter = '0'.repeat(64);
  assert.throws(() => assertQualificationResult(changedSentinel), /production sentinel changed/);

  const migration = fs.readFileSync(migrationPath, 'utf8');
  for (const kind of ['workspace', 'spec', 'run', 'story_result', 'wal_event', 'lease', 'integration_record', 'queue_job']) {
    assert.match(migration, new RegExp(`'${kind}'`));
  }
  assert.match(migration, /before_hash = after_hash/);
  assert.match(migration, /assert_wave_qualification_inventory_complete/);
  assert.doesNotMatch(migration, /(?:CREATE|ALTER|DROP|DELETE|UPDATE|INSERT)[^;]*pgboss\./i);
});

test('performance uses explicit absolute caps and a versioned baseline for every required metric', () => {
  assert.equal(budgets.baselineVersion, 'wave-stress-v1');
  const result = run('budget-seed', 'dependency-chain', 4);
  assertPerformanceBudgets(result, budgets);

  const exceeded = clone(result);
  exceeded.performance.cleanupMs = budgets.metrics.cleanupMs.absoluteCap + 1;
  assert.throws(() => assertPerformanceBudgets(exceeded, budgets), /cleanupMs.*exceeded/);
});

test('failure diagnostics are actionable, normalized, and contain no credential or production path', () => {
  const result = run('diagnostic-seed', 'conflict', 4);
  const diagnostic = buildQualificationFailureDiagnostic(result, 'WPE-FP-006');
  const serialized = JSON.stringify(diagnostic);
  assert.match(serialized, /diagnostic-seed/);
  assert.match(serialized, /WPE-FP-006/);
  assert.match(serialized, /qualify:wave:diagnostic/);
  assert.match(serialized, /normalizedEventTrace/);
  assert.match(serialized, /resourceSamples/);
  assert.doesNotMatch(serialized, /(?:postgres(?:ql)?:\/\/|password|api[_-]?key|\/Users\/|\\Users\\)/i);
});

test('blocking launcher has one authoritative attempt and no automatic retry loop', () => {
  const launcher = fs.readFileSync(launcherPath, 'utf8');
  assert.match(launcher, /firstAttempt: true/);
  assert.match(launcher, /diagnostic rerun is separate/i);
  assert.doesNotMatch(launcher, /for\s*\([^)]*(?:retry|attempt)/i);
  assert.doesNotMatch(launcher, /while\s*\([^)]*(?:retry|attempt)/i);
});
