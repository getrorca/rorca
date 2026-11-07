/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

/**
 * Rorca-owned provider fallback policy. Executors consume this contract; they
 * must not invent or reorder alternates. OMP performs the retries inside the
 * current story session. Pi may consume it only through the explicit adapter.
 */
export const PROVIDER_FALLBACK_POLICY_VERSION = 'rorca.provider-fallback-policy.v1' as const;
export const PROVIDER_FALLBACK_EVIDENCE_VERSION = 'rorca.provider-fallback-evidence.v1' as const;

export type ProviderFailureReason = 'usage_limit' | 'connection_error' | 'terminalized_authority';
export type ProviderFallbackExecutor = 'omp' | 'pi';

export interface ProviderFallbackPolicy {
  readonly schemaVersion: typeof PROVIDER_FALLBACK_POLICY_VERSION;
  readonly name: string;
  /** Ordered, complete chain supplied by Rorca, including the initial model. */
  readonly allowedAlternateChain: readonly string[];
  readonly failureReasons: readonly ProviderFailureReason[];
}

export interface ProviderFallbackAttemptIdentity {
  readonly runId: number | string;
  readonly storyId: string;
  readonly attemptId: string;
  readonly generation: number;
}

export interface ProviderFallbackEvidence {
  readonly schemaVersion: typeof PROVIDER_FALLBACK_EVIDENCE_VERSION;
  readonly policyName: string;
  readonly executor: ProviderFallbackExecutor;
  readonly originalReason: ProviderFailureReason;
  readonly originalMessage: string;
  readonly selectedModel: string;
  readonly priorModel: string;
  readonly alternateOrdinal: number;
  readonly attempt: ProviderFallbackAttemptIdentity;
  /** Stable identity for this alternate within the canonical story attempt. */
  readonly fallbackAttemptId: string;
  readonly recordedAt: string;
}

/** The implementation must atomically project into canonical story evidence and lifecycle WAL. */
export interface ProviderFallbackEvidenceWriter {
  appendCanonicalStoryAndLifecycleEvidence(evidence: ProviderFallbackEvidence): Promise<void>;
}

export interface ProviderFallbackRunInput<T> {
  readonly policy: ProviderFallbackPolicy;
  readonly executor: ProviderFallbackExecutor;
  readonly currentModel: string;
  readonly originalReason: ProviderFailureReason;
  readonly originalMessage: string;
  readonly attempt: ProviderFallbackAttemptIdentity;
  readonly evidence: ProviderFallbackEvidenceWriter;
  readonly runWithModel: (model: string, fallbackAttempt: number) => Promise<T>;
  readonly classifyFailure: (error: unknown) => ProviderFailureReason | null;
  readonly now?: () => string;
}

export class ProviderFallbackExhaustedError extends Error {
  readonly code = 'PROVIDER_FALLBACK_EXHAUSTED' as const;

  constructor(
    readonly originalReason: ProviderFailureReason,
    readonly originalMessage: string,
    readonly policyName: string,
    readonly attemptedModels: readonly string[],
    options?: ErrorOptions,
  ) {
    super(`Provider fallback policy ${policyName} exhausted: ${originalReason}: ${originalMessage}`, options);
    this.name = 'ProviderFallbackExhaustedError';
  }
}

function validatePolicy(policy: ProviderFallbackPolicy): void {
  if (policy.schemaVersion !== PROVIDER_FALLBACK_POLICY_VERSION || !policy.name.trim()) {
    throw new TypeError('provider fallback policy must have a name and supported schema version');
  }
  if (policy.allowedAlternateChain.length === 0 || new Set(policy.allowedAlternateChain).size !== policy.allowedAlternateChain.length
      || policy.allowedAlternateChain.some((model) => !model.trim())) {
    throw new TypeError('provider fallback policy model chain must be non-empty, ordered, and unique');
  }
  if (policy.failureReasons.length === 0 || new Set(policy.failureReasons).size !== policy.failureReasons.length) {
    throw new TypeError('provider fallback policy failure reasons must be non-empty and unique');
  }
}

/**
 * Continue a provider-failed story session through the exact named chain.
 * Exhaustion always reports the first failure, never the final alternate's
 * incidental error.
 */
export async function runProviderFallbackChain<T>(input: ProviderFallbackRunInput<T>): Promise<T> {
  validatePolicy(input.policy);
  if (!input.policy.failureReasons.includes(input.originalReason)) {
    throw new ProviderFallbackExhaustedError(
      input.originalReason, input.originalMessage, input.policy.name, Object.freeze([input.currentModel]),
    );
  }
  const currentIndex = input.policy.allowedAlternateChain.indexOf(input.currentModel);
  if (currentIndex === -1) throw new TypeError('current model is not present in the named provider fallback policy');

  const attemptedModels = [input.currentModel];
  let priorModel = input.currentModel;
  let lastError: unknown;
  for (let index = currentIndex + 1; index < input.policy.allowedAlternateChain.length; index++) {
    const selectedModel = input.policy.allowedAlternateChain[index];
    const fallbackAttempt = index - currentIndex;
    const evidence: ProviderFallbackEvidence = Object.freeze({
      schemaVersion: PROVIDER_FALLBACK_EVIDENCE_VERSION,
      policyName: input.policy.name,
      executor: input.executor,
      originalReason: input.originalReason,
      originalMessage: input.originalMessage,
      selectedModel,
      priorModel,
      alternateOrdinal: index,
      attempt: Object.freeze({ ...input.attempt }),
      fallbackAttemptId: `${input.attempt.attemptId}:provider-fallback:${fallbackAttempt}`,
      recordedAt: (input.now ?? (() => new Date().toISOString()))(),
    });
    // Evidence is durable before applying the alternate. The writer contract
    // makes story and lifecycle projection one canonical operation.
    await input.evidence.appendCanonicalStoryAndLifecycleEvidence(evidence);
    attemptedModels.push(selectedModel);
    try {
      return await input.runWithModel(selectedModel, fallbackAttempt);
    } catch (error) {
      lastError = error;
      const reason = input.classifyFailure(error);
      if (reason === null || !input.policy.failureReasons.includes(reason)) throw error;
      priorModel = selectedModel;
    }
  }
  throw new ProviderFallbackExhaustedError(
    input.originalReason,
    input.originalMessage,
    input.policy.name,
    Object.freeze(attemptedModels),
    lastError === undefined ? undefined : { cause: lastError },
  );
}

export function classifyProviderFallbackFailure(error: unknown): ProviderFailureReason | null {
  const message = error instanceof Error ? error.message : String(error);
  if (/usage limit|quota|rate limit|resource exhausted|429/i.test(message)) return 'usage_limit';
  if (/terminali[sz]ed authority|authority terminal|credential revoked/i.test(message)) return 'terminalized_authority';
  if (/connection|socket|network|ECONN|ETIMEDOUT|fetch failed/i.test(message)) return 'connection_error';
  return null;
}

export type ExecutorFallbackInput<T> = Omit<ProviderFallbackRunInput<T>, 'executor'>;

/** OMP's primary, in-story-session policy adapter. */
export function runOmpProviderFallback<T>(input: ExecutorFallbackInput<T>): Promise<T> {
  return runProviderFallbackChain({ ...input, executor: 'omp' });
}

/**
 * Pi compatibility adapter. The explicit selection token prevents Pi from
 * becoming an implicit fallback or defining a second model chain.
 */
export function runExplicitPiProviderFallback<T>(
  input: ExecutorFallbackInput<T> & { readonly explicitlySelected: true },
): Promise<T> {
  return runProviderFallbackChain({ ...input, executor: 'pi' });
}
