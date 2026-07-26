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
import { assertExactTrustedWalRow, type TrustedWalRow } from './trusted-wal';
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
  attestation_passed_at: string | null;
  attestation_expires_at: string | null;
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
  finalCommitSha: string | null;
  closeoutEligible: boolean;
  terminalRevision: string | null;
  integrationAncestry: string[];
  acceptedStoryIds: string[];
  complete: boolean;
  releaseEligible: boolean;
  invalidReason: string | null;
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

function exactTimestamp(left: unknown, right: unknown): boolean {
  const leftMs = Date.parse(String(left ?? ''));
  const rightMs = Date.parse(String(right ?? ''));
  return Number.isFinite(leftMs) && leftMs === rightMs;
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

function exactHostPass(row: ResultAuthorityRow, run: RunAuthorityRow, specId: string): boolean {
  return row.status === 'pass'
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
    && Date.parse(row.attestation_expires_at!) > Date.now()
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
): Promise<RunHostAuthority | null> {
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
  for (const storyId of expected) {
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
  if (!invalidReason && run.retried_from_run_id != null) {
    const predecessorRunId = Number(run.retried_from_run_id);
    const linkedIds = run.predecessor_pass_story_ids ?? [];
    if (!Number.isSafeInteger(predecessorRunId) || predecessorRunId <= 0
      || (linkedIds.length === 0) !== (run.predecessor_authority_hash === null)) {
      invalidReason = 'retry run lacks exact linked predecessor host authority';
    } else if (linkedIds.length > 0) {
      const predecessor = await inspectRunHostAuthority(predecessorRunId, nextSeen);
      const linked = linkedIds.map(storyId => predecessor?.stories.find(story =>
        story.storyId === storyId && story.status === 'pass' && story.commitSha));
      if (!predecessor || linked.some(story => !story)
        || linked.some(story => !predecessor.authoritativePassedStoryIds.includes(story!.storyId))) {
        invalidReason = 'linked predecessor pass set is unavailable or non-authoritative';
      } else {
        const exactLinked = linked.map(story => ({
          storyId: story!.storyId,
          resultId: story!.resultId,
          commitSha: story!.commitSha!,
        }));
        if (linkedPredecessorAuthorityHash(predecessorRunId, exactLinked) !== run.predecessor_authority_hash) {
          invalidReason = 'linked predecessor authority digest does not match exact host rows';
        } else {
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
      assertOrderedCommitAncestry(checkout.cwd, orderedAuthorityCommits, checkout.headSha);
      terminalRevision = checkout.headSha;
      integrationAncestry = [...orderedAuthorityCommits];
      if (integrationAncestry.at(-1) !== terminalRevision) integrationAncestry.push(terminalRevision);
      if (allExpectedPassed) {
        finalCommitSha = orderedPasses.at(-1)?.commit_sha?.toLowerCase() ?? null;
        if (!finalCommitSha || finalCommitSha !== terminalRevision) {
          invalidReason = 'latest integrated pass is not the exact canonical run-branch HEAD';
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

  const authoritativePassedStoryIds = rows
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
