import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { db } from '../db/index';

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
}

// ─── POST / — Create a template from an approved spec ─────────────────────────

router.post('/', (req: Request, res: Response) => {
  try {
    const { name, description, sourceSpecId, brief, storyStructure, directionLayers } = req.body;

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

    const id = randomUUID();
    const storyCount = storyStructure.length;

    db.prepare(
      `INSERT INTO templates (id, name, description, source_spec_id, brief, story_structure, direction_layers, story_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      name,
      description ?? null,
      sourceSpecId,
      brief,
      JSON.stringify(storyStructure),
      directionLayers ? JSON.stringify(directionLayers) : null,
      storyCount,
    );

    const row = db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as TemplateRow;

    res.status(201).json({
      id: row.id,
      name: row.name,
      description: row.description,
      sourceSpecId: row.source_spec_id,
      brief: row.brief,
      storyStructure: JSON.parse(row.story_structure),
      directionLayers: row.direction_layers ? JSON.parse(row.direction_layers) : null,
      storyCount: row.story_count,
      createdAt: row.created_at,
    });
  } catch (error: any) {
    console.error('[Templates] Create error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── GET / — List all templates ───────────────────────────────────────────────

router.get('/', (_req: Request, res: Response) => {
  try {
    const rows = db.prepare(
      'SELECT id, name, description, source_spec_id, story_count, created_at FROM templates ORDER BY created_at DESC'
    ).all() as Pick<TemplateRow, 'id' | 'name' | 'description' | 'source_spec_id' | 'story_count' | 'created_at'>[];

    const templates = rows.map(row => ({
      id: row.id,
      name: row.name,
      description: row.description,
      sourceSpecId: row.source_spec_id,
      storyCount: row.story_count,
      createdAt: row.created_at,
    }));

    res.json({ templates });
  } catch (error: any) {
    console.error('[Templates] List error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /:id — Get a single template ─────────────────────────────────────────

router.get('/:id', (req: Request, res: Response) => {
  try {
    const row = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id) as TemplateRow | undefined;

    if (!row) {
      res.status(404).json({ error: 'Template not found' });
      return;
    }

    res.json({
      id: row.id,
      name: row.name,
      description: row.description,
      sourceSpecId: row.source_spec_id,
      brief: row.brief,
      storyStructure: JSON.parse(row.story_structure),
      directionLayers: row.direction_layers ? JSON.parse(row.direction_layers) : null,
      storyCount: row.story_count,
      createdAt: row.created_at,
    });
  } catch (error: any) {
    console.error('[Templates] Get error:', error);
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
    console.error('[Templates] Delete error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
