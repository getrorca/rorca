/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { ciRecoveryRevisionIsAllowed, classifyAutonomousDeliveryObservation } from '../autonomous-pr-delivery';
import type { GithubPrDeliveryEvidence } from '../github-pr-delivery-evidence';
import type { DeliveryLifecycleBridgeResult } from '../autonomous-delivery-lifecycle';

const policyId = '10000000-0000-4000-8000-000000000001';
const policyDigest = `sha256:${'d'.repeat(64)}`;
const headSha = 'a'.repeat(40);

function evidence(overrides: Partial<GithubPrDeliveryEvidence> = {}): GithubPrDeliveryEvidence {
  return {
    schemaVersion: 'rorca.github-pr-delivery-evidence.v1',
    id: '20000000-0000-4000-8000-000000000002',
    workspaceId: 'ws-1',
    runId: 20260316000001,
    specSlug: 'reviewed-delivery',
    policy: { id: policyId, digest: policyDigest },
    repository: { owner: 'getrorca', name: 'rorca' },
    pullRequest: {
      number: 42,
      url: 'https://github.com/getrorca/rorca/pull/42',
      state: 'open',
      draft: false,
      merged: false,
      headRef: 'run/reviewed-delivery',
      baseRef: 'main',
      headSha,
      baseSha: 'b'.repeat(40),
      mergeCommitSha: null,
      mergeable: true,
      mergeableState: 'clean',
    },
    freshness: { comparisonStatus: 'ahead', aheadBy: 2, behindBy: 0, branchFresh: true },
    checks: [],
    checksTruncated: false,
    reviews: [],
    reviewsTruncated: false,
    checkSummary: {
      required: ['Backend Tests'], passing: ['Backend Tests'], pending: [], failing: [], missing: [],
      allRequiredPassed: true, policyAvailable: true, policyScopeMatches: true, truncated: false,
    },
    reviewSummary: {
      minimumApprovals: 1,
      currentApprovals: 1,
      approvedReviewers: ['release-owner'],
      requiredReviewers: ['release-owner'],
      missingRequiredReviewers: [],
      changesRequestedBy: [],
      requireCodeOwnerReview: false,
      codeOwnerReviewStatus: 'not_required',
      reviewSatisfied: true,
      policyAvailable: true,
      policyScopeMatches: true,
      truncated: false,
    },
    providerObservedAt: '2026-07-17T00:00:00.000Z',
    observedBy: { principalId: 'steward', displayLabel: 'Autonomous Delivery Steward' },
    payloadHash: `sha256:${'e'.repeat(64)}`,
    createdAt: '2026-07-17T00:00:00.000Z',
    ...overrides,
  };
}

function lifecycle(overrides: Partial<DeliveryLifecycleBridgeResult> = {}): DeliveryLifecycleBridgeResult {
  return {
    validationEvidenceId: '101',
    mergeEvidenceId: '102',
    mergeDecisionId: '103',
    lifecycleReady: true,
    blockers: [],
    mergeGateStatus: 'passed',
    planApprovalRequirement: 'policy',
    snapshotId: 'snapshot-1',
    evidenceHighWaterMark: 'evidence:102',
    decisionHighWaterMark: 'decision:103:1000',
    ...overrides,
  };
}

const lowDelivery = { policy_id: policyId, policy_digest: policyDigest, risk_level: 'low' as const };

describe('CI recovery revision containment', () => {
  test('allows bounded ordinary fixes but rejects workflow, CODEOWNERS, empty, and merge revisions', () => {
    expect(ciRecoveryRevisionIsAllowed(['backend/src/lib/example.ts', 'backend/src/lib/example.test.ts'], 0)).toBe(true);
    expect(ciRecoveryRevisionIsAllowed(['.github/workflows/ci.yml'], 0)).toBe(false);
    expect(ciRecoveryRevisionIsAllowed(['.github/CODEOWNERS'], 0)).toBe(false);
    expect(ciRecoveryRevisionIsAllowed([], 0)).toBe(false);
    expect(ciRecoveryRevisionIsAllowed(['src/example.ts'], 1)).toBe(false);
  });
});

describe('autonomous reviewed delivery classification', () => {
  test('permits actuation only when provider and canonical Lifecycle gates pass', () => {
    expect(classifyAutonomousDeliveryObservation(lowDelivery, evidence(), lifecycle())).toEqual({
      action: 'merge', reason: 'all_reviewed_delivery_gates_passed',
    });
  });

  test.each(['high', 'critical'] as const)('waits for explicit human Merge approval on %s risk', (riskLevel) => {
    const delivery = { ...lowDelivery, risk_level: riskLevel };
    expect(classifyAutonomousDeliveryObservation(delivery, evidence(), lifecycle({
      lifecycleReady: false,
      mergeGateStatus: 'awaiting_approval',
      mergeDecisionId: null,
      planApprovalRequirement: 'human',
      blockers: ['merge:awaiting_approval'],
    }))).toEqual({ action: 'wait_human', reason: 'canonical_merge_human_approval_required' });

    expect(classifyAutonomousDeliveryObservation(delivery, evidence(), lifecycle({
      planApprovalRequirement: 'human',
    }))).toEqual({ action: 'merge', reason: 'all_reviewed_delivery_gates_passed' });
  });

  test('routes definitive required-check failure into bounded CI recovery', () => {
    const observed = evidence({
      checkSummary: {
        ...evidence().checkSummary,
        passing: [], failing: ['Backend Tests'], allRequiredPassed: false,
      },
    });
    expect(classifyAutonomousDeliveryObservation(lowDelivery, observed, lifecycle())).toEqual({
      action: 'recover_ci', reason: 'required_checks_failed',
    });
  });

  test('waits for pending checks without consuming a recovery attempt', () => {
    const observed = evidence({
      checkSummary: {
        ...evidence().checkSummary,
        passing: [], pending: ['Backend Tests'], allRequiredPassed: false,
      },
    });
    expect(classifyAutonomousDeliveryObservation(lowDelivery, observed, lifecycle())).toEqual({
      action: 'wait_checks', reason: 'required_checks_pending_or_missing',
    });
  });

  test('requires re-review after changed SHA and never treats stale approval as current', () => {
    const observed = evidence({
      reviewSummary: {
        ...evidence().reviewSummary,
        currentApprovals: 0,
        approvedReviewers: [],
        missingRequiredReviewers: ['release-owner'],
        reviewSatisfied: false,
      },
    });
    expect(classifyAutonomousDeliveryObservation(lowDelivery, observed, lifecycle())).toEqual({
      action: 'wait_review', reason: 'review_policy_not_satisfied',
    });
  });

  test('routes stale/conflicted base into configured-agent conflict recovery', () => {
    const observed = evidence({
      pullRequest: { ...evidence().pullRequest, mergeable: false, mergeableState: 'dirty' },
      freshness: { comparisonStatus: 'diverged', aheadBy: 2, behindBy: 3, branchFresh: false },
    });
    expect(classifyAutonomousDeliveryObservation(lowDelivery, observed, lifecycle())).toEqual({
      action: 'recover_conflict', reason: 'branch_stale_or_conflicted',
    });
  });

  test('stops on current canonical Lifecycle blockers or missing Merge authorization', () => {
    expect(classifyAutonomousDeliveryObservation(lowDelivery, evidence(), lifecycle({
      lifecycleReady: false,
      blockers: ['qa:awaiting_approval'],
      mergeGateStatus: 'awaiting_approval',
      mergeDecisionId: null,
    }))).toEqual({
      action: 'wait_human', reason: 'lifecycle_blockers:qa:awaiting_approval',
    });
  });

  test('blocks policy snapshot drift and externally merged PRs', () => {
    expect(classifyAutonomousDeliveryObservation(lowDelivery, evidence({ policy: null }), lifecycle())).toEqual({
      action: 'block', reason: 'active_policy_snapshot_mismatch',
    });
    expect(classifyAutonomousDeliveryObservation(lowDelivery, evidence({
      pullRequest: { ...evidence().pullRequest, merged: true, state: 'closed' },
    }), lifecycle())).toEqual({ action: 'block', reason: 'pull_request_already_merged_outside_steward' });
  });
});
