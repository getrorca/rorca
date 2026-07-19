/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { normalizedSha, observeGithubPrDeliveryEvidence } from '../github-pr-delivery-evidence';

const headSha = 'a'.repeat(40);
const baseSha = 'b'.repeat(40);
const now = new Date('2026-07-16T12:00:00.000Z');

test('exact SHA normalization trims whitespace but rejects every overlong identity', () => {
  expect(normalizedSha(`  ${'a'.repeat(40)}\n`, 'sha')).toBe('a'.repeat(40));
  expect(() => normalizedSha('B'.repeat(64), 'sha')).toThrow('full Git commit SHA');
  expect(() => normalizedSha('a'.repeat(41), 'sha')).toThrow('full Git commit SHA');
  expect(() => normalizedSha('a'.repeat(65), 'sha')).toThrow('full Git commit SHA');
});

const activePolicy = {
  id: '10000000-0000-4000-8000-000000000001',
  workspaceId: 'ws-1',
  revision: 1,
  schemaVersion: 'rorca.autonomous-delivery-policy.v1',
  repository: { owner: 'getrorca', name: 'rorca' },
  baseBranch: 'main',
  allowedRiskLevels: ['low'],
  requiredChecks: ['Backend Tests'],
  reviewRules: {
    minimumApprovals: 1,
    requireCodeOwnerReview: false,
    dismissStaleApprovals: true,
    requiredReviewers: ['release-owner'],
  },
  mergeMethod: 'squash',
  retryBudget: { maxAttempts: 2, maxElapsedMinutes: 90 },
  deploymentAllowed: false,
  expiresAt: '2026-08-01T12:00:00.000Z',
  policyDigest: `sha256:${'c'.repeat(64)}`,
  status: 'active',
  effectiveStatus: 'active',
  createdBy: { principalId: 'operator', displayLabel: 'operator@example.test' },
  createdAt: '2026-07-16T10:00:00.000Z',
  activatedAt: '2026-07-16T11:00:00.000Z',
  activatedBy: { principalId: 'operator', displayLabel: 'operator@example.test' },
  revokedAt: null,
  revokedBy: null,
  revocationReason: null,
} as const;

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 20260316000001,
    workspace_id: 'ws-1',
    spec_path: 'forge/specs/approved/safe-delivery.json',
    branch_name: 'run/safe-delivery',
    pr_number: 42,
    repo_owner: 'getrorca',
    repo_name: 'rorca',
    release_base_branch: 'main',
    ...overrides,
  };
}

function pull(overrides: Record<string, unknown> = {}) {
  return {
    number: 42,
    html_url: 'https://github.com/getrorca/rorca/pull/42',
    state: 'open',
    draft: false,
    merged: false,
    mergeable: true,
    mergeable_state: 'clean',
    merge_commit_sha: null,
    updated_at: now.toISOString(),
    head: { ref: 'run/safe-delivery', sha: headSha, repo: { full_name: 'getrorca/rorca' } },
    base: { ref: 'main', sha: baseSha, repo: { full_name: 'getrorca/rorca' } },
    ...overrides,
  };
}

function insertedRow(params: unknown[]) {
  return {
    id: params[0], workspace_id: params[1], run_id: params[2], policy_id: params[3], policy_digest: params[4],
    repo_owner: params[5], repo_name: params[6], pr_number: params[7], pr_url: params[8], pr_state: params[9],
    draft: params[10], merged: params[11], head_ref: params[12], base_ref: params[13], head_sha: params[14],
    base_sha: params[15], merge_commit_sha: params[16], mergeable: params[17], mergeable_state: params[18],
    comparison_status: params[19], ahead_by: params[20], behind_by: params[21], branch_fresh: params[22],
    checks: params[23], checks_truncated: params[24], reviews: params[25], reviews_truncated: params[26],
    check_summary: params[27], review_summary: params[28], provider_observed_at: params[29],
    observed_by_principal_id: params[30], observed_by_display_label: params[31], payload_hash: params[32],
    created_at: now.toISOString(),
  };
}

function harness(options: {
  pull?: Record<string, unknown>;
  finalPull?: Record<string, unknown>;
  reviews?: unknown[];
  checkRuns?: unknown[];
  statuses?: unknown[];
  policy?: typeof activePolicy | null;
} = {}) {
  const urls: string[] = [];
  let pullCalls = 0;
  const inserted: unknown[][] = [];
  const wal: unknown[][] = [];
  const client = {
    query: jest.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('SELECT e.*')) return { rows: [] };
      if (sql.includes('INSERT INTO github_pr_delivery_evidence')) {
        inserted.push(params);
        return { rows: [insertedRow(params)] };
      }
      if (sql.includes('INSERT INTO wal_events')) {
        wal.push(params);
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }),
  };
  const fetchJson = jest.fn(async (url: string) => {
    urls.push(url);
    if (/\/pulls\/42$/.test(url)) {
      pullCalls += 1;
      return pull(pullCalls > 1 && options.finalPull ? options.finalPull : options.pull);
    }
    if (url.includes('/check-runs')) {
      const checkRuns = options.checkRuns ?? [{
        id: 501, name: 'Backend Tests', status: 'completed', conclusion: 'success',
        details_url: 'https://github.com/getrorca/rorca/actions/runs/1', completed_at: now.toISOString(),
        app: { slug: 'github-actions' },
      }];
      return { total_count: checkRuns.length, check_runs: checkRuns };
    }
    if (url.includes(`/commits/${headSha}/statuses?`)) return options.statuses ?? [];
    if (url.includes('/pulls/42/reviews')) {
      return options.reviews ?? [{
        id: 601, state: 'APPROVED', commit_id: headSha, submitted_at: now.toISOString(),
        user: { login: 'release-owner' }, author_association: 'MEMBER',
      }];
    }
    if (url.includes('/compare/')) return { status: 'ahead', ahead_by: 5, behind_by: 0 };
    throw new Error(`Unexpected GitHub URL: ${url}`);
  });
  return {
    urls, inserted, wal, fetchJson, client,
    overrides: {
      resolveAuthority: jest.fn(async () => ({
        owner: 'getrorca', name: 'rorca', status: 'active', source: 'pat-oauth-fallback',
      })),
      queryOne: jest.fn(async () => runRow()),
      resolveToken: jest.fn(async () => ({ token: 'opaque-test-token', source: 'workspace-pat' })),
      getActivePolicy: jest.fn(async () => options.policy === undefined ? activePolicy : options.policy),
      fetchJson,
      now: () => now,
      transaction: jest.fn(async (fn: (value: typeof client) => Promise<unknown>) => fn(client)),
    },
  };
}

describe('exact-SHA GitHub PR delivery evidence', () => {
  test('binds repository/run/branch/SHA and persists bounded provider evidence append-only', async () => {
    const test = harness();
    const result = await observeGithubPrDeliveryEvidence({
      workspaceId: 'ws-1',
      runId: 20260316000001,
      expectedHeadSha: headSha,
      principal: { principalId: 'operator', displayLabel: 'operator@example.test' },
    }, test.overrides as any);

    expect(result.replayed).toBe(false);
    expect(result.evidence).toMatchObject({
      workspaceId: 'ws-1',
      runId: 20260316000001,
      policy: { id: activePolicy.id, digest: activePolicy.policyDigest },
      repository: { owner: 'getrorca', name: 'rorca' },
      pullRequest: { number: 42, headRef: 'run/safe-delivery', baseRef: 'main', headSha, baseSha },
      freshness: { comparisonStatus: 'ahead', behindBy: 0, branchFresh: true },
      checkSummary: { allRequiredPassed: true, policyScopeMatches: true },
      reviewSummary: { reviewSatisfied: true, currentApprovals: 1, policyScopeMatches: true },
      payloadHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    expect(test.inserted).toHaveLength(1);
    expect(test.wal).toHaveLength(1);
    expect(JSON.stringify(test.inserted)).not.toContain('opaque-test-token');
    expect(JSON.stringify(test.wal)).not.toContain('opaque-test-token');
    expect(test.urls.every((url) => url.startsWith('https://api.github.com/repos/getrorca/rorca/'))).toBe(true);
  });

  test('fails closed before persistence when the provider head SHA changed', async () => {
    const test = harness({ pull: { head: { ref: 'run/safe-delivery', sha: 'd'.repeat(40), repo: { full_name: 'getrorca/rorca' } } } });
    await expect(observeGithubPrDeliveryEvidence({
      workspaceId: 'ws-1', runId: 20260316000001, expectedHeadSha: headSha,
      principal: { principalId: 'operator', displayLabel: 'operator@example.test' },
    }, test.overrides as any)).rejects.toThrow('head SHA changed');
    expect(test.inserted).toHaveLength(0);
    expect(test.urls).toHaveLength(1);
  });

  test('manual operator status can never satisfy a required autonomous delivery check', async () => {
    const manualPolicy = { ...activePolicy, requiredChecks: ['rorca/manual-spec-compliance'] } as unknown as typeof activePolicy;
    const test = harness({ policy: manualPolicy, statuses: [{
      id: 900, context: 'rorca/manual-spec-compliance', state: 'success', updated_at: now.toISOString(),
      creator: { login: 'release-owner' },
    }] });
    const result = await observeGithubPrDeliveryEvidence({
      workspaceId: 'ws-1', runId: 20260316000001, expectedHeadSha: headSha,
      principal: { principalId: 'operator', displayLabel: 'operator@example.test' },
    }, test.overrides as any);
    expect(result.evidence.checks.map((check) => check.name)).not.toContain('rorca/manual-spec-compliance');
    expect(result.evidence.checkSummary).toMatchObject({ allRequiredPassed: false, missing: ['rorca/manual-spec-compliance'] });
  });

  test('does not accept stale approvals or a mismatched policy base branch', async () => {
    const staleSha = 'e'.repeat(40);
    const test = harness({
      reviews: [{
        id: 601, state: 'APPROVED', commit_id: staleSha, submitted_at: now.toISOString(),
        user: { login: 'release-owner' }, author_association: 'MEMBER',
      }],
      policy: { ...activePolicy, baseBranch: 'release' } as unknown as typeof activePolicy,
    });
    const result = await observeGithubPrDeliveryEvidence({
      workspaceId: 'ws-1', runId: 20260316000001, expectedHeadSha: headSha,
      principal: { principalId: 'operator', displayLabel: 'operator@example.test' },
    }, test.overrides as any);

    expect(result.evidence.reviews[0]).toMatchObject({ currentHead: false });
    expect(result.evidence.checkSummary).toMatchObject({ allRequiredPassed: false, policyScopeMatches: false });
    expect(result.evidence.reviewSummary).toMatchObject({
      reviewSatisfied: false, currentApprovals: 0, missingRequiredReviewers: ['release-owner'], policyScopeMatches: false,
    });
  });

  test('fails closed when the PR changes during the observation window', async () => {
    const test = harness({ finalPull: {
      head: { ref: 'run/safe-delivery', sha: 'd'.repeat(40), repo: { full_name: 'getrorca/rorca' } },
    } });
    await expect(observeGithubPrDeliveryEvidence({
      workspaceId: 'ws-1', runId: 20260316000001, expectedHeadSha: headSha,
      principal: { principalId: 'operator', displayLabel: 'operator@example.test' },
    }, test.overrides as any)).rejects.toThrow('changed while');
    expect(test.inserted).toHaveLength(0);
  });

  test('a latest failing duplicate check identity dominates historical success', async () => {
    const test = harness({ checkRuns: [
      { id: 500, name: 'Backend Tests', status: 'completed', conclusion: 'success', completed_at: '2026-07-16T11:00:00.000Z', app: { slug: 'github-actions' } },
      { id: 501, name: 'Backend Tests', status: 'completed', conclusion: 'failure', completed_at: now.toISOString(), app: { slug: 'github-actions' } },
      { id: 700, name: 'Backend Tests', status: 'completed', conclusion: 'success', completed_at: now.toISOString(), app: { slug: 'untrusted-app' } },
    ] });
    const result = await observeGithubPrDeliveryEvidence({
      workspaceId: 'ws-1', runId: 20260316000001, expectedHeadSha: headSha,
      principal: { principalId: 'operator', displayLabel: 'operator@example.test' },
    }, test.overrides as any);
    expect(result.evidence.checkSummary).toMatchObject({ allRequiredPassed: false, failing: ['Backend Tests'] });
  });

  test('an unresolved old-SHA change request remains blocking after a push', async () => {
    const test = harness({ reviews: [{
      id: '90071992547409930001', state: 'CHANGES_REQUESTED', commit_id: 'e'.repeat(40), submitted_at: now.toISOString(),
      user: { login: 'release-owner' }, author_association: 'MEMBER',
    }] });
    const result = await observeGithubPrDeliveryEvidence({
      workspaceId: 'ws-1', runId: 20260316000001, expectedHeadSha: headSha,
      principal: { principalId: 'operator', displayLabel: 'operator@example.test' },
    }, test.overrides as any);
    expect(result.evidence.reviewSummary).toMatchObject({
      reviewSatisfied: false,
      changesRequestedBy: ['release-owner'],
    });
  });

  test('records observation without claiming gate readiness when no active policy exists', async () => {
    const test = harness({ policy: null });
    const result = await observeGithubPrDeliveryEvidence({
      workspaceId: 'ws-1', runId: 20260316000001, expectedHeadSha: headSha,
      principal: { principalId: 'operator', displayLabel: 'operator@example.test' },
    }, test.overrides as any);
    expect(result.evidence.policy).toBeNull();
    expect(result.evidence.checkSummary).toMatchObject({ policyAvailable: false, allRequiredPassed: false });
    expect(result.evidence.reviewSummary).toMatchObject({ policyAvailable: false, reviewSatisfied: false });
  });
});
