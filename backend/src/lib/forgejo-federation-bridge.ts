/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * W5-005 federation → Forgejo projection bridge. A host-verified Wave 4
 * result proposal (proposal-only, acceptedAsCompletion=false) triggers the
 * Forgejo release-intent path at the EXACT proposed head: draft PR ([WIP])
 * + pending/success commit status. The bridge grants no closeout, merge,
 * deployment, or production authority; replays are idempotent and
 * changed-head proposals are rejected BEFORE any projection.
 */

import { query, queryOne, transaction } from '../db/index';
import { ConflictError } from './errors';
import type { FederatedLeaseBinding, FederatedResultProposal } from './federated-runtime-contracts';
import type { FederatedHostVerification } from './federated-host-verifier';
import {
  prepareForgejoRunReleaseIntent,
  createOrFinalizeForgejoPullRequest,
  type ForgejoPrepareRunReleaseInput,
} from './forgejo-release-authority';
import { getWorkspaceForgejoCredential } from './forgejo-token-credential-provider';
import {
  fetchForgejoWithTimeout,
  resolveWorkspaceForgejoToken,
  scopeForgejoWorkspace,
} from './forgejo-token-credential-provider';
import { forgejoRepoApiUrl } from './forgejo-repository-authority';
import { ForgejoProviderError, forgejoProviderError } from './forgejo-provider-error';
import { withForgejoRepositoryAuthorityLock } from './forgejo-release-identity';
import { logger } from './logger';

export interface ForgejoBridgeInput {
  workspaceId: string;
  proposal: FederatedResultProposal;
  hostVerification: FederatedHostVerification;
  proposalHash: string;
  idempotencyKey: string;
  /** Overrides for the intent input (host authority shape). */
  branchName?: string;
  workspaceRealpath?: string;
  worktreeRealpath?: string;
  baseBranch?: string;
  baseSha?: string;
  /** Frozen run lineage resolved by the caller (host adapter); lets the
   * ledger durably enqueue before the reconcile loop re-derives it. */
  runId?: number | null;
}

export interface ForgejoBridgeReceipt {
  schemaVersion: 'rorca.forgejo-federation-bridge.v1';
  proposalId: string;
  proposalHash: string;
  headSha: string;
  status: 'projected' | 'pending' | 'blocked' | 'rejected_changed_head';
  intentRunId: number | null;
  draftPrNumber: number | null;
  closeoutAuthority: 'none';
  acceptedAsCompletion: false;
  errorCode?: string;
}


function headShas(input: ForgejoBridgeInput): { proposal: string; host: string; expected: string } {
  const binding = input.proposal.binding;
  return {
    proposal: input.proposal.observedHeadSha.toLowerCase(),
    host: input.hostVerification.headSha.toLowerCase(),
    expected: binding.expectedHeadSha.toLowerCase(),
  };
}

/** Load the pipeline run bound to the federated attempt (canonical lineage). */
async function runIdForAttempt(workspaceId: string, attemptId: string): Promise<number | null> {
  const row = await queryOne<{ run_id: number | string }>(
    'SELECT run_id FROM governed_execution_attempts WHERE workspace_id = $1 AND attempt_id = $2',
    [workspaceId, attemptId],
  );
  return row ? Number(row.run_id) : null;
}

export async function bridgeFederatedResultToForgejo(input: ForgejoBridgeInput): Promise<ForgejoBridgeReceipt> {
  const binding: FederatedLeaseBinding = input.proposal.binding;
  const { proposal, host, expected } = headShas(input);
  if (proposal !== expected || host !== expected) {
    await recordProjection(input, 'rejected_changed_head', null, null, 'head_changed');
    return {
      schemaVersion: 'rorca.forgejo-federation-bridge.v1',
      proposalId: input.proposal.proposalId,
      proposalHash: input.proposalHash,
      headSha: expected,
      status: 'rejected_changed_head',
      intentRunId: null,
      draftPrNumber: null,
      closeoutAuthority: 'none',
      acceptedAsCompletion: false,
      errorCode: 'FORGEJO_BRIDGE_CHANGED_HEAD',
    };
  }

  const existing = await ledgerProjection(input.workspaceId, input.proposal.proposalId);
  if (existing) {
    if (existing.status === 'projected') {
      return {
        schemaVersion: 'rorca.forgejo-federation-bridge.v1',
        proposalId: input.proposal.proposalId,
        proposalHash: input.proposalHash,
        headSha: expected,
        status: 'projected',
        intentRunId: existing.intent_run_id == null ? null : Number(existing.intent_run_id),
        draftPrNumber: existing.draft_pr_number == null ? null : Number(existing.draft_pr_number),
        closeoutAuthority: 'none',
        acceptedAsCompletion: false,
      };
    }
    if (existing.status !== 'pending') {
      throw new ConflictError('Forgejo federation projection is already durably blocked', {
        reason: 'forgejo_bridge_replay_conflict',
        retryable: false,
      });
    }
    // A pending ledger row means a prior attempt failed transiently; the
    // reconcile loop re-runs this exact projection (restart-safe).
  }

  const credential = await getWorkspaceForgejoCredential(input.workspaceId);
  if (!credential || credential.status !== 'active') {
    await recordProjection(input, 'pending', input.runId ?? null, null, 'forgejo_credential_unavailable');
    return {
      schemaVersion: 'rorca.forgejo-federation-bridge.v1',
      proposalId: input.proposal.proposalId,
      proposalHash: input.proposalHash,
      headSha: expected,
      status: 'pending',
      intentRunId: input.runId ?? null,
      draftPrNumber: null,
      closeoutAuthority: 'none',
      acceptedAsCompletion: false,
      errorCode: 'FORGEJO_BRIDGE_CREDENTIAL_UNAVAILABLE',
    };
  }

  const runId = input.runId ?? (await runIdForAttempt(input.workspaceId, binding.attemptId));
  if (runId == null) {
    await recordProjection(input, 'pending', null, null, 'run_lineage_missing');
    return {
      schemaVersion: 'rorca.forgejo-federation-bridge.v1',
      proposalId: input.proposal.proposalId,
      proposalHash: input.proposalHash,
      headSha: expected,
      status: 'pending',
      intentRunId: null,
      draftPrNumber: null,
      closeoutAuthority: 'none',
      acceptedAsCompletion: false,
      errorCode: 'FORGEJO_BRIDGE_RUN_LINEAGE_MISSING',
    };
  }

  const intentInput: ForgejoPrepareRunReleaseInput = {
    runId,
    workspaceId: input.workspaceId,
    specId: binding.specId,
    authorizedSha: expected,
    branchName: input.branchName ?? binding.worktreeId,
    workspaceRealpath: input.workspaceRealpath ?? credential.workspaceId,
    worktreeRealpath: input.worktreeRealpath ?? credential.workspaceId,
    baseBranch: input.baseBranch ?? 'main',
    baseSha: input.baseSha ?? binding.baseSha,
    mergeStrategy: 'draft-pr',
    autoMerge: false,
    externalSend: true,
    proposalHash: input.proposalHash,
    changedPathManifestHash: input.hostVerification.changedPathHash ?? null,
  };

  try {
    const identity = await prepareForgejoRunReleaseIntent(intentInput);
    const draftPrNumber = await createOrFinalizeForgejoPullRequest(identity, true);
    await projectBridgeStatus(input, expected);
    await transaction(async (client) => {
      await scopeForgejoWorkspace(client, input.workspaceId);
      await client.query(`
        INSERT INTO forgejo_federation_projections (
          proposal_id, workspace_id, proposal_hash, run_id, head_sha,
          changed_path_manifest_hash, intent_run_id, draft_pr_number, status,
          idempotency_key, proposal_json, host_verification_json
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'projected',$9,$10::jsonb,$11::jsonb)
        ON CONFLICT (proposal_id) DO UPDATE
          SET status = 'projected', intent_run_id = EXCLUDED.intent_run_id,
              draft_pr_number = EXCLUDED.draft_pr_number, error_code = NULL, updated_at = NOW()
          WHERE forgejo_federation_projections.status = 'pending'
      `, [input.proposal.proposalId, input.workspaceId, input.proposalHash, runId, expected,
        input.hostVerification.changedPathHash ?? null, identity.runId, draftPrNumber,
        input.idempotencyKey, JSON.stringify(input.proposal), JSON.stringify(input.hostVerification)]);
    });
    const settled = await ledgerProjection(input.workspaceId, input.proposal.proposalId);
    if (settled?.status !== 'projected') {
      // A concurrent reconciler finalized this proposal differently; report
      // the durable outcome without silently omitting the projection.
      const durableStatus = settled?.status === 'blocked' ? 'blocked' : 'pending';
      return {
        schemaVersion: 'rorca.forgejo-federation-bridge.v1',
        proposalId: input.proposal.proposalId,
        proposalHash: input.proposalHash,
        headSha: expected,
        status: durableStatus,
        intentRunId: runId,
        draftPrNumber: null,
        closeoutAuthority: 'none',
        acceptedAsCompletion: false,
        errorCode: settled?.error_code ?? undefined,
      };
    }
    return {
      schemaVersion: 'rorca.forgejo-federation-bridge.v1',
      proposalId: input.proposal.proposalId,
      proposalHash: input.proposalHash,
      headSha: expected,
      status: 'projected',
      intentRunId: identity.runId,
      draftPrNumber,
      closeoutAuthority: 'none',
      acceptedAsCompletion: false,
    };
  } catch (error) {
    const errorCode = error instanceof Error ? error.message.slice(0, 100) : 'unknown';
    const retryable = isRetryableBridgeError(error);
    await recordProjection(input, retryable ? 'pending' : 'blocked', runId, null, errorCode);
    return {
      schemaVersion: 'rorca.forgejo-federation-bridge.v1',
      proposalId: input.proposal.proposalId,
      proposalHash: input.proposalHash,
      headSha: expected,
      status: retryable ? 'pending' : 'blocked',
      intentRunId: runId,
      draftPrNumber: null,
      closeoutAuthority: 'none',
      acceptedAsCompletion: false,
      errorCode,
    };
  }
}

/** Permanent blocked is reserved for non-retryable authority conflicts only
 * (A5); provider/transient failures enqueue as 'pending' for the reconcile
 * loop instead of silently omitting or permanently burning the proposal. */
function isRetryableBridgeError(error: unknown): boolean {
  if (error instanceof ConflictError) return false;
  const message = error instanceof Error ? error.message : String(error);
  if (/authority|immutable|changed|differs|conflict|not active|revoked|rotated|no merge capability/i.test(message)) {
    return false;
  }
  return true;
}

async function recordProjection(
  input: ForgejoBridgeInput,
  status: 'projected' | 'pending' | 'blocked' | 'rejected_changed_head',
  intentRunId: number | null,
  draftPrNumber: number | null,
  errorCode?: string,
): Promise<void> {
  const binding = input.proposal.binding;
  const runId = intentRunId ?? input.runId ?? (await runIdForAttempt(input.workspaceId, binding.attemptId));
  // Write-once ledger: the first durable outcome is authoritative; a later
  // permanent outcome may terminalize a pending row (trigger-guarded).
  await transaction(async (client) => {
    await scopeForgejoWorkspace(client, input.workspaceId);
    await client.query(`
      INSERT INTO forgejo_federation_projections (
        proposal_id, workspace_id, proposal_hash, run_id, head_sha,
        changed_path_manifest_hash, intent_run_id, draft_pr_number, status, error_code,
        idempotency_key, proposal_json, host_verification_json
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb)
      ON CONFLICT (proposal_id) DO UPDATE
        SET status = EXCLUDED.status,
            error_code = COALESCE(EXCLUDED.error_code, forgejo_federation_projections.error_code),
            updated_at = NOW()
        WHERE forgejo_federation_projections.status = 'pending'
    `, [input.proposal.proposalId, input.workspaceId, input.proposalHash, runId, headShas(input).expected,
      input.hostVerification.changedPathHash ?? null, intentRunId, draftPrNumber, status,
      errorCode ?? null, input.idempotencyKey,
      JSON.stringify(input.proposal), JSON.stringify(input.hostVerification)]);
  });
}

/** Read one ledger row under the exact workspace scope (RLS). */
async function ledgerProjection(workspaceId: string, proposalId: string): Promise<{
  status: string; intent_run_id: number | null; draft_pr_number: number | null; error_code: string | null;
} | null> {
  return transaction(async (client) => {
    await scopeForgejoWorkspace(client, workspaceId);
    const row = (await client.query<{
      status: string; intent_run_id: number | null; draft_pr_number: number | null; error_code: string | null;
    }>(`SELECT status, intent_run_id, draft_pr_number, error_code
          FROM forgejo_federation_projections
         WHERE workspace_id = $1 AND proposal_id = $2`, [workspaceId, proposalId])).rows[0];
    return row ?? null;
  });
}

/** Project a pending 'rorca/pipeline' commit status at the exact head. Runs
 * inside the same frozen repository-actuation lock as the release actuation,
 * re-checks the binding identity/version immediately before the request, and
 * constructs the URL from the resolved token metadata AFTER the equality
 * check (A9) — a rotated credential can never reach the old instance URL. */
async function projectBridgeStatus(input: ForgejoBridgeInput, headSha: string): Promise<void> {
  const binding = input.proposal.binding;
  return withForgejoRepositoryAuthorityLock(input.workspaceId, '', '', async () => {
    const bindingBefore = await getWorkspaceForgejoCredential(input.workspaceId);
    if (!bindingBefore || bindingBefore.status !== 'active') {
      throw new ForgejoProviderError({
        providerStatus: null, code: 'FORGEJO_BRIDGE_CREDENTIAL_CHANGED',
        requestId: null, message: 'Forgejo credential binding changed before status projection',
      });
    }
    const token = await resolveWorkspaceForgejoToken(input.workspaceId, {
      repository: { owner: bindingBefore.owner, name: bindingBefore.name },
      purpose: 'statuses-write',
    });
    if (!token) {
      throw new ForgejoProviderError({
        providerStatus: null, code: 'FORGEJO_BRIDGE_STATUS_TOKEN_UNAVAILABLE',
        requestId: null, message: 'Forgejo status token is unavailable for federation projection',
      });
    }
    // Recheck binding identity/version/instance/owner/name immediately before
    // the request (rotation race fence).
    const bindingAfter = await getWorkspaceForgejoCredential(input.workspaceId);
    if (!bindingAfter
      || bindingAfter.bindingId !== token.metadata.bindingId
      || bindingAfter.credentialVersion !== token.metadata.credentialVersion
      || bindingAfter.instanceUrl.replace(/\/+$/, '') !== token.metadata.instanceUrl.replace(/\/+$/, '')
      || bindingAfter.owner.toLowerCase() !== token.metadata.owner.toLowerCase()
      || bindingAfter.name.toLowerCase() !== token.metadata.name.toLowerCase()) {
      throw new ForgejoProviderError({
        providerStatus: null, code: 'FORGEJO_BRIDGE_ROTATION_RACE',
        requestId: null, message: 'Forgejo credential binding rotated during status projection',
      });
    }
    const owner = token.metadata.owner;
    const name = token.metadata.name;
    const instanceUrl = token.metadata.instanceUrl;
    const runView = `${process.env.RORCA_BASE_URL || 'http://localhost:5210'}/runs/${binding.attemptId}`;
    const headers = { Authorization: `token ${token.token}`, Accept: 'application/json', 'Content-Type': 'application/json' };
    const lookup = await fetchForgejoWithTimeout(fetch,
      forgejoRepoApiUrl(instanceUrl, owner, name, `/statuses/${headSha}`), { headers });
    if (lookup.ok) {
      const existing = await lookup.json().catch(() => null);
      if (Array.isArray(existing) && existing.some((status) =>
        status !== null && typeof status === 'object'
        && 'context' in status && status.context === 'rorca/pipeline')) {
        return;
      }
    }
    const response = await fetchForgejoWithTimeout(fetch,
      forgejoRepoApiUrl(instanceUrl, owner, name, `/statuses/${headSha}`), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          context: 'rorca/pipeline',
          state: 'pending',
          description: `Federated result ${input.proposal.proposalId} proposed at exact head.`,
          target_url: runView,
        }),
      });
    if (!response.ok) throw forgejoProviderError(response, 'FORGEJO_BRIDGE_STATUS_PROJECTION_FAILED');
  });
}

/** Restart-safe reconcile (A5): every 'pending' federation projection is
 * re-run against the exact stored proposal + host verification with the same
 * deterministic idempotency key; each step (unique PR, unique status) is
 * rediscovered by the actuators, so replays never duplicate provider effects. */
export async function reconcilePendingForgejoFederationProjections(limit = 100): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError('Invalid Forgejo federation projection reconciliation limit');
  }
  // FORCE RLS (wave5 hardening) hides every row from an unscoped scan, so
  // enumerate the workspaces from the non-RLS registry and scan each scope
  // under its own workspace GUC — otherwise A4/A5 restart-safety silently
  // no-ops in production.
  const workspaces = await query<{ id: string }>('SELECT id FROM workspaces ORDER BY id');
  let completed = 0;
  for (const workspace of workspaces) {
    const rows = await transaction(async (client) => {
      await scopeForgejoWorkspace(client, workspace.id);
      return (await client.query<{ proposal_id: string; workspace_id: string; idempotency_key: string }>(`
        SELECT proposal_id, workspace_id, idempotency_key FROM forgejo_federation_projections
         WHERE status = 'pending'
         ORDER BY updated_at ASC
         LIMIT $1
      `, [limit])).rows;
    });
    for (const row of rows) {
      try {
        const status = await reconcileForgejoFederationProjection(
          row.workspace_id, row.proposal_id, row.idempotency_key);
        if (status === 'projected') completed += 1;
      } catch (error) {
        // The bridge records the durable outcome itself; a throw here means the
        // ledger write failed, which the periodic loop will re-attempt.
        logger.warn({ error, proposalId: row.proposal_id, workspaceId: row.workspace_id },
          '[ForgejoFederation] Pending projection reconcile deferred');
      }
    }
  }
  return completed;
}

async function reconcileForgejoFederationProjection(
  workspaceId: string,
  proposalId: string,
  idempotencyKey: string,
): Promise<'projected' | 'pending' | 'blocked' | 'rejected_changed_head'> {
  const stored = await transaction(async (client) => {
    await scopeForgejoWorkspace(client, workspaceId);
    return (await client.query<{
      proposal_json: unknown;
      host_verification_json: unknown;
      proposal_hash: string;
      run_id: number | null;
    }>(`SELECT proposal_json, host_verification_json, proposal_hash, run_id
          FROM forgejo_federation_projections
         WHERE workspace_id = $1 AND proposal_id = $2`, [workspaceId, proposalId])).rows[0];
  });
  if (!stored) return 'pending';
  // Reproduce the exact identity the original caller froze (A5): the release
  // intent row carries the branch and worktree paths the first attempt
  // actuated under. Deriving them from the binding alone (workspaceId /
  // worktreeId) would re-freeze a different identity and permanently block
  // the replay against the immutable intent.
  const frozen = stored.run_id == null ? null : await queryOne<{
    branch_name: string | null;
    execution_workspace_path: string | null;
    execution_worktree_path: string | null;
  }>(`SELECT branch_name, execution_workspace_path, execution_worktree_path
        FROM pipeline_run_release_intents
       WHERE run_id = $1`, [stored.run_id]);
  const proposal = stored.proposal_json as FederatedResultProposal;
  const hostVerification = stored.host_verification_json as FederatedHostVerification;
  const receipt = await bridgeFederatedResultToForgejo({
    workspaceId,
    proposal,
    hostVerification,
    proposalHash: stored.proposal_hash,
    idempotencyKey,
    runId: stored.run_id == null ? null : Number(stored.run_id),
    baseBranch: 'main',
    baseSha: proposal.binding.baseSha,
    branchName: frozen?.branch_name ?? proposal.binding.worktreeId,
    workspaceRealpath: frozen?.execution_workspace_path ?? undefined,
    worktreeRealpath: frozen?.execution_worktree_path ?? undefined,
  });
  return receipt.status;
}
