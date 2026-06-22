/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * spec-relevance-graph.ts — Builds a bounded, spec-centric memory relevance
 * graph for the Context Inspector UI.
 *
 * The graph uses a hub-and-ring layout:
 *  - Hub:   spec / story / run context node
 *  - Ring 1: target/routed files from the execution
 *  - Ring 2: memory/context items (selected + dropped candidates)
 *
 * Data sources:
 *  - retrieval_telemetry_events (persisted candidate scoring)
 *  - wal_events (story_started, context_trace)
 *  - pipeline_runs / specs (metadata)
 *  - Apache AGE graph (optional, for graph/path evidence)
 */

import path from 'path';
import { queryOne, query } from '../db/index';
import { logger } from './logger';
import {
  describeRuntimeGraph,
  getRuntimeGraphCapability,
  type GraphRuntimeDescriptor,
} from './graph-runtime';

// ─── Types ──────────────────────────────────────────────────────────────────

export type RelevanceNodeType = 'hub' | 'file' | 'memory' | 'context';
export type RelevanceEdgeRelation =
  | 'routed_to'
  | 'selected_memory'
  | 'dropped_memory'
  | 'learned_from'
  | 'about_file'
  | 'graph_path';

export interface RelevanceScoreBreakdown {
  semantic: number | null;
  graph: number | null;
  recency: number | null;
  skill: number | null;
  arbiter: number | null;
  keyword: number | null;
}

export interface RelevanceNode {
  id: string;
  type: RelevanceNodeType;
  ring: 0 | 1 | 2;
  label: string;
  entityId: string;
  // Memory/context fields (ring 2)
  sourceId?: string;
  title?: string;
  category?: string;
  snippet?: string;
  selected?: boolean;
  dropped?: boolean;
  enteredPrompt?: boolean;
  relevanceScore?: number;
  scoreBreakdown?: RelevanceScoreBreakdown;
  keptOrDroppedReason?: string;
  // File fields (ring 1)
  path?: string;
  // Hub fields (ring 0)
  specId?: string;
  storyId?: string;
  runId?: number;
}

export interface RelevanceEdgeVisualHints {
  thickness: number;
  dashed: boolean;
  opacity: number;
}

export interface RelevanceEdge {
  id: string;
  source: string;
  target: string;
  relation: RelevanceEdgeRelation;
  scoreContribution: number | null;
  evidence: string | null;
  visualHints: RelevanceEdgeVisualHints;
}

export interface RelevanceScoreLegend {
  field: string;
  label: string;
  description: string;
}

export interface RelevanceGraphCaps {
  maxFiles: number;
  maxMemories: number;
  maxEdges: number;
}

export interface RelevanceGraphTruncation {
  filesTruncated: boolean;
  memoriesTruncated: boolean;
  edgesTruncated: boolean;
  totalCandidates: number;
  returnedCandidates: number;
}

export interface RelevanceGraphFallback {
  ageAvailable: boolean;
  telemetryAvailable: boolean;
  graphPathsAvailable: boolean;
  missingReasons: string[];
}

export interface RelevanceGraphSummary {
  hubLabel: string;
  nodeCount: number;
  edgeCount: number;
  selectedCount: number;
  droppedCount: number;
  avgRelevanceScore: number | null;
}

export interface SpecRelevanceGraphResponse {
  available: boolean;
  runtime: GraphRuntimeDescriptor;
  hub: RelevanceNode | null;
  nodes: RelevanceNode[];
  edges: RelevanceEdge[];
  scoreLegend: RelevanceScoreLegend[];
  summary: RelevanceGraphSummary;
  caps: RelevanceGraphCaps;
  truncation: RelevanceGraphTruncation;
  fallback: RelevanceGraphFallback;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_CAPS: RelevanceGraphCaps = {
  maxFiles: 20,
  maxMemories: 30,
  maxEdges: 80,
};

const SCORE_LEGEND: RelevanceScoreLegend[] = [
  { field: 'semantic', label: 'Semantic / Vector', description: 'Embedding similarity between query and candidate' },
  { field: 'graph', label: 'Graph / Path', description: 'AGE graph proximity hops and relationship strength' },
  { field: 'recency', label: 'Recency', description: 'How recently the memory was created or updated' },
  { field: 'skill', label: 'Skill Alignment', description: 'Match between candidate skills and story skills' },
  { field: 'arbiter', label: 'Arbiter / Selection', description: 'Final arbiter decision weight' },
  { field: 'keyword', label: 'Keyword', description: 'Lexical keyword overlap score' },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function edgeVisualHints(
  relation: RelevanceEdgeRelation,
  score: number | null,
): RelevanceEdgeVisualHints {
  const baseOpacity = score != null ? Math.max(0.3, Math.min(1, score)) : 0.5;
  switch (relation) {
    case 'routed_to':
      return { thickness: 2, dashed: false, opacity: 0.9 };
    case 'selected_memory':
      return { thickness: 2, dashed: false, opacity: baseOpacity };
    case 'dropped_memory':
      return { thickness: 1, dashed: true, opacity: 0.4 };
    case 'graph_path':
      return { thickness: 1, dashed: true, opacity: baseOpacity };
    default:
      return { thickness: 1, dashed: false, opacity: 0.6 };
  }
}

function buildScoreBreakdown(candidate: Record<string, any>): RelevanceScoreBreakdown {
  const scoring = candidate.scoring;
  const breakdown = scoring?.breakdown;

  return {
    semantic: typeof candidate.semanticRankScore === 'number' ? candidate.semanticRankScore : null,
    graph: breakdown?.directGraphProximity?.proximityUnavailable === true
      ? null
      : (typeof candidate.graphScore === 'number' ? candidate.graphScore : null),
    recency: typeof candidate.freshnessScore === 'number' ? candidate.freshnessScore : null,
    skill: breakdown?.skillAlignment?.raw != null
      ? Number(breakdown.skillAlignment.raw)
      : null,
    arbiter: typeof candidate.finalScore === 'number' ? candidate.finalScore : null,
    keyword: typeof scoring?.keywordScore === 'number' ? scoring.keywordScore : null,
  };
}

function graphPathMissingReason(candidate: Record<string, any>): string | null {
  const scoring = candidate.scoring;
  if (!scoring) return 'No GraphRAG scoring data available';
  const proximity = scoring.breakdown?.directGraphProximity;
  if (!proximity) return 'No graph proximity component in scoring';
  if (proximity.proximityUnavailable) return 'Graph proximity unavailable (AGE not connected or no path found)';
  return null;
}

function buildUnavailableResponse(
  reasons: string[],
  runtime: GraphRuntimeDescriptor,
): SpecRelevanceGraphResponse {
  return {
    available: false,
    runtime,
    hub: null,
    nodes: [],
    edges: [],
    scoreLegend: SCORE_LEGEND,
    summary: {
      hubLabel: '',
      nodeCount: 0,
      edgeCount: 0,
      selectedCount: 0,
      droppedCount: 0,
      avgRelevanceScore: null,
    },
    caps: DEFAULT_CAPS,
    truncation: {
      filesTruncated: false,
      memoriesTruncated: false,
      edgesTruncated: false,
      totalCandidates: 0,
      returnedCandidates: 0,
    },
    fallback: {
      ageAvailable: runtime.ageAvailable,
      telemetryAvailable: false,
      graphPathsAvailable: false,
      missingReasons: reasons,
    },
  };
}

// ─── Query helpers ──────────────────────────────────────────────────────────

interface TelemetryRow {
  id: string;
  workspace_id: string;
  query_preview: string;
  matched_skills: string[];
  selected_candidate_keys: string[];
  dropped_candidate_keys: string[];
  needs_more_evidence: boolean;
  candidate_count: number;
  selected_count: number;
  token_budget: number;
  payload: Record<string, any>;
  latency_ms: number | null;
  retrieval_tier: string | null;
  created_at: string;
}

async function fetchTelemetryForRun(
  runId: number,
  workspaceId: string,
): Promise<{ telemetry: TelemetryRow | null; storyId: string | null }> {
  // Find the telemetry ID linked to this run via WAL events
  const walRow = await queryOne<{ story_id: string; telemetry_id: string }>(
    `SELECT story_id, payload->>'retrieval_telemetry_id' AS telemetry_id
     FROM wal_events
     WHERE event_type = 'story_started'
       AND (payload->>'run_id')::bigint = $1
       AND payload->>'retrieval_telemetry_id' IS NOT NULL
     ORDER BY ts DESC
     LIMIT 1`,
    [runId],
  );

  if (!walRow?.telemetry_id) return { telemetry: null, storyId: walRow?.story_id ?? null };

  const row = await queryOne<TelemetryRow>(
    `SELECT id, workspace_id, query_preview, matched_skills,
            selected_candidate_keys, dropped_candidate_keys,
            needs_more_evidence, candidate_count, selected_count,
            token_budget, payload, latency_ms, retrieval_tier, created_at
     FROM retrieval_telemetry_events
     WHERE id = $1 AND workspace_id = $2`,
    [walRow.telemetry_id, workspaceId],
  );

  return { telemetry: row ?? null, storyId: walRow.story_id };
}

async function fetchTelemetryById(
  telemetryId: string,
  workspaceId: string,
): Promise<TelemetryRow | null> {
  return queryOne<TelemetryRow>(
    `SELECT id, workspace_id, query_preview, matched_skills,
            selected_candidate_keys, dropped_candidate_keys,
            needs_more_evidence, candidate_count, selected_count,
            token_budget, payload, latency_ms, retrieval_tier, created_at
     FROM retrieval_telemetry_events
     WHERE id = $1 AND workspace_id = $2`,
    [telemetryId, workspaceId],
  ) as Promise<TelemetryRow | null>;
}

async function fetchRoutedFiles(
  runId: number,
): Promise<string[]> {
  // Routed files come from story_started WAL events or context_trace
  const rows = await query<{ file_path: string }>(
    `SELECT DISTINCT jsonb_array_elements_text(payload->'routed_files') AS file_path
     FROM wal_events
     WHERE event_type = 'story_started'
       AND (payload->>'run_id')::bigint = $1
       AND payload->'routed_files' IS NOT NULL`,
    [runId],
  );

  if (rows.length > 0) return rows.map(r => r.file_path);

  // Fallback: extract from context_trace WAL events
  const traceRows = await query<{ file_path: string }>(
    `SELECT DISTINCT jsonb_array_elements_text(payload->'predicted_paths') AS file_path
     FROM wal_events
     WHERE event_type = 'context_trace'
       AND (payload->>'run_id')::bigint = $1
       AND payload->'predicted_paths' IS NOT NULL`,
    [runId],
  );

  return traceRows.map(r => r.file_path);
}

function specSlugFromPath(specPath: string | null | undefined): string | undefined {
  if (!specPath) return undefined;
  const base = path.basename(specPath).replace(/\.json$/i, '').trim();
  return base.length > 0 ? base : undefined;
}

async function fetchRunMeta(
  runId: number,
): Promise<{ id: number; spec_path: string; workspace_id: string } | null> {
  return queryOne<{ id: number; spec_path: string; workspace_id: string }>(
    `SELECT id, spec_path, workspace_id FROM pipeline_runs WHERE id = $1`,
    [runId],
  ) as Promise<{ id: number; spec_path: string; workspace_id: string } | null>;
}

// ─── Graph Builder ──────────────────────────────────────────────────────────

export async function buildSpecRelevanceGraph(options: {
  workspaceId: string;
  specSlug?: string;
  storyId?: string;
  runId?: number;
  retrievalTelemetryId?: string;
  caps?: Partial<RelevanceGraphCaps>;
}): Promise<SpecRelevanceGraphResponse> {
  const {
    workspaceId,
    specSlug,
    storyId: inputStoryId,
    runId,
    retrievalTelemetryId,
  } = options;

  const caps: RelevanceGraphCaps = {
    maxFiles: Math.max(1, Math.min(options.caps?.maxFiles ?? DEFAULT_CAPS.maxFiles, 50)),
    maxMemories: Math.max(1, Math.min(options.caps?.maxMemories ?? DEFAULT_CAPS.maxMemories, 60)),
    maxEdges: Math.max(1, Math.min(options.caps?.maxEdges ?? DEFAULT_CAPS.maxEdges, 150)),
  };

  const runtimeCapability = await getRuntimeGraphCapability('relevance');
  const runtime = describeRuntimeGraph(runtimeCapability);
  const missingReasons: string[] = [];
  const ageAvailable = runtime.ageAvailable;

  if (runtime.graphMode === 'disabled') {
    return buildUnavailableResponse([
      runtime.message,
      ...runtimeCapability.capability.warnings,
    ], runtime);
  }

  // Resolve telemetry
  let telemetry: TelemetryRow | null = null;
  let resolvedStoryId = inputStoryId ?? null;
  let resolvedRunId = runId ?? null;
  let resolvedSpecSlug = specSlug ?? null;

  if (retrievalTelemetryId) {
    telemetry = await fetchTelemetryById(retrievalTelemetryId, workspaceId);
    if (!telemetry) {
      missingReasons.push(`Retrieval telemetry event ${retrievalTelemetryId} not found`);
    }
  } else if (runId) {
    const result = await fetchTelemetryForRun(runId, workspaceId);
    telemetry = result.telemetry;
    if (!telemetry) missingReasons.push('No retrieval telemetry found for this run');
    if (result.storyId && !resolvedStoryId) resolvedStoryId = result.storyId;
  }

  // Resolve spec from run if not provided
  if (!resolvedSpecSlug && resolvedRunId) {
    const runMeta = await fetchRunMeta(resolvedRunId);
    if (runMeta) {
      resolvedSpecSlug = specSlugFromPath(runMeta.spec_path) ?? null;
      if (runMeta.workspace_id !== workspaceId) {
        return buildUnavailableResponse(['Run does not belong to this workspace'], runtime);
      }
    }
  }

  // Build hub label
  const hubLabel = resolvedSpecSlug
    ? `Spec: ${resolvedSpecSlug}${resolvedStoryId ? ` / ${resolvedStoryId}` : ''}${resolvedRunId ? ` (run ${resolvedRunId})` : ''}`
    : resolvedRunId
      ? `Run ${resolvedRunId}`
      : 'Unknown context';

  // Build hub node
  const hubNodeId = `hub:${workspaceId}::${resolvedSpecSlug ?? 'unknown'}`;
  const hub: RelevanceNode = {
    id: hubNodeId,
    type: 'hub',
    ring: 0,
    label: hubLabel,
    entityId: resolvedSpecSlug ?? 'unknown',
    specId: resolvedSpecSlug ?? undefined,
    storyId: resolvedStoryId ?? undefined,
    runId: resolvedRunId ?? undefined,
  };

  const nodes: RelevanceNode[] = [hub];
  const edges: RelevanceEdge[] = [];

  // Ring 1: routed/target files
  let routedFiles: string[] = [];
  if (resolvedRunId) {
    try {
      routedFiles = await fetchRoutedFiles(resolvedRunId);
    } catch (err) {
      logger.warn({ err }, '[spec-relevance-graph] Failed to fetch routed files');
      missingReasons.push('Failed to load routed files from WAL');
    }
  }

  const filesTruncated = routedFiles.length > caps.maxFiles;
  const boundedFiles = routedFiles.slice(0, caps.maxFiles);

  for (const filePath of boundedFiles) {
    const fileNodeId = `file:${workspaceId}::${filePath}`;
    nodes.push({
      id: fileNodeId,
      type: 'file',
      ring: 1,
      label: filePath.split('/').pop() ?? filePath,
      entityId: filePath,
      path: filePath,
    });
    edges.push({
      id: `edge:routed:${hubNodeId}->${fileNodeId}`,
      source: hubNodeId,
      target: fileNodeId,
      relation: 'routed_to',
      scoreContribution: null,
      evidence: 'Context routing / predicted paths',
      visualHints: edgeVisualHints('routed_to', null),
    });
  }

  // Ring 2: memory/context candidates from telemetry
  let selectedCount = 0;
  let droppedCount = 0;
  let totalCandidates = 0;
  let scoreSum = 0;
  let scoreCount = 0;
  let graphPathsAvailable = false;

  if (telemetry) {
    const payload = telemetry.payload && typeof telemetry.payload === 'object'
      ? telemetry.payload
      : {};
    const candidatesRaw: Record<string, any>[] = Array.isArray(payload.candidates)
      ? payload.candidates
      : [];

    totalCandidates = candidatesRaw.length;

    const selectedKeys = new Set(
      Array.isArray(telemetry.selected_candidate_keys)
        ? telemetry.selected_candidate_keys
        : [],
    );

    let memoryCount = 0;
    for (const candidate of candidatesRaw) {
      if (!candidate || typeof candidate !== 'object') continue;
      if (typeof candidate.key !== 'string') continue;
      if (memoryCount >= caps.maxMemories) break;

      const isSelected = selectedKeys.has(candidate.key) || candidate.decision === 'keep';
      const finalScore = typeof candidate.finalScore === 'number' ? candidate.finalScore : 0;
      const breakdown = buildScoreBreakdown(candidate);

      // Check if graph/path evidence is present
      if (breakdown.graph != null && breakdown.graph > 0) {
        graphPathsAvailable = true;
      }

      const pathMissing = graphPathMissingReason(candidate);

      const memNodeId = `memory:${workspaceId}::${candidate.key}`;
      nodes.push({
        id: memNodeId,
        type: 'memory',
        ring: 2,
        label: typeof candidate.title === 'string'
          ? candidate.title
          : (typeof candidate.origin === 'string' ? candidate.origin : candidate.key),
        entityId: candidate.key,
        sourceId: typeof candidate.canonicalKey === 'string' ? candidate.canonicalKey : candidate.key,
        title: typeof candidate.title === 'string' ? candidate.title : undefined,
        category: typeof candidate.category === 'string'
          ? candidate.category
          : (typeof candidate.sourceType === 'string' ? candidate.sourceType : undefined),
        snippet: typeof candidate.snippet === 'string' ? candidate.snippet : undefined,
        selected: isSelected,
        dropped: !isSelected,
        enteredPrompt: isSelected,
        relevanceScore: finalScore,
        scoreBreakdown: breakdown,
        keptOrDroppedReason: Array.isArray(candidate.reasons) && candidate.reasons.length > 0
          ? candidate.reasons.join('; ')
          : (isSelected ? 'Selected' : 'Dropped'),
      });

      const edgeRelation: RelevanceEdgeRelation = isSelected ? 'selected_memory' : 'dropped_memory';
      const evidenceLabel = pathMissing
        ? `Score: ${finalScore.toFixed(3)} | Graph: ${pathMissing}`
        : `Score: ${finalScore.toFixed(3)}`;

      edges.push({
        id: `edge:${edgeRelation}:${hubNodeId}->${memNodeId}`,
        source: hubNodeId,
        target: memNodeId,
        relation: edgeRelation,
        scoreContribution: finalScore,
        evidence: evidenceLabel,
        visualHints: edgeVisualHints(edgeRelation, finalScore),
      });

      if (isSelected) selectedCount++;
      else droppedCount++;

      scoreSum += finalScore;
      scoreCount++;
      memoryCount++;
    }
  } else {
    missingReasons.push('No retrieval telemetry available for graph construction');
  }

  if (!ageAvailable) {
    missingReasons.push(runtime.message);
  }

  if (!graphPathsAvailable && telemetry) {
    missingReasons.push('No graph/path evidence found in any candidate — graph proximity unavailable');
  }

  const memoriesTruncated = totalCandidates > caps.maxMemories;
  const edgesTruncated = edges.length >= caps.maxEdges;

  return {
    available: true,
    runtime,
    hub,
    nodes,
    edges: edges.slice(0, caps.maxEdges),
    scoreLegend: SCORE_LEGEND,
    summary: {
      hubLabel,
      nodeCount: nodes.length,
      edgeCount: Math.min(edges.length, caps.maxEdges),
      selectedCount,
      droppedCount,
      avgRelevanceScore: scoreCount > 0 ? scoreSum / scoreCount : null,
    },
    caps,
    truncation: {
      filesTruncated,
      memoriesTruncated,
      edgesTruncated,
      totalCandidates,
      returnedCandidates: Math.min(totalCandidates, caps.maxMemories),
    },
    fallback: {
      ageAvailable,
      telemetryAvailable: telemetry != null,
      graphPathsAvailable,
      missingReasons,
    },
  };
}
