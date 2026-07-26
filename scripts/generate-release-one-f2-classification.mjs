#!/usr/bin/env node
/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const EXPECTED = Object.freeze({
  sha256: 'aa84326a096eb448e3fd62a199817f7664c222212574dc48a84b9445c9f1ecaa',
  failedSuites: 104,
  failedTests: 479,
  totalSuites: 439,
  totalTests: 4906,
});

const supervisedCore = new Set([
  'backend/src/__tests__/opencode-integration.test.ts',
  'backend/src/__tests__/QRW-010-pipeline-trigger-workflow-config.test.ts',
  'backend/src/routes/__tests__/worktrees.test.ts',
  'backend/src/routes/__tests__/execution-environments.test.ts',
  'backend/src/lib/__tests__/execution-environment-registry.test.ts',
  'backend/src/lib/__tests__/execution-engine-closeout.test.ts',
  'backend/src/lib/__tests__/ssdlc-pass-reconciler.test.ts',
  'backend/src/lib/__tests__/release-reconciler-state-transitions.test.ts',
  'backend/src/lib/__tests__/main-reconciliation-collision.test.ts',
  'backend/src/__tests__/golden-terminal-parity.test.ts',
  'backend/src/lib/__tests__/context-distillation.test.ts',
  'backend/src/lib/__tests__/plan-gate-default-deny.test.ts',
  'backend/src/lib/__tests__/release-restart-reconciliation.test.ts',
  'backend/src/routes/__tests__/team-rls.test.ts',
  'backend/src/__tests__/CLI-019-pi-rpc-retry-context.test.ts',
  'backend/src/lib/__tests__/pi-parity.test.ts',
  'backend/src/routes/__tests__/security-audit.test.ts',
]);

const disabledBySuite = new Map([
  ['backend/src/__tests__/opencode-integration.test.ts', ['warm_shared_agent_server']],
  ['backend/src/routes/__tests__/auto-merge-pipeline.test.ts', ['autonomous_provider_merge', 'auto_merge', 'manual_worktree_merge_surface']],
  ['backend/src/__tests__/QRW-010-pipeline-trigger-workflow-config.test.ts', ['ambient_credential_injection']],
  ['backend/src/routes/__tests__/worktrees.test.ts', ['manual_worktree_merge_surface', 'branch_only_external_push']],
  ['backend/src/db/__tests__/autonomous-reviewed-delivery-migration.test.ts', ['autonomous_provider_merge', 'auto_merge']],
  ['backend/src/lib/__tests__/release-reconciler-state-transitions.test.ts', ['branch_only_external_push']],
  ['backend/src/routes/__tests__/retry-merge.test.ts', ['manual_worktree_merge_surface', 'autonomous_provider_merge']],
  ['backend/src/db/__tests__/autonomous-delivery-governance-migration.test.ts', ['autonomous_provider_merge']],
  ['backend/src/lib/__tests__/main-reconciliation-collision.test.ts', ['local_user_execution_bridge']],
  ['backend/src/routes/__tests__/execution-environments.test.ts', ['local_user_execution_bridge']],
  ['backend/src/lib/__tests__/wave-integration-store.test.ts', ['high_risk_parallel_autonomy']],
  ['backend/src/lib/__tests__/execution-environment-registry.test.ts', ['local_user_execution_bridge']],
]);

function suitePath(absoluteName, repositoryRoot) {
  const relative = path.relative(repositoryRoot, absoluteName).replaceAll(path.sep, '/');
  if (!relative.startsWith('../') && relative !== '..') return relative;
  const marker = '/backend/';
  const index = absoluteName.replaceAll('\\', '/').lastIndexOf(marker);
  if (index >= 0) return `backend/${absoluteName.replaceAll('\\', '/').slice(index + marker.length)}`;
  throw new Error(`Broad result suite is outside the Rorca repository: ${absoluteName}`);
}

function add(capabilities, ...ids) {
  for (const id of ids) capabilities.add(id);
}

function capabilityIdsFor(suite) {
  const capabilities = new Set(['platform_integrity']);
  const lower = suite.toLowerCase();

  if (/(spec|author|template|stories|story-comments|tags|direction|onboarding|convention)/.test(lower)) {
    add(capabilities, 'authorized_spec_authoring');
  }
  if (/(context|memory|graph|hilo|hydrate|events-candidates)/.test(lower)) {
    add(capabilities, 'approved_context_evidence', 'learning_memory');
  }
  if (/(pipeline|queue|worker|retry|execution|pty|opencode|pi-|pi_|hook|wave)/.test(lower)) {
    add(capabilities, 'bounded_task_manifest', 'trusted_validation_closeout');
  }
  if (/(worktree|git-|story-commits|release)/.test(lower)) {
    add(capabilities, 'isolated_worktree_execution', 'host_enforced_scope');
  }
  if (/(github|webhook|pr-|pr-body|release-reconciler)/.test(lower)) {
    add(capabilities, 'github_app_draft_pr_check', 'human_merge_observation');
  }
  if (/(retry)/.test(lower)) add(capabilities, 'supervised_retry');
  if (/(analytics|budget|token-usage|health|activity|notification|settings|billing|backup)/.test(lower)) {
    add(capabilities, 'operator_diagnostics');
  }
  if (lower.includes('/mcp/')) add(capabilities, 'mcp_local_automation');
  if (/(approval|lifecycle-decision)/.test(lower)) add(capabilities, 'provider_human_approval');

  for (const id of disabledBySuite.get(suite) ?? []) capabilities.add(id);
  return [...capabilities].sort();
}

function classify(suite, suiteRuntimeFailure) {
  const disabled = disabledBySuite.has(suite);
  const core = supervisedCore.has(suite);
  const classes = [];
  if (core) classes.push('supervised_core');
  if (disabled) classes.push('disabled_future_capability');
  if (!core || disabled || suiteRuntimeFailure) classes.push('harness_or_corpus');

  const primaryClass = core
    ? 'supervised_core'
    : disabled
      ? 'disabled_future_capability'
      : 'harness_or_corpus';
  const disposition = disabled
    ? core
      ? 'mixed_fix_and_fail_closed'
      : 'replace_with_fail_closed_test'
    : 'must_fix_green';
  return { primaryClass, classes: [...new Set(classes)], disposition };
}

function rationaleFor(suite, classification, suiteRuntimeFailure) {
  const label = path.basename(suite);
  if (classification.classes.includes('disabled_future_capability')) {
    const mixed = classification.classes.includes('supervised_core');
    return mixed
      ? `${label} mixes supervised closeout behavior with an explicitly excluded Release-1 actuator; repair the supervised path and replace excluded expectations with production fail-closed evidence.`
      : `${label} exercises an explicitly excluded Release-1 capability or stale compatibility expectation; production must reject it before side effects and the suite must prove that denial.`;
  }
  if (classification.primaryClass === 'supervised_core') {
    return `${label} challenges an authority, closeout, security, or execution invariant on the supervised critical path; fix the production root cause and retain adversarial green evidence.`;
  }
  if (suiteRuntimeFailure) {
    return `${label} failed to compile or complete under the candidate-current broad harness; repair the test corpus or harness without relaxing any production type, isolation, or authority check.`;
  }
  return `${label} is attributed to stale fixtures, mocks, retained append-only state, or another harness/corpus mismatch; repair it to green without weakening candidate-current production behavior.`;
}

const [inputArg, outputArg] = process.argv.slice(2);
if (!inputArg || !outputArg) {
  console.error('Usage: generate-release-one-f2-classification.mjs <jest-results.json> <output.json>');
  process.exit(2);
}

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const bytes = readFileSync(path.resolve(inputArg));
const digest = createHash('sha256').update(bytes).digest('hex');
const results = JSON.parse(bytes.toString('utf8'));
for (const [field, expected] of Object.entries({
  failedSuites: results.numFailedTestSuites,
  failedTests: results.numFailedTests,
  totalSuites: results.numTotalTestSuites,
  totalTests: results.numTotalTests,
})) {
  if (expected !== EXPECTED[field]) throw new Error(`Unexpected ${field}: ${expected}; expected ${EXPECTED[field]}`);
}
if (digest !== EXPECTED.sha256) throw new Error(`Unexpected broad-result digest: ${digest}`);

const entries = results.testResults
  .filter((suite) => suite.status === 'failed')
  .map((suite) => {
    const normalizedSuite = suitePath(suite.name, repositoryRoot);
    const failedAssertions = suite.assertionResults.filter((assertion) => assertion.status === 'failed').length;
    const suiteRuntimeFailure = failedAssertions === 0;
    const classification = classify(normalizedSuite, suiteRuntimeFailure);
    return {
      suite: normalizedSuite,
      failedAssertions,
      suiteRuntimeFailure,
      ...classification,
      capabilityIds: capabilityIdsFor(normalizedSuite),
      rationale: rationaleFor(normalizedSuite, classification, suiteRuntimeFailure),
    };
  })
  .sort((left, right) => left.suite.localeCompare(right.suite));

if (entries.length !== EXPECTED.failedSuites) throw new Error(`Expected ${EXPECTED.failedSuites} failed suites, got ${entries.length}`);
if (new Set(entries.map((entry) => entry.suite)).size !== entries.length) throw new Error('Duplicate failed suite mapping');
if (entries.reduce((sum, entry) => sum + entry.failedAssertions, 0) !== EXPECTED.failedTests) {
  throw new Error('Failed assertion total does not match the broad result');
}

const output = {
  schemaVersion: 'rorca.release-one-f2-classification.v1',
  profileId: 'release-1-supervised-core',
  roadmapAuthority: 'Linear ROR-21',
  generatedAt: '2026-07-22T19:45:00.000Z',
  source: {
    resultFile: path.basename(inputArg),
    logFile: 'rorca-f2-broad-rerun1.log',
    sha256: digest,
    repositoryHead: '925808d23f6ea388f848e9e8fb9a48c501a1a291',
    failedSuites: results.numFailedTestSuites,
    failedTests: results.numFailedTests,
    passedSuites: results.numPassedTestSuites,
    passedTests: results.numPassedTests,
    pendingSuites: results.numPendingTestSuites,
    pendingTests: results.numPendingTests,
    totalSuites: results.numTotalTestSuites,
    totalTests: results.numTotalTests,
  },
  classificationPolicy: {
    supervised_core: 'In the Release-1 critical path; production and adversarial tests must be green.',
    disabled_future_capability: 'Excluded from Release-1; production must fail closed before side effects and the denial test must be green.',
    harness_or_corpus: 'The candidate-current production boundary remains; repair stale fixture, mock, isolation, compilation, or assertion behavior without weakening it.',
    noWaivers: true,
    noSilentSkips: true,
  },
  entries,
};

writeFileSync(path.resolve(outputArg), `${JSON.stringify(output, null, 2)}\n`, { encoding: 'utf8', flag: 'w', mode: 0o644 });
