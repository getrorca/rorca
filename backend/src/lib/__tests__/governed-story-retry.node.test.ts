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
  hasExactExecutableStoryRevisionAuthority,
  deriveNextGovernedRetryAttempt,
  reconcilePostIntegrationReplay,
  verifyGovernedRetryDispatchIdentity,
  type RetryCompletionEvidence,
  type RetryIntegrationEvidence,
  type RetryRunCloseoutEvidence,
} from '../governed-story-retry';
import { deriveStoryContractRevision } from '../story-execution-packet';

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
  const scope = deriveAuthoritativeRetryScope({ originalRunLineage: [100], targetRunId: 100, completions, integrations, closeouts });
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
    originalRunLineage: [100], targetRunId: 100, completions,
    integrations: integrations.map((row) => row.storyId === 'WPE-001' ? { ...row, state: 'integrated' as const } : row),
    closeouts,
  }), /lacks matching finalized integration/);
  assert.throws(() => deriveAuthoritativeRetryScope({ originalRunLineage: [100], targetRunId: 100, completions, integrations, closeouts: [] }), /run_closeout evidence is required/);
  assert.throws(() => deriveAuthoritativeRetryScope({
    originalRunLineage: [100], targetRunId: 100, completions, integrations, closeouts, requestedStoryIds: ['WPE-001'],
  }), /not failed or unresolved/);
});

test('a second failure appends a new attempt and cannot overwrite prior evidence identity', () => {
  const retryFailure: RetryCompletionEvidence = {
    runId: 101, storyId: 'WPE-002', attempt: 2, resultIdentity: 'result-failed-again', outcome: 'failed', sourceCommit: null,
  };
  const scope = deriveAuthoritativeRetryScope({
    originalRunLineage: [100, 101], targetRunId: 101, completions: [...completions, retryFailure], integrations, closeouts: [
      ...closeouts,
      { runId: 101, status: 'failed', integratedRevision: D, integrationAncestry: [C, D], acceptedStoryIds: ['WPE-001'], evidenceIdentity: 'wal:run_closeout:901' },
    ],
  });
  assert.deepEqual(scope.executableStoryIds, ['WPE-002']);
  assert.equal(scope.carriedForward[0].resultIdentity, 'result-accepted');
  assert.throws(() => deriveAuthoritativeRetryScope({
    originalRunLineage: [100], targetRunId: 100,
    completions: [...completions, { ...completions[1], outcome: 'failed' }],
    integrations,
    closeouts,
  }), /contradictory completion evidence/);
});

test('transitive carry-forward reindexes run-local integration orders against target ancestry', () => {
  const scope = deriveAuthoritativeRetryScope({
    originalRunLineage: [100, 101],
    targetRunId: 101,
    completions: [
      completions[0],
      { runId: 101, storyId: 'WPE-002', attempt: 2, resultIdentity: 'result-accepted-retry', outcome: 'accepted', sourceCommit: B },
      { runId: 101, storyId: 'WPE-003', attempt: 1, resultIdentity: 'result-failed', outcome: 'failed', sourceCommit: null },
    ],
    integrations: [
      integrations[0],
      { runId: 101, storyId: 'WPE-002', attempt: 2, state: 'finalized', sourceCommit: B, resultingHead: D, integrationOrder: 0 },
    ],
    closeouts: [
      { runId: 100, status: 'partial_failure', integratedRevision: C, integrationAncestry: [C], acceptedStoryIds: ['WPE-001'], evidenceIdentity: 'wal:run_closeout:900' },
      { runId: 101, status: 'partial_failure', integratedRevision: D, integrationAncestry: [C, D], acceptedStoryIds: ['WPE-002'], evidenceIdentity: 'wal:run_closeout:901' },
    ],
    requestedStoryIds: ['WPE-003'],
  });

  assert.deepEqual(
    scope.carriedForward.map(({ storyId, sourceRunId, integrationOrder }) => ({ storyId, sourceRunId, integrationOrder })),
    [
      { storyId: 'WPE-001', sourceRunId: 100, integrationOrder: 0 },
      { storyId: 'WPE-002', sourceRunId: 101, integrationOrder: 1 },
    ],
  );
});

test('retry attempt numbering advances from immutable root-lineage evidence', () => {
  assert.deepEqual(
    deriveNextGovernedRetryAttempt({ storyRetries: 0 }),
    { previousAttempt: 1, attempt: 2 },
  );
  assert.deepEqual(
    deriveNextGovernedRetryAttempt({ storyRetries: 0, latestGovernedAttempt: 2 }),
    { previousAttempt: 2, attempt: 3 },
  );
  assert.deepEqual(
    deriveNextGovernedRetryAttempt({ storyRetries: 3, latestGovernedAttempt: 2 }),
    { previousAttempt: 4, attempt: 5 },
  );
  assert.throws(
    () => deriveNextGovernedRetryAttempt({ storyRetries: 0, latestGovernedAttempt: 0 }),
    /latest governed attempt is invalid/,
  );
});

test('string runIds from pg BIGINT text rows never drop finalized integration evidence', () => {
  // Regression: the retry route loads ledger and closeout rows via raw SQL, where
  // node-postgres returns BIGINT columns as text, while completions are explicitly
  // Number()-coerced by the handler. A strict `lineageSet.has(row.runId)` filter
  // on the raw rows drops every integration/closeout row and flips accepted stories
  // into a false "lacks matching finalized integration" failure. runId coercion
  // must keep the evidence in scope.
  const stringIntegrations = integrations.map((row) => ({ ...row, runId: String(row.runId) }));
  const stringCloseouts = closeouts.map((row) => ({ ...row, runId: String(row.runId) }));
  const scope = deriveAuthoritativeRetryScope({
    originalRunLineage: [100], targetRunId: 100,
    completions, integrations: stringIntegrations, closeouts: stringCloseouts,
  });
  assert.deepEqual(scope.executableStoryIds, ['WPE-002']);
  assert.equal(scope.carriedForward[0].resultIdentity, 'result-accepted');
  assert.equal(scope.carriedForward[0].sourceRunId, 100);
});

test('canonical projection drift preserves retry authority only for exact executable story contracts', () => {
  const failedStory = {
    id: 'ACC-009',
    title: 'Saved views',
    acceptanceCriteria: ['Saved views are tenant isolated.'],
    passes: false,
  };
  const currentStories = [
    { id: 'ACC-001', title: 'Snapshot storage', passes: true, notes: 'Accepted by run 64.' },
    failedStory,
  ];
  const parentManifestRevisions = [{
    story_id: 'ACC-009',
    story_revision: deriveStoryContractRevision(failedStory),
  }];

  assert.equal(hasExactExecutableStoryRevisionAuthority({
    executableStoryIds: ['ACC-009'],
    currentStories,
    parentManifestRevisions,
  }), true);
  assert.equal(hasExactExecutableStoryRevisionAuthority({
    executableStoryIds: ['ACC-009'],
    currentStories: [
      currentStories[0],
      { ...failedStory, acceptanceCriteria: ['Saved views may cross tenants.'] },
    ],
    parentManifestRevisions,
  }), false);
  assert.equal(hasExactExecutableStoryRevisionAuthority({
    executableStoryIds: ['ACC-009'],
    currentStories,
    parentManifestRevisions: [],
  }), false);
});

test('retry authority accepts legacy retry-transformed manifest revisions when the retry spec matches', () => {
  const story = {
    id: 'ACC-010',
    title: 'Intercompany previews',
    description: 'Release-gated intercompany previews',
    acceptanceCriteria: ['Previews are release-gated'],
    passes: true,
  };
  // A legacy retry manifest froze the transformed story (effort + excluded
  // injected by buildGovernedRetrySpec) instead of the canonical shape.
  const retryTransformed = {
    ...story,
    passes: false,
    excluded: false,
    effort: 'max',
  };
  const frozen = deriveStoryContractRevision(retryTransformed);

  // The canonical derive alone no longer matches, but the retry-spec derive
  // does — retry-of-retry must not false-refuse a legitimate continuation.
  assert.equal(hasExactExecutableStoryRevisionAuthority({
    executableStoryIds: ['ACC-010'],
    currentStories: [story],
    parentManifestRevisions: [{ story_id: 'ACC-010', story_revision: frozen }],
    retrySpecStories: [retryTransformed],
  }), true);

  // A genuinely changed contract is still refused even when the retry spec is
  // supplied, so the guard keeps detecting real drift. The retry spec is built
  // from the current canonical spec, so it carries the changed criteria.
  const changedStory = { ...story, acceptanceCriteria: ['Previews are never release-gated'] };
  assert.equal(hasExactExecutableStoryRevisionAuthority({
    executableStoryIds: ['ACC-010'],
    currentStories: [changedStory],
    parentManifestRevisions: [{ story_id: 'ACC-010', story_revision: frozen }],
    retrySpecStories: [{ ...retryTransformed, acceptanceCriteria: ['Previews are never release-gated'] }],
  }), false);
});

test('dispatch binds every restart-sensitive identity and rejects stale target or tampering', () => {
  const scope = deriveAuthoritativeRetryScope({ originalRunLineage: [100], targetRunId: 100, completions, integrations, closeouts });
  const identity = createGovernedRetryDispatchIdentity({
    workspaceId: 'synthetic-workspace', specId: 'synthetic-spec', specRevision: 'sha256:spec',
    originalRunId: 100, originalRunLineage: [100], retryRunId: 101,
    baseRevision: D, integratedRevision: D, priorIntegrationAncestry: scope.priorIntegrationAncestry,
    recoveryRef: 'refs/heads/rorca/recovery/synthetic', recoveryRefRevision: D,
    fencingToken: 1, leaseIdentity: `sha256:${'1'.repeat(64)}`, idempotencyKey: 'synthetic-retry-key',
    queueName: 'pipeline:retry', queuePayloadHash: `sha256:${'2'.repeat(64)}`,
    executionManifestHash: `sha256:${'3'.repeat(64)}`, approvedPreviewHash: `sha256:${'4'.repeat(64)}`,
    scopeHash: `sha256:${'5'.repeat(64)}`, evidenceHash: scope.evidenceHash,
    taskManifestLineageHash: null,
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
