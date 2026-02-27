import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import * as crypto from 'crypto';
import simpleGit from 'simple-git';
import { db } from '../db/index';
import { synthesize } from '../lib/direction-stack';
import { generateDiagramBundle } from '../lib/diagram-generator';
import { chatComplete, getActiveProvider, DEFAULT_MODEL, resolveVaultProvider } from '../lib/llm-client';
import { writeSpec } from '../lib/spec-writer';
import { broadcastAll, subscribe, type WalEvent } from '../lib/sse-hub';
import { getVaultKey } from './vault';
import type { AuthUser } from './auth';
import { getEffectiveUser } from '../lib/get-user';

/** Resolve vault credentials (API key + baseUrl) for a given model and user. */
function resolveVaultCreds(userId: string, model: string): { apiKey?: string; baseUrl?: string } {
  // Try provider inferred from model registry first
  const vaultProvider = resolveVaultProvider(model);
  if (vaultProvider) {
    const result = getVaultKey(userId, vaultProvider);
    if (result) return { apiKey: result.key, baseUrl: result.baseUrl ?? undefined };
  }
  // Fallback: try 'openai-compat' for unrecognized models (pass-through)
  if (!vaultProvider) {
    const compat = getVaultKey(userId, 'openai-compat');
    if (compat) return { apiKey: compat.key, baseUrl: compat.baseUrl ?? undefined };
  }
  // Final fallback: try anthropic (backward compat — many users have this stored)
  const anthropic = getVaultKey(userId, 'anthropic');
  if (anthropic) return { apiKey: anthropic.key };
  return {};
}
import { createNotification } from './notifications';
import { parsePaginationParams, paginateArray } from '../lib/paginate';

const router = Router();

// ─── Batch Queue Types ────────────────────────────────────────────────────────

type BatchBriefStatus = 'queued' | 'generating' | 'completed' | 'failed';

interface BatchBriefItem {
  brief: string;
  workspaceId: string;
  templateId?: string;
  title?: string;
  model?: string;
  storyCount?: number;
  domain?: string;
  userId?: string;
  status: BatchBriefStatus;
  error?: string;
  slug?: string;
}

interface BatchState {
  id: string;
  items: BatchBriefItem[];
  createdAt: string;
  finishedAt?: string;
}

/** In-memory batch queue. Batches auto-clean after 1 hour. */
const batchQueue = new Map<string, BatchState>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface WorkspaceRow {
  id: string;
  label: string;
  path: string;
}

type ReviewStatus = 'draft' | 'review_requested' | 'approved' | 'changes_requested';

interface AssigneeInfo {
  id: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
}

interface SpecSummary {
  id: string;
  specName: string;
  storyCount: number;
  status: 'pending' | 'approved';
  generatedAt: string;
  approvedAt?: string;
  workspacePath: string;
  readinessPercent: number;
  tags: string[];
  forkedFrom?: string;
  reviewStatus: ReviewStatus;
  assignee?: AssigneeInfo;
  storyTitles?: string[];
  source?: string;
}

interface SpecVersionRow {
  id: number;
  spec_slug: string;
  version: number;
  content_json: string;
  status: string;
  rejection_reason: string | null;
  created_at: string;
}

interface UserStory {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
  complexity?: number;
  priority?: number;  // 1=urgent, 2=high, 3=normal (default), 4=low
  timeoutMinutes?: number;  // 5-120, default 45
  passes?: boolean;
  excluded?: boolean;
}

function getWorkspace(workspaceId: string): WorkspaceRow | undefined {
  return db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId) as WorkspaceRow | undefined;
}

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

function parseSpecFile(filePath: string): { title?: string; userStories?: unknown[]; generatedAt?: string; forkedFrom?: string; reviewStatus?: ReviewStatus; source?: string } {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

/**
 * Compute readiness percentage for a spec.
 * A story is "ready" when it has >= 3 acceptance criteria AND no unresolved dependencies.
 * Unresolved = dependsOn references a story ID not present in the spec.
 */
function computeReadiness(stories: any[]): number {
  if (stories.length === 0) return 0;
  const storyIds = new Set(stories.map((s: any) => s.id));
  let readyCount = 0;
  for (const story of stories) {
    const ac: unknown[] = story.acceptanceCriteria ?? [];
    const deps: string[] = story.dependsOn ?? story.dependencies ?? [];
    const hasEnoughAC = ac.length >= 3;
    const allDepsResolved = deps.every((d: string) => storyIds.has(d));
    if (hasEnoughAC && allDepsResolved) readyCount++;
  }
  return Math.round((readyCount / stories.length) * 100);
}

function getSpecTags(specId: string, workspaceId: string): string[] {
  const rows = db.prepare(
    'SELECT tag_name FROM spec_tags WHERE spec_id = ? AND workspace_id = ? ORDER BY tag_name'
  ).all(specId, workspaceId) as { tag_name: string }[];
  return rows.map(r => r.tag_name);
}

function getSpecAssignee(specId: string, workspaceId: string): AssigneeInfo | undefined {
  const row = db.prepare(`
    SELECT u.id, u.display_name, u.email, u.avatar_url
    FROM spec_assignments sa
    JOIN users u ON u.id = sa.assignee_id
    WHERE sa.spec_id = ? AND sa.workspace_id = ? AND sa.story_id = ''
  `).get(specId, workspaceId) as { id: string; display_name: string; email: string; avatar_url: string | null } | undefined;
  if (!row) return undefined;
  return { id: row.id, displayName: row.display_name, email: row.email, avatarUrl: row.avatar_url };
}

function buildSummary(
  filePath: string,
  fileName: string,
  status: 'pending' | 'approved',
  workspacePath: string,
  workspaceId?: string,
): SpecSummary {
  const content = parseSpecFile(filePath);
  const stat = fs.statSync(filePath);
  const stories: any[] = Array.isArray(content.userStories) ? content.userStories : [];
  const specId = fileName.replace('.json', '');
  const assignee = workspaceId ? getSpecAssignee(specId, workspaceId) : undefined;
  return {
    id: specId,
    specName: content.title ?? specId,
    storyCount: stories.length,
    status,
    generatedAt: content.generatedAt ?? stat.birthtime.toISOString(),
    ...(status === 'approved' ? { approvedAt: stat.mtime.toISOString() } : {}),
    workspacePath,
    readinessPercent: computeReadiness(stories),
    tags: workspaceId ? getSpecTags(specId, workspaceId) : [],
    ...(content.forkedFrom ? { forkedFrom: content.forkedFrom } : {}),
    reviewStatus: content.reviewStatus ?? 'draft',
    ...(assignee ? { assignee } : {}),
    storyTitles: stories.slice(0, 2).map((s: any) => s.title || s.id || 'Untitled'),
    ...(content.source ? { source: content.source } : {}),
  };
}

/** Get the next version number for a spec slug */
function nextVersion(specSlug: string): number {
  const row = db.prepare(
    'SELECT MAX(version) as max_ver FROM spec_versions WHERE spec_slug = ?'
  ).get(specSlug) as { max_ver: number | null } | undefined;
  return (row?.max_ver ?? 0) + 1;
}

/** Snapshot a spec's current content into spec_versions */
function snapshotVersion(specSlug: string, contentJson: string, status: string, rejectionReason?: string): number {
  const version = nextVersion(specSlug);
  db.prepare(
    `INSERT INTO spec_versions (spec_slug, version, content_json, status, rejection_reason) VALUES (?, ?, ?, ?, ?)`
  ).run(specSlug, version, contentJson, status, rejectionReason ?? null);
  return version;
}

/** Compute structured diff between two spec versions */
function computeSpecDiff(
  v1Content: { title?: string; userStories?: UserStory[] },
  v2Content: { title?: string; userStories?: UserStory[] },
): SpecDiffResult {
  const v1Stories = v1Content.userStories ?? [];
  const v2Stories = v2Content.userStories ?? [];

  const v1Map = new Map(v1Stories.map(s => [s.id, s]));
  const v2Map = new Map(v2Stories.map(s => [s.id, s]));

  const allIds = new Set([...v1Map.keys(), ...v2Map.keys()]);
  const stories: StoryDiff[] = [];

  for (const id of allIds) {
    const old = v1Map.get(id);
    const cur = v2Map.get(id);

    if (!old && cur) {
      stories.push({ id, changeType: 'added', story: cur });
    } else if (old && !cur) {
      stories.push({ id, changeType: 'removed', story: old });
    } else if (old && cur) {
      const deltas: FieldDelta[] = [];

      if (old.title !== cur.title) {
        deltas.push({ field: 'title', old: old.title, new: cur.title });
      }
      if (old.description !== cur.description) {
        deltas.push({ field: 'description', old: old.description, new: cur.description });
      }

      const oldAC = JSON.stringify(old.acceptanceCriteria);
      const curAC = JSON.stringify(cur.acceptanceCriteria);
      if (oldAC !== curAC) {
        deltas.push({
          field: 'acceptanceCriteria',
          old: old.acceptanceCriteria,
          new: cur.acceptanceCriteria,
          added: cur.acceptanceCriteria.filter(ac => !old.acceptanceCriteria.includes(ac)),
          removed: old.acceptanceCriteria.filter(ac => !cur.acceptanceCriteria.includes(ac)),
        });
      }

      const oldDeps = JSON.stringify(old.dependsOn);
      const curDeps = JSON.stringify(cur.dependsOn);
      if (oldDeps !== curDeps) {
        deltas.push({ field: 'dependsOn', old: old.dependsOn, new: cur.dependsOn });
      }

      if (deltas.length > 0) {
        stories.push({ id, changeType: 'modified', deltas });
      } else {
        stories.push({ id, changeType: 'unchanged' });
      }
    }
  }

  return {
    titleChanged: v1Content.title !== v2Content.title,
    oldTitle: v1Content.title,
    newTitle: v2Content.title,
    stories,
    summary: {
      added: stories.filter(s => s.changeType === 'added').length,
      removed: stories.filter(s => s.changeType === 'removed').length,
      modified: stories.filter(s => s.changeType === 'modified').length,
      unchanged: stories.filter(s => s.changeType === 'unchanged').length,
    },
  };
}

interface FieldDelta {
  field: string;
  old: unknown;
  new: unknown;
  added?: string[];
  removed?: string[];
}

interface StoryDiff {
  id: string;
  changeType: 'added' | 'removed' | 'modified' | 'unchanged';
  story?: UserStory;
  deltas?: FieldDelta[];
}

interface SpecDiffResult {
  titleChanged: boolean;
  oldTitle?: string;
  newTitle?: string;
  stories: StoryDiff[];
  summary: { added: number; removed: number; modified: number; unchanged: number };
}

/**
 * @swagger
 * /api/specs/generate:
 *   post:
 *     tags: [Specs]
 *     summary: Generate a spec from a brief via LLM
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, title, brief]
 *             properties:
 *               workspaceId: { type: string }
 *               title: { type: string, example: "User Authentication" }
 *               brief: { type: string, example: "Add login/register with JWT tokens" }
 *               storyCount: { type: integer, default: 5 }
 *               model: { type: string, example: "claude-sonnet-4-5-20250929" }
 *               domain: { type: string }
 *               diagramTypes: { type: array, items: { type: string } }
 *               storyAnnotations: { type: string }
 *               templateId: { type: string }
 *     responses:
 *       200:
 *         description: Generated spec
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 slug: { type: string }
 *                 title: { type: string }
 *                 stories: { type: array, items: { $ref: '#/components/schemas/UserStory' } }
 *                 provider: { type: string }
 *                 model: { type: string }
 *                 usage: { type: object }
 *                 specPath: { type: string }
 *       400: { description: "Missing required fields" }
 *       404: { description: "Workspace not found" }
 */
router.post('/generate', async (req: Request, res: Response) => {
  try {
    const { workspaceId, domain, diagramTypes, storyAnnotations, templateId } = req.body;
    const title: string = req.body.title || req.body.specName;
    const brief: string = req.body.brief || req.body.specBrief;
    const storyCount: number = Math.min(500, Math.max(1, parseInt(req.body.storyCount) || 8));
    const requestedModel: string | undefined = req.body.model;

    // 1. Validate required fields
    if (!workspaceId || !title || !brief) {
      res.status(400).json({ error: 'Missing required fields: workspaceId, title (or specName), brief (or specBrief)' });
      return;
    }

    // 1b. Validate model if provided (allow pass-through for openai-compat provider IDs)
    // No validation gate — any model string is accepted. Unknown models route to openai-compat.

    // 2. Fetch workspace from DB
    const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId) as Record<string, unknown> | undefined;
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    // 2b. Resolve model: request param > workspace L3 preferred_model > default
    let resolvedModel: string = DEFAULT_MODEL;
    if (requestedModel) {
      resolvedModel = requestedModel;
    } else {
      // Check workspace L3 for preferred_model
      const l3Pref = db.prepare(
        `SELECT preferred_model FROM direction_layers WHERE layer = 3 AND workspace_id = ? AND COALESCE(domain, '') = ''`
      ).get(workspaceId) as { preferred_model: string | null } | undefined;
      if (l3Pref?.preferred_model) {
        resolvedModel = l3Pref.preferred_model;
      }
    }

    // 3. Fetch L1: global brain (no workspace, no domain)
    const l1Row = db.prepare(
      `SELECT content_yaml FROM direction_layers WHERE layer = 1 AND COALESCE(workspace_id, '') = '' AND COALESCE(domain, '') = ''`
    ).get() as { content_yaml: string } | undefined;

    // 4. Fetch L2: domain profile
    const l2Row = db.prepare(
      `SELECT content_yaml FROM direction_layers WHERE layer = 2 AND domain = ? AND COALESCE(workspace_id, '') = ''`
    ).get(domain) as { content_yaml: string } | undefined;

    // 5. Fetch L3: project brief
    const l3Row = db.prepare(
      `SELECT content_yaml FROM direction_layers WHERE layer = 3 AND workspace_id = ? AND COALESCE(domain, '') = ''`
    ).get(workspaceId) as { content_yaml: string } | undefined;

    // 5b. Fetch auto-hydrated context from workspace_context
    const ctx = db.prepare(
      `SELECT schema_snapshot, git_memory FROM workspace_context WHERE workspace_id = ?`
    ).get(workspaceId) as { schema_snapshot: string | null; git_memory: string | null } | undefined;

    const schemaSnapshot = ctx?.schema_snapshot || undefined;
    const gitMemory = ctx?.git_memory || undefined;

    // 6. Synthesize direction stack
    const synthesized = synthesize({
      l1: l1Row?.content_yaml,
      l2: l2Row?.content_yaml,
      l3: l3Row?.content_yaml,
      schemaSnapshot,
      gitMemory,
      specBrief: brief,
      storyAnnotations,
    });

    // 6b. Fetch template if templateId provided
    let templateContext = '';
    if (templateId) {
      const tpl = db.prepare('SELECT * FROM templates WHERE id = ?').get(templateId) as
        { brief: string; story_structure: string; direction_layers: string | null } | undefined;
      if (tpl) {
        const stories = JSON.parse(tpl.story_structure);
        const storyOutline = stories.map((s: { id: string; title: string; description: string }) =>
          `- ${s.id}: ${s.title} — ${s.description}`
        ).join('\n');
        templateContext = [
          '=== REFERENCE TEMPLATE ===',
          `Template brief: ${tpl.brief}`,
          '',
          'Story structure pattern:',
          storyOutline,
          '',
          'Use this as a structural reference. Adapt story IDs, titles, and details to the new spec brief.',
          '=== END TEMPLATE ===',
        ].join('\n');
      }
    }

    // 7. Build LLM prompt
    const storyPrefix = req.body.storyPrefix || 'US';
    const wantDiagrams = Array.isArray(diagramTypes) && diagramTypes.some(
      (t: string) => t !== 'storyDeps'
    );
    const diagramSchema = wantDiagrams ? [
      '',
      'Also include a "diagrams" key at the top level with Mermaid diagrams for the following types:',
      (diagramTypes as string[]).filter((t: string) => t !== 'storyDeps').map((t: string) => {
        const hints: Record<string, string> = {
          architecture: 'graph TD — system components and their relationships',
          userFlow: 'graph LR — key user journeys through the product',
          dataFlow: 'flowchart TD — data movement between services/stores',
          erd: 'erDiagram — main database entities and their relationships',
        };
        return `  "${t}": { "mermaid": "<valid mermaid string using ${hints[t] || 'graph TD'}>" }`;
      }).join('\n'),
      'Diagrams schema addition: "diagrams":{"architecture":{"mermaid":"..."},"erd":{"mermaid":"..."}}',
      'Rules for diagrams:',
      '- Each mermaid string must be syntactically valid (renderable by mermaid.js)',
      '- Use \\n for newlines inside the mermaid string',
      '- Keep node labels short (under 30 chars)',
      '- Do not use special chars like quotes inside node labels',
    ].join('\n') : '';

    const fullPrompt = [
      '=== INSTRUCTIONS: READ THIS FIRST ===',
      'You are a spec writer. Your ONLY job is to output a single valid JSON object.',
      'Do NOT explain. Do NOT ask questions. Do NOT add markdown fences. Do NOT converse.',
      'Your ENTIRE response must be a single JSON object starting with { and ending with }.',
      'If you output anything other than raw JSON, the system will fail.',
      '=== END INSTRUCTIONS ===',
      '',
      synthesized,
      ...(templateContext ? [templateContext, '---'] : []),
      '---',
      `TASK: Generate a software specification JSON with exactly ${storyCount} user stories.`,
      `Spec title: ${title}`,
      `Spec brief: ${brief}`,
      '',
      'OUTPUT FORMAT: Respond with ONLY a raw JSON object. No markdown fences. No explanation. No preamble. Start your response with { and end with }.',
      '',
      'JSON schema:',
      `{"stories":[{"id":"${storyPrefix}-001","title":"string","description":"string","acceptanceCriteria":["string"],"dependsOn":["${storyPrefix}-001"],"complexity":3}],"mermaidDiagram":"graph TD\\n  ${storyPrefix}-001[\\"Story title\\"]\\n  ${storyPrefix}-002[\\"Story title\\"]\\n  ${storyPrefix}-001 --> ${storyPrefix}-002"${wantDiagrams ? ',"diagrams":{"architecture":{"mermaid":"graph TD\\n  A --> B"}}' : ''}}`,
      wantDiagrams ? diagramSchema : '',
      '',
      `Rules:`,
      `- Generate exactly ${storyCount} stories, numbered ${storyPrefix}-001 through ${storyPrefix}-${String(storyCount).padStart(3, '0')}`,
      '- Each story needs 3-5 specific testable acceptanceCriteria',
      '- dependsOn lists story IDs this story requires to be done first (empty array if none)',
      '- IMPORTANT: Analyze story CONTENT to determine dependencies — if story B references a component, API, or data model introduced in story A, then B dependsOn [A]. Consider: shared state/data, API endpoints one story creates that another consumes, UI components built in one story and used in another, database tables/schemas, authentication/authorization flows',
      '- Stories should be concrete and implementable, not vague',
      '- Each story must have a "complexity" field: integer 1-5 (1=trivial one-liner, 2=simple, 3=moderate, 4=complex multi-file, 5=epic cross-cutting). Base on acceptance criteria count, description scope, and dependency depth',
      '- Your entire response must be valid JSON parseable by JSON.parse()',
      '- Include a "mermaidDiagram" field: a valid Mermaid flowchart (graph TD) showing story dependency relationships',
      '- In the mermaidDiagram: each story is a node labeled with its ID, edges go from dependency to dependent (A --> B means A must be done before B)',
      '- Stories with no dependencies are root nodes (no incoming edges). Use \\n for newlines in the mermaid string',
    ].join('\n');

    // 8. Call LLM with selected model (use vault key if available)
    const user = getEffectiveUser(req);
    if (!user) { res.status(500).json({ error: 'No user configured' }); return; }
    const vaultCreds = resolveVaultCreds(user.id, resolvedModel);
    const llmResult = await chatComplete(
      [{ role: 'user', content: fullPrompt }],
      { model: resolvedModel, apiKey: vaultCreds.apiKey, baseUrl: vaultCreds.baseUrl },
    );
    const rawResponse = llmResult.text;
    const tokenUsage = llmResult.usage;

    // 9. Parse JSON — strip markdown fences and preamble text if present
    let parsed: { stories: unknown[]; diagrams?: Record<string, unknown>; mermaidDiagram?: string };
    try {
      // Extract JSON from ```json ... ``` code block if present
      const fenceMatch = rawResponse.match(/```(?:json)?\s*([\s\S]*?)```/);
      const jsonStr = fenceMatch ? fenceMatch[1].trim() : rawResponse.trim();
      // If there's still leading text before the JSON object, strip it
      const jsonStart = jsonStr.indexOf('{');
      parsed = JSON.parse(jsonStart > 0 ? jsonStr.slice(jsonStart) : jsonStr);
    } catch {
      res.status(500).json({ error: 'LLM returned non-JSON', raw: rawResponse });
      return;
    }

    // 10. Validate structure
    if (!Array.isArray(parsed.stories)) {
      res.status(500).json({ error: 'Invalid spec structure from LLM' });
      return;
    }

    // 11. Generate algorithmic diagrams
    const algorithmicDiagrams = generateDiagramBundle(parsed.stories as any, diagramTypes || []);

    // 11b. Resolve mermaidDiagram: prefer LLM-generated, fall back to algorithmic storyDeps
    const mermaidDiagram = (typeof parsed.mermaidDiagram === 'string' && parsed.mermaidDiagram.trim())
      ? parsed.mermaidDiagram
      : algorithmicDiagrams.storyDeps?.mermaid || '';

    // 12. Merge diagrams (algorithmic overwrites LLM for storyDeps)
    const allDiagrams = { ...(parsed.diagrams || {}), ...algorithmicDiagrams };

    // 13. Build slug
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    // 14. WAL event
    const provider = getActiveProvider();
    const model = resolvedModel;
    db.prepare(
      `INSERT INTO wal_events (event_type, spec_id, payload) VALUES ('generate', ?, ?)`
    ).run(slug, JSON.stringify({
      title, domain, storyCount: parsed.stories.length, provider, model,
      hasSchema: !!schemaSnapshot, hasGitMemory: !!gitMemory,
      inputTokens: tokenUsage.inputTokens, outputTokens: tokenUsage.outputTokens,
    }));

    // 15. Snapshot existing spec as a version if regenerating same slug
    const { pendingDir: genPendingDir, approvedDir: genApprovedDir } = specsDirs(workspace.path as string);
    const existingPending = path.join(genPendingDir, `${slug}.json`);
    const existingApproved = path.join(genApprovedDir, `${slug}.json`);

    if (fs.existsSync(existingPending)) {
      const existingContent = fs.readFileSync(existingPending, 'utf8');
      snapshotVersion(slug, existingContent, 'pending');
      fs.unlinkSync(existingPending);
    } else if (fs.existsSync(existingApproved)) {
      const existingContent = fs.readFileSync(existingApproved, 'utf8');
      snapshotVersion(slug, existingContent, 'approved');
      fs.unlinkSync(existingApproved);
    }

    // 16. Write spec to workspace directory
    let specPath: string;
    let diagramsPath: string;
    try {
      const writeResult = writeSpec(workspace.path as string, {
        slug,
        title,
        stories: parsed.stories as any,
        diagrams: allDiagrams as any,
        mermaidDiagram: mermaidDiagram || undefined,
        model: resolvedModel,
      });
      specPath = writeResult.specPath;
      diagramsPath = writeResult.diagramsPath;
    } catch (writeErr: any) {
      res.status(409).json({ error: writeErr.message });
      return;
    }

    // 17. Return response
    res.json({
      slug,
      title,
      stories: parsed.stories,
      diagrams: allDiagrams,
      mermaidDiagram,
      provider,
      model,
      usage: tokenUsage,
      specPath,
      diagramsPath,
    });
  } catch (error: any) {
    console.error('[Specs] Generate error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── US-008: POST /generate/batch — Queue multiple briefs for sequential generation ─

interface BatchRequestItem {
  brief: string;
  workspaceId: string;
  templateId?: string;
  title?: string;
  model?: string;
  storyCount?: number;
  domain?: string;
}

/**
 * Process a single brief within a batch. Reuses the same logic as POST /generate
 * but captures errors per-brief rather than returning HTTP errors.
 */
async function processBatchBrief(item: BatchBriefItem): Promise<void> {
  const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(item.workspaceId) as WorkspaceRow | undefined;
  if (!workspace) {
    item.status = 'failed';
    item.error = 'Workspace not found';
    return;
  }

  // Resolve model (accept any model string for openai-compat pass-through)
  let resolvedModel: string = DEFAULT_MODEL;
  if (item.model) {
    resolvedModel = item.model;
  } else {
    const l3Pref = db.prepare(
      `SELECT preferred_model FROM direction_layers WHERE layer = 3 AND workspace_id = ? AND COALESCE(domain, '') = ''`
    ).get(item.workspaceId) as { preferred_model: string | null } | undefined;
    if (l3Pref?.preferred_model) {
      resolvedModel = l3Pref.preferred_model;
    }
  }

  // Generate title from brief if not provided
  const title = item.title || item.brief.slice(0, 60).replace(/[^a-zA-Z0-9 ]/g, '').trim();
  const storyCount = Math.min(500, Math.max(1, item.storyCount || 8));

  // Fetch direction layers
  const l1Row = db.prepare(
    `SELECT content_yaml FROM direction_layers WHERE layer = 1 AND COALESCE(workspace_id, '') = '' AND COALESCE(domain, '') = ''`
  ).get() as { content_yaml: string } | undefined;
  const l2Row = db.prepare(
    `SELECT content_yaml FROM direction_layers WHERE layer = 2 AND domain = ? AND COALESCE(workspace_id, '') = ''`
  ).get(item.domain ?? '') as { content_yaml: string } | undefined;
  const l3Row = db.prepare(
    `SELECT content_yaml FROM direction_layers WHERE layer = 3 AND workspace_id = ? AND COALESCE(domain, '') = ''`
  ).get(item.workspaceId) as { content_yaml: string } | undefined;
  const ctx = db.prepare(
    `SELECT schema_snapshot, git_memory FROM workspace_context WHERE workspace_id = ?`
  ).get(item.workspaceId) as { schema_snapshot: string | null; git_memory: string | null } | undefined;

  const synthesized = synthesize({
    l1: l1Row?.content_yaml,
    l2: l2Row?.content_yaml,
    l3: l3Row?.content_yaml,
    schemaSnapshot: ctx?.schema_snapshot || undefined,
    gitMemory: ctx?.git_memory || undefined,
    specBrief: item.brief,
  });

  // Template context
  let templateContext = '';
  if (item.templateId) {
    const tpl = db.prepare('SELECT * FROM templates WHERE id = ?').get(item.templateId) as
      { brief: string; story_structure: string } | undefined;
    if (tpl) {
      const stories = JSON.parse(tpl.story_structure);
      const storyOutline = stories.map((s: { id: string; title: string; description: string }) =>
        `- ${s.id}: ${s.title} — ${s.description}`
      ).join('\n');
      templateContext = [
        '=== REFERENCE TEMPLATE ===',
        `Template brief: ${tpl.brief}`,
        '', 'Story structure pattern:', storyOutline, '',
        'Use this as a structural reference. Adapt story IDs, titles, and details to the new spec brief.',
        '=== END TEMPLATE ===',
      ].join('\n');
    }
  }

  const storyPrefix = 'US';
  const fullPrompt = [
    '=== INSTRUCTIONS: READ THIS FIRST ===',
    'You are a spec writer. Your ONLY job is to output a single valid JSON object.',
    'Do NOT explain. Do NOT ask questions. Do NOT add markdown fences. Do NOT converse.',
    'Your ENTIRE response must be a single JSON object starting with { and ending with }.',
    'If you output anything other than raw JSON, the system will fail.',
    '=== END INSTRUCTIONS ===',
    '',
    synthesized,
    ...(templateContext ? [templateContext, '---'] : []),
    '---',
    `TASK: Generate a software specification JSON with exactly ${storyCount} user stories.`,
    `Spec title: ${title}`,
    `Spec brief: ${item.brief}`,
    '',
    'OUTPUT FORMAT: Respond with ONLY a raw JSON object. No markdown fences. No explanation. No preamble. Start your response with { and end with }.',
    '',
    'JSON schema:',
    `{"stories":[{"id":"${storyPrefix}-001","title":"string","description":"string","acceptanceCriteria":["string"],"dependsOn":["${storyPrefix}-001"],"complexity":3}]}`,
    '',
    `Rules:`,
    `- Generate exactly ${storyCount} stories, numbered ${storyPrefix}-001 through ${storyPrefix}-${String(storyCount).padStart(3, '0')}`,
    '- Each story needs 3-5 specific testable acceptanceCriteria',
    '- dependsOn lists story IDs this story requires to be done first (empty array if none)',
    '- Stories should be concrete and implementable, not vague',
    '- Each story must have a "complexity" field: integer 1-5 (1=trivial, 2=simple, 3=moderate, 4=complex, 5=epic)',
    '- Your entire response must be valid JSON parseable by JSON.parse()',
  ].join('\n');

  // Call LLM (use vault key if available for this user)
  const batchVaultCreds = item.userId ? resolveVaultCreds(item.userId, resolvedModel) : {};
  const llmResult = await chatComplete(
    [{ role: 'user', content: fullPrompt }],
    { model: resolvedModel, apiKey: batchVaultCreds.apiKey, baseUrl: batchVaultCreds.baseUrl },
  );
  const rawResponse = llmResult.text;

  // Parse JSON
  let parsed: { stories: unknown[]; diagrams?: Record<string, unknown> };
  const fenceMatch = rawResponse.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = fenceMatch ? fenceMatch[1].trim() : rawResponse.trim();
  const jsonStart = jsonStr.indexOf('{');
  parsed = JSON.parse(jsonStart > 0 ? jsonStr.slice(jsonStart) : jsonStr);

  if (!Array.isArray(parsed.stories)) {
    throw new Error('Invalid spec structure from LLM');
  }

  // Generate diagrams
  const algorithmicDiagrams = generateDiagramBundle(parsed.stories as any, []);
  const allDiagrams = { ...(parsed.diagrams || {}), ...algorithmicDiagrams };

  // Build slug
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  // WAL event
  const provider = getActiveProvider();
  db.prepare(
    `INSERT INTO wal_events (event_type, spec_id, payload) VALUES ('generate', ?, ?)`
  ).run(slug, JSON.stringify({
    title, domain: item.domain, storyCount: parsed.stories.length, provider, model: resolvedModel,
    hasSchema: !!ctx?.schema_snapshot, hasGitMemory: !!ctx?.git_memory,
    inputTokens: llmResult.usage.inputTokens, outputTokens: llmResult.usage.outputTokens,
  }));

  // Snapshot existing spec if regenerating
  const { pendingDir, approvedDir } = specsDirs(workspace.path);
  const existingPending = path.join(pendingDir, `${slug}.json`);
  const existingApproved = path.join(approvedDir, `${slug}.json`);
  if (fs.existsSync(existingPending)) {
    snapshotVersion(slug, fs.readFileSync(existingPending, 'utf8'), 'pending');
    fs.unlinkSync(existingPending);
  } else if (fs.existsSync(existingApproved)) {
    snapshotVersion(slug, fs.readFileSync(existingApproved, 'utf8'), 'approved');
    fs.unlinkSync(existingApproved);
  }

  // Write spec
  writeSpec(workspace.path, {
    slug,
    title,
    stories: parsed.stories as any,
    diagrams: allDiagrams as any,
    model: resolvedModel,
  });

  item.slug = slug;
}

/**
 * Process all briefs in a batch sequentially. Emits batch_progress WAL events
 * via broadcastAll so SSE subscribers get real-time updates.
 */
async function processBatch(batch: BatchState): Promise<void> {
  for (let i = 0; i < batch.items.length; i++) {
    const item = batch.items[i];
    item.status = 'generating';

    // Broadcast progress: generating
    const genWalResult = db.prepare(
      `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('batch_progress', ?, ?)`
    ).run(item.workspaceId, JSON.stringify({
      batchId: batch.id,
      briefIndex: i,
      totalBriefs: batch.items.length,
      status: 'generating',
    }));
    const genWalEvent = db.prepare('SELECT * FROM wal_events WHERE id = ?').get(
      genWalResult.lastInsertRowid
    ) as WalEvent;
    broadcastAll(genWalEvent);

    try {
      await processBatchBrief(item);
      // processBatchBrief may set status to 'failed' internally (e.g. workspace not found)
      if (item.status as string !== 'failed') {
        item.status = 'completed';
      }
    } catch (error: any) {
      item.status = 'failed';
      item.error = error.message;
    }

    // Broadcast progress: completed or failed
    const doneWalResult = db.prepare(
      `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('batch_progress', ?, ?)`
    ).run(item.workspaceId, JSON.stringify({
      batchId: batch.id,
      briefIndex: i,
      totalBriefs: batch.items.length,
      status: item.status,
      slug: item.slug,
      error: item.error,
    }));
    const doneWalEvent = db.prepare('SELECT * FROM wal_events WHERE id = ?').get(
      doneWalResult.lastInsertRowid
    ) as WalEvent;
    broadcastAll(doneWalEvent);
  }

  batch.finishedAt = new Date().toISOString();

  // Emit batch_finished WAL event
  const completed = batch.items.filter(i => i.status === 'completed').length;
  const failed = batch.items.filter(i => i.status === 'failed').length;
  const finishWalResult = db.prepare(
    `INSERT INTO wal_events (event_type, payload) VALUES ('batch_finished', ?)`
  ).run(JSON.stringify({
    batchId: batch.id,
    summary: { completed, failed, total: batch.items.length },
  }));
  const finishWalEvent = db.prepare('SELECT * FROM wal_events WHERE id = ?').get(
    finishWalResult.lastInsertRowid
  ) as WalEvent;
  broadcastAll(finishWalEvent);

  // Auto-clean batch from memory after 1 hour
  setTimeout(() => batchQueue.delete(batch.id), 60 * 60 * 1000);
}

router.post('/generate/batch', (req: Request, res: Response) => {
  try {
    const { briefs } = req.body as { briefs?: BatchRequestItem[] };

    if (!Array.isArray(briefs) || briefs.length === 0) {
      res.status(400).json({ error: 'Missing or empty briefs array' });
      return;
    }

    // Validate each brief has required fields
    for (let i = 0; i < briefs.length; i++) {
      const b = briefs[i];
      if (!b.title || !b.brief || !b.workspaceId) {
        res.status(400).json({ error: `Brief at index ${i} missing required fields: title, brief, workspaceId` });
        return;
      }
      // Model validation removed — any model string is accepted for openai-compat pass-through
    }

    const batchId = crypto.randomUUID();
    const batchUser = getEffectiveUser(req);
    if (!batchUser) { res.status(500).json({ error: 'No user configured' }); return; }
    const batch: BatchState = {
      id: batchId,
      items: briefs.map(b => ({
        brief: b.brief,
        workspaceId: b.workspaceId,
        templateId: b.templateId,
        title: b.title,
        model: b.model,
        storyCount: b.storyCount,
        domain: b.domain,
        userId: batchUser.id,
        status: 'queued' as const,
      })),
      createdAt: new Date().toISOString(),
    };

    batchQueue.set(batchId, batch);

    // Start processing asynchronously — don't await
    processBatch(batch).catch(err => {
      console.error('[Specs] Batch processing error:', err);
    });

    // Emit WAL event for batch start
    const walResult = db.prepare(
      `INSERT INTO wal_events (event_type, payload) VALUES ('batch_started', ?)`
    ).run(JSON.stringify({ batchId, briefCount: briefs.length }));
    const walEvent = db.prepare('SELECT * FROM wal_events WHERE id = ?').get(
      walResult.lastInsertRowid
    ) as WalEvent;
    broadcastAll(walEvent);

    res.status(201).json({ batchId, briefCount: briefs.length });
  } catch (error: any) {
    console.error('[Specs] Batch create error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── US-008: GET /generate/batch/:batchId — Batch status ─────────────────────

router.get('/generate/batch/:batchId', (req: Request, res: Response) => {
  try {
    const batchId = req.params.batchId as string;
    const batch = batchQueue.get(batchId);

    if (!batch) {
      res.status(404).json({ error: 'Batch not found or expired' });
      return;
    }

    const items = batch.items.map((item, index) => ({
      index,
      brief: item.brief,
      workspaceId: item.workspaceId,
      status: item.status,
      slug: item.slug,
      error: item.error,
    }));

    const completed = items.filter(i => i.status === 'completed').length;
    const failed = items.filter(i => i.status === 'failed').length;
    const generating = items.filter(i => i.status === 'generating').length;
    const queued = items.filter(i => i.status === 'queued').length;

    res.json({
      batchId: batch.id,
      createdAt: batch.createdAt,
      finishedAt: batch.finishedAt,
      totalBriefs: items.length,
      summary: { completed, failed, generating, queued },
      items,
    });
  } catch (error: any) {
    console.error('[Specs] Batch status error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── US-008: GET /generate/batch/:batchId/stream — SSE batch progress ─────────

router.get('/generate/batch/:batchId/stream', (req: Request, res: Response) => {
  const batchId = req.params.batchId as string;
  const batch = batchQueue.get(batchId);

  if (!batch) {
    res.status(404).json({ error: 'Batch not found or expired' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  // Send initial snapshot so late-joiners see current state
  const snapshot = batch.items.map((item, index) => ({
    index,
    status: item.status,
    slug: item.slug,
    error: item.error,
    title: item.title,
  }));
  res.write(`event: snapshot\ndata: ${JSON.stringify({
    batchId: batch.id,
    totalBriefs: batch.items.length,
    items: snapshot,
  })}\n\n`);

  // If batch is already finished, send done event and close
  if (batch.finishedAt) {
    const completed = batch.items.filter(i => i.status === 'completed').length;
    const failed = batch.items.filter(i => i.status === 'failed').length;
    res.write(`event: done\ndata: ${JSON.stringify({
      batchId: batch.id,
      summary: { completed, failed, total: batch.items.length },
    })}\n\n`);
    res.end();
    return;
  }

  // Subscribe to WAL events for batch_progress
  const unsubscribe = subscribe((event) => {
    if (event.event_type !== 'batch_progress' && event.event_type !== 'batch_finished') return;
    const payload = event.payload ? JSON.parse(event.payload) : {};
    if (payload.batchId !== batchId) return;
    res.write(`event: progress\ndata: ${JSON.stringify(payload)}\n\n`);
  });

  // Heartbeat every 15s
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 15_000);

  // Check for batch completion periodically
  const completionCheck = setInterval(() => {
    const currentBatch = batchQueue.get(batchId);
    if (currentBatch?.finishedAt) {
      const completed = currentBatch.items.filter(i => i.status === 'completed').length;
      const failed = currentBatch.items.filter(i => i.status === 'failed').length;
      res.write(`event: done\ndata: ${JSON.stringify({
        batchId: currentBatch.id,
        summary: { completed, failed, total: currentBatch.items.length },
      })}\n\n`);
      cleanup();
    }
  }, 2_000);

  function cleanup() {
    clearInterval(heartbeat);
    clearInterval(completionCheck);
    unsubscribe();
    res.end();
  }

  req.on('close', cleanup);
});

/**
 * @swagger
 * /api/specs:
 *   get:
 *     tags: [Specs]
 *     summary: List specs (pending/approved/all)
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [all, pending, approved], default: all }
 *       - in: query
 *         name: tags
 *         schema: { type: string }
 *         description: Comma-separated tag filter
 *       - in: query
 *         name: reviewStatus
 *         schema: { type: string, enum: [draft, review_requested, approved, changes_requested] }
 *       - in: query
 *         name: assignee
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: List of specs
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 specs:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       specName: { type: string }
 *                       storyCount: { type: integer }
 *                       status: { type: string, enum: [pending, approved] }
 *                       generatedAt: { type: string, format: date-time }
 *                       readinessPercent: { type: number }
 *                       tags: { type: array, items: { type: string } }
 *                       reviewStatus: { type: string }
 */
router.get('/', (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string;
    const statusFilter = (req.query.status as string) || 'all';

    if (!workspaceId) {
      res.status(400).json({ error: 'Missing required query param: workspaceId' });
      return;
    }

    const workspace = getWorkspace(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const specs: SpecSummary[] = [];

    // Parse optional tags filter (comma-separated, match ALL)
    const tagsParam = req.query.tags as string | undefined;
    const filterTags = tagsParam ? tagsParam.split(',').map(t => t.trim()).filter(Boolean) : [];

    if (statusFilter !== 'approved') {
      for (const file of safeReaddir(pendingDir)) {
        try {
          specs.push(buildSummary(path.join(pendingDir, file), file, 'pending', workspace.path, workspaceId));
        } catch {
          // skip unparseable files
        }
      }
    }

    if (statusFilter !== 'pending') {
      for (const file of safeReaddir(approvedDir)) {
        try {
          specs.push(buildSummary(path.join(approvedDir, file), file, 'approved', workspace.path, workspaceId));
        } catch {
          // skip unparseable files
        }
      }
    }

    // Filter by tags (must match ALL specified tags)
    let filtered = filterTags.length > 0
      ? specs.filter(s => filterTags.every(t => s.tags.includes(t)))
      : specs;

    // Filter by reviewStatus (e.g. ?reviewStatus=review_requested)
    const reviewStatusFilter = req.query.reviewStatus as string | undefined;
    if (reviewStatusFilter && VALID_REVIEW_STATUSES.includes(reviewStatusFilter as ReviewStatus)) {
      filtered = filtered.filter(s => s.reviewStatus === reviewStatusFilter);
    }

    // V2-042: Filter by assignee (user ID)
    const assigneeFilter = req.query.assignee as string | undefined;
    if (assigneeFilter) {
      const assignedSpecIds = new Set(
        (db.prepare(
          "SELECT DISTINCT spec_id FROM spec_assignments WHERE workspace_id = ? AND assignee_id = ? AND story_id = ''"
        ).all(workspaceId, assigneeFilter) as { spec_id: string }[]).map(r => r.spec_id)
      );
      filtered = filtered.filter(s => assignedSpecIds.has(s.id));
    }

    // Sort by generatedAt DESC
    filtered.sort((a, b) =>
      new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime()
    );

    const pagination = parsePaginationParams(req);
    res.json(paginateArray(filtered, pagination, { cursorKey: (s) => s.id }));
  } catch (error: any) {
    console.error('[Specs] List error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── W-003 / US-005: GET /archive — Full-text searchable spec archive ─────────

interface ArchiveSpecSummary extends SpecSummary {
  rejectedAt?: string;
  rejectReason?: string;
  storyTitles: string[];
  repoName: string;
  branchName?: string;
  forkedFrom?: string;
  matchSnippets?: MatchSnippet[];
  relevanceScore?: number;
}

interface MatchSnippet {
  field: 'title' | 'storyTitle' | 'storyDescription' | 'acceptanceCriteria';
  text: string;
  storyId?: string;
}

function buildArchiveSummary(
  filePath: string,
  fileName: string,
  status: 'pending' | 'approved',
  workspacePath: string,
  branchName?: string,
  workspaceId?: string,
): ArchiveSpecSummary {
  const base = buildSummary(filePath, fileName, status, workspacePath, workspaceId);
  const content = parseSpecFile(filePath);
  const stories = (content as any).userStories ?? (content as any).stories ?? [];
  const storyTitles = stories.map((s: any) => s.title ?? s.id ?? '').filter(Boolean);
  const repoName = path.basename(workspacePath);
  const forkedFrom = (content as any).forkedFrom as string | undefined;
  return { ...base, storyTitles, repoName, branchName, ...(forkedFrom ? { forkedFrom } : {}) };
}

/** Extract searchable text fields from a parsed spec */
function extractSearchableFields(content: any): {
  storyTitles: string;
  storyDescriptions: string;
  acceptanceCriteria: string;
} {
  const stories: any[] = content.userStories ?? content.stories ?? [];
  return {
    storyTitles: stories.map((s: any) => s.title ?? '').filter(Boolean).join(' | '),
    storyDescriptions: stories.map((s: any) => s.description ?? '').filter(Boolean).join(' | '),
    acceptanceCriteria: stories
      .flatMap((s: any) => s.acceptanceCriteria ?? [])
      .join(' | '),
  };
}

/** Rebuild FTS index for a workspace's specs from filesystem + WAL rejected specs */
function rebuildSearchIndex(workspaceId: string, workspacePath: string): void {
  // Clear existing entries for this workspace
  db.prepare(`DELETE FROM spec_search_index WHERE workspace_id = ?`).run(workspaceId);

  const { pendingDir, approvedDir } = specsDirs(workspacePath);

  // Index pending specs
  for (const file of safeReaddir(pendingDir)) {
    try {
      const filePath = path.join(pendingDir, file);
      const content = parseSpecFile(filePath);
      const slug = file.replace('.json', '');
      const fields = extractSearchableFields(content);
      const stat = fs.statSync(filePath);
      db.prepare(
        `INSERT INTO spec_search_index (spec_slug, workspace_id, spec_title, story_titles, story_descriptions, acceptance_criteria, status, generated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(slug, workspaceId, content.title ?? slug, fields.storyTitles, fields.storyDescriptions, fields.acceptanceCriteria, 'pending', content.generatedAt ?? stat.birthtime.toISOString());
    } catch {
      // skip unparseable
    }
  }

  // Index approved specs
  for (const file of safeReaddir(approvedDir)) {
    try {
      const filePath = path.join(approvedDir, file);
      const content = parseSpecFile(filePath);
      const slug = file.replace('.json', '');
      const fields = extractSearchableFields(content);
      const stat = fs.statSync(filePath);
      db.prepare(
        `INSERT INTO spec_search_index (spec_slug, workspace_id, spec_title, story_titles, story_descriptions, acceptance_criteria, status, generated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(slug, workspaceId, content.title ?? slug, fields.storyTitles, fields.storyDescriptions, fields.acceptanceCriteria, 'approved', content.generatedAt ?? stat.birthtime.toISOString());
    } catch {
      // skip unparseable
    }
  }

  // Index rejected specs from WAL (most recent rejection per slug only)
  const rejectedEvents = db.prepare(
    `SELECT spec_id, ts, payload FROM wal_events
     WHERE event_type = 'spec_rejected' AND payload LIKE '%' || ? || '%'
     ORDER BY ts DESC`
  ).all(workspaceId) as { spec_id: string; ts: string; payload: string }[];

  const seenRejected = new Set<string>();
  for (const evt of rejectedEvents) {
    if (seenRejected.has(evt.spec_id)) continue;
    seenRejected.add(evt.spec_id);

    // Skip if a pending/approved spec already covers this slug
    const existing = db.prepare(
      `SELECT spec_slug FROM spec_search_index WHERE spec_slug = ? AND workspace_id = ?`
    ).get(evt.spec_id, workspaceId);
    if (existing) continue;

    // Try to get content from spec_versions for richer indexing
    const versionRow = db.prepare(
      `SELECT content_json FROM spec_versions WHERE spec_slug = ? ORDER BY version DESC LIMIT 1`
    ).get(evt.spec_id) as { content_json: string } | undefined;

    if (versionRow) {
      const content = JSON.parse(versionRow.content_json);
      const fields = extractSearchableFields(content);
      db.prepare(
        `INSERT INTO spec_search_index (spec_slug, workspace_id, spec_title, story_titles, story_descriptions, acceptance_criteria, status, generated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(evt.spec_id, workspaceId, content.title ?? evt.spec_id, fields.storyTitles, fields.storyDescriptions, fields.acceptanceCriteria, 'rejected', evt.ts);
    } else {
      // Minimal entry from WAL event only
      db.prepare(
        `INSERT INTO spec_search_index (spec_slug, workspace_id, spec_title, story_titles, story_descriptions, acceptance_criteria, status, generated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(evt.spec_id, workspaceId, evt.spec_id, '', '', '', 'rejected', evt.ts);
    }
  }
}

/** Generate match snippets showing which fields matched the query */
function generateSnippets(spec: ArchiveSpecSummary, query: string, content: any): MatchSnippet[] {
  const snippets: MatchSnippet[] = [];
  const lower = query.toLowerCase();
  const stories: any[] = content?.userStories ?? content?.stories ?? [];

  // Check spec title
  if (spec.specName.toLowerCase().includes(lower)) {
    snippets.push({ field: 'title', text: highlightMatch(spec.specName, query) });
  }

  // Check story titles
  for (const story of stories) {
    const title = story.title ?? '';
    if (title.toLowerCase().includes(lower)) {
      snippets.push({ field: 'storyTitle', text: highlightMatch(title, query), storyId: story.id });
    }
  }

  // Check story descriptions
  for (const story of stories) {
    const desc = story.description ?? '';
    if (desc.toLowerCase().includes(lower)) {
      snippets.push({ field: 'storyDescription', text: highlightMatch(desc, query), storyId: story.id });
    }
  }

  // Check acceptance criteria
  for (const story of stories) {
    for (const ac of story.acceptanceCriteria ?? []) {
      if (ac.toLowerCase().includes(lower)) {
        snippets.push({ field: 'acceptanceCriteria', text: highlightMatch(ac, query), storyId: story.id });
      }
    }
  }

  return snippets;
}

/** Wrap matching text in <mark> tags for highlighting */
function highlightMatch(text: string, query: string): string {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`(${escaped})`, 'gi'), '<mark>$1</mark>');
}

/** Compute relevance score: title matches weighted higher */
function computeRelevanceScore(snippets: MatchSnippet[]): number {
  let score = 0;
  for (const s of snippets) {
    switch (s.field) {
      case 'title': score += 10; break;
      case 'storyTitle': score += 5; break;
      case 'storyDescription': score += 2; break;
      case 'acceptanceCriteria': score += 1; break;
    }
  }
  return score;
}

/**
 * @swagger
 * /api/specs/archive:
 *   get:
 *     tags: [Specs]
 *     summary: Search spec archive with pagination
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: q
 *         schema: { type: string }
 *         description: Full-text search query
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [all, pending, approved, rejected] }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *       - in: query
 *         name: createdAfter
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: createdBefore
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: tags
 *         schema: { type: string }
 *         description: Comma-separated tag filter
 *     responses:
 *       200:
 *         description: Paginated archive results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 specs: { type: array, items: { type: object } }
 *                 total: { type: integer }
 *                 hasMore: { type: boolean }
 */
router.get('/archive', (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string;
    const q = (req.query.q as string) || '';
    const statusFilter = (req.query.status as string) || 'all';
    const pagination = parsePaginationParams(req, { limit: 50, maxLimit: 200 });
    const createdAfter = req.query.createdAfter as string | undefined;
    const createdBefore = req.query.createdBefore as string | undefined;
    const tagsParam = req.query.tags as string | undefined;
    const filterTags = tagsParam ? tagsParam.split(',').map(t => t.trim()).filter(Boolean) : [];

    if (!workspaceId) {
      res.status(400).json({ error: 'Missing required query param: workspaceId' });
      return;
    }

    const workspace = getWorkspace(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const { pendingDir, approvedDir } = specsDirs(workspace.path);

    // Rebuild FTS index for this workspace (fast: synchronous SQLite ops on local files)
    rebuildSearchIndex(workspaceId, workspace.path);

    // Look up most recent branch_name per spec slug from pipeline_runs
    const branchRows = db.prepare(
      `SELECT spec_path, branch_name FROM pipeline_runs
       WHERE workspace_id = ? AND branch_name IS NOT NULL
       ORDER BY id DESC`
    ).all(workspaceId) as { spec_path: string; branch_name: string }[];
    const branchBySlug = new Map<string, string>();
    for (const row of branchRows) {
      const slug = path.basename(row.spec_path, '.json');
      if (!branchBySlug.has(slug)) branchBySlug.set(slug, row.branch_name);
    }

    // Fall back to current git branch for specs that have no worktree branch
    let currentBranch: string | undefined;
    try {
      const branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: workspace.path, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8',
      }).trim();
      if (branch && branch !== 'HEAD') currentBranch = branch;
    } catch { /* not a git repo or git unavailable */ }

    // Determine matching slugs via FTS or collect all
    let matchingSlugs: Set<string> | null = null;
    if (q) {
      // Use FTS5 for full-text search — escape quotes in query
      const ftsQuery = q.replace(/"/g, '""');
      const ftsRows = db.prepare(
        `SELECT spec_slug FROM spec_search_index
         WHERE workspace_id = ? AND spec_search_index MATCH ?`
      ).all(workspaceId, `"${ftsQuery}"`) as { spec_slug: string }[];
      matchingSlugs = new Set(ftsRows.map(r => r.spec_slug));
    }

    const allSpecs: ArchiveSpecSummary[] = [];

    // Collect pending specs
    if (statusFilter === 'all' || statusFilter === 'pending') {
      for (const file of safeReaddir(pendingDir)) {
        try {
          const slug = path.basename(file, '.json');
          if (matchingSlugs && !matchingSlugs.has(slug)) continue;
          allSpecs.push(buildArchiveSummary(path.join(pendingDir, file), file, 'pending', workspace.path, branchBySlug.get(slug) ?? currentBranch, workspaceId));
        } catch {
          // skip unparseable files
        }
      }
    }

    // Collect approved specs
    if (statusFilter === 'all' || statusFilter === 'approved') {
      for (const file of safeReaddir(approvedDir)) {
        try {
          const slug = path.basename(file, '.json');
          if (matchingSlugs && !matchingSlugs.has(slug)) continue;
          allSpecs.push(buildArchiveSummary(path.join(approvedDir, file), file, 'approved', workspace.path, branchBySlug.get(slug) ?? currentBranch, workspaceId));
        } catch {
          // skip unparseable files
        }
      }
    }

    // Collect rejected specs from WAL events
    if (statusFilter === 'all' || statusFilter === 'rejected') {
      const rejectedEvents = db.prepare(
        `SELECT spec_id, ts, payload FROM wal_events
         WHERE event_type = 'spec_rejected'
         AND payload LIKE '%' || ? || '%'
         ORDER BY ts DESC`
      ).all(workspaceId) as { spec_id: string; ts: string; payload: string }[];

      const seenRejected = new Set<string>();
      for (const evt of rejectedEvents) {
        if (seenRejected.has(evt.spec_id)) continue;
        seenRejected.add(evt.spec_id);
        if (allSpecs.some(s => s.id === evt.spec_id)) continue;
        if (matchingSlugs && !matchingSlugs.has(evt.spec_id)) continue;

        const payload = JSON.parse(evt.payload);
        allSpecs.push({
          id: evt.spec_id,
          specName: evt.spec_id,
          storyCount: 0,
          status: 'rejected' as any,
          generatedAt: evt.ts,
          rejectedAt: evt.ts,
          rejectReason: payload.reason ?? undefined,
          workspacePath: workspace.path,
          repoName: path.basename(workspace.path),
          storyTitles: [],
          readinessPercent: 0,
          tags: getSpecTags(evt.spec_id, workspaceId),
          reviewStatus: 'draft' as ReviewStatus,
        });
      }
    }

    // Apply date range filters
    let filtered = allSpecs;
    if (createdAfter) {
      const afterDate = new Date(createdAfter).getTime();
      filtered = filtered.filter(s => new Date(s.generatedAt).getTime() >= afterDate);
    }
    if (createdBefore) {
      const beforeDate = new Date(createdBefore).getTime();
      filtered = filtered.filter(s => new Date(s.generatedAt).getTime() <= beforeDate);
    }

    // Apply tag filter (must match ALL specified tags)
    if (filterTags.length > 0) {
      filtered = filtered.filter(s => filterTags.every(t => s.tags.includes(t)));
    }

    // If searching, generate snippets and rank by relevance
    if (q) {
      for (const spec of filtered) {
        // Load spec content for snippet generation
        let content: any = null;
        const pendingFile = path.join(pendingDir, `${spec.id}.json`);
        const approvedFile = path.join(approvedDir, `${spec.id}.json`);
        try {
          if (fs.existsSync(pendingFile)) content = parseSpecFile(pendingFile);
          else if (fs.existsSync(approvedFile)) content = parseSpecFile(approvedFile);
          else {
            // Rejected spec — try spec_versions
            const vRow = db.prepare(
              `SELECT content_json FROM spec_versions WHERE spec_slug = ? ORDER BY version DESC LIMIT 1`
            ).get(spec.id) as { content_json: string } | undefined;
            if (vRow) content = JSON.parse(vRow.content_json);
          }
        } catch {
          // skip
        }

        const snippets = generateSnippets(spec, q, content);
        spec.matchSnippets = snippets;
        spec.relevanceScore = computeRelevanceScore(snippets);
      }

      // Sort by relevance DESC, then generatedAt DESC for tie-breaking
      filtered.sort((a, b) => {
        const scoreDiff = (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0);
        if (scoreDiff !== 0) return scoreDiff;
        return new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime();
      });
    } else {
      // No search — sort by generatedAt DESC
      filtered.sort((a, b) =>
        new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime()
      );
    }

    // Paginate
    res.json(paginateArray(filtered, pagination, { cursorKey: (s) => s.id }));
  } catch (error: any) {
    console.error('[Specs] Archive error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── V2-067: GET /search/stories — Cross-spec story search ────────────────────

router.get('/search/stories', (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string | undefined;
    const query = req.query.q as string | undefined;

    if (!workspaceId) {
      res.status(400).json({ error: 'Missing required query param: workspaceId' });
      return;
    }
    if (!query || query.trim().length === 0) {
      res.status(400).json({ error: 'Missing required query param: q (search query)' });
      return;
    }

    const workspace = getWorkspace(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const queryLower = query.toLowerCase();
    const results: Array<{
      specId: string;
      specTitle: string;
      status: string;
      story: UserStory;
      matchFields: string[];
    }> = [];

    for (const [dir, status] of [[pendingDir, 'pending'], [approvedDir, 'approved']] as const) {
      for (const file of safeReaddir(dir)) {
        const specId = file.replace('.json', '');
        const filePath = path.join(dir, file);
        try {
          const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          const specTitle = content.title ?? specId;
          const stories: UserStory[] = content.userStories ?? [];

          for (const story of stories) {
            const matchFields: string[] = [];
            if (story.id?.toLowerCase().includes(queryLower)) matchFields.push('id');
            if (story.title?.toLowerCase().includes(queryLower)) matchFields.push('title');
            if (story.description?.toLowerCase().includes(queryLower)) matchFields.push('description');
            if (story.acceptanceCriteria?.some(ac => ac.toLowerCase().includes(queryLower))) matchFields.push('acceptanceCriteria');

            if (matchFields.length > 0) {
              results.push({ specId, specTitle, status, story, matchFields });
            }
          }
        } catch {
          // Skip unparseable spec files
        }
      }
    }

    const pagination = parsePaginationParams(req);
    res.json(paginateArray(results, pagination));
  } catch (error: any) {
    console.error('[Specs] Story search error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /:specId/add-stories — Generate more stories for an existing spec ───

router.post('/:specId/add-stories', async (req: Request, res: Response) => {
  try {
    const { specId } = req.params;
    const { workspaceId, count, brief } = req.body;

    const storyCount = Math.min(20, Math.max(1, parseInt(count) || 3));

    if (!workspaceId) {
      res.status(400).json({ error: 'Missing required field: workspaceId' });
      return;
    }

    const workspace = getWorkspace(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const pendingFile = path.join(pendingDir, `${specId}.json`);
    const approvedFile = path.join(approvedDir, `${specId}.json`);

    let specFilePath: string;
    if (fs.existsSync(approvedFile)) specFilePath = approvedFile;
    else if (fs.existsSync(pendingFile)) specFilePath = pendingFile;
    else { res.status(404).json({ error: 'Spec not found' }); return; }

    const specContent = JSON.parse(fs.readFileSync(specFilePath, 'utf8'));
    const existingStories: Array<{ id: string; title: string }> =
      specContent.userStories ?? specContent.stories ?? [];

    const storyPrefix = existingStories[0]?.id?.match(/^([A-Z]+)/)?.[1] ?? 'US';
    const maxN = existingStories.reduce((max, s) => {
      const n = parseInt(s.id?.replace(/\D/g, '') || '0', 10);
      return n > max ? n : max;
    }, 0);
    const startN = maxN + 1;

    const l1Row = db.prepare(
      `SELECT content_yaml FROM direction_layers WHERE layer = 1 AND COALESCE(workspace_id, '') = '' AND COALESCE(domain, '') = ''`
    ).get() as { content_yaml: string } | undefined;
    const l3Row = db.prepare(
      `SELECT content_yaml FROM direction_layers WHERE layer = 3 AND workspace_id = ? AND COALESCE(domain, '') = ''`
    ).get(workspaceId) as { content_yaml: string } | undefined;

    const { synthesize } = await import('../lib/direction-stack');
    const synthesized = synthesize({ l1: l1Row?.content_yaml, l3: l3Row?.content_yaml, specBrief: specContent.title ?? specId });

    const existingList = existingStories.map(s => `- ${s.id}: ${s.title}`).join('\n');

    const fullPrompt = [
      '=== INSTRUCTIONS: READ THIS FIRST ===',
      'You are a spec writer. Your ONLY job is to output a single valid JSON object.',
      'Do NOT explain. Do NOT ask questions. Do NOT add markdown fences. Do NOT converse.',
      'Output ONLY the raw JSON object. If you output anything else, you have failed.',
      '=== END INSTRUCTIONS ===',
      '',
      synthesized,
      '---',
      `TASK: Add ${storyCount} NEW user stories to an existing spec.`,
      `Spec title: ${specContent.title ?? specId}`,
      brief ? `Additional brief: ${brief}` : '',
      '',
      'Existing stories (do NOT duplicate these):',
      existingList,
      '',
      `Generate exactly ${storyCount} new stories, numbered ${storyPrefix}-${String(startN).padStart(3, '0')} through ${storyPrefix}-${String(startN + storyCount - 1).padStart(3, '0')}.`,
      '',
      'OUTPUT FORMAT: Respond with ONLY a raw JSON object. No markdown. No preamble. Start with { and end with }.',
      'JSON schema: {"stories":[{"id":"string","title":"string","description":"string","acceptanceCriteria":["string"],"dependsOn":["string"]}]}',
      'Rules: 3-5 testable acceptanceCriteria per story. dependsOn lists IDs this story requires first (empty array if none). Analyze story content to determine dependencies — if a new story references components, APIs, or data models from existing stories, add those to dependsOn.',
    ].filter(Boolean).join('\n');

    const { chatComplete: chatCompleteFn } = await import('../lib/llm-client');
    const addStoriesUser = getEffectiveUser(req);
    if (!addStoriesUser) { res.status(500).json({ error: 'No user configured' }); return; }
    const addStoriesVaultCreds = resolveVaultCreds(addStoriesUser.id, DEFAULT_MODEL);
    const rawResponse = await chatCompleteFn(
      [{ role: 'user', content: fullPrompt }],
      { apiKey: addStoriesVaultCreds.apiKey, baseUrl: addStoriesVaultCreds.baseUrl },
    );

    let parsed: { stories: unknown[] };
    try {
      const responseText = rawResponse.text;
      const fenceMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
      const jsonStr = fenceMatch ? fenceMatch[1].trim() : responseText.trim();
      const jsonStart = jsonStr.indexOf('{');
      parsed = JSON.parse(jsonStart > 0 ? jsonStr.slice(jsonStart) : jsonStr);
    } catch {
      res.status(500).json({ error: 'LLM returned non-JSON', raw: rawResponse.text });
      return;
    }

    if (!Array.isArray(parsed.stories)) {
      res.status(500).json({ error: 'Invalid structure from LLM' });
      return;
    }

    const newStories = parsed.stories;
    specContent.userStories = [...existingStories, ...newStories];

    // Regenerate mermaidDiagram with all stories
    const { generateStoryDepsDiagram } = await import('../lib/diagram-generator');
    const depsDiagram = generateStoryDepsDiagram(specContent.userStories);
    specContent.mermaidDiagram = depsDiagram.mermaid;

    fs.writeFileSync(specFilePath, JSON.stringify(specContent, null, 2), 'utf8');

    res.json({ ok: true, addedCount: newStories.length, stories: newStories });
  } catch (error: any) {
    console.error('[Specs] Add stories error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── US-001: GET /:specId/versions — List all versions for a spec slug ────────

router.get('/:specId/versions', (req: Request, res: Response) => {
  try {
    const { specId } = req.params;

    const rows = db.prepare(
      `SELECT id, spec_slug, version, content_json, status, rejection_reason, created_at
       FROM spec_versions WHERE spec_slug = ? ORDER BY version ASC`
    ).all(specId) as SpecVersionRow[];

    const versions = rows.map(row => {
      const content = JSON.parse(row.content_json);
      const stories = content.userStories ?? content.stories ?? [];
      return {
        version: row.version,
        status: row.status,
        rejectionReason: row.rejection_reason,
        createdAt: row.created_at,
        title: content.title ?? specId,
        storyCount: Array.isArray(stories) ? stories.length : 0,
      };
    });

    const pagination = parsePaginationParams(req);
    res.json(paginateArray(versions, pagination));
  } catch (error: any) {
    console.error('[Specs] Versions error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── US-001: GET /:specId/diff — Structured diff between two versions ─────────

router.get('/:specId/diff', (req: Request, res: Response) => {
  try {
    const { specId } = req.params;
    const v1 = parseInt(req.query.v1 as string);
    const v2 = parseInt(req.query.v2 as string);

    if (isNaN(v1) || isNaN(v2)) {
      res.status(400).json({ error: 'Missing or invalid query params: v1 and v2 must be integers' });
      return;
    }

    if (v1 === v2) {
      res.status(400).json({ error: 'v1 and v2 must be different versions' });
      return;
    }

    const row1 = db.prepare(
      'SELECT content_json, status, rejection_reason, created_at FROM spec_versions WHERE spec_slug = ? AND version = ?'
    ).get(specId, v1) as { content_json: string; status: string; rejection_reason: string | null; created_at: string } | undefined;

    const row2 = db.prepare(
      'SELECT content_json, status, rejection_reason, created_at FROM spec_versions WHERE spec_slug = ? AND version = ?'
    ).get(specId, v2) as { content_json: string; status: string; rejection_reason: string | null; created_at: string } | undefined;

    if (!row1 || !row2) {
      const missing = !row1 && !row2 ? `v${v1} and v${v2}` : !row1 ? `v${v1}` : `v${v2}`;
      res.status(404).json({ error: `Version(s) not found: ${missing}` });
      return;
    }

    const content1 = JSON.parse(row1.content_json);
    const content2 = JSON.parse(row2.content_json);

    const diff = computeSpecDiff(content1, content2);

    res.json({
      specSlug: specId,
      v1: { version: v1, status: row1.status, createdAt: row1.created_at },
      v2: { version: v2, status: row2.status, createdAt: row2.created_at },
      diff,
    });
  } catch (error: any) {
    console.error('[Specs] Diff error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /:specId/versions/:version/restore — Restore a historical version ──

router.post('/:specId/versions/:version/restore', (req: Request, res: Response) => {
  try {
    const specId = req.params.specId as string;
    const version = req.params.version as string;
    const { workspaceId } = req.body;
    const versionNum = parseInt(version);

    if (!workspaceId) {
      res.status(400).json({ error: 'Missing required field: workspaceId' });
      return;
    }

    if (isNaN(versionNum)) {
      res.status(400).json({ error: 'Invalid version number' });
      return;
    }

    const workspace = getWorkspace(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    // Fetch the version to restore
    const row = db.prepare(
      'SELECT content_json, status FROM spec_versions WHERE spec_slug = ? AND version = ?'
    ).get(specId, versionNum) as { content_json: string; status: string } | undefined;

    if (!row) {
      res.status(404).json({ error: `Version ${versionNum} not found for spec ${specId}` });
      return;
    }

    const restoredContent = JSON.parse(row.content_json);

    // Find the current spec file and snapshot it before overwriting
    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const pendingPath = path.join(pendingDir, `${specId}.json`);
    const approvedPath = path.join(approvedDir, `${specId}.json`);
    const currentPath = fs.existsSync(approvedPath) ? approvedPath : fs.existsSync(pendingPath) ? pendingPath : null;
    const currentStatus = currentPath === approvedPath ? 'approved' : 'pending';

    if (currentPath) {
      // Snapshot current state before overwriting
      const currentContent = fs.readFileSync(currentPath, 'utf8');
      snapshotVersion(specId, currentContent, currentStatus);
    }

    // Write restored content to the current location (or pending if no file exists)
    const targetPath = currentPath ?? pendingPath;
    const targetDir = path.dirname(targetPath);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // Add restoration metadata
    restoredContent.restoredFrom = versionNum;
    restoredContent.restoredAt = new Date().toISOString();

    fs.writeFileSync(targetPath, JSON.stringify(restoredContent, null, 2), 'utf8');

    // Snapshot the restored version
    const newVersion = snapshotVersion(specId, JSON.stringify(restoredContent), currentStatus);

    // Emit WAL event
    db.prepare(
      `INSERT INTO wal_events (event_type, spec_id, workspace_id, payload) VALUES (?, ?, ?, ?)`
    ).run('version_restored', specId, workspaceId, JSON.stringify({
      restoredFromVersion: versionNum,
      newVersion,
    }));

    res.json({ ok: true, newVersion, restoredFromVersion: versionNum });
  } catch (error: any) {
    console.error('[Specs] Restore version error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── PATCH /:specId/stories/:storyId — Toggle excluded flag ──────────────────

router.patch('/:specId/stories/:storyId', (req: Request, res: Response) => {
  try {
    const specId = req.params.specId as string;
    const storyId = req.params.storyId as string;
    const { workspaceId, excluded, title, description, acceptanceCriteria } = req.body;

    if (!workspaceId) {
      res.status(400).json({ error: 'Missing required field: workspaceId' });
      return;
    }

    const workspace = getWorkspace(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const approvedFile = path.join(approvedDir, `${specId}.json`);
    const pendingFile = path.join(pendingDir, `${specId}.json`);

    // Determine if this is a field edit (title/description/acceptanceCriteria) vs exclude toggle
    const isFieldEdit = title !== undefined || description !== undefined || acceptanceCriteria !== undefined;

    if (isFieldEdit) {
      // EQ-006: Field edits only allowed on pending specs
      if (fs.existsSync(approvedFile)) {
        res.status(403).json({ error: 'Cannot edit stories in an approved spec. Only pending specs may be edited.' });
        return;
      }
      if (!fs.existsSync(pendingFile)) {
        res.status(404).json({ error: 'Spec not found' });
        return;
      }

      const raw = fs.readFileSync(pendingFile, 'utf8');
      const content = JSON.parse(raw);
      const stories: UserStory[] = content.userStories ?? [];
      const storyIndex = stories.findIndex((s: UserStory) => s.id === storyId);

      if (storyIndex === -1) {
        res.status(404).json({ error: 'Story not found' });
        return;
      }

      // Snapshot pre-edit state as a new version
      const version = snapshotVersion(specId, raw, 'pending');

      // Apply only provided fields
      if (title !== undefined) stories[storyIndex].title = title;
      if (description !== undefined) stories[storyIndex].description = description;
      if (acceptanceCriteria !== undefined) stories[storyIndex].acceptanceCriteria = acceptanceCriteria;

      content.userStories = stories;
      fs.writeFileSync(pendingFile, JSON.stringify(content, null, 2) + '\n');

      // WAL event
      const walResult = db.prepare(
        `INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, actor, payload) VALUES (?, ?, ?, ?, 'api', ?)`
      ).run('story_edited', workspaceId, specId, storyId, JSON.stringify({
        title: stories[storyIndex].title,
        version,
      }));

      broadcastAll({
        id: walResult.lastInsertRowid as number,
        ts: new Date().toISOString(),
        event_type: 'story_edited',
        workspace_id: workspaceId as string,
        spec_id: specId as string,
        story_id: storyId as string,
        actor: 'api',
        payload: JSON.stringify({ title: stories[storyIndex].title, version }),
      });

      res.json({ ok: true, story: stories[storyIndex], version });
      return;
    }

    // Original exclude toggle behavior
    let specPath: string;
    if (fs.existsSync(approvedFile)) {
      specPath = approvedFile;
    } else if (fs.existsSync(pendingFile)) {
      specPath = pendingFile;
    } else {
      res.status(404).json({ error: 'Spec not found' });
      return;
    }

    const content = JSON.parse(fs.readFileSync(specPath, 'utf8'));
    const stories: UserStory[] = content.userStories ?? [];
    const story = stories.find((s: UserStory) => s.id === storyId);

    if (!story) {
      res.status(404).json({ error: 'Story not found' });
      return;
    }

    story.excluded = excluded === true;
    fs.writeFileSync(specPath, JSON.stringify(content, null, 2) + '\n');

    const eventType = excluded ? 'story_excluded' : 'story_included';
    const walResult = db.prepare(
      `INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, actor, payload) VALUES (?, ?, ?, ?, 'api', ?)`
    ).run(eventType, workspaceId, specId, storyId, JSON.stringify({ excluded: story.excluded }));

    broadcastAll({
      id: walResult.lastInsertRowid as number,
      ts: new Date().toISOString(),
      event_type: eventType,
      workspace_id: workspaceId as string,
      spec_id: specId as string,
      story_id: storyId as string,
      actor: 'api',
      payload: JSON.stringify({ excluded: story.excluded }),
    });

    res.json({ ok: true, story });
  } catch (error: any) {
    console.error('[Specs] Toggle exclude error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── V2-008: PUT /:specId/stories/:storyId — Update a single story ───────────

router.put('/:specId/stories/:storyId', (req: Request, res: Response) => {
  try {
    const specId = req.params.specId as string;
    const storyId = req.params.storyId as string;
    const { workspaceId, title, description, acceptanceCriteria, complexity, priority, timeoutMinutes } = req.body;

    if (!workspaceId) {
      res.status(400).json({ error: 'Missing required field: workspaceId' });
      return;
    }

    if (complexity !== undefined && (!Number.isInteger(complexity) || complexity < 1 || complexity > 5)) {
      res.status(400).json({ error: 'complexity must be an integer between 1 and 5' });
      return;
    }

    if (priority !== undefined && (!Number.isInteger(priority) || priority < 1 || priority > 4)) {
      res.status(400).json({ error: 'priority must be an integer between 1 (urgent) and 4 (low)' });
      return;
    }

    if (timeoutMinutes !== undefined && (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 5 || timeoutMinutes > 120)) {
      res.status(400).json({ error: 'timeoutMinutes must be an integer between 5 and 120' });
      return;
    }

    const workspace = getWorkspace(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const approvedFile = path.join(approvedDir, `${specId}.json`);
    const pendingFile = path.join(pendingDir, `${specId}.json`);

    let specPath: string;
    if (fs.existsSync(approvedFile)) {
      specPath = approvedFile;
    } else if (fs.existsSync(pendingFile)) {
      specPath = pendingFile;
    } else {
      res.status(404).json({ error: 'Spec not found' });
      return;
    }

    const raw = fs.readFileSync(specPath, 'utf8');
    const content = JSON.parse(raw);
    const stories: UserStory[] = content.userStories ?? [];
    const storyIndex = stories.findIndex((s: UserStory) => s.id === storyId);

    if (storyIndex === -1) {
      res.status(404).json({ error: 'Story not found' });
      return;
    }

    // Snapshot pre-edit state as a new version
    const status = fs.existsSync(approvedFile) ? 'approved' : 'pending';
    const version = snapshotVersion(specId, raw, status);

    // Apply edits — only update provided fields
    if (title !== undefined) stories[storyIndex].title = title;
    if (description !== undefined) stories[storyIndex].description = description;
    if (acceptanceCriteria !== undefined) stories[storyIndex].acceptanceCriteria = acceptanceCriteria;
    if (complexity !== undefined) stories[storyIndex].complexity = complexity;
    if (priority !== undefined) stories[storyIndex].priority = priority;
    if (timeoutMinutes !== undefined) stories[storyIndex].timeoutMinutes = timeoutMinutes;

    content.userStories = stories;
    fs.writeFileSync(specPath, JSON.stringify(content, null, 2) + '\n');

    // WAL event
    const walResult = db.prepare(
      `INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, actor, payload) VALUES (?, ?, ?, ?, 'api', ?)`
    ).run('story_edited', workspaceId, specId, storyId, JSON.stringify({
      title: stories[storyIndex].title,
      version,
    }));

    broadcastAll({
      id: walResult.lastInsertRowid as number,
      ts: new Date().toISOString(),
      event_type: 'story_edited',
      workspace_id: workspaceId as string,
      spec_id: specId as string,
      story_id: storyId as string,
      actor: 'api',
      payload: JSON.stringify({ title: stories[storyIndex].title, version }),
    });

    res.json({ ok: true, story: stories[storyIndex], version });
  } catch (error: any) {
    console.error('[Specs] Story update error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── V2-067: DELETE /:specId/stories/:storyId — Remove a single story ─────────

router.delete('/:specId/stories/:storyId', (req: Request, res: Response) => {
  try {
    const specId = req.params.specId as string;
    const storyId = req.params.storyId as string;
    const workspaceId = (req.query.workspaceId ?? req.body?.workspaceId) as string | undefined;

    if (!workspaceId) {
      res.status(400).json({ error: 'Missing required field: workspaceId' });
      return;
    }

    const workspace = getWorkspace(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const approvedFile = path.join(approvedDir, `${specId}.json`);
    const pendingFile = path.join(pendingDir, `${specId}.json`);

    let specPath: string;
    if (fs.existsSync(approvedFile)) {
      specPath = approvedFile;
    } else if (fs.existsSync(pendingFile)) {
      specPath = pendingFile;
    } else {
      res.status(404).json({ error: 'Spec not found' });
      return;
    }

    const raw = fs.readFileSync(specPath, 'utf8');
    const content = JSON.parse(raw);
    const stories: UserStory[] = content.userStories ?? [];
    const storyIndex = stories.findIndex((s: UserStory) => s.id === storyId);

    if (storyIndex === -1) {
      res.status(404).json({ error: `Story ${storyId} not found in spec ${specId}` });
      return;
    }

    const deletedStory = stories[storyIndex];

    // Snapshot pre-delete state
    const status = fs.existsSync(approvedFile) ? 'approved' : 'pending';
    const version = snapshotVersion(specId, raw, status);

    // Remove and reindex
    stories.splice(storyIndex, 1);
    const storyPrefix = deletedStory.id.match(/^([A-Z]+)/)?.[1] ?? 'US';
    const reindexed = stories.map((s, i) => ({
      ...s,
      id: `${storyPrefix}-${String(i + 1).padStart(3, '0')}`,
      dependsOn: (s.dependsOn ?? [])
        .filter(dep => dep !== storyId)
        .map(dep => {
          const origIndex = stories.findIndex(os => os.id === dep);
          return origIndex >= 0 ? `${storyPrefix}-${String(origIndex + 1).padStart(3, '0')}` : dep;
        }),
    }));

    content.userStories = reindexed;
    fs.writeFileSync(specPath, JSON.stringify(content, null, 2) + '\n');

    // WAL event
    const walResult = db.prepare(
      `INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, actor, payload) VALUES (?, ?, ?, ?, 'api', ?)`
    ).run('story_deleted', workspaceId, specId, storyId, JSON.stringify({
      deletedTitle: deletedStory.title,
      version,
    }));

    broadcastAll({
      id: walResult.lastInsertRowid as number,
      ts: new Date().toISOString(),
      event_type: 'story_deleted',
      workspace_id: workspaceId,
      spec_id: specId,
      story_id: storyId,
      actor: 'api',
      payload: JSON.stringify({ deletedTitle: deletedStory.title, version }),
    });

    res.json({ ok: true, deletedStory, version, remainingCount: reindexed.length });
  } catch (error: any) {
    console.error('[Specs] Story delete error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── V2-008: POST /:specId/stories/:storyId/rewrite — AI-assisted rewrite ────

router.post('/:specId/stories/:storyId/rewrite', async (req: Request, res: Response) => {
  try {
    const specId = req.params.specId as string;
    const storyId = req.params.storyId as string;
    const { workspaceId, instructions, model } = req.body;

    if (!workspaceId) {
      res.status(400).json({ error: 'Missing required field: workspaceId' });
      return;
    }

    const workspace = getWorkspace(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const approvedFile = path.join(approvedDir, `${specId}.json`);
    const pendingFile = path.join(pendingDir, `${specId}.json`);

    let specPath: string;
    if (fs.existsSync(approvedFile)) {
      specPath = approvedFile;
    } else if (fs.existsSync(pendingFile)) {
      specPath = pendingFile;
    } else {
      res.status(404).json({ error: 'Spec not found' });
      return;
    }

    const raw = fs.readFileSync(specPath, 'utf8');
    const content = JSON.parse(raw);
    const stories: UserStory[] = content.userStories ?? [];
    const story = stories.find((s: UserStory) => s.id === storyId);

    if (!story) {
      res.status(404).json({ error: 'Story not found' });
      return;
    }

    // Build LLM prompt
    const prompt = `You are rewriting a single user story within a software spec. Return ONLY valid JSON matching this exact schema — no markdown fences, no explanation:

{
  "title": "string",
  "description": "string (Markdown allowed)",
  "acceptanceCriteria": ["string", ...]
}

Current story:
- ID: ${story.id}
- Title: ${story.title}
- Description: ${story.description ?? ''}
- Acceptance Criteria:
${story.acceptanceCriteria.map((ac: string) => `  - ${ac}`).join('\n')}

User instructions: ${instructions || 'Improve clarity and completeness.'}

Rewrite the story following the user instructions. Keep the same scope unless told otherwise. Return ONLY the JSON object.`;

    const resolvedModel = model || undefined;
    const rewriteUser = getEffectiveUser(req);
    if (!rewriteUser) { res.status(500).json({ error: 'No user configured' }); return; }
    const rewriteVaultCreds = resolveVaultCreds(rewriteUser.id, resolvedModel ?? DEFAULT_MODEL);
    const llmResult = await chatComplete(
      [{ role: 'user', content: prompt }],
      { model: resolvedModel, apiKey: rewriteVaultCreds.apiKey, baseUrl: rewriteVaultCreds.baseUrl },
    );

    // Parse LLM response — strip markdown fences if present
    let cleaned = llmResult.text.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    }

    const rewritten = JSON.parse(cleaned);

    if (!rewritten.title || !Array.isArray(rewritten.acceptanceCriteria)) {
      res.status(422).json({ error: 'LLM returned invalid story structure' });
      return;
    }

    res.json({
      ok: true,
      rewritten: {
        title: rewritten.title,
        description: rewritten.description ?? '',
        acceptanceCriteria: rewritten.acceptanceCriteria,
      },
      usage: llmResult.usage,
    });
  } catch (error: any) {
    console.error('[Specs] Story rewrite error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── V2-012: GET /tags/autocomplete — must be before /:specId to avoid capture ─

router.get('/tags/autocomplete', (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string;
    const q = (req.query.q as string) || '';

    if (!workspaceId) {
      res.status(400).json({ error: 'Missing required query param: workspaceId' });
      return;
    }

    let rows: { tag_name: string; count: number }[];
    if (q) {
      rows = db.prepare(
        `SELECT tag_name, COUNT(*) as count FROM spec_tags
         WHERE workspace_id = ? AND tag_name LIKE ? || '%'
         GROUP BY tag_name ORDER BY count DESC, tag_name ASC LIMIT 20`
      ).all(workspaceId, q.trim().toLowerCase()) as { tag_name: string; count: number }[];
    } else {
      rows = db.prepare(
        `SELECT tag_name, COUNT(*) as count FROM spec_tags
         WHERE workspace_id = ?
         GROUP BY tag_name ORDER BY count DESC, tag_name ASC LIMIT 20`
      ).all(workspaceId) as { tag_name: string; count: number }[];
    }

    res.json({ tags: rows.map(r => ({ name: r.tag_name, count: r.count })) });
  } catch (error: any) {
    console.error('[Specs] Tag autocomplete error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/specs/{specId}:
 *   get:
 *     tags: [Specs]
 *     summary: Get full spec detail
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *         description: Spec slug (filename without .json)
 *     responses:
 *       200:
 *         description: Full spec JSON with metadata
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Spec' }
 *       404: { description: "Spec not found" }
 */
router.get('/:specId', (req: Request, res: Response) => {
  try {
    const { specId } = req.params;
    const workspaceId = req.query.workspaceId as string;

    if (!workspaceId) {
      res.status(400).json({ error: 'Missing required query param: workspaceId' });
      return;
    }

    const workspace = getWorkspace(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const pendingFile = path.join(pendingDir, `${specId}.json`);
    const approvedFile = path.join(approvedDir, `${specId}.json`);

    let content: any;
    if (fs.existsSync(pendingFile)) {
      content = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
    } else if (fs.existsSync(approvedFile)) {
      content = JSON.parse(fs.readFileSync(approvedFile, 'utf8'));
    } else {
      res.status(404).json({ error: 'Spec not found' });
      return;
    }

    const stories: any[] = content.userStories ?? content.stories ?? [];
    res.json({ ...content, readinessPercent: computeReadiness(stories) });
  } catch (error: any) {
    console.error('[Specs] Get error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── V2-013: POST /:specId/fork — Deep copy spec with new slug ────────────────

router.post('/:specId/fork', (req: Request, res: Response) => {
  try {
    const specId = req.params.specId as string;
    const workspaceId = req.body.workspaceId as string;
    const title = req.body.title as string | undefined;
    const brief = req.body.brief as string | undefined;

    if (!workspaceId) {
      res.status(400).json({ error: 'Missing required field: workspaceId' });
      return;
    }

    const workspace = getWorkspace(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    // Find the source spec in pending or approved
    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const pendingFile = path.join(pendingDir, `${specId}.json`);
    const approvedFile = path.join(approvedDir, `${specId}.json`);

    let sourceFile: string;
    if (fs.existsSync(pendingFile)) {
      sourceFile = pendingFile;
    } else if (fs.existsSync(approvedFile)) {
      sourceFile = approvedFile;
    } else {
      res.status(404).json({ error: `Spec '${specId}' not found` });
      return;
    }

    const sourceContent = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));

    // Determine fork slug: original-slug-fork-N
    const baseSlug = `${specId}-fork`;
    let forkNumber = 1;
    while (
      fs.existsSync(path.join(pendingDir, `${baseSlug}-${forkNumber}.json`)) ||
      fs.existsSync(path.join(approvedDir, `${baseSlug}-${forkNumber}.json`))
    ) {
      forkNumber++;
    }
    const forkSlug = `${baseSlug}-${forkNumber}`;

    // Deep copy: reset passes, add forkedFrom, update metadata
    const stories: UserStory[] = (sourceContent.userStories ?? sourceContent.stories ?? []).map((s: UserStory) => ({
      ...s,
      passes: false,
    }));

    const forkedSpec = {
      ...sourceContent,
      title: title ?? `${sourceContent.title ?? specId} (Fork ${forkNumber})`,
      userStories: stories,
      forkedFrom: specId,
      generatedAt: new Date().toISOString(),
    };

    // Optionally override the brief
    if (brief) {
      forkedSpec.brief = brief;
    }

    // Remove stories key if it existed (normalize to userStories)
    delete forkedSpec.stories;

    // Write to pending/
    fs.mkdirSync(pendingDir, { recursive: true });
    const forkFile = path.join(pendingDir, `${forkSlug}.json`);
    fs.writeFileSync(forkFile, JSON.stringify(forkedSpec, null, 2));

    // Copy tags from source spec
    const sourceTags = getSpecTags(specId, workspaceId);
    for (const tag of sourceTags) {
      db.prepare(
        'INSERT OR IGNORE INTO spec_tags (spec_id, workspace_id, tag_name) VALUES (?, ?, ?)'
      ).run(forkSlug, workspaceId, tag);
    }

    // Snapshot version
    snapshotVersion(forkSlug, JSON.stringify(forkedSpec), 'pending');

    // Emit WAL event
    const walResult = db.prepare(
      `INSERT INTO wal_events (event_type, spec_id, workspace_id, actor, payload) VALUES ('spec_forked', ?, ?, 'user', ?)`
    ).run(forkSlug, workspaceId, JSON.stringify({ forkedFrom: specId, title: forkedSpec.title }));

    const walEvent = db.prepare('SELECT * FROM wal_events WHERE id = ?').get(
      walResult.lastInsertRowid
    ) as WalEvent;
    broadcastAll(walEvent);

    res.json({
      ok: true,
      forkId: forkSlug,
      forkedFrom: specId,
      path: forkFile,
    });
  } catch (error: any) {
    console.error('[Specs] Fork error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/specs/{specId}/approve:
 *   post:
 *     tags: [Specs]
 *     summary: Approve a spec (move to approved/)
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId: { type: string }
 *     responses:
 *       200:
 *         description: Spec approved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 specPath: { type: string }
 *       404: { description: "Spec not found in pending/" }
 */
router.post('/:specId/approve', (req: Request, res: Response) => {
  try {
    const { specId } = req.params;
    const { workspaceId } = req.body;

    if (!workspaceId) {
      res.status(400).json({ error: 'Missing required field: workspaceId' });
      return;
    }

    const workspace = getWorkspace(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const pendingFile = path.join(pendingDir, `${specId}.json`);

    if (!fs.existsSync(pendingFile)) {
      res.status(404).json({ error: `Spec '${specId}' not found in pending` });
      return;
    }

    // Create approved/ if needed and move the file
    fs.mkdirSync(approvedDir, { recursive: true });
    const approvedFile = path.join(approvedDir, `${specId}.json`);
    fs.renameSync(pendingFile, approvedFile);

    // Emit WAL event
    db.prepare(
      `INSERT INTO wal_events (event_type, spec_id, actor, payload) VALUES ('spec_approved', ?, 'user', ?)`
    ).run(specId, JSON.stringify({ workspaceId }));

    res.json({ ok: true, approvedPath: approvedFile });
  } catch (error: any) {
    console.error('[Specs] Approve error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/specs/{specId}/reject:
 *   post:
 *     tags: [Specs]
 *     summary: Reject a spec (delete + preserve in WAL)
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId: { type: string }
 *               reason: { type: string }
 *     responses:
 *       200: { description: "Spec rejected", content: { application/json: { schema: { type: object, properties: { ok: { type: boolean } } } } } }
 *       404: { description: "Spec not found" }
 */
router.post('/:specId/reject', (req: Request, res: Response) => {
  try {
    const { specId } = req.params;
    const { workspaceId, reason } = req.body;

    if (!workspaceId) {
      res.status(400).json({ error: 'Missing required field: workspaceId' });
      return;
    }

    const workspace = getWorkspace(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const { pendingDir } = specsDirs(workspace.path);
    const pendingFile = path.join(pendingDir, `${specId}.json`);

    if (!fs.existsSync(pendingFile)) {
      res.status(404).json({ error: `Spec '${specId}' not found in pending` });
      return;
    }

    // Snapshot the spec content before deletion so it appears in version history
    const content = fs.readFileSync(pendingFile, 'utf8');
    snapshotVersion(specId as string, content, 'rejected', (reason as string) ?? undefined);

    fs.unlinkSync(pendingFile);

    // Emit WAL event
    db.prepare(
      `INSERT INTO wal_events (event_type, spec_id, actor, payload) VALUES ('spec_rejected', ?, 'user', ?)`
    ).run(specId, JSON.stringify({ workspaceId, reason: reason ?? null }));

    res.json({ ok: true });
  } catch (error: any) {
    console.error('[Specs] Reject error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── V2-037: POST /:specId/request-review — Transition to review_requested ───

const VALID_REVIEW_STATUSES: ReviewStatus[] = ['draft', 'review_requested', 'approved', 'changes_requested'];

router.post('/:specId/request-review', (req: Request, res: Response) => {
  try {
    const { specId } = req.params;
    const { workspaceId } = req.body;

    if (!workspaceId) {
      res.status(400).json({ error: 'Missing required field: workspaceId' });
      return;
    }

    const workspace = getWorkspace(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const { pendingDir } = specsDirs(workspace.path);
    const specFile = path.join(pendingDir, `${specId}.json`);

    if (!fs.existsSync(specFile)) {
      res.status(404).json({ error: `Spec '${specId}' not found in pending` });
      return;
    }

    const raw = fs.readFileSync(specFile, 'utf8');
    const spec = JSON.parse(raw);
    const currentStatus: ReviewStatus = spec.reviewStatus ?? 'draft';

    // Only draft or changes_requested specs can be submitted for review
    if (currentStatus !== 'draft' && currentStatus !== 'changes_requested') {
      res.status(409).json({
        error: `Cannot request review: spec is currently '${currentStatus}'`,
      });
      return;
    }

    spec.reviewStatus = 'review_requested';
    fs.writeFileSync(specFile, JSON.stringify(spec, null, 2), 'utf8');

    // Emit WAL event for audit trail
    const walResult = db.prepare(
      `INSERT INTO wal_events (event_type, spec_id, workspace_id, actor, payload) VALUES ('review_requested', ?, ?, 'user', ?)`
    ).run(specId, workspaceId, JSON.stringify({ previousStatus: currentStatus }));

    const walEvent = db.prepare('SELECT * FROM wal_events WHERE id = ?').get(
      walResult.lastInsertRowid
    ) as WalEvent;
    broadcastAll(walEvent);

    res.json({ ok: true, reviewStatus: 'review_requested' });
  } catch (error: any) {
    console.error('[Specs] Request review error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── V2-037: POST /:specId/review — Approve or request changes ───────────────

router.post('/:specId/review', (req: Request, res: Response) => {
  try {
    const { specId } = req.params;
    const { workspaceId, action, comment, reviewerId } = req.body;

    if (!workspaceId) {
      res.status(400).json({ error: 'Missing required field: workspaceId' });
      return;
    }

    if (!action || !['approve', 'request_changes'].includes(action)) {
      res.status(400).json({ error: "Missing or invalid 'action': must be 'approve' or 'request_changes'" });
      return;
    }

    const workspace = getWorkspace(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const { pendingDir } = specsDirs(workspace.path);
    const specFile = path.join(pendingDir, `${specId}.json`);

    if (!fs.existsSync(specFile)) {
      res.status(404).json({ error: `Spec '${specId}' not found in pending` });
      return;
    }

    const raw = fs.readFileSync(specFile, 'utf8');
    const spec = JSON.parse(raw);
    const currentStatus: ReviewStatus = spec.reviewStatus ?? 'draft';

    // Can only review specs that are in review_requested state
    if (currentStatus !== 'review_requested') {
      res.status(409).json({
        error: `Cannot review: spec is currently '${currentStatus}', expected 'review_requested'`,
      });
      return;
    }

    const newStatus: ReviewStatus = action === 'approve' ? 'approved' : 'changes_requested';
    spec.reviewStatus = newStatus;
    fs.writeFileSync(specFile, JSON.stringify(spec, null, 2), 'utf8');

    // Emit WAL event with reviewer info and comment for audit trail
    const eventType = action === 'approve' ? 'review_approved' : 'review_changes_requested';
    const walResult = db.prepare(
      `INSERT INTO wal_events (event_type, spec_id, workspace_id, actor, payload) VALUES (?, ?, ?, ?, ?)`
    ).run(
      eventType,
      specId,
      workspaceId,
      reviewerId ?? 'user',
      JSON.stringify({
        action,
        comment: comment ?? null,
        reviewerId: reviewerId ?? null,
        previousStatus: currentStatus,
      }),
    );

    const walEvent = db.prepare('SELECT * FROM wal_events WHERE id = ?').get(
      walResult.lastInsertRowid
    ) as WalEvent;
    broadcastAll(walEvent);

    res.json({ ok: true, reviewStatus: newStatus });
  } catch (error: any) {
    console.error('[Specs] Review error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── US-007: GET /:specId/graph — DAG representation of story dependencies ───

interface StoryResultRow {
  story_id: string;
  status: string;
}

interface GraphNode {
  id: string;
  title: string;
  dependsOn: string[];
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
}

interface GraphEdge {
  from: string;
  to: string;
}

interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  parallelGroups: string[][];
}

interface GraphErrorResponse {
  error: string;
  cycle?: string[];
}

/**
 * Detect cycles in the dependency graph using DFS.
 * Returns the cycle path if found, null otherwise.
 */
function detectCycle(stories: UserStory[]): string[] | null {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const parent = new Map<string, string | null>();

  for (const s of stories) color.set(s.id, WHITE);

  function dfs(u: string): string[] | null {
    color.set(u, GRAY);
    const story = stories.find(s => s.id === u);
    if (!story) return null;

    for (const dep of story.dependsOn) {
      if (!color.has(dep)) continue; // unknown dep, skip
      if (color.get(dep) === GRAY) {
        // Back edge found — reconstruct cycle
        const cycle: string[] = [dep, u];
        let cur = u;
        while (cur !== dep) {
          cur = parent.get(cur)!;
          if (cur === dep) break;
          cycle.push(cur);
        }
        cycle.reverse();
        return cycle;
      }
      if (color.get(dep) === WHITE) {
        parent.set(dep, u);
        const result = dfs(dep);
        if (result) return result;
      }
    }

    color.set(u, BLACK);
    return null;
  }

  for (const s of stories) {
    if (color.get(s.id) === WHITE) {
      parent.set(s.id, null);
      const result = dfs(s.id);
      if (result) return result;
    }
  }

  return null;
}

/**
 * Compute parallel execution groups using Kahn's algorithm (topological sort by levels).
 * Each group contains stories whose dependencies are all in prior groups.
 */
function computeParallelGroups(stories: UserStory[]): string[][] {
  const storyIds = new Set(stories.map(s => s.id));
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // dep -> stories that depend on it

  for (const s of stories) {
    inDegree.set(s.id, 0);
    dependents.set(s.id, []);
  }

  for (const s of stories) {
    let count = 0;
    for (const dep of s.dependsOn) {
      if (storyIds.has(dep)) {
        count++;
        dependents.get(dep)!.push(s.id);
      }
    }
    inDegree.set(s.id, count);
  }

  const groups: string[][] = [];
  let queue = stories.filter(s => inDegree.get(s.id) === 0).map(s => s.id);

  while (queue.length > 0) {
    groups.push([...queue]);
    const nextQueue: string[] = [];
    for (const id of queue) {
      for (const dep of dependents.get(id) ?? []) {
        const newDeg = inDegree.get(dep)! - 1;
        inDegree.set(dep, newDeg);
        if (newDeg === 0) nextQueue.push(dep);
      }
    }
    queue = nextQueue;
  }

  return groups;
}

// ─── V2-011: POST /:specId/stories/bulk — Bulk story actions ─────────────────

router.post('/:specId/stories/bulk', (req: Request, res: Response) => {
  try {
    const specId = req.params.specId as string;
    const { workspaceId, action, storyIds, priority } = req.body;

    if (!workspaceId) {
      res.status(400).json({ error: 'Missing required field: workspaceId' });
      return;
    }

    const validActions = ['exclude', 'include', 'delete', 'set_priority'] as const;
    type BulkAction = typeof validActions[number];

    if (!action || !validActions.includes(action as BulkAction)) {
      res.status(400).json({ error: `Invalid action. Must be one of: ${validActions.join(', ')}` });
      return;
    }

    if (!Array.isArray(storyIds) || storyIds.length === 0) {
      res.status(400).json({ error: 'storyIds must be a non-empty array' });
      return;
    }

    if (action === 'set_priority') {
      if (priority === undefined || !Number.isInteger(priority) || priority < 1 || priority > 4) {
        res.status(400).json({ error: 'priority must be an integer between 1 (urgent) and 4 (low) for set_priority action' });
        return;
      }
    }

    const workspace = getWorkspace(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const approvedFile = path.join(approvedDir, `${specId}.json`);
    const pendingFile = path.join(pendingDir, `${specId}.json`);

    let specPath: string;
    if (fs.existsSync(approvedFile)) {
      specPath = approvedFile;
    } else if (fs.existsSync(pendingFile)) {
      specPath = pendingFile;
    } else {
      res.status(404).json({ error: 'Spec not found' });
      return;
    }

    const raw = fs.readFileSync(specPath, 'utf8');
    const content = JSON.parse(raw);
    let stories: UserStory[] = content.userStories ?? [];

    // Validate all storyIds exist
    const storyIdSet = new Set(storyIds as string[]);
    const foundIds = stories.filter(s => storyIdSet.has(s.id)).map(s => s.id);
    if (foundIds.length !== storyIdSet.size) {
      const missing = [...storyIdSet].filter(id => !foundIds.includes(id));
      res.status(404).json({ error: `Stories not found: ${missing.join(', ')}` });
      return;
    }

    // Snapshot pre-mutation state
    const status = fs.existsSync(approvedFile) ? 'approved' : 'pending';
    const version = snapshotVersion(specId, raw, status);

    let eventType: string;

    switch (action as BulkAction) {
      case 'exclude':
        eventType = 'stories_bulk_excluded';
        for (const s of stories) {
          if (storyIdSet.has(s.id)) s.excluded = true;
        }
        break;

      case 'include':
        eventType = 'stories_bulk_included';
        for (const s of stories) {
          if (storyIdSet.has(s.id)) s.excluded = false;
        }
        break;

      case 'delete':
        eventType = 'stories_bulk_deleted';
        stories = stories.filter(s => !storyIdSet.has(s.id));
        // Reindex story IDs to maintain sequential order (US-001, US-002, ...)
        stories = stories.map((s, i) => ({
          ...s,
          id: `US-${String(i + 1).padStart(3, '0')}`,
          // Update dependsOn references: remove deleted deps, remap surviving ones
          dependsOn: (s.dependsOn ?? [])
            .filter(dep => !storyIdSet.has(dep))
            .map(dep => {
              // Find the original story that had this id, get its new index
              const origStories: UserStory[] = content.userStories ?? [];
              const origIndex = origStories.filter(os => !storyIdSet.has(os.id)).findIndex(os => os.id === dep);
              return origIndex >= 0 ? `US-${String(origIndex + 1).padStart(3, '0')}` : dep;
            }),
        }));
        break;

      case 'set_priority':
        eventType = 'stories_bulk_priority';
        for (const s of stories) {
          if (storyIdSet.has(s.id)) s.priority = priority;
        }
        break;

      default:
        res.status(400).json({ error: 'Unknown action' });
        return;
    }

    content.userStories = stories;
    fs.writeFileSync(specPath, JSON.stringify(content, null, 2) + '\n');

    // WAL event
    const walResult = db.prepare(
      `INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, actor, payload) VALUES (?, ?, ?, ?, 'api', ?)`
    ).run(eventType, workspaceId, specId, null, JSON.stringify({
      action,
      storyIds,
      version,
      ...(action === 'set_priority' ? { priority } : {}),
    }));

    broadcastAll({
      id: walResult.lastInsertRowid as number,
      ts: new Date().toISOString(),
      event_type: eventType,
      workspace_id: workspaceId as string,
      spec_id: specId as string,
      story_id: null as unknown as string,
      actor: 'api',
      payload: JSON.stringify({ action, storyIds, version }),
    });

    res.json({
      ok: true,
      action,
      affectedCount: storyIds.length,
      version,
      stories: content.userStories,
    });
  } catch (error: any) {
    console.error('[Specs] Bulk story action error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/:specId/graph', (req: Request, res: Response) => {
  try {
    const { specId } = req.params;
    const workspaceId = req.query.workspaceId as string;
    const runId = req.query.runId as string | undefined;

    if (!workspaceId) {
      res.status(400).json({ error: 'Missing required query param: workspaceId' });
      return;
    }

    const workspace = getWorkspace(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    // Load spec from pending or approved
    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const pendingFile = path.join(pendingDir, `${specId}.json`);
    const approvedFile = path.join(approvedDir, `${specId}.json`);

    let specContent: { userStories?: UserStory[]; stories?: UserStory[] };
    if (fs.existsSync(pendingFile)) {
      specContent = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
    } else if (fs.existsSync(approvedFile)) {
      specContent = JSON.parse(fs.readFileSync(approvedFile, 'utf8'));
    } else {
      res.status(404).json({ error: 'Spec not found' });
      return;
    }

    const stories: UserStory[] = (specContent.userStories ?? specContent.stories ?? []).map(s => ({
      ...s,
      dependsOn: s.dependsOn ?? [],
    }));

    if (stories.length === 0) {
      res.json({ nodes: [], edges: [], parallelGroups: [] });
      return;
    }

    // Detect cycles
    const cycle = detectCycle(stories);
    if (cycle) {
      res.status(422).json({ error: 'Circular dependency detected', cycle } as GraphErrorResponse);
      return;
    }

    // Build status map from story_results if runId provided
    const statusMap = new Map<string, string>();
    if (runId) {
      const results = db.prepare(
        `SELECT story_id, status FROM story_results WHERE run_id = ? ORDER BY id DESC`
      ).all(Number(runId)) as StoryResultRow[];

      // Latest result per story wins (ORDER BY id DESC + first-seen)
      for (const r of results) {
        if (!statusMap.has(r.story_id)) {
          statusMap.set(r.story_id, r.status);
        }
      }
    }

    // Map story_results status values to graph status values
    function mapStatus(storyId: string): GraphNode['status'] {
      const raw = statusMap.get(storyId);
      if (!raw) return 'pending';
      switch (raw) {
        case 'pass': return 'passed';
        case 'fail': return 'failed';
        case 'skip': return 'skipped';
        case 'retry': return 'running';
        default: return 'pending';
      }
    }

    const storyIds = new Set(stories.map(s => s.id));

    // Build nodes and edges
    const nodes: GraphNode[] = stories.map(s => ({
      id: s.id,
      title: s.title,
      dependsOn: s.dependsOn.filter(d => storyIds.has(d)),
      status: mapStatus(s.id),
    }));

    const edges: GraphEdge[] = [];
    for (const s of stories) {
      for (const dep of s.dependsOn) {
        if (storyIds.has(dep)) {
          edges.push({ from: dep, to: s.id });
        }
      }
    }

    // Compute parallel groups
    const parallelGroups = computeParallelGroups(stories);

    res.json({ nodes, edges, parallelGroups } as GraphResponse);
  } catch (error: any) {
    console.error('[Specs] Graph error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── V2-076: POST /:specId/detect-dependencies — AI dependency detection ─────

interface DependencySuggestion {
  from: string;   // dependency story ID
  to: string;     // dependent story ID
  reason: string; // why this dependency is suggested
}

router.post('/:specId/detect-dependencies', async (req: Request, res: Response) => {
  try {
    const { specId } = req.params;
    const { workspaceId } = req.body;

    if (!workspaceId) {
      res.status(400).json({ error: 'Missing required field: workspaceId' });
      return;
    }

    const workspace = getWorkspace(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    // Load spec from pending or approved
    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const pendingFile = path.join(pendingDir, `${specId}.json`);
    const approvedFile = path.join(approvedDir, `${specId}.json`);

    let specContent: { userStories?: UserStory[]; stories?: UserStory[]; title?: string };
    if (fs.existsSync(pendingFile)) {
      specContent = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
    } else if (fs.existsSync(approvedFile)) {
      specContent = JSON.parse(fs.readFileSync(approvedFile, 'utf8'));
    } else {
      res.status(404).json({ error: 'Spec not found' });
      return;
    }

    const stories: UserStory[] = (specContent.userStories ?? specContent.stories ?? []).map(s => ({
      ...s,
      dependsOn: s.dependsOn ?? [],
    }));

    if (stories.length < 2) {
      res.json({ suggestions: [] });
      return;
    }

    // Build existing edges set for deduplication
    const existingEdges = new Set<string>();
    for (const s of stories) {
      for (const dep of s.dependsOn) {
        existingEdges.add(`${dep}->${s.id}`);
      }
    }

    // Build story summaries for LLM
    const storySummaries = stories.map(s => ({
      id: s.id,
      title: s.title,
      description: s.description,
      acceptanceCriteria: s.acceptanceCriteria,
      dependsOn: s.dependsOn,
    }));

    const prompt = [
      '=== INSTRUCTIONS: READ THIS FIRST ===',
      'You are a dependency analyzer. Your ONLY job is to output a single valid JSON object.',
      'Do NOT explain. Do NOT ask questions. Do NOT add markdown fences. Do NOT converse.',
      'Output ONLY the raw JSON object. If you output anything else, you have failed.',
      '=== END INSTRUCTIONS ===',
      '',
      'TASK: Analyze these user stories and identify MISSING dependencies that are not yet declared.',
      'A dependency exists when story B requires work from story A to be completed first.',
      '',
      'Look for these dependency signals:',
      '- Story B references a component, API endpoint, or data model that story A creates',
      '- Story B extends or modifies functionality introduced in story A',
      '- Story B requires authentication/authorization that story A implements',
      '- Story B uses a UI component, service, or utility built in story A',
      '- Story B tests or validates behavior implemented in story A',
      '',
      'IMPORTANT: Only suggest dependencies that are NOT already declared in dependsOn.',
      'Do NOT suggest self-dependencies or circular chains.',
      '',
      'Stories to analyze:',
      JSON.stringify(storySummaries, null, 2),
      '',
      'OUTPUT FORMAT: {"suggestions":[{"from":"STORY-001","to":"STORY-002","reason":"Brief reason"}]}',
      'Rules:',
      '- "from" is the prerequisite story ID, "to" is the dependent story ID',
      '- Only include genuinely missing dependencies — be conservative, not exhaustive',
      '- Each reason should be 1 sentence explaining the dependency signal',
      '- Return empty array if no missing dependencies found',
    ].join('\n');

    const user = getEffectiveUser(req);
    if (!user) { res.status(500).json({ error: 'No user configured' }); return; }
    const depVaultCreds = resolveVaultCreds(user.id, DEFAULT_MODEL);
    const llmResult = await chatComplete(
      [{ role: 'user', content: prompt }],
      { apiKey: depVaultCreds.apiKey, baseUrl: depVaultCreds.baseUrl },
    );

    // Parse response
    let parsed: { suggestions: DependencySuggestion[] };
    try {
      const responseText = llmResult.text;
      const fenceMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
      const jsonStr = fenceMatch ? fenceMatch[1].trim() : responseText.trim();
      const jsonStart = jsonStr.indexOf('{');
      parsed = JSON.parse(jsonStart > 0 ? jsonStr.slice(jsonStart) : jsonStr);
    } catch {
      res.status(500).json({ error: 'LLM returned non-JSON', raw: llmResult.text });
      return;
    }

    if (!Array.isArray(parsed.suggestions)) {
      res.json({ suggestions: [] });
      return;
    }

    // Filter: remove duplicates of existing edges, self-deps, and invalid story IDs
    const storyIds = new Set(stories.map(s => s.id));
    const filtered = parsed.suggestions.filter(s => {
      if (!storyIds.has(s.from) || !storyIds.has(s.to)) return false;
      if (s.from === s.to) return false;
      if (existingEdges.has(`${s.from}->${s.to}`)) return false;
      return true;
    });

    // Validate each suggestion doesn't create a cycle
    const validSuggestions: DependencySuggestion[] = [];
    for (const suggestion of filtered) {
      // Simulate adding this edge and check for cycles
      const testStories = stories.map(s => ({
        ...s,
        dependsOn: s.id === suggestion.to
          ? [...s.dependsOn, suggestion.from]
          : [...s.dependsOn],
      }));
      // Also include previously accepted suggestions in this batch
      for (const prev of validSuggestions) {
        const target = testStories.find(s => s.id === prev.to);
        if (target && !target.dependsOn.includes(prev.from)) {
          target.dependsOn.push(prev.from);
        }
      }
      const cycle = detectCycle(testStories);
      if (!cycle) {
        validSuggestions.push(suggestion);
      }
    }

    // Emit WAL event
    db.prepare(
      `INSERT INTO wal_events (event_type, spec_id, workspace_id, payload) VALUES (?, ?, ?, ?)`
    ).run('dependencies_detected', specId, workspaceId, JSON.stringify({
      suggestedCount: validSuggestions.length,
      filteredCount: filtered.length - validSuggestions.length,
    }));

    res.json({
      suggestions: validSuggestions,
      tokenUsage: llmResult.usage,
    });
  } catch (error: any) {
    console.error('[Specs] Detect dependencies error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── V2-076: POST /:specId/apply-dependencies — Accept suggested dependencies ─

router.post('/:specId/apply-dependencies', (req: Request, res: Response) => {
  try {
    const { specId } = req.params;
    const { workspaceId, dependencies } = req.body as {
      workspaceId: string;
      dependencies: Array<{ from: string; to: string }>;
    };

    if (!workspaceId || !Array.isArray(dependencies) || dependencies.length === 0) {
      res.status(400).json({ error: 'Missing workspaceId or dependencies array' });
      return;
    }

    const workspace = getWorkspace(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    // Load spec
    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const pendingFile = path.join(pendingDir, `${specId}.json`);
    const approvedFile = path.join(approvedDir, `${specId}.json`);

    let specContent: Record<string, unknown>;
    let specFilePath: string;
    if (fs.existsSync(pendingFile)) {
      specContent = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
      specFilePath = pendingFile;
    } else if (fs.existsSync(approvedFile)) {
      specContent = JSON.parse(fs.readFileSync(approvedFile, 'utf8'));
      specFilePath = approvedFile;
    } else {
      res.status(404).json({ error: 'Spec not found' });
      return;
    }

    const stories = (specContent.userStories ?? specContent.stories ?? []) as UserStory[];
    const storyMap = new Map(stories.map(s => [s.id, s]));

    // Apply accepted dependencies
    let appliedCount = 0;
    for (const dep of dependencies) {
      const story = storyMap.get(dep.to);
      if (!story) continue;
      if (!story.dependsOn) story.dependsOn = [];
      if (!story.dependsOn.includes(dep.from) && storyMap.has(dep.from)) {
        story.dependsOn.push(dep.from);
        appliedCount++;
      }
    }

    if (appliedCount === 0) {
      res.json({ ok: true, appliedCount: 0 });
      return;
    }

    // Validate no cycles were introduced
    const allStories: UserStory[] = stories.map(s => ({
      ...s,
      dependsOn: s.dependsOn ?? [],
    }));
    const cycle = detectCycle(allStories);
    if (cycle) {
      res.status(422).json({ error: 'Accepting these dependencies would create a circular dependency', cycle });
      return;
    }

    // Regenerate mermaid diagram
    const diagBundle = generateDiagramBundle(allStories, ['storyDeps']);
    if (diagBundle.storyDeps) {
      specContent.mermaidDiagram = diagBundle.storyDeps.mermaid;
    }

    // Write back
    fs.writeFileSync(specFilePath, JSON.stringify(specContent, null, 2), 'utf8');

    // Emit WAL event
    db.prepare(
      `INSERT INTO wal_events (event_type, spec_id, workspace_id, payload) VALUES (?, ?, ?, ?)`
    ).run('dependencies_applied', specId, workspaceId, JSON.stringify({
      appliedCount,
      edges: dependencies.slice(0, 20),
    }));

    res.json({ ok: true, appliedCount });
  } catch (error: any) {
    console.error('[Specs] Apply dependencies error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── V2-012: Tag management ──────────────────────────────────────────────────

// POST /:specId/tags — Add one or more tags to a spec
router.post('/:specId/tags', (req: Request, res: Response) => {
  try {
    const specId = req.params.specId as string;
    const { workspaceId, tags } = req.body;

    if (!workspaceId) {
      res.status(400).json({ error: 'Missing required field: workspaceId' });
      return;
    }
    if (!tags || !Array.isArray(tags) || tags.length === 0) {
      res.status(400).json({ error: 'Missing required field: tags (array of strings)' });
      return;
    }

    const workspace = getWorkspace(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const insert = db.prepare(
      'INSERT OR IGNORE INTO spec_tags (spec_id, workspace_id, tag_name) VALUES (?, ?, ?)'
    );
    const added: string[] = [];
    for (const tag of tags) {
      const name = String(tag).trim().toLowerCase();
      if (!name) continue;
      const result = insert.run(specId, workspaceId, name);
      if (result.changes > 0) added.push(name);
    }

    // Emit WAL event for tag changes
    const walResult = db.prepare(
      `INSERT INTO wal_events (event_type, spec_id, workspace_id, payload, ts)
       VALUES ('tags_updated', ?, ?, ?, datetime('now'))`
    ).run(specId, workspaceId, JSON.stringify({ added, action: 'add' }));
    const walEvent = db.prepare('SELECT * FROM wal_events WHERE id = ?').get(
      walResult.lastInsertRowid
    ) as WalEvent;
    broadcastAll(walEvent);

    res.json({ tags: getSpecTags(specId, workspaceId) });
  } catch (error: any) {
    console.error('[Specs] Add tags error:', error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /:specId/tags/:tag — Remove a tag from a spec
router.delete('/:specId/tags/:tag', (req: Request, res: Response) => {
  try {
    const specId = req.params.specId as string;
    const tag = req.params.tag as string;
    const workspaceId = req.query.workspaceId as string;

    if (!workspaceId) {
      res.status(400).json({ error: 'Missing required query param: workspaceId' });
      return;
    }

    const tagName = tag.trim().toLowerCase();
    const result = db.prepare(
      'DELETE FROM spec_tags WHERE spec_id = ? AND workspace_id = ? AND tag_name = ?'
    ).run(specId, workspaceId, tagName);

    if (result.changes === 0) {
      res.status(404).json({ error: 'Tag not found on this spec' });
      return;
    }

    // Emit WAL event
    const walResult = db.prepare(
      `INSERT INTO wal_events (event_type, spec_id, workspace_id, payload, ts)
       VALUES ('tags_updated', ?, ?, ?, datetime('now'))`
    ).run(specId, workspaceId, JSON.stringify({ removed: [tagName], action: 'remove' }));
    const walEvent = db.prepare('SELECT * FROM wal_events WHERE id = ?').get(
      walResult.lastInsertRowid
    ) as WalEvent;
    broadcastAll(walEvent);

    res.json({ tags: getSpecTags(specId, workspaceId) });
  } catch (error: any) {
    console.error('[Specs] Remove tag error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /api/specs/:specId/stories/:storyId/commits ─────────────────────────

interface StoryCommitRow {
  id: number;
  story_id: string;
  spec_id: string;
  workspace_id: string;
  commit_sha: string;
  commit_message: string;
  author: string;
  pushed_at: string;
}

router.get('/:specId/stories/:storyId/commits', (req: Request, res: Response) => {
  try {
    const { specId, storyId } = req.params;
    const workspaceId = req.query.workspaceId as string;

    if (!workspaceId) {
      res.status(400).json({ error: 'Missing workspaceId query param' });
      return;
    }

    const commits = db.prepare(
      `SELECT * FROM story_commits
       WHERE spec_id = ? AND story_id = ? AND workspace_id = ?
       ORDER BY pushed_at DESC`
    ).all(specId, storyId, workspaceId) as StoryCommitRow[];

    res.json({ commits });
  } catch (error: any) {
    console.error('[Specs] Story commits error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /api/specs/:specId/stories/:storyId/branch ────────────────────────

router.post('/:specId/stories/:storyId/branch', async (req: Request, res: Response) => {
  try {
    const specId = req.params.specId as string;
    const storyId = req.params.storyId as string;
    const { workspaceId } = req.body;

    if (!workspaceId) {
      res.status(400).json({ error: 'Missing required field: workspaceId' });
      return;
    }

    const workspace = getWorkspace(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    // Build branch name: feat/STORY-ID-slug
    const slug = storyId.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    const branchName = `feat/${slug}`;

    const git = simpleGit(workspace.path);

    // Auto-detect default branch (main or master)
    let defaultBranch = 'main';
    try {
      const branches = await git.branchLocal();
      if (branches.all.includes('main')) {
        defaultBranch = 'main';
      } else if (branches.all.includes('master')) {
        defaultBranch = 'master';
      }
    } catch {
      // Fall back to 'main'
    }

    // Check if branch already exists
    const allBranches = await git.branchLocal();
    if (allBranches.all.includes(branchName)) {
      res.status(409).json({
        error: 'Branch already exists',
        branchName,
        checkoutCommand: `git checkout ${branchName}`,
      });
      return;
    }

    // Create branch from HEAD of default branch
    await git.raw(['branch', branchName, defaultBranch]);

    res.status(201).json({
      branchName,
      baseBranch: defaultBranch,
      checkoutCommand: `git checkout ${branchName}`,
    });
  } catch (error: any) {
    console.error('[Specs] Create story branch error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── V2-031: POST /api/specs/:specId/stories/:storyId/pr-body ───────────────

const DEFAULT_PR_TEMPLATE = [
  '## Summary',
  '',
  '**Story:** {{storyId}} — {{storyTitle}}',
  '',
  '{{storyDescription}}',
  '',
  '## Acceptance Criteria',
  '',
  '{{acceptanceCriteriaChecklist}}',
  '',
  '{{#if dependencies}}',
  '## Dependencies',
  '',
  '{{dependencyList}}',
  '',
  '{{/if}}',
  '## Spec Reference',
  '',
  '{{specLink}}',
  '',
  '---',
  '_Generated by [Rorca](https://github.com/rorca) from spec `{{specId}}`_',
].join('\n');

function renderPrTemplate(template: string, vars: Record<string, string>): string {
  let result = template;

  // Handle {{#if key}}...{{/if}} conditionals
  result = result.replace(/\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_match, key, content) => {
    return vars[key] ? content : '';
  });

  // Replace {{variable}} placeholders
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }

  // Clean up multiple consecutive blank lines left by removed conditionals
  result = result.replace(/\n{3,}/g, '\n\n');

  return result.trim();
}

router.post('/:specId/stories/:storyId/pr-body', (req: Request, res: Response) => {
  try {
    const specId = req.params.specId as string;
    const storyId = req.params.storyId as string;
    const { workspaceId } = req.body;

    if (!workspaceId) {
      res.status(400).json({ error: 'Missing required field: workspaceId' });
      return;
    }

    const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId) as
      (WorkspaceRow & { pr_template?: string | null }) | undefined;
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    // Find spec file in pending or approved
    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    let filePath = path.join(approvedDir, `${specId}.json`);
    if (!fs.existsSync(filePath)) {
      filePath = path.join(pendingDir, `${specId}.json`);
    }
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: `Spec '${specId}' not found` });
      return;
    }

    const content = parseSpecFile(filePath);
    const stories: UserStory[] = (content.userStories ?? []) as UserStory[];
    const story = stories.find(s => s.id === storyId);
    if (!story) {
      res.status(404).json({ error: `Story '${storyId}' not found in spec '${specId}'` });
      return;
    }

    // Build template variables
    const acChecklist = story.acceptanceCriteria
      .map(ac => `- [ ] ${ac}`)
      .join('\n');

    const deps = story.dependsOn ?? [];
    const depList = deps.length > 0
      ? deps.map(d => `- \`${d}\``).join('\n')
      : '';

    const specLink = `Spec: \`${specId}\` (${stories.length} stories)`;

    const vars: Record<string, string> = {
      storyId: story.id,
      storyTitle: story.title,
      storyDescription: story.description || '',
      acceptanceCriteriaChecklist: acChecklist,
      dependencies: deps.length > 0 ? 'true' : '',
      dependencyList: depList,
      specId,
      specLink,
    };

    const template = workspace.pr_template || DEFAULT_PR_TEMPLATE;
    const body = renderPrTemplate(template, vars);

    res.json({ body });
  } catch (error: any) {
    console.error('[Specs] PR body generation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── V2-033: POST /:specId/import/github-issues — Import GitHub Issues as stories ───

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  labels: Array<{ name: string }>;
  state: string;
}

interface GitHubConnectionRow {
  encrypted_token: string;
}

interface GithubWebhookRow {
  repo_owner: string;
  repo_name: string;
}

/**
 * Fetch a page of GitHub issues by number.
 * Uses the individual issue endpoint for specific numbers,
 * or the list endpoint with pagination for bulk fetches.
 */
async function fetchGithubIssues(
  owner: string,
  repo: string,
  token: string,
  issueNumbers: number[],
): Promise<{ issues: GitHubIssue[]; errors: Array<{ number: number; error: string }> }> {
  const issues: GitHubIssue[] = [];
  const errors: Array<{ number: number; error: string }> = [];

  // Fetch individual issues by number — handles any set of issue numbers
  // regardless of pagination concerns
  const BATCH_SIZE = 10;
  for (let i = 0; i < issueNumbers.length; i += BATCH_SIZE) {
    const batch = issueNumbers.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (num) => {
        const res = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/issues/${num}`,
          {
            headers: {
              'Authorization': `Bearer ${token}`,
              'Accept': 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
            },
          },
        );
        if (!res.ok) {
          errors.push({ number: num, error: `GitHub API ${res.status}: ${res.statusText}` });
          return null;
        }
        return (await res.json()) as GitHubIssue;
      }),
    );
    for (const issue of results) {
      if (issue) issues.push(issue);
    }
  }

  return { issues, errors };
}

/**
 * Fetch ALL open issues from a GitHub repo with pagination.
 * Used when no specific issue numbers are provided.
 */
async function fetchAllGithubIssues(
  owner: string,
  repo: string,
  token: string,
): Promise<{ issues: GitHubIssue[]; errors: Array<{ number: number; error: string }> }> {
  const issues: GitHubIssue[] = [];
  let page = 1;
  const perPage = 100; // GitHub max

  while (true) {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues?state=open&per_page=${perPage}&page=${page}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );

    if (!res.ok) {
      return { issues, errors: [{ number: 0, error: `GitHub API ${res.status}: ${res.statusText}` }] };
    }

    const pageIssues = (await res.json()) as GitHubIssue[];
    // Filter out pull requests (GitHub Issues API includes PRs)
    const realIssues = pageIssues.filter(i => !('pull_request' in i));
    issues.push(...realIssues);

    if (pageIssues.length < perPage) break;
    page++;
  }

  return { issues, errors: [] };
}

function githubIssueToStory(
  issue: GitHubIssue,
  storyId: string,
): UserStory & { githubIssueUrl: string; tags: string[] } {
  const tags = issue.labels.map(l => l.name);
  return {
    id: storyId,
    title: issue.title,
    description: issue.body ?? '',
    acceptanceCriteria: [],
    dependsOn: [],
    passes: false,
    githubIssueUrl: issue.html_url,
    tags,
  };
}

router.post('/:specId/import/github-issues', async (req: Request, res: Response) => {
  try {
    const { specId } = req.params;
    const { workspaceId, issueNumbers, preview } = req.body as {
      workspaceId: string;
      issueNumbers?: number[];
      preview?: boolean;
    };

    if (!workspaceId) {
      res.status(400).json({ error: 'Missing required field: workspaceId' });
      return;
    }

    const workspace = getWorkspace(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    // Resolve GitHub connection for this workspace
    const ghConn = db.prepare(
      'SELECT repo_owner, repo_name FROM workspace_github_webhooks WHERE workspace_id = ?'
    ).get(workspaceId) as GithubWebhookRow | undefined;

    if (!ghConn) {
      res.status(400).json({ error: 'No GitHub connection for this workspace. Connect via workspace settings first.' });
      return;
    }

    // Resolve GitHub token from OAuth connections
    const tokenRow = db.prepare(
      'SELECT encrypted_token FROM github_connections LIMIT 1'
    ).get() as GitHubConnectionRow | undefined;

    if (!tokenRow) {
      res.status(400).json({ error: 'No GitHub OAuth token available. Connect your GitHub account first.' });
      return;
    }

    const { decryptToken } = await import('./auth');
    const githubToken = decryptToken(tokenRow.encrypted_token);

    // Find the spec on disk
    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const pendingFile = path.join(pendingDir, `${specId}.json`);
    const approvedFile = path.join(approvedDir, `${specId}.json`);

    let specFilePath: string;
    if (fs.existsSync(approvedFile)) specFilePath = approvedFile;
    else if (fs.existsSync(pendingFile)) specFilePath = pendingFile;
    else { res.status(404).json({ error: 'Spec not found' }); return; }

    const specContent = JSON.parse(fs.readFileSync(specFilePath, 'utf8'));
    const existingStories: Array<{ id: string }> =
      specContent.userStories ?? specContent.stories ?? [];

    // Determine next story ID
    const storyPrefix = existingStories[0]?.id?.match(/^([A-Z]+)/)?.[1] ?? 'US';
    const maxN = existingStories.reduce((max: number, s: { id: string }) => {
      const n = parseInt(s.id?.replace(/\D/g, '') || '0', 10);
      return n > max ? n : max;
    }, 0);

    // Fetch issues from GitHub
    const { issues, errors } = issueNumbers && issueNumbers.length > 0
      ? await fetchGithubIssues(ghConn.repo_owner, ghConn.repo_name, githubToken, issueNumbers)
      : await fetchAllGithubIssues(ghConn.repo_owner, ghConn.repo_name, githubToken);

    if (issues.length === 0 && errors.length > 0) {
      res.status(502).json({ error: 'Failed to fetch GitHub issues', details: errors });
      return;
    }

    // Map issues to stories
    const newStories = issues.map((issue, idx) => {
      const storyNum = maxN + idx + 1;
      const storyId = `${storyPrefix}-${String(storyNum).padStart(3, '0')}`;
      return githubIssueToStory(issue, storyId);
    });

    // Preview mode — return proposed stories without saving
    if (preview) {
      res.json({
        ok: true,
        preview: true,
        stories: newStories,
        errors,
      });
      return;
    }

    // Import mode — append stories and write to disk
    specContent.userStories = [...existingStories, ...newStories];

    // Regenerate mermaidDiagram with all stories
    const { generateStoryDepsDiagram } = await import('../lib/diagram-generator');
    const depsDiagram = generateStoryDepsDiagram(specContent.userStories);
    specContent.mermaidDiagram = depsDiagram.mermaid;

    fs.writeFileSync(specFilePath, JSON.stringify(specContent, null, 2), 'utf8');

    // Emit WAL event
    const walResult = db.prepare(
      `INSERT INTO wal_events (event_type, spec_id, workspace_id, payload) VALUES ('github_issues_imported', ?, ?, ?)`
    ).run(specId, workspaceId, JSON.stringify({
      issueCount: newStories.length,
      issueNumbers: issues.map(i => i.number),
      repoOwner: ghConn.repo_owner,
      repoName: ghConn.repo_name,
    }));
    const walEvent = db.prepare('SELECT * FROM wal_events WHERE id = ?').get(
      walResult.lastInsertRowid
    ) as WalEvent;
    broadcastAll(walEvent);

    res.json({
      ok: true,
      preview: false,
      importedCount: newStories.length,
      stories: newStories,
      errors,
    });
  } catch (error: any) {
    console.error('[Specs] GitHub issues import error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── V2-058: POST /:specId/import — Unified Linear + GitHub Issue Import ─────

interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  labels: { nodes: Array<{ name: string }> };
  state: { name: string };
}

interface LinearIssuesResponse {
  data?: {
    issues: {
      nodes: LinearIssue[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
  errors?: Array<{ message: string }>;
}

async function fetchLinearIssues(
  apiKey: string,
  filters: { teamId?: string; projectId?: string; labelIds?: string[] },
): Promise<{ issues: LinearIssue[]; errors: string[] }> {
  const filterParts: string[] = [];
  if (filters.teamId) filterParts.push(`team: { id: { eq: "${filters.teamId}" } }`);
  if (filters.projectId) filterParts.push(`project: { id: { eq: "${filters.projectId}" } }`);
  if (filters.labelIds && filters.labelIds.length > 0) {
    filterParts.push(`labels: { id: { in: [${filters.labelIds.map(id => `"${id}"`).join(', ')}] } }`);
  }

  const filterStr = filterParts.length > 0 ? `filter: { ${filterParts.join(', ')} }` : '';

  const allIssues: LinearIssue[] = [];
  let cursor: string | null = null;
  const errors: string[] = [];

  // Paginate through all matching issues
  for (let page = 0; page < 10; page++) { // safety cap at 10 pages (500 issues)
    const afterClause = cursor ? `, after: "${cursor}"` : '';
    const query = `{
      issues(first: 50${afterClause}${filterStr ? `, ${filterStr}` : ''}) {
        nodes {
          id
          identifier
          title
          description
          url
          labels { nodes { name } }
          state { name }
        }
        pageInfo { hasNextPage endCursor }
      }
    }`;

    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': apiKey,
      },
      body: JSON.stringify({ query }),
    });

    if (!res.ok) {
      errors.push(`Linear API ${res.status}: ${res.statusText}`);
      break;
    }

    const body = (await res.json()) as LinearIssuesResponse;
    if (body.errors) {
      errors.push(...body.errors.map(e => e.message));
      break;
    }

    const nodes = body.data?.issues?.nodes ?? [];
    allIssues.push(...nodes);

    if (!body.data?.issues?.pageInfo?.hasNextPage) break;
    cursor = body.data.issues.pageInfo.endCursor;
  }

  return { issues: allIssues, errors };
}

function linearIssueToStory(
  issue: LinearIssue,
  storyId: string,
): UserStory & { sourceUrl: string; tags: string[] } {
  const tags = issue.labels.nodes.map(l => l.name);
  return {
    id: storyId,
    title: issue.title,
    description: issue.description ?? '',
    acceptanceCriteria: [],
    dependsOn: [],
    passes: false,
    sourceUrl: issue.url,
    tags,
  };
}

function githubIssueToStoryWithSource(
  issue: GitHubIssue,
  storyId: string,
): UserStory & { sourceUrl: string; tags: string[] } {
  const tags = issue.labels.map(l => l.name);
  return {
    id: storyId,
    title: issue.title,
    description: issue.body ?? '',
    acceptanceCriteria: [],
    dependsOn: [],
    passes: false,
    sourceUrl: issue.html_url,
    tags,
  };
}

async function fetchGithubIssuesDirect(
  owner: string,
  repo: string,
  token: string,
  milestone?: string,
): Promise<{ issues: GitHubIssue[]; errors: string[] }> {
  const issues: GitHubIssue[] = [];
  const errors: string[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    let url = `https://api.github.com/repos/${owner}/${repo}/issues?state=open&per_page=${perPage}&page=${page}`;
    if (milestone) url += `&milestone=${encodeURIComponent(milestone)}`;

    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!res.ok) {
      errors.push(`GitHub API ${res.status}: ${res.statusText}`);
      break;
    }

    const pageIssues = (await res.json()) as GitHubIssue[];
    const realIssues = pageIssues.filter(i => !('pull_request' in i));
    issues.push(...realIssues);

    if (pageIssues.length < perPage) break;
    page++;
  }

  return { issues, errors };
}

type ImportSource = 'linear' | 'github';

interface ImportRequestBody {
  workspaceId: string;
  source: ImportSource;
  preview?: boolean;
  // Linear-specific
  linearApiKey?: string;
  linearTeamId?: string;
  linearProjectId?: string;
  linearLabelIds?: string[];
  // GitHub-specific
  githubToken?: string;
  githubOwner?: string;
  githubRepo?: string;
  githubMilestone?: string;
}

router.post('/:specId/import', async (req: Request, res: Response) => {
  try {
    const { specId } = req.params;
    const body = req.body as ImportRequestBody;
    const { workspaceId, source, preview } = body;

    if (!workspaceId) {
      res.status(400).json({ error: 'Missing required field: workspaceId' });
      return;
    }
    if (!source || !['linear', 'github'].includes(source)) {
      res.status(400).json({ error: "Missing or invalid 'source'. Must be 'linear' or 'github'." });
      return;
    }

    const workspace = getWorkspace(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    // Find the spec on disk
    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const pendingFile = path.join(pendingDir, `${specId}.json`);
    const approvedFile = path.join(approvedDir, `${specId}.json`);

    let specFilePath: string;
    if (fs.existsSync(approvedFile)) specFilePath = approvedFile;
    else if (fs.existsSync(pendingFile)) specFilePath = pendingFile;
    else { res.status(404).json({ error: 'Spec not found' }); return; }

    const specContent = JSON.parse(fs.readFileSync(specFilePath, 'utf8'));
    const existingStories: Array<{ id: string }> =
      specContent.userStories ?? specContent.stories ?? [];

    // Determine next story ID
    const storyPrefix = existingStories[0]?.id?.match(/^([A-Z]+)/)?.[1] ?? 'US';
    const maxN = existingStories.reduce((max: number, s: { id: string }) => {
      const n = parseInt(s.id?.replace(/\D/g, '') || '0', 10);
      return n > max ? n : max;
    }, 0);

    let newStories: Array<UserStory & { sourceUrl: string; tags: string[] }>;
    let importErrors: string[] = [];

    if (source === 'linear') {
      // Linear import
      if (!body.linearApiKey) {
        res.status(400).json({ error: 'Missing required field: linearApiKey' });
        return;
      }

      const { issues, errors } = await fetchLinearIssues(body.linearApiKey, {
        teamId: body.linearTeamId,
        projectId: body.linearProjectId,
        labelIds: body.linearLabelIds,
      });
      importErrors = errors;

      if (issues.length === 0 && errors.length > 0) {
        res.status(502).json({ error: 'Failed to fetch Linear issues', details: errors });
        return;
      }

      newStories = issues.map((issue, idx) => {
        const storyNum = maxN + idx + 1;
        const storyId = `${storyPrefix}-${String(storyNum).padStart(3, '0')}`;
        return linearIssueToStory(issue, storyId);
      });
    } else {
      // GitHub import
      if (!body.githubToken || !body.githubOwner || !body.githubRepo) {
        res.status(400).json({ error: 'Missing required fields: githubToken, githubOwner, githubRepo' });
        return;
      }

      const { issues, errors } = await fetchGithubIssuesDirect(
        body.githubOwner,
        body.githubRepo,
        body.githubToken,
        body.githubMilestone,
      );
      importErrors = errors;

      if (issues.length === 0 && errors.length > 0) {
        res.status(502).json({ error: 'Failed to fetch GitHub issues', details: errors });
        return;
      }

      newStories = issues.map((issue, idx) => {
        const storyNum = maxN + idx + 1;
        const storyId = `${storyPrefix}-${String(storyNum).padStart(3, '0')}`;
        return githubIssueToStoryWithSource(issue, storyId);
      });
    }

    // Preview mode — return proposed stories without saving
    if (preview) {
      res.json({
        ok: true,
        preview: true,
        source,
        stories: newStories,
        errors: importErrors,
      });
      return;
    }

    // Commit mode — append stories and write to disk
    specContent.userStories = [...existingStories, ...newStories];

    // Regenerate mermaidDiagram with all stories
    const { generateStoryDepsDiagram } = await import('../lib/diagram-generator');
    const depsDiagram = generateStoryDepsDiagram(specContent.userStories);
    specContent.mermaidDiagram = depsDiagram.mermaid;

    fs.writeFileSync(specFilePath, JSON.stringify(specContent, null, 2), 'utf8');

    // Emit WAL event
    const walResult = db.prepare(
      `INSERT INTO wal_events (event_type, spec_id, workspace_id, payload) VALUES ('issues_imported', ?, ?, ?)`
    ).run(specId, workspaceId, JSON.stringify({
      source,
      issueCount: newStories.length,
    }));
    const walEvent = db.prepare('SELECT * FROM wal_events WHERE id = ?').get(
      walResult.lastInsertRowid
    ) as WalEvent;
    broadcastAll(walEvent);

    res.json({
      ok: true,
      preview: false,
      source,
      importedCount: newStories.length,
      stories: newStories,
      errors: importErrors,
    });
  } catch (error: any) {
    console.error('[Specs] Issue import error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Story Comments ──────────────────────────────────────────────────────────

interface StoryCommentRow {
  id: string;
  spec_id: string;
  story_id: string;
  user_id: string;
  body: string;
  created_at: string;
  resolved_at: string | null;
  display_name: string;
  avatar_url: string | null;
}

// GET /api/specs/:specId/stories/:storyId/comments — list all comments for a story
router.get('/:specId/stories/:storyId/comments', (req: Request, res: Response) => {
  try {
    const { specId, storyId } = req.params;

    const comments = db.prepare(`
      SELECT sc.id, sc.spec_id, sc.story_id, sc.user_id, sc.body,
             sc.created_at, sc.resolved_at,
             COALESCE(u.display_name, sc.author_name, 'Guest') as display_name,
             u.avatar_url
      FROM story_comments sc
      LEFT JOIN users u ON u.id = sc.user_id
      WHERE sc.spec_id = ? AND sc.story_id = ?
      ORDER BY sc.created_at ASC
    `).all(specId, storyId) as StoryCommentRow[];

    res.json({ comments });
  } catch (error: any) {
    console.error('[StoryComments] List error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/specs/:specId/stories/:storyId/comments — create a comment
router.post('/:specId/stories/:storyId/comments', (req: Request, res: Response) => {
  try {
    const { specId, storyId } = req.params;
    const { body } = req.body;
    const user = getEffectiveUser(req);
    if (!user) { res.status(500).json({ error: 'No user configured' }); return; }

    if (!body || typeof body !== 'string' || body.trim().length === 0) {
      res.status(400).json({ error: 'body is required' });
      return;
    }

    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO story_comments (id, spec_id, story_id, user_id, body)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, specId, storyId, user.id, body.trim());

    // Emit WAL event
    const walResult = db.prepare(`
      INSERT INTO wal_events (ts, event_type, spec_id, story_id, actor, payload)
      VALUES (datetime('now'), 'comment_added', ?, ?, ?, ?)
    `).run(specId, storyId, user.email, JSON.stringify({ commentId: id }));
    const walEvent = db.prepare('SELECT * FROM wal_events WHERE id = ?').get(
      walResult.lastInsertRowid
    ) as WalEvent;
    broadcastAll(walEvent);

    // Return the created comment with author info
    const comment = db.prepare(`
      SELECT sc.id, sc.spec_id, sc.story_id, sc.user_id, sc.body,
             sc.created_at, sc.resolved_at,
             COALESCE(u.display_name, sc.author_name, 'Guest') as display_name,
             u.avatar_url
      FROM story_comments sc
      LEFT JOIN users u ON u.id = sc.user_id
      WHERE sc.id = ?
    `).get(id) as StoryCommentRow;

    // Parse @mentions and create notifications for each mentioned user
    const mentionPattern = /@([\w.\-]+(?:\s[\w.\-]+)?)/g;
    const mentionedNames = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = mentionPattern.exec(body)) !== null) {
      mentionedNames.add(match[1]);
    }

    if (mentionedNames.size > 0) {
      const allUsers = db.prepare(
        'SELECT id, display_name FROM users'
      ).all() as { id: string; display_name: string }[];

      const userByName = new Map(allUsers.map(u => [u.display_name.toLowerCase(), u.id]));

      for (const name of mentionedNames) {
        const mentionedUserId = userByName.get(name.toLowerCase());
        if (mentionedUserId && mentionedUserId !== user.id) {
          createNotification(
            mentionedUserId,
            'mention',
            `${comment.display_name} mentioned you in a comment`,
            body.length > 120 ? body.slice(0, 120) + '...' : body,
            `/specs/${specId}?story=${storyId}&comment=${id}`,
          );
        }
      }
    }

    res.status(201).json(comment);
  } catch (error: any) {
    console.error('[StoryComments] Create error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/specs/:specId/stories/:storyId/comments/:commentId/resolve — resolve a comment
router.post('/:specId/stories/:storyId/comments/:commentId/resolve', (req: Request, res: Response) => {
  try {
    const { specId, storyId, commentId } = req.params;
    const user = getEffectiveUser(req);
    if (!user) { res.status(500).json({ error: 'No user configured' }); return; }

    const existing = db.prepare(
      'SELECT id, resolved_at FROM story_comments WHERE id = ? AND spec_id = ? AND story_id = ?'
    ).get(commentId, specId, storyId) as { id: string; resolved_at: string | null } | undefined;

    if (!existing) {
      res.status(404).json({ error: 'Comment not found' });
      return;
    }

    if (existing.resolved_at) {
      res.status(400).json({ error: 'Comment is already resolved' });
      return;
    }

    db.prepare(
      "UPDATE story_comments SET resolved_at = datetime('now') WHERE id = ?"
    ).run(commentId);

    // Emit WAL event
    const walResult = db.prepare(`
      INSERT INTO wal_events (ts, event_type, spec_id, story_id, actor, payload)
      VALUES (datetime('now'), 'comment_resolved', ?, ?, ?, ?)
    `).run(specId, storyId, user.email, JSON.stringify({ commentId }));
    const walEvent = db.prepare('SELECT * FROM wal_events WHERE id = ?').get(
      walResult.lastInsertRowid
    ) as WalEvent;
    broadcastAll(walEvent);

    const comment = db.prepare(`
      SELECT sc.id, sc.spec_id, sc.story_id, sc.user_id, sc.body,
             sc.created_at, sc.resolved_at,
             COALESCE(u.display_name, sc.author_name, 'Guest') as display_name,
             u.avatar_url
      FROM story_comments sc
      LEFT JOIN users u ON u.id = sc.user_id
      WHERE sc.id = ?
    `).get(commentId) as StoryCommentRow;

    res.json(comment);
  } catch (error: any) {
    console.error('[StoryComments] Resolve error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/specs/:specId/comments/counts — unresolved comment counts per story
router.get('/:specId/comments/counts', (req: Request, res: Response) => {
  try {
    const { specId } = req.params;

    const rows = db.prepare(`
      SELECT story_id, COUNT(*) as count
      FROM story_comments
      WHERE spec_id = ? AND resolved_at IS NULL
      GROUP BY story_id
    `).all(specId) as { story_id: string; count: number }[];

    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[row.story_id] = row.count;
    }

    res.json({ counts });
  } catch (error: any) {
    console.error('[StoryComments] Counts error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── V2-042: PUT /:specId/assign — Assign spec to a user ──────────────────────

interface AssignmentRow {
  id: number;
  spec_id: string;
  story_id: string;
  workspace_id: string;
  assignee_id: string;
  assigned_at: string;
  assigned_by: string | null;
}

router.put('/:specId/assign', (req: Request, res: Response) => {
  try {
    const specId = req.params.specId as string;
    const { workspaceId, assigneeId } = req.body;
    const user = getEffectiveUser(req);
    if (!user) { res.status(500).json({ error: 'No user configured' }); return; }

    if (!workspaceId) {
      res.status(400).json({ error: 'Missing required field: workspaceId' });
      return;
    }

    const workspace = getWorkspace(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    // Verify spec exists
    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    if (!fs.existsSync(path.join(pendingDir, `${specId}.json`)) &&
        !fs.existsSync(path.join(approvedDir, `${specId}.json`))) {
      res.status(404).json({ error: 'Spec not found' });
      return;
    }

    // If assigneeId is null/empty, remove assignment
    if (!assigneeId) {
      db.prepare(
        "DELETE FROM spec_assignments WHERE spec_id = ? AND story_id = '' AND workspace_id = ?"
      ).run(specId, workspaceId);

      const walResult = db.prepare(
        `INSERT INTO wal_events (event_type, workspace_id, spec_id, actor, payload) VALUES (?, ?, ?, ?, ?)`
      ).run('spec_unassigned', workspaceId, specId, user?.id ?? 'api', JSON.stringify({ specId }));

      broadcastAll({
        id: walResult.lastInsertRowid as number,
        ts: new Date().toISOString(),
        event_type: 'spec_unassigned',
        workspace_id: workspaceId,
        spec_id: specId,
        story_id: null,
        actor: user?.id ?? 'api',
        payload: JSON.stringify({ specId }),
      });

      res.json({ ok: true, assigneeId: null });
      return;
    }

    // Verify assignee exists
    const assignee = db.prepare('SELECT id, display_name, email, avatar_url FROM users WHERE id = ?').get(assigneeId) as
      | { id: string; display_name: string; email: string; avatar_url: string | null }
      | undefined;
    if (!assignee) {
      res.status(404).json({ error: 'Assignee user not found' });
      return;
    }

    // Upsert assignment
    db.prepare(`
      INSERT INTO spec_assignments (spec_id, story_id, workspace_id, assignee_id, assigned_by)
      VALUES (?, '', ?, ?, ?)
      ON CONFLICT(spec_id, story_id, workspace_id) DO UPDATE SET
        assignee_id = excluded.assignee_id,
        assigned_by = excluded.assigned_by,
        assigned_at = datetime('now')
    `).run(specId, workspaceId, assigneeId, user?.id ?? null);

    // WAL event
    const walResult = db.prepare(
      `INSERT INTO wal_events (event_type, workspace_id, spec_id, actor, payload) VALUES (?, ?, ?, ?, ?)`
    ).run('spec_assigned', workspaceId, specId, user?.id ?? 'api', JSON.stringify({
      assigneeId,
      assigneeName: assignee.display_name,
    }));

    broadcastAll({
      id: walResult.lastInsertRowid as number,
      ts: new Date().toISOString(),
      event_type: 'spec_assigned',
      workspace_id: workspaceId,
      spec_id: specId,
      story_id: null,
      actor: user?.id ?? 'api',
      payload: JSON.stringify({ assigneeId, assigneeName: assignee.display_name }),
    });

    res.json({ ok: true, assignee: { id: assignee.id, displayName: assignee.display_name, email: assignee.email, avatarUrl: assignee.avatar_url } });
  } catch (error: any) {
    console.error('[Specs] Assign spec error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── V2-042: PUT /:specId/stories/:storyId/assign — Assign story to a user ───

router.put('/:specId/stories/:storyId/assign', (req: Request, res: Response) => {
  try {
    const specId = req.params.specId as string;
    const storyId = req.params.storyId as string;
    const { workspaceId, assigneeId } = req.body;
    const user = getEffectiveUser(req);
    if (!user) { res.status(500).json({ error: 'No user configured' }); return; }

    if (!workspaceId) {
      res.status(400).json({ error: 'Missing required field: workspaceId' });
      return;
    }

    const workspace = getWorkspace(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    // Verify spec + story exists
    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const approvedFile = path.join(approvedDir, `${specId}.json`);
    const pendingFile = path.join(pendingDir, `${specId}.json`);

    let specPath: string | null = null;
    if (fs.existsSync(approvedFile)) specPath = approvedFile;
    else if (fs.existsSync(pendingFile)) specPath = pendingFile;

    if (!specPath) {
      res.status(404).json({ error: 'Spec not found' });
      return;
    }

    const content = JSON.parse(fs.readFileSync(specPath, 'utf8'));
    const stories: UserStory[] = content.userStories ?? [];
    if (!stories.some(s => s.id === storyId)) {
      res.status(404).json({ error: 'Story not found' });
      return;
    }

    // If assigneeId is null/empty, remove assignment
    if (!assigneeId) {
      db.prepare(
        'DELETE FROM spec_assignments WHERE spec_id = ? AND story_id = ? AND workspace_id = ?'
      ).run(specId, storyId, workspaceId);

      const walResult = db.prepare(
        `INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, actor, payload) VALUES (?, ?, ?, ?, ?, ?)`
      ).run('story_unassigned', workspaceId, specId, storyId, user?.id ?? 'api', JSON.stringify({ storyId }));

      broadcastAll({
        id: walResult.lastInsertRowid as number,
        ts: new Date().toISOString(),
        event_type: 'story_unassigned',
        workspace_id: workspaceId,
        spec_id: specId,
        story_id: storyId,
        actor: user?.id ?? 'api',
        payload: JSON.stringify({ storyId }),
      });

      res.json({ ok: true, assigneeId: null });
      return;
    }

    // Verify assignee exists
    const assignee = db.prepare('SELECT id, display_name, email, avatar_url FROM users WHERE id = ?').get(assigneeId) as
      | { id: string; display_name: string; email: string; avatar_url: string | null }
      | undefined;
    if (!assignee) {
      res.status(404).json({ error: 'Assignee user not found' });
      return;
    }

    // Upsert assignment
    db.prepare(`
      INSERT INTO spec_assignments (spec_id, story_id, workspace_id, assignee_id, assigned_by)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(spec_id, story_id, workspace_id) DO UPDATE SET
        assignee_id = excluded.assignee_id,
        assigned_by = excluded.assigned_by,
        assigned_at = datetime('now')
    `).run(specId, storyId, workspaceId, assigneeId, user?.id ?? null);

    // WAL event
    const walResult = db.prepare(
      `INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, actor, payload) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('story_assigned', workspaceId, specId, storyId, user?.id ?? 'api', JSON.stringify({
      assigneeId,
      assigneeName: assignee.display_name,
    }));

    broadcastAll({
      id: walResult.lastInsertRowid as number,
      ts: new Date().toISOString(),
      event_type: 'story_assigned',
      workspace_id: workspaceId,
      spec_id: specId,
      story_id: storyId,
      actor: user?.id ?? 'api',
      payload: JSON.stringify({ assigneeId, assigneeName: assignee.display_name }),
    });

    res.json({ ok: true, assignee: { id: assignee.id, displayName: assignee.display_name, email: assignee.email, avatarUrl: assignee.avatar_url } });
  } catch (error: any) {
    console.error('[Specs] Assign story error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── V2-042: GET /:specId/assignments — Get all assignments for a spec ────────

router.get('/:specId/assignments', (req: Request, res: Response) => {
  try {
    const specId = req.params.specId as string;
    const workspaceId = req.query.workspaceId as string;

    if (!workspaceId) {
      res.status(400).json({ error: 'Missing required query param: workspaceId' });
      return;
    }

    const rows = db.prepare(`
      SELECT sa.spec_id, sa.story_id, sa.assignee_id, sa.assigned_at,
             u.display_name, u.email, u.avatar_url
      FROM spec_assignments sa
      JOIN users u ON u.id = sa.assignee_id
      WHERE sa.spec_id = ? AND sa.workspace_id = ?
    `).all(specId, workspaceId) as {
      spec_id: string;
      story_id: string | null;
      assignee_id: string;
      assigned_at: string;
      display_name: string;
      email: string;
      avatar_url: string | null;
    }[];

    const assignments = rows.map(r => ({
      specId: r.spec_id,
      storyId: r.story_id || null,  // '' → null for API response
      assignee: {
        id: r.assignee_id,
        displayName: r.display_name,
        email: r.email,
        avatarUrl: r.avatar_url,
      },
      assignedAt: r.assigned_at,
    }));

    res.json({ assignments });
  } catch (error: any) {
    console.error('[Specs] Get assignments error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── V2-077: POST /:specId/stories/:storyId/enhance-criteria — AI-suggest acceptance criteria ───

router.post('/:specId/stories/:storyId/enhance-criteria', async (req: Request, res: Response) => {
  try {
    const { specId, storyId } = req.params;
    const { workspaceId } = req.body;

    if (!workspaceId) {
      res.status(400).json({ error: 'Missing required field: workspaceId' });
      return;
    }

    const workspace = getWorkspace(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const pendingFile = path.join(pendingDir, `${specId}.json`);
    const approvedFile = path.join(approvedDir, `${specId}.json`);

    let specFilePath: string;
    if (fs.existsSync(approvedFile)) specFilePath = approvedFile;
    else if (fs.existsSync(pendingFile)) specFilePath = pendingFile;
    else { res.status(404).json({ error: 'Spec not found' }); return; }

    const specContent = JSON.parse(fs.readFileSync(specFilePath, 'utf8'));
    const allStories: Array<{ id: string; title: string; description?: string; acceptanceCriteria: string[]; dependsOn?: string[] }> =
      specContent.userStories ?? specContent.stories ?? [];

    const targetStory = allStories.find(s => s.id === storyId);
    if (!targetStory) {
      res.status(404).json({ error: `Story ${storyId} not found in spec ${specId}` });
      return;
    }

    // Build related stories context (dependencies + dependents)
    const deps = targetStory.dependsOn ?? [];
    const sid = storyId as string;
    const dependents = allStories.filter(s => (s.dependsOn ?? []).includes(sid));
    const relatedStories = allStories.filter(s => deps.includes(s.id) || dependents.some(d => d.id === s.id));
    const relatedContext = relatedStories.length > 0
      ? relatedStories.map(s => `- ${s.id}: ${s.title} [AC: ${s.acceptanceCriteria.join('; ')}]`).join('\n')
      : 'None';

    // Synthesize direction stack context
    const l1Row = db.prepare(
      `SELECT content_yaml FROM direction_layers WHERE layer = 1 AND COALESCE(workspace_id, '') = '' AND COALESCE(domain, '') = ''`
    ).get() as { content_yaml: string } | undefined;
    const l3Row = db.prepare(
      `SELECT content_yaml FROM direction_layers WHERE layer = 3 AND workspace_id = ? AND COALESCE(domain, '') = ''`
    ).get(workspaceId) as { content_yaml: string } | undefined;

    const synthesized = synthesize({ l1: l1Row?.content_yaml, l3: l3Row?.content_yaml, specBrief: specContent.title ?? specId });

    const fullPrompt = [
      '=== INSTRUCTIONS: READ THIS FIRST ===',
      'You are a spec quality reviewer. Your ONLY job is to output a single valid JSON object.',
      'Do NOT explain. Do NOT ask questions. Do NOT add markdown fences. Do NOT converse.',
      'Output ONLY the raw JSON object. If you output anything else, you have failed.',
      '=== END INSTRUCTIONS ===',
      '',
      synthesized,
      '---',
      `TASK: Suggest additional acceptance criteria for story ${storyId} to improve quality and testability.`,
      '',
      `Story: ${targetStory.id} — ${targetStory.title}`,
      targetStory.description ? `Description: ${targetStory.description}` : '',
      '',
      `Existing acceptance criteria (${targetStory.acceptanceCriteria.length}):`,
      targetStory.acceptanceCriteria.map((ac, i) => `  ${i + 1}. ${ac}`).join('\n'),
      '',
      `Related stories for consistency:`,
      relatedContext,
      '',
      'Generate 3-5 NEW acceptance criteria that:',
      '- Are specific, measurable, and testable',
      '- Cover edge cases, error handling, or performance not already addressed',
      '- Are consistent with related stories in tone and granularity',
      '- Do NOT duplicate existing criteria',
      '',
      'OUTPUT FORMAT: Respond with ONLY a raw JSON object. No markdown. No preamble. Start with { and end with }.',
      'JSON schema: {"suggestions":[{"criterion":"string","rationale":"string"}]}',
      'Each suggestion has the criterion text and a brief rationale explaining why it was added.',
    ].filter(Boolean).join('\n');

    const enhanceUser = getEffectiveUser(req);
    if (!enhanceUser) { res.status(500).json({ error: 'No user configured' }); return; }
    const enhanceVaultCreds = resolveVaultCreds(enhanceUser.id, DEFAULT_MODEL);
    const rawResponse = await chatComplete(
      [{ role: 'user', content: fullPrompt }],
      { apiKey: enhanceVaultCreds.apiKey, baseUrl: enhanceVaultCreds.baseUrl },
    );

    let parsed: { suggestions: Array<{ criterion: string; rationale: string }> };
    try {
      const responseText = rawResponse.text;
      const fenceMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
      const jsonStr = fenceMatch ? fenceMatch[1].trim() : responseText.trim();
      const jsonStart = jsonStr.indexOf('{');
      parsed = JSON.parse(jsonStart > 0 ? jsonStr.slice(jsonStart) : jsonStr);
    } catch {
      res.status(500).json({ error: 'LLM returned non-JSON', raw: rawResponse.text });
      return;
    }

    if (!Array.isArray(parsed.suggestions)) {
      res.status(500).json({ error: 'Invalid structure from LLM — expected suggestions array' });
      return;
    }

    res.json({
      ok: true,
      storyId,
      existingCount: targetStory.acceptanceCriteria.length,
      suggestions: parsed.suggestions,
    });
  } catch (error: any) {
    console.error('[Specs] Enhance criteria error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── V2-077: POST /:specId/stories/:storyId/accept-criteria — Accept suggested criteria ───

router.post('/:specId/stories/:storyId/accept-criteria', async (req: Request, res: Response) => {
  try {
    const { specId, storyId } = req.params;
    const { workspaceId, criteria } = req.body;

    if (!workspaceId) {
      res.status(400).json({ error: 'Missing required field: workspaceId' });
      return;
    }
    if (!Array.isArray(criteria) || criteria.length === 0) {
      res.status(400).json({ error: 'Missing or empty criteria array' });
      return;
    }

    const workspace = getWorkspace(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const pendingFile = path.join(pendingDir, `${specId}.json`);
    const approvedFile = path.join(approvedDir, `${specId}.json`);

    let specFilePath: string;
    if (fs.existsSync(approvedFile)) specFilePath = approvedFile;
    else if (fs.existsSync(pendingFile)) specFilePath = pendingFile;
    else { res.status(404).json({ error: 'Spec not found' }); return; }

    const specContent = JSON.parse(fs.readFileSync(specFilePath, 'utf8'));
    const allStories: Array<{ id: string; acceptanceCriteria: string[] }> =
      specContent.userStories ?? specContent.stories ?? [];

    const targetStory = allStories.find(s => s.id === storyId);
    if (!targetStory) {
      res.status(404).json({ error: `Story ${storyId} not found in spec ${specId}` });
      return;
    }

    // Append accepted criteria (deduplicate)
    const existing = new Set(targetStory.acceptanceCriteria);
    const added: string[] = [];
    for (const c of criteria) {
      if (typeof c === 'string' && c.trim() && !existing.has(c.trim())) {
        targetStory.acceptanceCriteria.push(c.trim());
        existing.add(c.trim());
        added.push(c.trim());
      }
    }

    fs.writeFileSync(specFilePath, JSON.stringify(specContent, null, 2), 'utf8');

    res.json({
      ok: true,
      storyId,
      addedCount: added.length,
      totalCriteria: targetStory.acceptanceCriteria.length,
    });
  } catch (error: any) {
    console.error('[Specs] Accept criteria error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
