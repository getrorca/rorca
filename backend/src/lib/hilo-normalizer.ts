/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * hilo-normalizer.ts — Hilo graph output normalization — Context Intelligence
 * Platform US-008.
 *
 * Reads Hilo's raw edge JSONL output and normalizes it into Rorca's shared
 * {@link GraphEdge} and {@link GraphFileNode} shapes. Every input line passes
 * through the shared contract validators — a malformed line is skipped (logged
 * at debug level) rather than crashing the pipeline.
 *
 * Acceptance criteria (US-008):
 *   • Parser reads Hilo edge JSONL and maps relations to shared GraphEdge/
 *     GraphFileNode shapes.
 *   • Missing optional classification data produces partial hydration, not
 *     total failure.
 *   • All paths pass through shared normalization and ignores.
 *   • Fixture tests cover TypeScript, Go/Python-style imports, and test
 *     relationships.
 *
 * Design constraints (docs/context-intelligence-platform.md §2.1 / §4):
 *   • Graph-only. This module reads files from the output directory written by
 *     the Hilo binary (see {@link ./hilo-hydration-runner}). No FUSE, xattr,
 *     inotify, or remote backend.
 *   • Rebuildable. The graph output is rebuildable codegraph data (never a
 *     system of record — design doc §3), so this module carries a schema
 *     version but no durable identity beyond path + SHA.
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';

import { type HydrationCounts } from '../db/workspace-hydration';
import { logger } from './logger';

// ════════════════════════════════════════════════════════════════════════════
// Inline shared contract shapes (mirror shared/contracts/graph.ts)
// ════════════════════════════════════════════════════════════════════════════

const GRAPH_METADATA_VERSION = 'v1' as const;

const repoRelativePath = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => !p.startsWith('/'), { message: 'path must be repo-relative, not absolute' })
  .refine((p) => !p.split(/[\\/]/).includes('..'), { message: 'path must not contain ".." segments' });

const fileRole = z.enum([
  'source',
  'test',
  'config',
  'doc',
  'entrypoint',
  'fixture',
  'generated',
  'unknown',
] as const);

export type FileRole = z.infer<typeof fileRole>;

const graphRelation = z.enum([
  'imports',
  'imported_by',
  'tests',
  'tested_by',
  'sibling',
  'contains',
  'references',
] as const);

export type GraphRelation = z.infer<typeof graphRelation>;

const nonNegativeInt = z.number().int().min(0);

const graphFileNode = z.object({
  schemaVersion: z.literal(GRAPH_METADATA_VERSION),
  path: repoRelativePath,
  role: fileRole,
  language: z.string().min(1).max(64).optional(),
  importsCount: nonNegativeInt.default(0),
  importedByCount: nonNegativeInt.default(0),
  testsCount: nonNegativeInt.default(0),
  testedByCount: nonNegativeInt.default(0),
  relationCounts: z.record(z.string(), nonNegativeInt).optional(),
  contentHash: z.string().min(1).max(128).optional(),
});

export type GraphFileNode = z.infer<typeof graphFileNode>;

const graphEdge = z.object({
  schemaVersion: z.literal(GRAPH_METADATA_VERSION),
  from: repoRelativePath,
  to: repoRelativePath,
  relation: graphRelation,
  weight: nonNegativeInt.optional(),
});

export type GraphEdge = z.infer<typeof graphEdge>;

// ════════════════════════════════════════════════════════════════════════════
// Raw Hilo output shapes (what the Hilo binary writes to the output directory)
// ════════════════════════════════════════════════════════════════════════════

/** A raw edge line from Hilo's JSONL output. */
interface RawHiloEdge {
  type: 'edge';
  from: string;
  to: string;
  relation: string;
  weight?: number;
}

/** A raw node/classification line from Hilo's JSONL output. */
interface RawHiloNode {
  type: 'node';
  path: string;
  role?: string;
  language?: string;
  contentHash?: string;
}

/** Union of all Hilo JSONL entry types. */
type RawHiloEntry = RawHiloEdge | RawHiloNode;

// ════════════════════════════════════════════════════════════════════════════
// Hilo relation → shared contract relation mapping
// ════════════════════════════════════════════════════════════════════════════

/**
 * Hilo's raw relation strings are normalised to the shared
 * {@link GraphRelation} set. Unknown relations are passed through as-is
 * (the shared {@link graphEdge} schema will reject them, and the line is
 * skipped with a debug log rather than crashing the pipeline).
 */
const HILO_TO_RORCA_RELATION: Record<string, string> = {
  imports: 'imports',
  imported_by: 'imported_by',
  tests: 'tests',
  tested_by: 'tested_by',
  sibling: 'sibling',
  contains: 'contains',
  references: 'references',
};

/** Normalise a raw Hilo relation string to a shared GraphRelation, or return null if unmappable. */
function normalizeRelation(raw: string): string | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;
  return HILO_TO_RORCA_RELATION[trimmed] ?? trimmed; // pass unknown through for schema rejection
}

// ════════════════════════════════════════════════════════════════════════════
// Hilo role → shared contract role mapping
// ════════════════════════════════════════════════════════════════════════════

/** Map a raw Hilo role string to the shared {@link FileRole} set. Defaults to 'unknown'. */
function normalizeRole(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim().toLowerCase();
  if (!trimmed) return 'unknown';
  switch (trimmed) {
    case 'source':
    case 'test':
    case 'config':
    case 'doc':
    case 'entrypoint':
    case 'fixture':
    case 'generated':
      return trimmed;
    default:
      return 'unknown';
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Public API
// ════════════════════════════════════════════════════════════════════════════

/** Result of normalizing Hilo graph output. */
export interface HiloNormalizedGraph {
  /** Normalized file nodes. */
  nodes: GraphFileNode[];
  /** Normalized edges between file nodes. */
  edges: GraphEdge[];
  /** Aggregate hydration counts for provenance/staleness tracking. */
  counts: HydrationCounts;
  /** Number of raw input lines that could not be normalized (malformed JSON, bad schema, etc.). */
  ignoredLines: number;
}

/** Options for {@link normalizeHiloOutput}. */
export interface NormalizeHiloOutputOptions {
  /** Hilo output directory containing the edge JSONL files. */
  outputDir: string;
  /** Git SHA of the workspace checkout (for stamped metadata). */
  gitSha?: string | null;
  /** Workspace id. */
  workspaceId?: string;
}

/**
 * Read the raw lines from Hilo's output directory. By convention Hilo writes a
 * single `edges.jsonl` file in its output directory. Lines are split and
 * trimmed; empty lines are skipped. Returns an array of non-empty trimmed strings.
 */
export function readHiloLines(outputDir: string): string[] {
  const edgesPath = path.join(outputDir, 'edges.jsonl');
  if (!fs.existsSync(edgesPath)) {
    logger.debug({ edgesPath }, '[HiloNormalizer] No edges.jsonl found');
    return [];
  }
  const raw = fs.readFileSync(edgesPath, 'utf-8');
  // A 64 MB guard — the graph output should never be that large, but if it is,
  // trimming after the limit is safer than crashing OOM.
  const bounded = raw.length > 64 * 1024 * 1024 ? raw.slice(0, 64 * 1024 * 1024) : raw;
  return bounded
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

/**
 * Parse a single raw line into a possibly-valid `RawHiloEntry`. Returns null
 * for unparseable JSON or entries without a recognised `type` field.
 */
export function parseHiloLine(line: string): RawHiloEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    logger.debug({ line: line.slice(0, 200) }, '[HiloNormalizer] Skipping unparseable JSON line');
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    logger.debug({ line: line.slice(0, 200) }, '[HiloNormalizer] Skipping non-object line');
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const type = obj.type;
  if (typeof type !== 'string') {
    logger.debug({ line: line.slice(0, 200) }, '[HiloNormalizer] Skipping line without string type');
    return null;
  }
  if (type === 'edge') {
    if (typeof obj.from !== 'string' || typeof obj.to !== 'string' || typeof obj.relation !== 'string') {
      logger.debug(
        { line: line.slice(0, 200) },
        '[HiloNormalizer] Skipping edge without from/to/relation strings',
      );
      return null;
    }
    return {
      type: 'edge',
      from: obj.from,
      to: obj.to,
      relation: obj.relation,
      weight: typeof obj.weight === 'number' ? obj.weight : undefined,
    };
  }
  if (type === 'node') {
    if (typeof obj.path !== 'string') {
      logger.debug(
        { line: line.slice(0, 200) },
        '[HiloNormalizer] Skipping node without string path',
      );
      return null;
    }
    return {
      type: 'node',
      path: obj.path,
      role: typeof obj.role === 'string' ? obj.role : undefined,
      language: typeof obj.language === 'string' ? obj.language : undefined,
      contentHash: typeof obj.contentHash === 'string' ? obj.contentHash : undefined,
    };
  }
  logger.debug({ type, line: line.slice(0, 200) }, '[HiloNormalizer] Skipping unknown entry type');
  return null;
}

/**
 * Normalize a raw Hilo edge into a shared {@link GraphEdge}, or return null if
 * the edge fails shared-contract validation.
 *
 * Missing optional fields (weight) produce a valid edge with the field omitted.
 */
export function normalizeEdge(raw: RawHiloEdge): GraphEdge | null {
  const relation = normalizeRelation(raw.relation);
  if (!relation) {
    logger.debug({ rawRelation: raw.relation }, '[HiloNormalizer] Skipping edge with unmappable relation');
    return null;
  }
  // Reject edges with invalid weight values (negative, NaN, Infinity)
  if (raw.weight !== undefined) {
    if (typeof raw.weight !== 'number' || !Number.isFinite(raw.weight) || raw.weight < 0) {
      logger.debug(
        { from: raw.from, to: raw.to, relation, weight: raw.weight },
        '[HiloNormalizer] Skipping edge with invalid weight',
      );
      return null;
    }
  }

  const candidate: Record<string, unknown> = {
    schemaVersion: 'v1',
    from: raw.from,
    to: raw.to,
    relation,
  };
  if (typeof raw.weight === 'number') {
    candidate.weight = raw.weight;
  }
  const parsed = graphEdge.safeParse(candidate);
  if (!parsed.success) {
    logger.debug(
      { from: raw.from, to: raw.to, relation, issues: parsed.error.issues },
      '[HiloNormalizer] Skipping edge that failed shared contract validation',
    );
    return null;
  }
  return parsed.data;
}

/**
 * Normalize a raw Hilo node into a shared {@link GraphFileNode}, or return null
 * if the node fails shared-contract validation.
 *
 * Missing optional classification data (role, language, contentHash) produces
 * a valid node with defaults/omitted fields — partial hydration, not failure.
 */
export function normalizeNode(raw: RawHiloNode): GraphFileNode | null {
  const role = normalizeRole(raw.role);
  const candidate: Record<string, unknown> = {
    schemaVersion: 'v1',
    path: raw.path,
    role,
    importsCount: 0,
    importedByCount: 0,
    testsCount: 0,
    testedByCount: 0,
  };
  if (raw.language) {
    candidate.language = raw.language;
  }
  if (raw.contentHash) {
    candidate.contentHash = raw.contentHash;
  }
  const parsed = graphFileNode.safeParse(candidate);
  if (!parsed.success) {
    logger.debug(
      { path: raw.path, issues: parsed.error.issues },
      '[HiloNormalizer] Skipping node that failed shared contract validation',
    );
    return null;
  }
  return parsed.data;
}

/**
 * Build aggregated relation counts for a node from its inbound/outbound edges.
 * This fills in `importsCount`, `importedByCount`, `testsCount`, `testedByCount`,
 * and populates `relationCounts` with any additional edge relations.
 */
export interface NodeCountFields {
  importsCount: number;
  importedByCount: number;
  testsCount: number;
  testedByCount: number;
  relationCounts?: Record<string, number>;
}

export function computeNodeCounts(
  nodePath: string,
  outgoing: Map<string, string[]>,
  incoming: Map<string, string[]>,
): NodeCountFields {
  // Outgoing edges from this node
  const out = outgoing.get(nodePath) ?? [];
  // Incoming edges to this node
  const inc = incoming.get(nodePath) ?? [];

  const importsCount = out.filter((r) => r === 'imports').length;
  const testsCount = out.filter((r) => r === 'tests').length;
  const importedByCount = inc.filter((r) => r === 'imports').length;
  const testedByCount = inc.filter((r) => r === 'tests').length;

  // Collect other relation counts
  const allRelations = [...out, ...inc];
  const relationCounts: Record<string, number> = {};
  for (const rel of allRelations) {
    if (rel === 'imports' || rel === 'tests') continue;
    relationCounts[rel] = (relationCounts[rel] ?? 0) + 1;
  }

  const result: NodeCountFields = {
    importsCount,
    importedByCount,
    testsCount,
    testedByCount,
  };
  if (Object.keys(relationCounts).length > 0) {
    result.relationCounts = relationCounts;
  }
  return result;
}

/**
 * Build aggregate hydration counts from the normalised graph.
 */
export function computeHydrationCounts(
  nodes: GraphFileNode[],
  edges: GraphEdge[],
): HydrationCounts {
  const imports = edges.filter((e) => e.relation === 'imports').length;
  const reverseImporters = edges.filter((e) => e.relation === 'imported_by').length;
  const tests = edges.filter((e) => e.relation === 'tests').length;
  const testedBy = edges.filter((e) => e.relation === 'tested_by').length;
  const roles = new Set(nodes.map((n) => n.role)).size;

  return {
    files: nodes.length,
    nodes: nodes.length,
    edges: edges.length,
    imports,
    reverseImporters,
    tests,
    testedBy,
    roles,
  };
}

/**
 * Normalize Hilo graph output into shared {@link GraphEdge} and
 * {@link GraphFileNode} shapes.
 *
 * This is the canonical entry point for US-008. It:
 *   1. Reads the edge JSONL file from the output directory.
 *   2. Parses every line and normalizes edges and nodes through the shared
 *      contract validators.
 *   3. Computes reverse-relation counts (importedByCount, testedByCount) from
 *      the edge set so each node carries its full relation fingerprint.
 *   4. Produces aggregate hydration counts for provenance.
 *   5. Never throws on malformed input — skipped lines are counted in
 *      `ignoredLines` and logged at debug level.
 *
 * Missing optional classification data (role, language, contentHash, weight)
 * produces partial hydration — nodes/edges are still normalised with defaults
 * or omitted fields rather than causing a total failure.
 *
 * @param options - The output directory, optional git SHA, and workspace id.
 * @returns A {@link HiloNormalizedGraph} with normalized nodes, edges, counts,
 *          and the number of ignored lines.
 */
export function normalizeHiloOutput(
  options: NormalizeHiloOutputOptions,
): HiloNormalizedGraph {
  const { outputDir } = options;

  const lines = readHiloLines(outputDir);
  const entries: RawHiloEntry[] = [];
  let ignoredLines = 0;

  for (const line of lines) {
    const entry = parseHiloLine(line);
    if (entry) {
      entries.push(entry);
    } else {
      ignoredLines++;
    }
  }

  // ── Normalize edges first, then nodes, so we can compute counts ─────────
  const rawEdges = entries.filter((e): e is RawHiloEdge => e.type === 'edge');
  const rawNodes = entries.filter((e): e is RawHiloNode => e.type === 'node');

  // Track outgoing/incoming relations for count computation.
  const outgoing = new Map<string, string[]>(); // from → relation[]
  const incoming = new Map<string, string[]>(); // to → relation[]
  const normalizedEdges: GraphEdge[] = [];

  for (const raw of rawEdges) {
    const edge = normalizeEdge(raw);
    if (edge) {
      normalizedEdges.push(edge);
      // Track outgoing
      const out = outgoing.get(edge.from) ?? [];
      out.push(edge.relation);
      outgoing.set(edge.from, out);
      // Track incoming
      const inc = incoming.get(edge.to) ?? [];
      inc.push(edge.relation);
      incoming.set(edge.to, inc);
    } else {
      ignoredLines++;
    }
  }

  // Build a node-set from both explicit node entries and implicit nodes
  // discovered from edge endpoints.
  const nodeMap = new Map<string, GraphFileNode>();

  // First pass: add nodes from explicit node entries
  for (const raw of rawNodes) {
    const node = normalizeNode(raw);
    if (node) {
      nodeMap.set(node.path, node);
    } else {
      ignoredLines++;
    }
  }

  // Second pass: add synthetic nodes for edge endpoints that have no explicit
  // node entry. These get role='unknown', language unset, and zero counts.
  // This is the "partial hydration" path — missing classification data is not
  // a failure.
  for (const edge of normalizedEdges) {
    if (!nodeMap.has(edge.from)) {
      const synthetic = graphFileNode.safeParse({
        schemaVersion: 'v1',
        path: edge.from,
        role: 'unknown',
        importsCount: 0,
        importedByCount: 0,
        testsCount: 0,
        testedByCount: 0,
      });
      if (synthetic.success) {
        nodeMap.set(edge.from, synthetic.data);
      }
    }
    if (!nodeMap.has(edge.to)) {
      const synthetic = graphFileNode.safeParse({
        schemaVersion: 'v1',
        path: edge.to,
        role: 'unknown',
        importsCount: 0,
        importedByCount: 0,
        testsCount: 0,
        testedByCount: 0,
      });
      if (synthetic.success) {
        nodeMap.set(edge.to, synthetic.data);
      }
    }
  }

  // ── Compute relation counts per node ────────────────────────────────────
  const nodesWithCounts: GraphFileNode[] = [];
  for (const [nodePath, node] of nodeMap) {
    const counts = computeNodeCounts(nodePath, outgoing, incoming);
    nodesWithCounts.push({ ...node, ...counts });
  }

  const counts = computeHydrationCounts(nodesWithCounts, normalizedEdges);

  logger.info(
    {
      nodes: nodesWithCounts.length,
      edges: normalizedEdges.length,
      ignoredLines,
      imports: counts.imports,
      tests: counts.tests,
    },
    '[HiloNormalizer] Normalization complete',
  );

  return {
    nodes: nodesWithCounts,
    edges: normalizedEdges,
    counts,
    ignoredLines,
  };
}
