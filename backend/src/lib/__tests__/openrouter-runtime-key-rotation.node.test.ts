/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import type {
  OpenRouterCreateLimitedKey,
  OpenRouterCreatedLimitedKey,
  OpenRouterKeyMetadata,
  OpenRouterOperationContext,
  OpenRouterRuntimeKeyReference,
} from '../openrouter-authority-provider-adapter';
import {
  OpenRouterRotationReplacementSchema,
  OpenRouterRuntimeKeyRotationService,
  assertOpenRouterRotationApproval,
  createOpenRouterRotationIntent,
  openRouterReplacementName,
  type OpenRouterRotationClaim,
  type OpenRouterRotationIntent,
  type OpenRouterRotationIntentMaterial,
  type OpenRouterRotationProvider,
  type OpenRouterRotationReplacement,
  type OpenRouterRotationStore,
} from '../openrouter-runtime-key-rotation';

const WORKSPACE_ID = 'workspace-one';
const BINDING_ID = '11111111-1111-4111-8111-111111111111';
const CURRENT_SECRET_ID = '22222222-2222-4222-8222-222222222222';
const REPLACEMENT_SECRET_ID = '33333333-3333-4333-8333-333333333333';
const EXECUTION_ONE = '44444444-4444-4444-8444-444444444444';
const EXECUTION_TWO = '55555555-5555-4555-8555-555555555555';
const INTENT_ID = '66666666-6666-4666-8666-666666666666';
const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;
const HASH_C = `sha256:${'c'.repeat(64)}`;

function material(): OpenRouterRotationIntentMaterial {
  return {
    schemaVersion: 'rorca.openrouter-runtime-key-rotation-intent.v1',
    workspaceId: WORKSPACE_ID,
    providerBinding: {
      providerId: 'openrouter',
      bindingId: BINDING_ID,
      generation: 7,
      providerAccountId: 'account-one',
    },
    currentRuntimeKey: {
      secretReferenceId: CURRENT_SECRET_ID,
      fingerprint: HASH_A,
    },
    desiredName: 'pipeline-runtime',
    limits: {
      creditLimitUsd: 4,
      usageLimit: 100,
      limitReset: 'daily',
      includeByokInLimit: false,
    },
    targetBinding: {
      adapterId: 'disposable-runtime-target',
      bindingId: 'runtime-binding-one',
      workspaceId: WORKSPACE_ID,
      environmentId: 'staging',
      generation: 3,
    },
    canary: {
      contractId: 'openrouter-real-completion',
      contractVersion: 1,
      requestDigest: HASH_B,
      responseAssertionDigest: HASH_C,
      modelId: 'openrouter/free',
      maxTokens: 8,
    },
    timeoutMs: 60_000,
    rollbackAction: 'restore-prior-binding',
  };
}

function replacement(
  intent: OpenRouterRotationIntent,
  patch: Partial<OpenRouterRotationReplacement> = {},
): OpenRouterRotationReplacement {
  return OpenRouterRotationReplacementSchema.parse({
    intentId: INTENT_ID,
    requestDigest: intent.requestDigest,
    workspaceId: intent.workspaceId,
    stableName: openRouterReplacementName(intent),
    fencingToken: 1,
    executionId: EXECUTION_ONE,
    operationState: 'creating',
    lifecycleState: 'pending',
    providerResourceId: null,
    runtimeKeyReference: null,
    limits: intent.limits,
    targetBinding: intent.targetBinding,
    ...patch,
  });
}

class MemoryRotationStore implements OpenRouterRotationStore {
  private persistedIntent: OpenRouterRotationIntent | null = null;
  current: OpenRouterRotationReplacement | null = null;

  async claim(
    intent: OpenRouterRotationIntent,
    stableName: string,
    executionId: string,
    fencingToken: number,
  ): Promise<OpenRouterRotationClaim> {
    if (this.persistedIntent === null) {
      this.persistedIntent = intent;
      this.current = replacement(intent, { stableName, executionId, fencingToken });
      return { action: 'create', replacement: this.current };
    }
    assert.equal(JSON.stringify(intent), JSON.stringify(this.persistedIntent), 'digest collision changed immutable intent');
    assert.ok(this.current);
    if (fencingToken < this.current.fencingToken) throw new Error('stale fence');
    if (fencingToken > this.current.fencingToken) {
      this.current = replacement(intent, { ...this.current, fencingToken, executionId });
    }
    return {
      action: this.current.operationState === 'settled' ? 'return' : 'reconcile',
      replacement: this.current,
    };
  }

  async recordCreated(
    intent: OpenRouterRotationIntent,
    executionId: string,
    fencingToken: number,
    created: OpenRouterCreatedLimitedKey,
  ): Promise<OpenRouterRotationReplacement> {
    assert.ok(this.current);
    if (this.current.operationState !== 'creating'
        || this.current.executionId !== executionId
        || this.current.fencingToken !== fencingToken) {
      throw new Error('creation fence lost');
    }
    this.current = replacement(intent, {
      ...this.current,
      operationState: 'settled',
      lifecycleState: 'pending',
      providerResourceId: created.key.resourceId,
      runtimeKeyReference: created.runtimeKeyReference,
    });
    return this.current;
  }

  async recordReconciled(
    intent: OpenRouterRotationIntent,
    executionId: string,
    fencingToken: number,
    resource: OpenRouterKeyMetadata,
    runtimeKeyReference: OpenRouterRuntimeKeyReference | null,
    lifecycleState: 'reconciled' | 'cleanup-required',
  ): Promise<OpenRouterRotationReplacement> {
    assert.ok(this.current);
    if (this.current.fencingToken !== fencingToken) throw new Error('reconciliation fence lost');
    if (this.current.operationState === 'settled') {
      assert.equal(this.current.providerResourceId, resource.resourceId);
      return this.current;
    }
    this.current = replacement(intent, {
      ...this.current,
      executionId,
      operationState: 'settled',
      lifecycleState,
      providerResourceId: resource.resourceId,
      runtimeKeyReference,
    });
    return this.current;
  }

  async markCreationUncertain(
    intent: OpenRouterRotationIntent,
    executionId: string,
    fencingToken: number,
  ): Promise<OpenRouterRotationReplacement> {
    assert.ok(this.current);
    if (this.current.fencingToken !== fencingToken) throw new Error('uncertain fence lost');
    if (this.current.operationState !== 'settled') {
      this.current = replacement(intent, {
        ...this.current,
        executionId,
        operationState: 'creation-uncertain',
        lifecycleState: 'pending',
      });
    }
    return this.current;
  }
}

class ProviderFixture implements OpenRouterRotationProvider {
  createCalls = 0;
  listCalls = 0;
  createInputs: OpenRouterCreateLimitedKey[] = [];
  resources: OpenRouterKeyMetadata[] = [];
  references = new Map<string, OpenRouterRuntimeKeyReference>();
  private creationGate: Promise<void> | null = null;
  private startedResolve: (() => void) | null = null;
  readonly createStarted = new Promise<void>((resolve) => { this.startedResolve = resolve; });

  blockCreation(gate: Promise<void>): void {
    this.creationGate = gate;
  }

  async createLimitedKeyForRotation(input: OpenRouterCreateLimitedKey): Promise<OpenRouterCreatedLimitedKey> {
    this.createCalls += 1;
    this.createInputs.push(input);
    this.startedResolve?.();
    if (this.creationGate) await this.creationGate;
    const key: OpenRouterKeyMetadata = {
      resourceId: 'provider-resource-one',
      fingerprint: `sha256:${crypto.createHash('sha256').update('provider-resource-one').digest('hex')}`,
      name: input.name,
      status: 'active',
      limits: {
        creditLimitUsd: input.creditLimitUsd,
        usage: 0,
        limitReset: input.limitReset,
        includeByokInLimit: input.includeByokInLimit ?? false,
      },
      providerCreatedAt: '2026-08-23T09:00:00.000Z',
      providerUpdatedAt: null,
    };
    const runtimeKeyReference = { secretId: REPLACEMENT_SECRET_ID, fingerprint: HASH_B };
    this.resources = [key];
    this.references.set(key.resourceId, runtimeKeyReference);
    return { key, runtimeKeyReference };
  }

  async listKeys(_context: OpenRouterOperationContext): Promise<OpenRouterKeyMetadata[]> {
    this.listCalls += 1;
    return this.resources;
  }

  async getStoredRuntimeKeyReference(
    _context: OpenRouterOperationContext,
    resourceId: string,
  ): Promise<OpenRouterRuntimeKeyReference | null> {
    return this.references.get(resourceId) ?? null;
  }
}

function execution(intent: OpenRouterRotationIntent, executionId = EXECUTION_ONE) {
  return {
    intent,
    approvedRequestDigest: intent.requestDigest,
    executionId,
    fencingToken: 1,
  };
}

test('the exact immutable digest binds every approved rotation field', () => {
  const baseMaterial = material();
  const base = createOpenRouterRotationIntent(baseMaterial);
  const changedMaterials: Array<[string, OpenRouterRotationIntentMaterial]> = [
    ['provider binding', { ...baseMaterial, providerBinding: { ...baseMaterial.providerBinding, generation: 8 } }],
    ['current fingerprint', { ...baseMaterial, currentRuntimeKey: { ...baseMaterial.currentRuntimeKey, fingerprint: HASH_C } }],
    ['current reference', { ...baseMaterial, currentRuntimeKey: { ...baseMaterial.currentRuntimeKey, secretReferenceId: REPLACEMENT_SECRET_ID } }],
    ['limits', { ...baseMaterial, limits: { ...baseMaterial.limits, usageLimit: 99 } }],
    ['target binding', { ...baseMaterial, targetBinding: { ...baseMaterial.targetBinding, environmentId: 'canary' } }],
    ['canary', { ...baseMaterial, canary: { ...baseMaterial.canary, requestDigest: HASH_C } }],
    ['timeout', { ...baseMaterial, timeoutMs: 60_001 }],
    ['rollback action', { ...baseMaterial, rollbackAction: 'disable-replacement' }],
  ];

  for (const [field, changedMaterial] of changedMaterials) {
    const changed = createOpenRouterRotationIntent(changedMaterial);
    assert.notEqual(changed.requestDigest, base.requestDigest, `${field} must change the digest`);
    assert.throws(
      () => assertOpenRouterRotationApproval(changed, base.requestDigest),
      /approval does not match/,
      `${field} must invalidate prior approval`,
    );
  }
  assert.equal(Object.isFrozen(base), true);
  assert.equal(Object.isFrozen(base.targetBinding), true);
  assert.equal(Reflect.set(base.targetBinding, 'environmentId', 'forbidden'), false);
});

test('concurrent execution and replay issue at most one provider replacement', async () => {
  const intent = createOpenRouterRotationIntent(material());
  const store = new MemoryRotationStore();
  const provider = new ProviderFixture();
  let releaseCreation: (() => void) | undefined;
  provider.blockCreation(new Promise<void>((resolve) => { releaseCreation = resolve; }));
  const service = new OpenRouterRuntimeKeyRotationService(provider, store);

  const first = service.execute(execution(intent));
  await provider.createStarted;
  const concurrent = await service.execute(execution(intent, EXECUTION_TWO));
  assert.equal(concurrent.lifecycleState, 'pending');
  assert.equal(concurrent.operationState, 'creation-uncertain');
  releaseCreation?.();
  const settled = await first;
  const replay = await service.execute(execution(intent, EXECUTION_TWO));

  assert.equal(provider.createCalls, 1);
  assert.ok(provider.listCalls >= 2, 'uncertain and lost-fence outcomes must list before another create');
  assert.equal(settled.providerResourceId, 'provider-resource-one');
  assert.equal(replay.providerResourceId, 'provider-resource-one');
  assert.equal(replay.lifecycleState, 'reconciled');
  assert.match(replay.stableName, /\[rorca:[0-9a-f]{64}\]$/);
});

test('a crash after provider acceptance reconciles stable metadata and the provider resource id', async () => {
  const intent = createOpenRouterRotationIntent(material());
  const store = new MemoryRotationStore();
  const provider = new ProviderFixture();
  const injectedRuntimeKey = 'sk-or-v1-injected-runtime-key';
  const crashing = new OpenRouterRuntimeKeyRotationService(provider, store, {
    afterProviderAcceptance() { throw new Error(injectedRuntimeKey); },
  });

  await assert.rejects(
    crashing.execute(execution(intent)),
    (error: unknown) => {
      assert.equal(error instanceof Error, true);
      const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
      assert.equal(serialized.includes(injectedRuntimeKey), false);
      assert.match(String(error), /Injected crash at the afterProviderAcceptance boundary/);
      return true;
    },
  );
  assert.equal(provider.createCalls, 1);
  assert.equal(store.current?.providerResourceId, null);

  const recovered = await new OpenRouterRuntimeKeyRotationService(provider, store)
    .execute(execution(intent, EXECUTION_TWO));
  assert.equal(provider.createCalls, 1);
  assert.equal(provider.listCalls, 1);
  assert.equal(recovered.providerResourceId, 'provider-resource-one');
  assert.deepEqual(recovered.runtimeKeyReference, {
    secretId: REPLACEMENT_SECRET_ID,
    fingerprint: HASH_B,
  });
  assert.equal(recovered.lifecycleState, 'reconciled');
});

test('provider acceptance before SecretStore persistence is tracked as cleanup-required', async () => {
  const intent = createOpenRouterRotationIntent(material());
  const store = new MemoryRotationStore();
  const provider = new ProviderFixture();
  await store.claim(intent, openRouterReplacementName(intent), EXECUTION_ONE, 1);
  provider.resources = [{
    resourceId: 'provider-accepted-without-secret',
    fingerprint: HASH_C,
    name: openRouterReplacementName(intent),
    status: 'active',
    limits: {
      creditLimitUsd: intent.limits.creditLimitUsd,
      usage: 0,
      limitReset: intent.limits.limitReset,
      includeByokInLimit: intent.limits.includeByokInLimit,
    },
    providerCreatedAt: '2026-08-23T09:01:00.000Z',
    providerUpdatedAt: null,
  }];

  const recovered = await new OpenRouterRuntimeKeyRotationService(provider, store)
    .execute(execution(intent, EXECUTION_TWO));
  assert.equal(provider.createCalls, 0);
  assert.equal(provider.listCalls, 1);
  assert.equal(recovered.providerResourceId, 'provider-accepted-without-secret');
  assert.equal(recovered.runtimeKeyReference, null);
  assert.equal(recovered.lifecycleState, 'cleanup-required');
  assert.equal(recovered.operationState, 'settled');
});

test('creation uses only declared limits and exact workspace/environment scope', async () => {
  const intent = createOpenRouterRotationIntent(material());
  const store = new MemoryRotationStore();
  const provider = new ProviderFixture();
  const result = await new OpenRouterRuntimeKeyRotationService(provider, store).execute(execution(intent));

  assert.deepEqual(provider.createInputs, [{
    workspaceId: WORKSPACE_ID,
    bindingId: BINDING_ID,
    bindingGeneration: 7,
    providerAccountId: 'account-one',
    name: openRouterReplacementName(intent),
    creditLimitUsd: 4,
    usageLimit: 100,
    limitReset: 'daily',
    includeByokInLimit: false,
  }]);
  assert.deepEqual(result.limits, intent.limits);
  assert.deepEqual(result.targetBinding, intent.targetBinding);

  const wrongEnvironment = createOpenRouterRotationIntent({
    ...material(),
    targetBinding: { ...material().targetBinding, environmentId: 'production' },
  });
  await assert.rejects(
    new OpenRouterRuntimeKeyRotationService(provider, store).execute({
      ...execution(wrongEnvironment, EXECUTION_TWO),
      approvedRequestDigest: intent.requestDigest,
    }),
    /approval does not match/,
  );
  assert.equal(provider.createCalls, 1, 'altered target scope must fail before provider access');

  assert.throws(() => createOpenRouterRotationIntent({
    ...material(),
    targetBinding: { ...material().targetBinding, workspaceId: 'workspace-two' },
  }), /target binding must belong to the rotation workspace/);
});

test('unknown is rejected while every declared replacement lifecycle is representable', () => {
  const intent = createOpenRouterRotationIntent(material());
  for (const lifecycleState of ['pending', 'active', 'revoked', 'cleanup-required', 'reconciled'] as const) {
    const runtimeKeyReference = lifecycleState === 'active' || lifecycleState === 'reconciled'
      ? { secretId: REPLACEMENT_SECRET_ID, fingerprint: HASH_B }
      : null;
    assert.equal(OpenRouterRotationReplacementSchema.parse({
      ...replacement(intent),
      operationState: 'settled',
      lifecycleState,
      providerResourceId: 'provider-resource-one',
      runtimeKeyReference,
    }).lifecycleState, lifecycleState);
  }
  assert.throws(() => OpenRouterRotationReplacementSchema.parse({
    ...replacement(intent),
    operationState: 'settled',
    lifecycleState: 'unknown',
    providerResourceId: 'provider-resource-one',
  }));
});
