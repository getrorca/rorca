/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import {
  createGovernedRetryDispatchIdentity,
  deriveAuthoritativeRetryScope,
  reconcilePostIntegrationReplay,
  verifyGovernedRetryDispatchIdentity,
  type RetryCompletionEvidence,
  type RetryIntegrationEvidence,
  type RetryRunCloseoutEvidence,
} from '../governed-story-retry';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);

const completions: RetryCompletionEvidence[] = [
  { runId: 100, storyId: 'WPE-001', attempt: 1, resultIdentity: 'result-accepted', outcome: 'accepted', sourceCommit: A },
  { runId: 100, storyId: 'WPE-002', attempt: 1, resultIdentity: 'result-failed', outcome: 'rejected', sourceCommit: B },
];
const integrations: RetryIntegrationEvidence[] = [
  { runId: 100, storyId: 'WPE-001', attempt: 1, state: 'finalized', sourceCommit: A, resultingHead: C, integrationOrder: 0 },
  { runId: 100, storyId: 'WPE-002', attempt: 1, state: 'aborted', sourceCommit: B, resultingHead: null, integrationOrder: 1 },
];
const closeouts: RetryRunCloseoutEvidence[] = [{
  runId: 100,
  status: 'partial_failure',
  integratedRevision: D,
  integrationAncestry: [C, D],
  acceptedStoryIds: ['WPE-001'],
  evidenceIdentity: 'wal:run_closeout:900',
}];

test('authoritative retry scope carries finalized siblings and executes only rejected work', () => {
  const scope = deriveAuthoritativeRetryScope({ originalRunLineage: [100], completions, integrations, closeouts });
  assert.deepEqual(scope.executableStoryIds, ['WPE-002']);
  assert.equal(scope.targetRevision, D);
  assert.deepEqual(scope.carriedForward, [{
    storyId: 'WPE-001', sourceRunId: 100, sourceAttempt: 1, resultIdentity: 'result-accepted',
    sourceCommit: A, resultingHead: C, integrationOrder: 0, reasonCode: 'ACCEPTED_INTEGRATED_SIBLING',
  }]);
  assert.ok(scope.priorIntegrationAncestry.includes(C));
});

test('accepted completion without matching finalized ledger and run_closeout ancestry fails closed', () => {
  assert.throws(() => deriveAuthoritativeRetryScope({
    originalRunLineage: [100], completions,
    integrations: integrations.map((row) => row.storyId === 'WPE-001' ? { ...row, state: 'integrated' as const } : row),
    closeouts,
  }), /lacks matching finalized integration/);
  assert.throws(() => deriveAuthoritativeRetryScope({ originalRunLineage: [100], completions, integrations, closeouts: [] }), /run_closeout evidence is required/);
  assert.throws(() => deriveAuthoritativeRetryScope({
    originalRunLineage: [100], completions, integrations, closeouts, requestedStoryIds: ['WPE-001'],
  }), /not failed or unresolved/);
});

test('a second failure appends a new attempt and cannot overwrite prior evidence identity', () => {
  const retryFailure: RetryCompletionEvidence = {
    runId: 101, storyId: 'WPE-002', attempt: 2, resultIdentity: 'result-failed-again', outcome: 'failed', sourceCommit: null,
  };
  const scope = deriveAuthoritativeRetryScope({
    originalRunLineage: [100, 101], completions: [...completions, retryFailure], integrations, closeouts: [
      ...closeouts,
      { runId: 101, status: 'failed', integratedRevision: D, integrationAncestry: [C, D], acceptedStoryIds: ['WPE-001'], evidenceIdentity: 'wal:run_closeout:901' },
    ],
  });
  assert.deepEqual(scope.executableStoryIds, ['WPE-002']);
  assert.equal(scope.carriedForward[0].resultIdentity, 'result-accepted');
  assert.throws(() => deriveAuthoritativeRetryScope({
    originalRunLineage: [100],
    completions: [...completions, { ...completions[1], outcome: 'failed' }],
    integrations,
    closeouts,
  }), /contradictory completion evidence/);
});

test('dispatch binds every restart-sensitive identity and rejects stale target or tampering', () => {
  const scope = deriveAuthoritativeRetryScope({ originalRunLineage: [100], completions, integrations, closeouts });
  const identity = createGovernedRetryDispatchIdentity({
    workspaceId: 'synthetic-workspace', specId: 'synthetic-spec', specRevision: 'sha256:spec',
    originalRunId: 100, originalRunLineage: [100], retryRunId: 101,
    baseRevision: D, integratedRevision: D, priorIntegrationAncestry: scope.priorIntegrationAncestry,
    recoveryRef: 'refs/heads/rorca/recovery/synthetic', recoveryRefRevision: D,
    fencingToken: 1, leaseIdentity: `sha256:${'1'.repeat(64)}`, idempotencyKey: 'synthetic-retry-key',
    queueName: 'pipeline:retry', queuePayloadHash: `sha256:${'2'.repeat(64)}`,
    executionManifestHash: `sha256:${'3'.repeat(64)}`, approvedPreviewHash: `sha256:${'4'.repeat(64)}`,
    scopeHash: `sha256:${'5'.repeat(64)}`, evidenceHash: scope.evidenceHash,
    storyAttempts: [{ storyId: 'WPE-002', attempt: 2, previousAttempt: 1, sourceRunId: 100, idempotencyKey: 'synthetic-retry-key:WPE-002:2' }],
    carriedForward: scope.carriedForward,
  });
  assert.equal(verifyGovernedRetryDispatchIdentity(identity), true);
  assert.equal(verifyGovernedRetryDispatchIdentity({ ...identity, fencingToken: 2 }), false);
  assert.throws(() => createGovernedRetryDispatchIdentity({ ...identity, identityHash: undefined as never, recoveryRefRevision: C }), /exact latest integrated/);
  assert.throws(() => createGovernedRetryDispatchIdentity({
    ...identity, identityHash: undefined as never,
    storyAttempts: [{ ...identity.storyAttempts[0], attempt: 3 }],
  }), /append exactly one attempt/);
});

test('post-Git replay reconciles exact commit/tree once and never requests patch reapplication', () => {
  assert.deepEqual(reconcilePostIntegrationReplay({
    expectedParentHead: C, sourceCommit: B, observedHead: D,
    observedParents: [C, B], observedTreeHash: A, preparedTreeHash: A,
  }), { action: 'finalize_once', resultingHead: D });
  assert.deepEqual(reconcilePostIntegrationReplay({
    expectedParentHead: C, sourceCommit: B, observedHead: D,
    observedParents: [C, B], observedTreeHash: B, preparedTreeHash: A,
  }), { action: 'manual_review_required', reason: 'observed integration commit/tree does not match prepared identities' });
});

test('migration provides linearizable finalization, append-only evidence, and no pg-boss mutation', () => {
  const root = fs.existsSync(path.resolve(process.cwd(), 'backend', 'src')) ? path.resolve(process.cwd(), 'backend', 'src') : path.resolve(process.cwd(), 'src');
  const migration = fs.readFileSync(path.join(root, 'db', 'pg-migrations', '20260719100000_governed_story_retry_attempts.sql'), 'utf8');
  assert.match(migration, /UNIQUE \(original_root_run_id, story_id, attempt\)/);
  assert.match(migration, /state_version BIGINT NOT NULL DEFAULT 1/);
  assert.match(migration, /governed retry story-attempt identity is immutable/);
  assert.match(migration, /terminal governed retry attempt evidence is immutable/);
  assert.match(migration, /governed retry evidence is append-only/);
  assert.match(migration, /base_revision = integrated_revision/);
  assert.doesNotMatch(migration, /(?:CREATE|ALTER|DROP|DELETE FROM|UPDATE)\s+(?:TABLE\s+)?pgboss\./i);
});

test('qualification fixtures are synthetic and cannot name or clean a production run', () => {
  const root = fs.existsSync(path.resolve(process.cwd(), 'backend', 'src')) ? path.resolve(process.cwd(), 'backend', 'src') : path.resolve(process.cwd(), 'src');
  const source = fs.readFileSync(path.join(root, 'lib', '__tests__', 'governed-story-retry.node.test.ts'), 'utf8');
  assert.match(source, /synthetic-workspace/);
  assert.doesNotMatch(source, /DELETE\s+FROM\s+pipeline_runs|UPDATE\s+pipeline_runs/i);
});
