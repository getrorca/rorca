import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { query, queryOne } from '../db/index';
import { getEffectiveUser } from '../lib/get-user';
import { logger } from '../lib/logger';

const router = Router();

/**
 * @swagger
 * /api/users/me:
 *   get:
 *     tags: [Users]
 *     summary: Get current user profile including plan
 *     operationId: getMe
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
    logger.error('[Users] Get me error:', error);
    res.status(500).json({ error: error.message });
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
    logger.error('[Users] Get assignments error:', error);
    res.status(500).json({ error: error.message });
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
      res.status(400).json({ error: 'Missing required query param: workspaceId' });
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
    logger.error('[Users] List workspace members error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
