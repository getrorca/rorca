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
import { db } from '../db/index';
import { SkillRegistry } from '../lib/skill-registry';
import { echolocate, inferSkillsFromStack, STACK_TO_SKILLS } from '../lib/workspace-echolocation';

const router = Router();

/**
 * Resolve the workspace path from optional query param or first registered workspace.
 */
function resolveWorkspacePath(req: Request): string | null {
  const workspaceId = req.query.workspaceId as string | undefined;
  if (workspaceId) {
    const ws = db.prepare('SELECT path FROM workspaces WHERE id = ?').get(workspaceId) as { path: string } | undefined;
    return ws?.path ?? null;
  }
  // Default: first registered workspace
  const first = db.prepare('SELECT path FROM workspaces ORDER BY rowid LIMIT 1').get() as { path: string } | undefined;
  return first?.path ?? null;
}

/**
 * @swagger
 * /api/skills:
 *   get:
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
router.get('/', (req: Request, res: Response) => {
  try {
    const registry = new SkillRegistry();
    const workspacePath = resolveWorkspacePath(req);

    if (workspacePath) {
      registry.discover(workspacePath);
    } else {
      // No workspace — only return DB-persisted skills
      const dbSkills = db.prepare('SELECT name, description, source, content FROM installed_skills').all() as {
        name: string;
        description: string;
        source: string;
        content: string;
      }[];
      // Manual load into registry is not needed — discover() handles DB merge.
      // But with no workspace path we just return DB skills directly.
      res.json({
        skills: dbSkills.map(s => ({
          name: s.name,
          description: s.description,
          source: s.source,
          filePath: '',
        })),
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
        filePath: s.filePath,
      })),
      warnings: registry.getWarnings(),
      catalog: registry.getCatalogForPrompt(),
    });
  } catch (error: any) {
    console.error('[Skills] List error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/skills/install:
 *   post:
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
router.post('/install', (req: Request, res: Response) => {
  try {
    const { name, content, source } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    if (!content || typeof content !== 'string') {
      res.status(400).json({ error: 'content is required' });
      return;
    }

    const registry = new SkillRegistry();
    const skill = registry.install(name.trim(), content, source || 'user');

    res.status(201).json({
      name: skill.metadata.name,
      description: skill.metadata.description,
      source: skill.source,
    });
  } catch (error: any) {
    console.error('[Skills] Install error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/skills/preview:
 *   get:
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
      res.status(400).json({ error: 'query is required' });
      return;
    }

    const result = await fetchSkillFromRegistry(query);
    if (!result) {
      res.status(404).json({ error: `No skill found for "${query}" in skills.sh` });
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
    console.error('[Skills] preview error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/skills/{name}/content:
 *   get:
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
router.get('/:name/content', (req: Request, res: Response) => {
  try {
    const name = req.params.name as string;
    const registry = new SkillRegistry();
    const wsPath = resolveWorkspacePath(req);

    // 1) Try filesystem via SkillRegistry
    if (wsPath) {
      registry.discover(wsPath);
    }
    const skill = registry.getSkill(name);

    if (skill) {
      // Read file content if filePath exists, otherwise use promptText
      let content = skill.promptText;
      if (skill.filePath && fs.existsSync(skill.filePath)) {
        content = fs.readFileSync(skill.filePath, 'utf-8');
      }
      const wordCount = content.split(/\s+/).filter(Boolean).length;
      res.json({
        name: skill.metadata.name,
        content,
        description: skill.metadata.description,
        wordCount,
        estimatedTokens: Math.ceil(wordCount * 1.3),
      });
      return;
    }

    // 2) Fallback: DB lookup
    const dbSkill = db.prepare(
      'SELECT name, description, content FROM installed_skills WHERE LOWER(name) = LOWER(?)'
    ).get(name) as { name: string; description: string; content: string } | undefined;

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
    res.status(404).json({ error: `Skill "${name}" not found` });
  } catch (error: any) {
    console.error('[Skills] Content error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/skills/{name}:
 *   delete:
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
router.delete('/:name', (req: Request, res: Response) => {
  try {
    const name = req.params.name as string;
    const registry = new SkillRegistry();
    const removed = registry.remove(name);

    if (!removed) {
      res.status(404).json({ error: `Skill "${name}" not found in installed skills` });
      return;
    }

    res.json({ removed: true, name });
  } catch (error: any) {
    console.error('[Skills] Remove error:', error);
    res.status(500).json({ error: error.message });
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
      const treeResp = await fetch(treeUrl, { signal: AbortSignal.timeout(10_000) });
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
      res.status(400).json({ error: 'name is required' });
      return;
    }

    // Strip .md extension if present (suggestions pass "react.md")
    const query = name.trim().replace(/\.md$/i, '').toLowerCase();

    // Resolve workspace path
    const wsPath = workspaceId
      ? (db.prepare('SELECT path FROM workspaces WHERE id = ?').get(workspaceId) as { path: string } | undefined)?.path
      : (db.prepare('SELECT path FROM workspaces ORDER BY rowid LIMIT 1').get() as { path: string } | undefined)?.path;

    if (!wsPath) {
      res.status(400).json({ error: 'No workspace found' });
      return;
    }

    // Search skills.sh and fetch content from GitHub
    const result = await fetchSkillFromRegistry(query);
    if (!result) {
      res.status(404).json({ error: `No skill found for "${query}" in skills.sh registry` });
      return;
    }

    const skillName = query.replace(/[^a-z0-9-]/g, '-');

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
    registry.install(skillName, result.content, result.source);

    res.status(201).json({
      name: result.name,
      description: result.description,
      source: result.source,
      skillId: result.skillId,
      filePath: rorcaPath,
    });
  } catch (error: any) {
    console.error('[Skills] install-from-sh error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/skills/suggestions:
 *   get:
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
router.get('/suggestions', (req: Request, res: Response) => {
  try {
    const wsPath = resolveWorkspacePath(req);
    if (!wsPath) {
      res.status(400).json({ error: 'No workspace found' });
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
    registry.discover(wsPath);
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
    console.error('[Skills] suggestions error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/skills/search:
 *   post:
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
    const { query, limit } = req.body;

    if (!query || typeof query !== 'string' || !query.trim()) {
      res.status(400).json({ error: 'query is required' });
      return;
    }

    const searchLimit = typeof limit === 'number' && limit > 0 ? Math.min(limit, 100) : 20;

    // Proxy to skills.sh search API
    const searchUrl = new URL('https://skills.sh/api/search');
    searchUrl.searchParams.set('q', query.trim());
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
      results: results.slice(0, searchLimit).map((r: any) => ({
        name: r.name || r.slug || '',
        description: r.description || r.summary || '',
        author: r.author || r.owner || '',
        url: r.url || r.homepage || '',
      })),
      query: query.trim(),
      total: data?.total ?? results.length,
    });
  } catch (error: any) {
    console.error('[Skills] search error:', error);
    res.status(500).json({ error: error.message });
  }
});

/** Recursively find .md files in a directory. */
function findMdFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findMdFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(fullPath);
      }
    }
  } catch { /* skip inaccessible */ }
  return results;
}

export default router;
