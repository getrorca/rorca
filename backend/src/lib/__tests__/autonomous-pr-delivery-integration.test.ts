/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';

jest.mock('../github-token-resolver', () => ({
  resolveWorkspaceGitHubToken: jest.fn(async () => ({ token: 'opaque-test-token', source: 'workspace-pat' })),
}));

import { execute, queryOne } from '../../db/index';
import { activateAutonomousDeliveryPolicy, createAutonomousDeliveryPolicy } from '../autonomous-delivery-policy';
import { createCanonicalEvidence, persistCanonicalEvidence } from '../ssdlc-evidence';
import {
  processAutonomousPrDelivery,
  reconcileAutonomousPrDeliveryMerge,
} from '../autonomous-pr-delivery';
import type { GithubPrDeliveryEvidence } from '../github-pr-delivery-evidence';

const workspaceId = 'ws-delivery-actuation';
const headSha = 'a'.repeat(40);
const mergedSha = 'c'.repeat(40);
const policyDigestPattern = /^sha256:[0-9a-f]{64}$/;

beforeEach(async () => {
  await execute('TRUNCATE TABLE workspaces CASCADE');
  await execute(`INSERT INTO workspaces (id, label, path, domains) VALUES ($1, 'Actuation', '/tmp/actuation', '[]')`, [workspaceId]);
  await execute(`
    INSERT INTO workspace_github_webhooks
      (workspace_id, repo_owner, repo_name, encrypted_webhook_secret, auto_pr_target_branch, auto_pr_enabled)
    VALUES ($1, 'getrorca', 'rorca', 'test-only', 'main', FALSE)
  `, [workspaceId]);
});

async function fixture() {
  const principal = { principalId: 'operator', displayLabel: 'operator@example.test' };
  const created = await createAutonomousDeliveryPolicy({
    workspaceId,
    principal,
    sourceRequestId: 'actuation-policy-create-001',
    now: new Date('2026-07-17T00:00:00.000Z'),
    draft: {
      baseBranch: 'main', allowedRiskLevels: ['low'], requiredChecks: ['Backend Tests'],
      reviewRules: { minimumApprovals: 1, requireCodeOwnerReview: false, dismissStaleApprovals: true, requiredReviewers: ['release-owner'] },
      mergeMethod: 'squash', retryBudget: { maxAttempts: 2, maxElapsedMinutes: 90 },
      expiresAt: '2026-08-01T00:00:00.000Z',
    },
  });
  expect(created.policy.policyDigest).toMatch(policyDigestPattern);
  await activateAutonomousDeliveryPolicy({
    workspaceId, policyId: created.policy.id, expectedPolicyDigest: created.policy.policyDigest,
    confirmation: 'ENABLE_AUTONOMOUS_PR_DELIVERY', principal,
    sourceRequestId: 'actuation-policy-activate-001', now: new Date('2026-07-17T00:01:00.000Z'),
  });
  const run = await queryOne<{ id: string }>(`
    INSERT INTO pipeline_runs (
      spec_path, workspace_id, status, branch_name, worktree_path, pr_number,
      merge_strategy, auto_merge, merge_status, agent_type, agent_model
    ) VALUES (
      'forge/specs/approved/reviewed-delivery.json', $1, 'done',
      'run/reviewed-delivery', '/tmp/reviewed-worktree', 42,
      'pr', FALSE, 'pending', 'pi', 'openai-codex/gpt-5.6-sol'
    ) RETURNING id::text
  `, [workspaceId]);
  if (!run) throw new Error('run insert failed');
  const runId = Number(run.id);
  const providerId = crypto.randomUUID();
  const providerHash = `sha256:${'d'.repeat(64)}` as const;
  await execute(`
    INSERT INTO github_pr_delivery_evidence (
      id, workspace_id, run_id, policy_id, policy_digest, repo_owner, repo_name,
      pr_number, pr_url, pr_state, draft, merged, head_ref, base_ref, head_sha,
      base_sha, mergeable, mergeable_state, comparison_status, ahead_by, behind_by,
      branch_fresh, checks, reviews, check_summary, review_summary,
      provider_observed_at, observed_by_principal_id, observed_by_display_label, payload_hash
    ) VALUES (
      $1, $2, $3, $4, $5, 'getrorca', 'rorca', 42,
      'https://github.com/getrorca/rorca/pull/42', 'open', FALSE, FALSE,
      'run/reviewed-delivery', 'main', $6, $7, TRUE, 'clean', 'ahead', 2, 0,
      TRUE, '[]', '[]',
      '{"allRequiredPassed":true,"policyAvailable":true,"policyScopeMatches":true}',
      '{"reviewSatisfied":true,"policyAvailable":true,"policyScopeMatches":true}',
      NOW(), 'steward', 'Autonomous Delivery Steward', $8
    )
  `, [providerId, workspaceId, runId, created.policy.id, created.policy.policyDigest, headSha, 'b'.repeat(40), providerHash]);
  const lifecycle = await persistCanonicalEvidence(createCanonicalEvidence({
    sourceType: 'github_check', sourceSystem: 'github-pr-delivery', sourceEventId: `actuation:${providerId}:merge`,
    observedAt: '2026-07-17T00:02:00.000Z',
    scope: { workspaceId, specSlug: 'reviewed-delivery', runId, storyId: null, phaseId: 'merge', gateId: 'gate-merge' },
    subject: { type: 'commit_sha', value: headSha }, phaseSubject: { type: 'commit_sha', value: headSha },
    releaseIdentity: { commitSha: headSha, artifactDigest: `sha256:${'e'.repeat(64)}` },
    classification: 'approval', status: 'passed', trustLevel: 'provider_verified', confidence: 1,
    details: {
      policyVersion: 'policy-v1', compilerVersion: 'ssdlc-plan-compiler-2',
      evidenceRequirementIds: ['evidence-requirement-merge'], providerEvidenceId: providerId,
    },
  }));
  const decision = await queryOne<{ id: string }>(`
    INSERT INTO ssdlc_decisions (
      workspace_id, spec_slug, run_id, phase_id, gate_id, decision_type, rationale,
      subject_type, subject_value, policy_version, policy_reference, policy_authorized,
      principal_type, principal_id, principal_display_label, actor, source_request_id,
      source_channel, scope_key, request_hash, expires_at
    ) VALUES (
      $1, 'reviewed-delivery', $2, 'merge', 'gate-merge', 'policy_approval',
      'Standing operator policy authorized this exact reviewed revision.',
      'commit_sha', $3, 'policy-v1', $4, TRUE, 'internal_service',
      'autonomous-delivery-steward', 'Autonomous Delivery Steward', 'Autonomous Delivery Steward',
      'actuation-policy-approval-001', 'internal', 'reviewed-delivery|merge|gate-merge|*|run',
      $5, '2026-08-01T00:00:00.000Z'
    ) RETURNING id::text
  `, [workspaceId, runId, headSha, `autonomous-delivery:${created.policy.id}:${created.policy.policyDigest}`, `sha256:${'f'.repeat(64)}`]);
  if (!decision) throw new Error('decision insert failed');
  const deliveryId = crypto.randomUUID();
  await execute(`
    INSERT INTO autonomous_pr_deliveries (
      id, workspace_id, run_id, spec_slug, policy_id, policy_digest, risk_level,
      repo_owner, repo_name, pr_number, base_branch, branch_name, initial_head_sha,
      current_head_sha, merge_method, retry_budget, status, source_request_id, deadline_at
    ) VALUES (
      $1, $2, $3, 'reviewed-delivery', $4, $5, 'low', 'getrorca', 'rorca', 42,
      'main', 'run/reviewed-delivery', $6, $6, 'squash',
      '{"maxAttempts":2,"maxElapsedMinutes":90}', 'queued',
      'actuation-delivery-start-001', '2026-08-01T00:00:00.000Z'
    )
  `, [deliveryId, workspaceId, runId, created.policy.id, created.policy.policyDigest, headSha]);
  const evidence: GithubPrDeliveryEvidence = {
    schemaVersion: 'rorca.github-pr-delivery-evidence.v1', id: providerId, workspaceId, runId,
    specSlug: 'reviewed-delivery', policy: { id: created.policy.id, digest: created.policy.policyDigest },
    repository: { owner: 'getrorca', name: 'rorca' },
    pullRequest: {
      number: 42, url: 'https://github.com/getrorca/rorca/pull/42', state: 'open', draft: false,
      merged: false, headRef: 'run/reviewed-delivery', baseRef: 'main', headSha,
      baseSha: 'b'.repeat(40), mergeCommitSha: null, mergeable: true, mergeableState: 'clean',
    },
    freshness: { comparisonStatus: 'ahead', aheadBy: 2, behindBy: 0, branchFresh: true },
    checks: [], checksTruncated: false, reviews: [], reviewsTruncated: false,
    checkSummary: {
      required: ['Backend Tests'], passing: ['Backend Tests'], pending: [], failing: [], missing: [],
      allRequiredPassed: true, policyAvailable: true, policyScopeMatches: true, truncated: false,
    },
    reviewSummary: {
      minimumApprovals: 1, currentApprovals: 1, approvedReviewers: ['release-owner'],
      requiredReviewers: ['release-owner'], missingRequiredReviewers: [], changesRequestedBy: [],
      requireCodeOwnerReview: false, codeOwnerReviewStatus: 'not_required', reviewSatisfied: true,
      policyAvailable: true, policyScopeMatches: true, truncated: false,
    },
    providerObservedAt: '2026-07-17T00:02:00.000Z',
    observedBy: { principalId: 'steward', displayLabel: 'Autonomous Delivery Steward' },
    payloadHash: providerHash, createdAt: '2026-07-17T00:02:00.000Z',
  };
  return {
    deliveryId, runId, evidence, lifecycleEvidenceId: lifecycle.evidence.id,
    decisionId: decision.id, policyId: created.policy.id, policyDigest: created.policy.policyDigest,
  };
}

test('merges exact SHA once and durably closes out merged-SHA/WAL evidence idempotently', async () => {
  const seeded = await fixture();
  const observe = jest.fn(async () => ({ evidence: seeded.evidence, replayed: false }));
  const bridge = jest.fn(async () => ({
    validationEvidenceId: '100',
    mergeEvidenceId: seeded.lifecycleEvidenceId,
    mergeDecisionId: seeded.decisionId,
    lifecycleReady: true,
    blockers: [],
    mergeGateStatus: 'passed',
    planApprovalRequirement: 'policy' as const,
    snapshotId: 'snapshot-actuation-1',
    evidenceHighWaterMark: `evidence:${seeded.lifecycleEvidenceId}`,
    decisionHighWaterMark: `decision:${seeded.decisionId}:1000`,
  }));
  const merge = jest.fn(async () => ({
    mergedSha,
    responseHash: `sha256:${'1'.repeat(64)}` as const,
    mergedAt: '2026-07-17T00:03:00.000Z',
  }));
  const deps = {
    observe,
    bridge,
    merge,
    schedule: jest.fn(),
    startCiRecovery: jest.fn(),
    recoverConflict: jest.fn(),
    now: () => new Date('2026-07-17T00:02:30.000Z'),
  };
  await processAutonomousPrDelivery({ deliveryId: seeded.deliveryId, expectedHeadSha: headSha }, deps as any);
  await processAutonomousPrDelivery({ deliveryId: seeded.deliveryId, expectedHeadSha: headSha }, deps as any);

  expect(merge).toHaveBeenCalledTimes(1);
  expect(observe).toHaveBeenCalledTimes(2); // observation + point-of-no-return recheck
  const delivery = await queryOne<{ status: string; merged_sha: string }>(
    'SELECT status, merged_sha FROM autonomous_pr_deliveries WHERE id = $1', [seeded.deliveryId],
  );
  expect(delivery).toEqual({ status: 'merged', merged_sha: mergedSha });
  const evidenceCount = await queryOne<{ total: number }>(
    'SELECT COUNT(*)::int AS total FROM autonomous_pr_delivery_merge_evidence WHERE delivery_id = $1', [seeded.deliveryId],
  );
  const walCount = await queryOne<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM wal_events WHERE event_type = 'autonomous_pr_merged' AND payload->>'deliveryId' = $1`,
    [seeded.deliveryId],
  );
  expect(evidenceCount?.total).toBe(1);
  expect(walCount?.total).toBe(1);
});

test('reconciles a crash after provider merge without issuing a second merge', async () => {
  const seeded = await fixture();
  await execute(`UPDATE autonomous_pr_deliveries SET status = 'observing' WHERE id = $1`, [seeded.deliveryId]);
  await execute(`
    UPDATE autonomous_pr_deliveries
    SET status = 'authorized', last_evidence_id = $2, merge_decision_id = $3,
        authorization_snapshot_id = 'snapshot-crash-1',
        authorization_evidence_hwm = $4, authorization_decision_hwm = $5,
        authorized_at = NOW(), updated_at = NOW()
    WHERE id = $1
  `, [seeded.deliveryId, seeded.evidence.id, seeded.decisionId,
    `evidence:${seeded.lifecycleEvidenceId}`, `decision:${seeded.decisionId}:1000`]);
  await execute(`UPDATE autonomous_pr_deliveries SET status = 'merging', updated_at = NOW() WHERE id = $1`, [seeded.deliveryId]);

  const originalFetch = global.fetch;
  const fetchMock = jest.fn(async () => new Response(JSON.stringify({
    merged: true,
    merged_at: '2026-07-17T00:04:00.000Z',
    merge_commit_sha: mergedSha,
    head: { sha: headSha },
  }), { status: 200, headers: { 'content-type': 'application/json' } }));
  global.fetch = fetchMock as typeof fetch;
  try {
    await expect(reconcileAutonomousPrDeliveryMerge(seeded.deliveryId)).resolves.toBe(true);
    await expect(reconcileAutonomousPrDeliveryMerge(seeded.deliveryId)).resolves.toBe(false);
  } finally {
    global.fetch = originalFetch;
  }
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const delivery = await queryOne<{ status: string; merged_sha: string }>(
    'SELECT status, merged_sha FROM autonomous_pr_deliveries WHERE id = $1', [seeded.deliveryId],
  );
  expect(delivery).toEqual({ status: 'merged', merged_sha: mergedSha });
  const evidenceCount = await queryOne<{ total: number }>(
    'SELECT COUNT(*)::int AS total FROM autonomous_pr_delivery_merge_evidence WHERE delivery_id = $1', [seeded.deliveryId],
  );
  expect(evidenceCount?.total).toBe(1);
});
