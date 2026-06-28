/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * US-038: Observability and operator diagnostics.
 *
 * Provides a unified diagnostics surface that aggregates:
 *  - Graph provider health (knowledge graph availability, vertex/edge counts, staleness)
 *  - Retrieval health (telemetry summary, feedback stats)
 *  - Capture health (context event ingestion, capture sidecar status, queue depth, git/hook cursors)
 *  - Candidate health (backlog counts by review status)
 *  - Warnings (missing Hilo, stale graph, candidate backlog, failed hydration)
 *
 * Also provides an endpoint for the rorca-capture sidecar to report its own status
 * (API reachability, local queue depth, git/hook/daemon cursors, last error).
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { validateBody } from '../lib/validate';
import { handleRouteError } from '../lib/async-handler';
import { ValidationError, NotFoundError } from '../lib/errors';
import { query, queryOne, execute } from '../db/index';
import { describeRuntimeGraph, getRuntimeGraphCapability } from '../lib/graph-runtime';
import { graphStats } from '../lib/knowledge-graph';
import { summarizePersistedRetrievalTelemetry } from '../lib/retrieval-telemetry';
import { summarizeRetrievalFeedback } from '../lib/retrieval-feedback';
import { cacheStats } from '../lib/context-cache';
import { getQueueStats } from '../lib/embedding-pipeline';
import { logger } from '../lib/logger';

const router = Router();

// ════════════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════════════

interface GraphHealth {
  available: boolean;
  runtime: ReturnType<typeof describeRuntimeGraph>;
  vertexCount: number;
  edgeCount: number;
  lastPopulatedAt: string | null;
  isStale: boolean;
  staleReason: string | null;
}

interface RetrievalHealth {
  recentTraceCount: number;
  telemetrySummary: {
    totalEvents: number;
    avgCandidateCount: number;
    avgLatencyMs: number;
    avgTokenBudget: number;
  } | null;
  feedbackSummary: {
    totalCandidates: number;
    avgUsefulnessScore: number;
    avgObservationCount: number;
  } | null;
  cacheStats: ReturnType<typeof cacheStats>;
  embeddingStats: ReturnType<typeof getQueueStats>;
}

interface CaptureSidecarStatus {
  reportedAt: string | null;
  apiReachable: boolean | null;
  localQueueDepth: number | null;
  lastFlushAt: string | null;
  lastFlushSucceeded: number | null;
  lastFlushFailed: number | null;
  gitHead: string | null;
  hookInstalled: boolean | null;
  daemonRunning: boolean | null;
  daemonPid: number | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

interface CaptureHealth {
  totalEvents: number;
  eventsLast24h: number;
  latestEventAt: string | null;
  sidecar: CaptureSidecarStatus | null;
}

interface CandidateHealth {
  totalCandidates: number;
  pendingCount: number;
  approvedCount: number;
  rejectedCount: number;
  duplicateCount: number;
  supersededCount: number;
  revisitCount: number;
  hasBacklog: boolean;
  backlogWarning: string | null;
}

interface OperatorWarning {
  severity: 'warning' | 'error' | 'info';
  category: 'hilo' | 'graph' | 'candidate' | 'hydration' | 'capture' | 'retrieval';
  message: string;
  detail: string | null;
}

interface DiagnosticsStatusResponse {
  status: 'ok' | 'degraded' | 'warning';
  graph: GraphHealth;
  retrieval: RetrievalHealth;
  capture: CaptureHealth;
  candidates: CandidateHealth;
  warnings: OperatorWarning[];
  timestamp: string;
}

// ════════════════════════════════════════════════════════════════════════════
// Capture sidecar status report schema
// ════════════════════════════════════════════════════════════════════════════

const CaptureStatusReportSchema = z.object({
  workspaceId: z.string().min(1).max(255),
  apiReachable: z.boolean().optional(),
  localQueueDepth: z.number().int().min(0).optional(),
  lastFlushAt: z.string().datetime().optional(),
  lastFlushSucceeded: z.number().int().min(0).optional(),
  lastFlushFailed: z.number().int().min(0).optional(),
  gitHead: z.string().max(64).optional(),
  hookInstalled: z.boolean().optional(),
  daemonRunning: z.boolean().optional(),
  daemonPid: z.number().int().positive().optional(),
  lastError: z.string().max(2000).optional(),
  lastErrorAt: z.string().datetime().optional(),
});

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

async function getGraphHealth(): Promise<GraphHealth> {
  const runtime = describeRuntimeGraph(await getRuntimeGraphCapability('knowledge'));
  const stats = await graphStats();

  let lastPopulatedAt: string | null = null;
  let isStale = false;
  let staleReason: string | null = null;

  if (stats.available) {
    const lastEvent = await queryOne<{ ts: string }>(
      `SELECT ts FROM wal_events
       WHERE event_type IN ('graph_populated', 'graph_backfill_complete', 'graph_populate_finished', 'run_finished')
       ORDER BY ts DESC LIMIT 1`,
    );
    lastPopulatedAt = lastEvent?.ts ?? null;

    // Consider stale if last populated > 7 days ago
    if (lastPopulatedAt) {
      const ageMs = Date.now() - new Date(lastPopulatedAt).getTime();
      const oneWeekMs = 7 * 24 * 3600 * 1000;
      if (ageMs > oneWeekMs) {
        isStale = true;
        staleReason = `Graph last populated ${Math.round(ageMs / (24 * 3600 * 1000))} days ago`;
      }
    } else {
      isStale = true;
      staleReason = 'Graph has never been populated';
    }
  }

  return {
    available: stats.available,
    runtime,
    vertexCount: stats.available ? stats.vertexCount : 0,
    edgeCount: stats.available ? stats.edgeCount : 0,
    lastPopulatedAt,
    isStale: stats.available ? isStale : false,
    staleReason: stats.available ? staleReason : null,
  };
}

async function getRetrievalHealth(): Promise<RetrievalHealth> {
  let telemetrySummary = null;
  let feedbackSummary = null;
  let recentTraceCount = 0;

  try {
    const telemetry = await summarizePersistedRetrievalTelemetry({});
    telemetrySummary = {
      totalEvents: telemetry.totalEvents ?? 0,
      avgCandidateCount: telemetry.avgCandidateCount ?? 0,
      avgLatencyMs: telemetry.avgLatencyMs ?? 0,
      avgTokenBudget: telemetry.avgTokenBudget ?? 0,
    };
  } catch {
    // Table may not exist
  }

  try {
    const feedback = await summarizeRetrievalFeedback({});
    const total = feedback.totalCandidates ?? 0;
    feedbackSummary = {
      totalCandidates: total,
      avgUsefulnessScore: feedback.avgUsefulnessScore ?? 0,
      avgObservationCount: feedback.avgObservationCount ?? 0,
    };
  } catch {
    // Table may not exist
  }

  try {
    const row = await queryOne<{ cnt: string }>(
      `SELECT COUNT(*)::int AS cnt FROM retrieval_traces`,
    );
    recentTraceCount = parseInt(row?.cnt ?? '0', 10);
  } catch {
    // Table may not exist
  }

  return {
    recentTraceCount,
    telemetrySummary,
    feedbackSummary,
    cacheStats: cacheStats(),
    embeddingStats: getQueueStats(),
  };
}

async function getCaptureHealth(workspaceId?: string): Promise<CaptureHealth> {
  let whereClause = '';
  const params: unknown[] = [];

  if (workspaceId) {
    whereClause = 'WHERE workspace_id = $1';
    params.push(workspaceId);
  }

  let totalEvents = 0;
  let eventsLast24h = 0;
  let latestEventAt: string | null = null;

  try {
    const countRow = await queryOne<{ cnt: string }>(
      `SELECT COUNT(*)::int AS cnt FROM context_events ${whereClause}`,
      params,
    );
    totalEvents = parseInt(countRow?.cnt ?? '0', 10);

    const last24hRow = await queryOne<{ cnt: string }>(
      `SELECT COUNT(*)::int AS cnt FROM context_events ${whereClause ? whereClause + ' AND' : 'WHERE'} created_at > NOW() - INTERVAL '24 hours'`,
      params,
    );
    eventsLast24h = parseInt(last24hRow?.cnt ?? '0', 10);

    const latestRow = await queryOne<{ ts: string }>(
      `SELECT created_at::text AS ts FROM context_events ${whereClause ? whereClause + ' AND' : 'WHERE'} true ORDER BY created_at DESC LIMIT 1`,
      params,
    );
    latestEventAt = latestRow?.ts ?? null;
  } catch {
    // Table may not exist
  }

  // Get sidecar status from capture_status table
  let sidecar: CaptureSidecarStatus | null = null;
  try {
    if (workspaceId) {
      const sRow = await queryOne<{
        reported_at: string;
        api_reachable: boolean;
        local_queue_depth: number;
        last_flush_at: string;
        last_flush_succeeded: number;
        last_flush_failed: number;
        git_head: string;
        hook_installed: boolean;
        daemon_running: boolean;
        daemon_pid: number;
        last_error: string;
        last_error_at: string;
      }>(
        `SELECT reported_at, api_reachable, local_queue_depth,
                last_flush_at, last_flush_succeeded, last_flush_failed,
                git_head, hook_installed, daemon_running, daemon_pid,
                last_error, last_error_at
         FROM capture_status
         WHERE workspace_id = $1
         ORDER BY reported_at DESC LIMIT 1`,
        [workspaceId],
      );
      if (sRow) {
        sidecar = {
          reportedAt: sRow.reported_at,
          apiReachable: sRow.api_reachable,
          localQueueDepth: sRow.local_queue_depth,
          lastFlushAt: sRow.last_flush_at,
          lastFlushSucceeded: sRow.last_flush_succeeded,
          lastFlushFailed: sRow.last_flush_failed,
          gitHead: sRow.git_head,
          hookInstalled: sRow.hook_installed,
          daemonRunning: sRow.daemon_running,
          daemonPid: sRow.daemon_pid,
          lastError: sRow.last_error,
          lastErrorAt: sRow.last_error_at,
        };
      }
    }
  } catch {
    // capture_status table may not exist yet
  }

  return { totalEvents, eventsLast24h, latestEventAt, sidecar };
}

async function getCandidateHealth(workspaceId?: string): Promise<CandidateHealth> {
  let whereClause = '';
  const params: unknown[] = [];

  if (workspaceId) {
    whereClause = 'WHERE workspace_id = $1';
    params.push(workspaceId);
  }

  let counts: Record<string, number> = {
    total: 0,
    pending: 0,
    approved: 0,
    rejected: 0,
    duplicate: 0,
    superseded: 0,
    revisit: 0,
  };

  try {
    const rows = await query<{ review_status: string; cnt: string }>(
      `SELECT review_status, COUNT(*)::int AS cnt
       FROM memory_candidates
       ${whereClause ? whereClause + ' GROUP BY review_status' : 'GROUP BY review_status'}`,
      params,
    );
    for (const r of rows) {
      const cnt = parseInt(r.cnt, 10);
      counts[r.review_status] = cnt;
      counts.total += cnt;
    }
  } catch {
    // Table may not exist
  }

  const pendingCount = counts.pending ?? 0;
  const hasBacklog = pendingCount > 10;
  const backlogWarning = hasBacklog
    ? `${pendingCount} pending candidates need review — candidate backlog may delay knowledge ingestion`
    : null;

  return {
    totalCandidates: counts.total,
    pendingCount,
    approvedCount: counts.approved ?? 0,
    rejectedCount: counts.rejected ?? 0,
    duplicateCount: counts.duplicate ?? 0,
    supersededCount: counts.superseded ?? 0,
    revisitCount: counts.revisit ?? 0,
    hasBacklog,
    backlogWarning,
  };
}

function buildWarnings(
  graph: GraphHealth,
  capture: CaptureHealth,
  candidates: CandidateHealth,
): OperatorWarning[] {
  const warnings: OperatorWarning[] = [];

  // Graph warnings
  if (!graph.available) {
    warnings.push({
      severity: 'warning',
      category: 'graph',
      message: 'Knowledge graph is unavailable — install Apache AGE or use graph lite fallback',
      detail: graph.runtime?.hint ?? null,
    });
  } else if (graph.isStale) {
    warnings.push({
      severity: 'warning',
      category: 'graph',
      message: 'Knowledge graph is stale',
      detail: graph.staleReason,
    });
  }

  // Candidate backlog
  if (candidates.hasBacklog) {
    warnings.push({
      severity: candidates.pendingCount > 50 ? 'error' : 'warning',
      category: 'candidate',
      message: `Candidate backlog: ${candidates.pendingCount} pending candidates awaiting review`,
      detail: 'Approve, reject, or deduplicate candidates in the Direction panel to clear the backlog.',
    });
  }

  // Capture health
  if (capture.sidecar) {
    if (capture.sidecar.lastError) {
      warnings.push({
        severity: 'warning',
        category: 'capture',
        message: `Capture sidecar reported an error: ${capture.sidecar.lastError}`,
        detail: capture.sidecar.lastErrorAt ? `Last error at ${capture.sidecar.lastErrorAt}` : null,
      });
    }
    if (capture.sidecar.localQueueDepth && capture.sidecar.localQueueDepth > 50) {
      warnings.push({
        severity: 'warning',
        category: 'capture',
        message: `Capture sidecar local queue has ${capture.sidecar.localQueueDepth} pending entries`,
        detail: 'Check that the Rorca API is reachable and the sidecar can flush.',
      });
    }
    if (capture.sidecar.apiReachable === false) {
      warnings.push({
        severity: 'error',
        category: 'capture',
        message: 'Capture sidecar cannot reach the Rorca API',
        detail: 'Check that the Rorca backend is running and the sidecar has the correct base URL.',
      });
    }
    if (capture.sidecar.hookInstalled === false) {
      warnings.push({
        severity: 'info',
        category: 'capture',
        message: 'Capture git hook is not installed — context events may be missed on commit',
        detail: 'Run `rorca-capture install-hook` to install the post-commit hook.',
      });
    }
  }

  // No data warnings
  if (capture.totalEvents === 0) {
    warnings.push({
      severity: 'info',
      category: 'capture',
      message: 'No context events have been ingested yet',
      detail: 'Install and start rorca-capture to begin ingesting context events.',
    });
  }

  return warnings;
}

// ════════════════════════════════════════════════════════════════════════════
// Routes
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * /api/diagnostics/status:
 *   get:
 *     tags: [Diagnostics]
 *     summary: Aggregated diagnostics status — graph, retrieval, capture, candidate health
 *     operationId: getDiagnosticsStatus
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Operator-only diagnostics surface that aggregates internal health metrics across graph, retrieval, capture, and candidate subsystems — exposes internal operational state."
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         schema: { type: string }
 *         description: Optional workspace filter for per-workspace capture and candidate stats
 *     responses:
 *       200:
 *         description: Aggregated diagnostics with health status and warnings
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, enum: [ok, degraded, warning] }
 *                 graph:
 *                   type: object
 *                   properties:
 *                     available: { type: boolean }
 *                     vertexCount: { type: integer }
 *                     edgeCount: { type: integer }
 *                     lastPopulatedAt: { type: string, nullable: true }
 *                     isStale: { type: boolean }
 *                     staleReason: { type: string, nullable: true }
 *                 retrieval:
 *                   type: object
 *                   properties:
 *                     recentTraceCount: { type: integer }
 *                     telemetrySummary: { type: object, nullable: true }
 *                     feedbackSummary: { type: object, nullable: true }
 *                 capture:
 *                   type: object
 *                   properties:
 *                     totalEvents: { type: integer }
 *                     eventsLast24h: { type: integer }
 *                     latestEventAt: { type: string, nullable: true }
 *                     sidecar: { type: object, nullable: true }
 *                 candidates:
 *                   type: object
 *                   properties:
 *                     totalCandidates: { type: integer }
 *                     pendingCount: { type: integer }
 *                     approvedCount: { type: integer }
 *                     hasBacklog: { type: boolean }
 *                     backlogWarning: { type: string, nullable: true }
 *                 warnings:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       severity: { type: string, enum: [warning, error, info] }
 *                       category: { type: string, enum: [hilo, graph, candidate, hydration, capture, retrieval] }
 *                       message: { type: string }
 *                       detail: { type: string, nullable: true }
 *                 timestamp: { type: string, format: date-time }
 */
router.get('/status', async (req: Request, res: Response) => {
  try {
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined;

    // Run all health checks in parallel
    const [graph, retrieval, capture, candidates] = await Promise.all([
      getGraphHealth(),
      getRetrievalHealth(),
      getCaptureHealth(workspaceId),
      getCandidateHealth(workspaceId),
    ]);

    const warnings = buildWarnings(graph, capture, candidates);

    // Determine overall status
    let status: 'ok' | 'degraded' | 'warning' = 'ok';
    const hasErrors = warnings.some(w => w.severity === 'error');
    const hasWarnings = warnings.some(w => w.severity === 'warning');
    if (hasErrors) {
      status = 'degraded';
    } else if (hasWarnings) {
      status = 'warning';
    }

    const response: DiagnosticsStatusResponse = {
      status,
      graph,
      retrieval,
      capture,
      candidates,
      warnings,
      timestamp: new Date().toISOString(),
    };

    res.json(response);
  } catch (err) {
    handleRouteError(res, err, '[diagnostics] status');
  }
});

/**
 * @swagger
 * /api/diagnostics/capture-status:
 *   post:
 *     tags: [Diagnostics]
 *     summary: Report capture sidecar status (called by rorca-capture daemon)
 *     operationId: reportCaptureStatus
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Sidecar-facing status report endpoint — the capture daemon reports its own health and cursors so the operator dashboard can surface warnings; safe for local/MCP automation."
 *     x-rorca-public-api: true
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId: { type: string }
 *               apiReachable: { type: boolean }
 *               localQueueDepth: { type: integer }
 *               lastFlushAt: { type: string, format: date-time }
 *               lastFlushSucceeded: { type: integer }
 *               lastFlushFailed: { type: integer }
 *               gitHead: { type: string }
 *               hookInstalled: { type: boolean }
 *               daemonRunning: { type: boolean }
 *               daemonPid: { type: integer }
 *               lastError: { type: string }
 *               lastErrorAt: { type: string, format: date-time }
 *     responses:
 *       200:
 *         description: Status accepted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 accepted: { type: boolean }
 *                 timestamp: { type: string, format: date-time }
 */
router.post('/capture-status', validateBody(CaptureStatusReportSchema), async (req: Request, res: Response) => {
  try {
    const body = req.body as z.infer<typeof CaptureStatusReportSchema>;

    // Ensure capture_status table exists (idempotent)
    try {
      await execute(`
        CREATE TABLE IF NOT EXISTS capture_status (
          id SERIAL PRIMARY KEY,
          workspace_id VARCHAR(255) NOT NULL,
          reported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          api_reachable BOOLEAN,
          local_queue_depth INTEGER DEFAULT 0,
          last_flush_at TIMESTAMPTZ,
          last_flush_succeeded INTEGER DEFAULT 0,
          last_flush_failed INTEGER DEFAULT 0,
          git_head VARCHAR(64),
          hook_installed BOOLEAN,
          daemon_running BOOLEAN,
          daemon_pid INTEGER,
          last_error TEXT,
          last_error_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
    } catch (e) {
      // Table may already exist — safe to ignore
    }

    // Upsert the status report
    await execute(
      `INSERT INTO capture_status
         (workspace_id, api_reachable, local_queue_depth, last_flush_at,
          last_flush_succeeded, last_flush_failed, git_head,
          hook_installed, daemon_running, daemon_pid, last_error, last_error_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        body.workspaceId,
        body.apiReachable ?? null,
        body.localQueueDepth ?? 0,
        body.lastFlushAt ?? null,
        body.lastFlushSucceeded ?? 0,
        body.lastFlushFailed ?? 0,
        body.gitHead ?? null,
        body.hookInstalled ?? null,
        body.daemonRunning ?? null,
        body.daemonPid ?? null,
        body.lastError ?? null,
        body.lastErrorAt ?? null,
      ],
    );

    logger.info(
      {
        workspaceId: body.workspaceId,
        queueDepth: body.localQueueDepth,
        apiReachable: body.apiReachable,
        hookInstalled: body.hookInstalled,
        daemonRunning: body.daemonRunning,
      },
      '[diagnostics] capture sidecar status report received',
    );

    res.json({
      accepted: true,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    handleRouteError(res, err, '[diagnostics] capture-status');
  }
});

/**
 * @swagger
 * /api/diagnostics/capture-status/{workspaceId}:
 *   get:
 *     tags: [Diagnostics]
 *     summary: Get latest capture sidecar status for a workspace
 *     operationId: getCaptureStatus
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Operator-only diagnostics surface for capture sidecar health — exposes internal daemon state."
 *     parameters:
 *       - in: path
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Latest capture sidecar status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 workspaceId: { type: string }
 *                 sidecar: { type: object, nullable: true }
 */
router.get('/capture-status/:workspaceId', async (req: Request, res: Response) => {
  try {
    const workspaceId = String(req.params.workspaceId);
    const capture = await getCaptureHealth(workspaceId);

    res.json({
      workspaceId,
      sidecar: capture.sidecar,
      events: {
        total: capture.totalEvents,
        last24h: capture.eventsLast24h,
        latestEventAt: capture.latestEventAt,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    handleRouteError(res, err, '[diagnostics] get capture-status');
  }
});

export default router;
