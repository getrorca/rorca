import { Router, Request, Response } from 'express';
import { db } from '../db/index';
import { synthesize } from '../lib/direction-stack';
import { generateDiagramBundle } from '../lib/diagram-generator';
import { chatComplete, getActiveProvider, getActiveModel } from '../lib/llm-client';
import { writeSpec } from '../lib/spec-writer';

const router = Router();

router.post('/generate', async (req: Request, res: Response) => {
  try {
    const { workspaceId, domain, title, brief, diagramTypes, storyAnnotations } = req.body;

    // 1. Validate required fields
    if (!workspaceId || !domain || !title || !brief) {
      res.status(400).json({ error: 'Missing required fields: workspaceId, domain, title, brief' });
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
    const fullPrompt = synthesized +
      '\n\n---\nGenerate a software specification with 6-10 user stories for: ' + title +
      '\n\nRespond with ONLY valid JSON — no markdown, no explanation, just the JSON object:\n' +
      '{"stories":[{"id":"US-001","title":"","description":"","acceptanceCriteria":[],"dependsOn":[]}],' +
      '"diagrams":{"architecture":{"mermaid":"","ascii":""},"userFlow":{"mermaid":"","ascii":""}}}\n\n' +
      'Rules: Each story needs 3-5 specific testable acceptanceCriteria. dependsOn is an array of story id strings this story requires first. Use sequential ids like US-001, US-002.';

    // 8. Call LLM
    const rawResponse = await chatComplete([{ role: 'user', content: fullPrompt }]);

    // 9. Parse JSON
    let parsed: { stories: unknown[]; diagrams?: Record<string, unknown> };
    try {
      parsed = JSON.parse(rawResponse);
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

    // 15. Write spec to workspace directory
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

    // 16. Return response
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

export default router;
