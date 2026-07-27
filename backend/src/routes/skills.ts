/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * skills.ts — Agent Skills CRUD routes.
 *
 * SK-001: GET /api/skills — list discovered + installed skills
 *         POST /api/skills/install — install a skill from content
 *         DELETE /api/skills/:name — remove an installed skill
 * SK-004: POST /api/skills/install-from-sh — install via skills.sh CLI
 *         GET /api/skills/suggestions — echolocation-based skill suggestions
 *         POST /api/skills/search — proxy to skills.sh search API
 */

import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { query, queryOne } from '../db/index';
import { SkillRegistry, inferCategory, isSkillSelectable } from '../lib/skill-registry';
import { echolocate, inferSkillsFromStack, STACK_TO_SKILLS } from '../lib/workspace-echolocation';
import { broadcastAll, type WalEvent } from '../lib/sse-hub';
import { NotFoundError, TooManyRequestsError, ValidationError } from '../lib/errors';
import { handleRouteError } from '../lib/async-handler';
import { githubRateLimiter } from '../lib/github-rate-limiter';

const router = Router();

/**
 * Resolve the workspace path from optional query param or first registered workspace.
 */
async function resolveWorkspacePath(req: Request): Promise<string | null> {
  const workspaceId = req.query.workspaceId as string | undefined;
  if (workspaceId) {
    const ws = await queryOne<{ path: string }>('SELECT path FROM workspaces WHERE id = $1', [workspaceId]);
    return ws?.path ?? null;
  }
  // Default: first registered workspace
  const first = await queryOne<{ path: string }>('SELECT path FROM workspaces ORDER BY id LIMIT 1');
  return first?.path ?? null;
}

/**
 * Resolve workspace ID from query/body param or first registered workspace.
 */
async function resolveWorkspaceId(req: Request): Promise<string | null> {
  const workspaceId = (req.query.workspaceId || req.body?.workspaceId) as string | undefined;
  if (workspaceId) return workspaceId;
  const first = await queryOne<{ id: string }>('SELECT id FROM workspaces ORDER BY id LIMIT 1');
  return first?.id ?? null;
}

/**
 * Emit a WAL event for skill operations and broadcast via SSE hub.
 */
async function emitSkillWalEvent(eventType: string, workspaceId: string | null, payload: Record<string, unknown>): Promise<void> {
  const row = await queryOne<{ id: number; ts: string }>(
    'INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ($1, $2, $3) RETURNING id, ts',
    [eventType, workspaceId, JSON.stringify(payload)]
  );
  const walEvent: WalEvent = {
    id: row!.id,
    ts: row!.ts,
    event_type: eventType,
    workspace_id: workspaceId,
    spec_id: null,
    story_id: null,
    actor: '',
    payload: JSON.stringify(payload),
  };
  broadcastAll(walEvent);
}

/**
 * @swagger
 * /api/skills:
 *   get:
 *     x-rorca-native-api: true
 *     x-rorca-rationale: "Intentional dashboard/native API operation; authenticated local-admin access only and never MCP-exposed by default."
 *     tags: [Skills]
 *     summary: List all discovered and installed skills
 *     operationId: listSkills
 *     description: Scans the workspace for skill files and merges with DB-persisted installed skills, returning metadata and a prompt-ready catalog.
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         schema:
 *           type: string
 *         description: Optional workspace ID to scan skills from. Defaults to first workspace.
 *     responses:
 *       200:
 *         description: List of skills with metadata
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 skills:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                       description:
 *                         type: string
 *                       source:
 *                         type: string
 *                       filePath:
 *                         type: string
 *                       identity:
 *                         type: string
 *                       packageRoot:
 *                         type: string
 *                       relativePath:
 *                         type: string
 *                       format:
 *                         type: string
 *                         enum: [agent-skill-package, legacy-flat, database]
 *                       selectors:
 *                         type: object
 *                         description: Advisory deterministic phase/artifact/risk eligibility metadata.
 *                 warnings:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       filePath:
 *                         type: string
 *                       reason:
 *                         type: string
 *                 catalog:
 *                   type: string
 *                   description: Compact name:description list for LLM prompt injection
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const registry = new SkillRegistry();
    const workspacePath = await resolveWorkspacePath(req);

    if (workspacePath) {
      await registry.discover(workspacePath);
    } else {
      // No workspace — only return DB-persisted skills
      const dbSkills = await query<{
        name: string;
        description: string;
        source: string;
        content: string;
        category: string | null;
        tags: string | null;
      }>('SELECT name, description, source, content, category, tags FROM installed_skills');
      // Manual load into registry is not needed — discover() handles DB merge.
      // But with no workspace path we just return DB skills directly.
      res.json({
        skills: dbSkills.map(s => {
          let parsedTags: string[] = [];
          if (s.tags) { try { parsedTags = JSON.parse(s.tags); } catch { /* ignore */ } }
          return {
            name: s.name,
            description: s.description,
            source: s.source,
            filePath: '',
            category: s.category || inferCategory(s.name, s.description),
            tags: parsedTags,
            identity: `db:${s.name.toLowerCase()}`,
            packageRoot: '',
            discoveryRoot: '',
            relativePath: '',
            format: 'database',
          };
        }),
        warnings: [],
        catalog: dbSkills.map(s => `${s.name}: ${s.description}`).join('\n'),
      });
      return;
    }

    const skills = registry.getAll();
    res.json({
      skills: skills.map(s => ({
        name: s.metadata.name,
        description: s.metadata.description,
        source: s.source,
        filePath: s.source === 'engineering-canon' ? `@rorca/engineering-canon/skills/${s.relativePath}` : s.filePath,
        category: s.metadata.category || inferCategory(s.metadata.name, s.metadata.description),
        tags: s.metadata.tags || [],
        identity: s.identity,
        packageRoot: s.source === 'engineering-canon' ? '@rorca/engineering-canon/skills' : s.packageRoot,
        discoveryRoot: s.source === 'engineering-canon' ? '@rorca/engineering-canon/skills' : s.discoveryRoot,
        relativePath: s.relativePath,
        format: s.format,
        selectors: s.metadata.selectors,
        governance: s.governance ?? { status: 'active', legacyCompatible: true },
        selectable: isSkillSelectable(s),
      })),
      warnings: registry.getWarnings(),
      catalog: registry.getCatalogForPrompt(),
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Skills] List');
  }
});

/**
 * @swagger
 * /api/skills/install:
 *   post:
 *     x-rorca-native-api: true
 *     x-rorca-native-authority: local-admin
 *     x-rorca-rationale: "Dashboard-only local-administrator skill installation; excluded from autonomous/MCP exposure and protected by the native human-authority gate."
 *     tags: [Skills]
 *     summary: Install a skill from markdown content
 *     operationId: installSkill
 *     description: Persists a new skill from the provided markdown content with optional YAML frontmatter into the installed_skills table.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, content]
 *             properties:
 *               name:
 *                 type: string
 *                 description: Skill name (overridden by frontmatter name if present)
 *               content:
 *                 type: string
 *                 description: Full markdown content (with optional YAML frontmatter)
 *               source:
 *                 type: string
 *                 description: Source label (default 'user')
 *     responses:
 *       201:
 *         description: Skill installed
 *       400:
 *         description: Missing required fields
 */
router.post('/install', async (req: Request, res: Response) => {
  try {
    const { name, content, source } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      throw new ValidationError('name is required');
      return;
    }
    if (!content || typeof content !== 'string') {
      throw new ValidationError('content is required');
      return;
    }

    const registry = new SkillRegistry();
    const skill = await registry.install(name.trim(), content, source || 'user');

    const wsId = await resolveWorkspaceId(req);
    await emitSkillWalEvent('skill_installed', wsId, {
      name: skill.metadata.name,
      source: skill.source,
      workspace_id: wsId,
    });

    res.status(201).json({
      name: skill.metadata.name,
      description: skill.metadata.description,
      source: skill.source,
      category: skill.metadata.category,
      tags: skill.metadata.tags || [],
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Skills] Install');
  }
});

/**
 * @swagger
 * /api/skills/top:
 *   get:
 *     x-rorca-native-api: true
 *     x-rorca-rationale: "Intentional dashboard/native API operation; authenticated local-admin access only and never MCP-exposed by default."
 *     tags: [Skills]
 *     summary: Get top skills from skills.sh ranked by install count
 *     operationId: getTopSkills
 *     description: |
 *       Proxies the skills.sh top skills endpoint and returns results mapped to
 *       the standard SkillResult shape with an additional installs field.
 *       Results are sorted by install count descending.
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: number
 *           default: 50
 *         description: Maximum number of results (default 50, max 100)
 *     responses:
 *       200:
 *         description: Top skills sorted by installs descending
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 results:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                       description:
 *                         type: string
 *                       author:
 *                         type: string
 *                       url:
 *                         type: string
 *                       installs:
 *                         type: number
 *                 total:
 *                   type: number
 *       502:
 *         description: skills.sh API unavailable or returned an error
 *       504:
 *         description: Upstream request timed out
 */
router.get('/top', async (req: Request, res: Response) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);

  // skills.sh requires q >= 2 chars — fan out across common seeds and merge
  const SEED_QUERIES = ['js', 'py', 'ts', 'go', 'css', 'api', 'db', 'git', 'react', 'test'];
  const perSeed = Math.ceil(limit / 3);

  const fetchSeed = async (q: string): Promise<any[]> => {
    try {
      const url = `https://skills.sh/api/search?q=${encodeURIComponent(q)}&limit=${perSeed}`;
      const r = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5_000),
      });
      if (!r.ok) return [];
      const d = await r.json().catch(() => null) as Record<string, unknown> | null;
      if (!d) return [];
      return Array.isArray((d as Record<string, unknown>)?.skills) ? (d as Record<string, unknown[]>).skills
        : Array.isArray((d as Record<string, unknown>)?.results) ? (d as Record<string, unknown[]>).results
        : Array.isArray(d) ? d : [];
    } catch {
      return [];
    }
  };

  const batches = await Promise.all(SEED_QUERIES.slice(0, 5).map(fetchSeed));
  const seen = new Set<string>();
  const merged: any[] = [];
  for (const batch of batches) {
    for (const r of batch) {
      const key = (r.name || r.skillId || r.slug || '').toLowerCase();
      if (key && !seen.has(key)) { seen.add(key); merged.push(r); }
    }
  }

  const results = merged
    .map((r: any) => ({
      name: r.name || r.skillId || r.slug || '',
      description: r.description || r.summary || '',
      author: r.author || r.owner || r.source || '',
      url: r.url || r.homepage || '',
      installs: typeof r.installs === 'number' ? r.installs : 0,
    }))
    .filter(r => r.name)
    .sort((a, b) => b.installs - a.installs)
    .slice(0, limit);

  res.json({ results, total: results.length });
});

/**
 * @swagger
 * /api/skills/preview:
 *   get:
 *     x-rorca-native-api: true
 *     x-rorca-rationale: "Intentional dashboard/native API operation; authenticated local-admin access only and never MCP-exposed by default."
 *     tags: [Skills]
 *     summary: Preview a skill from skills.sh without installing
 *     operationId: previewSkill
 *     description: |
 *       Searches skills.sh for the query and returns the SKILL.md content
 *       fetched from GitHub. Does NOT install the skill — preview only.
 *     parameters:
 *       - in: query
 *         name: query
 *         required: true
 *         schema:
 *           type: string
 *         description: Skill name or search query (e.g. "react", "node")
 *     responses:
 *       200:
 *         description: Skill content preview
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 name:
 *                   type: string
 *                 content:
 *                   type: string
 *                 description:
 *                   type: string
 *                 source:
 *                   type: string
 *                 skillId:
 *                   type: string
 *                 wordCount:
 *                   type: number
 *                 estimatedTokens:
 *                   type: number
 *       400:
 *         description: Missing query
 *       404:
 *         description: Skill not found in registry
 */
router.get('/preview', async (req: Request, res: Response) => {
  try {
    const query = (req.query.query as string || '').trim().replace(/\.md$/i, '');
    if (!query) {
      throw new ValidationError('query is required');
      return;
    }

    const result = await fetchSkillFromRegistry(query);
    if (!result) {
      throw new NotFoundError(`No skill found for "${query}" in skills.sh`);
      return;
    }

    const wordCount = result.content.split(/\s+/).filter(Boolean).length;
    res.json({
      name: result.name,
      content: result.content,
      description: result.description,
      source: result.source,
      skillId: result.skillId,
      wordCount,
      estimatedTokens: Math.ceil(wordCount * 1.3),
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Skills] preview');
  }
});

/**
 * @swagger
 * /api/skills/{name}/content:
 *   get:
 *     x-rorca-native-api: true
 *     x-rorca-rationale: "Intentional dashboard/native API operation; authenticated local-admin access only and never MCP-exposed by default."
 *     tags: [Skills]
 *     summary: Get full markdown content for a skill
 *     operationId: getSkillContent
 *     description: |
 *       Returns the full markdown content for a skill. Resolution order:
 *       1) SkillRegistry.getSkill(name) — reads file content from filePath
 *       2) Fallback: SELECT content FROM installed_skills WHERE LOWER(name) = LOWER(?)
 *       3) 404 if not found
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Skill name to retrieve content for
 *       - in: query
 *         name: workspaceId
 *         schema:
 *           type: string
 *         description: Optional workspace ID for filesystem skill discovery. Defaults to first workspace.
 *     responses:
 *       200:
 *         description: Full skill content with metadata
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 name:
 *                   type: string
 *                 content:
 *                   type: string
 *                 description:
 *                   type: string
 *                 wordCount:
 *                   type: number
 *                 estimatedTokens:
 *                   type: number
 *       404:
 *         description: Skill not found
 */
router.get('/:name/content', async (req: Request, res: Response) => {
  try {
    const name = req.params.name as string;
    const registry = new SkillRegistry();
    const wsPath = await resolveWorkspacePath(req);

    // 1) Try filesystem via SkillRegistry
    if (wsPath) {
      await registry.discover(wsPath);
    }
    const skill = registry.getSkill(name);

    if (skill) {
      // Registry content was read from the exact canonical entrypoint under an
      // allowed root. Never reconstruct or re-follow a mutable path here.
      const content = skill.rawContent ?? skill.promptText;
      const wordCount = content.split(/\s+/).filter(Boolean).length;
      res.json({
        name: skill.metadata.name,
        content,
        description: skill.metadata.description,
        identity: skill.identity,
        filePath: skill.source === 'engineering-canon' ? `@rorca/engineering-canon/skills/${skill.relativePath}` : skill.filePath,
        packageRoot: skill.source === 'engineering-canon' ? '@rorca/engineering-canon/skills' : skill.packageRoot,
        relativePath: skill.relativePath,
        format: skill.format,
        governance: skill.governance ?? { status: 'active', legacyCompatible: true },
        selectable: isSkillSelectable(skill),
        wordCount,
        estimatedTokens: Math.ceil(wordCount * 1.3),
      });
      return;
    }

    // 2) Fallback: DB lookup
    const dbSkill = await queryOne<{ name: string; description: string; content: string }>(
      'SELECT name, description, content FROM installed_skills WHERE LOWER(name) = LOWER($1)',
      [name]
    );

    if (dbSkill) {
      const wordCount = dbSkill.content.split(/\s+/).filter(Boolean).length;
      res.json({
        name: dbSkill.name,
        content: dbSkill.content,
        description: dbSkill.description,
        wordCount,
        estimatedTokens: Math.ceil(wordCount * 1.3),
      });
      return;
    }

    // 3) Not found
    throw new NotFoundError(`Skill "${name}" not found`);
  } catch (error: any) {
    handleRouteError(res, error, '[Skills] Content');
  }
});

/**
 * @swagger
 * /api/skills/{name}:
 *   delete:
 *     x-rorca-native-api: true
 *     x-rorca-rationale: "Intentional dashboard/native API operation; authenticated local-admin access only and never MCP-exposed by default."
 *     tags: [Skills]
 *     summary: Remove an installed skill by name
 *     operationId: removeSkill
 *     description: Deletes the specified skill from the installed_skills table by name.
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Skill name to remove
 *     responses:
 *       200:
 *         description: Skill removed
 *       404:
 *         description: Skill not found in installed_skills table
 */
router.delete('/:name', async (req: Request, res: Response) => {
  try {
    const name = req.params.name as string;
    const registry = new SkillRegistry();
    const wsId = await resolveWorkspaceId(req);
    const workspace = wsId ? await queryOne<{ path: string }>('SELECT path FROM workspaces WHERE id = $1', [wsId]) : null;
    if (workspace) registry.discoverFilesystem(workspace.path);
    const fsPaths = registry.getCandidates(name)
      .filter(skill => skill.filePath && (skill.source === 'rorca-skills' || skill.source === 'claude-skills'))
      .map(skill => skill.filePath);
    const removedFromDb = await registry.remove(name);

    // Remove only exact validated entrypoints. Package references/assets/scripts
    // are deliberately left intact for explicit operator cleanup.
    let removedFromFs = false;
    for (const filePath of new Set(fsPaths)) {
      try { fs.unlinkSync(filePath); removedFromFs = true; } catch { /* absent or concurrently removed */ }
    }

    if (!removedFromDb && !removedFromFs) {
      res.status(404).json({ error: `Skill "${name}" not found in installed skills`, code: 'NOT_FOUND' });
      return;
    }

    await emitSkillWalEvent('skill_removed', wsId, {
      name,
      workspace_id: wsId,
    });

    res.json({ removed: true, name });
  } catch (error: any) {
    handleRouteError(res, error, '[Skills] Remove');
  }
});

/** Parse YAML frontmatter from markdown content. Returns null if no frontmatter. */
function parseFrontmatter(content: string): { yaml: string; body: string } | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  return { yaml: match[1], body: match[2] };
}

/**
 * Search skills.sh for a query, then fetch the SKILL.md content from GitHub.
 * Returns the content + metadata of the best matching skill, or null.
 */
async function fetchSkillFromRegistry(query: string): Promise<{
  content: string;
  name: string;
  description: string;
  source: string;
  skillId: string;
} | null> {
  // 1. Search skills.sh
  const searchUrl = `https://skills.sh/api/search?q=${encodeURIComponent(query)}&limit=5`;
  let results: { skillId: string; source: string; name: string }[] = [];
  try {
    const resp = await fetch(searchUrl, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return null;
    const data: any = await resp.json();
    results = Array.isArray(data?.skills) ? data.skills : Array.isArray(data?.results) ? data.results : [];
  } catch {
    return null;
  }
  if (results.length === 0) return null;

  // 2. For each result, try to fetch SKILL.md from GitHub
  for (const result of results) {
    const { source, skillId } = result;
    if (!source || !skillId) continue;

    // Try common URL patterns
    const candidates = [
      `https://raw.githubusercontent.com/${source}/main/skills/${skillId}/SKILL.md`,
      `https://raw.githubusercontent.com/${source}/main/${skillId}/SKILL.md`,
      `https://raw.githubusercontent.com/${source}/refs/heads/main/skills/${skillId}/SKILL.md`,
    ];

    for (const url of candidates) {
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (resp.ok) {
          const content = await resp.text();
          // Parse frontmatter for metadata
          let description = '';
          let resolvedName = skillId;
          const parsed = parseFrontmatter(content);
          if (parsed) {
            try {
              const meta = yaml.load(parsed.yaml) as Record<string, unknown> | null;
              if (meta && typeof meta === 'object') {
                if (typeof meta['name'] === 'string') resolvedName = meta['name'];
                if (typeof meta['description'] === 'string') description = meta['description'];
              }
            } catch { /* use defaults */ }
          }
          return { content, name: resolvedName, description, source: `github:${source}`, skillId };
        }
      } catch { /* try next */ }
    }

    // Fallback: use GitHub tree API to find the right SKILL.md path
    try {
      const treeUrl = `https://api.github.com/repos/${source}/git/trees/HEAD?recursive=1`;
      const treeResp = await githubRateLimiter.execute(() =>
        fetch(treeUrl, { signal: AbortSignal.timeout(10_000) }),
      );
      if (treeResp.ok) {
        const tree: any = await treeResp.json();
        const skillFiles: string[] = (tree.tree || [])
          .filter((f: any) => f.type === 'blob' && f.path.endsWith('/SKILL.md'))
          .map((f: any) => f.path);

        for (const filePath of skillFiles) {
          const url = `https://raw.githubusercontent.com/${source}/main/${filePath}`;
          try {
            const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
            if (!resp.ok) continue;
            const content = await resp.text();
            const parsed = parseFrontmatter(content);
            if (parsed) {
              try {
                const meta = yaml.load(parsed.yaml) as Record<string, unknown> | null;
                if (meta && typeof meta === 'object' && meta['name'] === skillId) {
                  const description = typeof meta['description'] === 'string' ? meta['description'] : '';
                  return { content, name: skillId, description, source: `github:${source}`, skillId };
                }
              } catch { /* skip */ }
            }
          } catch { /* skip */ }
        }
      }
    } catch { /* skip to next result */ }
  }

  return null;
}

/**
 * @swagger
 * /api/skills/install-from-sh:
 *   post:
 *     x-rorca-native-api: true
 *     x-rorca-native-authority: local-admin
 *     x-rorca-rationale: "Dashboard-only local-administrator skill installation; excluded from autonomous/MCP exposure and protected by the native human-authority gate."
 *     tags: [Skills]
 *     summary: Install a skill from the skills.sh registry via HTTP
 *     operationId: installSkillFromSh
 *     description: |
 *       Fetches a skill's SKILL.md directly from GitHub (anthropics/skills, then
 *       vercel-labs/skills), saves to `.rorca/skills/` and `.claude/skills/`,
 *       and registers it in the DB. No CLI dependency required.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name:
 *                 type: string
 *                 description: Skill name to install from skills.sh registry
 *               workspaceId:
 *                 type: string
 *                 description: Workspace ID to install skill into. Defaults to first workspace.
 *     responses:
 *       201:
 *         description: Skill installed successfully
 *       400:
 *         description: Missing skill name or no workspace
 *       404:
 *         description: Skill not found in any registry
 *       502:
 *         description: Network error fetching skill
 */
router.post('/install-from-sh', async (req: Request, res: Response) => {
  try {
    const { name, workspaceId } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      throw new ValidationError('name is required');
      return;
    }

    // Strip .md extension if present (suggestions pass "react.md")
    const queryStr = name.trim().replace(/\.md$/i, '').toLowerCase();

    // Resolve workspace path
    let wsPath: string | undefined;
    if (workspaceId) {
      const ws = await queryOne<{ path: string }>('SELECT path FROM workspaces WHERE id = $1', [workspaceId]);
      wsPath = ws?.path;
    } else {
      const ws = await queryOne<{ path: string }>('SELECT path FROM workspaces ORDER BY id LIMIT 1');
      wsPath = ws?.path;
    }

    if (!wsPath) {
      throw new ValidationError('No workspace found');
      return;
    }

    // Search skills.sh and fetch content from GitHub
    const result = await fetchSkillFromRegistry(queryStr);
    if (!result) {
      throw new NotFoundError(`No skill found for "${queryStr}" in skills.sh registry`);
      return;
    }

    const skillName = queryStr.replace(/[^a-z0-9-]/g, '-');

    // Save to both .rorca/skills/ and .claude/skills/
    const rorcaSkillsDir = path.join(wsPath, '.rorca', 'skills');
    const claudeSkillsDir = path.join(wsPath, '.claude', 'skills');
    fs.mkdirSync(rorcaSkillsDir, { recursive: true });
    fs.mkdirSync(claudeSkillsDir, { recursive: true });

    const rorcaPath = path.join(rorcaSkillsDir, `${skillName}.md`);
    const claudePath = path.join(claudeSkillsDir, `${skillName}.md`);
    fs.writeFileSync(rorcaPath, result.content, 'utf-8');
    fs.writeFileSync(claudePath, result.content, 'utf-8');

    // Register in DB
    const registry = new SkillRegistry();
    await registry.install(skillName, result.content, result.source);

    const wsId = await resolveWorkspaceId(req);
    await emitSkillWalEvent('skill_installed', wsId, {
      name: skillName,
      source: result.source,
      skillId: result.skillId,
      workspace_id: wsId,
    });

    res.status(201).json({
      name: result.name,
      description: result.description,
      source: result.source,
      skillId: result.skillId,
      filePath: rorcaPath,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Skills] install-from-sh');
  }
});

/**
 * @swagger
 * /api/skills/suggestions:
 *   get:
 *     x-rorca-native-api: true
 *     x-rorca-rationale: "Intentional dashboard/native API operation; authenticated local-admin access only and never MCP-exposed by default."
 *     tags: [Skills]
 *     summary: Get skill suggestions based on workspace stack detection
 *     operationId: getSkillSuggestions
 *     description: |
 *       Runs workspace echolocation to detect the tech stack, then maps detected
 *       technologies to suggested skill files via the STACK_TO_SKILLS mapping.
 *       Returns both the inferred skill filenames and which stack items triggered them.
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         schema:
 *           type: string
 *         description: Workspace ID to analyze. Defaults to first workspace.
 *     responses:
 *       200:
 *         description: Skill suggestions based on detected stack
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 suggestions:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       skill:
 *                         type: string
 *                         description: Suggested skill filename (e.g. react.md)
 *                       triggeredBy:
 *                         type: array
 *                         items:
 *                           type: string
 *                         description: Stack items that triggered this suggestion
 *                       installed:
 *                         type: boolean
 *                         description: Whether this skill is already installed
 *                 stack:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                       version:
 *                         type: string
 *                       source:
 *                         type: string
 *                 monorepoApps:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                       path:
 *                         type: string
 *                       inferredSkills:
 *                         type: array
 *                         items:
 *                           type: string
 *       400:
 *         description: No workspace found
 */
router.get('/suggestions', async (req: Request, res: Response) => {
  try {
    const wsPath = await resolveWorkspacePath(req);
    if (!wsPath) {
      throw new ValidationError('No workspace found');
      return;
    }

    // Run echolocation
    const report = echolocate(wsPath);

    // Infer skills from stack
    const inferredSkills = inferSkillsFromStack(report.stack);

    // Build a reverse map: skill → which stack items triggered it
    const skillTriggers: Record<string, string[]> = {};
    for (const item of report.stack) {
      const mapped = STACK_TO_SKILLS[item.name];
      if (mapped) {
        for (const s of mapped) {
          if (!skillTriggers[s]) skillTriggers[s] = [];
          if (!skillTriggers[s].includes(item.name)) {
            skillTriggers[s].push(item.name);
          }
        }
      }
    }

    // Check which skills are already installed (filesystem + DB)
    const registry = new SkillRegistry();
    await registry.discover(wsPath);
    const installedNames = new Set(registry.getAll().map(s => s.metadata.name.toLowerCase()));

    // Build suggestions
    const suggestions = inferredSkills.map(skill => ({
      skill,
      triggeredBy: skillTriggers[skill] || [],
      installed: installedNames.has(path.basename(skill, '.md').toLowerCase()),
    }));

    // Include monorepo per-app skill inference if applicable
    const monorepoApps = report.monorepo.detected
      ? report.monorepo.apps.map(app => ({
          name: app.name,
          path: app.path,
          inferredSkills: app.inferredSkills,
        }))
      : [];

    res.json({
      suggestions,
      stack: report.stack,
      monorepoApps,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Skills] suggestions');
  }
});

/**
 * @swagger
 * /api/skills/search:
 *   post:
 *     x-rorca-native-api: true
 *     x-rorca-rationale: "Intentional dashboard/native API operation; authenticated local-admin access only and never MCP-exposed by default."
 *     tags: [Skills]
 *     summary: Search the skills.sh marketplace
 *     operationId: searchSkillsSh
 *     description: |
 *       Proxies a search query to the skills.sh search API for marketplace browsing.
 *       Returns matching skills with metadata from the skills.sh registry.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [query]
 *             properties:
 *               query:
 *                 type: string
 *                 description: Search query string
 *               limit:
 *                 type: number
 *                 description: Maximum results to return (default 20)
 *     responses:
 *       200:
 *         description: Search results from skills.sh
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 results:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                       description:
 *                         type: string
 *                       author:
 *                         type: string
 *                       url:
 *                         type: string
 *                 query:
 *                   type: string
 *                 total:
 *                   type: number
 *       400:
 *         description: Missing query
 *       502:
 *         description: skills.sh API unavailable
 */
router.post('/search', async (req: Request, res: Response) => {
  try {
    const { query: searchQuery, limit } = req.body;

    if (!searchQuery || typeof searchQuery !== 'string' || !searchQuery.trim()) {
      throw new ValidationError('query is required');
      return;
    }

    const trimmedQuery = searchQuery.trim();
    if (trimmedQuery.length < 2) {
      throw new ValidationError('query must be at least 2 characters');
    }

    const searchLimit = typeof limit === 'number' && limit > 0 ? Math.min(limit, 100) : 20;

    // Proxy to skills.sh search API
    const searchUrl = new URL('https://skills.sh/api/search');
    searchUrl.searchParams.set('q', trimmedQuery);
    searchUrl.searchParams.set('limit', String(searchLimit));

    let response: globalThis.Response;
    try {
      response = await fetch(searchUrl.toString(), {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (fetchErr: any) {
      res.status(502).json({
        error: 'skills.sh API unavailable',
        detail: fetchErr.message || 'Network error',
      });
      return;
    }

    if (!response.ok) {
      res.status(502).json({
        error: `skills.sh API returned ${response.status}`,
        detail: await response.text().catch(() => ''),
      });
      return;
    }

    const data: any = await response.json();

    // Normalize the response — skills.sh may return different shapes
    const results = Array.isArray(data?.results)
      ? data.results
      : Array.isArray(data?.skills)
        ? data.skills
        : Array.isArray(data)
          ? data
          : [];

    res.json({
      results: Array.from(
        new Map(
          results.slice(0, searchLimit).map((r: any) => {
            const name = r.name || r.slug || '';
            return [name.toLowerCase(), {
              name,
              description: r.description || r.summary || '',
              author: r.author || r.owner || '',
              url: r.url || r.homepage || '',
            }];
          }),
        ).values(),
      ).filter((r: any) => r.name),
      query: trimmedQuery,
      total: data?.total ?? results.length,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Skills] search');
  }
});

/**
 * Parse a GitHub repo URL or shorthand into owner/repo.
 * Accepted formats:
 *  - 'https://github.com/owner/repo'
 *  - 'https://github.com/owner/repo/tree/main'
 *  - 'https://github.com/owner/repo.git'
 *  - 'owner/repo'
 */
function parseGitHubRepo(repoUrl: string): { owner: string; repo: string } | null {
  let cleaned = repoUrl.trim();
  // Strip protocol + github.com prefix
  cleaned = cleaned.replace(/^https?:\/\/(www\.)?github\.com\//, '');
  // Strip .git suffix
  cleaned = cleaned.replace(/\.git$/, '');
  // Strip /tree/... suffix
  cleaned = cleaned.replace(/\/tree\/.*$/, '');
  // Strip trailing slashes
  cleaned = cleaned.replace(/\/+$/, '');

  const parts = cleaned.split('/');
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], repo: parts[1] };
}

/**
 * @swagger
 * /api/skills/browse-github:
 *   post:
 *     x-rorca-native-api: true
 *     x-rorca-rationale: "Intentional dashboard/native API operation; authenticated local-admin access only and never MCP-exposed by default."
 *     tags: [Skills]
 *     summary: Browse SKILL.md files in a GitHub repository
 *     operationId: browseGitHubSkills
 *     description: |
 *       Lists all SKILL.md files found in a GitHub repository tree.
 *       Fetches each file's YAML frontmatter for name and description.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [repoUrl]
 *             properties:
 *               repoUrl:
 *                 type: string
 *                 description: "GitHub URL or shorthand (e.g. 'wojons/skills' or 'https://github.com/wojons/skills')"
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         schema:
 *           type: string
 *         description: Workspace ID for checking installed status. Defaults to first workspace.
 *     responses:
 *       200:
 *         description: List of SKILL.md files in the repo
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 repo:
 *                   type: string
 *                 branch:
 *                   type: string
 *                 skills:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                       description:
 *                         type: string
 *                       path:
 *                         type: string
 *                       installed:
 *                         type: boolean
 *       400:
 *         description: Invalid repository URL
 *       404:
 *         description: Repository not found
 *       429:
 *         description: GitHub API rate limit exceeded
 *       502:
 *         description: GitHub API unavailable
 */
router.post('/browse-github', async (req: Request, res: Response) => {
  try {
    const { repoUrl } = req.body;
    if (!repoUrl || typeof repoUrl !== 'string' || !repoUrl.trim()) {
      throw new ValidationError('Invalid repository URL');
      return;
    }

    const parsed = parseGitHubRepo(repoUrl);
    if (!parsed) {
      throw new ValidationError('Invalid repository URL');
      return;
    }
    const { owner, repo } = parsed;

    // Fetch repo tree
    const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`;
    let treeData: any;
    try {
      const treeResp = await githubRateLimiter.execute(() =>
        fetch(treeUrl, {
          headers: { Accept: 'application/vnd.github+json' },
          signal: AbortSignal.timeout(15_000),
        }),
      );
      if (treeResp.status === 404) {
        throw new NotFoundError('Repository not found');
        return;
      }
      if (treeResp.status === 403) {
        throw new TooManyRequestsError('GitHub API rate limit exceeded. Try again later or add a GitHub token in Settings.');
        return;
      }
      if (!treeResp.ok) {
        res.status(502).json({ error: 'GitHub API unavailable' });
        return;
      }
      treeData = await treeResp.json();
    } catch (err: any) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        res.status(502).json({ error: 'GitHub API unavailable' });
        return;
      }
      throw err;
    }

    // Filter for SKILL.md files at any depth (pattern: */SKILL.md)
    const skillPaths: string[] = (treeData.tree || [])
      .filter((f: any) => f.type === 'blob' && f.path.endsWith('/SKILL.md'))
      .map((f: any) => f.path);

    // Build installed set for checking
    const wsPath = await resolveWorkspacePath(req);
    const installedNames = new Set<string>();
    if (wsPath) {
      const registry = new SkillRegistry();
      await registry.discover(wsPath);
      for (const s of registry.getAll()) {
        installedNames.add(s.metadata.name.toLowerCase());
      }
    }

    // Determine branch — try main first, fall back to master
    let branch = 'main';

    // Fetch frontmatter for each SKILL.md (parallel, capped at 30 to avoid flooding)
    const skills: Array<{ name: string; description: string; path: string; installed: boolean }> = [];
    const batchSize = 30;
    const toFetch = skillPaths.slice(0, batchSize);

    const fetchResults = await Promise.allSettled(
      toFetch.map(async (skillPath) => {
        // Try main branch first
        let content: string | null = null;
        let usedBranch = 'main';
        const mainUrl = `https://raw.githubusercontent.com/${owner}/${repo}/main/${skillPath}`;
        try {
          const resp = await fetch(mainUrl, { signal: AbortSignal.timeout(10_000) });
          if (resp.ok) {
            content = await resp.text();
          }
        } catch { /* try master */ }

        if (!content) {
          const masterUrl = `https://raw.githubusercontent.com/${owner}/${repo}/master/${skillPath}`;
          try {
            const resp = await fetch(masterUrl, { signal: AbortSignal.timeout(10_000) });
            if (resp.ok) {
              content = await resp.text();
              usedBranch = 'master';
            }
          } catch { /* skip */ }
        }

        if (!content) return null;

        // Update branch if we found master works
        if (usedBranch === 'master') branch = 'master';

        // Parse frontmatter
        let name = '';
        let description = '';
        const fm = parseFrontmatter(content);
        if (fm) {
          try {
            const meta = yaml.load(fm.yaml) as Record<string, unknown> | null;
            if (meta && typeof meta === 'object') {
              if (typeof meta['name'] === 'string') name = meta['name'];
              if (typeof meta['description'] === 'string') description = meta['description'];
            }
          } catch { /* use defaults */ }
        }

        // Derive name from directory if frontmatter has none
        if (!name) {
          const parts = skillPath.split('/');
          name = parts.length >= 2 ? parts[parts.length - 2] : skillPath;
        }

        return {
          name,
          description,
          path: skillPath,
          installed: installedNames.has(name.toLowerCase()),
        };
      })
    );

    for (const result of fetchResults) {
      if (result.status === 'fulfilled' && result.value) {
        skills.push(result.value);
      }
    }

    res.json({
      repo: `${owner}/${repo}`,
      branch,
      skills,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Skills] browse-github');
  }
});

/**
 * @swagger
 * /api/skills/install-from-github:
 *   post:
 *     x-rorca-native-api: true
 *     x-rorca-native-authority: local-admin
 *     x-rorca-rationale: "Dashboard-only local-administrator skill installation; excluded from autonomous/MCP exposure and protected by the native human-authority gate."
 *     tags: [Skills]
 *     summary: Install a skill from a GitHub repository by path
 *     operationId: installSkillFromGitHub
 *     description: |
 *       Fetches a specific SKILL.md from a GitHub repository and installs it
 *       using the SkillRegistry with dual-save to .rorca/skills/ and .claude/skills/.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [repoUrl, skillPath]
 *             properties:
 *               repoUrl:
 *                 type: string
 *                 description: "GitHub URL or shorthand (e.g. 'wojons/skills')"
 *               skillPath:
 *                 type: string
 *                 description: "Path within the repo (e.g. 'skills/react/SKILL.md')"
 *               workspaceId:
 *                 type: string
 *                 description: Workspace ID to install into. Defaults to first workspace.
 *     responses:
 *       201:
 *         description: Skill installed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 name:
 *                   type: string
 *                 description:
 *                   type: string
 *                 source:
 *                   type: string
 *                 filePath:
 *                   type: string
 *       400:
 *         description: Missing repoUrl or skillPath
 *       404:
 *         description: Skill file not found at path
 */
router.post('/install-from-github', async (req: Request, res: Response) => {
  try {
    const { repoUrl, skillPath, workspaceId } = req.body;

    if (!repoUrl || typeof repoUrl !== 'string' || !repoUrl.trim()) {
      throw new ValidationError('repoUrl is required');
      return;
    }
    if (!skillPath || typeof skillPath !== 'string' || !skillPath.trim()) {
      throw new ValidationError('skillPath is required');
      return;
    }

    const parsed = parseGitHubRepo(repoUrl);
    if (!parsed) {
      throw new ValidationError('Invalid repository URL');
      return;
    }
    const { owner, repo } = parsed;

    // Resolve workspace
    let wsPath: string | undefined;
    if (workspaceId) {
      const ws = await queryOne<{ path: string }>('SELECT path FROM workspaces WHERE id = $1', [workspaceId]);
      wsPath = ws?.path;
    } else {
      const ws = await queryOne<{ path: string }>('SELECT path FROM workspaces ORDER BY id LIMIT 1');
      wsPath = ws?.path;
    }

    if (!wsPath) {
      throw new ValidationError('No workspace found');
      return;
    }

    // Fetch raw content — try main, then master
    let content: string | null = null;
    const trimmedPath = skillPath.trim();
    const mainUrl = `https://raw.githubusercontent.com/${owner}/${repo}/main/${trimmedPath}`;
    try {
      const resp = await fetch(mainUrl, { signal: AbortSignal.timeout(15_000) });
      if (resp.ok) {
        content = await resp.text();
      }
    } catch { /* try master */ }

    if (!content) {
      const masterUrl = `https://raw.githubusercontent.com/${owner}/${repo}/master/${trimmedPath}`;
      try {
        const resp = await fetch(masterUrl, { signal: AbortSignal.timeout(15_000) });
        if (resp.ok) {
          content = await resp.text();
        }
      } catch { /* not found */ }
    }

    if (!content) {
      throw new NotFoundError(`Skill file not found at ${trimmedPath} in ${owner}/${repo}`);
      return;
    }

    // Parse frontmatter for name and description
    let name = '';
    let description = '';
    const fm = parseFrontmatter(content);
    if (fm) {
      try {
        const meta = yaml.load(fm.yaml) as Record<string, unknown> | null;
        if (meta && typeof meta === 'object') {
          if (typeof meta['name'] === 'string') name = meta['name'];
          if (typeof meta['description'] === 'string') description = meta['description'];
        }
      } catch { /* use defaults */ }
    }

    // Derive name from directory if no frontmatter name
    if (!name) {
      const parts = trimmedPath.split('/');
      // e.g. 'skills/react/SKILL.md' -> 'react'
      name = parts.length >= 2 ? parts[parts.length - 2] : path.basename(trimmedPath, '.md');
    }

    const skillName = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const source = `github:${owner}/${repo}`;

    // Dual-save to .rorca/skills/ and .claude/skills/
    const rorcaSkillsDir = path.join(wsPath, '.rorca', 'skills');
    const claudeSkillsDir = path.join(wsPath, '.claude', 'skills');
    fs.mkdirSync(rorcaSkillsDir, { recursive: true });
    fs.mkdirSync(claudeSkillsDir, { recursive: true });

    const rorcaPath = path.join(rorcaSkillsDir, `${skillName}.md`);
    const claudePath = path.join(claudeSkillsDir, `${skillName}.md`);
    fs.writeFileSync(rorcaPath, content, 'utf-8');
    fs.writeFileSync(claudePath, content, 'utf-8');

    // Register in DB
    const registry = new SkillRegistry();
    await registry.install(skillName, content, source);

    const wsId = await resolveWorkspaceId(req);
    await emitSkillWalEvent('skill_installed', wsId, {
      name: skillName,
      source: `github:${owner}/${repo}`,
      repoUrl: `https://github.com/${owner}/${repo}`,
      workspace_id: wsId,
    });

    res.status(201).json({
      name: skillName,
      description,
      source,
      filePath: rorcaPath,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Skills] install-from-github');
  }
});

/**
 * @swagger
 * /api/skills/bulk-install:
 *   post:
 *     x-rorca-native-api: true
 *     x-rorca-rationale: "Intentional dashboard/native API operation; authenticated local-admin access only and never MCP-exposed by default."
 *     tags: [Skills]
 *     summary: Install multiple skills in a single request
 *     operationId: bulkInstallSkills
 *     description: |
 *       Processes an array of skills sequentially (to avoid GitHub rate limiting).
 *       Each skill can come from skills.sh, a GitHub repo, or raw markdown content.
 *       Failed items do not abort the batch — processing continues.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [skills]
 *             properties:
 *               skills:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [name, source]
 *                   properties:
 *                     name:
 *                       type: string
 *                       description: Skill name
 *                     source:
 *                       type: string
 *                       enum: [sh, github, content]
 *                       description: "Source type: 'sh' (skills.sh registry), 'github' (GitHub repo), 'content' (raw markdown)"
 *                     repoUrl:
 *                       type: string
 *                       description: "GitHub repo URL (required when source='github')"
 *                     skillPath:
 *                       type: string
 *                       description: "Path within GitHub repo (required when source='github')"
 *                     content:
 *                       type: string
 *                       description: "Raw markdown content (required when source='content')"
 *               workspaceId:
 *                 type: string
 *                 description: Workspace ID to install into. Defaults to first workspace.
 *     responses:
 *       200:
 *         description: Bulk install results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 installed:
 *                   type: number
 *                 failed:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                       error:
 *                         type: string
 *                 total:
 *                   type: number
 *       400:
 *         description: Missing or invalid request body
 */
router.post('/bulk-install', async (req: Request, res: Response) => {
  try {
    const { skills, workspaceId } = req.body;

    if (!Array.isArray(skills) || skills.length === 0) {
      throw new ValidationError('skills array is required and must not be empty');
      return;
    }

    // Resolve workspace path
    let wsPath: string | undefined;
    if (workspaceId) {
      const ws = await queryOne<{ path: string }>('SELECT path FROM workspaces WHERE id = $1', [workspaceId]);
      wsPath = ws?.path;
    } else {
      const ws = await queryOne<{ path: string }>('SELECT path FROM workspaces ORDER BY id LIMIT 1');
      wsPath = ws?.path;
    }

    if (!wsPath) {
      throw new ValidationError('No workspace found');
      return;
    }

    // Ensure skill directories exist
    const rorcaSkillsDir = path.join(wsPath, '.rorca', 'skills');
    const claudeSkillsDir = path.join(wsPath, '.claude', 'skills');
    fs.mkdirSync(rorcaSkillsDir, { recursive: true });
    fs.mkdirSync(claudeSkillsDir, { recursive: true });

    const registry = new SkillRegistry();
    const wsId = await resolveWorkspaceId(req);
    let installed = 0;
    const failed: Array<{ name: string; error: string }> = [];

    // Process sequentially to avoid GitHub rate limiting
    for (const item of skills) {
      const itemName = (item.name || '').trim();
      if (!itemName) {
        failed.push({ name: item.name || '(empty)', error: 'name is required' });
        continue;
      }

      try {
        if (item.source === 'sh') {
          // Fetch from skills.sh registry
          const queryStr = itemName.replace(/\.md$/i, '').toLowerCase();
          const result = await fetchSkillFromRegistry(queryStr);
          if (!result) {
            failed.push({ name: itemName, error: `Not found in skills.sh registry` });
            continue;
          }
          const skillName = queryStr.replace(/[^a-z0-9-]/g, '-');
          fs.writeFileSync(path.join(rorcaSkillsDir, `${skillName}.md`), result.content, 'utf-8');
          fs.writeFileSync(path.join(claudeSkillsDir, `${skillName}.md`), result.content, 'utf-8');
          await registry.install(skillName, result.content, result.source);
          installed++;
          await emitSkillWalEvent('skill_installed', wsId, {
            name: skillName, source: result.source, workspace_id: wsId,
          });

        } else if (item.source === 'github') {
          // Fetch from GitHub repo
          if (!item.repoUrl || !item.skillPath) {
            failed.push({ name: itemName, error: 'repoUrl and skillPath are required for source=github' });
            continue;
          }
          const parsed = parseGitHubRepo(item.repoUrl);
          if (!parsed) {
            failed.push({ name: itemName, error: 'Invalid repository URL' });
            continue;
          }
          const { owner, repo } = parsed;
          const trimmedPath = item.skillPath.trim();

          let content: string | null = null;
          const mainUrl = `https://raw.githubusercontent.com/${owner}/${repo}/main/${trimmedPath}`;
          try {
            const resp = await fetch(mainUrl, { signal: AbortSignal.timeout(15_000) });
            if (resp.ok) content = await resp.text();
          } catch { /* try master */ }

          if (!content) {
            const masterUrl = `https://raw.githubusercontent.com/${owner}/${repo}/master/${trimmedPath}`;
            try {
              const resp = await fetch(masterUrl, { signal: AbortSignal.timeout(15_000) });
              if (resp.ok) content = await resp.text();
            } catch { /* not found */ }
          }

          if (!content) {
            failed.push({ name: itemName, error: `Skill file not found at ${trimmedPath} in ${owner}/${repo}` });
            continue;
          }

          // Parse frontmatter for name
          let skillName = itemName;
          const fm = parseFrontmatter(content);
          if (fm) {
            try {
              const meta = yaml.load(fm.yaml) as Record<string, unknown> | null;
              if (meta && typeof meta === 'object' && typeof meta['name'] === 'string') {
                skillName = meta['name'];
              }
            } catch { /* use provided name */ }
          }
          const normalizedName = skillName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
          const source = `github:${owner}/${repo}`;

          fs.writeFileSync(path.join(rorcaSkillsDir, `${normalizedName}.md`), content, 'utf-8');
          fs.writeFileSync(path.join(claudeSkillsDir, `${normalizedName}.md`), content, 'utf-8');
          await registry.install(normalizedName, content, source);
          installed++;
          await emitSkillWalEvent('skill_installed', wsId, {
            name: normalizedName, source, workspace_id: wsId,
          });

        } else if (item.source === 'content' || item.content) {
          // Install from raw markdown content
          const rawContent = item.content;
          if (!rawContent || typeof rawContent !== 'string') {
            failed.push({ name: itemName, error: 'content is required for source=content' });
            continue;
          }
          const normalizedName = itemName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
          fs.writeFileSync(path.join(rorcaSkillsDir, `${normalizedName}.md`), rawContent, 'utf-8');
          fs.writeFileSync(path.join(claudeSkillsDir, `${normalizedName}.md`), rawContent, 'utf-8');
          await registry.install(normalizedName, rawContent, 'user');
          installed++;
          await emitSkillWalEvent('skill_installed', wsId, {
            name: normalizedName, source: 'user', workspace_id: wsId,
          });

        } else {
          failed.push({ name: itemName, error: `Unknown source type: ${item.source}` });
        }
      } catch (err: any) {
        failed.push({ name: itemName, error: err.message || 'Unknown error' });
      }
    }

    res.json({ installed, failed, total: skills.length });
  } catch (error: any) {
    handleRouteError(res, error, '[Skills] bulk-install');
  }
});

/**
 * @swagger
 * /api/skills/bulk-remove:
 *   post:
 *     x-rorca-native-api: true
 *     x-rorca-rationale: "Intentional dashboard/native API operation; authenticated local-admin access only and never MCP-exposed by default."
 *     tags: [Skills]
 *     summary: Remove multiple installed skills at once
 *     operationId: bulkRemoveSkills
 *     description: |
 *       Removes multiple skills by name. For each skill, deletes from DB via SkillRegistry,
 *       and removes .rorca/skills/{name}.md and .claude/skills/{name}.md from the filesystem.
 *       Missing files are not treated as errors.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [names]
 *             properties:
 *               names:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Array of skill names to remove
 *               workspaceId:
 *                 type: string
 *                 description: Workspace ID for filesystem cleanup. Defaults to first workspace.
 *     responses:
 *       200:
 *         description: Bulk remove results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 removed:
 *                   type: number
 *                 notFound:
 *                   type: array
 *                   items:
 *                     type: string
 *       400:
 *         description: Missing or invalid request body
 */
router.post('/bulk-remove', async (req: Request, res: Response) => {
  try {
    const { names, workspaceId } = req.body;

    if (!Array.isArray(names) || names.length === 0) {
      throw new ValidationError('names array is required and must not be empty');
      return;
    }

    // Resolve workspace path for filesystem cleanup
    let wsPath: string | undefined;
    if (workspaceId) {
      const ws = await queryOne<{ path: string }>('SELECT path FROM workspaces WHERE id = $1', [workspaceId]);
      wsPath = ws?.path;
    } else {
      const ws = await queryOne<{ path: string }>('SELECT path FROM workspaces ORDER BY id LIMIT 1');
      wsPath = ws?.path;
    }

    const registry = new SkillRegistry();
    const wsId = await resolveWorkspaceId(req);
    let removed = 0;
    const notFound: string[] = [];

    for (const name of names) {
      if (!name || typeof name !== 'string') continue;
      const trimmed = name.trim();
      if (!trimmed) continue;

      const wasRemoved = await registry.remove(trimmed);
      if (wasRemoved) {
        removed++;
        await emitSkillWalEvent('skill_removed', wsId, {
          name: trimmed, workspace_id: wsId,
        });
      } else {
        notFound.push(trimmed);
      }

      // Clean up filesystem files (missing files are not errors)
      if (wsPath) {
        const normalizedName = trimmed.toLowerCase().replace(/[^a-z0-9-]/g, '-');
        const rorcaPath = path.join(wsPath, '.rorca', 'skills', `${normalizedName}.md`);
        const claudePath = path.join(wsPath, '.claude', 'skills', `${normalizedName}.md`);
        try { fs.unlinkSync(rorcaPath); } catch { /* missing file is fine */ }
        try { fs.unlinkSync(claudePath); } catch { /* missing file is fine */ }
      }
    }

    res.json({ removed, notFound });
  } catch (error: any) {
    handleRouteError(res, error, '[Skills] bulk-remove');
  }
});

/**
 * @swagger
 * /api/skills/export:
 *   get:
 *     x-rorca-native-api: true
 *     x-rorca-rationale: "Intentional dashboard/native API operation; authenticated local-admin access only and never MCP-exposed by default."
 *     tags: [Skills]
 *     summary: Export installed skills as a shareable JSON manifest
 *     operationId: exportSkills
 *     description: |
 *       Returns a JSON manifest of all installed skills that can be saved and
 *       used to re-install the same skill set in another workspace via bulk-install.
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         schema:
 *           type: string
 *         description: Workspace ID. Defaults to first workspace.
 *     responses:
 *       200:
 *         description: Skills export manifest
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 skills:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                       description:
 *                         type: string
 *                       source:
 *                         type: string
 *                       category:
 *                         type: string
 *                         nullable: true
 *                 exportedAt:
 *                   type: string
 *                   format: date-time
 *                 workspacePath:
 *                   type: string
 *                   nullable: true
 */
router.get('/export', async (req: Request, res: Response) => {
  try {
    const wsPath = await resolveWorkspacePath(req);

    const registry = new SkillRegistry();
    if (wsPath) {
      await registry.discover(wsPath);
    }

    const allSkills = registry.getAll();

    // If no skills from registry, also check DB directly
    let exportSkills;
    if (allSkills.length > 0) {
      exportSkills = allSkills.map(s => ({
        name: s.metadata.name,
        description: s.metadata.description,
        source: s.source,
        category: s.metadata.category || inferCategory(s.metadata.name, s.metadata.description),
        tags: s.metadata.tags || [],
      }));
    } else {
      const dbSkills = await query<{
        name: string; description: string; source: string; category: string | null; tags: string | null;
      }>('SELECT name, description, source, category, tags FROM installed_skills');
      exportSkills = dbSkills.map(s => {
        let parsedTags: string[] = [];
        if (s.tags) { try { parsedTags = JSON.parse(s.tags); } catch { /* ignore */ } }
        return {
          name: s.name,
          description: s.description,
          source: s.source,
          category: s.category || inferCategory(s.name, s.description),
          tags: parsedTags,
        };
      });
    }

    res.json({
      skills: exportSkills,
      exportedAt: new Date().toISOString(),
      workspacePath: wsPath || null,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Skills] export');
  }
});

/** Recursively find .md files in a directory. */
function _findMdFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(..._findMdFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(fullPath);
      }
    }
  } catch { /* skip inaccessible */ }
  return results;
}

export default router;
