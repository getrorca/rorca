/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import { z } from 'zod';
import { canonicalTransaction, queryOne } from '../db/index';
import {
  CoolifyProviderBindingSchema,
  ProviderDeploymentObservationSchema,
  StagingDeploymentRequestSchema,
  StagingDeploymentResultSchema,
  StagingExecutionReceiptSchema,
  type CoolifyProviderBinding,
  type DeclaredDeploymentHealthSignal,
  type ProviderBinding,
  type ProviderDeploymentAcceptance,
  type ProviderDeploymentObservation,
  type StagingDeploymentRequest,
  type StagingDeploymentResult,
  type StagingExecutionReceipt,
} from './authority-provider-adapter';
import { CoolifyAuthorityProviderAdapter } from './coolify-authority-provider-adapter';
import { ConflictError, NotFoundError } from './errors';

const OperationStatusSchema = z.enum([
  'requested',
  'waiting_for_authorization',
  'leased',
  'dispatched',
  'outcome_unknown',
  'settled',
]);
type OperationStatus = z.infer<typeof OperationStatusSchema>;

const StagingLeaseSchema = z.object({
  leaseId: z.string().uuid(),
  bindingId: z.string().uuid(),
  bindingGeneration: z.number().int().positive(),
  capability: z.literal('deploy.staging'),
  operationId: z.string().uuid(),
  status: z.literal('leased'),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict().refine(
  (lease) => Date.parse(lease.expiresAt) > Date.parse(lease.issuedAt),
  { message: 'Staging lease expiry must follow issuance' },
);

export interface StagingDeploymentAdapter {
  getProviderBinding(
    workspaceId: string,
    selector: { bindingId: string },
  ): Promise<ProviderBinding | null>;
  preflight(input: {
    workspaceId: string;
    bindingId: string;
    action: 'deploy.staging';
    bindingGeneration: number;
  }): Promise<ProviderBinding>;
  acquireLease(input: {
    workspaceId: string;
    bindingId: string;
    bindingGeneration: number;
    action: 'deploy.staging';
    operationId: string;
    requestedSeconds?: number;
  }): Promise<unknown>;
  dispatchDeployment(input: {
    binding: ProviderBinding;
    leaseId: string;
    operationId: string;
    revision: StagingDeploymentRequest['revision'];
    configurationBindingGeneration: number;
  }): Promise<ProviderDeploymentAcceptance>;
  observeDeployment(input: {
    binding: ProviderBinding;
    providerDeploymentId: string;
    revision: StagingDeploymentRequest['revision'];
    configurationBindingGeneration: number;
    healthSignals: readonly DeclaredDeploymentHealthSignal[];
  }): Promise<ProviderDeploymentObservation>;
  revokeLease(input: {
    workspaceId: string;
    leaseId: string;
    providerDeploymentId: string;
  }): Promise<{ revokedAt: string }>;
}

export interface StoredStagingOperation {
  request: StagingDeploymentRequest;
  requestDigest: string;
  status: OperationStatus;
  leaseId: string | null;
  providerDeploymentId: string | null;
  providerAcceptedAt: string | null;
  receipt: StagingExecutionReceipt | null;
}

export interface StagingDeploymentStore {
  reserve(request: StagingDeploymentRequest, requestDigest: string): Promise<StoredStagingOperation>;
  read(workspaceId: string, operationId: string): Promise<StoredStagingOperation | null>;
  markWaiting(workspaceId: string, operationId: string): Promise<StoredStagingOperation>;
  bindLease(workspaceId: string, operationId: string, leaseId: string): Promise<StoredStagingOperation>;
  markAccepted(
    workspaceId: string,
    operationId: string,
    acceptance: ProviderDeploymentAcceptance,
  ): Promise<StoredStagingOperation>;
  markOutcomeUnknown(workspaceId: string, operationId: string): Promise<void>;
  settle(receipt: StagingExecutionReceipt): Promise<StagingExecutionReceipt>;
}

interface OperationRow {
  id: string;
  workspace_id: string;
  binding_id: string;
  binding_generation: number | string;
  source_revision: string | null;
  image_digest: string | null;
  configuration_binding_generation: number | string;
  health_signals: unknown;
  requested_lease_seconds: number | string | null;
  request_digest: string;
  status: OperationStatus;
  lease_id: string | null;
  provider_deployment_id: string | null;
  provider_accepted_at: Date | string | null;
  receipt_payload: unknown | null;
}

const OPERATION_SELECT = `SELECT o.id, o.workspace_id, o.binding_id, o.binding_generation,
  o.source_revision, o.image_digest, o.configuration_binding_generation,
  o.health_signals, o.requested_lease_seconds, o.request_digest, o.status,
  COALESCE(o.lease_id, l.id) AS lease_id,
  COALESCE(o.provider_deployment_id, l.provider_deployment_id) AS provider_deployment_id,
  COALESCE(o.provider_accepted_at, CASE WHEN l.provider_deployment_id IS NOT NULL THEN l.updated_at END) AS provider_accepted_at,
  r.receipt_payload
FROM rorca.authority_deployment_operations o
LEFT JOIN rorca.authority_capability_leases l
  ON l.binding_id = o.binding_id AND l.operation_id = o.id
LEFT JOIN rorca.authority_execution_receipts r ON r.operation_id = o.id`;

function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function mapOperation(row: OperationRow): StoredStagingOperation {
  const request = StagingDeploymentRequestSchema.parse({
    workspaceId: row.workspace_id,
    bindingId: row.binding_id,
    bindingGeneration: Number(row.binding_generation),
    operationId: row.id,
    revision: {
      sourceRevision: row.source_revision,
      imageDigest: row.image_digest,
    },
    configurationBindingGeneration: Number(row.configuration_binding_generation),
    healthSignals: typeof row.health_signals === 'string'
      ? JSON.parse(row.health_signals) as unknown
      : row.health_signals,
    ...(row.requested_lease_seconds === null
      ? {}
      : { requestedLeaseSeconds: Number(row.requested_lease_seconds) }),
  });
  return {
    request,
    requestDigest: row.request_digest,
    status: OperationStatusSchema.parse(row.status),
    leaseId: row.lease_id,
    providerDeploymentId: row.provider_deployment_id,
    providerAcceptedAt: iso(row.provider_accepted_at),
    receipt: row.receipt_payload === null
      ? null
      : StagingExecutionReceiptSchema.parse(
        typeof row.receipt_payload === 'string'
          ? JSON.parse(row.receipt_payload) as unknown
          : row.receipt_payload,
      ),
  };
}

export function stagingDeploymentRequestDigest(request: StagingDeploymentRequest): string {
  const canonicalRequest = StagingDeploymentRequestSchema.parse(request);
  return crypto.createHash('sha256').update(JSON.stringify(canonicalRequest)).digest('hex');
}

export class PostgresStagingDeploymentStore implements StagingDeploymentStore {
  async reserve(request: StagingDeploymentRequest, requestDigest: string): Promise<StoredStagingOperation> {
    return canonicalTransaction(async (client) => {
      const existing = await client.query<OperationRow>(
        `${OPERATION_SELECT} WHERE o.id = $1 AND o.workspace_id = $2 FOR UPDATE OF o`,
        [request.operationId, request.workspaceId],
      );
      if (existing.rows[0]) {
        const operation = mapOperation(existing.rows[0]);
        if (operation.requestDigest !== requestDigest) {
          throw new ConflictError('Staging operation id is already bound to a different immutable request');
        }
        return operation;
      }
      await client.query(
        `INSERT INTO rorca.authority_deployment_operations
          (id, workspace_id, binding_id, binding_generation, capability,
           source_revision, image_digest, configuration_binding_generation,
           health_signals, requested_lease_seconds, request_digest, status)
         VALUES ($1, $2, $3, $4, 'deploy.staging', $5, $6, $7, $8::jsonb, $9, $10, 'requested')
         ON CONFLICT (id) DO NOTHING`,
        [
          request.operationId,
          request.workspaceId,
          request.bindingId,
          request.bindingGeneration,
          request.revision.sourceRevision,
          request.revision.imageDigest,
          request.configurationBindingGeneration,
          JSON.stringify(request.healthSignals),
          request.requestedLeaseSeconds ?? null,
          requestDigest,
        ],
      );
      const result = await client.query<OperationRow>(
        `${OPERATION_SELECT} WHERE o.id = $1 AND o.workspace_id = $2 FOR UPDATE OF o`,
        [request.operationId, request.workspaceId],
      );
      const row = result.rows[0];
      if (!row) throw new NotFoundError('Staging deployment operation not found');
      const operation = mapOperation(row);
      if (operation.requestDigest !== requestDigest) {
        throw new ConflictError('Staging operation id is already bound to a different immutable request');
      }
      return operation;
    });
  }

  async read(workspaceId: string, operationId: string): Promise<StoredStagingOperation | null> {
    const row = await queryOne<OperationRow>(
      `${OPERATION_SELECT} WHERE o.id = $1 AND o.workspace_id = $2`,
      [operationId, workspaceId],
    );
    return row ? mapOperation(row) : null;
  }

  async markWaiting(workspaceId: string, operationId: string): Promise<StoredStagingOperation> {
    await canonicalTransaction(async (client) => {
      const result = await client.query(
        `UPDATE rorca.authority_deployment_operations
            SET status = 'waiting_for_authorization'
          WHERE id = $1 AND workspace_id = $2
            AND status IN ('requested', 'waiting_for_authorization')
         RETURNING id`,
        [operationId, workspaceId],
      );
      if (result.rowCount === 0) throw new ConflictError('Staging operation cannot enter authorization wait');
    });
    const operation = await this.read(workspaceId, operationId);
    if (!operation) throw new NotFoundError('Staging deployment operation not found');
    return operation;
  }

  async bindLease(workspaceId: string, operationId: string, leaseId: string): Promise<StoredStagingOperation> {
    await canonicalTransaction(async (client) => {
      const result = await client.query(
        `UPDATE rorca.authority_deployment_operations
            SET lease_id = $3, status = 'leased'
          WHERE id = $1 AND workspace_id = $2
            AND (lease_id IS NULL OR lease_id = $3)
            AND status IN ('requested', 'waiting_for_authorization', 'leased')
         RETURNING id`,
        [operationId, workspaceId, leaseId],
      );
      if (result.rowCount === 0) throw new ConflictError('Staging operation has a conflicting capability lease');
    });
    const operation = await this.read(workspaceId, operationId);
    if (!operation) throw new NotFoundError('Staging deployment operation not found');
    return operation;
  }

  async markAccepted(
    workspaceId: string,
    operationId: string,
    acceptance: ProviderDeploymentAcceptance,
  ): Promise<StoredStagingOperation> {
    await canonicalTransaction(async (client) => {
      const result = await client.query(
        `UPDATE rorca.authority_deployment_operations
            SET provider_deployment_id = $3, provider_accepted_at = $4, status = 'dispatched'
          WHERE id = $1 AND workspace_id = $2
            AND status IN ('leased', 'dispatched', 'outcome_unknown')
            AND (provider_deployment_id IS NULL OR provider_deployment_id = $3)
         RETURNING id`,
        [operationId, workspaceId, acceptance.providerDeploymentId, acceptance.acceptedAt],
      );
      if (result.rowCount === 0) throw new ConflictError('Staging operation has a conflicting provider deployment');
    });
    const operation = await this.read(workspaceId, operationId);
    if (!operation) throw new NotFoundError('Staging deployment operation not found');
    return operation;
  }

  async markOutcomeUnknown(workspaceId: string, operationId: string): Promise<void> {
    await canonicalTransaction(async (client) => {
      const result = await client.query(
        `UPDATE rorca.authority_deployment_operations
            SET status = 'outcome_unknown'
          WHERE id = $1 AND workspace_id = $2
            AND status IN ('leased', 'dispatched', 'outcome_unknown')
         RETURNING id`,
        [operationId, workspaceId],
      );
      if (result.rowCount === 0) throw new ConflictError('Staging operation cannot enter reconciliation');
    });
  }

  async settle(receipt: StagingExecutionReceipt): Promise<StagingExecutionReceipt> {
    return canonicalTransaction(async (client) => {
      const parsed = StagingExecutionReceiptSchema.parse(receipt);
      await client.query(
        `INSERT INTO rorca.authority_execution_receipts
          (id, operation_id, workspace_id, receipt_payload, settled_at)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         ON CONFLICT (operation_id) DO NOTHING`,
        [parsed.receiptId, parsed.operationId, parsed.workspaceId, JSON.stringify(parsed), parsed.settledAt],
      );
      const result = await client.query<{ receipt_payload: unknown }>(
        `SELECT receipt_payload FROM rorca.authority_execution_receipts
          WHERE operation_id = $1 AND workspace_id = $2`,
        [parsed.operationId, parsed.workspaceId],
      );
      const stored = result.rows[0];
      if (!stored) throw new ConflictError('Staging execution receipt could not be settled');
      await client.query(
        `UPDATE rorca.authority_deployment_operations
            SET status = 'settled'
          WHERE id = $1 AND workspace_id = $2
            AND status IN ('dispatched', 'outcome_unknown', 'settled')`,
        [parsed.operationId, parsed.workspaceId],
      );
      return StagingExecutionReceiptSchema.parse(
        typeof stored.receipt_payload === 'string'
          ? JSON.parse(stored.receipt_payload) as unknown
          : stored.receipt_payload,
      );
    });
  }
}

interface ServiceDependencies {
  now(): Date;
  randomUUID(): string;
}

const DEFAULT_SERVICE_DEPENDENCIES: ServiceDependencies = {
  now: () => new Date(),
  randomUUID: () => crypto.randomUUID(),
};

function requireOperationBinding(
  value: ProviderBinding,
  request: StagingDeploymentRequest,
): CoolifyProviderBinding {
  const parsed = CoolifyProviderBindingSchema.safeParse(value);
  if (!parsed.success
    || parsed.data.workspaceId !== request.workspaceId
    || parsed.data.bindingId !== request.bindingId
    || parsed.data.bindingGeneration !== request.bindingGeneration
    || parsed.data.environmentKind !== 'staging'
    || parsed.data.capabilityPolicy.allowedActions.length !== 1
    || parsed.data.capabilityPolicy.allowedActions[0] !== 'deploy.staging') {
    throw new ConflictError('Staging authority returned a different provider target');
  }
  return parsed.data;
}

export class CoolifyStagingDeploymentService {
  constructor(
    private readonly adapter: StagingDeploymentAdapter = new CoolifyAuthorityProviderAdapter(),
    private readonly store: StagingDeploymentStore = new PostgresStagingDeploymentStore(),
    private readonly dependencies: ServiceDependencies = DEFAULT_SERVICE_DEPENDENCIES,
  ) {}

  async deploy(rawRequest: unknown): Promise<StagingDeploymentResult> {
    const request = StagingDeploymentRequestSchema.parse(rawRequest);
    const operation = await this.store.reserve(request, stagingDeploymentRequestDigest(request));
    if (operation.receipt) {
      return StagingDeploymentResultSchema.parse({ status: 'settled', receipt: operation.receipt });
    }
    return this.advance(operation, true);
  }

  async reconcile(workspaceId: string, operationId: string): Promise<StagingDeploymentResult> {
    const operation = await this.store.read(workspaceId, operationId);
    if (!operation) throw new NotFoundError('Staging deployment operation not found');
    if (operation.receipt) {
      return StagingDeploymentResultSchema.parse({ status: 'settled', receipt: operation.receipt });
    }
    if (!operation.providerDeploymentId) {
      throw new ConflictError('Staging deployment has no accepted provider deployment to reconcile');
    }
    return this.advance(operation, false);
  }

  private async advance(
    initialOperation: StoredStagingOperation,
    allowDispatch: boolean,
  ): Promise<StagingDeploymentResult> {
    let operation = initialOperation;
    let binding: CoolifyProviderBinding;
    if (!operation.providerDeploymentId) {
      if (!allowDispatch) {
        throw new ConflictError('Staging deployment dispatch is not authorized during reconciliation');
      }
      binding = requireOperationBinding(await this.adapter.preflight({
        workspaceId: operation.request.workspaceId,
        bindingId: operation.request.bindingId,
        bindingGeneration: operation.request.bindingGeneration,
        action: 'deploy.staging',
      }), operation.request);
      if (!binding.capabilityPolicy.preauthorizedStaging) {
        await this.store.markWaiting(operation.request.workspaceId, operation.request.operationId);
        return StagingDeploymentResultSchema.parse({
          status: 'waiting_for_authorization',
          operationId: operation.request.operationId,
        });
      }
      if (!operation.leaseId) {
        const rawLease = await this.adapter.acquireLease({
          workspaceId: operation.request.workspaceId,
          bindingId: operation.request.bindingId,
          bindingGeneration: operation.request.bindingGeneration,
          action: 'deploy.staging',
          operationId: operation.request.operationId,
          ...(operation.request.requestedLeaseSeconds === undefined
            ? {}
            : { requestedSeconds: operation.request.requestedLeaseSeconds }),
        });
        const parsedLease = StagingLeaseSchema.safeParse(rawLease);
        const lease = parsedLease.success ? parsedLease.data : null;
        if (lease === null
          || lease.bindingId !== binding.bindingId
          || lease.bindingGeneration !== binding.bindingGeneration
          || lease.operationId !== operation.request.operationId
          || Date.parse(lease.expiresAt) <= this.dependencies.now().getTime()
          || Date.parse(lease.expiresAt) - Date.parse(lease.issuedAt)
            > binding.capabilityPolicy.maxLeaseSeconds * 1000) {
          throw new ConflictError('Staging authority returned a mismatched or unbounded capability lease');
        }
        operation = await this.store.bindLease(
          operation.request.workspaceId,
          operation.request.operationId,
          lease.leaseId,
        );
      } else if (operation.status === 'requested' || operation.status === 'waiting_for_authorization') {
        operation = await this.store.bindLease(
          operation.request.workspaceId,
          operation.request.operationId,
          operation.leaseId,
        );
      }
      try {
        const acceptance = await this.adapter.dispatchDeployment({
          binding,
          leaseId: operation.leaseId!,
          operationId: operation.request.operationId,
          revision: operation.request.revision,
          configurationBindingGeneration: operation.request.configurationBindingGeneration,
        });
        operation = await this.store.markAccepted(
          operation.request.workspaceId,
          operation.request.operationId,
          acceptance,
        );
      } catch (error) {
        await this.store.markOutcomeUnknown(operation.request.workspaceId, operation.request.operationId);
        throw error;
      }
    } else {
      operation = await this.store.markAccepted(
        operation.request.workspaceId,
        operation.request.operationId,
        {
          providerDeploymentId: operation.providerDeploymentId,
          acceptedAt: operation.providerAcceptedAt ?? this.dependencies.now().toISOString(),
        },
      );
      const storedBinding = await this.adapter.getProviderBinding(operation.request.workspaceId, {
        bindingId: operation.request.bindingId,
      });
      if (!storedBinding) throw new NotFoundError('Staging provider binding not found');
      binding = requireOperationBinding(storedBinding, operation.request);
    }

    const providerDeploymentId = operation.providerDeploymentId!;
    let observation: ProviderDeploymentObservation;
    try {
      const rawObservation = await this.adapter.observeDeployment({
        binding,
        providerDeploymentId,
        revision: operation.request.revision,
        configurationBindingGeneration: operation.request.configurationBindingGeneration,
        healthSignals: operation.request.healthSignals,
      });
      observation = ProviderDeploymentObservationSchema.parse(rawObservation);
      if (observation.providerDeploymentId !== providerDeploymentId) {
        throw new ConflictError('Staging observation belongs to a different provider deployment');
      }
    } catch (error) {
      await this.store.markOutcomeUnknown(operation.request.workspaceId, operation.request.operationId);
      throw error;
    }
    if (observation.outcome === 'pending') {
      await this.store.markOutcomeUnknown(operation.request.workspaceId, operation.request.operationId);
      return StagingDeploymentResultSchema.parse({
        status: 'reconciliation_required',
        operationId: operation.request.operationId,
        providerDeploymentId,
      });
    }

    const revocation = await this.adapter.revokeLease({
      workspaceId: operation.request.workspaceId,
      leaseId: operation.leaseId!,
      providerDeploymentId,
    });
    const settledAt = this.dependencies.now().toISOString();
    const receipt = StagingExecutionReceiptSchema.parse({
      schemaVersion: 'rorca.staging-execution-receipt.v1',
      receiptId: this.dependencies.randomUUID(),
      operationId: operation.request.operationId,
      workspaceId: operation.request.workspaceId,
      capability: 'deploy.staging',
      target: {
        providerId: binding.providerId,
        bindingId: binding.bindingId,
        projectUuid: binding.target.projectUuid,
        applicationUuid: binding.target.applicationUuid,
        environmentUuid: binding.target.environmentUuid,
      },
      revision: operation.request.revision,
      configurationBindingGeneration: operation.request.configurationBindingGeneration,
      bindingGeneration: operation.request.bindingGeneration,
      providerDeploymentId,
      health: {
        providerStatus: observation.providerStatus,
        outcome: observation.outcome,
        signals: observation.signals,
        observedAt: observation.observedAt,
      },
      lease: {
        leaseId: operation.leaseId,
        revoked: true,
        revokedAt: revocation.revokedAt,
      },
      settledAt,
    });
    return StagingDeploymentResultSchema.parse({
      status: 'settled',
      receipt: await this.store.settle(receipt),
    });
  }
}
