/**
 * memory.ts — API routes for the Episodic MEMORY.md Ledger (CIE-005)
 *
 * CRUD operations on structured memory entries, approval/rejection flow
 * for post-run synthesis proposals, and context injection config.
 */

import { Router, Request, Response } from 'express';
import { db, execute, query as dbQuery, queryOne } from '../db/index';
import {
  readMemory,
  append,
  query,
  recent,
  deleteEntry,
  updateEntry,
  logRejected,
  readRejected,
  getContextSnippet,
  rotateMemory,
  countArchiveEntries,
  MEMORY_CATEGORIES,
  type MemoryEntry,
  type MemoryCategory,
} from '../lib/memory-ledger';
import { analyzeRunEvents } from '../lib/wal-feedback';
import { broadcastAll } from '../lib/sse-hub';

const router = Router();

// ─── Helpers ────────────────────────────────────────────────────────────────

function getWorkspacePath(workspaceId: string): string | null {
  const ws = db.prepare('SELECT path FROM workspaces WHERE id = ?').get(workspaceId) as { path: string } | undefined;
  return ws?.path ?? null;
}

function getLedgerPath(workspaceId: string): string | undefined {
  // Could read from .rorca/config.json in the future, but for now use default
  return undefined;
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

// ─── Routes ─────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/memory:
 *   get:
 *     tags: [Memory]
 *     summary: List memory entries for a workspace
 *     operationId: listMemoryEntries
 *     description: Returns structured memory ledger entries from MEMORY.md for a workspace. Can filter by category or return the N most recent entries.
 *     parameters:
 *       - name: workspaceId
 *         in: query
 *         required: true
 *         schema: { type: string }
 *         description: Workspace ID
 *       - name: category
 *         in: query
 *         schema: { type: string, enum: [Architecture, Convention, "Bug Fix", Decision, Pattern, Gotcha] }
 *         description: Filter entries by category
 *       - name: limit
 *         in: query
 *         schema: { type: integer }
 *         description: Return only the N most recent entries
 *     responses:
 *       200:
 *         description: Memory entries list
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
 *                       date: { type: string, description: "YYYY-MM-DD" }
 *                       category: { type: string }
 *                       title: { type: string }
 *                       rule: { type: string }
 *                       context: { type: string }
 *                       source: { type: string }
 *                 total: { type: integer }
 *                 categories: { type: array, items: { type: string } }
 *       400: { description: "Missing workspaceId" }
 *       404: { description: "Workspace not found" }
 */
router.get('/', (req: Request, res: Response) => {
  const { workspaceId, category, limit } = req.query;
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });

  const wsPath = getWorkspacePath(workspaceId as string);
  if (!wsPath) return res.status(404).json({ error: 'Workspace not found' });

  const ledgerPath = getLedgerPath(workspaceId as string);

  let entries: MemoryEntry[];
  if (category && MEMORY_CATEGORIES.includes(category as MemoryCategory)) {
    entries = query(wsPath, category as MemoryCategory, ledgerPath);
  } else if (limit) {
    entries = recent(wsPath, parseInt(limit as string, 10) || 20, ledgerPath);
  } else {
    entries = readMemory(wsPath, ledgerPath);
  }

  res.json({
    items: entries,
    total: entries.length,
    categories: MEMORY_CATEGORIES,
  });
});

/**
 * @swagger
 * /api/memory:
 *   post:
 *     tags: [Memory]
 *     summary: Append a new memory entry
 *     operationId: createMemoryEntry
 *     description: Appends a new structured entry to the workspace MEMORY.md ledger file with the current date.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, category, title, rule]
 *             properties:
 *               workspaceId: { type: string }
 *               category: { type: string, enum: [Architecture, Convention, "Bug Fix", Decision, Pattern, Gotcha] }
 *               title: { type: string, description: "Short title for the entry" }
 *               rule: { type: string, description: "The rule or insight to remember" }
 *               context: { type: string, description: "Optional additional context" }
 *               source: { type: string, description: "Optional source story ID (e.g. US-001)" }
 *     responses:
 *       201:
 *         description: Memory entry created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 entry:
 *                   type: object
 *                   properties:
 *                     date: { type: string }
 *                     category: { type: string }
 *                     title: { type: string }
 *                     rule: { type: string }
 *                     context: { type: string }
 *                     source: { type: string }
 *                 total: { type: integer, description: "Total entry count after insertion" }
 *       400: { description: "Missing required fields or invalid category" }
 *       404: { description: "Workspace not found" }
 */
router.post('/', (req: Request, res: Response) => {
  const { workspaceId, category, title, rule, context, source } = req.body;

  if (!workspaceId || !category || !title || !rule) {
    return res.status(400).json({ error: 'workspaceId, category, title, and rule are required' });
  }

  if (!MEMORY_CATEGORIES.includes(category as MemoryCategory)) {
    return res.status(400).json({ error: `Invalid category. Must be one of: ${MEMORY_CATEGORIES.join(', ')}` });
  }

  const wsPath = getWorkspacePath(workspaceId);
  if (!wsPath) return res.status(404).json({ error: 'Workspace not found' });

  const entry: MemoryEntry = {
    date: todayDate(),
    category: category as MemoryCategory,
    title,
    rule,
    context: context ?? '',
    source: source ?? '',
  };

  const entries = append(wsPath, entry, getLedgerPath(workspaceId));
  res.status(201).json({ entry, total: entries.length });
});

/**
 * @swagger
 * /api/memory/entry:
 *   put:
 *     tags: [Memory]
 *     summary: Update an existing memory entry
 *     operationId: updateMemoryEntry
 *     description: Updates an existing memory entry identified by date and title with the provided field changes.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, date, title]
 *             properties:
 *               workspaceId: { type: string }
 *               date: { type: string, description: "YYYY-MM-DD entry date" }
 *               title: { type: string, description: "Existing entry title to match" }
 *               updates:
 *                 type: object
 *                 description: Fields to update
 *                 properties:
 *                   rule: { type: string }
 *                   context: { type: string }
 *                   category: { type: string }
 *                   title: { type: string }
 *     responses:
 *       200:
 *         description: Entry updated — returns all entries
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 items: { type: array, items: { type: object } }
 *                 total: { type: integer }
 *       400: { description: "Missing required fields" }
 *       404: { description: "Workspace or entry not found" }
 */
router.put('/entry', (req: Request, res: Response) => {
  const { workspaceId, date, title, updates } = req.body;

  if (!workspaceId || !date || !title) {
    return res.status(400).json({ error: 'workspaceId, date, and title are required' });
  }

  if (updates?.category && !MEMORY_CATEGORIES.includes(updates.category as MemoryCategory)) {
    return res.status(400).json({ error: `Invalid category. Must be one of: ${MEMORY_CATEGORIES.join(', ')}` });
  }

  const wsPath = getWorkspacePath(workspaceId);
  if (!wsPath) return res.status(404).json({ error: 'Workspace not found' });

  const result = updateEntry(wsPath, date, title, updates ?? {}, getLedgerPath(workspaceId));
  if (!result) return res.status(404).json({ error: 'Entry not found' });

  res.json({ items: result, total: result.length });
});

/**
 * @swagger
 * /api/memory/entry:
 *   delete:
 *     tags: [Memory]
 *     summary: Delete a memory entry by date + title
 *     operationId: deleteMemoryEntry
 *     description: Removes a specific memory entry from the MEMORY.md ledger, identified by its date and title.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, date, title]
 *             properties:
 *               workspaceId: { type: string }
 *               date: { type: string, description: "YYYY-MM-DD entry date" }
 *               title: { type: string, description: "Entry title to delete" }
 *     responses:
 *       200:
 *         description: Entry deleted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 deleted: { type: boolean }
 *       400: { description: "Missing required fields" }
 *       404: { description: "Workspace or entry not found" }
 */
router.delete('/entry', (req: Request, res: Response) => {
  const { workspaceId, date, title } = req.body;

  if (!workspaceId || !date || !title) {
    return res.status(400).json({ error: 'workspaceId, date, and title are required' });
  }

  const wsPath = getWorkspacePath(workspaceId);
  if (!wsPath) return res.status(404).json({ error: 'Workspace not found' });

  const removed = deleteEntry(wsPath, date, title, getLedgerPath(workspaceId));
  if (!removed) return res.status(404).json({ error: 'Entry not found' });

  res.json({ deleted: true });
});

/**
 * @swagger
 * /api/memory/proposals:
 *   get:
 *     tags: [Memory]
 *     summary: List memory proposals for a workspace
 *     operationId: listMemoryProposals
 *     description: Returns persisted proposals from memory_proposals table. Defaults to pending status. Supports filtering by status and run ID.
 *     parameters:
 *       - name: workspaceId
 *         in: query
 *         required: true
 *         schema: { type: string }
 *       - name: status
 *         in: query
 *         schema: { type: string, enum: [pending, approved, rejected, dismissed] }
 *         description: Filter by status (defaults to pending)
 *       - name: runId
 *         in: query
 *         schema: { type: integer }
 *         description: Filter by pipeline run ID
 *     responses:
 *       200:
 *         description: Memory proposals list
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
 *                       proposalId: { type: string }
 *                       runId: { type: integer }
 *                       date: { type: string }
 *                       category: { type: string }
 *                       title: { type: string }
 *                       rule: { type: string }
 *                       context: { type: string }
 *                       source: { type: string }
 *                       status: { type: string }
 *                       proposedAt: { type: string }
 *                       resolvedAt: { type: string, nullable: true }
 *                 total: { type: integer }
 *       400: { description: "Missing workspaceId" }
 */
router.get('/proposals', (req: Request, res: Response) => {
  const { workspaceId, status, runId } = req.query;
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });

  let sql = 'SELECT * FROM memory_proposals WHERE workspace_id = ?';
  const params: (string | number)[] = [workspaceId as string];

  if (status) {
    sql += ' AND status = ?';
    params.push(status as string);
  } else {
    sql += " AND status = 'pending'";
  }

  if (runId) {
    sql += ' AND run_id = ?';
    params.push(parseInt(runId as string, 10));
  }

  sql += ' ORDER BY proposed_at DESC';

  const rows = db.prepare(sql).all(...params) as Array<{
    id: number;
    proposal_id: string;
    run_id: number;
    workspace_id: string;
    category: string;
    title: string;
    rule: string;
    context: string;
    source_story: string;
    status: string;
    proposed_at: string;
    resolved_at: string | null;
  }>;

  const items = rows.map(r => ({
    proposalId: r.proposal_id,
    runId: r.run_id,
    date: r.proposed_at.slice(0, 10),
    category: r.category,
    title: r.title,
    rule: r.rule,
    context: r.context,
    source: r.source_story,
    status: r.status,
    proposedAt: r.proposed_at,
    resolvedAt: r.resolved_at,
  }));

  res.json({ items, total: items.length });
});

/**
 * @swagger
 * /api/memory/proposals:
 *   post:
 *     tags: [Memory]
 *     summary: Approve, reject, or edit memory proposals
 *     operationId: resolveMemoryProposals
 *     description: Processes an array of proposal actions (approve, reject, or edit) and updates both the MEMORY.md ledger and the database accordingly. Approved and edited entries are immediately appended to MEMORY.md.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, proposals]
 *             properties:
 *               workspaceId: { type: string }
 *               proposals:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [proposalId, action, entry]
 *                   properties:
 *                     proposalId: { type: string }
 *                     action: { type: string, enum: [approve, reject, edit] }
 *                     entry:
 *                       type: object
 *                       properties:
 *                         date: { type: string }
 *                         category: { type: string }
 *                         title: { type: string }
 *                         rule: { type: string }
 *                         context: { type: string }
 *                         source: { type: string }
 *                     edits:
 *                       type: object
 *                       description: Override fields when action is 'edit'
 *                       properties:
 *                         rule: { type: string }
 *                         context: { type: string }
 *                         category: { type: string }
 *                         title: { type: string }
 *     responses:
 *       200:
 *         description: Proposal results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 results:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       proposalId: { type: string }
 *                       action: { type: string }
 *                       success: { type: boolean }
 *       400: { description: "Missing workspaceId or proposals array" }
 *       404: { description: "Workspace not found" }
 */
router.post('/proposals', (req: Request, res: Response) => {
  const { workspaceId, proposals } = req.body as {
    workspaceId: string;
    proposals: Array<{
      proposalId: string;
      action: 'approve' | 'reject' | 'edit';
      entry: MemoryEntry;
      edits?: Partial<Pick<MemoryEntry, 'rule' | 'context' | 'category' | 'title'>>;
    }>;
  };

  if (!workspaceId || !proposals || !Array.isArray(proposals)) {
    return res.status(400).json({ error: 'workspaceId and proposals array required' });
  }

  const wsPath = getWorkspacePath(workspaceId);
  if (!wsPath) return res.status(404).json({ error: 'Workspace not found' });

  const ledgerPath = getLedgerPath(workspaceId);
  const results: Array<{ proposalId: string; action: string; success: boolean }> = [];

  const updateStmt = db.prepare(
    `UPDATE memory_proposals SET status = ?, resolved_at = datetime('now') WHERE proposal_id = ? AND workspace_id = ?`
  );

  for (const p of proposals) {
    if (p.action === 'approve') {
      const entryToAppend: MemoryEntry = {
        ...p.entry,
        date: p.entry.date || todayDate(),
      };
      append(wsPath, entryToAppend, ledgerPath);
      updateStmt.run('approved', p.proposalId, workspaceId);
      results.push({ proposalId: p.proposalId, action: 'approve', success: true });
    } else if (p.action === 'reject') {
      logRejected(wsPath, p.entry, p.proposalId);
      updateStmt.run('rejected', p.proposalId, workspaceId);
      results.push({ proposalId: p.proposalId, action: 'reject', success: true });
    } else if (p.action === 'edit') {
      const edited: MemoryEntry = {
        ...p.entry,
        ...p.edits,
        date: p.entry.date || todayDate(),
      };
      append(wsPath, edited, ledgerPath);
      // Also update the DB row with the edited content
      db.prepare(
        `UPDATE memory_proposals SET status = 'approved', resolved_at = datetime('now'), title = ?, rule = ?, context = ?, category = ? WHERE proposal_id = ? AND workspace_id = ?`
      ).run(edited.title, edited.rule, edited.context, edited.category, p.proposalId, workspaceId);
      results.push({ proposalId: p.proposalId, action: 'edit', success: true });
    }
  }

  res.json({ results });
});

/**
 * @swagger
 * /api/memory/proposals/dismiss:
 *   post:
 *     tags: [Memory]
 *     summary: Dismiss memory proposals
 *     operationId: dismissMemoryProposals
 *     description: Marks the specified proposals as dismissed so they no longer appear in the pending review queue. Dismissed proposals can be restored via /undismiss.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, proposalIds]
 *             properties:
 *               workspaceId: { type: string }
 *               proposalIds: { type: array, items: { type: string }, description: "Proposal IDs to dismiss" }
 *     responses:
 *       200:
 *         description: Proposals dismissed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 dismissed: { type: integer, description: "Number of proposals dismissed" }
 *       400: { description: "Missing workspaceId or proposalIds" }
 */
router.post('/proposals/dismiss', async (req: Request, res: Response) => {
  const { workspaceId, proposalIds } = req.body as {
    workspaceId: string;
    proposalIds: string[];
  };

  if (!workspaceId || !proposalIds || !Array.isArray(proposalIds)) {
    return res.status(400).json({ error: 'workspaceId and proposalIds array required' });
  }

  let dismissed = 0;
  for (const id of proposalIds) {
    const r = await execute(
      `UPDATE memory_proposals SET status = 'dismissed', resolved_at = NOW() WHERE proposal_id = $1 AND workspace_id = $2`,
      [id, workspaceId]
    );
    dismissed += r.rowCount;
  }

  res.json({ dismissed });
});

/**
 * @swagger
 * /api/memory/proposals/undismiss:
 *   post:
 *     tags: [Memory]
 *     summary: Restore dismissed proposals back to pending
 *     operationId: undismissMemoryProposals
 *     description: Restores previously dismissed proposals back to pending status. If proposalIds is omitted, restores all dismissed proposals for the workspace.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId: { type: string }
 *               proposalIds: { type: array, items: { type: string }, description: "Specific proposal IDs to restore. Omit to restore all dismissed." }
 *     responses:
 *       200:
 *         description: Proposals restored
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 restored: { type: integer, description: "Number of proposals restored to pending" }
 *       400: { description: "Missing workspaceId" }
 */
router.post('/proposals/undismiss', async (req: Request, res: Response) => {
  const { workspaceId, proposalIds } = req.body as {
    workspaceId: string;
    proposalIds?: string[];
  };

  if (!workspaceId) {
    return res.status(400).json({ error: 'workspaceId required' });
  }

  let restored = 0;
  if (proposalIds && proposalIds.length > 0) {
    for (const id of proposalIds) {
      const r = await execute(
        `UPDATE memory_proposals SET status = 'pending', resolved_at = NULL WHERE proposal_id = $1 AND workspace_id = $2 AND status = 'dismissed'`,
        [id, workspaceId]
      );
      restored += r.rowCount;
    }
  } else {
    // Restore all dismissed for this workspace
    const r = await execute(
      `UPDATE memory_proposals SET status = 'pending', resolved_at = NULL WHERE workspace_id = $1 AND status = 'dismissed'`,
      [workspaceId]
    );
    restored = r.rowCount;
  }

  res.json({ restored });
});

/**
 * @swagger
 * /api/memory/rejected:
 *   get:
 *     tags: [Memory]
 *     summary: List rejected memory entries
 *     operationId: listRejectedMemoryEntries
 *     description: Returns all previously rejected memory entries for the given workspace from the rejected log file (MEMORY_REJECTED.md).
 *     parameters:
 *       - name: workspaceId
 *         in: query
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Rejected entries list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 items: { type: array, items: { type: object } }
 *                 total: { type: integer }
 *       400: { description: "Missing workspaceId" }
 *       404: { description: "Workspace not found" }
 */
router.get('/rejected', (req: Request, res: Response) => {
  const { workspaceId } = req.query;
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });

  const wsPath = getWorkspacePath(workspaceId as string);
  if (!wsPath) return res.status(404).json({ error: 'Workspace not found' });

  const rejected = readRejected(wsPath);
  res.json({ items: rejected, total: rejected.length });
});

/**
 * @swagger
 * /api/memory/context:
 *   get:
 *     tags: [Memory]
 *     summary: Get memory context snippet for agent prompt injection
 *     operationId: getMemoryContextSnippet
 *     description: Generates a formatted context snippet from recent memory entries suitable for injection into agent prompts. Returns a compact markdown section with token estimate.
 *     parameters:
 *       - name: workspaceId
 *         in: query
 *         required: true
 *         schema: { type: string }
 *       - name: n
 *         in: query
 *         schema: { type: integer, default: 20 }
 *         description: Number of recent entries to include
 *     responses:
 *       200:
 *         description: Context snippet
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 snippet: { type: string, description: "Formatted markdown snippet for prompt injection" }
 *                 tokenEstimate: { type: integer, description: "Approximate token count (length/4)" }
 *       400: { description: "Missing workspaceId" }
 *       404: { description: "Workspace not found" }
 */
router.get('/context', (req: Request, res: Response) => {
  const { workspaceId, n } = req.query;
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });

  const wsPath = getWorkspacePath(workspaceId as string);
  if (!wsPath) return res.status(404).json({ error: 'Workspace not found' });

  const snippet = getContextSnippet(wsPath, parseInt(n as string, 10) || 20, getLedgerPath(workspaceId as string));
  res.json({ snippet, tokenEstimate: Math.ceil(snippet.length / 4) });
});

/**
 * @swagger
 * /api/memory/categories:
 *   get:
 *     tags: [Memory]
 *     summary: List available memory categories
 *     operationId: listMemoryCategories
 *     description: Returns the list of valid memory entry categories that can be used when creating or filtering entries.
 *     responses:
 *       200:
 *         description: Available categories
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 categories:
 *                   type: array
 *                   items: { type: string }
 *                   example: [Architecture, Convention, "Bug Fix", Decision, Pattern, Gotcha]
 */
router.get('/categories', (_req: Request, res: Response) => {
  res.json({ categories: MEMORY_CATEGORIES });
});

/**
 * @swagger
 * /api/memory/archive/count:
 *   get:
 *     tags: [Memory]
 *     summary: Get archived entry count for a workspace
 *     operationId: getMemoryArchiveCount
 *     description: Returns the number of entries in the MEMORY_ARCHIVE.md file for the given workspace.
 *     parameters:
 *       - name: workspaceId
 *         in: query
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Archive entry count
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 count: { type: integer, description: "Number of entries in MEMORY_ARCHIVE.md" }
 *       400: { description: "Missing workspaceId" }
 *       404: { description: "Workspace not found" }
 */
router.get('/archive/count', (req: Request, res: Response) => {
  const { workspaceId } = req.query;
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });

  const wsPath = getWorkspacePath(workspaceId as string);
  if (!wsPath) return res.status(404).json({ error: 'Workspace not found' });

  const count = countArchiveEntries(wsPath);
  res.json({ count });
});

/**
 * @swagger
 * /api/memory/rotate:
 *   post:
 *     tags: [Memory]
 *     summary: Rotate old memory entries to archive
 *     operationId: rotateMemoryEntries
 *     description: |
 *       Moves old or excess entries from MEMORY.md to .rorca/memory/MEMORY_ARCHIVE.md.
 *       Architecture and Convention entries are never rotated (permanent project knowledge).
 *       Rotation triggers based on: entry age (MEMORY_RETENTION_DAYS, default 30),
 *       max entry count (MEMORY_MAX_ENTRIES, default 200), or token budget (8000 tokens).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId: { type: string }
 *               retentionDays: { type: number, description: "Days before entries are eligible for rotation (default 30)" }
 *               maxEntries: { type: number, description: "Max active entries cap (default 200)" }
 *               tokenBudget: { type: number, description: "Target token budget (default 8000)" }
 *     responses:
 *       200:
 *         description: Rotation result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 rotated: { type: integer }
 *                 remaining: { type: integer }
 *                 archived: { type: integer }
 *       400: { description: "Missing workspaceId" }
 *       404: { description: "Workspace not found" }
 */
router.post('/rotate', (req: Request, res: Response) => {
  const { workspaceId, retentionDays, maxEntries, tokenBudget } = req.body;
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });

  const wsPath = getWorkspacePath(workspaceId);
  if (!wsPath) return res.status(404).json({ error: 'Workspace not found' });

  const result = rotateMemory(wsPath, {
    retentionDays: retentionDays !== undefined ? Number(retentionDays) : undefined,
    maxEntries: maxEntries !== undefined ? Number(maxEntries) : undefined,
    tokenBudget: tokenBudget !== undefined ? Number(tokenBudget) : undefined,
  });

  res.json(result);
});

/**
 * @swagger
 * /api/memory/synthesize-from-run/{runId}:
 *   post:
 *     tags: [Memory]
 *     summary: Synthesize memory proposals from a pipeline run
 *     operationId: synthesizeMemoryFromRun
 *     description: |
 *       Analyzes WAL events for the specified run and generates candidate memory entries.
 *       Entries are deduplicated against existing memory, persisted as proposals in the
 *       memory_proposals table, and broadcast via SSE. User can then approve/reject proposals.
 *     parameters:
 *       - name: runId
 *         in: path
 *         required: true
 *         schema: { type: integer }
 *         description: Pipeline run ID to analyze
 *     responses:
 *       200:
 *         description: Generated proposals
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
 *                       proposalId: { type: string }
 *                       date: { type: string }
 *                       category: { type: string }
 *                       title: { type: string }
 *                       rule: { type: string }
 *                       context: { type: string }
 *                       source: { type: string }
 *                       status: { type: string }
 *                 total: { type: integer }
 *       400: { description: "Invalid runId" }
 *       404: { description: "Run not found" }
 */
// POST /api/memory/synthesize — synthesize memory proposals from all recent runs for a workspace
router.post('/synthesize', async (req: Request, res: Response) => {
  const { workspaceId } = req.body;
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId is required' });

  // Find recent completed runs for this workspace (last 10)
  const runs = await dbQuery<{ id: number }>(
    `SELECT id FROM pipeline_runs WHERE workspace_id = $1 AND status IN ('passed','failed','finished')
     ORDER BY finished_at DESC LIMIT 10`,
    [String(workspaceId)]
  );

  if (runs.length === 0) {
    return res.json({ proposals: [], total: 0 });
  }

  const allProposals: Array<{
    proposalId: string; date: string; category: string;
    title: string; rule: string; context: string; source: string; status: string;
  }> = [];
  const today = new Date().toISOString().slice(0, 10);

  for (const run of runs) {
    const candidates = await analyzeRunEvents(run.id);
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const proposalId = `wal-feedback-${run.id}-${i}`;
      await execute(
        `INSERT INTO memory_proposals (proposal_id, run_id, workspace_id, category, title, rule, context, source_story, status, proposed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', NOW())
         ON CONFLICT DO NOTHING`,
        [proposalId, run.id, String(workspaceId), c.category, c.title, c.rule, c.context, c.source]
      );
      allProposals.push({
        proposalId, date: today, category: c.category,
        title: c.title, rule: c.rule, context: c.context,
        source: c.source, status: 'pending',
      });
    }
  }

  if (allProposals.length > 0) {
    const walPayload = JSON.stringify({ workspace_id: workspaceId, proposals: allProposals });
    const walRow = await queryOne<{ id: number }>(
      `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('memory_proposals', $1, $2) RETURNING id`,
      [String(workspaceId), walPayload]
    );
    broadcastAll({
      id: walRow?.id ?? 0,
      ts: new Date().toISOString(),
      event_type: 'memory_proposals',
      workspace_id: String(workspaceId),
      spec_id: null, story_id: null, actor: 'system',
      payload: walPayload,
    });
  }

  res.json({ proposals: allProposals, total: allProposals.length });
});

router.post('/synthesize-from-run/:runId', async (req: Request, res: Response) => {
  const runId = parseInt(req.params.runId as string, 10);
  if (isNaN(runId)) return res.status(400).json({ error: 'Invalid runId' });

  const run = await queryOne<{ id: number; workspace_id: string; status: string }>(
    'SELECT id, workspace_id, status FROM pipeline_runs WHERE id = $1',
    [runId]
  );

  if (!run) return res.status(404).json({ error: 'Run not found' });

  // Generate candidates from WAL event analysis
  const candidates = await analyzeRunEvents(runId);

  if (candidates.length === 0) {
    return res.json({ proposals: [], total: 0 });
  }

  // Persist as proposals in memory_proposals table
  const today = new Date().toISOString().slice(0, 10);

  const proposals = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const proposalId = `wal-feedback-${runId}-${i}`;
    await execute(
      `INSERT INTO memory_proposals (proposal_id, run_id, workspace_id, category, title, rule, context, source_story, status, proposed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', NOW())
       ON CONFLICT DO NOTHING`,
      [proposalId, runId, run.workspace_id, c.category, c.title, c.rule, c.context, c.source]
    );
    proposals.push({
      proposalId,
      date: today,
      category: c.category,
      title: c.title,
      rule: c.rule,
      context: c.context,
      source: c.source,
      status: 'pending',
    });
  }

  // Broadcast via SSE
  const walPayload = JSON.stringify({
    run_id: runId,
    workspace_id: run.workspace_id,
    proposals,
  });

  const walRow = await queryOne<{ id: number }>(
    `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('memory_proposals', $1, $2) RETURNING id`,
    [run.workspace_id, walPayload]
  );

  broadcastAll({
    id: walRow?.id ?? 0,
    ts: new Date().toISOString(),
    event_type: 'memory_proposals',
    workspace_id: run.workspace_id,
    spec_id: null,
    story_id: null,
    actor: 'system',
    payload: walPayload,
  });

  res.json({ proposals, total: proposals.length });
});

export default router;
