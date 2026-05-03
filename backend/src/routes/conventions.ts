/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * CA-005: Convention Discovery Routes
 *
 * POST /api/conventions/discover       — Spawn analysis agent against workspace
 * GET  /api/conventions/drift/:workspaceId — Get latest drift report (stub — not yet implemented)
 * GET  /api/conventions/proposals/:workspaceId — List proposals for workspace
 * GET  /api/conventions/proposals/:workspaceId/:id — Single proposal detail
 * POST /api/conventions/proposals/:id/approve — Apply proposal artifacts
 * POST /api/conventions/proposals/:id/reject  — Reject proposal
 */
import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { query, queryOne, execute } from '../db/index';
import { discoverConventions } from '../lib/convention-agent';
import type { ConventionProposal } from '../lib/convention-agent';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors';
import { handleRouteError } from '../lib/async-handler';

const router = Router();

// ─── Types ──────────────────────────────────────────────────────────────────

interface WorkspaceRow {
  id: string;
  label: string;
  path: string;
}

interface ProposalRow {
  id: number;
  workspace_id: string;
  proposal_json: string;
  status: string;
  reject_reason: string | null;
  created_at: string;
  resolved_at: string | null;
}

// ─── GET /drift/:workspaceId — Stub (convention drift not yet implemented) ──

/**
 * @swagger
 * /api/conventions/drift/{workspaceId}:
 *   get:
 *     tags: [Conventions]
 *     summary: Get latest convention drift report
 *     description: Returns the most recent drift report for this workspace. Currently a stub — convention drift detection is not yet implemented.
 *     parameters:
 *       - in: path
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Drift report (null if not yet available)
 */
router.get('/drift/:workspaceId', (_req: Request, res: Response) => {
  // Stub: convention drift detection is not yet implemented.
  // Frontend (HealthDashboardPanel, TriggerPopover) expects { report: null } when no report exists.
  res.json({ report: null });
});

// ─── POST /discover ─────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/conventions/discover:
 *   post:
 *     tags: [Conventions]
 *     summary: Discover conventions from workspace codebase
 *     description: Spawns an analysis agent that reads config files, source code, and existing context files to produce convention artifacts staged for human review.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId:
 *                 type: string
 *                 description: Workspace to analyze
 *     responses:
 *       201:
 *         description: Convention proposal created
 *       400:
 *         description: Missing workspaceId
 *       404:
 *         description: Workspace not found
 */
router.post('/discover', async (req: Request, res: Response) => {
  const { workspaceId } = req.body;

  if (!workspaceId) {
    throw new ValidationError('Missing required field: workspaceId');
    return;
  }

  const workspace = await queryOne<WorkspaceRow>(
    'SELECT id, label, path FROM workspaces WHERE id = $1',
    [workspaceId],
  );

  if (!workspace) {
    throw new NotFoundError(`Workspace '${workspaceId}' not found`);
    return;
  }

  if (!fs.existsSync(workspace.path)) {
    throw new ValidationError(`Workspace path does not exist: ${workspace.path}`);
    return;
  }

  try {
    const proposal = await discoverConventions(workspace.path);

    // Store as proposal (NOT auto-applied)
    const result = await queryOne<{ id: number }>(
      `INSERT INTO convention_proposals (workspace_id, proposal_json, status, created_at)
       VALUES ($1, $2, 'pending', NOW())
       RETURNING id`,
      [workspaceId, JSON.stringify(proposal)],
    );

    const proposalId = result!.id;

    // WAL event
    await execute(
      `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('convention_discovered', $1, $2)`,
      [workspaceId, JSON.stringify({
        proposalId,
        stackCount: proposal.stack.length,
        conventionCount: proposal.conventions.length,
        skillCount: proposal.skills.length,
        architecture: proposal.architecture.pattern,
      })],
    );

    res.status(201).json({
      id: proposalId,
      workspaceId,
      proposal,
      status: 'pending',
    });
  } catch (err: unknown) {
    handleRouteError(res, err, '[Conventions] Discover');
  }
});

// ─── GET /proposals/:workspaceId ────────────────────────────────────────────

/**
 * @swagger
 * /api/conventions/proposals/{workspaceId}:
 *   get:
 *     tags: [Conventions]
 *     summary: List convention proposals for a workspace
 *     parameters:
 *       - in: path
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [pending, approved, rejected, all] }
 *         description: "Filter by status (default: all)"
 *     responses:
 *       200:
 *         description: List of proposals
 */
router.get('/proposals/:workspaceId', async (req: Request, res: Response) => {
  const { workspaceId } = req.params;
  const status = (req.query.status as string) || 'all';

  let rows: ProposalRow[];
  if (status === 'all') {
    rows = await query<ProposalRow>(
      'SELECT * FROM convention_proposals WHERE workspace_id = $1 ORDER BY created_at DESC',
      [workspaceId],
    );
  } else {
    rows = await query<ProposalRow>(
      'SELECT * FROM convention_proposals WHERE workspace_id = $1 AND status = $2 ORDER BY created_at DESC',
      [workspaceId, status],
    );
  }

  const items = rows.map(row => ({
    id: row.id,
    workspaceId: row.workspace_id,
    proposal: JSON.parse(row.proposal_json) as ConventionProposal,
    status: row.status,
    rejectReason: row.reject_reason,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  }));

  res.json({ items, total: items.length });
});

// ─── GET /proposals/:workspaceId/:id ────────────────────────────────────────

/**
 * @swagger
 * /api/conventions/proposals/{workspaceId}/{id}:
 *   get:
 *     tags: [Conventions]
 *     summary: Get a single convention proposal
 *     parameters:
 *       - in: path
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Proposal detail
 *       404:
 *         description: Proposal not found
 */
router.get('/proposals/:workspaceId/:id', async (req: Request, res: Response) => {
  const { workspaceId, id } = req.params;

  const row = await queryOne<ProposalRow>(
    'SELECT * FROM convention_proposals WHERE id = $1 AND workspace_id = $2',
    [Number(id), workspaceId],
  );

  if (!row) {
    throw new NotFoundError('Proposal not found');
    return;
  }

  res.json({
    id: row.id,
    workspaceId: row.workspace_id,
    proposal: JSON.parse(row.proposal_json) as ConventionProposal,
    status: row.status,
    rejectReason: row.reject_reason,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  });
});

// ─── POST /proposals/:id/approve ────────────────────────────────────────────

/**
 * @swagger
 * /api/conventions/proposals/{id}/approve:
 *   post:
 *     tags: [Conventions]
 *     summary: Approve and apply a convention proposal
 *     description: Applies L3 direction layer, writes AGENTS.md, and creates skill files in .rorca/skills/
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Proposal approved and applied
 *       404:
 *         description: Proposal not found
 *       409:
 *         description: Proposal already resolved
 */
router.post('/proposals/:id/approve', async (req: Request, res: Response) => {
  const { id } = req.params;

  const row = await queryOne<ProposalRow>(
    'SELECT * FROM convention_proposals WHERE id = $1',
    [Number(id)],
  );

  if (!row) {
    throw new NotFoundError('Proposal not found');
    return;
  }

  if (row.status !== 'pending') {
    throw new ConflictError(`Proposal already ${row.status}`);
    return;
  }

  const proposal = JSON.parse(row.proposal_json) as ConventionProposal;
  const workspace = await queryOne<WorkspaceRow>(
    'SELECT id, label, path FROM workspaces WHERE id = $1',
    [row.workspace_id],
  );

  if (!workspace) {
    throw new NotFoundError('Workspace not found');
    return;
  }

  // Apply artifacts
  const applied: string[] = [];

  // 1. Upsert L3 direction layer
  await execute(
    `INSERT INTO direction_layers (layer, workspace_id, domain, content_yaml, updated_at)
     VALUES (3, $1, NULL, $2, NOW())
     ON CONFLICT (layer, COALESCE(workspace_id,''), COALESCE(domain,''))
     DO UPDATE SET content_yaml = EXCLUDED.content_yaml, updated_at = NOW()`,
    [row.workspace_id, proposal.directionL3],
  );
  applied.push('Direction Stack L3');

  // 2. Write AGENTS.md (if workspace path exists)
  try {
    const agentsPath = path.join(workspace.path, 'AGENTS.md');
    fs.writeFileSync(agentsPath, proposal.agentsMd, 'utf-8');
    applied.push('AGENTS.md');
  } catch (err: any) {
    console.error(`Failed to write AGENTS.md: ${err.message}`);
  }

  // 3. Write CLAUDE.md if proposal includes one (only when missing)
  if (proposal.claudeMd) {
    try {
      const claudePath = path.join(workspace.path, 'CLAUDE.md');
      if (!fs.existsSync(claudePath)) {
        fs.writeFileSync(claudePath, proposal.claudeMd, 'utf-8');
        applied.push('CLAUDE.md');
      }
    } catch (err: any) {
      console.error(`Failed to write CLAUDE.md: ${err.message}`);
    }
  }

  // 4. Write skill files to .rorca/skills/
  if (proposal.skills.length > 0) {
    try {
      const skillsDir = path.join(workspace.path, '.rorca', 'skills');
      fs.mkdirSync(skillsDir, { recursive: true });
      for (const skill of proposal.skills) {
        const skillPath = path.join(skillsDir, skill.filename);
        fs.writeFileSync(skillPath, skill.content, 'utf-8');
      }
      applied.push(`${proposal.skills.length} skill files`);
    } catch (err: any) {
      console.error(`Failed to write skill files: ${err.message}`);
    }
  }

  // Mark approved
  await execute(
    `UPDATE convention_proposals SET status = 'approved', resolved_at = NOW() WHERE id = $1`,
    [Number(id)],
  );

  // WAL event
  await execute(
    `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('convention_approved', $1, $2)`,
    [row.workspace_id, JSON.stringify({ proposalId: row.id, applied })],
  );

  res.json({ ok: true, applied });
});

// ─── POST /proposals/:id/reject ─────────────────────────────────────────────

/**
 * @swagger
 * /api/conventions/proposals/{id}/reject:
 *   post:
 *     tags: [Conventions]
 *     summary: Reject a convention proposal
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason:
 *                 type: string
 *                 description: Optional rejection reason
 *     responses:
 *       200:
 *         description: Proposal rejected
 *       404:
 *         description: Proposal not found
 *       409:
 *         description: Proposal already resolved
 */
router.post('/proposals/:id/reject', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { reason } = req.body || {};

  const row = await queryOne<ProposalRow>(
    'SELECT * FROM convention_proposals WHERE id = $1',
    [Number(id)],
  );

  if (!row) {
    throw new NotFoundError('Proposal not found');
    return;
  }

  if (row.status !== 'pending') {
    throw new ConflictError(`Proposal already ${row.status}`);
    return;
  }

  await execute(
    `UPDATE convention_proposals SET status = 'rejected', reject_reason = $1, resolved_at = NOW() WHERE id = $2`,
    [reason || null, Number(id)],
  );

  // WAL event
  await execute(
    `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('convention_rejected', $1, $2)`,
    [row.workspace_id, JSON.stringify({ proposalId: row.id, reason: reason || null })],
  );

  res.json({ ok: true });
});

export default router;
