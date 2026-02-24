import { Router } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { db } from '../db/index';
import { hydrateSchema } from '../lib/schema-hydrator';
import {
  gitMapStep,
  gitReduceStep,
  getLatestHash,
} from '../lib/git-hydrator';

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
router.post('/', (req, res) => {
  const { id, label, path, domains } = req.body;

  if (!id || !label || !path || !domains) {
    res.status(400).json({ error: 'Missing required fields: id, label, path, domains' });
    return;
  }

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
  res.status(201).json({ workspace: parseWorkspace(row) });
});

// GET /api/workspaces
router.get('/', (_req, res) => {
  const rows = db.prepare('SELECT * FROM workspaces ORDER BY created_at DESC').all() as WorkspaceRow[];
  res.json({ workspaces: rows.map(parseWorkspace) });
});

/**
 * @swagger
 * /api/workspaces/{id}/context:
 *   get:
 *     tags: [Workspaces]
 *     summary: Get workspace hydrated context (schema + git)
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
      console.warn(`[Hydrate] Schema hydration returned 0 tables for workspace ${id}`);
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

// PATCH /api/workspaces/:id — Update workspace settings (e.g. pr_template)
router.patch('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.params.id) as WorkspaceRow | undefined;
  if (!row) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }

  const { pr_template } = req.body;
  if (pr_template !== undefined) {
    const value = pr_template === null || pr_template === '' ? null : String(pr_template);
    db.prepare('UPDATE workspaces SET pr_template = ? WHERE id = ?').run(value, req.params.id);
  }

  const updated = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.params.id) as WorkspaceRow;
  res.json({ workspace: parseWorkspace(updated) });
});

// DELETE /api/workspaces/:id
router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM workspaces WHERE id = ?').run(req.params.id);

  db.prepare(
    "INSERT INTO wal_events (event_type, workspace_id) VALUES ('workspace_delete', ?)"
  ).run(req.params.id);

  res.status(204).send();
});

export default router;
