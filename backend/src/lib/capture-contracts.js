/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
/**
 * US-026: Context Intelligence Platform — backend-local context event types.
 *
 * These match the root `shared/contracts/context-events.ts` and
 * `shared/contracts/memory-candidates.ts` contracts but live inside the
 * backend `src/` tree so they are reachable from `rootDir: "src"`.
 */
import { z } from 'zod';
// ── Primitives ──────────────────────────────────────────────────────────────
const nonEmptyString = z.string().min(1).max(2000);
const workspaceId = z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/, 'workspaceId must be 1–200 chars of [A-Za-z0-9_-] and must not start with a separator');
const idempotencyKey = z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{7,255}$/, 'idempotencyKey must be 8–256 chars of [A-Za-z0-9:._-] and must not start with a separator');
const isoTimestamp = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/, 'must be an ISO-8601 timestamp with timezone (e.g. 2026-06-27T12:00:00Z)');
const gitSha = z
    .string()
    .regex(/^[0-9a-f]{7,64}$/, 'gitSha must be a 7–64 char lowercase hex SHA');
const repoRelativePath = z
    .string()
    .min(1)
    .max(1024)
    .refine((p) => !p.startsWith('/'), { message: 'path must be repo-relative, not absolute' })
    .refine((p) => !p.split(/[\\/]/).includes('..'), { message: 'path must not contain ".." segments' });
const trustTier = z.enum(['authoritative', 'trusted', 'community', 'unverified']);
const confidence = z.number().min(0).max(1);
const reviewStatus = z.enum(['pending', 'approved', 'rejected', 'duplicate', 'superseded']);
// ── Context Event ───────────────────────────────────────────────────────────
const CONTEXT_EVENT_KINDS = ['commit', 'note', 'file_change', 'manual', 'reconcile'];
const contextEventKind = z.enum(CONTEXT_EVENT_KINDS);
export const contextEventSchema = z.object({
    schemaVersion: z.literal('v1'),
    idempotencyKey,
    workspaceId,
    kind: contextEventKind,
    source: nonEmptyString,
    payload: z.record(z.string(), z.unknown()),
    gitSha: gitSha.nullable().optional(),
    occurredAt: isoTimestamp,
    capturedAt: isoTimestamp.optional(),
});
// ── Memory Candidate ────────────────────────────────────────────────────────
export const memoryCandidateSchema = z.object({
    schemaVersion: z.literal('v1'),
    idempotencyKey,
    workspaceId,
    status: reviewStatus,
    title: nonEmptyString,
    body: z.string(),
    category: z.string().max(120).optional(),
    trust: trustTier,
    confidence: confidence.optional(),
    sourceEventKey: idempotencyKey.optional(),
    relatedFiles: z.array(repoRelativePath).optional(),
    createdAt: isoTimestamp,
    reviewedAt: isoTimestamp.nullable().optional(),
});
