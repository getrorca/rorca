/**
 * conventions.ts — Convention discovery and proposal management routes.
 *
 * CA-005: POST /api/conventions/discover spawns analysis agent.
 *         GET  /api/conventions/proposals/:workspaceId lists proposals.
 *         POST /api/conventions/proposals/:id/approve applies proposal.
 *         POST /api/conventions/proposals/:id/reject rejects proposal.
 */

import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { db } from '../db/index';
import { discoverConventions } from '../lib/convention-discovery';
import type { ConventionProposal } from '../lib/convention-discovery';
import { detectDrift } from '../lib/drift-detector';
import type { DriftReport, DriftViolation } from '../lib/drift-detector';
import { broadcastAll, type WalEvent } from '../lib/sse-hub';

const router = Router();

function emitWalEvent(eventType: string, workspaceId: string, payload: Record<string, unknown>): void {
  const result = db.prepare(
    'INSERT INTO wal_events (event_type, workspace_id, payload) VALUES (?, ?, ?)'
  ).run(eventType, workspaceId, JSON.stringify(payload));
  const walEvent: WalEvent = {
    id: result.lastInsertRowid as number,
    ts: new Date().toISOString(),
    event_type: eventType,
    workspace_id: workspaceId,
    spec_id: null,
    story_id: null,
    actor: '',
    payload: JSON.stringify(payload),
  };
  broadcastAll(walEvent);
}

/**
 * @swagger
 * /api/conventions/discover:
 *   post:
 *     tags: [Conventions]
 *     summary: Discover conventions in a workspace codebase
 *     operationId: discoverConventions
 *     description: Spawns an async convention analysis agent to scan the workspace codebase. Detects stack, architecture pattern, and generates a convention proposal with L3 direction layer, AGENTS.md template, and per-library guides. Stores the result as a pending proposal in the convention_proposals table.
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
 *         description: Convention proposal created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 proposalId: { type: integer }
 *                 proposal:
 *                   type: object
 *                   properties:
 *                     stack: { type: array, items: { type: string } }
 *                     conventions: { type: array, items: { type: object } }
 *                     architecture: { type: object, properties: { pattern: { type: string } } }
 *                     directionL3: { type: string, description: "YAML content for L3 direction layer" }
 *                     fileGovernance: { type: string, description: "Generated AGENTS.md content" }
 *                     perLibraryGuides: { type: object, additionalProperties: { type: string }, description: "filename → markdown content map" }
 *       400: { description: "Missing workspaceId" }
 *       404: { description: "Workspace not found or path missing on disk" }
 *       500: { description: "Convention discovery failed" }
 */
router.post('/discover', async (req: Request, res: Response) => {
  const { workspaceId } = req.body;

  if (!workspaceId) {
    res.status(400).json({ error: 'Missing required field: workspaceId' });
    return;
  }

  const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId) as
    { id: string; path: string; label: string } | undefined;

  if (!workspace) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }

  if (!fs.existsSync(workspace.path)) {
    res.status(404).json({ error: 'Workspace path does not exist on disk' });
    return;
  }

  try {
    const proposal = await discoverConventions(workspace.path);

    // Store proposal in DB
    const result = db.prepare(
      'INSERT INTO convention_proposals (workspace_id, proposal_json, status) VALUES (?, ?, ?)'
    ).run(workspaceId, JSON.stringify(proposal), 'pending');

    const proposalId = result.lastInsertRowid as number;

    // Emit WAL event
    emitWalEvent('convention_discovered', workspaceId, {
      proposalId,
      stackCount: proposal.stack.length,
      conventionCount: proposal.conventions.length,
      architecture: proposal.architecture.pattern,
    });

    res.json({
      ok: true,
      proposalId,
      proposal,
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Convention discovery failed', details: err.message });
  }
});

/**
 * @swagger
 * /api/conventions/proposals/{workspaceId}:
 *   get:
 *     tags: [Conventions]
 *     summary: List convention proposals for a workspace
 *     operationId: listConventionProposals
 *     description: Returns all convention proposals for the specified workspace, ordered by creation date descending.
 *     parameters:
 *       - in: path
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: List of proposals
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 proposals:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: integer }
 *                       workspaceId: { type: string }
 *                       proposal: { type: object }
 *                       status: { type: string, enum: [pending, approved, rejected] }
 *                       createdAt: { type: string }
 *                       resolvedAt: { type: string, nullable: true }
 */
router.get('/proposals/:workspaceId', (req: Request, res: Response) => {
  const { workspaceId } = req.params;

  const rows = db.prepare(
    'SELECT id, workspace_id, proposal_json, status, created_at, resolved_at FROM convention_proposals WHERE workspace_id = ? ORDER BY created_at DESC'
  ).all(workspaceId) as Array<{
    id: number;
    workspace_id: string;
    proposal_json: string;
    status: string;
    created_at: string;
    resolved_at: string | null;
  }>;

  const proposals = rows.map(row => ({
    id: row.id,
    workspaceId: row.workspace_id,
    proposal: JSON.parse(row.proposal_json) as ConventionProposal,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  }));

  res.json({ proposals });
});

/**
 * @swagger
 * /api/conventions/proposals/{id}/approve:
 *   post:
 *     tags: [Conventions]
 *     summary: Approve and apply a convention proposal
 *     operationId: approveConventionProposal
 *     description: "Applies the proposal's changes to the workspace: upserts L3 direction layer to DB, writes AGENTS.md if not present, and writes per-library convention guides to .rorca/conventions/. Emits convention_approved WAL event."
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Proposal approved and applied
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 applied:
 *                   type: array
 *                   items: { type: string }
 *                   description: List of changes applied (e.g. 'L3 direction layer', 'AGENTS.md (created)')
 *       400: { description: "Invalid proposal ID" }
 *       404: { description: "Proposal or workspace not found" }
 *       409: { description: "Proposal already resolved" }
 */
router.post('/proposals/:id/approve', (req: Request, res: Response) => {
  const proposalId = parseInt(String(req.params.id), 10);

  if (isNaN(proposalId)) {
    res.status(400).json({ error: 'Invalid proposal ID' });
    return;
  }

  const row = db.prepare(
    'SELECT id, workspace_id, proposal_json, status FROM convention_proposals WHERE id = ?'
  ).get(proposalId) as {
    id: number;
    workspace_id: string;
    proposal_json: string;
    status: string;
  } | undefined;

  if (!row) {
    res.status(404).json({ error: 'Proposal not found' });
    return;
  }

  if (row.status !== 'pending') {
    res.status(409).json({ error: `Proposal already ${row.status}` });
    return;
  }

  const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(row.workspace_id) as
    { id: string; path: string } | undefined;

  if (!workspace) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }

  const proposal = JSON.parse(row.proposal_json) as ConventionProposal;
  const applied: string[] = [];

  // 1. Apply L3 direction layer
  if (proposal.directionL3) {
    db.prepare(`
      INSERT INTO direction_layers (layer, workspace_id, domain, content_yaml, updated_at)
      VALUES (3, ?, NULL, ?, datetime('now'))
      ON CONFLICT (layer, COALESCE(workspace_id,''), COALESCE(domain,''))
      DO UPDATE SET content_yaml = excluded.content_yaml, updated_at = datetime('now')
    `).run(workspace.id, proposal.directionL3);
    applied.push('L3 direction layer');
  }

  // 2. Write AGENTS.md (if not already present)
  if (proposal.fileGovernance) {
    const agentsPath = path.join(workspace.path, 'AGENTS.md');
    if (!fs.existsSync(agentsPath)) {
      fs.writeFileSync(agentsPath, proposal.fileGovernance, 'utf-8');
      applied.push('AGENTS.md (created)');
    } else {
      applied.push('AGENTS.md (skipped — already exists)');
    }
  }

  // 3. Write per-library convention guides
  if (Object.keys(proposal.perLibraryGuides).length > 0) {
    const conventionsDir = path.join(workspace.path, '.rorca', 'conventions');
    fs.mkdirSync(conventionsDir, { recursive: true });
    for (const [filename, content] of Object.entries(proposal.perLibraryGuides)) {
      const guidePath = path.join(conventionsDir, filename);
      if (!fs.existsSync(guidePath)) {
        fs.writeFileSync(guidePath, content, 'utf-8');
        applied.push(`conventions/${filename}`);
      }
    }
  }

  // Mark proposal as approved
  db.prepare(
    "UPDATE convention_proposals SET status = 'approved', resolved_at = datetime('now') WHERE id = ?"
  ).run(proposalId);

  emitWalEvent('convention_approved', workspace.id, {
    proposalId,
    applied,
  });

  res.json({ ok: true, applied });
});

/**
 * @swagger
 * /api/conventions/proposals/{id}/reject:
 *   post:
 *     tags: [Conventions]
 *     summary: Reject a convention proposal
 *     operationId: rejectConventionProposal
 *     description: Marks a pending convention proposal as rejected without applying any changes to the workspace. Emits convention_rejected WAL event.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Proposal rejected
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *       400: { description: "Invalid proposal ID" }
 *       404: { description: "Proposal not found" }
 *       409: { description: "Proposal already resolved" }
 */
router.post('/proposals/:id/reject', (req: Request, res: Response) => {
  const proposalId = parseInt(String(req.params.id), 10);

  if (isNaN(proposalId)) {
    res.status(400).json({ error: 'Invalid proposal ID' });
    return;
  }

  const row = db.prepare(
    'SELECT id, workspace_id, status FROM convention_proposals WHERE id = ?'
  ).get(proposalId) as { id: number; workspace_id: string; status: string } | undefined;

  if (!row) {
    res.status(404).json({ error: 'Proposal not found' });
    return;
  }

  if (row.status !== 'pending') {
    res.status(409).json({ error: `Proposal already ${row.status}` });
    return;
  }

  db.prepare(
    "UPDATE convention_proposals SET status = 'rejected', resolved_at = datetime('now') WHERE id = ?"
  ).run(proposalId);

  emitWalEvent('convention_rejected', row.workspace_id, { proposalId });

  res.json({ ok: true });
});

/**
 * @swagger
 * /api/conventions/check:
 *   post:
 *     tags: [Conventions]
 *     summary: Run convention drift detection on a workspace
 *     operationId: checkConventionDrift
 *     description: Spawns a drift analysis agent that reads .rorca/conventions/*.md and direction stack L0-L3, samples up to 50 source files, and checks for violations. Stores the report in drift_reports table and emits convention_drift_detected WAL event.
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
 *         description: Drift report generated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 report:
 *                   type: object
 *                   properties:
 *                     violations:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           file: { type: string }
 *                           convention: { type: string }
 *                           severity: { type: string, enum: [error, warning] }
 *                           message: { type: string }
 *                     score: { type: integer, description: "Compliance score 0-100" }
 *                     conventionsChecked: { type: integer }
 *                     filesSampled: { type: integer }
 *                     checkedAt: { type: string }
 *       400: { description: "Missing workspaceId" }
 *       404: { description: "Workspace not found or path missing on disk" }
 *       500: { description: "Drift detection failed" }
 */
router.post('/check', async (req: Request, res: Response) => {
  const { workspaceId } = req.body;

  if (!workspaceId) {
    res.status(400).json({ error: 'Missing required field: workspaceId' });
    return;
  }

  const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId) as
    { id: string; path: string; label: string } | undefined;

  if (!workspace) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }

  if (!fs.existsSync(workspace.path)) {
    res.status(404).json({ error: 'Workspace path does not exist on disk' });
    return;
  }

  try {
    const report = await detectDrift(workspace.path, workspaceId);

    // Store in drift_reports table
    db.prepare(
      `INSERT INTO drift_reports (workspace_id, violations_json, score, conventions_checked, files_sampled, trigger_type)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      workspaceId,
      JSON.stringify(report.violations),
      report.score,
      report.conventionsChecked,
      report.filesSampled,
      'manual',
    );

    // Emit WAL event
    emitWalEvent('convention_drift_detected', workspaceId, {
      score: report.score,
      violationCount: report.violations.length,
      errorCount: report.violations.filter((v: DriftViolation) => v.severity === 'error').length,
      warningCount: report.violations.filter((v: DriftViolation) => v.severity === 'warning').length,
      conventionsChecked: report.conventionsChecked,
      filesSampled: report.filesSampled,
    });

    res.json({ ok: true, report });
  } catch (err: any) {
    res.status(500).json({ error: 'Drift detection failed', details: err.message });
  }
});

/**
 * @swagger
 * /api/conventions/drift/{workspaceId}:
 *   get:
 *     tags: [Conventions]
 *     summary: Get the latest drift report for a workspace
 *     operationId: getLatestDriftReport
 *     description: "Returns the most recent convention drift report from the drift_reports table. Returns { report: null } if no drift check has been run yet."
 *     parameters:
 *       - in: path
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Latest drift report or null
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: integer, nullable: true }
 *                 workspaceId: { type: string, nullable: true }
 *                 triggerType: { type: string, nullable: true }
 *                 report:
 *                   nullable: true
 *                   type: object
 *                   properties:
 *                     violations: { type: array, items: { type: object } }
 *                     score: { type: integer }
 *                     conventionsChecked: { type: integer }
 *                     filesSampled: { type: integer }
 *                     checkedAt: { type: string }
 */
router.get('/drift/:workspaceId', (req: Request, res: Response) => {
  const { workspaceId } = req.params;

  const row = db.prepare(
    `SELECT id, workspace_id, violations_json, score, conventions_checked, files_sampled, trigger_type, created_at
     FROM drift_reports WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 1`
  ).get(workspaceId) as {
    id: number;
    workspace_id: string;
    violations_json: string;
    score: number;
    conventions_checked: number;
    files_sampled: number;
    trigger_type: string;
    created_at: string;
  } | undefined;

  if (!row) {
    res.json({ report: null });
    return;
  }

  const report: DriftReport = {
    violations: JSON.parse(row.violations_json) as DriftViolation[],
    score: row.score,
    conventionsChecked: row.conventions_checked,
    filesSampled: row.files_sampled,
    checkedAt: row.created_at,
  };

  res.json({
    id: row.id,
    workspaceId: row.workspace_id,
    triggerType: row.trigger_type,
    report,
  });
});

export default router;
