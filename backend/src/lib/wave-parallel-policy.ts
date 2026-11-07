/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { UnprocessableError } from './errors';

export const EXPERIMENTAL_WAVE_PARALLEL_ENV = 'RORCA_EXPERIMENTAL_WAVE_PARALLEL' as const;
export const WAVE_PARALLEL_POLICY_ERROR_CODE = 'WAVE_PARALLEL_POLICY_DENIED' as const;

export type WaveExecutionMode = 'sequential' | 'wave-parallel';

export interface WaveParallelPolicyEnvironment {
  nodeEnv?: string;
  experimentalOptIn?: string;
}

export interface WaveParallelPolicyRequest {
  requestedMode?: WaveExecutionMode;
  requestedParallelism?: number;
  forceSequential?: boolean;
  source: string;
}

export interface EffectiveWaveParallelPolicy {
  mode: WaveExecutionMode;
  parallelism: number;
  experimental: boolean;
  optInIgnored: boolean;
  source: string;
}

export type WaveParallelPolicyDecision =
  | { allowed: true; effective: EffectiveWaveParallelPolicy }
  | {
      allowed: false;
      reason: 'conflicting_request' | 'production_forbidden' | 'experimental_opt_in_required';
      message: string;
      details: Record<string, unknown>;
    };

export class WaveParallelPolicyError extends UnprocessableError {
  constructor(decision: Extract<WaveParallelPolicyDecision, { allowed: false }>) {
    super(decision.message, WAVE_PARALLEL_POLICY_ERROR_CODE, {
      reason: decision.reason,
      ...decision.details,
    });
  }
}

function isProduction(nodeEnv: string | undefined): boolean {
  return nodeEnv?.trim().toLowerCase() === 'production';
}

function hasExperimentalOptIn(value: string | undefined): boolean {
  return value?.trim() === 'true';
}

/**
 * Deterministically resolves the only execution mode the control plane may
 * persist or dispatch. Environment values are explicit inputs so every API,
 * queue, worker, retry, and local-runner boundary shares identical policy.
 */
export function evaluateWaveParallelPolicy(
  request: WaveParallelPolicyRequest,
  environment: WaveParallelPolicyEnvironment,
): WaveParallelPolicyDecision {
  const production = isProduction(environment.nodeEnv);
  const optedIn = hasExperimentalOptIn(environment.experimentalOptIn);
  const requestedParallelism = request.requestedParallelism ?? 1;
  const parallelRequested = request.requestedMode === 'wave-parallel' || requestedParallelism > 1;
  const contradictoryMode = request.requestedMode === 'sequential' && requestedParallelism > 1;

  if (contradictoryMode || (request.forceSequential === true && parallelRequested)) {
    return {
      allowed: false,
      reason: 'conflicting_request',
      message: 'Conflicting execution options requested both sequential and wave-parallel execution.',
      details: {
        source: request.source,
        requestedMode: request.requestedMode ?? null,
        requestedParallelism,
        action: 'Use orchestrationMode="sequential" with parallelism=1, or remove forceSequential before requesting wave-parallel execution.',
      },
    };
  }

  if (!parallelRequested || request.forceSequential === true) {
    return {
      allowed: true,
      effective: {
        mode: 'sequential',
        parallelism: 1,
        experimental: false,
        optInIgnored: production && optedIn,
        source: request.source,
      },
    };
  }

  // This module validates the legacy execution shape only. Production wave
  // authority is resolved by wave-production-governance and its persisted,
  // fenced envelope at API, worker, engine, and local-runner boundaries.
  if (production) {
    return {
      allowed: true,
      effective: {
        mode: 'wave-parallel',
        parallelism: Math.max(2, Math.trunc(requestedParallelism)),
        experimental: false,
        optInIgnored: optedIn,
        source: request.source,
      },
    };
  }

  if (!optedIn) {
    return {
      allowed: false,
      reason: 'experimental_opt_in_required',
      message: 'Wave-parallel execution is experimental and disabled in this environment.',
      details: {
        source: request.source,
        requestedMode: request.requestedMode ?? 'wave-parallel',
        requestedParallelism,
        action: `Use sequential execution, or set ${EXPERIMENTAL_WAVE_PARALLEL_ENV}=true only in an isolated non-production environment.`,
      },
    };
  }

  return {
    allowed: true,
    effective: {
      mode: 'wave-parallel',
      parallelism: Math.max(2, Math.trunc(requestedParallelism)),
      experimental: true,
      optInIgnored: false,
      source: request.source,
    },
  };
}

export function enforceWaveParallelPolicy(
  request: WaveParallelPolicyRequest,
  environment: WaveParallelPolicyEnvironment,
): EffectiveWaveParallelPolicy {
  const decision = evaluateWaveParallelPolicy(request, environment);
  if (!decision.allowed) throw new WaveParallelPolicyError(decision);
  return decision.effective;
}

export function currentWaveParallelPolicyEnvironment(): WaveParallelPolicyEnvironment {
  return {
    nodeEnv: process.env.NODE_ENV,
    experimentalOptIn: process.env[EXPERIMENTAL_WAVE_PARALLEL_ENV],
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Revalidates queue/DB metadata immediately before execution. This catches
 * direct jobs, stale retries, and forged trigger metadata instead of silently
 * changing what the request claims after dispatch.
 */
export function enforceWaveDispatchConsistency(input: {
  source: string;
  payloadMode?: WaveExecutionMode;
  payloadParallelism?: number;
  rowParallelism?: number | null;
  triggerOptions?: Record<string, unknown>;
  environment: WaveParallelPolicyEnvironment;
}): EffectiveWaveParallelPolicy {
  const effective = enforceWaveParallelPolicy({
    source: input.source,
    requestedMode: input.payloadMode,
    requestedParallelism: input.payloadParallelism,
  }, input.environment);

  const rowParallelism = input.rowParallelism ?? 1;
  const claims = input.triggerOptions;
  const orchestration = record(claims?.orchestration);
  const claimedMode = claims?.orchestrationMode ?? orchestration?.mode;
  const claimedParallelism = claims?.parallelism ?? orchestration?.parallelism;

  const mismatch = rowParallelism !== effective.parallelism
    || (claimedMode !== undefined && claimedMode !== effective.mode)
    || (claimedParallelism !== undefined && claimedParallelism !== effective.parallelism);

  if (mismatch) {
    throw new WaveParallelPolicyError({
      allowed: false,
      reason: 'conflicting_request',
      message: 'Queued execution metadata does not match the effective wave-parallel policy; dispatch was refused.',
      details: {
        source: input.source,
        payloadMode: input.payloadMode ?? 'sequential',
        payloadParallelism: input.payloadParallelism ?? 1,
        rowParallelism,
        claimedMode: claimedMode ?? null,
        claimedParallelism: claimedParallelism ?? null,
        effectiveMode: effective.mode,
        effectiveParallelism: effective.parallelism,
        action: 'Recreate the run through the pipeline trigger API with consistent effective options.',
      },
    });
  }

  return effective;
}
