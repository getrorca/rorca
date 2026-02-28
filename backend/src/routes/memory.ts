/**
 * memory.ts — API routes for the Episodic MEMORY.md Ledger (CIE-005)
 *
 * CRUD operations on structured memory entries, approval/rejection flow
 * for post-run synthesis proposals, and context injection config.
 */

import { Router, Request, Response } from 'express';
import { db } from '../db/index';
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
  MEMORY_CATEGORIES,
  type MemoryEntry,
  type MemoryCategory,
} from '../lib/memory-ledger';

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
 *     summary: List memory entries
 *     parameters:
 *       - name: workspaceId
 *         in: query
 *         required: true
 *       - name: category
 *         in: query
 *         description: Filter by category
 *       - name: limit
 *         in: query
 *         description: Return only the N most recent entries
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
 *     summary: Append a new memory entry
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               workspaceId: { type: string }
 *               category: { type: string }
 *               title: { type: string }
 *               rule: { type: string }
 *               context: { type: string }
 *               source: { type: string }
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
 *     summary: Update an existing memory entry
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
 *     summary: Delete a memory entry by date + title
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
 *     summary: Get cached memory proposals for a workspace
 *     description: Returns persisted proposals from memory_proposals table. Supports filtering by status.
 *     parameters:
 *       - name: workspaceId
 *         in: query
 *         required: true
 *       - name: status
 *         in: query
 *         description: Filter by status (pending, approved, rejected, dismissed). Default pending.
 *       - name: runId
 *         in: query
 *         description: Filter by run ID
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
 *     summary: Approve, reject, or edit proposed memory entries from post-run synthesis
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
 *     summary: Dismiss proposals (user can return to review later)
 */
router.post('/proposals/dismiss', (req: Request, res: Response) => {
  const { workspaceId, proposalIds } = req.body as {
    workspaceId: string;
    proposalIds: string[];
  };

  if (!workspaceId || !proposalIds || !Array.isArray(proposalIds)) {
    return res.status(400).json({ error: 'workspaceId and proposalIds array required' });
  }

  const stmt = db.prepare(
    `UPDATE memory_proposals SET status = 'dismissed', resolved_at = datetime('now') WHERE proposal_id = ? AND workspace_id = ?`
  );

  let dismissed = 0;
  for (const id of proposalIds) {
    const r = stmt.run(id, workspaceId);
    dismissed += r.changes;
  }

  res.json({ dismissed });
});

/**
 * @swagger
 * /api/memory/proposals/undismiss:
 *   post:
 *     summary: Restore dismissed proposals back to pending for re-review
 */
router.post('/proposals/undismiss', (req: Request, res: Response) => {
  const { workspaceId, proposalIds } = req.body as {
    workspaceId: string;
    proposalIds?: string[];
  };

  if (!workspaceId) {
    return res.status(400).json({ error: 'workspaceId required' });
  }

  let restored = 0;
  if (proposalIds && proposalIds.length > 0) {
    const stmt = db.prepare(
      `UPDATE memory_proposals SET status = 'pending', resolved_at = NULL WHERE proposal_id = ? AND workspace_id = ? AND status = 'dismissed'`
    );
    for (const id of proposalIds) {
      const r = stmt.run(id, workspaceId);
      restored += r.changes;
    }
  } else {
    // Restore all dismissed for this workspace
    const r = db.prepare(
      `UPDATE memory_proposals SET status = 'pending', resolved_at = NULL WHERE workspace_id = ? AND status = 'dismissed'`
    ).run(workspaceId);
    restored = r.changes;
  }

  res.json({ restored });
});

/**
 * @swagger
 * /api/memory/rejected:
 *   get:
 *     summary: List rejected memory entries
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
 *     summary: Get memory context snippet for injection
 *     parameters:
 *       - name: workspaceId
 *         in: query
 *         required: true
 *       - name: n
 *         in: query
 *         description: Number of recent entries to include (default 20)
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
 *     summary: List available memory categories
 */
router.get('/categories', (_req: Request, res: Response) => {
  res.json({ categories: MEMORY_CATEGORIES });
});

export default router;
