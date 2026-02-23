import { Router, Request, Response } from 'express';
import simpleGit from 'simple-git';
import { db } from '../db/index';
import { broadcastAll, type WalEvent } from '../lib/sse-hub';

const router = Router();

// ─── Types ───────────────────────────────────────────────────────────────────

interface GitWorktree {
  path: string;
  branch: string;
  headSha: string;
  isLocked: boolean;
  isBare: boolean;
  addedAt?: string;
}

interface WorkspaceRow {
  id: string;
  label: string;
  path: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getWorkspace(workspaceId: string): WorkspaceRow | undefined {
  return db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId) as WorkspaceRow | undefined;
}

function emitWalEvent(eventType: string, workspaceId: string, payload: Record<string, unknown>): void {
  const result = db.prepare(
    'INSERT INTO wal_events (event_type, workspace_id, payload) VALUES (?, ?, ?)'
  ).run(eventType, workspaceId, JSON.stringify(payload));

  const walEvent = db.prepare(
    'SELECT * FROM wal_events WHERE id = ?'
  ).get(result.lastInsertRowid) as WalEvent;

  broadcastAll(walEvent);
}

/**
 * Parse `git worktree list --porcelain` output into structured objects.
 *
 * Porcelain format:
 *   worktree /path/to/worktree
 *   HEAD abc123
 *   branch refs/heads/main
 *   <blank line>
 */
function parsePorcelain(output: string): GitWorktree[] {
  const worktrees: GitWorktree[] = [];
  const blocks = output.trim().split('\n\n');

  for (const block of blocks) {
    if (!block.trim()) continue;

    const lines = block.trim().split('\n');
    let wtPath = '';
    let headSha = '';
    let branch = '';
    let isLocked = false;
    let isBare = false;

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        wtPath = line.slice('worktree '.length);
      } else if (line.startsWith('HEAD ')) {
        headSha = line.slice('HEAD '.length);
      } else if (line.startsWith('branch ')) {
        branch = line.slice('branch '.length).replace('refs/heads/', '');
      } else if (line === 'locked') {
        isLocked = true;
      } else if (line === 'bare') {
        isBare = true;
      } else if (line === 'detached') {
        branch = '(detached)';
      }
    }

    if (wtPath) {
      worktrees.push({ path: wtPath, branch, headSha, isLocked, isBare });
    }
  }

  return worktrees;
}

// ─── GET /api/worktrees?workspaceId= ────────────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string;
    if (!workspaceId) {
      res.status(400).json({ error: 'Missing required query param: workspaceId' });
      return;
    }

    const workspace = getWorkspace(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const git = simpleGit(workspace.path);
    const output = await git.raw(['worktree', 'list', '--porcelain']);
    const worktrees = parsePorcelain(output);

    res.json({ worktrees });
  } catch (error: any) {
    console.error('[Worktrees] List error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /api/worktrees ────────────────────────────────────────────────────

router.post('/', async (req: Request, res: Response) => {
  try {
    const { workspaceId, branchName, baseBranch, worktreePath } = req.body;

    if (!workspaceId || !branchName) {
      res.status(400).json({ error: 'Missing required fields: workspaceId, branchName' });
      return;
    }

    const workspace = getWorkspace(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const git = simpleGit(workspace.path);

    // Derive worktree path: {workspacePath}/../{repoName}-{branchSlug}
    const path = await import('path');
    const repoName = path.basename(workspace.path);
    const branchSlug = branchName.replace(/\//g, '-');
    const targetPath = worktreePath || path.resolve(workspace.path, '..', `${repoName}-${branchSlug}`);

    const base = baseBranch || 'HEAD';

    await git.raw(['worktree', 'add', '-b', branchName, targetPath, base]);

    emitWalEvent('worktree_created', workspaceId, { branchName, worktreePath: targetPath });

    res.status(201).json({ ok: true, worktreePath: targetPath, branchName });
  } catch (error: any) {
    if (error.message?.includes('already exists')) {
      res.status(409).json({ error: error.message });
      return;
    }
    console.error('[Worktrees] Create error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── DELETE /api/worktrees/:encodedPath?workspaceId=&force= ─────────────────

router.delete('/:encodedPath', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string;
    if (!workspaceId) {
      res.status(400).json({ error: 'Missing required query param: workspaceId' });
      return;
    }

    const workspace = getWorkspace(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const encodedPath = req.params.encodedPath as string;
    const decodedPath = decodeURIComponent(encodedPath);
    const force = req.query.force === 'true';
    const git = simpleGit(workspace.path);

    const args = ['worktree', 'remove', decodedPath];
    if (force) {
      args.push('--force');
    }

    await git.raw(args);

    emitWalEvent('worktree_removed', workspaceId, { worktreePath: decodedPath });

    res.json({ ok: true });
  } catch (error: any) {
    if (error.message?.includes('dirty') || error.message?.includes('untracked') || error.message?.includes('modified')) {
      res.status(409).json({ error: error.message });
      return;
    }
    console.error('[Worktrees] Remove error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /api/worktrees/merge ───────────────────────────────────────────────

router.post('/merge', async (req: Request, res: Response) => {
  try {
    const { workspaceId, branchName } = req.body;

    if (!workspaceId || !branchName) {
      res.status(400).json({ error: 'Missing required fields: workspaceId, branchName' });
      return;
    }

    const workspace = getWorkspace(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const git = simpleGit(workspace.path);
    await git.merge([branchName, '--no-ff']);

    emitWalEvent('worktree_merged', workspaceId, { branchName });

    res.json({ ok: true });
  } catch (error: any) {
    if (error.message?.includes('CONFLICT')) {
      res.status(409).json({ conflict: true, details: error.message });
      return;
    }
    console.error('[Worktrees] Merge error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /api/worktrees/status?workspaceId=&path= ──────────────────────────

router.get('/status', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string;
    const worktreePath = req.query.path as string;

    if (!workspaceId || !worktreePath) {
      res.status(400).json({ error: 'Missing required query params: workspaceId, path' });
      return;
    }

    const workspace = getWorkspace(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const git = simpleGit(worktreePath);
    const status = await git.status();

    res.json({
      branch: status.current,
      ahead: status.ahead,
      behind: status.behind,
      isClean: status.isClean(),
      modifiedFiles: status.modified,
    });
  } catch (error: any) {
    console.error('[Worktrees] Status error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
