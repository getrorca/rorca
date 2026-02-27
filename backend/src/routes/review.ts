import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { db } from '../db/index';
import { broadcastAll, type WalEvent } from '../lib/sse-hub';
import { getEffectiveUser } from '../lib/get-user';

// Two routers: one for spec-scoped endpoints (auth), one for public review access
const specReviewRouter = Router({ mergeParams: true });
const publicReviewRouter = Router();

// ─── Types ───────────────────────────────────────────────────────────────────

interface WorkspaceRow {
  id: string;
  label: string;
  path: string;
}

interface ReviewTokenRow {
  id: string;
  token_hash: string;
  spec_id: string;
  workspace_id: string;
  created_by: string | null;
  expires_at: string;
  created_at: string;
}

interface StoryCommentRow {
  id: string;
  spec_id: string;
  story_id: string;
  user_id: string | null;
  body: string;
  created_at: string;
  resolved_at: string | null;
  author_name: string | null;
  display_name: string | null;
  avatar_url: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function findSpecFile(workspacePath: string, specId: string): string | null {
  const pendingFile = path.join(workspacePath, 'forge', 'specs', 'pending', `${specId}.json`);
  const approvedFile = path.join(workspacePath, 'forge', 'specs', 'approved', `${specId}.json`);
  if (fs.existsSync(pendingFile)) return pendingFile;
  if (fs.existsSync(approvedFile)) return approvedFile;
  return null;
}

// ─── POST /api/specs/:specId/review-link ─────────────────────────────────────
// Mounted under /api/specs — generates a shareable review link

specReviewRouter.post('/:specId/review-link', (req: Request, res: Response) => {
  try {
    const specId = req.params.specId as string;
    const { workspaceId } = req.body;

    if (!workspaceId) {
      res.status(400).json({ error: 'workspaceId is required' });
      return;
    }

    const workspace = db.prepare('SELECT id, label, path FROM workspaces WHERE id = ?')
      .get(workspaceId) as WorkspaceRow | undefined;
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const specFile = findSpecFile(workspace.path, specId);
    if (!specFile) {
      res.status(404).json({ error: 'Spec not found' });
      return;
    }

    const user = getEffectiveUser(req);
    const rawToken = crypto.randomUUID();
    const tokenHash = hashToken(rawToken);
    const id = crypto.randomUUID();

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    db.prepare(`
      INSERT INTO review_tokens (id, token_hash, spec_id, workspace_id, created_by, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, tokenHash, specId, workspaceId, user?.id ?? null, expiresAt);

    // Emit WAL event
    const walResult = db.prepare(`
      INSERT INTO wal_events (ts, event_type, spec_id, workspace_id, actor, payload)
      VALUES (datetime('now'), 'review_link_created', ?, ?, ?, ?)
    `).run(specId, workspaceId, user?.email ?? 'system', JSON.stringify({ tokenId: id }));
    const walEvent = db.prepare('SELECT * FROM wal_events WHERE id = ?').get(
      walResult.lastInsertRowid
    ) as WalEvent;
    broadcastAll(walEvent);

    // Build URL from request origin
    const origin = req.headers.origin
      || req.headers.referer?.replace(/\/$/, '')
      || 'http://localhost:5210';
    const originUrl = new URL(origin);
    const baseUrl = `${originUrl.protocol}//${originUrl.host}`;

    res.status(201).json({
      url: `${baseUrl}/review/${rawToken}`,
      token: rawToken,
      expiresAt,
    });
  } catch (error: any) {
    console.error('[Review] Create link error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /api/review/:token — Public: fetch spec + comments ──────────────────

publicReviewRouter.get('/:token', (req: Request, res: Response) => {
  try {
    const token = req.params.token as string;
    const tokenHash = hashToken(token);

    const tokenRow = db.prepare(
      'SELECT * FROM review_tokens WHERE token_hash = ?'
    ).get(tokenHash) as ReviewTokenRow | undefined;

    if (!tokenRow) {
      res.status(404).json({ error: 'Invalid review link' });
      return;
    }

    if (new Date(tokenRow.expires_at) < new Date()) {
      res.status(410).json({ error: 'This review link has expired' });
      return;
    }

    const workspace = db.prepare('SELECT id, label, path FROM workspaces WHERE id = ?')
      .get(tokenRow.workspace_id) as WorkspaceRow | undefined;
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const specFile = findSpecFile(workspace.path, tokenRow.spec_id);
    if (!specFile) {
      res.status(404).json({ error: 'Spec not found' });
      return;
    }

    const specContent = JSON.parse(fs.readFileSync(specFile, 'utf8'));
    const stories = specContent.userStories ?? specContent.stories ?? [];

    const comments = db.prepare(`
      SELECT sc.id, sc.spec_id, sc.story_id, sc.user_id, sc.body,
             sc.created_at, sc.resolved_at, sc.author_name,
             u.display_name, u.avatar_url
      FROM story_comments sc
      LEFT JOIN users u ON u.id = sc.user_id
      WHERE sc.spec_id = ?
      ORDER BY sc.created_at ASC
    `).all(tokenRow.spec_id) as StoryCommentRow[];

    const commentsByStory: Record<string, StoryCommentRow[]> = {};
    for (const c of comments) {
      if (!commentsByStory[c.story_id]) commentsByStory[c.story_id] = [];
      commentsByStory[c.story_id].push(c);
    }

    res.json({
      specId: tokenRow.spec_id,
      title: specContent.title ?? tokenRow.spec_id,
      model: specContent.model,
      stories,
      commentsByStory,
      expiresAt: tokenRow.expires_at,
    });
  } catch (error: any) {
    console.error('[Review] Get spec error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /api/review/:token/comments — Public: add a guest comment ─────────

publicReviewRouter.post('/:token/comments', (req: Request, res: Response) => {
  try {
    const token = req.params.token as string;
    const { storyId, body, authorName } = req.body;
    const tokenHash = hashToken(token);

    if (!storyId || !body || typeof body !== 'string' || body.trim().length === 0) {
      res.status(400).json({ error: 'storyId and body are required' });
      return;
    }

    const tokenRow = db.prepare(
      'SELECT * FROM review_tokens WHERE token_hash = ?'
    ).get(tokenHash) as ReviewTokenRow | undefined;

    if (!tokenRow) {
      res.status(404).json({ error: 'Invalid review link' });
      return;
    }

    if (new Date(tokenRow.expires_at) < new Date()) {
      res.status(410).json({ error: 'This review link has expired' });
      return;
    }

    const id = crypto.randomUUID();
    const guestName = (authorName && typeof authorName === 'string' && authorName.trim())
      ? authorName.trim()
      : 'Guest';

    db.prepare(`
      INSERT INTO story_comments (id, spec_id, story_id, user_id, body, author_name)
      VALUES (?, ?, ?, NULL, ?, ?)
    `).run(id, tokenRow.spec_id, storyId, body.trim(), guestName);

    // Emit WAL event
    const walResult = db.prepare(`
      INSERT INTO wal_events (ts, event_type, spec_id, story_id, actor, payload)
      VALUES (datetime('now'), 'review_comment_added', ?, ?, ?, ?)
    `).run(tokenRow.spec_id, storyId, guestName, JSON.stringify({ commentId: id, authorName: guestName }));
    const walEvent = db.prepare('SELECT * FROM wal_events WHERE id = ?').get(
      walResult.lastInsertRowid
    ) as WalEvent;
    broadcastAll(walEvent);

    const comment = db.prepare(`
      SELECT id, spec_id, story_id, user_id, body, created_at, resolved_at, author_name
      FROM story_comments WHERE id = ?
    `).get(id) as {
      id: string;
      spec_id: string;
      story_id: string;
      user_id: string | null;
      body: string;
      created_at: string;
      resolved_at: string | null;
      author_name: string | null;
    };

    res.status(201).json({
      ...comment,
      display_name: guestName,
      avatar_url: null,
    });
  } catch (error: any) {
    console.error('[Review] Add comment error:', error);
    res.status(500).json({ error: error.message });
  }
});

export { specReviewRouter, publicReviewRouter };
export default publicReviewRouter;
