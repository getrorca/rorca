/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import { execute, queryOne } from '../index';
import {
  activateAutonomousDeliveryPolicy,
  createAutonomousDeliveryPolicy,
  revokeAutonomousDeliveryPolicy,
} from '../../lib/autonomous-delivery-policy';
import { createCanonicalEvidence, persistCanonicalEvidence } from '../../lib/ssdlc-evidence';

const workspaceId = 'ws-autonomous-reviewed-delivery';
const policyIdPattern = /^[0-9a-f-]{36}$/;
const headSha = 'a'.repeat(40);
const baseSha = 'b'.repeat(40);
const mergedSha = 'c'.repeat(40);
const principal = { principalId: 'operator-1', displayLabel: 'operator@example.test' };

beforeEach(async () => {
  await execute('TRUNCATE TABLE workspaces CASCADE');
  await execute(
    `INSERT INTO workspaces (id, label, path, domains)
     VALUES ($1, 'Reviewed delivery migration', '/tmp/reviewed-delivery', '[]')`,
    [workspaceId],
  );
  await execute(
    `INSERT INTO workspace_github_webhooks
       (workspace_id, repo_owner, repo_name, encrypted_webhook_secret,
        auto_pr_target_branch, auto_pr_enabled)
     VALUES ($1, 'getrorca', 'rorca', 'test-only', 'main', FALSE)`,
    [workspaceId],
  );
});

async function seedAuthority() {
  const created = await createAutonomousDeliveryPolicy({
    workspaceId,
    principal,
    sourceRequestId: 'reviewed-policy-create-001',
    now: new Date('2026-07-17T00:00:00.000Z'),
    draft: {
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
      expiresAt: '2026-08-01T00:00:00.000Z',
    },
  });
  expect(created.policy.id).toMatch(policyIdPattern);
  await activateAutonomousDeliveryPolicy({
    workspaceId,
    policyId: created.policy.id,
    expectedPolicyDigest: created.policy.policyDigest,
    confirmation: 'ENABLE_AUTONOMOUS_PR_DELIVERY',
    principal,
    sourceRequestId: 'reviewed-policy-activate-001',
    now: new Date('2026-07-17T00:01:00.000Z'),
  });
  const run = await queryOne<{ id: number }>(`
    INSERT INTO pipeline_runs (
      spec_path, workspace_id, status, branch_name, worktree_path,
      pr_number, merge_strategy, auto_merge, agent_type, agent_model
    ) VALUES (
      'forge/specs/approved/reviewed-delivery.json', $1, 'done',
      'run/reviewed-delivery', '/tmp/reviewed-delivery-worktree', 42,
      'pr', FALSE, 'pi', 'openai-codex/gpt-5.6-sol'
    ) RETURNING id
  `, [workspaceId]);
  if (!run) throw new Error('run insert failed');
  const runId = Number(run.id);

  const githubEvidenceId = crypto.randomUUID();
  await execute(`
    INSERT INTO github_pr_delivery_evidence (
      id, workspace_id, run_id, policy_id, policy_digest, repo_owner, repo_name,
      pr_number, pr_url, pr_state, draft, merged, head_ref, base_ref, head_sha,
      base_sha, mergeable, mergeable_state, comparison_status, ahead_by, behind_by,
      branch_fresh, checks, reviews, check_summary, review_summary,
      provider_observed_at, observed_by_principal_id, observed_by_display_label,
      payload_hash
    ) VALUES (
      $1, $2, $3, $4, $5, 'getrorca', 'rorca', 42,
      'https://github.com/getrorca/rorca/pull/42', 'open', FALSE, FALSE,
      'run/reviewed-delivery', 'main', $6, $7, TRUE, 'clean', 'ahead', 2, 0,
      TRUE, '[]', '[]', '{"allRequiredPassed":true}', '{"reviewSatisfied":true}',
      NOW(), 'steward', 'Autonomous Delivery Steward', $8
    )
  `, [githubEvidenceId, workspaceId, runId, created.policy.id, created.policy.policyDigest,
    headSha, baseSha, `sha256:${'d'.repeat(64)}`]);

  const lifecycle = await persistCanonicalEvidence(createCanonicalEvidence({
    sourceType: 'github_check',
    sourceSystem: 'github-pr-delivery',
    sourceEventId: `reviewed-delivery:${githubEvidenceId}:merge`,
    observedAt: '2026-07-17T00:02:00.000Z',
    scope: { workspaceId, specSlug: 'reviewed-delivery', runId, storyId: null, phaseId: 'merge', gateId: 'gate-merge' },
    subject: { type: 'commit_sha', value: headSha },
    phaseSubject: { type: 'commit_sha', value: headSha },
    releaseIdentity: { commitSha: headSha, artifactDigest: `sha256:${'e'.repeat(64)}` },
    classification: 'approval',
    status: 'passed',
    trustLevel: 'provider_verified',
    confidence: 1,
    details: { policyVersion: 'policy-v1', compilerVersion: 'ssdlc-plan-compiler-2', evidenceRequirementIds: ['evidence-requirement-merge'] },
  }));

  const decision = await queryOne<{ id: number }>(`
    INSERT INTO ssdlc_decisions (
      workspace_id, spec_slug, run_id, phase_id, gate_id, decision_type,
      rationale, subject_type, subject_value, policy_version, policy_reference,
      policy_authorized, principal_type, principal_id, principal_display_label,
      actor, source_request_id, source_channel, scope_key, request_hash, expires_at
    ) VALUES (
      $1, 'reviewed-delivery', $2, 'merge', 'gate-merge', 'policy_approval',
      'Standing operator policy authorized this exact reviewed revision.',
      'commit_sha', $3, 'policy-v1', $4, TRUE, 'internal_service',
      'autonomous-delivery-steward', 'Autonomous Delivery Steward',
      'Autonomous Delivery Steward', 'policy-approval-review-001', 'internal',
      'reviewed-delivery|merge|gate-merge|*|run', $5, '2026-08-01T00:00:00.000Z'
    ) RETURNING id
  `, [workspaceId, runId, headSha,
    `autonomous-delivery:${created.policy.id}:${created.policy.policyDigest}`,
    `sha256:${'f'.repeat(64)}`]);
  if (!decision) throw new Error('decision insert failed');
  return { policy: created.policy, runId, githubEvidenceId, lifecycleEvidenceId: lifecycle.evidence.id, decisionId: Number(decision.id) };
}

test('creates bounded reviewed-delivery state without pgboss objects and enforces terminal evidence', async () => {
  const authority = await seedAuthority();
  const deliveryId = crypto.randomUUID();
  await execute(`
    INSERT INTO autonomous_pr_deliveries (
      id, workspace_id, run_id, spec_slug, policy_id, policy_digest, risk_level,
      repo_owner, repo_name, pr_number, base_branch, branch_name,
      initial_head_sha, current_head_sha, merge_method, retry_budget, status,
      last_evidence_id, merge_decision_id, source_request_id, deadline_at
    ) VALUES (
      $1, $2, $3, 'reviewed-delivery', $4, $5, 'low', 'getrorca', 'rorca', 42,
      'main', 'run/reviewed-delivery', $6, $6, 'squash',
      '{"maxAttempts":2,"maxElapsedMinutes":90}', 'merging', $7, $8,
      'delivery-start-review-001', '2026-07-17T02:00:00.000Z'
    )
  `, [deliveryId, workspaceId, authority.runId, authority.policy.id,
    authority.policy.policyDigest, headSha, authority.githubEvidenceId, authority.decisionId]);

  await execute(`
    INSERT INTO autonomous_pr_delivery_merge_evidence (
      id, delivery_id, workspace_id, run_id, policy_id, policy_digest,
      github_evidence_id, lifecycle_merge_evidence_id, merge_decision_id,
      lifecycle_snapshot_id, evidence_high_water_mark, decision_high_water_mark,
      repo_owner, repo_name, pr_number, expected_head_sha, merged_sha,
      merge_method, provider_response_hash, merged_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9,
      'snapshot-reviewed-001', 'evidence:10', 'decision:5:1000',
      'getrorca', 'rorca', 42, $10, $11, 'squash', $12, NOW()
    )
  `, [crypto.randomUUID(), deliveryId, workspaceId, authority.runId,
    authority.policy.id, authority.policy.policyDigest, authority.githubEvidenceId,
    authority.lifecycleEvidenceId, authority.decisionId, headSha, mergedSha,
    `sha256:${'1'.repeat(64)}`]);
  await execute(`
    UPDATE autonomous_pr_deliveries
    SET status = 'merged', merged_sha = $2, completed_at = NOW(), updated_at = NOW()
    WHERE id = $1
  `, [deliveryId, mergedSha]);

  await expect(execute('DELETE FROM autonomous_pr_delivery_merge_evidence WHERE delivery_id = $1', [deliveryId]))
    .rejects.toThrow(/append-only/i);
  await expect(execute("UPDATE autonomous_pr_deliveries SET status = 'queued' WHERE id = $1", [deliveryId]))
    .rejects.toThrow(/terminal/i);
  await expect(execute('DELETE FROM autonomous_pr_deliveries WHERE id = $1', [deliveryId]))
    .rejects.toThrow(/audit-retained/i);

  const lifecycleRunIds = await queryOne<{ bigint_columns: number }>(`
    SELECT COUNT(*)::int AS bigint_columns
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name IN ('ssdlc_lifecycle_evidence', 'ssdlc_decisions')
      AND column_name = 'run_id' AND data_type = 'bigint'
  `);
  expect(lifecycleRunIds?.bigint_columns).toBe(2);

  const pgbossTouches = await queryOne<{ total: number }>(`
    SELECT COUNT(*)::int AS total
    FROM information_schema.tables
    WHERE table_schema = 'pgboss' AND table_name LIKE '%autonomous%'
  `);
  expect(pgbossTouches?.total).toBe(0);
});

test('operator revocation invalidates derived policy authority and stops queued delivery', async () => {
  const authority = await seedAuthority();
  const deliveryId = crypto.randomUUID();
  await execute(`
    INSERT INTO autonomous_pr_deliveries (
      id, workspace_id, run_id, spec_slug, policy_id, policy_digest, risk_level,
      repo_owner, repo_name, pr_number, base_branch, branch_name,
      initial_head_sha, current_head_sha, merge_method, retry_budget, status,
      source_request_id, deadline_at
    ) VALUES ($1, $2, $3, 'reviewed-delivery', $4, $5, 'low', 'getrorca', 'rorca',
              42, 'main', 'run/reviewed-delivery', $6, $6, 'squash',
              '{"maxAttempts":2,"maxElapsedMinutes":90}', 'queued',
              'delivery-revocation-review-001', '2026-08-01T00:00:00.000Z')
  `, [deliveryId, workspaceId, authority.runId, authority.policy.id, authority.policy.policyDigest, headSha]);

  await revokeAutonomousDeliveryPolicy({
    workspaceId,
    policyId: authority.policy.id,
    reason: 'Operator revoked standing authority during reviewed delivery validation.',
    principal,
    sourceRequestId: 'reviewed-policy-revoke-001',
    now: new Date(Date.now() + 1_000),
  });
  const decision = await queryOne<{ revoked_at: Date | null }>('SELECT revoked_at FROM ssdlc_decisions WHERE id = $1', [authority.decisionId]);
  const delivery = await queryOne<{ status: string; terminal_reason: string }>(
    'SELECT status, terminal_reason FROM autonomous_pr_deliveries WHERE id = $1', [deliveryId],
  );
  const blockedEvent = await queryOne<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM autonomous_pr_delivery_events
     WHERE delivery_id = $1 AND event_type = 'blocked'`, [deliveryId],
  );
  expect(decision?.revoked_at).not.toBeNull();
  expect(delivery).toEqual({ status: 'blocked', terminal_reason: 'standing_policy_revoked' });
  expect(blockedEvent?.total).toBe(1);
});

test('permits one bounded recovery terminal transition and blocks rewriting its identity', async () => {
  const authority = await seedAuthority();
  const deliveryId = crypto.randomUUID();
  await execute(`
    INSERT INTO autonomous_pr_deliveries (
      id, workspace_id, run_id, spec_slug, policy_id, policy_digest, risk_level,
      repo_owner, repo_name, pr_number, base_branch, branch_name,
      initial_head_sha, current_head_sha, merge_method, retry_budget, status,
      source_request_id, deadline_at
    ) VALUES ($1, $2, $3, 'reviewed-delivery', $4, $5, 'low', 'getrorca', 'rorca',
              42, 'main', 'run/reviewed-delivery', $6, $6, 'squash',
              '{"maxAttempts":2,"maxElapsedMinutes":90}', 'recovering_conflict',
              'delivery-recovery-review-001', '2026-07-17T02:00:00.000Z')
  `, [deliveryId, workspaceId, authority.runId, authority.policy.id, authority.policy.policyDigest, headSha]);
  const attemptId = crypto.randomUUID();
  await execute(`
    INSERT INTO autonomous_pr_delivery_recovery_attempts (
      id, delivery_id, attempt_number, recovery_kind, status, head_sha_before, classification
    ) VALUES ($1, $2, 1, 'conflict', 'started', $3, 'base_branch_conflict')
  `, [attemptId, deliveryId, headSha]);
  const nextHead = '9'.repeat(40);
  await execute(`
    UPDATE autonomous_pr_delivery_recovery_attempts
    SET status = 'completed', head_sha_after = $2, finished_at = NOW()
    WHERE id = $1
  `, [attemptId, nextHead]);
  await expect(execute(`
    UPDATE autonomous_pr_delivery_recovery_attempts SET failure_reason = 'rewrite' WHERE id = $1
  `, [attemptId])).rejects.toThrow(/one terminal transition/i);
  await expect(execute('DELETE FROM autonomous_pr_delivery_recovery_attempts WHERE id = $1', [attemptId]))
    .rejects.toThrow(/audit-retained/i);
});
