/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import { query } from '../db';
import { GATEWAY_EVENT_KINDS, type GatewayEventKind } from './gateway-events';
import { subscribe, type WalEvent } from './sse-hub';

export const RUN_EVENT_SUBSCRIPTION_TOOL_NAMES = [
  'rorca_subscribe_run_events',
  'rorca_unsubscribe_run_events',
] as const;

export type RunEventFamily = 'run' | 'story' | 'gate' | 'evidence' | 'orchestration' | 'gateway';

export interface RunEventDispatchV1 {
  schemaVersion: 'rorca.run-event-dispatch.v1';
  toolName: 'rorca_subscribe_run_events';
  family: RunEventFamily;
  payloadSchemaVersion: string | number | null;
  /** The unchanged canonical WAL/SSE envelope. */
  event: WalEvent;
}

export type ReplayRunEvents = (workspaceId: string, afterEventId: number) => Promise<readonly WalEvent[]>;
export type DeliverRunEvent = (dispatch: RunEventDispatchV1) => Promise<void> | void;

const GATEWAY_EVENT_TYPES: ReadonlySet<string> = new Set(
  GATEWAY_EVENT_KINDS.map((kind: GatewayEventKind) => `gateway.${kind}`),
);

export function runEventFamily(eventType: string): RunEventFamily | null {
  if (eventType.startsWith('orchestration.')) return 'orchestration';
  if (GATEWAY_EVENT_TYPES.has(eventType)) return 'gateway';
  if (eventType === 'run' || eventType.startsWith('run_') || eventType.startsWith('run.')) return 'run';
  if (eventType === 'story' || eventType.startsWith('story_') || eventType.startsWith('story.')) return 'story';
  if (eventType === 'gate' || eventType.startsWith('gate_') || eventType.startsWith('gate.')) return 'gate';
  if (eventType === 'evidence' || eventType.startsWith('evidence_') || eventType.startsWith('evidence.')) return 'evidence';
  return null;
}

function payloadVersion(payload: WalEvent['payload']): string | number | null {
  if (payload === null) return null;
  try {
    const value: unknown = typeof payload === 'string' ? JSON.parse(payload) : payload;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const version = record.schemaVersion ?? record.schema_version;
    return typeof version === 'string' || typeof version === 'number' ? version : null;
  } catch {
    return null;
  }
}

export function toRunEventDispatch(event: WalEvent): RunEventDispatchV1 | null {
  const family = runEventFamily(event.event_type);
  if (!family) return null;
  return {
    schemaVersion: 'rorca.run-event-dispatch.v1',
    toolName: 'rorca_subscribe_run_events',
    family,
    payloadSchemaVersion: payloadVersion(event.payload),
    event,
  };
}

/** Canonical replay source. Live delivery and replay both return the WAL/SSE row shape. */
export async function replayRunEvents(workspaceId: string, afterEventId: number): Promise<readonly WalEvent[]> {
  return query<WalEvent>(`
    SELECT * FROM wal_events
    WHERE workspace_id = $1 AND id > $2
      AND (event_type = 'run' OR event_type LIKE 'run\\_%' ESCAPE '\\' OR event_type LIKE 'run.%'
        OR event_type = 'story' OR event_type LIKE 'story\\_%' ESCAPE '\\' OR event_type LIKE 'story.%'
        OR event_type = 'gate' OR event_type LIKE 'gate\\_%' ESCAPE '\\' OR event_type LIKE 'gate.%'
        OR event_type = 'evidence' OR event_type LIKE 'evidence\\_%' ESCAPE '\\' OR event_type LIKE 'evidence.%'
        OR event_type LIKE 'orchestration.%' OR event_type = ANY($3::text[]))
    ORDER BY id ASC
  `, [workspaceId, afterEventId, [...GATEWAY_EVENT_TYPES]]);
}

/**
 * Session-scoped bridge from the canonical WAL/SSE hub to MCP notifications.
 * It attaches live delivery before loading replay, buffers the race window, and
 * advances one monotonic WAL cursor so replay/live overlap is idempotent.
 */
export class RunEventSubscription {
  private unsubscribeLive: (() => void) | null = null;
  private replaying = false;
  private buffered: WalEvent[] = [];
  private cursor = 0;
  private delivery = Promise.resolve();

  constructor(
    private readonly workspaceId: string,
    private readonly replay: ReplayRunEvents,
    private readonly deliver: DeliverRunEvent,
  ) {}

  async start(afterEventId = 0): Promise<{ workspaceId: string; cursor: number; canonicalToolNames: readonly string[] }> {
    if (!Number.isSafeInteger(afterEventId) || afterEventId < 0) throw new TypeError('afterEventId must be a non-negative safe integer');
    this.stop();
    this.cursor = afterEventId;
    this.replaying = true;
    this.unsubscribeLive = subscribe((event) => {
      if (event.workspace_id !== this.workspaceId || !runEventFamily(event.event_type)) return;
      if (this.replaying) this.buffered.push(event);
      else this.enqueue(event);
    });

    try {
      const replayed = await this.replay(this.workspaceId, afterEventId);
      for (const event of replayed) this.enqueue(event);
      this.replaying = false;
      for (const event of this.buffered.sort((a, b) => a.id - b.id)) this.enqueue(event);
      this.buffered = [];
      await this.delivery;
      return { workspaceId: this.workspaceId, cursor: this.cursor, canonicalToolNames: RUN_EVENT_SUBSCRIPTION_TOOL_NAMES };
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop(): void {
    this.unsubscribeLive?.();
    this.unsubscribeLive = null;
    this.replaying = false;
    this.buffered = [];
  }

  private enqueue(event: WalEvent): void {
    if (event.workspace_id !== this.workspaceId || event.id <= this.cursor) return;
    const dispatch = toRunEventDispatch(event);
    if (!dispatch) return;
    // Claim synchronously so replay/live overlap cannot enqueue the same ID.
    this.cursor = event.id;
    this.delivery = this.delivery.then(() => this.deliver(dispatch));
  }
}
