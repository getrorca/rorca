/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, it } from 'node:test';
import { ConflictError, ForbiddenError } from '../errors';
import {
  StripeAuthorityProviderAdapter,
  StripeProviderBindingSchema,
} from '../stripe-authority-provider-adapter';
import type { StripeProviderBinding } from '../stripe-authority-provider-adapter';
import { StripeTestModeCredentialCanaryAdapter } from '../stripe-credential-canary';
import type {
  StripeCredentialOperationInput,
  StripeCredentialSecretExecutor,
  StripeHttpOperationResult,
  StripeHttpTransport,
} from '../stripe-credential-canary';
import {
  StripeDashboardEvidenceUnsignedSchema,
  StripeDashboardEvidenceVerifier,
  StripeSecureOperatorCapture,
} from '../stripe-credential-capture';
import type {
  StoredStripeCapture,
  StripeCredentialSecretStore,
  StripeDashboardEvidence,
  StripeDashboardEvidenceUnsigned,
  StripeSecureCaptureResult,
} from '../stripe-credential-capture';
import {
  StripeCredentialCutoverService,
  StripeCredentialCutoverStateSchema,
  StripeDashboardRevocationEvidenceUnsignedSchema,
  StripeDashboardRevocationEvidenceVerifier,
} from '../stripe-credential-cutover';
import type {
  StripeCredentialCutoverRepository,
  StripeCredentialCutoverState,
  StripeDashboardRevocationEvidence,
} from '../stripe-credential-cutover';
import { StripeCredentialFailureService } from '../stripe-credential-failure';
import type {
  StripeCredentialFailureRepository,
  StripeCredentialIncident,
  StripeCredentialStatusReconciliation,
  StripeEmergencyRotationRequest,
  StripeRollbackReceipt,
} from '../stripe-credential-failure';
import { stripeRotationIntentDigest } from '../stripe-credential-rotation';
import type {
  StripeRotationApproval,
  StripeRotationIntentInput,
} from '../stripe-credential-rotation';
import {
  resumeStripeRotationRecord,
  StripeCredentialRotationService,
} from '../stripe-credential-rotation-store';
import type {
  StripeRotationIntentRepository,
  StripeRotationRecord,
} from '../stripe-credential-rotation-store';
import {
  RuntimeSecretBindingInspectInputSchema,
  RuntimeSecretBindingRestoreInputSchema,
  RuntimeSecretBindingStageInputSchema,
  RuntimeStripeRejectionVerificationInputSchema,
} from '../runtime-secret-binding-adapter';
import type {
  RuntimeSecretBindingAdapter,
  RuntimeSecretBindingState,
} from '../runtime-secret-binding-adapter';
import { stableWalJson } from '../trusted-wal';

const WORKSPACE_ID = 'workspace-rorca-stripe-qualification';
const FOREIGN_WORKSPACE_ID = 'workspace-rorca-stripe-foreign';
const ACCOUNT_ID = 'acct_rorca_qualification';
const BINDING_ID = 'a1000000-0000-4000-8000-000000000001';
const LIVE_BINDING_ID = 'a1000000-0000-4000-8000-000000000002';
const WEBHOOK_BINDING_ID = 'a1000000-0000-4000-8000-000000000003';
const INTENT_ID = 'a1000000-0000-4000-8000-000000000004';
const APPROVAL_ID = 'a1000000-0000-4000-8000-000000000005';
const CAPTURE_ID = 'a1000000-0000-4000-8000-000000000006';
const CAPTURE_EVIDENCE_ID = 'a1000000-0000-4000-8000-000000000007';
const REVOCATION_EVIDENCE_ID = 'a1000000-0000-4000-8000-000000000008';
const PRIOR_SECRET_REFERENCE = 'secret-store://rorca/provider-credentials/a1000000-0000-4000-8000-000000000009';
const TARGET_REFERENCE = 'runtime-binding://rorca/disposable-stripe-qualification';
const CANARY_RESOURCE_ID = 'pi_rorca_disposable_qualification';
const OPERATOR_ID = 'operator:rorca-stripe-qualification';
const ATTESTATION_KEY_ID = 'rorca-stripe-qualification-attestation';
const CREATED_AT = new Date('2026-08-24T10:00:00.000Z');
const CAPTURED_AT = new Date('2026-08-24T10:05:00.000Z');
const FIRST_CUTOVER_AT = new Date('2026-08-24T10:06:00.000Z');
const AFTER_GRACE_AT = new Date('2026-08-24T10:08:00.000Z');
const REVOKED_AT = new Date('2026-08-24T10:09:00.000Z');
const CREDENTIAL_PATTERN = /(?:sk|rk)_(?:test|live)_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{8,}/;

function credential(label: string): Buffer {
  return Buffer.from(['rk', 'test', `RorcaQualification${label}123456`].join('_'), 'ascii');
}

function fingerprint(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

interface BindingRow {
  id: string;
  workspace_id: string;
  provider_account_id: string;
  mode: 'test' | 'live';
  application_id: string;
  resource_type: string;
  resource_id: string;
  credential_class: 'restricted_api_key' | 'unrestricted_api_key' | 'webhook_signing_secret';
  key_kind: 'restricted' | 'unrestricted' | 'signing_secret';
  permission_manifest: string[];
  owner: string;
  fingerprint: string;
  secret_store_reference: string;
  target_binding_reference: string;
  status: 'active' | 'staged' | 'quarantined' | 'revoked' | 'invalid';
  binding_generation: number;
  last_verified_at: Date | null;
}

function rotationInput(binding: StripeProviderBinding): StripeRotationIntentInput {
  return {
    workspaceId: binding.workspaceId,
    bindingId: binding.bindingId,
    accountId: binding.accountId,
    currentFingerprint: binding.fingerprint,
    permissionManifest: [...binding.permissionManifest],
    mode: binding.mode,
    targetBindingReference: binding.targetBindingReference,
    replacementCredentialClass: 'restricted_api_key',
    canary: {
      operation: 'payment_intents.read',
      resourceType: 'payment_intents',
      resourceId: CANARY_RESOURCE_ID,
      timeoutMs: 10_000,
    },
    gracePeriodSeconds: 60,
    rollback: {
      strategy: 'restore_previous_binding',
      keepPriorCredentialActive: true,
      quarantineReplacement: true,
      verificationTimeoutMs: 10_000,
    },
    humanSteps: {
      dashboardReauthentication: 'required',
      restrictedKeyCreation: 'required',
      mfaAutomation: 'forbidden',
      providerControlBypass: 'forbidden',
    },
  };
}

function approval(input: StripeRotationIntentInput, expiresAt = '2026-08-24T10:30:00.000Z'): StripeRotationApproval {
  return {
    schemaVersion: 'rorca.stripe-rotation-approval.v1',
    intentDigest: stripeRotationIntentDigest(input),
    authorityReceiptId: APPROVAL_ID,
    approvedBy: OPERATOR_ID,
    approvedAt: '2026-08-24T09:59:00.000Z',
    expiresAt,
  };
}

class MemoryRotationRepository implements StripeRotationIntentRepository {
  record: StripeRotationRecord | null = null;
  createEffects = 0;
  resumeEffects = 0;

  async create(intent: StripeRotationRecord['intent']): Promise<StripeRotationRecord> {
    if (this.record) {
      if (this.record.intent.intentDigest !== intent.intentDigest) {
        throw new ConflictError('Qualification intent replay changed immutable authority');
      }
      return this.record;
    }
    this.createEffects += 1;
    this.record = {
      intent,
      lifecycle: {
        state: 'WAITING_FOR_AUTHENTICATION',
        timeoutDisposition: 'paused',
        activeElapsedMs: 0,
        waitingSince: intent.createdAt,
        resumedAt: null,
        resumeCount: 0,
        providerEvidenceDigest: null,
        capture: null,
      },
    };
    return this.record;
  }

  async get(workspaceId: string, intentId: string): Promise<StripeRotationRecord | null> {
    return this.record?.intent.workspaceId === workspaceId && this.record.intent.intentId === intentId
      ? this.record
      : null;
  }

  async resumeWithCapture(input: {
    workspaceId: string;
    intentId: string;
    intentDigest: string;
    capture: StoredStripeCapture;
    resumedAt: Date;
  }): Promise<{ record: StripeRotationRecord; resumed: boolean }> {
    const record = await this.get(input.workspaceId, input.intentId);
    if (!record) throw new ConflictError('Qualification rotation record is absent');
    const transition = resumeStripeRotationRecord({
      record,
      intentDigest: input.intentDigest,
      capture: input.capture,
      resumedAt: input.resumedAt,
    });
    if (transition.resumed) this.resumeEffects += 1;
    this.record = transition.record;
    return transition;
  }
}

class MemoryQualificationSecretStore implements StripeCredentialSecretStore, StripeCredentialSecretExecutor {
  private storedCapture: StoredStripeCapture | null = null;
  private readonly values = new Map<string, {
    fingerprint: string;
    value: Buffer;
    status: 'captured' | 'active' | 'quarantined';
  }>();

  captureAttempts = 0;
  captureEffects = 0;

  seed(reference: string, expectedFingerprint: string, value: Uint8Array): void {
    this.values.set(reference, {
      fingerprint: expectedFingerprint,
      value: Buffer.from(value),
      status: 'active',
    });
  }

  status(reference: string): 'captured' | 'active' | 'quarantined' | null {
    return this.values.get(reference)?.status ?? null;
  }

  activate(reference: string): void {
    const stored = this.values.get(reference);
    if (!stored) throw new ConflictError('Qualification SecretStore object is absent');
    stored.status = 'active';
  }

  quarantine(reference: string): void {
    const stored = this.values.get(reference);
    if (!stored) throw new ConflictError('Qualification SecretStore object is absent');
    stored.status = 'quarantined';
  }

  async captureReplacement(input: {
    intent: StripeRotationRecord['intent'];
    evidence: StripeDashboardEvidence;
    evidenceDigest: `sha256:${string}`;
    replacement: Uint8Array;
    fingerprint: `sha256:${string}`;
    capturedAt: Date;
  }): Promise<StoredStripeCapture> {
    this.captureAttempts += 1;
    if (this.storedCapture) {
      if (this.storedCapture.intentDigest !== input.intent.intentDigest
          || this.storedCapture.providerEvidenceDigest !== input.evidenceDigest
          || this.storedCapture.result.fingerprint !== input.fingerprint) {
        throw new ConflictError('Qualification secure-capture replay changed evidence');
      }
      return this.storedCapture;
    }

    this.captureEffects += 1;
    const reference = `secret-store://rorca/provider-credentials/${CAPTURE_ID}`;
    const stored: StoredStripeCapture = {
      intentId: input.intent.intentId,
      intentDigest: input.intent.intentDigest,
      workspaceId: input.intent.workspaceId,
      accountId: input.intent.accountId,
      mode: input.intent.mode,
      permissionManifest: [...input.intent.permissionManifest],
      targetBindingReference: input.intent.targetBindingReference,
      providerEvidenceDigest: input.evidenceDigest,
      result: {
        reference,
        fingerprint: input.fingerprint,
        provenance: {
          schemaVersion: 'rorca.stripe-capture-provenance.v1',
          captureReceiptReference: `credential-capture://rorca/${CAPTURE_ID}`,
          provider: 'stripe',
          channel: 'trusted_local_operator',
          providerEvidenceId: input.evidence.evidenceId,
          operatorId: input.evidence.operatorId,
          capturedAt: input.capturedAt.toISOString(),
          targetBindingReference: input.intent.targetBindingReference,
        },
      },
    };
    this.values.set(reference, {
      fingerprint: input.fingerprint,
      value: Buffer.from(input.replacement),
      status: 'captured',
    });
    this.storedCapture = stored;
    return stored;
  }

  async getCapture(captureReceiptReference: string): Promise<StoredStripeCapture | null> {
    return this.storedCapture?.result.provenance.captureReceiptReference === captureReceiptReference
      ? this.storedCapture
      : null;
  }

  async useCredential<T>(input: {
    secretStoreReference: string;
    expectedFingerprint: string;
    operation: (credentialValue: Uint8Array) => Promise<T>;
  }): Promise<T> {
    const stored = this.values.get(input.secretStoreReference);
    if (!stored || stored.status === 'quarantined' || stored.fingerprint !== input.expectedFingerprint) {
      throw new ForbiddenError('Qualification SecretStore reference does not match active authority');
    }
    const value = Buffer.from(stored.value);
    try {
      return await input.operation(value);
    } finally {
      value.fill(0);
    }
  }
}

class QualificationStripeTransport implements StripeHttpTransport {
  private readonly providerState = new Map<string, 'active' | 'rejected' | 'unknown'>();
  private requestSequence = 0;

  readonly requests: Array<{
    path: string;
    timeoutMs: number;
    fingerprint: string;
    statusCode: number;
  }> = [];

  failNextStatus: number | null = null;

  setStatus(expectedFingerprint: string, status: 'active' | 'rejected' | 'unknown'): void {
    this.providerState.set(expectedFingerprint, status);
  }

  status(expectedFingerprint: string): 'active' | 'rejected' | 'unknown' {
    return this.providerState.get(expectedFingerprint) ?? 'unknown';
  }

  async request(input: {
    path: string;
    credential: Uint8Array;
    timeoutMs: number;
  }): Promise<StripeHttpOperationResult> {
    this.requestSequence += 1;
    const credentialFingerprint = fingerprint(input.credential);
    const providerStatus = this.providerState.get(credentialFingerprint) ?? 'unknown';
    const statusCode = this.failNextStatus ?? (providerStatus === 'active'
      ? 200
      : providerStatus === 'rejected'
        ? 401
        : 503);
    this.failNextStatus = null;
    this.requests.push({
      path: input.path,
      timeoutMs: input.timeoutMs,
      fingerprint: credentialFingerprint,
      statusCode,
    });
    const resourceId = decodeURIComponent(input.path.slice(input.path.lastIndexOf('/') + 1));
    return {
      statusCode,
      providerRequestReference: `req_rorca_qualification_${this.requestSequence}`,
      body: statusCode === 200
        ? { id: resourceId, object: 'payment_intent', livemode: false }
        : { error: { type: 'invalid_request_error' } },
    };
  }
}

class MemoryRuntimeBinding implements RuntimeSecretBindingAdapter {
  stageAttempts = 0;
  stageEffects = 0;
  restoreAttempts = 0;
  restoreEffects = 0;
  rejectionAttempts = 0;
  failNextRejection = false;
  failNextStage = false;
  activeFingerprint: string;
  observedAt = FIRST_CUTOVER_AT.toISOString();

  constructor(
    private readonly priorFingerprint: string,
    private readonly provider: QualificationStripeTransport,
  ) {
    this.activeFingerprint = priorFingerprint;
  }

  private state(targetBindingReference: string): RuntimeSecretBindingState {
    return {
      targetBindingReference,
      activeFingerprint: this.activeFingerprint,
      health: 'healthy',
      bindingGeneration: this.activeFingerprint === this.priorFingerprint ? 1 : 2,
      observedAt: this.observedAt,
    };
  }

  async inspect(input: Parameters<RuntimeSecretBindingAdapter['inspect']>[0]): Promise<RuntimeSecretBindingState> {
    const parsed = RuntimeSecretBindingInspectInputSchema.parse(input);
    return this.state(parsed.targetBindingReference);
  }

  async stage(input: Parameters<RuntimeSecretBindingAdapter['stage']>[0]): Promise<RuntimeSecretBindingState> {
    const parsed = RuntimeSecretBindingStageInputSchema.parse(input);
    this.stageAttempts += 1;
    if (this.failNextStage) {
      this.failNextStage = false;
      throw new ConflictError('Simulated process loss during target stage');
    }
    if (this.activeFingerprint === parsed.replacementFingerprint) {
      return this.state(parsed.targetBindingReference);
    }
    if (this.activeFingerprint !== parsed.expectedCurrentFingerprint) {
      throw new ConflictError('Qualification target compare-and-swap failed');
    }
    this.activeFingerprint = parsed.replacementFingerprint;
    this.stageEffects += 1;
    return this.state(parsed.targetBindingReference);
  }

  async restore(input: Parameters<RuntimeSecretBindingAdapter['restore']>[0]): Promise<RuntimeSecretBindingState> {
    const parsed = RuntimeSecretBindingRestoreInputSchema.parse(input);
    this.restoreAttempts += 1;
    if (this.activeFingerprint === parsed.retainedPriorFingerprint) {
      return this.state(parsed.targetBindingReference);
    }
    if (this.activeFingerprint !== parsed.expectedActiveFingerprint) {
      throw new ConflictError('Qualification rollback compare-and-swap failed');
    }
    this.activeFingerprint = parsed.retainedPriorFingerprint;
    this.restoreEffects += 1;
    return this.state(parsed.targetBindingReference);
  }

  async verifyStripeCredentialRejected(
    input: Parameters<RuntimeSecretBindingAdapter['verifyStripeCredentialRejected']>[0],
  ) {
    const parsed = RuntimeStripeRejectionVerificationInputSchema.parse(input);
    this.rejectionAttempts += 1;
    if (this.failNextRejection) {
      this.failNextRejection = false;
      throw new ConflictError('Simulated process loss during old-key rejection verification');
    }
    if (this.activeFingerprint !== parsed.expectedActiveFingerprint
        || this.provider.status(parsed.retainedPriorFingerprint) !== 'rejected') {
      throw new ConflictError('Qualification provider has not rejected the retained prior key');
    }
    return {
      schemaVersion: 'rorca.stripe-old-key-rejection-receipt.v1' as const,
      mode: 'test' as const,
      operation: parsed.canary.operation,
      resourceType: parsed.canary.resourceType,
      resourceId: parsed.canary.resourceId,
      providerRequestReference: `req_rorca_old_key_rejected_${this.rejectionAttempts}`,
      rejectedAt: this.observedAt,
      result: 'authentication_rejected' as const,
    };
  }
}

class MemoryFailureRepository implements StripeCredentialFailureRepository {
  readonly rollbacks = new Map<string, StripeRollbackReceipt>();
  readonly emergencies = new Map<string, StripeEmergencyRotationRequest>();
  readonly reconciliations = new Map<string, StripeCredentialStatusReconciliation>();
  rollbackSettlementEffects = 0;
  crashAfterNextRollbackSettlement = false;

  constructor(private readonly secrets: MemoryQualificationSecretStore) {}

  private key(workspaceId: string, intentId: string): string {
    return `${workspaceId}:${intentId}`;
  }

  async getRollback(workspaceId: string, intentId: string): Promise<StripeRollbackReceipt | null> {
    return this.rollbacks.get(this.key(workspaceId, intentId)) ?? null;
  }

  async settleRollback(input: {
    receipt: StripeRollbackReceipt;
    replacementSecretReference: string;
  }): Promise<StripeRollbackReceipt> {
    const key = this.key(input.receipt.workspaceId, input.receipt.intentId);
    const existing = this.rollbacks.get(key);
    if (existing) return existing;
    this.secrets.quarantine(input.replacementSecretReference);
    this.rollbacks.set(key, input.receipt);
    this.rollbackSettlementEffects += 1;
    if (this.crashAfterNextRollbackSettlement) {
      this.crashAfterNextRollbackSettlement = false;
      throw new ConflictError('Simulated process loss after rollback receipt commit');
    }
    return input.receipt;
  }

  async createEmergency(request: StripeEmergencyRotationRequest): Promise<StripeEmergencyRotationRequest> {
    const key = request.evidence.providerRequestReference;
    const existing = this.emergencies.get(key);
    if (existing) return existing;
    this.emergencies.set(key, request);
    return request;
  }

  async createReconciliation(
    receipt: StripeCredentialStatusReconciliation,
  ): Promise<StripeCredentialStatusReconciliation> {
    const key = `${receipt.intentId}:${receipt.evidenceDigest}`;
    const existing = this.reconciliations.get(key);
    if (existing) return existing;
    this.reconciliations.set(key, receipt);
    return receipt;
  }

  async getReconciliation(
    _workspaceId: string,
    intentId: string,
    evidenceDigest: string,
  ): Promise<StripeCredentialStatusReconciliation | null> {
    return this.reconciliations.get(`${intentId}:${evidenceDigest}`) ?? null;
  }

  async listIncidents(workspaceId: string, limit: number): Promise<StripeCredentialIncident[]> {
    const incidents: StripeCredentialIncident[] = [];
    for (const receipt of this.rollbacks.values()) {
      if (receipt.workspaceId === workspaceId) incidents.push({ kind: 'rollback', receipt });
    }
    for (const request of this.emergencies.values()) {
      if (request.workspaceId === workspaceId) incidents.push({ kind: 'emergency', request });
    }
    for (const receipt of this.reconciliations.values()) {
      if (receipt.workspaceId === workspaceId) incidents.push({ kind: 'reconciliation', receipt });
    }
    return incidents.slice(0, limit);
  }
}

class MemoryCutoverRepository implements StripeCredentialCutoverRepository {
  state: StripeCredentialCutoverState | null = null;
  initializeEffects = 0;
  transitionEffects = 0;
  completionEffects = 0;
  crashAfterNextCompletion = false;

  constructor(
    private readonly settleBinding: (
      input: Parameters<StripeCredentialCutoverRepository['complete']>[0],
    ) => void,
  ) {}

  async get(workspaceId: string, intentId: string): Promise<StripeCredentialCutoverState | null> {
    return this.state?.workspaceId === workspaceId && this.state.intentId === intentId
      ? this.state
      : null;
  }

  async initialize(state: StripeCredentialCutoverState): Promise<StripeCredentialCutoverState> {
    if (!this.state) {
      this.state = StripeCredentialCutoverStateSchema.parse(state);
      this.initializeEffects += 1;
    }
    return this.state;
  }

  async transition(
    workspaceId: string,
    intentId: string,
    expectedState: StripeCredentialCutoverState['state'],
    next: StripeCredentialCutoverState,
  ): Promise<StripeCredentialCutoverState> {
    assert.equal(this.state?.workspaceId, workspaceId);
    assert.equal(this.state?.intentId, intentId);
    assert.equal(this.state?.state, expectedState);
    this.state = StripeCredentialCutoverStateSchema.parse(next);
    this.transitionEffects += 1;
    return this.state;
  }

  async complete(
    input: Parameters<StripeCredentialCutoverRepository['complete']>[0],
  ): Promise<StripeCredentialCutoverState> {
    if (this.state?.state === 'COMPLETED') return this.state;
    assert.equal(this.state?.state, input.expectedState);
    this.state = StripeCredentialCutoverStateSchema.parse(input.state);
    this.settleBinding(input);
    this.completionEffects += 1;
    if (this.crashAfterNextCompletion) {
      this.crashAfterNextCompletion = false;
      throw new ConflictError('Simulated process loss after cutover receipt settlement');
    }
    return this.state;
  }
}

interface QualificationFixture {
  adapter: StripeAuthorityProviderAdapter;
  bindingRows: BindingRow[];
  canary: StripeTestModeCredentialCanaryAdapter;
  capture: StripeSecureOperatorCapture;
  cutoverRepository: MemoryCutoverRepository;
  failureRepository: MemoryFailureRepository;
  failureService: StripeCredentialFailureService;
  input: StripeRotationIntentInput;
  priorSecret: Buffer;
  priorFingerprint: `sha256:${string}`;
  provider: QualificationStripeTransport;
  replacementSecret: Buffer;
  replacementFingerprint: `sha256:${string}`;
  revocationEvidence: (intentDigest: string) => StripeDashboardRevocationEvidence;
  rotationRepository: MemoryRotationRepository;
  rotationService: StripeCredentialRotationService;
  runtime: MemoryRuntimeBinding;
  secretStore: MemoryQualificationSecretStore;
  signedCaptureEvidence: (
    intentDigest: string,
    overrides?: Partial<StripeDashboardEvidenceUnsigned>,
  ) => StripeDashboardEvidence;
}

async function qualificationFixture(): Promise<QualificationFixture> {
  const priorSecret = credential('Prior');
  const replacementSecret = credential('Replacement');
  const priorFingerprint = fingerprint(priorSecret);
  const replacementFingerprint = fingerprint(replacementSecret);
  const bindingRows: BindingRow[] = [{
    id: BINDING_ID,
    workspace_id: WORKSPACE_ID,
    provider_account_id: ACCOUNT_ID,
    mode: 'test',
    application_id: 'rorca-disposable-payment-fixture',
    resource_type: 'payment_intents',
    resource_id: 'rorca-disposable-target',
    credential_class: 'restricted_api_key',
    key_kind: 'restricted',
    permission_manifest: ['payment_intents.read'],
    owner: OPERATOR_ID,
    fingerprint: priorFingerprint,
    secret_store_reference: PRIOR_SECRET_REFERENCE,
    target_binding_reference: TARGET_REFERENCE,
    status: 'active',
    binding_generation: 1,
    last_verified_at: new Date('2026-08-24T09:55:00.000Z'),
  }, {
    id: WEBHOOK_BINDING_ID,
    workspace_id: WORKSPACE_ID,
    provider_account_id: ACCOUNT_ID,
    mode: 'test',
    application_id: 'rorca-disposable-webhook-fixture',
    resource_type: 'webhook_endpoints',
    resource_id: 'rorca-disposable-webhook-target',
    credential_class: 'webhook_signing_secret',
    key_kind: 'signing_secret',
    permission_manifest: ['credentials.webhook_signing_secret.rotate'],
    owner: OPERATOR_ID,
    fingerprint: `sha256:${'c'.repeat(64)}`,
    secret_store_reference: 'secret-store://rorca/provider-credentials/a1000000-0000-4000-8000-000000000010',
    target_binding_reference: 'runtime-binding://rorca/disposable-webhook-qualification',
    status: 'active',
    binding_generation: 1,
    last_verified_at: new Date('2026-08-24T09:55:00.000Z'),
  }, {
    id: LIVE_BINDING_ID,
    workspace_id: WORKSPACE_ID,
    provider_account_id: ACCOUNT_ID,
    mode: 'live',
    application_id: 'rorca-disposable-payment-fixture',
    resource_type: 'payment_intents',
    resource_id: 'rorca-disposable-target',
    credential_class: 'restricted_api_key',
    key_kind: 'restricted',
    permission_manifest: ['payment_intents.read'],
    owner: OPERATOR_ID,
    fingerprint: `sha256:${'d'.repeat(64)}`,
    secret_store_reference: 'secret-store://rorca/provider-credentials/a1000000-0000-4000-8000-000000000011',
    target_binding_reference: TARGET_REFERENCE,
    status: 'active',
    binding_generation: 1,
    last_verified_at: null,
  }];
  const adapter = new StripeAuthorityProviderAdapter(async (workspaceId) =>
    bindingRows.filter((row) => row.workspace_id === workspaceId));
  const binding = (await adapter.inventory(WORKSPACE_ID)).find((candidate) => candidate.bindingId === BINDING_ID);
  assert.ok(binding);
  const input = rotationInput(binding);
  const rotationRepository = new MemoryRotationRepository();
  const secretStore = new MemoryQualificationSecretStore();
  secretStore.seed(PRIOR_SECRET_REFERENCE, priorFingerprint, priorSecret);
  const provider = new QualificationStripeTransport();
  provider.setStatus(priorFingerprint, 'active');
  provider.setStatus(replacementFingerprint, 'active');
  const canary = new StripeTestModeCredentialCanaryAdapter(secretStore, provider);
  const runtime = new MemoryRuntimeBinding(priorFingerprint, provider);
  const failureRepository = new MemoryFailureRepository(secretStore);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const readAttestationKeys = () => [{
    keyId: ATTESTATION_KEY_ID,
    publicKeyPem,
    workspaceId: WORKSPACE_ID,
    accountId: ACCOUNT_ID,
    operatorIds: [OPERATOR_ID],
    modes: ['test' as const],
  }];
  const capture = new StripeSecureOperatorCapture(
    secretStore,
    new StripeDashboardEvidenceVerifier(readAttestationKeys),
  );
  const failureService = new StripeCredentialFailureService(
    adapter,
    failureRepository,
    runtime,
    canary,
    () => REVOKED_AT,
  );
  const cutoverRepository = new MemoryCutoverRepository((settlement) => {
    const prior = bindingRows.find((row) => row.id === settlement.priorBinding.bindingId);
    assert.ok(prior);
    prior.status = 'revoked';
    prior.last_verified_at = settlement.verifiedAt;
    if (!bindingRows.some((row) => row.id === settlement.state.replacementBindingId)) {
      bindingRows.push({
        id: settlement.state.replacementBindingId,
        workspace_id: settlement.intent.workspaceId,
        provider_account_id: settlement.intent.accountId,
        mode: 'test',
        application_id: prior.application_id,
        resource_type: prior.resource_type,
        resource_id: prior.resource_id,
        credential_class: 'restricted_api_key',
        key_kind: 'restricted',
        permission_manifest: [...settlement.intent.permissionManifest],
        owner: prior.owner,
        fingerprint: settlement.capture.fingerprint,
        secret_store_reference: settlement.capture.reference,
        target_binding_reference: prior.target_binding_reference,
        status: 'active',
        binding_generation: prior.binding_generation + 1,
        last_verified_at: settlement.verifiedAt,
      });
    }
    secretStore.activate(settlement.capture.reference);
  });
  const cutoverService = new StripeCredentialCutoverService(
    (workspaceId, intentId) => rotationRepository.get(workspaceId, intentId),
    adapter,
    cutoverRepository,
    runtime,
    canary,
    new StripeDashboardRevocationEvidenceVerifier(readAttestationKeys),
    async <T>(_key: string, operation: () => Promise<T>) => operation(),
    () => FIRST_CUTOVER_AT,
    failureService,
  );
  const rotationService = new StripeCredentialRotationService(
    adapter,
    rotationRepository,
    secretStore,
    cutoverService,
  );

  function signedCaptureEvidence(
    intentDigest: string,
    overrides: Partial<StripeDashboardEvidenceUnsigned> = {},
  ): StripeDashboardEvidence {
    const unsigned = StripeDashboardEvidenceUnsignedSchema.parse({
      schemaVersion: 'rorca.stripe-dashboard-evidence.v1',
      evidenceId: CAPTURE_EVIDENCE_ID,
      intentDigest,
      workspaceId: WORKSPACE_ID,
      accountId: ACCOUNT_ID,
      mode: 'test',
      permissionManifest: ['payment_intents.read'],
      targetBindingReference: TARGET_REFERENCE,
      keyKind: 'restricted',
      replacementFingerprint,
      dashboardSessionReference: 'stripe-dashboard-session://rorca/qualification-capture',
      dashboardReauthenticatedAt: '2026-08-24T10:03:00.000Z',
      restrictedKeyCreatedAt: '2026-08-24T10:04:00.000Z',
      operatorId: OPERATOR_ID,
      attestationKeyId: ATTESTATION_KEY_ID,
      ...overrides,
    });
    return {
      ...unsigned,
      signature: sign(null, Buffer.from(stableWalJson(unsigned), 'utf8'), privateKey).toString('base64url'),
    };
  }

  function revocationEvidence(intentDigest: string): StripeDashboardRevocationEvidence {
    const unsigned = StripeDashboardRevocationEvidenceUnsignedSchema.parse({
      schemaVersion: 'rorca.stripe-dashboard-revocation-evidence.v1',
      evidenceId: REVOCATION_EVIDENCE_ID,
      intentDigest,
      workspaceId: WORKSPACE_ID,
      accountId: ACCOUNT_ID,
      mode: 'test',
      priorFingerprint,
      dashboardSessionReference: 'stripe-dashboard-session://rorca/qualification-revocation',
      dashboardReauthenticatedAt: '2026-08-24T10:08:30.000Z',
      revokedAt: REVOKED_AT.toISOString(),
      operatorId: OPERATOR_ID,
      attestationKeyId: ATTESTATION_KEY_ID,
    });
    return {
      ...unsigned,
      signature: sign(null, Buffer.from(stableWalJson(unsigned), 'utf8'), privateKey).toString('base64url'),
    };
  }

  return {
    adapter,
    bindingRows,
    canary,
    capture,
    cutoverRepository,
    failureRepository,
    failureService,
    input,
    priorSecret,
    priorFingerprint,
    provider,
    replacementSecret,
    replacementFingerprint,
    revocationEvidence,
    rotationRepository,
    rotationService,
    runtime,
    secretStore,
    signedCaptureEvidence,
  };
}

function assertSecretFree(value: unknown, fixture: QualificationFixture): void {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes(fixture.priorSecret.toString('ascii')), false);
  assert.equal(serialized.includes(fixture.replacementSecret.toString('ascii')), false);
  assert.doesNotMatch(serialized, CREDENTIAL_PATTERN);
}

interface PreparedQualification {
  captureResult: StripeSecureCaptureResult;
  record: StripeRotationRecord;
  request: {
    workspaceId: string;
    intentId: string;
    intentDigest: string;
  };
}

async function prepareCapturedRotation(subject: QualificationFixture): Promise<PreparedQualification> {
  const record = await subject.rotationService.createApprovedIntent({
    intentId: INTENT_ID,
    intent: subject.input,
    approval: approval(subject.input),
    now: CREATED_AT,
  });
  const captureResult = await subject.capture.capture({
    intent: record.intent,
    evidence: subject.signedCaptureEvidence(record.intent.intentDigest),
    replacement: subject.replacementSecret,
    now: CAPTURED_AT,
  });
  await subject.rotationService.completeAuthentication({
    workspaceId: WORKSPACE_ID,
    intentId: INTENT_ID,
    completion: {
      intentDigest: record.intent.intentDigest,
      captureReceiptReference: captureResult.provenance.captureReceiptReference,
    },
    now: CAPTURED_AT,
  });
  return {
    captureResult,
    record,
    request: {
      workspaceId: WORKSPACE_ID,
      intentId: INTENT_ID,
      intentDigest: record.intent.intentDigest,
    },
  };
}

describe('SCR-005 Stripe test-mode adversarial qualification', () => {
  it('proves restricted inventory, isolated capture, real canary, grace, cutover, and revocation without key exposure', async () => {
    const subject = await qualificationFixture();
    const inventory = await subject.adapter.inventory(WORKSPACE_ID);
    assert.equal(inventory.every((binding) => binding.accountId === ACCOUNT_ID), true);
    const prior = inventory.find((binding) => binding.bindingId === BINDING_ID);
    assert.ok(prior);
    assert.equal(prior.credentialClass, 'restricted_api_key');
    assert.equal(prior.keyKind, 'restricted');
    assert.deepEqual(prior.permissionManifest, ['payment_intents.read']);
    assert.equal(inventory.some((binding) => binding.credentialClass === 'webhook_signing_secret'), true);
    assert.equal(inventory.some((binding) => binding.mode === 'live'), true);

    await subject.adapter.assertApplicationMapping({
      workspaceId: WORKSPACE_ID,
      accountId: ACCOUNT_ID,
      mode: 'test',
      applicationId: prior.scope.applicationId,
      resourceType: prior.scope.resourceType,
      resourceId: prior.scope.resourceId,
      credentialClass: 'restricted_api_key',
      bindingId: prior.bindingId,
      targetBindingReference: TARGET_REFERENCE,
      permissions: ['payment_intents.read'],
    });

    const created = await subject.rotationService.createApprovedIntent({
      intentId: INTENT_ID,
      intent: subject.input,
      approval: approval(subject.input),
      now: CREATED_AT,
    });
    const ceremony = await subject.rotationService.getOperatorCeremony(WORKSPACE_ID, INTENT_ID);
    assert.equal(created.lifecycle.state, 'WAITING_FOR_AUTHENTICATION');
    assert.equal(created.lifecycle.timeoutDisposition, 'paused');
    assert.equal(ceremony.captureChannel, 'trusted_local_operator');
    assert.equal(ceremony.prohibitedActions.includes('submit_secret_to_api_or_model'), true);

    const evidence = subject.signedCaptureEvidence(created.intent.intentDigest);
    const firstCapture = await subject.capture.capture({
      intent: created.intent,
      evidence,
      replacement: subject.replacementSecret,
      now: CAPTURED_AT,
    });
    const recoveredCapture = await subject.capture.capture({
      intent: created.intent,
      evidence,
      replacement: subject.replacementSecret,
      now: CAPTURED_AT,
    });
    assert.deepEqual(recoveredCapture, firstCapture);
    assert.equal(subject.secretStore.captureAttempts, 2);
    assert.equal(subject.secretStore.captureEffects, 1);
    assert.deepEqual(Object.keys(firstCapture).sort(), ['fingerprint', 'provenance', 'reference']);

    const completion = {
      intentDigest: created.intent.intentDigest,
      captureReceiptReference: firstCapture.provenance.captureReceiptReference,
    };
    await subject.rotationService.completeAuthentication({
      workspaceId: WORKSPACE_ID,
      intentId: INTENT_ID,
      completion,
      now: CAPTURED_AT,
    });
    await subject.rotationService.completeAuthentication({
      workspaceId: WORKSPACE_ID,
      intentId: INTENT_ID,
      completion,
      now: FIRST_CUTOVER_AT,
    });
    assert.equal(subject.rotationRepository.resumeEffects, 1);
    assert.equal(subject.rotationRepository.record?.lifecycle.resumeCount, 1);

    const request = {
      workspaceId: WORKSPACE_ID,
      intentId: INTENT_ID,
      intentDigest: created.intent.intentDigest,
    };
    const grace = await subject.rotationService.advanceCutover({
      ...request,
      now: FIRST_CUTOVER_AT,
    });
    assert.equal(grace.state, 'GRACE_PERIOD');
    assert.equal(subject.runtime.stageEffects, 1);
    assert.equal(subject.runtime.activeFingerprint, subject.replacementFingerprint);
    assert.equal(subject.provider.requests[0]?.path, `/v1/payment_intents/${CANARY_RESOURCE_ID}`);
    assert.doesNotMatch(subject.provider.requests[0]?.path ?? '', /health/i);
    assert.equal((await subject.adapter.inventory(WORKSPACE_ID)).find(
      (binding) => binding.bindingId === BINDING_ID,
    )?.status, 'active');

    const graceReplay = await subject.rotationService.advanceCutover({
      ...request,
      now: new Date('2026-08-24T10:06:30.000Z'),
    });
    assert.equal(graceReplay.state, 'GRACE_PERIOD');
    assert.equal(subject.runtime.stageEffects, 1);
    assert.equal(subject.provider.requests.length, 1);

    const waiting = await subject.rotationService.advanceCutover({
      ...request,
      now: AFTER_GRACE_AT,
    });
    assert.equal(waiting.state, 'WAITING_FOR_REVOCATION');
    assert.equal(subject.provider.requests.length, 2);
    assert.equal((await subject.adapter.inventory(WORKSPACE_ID)).find(
      (binding) => binding.bindingId === BINDING_ID,
    )?.status, 'active');

    subject.provider.setStatus(subject.priorFingerprint, 'rejected');
    subject.runtime.observedAt = REVOKED_AT.toISOString();
    const revocationEvidence = subject.revocationEvidence(created.intent.intentDigest);
    const completed = await subject.rotationService.completeRevocation({
      ...request,
      evidence: revocationEvidence,
      now: REVOKED_AT,
    });
    const replay = await subject.rotationService.completeRevocation({
      ...request,
      evidence: revocationEvidence,
      now: new Date('2026-08-24T10:10:00.000Z'),
    });
    assert.equal(completed.state, 'COMPLETED');
    assert.deepEqual(replay, completed);
    assert.equal(subject.runtime.rejectionAttempts, 1);
    assert.equal(subject.cutoverRepository.completionEffects, 1);
    assert.equal(subject.secretStore.status(firstCapture.reference), 'active');

    const settledInventory = await subject.adapter.inventory(WORKSPACE_ID);
    assert.equal(settledInventory.find((binding) => binding.bindingId === BINDING_ID)?.status, 'revoked');
    assert.equal(settledInventory.some((binding) =>
      binding.status === 'active'
      && binding.fingerprint === subject.replacementFingerprint
      && binding.generation === 2), true);
    assertSecretFree({
      inventory,
      ceremony,
      firstCapture,
      grace,
      waiting,
      completed,
      settledInventory,
      providerRequests: subject.provider.requests,
    }, subject);
  });

  it('denies prompt extraction, cross-scope use, broader authority, altered intent, replay, expiry, and live mode', async () => {
    const subject = await qualificationFixture();
    const prior = (await subject.adapter.inventory(WORKSPACE_ID)).find(
      (binding) => binding.bindingId === BINDING_ID,
    );
    assert.ok(prior);

    assert.equal(await subject.adapter.getProviderBinding({
      workspaceId: FOREIGN_WORKSPACE_ID,
      accountId: ACCOUNT_ID,
      mode: 'test',
      applicationId: prior.scope.applicationId,
      resourceType: prior.scope.resourceType,
      resourceId: prior.scope.resourceId,
      credentialClass: 'restricted_api_key',
    }), null);
    await assert.rejects(subject.adapter.assertApplicationMapping({
      workspaceId: WORKSPACE_ID,
      accountId: ACCOUNT_ID,
      mode: 'live',
      applicationId: prior.scope.applicationId,
      resourceType: prior.scope.resourceType,
      resourceId: prior.scope.resourceId,
      credentialClass: 'restricted_api_key',
      bindingId: BINDING_ID,
      targetBindingReference: TARGET_REFERENCE,
      permissions: ['payment_intents.read'],
    }), /must match the binding workspace, account, mode, scope/);
    await assert.rejects(subject.adapter.assertApplicationMapping({
      workspaceId: WORKSPACE_ID,
      accountId: ACCOUNT_ID,
      mode: 'test',
      applicationId: prior.scope.applicationId,
      resourceType: prior.scope.resourceType,
      resourceId: prior.scope.resourceId,
      credentialClass: 'restricted_api_key',
      bindingId: BINDING_ID,
      targetBindingReference: TARGET_REFERENCE,
      permissions: ['payment_intents.read', 'customers.read'],
    }), /exceeds the approved permission manifest/);

    const alteredIntent = {
      ...subject.input,
      permissionManifest: [...subject.input.permissionManifest, 'customers.read'],
    };
    await assert.rejects(subject.rotationService.createApprovedIntent({
      intentId: INTENT_ID,
      intent: alteredIntent,
      approval: approval(subject.input),
      now: CREATED_AT,
    }), /permission manifest must equal the approved binding manifest/);
    await assert.rejects(subject.rotationService.createApprovedIntent({
      intentId: INTENT_ID,
      intent: subject.input,
      approval: approval(subject.input, '2026-08-24T09:59:30.000Z'),
      now: CREATED_AT,
    }), /temporally valid/);

    let extractionFailure: unknown;
    assert.throws(
      () => StripeProviderBindingSchema.parse({
        ...prior,
        owner: subject.replacementSecret.toString('ascii'),
      }),
      (error: unknown) => {
        extractionFailure = error;
        return true;
      },
    );
    assertSecretFree(extractionFailure, subject);
    assert.throws(() => subject.signedCaptureEvidence(
      stripeRotationIntentDigest(subject.input),
      { dashboardSessionReference: subject.replacementSecret.toString('ascii') },
    ));

    const created = await subject.rotationService.createApprovedIntent({
      intentId: INTENT_ID,
      intent: subject.input,
      approval: approval(subject.input),
      now: CREATED_AT,
    });
    const forged = {
      ...subject.signedCaptureEvidence(created.intent.intentDigest),
      signature: Buffer.alloc(64).toString('base64url'),
    };
    await assert.rejects(subject.capture.capture({
      intent: created.intent,
      evidence: forged,
      replacement: subject.replacementSecret,
      now: CAPTURED_AT,
    }), /signature verification failed/);
    await assert.rejects(subject.capture.capture({
      intent: created.intent,
      evidence: subject.signedCaptureEvidence(created.intent.intentDigest, {
        permissionManifest: ['payment_intents.read', 'customers.read'],
      }),
      replacement: subject.replacementSecret,
      now: CAPTURED_AT,
    }), /permission manifest exceeds or differs/);

    const wrongModeReplacement = Buffer.from(
      ['rk', 'live', 'RorcaQualificationWrongMode123456'].join('_'),
      'ascii',
    );
    await assert.rejects(subject.capture.capture({
      intent: created.intent,
      evidence: subject.signedCaptureEvidence(created.intent.intentDigest, {
        replacementFingerprint: fingerprint(wrongModeReplacement),
      }),
      replacement: wrongModeReplacement,
      now: CAPTURED_AT,
    }), /not a restricted key in the approved mode/);
    assert.equal(subject.secretStore.captureEffects, 0);
    assert.equal(subject.runtime.activeFingerprint, subject.priorFingerprint);

    const firstCapture = await subject.capture.capture({
      intent: created.intent,
      evidence: subject.signedCaptureEvidence(created.intent.intentDigest),
      replacement: subject.replacementSecret,
      now: CAPTURED_AT,
    });
    const replayReplacement = credential('Replay');
    await assert.rejects(subject.capture.capture({
      intent: created.intent,
      evidence: subject.signedCaptureEvidence(created.intent.intentDigest, {
        replacementFingerprint: fingerprint(replayReplacement),
      }),
      replacement: replayReplacement,
      now: CAPTURED_AT,
    }), /replay changed evidence/);
    assert.equal(subject.secretStore.captureEffects, 1);

    await subject.rotationService.completeAuthentication({
      workspaceId: WORKSPACE_ID,
      intentId: INTENT_ID,
      completion: {
        intentDigest: created.intent.intentDigest,
        captureReceiptReference: firstCapture.provenance.captureReceiptReference,
      },
      now: CAPTURED_AT,
    });
    await assert.rejects(subject.rotationService.advanceCutover({
      workspaceId: WORKSPACE_ID,
      intentId: INTENT_ID,
      intentDigest: `sha256:${'e'.repeat(64)}`,
      now: FIRST_CUTOVER_AT,
    }), /does not match the immutable intent digest/);

    const providerCalls = subject.provider.requests.length;
    await assert.rejects(subject.canary.runCanary({
      workspaceId: WORKSPACE_ID,
      accountId: ACCOUNT_ID,
      mode: 'live',
      secretStoreReference: firstCapture.reference,
      expectedFingerprint: firstCapture.fingerprint,
      permissionManifest: ['payment_intents.read'],
      canary: subject.input.canary,
    } as unknown as StripeCredentialOperationInput));
    assert.equal(subject.provider.requests.length, providerCalls);

    const recovered = subject.rotationRepository.record;
    assert.ok(recovered);
    const liveCutover = new StripeCredentialCutoverService(
      async () => ({
        ...recovered,
        intent: { ...recovered.intent, mode: 'live' },
      }),
      subject.adapter,
      subject.cutoverRepository,
      subject.runtime,
      subject.canary,
      new StripeDashboardRevocationEvidenceVerifier(() => []),
      async <T>(_key: string, operation: () => Promise<T>) => operation(),
      () => FIRST_CUTOVER_AT,
      subject.failureService,
    );
    await assert.rejects(liveCutover.advance({
      workspaceId: WORKSPACE_ID,
      intentId: INTENT_ID,
      intentDigest: recovered.intent.intentDigest,
      now: FIRST_CUTOVER_AT,
    }), /cutover is disabled outside test mode/);

    assert.equal(subject.runtime.activeFingerprint, subject.priorFingerprint);
    assert.equal(subject.bindingRows.find((row) => row.id === BINDING_ID)?.status, 'active');
    assertSecretFree({ extractionFailure, firstCapture }, subject);
  });

  it('rolls back target, canary, and grace failures while preserving the prior disposable binding', async () => {
    const targetFailure = await qualificationFixture();
    const targetPrepared = await prepareCapturedRotation(targetFailure);
    targetFailure.runtime.failNextStage = true;
    await assert.rejects(targetFailure.rotationService.advanceCutover({
      ...targetPrepared.request,
      now: FIRST_CUTOVER_AT,
    }), /retained prior binding was restored/);

    const canaryFailure = await qualificationFixture();
    const canaryPrepared = await prepareCapturedRotation(canaryFailure);
    canaryFailure.provider.failNextStatus = 500;
    await assert.rejects(canaryFailure.rotationService.advanceCutover({
      ...canaryPrepared.request,
      now: FIRST_CUTOVER_AT,
    }), /retained prior binding was restored/);
    await assert.rejects(canaryFailure.rotationService.advanceCutover({
      ...canaryPrepared.request,
      now: FIRST_CUTOVER_AT,
    }), /closed by an immutable rollback receipt/);

    const graceFailure = await qualificationFixture();
    const gracePrepared = await prepareCapturedRotation(graceFailure);
    await graceFailure.rotationService.advanceCutover({
      ...gracePrepared.request,
      now: FIRST_CUTOVER_AT,
    });
    graceFailure.provider.failNextStatus = 500;
    await assert.rejects(graceFailure.rotationService.advanceCutover({
      ...gracePrepared.request,
      now: AFTER_GRACE_AT,
    }), /retained prior binding was restored/);

    for (const [subject, prepared] of [
      [targetFailure, targetPrepared],
      [canaryFailure, canaryPrepared],
      [graceFailure, gracePrepared],
    ] as const) {
      const receipt = subject.failureRepository.rollbacks.get(`${WORKSPACE_ID}:${INTENT_ID}`);
      assert.ok(receipt);
      assert.equal(receipt.disposition, 'ROLLED_BACK');
      assert.equal(receipt.priorBindingStatus, 'retained_active');
      assert.equal(receipt.replacementSecretStatus, 'quarantined');
      assert.equal(subject.runtime.activeFingerprint, subject.priorFingerprint);
      assert.equal(subject.secretStore.status(prepared.captureResult.reference), 'quarantined');
      assert.equal(subject.bindingRows.find((row) => row.id === BINDING_ID)?.status, 'active');
      assertSecretFree(receipt, subject);
    }

    const settlementCrash = await qualificationFixture();
    const crashPrepared = await prepareCapturedRotation(settlementCrash);
    settlementCrash.failureRepository.crashAfterNextRollbackSettlement = true;
    settlementCrash.provider.failNextStatus = 500;
    await assert.rejects(settlementCrash.rotationService.advanceCutover({
      ...crashPrepared.request,
      now: FIRST_CUTOVER_AT,
    }), /process loss after rollback receipt commit/);
    await assert.rejects(settlementCrash.rotationService.advanceCutover({
      ...crashPrepared.request,
      now: FIRST_CUTOVER_AT,
    }), /closed by an immutable rollback receipt/);
    assert.equal(settlementCrash.failureRepository.rollbackSettlementEffects, 1);
    assert.equal(settlementCrash.runtime.activeFingerprint, settlementCrash.priorFingerprint);
    assert.equal(settlementCrash.secretStore.status(crashPrepared.captureResult.reference), 'quarantined');
  });

  it('creates secret-free emergency authority that cannot self-grant or cross scope', async () => {
    const subject = await qualificationFixture();
    const runtimeFailure = {
      schemaVersion: 'rorca.stripe-runtime-authentication-failure.v1' as const,
      fingerprint: subject.priorFingerprint,
      mode: 'test' as const,
      affectedResource: {
        applicationId: 'rorca-disposable-payment-fixture',
        resourceType: 'payment_intents',
        resourceId: 'rorca-disposable-target',
      },
      evidence: {
        evidenceType: 'stripe_runtime_authentication_failure' as const,
        operation: 'payment_intents.read',
        providerHttpStatus: 401 as const,
        providerRequestReference: 'req_rorca_runtime_auth_failure',
        targetBindingReference: TARGET_REFERENCE,
        observedAt: '2026-08-24T10:02:00.000Z',
      },
    };
    const request = await subject.failureService.createEmergencyRequest({
      workspaceId: WORKSPACE_ID,
      bindingId: BINDING_ID,
      failure: runtimeFailure,
      now: CREATED_AT,
    });
    assert.deepEqual(request.authority, {
      canGrant: false,
      canBroadenPermissions: false,
      canCrossWorkspace: false,
      canCrossMode: false,
      canInjectSecret: false,
      requiresDashboardAuthentication: true,
    });
    assert.equal(request.state, 'AWAITING_DASHBOARD_AUTHENTICATION');

    await assert.rejects(subject.failureService.createEmergencyRequest({
      workspaceId: FOREIGN_WORKSPACE_ID,
      bindingId: BINDING_ID,
      failure: runtimeFailure,
      now: CREATED_AT,
    }));
    await assert.rejects(subject.failureService.createEmergencyRequest({
      workspaceId: WORKSPACE_ID,
      bindingId: BINDING_ID,
      failure: {
        ...runtimeFailure,
        evidence: { ...runtimeFailure.evidence, operation: 'customers.read' },
      },
      now: CREATED_AT,
    }), /outside the binding permission manifest/);
    await assert.rejects(subject.failureService.createEmergencyRequest({
      workspaceId: WORKSPACE_ID,
      bindingId: BINDING_ID,
      failure: { ...runtimeFailure, mode: 'live' } as unknown as typeof runtimeFailure,
      now: CREATED_AT,
    }));

    const replay = await subject.failureService.createEmergencyRequest({
      workspaceId: WORKSPACE_ID,
      bindingId: BINDING_ID,
      failure: runtimeFailure,
      now: new Date('2026-08-24T10:03:00.000Z'),
    });
    assert.equal(replay.requestId, request.requestId);
    assert.equal(subject.failureRepository.emergencies.size, 1);
    assertSecretFree({ request, replay }, subject);
  });

  it('recovers capture, stage, canary, grace, revocation, and receipt crashes without duplicate settlement', async () => {
    const subject = await qualificationFixture();
    const prepared = await prepareCapturedRotation(subject);
    const replacementBindingId = 'a1000000-0000-4000-8000-000000000020';
    subject.cutoverRepository.state = StripeCredentialCutoverStateSchema.parse({
      state: 'READY_FOR_STAGING',
      intentId: INTENT_ID,
      intentDigest: prepared.record.intent.intentDigest,
      workspaceId: WORKSPACE_ID,
      bindingId: BINDING_ID,
      replacementBindingId,
      targetBindingReference: TARGET_REFERENCE,
      priorFingerprint: subject.priorFingerprint,
      replacementFingerprint: subject.replacementFingerprint,
      priorCredentialStatus: 'active',
      initializedAt: FIRST_CUTOVER_AT.toISOString(),
    });

    await subject.runtime.stage({
      workspaceId: WORKSPACE_ID,
      provider: 'stripe',
      accountId: ACCOUNT_ID,
      mode: 'test',
      targetBindingReference: TARGET_REFERENCE,
      timeoutMs: 10_000,
      idempotencyKey: replacementBindingId,
      expectedCurrentFingerprint: subject.priorFingerprint,
      replacementFingerprint: subject.replacementFingerprint,
      replacementSecretReference: prepared.captureResult.reference,
    });
    const canaryInput: StripeCredentialOperationInput = {
      workspaceId: WORKSPACE_ID,
      accountId: ACCOUNT_ID,
      mode: 'test',
      secretStoreReference: prepared.captureResult.reference,
      expectedFingerprint: subject.replacementFingerprint,
      permissionManifest: ['payment_intents.read'],
      canary: subject.input.canary,
    };
    await subject.canary.runCanary(canaryInput, FIRST_CUTOVER_AT);

    const grace = await subject.rotationService.advanceCutover({
      ...prepared.request,
      now: FIRST_CUTOVER_AT,
    });
    assert.equal(grace.state, 'GRACE_PERIOD');
    assert.equal(subject.runtime.stageEffects, 1);
    assert.equal(subject.cutoverRepository.initializeEffects, 0);
    assert.equal(subject.cutoverRepository.transitionEffects, 1);
    assert.equal(subject.provider.requests.length, 2);

    await subject.rotationService.advanceCutover({
      ...prepared.request,
      now: new Date('2026-08-24T10:06:30.000Z'),
    });
    const waiting = await subject.rotationService.advanceCutover({
      ...prepared.request,
      now: AFTER_GRACE_AT,
    });
    const waitingReplay = await subject.rotationService.advanceCutover({
      ...prepared.request,
      now: AFTER_GRACE_AT,
    });
    assert.equal(waiting.state, 'WAITING_FOR_REVOCATION');
    assert.deepEqual(waitingReplay, waiting);
    assert.equal(subject.cutoverRepository.transitionEffects, 2);

    subject.provider.setStatus(subject.priorFingerprint, 'rejected');
    subject.runtime.observedAt = REVOKED_AT.toISOString();
    subject.runtime.failNextRejection = true;
    subject.cutoverRepository.crashAfterNextCompletion = true;
    const evidence = subject.revocationEvidence(prepared.record.intent.intentDigest);
    await assert.rejects(subject.rotationService.completeRevocation({
      ...prepared.request,
      evidence,
      now: REVOKED_AT,
    }), /process loss after cutover receipt settlement/);
    assert.equal(subject.failureRepository.reconciliations.size, 1);
    assert.equal(subject.cutoverRepository.state?.state, 'COMPLETED');
    assert.equal(subject.cutoverRepository.completionEffects, 1);

    const completed = await subject.rotationService.completeRevocation({
      ...prepared.request,
      evidence,
      now: new Date('2026-08-24T10:10:00.000Z'),
    });
    assert.equal(completed.state, 'COMPLETED');
    assert.equal(subject.runtime.rejectionAttempts, 1);
    assert.equal(subject.cutoverRepository.completionEffects, 1);
    assert.equal(subject.rotationRepository.resumeEffects, 1);
    assert.equal(subject.secretStore.captureEffects, 1);
    assertSecretFree({
      completed,
      reconciliations: [...subject.failureRepository.reconciliations.values()],
      requests: subject.provider.requests,
    }, subject);
  });

  it('blocks revocation retry with an explicit receipt when provider status stays unknown', async () => {
    const subject = await qualificationFixture();
    const prepared = await prepareCapturedRotation(subject);
    await subject.rotationService.advanceCutover({
      ...prepared.request,
      now: FIRST_CUTOVER_AT,
    });
    await subject.rotationService.advanceCutover({
      ...prepared.request,
      now: AFTER_GRACE_AT,
    });
    subject.provider.setStatus(subject.priorFingerprint, 'unknown');
    subject.runtime.failNextRejection = true;
    const evidence = subject.revocationEvidence(prepared.record.intent.intentDigest);

    await assert.rejects(subject.rotationService.completeRevocation({
      ...prepared.request,
      evidence,
      now: REVOKED_AT,
    }), /requires manual reconciliation before retry/);
    const receipt = [...subject.failureRepository.reconciliations.values()][0];
    assert.ok(receipt);
    assert.equal(receipt.disposition, 'MANUAL_RECONCILIATION');
    assert.equal(receipt.retryAllowed, false);
    assert.equal(receipt.requiredDashboardAuthentication, true);

    await assert.rejects(subject.rotationService.completeRevocation({
      ...prepared.request,
      evidence,
      now: new Date('2026-08-24T10:10:00.000Z'),
    }), /requires manual reconciliation before revocation retry/);
    assert.equal(subject.runtime.rejectionAttempts, 1);
    assert.equal(subject.failureRepository.reconciliations.size, 1);
    assert.equal(subject.bindingRows.find((row) => row.id === BINDING_ID)?.status, 'active');
    assertSecretFree(receipt, subject);
  });
});
