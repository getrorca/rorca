/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { queryOne, transaction } from '../db';
import type {
  BrowserAuthenticationOutcomeCode,
  BrowserAuthenticationRequestRecord,
  BrowserAuthenticationRequestRepository,
  BrowserAuthenticationRequestState,
  BrowserAuthenticationRevalidation,
  BrowserAuthenticationStep,
  BrowserExternalProvider,
} from './browser-session-broker';
import { ConflictError, ForbiddenError, NotFoundError } from './errors';

interface BrowserAuthenticationRequestRow {
  id: string;
  lease_id: string;
  binding_id: string;
  workspace_id: string;
  external_provider: BrowserExternalProvider;
  run_id: string;
  story_id: string;
  purpose: string;
  profile_generation: number;
  step_type: BrowserAuthenticationStep;
  evidence: BrowserAuthenticationRequestRecord['evidence'];
  takeover_checkpoint_digest: `sha256:${string}`;
  state: BrowserAuthenticationRequestState;
  disposition: BrowserAuthenticationRequestRecord['disposition'];
  outcome_code: BrowserAuthenticationOutcomeCode | null;
  run_pause_owned: boolean;
  resume_count: 0 | 1;
  detected_at: Date | string;
  authentication_expires_at: Date | string;
  resolution_observation: BrowserAuthenticationRevalidation | null;
  resolved_by: string | null;
  resolved_at: Date | string | null;
  resumed_at: Date | string | null;
}

interface BrowserAuthenticationLeaseRow {
  id: string;
  binding_id: string;
  workspace_id: string;
  external_provider: BrowserExternalProvider;
  run_id: string;
  story_id: string;
  purpose: string;
  profile_generation: number;
  state: string;
  expires_at: Date | string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function nullableIso(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function record(row: BrowserAuthenticationRequestRow): BrowserAuthenticationRequestRecord {
  return {
    requestId: row.id,
    leaseId: row.lease_id,
    bindingId: row.binding_id,
    workspaceId: row.workspace_id,
    externalProvider: row.external_provider,
    runId: row.run_id,
    storyId: row.story_id,
    purpose: row.purpose,
    profileGeneration: row.profile_generation,
    step: row.step_type,
    evidence: row.evidence,
    checkpointDigest: row.takeover_checkpoint_digest,
    detectedAt: iso(row.detected_at),
    authenticationExpiresAt: iso(row.authentication_expires_at),
    state: row.state,
    disposition: row.disposition,
    outcomeCode: row.outcome_code,
    runPauseOwned: row.run_pause_owned,
    resumeCount: row.resume_count,
    resolutionObservation: row.resolution_observation,
    resolvedBy: row.resolved_by,
    resolvedAt: nullableIso(row.resolved_at),
    resumedAt: nullableIso(row.resumed_at),
  };
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function assertLeaseIdentity(lease: BrowserAuthenticationLeaseRow, request: BrowserAuthenticationRequestRecord): void {
  if (lease.binding_id !== request.bindingId
    || lease.workspace_id !== request.workspaceId
    || lease.external_provider !== request.externalProvider
    || lease.run_id !== request.runId
    || lease.story_id !== request.storyId
    || lease.purpose !== request.purpose
    || lease.profile_generation !== request.profileGeneration) {
    throw new ForbiddenError('Browser authentication request does not match its lease binding');
  }
}

async function insertReceipt(
  client: PoolClient,
  request: BrowserAuthenticationRequestRecord,
  eventType: 'browser_authentication_requested'
    | 'browser_authentication_revalidating'
    | 'browser_authentication_resumed'
    | 'browser_authentication_terminal',
  observedAt: string,
): Promise<void> {
  const evidence = {
    schemaVersion: 'rorca.browser-authentication-receipt.v1',
    requestId: request.requestId,
    leaseId: request.leaseId,
    bindingId: request.bindingId,
    workspaceId: request.workspaceId,
    runId: request.runId,
    provider: request.externalProvider,
    state: request.state,
    outcomeCode: request.outcomeCode,
    observationDigest: digest(request.evidence),
    resolutionObservationDigest: request.resolutionObservation === null
      ? null
      : digest(request.resolutionObservation),
    secretMaterial: '[redacted]',
  };
  await client.query(
    `INSERT INTO rorca.authority_provider_receipts (
       binding_id, workspace_id, event_type, evidence, evidence_digest, occurred_at
     ) VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
    [request.bindingId, request.workspaceId, eventType, JSON.stringify(evidence), digest(evidence), observedAt],
  );
}

export class PostgresBrowserAuthenticationRequestRepository implements BrowserAuthenticationRequestRepository {
  async createWait(request: BrowserAuthenticationRequestRecord): Promise<BrowserAuthenticationRequestRecord> {
    try {
      return await transaction(async (client) => {
        const leaseResult = await client.query<BrowserAuthenticationLeaseRow>(
          `SELECT id, binding_id, workspace_id, external_provider, run_id, story_id,
                  purpose, profile_generation, state, expires_at
             FROM rorca.authority_provider_leases
            WHERE id = $1
            FOR UPDATE`,
          [request.leaseId],
        );
        const lease = leaseResult.rows[0];
        if (!lease) throw new NotFoundError('Browser session lease', request.leaseId);
        assertLeaseIdentity(lease, request);
        if (lease.state !== 'active') {
          throw new ConflictError('Browser authentication wait requires an active lease', { state: lease.state });
        }
        if (Date.parse(request.detectedAt) >= Date.parse(iso(lease.expires_at))) {
          throw new ConflictError('Browser authentication wait cannot start after lease expiry');
        }
        if (Date.parse(request.authenticationExpiresAt) <= Date.parse(request.detectedAt)
          || Date.parse(request.authenticationExpiresAt) > Date.parse(iso(lease.expires_at))) {
          throw new ConflictError('Browser authentication expiry must be future and bounded by the lease');
        }

        const openResult = await client.query<{ id: string }>(
          `SELECT id
             FROM rorca.browser_authentication_requests
            WHERE workspace_id = $1 AND run_id = $2
              AND state IN ('WAITING_FOR_AUTHENTICATION', 'REVALIDATING')
            FOR UPDATE`,
          [request.workspaceId, request.runId],
        );
        if (openResult.rows.length > 0) {
          throw new ConflictError('The run is already waiting for browser authentication');
        }

        const paused = await client.query(
          `UPDATE rorca.pipeline_runs
              SET status = 'paused'
            WHERE id::text = $1 AND workspace_id = $2 AND status = 'running'`,
          [request.runId, request.workspaceId],
        );
        const runPauseOwned = paused.rowCount === 1;
        const inserted = await client.query<BrowserAuthenticationRequestRow>(
          `INSERT INTO rorca.browser_authentication_requests (
             id, lease_id, binding_id, workspace_id, external_provider, run_id,
             story_id, purpose, profile_generation, step_type, evidence,
             evidence_digest, takeover_checkpoint_digest, state, run_pause_owned,
             detected_at, authentication_expires_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb,
             $12, $13, 'WAITING_FOR_AUTHENTICATION', $14, $15, $16
           ) RETURNING *`,
          [
            request.requestId,
            request.leaseId,
            request.bindingId,
            request.workspaceId,
            request.externalProvider,
            request.runId,
            request.storyId,
            request.purpose,
            request.profileGeneration,
            request.step,
            JSON.stringify(request.evidence),
            digest(request.evidence),
            request.checkpointDigest,
            runPauseOwned,
            request.detectedAt,
            request.authenticationExpiresAt,
          ],
        );
        const created = record(inserted.rows[0]!);
        await insertReceipt(client, created, 'browser_authentication_requested', request.detectedAt);
        return created;
      });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
        throw new ConflictError('The lease or run is already waiting for browser authentication');
      }
      throw error;
    }
  }

  async findById(requestId: string): Promise<BrowserAuthenticationRequestRecord | null> {
    const row = await queryOne<BrowserAuthenticationRequestRow>(
      'SELECT * FROM rorca.browser_authentication_requests WHERE id = $1',
      [requestId],
    );
    return row ? record(row) : null;
  }

  async findOpenForRun(workspaceId: string, runId: string): Promise<BrowserAuthenticationRequestRecord | null> {
    const row = await queryOne<BrowserAuthenticationRequestRow>(
      `SELECT *
         FROM rorca.browser_authentication_requests
        WHERE workspace_id = $1 AND run_id = $2
          AND state IN ('WAITING_FOR_AUTHENTICATION', 'REVALIDATING')
        ORDER BY detected_at DESC
        LIMIT 1`,
      [workspaceId, runId],
    );
    return row ? record(row) : null;
  }

  async findLatestForRun(workspaceId: string, runId: string): Promise<BrowserAuthenticationRequestRecord | null> {
    const row = await queryOne<BrowserAuthenticationRequestRow>(
      `SELECT *
         FROM rorca.browser_authentication_requests
        WHERE workspace_id = $1 AND run_id = $2
        ORDER BY detected_at DESC
        LIMIT 1`,
      [workspaceId, runId],
    );
    return row ? record(row) : null;
  }

  async claimForRevalidation(
    requestId: string,
    workspaceId: string,
    runId: string,
    operatorId: string,
    observedAt: string,
  ): Promise<BrowserAuthenticationRequestRecord> {
    return transaction(async (client) => {
      const currentResult = await client.query<BrowserAuthenticationRequestRow>(
        'SELECT * FROM rorca.browser_authentication_requests WHERE id = $1 FOR UPDATE',
        [requestId],
      );
      const currentRow = currentResult.rows[0];
      if (!currentRow) throw new NotFoundError('Browser authentication request', requestId);
      const current = record(currentRow);
      if (current.workspaceId !== workspaceId || current.runId !== runId) {
        throw new ForbiddenError('Browser authentication resolution does not match its run');
      }
      if (current.state === 'REVALIDATING') return current;
      if (current.state !== 'WAITING_FOR_AUTHENTICATION') {
        throw new ConflictError('Browser authentication request is already settled', {
          state: current.state,
          outcomeCode: current.outcomeCode,
        });
      }
      if (Date.parse(current.authenticationExpiresAt) <= Date.parse(observedAt)) {
        throw new ConflictError('Browser authentication request has expired', { state: 'EXPIRED' });
      }
      const updated = await client.query<BrowserAuthenticationRequestRow>(
        `UPDATE rorca.browser_authentication_requests
            SET state = 'REVALIDATING', resolved_by = $2
          WHERE id = $1 AND state = 'WAITING_FOR_AUTHENTICATION'
        RETURNING *`,
        [requestId, operatorId],
      );
      const claimed = record(updated.rows[0]!);
      await insertReceipt(client, claimed, 'browser_authentication_revalidating', observedAt);
      return claimed;
    });
  }

  async settle(input: {
    requestId: string;
    workspaceId: string;
    runId: string;
    expectedStates: readonly Extract<BrowserAuthenticationRequestState, 'WAITING_FOR_AUTHENTICATION' | 'REVALIDATING'>[];
    state: Exclude<BrowserAuthenticationRequestState, 'WAITING_FOR_AUTHENTICATION' | 'REVALIDATING'>;
    disposition: BrowserAuthenticationRequestRecord['disposition'] & string;
    outcomeCode: BrowserAuthenticationOutcomeCode;
    resolutionObservation: BrowserAuthenticationRevalidation | null;
    resolvedBy: string;
    resolvedAt: string;
  }): Promise<BrowserAuthenticationRequestRecord> {
    return transaction(async (client) => {
      const currentResult = await client.query<BrowserAuthenticationRequestRow>(
        'SELECT * FROM rorca.browser_authentication_requests WHERE id = $1 FOR UPDATE',
        [input.requestId],
      );
      const currentRow = currentResult.rows[0];
      if (!currentRow) throw new NotFoundError('Browser authentication request', input.requestId);
      const current = record(currentRow);
      if (current.workspaceId !== input.workspaceId || current.runId !== input.runId) {
        throw new ForbiddenError('Browser authentication settlement does not match its run');
      }
      if (!input.expectedStates.includes(current.state as 'WAITING_FOR_AUTHENTICATION' | 'REVALIDATING')) {
        if (current.state === input.state && current.outcomeCode === input.outcomeCode) return current;
        throw new ConflictError('Browser authentication settlement lost its state fence', {
          state: current.state,
          outcomeCode: current.outcomeCode,
        });
      }

      const resumed = input.state === 'RESUMED';
      const updated = await client.query<BrowserAuthenticationRequestRow>(
        `UPDATE rorca.browser_authentication_requests
            SET state = $2,
                disposition = $3,
                outcome_code = $4,
                resolution_observation = $5::jsonb,
                resolved_by = $6,
                resolved_at = $7,
                resumed_at = CASE WHEN $2 = 'RESUMED' THEN $7::timestamptz ELSE NULL END,
                resume_count = CASE WHEN $2 = 'RESUMED' THEN 1 ELSE 0 END
          WHERE id = $1 AND state = ANY($8::text[])
        RETURNING *`,
        [
          input.requestId,
          input.state,
          input.disposition,
          input.outcomeCode,
          input.resolutionObservation === null ? null : JSON.stringify(input.resolutionObservation),
          input.resolvedBy,
          input.resolvedAt,
          input.expectedStates,
        ],
      );
      if (!updated.rows[0]) throw new ConflictError('Browser authentication settlement lost its state fence');
      const settled = record(updated.rows[0]);
      if (settled.resolutionObservation !== null) {
        await client.query(
          `UPDATE rorca.browser_profile_bindings
              SET provider_health = $2, session_health = $3, health_observed_at = $4
            WHERE id = $1 AND workspace_id = $5`,
          [
            settled.bindingId,
            settled.resolutionObservation.health.provider,
            settled.resolutionObservation.health.session,
            settled.resolutionObservation.health.observedAt,
            settled.workspaceId,
          ],
        );
      }
      if (resumed) {
        await client.query(
          `UPDATE rorca.authority_provider_leases
              SET last_heartbeat_at = $2
            WHERE id = $1 AND last_heartbeat_at <= $2 AND expires_at >= $2`,
          [settled.leaseId, input.resolvedAt],
        );
      }
      if (settled.runPauseOwned) {
        await client.query(
          `UPDATE rorca.pipeline_runs
              SET status = 'running'
            WHERE id::text = $1 AND workspace_id = $2 AND status = 'paused'`,
          [settled.runId, settled.workspaceId],
        );
      }
      await insertReceipt(
        client,
        settled,
        resumed ? 'browser_authentication_resumed' : 'browser_authentication_terminal',
        input.resolvedAt,
      );
      return settled;
    });
  }
}

export class UnavailableBrowserAuthenticationRequestRepository implements BrowserAuthenticationRequestRepository {
  private unavailable(): never {
    throw new ConflictError('Durable browser authentication waits require the PostgreSQL authority repository');
  }

  async createWait(_request: BrowserAuthenticationRequestRecord): Promise<BrowserAuthenticationRequestRecord> { return this.unavailable(); }
  async findById(_requestId: string): Promise<BrowserAuthenticationRequestRecord | null> { return this.unavailable(); }
  async findOpenForRun(_workspaceId: string, _runId: string): Promise<BrowserAuthenticationRequestRecord | null> { return this.unavailable(); }
  async findLatestForRun(_workspaceId: string, _runId: string): Promise<BrowserAuthenticationRequestRecord | null> { return this.unavailable(); }
  async claimForRevalidation(
    _requestId: string,
    _workspaceId: string,
    _runId: string,
    _operatorId: string,
    _observedAt: string,
  ): Promise<BrowserAuthenticationRequestRecord> { return this.unavailable(); }
  async settle(_input: Parameters<BrowserAuthenticationRequestRepository['settle']>[0]): Promise<BrowserAuthenticationRequestRecord> {
    return this.unavailable();
  }
}
