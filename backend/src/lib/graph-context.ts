/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * PG-016: Graph Context Traversal
 *
 * Enriches story context by traversing the Apache AGE knowledge graph.
 * For each predicted file path, finds:
 *   - Memory entries from stories that previously touched the same files
 *   - Conventions governing the files this story will touch
 *   - Conflict detection: in-progress stories touching the same files
 *
 * Results are cached in context-cache.ts (warm tier, TTL 2 min)
 * keyed by workspace/spec/story scope + predicted paths hash.
 */

import { createHash } from 'crypto';
import {
  buildFileNodeKey,
  buildStoryNodeKey,
  graphStats,
  normalizeGraphFilePath,
  parseAgtype,
} from './knowledge-graph';
import { get, set } from './context-cache';
import { query } from '../db/index';
import { logger } from './logger';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RelatedMemory {
  memoryId: string;
  text: string;
  relationship: string;
  hops: number;
}

export interface RelatedConvention {
  name: string;
  content: string;
  appliesTo: string;
}

export interface FileHistory {
  path: string;
  touchedByStories: string[];
  lastModifiedSpec: string;
}

export interface GraphContext {
  relatedMemories: RelatedMemory[];
  relatedConventions: RelatedConvention[];
  fileHistory: FileHistory[];
  impactRadius: number;
  graphHits: number;
}

// ─── Cache Key ──────────────────────────────────────────────────────────────

export function buildGraphContextCacheKey(
  storyId: string,
  predictedPaths: string[],
  workspaceId: string | number,
  specId?: string,
): string {
  const normalizedPaths = [...new Set(
    predictedPaths
      .map(normalizeGraphFilePath)
      .filter(Boolean),
  )].sort();
  const hash = createHash('md5')
    .update(normalizedPaths.join('\n'))
    .digest('hex')
    .slice(0, 12);
  return `graph-context:${workspaceId}:${specId || 'no-spec'}:${storyId}:${hash}`;
}

// ─── Cypher Helpers (use knowledge-graph.ts internals via pool) ─────────────

import { pool } from '../db/index';
import type { PoolClient } from 'pg';

async function setupAgeSession(client: PoolClient): Promise<void> {
  await client.query("LOAD 'age'");
  await client.query("SET search_path = ag_catalog, \"$user\", public");
}

function escCypher(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

interface CypherColumn {
  name: string;
  type: string;
}

async function cypherQuery<T = Record<string, unknown>>(
  cypher: string,
  returnColumns: CypherColumn[],
): Promise<T[]> {
  const columnDef = returnColumns.map(c => `${c.name} ${c.type}`).join(', ');
  const sql = `SELECT * FROM cypher('rorca', $$ ${cypher} $$) AS (${columnDef})`;

  const p = pool;
  const client = await p.connect();
  try {
    await setupAgeSession(client);
    const result = await client.query(sql);
    return result.rows.map(row => {
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

// ─── Main Entry Point ───────────────────────────────────────────────────────

/**
 * Traverse the knowledge graph to enrich story context.
 *
 * For each predicted file path:
 *   1. Find memory entries from stories that previously touched the same files
 *   2. Find conventions governing those files
 *   3. Detect conflicts with in-progress stories
 *
 * @param storyId - Current story ID (e.g. "PG-016")
 * @param predictedPaths - File paths this story is predicted to touch
 * @param workspaceId - Workspace ID for scoping queries
 * @param maxDepth - Max traversal depth (default 2)
 * @param specId - Spec ID for canonical story scoping when available
 */
export async function getGraphContext(
  storyId: string,
  predictedPaths: string[],
  workspaceId: string | number,
  maxDepth: number = 2,
  specId?: string,
): Promise<GraphContext> {
  const start = Date.now();

  const normalizedPredictedPaths = [...new Set(
    predictedPaths
      .map(normalizeGraphFilePath)
      .filter(Boolean),
  )];
  const currentStoryKey = specId
    ? buildStoryNodeKey(String(workspaceId), specId, storyId)
    : undefined;

  // Check cache first
  const cacheKey = buildGraphContextCacheKey(storyId, normalizedPredictedPaths, workspaceId, specId);
  const cached = get<GraphContext>(cacheKey);
  if (cached) {
    logger.debug({ storyId, cacheKey }, '[graph-context] cache HIT');
    return cached;
  }

  const result: GraphContext = {
    relatedMemories: [],
    relatedConventions: [],
    fileHistory: [],
    impactRadius: 0,
    graphHits: 0,
  };

  // Guard: check if graph is available
  try {
    const stats = await graphStats();
    if (!stats.available || stats.vertexCount === 0) {
      logger.debug({ storyId }, '[graph-context] graph empty or unavailable — returning empty');
      set(cacheKey, result, 'warm');
      return result;
    }
  } catch {
    logger.warn({ storyId }, '[graph-context] graph stats check failed');
    return result;
  }

  const uniqueNodes = new Set<string>();

  // Process each predicted path (limit to 10 to bound query count)
  for (const filePath of normalizedPredictedPaths.slice(0, 10)) {
    try {
      const fileKey = buildFileNodeKey(String(workspaceId), filePath);

      // 1. Path-based memory traversal:
      //    File <- TOUCHES - Story - LEARNED_FROM -> Memory
      await findRelatedMemories(filePath, fileKey, storyId, currentStoryKey, maxDepth, result, uniqueNodes);

      // 2. Convention lookup:
      //    File <- APPLIES_TO - Convention
      await findConventions(filePath, fileKey, result);

      // 3. File history:
      //    File <- TOUCHES - Story (collect all stories that touched this file)
      await buildFileHistory(filePath, fileKey, result);
    } catch (err) {
      logger.warn({ err, filePath, storyId }, '[graph-context] traversal error for path');
    }
  }

  // 4. Conflict detection: find in-progress stories touching the same files
  try {
    await detectConflicts(storyId, currentStoryKey, normalizedPredictedPaths, workspaceId, result);
  } catch (err) {
    logger.warn({ err, storyId }, '[graph-context] conflict detection failed');
  }

  // Deduplicate memories by memoryId
  const seenMemories = new Set<string>();
  result.relatedMemories = result.relatedMemories.filter(m => {
    if (seenMemories.has(m.memoryId)) return false;
    seenMemories.add(m.memoryId);
    return true;
  });

  // Deduplicate conventions by name + appliesTo
  const seenConventions = new Set<string>();
  result.relatedConventions = result.relatedConventions.filter(c => {
    const key = `${c.name}:${c.appliesTo}`;
    if (seenConventions.has(key)) return false;
    seenConventions.add(key);
    return true;
  });

  // Deduplicate file history by path
  const mergedHistory = new Map<string, FileHistory>();
  for (const fh of result.fileHistory) {
    const existing = mergedHistory.get(fh.path);
    if (existing) {
      const allStories = [...new Set([...existing.touchedByStories, ...fh.touchedByStories])];
      existing.touchedByStories = allStories;
      if (!existing.lastModifiedSpec && fh.lastModifiedSpec) {
        existing.lastModifiedSpec = fh.lastModifiedSpec;
      }
    } else {
      mergedHistory.set(fh.path, { ...fh });
    }
  }
  result.fileHistory = [...mergedHistory.values()];

  result.impactRadius = uniqueNodes.size;
  result.graphHits = result.relatedMemories.length + result.relatedConventions.length + result.fileHistory.length;

  const latencyMs = Date.now() - start;
  logger.info(
    {
      storyId,
      paths: normalizedPredictedPaths.length,
      memories: result.relatedMemories.length,
      conventions: result.relatedConventions.length,
      files: result.fileHistory.length,
      graphHits: result.graphHits,
      impactRadius: result.impactRadius,
      latencyMs,
    },
    '[graph-context] traversal complete',
  );

  // Cache in warm tier (TTL 2 min)
  set(cacheKey, result, 'warm');

  return result;
}

// ─── Internal Traversal Functions ───────────────────────────────────────────

/**
 * Find memory entries from stories that previously touched the same file.
 * Cypher: MATCH (f:File {path})<-[:TOUCHES]-(s:Story)-[:LEARNED_FROM]->(m:Memory) RETURN m
 * Depth-limited: direct connections + one intermediate node.
 */
async function findRelatedMemories(
  filePath: string,
  fileKey: string,
  currentStoryId: string,
  currentStoryKey: string | undefined,
  maxDepth: number,
  result: GraphContext,
  uniqueNodes: Set<string>,
): Promise<void> {
  // Direct path: File <- TOUCHES - Story - LEARNED_FROM -> Memory (2 hops)
  const directMemories = await cypherQuery<{
    mid: unknown;
    sid: unknown;
    stitle: unknown;
  }>(
    `MATCH (f:File {key: '${escCypher(fileKey)}'})<-[:TOUCHES]-(s:Story)-[:LEARNED_FROM]->(m:Memory)
     WHERE ${currentStoryKey ? `s.key <> '${escCypher(currentStoryKey)}'` : `s.id <> '${escCypher(currentStoryId)}'`}
     RETURN m.id, s.id, s.title`,
    [
      { name: 'mid', type: 'agtype' },
      { name: 'sid', type: 'agtype' },
      { name: 'stitle', type: 'agtype' },
    ],
  );

  for (const row of directMemories) {
    const memoryId = String(row.mid ?? '');
    const touchingStoryId = String(row.sid ?? '');
    if (!memoryId) continue;

    uniqueNodes.add(`memory:${memoryId}`);
    uniqueNodes.add(`story:${touchingStoryId}`);

    // Fetch actual memory text from WAL events
    const memText = await getMemoryText(memoryId);
    const relationship = `learned by ${touchingStoryId} which touched ${filePath}`;

    result.relatedMemories.push({
      memoryId,
      text: memText,
      relationship,
      hops: 2,
    });
  }

  // Extended depth (if maxDepth > 2): Memory - ABOUT -> File2 <- TOUCHES - Story2
  // This finds memories about files co-modified with the target file
  if (maxDepth > 2) {
    const extendedMemories = await cypherQuery<{
      mid: unknown;
      fpath: unknown;
    }>(
      `MATCH (f:File {key: '${escCypher(fileKey)}'})<-[:TOUCHES]-(s:Story)-[:TOUCHES]->(f2:File)<-[:ABOUT]-(m:Memory)
       WHERE f2.key <> '${escCypher(fileKey)}'
         AND ${currentStoryKey ? `s.key <> '${escCypher(currentStoryKey)}'` : `s.id <> '${escCypher(currentStoryId)}'`}
       RETURN DISTINCT m.id, f2.path`,
      [
        { name: 'mid', type: 'agtype' },
        { name: 'fpath', type: 'agtype' },
      ],
    );

    for (const row of extendedMemories) {
      const memoryId = String(row.mid ?? '');
      const aboutPath = String(row.fpath ?? '');
      if (!memoryId) continue;

      uniqueNodes.add(`memory:${memoryId}`);

      const memText = await getMemoryText(memoryId);
      result.relatedMemories.push({
        memoryId,
        text: memText,
        relationship: `about co-modified file ${aboutPath}`,
        hops: 3,
      });
    }
  }
}

/**
 * Find conventions governing a file path.
 * Cypher: MATCH (c:Convention)-[:APPLIES_TO]->(f:File {path}) RETURN c
 */
async function findConventions(
  filePath: string,
  fileKey: string,
  result: GraphContext,
): Promise<void> {
  const rows = await cypherQuery<{
    name: unknown;
    source: unknown;
    layer: unknown;
  }>(
    `MATCH (c:Convention)-[:APPLIES_TO]->(f:File {key: '${escCypher(fileKey)}'})
     RETURN c.name, c.source, c.layer`,
    [
      { name: 'name', type: 'agtype' },
      { name: 'source', type: 'agtype' },
      { name: 'layer', type: 'agtype' },
    ],
  );

  for (const row of rows) {
    const name = String(row.name ?? '');
    if (!name) continue;

    result.relatedConventions.push({
      name,
      content: `Convention: ${name} (source: ${String(row.source ?? 'unknown')}, layer: ${String(row.layer ?? '')})`,
      appliesTo: filePath,
    });
  }
}

/**
 * Build file history: which stories touched this file and from which spec.
 * Cypher: MATCH (s:Story)-[:TOUCHES]->(f:File {path}) RETURN s
 */
async function buildFileHistory(
  filePath: string,
  fileKey: string,
  result: GraphContext,
): Promise<void> {
  const rows = await cypherQuery<{
    sid: unknown;
    specid: unknown;
  }>(
    `MATCH (s:Story)-[:TOUCHES]->(f:File {key: '${escCypher(fileKey)}'})
     RETURN s.id, s.specId`,
    [
      { name: 'sid', type: 'agtype' },
      { name: 'specid', type: 'agtype' },
    ],
  );

  if (rows.length > 0) {
    const storyIds = rows.map(r => String(r.sid ?? ''));
    const lastSpec = String(rows[rows.length - 1]?.specid ?? '');

    result.fileHistory.push({
      path: filePath,
      touchedByStories: storyIds.filter(Boolean),
      lastModifiedSpec: lastSpec,
    });
  }
}

/**
 * Detect if another in-progress story is touching the same files.
 * Uses canonical story/file keys when spec/workspace scope is available.
 */
async function detectConflicts(
  storyId: string,
  currentStoryKey: string | undefined,
  predictedPaths: string[],
  workspaceId: string | number,
  result: GraphContext,
): Promise<void> {
  for (const filePath of predictedPaths.slice(0, 10)) {
    const fileKey = buildFileNodeKey(String(workspaceId), filePath);
    const conflicts = await cypherQuery<{
      s2id: unknown;
      fpath: unknown;
    }>(
      `MATCH (f:File {key: '${escCypher(fileKey)}'})<-[:TOUCHES]-(s2:Story)
       WHERE ${currentStoryKey ? `s2.key <> '${escCypher(currentStoryKey)}'` : `s2.id <> '${escCypher(storyId)}'`}
         AND s2.status = 'running'
       RETURN s2.id, f.path`,
      [
        { name: 's2id', type: 'agtype' },
        { name: 'fpath', type: 'agtype' },
      ],
    );

    for (const row of conflicts) {
      const conflictId = String(row.s2id ?? '');
      if (!conflictId || conflictId === storyId) continue;

      result.relatedMemories.push({
        memoryId: `conflict:${conflictId}:${filePath}`,
        text: `WARNING: Story ${conflictId} (status: running) is also touching ${filePath}`,
        relationship: 'conflict',
        hops: 1,
      });
    }
  }
}

// ─── Memory Text Lookup ─────────────────────────────────────────────────────

/**
 * Fetch memory entry text from WAL events by memory ID.
 * Falls back to the ID string if no entry found.
 */
async function getMemoryText(memoryId: string): Promise<string> {
  try {
    const row = await query<{ payload: string }>(
      `SELECT payload FROM wal_events
       WHERE event_type IN ('memory_created', 'memory_updated')
         AND payload::jsonb->>'id' = $1
       ORDER BY ts DESC LIMIT 1`,
      [memoryId],
    );

    if (row.length > 0 && row[0].payload) {
      const parsed = JSON.parse(row[0].payload);
      return parsed.text || parsed.content || parsed.rule || memoryId;
    }
  } catch {
    // Fallback silently
  }
  return memoryId;
}

// ─── Formatting Helper ──────────────────────────────────────────────────────

/**
 * Format GraphContext as a markdown section for injection into story prompts.
 */
export function formatGraphContext(ctx: GraphContext): string {
  if (
    ctx.relatedMemories.length === 0 &&
    ctx.relatedConventions.length === 0 &&
    ctx.fileHistory.length === 0
  ) {
    return '';
  }

  const lines: string[] = ['## Related History (from knowledge graph)'];

  if (ctx.relatedMemories.length > 0) {
    lines.push('');
    lines.push('### Relevant Memories');
    for (const m of ctx.relatedMemories) {
      if (m.relationship === 'conflict') {
        lines.push(`- **CONFLICT**: ${m.text}`);
      } else {
        lines.push(`- ${m.text} (${m.relationship}, ${m.hops} hops)`);
      }
    }
  }

  if (ctx.relatedConventions.length > 0) {
    lines.push('');
    lines.push('### Convention Context');
    for (const c of ctx.relatedConventions) {
      lines.push(`- Follow convention "${c.name}" for files matching ${c.appliesTo}`);
    }
  }

  if (ctx.fileHistory.length > 0) {
    lines.push('');
    lines.push('### File Touch History');
    for (const fh of ctx.fileHistory) {
      lines.push(
        `- \`${fh.path}\` was modified by stories: ${fh.touchedByStories.join(', ')}` +
        (fh.lastModifiedSpec ? ` (spec: ${fh.lastModifiedSpec})` : ''),
      );
    }
  }

  return lines.join('\n');
}
