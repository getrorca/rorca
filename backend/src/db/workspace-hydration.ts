/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Workspace hydration status helpers — Context Intelligence Platform US-003.
 *
 * Records the status/provenance of each Hilo-backed hydration of a workspace: its lifecycle
 * status, the git SHA it ran against (freshness key), the rebuildable graph output location,
 * normalized counts, runtime, staleness, and structured errors.
 *
 * The table is append-per-attempt; "latest status" is the most recent row per workspace
 * (see `getLatestHydration`). The Hilo graph itself is rebuildable and is NOT durable truth —
 * this table only tracks hydration status so a stale graph is detectable and re-buildable
 * (docs/context-intelligence-platform.md §2.1 / §3 / §6).
 *
 * Consumers: US-006 (config/runner), US-009 (staleness), US-010 (hydration APIs), US-038
 * (observability). All access goes through the async DB helpers with numbered placeholders.
 */

import { execute, query, queryOne } from './index';
import type { JsonValue } from './spec-jobs';

/** Hydration provider. Only Hilo is in scope for this spec (adapter-free — §4). */
export type HydrationProvider = 'hilo';

/**
 * Hydration lifecycle status:
 * - `pending`   — queued/created, not yet started
 * - `running`   — Hilo hydration in flight
 * - `succeeded` — completed; graph output written and counts recorded
 * - `failed`    — hydration errored (see `errorJson`)
 * - `stale`     — a previously-succeeded hydration the SHA has since moved past (see `staleReason`)
 * - `cancelled` — superseded/coalesced or operator-cancelled before completion
 */
export type HydrationStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'stale'
  | 'cancelled';

export const HYDRATION_STATUSES: readonly HydrationStatus[] = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'stale',
  'cancelled',
] as const;

/** Terminal statuses — no further state transitions are expected. */
export const TERMINAL_HYDRATION_STATUSES: readonly HydrationStatus[] = [
  'succeeded',
  'failed',
  'stale',
  'cancelled',
] as const;

/**
 * Normalized hydration counts produced by graph normalization (US-008). Stored as JSONB so the
 * normalizer can evolve the shape without a migration; common keys are typed for convenience.
 */
export interface HydrationCounts {
  files?: number;
  nodes?: number;
  edges?: number;
  imports?: number;
  reverseImporters?: number;
  tests?: number;
  testedBy?: number;
  roles?: number;
  [key: string]: number | undefined;
}

export interface WorkspaceHydration {
  id: number;
  workspaceId: string;
  provider: HydrationProvider;
  status: HydrationStatus;
  gitSha: string | null;
  graphPath: string | null;
  counts: HydrationCounts;
  durationMs: number | null;
  staleReason: string | null;
  errorJson: JsonValue | null;
  metadata: JsonValue;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface WorkspaceHydrationRow {
  id: number | string;
  workspace_id: string;
  provider: HydrationProvider;
  status: HydrationStatus;
  git_sha: string | null;
  graph_path: string | null;
  counts_json: HydrationCounts | null;
  duration_ms: number | string | null;
  stale_reason: string | null;
  error_json: JsonValue | null;
  metadata_json: JsonValue | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface CreateHydrationInput {
  workspaceId: string;
  provider?: HydrationProvider;
  status?: HydrationStatus;
  gitSha?: string | null;
  graphPath?: string | null;
  counts?: HydrationCounts | null;
  durationMs?: number | null;
  staleReason?: string | null;
  errorJson?: JsonValue | null;
  metadata?: JsonValue | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
}

/** Partial update of an existing hydration row. Only provided fields are written. */
export interface UpdateHydrationInput {
  status?: HydrationStatus;
  gitSha?: string | null;
  graphPath?: string | null;
  counts?: HydrationCounts | null;
  durationMs?: number | null;
  staleReason?: string | null;
  errorJson?: JsonValue | null;
  metadata?: JsonValue | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
}

export interface ListHydrationsOptions {
  status?: HydrationStatus;
  limit?: number;
  offset?: number;
}

// Column list shared by every SELECT/RETURNING so reads and writes stay in sync.
const HYDRATION_COLUMNS = `
  id,
  workspace_id,
  provider,
  status,
  git_sha,
  graph_path,
  counts_json,
  duration_ms,
  stale_reason,
  error_json,
  metadata_json,
  started_at,
  finished_at,
  created_at,
  updated_at
`;

function asDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

function mapRow(row: WorkspaceHydrationRow): WorkspaceHydration {
  return {
    id: Number(row.id),
    workspaceId: row.workspace_id,
    provider: row.provider,
    status: row.status,
    gitSha: row.git_sha,
    graphPath: row.graph_path,
    counts: row.counts_json ?? {},
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    staleReason: row.stale_reason,
    errorJson: row.error_json,
    metadata: row.metadata_json ?? {},
    startedAt: asDate(row.started_at),
    finishedAt: asDate(row.finished_at),
    createdAt: asDate(row.created_at) ?? new Date(0),
    updatedAt: asDate(row.updated_at) ?? new Date(0),
  };
}

/**
 * Record a new hydration attempt for a workspace. Returns the inserted row.
 * JSONB columns are passed as objects — `pg` serializes them.
 */
export async function createHydration(input: CreateHydrationInput): Promise<WorkspaceHydration> {
  const row = await queryOne<WorkspaceHydrationRow>(
    `INSERT INTO workspace_hydration (
       workspace_id,
       provider,
       status,
       git_sha,
       graph_path,
       counts_json,
       duration_ms,
       stale_reason,
       error_json,
       metadata_json,
       started_at,
       finished_at
     ) VALUES (
       $1, $2, $3, $4, $5,
       COALESCE($6::jsonb, '{}'::jsonb),
       $7, $8, $9,
       COALESCE($10::jsonb, '{}'::jsonb),
       $11, $12
     )
     RETURNING ${HYDRATION_COLUMNS}`,
    [
      input.workspaceId,
      input.provider ?? 'hilo',
      input.status ?? 'pending',
      input.gitSha ?? null,
      input.graphPath ?? null,
      input.counts ?? null,
      input.durationMs ?? null,
      input.staleReason ?? null,
      input.errorJson ?? null,
      input.metadata ?? null,
      input.startedAt ?? null,
      input.finishedAt ?? null,
    ],
  );

  if (!row) {
    throw new Error('Failed to create workspace hydration record');
  }

  return mapRow(row);
}

/** Fetch a hydration row by id, or null. */
export async function getHydrationById(id: number): Promise<WorkspaceHydration | null> {
  const row = await queryOne<WorkspaceHydrationRow>(
    `SELECT ${HYDRATION_COLUMNS}
     FROM workspace_hydration
     WHERE id = $1`,
    [id],
  );
  return row ? mapRow(row) : null;
}

/**
 * Latest hydration row for a workspace ("current hydration state"). When `status` is provided,
 * returns the latest row with that status (e.g. the latest `succeeded` hydration for freshness).
 * Backed by idx_workspace_hydration_workspace_created / _workspace_status.
 */
export async function getLatestHydration(
  workspaceId: string,
  status?: HydrationStatus,
): Promise<WorkspaceHydration | null> {
  const row = await queryOne<WorkspaceHydrationRow>(
    `SELECT ${HYDRATION_COLUMNS}
     FROM workspace_hydration
     WHERE workspace_id = $1
       AND ($2::text IS NULL OR status = $2::text)
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [workspaceId, status ?? null],
  );
  return row ? mapRow(row) : null;
}

/**
 * List hydration history for a workspace, newest first. Optionally filter by status and page.
 * Backed by idx_workspace_hydration_workspace_created / _workspace_status.
 */
export async function listHydrations(
  workspaceId: string,
  options: ListHydrationsOptions = {},
): Promise<WorkspaceHydration[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
  const offset = Math.max(options.offset ?? 0, 0);
  const rows = await query<WorkspaceHydrationRow>(
    `SELECT ${HYDRATION_COLUMNS}
     FROM workspace_hydration
     WHERE workspace_id = $1
       AND ($2::text IS NULL OR status = $2::text)
     ORDER BY created_at DESC, id DESC
     LIMIT $3 OFFSET $4`,
    [workspaceId, options.status ?? null, limit, offset],
  );
  return rows.map(mapRow);
}

/**
 * Apply a partial update to a hydration row. Only the fields present in `input` are written;
 * `updated_at` is always refreshed. Returns the updated row, or null if the id no longer exists.
 *
 * Uses COALESCE($n, column) so a NULL/omitted field leaves the existing value untouched, except
 * for fields that are legitimately nullable (graph_path, stale_reason, error_json) where callers
 * may need to clear a value — those are set unconditionally when the key is present.
 */
export async function updateHydration(
  id: number,
  input: UpdateHydrationInput,
): Promise<WorkspaceHydration | null> {
  const sets: string[] = ['updated_at = NOW()'];
  const params: unknown[] = [];
  let n = 1;

  const push = (column: string, value: unknown, cast = ''): void => {
    sets.push(`${column} = $${n}${cast}`);
    params.push(value);
    n += 1;
  };

  if (input.status !== undefined) push('status', input.status);
  if (input.gitSha !== undefined) push('git_sha', input.gitSha);
  if (input.graphPath !== undefined) push('graph_path', input.graphPath);
  if (input.counts !== undefined) push('counts_json', input.counts, '::jsonb');
  if (input.durationMs !== undefined) push('duration_ms', input.durationMs);
  if (input.staleReason !== undefined) push('stale_reason', input.staleReason);
  if (input.errorJson !== undefined) push('error_json', input.errorJson, '::jsonb');
  if (input.metadata !== undefined) push('metadata_json', input.metadata, '::jsonb');
  if (input.startedAt !== undefined) push('started_at', input.startedAt);
  if (input.finishedAt !== undefined) push('finished_at', input.finishedAt);

  // id is the final positional parameter.
  params.push(id);

  const row = await queryOne<WorkspaceHydrationRow>(
    `UPDATE workspace_hydration
     SET ${sets.join(', ')}
     WHERE id = $${n}
     RETURNING ${HYDRATION_COLUMNS}`,
    params,
  );
  return row ? mapRow(row) : null;
}

/**
 * Mark the latest non-stale hydration for a workspace as stale (US-009 staleness detection).
 * Returns the updated row, or null if there is no hydration to mark. `reason` defaults to a
 * SHA-change marker since that is the canonical staleness trigger.
 */
export async function markLatestHydrationStale(
  workspaceId: string,
  reason = 'git_sha_changed',
): Promise<WorkspaceHydration | null> {
  const row = await queryOne<WorkspaceHydrationRow>(
    `UPDATE workspace_hydration
     SET status = 'stale', stale_reason = $2, updated_at = NOW()
     WHERE id = (
       SELECT id FROM workspace_hydration
       WHERE workspace_id = $1 AND status <> 'stale'
       ORDER BY created_at DESC, id DESC
       LIMIT 1
     )
     RETURNING ${HYDRATION_COLUMNS}`,
    [workspaceId, reason],
  );
  return row ? mapRow(row) : null;
}

/** Delete all hydration rows for a workspace. Returns the number of rows removed. */
export async function deleteHydrationsForWorkspace(workspaceId: string): Promise<number> {
  const { rowCount } = await execute(
    `DELETE FROM workspace_hydration WHERE workspace_id = $1`,
    [workspaceId],
  );
  return rowCount;
}
