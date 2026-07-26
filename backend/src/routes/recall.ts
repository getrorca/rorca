/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * recall.ts — GET /api/recall
 *
 * Single-call context retrieval for MCP and CLI consumers.
 * Returns direction stack, memories, health, recent runs, skills,
 * workspace context, metadata, and active runs in one payload.
 *
 * All 8 data fetchers run concurrently via Promise.all — each wrapped
 * in its own try-catch so a failure in one section doesn't crash the
 * entire response.
 */

import { Router, Request, Response, NextFunction } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as fsPromises from 'fs/promises';
import * as yaml from 'js-yaml';
import { query as dbQuery, queryOne } from '../db/index';
import { synthesizeDirectionStack } from '../lib/direction-stack';
import { retrieveContext } from '../lib/memory-router';
import { echolocate } from '../lib/workspace-echolocation';
import { parseFrontmatter, inferCategory } from '../lib/skill-registry';
import { ForbiddenError, ValidationError, NotFoundError } from '../lib/errors';
import {
  RecallQuerySchema,
  type RecallDebugMeta,
  type RecallMemoryEntry,
  type RecallResponse,
  type DumpResponse,
  type RunSummary,
  type ActiveRun,
  type StoryProgress,
  type SkillPreview,
  type SkillFull,
  type DirectionLayer,
  type WorkspaceMetadata,
  type RetrievalTier,
  type MemoryEntry,
} from './recall-types';
import type { EcholocationReport } from '../lib/workspace-echolocation';

const router = Router();

// ─── DB row shapes (internal) ────────────────────────────────────────────────

interface WorkspaceRow {
  id: string;
  label: string;
  path: string;
  domains: string;
}

interface RunRow {
  id: number;
  spec_path: string;
  status: string;
  agent_type: string;
  agent_model: string | null;
  started_at: string;
  finished_at: string | null;
  pass_count: string;
  fail_count: string;
  skip_count: string;
  total_stories: string;
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

interface MemoryRow {
  id: number;
  category: string;
  content: string;
  source_story_id: string | null;
  source_run_id: number | null;
  confidence: string;
  source: string | null;
  pinned: boolean;
  created_at: string;
}

// ─── Skills helpers ─────────────────────────────────────────────────────────

function truncateAtWord(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const truncated = text.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace <= 0) return truncated;
  return truncated.slice(0, lastSpace);
}

async function readSkillFiles(dirPath: string): Promise<Array<{ name: string; content: string }>> {
  let entries: string[];
  try {
    entries = await fsPromises.readdir(dirPath);
  } catch {
    return [];
  }
  const mdFiles = entries.filter(f => f.endsWith('.md'));
  const results = await Promise.all(
    mdFiles.map(async (filename) => {
      try {
        const content = await fsPromises.readFile(path.join(dirPath, filename), 'utf-8');
        return { name: path.basename(filename, '.md'), content };
      } catch {
        return null;
      }
    }),
  );
  return results.filter((r): r is { name: string; content: string } => r !== null);
}

function fileToPreview(name: string, content: string, source: string): SkillPreview {
  const parsed = parseFrontmatter(content);
  let description = '';
  let category: string | null = null;
  let tags: string[] = [];
  let bodyText = content;

  if (parsed) {
    try {
      const raw = yaml.load(parsed.yaml) as Record<string, unknown> | null;
      if (raw && typeof raw === 'object') {
        if (typeof raw['description'] === 'string') description = raw['description'];
        if (typeof raw['name'] === 'string') name = raw['name'];
        if (typeof raw['category'] === 'string') category = raw['category'].trim();
        if (Array.isArray(raw['tags'])) {
          tags = raw['tags'].filter((t: unknown): t is string => typeof t === 'string');
        } else if (typeof raw['tags'] === 'string') {
          tags = raw['tags'].split(',').map((t: string) => t.trim()).filter(Boolean);
        }
      }
    } catch {
      // YAML parse failure — treat entire content as body
    }
    bodyText = parsed.body;
  }

  if (!category) category = inferCategory(name, description);

  return { name, contentPreview: truncateAtWord(bodyText.trim(), 200), description, category, tags, source };
}

// ─── Section fetchers ───────────────────────────────────────────────────────

async function fetchDirectionStack(
  workspaceId: string,
  storyText?: string,
): Promise<{ directionStack: string; retrievalTier: RetrievalTier }> {
  const synthesized = await synthesizeDirectionStack(workspaceId, storyText ? { storyText } : undefined);
  return { directionStack: synthesized.text, retrievalTier: 'cag' };
}

function debugKeyBelongsToWorkspace(workspaceId: string, key: string | null | undefined): boolean {
  if (!key) return true;
  return key === `workspace:${workspaceId}`
    || key.includes(`:${workspaceId}::`)
    || key.startsWith(`invalid:memory:${workspaceId}::`);
}

function assertWorkspaceScopedDebug(
  workspaceId: string,
  memories: RecallMemoryEntry[],
): void {
  for (const memory of memories) {
    const canonicalKey = memory.debug?.tieBreak.canonicalKey;
    const sourceStoryKey = memory.debug?.tieBreak.sourceStoryKey;
    if (!debugKeyBelongsToWorkspace(workspaceId, canonicalKey) || !debugKeyBelongsToWorkspace(workspaceId, sourceStoryKey)) {
      throw new ForbiddenError('Debug retrieval output contained results outside the active workspace scope');
    }
  }
}

async function fetchMemories(
  workspaceId: string,
  category?: string,
  storyText?: string,
  debug = false,
): Promise<{ memories: RecallMemoryEntry[]; retrievalTier: RetrievalTier; debugMeta?: RecallDebugMeta }> {
  if (!storyText) {
    // No story text — return most recent 100 memories from DB (was 20, too few for full recall)
    const catFilter = category
      ? ' AND category = $2'
      : '';
    const params: (string | undefined)[] = [workspaceId];
    if (category) params.push(category);

    const rows = await dbQuery<MemoryRow>(
      `SELECT id, category, content, source_story_id, source_run_id, confidence, source, pinned, created_at
       FROM memories
       WHERE workspace_id = $1 AND deleted_at IS NULL${catFilter}
       ORDER BY pinned DESC, created_at DESC
       LIMIT 100`,
      params,
    );

    return {
      memories: rows.map(memoryRowToEntry),
      retrievalTier: 'none',
    };
  }

  // Story text provided — use retrieveContext to get scored, ranked memories
  const ctx = await retrieveContext(workspaceId, storyText, { includeGraph: true, explain: debug });

  let retrievalTier: RetrievalTier = ctx.meta.tier === 'cache' ? 'cag'
    : ctx.meta.tier === 'search' || ctx.meta.tier === 'hybrid' ? 'rag'
    : 'none';
  if (ctx.meta.graphHits > 0) retrievalTier = 'graph';

  // Fetch all non-deleted memories from DB (optionally filtered by category)
  const catFilter = category
    ? ' AND category = $2'
    : '';
  const params: (string | undefined)[] = [workspaceId];
  if (category) params.push(category);

  const dbRows = await dbQuery<MemoryRow>(
    `SELECT id, category, content, source_story_id, source_run_id, confidence, source, pinned, created_at
     FROM memories
     WHERE workspace_id = $1 AND deleted_at IS NULL${catFilter}
     ORDER BY created_at DESC`,
    params,
  );

  // Build maps for matching retrieval results back to DB rows.
  const idToRow = new Map<string, MemoryRow>();
  const contentToRow = new Map<string, MemoryRow>();
  for (const row of dbRows) {
    idToRow.set(String(row.id), row);
    contentToRow.set(row.content, row);
  }

  // Match scored memory items from retrieveContext against DB rows.
  // Prefer stable IDs from semantic search, then fall back to exact content.
  const matched: Array<{ entry: RecallMemoryEntry; score: number }> = [];
  for (const mem of ctx.memory) {
    const row = mem.id ? idToRow.get(mem.id) : undefined;
    const fallbackRow = row ?? contentToRow.get(mem.text);
    if (fallbackRow) {
      matched.push({
        entry: {
          ...memoryRowToEntry(fallbackRow),
          debug: mem.explainability,
        },
        score: mem.score,
      });
    }
  }

  // Sort by score descending, take top 30 semantically relevant (was 10, too few)
  matched.sort((a, b) => b.score - a.score);
  const topMemories = matched.slice(0, 30).map(m => m.entry);

  assertWorkspaceScopedDebug(workspaceId, topMemories);

  const firstExplainability = ctx.memory[0]?.explainability;
  const debugMeta = debug
    ? {
        scoringVersion: firstExplainability?.scoringVersion ?? null,
        retrievalMode: firstExplainability?.retrievalMode ?? null,
        telemetryId: ctx.meta.telemetryId ?? null,
        ontologyExplainability: ctx.meta.ontologyExplainability,
      }
    : undefined;

  return { memories: topMemories, retrievalTier, debugMeta };
}

function memoryRowToEntry(r: MemoryRow): MemoryEntry {
  return {
    date: new Date(r.created_at).toISOString().slice(0, 10),
    category: r.category as MemoryEntry['category'],
    title: r.content.slice(0, 100),
    rule: r.content,
    context: '',
    source: r.source || r.source_story_id || '',
  };
}

function fetchHealth(workspacePath: string): EcholocationReport | null {
  return echolocate(workspacePath);
}

async function fetchRecentRuns(workspaceId: string): Promise<RunSummary[]> {
  const sql = `
    SELECT
      pr.id,
      pr.spec_path,
      pr.status,
      COALESCE(pr.agent_type, 'claude') AS agent_type,
      pr.agent_model,
      pr.started_at,
      pr.finished_at,
      COALESCE(SUM(CASE WHEN sr.status = 'pass' THEN 1 ELSE 0 END), 0)::text AS pass_count,
      COALESCE(SUM(CASE WHEN sr.status = 'fail' THEN 1 ELSE 0 END), 0)::text AS fail_count,
      COALESCE(SUM(CASE WHEN sr.status IN ('skip', 'excluded') THEN 1 ELSE 0 END), 0)::text AS skip_count,
      COALESCE(COUNT(sr.id), 0)::text AS total_stories
    FROM pipeline_runs pr
    LEFT JOIN story_results sr ON sr.run_id = pr.id
    WHERE pr.workspace_id = $1
      AND pr.status IN ('done', 'failed', 'partial_failure', 'cancelled')
    GROUP BY pr.id
    ORDER BY pr.started_at DESC
    LIMIT 5
  `;
  const rows = await dbQuery<RunRow>(sql, [workspaceId]);
  return rows.map((r) => ({
    id: r.id,
    specPath: r.spec_path,
    status: r.status,
    agent: r.agent_type,
    model: r.agent_model,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    passedStories: Number(r.pass_count),
    failedStories: Number(r.fail_count),
    skippedStories: Number(r.skip_count),
    totalTokens: null,
    costUsd: null,
  }));
}

async function fetchSkills(workspacePath: string): Promise<SkillPreview[]> {
  const skillsDir = path.join(workspacePath, '.rorca', 'skills');
  const fsSkills = await readSkillFiles(skillsDir);

  const seen = new Map<string, SkillPreview>();
  for (const { name, content } of fsSkills) {
    const preview = fileToPreview(name, content, 'rorca-skills');
    seen.set(preview.name.toLowerCase(), preview);
  }

  const dbSkills = await dbQuery<{
    name: string;
    description: string;
    source: string;
    content: string;
    category: string | null;
    tags: string | null;
  }>('SELECT name, description, source, content, category, tags FROM installed_skills');

  for (const row of dbSkills) {
    const key = row.name.toLowerCase();
    if (seen.has(key)) continue;

    let tags: string[] = [];
    if (row.tags) {
      try { tags = JSON.parse(row.tags); } catch { tags = []; }
    }

    const parsed = parseFrontmatter(row.content);
    const bodyText = parsed ? parsed.body.trim() : row.content.trim();

    seen.set(key, {
      name: row.name,
      contentPreview: truncateAtWord(bodyText, 200),
      description: row.description,
      category: row.category || inferCategory(row.name, row.description),
      tags,
      source: row.source || 'db',
    });
  }

  return Array.from(seen.values());
}

async function fetchWorkspaceContext(workspaceId: string): Promise<{
  schemaSnapshot: string | null;
  gitMemory: string | null;
}> {
  const ctxRow = await queryOne<{
    schema_snapshot: string | null;
  }>(
    'SELECT schema_snapshot FROM workspace_context WHERE workspace_id = $1',
    [workspaceId],
  );
  return {
    schemaSnapshot: ctxRow?.schema_snapshot ?? null,
    gitMemory: null, // git_memory column dropped (migration 075)
  };
}

async function fetchActiveRuns(
  workspaceId: string,
  workspacePath: string,
): Promise<ActiveRun[]> {
  const runs = await dbQuery<PipelineRunRow>(
    `SELECT id, spec_path, status, agent_type, agent_model, started_at, queue_position
     FROM pipeline_runs
     WHERE workspace_id = $1 AND status IN ('running', 'queued')
     ORDER BY started_at ASC`,
    [workspaceId],
  );

  return Promise.all(
    runs.map(async (run): Promise<ActiveRun> => {
      let storyProgress: StoryProgress | null = null;

      if (run.status === 'running') {
        let total = 0;
        try {
          const absSpecPath = path.join(workspacePath, run.spec_path);
          const specJson = JSON.parse(fs.readFileSync(absSpecPath, 'utf-8'));
          const stories: unknown[] = specJson.userStories ?? [];
          total = stories.length;
        } catch {
          // Spec file missing or unreadable
        }

        const counts = await dbQuery<StoryResultCountRow>(
          `SELECT status, COUNT(*)::text AS cnt
           FROM story_results
           WHERE run_id = $1
           GROUP BY status`,
          [run.id],
        );

        let passed = 0;
        let failed = 0;
        for (const row of counts) {
          const c = parseInt(row.cnt, 10);
          if (row.status === 'pass') passed = c;
          else if (row.status === 'fail' || row.status === 'timeout') failed += c;
        }

        const completed = counts.reduce((sum, r) => sum + parseInt(r.cnt, 10), 0);
        const inProgress = Math.max(0, total - completed);

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
    }),
  );
}

// ─── Route ──────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/recall:
 *   get:
 *     operationId: getRecall
 *     summary: Semantic workspace context recall — use when asking "what do we know about X?" or bootstrapping a session
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Recall is a read-only workspace intelligence surface used by CLI and MCP flows to bootstrap context without crossing billing or admin boundaries."
 *     x-rorca-public-api: true
 *     description: >
 *       USE THIS for semantic memory search ("find memories about deployment", "what conventions exist for auth").
 *       Pass the `query` parameter to trigger 3-tier semantic retrieval (CAG cache → RAG embeddings → Knowledge Graph)
 *       which ranks memories by relevance, not just recency. Without `query`, returns a full brain dump.
 *       Returns direction stack, memories, health, recent runs, skills, workspace context, metadata, and active runs.
 *       DO NOT use this for paginated memory listing — use listMemoryItems instead.
 *       DO NOT use this for cross-source search (specs + stories + memories) — use hybridSearch instead.
 *     tags: [Recall]
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema:
 *           type: string
 *         description: Workspace ID to recall context for
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *           enum: [Architecture, Convention, Bug Fix, Decision, Pattern, Gotcha]
 *         description: Optional memory category filter
 *       - in: query
 *         name: includeRuns
 *         schema:
 *           type: string
 *           default: 'true'
 *         description: Include recent pipeline runs (default true)
 *       - in: query
 *         name: includeHealth
 *         schema:
 *           type: string
 *           default: 'true'
 *         description: Include workspace health report (default true)
 *       - in: query
 *         name: storyText
 *         schema:
 *           type: string
 *         description: Optional story text for semantic memory retrieval (legacy — prefer query)
 *       - in: query
 *         name: query
 *         schema:
 *           type: string
 *         description: Feature brief or task description — anchors CAG/RAG/graph retrieval to what you are building. Takes precedence over storyText.
 *       - in: query
 *         name: titlesOnly
 *         schema:
 *           type: string
 *           default: 'false'
 *         description: When true, strips full rule content from memories and returns titles only (~2K tokens vs ~50K for full dump).
 *     responses:
 *       200:
 *         description: Full recall payload
 *       400:
 *         description: Missing or invalid workspaceId
 *       404:
 *         description: Workspace not found
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
  const start = Date.now();

  // Validate query params
  const parsed = RecallQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map(i => i.message).join('; '),
    );
  }
  const { workspaceId, category, includeRuns, includeHealth, titlesOnly, debug } = parsed.data;
  // `query` is the preferred alias for brief-anchored retrieval; falls back to legacy `storyText`
  const storyText = parsed.data.query ?? parsed.data.storyText;
  if (debug && !storyText) {
    throw new ValidationError('debug=true is only supported for ranked recall requests that include query or storyText');
  }

  // Verify workspace exists (required before parallel fetchers)
  const workspace = await queryOne<WorkspaceRow>(
    'SELECT id, label, path, domains FROM workspaces WHERE id = $1',
    [workspaceId],
  );
  if (!workspace) {
    throw new NotFoundError(`Workspace ${workspaceId} not found`);
  }

  const metadata: WorkspaceMetadata = {
    id: workspace.id,
    label: workspace.label,
    path: workspace.path,
    domain: workspace.domains || null,
  };

  // ── Execute all 8 section fetchers concurrently ─────────────────────────

  const sectionTimings: Record<string, number> = {};

  const timed = async <T>(name: string, fn: () => Promise<T> | T): Promise<T | null> => {
    const t0 = Date.now();
    try {
      const result = await fn();
      sectionTimings[name] = Date.now() - t0;
      return result;
    } catch (err) {
      sectionTimings[name] = Date.now() - t0;
      if (err instanceof ValidationError || err instanceof ForbiddenError) {
        throw err;
      }
      console.warn(`[recall] ${name} failed (${sectionTimings[name]}ms):`, (err as Error).message);
      return null;
    }
  };

  const [
    directionResult,
    memoryResult,
    healthResult,
    recentRunsResult,
    skillsResult,
    workspaceContextResult,
    activeRunsResult,
  ] = await Promise.all([
    // 1. Direction stack synthesis
    timed('directionStack', () => fetchDirectionStack(workspaceId, storyText)),
    // 2. Memories (may trigger 3-tier retrieval if storyText provided)
    timed('memories', () => fetchMemories(workspaceId, category, storyText, debug)),
    // 3. Health / echolocation
    timed('health', () => includeHealth ? fetchHealth(workspace.path) : null),
    // 4. Recent completed runs
    timed('recentRuns', () => includeRuns ? fetchRecentRuns(workspaceId) : []),
    // 5. Installed skills
    timed('skills', () => fetchSkills(workspace.path)),
    // 6. Workspace context (schema snapshot)
    timed('workspaceContext', () => fetchWorkspaceContext(workspaceId)),
    // 7. Active/queued runs with story progress
    timed('activeRuns', () => includeRuns ? fetchActiveRuns(workspaceId, workspace.path) : []),
  ]);

  // ── Derive retrieval tier from whichever section produced the highest tier ─
  let retrievalTier: RetrievalTier = 'none';
  if (directionResult) retrievalTier = directionResult.retrievalTier;
  if (memoryResult) {
    // Memory tier can upgrade the overall tier
    const tierRank: Record<RetrievalTier, number> = { none: 0, cag: 1, rag: 2, graph: 3 };
    if (tierRank[memoryResult.retrievalTier] > tierRank[retrievalTier]) {
      retrievalTier = memoryResult.retrievalTier;
    }
  }

  // ── Assemble response ────────────────────────────────────────────────────
  const rawMemories = memoryResult?.memories ?? [];
  const memories = titlesOnly
    ? rawMemories.map(m => ({ ...m, rule: '', context: '' }))
    : rawMemories;

  const response: RecallResponse = {
    directionStack: directionResult?.directionStack ?? '',
    memories,
    health: healthResult ?? null,
    recentRuns: (recentRunsResult as RunSummary[] | null) ?? [],
    skills: (skillsResult as SkillPreview[] | null) ?? [],
    workspaceContext: workspaceContextResult ?? { schemaSnapshot: null, gitMemory: null },
    metadata,
    activeRuns: (activeRunsResult as ActiveRun[] | null) ?? [],
    meta: {
      totalTokens: 0,
      latencyMs: 0,
      retrievalTier,
      generatedAt: new Date().toISOString(),
      ...(debug && memoryResult?.debugMeta ? { debug: memoryResult.debugMeta } : {}),
    },
  };

  // Hard cap: MCP HTTP transport rejects responses > ~100K chars.
  // Progressively trim sections until serialized size fits.
  const MAX_RESPONSE_CHARS = 40_000;
  let serialized = JSON.stringify(response);

  // 1. Trim memories from the bottom (lowest priority)
  while (serialized.length > MAX_RESPONSE_CHARS && response.memories.length > 1) {
    response.memories = response.memories.slice(0, Math.max(1, Math.floor(response.memories.length * 0.8)));
    serialized = JSON.stringify(response);
  }

  // 2. Strip memory rule/context content
  if (serialized.length > MAX_RESPONSE_CHARS) {
    response.memories = response.memories.map(m => ({ ...m, rule: '', context: '' }));
    serialized = JSON.stringify(response);
  }

  // 3. Trim skills to previews only (drop full content)
  if (serialized.length > MAX_RESPONSE_CHARS && response.skills.length > 0) {
    response.skills = response.skills.slice(0, 10).map((s: SkillPreview) => ({ ...s, content: undefined } as SkillPreview));
    serialized = JSON.stringify(response);
  }

  // 4. Truncate direction stack
  if (serialized.length > MAX_RESPONSE_CHARS && response.directionStack.length > 10_000) {
    response.directionStack = response.directionStack.slice(0, 10_000) + '\n\n[truncated]';
    serialized = JSON.stringify(response);
  }

  // 5. Drop workspace context snapshots
  if (serialized.length > MAX_RESPONSE_CHARS) {
    response.workspaceContext = { schemaSnapshot: null, gitMemory: null };
    serialized = JSON.stringify(response);
  }

  // Compute token estimate over the full serialized response
  response.meta.totalTokens = Math.ceil(JSON.stringify(response).length / 4);
  response.meta.latencyMs = Date.now() - start;

  // Log individual section timings for verification
  console.log(
    `[recall] workspaceId=${workspaceId} total=${response.meta.latencyMs}ms sections=${JSON.stringify(sectionTimings)}`,
  );

  res.json(response);
  } catch (err) { next(err); }
});

// ─── Dump-specific fetchers (no limits, no truncation) ──────────────────────

async function fetchAllMemories(workspaceId: string): Promise<MemoryEntry[]> {
  const rows = await dbQuery<MemoryRow>(
    `SELECT id, category, content, source_story_id, source_run_id, confidence, source, pinned, created_at
     FROM memories
     WHERE workspace_id = $1 AND deleted_at IS NULL
     ORDER BY created_at DESC`,
    [workspaceId],
  );
  return rows.map(memoryRowToEntry);
}

interface DirectionLayerRow {
  layer: number;
  content_yaml: string;
  domain: string | null;
  workspace_id: string | null;
}

async function fetchAllDirectionLayers(workspaceId: string): Promise<DirectionLayer[]> {
  const rows = await dbQuery<DirectionLayerRow>(
    `SELECT layer, content_yaml, domain, workspace_id
     FROM direction_layers
     WHERE workspace_id = $1 OR (workspace_id IS NULL AND layer IN (1, 2))
     ORDER BY layer ASC`,
    [workspaceId],
  );
  return rows.map((r) => ({
    layer: r.layer,
    content: r.content_yaml,
    domain: r.domain,
    workspaceId: r.workspace_id,
  }));
}

async function fetchAllSkills(workspacePath: string): Promise<SkillFull[]> {
  const skillsDir = path.join(workspacePath, '.rorca', 'skills');
  const fsSkills = await readSkillFiles(skillsDir);

  const seen = new Map<string, SkillFull>();
  for (const { name, content } of fsSkills) {
    const parsed = parseFrontmatter(content);
    let description = '';
    let category: string | null = null;
    let tags: string[] = [];

    if (parsed) {
      try {
        const raw = yaml.load(parsed.yaml) as Record<string, unknown> | null;
        if (raw && typeof raw === 'object') {
          if (typeof raw['description'] === 'string') description = raw['description'];
          if (typeof raw['category'] === 'string') category = raw['category'].trim();
          if (Array.isArray(raw['tags'])) {
            tags = raw['tags'].filter((t: unknown): t is string => typeof t === 'string');
          }
        }
      } catch { /* YAML parse failure */ }
    }
    if (!category) category = inferCategory(name, description);

    seen.set(name.toLowerCase(), {
      name,
      content,
      description,
      category,
      tags,
      source: 'rorca-skills',
    });
  }

  const dbSkills = await dbQuery<{
    name: string;
    description: string;
    source: string;
    content: string;
    category: string | null;
    tags: string | null;
  }>('SELECT name, description, source, content, category, tags FROM installed_skills');

  for (const row of dbSkills) {
    const key = row.name.toLowerCase();
    if (seen.has(key)) continue;

    let tags: string[] = [];
    if (row.tags) {
      try { tags = JSON.parse(row.tags); } catch { tags = []; }
    }

    seen.set(key, {
      name: row.name,
      content: row.content,
      description: row.description,
      category: row.category || inferCategory(row.name, row.description),
      tags,
      source: row.source || 'db',
    });
  }

  return Array.from(seen.values());
}

async function fetchWorkspaceContextDump(workspaceId: string): Promise<{
  schemaSnapshot: string | null;
  gitMemory: string | null;
}> {
  try {
    const ctxRow = await queryOne<{
      schema_snapshot: string | null;
      git_memory: string | null;
    }>(
      'SELECT schema_snapshot, git_memory FROM workspace_context WHERE workspace_id = $1',
      [workspaceId],
    );
    return {
      schemaSnapshot: ctxRow?.schema_snapshot ?? null,
      gitMemory: ctxRow?.git_memory ?? null,
    };
  } catch {
    // git_memory column may have been dropped (migration 075)
    const ctxRow = await queryOne<{
      schema_snapshot: string | null;
    }>(
      'SELECT schema_snapshot FROM workspace_context WHERE workspace_id = $1',
      [workspaceId],
    );
    return {
      schemaSnapshot: ctxRow?.schema_snapshot ?? null,
      gitMemory: null,
    };
  }
}

async function fetchRecentRunsDump(workspaceId: string): Promise<RunSummary[]> {
  const sql = `
    SELECT
      pr.id,
      pr.spec_path,
      pr.status,
      COALESCE(pr.agent_type, 'claude') AS agent_type,
      pr.agent_model,
      pr.started_at,
      pr.finished_at,
      COALESCE(SUM(CASE WHEN sr.status = 'pass' THEN 1 ELSE 0 END), 0)::text AS pass_count,
      COALESCE(SUM(CASE WHEN sr.status = 'fail' THEN 1 ELSE 0 END), 0)::text AS fail_count,
      COALESCE(SUM(CASE WHEN sr.status IN ('skip', 'excluded') THEN 1 ELSE 0 END), 0)::text AS skip_count,
      COALESCE(COUNT(sr.id), 0)::text AS total_stories
    FROM pipeline_runs pr
    LEFT JOIN story_results sr ON sr.run_id = pr.id
    WHERE pr.workspace_id = $1
      AND pr.status IN ('done', 'failed', 'partial_failure', 'cancelled')
    GROUP BY pr.id
    ORDER BY pr.started_at DESC
    LIMIT 20
  `;
  const rows = await dbQuery<RunRow>(sql, [workspaceId]);
  return rows.map((r) => ({
    id: r.id,
    specPath: r.spec_path,
    status: r.status,
    agent: r.agent_type,
    model: r.agent_model,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    passedStories: Number(r.pass_count),
    failedStories: Number(r.fail_count),
    skippedStories: Number(r.skip_count),
    totalTokens: null,
    costUsd: null,
  }));
}

// ─── Dump Route ─────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/recall/dump:
 *   get:
 *     x-rorca-native-api: true
 *     x-rorca-rationale: "Intentional dashboard/native API operation; authenticated local-admin access only and never MCP-exposed by default."
 *     operationId: getRecallDump
 *     summary: Unfiltered brain export with no token budget or limits
 *     description: >
 *       Returns the complete workspace brain with no truncation, no LIMIT
 *       clauses on memories, full skill content (not previews), raw direction
 *       layers (L1-L3, not synthesized), and last 20 pipeline runs.
 *     tags: [Recall]
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema:
 *           type: string
 *         description: Workspace ID to dump
 *     responses:
 *       200:
 *         description: Full dump payload
 *       400:
 *         description: Missing or invalid workspaceId
 *       404:
 *         description: Workspace not found
 */
router.get('/dump', async (req: Request, res: Response) => {
  const start = Date.now();

  const workspaceId = req.query.workspaceId as string | undefined;
  if (!workspaceId || typeof workspaceId !== 'string' || workspaceId.trim().length === 0) {
    res.status(400).json({ error: 'workspaceId is required', code: 'VALIDATION_ERROR' });
    return;
  }

  const workspace = await queryOne<WorkspaceRow>(
    'SELECT id, label, path, domains AS domain FROM workspaces WHERE id = $1',
    [workspaceId],
  );
  if (!workspace) {
    res.status(404).json({ error: 'Workspace not found', code: 'NOT_FOUND' });
    return;
  }

  const metadata: WorkspaceMetadata = {
    id: workspace.id,
    label: workspace.label,
    path: workspace.path,
    domain: workspace.domains || null,
  };

  const sectionTimings: Record<string, number> = {};

  const timed = async <T>(name: string, fn: () => Promise<T> | T): Promise<T | null> => {
    const t0 = Date.now();
    try {
      const result = await fn();
      sectionTimings[name] = Date.now() - t0;
      return result;
    } catch (err) {
      sectionTimings[name] = Date.now() - t0;
      console.warn(`[recall/dump] ${name} failed (${sectionTimings[name]}ms):`, (err as Error).message);
      return null;
    }
  };

  const [
    memoriesResult,
    directionLayersResult,
    skillsResult,
    workspaceContextResult,
    recentRunsResult,
    activeRunsResult,
  ] = await Promise.all([
    timed('memories', () => fetchAllMemories(workspaceId)),
    timed('directionLayers', () => fetchAllDirectionLayers(workspaceId)),
    timed('skills', () => fetchAllSkills(workspace.path)),
    timed('workspaceContext', () => fetchWorkspaceContextDump(workspaceId)),
    timed('recentRuns', () => fetchRecentRunsDump(workspaceId)),
    timed('activeRuns', () => fetchActiveRuns(workspaceId, workspace.path)),
  ]);

  const response: DumpResponse = {
    memories: memoriesResult ?? [],
    directionLayers: directionLayersResult ?? [],
    skills: (skillsResult as SkillFull[] | null) ?? [],
    workspaceContext: workspaceContextResult ?? { schemaSnapshot: null, gitMemory: null },
    recentRuns: (recentRunsResult as RunSummary[] | null) ?? [],
    metadata,
    activeRuns: (activeRunsResult as ActiveRun[] | null) ?? [],
    meta: {
      latencyMs: Date.now() - start,
      generatedAt: new Date().toISOString(),
    },
  };

  console.log(
    `[recall/dump] workspaceId=${workspaceId} total=${response.meta.latencyMs}ms sections=${JSON.stringify(sectionTimings)}`,
  );

  res.json(response);
});

export default router;
