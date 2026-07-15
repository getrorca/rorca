/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * retrieval-trace.ts — US-018 retrieval trace persistence, redaction, and retrieval.
 *
 * Persists replayable retrieval traces for debugging and quality evaluation.
 * Every trace is redacted before storage: sensitive values (large raw content,
 * secrets, tokens) are stripped or truncated so traces are safe to store and
 * share for offline analysis.
 *
 * Functions:
 *   - redactRetrievalTrace()  — strip sensitive data from a trace payload
 *   - persistRetrievalTrace() — validate and insert a trace into retrieval_traces
 *   - getRetrievalTrace()     — retrieve a trace by ID
 *   - listRetrievalTraces()   — list traces for a workspace
 */

import { execute, query, queryOne } from '../db';
import { logger } from './logger';
import { NotFoundError, ValidationError } from './errors';
import { retrievalTrace, type RetrievalTrace, type RetrievalCandidate } from './retrieval-contracts';
import {
  getContextLimits,
  assertPayloadWithinCap,
  assertCandidateWithinCap,
  byteLength,
} from './context-limits';

// ════════════════════════════════════════════════════════════════════════════
// Redaction constants
// ════════════════════════════════════════════════════════════════════════════

/** Maximum length of a candidate's `reason` field after redaction. */
const MAX_REASON_LENGTH = 500;

/** Maximum number of candidates preserved in a trace (bounds payload size). */
const MAX_CANDIDATES_IN_TRACE = 100;

/** Maximum length of a candidate's `title` field after redaction. */
const MAX_TITLE_LENGTH = 200;

/** Patterns that indicate sensitive content in candidate text/ref fields. */
const SENSITIVE_PATTERNS = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
  /sk-[a-zA-Z0-9]{20,}/,
  /(?:api[_-]?key|apikey|secret|token|password|passwd)=['"]?[^\s'"]{8,}['"]?/gi,
  /(?:AKIA|ASIA)[A-Z0-9]{16}/, // AWS access keys
  /ghp_[a-zA-Z0-9]{36}/, // GitHub personal access tokens
  /xox[bpras]-[a-zA-Z0-9-]+/, // Slack tokens
  /(?:mongodb|postgres|mysql|redis):\/\/[^@\s]+:[^@\s]+@/, // DB connection strings
  /Bearer\s+[a-zA-Z0-9._\-]{20,}/,
];

/**
 * Redact sensitive values from a string.
 * Replaces matched secrets with `[REDACTED]` and truncates overly long content.
 */
export function redactSensitiveString(value: string, maxLength: number = 2000): string {
  let result = value;

  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }

  if (result.length > maxLength) {
    result = result.slice(0, maxLength - 12) + '…[truncated]';
  }

  return result;
}

/**
 * Redact a single retrieval candidate for trace persistence.
 * Strips sensitive data and truncates large fields while preserving
 * scoring, breakdowns, and provenance metadata.
 */
export function redactCandidate(candidate: RetrievalCandidate): RetrievalCandidate {
  return {
    ...candidate,
    title: candidate.title ? redactSensitiveString(candidate.title, MAX_TITLE_LENGTH) : undefined,
    reason: candidate.reason ? redactSensitiveString(candidate.reason, MAX_REASON_LENGTH) : undefined,
    // ref is the path/id reference — keep it but redact any secrets in path names
    ref: redactSensitiveString(candidate.ref, 1000),
  };
}

/**
 * Redact a full retrieval trace for safe persistence.
 *
 * Redaction rules:
 *  - Each candidate's title/reason/ref are redacted for sensitive patterns
 *  - Large candidate text is NOT stored in the trace (candidates carry only
 *    scoring metadata, not raw content — raw content lives in memories table)
 *  - Candidate count is capped at MAX_CANDIDATES_IN_TRACE
 *  - Policy and graph metadata are preserved as-is (no sensitive data)
 *
 * Returns a new trace object — the original is never mutated.
 */
export function redactRetrievalTrace(trace: RetrievalTrace): RetrievalTrace {
  const candidates = trace.candidates.slice(0, MAX_CANDIDATES_IN_TRACE);

  return {
    ...trace,
    candidates: candidates.map(redactCandidate),
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Persistence
// ════════════════════════════════════════════════════════════════════════════

export interface PersistRetrievalTraceInput {
  traceId: string;
  workspaceId: string;
  briefHash: string;
  gitSha?: string;
  policy?: string;
  graphMode?: 'full' | 'lite' | 'disabled';
  degraded?: boolean;
  candidates: RetrievalCandidate[];
  tokenEstimate?: number;
}

/**
 * Validate a retrieval trace payload against the shared contract,
 * redact it, and persist it to the `retrieval_traces` table.
 *
 * Returns the redacted trace that was stored.
 * Throws ValidationError if the payload fails contract validation.
 */
export async function persistRetrievalTrace(input: PersistRetrievalTraceInput): Promise<RetrievalTrace> {
  // Build the trace object
  const now = new Date().toISOString();
  const raw: RetrievalTrace = {
    schemaVersion: 'v1' as const,
    traceId: input.traceId,
    workspaceId: input.workspaceId,
    briefHash: input.briefHash,
    gitSha: input.gitSha,
    createdAt: now,
    policy: input.policy,
    graphMode: input.graphMode,
    degraded: input.degraded,
    candidates: input.candidates,
    tokenEstimate: input.tokenEstimate,
  };

  // Validate against the shared contract
  const parsed = retrievalTrace.safeParse(raw);
  if (!parsed.success) {
    const messages = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ValidationError(`Retrieval trace validation failed: ${messages}`);
  }

  // Redact sensitive values
  const redacted = redactRetrievalTrace(parsed.data);
  const candidateCount = redacted.candidates.length;

  // Enforce payload caps with actionable errors (US-039). Redaction already
  // bounds candidate count and per-field length; here we additionally guard the
  // per-candidate and whole-trace serialized byte sizes so a pathological large
  // external repo cannot persist an unbounded JSONB blob.
  const limits = getContextLimits();
  for (const candidate of redacted.candidates) {
    assertCandidateWithinCap(candidate, candidate.ref || candidate.id || 'unknown', limits);
  }
  const serialized = JSON.stringify(redacted);
  assertPayloadWithinCap(
    byteLength(serialized),
    limits.maxTracePayloadBytes,
    'Retrieval trace',
    'Lower the candidate count or excerpt sizes (RORCA_RETRIEVAL_MAX_CANDIDATES / RORCA_TRACE_MAX_PAYLOAD_BYTES) and retry.',
  );

  // Count selected candidates (those with a non-drop decision).
  // The retrievalTrace contract doesn't have a dedicated "selected" field per candidate,
  // so we count all candidates — in practice the trace captures the full candidate set
  // and the consumer determines selection by position/scoring.
  const selectedCount = candidateCount;

  // Persist to DB
  try {
    await execute(
      `INSERT INTO retrieval_traces (
         trace_id,
         workspace_id,
         brief_hash,
         git_sha,
         policy,
         graph_mode,
         degraded,
         candidate_count,
         selected_count,
         token_estimate,
         payload,
         created_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
       ON CONFLICT (trace_id) DO UPDATE SET
         workspace_id = EXCLUDED.workspace_id,
         brief_hash = EXCLUDED.brief_hash,
         git_sha = EXCLUDED.git_sha,
         policy = EXCLUDED.policy,
         graph_mode = EXCLUDED.graph_mode,
         degraded = EXCLUDED.degraded,
         candidate_count = EXCLUDED.candidate_count,
         selected_count = EXCLUDED.selected_count,
         token_estimate = EXCLUDED.token_estimate,
         payload = EXCLUDED.payload,
         created_at = EXCLUDED.created_at`,
      [
        redacted.traceId,
        redacted.workspaceId,
        redacted.briefHash,
        redacted.gitSha ?? null,
        redacted.policy ?? null,
        redacted.graphMode ?? null,
        redacted.degraded ?? false,
        candidateCount,
        selectedCount,
        redacted.tokenEstimate ?? null,
        serialized,
        redacted.createdAt,
      ],
    );

    logger.debug(
      { traceId: redacted.traceId, workspaceId: redacted.workspaceId, candidateCount },
      '[retrieval-trace] trace persisted',
    );
  } catch (err: any) {
    if (err?.code !== '42P01') {
      logger.error({ err, traceId: redacted.traceId }, '[retrieval-trace] failed to persist trace');
    }
    throw err;
  }

  return redacted;
}

/**
 * Link a retrieval trace to a spec generation log.
 * Appends the traceId to the log's `retrieval_trace_ids` array.
 */
export async function linkTraceToSpecLog(traceId: string, specLogId: number): Promise<void> {
  try {
    await execute(
      `UPDATE spec_generation_logs
       SET retrieval_trace_ids = COALESCE(retrieval_trace_ids, '{}'::text[]) || $1::text
       WHERE id = $2
         AND NOT (COALESCE(retrieval_trace_ids, '{}'::text[]) @> ARRAY[$1]::text[])`,
      [traceId, specLogId],
    );
    logger.debug({ traceId, specLogId }, '[retrieval-trace] linked trace to spec log');
  } catch (err: any) {
    if (err?.code !== '42P01' && err?.code !== '42703') {
      logger.debug({ err, traceId, specLogId }, '[retrieval-trace] failed to link trace to spec log');
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Retrieval
// ════════════════════════════════════════════════════════════════════════════

interface PersistedTraceRow {
  trace_id: string;
  workspace_id: string;
  brief_hash: string;
  git_sha: string | null;
  policy: string | null;
  graph_mode: 'full' | 'lite' | 'disabled' | null;
  degraded: boolean;
  candidate_count: number;
  selected_count: number;
  token_estimate: number | null;
  payload: unknown;
  created_at: string;
}

/**
 * Retrieve a retrieval trace by its traceId.
 * Returns the deserialized trace payload or throws NotFoundError.
 */
export async function getRetrievalTrace(traceId: string): Promise<RetrievalTrace> {
  const row = await queryOne<PersistedTraceRow>(
    `SELECT
       trace_id,
       workspace_id,
       brief_hash,
       git_sha,
       policy,
       graph_mode,
       degraded,
       candidate_count,
       selected_count,
       token_estimate,
       payload,
       created_at
     FROM retrieval_traces
     WHERE trace_id = $1`,
    [traceId],
  );

  if (!row) {
    throw new NotFoundError('Retrieval trace', traceId);
  }

  // Parse the JSONB payload back into the contract shape
  const payload = row.payload && typeof row.payload === 'object'
    ? (row.payload as Record<string, unknown>)
    : {};

  // Reconstruct the trace from the stored payload
  const trace: RetrievalTrace = {
    schemaVersion: (payload.schemaVersion as RetrievalTrace['schemaVersion']) || 'v1',
    traceId: row.trace_id,
    workspaceId: row.workspace_id,
    briefHash: row.brief_hash,
    gitSha: row.git_sha ?? undefined,
    createdAt: row.created_at,
    policy: row.policy ?? undefined,
    graphMode: (row.graph_mode as RetrievalTrace['graphMode']) ?? undefined,
    degraded: row.degraded ?? undefined,
    candidates: Array.isArray(payload.candidates)
      ? (payload.candidates as RetrievalCandidate[])
      : [],
    tokenEstimate: row.token_estimate ?? undefined,
  };

  return trace;
}

export interface ListRetrievalTracesOptions {
  workspaceId?: string;
  limit?: number;
  offset?: number;
}

export interface ListRetrievalTracesResult {
  traces: RetrievalTrace[];
  total: number;
}

/**
 * List retrieval traces for a workspace, ordered by creation time descending.
 */
export async function listRetrievalTraces(
  options: ListRetrievalTracesOptions = {},
): Promise<ListRetrievalTracesResult> {
  const limit = Math.max(1, Math.min(100, options.limit ?? 20));
  const offset = Math.max(0, options.offset ?? 0);

  try {
    const countRow = await queryOne<{ total: number }>(
      `SELECT COUNT(*)::int AS total
       FROM retrieval_traces
       WHERE ($1::text IS NULL OR workspace_id = $1)`,
      [options.workspaceId ?? null],
    );

    const rows = await query<PersistedTraceRow>(
      `SELECT
         trace_id,
         workspace_id,
         brief_hash,
         git_sha,
         policy,
         graph_mode,
         degraded,
         candidate_count,
         selected_count,
         token_estimate,
         payload,
         created_at
       FROM retrieval_traces
       WHERE ($1::text IS NULL OR workspace_id = $1)
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [options.workspaceId ?? null, limit, offset],
    );

    const traces: RetrievalTrace[] = rows.map((row) => {
      const payload = row.payload && typeof row.payload === 'object'
        ? (row.payload as Record<string, unknown>)
        : {};

      return {
        schemaVersion: (payload.schemaVersion as RetrievalTrace['schemaVersion']) || 'v1',
        traceId: row.trace_id,
        workspaceId: row.workspace_id,
        briefHash: row.brief_hash,
        gitSha: row.git_sha ?? undefined,
        createdAt: row.created_at,
        policy: row.policy ?? undefined,
        graphMode: (row.graph_mode as RetrievalTrace['graphMode']) ?? undefined,
        degraded: row.degraded ?? undefined,
        candidates: Array.isArray(payload.candidates)
          ? (payload.candidates as RetrievalCandidate[])
          : [],
        tokenEstimate: row.token_estimate ?? undefined,
      };
    });

    return {
      traces,
      total: countRow?.total ?? 0,
    };
  } catch (err: any) {
    if (err?.code !== '42P01') {
      logger.debug({ err }, '[retrieval-trace] list failed');
    }
    return { traces: [], total: 0 };
  }
}
