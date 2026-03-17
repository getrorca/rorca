/**
 * recall.ts — GET /api/recall
 *
 * Single-call context retrieval for MCP clients.
 * Returns direction stack, workspace metadata, active runs, and more
 * in one response so the caller's LLM session has full context.
 */

import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { query, queryOne } from '../db/index';
import { synthesizeDirectionStack } from '../lib/direction-stack';
import {
  RecallQuerySchema,
  type RecallResponse,
  type ActiveRun,
  type StoryProgress,
  type WorkspaceMetadata,
} from './recall-types';
import { ValidationError, NotFoundError } from '../lib/errors';

const router = Router();

// ─── DB row shapes (internal) ────────────────────────────────────────────────

interface WorkspaceRow {
  id: string;
  label: string;
  path: string;
  domain: string | null;
}

interface PipelineRunRow {
  id: number;
  spec_path: string;
  status: string;
  agent_type: string;
  agent_model: string | null;
  started_at: string;
  queue_position: number | null;
}

interface StoryResultCountRow {
  status: string;
  cnt: string;
}

// ─── GET /api/recall ─────────────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  const start = Date.now();

  // Validate query params
  const parsed = RecallQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map(i => i.message).join('; '));
  }
  const { workspaceId, includeRuns } = parsed.data;

  // Fetch workspace
  const workspace = await queryOne<WorkspaceRow>(
    `SELECT id, label, path, domain FROM workspaces WHERE id = $1`,
    [workspaceId]
  );
  if (!workspace) {
    throw new NotFoundError(`Workspace not found: ${workspaceId}`);
  }

  // ── Direction Stack ──────────────────────────────────────────────────────
  const synthesized = await synthesizeDirectionStack(workspaceId);
  const directionStack = synthesized.text;

  // ── Workspace metadata ───────────────────────────────────────────────────
  const metadata: WorkspaceMetadata = {
    id: workspace.id,
    label: workspace.label,
    path: workspace.path,
    domain: workspace.domain,
  };

  // ── Active Runs ──────────────────────────────────────────────────────────
  let activeRuns: ActiveRun[] = [];

  if (includeRuns) {
    const runs = await query<PipelineRunRow>(
      `SELECT id, spec_path, status, agent_type, agent_model, started_at, queue_position
       FROM pipeline_runs
       WHERE workspace_id = $1 AND status IN ('running', 'queued')
       ORDER BY started_at ASC`,
      [workspaceId]
    );

    activeRuns = await Promise.all(
      runs.map(async (run): Promise<ActiveRun> => {
        let storyProgress: StoryProgress | null = null;

        if (run.status === 'running') {
          // Get total story count from spec JSON
          let total = 0;
          try {
            const absSpecPath = path.join(workspace.path, run.spec_path);
            const specJson = JSON.parse(fs.readFileSync(absSpecPath, 'utf-8'));
            const stories: unknown[] = specJson.userStories ?? [];
            total = stories.length;
          } catch {
            // Spec file missing or unreadable — leave total as 0
          }

          // Query story_results for this run
          const counts = await query<StoryResultCountRow>(
            `SELECT status, COUNT(*)::text AS cnt
             FROM story_results
             WHERE run_id = $1
             GROUP BY status`,
            [run.id]
          );

          let passed = 0;
          let failed = 0;
          let inProgress = 0;

          for (const row of counts) {
            const c = parseInt(row.cnt, 10);
            if (row.status === 'pass') passed = c;
            else if (row.status === 'fail' || row.status === 'timeout') failed += c;
            // 'retry' status means currently in-progress (retrying)
          }

          // Stories in progress = total - passed - failed - skipped/excluded
          const completed = counts.reduce((sum, r) => sum + parseInt(r.cnt, 10), 0);
          inProgress = Math.max(0, total - completed);

          storyProgress = { passed, failed, inProgress, total };
        }

        return {
          id: run.id,
          specPath: run.spec_path,
          status: run.status as 'running' | 'queued',
          agent: run.agent_type,
          model: run.agent_model,
          startedAt: run.started_at,
          queuePosition: run.status === 'queued' ? run.queue_position : null,
          storyProgress,
        };
      })
    );
  }

  // ── Assemble response ────────────────────────────────────────────────────
  // Stub out sections not yet implemented by other stories
  const response: RecallResponse = {
    directionStack,
    memories: [],
    health: null,
    recentRuns: [],
    skills: [],
    workspaceContext: {
      schemaSnapshot: null,
      gitMemory: null,
    },
    metadata,
    activeRuns,
    meta: {
      totalTokens: Math.ceil(directionStack.length / 4),
      latencyMs: Date.now() - start,
      retrievalTier: 'cag',
      generatedAt: new Date().toISOString(),
    },
  };

  res.json(response);
});

export default router;
