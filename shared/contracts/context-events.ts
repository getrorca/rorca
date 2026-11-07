// ─── Context Intelligence Platform — Context Event Contracts ──────────────────
//
// A context event is what the capture sidecar (`rorca-capture`) submits to Rorca
// over the ingestion API (US-032). Events are versioned, idempotency-keyed, and
// already redacted by the sidecar. They never write to the DB directly and never
// enter retrieval — they are raw capture-plane signal that may yield a reviewable
// memory candidate (design doc §5).

import { z } from 'zod';
import { CONTRACT_VERSIONS, schemaVersionField } from './version';
import { gitSha, idempotencyKey, isoTimestamp, nonEmptyString, workspaceId } from './primitives';

/** What kind of capture produced this event. */
export const CONTEXT_EVENT_KINDS = ['commit', 'note', 'file_change', 'manual', 'reconcile'] as const;
export type ContextEventKind = (typeof CONTEXT_EVENT_KINDS)[number];
export const contextEventKind = z.enum(CONTEXT_EVENT_KINDS);

export const contextEvent = z.object({
  schemaVersion: schemaVersionField(CONTRACT_VERSIONS.contextEvent),
  /** De-dupe key — flushing the sidecar queue twice must not double-ingest. */
  idempotencyKey,
  workspaceId,
  kind: contextEventKind,
  /** Origin of the event, e.g. `rorca-capture` or a daemon id. */
  source: nonEmptyString,
  /** Redacted, free-form payload (commit metadata, note body, etc.). */
  payload: z.record(z.string(), z.unknown()),
  gitSha: gitSha.nullable().optional(),
  occurredAt: isoTimestamp,
  /** When the sidecar captured it (may differ from `occurredAt` for backfills). */
  capturedAt: isoTimestamp.optional(),
});
export type ContextEvent = z.infer<typeof contextEvent>;
