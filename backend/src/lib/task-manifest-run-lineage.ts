/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { PoolClient } from 'pg';
import { queryOne } from '../db/index';
import { ConflictError } from './errors';
import { computeTaskManifestHash } from './task-manifest-artifacts';
import { safeParseTaskManifest, type TaskManifest } from './task-manifest';
import { computeSyntheticTaskManifestSpecHash, type SyntheticTaskManifestSpec } from './task-manifest-execution-envelope';
import { retryHash } from './retry-governance';

export const TASK_MANIFEST_RUN_LINEAGE_VERSION = 'rorca.task-manifest-lineage.v1' as const;

export interface TaskManifestRunLineage {
  runId: number;
  workspaceId: string;
  rootRunId: number;
  parentRunId: number | null;
  lineageDepth: number;
  schemaVersion: typeof TASK_MANIFEST_RUN_LINEAGE_VERSION;
  manifestId: string;
  sourceIdempotencyKey: string;
  manifestHash: string;
  syntheticSpecHash: string;
  manifestPath: string;
  syntheticSpecPath: string;
  lineageIdentityHash: string;
  providerHumanReceiptId: string | null;
}

interface LineageRow {
  run_id: number | string;
  workspace_id: string;
  root_run_id: number | string;
  parent_run_id: number | string | null;
  lineage_depth: number;
  schema_version: string;
  manifest_id: string;
  source_idempotency_key: string;
  manifest_hash: string;
  synthetic_spec_hash: string;
  manifest_path: string;
  synthetic_spec_path: string;
  lineage_identity_hash: string;
  provider_human_receipt_id: string | null;
}

interface RunRow {
  id: number | string;
  workspace_id: string;
  task_manifest_id: string | null;
  task_manifest_artifacts: Record<string, unknown> | string | null;
  trigger_options: Record<string, unknown> | string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && !Array.isArray(value) && typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && !Array.isArray(parsed) && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

function containedFile(workspacePath: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.split(/[\\/]+/).includes('..')) {
    throw new ConflictError('TaskManifest lineage path is not workspace-relative');
  }
  const root = fs.realpathSync(workspacePath);
  const absolute = path.resolve(root, relativePath);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ConflictError('TaskManifest lineage path escapes workspace authority');
  }
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new ConflictError('TaskManifest lineage path contains a symlink');
  }
  if (!fs.lstatSync(absolute).isFile() || fs.realpathSync(absolute) !== absolute) {
    throw new ConflictError('TaskManifest lineage authority must be a regular contained file');
  }
  return absolute;
}

function fromRow(row: LineageRow): TaskManifestRunLineage {
  return {
    runId: Number(row.run_id),
    workspaceId: row.workspace_id,
    rootRunId: Number(row.root_run_id),
    parentRunId: row.parent_run_id == null ? null : Number(row.parent_run_id),
    lineageDepth: row.lineage_depth,
    schemaVersion: TASK_MANIFEST_RUN_LINEAGE_VERSION,
    manifestId: row.manifest_id,
    sourceIdempotencyKey: row.source_idempotency_key,
    manifestHash: row.manifest_hash,
    syntheticSpecHash: row.synthetic_spec_hash,
    manifestPath: row.manifest_path,
    syntheticSpecPath: row.synthetic_spec_path,
    lineageIdentityHash: row.lineage_identity_hash,
    providerHumanReceiptId: row.provider_human_receipt_id,
  };
}

export function createTaskManifestRunLineage(input: Omit<TaskManifestRunLineage, 'schemaVersion' | 'lineageIdentityHash'>): TaskManifestRunLineage {
  const { providerHumanReceiptId, ...hashAuthority } = input;
  const base = { ...hashAuthority, schemaVersion: TASK_MANIFEST_RUN_LINEAGE_VERSION };
  return { ...base, lineageIdentityHash: retryHash(base), providerHumanReceiptId };
}

export async function insertTaskManifestRunLineage(
  client: PoolClient,
  input: TaskManifestRunLineage,
): Promise<TaskManifestRunLineage> {
  if (input.lineageIdentityHash !== retryHash({
    runId: input.runId,
    workspaceId: input.workspaceId,
    rootRunId: input.rootRunId,
    parentRunId: input.parentRunId,
    lineageDepth: input.lineageDepth,
    manifestId: input.manifestId,
    sourceIdempotencyKey: input.sourceIdempotencyKey,
    manifestHash: input.manifestHash,
    syntheticSpecHash: input.syntheticSpecHash,
    manifestPath: input.manifestPath,
    syntheticSpecPath: input.syntheticSpecPath,
    schemaVersion: input.schemaVersion,
  })) throw new ConflictError('TaskManifest lineage identity hash is invalid');
  const result = await client.query<LineageRow>(
    `INSERT INTO task_manifest_run_lineage (
       run_id, workspace_id, root_run_id, parent_run_id, lineage_depth,
       schema_version, manifest_id, source_idempotency_key, manifest_hash,
       synthetic_spec_hash, manifest_path, synthetic_spec_path, lineage_identity_hash,
       provider_human_receipt_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (run_id) DO NOTHING
     RETURNING *`,
    [input.runId, input.workspaceId, input.rootRunId, input.parentRunId, input.lineageDepth,
      input.schemaVersion, input.manifestId, input.sourceIdempotencyKey, input.manifestHash,
      input.syntheticSpecHash, input.manifestPath, input.syntheticSpecPath, input.lineageIdentityHash,
      input.providerHumanReceiptId],
  );
  const inserted = result.rows[0];
  if (inserted) return fromRow(inserted);
  const existing = (await client.query<LineageRow>(
    'SELECT * FROM task_manifest_run_lineage WHERE run_id = $1 FOR SHARE', [input.runId],
  )).rows[0];
  if (!existing || existing.lineage_identity_hash !== input.lineageIdentityHash) {
    throw new ConflictError('Run already has different immutable TaskManifest lineage');
  }
  return fromRow(existing);
}

async function loadVerified(
  runId: number,
  workspacePath: string,
  seen: ReadonlySet<number>,
): Promise<{ lineage: TaskManifestRunLineage; manifest: TaskManifest; syntheticSpec: SyntheticTaskManifestSpec }> {
  if (seen.has(runId)) throw new ConflictError('TaskManifest lineage cycle detected');
  const row = await queryOne<LineageRow & RunRow>(
    `SELECT lineage.*, run.task_manifest_id, run.task_manifest_artifacts, run.trigger_options
     FROM task_manifest_run_lineage lineage
     JOIN pipeline_runs run ON run.id = lineage.run_id AND run.workspace_id = lineage.workspace_id
     WHERE lineage.run_id = $1`,
    [runId],
  );
  if (!row) throw new ConflictError('TaskManifest run lacks immutable lineage authority');
  const lineage = fromRow(row);
  const expected = createTaskManifestRunLineage({
    runId: lineage.runId,
    workspaceId: lineage.workspaceId,
    rootRunId: lineage.rootRunId,
    parentRunId: lineage.parentRunId,
    lineageDepth: lineage.lineageDepth,
    manifestId: lineage.manifestId,
    sourceIdempotencyKey: lineage.sourceIdempotencyKey,
    manifestHash: lineage.manifestHash,
    syntheticSpecHash: lineage.syntheticSpecHash,
    manifestPath: lineage.manifestPath,
    syntheticSpecPath: lineage.syntheticSpecPath,
    providerHumanReceiptId: lineage.providerHumanReceiptId,
  });
  if (expected.lineageIdentityHash !== lineage.lineageIdentityHash || row.task_manifest_id !== lineage.manifestId) {
    throw new ConflictError('TaskManifest lineage differs from canonical run authority');
  }
  const artifacts = asRecord(row.task_manifest_artifacts);
  const options = asRecord(row.trigger_options);
  if (artifacts?.manifestHash !== lineage.manifestHash
    || artifacts?.syntheticSpecHash !== lineage.syntheticSpecHash
    || artifacts?.manifestPath !== lineage.manifestPath
    || artifacts?.specPath !== lineage.syntheticSpecPath
    || options?.manifestHash !== lineage.manifestHash
    || options?.syntheticSpecHash !== lineage.syntheticSpecHash) {
    throw new ConflictError('TaskManifest lineage differs from frozen artifact metadata');
  }
  const manifestPath = containedFile(workspacePath, lineage.manifestPath);
  const specPath = containedFile(workspacePath, lineage.syntheticSpecPath);
  const manifestBytes = fs.readFileSync(manifestPath, 'utf8');
  const parsedManifest = safeParseTaskManifest(JSON.parse(manifestBytes) as unknown);
  if (!parsedManifest.success) throw new ConflictError('TaskManifest lineage manifest bytes are invalid');
  const manifest = parsedManifest.data;
  const syntheticBytes = fs.readFileSync(specPath, 'utf8');
  const syntheticSpec = JSON.parse(syntheticBytes) as SyntheticTaskManifestSpec;
  const rawSyntheticHash = `sha256:${crypto.createHash('sha256').update(syntheticBytes, 'utf8').digest('hex')}`;
  if (computeTaskManifestHash(manifest) !== lineage.manifestHash
    || rawSyntheticHash !== lineage.syntheticSpecHash
    || computeSyntheticTaskManifestSpecHash(syntheticSpec) !== lineage.syntheticSpecHash
    || manifest.manifestId !== lineage.manifestId
    || manifest.idempotencyKey !== lineage.sourceIdempotencyKey
    || syntheticSpec.manifestHash !== lineage.manifestHash
    || syntheticSpec.manifestId !== lineage.manifestId
    || syntheticSpec.idempotencyKey !== lineage.sourceIdempotencyKey) {
    throw new ConflictError('TaskManifest lineage artifact bytes do not match immutable hashes');
  }
  if (lineage.lineageDepth === 0) {
    if (lineage.parentRunId !== null || lineage.rootRunId !== lineage.runId) {
      throw new ConflictError('TaskManifest root lineage identity is invalid');
    }
  } else {
    if (lineage.parentRunId === null) throw new ConflictError('TaskManifest descendant lineage lacks a parent');
    const parent = await loadVerified(lineage.parentRunId, workspacePath, new Set(seen).add(runId));
    if (parent.lineage.rootRunId !== lineage.rootRunId
      || parent.lineage.lineageDepth + 1 !== lineage.lineageDepth
      || parent.lineage.manifestId !== lineage.manifestId
      || parent.lineage.sourceIdempotencyKey !== lineage.sourceIdempotencyKey
      || parent.lineage.manifestHash !== lineage.manifestHash
      || parent.lineage.syntheticSpecHash !== lineage.syntheticSpecHash
      || parent.lineage.manifestPath !== lineage.manifestPath
      || parent.lineage.syntheticSpecPath !== lineage.syntheticSpecPath
      || parent.lineage.providerHumanReceiptId !== lineage.providerHumanReceiptId) {
      throw new ConflictError('TaskManifest descendant lineage differs from its parent authority');
    }
  }
  return { lineage, manifest, syntheticSpec };
}

function scopeContains(scope: string, candidate: string): boolean {
  const root = scope.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  const pathValue = candidate.replace(/\\/g, '/').replace(/^\.\//, '');
  return pathValue === root || pathValue.startsWith(`${root}/`);
}

export function changedFilesBetweenTaskManifestRevisions(
  repositoryPath: string,
  baseRevision: string,
  terminalRevision: string,
): string[] {
  if (!/^[0-9a-f]{40}$/.test(baseRevision) || !/^[0-9a-f]{40}$/.test(terminalRevision)) {
    throw new ConflictError('TaskManifest base or terminal revision is invalid');
  }
  try {
    execFileSync('git', ['cat-file', '-e', `${baseRevision}^{commit}`], {
      cwd: repositoryPath, stdio: ['ignore', 'ignore', 'pipe'],
    });
    execFileSync('git', ['cat-file', '-e', `${terminalRevision}^{commit}`], {
      cwd: repositoryPath, stdio: ['ignore', 'ignore', 'pipe'],
    });
    execFileSync('git', ['merge-base', '--is-ancestor', baseRevision, terminalRevision], {
      cwd: repositoryPath, stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch {
    throw new ConflictError('TaskManifest terminal revision is not descended from the frozen base revision');
  }
  const output = execFileSync(
    'git',
    ['diff', '--name-only', '--no-renames', '-z', baseRevision, terminalRevision, '--'],
    { cwd: repositoryPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return [...new Set(output.split('\0').map((value) => value.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

/** Recheck complete frozen-base to terminal file scope at host closeout. */
export async function assertTaskManifestHostFileScope(input: {
  runId: number;
  workspacePath: string;
  repositoryPath: string;
  terminalRevision: string;
}): Promise<void> {
  const verified = await loadVerified(input.runId, input.workspacePath, new Set<number>());
  const allowed = verified.manifest.boundedScope.allowedPaths;
  const forbidden = verified.manifest.boundedScope.forbiddenPaths;
  if (allowed.length === 0) throw new ConflictError('TaskManifest host file scope is empty');
  const manifestBases = await queryOne<{ base_revisions: string[] | null }>(
    `SELECT ARRAY_AGG(DISTINCT payload #>> '{execution,worktree,baseRevision}')
              FILTER (WHERE payload #>> '{execution,worktree,baseRevision}' IS NOT NULL) AS base_revisions
       FROM story_execution_manifests
      WHERE run_id = $1`,
    [input.runId],
  );
  const baseRevisions = manifestBases?.base_revisions ?? [];
  if (baseRevisions.length !== 1 || !/^[0-9a-f]{40}$/.test(baseRevisions[0] ?? '')) {
    throw new ConflictError('TaskManifest run lacks one exact frozen base revision');
  }
  const changed = changedFilesBetweenTaskManifestRevisions(
    input.repositoryPath,
    baseRevisions[0],
    input.terminalRevision,
  );
  for (const file of changed) {
    if (forbidden.some((scope) => scopeContains(scope, file))) {
      throw new ConflictError(`TaskManifest changed forbidden path '${file}'`);
    }
    if (!allowed.some((scope) => scopeContains(scope, file))) {
      throw new ConflictError(`TaskManifest changed path outside host-enforced scope '${file}'`);
    }
  }
}

export async function loadAndVerifyTaskManifestRunLineage(
  runId: number,
  workspacePath: string,
): Promise<{ lineage: TaskManifestRunLineage; manifest: TaskManifest; syntheticSpec: SyntheticTaskManifestSpec }> {
  return loadVerified(runId, workspacePath, new Set());
}
