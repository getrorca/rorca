import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { db } from '../db/index';
import { synthesize } from '../lib/direction-stack';
import { generateDiagramBundle } from '../lib/diagram-generator';
import { chatComplete, getActiveProvider, getActiveModel } from '../lib/llm-client';
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
    const { workspaceId, domain, diagramTypes, storyAnnotations } = req.body;
    const title: string = req.body.title || req.body.specName;
    const brief: string = req.body.brief || req.body.specBrief;
    const storyCount: number = Math.min(500, Math.max(1, parseInt(req.body.storyCount) || 8));

    // 1. Validate required fields
    if (!workspaceId || !title || !brief) {
      res.status(400).json({ error: 'Missing required fields: workspaceId, title (or specName), brief (or specBrief)' });
      return;
    }

    // 2. Fetch workspace from DB
    const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId) as Record<string, unknown> | undefined;
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
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

    // 7. Build LLM prompt
    const storyPrefix = req.body.storyPrefix || 'US';
    const fullPrompt = [
      synthesized,
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

    // 8. Call LLM
    const rawResponse = await chatComplete([{ role: 'user', content: fullPrompt }]);

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
    const model = getActiveModel();
    db.prepare(
      `INSERT INTO wal_events (event_type, spec_id, payload) VALUES ('generate', ?, ?)`
    ).run(slug, JSON.stringify({
      title, domain, storyCount: parsed.stories.length, provider, model,
      hasSchema: !!schemaSnapshot, hasGitMemory: !!gitMemory,
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

// ─── W-003: GET /archive — Searchable, filterable spec archive ────────────────

interface ArchiveSpecSummary extends SpecSummary {
  rejectedAt?: string;
  rejectReason?: string;
  storyTitles: string[];
}

function buildArchiveSummary(
  filePath: string,
  fileName: string,
  status: 'pending' | 'approved',
  workspacePath: string,
): ArchiveSpecSummary {
  const base = buildSummary(filePath, fileName, status, workspacePath);
  const content = parseSpecFile(filePath);
  const stories = (content as any).userStories ?? (content as any).stories ?? [];
  const storyTitles = stories.map((s: any) => s.title ?? s.id ?? '').filter(Boolean);
  return { ...base, storyTitles };
}

function matchesSearch(spec: ArchiveSpecSummary, q: string): boolean {
  const lower = q.toLowerCase();
  if (spec.specName.toLowerCase().includes(lower)) return true;
  if (spec.id.toLowerCase().includes(lower)) return true;
  for (const title of spec.storyTitles) {
    if (title.toLowerCase().includes(lower)) return true;
  }
  return false;
}

router.get('/archive', (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string;
    const q = (req.query.q as string) || '';
    const statusFilter = (req.query.status as string) || 'all';
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;

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
    const allSpecs: ArchiveSpecSummary[] = [];

    // Collect pending specs
    if (statusFilter === 'all' || statusFilter === 'pending') {
      for (const file of safeReaddir(pendingDir)) {
        try {
          allSpecs.push(buildArchiveSummary(path.join(pendingDir, file), file, 'pending', workspace.path));
        } catch {
          // skip unparseable files
        }
      }
    }

    // Collect approved specs
    if (statusFilter === 'all' || statusFilter === 'approved') {
      for (const file of safeReaddir(approvedDir)) {
        try {
          allSpecs.push(buildArchiveSummary(path.join(approvedDir, file), file, 'approved', workspace.path));
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
        // Skip if spec still exists (re-generated after rejection)
        if (allSpecs.some(s => s.id === evt.spec_id)) continue;

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
          storyTitles: [],
        });
      }
    }

    // Sort by generatedAt DESC
    allSpecs.sort((a, b) =>
      new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime()
    );

    // Apply search filter
    const filtered = q ? allSpecs.filter(s => matchesSearch(s, q)) : allSpecs;

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
