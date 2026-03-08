import { Router } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { db } from '../db/index';
import { validateBody } from '../lib/validate';
import { hydrateSchema } from '../lib/schema-hydrator';
import {
  gitMapStep,
  gitReduceStep,
  getLatestHash,
} from '../lib/git-hydrator';
import { chatComplete } from '../lib/llm-client';
import { validateDirectionYaml } from '../lib/direction-validator';
import { parsePaginationParams, paginateArray } from '../lib/paginate';
import { echolocate, computeHealthReport, discoverMonorepo, generateMonorepoCLAUDESection, inferSkillsFromStack } from '../lib/workspace-echolocation';
import { loadRorcaConfig, writeRorcaConfig, hasRorcaDir, ensureRorcaDirStructure, defaultRorcaConfig } from '../lib/rorca-config';
import type { RorcaConfig } from '../lib/rorca-config';
import { generateScaffoldPreview, writeScaffoldFiles } from '../lib/workspace-scaffold';
import type { ScaffoldFile } from '../lib/workspace-scaffold';
import { logger } from '../lib/logger';
import { requirePlan } from '../lib/require-plan';

const router = Router();

interface WorkspaceRow {
  id: string;
  label: string;
  path: string;
  domains: string;
  created_at: string;
  pr_template: string | null;
}

interface WorkspaceContextRow {
  workspace_id: string;
  schema_snapshot: string | null;
  schema_snapshot_at: string | null;
  schema_table_count: number;
  git_memory: string | null;
  git_memory_updated_at: string | null;
  last_ingested_commit_hash: string | null;
  git_commit_count: number;
}

function parseWorkspace(row: WorkspaceRow) {
  return {
    ...row,
    domains: JSON.parse(row.domains) as string[],
    pr_template: row.pr_template ?? null,
  };
}

/**
 * @swagger
 * /api/workspaces:
 *   post:
 *     tags: [Workspaces]
 *     summary: Register a new workspace
 *     operationId: createWorkspace
 *     description: >
 *       Registers a new workspace by path. Validates the filesystem path exists,
 *       creates the workspace record, auto-creates a default agent profile from
 *       L3 direction content, and runs echolocation on the workspace root.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [id, label, path, domains]
 *             properties:
 *               id: { type: string, example: "cashflow-ai" }
 *               label: { type: string, example: "CashflowAI" }
 *               path: { type: string, example: "/Users/dev/cashflow-ai" }
 *               domains: { type: array, items: { type: string }, example: ["saas"] }
 *     responses:
 *       201:
 *         description: Workspace created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 workspace: { $ref: '#/components/schemas/Workspace' }
 *       400: { description: "Missing fields or path not found" }
 *       409: { description: "Workspace already exists" }
 *   get:
 *     tags: [Workspaces]
 *     summary: List all registered workspaces
 *     operationId: listWorkspaces
 *     description: Returns a paginated list of all registered workspaces ordered by creation date descending.
 *     responses:
 *       200:
 *         description: List of workspaces
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 workspaces:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/Workspace' }
 */
const CreateWorkspaceSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  path: z.string().min(1),
  domains: z.array(z.string()),
});

router.post('/', validateBody(CreateWorkspaceSchema), requirePlan('workspaces'), (req, res) => {
  const { id, label, path, domains } = req.body;

  if (!fs.existsSync(path)) {
    res.status(400).json({ error: `Path does not exist on filesystem: ${path}` });
    return;
  }

  try {
    db.prepare(
      'INSERT INTO workspaces (id, label, path, domains) VALUES (?, ?, ?, ?)'
    ).run(id, label, path, JSON.stringify(domains));
  } catch (err: any) {
    if (err.message?.includes('UNIQUE constraint failed')) {
      res.status(409).json({ error: `Workspace '${id}' already exists` });
      return;
    }
    throw err;
  }

  db.prepare(
    "INSERT INTO wal_events (event_type, workspace_id) VALUES ('workspace_create', ?)"
  ).run(id);

  // V2-070: Auto-create default agent profile using workspace's L3 direction content
  const l3Row = db.prepare(
    `SELECT content_yaml FROM direction_layers WHERE layer = 3 AND workspace_id = ? AND COALESCE(domain, '') = '' LIMIT 1`
  ).get(id) as { content_yaml: string } | undefined;

  db.prepare(
    `INSERT OR IGNORE INTO agent_profiles (workspace_id, name, system_prompt_override, allowed_tools, is_active)
     VALUES (?, 'Default', ?, '[]', 1)`
  ).run(id, l3Row?.content_yaml || null);

  const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow;

  // CIE-001: Auto-run echolocation on workspace registration
  let health = null;
  try {
    health = echolocate(path);
    db.prepare(
      "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('echolocate', ?, ?)"
    ).run(id, JSON.stringify({
      score: health.score,
      stackCount: health.stack.length,
      missingCount: health.missing.length,
      monorepo: health.monorepo.detected,
    }));
  } catch {
    // Non-fatal — workspace still registers even if echolocation fails
  }

  const needsBootstrap = (health?.score ?? 0) < 40;
  res.status(201).json({ workspace: parseWorkspace(row), health, needsBootstrap });
});

// GET /api/workspaces
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM workspaces ORDER BY created_at DESC').all() as WorkspaceRow[];
  const pagination = parsePaginationParams(req);
  res.json(paginateArray(rows.map(parseWorkspace), pagination, { cursorKey: (w) => w.id }));
});

/**
 * @swagger
 * /api/workspaces/{id}/context:
 *   get:
 *     tags: [Workspaces]
 *     summary: Get workspace hydrated context (schema + git)
 *     operationId: getWorkspaceContext
 *     description: >
 *       Returns the hydrated context for a workspace, including schema snapshot,
 *       table count, git memory, last ingested commit hash, and git commit count.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Workspace context
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 schemaSnapshot: { type: string, nullable: true }
 *                 schemaTableCount: { type: integer, nullable: true }
 *                 gitMemory: { type: string, nullable: true }
 *                 lastIngestedCommitHash: { type: string, nullable: true }
 *                 gitCommitCount: { type: integer, nullable: true }
 */
router.get('/:id/context', (req, res) => {
  const row = db.prepare(
    'SELECT * FROM workspace_context WHERE workspace_id = ?'
  ).get(req.params.id) as WorkspaceContextRow | undefined;

  res.json({
    schemaSnapshot: row?.schema_snapshot ?? null,
    schemaTableCount: row?.schema_table_count ?? null,
    gitMemory: row?.git_memory ?? null,
    lastIngestedCommitHash: row?.last_ingested_commit_hash ?? null,
    gitCommitCount: row?.git_commit_count ?? null,
  });
});

/**
 * @swagger
 * /api/workspaces/{id}/hydrate:
 *   post:
 *     tags: [Workspaces]
 *     summary: Hydrate workspace context (schema and/or git)
 *     operationId: hydrateWorkspaceContext
 *     description: >
 *       Ingests schema and/or git history for a workspace. Schema hydration scans
 *       for database tables; git hydration uses LLM map-reduce over recent commits
 *       to build a memory summary. Supports delta ingestion from last known commit hash.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               types:
 *                 type: array
 *                 items: { type: string, enum: [schema, git] }
 *                 default: [schema, git]
 *     responses:
 *       200:
 *         description: Hydration result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 schema:
 *                   type: object
 *                   properties:
 *                     tableCount: { type: integer }
 *                     snapshot_at: { type: string, format: date-time, nullable: true }
 *                 git:
 *                   type: object
 *                   properties:
 *                     commitCount: { type: integer }
 *                     memory_updated_at: { type: string, format: date-time, nullable: true }
 *                     newCommits: { type: integer }
 *       404: { description: "Workspace not found" }
 */
router.post('/:id/hydrate', async (req, res) => {
  const { id } = req.params;
  const types: string[] = req.body.types ?? ['schema', 'git'];

  // 1. Fetch workspace
  const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow | undefined;
  if (!workspace) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }

  // 2. Fetch existing workspace_context (may not exist yet)
  const existingCtx = db.prepare(
    'SELECT * FROM workspace_context WHERE workspace_id = ?'
  ).get(id) as WorkspaceContextRow | undefined;

  const result: {
    ok: boolean;
    schema?: { tableCount: number; snapshot_at: string | null };
    git?: { commitCount: number; memory_updated_at: string | null; newCommits: number };
  } = { ok: true };

  // 3. Schema hydration
  if (types.includes('schema')) {
    const schemaResult = hydrateSchema(workspace.path);
    const snapshotAt = new Date().toISOString();

    db.prepare(
      `INSERT INTO workspace_context (workspace_id, schema_snapshot, schema_table_count, schema_snapshot_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET
         schema_snapshot = excluded.schema_snapshot,
         schema_table_count = excluded.schema_table_count,
         schema_snapshot_at = excluded.schema_snapshot_at`
    ).run(id, schemaResult.snapshot || null, schemaResult.tableNames.length, snapshotAt);

    db.prepare(
      "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('hydrate_schema', ?, ?)"
    ).run(id, JSON.stringify({ tableCount: schemaResult.tableNames.length }));

    if (schemaResult.tableNames.length === 0) {
      logger.warn(`[Hydrate] Schema hydration returned 0 tables for workspace ${id}`);
    }

    result.schema = { tableCount: schemaResult.tableNames.length, snapshot_at: snapshotAt };
  }

  // 4. Git hydration
  if (types.includes('git')) {
    const lastHash = existingCtx?.last_ingested_commit_hash ?? undefined;

    let summaries;
    try {
      summaries = await gitMapStep({
        workspacePath: workspace.path,
        fromHash: lastHash,
      });
    } catch (err: any) {
      if (err.message?.includes('Not a git repository')) {
        res.status(422).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: `Git map step failed: ${err.message}` });
      return;
    }

    const newCommits = summaries.reduce((acc, s) => acc + s.commitCount, 0);
    let gitMemory: string;

    if (newCommits > 0) {
      try {
        gitMemory = await gitReduceStep({
          summaries,
          workspaceLabel: workspace.label,
        });
      } catch (err: any) {
        res.status(502).json({ error: `LLM call failed during git reduce: ${err.message}` });
        return;
      }

      // Delta vs fresh: if lastHash was set, append; otherwise replace
      if (lastHash && existingCtx?.git_memory) {
        gitMemory = existingCtx.git_memory + '\n\n' + gitMemory;
      }
    } else {
      gitMemory = existingCtx?.git_memory ?? '';
    }

    const latestHash = getLatestHash(summaries) ?? existingCtx?.last_ingested_commit_hash ?? null;
    const totalCommitCount = (existingCtx?.git_commit_count ?? 0) + newCommits;
    const memoryUpdatedAt = newCommits > 0 ? new Date().toISOString() : (existingCtx?.git_memory_updated_at ?? null);

    db.prepare(
      `INSERT INTO workspace_context (workspace_id, git_memory, last_ingested_commit_hash, git_memory_updated_at, git_commit_count)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET
         git_memory = excluded.git_memory,
         last_ingested_commit_hash = excluded.last_ingested_commit_hash,
         git_memory_updated_at = excluded.git_memory_updated_at,
         git_commit_count = excluded.git_commit_count`
    ).run(id, gitMemory || null, latestHash, memoryUpdatedAt, totalCommitCount);

    db.prepare(
      "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('hydrate_git', ?, ?)"
    ).run(id, JSON.stringify({ commitCount: totalCommitCount, newCommits }));

    result.git = { commitCount: totalCommitCount, memory_updated_at: memoryUpdatedAt, newCommits };
  }

  res.json(result);
});

/**
 * @swagger
 * /api/workspaces/{id}/files:
 *   get:
 *     tags: [Workspaces]
 *     summary: Check which files exist in a workspace
 *     operationId: checkWorkspaceFiles
 *     description: >
 *       Checks the existence of specific files or glob patterns within a workspace's
 *       filesystem path. Returns the list of matching files that exist.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: patterns
 *         required: true
 *         schema: { type: string }
 *         description: Comma-separated file paths or glob patterns
 *         example: "README.md,CLAUDE.md"
 *     responses:
 *       200:
 *         description: List of matching files
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 exists:
 *                   type: array
 *                   items: { type: string }
 *       404: { description: "Workspace not found" }
 */
router.get('/:id/files', (req, res) => {
  const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.params.id) as WorkspaceRow | undefined;
  if (!workspace) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }

  const patternsParam = (req.query.patterns as string) || '';
  const patterns = patternsParam.split(',').map(p => p.trim()).filter(Boolean);

  const exists: string[] = [];

  for (const pattern of patterns) {
    if (pattern.includes('*')) {
      try {
        const parts = pattern.split('/');
        const dir = parts.slice(0, -1).join('/') || '.';
        const ext = parts[parts.length - 1].replace(/\*/g, '');
        const fullDir = path.join(workspace.path, dir);

        if (fs.existsSync(fullDir) && fs.statSync(fullDir).isDirectory()) {
          const scanDir = (dirPath: string, recursive: boolean) => {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            for (const entry of entries) {
              const fullPath = path.join(dirPath, entry.name);
              if (entry.isFile() && entry.name.endsWith(ext)) {
                exists.push(path.relative(workspace.path, fullPath));
              } else if (entry.isDirectory() && recursive) {
                scanDir(fullPath, true);
              }
            }
          };
          scanDir(fullDir, pattern.includes('**'));
        }
      } catch {
        // Skip invalid patterns
      }
    } else {
      const fullPath = path.join(workspace.path, pattern);
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        exists.push(pattern);
      }
    }
  }

  res.json({ exists });
});

/**
 * @swagger
 * /api/workspaces/{id}:
 *   get:
 *     tags: [Workspaces]
 *     summary: Get a single workspace
 *     operationId: getWorkspace
 *     description: Returns the full details of a single workspace by its ID.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Workspace details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 workspace: { $ref: '#/components/schemas/Workspace' }
 *       404: { description: "Workspace not found" }
 *   patch:
 *     tags: [Workspaces]
 *     summary: Update workspace settings
 *     operationId: updateWorkspace
 *     description: >
 *       Updates one or more workspace fields (label, path, domains, pr_template).
 *       Only provided fields are updated; omitted fields remain unchanged.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               pr_template: { type: string, nullable: true }
 *     responses:
 *       200:
 *         description: Updated workspace
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 workspace: { $ref: '#/components/schemas/Workspace' }
 *       404: { description: "Workspace not found" }
 *   delete:
 *     tags: [Workspaces]
 *     summary: Delete a workspace
 *     operationId: deleteWorkspace
 *     description: Deletes a workspace record by ID and emits a workspace_delete WAL event.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       204: { description: "Deleted" }
 */
router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.params.id) as WorkspaceRow | undefined;
  if (!row) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }
  res.json({ workspace: parseWorkspace(row) });
});

// PATCH /api/workspaces/:id — Update workspace settings
router.patch('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.params.id) as WorkspaceRow | undefined;
  if (!row) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }

  const { label, path: wsPath, domains, pr_template } = req.body;

  if (label !== undefined) {
    db.prepare('UPDATE workspaces SET label = ? WHERE id = ?').run(String(label), req.params.id);
  }

  if (wsPath !== undefined) {
    if (!fs.existsSync(wsPath)) {
      res.status(400).json({ error: `Path does not exist on filesystem: ${wsPath}` });
      return;
    }
    db.prepare('UPDATE workspaces SET path = ? WHERE id = ?').run(String(wsPath), req.params.id);
  }

  if (domains !== undefined) {
    db.prepare('UPDATE workspaces SET domains = ? WHERE id = ?').run(JSON.stringify(domains), req.params.id);
  }

  if (pr_template !== undefined) {
    const value = pr_template === null || pr_template === '' ? null : String(pr_template);
    db.prepare('UPDATE workspaces SET pr_template = ? WHERE id = ?').run(value, req.params.id);
  }

  const updated = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.params.id) as WorkspaceRow;
  res.json({ workspace: parseWorkspace(updated) });
});

/**
 * @swagger
 * /api/workspaces/{id}/pipeline-config:
 *   get:
 *     tags: [Workspaces]
 *     summary: Get pipeline configuration for a workspace
 *     operationId: getWorkspacePipelineConfig
 *     description: >
 *       Returns the pipeline configuration for a workspace, including auto-worktree,
 *       story timeout, max retries, and default parallelism settings.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Pipeline configuration
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 config:
 *                   type: object
 *                   properties:
 *                     autoWorktree: { type: boolean }
 *                     storyTimeoutMin: { type: integer }
 *                     maxRetries: { type: integer }
 *                     defaultParallelism: { type: integer }
 *       404: { description: "Workspace not found" }
 */
router.get('/:id/pipeline-config', (req, res) => {
  const row = db.prepare('SELECT pipeline_config, default_parallelism FROM workspaces WHERE id = ?').get(req.params.id) as { pipeline_config: string; default_parallelism: number } | undefined;
  if (!row) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }
  const config = JSON.parse(row.pipeline_config || '{}');
  res.json({
    config: {
      autoWorktree: config.autoWorktree ?? true,
      storyTimeoutMin: config.storyTimeoutMin ?? 45,
      maxRetries: config.maxRetries ?? 0,
      defaultParallelism: row.default_parallelism ?? 1,
    },
  });
});

/**
 * @swagger
 * /api/workspaces/{id}/pipeline-config:
 *   put:
 *     tags: [Workspaces]
 *     summary: Update pipeline configuration for a workspace
 *     operationId: updateWorkspacePipelineConfig
 *     description: >
 *       Updates the pipeline configuration for a workspace. Supports setting
 *       auto-worktree, story timeout in minutes, max retries, and default
 *       parallelism (clamped between 1 and 10).
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               autoWorktree: { type: boolean }
 *               storyTimeoutMin: { type: integer }
 *               maxRetries: { type: integer }
 *               defaultParallelism: { type: integer, minimum: 1, maximum: 10 }
 *     responses:
 *       200:
 *         description: Configuration updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *       404: { description: "Workspace not found" }
 */
router.put('/:id/pipeline-config', (req, res) => {
  const row = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(req.params.id) as { id: string } | undefined;
  if (!row) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }
  const { autoWorktree, storyTimeoutMin, maxRetries, defaultParallelism } = req.body;
  const config = JSON.stringify({ autoWorktree, storyTimeoutMin, maxRetries });
  if (defaultParallelism !== undefined) {
    const p = Math.max(1, Math.min(10, Math.floor(Number(defaultParallelism) || 1)));
    db.prepare('UPDATE workspaces SET pipeline_config = ?, default_parallelism = ? WHERE id = ?').run(config, p, req.params.id);
  } else {
    db.prepare('UPDATE workspaces SET pipeline_config = ? WHERE id = ?').run(config, req.params.id);
  }
  res.json({ ok: true });
});

/**
 * @swagger
 * /api/workspaces/{id}/stats:
 *   get:
 *     tags: [Workspaces]
 *     summary: Get summary stats for a workspace
 *     operationId: getWorkspaceStats
 *     description: >
 *       Returns aggregated statistics for a workspace including spec counts
 *       (pending/approved), pipeline run counts (total/active/completed/failed),
 *       story pass/fail rates, and last activity timestamp.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Workspace summary statistics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 workspaceId: { type: string }
 *                 specs:
 *                   type: object
 *                   properties:
 *                     pending: { type: integer }
 *                     approved: { type: integer }
 *                     total: { type: integer }
 *                 runs:
 *                   type: object
 *                   properties:
 *                     total: { type: integer }
 *                     active: { type: integer }
 *                     completed: { type: integer }
 *                     failed: { type: integer }
 *                     lastRunAt: { type: string, format: date-time, nullable: true }
 *                 stories:
 *                   type: object
 *                   properties:
 *                     total: { type: integer }
 *                     passed: { type: integer }
 *                     failed: { type: integer }
 *                     passRate: { type: integer, minimum: 0, maximum: 100 }
 *                 lastActivity: { type: string, format: date-time, nullable: true }
 *       404: { description: "Workspace not found" }
 */
router.get('/:id/stats', (req, res) => {
  const workspaceId = req.params.id;
  const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId) as WorkspaceRow | undefined;
  if (!row) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }

  // Count specs (pending + approved) from filesystem
  let pendingSpecs = 0;
  let approvedSpecs = 0;
  const pendingDir = path.join(row.path, 'forge/specs/pending');
  const approvedDir = path.join(row.path, 'forge/specs/approved');
  if (fs.existsSync(pendingDir)) {
    pendingSpecs = fs.readdirSync(pendingDir).filter(f => f.endsWith('.json')).length;
  }
  if (fs.existsSync(approvedDir)) {
    approvedSpecs = fs.readdirSync(approvedDir).filter(f => f.endsWith('.json')).length;
  }

  // Pipeline run stats
  const runStats = db.prepare(`
    SELECT
      COUNT(*) AS total_runs,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS active_runs,
      SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS completed_runs,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_runs,
      MAX(started_at) AS last_run_at
    FROM pipeline_runs WHERE workspace_id = ?
  `).get(workspaceId) as {
    total_runs: number;
    active_runs: number;
    completed_runs: number;
    failed_runs: number;
    last_run_at: string | null;
  };

  // Story pass rate
  const storyStats = db.prepare(`
    SELECT
      COUNT(*) AS total_stories,
      SUM(CASE WHEN sr.status = 'pass' THEN 1 ELSE 0 END) AS passed_stories,
      SUM(CASE WHEN sr.status = 'fail' THEN 1 ELSE 0 END) AS failed_stories
    FROM story_results sr
    JOIN pipeline_runs pr ON sr.run_id = pr.id
    WHERE pr.workspace_id = ?
  `).get(workspaceId) as {
    total_stories: number;
    passed_stories: number;
    failed_stories: number;
  };

  const passRate = storyStats.total_stories > 0
    ? Math.round((storyStats.passed_stories / storyStats.total_stories) * 100)
    : 0;

  // Last activity from WAL
  const lastActivity = db.prepare(
    'SELECT MAX(created_at) AS last_at FROM wal_events WHERE workspace_id = ?'
  ).get(workspaceId) as { last_at: string | null };

  res.json({
    workspaceId,
    specs: { pending: pendingSpecs, approved: approvedSpecs, total: pendingSpecs + approvedSpecs },
    runs: {
      total: runStats.total_runs,
      active: runStats.active_runs,
      completed: runStats.completed_runs,
      failed: runStats.failed_runs,
      lastRunAt: runStats.last_run_at,
    },
    stories: {
      total: storyStats.total_stories,
      passed: storyStats.passed_stories,
      failed: storyStats.failed_stories,
      passRate,
    },
    lastActivity: lastActivity.last_at ?? runStats.last_run_at,
  });
});

/**
 * @swagger
 * /api/workspaces/{id}/team-members:
 *   get:
 *     tags: [Workspaces]
 *     summary: Get team members for a workspace
 *     operationId: getWorkspaceTeamMembers
 *     description: >
 *       Returns the team linked to this workspace via workspace_access, along with
 *       all team members and their roles. If no team is linked, returns an empty
 *       members array with teamScoped set to false.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Team members for the workspace
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 teamScoped: { type: boolean }
 *                 team:
 *                   type: object
 *                   nullable: true
 *                   properties:
 *                     id: { type: string }
 *                     name: { type: string }
 *                     slug: { type: string }
 *                     permission: { type: string }
 *                 members:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       userId: { type: string }
 *                       email: { type: string }
 *                       displayName: { type: string }
 *                       role: { type: string }
 *                       joinedAt: { type: string, format: date-time }
 *                       acceptedAt: { type: string, format: date-time, nullable: true }
 *                       lastActiveAt: { type: string, format: date-time, nullable: true }
 *       404: { description: "Workspace not found" }
 */
router.get('/:id/team-members', (req, res) => {
  const workspaceId = req.params.id;
  const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId) as WorkspaceRow | undefined;
  if (!row) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }

  // Find team linked to this workspace via workspace_access
  const access = db.prepare(
    'SELECT wa.team_id, wa.permission, t.name AS team_name, t.slug AS team_slug FROM workspace_access wa JOIN teams t ON wa.team_id = t.id WHERE wa.workspace_id = ?'
  ).get(workspaceId) as { team_id: string; permission: string; team_name: string; team_slug: string } | undefined;

  if (!access) {
    res.json({ teamScoped: false, team: null, members: [] });
    return;
  }

  const members = db.prepare(`
    SELECT
      tm.user_id AS userId,
      u.email,
      u.display_name AS displayName,
      tm.role,
      tm.invited_at AS joinedAt,
      tm.accepted_at AS acceptedAt,
      tm.last_active_at AS lastActiveAt
    FROM team_members tm
    JOIN users u ON tm.user_id = u.id
    WHERE tm.team_id = ?
    ORDER BY tm.invited_at ASC
  `).all(access.team_id) as Array<{
    userId: string;
    email: string;
    displayName: string;
    role: string;
    joinedAt: string;
    acceptedAt: string | null;
    lastActiveAt: string | null;
  }>;

  res.json({
    teamScoped: true,
    team: { id: access.team_id, name: access.team_name, slug: access.team_slug, permission: access.permission },
    members,
  });
});

/**
 * @swagger
 * /api/workspaces/{id}/scan-direction:
 *   post:
 *     tags: [Workspaces]
 *     summary: Scan repo and generate draft direction layers
 *     operationId: scanWorkspaceDirection
 *     description: >
 *       Scans the workspace repository structure (package.json, CLAUDE.md, README.md,
 *       pyproject.toml, Cargo.toml, go.mod, tsconfig.json, and top-level directories)
 *       and uses an LLM to generate draft L1/L2/L3 direction layer content. Returns
 *       drafted YAML for each layer along with confidence level and L3 validation results.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Draft direction layers generated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 l1Draft: { type: string }
 *                 l2Draft: { type: string }
 *                 l3Draft: { type: string }
 *                 confidence: { type: string, enum: [low, medium, high] }
 *                 filesScanned: { type: array, items: { type: string } }
 *                 dirCount: { type: integer }
 *                 l3Valid: { type: boolean }
 *                 l3Errors: { type: array, items: { type: string } }
 *                 usage: { type: object }
 *       400: { description: "Workspace path does not exist" }
 *       404: { description: "Workspace not found" }
 *       500: { description: "Repo scan failed" }
 *       502: { description: "LLM returned invalid or incomplete response" }
 */
router.post('/:id/scan-direction', async (req, res) => {
  const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.params.id) as WorkspaceRow | undefined;
  if (!workspace) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }

  if (!fs.existsSync(workspace.path)) {
    res.status(400).json({ error: `Workspace path does not exist: ${workspace.path}` });
    return;
  }

  try {
    // 1. Scan key files from the workspace
    const scannedFiles: Record<string, string> = {};
    const filesToScan = ['package.json', 'CLAUDE.md', 'README.md', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'tsconfig.json'];

    for (const filename of filesToScan) {
      const filePath = path.join(workspace.path, filename);
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const content = fs.readFileSync(filePath, 'utf-8');
        // Truncate large files to avoid token explosion
        scannedFiles[filename] = content.length > 4000 ? content.slice(0, 4000) + '\n... (truncated)' : content;
      }
    }

    // 2. Get top-level directory listing (max 500 entries per AC)
    let dirListing: string[] = [];
    try {
      const entries = fs.readdirSync(workspace.path, { withFileTypes: true });
      dirListing = entries
        .slice(0, 500)
        .map(e => e.isDirectory() ? `${e.name}/` : e.name)
        .filter(name => !name.startsWith('.'));
    } catch {
      // Non-fatal — directory listing is supplementary
    }

    // 3. Determine confidence based on what was found
    const foundFiles = Object.keys(scannedFiles);
    let confidence: 'low' | 'medium' | 'high' = 'low';
    if (foundFiles.length >= 3) confidence = 'high';
    else if (foundFiles.length >= 1) confidence = 'medium';

    // 4. Build LLM prompt
    const fileContext = foundFiles.length > 0
      ? foundFiles.map(f => `--- ${f} ---\n${scannedFiles[f]}`).join('\n\n')
      : '(no recognized project files found)';

    const prompt = `=== INSTRUCTIONS: READ THIS FIRST ===
You MUST return ONLY a JSON object. No markdown fences, no explanation, no preamble.
The JSON object must have exactly three keys: "l1", "l2", "l3".
Each value is a string containing valid YAML for that direction layer.

=== CONTEXT ===
You are analyzing a software repository to auto-generate a "Direction Stack" — a 3-layer context cascade that guides AI code generation.

L1 (Global Standards): Engineering principles, coding style, output format preferences, testing philosophy. Plain text or YAML.

L2 (Domain Profile): Domain-specific knowledge — industry concepts, regulatory constraints, business terminology. Plain text or YAML.

L3 (Project Brief): Project-specific context. MUST be a YAML mapping with these required fields:
  - name: string (project name)
  - type: string (e.g. "web-app", "api", "cli", "mobile-app")
  - stack: array of strings (technologies used)
  - purpose: string (what the project does)
  - key_modules: array of strings (main components/modules)
Additional optional L3 fields: constraints, deployment_target, integrations

=== REPOSITORY DATA ===
Repository name: ${path.basename(workspace.path)}
Workspace label: ${workspace.label}
Workspace domains: ${JSON.parse(workspace.domains).join(', ') || '(none)'}

Files found:
${fileContext}

Top-level directory structure:
${dirListing.join('\n') || '(empty)'}

=== OUTPUT FORMAT ===
Return a JSON object with exactly this structure (no markdown, no fences):
{
  "l1": "the L1 YAML content as a string",
  "l2": "the L2 YAML content as a string",
  "l3": "the L3 YAML content as a string"
}

Infer the tech stack, project purpose, coding conventions, and domain from the scanned files. Be specific — use actual dependency names, real directory paths, and concrete conventions you can observe. L3 MUST include name, type, stack, purpose, and key_modules fields.`;

    const result = await chatComplete([{ role: 'user', content: prompt }]);
    let text = result.text.trim();

    // Strip markdown fences if LLM wrapped them
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    }

    let parsed: { l1: string; l2: string; l3: string };
    try {
      parsed = JSON.parse(text);
    } catch {
      res.status(502).json({ error: 'LLM returned invalid JSON', raw: text.slice(0, 500) });
      return;
    }

    if (!parsed.l1 || !parsed.l2 || !parsed.l3) {
      res.status(502).json({ error: 'LLM response missing required l1/l2/l3 keys', raw: text.slice(0, 500) });
      return;
    }

    // Validate L3 against direction schema
    const l3Validation = validateDirectionYaml(3, parsed.l3);

    // WAL event
    db.prepare(
      "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('direction_scan', ?, ?)"
    ).run(req.params.id, JSON.stringify({ confidence, filesScanned: foundFiles }));

    res.json({
      l1Draft: parsed.l1,
      l2Draft: parsed.l2,
      l3Draft: parsed.l3,
      confidence,
      filesScanned: foundFiles,
      dirCount: dirListing.length,
      l3Valid: l3Validation.valid,
      l3Errors: l3Validation.errors,
      usage: result.usage,
    });
  } catch (err: any) {
    logger.error('[scan-direction] error:', err.message);
    res.status(500).json({ error: err.message || 'Repo scan failed' });
  }
});

/**
 * @swagger
 * /api/workspaces/{id}/health:
 *   get:
 *     tags: [Workspaces]
 *     summary: Get workspace health report with component breakdown
 *     operationId: getWorkspaceHealth
 *     description: >
 *       CIE-012: Returns context/intent completeness score (0-100%) with per-component
 *       breakdown showing CLAUDE.md depth, AGENTS.md roles, config scopes, MEMORY.md
 *       entries, and skill file count. Appends score to health history log.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Health report with component breakdown
 *       404: { description: "Workspace not found" }
 *       400: { description: "Workspace path does not exist" }
 */
router.get('/:id/health', (req, res) => {
  const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.params.id) as WorkspaceRow | undefined;
  if (!workspace) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }

  if (!fs.existsSync(workspace.path)) {
    res.status(400).json({ error: `Workspace path does not exist: ${workspace.path}` });
    return;
  }

  try {
    const report = computeHealthReport(workspace.path);

    // Append to health history log
    const memoryDir = path.join(workspace.path, '.rorca', 'memory');
    const logPath = path.join(memoryDir, 'health-log.json');
    try {
      if (!fs.existsSync(memoryDir)) {
        fs.mkdirSync(memoryDir, { recursive: true });
      }
      let history: Array<{ score: number; timestamp: string }> = [];
      if (fs.existsSync(logPath)) {
        history = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
      }
      // Only append if score changed or > 1 hour since last entry
      const last = history[history.length - 1];
      const now = new Date().toISOString();
      if (!last || last.score !== report.score || (Date.now() - new Date(last.timestamp).getTime() > 3600_000)) {
        history.push({ score: report.score, timestamp: now });
        // Keep last 100 entries
        if (history.length > 100) history = history.slice(-100);
        fs.writeFileSync(logPath, JSON.stringify(history, null, 2));
      }
    } catch {
      // Non-fatal: history tracking failure doesn't block response
    }

    // Read trend for response
    let trend: Array<{ score: number; timestamp: string }> = [];
    try {
      if (fs.existsSync(logPath)) {
        trend = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
      }
    } catch {}

    res.json({ ...report, trend });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Health check failed' });
  }
});

/**
 * @swagger
 * /api/workspaces/{id}/echolocate:
 *   post:
 *     tags: [Workspaces]
 *     summary: Scan workspace to detect tech stack, context files, and compute health score
 *     operationId: echolocateWorkspace
 *     description: >
 *       Non-destructive scan of workspace root and subdirectories.
 *       Detects tech stack from manifest files, checks for context/intent files
 *       (CLAUDE.md, AGENTS.md, .rorca/), computes a Context Richness Score (0-100),
 *       and detects monorepo structure. Reads only, never writes.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Echolocation report
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 stack:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name: { type: string }
 *                       version: { type: string }
 *                       source: { type: string }
 *                 contextFiles:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       path: { type: string }
 *                       exists: { type: boolean }
 *                       sizeBytes: { type: integer }
 *                       lineCount: { type: integer }
 *                 missing:
 *                   type: array
 *                   items: { type: string }
 *                 monorepo:
 *                   type: object
 *                   properties:
 *                     detected: { type: boolean }
 *                     packages:
 *                       type: array
 *                       items: { type: string }
 *                 score: { type: integer, minimum: 0, maximum: 100 }
 *                 suggestions:
 *                   type: array
 *                   items: { type: string }
 *                 scannedAt: { type: string, format: date-time }
 *       404: { description: "Workspace not found" }
 *       400: { description: "Workspace path does not exist" }
 */
router.post('/:id/echolocate', (req, res) => {
  const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.params.id) as WorkspaceRow | undefined;
  if (!workspace) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }

  if (!fs.existsSync(workspace.path)) {
    res.status(400).json({ error: `Workspace path does not exist: ${workspace.path}` });
    return;
  }

  try {
    const report = echolocate(workspace.path);

    db.prepare(
      "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('echolocate', ?, ?)"
    ).run(req.params.id, JSON.stringify({
      score: report.score,
      stackCount: report.stack.length,
      missingCount: report.missing.length,
      monorepo: report.monorepo.detected,
    }));

    res.json(report);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Echolocation scan failed' });
  }
});

// ─── CIE-017: Monorepo Discovery & Scope Generation ──────────────────────────

/**
 * @swagger
 * /api/workspaces/{id}/monorepo/discover:
 *   post:
 *     tags: [Workspaces]
 *     summary: Discover monorepo structure and generate per-app scopes + AGENTS.md
 *     operationId: discoverMonorepo
 *     description: >
 *       CIE-017: Detects monorepo tool (Turborepo, Nx, Lerna, pnpm/npm/yarn workspaces),
 *       scans each app/package for tech stack, infers skill files, generates routing
 *       scopes and AGENTS.md content. Returns a preview by default; pass mode=apply
 *       to write scopes to .rorca/config.json and AGENTS.md to workspace root.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               mode:
 *                 type: string
 *                 enum: [preview, apply]
 *                 default: preview
 *     responses:
 *       200:
 *         description: Monorepo discovery result with scopes and AGENTS.md
 *       404: { description: "Workspace not found" }
 *       400: { description: "Not a monorepo or workspace path missing" }
 */
router.post('/:id/monorepo/discover', (req, res) => {
  const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.params.id) as WorkspaceRow | undefined;
  if (!workspace) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }

  if (!fs.existsSync(workspace.path)) {
    res.status(400).json({ error: `Workspace path does not exist: ${workspace.path}` });
    return;
  }

  try {
    const result = discoverMonorepo(workspace.path);

    if (!result.apps.length) {
      res.status(400).json({ error: 'No monorepo structure detected', tool: result.tool });
      return;
    }

    const mode = (req.body?.mode as string) || 'preview';

    if (mode === 'apply') {
      // Merge discovered scopes into existing config
      const config = loadRorcaConfig(workspace.path);
      const existingScopePaths = new Set(config.routing.scopes.map(s => s.path));
      const newScopes = result.scopes.filter(s => !existingScopePaths.has(s.path));

      if (newScopes.length > 0) {
        config.routing.scopes.push(...newScopes);
        writeRorcaConfig(workspace.path, config);
      }

      // Write AGENTS.md (only if it doesn't exist or user opts to overwrite)
      const agentsPath = path.join(workspace.path, 'AGENTS.md');
      if (!fs.existsSync(agentsPath)) {
        fs.writeFileSync(agentsPath, result.agentsMd, 'utf-8');
      }

      // CIE-017: Append monorepo structure section to CLAUDE.md
      const claudePath = path.join(workspace.path, 'CLAUDE.md');
      const monoSection = generateMonorepoCLAUDESection(result.apps, result.tool);
      const MONO_START = '<!-- RORCA:MONOREPO:START -->';
      const MONO_END = '<!-- RORCA:MONOREPO:END -->';
      try {
        if (fs.existsSync(claudePath)) {
          let claudeContent = fs.readFileSync(claudePath, 'utf-8');
          // Replace existing section or append
          const startIdx = claudeContent.indexOf(MONO_START);
          const endIdx = claudeContent.indexOf(MONO_END);
          if (startIdx !== -1 && endIdx !== -1) {
            claudeContent = claudeContent.slice(0, startIdx) + MONO_START + '\n' + monoSection + MONO_END + claudeContent.slice(endIdx + MONO_END.length);
          } else {
            claudeContent += '\n' + MONO_START + '\n' + monoSection + MONO_END + '\n';
          }
          fs.writeFileSync(claudePath, claudeContent, 'utf-8');
        }
        // Don't create CLAUDE.md just for monorepo — scaffold handles that
      } catch { /* non-fatal */ }

      db.prepare(
        "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('monorepo_discovered', ?, ?)"
      ).run(req.params.id, JSON.stringify({
        tool: result.tool,
        appCount: result.apps.length,
        scopesAdded: newScopes.length,
        applied: true,
      }));

      res.json({
        ...result,
        applied: true,
        scopesAdded: newScopes.length,
        config: loadRorcaConfig(workspace.path),
      });
    } else {
      // Preview mode
      db.prepare(
        "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('monorepo_discovered', ?, ?)"
      ).run(req.params.id, JSON.stringify({
        tool: result.tool,
        appCount: result.apps.length,
        scopeCount: result.scopes.length,
        applied: false,
      }));

      res.json({ ...result, applied: false });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Monorepo discovery failed' });
  }
});

/**
 * @swagger
 * /api/workspaces/{id}/scaffold:
 *   post:
 *     tags: [Workspaces]
 *     summary: Generate or write context/intent scaffolding for a workspace
 *     operationId: scaffoldWorkspace
 *     description: >
 *       CIE-002: After echolocation detects the stack, this endpoint generates
 *       bespoke CLAUDE.md, AGENTS.md, .rorca/config.json, and skill files.
 *       With mode=preview (default), returns generated files without writing.
 *       With mode=write, writes provided files to disk and commits.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               mode:
 *                 type: string
 *                 enum: [preview, write]
 *                 default: preview
 *               files:
 *                 type: array
 *                 description: Files to write (required when mode=write). Each item has relativePath and content.
 *                 items:
 *                   type: object
 *                   properties:
 *                     relativePath: { type: string }
 *                     content: { type: string }
 *     responses:
 *       200:
 *         description: Scaffold preview or write result
 *       404: { description: "Workspace not found" }
 *       400: { description: "Invalid request" }
 */
router.post('/:id/scaffold', async (req, res) => {
  const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.params.id) as WorkspaceRow | undefined;
  if (!workspace) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }

  if (!fs.existsSync(workspace.path)) {
    res.status(400).json({ error: `Workspace path does not exist: ${workspace.path}` });
    return;
  }

  const mode = (req.body.mode as string) || 'preview';

  if (mode === 'preview') {
    try {
      // Run echolocation first to get fresh report
      const report = echolocate(workspace.path);

      const preview = await generateScaffoldPreview(workspace.path, report);

      db.prepare(
        "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('scaffold_preview', ?, ?)"
      ).run(req.params.id, JSON.stringify({
        fileCount: preview.files.length,
        stackSummary: preview.stackSummary,
      }));

      res.json(preview);
    } catch (err: any) {
      logger.error('[scaffold] Preview error:', err.message);
      res.status(500).json({ error: err.message || 'Scaffold generation failed' });
    }
    return;
  }

  if (mode === 'write') {
    const files = req.body.files as Array<{ relativePath: string; content: string }> | undefined;
    if (!files || !Array.isArray(files) || files.length === 0) {
      res.status(400).json({ error: 'mode=write requires a non-empty files array' });
      return;
    }

    // Validate file paths — prevent directory traversal
    for (const f of files) {
      if (!f.relativePath || !f.content) {
        res.status(400).json({ error: 'Each file must have relativePath and content' });
        return;
      }
      const resolved = path.resolve(workspace.path, f.relativePath);
      if (!resolved.startsWith(workspace.path)) {
        res.status(400).json({ error: `Path traversal detected: ${f.relativePath}` });
        return;
      }
    }

    try {
      const scaffoldFiles: ScaffoldFile[] = files.map(f => ({
        relativePath: f.relativePath,
        content: f.content,
        alreadyExists: fs.existsSync(path.join(workspace.path, f.relativePath)),
      }));

      const result = writeScaffoldFiles(workspace.path, scaffoldFiles);

      db.prepare(
        "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('scaffold_written', ?, ?)"
      ).run(req.params.id, JSON.stringify({
        filesWritten: result.filesWritten.length,
        filesSkipped: result.filesSkipped.length,
        fileNames: result.filesWritten,
      }));

      // Auto-commit if any files were written
      if (result.filesWritten.length > 0) {
        try {
          const { execSync } = require('child_process');
          const gitOpts = { cwd: workspace.path, encoding: 'utf-8' as const, timeout: 15_000 };

          // Stage all written files
          for (const f of result.filesWritten) {
            execSync(`git add "${f}"`, gitOpts);
          }

          execSync(
            'git commit -m "chore: initialize rorca context/intent scaffolding"',
            gitOpts,
          );
        } catch (gitErr: any) {
          // Non-fatal — files were written even if commit fails
          logger.warn('[scaffold] Git commit failed:', gitErr.message);
        }
      }

      res.json(result);
    } catch (err: any) {
      logger.error('[scaffold] Write error:', err.message);
      res.status(500).json({ error: err.message || 'Scaffold write failed' });
    }
    return;
  }

  res.status(400).json({ error: `Unknown mode: ${mode}. Use "preview" or "write".` });
});

/**
 * @swagger
 * /api/workspaces/{id}/bootstrap:
 *   post:
 *     tags: [Workspaces]
 *     summary: Chain all workspace intelligence into one call
 *     operationId: bootstrapWorkspace
 *     description: >
 *       Chains echolocation, monorepo discovery, LLM-based direction generation,
 *       .rorca/config.json initialization, skill inference, and MEMORY.md setup
 *       into a single endpoint. Returns surfaces, direction drafts, scopes,
 *       suggested skills, health scores, and files created. If workspace already
 *       has .rorca/config.json, returns existing config with configured=true
 *       instead of overwriting. Completes in <15s for typical projects (<1000 files).
 *       LLM calls for direction generation timeout at 30s with partial results returned.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Bootstrap result with surfaces, direction, scopes, skills, health
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 configured:
 *                   type: boolean
 *                   description: True if workspace already had .rorca/config.json
 *                 empty:
 *                   type: boolean
 *                   description: True if echolocate found no recognizable stack
 *                 surfaces:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       path: { type: string }
 *                       name: { type: string }
 *                       stack: { type: array, items: { type: object, properties: { name: { type: string }, version: { type: string }, source: { type: string } } } }
 *                       suggestedL2: { type: string }
 *                 direction:
 *                   type: object
 *                   properties:
 *                     standards: { type: string }
 *                     conventions: { type: string }
 *                     project: { type: string }
 *                 scopes:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       path: { type: string }
 *                       inject: { type: array, items: { type: string } }
 *                       priority: { type: integer }
 *                 suggestedSkills:
 *                   type: array
 *                   items: { type: string }
 *                 healthBefore: { type: integer, minimum: 0, maximum: 100 }
 *                 healthAfter: { type: integer, minimum: 0, maximum: 100 }
 *                 filesCreated:
 *                   type: array
 *                   items: { type: string }
 *       404: { description: "Workspace not found" }
 *       400: { description: "Workspace path does not exist" }
 *       500: { description: "Bootstrap failed" }
 */
router.post('/:id/bootstrap', async (req, res) => {
  const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.params.id) as WorkspaceRow | undefined;
  if (!workspace) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }

  if (!fs.existsSync(workspace.path)) {
    res.status(400).json({ error: `Workspace path does not exist: ${workspace.path}` });
    return;
  }

  try {
    // 1. Check if already configured
    if (hasRorcaDir(workspace.path)) {
      const existingConfig = loadRorcaConfig(workspace.path);
      const report = echolocate(workspace.path);
      const health = computeHealthReport(workspace.path);

      res.json({
        configured: true,
        empty: false,
        surfaces: report.monorepo.detected
          ? report.monorepo.apps.map(app => ({
              path: app.path,
              name: app.name,
              stack: app.stack,
              suggestedL2: '',
            }))
          : [{
              path: '.',
              name: path.basename(workspace.path),
              stack: report.stack,
              suggestedL2: '',
            }],
        direction: { standards: '', conventions: '', project: '' },
        scopes: existingConfig.routing.scopes.map(s => ({
          path: s.path,
          inject: s.inject,
          priority: s.priority,
        })),
        suggestedSkills: inferSkillsFromStack(report.stack),
        healthBefore: health.score,
        healthAfter: health.score,
        filesCreated: [],
      });
      return;
    }

    // 2. Echolocate — detect stack, context files, monorepo
    const report = echolocate(workspace.path);
    const healthBefore = computeHealthReport(workspace.path).score;

    // 3. Handle empty workspace (no recognizable stack)
    if (report.stack.length === 0) {
      // Read existing L1 from DB as fallback default
      const l1Row = db.prepare(
        `SELECT content_yaml FROM direction_layers WHERE layer = 1 AND COALESCE(workspace_id, '') = '' AND COALESCE(domain, '') = ''`
      ).get() as { content_yaml: string } | undefined;

      res.json({
        configured: false,
        empty: true,
        surfaces: [],
        direction: {
          standards: l1Row?.content_yaml || '',
          conventions: '',
          project: '',
        },
        scopes: [],
        suggestedSkills: [],
        healthBefore,
        healthAfter: healthBefore,
        filesCreated: [],
      });
      return;
    }

    // 4. Monorepo discovery
    let monoResult: { apps: Array<{ path: string; name: string; stack: Array<{ name: string; version?: string; source: string }>; inferredSkills: string[] }>; scopes: Array<{ path: string; inject: string[]; priority: number }> } | null = null;
    if (report.monorepo.detected && report.monorepo.apps.length > 0) {
      const discovery = discoverMonorepo(workspace.path);
      monoResult = {
        apps: discovery.apps,
        scopes: discovery.scopes.map(s => ({
          path: s.path,
          inject: s.inject,
          priority: s.priority,
        })),
      };
    }

    // 5. LLM-based direction generation with 30s timeout
    let directionDraft = { standards: '', conventions: '', project: '' };
    try {
      const directionResult = await Promise.race([
        generateDirectionDrafts(workspace),
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error('direction_timeout')), 30_000)),
      ]);
      if (directionResult) {
        directionDraft = directionResult;
      }
    } catch (err: any) {
      // Timeout or LLM failure — continue with partial results
      logger.warn(`[bootstrap] Direction generation failed: ${err.message}`);
    }

    // 6. Build .rorca/config.json
    const config: RorcaConfig = defaultRorcaConfig();
    config.routing.global = ['CLAUDE.md', 'AGENTS.md'];

    if (monoResult && monoResult.scopes.length > 0) {
      config.routing.scopes = monoResult.scopes.map(s => ({
        path: s.path,
        inject: s.inject,
        priority: s.priority,
        managed: 'rorca' as const,
      }));
    }

    // 7. Write .rorca/config.json + initialize MEMORY.md
    ensureRorcaDirStructure(workspace.path);
    writeRorcaConfig(workspace.path, config);
    const filesCreated: string[] = ['.rorca/config.json'];

    // Initialize MEMORY.md if missing
    const memoryPath = path.join(workspace.path, 'MEMORY.md');
    if (!fs.existsSync(memoryPath)) {
      const memoryContent = `# Memory Ledger\n\n## ${new Date().toISOString().split('T')[0]} [Architecture] Workspace Bootstrap\n> Rule: Workspace bootstrapped by Rorca. Stack: ${report.stack.map(s => s.name).join(', ')}.\n> Context: Auto-generated during workspace setup.\n> Source: bootstrap\n`;
      fs.writeFileSync(memoryPath, memoryContent, 'utf-8');
      filesCreated.push('MEMORY.md');
    }

    // 8. Compute health after
    const healthAfter = computeHealthReport(workspace.path).score;

    // 9. Build surfaces
    const surfaces = monoResult
      ? monoResult.apps.map(app => ({
          path: app.path,
          name: app.name,
          stack: app.stack,
          suggestedL2: inferL2Domain(app.stack.map(s => s.name)),
        }))
      : [{
          path: '.',
          name: path.basename(workspace.path),
          stack: report.stack,
          suggestedL2: inferL2Domain(report.stack.map(s => s.name)),
        }];

    // 10. WAL event
    db.prepare(
      "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('workspace_bootstrap', ?, ?)"
    ).run(req.params.id, JSON.stringify({
      surfaceCount: surfaces.length,
      stackCount: report.stack.length,
      monorepo: report.monorepo.detected,
      healthBefore,
      healthAfter,
      filesCreated,
    }));

    res.json({
      configured: false,
      empty: false,
      surfaces,
      direction: directionDraft,
      scopes: monoResult?.scopes ?? [],
      suggestedSkills: inferSkillsFromStack(report.stack),
      healthBefore,
      healthAfter,
      filesCreated,
    });
  } catch (err: any) {
    logger.error('[bootstrap] error:', err.message);
    res.status(500).json({ error: err.message || 'Bootstrap failed' });
  }
});

/**
 * @swagger
 * /api/workspaces/{id}/bootstrap/commit:
 *   post:
 *     tags: [Workspaces]
 *     summary: Commit bootstrap wizard results to DB
 *     operationId: commitBootstrapResults
 *     description: >
 *       Saves the direction layers generated by the bootstrap wizard to the
 *       direction_layers DB table. Called when the user clicks "Start Building"
 *       in the Workspace Wizard. Also writes .rorca/config.json and MEMORY.md
 *       to disk if not already present.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               direction:
 *                 type: object
 *                 properties:
 *                   standards: { type: string }
 *                   conventions: { type: string }
 *                   project: { type: string }
 *               surfaces:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     path: { type: string }
 *                     name: { type: string }
 *                     stack: { type: array }
 *               scopes:
 *                 type: array
 *                 items:
 *                   type: object
 *     responses:
 *       200:
 *         description: Bootstrap committed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 layersSaved: { type: integer }
 *       404: { description: "Workspace not found" }
 */
router.post('/:id/bootstrap/commit', (req, res) => {
  const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.params.id) as WorkspaceRow | undefined;
  if (!workspace) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }

  const { direction, scopes } = req.body;
  let layersSaved = 0;

  const upsert = db.prepare(`
    INSERT INTO direction_layers (layer, workspace_id, domain, content_yaml, preferred_model, updated_at)
    VALUES (?, ?, ?, ?, NULL, datetime('now'))
    ON CONFLICT (layer, COALESCE(workspace_id,''), COALESCE(domain,''))
    DO UPDATE SET content_yaml = excluded.content_yaml, updated_at = datetime('now')
  `);

  // Save L1 (Standards) — global, no workspace scoping
  if (direction?.standards) {
    upsert.run(1, null, null, direction.standards);
    layersSaved++;
  }

  // Save L2 (Conventions) — workspace-scoped
  if (direction?.conventions) {
    upsert.run(2, req.params.id, null, direction.conventions);
    layersSaved++;
  }

  // Save L3 (Project) — workspace-scoped
  if (direction?.project) {
    upsert.run(3, req.params.id, null, direction.project);
    layersSaved++;
  }

  // Ensure .rorca/ directory and config exist
  if (fs.existsSync(workspace.path)) {
    ensureRorcaDirStructure(workspace.path);

    if (!hasRorcaDir(workspace.path) || !fs.existsSync(path.join(workspace.path, '.rorca', 'config.json'))) {
      const config = defaultRorcaConfig();
      config.routing.global = ['CLAUDE.md', 'AGENTS.md'];
      if (scopes && Array.isArray(scopes) && scopes.length > 0) {
        config.routing.scopes = scopes.map((s: { path: string; inject: string[]; priority: number }) => ({
          path: s.path,
          inject: s.inject,
          priority: s.priority,
          managed: 'rorca' as const,
        }));
      }
      writeRorcaConfig(workspace.path, config);
    }

    // Initialize MEMORY.md if missing
    const memoryPath = path.join(workspace.path, 'MEMORY.md');
    if (!fs.existsSync(memoryPath)) {
      fs.writeFileSync(memoryPath, `# Memory Ledger\n\n## ${new Date().toISOString().split('T')[0]} [Architecture] Workspace Bootstrap\n> Rule: Workspace bootstrapped by Rorca via Setup Wizard.\n> Source: bootstrap-commit\n`, 'utf-8');
    }
  }

  // WAL event
  db.prepare(
    "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('bootstrap_committed', ?, ?)"
  ).run(req.params.id, JSON.stringify({ layersSaved }));

  res.json({ ok: true, layersSaved });
});

/**
 * Infer L2 domain label from stack names.
 */
function inferL2Domain(stackNames: string[]): string {
  const set = new Set(stackNames);
  if (set.has('Next.js') || set.has('React') || set.has('Vue.js') || set.has('Angular') || set.has('Svelte')) {
    if (set.has('Express') || set.has('Fastify') || set.has('Prisma') || set.has('Drizzle ORM') || set.has('Stripe')) {
      return 'saas';
    }
    return 'web';
  }
  if (set.has('React Native') || set.has('Expo')) return 'mobile';
  if (set.has('Electron') || set.has('Tauri')) return 'desktop';
  if (set.has('Django') || set.has('FastAPI') || set.has('Flask') || set.has('Express') || set.has('Fastify') || set.has('Hono')) return 'api';
  if (set.has('Terraform') || set.has('Docker')) return 'infrastructure';
  if (set.has('Rust') || set.has('Go')) return 'systems';
  return '';
}

/**
 * Generate direction layer drafts (L1/L2/L3) via LLM.
 * Reuses the same logic as scan-direction but returns structured result.
 */
async function generateDirectionDrafts(workspace: WorkspaceRow): Promise<{ standards: string; conventions: string; project: string }> {
  const scannedFiles: Record<string, string> = {};
  const filesToScan = ['package.json', 'CLAUDE.md', 'README.md', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'tsconfig.json'];

  for (const filename of filesToScan) {
    const filePath = path.join(workspace.path, filename);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const content = fs.readFileSync(filePath, 'utf-8');
      scannedFiles[filename] = content.length > 4000 ? content.slice(0, 4000) + '\n... (truncated)' : content;
    }
  }

  let dirListing: string[] = [];
  try {
    const entries = fs.readdirSync(workspace.path, { withFileTypes: true });
    dirListing = entries
      .slice(0, 500)
      .map(e => e.isDirectory() ? `${e.name}/` : e.name)
      .filter(name => !name.startsWith('.'));
  } catch { /* non-fatal */ }

  const foundFiles = Object.keys(scannedFiles);
  const fileContext = foundFiles.length > 0
    ? foundFiles.map(f => `--- ${f} ---\n${scannedFiles[f]}`).join('\n\n')
    : '(no recognized project files found)';

  const prompt = `=== INSTRUCTIONS ===
Return ONLY a JSON object with three keys: "l1", "l2", "l3". No markdown, no fences, no explanation.

Generate a "Direction Stack" — a 3-layer context cascade for AI code generation:
- L1 (Standards): Engineering principles, coding style, testing philosophy. Plain text.
- L2 (Conventions): Domain-specific knowledge, business terminology. Plain text.
- L3 (Project): YAML with: name, type, stack (array), purpose, key_modules (array).

=== REPOSITORY ===
Name: ${path.basename(workspace.path)}
Label: ${workspace.label}
Domains: ${JSON.parse(workspace.domains).join(', ') || '(none)'}

Files:
${fileContext}

Directories:
${dirListing.join('\n') || '(empty)'}

=== OUTPUT ===
{"l1": "...", "l2": "...", "l3": "..."}`;

  const result = await chatComplete([{ role: 'user', content: prompt }]);
  let text = result.text.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  }

  const parsed = JSON.parse(text);
  return {
    standards: parsed.l1 || '',
    conventions: parsed.l2 || '',
    project: parsed.l3 || '',
  };
}

// DELETE /api/workspaces/:id
router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM workspaces WHERE id = ?').run(req.params.id);

  db.prepare(
    "INSERT INTO wal_events (event_type, workspace_id) VALUES ('workspace_delete', ?)"
  ).run(req.params.id);

  res.status(204).send();
});

export default router;
