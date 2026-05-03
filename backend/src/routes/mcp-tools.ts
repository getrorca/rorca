/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { Router } from 'express';

const router = Router();

/**
 * The canonical list of MCP tools, grouped into 5 categories.
 * This data is derived from backend/src/mcp/server.ts and stays
 * in sync manually when new tools are added to the stdio server.
 *
 * MC-004: Exposed as GET /api/mcp/tools for the VS Code extension tree view.
 */
interface McpToolDef {
  name: string;
  description: string;
  category: string;
  inputSchema: Record<string, unknown>;
  requiredParams: string[];
}

const MCP_TOOLS: McpToolDef[] = [
  // ─── Specs & Pipeline (9 + MC-001/MC-002 = 11) ──────────────────────────────
  {
    name: 'rorca_get_context',
    category: 'Specs & Pipeline',
    description: 'Get the synthesized Direction Stack for a workspace (L1–L5 merged in priority order).',
    inputSchema: {
      workspaceId: { type: 'string', description: 'Rorca workspace ID' },
      specBrief: { type: 'string', description: 'L4: one-paragraph description of the specific spec' },
      storyAnnotations: { type: 'string', description: 'L5: story-level context, acceptance criteria notes' },
    },
    requiredParams: ['workspaceId'],
  },
  {
    name: 'rorca_generate_spec',
    category: 'Specs & Pipeline',
    description: 'Generate a spec JSON (with userStories array) from a brief using the full Direction Stack.',
    inputSchema: {
      workspaceId: { type: 'string', description: 'Rorca workspace ID' },
      specBrief: { type: 'string', description: 'One-paragraph description of the feature to spec out' },
      title: { type: 'string', description: 'Short title for the spec (used as filename slug)' },
      storyCount: { type: 'number', description: 'Target number of user stories (default 8)' },
      includeDiagrams: { type: 'boolean', description: 'Whether to include Mermaid/ASCII diagrams' },
      model: { type: 'string', description: 'LLM model override (e.g. claude-opus-4-6)' },
    },
    requiredParams: ['workspaceId', 'specBrief', 'title'],
  },
  {
    name: 'rorca_list_specs',
    category: 'Specs & Pipeline',
    description: 'List all specs in a workspace grouped by status (pending/approved/running).',
    inputSchema: {
      workspaceId: { type: 'string', description: 'Rorca workspace ID' },
      status: { type: 'string', description: 'Filter by status: pending | approved | all' },
    },
    requiredParams: ['workspaceId'],
  },
  {
    name: 'rorca_approve_spec',
    category: 'Specs & Pipeline',
    description: 'Approve a pending spec and move it to the approved queue ready for pipeline execution.',
    inputSchema: {
      workspaceId: { type: 'string', description: 'Rorca workspace ID' },
      specId: { type: 'string', description: 'Spec ID (from rorca_list_specs)' },
      notes: { type: 'string', description: 'Optional approval notes to append to the spec' },
    },
    requiredParams: ['workspaceId', 'specId'],
  },
  {
    name: 'rorca_pipeline_status',
    category: 'Specs & Pipeline',
    description: 'Get the status of the active or most recent pipeline run with story-level progress.',
    inputSchema: {
      workspaceId: { type: 'string', description: 'Rorca workspace ID' },
      runId: { type: 'number', description: 'Specific run ID (optional, defaults to most recent)' },
    },
    requiredParams: ['workspaceId'],
  },
  {
    name: 'rorca_trigger_run',
    category: 'Specs & Pipeline',
    description: 'Start a pipeline run for an approved spec. Supports dry-run and isolated git worktree.',
    inputSchema: {
      workspaceId: { type: 'string', description: 'Rorca workspace ID' },
      specId: { type: 'string', description: 'Spec ID (filename slug, must be in approved status)' },
      dryRun: { type: 'boolean', description: 'Return cost estimate without executing (default false)' },
      autoWorktree: { type: 'boolean', description: 'Create isolated git worktree branch (default false)' },
    },
    requiredParams: ['workspaceId', 'specId'],
  },
  {
    name: 'rorca_run_status',
    category: 'Specs & Pipeline',
    description: 'Get detailed per-story status of a specific pipeline run with token counts.',
    inputSchema: {
      runId: { type: 'number', description: 'Pipeline run ID' },
    },
    requiredParams: ['runId'],
  },
  {
    name: 'rorca_list_runs',
    category: 'Specs & Pipeline',
    description: 'List recent pipeline runs for a workspace ordered by most recent first.',
    inputSchema: {
      workspaceId: { type: 'string', description: 'Rorca workspace ID' },
      limit: { type: 'number', description: 'Maximum number of runs to return (default 10, max 50)' },
    },
    requiredParams: ['workspaceId'],
  },
  {
    name: 'rorca_retry_story',
    category: 'Specs & Pipeline',
    description: 'Retry one or more failed stories in a completed pipeline run.',
    inputSchema: {
      runId: { type: 'number', description: 'Pipeline run ID' },
      storyIds: { type: 'array', description: 'Story IDs to retry (e.g. ["US-003"]). Omit to retry all failed.' },
    },
    requiredParams: ['runId'],
  },
  {
    name: 'rorca_usage_stats',
    category: 'Specs & Pipeline',
    description: 'Get token usage and cost summary for a workspace over a date range.',
    inputSchema: {
      workspaceId: { type: 'string', description: 'Rorca workspace ID' },
      from: { type: 'string', description: 'Start date (ISO-8601, e.g. "2026-01-01")' },
      to: { type: 'string', description: 'End date (ISO-8601, e.g. "2026-02-01")' },
      groupBy: { type: 'string', description: 'Group by: model | spec | story | user (default: model)' },
    },
    requiredParams: ['workspaceId'],
  },

  // ─── Story Editing (4 tools) ─────────────────────────────────────────────────
  {
    name: 'rorca_edit_story',
    category: 'Story Editing',
    description: 'Update a single story\'s title, description, or acceptance criteria in an existing spec.',
    inputSchema: {
      workspaceId: { type: 'string', description: 'Rorca workspace ID' },
      specId: { type: 'string', description: 'Spec ID (filename slug)' },
      storyId: { type: 'string', description: 'Story ID (e.g. "US-001")' },
      title: { type: 'string', description: 'New title for the story' },
      description: { type: 'string', description: 'New description for the story' },
      acceptanceCriteria: { type: 'array', description: 'New acceptance criteria (replaces existing)' },
    },
    requiredParams: ['workspaceId', 'specId', 'storyId'],
  },
  {
    name: 'rorca_add_stories',
    category: 'Story Editing',
    description: 'Generate and append new LLM-generated stories to an existing spec.',
    inputSchema: {
      workspaceId: { type: 'string', description: 'Rorca workspace ID' },
      specId: { type: 'string', description: 'Spec ID (filename slug) to add stories to' },
      count: { type: 'number', description: 'Number of new stories to generate (default 3, max 20)' },
      brief: { type: 'string', description: 'Optional guidance for what the new stories should cover' },
    },
    requiredParams: ['workspaceId', 'specId'],
  },
  {
    name: 'rorca_delete_story',
    category: 'Story Editing',
    description: 'Remove a story from a spec. Remaining stories are reindexed; a version snapshot is created.',
    inputSchema: {
      workspaceId: { type: 'string', description: 'Rorca workspace ID' },
      specId: { type: 'string', description: 'Spec ID (filename slug)' },
      storyId: { type: 'string', description: 'Story ID to delete (e.g. "US-003")' },
    },
    requiredParams: ['workspaceId', 'specId', 'storyId'],
  },
  {
    name: 'rorca_search_stories',
    category: 'Story Editing',
    description: 'Full-text search across all specs in a workspace for stories matching a query string.',
    inputSchema: {
      workspaceId: { type: 'string', description: 'Rorca workspace ID' },
      query: { type: 'string', description: 'Search query — matches story ID, title, description, and AC' },
    },
    requiredParams: ['workspaceId', 'query'],
  },

  // ─── Direction Stack (3 tools) ───────────────────────────────────────────────
  {
    name: 'rorca_get_direction',
    category: 'Direction Stack',
    description: 'Get the full direction stack for a workspace (L1 global brain, L2 domain, L3 project brief).',
    inputSchema: {
      workspaceId: { type: 'string', description: 'Rorca workspace ID' },
    },
    requiredParams: ['workspaceId'],
  },
  {
    name: 'rorca_update_direction',
    category: 'Direction Stack',
    description: 'Update a specific direction layer (L1, L2, or L3) for a workspace with YAML content.',
    inputSchema: {
      workspaceId: { type: 'string', description: 'Rorca workspace ID (required for L2/L3)' },
      layer: { type: 'number', description: 'Direction layer: 1 (global brain), 2 (domain), or 3 (project)' },
      contentYaml: { type: 'string', description: 'YAML content for the layer' },
      domain: { type: 'string', description: 'Domain name (only relevant for L2 layers)' },
      preferredModel: { type: 'string', description: 'Preferred LLM model (only valid for L3)' },
    },
    requiredParams: ['workspaceId', 'layer', 'contentYaml'],
  },
  {
    name: 'rorca_synthesize_direction',
    category: 'Direction Stack',
    description: 'Preview the fully merged direction string exactly as it would be sent to the LLM.',
    inputSchema: {
      workspaceId: { type: 'string', description: 'Rorca workspace ID' },
      specBrief: { type: 'string', description: 'L4: spec brief text (one-paragraph description)' },
      storyAnnotations: { type: 'string', description: 'L5: story-level annotations, edge cases' },
    },
    requiredParams: ['workspaceId'],
  },

  // ─── Workspaces (4 tools) ────────────────────────────────────────────────────
  {
    name: 'rorca_list_workspaces',
    category: 'Workspaces',
    description: 'List all registered workspaces with their IDs, labels, filesystem paths, and domain tags.',
    inputSchema: {},
    requiredParams: [],
  },
  {
    name: 'rorca_create_workspace',
    category: 'Workspaces',
    description: 'Register a new workspace by its filesystem path. Path must exist and be a git repository root.',
    inputSchema: {
      id: { type: 'string', description: 'Unique workspace ID (slug, e.g. "my-project")' },
      path: { type: 'string', description: 'Absolute filesystem path to the project root' },
      label: { type: 'string', description: 'Human-readable label (defaults to directory name)' },
      domains: { type: 'array', description: 'Domain tags for L2 direction matching (e.g. ["saas"])' },
    },
    requiredParams: ['id', 'path'],
  },
  {
    name: 'rorca_workspace_stats',
    category: 'Workspaces',
    description: 'Get summary stats for a workspace: spec count, run count, story pass rate, last activity.',
    inputSchema: {
      workspaceId: { type: 'string', description: 'Rorca workspace ID' },
    },
    requiredParams: ['workspaceId'],
  },
  {
    name: 'rorca_team_members',
    category: 'Workspaces',
    description: 'Get the team member list for a workspace with roles, emails, and last activity.',
    inputSchema: {
      workspaceId: { type: 'string', description: 'Rorca workspace ID (must be linked to a team)' },
    },
    requiredParams: ['workspaceId'],
  },

  // ─── Memory (3 tools) ────────────────────────────────────────────────────────
  {
    name: 'rorca_save_memory',
    category: 'Memory',
    description: 'Save a memory entry (Architecture/Convention/Bug Fix/Decision/Pattern/Gotcha) to the workspace ledger.',
    inputSchema: {
      workspaceId: { type: 'string', description: 'Rorca workspace ID' },
      category: { type: 'string', description: 'Memory category: Architecture | Convention | Bug Fix | Decision | Pattern | Gotcha' },
      title: { type: 'string', description: 'Short title summarizing the memory' },
      rule: { type: 'string', description: 'The actual rule, convention, or lesson learned' },
      context: { type: 'string', description: 'Additional context: why this matters, related files' },
      source: { type: 'string', description: 'Source of the memory (e.g. "manual", "code-review")' },
    },
    requiredParams: ['workspaceId', 'category', 'title', 'rule'],
  },
  {
    name: 'rorca_log_decision',
    category: 'Memory',
    description: 'Shortcut to save an architectural decision with structured reasoning and alternatives considered.',
    inputSchema: {
      workspaceId: { type: 'string', description: 'Rorca workspace ID' },
      title: { type: 'string', description: 'Decision title (e.g. "Use Zustand over Redux")' },
      decision: { type: 'string', description: 'What was decided and why' },
      alternatives: { type: 'string', description: 'What alternatives were considered and why rejected' },
    },
    requiredParams: ['workspaceId', 'title', 'decision'],
  },
  {
    name: 'rorca_get_memories',
    category: 'Memory',
    description: 'Paginated memory list with filters — use for browsing ("show last 50 memories") or filtering by category/confidence/run. Keyword search only. For semantic search ("find memories about X"), use rorca_recall_memories with currentTask or rorca_recall_workspace with query instead.',
    inputSchema: {
      workspaceId: { type: 'string', description: 'Rorca workspace ID' },
      category: { type: 'string', description: 'Filter by category (optional)' },
      limit: { type: 'number', description: 'Maximum entries to return (default 20, max 100)' },
    },
    requiredParams: ['workspaceId'],
  },
];

/**
 * @swagger
 * /api/mcp/tools:
 *   get:
 *     summary: List all available Rorca MCP tools
 *     description: >
 *       Returns all 24+ Rorca MCP tools grouped into 5 categories: Specs & Pipeline,
 *       Story Editing, Direction Stack, Workspaces, and Memory. Used by the VS Code
 *       extension tree view (MC-004) and any OpenAPI-to-MCP generation.
 *     tags:
 *       - MCP
 *     responses:
 *       200:
 *         description: List of all MCP tools
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 tools:
 *                   type: array
 *                   items:
 *                     type: object
 *                     required:
 *                       - name
 *                       - description
 *                       - category
 *                       - inputSchema
 *                       - requiredParams
 *                     properties:
 *                       name:
 *                         type: string
 *                         example: rorca_generate_spec
 *                       description:
 *                         type: string
 *                         example: Generate a spec JSON from a brief
 *                       category:
 *                         type: string
 *                         enum: [Specs & Pipeline, Story Editing, Direction Stack, Workspaces, Memory]
 *                       inputSchema:
 *                         type: object
 *                         additionalProperties: true
 *                       requiredParams:
 *                         type: array
 *                         items:
 *                           type: string
 */
router.get('/', (_req, res) => {
  res.json({ tools: MCP_TOOLS });
});

export default router;
