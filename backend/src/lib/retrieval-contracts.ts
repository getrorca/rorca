/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * US-018: Retrieval trace contracts — backend-local mirror.
 *
 * These match the root `shared/contracts/retrieval.ts` and
 * `shared/contracts/primitives.ts` contracts but live inside the
 * backend `src/` tree so they are reachable from `rootDir: "src"`.
 *
 * See docs/context-intelligence-platform.md §6 (Shared Contracts).
 */

import { z } from 'zod';

// ── Primitives ──────────────────────────────────────────────────────────────

const nonEmptyString = z.string().min(1).max(2000);
const nonNegativeInt = z.number().int().min(0);
const confidence = z.number().min(0).max(1);

const workspaceId = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/,
    'workspaceId must be 1–200 chars of [A-Za-z0-9_-] and must not start with a separator',
  );

const isoTimestamp = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/,
    'must be an ISO-8601 timestamp with timezone (e.g. 2026-06-27T12:00:00Z)',
  );

const gitSha = z
  .string()
  .regex(/^[0-9a-f]{7,64}$/, 'gitSha must be a 7–64 char lowercase hex SHA');

const graphMode = z.enum(['full', 'lite', 'disabled']);

// ── Trust (mirrored from shared/contracts/trust.ts) ────────────────────────

const trustTier = z.enum(['verified', 'unverified', 'disputed']);

// ── Graph (mirrored from shared/contracts/graph.ts) ────────────────────────

const fileRole = z.enum(['test', 'entrypoint', 'doc', 'config', 'source', 'generated', 'unknown']);

const graphRelation = z.enum([
  'TOUCHES',
  'ABOUT',
  'LEARNED_FROM',
  'FROM_SPEC',
  'BELONGS_TO',
  'APPLIES_TO',
  'USED_IN',
  'DEPENDS_ON',
  'IN_WORKSPACE',
]);

// ── Candidate contracts ────────────────────────────────────────────────────

export const CANDIDATE_KINDS = ['file', 'doc', 'memory', 'symbol', 'test'] as const;
export type CandidateKind = (typeof CANDIDATE_KINDS)[number];
const candidateKind = z.enum(CANDIDATE_KINDS);

const signalBreakdown = z.object({
  keyword: z.number().optional(),
  semantic: z.number().optional(),
  graphDistance: z.number().optional(),
  relationType: z.number().optional(),
  fileRole: z.number().optional(),
  testsEntrypoints: z.number().optional(),
  gitRecency: z.number().optional(),
  memoryRelevance: z.number().optional(),
  trustAuthority: z.number().optional(),
});
export type SignalBreakdown = z.infer<typeof signalBreakdown>;

export const retrievalCandidate = z.object({
  schemaVersion: z.literal('v1'),
  id: nonEmptyString,
  kind: candidateKind,
  ref: nonEmptyString,
  title: z.string().max(500).optional(),
  score: confidence,
  breakdown: signalBreakdown,
  graphDistance: nonNegativeInt.nullable().optional(),
  relation: graphRelation.nullable().optional(),
  role: fileRole.optional(),
  trust: trustTier,
  reason: z.string().max(2000).optional(),
  confidence: confidence.optional(),
});
export type RetrievalCandidate = z.infer<typeof retrievalCandidate>;

// ── Trace contract ────────────────────────────────────────────────────────

export const retrievalTrace = z.object({
  schemaVersion: z.literal('v1'),
  traceId: nonEmptyString,
  workspaceId,
  briefHash: nonEmptyString,
  gitSha: gitSha.optional(),
  createdAt: isoTimestamp,
  policy: z.string().max(200).optional(),
  graphMode: graphMode.optional(),
  degraded: z.boolean().optional(),
  candidates: z.array(retrievalCandidate),
  tokenEstimate: nonNegativeInt.optional(),
});
export type RetrievalTrace = z.infer<typeof retrievalTrace>;
