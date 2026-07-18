/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Canonical atomic persistence for execution-engine story-result projections. */

import * as path from 'path';
import type { PoolClient } from 'pg';
import { transaction } from '../db/index';
import { ConflictError, NotFoundError } from './errors';

export const STORY_RESULT_STATUSES = ['pass', 'fail', 'skip', 'excluded'] as const;
export type CanonicalStoryResultStatus = typeof STORY_RESULT_STATUSES[number];

export interface CanonicalStoryResultInput {
  runId: number;
  storyId: string;
  status: CanonicalStoryResultStatus;
  worktreePath?: string;
  worktreeBranch?: string;
  commitSha?: string;
  commitMessage?: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  modelUsed?: string;
  costUsd?: number;
  logPath?: string;
  blockedBy?: string[];
  activeSkills?: string[];
  completionPacket?: Record<string, unknown>;
  idempotencyKey?: string;
  /** Fallback journals preserve the original observation time. HTTP writes use DB time. */
  finishedAt?: string;
  /** Fallback replay binds a workspace journal to its owning run. */
  expectedWorkspaceId?: string;
}

export interface CanonicalStoryResultOutcome {
  id: number;
  duplicate: boolean;
}

interface RunProjectionRow {
  workspace_id: string;
  spec_path: string;
  branch_name: string | null;
  manifest_hash: string | null;
  spec_revision: string | null;
  story_revision: string | null;
  closeout_decision_id: string | null;
}

interface StoryResultIdentityRow {
  id: number;
  run_id: number | string;
  story_id: string;
  status: string;
  worktree_path: string | null;
  worktree_branch: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  model_used: string | null;
  cost_usd: number | null;
  log_path: string | null;
  blocked_by: string | null;
  active_skills: string | null;
  completion_packet: unknown;
  spec_id: string | null;
  ingest_key: string | null;
}

interface StoryCommitRow {
  id: number;
  story_id: string;
  spec_id: string;
  workspace_id: string;
  run_id: number | string | null;
  commit_sha: string;
  commit_message: string;
  author: string;
  branch_name: string | null;
  observed_source: string;
}

interface TokenUsageRow {
  id: number;
  workspace_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cost_usd: number;
}

interface ModelPricingRow {
  input_cost_per_1k: number;
  output_cost_per_1k: number;
}

function rows<T>(result: { rows: T[] }): T[] {
  return result.rows;
}

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

function jsonText(value: string[] | undefined): string | null {
  return value && value.length > 0 ? JSON.stringify(value) : null;
}

function nullable<T>(value: T | undefined): T | null {
  return value ?? null;
}

function sameNumber(left: number | null, right: number | null): boolean {
  return left === right || (left != null && right != null && Number(left) === Number(right));
}

function assertSameResultPayload(
  existing: StoryResultIdentityRow,
  input: CanonicalStoryResultInput,
  specId: string,
): void {
  const expectedCompletionPacket = input.completionPacket ?? null;
  const actualCompletionPacket = existing.completion_packet ?? null;
  const matches = Number(existing.run_id) === input.runId
    && existing.story_id === input.storyId
    && existing.status === input.status
    && existing.worktree_path === nullable(input.worktreePath)
    && existing.worktree_branch === nullable(input.worktreeBranch)
    && sameNumber(existing.input_tokens, nullable(input.inputTokens))
    && sameNumber(existing.output_tokens, nullable(input.outputTokens))
    && existing.model_used === nullable(input.modelUsed)
    && sameNumber(existing.cost_usd, nullable(input.costUsd))
    && existing.log_path === nullable(input.logPath)
    && existing.blocked_by === jsonText(input.blockedBy)
    && existing.active_skills === jsonText(input.activeSkills)
    && stableJson(actualCompletionPacket) === stableJson(expectedCompletionPacket)
    && existing.spec_id === specId
    && existing.ingest_key === input.idempotencyKey;

  if (!matches) {
    throw new ConflictError('Story result idempotency key is already bound to a different immutable payload');
  }
}

function expectedCommit(input: CanonicalStoryResultInput, projection: RunProjectionRow, specId: string) {
  if (input.status !== 'pass' || !input.commitSha) return null;
  return {
    storyId: input.storyId,
    specId,
    workspaceId: projection.workspace_id,
    runId: input.runId,
    commitSha: input.commitSha,
    commitMessage: input.commitMessage?.trim() || `integrated story(${input.storyId}): host-verified run-branch HEAD`,
    author: 'rorca-execution-engine',
    branchName: input.worktreeBranch ?? projection.branch_name,
    observedSource: 'worktree_branch',
  };
}

function assertSameCommit(row: StoryCommitRow | undefined, expected: NonNullable<ReturnType<typeof expectedCommit>>): void {
  if (!row
    || row.story_id !== expected.storyId
    || row.spec_id !== expected.specId
    || row.workspace_id !== expected.workspaceId
    || Number(row.run_id) !== expected.runId
    || row.commit_sha !== expected.commitSha
    || row.commit_message !== expected.commitMessage
    || row.author !== expected.author
    || row.branch_name !== expected.branchName
    || row.observed_source !== expected.observedSource) {
    throw new ConflictError('Story result integrated commit projection is missing or conflicts with its immutable payload');
  }
}

function needsAccounting(input: CanonicalStoryResultInput): boolean {
  return (input.inputTokens != null && input.inputTokens > 0)
    || (input.outputTokens != null && input.outputTokens > 0);
}

async function expectedAccounting(
  client: PoolClient,
  input: CanonicalStoryResultInput,
  workspaceId: string,
): Promise<Omit<TokenUsageRow, 'id'>> {
  const model = input.modelUsed || 'unknown';
  const pricing = rows(await client.query<ModelPricingRow>(
    'SELECT input_cost_per_1k, output_cost_per_1k FROM model_pricing WHERE model_id = $1',
    [model],
  ))[0];
  const inputTokens = input.inputTokens || 0;
  const outputTokens = input.outputTokens || 0;
  const derivedCost = pricing
    ? (inputTokens / 1000) * pricing.input_cost_per_1k + (outputTokens / 1000) * pricing.output_cost_per_1k
    : 0;
  return {
    workspace_id: workspaceId,
    model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    reasoning_tokens: input.reasoningTokens ?? 0,
    cost_usd: Math.round((input.costUsd ?? derivedCost) * 1_000_000) / 1_000_000,
  };
}

function assertSameAccounting(
  rowsToCheck: TokenUsageRow[],
  expected: Omit<TokenUsageRow, 'id'>,
): void {
  const matches = rowsToCheck.filter(row => row.workspace_id === expected.workspace_id
    && row.model === expected.model
    && Number(row.input_tokens) === expected.input_tokens
    && Number(row.output_tokens) === expected.output_tokens
    && Number(row.reasoning_tokens) === expected.reasoning_tokens
    && sameNumber(row.cost_usd, expected.cost_usd));
  if (matches.length !== 1) {
    throw new ConflictError('Story result token accounting projection is incomplete or ambiguous');
  }
}

async function loadRunProjection(client: PoolClient, input: CanonicalStoryResultInput): Promise<RunProjectionRow> {
  const projection = rows(await client.query<RunProjectionRow>(`
    SELECT pr.workspace_id, pr.spec_path, pr.branch_name,
           sem.manifest_hash, sem.spec_revision, sem.story_revision,
           scd.decision_id AS closeout_decision_id
    FROM pipeline_runs pr
    LEFT JOIN LATERAL (
      SELECT manifest_hash, spec_revision, story_revision
      FROM story_execution_manifests
      WHERE workspace_id = pr.workspace_id AND run_id = pr.id AND story_id = $2
      ORDER BY attempt DESC, created_at DESC LIMIT 1
    ) sem ON TRUE
    LEFT JOIN LATERAL (
      SELECT decision_id
      FROM story_closeout_decisions
      WHERE workspace_id = pr.workspace_id AND run_id = pr.id AND story_id = $2
        AND manifest_hash = sem.manifest_hash
      ORDER BY attempt DESC, created_at DESC LIMIT 1
    ) scd ON TRUE
    WHERE pr.id = $1
  `, [input.runId, input.storyId]))[0];
  if (!projection) throw new NotFoundError('Pipeline run not found');
  if (input.expectedWorkspaceId && projection.workspace_id !== input.expectedWorkspaceId) {
    throw new ConflictError('Fallback story result does not belong to the replay workspace');
  }
  return projection;
}

async function loadCommit(
  client: PoolClient,
  expected: NonNullable<ReturnType<typeof expectedCommit>>,
): Promise<StoryCommitRow | undefined> {
  return rows(await client.query<StoryCommitRow>(`
    SELECT id, story_id, spec_id, workspace_id, run_id, commit_sha,
           commit_message, author, branch_name, observed_source
    FROM story_commits
    WHERE workspace_id = $1 AND spec_id = $2 AND run_id = $3
      AND story_id = $4 AND commit_sha = $5
    LIMIT 1
  `, [expected.workspaceId, expected.specId, expected.runId, expected.storyId, expected.commitSha]))[0];
}

/**
 * Persist the logical result and every dependent projection in one transaction.
 * A duplicate is acknowledged only after immutable payload and completeness
 * checks succeed under the same transaction snapshot.
 */
export async function persistCanonicalStoryResult(
  input: CanonicalStoryResultInput,
): Promise<CanonicalStoryResultOutcome> {
  return transaction(async (client) => {
    const projection = await loadRunProjection(client, input);
    const specId = path.basename(projection.spec_path, '.json');
    const inserted = rows(await client.query<{ id: number }>(`
      INSERT INTO story_results (
        run_id, story_id, status, finished_at, worktree_path, worktree_branch,
        input_tokens, output_tokens, model_used, cost_usd, log_path, blocked_by,
        active_skills, completion_packet, spec_id, spec_revision, story_revision,
        manifest_hash, closeout_decision_id, ingest_key
      ) VALUES (
        $1, $2, $3, COALESCE($4::timestamptz, NOW()), $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14::jsonb, $15, $16, $17, $18, $19, $20
      )
      ON CONFLICT (ingest_key) WHERE ingest_key IS NOT NULL DO NOTHING
      RETURNING id
    `, [
      input.runId,
      input.storyId,
      input.status,
      input.finishedAt ?? null,
      input.worktreePath ?? null,
      input.worktreeBranch ?? null,
      input.inputTokens ?? null,
      input.outputTokens ?? null,
      input.modelUsed ?? null,
      input.costUsd ?? null,
      input.logPath ?? null,
      jsonText(input.blockedBy),
      jsonText(input.activeSkills),
      input.completionPacket ? JSON.stringify(input.completionPacket) : null,
      specId,
      projection.spec_revision,
      projection.story_revision,
      projection.manifest_hash,
      projection.closeout_decision_id,
      input.idempotencyKey ?? null,
    ]))[0];

    const commit = expectedCommit(input, projection, specId);
    const accounting = needsAccounting(input)
      ? await expectedAccounting(client, input, projection.workspace_id)
      : null;

    if (!inserted) {
      if (!input.idempotencyKey) {
        throw new ConflictError('Story result insert conflicted without an idempotency key');
      }
      const existing = rows(await client.query<StoryResultIdentityRow>(`
        SELECT id, run_id, story_id, status, worktree_path, worktree_branch,
               input_tokens, output_tokens, model_used, cost_usd, log_path,
               blocked_by, active_skills, completion_packet, spec_id, ingest_key
        FROM story_results
        WHERE ingest_key = $1
        FOR UPDATE
      `, [input.idempotencyKey]))[0];
      if (!existing) throw new ConflictError('Story result duplicate is not durably readable');
      assertSameResultPayload(existing, input, specId);

      if (commit) assertSameCommit(await loadCommit(client, commit), commit);
      if (accounting) {
        const usageRows = rows(await client.query<TokenUsageRow>(`
          SELECT id, workspace_id, model, input_tokens, output_tokens, reasoning_tokens, cost_usd
          FROM token_usage
          WHERE run_id = $1 AND story_id = $2
        `, [input.runId, input.storyId]));
        assertSameAccounting(usageRows, accounting);
      }
      return { id: existing.id, duplicate: true };
    }

    if (commit) {
      const projected = rows(await client.query<StoryCommitRow>(`
        INSERT INTO story_commits (
          story_id, spec_id, workspace_id, run_id, commit_sha, commit_message,
          author, pushed_at, branch_name, observed_source
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),$8,$9)
        ON CONFLICT DO NOTHING
        RETURNING id, story_id, spec_id, workspace_id, run_id, commit_sha,
                  commit_message, author, branch_name, observed_source
      `, [
        commit.storyId,
        commit.specId,
        commit.workspaceId,
        commit.runId,
        commit.commitSha,
        commit.commitMessage,
        commit.author,
        commit.branchName,
        commit.observedSource,
      ]))[0] ?? await loadCommit(client, commit);
      assertSameCommit(projected, commit);
    }

    if (accounting) {
      await client.query(`
        INSERT INTO token_usage (
          run_id, story_id, workspace_id, model, input_tokens, output_tokens,
          reasoning_tokens, cost_usd
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `, [
        input.runId,
        input.storyId,
        accounting.workspace_id,
        accounting.model,
        accounting.input_tokens,
        accounting.output_tokens,
        accounting.reasoning_tokens,
        accounting.cost_usd,
      ]);
    }

    return { id: inserted.id, duplicate: false };
  });
}
