/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Buffer } from 'node:buffer';
import {
  createHash,
  createPublicKey,
  randomUUID,
  verify as verifySignature,
} from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { canonicalTransaction, queryOne, withPgAdvisoryLock } from '../db/index';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from './errors';
import {
  HttpRuntimeSecretBindingAdapter,
  RuntimeSecretBindingStateSchema,
  type RuntimeSecretBindingAdapter,
  type RuntimeSecretBindingState,
} from './stripe-runtime-binding-adapter';
import {
  StripeCanaryReceiptSchema,
  StripeOldKeyRejectionReceiptSchema,
  StripeTestModeCredentialCanaryAdapter,
  type StripeCredentialCanaryAdapter,
  type StripeOldKeyRejectionReceipt,
} from './stripe-credential-canary';
import {
  readConfiguredStripeDashboardEvidenceKeys,
  StripeSecureCaptureResultSchema,
  type StripeDashboardEvidenceKeyBinding,
  type StripeSecureCaptureResult,
} from './stripe-credential-capture';
import {
  StripeCredentialFailureService,
  StripeFailureCutoverSnapshotSchema,
  type StripeFailureCutoverSnapshot,
} from './stripe-credential-failure';
import {
  StripeAuthorityProviderAdapter,
  StripeProviderBindingSchema,
  type StripeProviderBinding,
} from './stripe-authority-provider-adapter';
import { type StripeRotationRecord } from './stripe-credential-rotation-store';
import { StripeRotationIntentSchema, type StripeRotationIntent } from './stripe-credential-rotation';
import { stableWalJson } from './trusted-wal';

export const STRIPE_REVOCATION_EVIDENCE_VERSION = 'rorca.stripe-dashboard-revocation-evidence.v1' as const;
const FingerprintSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const SafeReferenceSchema = z.string().trim().min(1).max(2048).refine(
  (value) => !/(?:sk|rk)_(?:test|live)_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{8,}/.test(value),
  { message: 'Credential-shaped values are forbidden in Stripe cutover metadata' },
);

const CutoverBaseSchema = z.object({
  intentId: z.string().uuid(),
  intentDigest: FingerprintSchema,
  workspaceId: z.string().trim().min(1).max(255),
  bindingId: z.string().uuid(),
  replacementBindingId: z.string().uuid(),
  targetBindingReference: SafeReferenceSchema,
  priorFingerprint: FingerprintSchema,
  replacementFingerprint: FingerprintSchema,
  initializedAt: z.string().datetime({ offset: true }),
});

const PendingCutoverSchema = CutoverBaseSchema.safeExtend({
  priorCredentialStatus: z.literal('active'),
});

export const StripeRevocationCeremonySchema = z.object({
  schemaVersion: z.literal('rorca.stripe-old-key-revocation-ceremony.v1'),
  intentId: z.string().uuid(),
  intentDigest: FingerprintSchema,
  accountId: z.string().trim().min(1).max(255),
  mode: z.literal('test'),
  priorFingerprint: FingerprintSchema,
  state: z.literal('WAITING_FOR_REVOCATION'),
  requiredActions: z.tuple([
    z.literal('reauthenticate_in_stripe_dashboard'),
    z.literal('revoke_exact_prior_restricted_key'),
    z.literal('submit_signed_revocation_evidence'),
  ]),
  prohibitedActions: z.tuple([
    z.literal('submit_secret_to_api_or_model'),
    z.literal('revoke_before_post_cutover_verification'),
    z.literal('bypass_provider_controls'),
  ]),
}).strict();
export type StripeRevocationCeremony = z.infer<typeof StripeRevocationCeremonySchema>;

const StripeGraceFieldsSchema = z.object({
  stagedAt: z.string().datetime({ offset: true }),
  stagedTarget: RuntimeSecretBindingStateSchema,
  canary: StripeCanaryReceiptSchema,
  targetVerifiedAt: z.string().datetime({ offset: true }),
  graceStartedAt: z.string().datetime({ offset: true }),
  graceExpiresAt: z.string().datetime({ offset: true }),
});

const ReadyStateSchema = PendingCutoverSchema.safeExtend({
  state: z.literal('READY_FOR_STAGING'),
}).strict();

const GraceStateSchema = PendingCutoverSchema
  .safeExtend(StripeGraceFieldsSchema.shape)
  .safeExtend({ state: z.literal('GRACE_PERIOD') })
  .strict();

const WaitingStateSchema = GraceStateSchema.omit({ state: true }).safeExtend({
  state: z.literal('WAITING_FOR_REVOCATION'),
  postCutoverCanary: StripeCanaryReceiptSchema,
  postCutoverTarget: RuntimeSecretBindingStateSchema,
  postCutoverVerifiedAt: z.string().datetime({ offset: true }),
  revocationCeremony: StripeRevocationCeremonySchema,
}).strict();

const CompletedStateSchema = WaitingStateSchema.omit({ state: true, priorCredentialStatus: true }).safeExtend({
  state: z.literal('COMPLETED'),
  priorCredentialStatus: z.literal('revoked'),
  revocationEvidenceReference: z.string().regex(/^stripe-dashboard-revocation:\/\/rorca\/[0-9a-f-]{36}$/),
  revocationEvidenceDigest: FingerprintSchema,
  oldKeyRejection: StripeOldKeyRejectionReceiptSchema,
  completedAt: z.string().datetime({ offset: true }),
}).strict();

export const StripeCredentialCutoverStateSchema = z.discriminatedUnion('state', [
  ReadyStateSchema,
  GraceStateSchema,
  WaitingStateSchema,
  CompletedStateSchema,
]);
export type StripeCredentialCutoverState = z.infer<typeof StripeCredentialCutoverStateSchema>;

export const StripeCutoverAdvanceSchema = z.object({
  intentDigest: FingerprintSchema,
}).strict();
export type StripeCutoverAdvance = z.infer<typeof StripeCutoverAdvanceSchema>;

export const StripeDashboardRevocationEvidenceUnsignedSchema = z.object({
  schemaVersion: z.literal(STRIPE_REVOCATION_EVIDENCE_VERSION),
  evidenceId: z.string().uuid(),
  intentDigest: FingerprintSchema,
  workspaceId: z.string().trim().min(1).max(255),
  accountId: z.string().trim().min(1).max(255),
  mode: z.literal('test'),
  priorFingerprint: FingerprintSchema,
  dashboardSessionReference: SafeReferenceSchema,
  dashboardReauthenticatedAt: z.string().datetime({ offset: true }),
  revokedAt: z.string().datetime({ offset: true }),
  operatorId: z.string().trim().min(1).max(255),
  attestationKeyId: z.string().trim().min(1).max(255),
}).strict();
export type StripeDashboardRevocationEvidenceUnsigned = z.infer<typeof StripeDashboardRevocationEvidenceUnsignedSchema>;

export const StripeDashboardRevocationEvidenceSchema = StripeDashboardRevocationEvidenceUnsignedSchema.safeExtend({
  signature: z.string().trim().min(40).max(1024),
}).strict();
export type StripeDashboardRevocationEvidence = z.infer<typeof StripeDashboardRevocationEvidenceSchema>;

function unsignedRevocationEvidence(
  evidence: StripeDashboardRevocationEvidence,
): StripeDashboardRevocationEvidenceUnsigned {
  const { signature: _signature, ...unsigned } = evidence;
  return StripeDashboardRevocationEvidenceUnsignedSchema.parse(unsigned);
}

export function stripeRevocationEvidenceDigest(
  evidenceInput: StripeDashboardRevocationEvidence,
): `sha256:${string}` {
  const evidence = StripeDashboardRevocationEvidenceSchema.parse(evidenceInput);
  return `sha256:${createHash('sha256').update(stableWalJson(evidence), 'utf8').digest('hex')}`;
}

export class StripeDashboardRevocationEvidenceVerifier {
  constructor(
    private readonly readKeyBindings: () => readonly StripeDashboardEvidenceKeyBinding[] = readConfiguredStripeDashboardEvidenceKeys,
  ) {}

  verify(
    evidenceInput: StripeDashboardRevocationEvidence,
    intentInput: StripeRotationIntent,
    stateInput: StripeCredentialCutoverState,
    now = new Date(),
  ): StripeDashboardRevocationEvidence {
    const evidence = StripeDashboardRevocationEvidenceSchema.parse(evidenceInput);
    const intent = StripeRotationIntentSchema.parse(intentInput);
    const state = StripeCredentialCutoverStateSchema.parse(stateInput);
    if (state.state !== 'WAITING_FOR_REVOCATION') {
      throw new ConflictError('Stripe old-key revocation requires completed grace and post-cutover verification');
    }
    if (evidence.intentDigest !== intent.intentDigest
        || evidence.workspaceId !== intent.workspaceId
        || evidence.accountId !== intent.accountId
        || evidence.mode !== intent.mode
        || evidence.priorFingerprint !== state.priorFingerprint) {
      throw new ForbiddenError('Stripe revocation evidence does not match the exact cutover authority');
    }

    const keyBinding = this.readKeyBindings().find((candidate) =>
      candidate.keyId === evidence.attestationKeyId
      && candidate.workspaceId === evidence.workspaceId
      && candidate.accountId === evidence.accountId
      && candidate.operatorIds.includes(evidence.operatorId)
      && candidate.modes.includes(evidence.mode));
    if (!keyBinding) {
      throw new ForbiddenError('Stripe revocation evidence key is not authorized for this operator target');
    }
    let publicKey;
    try {
      publicKey = createPublicKey(keyBinding.publicKeyPem);
    } catch {
      throw new ForbiddenError('Stripe revocation evidence key is invalid');
    }
    if (publicKey.asymmetricKeyType !== 'ed25519') {
      throw new ForbiddenError('Stripe revocation evidence must use an Ed25519 attestation key');
    }
    const signedBytes = Buffer.from(stableWalJson(unsignedRevocationEvidence(evidence)), 'utf8');
    if (!verifySignature(null, signedBytes, publicKey, Buffer.from(evidence.signature, 'base64url'))) {
      throw new ForbiddenError('Stripe revocation evidence signature verification failed');
    }

    const reauthenticatedAt = Date.parse(evidence.dashboardReauthenticatedAt);
    const revokedAt = Date.parse(evidence.revokedAt);
    if (revokedAt < reauthenticatedAt
        || reauthenticatedAt < Date.parse(state.postCutoverVerifiedAt)
        || reauthenticatedAt < now.getTime() - 30 * 60_000
        || revokedAt > now.getTime() + 60_000) {
      throw new ForbiddenError('Stripe revocation evidence is not temporally valid after post-cutover verification');
    }
    return evidence;
  }
}

interface StripeCutoverRow {
  state_payload: unknown;
}

function projectCutover(row: StripeCutoverRow): StripeCredentialCutoverState {
  return StripeCredentialCutoverStateSchema.parse(row.state_payload);
}

function fixedIdentity(state: StripeCredentialCutoverState): Record<string, unknown> {
  return {
    intentId: state.intentId,
    intentDigest: state.intentDigest,
    workspaceId: state.workspaceId,
    bindingId: state.bindingId,
    replacementBindingId: state.replacementBindingId,
    targetBindingReference: state.targetBindingReference,
    priorFingerprint: state.priorFingerprint,
    replacementFingerprint: state.replacementFingerprint,
  };
}

function assertSameCutoverIdentity(
  existing: StripeCredentialCutoverState,
  requested: StripeCredentialCutoverState,
): void {
  if (stableWalJson(fixedIdentity(existing)) !== stableWalJson(fixedIdentity(requested))) {
    throw new ConflictError('Stripe cutover replay does not match the existing replacement binding state');
  }
}

export interface StripeCredentialCutoverRepository {
  get(workspaceId: string, intentId: string): Promise<StripeCredentialCutoverState | null>;
  initialize(state: StripeCredentialCutoverState): Promise<StripeCredentialCutoverState>;
  transition(
    workspaceId: string,
    intentId: string,
    expectedState: StripeCredentialCutoverState['state'],
    next: StripeCredentialCutoverState,
  ): Promise<StripeCredentialCutoverState>;
  complete(input: {
    expectedState: 'WAITING_FOR_REVOCATION';
    state: StripeCredentialCutoverState;
    priorBinding: StripeProviderBinding;
    intent: StripeRotationIntent;
    capture: StripeSecureCaptureResult;
    verifiedAt: Date;
  }): Promise<StripeCredentialCutoverState>;
}

async function selectCutover(
  client: PoolClient,
  workspaceId: string,
  intentId: string,
  lock = false,
): Promise<StripeCutoverRow | null> {
  const result = await client.query<StripeCutoverRow>(
    `SELECT state_payload
       FROM provider_credential_rotation_cutovers
      WHERE workspace_id = $1 AND rotation_intent_id = $2${lock ? ' FOR UPDATE' : ''}`,
    [workspaceId, intentId],
  );
  return result.rows[0] ?? null;
}

export class PostgresStripeCredentialCutoverRepository implements StripeCredentialCutoverRepository {
  async get(workspaceId: string, intentId: string): Promise<StripeCredentialCutoverState | null> {
    const row = await queryOne<StripeCutoverRow>(
      `SELECT state_payload
         FROM provider_credential_rotation_cutovers
        WHERE workspace_id = $1 AND rotation_intent_id = $2`,
      [workspaceId, intentId],
    );
    return row ? projectCutover(row) : null;
  }

  async initialize(stateInput: StripeCredentialCutoverState): Promise<StripeCredentialCutoverState> {
    const state = StripeCredentialCutoverStateSchema.parse(stateInput);
    if (state.state !== 'READY_FOR_STAGING') {
      throw new ConflictError('Stripe cutover must initialize before target staging');
    }
    return canonicalTransaction(async (client) => {
      const inserted = await client.query<StripeCutoverRow>(
        `INSERT INTO provider_credential_rotation_cutovers (
           rotation_intent_id, workspace_id, provider, binding_id,
           replacement_binding_id, intent_digest, target_binding_reference,
           prior_fingerprint, replacement_fingerprint, state,
           state_payload, initialized_at
         ) VALUES ($1,$2,'stripe',$3,$4,$5,$6,$7,$8,'READY_FOR_STAGING',$9::jsonb,$10)
         ON CONFLICT (rotation_intent_id) DO NOTHING
         RETURNING state_payload`,
        [state.intentId, state.workspaceId, state.bindingId, state.replacementBindingId,
          state.intentDigest, state.targetBindingReference, state.priorFingerprint,
          state.replacementFingerprint, JSON.stringify(state), state.initializedAt],
      );
      if (inserted.rows[0]) return projectCutover(inserted.rows[0]);
      const existing = await selectCutover(client, state.workspaceId, state.intentId);
      if (!existing) throw new ConflictError('Stripe cutover replay could not recover its persisted state');
      const projected = projectCutover(existing);
      assertSameCutoverIdentity(projected, state);
      return projected;
    });
  }

  async transition(
    workspaceId: string,
    intentId: string,
    expectedState: StripeCredentialCutoverState['state'],
    nextInput: StripeCredentialCutoverState,
  ): Promise<StripeCredentialCutoverState> {
    const next = StripeCredentialCutoverStateSchema.parse(nextInput);
    if (next.workspaceId !== workspaceId || next.intentId !== intentId) {
      throw new ConflictError('Stripe cutover transition identity is inconsistent');
    }
    return canonicalTransaction(async (client) => {
      const existing = await selectCutover(client, workspaceId, intentId, true);
      if (!existing) throw new NotFoundError('Stripe credential cutover', intentId);
      const current = projectCutover(existing);
      assertSameCutoverIdentity(current, next);
      if (current.state !== expectedState) {
        if (stableWalJson(current) === stableWalJson(next)) return current;
        throw new ConflictError('Stripe cutover transition lost its persisted state claim', {
          expectedState,
          actualState: current.state,
        });
      }
      const updated = await client.query<StripeCutoverRow>(
        `UPDATE provider_credential_rotation_cutovers
            SET state = $3, state_payload = $4::jsonb,
                grace_expires_at = $5, updated_at = clock_timestamp()
          WHERE workspace_id = $1 AND rotation_intent_id = $2 AND state = $6
          RETURNING state_payload`,
        [workspaceId, intentId, next.state, JSON.stringify(next),
          'graceExpiresAt' in next ? next.graceExpiresAt : null, expectedState],
      );
      if (!updated.rows[0]) throw new ConflictError('Stripe cutover transition was not persisted');
      return projectCutover(updated.rows[0]);
    });
  }

  async complete(input: {
    expectedState: 'WAITING_FOR_REVOCATION';
    state: StripeCredentialCutoverState;
    priorBinding: StripeProviderBinding;
    intent: StripeRotationIntent;
    capture: StripeSecureCaptureResult;
    verifiedAt: Date;
  }): Promise<StripeCredentialCutoverState> {
    const next = StripeCredentialCutoverStateSchema.parse(input.state);
    const prior = StripeProviderBindingSchema.parse(input.priorBinding);
    const intent = StripeRotationIntentSchema.parse(input.intent);
    const capture = StripeSecureCaptureResultSchema.parse(input.capture);
    if (next.state !== 'COMPLETED') throw new ConflictError('Stripe settlement requires completed cutover state');

    return canonicalTransaction(async (client) => {
      const existing = await selectCutover(client, next.workspaceId, next.intentId, true);
      if (!existing) throw new NotFoundError('Stripe credential cutover', next.intentId);
      const current = projectCutover(existing);
      assertSameCutoverIdentity(current, next);
      if (current.state === 'COMPLETED') {
        if (current.revocationEvidenceDigest !== next.revocationEvidenceDigest) {
          throw new ConflictError('Stripe revocation replay uses different provider evidence');
        }
        return current;
      }
      if (current.state !== input.expectedState) {
        throw new ConflictError('Stripe credential cutover is not ready for revocation settlement');
      }

      const revoked = await client.query(
        `UPDATE provider_credential_bindings
            SET status = 'revoked', last_verified_at = $4
          WHERE id = $1 AND workspace_id = $2 AND provider = 'stripe'
            AND fingerprint = $3 AND status = 'active'`,
        [prior.bindingId, prior.workspaceId, prior.fingerprint, input.verifiedAt.toISOString()],
      );
      if (revoked.rowCount !== 1) {
        throw new ConflictError('Stripe prior binding changed before verified revocation settlement');
      }

      const inserted = await client.query(
        `INSERT INTO provider_credential_bindings (
           id, workspace_id, provider, provider_account_id, mode,
           application_id, resource_type, resource_id, credential_class,
           key_kind, permission_manifest, owner, fingerprint,
           secret_store_reference, target_binding_reference, status,
           binding_generation, last_verified_at
         ) VALUES ($1,$2,'stripe',$3,'test',$4,$5,$6,'restricted_api_key',
                   'restricted',$7::jsonb,$8,$9,$10,$11,'active',$12,$13)
         ON CONFLICT (id) DO NOTHING`,
        [next.replacementBindingId, prior.workspaceId, prior.accountId,
          prior.scope.applicationId, prior.scope.resourceType, prior.scope.resourceId,
          JSON.stringify(intent.permissionManifest), prior.owner, capture.fingerprint,
          capture.reference, prior.targetBindingReference, prior.generation + 1,
          input.verifiedAt.toISOString()],
      );
      if (inserted.rowCount !== 1) {
        throw new ConflictError('Stripe replacement binding settlement could not be uniquely recorded');
      }

      const secretId = capture.reference.slice(capture.reference.lastIndexOf('/') + 1);
      const activated = await client.query(
        `UPDATE provider_credential_secret_objects
            SET status = 'active'
          WHERE id = $1 AND rotation_intent_id = $2
            AND fingerprint = $3 AND status = 'captured'`,
        [secretId, next.intentId, next.replacementFingerprint],
      );
      if (activated.rowCount !== 1) {
        throw new ConflictError('Stripe replacement SecretStore state could not be activated');
      }

      const updated = await client.query<StripeCutoverRow>(
        `UPDATE provider_credential_rotation_cutovers
            SET state = 'COMPLETED', state_payload = $3::jsonb,
                revocation_evidence_digest = $4,
                revocation_evidence_reference = $5,
                completed_at = $6, updated_at = clock_timestamp()
          WHERE workspace_id = $1 AND rotation_intent_id = $2
            AND state = 'WAITING_FOR_REVOCATION'
          RETURNING state_payload`,
        [next.workspaceId, next.intentId, JSON.stringify(next),
          next.revocationEvidenceDigest, next.revocationEvidenceReference,
          next.completedAt],
      );
      if (!updated.rows[0]) throw new ConflictError('Stripe cutover completion was not persisted');
      return projectCutover(updated.rows[0]);
    });
  }
}

export type StripeRotationRecordReader = (
  workspaceId: string,
  intentId: string,
) => Promise<StripeRotationRecord | null>;

function assertHealthyReplacement(
  stateInput: RuntimeSecretBindingState,
  targetBindingReference: string,
  replacementFingerprint: string,
): RuntimeSecretBindingState {
  const state = RuntimeSecretBindingStateSchema.parse(stateInput);
  if (state.targetBindingReference !== targetBindingReference
      || state.activeFingerprint !== replacementFingerprint
      || state.health !== 'healthy') {
    throw new ConflictError('Runtime target has not verified the exact healthy Stripe replacement binding');
  }
  return state;
}

function revocationCeremony(intent: StripeRotationIntent): StripeRevocationCeremony {
  return StripeRevocationCeremonySchema.parse({
    schemaVersion: 'rorca.stripe-old-key-revocation-ceremony.v1',
    intentId: intent.intentId,
    intentDigest: intent.intentDigest,
    accountId: intent.accountId,
    mode: 'test',
    priorFingerprint: intent.currentFingerprint,
    state: 'WAITING_FOR_REVOCATION',
    requiredActions: [
      'reauthenticate_in_stripe_dashboard',
      'revoke_exact_prior_restricted_key',
      'submit_signed_revocation_evidence',
    ],
    prohibitedActions: [
      'submit_secret_to_api_or_model',
      'revoke_before_post_cutover_verification',
      'bypass_provider_controls',
    ],
  });
}

function assertExactOldKeyRejection(
  receiptInput: StripeOldKeyRejectionReceipt,
  intent: StripeRotationIntent,
  evidence: StripeDashboardRevocationEvidence,
  completedAt: Date,
): StripeOldKeyRejectionReceipt {
  const receipt = StripeOldKeyRejectionReceiptSchema.parse(receiptInput);
  if (receipt.operation !== intent.canary.operation
      || receipt.resourceType !== intent.canary.resourceType
      || receipt.resourceId !== intent.canary.resourceId) {
    throw new ConflictError('Stripe old-key rejection did not exercise the exact declared canary operation');
  }
  const rejectedAt = Date.parse(receipt.rejectedAt);
  if (rejectedAt < Date.parse(evidence.revokedAt)
      || rejectedAt > completedAt.getTime() + 60_000) {
    throw new ConflictError('Stripe old-key rejection is not temporally valid after provider revocation');
  }
  return receipt;
}

export type StripeCutoverExclusiveRunner = <T>(
  key: string,
  operation: () => Promise<T>,
) => Promise<T>;
export type StripeCutoverFailureHandler = Pick<
  StripeCredentialFailureService,
  'getRollback' | 'getReconciliation' | 'rollbackPreRevocation' | 'reconcileRevocationOutcome'
>;

export class StripeCredentialCutoverService {
  private readonly failureHandler: StripeCutoverFailureHandler;

  constructor(
    private readonly readRotation: StripeRotationRecordReader,
    private readonly stripeAdapter = new StripeAuthorityProviderAdapter(),
    private readonly repository: StripeCredentialCutoverRepository = new PostgresStripeCredentialCutoverRepository(),
    private readonly runtimeBinding: RuntimeSecretBindingAdapter = new HttpRuntimeSecretBindingAdapter(),
    private readonly canary: StripeCredentialCanaryAdapter = new StripeTestModeCredentialCanaryAdapter(),
    private readonly revocationVerifier = new StripeDashboardRevocationEvidenceVerifier(),
    private readonly runExclusive: StripeCutoverExclusiveRunner = withPgAdvisoryLock,
    private readonly clock: () => Date = () => new Date(),
    failureHandler?: StripeCutoverFailureHandler,
  ) {
    this.failureHandler = failureHandler ?? new StripeCredentialFailureService(this.stripeAdapter);
  }

  async get(workspaceId: string, intentId: string): Promise<StripeCredentialCutoverState | null> {
    return this.repository.get(workspaceId, intentId);
  }

  private async rotation(workspaceId: string, intentId: string, intentDigest: string): Promise<StripeRotationRecord> {
    const record = await this.readRotation(workspaceId, intentId);
    if (!record) throw new NotFoundError('Stripe rotation intent', intentId);
    if (record.intent.intentDigest !== intentDigest) {
      throw new ForbiddenError('Stripe cutover request does not match the immutable intent digest');
    }
    if (record.intent.mode !== 'test') {
      throw new ForbiddenError('Stripe credential cutover is disabled outside test mode');
    }
    if (record.lifecycle.state !== 'READY_FOR_STAGING') {
      throw new ConflictError('Stripe credential cutover requires completed secure capture');
    }
    return record;
  }

  private async priorBinding(intent: StripeRotationIntent): Promise<StripeProviderBinding> {
    const binding = (await this.stripeAdapter.inventory(intent.workspaceId))
      .find((candidate) => candidate.bindingId === intent.bindingId);
    if (!binding) throw new NotFoundError('Stripe provider binding', intent.bindingId);
    return binding;
  }

  private inspectInput(intent: StripeRotationIntent) {
    return {
      workspaceId: intent.workspaceId,
      provider: 'stripe' as const,
      accountId: intent.accountId,
      mode: 'test' as const,
      targetBindingReference: intent.targetBindingReference,
      timeoutMs: intent.rollback.verificationTimeoutMs,
    };
  }

  private operationInput(
    intent: StripeRotationIntent,
    secretStoreReference: string,
    expectedFingerprint: string,
  ) {
    return {
      workspaceId: intent.workspaceId,
      accountId: intent.accountId,
      mode: 'test' as const,
      secretStoreReference,
      expectedFingerprint,
      permissionManifest: intent.permissionManifest,
      canary: intent.canary,
    };
  }

  private failureSnapshot(state: StripeCredentialCutoverState): StripeFailureCutoverSnapshot {
    return StripeFailureCutoverSnapshotSchema.parse({
      intentId: state.intentId,
      intentDigest: state.intentDigest,
      workspaceId: state.workspaceId,
      bindingId: state.bindingId,
      replacementBindingId: state.replacementBindingId,
      targetBindingReference: state.targetBindingReference,
      priorFingerprint: state.priorFingerprint,
      replacementFingerprint: state.replacementFingerprint,
      state: state.state,
    });
  }

  private async rollbackFailure(input: {
    intent: StripeRotationIntent;
    state: StripeCredentialCutoverState;
    prior: StripeProviderBinding;
    capture: StripeSecureCaptureResult;
    failurePhase: 'TARGET_STAGE' | 'CANARY' | 'PRE_REVOCATION_VERIFICATION';
    failureCode:
      | 'RUNTIME_TARGET_OPERATION_FAILED'
      | 'STRIPE_CANARY_FAILED'
      | 'POST_CUTOVER_VERIFICATION_FAILED';
    now?: Date;
  }): Promise<never> {
    const receipt = await this.failureHandler.rollbackPreRevocation({
      intent: input.intent,
      cutover: this.failureSnapshot(input.state),
      priorBinding: input.prior,
      capture: input.capture,
      failurePhase: input.failurePhase,
      failureCode: input.failureCode,
      now: input.now,
    });
    throw new ConflictError(
      receipt.disposition === 'ROLLED_BACK'
        ? 'Stripe cutover failed; the retained prior binding was restored and the replacement quarantined'
        : 'Stripe cutover failed and requires manual credential reconciliation',
      {
        rollbackReceiptId: receipt.receiptId,
        disposition: receipt.disposition,
        priorBindingStatus: receipt.priorBindingStatus,
        replacementSecretStatus: receipt.replacementSecretStatus,
        reconciliationRequired: receipt.disposition === 'MANUAL_RECONCILIATION',
      },
    );
  }

  async advance(input: {
    workspaceId: string;
    intentId: string;
    intentDigest: string;
    now?: Date;
  }): Promise<StripeCredentialCutoverState> {
    return this.runExclusive(
      `stripe-credential-cutover:${input.workspaceId}:${input.intentId}`,
      async () => {
        const record = await this.rotation(input.workspaceId, input.intentId, input.intentDigest);
        const intent = record.intent;
        const capture = StripeSecureCaptureResultSchema.parse(record.lifecycle.capture);
        let state = await this.repository.get(input.workspaceId, input.intentId);
        if (state?.state === 'COMPLETED' || state?.state === 'WAITING_FOR_REVOCATION') return state;
        const settledFailure = await this.failureHandler.getRollback(
          input.workspaceId,
          input.intentId,
        );
        if (settledFailure) {
          throw new ConflictError('Stripe credential cutover is closed by an immutable rollback receipt', {
            rollbackReceiptId: settledFailure.receiptId,
            disposition: settledFailure.disposition,
            reconciliationRequired: settledFailure.disposition === 'MANUAL_RECONCILIATION',
          });
        }
        const prior = await this.priorBinding(intent);
        if (prior.status !== 'active' || prior.fingerprint !== intent.currentFingerprint) {
          throw new ConflictError('Stripe prior credential must remain active until verified revocation');
        }
        const initializedAt = input.now ?? this.clock();
        state ??= await this.repository.initialize(ReadyStateSchema.parse({
          state: 'READY_FOR_STAGING',
          intentId: intent.intentId,
          intentDigest: intent.intentDigest,
          workspaceId: intent.workspaceId,
          bindingId: intent.bindingId,
          replacementBindingId: randomUUID(),
          targetBindingReference: intent.targetBindingReference,
          priorFingerprint: intent.currentFingerprint,
          replacementFingerprint: capture.fingerprint,
          priorCredentialStatus: 'active',
          initializedAt: initializedAt.toISOString(),
        }));

        if (state.state === 'READY_FOR_STAGING') {
          let failurePhase: 'TARGET_STAGE' | 'CANARY' = 'TARGET_STAGE';
          let failureCode:
            | 'RUNTIME_TARGET_OPERATION_FAILED'
            | 'STRIPE_CANARY_FAILED' = 'RUNTIME_TARGET_OPERATION_FAILED';
          try {
            let target = await this.runtimeBinding.inspect(this.inspectInput(intent));
            if (target.activeFingerprint === state.priorFingerprint) {
              target = await this.runtimeBinding.stage({
                ...this.inspectInput(intent),
                idempotencyKey: state.replacementBindingId,
                expectedCurrentFingerprint: state.priorFingerprint,
                replacementFingerprint: state.replacementFingerprint,
                replacementSecretReference: capture.reference,
              });
            } else if (target.activeFingerprint !== state.replacementFingerprint) {
              throw new ConflictError('Runtime target reports an unknown Stripe binding fingerprint');
            }
            const stagedTarget = assertHealthyReplacement(
              target,
              intent.targetBindingReference,
              state.replacementFingerprint,
            );
            failurePhase = 'CANARY';
            failureCode = 'STRIPE_CANARY_FAILED';
            const canary = await this.canary.runCanary(
              this.operationInput(intent, capture.reference, state.replacementFingerprint),
              input.now,
            );
            const verifiedTarget = assertHealthyReplacement(
              await this.runtimeBinding.inspect(this.inspectInput(intent)),
              intent.targetBindingReference,
              state.replacementFingerprint,
            );
            const graceStartedAt = new Date(Math.max(
              (input.now ?? this.clock()).getTime(),
              Date.parse(canary.verifiedAt),
              Date.parse(verifiedTarget.observedAt),
            )).toISOString();
            const graceExpiresAt = new Date(
              Date.parse(graceStartedAt) + intent.gracePeriodSeconds * 1_000,
            ).toISOString();
            return await this.repository.transition(
              input.workspaceId,
              input.intentId,
              'READY_FOR_STAGING',
              GraceStateSchema.parse({
                ...state,
                state: 'GRACE_PERIOD',
                stagedAt: stagedTarget.observedAt,
                stagedTarget,
                canary,
                targetVerifiedAt: verifiedTarget.observedAt,
                graceStartedAt,
                graceExpiresAt,
              }),
            );
          } catch {
            return this.rollbackFailure({
              intent,
              state,
              prior,
              capture,
              failurePhase,
              failureCode,
              now: input.now,
            });
          }
        }

        if (state.state === 'GRACE_PERIOD') {
          const graceCheckAt = input.now ?? this.clock();
          if (graceCheckAt.getTime() < Date.parse(state.graceExpiresAt)) return state;
          try {
            assertHealthyReplacement(
              await this.runtimeBinding.inspect(this.inspectInput(intent)),
              intent.targetBindingReference,
              state.replacementFingerprint,
            );
            const postCutoverCanary = await this.canary.runCanary(
              this.operationInput(intent, capture.reference, state.replacementFingerprint),
              input.now,
            );
            const postCutoverTarget = assertHealthyReplacement(
              await this.runtimeBinding.inspect(this.inspectInput(intent)),
              intent.targetBindingReference,
              state.replacementFingerprint,
            );
            const postCutoverVerifiedAt = new Date(Math.max(
              (input.now ?? this.clock()).getTime(),
              Date.parse(postCutoverCanary.verifiedAt),
              Date.parse(postCutoverTarget.observedAt),
            )).toISOString();
            return await this.repository.transition(
              input.workspaceId,
              input.intentId,
              'GRACE_PERIOD',
              WaitingStateSchema.parse({
                ...state,
                state: 'WAITING_FOR_REVOCATION',
                postCutoverCanary,
                postCutoverTarget,
                postCutoverVerifiedAt,
                revocationCeremony: revocationCeremony(intent),
              }),
            );
          } catch {
            return this.rollbackFailure({
              intent,
              state,
              prior,
              capture,
              failurePhase: 'PRE_REVOCATION_VERIFICATION',
              failureCode: 'POST_CUTOVER_VERIFICATION_FAILED',
              now: input.now,
            });
          }
        }

        return state;
      },
    );
  }

  async completeRevocation(input: {
    workspaceId: string;
    intentId: string;
    intentDigest: string;
    evidence: StripeDashboardRevocationEvidence;
    now?: Date;
  }): Promise<StripeCredentialCutoverState> {
    return this.runExclusive(
      `stripe-credential-cutover:${input.workspaceId}:${input.intentId}`,
      async () => {
        const record = await this.rotation(input.workspaceId, input.intentId, input.intentDigest);
        const state = await this.repository.get(input.workspaceId, input.intentId);
        if (!state) throw new NotFoundError('Stripe credential cutover', input.intentId);
        const evidence = StripeDashboardRevocationEvidenceSchema.parse(input.evidence);
        const evidenceDigest = stripeRevocationEvidenceDigest(evidence);
        if (state.state === 'COMPLETED') {
          if (state.revocationEvidenceDigest !== evidenceDigest) {
            throw new ConflictError('Stripe revocation replay uses different provider evidence');
          }
          return state;
        }
        if (state.state !== 'WAITING_FOR_REVOCATION') {
          throw new ConflictError('Stripe old key cannot be revoked before grace and post-cutover verification');
        }
        const priorReconciliation = await this.failureHandler.getReconciliation(
          input.workspaceId,
          input.intentId,
          evidenceDigest,
        );
        if (priorReconciliation?.disposition === 'MANUAL_RECONCILIATION') {
          throw new ConflictError(
            'Stripe key status requires manual reconciliation before revocation retry',
            {
              reconciliationReceiptId: priorReconciliation.receiptId,
              disposition: priorReconciliation.disposition,
              retryAllowed: false,
            },
          );
        }

        const verificationNow = input.now ?? this.clock();
        this.revocationVerifier.verify(evidence, record.intent, state, verificationNow);
        const prior = await this.priorBinding(record.intent);
        if (prior.status !== 'active' || prior.fingerprint !== state.priorFingerprint) {
          throw new ConflictError('Stripe prior binding changed before old-key rejection verification');
        }
        const capture = StripeSecureCaptureResultSchema.parse(record.lifecycle.capture);
        const completedAt = input.now ?? this.clock();
        let oldKeyRejection: StripeOldKeyRejectionReceipt;
        try {
          assertHealthyReplacement(
            await this.runtimeBinding.inspect(this.inspectInput(record.intent)),
            record.intent.targetBindingReference,
            state.replacementFingerprint,
          );
          oldKeyRejection = assertExactOldKeyRejection(
            await this.runtimeBinding.verifyStripeCredentialRejected({
              ...this.inspectInput(record.intent),
              expectedActiveFingerprint: state.replacementFingerprint,
              retainedPriorFingerprint: state.priorFingerprint,
              permissionManifest: record.intent.permissionManifest,
              canary: record.intent.canary,
            }),
            record.intent,
            evidence,
            completedAt,
          );
        } catch {
          const reconciliation = await this.failureHandler.reconcileRevocationOutcome({
            intent: record.intent,
            cutover: this.failureSnapshot(state),
            priorBinding: prior,
            capture,
            evidenceDigest,
            now: verificationNow,
          });
          if (!reconciliation.oldKeyRejection) {
            throw new ConflictError(
              reconciliation.receipt.disposition === 'MANUAL_RECONCILIATION'
                ? 'Stripe key status is unknown and requires manual reconciliation before retry'
                : 'Stripe provider readback did not verify a healthy replacement and rejected old key',
              {
                reconciliationReceiptId: reconciliation.receipt.receiptId,
                disposition: reconciliation.receipt.disposition,
                retryAllowed: reconciliation.receipt.retryAllowed,
              },
            );
          }
          oldKeyRejection = assertExactOldKeyRejection(
            reconciliation.oldKeyRejection,
            record.intent,
            evidence,
            completedAt,
          );
        }
        const completed = CompletedStateSchema.parse({
          ...state,
          state: 'COMPLETED',
          priorCredentialStatus: 'revoked',
          revocationEvidenceReference: `stripe-dashboard-revocation://rorca/${evidence.evidenceId}`,
          revocationEvidenceDigest: evidenceDigest,
          oldKeyRejection,
          completedAt: completedAt.toISOString(),
        });
        return this.repository.complete({
          expectedState: 'WAITING_FOR_REVOCATION',
          state: completed,
          priorBinding: prior,
          intent: record.intent,
          capture,
          verifiedAt: completedAt,
        });
      },
    );
  }
}
