/**
 * skills.ts — Agent Skills CRUD routes.
 *
 * SK-001: GET /api/skills — list discovered + installed skills
 *         POST /api/skills/install — install a skill from content
 *         DELETE /api/skills/:name — remove an installed skill
 */

import { Router, Request, Response } from 'express';
import { db } from '../db/index';
import { SkillRegistry } from '../lib/skill-registry';

const router = Router();

/**
 * Resolve the workspace path from optional query param or first registered workspace.
 */
function resolveWorkspacePath(req: Request): string | null {
  const workspaceId = req.query.workspaceId as string | undefined;
  if (workspaceId) {
    const ws = db.prepare('SELECT path FROM workspaces WHERE id = ?').get(workspaceId) as { path: string } | undefined;
    return ws?.path ?? null;
  }
  // Default: first registered workspace
  const first = db.prepare('SELECT path FROM workspaces ORDER BY rowid LIMIT 1').get() as { path: string } | undefined;
  return first?.path ?? null;
}

/**
 * @swagger
 * /api/skills:
 *   get:
 *     tags: [Skills]
 *     summary: List all discovered and installed skills
 *     operationId: listSkills
 *     description: Scans the workspace for skill files and merges with DB-persisted installed skills, returning metadata and a prompt-ready catalog.
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         schema:
 *           type: string
 *         description: Optional workspace ID to scan skills from. Defaults to first workspace.
 *     responses:
 *       200:
 *         description: List of skills with metadata
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 skills:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                       description:
 *                         type: string
 *                       source:
 *                         type: string
 *                       filePath:
 *                         type: string
 *                 warnings:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       filePath:
 *                         type: string
 *                       reason:
 *                         type: string
 *                 catalog:
 *                   type: string
 *                   description: Compact name:description list for LLM prompt injection
 */
router.get('/', (req: Request, res: Response) => {
  try {
    const registry = new SkillRegistry();
    const workspacePath = resolveWorkspacePath(req);

    if (workspacePath) {
      registry.discover(workspacePath);
    } else {
      // No workspace — only return DB-persisted skills
      const dbSkills = db.prepare('SELECT name, description, source, content FROM installed_skills').all() as {
        name: string;
        description: string;
        source: string;
        content: string;
      }[];
      // Manual load into registry is not needed — discover() handles DB merge.
      // But with no workspace path we just return DB skills directly.
      res.json({
        skills: dbSkills.map(s => ({
          name: s.name,
          description: s.description,
          source: s.source,
          filePath: '',
        })),
        warnings: [],
        catalog: dbSkills.map(s => `${s.name}: ${s.description}`).join('\n'),
      });
      return;
    }

    const skills = registry.getAll();
    res.json({
      skills: skills.map(s => ({
        name: s.metadata.name,
        description: s.metadata.description,
        source: s.source,
        filePath: s.filePath,
      })),
      warnings: registry.getWarnings(),
      catalog: registry.getCatalogForPrompt(),
    });
  } catch (error: any) {
    console.error('[Skills] List error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/skills/install:
 *   post:
 *     tags: [Skills]
 *     summary: Install a skill from markdown content
 *     operationId: installSkill
 *     description: Persists a new skill from the provided markdown content with optional YAML frontmatter into the installed_skills table.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, content]
 *             properties:
 *               name:
 *                 type: string
 *                 description: Skill name (overridden by frontmatter name if present)
 *               content:
 *                 type: string
 *                 description: Full markdown content (with optional YAML frontmatter)
 *               source:
 *                 type: string
 *                 description: Source label (default 'user')
 *     responses:
 *       201:
 *         description: Skill installed
 *       400:
 *         description: Missing required fields
 */
router.post('/install', (req: Request, res: Response) => {
  try {
    const { name, content, source } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    if (!content || typeof content !== 'string') {
      res.status(400).json({ error: 'content is required' });
      return;
    }

    const registry = new SkillRegistry();
    const skill = registry.install(name.trim(), content, source || 'user');

    res.status(201).json({
      name: skill.metadata.name,
      description: skill.metadata.description,
      source: skill.source,
    });
  } catch (error: any) {
    console.error('[Skills] Install error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/skills/{name}:
 *   delete:
 *     tags: [Skills]
 *     summary: Remove an installed skill by name
 *     operationId: removeSkill
 *     description: Deletes the specified skill from the installed_skills table by name.
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Skill name to remove
 *     responses:
 *       200:
 *         description: Skill removed
 *       404:
 *         description: Skill not found in installed_skills table
 */
router.delete('/:name', (req: Request, res: Response) => {
  try {
    const name = req.params.name as string;
    const registry = new SkillRegistry();
    const removed = registry.remove(name);

    if (!removed) {
      res.status(404).json({ error: `Skill "${name}" not found in installed skills` });
      return;
    }

    res.json({ removed: true, name });
  } catch (error: any) {
    console.error('[Skills] Remove error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
