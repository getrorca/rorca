// ─── Context Intelligence Platform — Shared Contract Versions ─────────────────
//
// Every shared contract in this module carries an explicit `schemaVersion` field
// (see docs/context-intelligence-platform.md §6). Consumers (backend, frontend,
// CLI) validate the version on the wire so the contracts can evolve safely:
// an unknown version is rejected rather than silently mis-parsed.
//
// Versions follow the existing repo convention of short string literals
// (e.g. retrieval-pipeline.ts `GRAPH_RAG_SCORE_SCHEMA_VERSION = 'v2'`).

import { z } from 'zod';

/**
 * Umbrella version of the whole shared-contracts bundle. Bump the major (v1→v2)
 * only for a breaking change that touches multiple contracts at once.
 */
export const CONTEXT_CONTRACTS_VERSION = 'v1' as const;

/**
 * Per-contract schema versions. Each top-level contract validates its own
 * `schemaVersion` against the matching literal here, so a single contract can be
 * revved independently of the rest.
 */
export const CONTRACT_VERSIONS = {
  hydration: 'v1',
  graphMetadata: 'v1',
  retrievalCandidate: 'v1',
  retrievalTrace: 'v1',
  specContextBundle: 'v1',
  contextEvent: 'v1',
  memoryCandidate: 'v1',
  reviewAction: 'v1',
} as const;

export type ContractName = keyof typeof CONTRACT_VERSIONS;
export type ContractVersion = (typeof CONTRACT_VERSIONS)[ContractName];

/**
 * Build the `schemaVersion` field validator for a contract. Returns a literal
 * schema so a payload stamped with the wrong (or missing) version is rejected.
 *
 * @example
 *   const hydrationRecord = z.object({
 *     schemaVersion: schemaVersionField(CONTRACT_VERSIONS.hydration),
 *     ...
 *   });
 */
export function schemaVersionField<T extends string>(version: T): z.ZodLiteral<T> {
  return z.literal(version);
}
