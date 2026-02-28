/**
 * agents.ts — API routes for AGENTS.md governance (CIE-006)
 *
 * CRUD operations on workspace AGENTS.md: list roles, update roles,
 * generate from echolocation, and query violations.
 */

import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { db } from '../db/index';
import {
  loadAgentsMd,
  parseAgentsMd,
  serializeAgentsMd,
  generateAgentsMd,
  type AgentRole,
} from '../lib/agents-parser';

const router = Router();

// ─── Helpers ────────────────────────────────────────────────────────────────

function getWorkspacePath(workspaceId: string): string | null {
  const ws = db.prepare('SELECT path FROM workspaces WHERE id = ?').get(workspaceId) as { path: string } | undefined;
  return ws?.path ?? null;
}

// ─── Routes ─────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/agents:
 *   get:
 *     summary: Get AGENTS.md roles for a workspace
 *     parameters:
 *       - name: workspaceId
 *         in: query
 *         required: true
 */
router.get('/', (req: Request, res: Response) => {
  const { workspaceId } = req.query;
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });

  const wsPath = getWorkspacePath(workspaceId as string);
  if (!wsPath) return res.status(404).json({ error: 'Workspace not found' });

  const result = loadAgentsMd(wsPath);
  const agentsPath = path.join(wsPath, 'AGENTS.md');
  const exists = fs.existsSync(agentsPath);

  res.json({
    roles: result.roles,
    raw: result.raw,
    exists,
    path: agentsPath,
  });
});

/**
 * @swagger
 * /api/agents:
 *   put:
 *     summary: Update AGENTS.md roles for a workspace
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               workspaceId:
 *                 type: string
 *               roles:
 *                 type: array
 *               raw:
 *                 type: string
 */
router.put('/', (req: Request, res: Response) => {
  const { workspaceId, roles, raw } = req.body;
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });

  const wsPath = getWorkspacePath(workspaceId as string);
  if (!wsPath) return res.status(404).json({ error: 'Workspace not found' });

  const agentsPath = path.join(wsPath, 'AGENTS.md');

  // If raw content is provided, write it directly
  if (typeof raw === 'string') {
    fs.writeFileSync(agentsPath, raw, 'utf-8');
    const parsed = parseAgentsMd(raw);
    return res.json({ roles: parsed.roles, raw, path: agentsPath });
  }

  // Otherwise serialize from roles array
  if (!Array.isArray(roles)) {
    return res.status(400).json({ error: 'Either roles array or raw string required' });
  }

  // Validate role structure
  for (const role of roles) {
    if (!role.name || typeof role.name !== 'string') {
      return res.status(400).json({ error: 'Each role requires a name string' });
    }
    if (!Array.isArray(role.owns)) role.owns = [];
    if (!Array.isArray(role.avoids)) role.avoids = [];
    if (!Array.isArray(role.rules)) role.rules = [];
  }

  const content = serializeAgentsMd(roles as AgentRole[]);
  fs.writeFileSync(agentsPath, content, 'utf-8');

  res.json({ roles, raw: content, path: agentsPath });
});

/**
 * @swagger
 * /api/agents/generate:
 *   post:
 *     summary: Generate AGENTS.md from workspace directory structure (echolocation)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               workspaceId:
 *                 type: string
 */
router.post('/generate', (req: Request, res: Response) => {
  const { workspaceId } = req.body;
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });

  const wsPath = getWorkspacePath(workspaceId as string);
  if (!wsPath) return res.status(404).json({ error: 'Workspace not found' });

  const content = generateAgentsMd(wsPath);
  const parsed = parseAgentsMd(content);

  res.json({
    roles: parsed.roles,
    raw: content,
    generated: true,
  });
});

/**
 * @swagger
 * /api/agents/violations:
 *   get:
 *     summary: Query recent violations from WAL events
 *     parameters:
 *       - name: workspaceId
 *         in: query
 *         required: true
 *       - name: runId
 *         in: query
 *         description: Filter by specific run ID
 *       - name: limit
 *         in: query
 *         description: Max results (default 50)
 */
router.get('/violations', (req: Request, res: Response) => {
  const { workspaceId, runId, limit } = req.query;
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });

  const maxResults = parseInt(limit as string, 10) || 50;

  let sql = `
    SELECT id, event_type, payload, created_at
    FROM wal_events
    WHERE workspace_id = ? AND event_type = 'story_violation'
  `;
  const params: (string | number)[] = [workspaceId as string];

  if (runId) {
    sql += ` AND json_extract(payload, '$.run_id') = ?`;
    params.push(parseInt(runId as string, 10));
  }

  sql += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(maxResults);

  const rows = db.prepare(sql).all(...params) as Array<{
    id: number;
    event_type: string;
    payload: string;
    created_at: string;
  }>;

  const violations = rows.map(row => ({
    id: row.id,
    ...JSON.parse(row.payload),
    created_at: row.created_at,
  }));

  res.json({ items: violations, total: violations.length });
});

export default router;
