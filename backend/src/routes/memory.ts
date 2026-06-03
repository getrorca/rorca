/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * memory.ts — API routes for the Episodic MEMORY.md Ledger (CIE-005)
 *
 * CRUD operations on structured memory entries, approval/rejection flow
 * for post-run synthesis proposals, and context injection config.
 */

import { Router, Request, Response } from 'express';
import { execute, query as dbQuery, queryOne } from '../db/index';
import {
  readMemory,
  append,
  query,
  recent,
  deleteEntry,
  updateEntry,
  logRejected,
  readRejected,
  getContextSnippet,
  rotateMemory,
  countArchiveEntries,
  MEMORY_CATEGORIES,
  type MemoryEntry,
  type MemoryCategory,
} from '../lib/memory-ledger';
import { analyzeRunEvents } from '../lib/wal-feedback';
import { broadcastAll } from '../lib/sse-hub';
import { invalidateMemory } from '../lib/context-cache';
import { deduplicateMemory } from '../lib/memory-dedup';
import { embedText, prepareText } from '../lib/embedding-pipeline';
import { NotFoundError, ValidationError } from '../lib/errors';
import { resolveStoryMemoryProvenance } from '../lib/memory-provenance';
import { getMemoryGraphNeighborhood, getMemoryGraphOverview } from '../lib/memory-graph';
import { checkAge } from '../lib/age-guard';
import {
  createMemoryRelation,
  listMemoryRelations,
  MEMORY_RELATION_SEMANTICS,
  MEMORY_RELATION_STATUSES,
  MEMORY_RELATION_TYPES,
  updateMemoryRelationStatus,
} from '../lib/memory-relations';

const router = Router();

// ─── Constants ──────────────────────────────────────────────────────────────

/** Valid source_type values for the memories table (must match CHECK constraint in migration 059) */
const VALID_SOURCE_TYPES = ['synthesis', 'manual', 'mcp', 'auto-extracted', 'import'] as const;
type SourceType = typeof VALID_SOURCE_TYPES[number];

// ─── Helpers ────────────────────────────────────────────────────────────────

async function getWorkspacePath(workspaceId: string): Promise<string | null> {
  const ws = await queryOne<{ path: string }>('SELECT path FROM workspaces WHERE id = $1', [workspaceId]);
  return ws?.path ?? null;
}

async function assertMemoryInWorkspace(workspaceId: string, memoryId: string): Promise<void> {
  const parsedMemoryId = Number(memoryId);
  if (!Number.isInteger(parsedMemoryId) || parsedMemoryId <= 0) {
    throw new ValidationError('memoryId must be a positive integer');
  }

  const memory = await queryOne<{ id: number }>(
    'SELECT id FROM memories WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL',
    [parsedMemoryId, workspaceId],
  );
  if (!memory) {
    throw new NotFoundError('Memory not found');
  }
}

function getLedgerPath(_workspaceId: string): string | undefined {
  // Could read from .rorca/config.json in the future, but for now use default
  return undefined;
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function toRunId(value: number | string | null | undefined): number | null {
  if (value == null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Infer source_type from the file-based source field text */
function inferSourceType(source: string): SourceType {
  if (!source) return 'manual';
  if (source === 'mcp-cli' || source === 'mcp') return 'mcp';
  // Story ID patterns: US-001, CIE-003, MST-002, SL-017, etc.
  if (/^[A-Z]{1,6}-\d{1,4}$/.test(source.trim())) return 'synthesis';
  // Source contains "story-" prefix (e.g. "story-US-001")
  if (/story-/i.test(source)) return 'synthesis';
  // Source contains "run-" prefix (e.g. "run-42")
  if (/^run-\d+$/i.test(source.trim())) return 'synthesis';
  return 'manual';
}

function inferStoryIdFromSource(source: string): string | null {
  const trimmed = source.trim();
  if (/^[A-Z]{1,6}-\d{1,4}$/.test(trimmed)) return trimmed;
  const storyMatch = trimmed.match(/^story-(.+)$/i);
  if (storyMatch?.[1]) return storyMatch[1].trim();
  return null;
}

function normalizeRelatedFiles(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((file): file is string => typeof file === 'string' && file.trim().length > 0))];
}

function parsePositiveInteger(value: number | string, fieldName: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ValidationError(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

function assertMemoryRelationType(value: string): asserts value is (typeof MEMORY_RELATION_TYPES)[number] {
  if (!MEMORY_RELATION_TYPES.includes(value as (typeof MEMORY_RELATION_TYPES)[number])) {
    throw new ValidationError(`relationType must be one of: ${MEMORY_RELATION_TYPES.join(', ')}`);
  }
}

function assertMemoryRelationStatus(value: string): asserts value is (typeof MEMORY_RELATION_STATUSES)[number] {
  if (!MEMORY_RELATION_STATUSES.includes(value as (typeof MEMORY_RELATION_STATUSES)[number])) {
    throw new ValidationError(`status must be one of: ${MEMORY_RELATION_STATUSES.join(', ')}`);
  }
}

async function emitMemoryWalEvent(params: {
  eventType: 'memory_created' | 'memory_deleted' | 'memory_restored';
  workspaceId: string;
  memoryId: string;
  category?: string;
  content?: string;
  storyId?: string | null;
  specId?: string | null;
  relatedFiles?: string[];
}): Promise<void> {
  try {
    const walPayload = JSON.stringify({
      id: params.memoryId,
      ...(params.content ? { text: params.content } : {}),
      ...(params.category ? { category: params.category } : {}),
      ...(params.relatedFiles ? { relatedFiles: params.relatedFiles } : {}),
    });
    const walEvent = await queryOne<{ id: number }>(
      `INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, payload) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [params.eventType, params.workspaceId, params.specId ?? null, params.storyId ?? null, walPayload],
    );
    if (walEvent) {
      broadcastAll({
        id: walEvent.id,
        event_type: params.eventType,
        workspace_id: params.workspaceId,
        spec_id: params.specId ?? null,
        story_id: params.storyId ?? null,
        payload: walPayload,
        ts: new Date().toISOString(),
      } as any);
    }
  } catch {
    // Best-effort WAL event — don't block memory lifecycle operations
  }
}

async function emitMemoryCreatedWalEvent(params: {
  workspaceId: string;
  memoryId: string;
  category: string;
  content: string;
  storyId?: string | null;
  specId?: string | null;
  relatedFiles?: string[];
}): Promise<void> {
  await emitMemoryWalEvent({
    eventType: 'memory_created',
    workspaceId: params.workspaceId,
    memoryId: params.memoryId,
    category: params.category,
    content: params.content,
    storyId: params.storyId,
    specId: params.specId,
    relatedFiles: params.relatedFiles,
  });
}

const STALE_REVIEW_SCAN_LIMIT = 120;
const STALE_REVIEW_RESULT_LIMIT = 12;
const STALE_REVIEW_SCORE_THRESHOLD = 30;
const STALE_REVIEW_DAYS = 45;
const STALE_LOW_CONFIDENCE_DAYS = 21;
const HOTSPOT_MEMORY_WINDOW = 400;
const HOTSPOT_RESULT_LIMIT = 6;
const REVIEW_ACTION_HISTORY_LIMIT = 96;

type MemoryReviewAction = 'archive' | 'delete' | 'keep' | 'revisit' | 'restore';
type MemoryReviewCandidateStatus = 'candidate' | 'kept' | 'revisit' | 'archived' | 'deleted';

interface MemoryReviewReason {
  code: string;
  label: string;
}

interface MemoryReviewMemoryRow {
  id: number;
  workspace_id: string;
  category: string;
  content: string;
  source_story_id: string | null;
  source_spec_id: string | null;
  source_run_id: number | string | null;
  confidence: string;
  related_files: string[] | string | null;
  pinned: boolean;
  source_type: string | null;
  source: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface MemoryReviewCandidateRow extends MemoryReviewMemoryRow {
  incoming_supersedes: number | string | null;
  outgoing_supersedes: number | string | null;
  active_conflicts: number | string | null;
}

interface MemoryReviewActionRecord {
  memoryId: number;
  action: MemoryReviewAction;
  at: string;
  previousStatus: string | null;
  nextStatus: MemoryReviewCandidateStatus | null;
}

interface MemoryHotspotRow {
  key: string;
  memory_count: number | string;
  conflict_count: number | string;
  superseded_count: number | string;
  last_touched_at: string | null;
  sample_memory_ids: number[] | string | null;
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : [];
    } catch {
      return [];
    }
  }

  return [];
}

function parseNumericArray(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0);
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0)
        : [];
    } catch {
      return [];
    }
  }

  return [];
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values.filter((value) => Number.isInteger(value) && value > 0))];
}

function daysSince(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return null;
  return Math.max(0, Math.floor((Date.now() - timestamp) / 86_400_000));
}

function parseReviewAction(value: unknown): MemoryReviewAction | null {
  if (value === 'archive' || value === 'delete' || value === 'keep' || value === 'revisit' || value === 'restore') {
    return value;
  }
  return null;
}

function statusForReviewAction(action: MemoryReviewAction, deletedAt: string | null): MemoryReviewCandidateStatus {
  if (action === 'archive') return 'archived';
  if (action === 'delete') return 'deleted';
  if (action === 'keep') return 'kept';
  if (action === 'revisit') return 'revisit';
  return deletedAt ? 'archived' : 'candidate';
}

function buildStaleReviewReasons(row: MemoryReviewCandidateRow): { staleScore: number; reasons: MemoryReviewReason[] } {
  const reasons: MemoryReviewReason[] = [];
  let staleScore = 0;
  const ageDays = daysSince(row.updated_at) ?? 0;
  const incomingSupersedes = Number(row.incoming_supersedes ?? 0);
  const activeConflicts = Number(row.active_conflicts ?? 0);
  const relatedFiles = parseStringArray(row.related_files);

  if (incomingSupersedes > 0) {
    staleScore += 60;
    reasons.push({ code: 'superseded_by_newer_memory', label: 'Superseded by a newer canonical memory.' });
  }

  if (ageDays >= STALE_REVIEW_DAYS) {
    staleScore += 25;
    reasons.push({ code: 'untouched_for_45d', label: `Not updated for ${ageDays} days.` });
  }

  if (row.confidence === 'low' && ageDays >= STALE_LOW_CONFIDENCE_DAYS) {
    staleScore += 15;
    reasons.push({ code: 'low_confidence_aging', label: 'Low-confidence memory has gone stale without a refresh.' });
  }

  if (activeConflicts > 0) {
    staleScore += 10;
    reasons.push({ code: 'conflict_needs_review', label: 'Conflicts with another active memory and needs operator review.' });
  }

  if (relatedFiles.length === 0) {
    staleScore += 8;
    reasons.push({ code: 'missing_file_provenance', label: 'No related file provenance is attached.' });
  }

  if (!row.source_spec_id && !row.source_story_id) {
    staleScore += 8;
    reasons.push({ code: 'weak_story_spec_provenance', label: 'Missing source story/spec provenance for future audits.' });
  }

  return { staleScore, reasons };
}

function mapMemoryReviewItem(
  row: MemoryReviewMemoryRow,
  review: { staleScore: number; reasons: MemoryReviewReason[] } | null,
  latestAction?: MemoryReviewActionRecord,
) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    category: row.category,
    content: row.content,
    sourceStoryId: row.source_story_id,
    sourceSpecId: row.source_spec_id,
    sourceRunId: toRunId(row.source_run_id),
    confidence: row.confidence,
    relatedFiles: parseStringArray(row.related_files),
    pinned: Boolean(row.pinned),
    sourceType: row.source_type,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    staleScore: review?.staleScore ?? 0,
    reasons: review?.reasons ?? [],
    status: latestAction ? statusForReviewAction(latestAction.action, row.deleted_at) : 'candidate',
    lastAction: latestAction
      ? {
        action: latestAction.action,
        at: latestAction.at,
        previousStatus: latestAction.previousStatus,
        nextStatus: latestAction.nextStatus,
      }
      : null,
  };
}

async function loadMemoryReviewActionHistory(workspaceId: string): Promise<MemoryReviewActionRecord[]> {
  const rows = await dbQuery<{ ts: string; payload: Record<string, unknown> | string | null }>(
    `SELECT ts, payload
       FROM wal_events
      WHERE workspace_id = $1
        AND event_type = 'memory_reviewed'
      ORDER BY ts DESC
      LIMIT $2`,
    [workspaceId, REVIEW_ACTION_HISTORY_LIMIT],
  );

  const seen = new Set<number>();
  const actions: MemoryReviewActionRecord[] = [];

  for (const row of rows) {
    const payload = typeof row.payload === 'string'
      ? JSON.parse(row.payload)
      : (row.payload ?? {});
    const memoryId = Number((payload as Record<string, unknown>).memoryId);
    const action = parseReviewAction((payload as Record<string, unknown>).action);
    if (!Number.isInteger(memoryId) || memoryId <= 0 || !action || seen.has(memoryId)) {
      continue;
    }

    seen.add(memoryId);
    actions.push({
      memoryId,
      action,
      at: row.ts,
      previousStatus: typeof (payload as Record<string, unknown>).previousStatus === 'string'
        ? (payload as Record<string, unknown>).previousStatus as string
        : null,
      nextStatus: typeof (payload as Record<string, unknown>).nextStatus === 'string'
        ? (payload as Record<string, unknown>).nextStatus as MemoryReviewCandidateStatus
        : null,
    });
  }

  return actions;
}

async function loadMemoryReviewRows(workspaceId: string, ids: number[]): Promise<MemoryReviewMemoryRow[]> {
  const targetIds = uniqueNumbers(ids);
  if (targetIds.length === 0) return [];

  return dbQuery<MemoryReviewMemoryRow>(
    `SELECT id, workspace_id, category, content, source_story_id, source_spec_id, source_run_id,
            confidence, related_files, pinned, source_type, source, created_at, updated_at, deleted_at
       FROM memories
      WHERE workspace_id = $1
        AND id = ANY($2::int[])
      ORDER BY updated_at DESC, id DESC`,
    [workspaceId, targetIds],
  );
}

async function loadStaleReviewCandidates(workspaceId: string): Promise<MemoryReviewCandidateRow[]> {
  return dbQuery<MemoryReviewCandidateRow>(
    `WITH candidate_pool AS (
       SELECT m.id,
              m.workspace_id,
              m.category,
              m.content,
              m.source_story_id,
              m.source_spec_id,
              m.source_run_id,
              m.confidence,
              m.related_files,
              COALESCE(m.pinned, false) AS pinned,
              m.source_type,
              m.source,
              m.created_at,
              m.updated_at,
              m.deleted_at
         FROM memories m
        WHERE m.workspace_id = $1
          AND m.deleted_at IS NULL
          AND COALESCE(m.pinned, false) = false
        ORDER BY m.updated_at ASC, m.id ASC
        LIMIT $2
     ),
     relation_stats AS (
       SELECT cp.id AS memory_id,
              COUNT(*) FILTER (WHERE mr.relation_type = 'SUPERSEDES' AND mr.status = 'active' AND mr.target_memory_id = cp.id)::int AS incoming_supersedes,
              COUNT(*) FILTER (WHERE mr.relation_type = 'SUPERSEDES' AND mr.status = 'active' AND mr.source_memory_id = cp.id)::int AS outgoing_supersedes,
              COUNT(*) FILTER (WHERE mr.relation_type = 'CONFLICTS_WITH' AND mr.status = 'active')::int AS active_conflicts
         FROM candidate_pool cp
         LEFT JOIN memory_relations mr
           ON mr.workspace_id = $1
          AND (mr.source_memory_id = cp.id OR mr.target_memory_id = cp.id)
        GROUP BY cp.id
     )
     SELECT cp.id,
            cp.workspace_id,
            cp.category,
            cp.content,
            cp.source_story_id,
            cp.source_spec_id,
            cp.source_run_id,
            cp.confidence,
            cp.related_files,
            cp.pinned,
            cp.source_type,
            cp.source,
            cp.created_at,
            cp.updated_at,
            cp.deleted_at,
            COALESCE(rs.incoming_supersedes, 0) AS incoming_supersedes,
            COALESCE(rs.outgoing_supersedes, 0) AS outgoing_supersedes,
            COALESCE(rs.active_conflicts, 0) AS active_conflicts
       FROM candidate_pool cp
       LEFT JOIN relation_stats rs ON rs.memory_id = cp.id
      ORDER BY cp.updated_at ASC, cp.id ASC`,
    [workspaceId, STALE_REVIEW_SCAN_LIMIT],
  );
}

async function loadHotspotRows(workspaceId: string, scope: 'file' | 'spec'): Promise<MemoryHotspotRow[]> {
  if (scope === 'file') {
    return dbQuery<MemoryHotspotRow>(
      `WITH recent_memories AS (
         SELECT id, source_spec_id, related_files, updated_at
           FROM memories
          WHERE workspace_id = $1
            AND deleted_at IS NULL
          ORDER BY updated_at DESC, id DESC
          LIMIT $2
       ),
       relation_counts AS (
         SELECT rm.id AS memory_id,
                COUNT(*) FILTER (WHERE mr.relation_type = 'CONFLICTS_WITH' AND mr.status = 'active')::int AS conflict_count,
                COUNT(*) FILTER (WHERE mr.relation_type = 'SUPERSEDES' AND mr.status = 'active')::int AS superseded_count
           FROM recent_memories rm
           LEFT JOIN memory_relations mr
             ON mr.workspace_id = $1
            AND (mr.source_memory_id = rm.id OR mr.target_memory_id = rm.id)
          GROUP BY rm.id
       ),
       file_refs AS (
         SELECT rm.id,
                rm.updated_at,
                jsonb_array_elements_text(rm.related_files) AS file_path
           FROM recent_memories rm
          WHERE jsonb_typeof(rm.related_files) = 'array'
       )
       SELECT fr.file_path AS key,
              COUNT(DISTINCT fr.id)::int AS memory_count,
              COUNT(DISTINCT fr.id) FILTER (WHERE COALESCE(rc.conflict_count, 0) > 0)::int AS conflict_count,
              COUNT(DISTINCT fr.id) FILTER (WHERE COALESCE(rc.superseded_count, 0) > 0)::int AS superseded_count,
              MAX(fr.updated_at) AS last_touched_at,
              ARRAY(
                SELECT DISTINCT fr2.id
                  FROM file_refs fr2
                 WHERE fr2.file_path = fr.file_path
                 ORDER BY fr2.id ASC
                 LIMIT 3
              ) AS sample_memory_ids
         FROM file_refs fr
         LEFT JOIN relation_counts rc ON rc.memory_id = fr.id
        GROUP BY fr.file_path
        ORDER BY memory_count DESC, conflict_count DESC, last_touched_at DESC, key ASC
        LIMIT $3`,
      [workspaceId, HOTSPOT_MEMORY_WINDOW, HOTSPOT_RESULT_LIMIT],
    );
  }

  return dbQuery<MemoryHotspotRow>(
    `WITH recent_memories AS (
       SELECT id, source_spec_id, updated_at
         FROM memories
        WHERE workspace_id = $1
          AND deleted_at IS NULL
          AND source_spec_id IS NOT NULL
        ORDER BY updated_at DESC, id DESC
        LIMIT $2
     ),
     relation_counts AS (
       SELECT rm.id AS memory_id,
              COUNT(*) FILTER (WHERE mr.relation_type = 'CONFLICTS_WITH' AND mr.status = 'active')::int AS conflict_count,
              COUNT(*) FILTER (WHERE mr.relation_type = 'SUPERSEDES' AND mr.status = 'active')::int AS superseded_count
         FROM recent_memories rm
         LEFT JOIN memory_relations mr
           ON mr.workspace_id = $1
          AND (mr.source_memory_id = rm.id OR mr.target_memory_id = rm.id)
        GROUP BY rm.id
     )
     SELECT rm.source_spec_id AS key,
            COUNT(DISTINCT rm.id)::int AS memory_count,
            COUNT(DISTINCT rm.id) FILTER (WHERE COALESCE(rc.conflict_count, 0) > 0)::int AS conflict_count,
            COUNT(DISTINCT rm.id) FILTER (WHERE COALESCE(rc.superseded_count, 0) > 0)::int AS superseded_count,
            MAX(rm.updated_at) AS last_touched_at,
            ARRAY(
              SELECT DISTINCT rm2.id
                FROM recent_memories rm2
               WHERE rm2.source_spec_id = rm.source_spec_id
               ORDER BY rm2.id ASC
               LIMIT 3
            ) AS sample_memory_ids
       FROM recent_memories rm
       LEFT JOIN relation_counts rc ON rc.memory_id = rm.id
      GROUP BY rm.source_spec_id
      ORDER BY memory_count DESC, conflict_count DESC, last_touched_at DESC, key ASC
      LIMIT $3`,
    [workspaceId, HOTSPOT_MEMORY_WINDOW, HOTSPOT_RESULT_LIMIT],
  );
}

function mapHotspotItems(rows: MemoryHotspotRow[], scopeType: 'file' | 'spec') {
  return rows.map((row) => ({
    scopeType,
    key: row.key,
    label: row.key,
    memoryCount: Number(row.memory_count),
    conflictCount: Number(row.conflict_count),
    supersededCount: Number(row.superseded_count),
    lastTouchedAt: row.last_touched_at,
    sampleMemoryIds: parseNumericArray(row.sample_memory_ids),
  }));
}

async function emitMemoryReviewWalEvent(params: {
  workspaceId: string;
  memoryId: number;
  action: MemoryReviewAction;
  previousStatus: string;
  nextStatus: MemoryReviewCandidateStatus;
  memory: MemoryReviewMemoryRow;
  staleScore: number;
  reasons: MemoryReviewReason[];
}): Promise<void> {
  const payload = {
    memoryId: params.memoryId,
    action: params.action,
    previousStatus: params.previousStatus,
    nextStatus: params.nextStatus,
    staleScore: params.staleScore,
    reasons: params.reasons,
    provenance: {
      category: params.memory.category,
      content: params.memory.content,
      source: params.memory.source,
      sourceStoryId: params.memory.source_story_id,
      sourceSpecId: params.memory.source_spec_id,
      sourceRunId: toRunId(params.memory.source_run_id),
      sourceType: params.memory.source_type,
      relatedFiles: parseStringArray(params.memory.related_files),
      createdAt: params.memory.created_at,
      updatedAt: params.memory.updated_at,
      deletedAt: params.memory.deleted_at,
    },
  };

  try {
    const walEvent = await queryOne<{ id: number }>(
      `INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, actor, payload)
       VALUES ('memory_reviewed', $1, $2, $3, 'user', $4)
       RETURNING id`,
      [params.workspaceId, params.memory.source_spec_id, params.memory.source_story_id, JSON.stringify(payload)],
    );

    if (walEvent) {
      broadcastAll({
        id: walEvent.id,
        event_type: 'memory_reviewed',
        workspace_id: params.workspaceId,
        spec_id: params.memory.source_spec_id,
        story_id: params.memory.source_story_id,
        actor: 'user',
        payload,
        ts: new Date().toISOString(),
      } as any);
    }
  } catch {
    // Best-effort review audit trail — do not block operator workflow.
  }
}

// ─── Routes ─────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/memory:
 *   get:
 *     tags: [Memory]
 *     summary: List memory entries for a workspace
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Read-only workspace memory listing is a safe local automation surface for CLI and MCP callers."
 *     x-rorca-public-api: true
 *     operationId: listMemoryEntries
 *     description: Returns structured memory ledger entries from MEMORY.md for a workspace. Can filter by category or return the N most recent entries.
 *     parameters:
 *       - name: workspaceId
 *         in: query
 *         required: true
 *         schema: { type: string }
 *         description: Workspace ID
 *       - name: category
 *         in: query
 *         schema: { type: string, enum: [Architecture, Convention, "Bug Fix", Decision, Pattern, Gotcha] }
 *         description: Filter entries by category
 *       - name: limit
 *         in: query
 *         schema: { type: integer }
 *         description: Return only the N most recent entries
 *     responses:
 *       200:
 *         description: Memory entries list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 items:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       date: { type: string, description: "YYYY-MM-DD" }
 *                       category: { type: string }
 *                       title: { type: string }
 *                       rule: { type: string }
 *                       context: { type: string }
 *                       source: { type: string }
 *                       sourceType: { type: string, enum: [synthesis, manual, mcp, auto-extracted, import], description: "Inferred from source field" }
 *                 total: { type: integer }
 *                 categories: { type: array, items: { type: string } }
 *       400: { description: "Missing workspaceId" }
 *       404: { description: "Workspace not found" }
 */
router.get('/', async (req: Request, res: Response) => {
  const { workspaceId, category, limit } = req.query;
  if (!workspaceId) throw new ValidationError('workspaceId required');

  const wsPath = await getWorkspacePath(workspaceId as string);
  if (!wsPath) throw new NotFoundError('Workspace not found');

  const ledgerPath = getLedgerPath(workspaceId as string);

  let entries: MemoryEntry[];
  if (category && MEMORY_CATEGORIES.includes(category as MemoryCategory)) {
    entries = query(wsPath, category as MemoryCategory, ledgerPath);
  } else if (limit) {
    entries = recent(wsPath, parseInt(limit as string, 10) || 20, ledgerPath);
  } else {
    entries = readMemory(wsPath, ledgerPath);
  }

  const itemsWithSourceType = entries.map(e => ({
    ...e,
    sourceType: inferSourceType(e.source),
  }));

  res.json({
    items: itemsWithSourceType,
    total: entries.length,
    categories: MEMORY_CATEGORIES,
  });
});

/**
 * @swagger
 * /api/memory:
 *   post:
 *     tags: [Memory]
 *     summary: Append a new memory entry
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Saving local project memory is a core open-source workflow with no billing or admin side effects."
 *     x-rorca-public-api: true
 *     operationId: createMemoryEntry
 *     description: Appends a new structured entry to the workspace MEMORY.md ledger file with the current date.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, category, title, rule]
 *             properties:
 *               workspaceId: { type: string }
 *               category: { type: string, enum: [Architecture, Convention, "Bug Fix", Decision, Pattern, Gotcha] }
 *               title: { type: string, description: "Short title for the entry" }
 *               rule: { type: string, description: "The rule or insight to remember" }
 *               context: { type: string, description: "Optional additional context" }
 *               source: { type: string, description: "Optional source story ID (e.g. US-001)" }
 *               sourceSpecId: { type: string, description: "Optional owning spec slug for provenance completeness" }
 *               sourceRunId: { type: integer, description: "Optional owning run ID for provenance completeness" }
 *               relatedFiles: { type: array, items: { type: string }, description: "Optional file scope for deterministic ABOUT edge reconstruction" }
 *     responses:
 *       201:
 *         description: Memory entry created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 entry:
 *                   type: object
 *                   properties:
 *                     date: { type: string }
 *                     category: { type: string }
 *                     title: { type: string }
 *                     rule: { type: string }
 *                     context: { type: string }
 *                     source: { type: string }
 *                 total: { type: integer, description: "Total entry count after insertion" }
 *       400: { description: "Missing required fields or invalid category" }
 *       404: { description: "Workspace not found" }
 */
router.post('/', async (req: Request, res: Response) => {
  const { workspaceId, category, title, rule, context, source, sourceType, relatedFiles, sourceSpecId, sourceRunId } = req.body;

  if (!workspaceId || !category || !title || !rule) {
    throw new ValidationError('workspaceId, category, title, and rule are required');
  }

  if (!MEMORY_CATEGORIES.includes(category as MemoryCategory)) {
    throw new ValidationError(`Invalid category. Must be one of: ${MEMORY_CATEGORIES.join(', ')}`);
  }

  // Validate sourceType if provided; otherwise infer from source text.
  const resolvedSourceType: SourceType = sourceType ?? inferSourceType(source ?? '');
  if (!VALID_SOURCE_TYPES.includes(resolvedSourceType as SourceType)) {
    throw new ValidationError(`Invalid sourceType. Must be one of: ${VALID_SOURCE_TYPES.join(', ')}`);
  }

  const wsPath = await getWorkspacePath(workspaceId);
  if (!wsPath) throw new NotFoundError('Workspace not found');

  const normalizedRelatedFiles = normalizeRelatedFiles(relatedFiles);
  const inferredStoryId = inferStoryIdFromSource(source ?? '');
  const normalizedSourceRunId = toRunId(sourceRunId);
  const inferredProvenance = await resolveStoryMemoryProvenance(normalizedSourceRunId, inferredStoryId);
  const resolvedSourceSpecId = sourceSpecId ?? inferredProvenance.sourceSpecId;
  const resolvedRelatedFiles = normalizedRelatedFiles.length > 0
    ? normalizedRelatedFiles
    : inferredProvenance.relatedFiles;

  const entry: MemoryEntry = {
    date: todayDate(),
    category: category as MemoryCategory,
    title,
    rule,
    context: context ?? '',
    source: source ?? '',
  };

  // Write to filesystem MEMORY.md
  const entries = append(wsPath, entry, getLedgerPath(workspaceId));

  // Also insert into memories DB table with source_type
  let embedding: number[] | null = null;
  try {
    const prepared = prepareText('memory', `${title}: ${rule}`);
    embedding = await embedText(prepared);
  } catch {
    // Embedding failure is non-fatal
  }
  const embeddingStr = embedding ? `[${embedding.join(',')}]` : null;

  let insertedId: string | undefined;
  if (embeddingStr) {
    try {
      const row = await queryOne<{ id: string }>(
        `INSERT INTO memories (workspace_id, category, content, source_story_id, source_spec_id, source_run_id, confidence, related_files, embedding, source_type, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector, $10, $11) RETURNING id`,
        [
          workspaceId,
          category,
          `${title}: ${rule}`,
          inferredStoryId,
          resolvedSourceSpecId,
          normalizedSourceRunId,
          'high',
          JSON.stringify(resolvedRelatedFiles),
          embeddingStr,
          resolvedSourceType,
          source ?? null,
        ],
      );
      insertedId = row?.id;
    } catch {
      // embedding column may not exist (pgvector not installed) — fall through to non-embedding insert
    }
  }
  if (!insertedId) {
    const row = await queryOne<{ id: string }>(
      `INSERT INTO memories (workspace_id, category, content, source_story_id, source_spec_id, source_run_id, confidence, related_files, source_type, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        workspaceId,
        category,
        `${title}: ${rule}`,
        inferredStoryId,
        resolvedSourceSpecId,
        normalizedSourceRunId,
        'high',
        JSON.stringify(resolvedRelatedFiles),
        resolvedSourceType,
        source ?? null,
      ],
    );
    insertedId = row?.id;
  }

  if (insertedId) {
    await emitMemoryCreatedWalEvent({
      workspaceId,
      memoryId: insertedId,
      category,
      content: `${title}: ${rule}`,
      storyId: inferredStoryId,
      specId: resolvedSourceSpecId,
      relatedFiles: resolvedRelatedFiles,
    });
  }

  invalidateMemory(workspaceId); // PG-013
  res.status(201).json({ entry, total: entries.length });
});

/**
 * @swagger
 * /api/memory/entry:
 *   put:
 *     tags: [Memory]
 *     summary: Update an existing memory entry
 *     operationId: updateMemoryEntry
 *     description: Updates an existing memory entry identified by date and title with the provided field changes.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, date, title]
 *             properties:
 *               workspaceId: { type: string }
 *               date: { type: string, description: "YYYY-MM-DD entry date" }
 *               title: { type: string, description: "Existing entry title to match" }
 *               updates:
 *                 type: object
 *                 description: Fields to update
 *                 properties:
 *                   rule: { type: string }
 *                   context: { type: string }
 *                   category: { type: string }
 *                   title: { type: string }
 *     responses:
 *       200:
 *         description: Entry updated — returns all entries
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 items: { type: array, items: { type: object } }
 *                 total: { type: integer }
 *       400: { description: "Missing required fields" }
 *       404: { description: "Workspace or entry not found" }
 */
router.put('/entry', async (req: Request, res: Response) => {
  const { workspaceId, date, title, updates } = req.body;

  if (!workspaceId || !date || !title) {
    throw new ValidationError('workspaceId, date, and title are required');
  }

  if (updates?.category && !MEMORY_CATEGORIES.includes(updates.category as MemoryCategory)) {
    throw new ValidationError(`Invalid category. Must be one of: ${MEMORY_CATEGORIES.join(', ')}`);
  }

  const wsPath = await getWorkspacePath(workspaceId);
  if (!wsPath) throw new NotFoundError('Workspace not found');

  const result = updateEntry(wsPath, date, title, updates ?? {}, getLedgerPath(workspaceId));
  if (!result) throw new NotFoundError('Entry not found');

  invalidateMemory(workspaceId); // PG-013
  res.json({ items: result, total: result.length });
});

/**
 * @swagger
 * /api/memory/entry:
 *   delete:
 *     tags: [Memory]
 *     summary: Delete a memory entry by date + title
 *     operationId: deleteMemoryEntry
 *     description: Removes a specific memory entry from the MEMORY.md ledger, identified by its date and title.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, date, title]
 *             properties:
 *               workspaceId: { type: string }
 *               date: { type: string, description: "YYYY-MM-DD entry date" }
 *               title: { type: string, description: "Entry title to delete" }
 *     responses:
 *       200:
 *         description: Entry deleted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 deleted: { type: boolean }
 *       400: { description: "Missing required fields" }
 *       404: { description: "Workspace or entry not found" }
 */
router.delete('/entry', async (req: Request, res: Response) => {
  const { workspaceId, date, title } = req.body;

  if (!workspaceId || !date || !title) {
    throw new ValidationError('workspaceId, date, and title are required');
  }

  const wsPath = await getWorkspacePath(workspaceId);
  if (!wsPath) throw new NotFoundError('Workspace not found');

  const removed = deleteEntry(wsPath, date, title, getLedgerPath(workspaceId));
  if (!removed) throw new NotFoundError('Entry not found');

  invalidateMemory(workspaceId); // PG-013
  res.json({ deleted: true });
});

/**
 * @swagger
 * /api/memory/proposals:
 *   get:
 *     tags: [Memory]
 *     summary: List memory proposals for a workspace
 *     operationId: listMemoryProposals
 *     description: Returns persisted proposals from memory_proposals table. Defaults to pending status. Supports filtering by status and run ID.
 *     parameters:
 *       - name: workspaceId
 *         in: query
 *         required: true
 *         schema: { type: string }
 *       - name: status
 *         in: query
 *         schema: { type: string, enum: [pending, approved, rejected, dismissed] }
 *         description: Filter by status (defaults to pending)
 *       - name: runId
 *         in: query
 *         schema: { type: integer }
 *         description: Filter by pipeline run ID
 *     responses:
 *       200:
 *         description: Memory proposals list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 items:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       proposalId: { type: string }
 *                       runId: { type: integer }
 *                       date: { type: string }
 *                       category: { type: string }
 *                       title: { type: string }
 *                       rule: { type: string }
 *                       context: { type: string }
 *                       source: { type: string }
 *                       sourceType: { type: string, enum: [synthesis], description: "Always synthesis for proposals" }
 *                       status: { type: string }
 *                       proposedAt: { type: string }
 *                       resolvedAt: { type: string, nullable: true }
 *                 total: { type: integer }
 *       400: { description: "Missing workspaceId" }
 */
router.get('/proposals', async (req: Request, res: Response) => {
  const { workspaceId, status, runId } = req.query;
  if (!workspaceId) throw new ValidationError('workspaceId required');

  let sql = 'SELECT * FROM memory_proposals WHERE workspace_id = $1';
  const params: (string | number)[] = [workspaceId as string];
  let paramIndex = 2;

  if (status) {
    sql += ` AND status = $${paramIndex}`;
    params.push(status as string);
    paramIndex++;
  } else {
    sql += " AND status = 'pending'";
  }

  if (runId) {
    sql += ` AND run_id = $${paramIndex}`;
    params.push(parseInt(runId as string, 10));
    paramIndex++;
  }

  sql += ' ORDER BY proposed_at DESC';

  const rows = await dbQuery<{
    id: number;
    proposal_id: string;
    run_id: number;
    workspace_id: string;
    category: string;
    title: string;
    rule: string;
    context: string;
    source_story: string;
    status: string;
    proposed_at: string;
    resolved_at: string | null;
  }>(sql, params);

  const items = rows.map(r => ({
    proposalId: r.proposal_id,
    runId: r.run_id,
    date: r.proposed_at.slice(0, 10),
    category: r.category,
    title: r.title,
    rule: r.rule,
    context: r.context,
    source: r.source_story,
    sourceType: 'synthesis' as SourceType,
    status: r.status,
    proposedAt: r.proposed_at,
    resolvedAt: r.resolved_at,
  }));

  res.json({ items, total: items.length });
});

/**
 * @swagger
 * /api/memory/proposals:
 *   post:
 *     tags: [Memory]
 *     summary: Approve, reject, or edit memory proposals
 *     operationId: resolveMemoryProposals
 *     description: Processes an array of proposal actions (approve, reject, or edit) and updates both the MEMORY.md ledger and the database accordingly. Approved and edited entries are immediately appended to MEMORY.md.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, proposals]
 *             properties:
 *               workspaceId: { type: string }
 *               proposals:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [proposalId, action, entry]
 *                   properties:
 *                     proposalId: { type: string }
 *                     action: { type: string, enum: [approve, reject, edit] }
 *                     entry:
 *                       type: object
 *                       properties:
 *                         date: { type: string }
 *                         category: { type: string }
 *                         title: { type: string }
 *                         rule: { type: string }
 *                         context: { type: string }
 *                         source: { type: string }
 *                     edits:
 *                       type: object
 *                       description: Override fields when action is 'edit'
 *                       properties:
 *                         rule: { type: string }
 *                         context: { type: string }
 *                         category: { type: string }
 *                         title: { type: string }
 *     responses:
 *       200:
 *         description: Proposal results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 results:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       proposalId: { type: string }
 *                       action: { type: string }
 *                       success: { type: boolean }
 *       400: { description: "Missing workspaceId or proposals array" }
 *       404: { description: "Workspace not found" }
 */
router.post('/proposals', async (req: Request, res: Response) => {
  const { workspaceId, proposals } = req.body as {
    workspaceId: string;
    proposals: Array<{
      proposalId: string;
      action: 'approve' | 'reject' | 'edit';
      entry: MemoryEntry;
      edits?: Partial<Pick<MemoryEntry, 'rule' | 'context' | 'category' | 'title'>>;
    }>;
  };

  if (!workspaceId || !proposals || !Array.isArray(proposals)) {
    throw new ValidationError('workspaceId and proposals array required');
  }

  const wsPath = await getWorkspacePath(workspaceId);
  if (!wsPath) throw new NotFoundError('Workspace not found');

  const ledgerPath = getLedgerPath(workspaceId);
  const results: Array<{ proposalId: string; action: string; success: boolean }> = [];

  for (const p of proposals) {
    const proposalMetadata = p.action === 'reject'
      ? null
      : await queryOne<{ source_story: string | null; run_id: number | string | null }>(
        `SELECT source_story, run_id FROM memory_proposals WHERE proposal_id = $1 AND workspace_id = $2`,
        [p.proposalId, workspaceId],
      );
    const proposalStoryId = proposalMetadata?.source_story ?? inferStoryIdFromSource(p.entry.source ?? '');
    const proposalRunId = toRunId(proposalMetadata?.run_id);
    const proposalProvenance = await resolveStoryMemoryProvenance(proposalRunId, proposalStoryId);

    if (p.action === 'approve') {
      const entryToAppend: MemoryEntry = {
        ...p.entry,
        date: p.entry.date || todayDate(),
      };
      append(wsPath, entryToAppend, ledgerPath);
      await execute(
        `UPDATE memory_proposals SET status = $1, resolved_at = NOW() WHERE proposal_id = $2 AND workspace_id = $3`,
        ['approved', p.proposalId, workspaceId]
      );

      // Also insert into memories DB table with source_type='synthesis' (proposals originate from synthesis)
      let embedding: number[] | null = null;
      try {
        const prepared = prepareText('memory', `${entryToAppend.title}: ${entryToAppend.rule}`);
        embedding = await embedText(prepared);
      } catch {
        // Embedding failure is non-fatal
      }
      const embeddingStr = embedding ? `[${embedding.join(',')}]` : null;
      let proposalRow: { id: string } | undefined;
      if (embeddingStr) {
        try {
          proposalRow = await queryOne<{ id: string }>(
            `INSERT INTO memories (workspace_id, category, content, source_story_id, source_spec_id, source_run_id, confidence, related_files, embedding, source_type, source)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector, $10, $11) RETURNING id`,
            [
              workspaceId,
              entryToAppend.category,
              `${entryToAppend.title}: ${entryToAppend.rule}`,
              proposalStoryId,
              proposalProvenance.sourceSpecId,
              proposalRunId,
              'high',
              JSON.stringify(proposalProvenance.relatedFiles),
              embeddingStr,
              'synthesis',
              entryToAppend.source || null,
            ],
          );
        } catch {
          // embedding column may not exist (pgvector not installed) — fall through
        }
      }
      if (!proposalRow) {
        proposalRow = await queryOne<{ id: string }>(
          `INSERT INTO memories (workspace_id, category, content, source_story_id, source_spec_id, source_run_id, confidence, related_files, source_type, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
          [
            workspaceId,
            entryToAppend.category,
            `${entryToAppend.title}: ${entryToAppend.rule}`,
            proposalStoryId,
            proposalProvenance.sourceSpecId,
            proposalRunId,
            'high',
            JSON.stringify(proposalProvenance.relatedFiles),
            'synthesis',
            entryToAppend.source || null,
          ],
        );
      }
      if (proposalRow?.id) {
        await emitMemoryCreatedWalEvent({
          workspaceId,
          memoryId: proposalRow.id,
          category: entryToAppend.category,
          content: `${entryToAppend.title}: ${entryToAppend.rule}`,
          storyId: proposalStoryId,
          specId: proposalProvenance.sourceSpecId,
          relatedFiles: proposalProvenance.relatedFiles,
        });
      }

      results.push({ proposalId: p.proposalId, action: 'approve', success: true });
    } else if (p.action === 'reject') {
      logRejected(wsPath, p.entry, p.proposalId);
      await execute(
        `UPDATE memory_proposals SET status = $1, resolved_at = NOW() WHERE proposal_id = $2 AND workspace_id = $3`,
        ['rejected', p.proposalId, workspaceId]
      );
      results.push({ proposalId: p.proposalId, action: 'reject', success: true });
    } else if (p.action === 'edit') {
      const edited: MemoryEntry = {
        ...p.entry,
        ...p.edits,
        date: p.entry.date || todayDate(),
      };
      append(wsPath, edited, ledgerPath);
      // Also update the DB row with the edited content
      await execute(
        `UPDATE memory_proposals SET status = 'approved', resolved_at = NOW(), title = $1, rule = $2, context = $3, category = $4 WHERE proposal_id = $5 AND workspace_id = $6`,
        [edited.title, edited.rule, edited.context, edited.category, p.proposalId, workspaceId]
      );

      // Insert into memories DB table with source_type='synthesis' (edited proposals still originate from synthesis)
      let editEmbedding: number[] | null = null;
      try {
        const prepared = prepareText('memory', `${edited.title}: ${edited.rule}`);
        editEmbedding = await embedText(prepared);
      } catch {
        // Embedding failure is non-fatal
      }
      const editEmbeddingStr = editEmbedding ? `[${editEmbedding.join(',')}]` : null;
      let proposalRow: { id: string } | undefined;
      if (editEmbeddingStr) {
        proposalRow = await queryOne<{ id: string }>(
          `INSERT INTO memories (workspace_id, category, content, source_story_id, source_spec_id, source_run_id, confidence, related_files, embedding, source_type, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector, $10, $11) RETURNING id`,
          [
            workspaceId,
            edited.category,
            `${edited.title}: ${edited.rule}`,
            proposalStoryId,
            proposalProvenance.sourceSpecId,
            proposalRunId,
            'high',
            JSON.stringify(proposalProvenance.relatedFiles),
            editEmbeddingStr,
            'synthesis',
            edited.source || null,
          ],
        );
      } else {
        proposalRow = await queryOne<{ id: string }>(
          `INSERT INTO memories (workspace_id, category, content, source_story_id, source_spec_id, source_run_id, confidence, related_files, source_type, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
          [
            workspaceId,
            edited.category,
            `${edited.title}: ${edited.rule}`,
            proposalStoryId,
            proposalProvenance.sourceSpecId,
            proposalRunId,
            'high',
            JSON.stringify(proposalProvenance.relatedFiles),
            'synthesis',
            edited.source || null,
          ],
        );
      }

      if (proposalRow?.id) {
        await emitMemoryCreatedWalEvent({
          workspaceId,
          memoryId: proposalRow.id,
          category: edited.category,
          content: `${edited.title}: ${edited.rule}`,
          storyId: proposalStoryId,
          specId: proposalProvenance.sourceSpecId,
          relatedFiles: proposalProvenance.relatedFiles,
        });
      }

      results.push({ proposalId: p.proposalId, action: 'edit', success: true });
    }
  }

  res.json({ results });
});

/**
 * @swagger
 * /api/memory/proposals/dismiss:
 *   post:
 *     tags: [Memory]
 *     summary: Dismiss memory proposals
 *     operationId: dismissMemoryProposals
 *     description: Marks the specified proposals as dismissed so they no longer appear in the pending review queue. Dismissed proposals can be restored via /undismiss.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, proposalIds]
 *             properties:
 *               workspaceId: { type: string }
 *               proposalIds: { type: array, items: { type: string }, description: "Proposal IDs to dismiss" }
 *     responses:
 *       200:
 *         description: Proposals dismissed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 dismissed: { type: integer, description: "Number of proposals dismissed" }
 *       400: { description: "Missing workspaceId or proposalIds" }
 */
router.post('/proposals/dismiss', async (req: Request, res: Response) => {
  const { workspaceId, proposalIds } = req.body as {
    workspaceId: string;
    proposalIds: string[];
  };

  if (!workspaceId || !proposalIds || !Array.isArray(proposalIds)) {
    throw new ValidationError('workspaceId and proposalIds array required');
  }

  let dismissed = 0;
  for (const id of proposalIds) {
    const r = await execute(
      `UPDATE memory_proposals SET status = 'dismissed', resolved_at = NOW() WHERE proposal_id = $1 AND workspace_id = $2`,
      [id, workspaceId]
    );
    dismissed += r.rowCount;
  }

  res.json({ dismissed });
});

/**
 * @swagger
 * /api/memory/proposals/undismiss:
 *   post:
 *     tags: [Memory]
 *     summary: Restore dismissed proposals back to pending
 *     operationId: undismissMemoryProposals
 *     description: Restores previously dismissed proposals back to pending status. If proposalIds is omitted, restores all dismissed proposals for the workspace.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId: { type: string }
 *               proposalIds: { type: array, items: { type: string }, description: "Specific proposal IDs to restore. Omit to restore all dismissed." }
 *     responses:
 *       200:
 *         description: Proposals restored
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 restored: { type: integer, description: "Number of proposals restored to pending" }
 *       400: { description: "Missing workspaceId" }
 */
router.post('/proposals/undismiss', async (req: Request, res: Response) => {
  const { workspaceId, proposalIds } = req.body as {
    workspaceId: string;
    proposalIds?: string[];
  };

  if (!workspaceId) {
    throw new ValidationError('workspaceId required');
  }

  let restored = 0;
  if (proposalIds && proposalIds.length > 0) {
    for (const id of proposalIds) {
      const r = await execute(
        `UPDATE memory_proposals SET status = 'pending', resolved_at = NULL WHERE proposal_id = $1 AND workspace_id = $2 AND status = 'dismissed'`,
        [id, workspaceId]
      );
      restored += r.rowCount;
    }
  } else {
    // Restore all dismissed for this workspace
    const r = await execute(
      `UPDATE memory_proposals SET status = 'pending', resolved_at = NULL WHERE workspace_id = $1 AND status = 'dismissed'`,
      [workspaceId]
    );
    restored = r.rowCount;
  }

  res.json({ restored });
});

/**
 * @swagger
 * /api/memory/rejected:
 *   get:
 *     tags: [Memory]
 *     summary: List rejected memory entries
 *     operationId: listRejectedMemoryEntries
 *     description: Returns all previously rejected memory entries for the given workspace from the rejected log file (MEMORY_REJECTED.md).
 *     parameters:
 *       - name: workspaceId
 *         in: query
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Rejected entries list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 items: { type: array, items: { type: object } }
 *                 total: { type: integer }
 *       400: { description: "Missing workspaceId" }
 *       404: { description: "Workspace not found" }
 */
router.get('/rejected', async (req: Request, res: Response) => {
  const { workspaceId } = req.query;
  if (!workspaceId) throw new ValidationError('workspaceId required');

  const wsPath = await getWorkspacePath(workspaceId as string);
  if (!wsPath) throw new NotFoundError('Workspace not found');

  const rejected = readRejected(wsPath);
  res.json({ items: rejected, total: rejected.length });
});

/**
 * @swagger
 * /api/memory/context:
 *   get:
 *     tags: [Memory]
 *     summary: Get memory context snippet for agent prompt injection
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Memory context snippets are read-only project intelligence used by local agents and MCP clients."
 *     x-rorca-public-api: true
 *     operationId: getMemoryContextSnippet
 *     description: Generates a formatted context snippet from recent memory entries suitable for injection into agent prompts. Returns a compact markdown section with token estimate.
 *     parameters:
 *       - name: workspaceId
 *         in: query
 *         required: true
 *         schema: { type: string }
 *       - name: n
 *         in: query
 *         schema: { type: integer, default: 20 }
 *         description: Number of recent entries to include
 *     responses:
 *       200:
 *         description: Context snippet
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 snippet: { type: string, description: "Formatted markdown snippet for prompt injection" }
 *                 tokenEstimate: { type: integer, description: "Approximate token count (length/4)" }
 *       400: { description: "Missing workspaceId" }
 *       404: { description: "Workspace not found" }
 */
router.get('/context', async (req: Request, res: Response) => {
  const { workspaceId, n } = req.query;
  if (!workspaceId) throw new ValidationError('workspaceId required');

  const wsPath = await getWorkspacePath(workspaceId as string);
  if (!wsPath) throw new NotFoundError('Workspace not found');

  const snippet = getContextSnippet(wsPath, parseInt(n as string, 10) || 20, getLedgerPath(workspaceId as string));
  res.json({ snippet, tokenEstimate: Math.ceil(snippet.length / 4) });
});

/**
 * @swagger
 * /api/memory/graph/overview:
 *   get:
 *     tags: [Memory]
 *     summary: Get a bounded workspace memory ontology overview graph
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Workspace-scoped memory graph overviews are read-only operator context with no write or admin side effects."
 *     x-rorca-public-api: true
 *     operationId: getMemoryGraphOverview
 *     description: Returns a deterministic, normalized workspace overview graph using only the V1 explicit edge set and query-layer caps.
 *     parameters:
 *       - name: workspaceId
 *         in: query
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Overview graph or graceful available:false fallback
 *       400: { description: "Missing workspaceId" }
 *       404: { description: "Workspace not found" }
 */
router.get('/graph/overview', async (req: Request, res: Response) => {
  const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId.trim() : '';
  if (!workspaceId) throw new ValidationError('workspaceId required');

  const wsPath = await getWorkspacePath(workspaceId);
  if (!wsPath) throw new NotFoundError('Workspace not found');

  const graph = await getMemoryGraphOverview(workspaceId);
  res.json(graph);
});

/**
 * @swagger
 * /api/memory/graph/neighborhood:
 *   get:
 *     tags: [Memory]
 *     summary: Get a bounded selected-memory neighborhood graph
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Selected-memory graph neighborhoods are read-only workspace context for local automation and UI rendering."
 *     x-rorca-public-api: true
 *     operationId: getMemoryGraphNeighborhood
 *     description: Returns a deterministic, normalized neighborhood graph for a selected memory using only the V1 explicit edge set and query-layer caps.
 *     parameters:
 *       - name: workspaceId
 *         in: query
 *         required: true
 *         schema: { type: string }
 *       - name: memoryId
 *         in: query
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Neighborhood graph or graceful available:false fallback
 *       400: { description: "Missing workspaceId or memoryId" }
 *       404: { description: "Workspace or memory not found" }
 */
router.get('/graph/neighborhood', async (req: Request, res: Response) => {
  const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId.trim() : '';
  const memoryId = typeof req.query.memoryId === 'string' ? req.query.memoryId.trim() : '';

  if (!workspaceId) throw new ValidationError('workspaceId required');
  if (!memoryId) throw new ValidationError('memoryId required');

  const wsPath = await getWorkspacePath(workspaceId);
  if (!wsPath) throw new NotFoundError('Workspace not found');

  await assertMemoryInWorkspace(workspaceId, memoryId);

  const graph = await getMemoryGraphNeighborhood(workspaceId, memoryId);
  res.json(graph);
});

/**
 * @swagger
 * /api/memory/relations:
 *   get:
 *     tags: [Memory]
 *     summary: List memory-to-memory ontology relations
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Workspace-scoped ontology relation listing is read-only local project context with no billing or admin side effects."
 *     x-rorca-public-api: true
 *     operationId: listMemoryRelations
 *     parameters:
 *       - name: workspaceId
 *         in: query
 *         required: true
 *         schema: { type: string }
 *       - name: memoryId
 *         in: query
 *         schema: { type: integer }
 *       - name: includeInactive
 *         in: query
 *         schema: { type: boolean, default: false }
 *     responses:
 *       200: { description: Relations list }
 *       400: { description: "Missing workspaceId or invalid memoryId" }
 *       404: { description: "Workspace not found" }
 */
router.get('/relations', async (req: Request, res: Response) => {
  const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId.trim() : '';
  if (!workspaceId) throw new ValidationError('workspaceId required');

  const wsPath = await getWorkspacePath(workspaceId);
  if (!wsPath) throw new NotFoundError('Workspace not found');

  const memoryId = req.query.memoryId !== undefined
    ? parsePositiveInteger(req.query.memoryId as string, 'memoryId')
    : undefined;

  const items = await listMemoryRelations({
    workspaceId,
    memoryId,
    includeInactive: req.query.includeInactive === 'true',
  });

  res.json({
    items,
    total: items.length,
    relationTypes: MEMORY_RELATION_TYPES,
    relationSemantics: MEMORY_RELATION_SEMANTICS,
  });
});

/**
 * @swagger
 * /api/memory/relations:
 *   post:
 *     tags: [Memory]
 *     summary: Create or restore a canonical memory-to-memory ontology relation
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Persisting workspace ontology links is core local project memory management with relational truth in Postgres before graph projection."
 *     x-rorca-public-api: true
 *     operationId: createMemoryRelation
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, sourceMemoryId, targetMemoryId, relationType]
 *             properties:
 *               workspaceId: { type: string }
 *               sourceMemoryId: { type: integer }
 *               targetMemoryId: { type: integer }
 *               relationType: { type: string, enum: [SUPERSEDES, CONFLICTS_WITH] }
 *               note: { type: string, nullable: true }
 *     responses:
 *       201: { description: Relation created or restored }
 *       400: { description: "Invalid input" }
 *       404: { description: "Workspace or memory not found" }
 *       409: { description: "An active canonical relation already exists" }
 */
router.post('/relations', async (req: Request, res: Response) => {
  const { workspaceId, sourceMemoryId, targetMemoryId, relationType, note } = req.body as {
    workspaceId?: string;
    sourceMemoryId?: number | string;
    targetMemoryId?: number | string;
    relationType?: string;
    note?: string | null;
  };

  if (!workspaceId) throw new ValidationError('workspaceId required');
  if (sourceMemoryId === undefined || targetMemoryId === undefined || !relationType) {
    throw new ValidationError('sourceMemoryId, targetMemoryId, and relationType are required');
  }

  const parsedSourceMemoryId = parsePositiveInteger(sourceMemoryId, 'sourceMemoryId');
  const parsedTargetMemoryId = parsePositiveInteger(targetMemoryId, 'targetMemoryId');
  assertMemoryRelationType(relationType);

  if (parsedSourceMemoryId === parsedTargetMemoryId) {
    if (relationType === 'SUPERSEDES') {
      throw new ValidationError('A memory cannot supersede itself');
    }
    throw new ValidationError('Memory relations require two distinct memories');
  }

  const wsPath = await getWorkspacePath(workspaceId);
  if (!wsPath) throw new NotFoundError('Workspace not found');

  const relation = await createMemoryRelation({
    workspaceId,
    sourceMemoryId: parsedSourceMemoryId,
    targetMemoryId: parsedTargetMemoryId,
    relationType,
    note,
  });

  res.status(201).json({ relation, semantics: MEMORY_RELATION_SEMANTICS[relation.relationType] });
});

/**
 * @swagger
 * /api/memory/relations/{id}:
 *   patch:
 *     tags: [Memory]
 *     summary: Update a memory relation lifecycle state
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Operators may archive or restore workspace-scoped ontology relations while preserving relational truth and audit history."
 *     x-rorca-public-api: true
 *     operationId: updateMemoryRelationStatus
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, status]
 *             properties:
 *               workspaceId: { type: string }
 *               status: { type: string, enum: [active, superseded, deleted] }
 *     responses:
 *       200: { description: Relation updated }
 *       404: { description: "Relation not found" }
 */
router.patch('/relations/:id', async (req: Request, res: Response) => {
  const relationId = parsePositiveInteger(req.params.id as string, 'relationId');

  const { workspaceId, status } = req.body as {
    workspaceId?: string;
    status?: string;
  };

  if (!workspaceId || !status) {
    throw new ValidationError('workspaceId and status are required');
  }

  assertMemoryRelationStatus(status);

  const wsPath = await getWorkspacePath(workspaceId);
  if (!wsPath) throw new NotFoundError('Workspace not found');

  const relation = await updateMemoryRelationStatus(
    workspaceId,
    relationId,
    status,
  );

  res.json({ relation, semantics: MEMORY_RELATION_SEMANTICS[relation.relationType] });
});

/**
 * @swagger
 * /api/memory/relations/{id}:
 *   delete:
 *     tags: [Memory]
 *     summary: Soft-delete a memory relation while preserving audit history
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Relation removal is a workspace-scoped ontology curation action that should preserve auditability via soft-state rather than hard deletion."
 *     x-rorca-public-api: true
 *     operationId: deleteMemoryRelation
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId: { type: string }
 *     responses:
 *       200: { description: Relation soft-deleted }
 *       404: { description: "Relation not found" }
 */
router.delete('/relations/:id', async (req: Request, res: Response) => {
  const relationId = parsePositiveInteger(req.params.id as string, 'relationId');

  const { workspaceId } = req.body as {
    workspaceId?: string;
  };

  if (!workspaceId) {
    throw new ValidationError('workspaceId is required');
  }

  const wsPath = await getWorkspacePath(workspaceId);
  if (!wsPath) throw new NotFoundError('Workspace not found');

  const relation = await updateMemoryRelationStatus(workspaceId, relationId, 'deleted');

  res.json({ relation, semantics: MEMORY_RELATION_SEMANTICS[relation.relationType] });
});

/**
 * @swagger
 * /api/memory/categories:
 *   get:
 *     tags: [Memory]
 *     summary: List available memory categories
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Memory category discovery is read-only schema metadata for local automation and MCP callers."
 *     x-rorca-public-api: true
 *     operationId: listMemoryCategories
 *     description: Returns the list of valid memory entry categories that can be used when creating or filtering entries.
 *     responses:
 *       200:
 *         description: Available categories
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 categories:
 *                   type: array
 *                   items: { type: string }
 *                   example: [Architecture, Convention, "Bug Fix", Decision, Pattern, Gotcha]
 */
router.get('/categories', (_req: Request, res: Response) => {
  res.json({ categories: MEMORY_CATEGORIES });
});

/**
 * @swagger
 * /api/memory/archive/count:
 *   get:
 *     tags: [Memory]
 *     summary: Get archived entry count for a workspace
 *     operationId: getMemoryArchiveCount
 *     description: Returns the number of entries in the MEMORY_ARCHIVE.md file for the given workspace.
 *     parameters:
 *       - name: workspaceId
 *         in: query
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Archive entry count
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 count: { type: integer, description: "Number of entries in MEMORY_ARCHIVE.md" }
 *       400: { description: "Missing workspaceId" }
 *       404: { description: "Workspace not found" }
 */
router.get('/archive/count', async (req: Request, res: Response) => {
  const { workspaceId } = req.query;
  if (!workspaceId) throw new ValidationError('workspaceId required');

  const wsPath = await getWorkspacePath(workspaceId as string);
  if (!wsPath) throw new NotFoundError('Workspace not found');

  const count = countArchiveEntries(wsPath);
  res.json({ count });
});

/**
 * @swagger
 * /api/memory/rotate:
 *   post:
 *     tags: [Memory]
 *     summary: Rotate old memory entries to archive
 *     operationId: rotateMemoryEntries
 *     description: |
 *       Moves old or excess entries from MEMORY.md to .rorca/memory/MEMORY_ARCHIVE.md.
 *       Architecture and Convention entries are never rotated (permanent project knowledge).
 *       Rotation triggers based on: entry age (MEMORY_RETENTION_DAYS, default 30),
 *       max entry count (MEMORY_MAX_ENTRIES, default 200), or token budget (8000 tokens).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId: { type: string }
 *               retentionDays: { type: number, description: "Days before entries are eligible for rotation (default 30)" }
 *               maxEntries: { type: number, description: "Max active entries cap (default 200)" }
 *               tokenBudget: { type: number, description: "Target token budget (default 8000)" }
 *     responses:
 *       200:
 *         description: Rotation result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 rotated: { type: integer }
 *                 remaining: { type: integer }
 *                 archived: { type: integer }
 *       400: { description: "Missing workspaceId" }
 *       404: { description: "Workspace not found" }
 */
router.post('/rotate', async (req: Request, res: Response) => {
  const { workspaceId, retentionDays, maxEntries, tokenBudget } = req.body;
  if (!workspaceId) throw new ValidationError('workspaceId required');

  const wsPath = await getWorkspacePath(workspaceId);
  if (!wsPath) throw new NotFoundError('Workspace not found');

  const result = rotateMemory(wsPath, {
    retentionDays: retentionDays !== undefined ? Number(retentionDays) : undefined,
    maxEntries: maxEntries !== undefined ? Number(maxEntries) : undefined,
    tokenBudget: tokenBudget !== undefined ? Number(tokenBudget) : undefined,
  });

  res.json(result);
});

/**
 * @swagger
 * /api/memory/synthesize-from-run/{runId}:
 *   post:
 *     tags: [Memory]
 *     summary: Synthesize memory proposals from a pipeline run
 *     operationId: synthesizeMemoryFromRun
 *     description: |
 *       Analyzes WAL events for the specified run and generates candidate memory entries.
 *       Entries are deduplicated against existing memory, persisted as proposals in the
 *       memory_proposals table, and broadcast via SSE. User can then approve/reject proposals.
 *     parameters:
 *       - name: runId
 *         in: path
 *         required: true
 *         schema: { type: integer }
 *         description: Pipeline run ID to analyze
 *     responses:
 *       200:
 *         description: Generated proposals
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 proposals:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       proposalId: { type: string }
 *                       date: { type: string }
 *                       category: { type: string }
 *                       title: { type: string }
 *                       rule: { type: string }
 *                       context: { type: string }
 *                       source: { type: string }
 *                       status: { type: string }
 *                 total: { type: integer }
 *       400: { description: "Invalid runId" }
 *       404: { description: "Run not found" }
 */
// POST /api/memory/synthesize — synthesize memory proposals from all recent runs for a workspace
router.post('/synthesize', async (req: Request, res: Response) => {
  const { workspaceId } = req.body;
  if (!workspaceId) throw new ValidationError('workspaceId is required');

  // Find recent completed runs for this workspace (last 10)
  const runs = await dbQuery<{ id: number }>(
    `SELECT id FROM pipeline_runs WHERE workspace_id = $1 AND status IN ('passed','failed','finished')
     ORDER BY finished_at DESC LIMIT 10`,
    [String(workspaceId)]
  );

  if (runs.length === 0) {
    return res.json({ proposals: [], total: 0 });
  }

  const allProposals: Array<{
    proposalId: string; date: string; category: string;
    title: string; rule: string; context: string; source: string; status: string;
  }> = [];
  const today = new Date().toISOString().slice(0, 10);

  for (const run of runs) {
    const candidates = await analyzeRunEvents(run.id);
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const proposalId = `wal-feedback-${run.id}-${i}`;
      await execute(
        `INSERT INTO memory_proposals (proposal_id, run_id, workspace_id, category, title, rule, context, source_story, status, proposed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', NOW())
         ON CONFLICT DO NOTHING`,
        [proposalId, run.id, String(workspaceId), c.category, c.title, c.rule, c.context, c.source]
      );
      allProposals.push({
        proposalId, date: today, category: c.category,
        title: c.title, rule: c.rule, context: c.context,
        source: c.source, status: 'pending',
      });
    }
  }

  if (allProposals.length > 0) {
    const walPayload = JSON.stringify({ workspace_id: workspaceId, proposals: allProposals });
    const walRow = await queryOne<{ id: number }>(
      `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('memory_proposals', $1, $2) RETURNING id`,
      [String(workspaceId), walPayload]
    );
    broadcastAll({
      id: walRow?.id ?? 0,
      ts: new Date().toISOString(),
      event_type: 'memory_proposals',
      workspace_id: String(workspaceId),
      spec_id: null, story_id: null, actor: 'system',
      payload: walPayload,
    });
  }

  res.json({ proposals: allProposals, total: allProposals.length });
});

/**
 * @swagger
 * /api/memory/synthesize-from-run/{runId}:
 *   post:
 *     tags: [Context Files]
 *     summary: Synthesize memory proposals from a pipeline run
 *     operationId: synthesizeMemoryFromRun
 *     description: >
 *       Analyzes WAL events and story results from a completed pipeline run and
 *       generates memory proposals (structured entries for MEMORY.md). Proposals
 *       are not automatically saved — they must be accepted via POST /api/memory/proposals/:id/accept.
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema:
 *           type: integer
 *         description: Pipeline run ID to synthesize memory from
 *         example: 42
 *     responses:
 *       200:
 *         description: Memory proposals generated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 proposals:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       proposalId: { type: string }
 *                       date: { type: string, format: date }
 *                       category:
 *                         type: string
 *                         enum: [Architecture, Convention, Bug Fix, Decision, Pattern, Gotcha]
 *                       title: { type: string }
 *                       rule: { type: string }
 *                       context: { type: string, nullable: true }
 *                       source: { type: string }
 *                       status:
 *                         type: string
 *                         enum: [pending, accepted, rejected]
 *                 total: { type: integer }
 *       400:
 *         description: Invalid runId (non-numeric)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Pipeline run not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/synthesize-from-run/:runId', async (req: Request, res: Response) => {
  const runId = parseInt(req.params.runId as string, 10);
  if (isNaN(runId)) throw new ValidationError('Invalid runId');

  const run = await queryOne<{ id: number; workspace_id: string; status: string }>(
    'SELECT id, workspace_id, status FROM pipeline_runs WHERE id = $1',
    [runId]
  );

  if (!run) throw new NotFoundError('Run not found');

  // Generate candidates from WAL event analysis
  const candidates = await analyzeRunEvents(runId);

  if (candidates.length === 0) {
    return res.json({ proposals: [], total: 0 });
  }

  // Persist as proposals in memory_proposals table
  const today = new Date().toISOString().slice(0, 10);

  const proposals = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const proposalId = `wal-feedback-${runId}-${i}`;
    await execute(
      `INSERT INTO memory_proposals (proposal_id, run_id, workspace_id, category, title, rule, context, source_story, status, proposed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', NOW())
       ON CONFLICT DO NOTHING`,
      [proposalId, runId, run.workspace_id, c.category, c.title, c.rule, c.context, c.source]
    );
    proposals.push({
      proposalId,
      date: today,
      category: c.category,
      title: c.title,
      rule: c.rule,
      context: c.context,
      source: c.source,
      status: 'pending',
    });
  }

  // Broadcast via SSE
  const walPayload = JSON.stringify({
    run_id: runId,
    workspace_id: run.workspace_id,
    proposals,
  });

  const walRow = await queryOne<{ id: number }>(
    `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('memory_proposals', $1, $2) RETURNING id`,
    [run.workspace_id, walPayload]
  );

  broadcastAll({
    id: walRow?.id ?? 0,
    ts: new Date().toISOString(),
    event_type: 'memory_proposals',
    workspace_id: run.workspace_id,
    spec_id: null,
    story_id: null,
    actor: 'system',
    payload: walPayload,
  });

  res.json({ proposals, total: proposals.length });
});

/**
 * @swagger
 * /api/memory/deduplicate:
 *   post:
 *     tags: [Memory]
 *     summary: Deduplicate memory entries using embedding similarity
 *     operationId: deduplicateMemory
 *     description: |
 *       Detects semantically duplicate memory entries using pgvector embedding similarity (>0.92 cosine threshold).
 *       When duplicates found: keeps the most recent entry, merges unique details from older entries.
 *       Falls back to Levenshtein distance comparison when vector search is unavailable.
 *       Use dryRun=true query param to preview what would be removed without modifying anything.
 *     parameters:
 *       - name: dryRun
 *         in: query
 *         schema: { type: boolean }
 *         description: If true, returns what would be removed without modifying anything
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId: { type: string }
 *     responses:
 *       200:
 *         description: Deduplication result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 removed: { type: integer, description: "Number of duplicate entries removed" }
 *                 merged: { type: integer, description: "Number of entries that absorbed details from duplicates" }
 *                 total: { type: integer, description: "Total entries remaining after deduplication" }
 *                 details:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       kept: { type: object, properties: { date: { type: string }, title: { type: string } } }
 *                       removed: { type: array, items: { type: object, properties: { date: { type: string }, title: { type: string } } } }
 *                       similarity: { type: number }
 *       400: { description: "Missing workspaceId" }
 *       404: { description: "Workspace not found" }
 */
router.post('/deduplicate', async (req: Request, res: Response) => {
  const { workspaceId } = req.body;
  if (!workspaceId) throw new ValidationError('workspaceId required');

  const wsPath = await getWorkspacePath(workspaceId);
  if (!wsPath) throw new NotFoundError('Workspace not found');

  const dryRun = req.query.dryRun === 'true';

  const result = await deduplicateMemory(wsPath, workspaceId, dryRun);
  res.json(result);
});

/**
 * @swagger
 * /api/memory/review:
 *   get:
 *     tags: [Memory]
 *     summary: List bounded stale-memory review candidates and hotspot summaries
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Workspace memory review queues are read-only operator context for local cleanup, audit, and retrieval explainability workflows."
 *     x-rorca-public-api: true
 *     operationId: listMemoryReviewQueue
 *     parameters:
 *       - name: workspaceId
 *         in: query
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Review candidates and hotspot summaries }
 *       400: { description: "Missing workspaceId" }
 *       404: { description: "Workspace not found" }
 */
router.get('/review', async (req: Request, res: Response) => {
  const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId.trim() : '';
  if (!workspaceId) throw new ValidationError('workspaceId required');

  const wsPath = await getWorkspacePath(workspaceId);
  if (!wsPath) throw new NotFoundError('Workspace not found');

  const ageAvailable = await checkAge();
  const staleRows = await loadStaleReviewCandidates(workspaceId);
  const recentActions = await loadMemoryReviewActionHistory(workspaceId);
  const latestActionByMemoryId = new Map(recentActions.map((action) => [action.memoryId, action]));

  const scoredCandidates = staleRows
    .map((row) => ({ row, review: buildStaleReviewReasons(row) }))
    .filter(({ review }) => review.staleScore >= STALE_REVIEW_SCORE_THRESHOLD)
    .sort((left, right) => right.review.staleScore - left.review.staleScore || left.row.updated_at.localeCompare(right.row.updated_at) || left.row.id - right.row.id);

  const candidateIds = scoredCandidates.map(({ row }) => row.id);
  const historyIds = recentActions.map((action) => action.memoryId);
  const reviewRows = await loadMemoryReviewRows(workspaceId, [...candidateIds, ...historyIds]);
  const memoryById = new Map(reviewRows.map((row) => [row.id, row]));

  const itemsMap = new Map<number, ReturnType<typeof mapMemoryReviewItem>>();

  for (const candidate of scoredCandidates) {
    const memoryRow = memoryById.get(candidate.row.id) ?? candidate.row;
    const latestAction = latestActionByMemoryId.get(candidate.row.id);
    itemsMap.set(candidate.row.id, mapMemoryReviewItem(memoryRow, candidate.review, latestAction));
  }

  for (const action of recentActions) {
    const memoryRow = memoryById.get(action.memoryId);
    if (!memoryRow) continue;
    const existing = itemsMap.get(action.memoryId);
    if (existing) {
      itemsMap.set(action.memoryId, {
        ...existing,
        status: statusForReviewAction(action.action, memoryRow.deleted_at),
        lastAction: {
          action: action.action,
          at: action.at,
          previousStatus: action.previousStatus,
          nextStatus: action.nextStatus,
        },
      });
      continue;
    }

    if (action.action === 'restore') continue;
    itemsMap.set(action.memoryId, mapMemoryReviewItem(memoryRow, null, action));
  }

  const reviewItems = [...itemsMap.values()]
    .sort((left, right) => {
      const order: Record<MemoryReviewCandidateStatus, number> = {
        candidate: 0,
        revisit: 1,
        kept: 2,
        archived: 3,
        deleted: 4,
      };
      const statusOrder = order[left.status] - order[right.status];
      if (statusOrder !== 0) return statusOrder;
      if (left.staleScore !== right.staleScore) return right.staleScore - left.staleScore;
      return right.updatedAt.localeCompare(left.updatedAt) || right.id - left.id;
    })
    .slice(0, STALE_REVIEW_RESULT_LIMIT + 6);

  const fileHotspots = mapHotspotItems(await loadHotspotRows(workspaceId, 'file'), 'file');
  const specHotspots = mapHotspotItems(await loadHotspotRows(workspaceId, 'spec'), 'spec');
  const fallbackReason = ageAvailable
    ? null
    : 'Apache AGE extension is unavailable. Review candidates and hotspots are using direct SQL provenance and relation fallbacks only.';

  res.json({
    available: true,
    staleCandidates: {
      items: reviewItems,
      total: reviewItems.length,
      truncated: scoredCandidates.length > STALE_REVIEW_RESULT_LIMIT,
      heuristics: {
        scanLimit: STALE_REVIEW_SCAN_LIMIT,
        resultLimit: STALE_REVIEW_RESULT_LIMIT,
        scoreThreshold: STALE_REVIEW_SCORE_THRESHOLD,
        staleAfterDays: STALE_REVIEW_DAYS,
        lowConfidenceAfterDays: STALE_LOW_CONFIDENCE_DAYS,
      },
      ageAvailable,
      mode: ageAvailable ? 'bounded-sql' : 'bounded-sql-fallback',
      reason: fallbackReason,
    },
    hotspots: {
      files: fileHotspots,
      specs: specHotspots,
      total: fileHotspots.length + specHotspots.length,
      truncated: fileHotspots.length >= HOTSPOT_RESULT_LIMIT || specHotspots.length >= HOTSPOT_RESULT_LIMIT,
      ageAvailable,
      mode: ageAvailable ? 'bounded-sql' : 'bounded-sql-fallback',
      reason: fallbackReason,
      windowSize: HOTSPOT_MEMORY_WINDOW,
      resultLimit: HOTSPOT_RESULT_LIMIT,
    },
  });
});

/**
 * @swagger
 * /api/memory/review/{id}/action:
 *   post:
 *     tags: [Memory]
 *     summary: Audit and apply a stale-memory review action
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Operators need auditable local memory curation actions that preserve provenance, soft-delete state, and restoration paths."
 *     x-rorca-public-api: true
 *     operationId: reviewMemoryCandidate
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, action]
 *             properties:
 *               workspaceId: { type: string }
 *               action: { type: string, enum: [archive, delete, keep, revisit, restore] }
 *     responses:
 *       200: { description: Reviewed memory candidate }
 *       400: { description: "Invalid input" }
 *       404: { description: "Memory not found" }
 */
router.post('/review/:id/action', async (req: Request, res: Response) => {
  const memoryId = parsePositiveInteger(req.params.id as string, 'memoryId');
  const { workspaceId, action } = req.body as { workspaceId?: string; action?: string };

  if (!workspaceId || !action) {
    throw new ValidationError('workspaceId and action are required');
  }

  const parsedAction = parseReviewAction(action);
  if (!parsedAction) {
    throw new ValidationError('action must be one of: archive, delete, keep, revisit, restore');
  }

  const wsPath = await getWorkspacePath(workspaceId);
  if (!wsPath) throw new NotFoundError('Workspace not found');

  const existing = await queryOne<MemoryReviewMemoryRow>(
    `SELECT id, workspace_id, category, content, source_story_id, source_spec_id, source_run_id,
            confidence, related_files, pinned, source_type, source, created_at, updated_at, deleted_at
       FROM memories
      WHERE id = $1
        AND workspace_id = $2`,
    [memoryId, workspaceId],
  );
  if (!existing) throw new NotFoundError('Memory not found');

  if (parsedAction === 'restore') {
    if (!existing.deleted_at) {
      throw new ValidationError('Only archived or deleted memories can be restored');
    }

    await execute('UPDATE memories SET deleted_at = NULL, updated_at = NOW() WHERE id = $1', [memoryId]);
    await emitMemoryWalEvent({
      eventType: 'memory_restored',
      workspaceId,
      memoryId: String(memoryId),
      category: existing.category,
      content: existing.content,
      storyId: existing.source_story_id,
      specId: existing.source_spec_id,
      relatedFiles: parseStringArray(existing.related_files),
    });
    await emitMemoryReviewWalEvent({
      workspaceId,
      memoryId,
      action: parsedAction,
      previousStatus: 'archived',
      nextStatus: 'candidate',
      memory: existing,
      staleScore: 0,
      reasons: [],
    });
    invalidateMemory(workspaceId);
    res.json({ ok: true, id: memoryId, action: parsedAction, status: 'candidate' });
    return;
  }

  if (existing.deleted_at) {
    throw new ValidationError('Restore this memory before applying another review action');
  }

  const review = buildStaleReviewReasons(existing as MemoryReviewCandidateRow);
  const previousStatus: MemoryReviewCandidateStatus = 'candidate';
  const nextStatus = statusForReviewAction(parsedAction, parsedAction === 'archive' || parsedAction === 'delete' ? new Date().toISOString() : null);

  if (parsedAction === 'archive' || parsedAction === 'delete') {
    await execute('UPDATE memories SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1', [memoryId]);
    await emitMemoryWalEvent({
      eventType: 'memory_deleted',
      workspaceId,
      memoryId: String(memoryId),
      category: existing.category,
      content: existing.content,
      storyId: existing.source_story_id,
      specId: existing.source_spec_id,
      relatedFiles: parseStringArray(existing.related_files),
    });
  } else if (parsedAction === 'keep') {
    await execute('UPDATE memories SET updated_at = NOW() WHERE id = $1', [memoryId]);
  }

  await emitMemoryReviewWalEvent({
    workspaceId,
    memoryId,
    action: parsedAction,
    previousStatus,
    nextStatus,
    memory: existing,
    staleScore: review.staleScore,
    reasons: review.reasons,
  });
  invalidateMemory(workspaceId);

  res.json({ ok: true, id: memoryId, action: parsedAction, status: nextStatus });
});

// ─── PG-022: DB-backed memory CRUD for curation ─────────────────────────────

/**
 * @swagger
 * /api/memory/items:
 *   get:
 *     tags: [Memory]
 *     summary: Paginated memory list — use for browsing, filtering, or "show me the last N memories"
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Paginated workspace memory browsing is a safe read-only surface for CLI and MCP workflows."
 *     x-rorca-public-api: true
 *     description: >
 *       USE THIS for paginated listing ("show last 50 memories", "list all Architecture memories", "memories from run #42").
 *       Returns memories sorted by pinned-first then newest, with category/confidence/run filters.
 *       This is keyword search only (PostgreSQL tsquery) — NOT semantic. For semantic search
 *       ("find memories related to deployment"), use getRecall with a query parameter instead.
 *       For cross-source search (specs + stories + memories together), use hybridSearch.
 *     operationId: listMemoryItems
 *     parameters:
 *       - name: workspaceId
 *         in: query
 *         required: true
 *         schema: { type: string }
 *       - name: category
 *         in: query
 *         schema: { type: string }
 *       - name: confidence
 *         in: query
 *         schema: { type: string, enum: [high, medium, low] }
 *       - name: sourceRunId
 *         in: query
 *         schema: { type: integer }
 *       - name: search
 *         in: query
 *         schema: { type: string }
 *         description: Full-text search query
 *       - name: pinnedOnly
 *         in: query
 *         schema: { type: boolean }
 *       - name: limit
 *         in: query
 *         description: Max items to return (default 20, max 500). Keep low to avoid large responses — use page param to paginate.
 *         schema: { type: integer, default: 20 }
 *       - name: page
 *         in: query
 *         description: Page number (1-based, default 1)
 *         schema: { type: integer, default: 1 }
 *     responses:
 *       200:
 *         description: Memory items list with counts
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 items:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: integer }
 *                       workspaceId: { type: string }
 *                       category: { type: string }
 *                       content: { type: string }
 *                       sourceStoryId: { type: string, nullable: true }
 *                       sourceSpecId: { type: string, nullable: true }
 *                       sourceRunId: { type: integer, nullable: true }
 *                       confidence: { type: string, enum: [high, medium, low] }
 *                       relatedFiles: { type: array, items: { type: string } }
 *                       pinned: { type: boolean }
 *                       sourceType: { type: string, enum: [synthesis, manual, mcp, auto-extracted, import] }
 *                       createdAt: { type: string, format: date-time }
 *                 total: { type: integer }
 *                 pinned: { type: integer }
 *                 recentRunIds: { type: array, items: { type: integer } }
 *                 categories: { type: array, items: { type: string } }
 *                 page: { type: integer }
 *                 pageSize: { type: integer }
 *       400: { description: "Missing workspaceId" }
 */
router.get('/items', async (req: Request, res: Response) => {
  const { workspaceId, category, confidence, sourceRunId, search, pinnedOnly } = req.query;
  if (!workspaceId) throw new ValidationError('workspaceId required');

  const pageSize = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 20, 1), 500);
  const page = Math.max(parseInt(req.query.page as string, 10) || 1, 1);
  const offset = (page - 1) * pageSize;

  let sql = `SELECT id, workspace_id, category, content, source_story_id, source_spec_id, source_run_id,
             confidence, related_files, pinned, source_type, created_at
             FROM memories WHERE workspace_id = $1 AND deleted_at IS NULL`;
  const params: (string | number)[] = [workspaceId as string];
  let paramIdx = 2;

  if (category) {
    sql += ` AND category = $${paramIdx}`;
    params.push(category as string);
    paramIdx++;
  }

  if (confidence) {
    sql += ` AND confidence = $${paramIdx}`;
    params.push(confidence as string);
    paramIdx++;
  }

  if (sourceRunId) {
    sql += ` AND source_run_id = $${paramIdx}`;
    params.push(parseInt(sourceRunId as string, 10));
    paramIdx++;
  }

  if (search) {
    sql += ` AND tsv @@ plainto_tsquery('english', $${paramIdx})`;
    params.push(search as string);
    paramIdx++;
  }

  if (pinnedOnly === 'true') {
    sql += ' AND pinned = true';
  }

  // Pinned first, then by created_at DESC, with pagination
  sql += ` ORDER BY pinned DESC, created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
  params.push(pageSize, offset);
  paramIdx += 2;

  const rows = await dbQuery<{
    id: number;
    workspace_id: string;
    category: string;
    content: string;
    source_story_id: string | null;
    source_spec_id: string | null;
    source_run_id: number | string | null;
    confidence: string;
    related_files: string;
    pinned: boolean;
    source_type: string;
    created_at: string;
  }>(sql, params);

  // Get counts
  const countRows = await dbQuery<{ total: string; pinned: string }>(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE pinned = true)::int AS pinned
     FROM memories WHERE workspace_id = $1 AND deleted_at IS NULL`,
    [workspaceId as string],
  );

  // Get recent run IDs for filter dropdown
  const runRows = await dbQuery<{ source_run_id: number | string }>(
    `SELECT DISTINCT source_run_id FROM memories
     WHERE workspace_id = $1 AND deleted_at IS NULL AND source_run_id IS NOT NULL
     ORDER BY source_run_id DESC LIMIT 10`,
    [workspaceId as string],
  );

  const items = rows.map(r => ({
    id: r.id,
    workspaceId: r.workspace_id,
    category: r.category,
    content: r.content,
    sourceStoryId: r.source_story_id,
    sourceSpecId: r.source_spec_id,
    sourceRunId: toRunId(r.source_run_id),
    confidence: r.confidence,
    relatedFiles: typeof r.related_files === 'string' ? JSON.parse(r.related_files) : r.related_files,
    pinned: r.pinned,
    sourceType: r.source_type,
    createdAt: r.created_at,
  }));

  res.json({
    items,
    total: parseInt(countRows[0]?.total ?? '0', 10),
    pinned: parseInt(countRows[0]?.pinned ?? '0', 10),
    recentRunIds: runRows.map(r => toRunId(r.source_run_id)).filter((value): value is number => value !== null),
    categories: MEMORY_CATEGORIES,
    page,
    pageSize,
  });
});

/**
 * @swagger
 * /api/memory/items/{id}:
 *   patch:
 *     tags: [Memory]
 *     summary: Update a memory entry (content, pinned status)
 *     operationId: updateMemoryItem
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               content: { type: string }
 *               pinned: { type: boolean }
 *     responses:
 *       200:
 *         description: Updated memory item
 *       404:
 *         description: Memory not found
 */
router.patch('/items/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) throw new ValidationError('Invalid id');

  const { content, pinned } = req.body as { content?: string; pinned?: boolean };

  // Check exists
  const existing = await queryOne<{ id: number; workspace_id: string; content: string }>(
    'SELECT id, workspace_id, content FROM memories WHERE id = $1 AND deleted_at IS NULL',
    [id],
  );
  if (!existing) throw new NotFoundError('Memory not found');

  const setClauses: string[] = [];
  const params: (string | number | boolean | null)[] = [];
  let paramIdx = 1;

  if (content !== undefined) {
    setClauses.push(`content = $${paramIdx}`);
    params.push(content);
    paramIdx++;

    // Re-compute embedding when content changes
    try {
      const prepared = prepareText('memory', content);
      const embedding = await embedText(prepared);
      if (embedding) {
        setClauses.push(`embedding = $${paramIdx}::vector`);
        params.push(`[${embedding.join(',')}]`);
        paramIdx++;
      }
    } catch {
      // Embedding failure is non-fatal — update content without new vector
    }
  }

  if (pinned !== undefined) {
    setClauses.push(`pinned = $${paramIdx}`);
    params.push(pinned);
    paramIdx++;
  }

  if (setClauses.length === 0) {
    throw new ValidationError('No fields to update');
  }

  setClauses.push('updated_at = NOW()');

  params.push(id);
  const sql = `UPDATE memories SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING
    id, workspace_id, category, content, source_story_id, source_spec_id, source_run_id,
    confidence, related_files, pinned, created_at`;

  const updated = await queryOne<{
    id: number; workspace_id: string; category: string; content: string;
    source_story_id: string | null; source_spec_id: string | null; source_run_id: number | string | null;
    confidence: string; related_files: string; pinned: boolean; created_at: string;
  }>(sql, params);

  invalidateMemory(existing.workspace_id);

  res.json({
    id: updated!.id,
    workspaceId: updated!.workspace_id,
    category: updated!.category,
    content: updated!.content,
    sourceStoryId: updated!.source_story_id,
    sourceSpecId: updated!.source_spec_id,
    sourceRunId: toRunId(updated!.source_run_id),
    confidence: updated!.confidence,
    relatedFiles: typeof updated!.related_files === 'string' ? JSON.parse(updated!.related_files) : updated!.related_files,
    pinned: updated!.pinned,
    createdAt: updated!.created_at,
  });
});

/**
 * @swagger
 * /api/memory/items/{id}:
 *   delete:
 *     tags: [Memory]
 *     summary: Soft-delete a memory entry
 *     operationId: deleteMemoryItem
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Memory soft-deleted
 *       404:
 *         description: Memory not found
 */
router.delete('/items/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) throw new ValidationError('Invalid id');

  const existing = await queryOne<{ id: number; workspace_id: string }>(
    'SELECT id, workspace_id FROM memories WHERE id = $1 AND deleted_at IS NULL',
    [id],
  );
  if (!existing) throw new NotFoundError('Memory not found');

  await execute('UPDATE memories SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1', [id]);
  await emitMemoryWalEvent({
    eventType: 'memory_deleted',
    workspaceId: existing.workspace_id,
    memoryId: String(existing.id),
  });
  invalidateMemory(existing.workspace_id);

  res.json({ deleted: true, id });
});

/**
 * @swagger
 * /api/memory/items/{id}/undelete:
 *   post:
 *     tags: [Memory]
 *     summary: Restore a soft-deleted memory entry
 *     operationId: undeleteMemoryItem
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Memory restored
 *       404:
 *         description: Memory not found or not deleted
 */
router.post('/items/:id/undelete', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) throw new ValidationError('Invalid id');

  const existing = await queryOne<{ id: number; workspace_id: string }>(
    'SELECT id, workspace_id FROM memories WHERE id = $1 AND deleted_at IS NOT NULL',
    [id],
  );
  if (!existing) throw new NotFoundError('Memory not found or not deleted');

  await execute('UPDATE memories SET deleted_at = NULL, updated_at = NOW() WHERE id = $1', [id]);
  await emitMemoryWalEvent({
    eventType: 'memory_restored',
    workspaceId: existing.workspace_id,
    memoryId: String(existing.id),
  });
  invalidateMemory(existing.workspace_id);

  res.json({ restored: true, id });
});

/**
 * @swagger
 * /api/memory/items/bulk:
 *   post:
 *     tags: [Memory]
 *     summary: Bulk operations on memory items (delete, pin, unpin)
 *     operationId: bulkMemoryAction
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ids, action]
 *             properties:
 *               ids: { type: array, items: { type: integer } }
 *               action: { type: string, enum: [delete, pin, unpin] }
 *     responses:
 *       200:
 *         description: Bulk action result
 */
router.post('/items/bulk', async (req: Request, res: Response) => {
  const { ids, action } = req.body as { ids: number[]; action: 'delete' | 'pin' | 'unpin' };

  if (!ids || !Array.isArray(ids) || ids.length === 0 || !action) {
    throw new ValidationError('ids array and action required');
  }

  // Build numbered placeholders for IN clause
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
  const targetRows = action === 'delete'
    ? await dbQuery<{ id: number; workspace_id: string }>(
      `SELECT id, workspace_id FROM memories WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
      ids,
    )
    : [];

  let sql: string;
  if (action === 'delete') {
    sql = `UPDATE memories SET deleted_at = NOW(), updated_at = NOW() WHERE id IN (${placeholders}) AND deleted_at IS NULL`;
  } else if (action === 'pin') {
    sql = `UPDATE memories SET pinned = true, updated_at = NOW() WHERE id IN (${placeholders}) AND deleted_at IS NULL`;
  } else if (action === 'unpin') {
    sql = `UPDATE memories SET pinned = false, updated_at = NOW() WHERE id IN (${placeholders}) AND deleted_at IS NULL`;
  } else {
    throw new ValidationError('action must be delete, pin, or unpin');
  }

  const result = await execute(sql, ids);

  // Invalidate cache for affected workspaces
  const wsRows = await dbQuery<{ workspace_id: string }>(
    `SELECT DISTINCT workspace_id FROM memories WHERE id IN (${placeholders})`,
    ids,
  );
  for (const ws of wsRows) {
    invalidateMemory(ws.workspace_id);
  }

  if (action === 'delete') {
    await Promise.all(targetRows.map((row) => emitMemoryWalEvent({
      eventType: 'memory_deleted',
      workspaceId: row.workspace_id,
      memoryId: String(row.id),
    })));
  }

  res.json({ affected: result.rowCount, action });
});

export default router;
