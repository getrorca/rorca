import { Router, Request, Response } from 'express';
import { db } from '../db/index';
import { synthesize } from '../lib/direction-stack';
import { isValidModel, SUPPORTED_MODELS } from '../lib/llm-client';

const router = Router();

// GET /api/direction — fetch a single direction layer
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

// GET /api/direction/models — list supported models
router.get('/models', (_req: Request, res: Response) => {
  res.json({
    models: SUPPORTED_MODELS.map(id => ({ id, label: id })),
  });
});

// GET /api/direction/preview — synthesize the direction stack for a workspace+domain
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

  const synthesized = synthesize({
    l1: l1Row?.content_yaml,
    l2: l2Row?.content_yaml,
    l3: l3Row?.content_yaml,
    schemaSnapshot,
    gitMemory,
    specBrief: String(brief),
  });

  res.json({ synthesized, schemaTableCount, gitCommitCount });
});

// POST /api/direction/synthesize — synthesize with L4/L5 in body
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

  const synthesized = synthesize({
    l1: l1Row?.content_yaml,
    l2: l2Row?.content_yaml,
    l3: l3Row?.content_yaml,
    schemaSnapshot,
    gitMemory,
    specBrief: l4SpecBrief || '',
    storyAnnotations: l5Annotations || undefined,
  });

  res.json({ synthesized });
});

export default router;
