/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GithubProviderBinding } from '../authority-provider-adapter';
import {
  GithubDeliveryReconciler,
  type GithubDeliveryReconciliationStore,
  type GithubOperationAttemptReference,
} from '../github-delivery-reconciliation';
import type { GithubInstallationLeaseSettlementOutcome } from '../github-app-credential-provider';
import {
  GithubReviewDeliveryOperations,
  type GithubExternalOperation,
  type GithubExternalSendGrant,
  type GithubPreparedRepository,
  type GithubReviewCommit,
  type GithubReviewDeliveryReceipt,
} from '../github-review-delivery';

const REQUEST_ID = '10000000-0000-4000-8000-000000000001';
const GRANT_ID = '20000000-0000-4000-8000-000000000001';
const LEASE_ID = '30000000-0000-4000-8000-000000000001';
const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const BRANCH = 'rorca/run-42/gef-004-c001d00dfeed';

const BINDING: GithubProviderBinding = {
  providerId: 'github-app', bindingId: '40000000-0000-4000-8000-000000000001', bindingGeneration: 9,
  workspaceId: 'workspace-reconciliation', bindingStatus: 'active', registrationStatus: 'active',
  installationStatus: 'active', installationId: 77, repositoryId: 99,
  repository: { owner: 'rorca', name: 'disposable' },
  secretReferences: [
    { purpose: 'app-signing', secretId: '50000000-0000-4000-8000-000000000001' },
    { purpose: 'webhook-verification', secretId: '50000000-0000-4000-8000-000000000002' },
  ],
  providerProfileVerified: true,
};

const PREPARED: GithubPreparedRepository = {
  checkoutId: '60000000-0000-4000-8000-000000000001',
  repositoryPath: '/tmp/rorca-reconciliation-repository',
  checkoutPath: '/tmp/rorca-reconciliation-worktree',
  approvedBaseRevision: BASE,
  isolated: true,
};

const COMMIT: GithubReviewCommit = {
  ...PREPARED,
  branch: BRANCH,
  workspaceId: BINDING.workspaceId,
  runId: 42,
  storyId: 'GEF-004',
  headRevision: HEAD,
  message: 'GEF-004: reconcile provider outcomes',
  authoredAt: '2026-08-24T12:00:00.000Z',
  author: { name: 'Rorca Automation', email: 'automation@rorca.local' },
  replayed: false,
};

const GRANT: GithubExternalSendGrant = {
  grantId: GRANT_ID, workspaceId: BINDING.workspaceId, bindingId: BINDING.bindingId,
  bindingGeneration: BINDING.bindingGeneration, repository: { id: BINDING.repositoryId, ...BINDING.repository },
  baseBranch: 'main', baseRevision: BASE, branch: BRANCH, headRevision: HEAD,
  operations: ['scm.branch.write', 'scm.pull_request.write', 'scm.checks.read', 'scm.review.request'],
  decision: 'accepted', externalSend: true, expiresAt: '2026-08-24T13:00:00.000Z',
};

interface StoredAttempt extends GithubOperationAttemptReference {
  state: 'started' | 'externally_accepted' | 'reconciliation_required';
  resources?: { pullRequestId?: number; checkRunIds?: readonly number[] };
}

class MemoryReconciliationStore implements GithubDeliveryReconciliationStore {
  readonly attempts: StoredAttempt[] = [];
  receiptWrites = 0;
  private receipt?: GithubReviewDeliveryReceipt;

  async beginAttempt(input: { operation: GithubExternalOperation }): Promise<GithubOperationAttemptReference> {
    const id = `70000000-0000-4000-8000-${String(this.attempts.length + 1).padStart(12, '0')}`;
    const attempt: StoredAttempt = { id, operation: input.operation, state: 'started' };
    this.attempts.push(attempt);
    return { id, operation: input.operation };
  }

  async markAccepted(
    _workspaceId: string,
    attempt: GithubOperationAttemptReference,
    resources?: { pullRequestId?: number; checkRunIds?: readonly number[] },
  ): Promise<void> {
    const stored = this.attempts.find(({ id }) => id === attempt.id);
    assert.ok(stored);
    stored.state = 'externally_accepted';
    stored.resources = resources;
  }

  async markReconciliationRequired(_workspaceId: string, attemptId: string): Promise<void> {
    const stored = this.attempts.find(({ id }) => id === attemptId);
    assert.ok(stored);
    stored.state = 'reconciliation_required';
  }

  async listReceiptAttempts(): Promise<readonly GithubOperationAttemptReference[]> {
    return this.attempts.map(({ id, operation }) => ({ id, operation }));
  }

  async findReceipt(): Promise<GithubReviewDeliveryReceipt | null> {
    return this.receipt ?? null;
  }

  async persistReceipt(receipt: GithubReviewDeliveryReceipt): Promise<GithubReviewDeliveryReceipt> {
    if (!this.receipt) {
      this.receipt = receipt;
      this.receiptWrites += 1;
    }
    return this.receipt;
  }
}

function baseInput() {
  return { authorityRequestId: REQUEST_ID, leaseId: LEASE_ID, grant: GRANT, binding: BINDING, commit: COMMIT };
}

test('crashes after push, pull-request, and check acceptance reconcile without duplicate external resources', async () => {
  const store = new MemoryReconciliationStore();
  const delivery = new GithubReviewDeliveryOperations();
  let remoteHead: string | null = null;
  let pullAccepted = false;
  let pushReads = 0;
  let pushWrites = 0;
  let pullReads = 0;
  let pullWrites = 0;
  let checkReads = 0;

  delivery.pushBranch = async () => {
    pushReads += 1;
    if (remoteHead === HEAD) return { branch: BRANCH, baseRevision: BASE, headRevision: HEAD, replayed: true };
    remoteHead = HEAD;
    pushWrites += 1;
    throw new Error('simulated crash after provider accepted push');
  };
  delivery.createOrUpdatePullRequest = async () => {
    pullReads += 1;
    if (pullAccepted) {
      return {
        id: 9001, number: 41, url: 'https://github.com/rorca/disposable/pull/41', branch: BRANCH,
        baseBranch: 'main', headRevision: HEAD, replayed: true,
      };
    }
    pullAccepted = true;
    pullWrites += 1;
    throw new Error('simulated crash after provider accepted pull request');
  };
  delivery.observeChecks = async () => {
    checkReads += 1;
    if (checkReads === 1) throw new Error('simulated crash after provider returned checks');
    return [{ id: 501, status: 'completed', conclusion: 'success' }];
  };
  delivery.requestReview = async () => ({ users: ['reviewer'], teams: [], replayed: false });

  const reconciler = new GithubDeliveryReconciler(delivery, store);
  await assert.rejects(reconciler.reconcileBranchPush(baseInput()), /simulated crash/);
  const push = await reconciler.reconcileBranchPush(baseInput());
  await assert.rejects(reconciler.reconcilePullRequest({ ...baseInput(), title: 'GEF-004', body: 'Review only.' }), /simulated crash/);
  const pullRequest = await reconciler.reconcilePullRequest({ ...baseInput(), title: 'GEF-004', body: 'Review only.' });
  await assert.rejects(reconciler.reconcileChecks(baseInput()), /simulated crash/);
  const checks = await reconciler.reconcileChecks(baseInput());
  const reviewRequest = await reconciler.reconcileReviewRequest({
    ...baseInput(), pullRequest: pullRequest.result, users: ['reviewer'],
  });
  const receiptInput = {
    ...baseInput(), push: push.result, pullRequest: pullRequest.result,
    checks: checks.result, reviewRequest: reviewRequest.result,
  };
  const receipt = await reconciler.recordReceipt(receiptInput);
  const replayedReceipt = await reconciler.recordReceipt(receiptInput);

  assert.deepEqual(
    { pushReads, pushWrites, pullReads, pullWrites, checkReads },
    { pushReads: 2, pushWrites: 1, pullReads: 2, pullWrites: 1, checkReads: 2 },
  );
  assert.equal(store.attempts.filter(({ state }) => state === 'reconciliation_required').length, 3);
  assert.strictEqual(receipt, replayedReceipt);
  assert.equal(store.receiptWrites, 1);
  assert.equal(receipt.workspaceId, BINDING.workspaceId);
  assert.equal(receipt.installationId, BINDING.installationId);
  assert.equal(receipt.repository.id, BINDING.repositoryId);
  assert.equal(receipt.branch, BRANCH);
  assert.equal(receipt.headRevision, HEAD);
  assert.equal(receipt.pullRequest.id, 9001);
  assert.deepEqual(receipt.checks, [{ id: 501, status: 'completed', conclusion: 'success' }]);
  assert.deepEqual({
    requestId: receipt.authority.requestId,
    grantId: receipt.authority.grantId,
    leaseId: receipt.authority.leaseId,
  }, { requestId: REQUEST_ID, grantId: GRANT_ID, leaseId: LEASE_ID });
  assert.equal(receipt.authority.attempts.length, 7);
  assert.equal(Object.isFrozen(receipt), true);
  assert.doesNotMatch(JSON.stringify(receipt), /token|authorization|private.?key|gh[opsu]_/i);
});

for (const outcome of ['completed', 'denied', 'cancelled', 'expired', 'failed'] as const) {
  test(`${outcome} terminal outcome cleans the worktree and settles the lease`, async () => {
    const delivery = new GithubReviewDeliveryOperations();
    let cleanupCalls = 0;
    const settledOutcomes: GithubInstallationLeaseSettlementOutcome[] = [];
    delivery.cleanupRepository = async (prepared) => {
      assert.strictEqual(prepared, PREPARED);
      cleanupCalls += 1;
      return { replayed: false };
    };
    const reconciler = new GithubDeliveryReconciler(
      delivery,
      new MemoryReconciliationStore(),
      async (leaseId, settledOutcome) => {
        assert.equal(leaseId, LEASE_ID);
        settledOutcomes.push(settledOutcome);
        return { leaseId, state: 'settled', settlementKind: 'revoked', expiresAt: '2026-08-24T13:00:00.000Z' };
      },
    );

    const result = await reconciler.settleTerminal({ leaseId: LEASE_ID, outcome, prepared: PREPARED });

    assert.equal(cleanupCalls, 1);
    assert.deepEqual(settledOutcomes, [outcome]);
    assert.deepEqual(result, {
      cleanup: { replayed: false },
      lease: { leaseId: LEASE_ID, state: 'settled', settlementKind: 'revoked', expiresAt: '2026-08-24T13:00:00.000Z' },
    });
  });
}

test('revocation failure stays reconciliation-required after terminal worktree cleanup', async () => {
  const delivery = new GithubReviewDeliveryOperations();
  let cleanupCalls = 0;
  delivery.cleanupRepository = async () => {
    cleanupCalls += 1;
    return { replayed: false };
  };
  const reconciler = new GithubDeliveryReconciler(
    delivery,
    new MemoryReconciliationStore(),
    async () => ({
      leaseId: LEASE_ID,
      state: 'reconciliation_required',
      settlementKind: 'revocation_failed',
      expiresAt: '2026-08-24T13:00:00.000Z',
    }),
  );

  const result = await reconciler.settleTerminal({ leaseId: LEASE_ID, outcome: 'failed', prepared: PREPARED });

  assert.equal(cleanupCalls, 1);
  assert.deepEqual(result.lease, {
    leaseId: LEASE_ID,
    state: 'reconciliation_required',
    settlementKind: 'revocation_failed',
    expiresAt: '2026-08-24T13:00:00.000Z',
  });
});
