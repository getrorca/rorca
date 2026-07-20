/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'crypto';

export const WAVE_POLICY_SCHEMA = 'rorca.wave-production-policy/v1' as const;
export const WAVE_FENCING_POLICY = 'dispatch-boundary-v1' as const;
export const WAVE_POLICY_REVISION = 'wave-production-rollout-v1' as const;

export type WaveOperatorStatus =
  | 'sequential-default'
  | 'experimental-nonproduction'
  | 'production-disabled'
  | 'receipt-missing'
  | 'receipt-stale'
  | 'review-missing'
  | 'activation-missing'
  | 'canary-enabled'
  | 'halted'
  | 'draining'
  | 'enabled';

export interface WavePolicyRequest {
  orchestrationMode?: unknown;
  parallelism?: unknown;
  qualificationReceiptId?: unknown;
  rolloutCohort?: unknown;
}

export interface WaveQualificationIdentity {
  id: string;
  reportHash: string;
  sourceRevision: string;
  current: boolean;
  productionEnableAvailable: boolean;
}

export interface WaveRolloutPolicy {
  enabled: boolean;
  cohort: string;
  workspaceAllowlist: string[];
  runAllowlist: number[];
  maxParallelism: number;
  maxActiveWaveRuns: number;
  maxActiveWaveRunsPerWorkspace: number;
  maxCpuPercent: number;
  maxMemoryPercent: number;
  maxErrorRate: number;
  observedCpuPercent: number;
  observedMemoryPercent: number;
  observedErrorRate: number;
  halted: boolean;
  draining: boolean;
  rationale: string;
  releaseReadinessPacketId: string | null;
  productionActivationApprovalId: string | null;
  releaseReadinessCurrent: boolean;
  operatorActivationCurrent: boolean;
  /** Monotonically increases on every rollout-control mutation. */
  policyEpoch: number;
}

export interface WavePolicyEnvironment {
  nodeEnv: string | undefined;
  productionEnabled: string | undefined;
  experimentalEnabled: string | undefined;
  killSwitch: string | undefined;
}

export interface WavePolicyEvaluationInput {
  request: WavePolicyRequest;
  environment: WavePolicyEnvironment;
  workspaceId: string;
  runId?: number;
  currentRevision: string;
  receipt: WaveQualificationIdentity | null;
  rollout: WaveRolloutPolicy;
  activeWaveRuns: number;
  activeWorkspaceWaveRuns: number;
}

export interface WavePolicyEnvelope {
  schemaVersion: typeof WAVE_POLICY_SCHEMA;
  policyRevision: typeof WAVE_POLICY_REVISION;
  requested: {
    orchestrationMode: 'sequential' | 'wave-parallel';
    parallelism: number;
    qualificationReceiptId: string | null;
    rolloutCohort: string | null;
  };
  effective: {
    orchestrationMode: 'sequential' | 'wave-parallel';
    parallelism: number;
  };
  status: WaveOperatorStatus;
  allowed: boolean;
  reason: string;
  workspaceId: string;
  runId: number | null;
  receipt: {
    id: string;
    reportHash: string;
    sourceRevision: string;
  } | null;
  rollout: {
    cohort: string;
    maxParallelism: number;
    maxActiveWaveRuns: number;
    maxActiveWaveRunsPerWorkspace: number;
    releaseReadinessPacketId: string | null;
    productionActivationApprovalId: string | null;
    policyEpoch: number;
  };
  fencingPolicy: typeof WAVE_FENCING_POLICY;
  fence: string;
}

function boundedInteger(value: unknown, fallback: number): number {
  return Number.isInteger(value) && Number(value) >= 1 ? Number(value) : fallback;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function wavePolicyFence(value: Omit<WavePolicyEnvelope, 'fence'>): string {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}

export function defaultWaveRolloutPolicy(): WaveRolloutPolicy {
  return {
    enabled: false,
    cohort: 'none',
    workspaceAllowlist: [],
    runAllowlist: [],
    maxParallelism: 1,
    maxActiveWaveRuns: 1,
    maxActiveWaveRunsPerWorkspace: 1,
    maxCpuPercent: 70,
    maxMemoryPercent: 70,
    maxErrorRate: 0,
    observedCpuPercent: 0,
    observedMemoryPercent: 0,
    observedErrorRate: 0,
    halted: false,
    draining: false,
    rationale: 'Sequential production default',
    releaseReadinessPacketId: null,
    productionActivationApprovalId: null,
    releaseReadinessCurrent: false,
    operatorActivationCurrent: false,
    policyEpoch: 0,
  };
}

export function wavePolicyEnvironment(env: NodeJS.ProcessEnv = process.env): WavePolicyEnvironment {
  return {
    nodeEnv: env.NODE_ENV,
    productionEnabled: env.RORCA_WAVE_PARALLEL_PRODUCTION_ENABLED,
    experimentalEnabled: env.RORCA_EXPERIMENTAL_WAVE_PARALLEL,
    killSwitch: env.RORCA_WAVE_PARALLEL_KILL_SWITCH,
  };
}

function healthExceeded(rollout: WaveRolloutPolicy): boolean {
  return rollout.observedCpuPercent > rollout.maxCpuPercent
    || rollout.observedMemoryPercent > rollout.maxMemoryPercent
    || rollout.observedErrorRate > rollout.maxErrorRate;
}

function inCohort(input: WavePolicyEvaluationInput): boolean {
  return input.rollout.workspaceAllowlist.includes(input.workspaceId)
    || (input.runId !== undefined && input.rollout.runAllowlist.includes(input.runId));
}

export function evaluateWaveProductionPolicy(input: WavePolicyEvaluationInput): WavePolicyEnvelope {
  const requestedParallelism = boundedInteger(input.request.parallelism, 1);
  const explicitWaveRequest = input.request.orchestrationMode === 'wave-parallel' && requestedParallelism > 1;
  const requestedReceiptId = typeof input.request.qualificationReceiptId === 'string' ? input.request.qualificationReceiptId : null;
  const requestedCohort = typeof input.request.rolloutCohort === 'string' ? input.request.rolloutCohort : null;
  const production = input.environment.nodeEnv === 'production';
  const requested = {
    orchestrationMode: explicitWaveRequest ? 'wave-parallel' as const : 'sequential' as const,
    parallelism: explicitWaveRequest ? requestedParallelism : 1,
    qualificationReceiptId: requestedReceiptId,
    rolloutCohort: requestedCohort,
  };

  let status: WaveOperatorStatus = 'sequential-default';
  let allowed = !explicitWaveRequest;
  let reason = explicitWaveRequest ? 'wave_parallel_not_authorized' : 'explicit_wave_parallel_request_required';

  if (!production) {
    if (input.environment.experimentalEnabled === 'true') {
      status = 'experimental-nonproduction';
      allowed = true;
      reason = explicitWaveRequest ? 'nonproduction_experiment_authorized' : 'nonproduction_experiment_available';
    }
  } else if (explicitWaveRequest) {
    if (input.environment.killSwitch === 'true' || input.rollout.halted || healthExceeded(input.rollout)) {
      status = 'halted';
      reason = input.environment.killSwitch === 'true' ? 'operator_kill_switch' : 'rollout_health_halt';
    } else if (input.rollout.draining) {
      status = 'draining';
      reason = 'rollout_draining_no_new_parallel_dispatch';
    } else if (input.environment.productionEnabled !== 'true') {
      status = 'production-disabled';
      reason = 'production_authority_disabled';
    } else if (!input.receipt || !requestedReceiptId || requestedReceiptId !== input.receipt.id) {
      status = 'receipt-missing';
      reason = 'configured_current_receipt_required';
    } else if (!input.rollout.enabled) {
      status = 'production-disabled';
      reason = 'production_rollout_disabled';
    } else if (!input.receipt.current || !input.receipt.productionEnableAvailable || input.receipt.sourceRevision !== input.currentRevision) {
      status = 'receipt-stale';
      reason = 'receipt_identity_or_revision_stale';
    } else if (!input.rollout.releaseReadinessPacketId || !input.rollout.releaseReadinessCurrent) {
      status = 'review-missing';
      reason = 'current_independent_release_review_required';
    } else if (!input.rollout.productionActivationApprovalId || !input.rollout.operatorActivationCurrent) {
      status = 'activation-missing';
      reason = 'separate_operator_production_activation_required';
    } else if (!requestedCohort || requestedCohort !== input.rollout.cohort || !inCohort(input)) {
      status = 'production-disabled';
      reason = 'workspace_or_run_not_in_rollout_cohort';
    } else if (requestedParallelism > input.rollout.maxParallelism
      || input.activeWaveRuns >= input.rollout.maxActiveWaveRuns
      || input.activeWorkspaceWaveRuns >= input.rollout.maxActiveWaveRunsPerWorkspace) {
      status = 'halted';
      reason = 'rollout_concurrency_or_resource_cap';
    } else {
      allowed = true;
      status = input.rollout.cohort === 'all' ? 'enabled' : 'canary-enabled';
      reason = 'production_wave_parallel_authorized';
    }
  } else {
    if (input.environment.killSwitch === 'true' || input.rollout.halted || healthExceeded(input.rollout)) status = 'halted';
    else if (input.rollout.draining) status = 'draining';
    else if (input.environment.productionEnabled !== 'true') status = 'production-disabled';
    else if (!input.receipt) status = 'receipt-missing';
    else if (!input.rollout.enabled) status = 'production-disabled';
    else if (!input.receipt.current || input.receipt.sourceRevision !== input.currentRevision) status = 'receipt-stale';
    else if (!input.rollout.releaseReadinessPacketId || !input.rollout.releaseReadinessCurrent) status = 'review-missing';
    else if (!input.rollout.productionActivationApprovalId || !input.rollout.operatorActivationCurrent) status = 'activation-missing';
    else if (!inCohort(input)) status = 'production-disabled';
    else status = input.rollout.cohort === 'all' ? 'enabled' : 'canary-enabled';
  }

  const effectiveWave = explicitWaveRequest && allowed;
  const withoutFence: Omit<WavePolicyEnvelope, 'fence'> = {
    schemaVersion: WAVE_POLICY_SCHEMA,
    policyRevision: WAVE_POLICY_REVISION,
    requested,
    effective: {
      orchestrationMode: effectiveWave ? 'wave-parallel' : 'sequential',
      parallelism: effectiveWave ? requestedParallelism : 1,
    },
    status,
    allowed,
    reason,
    workspaceId: input.workspaceId,
    runId: input.runId ?? null,
    receipt: input.receipt ? {
      id: input.receipt.id,
      reportHash: input.receipt.reportHash,
      sourceRevision: input.receipt.sourceRevision,
    } : null,
    rollout: {
      cohort: input.rollout.cohort,
      maxParallelism: input.rollout.maxParallelism,
      maxActiveWaveRuns: input.rollout.maxActiveWaveRuns,
      maxActiveWaveRunsPerWorkspace: input.rollout.maxActiveWaveRunsPerWorkspace,
      releaseReadinessPacketId: input.rollout.releaseReadinessPacketId,
      productionActivationApprovalId: input.rollout.productionActivationApprovalId,
      policyEpoch: input.rollout.policyEpoch,
    },
    fencingPolicy: WAVE_FENCING_POLICY,
  };
  return { ...withoutFence, fence: wavePolicyFence(withoutFence) };
}

export function assertWavePolicyEnvelopeIntegrity(envelope: WavePolicyEnvelope): WavePolicyEnvelope {
  const { fence: _ignored, ...withoutFence } = envelope;
  if (envelope.schemaVersion !== WAVE_POLICY_SCHEMA || envelope.fencingPolicy !== WAVE_FENCING_POLICY || wavePolicyFence(withoutFence) !== envelope.fence) {
    throw new Error('[wave-production-policy] dispatch fence is invalid');
  }
  return envelope;
}

export function assertWavePolicyEnvelope(envelope: WavePolicyEnvelope, input: WavePolicyEvaluationInput): WavePolicyEnvelope {
  assertWavePolicyEnvelopeIntegrity(envelope);
  const current = evaluateWaveProductionPolicy(input);
  if (current.fence !== envelope.fence || current.effective.orchestrationMode !== envelope.effective.orchestrationMode || current.effective.parallelism !== envelope.effective.parallelism) {
    throw new Error(`[wave-production-policy] dispatch policy changed: ${current.reason}`);
  }
  if (envelope.requested.orchestrationMode === 'wave-parallel' && !envelope.allowed) {
    throw new Error(`[wave-production-policy] wave dispatch denied: ${envelope.reason}`);
  }
  return current;
}
