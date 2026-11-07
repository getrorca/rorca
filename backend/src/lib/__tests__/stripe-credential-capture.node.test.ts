/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import {
  createHash,
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import { describe, it } from 'node:test';
import {
  STRIPE_CAPTURE_PROVENANCE_VERSION,
  STRIPE_DASHBOARD_EVIDENCE_VERSION,
  StripeDashboardEvidenceVerifier,
  StripeSecureOperatorCapture,
  type StoredStripeCapture,
  type StripeCredentialSecretStore,
  type StripeDashboardEvidence,
  type StripeDashboardEvidenceUnsigned,
} from '../stripe-credential-capture';
import {
  createStripeRotationIntent,
  stripeRotationIntentDigest,
  type StripeRotationIntent,
  type StripeRotationIntentInput,
} from '../stripe-credential-rotation';
import { ForbiddenError, UnprocessableError } from '../errors';
import type { StripeProviderBinding } from '../stripe-authority-provider-adapter';
import { stableWalJson } from '../trusted-wal';

const NOW = new Date('2026-08-23T12:00:00.000Z');
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const WORKSPACE_ID = 'workspace-stripe-capture';
const ACCOUNT_ID = 'acct_rorca_capture';
const INTENT_ID = '40000000-0000-4000-8000-000000000001';
const CAPTURE_ID = '40000000-0000-4000-8000-000000000002';

const BINDING: StripeProviderBinding = {
  providerId: 'stripe',
  bindingId: '40000000-0000-4000-8000-000000000003',
  workspaceId: WORKSPACE_ID,
  accountId: ACCOUNT_ID,
  mode: 'test',
  scope: {
    applicationId: 'rorca-disposable-fixture',
    resourceType: 'payment_intents',
    resourceId: 'disposable-target',
  },
  credentialClass: 'restricted_api_key',
  keyKind: 'restricted',
  permissionManifest: ['payment_intents.read', 'payment_intents.write'],
  owner: 'rorca-stripe-operator',
  fingerprint: `sha256:${'a'.repeat(64)}`,
  secretStoreReference: 'secret-store://rorca/current-capture-key',
  targetBindingReference: 'runtime-binding://rorca/disposable-target',
  status: 'active',
  generation: 2,
  lastVerifiedAt: '2026-08-23T11:00:00.000Z',
};

function rotationInput(): StripeRotationIntentInput {
  return {
    workspaceId: WORKSPACE_ID,
    bindingId: BINDING.bindingId,
    accountId: ACCOUNT_ID,
    currentFingerprint: BINDING.fingerprint,
    permissionManifest: [...BINDING.permissionManifest],
    mode: 'test',
    targetBindingReference: BINDING.targetBindingReference,
    replacementCredentialClass: 'restricted_api_key',
    canary: {
      operation: 'payment_intents.read',
      resourceType: 'payment_intents',
      resourceId: 'disposable-canary',
      timeoutMs: 10_000,
    },
    gracePeriodSeconds: 600,
    rollback: {
      strategy: 'restore_previous_binding',
      keepPriorCredentialActive: true,
      quarantineReplacement: true,
      verificationTimeoutMs: 15_000,
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
  const intentDigest = stripeRotationIntentDigest(input);
  return createStripeRotationIntent({
    intentId: INTENT_ID,
    intent: input,
    binding: BINDING,
    approval: {
      schemaVersion: 'rorca.stripe-rotation-approval.v1',
      intentDigest,
      authorityReceiptId: '40000000-0000-4000-8000-000000000004',
      approvedBy: 'operator:rorca-owner',
      approvedAt: '2026-08-23T11:58:00.000Z',
      expiresAt: '2026-08-23T12:30:00.000Z',
    },
    now: NOW,
  });
}

function restrictedKey(mode: 'test' | 'live' = 'test'): Uint8Array {
  return Buffer.from(['rk', mode, 'fixtureCredential123456'].join('_'), 'ascii');
}

function signedEvidence(
  intent: StripeRotationIntent,
  replacement: Uint8Array,
  overrides: Partial<StripeDashboardEvidenceUnsigned> = {},
): StripeDashboardEvidence {
  const unsigned: StripeDashboardEvidenceUnsigned = {
    schemaVersion: STRIPE_DASHBOARD_EVIDENCE_VERSION,
    evidenceId: '40000000-0000-4000-8000-000000000005',
    intentDigest: intent.intentDigest,
    workspaceId: intent.workspaceId,
    accountId: intent.accountId,
    mode: intent.mode,
    targetBindingReference: intent.targetBindingReference,
    permissionManifest: [...intent.permissionManifest],
    keyKind: 'restricted',
    replacementFingerprint: `sha256:${createHash('sha256').update(replacement).digest('hex')}`,
    dashboardSessionReference: 'stripe-dashboard-session://rorca/evidence-1',
    dashboardReauthenticatedAt: '2026-08-23T12:00:00.000Z',
    restrictedKeyCreatedAt: '2026-08-23T12:00:00.000Z',
    operatorId: 'operator:stripe-owner',
    attestationKeyId: 'stripe-operator-key-1',
    ...overrides,
  };
  return {
    ...unsigned,
    signature: sign(null, Buffer.from(stableWalJson(unsigned), 'utf8'), privateKey).toString('base64url'),
  };
}

class RecordingSecretStore implements StripeCredentialSecretStore {
  calls = 0;
  capturedBytes: Uint8Array | null = null;
  record: StoredStripeCapture | null = null;

  async captureReplacement(input: Parameters<StripeCredentialSecretStore['captureReplacement']>[0]): Promise<StoredStripeCapture> {
    this.calls += 1;
    this.capturedBytes = input.replacement;
    this.record ??= {
      intentId: input.intent.intentId,
      intentDigest: input.intent.intentDigest,
      workspaceId: input.intent.workspaceId,
      accountId: input.intent.accountId,
      mode: input.intent.mode,
      permissionManifest: [...input.intent.permissionManifest],
      targetBindingReference: input.intent.targetBindingReference,
      providerEvidenceDigest: input.evidenceDigest,
      result: {
        reference: `secret-store://rorca/provider-credentials/${CAPTURE_ID}`,
        fingerprint: input.fingerprint,
        provenance: {
          schemaVersion: STRIPE_CAPTURE_PROVENANCE_VERSION,
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
    return this.record;
  }

  async getCapture(captureReceiptReference: string): Promise<StoredStripeCapture | null> {
    return this.record?.result.provenance.captureReceiptReference === captureReceiptReference ? this.record : null;
  }
}

function verifier(): StripeDashboardEvidenceVerifier {
  return new StripeDashboardEvidenceVerifier(() => [{
    keyId: 'stripe-operator-key-1',
    publicKeyPem,
    workspaceId: WORKSPACE_ID,
    accountId: ACCOUNT_ID,
    operatorIds: ['operator:stripe-owner'],
    modes: ['test', 'live'],
  }]);
}

describe('Stripe secure operator credential capture', () => {
  it('writes raw bytes only to SecretStore and returns reference, fingerprint, and provenance', async () => {
    const intent = rotationIntent();
    const replacement = restrictedKey();
    const store = new RecordingSecretStore();
    const capture = new StripeSecureOperatorCapture(store, verifier());

    const result = await capture.capture({
      intent,
      evidence: signedEvidence(intent, replacement),
      replacement,
      now: NOW,
    });

    assert.equal(store.calls, 1);
    assert.equal(store.capturedBytes, replacement);
    assert.deepEqual(Object.keys(result).sort(), ['fingerprint', 'provenance', 'reference']);
    assert.equal(result.provenance.targetBindingReference, intent.targetBindingReference);
    assert.equal(result.reference, `secret-store://rorca/provider-credentials/${CAPTURE_ID}`);
    assert.equal(result.fingerprint, `sha256:${createHash('sha256').update(replacement).digest('hex')}`);
    assert.equal(JSON.stringify(result).includes(Buffer.from(replacement).toString('ascii')), false);
  });

  it('rejects wrong-mode and unrestricted replacements before SecretStore receives them', async () => {
    const intent = rotationIntent();
    const store = new RecordingSecretStore();
    const capture = new StripeSecureOperatorCapture(store, verifier());
    const wrongMode = restrictedKey('live');
    const unrestricted = Buffer.from(['sk', 'test', 'fixtureCredential123456'].join('_'), 'ascii');

    await assert.rejects(
      capture.capture({ intent, evidence: signedEvidence(intent, wrongMode), replacement: wrongMode, now: NOW }),
      (error: unknown) => error instanceof UnprocessableError
        && error.code === 'STRIPE_REPLACEMENT_MODE_OR_KIND_MISMATCH'
        && !JSON.stringify(error).includes(Buffer.from(wrongMode).toString('ascii')),
    );
    await assert.rejects(
      capture.capture({ intent, evidence: signedEvidence(intent, unrestricted), replacement: unrestricted, now: NOW }),
      (error: unknown) => error instanceof UnprocessableError
        && error.code === 'STRIPE_REPLACEMENT_MODE_OR_KIND_MISMATCH'
        && !JSON.stringify(error).includes(Buffer.from(unrestricted).toString('ascii')),
    );
    assert.equal(store.calls, 0);
  });

  it('rejects broadened permission evidence even when correctly signed', async () => {
    const intent = rotationIntent();
    const replacement = restrictedKey();
    const store = new RecordingSecretStore();
    const capture = new StripeSecureOperatorCapture(store, verifier());
    const evidence = signedEvidence(intent, replacement, {
      permissionManifest: [...intent.permissionManifest, 'customers.write'],
    });

    await assert.rejects(
      capture.capture({ intent, evidence, replacement, now: NOW }),
      (error: unknown) => error instanceof ForbiddenError
        && error.message.includes('exceeds or differs'),
    );
    assert.equal(store.calls, 0);
  });

  it('rejects signed provider actions performed before the intent entered its human wait', async () => {
    const intent = rotationIntent();
    const replacement = restrictedKey();
    const store = new RecordingSecretStore();
    const capture = new StripeSecureOperatorCapture(store, verifier());
    const preIntentEvidence = signedEvidence(intent, replacement, {
      dashboardReauthenticatedAt: '2026-08-23T11:59:58.000Z',
      restrictedKeyCreatedAt: '2026-08-23T11:59:59.000Z',
    });

    await assert.rejects(
      capture.capture({ intent, evidence: preIntentEvidence, replacement, now: NOW }),
      (error: unknown) => error instanceof ForbiddenError
        && error.message.includes('temporally valid'),
    );
    assert.equal(store.calls, 0);
  });

  it('cannot mark Dashboard reauthentication or key creation complete with forged or stale evidence', async () => {
    const intent = rotationIntent();
    const replacement = restrictedKey();
    const store = new RecordingSecretStore();
    const capture = new StripeSecureOperatorCapture(store, verifier());
    const forged = { ...signedEvidence(intent, replacement), signature: Buffer.alloc(64).toString('base64url') };
    const stale = signedEvidence(intent, replacement, {
      dashboardReauthenticatedAt: '2026-08-23T10:00:00.000Z',
      restrictedKeyCreatedAt: '2026-08-23T10:01:00.000Z',
    });

    await assert.rejects(
      capture.capture({ intent, evidence: forged, replacement, now: NOW }),
      (error: unknown) => error instanceof ForbiddenError
        && error.message.includes('signature verification failed'),
    );
    await assert.rejects(
      capture.capture({ intent, evidence: stale, replacement, now: NOW }),
      (error: unknown) => error instanceof ForbiddenError
        && error.message.includes('temporally valid'),
    );
    assert.equal(store.calls, 0);
  });
});
