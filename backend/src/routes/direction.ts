import { Router, Request, Response } from 'express';
import { db } from '../db/index';
import { synthesize } from '../lib/direction-stack';

const router = Router();

// PUT /api/direction — upsert a direction layer
router.put('/', (req: Request, res: Response) => {
  const { layer, workspaceId, domain, contentYaml } = req.body;

  if (!layer || !contentYaml) {
    res.status(400).json({ error: 'Missing required fields: layer, contentYaml' });
    return;
  }

  if (![1, 2, 3].includes(layer)) {
    res.status(400).json({ error: 'layer must be 1, 2, or 3' });
    return;
  }

  // Upsert via INSERT OR REPLACE (unique index on layer + coalesced workspace_id + domain)
  db.prepare(`
    INSERT INTO direction_layers (layer, workspace_id, domain, content_yaml, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT (layer, COALESCE(workspace_id,''), COALESCE(domain,''))
    DO UPDATE SET content_yaml = excluded.content_yaml, updated_at = datetime('now')
  `).run(layer, workspaceId || null, domain || null, contentYaml);

  // WAL event
  db.prepare(
    `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('direction_update', ?, ?)`
  ).run(workspaceId || null, JSON.stringify({ layer, domain: domain || null }));

  res.json({ ok: true });
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

  const synthesized = synthesize({
    l1: l1Row?.content_yaml,
    l2: l2Row?.content_yaml,
    l3: l3Row?.content_yaml,
    specBrief: String(brief),
  });

  res.json({ preview: synthesized });
});

export default router;
