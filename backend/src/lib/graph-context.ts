/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
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
 *
 * Phase 2 ranking guardrails:
 *   - Hot path is bounded to MAX_GRAPH_CONTEXT_PREDICTED_PATHS file targets.
 *   - Queries stay label/property-filtered (`File {key: ...}` / `f.key IN [...]`) to avoid full scans.
 *   - Cache keys and invalidation are workspace-scoped so duplicate local IDs cannot collide across workspaces.
 *   - Cache invalidation is driven by observable WAL lifecycle events plus explicit rebuild route hooks.
 */

import { createHash } from 'crypto';
import type { PoolClient } from 'pg';
import { pool, query } from '../db/index';
import { checkAge } from './age-guard';
import { buildRorcaCypherSql } from './graph-contract';
import { get, invalidatePattern, set } from './context-cache';
import {
  buildFileNodeKey,
  buildStoryNodeKey,
  graphStats,
  normalizeGraphFilePath,
  parseAgtype,
} from './knowledge-graph';
import { logger } from './logger';
import { subscribe, type WalEvent } from './sse-hub';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RelatedMemory {
  memoryId: string;
  text: string;
  relationship: string;
  hops: number;
  matchedPath?: string;
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
  proximityUnavailable: boolean;
}

interface FallbackMemoryRow {
  id: string;
  content: string;
  pinned: boolean;
  created_at: string;
  updated_at: string | null;
  source_story_id: string | null;
  source_spec_id: string | null;
  related_files: string[] | string | null;
}

interface MemoryTextRow {
  memory_id: string;
  payload: string;
}

interface ScopedFileTarget {
  path: string;
  key: string;
}

interface CypherColumn {
  name: string;
  type: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

export const GRAPH_CONTEXT_CACHE_PREFIX = 'graph-context';
export const MAX_GRAPH_CONTEXT_PREDICTED_PATHS = 10;
export const MAX_GRAPH_CONTEXT_LATENCY_BUDGET_MS = 200;
export const GRAPH_CONTEXT_INVALIDATION_EVENT_TYPES = [
  'spec_approved',
  'story_passed',
  'story_failed',
  'worktree_merged',
  'story_deleted',
  'spec_deleted',
  'memory_deleted',
  'memory_created',
  'memory_auto_saved',
  'memory_restored',
] as const;

let graphContextCacheInvalidatorStarted = false;

// ─── Cache Key / Invalidation ───────────────────────────────────────────────

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
  return `${GRAPH_CONTEXT_CACHE_PREFIX}:${workspaceId}:${specId || 'no-spec'}:${storyId}:${hash}`;
}

function buildGraphContextCachePattern(workspaceId?: string | number, specId?: string): string {
  if (workspaceId === undefined || workspaceId === null) return `${GRAPH_CONTEXT_CACHE_PREFIX}:*`;
  if (!specId) return `${GRAPH_CONTEXT_CACHE_PREFIX}:${workspaceId}:*`;
  return `${GRAPH_CONTEXT_CACHE_PREFIX}:${workspaceId}:${specId}:*`;
}

export function invalidateGraphContextCache(workspaceId?: string | number, specId?: string): void {
  invalidatePattern(buildGraphContextCachePattern(workspaceId, specId));
}

export function invalidateGraphContextCacheForWorkspace(workspaceId: string | number): void {
  invalidateGraphContextCache(workspaceId);
}

function shouldInvalidateGraphContext(eventType: string): boolean {
  return GRAPH_CONTEXT_INVALIDATION_EVENT_TYPES.includes(
    eventType as typeof GRAPH_CONTEXT_INVALIDATION_EVENT_TYPES[number],
  );
}

export function handleGraphContextCacheInvalidationEvent(event: WalEvent): void {
  if (!shouldInvalidateGraphContext(event.event_type) || !event.workspace_id) {
    return;
  }

  invalidateGraphContextCacheForWorkspace(event.workspace_id);
  logger.info(
    {
      eventType: event.event_type,
      workspaceId: event.workspace_id,
      specId: event.spec_id,
      storyId: event.story_id,
    },
    '[graph-context] invalidated scoped cache after WAL event',
  );
}

export function startGraphContextCacheInvalidator(): void {
  if (graphContextCacheInvalidatorStarted) {
    return;
  }

  subscribe((event) => {
    handleGraphContextCacheInvalidationEvent(event);
  });
  graphContextCacheInvalidatorStarted = true;
  logger.info(
    { eventTypes: GRAPH_CONTEXT_INVALIDATION_EVENT_TYPES },
    '[graph-context] subscribed cache invalidator to WAL lifecycle events',
  );
}

// ─── Cypher Helpers (use knowledge-graph.ts internals via pool) ─────────────

async function setupAgeSession(client: PoolClient): Promise<void> {
  await client.query("LOAD 'age'");
  await client.query('SET search_path = ag_catalog, "$user", public');
}

function escCypher(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function toCypherStringList(values: string[]): string {
  return `[${values.map(value => `'${escCypher(value)}'`).join(', ')}]`;
}

function otherStoryPredicate(
  alias: string,
  currentStoryKey: string | undefined,
  currentStoryId: string,
): string {
  return currentStoryKey
    ? `${alias}.key <> '${escCypher(currentStoryKey)}'`
    : `${alias}.id <> '${escCypher(currentStoryId)}'`;
}

async function cypherQuery<T = Record<string, unknown>>(
  cypher: string,
  returnColumns: CypherColumn[],
): Promise<T[]> {
  const columnDef = returnColumns.map(c => `${c.name} ${c.type}`).join(', ');
  const sql = buildRorcaCypherSql(cypher, columnDef);

  const client = await pool.connect();
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

function normalizeScopedTargets(
  workspaceId: string | number,
  predictedPaths: string[],
): ScopedFileTarget[] {
  return [...new Set(
    predictedPaths
      .map(normalizeGraphFilePath)
      .filter(Boolean),
  )]
    .slice(0, MAX_GRAPH_CONTEXT_PREDICTED_PATHS)
    .map(path => ({
      path,
      key: buildFileNodeKey(String(workspaceId), path),
    }));
}

function parseRelatedFiles(value: string[] | string | null | undefined): string[] {
  const parsed = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? (() => {
          try {
            const json = JSON.parse(value) as unknown;
            return Array.isArray(json) ? json : [];
          } catch {
            return [];
          }
        })()
      : [];

  return parsed
    .filter((file): file is string => typeof file === 'string' && file.trim().length > 0)
    .map(normalizeGraphFilePath)
    .filter(Boolean);
}

async function getMemoryTexts(memoryIds: string[]): Promise<Map<string, string>> {
  const uniqueIds = [...new Set(memoryIds.filter(Boolean))];
  if (uniqueIds.length === 0) {
    return new Map();
  }

  try {
    const rows = await query<MemoryTextRow>(
      `SELECT DISTINCT ON (payload::jsonb->>'id')
              payload::jsonb->>'id' AS memory_id,
              payload
         FROM wal_events
        WHERE event_type IN ('memory_created', 'memory_updated')
          AND payload::jsonb->>'id' = ANY($1::text[])
        ORDER BY payload::jsonb->>'id', ts DESC`,
      [uniqueIds],
    );

    const texts = new Map<string, string>();
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.payload);
        texts.set(row.memory_id, parsed.text || parsed.content || parsed.rule || row.memory_id);
      } catch {
        texts.set(row.memory_id, row.memory_id);
      }
    }
    return texts;
  } catch {
    return new Map(uniqueIds.map(memoryId => [memoryId, memoryId]));
  }
}

async function buildFallbackGraphContext(
  workspaceId: string | number,
  predictedPaths: string[],
  specId?: string,
): Promise<GraphContext> {
  const normalizedPaths = [...new Set(predictedPaths.map(normalizeGraphFilePath).filter(Boolean))];
  const empty: GraphContext = {
    relatedMemories: [],
    relatedConventions: [],
    fileHistory: [],
    impactRadius: 0,
    graphHits: 0,
    proximityUnavailable: true,
  };

  if (normalizedPaths.length === 0) {
    return empty;
  }

  const params: Array<string | string[]> = [String(workspaceId), normalizedPaths];
  let specClause = '';
  if (specId) {
    params.push(specId);
    specClause = 'AND source_spec_id = $3';
  }

  const rows = await query<FallbackMemoryRow>(
    `SELECT id::text AS id,
            content,
            COALESCE(pinned, false) AS pinned,
            created_at,
            updated_at,
            source_story_id,
            source_spec_id,
            related_files
       FROM memories
      WHERE workspace_id = $1
        AND deleted_at IS NULL
        ${specClause}
        AND EXISTS (
          SELECT 1
            FROM jsonb_array_elements_text(related_files) AS rf(path)
           WHERE rf.path = ANY($2::text[])
        )
      ORDER BY pinned DESC, COALESCE(updated_at, created_at) DESC
      LIMIT 12`,
    params,
  );

  const historyByPath = new Map<string, FileHistory>();
  const relatedMemories: RelatedMemory[] = [];

  for (const row of rows) {
    const relatedFiles = parseRelatedFiles(row.related_files);
    const matchedPath = relatedFiles.find(file => normalizedPaths.includes(file));
    if (!matchedPath) continue;

    relatedMemories.push({
      memoryId: row.id,
      text: row.content,
      relationship: row.pinned ? 'pinned fallback recency match' : 'fallback recency match',
      hops: 0,
      matchedPath,
    });

    const existing = historyByPath.get(matchedPath) ?? {
      path: matchedPath,
      touchedByStories: [],
      lastModifiedSpec: row.source_spec_id ?? '',
    };
    if (row.source_story_id && !existing.touchedByStories.includes(row.source_story_id)) {
      existing.touchedByStories.push(row.source_story_id);
    }
    if (!existing.lastModifiedSpec && row.source_spec_id) {
      existing.lastModifiedSpec = row.source_spec_id;
    }
    historyByPath.set(matchedPath, existing);
  }

  return {
    relatedMemories,
    relatedConventions: [],
    fileHistory: [...historyByPath.values()],
    impactRadius: relatedMemories.length + historyByPath.size,
    graphHits: relatedMemories.length + historyByPath.size,
    proximityUnavailable: true,
  };
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
  const fileTargets = normalizeScopedTargets(workspaceId, predictedPaths);
  const normalizedPredictedPaths = fileTargets.map(target => target.path);
  const currentStoryKey = specId
    ? buildStoryNodeKey(String(workspaceId), specId, storyId)
    : undefined;
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
    proximityUnavailable: false,
  };

  if (!(await checkAge())) {
    const fallback = await buildFallbackGraphContext(workspaceId, normalizedPredictedPaths, specId);
    logger.warn(
      { storyId, workspaceId, specId: specId ?? null },
      '[graph-context] AGE unavailable in lite mode — using recency-sorted Postgres fallback',
    );
    set(cacheKey, fallback, 'warm');
    return fallback;
  }

  try {
    const stats = await graphStats();
    if (!stats.available || stats.vertexCount === 0) {
      result.proximityUnavailable = !stats.available;
      logger.debug({ storyId }, '[graph-context] graph empty or unavailable — returning empty');
      set(cacheKey, result, 'warm');
      return result;
    }
  } catch {
    const fallback = await buildFallbackGraphContext(workspaceId, normalizedPredictedPaths, specId);
    logger.warn(
      { storyId, workspaceId, specId: specId ?? null },
      '[graph-context] graph stats check failed — using recency fallback',
    );
    set(cacheKey, fallback, 'warm');
    return fallback;
  }

  if (fileTargets.length === 0) {
    set(cacheKey, result, 'warm');
    return result;
  }

  const uniqueNodes = new Set<string>();

  await Promise.all([
    findRelatedMemoriesBatch(fileTargets, storyId, currentStoryKey, maxDepth, result, uniqueNodes),
    findConventionsBatch(fileTargets, result),
    buildFileHistoryBatch(fileTargets, result),
    detectConflictsBatch(storyId, currentStoryKey, fileTargets, result),
  ]);

  dedupeGraphContext(result);

  result.impactRadius = uniqueNodes.size;
  result.graphHits =
    result.relatedMemories.length + result.relatedConventions.length + result.fileHistory.length;

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
      performanceBudgetMs: MAX_GRAPH_CONTEXT_LATENCY_BUDGET_MS,
      budgetExceeded: latencyMs > MAX_GRAPH_CONTEXT_LATENCY_BUDGET_MS,
    },
    '[graph-context] traversal complete',
  );

  set(cacheKey, result, 'warm');
  return result;
}

function dedupeGraphContext(result: GraphContext): void {
  const seenMemories = new Set<string>();
  result.relatedMemories = result.relatedMemories.filter(memory => {
    if (seenMemories.has(memory.memoryId)) return false;
    seenMemories.add(memory.memoryId);
    return true;
  });

  const seenConventions = new Set<string>();
  result.relatedConventions = result.relatedConventions.filter(convention => {
    const key = `${convention.name}:${convention.appliesTo}`;
    if (seenConventions.has(key)) return false;
    seenConventions.add(key);
    return true;
  });

  const mergedHistory = new Map<string, FileHistory>();
  for (const history of result.fileHistory) {
    const existing = mergedHistory.get(history.path);
    if (!existing) {
      mergedHistory.set(history.path, { ...history });
      continue;
    }

    existing.touchedByStories = [...new Set([...existing.touchedByStories, ...history.touchedByStories])];
    if (!existing.lastModifiedSpec && history.lastModifiedSpec) {
      existing.lastModifiedSpec = history.lastModifiedSpec;
    }
  }
  result.fileHistory = [...mergedHistory.values()];
}

// ─── Internal Traversal Functions ───────────────────────────────────────────

async function findRelatedMemoriesBatch(
  fileTargets: ScopedFileTarget[],
  currentStoryId: string,
  currentStoryKey: string | undefined,
  maxDepth: number,
  result: GraphContext,
  uniqueNodes: Set<string>,
): Promise<void> {
  const fileKeys = toCypherStringList(fileTargets.map(target => target.key));
  const storyFilter = otherStoryPredicate('s', currentStoryKey, currentStoryId);

  try {
    const directMemories = await cypherQuery<{
      mid: unknown;
      sid: unknown;
      fpath: unknown;
    }>(
      `MATCH (f:File)<-[:TOUCHES]-(s:Story)-[:LEARNED_FROM]->(m:Memory)
       WHERE f.key IN ${fileKeys}
         AND ${storyFilter}
       RETURN DISTINCT m.id, s.id, f.path`,
      [
        { name: 'mid', type: 'agtype' },
        { name: 'sid', type: 'agtype' },
        { name: 'fpath', type: 'agtype' },
      ],
    );

    const extendedMemories = maxDepth > 2
      ? await cypherQuery<{
          mid: unknown;
          fpath: unknown;
        }>(
          `MATCH (f:File)<-[:TOUCHES]-(s:Story)-[:TOUCHES]->(f2:File)<-[:ABOUT]-(m:Memory)
           WHERE f.key IN ${fileKeys}
             AND f2.key <> f.key
             AND ${storyFilter}
           RETURN DISTINCT m.id, f2.path`,
          [
            { name: 'mid', type: 'agtype' },
            { name: 'fpath', type: 'agtype' },
          ],
        )
      : [];

    const memoryTexts = await getMemoryTexts([
      ...directMemories.map(row => String(row.mid ?? '')),
      ...extendedMemories.map(row => String(row.mid ?? '')),
    ]);

    for (const row of directMemories) {
      const memoryId = String(row.mid ?? '');
      const touchingStoryId = String(row.sid ?? '');
      const matchedPath = String(row.fpath ?? '');
      if (!memoryId) continue;

      uniqueNodes.add(`memory:${memoryId}`);
      uniqueNodes.add(`story:${touchingStoryId}`);
      result.relatedMemories.push({
        memoryId,
        text: memoryTexts.get(memoryId) ?? memoryId,
        relationship: `learned by ${touchingStoryId} which touched ${matchedPath}`,
        hops: 2,
        matchedPath,
      });
    }

    for (const row of extendedMemories) {
      const memoryId = String(row.mid ?? '');
      const aboutPath = String(row.fpath ?? '');
      if (!memoryId || !aboutPath) continue;

      uniqueNodes.add(`memory:${memoryId}`);
      result.relatedMemories.push({
        memoryId,
        text: memoryTexts.get(memoryId) ?? memoryId,
        relationship: `about co-modified file ${aboutPath}`,
        hops: 3,
        matchedPath: aboutPath,
      });
    }
  } catch (err) {
    logger.warn({ err, storyId: currentStoryId }, '[graph-context] related memory traversal failed');
  }
}

async function findConventionsBatch(
  fileTargets: ScopedFileTarget[],
  result: GraphContext,
): Promise<void> {
  const fileKeys = toCypherStringList(fileTargets.map(target => target.key));

  try {
    const rows = await cypherQuery<{
      name: unknown;
      source: unknown;
      layer: unknown;
      fpath: unknown;
    }>(
      `MATCH (c:Convention)-[:APPLIES_TO]->(f:File)
       WHERE f.key IN ${fileKeys}
       RETURN c.name, c.source, c.layer, f.path`,
      [
        { name: 'name', type: 'agtype' },
        { name: 'source', type: 'agtype' },
        { name: 'layer', type: 'agtype' },
        { name: 'fpath', type: 'agtype' },
      ],
    );

    for (const row of rows) {
      const name = String(row.name ?? '');
      const filePath = String(row.fpath ?? '');
      if (!name || !filePath) continue;

      result.relatedConventions.push({
        name,
        content: `Convention: ${name} (source: ${String(row.source ?? 'unknown')}, layer: ${String(row.layer ?? '')})`,
        appliesTo: filePath,
      });
    }
  } catch (err) {
    logger.warn({ err }, '[graph-context] convention traversal failed');
  }
}

async function buildFileHistoryBatch(
  fileTargets: ScopedFileTarget[],
  result: GraphContext,
): Promise<void> {
  const fileKeys = toCypherStringList(fileTargets.map(target => target.key));

  try {
    const rows = await cypherQuery<{
      sid: unknown;
      specid: unknown;
      fpath: unknown;
    }>(
      `MATCH (s:Story)-[:TOUCHES]->(f:File)
       WHERE f.key IN ${fileKeys}
       RETURN s.id, s.specId, f.path`,
      [
        { name: 'sid', type: 'agtype' },
        { name: 'specid', type: 'agtype' },
        { name: 'fpath', type: 'agtype' },
      ],
    );

    const historyByPath = new Map<string, FileHistory>();
    for (const row of rows) {
      const filePath = String(row.fpath ?? '');
      const storyId = String(row.sid ?? '');
      const specId = String(row.specid ?? '');
      if (!filePath || !storyId) continue;

      const existing = historyByPath.get(filePath) ?? {
        path: filePath,
        touchedByStories: [],
        lastModifiedSpec: specId,
      };
      if (!existing.touchedByStories.includes(storyId)) {
        existing.touchedByStories.push(storyId);
      }
      if (!existing.lastModifiedSpec && specId) {
        existing.lastModifiedSpec = specId;
      }
      historyByPath.set(filePath, existing);
    }

    result.fileHistory.push(...historyByPath.values());
  } catch (err) {
    logger.warn({ err }, '[graph-context] file history traversal failed');
  }
}

async function detectConflictsBatch(
  storyId: string,
  currentStoryKey: string | undefined,
  fileTargets: ScopedFileTarget[],
  result: GraphContext,
): Promise<void> {
  const fileKeys = toCypherStringList(fileTargets.map(target => target.key));

  try {
    const conflicts = await cypherQuery<{
      s2id: unknown;
      fpath: unknown;
    }>(
      `MATCH (f:File)<-[:TOUCHES]-(s2:Story)
       WHERE f.key IN ${fileKeys}
         AND ${otherStoryPredicate('s2', currentStoryKey, storyId)}
         AND s2.status = 'running'
       RETURN DISTINCT s2.id, f.path`,
      [
        { name: 's2id', type: 'agtype' },
        { name: 'fpath', type: 'agtype' },
      ],
    );

    for (const row of conflicts) {
      const conflictId = String(row.s2id ?? '');
      const filePath = String(row.fpath ?? '');
      if (!conflictId || !filePath || conflictId === storyId) continue;

      result.relatedMemories.push({
        memoryId: `conflict:${conflictId}:${filePath}`,
        text: `WARNING: Story ${conflictId} (status: running) is also touching ${filePath}`,
        relationship: 'conflict',
        hops: 1,
        matchedPath: filePath,
      });
    }
  } catch (err) {
    logger.warn({ err, storyId }, '[graph-context] conflict detection failed');
  }
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
    for (const memory of ctx.relatedMemories) {
      if (memory.relationship === 'conflict') {
        lines.push(`- **CONFLICT**: ${memory.text}`);
      } else {
        lines.push(`- ${memory.text} (${memory.relationship}, ${memory.hops} hops)`);
      }
    }
  }

  if (ctx.relatedConventions.length > 0) {
    lines.push('');
    lines.push('### Convention Context');
    for (const convention of ctx.relatedConventions) {
      lines.push(`- Follow convention "${convention.name}" for files matching ${convention.appliesTo}`);
    }
  }

  if (ctx.fileHistory.length > 0) {
    lines.push('');
    lines.push('### File Touch History');
    for (const history of ctx.fileHistory) {
      lines.push(
        `- \`${history.path}\` was modified by stories: ${history.touchedByStories.join(', ')}` +
        (history.lastModifiedSpec ? ` (spec: ${history.lastModifiedSpec})` : ''),
      );
    }
  }

  return lines.join('\n');
}
