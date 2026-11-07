/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { AuthError, ForbiddenError, ValidationError } from './errors';

export const CALLBACK_PROTOCOLS = ['https', 'dns'] as const;
export type CallbackProtocol = typeof CALLBACK_PROTOCOLS[number];

export interface CallbackGrant {
  enabled: boolean;
  missionId: string;
  attemptId: string;
  operationId: string;
  protocol: CallbackProtocol;
  domain: string;
  maxObservations: number;
  maxBytes: number;
  expiresAt: string;
  retentionUntil: string;
  authorityEpoch?: number;
}

export interface CallbackAllocation {
  handle: string;
  nonce: string;
  protocol: CallbackProtocol;
  domain: string;
  expiresAt: string;
}

export interface CallbackObservation {
  observationId: string;
  allocationLineage: string;
  protocol: CallbackProtocol;
  receivedAt: string;
  byteLength: number;
  nonceMatched: boolean;
  quarantined: boolean;
}

export interface ProofRequest {
  missionId: string;
  attemptId: string;
  operationId: string;
  observationId: string;
  negativeControlPassed: boolean;
  oracleRuleMatched: boolean;
  triggeredAt: string;
}

export type ProofDecision = 'proven' | 'inconclusive';
interface AllocationRecord { digest: Buffer; lineage: string; grant: CallbackGrant & { authorityEpoch: number }; nonce: string; observations: number; bytes: number; revoked: boolean; observation?: CallbackObservation }

function exactDomain(value: string): string {
  const normalized = value.toLowerCase();
  if (value !== normalized || value.length > 253 || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value)) {
    throw new ValidationError('callback domain must be an exact lowercase DNS domain');
  }
  return value;
}

/**
 * Operator-owned, deliberately non-networked callback boundary. It allocates exact grants and
 * admits metadata only; callers cannot use it as a webhook, proxy, content fetcher, or executor.
 */
export class BountyCallbackBroker {
  private readonly allocations = new Map<string, AllocationRecord>();
  private readonly observations = new Map<string, AllocationRecord>();
  private readonly quarantine: CallbackObservation[] = [];
  private readonly missionEpochs = new Map<string, number>();

  allocate(grant: CallbackGrant): CallbackAllocation {
    if (!grant.enabled) throw new ForbiddenError('OOB callbacks are disabled by default');
    if (!(CALLBACK_PROTOCOLS as readonly string[]).includes(grant.protocol)) throw new ForbiddenError('callback protocol is not approved');
    const domain = exactDomain(grant.domain);
    const expires = Date.parse(grant.expiresAt);
    const retention = Date.parse(grant.retentionUntil);
    if (!grant.missionId || !grant.attemptId || !grant.operationId) throw new ValidationError('mission, attempt, and operation bindings are required');
    if (!Number.isSafeInteger(grant.maxObservations) || grant.maxObservations < 1 || grant.maxObservations > 100 ||
        !Number.isSafeInteger(grant.maxBytes) || grant.maxBytes < 1 || grant.maxBytes > 65_536 ||
        expires <= Date.now() || retention < expires) throw new ValidationError('exact bounded budget, data limit, expiry, and retention are required');
    const currentEpoch = this.missionEpochs.get(grant.missionId) ?? grant.authorityEpoch ?? 1;
    const authorityEpoch = grant.authorityEpoch ?? currentEpoch;
    if (!Number.isSafeInteger(authorityEpoch) || authorityEpoch < 1 || authorityEpoch !== currentEpoch) throw new ForbiddenError('callback grant authority epoch is stale');
    this.missionEpochs.set(grant.missionId, authorityEpoch);
    const handle = `bcb_${randomBytes(32).toString('base64url')}`;
    const nonce = randomBytes(24).toString('base64url');
    const digest = createHash('sha256').update(handle).digest();
    const lineage = randomBytes(16).toString('hex');
    this.allocations.set(digest.toString('hex'), { digest, lineage, grant: { ...grant, domain, authorityEpoch }, nonce, observations: 0, bytes: 0, revoked: false });
    return { handle, nonce, protocol: grant.protocol, domain, expiresAt: grant.expiresAt };
  }

  /** Admits only bounded scalar metadata. There is intentionally no body, URL, headers, or response hook. */
  observe(handle: string, input: { protocol: CallbackProtocol; domain: string; nonce: string; byteLength: number; receivedAt?: string }): CallbackObservation {
    const record = this.find(handle);
    const receivedAt = input.receivedAt ?? new Date().toISOString();
    const validTime = Number.isFinite(Date.parse(receivedAt)) && Date.parse(receivedAt) <= Date.parse(record.grant.expiresAt);
    const exactScope = input.protocol === record.grant.protocol && input.domain === record.grant.domain;
    const nonceMatched = this.matchesNonce(record.nonce, input.nonce);
    const validSize = Number.isSafeInteger(input.byteLength) && input.byteLength >= 0 && record.bytes + input.byteLength <= record.grant.maxBytes;
    const active = !record.revoked && record.grant.authorityEpoch === this.missionEpochs.get(record.grant.missionId) && record.observations < record.grant.maxObservations;
    const quarantined = !(validTime && exactScope && nonceMatched && validSize && active);
    const observation: CallbackObservation = { observationId: randomBytes(16).toString('hex'), allocationLineage: record.lineage, protocol: input.protocol, receivedAt, byteLength: validSize ? input.byteLength : 0, nonceMatched, quarantined };
    if (quarantined) { this.quarantine.push(observation); return observation; }
    record.observations += 1; record.bytes += input.byteLength;
    if (record.observation) { observation.quarantined = true; this.quarantine.push(observation); return observation; }
    record.observation = observation; this.observations.set(observation.observationId, record);
    return observation;
  }

  evaluateProof(request: ProofRequest): ProofDecision {
    const record = this.observations.get(request.observationId);
    if (!record || record.revoked || record.grant.missionId !== request.missionId || record.grant.attemptId !== request.attemptId || record.grant.operationId !== request.operationId) return 'inconclusive';
    const observation = record.observation;
    const timing = Date.parse(request.triggeredAt) <= Date.parse(observation!.receivedAt) && Date.parse(observation!.receivedAt) <= Date.parse(record.grant.expiresAt);
    return observation?.allocationLineage === record.lineage && observation.nonceMatched && !observation.quarantined && timing && request.negativeControlPassed && request.oracleRuleMatched ? 'proven' : 'inconclusive';
  }

  revokeMission(missionId: string, replacementEpoch?: number): number {
    const current = this.missionEpochs.get(missionId) ?? 1;
    const next = replacementEpoch ?? current + 1;
    if (!Number.isSafeInteger(next) || next < current) throw new ValidationError('callback revocation epoch must not regress');
    if (next === current) return 0;
    this.missionEpochs.set(missionId, next);
    let count = 0;
    for (const record of this.allocations.values()) if (record.grant.missionId === missionId && !record.revoked) { record.revoked = true; count += 1; }
    return count;
  }
  pauseMission(missionId: string, replacementEpoch?: number): number { return this.revokeMission(missionId, replacementEpoch); }
  killMission(missionId: string, replacementEpoch?: number): number { return this.revokeMission(missionId, replacementEpoch); }
  purge(now = Date.now()): number { let count = 0; for (const [key, record] of this.allocations) if (Date.parse(record.grant.retentionUntil) <= now) { this.allocations.delete(key); if (record.observation) this.observations.delete(record.observation.observationId); count += 1; } return count; }
  quarantinedCount(): number { return this.quarantine.length; }

  private find(handle: string): AllocationRecord {
    const digest = createHash('sha256').update(handle).digest(); const record = this.allocations.get(digest.toString('hex'));
    if (!record || !timingSafeEqual(record.digest, digest)) throw new AuthError('invalid callback handle');
    return record;
  }
  private matchesNonce(expected: string, actual: string): boolean { const a = Buffer.from(expected); const b = Buffer.from(actual); return a.length === b.length && timingSafeEqual(a, b); }
}

/** Process-wide trusted callback authority, revoked by mission control. */
export const bountyCallbackBroker = new BountyCallbackBroker();
