/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { query, queryOne, execute } from '../db/index';
import { withUserClient } from '../db/user-client';
import { validateBody } from '../lib/validate';
import { hydrateSchema } from '../lib/schema-hydrator';
import {
  gitMapStep,
  gitReduceStep,
  getLatestHash,
} from '../lib/git-hydrator';
import { autoHydrateWorkspaceContext, buildContextHealthSummary } from '../lib/auto-memory';
import { chatComplete } from '../lib/llm-client';
import { validateDirectionYaml } from '../lib/direction-validator';
import { parsePaginationParams, paginateArray } from '../lib/paginate';
import { echolocate, computeHealthReport, discoverMonorepo, generateMonorepoCLAUDESection, inferSkillsFromStack } from '../lib/workspace-echolocation';
import { graphStats } from '../lib/knowledge-graph';
import { getEmbeddingCounts } from '../lib/embedding-pipeline';
import { loadRorcaConfig, writeRorcaConfig, hasRorcaDir, ensureRorcaDirStructure, defaultRorcaConfig } from '../lib/rorca-config';
import type { RorcaConfig } from '../lib/rorca-config';
import { generateScaffoldPreview, writeScaffoldFiles } from '../lib/workspace-scaffold';
import type { ScaffoldFile } from '../lib/workspace-scaffold';
import { logger } from '../lib/logger';
import { requirePlan } from '../lib/require-plan';
import { inferDomain } from '../lib/domain-inference';
import { ConflictError, NotFoundError, UnprocessableError, ValidationError } from '../lib/errors';
import { handleRouteError } from '../lib/async-handler';
import { authRequired, requireWorkspaceAdmin, requireWorkspaceMember } from '../lib/auth-utils';
import {
  buildDatabaseSetupGuidance,
  getDatabaseCapability,
  setDbMode,
  setPersistedByopDatabaseUrl,
  validateByopConnection,
  type DbMode,
  type DatabaseSelectionValidationError,
} from '../lib/db-strategy';

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
  last_ingested_commit_hash: string | null;
  git_commit_count: number;
  git_memory_hydrated_at: string | null;
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
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Workspace creation mutates user-owned project configuration and should require authenticated access."
 *     description: >
 *       Registers a new workspace by path. Validates the filesystem path exists,
 *       optionally persists a database mode selection (including hosted BYOP
 *       Postgres validation), creates the workspace record, auto-creates a
 *       default agent profile from L3 direction content, and runs echolocation
 *       on the workspace root.
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
 *               dbMode: { type: string, enum: [native, docker, byop], nullable: true }
 *               databaseUrl: { type: string, nullable: true, example: "postgres://postgres:secret@db.example.supabase.co:5432/postgres?sslmode=require" }
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
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Read-only workspace discovery is required by the standalone capture sidecar to resolve a local repo to a Rorca workspace via the stable API-only contract."
 *     x-rorca-public-api: true
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
  dbMode: z.enum(['native', 'docker', 'byop']).optional(),
  databaseUrl: z.string().optional(),
});

function resolveRequestedDbMode(input: { dbMode?: unknown; databaseUrl?: unknown }): DbMode | null {
  if (input.dbMode === 'native' || input.dbMode === 'docker' || input.dbMode === 'byop') {
    return input.dbMode;
  }
  if (typeof input.databaseUrl === 'string' && input.databaseUrl.trim()) {
    return 'byop';
  }
  return null;
}

async function persistRequestedDatabaseMode(input: { dbMode?: unknown; databaseUrl?: unknown }) {
  const mode = resolveRequestedDbMode(input);
  if (!mode) return null;

  if (mode === 'byop') {
    const databaseUrl = typeof input.databaseUrl === 'string' ? input.databaseUrl : '';
    const validation = await validateByopConnection(databaseUrl);
    setPersistedByopDatabaseUrl(validation.normalizedUrl);
    setDbMode('byop');
    return {
      mode,
      restartRequired: true,
      provider: validation.provider,
      connection: validation.connection,
      extensions: validation.extensions,
      warnings: validation.warnings,
    };
  }

  setDbMode(mode);
  return {
    mode,
    restartRequired: true,
    provider: mode === 'docker' ? 'docker-postgres' : 'native-postgres',
    connection: null,
    extensions: null,
    warnings: [],
  };
}

function throwDatabaseSelectionError(error: unknown): never {
  const dbError = error as Partial<DatabaseSelectionValidationError>;
  switch (dbError.code) {
    case 'INVALID_DATABASE_URL':
      throw new ValidationError((error as Error).message);
    case 'PGVECTOR_REQUIRED':
    case 'EXTENSION_CHECK_FAILED':
    case 'DATABASE_UNREACHABLE':
      throw new UnprocessableError((error as Error).message);
    default:
      throw error;
  }
}

router.post('/', authRequired, validateBody(CreateWorkspaceSchema), requirePlan('workspaces'), async (req, res, next) => {
  try {
    const { id, label, path, domains, dbMode, databaseUrl } = req.body;

    if (!fs.existsSync(path)) {
      throw new ValidationError(`Path does not exist on filesystem: ${path}`);
      return;
    }

    let databaseSelection = null;
    try {
      databaseSelection = await persistRequestedDatabaseMode({ dbMode, databaseUrl });
    } catch (error) {
      throwDatabaseSelectionError(error);
    }

    try {
      await withUserClient(req, async (client) => {
        await client.query(
          'INSERT INTO workspaces (id, label, path, domains) VALUES ($1, $2, $3, $4)',
          [id, label, path, JSON.stringify(domains)]
        );
      });
    } catch (err: any) {
      if (err.code === '23505' || err.message?.includes('duplicate key value violates unique constraint')) {
        throw new ConflictError(`Workspace '${id}' already exists`);
        return;
      }
      throw err;
    }

    await execute(
      "INSERT INTO wal_events (event_type, workspace_id) VALUES ('workspace_create', $1)",
      [id]
    );

    // V2-070: Auto-create default agent profile using workspace's L3 direction content
    const l3Row = await queryOne<{ content_yaml: string }>(
      `SELECT content_yaml FROM direction_layers WHERE layer = 3 AND workspace_id = $1 AND COALESCE(domain, '') = '' LIMIT 1`,
      [id]
    );

    await execute(
      `INSERT INTO agent_profiles (workspace_id, name, system_prompt_override, allowed_tools, is_active)
       VALUES ($1, 'Default', $2, '[]', true)
       ON CONFLICT DO NOTHING`,
      [id, l3Row?.content_yaml || null]
    );

    const row = await queryOne<WorkspaceRow>('SELECT * FROM workspaces WHERE id = $1', [id]);

    // CIE-001: Auto-run echolocation on workspace registration
    let health = null;
    try {
      health = echolocate(path);
      await execute(
        "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('echolocate', $1, $2)",
        [id, JSON.stringify({
          score: health.score,
          stackCount: health.stack.length,
          missingCount: health.missing.length,
          monorepo: health.monorepo.detected,
        })]
      );
    } catch {
      // Non-fatal — workspace still registers even if echolocation fails
    }

    // CTM-005: Fire-and-forget schema + git-memory hydration after registration.
    // Non-blocking — workspace creation must not wait on (or fail because of) hydration.
    void autoHydrateWorkspaceContext({
      workspaceId: id,
      workspacePath: path,
      workspaceLabel: label,
    }).catch((err) => {
      logger.warn(`[Workspaces] auto-hydration failed for ${id}: ${(err as Error)?.message ?? err}`);
    });

    const needsBootstrap = (health?.score ?? 0) < 40;
    res.status(201).json({
      workspace: parseWorkspace(row!),
      health,
      needsBootstrap,
      databaseSetup: buildDatabaseSetupGuidance(),
      ...(databaseSelection ? { databaseSelection } : {}),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/workspaces:
 *   get:
 *     tags: [Workspaces]
 *     summary: List all workspaces
 *     operationId: listWorkspaces
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Read-only workspace discovery is required by the standalone capture sidecar to resolve a local repo to a Rorca workspace via the stable API-only contract."
 *     x-rorca-public-api: true
 *     description: >
 *       Returns all registered workspace entries ordered by creation date descending.
 *       Supports cursor-based pagination via query parameters.
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Maximum number of items to return
 *       - in: query
 *         name: cursor
 *         schema:
 *           type: string
 *         description: Cursor for the next page (from previous response)
 *     responses:
 *       200:
 *         description: Paginated list of workspaces
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 items:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Workspace'
 *                 total:
 *                   type: integer
 *                   example: 3
 *                 hasMore:
 *                   type: boolean
 *                   example: false
 *                 cursor:
 *                   type: string
 *                   nullable: true
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// GET /api/workspaces
router.get('/', authRequired, async (req, res, next) => {
  try {
    const rows = await withUserClient(req, async (client) => {
      const result = await client.query<WorkspaceRow>('SELECT * FROM workspaces ORDER BY created_at DESC');
      return result.rows;
    });
    const pagination = parsePaginationParams(req);
    res.json(paginateArray(rows.map(parseWorkspace), pagination, { cursorKey: (w) => w.id }));
  } catch (err) {
    next(err);
  }
});

router.use('/:id', requireWorkspaceMember());

/**
 * @swagger
 * /api/workspaces/{id}/status:
 *   get:
 *     tags: [Workspaces]
 *     summary: Get lightweight workspace runtime status
 *     operationId: getWorkspaceStatus
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Workspace runtime status includes local environment metadata and should only be exposed to authenticated callers."
 *     description: >
 *       Returns a lightweight runtime status payload for a workspace including the
 *       canonical database capability model and current knowledge-graph counters.
 *       Database connection metadata is redacted before returning to the client.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Workspace runtime status
 *       404: { description: "Workspace not found" }
 */
router.get('/:id/status', async (req, res, next) => {
  try {
    const workspace = await queryOne<WorkspaceRow>('SELECT * FROM workspaces WHERE id = $1', [req.params.id]);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const [databaseCapability, stats, lastEvent] = await Promise.all([
      getDatabaseCapability(),
      graphStats(),
      queryOne<{ ts: string }>(
        `SELECT ts FROM wal_events
         WHERE event_type IN ('graph_populated', 'graph_backfill_complete', 'graph_populate_finished', 'run_finished')
         ORDER BY ts DESC LIMIT 1`,
      ),
    ]);

    res.json({
      workspaceId: workspace.id,
      databaseCapability,
      databaseSetup: buildDatabaseSetupGuidance(databaseCapability.dbMode),
      graph: {
        available: stats.available,
        graphMode: databaseCapability.graphMode,
        vertexCount: stats.vertexCount,
        edgeCount: stats.edgeCount,
        graphName: 'rorca',
        lastPopulatedAt: lastEvent?.ts ?? null,
        warnings: databaseCapability.warnings,
      },
    });
  } catch (err) {
    next(err);
  }
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
router.get('/:id/context', async (req, res, next) => {
  try {
    const row = await queryOne<WorkspaceContextRow>(
      'SELECT * FROM workspace_context WHERE workspace_id = $1',
      [req.params.id]
    );

    res.json({
      schemaSnapshot: row?.schema_snapshot ?? null,
      schemaTableCount: row?.schema_table_count ?? null,
      gitMemory: null, // git_memory column dropped (migration 075) — knowledge now in memories table
      lastIngestedCommitHash: row?.last_ingested_commit_hash ?? null,
      gitCommitCount: row?.git_commit_count ?? null,
    });
  } catch (err) {
    next(err);
  }
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
router.post('/:id/hydrate', requireWorkspaceAdmin(), async (req, res, next) => {
  try {
    const { id } = req.params;
    const types: string[] = req.body.types ?? ['schema', 'git'];

    // 1. Fetch workspace
    const workspace = await queryOne<WorkspaceRow>('SELECT * FROM workspaces WHERE id = $1', [id]);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    // 2. Fetch existing workspace_context (may not exist yet)
    const existingCtx = await queryOne<WorkspaceContextRow>(
      'SELECT * FROM workspace_context WHERE workspace_id = $1',
      [id]
    );

    const result: {
      ok: boolean;
      schema?: { tableCount: number; snapshot_at: string | null };
      git?: { commitCount: number; memory_updated_at: string | null; newCommits: number };
    } = { ok: true };

    // 3. Schema hydration
    if (types.includes('schema')) {
      const schemaResult = hydrateSchema(workspace.path);
      const snapshotAt = new Date().toISOString();

      await execute(
        `INSERT INTO workspace_context (workspace_id, schema_snapshot, schema_table_count, schema_snapshot_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT(workspace_id) DO UPDATE SET
           schema_snapshot = EXCLUDED.schema_snapshot,
           schema_table_count = EXCLUDED.schema_table_count,
           schema_snapshot_at = EXCLUDED.schema_snapshot_at`,
        [id, schemaResult.snapshot || null, schemaResult.tableNames.length, snapshotAt]
      );

      await execute(
        "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('hydrate_schema', $1, $2)",
        [id, JSON.stringify({ tableCount: schemaResult.tableNames.length })]
      );

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
          throw new UnprocessableError(err.message);
          return;
        }
        res.status(502).json({ error: `Git map step failed: ${err.message}` });
        return;
      }

      const newCommits = summaries.reduce((acc, s) => acc + s.commitCount, 0);
      let _gitMemory: string;

      if (newCommits > 0) {
        try {
          _gitMemory = await gitReduceStep({
            summaries,
            workspaceLabel: workspace.label,
          });
        } catch (err: any) {
          res.status(502).json({ error: `LLM call failed during git reduce: ${err.message}` });
          return;
        }

        // git_memory column was dropped (migration 075) — knowledge now lives in memories table.
        // _gitMemory is intentionally retained only for local flow symmetry and future response hooks.
      } else {
        _gitMemory = '';
      }

      const latestHash = getLatestHash(summaries) ?? existingCtx?.last_ingested_commit_hash ?? null;
      const totalCommitCount = (existingCtx?.git_commit_count ?? 0) + newCommits;
      const memoryUpdatedAt = newCommits > 0 ? new Date().toISOString() : null;

      await execute(
        `INSERT INTO workspace_context (workspace_id, last_ingested_commit_hash, git_commit_count)
         VALUES ($1, $2, $3)
         ON CONFLICT(workspace_id) DO UPDATE SET
           last_ingested_commit_hash = EXCLUDED.last_ingested_commit_hash,
           git_commit_count = EXCLUDED.git_commit_count`,
        [id, latestHash, totalCommitCount]
      );

      await execute(
        "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('hydrate_git', $1, $2)",
        [id, JSON.stringify({ commitCount: totalCommitCount, newCommits })]
      );

      result.git = { commitCount: totalCommitCount, memory_updated_at: memoryUpdatedAt, newCommits };
    }

    res.json(result);
  } catch (err) {
    next(err);
  }
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
router.get('/:id/files', async (req, res, next) => {
  try {
    const workspace = await queryOne<WorkspaceRow>('SELECT * FROM workspaces WHERE id = $1', [req.params.id]);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
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
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/workspaces/{id}:
 *   get:
 *     tags: [Workspaces]
 *     summary: Get a single workspace
 *     operationId: getWorkspace
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Workspace detail includes local repository metadata and should require authenticated access."
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
router.get('/:id', async (req, res, next) => {
  try {
    const row = await queryOne<WorkspaceRow>('SELECT * FROM workspaces WHERE id = $1', [req.params.id]);
    if (!row) {
      throw new NotFoundError('Workspace not found');
      return;
    }
    res.json({ workspace: parseWorkspace(row) });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/workspaces/{id}:
 *   patch:
 *     tags: [Workspaces]
 *     summary: Update workspace settings
 *     operationId: updateWorkspace
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Updating workspace metadata mutates user-owned project configuration and should require authenticated access."
 *     description: >
 *       Partially updates a workspace. All body fields are optional — only provided
 *       fields are updated. If path is supplied, it must exist on the filesystem.
 *       Domains should be an array of domain strings (e.g. ["saas", "fintech"]).
 *       dbMode/native/docker/byop changes are persisted globally for the running
 *       Rorca installation, and BYOP URLs are validated before persistence.
 *       pr_template can be set to null or empty string to clear the PR template.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Workspace ID
 *         example: cashflow-ai
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               label:
 *                 type: string
 *                 description: Human-readable workspace name
 *                 example: CashflowAI (updated)
 *               path:
 *                 type: string
 *                 description: Absolute filesystem path to the workspace
 *                 example: /Users/dev/cashflow-ai
 *               domains:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Domain tags for this workspace (affects L2 direction layer)
 *                 example: ["saas", "fintech"]
 *               pr_template:
 *                 type: string
 *                 nullable: true
 *                 description: Markdown template for auto-generated pull request bodies
 *               dbMode:
 *                 type: string
 *                 enum: [native, docker, byop]
 *                 description: Process-wide database mode for this Rorca installation
 *               databaseUrl:
 *                 type: string
 *                 nullable: true
 *                 description: Hosted PostgreSQL connection string used when dbMode=byop
 *     responses:
 *       200:
 *         description: Workspace updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 workspace:
 *                   $ref: '#/components/schemas/Workspace'
 *       400:
 *         description: Supplied path does not exist on the filesystem
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Workspace not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// PATCH /api/workspaces/:id — Update workspace settings
router.patch('/:id', requireWorkspaceAdmin(), async (req, res, next) => {
  try {
    const row = await queryOne<WorkspaceRow>('SELECT * FROM workspaces WHERE id = $1', [req.params.id]);
    if (!row) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const { label, path: wsPath, domains, pr_template, dbMode, databaseUrl } = req.body;

    let databaseSelection = null;
    try {
      databaseSelection = await persistRequestedDatabaseMode({ dbMode, databaseUrl });
    } catch (error) {
      throwDatabaseSelectionError(error);
    }

    if (label !== undefined) {
      await execute('UPDATE workspaces SET label = $1 WHERE id = $2', [String(label), req.params.id]);
    }

    if (wsPath !== undefined) {
      if (!fs.existsSync(wsPath)) {
        throw new ValidationError(`Path does not exist on filesystem: ${wsPath}`);
        return;
      }
      await execute('UPDATE workspaces SET path = $1 WHERE id = $2', [String(wsPath), req.params.id]);
    }

    if (domains !== undefined) {
      await execute('UPDATE workspaces SET domains = $1 WHERE id = $2', [JSON.stringify(domains), req.params.id]);
    }

    if (pr_template !== undefined) {
      const value = pr_template === null || pr_template === '' ? null : String(pr_template);
      await execute('UPDATE workspaces SET pr_template = $1 WHERE id = $2', [value, req.params.id]);
    }

    const updated = await queryOne<WorkspaceRow>('SELECT * FROM workspaces WHERE id = $1', [req.params.id]);
    res.json({
      workspace: parseWorkspace(updated!),
      databaseSetup: buildDatabaseSetupGuidance(),
      ...(databaseSelection ? { databaseSelection } : {}),
    });
  } catch (err) {
    next(err);
  }
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
 *                     includeGraph: { type: boolean }
 *       404: { description: "Workspace not found" }
 */
router.get('/:id/pipeline-config', async (req, res, next) => {
  try {
    const row = await queryOne<{ pipeline_config: string; default_parallelism: number }>(
      'SELECT pipeline_config, default_parallelism FROM workspaces WHERE id = $1',
      [req.params.id]
    );
    if (!row) {
      throw new NotFoundError('Workspace not found');
      return;
    }
    const config = JSON.parse(row.pipeline_config || '{}');
    res.json({
      config: {
        autoWorktree: config.autoWorktree ?? true,
        storyTimeoutMin: config.storyTimeoutMin ?? 45,
        maxRetries: config.maxRetries ?? 0,
        defaultParallelism: row.default_parallelism ?? 1,
        includeGraph: config.includeGraph ?? false,
        mergeStrategy: config.mergeStrategy ?? 'direct',
      },
    });
  } catch (err) {
    next(err);
  }
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
 *               includeGraph: { type: boolean }
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
router.put('/:id/pipeline-config', requireWorkspaceAdmin(), async (req, res, next) => {
  try {
    const row = await queryOne<{ id: string; pipeline_config: string }>('SELECT id, pipeline_config FROM workspaces WHERE id = $1', [req.params.id]);
    if (!row) {
      throw new NotFoundError('Workspace not found');
      return;
    }
    const existing = JSON.parse(row.pipeline_config || '{}');
    const { autoWorktree, storyTimeoutMin, maxRetries, defaultParallelism, includeGraph, mergeStrategy } = req.body;
    const merged = {
      autoWorktree: autoWorktree !== undefined ? autoWorktree : existing.autoWorktree,
      storyTimeoutMin: storyTimeoutMin !== undefined ? storyTimeoutMin : existing.storyTimeoutMin,
      maxRetries: maxRetries !== undefined ? maxRetries : existing.maxRetries,
      includeGraph: includeGraph !== undefined ? includeGraph : existing.includeGraph,
      mergeStrategy: mergeStrategy !== undefined ? mergeStrategy : existing.mergeStrategy,
    };
    const config = JSON.stringify(merged);
    if (defaultParallelism !== undefined) {
      const p = Math.max(1, Math.min(10, Math.floor(Number(defaultParallelism) || 1)));
      await execute('UPDATE workspaces SET pipeline_config = $1, default_parallelism = $2 WHERE id = $3', [config, p, req.params.id]);
    } else {
      await execute('UPDATE workspaces SET pipeline_config = $1 WHERE id = $2', [config, req.params.id]);
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/workspaces/{id}/stats:
 *   get:
 *     tags: [Workspaces]
 *     summary: Get summary stats for a workspace
 *     operationId: getWorkspaceStats
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Workspace stats expose user/project usage data and should only be visible to authenticated callers."
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
router.get('/:id/stats', async (req, res, next) => {
  try {
    const workspaceId = req.params.id;
    const row = await queryOne<WorkspaceRow>('SELECT * FROM workspaces WHERE id = $1', [workspaceId]);
    if (!row) {
      throw new NotFoundError('Workspace not found');
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
    const runStats = await queryOne<{
      total_runs: string;
      active_runs: string;
      completed_runs: string;
      failed_runs: string;
      last_run_at: string | null;
    }>(`
      SELECT
        COUNT(*)::int AS total_runs,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS active_runs,
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS completed_runs,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_runs,
        MAX(started_at) AS last_run_at
      FROM pipeline_runs WHERE workspace_id = $1
    `, [workspaceId]);

    // Story pass rate
    const storyStats = await queryOne<{
      total_stories: string;
      passed_stories: string;
      failed_stories: string;
    }>(`
      SELECT
        COUNT(*)::int AS total_stories,
        SUM(CASE WHEN sr.status = 'pass' THEN 1 ELSE 0 END)::int AS passed_stories,
        SUM(CASE WHEN sr.status = 'fail' THEN 1 ELSE 0 END)::int AS failed_stories
      FROM story_results sr
      JOIN pipeline_runs pr ON sr.run_id = pr.id
      WHERE pr.workspace_id = $1
    `, [workspaceId]);

    const totalRuns = Number(runStats?.total_runs ?? 0);
    const activeRuns = Number(runStats?.active_runs ?? 0);
    const completedRuns = Number(runStats?.completed_runs ?? 0);
    const failedRuns = Number(runStats?.failed_runs ?? 0);
    const lastRunAt = runStats?.last_run_at ?? null;

    const totalStories = Number(storyStats?.total_stories ?? 0);
    const passedStories = Number(storyStats?.passed_stories ?? 0);
    const failedStories = Number(storyStats?.failed_stories ?? 0);

    const passRate = totalStories > 0
      ? Math.round((passedStories / totalStories) * 100)
      : 0;

    // Last activity from WAL
    const lastActivity = await queryOne<{ last_at: string | null }>(
      'SELECT MAX(ts) AS last_at FROM wal_events WHERE workspace_id = $1',
      [workspaceId]
    );

    res.json({
      workspaceId,
      specs: { pending: pendingSpecs, approved: approvedSpecs, total: pendingSpecs + approvedSpecs },
      runs: {
        total: totalRuns,
        active: activeRuns,
        completed: completedRuns,
        failed: failedRuns,
        lastRunAt: lastRunAt,
      },
      stories: {
        total: totalStories,
        passed: passedStories,
        failed: failedStories,
        passRate,
      },
      lastActivity: lastActivity?.last_at ?? lastRunAt,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/workspaces/{id}/team-members:
 *   get:
 *     tags: [Workspaces]
 *     summary: Get team members for a workspace
 *     operationId: getWorkspaceTeamMembers
 *     x-rorca-tier: paid
 *     x-rorca-capability: teams
 *     x-rorca-rationale: "Workspace team membership is a multi-user collaboration feature and belongs behind the paid plan boundary."
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
router.get('/:id/team-members', async (req, res, next) => {
  try {
    const workspaceId = req.params.id;
    const row = await queryOne<WorkspaceRow>('SELECT * FROM workspaces WHERE id = $1', [workspaceId]);
    if (!row) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    // Find team linked to this workspace via workspace_access
    const access = await queryOne<{ team_id: string; permission: string; team_name: string; team_slug: string }>(
      'SELECT wa.team_id, wa.permission, t.name AS team_name, t.slug AS team_slug FROM workspace_access wa JOIN teams t ON wa.team_id = t.id WHERE wa.workspace_id = $1',
      [workspaceId]
    );

    if (!access) {
      res.json({ teamScoped: false, team: null, members: [] });
      return;
    }

    const members = await query<{
      userId: string;
      email: string;
      displayName: string;
      role: string;
      joinedAt: string;
      acceptedAt: string | null;
      lastActiveAt: string | null;
    }>(`
      SELECT
        tm.user_id AS "userId",
        u.email,
        u.display_name AS "displayName",
        tm.role,
        tm.invited_at AS "joinedAt",
        tm.accepted_at AS "acceptedAt",
        tm.last_active_at AS "lastActiveAt"
      FROM team_members tm
      JOIN users u ON tm.user_id = u.id
      WHERE tm.team_id = $1
      ORDER BY tm.invited_at ASC
    `, [access.team_id]);

    res.json({
      teamScoped: true,
      team: { id: access.team_id, name: access.team_name, slug: access.team_slug, permission: access.permission },
      members,
    });
  } catch (err) {
    next(err);
  }
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
router.post('/:id/scan-direction', requireWorkspaceAdmin(), async (req, res, next) => {
  try {
    const workspace = await queryOne<WorkspaceRow>('SELECT * FROM workspaces WHERE id = $1', [req.params.id]);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    if (!fs.existsSync(workspace.path)) {
      throw new ValidationError(`Workspace path does not exist: ${workspace.path}`);
      return;
    }

    // Infer domain from codebase before running direction scan
    let inferredDomain: string | null = null;
    try {
      inferredDomain = await inferDomain(workspace.path);
      if (inferredDomain) {
        // Update workspaces.domains to include inferred domain (deduplicated)
        const existingDomains: string[] = JSON.parse(workspace.domains ?? '[]');
        if (!existingDomains.includes(inferredDomain)) {
          const updatedDomains = [...existingDomains, inferredDomain];
          await execute('UPDATE workspaces SET domains = $1 WHERE id = $2', [JSON.stringify(updatedDomains), req.params.id]);
        }
        // Associate existing L2 direction layer for this domain with the workspace (upsert)
        const existingL2 = await queryOne<{ id: number; content_yaml: string }>(
          `SELECT id, content_yaml FROM direction_layers WHERE layer = 2 AND domain = $1 AND workspace_id IS NULL LIMIT 1`,
          [inferredDomain]
        );
        if (existingL2) {
          await execute(
            `INSERT INTO direction_layers (layer, workspace_id, domain, content_yaml, updated_at)
             VALUES (2, $1, $2, $3, NOW())
             ON CONFLICT (layer, COALESCE(workspace_id,''), COALESCE(domain,''), COALESCE(team_id,''))
             DO UPDATE SET content_yaml = EXCLUDED.content_yaml, updated_at = NOW()`,
            [req.params.id, inferredDomain, existingL2.content_yaml]
          );
        }
      }
    } catch (domainErr: any) {
      logger.warn('[scan-direction] domain inference failed:', domainErr.message);
      // Non-fatal — continue with scan
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
      await execute(
        "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('direction_scan', $1, $2)",
        [req.params.id, JSON.stringify({ confidence, filesScanned: foundFiles })]
      );

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
        inferredDomain,
      });
    } catch (err: unknown) {
      handleRouteError(res, err, '[Workspaces] Scan direction');
    }
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/workspaces/{id}/health:
 *   get:
 *     tags: [Workspaces]
 *     summary: Get workspace health report with component breakdown
 *     operationId: getWorkspaceHealth
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Workspace health reveals project-specific context and operational metadata, so it should require authenticated access."
 *     description: >
 *       CIE-012: Returns context/intent completeness score (0-100%) with per-component
 *       breakdown showing CLAUDE.md depth, AGENTS.md roles, config scopes, MEMORY.md
 *       entries, and skill file count. SW-009: Includes semantic section with knowledge
 *       graph stats (vertices, edges) and embedding counts by source type. Appends score
 *       to health history log.
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
router.get('/:id/health', async (req, res, next) => {
  try {
    const workspace = await queryOne<WorkspaceRow>('SELECT * FROM workspaces WHERE id = $1', [req.params.id]);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    if (!fs.existsSync(workspace.path)) {
      throw new ValidationError(`Workspace path does not exist: ${workspace.path}`);
      return;
    }

    try {
      const report = computeHealthReport(workspace.path);

      // SW-009: Semantic engine stats (graph + embeddings)
      let semantic: {
        graphAvailable: boolean;
        vertices: number;
        edges: number;
        embeddings: { total: number; specs: number; stories: number; memories: number };
        searchMode: 'hybrid' | 'keyword-only';
      };
      try {
        const [gs, ec] = await Promise.all([
          graphStats(),
          getEmbeddingCounts(),
        ]);
        semantic = {
          graphAvailable: gs.available,
          vertices: gs.vertexCount,
          edges: gs.edgeCount,
          embeddings: {
            total: ec.embeddingCount,
            specs: ec.specCount,
            stories: ec.storyCount,
            memories: ec.memoryCount,
          },
          searchMode: ec.embeddingCount > 0 ? 'hybrid' : 'keyword-only',
        };
      } catch {
        semantic = {
          graphAvailable: false,
          vertices: 0,
          edges: 0,
          embeddings: { total: 0, specs: 0, stories: 0, memories: 0 },
          searchMode: 'keyword-only',
        };
      }

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

      res.json({ ...report, semantic, trend });
    } catch (err: unknown) {
      handleRouteError(res, err, '[Workspaces] Health check');
    }
  } catch (err) {
    next(err);
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
router.post('/:id/echolocate', requireWorkspaceAdmin(), async (req, res, next) => {
  try {
    const workspace = await queryOne<WorkspaceRow>('SELECT * FROM workspaces WHERE id = $1', [req.params.id]);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    if (!fs.existsSync(workspace.path)) {
      throw new ValidationError(`Workspace path does not exist: ${workspace.path}`);
      return;
    }

    try {
      const report = echolocate(workspace.path);

      await execute(
        "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('echolocate', $1, $2)",
        [req.params.id, JSON.stringify({
          score: report.score,
          stackCount: report.stack.length,
          missingCount: report.missing.length,
          monorepo: report.monorepo.detected,
        })]
      );

      res.json(report);
    } catch (err: unknown) {
      handleRouteError(res, err, '[Workspaces] Echolocation scan');
    }
  } catch (err) {
    next(err);
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
router.post('/:id/monorepo/discover', requireWorkspaceAdmin(), async (req, res, next) => {
  try {
    const workspace = await queryOne<WorkspaceRow>('SELECT * FROM workspaces WHERE id = $1', [req.params.id]);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    if (!fs.existsSync(workspace.path)) {
      throw new ValidationError(`Workspace path does not exist: ${workspace.path}`);
      return;
    }

    try {
      const result = discoverMonorepo(workspace.path);

      if (!result.apps.length) {
        throw new ValidationError('No monorepo structure detected');
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

        await execute(
          "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('monorepo_discovered', $1, $2)",
          [req.params.id, JSON.stringify({
            tool: result.tool,
            appCount: result.apps.length,
            scopesAdded: newScopes.length,
            applied: true,
          })]
        );

        res.json({
          ...result,
          applied: true,
          scopesAdded: newScopes.length,
          config: loadRorcaConfig(workspace.path),
        });
      } else {
        // Preview mode
        await execute(
          "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('monorepo_discovered', $1, $2)",
          [req.params.id, JSON.stringify({
            tool: result.tool,
            appCount: result.apps.length,
            scopeCount: result.scopes.length,
            applied: false,
          })]
        );

        res.json({ ...result, applied: false });
      }
    } catch (err: unknown) {
      handleRouteError(res, err, '[Workspaces] Monorepo discovery');
    }
  } catch (err) {
    next(err);
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
router.post('/:id/scaffold', requireWorkspaceAdmin(), async (req, res, next) => {
  try {
    const workspace = await queryOne<WorkspaceRow>('SELECT * FROM workspaces WHERE id = $1', [req.params.id]);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    if (!fs.existsSync(workspace.path)) {
      throw new ValidationError(`Workspace path does not exist: ${workspace.path}`);
      return;
    }

    const mode = (req.body.mode as string) || 'preview';

    if (mode === 'preview') {
      try {
        // Run echolocation first to get fresh report
        const report = echolocate(workspace.path);

        const preview = await generateScaffoldPreview(workspace.path, report);

        await execute(
          "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('scaffold_preview', $1, $2)",
          [req.params.id, JSON.stringify({
            fileCount: preview.files.length,
            stackSummary: preview.stackSummary,
          })]
        );

        res.json(preview);
      } catch (err: unknown) {
        handleRouteError(res, err, '[Workspaces] Scaffold preview');
      }
      return;
    }

    if (mode === 'write') {
      const files = req.body.files as Array<{ relativePath: string; content: string }> | undefined;
      if (!files || !Array.isArray(files) || files.length === 0) {
        throw new ValidationError('mode=write requires a non-empty files array');
        return;
      }

      // Validate file paths — prevent directory traversal
      for (const f of files) {
        if (!f.relativePath || !f.content) {
          throw new ValidationError('Each file must have relativePath and content');
          return;
        }
        const resolved = path.resolve(workspace.path, f.relativePath);
        if (!resolved.startsWith(workspace.path)) {
          throw new ValidationError(`Path traversal detected: ${f.relativePath}`);
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

        await execute(
          "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('scaffold_written', $1, $2)",
          [req.params.id, JSON.stringify({
            filesWritten: result.filesWritten.length,
            filesSkipped: result.filesSkipped.length,
            fileNames: result.filesWritten,
          })]
        );

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
      } catch (err: unknown) {
        handleRouteError(res, err, '[Workspaces] Scaffold write');
      }
      return;
    }

    throw new ValidationError(`Unknown mode: ${mode}. Use "preview" or "write".`);
  } catch (err) {
    next(err);
  }
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
router.post('/:id/bootstrap', requireWorkspaceAdmin(), async (req, res, next) => {
  try {
    const workspace = await queryOne<WorkspaceRow>('SELECT * FROM workspaces WHERE id = $1', [req.params.id]);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    if (!fs.existsSync(workspace.path)) {
      throw new ValidationError(`Workspace path does not exist: ${workspace.path}`);
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
        const l1Row = await queryOne<{ content_yaml: string }>(
          `SELECT content_yaml FROM direction_layers WHERE layer = 1 AND COALESCE(workspace_id, '') = '' AND COALESCE(domain, '') = ''`
        );

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
      await execute(
        "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('workspace_bootstrap', $1, $2)",
        [req.params.id, JSON.stringify({
          surfaceCount: surfaces.length,
          stackCount: report.stack.length,
          monorepo: report.monorepo.detected,
          healthBefore,
          healthAfter,
          filesCreated,
        })]
      );

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
    } catch (err: unknown) {
      handleRouteError(res, err, '[Workspaces] Bootstrap');
    }
  } catch (err) {
    next(err);
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
router.post('/:id/bootstrap/commit', requireWorkspaceAdmin(), async (req, res, next) => {
  try {
    const workspace = await queryOne<WorkspaceRow>('SELECT * FROM workspaces WHERE id = $1', [req.params.id]);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const { direction, scopes } = req.body;
    let layersSaved = 0;

    // Save L1 (Standards) only for platform superusers. Workspace admins may not
    // overwrite the global standards layer through a workspace-scoped endpoint.
    if (direction?.standards && req.user?.role === 'admin') {
      await execute(
        `INSERT INTO direction_layers (layer, workspace_id, domain, content_yaml, preferred_model, updated_at)
         VALUES ($1, $2, $3, $4, NULL, NOW())
         ON CONFLICT (layer, COALESCE(workspace_id,''), COALESCE(domain,''))
         DO UPDATE SET content_yaml = EXCLUDED.content_yaml, updated_at = NOW()`,
        [1, null, null, direction.standards]
      );
      layersSaved++;
    }

    // Save L2 (Conventions) — workspace-scoped
    if (direction?.conventions) {
      await execute(
        `INSERT INTO direction_layers (layer, workspace_id, domain, content_yaml, preferred_model, updated_at)
         VALUES ($1, $2, $3, $4, NULL, NOW())
         ON CONFLICT (layer, COALESCE(workspace_id,''), COALESCE(domain,''))
         DO UPDATE SET content_yaml = EXCLUDED.content_yaml, updated_at = NOW()`,
        [2, req.params.id, null, direction.conventions]
      );
      layersSaved++;
    }

    // Save L3 (Project) — workspace-scoped
    if (direction?.project) {
      await execute(
        `INSERT INTO direction_layers (layer, workspace_id, domain, content_yaml, preferred_model, updated_at)
         VALUES ($1, $2, $3, $4, NULL, NOW())
         ON CONFLICT (layer, COALESCE(workspace_id,''), COALESCE(domain,''))
         DO UPDATE SET content_yaml = EXCLUDED.content_yaml, updated_at = NOW()`,
        [3, req.params.id, null, direction.project]
      );
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
    await execute(
      "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('bootstrap_committed', $1, $2)",
      [req.params.id, JSON.stringify({ layersSaved })]
    );

    res.json({ ok: true, layersSaved });
  } catch (err) {
    next(err);
  }
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

/**
 * @swagger
 * /api/workspaces/{id}/context-health:
 *   get:
 *     tags: [Workspaces]
 *     summary: Get context readiness indicators for the Spec Forge pre-flight checklist
 *     operationId: getWorkspaceContextHealth
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Context health indicators
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 l3Present: { type: boolean }
 *                 gitMemoryCount: { type: integer }
 *                 schemaPresent: { type: boolean }
 *                 claudeMdPresent: { type: boolean }
 *                 skillsCount: { type: integer }
 *                 contextScore: { type: integer, description: "0-100 composite context readiness score" }
 *                 readiness: { type: string, enum: [ready, partial, absent], description: "Coarse readiness bucket for indicator color" }
 *                 needsHydration: { type: boolean, description: "True when the UI should show a non-blocking hydration nudge" }
 *                 nudge: { type: string, nullable: true, description: "Human-readable nudge message when context is absent or stale" }
 *                 gitMemoryStale: { type: boolean, description: "True when git memory hydration is missing or older than the staleness window" }
 *                 gitMemoryHydratedAt: { type: string, format: date-time, nullable: true }
 *                 schemaHydratedAt: { type: string, format: date-time, nullable: true }
 *       404: { description: "Workspace not found" }
 */
router.get('/:id/context-health', async (req, res, next) => {
  try {
    const workspace = await queryOne<WorkspaceRow>('SELECT * FROM workspaces WHERE id = $1', [req.params.id]);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    // Fetch all DB data in parallel
    const [l3Row, ctxRow, skillsRow] = await Promise.all([
      queryOne<{ content: string | null }>(
        "SELECT content FROM direction_layers WHERE workspace_id = $1 AND layer = 3 LIMIT 1",
        [req.params.id]
      ),
      queryOne<{ schema_snapshot: string | null; git_commit_count: number }>(
        'SELECT schema_snapshot, git_commit_count FROM workspace_context WHERE workspace_id = $1',
        [req.params.id]
      ),
      queryOne<{ cnt: string }>(
        'SELECT COUNT(*)::text AS cnt FROM installed_skills',
        []
      ),
    ]);

    const l3Present = !!(l3Row?.content);
    // gitMemoryCount: number of commits ingested (git_commit_count in workspace_context)
    const gitMemoryCount = ctxRow?.git_commit_count ?? 0;
    const schemaPresent = !!(ctxRow?.schema_snapshot);

    // CLAUDE.md exists in workspace root
    let claudeMdPresent = false;
    try {
      claudeMdPresent = fs.existsSync(path.join(workspace.path, 'CLAUDE.md'));
    } catch { /* non-fatal */ }

    const skillsCount = parseInt(skillsRow?.cnt ?? '0', 10);

    // Compute composite contextScore (0-100)
    // L3=25, gitMemory=20 (partial: gitMemoryCount*4 up to 20), schema=20, claudeMd=20, skills=15
    const contextScore = Math.min(
      (l3Present ? 25 : 0) +
      Math.min(gitMemoryCount * 4, 20) +
      (schemaPresent ? 20 : 0) +
      (claudeMdPresent ? 20 : 0) +
      (skillsCount >= 1 ? 15 : 0),
      100
    );

    // CTM-005: Concrete readiness/nudge summary so the UI can show indicators and a
    // non-blocking nudge when memory is absent or stale. Non-fatal.
    const hydration = await buildContextHealthSummary({
      workspaceId: req.params.id,
      workspacePath: workspace.path,
    });

    res.json({
      l3Present,
      gitMemoryCount,
      schemaPresent,
      claudeMdPresent,
      skillsCount,
      contextScore,
      readiness: hydration.readiness,
      needsHydration: hydration.needsHydration,
      nudge: hydration.nudge,
      gitMemoryStale: hydration.gitMemoryStale,
      gitMemoryHydratedAt: hydration.gitMemoryHydratedAt,
      schemaHydratedAt: hydration.schemaHydratedAt,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/workspaces/{id}:
 *   delete:
 *     tags: [Workspaces]
 *     summary: Delete a workspace
 *     operationId: deleteWorkspace
 *     description: >
 *       Permanently deletes a workspace record from the database and emits a
 *       workspace_delete WAL event. Does not delete files on disk. Any active
 *       pipeline runs associated with this workspace should be cancelled first.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Workspace ID
 *         example: cashflow-ai
 *     responses:
 *       204:
 *         description: Workspace deleted successfully (no content)
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// DELETE /api/workspaces/:id
router.delete('/:id', requireWorkspaceAdmin(), async (req, res, next) => {
  try {
    const workspaceId = String(req.params.id);

    await execute('DELETE FROM workspaces WHERE id = $1', [workspaceId]);

    await execute(
      "INSERT INTO wal_events (event_type, workspace_id) VALUES ('workspace_delete', $1)",
      [workspaceId]
    );

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
