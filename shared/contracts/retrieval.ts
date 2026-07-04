// ─── Context Intelligence Platform — Retrieval Contracts ──────────────────────
//
// Retrieval candidates and replayable traces (US-016 ranker, US-018 trace).
// Every candidate carries a normalized score AND a per-signal breakdown so the
// ranking is explainable; every retrieval is persisted as a trace that can be
// replayed for debugging and regression testing.

import { z } from 'zod';
import { CONTRACT_VERSIONS, schemaVersionField } from './version';
import {
  confidence,
  gitSha,
  graphMode,
  isoTimestamp,
  nonEmptyString,
  nonNegativeInt,
  workspaceId,
} from './primitives';
import { fileRole, graphRelation } from './graph';
import { trustTier } from './trust';

/** What kind of thing a candidate points at. */
export const CANDIDATE_KINDS = ['file', 'doc', 'memory', 'symbol', 'test'] as const;
export type CandidateKind = (typeof CANDIDATE_KINDS)[number];
export const candidateKind = z.enum(CANDIDATE_KINDS);

/**
 * The ranker's signals (US-016). Each contributes a normalized component to the
 * final score; the breakdown records every component so a score is explainable.
 */
export const RETRIEVAL_SIGNALS = [
  'keyword',
  'semantic',
  'graphDistance',
  'relationType',
  'fileRole',
  'testsEntrypoints',
  'gitRecency',
  'memoryRelevance',
  'trustAuthority',
] as const;
export type RetrievalSignal = (typeof RETRIEVAL_SIGNALS)[number];

/** Per-signal score contributions. All optional — a signal absent from a run is omitted. */
export const signalBreakdown = z.object({
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

/** A single ranked retrieval candidate with an explainable score breakdown. */
export const retrievalCandidate = z.object({
  schemaVersion: schemaVersionField(CONTRACT_VERSIONS.retrievalCandidate),
  id: nonEmptyString,
  kind: candidateKind,
  /** Path for files/docs/tests, memory id for memories, symbol id for symbols. */
  ref: nonEmptyString,
  title: z.string().max(500).optional(),
  /** Final normalized score in [0, 1]. */
  score: confidence,
  breakdown: signalBreakdown,
  /** Graph hops from the nearest seed (US-015); null when graph is unavailable. */
  graphDistance: nonNegativeInt.nullable().optional(),
  relation: graphRelation.nullable().optional(),
  role: fileRole.optional(),
  trust: trustTier,
  /** Human-readable explanation of why this candidate was retrieved. */
  reason: z.string().max(2000).optional(),
  confidence: confidence.optional(),
});
export type RetrievalCandidate = z.infer<typeof retrievalCandidate>;

/**
 * A replayable record of one retrieval (US-018): the brief it answered, the
 * workspace/SHA it ran against, the policy and graph mode, and the ranked
 * candidates produced. `degraded` + `graphMode` report honest degradation when
 * Hilo is absent.
 */
export const retrievalTrace = z.object({
  schemaVersion: schemaVersionField(CONTRACT_VERSIONS.retrievalTrace),
  traceId: nonEmptyString,
  workspaceId,
  /** Hash of the brief that drove this retrieval (cache + replay key). */
  briefHash: nonEmptyString,
  gitSha: gitSha.optional(),
  createdAt: isoTimestamp,
  /** Retrieval policy id/name in effect for this run. */
  policy: z.string().max(200).optional(),
  graphMode: graphMode.optional(),
  degraded: z.boolean().optional(),
  candidates: z.array(retrievalCandidate),
  tokenEstimate: nonNegativeInt.optional(),
});
export type RetrievalTrace = z.infer<typeof retrievalTrace>;
