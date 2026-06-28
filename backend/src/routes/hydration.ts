/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * US-010: Workspace hydration APIs — Hilo hydration status and trigger.
 *
 * Exposes stable route surfaces for context hydration health (GET) and
 * idempotent Hilo hydration triggering (POST). These are UI/CLI integration
 * surfaces for the Context Intelligence Platform.
 *
 * @see docs/context-intelligence-platform.md §2.1 / §3 / §6
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { validateBody } from '../lib/validate';
import { handleRouteError } from '../lib/async-handler';
import { NotFoundError } from '../lib/errors';
import { queryOne } from '../db';
import {
  getLatestHydration,
  createHydration,
  type WorkspaceHydration,
} from '../db/workspace-hydration';
import {
  detectHydrationStaleness,
  type HydrationStalenessResult,
} from '../lib/hydration-staleness';
import { loadHiloConfig } from '../lib/hilo-config';
import { detectHilo, requireHilo } from '../lib/hilo-detector';
import { getBoss } from '../lib/pg-boss';

const router = Router();

// ═══════════════════════════════════════════════════════════════════════════
// Validation schemas
// ═══════════════════════════════════════════════════════════════════════════

const TriggerHydrationBodySchema = z.object({
  /** Hydration types to trigger. Only `hilo` is supported. */
  types: z.array(z.enum(['hilo'])).min(1).default(['hilo']),
});

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Action hints for clients consuming the hydration status response.
 * Stable strings the UI and CLI can switch on to render nudges.
 */
type HydrationActionHint =
  | 'hydrate'
  | 'rehydrate'
  | 'wait'
  | 'configure_hilo'
  | 'none';

interface HydrationStatusResponse {
  workspaceId: string;
  /** The hydration provider. Currently always `hilo`. */
  provider: 'hilo';
  /** Latest hydration record, or null when no hydration has been attempted. */
  latest: WorkspaceHydration | null;
  /** Graph staleness result (HEAD vs hydrated SHA). */
  freshness: HydrationStalenessResult['status'];
  /** Detailed staleness checks for UI indicators. */
  freshnessDetails: {
    gitRepo: boolean;
    hasHydration: boolean;
    headMatches: boolean;
    dirtyTree: boolean;
    currentHead: string | null;
    hydratedSha: string | null;
    humanSummary: string;
  };
  /** Normalized graph counts from the latest succeeded hydration, or empty. */
  counts: WorkspaceHydration['counts'];
  /** Sanitized error from the latest *failed* hydration, or null. */
  errors: {
    /** Whether the latest hydration attempt failed. */
    hasErrors: boolean;
    /** The latest failure's sanitized error_json, or null. */
    latestError: WorkspaceHydration['errorJson'] | null;
    /** The latest failure's status, or null. */
    latestErrorStatus: WorkspaceHydration['status'] | null;
  };
  /** Status of the *current* hydration (the latest row, regardless of lifecycle). */
  currentStatus: WorkspaceHydration['status'] | null;
  /** Stable action hints clients can switch on. */
  actionHint: HydrationActionHint;
  /** Human-readable action message. */
  actionMessage: string | null;
}

/**
 * Derive the action hint from the hydration record + staleness.
 * Consumed by both GET (status) and POST (idempotency guard) responses.
 */
function deriveActionHint(
  latest: WorkspaceHydration | null,
  staleness: HydrationStalenessResult,
  hiloAvailable: boolean,
): { hint: HydrationActionHint; message: string | null } {
  // No hydration has ever been attempted.
  if (!latest) {
    if (!hiloAvailable) {
      return { hint: 'configure_hilo', message: 'Hilo is not available for this workspace. Configure and enable Hilo to hydrate the codegraph.' };
    }
    return { hint: 'hydrate', message: 'No hydration has been attempted. Hydrate to build the codegraph.' };
  }

  // A hydration is in flight.
  if (latest.status === 'pending' || latest.status === 'running') {
    return { hint: 'wait', message: `Hydration is currently ${latest.status}.` };
  }

  // Latest failed.
  if (latest.status === 'failed') {
    if (staleness.status === 'stale' || staleness.status === 'missing') {
      return { hint: 'rehydrate', message: 'The last hydration failed. Re-hydrate to rebuild the graph.' };
    }
    return { hint: 'rehydrate', message: 'The last hydration failed. Re-hydrate to retry.' };
  }

  // Latest succeeded, check staleness.
  if (staleness.status === 'stale') {
    return { hint: 'rehydrate', message: 'New commits exist since the last hydration. Re-hydrate to capture recent changes.' };
  }
  if (staleness.status === 'dirty') {
    return { hint: 'rehydrate', message: 'The working tree has uncommitted changes. Re-hydrate after committing to ensure accuracy.' };
  }
  if (staleness.status === 'clean') {
    return { hint: 'none', message: null };
  }

  // Unknown (non-git workspace) or missing — graph may still be valid.
  return { hint: 'none', message: null };
}

/**
 * Build the full hydration status response.
 */
async function buildHydrationStatus(workspaceId: string, workspacePath: string): Promise<HydrationStatusResponse> {
  const [latest, staleness] = await Promise.all([
    getLatestHydration(workspaceId),
    detectHydrationStaleness(workspaceId, workspacePath),
  ]);

  // Latest error from the most recent *failed* hydration.
  let latestError: WorkspaceHydration['errorJson'] | null = null;
  let latestErrorStatus: WorkspaceHydration['status'] | null = null;
  if (latest?.status === 'failed') {
    latestError = latest.errorJson;
    latestErrorStatus = latest.status;
  }

  // Hilo availability for action hints.
  const hiloConfig = loadHiloConfig(workspacePath);
  const hiloDetection = await detectHilo(hiloConfig);
  const hiloAvailable = hiloDetection.available;

  const action = deriveActionHint(latest, staleness, hiloAvailable);

  return {
    workspaceId,
    provider: 'hilo',
    latest,
    freshness: staleness.status,
    freshnessDetails: {
      gitRepo: staleness.checks.gitRepo,
      hasHydration: staleness.checks.hasHydration,
      headMatches: staleness.checks.headMatches,
      dirtyTree: staleness.checks.dirtyTree,
      currentHead: staleness.currentHead,
      hydratedSha: staleness.hydratedSha,
      humanSummary: staleness.humanSummary,
    },
    counts: latest?.counts ?? {},
    errors: {
      hasErrors: latestError !== null,
      latestError,
      latestErrorStatus,
    },
    currentStatus: latest?.status ?? null,
    actionHint: action.hint,
    actionMessage: action.message,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Routes
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * /api/workspaces/{workspaceId}/hydration:
 *   get:
 *     tags: [Hydration]
 *     summary: Get Hilo hydration status for a workspace
 *     operationId: getHydrationStatus
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Read-only hydration health check so local/MCP clients can inspect codegraph freshness, graph counts, error state, and receive action hints; no side effects."
 *     x-rorca-public-api: true
 *     parameters:
 *       - in: path
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *         description: Workspace identifier
 *     responses:
 *       200:
 *         description: Hydration status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 workspaceId: { type: string }
 *                 provider: { type: string, enum: [hilo] }
 *                 latest:
 *                   type: object
 *                   nullable: true
 *                   properties:
 *                     id: { type: integer }
 *                     workspaceId: { type: string }
 *                     provider: { type: string }
 *                     status: { type: string, enum: [pending, running, succeeded, failed, stale, cancelled] }
 *                     gitSha: { type: string, nullable: true }
 *                     graphPath: { type: string, nullable: true }
 *                     counts: { type: object }
 *                     durationMs: { type: integer, nullable: true }
 *                     staleReason: { type: string, nullable: true }
 *                     errorJson: { type: object, nullable: true }
 *                     startedAt: { type: string, format: date-time, nullable: true }
 *                     finishedAt: { type: string, format: date-time, nullable: true }
 *                     createdAt: { type: string, format: date-time }
 *                     updatedAt: { type: string, format: date-time }
 *                 freshness: { type: string, enum: [clean, stale, dirty, unknown, missing] }
 *                 freshnessDetails:
 *                   type: object
 *                   properties:
 *                     gitRepo: { type: boolean }
 *                     hasHydration: { type: boolean }
 *                     headMatches: { type: boolean }
 *                     dirtyTree: { type: boolean }
 *                     currentHead: { type: string, nullable: true }
 *                     hydratedSha: { type: string, nullable: true }
 *                     humanSummary: { type: string }
 *                 counts: { type: object }
 *                 errors:
 *                   type: object
 *                   properties:
 *                     hasErrors: { type: boolean }
 *                     latestError: { type: object, nullable: true }
 *                     latestErrorStatus: { type: string, nullable: true }
 *                 currentStatus: { type: string, nullable: true, enum: [pending, running, succeeded, failed, stale, cancelled] }
 *                 actionHint: { type: string, enum: [hydrate, rehydrate, wait, configure_hilo, none] }
 *                 actionMessage: { type: string, nullable: true }
 *       404:
 *         description: Workspace not found
 */
router.get('/:workspaceId/hydration', async (req: Request, res: Response) => {
  try {
    const workspaceId = String(req.params.workspaceId);

    const workspace = await queryOne<{ id: string; path: string }>(
      'SELECT id, path FROM workspaces WHERE id = $1',
      [workspaceId],
    );
    if (!workspace) {
      throw new NotFoundError(`Workspace '${workspaceId}' not found`);
    }

    const status = await buildHydrationStatus(workspaceId, workspace.path);
    res.json(status);
  } catch (error) {
    handleRouteError(res, error, '[hydration] GET status');
  }
});

/**
 * @swagger
 * /api/workspaces/{workspaceId}/hydration:
 *   post:
 *     tags: [Hydration]
 *     summary: Trigger Hilo hydration for a workspace (idempotent)
 *     operationId: triggerHydration
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Triggers read-only codegraph hydration from the filesystem; no destructive side effects. Idempotent — duplicate requests return the existing pending/running hydration rather than creating duplicates. Safe for local/MCP automation."
 *     x-rorca-public-api: true
 *     parameters:
 *       - in: path
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *         description: Workspace identifier
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               types:
 *                 type: array
 *                 items: { type: string, enum: [hilo] }
 *                 default: [hilo]
 *     responses:
 *       202:
 *         description: Hydration triggered or already in progress
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 hydrationId: { type: integer }
 *                 status: { type: string, enum: [pending, running] }
 *                 idempotent: { type: boolean }
 *                 message: { type: string }
 *       404:
 *         description: Workspace not found
 *       422:
 *         description: Hilo unavailable or workspace not a valid directory
 *       409:
 *         description: Hydration already running (can be fetched and awaited)
 */
router.post('/:workspaceId/hydration', validateBody(TriggerHydrationBodySchema), async (req: Request, res: Response) => {
  try {
    const workspaceId = String(req.params.workspaceId);

    const workspace = await queryOne<{ id: string; path: string; label: string }>(
      'SELECT id, path, label FROM workspaces WHERE id = $1',
      [workspaceId],
    );
    if (!workspace) {
      throw new NotFoundError(`Workspace '${workspaceId}' not found`);
    }

    // ── Idempotency: if a hydration is already pending or running, return it ──
    const existing = await getLatestHydration(workspaceId);
    if (existing && (existing.status === 'pending' || existing.status === 'running')) {
      res.status(202).json({
        hydrationId: existing.id,
        status: existing.status,
        idempotent: true,
        message: existing.status === 'pending'
          ? 'Hydration is already queued. Await processing.'
          : 'Hydration is already running. Await completion.',
      });
      return;
    }

    // ── Hilo availability check ──
    const hiloConfig = loadHiloConfig(workspace.path);
    const hiloDetection = await detectHilo(hiloConfig);
    requireHilo(hiloDetection);

    // ── Create pending hydration row ──
    const hydration = await createHydration({
      workspaceId,
      provider: 'hilo',
      status: 'pending',
    });

    // ── Enqueue via pg-boss for background execution ──
    // The queue consumer (worker.ts or background runtime) will pick this up
    // and call runHiloHydration.
    try {
      const boss = getBoss();

      // Ensure the hydration queue exists (idempotent).
      await boss.createQueue('workspace:hydrate');

      await boss.send('workspace:hydrate', {
        hydrationId: hydration.id,
        workspaceId,
        workspacePath: workspace.path,
        config: {
          binaryPath: hiloConfig.binaryPath,
          checkoutPath: hiloConfig.checkoutPath,
          outputDir: hiloConfig.outputDir,
          timeoutMs: hiloConfig.timeoutMs,
        },
      }, {
        retryLimit: 0,
        retryDelay: 0,
      });
    } catch (enqueueErr: any) {
      // If enqueuing fails, still return the created hydration row.
      // The background runtime or worker will pick it up on the next poll
      // when it scans for pending hydrations.
      // We don't fail the request — the row exists and is actionable.
    }

    res.status(202).json({
      hydrationId: hydration.id,
      status: 'pending',
      idempotent: false,
      message: 'Hydration queued. Monitor status via GET /api/workspaces/{workspaceId}/hydration.',
    });
  } catch (error) {
    handleRouteError(res, error, '[hydration] POST trigger');
  }
});

export default router;
