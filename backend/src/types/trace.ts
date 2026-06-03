/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ContextTraceRawRef = `ctx:${number}:${number}`;

type OpenString<T extends string> = T | (string & {});

export type ContextTraceCorePhase =
  | 'retrieval'
  | 'arbiter'
  | 'prompt_assembly'
  | 'artifact_write'
  | 'artifact_lifecycle'
  | 'skill'
  | 'mcp'
  | 'memory'
  | 'forge';

export type ContextTracePhase = OpenString<ContextTraceCorePhase>;

export type ContextTraceCoreStatus =
  | 'started'
  | 'progress'
  | 'completed'
  | 'warning'
  | 'failed'
  | 'skipped';

export type ContextTraceStatus = OpenString<ContextTraceCoreStatus>;

export interface ContextTracePhaseDefinition {
  domain: 'backend' | 'skill' | 'mcp' | 'memory' | 'forge';
  description: string;
  rawArtifactExpected: boolean;
}

/**
 * V1 phase taxonomy for backend context traces.
 *
 * Reserved future-facing phases stay in the contract now so consumers can render
 * unknown producers without a breaking schema change.
 */
export const CONTEXT_TRACE_PHASE_TAXONOMY: Readonly<Record<ContextTraceCorePhase, ContextTracePhaseDefinition>> = {
  retrieval: {
    domain: 'backend',
    description: 'Context retrieval and candidate collection before any arbitration or prompt composition.',
    rawArtifactExpected: true,
  },
  arbiter: {
    domain: 'backend',
    description: 'Selection, pruning, and ranking decisions that decide which retrieved context survives.',
    rawArtifactExpected: true,
  },
  prompt_assembly: {
    domain: 'backend',
    description: 'Prompt composition that merges story inputs, direction layers, and chosen context into the final agent payload.',
    rawArtifactExpected: true,
  },
  artifact_write: {
    domain: 'backend',
    description: 'Per-record persistence attempts and write outcomes for raw context trace blobs.',
    rawArtifactExpected: false,
  },
  artifact_lifecycle: {
    domain: 'backend',
    description: 'Writer startup, flush, retention, degradation, and close lifecycle events for consistent operator visibility.',
    rawArtifactExpected: false,
  },
  skill: {
    domain: 'skill',
    description: 'Reserved namespace for future Pi/skill trace producers that extend the same contract.',
    rawArtifactExpected: true,
  },
  mcp: {
    domain: 'mcp',
    description: 'Reserved namespace for future MCP tool trace producers that need the same SSE/artifact envelope.',
    rawArtifactExpected: true,
  },
  memory: {
    domain: 'memory',
    description: 'Reserved namespace for future memory-specific trace producers outside the backend retrieval core.',
    rawArtifactExpected: true,
  },
  forge: {
    domain: 'forge',
    description: 'Reserved namespace for future forge/spec-drafting trace producers using the same event model.',
    rawArtifactExpected: true,
  },
};

export const CONTEXT_TRACE_EVENT_SCHEMA = 'rorca.context-trace-event/v1' as const;
export const CONTEXT_TRACE_ARTIFACT_SCHEMA = 'rorca.context-trace-artifact/v1' as const;
export const CONTEXT_TRACE_ARTIFACT_RECORD_TYPE = 'raw-payload' as const;

export interface ContextTraceRawRefParts {
  runId: number;
  seq: number;
  rawRef: ContextTraceRawRef;
}

export type ContextTraceMetricValue = string | number | boolean | null;
export type ContextTraceMetrics = Record<string, ContextTraceMetricValue>;
export type ContextTraceMetadata = Record<string, JsonValue>;

/**
 * Stable SSE-facing event contract for context engineering trace metadata.
 *
 * `rawRef` always points to the full file-backed raw payload. Consumers should
 * treat `metadata` and phase strings as open for additive evolution.
 */
export interface ContextTraceEvent {
  schema: typeof CONTEXT_TRACE_EVENT_SCHEMA;
  traceId: string;
  runId: number;
  seq: number;
  rawRef: ContextTraceRawRef;
  phase: ContextTracePhase;
  status: ContextTraceStatus;
  ts: string;
  storyId?: string;
  attempt?: number;
  summary?: string;
  metrics?: ContextTraceMetrics;
  metadata?: ContextTraceMetadata;
}

/**
 * Deterministic file-backed record stored in `forge/traces/*.context-trace.ndjson.gz`.
 *
 * Readers can recover the raw payload directly from `payload` without inferring
 * phase-specific shapes, while `event` preserves the exact SSE metadata envelope
 * that referenced the payload.
 */
export interface ContextTraceArtifactRecord {
  schema: typeof CONTEXT_TRACE_ARTIFACT_SCHEMA;
  recordType: typeof CONTEXT_TRACE_ARTIFACT_RECORD_TYPE;
  rawRef: ContextTraceRawRef;
  runId: number;
  seq: number;
  traceId: string;
  phase: ContextTracePhase;
  status: ContextTraceStatus;
  ts: string;
  storyId?: string;
  payloadFormat: 'json';
  payloadEncoding: 'identity';
  payloadBytes: number;
  event: ContextTraceEvent;
  payload: JsonValue;
}

function isPositiveInteger(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
}

export function formatContextTraceRawRef(runId: number, seq: number): ContextTraceRawRef {
  isPositiveInteger(runId, 'runId');
  isPositiveInteger(seq, 'seq');
  return `ctx:${runId}:${seq}`;
}

export function parseContextTraceRawRef(rawRef: string): ContextTraceRawRefParts | null {
  const match = /^ctx:(\d+):(\d+)$/.exec(rawRef);
  if (!match) return null;

  const runId = Number.parseInt(match[1], 10);
  const seq = Number.parseInt(match[2], 10);
  if (!Number.isInteger(runId) || runId <= 0 || !Number.isInteger(seq) || seq <= 0) {
    return null;
  }

  return {
    runId,
    seq,
    rawRef: rawRef as ContextTraceRawRef,
  };
}

export function createContextTraceRefGenerator(runId: number, startSeq = 0): () => ContextTraceRawRefParts {
  isPositiveInteger(runId, 'runId');
  if (!Number.isInteger(startSeq) || startSeq < 0) {
    throw new Error('startSeq must be a non-negative integer');
  }

  let currentSeq = startSeq;
  return () => {
    currentSeq += 1;
    return {
      runId,
      seq: currentSeq,
      rawRef: formatContextTraceRawRef(runId, currentSeq),
    };
  };
}
