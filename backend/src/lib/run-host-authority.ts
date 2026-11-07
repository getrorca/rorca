/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Frozen-scope, host-only run result authority for completion and release. */

import { createHash } from 'crypto';
import * as path from 'path';
import { query, queryOne } from '../db/index';
import { assertExactTrustedWalRow, stableWalJson, type TrustedWalRow } from './trusted-wal';
import { assertNotProtectedWave1Run } from './wave-1-stabilization';
import {
  assertCanonicalRunCheckout,
  assertOrderedCommitAncestry,
  isSupportedGitCommitSha,
} from './run-git-authority';

interface RunAuthorityRow {
  id: number | string;
  workspace_id: string;
  spec_path: string;
  status: string;
  lifecycle_status: string;
  expected_story_ids: string[] | null;
  excluded_story_ids: string[] | null;
  finished_at: string | null;
  branch_name: string | null;
  worktree_path: string | null;
  execution_workspace_path: string | null;
  execution_worktree_path: string | null;
  retried_from_run_id: number | string | null;
  predecessor_pass_story_ids: string[];
  predecessor_authority_hash: string | null;
  terminal_checkout_sha: string | null;
  terminal_checkout_attested_at: string | null;
  release_authorized_sha: string | null;
  release_execution_workspace_path: string | null;
  release_execution_worktree_path: string | null;
  release_identity_hash: string | null;
  workspace_path: string;
}

interface ResultAuthorityRow {
  id: number | string;
  story_id: string;
  status: string;
  reason: string | null;
  finished_at: string | null;
  spec_id: string | null;
  integrated: boolean;
  commit_sha: string | null;
  commit_message: string | null;
  commit_author: string | null;
  commit_branch: string | null;
  commit_observed_source: string | null;
  closeout_decision_id: string | null;
  manifest_hash: string | null;
  closeout_status: string | null;
  closeout_manifest_hash: string | null;
  projected_commit_sha: string | null;
  projected_commit_message: string | null;
  projected_commit_author: string | null;
  projected_commit_branch: string | null;
  projected_commit_source: string | null;
  commit_count: number | string;
  worktree_path: string | null;
  attestation_count: number | string;
  attestation_id: string | null;
  attestation_digest: string | null;
  attestation_passed_at: string | Date | null;
  attestation_expires_at: string | Date | null;
  attestation_revoked_at: string | null;
  accounting_required: boolean;
  accounting_model: string | null;
  accounting_input_tokens: number | string | null;
  accounting_output_tokens: number | string | null;
  accounting_reasoning_tokens: number | string | null;
  accounting_cost_usd: number | string | null;
  accounting_cost_source: string | null;
  accounting_input_rate: number | string | null;
  accounting_output_rate: number | string | null;
  projected_accounting_model: string | null;
  projected_accounting_input_tokens: number | string | null;
  projected_accounting_output_tokens: number | string | null;
  projected_accounting_reasoning_tokens: number | string | null;
  projected_accounting_cost_usd: number | string | null;
  projected_accounting_cost_source: string | null;
  projected_accounting_input_rate: number | string | null;
  projected_accounting_output_rate: number | string | null;
  accounting_count: number | string;
  result_provenance: string;
  result_source: string;
  host_attempt_envelope_id: string | null;
  host_attempt_authority_state: string | null;
  host_attempt_outcome: string | null;
  host_attempt_outcome_provenance: string | null;
  host_attempt_exit_code: number | null;
  host_attempt_exit_signal: string | null;
  host_attempt_spec_revision: string | null;
  host_attempt_story_revision: string | null;
  host_attempt_canonical_spec_revision: string | null;
  host_attempt_canonical_spec_bytes_hash: string | null;
  host_attempt_run_spec_revision: string | null;
  host_attempt_run_spec_bytes_hash: string | null;
  host_attempt_base_git_sha: string | null;
  host_attempt_expected_git_sha: string | null;
  host_attempt_observed_git_sha: string | null;
  host_attempt_expected_git_branch: string | null;
  host_attempt_worktree_branch: string | null;
}

export interface HostStoryAuthority {
  storyId: string;
  status: 'pass' | 'fail' | 'skip' | 'timeout' | 'excluded';
  reason: string | null;
  finishedAt: string | null;
  resultId: number;
  commitSha: string | null;
}

export interface LinkedPredecessorPass {
  storyId: string;
  resultId: number;
  commitSha: string;
}

export function linkedPredecessorAuthorityHash(runId: number, passes: readonly LinkedPredecessorPass[]): string {
  return createHash('sha256').update(JSON.stringify({
    contractVersion: 'linked-predecessor-host-authority-v1',
    runId,
    passes: [...passes].sort((a, b) => a.storyId.localeCompare(b.storyId)),
  })).digest('hex');
}

export interface RunHostAuthority {
  runId: number;
  workspaceId: string;
  specId: string;
  status: string;
  lifecycleStatus: string;
  finishedAt: string | null;
  branchName: string;
  checkoutPath: string;
  repositoryTopLevel: string;
  expectedStoryIds: string[];
  excludedStoryIds: string[];
  stories: HostStoryAuthority[];
  authoritativePassedStoryIds: string[];
  authoritativePredecessorPasses: LinkedPredecessorPass[];
  finalCommitSha: string | null;
  closeoutEligible: boolean;
  terminalRevision: string | null;
  integrationAncestry: string[];
  acceptedStoryIds: string[];
  complete: boolean;
  releaseEligible: boolean;
  invalidReason: string | null;
}

interface RunLocalProjectionStory {
  id?: unknown;
  passes?: unknown;
  excluded?: unknown;
}

function runLocalProjectionStories(value: unknown): RunLocalProjectionStory[] {
  if (!value || Array.isArray(value) || typeof value !== 'object') return [];
  if ('userStories' in value && Array.isArray(value.userStories)) {
    return value.userStories.filter((story: unknown): story is RunLocalProjectionStory =>
      Boolean(story) && !Array.isArray(story) && typeof story === 'object');
  }
  if (!('phases' in value) || !Array.isArray(value.phases)) return [];
  return value.phases.flatMap((phase) => {
    if (!phase || Array.isArray(phase) || typeof phase !== 'object'
      || !('stories' in phase) || !Array.isArray(phase.stories)) return [];
    return phase.stories.filter((story: unknown): story is RunLocalProjectionStory =>
      Boolean(story) && !Array.isArray(story) && typeof story === 'object');
  });
}

function projectionStoriesById(value: unknown): Map<string, RunLocalProjectionStory[]> {
  const byId = new Map<string, RunLocalProjectionStory[]>();
  for (const story of runLocalProjectionStories(value)) {
    if (typeof story.id !== 'string' || story.id.trim() === '') continue;
    const storyId = story.id.trim();
    const matches = byId.get(storyId) ?? [];
    matches.push(story);
    byId.set(storyId, matches);
  }
  return byId;
}

function lifecycleNeutralStory(story: RunLocalProjectionStory): Record<string, unknown> {
  return Object.fromEntries(Object.entries(story)
    .filter(([key]) => key !== 'passes' && key !== 'excluded'));
}

/**
 * Require the run-owned lifecycle projection to be an exact projection of
 * immutable host result authority while preserving canonical story semantics.
 * Canonical and run-local bytes may differ only because the run owns lifecycle
 * flags; the mutable copy may neither alter story content nor invent or erase
 * a host-owned lifecycle decision.
 */
export function assertExactRunLocalSpecLifecycleAuthority(
  authority: RunHostAuthority,
  canonicalProjection: unknown,
  runProjection: unknown,
): void {
  const fail = (): never => {
    throw new Error('run spec projection lifecycle flags lack host authority or canonical story semantics changed');
  };
  const expected = new Set(authority.expectedStoryIds);
  const excluded = new Set(authority.excludedStoryIds);
  const passed = new Set(authority.authoritativePassedStoryIds);
  if (!authority.complete || authority.invalidReason
    || expected.size !== authority.expectedStoryIds.length
    || excluded.size !== authority.excludedStoryIds.length
    || [...expected].some((storyId) => excluded.has(storyId))
    || [...passed].some((storyId) => !expected.has(storyId))) fail();

  const canonicalById = projectionStoriesById(canonicalProjection);
  const runById = projectionStoriesById(runProjection);
  if (canonicalById.size === 0 || canonicalById.size !== runById.size) fail();
  for (const [storyId, canonicalMatches] of canonicalById) {
    const runMatches = runById.get(storyId) ?? [];
    if (canonicalMatches.length !== 1 || runMatches.length !== 1
      || stableWalJson(lifecycleNeutralStory(canonicalMatches[0]))
        !== stableWalJson(lifecycleNeutralStory(runMatches[0]))
      || (!expected.has(storyId) && !excluded.has(storyId)
        && stableWalJson(canonicalMatches[0]) !== stableWalJson(runMatches[0]))) fail();
  }
  for (const storyId of expected) {
    const matches = runById.get(storyId) ?? [];
    if (matches.length !== 1
      || matches[0].passes !== passed.has(storyId)
      || matches[0].excluded === true) fail();
  }
  for (const storyId of excluded) {
    const matches = runById.get(storyId) ?? [];
    if (matches.length !== 1
      || matches[0].excluded !== true
      || matches[0].passes === true) fail();
  }
}

function emptyInvalid(run: RunAuthorityRow, reason: string): RunHostAuthority {
  const expected = run.expected_story_ids ?? [];
  const excluded = run.excluded_story_ids ?? [];
  return {
    runId: Number(run.id),
    workspaceId: run.workspace_id,
    specId: path.basename(run.spec_path, '.json'),
    status: run.status,
    lifecycleStatus: run.lifecycle_status,
    finishedAt: run.finished_at,
    branchName: run.branch_name ?? '',
    checkoutPath: path.resolve(run.execution_worktree_path ?? run.worktree_path ?? run.workspace_path),
    repositoryTopLevel: path.resolve(run.execution_workspace_path ?? run.workspace_path),
    expectedStoryIds: expected,
    excludedStoryIds: excluded,
    stories: [],
    authoritativePassedStoryIds: [],
    authoritativePredecessorPasses: [],
    finalCommitSha: null,
    closeoutEligible: false,
    terminalRevision: null,
    integrationAncestry: [],
    acceptedStoryIds: [],
    complete: false,
    releaseEligible: false,
    invalidReason: reason,
  };
}

function timestampMillis(value: unknown): number {
  // node-postgres returns timestamptz projections as Date objects. String(Date)
  // drops fractional milliseconds, so coercing before comparison can reject an
  // otherwise exact durable outbox/attestation pair at run closeout.
  if (value instanceof Date) return value.getTime();
  return typeof value === 'string' ? Date.parse(value) : Number.NaN;
}

function exactTimestamp(left: unknown, right: unknown): boolean {
  const leftMs = timestampMillis(left);
  const rightMs = timestampMillis(right);
  return Number.isFinite(leftMs) && leftMs === rightMs;
}

/** Runtime capability probe used by audited historical closeout correction. */
export function hasExactHostTimestampPrecisionCapability(): boolean {
  const fractional = new Date('2026-07-18T09:59:00.123Z');
  return exactTimestamp(fractional, '2026-07-18T09:59:00.123Z')
    && !exactTimestamp(fractional, '2026-07-18T09:59:00.000Z');
}

function parseWalPayload(event: TrustedWalRow): Record<string, unknown> | null {
  try {
    const parsed = typeof event.payload === 'string' ? JSON.parse(event.payload) as unknown : event.payload;
    return parsed && !Array.isArray(parsed) && typeof parsed === 'object'
      ? parsed as Record<string, unknown>
      : null;
  } catch { return null; }
}

function exactAccounting(row: ResultAuthorityRow): boolean {
  if (!row.accounting_required) return Number(row.accounting_count) === 0;
  const sameNullableNumber = (left: number | string | null, right: number | string | null) =>
    left === right || (left != null && right != null && Number(left) === Number(right));
  return Number(row.accounting_count) === 1
    && typeof row.accounting_model === 'string'
    && row.accounting_model.trim().length > 0
    && row.accounting_input_tokens != null && Number(row.accounting_input_tokens) >= 0
    && row.accounting_output_tokens != null && Number(row.accounting_output_tokens) >= 0
    && row.accounting_reasoning_tokens != null && Number(row.accounting_reasoning_tokens) >= 0
    && row.accounting_cost_usd != null && Number.isFinite(Number(row.accounting_cost_usd))
    && Number(row.accounting_cost_usd) >= 0
    && row.projected_accounting_model === row.accounting_model
    && sameNullableNumber(row.projected_accounting_input_tokens, row.accounting_input_tokens)
    && sameNullableNumber(row.projected_accounting_output_tokens, row.accounting_output_tokens)
    && sameNullableNumber(row.projected_accounting_reasoning_tokens, row.accounting_reasoning_tokens)
    && sameNullableNumber(row.projected_accounting_cost_usd, row.accounting_cost_usd)
    && row.projected_accounting_cost_source === row.accounting_cost_source
    && sameNullableNumber(row.projected_accounting_input_rate, row.accounting_input_rate)
    && sameNullableNumber(row.projected_accounting_output_rate, row.accounting_output_rate);
}

function exactSuccessfulAttemptAuthority(row: ResultAuthorityRow): boolean {
  return Boolean(row.host_attempt_envelope_id)
    && row.host_attempt_authority_state === 'valid'
    && row.host_attempt_outcome === 'success'
    && row.host_attempt_outcome_provenance === 'host_process'
    && row.host_attempt_exit_code === 0
    && row.host_attempt_exit_signal === null
    && /^sha256:[0-9a-f]{64}$/.test(row.host_attempt_canonical_spec_revision ?? '')
    && /^sha256:[0-9a-f]{64}$/.test(row.host_attempt_canonical_spec_bytes_hash ?? '')
    && /^sha256:[0-9a-f]{64}$/.test(row.host_attempt_run_spec_revision ?? '')
    && /^sha256:[0-9a-f]{64}$/.test(row.host_attempt_run_spec_bytes_hash ?? '')
    && row.host_attempt_spec_revision === row.host_attempt_run_spec_revision
    && /^sha256:[0-9a-f]{64}$/.test(row.host_attempt_story_revision ?? '')
    && /^[0-9a-f]{40}$/.test(row.host_attempt_base_git_sha ?? '')
    && /^[0-9a-f]{40}$/.test(row.host_attempt_expected_git_sha ?? '')
    && row.host_attempt_observed_git_sha === row.host_attempt_expected_git_sha
    && Boolean(row.host_attempt_expected_git_branch?.trim())
    && row.host_attempt_worktree_branch === row.host_attempt_expected_git_branch;
}

function exactHostPass(row: ResultAuthorityRow, run: RunAuthorityRow, specId: string): boolean {
  return row.status === 'pass'
    && exactSuccessfulAttemptAuthority(row)
    && row.spec_id === specId
    && row.integrated === true
    && row.result_provenance === 'host'
    && row.result_source === 'execution-engine'
    && Boolean(row.finished_at)
    && Boolean(row.closeout_decision_id)
    && row.closeout_status === 'accepted'
    && row.closeout_manifest_hash === row.manifest_hash
    && isSupportedGitCommitSha(row.commit_sha)
    && row.commit_author === 'rorca-execution-engine'
    && row.commit_observed_source === 'worktree_branch'
    && row.commit_branch === run.branch_name
    && row.worktree_path === run.execution_worktree_path
    && Number(row.commit_count) === 1
    && row.projected_commit_sha?.toLowerCase() === row.commit_sha?.toLowerCase()
    && row.projected_commit_message === row.commit_message
    && row.projected_commit_author === row.commit_author
    && row.projected_commit_branch === row.commit_branch
    && row.projected_commit_source === row.commit_observed_source
    && Number(row.attestation_count) === 1
    && Boolean(row.attestation_id)
    && /^[0-9a-f]{64}$/.test(row.attestation_digest ?? '')
    && Boolean(row.attestation_passed_at)
    && Boolean(row.attestation_expires_at)
    && timestampMillis(row.attestation_expires_at) > Date.now()
    && row.attestation_revoked_at === null
    && exactAccounting(row);
}

function allowedHostTerminal(row: ResultAuthorityRow): boolean {
  if (row.result_provenance !== 'host' || !row.finished_at) return false;
  if (row.status === 'pass') return row.result_source === 'execution-engine';
  if (row.status === 'fail' || row.status === 'timeout' || row.status === 'skip') {
    return row.result_source === 'execution-engine' || row.result_source === 'worker';
  }
  return false;
}

async function loadRun(runId: number): Promise<RunAuthorityRow | undefined> {
  return queryOne<RunAuthorityRow>(`
    SELECT pr.id, pr.workspace_id, pr.spec_path, pr.status, pr.lifecycle_status,
           pr.expected_story_ids, COALESCE(pr.excluded_story_ids, '{}'::text[]) AS excluded_story_ids,
           pr.finished_at, pr.branch_name, pr.worktree_path,
           pr.execution_workspace_path, pr.execution_worktree_path,
           pr.retried_from_run_id,
           COALESCE(pr.predecessor_pass_story_ids, '{}'::text[]) AS predecessor_pass_story_ids,
           pr.predecessor_authority_hash,
           pr.terminal_checkout_sha, pr.terminal_checkout_attested_at,
           ri.authorized_sha AS release_authorized_sha,
           ri.execution_workspace_path AS release_execution_workspace_path,
           ri.execution_worktree_path AS release_execution_worktree_path,
           ri.identity_hash AS release_identity_hash,
           ws.path AS workspace_path
      FROM pipeline_runs pr
      JOIN workspaces ws ON ws.id = pr.workspace_id
      LEFT JOIN pipeline_run_release_intents ri ON ri.run_id = pr.id
     WHERE pr.id = $1
  `, [runId]);
}

async function loadLatestHostResults(run: RunAuthorityRow, storyIds: string[]): Promise<ResultAuthorityRow[]> {
  if (storyIds.length === 0) return [];
  return query<ResultAuthorityRow>(`
    SELECT DISTINCT ON (sr.story_id)
           sr.id, sr.story_id, sr.status, sr.reason, sr.finished_at, sr.spec_id,
           sr.integrated, sr.commit_sha, sr.commit_message, sr.commit_author,
           sr.worktree_path,
           sr.commit_branch, sr.commit_observed_source, sr.closeout_decision_id,
           sr.manifest_hash, sr.result_provenance, sr.result_source,
           envelope.envelope_id AS host_attempt_envelope_id,
           envelope.authority_state AS host_attempt_authority_state,
           envelope.outcome AS host_attempt_outcome,
           envelope.outcome_provenance AS host_attempt_outcome_provenance,
           envelope.exit_code AS host_attempt_exit_code,
           envelope.exit_signal AS host_attempt_exit_signal,
           envelope.spec_revision AS host_attempt_spec_revision,
           envelope.story_revision AS host_attempt_story_revision,
           envelope.canonical_spec_revision AS host_attempt_canonical_spec_revision,
           envelope.canonical_spec_bytes_hash AS host_attempt_canonical_spec_bytes_hash,
           envelope.run_spec_revision AS host_attempt_run_spec_revision,
           envelope.run_spec_bytes_hash AS host_attempt_run_spec_bytes_hash,
           envelope.base_git_sha AS host_attempt_base_git_sha,
           envelope.expected_git_sha AS host_attempt_expected_git_sha,
           envelope.observed_git_sha AS host_attempt_observed_git_sha,
           envelope.expected_git_branch AS host_attempt_expected_git_branch,
           envelope.worktree_branch AS host_attempt_worktree_branch,
           sr.accounting_required, sr.accounting_model, sr.accounting_input_tokens,
           sr.accounting_output_tokens, sr.accounting_reasoning_tokens,
           sr.accounting_cost_usd, sr.accounting_cost_source,
           sr.accounting_input_rate, sr.accounting_output_rate,
           tu.model AS projected_accounting_model,
           tu.input_tokens AS projected_accounting_input_tokens,
           tu.output_tokens AS projected_accounting_output_tokens,
           tu.reasoning_tokens AS projected_accounting_reasoning_tokens,
           tu.cost_usd AS projected_accounting_cost_usd,
           tu.cost_source AS projected_accounting_cost_source,
           tu.input_cost_per_1k AS projected_accounting_input_rate,
           tu.output_cost_per_1k AS projected_accounting_output_rate,
           scd.status AS closeout_status, scd.manifest_hash AS closeout_manifest_hash,
           sc.commit_sha AS projected_commit_sha,
           sc.commit_message AS projected_commit_message,
           sc.author AS projected_commit_author,
           sc.branch_name AS projected_commit_branch,
           sc.observed_source AS projected_commit_source,
           (SELECT COUNT(*) FROM story_commits exact_sc
             WHERE exact_sc.workspace_id = pr.workspace_id
               AND exact_sc.spec_id = sr.spec_id AND exact_sc.run_id = sr.run_id
               AND exact_sc.story_id = sr.story_id AND exact_sc.commit_sha = sr.commit_sha) AS commit_count,
           (SELECT COUNT(*) FROM token_usage tu WHERE tu.story_result_id = sr.id) AS accounting_count,
           (SELECT COUNT(*) FROM checkpoint_validation_attestations a
             WHERE a.workspace_id = pr.workspace_id AND a.run_id = sr.run_id
               AND a.story_id = sr.story_id AND a.branch_name = sr.commit_branch
               AND a.checkpoint_sha = sr.commit_sha AND a.validation_gate = 'execution-engine') AS attestation_count,
           (SELECT MIN(a.id::text) FROM checkpoint_validation_attestations a
             WHERE a.workspace_id = pr.workspace_id AND a.run_id = sr.run_id
               AND a.story_id = sr.story_id AND a.branch_name = sr.commit_branch
               AND a.checkpoint_sha = sr.commit_sha AND a.validation_gate = 'execution-engine') AS attestation_id,
           (SELECT MIN(a.evidence_digest) FROM checkpoint_validation_attestations a
             WHERE a.workspace_id = pr.workspace_id AND a.run_id = sr.run_id
               AND a.story_id = sr.story_id AND a.branch_name = sr.commit_branch
               AND a.checkpoint_sha = sr.commit_sha AND a.validation_gate = 'execution-engine') AS attestation_digest,
           (SELECT MIN(a.passed_at) FROM checkpoint_validation_attestations a
             WHERE a.workspace_id = pr.workspace_id AND a.run_id = sr.run_id
               AND a.story_id = sr.story_id AND a.branch_name = sr.commit_branch
               AND a.checkpoint_sha = sr.commit_sha AND a.validation_gate = 'execution-engine') AS attestation_passed_at,
           (SELECT MIN(a.expires_at) FROM checkpoint_validation_attestations a
             WHERE a.workspace_id = pr.workspace_id AND a.run_id = sr.run_id
               AND a.story_id = sr.story_id AND a.branch_name = sr.commit_branch
               AND a.checkpoint_sha = sr.commit_sha AND a.validation_gate = 'execution-engine') AS attestation_expires_at,
           (SELECT MAX(a.revoked_at) FROM checkpoint_validation_attestations a
             WHERE a.workspace_id = pr.workspace_id AND a.run_id = sr.run_id
               AND a.story_id = sr.story_id AND a.branch_name = sr.commit_branch
               AND a.checkpoint_sha = sr.commit_sha AND a.validation_gate = 'execution-engine') AS attestation_revoked_at
      FROM story_results sr
      JOIN pipeline_runs pr ON pr.id = sr.run_id
      LEFT JOIN story_closeout_decisions scd
        ON scd.decision_id = sr.closeout_decision_id
       AND scd.workspace_id = pr.workspace_id AND scd.run_id = sr.run_id
       AND scd.story_id = sr.story_id AND scd.manifest_hash = sr.manifest_hash
      LEFT JOIN host_story_attempt_envelopes envelope
        ON envelope.workspace_id = pr.workspace_id AND envelope.run_id = sr.run_id
       AND envelope.story_id = sr.story_id AND envelope.attempt = scd.attempt
       AND envelope.manifest_hash = sr.manifest_hash
      LEFT JOIN story_commits sc
        ON sc.workspace_id = pr.workspace_id AND sc.spec_id = sr.spec_id
       AND sc.run_id = sr.run_id AND sc.story_id = sr.story_id
       AND sc.commit_sha = sr.commit_sha
      LEFT JOIN token_usage tu ON tu.story_result_id = sr.id
     WHERE sr.run_id = $1 AND sr.story_id = ANY($2::text[])
       AND sr.result_provenance = 'host'
       AND sr.result_source IN ('execution-engine', 'worker')
     ORDER BY sr.story_id, sr.id DESC
  `, [run.id, storyIds]);
}

async function loadUnresolvedAttemptConflicts(
  run: RunAuthorityRow,
  storyIds: string[],
  allowPostCancellationRecoveryConflicts: boolean,
): Promise<Array<{
  story_id: string;
  attempt: number;
  reason_code: string;
}>> {
  if (storyIds.length === 0) return [];
  return query(`
    SELECT conflict.story_id, conflict.attempt, conflict.reason_code
      FROM host_story_attempt_conflicts conflict
      JOIN pipeline_runs canonical_run
        ON canonical_run.id = conflict.run_id
       AND canonical_run.workspace_id = conflict.workspace_id
     WHERE conflict.workspace_id = $1 AND conflict.run_id = $2
       AND conflict.story_id = ANY($3::text[])
       AND NOT (
         $4::boolean
         AND conflict.reason_code = 'cancellation_fence_mismatch'
         AND conflict.observed_payload->>'outcome' = 'crash'
         AND conflict.observed_payload->>'provenance' = 'host_recovery'
         AND conflict.observed_payload->>'runId' = canonical_run.id::text
         AND conflict.observed_payload->>'storyId' = conflict.story_id
         AND conflict.observed_payload->>'attempt' = conflict.attempt::text
         AND conflict.observed_payload->>'launchGeneration' = conflict.launch_generation::text
         AND conflict.observed_payload->>'cancellationFence' = canonical_run.dispatch_fence
         AND EXISTS (
           SELECT 1
             FROM host_story_attempt_envelopes envelope
            WHERE envelope.workspace_id = conflict.workspace_id
              AND envelope.run_id = conflict.run_id
              AND envelope.story_id = conflict.story_id
              AND envelope.attempt = conflict.attempt
              AND envelope.launch_generation = conflict.launch_generation
              AND envelope.cancellation_fence = canonical_run.dispatch_fence
              AND envelope.manifest_hash = conflict.observed_payload->>'manifestHash'
              AND envelope.authority_state = 'conflict'
         )
         AND (
           EXISTS (
             SELECT 1
               FROM pipeline_run_cancellation_requests cancellation
              WHERE cancellation.run_id = canonical_run.id
                AND cancellation.requested_at <= conflict.observed_at
           )
           OR EXISTS (
             SELECT 1
               FROM governed_retry_dispatches retry
              WHERE retry.retry_run_id = canonical_run.id
                AND retry.cancellation_requested_at IS NOT NULL
                AND retry.cancellation_requested_at <= conflict.observed_at
           )
         )
       )
     ORDER BY conflict.conflict_id ASC
  `, [run.workspace_id, run.id, storyIds, allowPostCancellationRecoveryConflicts]);
}

async function verifyPassOutboxes(run: RunAuthorityRow, specId: string, passing: ResultAuthorityRow[]): Promise<boolean> {
  if (passing.length === 0) return true;
  const ids = passing.map(row => Number(row.id));
  const outboxes = await query<TrustedWalRow>(`
    SELECT * FROM wal_events
     WHERE trust_provenance = 'host' AND trusted_source = 'story-result'
       AND event_type = 'story_passed' AND story_result_id = ANY($1::int[])
     ORDER BY id ASC
  `, [ids]);
  const byResult = new Map<number, TrustedWalRow[]>();
  for (const outbox of outboxes) {
    const id = Number(outbox.story_result_id);
    const group = byResult.get(id) ?? [];
    group.push(outbox);
    byResult.set(id, group);
  }
  for (const row of passing) {
    const exact = byResult.get(Number(row.id)) ?? [];
    if (exact.length !== 1 || !exact[0].outbox_ready_at) return false;
    const outbox = exact[0];
    try { assertExactTrustedWalRow(outbox); } catch { return false; }
    const payload = parseWalPayload(outbox);
    if (!payload
      || outbox.workspace_id !== run.workspace_id
      || outbox.spec_id !== specId
      || outbox.story_id !== row.story_id
      || Number(outbox.canonical_run_id) !== Number(run.id)
      || Number(outbox.story_result_id) !== Number(row.id)
      || Number(payload.run_id) !== Number(run.id)
      || payload.story_id !== row.story_id
      || Number(payload.story_result_id) !== Number(row.id)
      || String(payload.commit_sha).toLowerCase() !== row.commit_sha?.toLowerCase()
      || payload.closeout_decision_id !== row.closeout_decision_id
      || payload.checkpoint_attestation_id !== row.attestation_id
      || String(payload.checkpoint_attestation_digest).toLowerCase() !== row.attestation_digest?.toLowerCase()
      || !exactTimestamp(payload.checkpoint_attestation_passed_at, row.attestation_passed_at)
      || !exactTimestamp(payload.checkpoint_attestation_expires_at, row.attestation_expires_at)) return false;
  }
  return true;
}

/**
 * Inspect current run authority without consulting the mutable spec projection.
 * Compatibility/recovery-proposal rows are deliberately absent from the query.
 */
export async function inspectRunHostAuthority(
  runId: number,
  seen: ReadonlySet<number> = new Set<number>(),
  options: { allowPostCancellationRecoveryConflicts?: boolean } = {},
): Promise<RunHostAuthority | null> {
  // Permanent campaign deny-list guard must precede every run selector,
  // including recursive predecessor authority inspection.
  assertNotProtectedWave1Run(runId);
  if (!Number.isSafeInteger(runId) || runId <= 0 || seen.has(runId)) return null;
  const nextSeen = new Set(seen).add(runId);
  const run = await loadRun(runId);
  if (!run) return null;
  const expected = run.expected_story_ids ?? [];
  const excluded = run.excluded_story_ids ?? [];
  if (expected.length === 0
    || new Set(expected).size !== expected.length
    || new Set(excluded).size !== excluded.length
    || excluded.some(storyId => expected.includes(storyId))
    || !run.branch_name) return emptyInvalid(run, 'frozen run scope or canonical branch is unavailable');

  const specId = path.basename(run.spec_path, '.json');
  const rows = await loadLatestHostResults(run, expected);
  const byStory = new Map(rows.map(row => [row.story_id, row]));
  const stories: HostStoryAuthority[] = excluded.map(storyId => ({
    storyId, status: 'excluded', reason: 'frozen_host_policy', finishedAt: null,
    resultId: 0, commitSha: null,
  }));
  let invalidReason: string | null = null;
  const attemptConflicts = await loadUnresolvedAttemptConflicts(
    run,
    expected,
    options.allowPostCancellationRecoveryConflicts === true,
  );
  if (attemptConflicts.length > 0) {
    const first = attemptConflicts[0];
    invalidReason = `unresolved host attempt conflict for ${first.story_id} attempt ${first.attempt}: ${first.reason_code}`;
  }
  for (const storyId of expected) {
    if (invalidReason) break;
    const row = byStory.get(storyId);
    if (!row) continue;
    if (!allowedHostTerminal(row)) {
      invalidReason = `latest governing result lacks allowed host authority for ${storyId}`;
      break;
    }
    stories.push({
      storyId,
      status: row.status as HostStoryAuthority['status'],
      reason: row.reason,
      finishedAt: row.finished_at,
      resultId: Number(row.id),
      commitSha: row.commit_sha?.toLowerCase() ?? null,
    });
  }

  const passing = rows.filter(row => row.status === 'pass');
  if (!invalidReason && passing.some(row => !exactHostPass(row, run, specId))) {
    invalidReason = 'one or more integrated passes lack exact host result/closeout/commit/attestation/accounting authority';
  }
  if (!invalidReason && !(await verifyPassOutboxes(run, specId, passing))) {
    invalidReason = 'one or more integrated passes lack exactly one released host outbox';
  }

  let predecessorCommitShas: string[] = [];
  let authoritativePredecessorPasses: LinkedPredecessorPass[] = [];
  if (!invalidReason && run.retried_from_run_id != null) {
    const predecessorRunId = Number(run.retried_from_run_id);
    const linkedIds = run.predecessor_pass_story_ids ?? [];
    if (!Number.isSafeInteger(predecessorRunId) || predecessorRunId <= 0
      || new Set(linkedIds).size !== linkedIds.length
      || linkedIds.some(storyId => expected.includes(storyId))
      || (linkedIds.length === 0) !== (run.predecessor_authority_hash === null)) {
      invalidReason = 'retry run lacks exact linked predecessor host authority';
    } else if (linkedIds.length > 0) {
      const predecessor = await inspectRunHostAuthority(predecessorRunId, nextSeen);
      const localPredecessorPasses: LinkedPredecessorPass[] = (predecessor?.stories ?? [])
        .filter(story => story.status === 'pass' && story.commitSha
          && predecessor?.authoritativePassedStoryIds.includes(story.storyId))
        .map(story => ({
          storyId: story.storyId,
          resultId: story.resultId,
          commitSha: story.commitSha!,
        }));
      const availablePasses = [
        ...localPredecessorPasses,
        ...(predecessor?.authoritativePredecessorPasses ?? []),
      ];
      const availableByStory = new Map(availablePasses.map(pass => [pass.storyId, pass]));
      const linked = linkedIds.map(storyId => availableByStory.get(storyId));
      if (!predecessor || predecessor.invalidReason
        || availableByStory.size !== availablePasses.length
        || linked.some(pass => !pass)) {
        invalidReason = 'linked predecessor pass set is unavailable or non-authoritative';
      } else {
        const exactLinked = linked as LinkedPredecessorPass[];
        if (linkedPredecessorAuthorityHash(predecessorRunId, exactLinked) !== run.predecessor_authority_hash) {
          invalidReason = 'linked predecessor authority digest does not match exact host rows';
        } else {
          authoritativePredecessorPasses = exactLinked;
          predecessorCommitShas = [...exactLinked]
            .sort((left, right) => left.resultId - right.resultId)
            .map(pass => pass.commitSha);
        }
      }
    }
  } else if (!invalidReason && (run.predecessor_pass_story_ids?.length > 0 || run.predecessor_authority_hash)) {
    invalidReason = 'predecessor authority exists without an exact linked run';
  }

  const complete = !invalidReason && expected.every(storyId => byStory.has(storyId));
  const allExpectedPassed = complete && expected.every(storyId => byStory.get(storyId)?.status === 'pass');
  let finalCommitSha: string | null = null;
  let terminalRevision: string | null = null;
  let integrationAncestry: string[] = [];
  const orderedPasses = [...passing].sort((left, right) => Number(left.id) - Number(right.id));
  const orderedAuthorityCommits = [
    ...predecessorCommitShas,
    ...orderedPasses.map(row => String(row.commit_sha).toLowerCase()),
  ];
  if (!invalidReason) {
    try {
      const checkout = assertCanonicalRunCheckout({
        cwd: run.execution_worktree_path ?? run.worktree_path ?? run.workspace_path,
        repositoryTopLevel: run.execution_workspace_path ?? run.workspace_path,
        branchName: run.branch_name,
      });
      const attestedTerminalRevision = run.terminal_checkout_attested_at
        && isSupportedGitCommitSha(run.terminal_checkout_sha)
        ? run.terminal_checkout_sha!.toLowerCase()
        : null;
      terminalRevision = attestedTerminalRevision ?? checkout.headSha;
      assertOrderedCommitAncestry(checkout.cwd, orderedAuthorityCommits, terminalRevision);
      integrationAncestry = [...orderedAuthorityCommits];
      if (integrationAncestry.at(-1) !== terminalRevision) integrationAncestry.push(terminalRevision);
      if (allExpectedPassed) {
        finalCommitSha = orderedPasses.at(-1)?.commit_sha?.toLowerCase() ?? null;
        if (!finalCommitSha || finalCommitSha !== terminalRevision) {
          invalidReason = 'latest integrated pass is not the exact run terminal revision';
        }
      }
    } catch (error) {
      finalCommitSha = orderedPasses.at(-1)?.commit_sha?.toLowerCase() ?? null;
      const immutableTerminal = Boolean(allExpectedPassed && finalCommitSha
        && run.terminal_checkout_attested_at
        && run.terminal_checkout_sha?.toLowerCase() === finalCommitSha
        && run.release_authorized_sha?.toLowerCase() === finalCommitSha
        && run.release_execution_workspace_path === run.execution_workspace_path
        && run.release_execution_worktree_path === run.execution_worktree_path
        && /^[0-9a-f]{64}$/.test(run.release_identity_hash ?? ''));
      if (immutableTerminal && finalCommitSha) {
        terminalRevision = finalCommitSha;
        integrationAncestry = [...orderedAuthorityCommits];
        if (integrationAncestry.at(-1) !== terminalRevision) integrationAncestry.push(terminalRevision);
      } else {
        invalidReason = error instanceof Error ? error.message : String(error);
      }
    }
  }

  const authoritativePassedStoryIds = invalidReason ? [] : rows
    .filter(row => row.status === 'pass' && exactHostPass(row, run, specId))
    .map(row => row.story_id);
  return {
    runId: Number(run.id),
    workspaceId: run.workspace_id,
    specId,
    status: run.status,
    lifecycleStatus: run.lifecycle_status,
    finishedAt: run.finished_at,
    branchName: run.branch_name,
    checkoutPath: path.resolve(run.execution_worktree_path ?? run.worktree_path ?? run.workspace_path),
    repositoryTopLevel: path.resolve(run.execution_workspace_path ?? run.workspace_path),
    expectedStoryIds: expected,
    excludedStoryIds: excluded,
    stories,
    authoritativePassedStoryIds,
    authoritativePredecessorPasses: invalidReason ? [] : authoritativePredecessorPasses,
    finalCommitSha,
    closeoutEligible: complete && !invalidReason && Boolean(terminalRevision),
    terminalRevision,
    integrationAncestry,
    acceptedStoryIds: [...authoritativePassedStoryIds].sort((left, right) => left.localeCompare(right)),
    complete: complete && !invalidReason,
    releaseEligible: allExpectedPassed && !invalidReason && Boolean(finalCommitSha),
    invalidReason,
  };
}
