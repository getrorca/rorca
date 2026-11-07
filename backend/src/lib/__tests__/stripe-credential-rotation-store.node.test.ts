/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  StoredStripeCapture,
  StripeCredentialSecretStore,
} from '../stripe-credential-capture';
import { StripeAuthorityProviderAdapter, type StripeProviderBinding } from '../stripe-authority-provider-adapter';
import {
  createStripeRotationIntent,
  stripeRotationIntentDigest,
  type StripeRotationIntent,
  type StripeRotationIntentInput,
} from '../stripe-credential-rotation';
import {
  resumeStripeRotationRecord,
  StripeCredentialRotationService,
  StripeRotationAuthenticationCompletionSchema,
  type StripeRotationIntentRepository,
  type StripeRotationRecord,
} from '../stripe-credential-rotation-store';
import { ConflictError, ForbiddenError } from '../errors';

const CREATED_AT = new Date('2026-08-23T10:00:00.000Z');
const RESUMED_AT = new Date('2026-08-23T15:00:00.000Z');
const INTENT_ID = '50000000-0000-4000-8000-000000000001';
const CAPTURE_ID = '50000000-0000-4000-8000-000000000002';

const BINDING: StripeProviderBinding = {
  providerId: 'stripe',
  bindingId: '50000000-0000-4000-8000-000000000003',
  workspaceId: 'workspace-stripe-resume',
  accountId: 'acct_rorca_resume',
  mode: 'test',
  scope: {
    applicationId: 'rorca-disposable-fixture',
    resourceType: 'payment_intents',
    resourceId: 'disposable-target',
  },
  credentialClass: 'restricted_api_key',
  keyKind: 'restricted',
  permissionManifest: ['payment_intents.read'],
  owner: 'rorca-stripe-operator',
  fingerprint: `sha256:${'a'.repeat(64)}`,
  secretStoreReference: 'secret-store://rorca/current-resume-key',
  targetBindingReference: 'runtime-binding://rorca/disposable-target',
  status: 'active',
  generation: 4,
  lastVerifiedAt: '2026-08-23T09:30:00.000Z',
};

function rotationInput(): StripeRotationIntentInput {
  return {
    workspaceId: BINDING.workspaceId,
    bindingId: BINDING.bindingId,
    accountId: BINDING.accountId,
    currentFingerprint: BINDING.fingerprint,
    permissionManifest: [...BINDING.permissionManifest],
    mode: BINDING.mode,
    targetBindingReference: BINDING.targetBindingReference,
    replacementCredentialClass: 'restricted_api_key',
    canary: {
      operation: 'payment_intents.read',
      resourceType: 'payment_intents',
      resourceId: 'disposable-canary',
      timeoutMs: 10_000,
    },
    gracePeriodSeconds: 300,
    rollback: {
      strategy: 'restore_previous_binding',
      keepPriorCredentialActive: true,
      quarantineReplacement: true,
      verificationTimeoutMs: 12_000,
    },
    humanSteps: {
      dashboardReauthentication: 'required',
      restrictedKeyCreation: 'required',
      mfaAutomation: 'forbidden',
      providerControlBypass: 'forbidden',
    },
  };
}

function rotationIntent(): StripeRotationIntent {
  const input = rotationInput();
  return createStripeRotationIntent({
    intentId: INTENT_ID,
    intent: input,
    binding: BINDING,
    approval: {
      schemaVersion: 'rorca.stripe-rotation-approval.v1',
      intentDigest: stripeRotationIntentDigest(input),
      authorityReceiptId: '50000000-0000-4000-8000-000000000004',
      approvedBy: 'operator:rorca-owner',
      approvedAt: '2026-08-23T09:59:00.000Z',
      expiresAt: '2026-08-23T10:30:00.000Z',
    },
    now: CREATED_AT,
  });
}

function waitingRecord(): StripeRotationRecord {
  const intent = rotationIntent();
  return {
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
}

function storedCapture(overrides: Partial<StoredStripeCapture> = {}): StoredStripeCapture {
  const intent = rotationIntent();
  return {
    intentId: intent.intentId,
    intentDigest: intent.intentDigest,
    workspaceId: intent.workspaceId,
    accountId: intent.accountId,
    mode: intent.mode,
    permissionManifest: [...intent.permissionManifest],
    targetBindingReference: intent.targetBindingReference,
    providerEvidenceDigest: `sha256:${'c'.repeat(64)}`,
    result: {
      reference: `secret-store://rorca/provider-credentials/${CAPTURE_ID}`,
      fingerprint: `sha256:${'b'.repeat(64)}`,
      provenance: {
        schemaVersion: 'rorca.stripe-capture-provenance.v1',
        captureReceiptReference: `credential-capture://rorca/${CAPTURE_ID}`,
        provider: 'stripe',
        channel: 'trusted_local_operator',
        providerEvidenceId: '50000000-0000-4000-8000-000000000005',
        operatorId: 'operator:stripe-owner',
        capturedAt: '2026-08-23T14:59:00.000Z',
        targetBindingReference: intent.targetBindingReference,
      },
    },
    ...overrides,
  };
}

class MemoryRepository implements StripeRotationIntentRepository {
  record: StripeRotationRecord = waitingRecord();
  transitionCount = 0;

  async create(): Promise<StripeRotationRecord> {
    return this.record;
  }

  async get(workspaceId: string, intentId: string): Promise<StripeRotationRecord | null> {
    return this.record.intent.workspaceId === workspaceId && this.record.intent.intentId === intentId
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
    assert.equal(input.workspaceId, this.record.intent.workspaceId);
    assert.equal(input.intentId, this.record.intent.intentId);
    const transition = resumeStripeRotationRecord({
      record: this.record,
      intentDigest: input.intentDigest,
      capture: input.capture,
      resumedAt: input.resumedAt,
    });
    if (transition.resumed) this.transitionCount += 1;
    this.record = transition.record;
    return transition;
  }
}

class MemorySecretStore implements StripeCredentialSecretStore {
  reads = 0;

  constructor(readonly capture: StoredStripeCapture | null) {}

  async captureReplacement(): Promise<StoredStripeCapture> {
    throw new Error('Raw secure capture is not reachable from the ordinary workflow service');
  }

  async getCapture(captureReceiptReference: string): Promise<StoredStripeCapture | null> {
    this.reads += 1;
    return this.capture?.result.provenance.captureReceiptReference === captureReceiptReference
      ? this.capture
      : null;
  }
}

describe('Stripe waiting and exactly-once resume', () => {
  it('does not charge five hours of human wait against active timeout', () => {
    const before = waitingRecord();
    const transition = resumeStripeRotationRecord({
      record: before,
      intentDigest: before.intent.intentDigest,
      capture: storedCapture(),
      resumedAt: RESUMED_AT,
    });

    assert.equal(transition.resumed, true);
    assert.equal(transition.record.lifecycle.state, 'READY_FOR_STAGING');
    assert.equal(transition.record.lifecycle.timeoutDisposition, 'running');
    assert.equal(transition.record.lifecycle.activeElapsedMs, 0);
    assert.equal(transition.record.lifecycle.resumedAt, RESUMED_AT.toISOString());
    assert.equal(transition.record.lifecycle.resumeCount, 1);
  });

  it('replays the same intent/capture safely and resumes only once', () => {
    const first = resumeStripeRotationRecord({
      record: waitingRecord(),
      intentDigest: rotationIntent().intentDigest,
      capture: storedCapture(),
      resumedAt: RESUMED_AT,
    });
    const replay = resumeStripeRotationRecord({
      record: first.record,
      intentDigest: rotationIntent().intentDigest,
      capture: storedCapture(),
      resumedAt: new Date('2026-08-23T16:00:00.000Z'),
    });

    assert.equal(first.resumed, true);
    assert.equal(replay.resumed, false);
    assert.equal(replay.record.lifecycle.resumedAt, RESUMED_AT.toISOString());
    assert.equal(replay.record.lifecycle.resumeCount, 1);
  });

  it('rejects altered intent, mode, permissions, or capture evidence on resume', () => {
    const waiting = waitingRecord();
    assert.throws(
      () => resumeStripeRotationRecord({
        record: waiting,
        intentDigest: `sha256:${'d'.repeat(64)}`,
        capture: storedCapture(),
        resumedAt: RESUMED_AT,
      }),
      (error: unknown) => error instanceof ForbiddenError,
    );
    assert.throws(
      () => resumeStripeRotationRecord({
        record: waiting,
        intentDigest: waiting.intent.intentDigest,
        capture: storedCapture({ mode: 'live' }),
        resumedAt: RESUMED_AT,
      }),
      (error: unknown) => error instanceof ForbiddenError,
    );
    assert.throws(
      () => resumeStripeRotationRecord({
        record: waiting,
        intentDigest: waiting.intent.intentDigest,
        capture: storedCapture({ permissionManifest: ['payment_intents.read', 'customers.write'] }),
        resumedAt: RESUMED_AT,
      }),
      (error: unknown) => error instanceof ForbiddenError,
    );

    const first = resumeStripeRotationRecord({
      record: waiting,
      intentDigest: waiting.intent.intentDigest,
      capture: storedCapture(),
      resumedAt: RESUMED_AT,
    });
    assert.throws(
      () => resumeStripeRotationRecord({
        record: first.record,
        intentDigest: waiting.intent.intentDigest,
        capture: storedCapture({ providerEvidenceDigest: `sha256:${'e'.repeat(64)}` }),
        resumedAt: RESUMED_AT,
      }),
      (error: unknown) => error instanceof ConflictError,
    );
  });

  it('ordinary completion accepts only a capture reference and returns safe metadata on replay', async () => {
    const repository = new MemoryRepository();
    const capture = storedCapture();
    const secretStore = new MemorySecretStore(capture);
    const service = new StripeCredentialRotationService(
      new StripeAuthorityProviderAdapter(async () => []),
      repository,
      secretStore,
    );
    const completion = {
      intentDigest: rotationIntent().intentDigest,
      captureReceiptReference: capture.result.provenance.captureReceiptReference,
    };

    const first = await service.completeAuthentication({
      workspaceId: BINDING.workspaceId,
      intentId: INTENT_ID,
      completion,
      now: RESUMED_AT,
    });
    const replay = await service.completeAuthentication({
      workspaceId: BINDING.workspaceId,
      intentId: INTENT_ID,
      completion,
      now: new Date('2026-08-23T16:00:00.000Z'),
    });

    assert.deepEqual(replay, first);
    assert.deepEqual(Object.keys(first).sort(), ['fingerprint', 'provenance', 'reference']);
    assert.equal(repository.transitionCount, 1);
    assert.equal(repository.record.lifecycle.resumeCount, 1);
    assert.equal(secretStore.reads, 2);
    assert.throws(() => StripeRotationAuthenticationCompletionSchema.parse({
      ...completion,
      replacement: ['rk', 'test', 'forbiddenCredential123'].join('_'),
    }));
  });

  it('cannot complete without a durable secure-capture receipt', async () => {
    const repository = new MemoryRepository();
    const service = new StripeCredentialRotationService(
      new StripeAuthorityProviderAdapter(async () => []),
      repository,
      new MemorySecretStore(null),
    );
    await assert.rejects(
      service.completeAuthentication({
        workspaceId: BINDING.workspaceId,
        intentId: INTENT_ID,
        completion: {
          intentDigest: rotationIntent().intentDigest,
          captureReceiptReference: `credential-capture://rorca/${CAPTURE_ID}`,
        },
        now: RESUMED_AT,
      }),
      (error: unknown) => error instanceof ForbiddenError
        && error.message.includes('evidence is required'),
    );
    assert.equal(repository.transitionCount, 0);
  });
});
