#!/usr/bin/env node
/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  canonicalJson,
  loadGateDefinition,
  runCertification,
  snapshotRepository,
  validateGateDefinition,
} from '../release-one-certification.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const productionDefinition = path.join(repositoryRoot, 'config/release-one-certification-gates.json');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeRepository(root, name) {
  const repo = path.join(root, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'certification@example.test');
  git(repo, 'config', 'user.name', 'Certification Test');
  fs.writeFileSync(path.join(repo, 'README.md'), `${name}\n`);
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-m', 'fixture');
  return repo;
}

function writeDefinition(root, gates) {
  const definition = {
    schemaVersion: 'rorca.release-one-certification-gates.v1',
    profileId: 'release-1-supervised-core',
    roadmapAuthority: 'Linear ROR-21',
    phases: {
      gate0: { requireCleanRepositories: false, gateIds: gates.map((gate) => gate.id) },
      gate1: { requireCleanRepositories: true, gateIds: gates.map((gate) => gate.id) },
    },
    gates,
  };
  const file = path.join(root, 'gates.json');
  fs.writeFileSync(file, `${JSON.stringify(definition, null, 2)}\n`);
  return file;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('production gate definition is dependency ordered, complete, and contains no publication actuator', () => {
  const definition = loadGateDefinition(productionDefinition);
  validateGateDefinition(definition);

  assert.equal(definition.schemaVersion, 'rorca.release-one-certification-gates.v1');
  assert.equal(definition.profileId, 'release-1-supervised-core');
  assert.equal(definition.roadmapAuthority, 'Linear ROR-21');
  assert.equal(new Set(definition.gates.map((gate) => gate.id)).size, definition.gates.length);

  const gate0 = new Set(definition.phases.gate0.gateIds);
  const gate1 = new Set(definition.phases.gate1.gateIds);
  for (const required of [
    'capability-profile-regenerate',
    'rorca-supervised-disabled-profile',
    'hermes-supervised-profile',
    'rorca-static-contracts',
    'migration-real-postgres',
    'hermes-build',
    'rorca-build',
    'live-built-pair',
    'pair-diff-audit',
  ]) assert.ok(gate0.has(required), `Gate 0 is missing ${required}`);
  for (const required of [
    'real-pgboss-runtime',
    'sandbox-egress-containment',
    'release-image-build',
    'classified-broad-harness',
  ]) assert.ok(gate1.has(required), `Gate 1 is missing ${required}`);

  const serializedCommands = definition.gates
    .flatMap((gate) => gate.steps ?? [{ command: gate.command, args: gate.args ?? [] }])
    .map((step) => [step.command, ...(step.args ?? [])].join(' '))
    .join('\n');
  assert.match(serializedCommands, /split:check -- --candidate --report-review-boundary/);
  assert.match(serializedCommands, /check-opencore-export\.test\.mjs/);
  assert.doesNotMatch(serializedCommands, /--allow-review/);
  for (const forbidden of [
    /\bgit\s+push\b/i,
    /\bnpm\s+publish\b/i,
    /\bdocker\s+push\b/i,
    /\bgh\s+pr\b/i,
    /\bkubectl\b/i,
    /\bcurl\b[^\n]*\b(?:POST|PUT|PATCH|DELETE)\b/i,
  ]) assert.doesNotMatch(serializedCommands, forbidden);
});

test('repository snapshot binds dirty tracked and untracked content without changing it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-one-cert-snapshot-'));
  try {
    const repo = makeRepository(root, 'repo');
    fs.appendFileSync(path.join(repo, 'README.md'), 'dirty\n');
    fs.writeFileSync(path.join(repo, 'new.txt'), 'untracked\n');
    const before = git(repo, 'status', '--porcelain=v1', '-z', '--untracked-files=all');
    const snapshot = snapshotRepository(repo);
    const after = git(repo, 'status', '--porcelain=v1', '-z', '--untracked-files=all');

    assert.equal(snapshot.clean, false);
    assert.equal(snapshot.head, git(repo, 'rev-parse', 'HEAD'));
    assert.equal(snapshot.tree, git(repo, 'rev-parse', 'HEAD^{tree}'));
    assert.equal(snapshot.statusEntries, 2);
    assert.deepEqual(snapshot.untrackedFiles.map((entry) => entry.path), ['new.txt']);
    assert.match(snapshot.worktreeContentSha256, /^[0-9a-f]{64}$/);
    assert.equal(after, before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runner fails fast, hashes exact logs, and writes a self-binding partial result', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-one-cert-fail-fast-'));
  try {
    const rorcaRoot = makeRepository(root, 'rorca');
    const hermesRoot = makeRepository(root, 'hermes');
    const marker = path.join(root, 'must-not-run');
    const definitionPath = writeDefinition(root, [
      {
        id: 'first-fails', repo: 'rorca', command: '{node}',
        args: ['--eval', "process.stdout.write('exact-first-log\\n'); process.exit(7)"], timeoutMs: 5_000,
      },
      {
        id: 'second-must-not-run', repo: 'hermes', command: '{node}',
        args: ['--eval', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe')`], timeoutMs: 5_000,
      },
    ]);
    const outputDir = path.join(root, 'evidence');
    const result = await runCertification({
      phase: 'gate0', definitionPath, rorcaRoot, hermesRoot, outputDir,
      credentialFile: path.join(root, 'unused-test-db.env'),
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.gates.length, 1);
    assert.equal(result.gates[0].id, 'first-fails');
    assert.equal(result.gates[0].exitCode, 7);
    assert.equal(fs.existsSync(marker), false, 'fail-fast runner executed a later gate');
    const log = fs.readFileSync(path.join(outputDir, result.gates[0].log.path));
    assert.match(log.toString('utf8'), /exact-first-log/);
    assert.equal(result.gates[0].log.sha256, sha256(log));

    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, 'pair-manifest.json'), 'utf8'));
    const { payloadSha256, ...unsigned } = manifest;
    assert.equal(payloadSha256, sha256(canonicalJson(unsigned)));
    assert.equal(
      fs.readFileSync(path.join(outputDir, 'pair-manifest.json.sha256'), 'utf8').trim().split(/\s+/)[0],
      sha256(fs.readFileSync(path.join(outputDir, 'pair-manifest.json'))),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('broad classifier preserves unknown failures and rejects silent skips', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-one-broad-classifier-'));
  try {
    const baseline = path.join(root, 'baseline.json');
    const results = path.join(root, 'results.json');
    const output = path.join(root, 'output');
    fs.writeFileSync(baseline, JSON.stringify({ entries: [] }));
    fs.writeFileSync(results, JSON.stringify({
      success: false,
      numTotalTestSuites: 1,
      numPassedTestSuites: 0,
      numFailedTestSuites: 1,
      numPendingTestSuites: 0,
      numTotalTests: 2,
      numPassedTests: 0,
      numFailedTests: 1,
      numPendingTests: 1,
      numTodoTests: 0,
      testResults: [{
        name: path.join(repositoryRoot, 'backend/src/__tests__/candidate-current-unknown.test.ts'),
        status: 'failed',
        assertionResults: [
          { status: 'failed', title: 'candidate finding', ancestorTitles: ['unknown'] },
          { status: 'pending', title: 'quietly skipped', ancestorTitles: ['unknown'] },
        ],
      }],
    }));
    const execution = spawnSync(process.execPath, [
      path.join(repositoryRoot, 'scripts/run-release-one-broad-certification.mjs'),
      '--output', output,
      '--baseline', baseline,
      '--results', results,
    ], { cwd: repositoryRoot, encoding: 'utf8' });
    assert.equal(execution.status, 1);
    const classification = JSON.parse(fs.readFileSync(path.join(output, 'classification.json'), 'utf8'));
    assert.equal(classification.status, 'failed');
    assert.equal(classification.policy.everyFailureClassified, false);
    assert.equal(classification.policy.everySkipHasDetectorReason, false);
    assert.equal(classification.failures[0].classification.primaryClass, 'unclassified');
    assert.equal(classification.skips[0].explicitReason, false);
    assert.equal(fs.existsSync(path.join(output, 'jest-results.json')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Gate 1 rejects a dirty repository before any command runs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-one-cert-clean-'));
  try {
    const rorcaRoot = makeRepository(root, 'rorca');
    const hermesRoot = makeRepository(root, 'hermes');
    fs.appendFileSync(path.join(hermesRoot, 'README.md'), 'dirty\n');
    const marker = path.join(root, 'must-not-run');
    const definitionPath = writeDefinition(root, [{
      id: 'must-not-run', repo: 'rorca', command: '{node}',
      args: ['--eval', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe')`], timeoutMs: 5_000,
    }]);
    const outputDir = path.join(root, 'evidence');

    const result = await runCertification({
      phase: 'gate1', definitionPath, rorcaRoot, hermesRoot, outputDir,
      credentialFile: path.join(root, 'unused-test-db.env'),
    });
    assert.equal(result.status, 'failed');
    assert.match(result.failure.message, /clean repositories/);
    assert.equal(result.gates.length, 0);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
