/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { boundedRedactedObservation, governedOperationsHash, requireExactHash, type Sha256 } from './governed-operations-primitives';

export const AUTHENTICATED_WAKE_SOURCES = ['canonical_event', 'webhook', 'lease_deadline', 'operator_request'] as const;
export type AuthenticatedWakeSource = typeof AUTHENTICATED_WAKE_SOURCES[number];
export type IdleLimit = 'noChangeTicks' | 'elapsedMs' | 'providerTokens' | 'providerRequests' | 'currencyMicros' | 'retries';

export interface VersionedIdlePolicy {
  schemaVersion: 'rorca.idle-cost-policy.v1'; policyId: string; policyVersion: string; policyHash: Sha256;
  hardMaxima: Record<IdleLimit, number>;
  exponentialSleep: { baseMs: number; multiplier: number; maximumMs: number; jitterPermille: number };
  cooldownMs: number; allowedWakeSources: readonly AuthenticatedWakeSource[]; maximumOscillations: number;
}
export interface IdleUsage { noChangeTicks: number; elapsedMs: number; providerTokens: number; providerRequests: number; currencyMicros: number; retries: number }
export interface WakeRevalidation {
  dependencyCapabilityHealthy: boolean; workspaceQuotaAvailable: boolean; runtimeQuotaAvailable: boolean;
  leaseFenceCurrent: boolean; policyActive: boolean; sessionCursorCurrent: boolean; cooldownElapsed: boolean; singleWriter: boolean;
}
export interface VerifiedWakeSourceReceipt {
  receiptId: string; receiptHash: Sha256; workspaceId: string; controllerId: string; source: AuthenticatedWakeSource;
  subjectHash: Sha256; authenticatedBy: string; relevant: true; observedAt: number; expiresAt: number;
}
export interface CircuitEscalation { escalationId: string; workspaceId: string; controllerId: string; reasonCode: string; detail: string; authorityEffect: 'none' }
export interface IdleControllerState {
  workspaceId: string; controllerId: string; policyHash: Sha256; status: 'running' | 'suspended' | 'circuit_open';
  usage: IdleUsage; nonessentialReservations: number; providerRequestCount: number; suspensionCount: number;
  wakeCount: number; oscillations: number; lastTransitionAt: number; escalation: CircuitEscalation | null;
  diagnosticsRetained: true; canonicalWorkCancelled: false;
}
export interface WakeRequest { wakeId: string; workspaceId: string; controllerId: string; sourceReceiptId: string; requestedAt: number }
export interface WakeResult { accepted: boolean; reasonCode: string; state: IdleControllerState; verifiedSource?: AuthenticatedWakeSource }

export interface DurableIdleCircuitStore {
  register(state: IdleControllerState): Promise<IdleControllerState>;
  atomicState<T>(workspaceId: string, controllerId: string,
    update: (state: IdleControllerState) => { state: IdleControllerState; result: T }): Promise<T>;
  load(workspaceId: string, controllerId: string): Promise<IdleControllerState | null>;
  atomicWake(workspaceId: string, controllerId: string, wakeId: string, requestHash: Sha256,
    update: (state: IdleControllerState) => Promise<WakeResult>): Promise<WakeResult>;
}

export interface WakeAuthorityVerifier {
  verifySourceAndLoadState(request: WakeRequest, current: IdleControllerState): Promise<{
    receipt: VerifiedWakeSourceReceipt;
    revalidation: WakeRevalidation;
  } | null>;
}

const ZERO_USAGE: IdleUsage = { noChangeTicks: 0, elapsedMs: 0, providerTokens: 0, providerRequests: 0, currencyMicros: 0, retries: 0 };

export function sealIdlePolicy(input: Omit<VersionedIdlePolicy, 'policyHash'>): VersionedIdlePolicy {
  for (const key of Object.keys(input.hardMaxima) as IdleLimit[]) {
    if (!Number.isSafeInteger(input.hardMaxima[key]) || input.hardMaxima[key] < 1) throw new Error(`Idle policy ${key} hard maximum must be positive`);
  }
  const sleep = input.exponentialSleep;
  if (sleep.baseMs < 1 || sleep.multiplier < 1 || sleep.maximumMs < sleep.baseMs || sleep.jitterPermille < 0
    || sleep.jitterPermille > 1000 || input.cooldownMs < 0 || input.maximumOscillations < 1 || input.maximumOscillations > 100) {
    throw new Error('Idle policy bounds are invalid');
  }
  if (new Set(input.allowedWakeSources).size !== AUTHENTICATED_WAKE_SOURCES.length
    || AUTHENTICATED_WAKE_SOURCES.some(source => !input.allowedWakeSources.includes(source))) {
    throw new Error('Idle policy must explicitly enumerate only all authenticated wake sources');
  }
  return Object.freeze({ ...input, allowedWakeSources: Object.freeze([...input.allowedWakeSources]), policyHash: governedOperationsHash(input) });
}

export function boundedExponentialSleep(policy: VersionedIdlePolicy, retry: number, deterministicJitter: number): number {
  const unjittered = Math.min(policy.exponentialSleep.maximumMs,
    policy.exponentialSleep.baseMs * policy.exponentialSleep.multiplier ** Math.max(0, retry));
  const normalized = Math.max(-1, Math.min(1, deterministicJitter));
  return Math.max(0, Math.round(unjittered + unjittered * (policy.exponentialSleep.jitterPermille / 1000) * normalized));
}

export class EventDrivenCostCircuit {
  constructor(private readonly policy: VersionedIdlePolicy, private readonly store: DurableIdleCircuitStore,
    private readonly authority: WakeAuthorityVerifier, private readonly now: () => number = Date.now) {
    const { policyHash: _hash, ...material } = policy;
    if (governedOperationsHash(material) !== policy.policyHash) throw new Error('Idle policy hash mismatch');
  }

  async register(workspaceId: string, controllerId: string, nonessentialReservations: number): Promise<IdleControllerState> {
    if (!Number.isSafeInteger(nonessentialReservations) || nonessentialReservations < 0) throw new Error('Invalid reservation count');
    return this.store.register({ workspaceId, controllerId, policyHash: this.policy.policyHash, status: 'running',
      usage: { ...ZERO_USAGE }, nonessentialReservations, providerRequestCount: 0, suspensionCount: 0,
      wakeCount: 0, oscillations: 0, lastTransitionAt: this.now(), escalation: null,
      diagnosticsRetained: true, canonicalWorkCancelled: false });
  }

  async observeIteration(workspaceId: string, controllerId: string, delta: Partial<IdleUsage>): Promise<IdleControllerState> {
    return this.store.atomicState(workspaceId, controllerId, state => {
      if (state.policyHash !== this.policy.policyHash) throw new Error('Persisted idle policy mismatch');
      if (state.status !== 'running') return { state, result: structuredClone(state) };
      const next = structuredClone(state);
      for (const key of Object.keys(ZERO_USAGE) as IdleLimit[]) {
        const amount = delta[key] ?? 0;
        if (!Number.isSafeInteger(amount) || amount < 0) throw new Error(`Idle usage ${key} must be a non-negative integer`);
        next.usage[key] += amount;
      }
      next.providerRequestCount += delta.providerRequests ?? 0;
      const exceeded = (Object.keys(this.policy.hardMaxima) as IdleLimit[]).find(key => next.usage[key] >= this.policy.hardMaxima[key]);
      if (exceeded) this.suspend(next, exceeded);
      return { state: next, result: structuredClone(next) };
    });
  }

  async providerRequestAllowed(workspaceId: string, controllerId: string): Promise<boolean> {
    return this.store.atomicState(workspaceId, controllerId, state => ({ state, result: state.status === 'running' }));
  }

  async requestWake(request: WakeRequest): Promise<WakeResult> {
    const requestHash = governedOperationsHash(request);
    return this.store.atomicWake(request.workspaceId, request.controllerId, request.wakeId, requestHash, async state => {
      if (state.policyHash !== this.policy.policyHash) throw new Error('Persisted idle policy mismatch');
      let accepted = false;
      let verifiedSource: AuthenticatedWakeSource | undefined;
      let reasonCode = state.status === 'circuit_open' ? 'governed_operator_review_required'
        : state.status !== 'suspended' ? 'controller_not_suspended' : 'wake_denied';
      if (state.status === 'suspended') {
        const verified = await this.authority.verifySourceAndLoadState(request, structuredClone(state));
        if (!verified) reasonCode = 'wake_source_receipt_not_verified';
        else {
          const receipt = verified.receipt;
          requireExactHash(receipt.receiptHash, 'wake source receipt hash');
          const exactReceipt = receipt.receiptId === request.sourceReceiptId && receipt.workspaceId === request.workspaceId
            && receipt.controllerId === request.controllerId && receipt.relevant && receipt.observedAt <= request.requestedAt
            && receipt.expiresAt >= request.requestedAt && this.policy.allowedWakeSources.includes(receipt.source);
          if (exactReceipt) verifiedSource = receipt.source;
          if (!exactReceipt) reasonCode = 'wake_source_receipt_not_exact';
          else if (request.requestedAt < state.lastTransitionAt + this.policy.cooldownMs) reasonCode = 'cooldown_not_elapsed';
          else if (!Object.values(verified.revalidation).every(Boolean)) reasonCode = 'wake_revalidation_failed';
          else {
            state.oscillations += 1;
            if (state.oscillations >= this.policy.maximumOscillations) {
              state.status = 'circuit_open';
              state.escalation = { escalationId: governedOperationsHash({ requestHash, circuit: true }),
                workspaceId: state.workspaceId, controllerId: state.controllerId, reasonCode: 'wake_suspend_oscillation',
                detail: 'governed operator review required; no provider, merge, deployment, approval, or lifecycle authority', authorityEffect: 'none' };
              reasonCode = 'governed_operator_review_required';
            } else {
              state.status = 'running'; state.usage = { ...ZERO_USAGE }; state.wakeCount += 1;
              state.lastTransitionAt = request.requestedAt; state.escalation = null;
              accepted = true; reasonCode = 'one_iteration_authorized';
            }
          }
        }
      }
      return { accepted, reasonCode, state: structuredClone(state), ...(verifiedSource ? { verifiedSource } : {}) };
    });
  }

  private suspend(state: IdleControllerState, limit: IdleLimit): void {
    state.status = 'suspended'; state.nonessentialReservations = 0; state.suspensionCount += 1;
    state.lastTransitionAt = this.now();
    if (!state.escalation) state.escalation = { escalationId: governedOperationsHash({ workspaceId: state.workspaceId,
      controllerId: state.controllerId, policyHash: state.policyHash, limit, suspensionCount: state.suspensionCount }),
      workspaceId: state.workspaceId, controllerId: state.controllerId, reasonCode: `idle_hard_limit_${limit}`,
      detail: boundedRedactedObservation('hard maximum crossed; scoped controller suspended and nonessential reservations released'), authorityEffect: 'none' };
  }
}
