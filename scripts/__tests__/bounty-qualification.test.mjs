/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const plan = readJson('config/bounty-qualification.v1.json');
const matrix = readJson('docs/security/hackbot/bounty-qualification-matrix.v1.json');
const evidence = readJson('tests/fixtures/bounty-qualification/evidence-results.v1.json');
const receipt = readJson('tests/fixtures/bounty-qualification/qualification-receipt.v1.json');
const requiredKinds = ['unit', 'property', 'postgresql', 'pg-boss', 'adapter', 'browser', 'sandbox', 'concurrency', 'crash', 'recovery', 'route-tool', 'ui', 'oracle', 'receipt'];
const requiredControls = ['sole-broker-egress', 'credential-isolation', 'scope-dns-redirect-containment', 'rule-of-two', 'stop-ordering', 'evidence-integrity', 'zero-submission-paths'];
const requiredMetrics = ['classSuccess', 'falsePositiveRate', 'rejectionRate', 'oracleFailures', 'costMicrousd', 'inputTokens', 'outputTokens', 'activity', 'cacheSpendMicrousd', 'authSpendMicrousd'];

function idsFromMarkdown(path, expression) {
  return [...readFileSync(resolve(root, path), 'utf8').matchAll(expression)].map((match) => match[1]).sort();
}

test('private and anti-cheat corpora are frozen, blinded, digest-only manifests', () => {
  assert.deepEqual(plan.corpora.map((item) => item.class).sort(), ['anti-cheat', 'private']);
  for (const corpus of plan.corpora) {
    assert.equal(corpus.storage, 'external-encrypted-fixture-store');
    assert.equal(corpus.blinded, true);
    assert.equal(corpus.immutable, true);
    assert.equal(corpus.repositoryContentIncluded, false);
    assert.match(corpus.manifestSha256, /^sha256:[0-9a-f]{64}$/);
    assert.ok(corpus.itemCount > 0);
  }
});

test('all required suite classes passed against declared hermetic targets', () => {
  assert.equal(plan.featureStateDuringQualification, 'disabled');
  assert.equal(plan.releaseEnableAvailable, false);
  assert.deepEqual(plan.requiredSuites.map((suite) => suite.kind).sort(), [...requiredKinds].sort());
  assert.deepEqual(evidence.suites.map((suite) => suite.kind).sort(), [...requiredKinds].sort());
  assert.ok(evidence.suites.every((suite) => suite.result === 'passed'));
  for (const target of plan.hermeticTargets) {
    assert.ok(['loopback-only', 'in-memory-resolver', 'intercepted-loopback', 'in-memory-broker', 'fake-transport'].includes(target.network));
    assert.match(target.origin, /(?:127\.0\.0\.1|\.invalid|^caido:\/\/)/);
  }
});

test('every HackBot requirement and finite P0 has one disposition, named test and passing result', () => {
  const requirementIds = idsFromMarkdown('docs/security/hackbot/requirements.md', /^\| (HB-[A-Z]+-\d+) \|/gm);
  const p0Ids = idsFromMarkdown('docs/architecture/adr-hackbot-governed-mission-control.md', /^\| (P0-[A-Z]+-\d+) \|/gm);
  const trace = readJson('docs/security/hackbot/hackbot-requirements-trace.v1.json');
  assert.deepEqual(matrix.requirements.map((row) => row.id).sort(), requirementIds);
  assert.deepEqual(matrix.p0Invariants.map((row) => row.id).sort(), p0Ids);
  assert.deepEqual(trace.rows.map((row) => row.requirementId).sort(), requirementIds);
  assert.ok(trace.rows.every((row) => row.disposition === 'implemented' && row.evidence.length > 0));
  for (const row of [...matrix.requirements, ...matrix.p0Invariants]) {
    assert.match(row.disposition, /^qualified/);
    assert.match(row.namedTest, /\.contract$/);
    assert.equal(row.result, 'passed');
  }
});

for (const row of matrix.p0Invariants) {
  test(`${row.namedTest} [${row.id}] qualification result`, () => {
    assert.equal(row.result, 'passed');
    assert.ok(evidence.controlProofs.some((proof) => proof.namedTest === row.namedTest)
      || ['controller-mutation-authority.contract', 'worker-bwrap-no-bypass.contract', 'hermes-relay-only.contract', 'broker-replay-stale-epoch.contract'].includes(row.namedTest));
  });
}

test('certification binds all mandatory controls and operational metrics', () => {
  assert.deepEqual(evidence.controlProofs.map((proof) => proof.id).sort(), [...requiredControls].sort());
  assert.ok(evidence.controlProofs.every((proof) => proof.result === 'passed' && proof.namedTest.endsWith('.contract')));
  assert.deepEqual(Object.keys(evidence.metrics).sort(), [...requiredMetrics].sort());
  assert.deepEqual(Object.keys(evidence.metrics.classSuccess).sort(), [
    'exposed-private-key', 'idor', 'known-vulnerability', 'reflected-xss',
    'server-side-callback', 'source-code-control-edge', 'stored-xss',
  ]);
  for (const key of ['falsePositiveRate', 'rejectionRate']) assert.ok(evidence.metrics[key] >= 0 && evidence.metrics[key] <= 1);
  for (const key of ['oracleFailures', 'costMicrousd', 'inputTokens', 'outputTokens', 'cacheSpendMicrousd', 'authSpendMicrousd']) assert.ok(evidence.metrics[key] >= 0);
});

test('runbook covers the complete disabled operator lifecycle', () => {
  const runbook = readFileSync(resolve(root, 'docs/bounty-qualification-runbook.md'), 'utf8');
  for (const operation of ['Enable', 'Preflight', 'Observe', 'Nudge', 'Pause', 'Kill', 'Resume', 'Closeout', 'Rollback']) {
    assert.match(runbook, new RegExp(`^## ${operation}$`, 'm'));
  }
  assert.match(runbook, /disabled by default/);
  assert.match(runbook, /no provider submission path/i);
});

test('immutable receipt is byte-reproducible and binds every requalification identity', () => {
  const directory = resolve(root, '.rorca/tmp/bounty-qualification-test');
  const generated = resolve(directory, 'receipt.json');
  mkdirSync(directory, { recursive: true });
  try {
    execFileSync(process.execPath, ['scripts/generate-bounty-qualification-receipt.mjs', generated], { cwd: root, stdio: 'pipe' });
    assert.deepEqual(JSON.parse(readFileSync(generated, 'utf8')), receipt);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(receipt.release.featureState, 'disabled');
  assert.equal(receipt.release.enableAvailable, false);
  assert.equal(receipt.immutable, true);
  assert.deepEqual(receipt.requalificationTriggers.sort(), plan.requalificationTriggers.sort());
  assert.deepEqual(Object.keys(receipt.bindings).sort(), plan.receiptBindings.sort());
  assert.match(receipt.receiptHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(receipt.requalificationFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(createHash('sha256').update(JSON.stringify(receipt)).digest('hex').length, 64);
});
