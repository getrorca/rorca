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
 *   post:
 *     summary: Approve or reject a proposed memory entry from post-run synthesis
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

  for (const p of proposals) {
    if (p.action === 'approve') {
      const entryToAppend: MemoryEntry = {
        ...p.entry,
        date: p.entry.date || todayDate(),
      };
      append(wsPath, entryToAppend, ledgerPath);
      results.push({ proposalId: p.proposalId, action: 'approve', success: true });
    } else if (p.action === 'reject') {
      logRejected(wsPath, p.entry, p.proposalId);
      results.push({ proposalId: p.proposalId, action: 'reject', success: true });
    } else if (p.action === 'edit') {
      const edited: MemoryEntry = {
        ...p.entry,
        ...p.edits,
        date: p.entry.date || todayDate(),
      };
      append(wsPath, edited, ledgerPath);
      results.push({ proposalId: p.proposalId, action: 'edit', success: true });
    }
  }

  res.json({ results });
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
