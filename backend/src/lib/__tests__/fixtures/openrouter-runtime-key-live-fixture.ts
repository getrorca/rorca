/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import {
  OpenRouterQualificationCrashBoundarySchema,
  type ExecuteOpenRouterQualificationInput,
  type OpenRouterLiveQualificationEvidence,
  type OpenRouterQualificationFixture,
  type OpenRouterQualificationFixtureDescriptor,
  type OpenRouterQualificationReceipt,
  type OpenRouterQualificationRollbackEvidence,
} from '../../openrouter-runtime-key-qualification';

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;
const HASH_C = `sha256:${'c'.repeat(64)}`;
const HASH_D = `sha256:${'d'.repeat(64)}`;
const HASH_E = `sha256:${'e'.repeat(64)}`;
const HASH_F = `sha256:${'f'.repeat(64)}`;
const COMPLETED_AT = '2026-08-24T12:00:05.000Z';

/**
 * Deterministic conformance double for the Rorca-owned live fixture contract.
 * It contains only redacted evidence and deliberately cannot accept credentials.
 */
export class DisposableOpenRouterLiveFixture implements OpenRouterQualificationFixture {
  readonly descriptor: OpenRouterQualificationFixtureDescriptor;
  executeCalls = 0;
  rollbackCalls = 0;

  constructor(
    targetBinding: OpenRouterQualificationFixtureDescriptor['targetBinding'],
    private readonly mutateEvidence?: (
      evidence: OpenRouterLiveQualificationEvidence,
    ) => OpenRouterLiveQualificationEvidence,
  ) {
    this.descriptor = {
      fixtureId: 'rorca-openrouter-live-fixture',
      owner: 'rorca',
      provider: 'openrouter',
      accountClass: 'dedicated-low-limit',
      disposable: true,
      targetBinding,
    };
  }

  async execute(
    input: Readonly<ExecuteOpenRouterQualificationInput>,
    signal: AbortSignal,
  ): Promise<OpenRouterLiveQualificationEvidence> {
    this.executeCalls += 1;
    if (signal.aborted) throw new Error('fixture aborted');
    const deployedRevision = 'rorca-fixture-revision-2';
    const completion = {
      kind: 'provider-completion' as const,
      providerId: 'openrouter' as const,
      endpoint: 'chat-completions' as const,
      contractId: 'rorca-live-inference-canary',
      contractVersion: 1,
      requestDigest: HASH_A,
      responseAssertionDigest: HASH_B,
      modelId: 'openrouter/auto',
      targetBindingGeneration: input.targetBinding.generation + 1,
      deployedRevision,
      providerResponseDigest: HASH_C,
      completedAt: COMPLETED_AT,
    };
    const oldKeyRejection = {
      kind: 'provider-completion-rejection' as const,
      providerId: 'openrouter' as const,
      endpoint: 'chat-completions' as const,
      keyFingerprint: HASH_D,
      rejectionStatus: 401 as const,
      providerResponseDigest: HASH_E,
      verifiedAt: COMPLETED_AT,
    };
    const evidence: OpenRouterLiveQualificationEvidence = {
      schemaVersion: 'rorca.openrouter-runtime-key-live-evidence.v1',
      fixture: this.descriptor,
      spend: {
        declaredLimitUsd: input.spendLimitUsd,
        observedUsd: Math.min(0.01, input.spendLimitUsd),
      },
      successfulRotation: {
        cutoverReceipt: {
          schemaVersion: 'rorca.openrouter-runtime-key-cutover-receipt.v1',
          receiptId: '77777777-7777-4777-8777-777777777777',
          workspaceId: input.workspaceId,
          requestDigest: HASH_F,
          providerBinding: {
            bindingId: input.providerBinding.bindingId,
            generation: input.providerBinding.generation,
          },
          replacement: {
            providerResourceId: 'provider-key-replacement',
            fingerprint: HASH_F,
            lifecycleState: 'active',
          },
          target: {
            adapterId: input.targetBinding.adapterId,
            bindingId: input.targetBinding.bindingId,
            environmentId: input.targetBinding.environmentId,
            bindingGeneration: input.targetBinding.generation + 1,
            deployedRevision,
          },
          canary: {
            contractId: completion.contractId,
            contractVersion: completion.contractVersion,
            providerResponseDigest: completion.providerResponseDigest,
            completedAt: completion.completedAt,
          },
          retiredKey: {
            providerResourceId: 'provider-key-prior',
            fingerprint: oldKeyRejection.keyFingerprint,
            rejectionStatus: oldKeyRejection.rejectionStatus,
            providerResponseDigest: oldKeyRejection.providerResponseDigest,
            verifiedAt: oldKeyRejection.verifiedAt,
          },
          emittedAt: COMPLETED_AT,
        },
        completion,
        oldKeyRejection,
      },
      security: {
        promptExtraction: {
          completion: {
            ...completion,
            contractId: 'rorca-prompt-extraction-denial',
            requestDigest: HASH_B,
            providerResponseDigest: HASH_D,
          },
          secretMaterialObserved: false,
        },
        crossWorkspace: { outcome: 'denied', providerCallMade: false },
        crossEnvironment: { outcome: 'denied', providerCallMade: false },
        alteredIntent: { outcome: 'denied', providerCallMade: false },
        replay: { outcome: 'denied', providerCallMade: false },
        expiredGrant: { outcome: 'denied', providerCallMade: false },
        revokedKeyReuse: { outcome: 'denied', rejection: oldKeyRejection },
      },
      rollback: {
        receipt: {
          schemaVersion: 'rorca.openrouter-runtime-key-recovery-receipt.v1',
          receiptId: '88888888-8888-4888-8888-888888888888',
          workspaceId: input.workspaceId,
          requestDigest: HASH_E,
          outcome: 'rolled-back',
          failure: { state: 'TARGET_DEPLOYED', code: 'OPENROUTER_QUALIFICATION_ROLLBACK_PROBE' },
          providerBinding: {
            bindingId: input.providerBinding.bindingId,
            generation: input.providerBinding.generation,
          },
          priorKey: {
            providerResourceId: 'provider-key-stable',
            fingerprint: HASH_A,
            status: 'active',
          },
          replacement: {
            providerResourceId: 'provider-key-rollback-probe',
            fingerprint: HASH_B,
            lifecycleState: 'revoked',
          },
          target: {
            adapterId: input.targetBinding.adapterId,
            bindingId: input.targetBinding.bindingId,
            environmentId: input.targetBinding.environmentId,
            priorGeneration: input.targetBinding.generation,
            changedGeneration: input.targetBinding.generation + 1,
            restoredGeneration: input.targetBinding.generation,
            restoredRevision: 'rorca-fixture-revision-1',
          },
          emittedAt: COMPLETED_AT,
        },
        priorTargetFunctional: true,
        priorBindingRestored: true,
      },
      crashRecovery: OpenRouterQualificationCrashBoundarySchema.options.map((boundary) => ({
        boundary,
        replacementCreateCount: 1 as const,
        resumeCount: 1 as const,
        targetFunctional: true as const,
        providerKeysKnown: true as const,
      })),
      providerCleanup: {
        completed: true,
        resources: [
          {
            resourceId: 'provider-key-replacement',
            providerStatus: 'deleted',
            lifecycleState: 'revoked',
          },
          {
            resourceId: 'provider-key-rollback-probe',
            providerStatus: 'disabled',
            lifecycleState: 'reconciled',
          },
        ],
      },
      receiptsPreserved: true,
      completedAt: COMPLETED_AT,
    };
    return this.mutateEvidence?.(evidence) ?? evidence;
  }

  async rollback(
    _receipt: Readonly<OpenRouterQualificationReceipt>,
    signal: AbortSignal,
  ): Promise<OpenRouterQualificationRollbackEvidence> {
    this.rollbackCalls += 1;
    if (signal.aborted) throw new Error('fixture aborted');
    return {
      targetFunctional: true,
      priorBindingRestored: true,
      replacements: [
        {
          resourceId: 'provider-key-replacement',
          providerStatus: 'deleted',
          lifecycleState: 'revoked',
        },
        {
          resourceId: 'provider-key-rollback-probe',
          providerStatus: 'disabled',
          lifecycleState: 'reconciled',
        },
      ],
      receiptsPreserved: true,
      completedAt: '2026-08-24T12:00:10.000Z',
    };
  }
}
