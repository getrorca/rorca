#!/usr/bin/env node
/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`Invalid argument sequence near ${key ?? '(end)'}`);
    values[key.slice(2)] = value;
  }
  if (!values.output || !values.baseline) throw new Error('Usage: run-release-one-broad-certification.mjs --output <dir> --baseline <classification.json>');
  return values;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizeSuite(repositoryRoot, absoluteName) {
  const relative = path.relative(repositoryRoot, absoluteName).replaceAll(path.sep, '/');
  if (!relative.startsWith('../') && relative !== '..') return relative;
  const normalized = absoluteName.replaceAll('\\', '/');
  const marker = '/backend/';
  const offset = normalized.lastIndexOf(marker);
  if (offset >= 0) return `backend/${normalized.slice(offset + marker.length)}`;
  throw new Error(`Broad suite is outside the Rorca repository: ${absoluteName}`);
}

const args = parseArgs(process.argv.slice(2));
const repositoryRoot = path.resolve(import.meta.dirname, '..');
const backendRoot = path.join(repositoryRoot, 'backend');
const outputDir = path.resolve(args.output);
const generatedResultPath = path.join(outputDir, 'jest-results.json');
const resultPath = args.results ? path.resolve(args.results) : generatedResultPath;
const classificationPath = path.join(outputDir, 'classification.json');
const baselinePath = path.resolve(repositoryRoot, args.baseline);
fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });

function aggregateShardResults(shards, startedAt) {
  const sum = (key) => shards.reduce((total, shard) => total + Number(shard[key] ?? 0), 0);
  const snapshotNumber = (key) => shards.reduce((total, shard) => total + Number(shard.snapshot?.[key] ?? 0), 0);
  const results = shards.flatMap((shard) => shard.testResults ?? [])
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
  return {
    numFailedTestSuites: sum('numFailedTestSuites'),
    numFailedTests: sum('numFailedTests'),
    numPassedTestSuites: sum('numPassedTestSuites'),
    numPassedTests: sum('numPassedTests'),
    numPendingTestSuites: sum('numPendingTestSuites'),
    numPendingTests: sum('numPendingTests'),
    numRuntimeErrorTestSuites: sum('numRuntimeErrorTestSuites'),
    numTodoTests: sum('numTodoTests'),
    numTotalTestSuites: sum('numTotalTestSuites'),
    numTotalTests: sum('numTotalTests'),
    openHandles: shards.flatMap((shard) => shard.openHandles ?? []),
    snapshot: {
      added: snapshotNumber('added'),
      didUpdate: shards.some((shard) => shard.snapshot?.didUpdate === true),
      failure: shards.some((shard) => shard.snapshot?.failure === true),
      filesAdded: snapshotNumber('filesAdded'),
      filesRemoved: snapshotNumber('filesRemoved'),
      filesRemovedList: shards.flatMap((shard) => shard.snapshot?.filesRemovedList ?? []),
      filesUnmatched: snapshotNumber('filesUnmatched'),
      filesUpdated: snapshotNumber('filesUpdated'),
      matched: snapshotNumber('matched'),
      total: snapshotNumber('total'),
      unchecked: snapshotNumber('unchecked'),
      uncheckedKeysByFile: shards.flatMap((shard) => shard.snapshot?.uncheckedKeysByFile ?? []),
      unmatched: snapshotNumber('unmatched'),
      updated: snapshotNumber('updated'),
    },
    startTime: startedAt,
    success: shards.every((shard) => shard.success === true),
    testResults: results,
    wasInterrupted: shards.some((shard) => shard.wasInterrupted === true),
  };
}

let jest;
if (args.results) {
  if (!fs.existsSync(resultPath)) throw new Error(`Provided Jest result does not exist: ${resultPath}`);
  const supplied = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  jest = { status: supplied.success === true ? 0 : 1, signal: null };
  fs.copyFileSync(resultPath, generatedResultPath);
} else {
  const jestBin = path.join(backendRoot, 'node_modules/jest/bin/jest.js');
  const listed = spawnSync(process.execPath, [jestBin, '--listTests', '--json'], {
    cwd: backendRoot,
    env: process.env,
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (listed.status !== 0 || !listed.stdout) {
    throw new Error(`Unable to enumerate broad Jest suites; status=${listed.status ?? 'null'} signal=${listed.signal ?? 'none'} stderr=${listed.stderr ?? ''}`);
  }
  const testFiles = JSON.parse(listed.stdout).map((file) => path.resolve(file)).sort();
  if (testFiles.length === 0) throw new Error('Broad Jest enumeration returned no suites');
  // One suite per process is deliberate. Several legacy integration suites retain
  // multi-gigabyte transformed module graphs; grouping even two can OOM and lose
  // the machine-readable result instead of reporting the actual assertion state.
  const batchSize = 1;
  const batches = [];
  for (let offset = 0; offset < testFiles.length; offset += batchSize) {
    batches.push(testFiles.slice(offset, offset + batchSize));
  }
  const shardResults = [];
  const startedAt = Date.now();
  let status = 0;
  let signal = null;
  for (let shard = 1; shard <= batches.length; shard += 1) {
    const prefix = `batch-${String(shard).padStart(3, '0')}-of-${batches.length}`;
    const shardPath = path.join(outputDir, `jest-results.${prefix}.json`);
    const shardLogPath = path.join(outputDir, `jest.${prefix}.log`);
    console.log(`Release-1 broad Jest batch ${shard}/${batches.length} (${batches[shard - 1].length} suites)`);
    const shardLogFd = fs.openSync(shardLogPath, 'wx', 0o600);
    const outcome = spawnSync(process.execPath, [
      '--max-old-space-size=8192',
      jestBin,
      ...batches[shard - 1],
      '--runInBand',
      '--no-cache',
      '--detectOpenHandles',
      '--json',
      `--outputFile=${shardPath}`,
    ], {
      cwd: backendRoot,
      env: process.env,
      stdio: ['ignore', shardLogFd, shardLogFd],
      timeout: 900_000,
    });
    fs.closeSync(shardLogFd);
    if (outcome.status !== 0) status = outcome.status || 1;
    if (outcome.signal && !signal) signal = outcome.signal;
    if (!fs.existsSync(shardPath)) {
      throw new Error(`Broad Jest batch ${shard}/${batches.length} produced no result; status=${outcome.status ?? 'null'} signal=${outcome.signal ?? 'none'}`);
    }
    const shardResult = JSON.parse(fs.readFileSync(shardPath, 'utf8'));
    shardResults.push(shardResult);
    console.log(`Release-1 broad Jest batch ${shard}/${batches.length} status=${shardResult.success ? 'passed' : 'failed'} suites=${shardResult.numTotalTestSuites} tests=${shardResult.numTotalTests}`);
  }
  const aggregate = aggregateShardResults(shardResults, startedAt);
  fs.writeFileSync(generatedResultPath, `${JSON.stringify(aggregate)}\n`, { mode: 0o600 });
  jest = { status: aggregate.success && status === 0 ? 0 : (status || 1), signal };
}

if (!fs.existsSync(generatedResultPath)) {
  console.error(`Broad Jest did not produce ${generatedResultPath}; status=${jest.status ?? 'null'} signal=${jest.signal ?? 'none'}`);
  process.exit(jest.status || 1);
}

const resultBytes = fs.readFileSync(generatedResultPath);
const results = JSON.parse(resultBytes.toString('utf8'));
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const baselineBySuite = new Map(baseline.entries.map((entry) => [entry.suite, entry]));
const failures = [];
const skips = [];

for (const suite of results.testResults ?? []) {
  const suitePath = normalizeSuite(repositoryRoot, suite.name);
  if (suite.status === 'failed') {
    const prior = baselineBySuite.get(suitePath);
    failures.push({
      suite: suitePath,
      failedAssertions: (suite.assertionResults ?? []).filter((assertion) => assertion.status === 'failed').length,
      suiteRuntimeFailure: !(suite.assertionResults ?? []).some((assertion) => assertion.status === 'failed'),
      classification: prior
        ? {
            primaryClass: prior.primaryClass,
            classes: prior.classes,
            disposition: prior.disposition,
            capabilityIds: prior.capabilityIds,
            rationale: prior.rationale,
          }
        : {
            primaryClass: 'unclassified',
            classes: ['unclassified'],
            disposition: 'must_triage_before_release',
            capabilityIds: [],
            rationale: 'Candidate-current failure was absent from the evidence-bound F2 baseline and must be classified before release.',
          },
    });
  }
  for (const assertion of suite.assertionResults ?? []) {
    if (!['pending', 'skipped', 'todo', 'disabled'].includes(assertion.status)) continue;
    const title = [...(assertion.ancestorTitles ?? []), assertion.title ?? ''].filter(Boolean).join(' > ');
    const explicitReason = /(?:unavailable|unsupported|not installed|requires|platform|fixture|detector|opt[ -]?in)/i.test(title);
    skips.push({ suite: suitePath, title, status: assertion.status, explicitReason });
  }
}
failures.sort((left, right) => left.suite.localeCompare(right.suite));
skips.sort((left, right) => left.suite.localeCompare(right.suite) || left.title.localeCompare(right.title));

const unclassifiedFailures = failures.filter((failure) => failure.classification.primaryClass === 'unclassified').length;
const silentSkips = skips.filter((skip) => !skip.explicitReason).length;
const openHandleCount = Array.isArray(results.openHandles) ? results.openHandles.length : 0;
const runtimeErrorSuites = Number(results.numRuntimeErrorTestSuites ?? 0);
const wasInterrupted = results.wasInterrupted === true;
const passed = Number(results.numFailedTestSuites ?? failures.length) === 0
  && Number(results.numFailedTests ?? 0) === 0
  && runtimeErrorSuites === 0
  && !wasInterrupted
  && openHandleCount === 0
  && unclassifiedFailures === 0
  && silentSkips === 0
  && jest.status === 0;
const classification = {
  schemaVersion: 'rorca.release-one-current-broad-result.v1',
  profileId: 'release-1-supervised-core',
  roadmapAuthority: 'Linear ROR-21',
  status: passed ? 'passed' : 'failed',
  result: {
    sha256: sha256(resultBytes),
    suites: {
      total: results.numTotalTestSuites,
      passed: results.numPassedTestSuites,
      failed: results.numFailedTestSuites,
      pending: results.numPendingTestSuites,
    },
    tests: {
      total: results.numTotalTests,
      passed: results.numPassedTests,
      failed: results.numFailedTests,
      pending: results.numPendingTests,
      todo: results.numTodoTests,
    },
    runtimeErrorSuites,
    openHandles: openHandleCount,
    wasInterrupted,
    jestExitCode: jest.status,
    jestSignal: jest.signal,
  },
  policy: {
    everyFailureClassified: unclassifiedFailures === 0,
    everySkipHasDetectorReason: silentSkips === 0,
    noDetectedOpenHandles: openHandleCount === 0,
    noRuntimeErrors: runtimeErrorSuites === 0,
    runCompleted: !wasInterrupted,
    failuresAreReleaseBlocking: true,
    futureCapabilitiesAreNeverImplementedToSatisfyThisGate: true,
  },
  failures,
  skips,
};
fs.writeFileSync(classificationPath, `${JSON.stringify(classification, null, 2)}\n`, { mode: 0o600 });
console.log(`Release-1 broad classification: ${classification.status}; failures=${failures.length}; unclassified=${unclassifiedFailures}; skips=${skips.length}; silentSkips=${silentSkips}`);
process.exit(passed ? 0 : (jest.status || 1));
