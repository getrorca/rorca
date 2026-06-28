// ─── Context Intelligence Platform — Review Action Contracts ──────────────────
//
// The actions a reviewer takes on a memory candidate (US-034): approve,
// edit-and-approve, reject, duplicate, supersede, revisit. Each action maps to a
// resulting review status; the governance gate (US-035) keys on that status.

import { z } from 'zod';
import { CONTRACT_VERSIONS, schemaVersionField } from './version';
import { nonEmptyString, type ReviewStatus } from './primitives';

/**
 * Review actions:
 * - `approve`          — accept as-is → `approved`.
 * - `edit_and_approve` — accept with edits → `approved` (requires `edits`).
 * - `reject`           — discard → `rejected`.
 * - `duplicate`        — mark as a duplicate of `targetId` → `duplicate`.
 * - `supersede`        — replaced by `targetId` → `superseded`.
 * - `revisit`          — send back to the queue → `pending`.
 */
export const REVIEW_ACTIONS = [
  'approve',
  'edit_and_approve',
  'reject',
  'duplicate',
  'supersede',
  'revisit',
] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];
export const reviewAction = z.enum(REVIEW_ACTIONS);

/** The review status each action resolves a candidate to. */
export const REVIEW_ACTION_RESULT: Record<ReviewAction, ReviewStatus> = {
  approve: 'approved',
  edit_and_approve: 'approved',
  reject: 'rejected',
  duplicate: 'duplicate',
  supersede: 'superseded',
  revisit: 'pending',
};

/** Edits carried by an `edit_and_approve` action. */
export const reviewEdits = z.object({
  title: z.string().min(1).optional(),
  body: z.string().optional(),
  category: z.string().max(120).optional(),
});
export type ReviewEdits = z.infer<typeof reviewEdits>;

/**
 * A reviewer's action on a candidate. `duplicate`/`supersede` require a
 * `targetId` (the canonical/superseding candidate); `edit_and_approve` requires
 * `edits`. Both invariants are enforced at validation time.
 */
export const reviewActionRequest = z
  .object({
    schemaVersion: schemaVersionField(CONTRACT_VERSIONS.reviewAction),
    candidateId: nonEmptyString,
    action: reviewAction,
    reviewer: z.string().max(200).optional(),
    note: z.string().max(4000).optional(),
    edits: reviewEdits.optional(),
    /** Target candidate for `duplicate`/`supersede`. */
    targetId: z.string().optional(),
  })
  .refine((v) => !(v.action === 'duplicate' || v.action === 'supersede') || !!v.targetId, {
    message: 'duplicate/supersede actions require targetId',
    path: ['targetId'],
  })
  .refine((v) => v.action !== 'edit_and_approve' || !!v.edits, {
    message: 'edit_and_approve requires edits',
    path: ['edits'],
  });
export type ReviewActionRequest = z.infer<typeof reviewActionRequest>;
