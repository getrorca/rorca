/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { PoolClient } from 'pg';
import { pool } from '../db/index';
import { checkAge } from './age-guard';
import {
  buildFileNodeKey,
  buildMemoryNodeKey,
  buildSpecNodeKey,
  buildStoryNodeKey,
  normalizeGraphFilePath,
  parseAgtype,
} from './knowledge-graph';
import { logger } from './logger';

export type MemoryGraphNodeType = 'Memory' | 'Story' | 'Spec' | 'File';
export type MemoryGraphEdgeType = 'ABOUT' | 'LEARNED_FROM' | 'FROM_SPEC' | 'TOUCHES' | 'BELONGS_TO' | 'DEPENDS_ON' | 'SUPERSEDES' | 'CONFLICTS_WITH';
export type MemoryGraphView = 'overview' | 'neighborhood';
export type MemoryGraphUnavailableCode = 'AGE_NOT_AVAILABLE' | 'GRAPH_QUERY_FAILED';

export interface MemoryGraphCaps {
  memories: number;
  stories: number;
  files: number;
  specs: number;
  edges: number;
  dependencies: number;
}

export interface MemoryGraphNode {
  id: string;
  type: MemoryGraphNodeType;
  entityId: string;
  label: string;
  workspaceId: string;
  selected: boolean;
  category?: string;
  pinned?: boolean;
  createdAt?: string | null;
  storyId?: string;
  specId?: string;
  title?: string;
  status?: string;
  path?: string;
}

export interface MemoryGraphEdge {
  id: string;
  type: MemoryGraphEdgeType;
  source: string;
  target: string;
}

export interface MemoryGraphSummary {
  nodeCount: number;
  edgeCount: number;
  countsByType: Record<MemoryGraphNodeType, number>;
  countsByEdgeType: Record<MemoryGraphEdgeType, number>;
  caps: MemoryGraphCaps;
  truncated: {
    nodes: boolean;
    edges: boolean;
  };
}

export interface MemoryGraphSelectionHints {
  selectedMemoryId: string | null;
  suggestedMemoryIds: string[];
  relatedStoryIds: string[];
  relatedSpecIds: string[];
  relatedFilePaths: string[];
}

export interface MemoryGraphScope {
  workspaceId: string;
  view: MemoryGraphView;
  memoryId: string | null;
}

export interface MemoryGraphResponse {
  available: boolean;
  scope: MemoryGraphScope;
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  summary: MemoryGraphSummary;
  selection: MemoryGraphSelectionHints;
  error?: string;
  code?: MemoryGraphUnavailableCode;
  mode?: 'lite';
  hint?: string;
}

interface CypherColumn {
  name: string;
  type: 'agtype';
}

interface MemoryAnchorRow {
  memoryId: string;
  category: string | null;
  pinned: boolean | null;
  createdAt: string | null;
}

interface MemoryStoryRow {
  memoryId: string;
  storyId: string;
  storyTitle: string | null;
  specId: string | null;
}

interface MemoryFileRow {
  memoryId: string;
  filePath: string;
}

interface MemorySpecRow {
  memoryId: string;
  specId: string;
  specTitle: string | null;
  specStatus: string | null;
}

interface StoryDependencyRow {
  storyId: string;
  storySpecId: string | null;
  dependsOnId: string;
  dependsOnTitle: string | null;
  dependsOnSpecId: string | null;
}

interface StoryFileRow {
  storyId: string;
  specId: string | null;
  filePath: string;
}

interface StorySpecRow {
  storyId: string;
  specId: string;
  specTitle: string | null;
  specStatus: string | null;
}

interface MemoryRelationRow {
  sourceMemoryId: string;
  sourceCategory: string | null;
  sourcePinned: boolean | null;
  sourceCreatedAt: string | null;
  targetMemoryId: string;
  targetCategory: string | null;
  targetPinned: boolean | null;
  targetCreatedAt: string | null;
  relationType: 'SUPERSEDES' | 'CONFLICTS_WITH';
}

const EDGE_TYPE_ORDER: MemoryGraphEdgeType[] = [
  'ABOUT',
  'LEARNED_FROM',
  'FROM_SPEC',
  'TOUCHES',
  'BELONGS_TO',
  'DEPENDS_ON',
  'SUPERSEDES',
  'CONFLICTS_WITH',
];
const NODE_TYPE_ORDER: MemoryGraphNodeType[] = ['Memory', 'Story', 'Spec', 'File'];

const DEFAULT_OVERVIEW_CAPS: MemoryGraphCaps = {
  memories: 12,
  stories: 18,
  files: 24,
  specs: 8,
  edges: 72,
  dependencies: 8,
};

const DEFAULT_NEIGHBORHOOD_CAPS: MemoryGraphCaps = {
  memories: 1,
  stories: 10,
  files: 12,
  specs: 6,
  edges: 40,
  dependencies: 10,
};

function emptyTypeCounts(): Record<MemoryGraphNodeType, number> {
  return { Memory: 0, Story: 0, Spec: 0, File: 0 };
}

function emptyEdgeCounts(): Record<MemoryGraphEdgeType, number> {
  return {
    ABOUT: 0,
    LEARNED_FROM: 0,
    FROM_SPEC: 0,
    TOUCHES: 0,
    BELONGS_TO: 0,
    DEPENDS_ON: 0,
    SUPERSEDES: 0,
    CONFLICTS_WITH: 0,
  };
}

function escapeCypher(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function workspacePredicate(alias: string, workspaceId: string): string {
  const safeWorkspaceId = escapeCypher(workspaceId);
  return `(${alias}.workspaceId = '${safeWorkspaceId}' OR ${alias}.workspace_id = '${safeWorkspaceId}')`;
}

function stringList(values: string[]): string {
  return `[${values.map((value) => `'${escapeCypher(value)}'`).join(', ')}]`;
}

function parseAgtypeRow<T>(row: Record<string, unknown>): T {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, parseAgtype(value)]),
  ) as T;
}

function sortStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

function sortNodes(nodes: MemoryGraphNode[]): MemoryGraphNode[] {
  return [...nodes].sort((left, right) => {
    const typeOrder = NODE_TYPE_ORDER.indexOf(left.type) - NODE_TYPE_ORDER.indexOf(right.type);
    if (typeOrder !== 0) return typeOrder;
    const labelOrder = left.label.localeCompare(right.label, undefined, { numeric: true });
    return labelOrder !== 0 ? labelOrder : left.id.localeCompare(right.id, undefined, { numeric: true });
  });
}

function sortEdges(edges: MemoryGraphEdge[]): MemoryGraphEdge[] {
  return [...edges].sort((left, right) => {
    const typeOrder = EDGE_TYPE_ORDER.indexOf(left.type) - EDGE_TYPE_ORDER.indexOf(right.type);
    if (typeOrder !== 0) return typeOrder;
    const sourceOrder = left.source.localeCompare(right.source, undefined, { numeric: true });
    return sourceOrder !== 0 ? sourceOrder : left.target.localeCompare(right.target, undefined, { numeric: true });
  });
}

function resolveCaps(view: MemoryGraphView, overrides: Partial<MemoryGraphCaps> = {}): MemoryGraphCaps {
  const base = view === 'overview' ? DEFAULT_OVERVIEW_CAPS : DEFAULT_NEIGHBORHOOD_CAPS;
  return {
    memories: Math.max(1, Math.min(overrides.memories ?? base.memories, base.memories)),
    stories: Math.max(1, Math.min(overrides.stories ?? base.stories, base.stories)),
    files: Math.max(1, Math.min(overrides.files ?? base.files, base.files)),
    specs: Math.max(1, Math.min(overrides.specs ?? base.specs, base.specs)),
    edges: Math.max(1, Math.min(overrides.edges ?? base.edges, base.edges)),
    dependencies: Math.max(0, Math.min(overrides.dependencies ?? base.dependencies, base.dependencies)),
  };
}

function buildScope(workspaceId: string, view: MemoryGraphView, memoryId: string | null): MemoryGraphScope {
  return { workspaceId, view, memoryId };
}

function buildUnavailable(
  scope: MemoryGraphScope,
  caps: MemoryGraphCaps,
  code: MemoryGraphUnavailableCode,
  error: string,
): MemoryGraphResponse {
  return {
    available: false,
    scope,
    nodes: [],
    edges: [],
    summary: {
      nodeCount: 0,
      edgeCount: 0,
      countsByType: emptyTypeCounts(),
      countsByEdgeType: emptyEdgeCounts(),
      caps,
      truncated: { nodes: false, edges: false },
    },
    selection: {
      selectedMemoryId: scope.memoryId,
      suggestedMemoryIds: [],
      relatedStoryIds: [],
      relatedSpecIds: [],
      relatedFilePaths: [],
    },
    error,
    code,
    mode: 'lite',
    hint: 'Run `rorca db start` to enable graph memory (requires Docker)',
  };
}

function buildSuccess(
  scope: MemoryGraphScope,
  caps: MemoryGraphCaps,
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
): MemoryGraphResponse {
  const sortedNodes = sortNodes(nodes);
  const sortedEdges = sortEdges(edges);
  const countsByType = emptyTypeCounts();
  const countsByEdgeType = emptyEdgeCounts();

  for (const node of sortedNodes) countsByType[node.type] += 1;
  for (const edge of sortedEdges) countsByEdgeType[edge.type] += 1;

  return {
    available: true,
    scope,
    nodes: sortedNodes,
    edges: sortedEdges,
    summary: {
      nodeCount: sortedNodes.length,
      edgeCount: sortedEdges.length,
      countsByType,
      countsByEdgeType,
      caps,
      truncated: {
        nodes:
          countsByType.Memory >= caps.memories
          || countsByType.Story >= caps.stories
          || countsByType.File >= caps.files
          || countsByType.Spec >= caps.specs,
        edges: sortedEdges.length >= caps.edges,
      },
    },
    selection: {
      selectedMemoryId: scope.memoryId,
      suggestedMemoryIds: sortStrings(sortedNodes.filter((node) => node.type === 'Memory').map((node) => node.entityId)),
      relatedStoryIds: sortStrings(sortedNodes.filter((node) => node.type === 'Story').map((node) => node.entityId)),
      relatedSpecIds: sortStrings(sortedNodes.filter((node) => node.type === 'Spec').map((node) => node.entityId)),
      relatedFilePaths: sortStrings(sortedNodes.filter((node) => node.type === 'File').map((node) => node.entityId)),
    },
  };
}

async function withAgeSession<T>(client: PoolClient, run: () => Promise<T>): Promise<T> {
  const current = await client.query<{ search_path: string }>("SELECT current_setting('search_path') AS search_path");
  const originalSearchPath = current.rows[0]?.search_path ?? 'rorca, public';

  try {
    await client.query("LOAD 'age'");
    await client.query('SET search_path = ag_catalog, "$user", public');
    return await run();
  } finally {
    await client.query("SELECT set_config('search_path', $1, false)", [originalSearchPath]);
  }
}

async function cypherQuery<T = Record<string, unknown>>(
  cypher: string,
  returnColumns: CypherColumn[],
): Promise<T[]> {
  const client = await pool.connect();
  const columnDef = returnColumns.map((column) => `${column.name} ${column.type}`).join(', ');
  const sql = `SELECT * FROM cypher('rorca', $$ ${cypher} $$) AS (${columnDef})`;

  try {
    return await withAgeSession(client, async () => {
      const result = await client.query(sql);
      return result.rows.map((row) => parseAgtypeRow<T>(row));
    });
  } finally {
    client.release();
  }
}

function allocateEdgeBudgets(view: MemoryGraphView, edgeLimit: number): Record<MemoryGraphEdgeType, number> {
  const weights: Record<MemoryGraphEdgeType, number> = view === 'overview'
    ? { ABOUT: 4, LEARNED_FROM: 4, FROM_SPEC: 2, TOUCHES: 4, BELONGS_TO: 2, DEPENDS_ON: 2, SUPERSEDES: 3, CONFLICTS_WITH: 3 }
    : { ABOUT: 3, LEARNED_FROM: 3, FROM_SPEC: 2, TOUCHES: 3, BELONGS_TO: 2, DEPENDS_ON: 3, SUPERSEDES: 3, CONFLICTS_WITH: 3 };
  const totalWeight = EDGE_TYPE_ORDER.reduce((sum, type) => sum + weights[type], 0);
  const budgets = EDGE_TYPE_ORDER.reduce((acc, type) => ({ ...acc, [type]: 0 }), {} as Record<MemoryGraphEdgeType, number>);

  let allocated = 0;
  for (const type of EDGE_TYPE_ORDER) {
    const budget = Math.floor((edgeLimit * weights[type]) / totalWeight);
    budgets[type] = budget;
    allocated += budget;
  }

  let remainder = edgeLimit - allocated;
  let index = 0;
  while (remainder > 0) {
    budgets[EDGE_TYPE_ORDER[index % EDGE_TYPE_ORDER.length]] += 1;
    remainder -= 1;
    index += 1;
  }

  return budgets;
}

function createAccumulator(caps: MemoryGraphCaps) {
  const nodes = new Map<string, MemoryGraphNode>();
  const edges = new Map<string, MemoryGraphEdge>();
  const countsByType = emptyTypeCounts();
  const nodeCaps: Record<MemoryGraphNodeType, number> = {
    Memory: caps.memories,
    Story: caps.stories,
    Spec: caps.specs,
    File: caps.files,
  };

  function addNode(node: MemoryGraphNode): boolean {
    const existing = nodes.get(node.id);
    if (existing) {
      nodes.set(node.id, { ...existing, ...node, selected: existing.selected || node.selected });
      return true;
    }
    if (countsByType[node.type] >= nodeCaps[node.type]) {
      return false;
    }
    nodes.set(node.id, node);
    countsByType[node.type] += 1;
    return true;
  }

  function addEdge(type: MemoryGraphEdgeType, source: string, target: string): void {
    if (!nodes.has(source) || !nodes.has(target) || edges.size >= caps.edges) {
      return;
    }
    const id = `${type}:${source}->${target}`;
    if (!edges.has(id)) {
      edges.set(id, { id, type, source, target });
    }
  }

  return {
    addNode,
    addEdge,
    nodes,
    edges,
  };
}

async function queryAnchorMemories(workspaceId: string, limit: number): Promise<MemoryAnchorRow[]> {
  return cypherQuery<MemoryAnchorRow>(
    `MATCH (m:Memory)
     WHERE ${workspacePredicate('m', workspaceId)}
     RETURN m.id AS memoryId,
            m.category AS category,
            COALESCE(m.pinned, false) AS pinned,
            COALESCE(m.updated_at, m.created_at) AS createdAt
     ORDER BY createdAt DESC, memoryId ASC
     LIMIT ${limit}`,
    [
      { name: 'memoryId', type: 'agtype' },
      { name: 'category', type: 'agtype' },
      { name: 'pinned', type: 'agtype' },
      { name: 'createdAt', type: 'agtype' },
    ],
  );
}

async function querySingleMemory(workspaceId: string, memoryId: string): Promise<MemoryAnchorRow[]> {
  return cypherQuery<MemoryAnchorRow>(
    `MATCH (m:Memory)
     WHERE ${workspacePredicate('m', workspaceId)}
       AND m.id = '${escapeCypher(memoryId)}'
     RETURN m.id AS memoryId,
            m.category AS category,
            COALESCE(m.pinned, false) AS pinned,
            COALESCE(m.updated_at, m.created_at) AS createdAt
     ORDER BY memoryId ASC
     LIMIT 1`,
    [
      { name: 'memoryId', type: 'agtype' },
      { name: 'category', type: 'agtype' },
      { name: 'pinned', type: 'agtype' },
      { name: 'createdAt', type: 'agtype' },
    ],
  );
}

async function queryMemoryStories(workspaceId: string, memoryIds: string[], limit: number): Promise<MemoryStoryRow[]> {
  if (memoryIds.length === 0 || limit <= 0) return [];
  return cypherQuery<MemoryStoryRow>(
    `MATCH (m:Memory)-[:LEARNED_FROM]->(s:Story)
     WHERE ${workspacePredicate('m', workspaceId)}
       AND ${workspacePredicate('s', workspaceId)}
       AND m.id IN ${stringList(memoryIds)}
     RETURN DISTINCT m.id AS memoryId,
                     s.id AS storyId,
                     s.title AS storyTitle,
                     s.specId AS specId
     ORDER BY memoryId ASC, storyId ASC
     LIMIT ${limit}`,
    [
      { name: 'memoryId', type: 'agtype' },
      { name: 'storyId', type: 'agtype' },
      { name: 'storyTitle', type: 'agtype' },
      { name: 'specId', type: 'agtype' },
    ],
  );
}

async function queryMemoryFiles(workspaceId: string, memoryIds: string[], limit: number): Promise<MemoryFileRow[]> {
  if (memoryIds.length === 0 || limit <= 0) return [];
  return cypherQuery<MemoryFileRow>(
    `MATCH (m:Memory)-[:ABOUT]->(f:File)
     WHERE ${workspacePredicate('m', workspaceId)}
       AND ${workspacePredicate('f', workspaceId)}
       AND m.id IN ${stringList(memoryIds)}
     RETURN DISTINCT m.id AS memoryId,
                     f.path AS filePath
     ORDER BY memoryId ASC, filePath ASC
     LIMIT ${limit}`,
    [
      { name: 'memoryId', type: 'agtype' },
      { name: 'filePath', type: 'agtype' },
    ],
  );
}

async function queryMemorySpecs(workspaceId: string, memoryIds: string[], limit: number): Promise<MemorySpecRow[]> {
  if (memoryIds.length === 0 || limit <= 0) return [];
  return cypherQuery<MemorySpecRow>(
    `MATCH (m:Memory)-[:FROM_SPEC]->(sp:Spec)
     WHERE ${workspacePredicate('m', workspaceId)}
       AND ${workspacePredicate('sp', workspaceId)}
       AND m.id IN ${stringList(memoryIds)}
     RETURN DISTINCT m.id AS memoryId,
                     sp.id AS specId,
                     sp.title AS specTitle,
                     sp.status AS specStatus
     ORDER BY memoryId ASC, specId ASC
     LIMIT ${limit}`,
    [
      { name: 'memoryId', type: 'agtype' },
      { name: 'specId', type: 'agtype' },
      { name: 'specTitle', type: 'agtype' },
      { name: 'specStatus', type: 'agtype' },
    ],
  );
}

async function queryStoryDependencies(workspaceId: string, storyIds: string[], limit: number): Promise<StoryDependencyRow[]> {
  if (storyIds.length === 0 || limit <= 0) return [];
  return cypherQuery<StoryDependencyRow>(
    `MATCH (s:Story)-[:DEPENDS_ON]->(d:Story)
     WHERE ${workspacePredicate('s', workspaceId)}
       AND ${workspacePredicate('d', workspaceId)}
       AND s.id IN ${stringList(storyIds)}
     RETURN DISTINCT s.id AS storyId,
                     s.specId AS storySpecId,
                     d.id AS dependsOnId,
                     d.title AS dependsOnTitle,
                     d.specId AS dependsOnSpecId
     ORDER BY storyId ASC, dependsOnId ASC
     LIMIT ${limit}`,
    [
      { name: 'storyId', type: 'agtype' },
      { name: 'storySpecId', type: 'agtype' },
      { name: 'dependsOnId', type: 'agtype' },
      { name: 'dependsOnTitle', type: 'agtype' },
      { name: 'dependsOnSpecId', type: 'agtype' },
    ],
  );
}

async function queryStoryFiles(workspaceId: string, storyIds: string[], limit: number): Promise<StoryFileRow[]> {
  if (storyIds.length === 0 || limit <= 0) return [];
  return cypherQuery<StoryFileRow>(
    `MATCH (s:Story)-[:TOUCHES]->(f:File)
     WHERE ${workspacePredicate('s', workspaceId)}
       AND ${workspacePredicate('f', workspaceId)}
       AND s.id IN ${stringList(storyIds)}
     RETURN DISTINCT s.id AS storyId,
                     s.specId AS specId,
                     f.path AS filePath
     ORDER BY storyId ASC, filePath ASC
     LIMIT ${limit}`,
    [
      { name: 'storyId', type: 'agtype' },
      { name: 'specId', type: 'agtype' },
      { name: 'filePath', type: 'agtype' },
    ],
  );
}

async function queryStorySpecs(workspaceId: string, storyIds: string[], limit: number): Promise<StorySpecRow[]> {
  if (storyIds.length === 0 || limit <= 0) return [];
  return cypherQuery<StorySpecRow>(
    `MATCH (s:Story)-[:BELONGS_TO]->(sp:Spec)
     WHERE ${workspacePredicate('s', workspaceId)}
       AND ${workspacePredicate('sp', workspaceId)}
       AND s.id IN ${stringList(storyIds)}
     RETURN DISTINCT s.id AS storyId,
                     sp.id AS specId,
                     sp.title AS specTitle,
                     sp.status AS specStatus
     ORDER BY storyId ASC, specId ASC
     LIMIT ${limit}`,
    [
      { name: 'storyId', type: 'agtype' },
      { name: 'specId', type: 'agtype' },
      { name: 'specTitle', type: 'agtype' },
      { name: 'specStatus', type: 'agtype' },
    ],
  );
}

async function queryMemoryRelations(
  workspaceId: string,
  memoryIds: string[],
  relationType: 'SUPERSEDES' | 'CONFLICTS_WITH',
  limit: number,
): Promise<MemoryRelationRow[]> {
  if (memoryIds.length === 0 || limit <= 0) return [];
  return cypherQuery<MemoryRelationRow>(
    `MATCH (source:Memory)-[r:${relationType}]->(target:Memory)
     WHERE ${workspacePredicate('source', workspaceId)}
       AND ${workspacePredicate('target', workspaceId)}
       AND COALESCE(r.active, true) = true
       AND (source.id IN ${stringList(memoryIds)} OR target.id IN ${stringList(memoryIds)})
     RETURN DISTINCT source.id AS sourceMemoryId,
                     source.category AS sourceCategory,
                     COALESCE(source.pinned, false) AS sourcePinned,
                     COALESCE(source.updated_at, source.created_at) AS sourceCreatedAt,
                     target.id AS targetMemoryId,
                     target.category AS targetCategory,
                     COALESCE(target.pinned, false) AS targetPinned,
                     COALESCE(target.updated_at, target.created_at) AS targetCreatedAt,
                     '${relationType}' AS relationType
     ORDER BY sourceMemoryId ASC, targetMemoryId ASC
     LIMIT ${limit}`,
    [
      { name: 'sourceMemoryId', type: 'agtype' },
      { name: 'sourceCategory', type: 'agtype' },
      { name: 'sourcePinned', type: 'agtype' },
      { name: 'sourceCreatedAt', type: 'agtype' },
      { name: 'targetMemoryId', type: 'agtype' },
      { name: 'targetCategory', type: 'agtype' },
      { name: 'targetPinned', type: 'agtype' },
      { name: 'targetCreatedAt', type: 'agtype' },
      { name: 'relationType', type: 'agtype' },
    ],
  );
}

function addMemoryNodes(
  workspaceId: string,
  graph: ReturnType<typeof createAccumulator>,
  rows: MemoryAnchorRow[],
  selectedMemoryId: string | null,
): void {
  for (const row of rows) {
    graph.addNode({
      id: buildMemoryNodeKey(workspaceId, row.memoryId),
      type: 'Memory',
      entityId: row.memoryId,
      label: row.memoryId,
      workspaceId,
      selected: selectedMemoryId ? row.memoryId === selectedMemoryId : true,
      category: row.category ?? undefined,
      pinned: row.pinned ?? false,
      createdAt: row.createdAt ?? null,
    });
  }
}

function addRelatedMemoryNodes(
  workspaceId: string,
  graph: ReturnType<typeof createAccumulator>,
  rows: MemoryRelationRow[],
  selectedMemoryId: string | null,
): void {
  for (const row of rows) {
    for (const memory of [
      {
        memoryId: row.sourceMemoryId,
        category: row.sourceCategory,
        pinned: row.sourcePinned,
        createdAt: row.sourceCreatedAt,
      },
      {
        memoryId: row.targetMemoryId,
        category: row.targetCategory,
        pinned: row.targetPinned,
        createdAt: row.targetCreatedAt,
      },
    ]) {
      graph.addNode({
        id: buildMemoryNodeKey(workspaceId, memory.memoryId),
        type: 'Memory',
        entityId: memory.memoryId,
        label: memory.memoryId,
        workspaceId,
        selected: selectedMemoryId ? memory.memoryId === selectedMemoryId : true,
        category: memory.category ?? undefined,
        pinned: memory.pinned ?? false,
        createdAt: memory.createdAt ?? null,
      });
    }
  }
}

function addStoryNodes(
  workspaceId: string,
  graph: ReturnType<typeof createAccumulator>,
  rows: Array<MemoryStoryRow | StoryDependencyRow>,
  selector: (row: MemoryStoryRow | StoryDependencyRow) => { storyId: string; title?: string | null; specId?: string | null },
): void {
  for (const row of rows) {
    const data = selector(row);
    if (!data.specId) continue;
    graph.addNode({
      id: buildStoryNodeKey(workspaceId, data.specId, data.storyId),
      type: 'Story',
      entityId: data.storyId,
      label: data.title || data.storyId,
      workspaceId,
      selected: false,
      storyId: data.storyId,
      specId: data.specId,
      title: data.title ?? data.storyId,
    });
  }
}

function addSpecNodes(
  workspaceId: string,
  graph: ReturnType<typeof createAccumulator>,
  rows: Array<MemorySpecRow | StorySpecRow>,
  selector: (row: MemorySpecRow | StorySpecRow) => { specId: string; title?: string | null; status?: string | null },
): void {
  for (const row of rows) {
    const data = selector(row);
    graph.addNode({
      id: buildSpecNodeKey(workspaceId, data.specId),
      type: 'Spec',
      entityId: data.specId,
      label: data.title || data.specId,
      workspaceId,
      selected: false,
      specId: data.specId,
      title: data.title ?? data.specId,
      status: data.status ?? undefined,
    });
  }
}

function addFileNodes(
  workspaceId: string,
  graph: ReturnType<typeof createAccumulator>,
  rows: Array<MemoryFileRow | StoryFileRow>,
  selector: (row: MemoryFileRow | StoryFileRow) => string,
): void {
  for (const row of rows) {
    const filePath = normalizeGraphFilePath(selector(row));
    if (!filePath) continue;
    graph.addNode({
      id: buildFileNodeKey(workspaceId, filePath),
      type: 'File',
      entityId: filePath,
      label: filePath,
      workspaceId,
      selected: false,
      path: filePath,
    });
  }
}

function addMemoryRelationEdges(
  workspaceId: string,
  graph: ReturnType<typeof createAccumulator>,
  rows: MemoryRelationRow[],
): void {
  for (const row of rows) {
    graph.addEdge(
      row.relationType,
      buildMemoryNodeKey(workspaceId, row.sourceMemoryId),
      buildMemoryNodeKey(workspaceId, row.targetMemoryId),
    );
  }
}

function addDirectEdges(
  workspaceId: string,
  graph: ReturnType<typeof createAccumulator>,
  memoryStories: MemoryStoryRow[],
  memoryFiles: MemoryFileRow[],
  memorySpecs: MemorySpecRow[],
): void {
  for (const row of memoryStories) {
    if (!row.specId) continue;
    graph.addEdge(
      'LEARNED_FROM',
      buildMemoryNodeKey(workspaceId, row.memoryId),
      buildStoryNodeKey(workspaceId, row.specId, row.storyId),
    );
  }

  for (const row of memoryFiles) {
    const filePath = normalizeGraphFilePath(row.filePath);
    if (!filePath) continue;
    graph.addEdge(
      'ABOUT',
      buildMemoryNodeKey(workspaceId, row.memoryId),
      buildFileNodeKey(workspaceId, filePath),
    );
  }

  for (const row of memorySpecs) {
    graph.addEdge(
      'FROM_SPEC',
      buildMemoryNodeKey(workspaceId, row.memoryId),
      buildSpecNodeKey(workspaceId, row.specId),
    );
  }
}

function addStoryEdges(
  workspaceId: string,
  graph: ReturnType<typeof createAccumulator>,
  storyFiles: StoryFileRow[],
  storySpecs: StorySpecRow[],
  dependencies: StoryDependencyRow[],
): void {
  for (const row of storyFiles) {
    if (!row.specId) continue;
    const filePath = normalizeGraphFilePath(row.filePath);
    if (!filePath) continue;
    graph.addEdge(
      'TOUCHES',
      buildStoryNodeKey(workspaceId, row.specId, row.storyId),
      buildFileNodeKey(workspaceId, filePath),
    );
  }

  for (const row of storySpecs) {
    graph.addEdge(
      'BELONGS_TO',
      buildStoryNodeKey(workspaceId, row.specId, row.storyId),
      buildSpecNodeKey(workspaceId, row.specId),
    );
  }

  for (const row of dependencies) {
    if (!row.storySpecId || !row.dependsOnSpecId) continue;
    graph.addEdge(
      'DEPENDS_ON',
      buildStoryNodeKey(workspaceId, row.storySpecId, row.storyId),
      buildStoryNodeKey(workspaceId, row.dependsOnSpecId, row.dependsOnId),
    );
  }
}

function storyIds(graph: ReturnType<typeof createAccumulator>): string[] {
  return sortStrings(
    [...graph.nodes.values()]
      .filter((node) => node.type === 'Story' && node.storyId)
      .map((node) => node.storyId as string),
  );
}

async function buildGraph(
  workspaceId: string,
  scope: MemoryGraphScope,
  caps: MemoryGraphCaps,
  anchorRows: MemoryAnchorRow[],
): Promise<MemoryGraphResponse> {
  const graph = createAccumulator(caps);
  const edgeBudgets = allocateEdgeBudgets(scope.view, caps.edges);

  addMemoryNodes(workspaceId, graph, anchorRows, scope.memoryId);
  const memoryIds = anchorRows.map((row) => row.memoryId);

  const memoryStories = await queryMemoryStories(workspaceId, memoryIds, edgeBudgets.LEARNED_FROM);
  const memoryFiles = await queryMemoryFiles(workspaceId, memoryIds, edgeBudgets.ABOUT);
  const memorySpecs = await queryMemorySpecs(workspaceId, memoryIds, edgeBudgets.FROM_SPEC);
  const supersedes = await queryMemoryRelations(workspaceId, memoryIds, 'SUPERSEDES', edgeBudgets.SUPERSEDES);
  const conflicts = await queryMemoryRelations(workspaceId, memoryIds, 'CONFLICTS_WITH', edgeBudgets.CONFLICTS_WITH);

  addRelatedMemoryNodes(workspaceId, graph, [...supersedes, ...conflicts], scope.memoryId);

  addStoryNodes(workspaceId, graph, memoryStories, (row) => ({
    storyId: (row as MemoryStoryRow).storyId,
    title: (row as MemoryStoryRow).storyTitle,
    specId: (row as MemoryStoryRow).specId,
  }));
  addFileNodes(workspaceId, graph, memoryFiles, (row) => (row as MemoryFileRow).filePath);
  addSpecNodes(workspaceId, graph, memorySpecs, (row) => ({
    specId: (row as MemorySpecRow).specId,
    title: (row as MemorySpecRow).specTitle,
    status: (row as MemorySpecRow).specStatus,
  }));

  const initialStoryIds = storyIds(graph);
  const dependencyLimit = Math.min(edgeBudgets.DEPENDS_ON, caps.dependencies);
  const dependencies = await queryStoryDependencies(workspaceId, initialStoryIds, dependencyLimit);
  addStoryNodes(workspaceId, graph, dependencies, (row) => ({
    storyId: (row as StoryDependencyRow).dependsOnId,
    title: (row as StoryDependencyRow).dependsOnTitle,
    specId: (row as StoryDependencyRow).dependsOnSpecId,
  }));

  const finalStoryIds = storyIds(graph);
  const storyFiles = await queryStoryFiles(workspaceId, finalStoryIds, edgeBudgets.TOUCHES);
  const storySpecs = await queryStorySpecs(workspaceId, finalStoryIds, edgeBudgets.BELONGS_TO);

  addFileNodes(workspaceId, graph, storyFiles, (row) => (row as StoryFileRow).filePath);
  addSpecNodes(workspaceId, graph, storySpecs, (row) => ({
    specId: (row as StorySpecRow).specId,
    title: (row as StorySpecRow).specTitle,
    status: (row as StorySpecRow).specStatus,
  }));

  addDirectEdges(workspaceId, graph, memoryStories, memoryFiles, memorySpecs);
  addMemoryRelationEdges(workspaceId, graph, supersedes);
  addMemoryRelationEdges(workspaceId, graph, conflicts);
  addStoryEdges(workspaceId, graph, storyFiles, storySpecs, dependencies);

  return buildSuccess(scope, caps, [...graph.nodes.values()], [...graph.edges.values()]);
}

async function queryGraph(
  workspaceId: string,
  view: MemoryGraphView,
  memoryId: string | null,
  overrides: Partial<MemoryGraphCaps> = {},
): Promise<MemoryGraphResponse> {
  const scope = buildScope(workspaceId, view, memoryId);
  const caps = resolveCaps(view, overrides);

  if (!(await checkAge())) {
    return buildUnavailable(scope, caps, 'AGE_NOT_AVAILABLE', 'Apache AGE extension not available');
  }

  try {
    const anchors = memoryId
      ? await querySingleMemory(workspaceId, memoryId)
      : await queryAnchorMemories(workspaceId, caps.memories);
    return await buildGraph(workspaceId, scope, caps, anchors);
  } catch (error) {
    logger.warn({ error, workspaceId, view, memoryId }, '[memory-graph] Graph query failed');
    return buildUnavailable(scope, caps, 'GRAPH_QUERY_FAILED', 'Memory graph unavailable');
  }
}

export async function getMemoryGraphOverview(
  workspaceId: string,
  overrides: Partial<MemoryGraphCaps> = {},
): Promise<MemoryGraphResponse> {
  return queryGraph(workspaceId, 'overview', null, overrides);
}

export async function getMemoryGraphNeighborhood(
  workspaceId: string,
  memoryId: string,
  overrides: Partial<MemoryGraphCaps> = {},
): Promise<MemoryGraphResponse> {
  return queryGraph(workspaceId, 'neighborhood', memoryId, overrides);
}
