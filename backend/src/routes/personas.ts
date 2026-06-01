/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * personas.ts — CA-016: API routes for persona CRUD + enable/disable.
 *
 * Provides endpoints for:
 * - Listing all discovered personas (grouped by category)
 * - Reading a single persona file
 * - Writing/updating a persona file
 * - Creating a new persona from template
 * - Toggling persona enabled/disabled (persisted in .rorca/config.json personas.disabled[])
 */

import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { queryOne } from '../db/index';
import { PersonaRegistry, PERSONA_CATEGORIES, type PersonaCategory } from '../lib/agent-personas';
import { loadRorcaConfig, writeRorcaConfig } from '../lib/rorca-config';
import { markWriting } from '../lib/file-watcher';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../lib/errors';

const router = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Built-in default personas shipped with Rorca — used when workspace has no custom personas yet
const DEFAULT_PERSONAS_DIR = path.resolve(__dirname, '..', '..', '..', 'default-personas');

async function resolveWorkspacePath(workspaceId: string): Promise<string | null> {
  try {
    const row = await queryOne<{ path: string }>('SELECT path FROM workspaces WHERE id = $1', [workspaceId]);
    return row?.path ?? null;
  } catch {
    return null;
  }
}

const DEFAULT_PERSONA_TEMPLATE = `---
category: specialist
name: {{NAME}}
description: {{DESCRIPTION}}
triggers: []
reviewPriority: 50
---

You are the **{{NAME}}** specialist persona.

## Role
Describe the role and expertise of this persona.

## Guidelines
- Add specific guidelines for this persona
- Include coding standards, review criteria, etc.
`;

// ─── List Personas ──────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/personas:
 *   get:
 *     summary: List all discovered personas for a workspace, grouped by category
 *     operationId: listPersonas
 *     description: Scans the workspace .rorca/personas/ directory and returns all discovered personas grouped by category with enabled/disabled status.
 *     tags: [Personas]
 *     parameters:
 *       - name: workspaceId
 *         in: query
 *         required: true
 *         schema:
 *           type: string
 *       - name: category
 *         in: query
 *         required: false
 *         schema:
 *           type: string
 *           enum: [primary, adversarial, specialist, review]
 *     responses:
 *       200:
 *         description: Personas grouped by category with disabled status
 */
router.get('/', async (req: Request, res: Response) => {
  const workspaceId = req.query.workspaceId as string;
  if (!workspaceId) {
    throw new ValidationError('workspaceId query parameter required');
  }

  const wsPath = await resolveWorkspacePath(workspaceId);
  if (!wsPath) {
    throw new NotFoundError('Workspace not found');
  }

  const rorcaDir = path.join(wsPath, '.rorca');
  const registry = new PersonaRegistry();
  registry.discover(rorcaDir);

  // If no workspace personas found, seed from built-in defaults
  if (registry.getAll().length === 0 && fs.existsSync(DEFAULT_PERSONAS_DIR)) {
    registry.discover(DEFAULT_PERSONAS_DIR);
  }

  const config = loadRorcaConfig(wsPath);
  const disabledSet = new Set(config.personas.disabled);
  const categoryFilter = req.query.category as PersonaCategory | undefined;

  const categories = categoryFilter
    ? [categoryFilter]
    : [...PERSONA_CATEGORIES];

  const grouped: Record<string, Array<{
    name: string;
    category: PersonaCategory;
    description: string;
    triggers: string[];
    reviewPriority: number;
    filePath: string;
    relativePath: string;
    enabled: boolean;
  }>> = {};

  for (const cat of categories) {
    const personas = registry.getByCategory(cat);
    grouped[cat] = personas.map(p => ({
      name: p.metadata.name,
      category: p.metadata.category,
      description: p.metadata.description,
      triggers: p.metadata.triggers,
      reviewPriority: p.metadata.reviewPriority,
      filePath: p.filePath,
      relativePath: path.relative(wsPath, p.filePath),
      enabled: !disabledSet.has(p.metadata.name),
    }));
  }

  return res.json({
    personas: grouped,
    warnings: registry.getWarnings(),
    totalCount: registry.getAll().length,
    disabledCount: disabledSet.size,
  });
});

// ─── Read Persona File ──────────────────────────────────────────────────────

/**
 * @swagger
 * /api/personas/read:
 *   get:
 *     summary: Read a persona file's content
 *     operationId: readPersonaFile
 *     description: Returns the raw markdown content of a specific persona file by its relative path within the workspace.
 *     tags: [Personas]
 *     parameters:
 *       - name: workspaceId
 *         in: query
 *         required: true
 *       - name: filePath
 *         in: query
 *         required: true
 *         description: Relative path from workspace root (e.g. .rorca/personas/_specialist/frontend.md)
 */
router.get('/read', async (req: Request, res: Response) => {
  const workspaceId = req.query.workspaceId as string;
  const filePath = req.query.filePath as string;

  if (!workspaceId || !filePath) {
    throw new ValidationError('workspaceId and filePath query parameters required');
  }

  const wsPath = await resolveWorkspacePath(workspaceId);
  if (!wsPath) {
    throw new NotFoundError('Workspace not found');
  }

  const absPath = path.resolve(wsPath, filePath);
  // Security: ensure path is within workspace
  if (!absPath.startsWith(wsPath)) {
    throw new ForbiddenError('Path traversal not allowed');
  }

  if (!fs.existsSync(absPath)) {
    throw new NotFoundError('Persona file not found');
  }

  const content = fs.readFileSync(absPath, 'utf-8');
  return res.json({ content, filePath });
});

// ─── Write Persona File ─────────────────────────────────────────────────────

/**
 * @swagger
 * /api/personas/write:
 *   put:
 *     summary: Write/update a persona file's content
 *     operationId: writePersonaFile
 *     description: Writes or overwrites the markdown content of a persona file at the specified relative path.
 *     tags: [Personas]
 */
router.put('/write', async (req: Request, res: Response) => {
  const { workspaceId, filePath, content } = req.body as {
    workspaceId: string;
    filePath: string;
    content: string;
  };

  if (!workspaceId || !filePath || typeof content !== 'string') {
    throw new ValidationError('workspaceId, filePath, and content required');
  }

  const wsPath = await resolveWorkspacePath(workspaceId);
  if (!wsPath) {
    throw new NotFoundError('Workspace not found');
  }

  const absPath = path.resolve(wsPath, filePath);
  if (!absPath.startsWith(wsPath)) {
    throw new ForbiddenError('Path traversal not allowed');
  }

  // Ensure parent directory exists
  const dir = path.dirname(absPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  markWriting(absPath);
  fs.writeFileSync(absPath, content, 'utf-8');

  return res.json({ ok: true, filePath });
});

// ─── Create Persona ─────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/personas/create:
 *   post:
 *     summary: Create a new persona from template
 *     operationId: createPersona
 *     description: Creates a new persona markdown file from the default template in the appropriate category directory.
 *     tags: [Personas]
 */
router.post('/create', async (req: Request, res: Response) => {
  const { workspaceId, name, description, category } = req.body as {
    workspaceId: string;
    name: string;
    description?: string;
    category?: PersonaCategory;
  };

  if (!workspaceId || !name) {
    throw new ValidationError('workspaceId and name required');
  }

  const wsPath = await resolveWorkspacePath(workspaceId);
  if (!wsPath) {
    throw new NotFoundError('Workspace not found');
  }

  const cat = category || 'specialist';
  const safeName = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const catDir = `_${cat}`;
  const relativePath = `.rorca/personas/${catDir}/${safeName}.md`;
  const absPath = path.join(wsPath, relativePath);

  if (fs.existsSync(absPath)) {
    throw new ConflictError(`Persona file already exists: ${relativePath}`);
  }

  // Ensure directory exists
  const dir = path.dirname(absPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const fileContent = DEFAULT_PERSONA_TEMPLATE
    .replace(/\{\{NAME\}\}/g, name)
    .replace(/\{\{DESCRIPTION\}\}/g, description || `${name} specialist persona`)
    .replace(/category: specialist/, `category: ${cat}`);

  markWriting(absPath);
  fs.writeFileSync(absPath, fileContent, 'utf-8');

  return res.status(201).json({ ok: true, filePath: relativePath, absPath });
});

// ─── Toggle Persona Enable/Disable ──────────────────────────────────────────

/**
 * @swagger
 * /api/personas/toggle:
 *   post:
 *     summary: Enable or disable a persona
 *     operationId: togglePersona
 *     description: Toggles a persona's enabled/disabled state by updating the .rorca/config.json personas.disabled array.
 *     tags: [Personas]
 */
router.post('/toggle', async (req: Request, res: Response) => {
  const { workspaceId, personaName, enabled } = req.body as {
    workspaceId: string;
    personaName: string;
    enabled: boolean;
  };

  if (!workspaceId || !personaName || typeof enabled !== 'boolean') {
    throw new ValidationError('workspaceId, personaName, and enabled (boolean) required');
  }

  const wsPath = await resolveWorkspacePath(workspaceId);
  if (!wsPath) {
    throw new NotFoundError('Workspace not found');
  }

  const config = loadRorcaConfig(wsPath);
  const disabled = new Set(config.personas.disabled);

  if (enabled) {
    disabled.delete(personaName);
  } else {
    disabled.add(personaName);
  }

  config.personas.disabled = [...disabled];
  writeRorcaConfig(wsPath, config);

  return res.json({ ok: true, disabled: config.personas.disabled });
});

export default router;
