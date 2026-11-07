/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

/** Provider-neutral projection of the real OMP JSONL-RPC event stream. */
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { query, transaction } from '../db';
import {
  EntityRefV1Schema, MISSION_CONTRACT_VERSIONS, type EntityRefV1,
} from './mission-contracts';
import { stableWalJson } from './trusted-wal';
import type { ManagedEngineRequest } from './rorca-managed-executor';

export const ORCHESTRATION_EVENT_KINDS = [
  'agent_started', 'task_started', 'agent_progress', 'agent_completed', 'agent_failed',
] as const;
export type OrchestrationEventKind = typeof ORCHESTRATION_EVENT_KINDS[number];

const OmpSourceSchema = z.object({
  provider: z.literal('omp'),
  rpcType: z.string().min(1).max(160),
  sourceEventId: z.string().min(1).max(256),
  parentEventId: z.string().min(1).max(256).nullable(),
  agentId: z.string().min(1).max(256).nullable(),
  parentAgentId: z.string().min(1).max(256).nullable(),
  taskId: z.string().min(1).max(256).nullable(),
  raw: z.record(z.string(), z.unknown()),
}).strict();

export const OrchestrationEventV1Schema = z.object({
  schemaVersion: z.literal('rorca.orchestration-event.v1'),
  eventId: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  idempotencyKey: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  kind: z.enum(ORCHESTRATION_EVENT_KINDS).nullable(),
  sequence: z.number().int().positive(),
  observedAt: z.string().datetime({ offset: true }),
  run: EntityRefV1Schema,
  story: EntityRefV1Schema,
  attempt: EntityRefV1Schema,
  process: EntityRefV1Schema,
  spec: EntityRefV1Schema,
  specRevisionHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  parentEventId: z.string().min(1).max(256).nullable(),
  omp: OmpSourceSchema,
}).strict();
export type OrchestrationEventV1 = z.infer<typeof OrchestrationEventV1Schema>;

export interface OmpOrchestrationInput {
  readonly request: ManagedEngineRequest;
  readonly processIdentity: string;
  readonly sourceOrdinal: number;
  readonly event: unknown;
  readonly observedAt: string;
}

export interface OrchestrationEventWriter {
  append(input: OmpOrchestrationInput): Promise<Readonly<{ payload: OrchestrationEventV1; duplicate: boolean; walEventId?: number }>>;
}

function bounded(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 256) : null;
}

function nestedRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function firstString(record: Record<string, unknown>, names: readonly string[]): string | null {
  for (const name of names) {
    const value = bounded(record[name]);
    if (value) return value;
  }
  return null;
}

export function orchestrationWalEventType(payload: Pick<OrchestrationEventV1, 'kind'>): string {
  return `orchestration.${payload.kind ?? 'unknown'}`;
}

export function mapOmpRpcType(type: string): OrchestrationEventKind | null {
  if (['agent_start', 'agent_started'].includes(type)) return 'agent_started';
  if (['turn_start', 'task_start', 'task_started', 'tool_execution_start'].includes(type)) return 'task_started';
  if (['message_update', 'agent_progress', 'tool_execution_update', 'tool_execution_end', 'turn_end'].includes(type)) return 'agent_progress';
  if (['agent_end', 'agent_completed', 'agent_settled'].includes(type)) return 'agent_completed';
  if (['error', 'agent_failed'].includes(type)) return 'agent_failed';
  return null;
}

function parent(kind: EntityRefV1['kind'], id: string, workspaceId: string, label: string, revision?: EntityRefV1['revision']) {
  return { workspaceId, kind, id, label, ...(revision ? { revision } : {}) };
}

function entityRefs(request: ManagedEngineRequest, processIdentity: string): Pick<OrchestrationEventV1, 'run' | 'story' | 'attempt' | 'process' | 'spec'> {
  const workspaceId = request.workspaceId;
  const specRevision = { kind: 'spec_version' as const, value: String(request.specVersion) };
  const spec: EntityRefV1 = {
    schemaVersion: MISSION_CONTRACT_VERSIONS.entityRef, workspaceId, kind: 'spec', id: request.specId,
    revision: specRevision, label: request.specId,
  };
  const run: EntityRefV1 = {
    schemaVersion: MISSION_CONTRACT_VERSIONS.entityRef, workspaceId, kind: 'run', id: String(request.runId),
    parent: parent('spec', request.specId, workspaceId, request.specId, specRevision), label: `Run ${String(request.runId)}`,
  };
  const story: EntityRefV1 = {
    schemaVersion: MISSION_CONTRACT_VERSIONS.entityRef, workspaceId, kind: 'story', id: request.storyId,
    revision: { kind: 'version', value: String(request.storyVersion) },
    parent: parent('run', String(request.runId), workspaceId, `Run ${String(request.runId)}`), label: request.storyId,
  };
  const attempt: EntityRefV1 = {
    schemaVersion: MISSION_CONTRACT_VERSIONS.entityRef, workspaceId, kind: 'attempt', id: request.attemptId,
    revision: { kind: 'version', value: String(request.generation) },
    parent: parent('story', request.storyId, workspaceId, request.storyId, story.revision), label: request.attemptId,
  };
  const process: EntityRefV1 = {
    schemaVersion: MISSION_CONTRACT_VERSIONS.entityRef, workspaceId, kind: 'process', id: processIdentity,
    parent: parent('attempt', request.attemptId, workspaceId, request.attemptId, attempt.revision), label: 'OMP managed process',
  };
  return { run, story, attempt, process, spec };
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function ompSourceKey(input: OmpOrchestrationInput): string {
  return digest(stableWalJson({ requestHash: input.request.requestHash, sourceOrdinal: input.sourceOrdinal, event: input.event }));
}

export function projectOmpOrchestrationEvent(input: OmpOrchestrationInput, sequence: number): OrchestrationEventV1 {
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new TypeError('orchestration sequence must be positive');
  const raw = nestedRecord(input.event) ?? { value: input.event };
  const type = bounded(raw.type) ?? 'unknown';
  const nested = nestedRecord(raw.event) ?? nestedRecord(raw.data) ?? {};
  const sourceEventId = firstString(raw, ['eventId', 'event_id', 'id'])
    ?? firstString(nested, ['eventId', 'event_id', 'id'])
    ?? ompSourceKey(input);
  const parentEventId = firstString(raw, ['parentEventId', 'parent_event_id', 'parentId', 'parent_id'])
    ?? firstString(nested, ['parentEventId', 'parent_event_id', 'parentId', 'parent_id']);
  const agentId = firstString(raw, ['agentId', 'agent_id']) ?? firstString(nested, ['agentId', 'agent_id']);
  const parentAgentId = firstString(raw, ['parentAgentId', 'parent_agent_id']) ?? firstString(nested, ['parentAgentId', 'parent_agent_id']);
  const taskId = firstString(raw, ['taskId', 'task_id', 'toolCallId', 'tool_call_id']) ?? firstString(nested, ['taskId', 'task_id', 'toolCallId', 'tool_call_id']);
  const idempotencyKey = ompSourceKey(input);
  return OrchestrationEventV1Schema.parse({
    schemaVersion: 'rorca.orchestration-event.v1', eventId: digest(`${input.request.requestHash}:${sourceEventId}`),
    idempotencyKey, kind: mapOmpRpcType(type), sequence, observedAt: input.observedAt,
    ...entityRefs(input.request, input.processIdentity), specRevisionHash: input.request.specHash,
    parentEventId, omp: { provider: 'omp', rpcType: type, sourceEventId, parentEventId, agentId, parentAgentId, taskId, raw },
  });
}

interface PersistedRow { wal_event_id: number; sequence: number; payload: Record<string, unknown> | string }
function parsedPayload(row: PersistedRow): OrchestrationEventV1 {
  return OrchestrationEventV1Schema.parse(typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload);
}

/** PostgreSQL implementation: one stream lock makes sequence allocation restart-safe. */
export class PgOrchestrationEventWriter implements OrchestrationEventWriter {
  async append(input: OmpOrchestrationInput): Promise<Readonly<{ payload: OrchestrationEventV1; duplicate: boolean; walEventId: number }>> {
    return transaction(async (client: PoolClient) => {
      const sourceKey = ompSourceKey(input);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [input.request.requestHash]);
      const existing = (await client.query<PersistedRow>(
        'SELECT wal_event_id, sequence, payload FROM orchestration_events WHERE source_key = $1 FOR UPDATE', [sourceKey],
      )).rows[0];
      if (existing) return { payload: parsedPayload(existing), duplicate: true, walEventId: Number(existing.wal_event_id) };
      const next = (await client.query<{ sequence: string }>(
        'SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM orchestration_events WHERE request_hash = $1', [input.request.requestHash],
      )).rows[0];
      const payload = projectOmpOrchestrationEvent(input, Number(next.sequence));
      const eventType = orchestrationWalEventType(payload);
      const wal = (await client.query<{ id: number }>(`
        INSERT INTO wal_events(event_type, workspace_id, spec_id, story_id, actor, payload, ingest_key)
        VALUES($1,$2,$3,$4,'omp-managed-executor',$5::jsonb,$6)
        ON CONFLICT (ingest_key) WHERE ingest_key IS NOT NULL DO NOTHING RETURNING id
      `, [eventType, input.request.workspaceId, input.request.specId, input.request.storyId, JSON.stringify(payload), `omp-orchestration:v1:${sourceKey}`])).rows[0];
      if (!wal) {
        const replay = (await client.query<PersistedRow>('SELECT wal_event_id, sequence, payload FROM orchestration_events WHERE source_key = $1', [sourceKey])).rows[0];
        if (!replay) throw new Error('orchestration WAL replay exists without its durable projection');
        return { payload: parsedPayload(replay), duplicate: true, walEventId: Number(replay.wal_event_id) };
      }
      await client.query(`
        INSERT INTO orchestration_events(source_key, request_hash, sequence, wal_event_id, run_id, story_id, attempt_id, process_identity, spec_id, spec_version, spec_hash, rpc_type, mapped_kind, payload)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)
      `, [sourceKey, input.request.requestHash, payload.sequence, wal.id, String(input.request.runId), input.request.storyId,
        input.request.attemptId, input.processIdentity, input.request.specId, input.request.specVersion, input.request.specHash,
        payload.omp.rpcType, payload.kind, JSON.stringify(payload)]);
      return { payload, duplicate: false, walEventId: Number(wal.id) };
    });
  }

  async replay(requestHash: string): Promise<readonly OrchestrationEventV1[]> {
    const rows = await query<PersistedRow>('SELECT wal_event_id, sequence, payload FROM orchestration_events WHERE request_hash = $1 ORDER BY sequence', [requestHash]);
    return Object.freeze(rows.map(parsedPayload));
  }
}
