import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export const RORCHA_API = process.env.RORCHA_API_URL || 'http://localhost:3030';

export const server = new McpServer({
  name: 'rorcha',
  version: '1.0.0',
});

server.registerTool(
  'rorcha_get_context',
  {
    description: 'Get the synthesized Direction Stack for a workspace. Returns a single string containing all direction layers (L1 global brain, L2 domain profile, L3 project brief, L4 spec brief, L5 story annotations) merged in priority order. Use this to inject full AI context at the start of any spec generation or implementation session.',
    inputSchema: {
      workspaceId: z.string().describe('Rorcha workspace ID (from rorcha_list_workspaces or settings)'),
      specBrief: z.string().optional().describe('L4: one-paragraph description of the specific spec being worked on'),
      storyAnnotations: z.string().optional().describe('L5: story-level context, acceptance criteria notes, or implementation hints'),
    },
  },
  async ({ workspaceId, specBrief, storyAnnotations }) => {
    const res = await fetch(`${RORCHA_API}/api/direction/synthesize`, {
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
  'rorcha_generate_spec',
  {
    description: 'Generate a spec JSON (with userStories array) from a spec brief. Calls the Rorcha synthesis engine which injects the full Direction Stack before sending to the LLM. Returns the generated spec as a JSON string ready to save as prd.json or submit for review.',
    inputSchema: {
      workspaceId: z.string().describe('Rorcha workspace ID'),
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
    const res = await fetch(`${RORCHA_API}/api/specs/generate`, {
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
  'rorcha_list_specs',
  {
    description: 'List all specs in a workspace. Returns specs grouped by status: pending (generated, awaiting review), approved (ready to run via Ralph Loop), and running (currently executing in a pipeline). Useful for checking queue state before starting a pipeline.',
    inputSchema: {
      workspaceId: z.string().describe('Rorcha workspace ID'),
      status: z.enum(['pending', 'approved', 'all']).optional().default('all').describe('Filter by spec status'),
    },
  },
  async ({ workspaceId, status }) => {
    const resolvedStatus = status ?? 'all';
    const res = await fetch(`${RORCHA_API}/api/specs?workspaceId=${workspaceId}&status=${resolvedStatus}`);
    if (!res.ok) throw new Error(`Failed to list specs: ${res.status}`);
    const specs = await res.json() as Array<{ id: string; title: string; status: string; storyCount: number; createdAt: string }>;
    if (specs.length === 0) {
      return { content: [{ type: 'text' as const, text: `No specs found for workspace ${workspaceId} (filter: ${resolvedStatus})` }] };
    }
    const lines = specs.map(s =>
      `[${s.status.toUpperCase()}] ${s.title} (${s.storyCount} stories) — ${s.id}`
    );
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  }
);

server.registerTool(
  'rorcha_approve_spec',
  {
    description: 'Approve a pending spec and move it to the approved queue. Once approved, the spec can be executed by Ralph Loop via run-loop.sh. Use rorcha_list_specs to find the spec ID first.',
    inputSchema: {
      workspaceId: z.string().describe('Rorcha workspace ID'),
      specId: z.string().describe('Spec ID (from rorcha_list_specs output)'),
      notes: z.string().optional().describe('Optional approval notes to append to the spec'),
    },
  },
  async ({ workspaceId, specId, notes }) => {
    const body: Record<string, string> = { workspaceId };
    if (notes !== undefined) body.notes = notes;
    const res = await fetch(`${RORCHA_API}/api/specs/${specId}/approve`, {
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
        text: `Spec approved and moved to: ${approvedPath}\n\nRun it with:\n  ~/rorcha/scripts/run-loop.sh --json ${approvedPath}`
      }]
    };
  }
);

server.registerTool(
  'rorcha_pipeline_status',
  {
    description: 'Get the status of the active (or most recent) pipeline run for a workspace. Returns run status (running/paused/done/failed), story-level progress (pass/fail/skip counts), elapsed time, and last log line. Use this to monitor a Ralph Loop session without switching windows.',
    inputSchema: {
      workspaceId: z.string().describe('Rorcha workspace ID'),
      runId: z.number().optional().describe('Specific run ID. If omitted, returns the most recent run.'),
    },
  },
  async ({ workspaceId, runId }) => {
    const url = runId
      ? `${RORCHA_API}/api/pipeline-runs/${runId}`
      : `${RORCHA_API}/api/pipeline-runs?workspaceId=${workspaceId}&limit=1`;
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
  'rorcha_trigger_run',
  {
    description: 'Start a pipeline run for an approved spec. Spawns run-loop.sh in the project workspace to execute all user stories sequentially. Optionally runs in dry-run mode (returns cost estimate without executing) or creates an isolated git worktree for the run.',
    inputSchema: {
      workspaceId: z.string().describe('Rorcha workspace ID'),
      specId: z.string().describe('Spec ID (filename slug) — must be in approved status'),
      dryRun: z.boolean().optional().default(false).describe('If true, returns a cost estimate without spawning the run'),
      autoWorktree: z.boolean().optional().default(false).describe('If true, creates an isolated git worktree branch for this run'),
    },
  },
  async ({ workspaceId, specId, dryRun, autoWorktree }) => {
    const res = await fetch(`${RORCHA_API}/api/pipeline/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId,
        specPath: `ralph/specs/approved/${specId}.json`,
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
  'rorcha_run_status',
  {
    description: 'Get detailed status of a specific pipeline run including per-story progress. Returns run status, elapsed time, and individual story pass/fail/skip/retry status with token counts. Use rorcha_list_runs to find run IDs.',
    inputSchema: {
      runId: z.number().describe('Pipeline run ID'),
    },
  },
  async ({ runId }) => {
    const res = await fetch(`${RORCHA_API}/api/pipeline/runs/${runId}`);
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
  'rorcha_usage_stats',
  {
    description: 'Get token usage and cost summary for a workspace over a date range. Returns aggregated usage grouped by model, with total input/output tokens, cost in USD, and daily time series. Useful for tracking spend and optimizing model selection.',
    inputSchema: {
      workspaceId: z.string().describe('Rorcha workspace ID'),
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

    const res = await fetch(`${RORCHA_API}/api/analytics/usage?${params.toString()}`);
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
  'rorcha_retry_story',
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

    const res = await fetch(`${RORCHA_API}/api/pipeline/runs/${runId}/retry`, {
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
  'rorcha_list_runs',
  {
    description: 'List recent pipeline runs for a workspace with status, spec, and completion summary. Returns runs ordered by most recent first. Use this to find run IDs for rorcha_run_status or rorcha_retry_story.',
    inputSchema: {
      workspaceId: z.string().describe('Rorcha workspace ID'),
      limit: z.number().min(1).max(50).optional().default(10).describe('Maximum number of runs to return (default 10, max 50)'),
    },
  },
  async ({ workspaceId, limit }) => {
    const resolvedLimit = limit ?? 10;
    const res = await fetch(`${RORCHA_API}/api/pipeline/runs?workspaceId=${encodeURIComponent(workspaceId)}&limit=${resolvedLimit}`);
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to list runs (${res.status}): ${err}`);
    }

    const { runs } = await res.json() as {
      runs: Array<{
        id: number; status: string; spec_path: string;
        branch_name: string | null; trigger_type: string | null;
        started_at: string; finished_at: string | null;
      }>;
    };

    if (runs.length === 0) {
      return { content: [{ type: 'text' as const, text: `No pipeline runs found for workspace ${workspaceId}` }] };
    }

    const lines = runs.slice(0, resolvedLimit).map(r => {
      const elapsed = r.finished_at
        ? `${Math.round((new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 60000)}m`
        : `${Math.round((Date.now() - new Date(r.started_at).getTime()) / 60000)}m`;
      const spec = r.spec_path.replace('ralph/specs/approved/', '').replace('.json', '');
      const branch = r.branch_name ? ` [${r.branch_name}]` : '';
      return `#${r.id}: ${r.status.toUpperCase()} — ${spec} (${elapsed})${branch}`;
    });

    return { content: [{ type: 'text' as const, text: `Recent runs:\n${lines.join('\n')}` }] };
  }
);

// ─── V2-067: Extended Spec Lifecycle MCP Tools ────────────────────────────────

server.registerTool(
  'rorcha_edit_story',
  {
    description: 'Update a single story in an existing spec. Can modify title, description, and acceptance criteria by spec ID and story ID. The spec can be in pending or approved status. Use rorcha_list_specs to find the spec ID, then rorcha_search_stories or read the spec to find the story ID (e.g. US-001).',
    inputSchema: {
      workspaceId: z.string().describe('Rorcha workspace ID'),
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

    const res = await fetch(`${RORCHA_API}/api/specs/${specId}/stories/${storyId}`, {
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
  'rorcha_search_stories',
  {
    description: 'Search across all specs in a workspace for stories matching a query string. Searches story IDs, titles, descriptions, and acceptance criteria. Returns matching stories with their spec context. Useful for finding related stories, checking for duplicates, or locating a specific story when you only know partial text.',
    inputSchema: {
      workspaceId: z.string().describe('Rorcha workspace ID'),
      query: z.string().describe('Search query — matches against story ID, title, description, and acceptance criteria'),
    },
  },
  async ({ workspaceId, query }) => {
    const res = await fetch(`${RORCHA_API}/api/specs/search/stories?workspaceId=${encodeURIComponent(workspaceId)}&q=${encodeURIComponent(query)}`);

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
  'rorcha_add_stories',
  {
    description: 'Generate and append new stories to an existing spec using the LLM. The new stories are AI-generated based on the existing spec context and an optional brief describing what the new stories should cover. Story IDs are auto-sequenced after existing stories.',
    inputSchema: {
      workspaceId: z.string().describe('Rorcha workspace ID'),
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

    const res = await fetch(`${RORCHA_API}/api/specs/${specId}/add-stories`, {
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
  'rorcha_delete_story',
  {
    description: 'Remove a single story from a spec by spec ID and story ID. The remaining stories are automatically reindexed to maintain sequential IDs (US-001, US-002, ...). Dependencies referencing the deleted story are cleaned up. A version snapshot is created before deletion for rollback.',
    inputSchema: {
      workspaceId: z.string().describe('Rorcha workspace ID'),
      specId: z.string().describe('Spec ID (filename slug)'),
      storyId: z.string().describe('Story ID to delete (e.g. "US-003")'),
    },
  },
  async ({ workspaceId, specId, storyId }) => {
    const res = await fetch(`${RORCHA_API}/api/specs/${specId}/stories/${storyId}?workspaceId=${encodeURIComponent(workspaceId)}`, {
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
  'rorcha_get_direction',
  {
    description: 'Get the full direction stack for a workspace, returning all layers (L1 global brain, L2 domain profile, L3 project brief) and their raw content. L4 (spec brief) and L5 (story annotations) are per-request and not persisted. Also returns team-level L1/L2 overrides if the workspace belongs to a team.',
    inputSchema: {
      workspaceId: z.string().describe('Rorcha workspace ID'),
    },
  },
  async ({ workspaceId }) => {
    const res = await fetch(`${RORCHA_API}/api/direction/all?workspaceId=${encodeURIComponent(workspaceId)}`);
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
  'rorcha_update_direction',
  {
    description: 'Update a specific direction layer (L1, L2, or L3) for a workspace. Content must be valid YAML. L1 is the global brain (engineering principles), L2 is the domain profile (auth patterns, API conventions), L3 is the project brief (stack, architecture, constraints). L4/L5 are per-request and cannot be persisted via this tool. Changes take effect immediately in subsequent spec generations.',
    inputSchema: {
      workspaceId: z.string().describe('Rorcha workspace ID — required for L2 and L3, optional for L1 (global)'),
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

    const res = await fetch(`${RORCHA_API}/api/direction`, {
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
  'rorcha_synthesize_direction',
  {
    description: 'Get the fully synthesized direction stack as a single merged string, exactly as it would be sent to the LLM during spec generation. Merges L1 through L5 in priority order with team overrides, auto-hydrated schema/git context, and optional L4/L5 content. Use this to preview what the LLM will see.',
    inputSchema: {
      workspaceId: z.string().describe('Rorcha workspace ID'),
      specBrief: z.string().optional().describe('L4: spec brief text (one-paragraph description). If omitted, shows synthesis without L4.'),
      storyAnnotations: z.string().optional().describe('L5: story-level annotations, edge cases, or implementation hints'),
    },
  },
  async ({ workspaceId, specBrief, storyAnnotations }) => {
    const res = await fetch(`${RORCHA_API}/api/direction/synthesize`, {
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
  'rorcha_list_workspaces',
  {
    description: 'List all registered workspaces the user has access to. Returns workspace ID, label, filesystem path, and domain tags. Use this to find workspace IDs for other tools (rorcha_generate_spec, rorcha_trigger_run, etc.).',
    inputSchema: {},
  },
  async () => {
    const res = await fetch(`${RORCHA_API}/api/workspaces`);
    if (!res.ok) throw new Error(`Failed to list workspaces: ${res.status}`);
    const { workspaces } = await res.json() as {
      workspaces: Array<{
        id: string; label: string; path: string;
        domains: string[]; created_at: string;
      }>;
    };

    if (workspaces.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No workspaces registered. Use rorcha_create_workspace to register one.' }] };
    }

    const lines = workspaces.map(w =>
      `${w.label} (${w.id})\n  Path: ${w.path}\n  Domains: ${w.domains.length > 0 ? w.domains.join(', ') : 'none'}`
    );
    return { content: [{ type: 'text' as const, text: `Workspaces (${workspaces.length}):\n\n${lines.join('\n\n')}` }] };
  }
);

server.registerTool(
  'rorcha_create_workspace',
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
    const res = await fetch(`${RORCHA_API}/api/workspaces`, {
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
  'rorcha_workspace_stats',
  {
    description: 'Get summary statistics for a workspace: spec count (pending/approved), pipeline run count (total/active/completed/failed), story pass rate, and last activity timestamp. Useful for a quick health check or dashboard overview.',
    inputSchema: {
      workspaceId: z.string().describe('Rorcha workspace ID'),
    },
  },
  async ({ workspaceId }) => {
    const res = await fetch(`${RORCHA_API}/api/workspaces/${encodeURIComponent(workspaceId)}/stats`);
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
  'rorcha_team_members',
  {
    description: 'Get the team member list for a workspace. Looks up the team associated with the workspace via workspace_access and returns all members with their roles (admin/editor/viewer), email, and last activity. Returns an empty list if the workspace is not team-scoped.',
    inputSchema: {
      workspaceId: z.string().describe('Rorcha workspace ID — must be linked to a team via workspace_access'),
    },
  },
  async ({ workspaceId }) => {
    const res = await fetch(`${RORCHA_API}/api/workspaces/${encodeURIComponent(workspaceId)}/team-members`);
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.env.NODE_ENV !== 'test') {
  main().catch(console.error);
}
