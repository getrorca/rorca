/**
 * recall.ts — Unified context recall endpoint for MCP and CLI consumers.
 *
 * GET /api/recall?workspaceId=<id>[&includeHealth=true][&includeRuns=true][&category=<cat>][&storyText=<text>]
 *
 * Returns all context sections in a single response: direction stack,
 * memories, health, recent runs, skills, workspace context, metadata,
 * and active runs.
 */

import { Router, Request, Response } from 'express';
import { query as dbQuery, queryOne } from '../db/index';
import { synthesizeDirectionStack } from '../lib/direction-stack';
import { readMemory, query as queryMemory } from '../lib/memory-ledger';
import { echolocate, type EcholocationReport } from '../lib/workspace-echolocation';
import { NotFoundError, ValidationError } from '../lib/errors';
import {
  RecallQuerySchema,
  type RecallResponse,
  type RecallHealth,
  type RunSummary,
  type ActiveRun,
  type SkillPreview,
  type WorkspaceMetadata,
} from './recall-types';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Path keys in EcholocationReport.contextFiles → RecallHealth.contextFiles named keys */
const CONTEXT_FILE_MAP: Record<string, keyof RecallHealth['contextFiles']> = {
  'CLAUDE.md': 'claudeMd',
  'AGENTS.md': 'agentsMd',
  'MEMORY.md': 'memoryMd',
  '.rorca/config.json': 'rorcaConfig',
};

function transformHealth(report: EcholocationReport): RecallHealth {
  const contextFiles: RecallHealth['contextFiles'] = {
    claudeMd: { exists: false, lineCount: 0 },
    agentsMd: { exists: false, lineCount: 0 },
    memoryMd: { exists: false, lineCount: 0 },
    rorcaConfig: { exists: false, lineCount: 0 },
  };

  for (const cf of report.contextFiles) {
    const key = CONTEXT_FILE_MAP[cf.path];
    if (key) {
      contextFiles[key] = { exists: cf.exists, lineCount: cf.lineCount ?? 0 };
    }
  }

  return {
    score: report.score,
    detectedStack: report.stack.map((s) => s.name),
    contextFiles,
    monorepoApps: report.monorepo.detected ? report.monorepo.packages : [],
    suggestions: report.suggestions,
  };
}

const router = Router();

/**
 * @swagger
 * /api/recall:
 *   get:
 *     summary: Unified context recall for MCP/CLI consumers
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: includeHealth
 *         schema: { type: string, default: 'true' }
 *       - in: query
 *         name: includeRuns
 *         schema: { type: string, default: 'true' }
 *       - in: query
 *         name: category
 *         schema: { type: string }
 *       - in: query
 *         name: storyText
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Recall response with all context sections
 */
router.get('/', async (req: Request, res: Response) => {
  const start = Date.now();

  // Validate query params
  const parsed = RecallQuerySchema.safeParse(req.query as unknown as Record<string, string>);
  if (!parsed.success) {
    const fieldErrors = parsed.error.flatten().fieldErrors;
    const details: Record<string, string> = {};
    for (const [k, v] of Object.entries(fieldErrors)) {
      if (v) details[k] = v.join(', ');
    }
    throw new ValidationError('Invalid query parameters', details);
  }

  const { workspaceId, category, includeRuns, includeHealth, storyText } = parsed.data;

  // Fetch workspace
  const workspace = await queryOne<{ id: number; label: string; path: string; domain: string | null }>(
    'SELECT id, label, path, domain FROM workspaces WHERE id = $1',
    [workspaceId],
  );
  if (!workspace) {
    throw new NotFoundError(`Workspace not found: ${workspaceId}`);
  }

  // ── Direction Stack ──────────────────────────────────────────────────────
  let directionStack = '';
  try {
    const synthesized = await synthesizeDirectionStack(workspaceId, { storyText });
    directionStack = synthesized.text;
  } catch {
    // Partial failure tolerance — return empty direction if synthesis fails
  }

  // ── Memories ─────────────────────────────────────────────────────────────
  let memories = readMemory(workspace.path);
  if (category) {
    memories = queryMemory(workspace.path, category);
  }

  // ── Health (echolocation) ────────────────────────────────────────────────
  let health: RecallResponse['health'] = null;
  if (includeHealth) {
    try {
      const report = echolocate(workspace.path);
      health = transformHealth(report);
    } catch {
      // Workspace path doesn't exist on disk or scan failed — partial failure
      health = null;
    }
  }

  // ── Recent Runs ──────────────────────────────────────────────────────────
  let recentRuns: RunSummary[] = [];
  let activeRuns: ActiveRun[] = [];
  if (includeRuns) {
    const runs = await dbQuery<{
      id: number;
      spec_path: string;
      status: string;
      agent: string;
      model: string | null;
      started_at: string;
      finished_at: string | null;
      passed_stories: number;
      failed_stories: number;
      skipped_stories: number;
      total_tokens: number | null;
      cost_usd: number | null;
    }>(
      `SELECT id, spec_path, status, agent, model, started_at, finished_at,
              COALESCE(passed_stories, 0) AS passed_stories,
              COALESCE(failed_stories, 0) AS failed_stories,
              COALESCE(skipped_stories, 0) AS skipped_stories,
              total_tokens, cost_usd
       FROM pipeline_runs
       WHERE workspace_id = $1
       ORDER BY started_at DESC
       LIMIT 10`,
      [workspaceId],
    );

    recentRuns = runs.map((r) => ({
      id: r.id,
      specPath: r.spec_path,
      status: r.status,
      agent: r.agent,
      model: r.model,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      passedStories: r.passed_stories,
      failedStories: r.failed_stories,
      skippedStories: r.skipped_stories,
      totalTokens: r.total_tokens,
      costUsd: r.cost_usd,
    }));

    activeRuns = runs
      .filter((r) => r.status === 'running' || r.status === 'queued')
      .map((r) => ({
        id: r.id,
        specPath: r.spec_path,
        status: r.status as 'running' | 'queued',
        agent: r.agent,
        model: r.model,
        startedAt: r.started_at,
        queuePosition: null,
        storiesCompleted: r.passed_stories + r.failed_stories + r.skipped_stories,
        storiesTotal: r.passed_stories + r.failed_stories + r.skipped_stories, // approximate
      }));
  }

  // ── Skills ───────────────────────────────────────────────────────────────
  let skills: SkillPreview[] = [];
  try {
    const dbSkills = await dbQuery<{
      name: string;
      description: string;
      category: string | null;
      tags: string;
      source: string;
    }>(
      `SELECT name, COALESCE(description, '') AS description, category,
              COALESCE(tags, '[]') AS tags, COALESCE(source, 'filesystem') AS source
       FROM skills
       WHERE workspace_id = $1
       LIMIT 50`,
      [workspaceId],
    );
    skills = dbSkills.map((s) => ({
      name: s.name,
      description: s.description,
      category: s.category,
      tags: typeof s.tags === 'string' ? JSON.parse(s.tags) : s.tags,
      source: s.source,
    }));
  } catch {
    // Skills table may not exist or query fails — partial failure
  }

  // ── Workspace Context ────────────────────────────────────────────────────
  let schemaSnapshot: string | null = null;
  let gitMemory: string | null = null;
  try {
    const ctx = await queryOne<{ schema_snapshot: string | null; git_memory: string | null }>(
      'SELECT schema_snapshot, git_memory FROM workspace_context WHERE workspace_id = $1',
      [workspaceId],
    );
    if (ctx) {
      schemaSnapshot = ctx.schema_snapshot;
      gitMemory = ctx.git_memory;
    }
  } catch {
    // workspace_context table may not exist — partial failure
  }

  // ── Metadata ─────────────────────────────────────────────────────────────
  const metadata: WorkspaceMetadata = {
    id: String(workspace.id),
    label: workspace.label,
    path: workspace.path,
    domain: workspace.domain,
  };

  // ── Assemble response ────────────────────────────────────────────────────
  const latencyMs = Date.now() - start;
  const totalTokens = Math.round(directionStack.length / 4); // rough estimate

  const response: RecallResponse = {
    directionStack,
    memories,
    health,
    recentRuns,
    skills,
    workspaceContext: { schemaSnapshot, gitMemory },
    metadata,
    activeRuns,
    meta: {
      totalTokens,
      latencyMs,
      retrievalTier: 'cag',
      generatedAt: new Date().toISOString(),
    },
  };

  res.json(response);
});

export default router;
