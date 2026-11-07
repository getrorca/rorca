/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { query, queryOne } from '../db/index';
import { parsePaginationParams, paginateArray } from '../lib/paginate';
import { NotFoundError, ValidationError } from '../lib/errors';
import { handleRouteError } from '../lib/async-handler';

const router = Router();

// ─── Types ───────────────────────────────────────────────────────────────────

interface WorkspaceRow {
  id: string;
  label: string;
  path: string;
}

interface StorySearchResult {
  storyId: string;
  storyTitle: string;
  storyDescription: string;
  acceptanceCriteria: string[];
  specId: string;
  specTitle: string;
  specStatus: 'pending' | 'approved';
  workspaceId: string;
  workspaceName: string;
  tags: string[];
  matchSnippet?: string;
}

// ─── Helpers (mirrored from specs.ts to avoid cross-import) ─────────────────

function specsDirs(workspacePath: string) {
  const pendingDir = path.join(workspacePath, 'forge', 'specs', 'pending');
  const approvedDir = path.join(workspacePath, 'forge', 'specs', 'approved');
  return { pendingDir, approvedDir };
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }
}

async function getSpecTags(specId: string, workspaceId: string): Promise<string[]> {
  const rows = await query<{ tag_name: string }>(
    'SELECT tag_name FROM spec_tags WHERE spec_id = $1 AND workspace_id = $2 ORDER BY tag_name',
    [specId, workspaceId]
  );
  return rows.map(r => r.tag_name);
}

/**
 * @swagger
 * /api/stories/search:
 *   get:
 *     x-rorca-native-api: true
 *     x-rorca-rationale: "Intentional dashboard/native API operation; authenticated local-admin access only and never MCP-exposed by default."
 *     tags: [Stories]
 *     summary: Search stories across all specs
 *     operationId: searchStoriesAcrossSpecs
 *     description: Searches story titles, descriptions, and acceptance criteria across all specs in one or more workspaces.
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema: { type: string }
 *         description: Search query (matches title, description, acceptance criteria)
 *       - in: query
 *         name: workspaceId
 *         schema: { type: string }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [all, pending, approved], default: all }
 *       - in: query
 *         name: tags
 *         schema: { type: string }
 *         description: Comma-separated tag filter
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50, maximum: 200 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200:
 *         description: Search results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 items: { type: array, items: { type: object } }
 *                 total: { type: integer }
 *                 hasMore: { type: boolean }
 *       400: { description: "Missing q parameter" }
 */
router.get('/search', async (req: Request, res: Response) => {
  try {
    const q = (req.query.q as string || '').trim();
    const workspaceId = req.query.workspaceId as string | undefined;
    const statusFilter = (req.query.status as string) || 'all';
    const tagsParam = req.query.tags as string | undefined;
    const filterTags = tagsParam ? tagsParam.split(',').map(t => t.trim()).filter(Boolean) : [];

    if (!q) {
      throw new ValidationError('Missing required query param: q');
      return;
    }

    // Determine which workspaces to search
    let workspaces: WorkspaceRow[];
    if (workspaceId) {
      const ws = await queryOne<WorkspaceRow>('SELECT id, label, path FROM workspaces WHERE id = $1', [workspaceId]);
      if (!ws) {
        throw new NotFoundError('Workspace not found');
        return;
      }
      workspaces = [ws];
    } else {
      workspaces = await query<WorkspaceRow>('SELECT id, label, path FROM workspaces ORDER BY label', []);
    }

    const lowerQ = q.toLowerCase();
    const allResults: StorySearchResult[] = [];

    for (const ws of workspaces) {
      const { pendingDir, approvedDir } = specsDirs(ws.path);

      const dirsToScan: { dir: string; status: 'pending' | 'approved' }[] = [];
      if (statusFilter === 'all' || statusFilter === 'pending') {
        dirsToScan.push({ dir: pendingDir, status: 'pending' });
      }
      if (statusFilter === 'all' || statusFilter === 'approved') {
        dirsToScan.push({ dir: approvedDir, status: 'approved' });
      }

      for (const { dir, status } of dirsToScan) {
        for (const file of safeReaddir(dir)) {
          try {
            const filePath = path.join(dir, file);
            const raw = fs.readFileSync(filePath, 'utf8');
            const content = JSON.parse(raw);
            const specId = file.replace('.json', '');
            const specTitle = content.title ?? specId;
            const stories: any[] = Array.isArray(content.userStories) ? content.userStories : [];

            const specTags = await getSpecTags(specId, ws.id);

            // Apply tag filter at spec level
            if (filterTags.length > 0) {
              if (!filterTags.every(t => specTags.includes(t))) continue;
            }

            for (const story of stories) {
              const title: string = story.title ?? '';
              const description: string = story.description ?? '';
              const ac: string[] = Array.isArray(story.acceptanceCriteria) ? story.acceptanceCriteria : [];

              // Search across title, description, and acceptance criteria
              const titleMatch = title.toLowerCase().includes(lowerQ);
              const descMatch = description.toLowerCase().includes(lowerQ);
              const acMatch = ac.some(a => a.toLowerCase().includes(lowerQ));

              if (titleMatch || descMatch || acMatch) {
                // Generate a snippet showing the first match
                let matchSnippet: string | undefined;
                if (titleMatch) {
                  matchSnippet = title;
                } else if (descMatch) {
                  matchSnippet = description;
                } else {
                  matchSnippet = ac.find(a => a.toLowerCase().includes(lowerQ));
                }

                allResults.push({
                  storyId: story.id ?? '',
                  storyTitle: title,
                  storyDescription: description,
                  acceptanceCriteria: ac,
                  specId,
                  specTitle,
                  specStatus: status,
                  workspaceId: ws.id,
                  workspaceName: ws.label,
                  tags: specTags,
                  matchSnippet,
                });
              }
            }
          } catch {
            // skip unparseable spec files
          }
        }
      }
    }

    // Sort: title matches first, then description, then AC
    allResults.sort((a, b) => {
      const aTitle = a.storyTitle.toLowerCase().includes(lowerQ) ? 0 : 1;
      const bTitle = b.storyTitle.toLowerCase().includes(lowerQ) ? 0 : 1;
      if (aTitle !== bTitle) return aTitle - bTitle;
      const aDesc = a.storyDescription.toLowerCase().includes(lowerQ) ? 0 : 1;
      const bDesc = b.storyDescription.toLowerCase().includes(lowerQ) ? 0 : 1;
      return aDesc - bDesc;
    });

    // Paginate
    const pagination = parsePaginationParams(req, { limit: 50, maxLimit: 200 });
    res.json(paginateArray(allResults, pagination));
  } catch (error: any) {
    handleRouteError(res, error, '[Stories] Search');
  }
});

export default router;
