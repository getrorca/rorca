/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { query, queryOne, execute, transaction } from '../db/index';
import { getEffectiveUser } from '../lib/get-user';
import { logger } from '../lib/logger';
import { ValidationError, AuthError, ConflictError } from '../lib/errors';
import { handleRouteError } from '../lib/async-handler';
import { validateBody } from '../lib/validate';
import { authRequired } from '../lib/auth-utils';
import { supabaseAdmin } from '../lib/supabase';

const router = Router();

/**
 * @swagger
 * /api/users/me:
 *   get:
 *     tags: [Users]
 *     summary: Get current user profile including plan
 *     operationId: getMe
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Current-user identity and plan metadata are user-owned account information and should require authenticated access."
 *     description: Returns the current user's profile including their plan tier (free/solo/pro/team). Falls back to the first registered user when auth is bypassed (local single-user mode).
 *     responses:
 *       200:
 *         description: Current user
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string }
 *                 email: { type: string }
 *                 displayName: { type: string }
 *                 plan: { type: string, enum: [free, solo, pro, team] }
 *                 emailVerified: { type: boolean }
 *                 avatarUrl: { type: string, nullable: true }
 *       404:
 *         description: No user found (empty database)
 */
router.get('/me', async (req: Request, res: Response) => {
  try {
    const user = await getEffectiveUser(req);
    if (!user) {
      res.status(404).json({ error: 'No user found' });
      return;
    }

    const row = await queryOne<{
      id: string;
      email: string;
      display_name: string;
      plan: string;
      email_verified_at: string | null;
      avatar_url: string | null;
    }>('SELECT id, email, display_name, plan, email_verified_at, avatar_url FROM users WHERE id = $1', [user.id]);

    if (!row) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      plan: row.plan ?? 'free',
      emailVerified: row.email_verified_at !== null,
      avatarUrl: row.avatar_url ?? null,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Users] Get me');
  }
});

const deleteMeSchema = z.object({
  confirmation: z.string().min(1),
});

/**
 * @swagger
 * /api/users/me:
 *   delete:
 *     tags: [Users]
 *     summary: Delete current Supabase user account
 *     operationId: deleteCurrentUser
 *     description: Permanently deletes the authenticated user's account via the Supabase Admin API. Confirmation must match DELETE or the user's email.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [confirmation]
 *             properties:
 *               confirmation:
 *                 type: string
 *     responses:
 *       200:
 *         description: Account deleted
 *       400:
 *         description: Invalid confirmation
 *       401:
 *         description: Not authenticated
 */
router.delete('/me', authRequired, async (req: Request, res: Response) => {
  try {
    const authReq = req as Request & { user?: { id: string; email?: string | null; supabaseId?: string | null } };
    const parsed = deleteMeSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Validation failed', {
        details: JSON.stringify(parsed.error.issues),
      });
    }
    const { confirmation } = parsed.data;

    if (!authReq.user?.supabaseId || !authReq.user.email) {
      throw new AuthError('Authentication required');
    }

    if (confirmation !== 'DELETE' && confirmation !== authReq.user.email) {
      throw new ValidationError('Confirmation must match DELETE or your email address');
    }

    const { error } = await supabaseAdmin.auth.admin.deleteUser(authReq.user.supabaseId);

    if (error) {
      throw new ConflictError(error.message);
    }

    res.json({ message: 'Account deleted successfully' });
  } catch (error: any) {
    handleRouteError(res, error, '[Users] Delete me');
  }
});

interface AssignmentDbRow {
  spec_id: string;
  story_id: string;
  workspace_id: string;
  assigned_at: string;
  workspace_label: string;
  workspace_path: string;
}

/**
 * @swagger
 * /api/users/me/assigned:
 *   get:
 *     tags: [Users]
 *     summary: Get specs and stories assigned to the current user
 *     operationId: getMyAssignments
 *     description: Returns all specs and stories assigned to the authenticated user, grouped by spec and enriched with titles from the filesystem.
 *     responses:
 *       200:
 *         description: List of assignments
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 assignments:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       specId: { type: string }
 *                       specName: { type: string }
 *                       workspaceId: { type: string }
 *                       workspaceLabel: { type: string }
 *                       assignedAt: { type: string }
 *                       assignedStories:
 *                         type: array
 *                         items:
 *                           type: object
 *                           properties:
 *                             storyId: { type: string }
 *                             storyTitle: { type: string }
 *                             assignedAt: { type: string }
 */
router.get('/me/assigned', async (req: Request, res: Response) => {
  try {
    const user = await getEffectiveUser(req);
    if (!user) { res.json({ assignments: [] }); return; }

    const rows = await query<AssignmentDbRow>(
      `SELECT sa.spec_id, sa.story_id, sa.workspace_id, sa.assigned_at,
             w.label AS workspace_label, w.path AS workspace_path
      FROM spec_assignments sa
      JOIN workspaces w ON w.id = sa.workspace_id
      WHERE sa.assignee_id = $1
      ORDER BY sa.assigned_at DESC`,
      [user.id],
    );

    // Group by spec and enrich with spec titles from filesystem
    const specMap = new Map<string, {
      specId: string;
      specName: string;
      workspaceId: string;
      workspaceLabel: string;
      assignedAt: string;
      assignedStories: { storyId: string; storyTitle: string; assignedAt: string }[];
    }>();

    for (const row of rows) {
      const key = `${row.workspace_id}:${row.spec_id}`;

      if (!specMap.has(key)) {
        // Try to read spec title from file
        let specName = row.spec_id;
        const pendingFile = path.join(row.workspace_path, 'forge', 'specs', 'pending', `${row.spec_id}.json`);
        const approvedFile = path.join(row.workspace_path, 'forge', 'specs', 'approved', `${row.spec_id}.json`);
        try {
          const filePath = fs.existsSync(pendingFile) ? pendingFile : approvedFile;
          if (fs.existsSync(filePath)) {
            const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            specName = content.title ?? row.spec_id;
          }
        } catch {
          // Keep slug as name
        }

        specMap.set(key, {
          specId: row.spec_id,
          specName,
          workspaceId: row.workspace_id,
          workspaceLabel: row.workspace_label,
          assignedAt: row.assigned_at,
          assignedStories: [],
        });
      }

      const entry = specMap.get(key)!;

      if (row.story_id && row.story_id !== '') {
        // Resolve story title
        let storyTitle = row.story_id;
        const pendingFile = path.join(row.workspace_path, 'forge', 'specs', 'pending', `${row.spec_id}.json`);
        const approvedFile = path.join(row.workspace_path, 'forge', 'specs', 'approved', `${row.spec_id}.json`);
        try {
          const filePath = fs.existsSync(pendingFile) ? pendingFile : approvedFile;
          if (fs.existsSync(filePath)) {
            const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            const stories = content.userStories ?? [];
            const story = stories.find((s: { id: string; title?: string }) => s.id === row.story_id);
            if (story?.title) storyTitle = story.title;
          }
        } catch {
          // Keep ID as title
        }

        entry.assignedStories.push({
          storyId: row.story_id,
          storyTitle,
          assignedAt: row.assigned_at,
        });
      }
    }

    res.json({ assignments: Array.from(specMap.values()) });
  } catch (error: any) {
    handleRouteError(res, error, '[Users] Get assignments');
  }
});

/**
 * @swagger
 * /api/users/workspace-members:
 *   get:
 *     tags: [Users]
 *     summary: List users available for story assignment
 *     operationId: listWorkspaceMembers
 *     description: Returns all users in the system who can be assigned to stories in the specified workspace. In a team context this would filter by team membership.
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: List of members
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 members:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       displayName: { type: string }
 *                       email: { type: string }
 *                       avatarUrl: { type: string, nullable: true }
 *       400:
 *         description: Missing workspaceId query parameter
 */
router.get('/workspace-members', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string;
    if (!workspaceId) {
      throw new ValidationError('Missing required query param: workspaceId');
      return;
    }

    // Return all users (in a team context this would filter by team membership)
    // For now, return all users in the system as potential assignees
    const users = await query<{ id: string; display_name: string; email: string; avatar_url: string | null }>(
      'SELECT id, display_name, email, avatar_url FROM users ORDER BY display_name',
    );

    res.json({
      members: users.map(u => ({
        id: u.id,
        displayName: u.display_name,
        email: u.email,
        avatarUrl: u.avatar_url,
      })),
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Users] List workspace members');
  }
});

/**
 * @swagger
 * /api/users/me:
 *   delete:
 *     tags: [Users]
 *     summary: Permanently delete user account
 *     operationId: deleteMyAccount
 *     description: |
 *       Hard-deletes personal data (vault_keys, github_connections,
 *       notification_subscriptions, notification_history, billing).
 *       Anonymizes operational records (pipeline_runs.triggered_by → 'deleted_user',
 *       story_comments.user_id → NULL). Requires password confirmation.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [confirmation]
 *             properties:
 *               confirmation: { type: string, example: delete my account }
 *     responses:
 *       200: { description: Account deleted }
 *       400: { description: Confirmation text required }
 *       409: { description: Active pipeline run prevents deletion }
 */
const deleteBodySchema = z.object({
  confirmation: z.string().trim().min(1, 'Confirmation is required'),
});

router.delete('/me', validateBody(deleteBodySchema), async (req: Request, res: Response) => {
  const { confirmation } = req.body as z.infer<typeof deleteBodySchema>;
  if (confirmation.toLowerCase() !== 'delete my account') {
    throw new ValidationError('Confirmation must be exactly "delete my account"');
  }

  // Identify user — route-level auth since global auth is bypassed
  const effectiveUser = await getEffectiveUser(req);
  if (!effectiveUser) {
    throw new AuthError('Authentication required');
  }
  const userId = effectiveUser.id;

  const user = await queryOne<{ id: string; email: string }>(
    'SELECT id, email FROM users WHERE id = $1',
    [userId],
  );
  if (!user) {
    throw new AuthError('Authentication required');
  }

  // Block deletion if any pipeline run is active for user's workspaces
  const activeRun = await queryOne<{ id: number }>(
    `SELECT id FROM pipeline_runs
     WHERE status = 'running'
       AND workspace_id IN (SELECT id FROM workspaces WHERE owner_id = $1)
     LIMIT 1`,
    [userId],
  );
  if (activeRun) {
    throw new ConflictError(
      'Cannot delete account while a pipeline run is active. Cancel all running pipelines first.',
    );
  }

  // Emit WAL event before deletion (audit trail)
  await execute(
    "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('account_deleted', '', $1)",
    [JSON.stringify({ userId: user.id, email: user.email, deletedAt: new Date().toISOString() })],
  );

  await transaction(async (client) => {
    // Anonymize operational records BEFORE user delete (avoids FK violations)
    await client.query(
      `UPDATE pipeline_runs SET triggered_by = 'deleted_user'
       WHERE workspace_id IN (SELECT id FROM workspaces WHERE owner_id = $1)`,
      [userId],
    );
    await client.query(
      'UPDATE story_comments SET user_id = NULL WHERE user_id = $1',
      [userId],
    );

    // Hard-delete personal data (child tables first, respecting FK order)
    // Most have ON DELETE CASCADE, but explicit deletion ensures completeness
    // and works even if FK cascades are changed later.
    await client.query('DELETE FROM api_key_vault WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM github_connections WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM notification_subscriptions WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM notification_history WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM subscriptions WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM user_settings WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM integration_credentials WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM provider_defaults WHERE user_id = $1', [userId]);

    // Delete the user row last — CASCADE handles any remaining FKs
    await client.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  logger.info(`[Users] Account deleted: ${user.email} (id: ${userId}). Personal data removed, operational records anonymized.`);

  res.json({ message: 'Your account has been deleted.' });
});

export default router;
