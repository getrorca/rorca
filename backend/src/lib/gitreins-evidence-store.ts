/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { query, queryOne } from '../db/index';
import {
  MAX_GITREINS_EVIDENCE_BYTES,
  parseGitReinsJudgeEvidence,
  type GitReinsJudgeResult,
  type GitReinsEvidenceV1,
} from './gitreins-runner';

export interface GitReinsEvidenceRecord {
  id: number;
  workspaceId: string;
  runId: number;
  storyId: string;
  attempt: number;
  mode: 'observe' | 'enforce';
  status: 'pass' | 'fail' | 'error';
  reasonCode: string;
  schemaVersion: string;
  command: 'judge';
  scope: 'working-tree';
  worktree: boolean;
  durationMs: number;
  evidence: GitReinsEvidenceV1 | null;
  createdAt: string;
}

interface GitReinsEvidenceRow {
  id: string | number;
  workspace_id: string;
  run_id: string | number;
  story_id: string;
  attempt: number;
  mode: 'observe' | 'enforce';
  status: 'pass' | 'fail' | 'error';
  reason_code: string;
  schema_version: string;
  command: 'judge';
  scope: 'working-tree';
  worktree: boolean;
  duration_ms: number;
  evidence: GitReinsEvidenceV1 | null;
  created_at: Date | string;
}

function mapRow(row: GitReinsEvidenceRow): GitReinsEvidenceRecord {
  return {
    id: Number(row.id),
    workspaceId: row.workspace_id,
    runId: Number(row.run_id),
    storyId: row.story_id,
    attempt: row.attempt,
    mode: row.mode,
    status: row.status,
    reasonCode: row.reason_code,
    schemaVersion: row.schema_version,
    command: row.command,
    scope: row.scope,
    worktree: row.worktree,
    durationMs: row.duration_ms,
    evidence: row.evidence,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

/** Internal append-only write used by the canonical execution engine. */
export async function appendGitReinsEvidence(input: {
  workspaceId: string;
  runId: number;
  storyId: string;
  result: GitReinsJudgeResult;
}): Promise<GitReinsEvidenceRecord> {
  if (input.result.mode === 'disabled' || input.result.status === 'skipped') {
    throw new Error('Disabled/skipped GitReins results are not evidence rows');
  }
  const mode = input.result.mode as 'observe' | 'enforce';
  const evidence = input.result.evidence
    ? parseGitReinsJudgeEvidence(input.result.evidence)
    : null;
  if (input.result.evidence && !evidence) throw new Error('Invalid GitReins evidence contract');
  const serializedEvidence = evidence ? JSON.stringify(evidence) : null;
  if (serializedEvidence && Buffer.byteLength(serializedEvidence) > MAX_GITREINS_EVIDENCE_BYTES) {
    throw new Error('GitReins evidence exceeds storage boundary');
  }
  const row = await queryOne<GitReinsEvidenceRow>(
    `INSERT INTO gitreins_evidence (
       workspace_id, run_id, story_id, attempt, mode, status, reason_code,
       schema_version, command, scope, worktree, duration_ms, evidence
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'judge', 'working-tree', $9, $10, $11::jsonb)
     RETURNING *`,
    [
      input.workspaceId,
      input.runId,
      input.storyId,
      input.result.attempt,
      mode,
      input.result.status,
      input.result.reasonCode,
      evidence?.schemaVersion ?? '1.0',
      input.result.worktree,
      input.result.durationMs,
      serializedEvidence,
    ],
  );
  if (!row) throw new Error('GitReins evidence insert returned no row');
  return mapRow(row);
}

export async function listGitReinsEvidence(input: {
  workspaceId: string;
  runId?: number;
  storyId?: string;
  limit?: number;
  offset?: number;
}): Promise<{ items: GitReinsEvidenceRecord[]; total: number; limit: number; offset: number }> {
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 20)));
  const offset = Math.max(0, Math.min(100_000, Math.trunc(input.offset ?? 0)));
  const params: unknown[] = [input.workspaceId];
  const filters = ['workspace_id = $1'];
  if (input.runId !== undefined) {
    params.push(input.runId);
    filters.push(`run_id = $${params.length}`);
  }
  if (input.storyId !== undefined) {
    params.push(input.storyId);
    filters.push(`story_id = $${params.length}`);
  }
  const where = filters.join(' AND ');
  const countRow = await queryOne<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM gitreins_evidence WHERE ${where}`,
    params,
  );
  const rows = await query<GitReinsEvidenceRow>(
    `SELECT * FROM gitreins_evidence
     WHERE ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );
  return {
    items: rows.map(mapRow),
    total: Number(countRow?.count ?? 0),
    limit,
    offset,
  };
}
