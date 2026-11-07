/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { BountyCallbackBroker, type CallbackGrant } from '../bounty-callback-broker';

const grant = (overrides: Partial<CallbackGrant> = {}): CallbackGrant => ({
  enabled: true, missionId: 'mission-a', attemptId: 'attempt-a', operationId: 'operation-a',
  protocol: 'https', domain: 'callbacks.operator.example', maxObservations: 2, maxBytes: 128,
  expiresAt: new Date(Date.now() + 60_000).toISOString(), retentionUntil: new Date(Date.now() + 120_000).toISOString(), ...overrides,
});

const observe = (broker: BountyCallbackBroker, allocation: ReturnType<BountyCallbackBroker['allocate']>, overrides = {}) =>
  broker.observe(allocation.handle, { protocol: allocation.protocol, domain: allocation.domain, nonce: allocation.nonce, byteLength: 12, ...overrides });

const proof = (observationId: string, overrides = {}) => ({ missionId: 'mission-a', attemptId: 'attempt-a', operationId: 'operation-a', observationId, negativeControlPassed: true, oracleRuleMatched: true, triggeredAt: new Date(Date.now() - 1_000).toISOString(), ...overrides });

describe('BountyCallbackBroker', () => {
  test('is disabled by default and requires every exact bounded grant', () => {
    const broker = new BountyCallbackBroker();
    expect(() => broker.allocate(grant({ enabled: false }))).toThrow('disabled by default');
    expect(() => broker.allocate(grant({ domain: '*.example.com' }))).toThrow();
    expect(() => broker.allocate(grant({ maxBytes: 0 }))).toThrow();
    expect(() => broker.allocate(grant({ expiresAt: new Date(0).toISOString() }))).toThrow();
  });

  test('creates high-entropy opaque single-purpose identifiers without target or secret', () => {
    const allocation = new BountyCallbackBroker().allocate(grant());
    expect(allocation.handle).toMatch(/^bcb_[A-Za-z0-9_-]{43}$/);
    expect(allocation.nonce).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(JSON.stringify(allocation)).not.toContain('mission-a');
    expect(JSON.stringify(allocation)).not.toContain('operation-a');
  });

  test('proves only broker lineage, timing, nonce, negative control, oracle, and exact mission scope', () => {
    const broker = new BountyCallbackBroker(); const allocation = broker.allocate(grant()); const observation = observe(broker, allocation);
    expect(broker.evaluateProof(proof(observation.observationId))).toBe('proven');
    expect(broker.evaluateProof(proof(observation.observationId, { missionId: 'mission-b' }))).toBe('inconclusive');
    expect(broker.evaluateProof(proof(observation.observationId, { negativeControlPassed: false }))).toBe('inconclusive');
    expect(broker.evaluateProof(proof(observation.observationId, { oracleRuleMatched: false }))).toBe('inconclusive');
    expect(broker.evaluateProof(proof(observation.observationId, { triggeredAt: new Date(Date.now() + 30_000).toISOString() }))).toBe('inconclusive');
  });

  test('quarantines guessing, noise, injection-sized input, duplicate replay, and late callbacks', () => {
    const broker = new BountyCallbackBroker(); const allocation = broker.allocate(grant());
    expect(observe(broker, allocation, { nonce: '<script>guess</script>' }).quarantined).toBe(true);
    expect(observe(broker, allocation, { domain: 'noise.example' }).quarantined).toBe(true);
    expect(observe(broker, allocation, { byteLength: 10_000 }).quarantined).toBe(true);
    expect(observe(broker, allocation).quarantined).toBe(false);
    expect(observe(broker, allocation).quarantined).toBe(true);
    broker.pauseMission('mission-a');
    expect(observe(broker, allocation).quarantined).toBe(true);
    expect(broker.quarantinedCount()).toBe(5);
  });

  test('kill revokes every mission allocation and retention purge removes lineage', () => {
    const broker = new BountyCallbackBroker();
    const allocation = broker.allocate(grant({ retentionUntil: new Date(Date.now() + 61_000).toISOString() }));
    const observation = observe(broker, allocation);
    expect(broker.killMission('mission-a')).toBe(1);
    expect(broker.evaluateProof(proof(observation.observationId))).toBe('inconclusive');
    expect(broker.purge(Date.now() + 62_000)).toBe(1);
    expect(() => observe(broker, allocation)).toThrow('invalid callback handle');
  });
});
