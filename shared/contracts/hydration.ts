// ─── Context Intelligence Platform — Hydration Contracts ──────────────────────
//
// The status record for a Hilo hydration run (US-003): which workspace, at which
// git SHA, current state, counts, timing, and any error. Freshness is keyed to
// the git SHA so a stale graph is detectable (US-009) and re-buildable — the
// hydration record describes derived state, never durable truth (design doc §3).

import { z } from 'zod';
import { CONTRACT_VERSIONS, schemaVersionField } from './version';
import { gitSha, isoTimestamp, nonNegativeInt, workspaceId } from './primitives';

/**
 * Hydration lifecycle state:
 * - `pending`   — queued, not started.
 * - `running`   — Hilo is hydrating now.
 * - `succeeded` — completed; graph is fresh for `gitSha`.
 * - `failed`    — completed with an error; see `error`.
 * - `stale`     — succeeded previously but the workspace SHA has since moved.
 */
export const HYDRATION_STATUSES = ['pending', 'running', 'succeeded', 'failed', 'stale'] as const;
export type HydrationStatus = (typeof HYDRATION_STATUSES)[number];
export const hydrationStatus = z.enum(HYDRATION_STATUSES);

export const hydrationRecord = z.object({
  schemaVersion: schemaVersionField(CONTRACT_VERSIONS.hydration),
  workspaceId,
  status: hydrationStatus,
  /** The git SHA this hydration is keyed to (freshness key). */
  gitSha,
  nodeCount: nonNegativeInt.nullable().optional(),
  edgeCount: nonNegativeInt.nullable().optional(),
  startedAt: isoTimestamp.nullable().optional(),
  finishedAt: isoTimestamp.nullable().optional(),
  durationMs: nonNegativeInt.nullable().optional(),
  /** Error message when `status === 'failed'`; null/absent otherwise. */
  error: z.string().nullable().optional(),
  /** True when the current workspace SHA no longer matches `gitSha`. */
  stale: z.boolean().optional(),
});
export type HydrationRecord = z.infer<typeof hydrationRecord>;
