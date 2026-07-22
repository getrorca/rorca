/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router } from 'express';
import { queryOne } from '../db/index';
import { parsePaginationParams, paginateQuery } from '../lib/paginate';

const router = Router();

interface WalEventRow {
  id: number;
  ts: string;
  event_type: string;
  workspace_id: string | null;
  spec_id: string | null;
  story_id: string | null;
  actor: string;
  payload: string | null;
}

interface UserRow {
  display_name: string;
  email: string;
  avatar_url: string | null;
}

/** Map WAL event_type to human-friendly activity type */
function mapActivityType(eventType: string): string {
  const mapping: Record<string, string> = {
    generate: 'spec_created',
    spec_generated: 'spec_created',
    spec_approved: 'spec_approved',
    spec_rejected: 'spec_rejected',
    spec_forked: 'spec_edited',
    story_edited: 'spec_edited',
    direction_update: 'spec_edited',
    run_started: 'run_triggered',
    run_finished: 'run_completed',
    run_failed: 'run_completed',
    review_requested: 'spec_edited',
    review_approved: 'spec_approved',
    review_changes_requested: 'spec_rejected',
    story_comment_added: 'comment_added',
    terminal_session_started: 'terminal_session_started',
    terminal_session_ended: 'terminal_session_ended',
    team_invite_accepted: 'member_joined',
    user_registered: 'member_joined',
  };
  return mapping[eventType] || eventType;
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `Duration: ${minutes}m ${seconds}s`;
}

/** Generate human-readable description from a WAL event */
function describeEvent(event: WalEventRow, displayName: string): string {
  const actor = displayName || event.actor;
  let payload: Record<string, unknown> = {};
  if (event.payload) {
    try { payload = JSON.parse(event.payload); } catch { /* ignore */ }
  }

  const specLabel = (payload.title as string) || event.spec_id || 'a spec';
  const storyLabel = (payload.storyTitle as string) || event.story_id || 'a story';

  switch (event.event_type) {
    case 'generate':
    case 'spec_generated':
      return `${actor} created spec "${specLabel}"`;
    case 'spec_approved':
      return `${actor} approved spec "${specLabel}"`;
    case 'spec_rejected':
      return `${actor} rejected spec "${specLabel}"${payload.reason ? `: ${payload.reason}` : ''}`;
    case 'spec_forked':
      return `${actor} forked spec "${specLabel}"`;
    case 'run_started':
      return `${actor} triggered a pipeline run for "${specLabel}"`;
    case 'run_finished':
      return `${actor} completed pipeline run for "${specLabel}"`;
    case 'run_failed':
      return `${actor} pipeline run failed for "${specLabel}"`;
    case 'run_paused':
      return `${actor} paused pipeline run for "${specLabel}"`;
    case 'run_resumed':
      return `${actor} resumed pipeline run for "${specLabel}"`;
    case 'story_passed':
      return `Story "${storyLabel}" passed in "${specLabel}"`;
    case 'story_failed':
      return `Story "${storyLabel}" failed in "${specLabel}"`;
    case 'story_edited':
      return `${actor} edited story "${storyLabel}" in "${specLabel}"`;
    case 'story_comment_added':
      return `${actor} commented on story "${storyLabel}"`;
    case 'terminal_session_started':
      return 'Terminal session started';
    case 'terminal_session_ended': {
      const durationMs = typeof payload.durationMs === 'number' ? payload.durationMs : 0;
      return `Terminal session ended${durationMs > 0 ? ` • ${formatDuration(durationMs)}` : ''}`;
    }
    case 'review_requested':
      return `${actor} requested review for "${specLabel}"`;
    case 'review_approved':
      return `${actor} approved review for "${specLabel}"`;
    case 'review_changes_requested':
      return `${actor} requested changes on "${specLabel}"`;
    case 'direction_update':
      return `${actor} updated direction stack`;
    case 'team_created':
      return `${actor} created a team`;
    case 'team_invite_sent':
      return `${actor} sent a team invite`;
    case 'team_invite_accepted':
      return `${actor} joined the team`;
    case 'user_registered':
      return `${actor} registered`;
    case 'github_pr_merged':
      return `${actor} merged PR for "${specLabel}"`;
    case 'worktree_created':
      return `${actor} created a worktree for "${specLabel}"`;
    case 'worktree_merged':
      return `${actor} merged worktree for "${specLabel}"`;
    default:
      return `${actor} performed ${event.event_type.replace(/_/g, ' ')}`;
  }
}

/** Determine what the activity links to: spec, run, or story */
function getTarget(event: WalEventRow): { type: string; id: string } | null {
  let payload: Record<string, unknown> = {};
  if (event.payload) {
    try { payload = JSON.parse(event.payload); } catch { /* ignore */ }
  }

  if (event.story_id && event.spec_id) {
    return { type: 'story', id: `${event.spec_id}/${event.story_id}` };
  }

  const runEvents = ['run_started', 'run_finished', 'run_failed', 'run_paused', 'run_resumed'];
  if (runEvents.includes(event.event_type) && payload.runId) {
    return { type: 'run', id: String(payload.runId) };
  }

  if (event.spec_id) {
    return { type: 'spec', id: event.spec_id };
  }

  return null;
}

// Relevant event types for the activity feed (skip low-level noise like story_started, batch_progress, etc.)
const ACTIVITY_EVENT_TYPES = [
  'generate', 'spec_generated', 'spec_approved', 'spec_rejected', 'spec_forked',
  'run_started', 'run_finished', 'run_failed', 'run_paused', 'run_resumed',
  'story_passed', 'story_failed', 'story_edited',
  'story_comment_added',
  'terminal_session_started', 'terminal_session_ended',
  'review_requested', 'review_approved', 'review_changes_requested',
  'direction_update',
  'team_created', 'team_invite_sent', 'team_invite_accepted',
  'user_registered',
  'github_pr_merged',
  'worktree_created', 'worktree_merged',
];

/**
 * @swagger
 * /api/activity:
 *   get:
 *     x-rorca-native-api: true
 *     x-rorca-rationale: "Intentional dashboard/native API operation; authenticated local-admin access only and never MCP-exposed by default."
 *     tags: [Analytics]
 *     summary: Get paginated activity feed
 *     operationId: getActivityFeed
 *     description: |
 *       Returns a paginated list of activity events derived from WAL events, enriched with
 *       user display names and human-readable descriptions. Filters out low-level noise events
 *       (e.g., story_started, batch_progress). Supports cursor-based pagination.
 *     parameters:
 *       - in: query
 *         name: type
 *         schema: { type: string, enum: [spec_created, spec_approved, spec_rejected, spec_edited, run_triggered, run_completed, comment_added, member_joined] }
 *         description: Filter by activity category (mapped from underlying WAL event types)
 *       - in: query
 *         name: workspaceId
 *         schema: { type: string }
 *         description: Filter by workspace ID
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 30, maximum: 100 }
 *         description: Number of items per page (max 100)
 *       - in: query
 *         name: cursor
 *         schema: { type: string }
 *         description: Opaque cursor for next page (from previous response)
 *     responses:
 *       200:
 *         description: Paginated activity feed
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
 *                       id: { type: integer, description: "WAL event ID" }
 *                       timestamp: { type: string, description: "ISO 8601 event timestamp" }
 *                       activityType: { type: string, description: "Human-friendly activity category" }
 *                       rawEventType: { type: string, description: "Raw WAL event_type value" }
 *                       actor:
 *                         type: object
 *                         properties:
 *                           id: { type: string }
 *                           name: { type: string }
 *                           avatarUrl: { type: string, nullable: true }
 *                       target:
 *                         type: object
 *                         nullable: true
 *                         properties:
 *                           type: { type: string, enum: [spec, run, story] }
 *                           id: { type: string }
 *                       description: { type: string, description: "Human-readable action summary" }
 *                       workspaceId: { type: string, nullable: true }
 *                       specId: { type: string, nullable: true }
 *                       storyId: { type: string, nullable: true }
 *                 total: { type: integer }
 *                 hasMore: { type: boolean }
 *                 cursor: { type: string, nullable: true, description: "Pass as cursor param in next request" }
 */
router.get('/', async (req, res) => {
  const pagination = parsePaginationParams(req, { limit: 30, maxLimit: 100 });
  const typeFilter = req.query.type ? String(req.query.type) : null;
  const workspaceFilter = req.query.workspaceId ? String(req.query.workspaceId) : null;
  const fromFilter = req.query.from ? String(req.query.from) : null;

  // Build WHERE clause with numbered placeholders ($1, $2, ...)
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  // Filter to activity-relevant event types
  const placeholders = ACTIVITY_EVENT_TYPES.map((_, i) => `$${params.length + i + 1}`).join(',');
  conditions.push(`event_type IN (${placeholders})`);
  params.push(...ACTIVITY_EVENT_TYPES);

  if (typeFilter) {
    // Map activity type back to WAL event types
    const reverseMap: Record<string, string[]> = {
      spec_created: ['generate', 'spec_generated'],
      spec_approved: ['spec_approved', 'review_approved'],
      spec_rejected: ['spec_rejected', 'review_changes_requested'],
      spec_edited: ['spec_forked', 'story_edited', 'direction_update', 'review_requested'],
      run_triggered: ['run_started'],
      run_completed: ['run_finished', 'run_failed'],
      comment_added: ['story_comment_added'],
      member_joined: ['team_invite_accepted', 'user_registered'],
    };
    const walTypes = reverseMap[typeFilter];
    if (walTypes) {
      const fp = walTypes.map((_, i) => `$${params.length + i + 1}`).join(',');
      conditions.push(`event_type IN (${fp})`);
      params.push(...walTypes);
    }
  }

  if (workspaceFilter) {
    conditions.push(`workspace_id = $${params.length + 1}`);
    params.push(workspaceFilter);
  }

  if (fromFilter) {
    conditions.push(`ts >= $${params.length + 1}`);
    params.push(fromFilter);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await paginateQuery<WalEventRow>({
    query: `SELECT * FROM wal_events ${whereClause}`,
    countQuery: `SELECT COUNT(*)::int as total FROM wal_events ${whereClause}`,
    params,
    pagination,
    orderBy: 'id DESC',
    cursorColumn: 'id',
    cursorDirection: 'desc',
  });

  // Batch-fetch display names for all unique actors
  const actorIds = [...new Set(result.items.map(e => e.actor))];
  const userMap = new Map<string, UserRow>();
  for (const actorId of actorIds) {
    const user = await queryOne<UserRow>(
      'SELECT display_name, email, avatar_url FROM users WHERE id = $1 OR email = $2',
      [actorId, actorId]
    );
    if (user) {
      userMap.set(actorId, user);
    }
  }

  const items = result.items.map(event => {
    const user = userMap.get(event.actor);
    const displayName = user?.display_name || event.actor;
    return {
      id: event.id,
      timestamp: event.ts,
      activityType: mapActivityType(event.event_type),
      rawEventType: event.event_type,
      actor: {
        id: event.actor,
        name: displayName,
        avatarUrl: user?.avatar_url || null,
      },
      target: getTarget(event),
      description: describeEvent(event, displayName),
      workspaceId: event.workspace_id,
      specId: event.spec_id,
      storyId: event.story_id,
    };
  });

  res.json({
    items,
    total: result.total,
    hasMore: result.hasMore,
    cursor: result.cursor,
  });
});

export default router;
