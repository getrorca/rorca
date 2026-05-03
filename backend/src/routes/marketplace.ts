import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { queryOne, query, execute } from '../db/index';
import { sanitizeSpec } from '../lib/spec-sanitizer';
import { getEffectiveUser } from '../lib/get-user';
import { ForbiddenError, NotFoundError, ValidationError } from '../lib/errors';
import { requirePlan } from '../lib/require-plan';

const router = Router();

// ─── Row types ───────────────────────────────────────────────────────────────

interface PublicationRow {
  id: string;
  spec_id: string;
  workspace_id: string;
  publisher_id: string | null;
  title: string;
  description: string;
  tags: string;
  sanitized_spec_json: string;
  redaction_count: number;
  download_count: number;
  source: string;
  deleted_at: string | null;
  created_at: string;
}

interface WorkspaceRow {
  id: string;
  path: string;
  label: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function ensureTable(): Promise<void> {
  const exists = await queryOne<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'spec_publications'"
  );
  if (!exists) {
    throw new ValidationError(
      'Marketplace tables not initialized. Restart backend to run migrations.',
    );
  }
}

// ─── POST /api/marketplace/preview-sanitize ──────────────────────────────────

/**
 * @swagger
 * /api/marketplace/preview-sanitize:
 *   post:
 *     tags: [Marketplace]
 *     summary: Preview PII/secret sanitization of a spec before publishing
 *     operationId: previewSanitize
 *     description: |
 *       Accepts a spec JSON object and runs the sanitizer across all string fields
 *       (recursively). Returns the sanitized copy and a redaction report so the user
 *       can confirm what will be scrubbed before they publish to the community
 *       marketplace.  No data is persisted by this endpoint.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [spec]
 *             properties:
 *               spec:
 *                 type: object
 *                 description: Raw spec JSON to sanitize
 *     responses:
 *       200:
 *         description: Sanitized spec and redaction report
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 sanitized:
 *                   type: object
 *                   description: Sanitized copy of the input spec
 *                 redactionCount:
 *                   type: integer
 *                   description: Total number of values redacted
 *                 redactions:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       field:
 *                         type: string
 *                         description: JSON path of the field containing the secret
 *                       pattern:
 *                         type: string
 *                         description: Name of the pattern that matched
 *                       original_preview:
 *                         type: string
 *                         description: First 4 + last 4 chars of the original value
 *       400:
 *         description: Missing or invalid spec field
 */
router.post('/preview-sanitize', (req: Request, res: Response) => {
  const { spec } = req.body as { spec?: unknown };

  if (spec === undefined || spec === null) {
    throw new ValidationError('Missing required field: spec');
    return;
  }

  const result = sanitizeSpec(spec);
  res.json(result);
});

// ─── POST /api/marketplace/publish ───────────────────────────────────────────

/**
 * @swagger
 * /api/marketplace/publish:
 *   post:
 *     tags: [Marketplace]
 *     summary: Publish a spec to the community marketplace
 *     operationId: publishSpec
 *     x-rorca-tier: paid
 *     x-rorca-capability: marketplacePublish
 *     x-rorca-rationale: "Marketplace publishing is a commercial distribution feature and should not be part of the free CLI contract."
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [spec_id, workspace_id]
 *             properties:
 *               spec_id:
 *                 type: string
 *                 description: Spec slug (filename without .json)
 *               workspace_id:
 *                 type: string
 *                 description: Workspace ID that owns the spec
 *               title:
 *                 type: string
 *                 description: Optional override title (defaults to spec title)
 *               description:
 *                 type: string
 *                 description: Optional description
 *               tags:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Optional tags for categorization
 *     responses:
 *       200:
 *         description: Publication created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 publicationId:
 *                   type: string
 *                 redactionCount:
 *                   type: integer
 *       400:
 *         description: Missing required fields
 *       404:
 *         description: Spec or workspace not found
 */
router.post('/publish', requirePlan('marketplace_publish'), async (req: Request, res: Response) => {
  await ensureTable();
  const user = await getEffectiveUser(req);
  const { spec_id, workspace_id, title, description, tags } = req.body as {
    spec_id?: string;
    workspace_id?: string;
    title?: string;
    description?: string;
    tags?: string[];
  };

  if (!spec_id || !workspace_id) {
    throw new ValidationError('Missing required fields: spec_id, workspace_id');
  }

  // Resolve workspace path
  const workspace = await queryOne<WorkspaceRow>(
    'SELECT id, path, label FROM workspaces WHERE id = $1',
    [workspace_id]
  );
  if (!workspace) throw new NotFoundError('Workspace', workspace_id);

  // Try approved first, then pending
  let specPath = path.join(workspace.path, 'forge', 'specs', 'approved', `${spec_id}.json`);
  if (!fs.existsSync(specPath)) {
    specPath = path.join(workspace.path, 'forge', 'specs', 'pending', `${spec_id}.json`);
  }
  if (!fs.existsSync(specPath)) {
    throw new NotFoundError('Spec', spec_id);
  }

  const rawSpec = JSON.parse(fs.readFileSync(specPath, 'utf-8'));

  // Sanitize PII/secrets
  const sanitizeResult = sanitizeSpec(rawSpec);

  const pubId = `pub_${crypto.randomUUID()}`;
  const specTitle = title || rawSpec.title || rawSpec.specName || spec_id;
  const specDesc =
    description ||
    rawSpec.brief ||
    (rawSpec.userStories
      ? `${rawSpec.userStories.length} user stories`
      : '');
  const tagsJson = JSON.stringify(tags || []);

  await execute(
    `INSERT INTO spec_publications
      (id, spec_id, workspace_id, publisher_id, title, description, tags, sanitized_spec_json, redaction_count, source, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'local', NOW())`,
    [
      pubId,
      spec_id,
      workspace_id,
      user?.id || null,
      specTitle,
      specDesc,
      tagsJson,
      JSON.stringify(sanitizeResult.sanitized),
      sanitizeResult.redactionCount,
    ]
  );

  // Insert into FTS index
  await execute(
    'INSERT INTO spec_fts (publication_id, title, description, tags) VALUES ($1, $2, $3, $4)',
    [pubId, specTitle, specDesc, (tags || []).join(' ')]
  );

  res.json({ publicationId: pubId, redactionCount: sanitizeResult.redactionCount });
});

// ─── POST /api/marketplace/:id/fork ──────────────────────────────────────────

/**
 * @swagger
 * /api/marketplace/{id}/fork:
 *   post:
 *     tags: [Marketplace]
 *     summary: Fork a published spec into a workspace
 *     operationId: forkSpec
 *     x-rorca-tier: paid
 *     x-rorca-capability: marketplacePublish
 *     x-rorca-rationale: "Marketplace forking is part of the commercial marketplace surface and belongs behind the paid plan boundary."
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Publication ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspace_id]
 *             properties:
 *               workspace_id:
 *                 type: string
 *                 description: Target workspace ID to fork into
 *     responses:
 *       200:
 *         description: Spec forked successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 specId:
 *                   type: string
 *                 path:
 *                   type: string
 *       400:
 *         description: Missing workspace_id
 *       404:
 *         description: Publication or workspace not found
 */
router.post('/:id/fork', async (req: Request, res: Response) => {
  await ensureTable();
  const id = String(req.params.id);
  const { workspace_id } = req.body as { workspace_id?: string };

  if (!workspace_id) {
    throw new ValidationError('Missing required field: workspace_id');
  }

  const pub = await queryOne<PublicationRow>(
    'SELECT * FROM spec_publications WHERE id = $1 AND deleted_at IS NULL',
    [id]
  );
  if (!pub) throw new NotFoundError('Publication', id);

  const workspace = await queryOne<WorkspaceRow>(
    'SELECT id, path, label FROM workspaces WHERE id = $1',
    [workspace_id]
  );
  if (!workspace) throw new NotFoundError('Workspace', workspace_id);

  // Parse sanitized spec and add attribution
  const specJson = JSON.parse(pub.sanitized_spec_json);
  specJson.forkedFrom = {
    publicationId: pub.id,
    originalSpecId: pub.spec_id,
    title: pub.title,
    forkedAt: new Date().toISOString(),
  };

  // Reset all story passes so the forked spec starts fresh
  if (specJson.userStories) {
    for (const story of specJson.userStories) {
      story.passes = false;
    }
  }

  // Generate a unique slug for the forked spec
  const baseSlug = pub.spec_id;
  const suffix = crypto.randomUUID().slice(0, 8);
  const forkedSlug = `${baseSlug}-fork-${suffix}`;
  specJson.id = forkedSlug;
  specJson.title = forkedSlug;

  // Write to target workspace's pending directory
  const pendingDir = path.join(workspace.path, 'forge', 'specs', 'pending');
  fs.mkdirSync(pendingDir, { recursive: true });
  const specPath = path.join(pendingDir, `${forkedSlug}.json`);
  fs.writeFileSync(specPath, JSON.stringify(specJson, null, 2));

  // Increment download count
  await execute(
    'UPDATE spec_publications SET download_count = download_count + 1 WHERE id = $1',
    [pub.id]
  );

  res.json({
    specId: forkedSlug,
    path: `forge/specs/pending/${forkedSlug}.json`,
  });
});

// ─── DELETE /api/marketplace/:id ─────────────────────────────────────────────

/**
 * @swagger
 * /api/marketplace/{id}:
 *   delete:
 *     tags: [Marketplace]
 *     summary: Soft-delete a published spec (sets deleted_at)
 *     operationId: unpublishSpec
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Publication ID
 *     responses:
 *       200:
 *         description: Publication deleted
 *       403:
 *         description: Not the original publisher
 *       404:
 *         description: Publication not found
 */
router.delete('/:id', async (req: Request, res: Response) => {
  await ensureTable();
  const user = await getEffectiveUser(req);
  const id = String(req.params.id);

  const pub = await queryOne<PublicationRow>(
    'SELECT * FROM spec_publications WHERE id = $1 AND deleted_at IS NULL',
    [id]
  );
  if (!pub) throw new NotFoundError('Publication', id);

  // Only original publisher can delete
  if (pub.publisher_id && user && pub.publisher_id !== user.id) {
    throw new ForbiddenError('Only the original publisher can delete this publication');
  }

  await execute(
    'UPDATE spec_publications SET deleted_at = NOW() WHERE id = $1',
    [id]
  );

  // Remove from FTS index
  await execute(
    'DELETE FROM spec_fts WHERE publication_id = $1',
    [id]
  );

  res.json({ deleted: true });
});

// ─── GET /api/marketplace?spec_id={id} ───────────────────────────────────────

/**
 * @swagger
 * /api/marketplace:
 *   get:
 *     tags: [Marketplace]
 *     summary: Check if a spec is published to the community marketplace
 *     operationId: checkSpecPublication
 *     parameters:
 *       - in: query
 *         name: spec_id
 *         required: true
 *         schema:
 *           type: string
 *         description: Spec slug to check for publication
 *     responses:
 *       200:
 *         description: Publication status for the spec
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 published:
 *                   type: boolean
 *                 publication:
 *                   type: object
 *                   nullable: true
 *                   properties:
 *                     id:
 *                       type: string
 *                     title:
 *                       type: string
 *                     created_at:
 *                       type: string
 *       400:
 *         description: Missing spec_id query parameter
 */
router.get('/', async (req: Request, res: Response) => {
  await ensureTable();
  const spec_id = String(req.query.spec_id || '').trim();

  if (!spec_id) {
    throw new ValidationError('Missing required query param: spec_id');
    return;
  }

  const pub = await queryOne<PublicationRow>(
    `SELECT id, spec_id, title, description, tags, download_count, source, created_at
     FROM spec_publications
     WHERE spec_id = $1 AND deleted_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [spec_id]
  );

  if (!pub) {
    res.json({ published: false, publication: null });
    return;
  }

  res.json({
    published: true,
    publication: {
      id: pub.id,
      spec_id: pub.spec_id,
      title: pub.title,
      description: pub.description,
      tags: JSON.parse(pub.tags || '[]') as string[],
      download_count: pub.download_count,
      source: pub.source,
      created_at: pub.created_at,
    },
  });
});

// ─── GET /api/marketplace/my ─────────────────────────────────────────────────

/**
 * @swagger
 * /api/marketplace/my:
 *   get:
 *     tags: [Marketplace]
 *     summary: Get all specs published by the current user
 *     operationId: myPublications
 *     responses:
 *       200:
 *         description: List of user's published specs
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 items:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Publication'
 *                 total:
 *                   type: integer
 */
router.get('/my', async (req: Request, res: Response) => {
  await ensureTable();
  const user = await getEffectiveUser(req);

  const rows = await query<PublicationRow>(
    `SELECT id, spec_id, title, description, tags, download_count, source, created_at
     FROM spec_publications
     WHERE deleted_at IS NULL AND (publisher_id = $1 OR publisher_id IS NULL)
     ORDER BY created_at DESC`,
    [user?.id || null]
  );

  const items = rows.map((r) => ({
    ...r,
    tags: JSON.parse(r.tags || '[]') as string[],
  }));

  res.json({ items, total: items.length });
});

// ─── GET /api/marketplace/popular ────────────────────────────────────────────

/**
 * @swagger
 * /api/marketplace/popular:
 *   get:
 *     tags: [Marketplace]
 *     summary: Get top 20 specs by download count
 *     operationId: popularSpecs
 *     responses:
 *       200:
 *         description: List of popular publications
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 items:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Publication'
 *                 total:
 *                   type: integer
 */
router.get('/popular', async (req: Request, res: Response) => {
  await ensureTable();
  const rows = await query<PublicationRow>(
    `SELECT id, spec_id, title, description, tags, download_count, source, created_at
     FROM spec_publications
     WHERE deleted_at IS NULL
     ORDER BY download_count DESC
     LIMIT 20`
  );

  const items = rows.map((r) => ({
    ...r,
    tags: JSON.parse(r.tags || '[]') as string[],
  }));

  res.json({ items, total: items.length });
});

// ─── GET /api/marketplace/search ─────────────────────────────────────────────

/**
 * @swagger
 * /api/marketplace/search:
 *   get:
 *     tags: [Marketplace]
 *     summary: Full-text search for published specs
 *     operationId: searchMarketplace
 *     parameters:
 *       - in: query
 *         name: q
 *         schema:
 *           type: string
 *         description: Search query (empty returns popular specs)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *           maximum: 100
 *         description: Max results to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of results to skip
 *     responses:
 *       200:
 *         description: Search results with snippets
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 items:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       title:
 *                         type: string
 *                       description:
 *                         type: string
 *                       snippet:
 *                         type: string
 *                         description: FTS highlighted snippet
 *                       tags:
 *                         type: array
 *                         items:
 *                           type: string
 *                       download_count:
 *                         type: integer
 *                       source:
 *                         type: string
 *                       created_at:
 *                         type: string
 *                 total:
 *                   type: integer
 *                   description: Total matching results for pagination
 */
router.get('/search', async (req: Request, res: Response) => {
  await ensureTable();
  const searchQuery = String(req.query.q || '').trim();
  const limit = Math.min(Math.max(parseInt(String(req.query.limit), 10) || 20, 1), 100);
  const offset = Math.max(parseInt(String(req.query.offset), 10) || 0, 0);

  // Empty query -> return popular specs
  if (!searchQuery) {
    const countRow = await queryOne<{ total: number }>(
      'SELECT COUNT(*)::int as total FROM spec_publications WHERE deleted_at IS NULL'
    );
    const rows = await query<PublicationRow>(
      `SELECT id, spec_id, title, description, tags, download_count, source, created_at
       FROM spec_publications
       WHERE deleted_at IS NULL
       ORDER BY download_count DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    res.json({
      items: rows.map((r) => ({ ...r, tags: JSON.parse(r.tags || '[]') as string[], snippet: '' })),
      total: countRow?.total ?? 0,
    });
    return;
  }

  // PostgreSQL full-text search with ts_headline for snippet extraction
  const tsQuery = searchQuery.split(/\s+/).filter(Boolean).join(' & ');

  const countRow = await queryOne<{ total: number }>(
    `SELECT COUNT(*)::int as total FROM spec_fts
     INNER JOIN spec_publications ON spec_publications.id = spec_fts.publication_id
     WHERE to_tsvector('english', spec_fts.title || ' ' || spec_fts.description || ' ' || spec_fts.tags) @@ to_tsquery('english', $1)
       AND spec_publications.deleted_at IS NULL`,
    [tsQuery]
  );

  const rows = await query<PublicationRow & { snippet: string }>(
    `SELECT
       spec_publications.id,
       spec_publications.spec_id,
       spec_publications.title,
       spec_publications.description,
       spec_publications.tags,
       spec_publications.download_count,
       spec_publications.source,
       spec_publications.created_at,
       ts_headline('english', spec_fts.description, to_tsquery('english', $1),
         'StartSel=<b>, StopSel=</b>, MaxWords=32, MinWords=16') AS snippet
     FROM spec_fts
     INNER JOIN spec_publications ON spec_publications.id = spec_fts.publication_id
     WHERE to_tsvector('english', spec_fts.title || ' ' || spec_fts.description || ' ' || spec_fts.tags) @@ to_tsquery('english', $1)
       AND spec_publications.deleted_at IS NULL
     ORDER BY ts_rank(to_tsvector('english', spec_fts.title || ' ' || spec_fts.description || ' ' || spec_fts.tags), to_tsquery('english', $1)) DESC
     LIMIT $2 OFFSET $3`,
    [tsQuery, limit, offset]
  );

  res.json({
    items: rows.map((r) => ({
      id: r.id,
      spec_id: r.spec_id,
      title: r.title,
      description: r.description,
      tags: JSON.parse(r.tags || '[]') as string[],
      download_count: r.download_count,
      source: r.source,
      created_at: r.created_at,
      snippet: r.snippet || '',
    })),
    total: countRow?.total ?? 0,
  });
});

// ─── GET /api/marketplace/:id ────────────────────────────────────────────────

/**
 * @swagger
 * /api/marketplace/{id}:
 *   get:
 *     tags: [Marketplace]
 *     summary: Get full publication detail including sanitized spec JSON
 *     operationId: getPublication
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Publication ID
 *     responses:
 *       200:
 *         description: Publication detail
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Publication'
 *       404:
 *         description: Publication not found
 */
router.get('/:id', async (req: Request, res: Response) => {
  await ensureTable();
  const id = String(req.params.id);

  const pub = await queryOne<PublicationRow>(
    `SELECT id, spec_id, workspace_id, publisher_id, title, description, tags,
            sanitized_spec_json, redaction_count, download_count, source, created_at
     FROM spec_publications
     WHERE id = $1 AND deleted_at IS NULL`,
    [id]
  );
  if (!pub) throw new NotFoundError('Publication', id);

  res.json({
    ...pub,
    tags: JSON.parse(pub.tags || '[]') as string[],
    sanitized_spec_json: JSON.parse(pub.sanitized_spec_json),
  });
});

export default router;
