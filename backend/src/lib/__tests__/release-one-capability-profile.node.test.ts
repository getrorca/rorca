/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  RELEASE_ONE_CAPABILITY_PROFILE,
  getReleaseOneCapability,
} from '../release-one-capability-profile';

type FailureClass = 'supervised_core' | 'disabled_future_capability' | 'harness_or_corpus';

interface FailureClassification {
  schemaVersion: string;
  source: {
    sha256: string;
    failedSuites: number;
    failedTests: number;
    totalSuites: number;
    totalTests: number;
  };
  entries: Array<{
    suite: string;
    failedAssertions: number;
    suiteRuntimeFailure: boolean;
    primaryClass: FailureClass;
    classes: FailureClass[];
    capabilityIds: string[];
    disposition: 'must_fix_green' | 'replace_with_fail_closed_test' | 'mixed_fix_and_fail_closed';
    rationale: string;
  }>;
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const classificationPath = path.join(
  repositoryRoot,
  'docs/release-certification/release-1-f2-broad-classification.json',
);

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function readClassification(): FailureClassification {
  return JSON.parse(readFileSync(classificationPath, 'utf8')) as FailureClassification;
}

test('Release-1 profile is explicit, fail-closed, and preserves human authority boundaries', () => {
  assert.equal(RELEASE_ONE_CAPABILITY_PROFILE.schemaVersion, 'rorca.release-one-capabilities.v1');
  assert.equal(RELEASE_ONE_CAPABILITY_PROFILE.profileId, 'release-1-supervised-core');
  assert.equal(RELEASE_ONE_CAPABILITY_PROFILE.roadmapAuthority, 'Linear ROR-21');

  const ids = RELEASE_ONE_CAPABILITY_PROFILE.capabilities.map((capability) => capability.id);
  assert.equal(new Set(ids).size, ids.length, 'capability IDs must be unique');

  const required = RELEASE_ONE_CAPABILITY_PROFILE.capabilities.filter((capability) => capability.state === 'required');
  const disabled = RELEASE_ONE_CAPABILITY_PROFILE.capabilities.filter((capability) => capability.state === 'disabled');
  const humanOnly = RELEASE_ONE_CAPABILITY_PROFILE.capabilities.filter((capability) => capability.state === 'human_only');
  assert.ok(required.length > 0);
  assert.ok(disabled.length > 0);
  assert.ok(humanOnly.length > 0);
  assert.ok(disabled.every((capability) => capability.enforcement === 'fail_closed'));
  assert.ok(humanOnly.every((capability) => capability.enforcement === 'external_human_authority'));

  for (const id of [
    'authorized_spec_authoring',
    'provider_human_approval',
    'bounded_task_manifest',
    'isolated_worktree_execution',
    'trusted_validation_closeout',
    'github_app_draft_pr_check',
    'learning_memory',
  ]) {
    assert.equal(getReleaseOneCapability(id).state, 'required');
  }
  for (const id of [
    'deployment_promotion',
    'autonomous_provider_merge',
    'auto_merge',
    'protected_branch_direct_update',
    'branch_only_external_push',
    'unattended_control_plane_mutation',
    'ambient_credential_injection',
    'scheduled_autonomy',
    'repair_autonomy',
    'high_risk_parallel_autonomy',
    'local_user_execution_bridge',
  ]) {
    assert.equal(getReleaseOneCapability(id).state, 'disabled');
  }
});

test('F2 classification maps all 104 failed suites without waivers or silent exclusions', () => {
  const classification = readClassification();
  assert.equal(classification.schemaVersion, 'rorca.release-one-f2-classification.v1');
  assert.equal(classification.source.failedSuites, 104);
  assert.equal(classification.source.failedTests, 479);
  assert.equal(classification.source.totalSuites, 439);
  assert.equal(classification.source.totalTests, 4906);
  assert.equal(classification.entries.length, 104);

  const suites = classification.entries.map((entry) => entry.suite);
  assert.equal(new Set(suites).size, suites.length, 'every failed suite must have exactly one mapping');
  assert.ok(suites.every((suite) => suite.startsWith('backend/') && !path.isAbsolute(suite)));
  assert.equal(
    classification.entries.reduce((sum, entry) => sum + entry.failedAssertions, 0),
    479,
  );

  for (const entry of classification.entries) {
    assert.ok(entry.classes.includes(entry.primaryClass));
    assert.ok(entry.classes.length > 0);
    assert.ok(entry.capabilityIds.length > 0);
    assert.ok(entry.rationale.trim().length >= 24);
    for (const capabilityId of entry.capabilityIds) getReleaseOneCapability(capabilityId);
    if (entry.classes.includes('disabled_future_capability')) {
      assert.ok(entry.capabilityIds.some((id) => getReleaseOneCapability(id).state === 'disabled'));
      assert.notEqual(entry.disposition, 'must_fix_green');
    } else {
      assert.equal(entry.disposition, 'must_fix_green');
    }
  }
});

test('checked-in F2 mapping binds exactly to the machine broad result when provided', () => {
  const resultPath = process.env.RORCA_F2_BROAD_JSON;
  if (!resultPath) return;

  const bytes = readFileSync(resultPath);
  const results = JSON.parse(bytes.toString('utf8')) as {
    numFailedTestSuites: number;
    numFailedTests: number;
    numTotalTestSuites: number;
    numTotalTests: number;
    testResults: Array<{
      name: string;
      status: string;
      assertionResults: Array<{ status: string }>;
    }>;
  };
  const classification = readClassification();
  assert.equal(sha256(bytes), classification.source.sha256);
  assert.equal(results.numFailedTestSuites, classification.source.failedSuites);
  assert.equal(results.numFailedTests, classification.source.failedTests);
  assert.equal(results.numTotalTestSuites, classification.source.totalSuites);
  assert.equal(results.numTotalTests, classification.source.totalTests);

  const actual = results.testResults
    .filter((suite) => suite.status === 'failed')
    .map((suite) => ({
      suite: path.relative(repositoryRoot, suite.name),
      failedAssertions: suite.assertionResults.filter((assertion) => assertion.status === 'failed').length,
      suiteRuntimeFailure: !suite.assertionResults.some((assertion) => assertion.status === 'failed'),
    }))
    .sort((left, right) => left.suite.localeCompare(right.suite));
  const mapped = classification.entries
    .map(({ suite, failedAssertions, suiteRuntimeFailure }) => ({ suite, failedAssertions, suiteRuntimeFailure }))
    .sort((left, right) => left.suite.localeCompare(right.suite));
  assert.deepEqual(mapped, actual);
});
