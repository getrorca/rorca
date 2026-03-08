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
 *     tags: [Agents]
 *     summary: Get AGENTS.md roles for a workspace
 *     operationId: getAgentRoles
 *     description: Returns the parsed AGENTS.md roles, raw file content, existence status, and absolute file path for the specified workspace.
 *     parameters:
 *       - name: workspaceId
 *         in: query
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: AGENTS.md content and parsed roles
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 roles:
 *                   type: array
 *                   description: Parsed agent role definitions
 *                   items:
 *                     type: object
 *                     properties:
 *                       name: { type: string }
 *                       owns: { type: array, items: { type: string } }
 *                       avoids: { type: array, items: { type: string } }
 *                       rules: { type: array, items: { type: string } }
 *                 raw: { type: string, description: "Raw AGENTS.md content" }
 *                 exists: { type: boolean, description: "Whether AGENTS.md exists at workspace root" }
 *                 path: { type: string, description: "Absolute path to AGENTS.md" }
 *       400: { description: "Missing workspaceId" }
 *       404: { description: "Workspace not found" }
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
 *     tags: [Agents]
 *     summary: Update AGENTS.md roles for a workspace
 *     operationId: updateAgentRoles
 *     description: Writes updated roles or raw content to the workspace AGENTS.md file. Provide either `raw` (written directly) or `roles` array (serialized from structured objects).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId: { type: string }
 *               raw: { type: string, description: "Raw markdown to write directly to AGENTS.md" }
 *               roles:
 *                 type: array
 *                 description: Structured roles to serialize and write (alternative to raw)
 *                 items:
 *                   type: object
 *                   required: [name]
 *                   properties:
 *                     name: { type: string }
 *                     owns: { type: array, items: { type: string } }
 *                     avoids: { type: array, items: { type: string } }
 *                     rules: { type: array, items: { type: string } }
 *     responses:
 *       200:
 *         description: AGENTS.md updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 roles: { type: array, items: { type: object } }
 *                 raw: { type: string }
 *                 path: { type: string }
 *       400: { description: "Missing workspaceId or invalid roles structure" }
 *       404: { description: "Workspace not found" }
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
 *     tags: [Agents]
 *     summary: Generate AGENTS.md from workspace directory structure
 *     operationId: generateAgentRoles
 *     description: Analyzes the workspace directory structure via echolocation to auto-generate AGENTS.md file governance roles. Returns the generated content without writing to disk — use PUT /api/agents to save.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId: { type: string }
 *     responses:
 *       200:
 *         description: Generated AGENTS.md content and roles (not written to disk)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 roles: { type: array, items: { type: object } }
 *                 raw: { type: string }
 *                 generated: { type: boolean }
 *       400: { description: "Missing workspaceId" }
 *       404: { description: "Workspace not found" }
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
 *     tags: [Agents]
 *     summary: Query AGENTS.md governance violations
 *     operationId: listAgentViolations
 *     description: Returns AGENTS.md governance violations recorded in WAL events (event_type=story_violation), optionally filtered by run ID.
 *     parameters:
 *       - name: workspaceId
 *         in: query
 *         required: true
 *         schema: { type: string }
 *       - name: runId
 *         in: query
 *         schema: { type: integer }
 *         description: Filter by specific pipeline run ID
 *       - name: limit
 *         in: query
 *         schema: { type: integer, default: 50 }
 *         description: Max results
 *     responses:
 *       200:
 *         description: Violations list
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
 *                       id: { type: integer }
 *                       created_at: { type: string }
 *                       story_id: { type: string, nullable: true }
 *                       file_path: { type: string, nullable: true }
 *                       rule_violated: { type: string, nullable: true }
 *                 total: { type: integer }
 *       400: { description: "Missing workspaceId" }
 */
router.get('/violations', (req: Request, res: Response) => {
  const { workspaceId, runId, limit } = req.query;
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });

  const maxResults = parseInt(limit as string, 10) || 50;

  let sql = `
    SELECT id, event_type, payload, ts
    FROM wal_events
    WHERE workspace_id = ? AND event_type = 'story_violation'
  `;
  const params: (string | number)[] = [workspaceId as string];

  if (runId) {
    sql += ` AND json_extract(payload, '$.run_id') = ?`;
    params.push(parseInt(runId as string, 10));
  }

  sql += ` ORDER BY ts DESC LIMIT ?`;
  params.push(maxResults);

  const rows = db.prepare(sql).all(...params) as Array<{
    id: number;
    event_type: string;
    payload: string;
    ts: string;
  }>;

  const violations = rows.map(row => ({
    id: row.id,
    ...JSON.parse(row.payload),
    created_at: row.ts,
  }));

  res.json({ items: violations, total: violations.length });
});

export default router;
