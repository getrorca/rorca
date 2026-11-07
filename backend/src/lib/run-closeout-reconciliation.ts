/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Exact-run, owner-authorized, closeout-only recovery protocol. */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import {
  execute,
  query,
  queryOne,
  transaction,
  withPgAdvisoryLock,
} from '../db/index';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  UnprocessableError,
  ValidationError,
} from './errors';
import {
  ProviderHumanEventSchema,
  providerHumanActionHash,
  verifyAndPersistProviderHumanAuthority,
  type ProviderHumanEvent,
} from './provider-human-authority';
import { getPgBossSchemaSql } from './pg-boss-schema';
import { getBoss, initBoss } from './pg-boss';
import {
  PipelineCloseoutReconciliationJobPayload,
  type PipelineCloseoutReconciliationJobPayloadType,
} from './pg-boss-schemas';
import { retryHash } from './retry-governance';
import {
  assertExactRunLocalSpecLifecycleAuthority,
  inspectRunHostAuthority,
  type RunHostAuthority,
} from './run-host-authority';
import {
  insertPreparedHostRunCloseout,
  loadHostRunCloseoutReference,
  prepareHostRunCloseout,
  samePreparedHostCloseout,
} from './run-closeout-authority';
import {
  REQUIRED_CLOSEOUT_TIMESTAMP_FIX_SHA,
  resolveCloseoutReconciliationBuildIdentity,
  sameCloseoutReconciliationBuildIdentity,
  type CloseoutReconciliationBuildIdentity,
} from './closeout-reconciliation-build-identity';
export {
  REQUIRED_CLOSEOUT_TIMESTAMP_FIX_SHA,
  resolveCloseoutReconciliationBuildIdentity,
} from './closeout-reconciliation-build-identity';
import { assertRunSpecAuthorityProjection, deriveRunSpecPath } from './run-spec-snapshot';
import {
  assertNotProtectedWave1Run,
  assertWave1CanonicalTarget,
  assertWave1ReconciliationSelector,
  WAVE_1_MANAGED_PROOF_RUN_ID,
  WAVE_1_PROTECTED_GENESIS_RUN_ID,
  WAVE_1_SOURCE_REPOSITORY,
  WAVE_1_SPEC_CONTENT_HASH,
  WAVE_1_SPEC_PATH,
} from './wave-1-stabilization';
import {
  assertExactTrustedWalRow,
  stableWalJson,
  type TrustedWalRow,
} from './trusted-wal';

export const CLOSEOUT_RECONCILIATION_PREVIEW_VERSION = 'rorca.run-closeout-reconciliation-preview.v1' as const;
export const CLOSEOUT_RECONCILIATION_JOB_VERSION = 'rorca.run-closeout-reconciliation-job.v1' as const;
export const CLOSEOUT_RECONCILIATION_RESULT_VERSION = 'rorca.run-closeout-reconciliation-result.v1' as const;
export const CLOSEOUT_RECONCILIATION_QUEUE = 'pipeline:closeout-reconcile' as const;
const MAX_PREVIEW_STORIES = 500;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SHA1 = /^[0-9a-f]{40}$/;
const EXACT_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

export const closeoutReconciliationPreviewQuerySchema = z.object({
  workspaceId: z.string().trim().min(1).max(160),
}).strict();

export const closeoutReconciliationRequestSchema = z.object({
  workspaceId: z.string().trim().min(1).max(160),
  acceptedPreviewHash: z.string().regex(SHA256),
  rationale: z.string().trim().min(12).max(2000),
  ownerAuthorization: ProviderHumanEventSchema,
}).strict();

export const CloseoutReconciliationJobPayloadSchema = PipelineCloseoutReconciliationJobPayload;
export type CloseoutReconciliationJobPayload = PipelineCloseoutReconciliationJobPayloadType;

export function requireCloseoutReconciliationIdempotencyKey(value: unknown): string {
  const raw = typeof value === 'string' ? value : '';
  const key = raw.trim();
  if (raw !== key || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(key)) {
    throw new ValidationError('Idempotency-Key must be 8-200 bounded ASCII characters');
  }
  return key;
}

interface RunRow {
  id: number | string;
  workspace_id: string;
  spec_path: string;
  status: string;
  lifecycle_status: string;
  lifecycle_diagnostics: unknown;
  lifecycle_updated_at: Date | string | null;
  lifecycle_updated_at_exact: string | null;
  summary: string | null;
  started_at: Date | string;
  finished_at: Date | string | null;
  finished_at_exact: string | null;
  expected_story_ids: string[] | null;
  excluded_story_ids: string[] | null;
  branch_name: string | null;
  worktree_path: string | null;
  execution_workspace_path: string | null;
  execution_worktree_path: string | null;
  terminal_checkout_sha: string | null;
  terminal_checkout_attested_at: Date | string | null;
  host_closeout_event_id: number | string | null;
  merge_strategy: string | null;
  auto_merge: boolean;
  effective_options: unknown;
  dispatch_request_hash: string | null;
  dispatch_effective_options_hash: string | null;
  retried_from_run_id: number | string | null;
  pid: number | null;
  opencode_server_pid: number | null;
  worker_id: string | null;
  last_heartbeat: Date | string | null;
  dispatch_owner: string | null;
  dispatch_lease_expires_at: Date | string | null;
  worktree_cleanup_status: string;
  worktree_cleaned_at: Date | string | null;
  pr_number: number | null;
  merge_status: string | null;
  merge_commit_sha: string | null;
  workspace_path: string;
}

interface StoryEvidenceRow {
  id: number | string;
  story_id: string;
  status: string;
  reason: string | null;
  finished_at: Date | string | null;
  spec_id: string | null;
  integrated: boolean;
  commit_sha: string | null;
  commit_message: string | null;
  commit_author: string | null;
  commit_branch: string | null;
  commit_observed_source: string | null;
  worktree_path: string | null;
  closeout_decision_id: string | null;
  manifest_hash: string | null;
  closeout_status: string | null;
  closeout_manifest_hash: string | null;
  attestation_count: number | string;
  attestation_id: string | null;
  attestation_digest: string | null;
  attestation_passed_at: Date | string | null;
  attestation_expires_at: Date | string | null;
  attestation_revoked_at: Date | string | null;
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

interface ReleaseIntentRow {
  run_id: number | string;
  workspace_id: string;
  spec_id: string;
  authorized_sha: string;
  branch_name: string;
  execution_workspace_path: string;
  execution_worktree_path: string;
  repository_owner: string | null;
  repository_name: string | null;
  repository_authority_source: string | null;
  repository_binding_id: string | null;
  repository_installation_id: number | string | null;
  repository_id: number | string | null;
  merge_strategy: string;
  auto_merge: boolean;
  external_send: boolean;
  deployment_allowed: boolean;
  identity_hash: string;
  status: string;
  step_state: unknown;
  base_branch: string | null;
  base_sha: string | null;
  provider_release_ref: string | null;
  integration_checkout_path: string | null;
  merge_commit_sha: string | null;
  terminal_event_id: number | string | null;
  host_closeout_event_id: number | string | null;
  host_closeout_identity_hash: string | null;
  completed_at: Date | string | null;
}

interface ReconciliationRow {
  id: string;
  run_id: number | string;
  workspace_id: string;
  idempotency_key: string;
  request_hash: string;
  preview_hash: string;
  immutable_authority_hash: string;
  owner_receipt_id: string;
  requester_actor_id: string;
  rationale: string;
  required_fix_sha: string;
  build_sha: string;
  build_receipt_hash: string;
  preview_expires_at: Date | string;
  state: 'prepared' | 'queued' | 'processing' | 'completed' | 'blocked';
  boss_job_id: string;
  job_payload_hash: string;
  transport_generation: number;
  transport_history: unknown;
  reconciliation_event_id: string | null;
  before_projection: unknown;
  after_projection: unknown;
  attempt_count: number;
  result_receipt_hash: string | null;
  reconciled_at: Date | string | null;
  claim_token: string | null;
}

export interface CloseoutReconciliationPreview {
  schemaVersion: typeof CLOSEOUT_RECONCILIATION_PREVIEW_VERSION;
  eligible: true;
  target: {
    runId: number;
    workspaceId: string;
    specId: string;
    expiresAt: string;
    immutableAuthorityHash: string;
    immutableAuthority: Record<string, unknown>;
    originalProjection: Record<string, unknown>;
    ownership: Record<string, unknown>;
    existingOutputs: Record<string, unknown>;
  };
  canonicalTargetHash: string;
}

export interface SafeCloseoutReconciliationProjection {
  schemaVersion: 'rorca.run-closeout-reconciliation-public.v1';
  runId: number;
  workspaceId: string;
  state: 'eligible' | ReconciliationRow['state'];
  previewHash: string | null;
  immutableAuthorityHash: string | null;
  expiresAt: string | null;
  reconciliationEventId: string | null;
  reconciledAt: string | null;
  resultReceiptHash: string | null;
}

export interface CloseoutReconciliationRequestResult {
  reconciliationId: string;
  runId: number;
  workspaceId: string;
  state: ReconciliationRow['state'];
  previewHash: string;
  resultReceiptHash: string | null;
  reconciledAt: string | null;
  replayed: boolean;
}

export class CloseoutReconciliationBlockedError extends Error {
  constructor(readonly reasonCode: string, message: string) {
    super(message);
    this.name = 'CloseoutReconciliationBlockedError';
  }
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try { return jsonRecord(JSON.parse(value) as unknown); }
    catch { throw new ConflictError('Durable JSON authority is invalid'); }
  }
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new ConflictError('Durable JSON authority is not an object');
  }
  return value as Record<string, unknown>;
}

function iso(value: Date | string | null | undefined, label: string): string | null {
  if (value == null) return null;
  const millis = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(millis)) throw new ConflictError(`${label} is not an exact timestamp`);
  return new Date(millis).toISOString();
}

function exactProjectionTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !EXACT_UTC_TIMESTAMP.test(value)
    || !Number.isFinite(Date.parse(value))) {
    throw new CloseoutReconciliationBlockedError(
      'ORIGINAL_PROJECTION_INVALID',
      `${label} is not an exact UTC timestamp`,
    );
  }
  return value;
}

function storedProjectionTimestamp(
  exactValue: string | null | undefined,
  fallback: Date | string | null | undefined,
  label: string,
): string | null {
  if (exactValue != null) return exactProjectionTimestamp(exactValue, label);
  return iso(fallback, label);
}

interface ReconciliationProjectionSnapshot {
  status: string;
  lifecycleStatus: string;
  summary: string | null;
  lifecycleDiagnostics: Record<string, unknown>;
  lifecycleUpdatedAt: string | null;
  finishedAt: string;
}

interface ReconciliationProjectionProgress {
  hostCloseoutCount: number;
  releaseStatus: string | null;
  terminalEventCount: number;
}

function parseProjectionSnapshot(value: unknown, label: string): ReconciliationProjectionSnapshot {
  const projection = jsonRecord(value);
  const diagnostics = jsonRecord(projection.lifecycleDiagnostics);
  if (typeof projection.status !== 'string'
    || typeof projection.lifecycleStatus !== 'string'
    || !(typeof projection.summary === 'string' || projection.summary === null)
    || !(typeof projection.lifecycleUpdatedAt === 'string' || projection.lifecycleUpdatedAt === null)
    || typeof projection.finishedAt !== 'string') {
    throw new CloseoutReconciliationBlockedError(
      'ORIGINAL_PROJECTION_INVALID',
      `${label} closeout reconciliation projection is invalid`,
    );
  }
  const lifecycleUpdatedAt = projection.lifecycleUpdatedAt === null
    ? null : exactProjectionTimestamp(projection.lifecycleUpdatedAt, `${label} lifecycle_updated_at`);
  const finishedAt = exactProjectionTimestamp(projection.finishedAt, `${label} finished_at`);
  if (!finishedAt) {
    throw new CloseoutReconciliationBlockedError(
      'ORIGINAL_PROJECTION_INVALID',
      `${label} closeout reconciliation finished_at is absent`,
    );
  }
  return {
    status: projection.status,
    lifecycleStatus: projection.lifecycleStatus,
    summary: projection.summary,
    lifecycleDiagnostics: diagnostics,
    lifecycleUpdatedAt,
    finishedAt,
  };
}

/**
 * Every signed original field remains exact throughout partial closeout. Only
 * the status/lifecycle pair may follow the documented host-owned state machine.
 */
function assertProtocolOwnedProjectionProgress(
  acceptedValue: unknown,
  currentValue: unknown,
  progress: ReconciliationProjectionProgress,
): void {
  const accepted = parseProjectionSnapshot(acceptedValue, 'Accepted');
  const current = parseProjectionSnapshot(currentValue, 'Current');
  if (accepted.status !== 'failed' || accepted.lifecycleStatus !== 'failed'
    || accepted.summary !== 'worker_closeout_failed') {
    throw new CloseoutReconciliationBlockedError(
      'ORIGINAL_PROJECTION_INVALID',
      'Accepted projection is not the exact false-failed worker closeout state',
    );
  }
  if (current.finishedAt !== accepted.finishedAt) {
    throw new CloseoutReconciliationBlockedError(
      'ORIGINAL_FINISHED_AT_DRIFT',
      'Original run finished_at changed after owner authorization',
    );
  }
  if (retryHash(current.lifecycleDiagnostics) !== retryHash(accepted.lifecycleDiagnostics)) {
    throw new CloseoutReconciliationBlockedError(
      'ORIGINAL_DIAGNOSTICS_DRIFT',
      'Original lifecycle diagnostics changed after owner authorization',
    );
  }
  if (current.lifecycleUpdatedAt !== accepted.lifecycleUpdatedAt) {
    throw new CloseoutReconciliationBlockedError(
      'ORIGINAL_LIFECYCLE_TIMESTAMP_DRIFT',
      'Original lifecycle_updated_at changed after owner authorization',
    );
  }
  if (current.summary !== accepted.summary) {
    throw new CloseoutReconciliationBlockedError(
      'ORIGINAL_SUMMARY_DRIFT',
      'Original run summary changed after owner authorization',
    );
  }

  let exactStatus = 'failed';
  let exactLifecycle = 'failed';
  if (progress.releaseStatus !== null) {
    if (!['pending', 'processing', 'completed'].includes(progress.releaseStatus)) {
      throw new CloseoutReconciliationBlockedError(
        'RELEASE_PROGRESS_INVALID',
        'Release intent status is outside documented reconciliation progression',
      );
    }
    if (current.status === 'release_pending' && current.lifecycleStatus === 'failed') {
      exactStatus = 'release_pending';
    } else if (current.status === 'done' && current.lifecycleStatus === 'finished'
      && progress.terminalEventCount === 1) {
      exactStatus = 'done';
      exactLifecycle = 'finished';
    } else {
      throw new CloseoutReconciliationBlockedError(
        'PUBLIC_PROJECTION_DRIFT',
        'Run status/lifecycle differs from documented reconciliation progression',
      );
    }
    if (progress.releaseStatus === 'completed' && exactStatus !== 'done') {
      throw new CloseoutReconciliationBlockedError(
        'RELEASE_PROGRESS_INVALID',
        'Completed release intent lacks exact public terminal projection',
      );
    }
  } else if (progress.terminalEventCount !== 0) {
    throw new CloseoutReconciliationBlockedError(
      'TERMINAL_EVENT_DRIFT',
      'Terminal event exists without protocol-owned release authority',
    );
  }
  if (progress.hostCloseoutCount === 0 && progress.releaseStatus !== null) {
    throw new CloseoutReconciliationBlockedError(
      'PARTIAL_AUTHORITY_INVALID',
      'Release progression exists without exact host closeout authority',
    );
  }
  if (current.status !== exactStatus || current.lifecycleStatus !== exactLifecycle) {
    throw new CloseoutReconciliationBlockedError(
      'ORIGINAL_PROJECTION_DRIFT',
      'Run status/lifecycle changed outside protocol-owned progression',
    );
  }
}

export function assertCloseoutReconciliationProjectionProgressForTests(input: {
  accepted: Record<string, unknown>;
  current: Record<string, unknown>;
  progress: ReconciliationProjectionProgress;
}): void {
  assertProtocolOwnedProjectionProgress(input.accepted, input.current, input.progress);
}

function nullableNumber(value: number | string | null): number | null {
  if (value == null) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new ConflictError('Accounting evidence contains a non-finite number');
  return number;
}

function processAlive(pid: number | null | undefined): boolean {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 15_000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

function normalizedRepositoryRemote(value: string): string {
  let remote = value.trim();
  const scp = remote.match(/^git@([^:]+):(.+)$/i);
  if (scp) remote = `https://${scp[1]}/${scp[2]}`;
  remote = remote.replace(/^git\+/, '');
  let parsed: URL;
  try { parsed = new URL(remote); }
  catch { throw new ConflictError('Canonical repository remote is not a normalized provider identity'); }
  const host = parsed.hostname.toLowerCase();
  const pathname = decodeURIComponent(parsed.pathname).replace(/\/+$/, '').replace(/\.git$/i, '');
  if (!host || !pathname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ConflictError('Canonical repository remote contains ambiguous identity components');
  }
  return `https://${host}${pathname}.git`;
}

function exactSha256(bytes: Buffer): string {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

async function loadRun(runId: number, workspaceId: string): Promise<RunRow> {
  const row = await queryOne<RunRow>(`
    SELECT run.id, run.workspace_id, run.spec_path, run.status, run.lifecycle_status,
           run.lifecycle_diagnostics, run.lifecycle_updated_at,
           to_char(run.lifecycle_updated_at AT TIME ZONE 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS lifecycle_updated_at_exact,
           run.summary, run.started_at, run.finished_at,
           to_char(run.finished_at AT TIME ZONE 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS finished_at_exact,
           run.expected_story_ids,
           COALESCE(run.excluded_story_ids, '{}'::text[]) AS excluded_story_ids,
           run.branch_name, run.worktree_path, run.execution_workspace_path,
           run.execution_worktree_path, run.terminal_checkout_sha,
           run.terminal_checkout_attested_at, run.host_closeout_event_id,
           run.merge_strategy, run.auto_merge, run.effective_options,
           run.dispatch_request_hash, run.dispatch_effective_options_hash,
           run.retried_from_run_id, run.pid, run.opencode_server_pid,
           run.worker_id, run.last_heartbeat, run.dispatch_owner,
           run.dispatch_lease_expires_at, run.worktree_cleanup_status,
           run.worktree_cleaned_at, run.pr_number, run.merge_status,
           run.merge_commit_sha, workspace.path AS workspace_path
      FROM pipeline_runs run
      JOIN workspaces workspace ON workspace.id = run.workspace_id
     WHERE run.id = $1 AND run.workspace_id = $2
  `, [runId, workspaceId]);
  if (!row) throw new NotFoundError('Pipeline run', String(runId));
  return row;
}

async function loadStoryEvidence(runId: number, storyIds: readonly string[]): Promise<StoryEvidenceRow[]> {
  if (storyIds.length === 0) return [];
  return query<StoryEvidenceRow>(`
    SELECT DISTINCT ON (result.story_id)
           result.id, result.story_id, result.status, result.reason,
           result.finished_at, result.spec_id, result.integrated,
           result.commit_sha, result.commit_message, result.commit_author,
           result.commit_branch, result.commit_observed_source, result.worktree_path,
           result.closeout_decision_id, result.manifest_hash,
           result.accounting_required, result.accounting_model,
           result.accounting_input_tokens, result.accounting_output_tokens,
           result.accounting_reasoning_tokens, result.accounting_cost_usd,
           result.accounting_cost_source, result.accounting_input_rate,
           result.accounting_output_rate, result.result_provenance, result.result_source,
           decision.status AS closeout_status,
           decision.manifest_hash AS closeout_manifest_hash,
           usage.model AS projected_accounting_model,
           usage.input_tokens AS projected_accounting_input_tokens,
           usage.output_tokens AS projected_accounting_output_tokens,
           usage.reasoning_tokens AS projected_accounting_reasoning_tokens,
           usage.cost_usd AS projected_accounting_cost_usd,
           usage.cost_source AS projected_accounting_cost_source,
           usage.input_cost_per_1k AS projected_accounting_input_rate,
           usage.output_cost_per_1k AS projected_accounting_output_rate,
           (SELECT COUNT(*) FROM token_usage exact_usage
             WHERE exact_usage.story_result_id = result.id) AS accounting_count,
           (SELECT COUNT(*) FROM checkpoint_validation_attestations attestation
             WHERE attestation.workspace_id = run.workspace_id
               AND attestation.run_id = result.run_id
               AND attestation.story_id = result.story_id
               AND attestation.branch_name = result.commit_branch
               AND attestation.checkpoint_sha = result.commit_sha
               AND attestation.validation_gate = 'execution-engine') AS attestation_count,
           (SELECT MIN(attestation.id::text) FROM checkpoint_validation_attestations attestation
             WHERE attestation.workspace_id = run.workspace_id
               AND attestation.run_id = result.run_id
               AND attestation.story_id = result.story_id
               AND attestation.branch_name = result.commit_branch
               AND attestation.checkpoint_sha = result.commit_sha
               AND attestation.validation_gate = 'execution-engine') AS attestation_id,
           (SELECT MIN(attestation.evidence_digest) FROM checkpoint_validation_attestations attestation
             WHERE attestation.workspace_id = run.workspace_id
               AND attestation.run_id = result.run_id
               AND attestation.story_id = result.story_id
               AND attestation.branch_name = result.commit_branch
               AND attestation.checkpoint_sha = result.commit_sha
               AND attestation.validation_gate = 'execution-engine') AS attestation_digest,
           (SELECT MIN(attestation.passed_at) FROM checkpoint_validation_attestations attestation
             WHERE attestation.workspace_id = run.workspace_id
               AND attestation.run_id = result.run_id
               AND attestation.story_id = result.story_id
               AND attestation.branch_name = result.commit_branch
               AND attestation.checkpoint_sha = result.commit_sha
               AND attestation.validation_gate = 'execution-engine') AS attestation_passed_at,
           (SELECT MIN(attestation.expires_at) FROM checkpoint_validation_attestations attestation
             WHERE attestation.workspace_id = run.workspace_id
               AND attestation.run_id = result.run_id
               AND attestation.story_id = result.story_id
               AND attestation.branch_name = result.commit_branch
               AND attestation.checkpoint_sha = result.commit_sha
               AND attestation.validation_gate = 'execution-engine') AS attestation_expires_at,
           (SELECT MAX(attestation.revoked_at) FROM checkpoint_validation_attestations attestation
             WHERE attestation.workspace_id = run.workspace_id
               AND attestation.run_id = result.run_id
               AND attestation.story_id = result.story_id
               AND attestation.branch_name = result.commit_branch
               AND attestation.checkpoint_sha = result.commit_sha
               AND attestation.validation_gate = 'execution-engine') AS attestation_revoked_at
      FROM story_results result
      JOIN pipeline_runs run ON run.id = result.run_id
      LEFT JOIN story_closeout_decisions decision
        ON decision.decision_id = result.closeout_decision_id
       AND decision.workspace_id = run.workspace_id
       AND decision.run_id = result.run_id
       AND decision.story_id = result.story_id
       AND decision.manifest_hash = result.manifest_hash
      LEFT JOIN token_usage usage ON usage.story_result_id = result.id
     WHERE result.run_id = $1
       AND result.story_id = ANY($2::text[])
       AND result.result_provenance = 'host'
       AND result.result_source IN ('execution-engine','worker')
     ORDER BY result.story_id, result.id DESC
  `, [runId, [...storyIds]]);
}

async function exactStoryEvidence(
  run: RunRow,
  authority: RunHostAuthority,
  databaseNowMs: number,
): Promise<Array<Record<string, unknown>>> {
  const rows = await loadStoryEvidence(authority.runId, authority.expectedStoryIds);
  const byStory = new Map(rows.map((row) => [row.story_id, row]));
  if (rows.length !== authority.expectedStoryIds.length) {
    throw new ConflictError('Exact governing story evidence is incomplete');
  }
  const resultIds = rows.map((row) => Number(row.id));
  const outboxes = await query<TrustedWalRow>(`
    SELECT * FROM wal_events
     WHERE trust_provenance = 'host'
       AND trusted_source = 'story-result'
       AND event_type = 'story_passed'
       AND story_result_id = ANY($1::int[])
     ORDER BY id ASC
  `, [resultIds]);
  const byResult = new Map<number, TrustedWalRow[]>();
  for (const outbox of outboxes) {
    assertExactTrustedWalRow(outbox);
    const resultId = Number(outbox.story_result_id);
    const group = byResult.get(resultId) ?? [];
    group.push(outbox);
    byResult.set(resultId, group);
  }

  return authority.expectedStoryIds.map((storyId) => {
    const row = byStory.get(storyId);
    const hostStory = authority.stories.find((story) => story.storyId === storyId);
    if (!row || !hostStory || hostStory.resultId !== Number(row.id)
      || row.status !== 'pass' || row.attestation_revoked_at !== null
      || Number(row.attestation_count) !== 1 || Number(row.accounting_count) > 1) {
      throw new ConflictError(`Governing authority changed for story ${storyId}`);
    }
    const exactOutboxes = byResult.get(Number(row.id)) ?? [];
    if (exactOutboxes.length !== 1 || !exactOutboxes[0].outbox_ready_at) {
      throw new ConflictError(`Story ${storyId} lacks one exact released host outbox`);
    }
    const outbox = exactOutboxes[0];
    const passedAt = iso(row.attestation_passed_at, 'attestation passed_at');
    const expiresAt = iso(row.attestation_expires_at, 'attestation expires_at');
    if (!passedAt || !expiresAt || Date.parse(expiresAt) <= databaseNowMs) {
      throw new UnprocessableError(`Story ${storyId} host attestation is expired or incomplete`, 'CLOSEOUT_EVIDENCE_EXPIRED');
    }
    return {
      storyId,
      result: {
        id: Number(row.id), status: row.status, reason: row.reason,
        finishedAt: iso(row.finished_at, 'story finished_at'),
        provenance: row.result_provenance, source: row.result_source,
      },
      commit: {
        sha: row.commit_sha?.toLowerCase() ?? null,
        message: row.commit_message,
        author: row.commit_author,
        branch: row.commit_branch,
        observedSource: row.commit_observed_source,
        worktreePath: row.worktree_path,
      },
      closeout: {
        decisionId: row.closeout_decision_id,
        manifestHash: row.manifest_hash,
        status: row.closeout_status,
        projectedManifestHash: row.closeout_manifest_hash,
      },
      attestation: {
        id: row.attestation_id,
        digest: row.attestation_digest,
        passedAt,
        expiresAt,
        revokedAt: null,
      },
      accounting: {
        required: row.accounting_required,
        source: {
          model: row.accounting_model,
          inputTokens: nullableNumber(row.accounting_input_tokens),
          outputTokens: nullableNumber(row.accounting_output_tokens),
          reasoningTokens: nullableNumber(row.accounting_reasoning_tokens),
          costUsd: nullableNumber(row.accounting_cost_usd),
          costSource: row.accounting_cost_source,
          inputRate: nullableNumber(row.accounting_input_rate),
          outputRate: nullableNumber(row.accounting_output_rate),
        },
        projection: {
          model: row.projected_accounting_model,
          inputTokens: nullableNumber(row.projected_accounting_input_tokens),
          outputTokens: nullableNumber(row.projected_accounting_output_tokens),
          reasoningTokens: nullableNumber(row.projected_accounting_reasoning_tokens),
          costUsd: nullableNumber(row.projected_accounting_cost_usd),
          costSource: row.projected_accounting_cost_source,
          inputRate: nullableNumber(row.projected_accounting_input_rate),
          outputRate: nullableNumber(row.projected_accounting_output_rate),
        },
      },
      storyPassWal: {
        id: Number(outbox.id),
        identityHash: outbox.event_identity_hash,
        ingestKey: outbox.ingest_key,
        payloadHash: retryHash(typeof outbox.payload === 'string'
          ? JSON.parse(outbox.payload) as unknown : outbox.payload),
        readyAt: iso(outbox.outbox_ready_at, 'story outbox ready_at'),
      },
    };
  });
}

function frozenPosture(run: RunRow): Record<string, unknown> {
  const options = jsonRecord(run.effective_options);
  const merge = jsonRecord(options.merge);
  const safety = jsonRecord(options.safety);
  const worktree = jsonRecord(options.worktree);
  if (run.merge_strategy !== 'branch-only' || run.auto_merge !== false
    || merge.strategy !== 'branch-only' || merge.autoMerge !== false
    || safety.externalSend !== false || safety.deploy !== false
    || worktree.enabled !== true || worktree.branch !== run.branch_name
    || worktree.path !== run.worktree_path) {
    throw new ConflictError('Run does not have one exact frozen branch-only/no-send/no-deploy posture');
  }
  const calculated = retryHash(options);
  if (!SHA256.test(run.dispatch_request_hash ?? '')
    || !SHA256.test(run.dispatch_effective_options_hash ?? '')
    || run.dispatch_effective_options_hash !== calculated) {
    throw new ConflictError('Run dispatch hashes do not bind its exact effective options');
  }
  return {
    mergeStrategy: 'branch-only', autoMerge: false, externalSend: false,
    deploy: false, effectiveOptions: options,
    dispatchRequestHash: run.dispatch_request_hash,
    dispatchEffectiveOptionsHash: run.dispatch_effective_options_hash,
  };
}

async function processEvidence(run: RunRow): Promise<Record<string, unknown>> {
  const rows = await query<{
    id: number | string; ts: Date | string; trust_provenance: string;
    event_identity_hash: string | null; payload: unknown;
  }>(`
    SELECT id, ts, trust_provenance, event_identity_hash, payload
      FROM wal_events
     WHERE event_type = 'run_process_finished'
       AND workspace_id = $2
       AND payload->>'run_id' = $1::text
     ORDER BY id ASC
  `, [Number(run.id), run.workspace_id]);
  if (rows.length !== 1) throw new ConflictError('Run must have exactly one process-finished transport observation');
  const row = rows[0];
  const payload = jsonRecord(row.payload);
  if (row.trust_provenance !== 'untrusted' || row.event_identity_hash !== null
    || payload.run_id !== Number(run.id) || payload.status !== 'failed'
    || payload.exit_code !== 0 || payload.exit_signal !== null
    || payload.source !== 'worker') {
    throw new ConflictError('Process-finished evidence is not the exact false-failed exit-zero observation');
  }
  return {
    id: Number(row.id), observedAt: iso(row.ts, 'process evidence timestamp'),
    trustProvenance: row.trust_provenance, exitCode: 0, exitSignal: null,
    observedStatus: 'failed', payloadHash: retryHash(payload),
  };
}

async function dispatchPublication(run: RunRow): Promise<Record<string, unknown>> {
  const row = await queryOne<{
    state: string; boss_job_id: string; request_hash: string | null;
    effective_options_hash: string | null; payload_hash: string | null;
    lease_owner: string | null; lease_expires_at: Date | string | null;
    completed_at: Date | string | null;
  }>(`
    SELECT state, boss_job_id::text, request_hash, effective_options_hash,
           payload_hash, lease_owner, lease_expires_at, completed_at
      FROM pipeline_dispatch_publications
     WHERE run_id = $1 AND workspace_id = $2
  `, [Number(run.id), run.workspace_id]);
  if (!row || !['completed', 'cancelled', 'failed'].includes(row.state)
    || row.lease_owner !== null || row.lease_expires_at !== null
    || row.request_hash !== run.dispatch_request_hash
    || row.effective_options_hash !== run.dispatch_effective_options_hash
    || !SHA256.test(row.payload_hash ?? '')) {
    throw new ConflictError('Original dispatch does not have terminal application-owned transport authority');
  }
  return {
    state: row.state, bossJobId: row.boss_job_id,
    requestHash: row.request_hash, effectiveOptionsHash: row.effective_options_hash,
    payloadHash: row.payload_hash, completedAt: iso(row.completed_at, 'dispatch completed_at'),
  };
}

async function ownershipSnapshot(
  run: RunRow,
  databaseNowMs: number,
  ownBossJobId?: string,
): Promise<Record<string, unknown>> {
  const pty = await query<{
    id: number | string; status: string; child_pid: number | null;
    exit_code: number | null; exit_signal: string | null; exited_at: Date | string | null;
  }>(`
    SELECT run_id AS id, status, child_pid, exit_code, exit_signal, exited_at
      FROM run_pty_sessions WHERE run_id = $1 ORDER BY updated_at DESC
  `, [Number(run.id)]);
  const activePtyGenerations = await queryOne<{ count: number | string }>(
    `SELECT COUNT(*) AS count FROM pty_generations WHERE run_id = $1 AND is_active = TRUE`,
    [Number(run.id)],
  );
  const schema = getPgBossSchemaSql();
  const jobs = await query<{ id: string; name: string; state: string }>(`
    SELECT id::text, name, state
      FROM ${schema}.job
     WHERE name IN ('pipeline:run','pipeline:run:direct','pipeline:retry','pipeline:cancel','pipeline:merge','${CLOSEOUT_RECONCILIATION_QUEUE}')
       AND state IN ('created','retry','active')
       AND data->>'runId' = $1::text
       AND ($2::uuid IS NULL OR id <> $2::uuid)
     ORDER BY name, id
  `, [Number(run.id), ownBossJobId ?? null]);
  const cancellation = await queryOne<{ count: number | string }>(
    'SELECT COUNT(*) AS count FROM pipeline_run_cancellation_requests WHERE run_id = $1',
    [Number(run.id)],
  );
  const retries = await queryOne<{
    dispatch_count: number | string; child_count: number | string;
  }>(`
    SELECT
      (SELECT COUNT(*) FROM governed_retry_dispatches
        WHERE original_run_id = $1 OR retry_run_id = $1) AS dispatch_count,
      (SELECT COUNT(*) FROM pipeline_runs WHERE retried_from_run_id = $1) AS child_count
  `, [Number(run.id)]);

  const engineAlive = processAlive(run.pid);
  const opencodeAlive = processAlive(run.opencode_server_pid);
  const dispatchLeaseExpiry = iso(run.dispatch_lease_expires_at, 'dispatch lease expiry');
  const dispatchLeaseActive = dispatchLeaseExpiry !== null && Date.parse(dispatchLeaseExpiry) > databaseNowMs;
  const ptyRows = pty.map((row) => ({
    id: Number(row.id), status: row.status, childPid: row.child_pid,
    childAlive: processAlive(row.child_pid), exitCode: row.exit_code,
    exitSignal: row.exit_signal, exitedAt: iso(row.exited_at, 'PTY exited_at'),
  }));
  if (engineAlive || opencodeAlive || dispatchLeaseActive || jobs.length > 0
    || ptyRows.some((row) => ['starting', 'active'].includes(row.status) || row.childAlive)
    || Number(activePtyGenerations?.count ?? 0) !== 0
    || Number(cancellation?.count ?? 0) !== 0
    || Number(retries?.dispatch_count ?? 0) !== 0
    || Number(retries?.child_count ?? 0) !== 0
    || run.retried_from_run_id !== null) {
    throw new ConflictError('Run still has execution, PTY, job, cancellation, or retry ownership');
  }
  return {
    engine: { pid: run.pid, alive: false },
    opencodeServer: { pid: run.opencode_server_pid, alive: false },
    worker: {
      workerId: run.worker_id,
      lastHeartbeat: iso(run.last_heartbeat, 'worker heartbeat'),
      dispatchOwner: run.dispatch_owner,
      dispatchLeaseExpiresAt: dispatchLeaseExpiry,
      dispatchLeaseActive: false,
    },
    ptySessions: ptyRows,
    activePtyGenerationCount: 0,
    activeJobs: [],
    cancellationRequestCount: 0,
    governedRetryDispatchCount: 0,
    retryChildCount: 0,
  };
}

async function outputSnapshot(run: RunRow): Promise<Record<string, unknown>> {
  const release = await queryOne<ReleaseIntentRow>(
    'SELECT * FROM pipeline_run_release_intents WHERE run_id = $1', [Number(run.id)],
  );
  const hostCloseouts = await query<TrustedWalRow>(`
    SELECT * FROM wal_events
     WHERE canonical_run_id = $1 AND workspace_id = $2
       AND trust_provenance = 'host' AND trusted_source = 'worker'
       AND event_type = 'run_closeout'
     ORDER BY id ASC
  `, [Number(run.id), run.workspace_id]);
  const terminals = await query<TrustedWalRow>(`
    SELECT * FROM wal_events
     WHERE canonical_run_id = $1 AND workspace_id = $2
       AND trust_provenance = 'host' AND trusted_source = 'worker'
       AND event_type = 'run_finished'
     ORDER BY id ASC
  `, [Number(run.id), run.workspace_id]);
  for (const event of [...hostCloseouts, ...terminals]) assertExactTrustedWalRow(event);
  const checkProjection = await queryOne<{ count: number | string }>(
    'SELECT COUNT(*) AS count FROM github_check_run_projections WHERE run_id = $1', [Number(run.id)],
  );
  return {
    terminalCheckout: {
      sha: run.terminal_checkout_sha?.toLowerCase() ?? null,
      attestedAt: iso(run.terminal_checkout_attested_at, 'terminal checkout attested_at'),
    },
    hostCloseoutPointer: run.host_closeout_event_id == null ? null : Number(run.host_closeout_event_id),
    hostCloseouts: hostCloseouts.map((row) => ({
      id: Number(row.id), identityHash: row.event_identity_hash,
      readyAt: iso(row.outbox_ready_at, 'host closeout ready_at'),
      payloadHash: retryHash(typeof row.payload === 'string' ? JSON.parse(row.payload) as unknown : row.payload),
    })),
    releaseIntent: release ? normalizeReleaseIntent(release) : null,
    terminalEvents: terminals.map((row) => ({
      id: Number(row.id), identityHash: row.event_identity_hash,
      readyAt: iso(row.outbox_ready_at, 'terminal ready_at'),
      relayedAt: iso(row.outbox_relayed_at, 'terminal relayed_at'),
      payloadHash: retryHash(typeof row.payload === 'string' ? JSON.parse(row.payload) as unknown : row.payload),
    })),
    githubCheckProjectionCount: Number(checkProjection?.count ?? 0),
    providerAndIntegration: {
      prNumber: run.pr_number,
      mergeStatus: run.merge_status,
      mergeCommitSha: run.merge_commit_sha,
      worktreeCleanupStatus: run.worktree_cleanup_status,
      worktreeCleanedAt: iso(run.worktree_cleaned_at, 'worktree cleaned_at'),
    },
  };
}

function normalizeReleaseIntent(row: ReleaseIntentRow): Record<string, unknown> {
  return {
    runId: Number(row.run_id), workspaceId: row.workspace_id, specId: row.spec_id,
    authorizedSha: row.authorized_sha.toLowerCase(), branchName: row.branch_name,
    executionWorkspacePath: row.execution_workspace_path,
    executionWorktreePath: row.execution_worktree_path,
    repository: row.repository_owner === null && row.repository_name === null
      && row.repository_authority_source === null && row.repository_binding_id === null
      && row.repository_installation_id === null && row.repository_id === null
      ? null
      : {
        owner: row.repository_owner, name: row.repository_name,
        source: row.repository_authority_source, bindingId: row.repository_binding_id,
        installationId: row.repository_installation_id == null ? null : Number(row.repository_installation_id),
        repositoryId: row.repository_id == null ? null : Number(row.repository_id),
      },
    mergeStrategy: row.merge_strategy, autoMerge: row.auto_merge,
    externalSend: row.external_send, deploymentAllowed: row.deployment_allowed,
    identityHash: row.identity_hash, status: row.status,
    stepState: jsonRecord(row.step_state),
    baseBranch: row.base_branch, baseSha: row.base_sha?.toLowerCase() ?? null,
    providerReleaseRef: row.provider_release_ref,
    integrationCheckoutPath: row.integration_checkout_path,
    mergeCommitSha: row.merge_commit_sha,
    terminalEventId: row.terminal_event_id == null ? null : Number(row.terminal_event_id),
    hostCloseoutEventId: row.host_closeout_event_id == null ? null : Number(row.host_closeout_event_id),
    hostCloseoutIdentityHash: row.host_closeout_identity_hash,
    completedAt: iso(row.completed_at, 'release completed_at'),
  };
}

function assertInitialProjection(run: RunRow, outputs: Record<string, unknown>): void {
  if (run.status !== 'failed' || run.lifecycle_status !== 'failed'
    || run.summary !== 'worker_closeout_failed' || !run.finished_at) {
    throw new ConflictError('Run is not the exact failed worker-closeout projection eligible for correction');
  }
  if (run.host_closeout_event_id !== null || run.terminal_checkout_sha !== null
    || run.terminal_checkout_attested_at !== null) {
    throw new ConflictError('Run already has terminal or host-closeout authority');
  }
  const hostCloseouts = outputs.hostCloseouts as unknown[];
  const terminalEvents = outputs.terminalEvents as unknown[];
  if (outputs.releaseIntent !== null || hostCloseouts.length !== 0 || terminalEvents.length !== 0
    || outputs.githubCheckProjectionCount !== 0) {
    throw new ConflictError('Run already has release, terminal, or provider projection authority');
  }
  const effects = outputs.providerAndIntegration as Record<string, unknown>;
  if (effects.prNumber !== null || effects.mergeStatus !== null || effects.mergeCommitSha !== null
    || effects.worktreeCleanupStatus !== 'not_started' || effects.worktreeCleanedAt !== null) {
    throw new ConflictError('Run has incompatible provider, merge, or cleanup effects');
  }
}

async function observeAuthority(input: {
  runId: number;
  workspaceId: string;
  ownBossJobId?: string;
}): Promise<{
  run: RunRow;
  hostAuthority: RunHostAuthority;
  immutableAuthority: Record<string, unknown>;
  originalProjection: Record<string, unknown>;
  ownership: Record<string, unknown>;
  outputs: Record<string, unknown>;
  expiresAt: string;
}> {
  const software = resolveCloseoutReconciliationBuildIdentity();
  assertWave1CanonicalTarget({
    workspaceId: input.workspaceId,
    expectedWorkspaceId: software.buildReceipt.workspaceId,
    canonicalSpecPath: software.buildReceipt.canonicalSpecPath,
  });
  const databaseClock = await queryOne<{ now_exact: string }>(
    `SELECT to_char(statement_timestamp() AT TIME ZONE 'UTC',
       'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now_exact`,
  );
  const databaseNowMs = Date.parse(String(databaseClock?.now_exact ?? ''));
  if (!Number.isFinite(databaseNowMs)) throw new ServiceUnavailableError('Database transaction clock is unavailable');
  const run = await loadRun(input.runId, input.workspaceId);
  if (!Number.isSafeInteger(input.runId) || input.runId <= 0) throw new ValidationError('Invalid run ID');
  const hostAuthority = await inspectRunHostAuthority(input.runId);
  if (!hostAuthority || hostAuthority.workspaceId !== input.workspaceId
    || !hostAuthority.closeoutEligible || !hostAuthority.releaseEligible
    || !hostAuthority.complete || hostAuthority.invalidReason
    || !hostAuthority.terminalRevision || !hostAuthority.finalCommitSha) {
    throw new ConflictError(`Run lacks exact release-eligible host authority: ${hostAuthority?.invalidReason ?? 'not found'}`);
  }
  assertWave1CanonicalTarget({
    workspaceId: run.workspace_id,
    expectedWorkspaceId: software.buildReceipt.workspaceId,
    canonicalSpecPath: run.spec_path,
  });
  if (hostAuthority.workspaceId !== run.workspace_id) {
    throw new ConflictError('Wave 1 host authority workspace differs from the canonical run target');
  }
  if (hostAuthority.expectedStoryIds.length === 0
    || hostAuthority.expectedStoryIds.length > MAX_PREVIEW_STORIES) {
    throw new ConflictError(`Closeout reconciliation supports 1-${MAX_PREVIEW_STORIES} frozen stories`);
  }
  if (!run.execution_workspace_path || !run.execution_worktree_path || !run.branch_name) {
    throw new ConflictError('Run lacks frozen host path and branch authority');
  }
  const canonicalWorkspaceRealpath = fs.realpathSync(run.workspace_path);
  const workspaceRealpath = fs.realpathSync(run.execution_workspace_path);
  const worktreeRealpath = fs.realpathSync(run.execution_worktree_path);
  const canonicalRepositoryTop = fs.realpathSync(git(canonicalWorkspaceRealpath, ['rev-parse', '--show-toplevel']));
  if (canonicalWorkspaceRealpath !== canonicalRepositoryTop
    || workspaceRealpath !== canonicalRepositoryTop
    || workspaceRealpath !== fs.realpathSync(hostAuthority.repositoryTopLevel)
    || worktreeRealpath !== fs.realpathSync(hostAuthority.checkoutPath)
    || run.branch_name !== hostAuthority.branchName) {
    throw new ConflictError('Run host checkout differs from canonical workspace.path repository authority');
  }
  const canonicalCommonDir = fs.realpathSync(path.resolve(
    canonicalRepositoryTop,
    git(canonicalRepositoryTop, ['rev-parse', '--git-common-dir']),
  ));
  const worktreeCommonDir = fs.realpathSync(path.resolve(
    worktreeRealpath,
    git(worktreeRealpath, ['rev-parse', '--git-common-dir']),
  ));
  const listedWorktrees = git(canonicalRepositoryTop, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => fs.realpathSync(line.slice('worktree '.length)));
  if (canonicalCommonDir !== worktreeCommonDir || !listedWorktrees.includes(worktreeRealpath)) {
    throw new ConflictError('Execution checkout is not an actual worktree member of workspace.path');
  }
  const sourceRemote = normalizedRepositoryRemote(git(canonicalRepositoryTop, ['remote', 'get-url', 'origin']));
  if (sourceRemote !== normalizedRepositoryRemote(WAVE_1_SOURCE_REPOSITORY)) {
    throw new ConflictError('Canonical workspace repository remote differs from reviewed Wave source');
  }
  const canonicalSpecPath = fs.realpathSync(path.resolve(canonicalRepositoryTop, WAVE_1_SPEC_PATH));
  if (canonicalSpecPath !== path.resolve(canonicalRepositoryTop, WAVE_1_SPEC_PATH)
    || !canonicalSpecPath.startsWith(`${canonicalRepositoryTop}${path.sep}`)) {
    throw new ConflictError('Canonical Wave spec path escaped workspace.path');
  }
  const canonicalSpecBytes = fs.readFileSync(canonicalSpecPath);
  if (exactSha256(canonicalSpecBytes) !== WAVE_1_SPEC_CONTENT_HASH) {
    throw new ConflictError('Actual canonical Wave spec bytes differ from the reviewed content hash');
  }
  const buildSha = software.buildSha.toLowerCase();
  const requiredFixSha = software.requiredFixSha.toLowerCase();
  if (!SHA1.test(buildSha) || !SHA1.test(requiredFixSha)) {
    throw new ConflictError('Build lineage receipt does not contain exact Git identities');
  }
  try {
    git(canonicalRepositoryTop, ['cat-file', '-e', `${buildSha}^{commit}`]);
    git(canonicalRepositoryTop, ['merge-base', '--is-ancestor', requiredFixSha, buildSha]);
  } catch {
    throw new ConflictError('Reviewed build does not descend from the required worker-closeout fix in the canonical repository');
  }
  const baseBranch = git(canonicalRepositoryTop, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const baseHeadSha = git(canonicalRepositoryTop, ['rev-parse', '--verify', `refs/heads/${baseBranch}^{commit}`]).toLowerCase();
  if (!SHA1.test(baseHeadSha)) throw new ConflictError('Canonical base does not resolve to an exact commit');

  const sourceSpecPath = canonicalSpecPath;
  const runSpecPath = deriveRunSpecPath({
    runId: input.runId,
    sourceSpecPath,
    workspacePath: workspaceRealpath,
    worktreePath: worktreeRealpath,
  });
  assertRunSpecAuthorityProjection({
    specPath: runSpecPath,
    expectedStoryIds: hostAuthority.expectedStoryIds,
    excludedStoryIds: hostAuthority.excludedStoryIds,
    authoritativePassedStoryIds: hostAuthority.authoritativePassedStoryIds,
  });
  const runSpecBytes = fs.readFileSync(runSpecPath);
  if (runSpecBytes.length > 2 * 1024 * 1024) throw new ConflictError('Run spec projection exceeds reconciliation bound');
  try {
    const canonicalProjection: unknown = JSON.parse(canonicalSpecBytes.toString('utf8'));
    const runProjection: unknown = JSON.parse(runSpecBytes.toString('utf8'));
    assertExactRunLocalSpecLifecycleAuthority(hostAuthority, canonicalProjection, runProjection);
  } catch {
    throw new ConflictError('run spec projection lifecycle flags lack host authority or canonical story semantics changed');
  }

  const [stories, processFinished, publication, ownership, outputs] = await Promise.all([
    exactStoryEvidence(run, hostAuthority, databaseNowMs),
    processEvidence(run),
    dispatchPublication(run),
    ownershipSnapshot(run, databaseNowMs, input.ownBossJobId),
    outputSnapshot(run),
  ]);
  const expiries = stories.map((story) => Date.parse(String(
    ((story.attestation as Record<string, unknown>).expiresAt),
  )));
  const earliest = Math.min(...expiries);
  if (!Number.isFinite(earliest) || earliest <= databaseNowMs) {
    throw new UnprocessableError('Closeout reconciliation evidence has expired', 'CLOSEOUT_EVIDENCE_EXPIRED');
  }
  const posture = frozenPosture(run);
  const immutableAuthority: Record<string, unknown> = {
    run: {
      id: input.runId, workspaceId: run.workspace_id,
      specId: hostAuthority.specId, specPath: run.spec_path,
      startedAt: iso(run.started_at, 'run started_at'),
      originalFinishedAt: storedProjectionTimestamp(
        run.finished_at_exact,
        run.finished_at,
        'run finished_at',
      ),
    },
    scope: {
      expectedStoryIds: hostAuthority.expectedStoryIds,
      excludedStoryIds: hostAuthority.excludedStoryIds,
      acceptedStoryIds: hostAuthority.acceptedStoryIds,
    },
    processFinished,
    stories,
    git: {
      branch: hostAuthority.branchName,
      canonicalWorkspaceRealpath,
      workspaceRealpath,
      worktreeRealpath,
      repositoryCommonDir: canonicalCommonDir,
      repositoryRemote: sourceRemote,
      terminalHead: hostAuthority.terminalRevision,
      finalCommitSha: hostAuthority.finalCommitSha,
      orderedIntegrationAncestry: hostAuthority.integrationAncestry,
      baseBranch,
      baseHeadSha,
    },
    canonicalSpec: {
      path: canonicalSpecPath,
      hash: exactSha256(canonicalSpecBytes),
      sizeBytes: canonicalSpecBytes.length,
    },
    runSpec: {
      path: runSpecPath,
      hash: exactSha256(runSpecBytes),
      sizeBytes: runSpecBytes.length,
    },
    dispatch: { ...posture, publication },
    software,
    earliestEvidenceExpiry: new Date(earliest).toISOString(),
  };
  return {
    run,
    hostAuthority,
    immutableAuthority,
    originalProjection: {
      status: run.status,
      lifecycleStatus: run.lifecycle_status,
      summary: run.summary,
      lifecycleDiagnostics: jsonRecord(run.lifecycle_diagnostics),
      lifecycleUpdatedAt: storedProjectionTimestamp(
        run.lifecycle_updated_at_exact,
        run.lifecycle_updated_at,
        'lifecycle updated_at',
      ),
      finishedAt: storedProjectionTimestamp(run.finished_at_exact, run.finished_at, 'run finished_at'),
    },
    ownership,
    outputs,
    expiresAt: new Date(earliest).toISOString(),
  };
}

async function repeatableRead<T>(operation: () => Promise<T>): Promise<T> {
  return transaction(async (client: PoolClient) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    return operation();
  });
}

function requireWave1ReconciliationSelector(runId: number): CloseoutReconciliationBuildIdentity {
  // The permanent deny list is evaluated before even resolving deployment
  // metadata, and therefore before every run/evidence read or mutation lock.
  assertNotProtectedWave1Run(runId);
  const deployment = resolveCloseoutReconciliationBuildIdentity();
  assertWave1ReconciliationSelector(runId, deployment);
  return deployment;
}

export async function previewRunCloseoutReconciliation(input: {
  runId: number;
  workspaceId: string;
}): Promise<CloseoutReconciliationPreview> {
  if (!Number.isSafeInteger(input.runId) || input.runId <= 0) {
    throw new ValidationError('Run ID must be a positive safe integer');
  }
  requireWave1ReconciliationSelector(input.runId);
  return repeatableRead(async () => {
    const observed = await observeAuthority(input);
    assertInitialProjection(observed.run, observed.outputs);
    const immutableAuthorityHash = retryHash(observed.immutableAuthority);
    const target: CloseoutReconciliationPreview['target'] = {
      runId: input.runId,
      workspaceId: input.workspaceId,
      specId: observed.hostAuthority.specId,
      expiresAt: observed.expiresAt,
      immutableAuthorityHash,
      immutableAuthority: observed.immutableAuthority,
      originalProjection: observed.originalProjection,
      ownership: observed.ownership,
      existingOutputs: observed.outputs,
    };
    return {
      schemaVersion: CLOSEOUT_RECONCILIATION_PREVIEW_VERSION,
      eligible: true,
      target,
      canonicalTargetHash: retryHash({
        schemaVersion: CLOSEOUT_RECONCILIATION_PREVIEW_VERSION,
        target,
      }),
    };
  });
}

async function isFutureAtDatabaseTime(timestamp: string): Promise<boolean> {
  const row = await queryOne<{ future: boolean }>(
    'SELECT $1::timestamptz > statement_timestamp() AS future', [timestamp],
  );
  return row?.future === true;
}

/** Safe public/MCP projection: no host paths, receipt payloads, actors, or Git topology. */
export async function getSafeRunCloseoutReconciliation(input: {
  runId: number;
  workspaceId: string;
}): Promise<SafeCloseoutReconciliationProjection> {
  assertNotProtectedWave1Run(input.runId);
  if (input.runId !== WAVE_1_MANAGED_PROOF_RUN_ID) {
    throw new ConflictError('Run is not the exact Wave 1 managed proof identity');
  }
  const row = await queryOne<ReconciliationRow>(`
    SELECT * FROM pipeline_run_closeout_reconciliations
     WHERE run_id = $1 AND workspace_id = $2
  `, [input.runId, input.workspaceId]);
  if (!row) {
    const preview = await previewRunCloseoutReconciliation(input);
    return {
      schemaVersion: 'rorca.run-closeout-reconciliation-public.v1',
      runId: input.runId,
      workspaceId: input.workspaceId,
      state: 'eligible',
      previewHash: preview.canonicalTargetHash,
      immutableAuthorityHash: preview.target.immutableAuthorityHash,
      expiresAt: preview.target.expiresAt,
      reconciliationEventId: null,
      reconciledAt: null,
      resultReceiptHash: null,
    };
  }
  return {
    schemaVersion: 'rorca.run-closeout-reconciliation-public.v1',
    runId: Number(row.run_id),
    workspaceId: row.workspace_id,
    state: row.state,
    previewHash: row.preview_hash,
    immutableAuthorityHash: row.immutable_authority_hash,
    expiresAt: iso(row.preview_expires_at, 'preview expiry'),
    reconciliationEventId: row.reconciliation_event_id ?? null,
    reconciledAt: iso(row.reconciled_at, 'reconciled_at'),
    resultReceiptHash: row.result_receipt_hash,
  };
}

function requestHash(input: {
  runId: number;
  workspaceId: string;
  previewHash: string;
  rationale: string;
  requesterActorId: string;
  ownerAuthorization: ProviderHumanEvent;
}): string {
  return retryHash({
    schemaVersion: 'rorca.run-closeout-reconciliation-request.v1',
    runId: input.runId,
    workspaceId: input.workspaceId,
    acceptedPreviewHash: input.previewHash,
    rationale: input.rationale,
    requesterActorId: input.requesterActorId,
    ownerAuthorizationHash: providerHumanActionHash(input.ownerAuthorization),
  });
}

function jobPayload(row: Pick<ReconciliationRow,
  'id' | 'run_id' | 'workspace_id' | 'preview_hash' | 'transport_generation'>): CloseoutReconciliationJobPayload {
  const runId = Number(row.run_id);
  assertNotProtectedWave1Run(runId);
  if (runId !== WAVE_1_MANAGED_PROOF_RUN_ID) {
    throw new ConflictError('Closeout reconciliation transport is not bound to the exact Wave 1 proof run');
  }
  return {
    schemaVersion: CLOSEOUT_RECONCILIATION_JOB_VERSION,
    reconciliationId: row.id,
    runId: WAVE_1_MANAGED_PROOF_RUN_ID,
    workspaceId: row.workspace_id,
    previewHash: row.preview_hash,
    transportGeneration: row.transport_generation,
  };
}

function resultFromRow(row: ReconciliationRow, replayed: boolean): CloseoutReconciliationRequestResult {
  return {
    reconciliationId: row.id,
    runId: Number(row.run_id),
    workspaceId: row.workspace_id,
    state: row.state,
    previewHash: row.preview_hash,
    resultReceiptHash: row.result_receipt_hash,
    reconciledAt: iso(row.reconciled_at, 'reconciled_at'),
    replayed,
  };
}

async function loadReconciliationById(id: string): Promise<ReconciliationRow | undefined> {
  return queryOne<ReconciliationRow>(
    'SELECT * FROM pipeline_run_closeout_reconciliations WHERE id = $1', [id],
  );
}

async function loadReconciliationByIdempotency(workspaceId: string, idempotencyKey: string): Promise<ReconciliationRow | undefined> {
  return queryOne<ReconciliationRow>(`
    SELECT * FROM pipeline_run_closeout_reconciliations
     WHERE workspace_id = $1 AND idempotency_key = $2
  `, [workspaceId, idempotencyKey]);
}

async function loadReconciliationByRun(runId: number, workspaceId: string): Promise<ReconciliationRow | undefined> {
  return queryOne<ReconciliationRow>(`
    SELECT * FROM pipeline_run_closeout_reconciliations
     WHERE run_id = $1 AND workspace_id = $2
  `, [runId, workspaceId]);
}

function observedPgBossTransportState(row: { state: string; output: unknown }): string {
  if (row.state !== 'failed' || !row.output || typeof row.output !== 'object' || Array.isArray(row.output)) {
    return row.state;
  }
  const value = (row.output as Record<string, unknown>).value;
  const message = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>).message
    : undefined;
  return message === 'job failed by timeout in active state' ? 'expired' : row.state;
}

export async function publishCloseoutReconciliation(
  reconciliationId: string,
  expectedRunId: number,
  transport?: Pick<ReturnType<typeof getBoss>, 'createQueue' | 'send'>,
): Promise<void> {
  assertNotProtectedWave1Run(expectedRunId);
  if (!transport) await initBoss();
  const boss = transport ?? getBoss();
  await boss.createQueue(CLOSEOUT_RECONCILIATION_QUEUE);
  const schema = getPgBossSchemaSql();
  const prepared = await transaction(async (client: PoolClient) => {
    let row = (await client.query<ReconciliationRow>(
      'SELECT * FROM pipeline_run_closeout_reconciliations WHERE id = $1 AND run_id = $2 FOR UPDATE',
      [reconciliationId, expectedRunId],
    )).rows[0];
    if (!row) throw new NotFoundError('Closeout reconciliation', reconciliationId);
    if (row.state === 'processing' || row.state === 'completed' || row.state === 'blocked') return null;
    const payload = jobPayload(row);
    if (retryHash(payload) !== row.job_payload_hash) {
      throw new ConflictError('Closeout reconciliation job payload no longer matches application authority');
    }
    type TransportRow = { id: string; name: string; state: string; data: unknown; output: unknown };
    const live = (await client.query<TransportRow>(
      `SELECT id::text, name, state, data, output FROM ${schema}.job WHERE id = $1::uuid`, [row.boss_job_id],
    )).rows[0];
    const archived = (await client.query<TransportRow>(
      `SELECT id::text, name, state, data, output FROM ${schema}.archive WHERE id = $1::uuid`, [row.boss_job_id],
    )).rows[0];
    if (live && archived) {
      await client.query(`UPDATE pipeline_run_closeout_reconciliations
        SET last_error_code='TRANSPORT_DUPLICATE',last_error_message='Job UUID exists in live and archive transport',updated_at=statement_timestamp()
        WHERE id=$1`, [row.id]);
      return { transportConflict: 'duplicate' as const };
    }
    const observed = live ?? archived;
    if (observed) {
      const parsedData = CloseoutReconciliationJobPayloadSchema.safeParse(observed.data);
      const exactTransport = observed.name === CLOSEOUT_RECONCILIATION_QUEUE
        && parsedData.success
        && retryHash(parsedData.data) === row.job_payload_hash
        && parsedData.data.transportGeneration === row.transport_generation;
      if (!exactTransport) {
        await client.query(`UPDATE pipeline_run_closeout_reconciliations
          SET last_error_code='TRANSPORT_IDENTITY_MISMATCH',last_error_message='Queue name, payload, or generation differs from application authority',updated_at=statement_timestamp()
          WHERE id=$1`, [row.id]);
        return { transportConflict: 'identity_mismatch' as const };
      }
    }
    const liveActionable = live && ['created', 'retry', 'active'].includes(live.state);
    if (!liveActionable && observed) {
      const previousJobId = row.boss_job_id;
      const previousState = observedPgBossTransportState(observed);
      const previousLocation = live ? 'live' : 'archive';
      const replacement = randomUUID();
      const replacementGeneration = row.transport_generation + 1;
      const replacementPayload = {
        ...payload,
        transportGeneration: replacementGeneration,
      };
      const replacementPayloadHash = retryHash(replacementPayload);
      row = (await client.query<ReconciliationRow>(`
        UPDATE pipeline_run_closeout_reconciliations
           SET boss_job_id = $2::uuid,
               transport_generation = $6,
               job_payload_hash = $7,
               transport_history = transport_history || jsonb_build_array(jsonb_build_object(
                 'bossJobId', $3::text, 'state', $4::text, 'location', $5::text,
                 'queue', $8::text, 'payloadHash', $9::text,
                 'retiredAt', to_char(statement_timestamp() AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
               )),
               updated_at = statement_timestamp()
         WHERE id = $1 AND state IN ('prepared','queued')
           AND boss_job_id = $3::uuid AND transport_generation = $6 - 1
         RETURNING *
      `, [row.id, replacement, previousJobId, previousState, previousLocation,
        replacementGeneration, replacementPayloadHash, observed.name, retryHash(observed.data)])).rows[0];
      if (!row) throw new ConflictError('Archived transport generation rotation lost application authority');
    }
    return { row, payload: jobPayload(row), alreadyActionable: Boolean(liveActionable) };
  });
  if (!prepared) return;
  if ('transportConflict' in prepared) {
    throw new ConflictError(prepared.transportConflict === 'duplicate'
      ? 'Closeout reconciliation transport UUID is duplicated across live and archive'
      : 'Closeout reconciliation transport name/data/generation mismatch');
  }

  let sent: string | null;
  try {
    sent = prepared.alreadyActionable
      ? prepared.row.boss_job_id
      : await boss.send(CLOSEOUT_RECONCILIATION_QUEUE, prepared.payload, {
        id: prepared.row.boss_job_id,
        retryLimit: 5,
        retryDelay: 30,
        expireInSeconds: 600,
      });
  } catch (error) {
    await execute(`UPDATE pipeline_run_closeout_reconciliations
      SET last_error_code='TRANSPORT_SEND_FAILED',last_error_message=$2,updated_at=statement_timestamp()
      WHERE id=$1 AND boss_job_id=$3::uuid`, [prepared.row.id,
      (error instanceof Error ? error.message : String(error)).slice(0, 1024), prepared.row.boss_job_id]);
    throw error;
  }
  if (!sent || sent !== prepared.row.boss_job_id) {
    await execute(`UPDATE pipeline_run_closeout_reconciliations
      SET last_error_code='TRANSPORT_NULL_SEND',last_error_message='pg-boss send returned null or a different UUID',updated_at=statement_timestamp()
      WHERE id=$1 AND boss_job_id=$2::uuid`, [prepared.row.id, prepared.row.boss_job_id]);
    throw new ServiceUnavailableError('Closeout reconciliation transport did not preserve application-owned job identity');
  }
  const queued = await queryOne<{ id: string }>(`
    UPDATE pipeline_run_closeout_reconciliations
       SET state = 'queued', published_at = COALESCE(published_at, statement_timestamp()),
           publish_attempt_count = publish_attempt_count + 1,
           last_error_code = NULL, last_error_message = NULL,
           updated_at = statement_timestamp()
     WHERE id = $1 AND state IN ('prepared','queued')
       AND boss_job_id = $2::uuid AND job_payload_hash = $3
       AND transport_generation = $4
     RETURNING id
  `, [prepared.row.id, prepared.row.boss_job_id, prepared.row.job_payload_hash,
    prepared.row.transport_generation]);
  if (!queued) {
    const progressed = await loadReconciliationById(prepared.row.id);
    if (progressed
      && progressed.boss_job_id === prepared.row.boss_job_id
      && progressed.job_payload_hash === prepared.row.job_payload_hash
      && progressed.transport_generation === prepared.row.transport_generation
      && ['completed', 'blocked'].includes(progressed.state)) return;
    throw new ConflictError('Closeout reconciliation publication lost application authority');
  }
}

export async function requestRunCloseoutReconciliation(input: {
  runId: number;
  workspaceId: string;
  acceptedPreviewHash: string;
  rationale: string;
  ownerAuthorization: ProviderHumanEvent;
  requesterActorId: string;
  idempotencyKey: string;
}): Promise<CloseoutReconciliationRequestResult> {
  if (!Number.isSafeInteger(input.runId) || input.runId <= 0) {
    throw new ValidationError('Run ID must be a positive safe integer');
  }
  requireWave1ReconciliationSelector(input.runId);
  const idempotencyKey = requireCloseoutReconciliationIdempotencyKey(input.idempotencyKey);
  const parsed = closeoutReconciliationRequestSchema.parse({
    workspaceId: input.workspaceId,
    acceptedPreviewHash: input.acceptedPreviewHash,
    rationale: input.rationale,
    ownerAuthorization: input.ownerAuthorization,
  });
  if (!input.requesterActorId.trim() || input.requesterActorId.length > 256) {
    throw new ForbiddenError('Exact local repair requester identity is required');
  }
  const exactRequestHash = requestHash({
    runId: input.runId,
    workspaceId: parsed.workspaceId,
    previewHash: parsed.acceptedPreviewHash,
    rationale: parsed.rationale,
    requesterActorId: input.requesterActorId,
    ownerAuthorization: parsed.ownerAuthorization,
  });
  const existing = await loadReconciliationByIdempotency(parsed.workspaceId, idempotencyKey);
  if (existing) {
    if (existing.request_hash !== exactRequestHash || Number(existing.run_id) !== input.runId) {
      throw new ConflictError('Idempotency-Key was already used for a different closeout reconciliation request');
    }
    await publishCloseoutReconciliation(existing.id, input.runId);
    return resultFromRow((await loadReconciliationById(existing.id))!, true);
  }

  return withPgAdvisoryLock(`pipeline-run-authority:${input.runId}`, async () => {
    const raced = await loadReconciliationByIdempotency(parsed.workspaceId, idempotencyKey);
    if (raced) {
      if (raced.request_hash !== exactRequestHash || Number(raced.run_id) !== input.runId) {
        throw new ConflictError('Idempotency-Key was already used for a different closeout reconciliation request');
      }
      await publishCloseoutReconciliation(raced.id, input.runId);
      return resultFromRow((await loadReconciliationById(raced.id))!, true);
    }
    if (await loadReconciliationByRun(input.runId, parsed.workspaceId)) {
      throw new ConflictError('Run already has a distinct closeout reconciliation authority request');
    }
    const preview = await previewRunCloseoutReconciliation({
      runId: input.runId,
      workspaceId: parsed.workspaceId,
    });
    if (preview.canonicalTargetHash !== parsed.acceptedPreviewHash) {
      throw new ConflictError('Accepted closeout reconciliation preview is stale or mismatched');
    }
    if (!await isFutureAtDatabaseTime(preview.target.expiresAt)) {
      throw new UnprocessableError('Accepted closeout reconciliation preview has expired', 'CLOSEOUT_PREVIEW_EXPIRED');
    }
    const owner = await verifyAndPersistProviderHumanAuthority({
      workspaceId: parsed.workspaceId,
      purpose: 'run_closeout_reconciliation',
      targetHash: preview.canonicalTargetHash,
      event: parsed.ownerAuthorization,
      requesterActorId: input.requesterActorId,
      requireDistinctActor: true,
      requireWorkspaceOwner: true,
    });
    // Re-observe after receipt persistence. The receipt is append-only but may
    // not authorize a target whose evidence drifted before ledger preparation.
    const current = await previewRunCloseoutReconciliation({
      runId: input.runId,
      workspaceId: parsed.workspaceId,
    });
    if (current.canonicalTargetHash !== preview.canonicalTargetHash) {
      throw new ConflictError('Closeout reconciliation authority changed before request preparation');
    }
    const reconciliationId = randomUUID();
    const bossJobId = randomUUID();
    const payload = jobPayload({
      id: reconciliationId,
      run_id: input.runId,
      workspace_id: parsed.workspaceId,
      preview_hash: preview.canonicalTargetHash,
      transport_generation: 1,
    });
    const inserted = await queryOne<ReconciliationRow>(`
      INSERT INTO pipeline_run_closeout_reconciliations (
        id, run_id, workspace_id, idempotency_key, request_hash,
        preview_hash, immutable_authority_hash, owner_receipt_id,
        requester_actor_id, rationale, required_fix_sha, build_sha,
        build_receipt_hash, preview_expires_at, state, boss_job_id,
        job_payload_hash, before_projection
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'prepared',$15,$16,$17::jsonb
      )
      RETURNING *
    `, [
      reconciliationId, input.runId, parsed.workspaceId, idempotencyKey,
      exactRequestHash, preview.canonicalTargetHash,
      preview.target.immutableAuthorityHash, owner.receiptId,
      input.requesterActorId, parsed.rationale,
      REQUIRED_CLOSEOUT_TIMESTAMP_FIX_SHA,
      String((preview.target.immutableAuthority.software as Record<string, unknown>).buildSha),
      String((preview.target.immutableAuthority.software as Record<string, unknown>).buildReceiptHash),
      preview.target.expiresAt, bossJobId, retryHash(payload), JSON.stringify(preview),
    ]);
    if (!inserted) throw new ConflictError('Closeout reconciliation request was not durably prepared');
    await publishCloseoutReconciliation(inserted.id, input.runId);
    return resultFromRow((await loadReconciliationById(inserted.id))!, false);
  });
}

function parseStoredPreview(row: ReconciliationRow): CloseoutReconciliationPreview {
  const preview = jsonRecord(row.before_projection) as unknown as CloseoutReconciliationPreview;
  if (preview.schemaVersion !== CLOSEOUT_RECONCILIATION_PREVIEW_VERSION
    || preview.eligible !== true || !preview.target
    || preview.target.runId !== Number(row.run_id)
    || preview.target.workspaceId !== row.workspace_id
    || preview.canonicalTargetHash !== row.preview_hash
    || preview.target.immutableAuthorityHash !== row.immutable_authority_hash
    || retryHash({ schemaVersion: preview.schemaVersion, target: preview.target }) !== row.preview_hash
    || retryHash(preview.target.immutableAuthority) !== row.immutable_authority_hash) {
    throw new CloseoutReconciliationBlockedError('PREVIEW_IDENTITY_INVALID', 'Stored closeout preview identity is invalid');
  }
  return preview;
}

async function assertOwnedProgress(
  row: ReconciliationRow,
  preview: CloseoutReconciliationPreview,
  observed: Awaited<ReturnType<typeof observeAuthority>>,
): Promise<void> {
  const terminalSha = observed.hostAuthority.terminalRevision!;
  const outputs = observed.outputs;
  const effects = outputs.providerAndIntegration as Record<string, unknown>;
  if (outputs.githubCheckProjectionCount !== 0
    || effects.prNumber !== null || effects.mergeStatus !== null
    || effects.mergeCommitSha !== null || effects.worktreeCleanupStatus !== 'not_started'
    || effects.worktreeCleanedAt !== null) {
    throw new CloseoutReconciliationBlockedError(
      'FORBIDDEN_OUTPUT_DRIFT',
      'Provider, merge, Check Run, or worktree cleanup output appeared after authorization',
    );
  }
  const terminalCheckout = outputs.terminalCheckout as Record<string, unknown>;
  const hostRows = outputs.hostCloseouts as Array<Record<string, unknown>>;
  const terminalRows = outputs.terminalEvents as Array<Record<string, unknown>>;
  if (hostRows.length > 1 || terminalRows.length > 1) {
    throw new CloseoutReconciliationBlockedError('TERMINAL_EVIDENCE_MULTIPLICITY', 'Run has duplicate trusted closeout or terminal evidence');
  }
  const release = outputs.releaseIntent as Record<string, unknown> | null;
  assertProtocolOwnedProjectionProgress(
    preview.target.originalProjection,
    observed.originalProjection,
    {
      hostCloseoutCount: hostRows.length,
      releaseStatus: release === null ? null : String(release.status),
      terminalEventCount: terminalRows.length,
    },
  );
  if (hostRows.length === 0) {
    if (terminalCheckout.sha !== null || terminalCheckout.attestedAt !== null
      || outputs.hostCloseoutPointer !== null || release !== null || terminalRows.length !== 0) {
      throw new CloseoutReconciliationBlockedError('PARTIAL_AUTHORITY_INVALID', 'Run projections exist without exact host closeout authority');
    }
    return;
  }
  if (terminalCheckout.sha !== terminalSha || typeof terminalCheckout.attestedAt !== 'string') {
    throw new CloseoutReconciliationBlockedError('TERMINAL_CHECKOUT_DRIFT', 'Terminal checkout fence differs from authorized host HEAD');
  }

  const expectedPrepared = await prepareHostRunCloseout({ runId: Number(row.run_id), status: 'done' });
  const actual = await loadHostRunCloseoutReference(Number(row.run_id));
  if (actual.reference.id !== Number(outputs.hostCloseoutPointer)
    || hostRows[0].id !== actual.reference.id
    || hostRows[0].identityHash !== actual.reference.identityHash
    || !samePreparedHostCloseout(expectedPrepared, {
      runId: expectedPrepared.runId,
      workspaceId: expectedPrepared.workspaceId,
      specId: expectedPrepared.specId,
      status: expectedPrepared.status,
      payload: actual.payload,
    })) {
    throw new CloseoutReconciliationBlockedError('HOST_CLOSEOUT_DRIFT', 'Host closeout differs from exact accepted authority');
  }

  if (!release) return;
  const immutableGit = preview.target.immutableAuthority.git as Record<string, unknown>;
  if (release.runId !== Number(row.run_id) || release.workspaceId !== row.workspace_id
    || release.specId !== preview.target.specId || release.authorizedSha !== terminalSha
    || release.branchName !== immutableGit.branch
    || release.executionWorkspacePath !== immutableGit.workspaceRealpath
    || release.executionWorktreePath !== immutableGit.worktreeRealpath
    || release.repository !== null || release.mergeStrategy !== 'branch-only'
    || release.autoMerge !== false || release.externalSend !== false
    || release.deploymentAllowed !== false || release.providerReleaseRef !== null
    || release.integrationCheckoutPath !== null || release.mergeCommitSha !== null
    || release.baseBranch !== immutableGit.baseBranch || release.baseSha !== immutableGit.baseHeadSha
    || release.hostCloseoutEventId !== actual.reference.id
    || release.hostCloseoutIdentityHash !== actual.reference.identityHash) {
    throw new CloseoutReconciliationBlockedError('RELEASE_INTENT_DRIFT', 'Release intent differs from frozen branch-only/no-send authority');
  }
  const terminalEventId = release.terminalEventId;
  if ((terminalEventId === null) !== (terminalRows.length === 0)
    || (terminalEventId !== null && terminalRows[0]?.id !== terminalEventId)) {
    throw new CloseoutReconciliationBlockedError('TERMINAL_EVENT_DRIFT', 'Trusted terminal event differs from release intent');
  }
}

async function revalidateAcceptedPreview(row: ReconciliationRow): Promise<{
  preview: CloseoutReconciliationPreview;
  observed: Awaited<ReturnType<typeof observeAuthority>>;
}> {
  const preview = parseStoredPreview(row);
  if (row.required_fix_sha !== REQUIRED_CLOSEOUT_TIMESTAMP_FIX_SHA
    || !await isFutureAtDatabaseTime(iso(row.preview_expires_at, 'preview expiry')!)) {
    throw new CloseoutReconciliationBlockedError('EVIDENCE_EXPIRED', 'Accepted closeout preview or host evidence has expired');
  }
  let observed: Awaited<ReturnType<typeof observeAuthority>>;
  try {
    observed = await repeatableRead(() => observeAuthority({
      runId: Number(row.run_id), workspaceId: row.workspace_id, ownBossJobId: row.boss_job_id,
    }));
  } catch (error) {
    throw new CloseoutReconciliationBlockedError(
      error instanceof UnprocessableError
        ? 'EVIDENCE_EXPIRED'
        : error instanceof ServiceUnavailableError
          ? 'BUILD_AUTHORITY_UNAVAILABLE'
          : 'IMMUTABLE_AUTHORITY_DRIFT',
      error instanceof Error ? error.message : String(error),
    );
  }
  const acceptedSoftware = preview.target.immutableAuthority.software as unknown as CloseoutReconciliationBuildIdentity;
  const workerSoftware = observed.immutableAuthority.software as unknown as CloseoutReconciliationBuildIdentity;
  if (acceptedSoftware.buildSha !== row.build_sha
    || acceptedSoftware.buildReceiptHash !== row.build_receipt_hash
    || acceptedSoftware.requiredFixSha !== row.required_fix_sha
    || !sameCloseoutReconciliationBuildIdentity(acceptedSoftware, workerSoftware)) {
    throw new CloseoutReconciliationBlockedError(
      'BUILD_AUTHORITY_DRIFT',
      'Worker startup build receipt differs from the exact API deployment receipt',
    );
  }
  if (retryHash(observed.immutableAuthority) !== row.immutable_authority_hash) {
    throw new CloseoutReconciliationBlockedError('IMMUTABLE_AUTHORITY_DRIFT', 'Run evidence, Git, spec, or dispatch authority changed');
  }
  await assertOwnedProgress(row, preview, observed);
  return { preview, observed };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function claimReconciliation(input: {
  reconciliationId: string;
  jobId: string;
  payload: CloseoutReconciliationJobPayload;
}): Promise<{ row: ReconciliationRow; claimToken: string } | null> {
  return transaction(async (client: PoolClient) => {
    const row = (await client.query<ReconciliationRow>(
      'SELECT * FROM pipeline_run_closeout_reconciliations WHERE id = $1 FOR UPDATE',
      [input.reconciliationId],
    )).rows[0];
    if (!row) throw new CloseoutReconciliationBlockedError('REQUEST_MISSING', 'Closeout reconciliation application authority is absent');
    if (row.state === 'completed' || row.state === 'blocked') return null;
    if (row.boss_job_id !== input.jobId || retryHash(input.payload) !== row.job_payload_hash
      || Number(row.run_id) !== input.payload.runId
      || row.workspace_id !== input.payload.workspaceId
      || row.preview_hash !== input.payload.previewHash
      || row.transport_generation !== input.payload.transportGeneration) {
      throw new CloseoutReconciliationBlockedError('JOB_IDENTITY_MISMATCH', 'Transport delivery differs from application-owned closeout authority');
    }
    const claimToken = randomUUID();
    const claimed = (await client.query<ReconciliationRow>(`
      UPDATE pipeline_run_closeout_reconciliations
         SET state = 'processing', claim_token = $2,
             claim_expires_at = NOW() + INTERVAL '5 minutes',
             claimed_at = COALESCE(claimed_at, NOW()),
             attempt_count = attempt_count + 1,
             last_error_code = NULL, last_error_message = NULL, updated_at = NOW()
       WHERE id = $1 AND state IN ('prepared','queued','processing')
         AND attempt_count < 1000
         AND preview_expires_at > NOW()
       RETURNING *
    `, [row.id, claimToken])).rows[0];
    if (!claimed) throw new CloseoutReconciliationBlockedError('CLAIM_EXHAUSTED', 'Closeout reconciliation claim could not be acquired');
    return { row: claimed, claimToken };
  });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function markBlocked(row: ReconciliationRow, claimToken: string, code: string, message: string): Promise<void> {
  await execute(`
    UPDATE pipeline_run_closeout_reconciliations
       SET state = 'blocked', claim_token = NULL, claim_expires_at = NULL,
           last_error_code = $3, last_error_message = $4, updated_at = NOW()
     WHERE id = $1 AND state = 'processing' AND claim_token = $2::uuid
  `, [row.id, claimToken, code.slice(0, 96), message.slice(0, 1024)]);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function releaseClaimForRetry(row: ReconciliationRow, claimToken: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await execute(`
    UPDATE pipeline_run_closeout_reconciliations
       SET state = 'queued', claim_token = NULL, claim_expires_at = NULL,
           last_error_code = 'TRANSIENT_PROCESSING_ERROR',
           last_error_message = $3, updated_at = NOW()
     WHERE id = $1 AND state = 'processing' AND claim_token = $2::uuid
  `, [row.id, claimToken, message.slice(0, 1024)]);
}

function reconciliationFailpoint(point: string): void {
  if (process.env.NODE_ENV === 'test'
    && process.env.RORCA_CLOSEOUT_RECONCILIATION_FAILPOINT === point) {
    throw new Error(`closeout_reconciliation_failpoint:${point}`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function persistAuthorizedInitialHostCloseout(
  row: ReconciliationRow,
  validation: Awaited<ReturnType<typeof revalidateAcceptedPreview>>,
): Promise<void> {
  const outputs = validation.observed.outputs;
  const hostRows = outputs.hostCloseouts as Array<Record<string, unknown>>;
  const terminalRows = outputs.terminalEvents as Array<Record<string, unknown>>;
  const release = outputs.releaseIntent as Record<string, unknown> | null;
  const observedTerminal = outputs.terminalCheckout as Record<string, unknown>;
  await transaction(async (client: PoolClient) => {
    const locked = (await client.query<Pick<RunRow,
      'status' | 'lifecycle_status' | 'summary' | 'lifecycle_diagnostics'
      | 'lifecycle_updated_at' | 'lifecycle_updated_at_exact'
      | 'finished_at' | 'finished_at_exact' | 'terminal_checkout_sha'
      | 'terminal_checkout_attested_at' | 'host_closeout_event_id'>>(`
      SELECT status, lifecycle_status, summary, lifecycle_diagnostics,
             lifecycle_updated_at,
             to_char(lifecycle_updated_at AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS lifecycle_updated_at_exact,
             finished_at,
             to_char(finished_at AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS finished_at_exact,
             terminal_checkout_sha, terminal_checkout_attested_at,
             host_closeout_event_id
        FROM pipeline_runs
       WHERE id = $1 AND workspace_id = $2
       FOR UPDATE
    `, [Number(row.run_id), row.workspace_id])).rows[0];
    if (!locked) {
      throw new CloseoutReconciliationBlockedError(
        'RUN_AUTHORITY_MISSING',
        'Exact run disappeared before host closeout publication',
      );
    }
    assertProtocolOwnedProjectionProgress(
      validation.preview.target.originalProjection,
      {
        status: locked.status,
        lifecycleStatus: locked.lifecycle_status,
        summary: locked.summary,
        lifecycleDiagnostics: jsonRecord(locked.lifecycle_diagnostics),
        lifecycleUpdatedAt: storedProjectionTimestamp(
          locked.lifecycle_updated_at_exact,
          locked.lifecycle_updated_at,
          'locked lifecycle_updated_at',
        ),
        finishedAt: storedProjectionTimestamp(
          locked.finished_at_exact,
          locked.finished_at,
          'locked finished_at',
        ),
      },
      {
        hostCloseoutCount: hostRows.length,
        releaseStatus: release === null ? null : String(release.status),
        terminalEventCount: terminalRows.length,
      },
    );
    if ((locked.terminal_checkout_sha?.toLowerCase() ?? null) !== observedTerminal.sha
      || iso(locked.terminal_checkout_attested_at, 'locked terminal_checkout_attested_at') !== observedTerminal.attestedAt
      || (locked.host_closeout_event_id == null ? null : Number(locked.host_closeout_event_id)) !== outputs.hostCloseoutPointer) {
      throw new CloseoutReconciliationBlockedError(
        'PARTIAL_AUTHORITY_INVALID',
        'Terminal or host-closeout authority changed before locked publication',
      );
    }
    if (hostRows.length === 1) return; // Exact replay: no new host authority is published.
    if (hostRows.length !== 0 || release !== null || terminalRows.length !== 0
      || locked.terminal_checkout_sha !== null
      || locked.terminal_checkout_attested_at !== null
      || locked.host_closeout_event_id !== null) {
      throw new CloseoutReconciliationBlockedError(
        'PARTIAL_AUTHORITY_INVALID',
        'Unexpected partial authority appeared before first host closeout',
      );
    }
    const prepared = await prepareHostRunCloseout({ runId: Number(row.run_id), status: 'done' });
    await insertPreparedHostRunCloseout(client, prepared);
  });
}

export interface CloseoutOnlySequenceActions<TValidation, TResult> {
  revalidate(): Promise<TValidation>;
  hostAuthority(validation: TValidation): RunHostAuthority;
  persistHostCloseout(validation: TValidation): Promise<void>;
  prepareBranchOnlyRelease(authority: RunHostAuthority): Promise<void>;
  reconcileBranchOnlyRelease(): Promise<{ status: 'completed' | 'blocked'; error?: string }>;
  finalize(validation: TValidation): Promise<TResult>;
  failpoint?(point: 'before_host_closeout' | 'after_host_closeout' | 'after_release_intent' | 'after_release_reconciliation'): void;
}

/**
 * Pure closeout-only ordering seam used by the worker and crash-boundary tests.
 * Every durable action is idempotent; revalidation occurs before each new
 * authority boundary and no execution/model/learn/provider option is accepted.
 */
export async function executeCloseoutOnlySequence<TValidation, TResult>(
  actions: CloseoutOnlySequenceActions<TValidation, TResult>,
): Promise<TResult> {
  let validation = await actions.revalidate();
  actions.failpoint?.('before_host_closeout');
  await actions.persistHostCloseout(validation);
  actions.failpoint?.('after_host_closeout');

  validation = await actions.revalidate();
  await actions.prepareBranchOnlyRelease(actions.hostAuthority(validation));
  actions.failpoint?.('after_release_intent');

  validation = await actions.revalidate();
  const release = await actions.reconcileBranchOnlyRelease();
  if (release.status !== 'completed') {
    throw new CloseoutReconciliationBlockedError(
      'RELEASE_RECONCILIATION_BLOCKED',
      release.error ?? 'Exact branch-only release reconciliation was blocked',
    );
  }
  actions.failpoint?.('after_release_reconciliation');
  return actions.finalize(validation);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function finalizeReconciliation(
  row: ReconciliationRow,
  claimToken: string,
  preview: CloseoutReconciliationPreview,
): Promise<string> {
  const observed = await revalidateAcceptedPreview(row);
  const outputs = observed.observed.outputs;
  const release = outputs.releaseIntent as Record<string, unknown> | null;
  const hostCloseouts = outputs.hostCloseouts as Array<Record<string, unknown>>;
  const terminals = outputs.terminalEvents as Array<Record<string, unknown>>;
  if (!release || release.status !== 'completed' || hostCloseouts.length !== 1
    || terminals.length !== 1 || observed.observed.run.status !== 'done'
    || observed.observed.run.lifecycle_status !== 'finished') {
    throw new CloseoutReconciliationBlockedError('RELEASE_NOT_COMPLETE', 'Exact branch-only release closeout is not complete');
  }
  const acceptedOriginal = parseProjectionSnapshot(
    preview.target.originalProjection,
    'Accepted',
  );
  const reconciliationClock = await queryOne<{ now_exact: string }>(
    `SELECT to_char(statement_timestamp() AT TIME ZONE 'UTC',
       'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now_exact`,
  );
  const reconciledAt = String(reconciliationClock?.now_exact ?? '');
  if (!EXACT_UTC_TIMESTAMP.test(reconciledAt)) {
    throw new ServiceUnavailableError('Database reconciliation clock is unavailable');
  }
  const afterProjection = {
    schemaVersion: CLOSEOUT_RECONCILIATION_RESULT_VERSION,
    runId: Number(row.run_id), workspaceId: row.workspace_id,
    status: 'done', lifecycleStatus: 'finished', summary: 'host_closeout_reconciled',
    finishedAtPreserved: acceptedOriginal.finishedAt,
    reconciledAt,
    terminalCheckout: outputs.terminalCheckout,
    hostCloseout: hostCloseouts[0],
    releaseIntent: release,
    terminalEvent: terminals[0],
  };
  const resultReceiptHash = retryHash({
    schemaVersion: CLOSEOUT_RECONCILIATION_RESULT_VERSION,
    reconciliationId: row.id,
    requestHash: row.request_hash,
    previewHash: row.preview_hash,
    ownerReceiptId: row.owner_receipt_id,
    afterProjection,
  });
  const diagnostic = {
    requestId: row.id,
    authorityHash: row.immutable_authority_hash,
    ownerReceiptId: row.owner_receipt_id,
    originalStatus: preview.target.originalProjection.status,
    originalLifecycleStatus: preview.target.originalProjection.lifecycleStatus,
    originalSummary: acceptedOriginal.summary,
    originalFinishedAt: acceptedOriginal.finishedAt,
    originalLifecycleUpdatedAt: acceptedOriginal.lifecycleUpdatedAt,
    originalLifecycleDiagnostics: acceptedOriginal.lifecycleDiagnostics,
    fixedBuildSha: row.build_sha,
    buildReceiptHash: row.build_receipt_hash,
    requiredFixSha: row.required_fix_sha,
    reconciledAt,
    resultReceiptHash,
  };
  await transaction(async (client: PoolClient) => {
    const locked = (await client.query<ReconciliationRow>(
      'SELECT * FROM pipeline_run_closeout_reconciliations WHERE id = $1 FOR UPDATE', [row.id],
    )).rows[0];
    if (!locked || locked.state !== 'processing' || locked.claim_token !== claimToken) {
      throw new ConflictError('Closeout reconciliation completion lost its exact claim');
    }
    const run = await client.query(`
      UPDATE pipeline_runs
         SET status = 'done', lifecycle_status = 'finished',
             summary = 'host_closeout_reconciled', lifecycle_updated_at = $3,
             lifecycle_diagnostics = COALESCE(lifecycle_diagnostics, '{}'::jsonb)
               || jsonb_build_object('closeoutReconciliation', $4::jsonb),
             pid = NULL, opencode_server_pid = NULL, worker_id = NULL,
             dispatch_owner = NULL, dispatch_lease_expires_at = NULL,
             queue_position = NULL
       WHERE id = $1 AND workspace_id = $2
         AND status = 'done' AND lifecycle_status = 'finished'
         AND summary IS NOT DISTINCT FROM $5
         AND finished_at IS NOT DISTINCT FROM $6::timestamptz
         AND lifecycle_updated_at IS NOT DISTINCT FROM $7::timestamptz
         AND lifecycle_diagnostics = $8::jsonb
       RETURNING id
    `, [
      Number(row.run_id), row.workspace_id, reconciledAt, JSON.stringify(diagnostic),
      acceptedOriginal.summary, acceptedOriginal.finishedAt,
      acceptedOriginal.lifecycleUpdatedAt, JSON.stringify(acceptedOriginal.lifecycleDiagnostics),
    ]);
    if (run.rowCount !== 1) throw new ConflictError('Truthful lifecycle correction did not bind the completed exact run');
    const completed = await client.query(`
      UPDATE pipeline_run_closeout_reconciliations
         SET state = 'completed', claim_token = NULL, claim_expires_at = NULL,
             after_projection = $3::jsonb, reconciled_at = $4,
             result_receipt_hash = $5, last_error_code = NULL,
             last_error_message = NULL, updated_at = NOW()
       WHERE id = $1 AND state = 'processing' AND claim_token = $2::uuid
       RETURNING id
    `, [row.id, claimToken, JSON.stringify(afterProjection), reconciledAt, resultReceiptHash]);
    if (completed.rowCount !== 1) throw new ConflictError('Closeout reconciliation result receipt was not committed');
  });
  return resultReceiptHash;
}

export async function processCloseoutReconciliationJob(input: {
  jobId: string;
  data: unknown;
  hasActiveInMemoryProcess?: (runId: number) => boolean;
}): Promise<{ state: 'completed' | 'blocked' | 'noop'; resultReceiptHash?: string }> {
  const parsed = CloseoutReconciliationJobPayloadSchema.safeParse(input.data);
  if (!parsed.success) {
    throw new CloseoutReconciliationBlockedError('JOB_PAYLOAD_INVALID', parsed.error.message);
  }
  const payload = parsed.data;
  // Permanent selector denial remains before every read and lock.
  requireWave1ReconciliationSelector(payload.runId);
  try {
    return await withPgAdvisoryLock(`pipeline-run-authority:${payload.runId}`, async () =>
      transaction(async (client: PoolClient) => {
        // Canonical lock order: run -> reconciliation -> cancellation/retry ->
        // story/closeout evidence. Reconciliation takes exactly one advisory
        // fence and never enters ordinary release authority.
        const runLock = await client.query(
          'SELECT id FROM pipeline_runs WHERE id = $1 AND workspace_id = $2 FOR UPDATE',
          [payload.runId, payload.workspaceId],
        );
        if (runLock.rowCount !== 1) {
          throw new CloseoutReconciliationBlockedError('RUN_AUTHORITY_MISSING', 'Exact reconciliation run/workspace authority is absent');
        }
        const row = (await client.query<ReconciliationRow>(
          'SELECT * FROM pipeline_run_closeout_reconciliations WHERE id = $1 FOR UPDATE',
          [payload.reconciliationId],
        )).rows[0];
        if (!row) throw new CloseoutReconciliationBlockedError('REQUEST_MISSING', 'Closeout reconciliation application authority is absent');
        if (row.state === 'completed') return { state: 'noop' as const, resultReceiptHash: row.result_receipt_hash ?? undefined };
        if (row.state === 'blocked') return { state: 'noop' as const };
        if (row.boss_job_id !== input.jobId || retryHash(payload) !== row.job_payload_hash
          || Number(row.run_id) !== payload.runId || row.workspace_id !== payload.workspaceId
          || row.preview_hash !== payload.previewHash
          || row.transport_generation !== payload.transportGeneration) {
          throw new CloseoutReconciliationBlockedError('JOB_IDENTITY_MISMATCH', 'Transport delivery differs from application-owned closeout authority');
        }
        const clock = (await client.query<{ now_exact: string; unexpired: boolean }>(`
          SELECT to_char(statement_timestamp() AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now_exact,
                 $1::timestamptz > statement_timestamp() AS unexpired
        `, [row.preview_expires_at])).rows[0];
        if (!clock?.unexpired) {
          throw new CloseoutReconciliationBlockedError('EVIDENCE_EXPIRED', 'Accepted closeout evidence expired at database time');
        }
        if (input.hasActiveInMemoryProcess?.(payload.runId)) {
          throw new CloseoutReconciliationBlockedError('ACTIVE_IN_MEMORY_ENGINE', 'Worker still owns an in-memory execution process for this run');
        }
        const cancellation = await client.query(
          'SELECT run_id FROM pipeline_run_cancellation_requests WHERE run_id = $1 FOR UPDATE',
          [payload.runId],
        );
        const retries = await client.query(`
          SELECT identity_hash FROM governed_retry_dispatches
           WHERE original_run_id = $1 OR retry_run_id = $1 FOR UPDATE
        `, [payload.runId]);
        const retryChildren = await client.query(
          'SELECT id FROM pipeline_runs WHERE retried_from_run_id = $1 FOR UPDATE',
          [payload.runId],
        );
        if (cancellation.rowCount !== 0 || retries.rowCount !== 0 || retryChildren.rowCount !== 0) {
          throw new CloseoutReconciliationBlockedError('CONCURRENT_RUN_AUTHORITY', 'Cancellation or retry authority fences reconciliation');
        }

        const preview = parseStoredPreview(row);
        const observed = await observeAuthority({
          runId: payload.runId,
          workspaceId: payload.workspaceId,
          ownBossJobId: row.boss_job_id,
        });
        assertInitialProjection(observed.run, observed.outputs);
        const acceptedSoftware = preview.target.immutableAuthority.software as unknown as CloseoutReconciliationBuildIdentity;
        const workerSoftware = observed.immutableAuthority.software as unknown as CloseoutReconciliationBuildIdentity;
        if (row.required_fix_sha !== REQUIRED_CLOSEOUT_TIMESTAMP_FIX_SHA
          || acceptedSoftware.buildSha !== row.build_sha
          || acceptedSoftware.buildReceiptHash !== row.build_receipt_hash
          || !sameCloseoutReconciliationBuildIdentity(acceptedSoftware, workerSoftware)
          || retryHash(observed.immutableAuthority) !== row.immutable_authority_hash) {
          throw new CloseoutReconciliationBlockedError('IMMUTABLE_AUTHORITY_DRIFT', 'Build, run evidence, Git, spec, or dispatch authority changed');
        }
        await assertOwnedProgress(row, preview, observed);
        reconciliationFailpoint('before_host_closeout');

        const reconciledAt = clock.now_exact;
        const acceptedOriginal = parseProjectionSnapshot(preview.target.originalProjection, 'Accepted');
        const eventPayload = {
          schemaVersion: 'rorca.run-closeout-reconciled-event.v1',
          source: 'closeout_reconciliation',
          reconciliationId: row.id,
          runId: payload.runId,
          workspaceId: payload.workspaceId,
          specId: preview.target.specId,
          immutableAuthorityHash: row.immutable_authority_hash,
          ownerReceiptId: row.owner_receipt_id,
          originalProjection: preview.target.originalProjection,
          targetProjection: { status: 'done', lifecycleStatus: 'finished', summary: 'host_closeout_reconciled' },
          reconciledAt,
        };
        const event = (await client.query<{ id: string }>(`
          INSERT INTO pipeline_run_closeout_reconciliation_events (
            reconciliation_id, run_id, workspace_id, event_type, source,
            immutable_authority_hash, payload, occurred_at
          ) VALUES ($1,$2,$3,'run_closeout_reconciled','closeout_reconciliation',$4,$5::jsonb,$6)
          RETURNING id
        `, [row.id, payload.runId, payload.workspaceId, row.immutable_authority_hash,
          JSON.stringify(eventPayload), reconciledAt])).rows[0];
        if (!event) throw new ConflictError('Dedicated reconciliation evidence event was not persisted');
        reconciliationFailpoint('after_host_closeout');

        const afterProjection = {
          schemaVersion: CLOSEOUT_RECONCILIATION_RESULT_VERSION,
          source: 'closeout_reconciliation',
          reconciliationEventId: event.id,
          runId: payload.runId,
          workspaceId: payload.workspaceId,
          status: 'done',
          lifecycleStatus: 'finished',
          summary: 'host_closeout_reconciled',
          finishedAtPreserved: acceptedOriginal.finishedAt,
          reconciledAt,
        };
        const resultReceiptHash = retryHash({
          schemaVersion: CLOSEOUT_RECONCILIATION_RESULT_VERSION,
          reconciliationId: row.id,
          requestHash: row.request_hash,
          previewHash: row.preview_hash,
          ownerReceiptId: row.owner_receipt_id,
          afterProjection,
        });
        const diagnostic = {
          source: 'closeout_reconciliation',
          reconciliationId: row.id,
          reconciliationEventId: event.id,
          immutableAuthorityHash: row.immutable_authority_hash,
          ownerReceiptId: row.owner_receipt_id,
          originalProjection: preview.target.originalProjection,
          fixedBuildSha: row.build_sha,
          buildReceiptHash: row.build_receipt_hash,
          requiredFixSha: row.required_fix_sha,
          reconciledAt,
          resultReceiptHash,
        };
        const updatedRun = await client.query(`
          UPDATE pipeline_runs
             SET status = 'done', lifecycle_status = 'finished',
                 summary = 'host_closeout_reconciled', lifecycle_updated_at = $3,
                 lifecycle_diagnostics = COALESCE(lifecycle_diagnostics, '{}'::jsonb)
                   || jsonb_build_object('closeoutReconciliation', $4::jsonb),
                 terminal_checkout_sha = $5,
                 terminal_checkout_attested_at = $3,
                 pid = NULL, opencode_server_pid = NULL, worker_id = NULL,
                 dispatch_owner = NULL, dispatch_lease_expires_at = NULL,
                 queue_position = NULL
           WHERE id = $1 AND workspace_id = $2
             AND status = 'failed' AND lifecycle_status = 'failed'
             AND summary IS NOT DISTINCT FROM $6
             AND finished_at IS NOT DISTINCT FROM $7::timestamptz
             AND lifecycle_updated_at IS NOT DISTINCT FROM $8::timestamptz
             AND lifecycle_diagnostics = $9::jsonb
           RETURNING id
        `, [payload.runId, payload.workspaceId, reconciledAt, JSON.stringify(diagnostic),
          observed.hostAuthority.terminalRevision, acceptedOriginal.summary,
          acceptedOriginal.finishedAt, acceptedOriginal.lifecycleUpdatedAt,
          JSON.stringify(acceptedOriginal.lifecycleDiagnostics)]);
        if (updatedRun.rowCount !== 1) throw new ConflictError('Atomic reconciliation lost the exact original run projection');
        reconciliationFailpoint('after_release_intent');

        const completed = await client.query(`
          UPDATE pipeline_run_closeout_reconciliations
             SET state = 'completed', attempt_count = attempt_count + 1,
                 claim_token = NULL, claim_expires_at = NULL,
                 reconciliation_event_id = $2, after_projection = $3::jsonb,
                 reconciled_at = $4, result_receipt_hash = $5,
                 last_error_code = NULL, last_error_message = NULL,
                 updated_at = statement_timestamp()
           WHERE id = $1 AND state IN ('prepared','queued')
           RETURNING id
        `, [row.id, event.id, JSON.stringify(afterProjection), reconciledAt, resultReceiptHash]);
        if (completed.rowCount !== 1) throw new ConflictError('Atomic reconciliation result receipt was not committed');
        reconciliationFailpoint('after_release_reconciliation');
        return { state: 'completed' as const, resultReceiptHash };
      }),
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('closeout_reconciliation_failpoint:')) {
      await execute(`
        UPDATE pipeline_run_closeout_reconciliations
           SET state = 'queued', claim_token = NULL, claim_expires_at = NULL,
               last_error_code = 'TRANSACTION_ROLLED_BACK',
               last_error_message = $2, updated_at = statement_timestamp()
         WHERE id = $1 AND state IN ('prepared','queued')
      `, [payload.reconciliationId, error.message.slice(0, 1024)]);
      throw error;
    }
    if (error instanceof CloseoutReconciliationBlockedError
      && ['JOB_IDENTITY_MISMATCH', 'REQUEST_MISSING'].includes(error.reasonCode)) {
      // A stale/forged transport delivery has no authority to terminalize the
      // canonical application request. Leave it recoverable and fail the job.
      throw error;
    }
    if (error instanceof CloseoutReconciliationBlockedError
      || error instanceof ConflictError
      || error instanceof ForbiddenError
      || error instanceof UnprocessableError) {
      const reasonCode = error instanceof CloseoutReconciliationBlockedError
        ? error.reasonCode : 'AUTHORITY_CONFLICT';
      await execute(`
        UPDATE pipeline_run_closeout_reconciliations
           SET state = 'blocked', claim_token = NULL, claim_expires_at = NULL,
               last_error_code = $2, last_error_message = $3,
               updated_at = statement_timestamp()
         WHERE id = $1 AND state IN ('prepared','queued')
      `, [payload.reconciliationId, reasonCode.slice(0, 96), error.message.slice(0, 1024)]);
      return { state: 'blocked' };
    }
    await execute(`
      UPDATE pipeline_run_closeout_reconciliations
         SET state = 'queued', claim_token = NULL, claim_expires_at = NULL,
             last_error_code = 'TRANSIENT_PROCESSING_ERROR',
             last_error_message = $2, updated_at = statement_timestamp()
       WHERE id = $1 AND state IN ('prepared','queued')
    `, [payload.reconciliationId, (error instanceof Error ? error.message : String(error)).slice(0, 1024)]);
    throw error;
  }
}

export async function recoverPendingCloseoutReconciliationPublications(limit = 100): Promise<{
  scanned: number;
  published: number;
  blocked: number;
  failed: number;
}> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new RangeError('Closeout reconciliation recovery limit must be between 1 and 500');
  }
  // This scans only already-authorized application rows. It never discovers
  // failed runs, workspaces, or Genesis by run state.
  const rows = await query<{ id: string; state: string; preview_expires_at: Date | string; expired: boolean }>(`
    SELECT id, state, preview_expires_at,
           preview_expires_at <= statement_timestamp() AS expired
      FROM pipeline_run_closeout_reconciliations
     WHERE run_id = $2
       AND run_id <> $3
       AND (
         state IN ('prepared','queued')
         OR (state = 'processing' AND claim_expires_at <= NOW())
       )
     ORDER BY updated_at ASC, id ASC
     LIMIT $1
  `, [limit, WAVE_1_MANAGED_PROOF_RUN_ID, WAVE_1_PROTECTED_GENESIS_RUN_ID]);
  const result = { scanned: rows.length, published: 0, blocked: 0, failed: 0 };
  for (const candidate of rows) {
    try {
      requireWave1ReconciliationSelector(WAVE_1_MANAGED_PROOF_RUN_ID);
      if (candidate.expired) {
        await execute(`
          UPDATE pipeline_run_closeout_reconciliations
             SET state = 'blocked', claim_token = NULL, claim_expires_at = NULL,
                 last_error_code = 'EVIDENCE_EXPIRED',
                 last_error_message = 'Authorized host evidence expired before transport recovery',
                 updated_at = NOW()
           WHERE id = $1 AND state IN ('prepared','queued','processing')
        `, [candidate.id]);
        result.blocked += 1;
        continue;
      }
      if (candidate.state === 'processing') {
        await execute(`
          UPDATE pipeline_run_closeout_reconciliations
             SET state = 'queued', claim_token = NULL, claim_expires_at = NULL,
                 last_error_code = 'STALE_WORKER_CLAIM_RECOVERED',
                 last_error_message = 'Expired closeout worker claim returned to exact transport recovery',
                 updated_at = NOW()
           WHERE id = $1 AND state = 'processing' AND claim_expires_at <= NOW()
        `, [candidate.id]);
      }
      await publishCloseoutReconciliation(candidate.id, WAVE_1_MANAGED_PROOF_RUN_ID);
      result.published += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

/** Contract-test helper: canonical payload identity is stable and contains no execution options. */
export function closeoutReconciliationJobPayloadForTests(input: {
  reconciliationId: string;
  runId: number;
  workspaceId: string;
  previewHash: string;
  transportGeneration?: number;
}): CloseoutReconciliationJobPayload {
  return CloseoutReconciliationJobPayloadSchema.parse({
    schemaVersion: CLOSEOUT_RECONCILIATION_JOB_VERSION,
    ...input,
    transportGeneration: input.transportGeneration ?? 1,
  });
}

/** Contract-test helper: exact normalized request identity. */
export function closeoutReconciliationRequestHashForTests(input: {
  runId: number;
  workspaceId: string;
  previewHash: string;
  rationale: string;
  requesterActorId: string;
  ownerAuthorization: ProviderHumanEvent;
}): string {
  return requestHash(input);
}

/** Keep stable JSON semantics explicit for source/security contract tests. */
export function closeoutReconciliationStablePreviewForTests(preview: CloseoutReconciliationPreview): string {
  return stableWalJson(preview);
}
