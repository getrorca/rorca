/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { OpenRouterProviderBinding } from '../openrouter-authority-provider-adapter';
import {
  OpenRouterQualificationFixtureRegistry,
  OpenRouterRuntimeKeyQualificationService,
  calculateOpenRouterQualificationDigest,
  calculateOpenRouterRotationPolicyDigest,
  type AcceptOpenRouterRotationPolicyInput,
  type ExecuteOpenRouterQualificationInput,
  type OpenRouterLiveQualificationEvidence,
  type OpenRouterQualificationRecord,
  type OpenRouterQualificationStore,
  type OpenRouterRotationPolicyMaterial,
  type OpenRouterRotationPolicyRecord,
} from '../openrouter-runtime-key-qualification';
import {
  createOpenRouterRotationIntent,
  type OpenRouterRotationIntentMaterial,
} from '../openrouter-runtime-key-rotation';
import { DisposableOpenRouterLiveFixture } from './fixtures/openrouter-runtime-key-live-fixture';

const NOW = Date.parse('2026-08-24T12:00:00.000Z');
const WORKSPACE_ID = 'rorca-openrouter-qualification-workspace';
const OTHER_WORKSPACE_ID = 'rorca-openrouter-other-workspace';
const BINDING_ID = '11111111-1111-4111-8111-111111111111';
const QUALIFICATION_ID = '22222222-2222-4222-8222-222222222222';
const HASH_A = `sha256:${'a'.repeat(64)}`;
const TARGET_BINDING = {
  adapterId: 'rorca-disposable-openrouter-target',
  bindingId: 'rorca-live-target-binding',
  workspaceId: WORKSPACE_ID,
  environmentId: 'rorca-openrouter-qualification',
  generation: 1,
} as const;

function healthyBinding(): OpenRouterProviderBinding {
  return {
    bindingId: BINDING_ID,
    workspaceId: WORKSPACE_ID,
    bindingStatus: 'active',
    providerId: 'openrouter',
    providerAccountId: 'rorca-dedicated-low-limit-account',
    generation: 1,
    managementSecretReference: {
      secretId: '44444444-4444-4444-8444-444444444444',
      fingerprint: HASH_A,
    },
    policyLimits: {
      maxCreditUsd: 1,
      maxUsage: 100,
      allowedLimitResets: ['daily'],
      includeByokInLimit: false,
    },
    approvedOperations: ['list_keys', 'create_limited_key', 'disable_key', 'delete_key', 'verify_binding'],
    health: {
      providerAccountVerified: true,
      completionProbeRejected: true,
      verifiedAt: '2026-08-24T11:59:00.000Z',
      validationErrorCode: null,
    },
  };
}

function qualificationInput(
  overrides: Partial<ExecuteOpenRouterQualificationInput> = {},
): ExecuteOpenRouterQualificationInput {
  const material = {
    qualificationId: QUALIFICATION_ID,
    fixtureId: 'rorca-openrouter-live-fixture',
    workspaceId: WORKSPACE_ID,
    providerBinding: {
      bindingId: BINDING_ID,
      generation: 1,
      providerAccountId: 'rorca-dedicated-low-limit-account',
    },
    targetBinding: TARGET_BINDING,
    spendLimitUsd: 0.25,
    timeoutMs: 30_000,
    grantIssuedAt: '2026-08-24T11:55:00.000Z',
    grantExpiresAt: '2026-08-24T13:00:00.000Z',
    ...overrides,
  };
  const { requestDigest: suppliedDigest, ...digestMaterial } = material as typeof material & {
    requestDigest?: string;
  };
  return {
    ...digestMaterial,
    requestDigest: suppliedDigest ?? calculateOpenRouterQualificationDigest(digestMaterial),
  } as ExecuteOpenRouterQualificationInput;
}

function policyInput(
  qualificationId = QUALIFICATION_ID,
  targetBinding = TARGET_BINDING,
): AcceptOpenRouterRotationPolicyInput {
  const material: OpenRouterRotationPolicyMaterial = {
    policyVersion: 'rorca.openrouter-runtime-key-rotation-policy.v1',
    qualificationId,
    workspaceId: WORKSPACE_ID,
    providerBinding: {
      bindingId: BINDING_ID,
      generation: 1,
      providerAccountId: 'rorca-dedicated-low-limit-account',
    },
    targetBinding,
    maxRotationCreditUsd: 0.2,
    expiresAt: '2026-08-24T12:45:00.000Z',
  };
  return {
    ...material,
    policyDigest: calculateOpenRouterRotationPolicyDigest(material),
  };
}

function rotationIntent(targetBinding = TARGET_BINDING, creditLimitUsd = 0.1) {
  const material: OpenRouterRotationIntentMaterial = {
    schemaVersion: 'rorca.openrouter-runtime-key-rotation-intent.v1',
    workspaceId: WORKSPACE_ID,
    providerBinding: {
      providerId: 'openrouter',
      bindingId: BINDING_ID,
      generation: 1,
      providerAccountId: 'rorca-dedicated-low-limit-account',
    },
    currentRuntimeKey: {
      secretReferenceId: '55555555-5555-4555-8555-555555555555',
      fingerprint: HASH_A,
    },
    desiredName: 'rorca-qualified-replacement',
    limits: {
      creditLimitUsd,
      usageLimit: 25,
      limitReset: 'daily',
      includeByokInLimit: false,
    },
    targetBinding,
    canary: {
      contractId: 'rorca-qualified-canary',
      contractVersion: 1,
      requestDigest: HASH_A,
      responseAssertionDigest: `sha256:${'b'.repeat(64)}`,
      modelId: 'openrouter/auto',
      maxTokens: 4,
    },
    timeoutMs: 30_000,
    rollbackAction: 'delete-replacement',
  };
  return createOpenRouterRotationIntent(material);
}

class MemoryQualificationStore implements OpenRouterQualificationStore {
  readonly records = new Map<string, OpenRouterQualificationRecord>();
  readonly requestDigests = new Set<string>();
  policy: OpenRouterRotationPolicyRecord | null = null;

  async claim(input: ExecuteOpenRouterQualificationInput): Promise<boolean> {
    if (this.records.has(input.qualificationId) || this.requestDigests.has(input.requestDigest)) return false;
    this.requestDigests.add(input.requestDigest);
    this.records.set(input.qualificationId, {
      qualificationId: input.qualificationId,
      workspaceId: input.workspaceId,
      providerBinding: input.providerBinding,
      fixtureId: input.fixtureId,
      targetBinding: input.targetBinding,
      spendLimitUsd: input.spendLimitUsd,
      observedSpendUsd: null,
      timeoutMs: input.timeoutMs,
      requestDigest: input.requestDigest,
      grantIssuedAt: input.grantIssuedAt,
      grantExpiresAt: input.grantExpiresAt,
      state: 'running',
      receipt: null,
      failureCode: null,
      rollbackReceipt: null,
    });
    return true;
  }

  async complete(input: ExecuteOpenRouterQualificationInput, evidence: OpenRouterLiveQualificationEvidence, receipt: OpenRouterQualificationRecord['receipt']): Promise<void> {
    const record = this.records.get(input.qualificationId);
    assert.ok(record);
    assert.ok(receipt);
    record.state = 'passed';
    record.observedSpendUsd = evidence.spend.observedUsd;
    record.receipt = receipt;
  }

  async fail(qualificationId: string, failureCode: string): Promise<void> {
    const record = this.records.get(qualificationId);
    if (!record || record.state !== 'running') return;
    record.state = 'failed';
    record.failureCode = failureCode;
  }

  async read(qualificationId: string): Promise<OpenRouterQualificationRecord | null> {
    return this.records.get(qualificationId) ?? null;
  }

  async acceptPolicy(policy: OpenRouterRotationPolicyRecord): Promise<boolean> {
    if (this.policy?.status === 'active') return false;
    this.policy = policy;
    return true;
  }

  async readPolicy(workspaceId: string, bindingId: string): Promise<OpenRouterRotationPolicyRecord | null> {
    if (this.policy?.workspaceId !== workspaceId || this.policy.providerBinding.bindingId !== bindingId) return null;
    return this.policy;
  }

  async disablePolicy(workspaceId: string, bindingId: string, disabledAt: string): Promise<void> {
    if (this.policy?.workspaceId === workspaceId && this.policy.providerBinding.bindingId === bindingId) {
      this.policy = { ...this.policy, status: 'disabled', disabledAt };
    }
  }

  async recordRollback(qualificationId: string, receipt: NonNullable<OpenRouterQualificationRecord['rollbackReceipt']>): Promise<void> {
    const record = this.records.get(qualificationId);
    assert.ok(record);
    assert.equal(record.state, 'passed');
    record.state = 'rolled-back';
    record.rollbackReceipt = receipt;
  }
}

function harness(options: {
  binding?: OpenRouterProviderBinding | null;
  mutateEvidence?: (evidence: OpenRouterLiveQualificationEvidence) => OpenRouterLiveQualificationEvidence;
  registerFixture?: boolean;
} = {}) {
  const store = new MemoryQualificationStore();
  const fixtures = new OpenRouterQualificationFixtureRegistry();
  const fixture = new DisposableOpenRouterLiveFixture(TARGET_BINDING, options.mutateEvidence);
  if (options.registerFixture !== false) fixtures.register(fixture);
  const binding = options.binding === undefined ? healthyBinding() : options.binding;
  const service = new OpenRouterRuntimeKeyQualificationService(
    { getProviderBinding: async () => binding },
    store,
    fixtures,
    () => NOW,
  );
  return { service, store, fixture };
}

test('bounded live evidence records inference, cutover, rejection, rollback, crash recovery, and cleanup before opt-in', async () => {
  const { service, store, fixture } = harness();
  const input = qualificationInput();

  assert.deepEqual(await service.status(WORKSPACE_ID, BINDING_ID), { available: false, policy: null });
  const receipt = await service.qualify(input);

  assert.equal(receipt.spend.declaredLimitUsd, 0.25);
  assert.ok(receipt.spend.observedUsd <= receipt.spend.declaredLimitUsd);
  assert.equal(receipt.fixture.owner, 'rorca');
  assert.equal(receipt.fixture.accountClass, 'dedicated-low-limit');
  assert.equal(fixture.executeCalls, 1);
  assert.equal(store.records.get(QUALIFICATION_ID)?.state, 'passed');
  assert.equal((await service.status(WORKSPACE_ID, BINDING_ID)).available, false);

  const accepted = await service.acceptPolicy(policyInput());
  assert.equal(accepted.status, 'active');
  assert.equal((await service.status(WORKSPACE_ID, BINDING_ID)).available, true);
  await assert.doesNotReject(service.assertRotationAvailable(rotationIntent()));
});

test('prompt extraction and every scope, intent, grant, replay, and revoked-key probe are mandatory', async () => {
  const missingSecurity = harness({
    mutateEvidence: (evidence) => ({
      ...evidence,
      security: {
        ...evidence.security,
        crossWorkspace: { outcome: 'denied', providerCallMade: true },
      },
    }) as unknown as OpenRouterLiveQualificationEvidence,
  });
  await assert.rejects(
    missingSecurity.service.qualify(qualificationInput()),
    (error: unknown) => error instanceof Error && 'code' in error
      && error.code === 'OPENROUTER_QUALIFICATION_FAILED',
  );
  assert.equal(missingSecurity.store.records.get(QUALIFICATION_ID)?.state, 'failed');

  const { service, fixture } = harness();
  const input = qualificationInput();
  await service.qualify(input);
  await assert.rejects(
    service.qualify(input),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'CONFLICT',
  );
  assert.equal(fixture.executeCalls, 1);
});

test('altered, expired, cross-workspace, and cross-environment grants fail before fixture or provider work', async () => {
  const altered = harness();
  await assert.rejects(
    altered.service.qualify(qualificationInput({ spendLimitUsd: 0.2, requestDigest: HASH_A })),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'FORBIDDEN',
  );
  assert.equal(altered.fixture.executeCalls, 0);

  const expired = harness();
  await assert.rejects(
    expired.service.qualify(qualificationInput({
      qualificationId: '66666666-6666-4666-8666-666666666666',
      grantIssuedAt: '2026-08-24T10:00:00.000Z',
      grantExpiresAt: '2026-08-24T11:00:00.000Z',
    })),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'FORBIDDEN',
  );
  assert.equal(expired.fixture.executeCalls, 0);

  const crossWorkspace = harness();
  const foreignTarget = { ...TARGET_BINDING, workspaceId: OTHER_WORKSPACE_ID };
  await assert.rejects(
    crossWorkspace.service.qualify(qualificationInput({
      qualificationId: '77777777-7777-4777-8777-777777777776',
      workspaceId: OTHER_WORKSPACE_ID,
      targetBinding: foreignTarget,
    })),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'FORBIDDEN',
  );
  assert.equal(crossWorkspace.fixture.executeCalls, 0);

  const crossEnvironment = harness();
  await assert.rejects(
    crossEnvironment.service.qualify(qualificationInput({
      qualificationId: '77777777-7777-4777-8777-777777777775',
      targetBinding: { ...TARGET_BINDING, environmentId: 'foreign-production' },
    })),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'FORBIDDEN',
  );
  assert.equal(crossEnvironment.fixture.executeCalls, 0);
});

test('all six injected crash boundaries and bounded provider cleanup are required', async () => {
  const incomplete = harness({
    mutateEvidence: (evidence) => ({
      ...evidence,
      crashRecovery: evidence.crashRecovery.slice(1),
    }) as OpenRouterLiveQualificationEvidence,
  });
  await assert.rejects(incomplete.service.qualify(qualificationInput()));
  assert.equal(incomplete.store.records.get(QUALIFICATION_ID)?.state, 'failed');

  const overspend = harness({
    mutateEvidence: (evidence) => ({
      ...evidence,
      spend: { ...evidence.spend, observedUsd: evidence.spend.declaredLimitUsd + 0.01 },
    }),
  });
  await assert.rejects(
    overspend.service.qualify(qualificationInput()),
    (error: unknown) => error instanceof Error && 'code' in error
      && error.code === 'OPENROUTER_QUALIFICATION_SPEND_EXCEEDED',
  );
});

test('adapter rollout stays unavailable without both exact healthy binding and accepted current policy', async () => {
  const noFixture = harness({ registerFixture: false });
  await assert.rejects(
    noFixture.service.qualify(qualificationInput()),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'SERVICE_UNAVAILABLE',
  );

  const unhealthy = healthyBinding();
  unhealthy.health = { ...unhealthy.health, completionProbeRejected: false, verifiedAt: null };
  const unhealthyHarness = harness({ binding: unhealthy });
  await assert.rejects(
    unhealthyHarness.service.qualify(qualificationInput()),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'FORBIDDEN',
  );

  const unaccepted = harness();
  await assert.rejects(
    unaccepted.service.assertRotationAvailable(rotationIntent()),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'FORBIDDEN',
  );
});

test('rollback disables rollout first, restores the fixture, revokes replacements, and preserves receipts idempotently', async () => {
  const { service, store, fixture } = harness();
  const qualification = await service.qualify(qualificationInput());
  await service.acceptPolicy(policyInput());

  await assert.rejects(
    service.rollback({
      qualificationId: QUALIFICATION_ID,
      workspaceId: OTHER_WORKSPACE_ID,
      bindingId: BINDING_ID,
    }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'FORBIDDEN',
  );
  assert.equal(store.policy?.status, 'active');
  assert.equal(fixture.rollbackCalls, 0);

  const rollbackScope = {
    qualificationId: QUALIFICATION_ID,
    workspaceId: WORKSPACE_ID,
    bindingId: BINDING_ID,
  };
  const rollback = await service.rollback(rollbackScope);
  assert.equal(rollback.qualificationReceiptDigest, qualification.receiptDigest);
  assert.equal(rollback.priorBindingRestored, true);
  assert.equal(rollback.targetFunctional, true);
  assert.equal(rollback.receiptsPreserved, true);
  assert.ok(rollback.replacements.every((resource) => resource.providerStatus !== 'active'));
  assert.equal(store.policy?.status, 'disabled');
  assert.equal(store.records.get(QUALIFICATION_ID)?.state, 'rolled-back');
  assert.equal((await service.status(WORKSPACE_ID, BINDING_ID)).available, false);

  assert.deepEqual(await service.rollback(rollbackScope), rollback);
  assert.equal(fixture.rollbackCalls, 1);
});

test('accepted policy is exact to target environment, credit ceiling, and qualification lifetime', async () => {
  const { service } = harness();
  await service.qualify(qualificationInput());
  const accepted = policyInput();
  await service.acceptPolicy(accepted);

  await assert.rejects(
    service.assertRotationAvailable(rotationIntent({ ...TARGET_BINDING, environmentId: 'foreign-production' })),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'FORBIDDEN',
  );
  await assert.rejects(
    service.assertRotationAvailable(rotationIntent(TARGET_BINDING, 0.21)),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'FORBIDDEN',
  );
});
