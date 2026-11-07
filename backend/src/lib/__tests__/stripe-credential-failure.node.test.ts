/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import type {
  RuntimeSecretBindingAdapter,
  RuntimeSecretBindingInspectInput,
  RuntimeSecretBindingRestoreInput,
  RuntimeSecretBindingStageInput,
  RuntimeSecretBindingState,
  RuntimeStripeRejectionVerificationInput,
} from '../runtime-secret-binding-adapter';
import type {
  StripeCredentialOperationInput,
  StripeCredentialStatusReader,
  StripeCredentialStatusReceipt,
  StripeOldKeyRejectionReceipt,
} from '../stripe-credential-canary';
import type { StripeSecureCaptureResult } from '../stripe-credential-capture';
import { StripeAuthorityProviderAdapter, type StripeProviderBinding } from '../stripe-authority-provider-adapter';
import {
  createStripeRotationIntent,
  stripeRotationIntentDigest,
  type StripeRotationIntent,
  type StripeRotationIntentInput,
} from '../stripe-credential-rotation';
import {
  StripeCredentialFailureService,
  StripeEmergencyRotationRequestSchema,
  StripeRollbackReceiptSchema,
  StripeRuntimeAuthenticationFailureSchema,
  type StripeCredentialFailureRepository,
  type StripeCredentialIncident,
  type StripeCredentialStatusReconciliation,
  type StripeEmergencyRotationRequest,
  type StripeFailureCutoverSnapshot,
  type StripeRollbackReceipt,
} from '../stripe-credential-failure';

const WORKSPACE_ID = 'workspace-stripe-failure';
const BINDING_ID = '90000000-0000-4000-8000-000000000001';
const INTENT_ID = '90000000-0000-4000-8000-000000000002';
const CAPTURE_ID = '90000000-0000-4000-8000-000000000003';
const REPLACEMENT_BINDING_ID = '90000000-0000-4000-8000-000000000004';
const PRIOR_FINGERPRINT = `sha256:${'a'.repeat(64)}`;
const REPLACEMENT_FINGERPRINT = `sha256:${'b'.repeat(64)}`;
const NOW = new Date('2026-08-24T14:00:00.000Z');

const BINDING: StripeProviderBinding = {
  providerId: 'stripe',
  bindingId: BINDING_ID,
  workspaceId: WORKSPACE_ID,
  accountId: 'acct_rorca_failure_fixture',
  mode: 'test',
  scope: {
    applicationId: 'rorca-disposable-payments',
    resourceType: 'payment_intents',
    resourceId: 'disposable-payment-target',
  },
  credentialClass: 'restricted_api_key',
  keyKind: 'restricted',
  permissionManifest: ['payment_intents.read'],
  owner: 'rorca-stripe-operator',
  fingerprint: PRIOR_FINGERPRINT,
  secretStoreReference: 'secret-store://rorca/provider-credentials/90000000-0000-4000-8000-000000000005',
  targetBindingReference: 'runtime-binding://rorca/disposable-payment-target',
  status: 'active',
  generation: 7,
  lastVerifiedAt: '2026-08-24T13:00:00.000Z',
};

function rotationInput(): StripeRotationIntentInput {
  return {
    workspaceId: WORKSPACE_ID,
    bindingId: BINDING_ID,
    accountId: BINDING.accountId,
    currentFingerprint: PRIOR_FINGERPRINT,
    permissionManifest: [...BINDING.permissionManifest],
    mode: 'test',
    targetBindingReference: BINDING.targetBindingReference,
    replacementCredentialClass: 'restricted_api_key',
    canary: {
      operation: 'payment_intents.read',
      resourceType: 'payment_intents',
      resourceId: 'pi_disposable_failure_canary',
      timeoutMs: 10_000,
    },
    gracePeriodSeconds: 300,
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

function intent(): StripeRotationIntent {
  const input = rotationInput();
  return createStripeRotationIntent({
    intentId: INTENT_ID,
    intent: input,
    binding: BINDING,
    approval: {
      schemaVersion: 'rorca.stripe-rotation-approval.v1',
      intentDigest: stripeRotationIntentDigest(input),
      authorityReceiptId: '90000000-0000-4000-8000-000000000006',
      approvedBy: 'operator:rorca-owner',
      approvedAt: '2026-08-24T13:55:00.000Z',
      expiresAt: '2026-08-24T15:00:00.000Z',
    },
    now: NOW,
  });
}

const CAPTURE: StripeSecureCaptureResult = {
  reference: `secret-store://rorca/provider-credentials/${CAPTURE_ID}`,
  fingerprint: REPLACEMENT_FINGERPRINT,
  provenance: {
    schemaVersion: 'rorca.stripe-capture-provenance.v1',
    captureReceiptReference: `credential-capture://rorca/${CAPTURE_ID}`,
    provider: 'stripe',
    channel: 'trusted_local_operator',
    providerEvidenceId: '90000000-0000-4000-8000-000000000007',
    operatorId: 'operator:stripe-owner',
    capturedAt: '2026-08-24T13:57:00.000Z',
    targetBindingReference: BINDING.targetBindingReference,
  },
};

function cutover(state: StripeFailureCutoverSnapshot['state'] = 'READY_FOR_STAGING'): StripeFailureCutoverSnapshot {
  const rotation = intent();
  return {
    intentId: rotation.intentId,
    intentDigest: rotation.intentDigest,
    workspaceId: WORKSPACE_ID,
    bindingId: BINDING_ID,
    replacementBindingId: REPLACEMENT_BINDING_ID,
    targetBindingReference: BINDING.targetBindingReference,
    priorFingerprint: PRIOR_FINGERPRINT,
    replacementFingerprint: REPLACEMENT_FINGERPRINT,
    state,
  };
}

function status(
  fingerprint: string,
  value: StripeCredentialStatusReceipt['status'],
): StripeCredentialStatusReceipt {
  return {
    schemaVersion: 'rorca.stripe-credential-status-receipt.v1',
    fingerprint,
    status: value,
    mode: 'test',
    operation: 'payment_intents.read',
    resourceType: 'payment_intents',
    resourceId: 'pi_disposable_failure_canary',
    providerRequestReference: value === 'unknown' ? null : `req_${value}_${fingerprint.slice(-4)}`,
    evidenceCode: value === 'active'
      ? 'provider_operation_succeeded'
      : value === 'rejected'
        ? 'provider_authentication_rejected'
        : 'provider_readback_unavailable',
    observedAt: NOW.toISOString(),
  };
}

class MemoryFailureRepository implements StripeCredentialFailureRepository {
  rollback: StripeRollbackReceipt | null = null;
  emergencies: StripeEmergencyRotationRequest[] = [];
  reconciliations: StripeCredentialStatusReconciliation[] = [];
  quarantinedReference: string | null = null;

  async getRollback(): Promise<StripeRollbackReceipt | null> {
    return this.rollback;
  }

  async settleRollback(input: {
    receipt: StripeRollbackReceipt;
    replacementSecretReference: string;
  }): Promise<StripeRollbackReceipt> {
    this.quarantinedReference = input.replacementSecretReference;
    this.rollback ??= StripeRollbackReceiptSchema.parse(input.receipt);
    return this.rollback;
  }

  async createEmergency(request: StripeEmergencyRotationRequest): Promise<StripeEmergencyRotationRequest> {
    const existing = this.emergencies.find((candidate) =>
      candidate.evidence.providerRequestReference === request.evidence.providerRequestReference);
    if (existing) return existing;
    this.emergencies.push(StripeEmergencyRotationRequestSchema.parse(request));
    return request;
  }

  async createReconciliation(
    receipt: StripeCredentialStatusReconciliation,
  ): Promise<StripeCredentialStatusReconciliation> {
    this.reconciliations.push(receipt);
    return receipt;
  }

  async getReconciliation(
    _workspaceId: string,
    _intentId: string,
    evidenceDigest: string,
  ): Promise<StripeCredentialStatusReconciliation | null> {
    return this.reconciliations.find((receipt) => receipt.evidenceDigest === evidenceDigest) ?? null;
  }

  async listIncidents(): Promise<StripeCredentialIncident[]> {
    return [
      ...(this.rollback ? [{ kind: 'rollback' as const, receipt: this.rollback }] : []),
      ...this.emergencies.map((request) => ({ kind: 'emergency' as const, request })),
      ...this.reconciliations.map((receipt) => ({ kind: 'reconciliation' as const, receipt })),
    ];
  }
}

class MemoryRuntimeBinding implements RuntimeSecretBindingAdapter {
  activeFingerprint = REPLACEMENT_FINGERPRINT;
  restoreCalls: RuntimeSecretBindingRestoreInput[] = [];
  inspectFailure = false;

  private state(input: RuntimeSecretBindingInspectInput): RuntimeSecretBindingState {
    return {
      targetBindingReference: input.targetBindingReference,
      activeFingerprint: this.activeFingerprint,
      health: 'healthy',
      bindingGeneration: this.activeFingerprint === PRIOR_FINGERPRINT ? 7 : 8,
      observedAt: NOW.toISOString(),
    };
  }

  async inspect(input: RuntimeSecretBindingInspectInput): Promise<RuntimeSecretBindingState> {
    if (this.inspectFailure) throw new Error('runtime outcome unknown');
    return this.state(input);
  }

  async stage(_input: RuntimeSecretBindingStageInput): Promise<RuntimeSecretBindingState> {
    throw new Error('not used by failure service');
  }

  async restore(input: RuntimeSecretBindingRestoreInput): Promise<RuntimeSecretBindingState> {
    this.restoreCalls.push(input);
    assert.equal(input.expectedActiveFingerprint, REPLACEMENT_FINGERPRINT);
    assert.equal(input.retainedPriorFingerprint, PRIOR_FINGERPRINT);
    this.activeFingerprint = PRIOR_FINGERPRINT;
    return this.state(input);
  }

  async verifyStripeCredentialRejected(
    _input: RuntimeStripeRejectionVerificationInput,
  ): Promise<StripeOldKeyRejectionReceipt> {
    throw new Error('not used by failure service');
  }
}

class MemoryStatusReader implements StripeCredentialStatusReader {
  reads: StripeCredentialOperationInput[] = [];
  values = new Map<string, StripeCredentialStatusReceipt['status']>([
    [PRIOR_FINGERPRINT, 'active'],
    [REPLACEMENT_FINGERPRINT, 'active'],
  ]);

  async readStatus(input: StripeCredentialOperationInput): Promise<StripeCredentialStatusReceipt> {
    this.reads.push(input);
    return status(input.expectedFingerprint, this.values.get(input.expectedFingerprint) ?? 'unknown');
  }
}

function fixture() {
  const repository = new MemoryFailureRepository();
  const runtime = new MemoryRuntimeBinding();
  const statusReader = new MemoryStatusReader();
  const adapter = new StripeAuthorityProviderAdapter(async (workspaceId) =>
    workspaceId === WORKSPACE_ID ? [{
      id: BINDING.bindingId,
      workspace_id: BINDING.workspaceId,
      provider_account_id: BINDING.accountId,
      mode: BINDING.mode,
      application_id: BINDING.scope.applicationId,
      resource_type: BINDING.scope.resourceType,
      resource_id: BINDING.scope.resourceId,
      credential_class: BINDING.credentialClass,
      key_kind: BINDING.keyKind,
      permission_manifest: BINDING.permissionManifest,
      owner: BINDING.owner,
      fingerprint: BINDING.fingerprint,
      secret_store_reference: BINDING.secretStoreReference,
      target_binding_reference: BINDING.targetBindingReference,
      status: BINDING.status,
      binding_generation: BINDING.generation,
      last_verified_at: BINDING.lastVerifiedAt,
    }] : []);
  const service = new StripeCredentialFailureService(
    adapter,
    repository,
    runtime,
    statusReader,
    () => NOW,
  );
  return { repository, runtime, statusReader, service };
}

function emergencyFailure() {
  return StripeRuntimeAuthenticationFailureSchema.parse({
    schemaVersion: 'rorca.stripe-runtime-authentication-failure.v1',
    fingerprint: PRIOR_FINGERPRINT,
    mode: 'test',
    affectedResource: BINDING.scope,
    evidence: {
      evidenceType: 'stripe_runtime_authentication_failure',
      operation: 'payment_intents.read',
      providerHttpStatus: 401,
      providerRequestReference: 'req_runtime_auth_failure_001',
      targetBindingReference: BINDING.targetBindingReference,
      observedAt: NOW.toISOString(),
    },
  });
}

describe('Stripe credential failure authority', () => {
  it('restores the retained prior target, quarantines the replacement, and records a secret-free rollback', async () => {
    const { repository, runtime, statusReader, service } = fixture();
    const receipt = await service.rollbackPreRevocation({
      intent: intent(),
      cutover: cutover(),
      priorBinding: BINDING,
      capture: CAPTURE,
      failurePhase: 'CANARY',
      failureCode: 'STRIPE_CANARY_FAILED',
      now: NOW,
    });

    assert.equal(receipt.disposition, 'ROLLED_BACK');
    assert.equal(receipt.priorBindingStatus, 'retained_active');
    assert.equal(receipt.replacementSecretStatus, 'quarantined');
    assert.equal(receipt.targetDisposition, 'prior_restored');
    assert.equal(runtime.activeFingerprint, PRIOR_FINGERPRINT);
    assert.equal(runtime.restoreCalls.length, 1);
    assert.equal(repository.quarantinedReference, CAPTURE.reference);
    assert.deepEqual(statusReader.reads.map((read) => read.expectedFingerprint), [
      PRIOR_FINGERPRINT,
      REPLACEMENT_FINGERPRINT,
    ]);
    assert.doesNotMatch(
      JSON.stringify(receipt),
      /(?:sk|rk)_(?:test|live)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+/,
    );
  });

  it('reads back uncertainty once, blocks retry for manual reconciliation, and replays the receipt', async () => {
    const { repository, runtime, statusReader, service } = fixture();
    statusReader.values.set(REPLACEMENT_FINGERPRINT, 'unknown');
    const request = {
      intent: intent(),
      cutover: cutover('GRACE_PERIOD'),
      priorBinding: BINDING,
      capture: CAPTURE,
      failurePhase: 'PRE_REVOCATION_VERIFICATION' as const,
      failureCode: 'POST_CUTOVER_VERIFICATION_FAILED' as const,
      now: NOW,
    };

    const receipt = await service.rollbackPreRevocation(request);
    const replay = await service.rollbackPreRevocation(request);

    assert.equal(receipt.disposition, 'MANUAL_RECONCILIATION');
    assert.equal(receipt.replacementSecretStatus, 'quarantined');
    assert.equal(receipt.manualReconciliation?.reasonCode, 'replacement_provider_status_unresolved');
    assert.equal(replay.receiptId, receipt.receiptId);
    assert.equal(statusReader.reads.length, 2);
    assert.equal(runtime.restoreCalls.length, 1);
    assert.equal(repository.rollback?.receiptId, receipt.receiptId);
  });

  it('creates an evidence-only emergency request with immutable least-privilege authority', async () => {
    const { repository, service } = fixture();
    const request = await service.createEmergencyRequest({
      workspaceId: WORKSPACE_ID,
      bindingId: BINDING_ID,
      failure: emergencyFailure(),
      now: NOW,
    });

    assert.equal(request.requestType, 'RUNTIME_AUTHENTICATION_FAILURE');
    assert.equal(request.bindingId, BINDING_ID);
    assert.equal(request.fingerprint, PRIOR_FINGERPRINT);
    assert.deepEqual(request.permissionManifest, BINDING.permissionManifest);
    assert.deepEqual(request.affectedResource, BINDING.scope);
    assert.deepEqual(request.authority, {
      canGrant: false,
      canBroadenPermissions: false,
      canCrossWorkspace: false,
      canCrossMode: false,
      canInjectSecret: false,
      requiresDashboardAuthentication: true,
    });
    assert.equal(repository.emergencies.length, 1);
    assert.doesNotMatch(
      JSON.stringify(request),
      /(?:sk|rk)_(?:test|live)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+/,
    );
  });

  it('rejects cross-mode, cross-resource, broadened, and credential-bearing emergency evidence', async () => {
    const { service } = fixture();
    const base = emergencyFailure();
    await assert.rejects(service.createEmergencyRequest({
      workspaceId: WORKSPACE_ID,
      bindingId: BINDING_ID,
      failure: { ...base, mode: 'live' } as typeof base,
    }));
    await assert.rejects(service.createEmergencyRequest({
      workspaceId: WORKSPACE_ID,
      bindingId: BINDING_ID,
      failure: {
        ...base,
        affectedResource: { ...base.affectedResource, resourceId: 'another-target' },
      },
    }));
    await assert.rejects(service.createEmergencyRequest({
      workspaceId: WORKSPACE_ID,
      bindingId: BINDING_ID,
      failure: {
        ...base,
        evidence: { ...base.evidence, operation: 'payment_intents.write' },
      },
    }));
    const credential = ['rk', 'test', 'forbiddenEmergencySecret123'].join('_');
    assert.throws(() => StripeRuntimeAuthenticationFailureSchema.parse({
      ...base,
      evidence: { ...base.evidence, providerRequestReference: credential },
    }));
  });

  it('requires manual reconciliation for unknown revocation status and resolves exact readback evidence', async () => {
    const { repository, statusReader, service } = fixture();
    statusReader.values.set(PRIOR_FINGERPRINT, 'unknown');
    const evidenceDigest = `sha256:${createHash('sha256').update('evidence-one').digest('hex')}`;
    const manual = await service.reconcileRevocationOutcome({
      intent: intent(),
      cutover: cutover('GRACE_PERIOD'),
      priorBinding: BINDING,
      capture: CAPTURE,
      evidenceDigest,
      now: NOW,
    });
    assert.equal(manual.receipt.disposition, 'MANUAL_RECONCILIATION');
    assert.equal(manual.receipt.retryAllowed, false);
    assert.equal(manual.oldKeyRejection, null);

    statusReader.values.set(PRIOR_FINGERPRINT, 'rejected');
    const resolved = await service.reconcileRevocationOutcome({
      intent: intent(),
      cutover: cutover('GRACE_PERIOD'),
      priorBinding: BINDING,
      capture: CAPTURE,
      evidenceDigest: `sha256:${createHash('sha256').update('evidence-two').digest('hex')}`,
      now: NOW,
    });
    assert.equal(resolved.receipt.disposition, 'PROVIDER_READBACK_RESOLVED');
    assert.equal(resolved.receipt.retryAllowed, true);
    assert.equal(resolved.oldKeyRejection?.result, 'authentication_rejected');
    assert.equal(repository.reconciliations.length, 2);
  });
});
