// ─── Context Intelligence Platform — Graph Metadata Contracts ─────────────────
//
// The normalized shape of Hilo's codegraph output (US-008): file nodes with
// roles and relation counts, and typed edges between files. This is rebuildable
// codegraph data (never a system of record — see design doc §3), so these
// contracts carry a schema version but no durable identity beyond path + SHA.

import { z } from 'zod';
import { CONTRACT_VERSIONS, schemaVersionField } from './version';
import { gitSha, isoTimestamp, nonNegativeInt, repoRelativePath, workspaceId } from './primitives';

/** The role a file plays, used as a ranker signal (entrypoints/tests weigh higher). */
export const FILE_ROLES = [
  'source',
  'test',
  'config',
  'doc',
  'entrypoint',
  'fixture',
  'generated',
  'unknown',
] as const;
export type FileRole = (typeof FILE_ROLES)[number];
export const fileRole = z.enum(FILE_ROLES);

/** Typed relations between file nodes (and reverse relations for cheap traversal). */
export const GRAPH_RELATIONS = [
  'imports',
  'imported_by',
  'tests',
  'tested_by',
  'sibling',
  'contains',
  'references',
] as const;
export type GraphRelation = (typeof GRAPH_RELATIONS)[number];
export const graphRelation = z.enum(GRAPH_RELATIONS);

/** A single file node in the normalized codegraph. */
export const graphFileNode = z.object({
  schemaVersion: schemaVersionField(CONTRACT_VERSIONS.graphMetadata),
  path: repoRelativePath,
  role: fileRole,
  language: z.string().min(1).max(64).optional(),
  importsCount: nonNegativeInt.default(0),
  importedByCount: nonNegativeInt.default(0),
  testsCount: nonNegativeInt.default(0),
  testedByCount: nonNegativeInt.default(0),
  /** Counts keyed by relation name, for relations beyond the explicit ones above. */
  relationCounts: z.record(z.string(), nonNegativeInt).optional(),
  /** Content hash of the file at the hydrated SHA, for cache invalidation. */
  contentHash: z.string().min(1).max(128).optional(),
});
export type GraphFileNode = z.infer<typeof graphFileNode>;

/** A typed edge between two file nodes. */
export const graphEdge = z.object({
  schemaVersion: schemaVersionField(CONTRACT_VERSIONS.graphMetadata),
  from: repoRelativePath,
  to: repoRelativePath,
  relation: graphRelation,
  /** Optional edge weight (e.g. number of import sites). */
  weight: nonNegativeInt.optional(),
});
export type GraphEdge = z.infer<typeof graphEdge>;

/**
 * A workspace's normalized graph metadata at a given git SHA — the projection
 * Hilo hydration produces and retrieval expansion (US-015) reads.
 */
export const graphMetadata = z.object({
  schemaVersion: schemaVersionField(CONTRACT_VERSIONS.graphMetadata),
  workspaceId,
  gitSha,
  generatedAt: isoTimestamp,
  nodeCount: nonNegativeInt,
  edgeCount: nonNegativeInt,
  nodes: z.array(graphFileNode).optional(),
  edges: z.array(graphEdge).optional(),
});
export type GraphMetadata = z.infer<typeof graphMetadata>;
