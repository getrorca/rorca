/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalTransaction, queryOne } from '../db/index';
import type { ProviderDeploymentAcceptance } from './authority-provider-adapter';
import { ConflictError, ForbiddenError, NotFoundError } from './errors';
import {
  OperationIntentProjectionSchema,
  ReleaseIntentSchema,
  ReleaseRolloutCohortSchema,
  type OperationIntentProjection,
  type ReleaseIntent,
  type ReleaseIntentValidation,
} from './release-intent';
import {
  PostgresReleaseIntentStore,
  type ReleaseIntentStore,
} from './release-intent-store';
import {
  PRODUCTION_ROLLOUT_RECEIPT_VERSION,
  ProductionActionAcceptanceSchema,
  ProductionActionObservationSchema,
  ProductionCanaryAcceptanceSchema,
  ProductionHealthEvaluationSchema,
  ProductionRolloutAuthoritySchema,
  ProductionRolloutReceiptSchema,
  ProductionRevisionSchema,
  evaluateProductionHealth,
  productionCohortsMatch,
  type ProductionCanaryAcceptance,
  type ProductionHealthEvaluation,
  type ProductionRolloutAdapter,
} from './production-rollout';
import {
  PostgresProductionRolloutStore,
  type ProductionRolloutStore,
  type StoredProductionAction,
  type StoredProductionRollout,
} from './production-rollout-store';

export const PRODUCTION_GATE_CONFIGURATION_VERSION = 'rorca.production-gate-configuration.v1' as const;
export const PRODUCTION_GATE_EVIDENCE_VERSION = 'rorca.production-gate-evidence.v1' as const;
export const PRODUCTION_AUTHORIZATION_VERSION = 'rorca.production-authorization.v1' as const;

const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const SafeIdentifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/);
const TimestampSchema = z.string().datetime({ offset: true }).transform((value) => new Date(value).toISOString());

export const ReviewedExternalGateConfigurationSchema = z.object({
  schemaVersion: z.literal(PRODUCTION_GATE_CONFIGURATION_VERSION),
  configurationId: z.string().uuid(),
  workspaceId: z.string().min(1).max(255),
  bindingId: z.string().uuid(),
  provider: SafeIdentifierSchema,
  gateId: SafeIdentifierSchema,
  environment: SafeIdentifierSchema,
  configurationDigest: DigestSchema,
  reviewReceiptDigest: DigestSchema,
  reviewedAt: TimestampSchema,
  status: z.literal('reviewed'),
}).strict();
export type ReviewedExternalGateConfiguration = z.infer<typeof ReviewedExternalGateConfigurationSchema>;

export const ExternalGateEvidenceReferenceSchema = z.object({
  provider: SafeIdentifierSchema,
  evidenceId: z.string().uuid(),
}).strict();
export type ExternalGateEvidenceReference = z.infer<typeof ExternalGateEvidenceReferenceSchema>;

export const VerifiedExternalGateEvidenceSchema = z.object({
  schemaVersion: z.literal(PRODUCTION_GATE_EVIDENCE_VERSION),
  evidenceId: z.string().uuid(),
  configurationId: z.string().uuid(),
  workspaceId: z.string().min(1).max(255),
  provider: SafeIdentifierSchema,
  providerEvidenceId: SafeIdentifierSchema,
  gateId: SafeIdentifierSchema,
  environment: SafeIdentifierSchema,
  configurationDigest: DigestSchema,
  decision: z.enum(['approved', 'denied']),
  operationIntentId: z.string().uuid(),
  intentDigest: DigestSchema,
  ciEvidenceDigest: DigestSchema,
  rolloutCohort: ReleaseRolloutCohortSchema,
  providerApprovalId: SafeIdentifierSchema,
  evidenceDigest: DigestSchema,
  reviewerSubjects: z.array(SafeIdentifierSchema).min(1).max(64),
  issuedAt: TimestampSchema,
  expiresAt: TimestampSchema,
  verifiedAt: TimestampSchema,
}).strict().superRefine((evidence, context) => {
  if (Date.parse(evidence.expiresAt) <= Date.parse(evidence.issuedAt)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expiresAt'],
      message: 'External gate evidence expiry must follow issuance',
    });
  }
  if (new Set(evidence.reviewerSubjects).size !== evidence.reviewerSubjects.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reviewerSubjects'],
      message: 'External gate reviewer subjects must be unique',
    });
  }
});
export type VerifiedExternalGateEvidence = z.infer<typeof VerifiedExternalGateEvidenceSchema>;

export const ProductionApprovalRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local_operator') }).strict(),
  z.object({
    kind: z.literal('external_gate'),
    evidence: ExternalGateEvidenceReferenceSchema,
  }).strict(),
]);
export type ProductionApprovalRequest = z.infer<typeof ProductionApprovalRequestSchema>;

export const ProductionDeploymentRequestSchema = z.object({
  workspaceId: z.string().min(1).max(255),
  bindingId: z.string().uuid(),
  bindingGeneration: z.number().int().positive(),
  operationId: z.string().uuid(),
  operationIntentId: z.string().uuid(),
  grantId: z.string().uuid(),
  intentDigest: DigestSchema,
  ciEvidenceDigest: DigestSchema,
  rolloutCohort: ReleaseRolloutCohortSchema,
  approval: ProductionApprovalRequestSchema,
  requestedLeaseSeconds: z.number().int().min(30).max(3600).optional(),
}).strict();
export type ProductionDeploymentRequest = z.infer<typeof ProductionDeploymentRequestSchema>;

export const ProductionAuthorizationWaitReasonSchema = z.enum([
  'external_gate_not_configured',
  'local_self_attestation_rejected',
  'external_gate_pending',
  'external_gate_denied',
  'external_gate_invalid',
  'release_material_changed',
  'grant_invalid',
  'authorization_replayed',
]);
export type ProductionAuthorizationWaitReason = z.infer<typeof ProductionAuthorizationWaitReasonSchema>;

export const ProductionDeploymentResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('waiting_for_authorization'),
    operationId: z.string().uuid(),
    reason: ProductionAuthorizationWaitReasonSchema,
  }).strict(),
  z.object({
    status: z.literal('waiting_for_change_window'),
    operationId: z.string().uuid(),
    reason: z.enum(['window_not_started', 'window_closed']),
    startsAt: TimestampSchema,
    endsAt: TimestampSchema,
  }).strict(),
  z.object({
    status: z.literal('dispatched'),
    operationId: z.string().uuid(),
    providerDeploymentId: z.string().min(1).max(255),
    acceptedAt: TimestampSchema,
  }).strict(),
  z.object({
    status: z.literal('reconciliation_required'),
    operationId: z.string().uuid(),
    phase: z.enum(['canary', 'expansion', 'rollback']),
    actionId: z.string().uuid(),
    providerDeploymentId: z.string().min(1).max(255).nullable(),
    healthEvaluation: ProductionHealthEvaluationSchema.nullable(),
  }).strict(),
  z.object({
    status: z.literal('settled'),
    receipt: ProductionRolloutReceiptSchema,
  }).strict(),
]);
export type ProductionDeploymentResult = z.infer<typeof ProductionDeploymentResultSchema>;

export interface ProductionPolicyProjection {
  mode: 'local_operator' | 'independent_external';
  externalGate: ReviewedExternalGateConfiguration | null;
}

export const ProductionAuthorizationTicketSchema = z.object({
  schemaVersion: z.literal(PRODUCTION_AUTHORIZATION_VERSION),
  authorizationId: z.string().uuid(),
  operationId: z.string().uuid(),
  workspaceId: z.string().min(1).max(255),
  bindingId: z.string().uuid(),
  bindingGeneration: z.number().int().positive(),
  operationIntentId: z.string().uuid(),
  intentDigest: DigestSchema,
  ciEvidenceDigest: DigestSchema,
  grantId: z.string().uuid(),
  gateEvidenceId: z.string().uuid().nullable(),
  authorizedAt: TimestampSchema,
}).strict();
export type ProductionAuthorizationTicket = z.infer<typeof ProductionAuthorizationTicketSchema>;

export interface ClaimedProductionAuthorization {
  ticket: ProductionAuthorizationTicket;
  releaseIntent: ReleaseIntent;
  existingAcceptance: ProviderDeploymentAcceptance | null;
}

export interface ProductionAuthorizationClaimStore {
  claimAuthorizedDispatch(
    ticket: ProductionAuthorizationTicket,
    now?: Date,
  ): Promise<ClaimedProductionAuthorization>;
}

export interface ProductionDispatchAdapter {
  dispatchAuthorizedProduction(input: {
    ticket: ProductionAuthorizationTicket;
    releaseIntent: OperationIntentProjection['releaseIntent'];
    requestedLeaseSeconds?: number;
  }): Promise<ProductionCanaryAcceptance>;
}

export interface ProductionDeploymentStore {
  ensureOperation(
    request: ProductionDeploymentRequest,
    projection: OperationIntentProjection,
  ): Promise<void>;
  getPolicy(workspaceId: string, bindingId: string): Promise<ProductionPolicyProjection>;
  getVerifiedExternalGateEvidence(
    configuration: ReviewedExternalGateConfiguration,
    reference: ExternalGateEvidenceReference,
  ): Promise<VerifiedExternalGateEvidence | null>;
  markWaitingForAuthorization(
    request: ProductionDeploymentRequest,
    reason: ProductionAuthorizationWaitReason,
  ): Promise<void>;
  markWaitingForChangeWindow(
    request: ProductionDeploymentRequest,
    reason: 'window_not_started' | 'window_closed',
  ): Promise<void>;
  authorize(input: {
    request: ProductionDeploymentRequest;
    validation: ReleaseIntentValidation;
    mode: ProductionPolicyProjection['mode'];
    configuration: ReviewedExternalGateConfiguration | null;
    evidence: VerifiedExternalGateEvidence | null;
    authorizedAt: string;
  }): Promise<ProductionAuthorizationTicket | null>;
  markDispatched(
    workspaceId: string,
    operationId: string,
    acceptance: ProviderDeploymentAcceptance,
  ): Promise<void>;
}

interface BindingPolicyRow {
  workspace_id: string;
  environment_kind: string;
  binding_generation: number | string;
  capability_policy: unknown;
}

interface GateConfigurationRow {
  id: string;
  workspace_id: string;
  binding_id: string;
  provider: string;
  gate_id: string;
  environment: string;
  configuration_digest: string;
  review_receipt_digest: string;
  reviewed_at: Date | string;
  status: string;
}

interface GateEvidenceRow {
  id: string;
  configuration_id: string;
  workspace_id: string;
  provider: string;
  provider_evidence_id: string;
  gate_id: string;
  environment: string;
  configuration_digest: string;
  decision: string;
  operation_intent_id: string;
  intent_digest: string;
  ci_evidence_digest: string;
  rollout_cohort: unknown;
  provider_approval_id: string;
  evidence_digest: string;
  reviewer_subjects: unknown;
  issued_at: Date | string;
  expires_at: Date | string;
  verified_at: Date | string;
}

function jsonValue(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) as unknown : value;
}

function postgresCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  return typeof error.code === 'string' ? error.code : null;
}

function gateConfiguration(row: GateConfigurationRow): ReviewedExternalGateConfiguration {
  return ReviewedExternalGateConfigurationSchema.parse({
    schemaVersion: PRODUCTION_GATE_CONFIGURATION_VERSION,
    configurationId: row.id,
    workspaceId: row.workspace_id,
    bindingId: row.binding_id,
    provider: row.provider,
    gateId: row.gate_id,
    environment: row.environment,
    configurationDigest: row.configuration_digest,
    reviewReceiptDigest: row.review_receipt_digest,
    reviewedAt: new Date(row.reviewed_at).toISOString(),
    status: row.status,
  });
}

function gateEvidence(row: GateEvidenceRow): VerifiedExternalGateEvidence {
  return VerifiedExternalGateEvidenceSchema.parse({
    schemaVersion: PRODUCTION_GATE_EVIDENCE_VERSION,
    evidenceId: row.id,
    configurationId: row.configuration_id,
    workspaceId: row.workspace_id,
    provider: row.provider,
    providerEvidenceId: row.provider_evidence_id,
    gateId: row.gate_id,
    environment: row.environment,
    configurationDigest: row.configuration_digest,
    decision: row.decision,
    operationIntentId: row.operation_intent_id,
    intentDigest: row.intent_digest,
    ciEvidenceDigest: row.ci_evidence_digest,
    rolloutCohort: jsonValue(row.rollout_cohort),
    providerApprovalId: row.provider_approval_id,
    evidenceDigest: row.evidence_digest,
    reviewerSubjects: jsonValue(row.reviewer_subjects),
    issuedAt: new Date(row.issued_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    verifiedAt: new Date(row.verified_at).toISOString(),
  });
}

function requestDigest(request: ProductionDeploymentRequest): string {
  return createHash('sha256')
    .update(JSON.stringify(ProductionDeploymentRequestSchema.parse(request)))
    .digest('hex');
}

export class PostgresProductionDeploymentStore implements ProductionDeploymentStore {
  async ensureOperation(
    request: ProductionDeploymentRequest,
    projection: OperationIntentProjection,
  ): Promise<void> {
    const imageDigest = projection.releaseIntent.artifacts.imageDigests[0] ?? null;
    try {
      await canonicalTransaction(async (client) => {
        const inserted = await client.query(
          `INSERT INTO rorca.authority_deployment_operations
            (id, workspace_id, binding_id, binding_generation, capability,
             source_revision, image_digest, configuration_binding_generation,
             health_signals, request_digest, requested_lease_seconds, status)
           VALUES ($1, $2, $3, $4, 'deploy.production', $5, $6, $7, $8::jsonb, $9, $10, 'requested')
           ON CONFLICT (id) DO NOTHING
           RETURNING id`,
          [
            request.operationId,
            request.workspaceId,
            request.bindingId,
            request.bindingGeneration,
            projection.releaseIntent.sourceRevision,
            imageDigest,
            projection.releaseIntent.configurationBindingGeneration,
            JSON.stringify(projection.releaseIntent.healthSignals),
            requestDigest(request),
            request.requestedLeaseSeconds ?? null,
          ],
        );
        if (inserted.rowCount === 0) {
          const existing = await client.query<{ request_digest: string; capability: string }>(
            `SELECT request_digest, capability
               FROM rorca.authority_deployment_operations
              WHERE id = $1 AND workspace_id = $2`,
            [request.operationId, request.workspaceId],
          );
          if (existing.rows[0]?.request_digest !== requestDigest(request)
            || existing.rows[0]?.capability !== 'deploy.production') {
            throw new ConflictError('Production operation id belongs to different immutable request material');
          }
        }
        await client.query(
          `INSERT INTO rorca.authority_production_authorizations
            (operation_id, workspace_id, binding_id, binding_generation,
             operation_intent_id, requested_intent_digest,
             requested_ci_evidence_digest, requested_rollout_cohort,
             requested_grant_id, approval_kind, request_digest, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, 'requested')
           ON CONFLICT (operation_id) DO NOTHING`,
          [
            request.operationId,
            request.workspaceId,
            request.bindingId,
            request.bindingGeneration,
            request.operationIntentId,
            request.intentDigest,
            request.ciEvidenceDigest,
            JSON.stringify(request.rolloutCohort),
            request.grantId,
            request.approval.kind,
            requestDigest(request),
          ],
        );
      });
    } catch (error) {
      if (postgresCode(error) === '23505') {
        throw new ConflictError('Production operation reuses consumed authorization evidence');
      }
      throw error;
    }
  }

  async getPolicy(workspaceId: string, bindingId: string): Promise<ProductionPolicyProjection> {
    const binding = await queryOne<BindingPolicyRow>(
      `SELECT workspace_id, environment_kind, binding_generation, capability_policy
         FROM rorca.deployment_provider_bindings
        WHERE workspace_id = $1 AND id = $2 AND provider_id = 'coolify'`,
      [workspaceId, bindingId],
    );
    if (!binding || binding.environment_kind !== 'production') {
      throw new ForbiddenError('Production authorization requires the exact production binding');
    }
    const policy = z.object({
      productionApprovalMode: z.enum(['local_operator', 'independent_external']).optional(),
    }).passthrough().parse(jsonValue(binding.capability_policy));
    const mode = policy.productionApprovalMode ?? 'independent_external';
    if (mode === 'local_operator') return { mode, externalGate: null };

    const configuration = await queryOne<GateConfigurationRow>(
      `SELECT id, workspace_id, binding_id, provider, gate_id, environment,
              configuration_digest, review_receipt_digest, reviewed_at, status
         FROM rorca.authority_external_gate_configurations
        WHERE workspace_id = $1 AND binding_id = $2 AND status = 'reviewed'`,
      [workspaceId, bindingId],
    );
    return {
      mode,
      externalGate: configuration ? gateConfiguration(configuration) : null,
    };
  }

  async getVerifiedExternalGateEvidence(
    configuration: ReviewedExternalGateConfiguration,
    reference: ExternalGateEvidenceReference,
  ): Promise<VerifiedExternalGateEvidence | null> {
    if (reference.provider !== configuration.provider) return null;
    const row = await queryOne<GateEvidenceRow>(
      `SELECT id, configuration_id, workspace_id, provider, provider_evidence_id,
              gate_id, environment, configuration_digest, decision,
              operation_intent_id, intent_digest, ci_evidence_digest,
              rollout_cohort, provider_approval_id, evidence_digest,
              reviewer_subjects, issued_at, expires_at, verified_at
         FROM rorca.authority_external_gate_evidence
        WHERE id = $1 AND configuration_id = $2 AND workspace_id = $3
          AND provider = $4`,
      [reference.evidenceId, configuration.configurationId, configuration.workspaceId, reference.provider],
    );
    return row ? gateEvidence(row) : null;
  }

  async markWaitingForAuthorization(
    request: ProductionDeploymentRequest,
    reason: ProductionAuthorizationWaitReason,
  ): Promise<void> {
    await this.markWaiting(request, 'waiting_for_authorization', reason);
  }

  async markWaitingForChangeWindow(
    request: ProductionDeploymentRequest,
    reason: 'window_not_started' | 'window_closed',
  ): Promise<void> {
    await this.markWaiting(request, 'waiting_for_change_window', reason);
  }

  private async markWaiting(
    request: ProductionDeploymentRequest,
    status: 'waiting_for_authorization' | 'waiting_for_change_window',
    reason: ProductionAuthorizationWaitReason | 'window_not_started' | 'window_closed',
  ): Promise<void> {
    await canonicalTransaction(async (client) => {
      await client.query(
        `UPDATE rorca.authority_production_authorizations
            SET status = $3, wait_reason = $4, updated_at = NOW()
          WHERE operation_id = $1 AND workspace_id = $2
            AND status IN ('requested', 'waiting_for_authorization', 'waiting_for_change_window')`,
        [request.operationId, request.workspaceId, status, reason],
      );
      await client.query(
        `UPDATE rorca.authority_deployment_operations
            SET status = $3
          WHERE id = $1 AND workspace_id = $2
            AND status IN ('requested', 'waiting_for_authorization', 'waiting_for_change_window')`,
        [request.operationId, request.workspaceId, status],
      );
    });
  }

  async authorize(input: {
    request: ProductionDeploymentRequest;
    validation: ReleaseIntentValidation;
    mode: ProductionPolicyProjection['mode'];
    configuration: ReviewedExternalGateConfiguration | null;
    evidence: VerifiedExternalGateEvidence | null;
    authorizedAt: string;
  }): Promise<ProductionAuthorizationTicket | null> {
    try {
      return await canonicalTransaction(async (client) => {
        const updated = await client.query<{ id: string }>(
          `UPDATE rorca.authority_production_authorizations
              SET status = 'authorized', wait_reason = NULL,
                  authorization_grant_id = $3,
                  external_gate_configuration_id = $4,
                  external_gate_evidence_id = $5,
                  approval_mode = $6,
                  authorized_at = $7,
                  updated_at = $7
            WHERE operation_id = $1 AND workspace_id = $2
              AND requested_grant_id = $3
              AND requested_intent_digest = $8
              AND requested_ci_evidence_digest = $9
              AND status IN ('requested', 'waiting_for_authorization', 'waiting_for_change_window')
           RETURNING id`,
          [
            input.request.operationId,
            input.request.workspaceId,
            input.validation.grantId,
            input.configuration?.configurationId ?? null,
            input.evidence?.evidenceId ?? null,
            input.mode,
            input.authorizedAt,
            input.validation.intentDigest,
            input.validation.ciEvidenceDigest,
          ],
        );
        const authorizationId = updated.rows[0]?.id;
        if (!authorizationId) {
          const existing = await client.query<{ id: string; status: string }>(
            `SELECT id, status
               FROM rorca.authority_production_authorizations
              WHERE operation_id = $1 AND workspace_id = $2`,
            [input.request.operationId, input.request.workspaceId],
          );
          if (!existing.rows[0] || !['authorized', 'dispatch_claimed', 'dispatched'].includes(existing.rows[0].status)) {
            return null;
          }
          return this.ticket(input, existing.rows[0].id);
        }
        await client.query(
          `UPDATE rorca.authority_deployment_operations
              SET status = 'authorized'
            WHERE id = $1 AND workspace_id = $2`,
          [input.request.operationId, input.request.workspaceId],
        );
        return this.ticket(input, authorizationId);
      });
    } catch (error) {
      if (postgresCode(error) === '23505') return null;
      throw error;
    }
  }

  private ticket(
    input: {
      request: ProductionDeploymentRequest;
      validation: ReleaseIntentValidation;
      evidence: VerifiedExternalGateEvidence | null;
      authorizedAt: string;
    },
    authorizationId: string,
  ): ProductionAuthorizationTicket {
    return {
      schemaVersion: PRODUCTION_AUTHORIZATION_VERSION,
      authorizationId,
      operationId: input.request.operationId,
      workspaceId: input.request.workspaceId,
      bindingId: input.request.bindingId,
      bindingGeneration: input.request.bindingGeneration,
      operationIntentId: input.request.operationIntentId,
      intentDigest: input.validation.intentDigest,
      ciEvidenceDigest: input.validation.ciEvidenceDigest,
      grantId: input.validation.grantId,
      gateEvidenceId: input.evidence?.evidenceId ?? null,
      authorizedAt: input.authorizedAt,
    };
  }

  async markDispatched(
    workspaceId: string,
    operationId: string,
    acceptance: ProviderDeploymentAcceptance,
  ): Promise<void> {
    await canonicalTransaction(async (client) => {
      await client.query(
        `UPDATE rorca.authority_production_authorizations
            SET status = 'dispatched', updated_at = NOW()
          WHERE operation_id = $1 AND workspace_id = $2
            AND status IN ('authorized', 'dispatch_claimed', 'dispatched')`,
        [operationId, workspaceId],
      );
      await client.query(
        `UPDATE rorca.authority_deployment_operations
            SET status = 'dispatched', provider_deployment_id = $3,
                provider_accepted_at = $4
          WHERE id = $1 AND workspace_id = $2
            AND status IN ('authorized', 'leased', 'dispatched')
            AND (provider_deployment_id IS NULL OR provider_deployment_id = $3)`,
        [operationId, workspaceId, acceptance.providerDeploymentId, acceptance.acceptedAt],
      );
    });
  }

  async claimAuthorizedDispatch(
    rawTicket: ProductionAuthorizationTicket,
    now = new Date(),
  ): Promise<ClaimedProductionAuthorization> {
    const ticket = ProductionAuthorizationTicketSchema.parse(rawTicket);
    return canonicalTransaction(async (client) => {
      const result = await client.query<{
        id: string;
        status: string;
        operation_id: string;
        workspace_id: string;
        binding_id: string;
        binding_generation: number | string;
        operation_intent_id: string;
        requested_intent_digest: string;
        requested_ci_evidence_digest: string;
        authorization_grant_id: string | null;
        external_gate_evidence_id: string | null;
        approval_mode: string | null;
        authorized_at: Date | string | null;
        grant_expires_at: Date | string;
        intent_payload: unknown;
        change_window_starts_at: string;
        change_window_ends_at: string;
        binding_status: string;
        environment_kind: string;
        current_binding_generation: number | string;
        capability_policy: unknown;
        gate_configuration_status: string | null;
        gate_decision: string | null;
        gate_expires_at: Date | string | null;
        provider_deployment_id: string | null;
        provider_accepted_at: Date | string | null;
      }>(
        `SELECT a.id, a.status, a.operation_id, a.workspace_id, a.binding_id,
                a.binding_generation, a.operation_intent_id,
                a.requested_intent_digest, a.requested_ci_evidence_digest,
                a.authorization_grant_id, a.external_gate_evidence_id,
                a.approval_mode, a.authorized_at,
                g.expires_at AS grant_expires_at,
                i.intent_payload,
                i.intent_payload#>>'{changeWindow,startsAt}' AS change_window_starts_at,
                i.intent_payload#>>'{changeWindow,endsAt}' AS change_window_ends_at,
                b.status AS binding_status, b.environment_kind,
                b.binding_generation AS current_binding_generation,
                b.capability_policy,
                c.status AS gate_configuration_status,
                e.decision AS gate_decision, e.expires_at AS gate_expires_at,
                o.provider_deployment_id, o.provider_accepted_at
           FROM rorca.authority_production_authorizations a
           JOIN rorca.authority_deployment_operations o ON o.id = a.operation_id
           JOIN rorca.authority_operation_intents i ON i.id = a.operation_intent_id
           JOIN rorca.authority_operation_intent_grants g ON g.id = a.authorization_grant_id
           JOIN rorca.deployment_provider_bindings b ON b.id = a.binding_id
           LEFT JOIN rorca.authority_external_gate_configurations c
             ON c.id = a.external_gate_configuration_id
           LEFT JOIN rorca.authority_external_gate_evidence e
             ON e.id = a.external_gate_evidence_id
          WHERE a.id = $1 AND a.operation_id = $2 AND a.workspace_id = $3
          FOR UPDATE OF a, o`,
        [ticket.authorizationId, ticket.operationId, ticket.workspaceId],
      );
      const row = result.rows[0];
      if (!row
        || !['authorized', 'dispatch_claimed', 'dispatched'].includes(row.status)
        || row.operation_id !== ticket.operationId
        || row.workspace_id !== ticket.workspaceId
        || row.binding_id !== ticket.bindingId
        || Number(row.binding_generation) !== ticket.bindingGeneration
        || row.operation_intent_id !== ticket.operationIntentId
        || row.requested_intent_digest !== ticket.intentDigest
        || row.requested_ci_evidence_digest !== ticket.ciEvidenceDigest
        || row.authorization_grant_id !== ticket.grantId
        || row.external_gate_evidence_id !== ticket.gateEvidenceId
        || (row.authorized_at === null
          || new Date(row.authorized_at).toISOString() !== ticket.authorizedAt)
        || row.binding_status !== 'active'
        || row.environment_kind !== 'production'
        || Number(row.current_binding_generation) !== ticket.bindingGeneration
        || (row.status === 'authorized'
          && (Date.parse(String(row.grant_expires_at)) <= now.getTime()
            || Date.parse(row.change_window_starts_at) > now.getTime()
            || Date.parse(row.change_window_ends_at) <= now.getTime()))
        || ((row.provider_deployment_id === null) !== (row.provider_accepted_at === null))) {
        throw new ForbiddenError('Production dispatch authorization is stale or differs from exact authority material');
      }
      const policy = z.object({
        productionApprovalMode: z.enum(['local_operator', 'independent_external']).optional(),
      }).passthrough().parse(jsonValue(row.capability_policy));
      const expectedMode = policy.productionApprovalMode ?? 'independent_external';
      if (row.approval_mode !== expectedMode
        || (row.status === 'authorized'
          && expectedMode === 'independent_external'
          && (row.gate_configuration_status !== 'reviewed'
            || row.gate_decision !== 'approved'
            || row.gate_expires_at === null
            || Date.parse(String(row.gate_expires_at)) <= now.getTime()))) {
        throw new ForbiddenError('Production dispatch external gate is unavailable, denied, or expired');
      }
      const releaseIntent = ReleaseIntentSchema.parse(jsonValue(row.intent_payload));
      if (row.status === 'authorized') {
        await client.query(
          `UPDATE rorca.authority_production_authorizations
              SET status = 'dispatch_claimed', claimed_at = $2, updated_at = $2
            WHERE id = $1 AND status = 'authorized'`,
          [ticket.authorizationId, now],
        );
      }
      let existingAcceptance: ProviderDeploymentAcceptance | null = null;
      if (row.provider_deployment_id !== null && row.provider_accepted_at !== null) {
        existingAcceptance = {
          providerDeploymentId: row.provider_deployment_id,
          acceptedAt: new Date(row.provider_accepted_at).toISOString(),
        };
      }
      return {
        ticket,
        releaseIntent,
        existingAcceptance,
      };
    });
  }
}

function cohortsMatch(
  left: ProductionDeploymentRequest['rolloutCohort'],
  right: OperationIntentProjection['releaseIntent']['rolloutCohort'],
): boolean {
  return left.cohortId === right.cohortId
    && left.percentage === right.percentage
    && left.selectorDigest === right.selectorDigest;
}

function evidenceMatches(
  configuration: ReviewedExternalGateConfiguration,
  evidence: VerifiedExternalGateEvidence,
  reference: ExternalGateEvidenceReference,
  request: ProductionDeploymentRequest,
  projection: OperationIntentProjection,
  now: Date,
  localOperatorId?: string,
): boolean {
  const approval = projection.releaseIntent.providerApprovalReference;
  return configuration.workspaceId === request.workspaceId
    && configuration.bindingId === request.bindingId
    && evidence.evidenceId === reference.evidenceId
    && evidence.provider === reference.provider
    && evidence.configurationId === configuration.configurationId
    && evidence.workspaceId === request.workspaceId
    && evidence.provider === configuration.provider
    && evidence.gateId === configuration.gateId
    && evidence.environment === configuration.environment
    && evidence.configurationDigest === configuration.configurationDigest
    && evidence.operationIntentId === projection.operationIntentId
    && evidence.intentDigest === projection.intentDigest
    && evidence.ciEvidenceDigest === projection.ciEvidenceDigest
    && cohortsMatch(evidence.rolloutCohort, projection.releaseIntent.rolloutCohort)
    && evidence.provider === approval.provider
    && evidence.providerApprovalId === approval.approvalId
    && evidence.environment === approval.environment
    && evidence.evidenceDigest === approval.evidenceDigest
    && evidence.reviewerSubjects.every((subject) =>
      subject.startsWith(`${evidence.provider}:`) && subject !== localOperatorId)
    && Date.parse(configuration.reviewedAt) <= now.getTime()
    && Date.parse(evidence.issuedAt) <= now.getTime()
    && Date.parse(evidence.verifiedAt) <= now.getTime()
    && Date.parse(evidence.expiresAt) > now.getTime();
}

interface ServiceDependencies {
  now(): Date;
  randomUUID(): string;
}

const DEFAULT_SERVICE_DEPENDENCIES: ServiceDependencies = {
  now: () => new Date(),
  randomUUID,
};

export class CoolifyProductionDeploymentService {
  constructor(
    private readonly adapter: ProductionDispatchAdapter & ProductionRolloutAdapter,
    private readonly store: ProductionDeploymentStore = new PostgresProductionDeploymentStore(),
    private readonly releaseIntents: Pick<ReleaseIntentStore, 'get' | 'validate'> = new PostgresReleaseIntentStore(),
    private readonly dependencies: ServiceDependencies = DEFAULT_SERVICE_DEPENDENCIES,
    private readonly rollouts: ProductionRolloutStore = new PostgresProductionRolloutStore(),
  ) {}

  async deploy(rawRequest: ProductionDeploymentRequest, localOperatorId?: string): Promise<ProductionDeploymentResult> {
    const request = ProductionDeploymentRequestSchema.parse(rawRequest);
    const projection = await this.releaseIntents.get(request.workspaceId, request.operationIntentId);
    if (!projection) throw new NotFoundError('Release operation intent', request.operationIntentId);
    const parsedProjection = OperationIntentProjectionSchema.parse(projection);
    await this.store.ensureOperation(request, parsedProjection);

    if (request.intentDigest !== parsedProjection.intentDigest
      || request.ciEvidenceDigest !== parsedProjection.ciEvidenceDigest
      || !cohortsMatch(request.rolloutCohort, parsedProjection.releaseIntent.rolloutCohort)) {
      return this.waitForAuthorization(request, 'release_material_changed');
    }

    let validation: ReleaseIntentValidation;
    try {
      validation = await this.releaseIntents.validate(
        request.workspaceId,
        request.operationIntentId,
        request.grantId,
        this.dependencies.now(),
      );
    } catch (error) {
      if (error instanceof ForbiddenError || error instanceof NotFoundError) {
        return this.waitForAuthorization(request, 'grant_invalid');
      }
      throw error;
    }

    const policy = await this.store.getPolicy(request.workspaceId, request.bindingId);
    let configuration: ReviewedExternalGateConfiguration | null = null;
    let evidence: VerifiedExternalGateEvidence | null = null;
    const now = this.dependencies.now();

    if (policy.mode === 'independent_external') {
      if (request.approval.kind === 'local_operator') {
        return this.waitForAuthorization(request, 'local_self_attestation_rejected');
      }
      configuration = policy.externalGate;
      if (!configuration) {
        return this.waitForAuthorization(request, 'external_gate_not_configured');
      }
      evidence = await this.store.getVerifiedExternalGateEvidence(configuration, request.approval.evidence);
      if (!evidence) return this.waitForAuthorization(request, 'external_gate_pending');
      if (evidence.decision === 'denied') {
        return this.waitForAuthorization(request, 'external_gate_denied');
      }
      if (!evidenceMatches(
        configuration,
        evidence,
        request.approval.evidence,
        request,
        parsedProjection,
        now,
        localOperatorId,
      )) {
        return this.waitForAuthorization(request, 'external_gate_invalid');
      }
    } else if (request.approval.kind !== 'local_operator' || !localOperatorId) {
      return this.waitForAuthorization(request, 'grant_invalid');
    }

    const window = parsedProjection.releaseIntent.changeWindow;
    if (now.getTime() < Date.parse(window.startsAt)) {
      return this.waitForWindow(request, 'window_not_started', window);
    }
    if (now.getTime() >= Date.parse(window.endsAt)) {
      return this.waitForWindow(request, 'window_closed', window);
    }

    const ticket = await this.store.authorize({
      request,
      validation,
      mode: policy.mode,
      configuration,
      evidence,
      authorizedAt: now.toISOString(),
    });
    if (!ticket) return this.waitForAuthorization(request, 'authorization_replayed');

    const acceptance = ProductionCanaryAcceptanceSchema.parse(
      await this.adapter.dispatchAuthorizedProduction({
        ticket,
        releaseIntent: parsedProjection.releaseIntent,
        ...(request.requestedLeaseSeconds === undefined
          ? {}
          : { requestedLeaseSeconds: request.requestedLeaseSeconds }),
      }),
    );
    await this.store.markDispatched(request.workspaceId, request.operationId, acceptance.action);
    await this.rollouts.start({
      authority: ProductionRolloutAuthoritySchema.parse({
        authorizationId: ticket.authorizationId,
        operationId: ticket.operationId,
        workspaceId: ticket.workspaceId,
        bindingId: ticket.bindingId,
        bindingGeneration: ticket.bindingGeneration,
        operationIntentId: ticket.operationIntentId,
        intentDigest: ticket.intentDigest,
        ciEvidenceDigest: ticket.ciEvidenceDigest,
        grantId: ticket.grantId,
        gateEvidenceId: ticket.gateEvidenceId,
        authorizedAt: ticket.authorizedAt,
      }),
      target: acceptance.target,
      priorState: acceptance.priorState,
      approvedCohort: parsedProjection.releaseIntent.rolloutCohort,
      canary: acceptance.action,
    });
    return ProductionDeploymentResultSchema.parse({
      status: 'dispatched',
      operationId: request.operationId,
      providerDeploymentId: acceptance.action.providerDeploymentId,
      acceptedAt: acceptance.action.acceptedAt,
    });
  }

  async reconcile(workspaceId: string, operationId: string): Promise<ProductionDeploymentResult> {
    let rollout = await this.rollouts.read(workspaceId, operationId);
    if (!rollout) throw new NotFoundError('Production rollout not found');
    if (rollout.receipt) {
      return ProductionDeploymentResultSchema.parse({
        status: 'settled',
        receipt: rollout.receipt,
      });
    }
    const projection = await this.releaseIntents.get(workspaceId, rollout.authority.operationIntentId);
    if (!projection) throw new NotFoundError('Release operation intent', rollout.authority.operationIntentId);
    const parsedProjection = OperationIntentProjectionSchema.parse(projection);
    const releaseIntent = parsedProjection.releaseIntent;
    if (parsedProjection.intentDigest !== rollout.authority.intentDigest
      || parsedProjection.ciEvidenceDigest !== rollout.authority.ciEvidenceDigest
      || !productionCohortsMatch(releaseIntent.rolloutCohort, rollout.approvedCohort)) {
      throw new ForbiddenError('Production rollout release material changed after canary dispatch');
    }

    const canary = rollout.actions.find((action) => action.phase === 'canary');
    if (!canary?.acceptance) {
      throw new ConflictError('Production rollout has no accepted canary action to reconcile');
    }
    let evaluation = rollout.evaluation;
    if (evaluation === null) {
      const observation = ProductionActionObservationSchema.parse(
        await this.adapter.observeProductionAction({
          authority: rollout.authority,
          action: canary.acceptance,
          releaseIntent,
        }),
      );
      if (observation.actionId !== canary.actionId || observation.phase !== 'canary'
        || observation.evidence.providerDeploymentId !== canary.acceptance.providerDeploymentId
        || JSON.stringify(observation.evidence.revision)
          !== JSON.stringify(canary.acceptance.targetRevision)
        || !productionCohortsMatch(observation.evidence.rolloutCohort, rollout.approvedCohort)) {
        throw new ConflictError('Canary observation differs from exact approved rollout');
      }
      const candidate = evaluateProductionHealth(releaseIntent, observation.evidence);
      if (observation.evidence.providerOutcome === 'pending' || candidate.decision === 'pending') {
        return this.reconciliationRequired(operationId, canary, candidate);
      }
      rollout = await this.rollouts.recordActionObservation(
        workspaceId,
        operationId,
        observation,
      );
      rollout = await this.rollouts.recordEvaluation(
        workspaceId,
        operationId,
        candidate,
      );
      evaluation = candidate;
    }

    if (evaluation.decision === 'expand') {
      let expansion = rollout.actions.find((action) => action.phase === 'expansion');
      if (!expansion) {
        expansion = await this.rollouts.prepareAction({
          workspaceId,
          operationId,
          phase: 'expansion',
          targetRevision: ProductionRevisionSchema.parse({
            sourceRevision: releaseIntent.sourceRevision,
            imageDigest: releaseIntent.artifacts.imageDigests[0]!,
            configurationBindingGeneration: releaseIntent.configurationBindingGeneration,
          }),
        });
        rollout = (await this.rollouts.read(workspaceId, operationId))!;
      }
      const acceptedExpansion = await this.ensureActionAccepted(
        rollout,
        expansion,
        releaseIntent,
      );
      if (acceptedExpansion === null) {
        return this.reconciliationRequired(operationId, expansion, evaluation);
      }
      rollout = acceptedExpansion.rollout;
      expansion = acceptedExpansion.action;
      if (expansion.observation === null) {
        const observation = ProductionActionObservationSchema.parse(
          await this.adapter.observeProductionAction({
            authority: rollout.authority,
            action: expansion.acceptance!,
            releaseIntent,
          }),
        );
        if (observation.evidence.providerOutcome === 'pending') {
          return this.reconciliationRequired(operationId, expansion, evaluation);
        }
        rollout = await this.rollouts.recordActionObservation(
          workspaceId,
          operationId,
          observation,
        );
        expansion = rollout.actions.find((action) => action.phase === 'expansion')!;
      }
      if (expansion.observation?.evidence.providerOutcome === 'healthy') {
        return this.settleRollout(rollout, releaseIntent, evaluation, false);
      }
    }

    let rollback = rollout.actions.find((action) => action.phase === 'rollback');
    if (!rollback) {
      rollback = await this.rollouts.prepareAction({
        workspaceId,
        operationId,
        phase: 'rollback',
        targetRevision: rollout.priorState.revision,
      });
      rollout = (await this.rollouts.read(workspaceId, operationId))!;
    }
    const acceptedRollback = await this.ensureActionAccepted(rollout, rollback, releaseIntent);
    if (acceptedRollback === null) {
      return this.reconciliationRequired(operationId, rollback, evaluation);
    }
    rollout = acceptedRollback.rollout;
    rollback = acceptedRollback.action;
    if (rollback.observation === null) {
      const observation = ProductionActionObservationSchema.parse(
        await this.adapter.observeProductionAction({
          authority: rollout.authority,
          action: rollback.acceptance!,
          releaseIntent,
        }),
      );
      if (observation.evidence.providerOutcome !== 'healthy') {
        return this.reconciliationRequired(operationId, rollback, evaluation);
      }
      rollout = await this.rollouts.recordActionObservation(
        workspaceId,
        operationId,
        observation,
      );
    }
    return this.settleRollout(rollout, releaseIntent, evaluation, true);
  }

  private async ensureActionAccepted(
    rollout: StoredProductionRollout,
    action: StoredProductionAction,
    releaseIntent: ReleaseIntent,
  ): Promise<{ rollout: StoredProductionRollout; action: StoredProductionAction } | null> {
    if (action.acceptance) return { rollout, action };
    let acceptance;
    if (action.status === 'outcome_unknown') {
      acceptance = await this.adapter.reconcileProductionAction({
        authority: rollout.authority,
        actionId: action.actionId,
        phase: action.phase,
        releaseIntent,
        priorState: rollout.priorState,
      });
      if (acceptance === null) return null;
    } else {
      if (action.phase === 'canary') {
        throw new ConflictError('Canary action cannot be redispatched during reconciliation');
      }
      acceptance = await this.adapter.dispatchProductionAction({
        authority: rollout.authority,
        actionId: action.actionId,
        phase: action.phase,
        releaseIntent,
        priorState: rollout.priorState,
      });
    }
    const parsedAcceptance = ProductionActionAcceptanceSchema.parse(acceptance);
    rollout = await this.rollouts.recordActionAcceptance(
      rollout.authority.workspaceId,
      rollout.authority.operationId,
      parsedAcceptance,
    );
    const storedAction = rollout.actions.find((candidate) => candidate.actionId === action.actionId);
    if (!storedAction?.acceptance) {
      throw new ConflictError('Production action acceptance was not durably checkpointed');
    }
    return { rollout, action: storedAction };
  }

  private reconciliationRequired(
    operationId: string,
    action: StoredProductionAction,
    healthEvaluation: ProductionHealthEvaluation,
  ): ProductionDeploymentResult {
    return ProductionDeploymentResultSchema.parse({
      status: 'reconciliation_required',
      operationId,
      phase: action.phase,
      actionId: action.actionId,
      providerDeploymentId: action.acceptance?.providerDeploymentId ?? null,
      healthEvaluation,
    });
  }

  private async settleRollout(
    initialRollout: StoredProductionRollout,
    releaseIntent: ReleaseIntent,
    evaluation: ProductionHealthEvaluation,
    rolledBack: boolean,
  ): Promise<ProductionDeploymentResult> {
    let rollout = initialRollout;
    for (const action of rollout.actions) {
      if (!action.acceptance || !action.observation) {
        throw new ConflictError('Production rollout cannot settle without observed action lineage');
      }
      if (action.revocation === null) {
        const revocation = await this.adapter.revokeProductionActionLease({
          authority: rollout.authority,
          action: action.acceptance,
        });
        rollout = await this.rollouts.recordRevocation(
          rollout.authority.workspaceId,
          rollout.authority.operationId,
          revocation,
        );
      }
    }
    const canary = rollout.actions.find((action) => action.phase === 'canary');
    const rollback = rollout.actions.find((action) => action.phase === 'rollback');
    if (!canary?.acceptance || !canary.revocation
      || (rolledBack && (!rollback?.acceptance || !rollback.observation))) {
      throw new ConflictError('Production terminal receipt lacks canary or rollback lineage');
    }
    const settledAt = this.dependencies.now().toISOString();
    const receipt = ProductionRolloutReceiptSchema.parse({
      schemaVersion: PRODUCTION_ROLLOUT_RECEIPT_VERSION,
      receiptId: this.dependencies.randomUUID(),
      operationId: rollout.authority.operationId,
      workspaceId: rollout.authority.workspaceId,
      capability: 'deploy.production',
      operationIntentId: rollout.authority.operationIntentId,
      releaseIntentDigest: rollout.authority.intentDigest,
      ciEvidenceDigest: rollout.authority.ciEvidenceDigest,
      authorizationId: rollout.authority.authorizationId,
      externalGateEvidenceId: rollout.authority.gateEvidenceId,
      target: rollout.target,
      revision: {
        sourceRevision: releaseIntent.sourceRevision,
        imageDigest: releaseIntent.artifacts.imageDigests[0]!,
      },
      configurationBindingGeneration: releaseIntent.configurationBindingGeneration,
      bindingGeneration: rollout.authority.bindingGeneration,
      providerDeploymentId: canary.acceptance.providerDeploymentId,
      rolloutCohort: rollout.approvedCohort,
      priorState: rollout.priorState,
      actions: rollout.actions.map((action) => ({
        ...action.acceptance!,
        observedAt: action.observation!.evidence.observedAt,
        providerStatus: action.observation!.evidence.providerStatus,
        providerOutcome: action.observation!.evidence.providerOutcome,
      })),
      health: {
        outcome: rolledBack ? 'unhealthy' : 'healthy',
        evaluation,
      },
      rollback: rolledBack ? {
        owner: releaseIntent.rollback.owner,
        procedure: releaseIntent.rollback.procedure,
        providerDeploymentId: rollback!.acceptance!.providerDeploymentId,
        restoredRevision: rollout.priorState.revision,
        healthVerified: true,
        completedAt: rollback!.observation!.evidence.observedAt,
      } : null,
      lease: {
        leaseId: canary.acceptance.leaseId,
        revoked: true,
        revokedAt: canary.revocation.revokedAt,
      },
      revokedLeases: rollout.actions.map((action) => action.revocation!),
      settledAt,
    });
    return ProductionDeploymentResultSchema.parse({
      status: 'settled',
      receipt: await this.rollouts.settle(receipt),
    });
  }

  private async waitForAuthorization(
    request: ProductionDeploymentRequest,
    reason: ProductionAuthorizationWaitReason,
  ): Promise<ProductionDeploymentResult> {
    await this.store.markWaitingForAuthorization(request, reason);
    return ProductionDeploymentResultSchema.parse({
      status: 'waiting_for_authorization',
      operationId: request.operationId,
      reason,
    });
  }

  private async waitForWindow(
    request: ProductionDeploymentRequest,
    reason: 'window_not_started' | 'window_closed',
    window: OperationIntentProjection['releaseIntent']['changeWindow'],
  ): Promise<ProductionDeploymentResult> {
    await this.store.markWaitingForChangeWindow(request, reason);
    return ProductionDeploymentResultSchema.parse({
      status: 'waiting_for_change_window',
      operationId: request.operationId,
      reason,
      startsAt: window.startsAt,
      endsAt: window.endsAt,
    });
  }
}
