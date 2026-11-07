/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Exact-revision historical delivery/assurance reconciliation. */
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { query, transaction } from '../db/index';
import { ConflictError, NotFoundError, UnprocessableError, ValidationError } from './errors';
import { normalizeSsdlcContractJson } from './ssdlc-contracts';
import { getLifecycleReconciliationSnapshot } from './ssdlc-lifecycle-read';
import { inspectApprovedSpecPasses } from './ssdlc-pass-reconciler';
import { deriveStoryContractRevision } from './story-execution-packet';
import { stableWalJson } from './trusted-wal';
import {
  digestLifecycleReconciliationState,
  loadLifecycleReconciliationWatermarks,
  type LifecycleReconciliationWatermarks,
} from './lifecycle-reconciliation-watermarks';

export const LIFECYCLE_RECONCILIATION_PREVIEW_VERSION = 'rorca.lifecycle-reconciliation-preview.v1' as const;
export const LIFECYCLE_RECONCILIATION_RECEIPT_VERSION = 'rorca.lifecycle-reconciliation-receipt.v1' as const;
const execFileAsync = promisify(execFile);
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SPEC_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LIFECYCLE_RECONCILIATION_MAX_SPEC_BYTES = 4 * 1024 * 1024;
const LIFECYCLE_RECONCILIATION_MAX_RUNS = 50;
const LIFECYCLE_RECONCILIATION_MAX_SPEC_VERSIONS = 100;
const LIFECYCLE_RECONCILIATION_MAX_STORIES = 2_000;
const TERMINAL_RUN_STATUS: Readonly<Partial<Record<string, true>>> = {
  done: true,
  failed: true,
  partial_failure: true,
  cancelled: true,
};

const SpecDocumentSchema = z.object({
  title: z.string().max(512).optional(),
  userStories: z.array(z.object({ id: z.string().max(128).optional(), passes: z.boolean().optional() }).passthrough())
    .max(LIFECYCLE_RECONCILIATION_MAX_STORIES).optional(),
  stories: z.array(z.object({ id: z.string().max(128).optional(), passes: z.boolean().optional() }).passthrough())
    .max(LIFECYCLE_RECONCILIATION_MAX_STORIES).optional(),
}).passthrough();

const AttestationSchema = z.object({
  deliveryOutcome: z.literal('completed'),
  rationale: z.string().trim().min(20).max(2000),
  evidenceReferences: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
}).strict();

export type DeliveryStatus = 'unknown' | 'in_progress' | 'failed' | 'completed' | 'operator_attested' | 'superseded';
export type AssuranceStatus = 'not_evaluated' | 'partial' | 'complete' | 'stale' | 'blocked';


interface WorkspaceRow {
  id: string;
  path: string;
}

interface RunRow {
  id: number;
  status: string;
  branch_name: string | null;
  merge_status: string | null;
  merge_commit_sha: string | null;
  terminal_checkout_sha: string | null;
  expected_story_ids: unknown;
  canonical_spec_revision: string | null;
  run_spec_path: string | null;
  run_spec_bytes_hash: string | null;
  execution_worktree_path: string | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  terminal_story_results: unknown;
}


interface ReceiptRow {
  id: string;
  workspace_id: string;
  spec_slug: string;
  spec_revision_hash: string;
  compiled_plan_id: string | null;
  preview_hash: string;
  reconciliation_watermarks: LifecycleReconciliationWatermarks;
  idempotency_key: string;
  request_hash: string;
  result_hash: string;
  delivery_status: DeliveryStatus;
  assurance_status: AssuranceStatus;
  story_summary: Record<string, unknown>;
  stage_evidence: unknown[];
  source_evidence: unknown[];
  unresolved_gaps: unknown[];
  operator_attestation: Record<string, unknown> | null;
  created_by: string;
  created_at: Date | string;
}

export interface LifecycleReconciliationPreview {
  schemaVersion: typeof LIFECYCLE_RECONCILIATION_PREVIEW_VERSION;
  workspaceId: string;
  specId: string;
  title: string;
  specRevisionHash: `sha256:${string}`;
  compiledPlanId: string | null;
  planState: string;
  watermarks: LifecycleReconciliationWatermarks;
  delivery: {
    status: DeliveryStatus;
    integratedRunId: number | null;
    integratedCommit: string | null;
    rationale: string;
  };
  assurance: {
    status: AssuranceStatus;
    controls: { total: number | null; passed: number | null };
    rationale: string;
  };
  stories: {
    total: number;
    reconciledPassed: number;
    ambiguous: number;
    invalid: number;
  };
  stages: Array<{
    stageId: string;
    label: string;
    status: 'unassessed' | 'passed' | 'partial' | 'blocked' | 'stale';
    phases: Array<{ phaseId: string; status: string; passed: number | null; required: number | null }>;
  }>;
  sourceEvidence: Array<Record<string, unknown>>;
  unresolvedGaps: Array<{ code: string; message: string; stageId?: string; storyId?: string }>;
  priorReceipt: { id: string; resultHash: string; createdAt: string; operatorAttested: boolean } | null;
  observedAt: string;
  previewHash: `sha256:${string}`;
}

export interface LifecycleReconciliationReceipt {
  schemaVersion: typeof LIFECYCLE_RECONCILIATION_RECEIPT_VERSION;
  id: string;
  workspaceId: string;
  specId: string;
  specRevisionHash: string;
  compiledPlanId: string | null;
  previewHash: string;
  resultHash: string;
  watermarks: LifecycleReconciliationWatermarks;
  deliveryStatus: DeliveryStatus;
  assuranceStatus: AssuranceStatus;
  storySummary: Record<string, unknown>;
  stageEvidence: unknown[];
  sourceEvidence: unknown[];
  unresolvedGaps: unknown[];
  operatorAttestation: Record<string, unknown> | null;
  createdBy: string;
  createdAt: string;
  replayed: boolean;
}

function digest(value: unknown): `sha256:${string}` {
  return digestLifecycleReconciliationState(value);
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function requireSpecSlug(value: string): string {
  const slug = value.trim();
  if (!SPEC_SLUG.test(slug)) throw new ValidationError('specId must be a canonical spec slug', { field: 'specId' });
  return slug;
}

async function loadWorkspace(workspaceId: string, client: PoolClient): Promise<WorkspaceRow> {
  const workspace = (await client.query(
    'SELECT id, path FROM workspaces WHERE id = $1',
    [workspaceId],
  )).rows[0] as WorkspaceRow | undefined;
  if (!workspace) throw new NotFoundError('Workspace', workspaceId);
  return workspace;
}

async function loadExactSpec(workspace: WorkspaceRow, specId: string): Promise<{
  path: string;
  content: z.infer<typeof SpecDocumentSchema>;
  hash: `sha256:${string}`;
}> {
  const approvedRoot = path.resolve(workspace.path, 'forge', 'specs', 'approved');
  const specPath = path.resolve(approvedRoot, `${specId}.json`);
  if (!specPath.startsWith(`${approvedRoot}${path.sep}`)) throw new ValidationError('specId escapes the approved spec directory');
  let bytes: string;
  try {
    const [realWorkspaceRoot, realApprovedRoot, realSpecPath] = await Promise.all([
      fs.realpath(workspace.path),
      fs.realpath(approvedRoot),
      fs.realpath(specPath),
    ]);
    if ((realApprovedRoot !== realWorkspaceRoot && !realApprovedRoot.startsWith(`${realWorkspaceRoot}${path.sep}`))
      || (realSpecPath !== realApprovedRoot && !realSpecPath.startsWith(`${realApprovedRoot}${path.sep}`))) {
      throw new UnprocessableError(
        'Approved spec does not resolve inside the selected workspace',
        'LIFECYCLE_RECONCILIATION_SPEC_PATH_INVALID',
        { specId, remediation: 'Replace the external spec link with canonical bytes inside the workspace approved directory.' },
      );
    }
    const stat = await fs.stat(specPath);
    if (!stat.isFile()) throw new NotFoundError('Approved spec', specId);
    if (stat.size > LIFECYCLE_RECONCILIATION_MAX_SPEC_BYTES) {
      throw new UnprocessableError(
        'Approved spec exceeds the lifecycle reconciliation read bound',
        'LIFECYCLE_RECONCILIATION_SPEC_TOO_LARGE',
        {
          specId,
          maximumBytes: LIFECYCLE_RECONCILIATION_MAX_SPEC_BYTES,
          remediation: 'Reduce the canonical approved spec below the maximum size, then retry reconciliation.',
        },
      );
    }
    bytes = await fs.readFile(specPath, 'utf8');
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof UnprocessableError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFoundError('Approved spec', specId);
    throw new UnprocessableError(
      'Approved spec could not be read safely',
      'LIFECYCLE_RECONCILIATION_SPEC_UNREADABLE',
      {
        specId,
        filesystemCode: (error as NodeJS.ErrnoException).code ?? 'UNKNOWN',
        remediation: 'Restore readable canonical spec bytes inside the workspace approved directory, then retry.',
      },
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bytes);
  } catch {
    throw new UnprocessableError(
      'Approved spec JSON is malformed',
      'LIFECYCLE_RECONCILIATION_SPEC_INVALID',
      { specId, remediation: 'Repair the approved spec JSON, then retry reconciliation.' },
    );
  }
  const parsed = SpecDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    throw new UnprocessableError(
      'Approved spec does not satisfy the reconciliation document contract',
      'LIFECYCLE_RECONCILIATION_SPEC_INVALID',
      {
        specId,
        invalidFields: parsed.error.issues.slice(0, 20).map((issue) => issue.path.join('.')),
        remediation: 'Repair the listed approved spec fields, then retry reconciliation.',
      },
    );
  }
  const content = parsed.data;
  const hash = `sha256:${crypto.createHash('sha256').update(normalizeSsdlcContractJson(content)).digest('hex')}` as const;
  return { path: specPath, content, hash };
}

async function loadRuns(workspaceId: string, specId: string, client: PoolClient): Promise<RunRow[]> {
  const rows = (await client.query(`
    SELECT pr.id, pr.status, pr.branch_name, pr.merge_status, pr.merge_commit_sha,
           pr.terminal_checkout_sha,
           (COALESCE(pr.expected_story_ids, '{}'::text[]))[1:$4] AS expected_story_ids,
           pr.canonical_spec_revision,
           pr.run_spec_path, pr.run_spec_bytes_hash, pr.execution_worktree_path,
           pr.started_at, pr.finished_at,
           COALESCE((
             SELECT jsonb_agg(
               jsonb_build_object('storyId', effective.story_id, 'status', effective.status)
               ORDER BY effective.story_id
             )
             FROM (
               SELECT DISTINCT ON (sr.story_id) sr.story_id, sr.status
               FROM story_results sr
               WHERE sr.run_id = pr.id
                 AND sr.story_id = ANY(COALESCE(pr.expected_story_ids, '{}'::text[]))
               ORDER BY sr.story_id, sr.id DESC
               LIMIT $4
             ) effective
           ), '[]'::jsonb) AS terminal_story_results
    FROM pipeline_runs pr
    WHERE pr.workspace_id = $1
      AND pr.spec_path = $2
    ORDER BY pr.id DESC
    LIMIT $3
  `, [
    workspaceId,
    `forge/specs/approved/${specId}.json`,
    LIFECYCLE_RECONCILIATION_MAX_RUNS + 1,
    LIFECYCLE_RECONCILIATION_MAX_STORIES + 1,
  ])).rows as RunRow[];
  if (rows.length > LIFECYCLE_RECONCILIATION_MAX_RUNS) {
    throw new ConflictError('Exact-spec run history exceeds the lifecycle reconciliation bound', {
      type: 'lifecycle_reconciliation_run_bound_exceeded',
      specId,
      maximumRuns: LIFECYCLE_RECONCILIATION_MAX_RUNS,
      remediation: 'Archive superseded run projections or reconcile an explicitly bounded historical run window before retrying.',
    });
  }
  return rows;
}


async function commitIsIntegrated(workspacePath: string, revision: string | null): Promise<boolean> {
  if (!revision || !/^[0-9a-f]{40,64}$/i.test(revision)) return false;
  try {
    await execFileAsync('git', ['merge-base', '--is-ancestor', revision, 'HEAD'], {
      cwd: workspacePath,
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

async function loadSpecVersionIdentities(
  workspaceId: string,
  specId: string,
  client: PoolClient,
): Promise<Map<string, HistoricalSpecIdentity | null>> {
  const totalRow = (await client.query(`
    SELECT COUNT(*)::text AS total
    FROM spec_versions
    WHERE workspace_id = $1 AND spec_slug = $2
  `, [workspaceId, specId])).rows[0] as { total?: number | string } | undefined;
  const total = Number(totalRow?.total ?? 0);
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new UnprocessableError(
      'Exact-spec version history count is malformed',
      'LIFECYCLE_RECONCILIATION_VERSION_COUNT_INVALID',
      { specId, remediation: 'Repair the spec version projection count without changing historical version rows.' },
    );
  }
  if (total > LIFECYCLE_RECONCILIATION_MAX_SPEC_VERSIONS) {
    throw new ConflictError('Exact-spec version history exceeds the lifecycle reconciliation bound', {
      type: 'lifecycle_reconciliation_spec_version_bound_exceeded',
      specId,
      maximumVersions: LIFECYCLE_RECONCILIATION_MAX_SPEC_VERSIONS,
      remediation: 'Materialize a content-hash identity index for older versions without modifying the historical version rows, then retry.',
    });
  }
  const rows = (await client.query(`
    SELECT content_json
    FROM spec_versions
    WHERE workspace_id = $1 AND spec_slug = $2
    ORDER BY version DESC
    LIMIT $3
  `, [workspaceId, specId, LIFECYCLE_RECONCILIATION_MAX_SPEC_VERSIONS])).rows as Array<{ content_json: unknown }>;
  const versions = new Map<string, HistoricalSpecIdentity | null>();
  for (const row of rows) {
    try {
      const raw = typeof row.content_json === 'string' ? JSON.parse(row.content_json) as unknown : row.content_json;
      const version = identity(SpecDocumentSchema.parse(raw));
      const existing = versions.get(version.canonicalHash);
      if (!versions.has(version.canonicalHash)) {
        versions.set(version.canonicalHash, version);
      } else if (!existing || existing.deliveryHash !== version.deliveryHash
        || !sameIds(existing.storyIds, version.storyIds)) {
        // Preserve both immutable rows in storage, but do not let a duplicated
        // canonical revision with contradictory delivery intent authorize.
        versions.set(version.canonicalHash, null);
      }
    } catch {
      // An invalid historical version cannot establish exact-revision authority.
    }
  }
  return versions;
}

interface HistoricalSpecIdentity {
  canonicalHash: string;
  deliveryHash: `sha256:${string}`;
  storyIds: string[];
}

function storyRecords(content: z.infer<typeof SpecDocumentSchema>): Array<Record<string, unknown>> {
  if (Array.isArray(content.userStories)) return content.userStories;
  if (Array.isArray(content.stories)) return content.stories;
  const phases = Array.isArray(content.phases) ? content.phases : [];
  return phases.flatMap((phase) => {
    if (!phase || typeof phase !== 'object' || Array.isArray(phase) || !('stories' in phase)) return [];
    return Array.isArray(phase.stories)
      ? phase.stories.filter((story: unknown): story is Record<string, unknown> =>
        Boolean(story) && typeof story === 'object' && !Array.isArray(story))
      : [];
  });
}

function specStoryIds(content: z.infer<typeof SpecDocumentSchema>): string[] {
  return [...new Set(storyRecords(content)
    .map((story) => typeof story.id === 'string' ? story.id.trim() : '')
    .filter(Boolean))]
    .sort();
}

/** Normalize only the two engine-owned pass projection fields; every authored assurance/delivery field stays material. */
function deliveryIdentityContent(content: z.infer<typeof SpecDocumentSchema>): Record<string, unknown> {
  const stripStory = (story: unknown): unknown => {
    if (!story || typeof story !== 'object' || Array.isArray(story)) return story;
    const intent: Record<string, unknown> = { ...story, passes: false };
    if (intent.notes === 'Completed by Rorca engine' || intent.notes === 'Completed by Rorca pass reconciler') {
      delete intent.notes;
    }
    return intent;
  };
  const canonical: Record<string, unknown> = JSON.parse(normalizeSsdlcContractJson(content));
  for (const key of ['userStories', 'stories'] as const) {
    if (Array.isArray(canonical[key])) canonical[key] = canonical[key].map(stripStory);
  }
  if (Array.isArray(canonical.phases)) {
    canonical.phases = canonical.phases.map((phase) => {
      if (!phase || typeof phase !== 'object' || Array.isArray(phase)) return phase;
      const projected: Record<string, unknown> = { ...phase };
      if (Array.isArray(projected.stories)) projected.stories = projected.stories.map(stripStory);
      return projected;
    });
  }
  return canonical;
}

function identity(content: z.infer<typeof SpecDocumentSchema>): HistoricalSpecIdentity {
  return {
    canonicalHash: deriveStoryContractRevision(content),
    deliveryHash: digest(deliveryIdentityContent(content)),
    storyIds: specStoryIds(content),
  };
}

async function snapshotSpecIdentity(run: RunRow): Promise<HistoricalSpecIdentity | null> {
  if (!run.run_spec_path || !run.execution_worktree_path || !SHA256.test(run.run_spec_bytes_hash ?? '')) return null;
  try {
    const [snapshotPath, worktreePath] = await Promise.all([
      fs.realpath(run.run_spec_path),
      fs.realpath(run.execution_worktree_path),
    ]);
    if (snapshotPath !== worktreePath && !snapshotPath.startsWith(`${worktreePath}${path.sep}`)) return null;
    const stat = await fs.stat(snapshotPath);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return null;
    const bytes = await fs.readFile(snapshotPath);
    const bytesHash = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
    if (bytesHash !== run.run_spec_bytes_hash) return null;
    return identity(SpecDocumentSchema.parse(JSON.parse(bytes.toString('utf8'))));
  } catch {
    return null;
  }
}

interface HistoricalSpecResolution {
  identity: HistoricalSpecIdentity | null;
  source: 'terminal_commit' | 'verified_run_snapshot' | 'spec_version_ledger' | null;
  conflict: string | null;
}

async function historicalSpecIdentity(
  workspacePath: string,
  revision: string | null,
  specId: string,
  run: RunRow,
  versionIdentities: Map<string, HistoricalSpecIdentity | null>,
): Promise<HistoricalSpecResolution> {
  const canonicalRevision = run.canonical_spec_revision;
  if (!canonicalRevision || !SHA256.test(canonicalRevision)) {
    return { identity: null, source: null, conflict: 'Run canonical spec revision is missing or malformed.' };
  }
  if (revision && /^[0-9a-f]{40,64}$/i.test(revision)) {
    const objectRef = `${revision}:forge/specs/approved/${specId}.json`;
    let committedObjectSize: number | null = null;
    try {
      const result = await execFileAsync(
        'git',
        ['cat-file', '-s', objectRef],
        { cwd: workspacePath, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 },
      );
      committedObjectSize = Number(result.stdout.trim());
    } catch {
      // A missing commit/path permits the verified immutable launch snapshot.
    }
    if (committedObjectSize !== null) {
      if (!Number.isSafeInteger(committedObjectSize) || committedObjectSize < 0
        || committedObjectSize > LIFECYCLE_RECONCILIATION_MAX_SPEC_BYTES) {
        return {
          identity: null,
          source: 'terminal_commit',
          conflict: 'Terminal commit spec exceeds the reconciliation read bound.',
        };
      }
      let committedBytes: string;
      try {
        const result = await execFileAsync(
          'git',
          ['show', objectRef],
          {
            cwd: workspacePath,
            encoding: 'utf8',
            timeout: 10_000,
            maxBuffer: LIFECYCLE_RECONCILIATION_MAX_SPEC_BYTES,
          },
        );
        committedBytes = result.stdout;
      } catch {
        return {
          identity: null,
          source: 'terminal_commit',
          conflict: 'Terminal commit spec exists but could not be read safely.',
        };
      }
      let committed: HistoricalSpecIdentity;
      try {
        committed = identity(SpecDocumentSchema.parse(JSON.parse(committedBytes)));
      } catch {
        return {
          identity: null,
          source: 'terminal_commit',
          conflict: 'Terminal commit spec is malformed or exceeds the reconciliation contract.',
        };
      }
      if (committed.canonicalHash !== canonicalRevision) {
        return {
          identity: null,
          source: 'terminal_commit',
          conflict: 'Terminal commit spec contradicts the run canonical spec revision.',
        };
      }
      return { identity: committed, source: 'terminal_commit', conflict: null };
    }
  }
  const hasDeclaredSnapshot = Boolean(run.run_spec_path || run.execution_worktree_path || run.run_spec_bytes_hash);
  const snapshot = await snapshotSpecIdentity(run);
  if (snapshot) {
    if (snapshot.canonicalHash !== canonicalRevision) {
      return {
        identity: null,
        source: 'verified_run_snapshot',
        conflict: 'Verified run snapshot contradicts the run canonical spec revision.',
      };
    }
    return { identity: snapshot, source: 'verified_run_snapshot', conflict: null };
  }
  if (hasDeclaredSnapshot) {
    return {
      identity: null,
      source: 'verified_run_snapshot',
      conflict: 'Declared run snapshot is malformed, out of bounds, outside its worktree, or fails its bytes hash.',
    };
  }
  if (!versionIdentities.has(canonicalRevision)) {
    return { identity: null, source: null, conflict: 'No immutable historical spec source matches the run revision.' };
  }
  const ledgerIdentity = versionIdentities.get(canonicalRevision) ?? null;
  return ledgerIdentity
    ? { identity: ledgerIdentity, source: 'spec_version_ledger', conflict: null }
    : {
      identity: null,
      source: 'spec_version_ledger',
      conflict: 'Duplicate historical spec rows contradict one another for the run revision.',
    };
}

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}


interface TerminalStoryResult {
  storyId: string;
  status: string;
}

function parseTerminalStoryResults(value: unknown): TerminalStoryResult[] {
  let raw = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const storyId = 'storyId' in item && typeof item.storyId === 'string' ? item.storyId.trim() : '';
    const status = 'status' in item && typeof item.status === 'string' ? item.status : '';
    return storyId && status ? [{ storyId, status }] : [];
  });
}
async function runEvidence(
  workspacePath: string,
  runs: RunRow[],
  specId: string,
  currentSpec: HistoricalSpecIdentity,
  versionIdentities: Map<string, HistoricalSpecIdentity | null>,
): Promise<Array<Record<string, unknown>>> {
  return Promise.all(runs.map(async (run) => {
    const candidateRevision = run.terminal_checkout_sha ?? run.merge_commit_sha;
    const integrated = run.merge_status === 'merged'
      || await commitIsIntegrated(workspacePath, candidateRevision);
    const rawExpectedStoryIds = Array.isArray(run.expected_story_ids) ? run.expected_story_ids : [];
    const expectedScopeBounded = rawExpectedStoryIds.length <= LIFECYCLE_RECONCILIATION_MAX_STORIES;
    const normalizedExpectedStoryIds = rawExpectedStoryIds
      .slice(0, LIFECYCLE_RECONCILIATION_MAX_STORIES)
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter((value) => value.length > 0 && value.length <= 128);
    const expectedStoryIds = [...new Set(normalizedExpectedStoryIds)].sort();
    const expectedScopeValid = expectedScopeBounded
      && rawExpectedStoryIds.length === expectedStoryIds.length
      && normalizedExpectedStoryIds.length === expectedStoryIds.length;
    const expectedStorySet = new Set(expectedStoryIds);
    const parsedTerminalStoryResults = parseTerminalStoryResults(run.terminal_story_results);
    const terminalResultsBounded = parsedTerminalStoryResults.length <= LIFECYCLE_RECONCILIATION_MAX_STORIES;
    const effectiveStoryResults = parsedTerminalStoryResults
      .slice(0, LIFECYCLE_RECONCILIATION_MAX_STORIES)
      .filter((result) => expectedStorySet.has(result.storyId));
    const effectiveStoryIds = effectiveStoryResults.map((result) => result.storyId).sort();
    const oneResultPerExpectedStory = effectiveStoryResults.length === expectedStoryIds.length
      && new Set(effectiveStoryIds).size === expectedStoryIds.length
      && sameIds([...new Set(effectiveStoryIds)].sort(), expectedStoryIds);
    const storyResultsComplete = expectedScopeValid
      && terminalResultsBounded
      && expectedStoryIds.length > 0
      && oneResultPerExpectedStory
      && effectiveStoryResults.every((result) => result.status === 'pass');
    const historicalResolution = await historicalSpecIdentity(
      workspacePath,
      candidateRevision,
      specId,
      run,
      versionIdentities,
    );
    const historicalSpec = historicalResolution.identity;
    const sameStorySet = expectedScopeValid && sameIds(expectedStoryIds, currentSpec.storyIds);
    const exactSpecRevision = sameStorySet
      && historicalSpec !== null
      && historicalSpec.deliveryHash === currentSpec.deliveryHash
      && sameIds(historicalSpec.storyIds, currentSpec.storyIds);
    return {
      kind: 'pipeline_run',
      runId: run.id,
      status: run.status,
      branchName: run.branch_name,
      mergeStatus: run.merge_status,
      commitSha: candidateRevision,
      integrated,
      exactSpecRevision,
      canonicalSpecRevision: run.canonical_spec_revision,
      observedSpecRevision: historicalSpec?.canonicalHash ?? null,
      observedDeliveryIdentityHash: historicalSpec?.deliveryHash ?? null,
      specIdentitySource: historicalResolution.source,
      specIdentityConflict: historicalResolution.conflict,
      expectedStoryIds,
      expectedStoryCount: expectedStoryIds.length,
      storyScopeValid: expectedScopeValid && terminalResultsBounded,
      storyScopeMaximum: LIFECYCLE_RECONCILIATION_MAX_STORIES,
      terminalStoryResults: effectiveStoryResults,
      passedStoryCount: effectiveStoryResults.filter((result) => result.status === 'pass').length,
      failedStoryCount: effectiveStoryResults.filter((result) => result.status !== 'pass').length,
      storyResultsComplete,
      terminal: TERMINAL_RUN_STATUS[run.status] === true,
      startedAt: run.started_at ? iso(run.started_at) : null,
      finishedAt: run.finished_at ? iso(run.finished_at) : null,
    };
  }));
}

async function latestReceipt(
  workspaceId: string,
  specId: string,
  specRevisionHash: string,
  client: PoolClient,
): Promise<ReceiptRow | undefined> {
  return (await client.query(`
    SELECT id, workspace_id, spec_slug, spec_revision_hash, compiled_plan_id::text,
           preview_hash, reconciliation_watermarks, idempotency_key, request_hash, result_hash, delivery_status,
           assurance_status, story_summary, stage_evidence, source_evidence,
           unresolved_gaps, operator_attestation, created_by, created_at
    FROM ssdlc_reconciliation_receipts
    WHERE workspace_id = $1 AND spec_slug = $2 AND spec_revision_hash = $3
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `, [workspaceId, specId, specRevisionHash])).rows[0] as ReceiptRow | undefined;
}

async function latestEffectiveAttestation(
  workspaceId: string,
  specId: string,
  specRevisionHash: string,
  client: PoolClient,
): Promise<ReceiptRow | undefined> {
  return (await client.query(`
    SELECT id, workspace_id, spec_slug, spec_revision_hash, compiled_plan_id::text,
           preview_hash, reconciliation_watermarks, idempotency_key, request_hash, result_hash, delivery_status,
           assurance_status, story_summary, stage_evidence, source_evidence,
           unresolved_gaps, operator_attestation, created_by, created_at
    FROM ssdlc_reconciliation_receipts
    WHERE workspace_id = $1 AND spec_slug = $2 AND spec_revision_hash = $3
      AND operator_attestation IS NOT NULL
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `, [workspaceId, specId, specRevisionHash])).rows[0] as ReceiptRow | undefined;
}


function receiptProjection(row: ReceiptRow, replayed: boolean): LifecycleReconciliationReceipt {
  return {
    schemaVersion: LIFECYCLE_RECONCILIATION_RECEIPT_VERSION,
    id: row.id,
    workspaceId: row.workspace_id,
    specId: row.spec_slug,
    specRevisionHash: row.spec_revision_hash,
    compiledPlanId: row.compiled_plan_id,
    previewHash: row.preview_hash,
    resultHash: row.result_hash,
    watermarks: row.reconciliation_watermarks,
    deliveryStatus: row.delivery_status,
    assuranceStatus: row.assurance_status,
    storySummary: row.story_summary,
    stageEvidence: row.stage_evidence,
    sourceEvidence: row.source_evidence,
    unresolvedGaps: row.unresolved_gaps,
    operatorAttestation: row.operator_attestation,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    replayed,
  };
}

/** Pure-read preview. The hash excludes wall-clock observation time. */
async function computeLifecycleReconciliationPreview(
  input: { workspaceId: string; specId: string },
  client: PoolClient,
): Promise<LifecycleReconciliationPreview> {
  const specId = requireSpecSlug(input.specId);
  const workspace = await loadWorkspace(input.workspaceId, client);
  const spec = await loadExactSpec(workspace, specId);
  const approvedSpecPath = `forge/specs/approved/${specId}.json`;
  const [detail, reconciliation, runs, prior, effectiveAttestation, versionIdentities, databaseWatermarks] = await Promise.all([
    getLifecycleReconciliationSnapshot({ workspaceId: workspace.id, specId }, client),
    inspectApprovedSpecPasses({ workspaceId: workspace.id, workspacePath: workspace.path, specPath: approvedSpecPath }),
    loadRuns(workspace.id, specId, client),
    latestReceipt(workspace.id, specId, spec.hash, client),
    latestEffectiveAttestation(workspace.id, specId, spec.hash, client),
    loadSpecVersionIdentities(workspace.id, specId, client),
    loadLifecycleReconciliationWatermarks(client, workspace.id, specId),
  ]);
  const watermarks: LifecycleReconciliationWatermarks = {
    ...databaseWatermarks,
    mutationState: digest({
      databaseMutationState: databaseWatermarks.mutationState,
      approvedSpecDocument: spec.content,
    }),
  };
  const currentSpecIdentity: HistoricalSpecIdentity = {
    ...identity(spec.content),
    canonicalHash: spec.hash,
  };
  const runsEvidence = await runEvidence(workspace.path, runs, specId, currentSpecIdentity, versionIdentities);
  const integratedRun = runsEvidence.find((run) => run.integrated === true
    && run.exactSpecRevision === true
    && run.status === 'done'
    && run.storyResultsComplete === true);
  const latestExactRun = runsEvidence.find((run) => run.exactSpecRevision === true);
  const activeRun = latestExactRun?.terminal === false ? latestExactRun : undefined;
  const failedRun = latestExactRun?.status === 'failed' || latestExactRun?.status === 'partial_failure'
    ? latestExactRun
    : undefined;
  const attested = effectiveAttestation !== undefined;
  const deliveryStatus: DeliveryStatus = attested
    ? 'operator_attested'
    : integratedRun
      ? 'completed'
      : activeRun
        ? 'in_progress'
        : failedRun
          ? 'failed'
          : 'unknown';
  const deliveryRationale = attested
    ? 'An append-only operator attestation records delivery completion for this exact spec revision; it does not certify assurance gates.'
    : integratedRun
      ? 'A successful exact-spec run has complete story results and its terminal commit is contained in the observed integration checkout.'
      : activeRun
        ? 'A run for this exact spec path is still active.'
        : failedRun
          ? 'Only failed terminal run evidence is currently available; delivery completion is unproven.'
          : 'No exact-spec run or governed operator attestation proves delivery completion.';

  const storyStatuses = reconciliation.stories;
  const stories = {
    total: storyStatuses.length,
    reconciledPassed: storyStatuses.filter((story) => story.status === 'consistent-passed').length,
    ambiguous: storyStatuses.filter((story) => story.status === 'ambiguous').length,
    invalid: storyStatuses.filter((story) => story.status === 'invalid').length,
  };
  const detailPlan = detail.plan;
  const detailState = detail.state;
  const phaseTimeline = detail.phaseTimeline;
  const phaseById = new Map(phaseTimeline.map((phase) => [phase.phaseId, phase]));
  const stages = detailPlan && detail.profile
    ? detail.profile.stages.map((stage) => {
      const phases = stage.phaseIds.map((phaseId) => {
        const phase = phaseById.get(phaseId)!;
        return { phaseId, status: phase.status, passed: phase.gateProgress.passed, required: phase.gateProgress.required };
      });
      const status = detailState !== 'current'
        ? 'stale' as const
        : phases.some((phase) => phase.status === 'blocked')
          ? 'blocked' as const
          : phases.every((phase) => phase.status === 'passed')
            ? 'passed' as const
            : 'partial' as const;
      return { stageId: stage.id, label: stage.label, status, phases };
    })
    : [];
  const assuranceStatus: AssuranceStatus = !detailPlan
    ? 'not_evaluated'
    : detailState !== 'current'
      ? 'stale'
      : stages.some((stage) => stage.status === 'blocked')
        ? 'blocked'
        : stages.length > 0 && stages.every((stage) => stage.status === 'passed')
          ? 'complete'
          : 'partial';
  const controls = detailPlan && detail.overallReadiness.counts
    ? { total: detail.overallReadiness.counts.total, passed: detail.overallReadiness.counts.passed }
    : { total: null, passed: null };
  const assuranceRationale = assuranceStatus === 'not_evaluated'
    ? 'No current compiled lifecycle/assurance plan exists for this exact spec revision.'
    : assuranceStatus === 'complete'
      ? 'Every applicable control in the current exact-revision plan is satisfied by current evidence or a governed decision.'
      : assuranceStatus === 'stale'
        ? 'The selected plan does not match the current canonical spec revision.'
        : assuranceStatus === 'blocked'
          ? 'At least one applicable control is blocked.'
          : 'A current plan exists, but one or more applicable controls lack current satisfying evidence.';

  const unresolvedGaps: LifecycleReconciliationPreview['unresolvedGaps'] = [];
  if (!detailPlan) unresolvedGaps.push({ code: 'MISSING_COMPILED_PLAN', message: 'Compile the exact current spec revision before assurance can be evaluated.' });
  if (stories.ambiguous > 0 || stories.invalid > 0) unresolvedGaps.push({ code: 'STORY_RECONCILIATION_REQUIRED', message: `${stories.ambiguous} ambiguous and ${stories.invalid} invalid story completion records require review.` });
  if (deliveryStatus !== 'completed' && deliveryStatus !== 'operator_attested') unresolvedGaps.push({ code: 'DELIVERY_INTEGRATION_UNPROVEN', message: 'No successful run commit is proven integrated and no operator delivery attestation exists.' });
  if (runsEvidence.some((run) => run.integrated === true && run.status === 'done' && run.exactSpecRevision !== true)) {
    unresolvedGaps.push({
      code: 'HISTORICAL_RUN_REVISION_MISMATCH',
      message: 'Integrated run evidence exists, but its committed spec intent or exact story set does not match the current canonical spec revision.',
    });
  }
  for (const run of runsEvidence.filter((item) => typeof item.specIdentityConflict === 'string')) {
    unresolvedGaps.push({
      code: 'CONTRADICTORY_RUN_SPEC_EVIDENCE',
      message: `Run ${String(run.runId)} cannot authorize delivery: ${String(run.specIdentityConflict)}`,
    });
  }
  for (const run of runsEvidence.filter((item) => item.storyScopeValid !== true)) {
    unresolvedGaps.push({
      code: 'RUN_STORY_SCOPE_INVALID',
      message: `Run ${String(run.runId)} has a malformed, duplicate, or oversized expected/result story scope and cannot authorize delivery.`,
    });
  }
  for (const stage of stages.filter((item) => item.status !== 'passed')) {
    unresolvedGaps.push({ code: 'STAGE_ASSURANCE_INCOMPLETE', stageId: stage.stageId, message: `${stage.label} assurance is ${stage.status}.` });
  }
  const sourceEvidence: Array<Record<string, unknown>> = [
    { kind: 'approved_spec', specRevisionHash: spec.hash, storyCount: stories.total },
    ...(detailPlan ? [{
      kind: 'compiled_assurance_plan',
      planId: detailPlan.databaseId,
      planVersion: detailPlan.version,
      inputHash: detailPlan.inputHash,
      assuranceProfileReceiptHash: typeof detail.provenance.assuranceProfile === 'object' && detail.provenance.assuranceProfile !== null
        ? (detail.provenance.assuranceProfile as Record<string, unknown>).compilationReceiptHash ?? null
        : null,
    }] : []),
    ...runsEvidence,
  ];
  const stablePreview = {
    schemaVersion: LIFECYCLE_RECONCILIATION_PREVIEW_VERSION,
    workspaceId: workspace.id,
    specId,
    title: spec.content.title ?? specId,
    specRevisionHash: spec.hash,
    compiledPlanId: detailPlan?.databaseId ?? null,
    planState: detailState,
    watermarks,
    delivery: {
      status: deliveryStatus,
      integratedRunId: typeof integratedRun?.runId === 'number' ? integratedRun.runId : null,
      integratedCommit: typeof integratedRun?.commitSha === 'string' ? integratedRun.commitSha : null,
      rationale: deliveryRationale,
    },
    assurance: { status: assuranceStatus, controls, rationale: assuranceRationale },
    stories,
    stages,
    sourceEvidence,
    unresolvedGaps,
    priorReceipt: prior ? {
      id: prior.id,
      resultHash: prior.result_hash,
      createdAt: iso(prior.created_at),
      operatorAttested: effectiveAttestation !== undefined,
    } : null,
  };
  return {
    ...stablePreview,
    observedAt: new Date().toISOString(),
    previewHash: digest(stablePreview),
  };
}

/** Pure-read preview computed from one repeatable-read database snapshot. */
export async function previewLifecycleReconciliation(input: {
  workspaceId: string;
  specId: string;
}): Promise<LifecycleReconciliationPreview> {
  return transaction(async (client: PoolClient) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    return computeLifecycleReconciliationPreview(input, client);
  });
}

export async function applyLifecycleReconciliation(input: {
  workspaceId: string;
  specId: string;
  previewHash: string;
  idempotencyKey: string;
  actorId: string;
  actorLabel: string;
  operatorAttestation?: unknown;
}): Promise<LifecycleReconciliationReceipt> {
  if (!SHA256.test(input.previewHash)) throw new ValidationError('previewHash must be a lowercase sha256 digest', { field: 'previewHash' });
  const specId = requireSpecSlug(input.specId);
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey || idempotencyKey.length > 256) throw new ValidationError('Idempotency-Key must contain 1-256 characters');
  const attestation = input.operatorAttestation === undefined ? null : AttestationSchema.parse(input.operatorAttestation);
  const normalizeAttestation = (specRevisionHash: string) => attestation ? {
    schemaVersion: 'rorca.operator-delivery-attestation.v1',
    actorId: input.actorId,
    actorLabel: input.actorLabel,
    deliveryOutcome: attestation.deliveryOutcome,
    rationale: attestation.rationale,
    evidenceReferences: attestation.evidenceReferences,
    specRevisionHash,
  } : null;
  const hashRequest = (
    specRevisionHash: string,
    watermarks: LifecycleReconciliationWatermarks,
  ) => digest({
    workspaceId: input.workspaceId,
    specId,
    previewHash: input.previewHash,
    watermarks,
    operatorAttestation: normalizeAttestation(specRevisionHash),
  });
  const assertReplay = (row: ReceiptRow): LifecycleReconciliationReceipt => {
    const expectedRequestHash = hashRequest(row.spec_revision_hash, row.reconciliation_watermarks);
    const legacyWatermark = `sha256:${'0'.repeat(64)}`;
    const legacyReceipt = Object.values(row.reconciliation_watermarks)
      .every((value) => value === legacyWatermark);
    const legacyRequestHash = digest({
      workspaceId: input.workspaceId,
      specId,
      previewHash: input.previewHash,
      operatorAttestation: normalizeAttestation(row.spec_revision_hash),
    });
    if (
      row.request_hash !== expectedRequestHash
      && !(legacyReceipt && row.request_hash === legacyRequestHash)
    ) {
      throw new ConflictError('Idempotency-Key was already used for a different reconciliation request');
    }
    return receiptProjection(row, true);
  };

  return transaction(async (client: PoolClient) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    // Acquire source locks before the first snapshot-bearing SELECT. Writers
    // that committed before the lock are therefore visible; later writers wait
    // until the receipt transaction commits or rolls back.
    // Receipt state is itself a preview input (prior receipt and carried
    // attestation). Serialize appenders before acquiring an MVCC snapshot.
    await client.query(
      'LOCK TABLE ssdlc_reconciliation_receipts IN SHARE ROW EXCLUSIVE MODE',
    );
    await client.query(`
      LOCK TABLE workspaces, ssdlc_compiled_plans, ssdlc_lifecycle_evidence,
                 ssdlc_decisions, pipeline_runs, story_results, spec_versions,
                 spec_search_index, spec_tags, ssdlc_plan_readiness_reasons,
                 memory_candidates, story_execution_manifests,
                 story_closeout_decisions, story_attempt_results, story_commits
      IN SHARE MODE
    `);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [input.workspaceId, idempotencyKey]);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [input.workspaceId, specId]);
    const replay = await client.query<ReceiptRow>(`
      SELECT id, workspace_id, spec_slug, spec_revision_hash, compiled_plan_id::text,
             preview_hash, reconciliation_watermarks, idempotency_key, request_hash, result_hash, delivery_status,
             assurance_status, story_summary, stage_evidence, source_evidence,
             unresolved_gaps, operator_attestation, created_by, created_at
      FROM ssdlc_reconciliation_receipts
      WHERE workspace_id = $1 AND idempotency_key = $2
      LIMIT 1
    `, [input.workspaceId, idempotencyKey]);
    if (replay.rows[0]) return assertReplay(replay.rows[0]);

    const preview = await computeLifecycleReconciliationPreview(
      { workspaceId: input.workspaceId, specId },
      client,
    );
    if (preview.previewHash !== input.previewHash) {
      throw new ConflictError('Lifecycle reconciliation preview is stale; refresh before applying', {
        type: 'new_preview_required',
        requestedPreviewHash: input.previewHash,
        currentPreviewHash: preview.previewHash,
        specRevisionHash: preview.specRevisionHash,
        watermarks: preview.watermarks,
      });
    }
    const requestedAttestation = normalizeAttestation(preview.specRevisionHash);
    const carriedAttestation = requestedAttestation === null && preview.delivery.status === 'operator_attested'
      ? (await latestEffectiveAttestation(input.workspaceId, specId, preview.specRevisionHash, client))?.operator_attestation ?? null
      : null;
    const effectiveOperatorAttestation = requestedAttestation ?? carriedAttestation;
    const requestHash = hashRequest(preview.specRevisionHash, preview.watermarks);
    const deliveryStatus: DeliveryStatus = effectiveOperatorAttestation ? 'operator_attested' : preview.delivery.status;
    const unresolvedGaps = deliveryStatus === 'completed' || deliveryStatus === 'operator_attested'
      ? preview.unresolvedGaps.filter((gap) => gap.code !== 'DELIVERY_INTEGRATION_UNPROVEN')
      : preview.unresolvedGaps;
    const resultHash = digest({
      schemaVersion: LIFECYCLE_RECONCILIATION_RECEIPT_VERSION,
      workspaceId: input.workspaceId,
      specId: preview.specId,
      specRevisionHash: preview.specRevisionHash,
      compiledPlanId: preview.compiledPlanId,
      previewHash: preview.previewHash,
      watermarks: preview.watermarks,
      requestHash,
      deliveryStatus,
      assuranceStatus: preview.assurance.status,
      storySummary: preview.stories,
      stageEvidence: preview.stages,
      sourceEvidence: preview.sourceEvidence,
      unresolvedGaps,
      operatorAttestation: effectiveOperatorAttestation,
      createdBy: input.actorId,
    });

    // Recompute the complete projection immediately before the append. Database
    // inputs remain locked; filesystem/profile/git drift changes the preview
    // identity and fails closed without writing a partial receipt.
    const revalidatedPreview = await computeLifecycleReconciliationPreview(
      { workspaceId: input.workspaceId, specId },
      client,
    );
    if (
      revalidatedPreview.previewHash !== preview.previewHash
      || revalidatedPreview.specRevisionHash !== preview.specRevisionHash
      || revalidatedPreview.compiledPlanId !== preview.compiledPlanId
      || stableWalJson(revalidatedPreview.watermarks) !== stableWalJson(preview.watermarks)
    ) {
      throw new ConflictError('Lifecycle reconciliation identity changed before receipt persistence', {
        type: 'new_preview_required',
        requestedPreviewHash: input.previewHash,
        currentPreviewHash: revalidatedPreview.previewHash,
        currentSpecRevisionHash: revalidatedPreview.specRevisionHash,
        currentCompiledPlanId: revalidatedPreview.compiledPlanId,
        currentWatermarks: revalidatedPreview.watermarks,
      });
    }

    const inserted = await client.query<ReceiptRow>(`
      INSERT INTO ssdlc_reconciliation_receipts (
        workspace_id, spec_slug, spec_revision_hash, compiled_plan_id,
        preview_hash, reconciliation_watermarks, idempotency_key, request_hash, result_hash,
        delivery_status, assurance_status, story_summary, stage_evidence,
        source_evidence, unresolved_gaps, operator_attestation, created_by
      ) VALUES ($1, $2, $3, $4::bigint, $5, $6::jsonb, $7, $8, $9, $10, $11,
                $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb, $17)
      RETURNING id, workspace_id, spec_slug, spec_revision_hash, compiled_plan_id::text,
                preview_hash, reconciliation_watermarks, idempotency_key, request_hash, result_hash, delivery_status,
                assurance_status, story_summary, stage_evidence, source_evidence,
                unresolved_gaps, operator_attestation, created_by, created_at
    `, [
      input.workspaceId, preview.specId, preview.specRevisionHash, preview.compiledPlanId,
      preview.previewHash, JSON.stringify(preview.watermarks), idempotencyKey, requestHash, resultHash,
      deliveryStatus, preview.assurance.status, JSON.stringify(preview.stories),
      JSON.stringify(preview.stages), JSON.stringify(preview.sourceEvidence),
      JSON.stringify(unresolvedGaps), effectiveOperatorAttestation ? JSON.stringify(effectiveOperatorAttestation) : null,
      input.actorId,
    ]);
    return receiptProjection(inserted.rows[0]!, false);
  });
}

export async function listLifecycleReconciliationReceipts(input: {
  workspaceId: string;
  specId: string;
  limit?: number;
}): Promise<LifecycleReconciliationReceipt[]> {
  const specId = requireSpecSlug(input.specId);
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  const rows = await query<ReceiptRow>(`
    SELECT id, workspace_id, spec_slug, spec_revision_hash, compiled_plan_id::text,
           preview_hash, reconciliation_watermarks, idempotency_key, request_hash, result_hash, delivery_status,
           assurance_status, story_summary, stage_evidence, source_evidence,
           unresolved_gaps, operator_attestation, created_by, created_at
    FROM ssdlc_reconciliation_receipts
    WHERE workspace_id = $1 AND spec_slug = $2
    ORDER BY created_at DESC, id DESC
    LIMIT $3
  `, [input.workspaceId, specId, limit]);
  return rows.map((row) => receiptProjection(row, false));
}
