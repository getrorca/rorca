/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  ProviderFallbackExhaustedError,
  runExplicitPiProviderFallback,
  runOmpProviderFallback,
  type ProviderFallbackEvidence,
  type ProviderFallbackEvidenceWriter,
  type ProviderFallbackPolicy,
  type ProviderFailureReason,
} from '../provider-fallback-policy';

const policy: ProviderFallbackPolicy = Object.freeze({
  schemaVersion: 'rorca.provider-fallback-policy.v1',
  name: 'hermes-omp-standard-v1',
  allowedAlternateChain: Object.freeze(['anthropic/primary', 'openai/alternate', 'google/last']),
  failureReasons: Object.freeze<readonly ProviderFailureReason[]>(['usage_limit', 'connection_error', 'terminalized_authority']),
});
const attempt = Object.freeze({ runId: 73, storyId: 'AAV-021', attemptId: 'attempt:aav-021:1', generation: 4 });

class CaptureEvidence implements ProviderFallbackEvidenceWriter {
  readonly story: ProviderFallbackEvidence[] = [];
  readonly lifecycle: ProviderFallbackEvidence[] = [];
  async appendCanonicalStoryAndLifecycleEvidence(evidence: ProviderFallbackEvidence): Promise<void> {
    this.story.push(evidence);
    this.lifecycle.push(evidence);
  }
}

const providerReason = (error: unknown) => error instanceof Error && error.message.startsWith('provider:')
  ? 'connection_error' as const
  : null;

describe('executor-neutral provider fallback policy', () => {
  test('OMP applies the named allowed chain inside the story session', async () => {
    const evidence = new CaptureEvidence();
    const runWithModel = jest.fn(async (model: string) => {
      if (model === 'openai/alternate') throw new Error('provider: connection dropped');
      return `settled:${model}`;
    });

    await expect(runOmpProviderFallback({
      policy, currentModel: 'anthropic/primary', originalReason: 'usage_limit',
      originalMessage: 'monthly usage limit reached', attempt, evidence, runWithModel,
      classifyFailure: providerReason, now: () => '2026-08-10T10:00:00.000Z',
    })).resolves.toBe('settled:google/last');
    expect(runWithModel.mock.calls.map(([model]) => model)).toEqual(['openai/alternate', 'google/last']);
    expect(evidence.story.map((item) => item.selectedModel)).toEqual(['openai/alternate', 'google/last']);
  });

  test('records identical canonical story and lifecycle evidence with original reason, selected model, and attempt identity', async () => {
    const evidence = new CaptureEvidence();
    await runOmpProviderFallback({
      policy, currentModel: 'anthropic/primary', originalReason: 'terminalized_authority',
      originalMessage: 'provider authority terminalized', attempt, evidence,
      runWithModel: async () => 'ok', classifyFailure: () => null,
      now: () => '2026-08-10T10:00:00.000Z',
    });
    expect(evidence.story).toEqual(evidence.lifecycle);
    expect(evidence.story[0]).toMatchObject({
      schemaVersion: 'rorca.provider-fallback-evidence.v1', policyName: 'hermes-omp-standard-v1', executor: 'omp',
      originalReason: 'terminalized_authority', originalMessage: 'provider authority terminalized',
      selectedModel: 'openai/alternate', priorModel: 'anthropic/primary', alternateOrdinal: 1, attempt,
      fallbackAttemptId: 'attempt:aav-021:1:provider-fallback:1',
    });
  });

  test('chain exhaustion preserves the original provider reason and message', async () => {
    const evidence = new CaptureEvidence();
    const result = runOmpProviderFallback({
      policy, currentModel: 'anthropic/primary', originalReason: 'usage_limit', originalMessage: 'original quota receipt',
      attempt, evidence, runWithModel: async (model) => { throw new Error(`provider: ${model} unavailable`); },
      classifyFailure: providerReason,
    });
    await expect(result).rejects.toMatchObject({
      code: 'PROVIDER_FALLBACK_EXHAUSTED', originalReason: 'usage_limit', originalMessage: 'original quota receipt',
      attemptedModels: ['anthropic/primary', 'openai/alternate', 'google/last'],
    });
    await expect(result).rejects.toBeInstanceOf(ProviderFallbackExhaustedError);
  });

  test('explicit Pi fallback consumes the exact same policy without a divergent chain', async () => {
    const evidence = new CaptureEvidence();
    const selected: string[] = [];
    await runExplicitPiProviderFallback({
      explicitlySelected: true, policy, currentModel: 'anthropic/primary', originalReason: 'connection_error',
      originalMessage: 'socket closed', attempt, evidence,
      runWithModel: async (model) => { selected.push(model); return 'ok'; }, classifyFailure: providerReason,
    });
    expect(selected).toEqual([policy.allowedAlternateChain[1]]);
    expect(evidence.story[0]).toMatchObject({ executor: 'pi', policyName: policy.name, selectedModel: policy.allowedAlternateChain[1] });
  });
});
