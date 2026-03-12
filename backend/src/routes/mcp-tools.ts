import { Router, Request, Response, NextFunction } from 'express';

const router = Router();

/**
 * MCP tool definitions — canonical list with categories, descriptions, and schemas.
 * Grouped into exactly 5 categories matching the CLAUDE.md spec.
 * Tools from MC-001 and MC-002 are appended to 'Specs & Pipeline'.
 */
interface McpToolDef {
  name: string;
  description: string;
  category: string;
  inputSchema: Record<string, unknown>;
  requiredParams: string[];
}

const MCP_TOOLS: McpToolDef[] = [
  // ─── Specs & Pipeline (9 existing + MC-001 + MC-002 = 11) ─────────────────
  {
    name: 'rorca_get_context',
    description: 'Get the synthesized Direction Stack (L1–L5) for a workspace. Returns all direction layers merged in priority order.',
    category: 'Specs & Pipeline',
    inputSchema: {
      workspaceId: { type: 'string', description: 'Rorca workspace ID' },
      specBrief: { type: 'string', description: 'L4: description of the specific spec being worked on' },
      storyAnnotations: { type: 'string', description: 'L5: story-level context, acceptance criteria notes' },
    },
    requiredParams: ['workspaceId'],
  },
  {
    name: 'rorca_generate_spec',
    description: 'Generate a spec JSON (with userStories array) from a brief. Calls the Rorca synthesis engine which injects the full Direction Stack before sending to the LLM.',
    category: 'Specs & Pipeline',
    inputSchema: {
      workspaceId: { type: 'string', description: 'Rorca workspace ID' },
      specBrief: { type: 'string', description: 'One-paragraph description of the feature or system to spec out' },
      title: { type: 'string', description: 'Short title for the spec (used as filename slug)' },
      storyCount: { type: 'number', description: 'Target number of user stories (default 8)' },
      includeDiagrams: { type: 'boolean', description: 'Whether to include Mermaid and ASCII diagrams' },
      model: { type: 'string', description: 'LLM model to use for generation' },
    },
    requiredParams: ['workspaceId', 'specBrief', 'title'],
  },
  {
    name: 'rorca_list_specs',
    description: 'List all specs in a workspace grouped by status: pending (awaiting review), approved (ready to run), and running (currently executing).',
    category: 'Specs & Pipeline',
    inputSchema: {
      workspaceId: { type: 'string', description: 'Rorca workspace ID' },
      status: { type: 'string', description: 'Filter by spec status: pending | approved | all' },
    },
    requiredParams: ['workspaceId'],
  },
  {
    name: 'rorca_approve_spec',
    description: 'Approve a pending spec and move it to the approved queue. Once approved, the spec can be executed via the pipeline.',
    category: 'Specs & Pipeline',
    inputSchema: {
      workspaceId: { type: 'string', description: 'Rorca workspace ID' },
      specId: { type: 'string', description: 'Spec ID (from rorca_list_specs output)' },
      notes: { type: 'string', description: 'Optional approval notes to append to the spec' },
    },
    requiredParams: ['workspaceId', 'specId'],
  },
  {
    name: 'rorca_pipeline_status',
    description: 'Get the status of the active or most recent pipeline run for a workspace. Returns run status, story progress counts, elapsed time.',
    category: 'Specs & Pipeline',
    inputSchema: {
      workspaceId: { type: 'string', description: 'Rorca workspace ID' },
      runId: { type: 'number', description: 'Specific run ID. If omitted, returns the most recent run.' },
    },
    requiredParams: ['workspaceId'],
  },
  {
    name: 'rorca_trigger_run',
    description: 'Start a pipeline run for an approved spec. Spawns the execution engine to execute all user stories sequentially. Supports dry-run and git worktree isolation.',
    category: 'Specs & Pipeline',
    inputSchema: {
      workspaceId: { type: 'string', description: 'Rorca workspace ID' },
      specId: { type: 'string', description: 'Spec ID (filename slug) — must be in approved status' },
      dryRun: { type: 'boolean', description: 'If true, returns a cost estimate without spawning the run' },
      autoWorktree: { type: 'boolean', description: 'If true, creates an isolated git worktree branch for this run' },
    },
    requiredParams: ['workspaceId', 'specId'],
  },
  {
    name: 'rorca_run_status',
    description: 'Get detailed status of a specific pipeline run including per-story progress, elapsed time, token counts, and retry counts.',
    category: 'Specs & Pipeline',
    inputSchema: {
      runId: { type: 'number', description: 'Pipeline run ID' },
    },
    requiredParams: ['runId'],
  },
  {
    name: 'rorca_list_runs',
    description: 'List recent pipeline runs for a workspace. Returns run status, spec path, story counts, start/finish times.',
    category: 'Specs & Pipeline',
    inputSchema: {
      workspaceId: { type: 'string', description: 'Rorca workspace ID' },
      limit: { type: 'number', description: 'Maximum runs to return (default 10)' },
    },
    requiredParams: ['workspaceId'],
  },
  {
    name: 'rorca_retry_story',
    description: 'Retry failed stories in a completed run. Spawns the execution engine for only the failed stories.',
    category: 'Specs & Pipeline',
    inputSchema: {
      runId: { type: 'number', description: 'Pipeline run ID containing the failed stories' },
      storyId: { type: 'string', description: 'Specific story ID to retry. If omitted, retries all failed stories.' },
    },
    requiredParams: ['runId'],
  },
  {
    name: 'rorca_forge_and_run',
    description: 'Brief-to-completion single tool. Generates a spec from a brief, approves it, and starts the pipeline run — all in one call. Reports progress as stories complete.',
    category: 'Specs & Pipeline',
    inputSchema: {
      workspaceId: { type: 'string', description: 'Rorca workspace ID' },
      brief: { type: 'string', description: 'Plain-English description of the feature to build' },
      title: { type: 'string', description: 'Short title for the spec (used as filename slug)' },
      storyCount: { type: 'number', description: 'Target number of user stories (default 8)' },
      model: { type: 'string', description: 'LLM model to use for spec generation' },
      autoWorktree: { type: 'boolean', description: 'If true, runs in an isolated git worktree branch' },
      dryRun: { type: 'boolean', description: 'If true, generates and approves spec but does not trigger run' },
    },
    requiredParams: ['workspaceId', 'brief', 'title'],
  },
  {
    name: 'rorca_cancel_run',
    description: 'Cancel an active pipeline run. Sends SIGTERM to the execution engine process then marks the run as failed in the database.',
    category: 'Specs & Pipeline',
    inputSchema: {
      runId: { type: 'number', description: 'Pipeline run ID to cancel' },
      reason: { type: 'string', description: 'Optional cancellation reason (recorded in WAL events)' },
    },
    requiredParams: ['runId'],
  },

  // ─── Story Editing (4) ────────────────────────────────────────────────────
  {
    name: 'rorca_edit_story',
    description: 'Update a story\'s title, description, or acceptance criteria in a spec file.',
    category: 'Story Editing',
    inputSchema: {
      workspaceId: { type: 'string', description: 'Rorca workspace ID' },
      specId: { type: 'string', description: 'Spec ID (filename slug)' },
      storyId: { type: 'string', description: 'Story ID (e.g. US-001)' },
      title: { type: 'string', description: 'New story title' },
      description: { type: 'string', description: 'New story description' },
      acceptanceCriteria: { type: 'array', description: 'New acceptance criteria list' },
    },
    requiredParams: ['workspaceId', 'specId', 'storyId'],
  },
  {
    name: 'rorca_add_stories',
    description: 'Generate and append new LLM-generated stories to an existing spec. Useful for extending a spec after initial generation.',
    category: 'Story Editing',
    inputSchema: {
      workspaceId: { type: 'string', description: 'Rorca workspace ID' },
      specId: { type: 'string', description: 'Spec ID (filename slug)' },
      brief: { type: 'string', description: 'Description of the additional stories to generate' },
      count: { type: 'number', description: 'Number of stories to generate (default 3)' },
    },
    requiredParams: ['workspaceId', 'specId', 'brief'],
  },
  {
    name: 'rorca_delete_story',
    description: 'Remove a story from a spec. Reindexes remaining stories and creates a snapshot before deletion.',
    category: 'Story Editing',
    inputSchema: {
      workspaceId: { type: 'string', description: 'Rorca workspace ID' },
      specId: { type: 'string', description: 'Spec ID (filename slug)' },
      storyId: { type: 'string', description: 'Story ID to delete (e.g. US-003)' },
    },
    requiredParams: ['workspaceId', 'specId', 'storyId'],
  },
  {
    name: 'rorca_search_stories',
    description: 'Full-text search across all stories in all specs in a workspace. Returns matching stories with their spec and context.',
    category: 'Story Editing',
    inputSchema: {
      workspaceId: { type: 'string', description: 'Rorca workspace ID' },
      query: { type: 'string', description: 'Search query' },
      limit: { type: 'number', description: 'Max results to return (default 20)' },
    },
    requiredParams: ['workspaceId', 'query'],
  },

  // ─── Direction Stack (3) ──────────────────────────────────────────────────
  {
    name: 'rorca_get_direction',
    description: 'Get all direction layers (L1–L3) for a workspace with raw content. L1 = global engineering principles, L2 = domain conventions, L3 = project-specific stack and constraints.',
    category: 'Direction Stack',
    inputSchema: {
      workspaceId: { type: 'string', description: 'Rorca workspace ID' },
    },
    requiredParams: ['workspaceId'],
  },
  {
    name: 'rorca_update_direction',
    description: 'Update a specific direction layer (L1/L2/L3) for a workspace. Content is markdown. Changes take effect immediately on next spec generation or pipeline run.',
    category: 'Direction Stack',
    inputSchema: {
      workspaceId: { type: 'string', description: 'Rorca workspace ID' },
      layer: { type: 'string', description: 'Direction layer to update: L1 | L2 | L3' },
      content: { type: 'string', description: 'New markdown content for this direction layer' },
    },
    requiredParams: ['workspaceId', 'layer', 'content'],
  },
  {
    name: 'rorca_synthesize_direction',
    description: 'Preview the merged direction string exactly as sent to the LLM. Shows how L1–L5 layers combine, with L4/L5 from an optional spec brief and story annotations.',
    category: 'Direction Stack',
    inputSchema: {
      workspaceId: { type: 'string', description: 'Rorca workspace ID' },
      specBrief: { type: 'string', description: 'L4: spec-level context to include in synthesis' },
      storyAnnotations: { type: 'string', description: 'L5: story-level annotations to include' },
    },
    requiredParams: ['workspaceId'],
  },

  // ─── Workspaces (4) ───────────────────────────────────────────────────────
  {
    name: 'rorca_list_workspaces',
    description: 'List all registered workspaces with their paths, domains, and labels.',
    category: 'Workspaces',
    inputSchema: {},
    requiredParams: [],
  },
  {
    name: 'rorca_create_workspace',
    description: 'Register a new workspace by filesystem path. The path must be an existing git repository.',
    category: 'Workspaces',
    inputSchema: {
      path: { type: 'string', description: 'Absolute filesystem path to the git repository' },
      label: { type: 'string', description: 'Human-readable label for the workspace' },
      domain: { type: 'string', description: 'Domain tag (e.g. saas, cli, mobile) for L2 direction routing' },
    },
    requiredParams: ['path', 'label'],
  },
  {
    name: 'rorca_workspace_stats',
    description: 'Get spec count, run count, pass rate, and last activity timestamp for a workspace.',
    category: 'Workspaces',
    inputSchema: {
      workspaceId: { type: 'string', description: 'Rorca workspace ID' },
    },
    requiredParams: ['workspaceId'],
  },
  {
    name: 'rorca_team_members',
    description: 'Get team members for a workspace including their roles and last active timestamps.',
    category: 'Workspaces',
    inputSchema: {
      workspaceId: { type: 'string', description: 'Rorca workspace ID' },
    },
    requiredParams: ['workspaceId'],
  },
  // rorca_usage_stats added to Workspaces for 4 total
  {
    name: 'rorca_usage_stats',
    description: 'Get token usage and cost summary for a workspace over a date range. Returns per-model breakdown and total spend.',
    category: 'Workspaces',
    inputSchema: {
      workspaceId: { type: 'string', description: 'Rorca workspace ID' },
      from: { type: 'string', description: 'Start date (ISO format, e.g. 2026-01-01)' },
      to: { type: 'string', description: 'End date (ISO format, e.g. 2026-03-31)' },
    },
    requiredParams: ['workspaceId'],
  },

  // ─── Memory (3) ───────────────────────────────────────────────────────────
  {
    name: 'rorca_save_memory',
    description: 'Save a memory entry (Architecture/Convention/Bug Fix/Decision/Pattern/Gotcha) to the workspace episodic ledger. Entries are injected into each story\'s context on the next pipeline run.',
    category: 'Memory',
    inputSchema: {
      workspaceId: { type: 'string', description: 'Rorca workspace ID' },
      category: { type: 'string', description: 'Memory category: Architecture | Convention | Bug Fix | Decision | Pattern | Gotcha' },
      title: { type: 'string', description: 'Short title summarizing the memory' },
      rule: { type: 'string', description: 'The rule, convention, or lesson learned' },
      context: { type: 'string', description: 'Additional context or background' },
    },
    requiredParams: ['workspaceId', 'category', 'title', 'rule'],
  },
  {
    name: 'rorca_log_decision',
    description: 'Shortcut for saving an architectural decision with structured reasoning. Saved as a Decision category memory entry.',
    category: 'Memory',
    inputSchema: {
      workspaceId: { type: 'string', description: 'Rorca workspace ID' },
      title: { type: 'string', description: 'Decision title (e.g. "Use Zustand over Redux")' },
      decision: { type: 'string', description: 'What was decided and why' },
      alternatives: { type: 'string', description: 'Alternatives considered and why rejected' },
    },
    requiredParams: ['workspaceId', 'title', 'decision'],
  },
  {
    name: 'rorca_get_memories',
    description: 'Retrieve memories from the workspace ledger, optionally filtered by category. Returns timestamped entries sorted by date descending.',
    category: 'Memory',
    inputSchema: {
      workspaceId: { type: 'string', description: 'Rorca workspace ID' },
      category: { type: 'string', description: 'Filter by category: Architecture | Convention | Bug Fix | Decision | Pattern | Gotcha' },
      limit: { type: 'number', description: 'Max entries to return (default 20)' },
    },
    requiredParams: ['workspaceId'],
  },
];

/**
 * @swagger
 * /api/mcp/tools:
 *   get:
 *     tags: [MCP]
 *     summary: List all available Rorca MCP tools
 *     operationId: listMcpTools
 *     description: >
 *       Returns the complete list of Rorca MCP tools with their names, descriptions,
 *       categories, input schemas, and required parameters. Tools are grouped into
 *       5 categories: 'Specs & Pipeline' (11 tools), 'Story Editing' (4 tools),
 *       'Direction Stack' (3 tools), 'Workspaces' (5 tools), 'Memory' (3 tools).
 *       Used by the VS Code extension MCP Tools panel to populate its tree view.
 *     parameters:
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *         description: Filter tools by category (optional)
 *     responses:
 *       200:
 *         description: List of MCP tools
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 tools:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name: { type: string }
 *                       description: { type: string }
 *                       category: { type: string }
 *                       inputSchema: { type: object }
 *                       requiredParams:
 *                         type: array
 *                         items: { type: string }
 *                 total: { type: integer }
 *                 categories:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name: { type: string }
 *                       count: { type: integer }
 */
router.get('/', (_req: Request, res: Response, next: NextFunction) => {
  try {
    const category = _req.query.category as string | undefined;
    const tools = category
      ? MCP_TOOLS.filter(t => t.category === category)
      : MCP_TOOLS;

    // Build category summary
    const categoryMap = new Map<string, number>();
    for (const t of MCP_TOOLS) {
      categoryMap.set(t.category, (categoryMap.get(t.category) ?? 0) + 1);
    }
    const categories = Array.from(categoryMap.entries()).map(([name, count]) => ({ name, count }));

    res.json({
      tools,
      total: tools.length,
      categories,
    });
  } catch (err) { next(err); }
});

export default router;
