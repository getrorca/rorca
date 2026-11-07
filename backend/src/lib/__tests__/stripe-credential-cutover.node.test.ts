/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  StripeCredentialCutoverService,
  StripeCredentialCutoverStateSchema,
  StripeDashboardRevocationEvidenceUnsignedSchema,
  StripeDashboardRevocationEvidenceVerifier,
  type StripeCredentialCutoverRepository,
  type StripeCredentialCutoverState,
  type StripeDashboardRevocationEvidence,
  type StripeCutoverFailureHandler,
} from '../stripe-credential-cutover';
import type {
  StripeCanaryReceipt,
  StripeCredentialCanaryAdapter,
  StripeCredentialOperationInput,
  StripeCredentialStatusReceipt,
  StripeOldKeyRejectionReceipt,
} from '../stripe-credential-canary';
import type { StripeSecureCaptureResult } from '../stripe-credential-capture';
import {
  StripeCredentialStatusReconciliationSchema,
  StripeRollbackReceiptSchema,
  type StripeCredentialStatusReconciliation,
  type StripeRollbackReceipt,
} from '../stripe-credential-failure';
import { StripeAuthorityProviderAdapter } from '../stripe-authority-provider-adapter';
import {
  createStripeRotationIntent,
  stripeRotationIntentDigest,
  type StripeRotationIntentInput,
} from '../stripe-credential-rotation';
import type { StripeRotationRecord } from '../stripe-credential-rotation-store';
import type {
  RuntimeSecretBindingAdapter,
  RuntimeSecretBindingInspectInput,
  RuntimeSecretBindingRestoreInput,
  RuntimeSecretBindingStageInput,
  RuntimeSecretBindingState,
  RuntimeStripeRejectionVerificationInput,
} from '../runtime-secret-binding-adapter';
import { stableWalJson } from '../trusted-wal';

const WORKSPACE_ID = 'workspace-stripe-cutover';
const BINDING_ID = '80000000-0000-4000-8000-000000000001';
const INTENT_ID = '80000000-0000-4000-8000-000000000002';
const CAPTURE_ID = '80000000-0000-4000-8000-000000000003';
const PRIOR_FINGERPRINT = `sha256:${'a'.repeat(64)}`;
const REPLACEMENT_FINGERPRINT = `sha256:${'b'.repeat(64)}`;
const TARGET_REFERENCE = 'runtime-binding://rorca/disposable-cutover-target';
const CAPTURE: StripeSecureCaptureResult = {
  reference: `secret-store://rorca/provider-credentials/${CAPTURE_ID}`,
  fingerprint: REPLACEMENT_FINGERPRINT,
  provenance: {
    schemaVersion: 'rorca.stripe-capture-provenance.v1',
    captureReceiptReference: `credential-capture://rorca/${CAPTURE_ID}`,
    provider: 'stripe',
    channel: 'trusted_local_operator',
    providerEvidenceId: '80000000-0000-4000-8000-000000000004',
    operatorId: 'operator:stripe-owner',
    capturedAt: '2026-08-24T11:59:00.000Z',
    targetBindingReference: TARGET_REFERENCE,
  },
};

function rotationInput(): StripeRotationIntentInput {
  return {
    workspaceId: WORKSPACE_ID,
    bindingId: BINDING_ID,
    accountId: 'acct_rorca_cutover',
    currentFingerprint: PRIOR_FINGERPRINT,
    permissionManifest: ['payment_intents.read'],
    mode: 'test',
    targetBindingReference: TARGET_REFERENCE,
    replacementCredentialClass: 'restricted_api_key',
    canary: {
      operation: 'payment_intents.read',
      resourceType: 'payment_intents',
      resourceId: 'pi_disposable_cutover',
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

function rotationRecord(): StripeRotationRecord {
  const input = rotationInput();
  const intent = createStripeRotationIntent({
    intentId: INTENT_ID,
    intent: input,
    approval: {
      schemaVersion: 'rorca.stripe-rotation-approval.v1',
      intentDigest: stripeRotationIntentDigest(input),
      authorityReceiptId: '80000000-0000-4000-8000-000000000005',
      approvedBy: 'operator:rorca-owner',
      approvedAt: '2026-08-24T11:55:00.000Z',
      expiresAt: '2026-08-24T12:30:00.000Z',
    },
    binding: {
      providerId: 'stripe',
      bindingId: BINDING_ID,
      workspaceId: WORKSPACE_ID,
      accountId: input.accountId,
      mode: 'test',
      scope: {
        applicationId: 'rorca-disposable-fixture',
        resourceType: 'payment_intents',
        resourceId: 'disposable-target',
      },
      credentialClass: 'restricted_api_key',
      keyKind: 'restricted',
      permissionManifest: [...input.permissionManifest],
      owner: 'rorca-stripe-operator',
      fingerprint: PRIOR_FINGERPRINT,
      secretStoreReference: 'secret-store://rorca/current-cutover-key',
      targetBindingReference: TARGET_REFERENCE,
      status: 'active',
      generation: 4,
      lastVerifiedAt: '2026-08-24T11:30:00.000Z',
    },
    now: new Date('2026-08-24T11:56:00.000Z'),
  });
  return {
    intent,
    lifecycle: {
      state: 'READY_FOR_STAGING',
      timeoutDisposition: 'running',
      activeElapsedMs: 0,
      waitingSince: intent.createdAt,
      resumedAt: '2026-08-24T11:59:00.000Z',
      resumeCount: 1,
      providerEvidenceDigest: `sha256:${'c'.repeat(64)}`,
      capture: CAPTURE,
    },
  };
}

class MemoryCutoverRepository implements StripeCredentialCutoverRepository {
  state: StripeCredentialCutoverState | null = null;
  initializeCalls = 0;
  transitionCalls = 0;
  completeCalls = 0;

  async get(): Promise<StripeCredentialCutoverState | null> {
    return this.state;
  }

  async initialize(state: StripeCredentialCutoverState): Promise<StripeCredentialCutoverState> {
    this.initializeCalls += 1;
    this.state ??= StripeCredentialCutoverStateSchema.parse(state);
    return this.state;
  }

  async transition(
    _workspaceId: string,
    _intentId: string,
    expectedState: StripeCredentialCutoverState['state'],
    next: StripeCredentialCutoverState,
  ): Promise<StripeCredentialCutoverState> {
    assert.equal(this.state?.state, expectedState);
    this.transitionCalls += 1;
    this.state = StripeCredentialCutoverStateSchema.parse(next);
    return this.state;
  }

  async complete(input: {
    expectedState: 'WAITING_FOR_REVOCATION';
    state: StripeCredentialCutoverState;
  }): Promise<StripeCredentialCutoverState> {
    assert.equal(this.state?.state, input.expectedState);
    this.completeCalls += 1;
    this.state = StripeCredentialCutoverStateSchema.parse(input.state);
    return this.state;
  }
}

class MemoryRuntimeBinding implements RuntimeSecretBindingAdapter {
  activeFingerprint = PRIOR_FINGERPRINT;
  inspectCalls = 0;
  stageCalls = 0;
  restoreCalls: RuntimeSecretBindingRestoreInput[] = [];
  rejectionCalls: RuntimeStripeRejectionVerificationInput[] = [];
  failNextRejection = false;
  rejectionReceiptOverrides: Partial<StripeOldKeyRejectionReceipt> = {};

  private state(targetBindingReference: string): RuntimeSecretBindingState {
    return {
      targetBindingReference,
      activeFingerprint: this.activeFingerprint,
      health: 'healthy',
      bindingGeneration: this.activeFingerprint === PRIOR_FINGERPRINT ? 4 : 5,
      observedAt: '2026-08-24T12:00:00.000Z',
    };
  }

  async inspect(input: RuntimeSecretBindingInspectInput): Promise<RuntimeSecretBindingState> {
    this.inspectCalls += 1;
    return this.state(input.targetBindingReference);
  }

  async stage(input: RuntimeSecretBindingStageInput): Promise<RuntimeSecretBindingState> {
    this.stageCalls += 1;
    assert.equal(input.expectedCurrentFingerprint, this.activeFingerprint);
    assert.equal(input.replacementSecretReference, CAPTURE.reference);
    this.activeFingerprint = input.replacementFingerprint;
    return this.state(input.targetBindingReference);
  }

  async restore(input: RuntimeSecretBindingRestoreInput): Promise<RuntimeSecretBindingState> {
    this.restoreCalls.push(input);
    assert.equal(input.expectedActiveFingerprint, this.activeFingerprint);
    this.activeFingerprint = input.retainedPriorFingerprint;
    return this.state(input.targetBindingReference);
  }

  async verifyStripeCredentialRejected(
    input: RuntimeStripeRejectionVerificationInput,
  ): Promise<StripeOldKeyRejectionReceipt> {
    this.rejectionCalls.push(input);
    if (this.failNextRejection) {
      this.failNextRejection = false;
      throw new Error('old key remains accepted');
    }
    return {
      schemaVersion: 'rorca.stripe-old-key-rejection-receipt.v1',
      mode: 'test',
      operation: input.canary.operation,
      resourceType: input.canary.resourceType,
      resourceId: input.canary.resourceId,
      providerRequestReference: 'req_old_key_rejected',
      rejectedAt: '2026-08-24T12:13:00.000Z',
      result: 'authentication_rejected',
      ...this.rejectionReceiptOverrides,
    };
  }
}

class MemoryCanary implements StripeCredentialCanaryAdapter {
  runCalls: StripeCredentialOperationInput[] = [];
  rejectionCalls: StripeCredentialOperationInput[] = [];
  failNextRun = false;
  observedAt = '2026-08-24T12:00:03.000Z';

  async runCanary(input: StripeCredentialOperationInput, now?: Date): Promise<StripeCanaryReceipt> {
    this.runCalls.push(input);
    if (this.failNextRun) {
      this.failNextRun = false;
      throw new Error('simulated crash after target stage');
    }
    return {
      schemaVersion: 'rorca.stripe-canary-receipt.v1',
      mode: 'test',
      operation: input.canary.operation,
      resourceType: input.canary.resourceType,
      resourceId: input.canary.resourceId,
      providerRequestReference: `req_canary_${this.runCalls.length}`,
      verifiedAt: (now ?? new Date(this.observedAt)).toISOString(),
    };
  }

  async verifyRejected(
    input: StripeCredentialOperationInput,
    now = new Date(),
  ): Promise<StripeOldKeyRejectionReceipt> {
    this.rejectionCalls.push(input);
    return {
      schemaVersion: 'rorca.stripe-old-key-rejection-receipt.v1',
      mode: 'test',
      operation: input.canary.operation,
      resourceType: input.canary.resourceType,
      resourceId: input.canary.resourceId,
      providerRequestReference: 'req_old_key_rejected',
      rejectedAt: now.toISOString(),
      result: 'authentication_rejected',
    };
  }
}

function providerStatus(
  fingerprint: string,
  status: StripeCredentialStatusReceipt['status'],
): StripeCredentialStatusReceipt {
  return {
    schemaVersion: 'rorca.stripe-credential-status-receipt.v1',
    fingerprint,
    status,
    mode: 'test',
    operation: 'payment_intents.read',
    resourceType: 'payment_intents',
    resourceId: 'disposable-canary',
    providerRequestReference: status === 'unknown' ? null : `req_${status}`,
    evidenceCode: status === 'active'
      ? 'provider_operation_succeeded'
      : status === 'rejected'
        ? 'provider_authentication_rejected'
        : 'provider_readback_unavailable',
    observedAt: '2026-08-24T12:13:00.000Z',
  };
}

class MemoryFailureHandler implements StripeCutoverFailureHandler {
  rollback: StripeRollbackReceipt | null = null;
  rollbackCalls: Array<Parameters<StripeCutoverFailureHandler['rollbackPreRevocation']>[0]> = [];
  reconciliationCalls:
    Array<Parameters<StripeCutoverFailureHandler['reconcileRevocationOutcome']>[0]> = [];
  reconciliations: StripeCredentialStatusReconciliation[] = [];
  priorReconciliationStatus: StripeCredentialStatusReceipt['status'] = 'active';
  replacementReconciliationStatus: StripeCredentialStatusReceipt['status'] = 'active';

  constructor(private readonly runtime: MemoryRuntimeBinding) {}

  async getRollback(): Promise<StripeRollbackReceipt | null> {
    return this.rollback;
  }


  async getReconciliation(
    _workspaceId: string,
    _intentId: string,
    evidenceDigest: string,
  ): Promise<StripeCredentialStatusReconciliation | null> {
    return this.reconciliations.find((receipt) => receipt.evidenceDigest === evidenceDigest) ?? null;
  }
  async rollbackPreRevocation(
    input: Parameters<StripeCutoverFailureHandler['rollbackPreRevocation']>[0],
  ): Promise<StripeRollbackReceipt> {
    this.rollbackCalls.push(input);
    this.runtime.activeFingerprint = input.intent.currentFingerprint;
    const targetReadback = await this.runtime.inspect({
      workspaceId: input.intent.workspaceId,
      provider: 'stripe',
      accountId: input.intent.accountId,
      mode: 'test',
      targetBindingReference: input.intent.targetBindingReference,
      timeoutMs: input.intent.rollback.verificationTimeoutMs,
    });
    this.rollback ??= StripeRollbackReceiptSchema.parse({
      schemaVersion: 'rorca.stripe-rollback-receipt.v1',
      receiptId: '80000000-0000-4000-8000-000000000007',
      intentId: input.intent.intentId,
      intentDigest: input.intent.intentDigest,
      workspaceId: input.intent.workspaceId,
      bindingId: input.intent.bindingId,
      replacementBindingId: input.cutover.replacementBindingId,
      mode: 'test',
      targetBindingReference: input.intent.targetBindingReference,
      priorFingerprint: input.intent.currentFingerprint,
      replacementFingerprint: input.capture.fingerprint,
      failurePhase: input.failurePhase,
      failureCode: input.failureCode,
      disposition: 'ROLLED_BACK',
      priorBindingStatus: 'retained_active',
      replacementSecretStatus: 'quarantined',
      targetDisposition: 'prior_restored',
      priorProviderStatus: providerStatus(input.intent.currentFingerprint, 'active'),
      replacementProviderStatus: providerStatus(input.capture.fingerprint, 'active'),
      targetReadback,
      manualReconciliation: null,
      settledAt: (input.now ?? new Date('2026-08-24T12:00:00.000Z')).toISOString(),
    });
    return this.rollback;
  }

  async reconcileRevocationOutcome(
    input: Parameters<StripeCutoverFailureHandler['reconcileRevocationOutcome']>[0],
  ): Promise<{
    receipt: StripeCredentialStatusReconciliation;
    oldKeyRejection: StripeOldKeyRejectionReceipt | null;
  }> {
    this.reconciliationCalls.push(input);
    const priorProviderStatus = providerStatus(
      input.intent.currentFingerprint,
      this.priorReconciliationStatus,
    );
    const replacementProviderStatus = providerStatus(
      input.capture.fingerprint,
      this.replacementReconciliationStatus,
    );
    const hasUnknown = priorProviderStatus.status === 'unknown'
      || replacementProviderStatus.status === 'unknown';
    const receipt = StripeCredentialStatusReconciliationSchema.parse({
      schemaVersion: 'rorca.stripe-status-reconciliation-receipt.v1',
      receiptId: '80000000-0000-4000-8000-000000000008',
      intentId: input.intent.intentId,
      intentDigest: input.intent.intentDigest,
      evidenceDigest: input.evidenceDigest,
      workspaceId: input.intent.workspaceId,
      bindingId: input.intent.bindingId,
      replacementBindingId: input.cutover.replacementBindingId,
      priorFingerprint: input.intent.currentFingerprint,
      replacementFingerprint: input.capture.fingerprint,
      trigger: 'REVOCATION_OUTCOME_UNKNOWN',
      priorProviderStatus,
      replacementProviderStatus,
      disposition: hasUnknown ? 'MANUAL_RECONCILIATION' : 'PROVIDER_READBACK_RESOLVED',
      retryAllowed: !hasUnknown,
      requiredDashboardAuthentication: true,
      reconciledAt: (input.now ?? new Date('2026-08-24T12:13:00.000Z')).toISOString(),
    });
    this.reconciliations.push(receipt);
    const oldKeyRejection = priorProviderStatus.status === 'rejected'
      && replacementProviderStatus.status === 'active'
      ? {
          schemaVersion: 'rorca.stripe-old-key-rejection-receipt.v1' as const,
          mode: 'test' as const,
          operation: priorProviderStatus.operation,
          resourceType: priorProviderStatus.resourceType,
          resourceId: priorProviderStatus.resourceId,
          providerRequestReference: priorProviderStatus.providerRequestReference!,
          rejectedAt: priorProviderStatus.observedAt,
          result: 'authentication_rejected' as const,
        }
      : null;
    return { receipt, oldKeyRejection };
  }
}

interface CutoverFixture {
  record: StripeRotationRecord;
  repository: MemoryCutoverRepository;
  runtime: MemoryRuntimeBinding;
  canary: MemoryCanary;
  failureHandler: MemoryFailureHandler;
  service: StripeCredentialCutoverService;
  revocationEvidence: () => StripeDashboardRevocationEvidence;
  bindingStatus: () => 'active';
}

function fixture(clock: () => Date = () => new Date()): CutoverFixture {
  const record = rotationRecord();
  const bindingStatus = 'active' as const;
  const stripeAdapter = new StripeAuthorityProviderAdapter(async () => [{
    id: BINDING_ID,
    workspace_id: WORKSPACE_ID,
    provider_account_id: record.intent.accountId,
    mode: 'test',
    application_id: 'rorca-disposable-fixture',
    resource_type: 'payment_intents',
    resource_id: 'disposable-target',
    credential_class: 'restricted_api_key',
    key_kind: 'restricted',
    permission_manifest: ['payment_intents.read'],
    owner: 'rorca-stripe-operator',
    fingerprint: PRIOR_FINGERPRINT,
    secret_store_reference: 'secret-store://rorca/current-cutover-key',
    target_binding_reference: TARGET_REFERENCE,
    status: bindingStatus,
    binding_generation: 4,
    last_verified_at: new Date('2026-08-24T11:30:00.000Z'),
  }]);
  const repository = new MemoryCutoverRepository();
  const runtime = new MemoryRuntimeBinding();
  const canary = new MemoryCanary();
  const failureHandler = new MemoryFailureHandler(runtime);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const verifier = new StripeDashboardRevocationEvidenceVerifier(() => [{
    keyId: 'stripe-dashboard-cutover-key',
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    workspaceId: WORKSPACE_ID,
    accountId: record.intent.accountId,
    operatorIds: ['operator:stripe-owner'],
    modes: ['test'],
  }]);
  const service = new StripeCredentialCutoverService(
    async () => record,
    stripeAdapter,
    repository,
    runtime,
    canary,
    verifier,
    async <T>(_key: string, operation: () => Promise<T>) => operation(),
    clock,
    failureHandler,
  );

  function revocationEvidence(): StripeDashboardRevocationEvidence {
    const unsigned = StripeDashboardRevocationEvidenceUnsignedSchema.parse({
      schemaVersion: 'rorca.stripe-dashboard-revocation-evidence.v1',
      evidenceId: '80000000-0000-4000-8000-000000000006',
      intentDigest: record.intent.intentDigest,
      workspaceId: WORKSPACE_ID,
      accountId: record.intent.accountId,
      mode: 'test',
      priorFingerprint: PRIOR_FINGERPRINT,
      dashboardSessionReference: 'stripe-dashboard-session://rorca/revocation-001',
      dashboardReauthenticatedAt: '2026-08-24T12:12:00.000Z',
      revokedAt: '2026-08-24T12:13:00.000Z',
      operatorId: 'operator:stripe-owner',
      attestationKeyId: 'stripe-dashboard-cutover-key',
    });
    return {
      ...unsigned,
      signature: sign(null, Buffer.from(stableWalJson(unsigned), 'utf8'), privateKey).toString('base64url'),
    };
  }

  return {
    record,
    repository,
    runtime,
    canary,
    service,
    failureHandler,
    revocationEvidence,
    bindingStatus: () => bindingStatus,
  };
}

describe('Stripe credential cutover state machine', () => {
  it('rolls back a canary failure and closes the cutover against retry', async () => {
    const subject = fixture();
    subject.canary.failNextRun = true;
    const request = {
      workspaceId: WORKSPACE_ID,
      intentId: INTENT_ID,
      intentDigest: subject.record.intent.intentDigest,
      now: new Date('2026-08-24T12:00:00.000Z'),
    };

    await assert.rejects(
      subject.service.advance(request),
      /retained prior binding was restored and the replacement quarantined/,
    );
    assert.equal(subject.runtime.stageCalls, 1);
    assert.equal(subject.runtime.activeFingerprint, PRIOR_FINGERPRINT);
    assert.equal(subject.repository.state?.state, 'READY_FOR_STAGING');
    assert.equal(subject.failureHandler.rollbackCalls.length, 1);
    assert.equal(subject.failureHandler.rollback?.failurePhase, 'CANARY');
    assert.equal(subject.failureHandler.rollback?.replacementSecretStatus, 'quarantined');

    await assert.rejects(
      subject.service.advance(request),
      /closed by an immutable rollback receipt/,
    );
    assert.equal(subject.runtime.stageCalls, 1);
    assert.equal(subject.repository.initializeCalls, 1);
    assert.equal(subject.failureHandler.rollbackCalls.length, 1);
    assert.equal(subject.bindingStatus(), 'active');
    assert.doesNotMatch(
      JSON.stringify(subject.failureHandler.rollback),
      /(?:sk|rk)_(?:test|live)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+/,
    );
  });

  it('starts the full grace period only after provider and target verification settle', async () => {
    let clockCalls = 0;
    let subject!: CutoverFixture;
    const observations = [
      new Date('2026-08-24T12:00:00.000Z'),
      new Date('2026-08-24T12:00:05.000Z'),
    ];
    subject = fixture(() => {
      const observedAt = observations[clockCalls]!;
      clockCalls += 1;
      if (clockCalls === 2) {
        assert.equal(subject.canary.runCalls.length, 1);
        assert.equal(subject.runtime.inspectCalls, 2);
      }
      return observedAt;
    });

    const state = await subject.service.advance({
      workspaceId: WORKSPACE_ID,
      intentId: INTENT_ID,
      intentDigest: subject.record.intent.intentDigest,
    });

    assert.equal(state.state, 'GRACE_PERIOD');
    assert.equal(clockCalls, 2);
    if (state.state === 'GRACE_PERIOD') {
      assert.equal(state.canary.verifiedAt, '2026-08-24T12:00:03.000Z');
      assert.equal(state.graceStartedAt, '2026-08-24T12:00:05.000Z');
      assert.equal(state.graceExpiresAt, '2026-08-24T12:05:05.000Z');
    }
  });

  it('replays grace without side effects and permits revocation only after post-cutover checks', async () => {
    const subject = fixture();
    const request = {
      workspaceId: WORKSPACE_ID,
      intentId: INTENT_ID,
      intentDigest: subject.record.intent.intentDigest,
    };
    await subject.service.advance({ ...request, now: new Date('2026-08-24T12:00:00.000Z') });
    const stageCalls = subject.runtime.stageCalls;
    const canaryCalls = subject.canary.runCalls.length;

    const replay = await subject.service.advance({ ...request, now: new Date('2026-08-24T12:04:59.000Z') });
    assert.equal(replay.state, 'GRACE_PERIOD');
    assert.equal(subject.runtime.stageCalls, stageCalls);
    assert.equal(subject.canary.runCalls.length, canaryCalls);
    assert.equal(subject.bindingStatus(), 'active');

    const waiting = await subject.service.advance({ ...request, now: new Date('2026-08-24T12:11:00.000Z') });
    assert.equal(waiting.state, 'WAITING_FOR_REVOCATION');
    assert.equal(subject.canary.runCalls.length, canaryCalls + 1);
    assert.equal(subject.bindingStatus(), 'active');
    if (waiting.state === 'WAITING_FOR_REVOCATION') {
      assert.equal(waiting.revocationCeremony.prohibitedActions.includes(
        'revoke_before_post_cutover_verification',
      ), true);
      assert.equal(waiting.postCutoverCanary.operation, 'payment_intents.read');
    }
  });

  it('settles only signed revocation plus verified old-key rejection and replays once', async () => {
    const subject = fixture();
    const request = {
      workspaceId: WORKSPACE_ID,
      intentId: INTENT_ID,
      intentDigest: subject.record.intent.intentDigest,
    };
    await subject.service.advance({ ...request, now: new Date('2026-08-24T12:00:00.000Z') });
    await subject.service.advance({ ...request, now: new Date('2026-08-24T12:11:00.000Z') });
    const evidence = subject.revocationEvidence();

    subject.runtime.failNextRejection = true;
    await assert.rejects(subject.service.completeRevocation({
      ...request,
      evidence,
      now: new Date('2026-08-24T12:13:00.000Z'),
    }), /provider readback did not verify/);
    assert.equal(subject.failureHandler.reconciliationCalls.length, 1);
    assert.equal(subject.repository.completeCalls, 0);
    assert.equal(subject.repository.state?.state, 'WAITING_FOR_REVOCATION');

    const completed = await subject.service.completeRevocation({
      ...request,
      evidence,
      now: new Date('2026-08-24T12:13:00.000Z'),
    });
    assert.equal(completed.state, 'COMPLETED');
    assert.equal(subject.canary.rejectionCalls.length, 0);
    assert.equal(subject.runtime.rejectionCalls.length, 2);
    assert.equal(subject.runtime.rejectionCalls[1]?.retainedPriorFingerprint, PRIOR_FINGERPRINT);
    assert.equal(subject.runtime.rejectionCalls[1]?.expectedActiveFingerprint, REPLACEMENT_FINGERPRINT);
    assert.equal(subject.runtime.rejectionCalls[1]?.canary.operation, 'payment_intents.read');
    assert.equal(subject.repository.completeCalls, 1);
    if (completed.state === 'COMPLETED') {
      assert.equal(completed.oldKeyRejection.result, 'authentication_rejected');
      assert.equal(completed.priorCredentialStatus, 'revoked');
    }

    const replay = await subject.service.completeRevocation({
      ...request,
      evidence,
      now: new Date('2026-08-24T12:14:00.000Z'),
    });
    assert.equal(replay.state, 'COMPLETED');
    assert.equal(subject.canary.rejectionCalls.length, 0);
    assert.equal(subject.runtime.rejectionCalls.length, 2);
    assert.equal(subject.repository.completeCalls, 1);
  });

  it('persists unknown provider status as a manual blocker before any retry', async () => {
    const subject = fixture();
    const request = {
      workspaceId: WORKSPACE_ID,
      intentId: INTENT_ID,
      intentDigest: subject.record.intent.intentDigest,
    };
    await subject.service.advance({ ...request, now: new Date('2026-08-24T12:00:00.000Z') });
    await subject.service.advance({ ...request, now: new Date('2026-08-24T12:11:00.000Z') });
    const evidence = subject.revocationEvidence();
    subject.runtime.failNextRejection = true;
    subject.failureHandler.priorReconciliationStatus = 'unknown';

    await assert.rejects(subject.service.completeRevocation({
      ...request,
      evidence,
      now: new Date('2026-08-24T12:13:00.000Z'),
    }), /unknown and requires manual reconciliation/);
    assert.equal(subject.failureHandler.reconciliations[0]?.retryAllowed, false);
    assert.equal(subject.runtime.rejectionCalls.length, 1);

    await assert.rejects(subject.service.completeRevocation({
      ...request,
      evidence,
      now: new Date('2026-08-24T12:14:00.000Z'),
    }), /requires manual reconciliation before revocation retry/);
    assert.equal(subject.runtime.rejectionCalls.length, 1);
    assert.equal(subject.repository.completeCalls, 0);
  });

  it('rejects unrelated or stale old-key rejection evidence without settling', async () => {
    const subject = fixture();
    const request = {
      workspaceId: WORKSPACE_ID,
      intentId: INTENT_ID,
      intentDigest: subject.record.intent.intentDigest,
    };
    await subject.service.advance({ ...request, now: new Date('2026-08-24T12:00:00.000Z') });
    await subject.service.advance({ ...request, now: new Date('2026-08-24T12:11:00.000Z') });
    const evidence = subject.revocationEvidence();

    subject.runtime.rejectionReceiptOverrides = { operation: 'customers.read' };
    await assert.rejects(subject.service.completeRevocation({
      ...request,
      evidence,
      now: new Date('2026-08-24T12:13:00.000Z'),
    }), /provider readback did not verify/);
    assert.equal(subject.repository.completeCalls, 0);
    assert.equal(subject.repository.state?.state, 'WAITING_FOR_REVOCATION');

    subject.runtime.rejectionReceiptOverrides = {
      operation: 'payment_intents.read',
      rejectedAt: '2026-08-24T12:12:59.000Z',
    };
    await assert.rejects(subject.service.completeRevocation({
      ...request,
      evidence,
      now: new Date('2026-08-24T12:13:00.000Z'),
    }), /provider readback did not verify/);
    assert.equal(subject.repository.completeCalls, 0);
    assert.equal(subject.repository.state?.state, 'WAITING_FOR_REVOCATION');
    assert.equal(subject.failureHandler.reconciliationCalls.length, 2);
  });
});
