/**
 * packs.ts — Convention Pack management routes.
 *
 * CA-003: POST /api/packs/install — Install a pack into a workspace
 *         GET  /api/packs          — List installed packs for a workspace
 */

import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { db } from '../db/index';
import { installPack } from '../lib/pack-installer';
import { PackRegistry } from '../lib/pack-registry';

const router = Router();

/**
 * @swagger
 * /api/packs/install:
 *   post:
 *     tags: [Packs]
 *     summary: Install a convention pack into a workspace
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
router.post('/install', (req: Request, res: Response) => {
  const { workspaceId, packPath } = req.body;

  if (!workspaceId || typeof workspaceId !== 'string') {
    res.status(400).json({ error: 'Missing required field: workspaceId' });
    return;
  }

  if (!packPath || typeof packPath !== 'string') {
    res.status(400).json({ error: 'Missing required field: packPath' });
    return;
  }

  // Resolve workspace
  const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId) as
    { id: string; path: string; label: string } | undefined;

  if (!workspace) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }

  if (!fs.existsSync(workspace.path)) {
    res.status(404).json({ error: 'Workspace path does not exist on disk' });
    return;
  }

  // Resolve pack path (absolute or relative to workspace)
  const absPackPath = path.isAbsolute(packPath)
    ? packPath
    : path.join(workspace.path, packPath);

  if (!fs.existsSync(absPackPath)) {
    res.status(404).json({ error: 'Pack path does not exist', packPath: absPackPath });
    return;
  }

  try {
    const result = installPack(workspaceId, workspace.path, absPackPath);

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
    // ValidationError from PackLoader or PackRegistry
    if (err.statusCode === 400 || err.name === 'ValidationError') {
      res.status(422).json({ error: err.message, details: err.details });
      return;
    }
    console.error('[Packs] Install error:', err);
    res.status(500).json({ error: 'Pack installation failed', details: err.message });
  }
});

/**
 * @swagger
 * /api/packs:
 *   get:
 *     tags: [Packs]
 *     summary: List installed packs for a workspace
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
router.get('/', (req: Request, res: Response) => {
  const workspaceId = req.query.workspaceId as string | undefined;

  if (!workspaceId) {
    res.status(400).json({ error: 'Missing required query param: workspaceId' });
    return;
  }

  const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId) as
    { id: string; path: string } | undefined;

  if (!workspace) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }

  const registry = new PackRegistry(workspace.path, workspaceId);
  const installed = registry.listInstalled();

  res.json({
    packs: installed.map(row => ({
      id: row.id,
      packName: row.pack_name,
      packVersion: row.pack_version,
      installedAt: row.installed_at,
      packPath: row.pack_path,
      valid: row.packJson !== null,
    })),
  });
});

export default router;
