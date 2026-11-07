/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertStripeRotationApproval,
  createStripeRotationIntent,
  stripeOperatorCeremony,
  stripeRotationIntentDigest,
  type StripeRotationApproval,
  type StripeRotationIntentInput,
} from '../stripe-credential-rotation';
import { ForbiddenError, UnprocessableError } from '../errors';
import type { StripeProviderBinding } from '../stripe-authority-provider-adapter';

const NOW = new Date('2026-08-23T12:00:00.000Z');
const WORKSPACE_ID = 'workspace-stripe-rotation';
const BINDING_ID = '30000000-0000-4000-8000-000000000001';
const CURRENT_FINGERPRINT = `sha256:${'a'.repeat(64)}`;

const BINDING: StripeProviderBinding = {
  providerId: 'stripe',
  bindingId: BINDING_ID,
  workspaceId: WORKSPACE_ID,
  accountId: 'acct_rorca_rotation',
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
  fingerprint: CURRENT_FINGERPRINT,
  secretStoreReference: 'secret-store://rorca/current-stripe-key',
  targetBindingReference: 'runtime-binding://rorca/disposable-target',
  status: 'active',
  generation: 7,
  lastVerifiedAt: '2026-08-23T11:30:00.000Z',
};

function intent(): StripeRotationIntentInput {
  return {
    workspaceId: WORKSPACE_ID,
    bindingId: BINDING_ID,
    accountId: BINDING.accountId,
    currentFingerprint: CURRENT_FINGERPRINT,
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
    gracePeriodSeconds: 900,
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

function approval(forIntent = intent()): StripeRotationApproval {
  return {
    schemaVersion: 'rorca.stripe-rotation-approval.v1',
    intentDigest: stripeRotationIntentDigest(forIntent),
    authorityReceiptId: '30000000-0000-4000-8000-000000000099',
    approvedBy: 'operator:rorca-owner',
    approvedAt: '2026-08-23T11:59:00.000Z',
    expiresAt: '2026-08-23T12:30:00.000Z',
  };
}

describe('immutable Stripe rotation intent authority', () => {
  it('changes the digest for every approved rotation dimension and invalidates the old approval', () => {
    const base = intent();
    const baseDigest = stripeRotationIntentDigest(base);
    const oldApproval = approval(base);
    const changes: StripeRotationIntentInput[] = [
      { ...base, permissionManifest: [...base.permissionManifest, 'customers.read'] },
      { ...base, mode: 'live' },
      { ...base, targetBindingReference: 'runtime-binding://rorca/other-target' },
      { ...base, canary: { ...base.canary, timeoutMs: base.canary.timeoutMs + 1_000 } },
      { ...base, gracePeriodSeconds: base.gracePeriodSeconds + 1 },
      { ...base, rollback: { ...base.rollback, verificationTimeoutMs: base.rollback.verificationTimeoutMs + 1_000 } },
      { ...base, currentFingerprint: `sha256:${'b'.repeat(64)}` },
    ];

    for (const changed of changes) {
      assert.notEqual(stripeRotationIntentDigest(changed), baseDigest);
      assert.throws(
        () => assertStripeRotationApproval(changed, oldApproval, NOW),
        (error: unknown) => error instanceof ForbiddenError
          && error.message.includes('exact immutable intent'),
      );
    }
  });

  it('canonicalizes permission ordering without changing the exact manifest authority', () => {
    const base = intent();
    assert.equal(
      stripeRotationIntentDigest({ ...base, permissionManifest: [...base.permissionManifest].reverse() }),
      stripeRotationIntentDigest(base),
    );
  });

  it('creates a deeply immutable waiting intent with a paused timeout and safe ceremony', () => {
    const created = createStripeRotationIntent({
      intentId: '30000000-0000-4000-8000-000000000010',
      intent: intent(),
      approval: approval(),
      binding: BINDING,
      now: NOW,
    });
    const ceremony = stripeOperatorCeremony(created);

    assert.equal(created.state, 'WAITING_FOR_AUTHENTICATION');
    assert.deepEqual(created.timeout, {
      disposition: 'paused',
      activeElapsedMs: 0,
      pausedAt: NOW.toISOString(),
    });
    assert.equal(Object.isFrozen(created), true);
    assert.equal(Object.isFrozen(created.permissionManifest), true);
    assert.equal(ceremony.captureChannel, 'trusted_local_operator');
    assert.deepEqual(ceremony.requiredActions, [
      'reauthenticate_in_stripe_dashboard',
      'create_exact_restricted_key',
      'capture_directly_to_secret_store',
    ]);
    assert.match(JSON.stringify(ceremony.prohibitedActions), /submit_secret_to_api_or_model/);
    assert.doesNotMatch(JSON.stringify(ceremony), /(?:sk|rk)_(?:test|live)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+/);
  });

  it('rejects broadened permissions, wrong mode, stale fingerprints, and unrestricted replacement before ceremony', () => {
    const base = intent();
    const cases: Array<[StripeRotationIntentInput, string]> = [
      [{ ...base, permissionManifest: [...base.permissionManifest, 'customers.read'] }, 'STRIPE_ROTATION_PERMISSION_MANIFEST_MISMATCH'],
      [{ ...base, mode: 'live' }, 'STRIPE_ROTATION_INTENT_SCOPE_MISMATCH'],
      [{ ...base, currentFingerprint: `sha256:${'b'.repeat(64)}` }, 'STRIPE_ROTATION_FINGERPRINT_MISMATCH'],
    ];

    for (const [changed, code] of cases) {
      assert.throws(
        () => createStripeRotationIntent({
          intent: changed,
          approval: approval(changed),
          binding: BINDING,
          now: NOW,
        }),
        (error: unknown) => error instanceof UnprocessableError && error.code === code,
      );
    }
    assert.throws(() => stripeRotationIntentDigest({
      ...base,
      replacementCredentialClass: 'unrestricted_api_key',
    } as unknown as StripeRotationIntentInput));
  });

  it('rejects expired approval instead of entering the human wait state', () => {
    const expired = { ...approval(), expiresAt: '2026-08-23T11:59:30.000Z' };
    assert.throws(
      () => createStripeRotationIntent({ intent: intent(), approval: expired, binding: BINDING, now: NOW }),
      (error: unknown) => error instanceof ForbiddenError
        && error.message.includes('temporally valid'),
    );
  });
});
