/**
 * context-files.ts — CIE-011: API routes for context/intent file editing.
 *
 * Provides endpoints for:
 * - Listing all registered context/intent files (CLAUDE.md, AGENTS.md, skills, MEMORY.md)
 * - Reading file content
 * - Writing file content (with echo suppression for chokidar)
 * - Git diff against last committed version
 * - Creating new skill files from template
 */

import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { db } from '../db/index';
import { loadRorcaConfig } from '../lib/rorca-config';
import { markWriting } from '../lib/file-watcher';

const router = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveWorkspacePath(workspaceId: string): string | null {
  try {
    const row = db.prepare('SELECT path FROM workspaces WHERE id = ?').get(workspaceId) as
      { path: string } | undefined;
    return row?.path ?? null;
  } catch {
    return null;
  }
}

/** Well-known context/intent files relative to workspace root */
const WELL_KNOWN_FILES = [
  { path: 'CLAUDE.md', role: 'context' as const, managed: 'hybrid' as const },
  { path: 'AGENTS.md', role: 'governance' as const, managed: 'hybrid' as const },
  { path: '.rorca/MEMORY.md', role: 'memory' as const, managed: 'rorca' as const },
  { path: '.rorca/AGENTS.md', role: 'governance' as const, managed: 'rorca' as const },
];

interface ContextFileEntry {
  relativePath: string;
  role: string;
  managed: 'rorca' | 'manual' | 'hybrid';
  exists: boolean;
  sizeBytes: number;
  modifiedAt: string | null;
}

function estimateTokens(text: string): number {
  // ~4 chars per token for English/code text
  return Math.ceil(text.length / 4);
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(w => w.length > 0).length;
}

// ─── List Context Files ──────────────────────────────────────────────────────

/**
 * @swagger
 * /api/workspaces/{id}/context-files:
 *   get:
 *     summary: List all registered context/intent files for a workspace
 *     tags: [Context Files]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Array of context file entries
 */
router.get('/:id/context-files', (req: Request, res: Response) => {
  const wsPath = resolveWorkspacePath(req.params.id as string);
  if (!wsPath) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }

  const files: ContextFileEntry[] = [];
  const seen = new Set<string>();

  // 1. Well-known files
  for (const wk of WELL_KNOWN_FILES) {
    const abs = path.join(wsPath, wk.path);
    const exists = fs.existsSync(abs);
    let sizeBytes = 0;
    let modifiedAt: string | null = null;
    if (exists) {
      const stat = fs.statSync(abs);
      sizeBytes = stat.size;
      modifiedAt = stat.mtime.toISOString();
    }
    files.push({
      relativePath: wk.path,
      role: wk.role,
      managed: wk.managed,
      exists,
      sizeBytes,
      modifiedAt,
    });
    seen.add(wk.path);
  }

  // 2. Files from .rorca/config.json fileRegistry
  const config = loadRorcaConfig(wsPath);
  if (config.context?.fileRegistry) {
    for (const entry of config.context.fileRegistry) {
      if (seen.has(entry.path)) continue;
      const abs = path.join(wsPath, entry.path);
      const exists = fs.existsSync(abs);
      let sizeBytes = 0;
      let modifiedAt: string | null = null;
      if (exists) {
        const stat = fs.statSync(abs);
        sizeBytes = stat.size;
        modifiedAt = stat.mtime.toISOString();
      }
      files.push({
        relativePath: entry.path,
        role: entry.role,
        managed: entry.managed,
        exists,
        sizeBytes,
        modifiedAt,
      });
      seen.add(entry.path);
    }
  }

  // 3. Skill files from .rorca/skills/
  const skillsDir = path.join(wsPath, '.rorca', 'skills');
  if (fs.existsSync(skillsDir)) {
    try {
      const skillFiles = fs.readdirSync(skillsDir).filter(f => f.endsWith('.md')).sort();
      for (const f of skillFiles) {
        const relPath = `.rorca/skills/${f}`;
        if (seen.has(relPath)) continue;
        const abs = path.join(skillsDir, f);
        const stat = fs.statSync(abs);
        files.push({
          relativePath: relPath,
          role: 'skill',
          managed: 'manual',
          exists: true,
          sizeBytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        });
        seen.add(relPath);
      }
    } catch { /* ignore */ }
  }

  // 4. Global routing files that aren't already listed
  for (const globalFile of config.routing?.global ?? []) {
    if (seen.has(globalFile)) continue;
    const abs = path.join(wsPath, globalFile);
    const exists = fs.existsSync(abs);
    let sizeBytes = 0;
    let modifiedAt: string | null = null;
    if (exists) {
      const stat = fs.statSync(abs);
      sizeBytes = stat.size;
      modifiedAt = stat.mtime.toISOString();
    }
    files.push({
      relativePath: globalFile,
      role: 'context',
      managed: 'manual',
      exists,
      sizeBytes,
      modifiedAt,
    });
    seen.add(globalFile);
  }

  res.json({ files });
});

// ─── Read File Content ───────────────────────────────────────────────────────

/**
 * @swagger
 * /api/workspaces/{id}/context-files/read:
 *   get:
 *     summary: Read the content of a context/intent file
 *     tags: [Context Files]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *       - name: filePath
 *         in: query
 *         required: true
 *         schema:
 *           type: string
 *         description: Relative path within workspace
 *     responses:
 *       200:
 *         description: File content + metadata
 */
router.get('/:id/context-files/read', (req: Request, res: Response) => {
  const wsPath = resolveWorkspacePath(req.params.id as string);
  if (!wsPath) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }

  const filePath = req.query.filePath as string;
  if (!filePath) {
    res.status(400).json({ error: 'Missing filePath query parameter' });
    return;
  }

  const abs = path.resolve(wsPath, filePath);
  // Security: prevent path traversal
  if (!abs.startsWith(path.resolve(wsPath))) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }

  if (!fs.existsSync(abs)) {
    res.status(404).json({ error: 'File not found' });
    return;
  }

  const content = fs.readFileSync(abs, 'utf-8');
  const stat = fs.statSync(abs);

  res.json({
    content,
    wordCount: countWords(content),
    estimatedTokens: estimateTokens(content),
    sizeBytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  });
});

// ─── Write File Content ──────────────────────────────────────────────────────

/**
 * @swagger
 * /api/workspaces/{id}/context-files/write:
 *   put:
 *     summary: Write content to a context/intent file
 *     tags: [Context Files]
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
 *               filePath:
 *                 type: string
 *               content:
 *                 type: string
 *     responses:
 *       200:
 *         description: File saved successfully
 */
router.put('/:id/context-files/write', (req: Request, res: Response) => {
  const wsPath = resolveWorkspacePath(req.params.id as string);
  if (!wsPath) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }

  const { filePath, content } = req.body as { filePath: string; content: string };
  if (!filePath || typeof content !== 'string') {
    res.status(400).json({ error: 'Missing filePath or content' });
    return;
  }

  const abs = path.resolve(wsPath, filePath);
  // Security: prevent path traversal
  if (!abs.startsWith(path.resolve(wsPath))) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }

  // Ensure parent directory exists
  const dir = path.dirname(abs);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Mark for echo suppression before writing
  markWriting(abs);
  fs.writeFileSync(abs, content, 'utf-8');

  const stat = fs.statSync(abs);
  res.json({
    saved: true,
    wordCount: countWords(content),
    estimatedTokens: estimateTokens(content),
    sizeBytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  });
});

// ─── Git Diff ────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/workspaces/{id}/context-files/diff:
 *   get:
 *     summary: Get git diff of a context file vs last committed version
 *     tags: [Context Files]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *       - name: filePath
 *         in: query
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Git diff output + committed content
 */
router.get('/:id/context-files/diff', (req: Request, res: Response) => {
  const wsPath = resolveWorkspacePath(req.params.id as string);
  if (!wsPath) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }

  const filePath = req.query.filePath as string;
  if (!filePath) {
    res.status(400).json({ error: 'Missing filePath query parameter' });
    return;
  }

  const abs = path.resolve(wsPath, filePath);
  if (!abs.startsWith(path.resolve(wsPath))) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }

  try {
    // Get the committed version (HEAD)
    let committedContent: string | null = null;
    try {
      committedContent = execSync(`git show HEAD:${filePath}`, {
        cwd: wsPath,
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      // File not in git yet (new/untracked)
      committedContent = null;
    }

    // Get unified diff
    let diff = '';
    try {
      diff = execSync(`git diff HEAD -- ${filePath}`, {
        cwd: wsPath,
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      diff = '';
    }

    const hasChanges = diff.length > 0;

    res.json({
      diff,
      committedContent,
      hasChanges,
      isTracked: committedContent !== null,
    });
  } catch {
    res.status(500).json({ error: 'Failed to compute diff' });
  }
});

// ─── Create New Skill File ───────────────────────────────────────────────────

/**
 * @swagger
 * /api/workspaces/{id}/context-files/create-skill:
 *   post:
 *     summary: Create a new skill file in .rorca/skills/ with a default template
 *     tags: [Context Files]
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
 *               filename:
 *                 type: string
 *                 description: Filename without extension (e.g. "my-skill")
 *     responses:
 *       201:
 *         description: Skill file created
 *       409:
 *         description: File already exists
 */
router.post('/:id/context-files/create-skill', (req: Request, res: Response) => {
  const wsPath = resolveWorkspacePath(req.params.id as string);
  if (!wsPath) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }

  const { filename } = req.body as { filename: string };
  if (!filename || typeof filename !== 'string') {
    res.status(400).json({ error: 'Missing filename' });
    return;
  }

  // Sanitize filename
  const sanitized = filename.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  if (!sanitized) {
    res.status(400).json({ error: 'Invalid filename' });
    return;
  }

  const relPath = `.rorca/skills/${sanitized}.md`;
  const abs = path.join(wsPath, relPath);

  if (fs.existsSync(abs)) {
    res.status(409).json({ error: 'File already exists', path: relPath });
    return;
  }

  // Ensure directory exists
  const dir = path.dirname(abs);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const template = `# ${sanitized}

## Description

Describe what this skill does and when it should be injected.

## Instructions

- Step-by-step instructions for the agent when this skill is active
- Be specific about expected behavior, coding patterns, and conventions

## Context

Additional context the agent needs to follow this skill correctly.
`;

  markWriting(abs);
  fs.writeFileSync(abs, template, 'utf-8');

  const stat = fs.statSync(abs);
  res.status(201).json({
    created: true,
    relativePath: relPath,
    sizeBytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  });
});

export default router;
