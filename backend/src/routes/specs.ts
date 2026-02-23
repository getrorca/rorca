import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { db } from '../db/index';
import { synthesize } from '../lib/direction-stack';
import { generateDiagramBundle } from '../lib/diagram-generator';
import { chatComplete, getActiveProvider, isValidModel, DEFAULT_MODEL, SUPPORTED_MODELS } from '../lib/llm-client';
import type { SupportedModel } from '../lib/llm-client';
import { writeSpec } from '../lib/spec-writer';

const router = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface WorkspaceRow {
  id: string;
  label: string;
  path: string;
}

interface SpecSummary {
  id: string;
  specName: string;
  storyCount: number;
  status: 'pending' | 'approved';
  generatedAt: string;
  approvedAt?: string;
  workspacePath: string;
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
  passes?: boolean;
}

function getWorkspace(workspaceId: string): WorkspaceRow | undefined {
  return db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId) as WorkspaceRow | undefined;
}

function specsDirs(workspacePath: string) {
  const pendingDir = path.join(workspacePath, 'scripts', 'ralph', 'specs', 'pending');
  const approvedDir = path.join(workspacePath, 'scripts', 'ralph', 'specs', 'approved');
  return { pendingDir, approvedDir };
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }
}

function parseSpecFile(filePath: string): { title?: string; userStories?: unknown[]; generatedAt?: string } {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function buildSummary(
  filePath: string,
  fileName: string,
  status: 'pending' | 'approved',
  workspacePath: string,
): SpecSummary {
  const content = parseSpecFile(filePath);
  const stat = fs.statSync(filePath);
  return {
    id: fileName.replace('.json', ''),
    specName: content.title ?? fileName.replace('.json', ''),
    storyCount: Array.isArray(content.userStories) ? content.userStories.length : 0,
    status,
    generatedAt: content.generatedAt ?? stat.birthtime.toISOString(),
    ...(status === 'approved' ? { approvedAt: stat.mtime.toISOString() } : {}),
    workspacePath,
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

    // 1b. Validate model if provided
    if (requestedModel && !isValidModel(requestedModel)) {
      res.status(400).json({
        error: `Invalid model: '${requestedModel}'. Supported models: ${SUPPORTED_MODELS.join(', ')}`,
      });
      return;
    }

    // 2. Fetch workspace from DB
    const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId) as Record<string, unknown> | undefined;
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    // 2b. Resolve model: request param > workspace L3 preferred_model > default
    let resolvedModel: SupportedModel = DEFAULT_MODEL;
    if (requestedModel && isValidModel(requestedModel)) {
      resolvedModel = requestedModel;
    } else if (!requestedModel) {
      // Check workspace L3 for preferred_model
      const l3Pref = db.prepare(
        `SELECT preferred_model FROM direction_layers WHERE layer = 3 AND workspace_id = ? AND COALESCE(domain, '') = ''`
      ).get(workspaceId) as { preferred_model: string | null } | undefined;
      if (l3Pref?.preferred_model && isValidModel(l3Pref.preferred_model)) {
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
    const fullPrompt = [
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
      `{"stories":[{"id":"${storyPrefix}-001","title":"string","description":"string","acceptanceCriteria":["string"],"dependsOn":["${storyPrefix}-001"]}]}`,
      '',
      `Rules:`,
      `- Generate exactly ${storyCount} stories, numbered ${storyPrefix}-001 through ${storyPrefix}-${String(storyCount).padStart(3, '0')}`,
      '- Each story needs 3-5 specific testable acceptanceCriteria',
      '- dependsOn lists story IDs this story requires to be done first (empty array if none)',
      '- Stories should be concrete and implementable, not vague',
      '- Your entire response must be valid JSON parseable by JSON.parse()',
    ].join('\n');

    // 8. Call LLM with selected model
    const llmResult = await chatComplete([{ role: 'user', content: fullPrompt }], resolvedModel);
    const rawResponse = llmResult.text;
    const tokenUsage = llmResult.usage;

    // 9. Parse JSON — strip markdown fences and preamble text if present
    let parsed: { stories: unknown[]; diagrams?: Record<string, unknown> };
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

// ─── R-001: GET / — List specs with status ──────────────────────────────────

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

    if (statusFilter !== 'approved') {
      for (const file of safeReaddir(pendingDir)) {
        try {
          specs.push(buildSummary(path.join(pendingDir, file), file, 'pending', workspace.path));
        } catch {
          // skip unparseable files
        }
      }
    }

    if (statusFilter !== 'pending') {
      for (const file of safeReaddir(approvedDir)) {
        try {
          specs.push(buildSummary(path.join(approvedDir, file), file, 'approved', workspace.path));
        } catch {
          // skip unparseable files
        }
      }
    }

    // Sort by generatedAt DESC
    specs.sort((a, b) =>
      new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime()
    );

    res.json({ specs });
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
): ArchiveSpecSummary {
  const base = buildSummary(filePath, fileName, status, workspacePath);
  const content = parseSpecFile(filePath);
  const stories = (content as any).userStories ?? (content as any).stories ?? [];
  const storyTitles = stories.map((s: any) => s.title ?? s.id ?? '').filter(Boolean);
  const repoName = path.basename(workspacePath);
  return { ...base, storyTitles, repoName, branchName };
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

router.get('/archive', (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string;
    const q = (req.query.q as string) || '';
    const statusFilter = (req.query.status as string) || 'all';
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;
    const createdAfter = req.query.createdAfter as string | undefined;
    const createdBefore = req.query.createdBefore as string | undefined;

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
          allSpecs.push(buildArchiveSummary(path.join(pendingDir, file), file, 'pending', workspace.path, branchBySlug.get(slug)));
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
          allSpecs.push(buildArchiveSummary(path.join(approvedDir, file), file, 'approved', workspace.path, branchBySlug.get(slug)));
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
    const total = filtered.length;
    const paged = filtered.slice(offset, offset + limit);

    res.json({
      specs: paged,
      total,
      hasMore: offset + limit < total,
    });
  } catch (error: any) {
    console.error('[Specs] Archive error:', error);
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
      'Rules: 3-5 testable acceptanceCriteria per story. dependsOn lists IDs this story requires first (empty array if none).',
    ].filter(Boolean).join('\n');

    const { chatComplete } = await import('../lib/llm-client');
    const rawResponse = await chatComplete([{ role: 'user', content: fullPrompt }]);

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

    res.json({ specSlug: specId, versions });
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

// ─── R-001: GET /:specId — Return full spec JSON ─────────────────────────────

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

    let content: unknown;
    if (fs.existsSync(pendingFile)) {
      content = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
    } else if (fs.existsSync(approvedFile)) {
      content = JSON.parse(fs.readFileSync(approvedFile, 'utf8'));
    } else {
      res.status(404).json({ error: 'Spec not found' });
      return;
    }

    res.json(content);
  } catch (error: any) {
    console.error('[Specs] Get error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── R-001: POST /:specId/approve — Move to approved/ ────────────────────────

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

// ─── R-001: POST /:specId/reject — Delete spec ───────────────────────────────

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

export default router;
