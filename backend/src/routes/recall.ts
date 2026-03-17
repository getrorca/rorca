/**
 * recall.ts — GET /api/recall — unified context retrieval endpoint.
 *
 * Returns a RecallResponse with 8 named sections + meta.
 * Each section is populated by its respective story (US-001 through US-010).
 * This file was bootstrapped by US-006 (skills section).
 */

import { Router, Request, Response } from 'express';
import * as fs from 'fs/promises';
import * as path from 'path';
import { queryOne, query as dbQuery } from '../db/index';
import { RecallQuerySchema, type RecallResponse, type SkillPreview } from './recall-types';
import { synthesizeDirectionStack } from '../lib/direction-stack';
import { readMemory, type MemoryEntry } from '../lib/memory-ledger';
import { echolocate } from '../lib/workspace-echolocation';
import { parseFrontmatter, inferCategory } from '../lib/skill-registry';
import * as yaml from 'js-yaml';
import { ValidationError, NotFoundError } from '../lib/errors';

const router = Router();

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Truncate text to maxLen characters, breaking at the last space before the limit.
 * If the text is shorter than maxLen, returns it unchanged.
 */
function truncateAtWord(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const truncated = text.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace <= 0) return truncated;
  return truncated.slice(0, lastSpace);
}

/**
 * Read all .md files from a directory, returning name + content pairs.
 * Returns empty array if directory does not exist.
 */
async function readSkillFiles(dirPath: string): Promise<Array<{ name: string; content: string }>> {
  let entries: string[];
  try {
    entries = await fs.readdir(dirPath);
  } catch {
    return [];
  }

  const mdFiles = entries.filter(f => f.endsWith('.md'));
  const results = await Promise.all(
    mdFiles.map(async (filename) => {
      try {
        const content = await fs.readFile(path.join(dirPath, filename), 'utf-8');
        return { name: path.basename(filename, '.md'), content };
      } catch {
        return null;
      }
    }),
  );

  return results.filter((r): r is { name: string; content: string } => r !== null);
}

/**
 * Build SkillPreview from raw file content.
 */
function fileToPreview(name: string, content: string, source: string): SkillPreview {
  const parsed = parseFrontmatter(content);
  let description = '';
  let category: string | null = null;
  let tags: string[] = [];
  let bodyText = content;

  if (parsed) {
    try {
      const raw = yaml.load(parsed.yaml) as Record<string, unknown> | null;
      if (raw && typeof raw === 'object') {
        if (typeof raw['description'] === 'string') description = raw['description'];
        if (typeof raw['name'] === 'string') name = raw['name'];
        if (typeof raw['category'] === 'string') category = raw['category'].trim();
        if (Array.isArray(raw['tags'])) {
          tags = raw['tags'].filter((t: unknown): t is string => typeof t === 'string');
        } else if (typeof raw['tags'] === 'string') {
          tags = raw['tags'].split(',').map((t: string) => t.trim()).filter(Boolean);
        }
      }
    } catch {
      // YAML parse failure — treat entire content as body
    }
    bodyText = parsed.body;
  }

  if (!category) category = inferCategory(name, description);

  return {
    name,
    contentPreview: truncateAtWord(bodyText.trim(), 200),
    description,
    category,
    tags,
    source,
  };
}

/**
 * Collect skills from filesystem (.rorca/skills/) and DB (installed_skills),
 * with filesystem taking precedence on name conflicts.
 */
async function collectSkills(workspacePath: string): Promise<SkillPreview[]> {
  const skillsDir = path.join(workspacePath, '.rorca', 'skills');

  // Read filesystem skills in parallel
  const fsSkills = await readSkillFiles(skillsDir);

  // Build previews from filesystem (these take precedence)
  const seen = new Map<string, SkillPreview>();
  for (const { name, content } of fsSkills) {
    const preview = fileToPreview(name, content, 'rorca-skills');
    seen.set(preview.name.toLowerCase(), preview);
  }

  // Merge DB-stored skills (only if not already present from filesystem)
  const dbSkills = await dbQuery<{
    name: string;
    description: string;
    source: string;
    content: string;
    category: string | null;
    tags: string | null;
  }>('SELECT name, description, source, content, category, tags FROM installed_skills');

  for (const row of dbSkills) {
    const key = row.name.toLowerCase();
    if (seen.has(key)) continue; // filesystem takes precedence

    let tags: string[] = [];
    if (row.tags) {
      try { tags = JSON.parse(row.tags); } catch { tags = []; }
    }

    const bodyText = (() => {
      const parsed = parseFrontmatter(row.content);
      return parsed ? parsed.body.trim() : row.content.trim();
    })();

    seen.set(key, {
      name: row.name,
      contentPreview: truncateAtWord(bodyText, 200),
      description: row.description,
      category: row.category || inferCategory(row.name, row.description),
      tags,
      source: row.source || 'db',
    });
  }

  return Array.from(seen.values());
}

// ─── Route ──────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/recall:
 *   get:
 *     summary: Unified context recall for a workspace
 *     tags: [Recall]
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *           enum: [Architecture, Convention, Bug Fix, Decision, Pattern, Gotcha]
 *       - in: query
 *         name: includeRuns
 *         schema:
 *           type: string
 *           default: 'true'
 *       - in: query
 *         name: includeHealth
 *         schema:
 *           type: string
 *           default: 'true'
 *       - in: query
 *         name: storyText
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Unified recall response
 */
router.get('/', async (req: Request, res: Response) => {
  const startMs = Date.now();

  // Validate query params
  const parsed = RecallQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
    );
  }
  const { workspaceId, category, includeRuns, includeHealth } = parsed.data;

  // Look up workspace
  const workspace = await queryOne<{ id: string; label: string; path: string; domain: string | null }>(
    'SELECT id, label, path, domain FROM workspaces WHERE id = $1',
    [workspaceId],
  );
  if (!workspace) {
    throw new NotFoundError(`Workspace ${workspaceId} not found`);
  }

  // ── Section: Direction Stack (US-002) ─────────────────────────────────
  let directionStack = '';
  try {
    const synthesized = await synthesizeDirectionStack(workspaceId);
    directionStack = synthesized.text;
  } catch {
    // Non-fatal — return empty string
  }

  // ── Section: Memories (US-003) ────────────────────────────────────────
  let memories: MemoryEntry[] = [];
  try {
    const all = readMemory(workspace.path);
    memories = category ? all.filter(m => m.category === category) : all;
  } catch {
    // Non-fatal
  }

  // ── Section: Health (US-004) ──────────────────────────────────────────
  let health = null;
  if (includeHealth) {
    try {
      health = echolocate(workspace.path);
    } catch {
      // Non-fatal
    }
  }

  // ── Section: Recent Runs (US-005) ─────────────────────────────────────
  // Stub — will be populated by US-005
  const recentRuns: RecallResponse['recentRuns'] = [];

  // ── Section: Skills (US-006) ──────────────────────────────────────────
  const skills = await collectSkills(workspace.path);

  // ── Section: Workspace Context (US-007) ───────────────────────────────
  // Stub — will be populated by US-007
  const workspaceContext: RecallResponse['workspaceContext'] = {
    schemaSnapshot: null,
    gitMemory: null,
  };

  // ── Section: Metadata (US-002) ────────────────────────────────────────
  const metadata: RecallResponse['metadata'] = {
    id: workspace.id,
    label: workspace.label,
    path: workspace.path,
    domain: workspace.domain,
  };

  // ── Section: Active Runs (US-008) ─────────────────────────────────────
  // Stub — will be populated by US-008
  const activeRuns: RecallResponse['activeRuns'] = [];

  // ── Meta ───────────────────────────────────────────────────────────────
  const latencyMs = Date.now() - startMs;
  const totalTokens = Math.ceil(directionStack.length / 4); // rough estimate

  const response: RecallResponse = {
    directionStack,
    memories,
    health,
    recentRuns,
    skills,
    workspaceContext,
    metadata,
    activeRuns,
    meta: {
      totalTokens,
      latencyMs,
      retrievalTier: 'cag',
      generatedAt: new Date().toISOString(),
    },
  };

  res.json(response);
});

export default router;
