/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  buildQualificationSandboxLaunch,
  qualificationDependencyDigest,
  type QualificationSandboxIdentity,
} from '../pre-staging-qualification-sandbox';

const HASH = `sha256:${'a'.repeat(64)}` as const;
const BACKEND_SRC_ROOT = fileURLToPath(new URL('../../', import.meta.url));

function fixtureIdentity(root: string): QualificationSandboxIdentity {
  return {
    bwrapPath: '/usr/bin/bwrap',
    mode: 'linux-bwrap',
    sandboxDigest: HASH,
    toolchainRoot: root,
    toolchainDigest: HASH,
    dependencyRoot: path.join(root, 'dependencies'),
    dependencyDigest: HASH,
    descriptor: {
      schemaVersion: 'rorca.pre-staging-toolchain.v1',
      mounts: [{ source: 'usr', target: '/usr' }],
      executables: { node: '/usr/bin/node' },
      dependencyBundles: { [HASH]: 'dependencies' },
    },
  };
}

test('qualification launch is networkless, credential-free, and read-only at the exact checkout', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qualification-sandbox-contract-'));
  try {
    const checkout = path.join(root, 'checkout');
    const toolchain = path.join(root, 'toolchain');
    fs.mkdirSync(path.join(checkout, 'backend'), { recursive: true });
    fs.mkdirSync(path.join(toolchain, 'usr'), { recursive: true });
    fs.mkdirSync(path.join(toolchain, 'dependencies'), { recursive: true });
    const launch = await buildQualificationSandboxLaunch({
      identity: fixtureIdentity(toolchain),
      checkoutRoot: checkout,
      cwd: path.join(checkout, 'backend'),
      executable: 'node',
      args: ['test.js'],
    });
    assert.equal(launch.command, '/usr/bin/bwrap');
    assert.deepEqual(launch.env, {});
    assert.ok(launch.args.includes('--unshare-all'));
    assert.ok(launch.args.includes('--clearenv'));
    assert.ok(launch.args.includes('--cap-drop'));
    const checkoutBind = launch.args.indexOf(fs.realpathSync(checkout));
    assert.equal(launch.args[checkoutBind - 1], '--ro-bind');
    assert.equal(launch.args[checkoutBind + 1], '/workspace');
    assert.equal(launch.args.includes('HOME'), false);
    assert.equal(launch.args.at(-2), '/usr/bin/node');
    assert.equal(launch.args.at(-1), 'test.js');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Darwin uses only a digest-pinned network-denied Docker launch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qualification-docker-contract-'));
  try {
    const checkout = path.join(root, 'checkout');
    const toolchain = path.join(root, 'toolchain');
    fs.mkdirSync(path.join(checkout, 'backend'), { recursive: true });
    fs.mkdirSync(path.join(toolchain, 'dependencies'), { recursive: true });
    const identity: QualificationSandboxIdentity = {
      ...fixtureIdentity(toolchain),
      mode: 'darwin-docker',
      bwrapPath: undefined,
      dockerPath: '/usr/local/bin/docker',
      dockerImage: HASH,
    };
    const launch = await buildQualificationSandboxLaunch({
      identity, checkoutRoot: checkout, cwd: path.join(checkout, 'backend'), executable: 'node', args: ['test.js'],
    });
    assert.equal(launch.command, '/usr/local/bin/docker');
    assert.deepEqual(launch.env, {});
    assert.deepEqual(launch.args.slice(0, 2), ['run', '--rm']);
    assert.ok(launch.args.includes('none'));
    assert.ok(launch.args.includes('--read-only'));
    assert.ok(launch.args.includes('no-new-privileges'));
    assert.ok(launch.args.includes(HASH));
    assert.equal(launch.args.includes('HOME'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dependency identity is byte-bound and fails without canonical manifest evidence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qualification-dependency-contract-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"one"}\n');
    const first = await qualificationDependencyDigest(root, ['package.json']);
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"two"}\n');
    const second = await qualificationDependencyDigest(root, ['package.json']);
    assert.match(first, /^sha256:[a-f0-9]{64}$/);
    assert.notEqual(first, second);
    await assert.rejects(qualificationDependencyDigest(root, ['README.md']), /cannot be established/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('durable claim and worker registration are mandatory before qualification spawn', () => {
  const srcRoot = BACKEND_SRC_ROOT;
  const qualification = fs.readFileSync(path.join(srcRoot, 'lib/pre-staging-qualification.ts'), 'utf8');
  const route = fs.readFileSync(path.join(srcRoot, 'routes/pre-staging-qualification.ts'), 'utf8');
  const worker = fs.readFileSync(path.join(srcRoot, 'worker.ts'), 'utf8');
  const queues = fs.readFileSync(path.join(srcRoot, 'lib/pg-boss.ts'), 'utf8');
  const migration = fs.readFileSync(path.join(srcRoot, 'db/pg-migrations/20260812122000_pre_staging_qualification_claims.sql'), 'utf8');
  const dispatch = qualification.slice(
    qualification.indexOf('export async function runPreStagingQualification'),
    qualification.indexOf('async function claimQualificationAttempt'),
  );
  assert.match(dispatch, /acquireQualificationAttempt/);
  assert.match(dispatch, /getBoss\(\)\.send\(PRE_STAGING_QUALIFICATION_QUEUE/);
  assert.doesNotMatch(dispatch, /spawn\(|executeCheck\(|addWorktree\(/);
  assert.match(route, /runPreStagingQualification/);
  assert.match(worker, /registerPreStagingQualificationWorker\(boss\)/);
  assert.match(queues, /createQueue\('pipeline:pre-staging-qualification'\)/);
  assert.match(migration, /UNIQUE \(workspace_id, idempotency_key\)/);
  assert.match(migration, /state IN \('pending', 'executing', 'results_ready', 'complete', 'blocked'\)/);
  assert.match(qualification, /QUALIFICATION_STALE_LEASE/);
  assert.match(qualification, /canonicalTransaction/);
  assert.match(qualification, /state = 'results_ready'/);
  assert.match(qualification, /persistQualificationEvidenceBatchInTransaction/);
  assert.doesNotMatch(qualification, /linkOriginalDependencies|fs\.symlink/);
});

test('exact-batch finalization binds every ordered gate and is forward-migration safe', () => {
  const srcRoot = BACKEND_SRC_ROOT;
  const historical = fs.readFileSync(path.join(srcRoot, 'db/pg-migrations/20260731156000_lifecycle_evidence_writer_capability.sql'), 'utf8');
  const migration = fs.readFileSync(path.join(srcRoot, 'db/pg-migrations/20260812133000_pre_staging_qualification_exact_batch.sql'), 'utf8');
  assert.doesNotMatch(historical, /qualification\.finalize/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION rorca\.guard_wave2_canonical_dml_v3/);
  assert.match(migration, /jsonb_array_elements\(artifact->'evidence'\) WITH ORDINALITY/);
  assert.match(migration, /jsonb_array_length\(artifact->'evidence'\)/);
  assert.match(migration, /state<>'results_ready'/);
  assert.match(migration, /result_hash<>p_request->>'resultHash'/);
  assert.match(migration, /effect\.operation='qualification\.finalize'/);
  assert.match(migration, /evidenceSetHash' IS DISTINCT FROM/);
  assert.match(migration, /is_current=TRUE AND plan\.validation_status='validated'/);
});

test('batch mismatch, replay, and forged runtime receipt fail closed', () => {
  const migration = fs.readFileSync(path.join(BACKEND_SRC_ROOT, 'db/pg-migrations/20260812133000_pre_staging_qualification_exact_batch.sql'), 'utf8');
  assert.match(migration, /Qualification exact-batch identity or replay denied/);
  assert.match(migration, /sourceEventId'=b\.value->>'sourceEventId'/);
  assert.match(migration, /Qualification receipt differs from exact-batch capability/);
  assert.match(migration, /Qualification attempt completion differs from exact-batch capability/);
  assert.match(migration, /REVOKE INSERT, UPDATE, DELETE ON rorca\.ssdlc_release_qualifications/);
  assert.doesNotMatch(migration, /TG_TABLE_NAME='ssdlc_release_qualifications'[^\n]+RETURN NEW/);
});
