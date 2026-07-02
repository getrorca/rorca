/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { execute, query } from '../db/index';
import type { GraphRagCandidateExplainability, GraphRagScoreContract } from './retrieval-pipeline';
import {
  assertCandidateWithinCap,
  assertPayloadWithinCap,
  byteLength,
  getContextLimits,
} from './context-limits';
import { logger } from './logger';

export interface RetrievalTelemetryCandidate {
  key: string;
  origin: string;
  sourceType?: string;
  finalScore: number;
  semanticRankScore?: number;
  preRerankPosition?: number | null;
  rerankedBy?: 'graph' | 'semantic';
  decision: 'keep' | 'drop' | 'needs-more' | 'conflict';
  freshnessScore: number;
  validatorScore: number;
  graphScore: number;
  historicalScore: number;
  reasons: string[];
  conflictsWith: string[];
  supersededBy?: string;
  scoring?: GraphRagScoreContract;
  explainability?: GraphRagCandidateExplainability;
}

export interface RetrievalTelemetryEvent {
  id: string;
  workspaceId: string;
  createdAt: string;
  queryPreview: string;
  matchedSkills: string[];
  selectedCandidateKeys: string[];
  droppedCandidateKeys: string[];
  needsMoreEvidence: boolean;
  candidateCount: number;
  selectedCount: number;
  tokenBudget: number;
  contradictions: Array<[string, string]>;
  candidates: RetrievalTelemetryCandidate[];
  latencyMs?: number;
  retrievalTier?: 'cache' | 'search' | 'hybrid';
}

export interface RetrievalTelemetryListOptions {
  workspaceId?: string;
  limit?: number;
}

export interface RetrievalTelemetryAggregateSummary {
  totalEvents: number;
  avgCandidateCount: number;
  avgSelectedCount: number;
  avgLatencyMs: number;
  avgTokenBudget: number;
  needsMoreEvidenceRate: number;
  contradictionRate: number;
  tierCounts: {
    cache: number;
    search: number;
    hybrid: number;
  };
  topMatchedSkills: Array<{
    skill: string;
    count: number;
  }>;
}

interface PersistedTelemetryRow {
  id: string;
  workspace_id: string;
  created_at: string;
  query_preview: string;
  matched_skills: unknown;
  selected_candidate_keys: unknown;
  dropped_candidate_keys: unknown;
  needs_more_evidence: boolean;
  candidate_count: number;
  selected_count: number;
  token_budget: number;
  contradiction_pairs: unknown;
  payload: unknown;
  latency_ms: number | null;
  retrieval_tier: 'cache' | 'search' | 'hybrid' | null;
}

interface PersistedTelemetrySummaryRow {
  total_events: number;
  avg_candidate_count: number;
  avg_selected_count: number;
  avg_latency_ms: number;
  avg_token_budget: number;
  needs_more_evidence_rate: number;
  contradiction_rate: number;
  cache_count: number;
  search_count: number;
  hybrid_count: number;
}

const MAX_EVENTS = 100;
const MAX_TELEMETRY_STRING_LENGTH = 1_000;
const MAX_TELEMETRY_ARRAY_ITEMS = 250;
const events: RetrievalTelemetryEvent[] = [];

function truncateTelemetryString(value: string, maxLength = MAX_TELEMETRY_STRING_LENGTH): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 12)}…[truncated]` : value;
}

function boundStringArray(values: string[]): string[] {
  return values.slice(0, MAX_TELEMETRY_ARRAY_ITEMS).map(value => truncateTelemetryString(value));
}

function boundTelemetryCandidate(candidate: RetrievalTelemetryCandidate): RetrievalTelemetryCandidate {
  return {
    ...candidate,
    key: truncateTelemetryString(candidate.key),
    origin: truncateTelemetryString(candidate.origin, 100),
    sourceType: candidate.sourceType ? truncateTelemetryString(candidate.sourceType, 200) : undefined,
    reasons: boundStringArray(candidate.reasons ?? []),
    conflictsWith: boundStringArray(candidate.conflictsWith ?? []),
    supersededBy: candidate.supersededBy ? truncateTelemetryString(candidate.supersededBy) : undefined,
  };
}

/**
 * Bound and validate retrieval telemetry before in-memory or durable storage.
 * Throws PayloadTooLargeError with remediation details if a candidate or event
 * still exceeds configured caps after cheap string/array truncation.
 */
export function boundRetrievalTelemetryEvent(event: RetrievalTelemetryEvent): RetrievalTelemetryEvent {
  const limits = getContextLimits();
  const bounded: RetrievalTelemetryEvent = {
    ...event,
    queryPreview: truncateTelemetryString(event.queryPreview, 240),
    matchedSkills: boundStringArray(event.matchedSkills ?? []),
    selectedCandidateKeys: boundStringArray(event.selectedCandidateKeys ?? []),
    droppedCandidateKeys: boundStringArray(event.droppedCandidateKeys ?? []),
    contradictions: (event.contradictions ?? [])
      .slice(0, MAX_TELEMETRY_ARRAY_ITEMS)
      .map(([left, right]) => [truncateTelemetryString(left), truncateTelemetryString(right)] as [string, string]),
    candidates: (event.candidates ?? [])
      .slice(0, limits.maxCandidates)
      .map(boundTelemetryCandidate),
  };

  for (const candidate of bounded.candidates) {
    assertCandidateWithinCap(candidate, candidate.key, limits);
  }

  const serialized = JSON.stringify({
    ...bounded,
    candidates: bounded.candidates,
  });
  assertPayloadWithinCap(
    byteLength(serialized),
    limits.maxTracePayloadBytes,
    'Retrieval telemetry',
    'Reduce RORCA_RETRIEVAL_MAX_CANDIDATES, disable retrieval explainability, or raise RORCA_TRACE_MAX_PAYLOAD_BYTES and retry.',
  );

  return bounded;
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function normalizeContradictions(value: unknown): Array<[string, string]> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (
      Array.isArray(entry)
      && entry.length >= 2
      && typeof entry[0] === 'string'
      && typeof entry[1] === 'string'
    ) {
      return [[entry[0], entry[1]] as [string, string]];
    }
    return [];
  });
}

function normalizeCandidates(value: unknown): RetrievalTelemetryCandidate[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const row = candidate as Record<string, unknown>;
    if (typeof row.key !== 'string' || typeof row.origin !== 'string' || typeof row.finalScore !== 'number') {
      return [];
    }

    return [{
      key: row.key,
      origin: row.origin,
      sourceType: typeof row.sourceType === 'string' ? row.sourceType : undefined,
      finalScore: row.finalScore,
      decision: (row.decision as RetrievalTelemetryCandidate['decision']) || 'drop',
      semanticRankScore: typeof row.semanticRankScore === 'number' ? row.semanticRankScore : undefined,
      preRerankPosition: typeof row.preRerankPosition === 'number' ? row.preRerankPosition : null,
      rerankedBy: row.rerankedBy === 'graph' ? 'graph' : row.rerankedBy === 'semantic' ? 'semantic' : undefined,
      freshnessScore: typeof row.freshnessScore === 'number' ? row.freshnessScore : 0,
      validatorScore: typeof row.validatorScore === 'number' ? row.validatorScore : 0,
      graphScore: typeof row.graphScore === 'number' ? row.graphScore : 0,
      historicalScore: typeof row.historicalScore === 'number' ? row.historicalScore : 0,
      reasons: normalizeStringArray(row.reasons),
      conflictsWith: normalizeStringArray(row.conflictsWith),
      supersededBy: typeof row.supersededBy === 'string' ? row.supersededBy : undefined,
      scoring: row.scoring && typeof row.scoring === 'object'
        ? row.scoring as GraphRagScoreContract
        : undefined,
      explainability: row.explainability && typeof row.explainability === 'object'
        ? row.explainability as GraphRagCandidateExplainability
        : undefined,
    }];
  });
}

function mapPersistedRowToEvent(row: PersistedTelemetryRow): RetrievalTelemetryEvent {
  const payload = row.payload && typeof row.payload === 'object'
    ? row.payload as Record<string, unknown>
    : {};

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    createdAt: row.created_at,
    queryPreview: row.query_preview,
    matchedSkills: normalizeStringArray(row.matched_skills),
    selectedCandidateKeys: normalizeStringArray(row.selected_candidate_keys),
    droppedCandidateKeys: normalizeStringArray(row.dropped_candidate_keys),
    needsMoreEvidence: row.needs_more_evidence,
    candidateCount: Number(row.candidate_count) || 0,
    selectedCount: Number(row.selected_count) || 0,
    tokenBudget: Number(row.token_budget) || 0,
    contradictions: normalizeContradictions(row.contradiction_pairs),
    candidates: normalizeCandidates(payload.candidates),
    latencyMs: row.latency_ms ?? undefined,
    retrievalTier: row.retrieval_tier ?? undefined,
  };
}

export function recordRetrievalTelemetry(event: Omit<RetrievalTelemetryEvent, 'id' | 'createdAt'>): RetrievalTelemetryEvent {
  const saved = boundRetrievalTelemetryEvent({
    ...event,
    id: `rt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
  });

  events.unshift(saved);
  if (events.length > MAX_EVENTS) {
    events.length = MAX_EVENTS;
  }

  logger.debug(
    {
      id: saved.id,
      workspaceId: saved.workspaceId,
      candidateCount: saved.candidateCount,
      selectedCount: saved.selectedCount,
      needsMoreEvidence: saved.needsMoreEvidence,
      retrievalTier: saved.retrievalTier,
      latencyMs: saved.latencyMs,
    },
    '[retrieval-telemetry] event recorded',
  );

  return saved;
}

export function getRecentRetrievalTelemetry(limit: number = 20): RetrievalTelemetryEvent[] {
  return events.slice(0, Math.max(0, limit));
}

export function listRetrievalTelemetry(options: RetrievalTelemetryListOptions = {}): RetrievalTelemetryEvent[] {
  const limit = Math.max(0, options.limit ?? 20);
  const filtered = options.workspaceId
    ? events.filter(event => event.workspaceId === options.workspaceId)
    : events;
  return filtered.slice(0, limit);
}

export async function persistRetrievalTelemetry(event: RetrievalTelemetryEvent): Promise<void> {
  const bounded = boundRetrievalTelemetryEvent(event);
  try {
    await execute(
      `INSERT INTO retrieval_telemetry_events (
         id,
         workspace_id,
         query_preview,
         matched_skills,
         selected_candidate_keys,
         dropped_candidate_keys,
         needs_more_evidence,
         candidate_count,
         selected_count,
         token_budget,
         contradiction_count,
         contradiction_pairs,
         retrieval_tier,
         latency_ms,
         payload,
         created_at
       )
       VALUES (
         $1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15::jsonb, $16
       )
       ON CONFLICT (id)
       DO UPDATE SET
         workspace_id = EXCLUDED.workspace_id,
         query_preview = EXCLUDED.query_preview,
         matched_skills = EXCLUDED.matched_skills,
         selected_candidate_keys = EXCLUDED.selected_candidate_keys,
         dropped_candidate_keys = EXCLUDED.dropped_candidate_keys,
         needs_more_evidence = EXCLUDED.needs_more_evidence,
         candidate_count = EXCLUDED.candidate_count,
         selected_count = EXCLUDED.selected_count,
         token_budget = EXCLUDED.token_budget,
         contradiction_count = EXCLUDED.contradiction_count,
         contradiction_pairs = EXCLUDED.contradiction_pairs,
         retrieval_tier = EXCLUDED.retrieval_tier,
         latency_ms = EXCLUDED.latency_ms,
         payload = EXCLUDED.payload,
         created_at = EXCLUDED.created_at`,
      [
        bounded.id,
        bounded.workspaceId,
        bounded.queryPreview,
        JSON.stringify(bounded.matchedSkills),
        JSON.stringify(bounded.selectedCandidateKeys),
        JSON.stringify(bounded.droppedCandidateKeys),
        bounded.needsMoreEvidence,
        bounded.candidateCount,
        bounded.selectedCount,
        bounded.tokenBudget,
        bounded.contradictions.length,
        JSON.stringify(bounded.contradictions),
        bounded.retrievalTier ?? null,
        bounded.latencyMs ?? null,
        JSON.stringify({ candidates: bounded.candidates }),
        bounded.createdAt,
      ],
    );
  } catch (err: any) {
    if (err?.code !== '42P01') {
      logger.debug({ err }, '[retrieval-telemetry] durable persistence failed');
    }
  }
}

export async function listPersistedRetrievalTelemetry(
  options: RetrievalTelemetryListOptions = {},
): Promise<RetrievalTelemetryEvent[]> {
  const limit = Math.max(0, options.limit ?? 20);

  try {
    const rows = await query<PersistedTelemetryRow>(
      `SELECT
         id,
         workspace_id,
         created_at,
         query_preview,
         matched_skills,
         selected_candidate_keys,
         dropped_candidate_keys,
         needs_more_evidence,
         candidate_count,
         selected_count,
         token_budget,
         contradiction_pairs,
         payload,
         latency_ms,
         retrieval_tier
       FROM retrieval_telemetry_events
       WHERE ($1::text IS NULL OR workspace_id = $1)
       ORDER BY created_at DESC
       LIMIT $2`,
      [options.workspaceId ?? null, limit],
    );

    return rows.map(mapPersistedRowToEvent);
  } catch (err: any) {
    if (err?.code !== '42P01') {
      logger.debug({ err }, '[retrieval-telemetry] persisted list failed');
    }
    return [];
  }
}

export async function summarizePersistedRetrievalTelemetry(
  options: RetrievalTelemetryListOptions = {},
): Promise<RetrievalTelemetryAggregateSummary> {
  const empty: RetrievalTelemetryAggregateSummary = {
    totalEvents: 0,
    avgCandidateCount: 0,
    avgSelectedCount: 0,
    avgLatencyMs: 0,
    avgTokenBudget: 0,
    needsMoreEvidenceRate: 0,
    contradictionRate: 0,
    tierCounts: {
      cache: 0,
      search: 0,
      hybrid: 0,
    },
    topMatchedSkills: [],
  };

  try {
    const [summaryRow, topSkills] = await Promise.all([
      query<PersistedTelemetrySummaryRow>(
        `SELECT
           COUNT(*)::int AS total_events,
           COALESCE(AVG(candidate_count), 0)::double precision AS avg_candidate_count,
           COALESCE(AVG(selected_count), 0)::double precision AS avg_selected_count,
           COALESCE(AVG(latency_ms), 0)::double precision AS avg_latency_ms,
           COALESCE(AVG(token_budget), 0)::double precision AS avg_token_budget,
           COALESCE(AVG(CASE WHEN needs_more_evidence THEN 1 ELSE 0 END), 0)::double precision AS needs_more_evidence_rate,
           COALESCE(AVG(CASE WHEN contradiction_count > 0 THEN 1 ELSE 0 END), 0)::double precision AS contradiction_rate,
           COUNT(*) FILTER (WHERE retrieval_tier = 'cache')::int AS cache_count,
           COUNT(*) FILTER (WHERE retrieval_tier = 'search')::int AS search_count,
           COUNT(*) FILTER (WHERE retrieval_tier = 'hybrid')::int AS hybrid_count
         FROM retrieval_telemetry_events
         WHERE ($1::text IS NULL OR workspace_id = $1)`,
        [options.workspaceId ?? null],
      ),
      query<{ skill: string; count: number }>(
        `SELECT skill, COUNT(*)::int AS count
         FROM (
           SELECT jsonb_array_elements_text(matched_skills) AS skill
           FROM retrieval_telemetry_events
           WHERE ($1::text IS NULL OR workspace_id = $1)
         ) expanded
         GROUP BY skill
         ORDER BY count DESC, skill ASC
         LIMIT 10`,
        [options.workspaceId ?? null],
      ),
    ]);

    const row = summaryRow[0];
    if (!row) return empty;

    return {
      totalEvents: Number(row.total_events) || 0,
      avgCandidateCount: Number(row.avg_candidate_count) || 0,
      avgSelectedCount: Number(row.avg_selected_count) || 0,
      avgLatencyMs: Number(row.avg_latency_ms) || 0,
      avgTokenBudget: Number(row.avg_token_budget) || 0,
      needsMoreEvidenceRate: Number(row.needs_more_evidence_rate) || 0,
      contradictionRate: Number(row.contradiction_rate) || 0,
      tierCounts: {
        cache: Number(row.cache_count) || 0,
        search: Number(row.search_count) || 0,
        hybrid: Number(row.hybrid_count) || 0,
      },
      topMatchedSkills: topSkills.map((skill) => ({
        skill: skill.skill,
        count: Number(skill.count) || 0,
      })),
    };
  } catch (err: any) {
    if (err?.code !== '42P01') {
      logger.debug({ err }, '[retrieval-telemetry] persisted summary failed');
    }
    return empty;
  }
}

export function clearRetrievalTelemetry(): void {
  events.length = 0;
}
