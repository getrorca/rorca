/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * events.ts — US-032: Context event ingestion route.
 *
 * Exposes POST /api/events for the capture sidecar (rorca-capture) and external
 * tools to submit raw context events into the `context_events` table. This is
 * the ONLY supported ingestion path — the sidecar MUST never write to the DB
 * directly.
 *
 * Capabilities:
 *   - Validates the shared payload contract (zod)
 *   - Sanitizes/redacts secrets in payload before persistence
 *   - Validates workspace existence and lifecycle/value constraints
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
import { redactObject } from '../lib/context-safety';

const router = Router();

// ── Shared Payload Schema ──────────────────────────────────────────────────

const ContextEventSchema = z.object({
  workspace_id: z.string().min(1).max(255),
  // trim() so whitespace-only values are rejected at the boundary (422) to
  // match the DB CHECK constraints (length(btrim(...)) > 0) rather than 500ing.
  source_system: z.string().trim().min(1).max(255),
  event_type: z.string().trim().min(1).max(255),
  occurred_at: z.string().datetime({ message: 'occurred_at must be an ISO 8601 datetime string' }),
  summary: z.string().max(2000).optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
  actor: z.string().max(255).optional(),
  source_ref: z.string().max(1000).optional(),
  idempotency_key: z.string().trim().min(1).max(500),
  schema_version: z.number().int().positive().default(1),
});

type ContextEventInput = z.infer<typeof ContextEventSchema>;

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

// ── Internal: Persist event (idempotent) ─────────────────────────────────────

interface ContextEventRow {
  id: string;
  workspace_id: string;
  source_system: string;
  source_ref: string | null;
  event_type: string;
  actor: string | null;
  occurred_at: string;
  summary: string | null;
  payload: Record<string, unknown>;
  idempotency_key: string;
  schema_version: number;
  created_at: string;
  updated_at: string;
}

async function persistEvent(input: ContextEventInput): Promise<{ row: ContextEventRow; created: boolean }> {
  // Sanitize payload before persisting
  const { value: sanitizedPayload } = redactObject(input.payload);

  // Try insert with ON CONFLICT DO NOTHING; if the idempotency key already
  // exists, zero rows are affected and we fall through to SELECT the existing row.
  const insertResult = await execute(
    `INSERT INTO context_events
       (workspace_id, source_system, event_type, occurred_at, summary, payload,
        actor, source_ref, idempotency_key, schema_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (workspace_id, idempotency_key) DO NOTHING`,
    [
      input.workspace_id,
      input.source_system,
      input.event_type,
      input.occurred_at,
      input.summary ?? null,
      JSON.stringify(sanitizedPayload),
      input.actor ?? null,
      input.source_ref ?? null,
      input.idempotency_key,
      input.schema_version,
    ],
  );

  if (insertResult.rowCount === 0) {
    // Idempotency hit — return the existing record
    const existing = await queryOne<ContextEventRow>(
      `SELECT * FROM context_events
       WHERE workspace_id = $1 AND idempotency_key = $2`,
      [input.workspace_id, input.idempotency_key],
    );
    // Should never be null (unique constraint guarantees it), but guard anyway
    if (!existing) {
      throw new Error('Idempotency conflict but record not found — this is a bug');
    }
    return { row: existing, created: false };
  }

  // Fetch the newly inserted row (ON CONFLICT DO NOTHING doesn't return it)
  const created = await queryOne<ContextEventRow>(
    `SELECT * FROM context_events
     WHERE workspace_id = $1 AND idempotency_key = $2`,
    [input.workspace_id, input.idempotency_key],
  );
  if (!created) {
    throw new Error('Insert succeeded but record not found — this is a bug');
  }
  return { row: created, created: true };
}

// ── POST /api/events ────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/events:
 *   post:
 *     summary: Ingest a raw context event from a capture sidecar or external tool
 *     operationId: rorca_ingest_context_event
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Ingestion is the ONLY write path for external capture sidecars; must be callable from local/MCP clients with idempotency guarantees so offline queues can flush safely without duplicates."
 *     x-rorca-public-api: true
 *     description: >
 *       Submits a raw context event to the durable context_events ledger.
 *       The Rorca DB is the system of record for captured knowledge; external
 *       sidecars (rorca-capture) MUST use this API rather than direct DB writes.
 *
 *       Idempotency is enforced via (workspace_id, idempotency_key): a duplicate
 *       submission returns the existing record with HTTP 200 instead of 201.
 *       Payloads are redacted for secrets before persistence.
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
 *               - event_type
 *               - occurred_at
 *               - idempotency_key
 *             properties:
 *               workspace_id:
 *                 type: string
 *                 description: Workspace ID (must exist in Rorca)
 *               source_system:
 *                 type: string
 *                 description: Provenance system (e.g. 'rorca-capture', 'git', 'manual')
 *               event_type:
 *                 type: string
 *                 description: Event category (e.g. 'commit', 'manual_note', 'file_change')
 *               occurred_at:
 *                 type: string
 *                 format: date-time
 *                 description: When the event happened in the source system (ISO 8601)
 *               summary:
 *                 type: string
 *                 description: Short human-readable description
 *               payload:
 *                 type: object
 *                 description: Structured event body (redacted for secrets before persistence)
 *               actor:
 *                 type: string
 *                 description: Who or what produced the event
 *               source_ref:
 *                 type: string
 *                 description: Pointer into the source system (commit SHA, file path, note ID)
 *               idempotency_key:
 *                 type: string
 *                 description: Stable key so offline-queue flushes and retries are safe
 *               schema_version:
 *                 type: integer
 *                 default: 1
 *                 description: Context Intelligence contract version
 *     responses:
 *       201:
 *         description: Event created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ContextEvent'
 *       200:
 *         description: Existing event returned (idempotent duplicate)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ContextEvent'
 *       400:
 *         description: Invalid input (missing fields, bad date format)
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
 *       422:
 *         description: Validation failed (zod schema)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/', validateBody(ContextEventSchema), async (req: Request, res: Response) => {
  try {
    const input: ContextEventInput = req.body;

    // Validate workspace exists
    await assertWorkspaceExists(input.workspace_id);

    // Persist with idempotency. persistEvent reports whether the row was newly
    // inserted (201) or an existing record returned on an idempotency hit (200);
    // this is authoritative, unlike a created_at/updated_at timestamp heuristic
    // which misfires when a duplicate arrives within the same second.
    const { row, created } = await persistEvent(input);

    res.status(created ? 201 : 200).json(row);
  } catch (error) {
    handleRouteError(res, error, '[events] ingest');
  }
});

export default router;
