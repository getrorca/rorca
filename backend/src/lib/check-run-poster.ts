/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Restart-safe, exact-SHA GitHub Check Run projection. */

import { createHash, randomUUID } from 'crypto';
import {
  broadcastAll,
  subscribeDurable,
  type WalEvent,
} from './sse-hub';
import { execute, query, queryOne, transaction } from '../db/index';
import { resolveWorkspaceGitHubToken } from './github-token-resolver';
import {
  getGithubRepositoryAuthority,
  githubRepoApiUrl,
  isFullGitObjectId,
} from './github-repository-authority';
import { fetchGithubWithTimeout } from './github-app-credential-provider';
import { githubRateLimiter } from './github-rate-limiter';
import { logger } from './logger';
import {
  extractGithubProviderError,
  formatGithubProviderError,
  sanitizeGithubProviderException,
} from './github-provider-error';
import {
  authorizeCanonicalWalEvent,
  authorizeCompleteTerminalRun,
  type CompleteTerminalRun,
} from './github-poster-authority';
import { ConflictError } from './errors';
import { assertCanonicalRunCheckout } from './run-git-authority';

interface PipelineRunRow {
  worktree_path: string | null;
  workspace_id: string;
  branch_name: string | null;
  execution_workspace_path: string | null;
  execution_worktree_path: string | null;
  terminal_checkout_sha: string | null;
  release_authorized_sha: string | null;
  release_execution_workspace_path: string | null;
  release_execution_worktree_path: string | null;
  release_identity_hash: string | null;
  workspace_path: string;
}

interface StoryProgress {
  storyId: string;
  title: string;
  status: 'pass' | 'fail' | 'skip';
  reason?: string;
}

interface CheckAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: 'failure';
  message: string;
  title: string;
}

interface ProjectionPayload {
  runId: number;
  stories: StoryProgress[];
  title: string;
  summary: string;
  text: string;
  annotations: CheckAnnotation[];
  counts: { passed: number; failed: number; skipped: number; total: number };
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
  check_run_id: number | string | null;
  provider_head_sha: string | null;
  claim_token: string | null;
  claimed_at: string | null;
  attempts: number;
  next_attempt_at: string | null;
}

interface ProjectionClaim extends ProjectionRow {
  claim_token: string;
  desired_payload: ProjectionPayload;
}

const CHECK_RUN_NAME = 'Rorca Pipeline';
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
    throw new ConflictError('GitHub Check Run projection payload is invalid');
  }
  return parsed as ProjectionPayload;
}

async function resolveBranchHead(runId: number, workspaceId: string): Promise<string | null> {
  const run = await queryOne<PipelineRunRow>(`
    SELECT pr.worktree_path, pr.workspace_id, pr.branch_name,
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
  try {
    return assertCanonicalRunCheckout({
      cwd: run.execution_worktree_path ?? run.worktree_path ?? run.workspace_path,
      repositoryTopLevel: run.execution_workspace_path ?? run.workspace_path,
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

function buildSummaryTable(stories: StoryProgress[]): string {
  const emoji: Record<StoryProgress['status'], string> = {
    pass: ':white_check_mark:', fail: ':x:', skip: ':fast_forward:',
  };
  return [
    '| Story | Title | Status |',
    '|-------|-------|--------|',
    ...stories.map(story => `| ${story.storyId} | ${story.title.slice(0, 60)} | ${emoji[story.status]} ${story.status} |`),
  ].join('\n');
}

function extractAnnotations(stories: StoryProgress[]): CheckAnnotation[] {
  const annotations: CheckAnnotation[] = [];
  const fileLine = /(?:^|\s|at\s+)([a-zA-Z0-9_./-]+\.[a-zA-Z]{1,5}):(\d+)/gm;
  for (const story of stories) {
    if (story.status !== 'fail' || !story.reason) continue;
    for (const match of story.reason.matchAll(fileLine)) {
      if (match[1].includes('node_modules/') || match[1].startsWith('http')) continue;
      annotations.push({
        path: match[1],
        start_line: Number(match[2]),
        end_line: Number(match[2]),
        annotation_level: 'failure',
        message: `${story.storyId} failed: ${story.reason.slice(0, 200)}`,
        title: `${story.storyId}: ${story.title}`,
      });
    }
  }
  return annotations.slice(0, 50);
}

function terminalPayload(complete: CompleteTerminalRun, conclusion: 'success' | 'failure' | 'neutral'): ProjectionPayload {
  const stories: StoryProgress[] = complete.stories.map(result => ({
    storyId: result.storyId,
    title: result.storyId,
    status: result.status === 'pass'
      ? 'pass'
      : result.status === 'fail' || result.status === 'timeout' ? 'fail' : 'skip',
    ...(result.reason ? { reason: result.reason } : {}),
  }));
  const counts = {
    passed: stories.filter(story => story.status === 'pass').length,
    failed: stories.filter(story => story.status === 'fail').length,
    skipped: stories.filter(story => story.status === 'skip').length,
    total: stories.length,
  };
  const summary = buildSummaryTable(stories);
  const failures = stories
    .filter(story => story.status === 'fail')
    .map(story => `- **${story.storyId}**${story.reason ? `: ${story.reason}` : ''}`);
  return {
    runId: complete.run.id,
    stories,
    title: `Pipeline Run #${complete.run.id} — ${conclusion}`,
    summary,
    text: [
      `## Rorca Pipeline Run #${complete.run.id}`,
      `**Results**: ${counts.passed}/${counts.total} passed, ${counts.failed} failed, ${counts.skipped} skipped`,
      summary,
      ...(failures.length ? ['### Failed Stories', ...failures] : []),
    ].join('\n\n'),
    annotations: extractAnnotations(stories),
    counts,
  };
}

function startedPayload(runId: number): ProjectionPayload {
  return {
    runId,
    stories: [],
    title: `Pipeline Run #${runId}`,
    summary: 'Pipeline is starting...',
    text: '',
    annotations: [],
    counts: { passed: 0, failed: 0, skipped: 0, total: 0 },
  };
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
}): Promise<void> {
  const eventHash = input.event.event_identity_hash;
  if (!eventHash || !/^[0-9a-f]{64}$/.test(eventHash)) {
    throw new ConflictError('Trusted Check Run event has no immutable identity hash');
  }
  const payloadHash = hash({
    version: 1,
    state: input.state,
    headSha: input.headSha,
    conclusion: input.conclusion,
    payload: input.payload,
  });
  await transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`github-check-run:${input.runId}`]);
    const existing = (await client.query<ProjectionRow>(
      'SELECT * FROM github_check_run_projections WHERE run_id = $1 FOR UPDATE',
      [input.runId],
    )).rows[0];
    if (existing && (existing.workspace_id !== input.workspaceId
      || existing.spec_id !== input.specId
      || existing.external_id !== externalId(input.runId))) {
      throw new ConflictError('GitHub Check Run projection does not own the canonical run identity');
    }
    if (existing?.desired_state === 'completed') {
      if (existing.head_sha !== input.headSha
        || existing.conclusion !== input.conclusion
        || existing.desired_payload_hash !== payloadHash) {
        throw new ConflictError('Terminal GitHub Check Run projection already has different immutable authority');
      }
      return;
    }
    if (!existing) {
      await client.query(`
        INSERT INTO github_check_run_projections (
          run_id, workspace_id, spec_id, desired_event_id,
          desired_event_identity_hash, desired_state, head_sha, conclusion,
          desired_payload, desired_payload_hash, external_id, projection_status
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,'pending')
      `, [
        input.runId, input.workspaceId, input.specId, input.event.id, eventHash,
        input.state, input.headSha, input.conclusion, JSON.stringify(input.payload),
        payloadHash, externalId(input.runId),
      ]);
      return;
    }
    await client.query(`
      UPDATE github_check_run_projections
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

/** Durable subscriber: all local authority checks and ledger writes precede WAL ack. */
export async function acceptCheckRunWalEvent(event: WalEvent): Promise<number | null> {
  if (event.event_type === 'run_started') {
    const authorized = await authorizeCanonicalWalEvent(event);
    if (!authorized
      || authorized.run.status !== 'running'
      || !['starting', 'pty_attached', 'running'].includes(authorized.run.lifecycleStatus)) return null;
    const headSha = await resolveBranchHead(authorized.run.id, authorized.run.workspaceId);
    if (!isFullGitObjectId(headSha)) return null;
    await persistDesiredProjection({
      event,
      runId: authorized.run.id,
      workspaceId: authorized.run.workspaceId,
      specId: authorized.run.specId,
      state: 'in_progress',
      headSha: headSha.toLowerCase(),
      conclusion: null,
      payload: startedPayload(authorized.run.id),
    });
    return authorized.run.id;
  }
  if (event.event_type !== 'run_finished') return null;

  // Every pass/result/commit/closeout/outbox/hash check completes here, before
  // repository authority or installation token resolution in reconciliation.
  const complete = await authorizeCompleteTerminalRun(event);
  if (!complete) return null;
  const conclusion: 'success' | 'failure' | 'neutral' = complete.successAuthorized
    ? 'success'
    : complete.run.status === 'cancelled' ? 'neutral' : 'failure';
  const localHead = complete.finalCommitSha
    ?? await resolveBranchHead(complete.run.id, complete.run.workspaceId);
  if (!isFullGitObjectId(localHead)) return null;
  await persistDesiredProjection({
    event,
    runId: complete.run.id,
    workspaceId: complete.run.workspaceId,
    specId: complete.run.specId,
    state: 'completed',
    headSha: localHead.toLowerCase(),
    conclusion,
    payload: terminalPayload(complete, conclusion),
  });
  return complete.run.id;
}

async function claimProjection(runId: number): Promise<ProjectionClaim | null> {
  return transaction(async (client) => {
    const row = (await client.query<ProjectionRow>(
      'SELECT * FROM github_check_run_projections WHERE run_id = $1 FOR UPDATE SKIP LOCKED',
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
      UPDATE github_check_run_projections
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

async function getRepository(workspaceId: string): Promise<{ owner: string; repo: string } | null> {
  const authority = await getGithubRepositoryAuthority(workspaceId, { requireActive: true });
  return authority ? { owner: authority.owner, repo: authority.name } : null;
}

async function getToken(workspaceId: string, owner: string, repo: string): Promise<string | null> {
  const resolved = await resolveWorkspaceGitHubToken(workspaceId, {
    repository: { owner, name: repo }, purpose: 'checks-write',
  });
  return resolved?.token ?? null;
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
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

async function providerFetch(
  url: string,
  init: RequestInit,
  operationCode: string,
): Promise<Response> {
  let response: Response;
  try {
    response = await githubRateLimiter.execute(() =>
      fetchGithubWithTimeout(fetch, url, init));
  } catch (error) {
    const sanitized = sanitizeGithubProviderException(error, operationCode);
    throw new ProjectionProviderError(
      sanitized.code, true, true, null, sanitized.requestId,
      formatGithubProviderError(sanitized),
    );
  }
  if (!response.ok) {
    const providerError = extractGithubProviderError(response, operationCode);
    const retryable = response.status === 408 || response.status === 409
      || response.status === 429 || response.status >= 500;
    throw new ProjectionProviderError(
      providerError.code, retryable, false, response.status,
      providerError.requestId, formatGithubProviderError(providerError),
    );
  }
  return response;
}

function safeRequestId(response: Pick<Response, 'status' | 'headers'>): string | null {
  return extractGithubProviderError(response, 'GITHUB_CHECK_RUN_RESPONSE_INVALID').requestId;
}

async function discoverCheckRun(
  owner: string,
  repo: string,
  token: string,
  claim: ProjectionClaim,
): Promise<number | null> {
  const matches: Array<{ id?: number; external_id?: string; head_sha?: string }> = [];
  const maxPages = 10;
  for (let page = 1; page <= maxPages; page++) {
    const suffix = `/commits/${claim.head_sha}/check-runs?check_name=${encodeURIComponent(CHECK_RUN_NAME)}&filter=all&per_page=100&page=${page}`;
    const response = await providerFetch(
      githubRepoApiUrl(owner, repo, suffix),
      { method: 'GET', headers: headers(token) },
      'GITHUB_CHECK_RUN_RECONCILE_FAILED',
    );
    let body: { total_count?: number; check_runs?: Array<{ id?: number; external_id?: string; head_sha?: string }> };
    try { body = await response.json() as typeof body; }
    catch {
      throw new ProjectionProviderError('GITHUB_CHECK_RUN_RECONCILE_UNCERTAIN', true, true, response.status, safeRequestId(response), 'GitHub Check Run lookup response was unreadable');
    }
    const pageRows = body.check_runs ?? [];
    matches.push(...pageRows.filter(check =>
      check.external_id === claim.external_id
        && check.head_sha?.toLowerCase() === claim.head_sha
        && Number.isSafeInteger(check.id)));
    if (matches.length > 1) {
      throw new ProjectionProviderError('GITHUB_CHECK_RUN_IDENTITY_AMBIGUOUS', false, false, response.status, safeRequestId(response), 'Multiple provider Check Runs share one Rorca external identity');
    }
    const total = Number(body.total_count ?? pageRows.length);
    if (pageRows.length < 100 || page * 100 >= total) return matches[0]?.id ?? null;
    if (page === maxPages) {
      throw new ProjectionProviderError('GITHUB_CHECK_RUN_DISCOVERY_TRUNCATED', true, true, response.status, safeRequestId(response), 'GitHub Check Run discovery exceeded its deterministic page bound');
    }
  }
  return matches[0]?.id ?? null;
}

function providerBody(claim: ProjectionClaim): Record<string, unknown> {
  const output = {
    title: claim.desired_payload.title,
    summary: claim.desired_payload.summary,
    ...(claim.desired_payload.text ? { text: claim.desired_payload.text } : {}),
    ...(claim.desired_payload.annotations.length
      ? { annotations: claim.desired_payload.annotations }
      : {}),
  };
  if (claim.desired_state === 'completed') {
    return {
      name: CHECK_RUN_NAME,
      head_sha: claim.head_sha,
      external_id: claim.external_id,
      details_url: buildRunViewUrl(Number(claim.run_id)),
      status: 'completed',
      conclusion: claim.conclusion,
      completed_at: new Date().toISOString(),
      output,
    };
  }
  return {
    name: CHECK_RUN_NAME,
    head_sha: claim.head_sha,
    external_id: claim.external_id,
    details_url: buildRunViewUrl(Number(claim.run_id)),
    status: 'in_progress',
    started_at: new Date().toISOString(),
    output,
  };
}

async function applyProviderProjection(
  owner: string,
  repo: string,
  token: string,
  claim: ProjectionClaim,
): Promise<number> {
  if (claim.provider_head_sha && claim.provider_head_sha !== claim.head_sha) {
    const priorClaim = { ...claim, head_sha: claim.provider_head_sha };
    const priorId = claim.check_run_id == null
      ? await discoverCheckRun(owner, repo, token, priorClaim)
      : Number(claim.check_run_id);
    if (priorId) {
      await providerFetch(
        githubRepoApiUrl(owner, repo, `/check-runs/${priorId}`),
        {
          method: 'PATCH',
          headers: headers(token),
          body: JSON.stringify({
            status: 'completed', conclusion: 'neutral', completed_at: new Date().toISOString(),
            output: { title: `Pipeline Run #${Number(claim.run_id)} — superseded head`, summary: `Final evidence moved to ${claim.head_sha}.` },
          }),
        },
        'GITHUB_CHECK_RUN_SUPERSEDE_FAILED',
      );
    }
  }
  let checkRunId = await discoverCheckRun(owner, repo, token, claim);
  const body = providerBody(claim);
  if (checkRunId) {
    const { name: _name, head_sha: _headSha, external_id: _externalId, ...patch } = body;
    await providerFetch(
      githubRepoApiUrl(owner, repo, `/check-runs/${checkRunId}`),
      { method: 'PATCH', headers: headers(token), body: JSON.stringify(patch) },
      'GITHUB_CHECK_RUN_UPDATE_FAILED',
    );
    return checkRunId;
  }
  const response = await providerFetch(
    githubRepoApiUrl(owner, repo, '/check-runs'),
    { method: 'POST', headers: headers(token), body: JSON.stringify(body) },
    'GITHUB_CHECK_RUN_CREATE_FAILED',
  );
  try {
    const created = await response.json() as { id?: number };
    checkRunId = Number(created.id);
  } catch {
    throw new ProjectionProviderError('GITHUB_CHECK_RUN_CREATE_UNCERTAIN', true, true, response.status, safeRequestId(response), 'GitHub Check Run create response was unreadable');
  }
  if (!Number.isSafeInteger(checkRunId) || checkRunId <= 0) {
    throw new ProjectionProviderError('GITHUB_CHECK_RUN_CREATE_UNCERTAIN', true, true, response.status, safeRequestId(response), 'GitHub Check Run create response omitted its identity');
  }
  return checkRunId;
}

async function finishClaim(
  claim: ProjectionClaim,
  state: 'projected' | 'completed' | 'retry' | 'uncertain' | 'blocked',
  values: {
    checkRunId?: number;
    providerHeadSha?: string;
    requestId?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    retryDelayMs?: number;
  } = {},
): Promise<boolean> {
  const result = await execute(`
    UPDATE github_check_run_projections
       SET projection_status = CASE WHEN desired_payload_hash = $3 THEN $4 ELSE 'pending' END,
           check_run_id = COALESCE($5, check_run_id),
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
    values.checkRunId ?? null, values.providerHeadSha ?? null,
    values.requestId ?? null, values.errorCode ?? null,
    values.errorMessage?.slice(0, 512) ?? null, values.retryDelayMs ?? 0,
  ]);
  return result.rowCount === 1;
}

async function emitProjectionWal(claim: ProjectionClaim, checkRunId: number): Promise<void> {
  const eventType = claim.desired_state === 'completed' ? 'check_run_completed' : 'check_run_created';
  const payload = {
    run_id: Number(claim.run_id),
    check_run_id: checkRunId,
    sha: claim.head_sha,
    conclusion: claim.conclusion,
    ...claim.desired_payload.counts,
  };
  const ingestKey = `github-check-projection:v1:${Number(claim.run_id)}:${claim.desired_payload_hash}`;
  const event = await queryOne<WalEvent>(`
    INSERT INTO wal_events (event_type, workspace_id, spec_id, actor, payload, ingest_key)
    VALUES ($1,$2,$3,'github',$4::jsonb,$5)
    ON CONFLICT (ingest_key) WHERE ingest_key IS NOT NULL DO NOTHING
    RETURNING *
  `, [eventType, claim.workspace_id, claim.spec_id, JSON.stringify(payload), ingestKey]);
  if (event) broadcastAll(event);
}

export async function reconcileCheckRunProjection(runId: number): Promise<boolean> {
  const claim = await claimProjection(runId);
  if (!claim) return false;
  try {
    // Repeat exact canonical branch and terminal HEAD verification immediately
    // before repository authority/token resolution. Drift blocks all provider use.
    const exactHead = await resolveBranchHead(Number(claim.run_id), claim.workspace_id);
    if (!exactHead || exactHead !== claim.head_sha) {
      await finishClaim(claim, 'blocked', {
        errorCode: 'GITHUB_CHECK_RUN_TERMINAL_HEAD_DRIFT',
        errorMessage: 'Canonical run branch/HEAD changed after durable projection acceptance',
      });
      return false;
    }
    // Repository authority and token resolution happen only after the immutable
    // local projection has been durably accepted, claimed, and reverified.
    const repository = await getRepository(claim.workspace_id);
    if (!repository) {
      await finishClaim(claim, 'retry', {
        errorCode: 'GITHUB_REPOSITORY_AUTHORITY_UNAVAILABLE',
        errorMessage: 'Canonical GitHub repository authority is unavailable',
        retryDelayMs: 30_000,
      });
      return false;
    }
    const token = await getToken(claim.workspace_id, repository.owner, repository.repo);
    if (!token) {
      await finishClaim(claim, 'retry', {
        errorCode: 'GITHUB_CHECKS_TOKEN_UNAVAILABLE',
        errorMessage: 'Purpose-scoped GitHub Checks token is unavailable',
        retryDelayMs: 30_000,
      });
      return false;
    }
    const checkRunId = await applyProviderProjection(repository.owner, repository.repo, token, claim);
    const status = claim.desired_state === 'completed' ? 'completed' : 'projected';
    if (await finishClaim(claim, status, {
      checkRunId,
      providerHeadSha: claim.head_sha,
    })) {
      await emitProjectionWal(claim, checkRunId);
    }
    return true;
  } catch (error) {
    const providerError = error instanceof ProjectionProviderError
      ? error
      : new ProjectionProviderError(
        'GITHUB_CHECK_RUN_PROJECTION_FAILED', true, true, null, null,
        formatGithubProviderError(sanitizeGithubProviderException(error, 'GITHUB_CHECK_RUN_PROJECTION_FAILED')),
      );
    const state = providerError.uncertain
      ? 'uncertain'
      : providerError.retryable ? 'retry' : 'blocked';
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
    logger.warn({
      runId,
      code: providerError.code,
      state,
      statusCode: providerError.statusCode,
    }, '[CheckRun] Durable projection deferred');
    return false;
  }
}

function scheduleReconcile(runId: number): void {
  if (scheduledRuns.has(runId)) return;
  scheduledRuns.add(runId);
  setImmediate(() => {
    void reconcileCheckRunProjection(runId)
      .catch(error => logger.warn({ error, runId }, '[CheckRun] Scheduled projection failed'))
      .finally(() => scheduledRuns.delete(runId));
  });
}

export async function reconcilePendingCheckRunProjections(limit = 100): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new RangeError('Invalid Check Run reconciliation limit');
  const rows = await query<{ run_id: number | string }>(`
    SELECT run_id FROM github_check_run_projections
     WHERE projection_status IN ('pending', 'retry', 'uncertain')
        OR (projection_status = 'processing' AND claimed_at < NOW() - INTERVAL '2 minutes')
     ORDER BY updated_at ASC
     LIMIT $1
  `, [limit]);
  let completed = 0;
  for (const row of rows) {
    if (await reconcileCheckRunProjection(Number(row.run_id))) completed++;
  }
  return completed;
}

/** Test/direct seam: durably accept and then synchronously attempt projection. */
export async function handleCheckRunWalEvent(event: WalEvent): Promise<void> {
  const runId = await acceptCheckRunWalEvent(event);
  if (runId) await reconcileCheckRunProjection(runId);
}

export function resetCheckRunPosterForTests(): void {
  scheduledRuns.clear();
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
}

export function startCheckRunPoster(): void {
  subscribeDurable(async (event) => {
    if (event.event_type !== 'run_started' && event.event_type !== 'run_finished') return;
    const runId = await acceptCheckRunWalEvent(event);
    if (runId) scheduleReconcile(runId);
  });
  void reconcilePendingCheckRunProjections().catch(error =>
    logger.warn({ error }, '[CheckRun] Startup projection reconciliation deferred'));
  if (!reconcileTimer) {
    reconcileTimer = setInterval(() => {
      void reconcilePendingCheckRunProjections().catch(error =>
        logger.warn({ error }, '[CheckRun] Periodic projection reconciliation deferred'));
    }, RECONCILE_INTERVAL_MS);
    reconcileTimer.unref?.();
  }
  logger.info('[CheckRun] Durable Check Run projector subscribed');
}
