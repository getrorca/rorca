/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Bounded reviewed-PR delivery state machine. It reuses pg-boss, the canonical
 * Lifecycle evaluator/ledgers, the configured execution agent, and isolated
 * worktrees. It is not a scheduler and grants no deployment authority.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import simpleGit from 'simple-git';
import type PgBoss from 'pg-boss';
import { queryOne, execute, transaction } from '../db/index';
import { getBoss } from './pg-boss';
import { getActiveAutonomousDeliveryPolicy, type AutonomousDeliveryPolicyRecord } from './autonomous-delivery-policy';
import {
  getGithubPrDeliveryEvidenceById,
  observeGithubPrDeliveryEvidence,
  type GithubPrDeliveryEvidence,
} from './github-pr-delivery-evidence';
import {
  bridgeGithubEvidenceToLifecycle,
  type DeliveryLifecycleBridgeResult,
} from './autonomous-delivery-lifecycle';
import { resolveWorkspaceGitHubToken } from './github-token-resolver';
import { loadRunReleaseIdentity } from './release-authority';
import { revalidateRunReleaseIdentity, withGithubReleaseActuation } from './release-identity';
import { fetchGithubWithTimeout } from './github-app-credential-provider';
import { isFullGitObjectId } from './github-repository-authority';
import { githubRateLimiter } from './github-rate-limiter';
import {
  extractGithubProviderError,
  formatGithubProviderError,
  sanitizeGithubProviderException,
} from './github-provider-error';
import { ConflictError, NotFoundError, UnprocessableError } from './errors';
import { validateReusableWorktree } from './worktree-freshness';
import {
  AutonomousPrDeliveryJobPayload,
} from './pg-boss-schemas';
import { logger } from './logger';
import { paginateQuery, type PaginationParams } from './paginate';
import { compileSpecPlan } from './ssdlc-plan-service';
import { SSDLC_PLAN_COMPILER_VERSION } from './ssdlc-plan-compiler';

export const AUTONOMOUS_PR_DELIVERY_QUEUE = 'pipeline:pr-delivery' as const;
export const AUTONOMOUS_PR_DELIVERY_POLL_SECONDS = 60;

export type AutonomousPrDeliveryStatus =
  | 'queued' | 'observing' | 'awaiting_checks' | 'awaiting_review'
  | 'awaiting_human_approval' | 'recovering_ci' | 'recovering_conflict'
  | 'authorized' | 'merging' | 'merged' | 'blocked' | 'budget_exhausted';

interface DeliveryRow {
  id: string;
  workspace_id: string;
  run_id: number | string;
  spec_slug: string;
  policy_id: string;
  policy_digest: string;
  risk_level: 'low' | 'medium' | 'high' | 'critical';
  repo_owner: string;
  repo_name: string;
  pr_number: number | string;
  base_branch: string;
  branch_name: string;
  initial_head_sha: string;
  current_head_sha: string;
  merge_method: 'merge' | 'squash' | 'rebase';
  retry_budget: { maxAttempts: number; maxElapsedMinutes: number } | string;
  status: AutonomousPrDeliveryStatus;
  recovery_attempts: number | string;
  last_evidence_id: string | null;
  merge_decision_id: number | string | null;
  authorization_snapshot_id: string | null;
  authorization_evidence_hwm: string | null;
  authorization_decision_hwm: string | null;
  authorized_at: Date | string | null;
  merged_sha: string | null;
  terminal_reason: string | null;
  source_request_id: string;
  deadline_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
}

interface RunDeliveryBinding {
  id: number | string;
  workspace_id: string;
  spec_path: string;
  branch_name: string | null;
  worktree_path: string | null;
  pr_number: number | string | null;
  merge_strategy: string | null;
  status: string;
  agent_type: 'claude' | 'opencode' | 'codex' | 'pi' | null;
  agent_model: string | null;
  terminal_mode: 'ansi-html' | 'pty' | null;
  thinking_enabled: boolean | null;
  thinking_budget: number | null;
  effort_level: 'low' | 'medium' | 'high' | 'max' | 'xhigh' | null;
  workspace_path: string;
  repo_owner: string;
  repo_name: string;
  release_provider_ref: string | null;
  release_authorized_sha: string | null;
  release_base_branch: string | null;
  release_base_sha: string | null;
  compiler_version: string | null;
  risk_level: string | null;
  risk_assignment_count: number | string | null;
  profiles: unknown;
}

export interface QueueAutonomousPrDeliveryResult {
  queued: boolean;
  deliveryId: string | null;
  reason: string | null;
  replayed: boolean;
}

export interface DeliveryObservationClassification {
  action: 'merge' | 'wait_checks' | 'wait_review' | 'wait_human' | 'recover_ci' | 'recover_conflict' | 'block';
  reason: string;
}

export interface AutonomousDeliveryJobDependencies {
  observe: typeof observeGithubPrDeliveryEvidence;
  bridge: typeof bridgeGithubEvidenceToLifecycle;
  schedule(deliveryId: string, expectedHeadSha: string, delaySeconds: number): Promise<string | null>;
  merge(delivery: DeliveryRow, evidence: GithubPrDeliveryEvidence): Promise<{ mergedSha: string; responseHash: `sha256:${string}`; mergedAt: string }>;
  startCiRecovery(delivery: DeliveryRow, evidence: GithubPrDeliveryEvidence): Promise<boolean>;
  recoverConflict(delivery: DeliveryRow): Promise<string>;
  now(): Date;
}

function sha(value: unknown): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function number(value: number | string): number {
  return Number(value);
}

function budget(row: DeliveryRow): { maxAttempts: number; maxElapsedMinutes: number } {
  return typeof row.retry_budget === 'string' ? JSON.parse(row.retry_budget) : row.retry_budget;
}

function terminal(status: AutonomousPrDeliveryStatus): boolean {
  return ['merged', 'blocked', 'budget_exhausted'].includes(status);
}

export function ciRecoveryRevisionIsAllowed(changedPaths: string[], mergeCommitCount: number): boolean {
  if (mergeCommitCount !== 0 || changedPaths.length === 0 || changedPaths.length > 200) return false;
  return changedPaths.every((candidate) => {
    const normalized = candidate.replace(/\\/g, '/').replace(/^\.\//, '');
    return normalized.length > 0
      && !normalized.startsWith('../')
      && !path.isAbsolute(normalized)
      && !normalized.startsWith('.github/workflows/')
      && normalized !== '.github/CODEOWNERS'
      && normalized !== 'CODEOWNERS';
  });
}

async function bindingForRun(workspaceId: string, runId: number): Promise<RunDeliveryBinding> {
  const row = await queryOne<RunDeliveryBinding>(`
    SELECT r.id, r.workspace_id, r.spec_path, r.branch_name, r.worktree_path,
           r.pr_number, r.merge_strategy, r.status, r.agent_type, r.agent_model,
           r.terminal_mode, r.thinking_enabled, r.thinking_budget, r.effort_level,
           w.path AS workspace_path, gh.repo_owner, gh.repo_name,
           ri.provider_release_ref AS release_provider_ref,
           ri.authorized_sha AS release_authorized_sha,
           ri.base_branch AS release_base_branch,
           ri.base_sha AS release_base_sha,
           cp.compiler_version,
           cp.provenance_json->>'riskLevel' AS risk_level,
           cp.provenance_json->>'riskAssignmentCount' AS risk_assignment_count,
           cp.provenance_json->'profiles' AS profiles
    FROM pipeline_runs r
    JOIN workspaces w ON w.id = r.workspace_id
    JOIN github_workspace_repository_authority gh
      ON gh.workspace_id = r.workspace_id AND gh.authority_status = 'active'
    JOIN pipeline_run_release_intents ri
      ON ri.run_id = r.id AND ri.workspace_id = r.workspace_id
    LEFT JOIN LATERAL (
      SELECT compiler_version, provenance_json
      FROM ssdlc_compiled_plans
      WHERE workspace_id = r.workspace_id
        AND spec_slug = regexp_replace(r.spec_path, '^.*/|\\.json$', '', 'g')
        AND is_current = TRUE
      ORDER BY created_at DESC LIMIT 1
    ) cp ON TRUE
    WHERE r.id = $1 AND r.workspace_id = $2
  `, [runId, workspaceId]);
  if (!row) throw new NotFoundError('Pipeline run', String(runId));
  return row;
}

async function event(input: {
  delivery: DeliveryRow;
  eventType: string;
  evidenceId?: string | null;
  lifecycleEvidenceIds?: string[];
  decisionId?: string | number | null;
  detail?: Record<string, unknown>;
}): Promise<void> {
  await transaction(async (client) => {
    await client.query(`
      INSERT INTO autonomous_pr_delivery_events (
        delivery_id, workspace_id, event_type, head_sha, evidence_id,
        lifecycle_evidence_ids, decision_id, detail
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb)
    `, [
      input.delivery.id,
      input.delivery.workspace_id,
      input.eventType,
      input.delivery.current_head_sha,
      input.evidenceId ?? null,
      JSON.stringify(input.lifecycleEvidenceIds ?? []),
      input.decisionId ?? null,
      JSON.stringify(input.detail ?? {}),
    ]);
    await client.query(`
      INSERT INTO wal_events (event_type, workspace_id, spec_id, actor, payload)
      VALUES ($1, $2, $3, 'autonomous-delivery-steward', $4::jsonb)
    `, [`autonomous_pr_delivery_${input.eventType}`, input.delivery.workspace_id, input.delivery.spec_slug, JSON.stringify({
      deliveryId: input.delivery.id,
      runId: number(input.delivery.run_id),
      prNumber: number(input.delivery.pr_number),
      headSha: input.delivery.current_head_sha,
      evidenceId: input.evidenceId ?? null,
      decisionId: input.decisionId ? String(input.decisionId) : null,
      ...input.detail,
    })]);
  });
}

async function updateStatus(
  deliveryId: string,
  status: AutonomousPrDeliveryStatus,
  patch: {
    evidenceId?: string;
    decisionId?: string | null;
    headSha?: string;
    snapshot?: DeliveryLifecycleBridgeResult;
  } = {},
): Promise<void> {
  await execute(`
    UPDATE autonomous_pr_deliveries
    SET status = $2,
        last_evidence_id = COALESCE($3, last_evidence_id),
        merge_decision_id = COALESCE($4::bigint, merge_decision_id),
        current_head_sha = COALESCE($5, current_head_sha),
        authorization_snapshot_id = COALESCE($6, authorization_snapshot_id),
        authorization_evidence_hwm = COALESCE($7, authorization_evidence_hwm),
        authorization_decision_hwm = COALESCE($8, authorization_decision_hwm),
        authorized_at = CASE WHEN $2 = 'authorized' THEN NOW() ELSE authorized_at END,
        updated_at = NOW()
    WHERE id = $1 AND status NOT IN ('merged', 'blocked', 'budget_exhausted')
  `, [
    deliveryId,
    status,
    patch.evidenceId ?? null,
    patch.decisionId ?? null,
    patch.headSha ?? null,
    patch.snapshot?.snapshotId ?? null,
    patch.snapshot?.evidenceHighWaterMark ?? null,
    patch.snapshot?.decisionHighWaterMark ?? null,
  ]);
}

async function terminateDelivery(delivery: DeliveryRow, status: 'blocked' | 'budget_exhausted', reason: string): Promise<void> {
  const result = await execute(`
    UPDATE autonomous_pr_deliveries
    SET status = $2, terminal_reason = $3, completed_at = NOW(), updated_at = NOW()
    WHERE id = $1 AND status NOT IN ('merged', 'blocked', 'budget_exhausted')
  `, [delivery.id, status, reason.slice(0, 1_024)]);
  if (result.rowCount > 0) await event({ delivery, eventType: status, detail: { reason: reason.slice(0, 512) } });
}

async function defaultSchedule(deliveryId: string, expectedHeadSha: string, delaySeconds: number): Promise<string | null> {
  return await getBoss().send(AUTONOMOUS_PR_DELIVERY_QUEUE, { deliveryId, expectedHeadSha }, {
    retryLimit: 0,
    expireInSeconds: 300,
    startAfter: Math.max(0, delaySeconds),
  });
}

export async function queueAutonomousPrDeliveryForRun(input: {
  workspaceId: string;
  runId: number;
  sourceRequestId?: string;
}, enqueue: AutonomousDeliveryJobDependencies['schedule'] = defaultSchedule): Promise<QueueAutonomousPrDeliveryResult> {
  let binding = await bindingForRun(input.workspaceId, input.runId);
  if (binding.compiler_version !== SSDLC_PLAN_COMPILER_VERSION) {
    try {
      await compileSpecPlan({
        workspaceId: input.workspaceId,
        workspacePath: binding.workspace_path,
        specSlug: binding.spec_path.split('/').pop()?.replace(/\.json$/i, '') ?? binding.spec_path,
        source: 'lazy-compile',
      });
      binding = await bindingForRun(input.workspaceId, input.runId);
    } catch {
      return { queued: false, deliveryId: null, reason: 'current_lifecycle_plan_recompile_required', replayed: false };
    }
  }
  if (binding.merge_strategy !== 'pr') return { queued: false, deliveryId: null, reason: 'merge_strategy_not_pr', replayed: false };
  if (binding.status !== 'done') return { queued: false, deliveryId: null, reason: 'run_not_complete', replayed: false };
  if (!binding.branch_name || !binding.worktree_path || !binding.pr_number
    || !binding.release_provider_ref || !binding.release_authorized_sha
    || !binding.release_base_branch || !binding.release_base_sha) {
    return { queued: false, deliveryId: null, reason: 'canonical_pr_binding_incomplete', replayed: false };
  }
  if (!['low', 'medium', 'high', 'critical'].includes(binding.risk_level ?? '')
    || Number(binding.risk_assignment_count ?? 0) < 1) {
    return { queued: false, deliveryId: null, reason: 'explicit_risk_classification_unavailable', replayed: false };
  }
  const riskLevel = binding.risk_level as DeliveryRow['risk_level'];
  const profiles = Array.isArray(binding.profiles) ? binding.profiles.map(String) : [];
  const policy = await getActiveAutonomousDeliveryPolicy(input.workspaceId);
  if (!policy) return { queued: false, deliveryId: null, reason: 'no_active_delivery_policy', replayed: false };
  if (policy.repository.owner !== binding.repo_owner || policy.repository.name !== binding.repo_name) {
    return { queued: false, deliveryId: null, reason: 'policy_repository_mismatch', replayed: false };
  }
  const requiresHumanApproval = !policy.allowedRiskLevels.includes(riskLevel as 'low' | 'medium')
    || ['high', 'critical'].includes(riskLevel)
    || profiles.some((profile) => ['security-sensitive', 'release-operations'].includes(profile));
  if (requiresHumanApproval) {
    // The active policy remains the immutable checks/review/retry/merge-method
    // envelope, but it grants no approval authority for this risk/profile.
    // Keep the reviewed-delivery worker alive so a separately authenticated
    // human Merge decision can authorize this exact SHA.
    await execute(`
      INSERT INTO wal_events (event_type, workspace_id, spec_id, actor, payload)
      VALUES ('autonomous_pr_delivery_human_approval_required', $1,
              regexp_replace($2, '^.*/|\\.json$', '', 'g'), 'autonomous-delivery-steward', $3::jsonb)
    `, [input.workspaceId, binding.spec_path, JSON.stringify({
      runId: input.runId,
      prNumber: number(binding.pr_number),
      riskLevel,
      profiles,
      reason: 'risk_or_profile_requires_explicit_human_approval',
    })]);
  }

  const worktree = validateReusableWorktree({
    workspacePath: binding.workspace_path,
    worktreePath: binding.worktree_path,
    expectedBranchName: binding.branch_name,
  });
  if (!worktree.ok) return { queued: false, deliveryId: null, reason: `worktree_guard:${worktree.reason}`, replayed: false };
  const headSha = (await simpleGit(binding.worktree_path).revparse(['HEAD'])).trim().toLowerCase();
  if (!isFullGitObjectId(headSha)) throw new UnprocessableError('Run branch HEAD is not a full Git SHA', 'REVISION_UNAVAILABLE');
  if (headSha !== binding.release_authorized_sha.toLowerCase()) {
    return { queued: false, deliveryId: null, reason: 'release_authorized_sha_mismatch', replayed: false };
  }
  if (policy.baseBranch !== binding.release_base_branch) {
    return { queued: false, deliveryId: null, reason: 'policy_release_base_mismatch', replayed: false };
  }
  const id = crypto.randomUUID();
  const sourceRequestId = input.sourceRequestId ?? `autonomous-pr-delivery:${input.runId}:${headSha}`;
  const deadline = new Date(Date.now() + policy.retryBudget.maxElapsedMinutes * 60_000);
  const inserted = await queryOne<DeliveryRow>(`
    INSERT INTO autonomous_pr_deliveries (
      id, workspace_id, run_id, spec_slug, policy_id, policy_digest, risk_level,
      repo_owner, repo_name, pr_number, base_branch, branch_name,
      initial_head_sha, current_head_sha, merge_method, retry_budget, status,
      source_request_id, deadline_at
    ) VALUES (
      $1, $2, $3, regexp_replace($4, '^.*/|\\.json$', '', 'g'), $5, $6, $7,
      $8, $9, $10, $11, $12, $13, $13, $14, $15::jsonb, 'queued', $16, $17
    )
    ON CONFLICT (workspace_id, run_id) DO NOTHING
    RETURNING *
  `, [
    id, input.workspaceId, input.runId, binding.spec_path, policy.id, policy.policyDigest,
    riskLevel, binding.repo_owner, binding.repo_name, number(binding.pr_number), policy.baseBranch,
    binding.branch_name, headSha, policy.mergeMethod, JSON.stringify(policy.retryBudget), sourceRequestId, deadline,
  ]);
  const delivery = inserted ?? await queryOne<DeliveryRow>(
    'SELECT * FROM autonomous_pr_deliveries WHERE workspace_id = $1 AND run_id = $2',
    [input.workspaceId, input.runId],
  );
  if (!delivery) throw new ConflictError('Autonomous PR delivery could not be persisted');
  if (delivery.policy_id !== policy.id || delivery.policy_digest !== policy.policyDigest) {
    throw new ConflictError('An autonomous delivery already exists under a different immutable policy');
  }
  if (terminal(delivery.status)) {
    return { queued: false, deliveryId: delivery.id, reason: `delivery_${delivery.status}`, replayed: true };
  }
  if (inserted) await event({ delivery, eventType: 'queued', detail: { policyId: policy.id, riskLevel } });
  const jobId = await enqueue(delivery.id, delivery.current_head_sha, 0);
  if (!jobId) {
    await terminateDelivery(delivery, 'blocked', 'pgboss_queue_unavailable');
    return { queued: false, deliveryId: delivery.id, reason: 'pgboss_queue_unavailable', replayed: !inserted };
  }
  return { queued: true, deliveryId: delivery.id, reason: null, replayed: !inserted };
}

function requiredCheckState(evidence: GithubPrDeliveryEvidence): 'passed' | 'pending' | 'failed' {
  if (evidence.checkSummary.allRequiredPassed && !evidence.checksTruncated) return 'passed';
  if (evidence.checkSummary.failing.length > 0 || evidence.checksTruncated) return 'failed';
  return 'pending';
}

export function classifyAutonomousDeliveryObservation(
  delivery: Pick<DeliveryRow, 'policy_id' | 'policy_digest' | 'risk_level'>,
  evidence: GithubPrDeliveryEvidence,
  lifecycle: DeliveryLifecycleBridgeResult,
): DeliveryObservationClassification {
  if (evidence.policy?.id !== delivery.policy_id || evidence.policy.digest !== delivery.policy_digest) {
    return { action: 'block', reason: 'active_policy_snapshot_mismatch' };
  }
  if (evidence.pullRequest.merged) return { action: 'block', reason: 'pull_request_already_merged_outside_steward' };
  if (evidence.pullRequest.state !== 'open') return { action: 'block', reason: 'pull_request_not_open' };
  if (evidence.pullRequest.draft) return { action: 'wait_review', reason: 'pull_request_is_draft' };
  const checkState = requiredCheckState(evidence);
  if (checkState === 'failed') return { action: 'recover_ci', reason: 'required_checks_failed' };
  if (checkState === 'pending') return { action: 'wait_checks', reason: 'required_checks_pending_or_missing' };
  if (!evidence.reviewSummary.reviewSatisfied || evidence.reviewsTruncated) {
    return { action: 'wait_review', reason: evidence.reviewSummary.changesRequestedBy.length > 0
      ? 'changes_requested_on_current_sha'
      : 'review_policy_not_satisfied' };
  }
  if (!evidence.freshness.branchFresh || evidence.pullRequest.mergeable === false
    || !['clean', 'has_hooks'].includes(evidence.pullRequest.mergeableState)) {
    return { action: 'recover_conflict', reason: 'branch_stale_or_conflicted' };
  }
  if (!lifecycle.lifecycleReady || lifecycle.mergeGateStatus !== 'passed' || !lifecycle.mergeDecisionId) {
    return { action: 'wait_human', reason: lifecycle.planApprovalRequirement === 'human'
      ? 'canonical_merge_human_approval_required'
      : `lifecycle_blockers:${lifecycle.blockers.slice(0, 8).join('|')}` };
  }
  return { action: 'merge', reason: 'all_reviewed_delivery_gates_passed' };
}

async function latestDelivery(deliveryId: string): Promise<DeliveryRow> {
  const row = await queryOne<DeliveryRow>('SELECT * FROM autonomous_pr_deliveries WHERE id = $1', [deliveryId]);
  if (!row) throw new NotFoundError('Autonomous PR delivery', deliveryId);
  return row;
}

async function waitAndReschedule(
  delivery: DeliveryRow,
  status: 'awaiting_checks' | 'awaiting_review' | 'awaiting_human_approval',
  eventType: 'awaiting_checks' | 'awaiting_review' | 'awaiting_human_approval',
  reason: string,
  deps: AutonomousDeliveryJobDependencies,
): Promise<void> {
  await updateStatus(delivery.id, status);
  await event({ delivery, eventType, detail: { reason } });
  const jobId = await deps.schedule(delivery.id, delivery.current_head_sha, AUTONOMOUS_PR_DELIVERY_POLL_SECONDS);
  if (!jobId) await terminateDelivery(delivery, 'blocked', 'pgboss_queue_unavailable');
}

async function assertPolicyStillActive(delivery: DeliveryRow, now: Date): Promise<AutonomousDeliveryPolicyRecord> {
  const policy = await getActiveAutonomousDeliveryPolicy(delivery.workspace_id, now);
  if (!policy || policy.id !== delivery.policy_id || policy.policyDigest !== delivery.policy_digest) {
    throw new ConflictError('Standing delivery policy is no longer the active immutable policy');
  }
  // For high/critical/protected work the policy is only the immutable
  // checks/review/retry/merge-method envelope. Lifecycle still requires an
  // authenticated human decision; recordPolicyApproval independently checks
  // allowedRiskLevels before creating standing authority.
  return policy;
}

async function authorize(delivery: DeliveryRow, evidence: GithubPrDeliveryEvidence, lifecycle: DeliveryLifecycleBridgeResult): Promise<void> {
  await transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`autonomous-delivery-merge:${delivery.id}`]);
    const current = (await client.query<DeliveryRow>('SELECT * FROM autonomous_pr_deliveries WHERE id = $1 FOR UPDATE', [delivery.id])).rows[0];
    if (!current || current.status !== 'observing') {
      throw new ConflictError('Autonomous delivery state changed before authorization');
    }
    const policy = (await client.query<{ id: string }>(`
      SELECT id FROM autonomous_delivery_policies
      WHERE id = $1 AND workspace_id = $2 AND policy_digest = $3
        AND status = 'active' AND expires_at > NOW() FOR UPDATE
    `, [delivery.policy_id, delivery.workspace_id, delivery.policy_digest])).rows[0];
    if (!policy) throw new ConflictError('Standing delivery policy changed before authorization');
    const provider = (await client.query<{ id: string }>(`
      SELECT id FROM github_pr_delivery_evidence
      WHERE id = $1 AND workspace_id = $2 AND run_id = $3
        AND head_sha = $4 AND policy_id = $5 AND policy_digest = $6
        AND pr_state = 'open' AND draft = FALSE AND merged = FALSE
        AND mergeable = TRUE AND mergeable_state IN ('clean', 'has_hooks')
        AND branch_fresh = TRUE
        AND checks_truncated = FALSE AND reviews_truncated = FALSE
        AND check_summary->>'allRequiredPassed' = 'true'
        AND review_summary->>'reviewSatisfied' = 'true'
      FOR SHARE
    `, [evidence.id, delivery.workspace_id, delivery.run_id, delivery.current_head_sha, delivery.policy_id, delivery.policy_digest])).rows[0];
    if (!provider) throw new ConflictError('Exact provider evidence changed before authorization');
    const decision = (await client.query<{ id: string }>(`
      SELECT id::text FROM ssdlc_decisions
      WHERE id = $1 AND workspace_id = $2 AND spec_slug = $3
        AND phase_id = 'merge' AND subject_type = 'commit_sha' AND lower(subject_value) = $4
        AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())
      FOR SHARE
    `, [lifecycle.mergeDecisionId, delivery.workspace_id, delivery.spec_slug, delivery.current_head_sha])).rows[0];
    if (!decision) throw new ConflictError('Canonical Merge authorization changed before actuation');
    await client.query(`
      UPDATE autonomous_pr_deliveries
      SET status = 'authorized', last_evidence_id = $2, merge_decision_id = $3,
          authorization_snapshot_id = $4, authorization_evidence_hwm = $5,
          authorization_decision_hwm = $6, authorized_at = NOW(), updated_at = NOW()
      WHERE id = $1
    `, [delivery.id, evidence.id, lifecycle.mergeDecisionId, lifecycle.snapshotId,
      lifecycle.evidenceHighWaterMark, lifecycle.decisionHighWaterMark]);
  });
}

async function persistMerged(input: {
  delivery: DeliveryRow;
  evidence: GithubPrDeliveryEvidence;
  lifecycle: DeliveryLifecycleBridgeResult;
  mergedSha: string;
  responseHash: `sha256:${string}`;
  mergedAt: string;
}): Promise<void> {
  await transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`autonomous-delivery-merge:${input.delivery.id}`]);
    const replay = (await client.query<{ merged_sha: string }>(
      'SELECT merged_sha FROM autonomous_pr_delivery_merge_evidence WHERE delivery_id = $1',
      [input.delivery.id],
    )).rows[0];
    if (replay) {
      if (replay.merged_sha !== input.mergedSha) throw new ConflictError('Merged-SHA evidence conflict');
      return;
    }
    const current = (await client.query<DeliveryRow>(
      'SELECT * FROM autonomous_pr_deliveries WHERE id = $1 FOR UPDATE',
      [input.delivery.id],
    )).rows[0];
    if (!current || current.status !== 'merging'
      || current.current_head_sha !== input.evidence.pullRequest.headSha
      || current.last_evidence_id !== input.evidence.id
      || String(current.merge_decision_id) !== String(input.lifecycle.mergeDecisionId)) {
      throw new ConflictError('Merge authority snapshot changed before durable closeout');
    }
    const lifecycleEvidence = (await client.query<{ id: string }>(`
      SELECT id::text FROM ssdlc_lifecycle_evidence
      WHERE id = $1 AND workspace_id = $2 AND run_id = $3
        AND phase_id = 'merge' AND evidence_status = 'passed'
        AND subject_type = 'commit_sha' AND lower(subject_value) = $4
      FOR SHARE
    `, [input.lifecycle.mergeEvidenceId, input.delivery.workspace_id, input.delivery.run_id, input.delivery.current_head_sha])).rows[0];
    if (!lifecycleEvidence) throw new ConflictError('Lifecycle Merge evidence changed before closeout');
    const policy = (await client.query<{ id: string; status: string }>(`
      SELECT id, status FROM autonomous_delivery_policies
      WHERE id = $1 AND workspace_id = $2 AND policy_digest = $3
        AND (
          (status = 'active' AND expires_at > NOW())
          OR (status = 'revoked' AND revoked_at >= $4)
        )
      FOR SHARE
    `, [input.delivery.policy_id, input.delivery.workspace_id, input.delivery.policy_digest, current.authorized_at])).rows[0];
    if (!policy) throw new ConflictError('Standing delivery policy was not current at authorization');
    await client.query(`
      INSERT INTO autonomous_pr_delivery_merge_evidence (
        id, delivery_id, workspace_id, run_id, policy_id, policy_digest,
        github_evidence_id, lifecycle_merge_evidence_id, merge_decision_id,
        lifecycle_snapshot_id, evidence_high_water_mark, decision_high_water_mark,
        repo_owner, repo_name, pr_number, expected_head_sha, merged_sha,
        merge_method, provider_response_hash, merged_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                $13, $14, $15, $16, $17, $18, $19, $20)
    `, [
      crypto.randomUUID(), input.delivery.id, input.delivery.workspace_id, input.delivery.run_id,
      input.delivery.policy_id, input.delivery.policy_digest, input.evidence.id,
      input.lifecycle.mergeEvidenceId, input.lifecycle.mergeDecisionId,
      input.lifecycle.snapshotId, input.lifecycle.evidenceHighWaterMark, input.lifecycle.decisionHighWaterMark,
      input.delivery.repo_owner, input.delivery.repo_name, input.delivery.pr_number,
      input.delivery.current_head_sha, input.mergedSha, input.delivery.merge_method,
      input.responseHash, input.mergedAt,
    ]);
    await client.query(`
      UPDATE autonomous_pr_deliveries
      SET status = 'merged', merged_sha = $2, completed_at = $3, updated_at = NOW()
      WHERE id = $1
    `, [input.delivery.id, input.mergedSha, input.mergedAt]);
    await client.query(`UPDATE pipeline_runs SET merge_status = 'merged' WHERE id = $1`, [input.delivery.run_id]);
    await client.query(`
      INSERT INTO autonomous_pr_delivery_events (
        delivery_id, workspace_id, event_type, head_sha, evidence_id,
        lifecycle_evidence_ids, decision_id, detail
      ) VALUES ($1, $2, 'merged', $3, $4, $5::jsonb, $6, $7::jsonb)
    `, [input.delivery.id, input.delivery.workspace_id, input.delivery.current_head_sha,
      input.evidence.id, JSON.stringify([input.lifecycle.validationEvidenceId, input.lifecycle.mergeEvidenceId]),
      input.lifecycle.mergeDecisionId, JSON.stringify({ mergedSha: input.mergedSha, mergeMethod: input.delivery.merge_method })]);
    await client.query(`
      INSERT INTO wal_events (event_type, workspace_id, spec_id, actor, payload)
      VALUES ('autonomous_pr_merged', $1, $2, 'autonomous-delivery-steward', $3::jsonb)
    `, [input.delivery.workspace_id, input.delivery.spec_slug, JSON.stringify({
      deliveryId: input.delivery.id,
      runId: number(input.delivery.run_id),
      prNumber: number(input.delivery.pr_number),
      expectedHeadSha: input.delivery.current_head_sha,
      mergedSha: input.mergedSha,
      mergeMethod: input.delivery.merge_method,
      policyId: input.delivery.policy_id,
      policyDigest: input.delivery.policy_digest,
      githubEvidenceId: input.evidence.id,
      lifecycleMergeEvidenceId: input.lifecycle.mergeEvidenceId,
      mergeDecisionId: input.lifecycle.mergeDecisionId,
      lifecycleSnapshotId: input.lifecycle.snapshotId,
    })]);
  });
}

async function providerMerge(
  delivery: DeliveryRow,
  evidence: GithubPrDeliveryEvidence,
): Promise<{ mergedSha: string; responseHash: `sha256:${string}`; mergedAt: string }> {
  const releaseIdentity = await loadRunReleaseIdentity(Number(delivery.run_id), delivery.current_head_sha);
  return withGithubReleaseActuation(releaseIdentity, 'merge', async ({ authority, credential }) => {
  await revalidateRunReleaseIdentity(releaseIdentity);
  if (authority.owner !== delivery.repo_owner || authority.name !== delivery.repo_name) {
    throw new ConflictError('Reviewed delivery repository differs from canonical release authority');
  }
  const token = credential.token;
  const prUrl = `https://api.github.com/repos/${encodeURIComponent(delivery.repo_owner)}/${encodeURIComponent(delivery.repo_name)}/pulls/${number(delivery.pr_number)}`;
  const preflight = await githubRateLimiter.execute(() => fetchGithubWithTimeout(fetch, prUrl, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  }));
  const currentPr = await preflight.json().catch(() => ({})) as {
    number?: number; html_url?: string; state?: string; draft?: boolean; merged?: boolean; mergeable?: boolean; mergeable_state?: string;
    head?: { sha?: string; ref?: string; repo?: { full_name?: string } }; base?: { sha?: string; ref?: string; repo?: { full_name?: string } };
  };
  const expectedRepository = `${delivery.repo_owner}/${delivery.repo_name}`.toLowerCase();
  if (!preflight.ok || currentPr.number !== Number(delivery.pr_number)
    || currentPr.html_url !== evidence.pullRequest.url
    || currentPr.state !== 'open' || currentPr.draft !== false || currentPr.merged !== false
    || currentPr.head?.repo?.full_name?.toLowerCase() !== expectedRepository
    || currentPr.base?.repo?.full_name?.toLowerCase() !== expectedRepository
    || currentPr.head?.sha?.toLowerCase() !== delivery.current_head_sha
    || currentPr.head?.ref !== releaseIdentity.providerReleaseRef || currentPr.base?.ref !== releaseIdentity.baseBranch
    || currentPr.base?.sha?.toLowerCase() !== evidence.pullRequest.baseSha
    || currentPr.mergeable !== true || !['clean', 'has_hooks'].includes(String(currentPr.mergeable_state ?? ''))) {
    throw new ConflictError('GitHub PR changed after final authorization observation');
  }
  const url = `${prUrl}/merge`;
  const body = { sha: delivery.current_head_sha, merge_method: delivery.merge_method };
  await revalidateRunReleaseIdentity(releaseIdentity);
  let response: Response | null = null;
  let transportError: unknown = null;
  try {
    response = await githubRateLimiter.execute(() => fetchGithubWithTimeout(fetch, url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify(body),
    }));
  } catch (error) {
    transportError = error;
  }
  const raw = response?.ok
    ? await response.json().catch(() => ({})) as { sha?: string; merged?: boolean }
    : {};
  if (response?.ok && raw.merged === true && isFullGitObjectId(raw.sha)) {
    const stable = { sha: raw.sha, merged: true, status: response.status };
    return { mergedSha: raw.sha, responseHash: sha(stable), mergedAt: new Date().toISOString() };
  }

  // A response may be lost after GitHub committed the merge. Reconcile once;
  // never issue an unconditional second merge with a different head.
  const check = await githubRateLimiter.execute(() => fetchGithubWithTimeout(fetch,
    `https://api.github.com/repos/${encodeURIComponent(delivery.repo_owner)}/${encodeURIComponent(delivery.repo_name)}/pulls/${number(delivery.pr_number)}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } },
  ));
  const pr = await check.json().catch(() => ({})) as { merged?: boolean; merged_at?: string; merge_commit_sha?: string; head?: { sha?: string } };
  if (check.ok && pr.merged === true && pr.head?.sha?.toLowerCase() === delivery.current_head_sha
    && isFullGitObjectId(pr.merge_commit_sha)) {
    const stable = { sha: pr.merge_commit_sha, merged: true, reconciled: true, status: response?.status ?? null };
    return { mergedSha: pr.merge_commit_sha, responseHash: sha(stable), mergedAt: pr.merged_at ?? new Date().toISOString() };
  }
  const providerError = response
    ? extractGithubProviderError(response, 'GITHUB_EXACT_SHA_MERGE_FAILED')
    : sanitizeGithubProviderException(transportError, 'GITHUB_EXACT_SHA_MERGE_FAILED');
  throw new ConflictError(`GitHub exact-SHA merge could not be proven: ${formatGithubProviderError(providerError)}`);
  });
}

function dependencies(overrides: Partial<AutonomousDeliveryJobDependencies>): AutonomousDeliveryJobDependencies {
  return {
    observe: overrides.observe ?? observeGithubPrDeliveryEvidence,
    bridge: overrides.bridge ?? bridgeGithubEvidenceToLifecycle,
    schedule: overrides.schedule ?? defaultSchedule,
    merge: overrides.merge ?? providerMerge,
    startCiRecovery: overrides.startCiRecovery ?? startCiRecovery,
    recoverConflict: overrides.recoverConflict ?? recoverConflict,
    now: overrides.now ?? (() => new Date()),
  };
}

export async function processAutonomousPrDelivery(
  input: { deliveryId: string; expectedHeadSha: string },
  dependencyOverrides: Partial<AutonomousDeliveryJobDependencies> = {},
): Promise<void> {
  const deps = dependencies(dependencyOverrides);
  let delivery = await latestDelivery(input.deliveryId);
  if (terminal(delivery.status)) return;
  if (!['queued', 'awaiting_checks', 'awaiting_review', 'awaiting_human_approval'].includes(delivery.status)) return;
  if (delivery.current_head_sha !== input.expectedHeadSha) return; // stale queued observation
  if (deps.now().getTime() >= new Date(delivery.deadline_at).getTime()) {
    await terminateDelivery(delivery, 'budget_exhausted', 'maximum_elapsed_time_exceeded');
    return;
  }
  try {
    await assertPolicyStillActive(delivery, deps.now());
  } catch (error) {
    await terminateDelivery(delivery, 'blocked', error instanceof Error ? error.message : 'policy_unavailable');
    return;
  }
  await updateStatus(delivery.id, 'observing');
  const observed = await deps.observe({
    workspaceId: delivery.workspace_id,
    runId: number(delivery.run_id),
    expectedHeadSha: delivery.current_head_sha,
    principal: { principalId: 'autonomous-delivery-steward', displayLabel: 'Autonomous Delivery Steward' },
  });
  const evidence = observed.evidence;
  const lifecycle = await deps.bridge({
    authority: {
      deliveryId: delivery.id,
      workspaceId: delivery.workspace_id,
      runId: number(delivery.run_id),
      policyId: delivery.policy_id,
      policyDigest: delivery.policy_digest,
      riskLevel: delivery.risk_level,
    },
    evidence,
  });
  await updateStatus(delivery.id, 'observing', {
    evidenceId: evidence.id,
    decisionId: lifecycle.mergeDecisionId,
  });
  await event({
    delivery,
    eventType: 'observed',
    evidenceId: evidence.id,
    lifecycleEvidenceIds: [lifecycle.validationEvidenceId, lifecycle.mergeEvidenceId],
    decisionId: lifecycle.mergeDecisionId,
    detail: { checksPassed: evidence.checkSummary.allRequiredPassed, reviewsSatisfied: evidence.reviewSummary.reviewSatisfied },
  });
  const classification = classifyAutonomousDeliveryObservation(delivery, evidence, lifecycle);

  if (classification.action === 'block') {
    await terminateDelivery(delivery, 'blocked', classification.reason);
    return;
  }
  if (classification.action === 'wait_checks') {
    await waitAndReschedule(delivery, 'awaiting_checks', 'awaiting_checks', classification.reason, deps);
    return;
  }
  if (classification.action === 'wait_review') {
    await waitAndReschedule(delivery, 'awaiting_review', 'awaiting_review', classification.reason, deps);
    return;
  }
  if (classification.action === 'wait_human') {
    // Human-required state is intentionally not polled. An authenticated
    // operator may replay the idempotent start action after recording the
    // canonical approval or resolving the blocker.
    await updateStatus(delivery.id, 'awaiting_human_approval');
    await event({ delivery, eventType: 'awaiting_human_approval', detail: { reason: classification.reason } });
    return;
  }
  if (classification.action === 'recover_ci') {
    if (number(delivery.recovery_attempts) >= budget(delivery).maxAttempts) {
      await terminateDelivery(delivery, 'budget_exhausted', 'maximum_recovery_attempts_exceeded');
      return;
    }
    const started = await deps.startCiRecovery(delivery, evidence);
    if (!started) await terminateDelivery(delivery, 'blocked', 'ci_failure_not_safely_repairable');
    return;
  }
  if (classification.action === 'recover_conflict') {
    if (number(delivery.recovery_attempts) >= budget(delivery).maxAttempts) {
      await terminateDelivery(delivery, 'budget_exhausted', 'maximum_recovery_attempts_exceeded');
      return;
    }
    try {
      const nextHead = await deps.recoverConflict(delivery);
      await deps.schedule(delivery.id, nextHead, 0);
    } catch (error) {
      delivery = await latestDelivery(delivery.id);
      if (number(delivery.recovery_attempts) >= budget(delivery).maxAttempts) {
        await terminateDelivery(delivery, 'budget_exhausted', error instanceof Error ? error.message : 'conflict_recovery_failed');
      } else {
        await deps.schedule(delivery.id, delivery.current_head_sha, AUTONOMOUS_PR_DELIVERY_POLL_SECONDS);
      }
    }
    return;
  }

  // Freshness is re-observed immediately before authorization/actuation. The
  // GitHub merge request also carries the unchanged head SHA as a condition.
  const finalObserved = await deps.observe({
    workspaceId: delivery.workspace_id,
    runId: number(delivery.run_id),
    expectedHeadSha: delivery.current_head_sha,
    principal: { principalId: 'autonomous-delivery-steward', displayLabel: 'Autonomous Delivery Steward' },
  });
  const finalLifecycle = await deps.bridge({
    authority: {
      deliveryId: delivery.id,
      workspaceId: delivery.workspace_id,
      runId: number(delivery.run_id),
      policyId: delivery.policy_id,
      policyDigest: delivery.policy_digest,
      riskLevel: delivery.risk_level,
    },
    evidence: finalObserved.evidence,
  });
  const finalClassification = classifyAutonomousDeliveryObservation(delivery, finalObserved.evidence, finalLifecycle);
  if (finalClassification.action !== 'merge') {
    if (finalClassification.action === 'wait_checks') {
      await waitAndReschedule(delivery, 'awaiting_checks', 'awaiting_checks', `premerge_recheck:${finalClassification.reason}`, deps);
    } else if (finalClassification.action === 'wait_review') {
      await waitAndReschedule(delivery, 'awaiting_review', 'awaiting_review', `premerge_recheck:${finalClassification.reason}`, deps);
    } else if (finalClassification.action === 'wait_human') {
      await updateStatus(delivery.id, 'awaiting_human_approval');
      await event({ delivery, eventType: 'awaiting_human_approval', detail: { reason: `premerge_recheck:${finalClassification.reason}` } });
    } else {
      await terminateDelivery(delivery, 'blocked', `premerge_recheck:${finalClassification.reason}`);
    }
    return;
  }
  await assertPolicyStillActive(delivery, deps.now());
  await authorize(delivery, finalObserved.evidence, finalLifecycle);
  await event({
    delivery,
    eventType: 'merge_authorized',
    evidenceId: finalObserved.evidence.id,
    lifecycleEvidenceIds: [finalLifecycle.validationEvidenceId, finalLifecycle.mergeEvidenceId],
    decisionId: finalLifecycle.mergeDecisionId,
    detail: { lifecycleSnapshotId: finalLifecycle.snapshotId },
  });
  await updateStatus(delivery.id, 'merging');
  await event({ delivery, eventType: 'merge_started', evidenceId: finalObserved.evidence.id, decisionId: finalLifecycle.mergeDecisionId });
  try {
    const merged = await deps.merge(delivery, finalObserved.evidence);
    await persistMerged({ delivery, evidence: finalObserved.evidence, lifecycle: finalLifecycle, ...merged });
  } catch (error) {
    if (error instanceof ConflictError) {
      await terminateDelivery(delivery, 'blocked', `exact_sha_merge_precondition_failed:${error.message}`);
      return;
    }
    throw error;
  }
}

async function startCiRecovery(_delivery: DeliveryRow, _evidence: GithubPrDeliveryEvidence): Promise<boolean> {
  // Recovery that changes the released branch requires a new canonical run and
  // immutable release identity initiated by an operator. Reviewed delivery is
  // not a second execution/release orchestrator.
  return false;
}

async function recoverConflict(_delivery: DeliveryRow): Promise<string> {
  // A reviewed-delivery retry may observe and wait, but it may not advance the
  // immutable host release SHA or perform a second remote push orchestrator.
  throw new ConflictError('Conflict recovery requires a new explicitly authorized run/release identity');
}

export async function resumeAutonomousDeliveryAfterRecoveryRun(_childRunId: number, _childStatus: string): Promise<boolean> {
  // Legacy child recovery cannot prove the immutable release SHA without
  // ambient remote inspection. New work requires a new explicit run/release.
  return false;
}

export async function reconcileAutonomousPrDeliveryMerge(deliveryId: string): Promise<boolean> {
  const delivery = await latestDelivery(deliveryId);
  if (delivery.status !== 'merging' || !delivery.last_evidence_id || !delivery.merge_decision_id
    || !delivery.authorization_snapshot_id || !delivery.authorization_evidence_hwm
    || !delivery.authorization_decision_hwm) return false;
  const evidence = await getGithubPrDeliveryEvidenceById(delivery.workspace_id, delivery.last_evidence_id);
  if (!evidence || evidence.pullRequest.headSha !== delivery.current_head_sha) return false;
  const lifecycleRows = await queryOne<{ validation_id: string | null; merge_id: string | null }>(`
    SELECT
      MAX(id) FILTER (WHERE COALESCE(delivery_projection_kind, phase_id) = 'validation')::text AS validation_id,
      MAX(id) FILTER (WHERE COALESCE(delivery_projection_kind, phase_id) = 'merge' AND evidence_status = 'passed')::text AS merge_id
    FROM ssdlc_lifecycle_evidence
    WHERE (github_pr_delivery_evidence_id = $1
           OR metadata->'details'->>'providerEvidenceId' = $1::text)
      AND workspace_id = $2 AND run_id = $3
  `, [evidence.id, delivery.workspace_id, delivery.run_id]);
  if (!lifecycleRows?.merge_id) return false;
  const releaseIdentity = await loadRunReleaseIdentity(Number(delivery.run_id), delivery.current_head_sha);
  const observed = await withGithubReleaseActuation(releaseIdentity, 'reviewed-delivery', async ({ authority, credential }) => {
    if (authority.owner !== delivery.repo_owner || authority.name !== delivery.repo_name) return null;
    const response = await githubRateLimiter.execute(() => fetchGithubWithTimeout(fetch,
      `https://api.github.com/repos/${encodeURIComponent(delivery.repo_owner)}/${encodeURIComponent(delivery.repo_name)}/pulls/${number(delivery.pr_number)}`,
      { headers: { Authorization: `Bearer ${credential.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } },
    ));
    const pr = await response.json().catch(() => ({})) as {
      number?: number; html_url?: string; state?: string; draft?: boolean; merged?: boolean;
      merged_at?: string;
      merge_commit_sha?: string;
      head?: { sha?: string; ref?: string; repo?: { full_name?: string } };
      base?: { sha?: string; ref?: string; repo?: { full_name?: string } };
    };
    const expectedRepository = `${delivery.repo_owner}/${delivery.repo_name}`.toLowerCase();
    if (!response.ok || pr.number !== Number(delivery.pr_number) || pr.html_url !== evidence.pullRequest.url
      || pr.state !== 'closed' || pr.draft !== false || pr.merged !== true
      || pr.head?.repo?.full_name?.toLowerCase() !== expectedRepository
      || pr.base?.repo?.full_name?.toLowerCase() !== expectedRepository
      || pr.head?.sha?.toLowerCase() !== delivery.current_head_sha
      || pr.head?.ref !== releaseIdentity.providerReleaseRef
      || pr.base?.ref !== releaseIdentity.baseBranch
      || !isFullGitObjectId(pr.base?.sha)
      || !isFullGitObjectId(pr.merge_commit_sha)) return null;
    // GitHub may report the advanced current base tip after a successful merge,
    // not the immutable pre-merge base captured in provider evidence. Prove the
    // resulting merge commit descends from that authorized base instead of
    // requiring the mutable base ref to remain frozen after actuation.
    const comparisonResponse = await fetchGithubWithTimeout(fetch,
      `https://api.github.com/repos/${encodeURIComponent(delivery.repo_owner)}/${encodeURIComponent(delivery.repo_name)}/compare/${evidence.pullRequest.baseSha}...${pr.merge_commit_sha}`,
      { headers: { Authorization: `Bearer ${credential.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } },
    );
    const comparison = await comparisonResponse.json().catch(() => ({})) as {
      status?: string; ahead_by?: number; merge_base_commit?: { sha?: string };
    };
    if (!comparisonResponse.ok || comparison.status !== 'ahead'
      || !Number.isInteger(comparison.ahead_by) || Number(comparison.ahead_by) < 1
      || comparison.merge_base_commit?.sha?.toLowerCase() !== evidence.pullRequest.baseSha) return null;
    return pr;
  });
  if (!observed || !isFullGitObjectId(observed.merge_commit_sha)) return false;
  const pr = observed;
  const lifecycle: DeliveryLifecycleBridgeResult = {
    validationEvidenceId: lifecycleRows.validation_id ?? lifecycleRows.merge_id,
    mergeEvidenceId: lifecycleRows.merge_id,
    mergeDecisionId: String(delivery.merge_decision_id),
    lifecycleReady: true,
    blockers: [],
    mergeGateStatus: 'passed',
    planApprovalRequirement: 'policy',
    snapshotId: delivery.authorization_snapshot_id,
    evidenceHighWaterMark: delivery.authorization_evidence_hwm,
    decisionHighWaterMark: delivery.authorization_decision_hwm,
  };
  await persistMerged({
    delivery,
    evidence,
    lifecycle,
    mergedSha: pr.merge_commit_sha!,
    responseHash: sha({ merged: true, reconciledAfterCrash: true, sha: pr.merge_commit_sha }),
    mergedAt: pr.merged_at ?? new Date().toISOString(),
  });
  return true;
}

export async function reconcilePendingAutonomousPrDeliveryMerges(limit = 50): Promise<number> {
  const rows = await queryOne<{ ids: string[] }>(`
    SELECT COALESCE(array_agg(id ORDER BY updated_at ASC), ARRAY[]::uuid[]) AS ids
    FROM (
      SELECT id, updated_at FROM autonomous_pr_deliveries
      WHERE status = 'merging' ORDER BY updated_at ASC LIMIT $1
    ) bounded
  `, [Math.max(1, Math.min(limit, 100))]);
  let reconciled = 0;
  for (const id of rows?.ids ?? []) {
    try {
      if (await reconcileAutonomousPrDeliveryMerge(id)) reconciled += 1;
    } catch (error) {
      logger.warn({ err: error, deliveryId: id }, '[autonomous-delivery] merge reconciliation deferred');
    }
  }
  return reconciled;
}

export async function registerAutonomousPrDeliveryWorker(boss: PgBoss): Promise<void> {
  await boss.work(AUTONOMOUS_PR_DELIVERY_QUEUE, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      const parsed = AutonomousPrDeliveryJobPayload.safeParse(job.data);
      if (!parsed.success) throw new Error(`Invalid pipeline:pr-delivery payload: ${parsed.error.message}`);
      const data = parsed.data;
      try {
        await processAutonomousPrDelivery(data);
      } catch (error) {
        logger.error({ err: error, deliveryId: data.deliveryId }, '[autonomous-delivery] worker step failed');
        const delivery = await latestDelivery(data.deliveryId).catch(() => null);
        if (delivery && !terminal(delivery.status)) {
          if (delivery.status === 'merging') {
            // Never issue another merge. Reconcile provider truth now or leave
            // the durable `merging` state for startup reconciliation.
            await reconcileAutonomousPrDeliveryMerge(delivery.id).catch(() => false);
          } else if (delivery.status === 'authorized') {
            await terminateDelivery(delivery, 'blocked', 'merge_actuation_did_not_start');
          } else if (new Date(delivery.deadline_at).getTime() <= Date.now()) {
            await terminateDelivery(delivery, 'budget_exhausted', 'worker_step_failed_after_deadline');
          } else {
            await updateStatus(delivery.id, 'queued');
            await defaultSchedule(delivery.id, delivery.current_head_sha, AUTONOMOUS_PR_DELIVERY_POLL_SECONDS);
          }
        }
      }
    }
  });
}

export async function listAutonomousPrDeliveries(workspaceId: string, pagination: PaginationParams) {
  const result = await paginateQuery<DeliveryRow>({
    query: 'SELECT * FROM autonomous_pr_deliveries WHERE workspace_id = $1',
    countQuery: 'SELECT COUNT(*)::integer AS total FROM autonomous_pr_deliveries WHERE workspace_id = $1',
    params: [workspaceId],
    pagination,
    orderBy: 'created_at DESC',
    cursorColumn: 'created_at',
    cursorDirection: 'desc',
  });
  return {
    ...result,
    items: result.items.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    runId: number(row.run_id),
    specSlug: row.spec_slug,
    policy: { id: row.policy_id, digest: row.policy_digest },
    riskLevel: row.risk_level,
    repository: { owner: row.repo_owner, name: row.repo_name },
    pullRequest: { number: number(row.pr_number), baseBranch: row.base_branch, branchName: row.branch_name },
    initialHeadSha: row.initial_head_sha,
    currentHeadSha: row.current_head_sha,
    mergeMethod: row.merge_method,
    status: row.status,
    recoveryAttempts: number(row.recovery_attempts),
    deadlineAt: iso(row.deadline_at),
    lastEvidenceId: row.last_evidence_id,
    mergeDecisionId: row.merge_decision_id ? String(row.merge_decision_id) : null,
    lifecycleSnapshotId: row.authorization_snapshot_id,
    mergedSha: row.merged_sha,
    terminalReason: row.terminal_reason,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
      completedAt: row.completed_at ? iso(row.completed_at) : null,
    })),
  };
}
