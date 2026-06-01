/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * packs.ts — Convention Pack management routes.
 *
 * CA-003: POST /api/packs/install — Install a pack into a workspace
 *         GET  /api/packs          — List installed packs for a workspace
 * CA-015: GET  /api/packs/catalog  — List available packs from built-in packs/ directory
 *         DELETE /api/packs/:name  — Uninstall a pack from a workspace
 */

import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { query, queryOne, execute } from '../db/index';
import { installPack, forkPack } from '../lib/pack-installer';
import { PackRegistry, PackJsonSchema } from '../lib/pack-registry';
import { broadcastAll } from '../lib/sse-hub';
import { handleRouteError } from '../lib/async-handler';
import { logger } from '../lib/logger';
import { NotFoundError, UnprocessableError, ValidationError } from '../lib/errors';

const router = Router();

/**
 * @swagger
 * /api/packs/install:
 *   post:
 *     tags: [Packs]
 *     summary: Install a convention pack into a workspace
 *     operationId: installPack
 *     description: >
 *       Copies scaffold files (skipping existing), injects L0 direction layers,
 *       copies personas/conventions/skills, generates AGENTS.md, and registers
 *       in the convention_packs table. Idempotent — re-installing updates files
 *       but doesn't duplicate direction layers.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, packPath]
 *             properties:
 *               workspaceId:
 *                 type: string
 *                 description: Target workspace ID
 *               packPath:
 *                 type: string
 *                 description: Absolute or workspace-relative path to the pack directory
 *     responses:
 *       201:
 *         description: Pack installed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                 packName:
 *                   type: string
 *                 packVersion:
 *                   type: string
 *                 scaffoldCopied:
 *                   type: array
 *                   items:
 *                     type: string
 *                 scaffoldConflicts:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       relativePath:
 *                         type: string
 *                       reason:
 *                         type: string
 *                 directionLayersInjected:
 *                   type: integer
 *                 personasCopied:
 *                   type: array
 *                   items:
 *                     type: string
 *                 conventionsCopied:
 *                   type: array
 *                   items:
 *                     type: string
 *                 skillsCopied:
 *                   type: array
 *                   items:
 *                     type: string
 *                 agentsMdAction:
 *                   type: string
 *                   enum: [created, appended, skipped]
 *       400:
 *         description: Missing required fields or invalid pack path
 *       404:
 *         description: Workspace not found or pack path does not exist
 *       422:
 *         description: Invalid pack structure (missing pack.json or required dirs)
 */
router.post('/install', async (req: Request, res: Response) => {
  const { workspaceId, packPath } = req.body;

  if (!workspaceId || typeof workspaceId !== 'string') {
    throw new ValidationError('Missing required field: workspaceId');
    return;
  }

  if (!packPath || typeof packPath !== 'string') {
    throw new ValidationError('Missing required field: packPath');
    return;
  }

  // Resolve workspace
  const workspace = await queryOne<{ id: string; path: string; label: string }>(
    'SELECT * FROM workspaces WHERE id = $1', [workspaceId]
  );

  if (!workspace) {
    throw new NotFoundError('Workspace not found');
    return;
  }

  if (!fs.existsSync(workspace.path)) {
    throw new NotFoundError('Workspace path does not exist on disk');
    return;
  }

  // Resolve pack path (absolute or relative to workspace)
  const absPackPath = path.isAbsolute(packPath)
    ? packPath
    : path.join(workspace.path, packPath);

  if (!fs.existsSync(absPackPath)) {
    throw new NotFoundError('Pack path does not exist');
    return;
  }

  try {
    const result = await installPack(workspaceId, workspace.path, absPackPath);

    res.status(201).json({
      ok: true,
      packName: result.packName,
      packVersion: result.packVersion,
      scaffoldCopied: result.scaffoldCopied,
      scaffoldConflicts: result.scaffoldConflicts,
      directionLayersInjected: result.directionLayersInjected,
      personasCopied: result.personasCopied,
      conventionsCopied: result.conventionsCopied,
      skillsCopied: result.skillsCopied,
      agentsMdAction: result.agentsMdAction,
    });
  } catch (err: any) {
    // Re-throw AppError subclasses (ValidationError, NotFoundError, etc.) — error handler serializes them
    if (err.statusCode) throw err;
    logger.error('[Packs] Install error:', err);
    throw err;
  }
});

/**
 * @swagger
 * /api/packs/fork:
 *   post:
 *     tags: [Packs]
 *     summary: Fork an installed pack for workspace-local customization
 *     operationId: forkPack
 *     description: >
 *       Copies an installed pack to .rorca/packs/<newName>/, updates pack.json
 *       with the new name and a forkedFrom field referencing the original,
 *       unregisters the source pack, and re-installs from the forked copy.
 *       The forked pack is fully editable and replaces the original's L0 layers.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, sourcePack, newName]
 *             properties:
 *               workspaceId:
 *                 type: string
 *                 description: Target workspace ID
 *               sourcePack:
 *                 type: string
 *                 description: Name of the installed pack to fork
 *               newName:
 *                 type: string
 *                 description: >
 *                   Name for the forked pack (lowercase alphanumeric with dots/hyphens/underscores)
 *     responses:
 *       201:
 *         description: Pack forked successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                 newName:
 *                   type: string
 *                 newVersion:
 *                   type: string
 *                 forkedFrom:
 *                   type: string
 *                 forkedPackPath:
 *                   type: string
 *       400:
 *         description: Missing required fields or invalid pack name
 *       404:
 *         description: Workspace or source pack not found
 *       409:
 *         description: Fork destination already exists
 *       422:
 *         description: Invalid pack structure after fork
 */
router.post('/fork', async (req: Request, res: Response) => {
  const { workspaceId, sourcePack, newName } = req.body;

  if (!workspaceId || typeof workspaceId !== 'string') {
    throw new ValidationError('Missing required field: workspaceId');
    return;
  }

  if (!sourcePack || typeof sourcePack !== 'string') {
    throw new ValidationError('Missing required field: sourcePack');
    return;
  }

  if (!newName || typeof newName !== 'string') {
    throw new ValidationError('Missing required field: newName');
    return;
  }

  // Resolve workspace
  const workspace = await queryOne<{ id: string; path: string; label: string }>(
    'SELECT * FROM workspaces WHERE id = $1', [workspaceId]
  );

  if (!workspace) {
    throw new NotFoundError('Workspace not found');
    return;
  }

  if (!fs.existsSync(workspace.path)) {
    throw new NotFoundError('Workspace path does not exist on disk');
    return;
  }

  try {
    const result = await forkPack(workspaceId, workspace.path, sourcePack, newName);

    res.status(201).json({
      ok: true,
      newName: result.newName,
      newVersion: result.newVersion,
      forkedFrom: result.forkedFrom,
      forkedPackPath: result.forkedPackPath,
    });
  } catch (err: any) {
    // Re-throw AppError subclasses — error handler serializes them
    if (err.statusCode) throw err;
    logger.error('[Packs] Fork error:', err);
    throw err;
  }
});

/**
 * @swagger
 * /api/packs:
 *   get:
 *     tags: [Packs]
 *     summary: List installed packs for a workspace
 *     operationId: listInstalledPacks
 *     description: Returns all convention packs currently installed in the specified workspace.
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of installed packs
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 packs:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: integer
 *                       packName:
 *                         type: string
 *                       packVersion:
 *                         type: string
 *                       installedAt:
 *                         type: string
 *                       packPath:
 *                         type: string
 *       400:
 *         description: Missing workspaceId
 *       404:
 *         description: Workspace not found
 */
router.get('/', async (req: Request, res: Response) => {
  const workspaceId = req.query.workspaceId as string | undefined;

  if (!workspaceId) {
    throw new ValidationError('Missing required query param: workspaceId');
    return;
  }

  const workspace = await queryOne<{ id: string; path: string }>(
    'SELECT * FROM workspaces WHERE id = $1', [workspaceId]
  );

  if (!workspace) {
    throw new NotFoundError('Workspace not found');
    return;
  }

  const registry = new PackRegistry(workspace.path, workspaceId);
  const installed = await registry.listInstalled();

  res.json({
    packs: (installed as any[]).map(row => ({
      id: row.id,
      packName: row.pack_name ?? row.name,
      packVersion: row.pack_version ?? row.version,
      installedAt: row.installed_at ?? row.installedAt,
      packPath: row.pack_path ?? row.packPath,
      forkedFrom: null,
      valid: (row.packJson ?? row.manifest) !== null,
    })),
  });
});

/**
 * @swagger
 * /api/packs/catalog:
 *   get:
 *     tags: [Packs]
 *     summary: List available convention packs from built-in catalog
 *     operationId: listPackCatalog
 *     description: >
 *       Scans the Rorca built-in packs/ directory for valid pack.json files
 *       and returns their metadata. Optionally includes workspace install status.
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         schema:
 *           type: string
 *         description: Optional workspace ID to check install status
 *     responses:
 *       200:
 *         description: List of available packs
 */
router.get('/catalog', async (req: Request, res: Response) => {
  const workspaceId = req.query.workspaceId as string | undefined;

  // Rorca built-in packs directory
  const packsDir = path.resolve(__dirname, '../../../..', 'packs');

  if (!fs.existsSync(packsDir)) {
    res.json({ packs: [] });
    return;
  }

  // Get installed pack names for this workspace (if provided)
  const installedNames = new Set<string>();
  if (workspaceId) {
    const rows = await query<{ pack_name: string }>(
      'SELECT pack_name FROM convention_packs WHERE workspace_id = $1',
      [workspaceId]
    );
    for (const r of rows) installedNames.add(r.pack_name);
  }

  const entries = fs.readdirSync(packsDir, { withFileTypes: true });
  const packs: Array<{
    name: string;
    version: string;
    description: string;
    author: string | undefined;
    license: string | undefined;
    frameworks: string[];
    skills: string[];
    packPath: string;
    installed: boolean;
    hasPersonas: boolean;
    hasConventions: boolean;
    hasScaffold: boolean;
    hasAgentsMd: boolean;
  }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const packDir = path.join(packsDir, entry.name);
    const packJsonPath = path.join(packDir, 'pack.json');
    if (!fs.existsSync(packJsonPath)) continue;

    try {
      const raw = JSON.parse(fs.readFileSync(packJsonPath, 'utf-8'));
      const result = PackJsonSchema.safeParse(raw);
      if (!result.success) continue;

      const pack = result.data;
      const rawPack = raw as Record<string, unknown>;
      packs.push({
        name: pack.name,
        version: pack.version,
        description: pack.description,
        author: typeof rawPack.author === 'string' ? rawPack.author : undefined,
        license: typeof rawPack.license === 'string' ? rawPack.license : undefined,
        frameworks: pack.compatibility.frameworks,
        skills: pack.skills,
        packPath: packDir,
        installed: installedNames.has(pack.name),
        hasPersonas: fs.existsSync(path.join(packDir, 'personas')),
        hasConventions: fs.existsSync(path.join(packDir, 'conventions')),
        hasScaffold: fs.existsSync(path.join(packDir, 'scaffold')),
        hasAgentsMd: fs.existsSync(path.join(packDir, 'AGENTS.md')),
      });
    } catch {
      // Skip invalid packs
    }
  }

  res.json({ packs });
});

/**
 * @swagger
 * /api/packs/detail:
 *   get:
 *     tags: [Packs]
 *     summary: Get detailed contents of a pack
 *     operationId: getPackDetail
 *     description: Returns full pack details including direction layers, personas, conventions, scaffold tree, and AGENTS.md preview.
 *     parameters:
 *       - in: query
 *         name: packPath
 *         required: true
 *         schema:
 *           type: string
 *         description: Absolute path to the pack directory
 *     responses:
 *       200:
 *         description: Pack details including direction layers, personas, conventions, scaffold tree
 *       404:
 *         description: Pack path not found
 */
router.get('/detail', (req: Request, res: Response) => {
  const packPath = req.query.packPath as string | undefined;

  if (!packPath) {
    throw new ValidationError('Missing required query param: packPath');
    return;
  }

  if (!fs.existsSync(packPath)) {
    throw new NotFoundError('Pack path not found');
    return;
  }

  const packJsonPath = path.join(packPath, 'pack.json');
  if (!fs.existsSync(packJsonPath)) {
    throw new NotFoundError('pack.json not found');
    return;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(packJsonPath, 'utf-8'));
    const result = PackJsonSchema.safeParse(raw);
    if (!result.success) {
      throw new UnprocessableError('Invalid pack.json');
      return;
    }

    const pack = result.data;

    // Read direction layers preview
    const directionLayers: Array<{ filename: string; preview: string }> = [];
    const dirDir = path.join(packPath, 'direction');
    if (fs.existsSync(dirDir)) {
      for (const f of fs.readdirSync(dirDir).filter(f => f.endsWith('.md'))) {
        const content = fs.readFileSync(path.join(dirDir, f), 'utf-8');
        directionLayers.push({ filename: f, preview: content.slice(0, 500) });
      }
    }

    // List personas
    const personas: string[] = [];
    const personasDir = path.join(packPath, 'personas');
    if (fs.existsSync(personasDir)) {
      const scanDir = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (e.isDirectory()) {
            scanDir(path.join(dir, e.name));
          } else if (e.name.endsWith('.md')) {
            personas.push(path.relative(personasDir, path.join(dir, e.name)));
          }
        }
      };
      scanDir(personasDir);
    }

    // List conventions
    const conventions: string[] = [];
    const convDir = path.join(packPath, 'conventions');
    if (fs.existsSync(convDir)) {
      for (const f of fs.readdirSync(convDir).filter(f => f.endsWith('.md'))) {
        conventions.push(f);
      }
    }

    // Build scaffold file tree
    const scaffoldTree: string[] = [];
    const scaffoldDir = path.join(packPath, 'scaffold');
    if (fs.existsSync(scaffoldDir)) {
      const scanScaffold = (dir: string, prefix: string = '') => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const relPath = prefix ? `${prefix}/${e.name}` : e.name;
          if (e.isDirectory()) {
            scaffoldTree.push(`${relPath}/`);
            scanScaffold(path.join(dir, e.name), relPath);
          } else {
            scaffoldTree.push(relPath);
          }
        }
      };
      scanScaffold(scaffoldDir);
    }

    // Read AGENTS.md preview
    const agentsMdPath = path.join(packPath, 'AGENTS.md');
    const agentsMdPreview = fs.existsSync(agentsMdPath)
      ? fs.readFileSync(agentsMdPath, 'utf-8').slice(0, 500)
      : null;

    res.json({
      metadata: pack,
      directionLayers,
      personas,
      conventions,
      scaffoldTree,
      agentsMdPreview,
    });
  } catch (err: any) {
    handleRouteError(res, err, '[Packs] Detail');
  }
});

/**
 * @swagger
 * /api/packs/{name}:
 *   delete:
 *     tags: [Packs]
 *     summary: Uninstall a convention pack from a workspace
 *     operationId: uninstallPack
 *     description: >
 *       Removes the pack registration from the DB, deletes L0 direction layers
 *       injected by the pack, and cleans up .rorca/ files if from a forked pack.
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Pack uninstalled
 *       400:
 *         description: Missing workspaceId
 *       404:
 *         description: Pack or workspace not found
 */
router.delete('/:name', async (req: Request, res: Response) => {
  const packName = req.params.name as string;
  const rawWsId = req.query.workspaceId;

  if (!rawWsId || typeof rawWsId !== 'string') {
    throw new ValidationError('Missing required query param: workspaceId');
    return;
  }

  const workspaceId: string = rawWsId;

  const workspace = await queryOne<{ id: string; path: string }>(
    'SELECT * FROM workspaces WHERE id = $1', [workspaceId]
  );

  if (!workspace) {
    throw new NotFoundError('Workspace not found');
    return;
  }

  // Check pack exists
  const packRow = await queryOne<{ id: number; pack_name: string; pack_path: string; forked_from: string | null }>(
    'SELECT * FROM convention_packs WHERE workspace_id = $1 AND pack_name = $2',
    [workspaceId, packName]
  );

  if (!packRow) {
    throw new NotFoundError(`Pack "${packName}" not installed in this workspace`);
    return;
  }

  try {
    // Delete L0 direction layers for this workspace (pack-injected)
    await execute(
      'DELETE FROM direction_layers WHERE workspace_id = $1 AND layer = 0',
      [workspaceId]
    );

    // Delete installed_skills sourced from this pack
    await execute(
      'DELETE FROM installed_skills WHERE source = $1',
      [`pack:${packName}`]
    );

    // Unregister from DB
    const registry = new PackRegistry(workspace.path, workspaceId);
    registry.unregister(packName);

    // If it was a forked pack in .rorca/packs/, remove the directory
    if (packRow.pack_path && !path.isAbsolute(packRow.pack_path)) {
      const forkDir = path.join(workspace.path, packRow.pack_path);
      if (fs.existsSync(forkDir) && forkDir.includes('.rorca/packs/')) {
        fs.rmSync(forkDir, { recursive: true, force: true });
      }
    }

    // Emit WAL event
    broadcastAll({
      event_type: 'pack_uninstalled',
      workspace_id: workspaceId,
      payload: { packName },
    } as any);

    res.json({ ok: true, packName, removed: true });
  } catch (err: any) {
    // Re-throw AppError subclasses — error handler serializes them
    if (err.statusCode) throw err;
    logger.error('[Packs] Uninstall error:', err);
    throw err;
  }
});

export default router;
