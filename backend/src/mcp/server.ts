/**
 * LEGACY STDIO MCP SERVER — kept as offline fallback.
 *
 * CA-021: The primary MCP transport is now Streamable HTTP at /mcp,
 * auto-generated from the OpenAPI spec. This stdio server is maintained
 * for offline/standalone usage when the backend isn't running.
 *
 * Preferred connection method:
 *   claude mcp add rorca --transport http http://localhost:3030/mcp
 *
 * Legacy connection method (this file):
 *   claude mcp add rorca -- npx tsx /path/to/rorca/backend/src/mcp/server.ts
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { logger } from '../lib/logger';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export const RORCA_API = process.env.RORCA_API_URL || 'http://localhost:3030';

export const server = new McpServer({
  name: 'rorca',
  version: '1.0.0',
});

server.registerTool(
  'rorca_get_context',
  {
    description: 'Get the synthesized Direction Stack for a workspace. Returns a single string containing all direction layers (L1 global brain, L2 domain profile, L3 project brief, L4 spec brief, L5 story annotations) merged in priority order. Use this to inject full AI context at the start of any spec generation or implementation session.',
    inputSchema: {
      workspaceId: z.string().describe('Rorca workspace ID (from rorca_list_workspaces or settings)'),
      specBrief: z.string().optional().describe('L4: one-paragraph description of the specific spec being worked on'),
      storyAnnotations: z.string().optional().describe('L5: story-level context, acceptance criteria notes, or implementation hints'),
    },
  },
  async ({ workspaceId, specBrief, storyAnnotations }) => {
    const res = await fetch(`${RORCA_API}/api/direction/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId,
        l4SpecBrief: specBrief,
        l5Annotations: storyAnnotations,
      }),
    });
    if (!res.ok) throw new Error(`Direction Stack synthesis failed: ${res.status}`);
    const { synthesized } = await res.json() as { synthesized: string };
    return { content: [{ type: 'text' as const, text: synthesized }] };
  }
);

server.registerTool(
  'rorca_generate_spec',
  {
    description: 'Generate a spec JSON (with userStories array) from a spec brief. Calls the Rorca synthesis engine which injects the full Direction Stack before sending to the LLM. Returns the generated spec as a JSON string ready to save as prd.json or submit for review.',
    inputSchema: {
      workspaceId: z.string().describe('Rorca workspace ID'),
      specBrief: z.string().describe('One-paragraph description of the feature or system to spec out'),
      title: z.string().describe('Short title for the spec (used as filename slug)'),
      storyCount: z.number().min(1).max(500).optional().default(8).describe('Target number of user stories (default 8)'),
      includeDiagrams: z.boolean().optional().default(true).describe('Whether to include Mermaid and ASCII diagrams in output'),
      model: z.enum(['claude-sonnet-4-5-20250929', 'claude-opus-4-6', 'claude-haiku-4-5-20251001']).optional().describe('LLM model to use for generation. If omitted, uses workspace default or claude-sonnet-4-5-20250929.'),
    },
  },
  async ({ workspaceId, specBrief, title, storyCount, includeDiagrams, model }) => {
    const resolvedStoryCount = storyCount ?? 8;
    const resolvedIncludeDiagrams = includeDiagrams ?? true;
    const res = await fetch(`${RORCA_API}/api/specs/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId, specBrief, title,
        storyCount: resolvedStoryCount,
        includeDiagrams: resolvedIncludeDiagrams,
        ...(model ? { model } : {}),
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Spec generation failed (${res.status}): ${err}`);
    }
    const spec = await res.json() as { model?: string; usage?: { inputTokens?: number; outputTokens?: number } };
    return {
      content: [
        { type: 'text' as const, text: `Generated spec: ${title}\nModel: ${spec.model ?? 'unknown'}\nTokens: ${spec.usage?.inputTokens ?? 0} in / ${spec.usage?.outputTokens ?? 0} out\n\n${JSON.stringify(spec, null, 2)}` }
      ]
    };
  }
);

server.registerTool(
  'rorca_list_specs',
  {
    description: 'List all specs in a workspace. Returns specs grouped by status: pending (generated, awaiting review), approved (ready to run via Ralph Loop), and running (currently executing in a pipeline). Useful for checking queue state before starting a pipeline.',
    inputSchema: {
      workspaceId: z.string().describe('Rorca workspace ID'),
      status: z.enum(['pending', 'approved', 'all']).optional().default('all').describe('Filter by spec status'),
    },
  },
  async ({ workspaceId, status }) => {
    const resolvedStatus = status ?? 'all';
    const res = await fetch(`${RORCA_API}/api/specs?workspaceId=${workspaceId}&status=${resolvedStatus}`);
    if (!res.ok) throw new Error(`Failed to list specs: ${res.status}`);
    const data = await res.json() as { items?: Array<{ id: string; title?: string; specName?: string; status: string; storyCount: number; createdAt: string }> } | Array<{ id: string; title?: string; specName?: string; status: string; storyCount: number; createdAt: string }>;
    const specs = Array.isArray(data) ? data : (data.items ?? []);
    if (specs.length === 0) {
      return { content: [{ type: 'text' as const, text: `No specs found for workspace ${workspaceId} (filter: ${resolvedStatus})` }] };
    }
    const lines = specs.map(s =>
      `[${s.status.toUpperCase()}] ${s.specName ?? s.title ?? s.id} (${s.storyCount} stories) — ${s.id}`
    );
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  }
);

server.registerTool(
  'rorca_approve_spec',
  {
    description: 'Approve a pending spec and move it to the approved queue. Once approved, the spec can be executed by Ralph Loop via run-loop.sh. Use rorca_list_specs to find the spec ID first.',
    inputSchema: {
      workspaceId: z.string().describe('Rorca workspace ID'),
      specId: z.string().describe('Spec ID (from rorca_list_specs output)'),
      notes: z.string().optional().describe('Optional approval notes to append to the spec'),
    },
  },
  async ({ workspaceId, specId, notes }) => {
    const body: Record<string, string> = { workspaceId };
    if (notes !== undefined) body.notes = notes;
    const res = await fetch(`${RORCA_API}/api/specs/${specId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Approval failed (${res.status}): ${err}`);
    }
    const { path: approvedPath } = await res.json() as { path: string };
    return {
      content: [{
        type: 'text' as const,
        text: `Spec approved and moved to: ${approvedPath}\n\nRun it with:\n  ~/rorca/forge/run-loop.sh --json ${approvedPath}`
      }]
    };
  }
);

server.registerTool(
  'rorca_pipeline_status',
  {
    description: 'Get the status of the active (or most recent) pipeline run for a workspace. Returns run status (running/paused/done/failed), story-level progress (pass/fail/skip counts), elapsed time, and last log line. Use this to monitor a Ralph Loop session without switching windows.',
    inputSchema: {
      workspaceId: z.string().describe('Rorca workspace ID'),
      runId: z.number().optional().describe('Specific run ID. If omitted, returns the most recent run.'),
    },
  },
  async ({ workspaceId, runId }) => {
    const url = runId
      ? `${RORCA_API}/api/pipeline-runs/${runId}`
      : `${RORCA_API}/api/pipeline-runs?workspaceId=${workspaceId}&limit=1`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to get pipeline status: ${res.status}`);
    const data = await res.json() as {
      id: number; status: string; specPath: string;
      startedAt: string; finishedAt?: string;
      stories: Array<{ storyId: string; status: string; retries: number }>;
    };
    const run = Array.isArray(data) ? data[0] : data;
    if (!run) return { content: [{ type: 'text' as const, text: `No pipeline runs found for workspace ${workspaceId}` }] };
    const pass = run.stories.filter((s: { status: string }) => s.status === 'pass').length;
    const fail = run.stories.filter((s: { status: string }) => s.status === 'fail').length;
    const skip = run.stories.filter((s: { status: string }) => s.status === 'skip').length;
    const total = run.stories.length;
    const elapsed = run.finishedAt
      ? `${Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 60000)}m`
      : `${Math.round((Date.now() - new Date(run.startedAt).getTime()) / 60000)}m (running)`;
    const summary = [
      `Run #${run.id}: ${run.status.toUpperCase()} (${elapsed})`,
      `Spec: ${run.specPath}`,
      `Stories: ${pass} pass / ${fail} fail / ${skip} skip / ${total} total`,
    ].join('\n');
    return { content: [{ type: 'text' as const, text: summary }] };
  }
);

// ─── V2-068: Pipeline Control & Analytics MCP Tools ───────────────────────────

server.registerTool(
  'rorca_trigger_run',
  {
    description: 'Start a pipeline run for an approved spec. Spawns run-loop.sh in the project workspace to execute all user stories sequentially. Optionally runs in dry-run mode (returns cost estimate without executing) or creates an isolated git worktree for the run.',
    inputSchema: {
      workspaceId: z.string().describe('Rorca workspace ID'),
      specId: z.string().describe('Spec ID (filename slug) — must be in approved status'),
      dryRun: z.boolean().optional().default(false).describe('If true, returns a cost estimate without spawning the run'),
      autoWorktree: z.boolean().optional().default(false).describe('If true, creates an isolated git worktree branch for this run'),
    },
  },
  async ({ workspaceId, specId, dryRun, autoWorktree }) => {
    const res = await fetch(`${RORCA_API}/api/pipeline/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId,
        specPath: `forge/specs/approved/${specId}.json`,
        dryRun: dryRun ?? false,
        autoWorktree: autoWorktree ?? false,
      }),
    });

    const data = await res.json() as Record<string, unknown>;

    if (!res.ok) {
      throw new Error(`Pipeline trigger failed (${res.status}): ${data.error ?? JSON.stringify(data)}`);
    }

    if (data.conflict) {
      return {
        content: [{
          type: 'text' as const,
          text: `Conflict: workspace already has an active run (run #${data.activeRunId}). Wait for it to finish or use autoWorktree to run in parallel.`
        }]
      };
    }

    if (data.dryRun) {
      return {
        content: [{
          type: 'text' as const,
          text: `Dry run estimate for ${specId}:\n${JSON.stringify(data.estimate, null, 2)}`
        }]
      };
    }

    const parts = [`Pipeline run #${data.runId} started for spec ${specId}`];
    if (data.branchName) parts.push(`Worktree branch: ${data.branchName}`);
    if (data.worktreePath) parts.push(`Worktree path: ${data.worktreePath}`);
    return { content: [{ type: 'text' as const, text: parts.join('\n') }] };
  }
);

server.registerTool(
  'rorca_run_status',
  {
    description: 'Get detailed status of a specific pipeline run including per-story progress. Returns run status, elapsed time, and individual story pass/fail/skip/retry status with token counts. Use rorca_list_runs to find run IDs.',
    inputSchema: {
      runId: z.number().describe('Pipeline run ID'),
    },
  },
  async ({ runId }) => {
    const res = await fetch(`${RORCA_API}/api/pipeline/runs/${runId}`);
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to get run status (${res.status}): ${err}`);
    }

    const data = await res.json() as {
      run: {
        id: number; status: string; spec_path: string;
        workspace_id: string; pid: number | null;
        branch_name: string | null; worktree_path: string | null;
        started_at: string; finished_at: string | null;
      };
      stories: Array<{
        story_id: string; status: string; retries: number;
        started_at: string | null; finished_at: string | null;
        elapsed_seconds: number | null;
        input_tokens: number | null; output_tokens: number | null;
      }>;
    };

    const { run, stories } = data;
    const elapsed = run.finished_at
      ? `${Math.round((new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) / 60000)}m`
      : `${Math.round((Date.now() - new Date(run.started_at).getTime()) / 60000)}m (running)`;

    const pass = stories.filter(s => s.status === 'pass').length;
    const fail = stories.filter(s => s.status === 'fail').length;
    const skip = stories.filter(s => s.status === 'skip').length;
    const retry = stories.filter(s => s.status === 'retry').length;

    const header = [
      `Run #${run.id}: ${run.status.toUpperCase()} (${elapsed})`,
      `Spec: ${run.spec_path}`,
      `Progress: ${pass} pass / ${fail} fail / ${skip} skip / ${retry} retry / ${stories.length} total`,
    ];
    if (run.branch_name) header.push(`Branch: ${run.branch_name}`);

    const storyLines = stories.map(s => {
      const tokens = (s.input_tokens || s.output_tokens)
        ? ` [${s.input_tokens ?? 0}/${s.output_tokens ?? 0} tokens]`
        : '';
      const time = s.elapsed_seconds ? ` (${Math.round(s.elapsed_seconds)}s)` : '';
      const retries = s.retries > 0 ? ` retry#${s.retries}` : '';
      return `  ${s.story_id}: ${s.status.toUpperCase()}${retries}${time}${tokens}`;
    });

    return {
      content: [{
        type: 'text' as const,
        text: header.join('\n') + '\n\nStories:\n' + storyLines.join('\n')
      }]
    };
  }
);

server.registerTool(
  'rorca_usage_stats',
  {
    description: 'Get token usage and cost summary for a workspace over a date range. Returns aggregated usage grouped by model, with total input/output tokens, cost in USD, and daily time series. Useful for tracking spend and optimizing model selection.',
    inputSchema: {
      workspaceId: z.string().describe('Rorca workspace ID'),
      from: z.string().optional().describe('Start date (ISO-8601, e.g. "2026-01-01"). Defaults to 30 days ago.'),
      to: z.string().optional().describe('End date (ISO-8601, e.g. "2026-02-01"). Defaults to now.'),
      groupBy: z.enum(['model', 'spec', 'story', 'user']).optional().default('model').describe('How to group results (default: model)'),
    },
  },
  async ({ workspaceId, from, to, groupBy }) => {
    const params = new URLSearchParams();
    params.set('workspace_id', workspaceId);
    params.set('group_by', groupBy ?? 'model');
    if (from) params.set('from', from);
    if (to) params.set('to', to);

    const res = await fetch(`${RORCA_API}/api/analytics/usage?${params.toString()}`);
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to get usage stats (${res.status}): ${err}`);
    }

    const data = await res.json() as {
      grouped: Array<{
        group_key: string;
        total_input_tokens: number;
        total_output_tokens: number;
        total_cost_usd: number;
        count: number;
      }>;
      timeSeries: Array<{
        date: string;
        total_input_tokens: number;
        total_output_tokens: number;
        total_cost_usd: number;
      }>;
      totals: {
        total_input_tokens: number;
        total_output_tokens: number;
        total_cost_usd: number;
        total_records: number;
      };
    };

    const lines = [`Token Usage (grouped by ${groupBy ?? 'model'}):\n`];

    if (data.grouped.length === 0) {
      lines.push('No usage data found for this period.');
    } else {
      for (const g of data.grouped) {
        lines.push(`  ${g.group_key}: ${g.total_input_tokens.toLocaleString()} in / ${g.total_output_tokens.toLocaleString()} out — $${g.total_cost_usd.toFixed(4)} (${g.count} records)`);
      }
    }

    lines.push(`\nTotals: ${data.totals.total_input_tokens.toLocaleString()} in / ${data.totals.total_output_tokens.toLocaleString()} out — $${data.totals.total_cost_usd.toFixed(4)}`);

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  }
);

server.registerTool(
  'rorca_retry_story',
  {
    description: 'Retry one or more failed stories within a completed pipeline run. The run must be in a terminal state (failed, done, or partial_failure). Creates new story_result rows with incremented retry counts and respawns run-loop.sh for only the specified stories.',
    inputSchema: {
      runId: z.number().describe('Pipeline run ID'),
      storyIds: z.array(z.string()).optional().describe('Story IDs to retry (e.g. ["US-003", "US-005"]). If omitted, retries ALL failed stories.'),
    },
  },
  async ({ runId, storyIds }) => {
    const body: Record<string, unknown> = {};
    if (storyIds !== undefined) body.storyIds = storyIds;

    const res = await fetch(`${RORCA_API}/api/pipeline/runs/${runId}/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Retry failed (${res.status}): ${err}`);
    }

    const data = await res.json() as {
      ok: boolean;
      runId: number;
      retriedStories: Array<{ storyId: string; attempt: number }>;
    };

    const storyList = data.retriedStories
      .map(s => `  ${s.storyId} (attempt #${s.attempt})`)
      .join('\n');

    return {
      content: [{
        type: 'text' as const,
        text: `Retry started for run #${data.runId}:\n${storyList}`
      }]
    };
  }
);

server.registerTool(
  'rorca_list_runs',
  {
    description: 'List recent pipeline runs for a workspace with status, spec, and completion summary. Returns runs ordered by most recent first. Use this to find run IDs for rorca_run_status or rorca_retry_story.',
    inputSchema: {
      workspaceId: z.string().describe('Rorca workspace ID'),
      limit: z.number().min(1).max(50).optional().default(10).describe('Maximum number of runs to return (default 10, max 50)'),
    },
  },
  async ({ workspaceId, limit }) => {
    const resolvedLimit = limit ?? 10;
    const res = await fetch(`${RORCA_API}/api/pipeline/runs?workspaceId=${encodeURIComponent(workspaceId)}&limit=${resolvedLimit}`);
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to list runs (${res.status}): ${err}`);
    }

    const payload = await res.json() as {
      runs?: Array<{ id: number; status: string; spec_path: string; branch_name: string | null; trigger_type: string | null; started_at: string; finished_at: string | null }>;
      items?: Array<{ id: number; status: string; spec_path: string; branch_name: string | null; trigger_type: string | null; started_at: string; finished_at: string | null }>;
    };
    const runs = payload.runs ?? payload.items ?? [];

    if (runs.length === 0) {
      return { content: [{ type: 'text' as const, text: `No pipeline runs found for workspace ${workspaceId}` }] };
    }

    const lines = runs.slice(0, resolvedLimit).map(r => {
      const elapsed = r.finished_at
        ? `${Math.round((new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 60000)}m`
        : `${Math.round((Date.now() - new Date(r.started_at).getTime()) / 60000)}m`;
      const spec = r.spec_path.replace('forge/specs/approved/', '').replace('.json', '');
      const branch = r.branch_name ? ` [${r.branch_name}]` : '';
      return `#${r.id}: ${r.status.toUpperCase()} — ${spec} (${elapsed})${branch}`;
    });

    return { content: [{ type: 'text' as const, text: `Recent runs:\n${lines.join('\n')}` }] };
  }
);

// ─── V2-067: Extended Spec Lifecycle MCP Tools ────────────────────────────────

server.registerTool(
  'rorca_edit_story',
  {
    description: 'Update a single story in an existing spec. Can modify title, description, and acceptance criteria by spec ID and story ID. The spec can be in pending or approved status. Use rorca_list_specs to find the spec ID, then rorca_search_stories or read the spec to find the story ID (e.g. US-001).',
    inputSchema: {
      workspaceId: z.string().describe('Rorca workspace ID'),
      specId: z.string().describe('Spec ID (filename slug, e.g. "my-feature-spec")'),
      storyId: z.string().describe('Story ID within the spec (e.g. "US-001")'),
      title: z.string().optional().describe('New title for the story'),
      description: z.string().optional().describe('New description for the story'),
      acceptanceCriteria: z.array(z.string()).optional().describe('New acceptance criteria (replaces existing list)'),
    },
  },
  async ({ workspaceId, specId, storyId, title, description, acceptanceCriteria }) => {
    const body: Record<string, unknown> = { workspaceId };
    if (title !== undefined) body.title = title;
    if (description !== undefined) body.description = description;
    if (acceptanceCriteria !== undefined) body.acceptanceCriteria = acceptanceCriteria;

    const res = await fetch(`${RORCA_API}/api/specs/${specId}/stories/${storyId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to edit story ${storyId} in spec ${specId} (${res.status}): ${err}`);
    }

    const data = await res.json() as { ok: boolean; story: Record<string, unknown>; version: number };
    return {
      content: [{
        type: 'text' as const,
        text: `Story ${storyId} updated in spec ${specId} (version ${data.version})\n\n${JSON.stringify(data.story, null, 2)}`
      }]
    };
  }
);

server.registerTool(
  'rorca_search_stories',
  {
    description: 'Search across all specs in a workspace for stories matching a query string. Searches story IDs, titles, descriptions, and acceptance criteria. Returns matching stories with their spec context. Useful for finding related stories, checking for duplicates, or locating a specific story when you only know partial text.',
    inputSchema: {
      workspaceId: z.string().describe('Rorca workspace ID'),
      query: z.string().describe('Search query — matches against story ID, title, description, and acceptance criteria'),
    },
  },
  async ({ workspaceId, query }) => {
    const res = await fetch(`${RORCA_API}/api/specs/search/stories?workspaceId=${encodeURIComponent(workspaceId)}&q=${encodeURIComponent(query)}`);

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Story search failed (${res.status}): ${err}`);
    }

    const data = await res.json() as {
      query: string;
      resultCount: number;
      results: Array<{
        specId: string;
        specTitle: string;
        status: string;
        story: { id: string; title: string; description: string; acceptanceCriteria: string[] };
        matchFields: string[];
      }>;
    };

    if (data.resultCount === 0) {
      return { content: [{ type: 'text' as const, text: `No stories found matching "${query}"` }] };
    }

    const lines = data.results.map(r =>
      `[${r.status.toUpperCase()}] ${r.specId} → ${r.story.id}: ${r.story.title}\n  Matched in: ${r.matchFields.join(', ')}\n  AC: ${r.story.acceptanceCriteria?.slice(0, 2).join('; ') ?? 'none'}${(r.story.acceptanceCriteria?.length ?? 0) > 2 ? ` (+${(r.story.acceptanceCriteria?.length ?? 0) - 2} more)` : ''}`
    );
    return {
      content: [{
        type: 'text' as const,
        text: `Found ${data.resultCount} stories matching "${query}":\n\n${lines.join('\n\n')}`
      }]
    };
  }
);

server.registerTool(
  'rorca_add_stories',
  {
    description: 'Generate and append new stories to an existing spec using the LLM. The new stories are AI-generated based on the existing spec context and an optional brief describing what the new stories should cover. Story IDs are auto-sequenced after existing stories.',
    inputSchema: {
      workspaceId: z.string().describe('Rorca workspace ID'),
      specId: z.string().describe('Spec ID (filename slug) to add stories to'),
      count: z.number().min(1).max(20).optional().default(3).describe('Number of new stories to generate (default 3, max 20)'),
      brief: z.string().optional().describe('Optional guidance for what the new stories should cover. If omitted, the LLM infers from the existing spec.'),
    },
  },
  async ({ workspaceId, specId, count, brief }) => {
    const body: Record<string, unknown> = {
      workspaceId,
      count: count ?? 3,
    };
    if (brief !== undefined) body.brief = brief;

    const res = await fetch(`${RORCA_API}/api/specs/${specId}/add-stories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to add stories to spec ${specId} (${res.status}): ${err}`);
    }

    const data = await res.json() as {
      added: number;
      totalStories: number;
      newStories: Array<{ id: string; title: string }>;
    };

    const storyList = data.newStories.map(s => `  ${s.id}: ${s.title}`).join('\n');
    return {
      content: [{
        type: 'text' as const,
        text: `Added ${data.added} stories to spec ${specId} (${data.totalStories} total):\n\n${storyList}`
      }]
    };
  }
);

server.registerTool(
  'rorca_delete_story',
  {
    description: 'Remove a single story from a spec by spec ID and story ID. The remaining stories are automatically reindexed to maintain sequential IDs (US-001, US-002, ...). Dependencies referencing the deleted story are cleaned up. A version snapshot is created before deletion for rollback.',
    inputSchema: {
      workspaceId: z.string().describe('Rorca workspace ID'),
      specId: z.string().describe('Spec ID (filename slug)'),
      storyId: z.string().describe('Story ID to delete (e.g. "US-003")'),
    },
  },
  async ({ workspaceId, specId, storyId }) => {
    const res = await fetch(`${RORCA_API}/api/specs/${specId}/stories/${storyId}?workspaceId=${encodeURIComponent(workspaceId)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to delete story ${storyId} from spec ${specId} (${res.status}): ${err}`);
    }

    const data = await res.json() as {
      ok: boolean;
      deletedStory: { id: string; title: string };
      version: number;
      remainingCount: number;
    };

    return {
      content: [{
        type: 'text' as const,
        text: `Deleted story ${storyId} ("${data.deletedStory.title}") from spec ${specId}\nVersion snapshot: ${data.version}\nRemaining stories: ${data.remainingCount}`
      }]
    };
  }
);

// ─── V2-071: Direction Stack MCP Tools ─────────────────────────────────────────

server.registerTool(
  'rorca_get_direction',
  {
    description: 'Get the full direction stack for a workspace, returning all layers (L1 global brain, L2 domain profile, L3 project brief) and their raw content. L4 (spec brief) and L5 (story annotations) are per-request and not persisted. Also returns team-level L1/L2 overrides if the workspace belongs to a team.',
    inputSchema: {
      workspaceId: z.string().describe('Rorca workspace ID'),
    },
  },
  async ({ workspaceId }) => {
    const res = await fetch(`${RORCA_API}/api/direction/all?workspaceId=${encodeURIComponent(workspaceId)}`);
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to get direction stack (${res.status}): ${err}`);
    }

    const data = await res.json() as {
      layers: {
        l1: { content: string | null; source: string };
        l2: { content: string | null; teamOverride: string | null };
        l3: { content: string | null; preferredModel: string | null };
        l4: { content: null; note: string };
        l5: { content: null; note: string };
      };
      teamL1: string | null;
      teamL2: string | null;
    };

    const lines: string[] = [`Direction Stack for workspace ${workspaceId}:\n`];

    // L1
    if (data.teamL1) {
      lines.push(`=== L1: Global Brain (team override) ===\n${data.teamL1}\n`);
    } else if (data.layers.l1.content) {
      lines.push(`=== L1: Global Brain ===\n${data.layers.l1.content}\n`);
    } else {
      lines.push(`=== L1: Global Brain ===\n(not configured)\n`);
    }

    // L2
    if (data.teamL2) {
      lines.push(`=== L2: Domain Profile (team override) ===\n${data.teamL2}\n`);
    } else if (data.layers.l2.content) {
      lines.push(`=== L2: Domain Profile ===\n${data.layers.l2.content}\n`);
    } else {
      lines.push(`=== L2: Domain Profile ===\n(not configured)\n`);
    }

    // L3
    if (data.layers.l3.content) {
      lines.push(`=== L3: Project Brief ===\n${data.layers.l3.content}`);
      if (data.layers.l3.preferredModel) {
        lines.push(`Preferred model: ${data.layers.l3.preferredModel}`);
      }
      lines.push('');
    } else {
      lines.push(`=== L3: Project Brief ===\n(not configured)\n`);
    }

    // L4/L5
    lines.push(`=== L4: Spec Brief ===\n${data.layers.l4.note}\n`);
    lines.push(`=== L5: Story Annotations ===\n${data.layers.l5.note}`);

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  }
);

server.registerTool(
  'rorca_update_direction',
  {
    description: 'Update a specific direction layer (L1, L2, or L3) for a workspace. Content must be valid YAML. L1 is the global brain (engineering principles), L2 is the domain profile (auth patterns, API conventions), L3 is the project brief (stack, architecture, constraints). L4/L5 are per-request and cannot be persisted via this tool. Changes take effect immediately in subsequent spec generations.',
    inputSchema: {
      workspaceId: z.string().describe('Rorca workspace ID — required for L2 and L3, optional for L1 (global)'),
      layer: z.number().min(1).max(3).describe('Direction layer number: 1 (global brain), 2 (domain profile), or 3 (project brief)'),
      contentYaml: z.string().describe('YAML content for the layer'),
      domain: z.string().optional().describe('Domain name (only relevant for L2 domain-scoped layers)'),
      preferredModel: z.string().optional().describe('Preferred LLM model (only valid for L3)'),
    },
  },
  async ({ workspaceId, layer, contentYaml, domain, preferredModel }) => {
    const body: Record<string, unknown> = {
      layer,
      contentYaml,
    };
    // L1 is global — workspaceId is optional for L1 but required for L2/L3
    if (layer >= 2) {
      body.workspaceId = workspaceId;
    }
    if (domain !== undefined) body.domain = domain;
    if (preferredModel !== undefined) body.preferredModel = preferredModel;

    const res = await fetch(`${RORCA_API}/api/direction`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to update direction layer L${layer} (${res.status}): ${err}`);
    }

    const layerNames: Record<number, string> = { 1: 'Global Brain', 2: 'Domain Profile', 3: 'Project Brief' };
    return {
      content: [{
        type: 'text' as const,
        text: `Direction layer L${layer} (${layerNames[layer]}) updated successfully for workspace ${workspaceId}.${preferredModel ? `\nPreferred model: ${preferredModel}` : ''}\n\nChanges will be reflected in subsequent spec generations.`
      }]
    };
  }
);

server.registerTool(
  'rorca_synthesize_direction',
  {
    description: 'Get the fully synthesized direction stack as a single merged string, exactly as it would be sent to the LLM during spec generation. Merges L1 through L5 in priority order with team overrides, auto-hydrated schema/git context, and optional L4/L5 content. Use this to preview what the LLM will see.',
    inputSchema: {
      workspaceId: z.string().describe('Rorca workspace ID'),
      specBrief: z.string().optional().describe('L4: spec brief text (one-paragraph description). If omitted, shows synthesis without L4.'),
      storyAnnotations: z.string().optional().describe('L5: story-level annotations, edge cases, or implementation hints'),
    },
  },
  async ({ workspaceId, specBrief, storyAnnotations }) => {
    const res = await fetch(`${RORCA_API}/api/direction/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId,
        l4SpecBrief: specBrief ?? '',
        l5Annotations: storyAnnotations,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Direction synthesis failed (${res.status}): ${err}`);
    }
    const { synthesized } = await res.json() as { synthesized: string };
    return { content: [{ type: 'text' as const, text: synthesized }] };
  }
);

// ─── V2-072: Workspace & Team Administration MCP Tools ──────────────────────

server.registerTool(
  'rorca_list_workspaces',
  {
    description: 'List all registered workspaces the user has access to. Returns workspace ID, label, filesystem path, and domain tags. Use this to find workspace IDs for other tools (rorca_generate_spec, rorca_trigger_run, etc.).',
    inputSchema: {},
  },
  async () => {
    const res = await fetch(`${RORCA_API}/api/workspaces`);
    if (!res.ok) throw new Error(`Failed to list workspaces: ${res.status}`);
    const data = await res.json() as {
      items?: Array<{ id: string; label: string; path: string; domains: string[]; created_at: string; }>;
      workspaces?: Array<{ id: string; label: string; path: string; domains: string[]; created_at: string; }>;
    };
    const workspaces = data.items ?? data.workspaces ?? [];

    if (workspaces.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No workspaces registered. Use rorca_create_workspace to register one.' }] };
    }

    const lines = workspaces.map(w =>
      `${w.label} (${w.id})\n  Path: ${w.path}\n  Domains: ${w.domains.length > 0 ? w.domains.join(', ') : 'none'}`
    );
    return { content: [{ type: 'text' as const, text: `Workspaces (${workspaces.length}):\n\n${lines.join('\n\n')}` }] };
  }
);

server.registerTool(
  'rorca_create_workspace',
  {
    description: 'Register a new workspace by its filesystem path. The path must exist and should be a git repository root. Optionally provide a human label and domain tags (e.g. "saas", "fintech") for Direction Stack L2 matching.',
    inputSchema: {
      id: z.string().describe('Unique workspace ID (slug, e.g. "my-project")'),
      path: z.string().describe('Absolute filesystem path to the project root (must exist)'),
      label: z.string().optional().describe('Human-readable label (defaults to the directory name)'),
      domains: z.array(z.string()).optional().default([]).describe('Domain tags for L2 direction matching (e.g. ["saas", "fintech"])'),
    },
  },
  async ({ id, path: wsPath, label, domains }) => {
    const resolvedLabel = label ?? wsPath.split('/').pop() ?? id;
    const resolvedDomains = domains ?? [];
    const res = await fetch(`${RORCA_API}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id,
        label: resolvedLabel,
        path: wsPath,
        domains: resolvedDomains,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to create workspace (${res.status}): ${err}`);
    }

    const data = await res.json() as { workspace: { id: string; label: string; path: string; domains: string[] } };
    return {
      content: [{
        type: 'text' as const,
        text: `Workspace registered:\n  ID: ${data.workspace.id}\n  Label: ${data.workspace.label}\n  Path: ${data.workspace.path}\n  Domains: ${data.workspace.domains.join(', ') || 'none'}`
      }]
    };
  }
);

server.registerTool(
  'rorca_workspace_stats',
  {
    description: 'Get summary statistics for a workspace: spec count (pending/approved), pipeline run count (total/active/completed/failed), story pass rate, and last activity timestamp. Useful for a quick health check or dashboard overview.',
    inputSchema: {
      workspaceId: z.string().describe('Rorca workspace ID'),
    },
  },
  async ({ workspaceId }) => {
    const res = await fetch(`${RORCA_API}/api/workspaces/${encodeURIComponent(workspaceId)}/stats`);
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to get workspace stats (${res.status}): ${err}`);
    }

    const data = await res.json() as {
      workspaceId: string;
      specs: { pending: number; approved: number; total: number };
      runs: { total: number; active: number; completed: number; failed: number; lastRunAt: string | null };
      stories: { total: number; passed: number; failed: number; passRate: number };
      lastActivity: string | null;
    };

    const lines = [
      `Workspace Stats: ${data.workspaceId}`,
      '',
      `Specs: ${data.specs.total} total (${data.specs.pending} pending, ${data.specs.approved} approved)`,
      `Runs: ${data.runs.total} total (${data.runs.active} active, ${data.runs.completed} completed, ${data.runs.failed} failed)`,
      `Stories: ${data.stories.total} executed — ${data.stories.passRate}% pass rate (${data.stories.passed} pass / ${data.stories.failed} fail)`,
      `Last activity: ${data.lastActivity ?? 'never'}`,
    ];
    if (data.runs.lastRunAt) {
      lines.push(`Last run: ${data.runs.lastRunAt}`);
    }

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  }
);

server.registerTool(
  'rorca_team_members',
  {
    description: 'Get the team member list for a workspace. Looks up the team associated with the workspace via workspace_access and returns all members with their roles (admin/editor/viewer), email, and last activity. Returns an empty list if the workspace is not team-scoped.',
    inputSchema: {
      workspaceId: z.string().describe('Rorca workspace ID — must be linked to a team via workspace_access'),
    },
  },
  async ({ workspaceId }) => {
    const res = await fetch(`${RORCA_API}/api/workspaces/${encodeURIComponent(workspaceId)}/team-members`);
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to get team members (${res.status}): ${err}`);
    }

    const data = await res.json() as {
      teamScoped: boolean;
      team: { id: string; name: string; slug: string; permission: string } | null;
      members: Array<{
        userId: string;
        email: string;
        displayName: string;
        role: string;
        joinedAt: string;
        acceptedAt: string | null;
        lastActiveAt: string | null;
      }>;
    };

    if (!data.teamScoped || !data.team) {
      return {
        content: [{
          type: 'text' as const,
          text: `Workspace ${workspaceId} is not linked to any team. Use team management to associate this workspace with a team first.`
        }]
      };
    }

    if (data.members.length === 0) {
      return {
        content: [{
          type: 'text' as const,
          text: `Team "${data.team.name}" has no members yet.`
        }]
      };
    }

    const memberLines = data.members.map(m => {
      const status = m.acceptedAt ? 'active' : 'invited';
      const lastActive = m.lastActiveAt ? ` (last active: ${m.lastActiveAt})` : '';
      return `  ${m.displayName || m.email} <${m.email}> — ${m.role} [${status}]${lastActive}`;
    });

    return {
      content: [{
        type: 'text' as const,
        text: `Team "${data.team.name}" members (${data.members.length}) — workspace permission: ${data.team.permission}\n\n${memberLines.join('\n')}`
      }]
    };
  }
);

// ─── Memory & Decision Logging MCP Tools ────────────────────────────────────

server.registerTool(
  'rorca_save_memory',
  {
    description: 'Save a memory entry to the Rorca memory ledger for a workspace. Memories persist across sessions and are injected into future spec generation and story execution as context. Use this to record architectural decisions, conventions, bug fixes, patterns, and gotchas discovered during development. Categories: Architecture, Convention, Bug Fix, Decision, Pattern, Gotcha.',
    inputSchema: {
      workspaceId: z.string().describe('Rorca workspace ID (use rorca_list_workspaces to find it)'),
      category: z.enum(['Architecture', 'Convention', 'Bug Fix', 'Decision', 'Pattern', 'Gotcha']).describe('Memory category'),
      title: z.string().describe('Short title summarizing the memory (e.g. "Always use parameterized queries")'),
      rule: z.string().describe('The actual rule, convention, or lesson learned. Be specific and actionable.'),
      context: z.string().optional().describe('Additional context: why this matters, what triggered it, related files'),
      source: z.string().optional().describe('Source of the memory (e.g. "manual", "code-review", "debugging session")'),
    },
  },
  async ({ workspaceId, category, title, rule, context, source }) => {
    const body: Record<string, string> = { workspaceId, category, title, rule };
    if (context !== undefined) body.context = context;
    if (source !== undefined) body.source = source;

    const res = await fetch(`${RORCA_API}/api/memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to save memory (${res.status}): ${err}`);
    }

    const data = await res.json() as { entry: { date: string; category: string; title: string; rule: string }; total: number };
    return {
      content: [{
        type: 'text' as const,
        text: `Memory saved to workspace ${workspaceId}:\n  [${data.entry.category}] ${data.entry.title}\n  Rule: ${data.entry.rule}\n  Total memories: ${data.total}\n\nThis will be injected into future spec generations and story executions.`
      }]
    };
  }
);

server.registerTool(
  'rorca_log_decision',
  {
    description: 'Shortcut to save an architectural or technical decision as a memory. Wraps rorca_save_memory with category "Decision" and adds structured reasoning (alternatives considered, why this was chosen). Use when making significant technical choices during development.',
    inputSchema: {
      workspaceId: z.string().describe('Rorca workspace ID'),
      title: z.string().describe('Decision title (e.g. "Use Zustand over Redux for state management")'),
      decision: z.string().describe('What was decided and why'),
      alternatives: z.string().optional().describe('What alternatives were considered and why they were rejected'),
    },
  },
  async ({ workspaceId, title, decision, alternatives }) => {
    const rule = alternatives
      ? `${decision}\n\nAlternatives considered: ${alternatives}`
      : decision;

    const res = await fetch(`${RORCA_API}/api/memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId,
        category: 'Decision',
        title,
        rule,
        source: 'mcp-cli',
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to log decision (${res.status}): ${err}`);
    }

    const data = await res.json() as { entry: { date: string; title: string; rule: string }; total: number };
    return {
      content: [{
        type: 'text' as const,
        text: `Decision logged: ${data.entry.title}\n\n${data.entry.rule}\n\nTotal memories: ${data.total}`
      }]
    };
  }
);

server.registerTool(
  'rorca_get_memories',
  {
    description: 'Retrieve memories from the Rorca memory ledger for a workspace. Returns recent memories or filters by category. Use this to check what conventions, decisions, and patterns have been recorded for a project before making changes.',
    inputSchema: {
      workspaceId: z.string().describe('Rorca workspace ID'),
      category: z.enum(['Architecture', 'Convention', 'Bug Fix', 'Decision', 'Pattern', 'Gotcha']).optional().describe('Filter by category. If omitted, returns recent memories across all categories.'),
      limit: z.number().min(1).max(100).optional().default(20).describe('Maximum entries to return (default 20)'),
    },
  },
  async ({ workspaceId, category, limit }) => {
    const params = new URLSearchParams({ workspaceId });
    if (category) params.set('category', category);
    if (limit) params.set('limit', String(limit ?? 20));

    const res = await fetch(`${RORCA_API}/api/memory?${params.toString()}`);
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to get memories (${res.status}): ${err}`);
    }

    const data = await res.json() as {
      items: Array<{ date: string; category: string; title: string; rule: string; context?: string }>;
      total: number;
    };

    if (data.items.length === 0) {
      return { content: [{ type: 'text' as const, text: `No memories found for workspace ${workspaceId}${category ? ` in category ${category}` : ''}` }] };
    }

    const lines = data.items.map(m =>
      `[${m.date}] [${m.category}] ${m.title}\n  ${m.rule}${m.context ? `\n  Context: ${m.context}` : ''}`
    );

    return {
      content: [{
        type: 'text' as const,
        text: `Memories (${data.items.length}/${data.total}):\n\n${lines.join('\n\n')}`
      }]
    };
  }
);

server.registerTool(
  'rorca_check_spec',
  {
    description: 'Validate a spec\'s structural integrity. Checks for missing required fields (id, title, description, acceptanceCriteria), duplicate story IDs, orphaned dependsOn references, and empty acceptanceCriteria arrays. Returns categorized errors (blocking), warnings (non-blocking), and aggregate stats.',
    inputSchema: {
      workspaceId: z.string().describe('Rorca workspace ID (from rorca_list_workspaces)'),
      specId: z.string().describe('Spec slug (e.g. "rorca-feature-enhancements") — filename without .json'),
    },
  },
  async ({ workspaceId, specId }) => {
    const res = await fetch(`${RORCA_API}/api/specs/${encodeURIComponent(specId)}/check?workspaceId=${encodeURIComponent(workspaceId)}`);
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Spec check failed (${res.status}): ${err}`);
    }
    const data = await res.json() as {
      valid: boolean;
      errors: Array<{ storyId: string; field: string; message: string }>;
      warnings: Array<{ storyId: string; field: string; message: string }>;
      stats: { totalStories: number; avgACCount: number; maxDependencyDepth: number };
    };

    const lines: string[] = [];
    lines.push(`Spec: ${specId}`);
    lines.push(`Valid: ${data.valid ? '✅ yes' : '❌ no'}`);
    lines.push(`Stories: ${data.stats.totalStories} | Avg AC: ${data.stats.avgACCount} | Max dep depth: ${data.stats.maxDependencyDepth}`);

    if (data.errors.length > 0) {
      lines.push(`\nErrors (${data.errors.length}):`);
      for (const e of data.errors) {
        lines.push(`  ❌ [${e.storyId}] ${e.field}: ${e.message}`);
      }
    }

    if (data.warnings.length > 0) {
      lines.push(`\nWarnings (${data.warnings.length}):`);
      for (const w of data.warnings) {
        lines.push(`  ⚠️  [${w.storyId}] ${w.field}: ${w.message}`);
      }
    }

    if (data.errors.length === 0 && data.warnings.length === 0) {
      lines.push('\nNo issues found.');
    }

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  }
);

server.registerTool(
  'rorca_score_spec',
  {
    description: 'Score a spec\'s acceptance criteria quality on a 0-100 scale. Scores each story based on AC count (base score), specificity (penalty for vague phrases like "properly", "correctly", "as expected"), and state coverage (bonus for mentioning error, empty, and loading states). Returns per-story scores and aggregate spec score.',
    inputSchema: {
      workspaceId: z.string().describe('Rorca workspace ID (from rorca_list_workspaces)'),
      specId: z.string().describe('Spec slug (e.g. "rorca-feature-enhancements") — filename without .json'),
    },
  },
  async ({ workspaceId, specId }) => {
    const res = await fetch(`${RORCA_API}/api/specs/${encodeURIComponent(specId)}/score?workspaceId=${encodeURIComponent(workspaceId)}`);
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Spec score failed (${res.status}): ${err}`);
    }
    const data = await res.json() as {
      specScore: number;
      stories: Array<{
        id: string;
        score: number;
        acCount: number;
        vaguePhrasesFound: string[];
        stateCoverage: { error: boolean; empty: boolean; loading: boolean };
      }>;
    };

    const lines: string[] = [];
    lines.push(`Spec: ${specId}`);
    lines.push(`Overall score: ${data.specScore}/100`);
    lines.push(`Stories scored: ${data.stories.length}`);
    lines.push('');

    for (const s of data.stories) {
      const coverage = [
        s.stateCoverage.error ? 'error' : '',
        s.stateCoverage.empty ? 'empty' : '',
        s.stateCoverage.loading ? 'loading' : '',
      ].filter(Boolean).join(', ') || 'none';
      lines.push(`[${s.id}] score=${s.score}/100 ac=${s.acCount} coverage=${coverage}`);
      if (s.vaguePhrasesFound.length > 0) {
        lines.push(`  ⚠️  Vague: ${s.vaguePhrasesFound.join(', ')}`);
      }
    }

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  }
);

server.registerTool(
  'rorca_validate_spec',
  {
    description: 'LLM-powered deep spec review using claude-sonnet-4-6. Injects spec-gap-analysis and assumption-buster skills to identify: implicit assumptions (with risk assessment), coverage gaps (missing error handling, auth, edge cases), untestable acceptance criteria (vague/subjective), and missed stories. Returns structured analysis with four arrays: assumptions, gaps, untestableACs, missedStories.',
    inputSchema: {
      workspaceId: z.string().describe('Rorca workspace ID (from rorca_list_workspaces)'),
      specId: z.string().describe('Spec slug (e.g. "rorca-feature-enhancements") — filename without .json'),
    },
  },
  async ({ workspaceId, specId }) => {
    const res = await fetch(`${RORCA_API}/api/specs/${encodeURIComponent(specId)}/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Spec validation failed (${res.status}): ${err}`);
    }
    const data = await res.json() as {
      assumptions: Array<{ storyId: string; assumption: string; risk: string }>;
      gaps: Array<{ area: string; description: string }>;
      untestableACs: Array<{ storyId: string; acIndex: number; reason: string }>;
      missedStories: Array<{ title: string; description: string; reason: string }>;
    };

    const lines: string[] = [];
    lines.push(`Deep Validation: ${specId}`);
    lines.push('');

    if (data.assumptions.length > 0) {
      lines.push(`Implicit Assumptions (${data.assumptions.length}):`);
      for (const a of data.assumptions) {
        lines.push(`  ⚠️  [${a.storyId}] ${a.assumption}`);
        lines.push(`       Risk: ${a.risk}`);
      }
      lines.push('');
    }

    if (data.gaps.length > 0) {
      lines.push(`Coverage Gaps (${data.gaps.length}):`);
      for (const g of data.gaps) {
        lines.push(`  🔍 [${g.area}] ${g.description}`);
      }
      lines.push('');
    }

    if (data.untestableACs.length > 0) {
      lines.push(`Untestable Acceptance Criteria (${data.untestableACs.length}):`);
      for (const u of data.untestableACs) {
        lines.push(`  ❌ [${u.storyId}] AC #${u.acIndex}: ${u.reason}`);
      }
      lines.push('');
    }

    if (data.missedStories.length > 0) {
      lines.push(`Missed Stories (${data.missedStories.length}):`);
      for (const m of data.missedStories) {
        lines.push(`  📋 ${m.title}`);
        lines.push(`       ${m.description}`);
        lines.push(`       Why needed: ${m.reason}`);
      }
      lines.push('');
    }

    if (data.assumptions.length === 0 && data.gaps.length === 0 && data.untestableACs.length === 0 && data.missedStories.length === 0) {
      lines.push('No issues found — spec looks comprehensive.');
    }

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  }
);

// ─── Slash-command Prompts (/mcp__rorca__<name>) ──────────────────────────────
// These are user-invocable via /mcp__rorca__<name> [args] in Claude Code.
// Each prompt calls the backend directly and injects formatted results into
// the conversation — no secondary tool call required.

const DEFAULT_WORKSPACE = 'rorcha';

server.registerPrompt(
  'list_specs',
  {
    title: 'List Specs',
    description: 'List all specs for a workspace grouped by status (pending/approved). Defaults to the rorcha workspace.',
    argsSchema: {
      workspaceId: z.string().optional().describe(`Workspace ID (default: ${DEFAULT_WORKSPACE})`),
      status: z.enum(['pending', 'approved', 'all']).optional().describe('Filter: pending | approved | all (default: all)'),
    },
  },
  async ({ workspaceId, status }) => {
    const ws = workspaceId ?? DEFAULT_WORKSPACE;
    const st = status ?? 'all';
    const res = await fetch(`${RORCA_API}/api/specs?workspaceId=${ws}&status=${st}`);
    if (!res.ok) {
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Error fetching specs (${res.status}): ${await res.text()}` } }] };
    }
    const data = await res.json() as { items?: Array<{ id: string; specName?: string; title?: string; status: string; storyCount: number }> } | Array<{ id: string; specName?: string; title?: string; status: string; storyCount: number }>;
    const specs = Array.isArray(data) ? data : (data.items ?? []);
    if (specs.length === 0) {
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `No specs found for workspace "${ws}" (filter: ${st})` } }] };
    }
    const byStatus: Record<string, typeof specs> = {};
    for (const s of specs) {
      const key = s.status ?? 'unknown';
      (byStatus[key] ??= []).push(s);
    }
    const sections = Object.entries(byStatus).map(([k, items]) => {
      const lines = items.map(s => `  • ${s.specName ?? s.title ?? s.id} (${s.storyCount} stories) — ${s.id}`);
      return `## ${k.toUpperCase()} (${items.length})\n${lines.join('\n')}`;
    });
    return {
      messages: [{
        role: 'user' as const,
        content: { type: 'text' as const, text: `Specs for workspace "${ws}" (${specs.length} total):\n\n${sections.join('\n\n')}` },
      }],
    };
  }
);

server.registerPrompt(
  'list_runs',
  {
    title: 'List Runs',
    description: 'List recent pipeline runs for a workspace. Defaults to the rorcha workspace, last 10 runs.',
    argsSchema: {
      workspaceId: z.string().optional().describe(`Workspace ID (default: ${DEFAULT_WORKSPACE})`),
      limit: z.string().optional().describe('Number of runs to show (default: 10, max: 50)'),
    },
  },
  async ({ workspaceId, limit }) => {
    const ws = workspaceId ?? DEFAULT_WORKSPACE;
    const n = Math.min(50, Math.max(1, parseInt(limit ?? '10', 10) || 10));
    const res = await fetch(`${RORCA_API}/api/pipeline/runs?workspaceId=${encodeURIComponent(ws)}&limit=${n}`);
    if (!res.ok) {
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Error fetching runs (${res.status}): ${await res.text()}` } }] };
    }
    const payload = await res.json() as {
      runs?: Array<{ id: number; status: string; spec_path: string; branch_name: string | null; started_at: string; finished_at: string | null }>;
      items?: Array<{ id: number; status: string; spec_path: string; branch_name: string | null; started_at: string; finished_at: string | null }>;
    };
    const runs = payload.runs ?? payload.items ?? [];
    if (runs.length === 0) {
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `No pipeline runs found for workspace "${ws}"` } }] };
    }
    const STATUS_ICON: Record<string, string> = { done: '✅', failed: '❌', running: '🔄', queued: '⏳' };
    const lines = runs.map(r => {
      const icon = STATUS_ICON[r.status] ?? '❓';
      const elapsed = r.finished_at
        ? `${Math.round((new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 60000)}m`
        : `${Math.round((Date.now() - new Date(r.started_at).getTime()) / 60000)}m (running)`;
      const spec = r.spec_path.replace('forge/specs/approved/', '').replace('.json', '');
      const branch = r.branch_name ? ` [${r.branch_name}]` : '';
      return `${icon} #${r.id}: ${r.status.toUpperCase()} — ${spec} (${elapsed})${branch}`;
    });
    return {
      messages: [{
        role: 'user' as const,
        content: { type: 'text' as const, text: `Recent runs for workspace "${ws}" (${runs.length} shown):\n\n${lines.join('\n')}` },
      }],
    };
  }
);

server.registerPrompt(
  'run_status',
  {
    title: 'Run Status',
    description: 'Get detailed per-story status for a specific pipeline run by ID.',
    argsSchema: {
      runId: z.string().describe('Pipeline run ID (e.g. 39)'),
    },
  },
  async ({ runId }) => {
    const id = parseInt(runId, 10);
    if (isNaN(id)) {
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Invalid run ID: "${runId}". Must be a number.` } }] };
    }
    const res = await fetch(`${RORCA_API}/api/pipeline/runs/${id}`);
    if (!res.ok) {
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Error fetching run #${id} (${res.status}): ${await res.text()}` } }] };
    }
    const data = await res.json() as {
      run: { id: number; status: string; spec_path: string; started_at: string; finished_at: string | null; branch_name: string | null };
      stories: Array<{ story_id: string; status: string; retries: number; elapsed_seconds: number | null; input_tokens: number | null; output_tokens: number | null }>;
    };
    const { run, stories } = data;
    const elapsed = run.finished_at
      ? `${Math.round((new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) / 60000)}m`
      : `${Math.round((Date.now() - new Date(run.started_at).getTime()) / 60000)}m (running)`;
    const pass = stories.filter(s => s.status === 'pass').length;
    const fail = stories.filter(s => s.status === 'fail').length;
    const skip = stories.filter(s => s.status === 'skip').length;
    const STATUS_ICON: Record<string, string> = { pass: '✅', fail: '❌', skip: '⏭️', retry: '🔄', running: '⚡' };
    const storyLines = stories.map(s => {
      const icon = STATUS_ICON[s.status] ?? '❓';
      const time = s.elapsed_seconds ? ` (${Math.round(s.elapsed_seconds)}s)` : '';
      const tokens = (s.input_tokens || s.output_tokens) ? ` [${(s.input_tokens ?? 0).toLocaleString()}/${(s.output_tokens ?? 0).toLocaleString()} tok]` : '';
      const retries = s.retries > 0 ? ` retry#${s.retries}` : '';
      return `  ${icon} ${s.story_id}: ${s.status.toUpperCase()}${retries}${time}${tokens}`;
    });
    const spec = run.spec_path.replace('forge/specs/approved/', '').replace('.json', '');
    const header = [
      `**Run #${run.id}** — ${run.status.toUpperCase()} (${elapsed})`,
      `Spec: ${spec}`,
      `Progress: ${pass} pass / ${fail} fail / ${skip} skip / ${stories.length} total`,
    ];
    if (run.branch_name) header.push(`Branch: ${run.branch_name}`);
    return {
      messages: [{
        role: 'user' as const,
        content: { type: 'text' as const, text: `${header.join('\n')}\n\nStories:\n${storyLines.join('\n')}` },
      }],
    };
  }
);

server.registerPrompt(
  'pipeline_status',
  {
    title: 'Pipeline Status',
    description: 'Get the status of the most recent pipeline run for a workspace. Defaults to the rorcha workspace.',
    argsSchema: {
      workspaceId: z.string().optional().describe(`Workspace ID (default: ${DEFAULT_WORKSPACE})`),
    },
  },
  async ({ workspaceId }) => {
    const ws = workspaceId ?? DEFAULT_WORKSPACE;
    const res = await fetch(`${RORCA_API}/api/pipeline/runs?workspaceId=${encodeURIComponent(ws)}&limit=1`);
    if (!res.ok) {
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Error fetching pipeline status (${res.status}): ${await res.text()}` } }] };
    }
    const payload = await res.json() as {
      runs?: Array<{ id: number; status: string; spec_path: string; started_at: string; finished_at: string | null }>;
      items?: Array<{ id: number; status: string; spec_path: string; started_at: string; finished_at: string | null }>;
    };
    const runs = payload.runs ?? payload.items ?? [];
    if (runs.length === 0) {
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `No pipeline runs found for workspace "${ws}". Nothing has been run yet.` } }] };
    }
    const run = runs[0];
    // Fetch detailed story results for the latest run
    const detailRes = await fetch(`${RORCA_API}/api/pipeline/runs/${run.id}`);
    if (!detailRes.ok) {
      const elapsed = run.finished_at
        ? `${Math.round((new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) / 60000)}m`
        : `${Math.round((Date.now() - new Date(run.started_at).getTime()) / 60000)}m (running)`;
      const spec = run.spec_path.replace('forge/specs/approved/', '').replace('.json', '');
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Latest run #${run.id}: ${run.status.toUpperCase()} (${elapsed})\nSpec: ${spec}` } }] };
    }
    const detail = await detailRes.json() as {
      run: { id: number; status: string; spec_path: string; started_at: string; finished_at: string | null };
      stories: Array<{ story_id: string; status: string; retries: number }>;
    };
    const elapsed = detail.run.finished_at
      ? `${Math.round((new Date(detail.run.finished_at).getTime() - new Date(detail.run.started_at).getTime()) / 60000)}m`
      : `${Math.round((Date.now() - new Date(detail.run.started_at).getTime()) / 60000)}m (running)`;
    const pass = detail.stories.filter(s => s.status === 'pass').length;
    const fail = detail.stories.filter(s => s.status === 'fail').length;
    const skip = detail.stories.filter(s => s.status === 'skip').length;
    const spec = detail.run.spec_path.replace('forge/specs/approved/', '').replace('.json', '');
    const STATUS_EMOJI: Record<string, string> = { done: '✅', failed: '❌', running: '🔄', queued: '⏳' };
    const icon = STATUS_EMOJI[detail.run.status] ?? '❓';
    return {
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `${icon} **Latest pipeline run** for workspace "${ws}":\n\nRun #${detail.run.id}: ${detail.run.status.toUpperCase()} (${elapsed})\nSpec: ${spec}\nStories: ${pass} pass / ${fail} fail / ${skip} skip / ${detail.stories.length} total\n\nUse /mcp__rorca__run_status ${detail.run.id} for full per-story breakdown.`,
        },
      }],
    };
  }
);

server.registerPrompt(
  'trigger_run',
  {
    title: 'Trigger Pipeline Run',
    description: 'Start a pipeline run for an approved spec. Spec must be in the approved queue.',
    argsSchema: {
      specId: z.string().describe('Spec ID slug (e.g. rorca-curated-skills-library)'),
      workspaceId: z.string().optional().describe(`Workspace ID (default: ${DEFAULT_WORKSPACE})`),
    },
  },
  async ({ specId, workspaceId }) => {
    const ws = workspaceId ?? DEFAULT_WORKSPACE;
    const res = await fetch(`${RORCA_API}/api/pipeline/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: ws, specPath: `forge/specs/approved/${specId}.json` }),
    });
    const data = await res.json() as Record<string, unknown>;
    if (!res.ok) {
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Failed to trigger run (${res.status}): ${data.error ?? JSON.stringify(data)}` } }] };
    }
    if (data.conflict) {
      return {
        messages: [{
          role: 'user' as const,
          content: { type: 'text' as const, text: `⚠️ Conflict: workspace "${ws}" already has active run #${data.activeRunId}.\n\nWait for it to finish, or use rorca_trigger_run with autoWorktree: true to run in parallel.` },
        }],
      };
    }
    return {
      messages: [{
        role: 'user' as const,
        content: { type: 'text' as const, text: `🚀 Pipeline run #${data.runId} started!\nSpec: ${specId}\nWorkspace: ${ws}\n\nTrack progress with: /mcp__rorca__run_status ${data.runId}` },
      }],
    };
  }
);

server.registerPrompt(
  'generate_spec',
  {
    title: 'Generate Spec',
    description: 'Generate a spec JSON from a title and brief. Usage: /mcp__rorca__generate_spec "my-spec-slug" "One paragraph describing the feature"',
    argsSchema: {
      title: z.string().describe('Spec slug (e.g. add-dark-mode) — becomes the filename'),
      specBrief: z.string().describe('One-paragraph description of the feature to spec out'),
      storyCount: z.string().optional().describe('Number of stories to generate (default: 8)'),
      workspaceId: z.string().optional().describe(`Workspace ID (default: ${DEFAULT_WORKSPACE})`),
    },
  },
  async ({ title, specBrief, storyCount, workspaceId }) => {
    const ws = workspaceId ?? DEFAULT_WORKSPACE;
    const count = parseInt(storyCount ?? '8', 10) || 8;
    const res = await fetch(`${RORCA_API}/api/specs/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: ws, title, specBrief, storyCount: count, includeDiagrams: false }),
    });
    if (!res.ok) {
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Spec generation failed (${res.status}): ${await res.text()}` } }] };
    }
    const spec = await res.json() as { title?: string; userStories?: Array<{ id: string; title: string }>; model?: string };
    const stories = spec.userStories ?? [];
    const storyList = stories.map(s => `  • ${s.id}: ${s.title}`).join('\n');
    return {
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `✅ Spec "${title}" generated (${stories.length} stories, model: ${spec.model ?? 'unknown'}):\n\n${storyList}\n\nApprove it with: /mcp__rorca__approve_spec ${title}`,
        },
      }],
    };
  }
);

server.registerPrompt(
  'approve_spec',
  {
    title: 'Approve Spec',
    description: 'Approve a pending spec and move it to the approved queue.',
    argsSchema: {
      specId: z.string().describe('Spec ID slug (e.g. rorca-curated-skills-library)'),
      workspaceId: z.string().optional().describe(`Workspace ID (default: ${DEFAULT_WORKSPACE})`),
      notes: z.string().optional().describe('Optional approval notes'),
    },
  },
  async ({ specId, workspaceId, notes }) => {
    const ws = workspaceId ?? DEFAULT_WORKSPACE;
    const body: Record<string, string> = { workspaceId: ws };
    if (notes) body.notes = notes;
    const res = await fetch(`${RORCA_API}/api/specs/${specId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Failed to approve spec "${specId}" (${res.status}): ${await res.text()}` } }] };
    }
    const data = await res.json() as { path: string };
    return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `✅ Spec "${specId}" approved.\nMoved to: ${data.path}\n\nRun it with: /mcp__rorca__trigger_run ${specId}` } }] };
  }
);

server.registerPrompt(
  'get_context',
  {
    title: 'Get Context',
    description: 'Get the synthesized Direction Stack (L1–L5) for a workspace.',
    argsSchema: {
      workspaceId: z.string().optional().describe(`Workspace ID (default: ${DEFAULT_WORKSPACE})`),
      specBrief: z.string().optional().describe('Optional L4 spec brief to include in synthesis'),
    },
  },
  async ({ workspaceId, specBrief }) => {
    const ws = workspaceId ?? DEFAULT_WORKSPACE;
    const res = await fetch(`${RORCA_API}/api/direction/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: ws, l4SpecBrief: specBrief ?? '', l5Annotations: '' }),
    });
    if (!res.ok) {
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Failed to get context (${res.status}): ${await res.text()}` } }] };
    }
    const { synthesized } = await res.json() as { synthesized: string };
    return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: synthesized } }] };
  }
);

server.registerPrompt(
  'get_direction',
  {
    title: 'Get Direction Stack',
    description: 'Get all direction layers (L1–L3) with raw content for a workspace.',
    argsSchema: {
      workspaceId: z.string().optional().describe(`Workspace ID (default: ${DEFAULT_WORKSPACE})`),
    },
  },
  async ({ workspaceId }) => {
    const ws = workspaceId ?? DEFAULT_WORKSPACE;
    const res = await fetch(`${RORCA_API}/api/direction/all?workspaceId=${encodeURIComponent(ws)}`);
    if (!res.ok) {
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Failed to get direction (${res.status}): ${await res.text()}` } }] };
    }
    const data = await res.json() as {
      layers: { l1: { content: string | null }; l2: { content: string | null }; l3: { content: string | null; preferredModel: string | null } };
    };
    const lines = [
      `=== L1: Standards ===\n${data.layers.l1.content ?? '(not configured)'}`,
      `=== L2: Conventions ===\n${data.layers.l2.content ?? '(not configured)'}`,
      `=== L3: Project ===\n${data.layers.l3.content ?? '(not configured)'}${data.layers.l3.preferredModel ? `\nPreferred model: ${data.layers.l3.preferredModel}` : ''}`,
    ];
    return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Direction Stack for "${ws}":\n\n${lines.join('\n\n')}` } }] };
  }
);

server.registerPrompt(
  'synthesize_direction',
  {
    title: 'Synthesize Direction',
    description: 'Preview the fully merged direction stack exactly as sent to the LLM.',
    argsSchema: {
      workspaceId: z.string().optional().describe(`Workspace ID (default: ${DEFAULT_WORKSPACE})`),
      specBrief: z.string().optional().describe('Optional L4 spec brief'),
    },
  },
  async ({ workspaceId, specBrief }) => {
    const ws = workspaceId ?? DEFAULT_WORKSPACE;
    const res = await fetch(`${RORCA_API}/api/direction/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: ws, l4SpecBrief: specBrief ?? '', l5Annotations: '' }),
    });
    if (!res.ok) {
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Failed to synthesize direction (${res.status}): ${await res.text()}` } }] };
    }
    const { synthesized } = await res.json() as { synthesized: string };
    return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Synthesized direction for "${ws}":\n\n${synthesized}` } }] };
  }
);

server.registerPrompt(
  'search_stories',
  {
    title: 'Search Stories',
    description: 'Search across all specs for stories matching a query.',
    argsSchema: {
      query: z.string().describe('Search query (matches ID, title, description, acceptance criteria)'),
      workspaceId: z.string().optional().describe(`Workspace ID (default: ${DEFAULT_WORKSPACE})`),
    },
  },
  async ({ query, workspaceId }) => {
    const ws = workspaceId ?? DEFAULT_WORKSPACE;
    const res = await fetch(`${RORCA_API}/api/specs/search/stories?workspaceId=${encodeURIComponent(ws)}&q=${encodeURIComponent(query)}`);
    if (!res.ok) {
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Search failed (${res.status}): ${await res.text()}` } }] };
    }
    const data = await res.json() as {
      resultCount: number;
      results: Array<{ specId: string; status: string; story: { id: string; title: string; acceptanceCriteria: string[] }; matchFields: string[] }>;
    };
    if (data.resultCount === 0) {
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `No stories found matching "${query}"` } }] };
    }
    const lines = data.results.map(r =>
      `[${r.status.toUpperCase()}] ${r.specId} → ${r.story.id}: ${r.story.title}\n  Matched in: ${r.matchFields.join(', ')}`
    );
    return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Found ${data.resultCount} stories matching "${query}":\n\n${lines.join('\n\n')}` } }] };
  }
);

server.registerPrompt(
  'add_stories',
  {
    title: 'Add Stories',
    description: 'Generate and append new LLM-generated stories to an existing spec.',
    argsSchema: {
      specId: z.string().describe('Spec ID slug'),
      count: z.string().optional().describe('Number of stories to add (default: 3)'),
      brief: z.string().optional().describe('Guidance for what the new stories should cover'),
      workspaceId: z.string().optional().describe(`Workspace ID (default: ${DEFAULT_WORKSPACE})`),
    },
  },
  async ({ specId, count, brief, workspaceId }) => {
    const ws = workspaceId ?? DEFAULT_WORKSPACE;
    const body: Record<string, unknown> = { workspaceId: ws, count: parseInt(count ?? '3', 10) || 3 };
    if (brief) body.brief = brief;
    const res = await fetch(`${RORCA_API}/api/specs/${specId}/add-stories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Failed to add stories (${res.status}): ${await res.text()}` } }] };
    }
    const data = await res.json() as { added: number; totalStories: number; newStories: Array<{ id: string; title: string }> };
    const storyList = data.newStories.map(s => `  • ${s.id}: ${s.title}`).join('\n');
    return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Added ${data.added} stories to "${specId}" (${data.totalStories} total):\n\n${storyList}` } }] };
  }
);

server.registerPrompt(
  'delete_story',
  {
    title: 'Delete Story',
    description: 'Remove a story from a spec. Remaining stories are reindexed.',
    argsSchema: {
      specId: z.string().describe('Spec ID slug'),
      storyId: z.string().describe('Story ID (e.g. US-003)'),
      workspaceId: z.string().optional().describe(`Workspace ID (default: ${DEFAULT_WORKSPACE})`),
    },
  },
  async ({ specId, storyId, workspaceId }) => {
    const ws = workspaceId ?? DEFAULT_WORKSPACE;
    const res = await fetch(`${RORCA_API}/api/specs/${specId}/stories/${storyId}?workspaceId=${encodeURIComponent(ws)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: ws }),
    });
    if (!res.ok) {
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Failed to delete story (${res.status}): ${await res.text()}` } }] };
    }
    const data = await res.json() as { deletedStory: { id: string; title: string }; version: number; remainingCount: number };
    return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `🗑️ Deleted "${data.deletedStory.title}" (${storyId}) from spec "${specId}".\nVersion snapshot: ${data.version}\nRemaining stories: ${data.remainingCount}` } }] };
  }
);

server.registerPrompt(
  'retry_story',
  {
    title: 'Retry Story',
    description: 'Retry failed stories in a completed pipeline run.',
    argsSchema: {
      runId: z.string().describe('Pipeline run ID'),
      storyIds: z.string().optional().describe('Comma-separated story IDs to retry (e.g. US-003,US-005). Omit to retry ALL failed.'),
    },
  },
  async ({ runId, storyIds }) => {
    const id = parseInt(runId, 10);
    if (isNaN(id)) {
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Invalid run ID: "${runId}"` } }] };
    }
    const body: Record<string, unknown> = {};
    if (storyIds) body.storyIds = storyIds.split(',').map(s => s.trim()).filter(Boolean);
    const res = await fetch(`${RORCA_API}/api/pipeline/runs/${id}/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Retry failed (${res.status}): ${await res.text()}` } }] };
    }
    const data = await res.json() as { runId: number; retriedStories: Array<{ storyId: string; attempt: number }> };
    const list = data.retriedStories.map(s => `  • ${s.storyId} (attempt #${s.attempt})`).join('\n');
    return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `🔄 Retry started for run #${data.runId}:\n\n${list}\n\nTrack progress with: /mcp__rorca__run_status ${data.runId}` } }] };
  }
);

server.registerPrompt(
  'usage_stats',
  {
    title: 'Usage Stats',
    description: 'Token usage and cost summary for a workspace.',
    argsSchema: {
      workspaceId: z.string().optional().describe(`Workspace ID (default: ${DEFAULT_WORKSPACE})`),
      groupBy: z.enum(['model', 'spec', 'story', 'user']).optional().describe('Group by: model | spec | story | user (default: model)'),
      from: z.string().optional().describe('Start date ISO-8601 (e.g. 2026-01-01). Defaults to 30 days ago.'),
      to: z.string().optional().describe('End date ISO-8601 (e.g. 2026-02-01). Defaults to now.'),
    },
  },
  async ({ workspaceId, groupBy, from, to }) => {
    const ws = workspaceId ?? DEFAULT_WORKSPACE;
    const params = new URLSearchParams({ workspace_id: ws, group_by: groupBy ?? 'model' });
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const res = await fetch(`${RORCA_API}/api/analytics/usage?${params}`);
    if (!res.ok) {
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Failed to get usage stats (${res.status}): ${await res.text()}` } }] };
    }
    const data = await res.json() as {
      grouped: Array<{ group_key: string; total_input_tokens: number; total_output_tokens: number; total_cost_usd: number; count: number }>;
      totals: { total_input_tokens: number; total_output_tokens: number; total_cost_usd: number };
    };
    const lines = data.grouped.length === 0
      ? ['No usage data for this period.']
      : data.grouped.map(g => `  ${g.group_key}: ${g.total_input_tokens.toLocaleString()} in / ${g.total_output_tokens.toLocaleString()} out — $${g.total_cost_usd.toFixed(4)} (${g.count} records)`);
    lines.push(`\nTotal: ${data.totals.total_input_tokens.toLocaleString()} in / ${data.totals.total_output_tokens.toLocaleString()} out — $${data.totals.total_cost_usd.toFixed(4)}`);
    return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Token usage for "${ws}" (by ${groupBy ?? 'model'}):\n\n${lines.join('\n')}` } }] };
  }
);

server.registerPrompt(
  'workspace_stats',
  {
    title: 'Workspace Stats',
    description: 'Quick health check: spec counts, run counts, story pass rate, last activity.',
    argsSchema: {
      workspaceId: z.string().optional().describe(`Workspace ID (default: ${DEFAULT_WORKSPACE})`),
    },
  },
  async ({ workspaceId }) => {
    const ws = workspaceId ?? DEFAULT_WORKSPACE;
    const res = await fetch(`${RORCA_API}/api/workspaces/${encodeURIComponent(ws)}/stats`);
    if (!res.ok) {
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Failed to get workspace stats (${res.status}): ${await res.text()}` } }] };
    }
    const data = await res.json() as {
      specs: { pending: number; approved: number; total: number };
      runs: { total: number; active: number; completed: number; failed: number };
      stories: { total: number; passed: number; failed: number; passRate: number };
      lastActivity: string | null;
    };
    const text = [
      `📊 Workspace stats: ${ws}`,
      ``,
      `Specs:   ${data.specs.total} total (${data.specs.pending} pending, ${data.specs.approved} approved)`,
      `Runs:    ${data.runs.total} total (${data.runs.active} active, ${data.runs.completed} completed, ${data.runs.failed} failed)`,
      `Stories: ${data.stories.total} executed — ${data.stories.passRate}% pass rate`,
      `Last activity: ${data.lastActivity ?? 'never'}`,
    ].join('\n');
    return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
  }
);

server.registerPrompt(
  'list_workspaces',
  {
    title: 'List Workspaces',
    description: 'List all registered workspaces with their paths and domains.',
    argsSchema: {},
  },
  async () => {
    const res = await fetch(`${RORCA_API}/api/workspaces`);
    if (!res.ok) {
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Failed to list workspaces (${res.status}): ${await res.text()}` } }] };
    }
    const data = await res.json() as { items?: Array<{ id: string; label: string; path: string; domains: string[] }>; workspaces?: Array<{ id: string; label: string; path: string; domains: string[] }> };
    const workspaces = data.items ?? data.workspaces ?? [];
    if (workspaces.length === 0) {
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: 'No workspaces registered.' } }] };
    }
    const lines = workspaces.map(w => `  • ${w.label} (${w.id})\n    Path: ${w.path}\n    Domains: ${w.domains.join(', ') || 'none'}`);
    return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Workspaces (${workspaces.length}):\n\n${lines.join('\n\n')}` } }] };
  }
);

server.registerPrompt(
  'get_memories',
  {
    title: 'Get Memories',
    description: 'Retrieve memories from the memory ledger, optionally filtered by category.',
    argsSchema: {
      workspaceId: z.string().optional().describe(`Workspace ID (default: ${DEFAULT_WORKSPACE})`),
      category: z.enum(['Architecture', 'Convention', 'Bug Fix', 'Decision', 'Pattern', 'Gotcha']).optional().describe('Filter by category'),
      limit: z.string().optional().describe('Max entries to return (default: 20)'),
    },
  },
  async ({ workspaceId, category, limit }) => {
    const ws = workspaceId ?? DEFAULT_WORKSPACE;
    const params = new URLSearchParams({ workspaceId: ws });
    if (category) params.set('category', category);
    if (limit) params.set('limit', limit);
    const res = await fetch(`${RORCA_API}/api/memory?${params}`);
    if (!res.ok) {
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Failed to get memories (${res.status}): ${await res.text()}` } }] };
    }
    const data = await res.json() as { items: Array<{ date: string; category: string; title: string; rule: string }>; total: number };
    if (data.items.length === 0) {
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `No memories found for "${ws}"${category ? ` in category ${category}` : ''}` } }] };
    }
    const lines = data.items.map(m => `[${m.date}] [${m.category}] ${m.title}\n  ${m.rule}`);
    return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Memories (${data.items.length}/${data.total}):\n\n${lines.join('\n\n')}` } }] };
  }
);

server.registerPrompt(
  'save_memory',
  {
    title: 'Save Memory',
    description: 'Save a memory entry (convention, bug fix, decision, pattern, gotcha) to the workspace ledger.',
    argsSchema: {
      category: z.enum(['Architecture', 'Convention', 'Bug Fix', 'Decision', 'Pattern', 'Gotcha']).describe('Memory category'),
      title: z.string().describe('Short title summarizing the memory'),
      rule: z.string().describe('The rule, convention, or lesson learned'),
      workspaceId: z.string().optional().describe(`Workspace ID (default: ${DEFAULT_WORKSPACE})`),
      context: z.string().optional().describe('Additional context'),
    },
  },
  async ({ category, title, rule, workspaceId, context }) => {
    const ws = workspaceId ?? DEFAULT_WORKSPACE;
    const body: Record<string, string> = { workspaceId: ws, category, title, rule };
    if (context) body.context = context;
    const res = await fetch(`${RORCA_API}/api/memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Failed to save memory (${res.status}): ${await res.text()}` } }] };
    }
    const data = await res.json() as { entry: { category: string; title: string; rule: string }; total: number };
    return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `🧠 Memory saved to "${ws}":\n[${data.entry.category}] ${data.entry.title}\n${data.entry.rule}\n\nTotal memories: ${data.total}` } }] };
  }
);

server.registerPrompt(
  'log_decision',
  {
    title: 'Log Decision',
    description: 'Record an architectural or technical decision with reasoning.',
    argsSchema: {
      title: z.string().describe('Decision title (e.g. "Use Zustand over Redux")'),
      decision: z.string().describe('What was decided and why'),
      alternatives: z.string().optional().describe('Alternatives considered and why rejected'),
      workspaceId: z.string().optional().describe(`Workspace ID (default: ${DEFAULT_WORKSPACE})`),
    },
  },
  async ({ title, decision, alternatives, workspaceId }) => {
    const ws = workspaceId ?? DEFAULT_WORKSPACE;
    const rule = alternatives ? `${decision}\n\nAlternatives considered: ${alternatives}` : decision;
    const res = await fetch(`${RORCA_API}/api/memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: ws, category: 'Decision', title, rule, source: 'mcp-cli' }),
    });
    if (!res.ok) {
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Failed to log decision (${res.status}): ${await res.text()}` } }] };
    }
    const data = await res.json() as { entry: { title: string; rule: string }; total: number };
    return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `📝 Decision logged: ${data.entry.title}\n\n${data.entry.rule}\n\nTotal memories: ${data.total}` } }] };
  }
);

server.registerPrompt(
  'validate_spec',
  {
    title: 'Validate Spec (Deep LLM Review)',
    description: 'LLM-powered deep spec review. Uses claude-sonnet-4-6 with spec-gap-analysis and assumption-buster skills to find: implicit assumptions, coverage gaps, untestable ACs, and missed stories.',
    argsSchema: {
      specId: z.string().describe('Spec slug (e.g. "rorca-feature-enhancements") — filename without .json'),
      workspaceId: z.string().optional().describe(`Workspace ID (default: ${DEFAULT_WORKSPACE})`),
    },
  },
  async ({ specId, workspaceId }) => {
    const ws = workspaceId ?? DEFAULT_WORKSPACE;
    const res = await fetch(`${RORCA_API}/api/specs/${encodeURIComponent(specId)}/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: ws }),
    });
    if (!res.ok) {
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Spec validation failed (${res.status}): ${await res.text()}` } }] };
    }
    const data = await res.json() as {
      assumptions: Array<{ storyId: string; assumption: string; risk: string }>;
      gaps: Array<{ area: string; description: string }>;
      untestableACs: Array<{ storyId: string; acIndex: number; reason: string }>;
      missedStories: Array<{ title: string; description: string; reason: string }>;
    };

    const lines: string[] = [];
    lines.push(`Deep Validation: ${specId}`);
    lines.push('');

    if (data.assumptions.length > 0) {
      lines.push(`Implicit Assumptions (${data.assumptions.length}):`);
      for (const a of data.assumptions) {
        lines.push(`  ⚠️  [${a.storyId}] ${a.assumption}`);
        lines.push(`       Risk: ${a.risk}`);
      }
      lines.push('');
    }

    if (data.gaps.length > 0) {
      lines.push(`Coverage Gaps (${data.gaps.length}):`);
      for (const g of data.gaps) {
        lines.push(`  🔍 [${g.area}] ${g.description}`);
      }
      lines.push('');
    }

    if (data.untestableACs.length > 0) {
      lines.push(`Untestable Acceptance Criteria (${data.untestableACs.length}):`);
      for (const u of data.untestableACs) {
        lines.push(`  ❌ [${u.storyId}] AC #${u.acIndex}: ${u.reason}`);
      }
      lines.push('');
    }

    if (data.missedStories.length > 0) {
      lines.push(`Missed Stories (${data.missedStories.length}):`);
      for (const m of data.missedStories) {
        lines.push(`  📋 ${m.title}`);
        lines.push(`       ${m.description}`);
        lines.push(`       Why needed: ${m.reason}`);
      }
      lines.push('');
    }

    if (data.assumptions.length === 0 && data.gaps.length === 0 && data.untestableACs.length === 0 && data.missedStories.length === 0) {
      lines.push('No issues found — spec looks comprehensive.');
    }

    return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: lines.join('\n') } }] };
  }
);

server.registerPrompt(
  'check_spec',
  {
    title: 'Check Spec',
    description: 'Validate a spec\'s structural integrity: missing required fields, duplicate IDs, orphaned dependsOn references, empty acceptanceCriteria.',
    argsSchema: {
      specId: z.string().describe('Spec slug (e.g. "rorca-feature-enhancements") — filename without .json'),
      workspaceId: z.string().optional().describe(`Workspace ID (default: ${DEFAULT_WORKSPACE})`),
    },
  },
  async ({ specId, workspaceId }) => {
    const ws = workspaceId ?? DEFAULT_WORKSPACE;
    const res = await fetch(`${RORCA_API}/api/specs/${encodeURIComponent(specId)}/check?workspaceId=${encodeURIComponent(ws)}`);
    if (!res.ok) {
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Spec check failed (${res.status}): ${await res.text()}` } }] };
    }
    const data = await res.json() as {
      valid: boolean;
      errors: Array<{ storyId: string; field: string; message: string }>;
      warnings: Array<{ storyId: string; field: string; message: string }>;
      stats: { totalStories: number; avgACCount: number; maxDependencyDepth: number };
    };

    const lines: string[] = [];
    lines.push(`Spec: ${specId}`);
    lines.push(`Valid: ${data.valid ? '✅ yes' : '❌ no'}`);
    lines.push(`Stories: ${data.stats.totalStories} | Avg AC: ${data.stats.avgACCount} | Max dep depth: ${data.stats.maxDependencyDepth}`);

    if (data.errors.length > 0) {
      lines.push(`\nErrors (${data.errors.length}):`);
      for (const e of data.errors) {
        lines.push(`  ❌ [${e.storyId}] ${e.field}: ${e.message}`);
      }
    }

    if (data.warnings.length > 0) {
      lines.push(`\nWarnings (${data.warnings.length}):`);
      for (const w of data.warnings) {
        lines.push(`  ⚠️  [${w.storyId}] ${w.field}: ${w.message}`);
      }
    }

    if (data.errors.length === 0 && data.warnings.length === 0) {
      lines.push('\nNo issues found.');
    }

    return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: lines.join('\n') } }] };
  }
);

server.registerPrompt(
  'score_spec',
  {
    title: 'Score Spec',
    description: 'Score a spec\'s acceptance criteria quality (0-100). Checks AC count, specificity (penalizes vague phrases like "properly", "correctly"), and state coverage (error/empty/loading states).',
    argsSchema: {
      specId: z.string().describe('Spec slug (e.g. "rorca-feature-enhancements") — filename without .json'),
      workspaceId: z.string().optional().describe(`Workspace ID (default: ${DEFAULT_WORKSPACE})`),
    },
  },
  async ({ specId, workspaceId }) => {
    const ws = workspaceId ?? DEFAULT_WORKSPACE;
    const res = await fetch(`${RORCA_API}/api/specs/${encodeURIComponent(specId)}/score?workspaceId=${encodeURIComponent(ws)}`);
    if (!res.ok) {
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Spec score failed (${res.status}): ${await res.text()}` } }] };
    }
    const data = await res.json() as {
      specScore: number;
      stories: Array<{
        id: string;
        score: number;
        acCount: number;
        vaguePhrasesFound: string[];
        stateCoverage: { error: boolean; empty: boolean; loading: boolean };
      }>;
    };

    const lines: string[] = [];
    lines.push(`Spec: ${specId}`);
    lines.push(`Overall score: ${data.specScore}/100`);
    lines.push(`Stories scored: ${data.stories.length}`);
    lines.push('');

    for (const s of data.stories) {
      const coverage = [
        s.stateCoverage.error ? 'error' : '',
        s.stateCoverage.empty ? 'empty' : '',
        s.stateCoverage.loading ? 'loading' : '',
      ].filter(Boolean).join(', ') || 'none';
      lines.push(`[${s.id}] score=${s.score}/100 ac=${s.acCount} coverage=${coverage}`);
      if (s.vaguePhrasesFound.length > 0) {
        lines.push(`  ⚠️  Vague: ${s.vaguePhrasesFound.join(', ')}`);
      }
    }

    return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: lines.join('\n') } }] };
  }
);

server.registerTool(
  'rorca_suggest_skills',
  {
    description: 'Run LLM-driven skill matching for a spec. Reads installed skills from .rorca/skills/, MEMORY.md, and AGENTS.md, then assigns suggestedSkills arrays (name, relevance 1-10, reason) to each story. Writes updated spec JSON back to the filesystem.',
    inputSchema: {
      workspaceId: z.string().describe('Rorca workspace ID'),
      specId: z.string().describe('Spec slug (e.g. "rorca-feature-enhancements") — filename without .json'),
    },
  },
  async ({ workspaceId, specId }) => {
    const res = await fetch(`${RORCA_API}/api/specs/${encodeURIComponent(specId)}/suggest-skills`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId }),
    });
    if (!res.ok) {
      throw new Error(`Skill suggestion failed (${res.status}): ${await res.text()}`);
    }
    const data = await res.json() as {
      matched: number;
      storiesAffected: number;
      stories: Array<{ storyId: string; skills: Array<{ name: string; relevance: number; reason: string }> }>;
    };
    const lines: string[] = [
      `Skill matching complete: ${data.matched} skills across ${data.storiesAffected} stories`,
      '',
    ];
    for (const s of data.stories) {
      if (s.skills.length === 0) continue;
      lines.push(`[${s.storyId}]`);
      for (const sk of s.skills) {
        lines.push(`  • ${sk.name} (relevance ${sk.relevance}/10): ${sk.reason}`);
      }
    }
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
);

server.registerPrompt(
  'suggest_skills',
  {
    title: 'Suggest Skills',
    description: 'Run LLM-driven skill matching for a spec. Assigns suggestedSkills with name, relevance (1-10), and reasoning to each story based on installed skills, MEMORY.md, and AGENTS.md.',
    argsSchema: {
      specId: z.string().describe('Spec slug (e.g. "rorca-feature-enhancements") — filename without .json'),
      workspaceId: z.string().optional().describe(`Workspace ID (default: ${DEFAULT_WORKSPACE})`),
    },
  },
  async ({ specId, workspaceId }) => {
    const ws = workspaceId ?? DEFAULT_WORKSPACE;
    const res = await fetch(`${RORCA_API}/api/specs/${encodeURIComponent(specId)}/suggest-skills`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: ws }),
    });
    if (!res.ok) {
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Skill suggestion failed (${res.status}): ${await res.text()}` } }] };
    }
    const data = await res.json() as {
      matched: number;
      storiesAffected: number;
      stories: Array<{ storyId: string; skills: Array<{ name: string; relevance: number; reason: string }> }>;
    };
    const lines: string[] = [
      `Spec: ${specId}`,
      `Skills matched: ${data.matched} across ${data.storiesAffected} stories`,
      '',
    ];
    for (const s of data.stories) {
      if (s.skills.length === 0) continue;
      lines.push(`[${s.storyId}]`);
      for (const sk of s.skills) {
        lines.push(`  • ${sk.name} (${sk.relevance}/10): ${sk.reason}`);
      }
    }
    if (data.matched === 0) {
      lines.push('No skills matched. Install skills from the Marketplace first.');
    }
    return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: lines.join('\n') } }] };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.env.NODE_ENV !== 'test') {
  main().catch((err) => logger.error({ err }, 'MCP server error'));
}
