/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * hilo-neighborhood.ts — Hilo graph neighborhood expansion — Context Intelligence
 * Platform US-015.
 *
 * Expands seed files through Hilo graph relations to discover related files.
 * Supports configurable depth, file count limits, relation filtering, and
 * degradation when Hilo is stale or unavailable.
 *
 * Acceptance criteria (US-015):
 *   • Expansion includes relation type, depth, source seed, and path provenance.
 *   • Max depth / max files are configurable and enforced.
 *   • Stale/unavailable Hilo returns partial context with degradation flags.
 *   • Tests cover one-hop, multi-hop, tests, max-depth, stale fallback.
 *
 * Design constraints (docs/context-intelligence-platform.md §2.1 / §4):
 *   • Graph-only. This module operates on in-memory {@link GraphEdge} and
 *     {@link GraphFileNode} shapes — it installs no FUSE, xattr, inotify, or
 *     remote backend.
 *   • Rebuildable. The graph is rebuildable codegraph data (never a system of
 *     record), so expansion is stateless and deterministic given the same
 *     normalized graph input.
 */

import { logger } from './logger';

// ════════════════════════════════════════════════════════════════════════════
// Inline shared contract shapes (mirror shared/contracts/graph.ts)
// ════════════════════════════════════════════════════════════════════════════

/**
 * The role a file plays, used for ranking signals.
 * Mirrors `FileRole` from shared/contracts/graph.ts.
 */
export type FileRole =
  | 'source'
  | 'test'
  | 'config'
  | 'doc'
  | 'entrypoint'
  | 'fixture'
  | 'generated'
  | 'unknown';

/**
 * Typed relations between file nodes.
 * Mirrors `GraphRelation` from shared/contracts/graph.ts.
 */
export type GraphRelation =
  | 'imports'
  | 'imported_by'
  | 'tests'
  | 'tested_by'
  | 'sibling'
  | 'contains'
  | 'references';

/** A single file node in the normalized codegraph. */
export interface GraphFileNode {
  schemaVersion: string;
  path: string;
  role: FileRole;
  language?: string;
  importsCount: number;
  importedByCount: number;
  testsCount: number;
  testedByCount: number;
  relationCounts?: Record<string, number>;
  contentHash?: string;
}

/** A typed edge between two file nodes. */
export interface GraphEdge {
  schemaVersion: string;
  from: string;
  to: string;
  relation: GraphRelation;
  weight?: number;
}

// ════════════════════════════════════════════════════════════════════════════
// Expansion types
// ════════════════════════════════════════════════════════════════════════════

/**
 * A single expanded file in the neighborhood result.
 * Carries full provenance: which seed originated it, through what relation
 * chain, and at what depth (hop count from seed).
 */
export interface ExpandedFile {
  /** Repo-relative file path (normalized through the shared contract). */
  path: string;
  /** The seed file that led to this expansion (root of the BFS tree). */
  sourceSeed: string;
  /** The graph relation that connected this file to its parent in the expansion. */
  relation: GraphRelation;
  /** Depth from the seed file (0 = seed itself, 1 = direct neighbor, etc.). */
  depth: number;
  /** Ordered chain of file paths from seed to this file (inclusive of both ends). */
  pathProvenance: string[];
  /** The file's role (from node data), or 'unknown' if no node entry exists. */
  role: FileRole;
  /** The file's language, if known. */
  language?: string;
}

/**
 * Degradation flags set when Hilo is stale, unavailable, or limits are hit.
 * Consumers use these to surface warnings in UIs or adjust retrieval behavior.
 */
export interface NeighborhoodDegradation {
  /** True when the Hilo graph is stale (hydration SHA != current HEAD). */
  hiloStale: boolean;
  /** True when the Hilo graph is unavailable (no hydration, Hilo disabled, no graph data). */
  hiloUnavailable: boolean;
  /** True when maxDepth was reached and expansion was truncated. */
  depthLimitReached: boolean;
  /** True when maxFiles was reached and expansion was truncated. */
  fileLimitReached: boolean;
  /** Human-readable summary of degradation reasons. */
  summary: string;
}

/**
 * Options for {@link expandNeighborhood}.
 */
export interface NeighborhoodExpansionOptions {
  /**
   * Seed file paths (repo-relative) to expand from.
   * Empty/non-string values are filtered out.
   */
  seeds: string[];
  /**
   * Maximum expansion depth (BFS hop count from seeds).
   * Must be >= 1. Default: 2.
   */
  maxDepth?: number;
  /**
   * Maximum number of total expanded files (including seeds).
   * Must be >= 1. Default: 50.
   */
  maxFiles?: number;
  /**
   * Optional filter: only follow these relation types.
   * When omitted or empty, all relation types are followed.
   */
  relationFilter?: GraphRelation[];
  /**
   * Whether to treat stale Hilo as a degradation (does not block expansion).
   * Default: false (stale Hilo still produces expansion results).
   */
  strictStaleness?: boolean;
}

/**
 * Result of {@link expandNeighborhood}.
 */
export interface NeighborhoodExpansionResult {
  /** Expanded files with full provenance, ordered by depth then path. */
  files: ExpandedFile[];
  /** Degradation flags and summary. */
  degradation: NeighborhoodDegradation;
  /** Total number of unique nodes visited during expansion (including seeds). */
  totalVisited: number;
  /** Number of seeds that were expanded from (after filtering invalid seeds). */
  seedCount: number;
}

// ════════════════════════════════════════════════════════════════════════════
// Defaults & limits
// ════════════════════════════════════════════════════════════════════════════

export const DEFAULT_MAX_DEPTH = 2;
export const DEFAULT_MAX_FILES = 50;
export const MAX_DEPTH_HARD_LIMIT = 10;
export const MAX_FILES_HARD_LIMIT = 500;

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

/**
 * Build adjacency maps from the normalized edge set for efficient BFS traversal.
 *
 * Returns:
 *  - `outgoing`: from → { to → relation[] }  (forward edges)
 *  - `incoming`: to → { from → relation[] }  (reverse edges for imported_by/tests)
 */
function buildAdjacency(edges: GraphEdge[]) {
  const outgoing = new Map<string, Map<string, GraphRelation[]>>();
  const incoming = new Map<string, Map<string, GraphRelation[]>>();

  for (const edge of edges) {
    // Forward: from → to
    let fwd = outgoing.get(edge.from);
    if (!fwd) {
      fwd = new Map();
      outgoing.set(edge.from, fwd);
    }
    const fwdRels = fwd.get(edge.to) ?? [];
    fwdRels.push(edge.relation);
    fwd.set(edge.to, fwdRels);

    // Reverse: to → from (for cheap reverse traversal)
    let rev = incoming.get(edge.to);
    if (!rev) {
      rev = new Map();
      incoming.set(edge.to, rev);
    }
    const revRels = rev.get(edge.from) ?? [];
    revRels.push(edge.relation);
    rev.set(edge.from, revRels);
  }

  return { outgoing, incoming };
}

/**
 * Build a lookup map from file path to GraphFileNode for role/language info.
 */
function buildNodeMap(nodes: GraphFileNode[]): Map<string, GraphFileNode> {
  const map = new Map<string, GraphFileNode>();
  for (const node of nodes) {
    map.set(node.path, node);
  }
  return map;
}

/**
 * Get all neighbor paths and their relations from a given file path,
 * considering both outgoing and incoming edges.
 */
function getNeighbors(
  path: string,
  outgoing: Map<string, Map<string, GraphRelation[]>>,
  incoming: Map<string, Map<string, GraphRelation[]>>,
  relationFilter: Set<GraphRelation> | null,
): Array<{ neighbor: string; relation: GraphRelation }> {
  const results: Array<{ neighbor: string; relation: GraphRelation }> = [];

  // Outgoing edges (e.g., imports, tests, references)
  const outMap = outgoing.get(path);
  if (outMap) {
    for (const [target, relations] of outMap) {
      for (const rel of relations) {
        if (!relationFilter || relationFilter.has(rel)) {
          results.push({ neighbor: target, relation: rel });
        }
      }
    }
  }

  // Incoming edges — normalize to the "from this file" perspective
  // If file A imports file B, then B has an incoming "imports" edge from A.
  // From B's perspective, A is a "reverse importer" (imported_by).
  const inMap = incoming.get(path);
  if (inMap) {
    for (const [source, relations] of inMap) {
      for (const rel of relations) {
        // Map the reverse relation for provenance clarity
        const reverseRel = reverseRelation(rel);
        if (!relationFilter || relationFilter.has(reverseRel)) {
          results.push({ neighbor: source, relation: reverseRel });
        }
      }
    }
  }

  return results;
}

/**
 * Map an edge relation to its semantic reverse.
 *  - imports    → imported_by (the file with this edge is *imported by* the source)
 *  - tests      → tested_by
 *  - sibling    → sibling (symmetric)
 *  - contains   → contained_by (approximate reverse)
 *  - references → referenced_by (approximate reverse)
 */
function reverseRelation(rel: GraphRelation): GraphRelation {
  switch (rel) {
    case 'imports':
      return 'imported_by';
    case 'tests':
      return 'tested_by';
    case 'tested_by':
      return 'tests';
    case 'imported_by':
      return 'imports';
    case 'contains':
      // No canonical reverse in the contract; use 'references' as approximate.
      return 'references';
    case 'references':
      // Approximate reverse.
      return 'references';
    case 'sibling':
      return 'sibling';
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Core expansion
// ════════════════════════════════════════════════════════════════════════════

/**
 * Options for the low-level expansion function.
 */
export interface ExpandNeighborhoodInput {
  /** Normalized file nodes. */
  nodes: GraphFileNode[];
  /** Normalized edges between file nodes. */
  edges: GraphEdge[];
  /** Expansion options (seeds, limits, filters). */
  options: NeighborhoodExpansionOptions;
  /** Pre-computed staleness flags from the caller. */
  staleness?: {
    hiloStale: boolean;
    hiloUnavailable: boolean;
  };
}

/**
 * Expand seed files through the Hilo graph to discover their neighborhoods.
 *
 * Uses breadth-first traversal across all enabled relation types to find files
 * related to the seed set. Each expanded file carries full provenance
 * (source seed, relation, depth, path chain).
 *
 * When Hilo is stale or unavailable, expansion still proceeds on the available
 * data (partial context), and the result carries degradation flags for consumers
 * to surface warnings or adjust downstream behavior.
 *
 * @param input - Normalized graph data and expansion options.
 * @returns A {@link NeighborhoodExpansionResult} with expanded files and degradation flags.
 */
export function expandNeighborhood(
  input: ExpandNeighborhoodInput,
): NeighborhoodExpansionResult {
  const { nodes, edges, options, staleness } = input;

  // ── Clamp limits ──────────────────────────────────────────────────────
  const maxDepth = Math.max(
    1,
    Math.min(options.maxDepth ?? DEFAULT_MAX_DEPTH, MAX_DEPTH_HARD_LIMIT),
  );
  const maxFiles = Math.max(
    1,
    Math.min(options.maxFiles ?? DEFAULT_MAX_FILES, MAX_FILES_HARD_LIMIT),
  );

  const relationFilter = options.relationFilter && options.relationFilter.length > 0
    ? new Set(options.relationFilter)
    : null;

  // ── Filter and normalize seeds ─────────────────────────────────────────
  const seeds = [...new Set(
    options.seeds
      .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      .map((s) => s.trim()),
  )];

  // ── Build data structures ──────────────────────────────────────────────
  const { outgoing, incoming } = buildAdjacency(edges);
  const nodeMap = buildNodeMap(nodes);

  // ── Degradation initialisation ─────────────────────────────────────────
  const hiloStale = staleness?.hiloStale ?? false;
  const hiloUnavailable = staleness?.hiloUnavailable ?? false;

  // If the graph is entirely empty (no nodes, no edges), treat as unavailable.
  const graphEmpty = nodes.length === 0 && edges.length === 0;
  const effectiveUnavailable = hiloUnavailable || graphEmpty;

  const degradation: NeighborhoodDegradation = {
    hiloStale,
    hiloUnavailable: effectiveUnavailable,
    depthLimitReached: false,
    fileLimitReached: false,
    summary: '',
  };

  // ── Handle unavailable / empty graph ───────────────────────────────────
  if (effectiveUnavailable) {
    // Return seeds with depth 0, plus degradation flags
    const seedFiles: ExpandedFile[] = seeds.map((seed) => {
      const node = nodeMap.get(seed);
      return {
        path: seed,
        sourceSeed: seed,
        relation: 'references', // placeholder — no edges to derive a real relation
        depth: 0,
        pathProvenance: [seed],
        role: node?.role ?? 'unknown',
        language: node?.language,
      };
    });

    const summaryParts: string[] = [];
    if (degradation.hiloStale) summaryParts.push('Hilo graph is stale');
    summaryParts.push('Hilo graph is unavailable — returning seeds only.');
    degradation.summary = summaryParts.join('; ');
    logger.debug({ seeds: seeds.length, nodes, edges },
      '[hilo-neighborhood] Graph unavailable — returning seeds only');

    return {
      files: seedFiles.slice(0, maxFiles),
      degradation,
      totalVisited: seedFiles.length,
      seedCount: seeds.length,
    };
  }

  // ── BFS expansion ──────────────────────────────────────────────────────
  // Each queue entry carries the current path, source seed, depth, and path chain.
  interface BfsEntry {
    path: string;
    sourceSeed: string;
    depth: number;
    pathProvenance: string[];
  }

  const visited = new Set<string>();
  const expanded: ExpandedFile[] = [];

  // Seed the queue with the seed files.
  const queue: BfsEntry[] = [];
  for (const seed of seeds) {
    if (visited.has(seed)) continue;
    visited.add(seed);
    const entry: BfsEntry = {
      path: seed,
      sourceSeed: seed,
      depth: 0,
      pathProvenance: [seed],
    };
    queue.push(entry);

    // Add seed to results immediately.
    const node = nodeMap.get(seed);
    expanded.push({
      path: seed,
      sourceSeed: seed,
      relation: 'references', // seeds have no incoming relation — placeholder
      depth: 0,
      pathProvenance: [seed],
      role: node?.role ?? 'unknown',
      language: node?.language,
    });
  }

  // BFS loop
  while (queue.length > 0) {
    const current = queue.shift()!;

    // Stop expanding if we hit depth limit.
    if (current.depth >= maxDepth) {
      degradation.depthLimitReached = true;
      continue;
    }

    // Get neighbors
    const neighbors = getNeighbors(current.path, outgoing, incoming, relationFilter);

    for (const { neighbor, relation } of neighbors) {
      if (visited.has(neighbor)) continue;

      // Check file limit before adding to visited set.
      if (visited.size >= maxFiles) {
        degradation.fileLimitReached = true;
        // Break out of the neighbor loop; the queue drain will finish naturally
        // without adding more items.
        break;
      }

      visited.add(neighbor);

      const nextDepth = current.depth + 1;
      const pathProvenance = [...current.pathProvenance, neighbor];

      const node = nodeMap.get(neighbor);
      expanded.push({
        path: neighbor,
        sourceSeed: current.sourceSeed,
        relation,
        depth: nextDepth,
        pathProvenance,
        role: node?.role ?? 'unknown',
        language: node?.language,
      });

      // Only enqueue if we haven't hit depth limit yet.
      if (nextDepth < maxDepth) {
        queue.push({
          path: neighbor,
          sourceSeed: current.sourceSeed,
          depth: nextDepth,
          pathProvenance,
        });
      }
    }

    // If file limit was hit during neighbor expansion, clear the queue.
    if (degradation.fileLimitReached) {
      queue.length = 0;
      break;
    }
  }

  // ── Sort results: depth first, then path ───────────────────────────────
  expanded.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.path.localeCompare(b.path);
  });

  // ── Re-compute degradation after sort ──────────────────────────────────
  // depthLimitReached if any file is at maxDepth (could have gone deeper)
  if (!degradation.depthLimitReached) {
    degradation.depthLimitReached = expanded.some((f) => f.depth >= maxDepth);
  }

  // ── Build summary ──────────────────────────────────────────────────────
  const parts: string[] = [];
  if (degradation.hiloStale) {
    parts.push('Hilo graph is stale (re-hydration recommended)');
  }
  if (degradation.hiloUnavailable) {
    parts.push('Hilo graph is unavailable');
  }
  if (degradation.depthLimitReached) {
    parts.push(`depth limit (${maxDepth}) reached — deeper relations not explored`);
  }
  if (degradation.fileLimitReached) {
    parts.push(`file limit (${maxFiles}) reached — some relations not explored`);
  }
  degradation.summary = parts.length > 0
    ? parts.join('; ')
    : 'Expansion complete — no degradation.';

  logger.debug(
    {
      seeds: seeds.length,
      totalVisited: visited.size,
      expanded: expanded.length,
      maxDepth,
      maxFiles,
      depthLimitReached: degradation.depthLimitReached,
      fileLimitReached: degradation.fileLimitReached,
      hiloStale: degradation.hiloStale,
    },
    '[hilo-neighborhood] Expansion complete',
  );

  return {
    files: expanded,
    degradation,
    totalVisited: visited.size,
    seedCount: seeds.length,
  };
}
