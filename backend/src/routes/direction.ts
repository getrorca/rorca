import { Router, Request, Response } from 'express';
import { db } from '../db/index';
import { synthesize } from '../lib/direction-stack';
import { isValidModel, SUPPORTED_MODELS, MODEL_INFO, DEFAULT_MODEL } from '../lib/llm-client';
import { validateDirectionYaml, getPreviewWarnings } from '../lib/direction-validator';

const router = Router();

/** Look up team L1/L2 for a workspace via workspace_access */
function getTeamLayers(workspaceId: string): { teamL1?: string; teamL2?: string } {
  // A workspace may belong to a team via workspace_access
  const access = db.prepare(
    'SELECT team_id FROM workspace_access WHERE workspace_id = ? LIMIT 1'
  ).get(workspaceId) as { team_id: string } | undefined;

  if (!access) return {};

  const teamL1 = db.prepare(
    `SELECT content_yaml FROM direction_layers WHERE layer = 1 AND team_id = ? AND COALESCE(workspace_id,'') = '' AND COALESCE(domain,'') = ''`
  ).get(access.team_id) as { content_yaml: string } | undefined;

  const teamL2 = db.prepare(
    `SELECT content_yaml FROM direction_layers WHERE layer = 2 AND team_id = ? AND COALESCE(workspace_id,'') = '' AND COALESCE(domain,'') = ''`
  ).get(access.team_id) as { content_yaml: string } | undefined;

  return {
    teamL1: teamL1?.content_yaml,
    teamL2: teamL2?.content_yaml,
  };
}

/**
 * @swagger
 * /api/direction:
 *   get:
 *     tags: [Direction Stack]
 *     summary: Fetch a single direction layer
 *     parameters:
 *       - in: query
 *         name: layer
 *         required: true
 *         schema: { type: integer, enum: [1, 2, 3] }
 *       - in: query
 *         name: workspaceId
 *         schema: { type: string }
 *         description: Required for L2 and L3
 *     responses:
 *       200:
 *         description: Direction layer content
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 contentYaml: { type: string }
 *                 preferredModel: { type: string, nullable: true, description: "Only returned for L3" }
 *       400: { description: "Invalid layer" }
 *   put:
 *     tags: [Direction Stack]
 *     summary: Upsert a direction layer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [layer, contentYaml]
 *             properties:
 *               layer: { type: integer, enum: [1, 2, 3] }
 *               workspaceId: { type: string }
 *               domain: { type: string }
 *               contentYaml: { type: string }
 *               preferredModel: { type: string, description: "Only valid for layer 3" }
 *     responses:
 *       200: { description: "Saved", content: { application/json: { schema: { type: object, properties: { ok: { type: boolean } } } } } }
 *       400: { description: "Missing fields or invalid layer" }
 *       422: { description: "Invalid YAML or schema validation error" }
 */
router.get('/', (req: Request, res: Response) => {
  const { layer, workspaceId } = req.query;

  if (!layer || ![1, 2, 3].includes(Number(layer))) {
    res.status(400).json({ error: 'layer must be 1, 2, or 3' });
    return;
  }

  const layerNum = Number(layer);
  let row: { content_yaml: string } | undefined;

  if (layerNum === 1) {
    row = db.prepare(
      `SELECT content_yaml FROM direction_layers WHERE layer = 1 AND COALESCE(workspace_id, '') = '' AND COALESCE(domain, '') = ''`
    ).get() as { content_yaml: string } | undefined;
  } else if (layerNum === 2) {
    // L2 is domain-scoped; for the panel we fetch workspace-level L2
    row = workspaceId
      ? db.prepare(
          `SELECT content_yaml FROM direction_layers WHERE layer = 2 AND workspace_id = ? AND COALESCE(domain, '') = ''`
        ).get(String(workspaceId)) as { content_yaml: string } | undefined
      : undefined;
  } else {
    const l3Row = workspaceId
      ? db.prepare(
          `SELECT content_yaml, preferred_model FROM direction_layers WHERE layer = 3 AND workspace_id = ? AND COALESCE(domain, '') = ''`
        ).get(String(workspaceId)) as { content_yaml: string; preferred_model: string | null } | undefined
      : undefined;
    res.json({ contentYaml: l3Row?.content_yaml ?? '', preferredModel: l3Row?.preferred_model ?? null });
    return;
  }

  res.json({ contentYaml: row?.content_yaml ?? '' });
});

// PUT /api/direction — upsert a direction layer
router.put('/', (req: Request, res: Response) => {
  const { layer, workspaceId, domain, contentYaml, preferredModel } = req.body;

  if (!layer || !contentYaml) {
    res.status(400).json({ error: 'Missing required fields: layer, contentYaml' });
    return;
  }

  if (![1, 2, 3].includes(layer)) {
    res.status(400).json({ error: 'layer must be 1, 2, or 3' });
    return;
  }

  // Validate preferredModel if provided (only valid for L3)
  if (preferredModel !== undefined && preferredModel !== null) {
    if (layer !== 3) {
      res.status(400).json({ error: 'preferredModel is only valid for layer 3' });
      return;
    }
    if (!isValidModel(preferredModel)) {
      res.status(400).json({
        error: `Invalid preferredModel: '${preferredModel}'. Supported models: ${SUPPORTED_MODELS.join(', ')}`,
      });
      return;
    }
  }

  // Validate YAML syntax and per-layer schema
  const validation = validateDirectionYaml(layer, contentYaml);
  if (validation.yamlError) {
    res.status(422).json({
      error: 'Invalid YAML syntax',
      yamlError: validation.yamlError,
    });
    return;
  }
  if (!validation.valid) {
    res.status(422).json({
      error: 'Direction content failed schema validation',
      validationErrors: validation.errors,
    });
    return;
  }

  // Upsert via INSERT OR REPLACE (unique index on layer + coalesced workspace_id + domain)
  db.prepare(`
    INSERT INTO direction_layers (layer, workspace_id, domain, content_yaml, preferred_model, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT (layer, COALESCE(workspace_id,''), COALESCE(domain,''))
    DO UPDATE SET content_yaml = excluded.content_yaml, preferred_model = excluded.preferred_model, updated_at = datetime('now')
  `).run(layer, workspaceId || null, domain || null, contentYaml, (layer === 3 ? preferredModel ?? null : null));

  // WAL event
  db.prepare(
    `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('direction_update', ?, ?)`
  ).run(workspaceId || null, JSON.stringify({ layer, domain: domain || null, ...(preferredModel ? { preferredModel } : {}) }));

  res.json({ ok: true });
});

/**
 * @swagger
 * /api/direction/all:
 *   get:
 *     tags: [Direction Stack]
 *     summary: Fetch all direction layers for a workspace
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: All direction layers
 *       400: { description: "Missing workspaceId" }
 */
router.get('/all', (req: Request, res: Response) => {
  const { workspaceId } = req.query;

  if (!workspaceId) {
    res.status(400).json({ error: 'Missing required query param: workspaceId' });
    return;
  }

  const wsId = String(workspaceId);

  // L1: global (no workspace, no domain)
  const l1Row = db.prepare(
    `SELECT content_yaml FROM direction_layers WHERE layer = 1 AND COALESCE(workspace_id, '') = '' AND COALESCE(domain, '') = ''`
  ).get() as { content_yaml: string } | undefined;

  // L2: workspace-scoped
  const l2Row = db.prepare(
    `SELECT content_yaml FROM direction_layers WHERE layer = 2 AND workspace_id = ? AND COALESCE(domain, '') = ''`
  ).get(wsId) as { content_yaml: string } | undefined;

  // L3: workspace-scoped with preferred_model
  const l3Row = db.prepare(
    `SELECT content_yaml, preferred_model FROM direction_layers WHERE layer = 3 AND workspace_id = ? AND COALESCE(domain, '') = ''`
  ).get(wsId) as { content_yaml: string; preferred_model: string | null } | undefined;

  // Team L1/L2 overrides
  const teamLayers = getTeamLayers(wsId);

  res.json({
    layers: {
      l1: { content: l1Row?.content_yaml ?? null, source: teamLayers.teamL1 ? 'team' : 'global' },
      l2: { content: l2Row?.content_yaml ?? null, teamOverride: teamLayers.teamL2 ?? null },
      l3: { content: l3Row?.content_yaml ?? null, preferredModel: l3Row?.preferred_model ?? null },
      l4: { content: null, note: 'L4 (spec brief) is provided per-request, not persisted' },
      l5: { content: null, note: 'L5 (story annotations) is provided per-request, not persisted' },
    },
    teamL1: teamLayers.teamL1 ?? null,
    teamL2: teamLayers.teamL2 ?? null,
  });
});

/**
 * @swagger
 * /api/direction/models:
 *   get:
 *     tags: [Direction Stack]
 *     summary: List supported LLM models
 *     responses:
 *       200:
 *         description: Model list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 models:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string, example: "claude-sonnet-4-5-20250929" }
 *                       label: { type: string }
 */
router.get('/models', (req: Request, res: Response) => {
  const { workspaceId } = req.query;

  // Resolve workspace default model for "recommended" badge
  let workspaceDefault: string | null = null;
  if (workspaceId) {
    const l3Pref = db.prepare(
      `SELECT preferred_model FROM direction_layers WHERE layer = 3 AND workspace_id = ? AND COALESCE(domain, '') = ''`
    ).get(String(workspaceId)) as { preferred_model: string | null } | undefined;
    workspaceDefault = l3Pref?.preferred_model ?? null;
  }

  const recommendedId = workspaceDefault || DEFAULT_MODEL;

  res.json({
    models: SUPPORTED_MODELS.map(id => {
      const info = MODEL_INFO[id];
      return {
        id,
        label: info.label,
        provider: info.provider,
        costPer1kInput: info.costPer1kInput,
        costPer1kOutput: info.costPer1kOutput,
        recommended: id === recommendedId,
      };
    }),
    defaultModel: recommendedId,
  });
});

/**
 * @swagger
 * /api/direction/preview:
 *   get:
 *     tags: [Direction Stack]
 *     summary: Preview synthesized direction stack
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         schema: { type: string }
 *       - in: query
 *         name: domain
 *         schema: { type: string }
 *       - in: query
 *         name: brief
 *         required: true
 *         schema: { type: string }
 *         description: The spec brief text (L4)
 *     responses:
 *       200:
 *         description: Synthesized direction stack preview
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 synthesized: { type: string }
 *                 schemaTableCount: { type: integer, nullable: true }
 *                 gitCommitCount: { type: integer, nullable: true }
 *                 warnings: { type: array, items: { type: string } }
 *       400: { description: "Missing brief" }
 */
router.get('/preview', (req: Request, res: Response) => {
  const { workspaceId, domain, brief } = req.query;

  if (!brief) {
    res.status(400).json({ error: 'Missing required query param: brief' });
    return;
  }

  // Fetch layers
  const l1Row = db.prepare(
    `SELECT content_yaml FROM direction_layers WHERE layer = 1 AND COALESCE(workspace_id, '') = '' AND COALESCE(domain, '') = ''`
  ).get() as { content_yaml: string } | undefined;

  const l2Row = domain
    ? db.prepare(
        `SELECT content_yaml FROM direction_layers WHERE layer = 2 AND domain = ? AND COALESCE(workspace_id, '') = ''`
      ).get(String(domain)) as { content_yaml: string } | undefined
    : undefined;

  const l3Row = workspaceId
    ? db.prepare(
        `SELECT content_yaml FROM direction_layers WHERE layer = 3 AND workspace_id = ? AND COALESCE(domain, '') = ''`
      ).get(String(workspaceId)) as { content_yaml: string } | undefined
    : undefined;

  // Fetch auto-hydrated context from workspace_context
  let schemaSnapshot: string | undefined;
  let gitMemory: string | undefined;
  let schemaTableCount: number | null = null;
  let gitCommitCount: number | null = null;

  if (workspaceId) {
    const ctx = db.prepare(
      `SELECT schema_snapshot, schema_table_count, git_memory, git_commit_count
       FROM workspace_context WHERE workspace_id = ?`
    ).get(String(workspaceId)) as {
      schema_snapshot: string | null;
      schema_table_count: number | null;
      git_memory: string | null;
      git_commit_count: number | null;
    } | undefined;

    if (ctx) {
      schemaSnapshot = ctx.schema_snapshot || undefined;
      gitMemory = ctx.git_memory || undefined;
      schemaTableCount = ctx.schema_table_count;
      gitCommitCount = ctx.git_commit_count;
    }
  }

  // Look up workspace domains for mismatch detection
  let workspaceDomains: string[] | undefined;
  if (workspaceId) {
    const wsRow = db.prepare(
      `SELECT domains FROM workspaces WHERE id = ?`
    ).get(String(workspaceId)) as { domains: string | null } | undefined;
    if (wsRow?.domains) {
      try { workspaceDomains = JSON.parse(wsRow.domains); } catch { /* ignore */ }
    }
  }

  // Fetch team L1/L2 if workspace belongs to a team
  const teamLayers = workspaceId ? getTeamLayers(String(workspaceId)) : {};

  const warnings = getPreviewWarnings({
    l1Content: l1Row?.content_yaml,
    l2Content: l2Row?.content_yaml,
    l3Content: l3Row?.content_yaml,
    workspaceId: workspaceId ? String(workspaceId) : undefined,
    domain: domain ? String(domain) : undefined,
    workspaceDomains,
  });

  const synthesized = synthesize({
    l1: l1Row?.content_yaml,
    l2: l2Row?.content_yaml,
    teamL1: teamLayers.teamL1,
    teamL2: teamLayers.teamL2,
    l3: l3Row?.content_yaml,
    schemaSnapshot,
    gitMemory,
    specBrief: String(brief),
  });

  res.json({ synthesized, schemaTableCount, gitCommitCount, warnings });
});

/**
 * @swagger
 * /api/direction/synthesize:
 *   post:
 *     tags: [Direction Stack]
 *     summary: Synthesize direction stack with L4/L5 content
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               workspaceId: { type: string }
 *               l4SpecBrief: { type: string, description: "Spec brief (L4)" }
 *               l5Annotations: { type: string, description: "Story annotations (L5)" }
 *     responses:
 *       200:
 *         description: Synthesized direction stack
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 synthesized: { type: string }
 */
router.post('/synthesize', (req: Request, res: Response) => {
  const { workspaceId, l4SpecBrief, l5Annotations } = req.body;

  // Fetch persisted layers
  const l1Row = db.prepare(
    `SELECT content_yaml FROM direction_layers WHERE layer = 1 AND COALESCE(workspace_id, '') = '' AND COALESCE(domain, '') = ''`
  ).get() as { content_yaml: string } | undefined;

  const l2Row = workspaceId
    ? db.prepare(
        `SELECT content_yaml FROM direction_layers WHERE layer = 2 AND workspace_id = ? AND COALESCE(domain, '') = ''`
      ).get(String(workspaceId)) as { content_yaml: string } | undefined
    : undefined;

  const l3Row = workspaceId
    ? db.prepare(
        `SELECT content_yaml FROM direction_layers WHERE layer = 3 AND workspace_id = ? AND COALESCE(domain, '') = ''`
      ).get(String(workspaceId)) as { content_yaml: string } | undefined
    : undefined;

  // Fetch auto-hydrated context
  let schemaSnapshot: string | undefined;
  let gitMemory: string | undefined;

  if (workspaceId) {
    const ctx = db.prepare(
      `SELECT schema_snapshot, git_memory FROM workspace_context WHERE workspace_id = ?`
    ).get(String(workspaceId)) as { schema_snapshot: string | null; git_memory: string | null } | undefined;

    if (ctx) {
      schemaSnapshot = ctx.schema_snapshot || undefined;
      gitMemory = ctx.git_memory || undefined;
    }
  }

  // Fetch team L1/L2 if workspace belongs to a team
  const teamLayers = workspaceId ? getTeamLayers(String(workspaceId)) : {};

  const synthesized = synthesize({
    l1: l1Row?.content_yaml,
    l2: l2Row?.content_yaml,
    teamL1: teamLayers.teamL1,
    teamL2: teamLayers.teamL2,
    l3: l3Row?.content_yaml,
    schemaSnapshot,
    gitMemory,
    specBrief: l4SpecBrief || '',
    storyAnnotations: l5Annotations || undefined,
  });

  res.json({ synthesized });
});

export default router;
