/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import {
  OpenRouterAuthorityProviderAdapter,
  type OpenRouterAuthorityStore,
  type OpenRouterKeyMetadata,
  type OpenRouterOperationContext,
  type OpenRouterProviderBinding,
  type OpenRouterProviderResponse,
  type OpenRouterProviderTransport,
  type OpenRouterSecretStore,
} from '../openrouter-authority-provider-adapter';
import { prepareOpenRouterManagementSecret } from '../integration-vault';

const MANAGEMENT_CREDENTIAL = 'sk-or-v1-management-opaque-secret';
const RUNTIME_CREDENTIAL = 'sk-or-v1-runtime-opaque-secret';
const BINDING_ID = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_ID = 'workspace-one';
const ACCOUNT_ID = 'account-one';

function credentialFingerprint(value: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function binding(overrides: Partial<OpenRouterProviderBinding> = {}): OpenRouterProviderBinding {
  return {
    providerId: 'openrouter',
    bindingId: BINDING_ID,
    workspaceId: WORKSPACE_ID,
    bindingStatus: 'active',
    providerAccountId: ACCOUNT_ID,
    generation: 7,
    managementSecretReference: {
      secretId: '22222222-2222-4222-8222-222222222222',
      fingerprint: credentialFingerprint(MANAGEMENT_CREDENTIAL),
    },
    policyLimits: {
      maxCreditUsd: 5,
      maxUsage: 100,
      allowedLimitResets: ['daily'],
      includeByokInLimit: false,
    },
    approvedOperations: ['list_keys', 'create_limited_key', 'disable_key', 'delete_key', 'verify_binding'],
    health: {
      providerAccountVerified: true,
      completionProbeRejected: true,
      verifiedAt: '2026-08-21T10:00:00.000Z',
      validationErrorCode: null,
    },
    ...overrides,
  };
}

const context: OpenRouterOperationContext = {
  workspaceId: WORKSPACE_ID,
  bindingId: BINDING_ID,
  bindingGeneration: 7,
  providerAccountId: ACCOUNT_ID,
};

function response(status: number, body: unknown, accountId = ACCOUNT_ID): OpenRouterProviderResponse {
  return { status, headers: new Headers({ 'x-openrouter-account-id': accountId }), body };
}

function dependencies(initialBinding = binding()) {
  let currentBinding = initialBinding;
  const saved: Array<{ resources: readonly OpenRouterKeyMetadata[]; runtimeSecretId?: string }> = [];
  const ownershipChecks: string[] = [];
  const statusChanges: Array<{ resourceId: string; status: 'disabled' | 'deleted' }> = [];
  const providerRequests: Array<Parameters<OpenRouterProviderTransport['request']>[0]> = [];
  let credentialResolutions = 0;
  let providerCalls = 0;
  let runtimeStores = 0;
  const queuedResponses: OpenRouterProviderResponse[] = [];
  const store: OpenRouterAuthorityStore = {
    async readBinding() { return currentBinding; },
    async readBindingForWorkspace() { return currentBinding; },
    async markBindingVerified() {
      currentBinding = binding({
        ...currentBinding,
        bindingStatus: 'active',
        health: {
          providerAccountVerified: true,
          completionProbeRejected: true,
          verifiedAt: '2026-08-21T11:00:00.000Z',
          validationErrorCode: null,
        },
      });
    },
    async saveResources(_binding, resources, runtimeSecretId) {
      saved.push({ resources, ...(runtimeSecretId ? { runtimeSecretId } : {}) });
    },
    async assertResourceOwned(_binding, resourceId) {
      ownershipChecks.push(resourceId);
    },
    async markResourceStatus(_binding, resourceId, status) {
      statusChanges.push({ resourceId, status });
    },
    async readRuntimeKeyReference(_binding, resourceId) {
      return resourceId === 'created-resource'
        ? {
          secretId: '33333333-3333-4333-8333-333333333333',
          fingerprint: credentialFingerprint(RUNTIME_CREDENTIAL),
        }
        : null;
    },
  };
  const secretStore: OpenRouterSecretStore = {
    async resolveManagementCredential() {
      credentialResolutions += 1;
      return MANAGEMENT_CREDENTIAL;
    },
    async storeRuntimeCredential() {
      runtimeStores += 1;
      return {
        id: '33333333-3333-4333-8333-333333333333',
        fingerprint: credentialFingerprint(RUNTIME_CREDENTIAL),
      };
    },
  };
  const transport: OpenRouterProviderTransport = {
    async request(input) {
      providerRequests.push(input);
      providerCalls += 1;
      const next = queuedResponses.shift();
      assert.ok(next, 'a provider response must be queued');
      return next;
    },
  };
  return {
    store,
    secretStore,
    transport,
    saved,
    queuedResponses,
    ownershipChecks,
    statusChanges,
    providerRequests,
    counts: () => ({ credentialResolutions, providerCalls, runtimeStores }),
  };
}

test('healthy list emits fingerprints and metadata but no provider key values', async () => {
  const deps = dependencies();
  deps.queuedResponses.push(response(200, {
    data: [{
      hash: 'provider-key-hash',
      name: 'runtime-one',
      disabled: false,
      limit: 5,
      usage: 1.25,
      limit_reset: 'daily',
      include_byok_in_limit: false,
      created_at: '2026-08-20T10:00:00.000Z',
      key: RUNTIME_CREDENTIAL,
      management_key: MANAGEMENT_CREDENTIAL,
    }],
  }));

  const adapter = new OpenRouterAuthorityProviderAdapter(deps.store, deps.secretStore, deps.transport);
  const result = await adapter.listKeys(context);

  assert.equal(adapter.contractVersion, 'rorca.authority-provider-adapter.v1');
  assert.equal(adapter.descriptor.adapterId, 'openrouter-runtime-keys');
  assert.deepEqual(adapter.capabilities, [
    'list_keys', 'create_limited_key', 'disable_key', 'delete_key', 'verify_binding',
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.resourceId, 'provider-key-hash');
  assert.match(result[0]?.fingerprint ?? '', /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(result[0]?.limits, {
    creditLimitUsd: 5,
    usage: 1.25,
    limitReset: 'daily',
    includeByokInLimit: false,
  });
  assert.equal(JSON.stringify(result).includes(RUNTIME_CREDENTIAL), false);
  assert.equal(JSON.stringify(result).includes(MANAGEMENT_CREDENTIAL), false);
  assert.equal(deps.saved.length, 1);
});

test('preflight verifies management identity and requires completion rejection', async () => {
  const deps = dependencies(binding({
    bindingStatus: 'invalid',
    health: {
      providerAccountVerified: false,
      completionProbeRejected: false,
      verifiedAt: null,
      validationErrorCode: 'not_verified',
    },
  }));
  deps.queuedResponses.push(response(200, { data: [] }), response(403, { error: 'forbidden' }));

  const verified = await new OpenRouterAuthorityProviderAdapter(deps.store, deps.secretStore, deps.transport)
    .verify(context);

  assert.equal(verified.bindingStatus, 'active');
  assert.equal(verified.health.providerAccountVerified, true);
  assert.equal(verified.health.completionProbeRejected, true);
  assert.deepEqual(deps.counts(), { credentialResolutions: 1, providerCalls: 2, runtimeStores: 0 });
  assert.equal(JSON.stringify(verified).includes(MANAGEMENT_CREDENTIAL), false);
});

test('preflight fails closed when the management credential can call completions', async () => {
  const deps = dependencies(binding({ bindingStatus: 'invalid' }));
  deps.queuedResponses.push(response(200, { data: [] }), response(200, { choices: [] }));
  const operation = new OpenRouterAuthorityProviderAdapter(deps.store, deps.secretStore, deps.transport)
    .verify(context);

  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error && typeof error === 'object' && 'code' in error);
    assert.equal(error.code, 'OPENROUTER_MANAGEMENT_CREDENTIAL_CAN_INFER');
    assert.equal(JSON.stringify(error).includes(MANAGEMENT_CREDENTIAL), false);
    return true;
  });
});

test('cross-scope, stale, wrong-account, unapproved, and disabled requests fail before provider access', async () => {
  const cases: Array<[OpenRouterOperationContext, OpenRouterProviderBinding]> = [
    [{ ...context, workspaceId: 'workspace-two' }, binding()],
    [{ ...context, bindingGeneration: 6 }, binding()],
    [{ ...context, providerAccountId: 'account-two' }, binding()],
    [context, binding({ approvedOperations: ['verify_binding'] })],
    [context, binding({ bindingStatus: 'disabled' })],
  ];
  for (const [operationContext, currentBinding] of cases) {
    const deps = dependencies(currentBinding);
    await assert.rejects(
      new OpenRouterAuthorityProviderAdapter(deps.store, deps.secretStore, deps.transport).listKeys(operationContext),
    );
    assert.deepEqual(deps.counts(), { credentialResolutions: 0, providerCalls: 0, runtimeStores: 0 });
    assert.equal(deps.saved.length, 0);
  }
});

test('disabled binding prevents limited-key creation without changing tracked runtime keys', async () => {
  const deps = dependencies(binding({ bindingStatus: 'disabled' }));
  await assert.rejects(
    new OpenRouterAuthorityProviderAdapter(deps.store, deps.secretStore, deps.transport).createLimitedKey({
      ...context,
      name: 'blocked-replacement',
      creditLimitUsd: 4,
      usageLimit: 100,
      limitReset: 'daily',
    }),
    /Provider binding is disabled/,
  );
  assert.deepEqual(deps.counts(), { credentialResolutions: 0, providerCalls: 0, runtimeStores: 0 });
  assert.equal(deps.saved.length, 0);
  assert.deepEqual(deps.statusChanges, []);
});

test('a changed management-secret fingerprint fails before the provider call', async () => {
  const deps = dependencies(binding({
    managementSecretReference: {
      secretId: '22222222-2222-4222-8222-222222222222',
      fingerprint: credentialFingerprint('different-account-credential'),
    },
  }));
  await assert.rejects(
    new OpenRouterAuthorityProviderAdapter(deps.store, deps.secretStore, deps.transport).listKeys(context),
    /Provider account credential does not match the binding/,
  );
  assert.deepEqual(deps.counts(), { credentialResolutions: 1, providerCalls: 0, runtimeStores: 0 });
});

test('credential-bearing dependency failures are replaced with redacted application errors', async () => {
  const resolverFailure = dependencies();
  resolverFailure.secretStore.resolveManagementCredential = async () => {
    throw new Error(`vault failure for ${MANAGEMENT_CREDENTIAL}`);
  };
  await assert.rejects(
    new OpenRouterAuthorityProviderAdapter(
      resolverFailure.store,
      resolverFailure.secretStore,
      resolverFailure.transport,
    ).listKeys(context),
    (error: unknown) => {
      assert.ok(error && typeof error === 'object' && 'code' in error);
      assert.equal(error.code, 'OPENROUTER_CREDENTIAL_UNAVAILABLE');
      assert.equal(JSON.stringify(error).includes(MANAGEMENT_CREDENTIAL), false);
      return true;
    },
  );
  assert.equal(resolverFailure.counts().providerCalls, 0);

  const transportFailure = dependencies();
  transportFailure.transport.request = async () => {
    throw new Error(`provider failure for ${MANAGEMENT_CREDENTIAL}`);
  };
  await assert.rejects(
    new OpenRouterAuthorityProviderAdapter(
      transportFailure.store,
      transportFailure.secretStore,
      transportFailure.transport,
    ).listKeys(context),
    (error: unknown) => {
      assert.ok(error && typeof error === 'object' && 'code' in error);
      assert.equal(error.code, 'OPENROUTER_PROVIDER_UNAVAILABLE');
      assert.equal(JSON.stringify(error).includes(MANAGEMENT_CREDENTIAL), false);
      return true;
    },
  );
});

test('limited creation stores the runtime value and returns only redacted metadata', async () => {
  const deps = dependencies();
  deps.queuedResponses.push(response(201, {
    key: RUNTIME_CREDENTIAL,
    data: {
      hash: 'created-resource', name: 'bounded-runtime', disabled: false,
      limit: 4, usage: 0, limit_reset: 'daily', include_byok_in_limit: false,
    },
  }));
  const adapter = new OpenRouterAuthorityProviderAdapter(deps.store, deps.secretStore, deps.transport);
  const result = await adapter.createLimitedKeyForRotation({
    ...context,
    name: 'bounded-runtime',
    creditLimitUsd: 4,
    usageLimit: 100,
    limitReset: 'daily',
    includeByokInLimit: false,
  });

  assert.equal(result.key.resourceId, 'created-resource');
  assert.equal(JSON.stringify(result).includes(RUNTIME_CREDENTIAL), false);
  assert.deepEqual(result.runtimeKeyReference, {
    secretId: '33333333-3333-4333-8333-333333333333',
    fingerprint: credentialFingerprint(RUNTIME_CREDENTIAL),
  });
  assert.deepEqual(deps.providerRequests[0]?.body, {
    name: 'bounded-runtime',
    limit: 4,
    limit_reset: 'daily',
    include_byok_in_limit: false,
    usage_limit: 100,
  });
  assert.equal(deps.saved[0]?.runtimeSecretId, '33333333-3333-4333-8333-333333333333');
  assert.deepEqual(deps.counts(), { credentialResolutions: 1, providerCalls: 1, runtimeStores: 1 });

  await assert.rejects(adapter.createLimitedKey({
    ...context,
    name: 'too-large',
    creditLimitUsd: 6,
    usageLimit: 100,
    limitReset: 'daily',
  }), /exceeds the approved binding policy/);
  assert.equal(deps.counts().providerCalls, 1);
});

test('disable and delete act only on the exactly tracked provider resource', async () => {
  const deps = dependencies();
  deps.queuedResponses.push(
    response(200, {
      data: {
        hash: 'tracked-resource',
        name: 'bounded-runtime',
        disabled: true,
        limit: 4,
        usage: 2,
        limit_reset: 'daily',
        include_byok_in_limit: false,
      },
    }),
    response(204, null),
  );
  const adapter = new OpenRouterAuthorityProviderAdapter(deps.store, deps.secretStore, deps.transport);

  const disabled = await adapter.disableKey(context, 'tracked-resource');
  assert.equal(disabled.resourceId, 'tracked-resource');
  assert.equal(disabled.status, 'disabled');
  await adapter.deleteKey(context, 'tracked-resource');

  assert.deepEqual(deps.ownershipChecks, ['tracked-resource', 'tracked-resource']);
  assert.deepEqual(deps.statusChanges, [
    { resourceId: 'tracked-resource', status: 'disabled' },
    { resourceId: 'tracked-resource', status: 'deleted' },
  ]);
  assert.deepEqual(deps.counts(), { credentialResolutions: 2, providerCalls: 2, runtimeStores: 0 });
});

test('runtime SecretStore failures cannot disclose the newly issued key', async () => {
  const deps = dependencies();
  deps.queuedResponses.push(response(201, {
    key: RUNTIME_CREDENTIAL,
    data: {
      hash: 'created-resource', name: 'bounded-runtime', disabled: false,
      limit: 4, usage: 0, limit_reset: 'daily', include_byok_in_limit: false,
    },
  }));
  deps.secretStore.storeRuntimeCredential = async () => {
    throw new Error(`storage failure for ${RUNTIME_CREDENTIAL}`);
  };

  await assert.rejects(
    new OpenRouterAuthorityProviderAdapter(deps.store, deps.secretStore, deps.transport).createLimitedKey({
      ...context,
      name: 'bounded-runtime',
      creditLimitUsd: 4,
      usageLimit: 100,
      limitReset: 'daily',
    }),
    (error: unknown) => {
      assert.ok(error && typeof error === 'object' && 'code' in error);
      assert.equal(error.code, 'OPENROUTER_RUNTIME_SECRET_STORE_FAILED');
      assert.equal(JSON.stringify(error).includes(RUNTIME_CREDENTIAL), false);
      return true;
    },
  );
  assert.equal(deps.saved.length, 0);
});

test('management credential ingestion emits only ciphertext, reference, and fingerprint', () => {
  const previousVaultKey = process.env.VAULT_KEY;
  process.env.VAULT_KEY = 'ab'.repeat(32);
  try {
    const prepared = prepareOpenRouterManagementSecret(MANAGEMENT_CREDENTIAL, 'operator:test');
    assert.equal(prepared.provider, 'openrouter');
    assert.equal(prepared.secretKind, 'management_key');
    assert.match(prepared.fingerprint, /^sha256:[0-9a-f]{64}$/);
    assert.equal(prepared.encryptedValue.includes(MANAGEMENT_CREDENTIAL), false);
    assert.equal(JSON.stringify({
      id: prepared.id,
      provider: prepared.provider,
      secretKind: prepared.secretKind,
      fingerprint: prepared.fingerprint,
    }).includes(MANAGEMENT_CREDENTIAL), false);
  } finally {
    if (previousVaultKey === undefined) delete process.env.VAULT_KEY;
    else process.env.VAULT_KEY = previousVaultKey;
  }
});
