/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { checkDuplicatePrefixes } from '../pg-index';
import { execute, queryOne } from '../index';
import {
  activateAutonomousDeliveryPolicy,
  createAutonomousDeliveryPolicy,
  revokeAutonomousDeliveryPolicy,
} from '../../lib/autonomous-delivery-policy';

const migrationFile = '20260715210000_autonomous_delivery_governance.sql';
const migrationDir = path.join(__dirname, '..', 'pg-migrations');
const sql = fs.readFileSync(path.join(migrationDir, migrationFile), 'utf8');
const principal = { principalId: 'operator-1', displayLabel: 'operator@example.test' };

async function workspaceFixture(id: string): Promise<void> {
  await execute(
    `INSERT INTO workspaces (id, label, path, domains) VALUES ($1, $2, $3, '[]')`,
    [id, id, `/tmp/${id}`],
  );
  await execute(
    `INSERT INTO workspace_github_webhooks
      (workspace_id, repo_owner, repo_name, encrypted_webhook_secret, auto_pr_target_branch)
     VALUES ($1, 'getrorca', 'rorca', 'test-only-secret-ciphertext', 'main')`,
    [id],
  );
}

function policyDraft(now: Date) {
  return {
    baseBranch: 'main',
    allowedRiskLevels: ['low'] as Array<'low' | 'medium'>,
    requiredChecks: ['Backend Tests'],
    reviewRules: {
      minimumApprovals: 1,
      requireCodeOwnerReview: false,
      dismissStaleApprovals: true as const,
      requiredReviewers: ['release-owner'],
    },
    mergeMethod: 'squash' as const,
    retryBudget: { maxAttempts: 2, maxElapsedMinutes: 90 },
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000).toISOString(),
  };
}

describe('autonomous delivery governance migration', () => {
  test('is collision-free, bounded, append-only, and never manages pgboss', () => {
    const files = fs.readdirSync(migrationDir).filter((file) => file.endsWith('.sql'));
    expect(() => checkDuplicatePrefixes(files)).not.toThrow();
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS autonomous_delivery_policies');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS github_pr_delivery_evidence');
    expect(sql).toContain("allowed_risk_levels <@ '[\"low\", \"medium\"]'::jsonb");
    expect(sql).toContain('deployment_allowed BOOLEAN NOT NULL DEFAULT FALSE CHECK (deployment_allowed = FALSE)');
    expect(sql).toContain('autonomous delivery policy state transitions are one-way');
    expect(sql).toContain('github_pr_delivery_evidence_append_only');
    expect(sql).not.toMatch(/\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|SCHEMA).*pgboss/is);
  });

  test('creates disabled, activates exact digest, freezes scope, and revokes one-way', async () => {
    const now = new Date();
    const workspaceId = `ws-delivery-policy-${crypto.randomUUID()}`;
    await workspaceFixture(workspaceId);
    const created = await createAutonomousDeliveryPolicy({
      workspaceId,
      draft: policyDraft(now),
      principal,
      sourceRequestId: 'policy-create-db-001',
      now,
    });
    expect(created).toMatchObject({ replayed: false, policy: { status: 'disabled', deploymentAllowed: false } });
    const createReplay = await createAutonomousDeliveryPolicy({
      workspaceId,
      draft: policyDraft(now),
      principal,
      sourceRequestId: 'policy-create-db-001',
      now,
    });
    expect(createReplay).toMatchObject({ replayed: true, policy: { id: created.policy.id } });

    const activated = await activateAutonomousDeliveryPolicy({
      workspaceId,
      policyId: created.policy.id,
      expectedPolicyDigest: created.policy.policyDigest,
      confirmation: 'ENABLE_AUTONOMOUS_PR_DELIVERY',
      principal,
      sourceRequestId: 'policy-activate-db-001',
      now: new Date(now.getTime() + 1_000),
    });
    expect(activated.policy.status).toBe('active');
    const activationReplay = await activateAutonomousDeliveryPolicy({
      workspaceId,
      policyId: created.policy.id,
      expectedPolicyDigest: created.policy.policyDigest,
      confirmation: 'ENABLE_AUTONOMOUS_PR_DELIVERY',
      principal,
      sourceRequestId: 'policy-activate-db-001',
      now: new Date(now.getTime() + 1_000),
    });
    expect(activationReplay).toMatchObject({ replayed: true, policy: { status: 'active' } });

    await expect(execute(
      `UPDATE autonomous_delivery_policies SET required_checks = '["Different Check"]'::jsonb WHERE id = $1`,
      [created.policy.id],
    )).rejects.toThrow('policy scope and authority are immutable');

    const revoked = await revokeAutonomousDeliveryPolicy({
      workspaceId,
      policyId: created.policy.id,
      reason: 'Operator revoked the standing policy after review.',
      principal,
      sourceRequestId: 'policy-revoke-db-001',
      now: new Date(now.getTime() + 2_000),
    });
    expect(revoked.policy.status).toBe('revoked');

    await expect(activateAutonomousDeliveryPolicy({
      workspaceId,
      policyId: created.policy.id,
      expectedPolicyDigest: created.policy.policyDigest,
      confirmation: 'ENABLE_AUTONOMOUS_PR_DELIVERY',
      principal,
      sourceRequestId: 'policy-reactivate-db-001',
      now: new Date(now.getTime() + 3_000),
    })).rejects.toThrow('cannot be activated');
  });

  test('enforces exact evidence identity and blocks evidence update/delete', async () => {
    const workspaceId = `ws-delivery-evidence-${crypto.randomUUID()}`;
    await workspaceFixture(workspaceId);
    const run = await queryOne<{ id: number }>(
      `INSERT INTO pipeline_runs (spec_path, workspace_id, status, branch_name)
       VALUES ('forge/specs/approved/safe-delivery.json', $1, 'done', 'run/safe-delivery')
       RETURNING id`,
      [workspaceId],
    );
    expect(run).toBeDefined();
    const evidenceId = crypto.randomUUID();
    await execute(
      `INSERT INTO github_pr_delivery_evidence
        (id, workspace_id, run_id, repo_owner, repo_name, repository_authority_source,
         pr_number, pr_url, pr_state, draft, merged, head_ref, base_ref, head_sha, base_sha, mergeable,
         mergeable_state, comparison_status, ahead_by, behind_by, branch_fresh,
         checks, reviews, check_summary, review_summary, provider_observed_at,
         observed_by_principal_id, observed_by_display_label, payload_hash)
       VALUES ($1, $2, $3, 'getrorca', 'rorca', 'pat-oauth-fallback', 42,
         'https://github.com/getrorca/rorca/pull/42', 'open', FALSE, FALSE,
         'run/safe-delivery', 'main', $4, $5, TRUE, 'clean', 'ahead', 2, 0, TRUE,
         '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, NOW(),
         'operator-1', 'operator@example.test', $6)`,
      [evidenceId, workspaceId, run!.id, 'a'.repeat(40), 'b'.repeat(40), `sha256:${'c'.repeat(64)}`],
    );

    await expect(execute(
      `UPDATE github_pr_delivery_evidence SET branch_fresh = FALSE WHERE id = $1`,
      [evidenceId],
    )).rejects.toThrow('append-only');
    await expect(execute(
      `DELETE FROM github_pr_delivery_evidence WHERE id = $1`,
      [evidenceId],
    )).rejects.toThrow('append-only');
  });
});
