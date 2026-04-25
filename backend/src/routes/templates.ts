import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { query, queryOne, execute } from '../db/index';
import { parsePaginationParams, paginateArray } from '../lib/paginate';
import { getEffectiveUser } from '../lib/get-user';
import { logger } from '../lib/logger';
import { ForbiddenError, NotFoundError, ValidationError } from '../lib/errors';
import { handleRouteError } from '../lib/async-handler';

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

async function getUserTeamIds(userId: string): Promise<string[]> {
  const rows = await query<{ team_id: string }>(
    'SELECT team_id FROM team_members WHERE user_id = $1',
    [userId]
  );
  return rows.map(r => r.team_id);
}

async function getUserTeamRole(userId: string, teamId: string): Promise<string | null> {
  const row = await queryOne<{ role: string }>(
    'SELECT role FROM team_members WHERE user_id = $1 AND team_id = $2',
    [userId, teamId]
  );
  return row?.role ?? null;
}

async function canReadTemplate(userId: string, row: Pick<TemplateRow, 'author_id' | 'team_id'>): Promise<boolean> {
  if (row.author_id === userId) {
    return true;
  }

  if (!row.team_id) {
    return false;
  }

  const teamIds = await getUserTeamIds(userId);
  return teamIds.includes(row.team_id);
}

async function canManageTemplate(userId: string, row: Pick<TemplateRow, 'author_id' | 'team_id'>): Promise<boolean> {
  if (row.author_id === userId) {
    return true;
  }

  if (!row.team_id) {
    return false;
  }

  const role = await getUserTeamRole(userId, row.team_id);
  return role === 'admin';
}

async function getTemplateRating(templateId: string): Promise<{ avgRating: number; ratingCount: number }> {
  const row = await queryOne<{ avg_rating: number | null; rating_count: number }>(
    `SELECT AVG(rating) as avg_rating, COUNT(*)::int as rating_count
     FROM template_ratings WHERE template_id = $1`,
    [templateId]
  );
  return {
    avgRating: row?.avg_rating ? Math.round(row.avg_rating * 10) / 10 : 0,
    ratingCount: row?.rating_count ?? 0,
  };
}

async function getAuthorInfo(authorId: string | null): Promise<{ authorName: string | null; authorEmail: string | null }> {
  if (!authorId) return { authorName: null, authorEmail: null };
  const user = await queryOne<{ display_name: string; email: string }>(
    'SELECT display_name, email FROM users WHERE id = $1',
    [authorId]
  );
  return {
    authorName: user?.display_name ?? null,
    authorEmail: user?.email ?? null,
  };
}

async function formatTemplate(row: TemplateRow, includeBody: boolean = false) {
  const { avgRating, ratingCount } = await getTemplateRating(row.id);
  const { authorName, authorEmail } = await getAuthorInfo(row.author_id);

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
router.post('/', async (req: Request, res: Response) => {
  try {
    const user = await getEffectiveUser(req);
    if (!user) { res.status(500).json({ error: 'No user configured' }); return; }
    const { name, description, sourceSpecId, brief, storyStructure, directionLayers, teamId } = req.body;

    if (!name || !sourceSpecId || !brief || !storyStructure) {
      throw new ValidationError('Missing required fields: name, sourceSpecId, brief, storyStructure');
      return;
    }

    if (!Array.isArray(storyStructure) || storyStructure.length === 0) {
      throw new ValidationError('storyStructure must be a non-empty array');
      return;
    }

    // Validate teamId if provided — user must be a member
    if (teamId) {
      const userTeamIds = await getUserTeamIds(user.id);
      if (!userTeamIds.includes(teamId)) {
        throw new ForbiddenError('You are not a member of this team');
        return;
      }
    }

    const id = randomUUID();
    const storyCount = storyStructure.length;

    await execute(
      `INSERT INTO templates (id, name, description, source_spec_id, brief, story_structure, direction_layers, story_count, team_id, author_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
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
      ]
    );

    const row = await queryOne<TemplateRow>('SELECT * FROM templates WHERE id = $1', [id]);
    res.status(201).json(await formatTemplate(row!, true));
  } catch (error: any) {
    handleRouteError(res, error, '[Templates] Create');
  }
});

// ─── GET / — List templates with scope filtering ─────────────────────────────

/**
 * @swagger
 * /api/templates:
 *   get:
 *     tags: [Templates]
 *     summary: List templates
 *     operationId: listTemplates
 *     description: >
 *       Returns reusable spec templates filtered by scope. Personal templates are
 *       created by the current user; team templates are shared within teams the user
 *       belongs to; all returns both. Returns an empty list if user is not authenticated.
 *     parameters:
 *       - in: query
 *         name: scope
 *         schema:
 *           type: string
 *           enum: [all, personal, team]
 *           default: all
 *         description: Filter templates by ownership scope
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
 *                   items:
 *                     $ref: '#/components/schemas/Template'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const user = await getEffectiveUser(req);
    if (!user) { res.json({ templates: [] }); return; }
    const scope = (req.query.scope as string) || 'all';

    let rows: TemplateRow[];

    if (scope === 'personal') {
      // Only templates created by this user (no team_id)
      rows = await query<TemplateRow>(
        `SELECT * FROM templates WHERE author_id = $1 AND team_id IS NULL ORDER BY created_at DESC`,
        [user.id]
      );
    } else if (scope === 'team') {
      // Templates shared with any of user's teams
      const teamIds = await getUserTeamIds(user.id);
      if (teamIds.length === 0) {
        rows = [];
      } else {
        const placeholders = teamIds.map((_, i) => `$${i + 1}`).join(',');
        rows = await query<TemplateRow>(
          `SELECT * FROM templates WHERE team_id IN (${placeholders}) ORDER BY created_at DESC`,
          teamIds
        );
      }
    } else {
      // 'all' — personal + team templates visible to this user
      const teamIds = await getUserTeamIds(user.id);
      if (teamIds.length === 0) {
        rows = await query<TemplateRow>(
          `SELECT * FROM templates WHERE author_id = $1 ORDER BY created_at DESC`,
          [user.id]
        );
      } else {
        const placeholders = teamIds.map((_, i) => `$${i + 2}`).join(',');
        rows = await query<TemplateRow>(
          `SELECT * FROM templates
           WHERE author_id = $1 OR team_id IN (${placeholders})
           ORDER BY created_at DESC`,
          [user.id, ...teamIds]
        );
      }
    }

    // Sort: featured (avg rating >= 4.0) first, then by created_at desc
    const templates = await Promise.all(rows.map(row => formatTemplate(row)));
    templates.sort((a, b) => {
      const aFeatured = (a.avgRating as number) >= 4.0 ? 1 : 0;
      const bFeatured = (b.avgRating as number) >= 4.0 ? 1 : 0;
      if (bFeatured !== aFeatured) return bFeatured - aFeatured;
      return 0; // preserve DB ordering (created_at DESC) within same featured status
    });

    const pagination = parsePaginationParams(req);
    res.json(paginateArray(templates, pagination, { cursorKey: (t) => t.id as string }));
  } catch (error: any) {
    handleRouteError(res, error, '[Templates] List');
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
router.post('/:id/rate', async (req: Request, res: Response) => {
  try {
    const user = await getEffectiveUser(req);
    if (!user) { res.status(500).json({ error: 'No user configured' }); return; }
    const templateId = req.params.id as string;
    const { rating } = req.body;

    if (typeof rating !== 'number' || rating < 1 || rating > 5 || !Number.isInteger(rating)) {
      throw new ValidationError('Rating must be an integer between 1 and 5');
      return;
    }

    // Check template exists
    const template = await queryOne<Pick<TemplateRow, 'id' | 'team_id' | 'author_id'>>(
      'SELECT id, team_id, author_id FROM templates WHERE id = $1',
      [templateId]
    );
    if (!template) {
      throw new NotFoundError('Template not found');
      return;
    }

    if (!(await canReadTemplate(user.id, template))) {
      throw new ForbiddenError('You do not have access to this template');
    }

    // Upsert rating
    const id = randomUUID();
    await execute(
      `INSERT INTO template_ratings (id, template_id, user_id, rating)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT(template_id, user_id) DO UPDATE SET rating = EXCLUDED.rating, updated_at = NOW()`,
      [id, templateId, user.id, rating]
    );

    const { avgRating, ratingCount } = await getTemplateRating(templateId);
    res.json({ avgRating, ratingCount, userRating: rating });
  } catch (error: any) {
    handleRouteError(res, error, '[Templates] Rate');
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
router.post('/:id/use', async (req: Request, res: Response) => {
  try {
    const user = await getEffectiveUser(req);
    if (!user) { res.status(500).json({ error: 'No user configured' }); return; }

    const row = await queryOne<Pick<TemplateRow, 'id' | 'author_id' | 'team_id'>>(
      'SELECT id, author_id, team_id FROM templates WHERE id = $1',
      [req.params.id]
    );

    if (!row) {
      throw new NotFoundError('Template not found');
      return;
    }

    if (!(await canReadTemplate(user.id, row))) {
      throw new ForbiddenError('You do not have access to this template');
      return;
    }

    await execute(
      `UPDATE templates SET usage_count = usage_count + 1, last_used_at = NOW() WHERE id = $1`,
      [req.params.id]
    );

    res.json({ ok: true });
  } catch (error: any) {
    handleRouteError(res, error, '[Templates] Use');
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
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const user = await getEffectiveUser(req);
    if (!user) { res.status(500).json({ error: 'No user configured' }); return; }
    const row = await queryOne<TemplateRow>('SELECT * FROM templates WHERE id = $1', [req.params.id]);

    if (!row) {
      throw new NotFoundError('Template not found');
      return;
    }

    if (!(await canReadTemplate(user.id, row))) {
      throw new ForbiddenError('You do not have access to this template');
      return;
    }

    // Include user's own rating if any
    const userRating = await queryOne<{ rating: number }>(
      'SELECT rating FROM template_ratings WHERE template_id = $1 AND user_id = $2',
      [row.id, user.id]
    );

    const result = await formatTemplate(row, true);
    (result as Record<string, unknown>).userRating = userRating?.rating ?? null;

    res.json(result);
  } catch (error: any) {
    handleRouteError(res, error, '[Templates] Get');
  }
});

// ─── DELETE /:id — Remove a template ──────────────────────────────────────────

/**
 * @swagger
 * /api/templates/{id}:
 *   delete:
 *     tags: [Templates]
 *     summary: Delete a template
 *     operationId: deleteTemplate
 *     description: Permanently deletes a template by its ID.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Template UUID
 *         example: 550e8400-e29b-41d4-a716-446655440000
 *     responses:
 *       204:
 *         description: Template deleted successfully (no content)
 *       404:
 *         description: Template not found
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
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const user = await getEffectiveUser(req);
    if (!user) { res.status(500).json({ error: 'No user configured' }); return; }

    const row = await queryOne<Pick<TemplateRow, 'id' | 'author_id' | 'team_id'>>(
      'SELECT id, author_id, team_id FROM templates WHERE id = $1',
      [req.params.id]
    );

    if (!row) {
      throw new NotFoundError('Template not found');
      return;
    }

    if (!(await canManageTemplate(user.id, row))) {
      throw new ForbiddenError('You do not have permission to delete this template');
      return;
    }

    await execute('DELETE FROM templates WHERE id = $1', [req.params.id]);
    res.status(204).send();
  } catch (error: any) {
    handleRouteError(res, error, '[Templates] Delete');
  }
});

export default router;
