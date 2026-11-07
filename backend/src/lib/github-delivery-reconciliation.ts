/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import { execute, transaction } from '../db/index';
import { GithubProviderBindingSchema, type GithubProviderBinding } from './authority-provider-adapter';
import {
  settleGithubInstallationLease,
  type GithubInstallationLeaseSettlement,
  type GithubInstallationLeaseSettlementOutcome,
} from './github-app-credential-provider';
import {
  GithubExternalSendGrantSchema,
  GithubReviewDeliveryOperations,
  GithubReviewDeliveryReceiptSchema,
  type GithubBranchPushResult,
  type GithubCheckObservation,
  type GithubExternalOperation,
  type GithubExternalSendGrant,
  type GithubPreparedRepository,
  type GithubPullRequestResult,
  type GithubReviewCommit,
  type GithubReviewDeliveryReceipt,
  type GithubReviewRequestResult,
} from './github-review-delivery';
import { ConflictError, ForbiddenError, UnprocessableError, ValidationError } from './errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ATTEMPT_UNKNOWN_CODE = 'provider_outcome_unknown';
const GITHUB_EXTERNAL_OPERATIONS: readonly GithubExternalOperation[] = Object.freeze([
  'scm.branch.write',
  'scm.pull_request.write',
  'scm.checks.read',
  'scm.review.request',
]);

export interface GithubOperationAttemptReference {
  readonly id: string;
  readonly operation: GithubExternalOperation;
}

interface GithubOperationAttemptStart extends GithubOperationAttemptReference {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly grantId: string;
  readonly leaseId: string;
  readonly repository: { id: number; owner: string; name: string };
  readonly bindingId: string;
  readonly bindingGeneration: number;
  readonly installationId: number;
  readonly branch: string;
  readonly commitSha: string;
}

interface GithubOperationAcceptedResources {
  readonly pullRequestId?: number;
  readonly checkRunIds?: readonly number[];
}
interface GithubReceiptLineage {
  workspaceId: string;
  requestId: string;
  grantId: string;
  leaseId: string;
}


export interface GithubDeliveryReconciliationStore {
  beginAttempt(input: Omit<GithubOperationAttemptStart, 'id'>): Promise<GithubOperationAttemptReference>;
  markAccepted(
    workspaceId: string,
    attempt: GithubOperationAttemptReference,
    resources?: GithubOperationAcceptedResources,
  ): Promise<void>;
  markReconciliationRequired(workspaceId: string, attemptId: string): Promise<void>;
  findReceipt(input: GithubReceiptLineage): Promise<GithubReviewDeliveryReceipt | null>;
  listReceiptAttempts(input: GithubReceiptLineage): Promise<readonly GithubOperationAttemptReference[]>;
  persistReceipt(receipt: GithubReviewDeliveryReceipt): Promise<GithubReviewDeliveryReceipt>;
}

interface AttemptRow {
  id: string;
  operation: GithubExternalOperation;
  state: 'started' | 'externally_accepted' | 'reconciliation_required' | 'settled' | 'failed';
  repository_external_id: string;
  repository_owner: string;
  repository_name: string;
  installation_external_id: string;
  branch_name: string;
  commit_sha: string;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function receiptHash(receipt: GithubReviewDeliveryReceipt): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(receipt)).digest('hex')}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

function parseReceiptJson(value: unknown): GithubReviewDeliveryReceipt {
  let candidate = value;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      throw new ConflictError('Persisted GitHub delivery receipt is invalid');
    }
  }
  return deepFreeze(GithubReviewDeliveryReceiptSchema.parse(candidate));
}

class PgGithubDeliveryReconciliationStore implements GithubDeliveryReconciliationStore {
  async beginAttempt(input: Omit<GithubOperationAttemptStart, 'id'>): Promise<GithubOperationAttemptReference> {
    return transaction(async (client) => {
      const lockKey = [input.workspaceId, input.requestId, input.grantId, input.leaseId].join(':');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey]);
      const lease = await client.query<{
        state: string;
        provider_binding_id: string;
        binding_generation: string | number;
        repository_external_id: string;
        repository_owner: string;
        repository_name: string;
      }>(`SELECT state, provider_binding_id, binding_generation, repository_external_id,
                 repository_owner, repository_name
            FROM provider_authority_leases
           WHERE id = $1
             AND workspace_id = $2
             AND authority_grant_id = $3
             AND provider_id = 'github-app'
           FOR SHARE`, [input.leaseId, input.workspaceId, input.grantId]);
      const authority = lease.rows[0];
      if (!authority || authority.state !== 'active') {
        throw new ForbiddenError('GitHub delivery authority lease is not active');
      }
      if (authority.provider_binding_id !== input.bindingId
        || Number(authority.binding_generation) !== input.bindingGeneration
        || authority.repository_external_id !== String(input.repository.id)
        || authority.repository_owner.toLowerCase() !== input.repository.owner.toLowerCase()
        || authority.repository_name.toLowerCase() !== input.repository.name.toLowerCase()) {
        throw new ConflictError('GitHub delivery attempt does not match its repository authority lease');
      }
      const settled = await client.query<{ id: string }>(`SELECT id
            FROM provider_operation_receipts
           WHERE workspace_id = $1
             AND authority_request_id = $2
             AND authority_grant_id = $3
             AND authority_lease_id = $4
           FOR SHARE`, [input.workspaceId, input.requestId, input.grantId, input.leaseId]);
      if (settled.rows[0]) throw new ConflictError('GitHub delivery is already settled');

      await client.query(`UPDATE provider_operation_attempts
            SET state = 'reconciliation_required', last_error_code = $6
          WHERE workspace_id = $1
            AND authority_request_id = $2
            AND authority_grant_id = $3
            AND authority_lease_id = $4
            AND operation = $5
            AND state = 'started'`, [
        input.workspaceId,
        input.requestId,
        input.grantId,
        input.leaseId,
        input.operation,
        ATTEMPT_UNKNOWN_CODE,
      ]);
      const sequence = await client.query<{ next_attempt: string | number }>(`SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next_attempt
            FROM provider_operation_attempts
           WHERE workspace_id = $1
             AND authority_request_id = $2
             AND authority_grant_id = $3
             AND authority_lease_id = $4
             AND operation = $5`, [input.workspaceId, input.requestId, input.grantId, input.leaseId, input.operation]);
      const id = crypto.randomUUID();
      await client.query(`INSERT INTO provider_operation_attempts
        (id, workspace_id, authority_request_id, authority_grant_id, authority_lease_id,
         provider_id, operation, attempt_number, repository_external_id, repository_owner,
         repository_name, installation_external_id, branch_name, commit_sha)
        VALUES ($1,$2,$3,$4,$5,'github-app',$6,$7,$8,$9,$10,$11,$12,$13)`, [
        id,
        input.workspaceId,
        input.requestId,
        input.grantId,
        input.leaseId,
        input.operation,
        Number(sequence.rows[0]?.next_attempt ?? 1),
        String(input.repository.id),
        input.repository.owner,
        input.repository.name,
        String(input.installationId),
        input.branch,
        input.commitSha,
      ]);
      return Object.freeze({ id, operation: input.operation });
    });
  }

  async markAccepted(
    workspaceId: string,
    attempt: GithubOperationAttemptReference,
    resources: GithubOperationAcceptedResources = {},
  ): Promise<void> {
    const result = await execute(`UPDATE provider_operation_attempts
      SET state = 'externally_accepted', externally_accepted_at = NOW(), last_error_code = NULL,
          pull_request_external_id = $4,
          check_run_external_ids = $5::jsonb
      WHERE id = $1
        AND workspace_id = $2
        AND operation = $3
        AND state IN ('started','reconciliation_required')`, [
      attempt.id,
      workspaceId,
      attempt.operation,
      resources.pullRequestId === undefined ? null : String(resources.pullRequestId),
      JSON.stringify(resources.checkRunIds ?? []),
    ]);
    if (result.rowCount !== 1) throw new ConflictError('GitHub operation attempt changed before acceptance was recorded');
  }

  async markReconciliationRequired(workspaceId: string, attemptId: string): Promise<void> {
    const result = await execute(`UPDATE provider_operation_attempts
      SET state = 'reconciliation_required', last_error_code = $3
      WHERE id = $1 AND workspace_id = $2 AND state = 'started'`, [
      attemptId,
      workspaceId,
      ATTEMPT_UNKNOWN_CODE,
    ]);
    if (result.rowCount !== 1) {
      throw new ConflictError('GitHub operation attempt changed before its unknown outcome was recorded');
    }
  }
  async findReceipt(input: GithubReceiptLineage): Promise<GithubReviewDeliveryReceipt | null> {
    const persisted = await transaction(async (client) => {
      const result = await client.query<{ receipt_json: unknown; receipt_hash: string }>(`SELECT receipt_json, receipt_hash
          FROM provider_operation_receipts
         WHERE workspace_id = $1
           AND authority_request_id = $2
           AND authority_grant_id = $3
           AND authority_lease_id = $4`, [input.workspaceId, input.requestId, input.grantId, input.leaseId]);
      return result.rows[0] ?? null;
    });
    if (!persisted) return null;
    const receipt = parseReceiptJson(persisted.receipt_json);
    if (persisted.receipt_hash !== receiptHash(receipt)) {
      throw new ConflictError('Persisted GitHub delivery receipt hash is invalid');
    }
    return receipt;
  }


  async listReceiptAttempts(input: GithubReceiptLineage): Promise<readonly GithubOperationAttemptReference[]> {
    const rows = await transaction(async (client) => {
      const result = await client.query<AttemptRow>(`SELECT id, operation, state, repository_external_id,
             repository_owner, repository_name, installation_external_id, branch_name, commit_sha
          FROM provider_operation_attempts
         WHERE workspace_id = $1
           AND authority_request_id = $2
           AND authority_grant_id = $3
           AND authority_lease_id = $4
         ORDER BY started_at, operation, attempt_number
         FOR SHARE`, [input.workspaceId, input.requestId, input.grantId, input.leaseId]);
      return result.rows;
    });
    if (rows.some(({ state }) => state === 'started' || state === 'failed' || state === 'settled')) {
      throw new ConflictError('GitHub delivery attempts are not ready for one settlement receipt');
    }
    for (const operation of GITHUB_EXTERNAL_OPERATIONS) {
      if (!rows.some((row) => row.operation === operation && row.state === 'externally_accepted')) {
        throw new ConflictError(`GitHub delivery has no accepted ${operation} attempt`);
      }
    }
    return Object.freeze(rows.map(({ id, operation }) => Object.freeze({ id, operation })));
  }

  async persistReceipt(receiptInput: GithubReviewDeliveryReceipt): Promise<GithubReviewDeliveryReceipt> {
    const receipt = GithubReviewDeliveryReceiptSchema.parse(receiptInput);
    const hash = receiptHash(receipt);
    return transaction(async (client) => {
      const lockKey = [receipt.workspaceId, receipt.authority.requestId, receipt.authority.grantId, receipt.authority.leaseId].join(':');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey]);
      const existing = await client.query<{ receipt_json: unknown; receipt_hash: string }>(`SELECT receipt_json, receipt_hash
          FROM provider_operation_receipts
         WHERE workspace_id = $1
           AND authority_request_id = $2
           AND authority_grant_id = $3
           AND authority_lease_id = $4
         FOR SHARE`, [
        receipt.workspaceId,
        receipt.authority.requestId,
        receipt.authority.grantId,
        receipt.authority.leaseId,
      ]);
      if (existing.rows[0]) {
        const persisted = parseReceiptJson(existing.rows[0].receipt_json);
        if (existing.rows[0].receipt_hash !== receiptHash(persisted) || existing.rows[0].receipt_hash !== hash) {
          throw new ConflictError('Existing GitHub delivery receipt differs from the exact settled journey');
        }
        return persisted;
      }

      const attemptIds = receipt.authority.attempts.map(({ id }) => id);
      const attempts = await client.query<AttemptRow>(`SELECT id, operation, state, repository_external_id,
             repository_owner, repository_name, installation_external_id, branch_name, commit_sha
          FROM provider_operation_attempts
         WHERE workspace_id = $1
           AND authority_request_id = $2
           AND authority_grant_id = $3
           AND authority_lease_id = $4
         ORDER BY started_at, operation, attempt_number
         FOR UPDATE`, [
        receipt.workspaceId,
        receipt.authority.requestId,
        receipt.authority.grantId,
        receipt.authority.leaseId,
      ]);
      if (attempts.rows.length !== attemptIds.length
        || attempts.rows.some((row) => row.state !== 'externally_accepted' && row.state !== 'reconciliation_required')
        || attempts.rows.some((row) => row.repository_external_id !== String(receipt.repository.id)
          || row.repository_owner.toLowerCase() !== receipt.repository.owner.toLowerCase()
          || row.repository_name.toLowerCase() !== receipt.repository.name.toLowerCase()
          || row.installation_external_id !== String(receipt.installationId)
          || row.branch_name !== receipt.branch
          || row.commit_sha !== receipt.headRevision)) {
        throw new ConflictError('GitHub delivery receipt does not match every operation attempt');
      }
      const expectedAttempts = new Map(receipt.authority.attempts.map((attempt) => [attempt.id, attempt.operation]));
      if (attempts.rows.some((row) => expectedAttempts.get(row.id) !== row.operation)) {
        throw new ConflictError('GitHub delivery receipt operation lineage is inconsistent');
      }

      const receiptId = crypto.randomUUID();
      const settledAt = new Date().toISOString();
      await client.query(`INSERT INTO provider_operation_receipts
        (id, workspace_id, authority_request_id, authority_grant_id, authority_lease_id,
         provider_id, receipt_schema_version, receipt_json, receipt_hash, settled_at)
        VALUES ($1,$2,$3,$4,$5,'github-app',$6,$7::jsonb,$8,$9)`, [
        receiptId,
        receipt.workspaceId,
        receipt.authority.requestId,
        receipt.authority.grantId,
        receipt.authority.leaseId,
        receipt.schemaVersion,
        JSON.stringify(receipt),
        hash,
        settledAt,
      ]);
      await client.query(`INSERT INTO provider_operation_receipt_attempts
        (receipt_id, attempt_id, workspace_id, authority_request_id, authority_grant_id, authority_lease_id)
        SELECT $1, attempt_id, $2, $3, $4, $5 FROM unnest($6::uuid[]) AS attempt_id`, [
        receiptId,
        receipt.workspaceId,
        receipt.authority.requestId,
        receipt.authority.grantId,
        receipt.authority.leaseId,
        attemptIds,
      ]);
      await client.query(`UPDATE provider_operation_attempts
        SET state = 'externally_accepted',
            externally_accepted_at = COALESCE(externally_accepted_at, $2),
            last_error_code = NULL,
            pull_request_external_id = CASE
              WHEN operation IN ('scm.pull_request.write','scm.review.request') THEN $3
              ELSE pull_request_external_id
            END,
            check_run_external_ids = CASE
              WHEN operation = 'scm.checks.read' THEN $4::jsonb
              ELSE check_run_external_ids
            END
        WHERE id = ANY($1::uuid[]) AND state = 'reconciliation_required'`, [
        attemptIds,
        settledAt,
        String(receipt.pullRequest.id),
        JSON.stringify(receipt.checks.map(({ id }) => id)),
      ]);
      await client.query(`UPDATE provider_operation_attempts
        SET state = 'settled', settled_at = $2
        WHERE id = ANY($1::uuid[]) AND state = 'externally_accepted'`, [attemptIds, settledAt]);
      return deepFreeze(receipt);
    });
  }
}

const DEFAULT_STORE: GithubDeliveryReconciliationStore = new PgGithubDeliveryReconciliationStore();

interface GithubReconciliationBaseInput {
  authorityRequestId: string;
  leaseId: string;
  grant: GithubExternalSendGrant;
  binding: GithubProviderBinding;
  commit: GithubReviewCommit;
}

export interface GithubReconciledOperation<T> {
  readonly attempt: GithubOperationAttemptReference;
  readonly result: T;
}

export interface GithubDeliveryTerminalSettlement {
  readonly cleanup: { replayed: boolean };
  readonly lease: GithubInstallationLeaseSettlement;
}

type LeaseSettler = (
  leaseId: string,
  outcome: GithubInstallationLeaseSettlementOutcome,
) => Promise<GithubInstallationLeaseSettlement>;

export class GithubDeliveryReconciler {
  constructor(
    private readonly delivery = new GithubReviewDeliveryOperations(),
    private readonly store: GithubDeliveryReconciliationStore = DEFAULT_STORE,
    private readonly settleLease: LeaseSettler = settleGithubInstallationLease,
  ) {}

  private validated(input: GithubReconciliationBaseInput, operation: GithubExternalOperation): {
    grant: GithubExternalSendGrant;
    binding: GithubProviderBinding;
  } {
    if (!UUID.test(input.authorityRequestId)) throw new ValidationError('authorityRequestId must be a UUID');
    if (!UUID.test(input.leaseId)) throw new ValidationError('leaseId must be a UUID');
    const grant = GithubExternalSendGrantSchema.parse(input.grant);
    const binding = GithubProviderBindingSchema.parse(input.binding);
    if (!grant.operations.includes(operation)) throw new ForbiddenError('External-send grant does not authorize this operation');
    if (grant.workspaceId !== binding.workspaceId || grant.grantId.trim() === ''
      || grant.repository.id !== binding.repositoryId || grant.branch !== input.commit.branch
      || grant.headRevision !== input.commit.headRevision || input.commit.workspaceId !== grant.workspaceId) {
      throw new ConflictError('GitHub reconciliation context does not describe one authority journey');
    }
    return { grant, binding };
  }

  private async begin(
    input: GithubReconciliationBaseInput,
    operation: GithubExternalOperation,
  ): Promise<GithubOperationAttemptReference> {
    const { grant, binding } = this.validated(input, operation);
    return this.store.beginAttempt({
      workspaceId: grant.workspaceId,
      requestId: input.authorityRequestId,
      grantId: grant.grantId,
      leaseId: input.leaseId,
      operation,
      repository: grant.repository,
      bindingId: binding.bindingId,
      bindingGeneration: binding.bindingGeneration,
      installationId: binding.installationId,
      branch: grant.branch,
      commitSha: grant.headRevision,
    });
  }

  private async reconcile<T>(
    input: GithubReconciliationBaseInput,
    operation: GithubExternalOperation,
    act: () => Promise<T>,
    resources: (result: T) => GithubOperationAcceptedResources = () => ({}),
  ): Promise<GithubReconciledOperation<T>> {
    const attempt = await this.begin(input, operation);
    try {
      const result = await act();
      await this.store.markAccepted(input.grant.workspaceId, attempt, resources(result));
      return Object.freeze({ attempt, result });
    } catch (error) {
      await this.store.markReconciliationRequired(input.grant.workspaceId, attempt.id);
      throw error;
    }
  }

  reconcileBranchPush(input: GithubReconciliationBaseInput): Promise<GithubReconciledOperation<GithubBranchPushResult>> {
    return this.reconcile(input, 'scm.branch.write', () => this.delivery.pushBranch(input));
  }

  reconcilePullRequest(input: GithubReconciliationBaseInput & {
    title: string;
    body: string;
  }): Promise<GithubReconciledOperation<GithubPullRequestResult>> {
    return this.reconcile(
      input,
      'scm.pull_request.write',
      () => this.delivery.createOrUpdatePullRequest(input),
      (pullRequest) => ({ pullRequestId: pullRequest.id }),
    );
  }

  reconcileChecks(input: GithubReconciliationBaseInput): Promise<GithubReconciledOperation<readonly GithubCheckObservation[]>> {
    return this.reconcile(
      input,
      'scm.checks.read',
      () => this.delivery.observeChecks(input),
      (checks) => ({ checkRunIds: checks.map(({ id }) => id) }),
    );
  }

  reconcileReviewRequest(input: GithubReconciliationBaseInput & {
    pullRequest: GithubPullRequestResult;
    users?: readonly string[];
    teams?: readonly string[];
  }): Promise<GithubReconciledOperation<GithubReviewRequestResult>> {
    return this.reconcile(
      input,
      'scm.review.request',
      () => this.delivery.requestReview(input),
      () => ({ pullRequestId: input.pullRequest.id }),
    );
  }

  async recordReceipt(input: GithubReconciliationBaseInput & {
    push: GithubBranchPushResult;
    pullRequest: GithubPullRequestResult;
    checks: readonly GithubCheckObservation[];
    reviewRequest: GithubReviewRequestResult;
  }): Promise<GithubReviewDeliveryReceipt> {
    const { grant, binding } = this.validated(input, 'scm.branch.write');
    const lineage = {
      workspaceId: grant.workspaceId,
      requestId: input.authorityRequestId,
      grantId: grant.grantId,
      leaseId: input.leaseId,
    };
    const existing = await this.store.findReceipt(lineage);
    if (existing) return existing;
    const attempts = await this.store.listReceiptAttempts(lineage);
    const receipt = this.delivery.createReceipt({
      lineage: {
        workspaceId: grant.workspaceId,
        requestId: input.authorityRequestId,
        grantId: grant.grantId,
        leaseId: input.leaseId,
        attempts,
      },
      binding,
      commit: input.commit,
      push: input.push,
      pullRequest: input.pullRequest,
      checks: input.checks,
      reviewRequest: input.reviewRequest,
    });
    return this.store.persistReceipt(receipt);
  }

  async settleTerminal(input: {
    leaseId: string;
    outcome: GithubInstallationLeaseSettlementOutcome;
    prepared: GithubPreparedRepository;
  }): Promise<GithubDeliveryTerminalSettlement> {
    let cleanup: { replayed: boolean } | undefined;
    let cleanupError: unknown;
    try {
      cleanup = await this.delivery.cleanupRepository(input.prepared);
    } catch (error) {
      cleanupError = error;
    }

    let lease: GithubInstallationLeaseSettlement;
    try {
      lease = await this.settleLease(input.leaseId, input.outcome);
    } catch (error) {
      if (cleanupError) {
        throw new UnprocessableError(
          'GitHub delivery worktree cleanup and lease settlement both require reconciliation',
          'GITHUB_DELIVERY_TERMINAL_RECONCILIATION_REQUIRED',
        );
      }
      throw error;
    }
    if (cleanupError || !cleanup) throw cleanupError;
    return Object.freeze({ cleanup, lease });
  }
}
