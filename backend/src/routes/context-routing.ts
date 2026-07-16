/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * context-routing.ts — API routes for CIE-010: Context Routing Settings UI.
 *
 * Provides endpoints for:
 * - Directory tree browsing (lazy-loaded)
 * - Skill file listing (.rorca/skills/*.md)
 * - Full .rorca/config.json routing config CRUD
 * - Config export/import
 * - "Eject to Config" (generate default config.json for new workspaces)
 */

import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { queryOne } from '../db/index';
import { validateBody } from '../lib/validate';
import {
  loadRorcaConfig,
  writeRorcaConfig,
  RorcaConfigSchema,
  hasRorcaDir,
  ensureRorcaDirStructure,
  defaultRorcaConfig,
  invalidateConfigCache,
} from '../lib/rorca-config';
import { invalidateConfig } from '../lib/context-cache';
import { populateConventionsFromConfig } from '../lib/knowledge-graph';
import { NotFoundError, ValidationError } from '../lib/errors';
import { handleRouteError } from '../lib/async-handler';
import { routeWorkspaceContext } from '../lib/workspace-context-routing';

const router = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function resolveWorkspacePath(workspaceId: string): Promise<string | null> {
  try {
    const row = await queryOne<{ path: string }>('SELECT path FROM workspaces WHERE id = $1', [workspaceId]);
    return row?.path ?? null;
  } catch {
    return null;
  }
}

interface DirEntry {
  name: string;
  path: string;
  type: 'directory' | 'file';
  children?: DirEntry[];
}

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt',
  'coverage', '__pycache__', 'target', '.venv', 'venv',
  '.turbo', '.cache', '.parcel-cache', '.output',
]);

// ─── Directory Tree ───────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/workspaces/{id}/directory-tree:
 *   get:
 *     summary: Get workspace directory tree (lazy-loaded by path)
 *     operationId: getDirectoryTree
 *     description: Returns a lazy-loaded directory listing for the given workspace, filtered to exclude common build/dependency directories.
 *     tags: [Context Routing]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *       - name: dirPath
 *         in: query
 *         required: false
 *         schema:
 *           type: string
 *         description: Relative path to list (empty = root)
 *     responses:
 *       200:
 *         description: Directory entries
 */
router.get('/:id/directory-tree', async (req: Request, res: Response) => {
  const wsPath = await resolveWorkspacePath(req.params.id as string);
  if (!wsPath) {
    throw new NotFoundError('Workspace not found');
    return;
  }

  const dirPath = (req.query.dirPath as string) || '';
  const absPath = path.join(wsPath, dirPath);

  // Security: prevent path traversal
  const resolved = path.resolve(absPath);
  if (!resolved.startsWith(path.resolve(wsPath))) {
    throw new ValidationError('Invalid path');
    return;
  }

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new NotFoundError('Directory not found');
    return;
  }

  try {
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const result: DirEntry[] = entries
      .filter(e => !e.name.startsWith('.') || e.name === '.rorca')
      .filter(e => !e.isDirectory() || !IGNORED_DIRS.has(e.name))
      .map(e => ({
        name: e.name,
        path: dirPath ? `${dirPath}/${e.name}` : e.name,
        type: e.isDirectory() ? 'directory' as const : 'file' as const,
      }))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    res.json({ entries: result, root: dirPath || '.' });
  } catch (err: unknown) {
    handleRouteError(res, err, '[ContextRouting] Read directory');
  }
});

// ─── Canonical Workspace-Context Routing Decision ─────────────────────────────

/**
 * @swagger
 * /api/workspaces/{id}/context-routing:
 *   get:
 *     summary: Get the canonical workspace-context routing decision
 *     operationId: getWorkspaceContextRouting
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Routing decision reflects workspace-owned context state (stack, missing files, .rorca contract) and should only be exposed to authenticated callers."
 *     description: >
 *       CTM-006: Returns the single deterministic workspace-context routing decision —
 *       detected stack, missing context files, a 0–100 richness score, and the validated
 *       .rorca / AGENTS.md / MEMORY.md routing contract. Quick-run generation and
 *       installed-skill injection route through this same path so the UI and execution
 *       never disagree about whether a workspace is context blind.
 *     tags: [Context Routing]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Canonical routing decision
 */
router.get('/:id/context-routing', async (req: Request, res: Response) => {
  const wsPath = await resolveWorkspacePath(req.params.id as string);
  if (!wsPath) {
    throw new NotFoundError('Workspace not found');
    return;
  }

  const routing = routeWorkspaceContext(wsPath);
  res.json({ routing });
});

// ─── Skills Listing ───────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/workspaces/{id}/skills:
 *   get:
 *     summary: List available .rorca/skills/*.md files
 *     operationId: listSkillFiles
 *     description: Lists all Markdown skill files in the workspace .rorca/skills/ directory with metadata.
 *     tags: [Context Routing]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of skill files
 */
router.get('/:id/skills', async (req: Request, res: Response) => {
  const wsPath = await resolveWorkspacePath(req.params.id as string);
  if (!wsPath) {
    throw new NotFoundError('Workspace not found');
    return;
  }

  const skillsDir = path.join(wsPath, '.rorca', 'skills');
  if (!fs.existsSync(skillsDir)) {
    res.json({ skills: [], hasRorcaDir: hasRorcaDir(wsPath) });
    return;
  }

  try {
    const files = fs.readdirSync(skillsDir)
      .filter(f => f.endsWith('.md'))
      .sort();

    const skills = files.map(f => {
      const filePath = path.join(skillsDir, f);
      const stat = fs.statSync(filePath);
      // Read first line for a description
      const content = fs.readFileSync(filePath, 'utf-8');
      const firstLine = content.split('\n').find(l => l.trim().length > 0) || '';
      const description = firstLine.startsWith('#')
        ? firstLine.replace(/^#+\s*/, '')
        : firstLine.slice(0, 80);

      return {
        filename: f,
        name: f.replace(/\.md$/, ''),
        description,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      };
    });

    res.json({ skills, hasRorcaDir: true });
  } catch {
    res.json({ skills: [], hasRorcaDir: hasRorcaDir(wsPath) });
  }
});

// ─── Rorca Config (routing section) ───────────────────────────────────────────

/**
 * @swagger
 * /api/workspaces/{id}/rorca-config:
 *   get:
 *     summary: Get the full .rorca/config.json (routing, context, orchestration, execution)
 *     operationId: getRorcaConfig
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Rorca config contains workspace-specific routing and execution preferences and should only be exposed to authenticated callers."
 *     description: Reads and returns the full .rorca/config.json with defaults applied for any missing fields.
 *     tags: [Context Routing]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Full rorca config with defaults applied
 */
router.get('/:id/rorca-config', async (req: Request, res: Response) => {
  const wsPath = await resolveWorkspacePath(req.params.id as string);
  if (!wsPath) {
    throw new NotFoundError('Workspace not found');
    return;
  }

  const config = loadRorcaConfig(wsPath);
  const configExists = hasRorcaDir(wsPath) &&
    fs.existsSync(path.join(wsPath, '.rorca', 'config.json'));

  res.json({ config, configExists, hasRorcaDir: hasRorcaDir(wsPath) });
});

/**
 * @swagger
 * /api/workspaces/{id}/rorca-config:
 *   put:
 *     summary: Save the full .rorca/config.json
 *     operationId: updateRorcaConfig
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Updating .rorca/config.json mutates workspace-owned execution settings and should require authenticated access."
 *     description: Validates and writes the provided config object to .rorca/config.json, creating the directory if needed.
 *     tags: [Context Routing]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               config:
 *                 type: object
 *     responses:
 *       200:
 *         description: Config saved
 *       400:
 *         description: Validation errors
 */
const RorcaConfigBodySchema = z.object({
  config: RorcaConfigSchema,
});

router.put('/:id/rorca-config', validateBody(RorcaConfigBodySchema), async (req: Request, res: Response) => {
  const wsPath = await resolveWorkspacePath(req.params.id as string);
  if (!wsPath) {
    throw new NotFoundError('Workspace not found');
    return;
  }

  writeRorcaConfig(wsPath, req.body.config);
  invalidateConfig(req.params.id as string); // PG-013

  // SW-008: Sync convention graph with updated config
  populateConventionsFromConfig(req.params.id as string, wsPath).catch(() => {
    // Graph population is best-effort — don't block config save
  });

  // Return the saved config (with defaults filled)
  const saved = loadRorcaConfig(wsPath);
  res.json({ config: saved, configExists: true });
});

// ─── Raw JSON Config ──────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/workspaces/{id}/rorca-config/raw:
 *   get:
 *     summary: Get raw .rorca/config.json text content (for JSON editor)
 *     operationId: getRorcaConfigRaw
 *     description: Returns the raw JSON text of .rorca/config.json for use in a code editor, or pretty-printed defaults if the file does not exist.
 *     tags: [Context Routing]
 */
router.get('/:id/rorca-config/raw', async (req: Request, res: Response) => {
  const wsPath = await resolveWorkspacePath(req.params.id as string);
  if (!wsPath) {
    throw new NotFoundError('Workspace not found');
    return;
  }

  const cfgPath = path.join(wsPath, '.rorca', 'config.json');
  if (!fs.existsSync(cfgPath)) {
    // Return pretty-printed defaults
    const defaults = defaultRorcaConfig();
    res.json({
      raw: JSON.stringify({ $schema: './config.schema.json', ...defaults }, null, 2),
      exists: false,
    });
    return;
  }

  const raw = fs.readFileSync(cfgPath, 'utf-8');
  res.json({ raw, exists: true });
});

/**
 * @swagger
 * /api/workspaces/{id}/rorca-config/raw:
 *   put:
 *     summary: Save raw JSON text to .rorca/config.json (with validation)
 *     operationId: updateRorcaConfigRaw
 *     description: Parses and validates raw JSON text, then writes it to .rorca/config.json preserving the user's formatting.
 *     tags: [Context Routing]
 */
router.put('/:id/rorca-config/raw', async (req: Request, res: Response) => {
  const wsPath = await resolveWorkspacePath(req.params.id as string);
  if (!wsPath) {
    throw new NotFoundError('Workspace not found');
    return;
  }

  const { raw } = req.body as { raw: string };
  if (typeof raw !== 'string') {
    throw new ValidationError('Missing raw JSON string');
    return;
  }

  // Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    const msg = err instanceof SyntaxError ? err.message : 'Invalid JSON';
    throw new ValidationError('JSON parse error', { parseError: msg });
    return;
  }

  // Validate schema
  const result = RorcaConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map(issue => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    throw new ValidationError('Schema validation failed', { issues });
    return;
  }

  // Write the raw text (user-formatted) to preserve their formatting
  ensureRorcaDirStructure(wsPath);
  const cfgPath = path.join(wsPath, '.rorca', 'config.json');
  fs.writeFileSync(cfgPath, raw, 'utf-8');
  invalidateConfigCache();
  invalidateConfig(req.params.id as string); // PG-013

  res.json({ config: result.data, configExists: true });
});

// ─── Eject to Config ──────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/workspaces/{id}/rorca-config/eject:
 *   post:
 *     summary: Generate default .rorca/config.json for a workspace that doesn't have one
 *     operationId: ejectRorcaConfig
 *     description: Creates a default .rorca/config.json in the workspace directory, enabling advanced configuration for the first time.
 *     tags: [Context Routing]
 */
router.post('/:id/rorca-config/eject', async (req: Request, res: Response) => {
  const wsPath = await resolveWorkspacePath(req.params.id as string);
  if (!wsPath) {
    throw new NotFoundError('Workspace not found');
    return;
  }

  const cfgPath = path.join(wsPath, '.rorca', 'config.json');
  if (fs.existsSync(cfgPath)) {
    // Config already exists — return it
    const config = loadRorcaConfig(wsPath);
    res.json({ config, configExists: true, ejected: false });
    return;
  }

  // Generate default config
  const config = defaultRorcaConfig();
  writeRorcaConfig(wsPath, config);

  const saved = loadRorcaConfig(wsPath);
  res.json({ config: saved, configExists: true, ejected: true });
});

// ─── Export Config ────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/workspaces/{id}/rorca-config/export:
 *   get:
 *     summary: Export .rorca/config.json as downloadable JSON
 *     operationId: exportRorcaConfig
 *     description: Returns the .rorca/config.json as a downloadable file attachment with Content-Disposition header.
 *     tags: [Context Routing]
 */
router.get('/:id/rorca-config/export', async (req: Request, res: Response) => {
  const wsPath = await resolveWorkspacePath(req.params.id as string);
  if (!wsPath) {
    throw new NotFoundError('Workspace not found');
    return;
  }

  const config = loadRorcaConfig(wsPath);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="rorca-config.json"');
  res.send(JSON.stringify({ $schema: './config.schema.json', ...config }, null, 2));
});

export default router;
