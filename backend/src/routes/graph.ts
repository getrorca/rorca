/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { graphStats, populateFromRun, populateFromSpec } from '../lib/knowledge-graph';
import { query, queryOne } from '../db/index';
import { broadcastAll } from '../lib/sse-hub';
import { logger } from '../lib/logger';
import {
  buildGraphRagExplainability,
  GRAPH_RAG_SCORE_CONTRACT_DOCUMENTATION,
} from '../lib/retrieval-pipeline';
import {
  listPersistedRetrievalTelemetry,
  listRetrievalTelemetry,
  summarizePersistedRetrievalTelemetry,
  type RetrievalTelemetryCandidate,
  type RetrievalTelemetryEvent,
} from '../lib/retrieval-telemetry';
import { listRetrievalFeedback, summarizeRetrievalFeedback } from '../lib/retrieval-feedback';
import { getAgeUnavailableBody } from '../lib/age-guard';
import { describeRuntimeGraph, getRuntimeGraphCapability } from '../lib/graph-runtime';
import { ForbiddenError, ValidationError } from '../lib/errors';
import { invalidateGraphContextCacheForWorkspace } from '../lib/graph-context';

const router = Router();

// Track in-progress population to prevent double-trigger
const activePopulations = new Set<string>();

// ─── Types ──────────────────────────────────────────────────────────────────

interface GraphStatsResponse {
  available: boolean;
  runtime: ReturnType<typeof describeRuntimeGraph>;
  vertexCount: number;
  edgeCount: number;
  graphName: string;
  lastPopulatedAt: string | null;
}

function debugKeyBelongsToWorkspace(workspaceId: string, key: string | null | undefined): boolean {
  if (!key) return true;
  return key === `workspace:${workspaceId}`
    || key.includes(`:${workspaceId}::`)
    || key.startsWith(`invalid:memory:${workspaceId}::`);
}

function candidateMatchesSpec(candidate: RetrievalTelemetryCandidate, workspaceId: string, specId?: string): boolean {
  if (!specId) return true;
  const storyPrefix = `story:${workspaceId}::${specId}::`;
  return candidate.scoring?.tieBreak.sourceStoryKey?.startsWith(storyPrefix) ?? false;
}

function attachTelemetryExplainability(
  event: RetrievalTelemetryEvent,
  workspaceId: string,
  specId?: string,
): RetrievalTelemetryEvent & { scoringVersion: string | null; retrievalMode: string | null } {
  const candidates = event.candidates
    .filter(candidate => candidateMatchesSpec(candidate, workspaceId, specId))
    .map((candidate) => {
      const explainability = (
        candidate.explainability
        && 'ontologyExplainability' in candidate.explainability
        && 'provenanceEdgeOverflow' in candidate.explainability
        && 'rankReasonOverflow' in candidate.explainability
      )
        ? candidate.explainability
        : (candidate.scoring
          ? buildGraphRagExplainability({
              scoring: candidate.scoring,
              reasons: candidate.reasons,
              graphRelationship: candidate.scoring.breakdown.directGraphProximity.relationship,
            })
          : candidate.explainability);

      if (
        explainability
        && (!debugKeyBelongsToWorkspace(workspaceId, explainability.tieBreak.canonicalKey)
          || !debugKeyBelongsToWorkspace(workspaceId, explainability.tieBreak.sourceStoryKey))
      ) {
        throw new ForbiddenError('Retrieval telemetry contained candidates outside the active workspace scope');
      }

      return {
        ...candidate,
        explainability,
      };
    });

  const firstExplainability = candidates.find(candidate => candidate.explainability)?.explainability;
  return {
    ...event,
    candidates,
    scoringVersion: firstExplainability?.scoringVersion ?? null,
    retrievalMode: firstExplainability?.retrievalMode ?? null,
  };
}

// ─── Routes ─────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/graph/stats:
 *   get:
 *     tags: [Graph]
 *     summary: Get knowledge graph statistics
 *     operationId: getGraphStats
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Read-only graph capability and counter summary with no write or operator-only side effects."
 *     x-rorca-public-api: true
 *     description: Returns runtime graph mode plus basic graph statistics including vertex count, edge count, graph name, and last populated timestamp. When AGE is not installed, returns available=false with zeroed counts and null timestamps — never a 500 error.
 *     responses:
 *       200:
 *         description: Graph statistics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 available:
 *                   type: boolean
 *                   description: Whether Apache AGE extension is loaded
 *                 vertexCount:
 *                   type: integer
 *                   description: Total number of vertices in the graph
 *                 edgeCount:
 *                   type: integer
 *                   description: Total number of edges in the graph
 *                 graphName:
 *                   type: string
 *                   description: Name of the AGE graph
 *                 lastPopulatedAt:
 *                   type: string
 *                   nullable: true
 *                   format: date-time
 *                   description: Timestamp of most recent graph population event
 */
router.get('/stats', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const runtime = describeRuntimeGraph(await getRuntimeGraphCapability('knowledge'));
    const stats = await graphStats();

    if (!stats.available) {
      const result: GraphStatsResponse = {
        available: false,
        runtime,
        vertexCount: 0,
        edgeCount: 0,
        graphName: 'rorca',
        lastPopulatedAt: null,
      };
      return res.json(result);
    }

    // Fetch last populated timestamp from wal_events (graph_populated events)
    // or fall back to latest graph-related WAL event
    const lastEvent = await queryOne<{ ts: string }>(
      `SELECT ts FROM wal_events
       WHERE event_type IN ('graph_populated', 'graph_backfill_complete', 'graph_populate_finished', 'run_finished')
       ORDER BY ts DESC LIMIT 1`,
    );

    const result: GraphStatsResponse = {
      available: true,
      runtime,
      vertexCount: stats.vertexCount,
      edgeCount: stats.edgeCount,
      graphName: 'rorca',
      lastPopulatedAt: lastEvent?.ts ?? null,
    };

    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/graph/retrieval-telemetry:
 *   get:
 *     tags: [Graph]
 *     summary: Get recent retrieval telemetry, score-contract metadata, and feedback rows for operator debugging
 *     operationId: getRetrievalTelemetry
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Retrieval telemetry exposes operator-only debugging and ranking internals and should remain admin-only."
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         schema: { type: string }
 *         description: Optional workspace filter
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
 *         description: Max telemetry events / feedback rows to return
 *     responses:
 *       200:
 *         description: Recent retrieval telemetry, GraphRAG score-contract metadata (including scored vs semantic-only consumer surfaces), and feedback summary
 */
router.get('/retrieval-telemetry', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined;
    const specId = typeof req.query.specId === 'string' ? req.query.specId : undefined;
    const parsedLimit = parseInt(String(req.query.limit ?? '20'), 10);
    const limit = Number.isFinite(parsedLimit) ? Math.min(100, Math.max(1, parsedLimit)) : 20;

    if (!workspaceId) {
      throw new ValidationError('workspaceId is required for retrieval telemetry debugging');
    }

    const [persistedEventsRaw, telemetrySummary, feedback, feedbackSummary] = await Promise.all([
      listPersistedRetrievalTelemetry({ workspaceId, limit }),
      summarizePersistedRetrievalTelemetry({ workspaceId }),
      listRetrievalFeedback({ workspaceId, limit }),
      summarizeRetrievalFeedback({ workspaceId }),
    ]);

    const eventsRaw = listRetrievalTelemetry({ workspaceId, limit });
    const events = eventsRaw
      .map(event => attachTelemetryExplainability(event, workspaceId, specId))
      .filter(event => !specId || event.candidates.length > 0);
    const persistedEvents = persistedEventsRaw
      .map(event => attachTelemetryExplainability(event, workspaceId, specId))
      .filter(event => !specId || event.candidates.length > 0);

    res.json({
      workspaceId,
      specId: specId ?? null,
      limit,
      scoreContract: GRAPH_RAG_SCORE_CONTRACT_DOCUMENTATION,
      events,
      persistedEvents,
      feedback,
      summary: {
        telemetry: telemetrySummary,
        feedback: feedbackSummary,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── Helper: emit WAL event and broadcast to SSE subscribers ──────────────

async function emitWal(
  eventType: string,
  workspaceId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const row = await queryOne<{
    id: number;
    ts: string;
    event_type: string;
    workspace_id: string | null;
    spec_id: string | null;
    story_id: string | null;
    actor: string;
    payload: string | null;
  }>(
    `INSERT INTO wal_events (event_type, workspace_id, payload)
     VALUES ($1, $2, $3) RETURNING *`,
    [eventType, workspaceId, JSON.stringify(payload)],
  );
  if (row) broadcastAll(row);
}

// ─── POST /api/graph/populate ────────────────────────────────────────────

/**
 * @swagger
 * /api/graph/populate:
 *   post:
 *     tags: [Graph]
 *     summary: Populate the knowledge graph for a workspace
 *     operationId: populateGraph
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Graph population is an operator-controlled maintenance workflow and should remain admin-only."
 *     description: |
 *       Triggers a full graph population for a workspace by iterating all completed
 *       pipeline runs and approved specs. Returns 202 immediately; progress is reported
 *       via WAL events (graph_populate_started, graph_populate_progress, graph_populate_finished).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId:
 *                 type: string
 *                 description: The workspace to populate the graph for
 *     responses:
 *       202:
 *         description: Population started
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 totalItems:
 *                   type: integer
 *                   description: Total number of runs + specs to process
 *       400:
 *         description: Missing workspaceId or graph unavailable
 *       409:
 *         description: Population already in progress for this workspace
 */
router.post('/populate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { workspaceId } = req.body;

    if (!workspaceId || typeof workspaceId !== 'string') {
      return res.status(400).json({ error: 'workspaceId is required' });
    }

    const runtime = await getRuntimeGraphCapability('admin');
    if (!runtime.adminAvailable) {
      return res.status(503).json(getAgeUnavailableBody());
    }

    if (activePopulations.has(workspaceId)) {
      return res.status(409).json({ error: 'Population already in progress for this workspace' });
    }

    // Count total items to process
    const completedRuns = await query<{ id: number; spec_path: string }>(
      `SELECT id, spec_path FROM pipeline_runs
       WHERE workspace_id = $1 AND status IN ('done', 'passed')`,
      [workspaceId],
    );

    // Get unique spec slugs from completed runs, then load latest version content
    const specSlugs = [...new Set(
      completedRuns
        .map(r => r.spec_path.replace(/^.*\//, '').replace(/\.json$/, ''))
        .filter(Boolean),
    )];

    const approvedSpecs: Array<{ spec_slug: string; content_json: unknown }> = [];
    for (const slug of specSlugs) {
      const sv = await queryOne<{ spec_slug: string; content_json: unknown }>(
        `SELECT spec_slug, content_json FROM spec_versions
         WHERE workspace_id = $1 AND spec_slug = $2
         ORDER BY version DESC LIMIT 1`,
        [workspaceId, slug],
      );
      if (sv) approvedSpecs.push(sv);
    }

    const totalItems = completedRuns.length + approvedSpecs.length;

    if (totalItems === 0) {
      return res.status(202).json({ totalItems: 0 });
    }

    // Mark population as active and respond immediately
    invalidateGraphContextCacheForWorkspace(workspaceId);
    activePopulations.add(workspaceId);
    res.status(202).json({ totalItems });

    // Run population async (fire-and-forget after response)
    (async () => {
      let completed = 0;
      try {
        await emitWal('graph_populate_started', workspaceId, { totalItems });

        // Process completed runs
        for (const run of completedRuns) {
          try {
            const specId = run.spec_path
              .replace(/^.*\//, '')
              .replace(/\.json$/, '');
            await populateFromRun(run.id, specId, workspaceId);
          } catch (err) {
            logger.warn({ err, runId: run.id }, '[graph/populate] Failed to populate from run');
          }
          completed++;
          if (completed % 5 === 0 || completed === totalItems) {
            await emitWal('graph_populate_progress', workspaceId, { completed, total: totalItems });
          }
        }

        // Process approved specs
        for (const sv of approvedSpecs) {
          try {
            const content = typeof sv.content_json === 'string'
              ? JSON.parse(sv.content_json)
              : sv.content_json;
            const stories = (content.userStories || []).map((s: { id: string; title: string; dependsOn?: string[] }) => ({
              id: s.id,
              title: s.title,
              dependsOn: s.dependsOn,
            }));
            await populateFromSpec(sv.spec_slug, workspaceId, stories);
          } catch (err) {
            logger.warn({ err, specSlug: sv.spec_slug }, '[graph/populate] Failed to populate from spec');
          }
          completed++;
          if (completed % 5 === 0 || completed === totalItems) {
            await emitWal('graph_populate_progress', workspaceId, { completed, total: totalItems });
          }
        }

        invalidateGraphContextCacheForWorkspace(workspaceId);
        await emitWal('graph_populate_finished', workspaceId, { totalItems, completed });
        logger.info({ workspaceId, totalItems, completed }, '[graph/populate] Population complete');
      } catch (err) {
        invalidateGraphContextCacheForWorkspace(workspaceId);
        logger.error({ err, workspaceId }, '[graph/populate] Population failed');
        await emitWal('graph_populate_finished', workspaceId, { totalItems, completed, error: true }).catch(() => {});
      } finally {
        activePopulations.delete(workspaceId);
      }
    })();
  } catch (err) {
    next(err);
  }
});

export default router;
