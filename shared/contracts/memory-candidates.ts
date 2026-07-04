// ─── Context Intelligence Platform — Memory Candidate Contracts ───────────────
//
// Captured knowledge enters as a reviewable memory candidate, never as durable
// memory (design doc §2.5). A candidate is created PENDING by ingestion (US-032),
// reviewed via a review action (US-034), and only an `approved` candidate, once
// promoted through the existing durable-memory path (US-035), becomes retrievable.

import { z } from 'zod';
import { CONTRACT_VERSIONS, schemaVersionField } from './version';
import {
  confidence,
  idempotencyKey,
  isoTimestamp,
  nonEmptyString,
  repoRelativePath,
  reviewStatus,
  workspaceId,
} from './primitives';
import { trustTier } from './trust';

export const memoryCandidate = z.object({
  schemaVersion: schemaVersionField(CONTRACT_VERSIONS.memoryCandidate),
  /** Stable de-dupe key carried from the originating context event. */
  idempotencyKey,
  workspaceId,
  /** Governance state — created `pending`; the gate only lets `approved` through. */
  status: reviewStatus,
  title: nonEmptyString,
  body: z.string(),
  category: z.string().max(120).optional(),
  trust: trustTier,
  confidence: confidence.optional(),
  /** Idempotency key of the `context_event` this candidate was derived from. */
  sourceEventKey: idempotencyKey.optional(),
  /** Repo-relative files this candidate is about, for provenance previews (US-037). */
  relatedFiles: z.array(repoRelativePath).optional(),
  createdAt: isoTimestamp,
  reviewedAt: isoTimestamp.nullable().optional(),
});
export type MemoryCandidate = z.infer<typeof memoryCandidate>;
