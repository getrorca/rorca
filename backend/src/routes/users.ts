import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { db } from '../db';
import type { AuthUser } from './auth';

const router = Router();

interface WorkspaceRow {
  id: string;
  label: string;
  path: string;
}

interface AssignmentDbRow {
  spec_id: string;
  story_id: string;
  workspace_id: string;
  assigned_at: string;
  workspace_label: string;
  workspace_path: string;
}

// ─── V2-042: GET /me/assigned — All specs and stories assigned to current user ──

router.get('/me/assigned', (req: Request, res: Response) => {
  try {
    const user = (req as Request & { user: AuthUser }).user;

    const rows = db.prepare(`
      SELECT sa.spec_id, sa.story_id, sa.workspace_id, sa.assigned_at,
             w.label AS workspace_label, w.path AS workspace_path
      FROM spec_assignments sa
      JOIN workspaces w ON w.id = sa.workspace_id
      WHERE sa.assignee_id = ?
      ORDER BY sa.assigned_at DESC
    `).all(user.id) as AssignmentDbRow[];

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
        const pendingFile = path.join(row.workspace_path, 'scripts', 'ralph', 'specs', 'pending', `${row.spec_id}.json`);
        const approvedFile = path.join(row.workspace_path, 'scripts', 'ralph', 'specs', 'approved', `${row.spec_id}.json`);
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
        const pendingFile = path.join(row.workspace_path, 'scripts', 'ralph', 'specs', 'pending', `${row.spec_id}.json`);
        const approvedFile = path.join(row.workspace_path, 'scripts', 'ralph', 'specs', 'approved', `${row.spec_id}.json`);
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
    console.error('[Users] Get assignments error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── V2-042: GET /workspace-members — List users available for assignment ──────

router.get('/workspace-members', (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string;
    if (!workspaceId) {
      res.status(400).json({ error: 'Missing required query param: workspaceId' });
      return;
    }

    // Return all users (in a team context this would filter by team membership)
    // For now, return all users in the system as potential assignees
    const users = db.prepare(
      'SELECT id, display_name, email, avatar_url FROM users ORDER BY display_name'
    ).all() as { id: string; display_name: string; email: string; avatar_url: string | null }[];

    res.json({
      members: users.map(u => ({
        id: u.id,
        displayName: u.display_name,
        email: u.email,
        avatarUrl: u.avatar_url,
      })),
    });
  } catch (error: any) {
    console.error('[Users] List workspace members error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
