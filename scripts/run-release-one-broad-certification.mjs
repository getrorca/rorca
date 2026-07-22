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

let jest;
if (args.results) {
  if (!fs.existsSync(resultPath)) throw new Error(`Provided Jest result does not exist: ${resultPath}`);
  const supplied = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  jest = { status: supplied.success === true ? 0 : 1, signal: null };
  fs.copyFileSync(resultPath, generatedResultPath);
} else {
  jest = spawnSync(process.execPath, [
    '--max-old-space-size=8192',
    path.join(backendRoot, 'node_modules/jest/bin/jest.js'),
    '--runInBand',
    '--no-cache',
    '--detectOpenHandles',
    '--json',
    `--outputFile=${generatedResultPath}`,
  ], {
    cwd: backendRoot,
    env: process.env,
    stdio: 'inherit',
    timeout: 3_300_000,
  });
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
const passed = Number(results.numFailedTestSuites ?? failures.length) === 0
  && Number(results.numFailedTests ?? 0) === 0
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
    jestExitCode: jest.status,
    jestSignal: jest.signal,
  },
  policy: {
    everyFailureClassified: unclassifiedFailures === 0,
    everySkipHasDetectorReason: silentSkips === 0,
    failuresAreReleaseBlocking: true,
    futureCapabilitiesAreNeverImplementedToSatisfyThisGate: true,
  },
  failures,
  skips,
};
fs.writeFileSync(classificationPath, `${JSON.stringify(classification, null, 2)}\n`, { mode: 0o600 });
console.log(`Release-1 broad classification: ${classification.status}; failures=${failures.length}; unclassified=${unclassifiedFailures}; skips=${skips.length}; silentSkips=${silentSkips}`);
process.exit(passed ? 0 : (jest.status || 1));
