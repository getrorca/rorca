// ─── Context Intelligence Platform — Shared Primitive Validators ──────────────
//
// Small, reusable runtime validators shared by every contract. These are the
// building blocks the platform's correctness depends on: a malformed workspace
// id, review status, confidence value, or idempotency key must be rejected at
// the boundary, not after it has poisoned a graph, trace, or review decision.
//
// Path/secret safety (US-005) is the authoritative home for full traversal and
// redaction protection; the light `repoRelativePath` here only rejects the
// obvious unsafe shapes so provenance refs stay well-formed.

import { z } from 'zod';

/** Non-empty, length-bounded string — the default for opaque ids and refs. */
export const nonEmptyString = z.string().min(1).max(2000);

/** Non-negative integer — counts, durations (ms), token estimates. */
export const nonNegativeInt = z.number().int().min(0);

/**
 * Rorca workspace id. Workspaces use slug-like TEXT primary keys
 * (e.g. `ws-1`, `rorca-feat-context-intelligence-US-002`). The id must start
 * with an alphanumeric and contain only `[A-Za-z0-9_-]` thereafter — which
 * rejects empty strings, leading separators, whitespace, dots, and any path
 * traversal (`/`, `..`) that could escape a workspace-scoped lookup.
 */
export const WORKSPACE_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
export const workspaceId = z
  .string()
  .regex(
    WORKSPACE_ID_REGEX,
    'workspaceId must be 1–200 chars of [A-Za-z0-9_-] and must not start with a separator',
  );

/**
 * Idempotency key for sidecar submissions and post-save jobs. Mirrors the
 * colon-delimited keys already used in the codebase
 * (e.g. `spec-post-save-v1:ws-1:spec-retry:1`). Bounded length, safe charset,
 * no whitespace or slashes.
 */
export const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9][A-Za-z0-9:._-]{7,255}$/;
export const idempotencyKey = z
  .string()
  .regex(
    IDEMPOTENCY_KEY_REGEX,
    'idempotencyKey must be 8–256 chars of [A-Za-z0-9:._-] and must not start with a separator',
  );

/**
 * Normalized confidence / score in the inclusive range [0, 1].
 * Zod's `z.number()` already rejects `NaN`; the bounds reject ±Infinity and
 * out-of-range values, and a non-number (e.g. `'high'`) fails the type check.
 */
export const confidence = z.number().min(0).max(1);

/**
 * Review status for a memory candidate. The governance gate (US-035) keys on
 * this: only `approved` candidates may ever influence retrieval, so the set is
 * closed and `revisit` is an action (review.ts), never a status.
 */
export const REVIEW_STATUSES = ['pending', 'approved', 'rejected', 'duplicate', 'superseded'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
export const reviewStatus = z.enum(REVIEW_STATUSES);

/** Git commit SHA (short or full), used as the hydration freshness key. */
export const GIT_SHA_REGEX = /^[0-9a-f]{7,64}$/;
export const gitSha = z.string().regex(GIT_SHA_REGEX, 'gitSha must be a 7–64 char lowercase hex SHA');

/**
 * ISO-8601 timestamp string with timezone (`Z` or ±HH:MM). Validated by regex
 * so the check is deterministic and runtime-agnostic (no Date dependency).
 */
export const ISO_8601_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
export const isoTimestamp = z
  .string()
  .regex(ISO_8601_REGEX, 'must be an ISO-8601 timestamp with timezone (e.g. 2026-06-27T12:00:00Z)');

/**
 * Repo-relative file path used in provenance/graph refs. Rejects absolute paths
 * and `..` traversal segments. NOTE: US-005 owns the canonical path-safety
 * primitives; this is a lightweight well-formedness guard only.
 */
export const repoRelativePath = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => !p.startsWith('/'), { message: 'path must be repo-relative, not absolute' })
  .refine((p) => !p.split(/[\\/]/).includes('..'), { message: 'path must not contain ".." segments' });

/**
 * Graph availability mode, mirrored from the platform's DB-mode detection
 * (full = AGE present, lite = connected without AGE, disabled = unreachable).
 * Surfaced on retrieval traces and bundles so degradation is reported honestly.
 */
export const GRAPH_MODES = ['full', 'lite', 'disabled'] as const;
export type GraphMode = (typeof GRAPH_MODES)[number];
export const graphMode = z.enum(GRAPH_MODES);
