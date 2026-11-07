/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  captureCloseoutReconciliationBuildIdentity,
  sameCloseoutReconciliationBuildIdentity,
} from '../closeout-reconciliation-build-identity';
import { measureCloseoutReconciliationArtifact } from '../closeout-reconciliation-artifact';
import {
  WAVE_1_IMPLEMENTATION_BASELINE_SHA,
  WAVE_1_SOURCE_REPOSITORY,
  WAVE_1_SPEC_CONTENT_HASH,
} from '../wave-1-stabilization';

const ENV = 'RORCA_BUILD_IDENTITY_RECEIPT';
const KEY_ENV = 'RORCA_BUILD_IDENTITY_VERIFICATION_KEY';
const TEST_KEY_PAIR = crypto.generateKeyPairSync('ed25519');
const VERIFICATION_KEY = TEST_KEY_PAIR.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const originalReceipt = process.env[ENV];
const originalVerificationKey = process.env[KEY_ENV];
const originalBuildSha = process.env.RORCA_BUILD_SHA;
const originalSourceRoot = process.env.RORCA_SOURCE_ROOT;

function receipt(buildSha: string, artifactCharacter: string, deploymentId: string): string {
  const unsigned = {
    schemaVersion: 'rorca.build-identity-receipt.v1',
    buildSha,
    reviewedSourceSha: buildSha,
    requiredFixSha: 'e0fbcff3dd227ef918da71e3b0fe8761ee79b6d1',
    artifactDigest: artifactCharacter === 'measured'
      ? measureCloseoutReconciliationArtifact().digest
      : `sha256:${artifactCharacter.repeat(64)}`,
    deploymentId,
    deploymentEnvironment: 'production',
    workspaceId: 'proof-workspace',
    canonicalSpecPath: 'forge/specs/pending/wave-1-stabilize-evidence-closeout-and-managed-branch-delivery.json',
    issuer: 'rorca-release-authority',
    keyId: 'wave1-test-key',
    issuedAt: '2026-07-26T23:30:00.000Z',
    implementationBaselineSha: WAVE_1_IMPLEMENTATION_BASELINE_SHA,
    waveSpecRevision: WAVE_1_SPEC_CONTENT_HASH,
    sourceRepository: WAVE_1_SOURCE_REPOSITORY,
  };
  const signature = `ed25519:${crypto.sign(
    null,
    Buffer.from(JSON.stringify(unsigned), 'utf8'),
    TEST_KEY_PAIR.privateKey,
  ).toString('base64')}`;
  return JSON.stringify({ ...unsigned, signature });
}

afterEach(() => {
  if (originalReceipt === undefined) delete process.env[ENV];
  else process.env[ENV] = originalReceipt;
  if (originalVerificationKey === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = originalVerificationKey;
  if (originalBuildSha === undefined) delete process.env.RORCA_BUILD_SHA;
  else process.env.RORCA_BUILD_SHA = originalBuildSha;
  if (originalSourceRoot === undefined) delete process.env.RORCA_SOURCE_ROOT;
  else process.env.RORCA_SOURCE_ROOT = originalSourceRoot;
  jest.resetModules();
});

test('fails closed when no exact deployment receipt existed at process startup', () => {
  delete process.env[ENV];
  jest.isolateModules(() => {
    const identity = jest.requireActual('../closeout-reconciliation-build-identity') as typeof import('../closeout-reconciliation-build-identity');
    expect(() => identity.resolveCloseoutReconciliationBuildIdentity())
      .toThrow('requires an exact startup deployment receipt');
  });
});

test.each([
  '',
  '{}',
  JSON.stringify({
    schemaVersion: 'rorca.build-identity-receipt.v1',
    buildSha: 'not-a-sha',
    artifactDigest: `sha256:${'a'.repeat(64)}`,
    deploymentId: 'deployment-one',
    issuedAt: '2026-07-26T23:30:00.000Z',
  }),
  `${receipt('a'.repeat(40), 'b', 'deployment-one').slice(0, -1)},"mutableExtra":true}`,
])('rejects absent, malformed, or extensible startup receipt %#', (raw) => {
  expect(captureCloseoutReconciliationBuildIdentity(raw)).toMatchObject({
    identity: null,
    error: expect.any(String),
  });
});

test('captures and freezes the startup receipt instead of trusting mutable checkout or environment state', () => {
  const apiReceipt = receipt('a'.repeat(40), 'measured', 'rollout-api-worker-001');
  const changedReceipt = receipt('c'.repeat(40), 'measured', 'rollout-api-worker-002');
  process.env[ENV] = apiReceipt;
  process.env[KEY_ENV] = VERIFICATION_KEY;
  process.env.RORCA_BUILD_SHA = 'e'.repeat(40);
  process.env.RORCA_SOURCE_ROOT = '/tmp/a-mutable-checkout-must-not-be-proof';

  jest.isolateModules(() => {
    const identity = jest.requireActual('../closeout-reconciliation-build-identity') as typeof import('../closeout-reconciliation-build-identity');
    const startup = identity.resolveCloseoutReconciliationBuildIdentity();
    process.env[ENV] = changedReceipt;
    process.env.RORCA_BUILD_SHA = 'f'.repeat(40);
    process.env.RORCA_SOURCE_ROOT = '/tmp/changed-checkout';
    const afterMutation = identity.resolveCloseoutReconciliationBuildIdentity();

    expect(afterMutation).toBe(startup);
    expect(afterMutation).toMatchObject({
      buildSha: 'a'.repeat(40),
      buildReceiptHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      implementationBaselineSha: WAVE_1_IMPLEMENTATION_BASELINE_SHA,
      waveSpecRevision: WAVE_1_SPEC_CONTENT_HASH,
      sourceRepository: WAVE_1_SOURCE_REPOSITORY,
      artifactDigest: measureCloseoutReconciliationArtifact().digest,
      verification: 'startup-deployment-receipt+measured-artifact+runtime-capability',
    });
    expect(Object.isFrozen(afterMutation)).toBe(true);
    expect(Object.isFrozen(afterMutation.buildReceipt)).toBe(true);
  });
});

test('rejects a deployment receipt bound to another baseline, spec revision, repository, or unknown field', () => {
  const exact = JSON.parse(receipt('a'.repeat(40), 'measured', 'rollout-api-worker-001')) as Record<string, unknown>;
  for (const changed of [
    { ...exact, implementationBaselineSha: 'f'.repeat(40) },
    { ...exact, waveSpecRevision: `sha256:${'f'.repeat(64)}` },
    { ...exact, sourceRepository: 'https://github.com/attacker/fork.git' },
    { ...exact, runtimeClaimedApproval: true },
  ]) {
    expect(captureCloseoutReconciliationBuildIdentity(JSON.stringify(changed)).identity).toBeNull();
  }
});

test('worker validation binds the exact API receipt persisted in immutable application authority', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'run-closeout-reconciliation.ts'), 'utf8');
  expect(source).toContain('acceptedSoftware.buildReceiptHash !== row.build_receipt_hash');
  expect(source).toContain('sameCloseoutReconciliationBuildIdentity(acceptedSoftware, workerSoftware)');
  expect(source).toContain("'BUILD_AUTHORITY_UNAVAILABLE'");
  expect(source).not.toContain('process.env.RORCA_BUILD_SHA');
  expect(source).not.toContain("['rev-parse', '--verify', 'HEAD^{commit}']");
});

test('detects exact API/worker startup receipt mismatch even for the same source commit', () => {
  const api = captureCloseoutReconciliationBuildIdentity(
    receipt('a'.repeat(40), 'measured', 'rollout-api-worker-001'),
    VERIFICATION_KEY,
  ).identity!;
  const forgedArtifact = captureCloseoutReconciliationBuildIdentity(
    receipt('a'.repeat(40), 'c', 'rollout-api-worker-001'),
    VERIFICATION_KEY,
  );
  const differentDeployment = captureCloseoutReconciliationBuildIdentity(
    receipt('a'.repeat(40), 'measured', 'rollout-api-worker-002'),
    VERIFICATION_KEY,
  ).identity!;

  expect(sameCloseoutReconciliationBuildIdentity(api, api)).toBe(true);
  expect(forgedArtifact.identity).toBeNull();
  expect(sameCloseoutReconciliationBuildIdentity(api, differentDeployment)).toBe(false);
});
