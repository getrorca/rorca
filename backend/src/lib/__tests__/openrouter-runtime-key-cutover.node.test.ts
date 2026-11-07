/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  OpenRouterKeyMetadata,
  OpenRouterOperationContext,
} from '../openrouter-authority-provider-adapter';
import {
  OpenRouterRotationCutoverRecordSchema,
  OpenRouterRuntimeKeyCutoverService,
  type OpenRouterCutoverProvider,
  type OpenRouterCutoverFaults,
  type OpenRouterRotationCutoverReceipt,
  type OpenRouterRotationRecoveryReceipt,
  type OpenRouterRotationCutoverRecord,
  type OpenRouterRotationCutoverStore,
} from '../openrouter-runtime-key-cutover';
import {
  OpenRouterRotationReplacementSchema,
  OpenRouterRuntimeKeyRotationService,
  createOpenRouterRotationIntent,
  openRouterReplacementName,
  type ExecuteOpenRouterRotationInput,
  type OpenRouterRotationIntent,
  type OpenRouterRotationIntentMaterial,
  type OpenRouterRotationReplacement,
} from '../openrouter-runtime-key-rotation';
import type {
  ActivateRuntimeSecretInput,
  DeployRuntimeSecretInput,
  RunRuntimeCompletionCanaryInput,
  RuntimeProviderCompletionEvidence,
  RuntimeSecretBindingAdapter,
  RuntimeSecretBindingAdapterResolver,
  RestoreRuntimeSecretBindingInput,
  StageRuntimeSecretInput,
  VerifyRuntimeCredentialRejectedInput,
} from '../runtime-secret-binding-adapter';

const WORKSPACE_ID = 'workspace-one';
const BINDING_ID = '11111111-1111-4111-8111-111111111111';
const CURRENT_SECRET_ID = '22222222-2222-4222-8222-222222222222';
const REPLACEMENT_SECRET_ID = '33333333-3333-4333-8333-333333333333';
const EXECUTION_ID = '44444444-4444-4444-8444-444444444444';
const INTENT_ID = '55555555-5555-4555-8555-555555555555';
const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;
const HASH_C = `sha256:${'c'.repeat(64)}`;
const OLD_KEY_VALUE = 'sk-or-v1-old-key-value';
const REPLACEMENT_KEY_VALUE = 'sk-or-v1-replacement-key-value';
const HASH_D = `sha256:${'d'.repeat(64)}`;
const HASH_E = `sha256:${'e'.repeat(64)}`;
const INITIAL_NOW = Date.parse('2026-08-23T10:00:00.000Z');

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

function replacement(intent: OpenRouterRotationIntent): OpenRouterRotationReplacement {
  return OpenRouterRotationReplacementSchema.parse({
    intentId: INTENT_ID,
    requestDigest: intent.requestDigest,
    workspaceId: intent.workspaceId,
    stableName: openRouterReplacementName(intent),
    fencingToken: 1,
    executionId: EXECUTION_ID,
    operationState: 'settled',
    lifecycleState: 'pending',
    providerResourceId: 'replacement-resource',
    runtimeKeyReference: {
      secretId: REPLACEMENT_SECRET_ID,
      fingerprint: HASH_D,
    },
    limits: intent.limits,
    targetBinding: intent.targetBinding,
  });
}

function execution(intent: OpenRouterRotationIntent): ExecuteOpenRouterRotationInput {
  return {
    intent,
    approvedRequestDigest: intent.requestDigest,
    executionId: EXECUTION_ID,
    fencingToken: 1,
  };
}

class SettledRotationService extends OpenRouterRuntimeKeyRotationService {
  constructor(private readonly settled: OpenRouterRotationReplacement) {
    super();
  }

  override async execute(_input: ExecuteOpenRouterRotationInput): Promise<OpenRouterRotationReplacement> {
    return this.settled;
  }
}

class MemoryCutoverStore implements OpenRouterRotationCutoverStore {
  current: OpenRouterRotationCutoverRecord | null = null;
  replacementActive = false;
  replacementLifecycle: 'pending' | 'active' | 'revoked' | 'cleanup-required' = 'pending';
  completeFailures = 0;
  readonly receipts: OpenRouterRotationCutoverReceipt[] = [];
  readonly recoveryReceipts: OpenRouterRotationRecoveryReceipt[] = [];

  constructor(
    private readonly events: string[],
    private readonly now: () => number,
  ) {}

  private update(patch: Partial<OpenRouterRotationCutoverRecord>): OpenRouterRotationCutoverRecord {
    assert.ok(this.current);
    this.current = OpenRouterRotationCutoverRecordSchema.parse({ ...this.current, ...patch });
    return this.current;
  }

  async claim(
    intent: OpenRouterRotationIntent,
    settled: OpenRouterRotationReplacement,
    executionId: string,
    fencingToken: number,
  ): Promise<OpenRouterRotationCutoverRecord> {
    if (!this.current) {
      this.current = OpenRouterRotationCutoverRecordSchema.parse({
        intentId: settled.intentId,
        workspaceId: intent.workspaceId,
        requestDigest: intent.requestDigest,
        executionId,
        fencingToken,
        state: 'REPLACEMENT_READY',
        resumeState: null,
        waitingReasonCode: null,
        timeoutConsumedMs: 0,
        timeoutStartedAt: null,
        oldProviderResourceId: 'old-resource',
        targetBindingGeneration: null,
        targetRequiresDeployment: null,
        deployedRevision: null,
        canaryEvidence: null,
        oldKeyDisabledAt: null,
        rejectionEvidence: null,
        receipt: null,
        completedAt: null,
        failureState: null,
        failureCode: null,
        restoredBindingGeneration: null,
        restoredRevision: null,
        reconciliationReasonCode: null,
        recoveryReceipt: null,
      });
    }
    return this.current;
  }

  async markWaiting(
    _intent: OpenRouterRotationIntent,
    _executionId: string,
    _fencingToken: number,
    reasonCode: string,
  ): Promise<OpenRouterRotationCutoverRecord> {
    assert.ok(this.current);
    const resumeState = this.current.state === 'WAITING_FOR_AUTHORIZATION'
      ? this.current.resumeState
      : this.current.state;
    this.events.push('persist:waiting');
    return this.update({
      state: 'WAITING_FOR_AUTHORIZATION',
      resumeState: resumeState === 'COMPLETED'
        || resumeState === 'WAITING_FOR_AUTHORIZATION'
        || resumeState === 'ROLLBACK_PENDING'
        || resumeState === 'TARGET_RESTORED'
        || resumeState === 'ROLLED_BACK'
        ? null
        : resumeState,
      waitingReasonCode: reasonCode,
      timeoutStartedAt: null,
    });
  }

  async startExecution(): Promise<OpenRouterRotationCutoverRecord> {
    assert.ok(this.current);
    const state = this.current.state === 'WAITING_FOR_AUTHORIZATION'
      ? this.current.resumeState
      : this.current.state;
    assert.ok(state);
    return this.update({
      state,
      resumeState: null,
      waitingReasonCode: null,
      timeoutStartedAt: this.current.timeoutStartedAt ?? new Date(this.now()).toISOString(),
    });
  }

  async recordBindingStaged(
    _intent: OpenRouterRotationIntent,
    _executionId: string,
    _fencingToken: number,
    bindingGeneration: number,
    requiresDeployment: boolean,
  ): Promise<OpenRouterRotationCutoverRecord> {
    this.events.push('persist:stage');
    return this.update({
      state: 'BINDING_STAGED',
      targetBindingGeneration: bindingGeneration,
      targetRequiresDeployment: requiresDeployment,
    });
  }

  async recordTargetDeployed(
    _intent: OpenRouterRotationIntent,
    _executionId: string,
    _fencingToken: number,
    deployedRevision: string,
  ): Promise<OpenRouterRotationCutoverRecord> {
    this.events.push('persist:deploy');
    return this.update({ state: 'TARGET_DEPLOYED', deployedRevision });
  }

  async recordCanaryPassed(
    _intent: OpenRouterRotationIntent,
    _executionId: string,
    _fencingToken: number,
    evidence: RuntimeProviderCompletionEvidence,
  ): Promise<OpenRouterRotationCutoverRecord> {
    this.events.push('persist:canary');
    return this.update({ state: 'CANARY_PASSED', canaryEvidence: evidence });
  }

  async recordBindingActive(): Promise<OpenRouterRotationCutoverRecord> {
    this.events.push('persist:active');
    return this.update({ state: 'BINDING_ACTIVE' });
  }

  async beginOldKeyDisable(): Promise<OpenRouterRotationCutoverRecord> {
    this.events.push('persist:disable-pending');
    return this.update({ state: 'OLD_KEY_DISABLE_PENDING' });
  }

  async recordOldKeyDisabled(): Promise<OpenRouterRotationCutoverRecord> {
    this.events.push('persist:disabled');
    return this.update({
      state: 'OLD_KEY_DISABLED',
      oldKeyDisabledAt: new Date(this.now()).toISOString(),
      reconciliationReasonCode: null,
    });
  }

  async complete(
    _intent: OpenRouterRotationIntent,
    _replacement: OpenRouterRotationReplacement,
    _executionId: string,
    _fencingToken: number,
    rejectionEvidence: Parameters<OpenRouterRotationCutoverStore['complete']>[4],
    receipt: OpenRouterRotationCutoverReceipt,
  ): Promise<OpenRouterRotationCutoverRecord> {
    if (this.completeFailures > 0) {
      this.completeFailures -= 1;
      throw new Error(`receipt persistence failure ${OLD_KEY_VALUE} ${REPLACEMENT_KEY_VALUE}`);
    }
    assert.equal(this.receipts.length, 0, 'receipt emission must be exactly once');
    this.events.push('persist:complete');
    this.replacementActive = true;
    this.replacementLifecycle = 'active';
    this.receipts.push(receipt);
    return this.update({
      state: 'COMPLETED',
      timeoutStartedAt: null,
      rejectionEvidence,
      receipt,
      completedAt: receipt.emittedAt,
      reconciliationReasonCode: null,
    });
  }

  async beginRollback(
    _intent: OpenRouterRotationIntent,
    _executionId: string,
    _fencingToken: number,
    failureState: OpenRouterRotationCutoverRecord['state'],
    failureCode: string,
  ): Promise<OpenRouterRotationCutoverRecord> {
    this.events.push('persist:rollback');
    return this.update({
      state: 'ROLLBACK_PENDING',
      failureState,
      failureCode,
      reconciliationReasonCode: null,
    });
  }

  async recordTargetRestored(
    _intent: OpenRouterRotationIntent,
    _executionId: string,
    _fencingToken: number,
    restoredBindingGeneration: number,
    restoredRevision: string,
  ): Promise<OpenRouterRotationCutoverRecord> {
    this.events.push('persist:restored');
    return this.update({
      state: 'TARGET_RESTORED',
      restoredBindingGeneration,
      restoredRevision,
      reconciliationReasonCode: null,
    });
  }

  async completeRollback(
    _intent: OpenRouterRotationIntent,
    _replacement: OpenRouterRotationReplacement,
    _executionId: string,
    _fencingToken: number,
    receipt: OpenRouterRotationRecoveryReceipt,
  ): Promise<OpenRouterRotationCutoverRecord> {
    this.events.push('persist:rolled-back');
    this.replacementLifecycle = 'revoked';
    this.recoveryReceipts.push(receipt);
    return this.update({
      state: 'ROLLED_BACK',
      timeoutStartedAt: null,
      recoveryReceipt: receipt,
      reconciliationReasonCode: null,
      completedAt: receipt.emittedAt,
    });
  }

  async markReconciliationRequired(
    _intent: OpenRouterRotationIntent,
    _replacement: OpenRouterRotationReplacement,
    _executionId: string,
    _fencingToken: number,
    reasonCode: string,
    receipt: OpenRouterRotationRecoveryReceipt,
    replacementCleanupRequired: boolean,
  ): Promise<OpenRouterRotationCutoverRecord> {
    this.events.push('persist:reconciliation');
    if (replacementCleanupRequired) this.replacementLifecycle = 'cleanup-required';
    this.recoveryReceipts.push(receipt);
    return this.update({
      reconciliationReasonCode: reasonCode,
      recoveryReceipt: receipt,
      timeoutStartedAt: null,
    });
  }

  async clearReconciliationRequired(): Promise<OpenRouterRotationCutoverRecord> {
    this.events.push('persist:reconciliation-cleared');
    return this.update({ reconciliationReasonCode: null });
  }
}

class TargetFixture implements RuntimeSecretBindingAdapter {
  readonly adapterId = 'disposable-runtime-target';
  canaryResult: unknown;
  failAt: 'stage' | 'deploy' | 'canary' | 'activate' | 'restore' | 'rejection' | null = null;
  currentGeneration = 3;
  stageMutations = 0;
  deployMutations = 0;
  activationMutations = 0;
  restoreMutations = 0;

  constructor(private readonly events: string[]) {
    this.canaryResult = {
      kind: 'provider-completion',
      providerId: 'openrouter',
      endpoint: 'chat-completions',
      contractId: 'openrouter-real-completion',
      contractVersion: 1,
      requestDigest: HASH_B,
      responseAssertionDigest: HASH_C,
      modelId: 'openrouter/free',
      targetBindingGeneration: 4,
      deployedRevision: 'revision-42',
      providerResponseDigest: HASH_E,
      completedAt: '2026-08-23T10:00:01.000Z',
    };
  }

  private injectFailure(boundary: TargetFixture['failAt']): void {
    if (this.failAt !== boundary) return;
    this.failAt = null;
    throw new Error(`adapter failure ${OLD_KEY_VALUE} ${REPLACEMENT_KEY_VALUE}`);
  }

  async stageReplacement(input: StageRuntimeSecretInput) {
    this.events.push('stage');
    assert.deepEqual(input.replacement, { secretId: REPLACEMENT_SECRET_ID, fingerprint: HASH_D });
    if (this.currentGeneration === 3) {
      this.currentGeneration = 4;
      this.stageMutations += 1;
    }
    this.injectFailure('stage');
    return { bindingGeneration: 4, requiresDeployment: true };
  }

  async deployOrRefresh(input: DeployRuntimeSecretInput) {
    this.events.push('deploy');
    assert.equal(input.bindingGeneration, 4);
    assert.equal(input.requiresDeployment, true);
    if (this.deployMutations === 0) this.deployMutations += 1;
    this.injectFailure('deploy');
    return { bindingGeneration: 4, deployedRevision: 'revision-42' };
  }

  async runProviderCompletionCanary(
    _input: RunRuntimeCompletionCanaryInput,
  ): Promise<RuntimeProviderCompletionEvidence> {
    this.events.push('canary');
    this.injectFailure('canary');
    return this.canaryResult as RuntimeProviderCompletionEvidence;
  }

  async activateStagedBinding(input: ActivateRuntimeSecretInput) {
    this.events.push('activate');
    if (this.currentGeneration !== input.bindingGeneration) {
      this.currentGeneration = input.bindingGeneration;
      this.activationMutations += 1;
    } else if (this.activationMutations === 0) {
      this.activationMutations += 1;
    }
    this.injectFailure('activate');
    return { bindingGeneration: input.bindingGeneration, deployedRevision: input.deployedRevision };
  }

  async restorePriorBinding(input: RestoreRuntimeSecretBindingInput) {
    this.events.push('restore');
    assert.equal(input.priorBindingGeneration, 3);
    if (this.currentGeneration !== input.priorBindingGeneration) {
      this.currentGeneration = input.priorBindingGeneration;
      this.restoreMutations += 1;
    }
    this.injectFailure('restore');
    return { bindingGeneration: 3, deployedRevision: 'revision-prior' };
  }

  async verifyProviderCredentialRejected(input: VerifyRuntimeCredentialRejectedInput) {
    this.events.push('reject-old');
    this.injectFailure('rejection');
    assert.deepEqual(input.rejectedCredential, { secretId: CURRENT_SECRET_ID, fingerprint: HASH_A });
    return {
      kind: 'provider-completion-rejection' as const,
      providerId: 'openrouter' as const,
      endpoint: 'chat-completions' as const,
      keyFingerprint: HASH_A,
      rejectionStatus: 401 as const,
      providerResponseDigest: HASH_D,
      verifiedAt: '2026-08-23T10:00:02.000Z',
    };
  }
}

class ProviderFixture implements OpenRouterCutoverProvider {
  oldStatus: 'active' | 'disabled' = 'active';
  replacementStatus: 'active' | 'disabled' | 'deleted' = 'active';
  listFailures = 0;
  oldDisableFailures = 0;
  oldDisableAcceptedThenThrows = false;
  replacementCleanupFailures = 0;
  oldDisableCalls = 0;
  replacementCleanupCalls = 0;

  constructor(
    private readonly events: string[],
    private readonly store: MemoryCutoverStore,
  ) {}

  get disabled(): boolean {
    return this.oldStatus === 'disabled';
  }

  private metadata(
    resourceId: 'old-resource' | 'replacement-resource',
    status: 'active' | 'disabled' | 'deleted',
  ): OpenRouterKeyMetadata {
    return {
      resourceId,
      fingerprint: resourceId === 'old-resource' ? HASH_E : HASH_D,
      name: resourceId === 'old-resource' ? 'old-runtime-key' : 'replacement-runtime-key',
      status,
      limits: {
        creditLimitUsd: 4,
        usage: 1,
        limitReset: 'daily',
        includeByokInLimit: false,
      },
      providerCreatedAt: '2026-08-22T10:00:00.000Z',
      providerUpdatedAt: '2026-08-23T10:00:00.000Z',
    };
  }

  async disableKey(_context: OpenRouterOperationContext, resourceId: string): Promise<OpenRouterKeyMetadata> {
    if (resourceId === 'old-resource') {
      this.events.push('disable-old');
      this.oldDisableCalls += 1;
      assert.equal(this.store.current?.state, 'OLD_KEY_DISABLE_PENDING');
      if (this.oldDisableFailures > 0) {
        this.oldDisableFailures -= 1;
        throw new Error(`provider failure ${OLD_KEY_VALUE}`);
      }
      this.oldStatus = 'disabled';
      if (this.oldDisableAcceptedThenThrows) {
        this.listFailures += 1;
        this.oldDisableAcceptedThenThrows = false;
        throw new Error(`uncertain provider response ${OLD_KEY_VALUE}`);
      }
      return this.metadata('old-resource', 'disabled');
    }
    assert.equal(resourceId, 'replacement-resource');
    if (this.replacementCleanupFailures > 0) {
      this.replacementCleanupFailures -= 1;
      throw new Error(`replacement cleanup failure ${REPLACEMENT_KEY_VALUE}`);
    }
    this.events.push('disable-replacement');
    this.replacementCleanupCalls += 1;
    assert.equal(this.store.current?.state, 'TARGET_RESTORED');
    this.replacementStatus = 'disabled';
    return this.metadata('replacement-resource', 'disabled');
  }

  async deleteKey(_context: OpenRouterOperationContext, resourceId: string): Promise<void> {
    assert.equal(resourceId, 'replacement-resource');
    this.events.push('delete-replacement');
    this.replacementCleanupCalls += 1;
    assert.equal(this.store.current?.state, 'TARGET_RESTORED');
    this.replacementStatus = 'deleted';
  }

  async listKeys(): Promise<OpenRouterKeyMetadata[]> {
    this.events.push('list-keys');
    if (this.listFailures > 0) {
      this.listFailures -= 1;
      throw new Error(`provider list failure ${OLD_KEY_VALUE} ${REPLACEMENT_KEY_VALUE}`);
    }
    return [
      this.metadata('old-resource', this.oldStatus),
      ...(this.replacementStatus === 'deleted'
        ? []
        : [this.metadata('replacement-resource', this.replacementStatus)]),
    ];
  }
}

class MutableTargetResolver implements RuntimeSecretBindingAdapterResolver {
  constructor(public target: RuntimeSecretBindingAdapter | null) {}

  resolve(adapterId: string): RuntimeSecretBindingAdapter | null {
    return this.target?.adapterId === adapterId ? this.target : null;
  }
}

function fixture(
  faults: OpenRouterCutoverFaults = {},
  replacementOverride?: OpenRouterRotationReplacement,
) {
  const intent = createOpenRouterRotationIntent(material());
  const settled = replacementOverride ?? replacement(intent);
  const events: string[] = [];
  let now = INITIAL_NOW;
  const store = new MemoryCutoverStore(events, () => now);
  const target = new TargetFixture(events);
  const provider = new ProviderFixture(events, store);
  const resolver = new MutableTargetResolver(target);
  const service = new OpenRouterRuntimeKeyCutoverService(
    new SettledRotationService(settled),
    provider,
    store,
    resolver,
    () => now,
    faults,
  );
  return {
    intent,
    events,
    store,
    target,
    provider,
    resolver,
    service,
    advance(ms: number) { now += ms; },
  };
}

test('real completion evidence gates cutover and one redacted receipt settles the replacement active', async () => {
  const f = fixture();
  const completed = await f.service.execute(execution(f.intent));

  assert.equal(completed.state, 'COMPLETED');
  assert.equal(f.store.replacementActive, true);
  assert.equal(f.store.receipts.length, 1);
  assert.deepEqual(f.events, [
    'stage',
    'persist:stage',
    'deploy',
    'persist:deploy',
    'canary',
    'persist:canary',
    'activate',
    'persist:active',
    'persist:disable-pending',
    'list-keys',
    'disable-old',
    'list-keys',
    'persist:disabled',
    'reject-old',
    'persist:complete',
  ]);
  assert.deepEqual(completed.receipt?.target, {
    adapterId: 'disposable-runtime-target',
    bindingId: 'runtime-binding-one',
    environmentId: 'staging',
    bindingGeneration: 4,
    deployedRevision: 'revision-42',
  });
  assert.equal(completed.receipt?.retiredKey.rejectionStatus, 401);
  assert.equal(JSON.stringify(completed.receipt).includes('secretId'), false);
  assert.equal(JSON.stringify(completed.receipt).includes('key-value'), false);

  const replay = await f.service.execute(execution(f.intent));
  assert.equal(replay.state, 'COMPLETED');
  assert.equal(f.store.receipts.length, 1);
  assert.equal(f.events.length, 15, 'completed replay must not repeat target or provider mutations');
});

test('a health-only response triggers ordered target restoration and replacement cleanup', async () => {
  const f = fixture();
  f.target.canaryResult = {
    kind: 'health',
    status: 'healthy',
    deployedRevision: 'revision-42',
  };

  const rolledBack = await f.service.execute(execution(f.intent));
  assert.equal(rolledBack.state, 'ROLLED_BACK');
  assert.equal(f.target.currentGeneration, 3);
  assert.equal(f.provider.disabled, false);
  assert.equal(f.provider.replacementStatus, 'disabled');
  assert.equal(f.events.includes('activate'), false);
  assert.equal(f.events.includes('disable-old'), false);
  assert.ok(f.events.indexOf('restore') < f.events.indexOf('disable-replacement'));
  assert.equal(rolledBack.recoveryReceipt?.failure.code, 'OPENROUTER_COMPLETION_CANARY_FAILED');
  const serialized = JSON.stringify(rolledBack);
  assert.equal(serialized.includes(OLD_KEY_VALUE), false);
  assert.equal(serialized.includes(REPLACEMENT_KEY_VALUE), false);
});

test('an unavailable adapter durably waits without starting or consuming the execution timeout', async () => {
  const f = fixture();
  f.resolver.target = null;

  const waiting = await f.service.execute(execution(f.intent));
  assert.equal(waiting.state, 'WAITING_FOR_AUTHORIZATION');
  assert.equal(waiting.resumeState, 'REPLACEMENT_READY');
  assert.equal(waiting.waitingReasonCode, 'TARGET_BINDING_ADAPTER_UNAVAILABLE');
  assert.equal(waiting.timeoutStartedAt, null);
  assert.equal(waiting.timeoutConsumedMs, 0);
  assert.equal(f.provider.disabled, false);
  assert.deepEqual(f.events, ['persist:waiting']);

  f.advance(86_400_000);
  f.resolver.target = f.target;
  const completed = await f.service.execute(execution(f.intent));
  assert.equal(completed.state, 'COMPLETED');
  assert.equal(f.store.receipts.length, 1);
});

test('every failed pre-cutover boundary restores the prior target before revoking the replacement', async () => {
  for (const boundary of ['stage', 'deploy', 'canary', 'activate'] as const) {
    const f = fixture();
    f.target.failAt = boundary;

    const rolledBack = await f.service.execute(execution(f.intent));
    assert.equal(rolledBack.state, 'ROLLED_BACK', boundary);
    assert.equal(f.target.currentGeneration, 3, boundary);
    assert.equal(f.provider.oldStatus, 'active', boundary);
    assert.equal(f.provider.replacementStatus, 'disabled', boundary);
    assert.ok(f.events.indexOf('restore') < f.events.indexOf('disable-replacement'), boundary);
    assert.equal(JSON.stringify(rolledBack).includes(OLD_KEY_VALUE), false, boundary);
    assert.equal(JSON.stringify(rolledBack).includes(REPLACEMENT_KEY_VALUE), false, boundary);
  }
});

test('crashes at every cutover external boundary replay without duplicate target mutations or old-key disables', async () => {
  const boundaries = [
    'afterBindingStage',
    'afterDeployAcceptance',
    'afterCanaryResult',
    'afterCutover',
    'afterOldKeyDisable',
  ] as const;
  for (const boundary of boundaries) {
    let crash = true;
    const faults: OpenRouterCutoverFaults = {
      [boundary]: () => {
        if (!crash) return;
        crash = false;
        throw new Error(`${OLD_KEY_VALUE} ${REPLACEMENT_KEY_VALUE}`);
      },
    };
    const f = fixture(faults);
    await assert.rejects(
      f.service.execute(execution(f.intent)),
      (error: unknown) => {
        assert.equal(error instanceof Error, true);
        const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
        assert.equal(serialized.includes(OLD_KEY_VALUE), false);
        assert.equal(serialized.includes(REPLACEMENT_KEY_VALUE), false);
        return true;
      },
      boundary,
    );

    const completed = await f.service.execute(execution(f.intent));
    assert.equal(completed.state, 'COMPLETED', boundary);
    assert.equal(f.target.stageMutations, 1, boundary);
    assert.equal(f.target.deployMutations, 1, boundary);
    assert.equal(f.target.activationMutations, 1, boundary);
    assert.equal(f.provider.oldDisableCalls, 1, boundary);
    assert.equal(f.store.receipts.length, 1, boundary);
  }
});

test('an uncertain old-key disable is read back before retry and never disables the replacement', async () => {
  const f = fixture();
  f.provider.oldDisableAcceptedThenThrows = true;

  const uncertain = await f.service.execute(execution(f.intent));
  assert.equal(uncertain.state, 'OLD_KEY_DISABLE_PENDING');
  assert.equal(uncertain.reconciliationReasonCode, 'OPENROUTER_OLD_KEY_DISABLE_UNCERTAIN');
  assert.equal(f.provider.oldStatus, 'disabled');
  assert.equal(f.provider.oldDisableCalls, 1);
  assert.equal(f.provider.replacementStatus, 'active');

  const beforeReplay = f.events.length;
  const completed = await f.service.execute(execution(f.intent));
  assert.equal(completed.state, 'COMPLETED');
  assert.equal(f.provider.oldDisableCalls, 1);
  assert.equal(f.provider.replacementStatus, 'active');
  assert.equal(f.events.slice(beforeReplay).includes('disable-old'), false);
  assert.equal(f.events.slice(beforeReplay).includes('disable-replacement'), false);
});

test('a confirmed old-key disable failure rolls back while an uncertain restore defers replacement cleanup', async () => {
  const f = fixture();
  f.provider.oldDisableFailures = 1;
  const rolledBack = await f.service.execute(execution(f.intent));
  assert.equal(rolledBack.state, 'ROLLED_BACK');
  assert.equal(f.provider.oldStatus, 'active');
  assert.equal(f.target.currentGeneration, 3);
  assert.ok(f.events.indexOf('restore') < f.events.indexOf('disable-replacement'));

  const restoreUncertain = fixture();
  restoreUncertain.target.failAt = 'canary';
  const originalRestore = restoreUncertain.target.restorePriorBinding.bind(restoreUncertain.target);
  let restoreFails = true;
  restoreUncertain.target.restorePriorBinding = async (input) => {
    if (restoreFails) {
      restoreFails = false;
      restoreUncertain.events.push('restore');
      throw new Error(`${OLD_KEY_VALUE} ${REPLACEMENT_KEY_VALUE}`);
    }
    return originalRestore(input);
  };
  const waiting = await restoreUncertain.service.execute(execution(restoreUncertain.intent));
  assert.equal(waiting.state, 'ROLLBACK_PENDING');
  assert.equal(waiting.reconciliationReasonCode, 'OPENROUTER_TARGET_RESTORE_UNCERTAIN');
  assert.equal(restoreUncertain.provider.replacementStatus, 'active');
  assert.equal(restoreUncertain.events.includes('disable-replacement'), false);

  const recovered = await restoreUncertain.service.execute(execution(restoreUncertain.intent));
  assert.equal(recovered.state, 'ROLLED_BACK');
  assert.equal(restoreUncertain.target.currentGeneration, 3);
  assert.equal(restoreUncertain.provider.replacementStatus, 'disabled');
});

test('creation and revocation uncertainty emit redacted reconciliation receipts and resume safely', async () => {
  const intent = createOpenRouterRotationIntent(material());
  const creationUncertain = OpenRouterRotationReplacementSchema.parse({
    ...replacement(intent),
    operationState: 'creation-uncertain',
    providerResourceId: null,
    runtimeKeyReference: null,
  });
  const creation = fixture({}, creationUncertain);
  const creationReceipt = await creation.service.execute(execution(creation.intent));
  assert.equal(creationReceipt.state, 'REPLACEMENT_READY');
  assert.equal(creationReceipt.reconciliationReasonCode, 'OPENROUTER_REPLACEMENT_CREATION_UNCERTAIN');
  assert.deepEqual(creation.events, ['persist:reconciliation']);

  const cleanup = fixture();
  cleanup.target.failAt = 'canary';
  cleanup.provider.replacementCleanupFailures = 1;
  const cleanupReceipt = await cleanup.service.execute(execution(cleanup.intent));
  assert.equal(cleanupReceipt.state, 'TARGET_RESTORED');
  assert.equal(cleanupReceipt.reconciliationReasonCode, 'OPENROUTER_REPLACEMENT_CLEANUP_UNCERTAIN');
  assert.equal(cleanup.store.replacementLifecycle, 'cleanup-required');
  assert.equal(cleanup.provider.oldStatus, 'active');
  const serialized = JSON.stringify([creationReceipt, cleanupReceipt]);
  assert.equal(serialized.includes(OLD_KEY_VALUE), false);
  assert.equal(serialized.includes(REPLACEMENT_KEY_VALUE), false);

  const recovered = await cleanup.service.execute(execution(cleanup.intent));
  assert.equal(recovered.state, 'ROLLED_BACK');
  assert.equal(cleanup.provider.replacementStatus, 'disabled');
});

test('receipt or rejection failure keeps the active replacement and resumes without another disable', async () => {
  const f = fixture();
  f.target.failAt = 'rejection';
  const uncertain = await f.service.execute(execution(f.intent));
  assert.equal(uncertain.state, 'OLD_KEY_DISABLED');
  assert.equal(uncertain.reconciliationReasonCode, 'OPENROUTER_OLD_KEY_REJECTION_UNCERTAIN');
  assert.equal(f.provider.oldStatus, 'disabled');
  assert.equal(f.provider.replacementStatus, 'active');
  assert.equal(f.provider.oldDisableCalls, 1);

  const completed = await f.service.execute(execution(f.intent));
  assert.equal(completed.state, 'COMPLETED');
  assert.equal(f.provider.oldDisableCalls, 1);
  assert.equal(f.store.receipts.length, 1);
  assert.equal(JSON.stringify(uncertain).includes(OLD_KEY_VALUE), false);
  assert.equal(JSON.stringify(uncertain).includes(REPLACEMENT_KEY_VALUE), false);

  const receiptFailure = fixture();
  receiptFailure.store.completeFailures = 1;
  const receiptUncertain = await receiptFailure.service.execute(execution(receiptFailure.intent));
  assert.equal(receiptUncertain.state, 'OLD_KEY_DISABLED');
  assert.equal(receiptUncertain.reconciliationReasonCode, 'OPENROUTER_CUTOVER_RECEIPT_UNCERTAIN');
  assert.equal(receiptFailure.provider.oldDisableCalls, 1);
  assert.equal(JSON.stringify(receiptUncertain).includes(OLD_KEY_VALUE), false);
  assert.equal(JSON.stringify(receiptUncertain).includes(REPLACEMENT_KEY_VALUE), false);

  const receiptRecovered = await receiptFailure.service.execute(execution(receiptFailure.intent));
  assert.equal(receiptRecovered.state, 'COMPLETED');
  assert.equal(receiptFailure.provider.oldDisableCalls, 1);
  assert.equal(receiptFailure.store.receipts.length, 1);
});
