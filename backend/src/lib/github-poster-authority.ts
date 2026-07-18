/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Canonical local authority checks shared by GitHub Check/status posters. */

import * as path from 'path';
import { query, queryOne } from '../db/index';
import { isFullGitObjectId } from './github-repository-authority';
import { isTrustedGoverningWalEvent, type TrustedWalRow } from './trusted-wal';
import type { WalEvent } from './sse-hub';

export interface CanonicalPosterRun {
  id: number;
  workspaceId: string;
  specId: string;
  status: string;
  lifecycleStatus: string;
  expectedStoryIds: string[] | null;
  finishedAt: string | null;
}

export interface AuthorizedWalEvent {
  event: TrustedWalRow;
  payload: Record<string, unknown>;
  run: CanonicalPosterRun;
}

export interface AuthorizedStoryPass extends AuthorizedWalEvent {
  storyId: string;
  resultId: number;
  commitSha: string;
}

export interface TerminalStoryAuthority {
  storyId: string;
  status: string;
  reason: string | null;
  finishedAt: string | null;
  resultId: number;
  commitSha: string | null;
}

export interface CompleteTerminalRun extends AuthorizedWalEvent {
  stories: TerminalStoryAuthority[];
  finalCommitSha: string | null;
  successAuthorized: boolean;
}

interface RunRow {
  id: number | string;
  workspace_id: string;
  spec_path: string;
  status: string;
  lifecycle_status: string;
  expected_story_ids: string[] | null;
  finished_at: string | null;
}

interface StoryAuthorityRow {
  id: number | string;
  story_id: string;
  status: string;
  spec_id: string | null;
  reason: string | null;
  finished_at: string | null;
  closeout_decision_id: string | null;
  closeout_status: string | null;
  commit_sha: string | null;
  observed_source: string | null;
  author: string | null;
  pushed_at: string | null;
}

function parsePayload(event: WalEvent): Record<string, unknown> | null {
  try {
    const value = typeof event.payload === 'string' ? JSON.parse(event.payload) as unknown : event.payload;
    return value && !Array.isArray(value) && typeof value === 'object'
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function sourceAllowed(event: TrustedWalRow): boolean {
  if (event.event_type === 'run_started' || event.event_type === 'run_finished') {
    return event.trusted_source === 'worker';
  }
  if (event.event_type === 'story_passed') return event.trusted_source === 'story-result';
  return event.trusted_source === 'execution-engine' || event.trusted_source === 'worker';
}

export async function authorizeCanonicalWalEvent(event: WalEvent): Promise<AuthorizedWalEvent | null> {
  if (!isTrustedGoverningWalEvent(event) || !sourceAllowed(event)) return null;
  const payload = parsePayload(event);
  if (!payload) return null;
  const runId = Number(payload.run_id);
  if (!Number.isSafeInteger(runId) || runId <= 0 || runId !== Number(event.canonical_run_id)) return null;

  const row = await queryOne<RunRow>(`
    SELECT id, workspace_id, spec_path, status, lifecycle_status,
           expected_story_ids, finished_at
      FROM pipeline_runs
     WHERE id = $1
  `, [runId]);
  if (!row) return null;
  const specId = path.basename(row.spec_path, '.json');
  if (row.workspace_id !== event.workspace_id || specId !== event.spec_id) return null;
  if (event.story_id && row.expected_story_ids && !row.expected_story_ids.includes(event.story_id)) return null;
  return {
    event,
    payload,
    run: {
      id: Number(row.id),
      workspaceId: row.workspace_id,
      specId,
      status: row.status,
      lifecycleStatus: row.lifecycle_status,
      expectedStoryIds: row.expected_story_ids,
      finishedAt: row.finished_at,
    },
  };
}

function eventFullSha(payload: Record<string, unknown>): string | null {
  const sha = typeof payload.commit_sha === 'string' ? payload.commit_sha.toLowerCase() : null;
  return isFullGitObjectId(sha) ? sha : null;
}

/** Accepted closeout + latest pass result + exact integrated commit are all required. */
export async function authorizeStoryPassEvent(event: WalEvent): Promise<AuthorizedStoryPass | null> {
  if (event.event_type !== 'story_passed' || !event.story_id) return null;
  const authorized = await authorizeCanonicalWalEvent(event);
  if (!authorized) return null;
  const resultId = Number(authorized.payload.story_result_id);
  const eventSha = eventFullSha(authorized.payload);
  const decisionId = typeof authorized.payload.closeout_decision_id === 'string'
    ? authorized.payload.closeout_decision_id
    : null;
  if (!Number.isSafeInteger(resultId) || resultId <= 0 || !eventSha || !decisionId) return null;

  const row = await queryOne<StoryAuthorityRow>(`
    SELECT sr.id, sr.story_id, sr.status, sr.spec_id, sr.reason, sr.finished_at,
           sr.closeout_decision_id, scd.status AS closeout_status,
           sc.commit_sha, sc.observed_source, sc.author, sc.pushed_at
      FROM story_results sr
      JOIN story_closeout_decisions scd
        ON scd.decision_id = sr.closeout_decision_id
       AND scd.workspace_id = $1 AND scd.spec_id = $2
       AND scd.run_id = $3 AND scd.story_id = $4
      JOIN story_commits sc
        ON sc.workspace_id = $1 AND sc.spec_id = $2
       AND sc.run_id = $3 AND sc.story_id = $4 AND sc.commit_sha = $6
     WHERE sr.id = $5 AND sr.run_id = $3 AND sr.story_id = $4 AND sr.spec_id = $2
       AND sr.id = (
         SELECT latest.id FROM story_results latest
          WHERE latest.run_id = $3 AND latest.story_id = $4
          ORDER BY latest.id DESC LIMIT 1
       )
  `, [
    authorized.run.workspaceId,
    authorized.run.specId,
    authorized.run.id,
    event.story_id,
    resultId,
    eventSha,
  ]);
  if (!row
    || row.status !== 'pass'
    || row.spec_id !== authorized.run.specId
    || row.closeout_status !== 'accepted'
    || row.closeout_decision_id !== decisionId
    || row.commit_sha?.toLowerCase() !== eventSha
    || row.observed_source !== 'worktree_branch'
    || row.author !== 'rorca-execution-engine') {
    return null;
  }
  return {
    ...authorized,
    storyId: event.story_id,
    resultId,
    commitSha: eventSha,
  };
}

export async function authorizeTerminalStoryEvent(event: WalEvent): Promise<AuthorizedWalEvent | null> {
  if (!event.story_id || !['story_failed', 'story_skipped'].includes(event.event_type)) return null;
  const authorized = await authorizeCanonicalWalEvent(event);
  if (!authorized) return null;
  const row = await queryOne<{ status: string }>(`
    SELECT status FROM story_results
     WHERE run_id = $1 AND story_id = $2
     ORDER BY id DESC LIMIT 1
  `, [authorized.run.id, event.story_id]);
  const allowed = event.event_type === 'story_failed'
    ? ['fail', 'timeout'].includes(row?.status ?? '')
    : ['skip', 'excluded'].includes(row?.status ?? '');
  return allowed ? authorized : null;
}

/**
 * Require a terminal canonical run and one terminal latest result for every
 * frozen expected story. Every passing result must carry accepted closeout and
 * an exact integrated commit. Historical runs without a frozen set fail closed.
 */
export async function authorizeCompleteTerminalRun(event: WalEvent): Promise<CompleteTerminalRun | null> {
  if (event.event_type !== 'run_finished') return null;
  const authorized = await authorizeCanonicalWalEvent(event);
  if (!authorized) return null;
  const terminalRunStatuses = new Set(['done', 'failed', 'partial_failure', 'cancelled']);
  const terminalLifecycles = new Set(['finished', 'failed', 'cancelled']);
  if (!terminalRunStatuses.has(authorized.run.status)
    || !terminalLifecycles.has(authorized.run.lifecycleStatus)
    || !authorized.run.finishedAt) {
    return null;
  }
  const expected = authorized.run.expectedStoryIds;
  if (!expected || expected.length === 0 || new Set(expected).size !== expected.length) return null;

  const rows = await query<StoryAuthorityRow>(`
    SELECT DISTINCT ON (sr.story_id)
           sr.id, sr.story_id, sr.status, sr.spec_id, sr.reason, sr.finished_at,
           sr.closeout_decision_id, scd.status AS closeout_status,
           sc.commit_sha, sc.observed_source, sc.author, sc.pushed_at
      FROM story_results sr
      LEFT JOIN story_closeout_decisions scd
        ON scd.decision_id = sr.closeout_decision_id
       AND scd.workspace_id = $2 AND scd.spec_id = $3
       AND scd.run_id = sr.run_id AND scd.story_id = sr.story_id
      LEFT JOIN LATERAL (
        SELECT commit_sha, observed_source, author, pushed_at
          FROM story_commits
         WHERE workspace_id = $2 AND spec_id = $3
           AND run_id = sr.run_id AND story_id = sr.story_id
         ORDER BY pushed_at DESC, id DESC LIMIT 1
      ) sc ON TRUE
     WHERE sr.run_id = $1 AND sr.story_id = ANY($4::text[])
     ORDER BY sr.story_id, sr.id DESC
  `, [authorized.run.id, authorized.run.workspaceId, authorized.run.specId, expected]);
  if (rows.length !== expected.length || rows.some(row => !expected.includes(row.story_id))) return null;
  const terminalStoryStatuses = new Set(['pass', 'fail', 'skip', 'timeout', 'excluded']);
  if (rows.some(row => !terminalStoryStatuses.has(row.status) || !row.finished_at)) return null;

  for (const row of rows) {
    if (row.status !== 'pass') continue;
    if (row.spec_id !== authorized.run.specId
      || !row.closeout_decision_id
      || row.closeout_status !== 'accepted'
      || !isFullGitObjectId(row.commit_sha)
      || row.observed_source !== 'worktree_branch'
      || row.author !== 'rorca-execution-engine') {
      return null;
    }
  }
  const commits = rows
    .filter(row => row.status === 'pass' && row.commit_sha && row.pushed_at)
    .sort((left, right) => new Date(left.pushed_at!).getTime() - new Date(right.pushed_at!).getTime());
  const finalCommitSha = commits.length > 0 ? commits[commits.length - 1].commit_sha!.toLowerCase() : null;
  const hasFailure = rows.some(row => row.status === 'fail' || row.status === 'timeout');
  const hasPass = rows.some(row => row.status === 'pass');
  const successAuthorized = authorized.run.status === 'done' && !hasFailure && hasPass && Boolean(finalCommitSha);

  return {
    ...authorized,
    stories: rows.map(row => ({
      storyId: row.story_id,
      status: row.status,
      reason: row.reason,
      finishedAt: row.finished_at,
      resultId: Number(row.id),
      commitSha: row.commit_sha?.toLowerCase() ?? null,
    })),
    finalCommitSha,
    successAuthorized,
  };
}
