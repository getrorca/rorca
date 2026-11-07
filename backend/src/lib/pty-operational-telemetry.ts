/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { execute } from '../db/index';
import {
  safePtyTelemetryLabels,
  safePtyTelemetryMeasurements,
  type PtyByteClass,
  type PtyTelemetryComponent,
} from './context-safety';
import { logger } from './logger';
import { broadcastTopic } from './sse-hub';

export const PTY_OPERATIONS_HEALTH_TOPIC = 'pty-operations:health';

export interface PtyTelemetryIdentity {
  generationId: string;
  runId: number;
  storyId: string;
}

let lastReplayLatencyMs: number | null = null;

export function recordPtyReplayLatency(latencyMs: number): void {
  if (Number.isFinite(latencyMs) && latencyMs >= 0) lastReplayLatencyMs = latencyMs;
}

export function getLastPtyReplayLatencyMs(): number | null {
  return lastReplayLatencyMs;
}

/**
 * Emit one content-free byte accounting event. Identity is used only for the
 * existing relational foreign keys and is never copied into labels or SSE.
 */
export function recordPtyByteTelemetry(
  identity: PtyTelemetryIdentity,
  byteClass: PtyByteClass,
  component: PtyTelemetryComponent,
  byteCount: number,
  measurements: Record<string, unknown> = {},
): void {
  const boundedCount = Number.isFinite(byteCount) ? Math.max(0, Math.floor(byteCount)) : 0;
  if (boundedCount === 0) return;
  const labels = safePtyTelemetryLabels(byteClass, component);
  const safeMeasurements = safePtyTelemetryMeasurements(measurements);
  const publicEvent = {
    event: 'byte_accounting' as const,
    labels,
    byte_count: boundedCount,
    measurements: safeMeasurements,
    occurred_at: new Date().toISOString(),
  };

  // Do not write per-chunk accounting to process stdout: engine stdout is itself
  // captured as PTY output, so logging this event would recursively create more
  // output chunks and telemetry. The bounded SSE topic and durable row remain
  // the observable operational surfaces.
  broadcastTopic(PTY_OPERATIONS_HEALTH_TOPIC, publicEvent);
  void execute(
    `INSERT INTO pty_capture_telemetry
      (generation_id, run_id, story_id, event_type, details, byte_class, byte_count)
     VALUES ($1, $2, $3, 'byte_accounting', $4::jsonb, $5, $6)`,
    [identity.generationId, identity.runId, identity.storyId,
      JSON.stringify({ labels, measurements: safeMeasurements }), labels.byte_class, boundedCount],
  ).catch((error: unknown) => {
    logger.warn({ error, byteClass, component }, '[pty-operations] durable byte telemetry unavailable');
  });
}

export function publishPtyOperationsHealthEvent(payload: Record<string, unknown>): void {
  // Callers construct this from numeric aggregates and closed feature/schema
  // states. It intentionally has no run, story, generation, token, path, or text.
  broadcastTopic(PTY_OPERATIONS_HEALTH_TOPIC, payload);
}
