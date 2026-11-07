/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

/** HMG-010's closed Hermes gateway family, carried by the canonical WAL/SSE envelope. */
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { query, transaction } from '../db';
import { EntityRefV1Schema } from './mission-contracts';
import { stableWalJson } from './trusted-wal';

export const GATEWAY_EVENT_KINDS = [
  'mission_draft_ready',
  'decision_required',
  'gate_blocked',
  'source_drift',
  'run_completed',
  'release_ready',
] as const;
export type GatewayEventKind = typeof GATEWAY_EVENT_KINDS[number];

const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const boundedId = z.string().min(1).max(256);
const boundedText = z.string().min(1).max(2000);

export const GatewayIdentityV1Schema = z.object({
  workspaceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/),
  mission: EntityRefV1Schema.refine((value) => value.kind === 'mission', 'mission identity must have kind mission'),
  spec: EntityRefV1Schema.refine((value) => value.kind === 'spec'
    && value.revision?.kind === 'spec_version' && /^[1-9]\d*$/.test(value.revision.value),
  'spec identity requires a positive exact spec_version revision'),
  specRevisionHash: sha256,
  run: EntityRefV1Schema.nullable(),
  story: EntityRefV1Schema.nullable(),
  attempt: EntityRefV1Schema.nullable(),
}).strict().superRefine((value, context) => {
  for (const [name, ref] of Object.entries({ mission: value.mission, spec: value.spec, run: value.run, story: value.story, attempt: value.attempt })) {
    if (ref && ref.workspaceId !== value.workspaceId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [name, 'workspaceId'], message: 'gateway identities must belong to one workspace' });
    }
  }
  if (value.run && value.run.kind !== 'run') context.addIssue({ code: z.ZodIssueCode.custom, path: ['run'], message: 'run identity must have kind run' });
  if (value.story && value.story.kind !== 'story') context.addIssue({ code: z.ZodIssueCode.custom, path: ['story'], message: 'story identity must have kind story' });
  if (value.attempt && value.attempt.kind !== 'attempt') context.addIssue({ code: z.ZodIssueCode.custom, path: ['attempt'], message: 'attempt identity must have kind attempt' });
});
export type GatewayIdentityV1 = z.infer<typeof GatewayIdentityV1Schema>;

const DetailSchemas = {
  mission_draft_ready: z.object({ assuranceProfileId: boundedId }).strict(),
  decision_required: z.object({ decisionId: boundedId, question: boundedText }).strict(),
  gate_blocked: z.object({ gateId: boundedId, blockingControlIds: z.array(boundedId).min(1).max(100) }).strict(),
  source_drift: z.object({ previousBundleHash: sha256, currentBundleHash: sha256 }).strict(),
  run_completed: z.object({ outcome: z.enum(['succeeded', 'failed', 'cancelled']), evidenceBundleId: boundedId.nullable() }).strict(),
  release_ready: z.object({ releaseId: boundedId, evidenceBundleId: boundedId }).strict(),
} as const;

const base = {
  schemaVersion: z.literal('rorca.gateway-event.v1'),
  eventId: sha256,
  idempotencyKey: sha256,
  sourceEventId: boundedId,
  sequence: z.number().int().positive(),
  occurredAt: z.string().datetime({ offset: true }),
  identity: GatewayIdentityV1Schema,
  summary: boundedText,
};

export const GatewayEventV1Schema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('mission_draft_ready'), details: DetailSchemas.mission_draft_ready }).strict(),
  z.object({ ...base, kind: z.literal('decision_required'), details: DetailSchemas.decision_required }).strict(),
  z.object({ ...base, kind: z.literal('gate_blocked'), details: DetailSchemas.gate_blocked }).strict(),
  z.object({ ...base, kind: z.literal('source_drift'), details: DetailSchemas.source_drift }).strict(),
  z.object({ ...base, kind: z.literal('run_completed'), details: DetailSchemas.run_completed }).strict(),
  z.object({ ...base, kind: z.literal('release_ready'), details: DetailSchemas.release_ready }).strict(),
]);
export type GatewayEventV1 = z.infer<typeof GatewayEventV1Schema>;

export type GatewayEventInput = {
  [K in GatewayEventKind]: Readonly<{
    kind: K;
    sourceEventId: string;
    occurredAt: string;
    identity: GatewayIdentityV1;
    summary: string;
    details: z.input<(typeof DetailSchemas)[K]>;
  }>;
}[GatewayEventKind];

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function gatewaySourceKey(input: GatewayEventInput): string {
  return digest(stableWalJson({ kind: input.kind, sourceEventId: input.sourceEventId, identity: input.identity }));
}

export function gatewayWalEventType(payload: Pick<GatewayEventV1, 'kind'>): `gateway.${GatewayEventKind}` {
  return `gateway.${payload.kind}`;
}

export function projectGatewayEvent(input: GatewayEventInput, sequence: number): GatewayEventV1 {
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new TypeError('gateway sequence must be positive');
  const idempotencyKey = gatewaySourceKey(input);
  return GatewayEventV1Schema.parse({
    schemaVersion: 'rorca.gateway-event.v1',
    eventId: digest(idempotencyKey),
    idempotencyKey,
    sourceEventId: input.sourceEventId,
    sequence,
    occurredAt: input.occurredAt,
    kind: input.kind,
    identity: input.identity,
    summary: input.summary,
    details: input.details,
  });
}

interface PersistedRow { wal_event_id: number; sequence: number; payload: Record<string, unknown> | string }
function parsedPayload(row: PersistedRow): GatewayEventV1 {
  return GatewayEventV1Schema.parse(typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload);
}

/** Transactional gateway projection. wal_events remains the sole replay/live transport. */
export class PgGatewayEventWriter {
  async append(input: GatewayEventInput): Promise<Readonly<{ payload: GatewayEventV1; duplicate: boolean; walEventId: number }>> {
    return transaction(async (client: PoolClient) => {
      const sourceKey = gatewaySourceKey(input);
      const streamKey = `${input.identity.workspaceId}:${input.identity.mission.id}`;
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [streamKey]);
      const existing = (await client.query<PersistedRow>(
        'SELECT wal_event_id, sequence, payload FROM gateway_events WHERE source_key=$1 FOR UPDATE', [sourceKey],
      )).rows[0];
      if (existing) return { payload: parsedPayload(existing), duplicate: true, walEventId: Number(existing.wal_event_id) };
      const next = (await client.query<{ sequence: string }>(
        'SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM gateway_events WHERE workspace_id=$1 AND mission_id=$2',
        [input.identity.workspaceId, input.identity.mission.id],
      )).rows[0];
      const payload = projectGatewayEvent(input, Number(next.sequence));
      const wal = (await client.query<{ id: number }>(`
        INSERT INTO wal_events(event_type, workspace_id, spec_id, story_id, actor, payload, ingest_key)
        VALUES($1,$2,$3,$4,'hermes-gateway',$5::jsonb,$6)
        ON CONFLICT (ingest_key) WHERE ingest_key IS NOT NULL DO NOTHING RETURNING id
      `, [gatewayWalEventType(payload), payload.identity.workspaceId, payload.identity.spec.id,
        payload.identity.story?.id ?? null, JSON.stringify(payload), `hermes-gateway:v1:${sourceKey}`])).rows[0];
      if (!wal) {
        const replay = (await client.query<PersistedRow>('SELECT wal_event_id, sequence, payload FROM gateway_events WHERE source_key=$1', [sourceKey])).rows[0];
        if (!replay) throw new Error('gateway WAL replay exists without its durable projection');
        return { payload: parsedPayload(replay), duplicate: true, walEventId: Number(replay.wal_event_id) };
      }
      await client.query(`
        INSERT INTO gateway_events(source_key, sequence, wal_event_id, event_kind, workspace_id, mission_id, spec_id, spec_version, spec_hash, run_id, story_id, attempt_id, payload)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
      `, [sourceKey, payload.sequence, wal.id, payload.kind, payload.identity.workspaceId, payload.identity.mission.id,
        payload.identity.spec.id, Number(payload.identity.spec.revision!.value), payload.identity.specRevisionHash,
        payload.identity.run?.id ?? null, payload.identity.story?.id ?? null, payload.identity.attempt?.id ?? null, JSON.stringify(payload)]);
      return { payload, duplicate: false, walEventId: Number(wal.id) };
    });
  }

  async replay(workspaceId: string, missionId: string): Promise<readonly GatewayEventV1[]> {
    const rows = await query<PersistedRow>(
      'SELECT wal_event_id, sequence, payload FROM gateway_events WHERE workspace_id=$1 AND mission_id=$2 ORDER BY sequence',
      [workspaceId, missionId],
    );
    return Object.freeze(rows.map(parsedPayload));
  }
}

/** Compile-time guard: gateway transport payloads never alias the permitted-action descriptor. */
export type _GatewayPayloadIsNotActionEnvelope = GatewayEventV1 extends { schemaVersion: 'rorca.action-envelope.v1' } ? never : true;
