import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { db } from '../db/index';
import { AuthUser } from './auth';
import { parsePaginationParams, paginateArray } from '../lib/paginate';
import { getEffectiveUser } from '../lib/get-user';
import { logger } from '../lib/logger';

const router = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface TemplateRow {
  id: string;
  name: string;
  description: string | null;
  source_spec_id: string;
  brief: string;
  story_structure: string;
  direction_layers: string | null;
  story_count: number;
  created_at: string;
  team_id: string | null;
  author_id: string | null;
  usage_count: number;
  last_used_at: string | null;
}

interface RatingRow {
  template_id: string;
  avg_rating: number;
  rating_count: number;
}

function getUserTeamIds(userId: string): string[] {
  const rows = db.prepare(
    'SELECT team_id FROM team_members WHERE user_id = ?'
  ).all(userId) as { team_id: string }[];
  return rows.map(r => r.team_id);
}

function getTemplateRating(templateId: string): { avgRating: number; ratingCount: number } {
  const row = db.prepare(
    `SELECT AVG(rating) as avg_rating, COUNT(*) as rating_count
     FROM template_ratings WHERE template_id = ?`
  ).get(templateId) as { avg_rating: number | null; rating_count: number };
  return {
    avgRating: row.avg_rating ? Math.round(row.avg_rating * 10) / 10 : 0,
    ratingCount: row.rating_count,
  };
}

function getAuthorInfo(authorId: string | null): { authorName: string | null; authorEmail: string | null } {
  if (!authorId) return { authorName: null, authorEmail: null };
  const user = db.prepare(
    'SELECT display_name, email FROM users WHERE id = ?'
  ).get(authorId) as { display_name: string; email: string } | undefined;
  return {
    authorName: user?.display_name ?? null,
    authorEmail: user?.email ?? null,
  };
}

function formatTemplate(row: TemplateRow, includeBody: boolean = false) {
  const { avgRating, ratingCount } = getTemplateRating(row.id);
  const { authorName, authorEmail } = getAuthorInfo(row.author_id);

  const result: Record<string, unknown> = {
    id: row.id,
    name: row.name,
    description: row.description,
    sourceSpecId: row.source_spec_id,
    storyCount: row.story_count,
    createdAt: row.created_at,
    teamId: row.team_id,
    authorId: row.author_id,
    authorName,
    authorEmail,
    usageCount: row.usage_count,
    lastUsedAt: row.last_used_at,
    avgRating,
    ratingCount,
  };

  // Always include brief (needed for template picker in Forge)
  result.brief = row.brief;

  if (includeBody) {
    result.storyStructure = JSON.parse(row.story_structure);
    result.directionLayers = row.direction_layers ? JSON.parse(row.direction_layers) : null;
  }

  return result;
}

/**
 * @swagger
 * /api/templates:
 *   post:
 *     tags: [Templates]
 *     summary: Create a template from an approved spec
 *     operationId: createTemplate
 *     description: Creates a reusable spec template from an approved spec's story structure and direction layers.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, sourceSpecId, brief, storyStructure]
 *             properties:
 *               name: { type: string }
 *               description: { type: string }
 *               sourceSpecId: { type: string }
 *               brief: { type: string }
 *               storyStructure: { type: array, items: { $ref: '#/components/schemas/UserStory' } }
 *               directionLayers: { type: object }
 *               teamId: { type: string }
 *     responses:
 *       201:
 *         description: Template created
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Template' }
 *       400: { description: "Missing required fields" }
 *   get:
 *     tags: [Templates]
 *     summary: List templates
 *     operationId: listTemplates
 *     description: Returns paginated templates filtered by scope (all, personal, or team) with ratings and author info.
 *     parameters:
 *       - in: query
 *         name: scope
 *         schema: { type: string, enum: [all, personal, team], default: all }
 *     responses:
 *       200:
 *         description: List of templates
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 templates:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/Template' }
 */
router.post('/', (req: Request, res: Response) => {
  try {
    const user = getEffectiveUser(req);
    if (!user) { res.status(500).json({ error: 'No user configured' }); return; }
    const { name, description, sourceSpecId, brief, storyStructure, directionLayers, teamId } = req.body;

    if (!name || !sourceSpecId || !brief || !storyStructure) {
      res.status(400).json({
        error: 'Missing required fields: name, sourceSpecId, brief, storyStructure',
      });
      return;
    }

    if (!Array.isArray(storyStructure) || storyStructure.length === 0) {
      res.status(400).json({ error: 'storyStructure must be a non-empty array' });
      return;
    }

    // Validate teamId if provided — user must be a member
    if (teamId) {
      const userTeamIds = getUserTeamIds(user.id);
      if (!userTeamIds.includes(teamId)) {
        res.status(403).json({ error: 'You are not a member of this team' });
        return;
      }
    }

    const id = randomUUID();
    const storyCount = storyStructure.length;

    db.prepare(
      `INSERT INTO templates (id, name, description, source_spec_id, brief, story_structure, direction_layers, story_count, team_id, author_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      name,
      description ?? null,
      sourceSpecId,
      brief,
      JSON.stringify(storyStructure),
      directionLayers ? JSON.stringify(directionLayers) : null,
      storyCount,
      teamId ?? null,
      user.id,
    );

    const row = db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as TemplateRow;
    res.status(201).json(formatTemplate(row, true));
  } catch (error: any) {
    logger.error('[Templates] Create error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── GET / — List templates with scope filtering ─────────────────────────────

router.get('/', (req: Request, res: Response) => {
  try {
    const user = getEffectiveUser(req);
    if (!user) { res.json({ templates: [] }); return; }
    const scope = (req.query.scope as string) || 'all';

    let rows: TemplateRow[];

    if (scope === 'personal') {
      // Only templates created by this user (no team_id)
      rows = db.prepare(
        `SELECT * FROM templates WHERE author_id = ? AND team_id IS NULL ORDER BY created_at DESC`
      ).all(user.id) as TemplateRow[];
    } else if (scope === 'team') {
      // Templates shared with any of user's teams
      const teamIds = getUserTeamIds(user.id);
      if (teamIds.length === 0) {
        rows = [];
      } else {
        const placeholders = teamIds.map(() => '?').join(',');
        rows = db.prepare(
          `SELECT * FROM templates WHERE team_id IN (${placeholders}) ORDER BY created_at DESC`
        ).all(...teamIds) as TemplateRow[];
      }
    } else {
      // 'all' — personal + team templates visible to this user
      const teamIds = getUserTeamIds(user.id);
      if (teamIds.length === 0) {
        // No teams — show personal (author_id match) + templates with no team_id (legacy/global)
        rows = db.prepare(
          `SELECT * FROM templates WHERE author_id = ? OR team_id IS NULL ORDER BY created_at DESC`
        ).all(user.id) as TemplateRow[];
      } else {
        const placeholders = teamIds.map(() => '?').join(',');
        rows = db.prepare(
          `SELECT * FROM templates
           WHERE author_id = ? OR team_id IS NULL OR team_id IN (${placeholders})
           ORDER BY created_at DESC`
        ).all(user.id, ...teamIds) as TemplateRow[];
      }
    }

    // Sort: featured (avg rating >= 4.0) first, then by created_at desc
    const templates = rows.map(row => formatTemplate(row));
    templates.sort((a, b) => {
      const aFeatured = (a.avgRating as number) >= 4.0 ? 1 : 0;
      const bFeatured = (b.avgRating as number) >= 4.0 ? 1 : 0;
      if (bFeatured !== aFeatured) return bFeatured - aFeatured;
      return 0; // preserve DB ordering (created_at DESC) within same featured status
    });

    const pagination = parsePaginationParams(req);
    res.json(paginateArray(templates, pagination, { cursorKey: (t) => t.id as string }));
  } catch (error: any) {
    logger.error('[Templates] List error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/templates/{id}/rate:
 *   post:
 *     tags: [Templates]
 *     summary: Rate a template (1-5)
 *     operationId: rateTemplate
 *     description: Submits or updates a 1-5 star rating for the specified template.
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
 *             required: [rating]
 *             properties:
 *               rating: { type: integer, minimum: 1, maximum: 5 }
 *     responses:
 *       200:
 *         description: Rating saved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 avgRating: { type: number }
 *                 ratingCount: { type: integer }
 *                 userRating: { type: integer }
 *       404: { description: "Template not found" }
 */
router.post('/:id/rate', (req: Request, res: Response) => {
  try {
    const user = getEffectiveUser(req);
    if (!user) { res.status(500).json({ error: 'No user configured' }); return; }
    const templateId = req.params.id as string;
    const { rating } = req.body;

    if (typeof rating !== 'number' || rating < 1 || rating > 5 || !Number.isInteger(rating)) {
      res.status(400).json({ error: 'Rating must be an integer between 1 and 5' });
      return;
    }

    // Check template exists
    const template = db.prepare('SELECT id, team_id FROM templates WHERE id = ?').get(templateId) as
      Pick<TemplateRow, 'id' | 'team_id'> | undefined;
    if (!template) {
      res.status(404).json({ error: 'Template not found' });
      return;
    }

    // If template belongs to a team, user must be a member
    if (template.team_id) {
      const userTeamIds = getUserTeamIds(user.id);
      if (!userTeamIds.includes(template.team_id)) {
        res.status(403).json({ error: 'You must be a team member to rate this template' });
        return;
      }
    }

    // Upsert rating
    const id = randomUUID();
    db.prepare(
      `INSERT INTO template_ratings (id, template_id, user_id, rating)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(template_id, user_id) DO UPDATE SET rating = excluded.rating, updated_at = datetime('now')`
    ).run(id, templateId, user.id, rating);

    const { avgRating, ratingCount } = getTemplateRating(templateId);
    res.json({ avgRating, ratingCount, userRating: rating });
  } catch (error: any) {
    logger.error('[Templates] Rate error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/templates/{id}/use:
 *   post:
 *     tags: [Templates]
 *     summary: Record template usage
 *     operationId: recordTemplateUsage
 *     description: Increments the usage count and updates the last_used_at timestamp for the specified template.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Usage recorded
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *       404:
 *         description: Template not found
 */
router.post('/:id/use', (req: Request, res: Response) => {
  try {
    const result = db.prepare(
      `UPDATE templates SET usage_count = usage_count + 1, last_used_at = datetime('now') WHERE id = ?`
    ).run(req.params.id);

    if (result.changes === 0) {
      res.status(404).json({ error: 'Template not found' });
      return;
    }

    res.json({ ok: true });
  } catch (error: any) {
    logger.error('[Templates] Use error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/templates/{id}:
 *   get:
 *     tags: [Templates]
 *     summary: Get a single template
 *     operationId: getTemplate
 *     description: Returns the full template including story structure, direction layers, and the requesting user's rating.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Template with full body
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Template' }
 *       404: { description: "Template not found" }
 *   delete:
 *     tags: [Templates]
 *     summary: Delete a template
 *     operationId: deleteTemplate
 *     description: Permanently deletes the specified template and its associated ratings.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       204: { description: "Deleted" }
 *       404: { description: "Template not found" }
 */
router.get('/:id', (req: Request, res: Response) => {
  try {
    const user = getEffectiveUser(req);
    if (!user) { res.status(500).json({ error: 'No user configured' }); return; }
    const row = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id) as TemplateRow | undefined;

    if (!row) {
      res.status(404).json({ error: 'Template not found' });
      return;
    }

    // Include user's own rating if any
    const userRating = db.prepare(
      'SELECT rating FROM template_ratings WHERE template_id = ? AND user_id = ?'
    ).get(row.id, user.id) as { rating: number } | undefined;

    const result = formatTemplate(row, true);
    (result as Record<string, unknown>).userRating = userRating?.rating ?? null;

    res.json(result);
  } catch (error: any) {
    logger.error('[Templates] Get error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── DELETE /:id — Remove a template ──────────────────────────────────────────

router.delete('/:id', (req: Request, res: Response) => {
  try {
    const result = db.prepare('DELETE FROM templates WHERE id = ?').run(req.params.id);

    if (result.changes === 0) {
      res.status(404).json({ error: 'Template not found' });
      return;
    }

    res.status(204).send();
  } catch (error: any) {
    logger.error('[Templates] Delete error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
