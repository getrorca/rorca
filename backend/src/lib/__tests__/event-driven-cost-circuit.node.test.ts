/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { AUTHENTICATED_WAKE_SOURCES, EventDrivenCostCircuit, boundedExponentialSleep, sealIdlePolicy,
  type DurableIdleCircuitStore, type IdleControllerState, type IdleLimit, type VerifiedWakeSourceReceipt,
  type VersionedIdlePolicy, type WakeAuthorityVerifier, type WakeRequest, type WakeResult, type WakeRevalidation } from '../event-driven-cost-circuit';
import { governedOperationsHash, type Sha256 } from '../governed-operations-primitives';

const NOW = Date.parse('2026-08-05T13:00:00.000Z');
function policy(maximumOscillations = 3): VersionedIdlePolicy {
  return sealIdlePolicy({ schemaVersion: 'rorca.idle-cost-policy.v1', policyId: 'policy:idle-pilot', policyVersion: '1.0.0',
    hardMaxima: { noChangeTicks: 3, elapsedMs: 1000, providerTokens: 100, providerRequests: 2, currencyMicros: 1000, retries: 2 },
    exponentialSleep: { baseMs: 100, multiplier: 2, maximumMs: 800, jitterPermille: 100 }, cooldownMs: 500,
    allowedWakeSources: AUTHENTICATED_WAKE_SOURCES, maximumOscillations });
}
class DurableFixtureStore implements DurableIdleCircuitStore {
  readonly states = new Map<string, IdleControllerState>();
  readonly wakes = new Map<string, { hash: Sha256; result: WakeResult }>();
  async register(state: IdleControllerState): Promise<IdleControllerState> {
    const key = `${state.workspaceId}:${state.controllerId}`;
    if (this.states.has(key)) throw new Error('Idle controller is already registered');
    this.states.set(key, structuredClone(state)); return structuredClone(state);
  }
  async load(workspaceId: string, controllerId: string): Promise<IdleControllerState | null> {
    const state = this.states.get(`${workspaceId}:${controllerId}`);
    return state ? structuredClone(state) : null;
  }
  async atomicState<T>(workspaceId: string, controllerId: string,
    update: (state: IdleControllerState) => { state: IdleControllerState; result: T }): Promise<T> {
    const key = `${workspaceId}:${controllerId}`; const state = this.states.get(key);
    if (!state) throw new Error('Unknown idle controller');
    const changed = update(structuredClone(state)); this.states.set(key, structuredClone(changed.state)); return changed.result;
  }
  async atomicWake(workspaceId: string, controllerId: string, wakeId: string, requestHash: Sha256,
    update: (state: IdleControllerState) => Promise<WakeResult>): Promise<WakeResult> {
    const replayKey = `${workspaceId}:${controllerId}:${wakeId}`; const replay = this.wakes.get(replayKey);
    if (replay) { if (replay.hash !== requestHash) throw new Error('Changed wake replay permanently rejected'); return structuredClone(replay.result); }
    const key = `${workspaceId}:${controllerId}`; const state = this.states.get(key); if (!state) throw new Error('Unknown idle controller');
    const result = await update(structuredClone(state)); this.states.set(key, structuredClone(result.state));
    this.wakes.set(replayKey, { hash: requestHash, result: structuredClone(result) }); return result;
  }
}
const healthy: WakeRevalidation = { dependencyCapabilityHealthy: true, workspaceQuotaAvailable: true,
  runtimeQuotaAvailable: true, leaseFenceCurrent: true, policyActive: true, sessionCursorCurrent: true,
  cooldownElapsed: true, singleWriter: true };
class AuthorityFixture implements WakeAuthorityVerifier {
  revalidation = { ...healthy };
  denied = new Set<string>();
  async verifySourceAndLoadState(request: WakeRequest): Promise<{ receipt: VerifiedWakeSourceReceipt; revalidation: WakeRevalidation } | null> {
    if (this.denied.has(request.sourceReceiptId)) return null;
    const material = { receiptId: request.sourceReceiptId, workspaceId: request.workspaceId, controllerId: request.controllerId,
      source: 'canonical_event' as const, subjectHash: governedOperationsHash('subject'), authenticatedBy: 'canonical-writer',
      relevant: true as const, observedAt: request.requestedAt - 1, expiresAt: request.requestedAt + 1000 };
    return { receipt: { ...material, receiptHash: governedOperationsHash(material) }, revalidation: { ...this.revalidation } };
  }
}
function wake(overrides: Partial<WakeRequest> = {}): WakeRequest { return { wakeId: 'wake:1', workspaceId: 'workspace:a',
  controllerId: 'controller:doctor', sourceReceiptId: 'receipt:canonical:1', requestedAt: NOW + 500, ...overrides }; }
function circuit(store = new DurableFixtureStore(), authority = new AuthorityFixture(), clock = () => NOW, oscillations = 3) {
  return { circuit: new EventDrivenCostCircuit(policy(oscillations), store, authority, clock), store, authority };
}

test('W4-012 policy bounds all spend/sleep/jitter/wake dimensions', () => {
  const value = policy(); assert.match(value.policyHash, /^sha256:/); assert.deepEqual(value.allowedWakeSources, AUTHENTICATED_WAKE_SOURCES);
  assert.equal(boundedExponentialSleep(value, 0, 0), 100); assert.equal(boundedExponentialSleep(value, 2, 1), 440);
  assert.throws(() => new EventDrivenCostCircuit({ ...value, cooldownMs: 501 }, new DurableFixtureStore(), new AuthorityFixture()), /hash mismatch/);
});

test('W4-012 each hard limit is durably scoped and blocks requests after controller restart', async () => {
  for (const limit of Object.keys(policy().hardMaxima) as IdleLimit[]) {
    const fixture = circuit(); await fixture.circuit.register('workspace:a', 'controller:doctor', 7);
    const beforeB = await fixture.circuit.register('workspace:b', 'controller:doctor', 11);
    const suspended = await fixture.circuit.observeIteration('workspace:a', 'controller:doctor', { [limit]: policy().hardMaxima[limit] });
    assert.equal(suspended.status, 'suspended'); assert.equal(suspended.nonessentialReservations, 0);
    const restarted = new EventDrivenCostCircuit(policy(), fixture.store, fixture.authority, () => NOW);
    assert.equal(await restarted.providerRequestAllowed('workspace:a', 'controller:doctor'), false);
    assert.deepEqual(await restarted.observeIteration('workspace:b', 'controller:doctor', {}), beforeB);
  }
});

test('W4-012 wake requires an independently verified source receipt and loaded revalidation', async () => {
  const denied = circuit(); await denied.circuit.register('workspace:a', 'controller:doctor', 1);
  await denied.circuit.observeIteration('workspace:a', 'controller:doctor', { noChangeTicks: 3 });
  denied.authority.denied.add('receipt:heartbeat');
  assert.equal((await denied.circuit.requestWake(wake({ sourceReceiptId: 'receipt:heartbeat' }))).accepted, false);
  for (const key of Object.keys(healthy) as Array<keyof WakeRevalidation>) {
    const fixture = circuit(); await fixture.circuit.register('workspace:a', 'controller:doctor', 1);
    await fixture.circuit.observeIteration('workspace:a', 'controller:doctor', { retries: 2 });
    fixture.authority.revalidation = { ...healthy, [key]: false };
    assert.equal((await fixture.circuit.requestWake(wake({ wakeId: `wake:${key}` }))).reasonCode, 'wake_revalidation_failed');
  }
});

test('W4-012 durable wake replay survives restart and oscillation opens the scoped circuit', async () => {
  let clock = NOW; const fixture = circuit(new DurableFixtureStore(), new AuthorityFixture(), () => clock, 2);
  await fixture.circuit.register('workspace:a', 'controller:doctor', 1); await fixture.circuit.register('workspace:b', 'controller:doctor', 1);
  await fixture.circuit.observeIteration('workspace:a', 'controller:doctor', { providerRequests: 2 }); clock += 500;
  const request = wake({ requestedAt: clock }); const first = await fixture.circuit.requestWake(request);
  const restarted = new EventDrivenCostCircuit(policy(2), fixture.store, fixture.authority, () => clock);
  assert.deepEqual(await restarted.requestWake(request), first); assert.equal(first.state.wakeCount, 1);
  await restarted.observeIteration('workspace:a', 'controller:doctor', { providerTokens: 100 }); clock += 500;
  assert.deepEqual(await restarted.requestWake(request), first);
  assert.equal((await fixture.store.load('workspace:a', 'controller:doctor'))?.status, 'suspended');
  assert.equal(await restarted.providerRequestAllowed('workspace:a', 'controller:doctor'), false);
  const opened = await restarted.requestWake(wake({ wakeId: 'wake:2', requestedAt: clock }));
  assert.equal(opened.state.status, 'circuit_open'); assert.equal(await restarted.providerRequestAllowed('workspace:b', 'controller:doctor'), true);
  await assert.rejects(restarted.requestWake({ ...request, sourceReceiptId: 'receipt:changed' }), /Changed wake replay/);
});
