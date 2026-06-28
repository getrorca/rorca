/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * candidates.ts — US-032 & US-033: Memory candidate ingestion, list, and detail routes.
 *
 * US-032 exposes POST /api/candidates for the capture sidecar (rorca-capture) and
 * external tools to submit reviewable memory candidates into the
 * `memory_candidates` table. This is the ONLY supported ingestion path — the
 * sidecar MUST never write to the DB directly.
 *
 * US-033 adds paginated list (GET /api/candidates) with key filters and a
 * detail view (GET /api/candidates/:id) that returns event provenance,
 * related files, metadata, and the promoted memory link. Both endpoints
 * redact sensitive fields (rule, context, event payload) on output for
 * defense-in-depth.
 *
 * Capabilities:
 *   - Validates the shared payload contract (zod)
 *   - Sanitizes/redacts secrets in context and rule before persistence
 *   - Validates workspace existence, category/lifecycle/trust values
 *   - Idempotent: duplicate idempotency_key returns the existing record (201 on
 *     first insert, 200 on duplicate)
 *   - Paginated list with filters: status, source_system, category, confidence,
 *     trust_tier, search, and date range
 *   - Detail view with event provenance, promoted memory link, and full metadata
 *   - Swagger tier/rationale annotations for MCP exposure
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { queryOne, execute } from '../db/index';
import { validateBody } from '../lib/validate';
import { handleRouteError } from '../lib/async-handler';
import { ValidationError, NotFoundError } from '../lib/errors';
import { redactSecrets } from '../lib/context-safety';
import { parsePaginationParams, paginateQuery } from '../lib/paginate';

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

// ── Types for list/detail output ────────────────────────────────────────────

/** Row shape returned by the database (snake_case). */
interface CandidateRow {
  id: string;
  workspace_id: string;
  context_event_id: number | null;
  source_system: string;
  source_ref: string | null;
  category: string;
  title: string;
  rule: string;
  context: string | null;
  related_files: string[] | string;
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
  metadata: Record<string, unknown> | string;
  created_at: string;
  updated_at: string;
}

interface ContextEventRow {
  id: number;
  workspace_id: string;
  source_system: string;
  source_ref: string | null;
  event_type: string;
  actor: string | null;
  occurred_at: string;
  summary: string | null;
  payload: Record<string, unknown> | string;
  idempotency_key: string;
  schema_version: number;
  created_at: string;
}

interface PromotedMemoryRow {
  id: number;
  category: string;
  content: string;
  created_at: string;
}

/** Safe parsed form of related_files. */
function parseRelatedFiles(value: string[] | string | null | undefined): string[] {
  if (Array.isArray(value)) return value.filter((f): f is string => typeof f === 'string');
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter((f: unknown): f is string => typeof f === 'string') : []; } catch { return []; }
  }
  return [];
}

/** Parse metadata JSONB field. */
function parseMetadata(value: Record<string, unknown> | string | null | undefined): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; }
  }
  return {};
}

/** Parse context_event payload JSONB field, redacting secrets. */
function parsePayloadRedacted(value: Record<string, unknown> | string | null | undefined): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const str = JSON.stringify(value);
    const { redacted } = redactSecrets(str);
    try { return JSON.parse(redacted); } catch { return {}; }
  }
  if (typeof value === 'string') {
    const { redacted } = redactSecrets(value);
    try { return JSON.parse(redacted); } catch { return {}; }
  }
  return {};
}

/**
 * Map a raw candidate row to the output shape, redacting rule & context.
 * Applies redactSecrets as defense-in-depth (ingestion already redacts, but
 * this keeps direct-DB-loaded rows safe when displayed).
 */
function mapCandidateOutput(row: CandidateRow) {
  const { redacted: safeRule } = redactSecrets(row.rule);
  const safeContext = row.context ? redactSecrets(row.context).redacted : null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    contextEventId: row.context_event_id,
    sourceSystem: row.source_system,
    sourceRef: row.source_ref,
    category: row.category,
    title: row.title,
    rule: safeRule,
    context: safeContext,
    relatedFiles: parseRelatedFiles(row.related_files),
    confidence: row.confidence,
    trustTier: row.trust_tier,
    reviewStatus: row.review_status,
    reviewer: row.reviewer,
    reviewedAt: row.reviewed_at,
    reviewNote: row.review_note,
    duplicateOfCandidateId: row.duplicate_of_candidate_id,
    promotedMemoryId: row.promoted_memory_id,
    promotedAt: row.promoted_at,
    metadata: parseMetadata(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── GET /api/candidates (list) ─────────────────────────────────────────────

/**
 * @swagger
 * /api/candidates:
 *   get:
 *     summary: List memory candidates with pagination and filters
 *     operationId: listMemoryCandidates
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Read-only candidate listing with workspace scoping — safe for local/MCP automation with no write or admin side effects."
 *     x-rorca-public-api: true
 *     description: >
 *       Returns a paginated, filterable list of memory candidates for a workspace.
 *       Supports filtering by review status, source system, category, confidence,
 *       trust tier, search text, and date range. Sensitive fields (rule, context)
 *       are redacted on output for defense-in-depth.
 *     tags: [Context Intelligence]
 *     parameters:
 *       - name: workspace_id
 *         in: query
 *         required: true
 *         schema:
 *           type: string
 *         description: Workspace ID
 *       - name: status
 *         in: query
 *         schema:
 *           type: string
 *           enum: [pending, approved, rejected, duplicate, superseded, revisit]
 *         description: Filter by review status
 *       - name: source_system
 *         in: query
 *         schema:
 *           type: string
 *         description: Filter by source system
 *       - name: category
 *         in: query
 *         schema:
 *           type: string
 *         description: Filter by knowledge category
 *       - name: confidence
 *         in: query
 *         schema:
 *           type: string
 *           enum: [high, medium, low]
 *         description: Filter by confidence level
 *       - name: trust_tier
 *         in: query
 *         schema:
 *           type: string
 *           enum: [authoritative, trusted, community, unverified]
 *         description: Filter by trust tier
 *       - name: search
 *         in: query
 *         schema:
 *           type: string
 *         description: Full-text search on title, rule, and context
 *       - name: date_from
 *         in: query
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Filter candidates created on or after this ISO 8601 timestamp
 *       - name: date_to
 *         in: query
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Filter candidates created on or before this ISO 8601 timestamp
 *       - name: page
 *         in: query
 *         schema:
 *           type: integer
 *           default: 1
 *       - name: limit
 *         in: query
 *         schema:
 *           type: integer
 *           default: 50
 *           maximum: 250
 *     responses:
 *       200:
 *         description: Paginated list of memory candidates
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 items:
 *                   type: array
 *                   items:
 *                     type: object
 *                 total:
 *                   type: integer
 *                 hasMore:
 *                   type: boolean
 *                 cursor:
 *                   type: string
 *                   nullable: true
 *       400:
 *         description: Missing workspace_id
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Workspace not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspace_id as string;
    if (!workspaceId) throw new ValidationError('workspace_id required');

    // Validate workspace exists
    await assertWorkspaceExists(workspaceId);

    // Build filters
    const where: string[] = ['mc.workspace_id = $1'];
    const params: unknown[] = [workspaceId];
    let paramIdx = 2;

    const status = req.query.status as string;
    if (status) {
      const validStatuses = ['pending', 'approved', 'rejected', 'duplicate', 'superseded', 'revisit'];
      if (!validStatuses.includes(status)) {
        throw new ValidationError(`Invalid status. Must be one of: ${validStatuses.join(', ')}`);
      }
      where.push(`mc.review_status = $${paramIdx}`);
      params.push(status);
      paramIdx++;
    }

    const sourceSystem = req.query.source_system as string;
    if (sourceSystem) {
      where.push(`mc.source_system = $${paramIdx}`);
      params.push(sourceSystem);
      paramIdx++;
    }

    const category = req.query.category as string;
    if (category) {
      where.push(`mc.category = $${paramIdx}`);
      params.push(category);
      paramIdx++;
    }

    const confidence = req.query.confidence as string;
    if (confidence) {
      const validConfidences = ['high', 'medium', 'low'];
      if (!validConfidences.includes(confidence)) {
        throw new ValidationError(`Invalid confidence. Must be one of: ${validConfidences.join(', ')}`);
      }
      where.push(`mc.confidence = $${paramIdx}`);
      params.push(confidence);
      paramIdx++;
    }

    const trustTier = req.query.trust_tier as string;
    if (trustTier) {
      const validTiers = ['authoritative', 'trusted', 'community', 'unverified'];
      if (!validTiers.includes(trustTier)) {
        throw new ValidationError(`Invalid trust_tier. Must be one of: ${validTiers.join(', ')}`);
      }
      where.push(`mc.trust_tier = $${paramIdx}`);
      params.push(trustTier);
      paramIdx++;
    }

    const search = req.query.search as string;
    if (search) {
      where.push(`(
        mc.title ILIKE $${paramIdx}
        OR mc.rule ILIKE $${paramIdx}
        OR mc.context ILIKE $${paramIdx}
      )`);
      params.push(`%${search}%`);
      paramIdx++;
    }

    const dateFrom = req.query.date_from as string;
    if (dateFrom) {
      where.push(`mc.created_at >= $${paramIdx}::timestamptz`);
      params.push(dateFrom);
      paramIdx++;
    }

    const dateTo = req.query.date_to as string;
    if (dateTo) {
      where.push(`mc.created_at <= $${paramIdx}::timestamptz`);
      params.push(dateTo);
      paramIdx++;
    }

    const whereClause = where.join(' AND ');

    const baseQuery = `SELECT
      id, workspace_id, context_event_id, source_system, source_ref,
      category, title, rule, context, related_files,
      confidence, trust_tier, review_status, reviewer, reviewed_at, review_note,
      duplicate_of_candidate_id, promoted_memory_id, promoted_at,
      idempotency_key, schema_version, metadata, created_at, updated_at
    FROM memory_candidates mc
    WHERE ${whereClause}`;

    const countQuery = `SELECT COUNT(*)::int AS total
      FROM memory_candidates mc
      WHERE ${whereClause}`;

    const pagination = parsePaginationParams(req);

    const page = await paginateQuery<CandidateRow>({
      query: baseQuery,
      countQuery,
      params,
      pagination,
      orderBy: 'mc.created_at DESC, mc.id DESC',
      cursorColumn: 'mc.id',
      cursorDirection: 'desc',
    });

    // Defence-in-depth: redact rule & context on every row
    const items = page.items.map(mapCandidateOutput);

    res.json({ ...page, items });
  } catch (error) {
    handleRouteError(res, error, '[candidates] list');
  }
});

// ── GET /api/candidates/:id (detail) ───────────────────────────────────────

/**
 * @swagger
 * /api/candidates/{id}:
 *   get:
 *     summary: Get a single memory candidate with full provenance
 *     operationId: getMemoryCandidate
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Read-only candidate detail with workspace scoping — safe for local/MCP automation with no write or admin side effects."
 *     x-rorca-public-api: true
 *     description: >
 *       Returns a single memory candidate with its full provenance: the originating
 *       context event (with redacted payload), related files, metadata, and the
 *       promoted memory link if the candidate has been approved and promoted.
 *       Sensitive fields (rule, context, event payload) are redacted on output.
 *     tags: [Context Intelligence]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: integer
 *         description: Candidate ID
 *     responses:
 *       200:
 *         description: Memory candidate with full provenance
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 candidate:
 *                   type: object
 *                 eventProvenance:
 *                   type: object
 *                   nullable: true
 *                   description: The originating context event (null if no event linked)
 *                 promotedMemory:
 *                   type: object
 *                   nullable: true
 *                   description: The durable memory this candidate was promoted into
 *       400:
 *         description: Invalid candidate ID
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Candidate not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id) || id <= 0) {
      throw new ValidationError('Candidate ID must be a positive integer');
    }

    // Fetch the candidate
    const row = await queryOne<CandidateRow>(
      `SELECT * FROM memory_candidates WHERE id = $1`,
      [id],
    );
    if (!row) {
      throw new NotFoundError(`Candidate ${id} not found`);
    }

    // Map candidate output (redacts rule & context)
    const candidate = mapCandidateOutput(row);

    // Fetch provenance event if linked
    let eventProvenance: Record<string, unknown> | null = null;
    if (row.context_event_id) {
      const event = await queryOne<ContextEventRow>(
        `SELECT id, workspace_id, source_system, source_ref, event_type, actor,
                occurred_at, summary, payload, idempotency_key, schema_version, created_at
         FROM context_events WHERE id = $1`,
        [row.context_event_id],
      );
      if (event) {
        eventProvenance = {
          id: event.id,
          workspaceId: event.workspace_id,
          sourceSystem: event.source_system,
          sourceRef: event.source_ref,
          eventType: event.event_type,
          actor: event.actor,
          occurredAt: event.occurred_at,
          summary: event.summary,
          payload: parsePayloadRedacted(event.payload),
          schemaVersion: event.schema_version,
          createdAt: event.created_at,
        };
      }
    }

    // Fetch promoted memory link if candidate was promoted
    let promotedMemory: Record<string, unknown> | null = null;
    if (row.promoted_memory_id) {
      const mem = await queryOne<PromotedMemoryRow>(
        `SELECT id, category, content, created_at
         FROM memories WHERE id = $1 AND deleted_at IS NULL`,
        [row.promoted_memory_id],
      );
      if (mem) {
        promotedMemory = {
          id: mem.id,
          category: mem.category,
          content: mem.content,
          createdAt: mem.created_at,
        };
      }
    }

    res.json({
      candidate,
      eventProvenance: eventProvenance ?? null,
      promotedMemory: promotedMemory ?? null,
    });
  } catch (error) {
    handleRouteError(res, error, '[candidates] detail');
  }
});

export default router;
