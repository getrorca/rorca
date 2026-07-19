/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  assertWavePolicyEnvelope,
  defaultWaveRolloutPolicy,
  evaluateWaveProductionPolicy,
  type WavePolicyEvaluationInput,
  type WaveQualificationIdentity,
} from '../wave-production-policy';

const repositoryRoot = fs.existsSync(path.resolve(process.cwd(), 'backend/src'))
  ? process.cwd()
  : path.resolve(process.cwd(), '..');

const receipt: WaveQualificationIdentity = {
  id: '41',
  reportHash: `sha256:${'a'.repeat(64)}`,
  sourceRevision: 'b'.repeat(40),
  current: true,
  productionEnableAvailable: true,
};

function productionInput(overrides: Partial<WavePolicyEvaluationInput> = {}): WavePolicyEvaluationInput {
  return {
    request: {
      orchestrationMode: 'wave-parallel',
      parallelism: 2,
      qualificationReceiptId: '41',
      rolloutCohort: 'canary-a',
    },
    environment: {
      nodeEnv: 'production',
      productionEnabled: 'true',
      experimentalEnabled: undefined,
      killSwitch: undefined,
    },
    workspaceId: 'workspace-a',
    runId: 101,
    currentRevision: receipt.sourceRevision,
    receipt,
    rollout: {
      ...defaultWaveRolloutPolicy(),
      enabled: true,
      cohort: 'canary-a',
      workspaceAllowlist: ['workspace-a'],
      maxParallelism: 4,
      maxActiveWaveRuns: 2,
      maxActiveWaveRunsPerWorkspace: 1,
      maxErrorRate: 0.05,
      releaseReadinessPacketId: 'packet-71',
      productionActivationApprovalId: 'approval-81',
      releaseReadinessCurrent: true,
      operatorActivationCurrent: true,
    },
    activeWaveRuns: 0,
    activeWorkspaceWaveRuns: 0,
    ...overrides,
  };
}

test('production remains sequential unless mode and parallelism are both explicit', () => {
  for (const request of [{}, { orchestrationMode: 'wave-parallel' }, { orchestrationMode: 'sequential', parallelism: 4 }]) {
    const result = evaluateWaveProductionPolicy(productionInput({ request }));
    assert.deepEqual(result.effective, { orchestrationMode: 'sequential', parallelism: 1 });
  }
});

test('production requires independent exact flag, current receipt, reviews, activation, cohort and request', () => {
  const enabled = evaluateWaveProductionPolicy(productionInput());
  assert.equal(enabled.allowed, true);
  assert.equal(enabled.status, 'canary-enabled');
  assert.deepEqual(enabled.effective, { orchestrationMode: 'wave-parallel', parallelism: 2 });

  const cases: Array<[string, Partial<WavePolicyEvaluationInput>, string]> = [
    ['flag omitted', { environment: { ...productionInput().environment, productionEnabled: undefined } }, 'production-disabled'],
    ['flag not exact', { environment: { ...productionInput().environment, productionEnabled: 'TRUE' } }, 'production-disabled'],
    ['receipt omitted', { receipt: null }, 'receipt-missing'],
    ['receipt stale', { receipt: { ...receipt, current: false } }, 'receipt-stale'],
    ['revision stale', { currentRevision: 'c'.repeat(40) }, 'receipt-stale'],
    ['review omitted', { rollout: { ...productionInput().rollout, releaseReadinessPacketId: null } }, 'review-missing'],
    ['review stale', { rollout: { ...productionInput().rollout, releaseReadinessCurrent: false } }, 'review-missing'],
    ['activation omitted', { rollout: { ...productionInput().rollout, productionActivationApprovalId: null } }, 'activation-missing'],
    ['activation stale', { rollout: { ...productionInput().rollout, operatorActivationCurrent: false } }, 'activation-missing'],
    ['cohort omitted', { request: { ...productionInput().request, rolloutCohort: undefined } }, 'production-disabled'],
  ];
  for (const [name, overrides, status] of cases) {
    const result = evaluateWaveProductionPolicy(productionInput(overrides));
    assert.equal(result.allowed, false, name);
    assert.equal(result.status, status, name);
    assert.deepEqual(result.effective, { orchestrationMode: 'sequential', parallelism: 1 }, name);
  }
});

test('experimental flag can authorize only non-production', () => {
  const production = evaluateWaveProductionPolicy(productionInput({
    environment: { nodeEnv: 'production', productionEnabled: undefined, experimentalEnabled: 'true', killSwitch: undefined },
  }));
  assert.equal(production.allowed, false);
  assert.equal(production.status, 'production-disabled');

  const nonproduction = evaluateWaveProductionPolicy(productionInput({
    environment: { nodeEnv: 'development', productionEnabled: undefined, experimentalEnabled: 'true', killSwitch: undefined },
    receipt: null,
  }));
  assert.equal(nonproduction.allowed, true);
  assert.equal(nonproduction.status, 'experimental-nonproduction');
});

test('caps, health, draining and kill switch stop only future parallel dispatch', () => {
  for (const overrides of [
    { request: { ...productionInput().request, parallelism: 5 } },
    { activeWaveRuns: 2 },
    { rollout: { ...productionInput().rollout, observedErrorRate: 0.06 } },
    { rollout: { ...productionInput().rollout, draining: true } },
    { environment: { ...productionInput().environment, killSwitch: 'true' } },
  ]) {
    const result = evaluateWaveProductionPolicy(productionInput(overrides));
    assert.equal(result.allowed, false);
    assert.equal(result.effective.parallelism, 1);
    assert.ok(['halted', 'draining'].includes(result.status));
  }
});

test('dispatch fence detects queue, worker or runner policy drift without relabeling evidence', () => {
  const envelope = evaluateWaveProductionPolicy(productionInput());
  assert.doesNotThrow(() => assertWavePolicyEnvelope(envelope, productionInput()));
  assert.throws(
    () => assertWavePolicyEnvelope(envelope, productionInput({ environment: { ...productionInput().environment, killSwitch: 'true' } })),
    /dispatch policy changed/,
  );
  assert.equal(envelope.effective.orchestrationMode, 'wave-parallel');
  assert.equal(envelope.allowed, true);
});

test('NODE_ENV=production policy exercise is pure and cannot access a database or repository', () => {
  // This test supplies production as data. It does not mutate process.env, import the DB
  // pool, read a repository, or spawn a process; integration qualification must use the
  // dedicated test DB and disposable repositories described in the rollout runbook.
  const result = evaluateWaveProductionPolicy(productionInput());
  assert.equal(result.status, 'canary-enabled');
});

test('engine and dispatch boundaries require the same governed production evidence', () => {
  const engine = fs.readFileSync(path.join(repositoryRoot, 'backend/src/lib/execution-engine.ts'), 'utf8');
  const worker = fs.readFileSync(path.join(repositoryRoot, 'backend/src/worker.ts'), 'utf8');
  const runner = fs.readFileSync(path.join(repositoryRoot, 'backend/src/runner/local-runner.ts'), 'utf8');
  assert.match(engine, /RORCA_GOVERNED_WAVE_POLICY/);
  assert.match(engine, /RORCA_WAVE_PARALLEL_PRODUCTION_ENABLED !== 'true'/);
  assert.match(engine, /policy\.receipt\.sourceRevision !== currentRevision/);
  assert.match(worker, /Revalidating governed mode immediately before spawn/);
  assert.match(runner, /runner\/jobs\/\$\{job\.id\}\/revalidate/);
});

test('governance migration is additive and never touches pg-boss or historical run evidence', () => {
  const migration = fs.readFileSync(path.join(repositoryRoot, 'backend/src/db/pg-migrations/20260719104000_wave_production_governance.sql'), 'utf8');
  assert.match(migration, /ADD COLUMN IF NOT EXISTS orchestration_mode/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS wave_parallel_governance_audit/);
  assert.doesNotMatch(migration, /(?:UPDATE|DELETE FROM)\s+pipeline_runs/i);
  assert.doesNotMatch(migration, /(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)[^;]*\bpgboss\b/i);
});
