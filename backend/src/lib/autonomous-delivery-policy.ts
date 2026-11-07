/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Standing autonomous PR-delivery policy.
 *
 * Policies are operator-owned, repository-scoped, disabled on creation, and
 * immutable except for one-way activation/revocation. They never grant deploy
 * authority. High/critical risk is deliberately outside standing automation.
 */

import crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { queryOne, transaction } from '../db/index';
import { paginateQuery, type PaginationParams } from './paginate';
import { ConflictError, NotFoundError, UnprocessableError, ValidationError } from './errors';
import { getGithubRepositoryAuthority } from './github-repository-authority';

export const AUTONOMOUS_DELIVERY_POLICY_SCHEMA_VERSION = 'rorca.autonomous-delivery-policy.v1' as const;
export const AUTONOMOUS_DELIVERY_ACTIVATION_CONFIRMATION = 'ENABLE_AUTONOMOUS_PR_DELIVERY' as const;
export const MAX_AUTONOMOUS_POLICY_LIFETIME_DAYS = 90;

const GitHubLoginSchema = z.string().trim().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/);
const CheckNameSchema = z.string().trim().min(1).max(200);
const BaseBranchSchema = z.string().trim().min(1).max(255)
  .regex(/^[A-Za-z0-9._/-]+$/)
  .refine((value) => !value.startsWith('/') && !value.endsWith('/') && !value.includes('..') && !value.includes('//'), {
    message: 'baseBranch is not a safe Git ref',
  });

export const AutonomousDeliveryPolicyDraftSchema = z.object({
  baseBranch: BaseBranchSchema,
  allowedRiskLevels: z.array(z.enum(['low', 'medium'])).min(1).max(2),
  requiredChecks: z.array(CheckNameSchema).min(1).max(50),
  reviewRules: z.object({
    minimumApprovals: z.number().int().min(1).max(10),
    requireCodeOwnerReview: z.boolean().default(false),
    dismissStaleApprovals: z.literal(true).default(true),
    requiredReviewers: z.array(GitHubLoginSchema).max(25).default([]),
  }).strict(),
  mergeMethod: z.enum(['merge', 'squash', 'rebase']),
  retryBudget: z.object({
    maxAttempts: z.number().int().min(0).max(5),
    maxElapsedMinutes: z.number().int().min(1).max(1_440),
  }).strict(),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();

export type AutonomousDeliveryPolicyDraft = z.input<typeof AutonomousDeliveryPolicyDraftSchema>;
export type AutonomousRiskLevel = 'low' | 'medium';
export type AutonomousMergeMethod = 'merge' | 'squash' | 'rebase';
export type AutonomousDeliveryPolicyStatus = 'disabled' | 'active' | 'revoked';

export interface DeliveryPolicyPrincipal {
  principalId: string;
  displayLabel: string;
}

export interface DeliveryPolicyRepository {
  owner: string;
  name: string;
}

export interface NormalizedAutonomousDeliveryPolicy {
  schemaVersion: typeof AUTONOMOUS_DELIVERY_POLICY_SCHEMA_VERSION;
  repository: DeliveryPolicyRepository;
  baseBranch: string;
  allowedRiskLevels: AutonomousRiskLevel[];
  requiredChecks: string[];
  reviewRules: {
    minimumApprovals: number;
    requireCodeOwnerReview: boolean;
    dismissStaleApprovals: true;
    requiredReviewers: string[];
  };
  mergeMethod: AutonomousMergeMethod;
  retryBudget: { maxAttempts: number; maxElapsedMinutes: number };
  deploymentAllowed: false;
  expiresAt: string;
  policyDigest: `sha256:${string}`;
}

export interface AutonomousDeliveryPolicyRecord extends NormalizedAutonomousDeliveryPolicy {
  id: string;
  workspaceId: string;
  revision: number;
  status: AutonomousDeliveryPolicyStatus;
  effectiveStatus: AutonomousDeliveryPolicyStatus | 'expired';
  createdBy: DeliveryPolicyPrincipal;
  createdAt: string;
  activatedAt: string | null;
  activatedBy: DeliveryPolicyPrincipal | null;
  revokedAt: string | null;
  revokedBy: DeliveryPolicyPrincipal | null;
  revocationReason: string | null;
}

interface PolicyRow {
  id: string;
  workspace_id: string;
  revision: number | string;
  repo_owner: string;
  repo_name: string;
  base_branch: string;
  allowed_risk_levels: unknown;
  required_checks: unknown;
  review_rules: unknown;
  merge_method: AutonomousMergeMethod;
  retry_budget: unknown;
  deployment_allowed: boolean;
  policy_digest: `sha256:${string}`;
  status: AutonomousDeliveryPolicyStatus;
  created_by_principal_id: string;
  created_by_display_label: string;
  created_at: string | Date;
  expires_at: string | Date;
  activated_at: string | Date | null;
  activated_by_principal_id: string | null;
  activated_by_display_label: string | null;
  activation_source_request_id: string | null;
  revoked_at: string | Date | null;
  revoked_by_principal_id: string | null;
  revoked_by_display_label: string | null;
  revocation_reason: string | null;
  revocation_source_request_id: string | null;
  source_request_id: string;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]));
  }
  return value;
}

export function stablePolicyJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function digestPolicy(value: Omit<NormalizedAutonomousDeliveryPolicy, 'policyDigest'>): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(stablePolicyJson(value), 'utf8').digest('hex')}`;
}

function uniqueSorted(values: string[], field: string, caseInsensitive = false): string[] {
  const normalized = values.map((value) => value.trim());
  const keys = normalized.map((value) => caseInsensitive ? value.toLowerCase() : value);
  if (new Set(keys).size !== values.length) {
    throw new ValidationError(`${field} must not contain duplicates`, { field });
  }
  return normalized.sort((left, right) => left.localeCompare(right));
}

function assertPolicyLifetime(expiresAt: string, now: Date): string {
  const expires = new Date(expiresAt);
  const max = now.getTime() + MAX_AUTONOMOUS_POLICY_LIFETIME_DAYS * 24 * 60 * 60 * 1_000;
  if (expires.getTime() <= now.getTime()) {
    throw new ValidationError('expiresAt must be in the future', { field: 'expiresAt' });
  }
  if (expires.getTime() > max) {
    throw new ValidationError(`expiresAt cannot exceed ${MAX_AUTONOMOUS_POLICY_LIFETIME_DAYS} days`, { field: 'expiresAt' });
  }
  return expires.toISOString();
}

export function normalizeAutonomousDeliveryPolicy(
  repository: DeliveryPolicyRepository,
  input: AutonomousDeliveryPolicyDraft,
  now = new Date(),
): NormalizedAutonomousDeliveryPolicy {
  const parsed = AutonomousDeliveryPolicyDraftSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError('Autonomous delivery policy is invalid', {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  const owner = repository.owner.trim();
  const name = repository.name.trim();
  if (!owner || !name) throw new ValidationError('A connected GitHub repository is required');

  const withoutDigest: Omit<NormalizedAutonomousDeliveryPolicy, 'policyDigest'> = {
    schemaVersion: AUTONOMOUS_DELIVERY_POLICY_SCHEMA_VERSION,
    repository: { owner, name },
    baseBranch: parsed.data.baseBranch,
    allowedRiskLevels: uniqueSorted(parsed.data.allowedRiskLevels, 'allowedRiskLevels') as AutonomousRiskLevel[],
    requiredChecks: uniqueSorted(parsed.data.requiredChecks, 'requiredChecks'),
    reviewRules: {
      minimumApprovals: parsed.data.reviewRules.minimumApprovals,
      requireCodeOwnerReview: parsed.data.reviewRules.requireCodeOwnerReview,
      dismissStaleApprovals: true,
      requiredReviewers: uniqueSorted(parsed.data.reviewRules.requiredReviewers, 'reviewRules.requiredReviewers', true),
    },
    mergeMethod: parsed.data.mergeMethod,
    retryBudget: parsed.data.retryBudget,
    deploymentAllowed: false,
    expiresAt: assertPolicyLifetime(parsed.data.expiresAt, now),
  };
  return { ...withoutDigest, policyDigest: digestPolicy(withoutDigest) };
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value === 'string') {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return (value ?? fallback) as T;
}

function iso(value: string | Date | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function mapPolicy(row: PolicyRow, now = new Date()): AutonomousDeliveryPolicyRecord {
  const allowedRiskLevels = parseJson<AutonomousRiskLevel[]>(row.allowed_risk_levels, []);
  const requiredChecks = parseJson<string[]>(row.required_checks, []);
  const reviewRules = parseJson<NormalizedAutonomousDeliveryPolicy['reviewRules']>(row.review_rules, {
    minimumApprovals: 1, requireCodeOwnerReview: false, dismissStaleApprovals: true, requiredReviewers: [],
  });
  const retryBudget = parseJson<NormalizedAutonomousDeliveryPolicy['retryBudget']>(row.retry_budget, {
    maxAttempts: 0, maxElapsedMinutes: 1,
  });
  const expiresAt = iso(row.expires_at)!;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    revision: Number(row.revision),
    schemaVersion: AUTONOMOUS_DELIVERY_POLICY_SCHEMA_VERSION,
    repository: { owner: row.repo_owner, name: row.repo_name },
    baseBranch: row.base_branch,
    allowedRiskLevels,
    requiredChecks,
    reviewRules,
    mergeMethod: row.merge_method,
    retryBudget,
    deploymentAllowed: false,
    expiresAt,
    policyDigest: row.policy_digest,
    status: row.status,
    effectiveStatus: row.status === 'active' && new Date(expiresAt).getTime() <= now.getTime() ? 'expired' : row.status,
    createdBy: { principalId: row.created_by_principal_id, displayLabel: row.created_by_display_label },
    createdAt: iso(row.created_at)!,
    activatedAt: iso(row.activated_at),
    activatedBy: row.activated_by_principal_id && row.activated_by_display_label
      ? { principalId: row.activated_by_principal_id, displayLabel: row.activated_by_display_label }
      : null,
    revokedAt: iso(row.revoked_at),
    revokedBy: row.revoked_by_principal_id && row.revoked_by_display_label
      ? { principalId: row.revoked_by_principal_id, displayLabel: row.revoked_by_display_label }
      : null,
    revocationReason: row.revocation_reason,
  };
}

function assertRequestId(value: string): string {
  const requestId = value.trim();
  if (requestId.length < 8 || requestId.length > 200) {
    throw new ValidationError('Idempotency-Key must be between 8 and 200 characters');
  }
  return requestId;
}

async function repositoryForWorkspace(workspaceId: string): Promise<DeliveryPolicyRepository> {
  const authority = await getGithubRepositoryAuthority(workspaceId, { requireActive: true });
  if (!authority) throw new NotFoundError('Connected GitHub repository', workspaceId);
  return { owner: authority.owner, name: authority.name };
}

async function insertEvent(
  client: PoolClient,
  input: {
    policyId: string;
    workspaceId: string;
    eventType: 'created' | 'activated' | 'revoked';
    principal: DeliveryPolicyPrincipal;
    sourceRequestId: string;
    policyDigest: string;
    reason?: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO autonomous_delivery_policy_events
      (policy_id, workspace_id, event_type, principal_id, principal_display_label,
       source_request_id, policy_digest, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [input.policyId, input.workspaceId, input.eventType, input.principal.principalId,
      input.principal.displayLabel, input.sourceRequestId, input.policyDigest, input.reason ?? null],
  );
}

async function insertWal(
  client: PoolClient,
  eventType: string,
  workspaceId: string,
  principal: DeliveryPolicyPrincipal,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO wal_events (event_type, workspace_id, actor, payload)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [eventType, workspaceId, principal.displayLabel, JSON.stringify(payload)],
  );
}

async function revokeDerivedPolicyAuthority(
  client: PoolClient,
  input: {
    workspaceId: string;
    policyId: string;
    policyDigest: string;
    principal: DeliveryPolicyPrincipal;
    sourceRequestId: string;
    reason: string;
    now: Date;
  },
): Promise<void> {
  await client.query(`
    UPDATE ssdlc_decisions
    SET revoked_at = $1, revoked_by_principal_type = 'internal_service',
        revoked_by_principal_id = 'autonomous-delivery-steward',
        revoked_by_display_label = 'Autonomous Delivery Steward',
        revocation_rationale = $2, revocation_source_request_id = $3
    WHERE workspace_id = $4 AND decision_type = 'policy_approval'
      AND policy_reference = $5 AND revoked_at IS NULL
  `, [
    input.now.toISOString(),
    `Standing policy authority revoked: ${input.reason}`.slice(0, 2_000),
    `policy-revoked:${input.sourceRequestId}`,
    input.workspaceId,
    `autonomous-delivery:${input.policyId}:${input.policyDigest}`,
  ]);

  const blocked = await client.query<{ id: string; run_id: string; current_head_sha: string }>(`
    UPDATE autonomous_pr_deliveries
    SET status = 'blocked', terminal_reason = 'standing_policy_revoked',
        completed_at = $1, updated_at = $1
    WHERE workspace_id = $2 AND policy_id = $3 AND policy_digest = $4
      AND status NOT IN ('merged', 'blocked', 'budget_exhausted', 'authorized', 'merging')
    RETURNING id, run_id::text, current_head_sha
  `, [input.now.toISOString(), input.workspaceId, input.policyId, input.policyDigest]);
  for (const delivery of blocked.rows) {
    await client.query(`
      INSERT INTO autonomous_pr_delivery_events (
        delivery_id, workspace_id, event_type, head_sha, detail
      ) VALUES ($1, $2, 'blocked', $3, $4::jsonb)
    `, [delivery.id, input.workspaceId, delivery.current_head_sha, JSON.stringify({
      reason: 'standing_policy_revoked',
      policyId: input.policyId,
    })]);
  }
}

export async function createAutonomousDeliveryPolicy(input: {
  workspaceId: string;
  draft: AutonomousDeliveryPolicyDraft;
  principal: DeliveryPolicyPrincipal;
  sourceRequestId: string;
  now?: Date;
}): Promise<{ policy: AutonomousDeliveryPolicyRecord; replayed: boolean }> {
  const requestId = assertRequestId(input.sourceRequestId);
  const repository = await repositoryForWorkspace(input.workspaceId);
  // Persist the same trusted instant used to validate policy lifetime. Letting
  // PostgreSQL choose a later created_at leaves a race where an expiry can pass
  // validation and then violate expires_at > created_at at INSERT time.
  const policyNow = input.now ?? new Date();
  const normalized = normalizeAutonomousDeliveryPolicy(repository, input.draft, policyNow);

  return transaction(async (client) => {
    const replay = await client.query<PolicyRow>(
      'SELECT * FROM autonomous_delivery_policies WHERE workspace_id = $1 AND source_request_id = $2 FOR UPDATE',
      [input.workspaceId, requestId],
    );
    if (replay.rows[0]) {
      if (replay.rows[0].policy_digest !== normalized.policyDigest) {
        throw new ConflictError('Idempotency-Key was already used for a different autonomous delivery policy');
      }
      return { policy: mapPolicy(replay.rows[0], policyNow), replayed: true };
    }

    const revisionResult = await client.query<{ revision: number }>(
      `SELECT COALESCE(MAX(revision), 0)::integer + 1 AS revision
         FROM autonomous_delivery_policies
        WHERE workspace_id = $1 AND repo_owner = $2 AND repo_name = $3 AND base_branch = $4`,
      [input.workspaceId, repository.owner, repository.name, normalized.baseBranch],
    );
    const revision = Number(revisionResult.rows[0]?.revision ?? 1);
    const id = randomUUID();
    const inserted = await client.query<PolicyRow>(
      `INSERT INTO autonomous_delivery_policies
        (id, workspace_id, revision, repo_owner, repo_name, base_branch,
         allowed_risk_levels, required_checks, review_rules, merge_method, retry_budget,
         deployment_allowed, policy_digest, status, source_request_id,
         created_by_principal_id, created_by_display_label, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11::jsonb,
               FALSE, $12, 'disabled', $13, $14, $15, $16, $17)
       RETURNING *`,
      [id, input.workspaceId, revision, repository.owner, repository.name, normalized.baseBranch,
        JSON.stringify(normalized.allowedRiskLevels), JSON.stringify(normalized.requiredChecks),
        JSON.stringify(normalized.reviewRules), normalized.mergeMethod, JSON.stringify(normalized.retryBudget),
        normalized.policyDigest, requestId, input.principal.principalId, input.principal.displayLabel,
        normalized.expiresAt, policyNow.toISOString()],
    );
    await insertEvent(client, {
      policyId: id, workspaceId: input.workspaceId, eventType: 'created', principal: input.principal,
      sourceRequestId: requestId, policyDigest: normalized.policyDigest,
    });
    await insertWal(client, 'autonomous_delivery_policy_created', input.workspaceId, input.principal, {
      policyId: id, policyDigest: normalized.policyDigest, revision, repository: normalized.repository,
      baseBranch: normalized.baseBranch, status: 'disabled', deploymentAllowed: false,
    });
    return { policy: mapPolicy(inserted.rows[0], policyNow), replayed: false };
  });
}

export async function activateAutonomousDeliveryPolicy(input: {
  workspaceId: string;
  policyId: string;
  expectedPolicyDigest: string;
  confirmation: string;
  principal: DeliveryPolicyPrincipal;
  sourceRequestId: string;
  now?: Date;
}): Promise<{ policy: AutonomousDeliveryPolicyRecord; replayed: boolean }> {
  const requestId = assertRequestId(input.sourceRequestId);
  if (input.confirmation !== AUTONOMOUS_DELIVERY_ACTIVATION_CONFIRMATION) {
    throw new ValidationError(`confirmation must equal ${AUTONOMOUS_DELIVERY_ACTIVATION_CONFIRMATION}`);
  }
  const now = input.now ?? new Date();

  return transaction(async (client) => {
    const result = await client.query<PolicyRow>(
      'SELECT * FROM autonomous_delivery_policies WHERE id = $1 AND workspace_id = $2 FOR UPDATE',
      [input.policyId, input.workspaceId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundError('Autonomous delivery policy', input.policyId);
    if (row.policy_digest !== input.expectedPolicyDigest) {
      throw new ConflictError('Policy digest changed; review the current immutable policy before activation');
    }
    if (row.status === 'active' && row.activation_source_request_id === requestId) {
      return { policy: mapPolicy(row, now), replayed: true };
    }
    if (row.status !== 'disabled') throw new ConflictError(`Policy is ${row.status} and cannot be activated`);
    if (new Date(row.expires_at).getTime() <= now.getTime()) {
      throw new UnprocessableError('Expired policy cannot be activated', 'AUTONOMOUS_DELIVERY_POLICY_EXPIRED');
    }

    const current = await client.query<PolicyRow>(
      `SELECT * FROM autonomous_delivery_policies
        WHERE workspace_id = $1 AND status = 'active' AND id <> $2
        FOR UPDATE`,
      [input.workspaceId, input.policyId],
    );
    for (const active of current.rows) {
      const supersedeRequestId = `superseded:${input.policyId}`;
      await client.query(
        `UPDATE autonomous_delivery_policies
            SET status = 'revoked', revoked_at = $1, revoked_by_principal_id = $2,
                revoked_by_display_label = $3, revocation_reason = $4,
                revocation_source_request_id = $5
          WHERE id = $6`,
        [now.toISOString(), input.principal.principalId, input.principal.displayLabel,
          `Superseded by reviewed policy ${input.policyId}`, supersedeRequestId, active.id],
      );
      await insertEvent(client, {
        policyId: active.id, workspaceId: input.workspaceId, eventType: 'revoked', principal: input.principal,
        sourceRequestId: supersedeRequestId, policyDigest: active.policy_digest,
        reason: `Superseded by reviewed policy ${input.policyId}`,
      });
      await revokeDerivedPolicyAuthority(client, {
        workspaceId: input.workspaceId,
        policyId: active.id,
        policyDigest: active.policy_digest,
        principal: input.principal,
        sourceRequestId: supersedeRequestId,
        reason: `Superseded by reviewed policy ${input.policyId}`,
        now,
      });
    }

    const activated = await client.query<PolicyRow>(
      `UPDATE autonomous_delivery_policies
          SET status = 'active', activated_at = $1, activated_by_principal_id = $2,
              activated_by_display_label = $3, activation_source_request_id = $4
        WHERE id = $5
        RETURNING *`,
      [now.toISOString(), input.principal.principalId, input.principal.displayLabel, requestId, input.policyId],
    );
    await insertEvent(client, {
      policyId: input.policyId, workspaceId: input.workspaceId, eventType: 'activated', principal: input.principal,
      sourceRequestId: requestId, policyDigest: row.policy_digest,
    });
    await insertWal(client, 'autonomous_delivery_policy_activated', input.workspaceId, input.principal, {
      policyId: input.policyId, policyDigest: row.policy_digest, revision: row.revision,
      repository: { owner: row.repo_owner, name: row.repo_name }, baseBranch: row.base_branch,
      expiresAt: new Date(row.expires_at).toISOString(), deploymentAllowed: false,
    });
    return { policy: mapPolicy(activated.rows[0], now), replayed: false };
  });
}

export async function revokeAutonomousDeliveryPolicy(input: {
  workspaceId: string;
  policyId: string;
  reason: string;
  principal: DeliveryPolicyPrincipal;
  sourceRequestId: string;
  now?: Date;
}): Promise<{ policy: AutonomousDeliveryPolicyRecord; replayed: boolean }> {
  const requestId = assertRequestId(input.sourceRequestId);
  const reason = input.reason.trim();
  if (reason.length < 10 || reason.length > 2_000) {
    throw new ValidationError('Revocation reason must be between 10 and 2000 characters');
  }
  const now = input.now ?? new Date();

  return transaction(async (client) => {
    const result = await client.query<PolicyRow>(
      'SELECT * FROM autonomous_delivery_policies WHERE id = $1 AND workspace_id = $2 FOR UPDATE',
      [input.policyId, input.workspaceId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundError('Autonomous delivery policy', input.policyId);
    if (row.status === 'revoked' && row.revocation_source_request_id === requestId) {
      return { policy: mapPolicy(row, now), replayed: true };
    }
    if (row.status === 'revoked') throw new ConflictError('Policy was already revoked by another request');

    const revoked = await client.query<PolicyRow>(
      `UPDATE autonomous_delivery_policies
          SET status = 'revoked', revoked_at = $1, revoked_by_principal_id = $2,
              revoked_by_display_label = $3, revocation_reason = $4,
              revocation_source_request_id = $5
        WHERE id = $6
        RETURNING *`,
      [now.toISOString(), input.principal.principalId, input.principal.displayLabel, reason, requestId, input.policyId],
    );
    await insertEvent(client, {
      policyId: input.policyId, workspaceId: input.workspaceId, eventType: 'revoked', principal: input.principal,
      sourceRequestId: requestId, policyDigest: row.policy_digest, reason,
    });
    await revokeDerivedPolicyAuthority(client, {
      workspaceId: input.workspaceId,
      policyId: input.policyId,
      policyDigest: row.policy_digest,
      principal: input.principal,
      sourceRequestId: requestId,
      reason,
      now,
    });
    await insertWal(client, 'autonomous_delivery_policy_revoked', input.workspaceId, input.principal, {
      policyId: input.policyId,
      policyDigest: row.policy_digest,
      reasonDigest: `sha256:${crypto.createHash('sha256').update(reason, 'utf8').digest('hex')}`,
    });
    return { policy: mapPolicy(revoked.rows[0], now), replayed: false };
  });
}

export async function listAutonomousDeliveryPolicies(
  workspaceId: string,
  pagination: PaginationParams,
  now = new Date(),
): Promise<{
  active: AutonomousDeliveryPolicyRecord | null;
  policies: AutonomousDeliveryPolicyRecord[];
  total: number;
  hasMore: boolean;
  cursor?: string;
}> {
  const [active, result] = await Promise.all([
    getActiveAutonomousDeliveryPolicy(workspaceId, now),
    paginateQuery<PolicyRow>({
      query: 'SELECT * FROM autonomous_delivery_policies WHERE workspace_id = $1',
      countQuery: 'SELECT COUNT(*)::integer AS total FROM autonomous_delivery_policies WHERE workspace_id = $1',
      params: [workspaceId],
      pagination,
      orderBy: 'created_at DESC',
      cursorColumn: 'created_at',
      cursorDirection: 'desc',
    }),
  ]);
  return {
    active,
    policies: result.items.map((row) => mapPolicy(row, now)),
    total: result.total,
    hasMore: result.hasMore,
    ...(result.cursor ? { cursor: result.cursor } : {}),
  };
}

export async function getActiveAutonomousDeliveryPolicy(
  workspaceId: string,
  now = new Date(),
): Promise<AutonomousDeliveryPolicyRecord | null> {
  const row = await queryOne<PolicyRow>(
    `SELECT * FROM autonomous_delivery_policies
      WHERE workspace_id = $1 AND status = 'active' AND expires_at > $2
      ORDER BY activated_at DESC LIMIT 1`,
    [workspaceId, now.toISOString()],
  );
  return row ? mapPolicy(row, now) : null;
}
