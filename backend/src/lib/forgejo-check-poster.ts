/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Restart-safe, exact-SHA Forgejo commit-status projection (W5-004). Mirrors
 * `check-run-poster.ts` over Forgejo commit statuses: context
 * `rorca/pipeline`, pending/success/failure via
 * POST /repos/{owner}/{repo}/statuses/{sha}, WAL-driven
 * (run_started/run_finished), 30s reconcile, idempotent replay, and
 * authority records required. An optional Forgejo Actions check-run backend
 * implements the same projection interface behind capability detection.
 */

import { createHash, randomUUID } from 'crypto';
import {
  broadcastAll,
  subscribeDurable,
  type WalEvent,
} from './sse-hub';
import { query, queryOne, transaction } from '../db/index';
import {
  fetchForgejoWithTimeout,
  getWorkspaceForgejoCredential,
  resolveWorkspaceForgejoToken,
  scopeForgejoWorkspace,
  type ResolvedForgejoToken,
} from './forgejo-token-credential-provider';
import { forgejoRepoApiUrl, isFullForgejoObjectId } from './forgejo-repository-authority';
import {
  extractForgejoProviderError,
  formatForgejoProviderError,
  sanitizeForgejoProviderException,
} from './forgejo-provider-error';
import {
  authorizeCanonicalWalEvent,
  authorizeCompleteTerminalRun,
  type CompleteTerminalRun,
} from './github-poster-authority';
import { ConflictError } from './errors';
import { withForgejoRepositoryAuthorityLock } from './forgejo-release-identity';
import { assertCanonicalRunCheckout } from './run-git-authority';
import { logger } from './logger';

interface ProjectionPayload {
  runId: number;
  state: 'pending' | 'success' | 'failure';
  description: string;
}

interface ProjectionRow {
  run_id: number | string;
  workspace_id: string;
  spec_id: string;
  desired_event_id: number;
  desired_event_identity_hash: string;
  desired_state: 'in_progress' | 'completed';
  head_sha: string;
  conclusion: 'success' | 'failure' | 'neutral' | null;
  desired_payload: ProjectionPayload | string;
  desired_payload_hash: string;
  external_id: string;
  projection_status: 'pending' | 'processing' | 'retry' | 'uncertain' | 'projected' | 'completed' | 'blocked';
  provider_status_id: number | string | null;
  provider_head_sha: string | null;
  claim_token: string | null;
  claimed_at: string | null;
  attempts: number;
  next_attempt_at: string | null;
  repository_owner: string;
  repository_name: string;
  repository_binding_id: string | null;
  repository_id: number | string | null;
}

interface ProjectionClaim extends ProjectionRow {
  claim_token: string;
  desired_payload: ProjectionPayload;
}

const STATUS_CONTEXT = 'rorca/pipeline';
const EXTERNAL_ID_VERSION = 'v1';
const RECONCILE_INTERVAL_MS = 30_000;
let reconcileTimer: ReturnType<typeof setInterval> | null = null;
const scheduledRuns = new Set<number>();

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function externalId(runId: number): string {
  return `rorca:pipeline-run:${runId}:${EXTERNAL_ID_VERSION}`;
}

function buildRunViewUrl(runId: number): string {
  return `${process.env.RORCA_BASE_URL || 'http://localhost:5210'}/runs/${runId}`;
}

function parseProjectionPayload(value: ProjectionRow['desired_payload']): ProjectionPayload {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new ConflictError('Forgejo status projection payload is invalid');
  }
  return parsed as ProjectionPayload;
}

function terminalPayload(complete: CompleteTerminalRun): ProjectionPayload {
  const passed = complete.stories.filter((story) => story.status === 'pass').length;
  const failed = complete.stories.filter((story) => story.status !== 'pass').length;
  const state: 'success' | 'failure' = complete.successAuthorized && failed === 0 ? 'success' : 'failure';
  return {
    runId: complete.run.id,
    state,
    description: `Rorca Pipeline Run #${complete.run.id}: ${passed}/${complete.stories.length} passed, ${failed} failed.`,
  };
}

function startedPayload(runId: number): ProjectionPayload {
  return { runId, state: 'pending', description: 'Rorca pipeline run started.' };
}

export async function acceptForgejoStatusWalEvent(event: WalEvent): Promise<number | null> {
  if (event.event_type === 'run_started') {
    const authorized = await authorizeCanonicalWalEvent(event);
    if (!authorized
      || authorized.run.status !== 'running'
      || !['starting', 'pty_attached', 'running'].includes(authorized.run.lifecycleStatus)) return null;
    const headSha = await resolveBranchHead(authorized.run.id, authorized.run.workspaceId);
    if (!isFullForgejoObjectId(headSha)) return null;
    await withForgejoRepositoryAuthorityLock(authorized.run.workspaceId, '', '', async () => {
      const authority = await resolveProjectionAuthority(authorized.run.workspaceId, authorized.run.id, headSha);
      await persistDesiredProjection({
        event,
        runId: authorized.run.id,
        workspaceId: authorized.run.workspaceId,
        specId: authorized.run.specId,
        state: 'in_progress',
        headSha: headSha.toLowerCase(),
        conclusion: null,
        payload: startedPayload(authorized.run.id),
        authority,
      });
    });
    return authorized.run.id;
  }
  if (event.event_type !== 'run_finished') return null;

  const complete = await authorizeCompleteTerminalRun(event);
  if (!complete) return null;
  const localHead = complete.finalCommitSha ?? await resolveBranchHead(complete.run.id, complete.run.workspaceId);
  if (!isFullForgejoObjectId(localHead)) return null;

  await withForgejoRepositoryAuthorityLock(complete.run.workspaceId, '', '', async () => {
    const authority = await resolveProjectionAuthority(complete.run.workspaceId, complete.run.id, localHead);
    await persistDesiredProjection({
      event,
      runId: complete.run.id,
      workspaceId: complete.run.workspaceId,
      specId: complete.run.specId,
      state: 'completed',
      headSha: localHead.toLowerCase(),
      conclusion: complete.successAuthorized ? 'success' : 'failure',
      payload: terminalPayload(complete),
      authority,
    });
  });
  return complete.run.id;
}

async function resolveBranchHead(runId: number, workspaceId: string): Promise<string | null> {
  const run = await queryOne<{
    worktree_path: string | null;
    branch_name: string | null;
    execution_workspace_path: string | null;
    execution_worktree_path: string | null;
    workspace_path: string | null;
    terminal_checkout_sha: string | null;
    release_authorized_sha: string | null;
    release_execution_workspace_path: string | null;
    release_execution_worktree_path: string | null;
    release_identity_hash: string | null;
  }>(`
    SELECT pr.worktree_path, pr.branch_name,
           pr.execution_workspace_path, pr.execution_worktree_path,
           pr.terminal_checkout_sha, ri.authorized_sha AS release_authorized_sha,
           ri.execution_workspace_path AS release_execution_workspace_path,
           ri.execution_worktree_path AS release_execution_worktree_path,
           ri.identity_hash AS release_identity_hash, ws.path AS workspace_path
      FROM pipeline_runs pr JOIN workspaces ws ON ws.id = pr.workspace_id
      LEFT JOIN pipeline_run_release_intents ri ON ri.run_id = pr.id
     WHERE pr.id = $1 AND pr.workspace_id = $2
  `, [runId, workspaceId]);
  if (!run?.branch_name) return null;
  // Running events resolve the LIVE checkout head first (canonical GitHub
  // projector behavior); the immutable terminal attestation is the fallback
  // for completed runs whose checkout may no longer be materialized.
  try {
    return assertCanonicalRunCheckout({
      cwd: run.execution_worktree_path ?? run.worktree_path ?? run.workspace_path ?? '',
      repositoryTopLevel: run.execution_workspace_path ?? run.workspace_path ?? '',
      branchName: run.branch_name,
    }).headSha;
  } catch {
    const terminal = run.terminal_checkout_sha?.toLowerCase();
    return terminal
      && terminal === run.release_authorized_sha?.toLowerCase()
      && run.release_execution_workspace_path === run.execution_workspace_path
      && run.release_execution_worktree_path === run.execution_worktree_path
      && /^[0-9a-f]{64}$/.test(run.release_identity_hash ?? '')
      ? terminal
      : null;
  }
}

interface ProjectionAuthority {
  owner: string;
  name: string;
  bindingId: string | null;
  repositoryId: number | null;
}

async function resolveProjectionAuthority(workspaceId: string, runId: number, headSha: string): Promise<ProjectionAuthority> {
  const frozen = await queryOne<{
    repository_owner: string | null; repository_name: string | null;
    repository_binding_id: string | null; repository_id: number | string | null;
    authorized_sha: string;
  }>(`SELECT repository_owner, repository_name, repository_binding_id, repository_id, authorized_sha
        FROM pipeline_run_release_intents WHERE run_id = $1 AND workspace_id = $2`, [runId, workspaceId]);
  if (frozen) {
    if (!frozen.repository_owner || !frozen.repository_name
      || frozen.authorized_sha.toLowerCase() !== headSha.toLowerCase()) {
      throw new ConflictError('Forgejo release intent cannot freeze this status projection authority');
    }
    return {
      owner: frozen.repository_owner, name: frozen.repository_name,
      bindingId: frozen.repository_binding_id,
      repositoryId: frozen.repository_id == null ? null : Number(frozen.repository_id),
    };
  }
  const binding = await getWorkspaceForgejoCredential(workspaceId);
  if (!binding || binding.status !== 'active') {
    throw new ConflictError('Canonical Forgejo credential binding is unavailable');
  }
  return {
    owner: binding.owner, name: binding.name, bindingId: binding.bindingId,
    repositoryId: Number(binding.scopeProfile.repositoryId ?? null) || null,
  };
}

function projectionAuthorityMatches(row: ProjectionRow, authority: ProjectionAuthority): boolean {
  return row.repository_owner.toLowerCase() === authority.owner.toLowerCase()
    && row.repository_name.toLowerCase() === authority.name.toLowerCase()
    && row.repository_binding_id === authority.bindingId
    && Number(row.repository_id ?? 0) === Number(authority.repositoryId ?? 0);
}

async function persistDesiredProjection(input: {
  event: WalEvent;
  runId: number;
  workspaceId: string;
  specId: string;
  state: 'in_progress' | 'completed';
  headSha: string;
  conclusion: 'success' | 'failure' | 'neutral' | null;
  payload: ProjectionPayload;
  authority: ProjectionAuthority;
}): Promise<void> {
  const eventHash = input.event.event_identity_hash;
  if (!eventHash || !/^[0-9a-f]{64}$/.test(eventHash)) {
    throw new ConflictError('Trusted Forgejo status event has no immutable identity hash');
  }
  const payloadHash = hash({
    version: 1,
    state: input.state,
    headSha: input.headSha,
    conclusion: input.conclusion,
    payload: input.payload,
  });
  await transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`forgejo-status:${input.runId}`]);
    const existing = (await client.query<ProjectionRow>(
      'SELECT * FROM forgejo_status_projections WHERE run_id = $1 FOR UPDATE',
      [input.runId],
    )).rows[0];
    if (existing && (existing.workspace_id !== input.workspaceId
      || existing.spec_id !== input.specId
      || existing.external_id !== externalId(input.runId)
      || !projectionAuthorityMatches(existing, input.authority))) {
      throw new ConflictError('Forgejo status projection does not own the canonical run identity');
    }
    if (existing?.desired_state === 'completed') {
      if (existing.head_sha !== input.headSha
        || existing.conclusion !== input.conclusion
        || existing.desired_payload_hash !== payloadHash) {
        throw new ConflictError('Terminal Forgejo status projection already has different immutable authority');
      }
      return;
    }
    if (!existing) {
      await client.query(`
        INSERT INTO forgejo_status_projections (
          run_id, workspace_id, spec_id, desired_event_id,
          desired_event_identity_hash, desired_state, head_sha, conclusion,
          desired_payload, desired_payload_hash, external_id, projection_status,
          repository_owner, repository_name, repository_binding_id, repository_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,'pending',$12,$13,$14,$15)
      `, [
        input.runId, input.workspaceId, input.specId, input.event.id, eventHash,
        input.state, input.headSha, input.conclusion, JSON.stringify(input.payload),
        payloadHash, externalId(input.runId), input.authority.owner, input.authority.name,
        input.authority.bindingId, input.authority.repositoryId,
      ]);
      return;
    }
    await client.query(`
      UPDATE forgejo_status_projections
         SET desired_event_id = $2, desired_event_identity_hash = $3,
             desired_state = $4, head_sha = $5, conclusion = $6,
             desired_payload = $7::jsonb, desired_payload_hash = $8,
             projection_status = CASE WHEN projection_status = 'processing'
               THEN 'processing' ELSE 'pending' END,
             next_attempt_at = NULL, last_error_code = NULL,
             last_error_message = NULL, updated_at = NOW()
       WHERE run_id = $1
    `, [
      input.runId, input.event.id, eventHash, input.state, input.headSha,
      input.conclusion, JSON.stringify(input.payload), payloadHash,
    ]);
  });
}

async function claimProjection(runId: number): Promise<ProjectionClaim | null> {
  return transaction(async (client) => {
    const run = (await client.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM pipeline_runs WHERE id = $1', [runId],
    )).rows[0];
    if (!run) return null;
    await scopeForgejoWorkspace(client, run.workspace_id);
    const row = (await client.query<ProjectionRow>(
      'SELECT * FROM forgejo_status_projections WHERE run_id = $1 FOR UPDATE SKIP LOCKED',
      [runId],
    )).rows[0];
    if (!row) return null;
    const terminalStatus = row.desired_state === 'completed' ? 'completed' : 'projected';
    if (row.projection_status === terminalStatus || row.projection_status === 'blocked') return null;
    if (row.projection_status === 'processing'
      && row.claimed_at
      && Date.parse(row.claimed_at) > Date.now() - 120_000) return null;
    if (row.next_attempt_at && Date.parse(row.next_attempt_at) > Date.now()) return null;
    const claimToken = randomUUID();
    const claimed = (await client.query<ProjectionRow>(`
      UPDATE forgejo_status_projections
         SET projection_status = 'processing', claim_token = $2,
             claimed_at = NOW(), attempts = attempts + 1, updated_at = NOW()
       WHERE run_id = $1
       RETURNING *
    `, [runId, claimToken])).rows[0];
    return claimed ? {
      ...claimed,
      claim_token: claimToken,
      desired_payload: parseProjectionPayload(claimed.desired_payload),
    } : null;
  });
}

function forgejoHeaders(token: string): Record<string, string> {
  return {
    Authorization: `token ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'Rorca-Worker',
  };
}

class ProjectionProviderError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly uncertain: boolean,
    readonly statusCode: number | null,
    readonly requestId: string | null,
    message: string,
  ) { super(message); }
}

async function providerFetch(url: string, init: RequestInit, operationCode: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetchForgejoWithTimeout(fetch, url, init);
  } catch (error) {
    const sanitized = sanitizeForgejoProviderException(error, operationCode);
    throw new ProjectionProviderError(sanitized.code, true, true, null, sanitized.requestId,
      formatForgejoProviderError(sanitized));
  }
  if (!response.ok) {
    const providerError = extractForgejoProviderError(response, operationCode);
    const retryable = response.status === 408 || response.status === 409
      || response.status === 429 || response.status >= 500;
    throw new ProjectionProviderError(providerError.code, retryable, false, response.status,
      providerError.requestId, formatForgejoProviderError(providerError));
  }
  return response;
}

function safeRequestId(response: Pick<Response, 'status' | 'headers'>): string | null {
  return extractForgejoProviderError(response, 'FORGEJO_STATUS_RESPONSE_INVALID').requestId;
}

interface ForgejoStatus {
  id?: number;
  context?: string;
  state?: string;
  target_url?: string | null;
  description?: string | null;
}

function statusMatchesDesired(status: ForgejoStatus, claim: ProjectionClaim): boolean {
  const desired = providerBody(claim);
  return status.context === STATUS_CONTEXT
    && status.state === desired.state
    && (status.description ?? null) === desired.description
    && (status.target_url ?? null) === desired.target_url;
}

/** Discover the newest provider status owned by our exact context/target URL
 * at the claim's head. Forgejo statuses are append-only, so multiple owned
 * statuses at one head are expected history (pending then terminal); the
 * LATEST owned status is what a replay must match against the full desired
 * payload (state, description, target URL, head, provider id). */
async function discoverStatus(
  instanceUrl: string,
  owner: string,
  repo: string,
  token: string,
  claim: ProjectionClaim,
): Promise<ForgejoStatus | null> {
  const response = await providerFetch(
    forgejoRepoApiUrl(instanceUrl, owner, repo, `/statuses/${claim.head_sha}`),
    { method: 'GET', headers: forgejoHeaders(token) },
    'FORGEJO_STATUS_RECONCILE_FAILED',
  );
  let body: unknown;
  try { body = await response.json(); } catch {
    throw new ProjectionProviderError('FORGEJO_STATUS_RECONCILE_UNCERTAIN', true, true, response.status,
      safeRequestId(response), 'Forgejo status lookup response was unreadable');
  }
  if (!Array.isArray(body)) {
    throw new ProjectionProviderError('FORGEJO_STATUS_RECONCILE_UNCERTAIN', true, true, response.status,
      safeRequestId(response), 'Forgejo status lookup response shape was indeterminate');
  }
  const owned = (body as ForgejoStatus[]).filter((status) =>
    status && typeof status === 'object'
    && status.context === STATUS_CONTEXT
    && (status.target_url ?? '') === buildRunViewUrl(Number(claim.run_id))
    && Number.isSafeInteger(status.id))
    .sort((a, b) => Number(b.id!) - Number(a.id!));
  return owned[0] ?? null;
}

function providerBody(claim: ProjectionClaim): Record<string, unknown> {
  const state = claim.desired_state === 'completed'
    ? (claim.conclusion === 'success' ? 'success' : 'failure')
    : 'pending';
  return {
    context: STATUS_CONTEXT,
    state,
    description: claim.desired_payload.description.slice(0, 140),
    target_url: buildRunViewUrl(Number(claim.run_id)),
  };
}

async function applyProviderProjection(
  instanceUrl: string,
  owner: string,
  repo: string,
  token: string,
  claim: ProjectionClaim,
): Promise<number> {
  const latest = await discoverStatus(instanceUrl, owner, repo, token, claim);
  // Idempotent replay: the latest owned status already carries the full
  // desired payload. Otherwise Forgejo statuses are append-only, so a NEW
  // status (pending or terminal) is posted at the exact head.
  if (latest && statusMatchesDesired(latest, claim)) return Number(latest.id);
  const response = await providerFetch(
    forgejoRepoApiUrl(instanceUrl, owner, repo, `/statuses/${claim.head_sha}`),
    { method: 'POST', headers: forgejoHeaders(token), body: JSON.stringify(providerBody(claim)) },
    'FORGEJO_STATUS_CREATE_FAILED',
  );
  let created: ForgejoStatus;
  try { created = await response.json() as ForgejoStatus; } catch {
    throw new ProjectionProviderError('FORGEJO_STATUS_CREATE_UNCERTAIN', true, true, response.status,
      safeRequestId(response), 'Forgejo status create response was unreadable');
  }
  if (!Number.isSafeInteger(created.id) || Number(created.id) <= 0) {
    throw new ProjectionProviderError('FORGEJO_STATUS_CREATE_UNCERTAIN', true, true, response.status,
      safeRequestId(response), 'Forgejo status create response omitted its identity');
  }
  // Verify the provider response payload BEFORE completing the local claim:
  // the created status must carry the exact desired context/state/target URL.
  if (!statusMatchesDesired(created, claim)) {
    throw new ProjectionProviderError('FORGEJO_STATUS_CREATE_UNCERTAIN', true, true, response.status,
      safeRequestId(response), 'Forgejo status create response differs from the desired payload');
  }
  return Number(created.id);
}

async function finishClaim(
  claim: ProjectionClaim,
  state: 'projected' | 'completed' | 'retry' | 'uncertain' | 'blocked',
  values: {
    providerStatusId?: number;
    providerHeadSha?: string;
    requestId?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    retryDelayMs?: number;
  } = {},
): Promise<boolean> {
  return transaction(async (client) => {
    await scopeForgejoWorkspace(client, claim.workspace_id);
    const result = await client.query(`
      UPDATE forgejo_status_projections
         SET projection_status = CASE WHEN desired_payload_hash = $3 THEN $4 ELSE 'pending' END,
             provider_status_id = COALESCE($5, provider_status_id),
             provider_head_sha = COALESCE($6, provider_head_sha),
             provider_request_id = $7,
             last_error_code = $8,
             last_error_message = $9,
             next_attempt_at = CASE
               WHEN desired_payload_hash = $3 AND $10::int > 0
                 THEN NOW() + ($10::text || ' milliseconds')::interval
               ELSE NULL END,
             claim_token = NULL, claimed_at = NULL, updated_at = NOW()
       WHERE run_id = $1 AND claim_token = $2::uuid
    `, [
      Number(claim.run_id), claim.claim_token, claim.desired_payload_hash, state,
      values.providerStatusId ?? null, values.providerHeadSha ?? null,
      values.requestId ?? null, values.errorCode ?? null,
      values.errorMessage?.slice(0, 512) ?? null, values.retryDelayMs ?? 0,
    ]);
    return result.rowCount === 1;
  });
}

async function emitProjectionWal(claim: ProjectionClaim, providerStatusId: number): Promise<void> {
  const eventType = claim.desired_state === 'completed' ? 'forgejo_status_completed' : 'forgejo_status_created';
  const payload = {
    run_id: Number(claim.run_id),
    provider_status_id: providerStatusId,
    sha: claim.head_sha,
    conclusion: claim.conclusion,
    state: claim.desired_payload.state,
  };
  const ingestKey = `forgejo-status-projection:v1:${Number(claim.run_id)}:${claim.desired_payload_hash}`;
  const event = await queryOne<WalEvent>(`
    INSERT INTO wal_events (event_type, workspace_id, spec_id, actor, payload, ingest_key)
    VALUES ($1,$2,$3,'forgejo',$4::jsonb,$5)
    ON CONFLICT (ingest_key) WHERE ingest_key IS NOT NULL DO NOTHING
    RETURNING *
  `, [eventType, claim.workspace_id, claim.spec_id, JSON.stringify(payload), ingestKey]);
  if (event) broadcastAll(event);
}

export async function reconcileForgejoStatusProjection(runId: number): Promise<boolean> {
  const claim = await claimProjection(runId);
  if (!claim) return false;
  try {
    const statusId = await withForgejoRepositoryAuthorityLock(
      claim.workspace_id,
      claim.repository_owner,
      claim.repository_name,
      async () => {
        const binding = await getWorkspaceForgejoCredential(claim.workspace_id);
        if (!binding || binding.status !== 'active'
          || binding.owner.toLowerCase() !== claim.repository_owner.toLowerCase()
          || binding.name.toLowerCase() !== claim.repository_name.toLowerCase()
          || (claim.repository_binding_id != null && binding.bindingId !== claim.repository_binding_id)) {
          throw new ProjectionProviderError(
            'FORGEJO_CREDENTIAL_AUTHORITY_CHANGED', false, false, null, null,
            'Canonical Forgejo credential binding differs from the frozen status projection',
          );
        }
        const credential = await resolveWorkspaceForgejoToken(claim.workspace_id, {
          repository: { owner: binding.owner, name: binding.name },
          purpose: 'statuses-write',
        });
        if (!credential) {
          throw new ProjectionProviderError(
            'FORGEJO_STATUS_TOKEN_AUTHORITY_MISMATCH', false, false, null, null,
            'Purpose-scoped Forgejo status credential differs from frozen projection authority',
          );
        }
        return applyProviderProjection(binding.instanceUrl, binding.owner, binding.name, credential.token, claim);
      },
    );
    const status = claim.desired_state === 'completed' ? 'completed' : 'projected';
    if (await finishClaim(claim, status, { providerStatusId: statusId, providerHeadSha: claim.head_sha })) {
      await emitProjectionWal(claim, statusId);
    }
    return true;
  } catch (error) {
    const providerError = error instanceof ProjectionProviderError
      ? error
      : new ProjectionProviderError(
        'FORGEJO_STATUS_PROJECTION_FAILED', true, true, null, null,
        formatForgejoProviderError(sanitizeForgejoProviderException(error, 'FORGEJO_STATUS_PROJECTION_FAILED')),
      );
    const state = providerError.uncertain ? 'uncertain' : providerError.retryable ? 'retry' : 'blocked';
    const retryDelayMs = providerError.retryable
      ? Math.min(300_000, 2 ** Math.min(claim.attempts, 8) * 1_000)
      : 0;
    await finishClaim(claim, state, {
      providerHeadSha: claim.head_sha,
      requestId: providerError.requestId,
      errorCode: providerError.code,
      errorMessage: providerError.message,
      retryDelayMs,
    });
    logger.warn({ runId, code: providerError.code, state }, '[ForgejoStatus] Durable projection deferred');
    return false;
  }
}

function scheduleReconcile(runId: number): void {
  if (scheduledRuns.has(runId)) return;
  scheduledRuns.add(runId);
  setImmediate(() => {
    void reconcileForgejoStatusProjection(runId)
      .catch(error => logger.warn({ error, runId }, '[ForgejoStatus] Scheduled projection failed'))
      .finally(() => scheduledRuns.delete(runId));
  });
}

export async function reconcilePendingForgejoStatusProjections(limit = 100): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new RangeError('Invalid Forgejo status reconciliation limit');
  // FORCE RLS (wave5 hardening) hides every row from an unscoped scan, so
  // enumerate the workspaces from the non-RLS registry and scan each scope
  // under its own workspace GUC — otherwise the 30s reconcile silently no-ops
  // in production.
  const workspaces = await query<{ id: string }>('SELECT id FROM workspaces ORDER BY id');
  let completed = 0;
  for (const workspace of workspaces) {
    const rows = await transaction(async (client) => {
      await scopeForgejoWorkspace(client, workspace.id);
      return (await client.query<{ run_id: number | string }>(`
        SELECT run_id FROM forgejo_status_projections
         WHERE projection_status IN ('pending', 'retry', 'uncertain')
            OR (projection_status = 'processing' AND claimed_at < NOW() - INTERVAL '2 minutes')
         ORDER BY updated_at ASC
         LIMIT $1
      `, [limit])).rows;
    });
    for (const row of rows) {
      if (await reconcileForgejoStatusProjection(Number(row.run_id))) completed++;
    }
  }
  return completed;
}

/** Test/direct seam: durably accept and then synchronously attempt projection. */
export async function handleForgejoStatusWalEvent(event: WalEvent): Promise<void> {
  const runId = await acceptForgejoStatusWalEvent(event);
  if (runId) await reconcileForgejoStatusProjection(runId);
}

export function resetForgejoCheckPosterForTests(): void {
  scheduledRuns.clear();
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
}

export function startForgejoCheckPoster(): void {
  subscribeDurable(async (event) => {
    if (event.event_type !== 'run_started' && event.event_type !== 'run_finished') return;
    const runId = await acceptForgejoStatusWalEvent(event);
    if (runId) scheduleReconcile(runId);
  });
  void reconcilePendingForgejoStatusProjections().catch(error =>
    logger.warn({ error }, '[ForgejoStatus] Startup projection reconciliation deferred'));
  if (!reconcileTimer) {
    reconcileTimer = setInterval(() => {
      void reconcilePendingForgejoStatusProjections().catch(error =>
        logger.warn({ error }, '[ForgejoStatus] Periodic projection reconciliation deferred'));
    }, RECONCILE_INTERVAL_MS);
    reconcileTimer.unref?.();
  }
  logger.info('[ForgejoStatus] Durable Forgejo status projector subscribed');
}

// ─── Optional Forgejo Actions check-run backend ───────────────────────────

export interface ForgejoProjectionBackend {
  readonly kind: 'commit-status' | 'actions-check-run';
  project(owner: string, repo: string, credential: ResolvedForgejoToken, claim: ProjectionClaim): Promise<number>;
  isAvailable(): boolean;
}

export const commitStatusBackend: ForgejoProjectionBackend = Object.freeze({
  kind: 'commit-status',
    async project(owner: string, repo: string, credential: ResolvedForgejoToken, claim: ProjectionClaim) {
    return applyProviderProjection(credential.metadata.instanceUrl, owner, repo, credential.token, claim);
  },
  isAvailable() { return true; },
});

/** Capability-gated Forgejo Actions check-run backend (same projection shape). */
export function createActionsCheckRunBackend(available: () => boolean): ForgejoProjectionBackend {
  return Object.freeze({
    kind: 'actions-check-run' as const,
    async project(owner: string, repo: string, credential: ResolvedForgejoToken, claim: ProjectionClaim) {
      const response = await providerFetch(
        forgejoRepoApiUrl(credential.metadata.instanceUrl, owner, repo, '/check-runs'),
        { method: 'POST', headers: forgejoHeaders(credential.token), body: JSON.stringify({
          name: STATUS_CONTEXT,
          head_sha: claim.head_sha,
          status: claim.desired_state === 'completed' ? 'completed' : 'in_progress',
          conclusion: claim.desired_state === 'completed'
            ? (claim.conclusion === 'success' ? 'success' : 'failure') : null,
          details_url: buildRunViewUrl(Number(claim.run_id)),
        }) },
        'FORGEJO_ACTIONS_CHECK_RUN_CREATE_FAILED',
      );
      let created: { id?: number };
      try { created = await response.json() as { id?: number }; } catch {
        throw new ProjectionProviderError('FORGEJO_ACTIONS_CHECK_RUN_CREATE_UNCERTAIN', true, true,
          response.status, safeRequestId(response), 'Forgejo Actions check-run create response was unreadable');
      }
      if (!Number.isSafeInteger(created.id) || Number(created.id) <= 0) {
        throw new ProjectionProviderError('FORGEJO_ACTIONS_CHECK_RUN_CREATE_UNCERTAIN', true, true,
          response.status, safeRequestId(response), 'Forgejo Actions check-run create response omitted its identity');
      }
      return Number(created.id);
    },
    isAvailable: available,
  });
}

/** Resolve the projection backend for an instance: Actions only when detected. */
export function resolveForgejoProjectionBackend(
  actionsCapable: () => boolean = () => process.env.RORCA_FORGEJO_ACTIONS_BACKEND === '1',
): ForgejoProjectionBackend {
  if (actionsCapable()) return createActionsCheckRunBackend(actionsCapable);
  return commitStatusBackend;
}
