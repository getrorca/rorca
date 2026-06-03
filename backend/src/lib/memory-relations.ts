/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { query, queryOne, transaction } from '../db/index';
import { ConflictError, NotFoundError, ValidationError } from './errors';
import {
  buildMemoryRelationEdgeKey,
  type MemoryRelationProjectionRow,
  upsertMemoryRelationProjection,
} from './knowledge-graph';
import { logger } from './logger';

/**
 * Canonical ontology semantics for first-class memory-to-memory relations.
 *
 * SUPERSEDES: directional. The source memory is the newer authoritative rule
 * that replaces the target memory for future use, while the target stays
 * auditable as historical knowledge.
 *
 * CONFLICTS_WITH: symmetric. Two memories cannot both be followed without
 * tension or contradiction, so the pair is canonicalized to a stable ordering
 * and stored once.
 */
export const MEMORY_RELATION_TYPES = ['SUPERSEDES', 'CONFLICTS_WITH'] as const;
export type MemoryRelationType = typeof MEMORY_RELATION_TYPES[number];

export const MEMORY_RELATION_STATUSES = ['active', 'superseded', 'deleted'] as const;
export type MemoryRelationStatus = typeof MEMORY_RELATION_STATUSES[number];

export const MEMORY_RELATION_SEMANTICS: Record<MemoryRelationType, {
  symmetric: boolean;
  summary: string;
  sourceMeaning: string;
  targetMeaning: string;
}> = {
  SUPERSEDES: {
    symmetric: false,
    summary: 'The source memory replaces the target memory as the newer canonical rule, while preserving the older rule for auditability.',
    sourceMeaning: 'Newer authoritative memory.',
    targetMeaning: 'Older memory retained as superseded history.',
  },
  CONFLICTS_WITH: {
    symmetric: true,
    summary: 'The two memories cannot both be applied cleanly; the pair is stored once in deterministic order to avoid duplicate truth rows.',
    sourceMeaning: 'Canonical first memory in the conflicting pair.',
    targetMeaning: 'Canonical second memory in the conflicting pair.',
  },
};

export interface MemoryRelationRecord {
  id: number;
  workspaceId: string;
  sourceMemoryId: number;
  targetMemoryId: number;
  relationType: MemoryRelationType;
  canonicalKey: string;
  note: string | null;
  status: MemoryRelationStatus;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  restoredAt: string | null;
  supersededAt: string | null;
}

export interface MemoryRelationListItem extends MemoryRelationRecord {
  sourceMemory: {
    id: number;
    category: string;
    content: string;
    sourceStoryId: string | null;
    sourceSpecId: string | null;
    sourceRunId: number | null;
    sourceType: string | null;
    relatedFiles: string[];
    pinned: boolean;
    createdAt: string | null;
  };
  targetMemory: {
    id: number;
    category: string;
    content: string;
    sourceStoryId: string | null;
    sourceSpecId: string | null;
    sourceRunId: number | null;
    sourceType: string | null;
    relatedFiles: string[];
    pinned: boolean;
    createdAt: string | null;
  };
  semantics: (typeof MEMORY_RELATION_SEMANTICS)[MemoryRelationType];
}

export interface CreateMemoryRelationInput {
  workspaceId: string;
  sourceMemoryId: number;
  targetMemoryId: number;
  relationType: MemoryRelationType;
  note?: string | null;
}

export interface ListMemoryRelationsInput {
  workspaceId: string;
  memoryId?: number;
  includeInactive?: boolean;
}

function parseRelatedFiles(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === 'string')
        : [];
    } catch {
      return [];
    }
  }

  return [];
}

interface MemoryOwnershipRow {
  id: number;
  workspace_id: string;
}

interface MemoryRelationRow {
  id: number | string;
  workspace_id: string;
  source_memory_id: number | string;
  target_memory_id: number | string;
  relation_type: MemoryRelationType;
  canonical_key: string;
  note: string | null;
  status: MemoryRelationStatus;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  restored_at: string | null;
  superseded_at: string | null;
}

function assertPositiveInteger(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`${fieldName} must be a positive integer`);
  }
}

function assertRelationType(value: string): asserts value is MemoryRelationType {
  if (!MEMORY_RELATION_TYPES.includes(value as MemoryRelationType)) {
    throw new ValidationError(`relationType must be one of: ${MEMORY_RELATION_TYPES.join(', ')}`);
  }
}

function normalizeRelationPair(
  relationType: MemoryRelationType,
  sourceMemoryId: number,
  targetMemoryId: number,
): { sourceMemoryId: number; targetMemoryId: number } {
  if (relationType === 'CONFLICTS_WITH' && sourceMemoryId > targetMemoryId) {
    return {
      sourceMemoryId: targetMemoryId,
      targetMemoryId: sourceMemoryId,
    };
  }

  return { sourceMemoryId, targetMemoryId };
}

export function buildMemoryRelationCanonicalKey(
  workspaceId: string,
  relationType: MemoryRelationType,
  sourceMemoryId: number,
  targetMemoryId: number,
): string {
  const normalized = normalizeRelationPair(relationType, sourceMemoryId, targetMemoryId);
  return buildMemoryRelationEdgeKey(
    workspaceId,
    relationType,
    String(normalized.sourceMemoryId),
    String(normalized.targetMemoryId),
  );
}

function mapRelationRecord(row: MemoryRelationRow): MemoryRelationRecord {
  return {
    id: Number(row.id),
    workspaceId: row.workspace_id,
    sourceMemoryId: Number(row.source_memory_id),
    targetMemoryId: Number(row.target_memory_id),
    relationType: row.relation_type,
    canonicalKey: row.canonical_key,
    note: row.note,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    restoredAt: row.restored_at,
    supersededAt: row.superseded_at,
  };
}

async function assertMemoriesBelongToWorkspace(
  workspaceId: string,
  sourceMemoryId: number,
  targetMemoryId: number,
): Promise<void> {
  const rows = await query<MemoryOwnershipRow>(
    `SELECT id, workspace_id
       FROM memories
      WHERE id IN ($1, $2) AND deleted_at IS NULL`,
    [sourceMemoryId, targetMemoryId],
  );

  if (rows.length !== 2) {
    throw new NotFoundError('One or both memories were not found');
  }

  if (rows.some((row) => row.workspace_id !== workspaceId)) {
    throw new ValidationError('Memory relations must stay within a single workspace');
  }
}

async function loadProjectionRowById(relationId: number): Promise<MemoryRelationProjectionRow | undefined> {
  return queryOne<MemoryRelationProjectionRow>(
    `SELECT mr.id,
            mr.workspace_id,
            mr.source_memory_id,
            mr.target_memory_id,
            mr.relation_type,
            mr.canonical_key,
            mr.status,
            mr.created_at,
            mr.updated_at,
            mr.deleted_at,
            mr.restored_at,
            mr.superseded_at,
            sm.category AS source_category,
            COALESCE(sm.pinned, false) AS source_pinned,
            sm.created_at AS source_created_at,
            sm.updated_at AS source_updated_at,
            tm.category AS target_category,
            COALESCE(tm.pinned, false) AS target_pinned,
            tm.created_at AS target_created_at,
            tm.updated_at AS target_updated_at
       FROM memory_relations mr
       JOIN memories sm ON sm.id = mr.source_memory_id
       JOIN memories tm ON tm.id = mr.target_memory_id
      WHERE mr.id = $1`,
    [relationId],
  );
}

export async function projectMemoryRelationByIdBestEffort(relationId: number): Promise<void> {
  const row = await loadProjectionRowById(relationId);
  if (!row) return;

  try {
    await upsertMemoryRelationProjection(row);
  } catch (error) {
    logger.warn({ error, relationId }, '[memory-relations] Relation projection failed; relational truth kept');
  }
}

export async function reconcileMemoryRelationProjection(
  workspaceId: string,
): Promise<{ projected: number }> {
  const rows = await query<MemoryRelationProjectionRow>(
    `SELECT mr.id,
            mr.workspace_id,
            mr.source_memory_id,
            mr.target_memory_id,
            mr.relation_type,
            mr.canonical_key,
            mr.status,
            mr.created_at,
            mr.updated_at,
            mr.deleted_at,
            mr.restored_at,
            mr.superseded_at,
            sm.category AS source_category,
            COALESCE(sm.pinned, false) AS source_pinned,
            sm.created_at AS source_created_at,
            sm.updated_at AS source_updated_at,
            tm.category AS target_category,
            COALESCE(tm.pinned, false) AS target_pinned,
            tm.created_at AS target_created_at,
            tm.updated_at AS target_updated_at
       FROM memory_relations mr
       JOIN memories sm ON sm.id = mr.source_memory_id
       JOIN memories tm ON tm.id = mr.target_memory_id
      WHERE mr.workspace_id = $1
      ORDER BY mr.id ASC`,
    [workspaceId],
  );

  for (const row of rows) {
    try {
      await upsertMemoryRelationProjection(row);
    } catch (error) {
      logger.warn({ error, workspaceId, relationId: row.id }, '[memory-relations] Workspace relation reconciliation skipped failed projection row');
    }
  }

  return { projected: rows.length };
}

export async function createMemoryRelation(input: CreateMemoryRelationInput): Promise<MemoryRelationRecord> {
  assertPositiveInteger(input.sourceMemoryId, 'sourceMemoryId');
  assertPositiveInteger(input.targetMemoryId, 'targetMemoryId');
  assertRelationType(input.relationType);

  if (input.sourceMemoryId === input.targetMemoryId) {
    if (input.relationType === 'SUPERSEDES') {
      throw new ValidationError('A memory cannot supersede itself');
    }
    throw new ValidationError('Memory relations require two distinct memories');
  }

  await assertMemoriesBelongToWorkspace(input.workspaceId, input.sourceMemoryId, input.targetMemoryId);

  if (input.relationType === 'SUPERSEDES') {
    const reverseActive = await queryOne<{ id: number }>(
      `SELECT id
         FROM memory_relations
        WHERE workspace_id = $1
          AND relation_type = 'SUPERSEDES'
          AND source_memory_id = $2
          AND target_memory_id = $3
          AND status = 'active'
        LIMIT 1`,
      [input.workspaceId, input.targetMemoryId, input.sourceMemoryId],
    );

    if (reverseActive) {
      throw new ConflictError('Supersession already points the other way for these memories; archive the existing edge before reversing it');
    }
  }

  const normalized = normalizeRelationPair(input.relationType, input.sourceMemoryId, input.targetMemoryId);
  const canonicalKey = buildMemoryRelationCanonicalKey(
    input.workspaceId,
    input.relationType,
    normalized.sourceMemoryId,
    normalized.targetMemoryId,
  );

  const relation = await transaction(async (client) => {
    const existingResult = await client.query<MemoryRelationRow>(
      `SELECT id, workspace_id, source_memory_id, target_memory_id, relation_type, canonical_key,
              note, status, created_at, updated_at, deleted_at, restored_at, superseded_at
         FROM memory_relations
        WHERE workspace_id = $1
          AND relation_type = $2
          AND source_memory_id = $3
          AND target_memory_id = $4
        FOR UPDATE`,
      [
        input.workspaceId,
        input.relationType,
        normalized.sourceMemoryId,
        normalized.targetMemoryId,
      ],
    );

    if (existingResult.rows[0]) {
      if (existingResult.rows[0].status === 'active') {
        throw new ConflictError(`${input.relationType} relation already exists for these memories`);
      }

      const updated = await client.query<MemoryRelationRow>(
        `UPDATE memory_relations
            SET note = $1,
                status = 'active',
                updated_at = NOW(),
                deleted_at = NULL,
                superseded_at = NULL,
                restored_at = NOW()
          WHERE id = $2
        RETURNING id, workspace_id, source_memory_id, target_memory_id, relation_type, canonical_key,
                  note, status, created_at, updated_at, deleted_at, restored_at, superseded_at`,
        [input.note ?? null, existingResult.rows[0].id],
      );
      return mapRelationRecord(updated.rows[0]);
    }

    const inserted = await client.query<MemoryRelationRow>(
      `INSERT INTO memory_relations (
         workspace_id,
         source_memory_id,
         target_memory_id,
         relation_type,
         canonical_key,
         note,
         status
       ) VALUES ($1, $2, $3, $4, $5, $6, 'active')
       RETURNING id, workspace_id, source_memory_id, target_memory_id, relation_type, canonical_key,
                 note, status, created_at, updated_at, deleted_at, restored_at, superseded_at`,
      [
        input.workspaceId,
        normalized.sourceMemoryId,
        normalized.targetMemoryId,
        input.relationType,
        canonicalKey,
        input.note ?? null,
      ],
    );
    return mapRelationRecord(inserted.rows[0]);
  });

  await projectMemoryRelationByIdBestEffort(relation.id);
  return relation;
}

export async function updateMemoryRelationStatus(
  workspaceId: string,
  relationId: number,
  status: MemoryRelationStatus,
): Promise<MemoryRelationRecord> {
  assertPositiveInteger(relationId, 'relationId');
  if (!MEMORY_RELATION_STATUSES.includes(status)) {
    throw new ValidationError(`status must be one of: ${MEMORY_RELATION_STATUSES.join(', ')}`);
  }

  const updated = await transaction(async (client) => {
    const existing = await client.query<MemoryRelationRow>(
      `SELECT id, workspace_id, source_memory_id, target_memory_id, relation_type, canonical_key,
              note, status, created_at, updated_at, deleted_at, restored_at, superseded_at
         FROM memory_relations
        WHERE id = $1 AND workspace_id = $2
        FOR UPDATE`,
      [relationId, workspaceId],
    );

    if (!existing.rows[0]) {
      throw new NotFoundError('Memory relation not found');
    }

    const updateResult = await client.query<MemoryRelationRow>(
      `UPDATE memory_relations
          SET status = $1,
              updated_at = NOW(),
              deleted_at = CASE WHEN $1 = 'deleted' THEN NOW() ELSE NULL END,
              superseded_at = CASE WHEN $1 = 'superseded' THEN NOW() ELSE NULL END,
              restored_at = CASE WHEN $1 = 'active' AND status <> 'active' THEN NOW() ELSE restored_at END
        WHERE id = $2
      RETURNING id, workspace_id, source_memory_id, target_memory_id, relation_type, canonical_key,
                note, status, created_at, updated_at, deleted_at, restored_at, superseded_at`,
      [status, relationId],
    );

    return mapRelationRecord(updateResult.rows[0]);
  });

  await projectMemoryRelationByIdBestEffort(updated.id);
  return updated;
}

export async function listMemoryRelations(
  input: ListMemoryRelationsInput,
): Promise<MemoryRelationListItem[]> {
  const params: Array<string | number> = [input.workspaceId];
  let paramIndex = 2;
  let where = 'WHERE mr.workspace_id = $1';

  if (!input.includeInactive) {
    where += " AND mr.status = 'active'";
  }

  if (input.memoryId) {
    assertPositiveInteger(input.memoryId, 'memoryId');
    where += ` AND (mr.source_memory_id = $${paramIndex} OR mr.target_memory_id = $${paramIndex})`;
    params.push(input.memoryId);
    paramIndex += 1;
  }

  const rows = await query<MemoryRelationRow & {
    source_category: string;
    source_content: string;
    source_story_id: string | null;
    source_spec_id: string | null;
    source_run_id: number | string | null;
    source_type: string | null;
    source_related_files: string[] | string | null;
    source_pinned: boolean;
    source_created_at: string | null;
    target_category: string;
    target_content: string;
    target_story_id: string | null;
    target_spec_id: string | null;
    target_run_id: number | string | null;
    target_type: string | null;
    target_related_files: string[] | string | null;
    target_pinned: boolean;
    target_created_at: string | null;
  }>(
    `SELECT mr.id,
            mr.workspace_id,
            mr.source_memory_id,
            mr.target_memory_id,
            mr.relation_type,
            mr.canonical_key,
            mr.note,
            mr.status,
            mr.created_at,
            mr.updated_at,
            mr.deleted_at,
            mr.restored_at,
            mr.superseded_at,
            sm.category AS source_category,
            sm.content AS source_content,
            sm.source_story_id,
            sm.source_spec_id,
            sm.source_run_id,
            sm.source_type,
            sm.related_files AS source_related_files,
            COALESCE(sm.pinned, false) AS source_pinned,
            sm.created_at AS source_created_at,
            tm.category AS target_category,
            tm.content AS target_content,
            tm.source_story_id AS target_story_id,
            tm.source_spec_id AS target_spec_id,
            tm.source_run_id AS target_run_id,
            tm.source_type AS target_type,
            tm.related_files AS target_related_files,
            COALESCE(tm.pinned, false) AS target_pinned,
            tm.created_at AS target_created_at
       FROM memory_relations mr
       JOIN memories sm ON sm.id = mr.source_memory_id
       JOIN memories tm ON tm.id = mr.target_memory_id
      ${where}
      ORDER BY mr.updated_at DESC, mr.id DESC`,
    params,
  );

  return rows.map((row) => ({
    ...mapRelationRecord(row),
    sourceMemory: {
      id: Number(row.source_memory_id),
      category: row.source_category,
      content: row.source_content,
      sourceStoryId: row.source_story_id,
      sourceSpecId: row.source_spec_id,
      sourceRunId: row.source_run_id === null ? null : Number(row.source_run_id),
      sourceType: row.source_type,
      relatedFiles: parseRelatedFiles(row.source_related_files),
      pinned: Boolean(row.source_pinned),
      createdAt: row.source_created_at,
    },
    targetMemory: {
      id: Number(row.target_memory_id),
      category: row.target_category,
      content: row.target_content,
      sourceStoryId: row.target_story_id,
      sourceSpecId: row.target_spec_id,
      sourceRunId: row.target_run_id === null ? null : Number(row.target_run_id),
      sourceType: row.target_type,
      relatedFiles: parseRelatedFiles(row.target_related_files),
      pinned: Boolean(row.target_pinned),
      createdAt: row.target_created_at,
    },
    semantics: MEMORY_RELATION_SEMANTICS[row.relation_type],
  }));
}
