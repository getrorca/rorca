/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { canonicalTransaction, query, queryOne } from '../db/index';
import { ConflictError, ForbiddenError, NotFoundError } from './errors';
import {
  HttpRuntimeSecretBindingAdapter,
  RuntimeSecretBindingStateSchema,
  type RuntimeSecretBindingAdapter,
  type RuntimeSecretBindingState,
} from './stripe-runtime-binding-adapter';
import {
  StripeCredentialStatusReceiptSchema,
  StripeOldKeyRejectionReceiptSchema,
  StripeTestModeCredentialCanaryAdapter,
  type StripeCredentialOperationInput,
  type StripeCredentialStatusReader,
  type StripeOldKeyRejectionReceipt,
} from './stripe-credential-canary';
import {
  StripeSecureCaptureResultSchema,
  type StripeSecureCaptureResult,
} from './stripe-credential-capture';
import {
  StripeAuthorityProviderAdapter,
  StripeProviderBindingSchema,
  type StripeProviderBinding,
} from './stripe-authority-provider-adapter';
import {
  StripeRotationIntentSchema,
  type StripeRotationIntent,
} from './stripe-credential-rotation';
import { stableWalJson } from './trusted-wal';

const FingerprintSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const SafeReferenceSchema = z.string().trim().min(1).max(2048).refine(
  (value) => !/(?:sk|rk)_(?:test|live)_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{8,}/.test(value),
  { message: 'Credential-shaped values are forbidden in Stripe failure evidence' },
);
const FailurePhaseSchema = z.enum([
  'TARGET_STAGE',
  'CANARY',
  'PRE_REVOCATION_VERIFICATION',
]);
const FailureCodeSchema = z.enum([
  'RUNTIME_TARGET_OPERATION_FAILED',
  'STRIPE_CANARY_FAILED',
  'POST_CUTOVER_VERIFICATION_FAILED',
]);

export const StripeFailureCutoverSnapshotSchema = z.object({
  intentId: z.string().uuid(),
  intentDigest: FingerprintSchema,
  workspaceId: z.string().trim().min(1).max(255),
  bindingId: z.string().uuid(),
  replacementBindingId: z.string().uuid(),
  targetBindingReference: SafeReferenceSchema,
  priorFingerprint: FingerprintSchema,
  replacementFingerprint: FingerprintSchema,
  state: z.enum(['READY_FOR_STAGING', 'GRACE_PERIOD', 'WAITING_FOR_REVOCATION']),
}).strict();
export type StripeFailureCutoverSnapshot = z.infer<typeof StripeFailureCutoverSnapshotSchema>;

const ManualReconciliationSchema = z.object({
  reasonCode: z.enum([
    'prior_provider_status_unresolved',
    'replacement_provider_status_unresolved',
    'prior_provider_rejected',
    'runtime_target_status_unresolved',
    'runtime_restore_unverified',
    'runtime_target_unhealthy',
  ]),
  requiredActions: z.tuple([
    z.literal('inspect_exact_provider_fingerprints'),
    z.literal('inspect_exact_runtime_target_binding'),
    z.literal('reauthenticate_in_stripe_dashboard'),
  ]),
}).strict();

export const StripeRollbackReceiptSchema = z.object({
  schemaVersion: z.literal('rorca.stripe-rollback-receipt.v1'),
  receiptId: z.string().uuid(),
  intentId: z.string().uuid(),
  intentDigest: FingerprintSchema,
  workspaceId: z.string().trim().min(1).max(255),
  bindingId: z.string().uuid(),
  replacementBindingId: z.string().uuid(),
  mode: z.literal('test'),
  targetBindingReference: SafeReferenceSchema,
  priorFingerprint: FingerprintSchema,
  replacementFingerprint: FingerprintSchema,
  failurePhase: FailurePhaseSchema,
  failureCode: FailureCodeSchema,
  disposition: z.enum(['ROLLED_BACK', 'MANUAL_RECONCILIATION']),
  priorBindingStatus: z.enum(['retained_active', 'manual_reconciliation']),
  replacementSecretStatus: z.literal('quarantined'),
  targetDisposition: z.enum([
    'prior_already_active',
    'prior_restored',
    'manual_reconciliation',
  ]),
  priorProviderStatus: StripeCredentialStatusReceiptSchema,
  replacementProviderStatus: StripeCredentialStatusReceiptSchema,
  targetReadback: RuntimeSecretBindingStateSchema.nullable(),
  manualReconciliation: ManualReconciliationSchema.nullable(),
  settledAt: z.string().datetime({ offset: true }),
}).strict().superRefine((receipt, context) => {
  const automatic = receipt.disposition === 'ROLLED_BACK';
  if (automatic && (
    receipt.priorBindingStatus !== 'retained_active'
    || receipt.priorProviderStatus.status !== 'active'
    || receipt.replacementProviderStatus.status === 'unknown'
    || receipt.targetDisposition === 'manual_reconciliation'
    || receipt.targetReadback?.activeFingerprint !== receipt.priorFingerprint
    || receipt.targetReadback.health !== 'healthy'
    || receipt.manualReconciliation !== null
  )) {
    context.addIssue({
      code: 'custom',
      path: ['disposition'],
      message: 'Automatic rollback requires verified prior provider and runtime target state',
    });
  }
  if (!automatic && receipt.manualReconciliation === null) {
    context.addIssue({
      code: 'custom',
      path: ['manualReconciliation'],
      message: 'Manual reconciliation requires bounded operator instructions',
    });
  }
});
export type StripeRollbackReceipt = z.infer<typeof StripeRollbackReceiptSchema>;

export const StripeRuntimeAuthenticationFailureSchema = z.object({
  schemaVersion: z.literal('rorca.stripe-runtime-authentication-failure.v1'),
  fingerprint: FingerprintSchema,
  mode: z.literal('test'),
  affectedResource: z.object({
    applicationId: z.string().trim().min(1).max(255),
    resourceType: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/),
    resourceId: z.string().trim().min(1).max(255),
  }).strict(),
  evidence: z.object({
    evidenceType: z.literal('stripe_runtime_authentication_failure'),
    operation: z.string().regex(/^[a-z][a-z0-9._-]{0,127}$/),
    providerHttpStatus: z.literal(401),
    providerRequestReference: SafeReferenceSchema,
    targetBindingReference: SafeReferenceSchema,
    observedAt: z.string().datetime({ offset: true }),
  }).strict(),
}).strict();
export type StripeRuntimeAuthenticationFailure = z.infer<typeof StripeRuntimeAuthenticationFailureSchema>;

const EmergencyAuthoritySchema = z.object({
  canGrant: z.literal(false),
  canBroadenPermissions: z.literal(false),
  canCrossWorkspace: z.literal(false),
  canCrossMode: z.literal(false),
  canInjectSecret: z.literal(false),
  requiresDashboardAuthentication: z.literal(true),
}).strict();

export const StripeEmergencyRotationRequestSchema = z.object({
  schemaVersion: z.literal('rorca.stripe-emergency-rotation-request.v1'),
  requestId: z.string().uuid(),
  requestType: z.literal('RUNTIME_AUTHENTICATION_FAILURE'),
  workspaceId: z.string().trim().min(1).max(255),
  bindingId: z.string().uuid(),
  accountId: z.string().trim().min(1).max(255),
  fingerprint: FingerprintSchema,
  mode: z.literal('test'),
  affectedResource: StripeRuntimeAuthenticationFailureSchema.shape.affectedResource,
  permissionManifest: z.array(z.string().regex(/^[a-z][a-z0-9._-]{0,127}$/)).min(1),
  evidence: StripeRuntimeAuthenticationFailureSchema.shape.evidence,
  state: z.literal('AWAITING_DASHBOARD_AUTHENTICATION'),
  authority: EmergencyAuthoritySchema,
  requestedAt: z.string().datetime({ offset: true }),
}).strict();
export type StripeEmergencyRotationRequest = z.infer<typeof StripeEmergencyRotationRequestSchema>;

export const StripeCredentialStatusReconciliationSchema = z.object({
  schemaVersion: z.literal('rorca.stripe-status-reconciliation-receipt.v1'),
  receiptId: z.string().uuid(),
  intentId: z.string().uuid(),
  intentDigest: FingerprintSchema,
  evidenceDigest: FingerprintSchema,
  workspaceId: z.string().trim().min(1).max(255),
  bindingId: z.string().uuid(),
  replacementBindingId: z.string().uuid(),
  priorFingerprint: FingerprintSchema,
  replacementFingerprint: FingerprintSchema,
  trigger: z.literal('REVOCATION_OUTCOME_UNKNOWN'),
  priorProviderStatus: StripeCredentialStatusReceiptSchema,
  replacementProviderStatus: StripeCredentialStatusReceiptSchema,
  disposition: z.enum(['PROVIDER_READBACK_RESOLVED', 'MANUAL_RECONCILIATION']),
  retryAllowed: z.boolean(),
  requiredDashboardAuthentication: z.literal(true),
  reconciledAt: z.string().datetime({ offset: true }),
}).strict().superRefine((receipt, context) => {
  const hasUnknown = receipt.priorProviderStatus.status === 'unknown'
    || receipt.replacementProviderStatus.status === 'unknown';
  if (hasUnknown !== (receipt.disposition === 'MANUAL_RECONCILIATION')
      || receipt.retryAllowed !== !hasUnknown) {
    context.addIssue({
      code: 'custom',
      path: ['disposition'],
      message: 'Unknown provider status must block retry for manual reconciliation',
    });
  }
});
export type StripeCredentialStatusReconciliation = z.infer<
  typeof StripeCredentialStatusReconciliationSchema
>;

const RollbackIncidentSchema = z.object({
  kind: z.literal('rollback'),
  receipt: StripeRollbackReceiptSchema,
}).strict();
const EmergencyIncidentSchema = z.object({
  kind: z.literal('emergency'),
  request: StripeEmergencyRotationRequestSchema,
}).strict();
const ReconciliationIncidentSchema = z.object({
  kind: z.literal('reconciliation'),
  receipt: StripeCredentialStatusReconciliationSchema,
}).strict();
export const StripeCredentialIncidentSchema = z.discriminatedUnion('kind', [
  RollbackIncidentSchema,
  EmergencyIncidentSchema,
  ReconciliationIncidentSchema,
]);
export type StripeCredentialIncident = z.infer<typeof StripeCredentialIncidentSchema>;

interface PayloadRow {
  payload: unknown;
}

async function selectRollback(
  client: PoolClient,
  workspaceId: string,
  intentId: string,
): Promise<StripeRollbackReceipt | null> {
  const result = await client.query<PayloadRow>(
    `SELECT receipt_payload AS payload
       FROM provider_credential_rotation_rollbacks
      WHERE workspace_id = $1 AND rotation_intent_id = $2`,
    [workspaceId, intentId],
  );
  return result.rows[0] ? StripeRollbackReceiptSchema.parse(result.rows[0].payload) : null;
}

export interface StripeCredentialFailureRepository {
  getRollback(workspaceId: string, intentId: string): Promise<StripeRollbackReceipt | null>;
  settleRollback(input: {
    receipt: StripeRollbackReceipt;
    replacementSecretReference: string;
  }): Promise<StripeRollbackReceipt>;
  createEmergency(request: StripeEmergencyRotationRequest): Promise<StripeEmergencyRotationRequest>;
  createReconciliation(
    receipt: StripeCredentialStatusReconciliation,
  ): Promise<StripeCredentialStatusReconciliation>;
  getReconciliation(
    workspaceId: string,
    intentId: string,
    evidenceDigest: string,
  ): Promise<StripeCredentialStatusReconciliation | null>;
  listIncidents(workspaceId: string, limit: number): Promise<StripeCredentialIncident[]>;
}

export class PostgresStripeCredentialFailureRepository implements StripeCredentialFailureRepository {
  async getRollback(workspaceId: string, intentId: string): Promise<StripeRollbackReceipt | null> {
    const row = await queryOne<PayloadRow>(
      `SELECT receipt_payload AS payload
         FROM provider_credential_rotation_rollbacks
        WHERE workspace_id = $1 AND rotation_intent_id = $2`,
      [workspaceId, intentId],
    );
    return row ? StripeRollbackReceiptSchema.parse(row.payload) : null;
  }
  async getReconciliation(
    workspaceId: string,
    intentId: string,
    evidenceDigest: string,
  ): Promise<StripeCredentialStatusReconciliation | null> {
    const digest = FingerprintSchema.parse(evidenceDigest);
    const row = await queryOne<PayloadRow>(
      `SELECT receipt_payload AS payload
         FROM provider_credential_status_reconciliations
        WHERE workspace_id = $1 AND rotation_intent_id = $2 AND evidence_digest = $3`,
      [workspaceId, intentId, digest],
    );
    return row ? StripeCredentialStatusReconciliationSchema.parse(row.payload) : null;
  }

  async settleRollback(input: {
    receipt: StripeRollbackReceipt;
    replacementSecretReference: string;
  }): Promise<StripeRollbackReceipt> {
    const receipt = StripeRollbackReceiptSchema.parse(input.receipt);
    const secretReference = SafeReferenceSchema.parse(input.replacementSecretReference);

    const secretId = secretReference.slice(secretReference.lastIndexOf('/') + 1);
    if (!z.string().uuid().safeParse(secretId).success) {
      throw new ConflictError('Stripe rollback replacement SecretStore reference is invalid');
    }

    return canonicalTransaction(async (client) => {
      const existing = await selectRollback(client, receipt.workspaceId, receipt.intentId);
      if (existing) {
        if (stableWalJson(existing) !== stableWalJson(receipt)) {
          throw new ConflictError('Stripe rollback replay does not match the immutable receipt');
        }
        return existing;
      }

      const cutover = await client.query(
        `SELECT 1
           FROM provider_credential_rotation_cutovers
          WHERE rotation_intent_id = $1 AND workspace_id = $2
            AND binding_id = $3 AND replacement_binding_id = $4
            AND intent_digest = $5 AND prior_fingerprint = $6
            AND replacement_fingerprint = $7
            AND target_binding_reference = $8
            AND state IN ('READY_FOR_STAGING', 'GRACE_PERIOD')
          FOR UPDATE`,
        [receipt.intentId, receipt.workspaceId, receipt.bindingId,
          receipt.replacementBindingId, receipt.intentDigest, receipt.priorFingerprint,
          receipt.replacementFingerprint, receipt.targetBindingReference],
      );
      if (cutover.rowCount !== 1) {
        throw new ConflictError('Stripe rollback no longer matches a pre-revocation cutover');
      }

      const prior = await client.query(
        `SELECT 1
           FROM provider_credential_bindings
          WHERE id = $1 AND workspace_id = $2 AND provider = 'stripe'
            AND mode = 'test' AND fingerprint = $3 AND status = 'active'
          FOR UPDATE`,
        [receipt.bindingId, receipt.workspaceId, receipt.priorFingerprint],
      );
      if (prior.rowCount !== 1) {
        throw new ConflictError('Stripe prior binding is not retained active during rollback settlement');
      }

      const quarantined = await client.query(
        `UPDATE provider_credential_secret_objects
            SET status = 'quarantined'
          WHERE id = $1 AND rotation_intent_id = $2 AND fingerprint = $3
            AND status IN ('captured', 'quarantined')`,
        [secretId, receipt.intentId, receipt.replacementFingerprint],
      );
      if (quarantined.rowCount !== 1) {
        throw new ConflictError('Stripe replacement SecretStore object could not be quarantined');
      }

      await client.query(
        `INSERT INTO provider_credential_rotation_rollbacks (
           receipt_id, rotation_intent_id, workspace_id, provider, binding_id,
           replacement_binding_id, intent_digest, prior_fingerprint,
           replacement_fingerprint, target_binding_reference, disposition,
           receipt_payload, settled_at
         ) VALUES ($1,$2,$3,'stripe',$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)`,
        [receipt.receiptId, receipt.intentId, receipt.workspaceId, receipt.bindingId,
          receipt.replacementBindingId, receipt.intentDigest, receipt.priorFingerprint,
          receipt.replacementFingerprint, receipt.targetBindingReference,
          receipt.disposition, JSON.stringify(receipt), receipt.settledAt],
      );
      await client.query(
        `INSERT INTO wal_events (event_type, workspace_id, payload)
         VALUES ('provider_credential_rotation_rolled_back', $1, $2::jsonb)`,
        [receipt.workspaceId, JSON.stringify({
          schemaVersion: 'rorca.provider-credential-failure-wal.v1',
          event: 'rotation_rolled_back',
          receipt,
        })],
      );
      return receipt;
    });
  }

  async createEmergency(
    requestInput: StripeEmergencyRotationRequest,
  ): Promise<StripeEmergencyRotationRequest> {
    const request = StripeEmergencyRotationRequestSchema.parse(requestInput);
    return canonicalTransaction(async (client) => {
      const binding = await client.query(
        `SELECT 1
           FROM provider_credential_bindings
          WHERE id = $1 AND workspace_id = $2 AND provider = 'stripe'
            AND mode = $3 AND fingerprint = $4 AND status = 'active'
          FOR UPDATE`,
        [request.bindingId, request.workspaceId, request.mode, request.fingerprint],
      );
      if (binding.rowCount !== 1) {
        throw new ConflictError('Runtime authentication failure no longer matches the active binding');
      }
      const inserted = await client.query<PayloadRow>(
        `INSERT INTO provider_credential_emergency_requests (
           request_id, workspace_id, provider, binding_id, fingerprint, mode,
           evidence_reference, state, request_payload, requested_at
         ) VALUES ($1,$2,'stripe',$3,$4,$5,$6,$7,$8::jsonb,$9)
         ON CONFLICT (provider, evidence_reference) DO NOTHING
         RETURNING request_payload AS payload`,
        [request.requestId, request.workspaceId, request.bindingId, request.fingerprint,
          request.mode, request.evidence.providerRequestReference, request.state,
          JSON.stringify(request), request.requestedAt],
      );
      if (inserted.rows[0]) {
        await client.query(
          `INSERT INTO wal_events (event_type, workspace_id, payload)
           VALUES ('provider_credential_emergency_requested', $1, $2::jsonb)`,
          [request.workspaceId, JSON.stringify({
            schemaVersion: 'rorca.provider-credential-failure-wal.v1',
            event: 'emergency_requested',
            request,
          })],
        );
        return StripeEmergencyRotationRequestSchema.parse(inserted.rows[0].payload);
      }
      const existing = await client.query<PayloadRow>(
        `SELECT request_payload AS payload
           FROM provider_credential_emergency_requests
          WHERE provider = 'stripe' AND evidence_reference = $1`,
        [request.evidence.providerRequestReference],
      );
      if (!existing.rows[0]) {
        throw new ConflictError('Stripe emergency request replay could not recover its receipt');
      }
      const projected = StripeEmergencyRotationRequestSchema.parse(existing.rows[0].payload);
      const replayIdentity = {
        ...request,
        requestId: projected.requestId,
        requestedAt: projected.requestedAt,
      };
      if (stableWalJson(projected) !== stableWalJson(replayIdentity)) {
        throw new ConflictError('Stripe emergency evidence was already bound to another request');
      }
      return projected;
    });
  }

  async createReconciliation(
    receiptInput: StripeCredentialStatusReconciliation,
  ): Promise<StripeCredentialStatusReconciliation> {
    const receipt = StripeCredentialStatusReconciliationSchema.parse(receiptInput);
    return canonicalTransaction(async (client) => {
      const inserted = await client.query<PayloadRow>(
        `INSERT INTO provider_credential_status_reconciliations (
           receipt_id, rotation_intent_id, workspace_id, provider, binding_id,
           evidence_digest, disposition, retry_allowed, receipt_payload, reconciled_at
         ) VALUES ($1,$2,$3,'stripe',$4,$5,$6,$7,$8::jsonb,$9)
         ON CONFLICT (rotation_intent_id, evidence_digest) DO NOTHING
         RETURNING receipt_payload AS payload`,
        [receipt.receiptId, receipt.intentId, receipt.workspaceId, receipt.bindingId,
          receipt.evidenceDigest, receipt.disposition, receipt.retryAllowed,
          JSON.stringify(receipt), receipt.reconciledAt],
      );
      if (inserted.rows[0]) {
        await client.query(
          `INSERT INTO wal_events (event_type, workspace_id, payload)
           VALUES ('provider_credential_status_reconciled', $1, $2::jsonb)`,
          [receipt.workspaceId, JSON.stringify({
            schemaVersion: 'rorca.provider-credential-failure-wal.v1',
            event: 'status_reconciled',
            receipt,
          })],
        );
        return StripeCredentialStatusReconciliationSchema.parse(inserted.rows[0].payload);
      }
      const existing = await client.query<PayloadRow>(
        `SELECT receipt_payload AS payload
           FROM provider_credential_status_reconciliations
          WHERE rotation_intent_id = $1 AND evidence_digest = $2`,
        [receipt.intentId, receipt.evidenceDigest],
      );
      if (!existing.rows[0]) {
        throw new ConflictError('Stripe status reconciliation replay could not recover its receipt');
      }
      return StripeCredentialStatusReconciliationSchema.parse(existing.rows[0].payload);
    });
  }

  async listIncidents(workspaceId: string, limit: number): Promise<StripeCredentialIncident[]> {
    const boundedLimit = z.number().int().min(1).max(250).parse(limit);
    const rows = await query<{ kind: 'rollback' | 'emergency' | 'reconciliation'; payload: unknown }>(
      `SELECT kind, payload
         FROM (
           SELECT 'rollback'::TEXT AS kind, receipt_payload AS payload, settled_at AS occurred_at
             FROM provider_credential_rotation_rollbacks WHERE workspace_id = $1
           UNION ALL
           SELECT 'emergency'::TEXT, request_payload, requested_at
             FROM provider_credential_emergency_requests WHERE workspace_id = $1
           UNION ALL
           SELECT 'reconciliation'::TEXT, receipt_payload, reconciled_at
             FROM provider_credential_status_reconciliations WHERE workspace_id = $1
         ) incidents
        ORDER BY occurred_at DESC
        LIMIT $2`,
      [workspaceId, boundedLimit],
    );
    return rows.map((row) => StripeCredentialIncidentSchema.parse(
      row.kind === 'emergency'
        ? { kind: row.kind, request: row.payload }
        : { kind: row.kind, receipt: row.payload },
    ));
  }
}

function assertRollbackIdentity(input: {
  intent: StripeRotationIntent;
  cutover: StripeFailureCutoverSnapshot;
  priorBinding: StripeProviderBinding;
  capture: StripeSecureCaptureResult;
}): void {
  const { intent, cutover, priorBinding, capture } = input;
  if (intent.mode !== 'test'
      || priorBinding.mode !== 'test'
      || intent.workspaceId !== cutover.workspaceId
      || intent.workspaceId !== priorBinding.workspaceId
      || intent.bindingId !== cutover.bindingId
      || intent.bindingId !== priorBinding.bindingId
      || intent.intentId !== cutover.intentId
      || intent.intentDigest !== cutover.intentDigest
      || intent.currentFingerprint !== cutover.priorFingerprint
      || intent.currentFingerprint !== priorBinding.fingerprint
      || capture.fingerprint !== cutover.replacementFingerprint
      || intent.targetBindingReference !== cutover.targetBindingReference
      || intent.targetBindingReference !== priorBinding.targetBindingReference) {
    throw new ForbiddenError('Stripe rollback does not match the immutable test-mode authority target');
  }
  if (priorBinding.status !== 'active') {
    throw new ConflictError('Stripe rollback requires the retained prior binding to remain active');
  }
}

function runtimeInspectInput(intent: StripeRotationIntent) {
  return {
    workspaceId: intent.workspaceId,
    provider: 'stripe' as const,
    accountId: intent.accountId,
    mode: 'test' as const,
    targetBindingReference: intent.targetBindingReference,
    timeoutMs: intent.rollback.verificationTimeoutMs,
  };
}

function credentialOperationInput(
  intent: StripeRotationIntent,
  secretStoreReference: string,
  expectedFingerprint: string,
): StripeCredentialOperationInput {
  return {
    workspaceId: intent.workspaceId,
    accountId: intent.accountId,
    mode: 'test',
    secretStoreReference,
    expectedFingerprint,
    permissionManifest: intent.permissionManifest,
    canary: intent.canary,
  };
}

function manualRollbackReason(input: {
  priorStatus: z.infer<typeof StripeCredentialStatusReceiptSchema>;
  replacementStatus: z.infer<typeof StripeCredentialStatusReceiptSchema>;
  target: RuntimeSecretBindingState | null;
  priorFingerprint: string;
  restoreAttempted: boolean;
}): z.infer<typeof ManualReconciliationSchema>['reasonCode'] | null {
  if (input.priorStatus.status === 'unknown') return 'prior_provider_status_unresolved';
  if (input.replacementStatus.status === 'unknown') return 'replacement_provider_status_unresolved';
  if (input.priorStatus.status === 'rejected') return 'prior_provider_rejected';
  if (!input.target) return 'runtime_target_status_unresolved';
  if (input.target.health !== 'healthy') return 'runtime_target_unhealthy';
  if (input.target.activeFingerprint !== input.priorFingerprint) {
    return input.restoreAttempted ? 'runtime_restore_unverified' : 'runtime_target_status_unresolved';
  }
  return null;
}

export class StripeCredentialFailureService {
  constructor(
    private readonly stripeAdapter = new StripeAuthorityProviderAdapter(),
    private readonly repository: StripeCredentialFailureRepository = new PostgresStripeCredentialFailureRepository(),
    private readonly runtimeBinding: RuntimeSecretBindingAdapter = new HttpRuntimeSecretBindingAdapter(),
    private readonly statusReader: StripeCredentialStatusReader = new StripeTestModeCredentialCanaryAdapter(),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async getRollback(workspaceId: string, intentId: string): Promise<StripeRollbackReceipt | null> {
    return this.repository.getRollback(workspaceId, intentId);
  }

  async rollbackPreRevocation(input: {
    intent: StripeRotationIntent;
    cutover: StripeFailureCutoverSnapshot;
    priorBinding: StripeProviderBinding;
    capture: StripeSecureCaptureResult;
    failurePhase: z.infer<typeof FailurePhaseSchema>;
    failureCode: z.infer<typeof FailureCodeSchema>;
    now?: Date;
  }): Promise<StripeRollbackReceipt> {
    const intent = StripeRotationIntentSchema.parse(input.intent);
    const cutover = StripeFailureCutoverSnapshotSchema.parse(input.cutover);
    const priorBinding = StripeProviderBindingSchema.parse(input.priorBinding);
    const capture = StripeSecureCaptureResultSchema.parse(input.capture);
    const failurePhase = FailurePhaseSchema.parse(input.failurePhase);
    const failureCode = FailureCodeSchema.parse(input.failureCode);
    assertRollbackIdentity({ intent, cutover, priorBinding, capture });
    if (cutover.state === 'WAITING_FOR_REVOCATION') {
      throw new ConflictError('Stripe rollback is forbidden after the revocation ceremony begins');
    }

    const existing = await this.repository.getRollback(intent.workspaceId, intent.intentId);
    if (existing) return existing;

    const [priorProviderStatus, replacementProviderStatus] = await Promise.all([
      this.statusReader.readStatus(credentialOperationInput(
        intent,
        priorBinding.secretStoreReference,
        priorBinding.fingerprint,
      ), input.now),
      this.statusReader.readStatus(credentialOperationInput(
        intent,
        capture.reference,
        capture.fingerprint,
      ), input.now),
    ]);

    const inspectInput = runtimeInspectInput(intent);
    let targetReadback: RuntimeSecretBindingState | null = null;
    try {
      targetReadback = RuntimeSecretBindingStateSchema.parse(
        await this.runtimeBinding.inspect(inspectInput),
      );
    } catch {
      targetReadback = null;
    }

    let restoreAttempted = false;
    let targetDisposition: StripeRollbackReceipt['targetDisposition'] = 'manual_reconciliation';
    if (targetReadback?.activeFingerprint === intent.currentFingerprint
        && targetReadback.health === 'healthy') {
      targetDisposition = 'prior_already_active';
    } else if (targetReadback?.activeFingerprint === capture.fingerprint
        && priorProviderStatus.status === 'active') {
      restoreAttempted = true;
      try {
        targetReadback = RuntimeSecretBindingStateSchema.parse(await this.runtimeBinding.restore({
          ...inspectInput,
          idempotencyKey: randomUUID(),
          expectedActiveFingerprint: capture.fingerprint,
          retainedPriorFingerprint: intent.currentFingerprint,
        }));
      } catch {
        try {
          targetReadback = RuntimeSecretBindingStateSchema.parse(
            await this.runtimeBinding.inspect(inspectInput),
          );
        } catch {
          targetReadback = null;
        }
      }
      if (targetReadback?.activeFingerprint === intent.currentFingerprint
          && targetReadback.health === 'healthy') {
        targetDisposition = 'prior_restored';
      }
    }

    const manualReason = manualRollbackReason({
      priorStatus: priorProviderStatus,
      replacementStatus: replacementProviderStatus,
      target: targetReadback,
      priorFingerprint: intent.currentFingerprint,
      restoreAttempted,
    });
    const disposition = manualReason === null ? 'ROLLED_BACK' : 'MANUAL_RECONCILIATION';
    const receipt = StripeRollbackReceiptSchema.parse({
      schemaVersion: 'rorca.stripe-rollback-receipt.v1',
      receiptId: randomUUID(),
      intentId: intent.intentId,
      intentDigest: intent.intentDigest,
      workspaceId: intent.workspaceId,
      bindingId: intent.bindingId,
      replacementBindingId: cutover.replacementBindingId,
      mode: 'test',
      targetBindingReference: intent.targetBindingReference,
      priorFingerprint: intent.currentFingerprint,
      replacementFingerprint: capture.fingerprint,
      failurePhase,
      failureCode,
      disposition,
      priorBindingStatus: disposition === 'ROLLED_BACK' ? 'retained_active' : 'manual_reconciliation',
      replacementSecretStatus: 'quarantined',
      targetDisposition: disposition === 'ROLLED_BACK' ? targetDisposition : 'manual_reconciliation',
      priorProviderStatus,
      replacementProviderStatus,
      targetReadback,
      manualReconciliation: manualReason === null ? null : {
        reasonCode: manualReason,
        requiredActions: [
          'inspect_exact_provider_fingerprints',
          'inspect_exact_runtime_target_binding',
          'reauthenticate_in_stripe_dashboard',
        ],
      },
      settledAt: (input.now ?? this.clock()).toISOString(),
    });
    return this.repository.settleRollback({
      receipt,
      replacementSecretReference: capture.reference,
    });
  }

  async createEmergencyRequest(input: {
    workspaceId: string;
    bindingId: string;
    failure: StripeRuntimeAuthenticationFailure;
    now?: Date;
  }): Promise<StripeEmergencyRotationRequest> {
    const failure = StripeRuntimeAuthenticationFailureSchema.parse(input.failure);
    const binding = (await this.stripeAdapter.inventory(input.workspaceId))
      .find((candidate) => candidate.bindingId === input.bindingId);
    if (!binding) throw new NotFoundError('Stripe provider binding', input.bindingId);
    if (binding.workspaceId !== input.workspaceId
        || binding.mode !== failure.mode
        || binding.fingerprint !== failure.fingerprint
        || binding.status !== 'active'
        || binding.credentialClass !== 'restricted_api_key'
        || binding.scope.applicationId !== failure.affectedResource.applicationId
        || binding.scope.resourceType !== failure.affectedResource.resourceType
        || binding.scope.resourceId !== failure.affectedResource.resourceId
        || binding.targetBindingReference !== failure.evidence.targetBindingReference) {
      throw new ForbiddenError('Runtime authentication evidence does not match the exact active Stripe binding');
    }
    if (!binding.permissionManifest.includes(failure.evidence.operation)) {
      throw new ForbiddenError('Runtime authentication evidence is outside the binding permission manifest');
    }

    return this.repository.createEmergency(StripeEmergencyRotationRequestSchema.parse({
      schemaVersion: 'rorca.stripe-emergency-rotation-request.v1',
      requestId: randomUUID(),
      requestType: 'RUNTIME_AUTHENTICATION_FAILURE',
      workspaceId: binding.workspaceId,
      bindingId: binding.bindingId,
      accountId: binding.accountId,
      fingerprint: binding.fingerprint,
      mode: 'test',
      affectedResource: binding.scope,
      permissionManifest: binding.permissionManifest,
      evidence: failure.evidence,
      state: 'AWAITING_DASHBOARD_AUTHENTICATION',
      authority: {
        canGrant: false,
        canBroadenPermissions: false,
        canCrossWorkspace: false,
        canCrossMode: false,
        canInjectSecret: false,
        requiresDashboardAuthentication: true,
      },
      requestedAt: (input.now ?? this.clock()).toISOString(),
    }));
  }
  async getReconciliation(
    workspaceId: string,
    intentId: string,
    evidenceDigest: string,
  ): Promise<StripeCredentialStatusReconciliation | null> {
    return this.repository.getReconciliation(workspaceId, intentId, evidenceDigest);
  }


  async reconcileRevocationOutcome(input: {
    intent: StripeRotationIntent;
    cutover: StripeFailureCutoverSnapshot;
    priorBinding: StripeProviderBinding;
    capture: StripeSecureCaptureResult;
    evidenceDigest: string;
    now?: Date;
  }): Promise<{
    receipt: StripeCredentialStatusReconciliation;
    oldKeyRejection: StripeOldKeyRejectionReceipt | null;
  }> {
    const intent = StripeRotationIntentSchema.parse(input.intent);
    const cutover = StripeFailureCutoverSnapshotSchema.parse(input.cutover);
    const priorBinding = StripeProviderBindingSchema.parse(input.priorBinding);
    const capture = StripeSecureCaptureResultSchema.parse(input.capture);
    const evidenceDigest = FingerprintSchema.parse(input.evidenceDigest);
    assertRollbackIdentity({ intent, cutover, priorBinding, capture });

    const [priorProviderStatus, replacementProviderStatus] = await Promise.all([
      this.statusReader.readStatus(credentialOperationInput(
        intent,
        priorBinding.secretStoreReference,
        priorBinding.fingerprint,
      ), input.now),
      this.statusReader.readStatus(credentialOperationInput(
        intent,
        capture.reference,
        capture.fingerprint,
      ), input.now),
    ]);
    const hasUnknown = priorProviderStatus.status === 'unknown'
      || replacementProviderStatus.status === 'unknown';
    const receipt = await this.repository.createReconciliation(
      StripeCredentialStatusReconciliationSchema.parse({
        schemaVersion: 'rorca.stripe-status-reconciliation-receipt.v1',
        receiptId: randomUUID(),
        intentId: intent.intentId,
        intentDigest: intent.intentDigest,
        evidenceDigest,
        workspaceId: intent.workspaceId,
        bindingId: intent.bindingId,
        replacementBindingId: cutover.replacementBindingId,
        priorFingerprint: intent.currentFingerprint,
        replacementFingerprint: capture.fingerprint,
        trigger: 'REVOCATION_OUTCOME_UNKNOWN',
        priorProviderStatus,
        replacementProviderStatus,
        disposition: hasUnknown ? 'MANUAL_RECONCILIATION' : 'PROVIDER_READBACK_RESOLVED',
        retryAllowed: !hasUnknown,
        requiredDashboardAuthentication: true,
        reconciledAt: (input.now ?? this.clock()).toISOString(),
      }),
    );
    const oldKeyRejection = priorProviderStatus.status === 'rejected'
      && replacementProviderStatus.status === 'active'
      && priorProviderStatus.providerRequestReference
      ? StripeOldKeyRejectionReceiptSchema.parse({
          schemaVersion: 'rorca.stripe-old-key-rejection-receipt.v1',
          mode: 'test',
          operation: priorProviderStatus.operation,
          resourceType: priorProviderStatus.resourceType,
          resourceId: priorProviderStatus.resourceId,
          providerRequestReference: priorProviderStatus.providerRequestReference,
          rejectedAt: priorProviderStatus.observedAt,
          result: 'authentication_rejected',
        })
      : null;
    return { receipt, oldKeyRejection };
  }

  async listIncidents(workspaceId: string, limit = 100): Promise<StripeCredentialIncident[]> {
    return this.repository.listIncidents(workspaceId, limit);
  }
}
