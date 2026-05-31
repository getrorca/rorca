/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * PG-015: Knowledge Graph — Apache AGE Cypher bridge for Rorca
 *
 * Provides typed wrappers around Apache AGE Cypher queries executed via
 * PostgreSQL's SQL/Cypher bridge:
 *
 *   SELECT * FROM cypher('rorca', $$ MATCH ... RETURN ... $$) AS (col agtype)
 *
 * All queries are parameterized. The graph is additive (append-only) —
 * historical edges are preserved for temporal analysis.
 *
 * PG-019: Graceful degradation when Apache AGE is unavailable.
 * On managed Postgres services (Supabase, Neon), AGE is not installed.
 * All graph functions check `isGraphAvailable()` and return empty results
 * gracefully when AGE is missing. Core functionality (search, memory,
 * CAG/RAG) works without the graph layer.
 */

import * as fs from 'fs';
import * as path from 'path';
import { pool, query } from '../db/index';
import { logger } from './logger';
import type { PoolClient } from 'pg';
import { checkAge, getAgeUnavailableBody } from './age-guard';

// ── Graph Availability Flag ─────────────────────────────────────────────────

/**
 * PG-019: Track whether Apache AGE is available on this Postgres instance.
 * Checked on first graph operation, then cached with TTL.
 *   - `null` = not yet checked
 *   - `true` = AGE available (cached indefinitely)
 *   - `false` = AGE unavailable — re-checked every 60s so recovery is automatic
 */
let _graphAvailable: boolean | null = null;
let _graphAvailableCheckedAt = 0;
const GRAPH_AVAILABLE_NEGATIVE_TTL_MS = 60_000; // re-check every 60s on negative result
const RORCA_V2_GRAPH = 'rorca_v2';
const RORCA_V2_KEYED_NODE_LABELS = ['Story', 'File', 'Spec', 'Memory', 'Convention', 'Skill'] as const;

export type RorcaV2KeyedNodeLabel = typeof RORCA_V2_KEYED_NODE_LABELS[number];

export interface GraphBootstrapUnavailable {
  available: false;
  statusCode: 503;
  error: string;
  code: 'AGE_NOT_INSTALLED';
  mode: 'lite';
  hint: string;
}

export interface GraphBootstrapReady {
  available: true;
  graphName: typeof RORCA_V2_GRAPH;
  labels: RorcaV2KeyedNodeLabel[];
  keyIndexes: string[];
}

export type GraphBootstrapResult = GraphBootstrapReady | GraphBootstrapUnavailable;

/**
 * Check if Apache AGE is available on the current Postgres instance.
 * Positive results are cached indefinitely. Negative results expire after 60s
 * so the system auto-recovers if AGE becomes available after startup.
 */
export async function isGraphAvailable(): Promise<boolean> {
  if (_graphAvailable === true) return true;

  // Negative result with TTL — re-check after expiry
  if (_graphAvailable === false) {
    const elapsed = Date.now() - _graphAvailableCheckedAt;
    if (elapsed < GRAPH_AVAILABLE_NEGATIVE_TTL_MS) return false;
    // TTL expired, re-check below
    _graphAvailable = null;
  }

  try {
    const result = await pool.query<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname = 'age'"
    );
    _graphAvailable = result.rows.length > 0;
    _graphAvailableCheckedAt = Date.now();

    if (_graphAvailable) {
      logger.info('[knowledge-graph] isGraphAvailable=true — AGE extension found');
    } else {
      logger.info(
        '[knowledge-graph] isGraphAvailable=false — AGE extension not found in pg_extension. ' +
        'Will re-check in 60s. Use self-hosted Postgres for full graph support.'
      );
    }
  } catch (err) {
    _graphAvailable = false;
    _graphAvailableCheckedAt = Date.now();
    logger.info(
      { err },
      '[knowledge-graph] isGraphAvailable=false — query error checking AGE extension. Will re-check in 60s.'
    );
  }

  return _graphAvailable;
}

/**
 * Reset the cached graph availability flag.
 * Useful after extension installation or for testing.
 */
export function resetGraphAvailability(): void {
  _graphAvailable = null;
  _graphAvailableCheckedAt = 0;
}

// ── agtype Parsing ──────────────────────────────────────────────────────────

/**
 * Parse an Apache AGE agtype value into a JavaScript value.
 * AGE returns results as agtype — a JSON-like string with type suffixes.
 *
 * Examples:
 *   "hello"::agtype  → "hello"
 *   42::agtype        → 42
 *   {"id": "US-001", "title": "..."}::vertex → { id: "US-001", title: "..." }
 */
export function parseAgtype<T = unknown>(value: unknown): T {
  if (value === null || value === undefined) return null as T;

  // AGE returns agtype as a string in the pg driver
  if (typeof value === 'string') {
    // Strip trailing ::vertex, ::edge, ::path suffixes if present
    const cleaned = value
      .replace(/::vertex$/i, '')
      .replace(/::edge$/i, '')
      .replace(/::path$/i, '');
    try {
      return JSON.parse(cleaned) as T;
    } catch {
      // If it's a simple scalar string wrapped in quotes
      if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
        return cleaned.slice(1, -1) as unknown as T;
      }
      return cleaned as unknown as T;
    }
  }

  // Already parsed (shouldn't happen with pg driver but handle gracefully)
  return value as T;
}

/**
 * Parse a row of agtype columns into typed values.
 */
function parseAgtypeRow<T>(row: Record<string, unknown>): T {
  const parsed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    parsed[key] = parseAgtype(value);
  }
  return parsed as T;
}

// ── Session Setup ───────────────────────────────────────────────────────────

/**
 * AGE requires LOAD 'age' and SET search_path per connection/session.
 * This must be called before any Cypher query on a given client.
 */
async function setupAgeSession(client: PoolClient): Promise<void> {
  logger.debug('[knowledge-graph] setupAgeSession: running LOAD age + SET search_path');
  await client.query("LOAD 'age'");
  await client.query("SET search_path = ag_catalog, \"$user\", public");
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function rorcaV2KeyIndexName(label: RorcaV2KeyedNodeLabel): string {
  return `idx_${RORCA_V2_GRAPH}_${label.toLowerCase()}_key`;
}

async function ensureGraphExists(client: PoolClient, graphName: string): Promise<void> {
  const existing = await client.query(
    'SELECT 1 FROM ag_catalog.ag_graph WHERE name = $1',
    [graphName],
  );
  if (existing.rowCount === 0) {
    await client.query('SELECT create_graph($1)', [graphName]);
  }
}

async function ensureVertexLabelExists(
  client: PoolClient,
  graphName: string,
  label: RorcaV2KeyedNodeLabel,
): Promise<void> {
  const existing = await client.query(
    `SELECT 1 FROM ag_catalog.ag_label
     WHERE graph = (SELECT graphid FROM ag_catalog.ag_graph WHERE name = $1)
       AND name = $2
       AND kind = 'v'`,
    [graphName, label],
  );
  if (existing.rowCount === 0) {
    await client.query('SELECT create_vlabel($1, $2)', [graphName, label]);
  }
}

async function ensureCanonicalKeyIndex(
  client: PoolClient,
  graphName: typeof RORCA_V2_GRAPH,
  label: RorcaV2KeyedNodeLabel,
): Promise<string> {
  const indexName = rorcaV2KeyIndexName(label);
  await client.query(
    `CREATE INDEX IF NOT EXISTS ${quoteIdent(indexName)}
     ON ${quoteIdent(graphName)}.${quoteIdent(label)}
     USING btree (agtype_access_operator(properties, '"key"'::agtype))`,
  );
  return indexName;
}

/**
 * Explicit bootstrap for the next-generation graph projection.
 *
 * This intentionally does not change any existing runtime reads/writes, which
 * still target the legacy `rorca` graph. AGE does not provide Neo4j-style
 * property uniqueness constraints in the current stack, so the strongest
 * compatible lookup support here is an idempotent btree expression index over
 * each label table's canonical `properties.key` value.
 */
export async function initRorcaV2Graph(): Promise<GraphBootstrapResult> {
  if (!(await checkAge())) {
    return {
      available: false,
      statusCode: 503,
      ...getAgeUnavailableBody(),
    };
  }

  const client = await pool.connect();
  try {
    await setupAgeSession(client);
    await ensureGraphExists(client, RORCA_V2_GRAPH);

    const keyIndexes: string[] = [];
    for (const label of RORCA_V2_KEYED_NODE_LABELS) {
      await ensureVertexLabelExists(client, RORCA_V2_GRAPH, label);
      keyIndexes.push(await ensureCanonicalKeyIndex(client, RORCA_V2_GRAPH, label));
    }

    logger.info(
      { graphName: RORCA_V2_GRAPH, labels: RORCA_V2_KEYED_NODE_LABELS, keyIndexes },
      '[knowledge-graph] rorca_v2 graph bootstrap complete',
    );

    return {
      available: true,
      graphName: RORCA_V2_GRAPH,
      labels: [...RORCA_V2_KEYED_NODE_LABELS],
      keyIndexes,
    };
  } finally {
    await client.query('SET search_path = rorca, public');
    client.release();
  }
}

// ── Cypher Query Helper ─────────────────────────────────────────────────────

interface CypherColumn {
  name: string;
  type: string; // 'agtype' for all AGE columns
}

/**
 * Execute a Cypher query against the 'rorca' graph.
 *
 * @param cypher - Cypher query string (parameterize with $param syntax)
 * @param returnColumns - Column definitions for the RETURN clause
 * @param params - Optional parameters passed to the Cypher query
 *
 * @example
 * ```ts
 * const rows = await cypherQuery(
 *   "MATCH (s:Story {id: 'US-001'})-[:TOUCHES]->(f:File) RETURN f.path",
 *   [{ name: 'path', type: 'agtype' }]
 * );
 * ```
 */
async function cypherQuery<T = Record<string, unknown>>(
  cypher: string,
  returnColumns: CypherColumn[],
): Promise<T[]> {
  const columnDef = returnColumns.map(c => `${c.name} ${c.type}`).join(', ');
  const sql = `SELECT * FROM cypher('rorca', $$ ${cypher} $$) AS (${columnDef})`;

  const p = pool;
  logger.debug('[knowledge-graph] cypherQuery: acquiring pool client');
  const client = await p.connect();
  try {
    await setupAgeSession(client);
    const result = await client.query(sql);
    logger.debug({ rowCount: result.rowCount }, '[knowledge-graph] cypherQuery: query complete');
    return result.rows.map(row => parseAgtypeRow<T>(row));
  } finally {
    await client.query('SET search_path = rorca, public');
    client.release();
    logger.debug('[knowledge-graph] cypherQuery: pool client released');
  }
}

/**
 * Execute a Cypher mutation (MERGE/CREATE) that returns no results.
 */
async function cypherMutate(cypher: string): Promise<void> {
  const sql = `SELECT * FROM cypher('rorca', $$ ${cypher} $$) AS (v agtype)`;

  const p = pool;
  logger.debug('[knowledge-graph] cypherMutate: acquiring pool client');
  const client = await p.connect();
  try {
    await setupAgeSession(client);
    await client.query(sql);
    logger.debug('[knowledge-graph] cypherMutate: mutation complete');
  } catch (err) {
    logger.error(
      { err, cypher: cypher.trim().substring(0, 500) },
      '[knowledge-graph] cypherMutate failed — Cypher query text included',
    );
    throw err;
  } finally {
    await client.query('SET search_path = rorca, public');
    client.release();
    logger.debug('[knowledge-graph] cypherMutate: pool client released');
  }
}

// ── Escape Helpers ──────────────────────────────────────────────────────────

/**
 * Escape a string value for use in Cypher property maps.
 * Prevents Cypher injection by escaping single quotes and backslashes.
 */
function escCypher(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

function evidenceEdgeSet(alias: string): string {
  const now = new Date().toISOString();
  return `
    ON CREATE SET ${alias}.evidenceCount = 1,
                  ${alias}.lastSeenAt = '${now}'
    ON MATCH SET ${alias}.evidenceCount = COALESCE(${alias}.evidenceCount, 0) + 1,
                 ${alias}.lastSeenAt = '${now}'
  `;
}

/**
 * Extract probable file paths from prose chunks produced by the story log follower.
 * Supports human-readable tool traces like "Reading src/foo.ts" and "Editing backend/app.ts".
 */
function extractFilePathsFromProse(text: string): string[] {
  if (!text) return [];

  const paths = new Set<string>();
  const humanReadable = /\b(?:Reading|Writing|Editing|Read|Write|Edit)\s+([\w./@-]+\.[\w-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = humanReadable.exec(text)) !== null) {
    paths.add(match[1]);
  }

  const genericPath = /(?:^|\s)((?:[\w.-]+\/)+[\w.-]+\.[\w-]+)/g;
  while ((match = genericPath.exec(text)) !== null) {
    paths.add(match[1]);
  }

  return [...paths];
}

/**
 * Collect file paths touched by a story from the story_output_chunks table.
 * This mines the human-readable story log trail instead of using commit SHAs as
 * file proxies, which keeps graph file nodes aligned with actual paths.
 */
export async function collectStoryFileTouches(runId: number, storyId: string): Promise<string[]> {
  try {
    const rows = await query<{ chunk: string }>(
      `SELECT chunk FROM story_output_chunks
       WHERE run_id = $1 AND story_id = $2
       ORDER BY sequence ASC`,
      [runId, storyId],
    );

    const paths = new Set<string>();
    for (const row of rows) {
      for (const filePath of extractFilePathsFromProse(row.chunk)) {
        paths.add(filePath);
      }
    }
    return [...paths];
  } catch {
    return [];
  }
}

// ── Node Operations ─────────────────────────────────────────────────────────

export interface StoryNode {
  id: string;
  specId: string;
  workspaceId: string;
  title: string;
  status: string;
}

export interface FileNode {
  path: string;
  workspace_id: string;
}

export interface MemoryNode {
  id: string;
  category: string;
  created_at: string;
}

export interface SpecNode {
  id: string;
  title: string;
  status: string;
  workspace_id: string;
}

export interface ConventionNode {
  name: string;
  source: string;
  layer: string;
}

export interface WorkspaceNode {
  id: string;
  label: string;
}

export interface SkillNode {
  name: string;
  source: string;
}

export function normalizeGraphFilePath(filePath: string): string {
  const normalized = path.posix.normalize((filePath || '').trim().replace(/\\/g, '/'));
  if (normalized === '.' || normalized === '') return '';
  return normalized.replace(/^\.\//, '');
}

export function buildStoryNodeKey(workspaceId: string, specId: string, storyId: string): string {
  return `story:${workspaceId}::${specId}::${storyId}`;
}

export function buildFileNodeKey(workspaceId: string, filePath: string): string {
  return `file:${workspaceId}::${normalizeGraphFilePath(filePath)}`;
}

export function buildSpecNodeKey(workspaceId: string, specId: string): string {
  return `spec:${workspaceId}::${specId}`;
}

export function buildMemoryNodeKey(workspaceId: string, memoryId: string): string {
  return `memory:${workspaceId}::${memoryId}`;
}

export function buildConventionNodeKey(workspaceId: string, conventionName: string): string {
  return `convention:${workspaceId}::${conventionName}`;
}

export function buildSkillNodeKey(skillName: string, source?: string): string {
  return `skill:${source || 'default'}::${skillName}`;
}

/**
 * Add or update a Story vertex in the knowledge graph.
 * Uses MERGE to be idempotent.
 * PG-019: No-op if AGE is unavailable.
 */
export async function addStoryNode(story: StoryNode): Promise<void> {
  if (!(await isGraphAvailable())) return;
  const storyKey = buildStoryNodeKey(story.workspaceId, story.specId, story.id);
  const cypher = `
    MERGE (s:Story {key: '${escCypher(storyKey)}'})
    SET s.id = '${escCypher(story.id)}',
        s.storyId = '${escCypher(story.id)}',
        s.specId = '${escCypher(story.specId)}',
        s.workspaceId = '${escCypher(story.workspaceId)}',
        s.workspace_id = '${escCypher(story.workspaceId)}',
        s.title = '${escCypher(story.title)}',
        s.status = '${escCypher(story.status)}'
  `;
  await cypherMutate(cypher);
  logger.debug({ storyId: story.id, storyKey }, '[knowledge-graph] Story node upserted');
}

/**
 * Add a File vertex (if not exists) and create a TOUCHES edge from a Story.
 * PG-019: No-op if AGE is unavailable.
 */
export async function addFileTouch(
  storyId: string,
  filePath: string,
  workspaceId: string,
  specId: string,
): Promise<void> {
  if (!(await isGraphAvailable())) return;
  const normalizedPath = normalizeGraphFilePath(filePath);
  const cypher = `
    MERGE (s:Story {key: '${escCypher(buildStoryNodeKey(workspaceId, specId, storyId))}'})
    ON CREATE SET s.id = '${escCypher(storyId)}',
                  s.storyId = '${escCypher(storyId)}',
                  s.specId = '${escCypher(specId)}',
                  s.workspaceId = '${escCypher(workspaceId)}',
                  s.workspace_id = '${escCypher(workspaceId)}'
    MERGE (f:File {key: '${escCypher(buildFileNodeKey(workspaceId, normalizedPath))}'})
    SET f.path = '${escCypher(normalizedPath)}',
        f.workspaceId = '${escCypher(workspaceId)}',
        f.workspace_id = '${escCypher(workspaceId)}'
    MERGE (s)-[r:TOUCHES]->(f)
    ${evidenceEdgeSet('r')}
  `;
  await cypherMutate(cypher);
  logger.debug({ storyId, filePath: normalizedPath, workspaceId, specId }, '[knowledge-graph] File touch edge added');
}

/**
 * Link a Memory entry to the Story that produced it.
 * PG-019: No-op if AGE is unavailable.
 */
export async function addMemoryLink(
  memoryId: string,
  storyId: string,
  specId: string,
  workspaceId: string,
  category?: string,
): Promise<void> {
  if (!(await isGraphAvailable())) return;
  const cat = category || '';
  const cypher = `
    MERGE (m:Memory {key: '${escCypher(buildMemoryNodeKey(workspaceId, memoryId))}'})
    ON CREATE SET m.created_at = '${new Date().toISOString()}'
    SET m.id = '${escCypher(memoryId)}',
        m.category = COALESCE(m.category, '${escCypher(cat)}'),
        m.workspaceId = '${escCypher(workspaceId)}'
    MERGE (s:Story {key: '${escCypher(buildStoryNodeKey(workspaceId, specId, storyId))}'})
    ON CREATE SET s.id = '${escCypher(storyId)}',
                  s.storyId = '${escCypher(storyId)}',
                  s.specId = '${escCypher(specId)}',
                  s.workspaceId = '${escCypher(workspaceId)}',
                  s.workspace_id = '${escCypher(workspaceId)}'
    MERGE (m)-[r:LEARNED_FROM]->(s)
    ${evidenceEdgeSet('r')}
  `;
  await cypherMutate(cypher);
  logger.debug({ memoryId, storyId, specId, workspaceId }, '[knowledge-graph] Memory link added');
}

/**
 * Link a Memory entry to a specific File it references.
 * PG-019: No-op if AGE is unavailable.
 */
export async function addMemoryAboutFile(
  memoryId: string,
  filePath: string,
  workspaceId: string,
): Promise<void> {
  if (!(await isGraphAvailable())) return;
  const normalizedPath = normalizeGraphFilePath(filePath);
  const cypher = `
    MERGE (m:Memory {key: '${escCypher(buildMemoryNodeKey(workspaceId, memoryId))}'})
    SET m.id = '${escCypher(memoryId)}',
        m.workspaceId = '${escCypher(workspaceId)}'
    MERGE (f:File {key: '${escCypher(buildFileNodeKey(workspaceId, normalizedPath))}'})
    SET f.path = '${escCypher(normalizedPath)}',
        f.workspaceId = '${escCypher(workspaceId)}',
        f.workspace_id = '${escCypher(workspaceId)}'
    MERGE (m)-[r:ABOUT]->(f)
    ${evidenceEdgeSet('r')}
  `;
  await cypherMutate(cypher);
  logger.debug({ memoryId, filePath: normalizedPath, workspaceId }, '[knowledge-graph] Memory-about-file edge added');
}

/**
 * Link a Memory entry to the Spec that produced it.
 * PG-019: No-op if AGE is unavailable.
 */
export async function addMemorySourceSpec(memoryId: string, specId: string, workspaceId: string): Promise<void> {
  if (!(await isGraphAvailable())) return;
  const cypher = `
    MERGE (m:Memory {key: '${escCypher(buildMemoryNodeKey(workspaceId, memoryId))}'})
    SET m.id = '${escCypher(memoryId)}',
        m.workspaceId = '${escCypher(workspaceId)}'
    MERGE (sp:Spec {key: '${escCypher(buildSpecNodeKey(workspaceId, specId))}'})
    ON CREATE SET sp.id = '${escCypher(specId)}',
                  sp.specId = '${escCypher(specId)}',
                  sp.workspaceId = '${escCypher(workspaceId)}',
                  sp.workspace_id = '${escCypher(workspaceId)}'
    MERGE (m)-[r:FROM_SPEC]->(sp)
    ${evidenceEdgeSet('r')}
  `;
  await cypherMutate(cypher);
  logger.debug({ memoryId, specId, workspaceId }, '[knowledge-graph] Memory-from-spec edge added');
}

/**
 * Link a Convention to a File pattern it governs.
 * PG-019: No-op if AGE is unavailable.
 */
export async function addConventionLink(
  conventionName: string,
  filePath: string,
  workspaceId: string,
  source?: string,
  layer?: string,
): Promise<void> {
  if (!(await isGraphAvailable())) return;
  const normalizedPath = normalizeGraphFilePath(filePath);
  const cypher = `
    MERGE (c:Convention {key: '${escCypher(buildConventionNodeKey(workspaceId, conventionName))}'})
    SET c.name = '${escCypher(conventionName)}',
        c.source = '${escCypher(source || '')}',
        c.layer = '${escCypher(layer || '')}',
        c.workspaceId = '${escCypher(workspaceId)}'
    MERGE (f:File {key: '${escCypher(buildFileNodeKey(workspaceId, normalizedPath))}'})
    SET f.path = '${escCypher(normalizedPath)}',
        f.workspaceId = '${escCypher(workspaceId)}',
        f.workspace_id = '${escCypher(workspaceId)}'
    MERGE (c)-[r:APPLIES_TO]->(f)
    ${evidenceEdgeSet('r')}
  `;
  await cypherMutate(cypher);
  logger.debug({ conventionName, filePath: normalizedPath, workspaceId }, '[knowledge-graph] Convention link added');
}

/**
 * Mark a Convention as violated by a Story.
 * PG-019: No-op if AGE is unavailable.
 */
export async function addConventionViolation(
  conventionName: string,
  storyId: string,
  specId: string,
  workspaceId: string,
): Promise<void> {
  if (!(await isGraphAvailable())) return;
  const cypher = `
    MERGE (c:Convention {key: '${escCypher(buildConventionNodeKey(workspaceId, conventionName))}'})
    SET c.name = '${escCypher(conventionName)}',
        c.workspaceId = '${escCypher(workspaceId)}'
    MERGE (s:Story {key: '${escCypher(buildStoryNodeKey(workspaceId, specId, storyId))}'})
    ON CREATE SET s.id = '${escCypher(storyId)}',
                  s.storyId = '${escCypher(storyId)}',
                  s.specId = '${escCypher(specId)}',
                  s.workspaceId = '${escCypher(workspaceId)}',
                  s.workspace_id = '${escCypher(workspaceId)}'
    MERGE (c)-[r:VIOLATED_BY]->(s)
    ${evidenceEdgeSet('r')}
  `;
  await cypherMutate(cypher);
  logger.debug({ conventionName, storyId, specId, workspaceId }, '[knowledge-graph] Convention violation edge added');
}

/**
 * Track which Skill was injected/used in a Story.
 * PG-019: No-op if AGE is unavailable.
 */
export async function addSkillUsage(skillName: string, storyId: string, specId: string, workspaceId: string, source?: string): Promise<void> {
  if (!(await isGraphAvailable())) return;
  const cypher = `
    MERGE (sk:Skill {key: '${escCypher(buildSkillNodeKey(skillName, source))}'})
    SET sk.name = '${escCypher(skillName)}',
        sk.source = '${escCypher(source || '')}'
    MERGE (s:Story {key: '${escCypher(buildStoryNodeKey(workspaceId, specId, storyId))}'})
    ON CREATE SET s.id = '${escCypher(storyId)}',
                  s.storyId = '${escCypher(storyId)}',
                  s.specId = '${escCypher(specId)}',
                  s.workspaceId = '${escCypher(workspaceId)}',
                  s.workspace_id = '${escCypher(workspaceId)}'
    MERGE (sk)-[r:USED_IN]->(s)
    ${evidenceEdgeSet('r')}
  `;
  await cypherMutate(cypher);
  logger.debug({ skillName, storyId, specId }, '[knowledge-graph] Skill usage edge added');
}

/**
 * Add Spec node and link it to a Workspace.
 * PG-019: No-op if AGE is unavailable.
 */
export async function addSpecNode(spec: SpecNode): Promise<void> {
  if (!(await isGraphAvailable())) return;
  const cypher = `
    MERGE (sp:Spec {key: '${escCypher(buildSpecNodeKey(spec.workspace_id, spec.id))}'})
    SET sp.id = '${escCypher(spec.id)}',
        sp.specId = '${escCypher(spec.id)}',
        sp.title = '${escCypher(spec.title)}',
        sp.status = '${escCypher(spec.status)}',
        sp.workspaceId = '${escCypher(spec.workspace_id)}',
        sp.workspace_id = '${escCypher(spec.workspace_id)}'
    MERGE (w:Workspace {id: '${escCypher(spec.workspace_id)}'})
    MERGE (sp)-[r:IN_WORKSPACE]->(w)
    ${evidenceEdgeSet('r')}
  `;
  await cypherMutate(cypher);
  logger.debug({ specId: spec.id, workspaceId: spec.workspace_id }, '[knowledge-graph] Spec node upserted');
}

/**
 * Add Story BELONGS_TO Spec edge.
 * PG-019: No-op if AGE is unavailable.
 */
export async function addStoryToSpec(storyId: string, specId: string, workspaceId: string): Promise<void> {
  if (!(await isGraphAvailable())) return;
  const cypher = `
    MERGE (s:Story {key: '${escCypher(buildStoryNodeKey(workspaceId, specId, storyId))}'})
    ON CREATE SET s.id = '${escCypher(storyId)}',
                  s.storyId = '${escCypher(storyId)}',
                  s.specId = '${escCypher(specId)}',
                  s.workspaceId = '${escCypher(workspaceId)}',
                  s.workspace_id = '${escCypher(workspaceId)}'
    MERGE (sp:Spec {key: '${escCypher(buildSpecNodeKey(workspaceId, specId))}'})
    ON CREATE SET sp.id = '${escCypher(specId)}',
                  sp.specId = '${escCypher(specId)}',
                  sp.workspaceId = '${escCypher(workspaceId)}',
                  sp.workspace_id = '${escCypher(workspaceId)}'
    MERGE (s)-[r:BELONGS_TO]->(sp)
    ${evidenceEdgeSet('r')}
  `;
  await cypherMutate(cypher);
}

/**
 * Add Story DEPENDS_ON Story edges from the spec JSON dependsOn field.
 * PG-019: No-op if AGE is unavailable.
 */
export async function addStoryDependency(storyId: string, dependsOnId: string, specId: string, workspaceId: string): Promise<void> {
  if (!(await isGraphAvailable())) return;
  const cypher = `
    MERGE (s:Story {key: '${escCypher(buildStoryNodeKey(workspaceId, specId, storyId))}'})
    ON CREATE SET s.id = '${escCypher(storyId)}',
                  s.storyId = '${escCypher(storyId)}',
                  s.specId = '${escCypher(specId)}',
                  s.workspaceId = '${escCypher(workspaceId)}',
                  s.workspace_id = '${escCypher(workspaceId)}'
    MERGE (d:Story {key: '${escCypher(buildStoryNodeKey(workspaceId, specId, dependsOnId))}'})
    ON CREATE SET d.id = '${escCypher(dependsOnId)}',
                  d.storyId = '${escCypher(dependsOnId)}',
                  d.specId = '${escCypher(specId)}',
                  d.workspaceId = '${escCypher(workspaceId)}',
                  d.workspace_id = '${escCypher(workspaceId)}'
    MERGE (s)-[r:DEPENDS_ON]->(d)
    ${evidenceEdgeSet('r')}
  `;
  await cypherMutate(cypher);
}

// ── Query Operations ────────────────────────────────────────────────────────

export type NodeType = 'Story' | 'File' | 'Memory' | 'Spec' | 'Convention' | 'Workspace' | 'Skill';
export type EdgeType = 'TOUCHES' | 'BELONGS_TO' | 'DEPENDS_ON' | 'LEARNED_FROM' | 'ABOUT' | 'APPLIES_TO' | 'VIOLATED_BY' | 'USED_IN' | 'IN_WORKSPACE' | 'FROM_SPEC';

export interface CypherResult {
  id: unknown;
  label: string;
  properties: Record<string, unknown>;
}

export interface GraphQueryScope {
  workspaceId?: string;
  specId?: string;
}

export interface GraphNodeLookup {
  property: string;
  value: string;
  normalizedNodeId: string;
}

export function buildScopedGraphNodeLookup(
  nodeType: NodeType,
  nodeId: string,
  scope: GraphQueryScope = {},
): GraphNodeLookup {
  const normalizedNodeId = nodeType === 'File' ? normalizeGraphFilePath(nodeId) : nodeId;

  if (nodeType === 'Story' && scope.workspaceId && scope.specId) {
    return {
      property: 'key',
      value: buildStoryNodeKey(scope.workspaceId, scope.specId, normalizedNodeId),
      normalizedNodeId,
    };
  }

  if (nodeType === 'File' && scope.workspaceId) {
    return {
      property: 'key',
      value: buildFileNodeKey(scope.workspaceId, normalizedNodeId),
      normalizedNodeId,
    };
  }

  if (nodeType === 'Spec' && scope.workspaceId) {
    return {
      property: 'key',
      value: buildSpecNodeKey(scope.workspaceId, normalizedNodeId),
      normalizedNodeId,
    };
  }

  if (nodeType === 'Memory' && scope.workspaceId) {
    return {
      property: 'key',
      value: buildMemoryNodeKey(scope.workspaceId, normalizedNodeId),
      normalizedNodeId,
    };
  }

  if (nodeType === 'Convention' && scope.workspaceId) {
    return {
      property: 'key',
      value: buildConventionNodeKey(scope.workspaceId, normalizedNodeId),
      normalizedNodeId,
    };
  }

  return {
    property: nodeType === 'File' ? 'path' : nodeType === 'Convention' || nodeType === 'Skill' ? 'name' : 'id',
    value: normalizedNodeId,
    normalizedNodeId,
  };
}

/**
 * Query nodes related to a given node, optionally filtering by edge types and depth.
 *
 * @param nodeType - The label of the starting node
 * @param nodeId - The `id` (or `path`/`name`) property of the starting node
 * @param depth - Max traversal depth (default 1)
 * @param edgeTypes - Optional list of edge types to traverse
 */
export async function queryRelated(
  nodeType: NodeType,
  nodeId: string,
  depth: number = 1,
  edgeTypes?: EdgeType[],
  scope?: GraphQueryScope,
): Promise<CypherResult[]> {
  if (!(await isGraphAvailable())) return [];

  // Apache AGE accepts variable-length single-type traversals like
  // [:DEPENDS_ON*1..2] but rejects Neo4j-style alternation such as
  // [:DEPENDS_ON|TOUCHES*1..2]. When multiple edge types are requested,
  // fan out into one query per type and merge the results in memory.
  if (edgeTypes && edgeTypes.length > 1) {
    const results = await Promise.all(
      edgeTypes.map((edgeType) => queryRelated(nodeType, nodeId, depth, [edgeType], scope)),
    );
    const deduped = new Map<string, CypherResult>();
    for (const resultSet of results) {
      for (const row of resultSet) {
        const key = `${row.label}:${String(row.id)}:${JSON.stringify(row.properties)}`;
        if (!deduped.has(key)) deduped.set(key, row);
      }
    }
    return [...deduped.values()];
  }

  const lookup = buildScopedGraphNodeLookup(nodeType, nodeId, scope);
  const edgeFilter = edgeTypes && edgeTypes.length === 1
    ? `:${edgeTypes[0]}`
    : '';

  const cypher = `
    MATCH (start:${nodeType} {${lookup.property}: '${escCypher(lookup.value)}'})
          -[${edgeFilter}*1..${depth}]-
          (related)
    RETURN DISTINCT related
  `;

  try {
    const rows = await cypherQuery<{ related: unknown }>(
      cypher,
      [{ name: 'related', type: 'agtype' }],
    );

    return rows.map(row => {
      const val = row.related as Record<string, unknown>;
      const props = (val?.properties as Record<string, unknown>) || {};
      return {
        id: val?.id ?? props.id ?? null,
        label: (val?.label as string) || '',
        properties: props,
      };
    });
  } catch (err) {
    logger.error({ err, nodeType, nodeId: lookup.normalizedNodeId, edgeTypes, scope }, '[knowledge-graph] queryRelated failed');
    return [];
  }
}

// ── Impact Query ────────────────────────────────────────────────────────────

export interface ImpactResult {
  stories: Array<{ id: string; title: string; specId: string }>;
  specs: Array<{ id: string; title: string }>;
  conventions: Array<{ name: string; source: string }>;
}

/**
 * Fan-out query: find all stories, specs, and conventions connected to a file path.
 * Useful for understanding the blast radius of changes to a file.
 */
export async function queryImpact(filePath: string, workspaceId?: string): Promise<ImpactResult> {
  const result: ImpactResult = {
    stories: [],
    specs: [],
    conventions: [],
  };

  if (!(await isGraphAvailable())) return result;

  const fileLookup = buildScopedGraphNodeLookup('File', filePath, { workspaceId });

  try {
    // Stories that touch this file
    const storyRows = await cypherQuery<{ id: unknown; title: unknown; specId: unknown }>(
      `MATCH (s:Story)-[:TOUCHES]->(f:File {${fileLookup.property}: '${escCypher(fileLookup.value)}'})
       RETURN s.id, s.title, s.specId`,
      [
        { name: 'id', type: 'agtype' },
        { name: 'title', type: 'agtype' },
        { name: 'specId', type: 'agtype' },
      ],
    );
    result.stories = storyRows.map(r => ({
      id: String(parseAgtype(r.id) ?? ''),
      title: String(parseAgtype(r.title) ?? ''),
      specId: String(parseAgtype(r.specId) ?? ''),
    }));

    // Specs connected through stories that touch this file
    const specRows = await cypherQuery<{ id: unknown; title: unknown }>(
      `MATCH (s:Story)-[:TOUCHES]->(f:File {${fileLookup.property}: '${escCypher(fileLookup.value)}'})
       MATCH (s)-[:BELONGS_TO]->(sp:Spec)
       RETURN DISTINCT sp.id, sp.title`,
      [
        { name: 'id', type: 'agtype' },
        { name: 'title', type: 'agtype' },
      ],
    );
    result.specs = specRows.map(r => ({
      id: String(parseAgtype(r.id) ?? ''),
      title: String(parseAgtype(r.title) ?? ''),
    }));

    // Conventions that apply to this file
    const convRows = await cypherQuery<{ name: unknown; source: unknown }>(
      `MATCH (c:Convention)-[:APPLIES_TO]->(f:File {${fileLookup.property}: '${escCypher(fileLookup.value)}'})
       RETURN c.name, c.source`,
      [
        { name: 'name', type: 'agtype' },
        { name: 'source', type: 'agtype' },
      ],
    );
    result.conventions = convRows.map(r => ({
      name: String(parseAgtype(r.name) ?? ''),
      source: String(parseAgtype(r.source) ?? ''),
    }));
  } catch (err) {
    logger.error({ err, filePath: fileLookup.normalizedNodeId, workspaceId }, '[knowledge-graph] queryImpact failed');
  }

  return result;
}

// ── Bulk Population from WAL Events ─────────────────────────────────────────

/**
 * Populate graph from a completed run:
 * - Mine story_output_chunks for real file paths → Story-[:TOUCHES]->File edges
 * - Parse spec JSON for dependsOn → Story-[:DEPENDS_ON]->Story edges
 * - Create Story-[:BELONGS_TO]->Spec edges
 * - Create Spec-[:IN_WORKSPACE]->Workspace edges
 */
export async function populateFromRun(
  runId: number,
  specId: string,
  workspaceId: string,
): Promise<{ nodesCreated: number; edgesCreated: number }> {
  let nodesCreated = 0;
  let edgesCreated = 0;

  if (!(await isGraphAvailable())) return { nodesCreated, edgesCreated };

  try {
    // 1. Get story results for this run
    const storyResults = await query<{
      story_id: string;
      status: string;
    }>(
      'SELECT story_id, status FROM story_results WHERE run_id = $1',
      [runId],
    );

    if (storyResults.length === 0) {
      logger.debug({ runId }, '[knowledge-graph] No story results for run');
      return { nodesCreated, edgesCreated };
    }

    // 2. Add spec node
    await addSpecNode({
      id: specId,
      title: specId, // We use the slug as title since we don't have the human title here
      status: 'completed',
      workspace_id: String(workspaceId),
    });
    nodesCreated++;

    // 3. Process each story
    for (const sr of storyResults) {
      // Add story node
      await addStoryNode({
        id: sr.story_id,
        specId,
        workspaceId: String(workspaceId),
        title: sr.story_id,
        status: sr.status,
      });
      nodesCreated++;

      // Story belongs to spec
      await addStoryToSpec(sr.story_id, specId, String(workspaceId));
      edgesCreated++;

      // Mine real file paths from the story output chunks written by story-log-follower.
      const filePaths = await collectStoryFileTouches(runId, sr.story_id);
      for (const filePath of filePaths) {
        await addFileTouch(sr.story_id, filePath, String(workspaceId), specId);
        edgesCreated++;
      }
    }

    logger.info(
      { runId, specId, nodesCreated, edgesCreated },
      '[knowledge-graph] Graph populated from run',
    );
  } catch (err) {
    logger.error({ err, runId, specId }, '[knowledge-graph] populateFromRun failed');
  }

  return { nodesCreated, edgesCreated };
}

/**
 * Populate spec-level graph relationships: BELONGS_TO and DEPENDS_ON
 * from a parsed spec JSON.
 */
export async function populateFromSpec(
  specId: string,
  workspaceId: string,
  stories: Array<{ id: string; title: string; dependsOn?: string[] }>,
): Promise<void> {
  if (!(await isGraphAvailable())) return;

  try {
    // Add spec node
    await addSpecNode({
      id: specId,
      title: specId,
      status: 'approved',
      workspace_id: String(workspaceId),
    });

    for (const story of stories) {
      // Add story node
      await addStoryNode({
        id: story.id,
        specId,
        workspaceId: String(workspaceId),
        title: story.title,
        status: 'pending',
      });

      // Story belongs to spec
      await addStoryToSpec(story.id, specId, String(workspaceId));

      // Story depends on other stories
      if (story.dependsOn) {
        for (const depId of story.dependsOn) {
          await addStoryDependency(story.id, depId, specId, String(workspaceId));
        }
      }
    }

    logger.info(
      { specId, storyCount: stories.length },
      '[knowledge-graph] Graph populated from spec',
    );
  } catch (err) {
    logger.error({ err, specId }, '[knowledge-graph] populateFromSpec failed');
  }
}

// ── Convention Population from Config ─────────────────────────────────────────

/**
 * SW-008: Populate Convention nodes and APPLIES_TO edges from .rorca/config.json.
 *
 * Reads routing.scopes and routing.globals from the workspace config, creates
 * Convention nodes, and links them to matched File nodes via APPLIES_TO edges.
 *
 * - Scope conventions: one Convention per injected context file, linked to files
 *   matching the scope's path glob via micromatch.
 * - Global conventions: one Convention per global file (always-injected).
 *
 * @param workspaceId - The workspace ID (for logging / future queries)
 * @param workspacePath - Absolute filesystem path to the workspace root
 */
export async function populateConventionsFromConfig(
  workspaceId: string,
  workspacePath: string,
): Promise<{ nodesCreated: number; edgesCreated: number }> {
  let nodesCreated = 0;
  let edgesCreated = 0;

  if (!(await isGraphAvailable())) return { nodesCreated, edgesCreated };

  try {
    const { loadRorcaConfig } = await import('./rorca-config');
    const micromatch = (await import('micromatch')).default;

    const config = loadRorcaConfig(workspacePath);
    const { scopes, global: globals } = config.routing;

    // Collect workspace files for micromatch (relative paths)
    const workspaceFiles = listFilesRecursive(workspacePath, workspacePath);

    // 1. Scope conventions: each inject[] entry becomes a Convention node
    for (const scope of scopes) {
      // Match workspace files against the scope path glob
      const matchedFiles = micromatch(workspaceFiles, scope.path);

      for (const injectFile of scope.inject) {
        await addConventionLink(injectFile, '', workspaceId, 'config.json', 'scope');
        nodesCreated++;

        // Link convention to each matched file
        for (const filePath of matchedFiles) {
          await addConventionLink(injectFile, filePath, workspaceId, 'config.json', 'scope');
          edgesCreated++;
        }
      }
    }

    // 2. Global conventions: always-injected files
    for (const globalFile of globals) {
      await addConventionLink(globalFile, '', workspaceId, 'config.json', 'global');
      nodesCreated++;
    }

    logger.info(
      { workspaceId, nodesCreated, edgesCreated, scopeCount: scopes.length, globalCount: globals.length },
      '[knowledge-graph] Conventions populated from config.json',
    );
  } catch (err) {
    logger.error({ err, workspaceId }, '[knowledge-graph] populateConventionsFromConfig failed');
  }

  return { nodesCreated, edgesCreated };
}

/**
 * Recursively list files in a directory, returning paths relative to the base.
 * Skips node_modules, .git, and other large directories.
 */
function listFilesRecursive(dir: string, base: string, maxDepth = 5, depth = 0): string[] {
  if (depth >= maxDepth) return [];

  const SKIP_DIRS = new Set([
    'node_modules', '.git', '.next', 'dist', 'build', '.cache',
    '__pycache__', '.tox', 'vendor', 'target', '.rorca',
  ]);

  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        results.push(...listFilesRecursive(
          path.join(dir, entry.name),
          base,
          maxDepth,
          depth + 1,
        ));
      } else if (entry.isFile()) {
        results.push(path.relative(base, path.join(dir, entry.name)));
      }
    }
  } catch {
    // Permission errors, broken symlinks — skip silently
  }
  return results;
}

// ── Graph Health Check ──────────────────────────────────────────────────────

export interface GraphStats {
  available: boolean;
  vertexCount: number;
  edgeCount: number;
  labels: string[];
}

/**
 * Check if the AGE graph is available and return basic stats.
 * PG-019: Returns available: false immediately if AGE extension is not installed.
 */
// ── Skill Effectiveness Queries ──────────────────────────────────────────────

export interface SkillEffectivenessRow {
  skill: string;
  passCount: number;
  totalCount: number;
}

/**
 * Query Skill-USED_IN->Story edges to compute per-skill pass rates.
 * Returns skills ordered by pass count descending.
 * PG-019: Returns empty array if AGE is unavailable.
 */
export async function querySkillEffectiveness(): Promise<SkillEffectivenessRow[]> {
  if (!(await isGraphAvailable())) return [];

  try {
    // Total uses per skill
    const totalRows = await cypherQuery<{ skill: unknown; cnt: unknown }>(
      `MATCH (sk:Skill)-[:USED_IN]->(st:Story)
       RETURN sk.name, count(st)`,
      [
        { name: 'skill', type: 'agtype' },
        { name: 'cnt', type: 'agtype' },
      ],
    );

    // Passed uses per skill
    const passRows = await cypherQuery<{ skill: unknown; cnt: unknown }>(
      `MATCH (sk:Skill)-[:USED_IN]->(st:Story)
       WHERE st.status = 'pass'
       RETURN sk.name, count(st)`,
      [
        { name: 'skill', type: 'agtype' },
        { name: 'cnt', type: 'agtype' },
      ],
    );

    const passMap = new Map<string, number>();
    for (const row of passRows) {
      const name = String(parseAgtype(row.skill) ?? '');
      const cnt = Number(parseAgtype(row.cnt) ?? 0);
      if (name) passMap.set(name, cnt);
    }

    const results: SkillEffectivenessRow[] = [];
    for (const row of totalRows) {
      const name = String(parseAgtype(row.skill) ?? '');
      const total = Number(parseAgtype(row.cnt) ?? 0);
      if (name && total > 0) {
        results.push({
          skill: name,
          passCount: passMap.get(name) ?? 0,
          totalCount: total,
        });
      }
    }

    results.sort((a, b) => b.passCount - a.passCount);
    logger.debug({ count: results.length }, '[knowledge-graph] querySkillEffectiveness complete');
    return results;
  } catch (err) {
    logger.warn({ err }, '[knowledge-graph] querySkillEffectiveness failed');
    return [];
  }
}

export interface SkillPathAffinityRow {
  skill: string;
  filePath: string;
  storyCount: number;
}

/**
 * Query which skills were active on stories that touched specific file patterns.
 * Returns skill-to-file-path associations ordered by frequency.
 * PG-019: Returns empty array if AGE is unavailable.
 */
export async function querySkillPathAffinity(limit: number = 50): Promise<SkillPathAffinityRow[]> {
  if (!(await isGraphAvailable())) return [];

  try {
    const rows = await cypherQuery<{ skill: unknown; fpath: unknown; cnt: unknown }>(
      `MATCH (sk:Skill)-[:USED_IN]->(st:Story)-[:TOUCHES]->(f:File)
       WHERE st.status = 'pass'
       RETURN sk.name, f.path, count(st)
       ORDER BY count(st) DESC
       LIMIT ${limit}`,
      [
        { name: 'skill', type: 'agtype' },
        { name: 'fpath', type: 'agtype' },
        { name: 'cnt', type: 'agtype' },
      ],
    );

    return rows.map(row => ({
      skill: String(parseAgtype(row.skill) ?? ''),
      filePath: String(parseAgtype(row.fpath) ?? ''),
      storyCount: Number(parseAgtype(row.cnt) ?? 0),
    })).filter(r => r.skill && r.filePath);
  } catch (err) {
    logger.warn({ err }, '[knowledge-graph] querySkillPathAffinity failed');
    return [];
  }
}

// ── Spec Knowledge Graph Query ──────────────────────────────────────────────

export interface KnowledgeGraphMemory {
  id: string;
  category: string;
  relationship: string;
  storyId: string;
}

export interface KnowledgeGraphConvention {
  name: string;
  source: string;
  relationship: string;
  filePath: string;
}

export interface KnowledgeGraphRelatedStory {
  id: string;
  specId: string;
  title: string;
  relationship: string;
}

export interface SpecKnowledgeGraphResult {
  memories: KnowledgeGraphMemory[];
  conventions: KnowledgeGraphConvention[];
  relatedStories: KnowledgeGraphRelatedStory[];
}

/**
 * Query the knowledge graph for data related to a spec's stories.
 * Returns memories linked via LEARNED_FROM, conventions linked via APPLIES_TO/TOUCHES,
 * and related stories from other specs connected via DEPENDS_ON or TOUCHES.
 * PG-019: Returns empty arrays if AGE is unavailable.
 */
export async function querySpecKnowledgeGraph(specId: string, workspaceId?: string): Promise<SpecKnowledgeGraphResult> {
  const empty: SpecKnowledgeGraphResult = { memories: [], conventions: [], relatedStories: [] };
  if (!(await isGraphAvailable())) return empty;

  const specLookup = buildScopedGraphNodeLookup('Spec', specId, { workspaceId });
  const safeSpecLookupValue = escCypher(specLookup.value);

  try {
    // 1. Memory nodes linked to this spec's stories via LEARNED_FROM
    const learnedRows = await cypherQuery<{ mid: unknown; cat: unknown; sid: unknown }>(
      `MATCH (m:Memory)-[:LEARNED_FROM]->(s:Story)-[:BELONGS_TO]->(sp:Spec {${specLookup.property}: '${safeSpecLookupValue}'})
       RETURN m.id, m.category, s.id`,
      [
        { name: 'mid', type: 'agtype' },
        { name: 'cat', type: 'agtype' },
        { name: 'sid', type: 'agtype' },
      ],
    );

    const sourceSpecRows = await cypherQuery<{ mid: unknown; cat: unknown }>(
      `MATCH (m:Memory)-[:FROM_SPEC]->(sp:Spec {${specLookup.property}: '${safeSpecLookupValue}'})
       RETURN m.id, m.category`,
      [
        { name: 'mid', type: 'agtype' },
        { name: 'cat', type: 'agtype' },
      ],
    );

    const memories: KnowledgeGraphMemory[] = [
      ...learnedRows.map(row => ({
        id: String(parseAgtype(row.mid) ?? ''),
        category: String(parseAgtype(row.cat) ?? ''),
        relationship: 'LEARNED_FROM',
        storyId: String(parseAgtype(row.sid) ?? ''),
      })),
      ...sourceSpecRows.map(row => ({
        id: String(parseAgtype(row.mid) ?? ''),
        category: String(parseAgtype(row.cat) ?? ''),
        relationship: 'FROM_SPEC',
        storyId: specId,
      })),
    ];

    // 2. Convention nodes that APPLIES_TO files touched by this spec's stories
    const conventionRows = await cypherQuery<{ cname: unknown; csrc: unknown; fpath: unknown }>(
      `MATCH (c:Convention)-[:APPLIES_TO]->(f:File)<-[:TOUCHES]-(s:Story)-[:BELONGS_TO]->(sp:Spec {${specLookup.property}: '${safeSpecLookupValue}'})
       RETURN DISTINCT c.name, c.source, f.path`,
      [
        { name: 'cname', type: 'agtype' },
        { name: 'csrc', type: 'agtype' },
        { name: 'fpath', type: 'agtype' },
      ],
    );

    const conventions: KnowledgeGraphConvention[] = conventionRows.map(row => ({
      name: String(parseAgtype(row.cname) ?? ''),
      source: String(parseAgtype(row.csrc) ?? ''),
      relationship: 'APPLIES_TO',
      filePath: String(parseAgtype(row.fpath) ?? ''),
    }));

    // 3. Related stories from OTHER specs connected via DEPENDS_ON or TOUCHES
    const relatedRows = await cypherQuery<{ rid: unknown; rspec: unknown; rtitle: unknown; rel: unknown }>(
      `MATCH (s:Story)-[:BELONGS_TO]->(sp:Spec {${specLookup.property}: '${safeSpecLookupValue}'})
       MATCH (s)-[:TOUCHES]->(f:File)<-[:TOUCHES]-(r:Story)-[:BELONGS_TO]->(rsp:Spec)
       WHERE rsp.${specLookup.property} <> '${safeSpecLookupValue}'
       RETURN DISTINCT r.id, rsp.id, r.title, 'TOUCHES'`,
      [
        { name: 'rid', type: 'agtype' },
        { name: 'rspec', type: 'agtype' },
        { name: 'rtitle', type: 'agtype' },
        { name: 'rel', type: 'agtype' },
      ],
    );

    const relatedStories: KnowledgeGraphRelatedStory[] = relatedRows.map(row => ({
      id: String(parseAgtype(row.rid) ?? ''),
      specId: String(parseAgtype(row.rspec) ?? ''),
      title: String(parseAgtype(row.rtitle) ?? ''),
      relationship: String(parseAgtype(row.rel) ?? 'TOUCHES'),
    }));

    logger.debug(
      {
        specId,
        workspaceId: workspaceId ?? null,
        memories: memories.length,
        conventions: conventions.length,
        relatedStories: relatedStories.length,
      },
      '[knowledge-graph] querySpecKnowledgeGraph complete',
    );

    return { memories, conventions, relatedStories };
  } catch (err) {
    logger.warn({ err, specId, workspaceId: workspaceId ?? null }, '[knowledge-graph] querySpecKnowledgeGraph failed');
    return empty;
  }
}

export async function graphStats(): Promise<GraphStats> {
  if (!(await isGraphAvailable())) {
    return { available: false, vertexCount: 0, edgeCount: 0, labels: [] };
  }

  try {
    // Check if the graph exists
    const graphExists = await cypherQuery<{ cnt: unknown }>(
      'MATCH (n) RETURN count(n)',
      [{ name: 'cnt', type: 'agtype' }],
    );

    const vertexCount = Number(parseAgtype(graphExists[0]?.cnt) ?? 0);

    const edgeCounts = await cypherQuery<{ cnt: unknown }>(
      'MATCH ()-[r]->() RETURN count(r)',
      [{ name: 'cnt', type: 'agtype' }],
    );

    const edgeCount = Number(parseAgtype(edgeCounts[0]?.cnt) ?? 0);

    // Get labels from catalog
    const labelRows = await query<{ name: string }>(
      `SELECT name FROM ag_catalog.ag_label
       WHERE graph = (SELECT graphid FROM ag_catalog.ag_graph WHERE name = 'rorca')
         AND name NOT IN ('_ag_label_vertex', '_ag_label_edge')
       ORDER BY name`,
    );

    return {
      available: true,
      vertexCount,
      edgeCount,
      labels: labelRows.map(r => r.name),
    };
  } catch (err) {
    logger.warn({ err }, '[knowledge-graph] Graph not available');
    return {
      available: false,
      vertexCount: 0,
      edgeCount: 0,
      labels: [],
    };
  }
}
