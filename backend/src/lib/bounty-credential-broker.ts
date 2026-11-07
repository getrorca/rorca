/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { AuthError, ConflictError, ForbiddenError, ValidationError } from './errors';

export const FORBIDDEN_CREDENTIAL_ACTIONS = ['provision', 'password-reset', 'mfa-enroll', 'mfa-reset', 'captcha-bypass'] as const;
export const APPROVED_CREDENTIAL_ADAPTERS = ['playwright-trusted', 'http-trusted'] as const;
const MAX_AUTH_FAILURES = 3;

export interface CredentialBinding {
  workspaceId: string;
  programId: string;
  missionId: string;
  accountId: string;
  role: string;
  origin: string;
  actions: string[];
  adapter: string;
  epoch: number;
  expiresAt: string;
}

export interface CredentialMaterial { username?: string; password?: string; token?: string; cookies?: string }
export interface CredentialHandle extends CredentialBinding { handle: string }
interface RecordEntry { digest: Buffer; binding: CredentialBinding; material: CredentialMaterial; failures: number; revoked: boolean }

export interface BrokerLifecycle {
  holdMission(binding: CredentialBinding, reason: 'auth_circuit_open' | 'refresh_invalidated'): Promise<void> | void;
  closeBrowserPartition(binding: CredentialBinding): Promise<void> | void;
}

const noLifecycle: BrokerLifecycle = { holdMission: () => undefined, closeBrowserPartition: () => undefined };

function canonicalOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('not an origin');
    return url.origin;
  } catch { throw new ValidationError('origin must be an absolute origin without credentials, path, query, or fragment'); }
}

function assertSafeActions(actions: string[]): void {
  if (!actions.length || actions.some((action) => !/^[a-z][a-z0-9:-]{1,63}$/.test(action))) {
    throw new ValidationError('At least one valid credential action is required');
  }
  if (actions.some((action) => (FORBIDDEN_CREDENTIAL_ACTIONS as readonly string[]).includes(action))) {
    throw new ForbiddenError('Autonomous account provisioning, reset, MFA, and CAPTCHA bypass are prohibited');
  }
}

export class BountyCredentialBroker {
  private readonly records = new Map<string, RecordEntry>();
  private readonly epochs = new Map<string, number>();
  private readonly missionEpochs = new Map<string, number>();
  constructor(private readonly lifecycle: BrokerLifecycle = noLifecycle) {}

  issue(binding: CredentialBinding, material: CredentialMaterial): CredentialHandle {
    const origin = canonicalOrigin(binding.origin);
    assertSafeActions(binding.actions);
    if (!(APPROVED_CREDENTIAL_ADAPTERS as readonly string[]).includes(binding.adapter)) {
      throw new ForbiddenError('Credential adapter is not approved for secret redemption');
    }
    if (!Number.isSafeInteger(binding.epoch) || binding.epoch < 1 || Date.parse(binding.expiresAt) <= Date.now()) {
      throw new ValidationError('Credential handle epoch and expiry must be valid');
    }
    if (!Object.values(material).some((value) => typeof value === 'string' && value.length > 0)) {
      throw new ValidationError('Credential material is required');
    }
    const scope = `${binding.workspaceId}:${binding.programId}:${binding.missionId}:${binding.accountId}`;
    const epoch = this.epochs.get(scope) ?? binding.epoch;
    const missionEpoch = this.missionEpochs.get(binding.missionId) ?? binding.epoch;
    if (binding.epoch !== epoch || binding.epoch !== missionEpoch) throw new ConflictError('Credential epoch is stale');
    this.missionEpochs.set(binding.missionId, binding.epoch);
    const handle = `bch_${randomBytes(32).toString('base64url')}`;
    const digest = createHash('sha256').update(handle).digest();
    const safeBinding = { ...binding, origin, actions: [...new Set(binding.actions)].sort() };
    this.records.set(digest.toString('hex'), { digest, binding: safeBinding, material: { ...material }, failures: 0, revoked: false });
    return { handle, ...safeBinding };
  }

  redeem(handle: string, request: { adapter: string; origin: string; action: string; epoch: number }): CredentialMaterial {
    const digest = createHash('sha256').update(handle).digest();
    const record = this.records.get(digest.toString('hex'));
    if (!record || !timingSafeEqual(record.digest, digest)) throw new AuthError('Invalid credential handle');
    const { binding } = record;
    if (record.revoked || Date.parse(binding.expiresAt) <= Date.now() || request.epoch !== binding.epoch || this.missionEpochs.get(binding.missionId) !== binding.epoch) throw new AuthError('Credential handle expired, revoked, or stale');
    if (request.adapter !== binding.adapter || canonicalOrigin(request.origin) !== binding.origin || !binding.actions.includes(request.action)) {
      throw new ForbiddenError('Credential handle is not authorized for this adapter destination and action');
    }
    return { ...record.material };
  }

  async reportFailure(handle: string, reason: 'login' | 'captcha' | 'refresh-invalidated'): Promise<{ held: boolean }> {
    const record = this.lookup(handle);
    if (reason === 'refresh-invalidated') {
      await this.revoke(handle);
      await this.lifecycle.holdMission(record.binding, 'refresh_invalidated');
      return { held: true };
    }
    record.failures += 1;
    if (record.failures < MAX_AUTH_FAILURES) return { held: false };
    record.revoked = true;
    await this.lifecycle.closeBrowserPartition(record.binding);
    await this.lifecycle.holdMission(record.binding, 'auth_circuit_open');
    return { held: true };
  }

  async revoke(handle: string): Promise<{ epoch: number }> {
    const record = this.lookup(handle);
    record.revoked = true;
    const b = record.binding;
    const scope = `${b.workspaceId}:${b.programId}:${b.missionId}:${b.accountId}`;
    const epoch = Math.max(this.epochs.get(scope) ?? b.epoch, b.epoch) + 1;
    this.epochs.set(scope, epoch);
    await this.lifecycle.closeBrowserPartition(b);
    return { epoch };
  }

  /** Revokes every credential/browser partition at the Controller replacement epoch. */
  async revokeMission(missionId: string, replacementEpoch: number): Promise<number> {
    if (!missionId || !Number.isSafeInteger(replacementEpoch) || replacementEpoch < 2) throw new ValidationError('mission revocation epoch is invalid');
    const current = this.missionEpochs.get(missionId) ?? replacementEpoch - 1;
    if (replacementEpoch < current) throw new ConflictError('Mission credential revocation epoch regressed');
    this.missionEpochs.set(missionId, replacementEpoch);
    let revoked = 0;
    for (const record of this.records.values()) {
      if (record.binding.missionId !== missionId || record.revoked) continue;
      record.revoked = true;
      revoked += 1;
      await this.lifecycle.closeBrowserPartition(record.binding);
    }
    return revoked;
  }

  private lookup(handle: string): RecordEntry {
    const record = this.records.get(createHash('sha256').update(handle).digest('hex'));
    if (!record) throw new AuthError('Invalid credential handle');
    return record;
  }
}

/** Never forward ambient authorization or cookie credentials across origins. */
export function headersForRedirect(headers: Record<string, string>, from: string, destination: string): Record<string, string> {
  if (new URL(from).origin === new URL(destination).origin) return { ...headers };
  const stripped = { ...headers };
  for (const name of Object.keys(stripped)) {
    if (['authorization', 'cookie', 'proxy-authorization'].includes(name.toLowerCase())) delete stripped[name];
  }
  return stripped;
}
