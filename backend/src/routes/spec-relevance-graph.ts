/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * spec-relevance-graph.ts — API routes for the spec-centric memory relevance
 * graph. Returns a bounded hub-and-ring graph for spec/story/run context
 * neighborhoods, suitable for Context Inspector visualization.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { queryOne } from '../db/index';
import { ValidationError, NotFoundError } from '../lib/errors';
import { buildSpecRelevanceGraph } from '../lib/spec-relevance-graph';

const router = Router();

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseOptionalInt(value: unknown, min: number, max: number, fallback: number): number {
  if (value == null || value === '') return fallback;
  const parsed = parseInt(String(value), 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

async function resolveWorkspace(workspaceId: string): Promise<{ id: string; path: string }> {
  const ws = await queryOne<{ id: string; path: string }>(
    'SELECT id, path FROM workspaces WHERE id = $1',
    [workspaceId],
  );
  if (!ws) throw new NotFoundError('Workspace', workspaceId);
  return ws;
}

// ─── GET /api/spec-relevance-graph ──────────────────────────────────────────

/**
 * @swagger
 * /api/spec-relevance-graph:
 *   get:
 *     tags: [Graph, Context]
 *     summary: Get spec-centric memory relevance graph
 *     operationId: getSpecRelevanceGraph
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Read-only bounded graph of retrieval context for a spec/run — stable diagnostic surface with no write or operator-only side effects."
 *     x-rorca-public-api: true
 *     description: |
 *       Returns a bounded spec-centric memory relevance graph for Context Inspector
 *       visualization. The graph uses a hub-and-ring layout:
 *       - Hub (ring 0): spec/story/run context node
 *       - Ring 1: target/routed files from execution
 *       - Ring 2: memory/context items with scoring details
 *
 *       Provide at least one of specSlug, runId, or retrievalTelemetryId.
 *       workspaceId is always required.
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *         description: Workspace ID (required for scoping)
 *       - in: query
 *         name: specSlug
 *         schema: { type: string }
 *         description: Spec slug/ID to center the graph on
 *       - in: query
 *         name: storyId
 *         schema: { type: string }
 *         description: Optional story/task ID for narrower focus
 *       - in: query
 *         name: runId
 *         schema: { type: integer }
 *         description: Pipeline run ID to extract telemetry and routed files from
 *       - in: query
 *         name: retrievalTelemetryId
 *         schema: { type: string }
 *         description: Direct retrieval telemetry event ID
 *       - in: query
 *         name: maxFiles
 *         schema: { type: integer, minimum: 1, maximum: 50, default: 20 }
 *         description: Max ring-1 file nodes
 *       - in: query
 *         name: maxMemories
 *         schema: { type: integer, minimum: 1, maximum: 60, default: 30 }
 *         description: Max ring-2 memory/context nodes
 *       - in: query
 *         name: maxEdges
 *         schema: { type: integer, minimum: 1, maximum: 150, default: 80 }
 *         description: Max edges in the graph
 *     responses:
 *       200:
 *         description: Spec-centric memory relevance graph
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 available: { type: boolean }
 *                 hub: { type: object, nullable: true }
 *                 nodes: { type: array }
 *                 edges: { type: array }
 *                 scoreLegend: { type: array }
 *                 summary: { type: object }
 *                 caps: { type: object }
 *                 truncation: { type: object }
 *                 fallback: { type: object }
 *       400: { description: "Missing required parameters" }
 *       404: { description: "Workspace not found" }
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : '';
    if (!workspaceId) throw new ValidationError('workspaceId is required');

    const specSlug = typeof req.query.specSlug === 'string' ? req.query.specSlug : undefined;
    const storyId = typeof req.query.storyId === 'string' ? req.query.storyId : undefined;
    const runIdRaw = req.query.runId;
    const runId = runIdRaw != null && runIdRaw !== ''
      ? parseInt(String(runIdRaw), 10)
      : undefined;
    const retrievalTelemetryId = typeof req.query.retrievalTelemetryId === 'string'
      ? req.query.retrievalTelemetryId
      : undefined;

    if (!specSlug && runId == null && !retrievalTelemetryId) {
      throw new ValidationError('At least one of specSlug, runId, or retrievalTelemetryId is required');
    }

    if (runId != null && isNaN(runId)) {
      throw new ValidationError('runId must be a valid integer');
    }

    // Validate workspace exists
    await resolveWorkspace(workspaceId);

    const maxFiles = parseOptionalInt(req.query.maxFiles, 1, 50, 20);
    const maxMemories = parseOptionalInt(req.query.maxMemories, 1, 60, 30);
    const maxEdges = parseOptionalInt(req.query.maxEdges, 1, 150, 80);

    const graph = await buildSpecRelevanceGraph({
      workspaceId,
      specSlug,
      storyId,
      runId,
      retrievalTelemetryId,
      caps: { maxFiles, maxMemories, maxEdges },
    });

    res.json(graph);
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/spec-relevance-graph/by-run/:runId ────────────────────────────

/**
 * @swagger
 * /api/spec-relevance-graph/by-run/{runId}:
 *   get:
 *     tags: [Graph, Context]
 *     summary: Get spec-centric memory relevance graph scoped to a pipeline run
 *     operationId: getSpecRelevanceGraphByRun
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Read-only convenience accessor for run-scoped relevance graph — stable diagnostic surface."
 *     x-rorca-public-api: true
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: integer }
 *         description: Pipeline run ID
 *       - in: query
 *         name: maxFiles
 *         schema: { type: integer, minimum: 1, maximum: 50, default: 20 }
 *       - in: query
 *         name: maxMemories
 *         schema: { type: integer, minimum: 1, maximum: 60, default: 30 }
 *       - in: query
 *         name: maxEdges
 *         schema: { type: integer, minimum: 1, maximum: 150, default: 80 }
 *     responses:
 *       200: { description: "Spec-centric memory relevance graph for run" }
 *       400: { description: "Invalid runId" }
 *       404: { description: "Run not found" }
 */
router.get('/by-run/:runId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const runId = parseInt(String(req.params.runId), 10);
    if (isNaN(runId)) throw new ValidationError('Invalid runId');

    const run = await queryOne<{ id: number; spec_id: string; workspace_id: string }>(
      'SELECT id, spec_id, workspace_id FROM pipeline_runs WHERE id = $1',
      [runId],
    );
    if (!run) throw new NotFoundError('Run', String(runId));

    const maxFiles = parseOptionalInt(req.query.maxFiles, 1, 50, 20);
    const maxMemories = parseOptionalInt(req.query.maxMemories, 1, 60, 30);
    const maxEdges = parseOptionalInt(req.query.maxEdges, 1, 150, 80);

    const graph = await buildSpecRelevanceGraph({
      workspaceId: run.workspace_id,
      specSlug: run.spec_id,
      runId,
      caps: { maxFiles, maxMemories, maxEdges },
    });

    res.json(graph);
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/spec-relevance-graph/by-spec/:specSlug ────────────────────────

/**
 * @swagger
 * /api/spec-relevance-graph/by-spec/{specSlug}:
 *   get:
 *     tags: [Graph, Context]
 *     summary: Get spec-centric memory relevance graph scoped to a spec
 *     operationId: getSpecRelevanceGraphBySpec
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Read-only convenience accessor for spec-scoped relevance graph — stable diagnostic surface."
 *     x-rorca-public-api: true
 *     parameters:
 *       - in: path
 *         name: specSlug
 *         required: true
 *         schema: { type: string }
 *         description: Spec slug/ID
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: storyId
 *         schema: { type: string }
 *         description: Optional story/task ID for narrower focus
 *       - in: query
 *         name: maxFiles
 *         schema: { type: integer, minimum: 1, maximum: 50, default: 20 }
 *       - in: query
 *         name: maxMemories
 *         schema: { type: integer, minimum: 1, maximum: 60, default: 30 }
 *       - in: query
 *         name: maxEdges
 *         schema: { type: integer, minimum: 1, maximum: 150, default: 80 }
 *     responses:
 *       200: { description: "Spec-centric memory relevance graph for spec" }
 *       400: { description: "Missing workspaceId" }
 *       404: { description: "Workspace not found" }
 */
router.get('/by-spec/:specSlug', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const specSlug = String(req.params.specSlug);
    if (!specSlug) throw new ValidationError('specSlug is required');

    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : '';
    if (!workspaceId) throw new ValidationError('workspaceId is required');

    await resolveWorkspace(workspaceId);

    const storyId = typeof req.query.storyId === 'string' ? req.query.storyId : undefined;

    // Find the latest run for this spec to get telemetry
    const latestRun = await queryOne<{ id: number }>(
      `SELECT id FROM pipeline_runs
       WHERE spec_id = $1 AND workspace_id = $2
       ORDER BY created_at DESC LIMIT 1`,
      [specSlug, workspaceId],
    );

    const maxFiles = parseOptionalInt(req.query.maxFiles, 1, 50, 20);
    const maxMemories = parseOptionalInt(req.query.maxMemories, 1, 60, 30);
    const maxEdges = parseOptionalInt(req.query.maxEdges, 1, 150, 80);

    const graph = await buildSpecRelevanceGraph({
      workspaceId,
      specSlug,
      storyId,
      runId: latestRun?.id,
      caps: { maxFiles, maxMemories, maxEdges },
    });

    res.json(graph);
  } catch (err) {
    next(err);
  }
});

export default router;
