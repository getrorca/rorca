/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PoolClient } from 'pg';
import { queryOne, transaction } from '../db/index';
import { retryHash, type RetryPreviewPacket } from './retry-governance';
import {
  prepareHostRunCloseout,
  terminalizePreparedHostRunCloseout,
} from './run-closeout-authority';

export type RetryPreparationState =
  | 'unowned'
  | 'preparing'
  | 'artifacts_ready'
  | 'hooks_running'
  | 'hooks_passed'
  | 'manifests_ready'
  | 'outbox_ready'
  | 'published'
  | 'cancelled'
  | 'refused';

export interface GovernedRetryPublicationSnapshot {
  previewStatus: string | null;
  preparationState: RetryPreparationState | null;
  dispatchState: string | null;
  runStatus: string | null;
  bossJobId: string | null;
}

export type GovernedRetryPublicationOutcome = 'pending' | 'published' | 'cancelled' | 'refused' | 'inconsistent';

export class GovernedRetryPublicationPendingError extends Error {
  constructor() {
    super('[governed-retry] durable publication is still pending; retry this exact queue delivery');
    this.name = 'GovernedRetryPublicationPendingError';
  }
}

export class GovernedRetryStateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GovernedRetryStateConflictError';
  }
}

export function classifyGovernedRetryPublication(
  snapshot: GovernedRetryPublicationSnapshot,
): GovernedRetryPublicationOutcome {
  if (
    snapshot.previewStatus === 'cancelled'
    || snapshot.preparationState === 'cancelled'
    || snapshot.dispatchState === 'cancelled'
    || snapshot.runStatus === 'cancelled'
  ) return 'cancelled';
  if (
    snapshot.previewStatus === 'refused'
    || snapshot.preparationState === 'refused'
    || snapshot.dispatchState === 'failed'
  ) return 'refused';
  if (
    snapshot.previewStatus === 'dispatched'
    && snapshot.preparationState === 'published'
    && snapshot.dispatchState !== null
    && !['prepared', 'cancelled', 'failed'].includes(snapshot.dispatchState)
    && snapshot.bossJobId !== null
  ) return 'published';
  if (
    snapshot.runStatus === 'queued'
    && snapshot.previewStatus === 'approved'
    && ['preparing', 'artifacts_ready', 'hooks_running', 'hooks_passed', 'manifests_ready', 'outbox_ready'].includes(snapshot.preparationState ?? '')
    && (snapshot.dispatchState === null || snapshot.dispatchState === 'prepared')
  ) return 'pending';
  return 'inconsistent';
}

export async function waitForGovernedRetryPublication(input: {
  read: () => Promise<GovernedRetryPublicationSnapshot>;
  attempts?: number;
  delayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
}): Promise<{ outcome: Exclude<GovernedRetryPublicationOutcome, 'pending'>; snapshot: GovernedRetryPublicationSnapshot }> {
  const attempts = Math.max(1, input.attempts ?? 5);
  const delayMs = Math.max(0, input.delayMs ?? 50);
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let snapshot = await input.read();
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const outcome = classifyGovernedRetryPublication(snapshot);
    if (outcome !== 'pending') return { outcome, snapshot };
    if (attempt < attempts) {
      await sleep(delayMs);
      snapshot = await input.read();
    }
  }
  throw new GovernedRetryPublicationPendingError();
}

interface PreviewPublicationRow {
  status: string;
  preparation_state: RetryPreparationState;
  retry_run_id: string | number | null;
  boss_job_id: string | null;
}

interface DispatchPublicationRow {
  identity_hash: string;
  state: string;
  retry_run_id: string | number;
  preview_hash: string;
  queue_payload_hash: string;
  boss_job_id: string | null;
}

function snapshot(
  preview: PreviewPublicationRow | undefined,
  dispatch: DispatchPublicationRow | undefined,
  runStatus: string | null,
): GovernedRetryPublicationSnapshot {
  return {
    previewStatus: preview?.status ?? null,
    preparationState: preview?.preparation_state ?? null,
    dispatchState: dispatch?.state ?? null,
    runStatus,
    bossJobId: dispatch?.boss_job_id ?? preview?.boss_job_id ?? null,
  };
}

async function lockPublicationRows(client: PoolClient, input: {
  previewHash: string;
  dispatchIdentityHash: string;
  retryRunId: number;
}): Promise<{
  preview: PreviewPublicationRow | undefined;
  dispatch: DispatchPublicationRow | undefined;
  runStatus: string | null;
}> {
  // Cancellation and worker claim use the same preview -> dispatch -> run lock
  // order, so publication has one deterministic linearization point.
  const previewResult = await client.query<PreviewPublicationRow>(
    `SELECT status, preparation_state, retry_run_id, boss_job_id
     FROM pipeline_retry_previews WHERE preview_hash = $1 FOR UPDATE`,
    [input.previewHash],
  );
  const dispatchResult = await client.query<DispatchPublicationRow>(
    `SELECT identity_hash, state, retry_run_id, preview_hash, queue_payload_hash, boss_job_id::text
     FROM governed_retry_dispatches WHERE identity_hash = $1 FOR UPDATE`,
    [input.dispatchIdentityHash],
  );
  const runResult = await client.query<{ status: string }>(
    `SELECT status FROM pipeline_runs WHERE id = $1 FOR UPDATE`,
    [input.retryRunId],
  );
  return {
    preview: previewResult.rows[0],
    dispatch: dispatchResult.rows[0],
    runStatus: runResult.rows[0]?.status ?? null,
  };
}

/**
 * Publish a complete Rorca outbox. Both the API sender and a fast worker may
 * call this; the first transaction wins and all exact replays observe the same
 * generated pg-boss UUID without mutating pg-boss-owned tables.
 */
export async function publishGovernedRetryDispatch(input: {
  previewHash: string;
  dispatchIdentityHash: string;
  retryRunId: number;
  queuePayloadHash: string;
  bossJobId: string;
}): Promise<{ outcome: GovernedRetryPublicationOutcome; snapshot: GovernedRetryPublicationSnapshot }> {
  return transaction(async (client) => {
    const locked = await lockPublicationRows(client, input);
    const before = snapshot(locked.preview, locked.dispatch, locked.runStatus);
    const beforeOutcome = classifyGovernedRetryPublication(before);
    if (['published', 'cancelled', 'refused'].includes(beforeOutcome)) {
      return { outcome: beforeOutcome, snapshot: before };
    }
    const exactRows = locked.preview
      && locked.dispatch
      && Number(locked.preview.retry_run_id) === input.retryRunId
      && Number(locked.dispatch.retry_run_id) === input.retryRunId
      && locked.dispatch.preview_hash === input.previewHash
      && locked.dispatch.queue_payload_hash === input.queuePayloadHash;
    if (
      exactRows
      && locked.preview!.status === 'approved'
      && locked.preview!.preparation_state === 'outbox_ready'
      && locked.dispatch!.state === 'dispatched'
      && locked.dispatch!.boss_job_id
    ) {
      await client.query(
        `UPDATE pipeline_retry_previews
         SET status = 'dispatched', preparation_state = 'published', boss_job_id = $2::uuid,
             dispatched_at = COALESCE(dispatched_at, NOW()), preparation_owner = NULL,
             preparation_lease_expires_at = NULL
         WHERE preview_hash = $1 AND status = 'approved' AND preparation_state = 'outbox_ready'`,
        [input.previewHash, locked.dispatch!.boss_job_id],
      );
      const repaired = snapshot(
        { ...locked.preview!, status: 'dispatched', preparation_state: 'published', boss_job_id: locked.dispatch!.boss_job_id },
        locked.dispatch,
        locked.runStatus,
      );
      return { outcome: 'published', snapshot: repaired };
    }
    if (
      beforeOutcome !== 'pending'
      || !exactRows
      || locked.preview!.preparation_state !== 'outbox_ready'
      || locked.dispatch!.state !== 'prepared'
    ) return { outcome: beforeOutcome === 'pending' ? 'pending' : 'inconsistent', snapshot: before };

    await client.query(
      `UPDATE governed_retry_dispatches
       SET state = 'dispatched', boss_job_id = $2::uuid
       WHERE identity_hash = $1 AND state = 'prepared'`,
      [input.dispatchIdentityHash, input.bossJobId],
    );
    await client.query(
      `UPDATE pipeline_retry_previews
       SET status = 'dispatched', preparation_state = 'published', boss_job_id = $2::uuid,
           dispatched_at = COALESCE(dispatched_at, NOW()), preparation_owner = NULL,
           preparation_lease_expires_at = NULL
       WHERE preview_hash = $1 AND status = 'approved' AND preparation_state = 'outbox_ready'`,
      [input.previewHash, input.bossJobId],
    );
    const after = snapshot(
      { ...locked.preview!, status: 'dispatched', preparation_state: 'published', boss_job_id: input.bossJobId },
      { ...locked.dispatch!, state: 'dispatched', boss_job_id: input.bossJobId },
      locked.runStatus,
    );
    return { outcome: 'published', snapshot: after };
  });
}

export async function readGovernedRetryPublication(input: {
  previewHash: string;
  dispatchIdentityHash: string;
  retryRunId: number;
}): Promise<GovernedRetryPublicationSnapshot> {
  const row = await queryOne<{
    preview_status: string | null;
    preparation_state: RetryPreparationState | null;
    dispatch_state: string | null;
    run_status: string | null;
    boss_job_id: string | null;
  }>(
    `SELECT preview.status AS preview_status, preview.preparation_state,
            dispatch.state AS dispatch_state, run.status AS run_status,
            COALESCE(dispatch.boss_job_id, preview.boss_job_id)::text AS boss_job_id
     FROM pipeline_runs run
     LEFT JOIN pipeline_retry_previews preview
       ON preview.preview_hash = $1 AND preview.retry_run_id = run.id
     LEFT JOIN governed_retry_dispatches dispatch
       ON dispatch.identity_hash = $2 AND dispatch.retry_run_id = run.id
     WHERE run.id = $3`,
    [input.previewHash, input.dispatchIdentityHash, input.retryRunId],
  );
  return {
    previewStatus: row?.preview_status ?? null,
    preparationState: row?.preparation_state ?? null,
    dispatchState: row?.dispatch_state ?? null,
    runStatus: row?.run_status ?? null,
    bossJobId: row?.boss_job_id ?? null,
  };
}

export async function advanceGovernedRetryPreparation(input: {
  previewHash: string;
  owner: string;
  from: RetryPreparationState;
  to: RetryPreparationState;
}): Promise<void> {
  const result = await transaction(async (client) => client.query(
    `UPDATE pipeline_retry_previews
     SET preparation_state = $4, preparation_lease_expires_at = NOW() + INTERVAL '5 minutes'
     WHERE preview_hash = $1 AND status = 'approved' AND preparation_owner = $2
       AND preparation_state = $3
     RETURNING preview_hash`,
    [input.previewHash, input.owner, input.from, input.to],
  ));
  if (result.rowCount !== 1) {
    throw new GovernedRetryStateConflictError('[governed-retry] preparation ownership or state was lost');
  }
}

export type GovernedRetryRunCancellationResult =
  | { outcome: 'not_governed_retry' }
  | { outcome: 'cancelled_before_claim'; previewHash: string; bossJobId: string | null }
  | { outcome: 'termination_required'; previewHash: string; bossJobId: string | null }
  | { outcome: 'already_terminal'; previewHash: string; bossJobId: string | null };

/** Canonical generic-run cancellation bridge for a governed retry run. */
export async function requestGovernedRetryRunCancellation(input: {
  runId: number;
  workspaceId: string;
  requestedBy: string;
  reason: string;
}): Promise<GovernedRetryRunCancellationResult> {
  return transaction(async (client) => {
    const previewResult = await client.query<{
      preview_hash: string; status: string; preparation_state: RetryPreparationState;
      original_run_id: number | string; boss_job_id: string | null;
    }>(
      `SELECT preview_hash, status, preparation_state, original_run_id, boss_job_id::text
       FROM pipeline_retry_previews
       WHERE retry_run_id = $1 AND workspace_id = $2
       FOR UPDATE`,
      [input.runId, input.workspaceId],
    );
    const preview = previewResult.rows[0];
    if (!preview) return { outcome: 'not_governed_retry' };
    const dispatchResult = await client.query<{
      identity_hash: string; state: string; boss_job_id: string | null;
    }>(
      `SELECT identity_hash, state, boss_job_id::text
       FROM governed_retry_dispatches WHERE retry_run_id = $1 FOR UPDATE`,
      [input.runId],
    );
    const dispatch = dispatchResult.rows[0];
    const run = (await client.query<{ status: string }>(
      'SELECT status FROM pipeline_runs WHERE id = $1 AND workspace_id = $2 FOR UPDATE',
      [input.runId, input.workspaceId],
    )).rows[0];
    if (!run) throw new GovernedRetryStateConflictError('Governed retry run disappeared during cancellation');
    const bossJobId = dispatch?.boss_job_id ?? preview.boss_job_id ?? null;
    if (['cancelled', 'refused'].includes(preview.status)
      || ['finalized', 'failed', 'manual_review_required', 'cancelled'].includes(dispatch?.state ?? '')) {
      return { outcome: 'already_terminal', previewHash: preview.preview_hash, bossJobId };
    }
    if (dispatch && ['committed', 'integrating', 'integrated_validated'].includes(dispatch.state)) {
      throw new GovernedRetryStateConflictError('Post-Git governed retry cannot be cancelled; exact reconciliation is required');
    }
    const evidence = JSON.stringify({
      schemaVersion: 'rorca.governed-retry-cancellation.v1',
      reason: input.reason.slice(0, 512),
      requestedBy: input.requestedBy.slice(0, 256),
      previewHash: preview.preview_hash,
      retryRunId: input.runId,
      priorPreviewStatus: preview.status,
      priorPreparationState: preview.preparation_state,
      priorDispatchState: dispatch?.state ?? null,
      priorRunStatus: run.status,
    });
    const workerTerminalizationRequired = dispatch
      && ['prepared', 'dispatched', 'claimed', 'executing'].includes(dispatch.state);
    if (workerTerminalizationRequired) {
      const requested = await client.query(
        `UPDATE governed_retry_dispatches
         SET cancellation_requested_at = COALESCE(cancellation_requested_at, NOW()),
             cancellation_request = COALESCE(cancellation_request, $2::jsonb)
         WHERE identity_hash = $1 AND state IN ('prepared', 'dispatched', 'claimed', 'executing')
         RETURNING identity_hash`,
        [dispatch.identity_hash, evidence],
      );
      if (requested.rowCount !== 1) throw new GovernedRetryStateConflictError('Governed retry cancellation lost its pre-Git race');
      return { outcome: 'termination_required', previewHash: preview.preview_hash, bossJobId };
    }
    if (dispatch) {
      await client.query(
        `UPDATE governed_retry_story_attempts
         SET state = 'cancelled', cancellation_evidence = $2::jsonb, cancelled_at = NOW()
         WHERE dispatch_identity_hash = $1 AND state = 'pending'`,
        [dispatch.identity_hash, evidence],
      );
      await client.query(
        `UPDATE governed_retry_dispatches
         SET state = 'cancelled', cancellation_evidence = $2::jsonb, cancelled_at = NOW(),
             lease_owner = NULL, lease_expires_at = NULL
         WHERE identity_hash = $1 AND state IN ('prepared', 'dispatched')`,
        [dispatch.identity_hash, evidence],
      );
    }
    await client.query(
      `UPDATE pipeline_runs
       SET status = 'cancelled', finished_at = COALESCE(finished_at, NOW()),
           queue_position = NULL, lifecycle_status = 'cancelled', lifecycle_updated_at = NOW()
       WHERE id = $1 AND status = 'queued'`,
      [input.runId],
    );
    await client.query(
      `UPDATE pipeline_retry_previews
       SET status = 'cancelled', preparation_state = 'cancelled', cancelled_at = NOW(),
           cancellation_evidence = $2::jsonb, preparation_owner = NULL,
           preparation_lease_expires_at = NULL
       WHERE preview_hash = $1 AND status IN ('previewed', 'approved', 'dispatched')`,
      [preview.preview_hash, evidence],
    );
    return { outcome: 'cancelled_before_claim', previewHash: preview.preview_hash, bossJobId };
  });
}

export type GovernedRetryTerminalizationResult =
  | { outcome: 'not_governed_retry' }
  | { outcome: 'terminalized'; terminal: 'cancelled' | 'failed'; previewHash: string; dispatchIdentityHash: string; bossJobId: string | null }
  | { outcome: 'already_terminal'; terminal: 'cancelled' | 'failed'; previewHash: string; dispatchIdentityHash: string; bossJobId: string | null }
  | { outcome: 'manual_review_required'; previewHash: string; dispatchIdentityHash: string; bossJobId: string | null };

/**
 * Common application-owned terminalizer for every pre-Git governed retry exit.
 * The caller must stop/verify the engine and PTY process trees first. Rorca
 * state then converges under the canonical preview -> dispatch -> run lock
 * order, including immutable host closeout and trusted terminal outbox. pg-boss
 * is deliberately outside this transaction and may only be notified afterward.
 */
export async function terminalizeGovernedRetryRun(input: {
  runId: number;
  workspaceId: string;
  requestedTerminal: 'auto' | 'cancelled' | 'failed';
  reason: string;
  source: string;
}): Promise<GovernedRetryTerminalizationResult> {
  const candidate = await queryOne<{
    preview_hash: string;
    identity_hash: string;
    state: string;
    cancellation_requested_at: string | null;
  }>(
    `SELECT preview.preview_hash, dispatch.identity_hash, dispatch.state,
            dispatch.cancellation_requested_at
       FROM pipeline_retry_previews preview
       JOIN governed_retry_dispatches dispatch ON dispatch.preview_hash = preview.preview_hash
      WHERE dispatch.retry_run_id = $1 AND preview.workspace_id = $2`,
    [input.runId, input.workspaceId],
  );
  if (!candidate) return { outcome: 'not_governed_retry' };

  const postGitStates = ['committed', 'integrating', 'integrated_validated', 'finalized', 'manual_review_required'];
  if (postGitStates.includes(candidate.state)) {
    return transaction(async (client) => {
      const preview = (await client.query<{ preview_hash: string }>(
        `SELECT preview_hash FROM pipeline_retry_previews
          WHERE preview_hash = $1 AND workspace_id = $2 FOR UPDATE`,
        [candidate.preview_hash, input.workspaceId],
      )).rows[0];
      const dispatch = (await client.query<{ identity_hash: string; state: string; boss_job_id: string | null }>(
        `SELECT identity_hash, state, boss_job_id::text
           FROM governed_retry_dispatches WHERE identity_hash = $1 FOR UPDATE`,
        [candidate.identity_hash],
      )).rows[0];
      await client.query('SELECT id FROM pipeline_runs WHERE id = $1 AND workspace_id = $2 FOR UPDATE', [input.runId, input.workspaceId]);
      if (!preview || !dispatch) throw new GovernedRetryStateConflictError('Governed retry authority disappeared during post-Git reconciliation');
      if (dispatch.state !== 'finalized' && dispatch.state !== 'manual_review_required') {
        const evidence = JSON.stringify({
          schemaVersion: 'rorca.governed-retry-reconciliation.v1',
          reason: input.reason.slice(0, 512),
          source: input.source.slice(0, 128),
          retryRunId: input.runId,
          dispatchIdentityHash: dispatch.identity_hash,
          postGitAmbiguity: true,
        });
        await client.query(
          `UPDATE governed_retry_story_attempts
              SET state = 'manual_review_required', failure_evidence = $2::jsonb
            WHERE dispatch_identity_hash = $1 AND state IN ('committed','integrating')`,
          [dispatch.identity_hash, evidence],
        );
        await client.query(
          `UPDATE governed_retry_dispatches
              SET state = 'manual_review_required', failure_evidence = $2::jsonb,
                  lease_owner = NULL, lease_expires_at = NULL
            WHERE identity_hash = $1 AND state IN ('committed','integrating','integrated_validated')`,
          [dispatch.identity_hash, evidence],
        );
        await client.query(
          `UPDATE pipeline_runs
              SET status = 'partial_failure', finished_at = COALESCE(finished_at, NOW()),
                  summary = 'governed_retry_post_git_manual_review_required',
                  lifecycle_status = 'blocked', lifecycle_updated_at = NOW(),
                  lifecycle_diagnostics = lifecycle_diagnostics || $2::jsonb,
                  pid = NULL, worker_id = NULL, queue_position = NULL
            WHERE id = $1`,
          [input.runId, JSON.stringify({ owner: 'governed_retry_terminalizer', reason: input.reason })],
        );
      }
      return {
        outcome: 'manual_review_required' as const,
        previewHash: preview.preview_hash,
        dispatchIdentityHash: dispatch.identity_hash,
        bossJobId: dispatch.boss_job_id,
      };
    });
  }

  const terminal = input.requestedTerminal === 'failed'
    ? 'failed'
    : input.requestedTerminal === 'cancelled' || candidate.cancellation_requested_at
      ? 'cancelled'
      : 'failed';
  if (input.requestedTerminal === 'cancelled' && !candidate.cancellation_requested_at) {
    throw new GovernedRetryStateConflictError('Governed retry cancellation has no durable winning request');
  }
  const preparedCloseout = await prepareHostRunCloseout({
    runId: input.runId,
    status: terminal,
    governedRetryDispatchIdentity: candidate.identity_hash,
  });

  return transaction(async (client) => {
    const preview = (await client.query<{
      preview_hash: string; status: string; preparation_state: RetryPreparationState;
    }>(
      `SELECT preview_hash, status, preparation_state
         FROM pipeline_retry_previews
        WHERE preview_hash = $1 AND workspace_id = $2 FOR UPDATE`,
      [candidate.preview_hash, input.workspaceId],
    )).rows[0];
    const dispatch = (await client.query<{
      identity_hash: string; state: string; boss_job_id: string | null;
      cancellation_requested_at: string | null;
    }>(
      `SELECT identity_hash, state, boss_job_id::text, cancellation_requested_at
         FROM governed_retry_dispatches WHERE identity_hash = $1 FOR UPDATE`,
      [candidate.identity_hash],
    )).rows[0];
    const run = (await client.query<{ status: string; host_closeout_event_id: number | null }>(
      `SELECT status, host_closeout_event_id FROM pipeline_runs
        WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
      [input.runId, input.workspaceId],
    )).rows[0];
    if (!preview || !dispatch || !run) {
      throw new GovernedRetryStateConflictError('Governed retry authority disappeared during terminalization');
    }
    if (postGitStates.includes(dispatch.state)) {
      throw new GovernedRetryStateConflictError('Governed retry crossed post-Git authority during terminalization');
    }
    const actualTerminal = input.requestedTerminal === 'failed'
      ? 'failed'
      : input.requestedTerminal === 'cancelled' || dispatch.cancellation_requested_at
        ? 'cancelled'
        : 'failed';
    if (actualTerminal !== terminal) {
      throw new GovernedRetryStateConflictError('Governed retry cancellation won while terminal authority was being prepared');
    }
    const matchingTerminal = terminal === 'cancelled'
      ? preview.status === 'cancelled' && dispatch.state === 'cancelled' && run.status === 'cancelled'
      : preview.status === 'refused' && dispatch.state === 'failed' && run.status === 'failed';
    if (matchingTerminal && run.host_closeout_event_id != null) {
      return {
        outcome: 'already_terminal' as const,
        terminal,
        previewHash: preview.preview_hash,
        dispatchIdentityHash: dispatch.identity_hash,
        bossJobId: dispatch.boss_job_id,
      };
    }
    if (['cancelled', 'failed', 'manual_review_required', 'finalized'].includes(dispatch.state)) {
      throw new GovernedRetryStateConflictError(`Governed retry has contradictory terminal state ${dispatch.state}`);
    }

    const evidence = JSON.stringify({
      schemaVersion: terminal === 'cancelled'
        ? 'rorca.governed-retry-cancellation.v1'
        : 'rorca.governed-retry-reconciliation.v1',
      reason: input.reason.slice(0, 512),
      source: input.source.slice(0, 128),
      previewHash: preview.preview_hash,
      dispatchIdentityHash: dispatch.identity_hash,
      retryRunId: input.runId,
      priorPreviewStatus: preview.status,
      priorPreparationState: preview.preparation_state,
      priorDispatchState: dispatch.state,
      priorRunStatus: run.status,
    });
    await client.query(
      `UPDATE governed_retry_story_attempts
          SET state = $2, cancellation_evidence = CASE WHEN $2 = 'cancelled' THEN $3::jsonb ELSE cancellation_evidence END,
              cancelled_at = CASE WHEN $2 = 'cancelled' THEN COALESCE(cancelled_at, NOW()) ELSE cancelled_at END,
              failure_evidence = CASE WHEN $2 = 'failed' THEN $3::jsonb ELSE failure_evidence END
        WHERE dispatch_identity_hash = $1 AND state IN ('pending','executing')`,
      [dispatch.identity_hash, terminal === 'cancelled' ? 'cancelled' : 'failed', evidence],
    );
    await client.query(
      `UPDATE governed_retry_dispatches
          SET state = $2, cancellation_evidence = CASE WHEN $2 = 'cancelled' THEN $3::jsonb ELSE cancellation_evidence END,
              cancelled_at = CASE WHEN $2 = 'cancelled' THEN COALESCE(cancelled_at, NOW()) ELSE cancelled_at END,
              failure_evidence = CASE WHEN $2 = 'failed' THEN $3::jsonb ELSE failure_evidence END,
              lease_owner = NULL, lease_expires_at = NULL, launch_pid = NULL, launch_token_hash = NULL
        WHERE identity_hash = $1 AND state IN ('prepared','dispatched','claimed','executing')`,
      [dispatch.identity_hash, terminal === 'cancelled' ? 'cancelled' : 'failed', evidence],
    );
    await client.query(
      `UPDATE pipeline_retry_previews
          SET status = $2, preparation_state = $3,
              cancelled_at = CASE WHEN $2 = 'cancelled' THEN COALESCE(cancelled_at, NOW()) ELSE cancelled_at END,
              cancellation_evidence = CASE WHEN $2 = 'cancelled' THEN $4::jsonb ELSE cancellation_evidence END,
              refusal_reason = CASE WHEN $2 = 'refused' THEN $5 ELSE refusal_reason END,
              preparation_owner = NULL, preparation_lease_expires_at = NULL
        WHERE preview_hash = $1 AND status IN ('approved','dispatched')`,
      [preview.preview_hash, terminal === 'cancelled' ? 'cancelled' : 'refused', terminal === 'cancelled' ? 'cancelled' : 'refused', evidence, input.reason.slice(0, 512)],
    );
    await client.query(
      `UPDATE run_pty_sessions
          SET status = 'killed', exit_signal = COALESCE(exit_signal, 'SIGTERM'),
              exited_at = COALESCE(exited_at, NOW()), updated_at = NOW()
        WHERE run_id = $1 AND status IN ('starting','active')`,
      [input.runId],
    );
    await client.query(
      `UPDATE pipeline_runs
          SET summary = $2,
              lifecycle_diagnostics = lifecycle_diagnostics || $3::jsonb
        WHERE id = $1`,
      [input.runId, input.reason.slice(0, 512), JSON.stringify({ owner: 'governed_retry_terminalizer', source: input.source })],
    );
    const closeout = await terminalizePreparedHostRunCloseout(client, preparedCloseout);
    await client.query(
      `INSERT INTO wal_events (event_type, workspace_id, run_id, payload, ingest_key)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (ingest_key) WHERE ingest_key IS NOT NULL DO NOTHING`,
      [
        terminal === 'cancelled' ? 'run_cancelled' : 'governed_retry_failed',
        input.workspaceId,
        input.runId,
        JSON.stringify({
          schemaVersion: 'rorca.governed-retry-terminalization.v1',
          terminal,
          reason: input.reason,
          previewHash: preview.preview_hash,
          dispatchIdentityHash: dispatch.identity_hash,
          hostCloseoutEventId: closeout.id,
          hostCloseoutIdentityHash: closeout.identityHash,
        }),
        `governed-retry-terminal:${dispatch.identity_hash}:${terminal}`,
      ],
    );
    return {
      outcome: 'terminalized' as const,
      terminal,
      previewHash: preview.preview_hash,
      dispatchIdentityHash: dispatch.identity_hash,
      bossJobId: dispatch.boss_job_id,
    };
  });
}

export interface CancelGovernedRetryResult {
  cancelled: boolean;
  duplicate: boolean;
  terminal: 'cancelled' | 'refused';
  retryRunId: number | null;
  dispatchIdentityHash: string | null;
}

/** Transactionally terminalize every still-queued Rorca-owned retry record. */
export async function cancelGovernedRetryPreview(input: {
  previewHash: string;
  originalRunId: number;
  workspaceId: string;
  packet: RetryPreviewPacket;
  previewIdentityHash: string;
  expiresAt: string;
  reason?: string;
  requireExisting?: boolean;
}): Promise<CancelGovernedRetryResult> {
  return transaction(async (client) => {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`retry-preview:${input.previewHash}`],
    );
    let insertedCancellation = false;
    let previewResult = await client.query<{
      status: string;
      preparation_state: RetryPreparationState;
      retry_run_id: string | number | null;
      original_run_id: string | number;
      workspace_id: string;
      packet: RetryPreviewPacket;
    }>(
      `SELECT status, preparation_state, retry_run_id, original_run_id, workspace_id, packet
       FROM pipeline_retry_previews WHERE preview_hash = $1 FOR UPDATE`,
      [input.previewHash],
    );
    let preview = previewResult.rows[0];
    if (!preview && input.requireExisting) {
      throw new GovernedRetryStateConflictError('Expired retry cancellation identity has no matching durable preparation');
    }
    if (!preview) {
      previewResult = await client.query(
        `INSERT INTO pipeline_retry_previews (
           preview_hash, original_run_id, workspace_id, scope_hash, status, packet,
           preview_identity_hash, expires_at, preparation_state, cancelled_at,
           cancellation_evidence
         ) VALUES ($1,$2,$3,$4,'cancelled',$5::jsonb,$6,$7,'cancelled',NOW(),$8::jsonb)
         RETURNING status, preparation_state, retry_run_id, original_run_id, workspace_id, packet`,
        [
          input.previewHash,
          input.originalRunId,
          input.workspaceId,
          retryHash(input.packet.scope.executable.map((entry) => entry.storyId)),
          JSON.stringify(input.packet),
          input.previewIdentityHash,
          input.expiresAt,
          JSON.stringify({
            schemaVersion: 'rorca.governed-retry-cancellation.v1',
            reason: input.reason ?? 'operator_cancelled_preview',
            previewHash: input.previewHash,
            originalRunId: input.originalRunId,
            retryRunId: null,
            dispatchIdentityHash: null,
            priorPreviewStatus: null,
            priorPreparationState: null,
            priorDispatchState: null,
            priorRunStatus: null,
          }),
        ],
      );
      preview = previewResult.rows[0];
      insertedCancellation = true;
    }
    const identityMismatches = [
      ...(Number(preview.original_run_id) !== input.originalRunId ? ['originalRunId'] : []),
      ...(preview.workspace_id !== input.workspaceId ? ['workspaceId'] : []),
      ...(retryHash(preview.packet) !== retryHash(input.packet) ? ['packetHash'] : []),
    ];
    if (identityMismatches.length > 0) {
      throw new GovernedRetryStateConflictError(
        `Stored retry preview does not match cancellation authority (${identityMismatches.join(', ')})`,
      );
    }

    const dispatchResult = await client.query<{
      identity_hash: string;
      state: string;
      retry_run_id: string | number;
    }>(
      `SELECT identity_hash, state, retry_run_id
       FROM governed_retry_dispatches WHERE preview_hash = $1 FOR UPDATE`,
      [input.previewHash],
    );
    const dispatch = dispatchResult.rows[0];
    const retryRunId = preview.retry_run_id == null ? null : Number(preview.retry_run_id);
    const runResult = retryRunId == null
      ? { rows: [] as Array<{ status: string }> }
      : await client.query<{ status: string }>('SELECT status FROM pipeline_runs WHERE id = $1 FOR UPDATE', [retryRunId]);
    const runStatus = runResult.rows[0]?.status ?? null;

    if (preview.status === 'cancelled' && !insertedCancellation) {
      return { cancelled: true, duplicate: true, terminal: 'cancelled', retryRunId, dispatchIdentityHash: dispatch?.identity_hash ?? null };
    }
    if (preview.status === 'refused') {
      return { cancelled: false, duplicate: true, terminal: 'refused', retryRunId, dispatchIdentityHash: dispatch?.identity_hash ?? null };
    }
    if (dispatch && !['prepared', 'dispatched'].includes(dispatch.state)) {
      throw new GovernedRetryStateConflictError(`Retry dispatch is already ${dispatch.state} and cannot be preview-cancelled`);
    }
    if (retryRunId !== null && runStatus !== 'queued') {
      throw new GovernedRetryStateConflictError(`Retry run is already ${runStatus ?? 'missing'} and cannot be preview-cancelled`);
    }

    const evidence = {
      schemaVersion: 'rorca.governed-retry-cancellation.v1',
      reason: input.reason ?? 'operator_cancelled_preview',
      previewHash: input.previewHash,
      originalRunId: input.originalRunId,
      retryRunId,
      dispatchIdentityHash: dispatch?.identity_hash ?? null,
      priorPreviewStatus: preview.status,
      priorPreparationState: preview.preparation_state,
      priorDispatchState: dispatch?.state ?? null,
      priorRunStatus: runStatus,
    };
    const encodedEvidence = JSON.stringify(evidence);

    if (dispatch) {
      await client.query(
        `UPDATE governed_retry_story_attempts
         SET state = 'cancelled', cancellation_evidence = $2::jsonb, cancelled_at = NOW()
         WHERE dispatch_identity_hash = $1 AND state = 'pending'`,
        [dispatch.identity_hash, encodedEvidence],
      );
      await client.query(
        `UPDATE governed_retry_dispatches
         SET state = 'cancelled', cancellation_evidence = $2::jsonb, cancelled_at = NOW(),
             lease_owner = NULL, lease_expires_at = NULL
         WHERE identity_hash = $1 AND state IN ('prepared', 'dispatched')`,
        [dispatch.identity_hash, encodedEvidence],
      );
    }
    if (retryRunId !== null) {
      await client.query(
        `UPDATE pipeline_runs
         SET status = 'cancelled', finished_at = COALESCE(finished_at, NOW()),
             summary = COALESCE(summary, 'retry_preview_cancelled'), lifecycle_status = 'cancelled',
             lifecycle_updated_at = NOW(),
             lifecycle_diagnostics = lifecycle_diagnostics || $2::jsonb
         WHERE id = $1 AND status = 'queued'`,
        [retryRunId, JSON.stringify({ owner: 'retry_preview_cancellation', previewHash: input.previewHash })],
      );
    }
    await client.query(
      `UPDATE pipeline_retry_previews
       SET status = 'cancelled', preparation_state = 'cancelled', cancelled_at = NOW(),
           cancellation_evidence = $2::jsonb, preparation_owner = NULL,
           preparation_lease_expires_at = NULL
       WHERE preview_hash = $1 AND status IN ('previewed', 'approved', 'dispatched')`,
      [input.previewHash, encodedEvidence],
    );
    await client.query(
      `INSERT INTO wal_events (event_type, workspace_id, payload, ingest_key)
       VALUES ('retry_preview_cancelled', $1, $2::jsonb, $3)
       ON CONFLICT (ingest_key) WHERE ingest_key IS NOT NULL DO NOTHING`,
      [input.workspaceId, encodedEvidence, `governed-retry-cancel:${input.previewHash}`],
    );
    return { cancelled: true, duplicate: false, terminal: 'cancelled', retryRunId, dispatchIdentityHash: dispatch?.identity_hash ?? null };
  });
}

/**
 * Deterministically refuse an expired/stale preparation after its owner lease
 * has elapsed. Exact stored packet and identity hashes are required, so an
 * unrelated request cannot terminalize another approval.
 */
export async function refuseAbandonedGovernedRetryPreparation(input: {
  previewHash: string;
  originalRunId: number;
  workspaceId: string;
  packetHash: string;
  previewIdentityHash: string;
  reason: string;
}): Promise<boolean> {
  return transaction(async (client) => {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`retry-preview:${input.previewHash}`],
    );
    const previewResult = await client.query<{
      status: string; retry_run_id: string | number | null; preparation_owner: string | null;
      preparation_lease_live: boolean; original_run_id: string | number;
      workspace_id: string; packet: RetryPreviewPacket; preview_identity_hash: string | null;
    }>(
      `SELECT status, retry_run_id, preparation_owner,
              (preparation_owner IS NOT NULL AND preparation_lease_expires_at > NOW()) AS preparation_lease_live,
              original_run_id, workspace_id, packet, preview_identity_hash
       FROM pipeline_retry_previews WHERE preview_hash = $1 FOR UPDATE`,
      [input.previewHash],
    );
    const preview = previewResult.rows[0];
    if (!preview || preview.status !== 'approved') return false;
    if (
      Number(preview.original_run_id) !== input.originalRunId
      || preview.workspace_id !== input.workspaceId
      || retryHash(preview.packet) !== input.packetHash
      || preview.preview_identity_hash !== input.previewIdentityHash
    ) return false;
    if (preview.preparation_lease_live) return false;

    const dispatchResult = await client.query<{ identity_hash: string; state: string }>(
      `SELECT identity_hash, state FROM governed_retry_dispatches
       WHERE preview_hash = $1 FOR UPDATE`,
      [input.previewHash],
    );
    const dispatch = dispatchResult.rows[0];
    const retryRunId = preview.retry_run_id == null ? null : Number(preview.retry_run_id);
    if (retryRunId !== null) {
      await client.query('SELECT status FROM pipeline_runs WHERE id = $1 FOR UPDATE', [retryRunId]);
    }
    const evidence = JSON.stringify({
      schemaVersion: 'rorca.governed-retry-preparation-refusal.v1',
      previewHash: input.previewHash,
      originalRunId: input.originalRunId,
      retryRunId,
      reason: input.reason,
      recoveredAfterOwnerLease: true,
    });
    if (dispatch && ['prepared', 'dispatched'].includes(dispatch.state)) {
      await client.query(
        `UPDATE governed_retry_story_attempts SET state = 'failed', failure_evidence = $2::jsonb
         WHERE dispatch_identity_hash = $1 AND state = 'pending'`,
        [dispatch.identity_hash, evidence],
      );
      await client.query(
        `UPDATE governed_retry_dispatches
         SET state = 'failed', failure_evidence = $2::jsonb,
             lease_owner = NULL, lease_expires_at = NULL
         WHERE identity_hash = $1 AND state IN ('prepared', 'dispatched')`,
        [dispatch.identity_hash, evidence],
      );
    }
    if (retryRunId !== null) {
      await client.query(
        `UPDATE pipeline_runs
         SET status = 'cancelled', finished_at = COALESCE(finished_at, NOW()), summary = $2,
             lifecycle_status = 'cancelled', lifecycle_updated_at = NOW(),
             lifecycle_diagnostics = lifecycle_diagnostics || $3::jsonb
         WHERE id = $1 AND status = 'queued'`,
        [retryRunId, input.reason, JSON.stringify({ owner: 'retry_abandoned_preparation_refusal', previewHash: input.previewHash })],
      );
    }
    await client.query(
      `UPDATE pipeline_retry_previews
       SET status = 'refused', preparation_state = 'refused', refusal_reason = $2,
           preparation_owner = NULL, preparation_lease_expires_at = NULL
       WHERE preview_hash = $1 AND status = 'approved'`,
      [input.previewHash, input.reason],
    );
    await client.query(
      `INSERT INTO wal_events (event_type, workspace_id, payload, ingest_key)
       VALUES ('retry_preparation_refused', $1, $2::jsonb, $3)
       ON CONFLICT (ingest_key) WHERE ingest_key IS NOT NULL DO NOTHING`,
      [input.workspaceId, evidence, `governed-retry-refused:${input.previewHash}`],
    );
    return true;
  });
}

/**
 * Atomically refuse a published retry before any worker owns the agent boundary.
 * All deterministic validation failures use this path so preview, dispatch,
 * attempts, and run cannot disagree after pg-boss exhausts retries.
 */
export async function refusePublishedGovernedRetryBeforeClaim(input: {
  previewHash: string;
  dispatchIdentityHash: string;
  retryRunId: number;
  workspaceId: string;
  reason: string;
}): Promise<boolean> {
  return transaction(async client => {
    const previewResult = await client.query<{ status: string; preparation_state: string }>(
      `SELECT status, preparation_state FROM pipeline_retry_previews
        WHERE preview_hash = $1 FOR UPDATE`,
      [input.previewHash],
    );
    const dispatchResult = await client.query<{ state: string }>(
      `SELECT state FROM governed_retry_dispatches
        WHERE identity_hash = $1 AND preview_hash = $2 AND retry_run_id = $3
        FOR UPDATE`,
      [input.dispatchIdentityHash, input.previewHash, input.retryRunId],
    );
    const runResult = await client.query<{ status: string }>(
      'SELECT status FROM pipeline_runs WHERE id = $1 FOR UPDATE',
      [input.retryRunId],
    );
    const preview = previewResult.rows[0];
    const dispatch = dispatchResult.rows[0];
    const run = runResult.rows[0];
    if (preview?.status === 'cancelled' || dispatch?.state === 'cancelled' || run?.status === 'cancelled') return false;
    if (preview?.status === 'refused' && dispatch?.state === 'failed' && run?.status === 'failed') return true;
    if (preview?.status !== 'dispatched'
      || preview.preparation_state !== 'published'
      || dispatch?.state !== 'dispatched'
      || run?.status !== 'queued') return false;

    const evidence = JSON.stringify({
      schemaVersion: 'rorca.governed-retry-preclaim-refusal.v1',
      previewHash: input.previewHash,
      dispatchIdentityHash: input.dispatchIdentityHash,
      retryRunId: input.retryRunId,
      reason: input.reason,
    });
    await client.query(
      `UPDATE governed_retry_story_attempts
          SET state = 'failed', failure_evidence = $2::jsonb
        WHERE dispatch_identity_hash = $1 AND state = 'pending'`,
      [input.dispatchIdentityHash, evidence],
    );
    await client.query(
      `UPDATE governed_retry_dispatches
          SET state = 'failed', failure_evidence = $2::jsonb,
              lease_owner = NULL, lease_expires_at = NULL
        WHERE identity_hash = $1 AND state = 'dispatched'`,
      [input.dispatchIdentityHash, evidence],
    );
    await client.query(
      `UPDATE pipeline_retry_previews
          SET status = 'refused', preparation_state = 'refused', refusal_reason = $2,
              preparation_owner = NULL, preparation_lease_expires_at = NULL
        WHERE preview_hash = $1 AND status = 'dispatched' AND preparation_state = 'published'`,
      [input.previewHash, input.reason],
    );
    await client.query(
      `UPDATE pipeline_runs
          SET status = 'failed', finished_at = COALESCE(finished_at, NOW()), summary = $2,
              lifecycle_status = 'failed', lifecycle_updated_at = NOW(),
              lifecycle_diagnostics = lifecycle_diagnostics || $3::jsonb
        WHERE id = $1 AND status = 'queued'`,
      [
        input.retryRunId,
        input.reason,
        JSON.stringify({ owner: 'retry_preclaim_refusal', previewHash: input.previewHash }),
      ],
    );
    await client.query(
      `INSERT INTO wal_events (event_type, workspace_id, payload, ingest_key)
       VALUES ('retry_preclaim_refused', $1, $2::jsonb, $3)
       ON CONFLICT (ingest_key) WHERE ingest_key IS NOT NULL DO NOTHING`,
      [input.workspaceId, evidence, `governed-retry-preclaim-refused:${input.previewHash}`],
    );
    return true;
  });
}

/** Fail closed only while this API request still owns an unpublished preparation. */
export async function refuseGovernedRetryPreparation(input: {
  previewHash: string;
  owner: string;
  retryRunId: number;
  workspaceId: string;
  reason: string;
}): Promise<boolean> {
  return transaction(async (client) => {
    const previewResult = await client.query<{ status: string; preparation_owner: string | null }>(
      `SELECT status, preparation_owner FROM pipeline_retry_previews
       WHERE preview_hash = $1 FOR UPDATE`,
      [input.previewHash],
    );
    const preview = previewResult.rows[0];
    const dispatchResult = await client.query<{ identity_hash: string; state: string }>(
      `SELECT identity_hash, state FROM governed_retry_dispatches
       WHERE preview_hash = $1 FOR UPDATE`,
      [input.previewHash],
    );
    const dispatch = dispatchResult.rows[0];
    await client.query('SELECT status FROM pipeline_runs WHERE id = $1 FOR UPDATE', [input.retryRunId]);
    if (!preview || preview.status !== 'approved' || preview.preparation_owner !== input.owner) return false;

    const evidence = JSON.stringify({
      schemaVersion: 'rorca.governed-retry-preparation-refusal.v1',
      previewHash: input.previewHash,
      retryRunId: input.retryRunId,
      reason: input.reason,
    });
    if (dispatch?.state === 'prepared') {
      await client.query(
        `UPDATE governed_retry_story_attempts SET state = 'failed', failure_evidence = $2::jsonb
         WHERE dispatch_identity_hash = $1 AND state = 'pending'`,
        [dispatch.identity_hash, evidence],
      );
      await client.query(
        `UPDATE governed_retry_dispatches
         SET state = 'failed', failure_evidence = $2::jsonb,
             lease_owner = NULL, lease_expires_at = NULL
         WHERE identity_hash = $1 AND state = 'prepared'`,
        [dispatch.identity_hash, evidence],
      );
    }
    await client.query(
      `UPDATE pipeline_runs
       SET status = 'cancelled', finished_at = COALESCE(finished_at, NOW()), summary = $2,
           lifecycle_status = 'cancelled', lifecycle_updated_at = NOW(),
           lifecycle_diagnostics = lifecycle_diagnostics || $3::jsonb
       WHERE id = $1 AND status = 'queued'`,
      [input.retryRunId, input.reason, JSON.stringify({ owner: 'retry_preparation_refusal', previewHash: input.previewHash })],
    );
    await client.query(
      `UPDATE pipeline_retry_previews
       SET status = 'refused', preparation_state = 'refused', refusal_reason = $2,
           preparation_owner = NULL, preparation_lease_expires_at = NULL
       WHERE preview_hash = $1 AND status = 'approved' AND preparation_owner = $3`,
      [input.previewHash, input.reason, input.owner],
    );
    await client.query(
      `INSERT INTO wal_events (event_type, workspace_id, payload, ingest_key)
       VALUES ('retry_preparation_refused', $1, $2::jsonb, $3)
       ON CONFLICT (ingest_key) WHERE ingest_key IS NOT NULL DO NOTHING`,
      [input.workspaceId, evidence, `governed-retry-refused:${input.previewHash}`],
    );
    return true;
  });
}
