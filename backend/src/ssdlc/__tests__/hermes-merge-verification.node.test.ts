/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { CanonicalLifecycleEvidence } from '../../lib/ssdlc-evidence';
import {
  createHermesMergeVerifier,
  type MergeVerificationSnapshot,
} from '../hermes-merge-verification';

const NOW = new Date('2026-03-16T00:06:29.000Z');
const AUTHORIZED_SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const scope = {
  workspaceId: 'workspace-1', specSlug: 'source-verified-delivery', runId: 17,
  storyId: 'AAV-017', phaseId: 'deployment', gateId: 'exact-source-integrity',
};
const authorized = { headSha: AUTHORIZED_SHA, changedFiles: ['src/delivery.ts', 'src/delivery.test.ts'] };

function input() {
  return {
    scope,
    authorized,
    actor: 'hermes:merge-verifier',
    rawReference: 'git://source-verified-delivery/heads/authorized',
  };
}

function verifier(snapshot: MergeVerificationSnapshot, emitted: CanonicalLifecycleEvidence[]) {
  return createHermesMergeVerifier({
    async inspectMergeState(request) {
      assert.equal(request.authorizedHeadSha, AUTHORIZED_SHA);
      return snapshot;
    },
    async emitMergeEvidence(evidence) { emitted.push(evidence); },
  }, { now: () => NOW });
}

test('allows merge only for the exact authorized head, complete change set, and clean worktree', async () => {
  const emitted: CanonicalLifecycleEvidence[] = [];
  const result = await verifier({
    headSha: AUTHORIZED_SHA,
    changedFiles: ['src/delivery.test.ts', 'src/delivery.ts'],
    uncommittedChanges: [],
  }, emitted).verify(input());

  assert.equal(result.control, 'merge_allowed');
  assert.deepEqual(result.discrepancies, []);
  assert.deepEqual(result.snapshot.changedFiles, ['src/delivery.test.ts', 'src/delivery.ts']);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0], result.evidence);
  assert.equal(result.evidence.scope.phaseId, 'merge');
  assert.equal(result.evidence.status, 'passed');
  assert.deepEqual(result.evidence.subject, { type: 'commit_sha', value: AUTHORIZED_SHA });
  assert.deepEqual(result.evidence.releaseIdentity, {
    commitSha: AUTHORIZED_SHA, artifactDigest: null, deploymentId: null,
  });
  assert.equal(result.evidence.details.verifiedHeadSha, AUTHORIZED_SHA);
  assert.equal(result.evidence.details.control, 'merge_allowed');
});

test('blocks merge and reports exact head and complete change-set discrepancies', async () => {
  const emitted: CanonicalLifecycleEvidence[] = [];
  const result = await verifier({
    headSha: OTHER_SHA,
    changedFiles: ['src/delivery.ts', 'src/unexpected.ts'],
    uncommittedChanges: [],
  }, emitted).verify(input());

  assert.equal(result.control, 'merge_blocked');
  assert.deepEqual(result.discrepancies, [
    { code: 'HEAD_SHA_MISMATCH', expected: AUTHORIZED_SHA, observed: OTHER_SHA },
    { code: 'CHANGE_SET_MISMATCH', missing: ['src/delivery.test.ts'], unexpected: ['src/unexpected.ts'] },
  ]);
  assert.equal(result.evidence.status, 'story_caused_failure');
  assert.deepEqual(result.evidence.subject, { type: 'commit_sha', value: OTHER_SHA });
  assert.equal(result.evidence.details.verifiedHeadSha, null);
  assert.deepEqual(result.evidence.details.discrepancies, result.discrepancies);
  assert.equal(
    result.evidence.excerpt,
    `Merge blocked for head ${OTHER_SHA}: HEAD_SHA_MISMATCH expected=${AUTHORIZED_SHA} observed=${OTHER_SHA}; CHANGE_SET_MISMATCH missing=[\"src/delivery.test.ts\"] unexpected=[\"src/unexpected.ts\"].`,
  );
  assert.equal(emitted.length, 1);
});

test('blocks merge and identifies every uncommitted drift path exactly', async () => {
  const emitted: CanonicalLifecycleEvidence[] = [];
  const result = await verifier({
    headSha: AUTHORIZED_SHA,
    changedFiles: [...authorized.changedFiles],
    uncommittedChanges: ['src/generated.ts', 'docs/release.md'],
  }, emitted).verify(input());

  assert.equal(result.control, 'merge_blocked');
  assert.deepEqual(result.discrepancies, [{
    code: 'UNCOMMITTED_DRIFT', paths: ['docs/release.md', 'src/generated.ts'],
  }]);
  assert.equal(result.evidence.details.control, 'merge_blocked');
  assert.deepEqual(result.evidence.details.discrepancies, result.discrepancies);
  assert.equal(
    result.evidence.excerpt,
    `Merge blocked for head ${AUTHORIZED_SHA}: UNCOMMITTED_DRIFT paths=[\"docs/release.md\",\"src/generated.ts\"].`,
  );
  assert.equal(emitted.length, 1);
});

test('rejects path aliases that become duplicates after separator normalization', async () => {
  const emitted: CanonicalLifecycleEvidence[] = [];
  await assert.rejects(
    verifier({
      headSha: AUTHORIZED_SHA,
      changedFiles: [...authorized.changedFiles],
      uncommittedChanges: [],
    }, emitted).verify({
      ...input(),
      authorized: { headSha: AUTHORIZED_SHA, changedFiles: ['src/delivery.ts', 'src\\delivery.ts'] },
    }),
    { name: 'TypeError', message: 'authorized.changedFiles must not contain duplicate normalized paths' },
  );
  assert.deepEqual(emitted, []);
});
