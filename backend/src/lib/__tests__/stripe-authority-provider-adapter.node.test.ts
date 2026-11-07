/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertStripeApplicationMapping,
  assertStripeRotationAuthorized,
  StripeAuthorityProviderAdapter,
  StripeProviderBindingSchema,
  type StripeBindingReader,
  type StripeProviderBinding,
} from '../stripe-authority-provider-adapter';
import { UnprocessableError } from '../errors';

const WORKSPACE_ID = 'workspace-stripe';
const ACCOUNT_ID = 'acct_rorca_test';
const APPLICATION_ID = 'rorca-payments-fixture';
const RESOURCE_TYPE = 'payment_intents';
const RESOURCE_ID = 'disposable-target';

function row(
  id: string,
  mode: 'test' | 'live',
  credentialClass: 'restricted_api_key' | 'unrestricted_api_key' | 'webhook_signing_secret',
  fingerprintCharacter: string,
  permissions: string[],
) {
  const keyKind = credentialClass === 'restricted_api_key'
    ? 'restricted'
    : credentialClass === 'unrestricted_api_key' ? 'unrestricted' : 'signing_secret';
  return {
    id,
    workspace_id: WORKSPACE_ID,
    provider_account_id: ACCOUNT_ID,
    mode,
    application_id: APPLICATION_ID,
    resource_type: RESOURCE_TYPE,
    resource_id: RESOURCE_ID,
    credential_class: credentialClass,
    key_kind: keyKind,
    permission_manifest: permissions,
    owner: 'rorca-stripe-operator',
    fingerprint: `sha256:${fingerprintCharacter.repeat(64)}`,
    secret_store_reference: `secret-store://rorca/${id}`,
    target_binding_reference: `runtime-binding://rorca/${id}`,
    status: 'active' as const,
    binding_generation: 3,
    last_verified_at: new Date('2026-08-21T09:30:00.000Z'),
  };
}

const TEST_RESTRICTED_ROW = row(
  '10000000-0000-4000-8000-000000000001',
  'test',
  'restricted_api_key',
  'a',
  ['payment_intents.read', 'payment_intents.write'],
);
const LIVE_RESTRICTED_ROW = row(
  '10000000-0000-4000-8000-000000000002',
  'live',
  'restricted_api_key',
  'b',
  ['payment_intents.read'],
);
const TEST_UNRESTRICTED_ROW = row(
  '10000000-0000-4000-8000-000000000003',
  'test',
  'unrestricted_api_key',
  'c',
  ['payment_intents.read', 'payment_intents.write', 'customers.write'],
);
const TEST_WEBHOOK_ROW = row(
  '10000000-0000-4000-8000-000000000004',
  'test',
  'webhook_signing_secret',
  'd',
  ['webhook.signature.verify'],
);
const ROWS = [TEST_RESTRICTED_ROW, LIVE_RESTRICTED_ROW, TEST_UNRESTRICTED_ROW, TEST_WEBHOOK_ROW];

function adapter(rows = ROWS): StripeAuthorityProviderAdapter {
  const reader: StripeBindingReader = async (workspaceId) => workspaceId === WORKSPACE_ID ? rows : [];
  return new StripeAuthorityProviderAdapter(reader);
}

function mapping(binding: StripeProviderBinding, permissions = binding.permissionManifest) {
  return {
    workspaceId: binding.workspaceId,
    accountId: binding.accountId,
    mode: binding.mode,
    applicationId: binding.scope.applicationId,
    resourceType: binding.scope.resourceType,
    resourceId: binding.scope.resourceId,
    credentialClass: binding.credentialClass,
    bindingId: binding.bindingId,
    targetBindingReference: binding.targetBindingReference,
    permissions: [...permissions],
  };
}

describe('StripeAuthorityProviderAdapter inventory', () => {
  it('returns every credential class and all required secret-free inventory metadata', async () => {
    const inventory = await adapter().inventory(WORKSPACE_ID);

    assert.deepEqual(inventory.map((binding) => binding.credentialClass), [
      'restricted_api_key',
      'restricted_api_key',
      'unrestricted_api_key',
      'webhook_signing_secret',
    ]);
    assert.deepEqual(inventory[0], {
      providerId: 'stripe',
      bindingId: TEST_RESTRICTED_ROW.id,
      workspaceId: WORKSPACE_ID,
      accountId: ACCOUNT_ID,
      mode: 'test',
      scope: {
        applicationId: APPLICATION_ID,
        resourceType: RESOURCE_TYPE,
        resourceId: RESOURCE_ID,
      },
      credentialClass: 'restricted_api_key',
      keyKind: 'restricted',
      permissionManifest: ['payment_intents.read', 'payment_intents.write'],
      owner: 'rorca-stripe-operator',
      fingerprint: `sha256:${'a'.repeat(64)}`,
      secretStoreReference: `secret-store://rorca/${TEST_RESTRICTED_ROW.id}`,
      targetBindingReference: `runtime-binding://rorca/${TEST_RESTRICTED_ROW.id}`,
      status: 'active',
      generation: 3,
      lastVerifiedAt: '2026-08-21T09:30:00.000Z',
    });
    assert.doesNotMatch(JSON.stringify(inventory), /(?:sk|rk)_(?:test|live)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+/);
  });

  it('strictly rejects credential value fields from the projection', async () => {
    const [binding] = await adapter().inventory(WORKSPACE_ID);
    assert.throws(() => StripeProviderBindingSchema.parse({ ...binding, keyValue: 'forbidden' }));
    assert.throws(() => StripeProviderBindingSchema.parse({ ...binding, webhookSecret: 'forbidden' }));
  });

  it('rejects credential-shaped values without echoing them in validation evidence', async () => {
    const [binding] = await adapter().inventory(WORKSPACE_ID);
    const credentialValue = ['sk', 'test', 'notarealcredential'].join('_');
    assert.throws(
      () => StripeProviderBindingSchema.parse({
        ...binding,
        secretStoreReference: `secret-store://rorca/${credentialValue}`,
      }),
      (error: unknown) => !JSON.stringify(error).includes(credentialValue),
    );
  });

  it('resolves only an exact active mode binding and never falls back across mode', async () => {
    const exactBase = {
      workspaceId: WORKSPACE_ID,
      accountId: ACCOUNT_ID,
      applicationId: APPLICATION_ID,
      resourceType: RESOURCE_TYPE,
      resourceId: RESOURCE_ID,
      credentialClass: 'restricted_api_key' as const,
    };
    const testBinding = await adapter().getProviderBinding({ ...exactBase, mode: 'test' });
    const liveBinding = await adapter().getProviderBinding({ ...exactBase, mode: 'live' });
    const unavailableLive = await adapter([TEST_RESTRICTED_ROW]).getProviderBinding({ ...exactBase, mode: 'live' });

    assert.equal(testBinding?.bindingId, TEST_RESTRICTED_ROW.id);
    assert.equal(liveBinding?.bindingId, LIVE_RESTRICTED_ROW.id);
    assert.equal(unavailableLive, null);
  });
});

describe('Stripe least-privilege mapping authority', () => {
  it('reports each operation broader than the approved permission manifest', async () => {
    const stripe = adapter();
    const binding = (await stripe.inventory(WORKSPACE_ID))[0];

    await assert.rejects(
      stripe.assertApplicationMapping(mapping(binding, ['payment_intents.read', 'customers.write'])),
      (error: unknown) => error instanceof UnprocessableError
        && error.code === 'STRIPE_PERMISSION_MANIFEST_EXCEEDED'
        && error.message.includes('customers.write')
        && JSON.stringify(error).includes('customers.write'),
    );
  });

  it('rejects credential-shaped mapping inputs before an error can echo them', async () => {
    const stripe = adapter();
    const binding = (await stripe.inventory(WORKSPACE_ID))[0];
    const credentialValue = ['rk', 'test', 'notarealcredential'].join('_');

    await assert.rejects(
      stripe.assertApplicationMapping(mapping(binding, [credentialValue])),
      (error: unknown) => !JSON.stringify(error).includes(credentialValue),
    );
  });

  it('rejects cross-mode mappings rather than reusing a test binding for live', async () => {
    const stripe = adapter();
    const binding = (await stripe.inventory(WORKSPACE_ID))[0];

    await assert.rejects(
      stripe.assertApplicationMapping({ ...mapping(binding), mode: 'live' }),
      (error: unknown) => error instanceof UnprocessableError
        && error.code === 'STRIPE_BINDING_SCOPE_MISMATCH',
    );
  });

  it('rejects a quarantined binding before runtime mapping', async () => {
    const binding = (await adapter().inventory(WORKSPACE_ID))[0];
    const quarantined = { ...binding, status: 'quarantined' as const };

    assert.throws(
      () => assertStripeApplicationMapping(quarantined, mapping(quarantined), [quarantined]),
      (error: unknown) => error instanceof UnprocessableError
        && error.code === 'STRIPE_BINDING_NOT_ACTIVE'
        && error.details?.status === 'quarantined',
    );
  });

  it('rejects an unrestricted account credential when a restricted key satisfies the operations', async () => {
    const stripe = adapter();
    const binding = (await stripe.inventory(WORKSPACE_ID)).find(
      (candidate) => candidate.credentialClass === 'unrestricted_api_key',
    );
    assert.ok(binding);

    await assert.rejects(
      stripe.assertApplicationMapping(mapping(binding, ['payment_intents.read'])),
      (error: unknown) => error instanceof UnprocessableError
        && error.code === 'STRIPE_RESTRICTED_KEY_REQUIRED'
        && error.details?.restrictedBindingId === TEST_RESTRICTED_ROW.id,
    );
  });

  it('accepts an exact restricted mapping within its manifest', async () => {
    const stripe = adapter();
    const binding = (await stripe.inventory(WORKSPACE_ID))[0];
    const accepted = await stripe.assertApplicationMapping(mapping(binding, ['payment_intents.read']));
    assert.equal(accepted.bindingId, binding.bindingId);
  });
});

describe('Stripe webhook rotation authority', () => {
  it('never authorizes signing-secret rotation with a restricted API-key grant', async () => {
    const webhookBinding = (await adapter().inventory(WORKSPACE_ID)).find(
      (binding) => binding.credentialClass === 'webhook_signing_secret',
    );
    assert.ok(webhookBinding);

    assert.throws(
      () => assertStripeRotationAuthorized(webhookBinding, {
        workspaceId: WORKSPACE_ID,
        accountId: ACCOUNT_ID,
        mode: 'test',
        authorityKind: 'restricted_api_key_grant',
        permissions: ['credentials.webhook_signing_secret.rotate'],
      }),
      (error: unknown) => error instanceof UnprocessableError
        && error.code === 'STRIPE_WEBHOOK_ROTATION_AUTHORITY_REQUIRED',
    );
  });

  it('requires exact mode and explicit Dashboard operator permission', async () => {
    const webhookBinding = (await adapter().inventory(WORKSPACE_ID)).find(
      (binding) => binding.credentialClass === 'webhook_signing_secret',
    );
    assert.ok(webhookBinding);

    assert.throws(
      () => assertStripeRotationAuthorized(webhookBinding, {
        workspaceId: WORKSPACE_ID,
        accountId: ACCOUNT_ID,
        mode: 'live',
        authorityKind: 'stripe_dashboard_operator',
        permissions: ['credentials.webhook_signing_secret.rotate'],
      }),
      (error: unknown) => error instanceof UnprocessableError
        && error.code === 'STRIPE_ROTATION_GRANT_SCOPE_MISMATCH',
    );
    assert.doesNotThrow(() => assertStripeRotationAuthorized(webhookBinding, {
      workspaceId: WORKSPACE_ID,
      accountId: ACCOUNT_ID,
      mode: 'test',
      authorityKind: 'stripe_dashboard_operator',
      permissions: ['credentials.webhook_signing_secret.rotate'],
    }));
  });
});
