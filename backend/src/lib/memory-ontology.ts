/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { pool } from '../db/index';
import { checkAge } from './age-guard';
import { buildMemoryNodeKey, parseAgtype } from './knowledge-graph';
import { logger } from './logger';

export type MemoryOntologyRelationType = 'SUPERSEDES' | 'CONFLICTS_WITH';
export type MemoryOntologyRelationDirection = 'incoming' | 'outgoing' | 'symmetric';
export type MemoryOntologyRelationStatus = 'active' | 'superseded' | 'deleted' | null;

export interface MemoryOntologyRelation {
  relationType: MemoryOntologyRelationType;
  relationKey: string;
  direction: MemoryOntologyRelationDirection;
  otherMemoryId: string;
  otherCanonicalKey: string;
  counterpartRetrieved: boolean;
  active: boolean;
  status: MemoryOntologyRelationStatus;
  updatedAt: string | null;
}

export interface MemoryOntologyCandidateAdjustment {
  stale: boolean;
  suppressed: boolean;
  conflict: boolean;
  relations: MemoryOntologyRelation[];
}

export interface MemoryOntologyLookupResult {
  applied: boolean;
  ageUnavailable: boolean;
  candidateIds: string[];
  adjustments: Record<string, MemoryOntologyCandidateAdjustment>;
}

interface CypherColumn {
  name: string;
  type: 'agtype';
}

interface RelationRow {
  sourceMemoryId: unknown;
  targetMemoryId: unknown;
  relationKey: unknown;
  status: unknown;
  active: unknown;
  updatedAt: unknown;
}

const MEMORY_ONTOLOGY_MAX_CANDIDATES = 64;
const MEMORY_ONTOLOGY_EDGE_LIMIT_PER_TYPE = 64;

function escCypher(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function emptyAdjustment(): MemoryOntologyCandidateAdjustment {
  return {
    stale: false,
    suppressed: false,
    conflict: false,
    relations: [],
  };
}

function normalizeStatus(value: unknown): MemoryOntologyRelationStatus {
  const normalized = typeof value === 'string' ? value : String(value ?? '');
  if (normalized === 'active' || normalized === 'superseded' || normalized === 'deleted') {
    return normalized;
  }
  return null;
}

function normalizeBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return Boolean(value);
}

function compareRelations(a: MemoryOntologyRelation, b: MemoryOntologyRelation): number {
  if (a.relationType !== b.relationType) {
    return a.relationType.localeCompare(b.relationType);
  }
  if (a.direction !== b.direction) {
    return a.direction.localeCompare(b.direction);
  }
  if (a.otherCanonicalKey !== b.otherCanonicalKey) {
    return a.otherCanonicalKey.localeCompare(b.otherCanonicalKey);
  }
  return a.relationKey.localeCompare(b.relationKey);
}

async function cypherQuery<T>(cypher: string, returnColumns: CypherColumn[]): Promise<T[]> {
  const columnDef = returnColumns.map(column => `${column.name} ${column.type}`).join(', ');
  const sql = `SELECT * FROM cypher('rorca', $$ ${cypher} $$) AS (${columnDef})`;
  const client = await pool.connect();
  try {
    await client.query("LOAD 'age'");
    await client.query('SET search_path = ag_catalog, "$user", public');
    const result = await client.query(sql);
    return result.rows.map((row) => {
      const parsed: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        parsed[key] = parseAgtype(value);
      }
      return parsed as T;
    });
  } finally {
    await client.query('SET search_path = rorca, public');
    client.release();
  }
}

async function lookupRelationType(
  workspaceId: string,
  candidateIds: string[],
  relationType: MemoryOntologyRelationType,
): Promise<Array<{ memoryId: string; relation: MemoryOntologyRelation }>> {
  if (candidateIds.length === 0) return [];

  const safeWorkspaceId = escCypher(workspaceId);
  const candidateSet = new Set(candidateIds);
  const candidateList = candidateIds.map(id => `'${escCypher(id)}'`).join(', ');
  const cypher = `
    MATCH (source:Memory)-[r:${relationType}]->(target:Memory)
    WHERE source.workspace_id = '${safeWorkspaceId}'
      AND target.workspace_id = '${safeWorkspaceId}'
      AND COALESCE(r.workspace_id, source.workspace_id) = '${safeWorkspaceId}'
      AND COALESCE(r.active, true) = true
      AND COALESCE(r.status, 'active') = 'active'
      AND (source.id IN [${candidateList}] OR target.id IN [${candidateList}])
    RETURN source.id AS sourceMemoryId,
           target.id AS targetMemoryId,
           r.key AS relationKey,
           r.status AS status,
           r.active AS active,
           r.updated_at AS updatedAt
    LIMIT ${MEMORY_ONTOLOGY_EDGE_LIMIT_PER_TYPE}
  `;

  const rows = await cypherQuery<RelationRow>(cypher, [
    { name: 'sourceMemoryId', type: 'agtype' },
    { name: 'targetMemoryId', type: 'agtype' },
    { name: 'relationKey', type: 'agtype' },
    { name: 'status', type: 'agtype' },
    { name: 'active', type: 'agtype' },
    { name: 'updatedAt', type: 'agtype' },
  ]);

  const relationEntries: Array<{ memoryId: string; relation: MemoryOntologyRelation }> = [];
  for (const row of rows) {
    const sourceMemoryId = String(row.sourceMemoryId ?? '').trim();
    const targetMemoryId = String(row.targetMemoryId ?? '').trim();
    const relationKey = String(row.relationKey ?? '').trim();
    if (!sourceMemoryId || !targetMemoryId || !relationKey) {
      continue;
    }

    const status = normalizeStatus(row.status);
    const active = normalizeBoolean(row.active);
    const updatedAt = typeof row.updatedAt === 'string' ? row.updatedAt : String(row.updatedAt ?? '') || null;

    if (relationType === 'SUPERSEDES') {
      if (candidateSet.has(sourceMemoryId)) {
        relationEntries.push({
          memoryId: sourceMemoryId,
          relation: {
            relationType,
            relationKey,
            direction: 'outgoing',
            otherMemoryId: targetMemoryId,
            otherCanonicalKey: buildMemoryNodeKey(workspaceId, targetMemoryId),
            counterpartRetrieved: candidateSet.has(targetMemoryId),
            active,
            status,
            updatedAt,
          },
        });
      }
      if (candidateSet.has(targetMemoryId)) {
        relationEntries.push({
          memoryId: targetMemoryId,
          relation: {
            relationType,
            relationKey,
            direction: 'incoming',
            otherMemoryId: sourceMemoryId,
            otherCanonicalKey: buildMemoryNodeKey(workspaceId, sourceMemoryId),
            counterpartRetrieved: candidateSet.has(sourceMemoryId),
            active,
            status,
            updatedAt,
          },
        });
      }
      continue;
    }

    if (candidateSet.has(sourceMemoryId)) {
      relationEntries.push({
        memoryId: sourceMemoryId,
        relation: {
          relationType,
          relationKey,
          direction: 'symmetric',
          otherMemoryId: targetMemoryId,
          otherCanonicalKey: buildMemoryNodeKey(workspaceId, targetMemoryId),
          counterpartRetrieved: candidateSet.has(targetMemoryId),
          active,
          status,
          updatedAt,
        },
      });
    }

    if (candidateSet.has(targetMemoryId)) {
      relationEntries.push({
        memoryId: targetMemoryId,
        relation: {
          relationType,
          relationKey,
          direction: 'symmetric',
          otherMemoryId: sourceMemoryId,
          otherCanonicalKey: buildMemoryNodeKey(workspaceId, sourceMemoryId),
          counterpartRetrieved: candidateSet.has(sourceMemoryId),
          active,
          status,
          updatedAt,
        },
      });
    }
  }

  return relationEntries;
}

export async function lookupMemoryOntologyAdjustments(
  workspaceId: string,
  candidateIds: string[],
): Promise<MemoryOntologyLookupResult> {
  const boundedCandidateIds = unique(candidateIds).slice(0, MEMORY_ONTOLOGY_MAX_CANDIDATES);
  const adjustments = Object.fromEntries(
    boundedCandidateIds.map((candidateId) => [candidateId, emptyAdjustment()]),
  ) as Record<string, MemoryOntologyCandidateAdjustment>;

  if (boundedCandidateIds.length === 0) {
    return {
      applied: false,
      ageUnavailable: false,
      candidateIds: [],
      adjustments,
    };
  }

  if (!(await checkAge())) {
    logger.debug(
      { workspaceId, candidateCount: boundedCandidateIds.length },
      '[memory-ontology] AGE unavailable — skipping ontology precedence lookup',
    );
    return {
      applied: false,
      ageUnavailable: true,
      candidateIds: boundedCandidateIds,
      adjustments,
    };
  }

  try {
    const relationEntries = [
      ...(await lookupRelationType(workspaceId, boundedCandidateIds, 'SUPERSEDES')),
      ...(await lookupRelationType(workspaceId, boundedCandidateIds, 'CONFLICTS_WITH')),
    ];

    const seen = new Set<string>();
    for (const entry of relationEntries) {
      const adjustment = adjustments[entry.memoryId];
      if (!adjustment) {
        continue;
      }
      const relationKey = `${entry.memoryId}::${entry.relation.relationType}::${entry.relation.direction}::${entry.relation.relationKey}::${entry.relation.otherCanonicalKey}`;
      if (seen.has(relationKey)) {
        continue;
      }
      seen.add(relationKey);
      adjustment.relations.push(entry.relation);
      if (entry.relation.relationType === 'SUPERSEDES' && entry.relation.direction === 'incoming') {
        adjustment.stale = true;
        adjustment.suppressed = true;
      }
      if (entry.relation.relationType === 'CONFLICTS_WITH') {
        adjustment.conflict = true;
      }
    }

    for (const adjustment of Object.values(adjustments)) {
      adjustment.relations.sort(compareRelations);
    }

    return {
      applied: true,
      ageUnavailable: false,
      candidateIds: boundedCandidateIds,
      adjustments,
    };
  } catch (error) {
    logger.warn(
      { error, workspaceId, candidateCount: boundedCandidateIds.length },
      '[memory-ontology] Ontology precedence lookup failed — continuing with semantic retrieval only',
    );
    return {
      applied: false,
      ageUnavailable: false,
      candidateIds: boundedCandidateIds,
      adjustments,
    };
  }
}
