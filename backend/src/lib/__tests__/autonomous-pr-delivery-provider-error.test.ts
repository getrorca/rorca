
/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

const mockQueryOne = jest.fn();
const mockExecute = jest.fn();
const mockTransaction = jest.fn();
const mockGetActivePolicy = jest.fn();

jest.mock('../../db/index', () => ({
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
  execute: (...args: unknown[]) => mockExecute(...args),
  transaction: (...args: unknown[]) => mockTransaction(...args),
}));

jest.mock('../autonomous-delivery-policy', () => ({
  getActiveAutonomousDeliveryPolicy: (...args: unknown[]) => mockGetActivePolicy(...args),
}));

jest.mock('../github-token-resolver', () => ({
  resolveWorkspaceGitHubToken: jest.fn(async () => ({ token: 'opaque-test-token', source: 'github-app-installation' })),
}));

// Provider-error redaction is isolated from the separately covered release
// identity database contract. Supply one exact immutable actuation capability
// so this fixture reaches the intended failed GitHub response seam.
jest.mock('../release-authority', () => ({
  loadRunReleaseIdentity: jest.fn(async () => ({
    runId: 42,
    workspaceId: 'ws-provider-error',
    specId: 'provider-error',
    authorizedSha: 'a'.repeat(40),
    branchName: 'run/provider-error',
    workspaceRealpath: '/tmp/provider-error',
    worktreeRealpath: '/tmp/provider-error-worktree',
    baseBranch: 'main',
    baseSha: 'b'.repeat(40),
    providerReleaseRef: 'rorca/release/run-42-aaaaaaaaaaaa',
    integrationCheckoutPath: '/tmp/provider-error-integration',
    repository: {
      owner: 'getrorca', name: 'rorca', source: 'github-app-installation',
      bindingId: 'binding-provider-error', installationId: 7, repositoryId: 9,
    },
  })),
}));

jest.mock('../release-identity', () => ({
  revalidateRunReleaseIdentity: jest.fn(async () => undefined),
  withGithubReleaseActuation: jest.fn(async (
    _identity: unknown,
    _purpose: unknown,
    callback: (capability: Record<string, unknown>) => Promise<unknown>,
  ) => callback({
    authority: { owner: 'getrorca', name: 'rorca' },
    credential: { token: 'opaque-test-token', source: 'github-app-installation' },
  })),
}));

import { processAutonomousPrDelivery } from '../autonomous-pr-delivery';
import type { GithubPrDeliveryEvidence } from '../github-pr-delivery-evidence';

const headSha = 'a'.repeat(40);
const baseSha = 'b'.repeat(40);
const policyId = '10000000-0000-4000-8000-000000000001';
const policyDigest = `sha256:${'d'.repeat(64)}`;
const bodySecret = 'ghp_body_secret_must_not_persist';
const requestDerivedText = 'https://github.invalid/private/request?token=request-secret';

const delivery = {
  id: '30000000-0000-4000-8000-000000000003',
  workspace_id: 'ws-provider-error',
  run_id: 42,
  spec_slug: 'provider-error',
  policy_id: policyId,
  policy_digest: policyDigest,
  risk_level: 'low' as const,
  repo_owner: 'getrorca',
  repo_name: 'rorca',
  pr_number: 42,
  base_branch: 'main',
  branch_name: 'run/provider-error',
  initial_head_sha: headSha,
  current_head_sha: headSha,
  merge_method: 'squash' as const,
  retry_budget: { maxAttempts: 2, maxElapsedMinutes: 90 },
  status: 'queued' as const,
  recovery_attempts: 0,
  last_evidence_id: null,
  merge_decision_id: null,
  authorization_snapshot_id: null,
  authorization_evidence_hwm: null,
  authorization_decision_hwm: null,
  authorized_at: null,
  merged_sha: null,
  terminal_reason: null,
  source_request_id: 'provider-error-test',
  deadline_at: '2026-08-01T00:00:00.000Z',
  created_at: '2026-07-17T00:00:00.000Z',
  updated_at: '2026-07-17T00:00:00.000Z',
  completed_at: null,
};

const evidence: GithubPrDeliveryEvidence = {
  schemaVersion: 'rorca.github-pr-delivery-evidence.v1',
  id: '20000000-0000-4000-8000-000000000002',
  workspaceId: delivery.workspace_id,
  runId: delivery.run_id,
  specSlug: delivery.spec_slug,
  policy: { id: policyId, digest: policyDigest },
  repository: { owner: delivery.repo_owner, name: delivery.repo_name },
  pullRequest: {
    number: 42,
    url: 'https://github.com/getrorca/rorca/pull/42',
    state: 'open',
    draft: false,
    merged: false,
    headRef: 'rorca/release/run-42-aaaaaaaaaaaa',
    baseRef: delivery.base_branch,
    headSha,
    baseSha,
    mergeCommitSha: null,
    mergeable: true,
    mergeableState: 'clean',
  },
  freshness: { comparisonStatus: 'ahead', aheadBy: 1, behindBy: 0, branchFresh: true },
  checks: [],
  checksTruncated: false,
  reviews: [],
  reviewsTruncated: false,
  checkSummary: {
    required: [], passing: [], pending: [], failing: [], missing: [],
    allRequiredPassed: true, policyAvailable: true, policyScopeMatches: true, truncated: false,
  },
  reviewSummary: {
    minimumApprovals: 0, currentApprovals: 0, approvedReviewers: [], requiredReviewers: [],
    missingRequiredReviewers: [], changesRequestedBy: [], requireCodeOwnerReview: false,
    codeOwnerReviewStatus: 'not_required', reviewSatisfied: true,
    policyAvailable: true, policyScopeMatches: true, truncated: false,
  },
  providerObservedAt: '2026-07-17T00:02:00.000Z',
  observedBy: { principalId: 'steward', displayLabel: 'Autonomous Delivery Steward' },
  payloadHash: `sha256:${'e'.repeat(64)}`,
  createdAt: '2026-07-17T00:02:00.000Z',
};

const lifecycle = {
  validationEvidenceId: '101',
  mergeEvidenceId: '102',
  mergeDecisionId: '103',
  lifecycleReady: true,
  blockers: [],
  mergeGateStatus: 'passed' as const,
  planApprovalRequirement: 'policy' as const,
  snapshotId: 'snapshot-provider-error',
  evidenceHighWaterMark: 'evidence:102',
  decisionHighWaterMark: 'decision:103:1000',
};

describe('autonomous exact-SHA merge provider errors', () => {
  const persistedValues: string[] = [];
  let terminalReason: string | null;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    persistedValues.length = 0;
    terminalReason = null;
    originalFetch = global.fetch;

    mockQueryOne.mockResolvedValue(delivery);
    mockGetActivePolicy.mockResolvedValue({ id: policyId, policyDigest });
    mockExecute.mockImplementation(async (sqlValue: unknown, params: unknown[] = []) => {
      const sql = String(sqlValue);
      if (sql.includes('terminal_reason = $3')) terminalReason = String(params[2]);
      persistedValues.push(JSON.stringify(params));
      return { rowCount: 1 };
    });
    mockTransaction.mockImplementation(async (callback: (client: { query: jest.Mock }) => Promise<unknown>) => {
      const client = {
        query: jest.fn(async (sqlValue: unknown, params: unknown[] = []) => {
          const sql = String(sqlValue);
          persistedValues.push(JSON.stringify(params));
          if (sql.includes('SELECT * FROM autonomous_pr_deliveries')) {
            return { rows: [{ ...delivery, status: 'observing' }] };
          }
          if (sql.includes('SELECT id FROM autonomous_delivery_policies')) return { rows: [{ id: policyId }] };
          if (sql.includes('SELECT id FROM github_pr_delivery_evidence')) return { rows: [{ id: evidence.id }] };
          if (sql.includes('SELECT id::text FROM ssdlc_decisions')) return { rows: [{ id: lifecycle.mergeDecisionId }] };
          return { rows: [] };
        }),
      };
      return callback(client);
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('persists only bounded sanitized metadata when GitHub returns a secret-bearing merge body', async () => {
    const mergeFailureResponse = new Response(JSON.stringify({
      merged: false,
      message: `${bodySecret} ${requestDerivedText}`,
    }), { status: 422, headers: { 'content-type': 'application/json', 'x-github-request-id': 'REQ-safe-123' } });
    const mergeFailureBodyRead = jest.spyOn(mergeFailureResponse, 'json');
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        state: 'open', draft: false, merged: false, mergeable: true, mergeable_state: 'clean',
        head: { sha: headSha, ref: 'rorca/release/run-42-aaaaaaaaaaaa' },
        base: { sha: baseSha, ref: delivery.base_branch },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(mergeFailureResponse)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        merged: false,
        head: { sha: headSha },
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    global.fetch = fetchMock as typeof fetch;

    await processAutonomousPrDelivery(
      { deliveryId: delivery.id, expectedHeadSha: headSha },
      {
        observe: jest.fn(async () => ({ evidence, replayed: false })),
        bridge: jest.fn(async () => lifecycle),
        schedule: jest.fn(),
        startCiRecovery: jest.fn(),
        recoverConflict: jest.fn(),
        now: () => new Date('2026-07-17T00:02:30.000Z'),
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(mergeFailureBodyRead).not.toHaveBeenCalled();
    expect(terminalReason).toContain('GITHUB_EXACT_SHA_MERGE_FAILED');
    expect(terminalReason).toContain('status=422');
    expect(terminalReason).toContain('request_id=REQ-safe-123');
    expect(terminalReason).toContain('GitHub rejected the request parameters.');
    const durableText = JSON.stringify({ terminalReason, persistedValues });
    expect(durableText).not.toContain(bodySecret);
    expect(durableText).not.toContain(requestDerivedText);
  });
});
