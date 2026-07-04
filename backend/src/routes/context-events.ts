/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { queryOne } from '../db/index';
import { NotFoundError, ValidationError } from '../lib/errors';
import { broadcastAll } from '../lib/sse-hub';
import {
  CONTEXT_EVENT_TYPES,
  CONTEXT_TRUST_TIERS,
  buildContextEventIdempotencyKey,
  normalizeJsonObject,
  normalizeRelatedFiles,
  parseOptionalDate,
  type ContextEventType,
  type ContextTrustTier,
  type JsonObject,
} from '../lib/context-capture';

const router = Router();

const ContextEventBodySchema = z.object({
  workspaceId: z.string().trim().min(1),
  eventType: z.enum(CONTEXT_EVENT_TYPES),
  sourceSystem: z.string().trim().min(1),
  sourceRef: z.string().trim().min(1),
  actor: z.string().trim().min(1).optional(),
  occurredAt: z.string().trim().min(1).optional(),
  summary: z.string().default(''),
  payload: z.unknown().optional(),
  provenance: z.unknown().optional(),
  relatedFiles: z.unknown().optional(),
  metadata: z.unknown().optional(),
  trustTier: z.enum(CONTEXT_TRUST_TIERS).default('agent_observation'),
  idempotencyKey: z.string().trim().min(1).max(512).optional(),
  contentHash: z.string().trim().min(1).max(128).optional(),
});

type ContextEventBody = z.infer<typeof ContextEventBodySchema>;

export interface ContextEventResponse {
  id: string;
  workspaceId: string;
  eventType: ContextEventType;
  sourceSystem: string;
  sourceRef: string;
  actor: string | null;
  occurredAt: string;
  summary: string;
  payload: JsonObject;
  provenance: JsonObject;
  relatedFiles: string[];
  metadata: JsonObject;
  trustTier: ContextTrustTier;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

const CONTEXT_EVENT_SELECT = `
  SELECT id::text AS id,
         workspace_id AS "workspaceId",
         event_type AS "eventType",
         source_system AS "sourceSystem",
         source_ref AS "sourceRef",
         actor,
         occurred_at AS "occurredAt",
         summary,
         payload,
         provenance,
         related_files AS "relatedFiles",
         metadata,
         trust_tier AS "trustTier",
         idempotency_key AS "idempotencyKey",
         created_at AS "createdAt",
         updated_at AS "updatedAt"
    FROM context_events`;

function parseBody(req: Request): ContextEventBody {
  const result = ContextEventBodySchema.safeParse(req.body);
  if (!result.success) {
    throw new ValidationError('Invalid context event payload', { issues: result.error.issues });
  }
  return result.data;
}

async function assertWorkspace(workspaceId: string): Promise<void> {
  const workspace = await queryOne<{ id: string }>('SELECT id FROM workspaces WHERE id = $1', [workspaceId]);
  if (!workspace) {
    throw new NotFoundError('Workspace', workspaceId);
  }
}

async function emitContextEventCreated(event: ContextEventResponse, duplicate: boolean): Promise<void> {
  try {
    const walEventType = event.eventType === 'git_commit' ? 'git_commit' : 'context_event_ingested';
    const payload = JSON.stringify({
      contextEventId: event.id,
      eventType: event.eventType,
      sourceSystem: event.sourceSystem,
      sourceRef: event.sourceRef,
      trustTier: event.trustTier,
      duplicate,
      relatedFiles: event.relatedFiles,
      metadata: event.metadata,
    });
    const walEvent = await queryOne<{ id: number }>(
      `INSERT INTO wal_events (event_type, workspace_id, actor, payload)
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING id`,
      [walEventType, event.workspaceId, event.actor ?? 'context-capture', payload],
    );
    if (walEvent) {
      broadcastAll({
        id: walEvent.id,
        event_type: walEventType,
        workspace_id: event.workspaceId,
        spec_id: null,
        story_id: null,
        actor: event.actor ?? 'context-capture',
        payload,
        ts: new Date().toISOString(),
      } as any);
    }
  } catch {
    // Best-effort audit event. The durable context_event row is authoritative.
  }
}

async function findByIdempotencyKey(idempotencyKey: string): Promise<ContextEventResponse | undefined> {
  return queryOne<ContextEventResponse>(
    `${CONTEXT_EVENT_SELECT}
      WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
}

/**
 * @swagger
 * /api/context-events:
 *   post:
 *     tags: [Context Capture]
 *     summary: Ingest a durable context capture event
 *     operationId: createContextEvent
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Sidecar event ingestion is a stable local automation surface; writes only caller-submitted observations and has no operator-only side effects."
 *     x-rorca-public-api: true
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, eventType, sourceSystem, sourceRef]
 *             properties:
 *               workspaceId: { type: string }
 *               eventType: { type: string, enum: [manual_cli_note, manual_note, git_commit, git_range, daemon_scan, pr_merge, incident, duckbrain_import, duckbrain_memory, hermes_event, hermes_session] }
 *               sourceSystem: { type: string }
 *               sourceRef: { type: string }
 *               actor: { type: string }
 *               occurredAt: { type: string, format: date-time }
 *               summary: { type: string }
 *               payload: { type: object }
 *               provenance: { type: object }
 *               relatedFiles: { type: array, items: { type: string } }
 *               metadata: { type: object }
 *               trustTier: { type: string, enum: [agent_observation, working_note, engineering_decision, approved_policy, verified_fact] }
 *               idempotencyKey: { type: string }
 *               contentHash: { type: string }
 *     responses:
 *       201: { description: Created context event }
 *       200: { description: Existing context event returned for an idempotent duplicate submission }
 *       400: { description: Invalid payload }
 *       404: { description: Workspace not found }
 */
router.post('/', async (req: Request, res: Response) => {
  const body = parseBody(req);
  const payload = normalizeJsonObject(body.payload, 'payload');
  const provenance = normalizeJsonObject(body.provenance, 'provenance');
  const relatedFiles = normalizeRelatedFiles(body.relatedFiles);
  const metadata = normalizeJsonObject(body.metadata, 'metadata');
  const occurredAt = parseOptionalDate(body.occurredAt, 'occurredAt') ?? new Date().toISOString();

  await assertWorkspace(body.workspaceId);

  const derived = buildContextEventIdempotencyKey({
    workspaceId: body.workspaceId,
    sourceSystem: body.sourceSystem,
    contentHash: body.contentHash,
    eventType: body.eventType,
    sourceRef: body.sourceRef,
    summary: body.summary,
    payload,
    relatedFiles,
  });
  const idempotencyKey = body.idempotencyKey ?? derived.idempotencyKey;
  const enrichedMetadata = {
    ...metadata,
    contentHash: derived.contentHash,
  };

  const existing = await findByIdempotencyKey(idempotencyKey);
  if (existing) {
    await emitContextEventCreated(existing, true);
    res.status(200).json({ event: existing, created: false, idempotent: true });
    return;
  }

  const inserted = await queryOne<ContextEventResponse>(
    `WITH inserted AS (
        INSERT INTO context_events (
          workspace_id,
          event_type,
          source_system,
          source_ref,
          actor,
          occurred_at,
          summary,
          payload,
          provenance,
          related_files,
          metadata,
          trust_tier,
          idempotency_key
        ) VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13)
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING id
      )
      ${CONTEXT_EVENT_SELECT}
      WHERE id = (SELECT id FROM inserted)`, 
    [
      body.workspaceId,
      body.eventType,
      body.sourceSystem,
      body.sourceRef,
      body.actor ?? null,
      occurredAt,
      body.summary,
      JSON.stringify(payload),
      JSON.stringify(provenance),
      JSON.stringify(relatedFiles),
      JSON.stringify(enrichedMetadata),
      body.trustTier,
      idempotencyKey,
    ],
  );

  if (!inserted) {
    const concurrentExisting = await findByIdempotencyKey(idempotencyKey);
    if (concurrentExisting) {
      await emitContextEventCreated(concurrentExisting, true);
      res.status(200).json({ event: concurrentExisting, created: false, idempotent: true });
      return;
    }
    throw new ValidationError('Failed to create context event');
  }

  await emitContextEventCreated(inserted, false);
  res.status(201).json({ event: inserted, created: true, idempotent: false });
});

export default router;
