/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * candidates.ts — US-032: Memory candidate ingestion route.
 *
 * Exposes POST /api/candidates for the capture sidecar (rorca-capture) and
 * external tools to submit reviewable memory candidates into the
 * `memory_candidates` table. This is the ONLY supported ingestion path — the
 * sidecar MUST never write to the DB directly.
 *
 * Capabilities:
 *   - Validates the shared payload contract (zod)
 *   - Sanitizes/redacts secrets in context and rule before persistence
 *   - Validates workspace existence, category/lifecycle/trust values
 *   - Idempotent: duplicate idempotency_key returns the existing record (201 on
 *     first insert, 200 on duplicate)
 *   - Swagger tier/rationale annotations for MCP exposure
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { queryOne, execute } from '../db/index';
import { validateBody } from '../lib/validate';
import { handleRouteError } from '../lib/async-handler';
import { ValidationError, NotFoundError } from '../lib/errors';
import { redactSecrets } from '../lib/context-safety';

const router = Router();

// ── Shared Payload Schema ──────────────────────────────────────────────────

const MemoryCandidateSchema = z.object({
  workspace_id: z.string().min(1).max(255),
  source_system: z.string().min(1).max(255),
  category: z.string().min(1).max(255),
  title: z.string().min(1).max(1000),
  rule: z.string().min(1),
  context: z.string().max(5000).optional(),
  related_files: z.array(z.string()).default([]),
  confidence: z.enum(['high', 'medium', 'low']).default('medium'),
  trust_tier: z.enum(['authoritative', 'trusted', 'community', 'unverified']).default('unverified'),
  source_ref: z.string().max(1000).optional(),
  context_event_id: z.number().int().positive().optional(),
  idempotency_key: z.string().min(1).max(500),
  schema_version: z.number().int().positive().default(1),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

type MemoryCandidateInput = z.infer<typeof MemoryCandidateSchema>;

// ── Internal: Validate workspace exists ──────────────────────────────────────

async function assertWorkspaceExists(workspaceId: string): Promise<void> {
  const row = await queryOne<{ id: string }>(
    'SELECT id FROM workspaces WHERE id = $1',
    [workspaceId],
  );
  if (!row) {
    throw new NotFoundError(`Workspace '${workspaceId}' not found`);
  }
}

// ── Internal: Validate context_event_id FK if provided ───────────────────────

async function assertContextEventExists(
  eventId: number,
  workspaceId: string,
): Promise<void> {
  const row = await queryOne<{ id: string }>(
    'SELECT id FROM context_events WHERE id = $1 AND workspace_id = $2',
    [eventId, workspaceId],
  );
  if (!row) {
    throw new NotFoundError(
      `context_event ${eventId} not found in workspace '${workspaceId}'`,
    );
  }
}

// ── Internal: Persist candidate (idempotent) ─────────────────────────────────

interface MemoryCandidateRow {
  id: string;
  workspace_id: string;
  context_event_id: number | null;
  source_system: string;
  source_ref: string | null;
  category: string;
  title: string;
  rule: string;
  context: string | null;
  related_files: string[];
  confidence: string;
  trust_tier: string;
  review_status: string;
  reviewer: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  duplicate_of_candidate_id: number | null;
  promoted_memory_id: number | null;
  promoted_at: string | null;
  idempotency_key: string;
  schema_version: number;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

async function persistCandidate(input: MemoryCandidateInput): Promise<MemoryCandidateRow> {
  // Sanitize string fields that may contain secrets
  const { redacted: sanitizedRule } = redactSecrets(input.rule);
  const sanitizedContext = input.context ? redactSecrets(input.context).redacted : null;

  // Try insert with ON CONFLICT DO NOTHING; if the idempotency key already
  // exists, zero rows are affected and we fall through to SELECT the existing row.
  const insertResult = await execute(
    `INSERT INTO memory_candidates
       (workspace_id, source_system, category, title, rule, context,
        related_files, confidence, trust_tier,
        source_ref, context_event_id, idempotency_key, schema_version, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (workspace_id, idempotency_key) DO NOTHING`,
    [
      input.workspace_id,
      input.source_system,
      input.category,
      input.title,
      sanitizedRule,
      sanitizedContext,
      JSON.stringify(input.related_files),
      input.confidence,
      input.trust_tier,
      input.source_ref ?? null,
      input.context_event_id ?? null,
      input.idempotency_key,
      input.schema_version,
      JSON.stringify(input.metadata),
    ],
  );

  if (insertResult.rowCount === 0) {
    // Idempotency hit — return the existing record
    const existing = await queryOne<MemoryCandidateRow>(
      `SELECT * FROM memory_candidates
       WHERE workspace_id = $1 AND idempotency_key = $2`,
      [input.workspace_id, input.idempotency_key],
    );
    if (!existing) {
      throw new Error('Idempotency conflict but record not found — this is a bug');
    }
    return existing;
  }

  // Fetch the newly inserted row
  const created = await queryOne<MemoryCandidateRow>(
    `SELECT * FROM memory_candidates
     WHERE workspace_id = $1 AND idempotency_key = $2`,
    [input.workspace_id, input.idempotency_key],
  );
  if (!created) {
    throw new Error('Insert succeeded but record not found — this is a bug');
  }
  return created;
}

// ── POST /api/candidates ────────────────────────────────────────────────────

/**
 * @swagger
 * /api/candidates:
 *   post:
 *     summary: Ingest a reviewable memory candidate from a capture sidecar or external tool
 *     operationId: rorca_ingest_memory_candidate
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Ingestion is the ONLY write path for external capture sidecars; must be callable from local/MCP clients with idempotency guarantees so offline queues can flush safely without duplicates."
 *     x-rorca-public-api: true
 *     description: >
 *       Submits a distilled memory candidate to the reviewable memory_candidates table.
 *       Candidates enter as 'pending' and must pass through the governance gate (US-034/035)
 *       before they can be promoted to durable memory and influence retrieval.
 *
 *       Idempotency is enforced via (workspace_id, idempotency_key): a duplicate
 *       submission returns the existing record with HTTP 200 instead of 201.
 *       Rule and context fields are redacted for secrets before persistence.
 *     tags: [Context Intelligence]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - workspace_id
 *               - source_system
 *               - category
 *               - title
 *               - rule
 *               - idempotency_key
 *             properties:
 *               workspace_id:
 *                 type: string
 *                 description: Workspace ID (must exist in Rorca)
 *               source_system:
 *                 type: string
 *                 description: Provenance system (e.g. 'rorca-capture', 'git', 'manual')
 *               category:
 *                 type: string
 *                 description: Knowledge category (Architecture, Bug Fix, Convention, Decision, Gotcha, Pattern)
 *               title:
 *                 type: string
 *                 description: Short summary of the distilled knowledge
 *               rule:
 *                 type: string
 *                 description: The actionable lesson (redacted for secrets before persistence)
 *               context:
 *                 type: string
 *                 description: Why it matters (redacted for secrets before persistence)
 *               related_files:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Workspace-relative file paths this candidate touches
 *               confidence:
 *                 type: string
 *                 enum: [high, medium, low]
 *                 default: medium
 *               trust_tier:
 *                 type: string
 *                 enum: [authoritative, trusted, community, unverified]
 *                 default: unverified
 *               source_ref:
 *                 type: string
 *                 description: Pointer into the source system (commit SHA, file path, note ID)
 *               context_event_id:
 *                 type: integer
 *                 description: FK to the originating context_event (if any)
 *               idempotency_key:
 *                 type: string
 *                 description: Stable key so offline-queue flushes and retries are safe
 *               schema_version:
 *                 type: integer
 *                 default: 1
 *               metadata:
 *                 type: object
 *     responses:
 *       201:
 *         description: Candidate created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/MemoryCandidate'
 *       200:
 *         description: Existing candidate returned (idempotent duplicate)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/MemoryCandidate'
 *       400:
 *         description: Invalid input (missing fields, bad enum values)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Workspace or context_event not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       422:
 *         description: Validation failed (zod schema)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/', validateBody(MemoryCandidateSchema), async (req: Request, res: Response) => {
  try {
    const input: MemoryCandidateInput = req.body;

    // Validate workspace exists
    await assertWorkspaceExists(input.workspace_id);

    // Validate context_event_id FK if provided
    if (input.context_event_id) {
      await assertContextEventExists(input.context_event_id, input.workspace_id);
    }

    // Persist with idempotency
    const row = await persistCandidate(input);

    // Determine status: 201 if new (created_at ≈ updated_at), 200 if duplicate
    const isNew = Math.abs(
      new Date(row.updated_at).getTime() - new Date(row.created_at).getTime(),
    ) < 1000;

    res.status(isNew ? 201 : 200).json(row);
  } catch (error) {
    handleRouteError(res, error, '[candidates] ingest');
  }
});

export default router;
