/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Canonical atomic persistence for execution-engine story-result projections. */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { PoolClient } from 'pg';
import { query, transaction } from '../db/index';
import { ConflictError, NotFoundError, ValidationError } from './errors';
import { assertCanonicalRunCheckout } from './run-git-authority';
import {
  assertExactTrustedWalRow,
  insertTrustedWalEvent,
  trustedWalReference,
  type TrustedWalReference,
  type TrustedWalRow,
} from './trusted-wal';

export const STORY_RESULT_STATUSES = ['pass', 'fail', 'skip', 'excluded'] as const;
export type CanonicalStoryResultStatus = typeof STORY_RESULT_STATUSES[number];

export type StoryResultProvenance = 'host' | 'compatibility' | 'recovery_proposal';
export type StoryResultSource = 'execution-engine' | 'worker' | 'compatibility-http' | 'fallback-journal';

export interface StoryResultPersistenceAuthority {
  provenance: StoryResultProvenance;
  source: StoryResultSource;
}

export const EXECUTION_ENGINE_RESULT_AUTHORITY = Object.freeze({
  provenance: 'host', source: 'execution-engine',
} satisfies StoryResultPersistenceAuthority);
export const WORKER_RESULT_AUTHORITY = Object.freeze({
  provenance: 'host', source: 'worker',
} satisfies StoryResultPersistenceAuthority);
const COMPATIBILITY_RESULT_AUTHORITY = Object.freeze({
  provenance: 'compatibility', source: 'compatibility-http',
} satisfies StoryResultPersistenceAuthority);

export interface CanonicalStoryResultInput {
  runId: number;
  storyId: string;
  status: CanonicalStoryResultStatus;
  worktreePath?: string;
  worktreeBranch?: string;
  /** Explicitly distinguishes integrated implementation passes from legitimate non-integrated modes. */
  integrated?: boolean;
  commitSha?: string;
  commitMessage?: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  modelUsed?: string;
  costUsd?: number;
  logPath?: string;
  reason?: string;
  blockedBy?: string[];
  activeSkills?: string[];
  completionPacket?: Record<string, unknown>;
  idempotencyKey?: string;
  /** Fallback journals preserve the original observation time. HTTP/direct writes use DB time. */
  finishedAt?: string;
  /** Fallback/direct host writes bind a workspace journal to its owning run. */
  expectedWorkspaceId?: string;
  /** Host-only integrated-pass outbox request. Public story-result routes omit it. */
  trustedPassOutbox?: {
    payload: Record<string, unknown>;
  };
}

export interface CanonicalStoryResultOutcome {
  id: number;
  duplicate: boolean;
  trustedWal?: TrustedWalReference;
}

export interface StoryResultAtomicFinalizationOptions {
  integrationFinalization?: {
    attempt: number;
    resultingHead: string;
    validationIdentity?: Record<string, unknown>;
    finalizationIdentity: {
      idempotencyKey: string;
      revision: string;
      receiptHash: string;
    };
  };
}

export interface LegacyStoryAccountingInput {
  runId: number;
  storyId: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  modelUsed?: string;
  costUsd?: number;
}

interface RunProjectionRow {
  workspace_id: string;
  spec_path: string;
  branch_name: string | null;
  execution_workspace_path: string | null;
  execution_worktree_path: string | null;
  manifest_hash: string | null;
  spec_revision: string | null;
  story_revision: string | null;
  closeout_decision_id: string | null;
  closeout_status: string | null;
}

interface StoryResultIdentityRow {
  id: number;
  run_id: number | string;
  story_id: string;
  status: string;
  finished_at: string | Date | null;
  finished_at_source: string;
  result_provenance: string;
  result_source: string;
  worktree_path: string | null;
  worktree_branch: string | null;
  integrated: boolean;
  commit_sha: string | null;
  commit_message: string | null;
  commit_author: string | null;
  commit_branch: string | null;
  commit_observed_source: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  model_used: string | null;
  cost_usd: number | null;
  log_path: string | null;
  reason: string | null;
  blocked_by: string | null;
  active_skills: string | null;
  completion_packet: unknown;
  spec_id: string | null;
  spec_revision: string | null;
  story_revision: string | null;
  manifest_hash: string | null;
  closeout_decision_id: string | null;
  ingest_key: string | null;
  accounting_required: boolean;
  accounting_model: string | null;
  accounting_input_tokens: number | null;
  accounting_output_tokens: number | null;
  accounting_reasoning_tokens: number | null;
  accounting_cost_usd: number | null;
  accounting_cost_source: string | null;
  accounting_input_rate: number | null;
  accounting_output_rate: number | null;
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
  story_result_id: number | string | null;
  workspace_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cost_usd: number;
  cost_source: string;
  input_cost_per_1k: number | null;
  output_cost_per_1k: number | null;
}

interface ModelPricingRow {
  input_cost_per_1k: number;
  output_cost_per_1k: number;
}

interface NormalizedCommit {
  storyId: string;
  specId: string;
  workspaceId: string;
  runId: number;
  commitSha: string;
  commitMessage: string;
  author: string;
  branchName: string;
  observedSource: string;
}

interface NormalizedAccounting {
  workspace_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cost_usd: number;
  cost_source: 'explicit' | 'derived' | 'legacy';
  input_cost_per_1k: number | null;
  output_cost_per_1k: number | null;
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

function roundedCost(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function sameNumber(left: number | null, right: number | null): boolean {
  return left === right || (left != null && right != null && Number(left) === Number(right));
}

function normalizeObservedTimestamp(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new ValidationError('finishedAt must be a valid timestamp');
  return parsed.toISOString();
}

function sameTimestamp(left: string | Date | null, right: string): boolean {
  if (left == null) return false;
  const parsed = left instanceof Date ? left : new Date(left);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === right;
}

function assertNonNegativeFinite(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new ValidationError(`${name} must be a non-negative finite number`);
  }
}

function validateInput(
  input: CanonicalStoryResultInput,
  authority: StoryResultPersistenceAuthority,
  options: { requireWriteRole?: boolean } = { requireWriteRole: true },
): void {
  if (!Number.isSafeInteger(input.runId) || input.runId <= 0) throw new ValidationError('runId must be a positive integer');
  if (typeof input.storyId !== 'string' || !input.storyId) throw new ValidationError('storyId is required');
  if (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey || input.idempotencyKey.length > 256) {
    throw new ValidationError('idempotencyKey is required and must be at most 256 characters');
  }
  if (!STORY_RESULT_STATUSES.includes(input.status)) throw new ValidationError(`Invalid status: ${input.status}`);
  if (input.integrated !== undefined && typeof input.integrated !== 'boolean') {
    throw new ValidationError('integrated must be a boolean');
  }
  for (const [name, value] of [
    ['inputTokens', input.inputTokens],
    ['outputTokens', input.outputTokens],
    ['reasoningTokens', input.reasoningTokens],
    ['costUsd', input.costUsd],
  ] as const) assertNonNegativeFinite(name, value);
  for (const [name, value] of [
    ['inputTokens', input.inputTokens],
    ['outputTokens', input.outputTokens],
    ['reasoningTokens', input.reasoningTokens],
  ] as const) {
    if (value !== undefined && !Number.isSafeInteger(value)) throw new ValidationError(`${name} must be an integer`);
  }
  for (const [name, value] of [
    ['worktreePath', input.worktreePath],
    ['worktreeBranch', input.worktreeBranch],
    ['commitSha', input.commitSha],
    ['commitMessage', input.commitMessage],
    ['modelUsed', input.modelUsed],
    ['logPath', input.logPath],
    ['reason', input.reason],
    ['finishedAt', input.finishedAt],
    ['expectedWorkspaceId', input.expectedWorkspaceId],
  ] as const) {
    if (value !== undefined && typeof value !== 'string') throw new ValidationError(`${name} must be a string`);
  }
  for (const [name, value] of [['blockedBy', input.blockedBy], ['activeSkills', input.activeSkills]] as const) {
    if (value !== undefined && (!Array.isArray(value) || value.some(item => typeof item !== 'string'))) {
      throw new ValidationError(`${name} must be an array of strings`);
    }
  }
  if (input.completionPacket !== undefined
    && (input.completionPacket === null || Array.isArray(input.completionPacket) || typeof input.completionPacket !== 'object')) {
    throw new ValidationError('completionPacket must be an object');
  }
  if (input.trustedPassOutbox !== undefined
    && (!input.trustedPassOutbox || Array.isArray(input.trustedPassOutbox)
      || typeof input.trustedPassOutbox !== 'object'
      || !input.trustedPassOutbox.payload
      || Array.isArray(input.trustedPassOutbox.payload)
      || typeof input.trustedPassOutbox.payload !== 'object')) {
    throw new ValidationError('trustedPassOutbox.payload must be an object');
  }
  const hostIntegratedAuthority = authority.provenance === 'host'
    && authority.source === 'execution-engine';
  if (input.trustedPassOutbox && (!hostIntegratedAuthority || input.integrated !== true)) {
    throw new ValidationError('Trusted pass outbox requires host execution-engine authority and an explicit integrated pass');
  }
  if ((input.integrated === true || input.commitSha !== undefined || input.commitMessage !== undefined)
    && !hostIntegratedAuthority) {
    throw new ValidationError('Integrated result and commit identity are host-only');
  }
  if (authority.provenance === 'recovery_proposal' || authority.source === 'fallback-journal') {
    throw new ValidationError('Fallback story results are proposal-only and cannot be persisted');
  }
  if ((authority.source === 'worker' && authority.provenance !== 'host')
    || (authority.source === 'execution-engine' && authority.provenance !== 'host')
    || (authority.source === 'compatibility-http' && authority.provenance !== 'compatibility')) {
    throw new ValidationError('Story result persistence authority is invalid');
  }
  if (options.requireWriteRole !== false && process.env.NODE_ENV !== 'test' && authority.provenance === 'host') {
    const requiredRole = authority.source === 'worker' ? 'worker' : 'engine';
    if (process.env.RORCA_PROCESS_ROLE !== requiredRole) {
      throw new ValidationError(`Host story result source ${authority.source} requires ${requiredRole} process authority`);
    }
  }
  if (input.integrated === true && (input.status !== 'pass' || input.commitSha === undefined)) {
    throw new ValidationError('Integrated pass requires pass status and exact commitSha');
  }
  if (input.integrated === false && input.commitSha !== undefined) {
    throw new ValidationError('commitSha cannot be supplied for a non-integrated result');
  }
  if (input.commitMessage !== undefined && input.commitSha === undefined) {
    throw new ValidationError('commitMessage requires commitSha');
  }
  if (input.commitSha !== undefined && !/^[0-9a-f]{40}$/i.test(input.commitSha)) {
    throw new ValidationError('commitSha must be a full 40-hex Git/GitHub object id');
  }
  if (input.finishedAt !== undefined) normalizeObservedTimestamp(input.finishedAt);
}

function normalizedCommit(
  input: CanonicalStoryResultInput,
  projection: RunProjectionRow,
  specId: string,
  authority: StoryResultPersistenceAuthority,
): NormalizedCommit | null {
  const integrated = input.integrated === true || (input.integrated === undefined && input.commitSha !== undefined);
  if (!integrated) return null;
  if (authority.provenance !== 'host' || authority.source !== 'execution-engine') {
    throw new ValidationError('Integrated result and commit identity are host-only');
  }
  if (input.status !== 'pass') throw new ValidationError('Only pass results can be integrated');
  if (!input.commitSha) throw new ValidationError('Integrated pass requires exact commitSha');
  if (!projection.manifest_hash || !projection.closeout_decision_id || projection.closeout_status !== 'accepted') {
    throw new ConflictError('Integrated pass requires an accepted closeout decision for the active manifest');
  }
  const branchName = input.worktreeBranch?.trim();
  const canonicalBranch = projection.branch_name?.trim();
  if (!branchName || !canonicalBranch || branchName !== canonicalBranch) {
    throw new ConflictError('Integrated pass branch must exactly match pipeline run authority');
  }
  if (!input.worktreePath || !projection.execution_workspace_path || !projection.execution_worktree_path) {
    throw new ConflictError('Integrated pass requires DB-frozen workspace/worktree identity');
  }
  let inputWorktree: string;
  let frozenWorkspace: string;
  let frozenWorktree: string;
  try {
    inputWorktree = fs.realpathSync(input.worktreePath);
    frozenWorkspace = fs.realpathSync(projection.execution_workspace_path);
    frozenWorktree = fs.realpathSync(projection.execution_worktree_path);
  } catch {
    throw new ConflictError('Integrated pass workspace/worktree realpath is unavailable');
  }
  if (inputWorktree !== frozenWorktree) {
    throw new ConflictError('Integrated pass worktree differs from DB-frozen run identity');
  }
  assertCanonicalRunCheckout({
    cwd: frozenWorktree,
    repositoryTopLevel: frozenWorkspace,
    branchName,
    expectedHead: input.commitSha,
  });
  return {
    storyId: input.storyId,
    specId,
    workspaceId: projection.workspace_id,
    runId: input.runId,
    commitSha: input.commitSha.toLowerCase(),
    commitMessage: input.commitMessage?.trim() || `integrated story(${input.storyId}): host-verified run-branch HEAD`,
    author: 'rorca-execution-engine',
    branchName,
    observedSource: 'worktree_branch',
  };
}

function needsAccounting(input: Pick<CanonicalStoryResultInput, 'inputTokens' | 'outputTokens' | 'reasoningTokens' | 'costUsd'>): boolean {
  return input.inputTokens !== undefined
    || input.outputTokens !== undefined
    || input.reasoningTokens !== undefined
    || input.costUsd !== undefined;
}

async function deriveAccounting(
  client: PoolClient,
  input: Pick<CanonicalStoryResultInput, 'inputTokens' | 'outputTokens' | 'reasoningTokens' | 'modelUsed' | 'costUsd'>,
  workspaceId: string,
): Promise<NormalizedAccounting | null> {
  if (!needsAccounting(input)) return null;
  const model = input.modelUsed || 'unknown';
  const pricing = rows(await client.query<ModelPricingRow>(
    'SELECT input_cost_per_1k, output_cost_per_1k FROM model_pricing WHERE model_id = $1',
    [model],
  ))[0];
  const inputTokens = input.inputTokens ?? 0;
  const outputTokens = input.outputTokens ?? 0;
  const inputRate = pricing ? Number(pricing.input_cost_per_1k) : null;
  const outputRate = pricing ? Number(pricing.output_cost_per_1k) : null;
  const derivedCost = inputRate != null && outputRate != null
    ? (inputTokens / 1000) * inputRate + (outputTokens / 1000) * outputRate
    : 0;
  return {
    workspace_id: workspaceId,
    model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    reasoning_tokens: input.reasoningTokens ?? 0,
    cost_usd: roundedCost(input.costUsd ?? derivedCost),
    cost_source: input.costUsd !== undefined ? 'explicit' : 'derived',
    input_cost_per_1k: inputRate,
    output_cost_per_1k: outputRate,
  };
}

function accountingFromResult(existing: StoryResultIdentityRow): NormalizedAccounting | null {
  if (!existing.accounting_required) return null;
  if (existing.accounting_model == null
    || existing.accounting_input_tokens == null
    || existing.accounting_output_tokens == null
    || existing.accounting_reasoning_tokens == null
    || existing.accounting_cost_usd == null
    || !['explicit', 'derived', 'legacy'].includes(existing.accounting_cost_source ?? '')) {
    throw new ConflictError('Story result accounting identity is incomplete');
  }
  return {
    workspace_id: '',
    model: existing.accounting_model,
    input_tokens: Number(existing.accounting_input_tokens),
    output_tokens: Number(existing.accounting_output_tokens),
    reasoning_tokens: Number(existing.accounting_reasoning_tokens),
    cost_usd: Number(existing.accounting_cost_usd),
    cost_source: existing.accounting_cost_source as NormalizedAccounting['cost_source'],
    input_cost_per_1k: existing.accounting_input_rate == null ? null : Number(existing.accounting_input_rate),
    output_cost_per_1k: existing.accounting_output_rate == null ? null : Number(existing.accounting_output_rate),
  };
}

function assertSameResultPayload(
  existing: StoryResultIdentityRow,
  input: CanonicalStoryResultInput,
  projection: RunProjectionRow,
  specId: string,
  commit: NormalizedCommit | null,
  accounting: NormalizedAccounting | null,
  authority: StoryResultPersistenceAuthority,
): void {
  const expectedCompletionPacket = input.completionPacket ?? null;
  const actualCompletionPacket = existing.completion_packet ?? null;
  const expectedFinishedSource = input.finishedAt === undefined ? 'database' : 'observed';
  const finishedMatches = existing.finished_at_source === 'legacy'
    ? input.finishedAt === undefined
      || sameTimestamp(existing.finished_at, normalizeObservedTimestamp(input.finishedAt))
    : expectedFinishedSource === 'database'
      ? existing.finished_at_source === 'database'
      : existing.finished_at_source === 'observed'
        && sameTimestamp(existing.finished_at, normalizeObservedTimestamp(input.finishedAt!));
  const existingAccounting = accountingFromResult(existing);
  const accountingIdentityMatches = accounting
    ? existingAccounting != null
      && existingAccounting.model === accounting.model
      && existingAccounting.input_tokens === accounting.input_tokens
      && existingAccounting.output_tokens === accounting.output_tokens
      && existingAccounting.reasoning_tokens === accounting.reasoning_tokens
      && existingAccounting.cost_usd === accounting.cost_usd
      && existingAccounting.cost_source === accounting.cost_source
      && sameNumber(existingAccounting.input_cost_per_1k, accounting.input_cost_per_1k)
      && sameNumber(existingAccounting.output_cost_per_1k, accounting.output_cost_per_1k)
    : existingAccounting == null;

  const matches = Number(existing.run_id) === input.runId
    && existing.story_id === input.storyId
    && existing.status === input.status
    && finishedMatches
    && existing.result_provenance === authority.provenance
    && existing.result_source === authority.source
    && existing.worktree_path === nullable(input.worktreePath)
    && existing.worktree_branch === nullable(input.worktreeBranch)
    && existing.integrated === Boolean(commit)
    && existing.commit_sha === (commit?.commitSha ?? null)
    && existing.commit_message === (commit?.commitMessage ?? null)
    && existing.commit_author === (commit?.author ?? null)
    && existing.commit_branch === (commit?.branchName ?? null)
    && existing.commit_observed_source === (commit?.observedSource ?? null)
    && sameNumber(existing.input_tokens, nullable(input.inputTokens))
    && sameNumber(existing.output_tokens, nullable(input.outputTokens))
    && sameNumber(existing.reasoning_tokens, nullable(input.reasoningTokens))
    && existing.model_used === nullable(input.modelUsed)
    && sameNumber(existing.cost_usd, nullable(input.costUsd))
    && existing.log_path === nullable(input.logPath)
    && existing.reason === nullable(input.reason)
    && existing.blocked_by === jsonText(input.blockedBy)
    && existing.active_skills === jsonText(input.activeSkills)
    && stableJson(actualCompletionPacket) === stableJson(expectedCompletionPacket)
    && existing.spec_id === specId
    && existing.spec_revision === projection.spec_revision
    && existing.story_revision === projection.story_revision
    && existing.manifest_hash === projection.manifest_hash
    && existing.closeout_decision_id === projection.closeout_decision_id
    && existing.ingest_key === input.idempotencyKey
    && existing.accounting_required === Boolean(accounting)
    && accountingIdentityMatches;

  if (!matches) {
    throw new ConflictError('Story result idempotency key is already bound to a different immutable payload');
  }
}

function assertSameCommit(row: StoryCommitRow | undefined, expected: NormalizedCommit): void {
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

function assertSameAccounting(
  usageRows: TokenUsageRow[],
  storyResultId: number,
  workspaceId: string,
  expected: NormalizedAccounting | null,
  allowLegacySource = false,
): void {
  if (!expected) {
    if (usageRows.length !== 0) throw new ConflictError('Story result has an unexpected accounting projection');
    return;
  }
  if (usageRows.length !== 1) {
    throw new ConflictError('Story result token accounting projection is incomplete or ambiguous');
  }
  const row = usageRows[0];
  if (Number(row.story_result_id) !== storyResultId
    || row.workspace_id !== workspaceId
    || row.model !== expected.model
    || Number(row.input_tokens) !== expected.input_tokens
    || Number(row.output_tokens) !== expected.output_tokens
    || Number(row.reasoning_tokens) !== expected.reasoning_tokens
    || !sameNumber(row.cost_usd, expected.cost_usd)
    || (row.cost_source !== expected.cost_source && !(allowLegacySource && row.cost_source === 'legacy'))
    || (!(allowLegacySource && row.cost_source === 'legacy')
      && (!sameNumber(row.input_cost_per_1k, expected.input_cost_per_1k)
        || !sameNumber(row.output_cost_per_1k, expected.output_cost_per_1k)))) {
    throw new ConflictError('Story result token accounting projection conflicts with its immutable identity');
  }
}

async function loadRunProjection(client: PoolClient, input: CanonicalStoryResultInput): Promise<RunProjectionRow> {
  const projection = rows(await client.query<RunProjectionRow>(`
    SELECT pr.workspace_id, pr.spec_path, pr.branch_name,
           pr.execution_workspace_path, pr.execution_worktree_path,
           sem.manifest_hash, sem.spec_revision, sem.story_revision,
           scd.decision_id AS closeout_decision_id,
           scd.status AS closeout_status
    FROM pipeline_runs pr
    LEFT JOIN LATERAL (
      SELECT manifest_hash, spec_revision, story_revision
      FROM story_execution_manifests
      WHERE workspace_id = pr.workspace_id AND run_id = pr.id AND story_id = $2
      ORDER BY attempt DESC, created_at DESC LIMIT 1
    ) sem ON TRUE
    LEFT JOIN LATERAL (
      SELECT decision_id, status
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

async function loadCommit(client: PoolClient, expected: NormalizedCommit): Promise<StoryCommitRow | undefined> {
  return rows(await client.query<StoryCommitRow>(`
    SELECT id, story_id, spec_id, workspace_id, run_id, commit_sha,
           commit_message, author, branch_name, observed_source
    FROM story_commits
    WHERE workspace_id = $1 AND spec_id = $2 AND run_id = $3
      AND story_id = $4 AND commit_sha = $5
    LIMIT 1
  `, [expected.workspaceId, expected.specId, expected.runId, expected.storyId, expected.commitSha]))[0];
}

async function loadAccounting(client: PoolClient, storyResultId: number): Promise<TokenUsageRow[]> {
  return rows(await client.query<TokenUsageRow>(`
    SELECT id, story_result_id, workspace_id, model, input_tokens, output_tokens,
           reasoning_tokens, cost_usd, cost_source, input_cost_per_1k,
           output_cost_per_1k
    FROM token_usage
    WHERE story_result_id = $1
  `, [storyResultId]));
}

function resultIdentitySelect(): string {
  return `id, run_id, story_id, status, finished_at, finished_at_source,
          result_provenance, result_source, worktree_path, worktree_branch,
          integrated, commit_sha, commit_message,
          commit_author, commit_branch, commit_observed_source, input_tokens,
          output_tokens, reasoning_tokens, model_used, cost_usd, log_path,
          reason, blocked_by, active_skills, completion_packet, spec_id, spec_revision,
          story_revision, manifest_hash, closeout_decision_id, ingest_key,
          accounting_required, accounting_model, accounting_input_tokens,
          accounting_output_tokens, accounting_reasoning_tokens,
          accounting_cost_usd, accounting_cost_source, accounting_input_rate,
          accounting_output_rate`;
}

async function persistTrustedPassOutbox(
  client: PoolClient,
  input: CanonicalStoryResultInput,
  projection: RunProjectionRow,
  specId: string,
  resultId: number,
  commit: NormalizedCommit | null,
): Promise<TrustedWalReference | undefined> {
  if (!input.trustedPassOutbox) return undefined;
  if (input.status !== 'pass' || !commit) {
    throw new ConflictError('Trusted pass outbox requires an exact integrated pass commit');
  }
  if (!projection.closeout_decision_id || projection.closeout_status !== 'accepted') {
    throw new ConflictError('Trusted pass outbox requires an accepted canonical closeout decision');
  }
  const event = await insertTrustedWalEvent(client, {
    eventType: 'story_passed',
    workspaceId: projection.workspace_id,
    runId: input.runId,
    storyId: input.storyId,
    specId,
    source: 'story-result',
    storyResultId: resultId,
    payload: {
      ...input.trustedPassOutbox.payload,
      run_id: input.runId,
      story_id: input.storyId,
      story_result_id: resultId,
      commit_sha: commit.commitSha,
      closeout_decision_id: projection.closeout_decision_id,
    },
  });
  return trustedWalReference(event.row);
}

export const WAVE_INTEGRATED_PASS_RECOVERY_VERSION = 'rorca.wave-integrated-pass-recovery.v1' as const;

function stableRecoveryJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableRecoveryJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableRecoveryJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function recoveryPacketHash(packet: Record<string, unknown>): string {
  return createHash('sha256').update(stableRecoveryJson(packet), 'utf8').digest('hex');
}

/** Freeze exact engine-authored pass inputs while crossing integrated -> validated. */
export async function stageIntegratedPassRecoveryPacket(
  input: CanonicalStoryResultInput,
  options: StoryResultAtomicFinalizationOptions,
): Promise<{ packetHash: string; replayed: boolean }> {
  validateInput(input, EXECUTION_ENGINE_RESULT_AUTHORITY);
  const finalization = options.integrationFinalization;
  if (!finalization?.validationIdentity
    || finalization.finalizationIdentity.idempotencyKey !== input.idempotencyKey
    || finalization.resultingHead !== input.commitSha) {
    throw new ValidationError('Integrated pass recovery staging requires exact validation/finalization authority');
  }
  const packet = {
    schemaVersion: WAVE_INTEGRATED_PASS_RECOVERY_VERSION,
    storyResult: input,
    integrationFinalization: finalization,
  };
  const packetHash = recoveryPacketHash(packet);
  return transaction(async (client) => {
    const locked = rows(await client.query<{
      state: string; resulting_head: string | null; validation_identity: Record<string, unknown> | null;
      recovery_packet: Record<string, unknown> | null; recovery_packet_hash: string | null;
    }>(
      `SELECT state, resulting_head, validation_identity, recovery_packet, recovery_packet_hash
       FROM story_integration_ledger
       WHERE run_id = $1 AND story_id = $2 AND attempt = $3
       FOR UPDATE`,
      [input.runId, input.storyId, finalization.attempt],
    ))[0];
    if (!locked || !['integrated', 'integrated_validated'].includes(locked.state)
      || locked.resulting_head?.trim().toLowerCase() !== finalization.resultingHead.toLowerCase()) {
      throw new ConflictError('Wave integration is not ready for exact recovery packet staging');
    }
    if (locked.state === 'integrated_validated') {
      if (!locked.recovery_packet || locked.recovery_packet_hash !== packetHash
        || stableRecoveryJson(locked.recovery_packet) !== stableRecoveryJson(packet)
        || stableRecoveryJson(locked.validation_identity) !== stableRecoveryJson(finalization.validationIdentity)) {
        throw new ConflictError('Wave recovery packet changed during replay');
      }
      return { packetHash, replayed: true };
    }
    const updated = await client.query(
      `UPDATE story_integration_ledger
       SET state = 'integrated_validated',
           validation_identity = $4::jsonb,
           recovery_packet = $5::jsonb,
           recovery_packet_hash = $6
       WHERE run_id = $1 AND story_id = $2 AND attempt = $3 AND state = 'integrated'`,
      [input.runId, input.storyId, finalization.attempt,
        JSON.stringify(finalization.validationIdentity), JSON.stringify(packet), packetHash],
    );
    if (updated.rowCount !== 1) throw new ConflictError('Wave recovery packet staging lost its state fence');
    return { packetHash, replayed: false };
  });
}

async function lockWaveIntegrationFinalization(
  client: PoolClient,
  input: CanonicalStoryResultInput,
  options: StoryResultAtomicFinalizationOptions,
): Promise<'none' | 'integrated_validated' | 'finalized'> {
  const finalization = options.integrationFinalization;
  if (!finalization) return 'none';
  const identity = finalization.finalizationIdentity;
  if (input.status !== 'pass' || !Number.isSafeInteger(finalization.attempt) || finalization.attempt < 1
    || !/^[0-9a-f]{40}$/i.test(finalization.resultingHead)
    || identity.idempotencyKey !== input.idempotencyKey
    || identity.revision !== finalization.resultingHead
    || !/^[0-9a-f]{64}$/i.test(identity.receiptHash)) {
    throw new ValidationError('Wave integration finalization identity is invalid');
  }
  const ledger = rows(await client.query<{
    state: string; resulting_head: string | null; finalization_identity: Record<string, unknown> | null;
  }>(`
    SELECT state, resulting_head, finalization_identity
    FROM story_integration_ledger
    WHERE run_id = $1 AND story_id = $2 AND attempt = $3
    FOR UPDATE
  `, [input.runId, input.storyId, finalization.attempt]))[0];
  if (!ledger || !['integrated_validated', 'finalized'].includes(ledger.state)
    || ledger.resulting_head?.trim().toLowerCase() !== finalization.resultingHead.toLowerCase()) {
    throw new ConflictError('Wave integration ledger is not validated for this exact pass projection');
  }
  if (ledger.state === 'finalized') {
    const prior = ledger.finalization_identity;
    if (!prior
      || prior.idempotencyKey !== identity.idempotencyKey
      || prior.revision !== identity.revision
      || prior.receiptHash !== identity.receiptHash) {
      throw new ConflictError('Wave integration finalization identity changed during replay');
    }
  }
  return ledger.state as 'integrated_validated' | 'finalized';
}

async function finalizeWaveIntegration(
  client: PoolClient,
  input: CanonicalStoryResultInput,
  options: StoryResultAtomicFinalizationOptions,
  state: 'none' | 'integrated_validated' | 'finalized',
): Promise<void> {
  if (state !== 'integrated_validated') return;
  const finalization = options.integrationFinalization!;
  const finalized = await client.query(
    `UPDATE story_integration_ledger
     SET state = 'finalized', finalization_identity = $4::jsonb, finalized_at = NOW()
     WHERE run_id = $1 AND story_id = $2 AND attempt = $3 AND state = 'integrated_validated'`,
    [input.runId, input.storyId, finalization.attempt, JSON.stringify(finalization.finalizationIdentity)],
  );
  if (finalized.rowCount !== 1) throw new ConflictError('Wave integration finalization lost its state fence');
}

/**
 * Persist the logical result and every dependent projection in one transaction.
 * A duplicate is acknowledged only after every immutable input and keyed
 * dependent projection succeeds under the same transaction snapshot.
 */
async function persistCanonicalStoryResultInternal(
  input: CanonicalStoryResultInput,
  authority: StoryResultPersistenceAuthority,
  options: StoryResultAtomicFinalizationOptions,
  requireWriteRole: boolean,
): Promise<CanonicalStoryResultOutcome> {
  validateInput(input, authority, { requireWriteRole });
  return transaction(async (client) => {
    const integrationState = await lockWaveIntegrationFinalization(client, input, options);
    const projection = await loadRunProjection(client, input);
    const specId = path.basename(projection.spec_path, '.json');
    const commit = normalizedCommit(input, projection, specId, authority);
    const accounting = await deriveAccounting(client, input, projection.workspace_id);
    const finishedAt = input.finishedAt === undefined ? null : normalizeObservedTimestamp(input.finishedAt);
    const finishedAtSource = input.finishedAt === undefined ? 'database' : 'observed';

    const inserted = rows(await client.query<{ id: number }>(`
      INSERT INTO story_results (
        run_id, story_id, status, finished_at, finished_at_source,
        worktree_path, worktree_branch, integrated, commit_sha, commit_message,
        commit_author, commit_branch, commit_observed_source, input_tokens,
        output_tokens, reasoning_tokens, model_used, cost_usd, log_path,
        blocked_by, active_skills, completion_packet, spec_id, spec_revision,
        story_revision, manifest_hash, closeout_decision_id, ingest_key,
        accounting_required, accounting_model, accounting_input_tokens,
        accounting_output_tokens, accounting_reasoning_tokens,
        accounting_cost_usd, accounting_cost_source, accounting_input_rate,
        accounting_output_rate, reason, result_provenance, result_source
      ) VALUES (
        $1, $2, $3, COALESCE($4::timestamptz, NOW()), $5, $6, $7, $8, $9,
        $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21,
        $22::jsonb, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32,
        $33, $34, $35, $36, $37, $38, $39, $40
      )
      ON CONFLICT (ingest_key) WHERE ingest_key IS NOT NULL DO NOTHING
      RETURNING id
    `, [
      input.runId,
      input.storyId,
      input.status,
      finishedAt,
      finishedAtSource,
      input.worktreePath ?? null,
      input.worktreeBranch ?? null,
      Boolean(commit),
      commit?.commitSha ?? null,
      commit?.commitMessage ?? null,
      commit?.author ?? null,
      commit?.branchName ?? null,
      commit?.observedSource ?? null,
      input.inputTokens ?? null,
      input.outputTokens ?? null,
      input.reasoningTokens ?? null,
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
      Boolean(accounting),
      accounting?.model ?? null,
      accounting?.input_tokens ?? null,
      accounting?.output_tokens ?? null,
      accounting?.reasoning_tokens ?? null,
      accounting?.cost_usd ?? null,
      accounting?.cost_source ?? null,
      accounting?.input_cost_per_1k ?? null,
      accounting?.output_cost_per_1k ?? null,
      input.reason ?? null,
      authority.provenance,
      authority.source,
    ]))[0];

    if (!inserted) {
      if (!input.idempotencyKey) {
        throw new ConflictError('Story result insert conflicted without an idempotency key');
      }
      const existing = rows(await client.query<StoryResultIdentityRow>(`
        SELECT ${resultIdentitySelect()}
        FROM story_results
        WHERE ingest_key = $1
        FOR UPDATE
      `, [input.idempotencyKey]))[0];
      if (!existing) throw new ConflictError('Story result duplicate is not durably readable');
      assertSameResultPayload(existing, input, projection, specId, commit, accounting, authority);

      if (commit) assertSameCommit(await loadCommit(client, commit), commit);
      assertSameAccounting(
        await loadAccounting(client, existing.id),
        existing.id,
        projection.workspace_id,
        accounting,
      );
      const trustedWal = await persistTrustedPassOutbox(
        client, input, projection, specId, existing.id, commit,
      );
      await finalizeWaveIntegration(client, input, options, integrationState);
      return { id: existing.id, duplicate: true, ...(trustedWal ? { trustedWal } : {}) };
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
      const usage = rows(await client.query<TokenUsageRow>(`
        INSERT INTO token_usage (
          story_result_id, run_id, story_id, workspace_id, model, input_tokens,
          output_tokens, reasoning_tokens, cost_usd, cost_source,
          input_cost_per_1k, output_cost_per_1k
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        RETURNING id, story_result_id, workspace_id, model, input_tokens,
                  output_tokens, reasoning_tokens, cost_usd, cost_source,
                  input_cost_per_1k, output_cost_per_1k
      `, [
        inserted.id,
        input.runId,
        input.storyId,
        accounting.workspace_id,
        accounting.model,
        accounting.input_tokens,
        accounting.output_tokens,
        accounting.reasoning_tokens,
        accounting.cost_usd,
        accounting.cost_source,
        accounting.input_cost_per_1k,
        accounting.output_cost_per_1k,
      ]));
      assertSameAccounting(usage, inserted.id, projection.workspace_id, accounting);
    }

    const trustedWal = await persistTrustedPassOutbox(
      client, input, projection, specId, inserted.id, commit,
    );
    await finalizeWaveIntegration(client, input, options, integrationState);
    return { id: inserted.id, duplicate: false, ...(trustedWal ? { trustedWal } : {}) };
  });
}

export async function persistCanonicalStoryResult(
  input: CanonicalStoryResultInput,
  authority: StoryResultPersistenceAuthority = COMPATIBILITY_RESULT_AUTHORITY,
  options: StoryResultAtomicFinalizationOptions = {},
): Promise<CanonicalStoryResultOutcome> {
  return persistCanonicalStoryResultInternal(input, authority, options, true);
}

export interface IntegratedValidatedPassRecoveryResult {
  scanned: number;
  finalized: number;
  duplicates: number;
  blocked: number;
  truncated: boolean;
  finalizedStoryIds: string[];
}

/**
 * Worker-only host re-finalization. Caller supplies scope only; every result,
 * commit, accounting, outbox, checkout, decision, and finalization input is
 * revalidated from the locked application ledger and canonical run tables.
 */
export async function recoverIntegratedValidatedStoryFinalizations(
  input: { runId?: number; limit?: number } = {},
): Promise<IntegratedValidatedPassRecoveryResult> {
  if (process.env.NODE_ENV !== 'test' && process.env.RORCA_PROCESS_ROLE !== 'worker') {
    throw new ValidationError('Integrated pass re-finalization requires worker process authority');
  }
  const limit = Math.min(100, Math.max(1, input.limit ?? 25));
  const candidates = await query<{
    run_id: number | string; story_id: string; attempt: number;
    resulting_head: string | null; recovery_packet: Record<string, unknown> | null;
    recovery_packet_hash: string | null;
  }>(
    `SELECT run_id, story_id, attempt, resulting_head, recovery_packet, recovery_packet_hash
     FROM story_integration_ledger
     WHERE state = 'integrated_validated'
       AND ($1::bigint IS NULL OR run_id = $1)
     ORDER BY run_id, integration_order, story_id
     LIMIT $2`,
    [input.runId ?? null, limit + 1],
  );
  const truncated = candidates.length > limit;
  const result: IntegratedValidatedPassRecoveryResult = {
    scanned: Math.min(candidates.length, limit), finalized: 0, duplicates: 0,
    blocked: 0, truncated, finalizedStoryIds: [],
  };
  for (const candidate of candidates.slice(0, limit)) {
    try {
      const packet = candidate.recovery_packet;
      if (!packet || packet.schemaVersion !== WAVE_INTEGRATED_PASS_RECOVERY_VERSION
        || candidate.recovery_packet_hash !== recoveryPacketHash(packet)) {
        throw new ConflictError('Integrated pass recovery packet is absent or has an invalid hash');
      }
      const storyResult = packet.storyResult as CanonicalStoryResultInput | undefined;
      const integrationFinalization = packet.integrationFinalization as StoryResultAtomicFinalizationOptions['integrationFinalization'];
      if (!storyResult || !integrationFinalization
        || Number(candidate.run_id) !== storyResult.runId
        || candidate.story_id !== storyResult.storyId
        || candidate.attempt !== integrationFinalization.attempt
        || candidate.resulting_head?.trim().toLowerCase() !== integrationFinalization.resultingHead.toLowerCase()
        || storyResult.commitSha?.toLowerCase() !== integrationFinalization.resultingHead.toLowerCase()
        || storyResult.integrated !== true || storyResult.status !== 'pass') {
        throw new ConflictError('Integrated pass recovery packet differs from locked ledger identity');
      }
      const outcome = await persistCanonicalStoryResultInternal(
        storyResult,
        EXECUTION_ENGINE_RESULT_AUTHORITY,
        { integrationFinalization },
        false,
      );
      result[outcome.duplicate ? 'duplicates' : 'finalized']++;
      result.finalizedStoryIds.push(candidate.story_id);
    } catch {
      result.blocked++;
    }
  }
  result.finalizedStoryIds.sort((left, right) => left.localeCompare(right));
  return result;
}

/**
 * Recognize any agent-writable journal result only as an exact reference to an
 * already immutable host result. This is read-only: pass/fail/skip/excluded
 * proposals can never create, replace, or promote terminal authority.
 */
export async function verifyReleasedHostResultProposal(
  input: CanonicalStoryResultInput,
): Promise<boolean> {
  // Read-only duplicate comparison validates the immutable host-shaped payload
  // but deliberately does not acquire engine write authority. The transaction
  // below has no INSERT/UPDATE path, so a production worker can only recognize
  // an already persisted exact row.
  validateInput(input, EXECUTION_ENGINE_RESULT_AUTHORITY, { requireWriteRole: false });
  if (!input.idempotencyKey) return false;
  return transaction(async (client) => {
    const projection = await loadRunProjection(client, input);
    const specId = path.basename(projection.spec_path, '.json');
    const commit = normalizedCommit(input, projection, specId, EXECUTION_ENGINE_RESULT_AUTHORITY);
    const accounting = await deriveAccounting(client, input, projection.workspace_id);
    const existing = rows(await client.query<StoryResultIdentityRow>(`
      SELECT ${resultIdentitySelect()}
        FROM story_results
       WHERE ingest_key = $1
       FOR SHARE
    `, [input.idempotencyKey]))[0];
    if (!existing) return false;
    assertSameResultPayload(
      existing, input, projection, specId, commit, accounting, EXECUTION_ENGINE_RESULT_AUTHORITY,
    );
    if (commit) assertSameCommit(await loadCommit(client, commit), commit);
    assertSameAccounting(
      await loadAccounting(client, existing.id), existing.id, projection.workspace_id, accounting,
    );
    if (input.status !== 'pass') return true;
    if (!commit) return false;
    const outboxes = rows(await client.query<TrustedWalRow>(`
      SELECT * FROM wal_events
       WHERE trust_provenance = 'host' AND trusted_source = 'story-result'
         AND story_result_id = $1
       FOR SHARE
    `, [existing.id]));
    if (outboxes.length !== 1 || !outboxes[0].outbox_ready_at) return false;
    const outbox = outboxes[0];
    const expectedPayload = {
      ...input.trustedPassOutbox?.payload,
      run_id: input.runId,
      story_id: input.storyId,
      story_result_id: existing.id,
      commit_sha: commit.commitSha,
      closeout_decision_id: projection.closeout_decision_id,
    };
    // Compare the complete canonical WAL identity, not a selected subset. This
    // includes checkpoint attestation id/digest/passed-at/expiry and every
    // future stable payload field supplied by the host result finalizer.
    assertExactTrustedWalRow(outbox, {
      id: outbox.id,
      ingestKey: outbox.ingest_key,
      identityHash: outbox.event_identity_hash,
      eventType: 'story_passed',
      workspaceId: projection.workspace_id,
      runId: input.runId,
      specId,
      storyId: input.storyId,
      source: 'story-result',
      storyResultId: existing.id,
      payload: expectedPayload,
    });
    return true;
  });
}

/**
 * Compatibility writer for the post-hoc token endpoint and legacy WAL events.
 * Canonical ingest-keyed results are immutable and rejected. Legacy rows are
 * locked, updated, and bound to one keyed accounting row in one transaction.
 */
export async function persistLegacyStoryResultAccounting(
  input: LegacyStoryAccountingInput,
): Promise<{ storyResultId: number; duplicate: boolean }> {
  if (!Number.isSafeInteger(input.runId) || input.runId <= 0
    || typeof input.storyId !== 'string' || !input.storyId) {
    throw new ValidationError('runId and storyId are required');
  }
  for (const [name, value] of [
    ['inputTokens', input.inputTokens],
    ['outputTokens', input.outputTokens],
    ['reasoningTokens', input.reasoningTokens],
    ['costUsd', input.costUsd],
  ] as const) assertNonNegativeFinite(name, value);
  for (const [name, value] of [
    ['inputTokens', input.inputTokens],
    ['outputTokens', input.outputTokens],
    ['reasoningTokens', input.reasoningTokens],
  ] as const) {
    if (value !== undefined && !Number.isSafeInteger(value)) throw new ValidationError(`${name} must be an integer`);
  }
  if (input.modelUsed !== undefined && typeof input.modelUsed !== 'string') {
    throw new ValidationError('modelUsed must be a string');
  }
  if (!needsAccounting(input)) throw new ValidationError('At least one accounting value is required');

  return transaction(async (client) => {
    const result = rows(await client.query<StoryResultIdentityRow>(`
      SELECT ${resultIdentitySelect()}
      FROM story_results
      WHERE run_id = $1 AND story_id = $2
      ORDER BY id DESC
      LIMIT 1
      FOR UPDATE
    `, [input.runId, input.storyId]))[0];
    if (!result) throw new NotFoundError('Story result not found');
    if (result.ingest_key !== null) {
      throw new ConflictError('Canonical story-result accounting is immutable; replay the original keyed result');
    }

    const workspace = rows(await client.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM pipeline_runs WHERE id = $1',
      [input.runId],
    ))[0];
    if (!workspace) throw new NotFoundError('Pipeline run not found');
    const expected = await deriveAccounting(client, input, workspace.workspace_id);
    if (!expected) throw new ValidationError('At least one accounting value is required');
    const existing = await loadAccounting(client, result.id);
    if (existing.length > 0) {
      assertSameAccounting(existing, result.id, workspace.workspace_id, expected, true);
      return { storyResultId: result.id, duplicate: true };
    }

    await client.query(`
      UPDATE story_results
      SET input_tokens = $1, output_tokens = $2, reasoning_tokens = $3,
          model_used = $4, cost_usd = $5, accounting_required = TRUE,
          accounting_model = $6, accounting_input_tokens = $7,
          accounting_output_tokens = $8, accounting_reasoning_tokens = $9,
          accounting_cost_usd = $10, accounting_cost_source = $11,
          accounting_input_rate = $12, accounting_output_rate = $13
      WHERE id = $14
    `, [
      input.inputTokens ?? null,
      input.outputTokens ?? null,
      input.reasoningTokens ?? null,
      input.modelUsed ?? null,
      input.costUsd ?? null,
      expected.model,
      expected.input_tokens,
      expected.output_tokens,
      expected.reasoning_tokens,
      expected.cost_usd,
      expected.cost_source,
      expected.input_cost_per_1k,
      expected.output_cost_per_1k,
      result.id,
    ]);

    const usage = rows(await client.query<TokenUsageRow>(`
      INSERT INTO token_usage (
        story_result_id, run_id, story_id, workspace_id, model, input_tokens,
        output_tokens, reasoning_tokens, cost_usd, cost_source,
        input_cost_per_1k, output_cost_per_1k
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (story_result_id) WHERE story_result_id IS NOT NULL DO NOTHING
      RETURNING id, story_result_id, workspace_id, model, input_tokens,
                output_tokens, reasoning_tokens, cost_usd, cost_source,
                input_cost_per_1k, output_cost_per_1k
    `, [
      result.id,
      input.runId,
      input.storyId,
      expected.workspace_id,
      expected.model,
      expected.input_tokens,
      expected.output_tokens,
      expected.reasoning_tokens,
      expected.cost_usd,
      expected.cost_source,
      expected.input_cost_per_1k,
      expected.output_cost_per_1k,
    ]));
    const persisted = usage.length > 0 ? usage : await loadAccounting(client, result.id);
    assertSameAccounting(persisted, result.id, workspace.workspace_id, expected);
    return { storyResultId: result.id, duplicate: usage.length === 0 };
  });
}
