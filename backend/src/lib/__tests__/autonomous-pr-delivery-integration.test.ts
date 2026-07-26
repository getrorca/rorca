/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';

jest.mock('../github-token-resolver', () => ({
  resolveWorkspaceGitHubToken: jest.fn(async () => ({
    token: 'opaque-test-token', source: 'workspace-pat',
    metadata: { fallback: true, repository: { owner: 'getrorca', name: 'rorca' } },
  })),
}));

jest.mock('../run-git-authority', () => ({
  assertCanonicalRunCheckout: jest.fn((input: { expectedHead: string }) => ({ headSha: input.expectedHead })),
}));

import { execute, queryOne } from '../../db/index';
import { activateAutonomousDeliveryPolicy, createAutonomousDeliveryPolicy, revokeAutonomousDeliveryPolicy } from '../autonomous-delivery-policy';
import { createCanonicalEvidence, persistCanonicalEvidence } from '../ssdlc-evidence';
import {
  processAutonomousPrDelivery,
  reconcileAutonomousPrDeliveryMerge,
  withActiveAutonomousDeliveryPolicyActuation,
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
      merge_strategy, auto_merge, merge_status, agent_type, agent_model,
      execution_workspace_path, execution_worktree_path, terminal_checkout_sha, terminal_checkout_attested_at
    ) VALUES (
      'forge/specs/approved/reviewed-delivery.json', $1, 'done',
      'run/reviewed-delivery', '/tmp/reviewed-worktree', 42,
      'pr', FALSE, 'pending', 'pi', 'openai-codex/gpt-5.6-sol',
      '/tmp/actuation', '/tmp/reviewed-worktree', $2, NOW()
    ) RETURNING id::text
  `, [workspaceId, headSha]);
  if (!run) throw new Error('run insert failed');
  const runId = Number(run.id);
  await execute(`
    INSERT INTO pipeline_run_release_intents (
      run_id, workspace_id, spec_id, authorized_sha, branch_name,
      execution_workspace_path, execution_worktree_path,
      repository_owner, repository_name, repository_authority_source,
      merge_strategy, auto_merge, external_send, deployment_allowed,
      identity_hash, status, base_branch, base_sha, provider_release_ref,
      integration_checkout_path
    ) VALUES (
      $1, $2, 'reviewed-delivery', $3, 'run/reviewed-delivery',
      '/tmp/actuation', '/tmp/reviewed-worktree',
      'getrorca', 'rorca', 'pat-oauth-fallback',
      'pr', FALSE, TRUE, FALSE, $4, 'completed', 'main', $5,
      'run/reviewed-delivery', '/tmp/actuation'
    )
  `, [runId, workspaceId, headSha, '2'.repeat(64), 'b'.repeat(40)]);
  const providerId = crypto.randomUUID();
  const providerHash = `sha256:${'d'.repeat(64)}` as const;
  await execute(`
    INSERT INTO github_pr_delivery_evidence (
      id, workspace_id, run_id, policy_id, policy_digest, repo_owner, repo_name,
      pr_number, pr_url, pr_state, draft, merged, head_ref, base_ref, head_sha,
      base_sha, mergeable, mergeable_state, comparison_status, ahead_by, behind_by,
      branch_fresh, checks, reviews, check_summary, review_summary,
      provider_observed_at, observed_by_principal_id, observed_by_display_label, payload_hash,
      repository_authority_source
    ) VALUES (
      $1, $2, $3, $4, $5, 'getrorca', 'rorca', 42,
      'https://github.com/getrorca/rorca/pull/42', 'open', FALSE, FALSE,
      'run/reviewed-delivery', 'main', $6, $7, TRUE, 'clean', 'ahead', 2, 0,
      TRUE, '[]', '[]',
      '{"allRequiredPassed":true,"policyAvailable":true,"policyScopeMatches":true}',
      '{"reviewSatisfied":true,"policyAvailable":true,"policyScopeMatches":true}',
      NOW(), 'steward', 'Autonomous Delivery Steward', $8, 'pat-oauth-fallback'
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
  const providerReceiptId = crypto.randomUUID();
  await execute(`
    INSERT INTO provider_human_authority_receipts (
      id, workspace_id, purpose, target_hash, issuer_id, key_id, key_fingerprint,
      provider, provider_tenant_id, actor_id, conversation_id, thread_id, message_id,
      occurred_at, normalized_command_hash, ingress_idempotency_key, attestation_hash
    ) VALUES (
      $1, $2, 'lifecycle_decision', $3, 'integration-issuer', 'integration-key', $4,
      'slack', 'team-integration', 'release-human', 'channel-integration', 'thread-integration', $5,
      NOW(), $3, $6, $7
    )
  `, [providerReceiptId, workspaceId, `sha256:${'3'.repeat(64)}`, `sha256:${'4'.repeat(64)}`,
    `message-${providerReceiptId}`, `ingress-${providerReceiptId}`, `sha256:${crypto.createHash('sha256').update(providerReceiptId).digest('hex')}`]);
  const decision = await queryOne<{ id: string }>(`
    INSERT INTO ssdlc_decisions (
      workspace_id, spec_slug, run_id, phase_id, gate_id, decision_type, rationale,
      subject_type, subject_value, policy_version, policy_reference, policy_authorized,
      principal_type, principal_id, principal_display_label, actor, source_request_id,
      source_channel, scope_key, request_hash, expires_at, provider_human_receipt_id
    ) VALUES (
      $1, 'reviewed-delivery', $2, 'merge', 'gate-merge', 'merge_approval',
      'Provider human authorized this exact reviewed revision.',
      'commit_sha', $3, 'policy-v1', $4, TRUE, 'provider_human',
      'release-human', 'slack:release-human', 'slack:release-human',
      'actuation-human-merge-approval-001', 'provider', 'reviewed-delivery|merge|gate-merge|*|run',
      $5, '2026-08-01T00:00:00.000Z', $6
    ) RETURNING id::text
  `, [workspaceId, runId, headSha, `autonomous-delivery:${created.policy.id}:${created.policy.policyDigest}`, `sha256:${'f'.repeat(64)}`, providerReceiptId]);
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

test('Release-1 terminalizes autonomous merge before observation or provider effects', async () => {
  const seeded = await fixture();
  const observe = jest.fn();
  const bridge = jest.fn();
  const merge = jest.fn();
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

  expect(observe).not.toHaveBeenCalled();
  expect(bridge).not.toHaveBeenCalled();
  expect(merge).not.toHaveBeenCalled();
  const delivery = await queryOne<{ status: string; merged_sha: string | null; terminal_reason: string }>(
    'SELECT status, merged_sha, terminal_reason FROM autonomous_pr_deliveries WHERE id = $1', [seeded.deliveryId],
  );
  expect(delivery).toEqual({
    status: 'blocked',
    merged_sha: null,
    terminal_reason: 'release_one_capability_disabled:autonomous_provider_merge',
  });
  const evidenceCount = await queryOne<{ total: number }>(
    'SELECT COUNT(*)::int AS total FROM autonomous_pr_delivery_merge_evidence WHERE delivery_id = $1', [seeded.deliveryId],
  );
  const walCount = await queryOne<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM wal_events WHERE event_type = 'autonomous_pr_merged' AND payload->>'deliveryId' = $1`,
    [seeded.deliveryId],
  );
  expect(evidenceCount?.total).toBe(0);
  expect(walCount?.total).toBe(0);
});

test('dormant policy actuation lock still prevents revocation overtaking its point-of-no-return', async () => {
  const seeded = await fixture();
  let enteredEffect!: () => void;
  const effectEntered = new Promise<void>((resolve) => { enteredEffect = resolve; });
  let releaseEffect!: () => void;
  const effectRelease = new Promise<void>((resolve) => { releaseEffect = resolve; });
  const processing = withActiveAutonomousDeliveryPolicyActuation({
    policyId: seeded.policyId,
    workspaceId,
    policyDigest: seeded.policyDigest,
  }, async ({ revalidatePolicy }) => {
    enteredEffect();
    await effectRelease;
    await revalidatePolicy();
  });
  await effectEntered;

  let revocationSettled = false;
  const revocation = revokeAutonomousDeliveryPolicy({
    workspaceId, policyId: seeded.policyId,
    reason: 'Operator revoked policy during the deterministic dormant-actuation race.',
    principal: { principalId: 'operator', displayLabel: 'operator@example.test' },
    sourceRequestId: 'actuation-policy-revoke-race-001', now: new Date(),
  }).then((result) => { revocationSettled = true; return result; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const revocationOvertookEffect = revocationSettled;
  releaseEffect();
  await processing;
  await revocation;

  expect(revocationOvertookEffect).toBe(false);
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
  const fetchMock = jest.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/compare/')) return new Response(JSON.stringify({
      status: 'ahead', ahead_by: 1, merge_base_commit: { sha: 'b'.repeat(40) },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({
      number: 42,
      html_url: 'https://github.com/getrorca/rorca/pull/42',
      state: 'closed', draft: false, merged: true,
      merged_at: '2026-07-17T00:04:00.000Z', merge_commit_sha: mergedSha,
      head: { sha: headSha, ref: 'run/reviewed-delivery', repo: { full_name: 'getrorca/rorca' } },
      // The mutable base tip advanced after merge and deliberately differs from
      // the immutable pre-merge evidence base (`b...`).
      base: { sha: mergedSha, ref: 'main', repo: { full_name: 'getrorca/rorca' } },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  global.fetch = fetchMock as typeof fetch;
  try {
    expect(await reconcileAutonomousPrDeliveryMerge(seeded.deliveryId)).toBe(true);
    expect(await reconcileAutonomousPrDeliveryMerge(seeded.deliveryId)).toBe(false);
  } finally {
    global.fetch = originalFetch;
  }
  expect(fetchMock).toHaveBeenCalledTimes(2);
  const delivery = await queryOne<{ status: string; merged_sha: string }>(
    'SELECT status, merged_sha FROM autonomous_pr_deliveries WHERE id = $1', [seeded.deliveryId],
  );
  expect(delivery).toEqual({ status: 'merged', merged_sha: mergedSha });
  const evidenceCount = await queryOne<{ total: number }>(
    'SELECT COUNT(*)::int AS total FROM autonomous_pr_delivery_merge_evidence WHERE delivery_id = $1', [seeded.deliveryId],
  );
  expect(evidenceCount?.total).toBe(1);
});
