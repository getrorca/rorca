/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { query, queryOne, execute } from '../db/index';
import { broadcastAll, type WalEvent } from '../lib/sse-hub';
import { getEffectiveUser } from '../lib/get-user';
import { handleRouteError } from '../lib/async-handler';
import { GoneError, NotFoundError, ValidationError } from '../lib/errors';
import { requireLocalOperatorBoundary } from '../lib/local-operator-boundary';
import { persistReviewComment, type PersistReviewCommentInput } from '../lib/review-comment-persistence';

const specReviewRouter = Router({ mergeParams: true, strict: true, caseSensitive: true });
const publicReviewRouter = Router({ strict: true, caseSensitive: true });
const operatorReviewRouter = Router({ strict: true, caseSensitive: true });
operatorReviewRouter.use(requireLocalOperatorBoundary);

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
  review_persona?: string | null;
  review_type?: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}
const REVIEW_IDENTIFIER = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,198}[a-zA-Z0-9_-])?$/;

function findSpecFile(workspacePath: string, specId: string): string | null {
  if (!REVIEW_IDENTIFIER.test(specId) || specId.includes('..')) return null;
  const pendingFile = path.join(workspacePath, 'forge', 'specs', 'pending', `${specId}.json`);
  const approvedFile = path.join(workspacePath, 'forge', 'specs', 'approved', `${specId}.json`);
  if (fs.existsSync(pendingFile)) return pendingFile;
  if (fs.existsSync(approvedFile)) return approvedFile;
  return null;
}

function routeReplayKey(req: Request, input: Omit<PersistReviewCommentInput, 'actorScope' | 'replayKey'>): string {
  const suppliedKey = req.get('Idempotency-Key')?.trim();
  if (suppliedKey !== undefined
    && (suppliedKey.length < 1 || suppliedKey.length > 200 || !/^[a-zA-Z0-9._:-]+$/.test(suppliedKey))) {
    throw new ValidationError('Idempotency-Key must contain 1-200 letters, numbers, dot, underscore, colon, or dash');
  }
  return suppliedKey ?? `semantic:${crypto.createHash('sha256').update(JSON.stringify([
    input.workspaceId, input.specId, input.storyId, input.body, input.authorName,
    input.reviewPersona, input.reviewType, 'add-review-comment',
  ])).digest('hex')}`;
}

async function resolveReviewWorkspaceId(specId: string, supplied: unknown): Promise<string> {
  if (typeof supplied === 'string' && supplied.trim()) {
    const workspace = await queryOne<WorkspaceRow>(
      'SELECT id, label, path FROM workspaces WHERE id = $1',
      [supplied.trim()],
    );
    if (!workspace || !findSpecFile(workspace.path, specId)) {
      throw new ValidationError('workspace_id does not contain the requested spec');
    }
    return workspace.id;
  }
  const workspaces = await query<WorkspaceRow>('SELECT id, label, path FROM workspaces ORDER BY id');
  const matches = workspaces.filter((workspace) => findSpecFile(workspace.path, specId));
  if (matches.length !== 1) {
    throw new ValidationError('workspace_id is required when the spec workspace cannot be inferred uniquely');
  }
  return matches[0].id;
}

// ─── POST /api/specs/:specId/review-link ─────────────────────────────────────
// Mounted under /api/specs — generates a shareable review link

/**
 * @swagger
 * /api/specs/{specId}/review-link:
 *   post:
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Authenticated local administrator creates a high-entropy external review capability; never MCP-callable."
 *     tags: [Specs]
 *     summary: Generate a shareable review link for a spec
 *     operationId: createSpecReviewLink
 *     description: Creates a time-limited (7-day) review token and returns a shareable URL that allows external reviewers to view the spec and leave comments without authentication.
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *         description: Spec slug ID (e.g., rorca-feature-enhancements)
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
 *                 description: Workspace ID that owns the spec
 *     responses:
 *       201:
 *         description: Review link created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 url: { type: string, description: "Full shareable URL with token embedded" }
 *                 token: { type: string, description: "Raw review token" }
 *                 expiresAt: { type: string, description: "ISO 8601 expiry timestamp (7 days from now)" }
 *       400: { description: "Missing workspaceId" }
 *       404: { description: "Workspace or spec not found" }
 */
specReviewRouter.post('/:specId/review-link', async (req: Request, res: Response) => {
  try {
    const specId = req.params.specId as string;
    const { workspaceId } = req.body;

    if (!workspaceId) {
      throw new ValidationError('workspaceId is required');
      return;
    }

    const workspace = await queryOne<WorkspaceRow>(
      'SELECT id, label, path FROM workspaces WHERE id = $1',
      [workspaceId]
    );
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const specFile = findSpecFile(workspace.path, specId);
    if (!specFile) {
      throw new NotFoundError('Spec not found');
      return;
    }

    const user = await getEffectiveUser(req);
    const rawToken = crypto.randomUUID();
    const tokenHash = hashToken(rawToken);
    const id = crypto.randomUUID();

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    await execute(
      `INSERT INTO review_tokens (id, token_hash, spec_id, workspace_id, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, tokenHash, specId, workspaceId, user?.id ?? null, expiresAt]
    );

    // Emit WAL event
    const walRow = await queryOne<WalEvent>(
      `INSERT INTO wal_events (ts, event_type, spec_id, workspace_id, actor, payload)
       VALUES (NOW(), 'review_link_created', $1, $2, $3, $4)
       RETURNING *`,
      [specId, workspaceId, user?.email ?? 'system', JSON.stringify({ tokenId: id })]
    );
    if (walRow) {
      broadcastAll(walRow);
    }

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
  } catch (error: unknown) {
    handleRouteError(res, error, '[Review] Create link');
  }
});

// ─── GET /api/review/:token — Public: fetch spec + comments ──────────────────

/**
 * @swagger
 * /api/review/{token}:
 *   get:
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Read-only access is bounded by an unguessable expiring review token and reveals only that token's spec review projection."
 *     tags: [Review]
 *     summary: Get spec content and comments via review token
 *     operationId: getReviewSpec
 *     description: Public endpoint — validates the review token, loads the spec JSON from disk, and returns spec content with all story comments grouped by story ID. No authentication required.
 *     parameters:
 *       - in: path
 *         name: token
 *         required: true
 *         schema: { type: string }
 *         description: Raw review token (from the generated review link URL)
 *     responses:
 *       200:
 *         description: Spec content and comments
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 specId: { type: string }
 *                 title: { type: string }
 *                 model: { type: string }
 *                 stories:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       title: { type: string }
 *                       description: { type: string }
 *                       acceptanceCriteria: { type: array, items: { type: string } }
 *                       passes: { type: boolean }
 *                 commentsByStory:
 *                   type: object
 *                   description: Map of storyId → array of comment objects
 *                   additionalProperties:
 *                     type: array
 *                     items:
 *                       type: object
 *                       properties:
 *                         id: { type: string }
 *                         body: { type: string }
 *                         author_name: { type: string, nullable: true }
 *                         display_name: { type: string, nullable: true }
 *                         created_at: { type: string }
 *                 expiresAt: { type: string, description: "ISO 8601 expiry timestamp" }
 *       404: { description: "Invalid review token" }
 *       410: { description: "Review link has expired" }
 */
publicReviewRouter.get('/:token', async (req: Request, res: Response) => {
  try {
    const token = req.params.token as string;
    const tokenHash = hashToken(token);

    const tokenRow = await queryOne<ReviewTokenRow>(
      'SELECT * FROM review_tokens WHERE token_hash = $1',
      [tokenHash]
    );

    if (!tokenRow) {
      throw new NotFoundError('Invalid review link');
      return;
    }

    if (new Date(tokenRow.expires_at) < new Date()) {
      throw new GoneError('This review link has expired');
      return;
    }

    const workspace = await queryOne<WorkspaceRow>(
      'SELECT id, label, path FROM workspaces WHERE id = $1',
      [tokenRow.workspace_id]
    );
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const specFile = findSpecFile(workspace.path, tokenRow.spec_id);
    if (!specFile) {
      throw new NotFoundError('Spec not found');
      return;
    }

    const specContent = JSON.parse(fs.readFileSync(specFile, 'utf8'));
    const stories = specContent.userStories ?? specContent.stories ?? [];

    const comments = await query<StoryCommentRow>(
      `SELECT sc.id, sc.spec_id, sc.story_id, sc.user_id, sc.body,
             sc.created_at, sc.resolved_at, sc.author_name,
             u.display_name, u.avatar_url
      FROM story_comments sc
      LEFT JOIN users u ON u.id = sc.user_id
      WHERE sc.spec_id = $1
      ORDER BY sc.created_at ASC`,
      [tokenRow.spec_id]
    );

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
  } catch (error: unknown) {
    handleRouteError(res, error, '[Review] Get spec');
  }
});

// ─── POST /api/review/:token/comments — Public: add a guest comment ─────────

/**
 * @swagger
 * /api/review/{token}/comments:
 *   post:
 *     x-rorca-tier: public
 *     x-rorca-rationale: "A high-entropy expiring review token authorizes a bounded guest comment; origin, CSRF, replay protection, and rate limits apply."
 *     tags: [Review]
 *     summary: Add a guest comment via review token
 *     operationId: addReviewComment
 *     description: Public endpoint — validates the review token and inserts a guest comment on a specific story. No authentication required. Emits a WAL event for the comment.
 *     parameters:
 *       - in: path
 *         name: token
 *         required: true
 *         schema: { type: string }
 *         description: Raw review token
 *       - in: header
 *         name: Idempotency-Key
 *         required: false
 *         schema: { type: string, maxLength: 200 }
 *         description: Stable caller replay key; omitted clients receive deterministic semantic replay protection.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [storyId, body]
 *             properties:
 *               storyId: { type: string, description: "Story ID (e.g., US-001)" }
 *               body: { type: string, description: "Comment text (non-empty)" }
 *               authorName: { type: string, description: "Optional guest display name (defaults to 'Guest')" }
 *     responses:
 *       201:
 *         description: Comment created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string }
 *                 spec_id: { type: string }
 *                 story_id: { type: string }
 *                 body: { type: string }
 *                 author_name: { type: string }
 *                 display_name: { type: string }
 *                 created_at: { type: string }
 *       400: { description: "Missing storyId or body" }
 *       404: { description: "Invalid review token" }
 *       410: { description: "Review link has expired" }
 */
publicReviewRouter.post('/:token/comments', async (req: Request, res: Response) => {
  try {
    const token = req.params.token as string;
    const { storyId, body, authorName } = req.body;
    const tokenHash = hashToken(token);

    if (typeof storyId !== 'string' || !REVIEW_IDENTIFIER.test(storyId) || storyId.includes('..')
      || typeof body !== 'string' || body.trim().length === 0) {
      throw new ValidationError('A valid storyId and non-empty body are required');
    }

    const tokenRow = await queryOne<ReviewTokenRow>(
      'SELECT * FROM review_tokens WHERE token_hash = $1',
      [tokenHash]
    );

    if (!tokenRow) {
      throw new NotFoundError('Invalid review link');
      return;
    }

    if (new Date(tokenRow.expires_at) < new Date()) {
      throw new GoneError('This review link has expired');
      return;
    }

    const guestName = (authorName && typeof authorName === 'string' && authorName.trim())
      ? authorName.trim()
      : 'Guest';
    if (guestName.length > 200 || body.trim().length > 100_000 || String(storyId).length > 200) {
      throw new ValidationError('Review comment fields exceed their allowed size');
    }
    const persistence = {
      workspaceId: tokenRow.workspace_id,
      specId: tokenRow.spec_id,
      storyId: String(storyId),
      body: body.trim(),
      authorName: guestName,
      reviewPersona: null,
      reviewType: null,
    };
    const { comment, replayed } = await persistReviewComment({
      ...persistence,
      actorScope: 'guest',
      replayKey: routeReplayKey(req, persistence),
    });

    if (!replayed) {
      const walRow = await queryOne<WalEvent>(
        `INSERT INTO wal_events (ts, event_type, spec_id, story_id, actor, payload)
         VALUES (NOW(), 'review_comment_added', $1, $2, $3, $4)
         RETURNING *`,
        [tokenRow.spec_id, storyId, guestName, JSON.stringify({ commentId: comment.id, authorName: guestName })],
      );
      if (walRow) broadcastAll(walRow);
    }

    res.status(replayed ? 200 : 201).json({
      ...comment,
      display_name: guestName,
      avatar_url: null,
      replayed,
    });
  } catch (error: unknown) {
    handleRouteError(res, error, '[Review] Add comment');
  }
});

// ─── POST /api/review/comment — explicit local-operator review comment ────────
// Execution children persist through the canonical DB helper instead of
// inheriting this human operator capability.

/**
 * @swagger
 * /api/review/comment:
 *   post:
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Local human operator-only review mutation; authenticated, CSRF-protected, rate-limited, capability-gated, and replay-safe."
 *     tags: [Review]
 *     summary: Store an explicit local-operator review comment
 *     operationId: addInternalReviewComment
 *     description: Local human operator endpoint for replay-safe persona review results. Execution children write through the canonical scoped DB helper and cannot exercise this operator capability.
 *     parameters:
 *       - in: header
 *         name: Idempotency-Key
 *         required: false
 *         schema: { type: string, maxLength: 200 }
 *         description: Stable caller replay key; when omitted, normalized review semantics provide deterministic replay protection.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [spec_id, story_id, body]
 *             properties:
 *               spec_id: { type: string, description: "Spec slug ID" }
 *               workspace_id: { type: string, description: "Workspace ID; inferred only when the spec exists in exactly one workspace" }
 *               story_id: { type: string, description: "Story ID (e.g., US-001)" }
 *               body: { type: string, description: "Review comment text" }
 *               author_name: { type: string, description: "Persona display name (e.g., 'Security Reviewer')" }
 *               review_persona: { type: string, description: "Persona identifier (e.g., 'security', 'red-team')" }
 *               review_type: { type: string, description: "Review type (e.g., 'adversarial', 'compliance')" }
 *     responses:
 *       201:
 *         description: Review comment stored
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string }
 *                 spec_id: { type: string }
 *                 story_id: { type: string }
 *                 author_name: { type: string }
 *                 review_persona: { type: string, nullable: true }
 *                 review_type: { type: string, nullable: true }
 *       400: { description: "Missing spec_id, story_id, or body" }
 */
operatorReviewRouter.post('/comment', async (req: Request, res: Response) => {
  try {
    const {
      workspace_id,
      spec_id,
      story_id,
      body,
      author_name,
      review_persona,
      review_type,
    } = req.body as Record<string, unknown>;
    if (typeof spec_id !== 'string' || !spec_id.trim()
      || typeof story_id !== 'string' || !story_id.trim()
      || typeof body !== 'string' || !body.trim()) {
      throw new ValidationError('spec_id, story_id, and body are required');
    }
    if (!REVIEW_IDENTIFIER.test(spec_id) || spec_id.includes('..')
      || !REVIEW_IDENTIFIER.test(story_id) || story_id.includes('..')) {
      throw new ValidationError('spec_id or story_id contains an invalid identifier');
    }
    if ((author_name != null && typeof author_name !== 'string')
      || (review_persona != null && typeof review_persona !== 'string')
      || (review_type != null && typeof review_type !== 'string')) {
      throw new ValidationError('Review actor and classification fields must be strings');
    }
    const displayName = typeof author_name === 'string' && author_name.trim()
      ? author_name.trim()
      : 'Review Agent';
    const normalizedBody = body.trim();
    if (spec_id.length > 200 || story_id.length > 200 || normalizedBody.length > 100_000
      || displayName.length > 200 || String(review_persona ?? '').length > 200
      || String(review_type ?? '').length > 200) {
      throw new ValidationError('Review comment fields exceed their allowed size');
    }
    const workspaceId = await resolveReviewWorkspaceId(spec_id, workspace_id);
    const persistence = {
      workspaceId,
      specId: spec_id,
      storyId: story_id,
      body: normalizedBody,
      authorName: displayName,
      reviewPersona: typeof review_persona === 'string' && review_persona ? review_persona : null,
      reviewType: typeof review_type === 'string' && review_type ? review_type : null,
    };
    const { comment, replayed } = await persistReviewComment({
      ...persistence,
      actorScope: 'operator',
      replayKey: routeReplayKey(req, persistence),
    });
    res.status(replayed ? 200 : 201).json({
      ...comment,
      workspace_id: workspaceId,
      replayed,
    });
  } catch (error: unknown) {
    handleRouteError(res, error, '[Review] Internal comment');
  }
});

export { specReviewRouter, publicReviewRouter, operatorReviewRouter };
export default publicReviewRouter;
