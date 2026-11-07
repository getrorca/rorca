/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PoolClient } from 'pg';
import type { BrowserContextOptions } from 'playwright';
import { z } from 'zod';
import { query, queryOne, transaction } from '../db';
import type {
  BrowserProfileHealth,
  BrowserAuthenticationObservation,
  BrowserAuthenticationRequestRecord,
  BrowserAuthenticationRevalidation,
  BrowserSessionActionResult,
  BrowserSessionAction,
  BrowserSessionEvidenceObservation,
  BrowserSessionGrantRecord,
  BrowserSessionLeaseRecord,
  BrowserSessionLeaseRepository,
  BrowserSessionRequest,
  BrowserSessionRevocation,
  BrowserSessionRunnerHost,
  BrowserSessionUse,
  BrowserSessionRunnerLaunch,
  IsolatedBrowserRunnerMountPort,
} from './browser-session-broker';
import {
  ContainedBrowser,
  type BrowserAuthenticationSignal,
  type BrowserAuthenticationSnapshot,
  type BrowserAuthorization,
} from './contained-browser';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  UnprocessableError,
} from './errors';

interface BrowserSessionGrantRow {
  id: string;
  binding_id: string;
  workspace_id: string;
  external_provider: BrowserSessionGrantRecord['externalProvider'];
  run_id: string;
  story_id: string;
  purpose: string;
  profile_generation: number;
  allowed_origins: string[];
  allowed_actions: BrowserSessionGrantRecord['allowedActions'];
  maximum_concurrent_runners: number;
  expires_at: Date | string;
  evidence_contract: BrowserSessionGrantRecord['evidenceContract'];
  retention_mode: BrowserSessionGrantRecord['retentionMode'];
  retain_until: Date | string | null;
  destruction_policy: BrowserSessionGrantRecord['destructionPolicy'];
  state: BrowserSessionGrantRecord['state'];
  issued_at: Date | string;
  revoked_at: Date | string | null;
  revocation_reason: string | null;
}

interface BrowserSessionLeaseRow {
  id: string;
  grant_id: string;
  binding_id: string;
  workspace_id: string;
  external_provider: BrowserSessionLeaseRecord['externalProvider'];
  run_id: string;
  story_id: string;
  purpose: string;
  profile_generation: number;
  allowed_origins: string[];
  allowed_actions: BrowserSessionLeaseRecord['allowedActions'];
  maximum_concurrent_runners: number;
  evidence_contract: BrowserSessionLeaseRecord['evidenceContract'];
  retention_mode: BrowserSessionLeaseRecord['retentionMode'];
  retain_until: Date | string | null;
  destruction_policy: BrowserSessionLeaseRecord['destructionPolicy'];
  state: BrowserSessionLeaseRecord['state'];
  isolated_runner_id: string;
  issued_at: Date | string;
  expires_at: Date | string;
  last_heartbeat_at: Date | string;
  revoked_at: Date | string | null;
  revocation_reason: string | null;
}

interface BrowserProfilePolicyRow {
  id: string;
  workspace_id: string;
  external_provider: BrowserSessionGrantRecord['externalProvider'];
  profile_generation: number;
  allowed_origins: string[];
  lifecycle_state: 'pending' | 'active' | 'quarantined' | 'deleted';
  binding_status: 'active' | 'disabled' | 'invalid';
  provider_health: BrowserProfileHealth['provider'];
  session_health: BrowserProfileHealth['session'];
  health_observed_at: Date | string;
  retention_mode: BrowserSessionGrantRecord['retentionMode'];
  retain_until: Date | string | null;
  destruction_policy: BrowserSessionGrantRecord['destructionPolicy'];
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function nullableIso(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function grantRecord(row: BrowserSessionGrantRow): BrowserSessionGrantRecord {
  return {
    id: row.id,
    bindingId: row.binding_id,
    workspaceId: row.workspace_id,
    externalProvider: row.external_provider,
    runId: row.run_id,
    storyId: row.story_id,
    purpose: row.purpose,
    profileGeneration: Number(row.profile_generation),
    allowedOrigins: [...row.allowed_origins],
    allowedActions: [...row.allowed_actions],
    maximumConcurrentRunners: Number(row.maximum_concurrent_runners),
    expiresAt: iso(row.expires_at),
    evidenceContract: row.evidence_contract,
    retentionMode: row.retention_mode,
    retainUntil: nullableIso(row.retain_until),
    destructionPolicy: row.destruction_policy,
    state: row.state,
    issuedAt: iso(row.issued_at),
    revokedAt: nullableIso(row.revoked_at),
    revocationReason: row.revocation_reason,
  };
}

function leaseRecord(row: BrowserSessionLeaseRow): BrowserSessionLeaseRecord {
  return {
    id: row.id,
    grantId: row.grant_id,
    bindingId: row.binding_id,
    workspaceId: row.workspace_id,
    externalProvider: row.external_provider,
    runId: row.run_id,
    storyId: row.story_id,
    purpose: row.purpose,
    profileGeneration: Number(row.profile_generation),
    allowedOrigins: [...row.allowed_origins],
    allowedActions: [...row.allowed_actions],
    maximumConcurrentRunners: Number(row.maximum_concurrent_runners),
    expiresAt: iso(row.expires_at),
    evidenceContract: row.evidence_contract,
    retentionMode: row.retention_mode,
    retainUntil: nullableIso(row.retain_until),
    destructionPolicy: row.destruction_policy,
    state: row.state,
    runnerId: row.isolated_runner_id,
    issuedAt: iso(row.issued_at),
    lastHeartbeatAt: iso(row.last_heartbeat_at),
    revokedAt: nullableIso(row.revoked_at),
    revocationReason: row.revocation_reason,
  };
}

function digestEvidence(value: unknown): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

async function insertReceipt(
  client: PoolClient,
  bindingId: string,
  workspaceId: string,
  eventType: string,
  evidence: Record<string, unknown>,
  occurredAt: string,
): Promise<void> {
  await client.query(
    `INSERT INTO rorca.authority_provider_receipts
       (binding_id, workspace_id, event_type, evidence, evidence_digest, occurred_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
    [bindingId, workspaceId, eventType, JSON.stringify(evidence), digestEvidence(evidence), occurredAt],
  );
}

function leaseEvidence(
  lease: BrowserSessionLeaseRecord,
  schemaVersion: string,
  outcome: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion,
    leaseId: lease.id,
    grantId: lease.grantId,
    bindingId: lease.bindingId,
    workspaceId: lease.workspaceId,
    provider: lease.externalProvider,
    runId: lease.runId,
    storyId: lease.storyId,
    purpose: lease.purpose,
    profileGeneration: lease.profileGeneration,
    allowedOrigins: lease.allowedOrigins,
    allowedActions: lease.allowedActions,
    maximumConcurrentRunners: lease.maximumConcurrentRunners,
    expiresAt: lease.expiresAt,
    outcome,
    profileArtifact: '[isolated-runner-memory-mount]',
    secretMaterial: '[redacted]',
    ...extra,
  };
}

function isSubset(requested: readonly string[], allowed: readonly string[]): boolean {
  return requested.every((entry) => allowed.includes(entry));
}

function assertGrantIdentity(grant: BrowserSessionGrantRecord, request: BrowserSessionRequest): void {
  if (grant.bindingId !== request.bindingId
    || grant.workspaceId !== request.workspaceId
    || grant.externalProvider !== request.externalProvider
    || grant.runId !== request.runId
    || grant.storyId !== request.storyId
    || grant.purpose !== request.purpose
    || grant.profileGeneration !== request.profileGeneration) {
    throw new ForbiddenError('Browser session request does not match its authority grant');
  }
  if (!isSubset(request.allowedOrigins, grant.allowedOrigins)
    || !isSubset(request.allowedActions, grant.allowedActions)) {
    throw new ForbiddenError('Browser session request broadens its authority grant');
  }
}

function assertLeaseIdentity(
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
    throw new ForbiddenError('Browser session operation does not match its lease binding');
  }
}

export class PostgresBrowserSessionLeaseRepository implements BrowserSessionLeaseRepository {
  async createGrant(grant: BrowserSessionGrantRecord, healthStaleBefore: string): Promise<BrowserSessionGrantRecord> {
    return transaction(async (client) => {
      const profileResult = await client.query<BrowserProfilePolicyRow>(
        `SELECT id, workspace_id, external_provider, profile_generation, allowed_origins,
                lifecycle_state, binding_status, provider_health, session_health,
                health_observed_at, retention_mode, retain_until, destruction_policy
           FROM rorca.browser_profile_bindings
          WHERE id = $1
          FOR UPDATE`,
        [grant.bindingId],
      );
      const profile = profileResult.rows[0];
      if (!profile) throw new NotFoundError('Browser profile binding', grant.bindingId);
      if (profile.workspace_id !== grant.workspaceId || profile.external_provider !== grant.externalProvider) {
        throw new ForbiddenError('Browser session grant does not match the profile workspace and provider');
      }
      if (profile.profile_generation !== grant.profileGeneration) {
        throw new ConflictError('Browser session grant targets a stale profile generation');
      }
      if (!isSubset(grant.allowedOrigins, profile.allowed_origins)) {
        throw new ForbiddenError('Browser session grant broadens the profile origin policy');
      }
      if (profile.lifecycle_state !== 'active' || profile.binding_status !== 'active'
        || profile.provider_health !== 'healthy' || profile.session_health !== 'healthy') {
        throw new ForbiddenError('Browser session grant requires an active healthy profile');
      }
      if (Date.parse(iso(profile.health_observed_at)) < Date.parse(healthStaleBefore)) {
        throw new ConflictError('Browser session grant requires fresh profile health');
      }
      if (Date.parse(grant.expiresAt) <= Date.parse(grant.issuedAt)) {
        throw new ConflictError('Browser session grant is already expired');
      }

      const result = await client.query<BrowserSessionGrantRow>(
        `INSERT INTO rorca.authority_provider_grants (
           id, binding_id, workspace_id, external_provider, run_id, story_id, purpose,
           profile_generation, allowed_origins, allowed_actions, maximum_concurrent_runners,
           expires_at, evidence_contract, retention_mode, retain_until, destruction_policy,
           state, issued_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10::text[], $11,
           $12, $13::jsonb, $14, $15, $16, 'active', $17
         ) RETURNING *`,
        [
          grant.id,
          grant.bindingId,
          grant.workspaceId,
          grant.externalProvider,
          grant.runId,
          grant.storyId,
          grant.purpose,
          grant.profileGeneration,
          grant.allowedOrigins,
          grant.allowedActions,
          grant.maximumConcurrentRunners,
          grant.expiresAt,
          JSON.stringify(grant.evidenceContract),
          grant.retentionMode,
          grant.retainUntil,
          grant.destructionPolicy,
          grant.issuedAt,
        ],
      );
      return grantRecord(result.rows[0]!);
    });
  }

  async findGrant(grantId: string): Promise<BrowserSessionGrantRecord | null> {
    const row = await queryOne<BrowserSessionGrantRow>(
      'SELECT * FROM rorca.authority_provider_grants WHERE id = $1',
      [grantId],
    );
    return row ? grantRecord(row) : null;
  }

  async reserveLease(
    lease: BrowserSessionLeaseRecord,
    profileHealthStaleBefore: string,
    heartbeatStaleBefore: string,
  ): Promise<BrowserSessionLeaseRecord> {
    const outcome = await transaction(async (client): Promise<{ lease?: BrowserSessionLeaseRecord; error?: ConflictError }> => {
      const grantResult = await client.query<BrowserSessionGrantRow>(
        'SELECT * FROM rorca.authority_provider_grants WHERE id = $1 FOR UPDATE',
        [lease.grantId],
      );
      if (!grantResult.rows[0]) throw new NotFoundError('Browser session grant', lease.grantId);
      const grant = grantRecord(grantResult.rows[0]);
      assertGrantIdentity(grant, lease);

      if (grant.state !== 'active' || Date.parse(grant.expiresAt) <= Date.parse(lease.issuedAt)) {
        if (grant.state === 'active') {
          await client.query(
            `UPDATE rorca.authority_provider_grants
                SET state = 'expired', revoked_at = $2, revocation_reason = 'grant_expired'
              WHERE id = $1`,
            [grant.id, lease.issuedAt],
          );
        }
        return { error: new ConflictError('Browser session grant is expired or revoked') };
      }
      if (Date.parse(lease.expiresAt) > Date.parse(grant.expiresAt)) {
        throw new ForbiddenError('Browser session lease expiry broadens its authority grant');
      }

      const profileResult = await client.query<BrowserProfilePolicyRow>(
        `SELECT id, workspace_id, external_provider, profile_generation, allowed_origins,
                lifecycle_state, binding_status, provider_health, session_health,
                health_observed_at, retention_mode, retain_until, destruction_policy
           FROM rorca.browser_profile_bindings
          WHERE id = $1 AND workspace_id = $2
          FOR UPDATE`,
        [lease.bindingId, lease.workspaceId],
      );
      const profile = profileResult.rows[0];
      if (!profile) throw new NotFoundError('Browser profile binding', lease.bindingId);
      if (profile.external_provider !== lease.externalProvider) {
        throw new ForbiddenError('Browser session lease provider does not match its profile');
      }
      if (profile.profile_generation !== lease.profileGeneration) {
        throw new ConflictError('Browser session lease targets a stale profile generation');
      }
      if (!isSubset(lease.allowedOrigins, profile.allowed_origins)) {
        throw new ForbiddenError('Browser session lease broadens the profile origin policy');
      }
      if (profile.lifecycle_state !== 'active' || profile.binding_status !== 'active'
        || profile.provider_health !== 'healthy' || profile.session_health !== 'healthy') {
        throw new ForbiddenError('Browser session lease requires an active healthy profile');
      }
      if (Date.parse(iso(profile.health_observed_at)) < Date.parse(profileHealthStaleBefore)) {
        throw new ConflictError('Browser session lease requires fresh profile health');
      }

      const expired = await client.query<BrowserSessionLeaseRow>(
        `UPDATE rorca.authority_provider_leases
            SET state = 'uncertain', revoked_at = $2,
                revocation_reason = 'lease_expired_pending_reconciliation'
          WHERE binding_id = $1
            AND state IN ('provisioning', 'active')
            AND expires_at <= $2
        RETURNING *`,
        [lease.bindingId, lease.issuedAt],
      );
      if (expired.rows.length > 0) {
        await client.query(
          `UPDATE rorca.browser_profile_bindings
              SET provider_health = 'degraded', session_health = 'unknown', health_observed_at = $2
            WHERE id = $1`,
          [lease.bindingId, lease.issuedAt],
        );
        for (const row of expired.rows) {
          const expiredLease = leaseRecord(row);
          await insertReceipt(
            client,
            expiredLease.bindingId,
            expiredLease.workspaceId,
            'browser_lease_uncertain',
            leaseEvidence(expiredLease, 'rorca.browser-session-reconciliation.v1', 'lease_expired_pending_reconciliation'),
            lease.issuedAt,
          );
        }
        return { error: new ConflictError('Expired browser session runner reconciliation is required') };
      }

      const stale = await client.query<BrowserSessionLeaseRow>(
        `UPDATE rorca.authority_provider_leases
            SET state = 'uncertain', revoked_at = $3, revocation_reason = 'runner_heartbeat_lost'
          WHERE binding_id = $1
            AND state IN ('provisioning', 'active')
            AND expires_at > $3
            AND last_heartbeat_at < $2
        RETURNING *`,
        [lease.bindingId, heartbeatStaleBefore, lease.issuedAt],
      );
      if (stale.rows.length > 0) {
        await client.query(
          `UPDATE rorca.browser_profile_bindings
              SET provider_health = 'degraded', session_health = 'unknown', health_observed_at = $2
            WHERE id = $1`,
          [lease.bindingId, lease.issuedAt],
        );
        for (const row of stale.rows) {
          const staleLease = leaseRecord(row);
          await insertReceipt(
            client,
            staleLease.bindingId,
            staleLease.workspaceId,
            'browser_lease_uncertain',
            leaseEvidence(staleLease, 'rorca.browser-session-reconciliation.v1', 'heartbeat_lost'),
            lease.issuedAt,
          );
        }
        return { error: new ConflictError('Browser session runner reconciliation is required') };
      }

      const unresolved = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM rorca.authority_provider_leases
          WHERE binding_id = $1 AND state = 'uncertain'`,
        [lease.bindingId],
      );
      if (Number(unresolved.rows[0]?.count ?? 0) > 0) {
        return { error: new ConflictError('Browser session runner reconciliation is required') };
      }

      const active = await client.query<{ count: string; minimum_policy: number | null }>(
        `SELECT COUNT(*)::text AS count,
                MIN(maximum_concurrent_runners) AS minimum_policy
           FROM rorca.authority_provider_leases
          WHERE binding_id = $1
            AND state IN ('provisioning', 'active')
            AND expires_at > $2`,
        [lease.bindingId, lease.issuedAt],
      );
      const activeCount = Number(active.rows[0]?.count ?? 0);
      const existingPolicy = active.rows[0]?.minimum_policy;
      const effectiveLimit = existingPolicy === null || existingPolicy === undefined
        ? grant.maximumConcurrentRunners
        : Math.min(grant.maximumConcurrentRunners, Number(existingPolicy));
      if (activeCount >= effectiveLimit) {
        throw new ConflictError('Browser session grant concurrency policy is exhausted');
      }

      const result = await client.query<BrowserSessionLeaseRow>(
        `INSERT INTO rorca.authority_provider_leases (
           id, grant_id, binding_id, workspace_id, external_provider, run_id, story_id,
           purpose, profile_generation, allowed_origins, allowed_actions,
           maximum_concurrent_runners, evidence_contract, retention_mode, retain_until,
           destruction_policy, state, isolated_runner_id, issued_at, expires_at,
           last_heartbeat_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text[], $11::text[],
           $12, $13::jsonb, $14, $15, $16, 'provisioning', $17, $18, $19, $18
         ) RETURNING *`,
        [
          lease.id,
          lease.grantId,
          lease.bindingId,
          lease.workspaceId,
          lease.externalProvider,
          lease.runId,
          lease.storyId,
          lease.purpose,
          lease.profileGeneration,
          lease.allowedOrigins,
          lease.allowedActions,
          lease.maximumConcurrentRunners,
          JSON.stringify(lease.evidenceContract),
          lease.retentionMode,
          lease.retainUntil,
          lease.destructionPolicy,
          lease.runnerId,
          lease.issuedAt,
          lease.expiresAt,
        ],
      );
      const reserved = leaseRecord(result.rows[0]!);
      await insertReceipt(
        client,
        reserved.bindingId,
        reserved.workspaceId,
        'browser_lease_requested',
        leaseEvidence(reserved, 'rorca.browser-session-lease.v1', 'reserved'),
        reserved.issuedAt,
      );
      return { lease: reserved };
    });
    if (outcome.error) throw outcome.error;
    return outcome.lease!;
  }

  async activateLease(leaseId: string, activatedAt: string): Promise<BrowserSessionLeaseRecord> {
    return transaction(async (client) => {
      const result = await client.query<BrowserSessionLeaseRow>(
        `UPDATE rorca.authority_provider_leases
            SET state = 'active', last_heartbeat_at = $2
          WHERE id = $1 AND state = 'provisioning' AND expires_at > $2
        RETURNING *`,
        [leaseId, activatedAt],
      );
      if (!result.rows[0]) throw new ConflictError('Browser session lease could not be activated');
      const active = leaseRecord(result.rows[0]);
      await insertReceipt(
        client,
        active.bindingId,
        active.workspaceId,
        'browser_lease_issued',
        leaseEvidence(active, 'rorca.browser-session-lease.v1', 'active'),
        activatedAt,
      );
      return active;
    });
  }

  async authorizeUse(
    input: BrowserSessionUse,
    requestedOrigin: string | null,
    usedAt: string,
    heartbeatStaleBefore: string,
  ): Promise<BrowserSessionLeaseRecord> {
    const outcome = await transaction(async (client): Promise<{ lease?: BrowserSessionLeaseRecord; error?: Error }> => {
      const result = await client.query<BrowserSessionLeaseRow>(
        'SELECT * FROM rorca.authority_provider_leases WHERE id = $1 FOR UPDATE',
        [input.leaseId],
      );
      if (!result.rows[0]) throw new NotFoundError('Browser session lease', input.leaseId);
      let lease = leaseRecord(result.rows[0]);
      assertLeaseIdentity(lease, input);

      if (lease.state !== 'active') {
        throw new ConflictError('Browser session lease is not active', { state: lease.state });
      }
      if (Date.parse(lease.expiresAt) <= Date.parse(usedAt)) {
        const uncertain = await this.markUncertainInTransaction(
          client,
          lease,
          'lease_expired_pending_reconciliation',
          usedAt,
        );
        return {
          error: new ConflictError(
            'Browser session lease has expired and its runner requires reconciliation',
            { leaseId: uncertain.id },
          ),
        };
      }
      if (Date.parse(lease.lastHeartbeatAt) < Date.parse(heartbeatStaleBefore)) {
        const uncertain = await this.markUncertainInTransaction(client, lease, 'runner_heartbeat_lost', usedAt);
        return { error: new ConflictError('Browser session runner reconciliation is required', { leaseId: uncertain.id }) };
      }
      if (!lease.allowedActions.includes(input.action.type)) {
        await this.insertSecurityEventInTransaction(
          client,
          lease,
          'action_not_allowed',
          requestedOrigin,
          input.action.type,
          usedAt,
        );
        return { error: new ForbiddenError('Browser session action is outside the lease policy') };
      }
      if (requestedOrigin !== null && !lease.allowedOrigins.includes(requestedOrigin)) {
        await this.insertSecurityEventInTransaction(
          client,
          lease,
          'origin_not_allowlisted',
          requestedOrigin,
          input.action.type,
          usedAt,
        );
        return { error: new ForbiddenError('Browser session navigation is outside the exact origin allowlist') };
      }

      const heartbeat = await client.query<BrowserSessionLeaseRow>(
        'UPDATE rorca.authority_provider_leases SET last_heartbeat_at = $2 WHERE id = $1 RETURNING *',
        [lease.id, usedAt],
      );
      return { lease: leaseRecord(heartbeat.rows[0]!) };
    });
    if (outcome.error) throw outcome.error;
    return outcome.lease!;
  }

  async markUncertain(leaseId: string, reason: string, observedAt: string): Promise<BrowserSessionLeaseRecord> {
    return transaction(async (client) => {
      const result = await client.query<BrowserSessionLeaseRow>(
        'SELECT * FROM rorca.authority_provider_leases WHERE id = $1 FOR UPDATE',
        [leaseId],
      );
      if (!result.rows[0]) throw new NotFoundError('Browser session lease', leaseId);
      const lease = leaseRecord(result.rows[0]);
      if (lease.state === 'revoked' || lease.state === 'expired') return lease;
      return this.markUncertainInTransaction(client, lease, reason, observedAt);
    });
  }

  async beginRevocation(input: BrowserSessionRevocation, observedAt: string): Promise<BrowserSessionLeaseRecord> {
    return transaction(async (client) => {
      const result = await client.query<BrowserSessionLeaseRow>(
        'SELECT * FROM rorca.authority_provider_leases WHERE id = $1 FOR UPDATE',
        [input.leaseId],
      );
      if (!result.rows[0]) throw new NotFoundError('Browser session lease', input.leaseId);
      const lease = leaseRecord(result.rows[0]);
      assertLeaseIdentity(lease, input);
      if (lease.state === 'revoked' || lease.state === 'expired') return lease;
      const claimed = await client.query<BrowserSessionLeaseRow>(
        `UPDATE rorca.authority_provider_leases
            SET state = 'uncertain', revoked_at = $2, revocation_reason = 'revocation_in_progress'
          WHERE id = $1 RETURNING *`,
        [lease.id, observedAt],
      );
      return leaseRecord(claimed.rows[0]!);
    });
  }

  async completeRevocation(leaseId: string, reason: string, observedAt: string): Promise<BrowserSessionLeaseRecord> {
    return transaction(async (client) => {
      const result = await client.query<BrowserSessionLeaseRow>(
        `UPDATE rorca.authority_provider_leases
            SET state = 'revoked', revoked_at = $2, revocation_reason = $3
          WHERE id = $1 AND state IN ('provisioning', 'active', 'uncertain')
        RETURNING *`,
        [leaseId, observedAt, reason],
      );
      if (!result.rows[0]) {
        const existing = await client.query<BrowserSessionLeaseRow>(
          'SELECT * FROM rorca.authority_provider_leases WHERE id = $1',
          [leaseId],
        );
        if (!existing.rows[0]) throw new NotFoundError('Browser session lease', leaseId);
        return leaseRecord(existing.rows[0]);
      }
      const revoked = leaseRecord(result.rows[0]);
      await insertReceipt(
        client,
        revoked.bindingId,
        revoked.workspaceId,
        'browser_lease_revoked',
        leaseEvidence(revoked, 'rorca.browser-session-revocation.v1', 'revoked', { reason }),
        observedAt,
      );
      return revoked;
    });
  }

  async completeReconciliation(
    leaseId: string,
    health: BrowserProfileHealth,
    observedAt: string,
  ): Promise<BrowserSessionLeaseRecord> {
    return transaction(async (client) => {
      const result = await client.query<BrowserSessionLeaseRow>(
        `UPDATE rorca.authority_provider_leases
            SET state = 'revoked', revoked_at = $2, revocation_reason = 'runner_reconciled'
          WHERE id = $1 AND state = 'uncertain'
        RETURNING *`,
        [leaseId, observedAt],
      );
      if (!result.rows[0]) throw new ConflictError('Browser session lease is not awaiting reconciliation');
      const reconciled = leaseRecord(result.rows[0]);
      await client.query(
        `UPDATE rorca.browser_profile_bindings
            SET provider_health = $2, session_health = $3, health_observed_at = $4
          WHERE id = $1 AND profile_generation = $5`,
        [reconciled.bindingId, health.provider, health.session, health.observedAt, reconciled.profileGeneration],
      );
      await insertReceipt(
        client,
        reconciled.bindingId,
        reconciled.workspaceId,
        'browser_lease_reconciled',
        leaseEvidence(reconciled, 'rorca.browser-session-reconciliation.v1', 'terminated_and_health_observed', {
          providerHealth: health.provider,
          sessionHealth: health.session,
          healthObservedAt: health.observedAt,
        }),
        observedAt,
      );
      return reconciled;
    });
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
    await transaction(async (client) => {
      const result = await client.query<BrowserSessionLeaseRow>(
        'SELECT * FROM rorca.authority_provider_leases WHERE id = $1 FOR UPDATE',
        [input.leaseId],
      );
      if (!result.rows[0]) throw new NotFoundError('Browser session lease', input.leaseId);
      await this.insertSecurityEventInTransaction(
        client,
        leaseRecord(result.rows[0]),
        input.reason,
        input.requestedOrigin,
        input.effect,
        input.observedAt,
      );
    });
  }

  async findLease(leaseId: string): Promise<BrowserSessionLeaseRecord | null> {
    const row = await queryOne<BrowserSessionLeaseRow>(
      'SELECT * FROM rorca.authority_provider_leases WHERE id = $1',
      [leaseId],
    );
    return row ? leaseRecord(row) : null;
  }

  async listOpenLeases(bindingId: string, workspaceId: string): Promise<BrowserSessionLeaseRecord[]> {
    const rows = await query<BrowserSessionLeaseRow>(
      `SELECT * FROM rorca.authority_provider_leases
        WHERE binding_id = $1 AND workspace_id = $2
          AND state IN ('provisioning', 'active', 'uncertain')
        ORDER BY issued_at, id`,
      [bindingId, workspaceId],
    );
    return rows.map(leaseRecord);
  }

  async listOpenLeasesForBroker(): Promise<BrowserSessionLeaseRecord[]> {
    const rows = await query<BrowserSessionLeaseRow>(
      `SELECT * FROM rorca.authority_provider_leases
        WHERE state IN ('provisioning', 'active', 'uncertain')
        ORDER BY issued_at, id`,
    );
    return rows.map(leaseRecord);
  }

  async revokeOpenGrants(reason: string, observedAt: string): Promise<number> {
    return transaction(async (client) => {
      const result = await client.query(
        `UPDATE rorca.authority_provider_grants
            SET state = 'revoked', revoked_at = $1, revocation_reason = $2
          WHERE state = 'active'`,
        [observedAt, reason],
      );
      return result.rowCount ?? 0;
    });
  }

  private async markUncertainInTransaction(
    client: PoolClient,
    lease: BrowserSessionLeaseRecord,
    reason: string,
    observedAt: string,
  ): Promise<BrowserSessionLeaseRecord> {
    const result = await client.query<BrowserSessionLeaseRow>(
      `UPDATE rorca.authority_provider_leases
          SET state = 'uncertain', revoked_at = $2, revocation_reason = $3
        WHERE id = $1 RETURNING *`,
      [lease.id, observedAt, reason],
    );
    const uncertain = leaseRecord(result.rows[0]!);
    await client.query(
      `UPDATE rorca.browser_profile_bindings
          SET provider_health = 'degraded', session_health = 'unknown', health_observed_at = $2
        WHERE id = $1`,
      [uncertain.bindingId, observedAt],
    );
    await insertReceipt(
      client,
      uncertain.bindingId,
      uncertain.workspaceId,
      'browser_lease_uncertain',
      leaseEvidence(uncertain, 'rorca.browser-session-reconciliation.v1', reason),
      observedAt,
    );
    return uncertain;
  }

  private async insertSecurityEventInTransaction(
    client: PoolClient,
    lease: BrowserSessionLeaseRecord,
    reason:
      | 'action_not_allowed'
      | 'credential_extraction_attempt'
      | 'origin_not_allowlisted'
      | 'network_origin_not_allowlisted',
    requestedOrigin: string | null,
    effect: string,
    observedAt: string,
  ): Promise<void> {
    await insertReceipt(
      client,
      lease.bindingId,
      lease.workspaceId,
      'browser_security_denied',
      {
        schemaVersion: 'rorca.browser-session-security-event.v1',
        leaseId: lease.id,
        bindingId: lease.bindingId,
        workspaceId: lease.workspaceId,
        provider: lease.externalProvider,
        profileGeneration: lease.profileGeneration,
        reason,
        effect,
        requestedOriginDigest: requestedOrigin === null ? null : digestEvidence({ origin: requestedOrigin }),
        requestedOrigin: '[redacted]',
        secretMaterial: '[redacted]',
      },
      observedAt,
    );
  }
}

export class UnavailableBrowserSessionLeaseRepository implements BrowserSessionLeaseRepository {
  private unavailable(): never {
    throw new ServiceUnavailableError('Browser session lease persistence is not configured');
  }

  createGrant(): Promise<BrowserSessionGrantRecord> { return this.unavailable(); }
  findGrant(): Promise<BrowserSessionGrantRecord | null> { return this.unavailable(); }
  reserveLease(): Promise<BrowserSessionLeaseRecord> { return this.unavailable(); }
  activateLease(): Promise<BrowserSessionLeaseRecord> { return this.unavailable(); }
  authorizeUse(): Promise<BrowserSessionLeaseRecord> { return this.unavailable(); }
  markUncertain(): Promise<BrowserSessionLeaseRecord> { return this.unavailable(); }
  beginRevocation(): Promise<BrowserSessionLeaseRecord> { return this.unavailable(); }
  completeRevocation(): Promise<BrowserSessionLeaseRecord> { return this.unavailable(); }
  completeReconciliation(): Promise<BrowserSessionLeaseRecord> { return this.unavailable(); }
  recordSecurityEvent(): Promise<void> { return this.unavailable(); }
  findLease(): Promise<BrowserSessionLeaseRecord | null> { return this.unavailable(); }
  async listOpenLeases(): Promise<BrowserSessionLeaseRecord[]> { return []; }
  async listOpenLeasesForBroker(): Promise<BrowserSessionLeaseRecord[]> { return []; }
  async revokeOpenGrants(): Promise<number> { return 0; }
}

interface LocalRunnerInput {
  leaseId: string;
  runnerId: string;
  workspaceId: string;
  runId: string;
  storyId: string;
  purpose: string;
  bindingId: string;
  profileGeneration: number;
  allowedOrigins: readonly string[];
  allowedActions: BrowserSessionRunnerLaunch['allowedActions'];
  expiresAt: string;
  onSecurityEvent: BrowserSessionRunnerLaunch['onSecurityEvent'];
}

interface LocalRunnerState {
  input: LocalRunnerInput;
  browser: ContainedBrowser;
  mounted: boolean;
  securityDenied: boolean;
  authenticationSuspended: boolean;
  revalidatedRequestId: string | null;
  resumedRequestIds: Set<string>;
  checkpointDigest: `sha256:${string}` | null;
}

const BrowserRunnerCheckpointSchema = z.object({
  schemaVersion: z.literal('rorca.browser-runner-authentication-checkpoint.v1'),
  runnerId: z.string().uuid(),
  recoveryEndpoint: z.string().url(),
  checkpointDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/)
    .transform((value): `sha256:${string}` => value as `sha256:${string}`),
  input: z.object({
    leaseId: z.string().uuid(),
    workspaceId: z.string().min(1).max(255),
    runId: z.string().min(1).max(255),
    storyId: z.string().min(1).max(255),
    purpose: z.string().min(1).max(255),
    bindingId: z.string().uuid(),
    profileGeneration: z.number().int().positive(),
    allowedOrigins: z.array(z.string().url()).min(1).max(32),
    allowedActions: z.array(z.enum(['navigate', 'click', 'fill', 'select', 'check', 'readText', 'upload'])).min(1).max(7),
    expiresAt: z.string().datetime(),
  }).strict(),
  resumedRequestIds: z.array(z.string().uuid()).max(32),
}).strict();
type BrowserRunnerCheckpoint = z.infer<typeof BrowserRunnerCheckpointSchema>;

function profileStorageState(profileBytes: Buffer): Exclude<BrowserContextOptions['storageState'], string | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(profileBytes.toString('utf8'));
  } catch {
    throw new UnprocessableError(
      'Encrypted browser profile is not a supported in-memory browser storage state',
      'BROWSER_PROFILE_FORMAT_UNSUPPORTED',
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UnprocessableError('Encrypted browser profile storage state is invalid', 'BROWSER_PROFILE_FORMAT_UNSUPPORTED');
  }
  const state = parsed as { cookies?: unknown; origins?: unknown };
  if (!Array.isArray(state.cookies) || !Array.isArray(state.origins)) {
    throw new UnprocessableError('Encrypted browser profile storage state is invalid', 'BROWSER_PROFILE_FORMAT_UNSUPPORTED');
  }
  return parsed as Exclude<BrowserContextOptions['storageState'], string | undefined>;
}

function exactOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

function authenticationActionResult(
  snapshot: BrowserAuthenticationSnapshot,
  observedAt: string,
): Extract<BrowserSessionActionResult, { kind: 'authentication_required' }> | null {
  if (snapshot.signal === null) return null;
  if (snapshot.currentOrigin === null) {
    throw new UnprocessableError(
      'Observed browser authentication state has no safe provider origin',
      'BROWSER_AUTHENTICATION_ORIGIN_UNOBSERVED',
    );
  }
  const stepBySignal: Record<BrowserAuthenticationSignal, BrowserAuthenticationObservation['step']> = {
    login_prompt: 'login_expired',
    consent_prompt: 'consent',
    mfa_prompt: 'mfa',
    passkey_prompt: 'passkey',
    captcha_challenge: 'captcha',
    account_lock_notice: 'account_locked',
    provider_step_up_prompt: 'provider_step_up',
    anti_automation_notice: 'anti_automation',
  };
  return {
    kind: 'authentication_required',
    observation: {
      schemaVersion: 'rorca.browser-authentication-observation.v1',
      step: stepBySignal[snapshot.signal],
      observedAt,
      currentOrigin: snapshot.currentOrigin,
      signal: snapshot.signal,
      providerStateDigest: snapshot.providerStateDigest,
      accessibilityDigest: snapshot.accessibilityDigest,
      screenshotDigest: snapshot.screenshotDigest,
      automationPolicy: snapshot.signal === 'anti_automation_notice' ? 'prohibited' : 'human_only',
      redaction: 'required',
    },
  };
}

/**
 * Local trusted runner host. Profile bytes are parsed in memory and passed to a
 * fresh non-persistent Playwright context; no profile path or browser object is
 * exposed to the caller or model-facing action surface.
 */
export class LocalIsolatedBrowserSessionRunnerHost implements BrowserSessionRunnerHost {
  private readonly runners = new Map<string, LocalRunnerState>();
  private readonly quarantineRoot: string;
  private readonly checkpointRoot: string;
  private readonly evidenceRoot: string;

  constructor(private readonly options: {
    quarantineRoot?: string;
    checkpointRoot?: string;
    evidenceRoot?: string;
    headless?: boolean;
    now?: () => string;
    healthProbe?: (runnerId: string) => Promise<BrowserProfileHealth>;
    onRecoveredSecurityEvent?: (
      leaseId: string,
      event: Parameters<BrowserSessionRunnerLaunch['onSecurityEvent']>[0],
    ) => Promise<void>;
  } = {}) {
    this.quarantineRoot = options.quarantineRoot ?? path.join(os.tmpdir(), 'rorca-browser-session-runners');
    this.checkpointRoot = options.checkpointRoot ?? path.join(this.quarantineRoot, 'authentication-checkpoints');
    this.evidenceRoot = options.evidenceRoot ?? path.join(os.homedir(), '.rorca', 'browser-session-evidence');
  }

  async launch(input: BrowserSessionRunnerLaunch): Promise<IsolatedBrowserRunnerMountPort> {
    if (this.runners.has(input.runnerId)) throw new ConflictError('Browser runner identity is already allocated');
    const runnerInput: LocalRunnerInput = {
      leaseId: input.leaseId,
      runnerId: input.runnerId,
      workspaceId: input.workspaceId,
      runId: input.runId,
      storyId: input.storyId,
      purpose: input.purpose,
      bindingId: input.bindingId,
      profileGeneration: input.profileGeneration,
      allowedOrigins: [...input.allowedOrigins],
      allowedActions: [...input.allowedActions],
      expiresAt: input.expiresAt,
      onSecurityEvent: input.onSecurityEvent,
    };
    const browser = this.createBrowser(runnerInput);
    const state: LocalRunnerState = {
      input: runnerInput,
      browser,
      mounted: false,
      securityDenied: false,
      authenticationSuspended: false,
      revalidatedRequestId: null,
      resumedRequestIds: new Set(),
      checkpointDigest: null,
    };
    this.runners.set(input.runnerId, state);

    return {
      mountProfile: async (mount) => {
        const current = this.runners.get(input.runnerId);
        if (!current || current.mounted
          || mount.runnerId !== input.runnerId
          || mount.bindingId !== input.bindingId
          || mount.profileGeneration !== input.profileGeneration
          || mount.modelContextAccess !== 'none'
          || mount.filesystemAccess !== 'ephemeral-profile-only'
          || mount.artifactAccess !== 'redacted-only'
          || mount.allowedOrigins.length !== runnerInput.allowedOrigins.length
          || !mount.allowedOrigins.every((origin) => runnerInput.allowedOrigins.includes(origin))) {
          throw new ForbiddenError('Browser profile mount does not match its isolated runner lease');
        }
        const storageState = profileStorageState(mount.profileBytes);
        await current.browser.start(storageState);
        current.mounted = true;
      },
    };
  }

  async use(runnerId: string, action: BrowserSessionAction): Promise<BrowserSessionActionResult> {
    const runner = this.runners.get(runnerId);
    if (!runner?.mounted) throw new ServiceUnavailableError('Browser session runner is not active');
    if (runner.authenticationSuspended) {
      throw new ConflictError('Browser automation is suspended while operator authentication is pending');
    }
    if (Date.parse(runner.input.expiresAt) <= Date.parse(this.now())) {
      throw new ConflictError('Browser session runner lease has expired');
    }
    runner.securityDenied = false;
    const preflightAuthentication = authenticationActionResult(
      await runner.browser.observeAuthentication(),
      this.now(),
    );
    if (preflightAuthentication) return preflightAuthentication;
    try {
      const result = await runner.browser.act(action);
      const authentication = authenticationActionResult(
        await runner.browser.observeAuthentication(),
        this.now(),
      );
      if (authentication) return authentication;
      return {
        kind: 'completed',
        ...(typeof result === 'string' ? { result } : {}),
      };
    } catch (error) {
      if (runner.securityDenied) {
        throw new ForbiddenError('Browser runner blocked navigation outside the exact origin allowlist');
      }
      // A provider may redirect to a challenge before the requested selector
      // resolves. Prefer the observed typed wait over an incidental action
      // error, but preserve the original error if the page cannot be observed.
      try {
        const authentication = authenticationActionResult(
          await runner.browser.observeAuthentication(),
          this.now(),
        );
        if (authentication) return authentication;
      } catch (observationError) {
        if (observationError instanceof UnprocessableError) throw observationError;
      }
      throw error;
    }
  }

  async captureEvidence(runnerId: string): Promise<BrowserSessionEvidenceObservation> {
    const runner = await this.requireRunner(runnerId);
    if (!runner.mounted || runner.authenticationSuspended) {
      throw new ConflictError('Browser evidence capture requires active, unsuspended automation');
    }
    const capture = await runner.browser.captureRedactedEvidence();
    const captureId = crypto.randomUUID();
    const screenshotArtifactId = `browser-evidence:${captureId}:screenshot`;
    const accessibilityArtifactId = `browser-evidence:${captureId}:accessibility`;
    await fs.mkdir(this.evidenceRoot, { recursive: true, mode: 0o700 });
    const screenshotPath = path.join(this.evidenceRoot, `${captureId}.png`);
    const accessibilityPath = path.join(this.evidenceRoot, `${captureId}.aria.txt`);
    try {
      await fs.writeFile(screenshotPath, capture.screenshot, { mode: 0o600, flag: 'wx' });
      try {
        await fs.writeFile(accessibilityPath, capture.accessibilitySnapshot, {
          encoding: 'utf8',
          mode: 0o600,
          flag: 'wx',
        });
      } catch (error) {
        await fs.rm(screenshotPath, { force: true });
        throw error;
      }
      return {
        observedAt: this.now(),
        currentOrigin: capture.currentOrigin,
        screenshot: {
          artifactId: screenshotArtifactId,
          digest: capture.screenshotDigest,
          mediaType: 'image/png',
        },
        accessibilitySnapshot: {
          artifactId: accessibilityArtifactId,
          digest: capture.accessibilityDigest,
          mediaType: 'text/aria-snapshot',
        },
        networkMetadata: capture.networkMetadata,
        providerStateDigest: capture.providerStateDigest,
        authenticatedSessionObserved: capture.authenticatedSessionObserved,
        redaction: capture.redaction,
      };
    } finally {
      capture.screenshot.fill(0);
    }
  }

  async suspendForAuthentication(
    runnerId: string,
    observation: BrowserAuthenticationObservation,
  ): Promise<{ checkpointDigest: `sha256:${string}` }> {
    const runner = this.runners.get(runnerId);
    if (!runner?.mounted) throw new ServiceUnavailableError('Browser session runner is not active');
    if (!runner.input.allowedOrigins.includes(observation.currentOrigin)) {
      throw new ForbiddenError('Browser authentication observation is outside the lease origin policy');
    }
    if (runner.authenticationSuspended && runner.checkpointDigest !== null) {
      return { checkpointDigest: runner.checkpointDigest };
    }
    runner.browser.suspendAutomation();
    runner.authenticationSuspended = true;
    const checkpointIdentity = {
      schemaVersion: 'rorca.browser-runner-authentication-checkpoint.v1',
      runnerId,
      leaseId: runner.input.leaseId,
      bindingId: runner.input.bindingId,
      profileGeneration: runner.input.profileGeneration,
      recoveryEndpoint: runner.browser.recoveryEndpoint(),
    };
    runner.checkpointDigest = `sha256:${crypto.createHash('sha256')
      .update(JSON.stringify(checkpointIdentity))
      .digest('hex')}`;
    await this.writeCheckpoint(runner);
    return { checkpointDigest: runner.checkpointDigest };
  }

  async revalidateAuthentication(
    runnerId: string,
    request: BrowserAuthenticationRequestRecord,
  ): Promise<BrowserAuthenticationRevalidation> {
    const runner = await this.requireRunner(runnerId);
    this.assertAuthenticationIdentity(runner, request);
    const snapshot = await runner.browser.observeAuthentication();
    const observedAt = this.now();
    const currentOrigin = snapshot.currentOrigin ?? request.evidence.currentOrigin;
    const allowedOrigin = snapshot.currentOrigin !== null
      && runner.input.allowedOrigins.includes(snapshot.currentOrigin);
    const challengePresent = snapshot.signal !== null;
    const healthy = !challengePresent && snapshot.authenticatedSessionObserved && allowedOrigin;
    const accountLocked = snapshot.signal === 'account_lock_notice';
    const loginExpired = snapshot.signal === 'login_prompt';
    const health: BrowserProfileHealth = {
      provider: accountLocked ? 'locked' : healthy ? 'healthy' : 'degraded',
      session: healthy ? 'healthy' : loginExpired ? 'expired' : 'unknown',
      observedAt,
    };
    if (healthy) runner.revalidatedRequestId = request.requestId;
    else runner.revalidatedRequestId = null;
    return {
      schemaVersion: 'rorca.browser-authentication-revalidation.v1',
      observedAt,
      currentOrigin,
      providerStateDigest: snapshot.providerStateDigest,
      accessibilityDigest: snapshot.accessibilityDigest,
      challengePresent,
      health,
      redaction: 'required',
    };
  }

  async resumeAfterAuthentication(runnerId: string, requestId: string): Promise<'resumed' | 'already_resumed'> {
    const runner = await this.requireRunner(runnerId);
    if (runner.resumedRequestIds.has(requestId)) {
      runner.browser.resumeAutomation();
      runner.authenticationSuspended = false;
      return 'already_resumed';
    }
    if (runner.revalidatedRequestId !== requestId) {
      throw new ForbiddenError('Browser automation cannot resume without matching healthy provider revalidation');
    }
    runner.resumedRequestIds.add(requestId);
    runner.authenticationSuspended = false;
    try {
      // Persist the once-only fence before re-enabling automation. A failed
      // checkpoint write must leave this live runner suspended and retryable.
      await this.writeCheckpoint(runner);
    } catch (error) {
      runner.resumedRequestIds.delete(requestId);
      runner.authenticationSuspended = true;
      throw error;
    }
    runner.browser.resumeAutomation();
    return 'resumed';
  }

  async terminate(runnerId: string): Promise<'terminated' | 'uncertain'> {
    let runner: LocalRunnerState | null | undefined = this.runners.get(runnerId);
    if (!runner) {
      try {
        runner = await this.recoverRunner(runnerId);
      } catch {
        return 'uncertain';
      }
    }
    if (!runner) return 'terminated';
    try {
      await runner.browser.stop();
      return 'terminated';
    } catch {
      return 'uncertain';
    }
  }

  async clearEphemeralState(runnerId: string): Promise<void> {
    const runner = this.runners.get(runnerId);
    if (runner) await runner.browser.stop();
    this.runners.delete(runnerId);
    await fs.rm(this.checkpointPath(runnerId), { force: true });
  }

  async reconcile(runnerId: string): Promise<{ termination: 'terminated' | 'uncertain'; health: BrowserProfileHealth }> {
    const termination = await this.terminate(runnerId);
    const health = this.options.healthProbe
      ? await this.options.healthProbe(runnerId)
      : { provider: 'degraded' as const, session: 'unknown' as const, observedAt: this.now() };
    return { termination, health };
  }

  private createBrowser(input: LocalRunnerInput): ContainedBrowser {
    const authorization: BrowserAuthorization = {
      authorize: async ({ effect, url }) => {
        if (effect === 'upload') return false;
        const origin = exactOrigin(url);
        if (origin !== null && input.allowedOrigins.includes(origin)) return true;
        const runner = this.runners.get(input.runnerId);
        if (runner) runner.securityDenied = true;
        await input.onSecurityEvent({
          reason: 'network_origin_not_allowlisted',
          requestedOrigin: origin,
          effect,
        });
        return false;
      },
      resolveAdmittedArtifact: async () => undefined,
    };
    return new ContainedBrowser({
      programId: input.workspaceId,
      missionId: input.runId,
      accountId: input.bindingId,
      role: input.storyId,
    }, authorization, this.quarantineRoot, { headless: this.options.headless ?? false });
  }

  private async requireRunner(runnerId: string): Promise<LocalRunnerState> {
    const existing = this.runners.get(runnerId);
    if (existing) return existing;
    const recovered = await this.recoverRunner(runnerId);
    if (!recovered) throw new ServiceUnavailableError('Browser authentication checkpoint is unavailable');
    return recovered;
  }

  private async recoverRunner(runnerId: string): Promise<LocalRunnerState | null> {
    const checkpoint = await this.readCheckpoint(runnerId);
    if (!checkpoint) return null;
    const onSecurityEvent: BrowserSessionRunnerLaunch['onSecurityEvent'] = async (event) => {
      if (!this.options.onRecoveredSecurityEvent) {
        throw new ServiceUnavailableError('Recovered browser runner has no security evidence sink');
      }
      await this.options.onRecoveredSecurityEvent(checkpoint.input.leaseId, event);
    };
    const input: LocalRunnerInput = {
      runnerId: checkpoint.runnerId,
      ...checkpoint.input,
      onSecurityEvent,
    };
    const browser = this.createBrowser(input);
    await browser.recover(checkpoint.recoveryEndpoint);
    const state: LocalRunnerState = {
      input,
      browser,
      mounted: true,
      securityDenied: false,
      authenticationSuspended: true,
      revalidatedRequestId: null,
      resumedRequestIds: new Set(checkpoint.resumedRequestIds),
      checkpointDigest: checkpoint.checkpointDigest,
    };
    this.runners.set(runnerId, state);
    return state;
  }

  private assertAuthenticationIdentity(
    runner: LocalRunnerState,
    request: BrowserAuthenticationRequestRecord,
  ): void {
    if (runner.input.leaseId !== request.leaseId
      || runner.input.workspaceId !== request.workspaceId
      || runner.input.runId !== request.runId
      || runner.input.storyId !== request.storyId
      || runner.input.purpose !== request.purpose
      || runner.input.bindingId !== request.bindingId
      || runner.input.profileGeneration !== request.profileGeneration
      || runner.checkpointDigest !== request.checkpointDigest) {
      throw new ForbiddenError('Recovered browser position does not match the authentication request');
    }
  }

  private async writeCheckpoint(runner: LocalRunnerState): Promise<void> {
    if (runner.checkpointDigest === null) {
      throw new ConflictError('Browser authentication checkpoint identity is not initialized');
    }
    const checkpoint: BrowserRunnerCheckpoint = {
      schemaVersion: 'rorca.browser-runner-authentication-checkpoint.v1',
      runnerId: runner.input.runnerId,
      recoveryEndpoint: runner.browser.recoveryEndpoint(),
      checkpointDigest: runner.checkpointDigest,
      input: {
        leaseId: runner.input.leaseId,
        workspaceId: runner.input.workspaceId,
        runId: runner.input.runId,
        storyId: runner.input.storyId,
        purpose: runner.input.purpose,
        bindingId: runner.input.bindingId,
        profileGeneration: runner.input.profileGeneration,
        allowedOrigins: [...runner.input.allowedOrigins],
        allowedActions: [...runner.input.allowedActions],
        expiresAt: runner.input.expiresAt,
      },
      resumedRequestIds: [...runner.resumedRequestIds],
    };
    BrowserRunnerCheckpointSchema.parse(checkpoint);
    await fs.mkdir(this.checkpointRoot, { recursive: true, mode: 0o700 });
    const target = this.checkpointPath(runner.input.runnerId);
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(checkpoint), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, target);
  }

  private async readCheckpoint(runnerId: string): Promise<BrowserRunnerCheckpoint | null> {
    try {
      const content = await fs.readFile(this.checkpointPath(runnerId), 'utf8');
      const checkpoint = BrowserRunnerCheckpointSchema.parse(JSON.parse(content));
      if (checkpoint.runnerId !== runnerId) {
        throw new ForbiddenError('Browser authentication checkpoint runner identity mismatch');
      }
      return checkpoint;
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  private checkpointPath(runnerId: string): string {
    return path.join(this.checkpointRoot, `${z.string().uuid().parse(runnerId)}.json`);
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }
}
