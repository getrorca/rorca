/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  assertNotProtectedWave1Run,
  assertWave1CanonicalTarget,
  assertWave1DeploymentBinding,
  assertWave1ReconciliationSelector,
  WAVE_1_IMPLEMENTATION_BASELINE_SHA,
  WAVE_1_MANAGED_PROOF_RUN_ID,
  WAVE_1_PROTECTED_GENESIS_RUN_ID,
  WAVE_1_SOURCE_REPOSITORY,
  WAVE_1_SPEC_CONTENT_HASH,
  WAVE_1_SPEC_PATH,
} from '../wave-1-stabilization';

const deployment = {
  implementationBaselineSha: WAVE_1_IMPLEMENTATION_BASELINE_SHA,
  waveSpecRevision: WAVE_1_SPEC_CONTENT_HASH,
  sourceRepository: WAVE_1_SOURCE_REPOSITORY,
};

function expectReason(operation: () => unknown, reason: string): void {
  expect(operation).toThrow(expect.objectContaining({
    code: 'WAVE_1_INTAKE_BLOCKED',
    details: { reason },
  }));
}

test('checked fixture records the exact baseline, spec revision, proof run, and permanent deny list', () => {
  const fixture = JSON.parse(fs.readFileSync(path.resolve(
    __dirname,
    'fixtures',
    'wave-1-stabilization-contract.json',
  ), 'utf8')) as unknown;
  expect(fixture).toMatchObject({
    schemaVersion: 'rorca.wave-1-stabilization-contract.v1',
    implementationBaselineGitSha: WAVE_1_IMPLEMENTATION_BASELINE_SHA,
    sourceRepository: WAVE_1_SOURCE_REPOSITORY,
    waveSpec: {
      canonicalPath: WAVE_1_SPEC_PATH,
      contentHash: WAVE_1_SPEC_CONTENT_HASH,
    },
    isolatedLocalProof: {
      fixtureKind: 'disposable-synthetic-local-run',
      runIdentityPolicy: 'fresh-dynamic-non-protected',
      delivery: 'local-review-bundle',
      requiresNetwork: false,
      requiresCredentials: false,
      autoMerge: false,
      deploymentAllowed: false,
      approvalFabricationAllowed: false,
    },
    deferredManagedProof: {
      ineligibleRunId: WAVE_1_MANAGED_PROOF_RUN_ID,
      reconciliationEligibility: 'requires-separate-reviewed-merge-deployment-and-fresh-owner-authorization',
    },
    denyListedRunIds: [WAVE_1_PROTECTED_GENESIS_RUN_ID],
    authority: {
      approvalGranted: false,
      providerConsentGranted: false,
      mergeGranted: false,
      deploymentGranted: false,
      lifecycleMutationGranted: false,
    },
  });
});

test('permanent deny list wins before deployment or selector checks', () => {
  expectReason(
    () => assertWave1ReconciliationSelector(WAVE_1_PROTECTED_GENESIS_RUN_ID, null),
    'PROTECTED_GENESIS_RUN',
  );
  expectReason(
    () => assertNotProtectedWave1Run(WAVE_1_PROTECTED_GENESIS_RUN_ID),
    'PROTECTED_GENESIS_RUN',
  );
});

test('proof run remains ineligible without a separately issued exact deployment binding', () => {
  expectReason(
    () => assertWave1ReconciliationSelector(WAVE_1_MANAGED_PROOF_RUN_ID, null),
    'PROOF_DEPLOYMENT_AUTHORITY_REQUIRED',
  );
  expect(() => assertWave1ReconciliationSelector(WAVE_1_MANAGED_PROOF_RUN_ID, deployment)).not.toThrow();
});

test.each([
  [{ ...deployment, implementationBaselineSha: 'f'.repeat(40) }, 'BASELINE_MISMATCH'],
  [{ ...deployment, waveSpecRevision: `sha256:${'f'.repeat(64)}` }, 'SPEC_REVISION_MISMATCH'],
  [{ ...deployment, sourceRepository: 'https://github.com/attacker/fork.git' }, 'REPOSITORY_MISMATCH'],
] as const)('deployment binding fails closed with stable reason %#', (candidate, reason) => {
  expectReason(() => assertWave1DeploymentBinding(candidate), reason);
});

test('canonical workspace and spec path reject traversal, encoding, alternate path, and cross-workspace input', () => {
  expect(() => assertWave1CanonicalTarget({
    workspaceId: 'workspace-one',
    expectedWorkspaceId: 'workspace-one',
    canonicalSpecPath: WAVE_1_SPEC_PATH,
  })).not.toThrow();
  for (const canonicalSpecPath of [
    `../${WAVE_1_SPEC_PATH}`,
    WAVE_1_SPEC_PATH.replace('/', '%2f'),
    WAVE_1_SPEC_PATH.replace('/pending/', '/approved/'),
    `/tmp/${WAVE_1_SPEC_PATH}`,
  ]) {
    expectReason(() => assertWave1CanonicalTarget({
      workspaceId: 'workspace-one', expectedWorkspaceId: 'workspace-one', canonicalSpecPath,
    }), 'SPEC_PATH_MISMATCH');
  }
  expectReason(() => assertWave1CanonicalTarget({
    workspaceId: 'workspace-two',
    expectedWorkspaceId: 'workspace-one',
    canonicalSpecPath: WAVE_1_SPEC_PATH,
  }), 'WORKSPACE_MISMATCH');
});
