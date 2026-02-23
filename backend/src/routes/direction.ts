import { Router, Request, Response } from 'express';
import { db } from '../db/index';
import { synthesize } from '../lib/direction-stack';
import { isValidModel, SUPPORTED_MODELS } from '../lib/llm-client';
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
