/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Host-only recovery for committed, locally unreleased integrated passes. */

import * as fs from 'fs';
import * as path from 'path';
import { query } from '../db/index';
import { markStoryPassed } from './execution-engine';
import { deriveRunSpecPath, assertRunSpecAuthorityProjection } from './run-spec-snapshot';
import {
  assertCanonicalRunCheckout,
  assertOrderedCommitAncestry,
  isSupportedGitCommitSha,
} from './run-git-authority';
import {
  assertExactTrustedWalRow,
  relayTrustedWalEvent,
  trustedWalReference,
  type TrustedWalRow,
} from './trusted-wal';

interface RecoveryCandidate {
  wal_id: number;
  wal_ts: string;
  event_type: string;
  workspace_id: string;
  spec_id: string;
  story_id: string;
  actor: string;
  payload: Record<string, unknown> | string;
  ingest_key: string;
  trust_provenance: 'host';
  trusted_source: 'story-result';
  canonical_run_id: number | string;
  story_result_id: number | string;
  event_identity_hash: string;
  outbox_ready_at: string | null;
  outbox_relayed_at: string | null;
  result_status: string;
  result_integrated: boolean;
  result_commit_sha: string | null;
  result_commit_message: string | null;
  result_commit_author: string | null;
  result_commit_branch: string | null;
  result_commit_source: string | null;
  result_closeout_id: string | null;
  result_manifest_hash: string | null;
  result_provenance: string;
  result_source: string;
  run_workspace_id: string;
  run_spec_path: string;
  run_worktree_path: string | null;
  run_branch_name: string | null;
  run_auto_worktree: boolean | null;
  run_retried_from_id: number | string | null;
  run_expected_story_ids: string[] | null;
  run_excluded_story_ids: string[] | null;
  workspace_path: string;
  closeout_status: string | null;
  closeout_manifest_hash: string | null;
  closeout_workspace_id: string | null;
  closeout_spec_id: string | null;
  closeout_run_id: number | string | null;
  closeout_story_id: string | null;
  commit_sha: string | null;
  commit_message: string | null;
  commit_author: string | null;
  commit_branch: string | null;
  commit_source: string | null;
  commit_count: number | string;
  outbox_count: number | string;
  attestation_id: string | null;
  attestation_digest: string | null;
  attestation_passed_at: string | null;
  attestation_expires_at: string | null;
  attestation_revoked_at: string | null;
  attestation_count: number | string;
}

export interface PassRecoveryBlocked {
  walEventId: number;
  runId: number;
  storyId: string;
  reason: string;
}

export interface PassRecoveryResult {
  scanned: number;
  recovered: number;
  alreadyProjected: number;
  blocked: PassRecoveryBlocked[];
  truncated: boolean;
}

interface RecoveryChainRow {
  id: number | string;
  story_id: string;
  commit_sha: string;
  commit_branch: string;
  result_provenance: string;
  result_source: string;
  integrated: boolean;
  closeout_decision_id: string | null;
  closeout_status: string | null;
  closeout_manifest_hash: string | null;
  manifest_hash: string | null;
  projected_commit_sha: string | null;
  projected_commit_branch: string | null;
  commit_count: number | string;
  outbox_count: number | string;
  attestation_count: number | string;
}

export interface PassRecoveryOptions {
  runId?: number;
  limit?: number;
}

function walRow(row: RecoveryCandidate): TrustedWalRow {
  return {
    id: Number(row.wal_id),
    ts: String(row.wal_ts),
    event_type: row.event_type,
    workspace_id: row.workspace_id,
    spec_id: row.spec_id,
    story_id: row.story_id,
    actor: row.actor,
    payload: typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload),
    ingest_key: row.ingest_key,
    trust_provenance: row.trust_provenance,
    trusted_source: row.trusted_source,
    canonical_run_id: row.canonical_run_id,
    story_result_id: row.story_result_id,
    event_identity_hash: row.event_identity_hash,
    outbox_ready_at: row.outbox_ready_at,
    outbox_relayed_at: row.outbox_relayed_at,
  };
}

function parsePayload(value: RecoveryCandidate['payload']): Record<string, unknown> | null {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
    return parsed && !Array.isArray(parsed) && typeof parsed === 'object'
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function assertExactRepositorySuccessorState(candidate: RecoveryCandidate): Promise<string[]> {
  if (!candidate.run_branch_name || candidate.result_commit_branch !== candidate.run_branch_name) {
    throw new Error('integrated pass branch differs from pipeline run authority');
  }
  const checkout = assertCanonicalRunCheckout({
    cwd: candidate.run_worktree_path ?? candidate.workspace_path,
    repositoryTopLevel: candidate.workspace_path,
    branchName: candidate.run_branch_name,
  });
  const chain = await query<RecoveryChainRow>(`
    SELECT sr.id, sr.story_id, sr.commit_sha, sr.commit_branch,
           sr.result_provenance, sr.result_source, sr.integrated,
           sr.closeout_decision_id,
           scd.status AS closeout_status,
           scd.manifest_hash AS closeout_manifest_hash, sr.manifest_hash,
           sc.commit_sha AS projected_commit_sha,
           sc.branch_name AS projected_commit_branch,
           (SELECT COUNT(*) FROM story_commits exact_sc
             WHERE exact_sc.workspace_id = pr.workspace_id AND exact_sc.spec_id = sr.spec_id
               AND exact_sc.run_id = sr.run_id AND exact_sc.story_id = sr.story_id
               AND exact_sc.commit_sha = sr.commit_sha) AS commit_count,
           (SELECT COUNT(*) FROM wal_events exact_w
             WHERE exact_w.trust_provenance = 'host' AND exact_w.trusted_source = 'story-result'
               AND exact_w.event_type = 'story_passed' AND exact_w.story_result_id = sr.id) AS outbox_count,
           (SELECT COUNT(*) FROM checkpoint_validation_attestations exact_a
             WHERE exact_a.workspace_id = pr.workspace_id AND exact_a.run_id = sr.run_id
               AND exact_a.story_id = sr.story_id AND exact_a.branch_name = sr.commit_branch
               AND exact_a.checkpoint_sha = sr.commit_sha AND exact_a.validation_gate = 'execution-engine'
               AND exact_a.revoked_at IS NULL) AS attestation_count
      FROM story_results sr
      JOIN pipeline_runs pr ON pr.id = sr.run_id
      LEFT JOIN story_closeout_decisions scd ON scd.decision_id = sr.closeout_decision_id
      LEFT JOIN story_commits sc ON sc.workspace_id = pr.workspace_id
       AND sc.spec_id = sr.spec_id AND sc.run_id = sr.run_id
       AND sc.story_id = sr.story_id AND sc.commit_sha = sr.commit_sha
     WHERE sr.run_id = $1 AND sr.status = 'pass'
       AND sr.result_provenance = 'host' AND sr.result_source = 'execution-engine'
     ORDER BY sr.id ASC
  `, [Number(candidate.canonical_run_id)]);
  const candidateChainRow = chain.find(row => Number(row.id) === Number(candidate.story_result_id));
  if (!candidateChainRow
    || candidateChainRow.commit_sha.toLowerCase() !== candidate.result_commit_sha?.toLowerCase()) {
    throw new Error('recovery pass is absent from ordered host successor state');
  }
  for (const row of chain) {
    if (!isSupportedGitCommitSha(row.commit_sha)
      || row.commit_branch !== candidate.run_branch_name
      || row.result_provenance !== 'host' || row.result_source !== 'execution-engine'
      || row.integrated !== true || row.closeout_status !== 'accepted'
      || row.closeout_manifest_hash !== row.manifest_hash
      || row.projected_commit_sha !== row.commit_sha
      || row.projected_commit_branch !== row.commit_branch
      || Number(row.commit_count) !== 1 || Number(row.outbox_count) !== 1
      || Number(row.attestation_count) !== 1) {
      throw new Error('ordered host successor state is incomplete or inconsistent');
    }
  }
  const chainIds = chain.map(row => Number(row.id));
  const outboxes = await query<TrustedWalRow>(`
    SELECT * FROM wal_events
     WHERE trust_provenance = 'host' AND trusted_source = 'story-result'
       AND event_type = 'story_passed' AND story_result_id = ANY($1::int[])
     ORDER BY id ASC
  `, [chainIds]);
  for (const row of chain) {
    const exact = outboxes.filter(outbox => Number(outbox.story_result_id) === Number(row.id));
    if (exact.length !== 1) throw new Error('ordered host successor outbox identity is ambiguous');
    assertExactTrustedWalRow(exact[0]);
    const payload = typeof exact[0].payload === 'string'
      ? JSON.parse(exact[0].payload) as Record<string, unknown>
      : exact[0].payload as unknown as Record<string, unknown>;
    if (exact[0].workspace_id !== candidate.workspace_id
      || exact[0].spec_id !== candidate.spec_id
      || exact[0].story_id !== row.story_id
      || Number(exact[0].canonical_run_id) !== Number(candidate.canonical_run_id)
      || Number(payload.story_result_id) !== Number(row.id)
      || String(payload.commit_sha).toLowerCase() !== row.commit_sha.toLowerCase()
      || payload.closeout_decision_id !== row.closeout_decision_id) {
      throw new Error('ordered host successor outbox identity is inconsistent');
    }
  }
  const shas = chain.map(row => row.commit_sha.toLowerCase());
  assertOrderedCommitAncestry(checkout.cwd, shas, checkout.headSha);
  if (shas.at(-1) !== checkout.headSha) {
    throw new Error('canonical run HEAD is not the exact latest host successor');
  }
  return chain.map(row => row.story_id);
}

function assertCandidateIdentity(candidate: RecoveryCandidate): void {
  const runId = Number(candidate.canonical_run_id);
  const resultId = Number(candidate.story_result_id);
  const payload = parsePayload(candidate.payload);
  const sha = candidate.result_commit_sha?.toLowerCase() ?? null;
  if (!Number.isSafeInteger(runId) || runId <= 0
    || !Number.isSafeInteger(resultId) || resultId <= 0
    || !payload
    || candidate.event_type !== 'story_passed'
    || candidate.result_status !== 'pass'
    || candidate.result_integrated !== true
    || candidate.result_provenance !== 'host'
    || candidate.result_source !== 'execution-engine'
    || !isSupportedGitCommitSha(sha)
    || candidate.result_commit_author !== 'rorca-execution-engine'
    || candidate.result_commit_source !== 'worktree_branch'
    || !candidate.result_commit_branch
    || !candidate.run_branch_name
    || candidate.result_commit_branch !== candidate.run_branch_name
    || !candidate.result_commit_message
    || candidate.run_workspace_id !== candidate.workspace_id
    || candidate.closeout_status !== 'accepted'
    || candidate.closeout_workspace_id !== candidate.workspace_id
    || candidate.closeout_spec_id !== candidate.spec_id
    || Number(candidate.closeout_run_id) !== runId
    || candidate.closeout_story_id !== candidate.story_id
    || candidate.closeout_manifest_hash !== candidate.result_manifest_hash
    || candidate.result_closeout_id !== payload.closeout_decision_id
    || Number(payload.run_id) !== runId
    || payload.story_id !== candidate.story_id
    || Number(payload.story_result_id) !== resultId
    || String(payload.commit_sha).toLowerCase() !== sha
    || Number(candidate.commit_count) !== 1
    || candidate.commit_sha?.toLowerCase() !== sha
    || candidate.commit_message !== candidate.result_commit_message
    || candidate.commit_author !== candidate.result_commit_author
    || candidate.commit_branch !== candidate.result_commit_branch
    || candidate.commit_source !== candidate.result_commit_source
    || Number(candidate.outbox_count) !== 1
    || Number(candidate.attestation_count) !== 1
    || !candidate.attestation_id
    || !candidate.attestation_digest
    || !/^[0-9a-f]{64}$/.test(candidate.attestation_digest)
    || candidate.attestation_revoked_at !== null
    || !candidate.attestation_passed_at
    || !candidate.attestation_expires_at
    || Date.parse(candidate.attestation_expires_at) <= Date.now()) {
    throw new Error('unreleased pass identity is incomplete or inconsistent');
  }
  const event = walRow(candidate);
  assertExactTrustedWalRow(event);
  if (event.outbox_ready_at !== null || event.outbox_relayed_at !== null) {
    throw new Error('candidate is not an unreleased pass outbox');
  }
}

function runSpecPath(candidate: RecoveryCandidate): string {
  const source = path.resolve(candidate.workspace_path, candidate.run_spec_path);
  return deriveRunSpecPath({
    runId: Number(candidate.canonical_run_id),
    sourceSpecPath: source,
    workspacePath: candidate.workspace_path,
    worktreePath: candidate.run_worktree_path,
    retry: candidate.run_retried_from_id !== null,
  });
}

async function loadCandidates(options: { runId?: number; limit: number }): Promise<RecoveryCandidate[]> {
  return query<RecoveryCandidate>(`
    SELECT w.id AS wal_id, w.ts AS wal_ts, w.event_type, w.workspace_id,
           w.spec_id, w.story_id, w.actor, w.payload, w.ingest_key,
           w.trust_provenance, w.trusted_source, w.canonical_run_id,
           w.story_result_id, w.event_identity_hash, w.outbox_ready_at,
           w.outbox_relayed_at,
           sr.status AS result_status, sr.integrated AS result_integrated,
           sr.commit_sha AS result_commit_sha,
           sr.commit_message AS result_commit_message,
           sr.commit_author AS result_commit_author,
           sr.commit_branch AS result_commit_branch,
           sr.commit_observed_source AS result_commit_source,
           sr.closeout_decision_id AS result_closeout_id,
           sr.manifest_hash AS result_manifest_hash,
           sr.result_provenance, sr.result_source,
           pr.workspace_id AS run_workspace_id, pr.spec_path AS run_spec_path,
           pr.worktree_path AS run_worktree_path, pr.branch_name AS run_branch_name,
           pr.auto_worktree AS run_auto_worktree,
           pr.retried_from_run_id AS run_retried_from_id,
           pr.expected_story_ids AS run_expected_story_ids,
           COALESCE(pr.excluded_story_ids, '{}'::text[]) AS run_excluded_story_ids,
           ws.path AS workspace_path,
           scd.status AS closeout_status, scd.manifest_hash AS closeout_manifest_hash,
           scd.workspace_id AS closeout_workspace_id, scd.spec_id AS closeout_spec_id,
           scd.run_id AS closeout_run_id, scd.story_id AS closeout_story_id,
           commit_row.commit_sha, commit_row.commit_message,
           commit_row.author AS commit_author, commit_row.branch_name AS commit_branch,
           commit_row.observed_source AS commit_source,
           (SELECT COUNT(*) FROM story_commits sc_count
             WHERE sc_count.workspace_id = w.workspace_id
               AND sc_count.spec_id = w.spec_id
               AND sc_count.run_id = w.canonical_run_id
               AND sc_count.story_id = w.story_id
               AND sc_count.commit_sha = sr.commit_sha) AS commit_count,
           (SELECT COUNT(*) FROM wal_events w_count
             WHERE w_count.trust_provenance = 'host'
               AND w_count.trusted_source = 'story-result'
               AND w_count.story_result_id = sr.id) AS outbox_count,
           att.id AS attestation_id, att.evidence_digest AS attestation_digest,
           att.passed_at AS attestation_passed_at,
           att.expires_at AS attestation_expires_at,
           att.revoked_at AS attestation_revoked_at,
           COALESCE(att.attestation_count, 0) AS attestation_count
      FROM wal_events w
      JOIN story_results sr ON sr.id = w.story_result_id
      JOIN pipeline_runs pr ON pr.id = w.canonical_run_id
      JOIN workspaces ws ON ws.id = w.workspace_id
      LEFT JOIN story_closeout_decisions scd
        ON scd.decision_id = sr.closeout_decision_id
      LEFT JOIN story_commits commit_row
        ON commit_row.workspace_id = w.workspace_id
       AND commit_row.spec_id = w.spec_id
       AND commit_row.run_id = w.canonical_run_id
       AND commit_row.story_id = w.story_id
       AND commit_row.commit_sha = sr.commit_sha
      LEFT JOIN LATERAL (
        SELECT a.id, a.evidence_digest, a.passed_at, a.expires_at, a.revoked_at,
               COUNT(*) OVER() AS attestation_count
          FROM checkpoint_validation_attestations a
         WHERE a.workspace_id = w.workspace_id
           AND a.run_id = w.canonical_run_id
           AND a.story_id = w.story_id
           AND a.branch_name = sr.commit_branch
           AND a.checkpoint_sha = sr.commit_sha
           AND a.validation_gate = 'execution-engine'
         ORDER BY a.passed_at DESC
         LIMIT 1
      ) att ON TRUE
     WHERE w.trust_provenance = 'host'
       AND w.trusted_source = 'story-result'
       AND w.event_type = 'story_passed'
       AND w.outbox_ready_at IS NULL
       AND w.outbox_relayed_at IS NULL
       AND ($1::bigint = 0 OR w.canonical_run_id = $1)
     ORDER BY w.id ASC
     LIMIT $2
  `, [options.runId ?? 0, options.limit + 1]);
}

/**
 * Cross result->file->ready crash boundaries without guessing. Any row that
 * cannot be proven exact remains inert and is returned as a terminal blocker.
 */
export async function recoverUnreleasedIntegratedPasses(
  options: PassRecoveryOptions = {},
): Promise<PassRecoveryResult> {
  if (process.env.NODE_ENV !== 'test' && process.env.RORCA_PROCESS_ROLE !== 'worker') {
    throw new Error('Integrated pass recovery requires worker process authority');
  }
  const limit = options.limit ?? 2_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    throw new RangeError('Pass recovery limit must be between 1 and 10000');
  }
  if (options.runId !== undefined && (!Number.isSafeInteger(options.runId) || options.runId <= 0)) {
    throw new RangeError('Pass recovery runId must be a positive integer');
  }
  const loaded = await loadCandidates({ runId: options.runId, limit });
  const truncated = loaded.length > limit;
  const candidates = loaded.slice(0, limit);
  const result: PassRecoveryResult = {
    scanned: candidates.length,
    recovered: 0,
    alreadyProjected: 0,
    blocked: [],
    truncated,
  };

  for (const candidate of candidates) {
    try {
      assertCandidateIdentity(candidate);
      const hostSuccessorStoryIds = await assertExactRepositorySuccessorState(candidate);
      const specPath = runSpecPath(candidate);
      if (!fs.existsSync(specPath)) throw new Error('run-owned spec snapshot is unavailable');
      const lifecycle = await markStoryPassed(specPath, candidate.story_id);
      if (!lifecycle.storyFound) throw new Error('story is absent from the run-owned spec snapshot');
      if (lifecycle.changed) result.recovered++;
      else result.alreadyProjected++;
      assertRunSpecAuthorityProjection({
        specPath,
        expectedStoryIds: candidate.run_expected_story_ids ?? [],
        excludedStoryIds: candidate.run_excluded_story_ids ?? [],
        authoritativePassedStoryIds: hostSuccessorStoryIds,
      });
      await relayTrustedWalEvent(trustedWalReference(walRow(candidate)));
    } catch (error) {
      result.blocked.push({
        walEventId: Number(candidate.wal_id),
        runId: Number(candidate.canonical_run_id),
        storyId: candidate.story_id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (truncated) {
    result.blocked.push({
      walEventId: 0,
      runId: options.runId ?? 0,
      storyId: '*',
      reason: 'unreleased pass recovery exceeded the bounded scan limit',
    });
  }
  return result;
}

export function passRecoveryBlocksCompletion(result: PassRecoveryResult): boolean {
  return result.truncated || result.blocked.length > 0;
}
