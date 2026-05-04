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
import { detectCapability } from '../lib/reasoning-detector';
import { ALL_MODELS } from '../lib/llm-client';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export const RORCA_API = process.env.RORCA_API_URL || 'http://localhost:3030';

export const server = new McpServer({
  name: 'rorca',
  version: '1.0.0',
});

// ─── MC-007: Error Recovery & Offline Handling ────────────────────────────────

/** Tools that are safe to retry on ECONNREFUSED (GET-equivalent, idempotent). */
const IDEMPOTENT_TOOLS = new Set([
  'rorca_list_specs', 'rorca_list_runs', 'rorca_get_direction',
  'rorca_list_workspaces', 'rorca_recall_memories', 'rorca_workspace_stats',
  'rorca_get_context', 'rorca_synthesize_direction', 'rorca_search_stories',
  'rorca_run_status', 'rorca_pipeline_status', 'rorca_usage_stats',
  'rorca_recall_workspace', 'rorca_model_capabilities',
]);

/** Cacheable tool names → { data, cachedAt } */
const toolCache = new Map<string, { data: unknown; cachedAt: string }>();

/** Structured error result for MCP tool calls. */
function mkError(toolName: string, fields: Record<string, unknown>) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        ok: false,
        tool: toolName,
        timestamp: new Date().toISOString(),
        ...fields,
      }, null, 2),
    }],
    isError: true as const,
  };
}

/**
 * Make a fetch call with a configurable AbortController timeout.
 * Default: 5 minutes (covers Opus spec generation at 40-90s + overhead).
 * Pass timeoutMs = 0 to disable the timeout entirely (for slow paths like enrich,
 * match-skills, suggest-skills — long-term fix is async jobs, see MCP-A* stories).
 * Throws on ECONNREFUSED, fetch failure, or timeout.
 */
async function timedFetch(url: string, init?: RequestInit, timeoutMs = 300_000): Promise<Response> {
  if (timeoutMs <= 0) {
    return fetch(url, init);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw Object.assign(new Error('TIMEOUT'), { isTimeout: true });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Retry a fetch factory fn with exponential backoff for idempotent tools.
 * Delays: 1s, 2s, 4s (3 attempts before giving up).
 */
async function fetchWithRetry(
  toolName: string,
  fn: () => Promise<Response>,
): Promise<Response> {
  const isIdempotent = IDEMPOTENT_TOOLS.has(toolName);
  const maxAttempts = isIdempotent ? 3 : 1;
  const delays = [1000, 2000, 4000];

  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const isConnRefused = msg.includes('ECONNREFUSED') || msg.includes('fetch failed');
      lastErr = err;

      if (!isConnRefused || !isIdempotent) throw err;

      if (attempt < maxAttempts - 1) {
        console.error(`[rorca-mcp] ${toolName} retrying (attempt ${attempt + 2}/${maxAttempts}) after ECONNREFUSED...`);
        await new Promise(r => setTimeout(r, delays[attempt]));
      }
    }
  }
  throw lastErr;
}

/**
 * Shared wrapper for all MCP tool call handlers.
 * Handles: ECONNREFUSED, timeout, non-2xx HTTP, cached fallback.
 */
async function wrapToolCall<T>(
  toolName: string,
  fn: () => Promise<T>,
  cacheKey?: string,
): Promise<T | ReturnType<typeof mkError>> {
  try {
    const result = await fn();

    // Store result in cache if a cache key is provided
    if (cacheKey !== undefined) {
      try {
        toolCache.set(cacheKey, { data: result, cachedAt: new Date().toISOString() });
      } catch { /* never let cache write failure break the tool */ }
    }

    return result;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[rorca-mcp]', toolName, msg);

    // Timeout
    if (err instanceof Error && (err as NodeJS.ErrnoException & { isTimeout?: boolean }).isTimeout) {
      return mkError(toolName, {
        error: 'Tool call timed out after 30 seconds. The Rorca server is running but may be slow. Try again.',
        category: 'timeout',
        suggestion: 'The Rorca server may be overloaded. Try again.',
      });
    }

    // ECONNREFUSED / offline
    const isConnRefused = msg.includes('ECONNREFUSED') || msg.includes('fetch failed');
    if (isConnRefused) {
      // Return cached data for idempotent tools if available
      if (cacheKey !== undefined && toolCache.has(cacheKey)) {
        const cached = toolCache.get(cacheKey)!;
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              cached: true,
              cached_at: cached.cachedAt,
              warning: 'Using cached data — Rorca server is offline',
              data: cached.data,
            }, null, 2),
          }],
        } as T;
      }

      return mkError(toolName, {
        error: 'Rorca server is offline',
        offline: true,
        suggestion: 'Start the server: rorca start',
        category: 'offline',
      });
    }

    // Re-throw — caller handles HTTP errors and Zod errors
    throw err;
  }
}

/**
 * Wrap a non-2xx HTTP response into a structured MCP error.
 * Call this immediately after receiving a response (before reading body).
 */
async function httpError(
  toolName: string,
  res: Response,
): Promise<ReturnType<typeof mkError>> {
  let body = '';
  try { body = await res.text(); } catch { /* ignore */ }
  return mkError(toolName, {
    error: `API error: ${res.status} ${res.statusText}`,
    category: 'http_error',
    body: body.slice(0, 400),
  });
}

/** Start a 30s health-check ping. Returns a cleanup function. */
export function startHealthCheck(): () => void {
  let lastOnline: boolean | null = null;

  const timer = setInterval(async () => {
    let online = false;
    try {
      const res = await timedFetch(`${RORCA_API}/api/health`);
      online = res.ok;
    } catch { /* offline */ }

    if (online !== lastOnline) {
      lastOnline = online;
      try {
        server.server.notification({
          method: 'notifications/rorca/connection',
          params: { online, url: RORCA_API },
        });
      } catch { /* MCP client may not be connected yet */ }
    }
  }, 30_000);

  return () => clearInterval(timer);
}

// ─── End MC-007 infrastructure ─────────────────────────────────────────────────

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
    return wrapToolCall('rorca_get_context', async () => {
      const res = await fetchWithRetry('rorca_get_context', () => timedFetch(`${RORCA_API}/api/direction/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, l4SpecBrief: specBrief, l5Annotations: storyAnnotations }),
      }));
      if (!res.ok) return httpError('rorca_get_context', res);
      const { synthesized } = await res.json() as { synthesized: string };
      return { content: [{ type: 'text' as const, text: synthesized }] };
    }, `get_context:${workspaceId}`);
  }
);

server.registerTool(
  'rorca_model_capabilities',
  {
    description: 'Returns the computed ReasoningCapability for a given model ID. Use this to check whether a model supports extended thinking, effort levels, or native chain-of-thought before configuring a spec or pipeline run.',
    inputSchema: {
      modelId: z.string().describe('The model identifier string (e.g. "claude-opus-4-6", "o3", "openai/o4-mini")'),
    },
  },
  async ({ modelId }) => {
    return wrapToolCall('rorca_model_capabilities', async () => {
      const capability = detectCapability(modelId);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ ok: true, modelId, capability }, null, 2),
        }],
      };
    });
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
      model: z.string().optional().describe('LLM model to use for generation (any model ID). If omitted, uses workspace default or claude-sonnet-4-6.'),
      thinkingEnabled: z.boolean().optional().default(false).describe('(Deprecated — use reasoning.enabled) Enable extended thinking for deeper reasoning during spec generation (Anthropic models).'),
      thinkingBudget: z.number().min(1024).max(65536).optional().default(8192).describe('(Deprecated — use reasoning.budgetTokens) Token budget for extended thinking (only used when thinkingEnabled=true). Default 8192.'),
      reasoning: z.object({
        enabled: z.boolean().describe('Enable reasoning/extended thinking for this spec generation'),
        effort: z.string().optional().describe('Effort level for reasoning (low/medium/high/max — model-dependent)'),
      }).optional().describe('Reasoning config. Takes precedence over thinkingEnabled/thinkingBudget if both are provided.'),
    },
  },
  async ({ workspaceId, specBrief, title, storyCount, includeDiagrams, model, thinkingEnabled, thinkingBudget, reasoning }) => {
    return wrapToolCall('rorca_generate_spec', async () => {
      const resolvedStoryCount = storyCount ?? 8;
      const resolvedIncludeDiagrams = includeDiagrams ?? true;

      // Build reasoning payload: new `reasoning` param takes precedence; fall back to legacy thinkingEnabled/thinkingBudget
      let reasoningPayload: Record<string, unknown> = {};
      if (reasoning) {
        reasoningPayload = { reasoning };
        // Also propagate as legacy fields for backward compat with older backend versions
        if (reasoning.enabled) {
          reasoningPayload.thinkingEnabled = true;
        }
      } else if (thinkingEnabled) {
        reasoningPayload = { thinkingEnabled, thinkingBudget: thinkingBudget ?? 8192 };
      }

      const res = await timedFetch(`${RORCA_API}/api/specs/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId, specBrief, title,
          storyCount: resolvedStoryCount,
          includeDiagrams: resolvedIncludeDiagrams,
          ...(model ? { model } : {}),
          ...reasoningPayload,
        }),
      }, 0); // unbounded — Opus with 50+ stories can take 10+ min; rely on upstream MCP client timeout
      if (!res.ok) return httpError('rorca_generate_spec', res);
      const spec = await res.json() as { slug?: string; id?: string; title?: string; model?: string; usage?: { inputTokens?: number; outputTokens?: number } };

      // Enrich + match-skills run automatically in the backend after generate completes.
      // No need to chain them here — backend fires them via setImmediate post-response.
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            title,
            specId: spec.slug ?? spec.id ?? title,
            model: spec.model ?? 'unknown',
            tokens: { in: spec.usage?.inputTokens ?? 0, out: spec.usage?.outputTokens ?? 0 },
            note: 'Enrich + skill matching running in background. Skills tab will populate within ~2 min.',
          }, null, 2),
        }],
      };
    });
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
    const cacheKey = `list_specs:${workspaceId}:${status ?? 'all'}`;
    return wrapToolCall('rorca_list_specs', async () => {
      const resolvedStatus = status ?? 'all';
      const res = await fetchWithRetry('rorca_list_specs', () => timedFetch(`${RORCA_API}/api/specs?workspaceId=${workspaceId}&status=${resolvedStatus}`));
      if (!res.ok) return httpError('rorca_list_specs', res);
      const data = await res.json() as { items?: Array<{ id: string; title?: string; specName?: string; status: string; storyCount: number; createdAt: string }> } | Array<{ id: string; title?: string; specName?: string; status: string; storyCount: number; createdAt: string }>;
      const specs = Array.isArray(data) ? data : (data.items ?? []);
      if (specs.length === 0) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, specs: [], message: `No specs found for workspace ${workspaceId} (filter: ${resolvedStatus})` }, null, 2) }] };
      }
      const lines = specs.map(s => `[${s.status.toUpperCase()}] ${s.specName ?? s.title ?? s.id} (${s.storyCount} stories) — ${s.id}`);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, specs, summary: lines }, null, 2) }] };
    }, cacheKey);
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
    return wrapToolCall('rorca_approve_spec', async () => {
      const body: Record<string, string> = { workspaceId };
      if (notes !== undefined) body.notes = notes;
      const res = await timedFetch(`${RORCA_API}/api/specs/${specId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) return httpError('rorca_approve_spec', res);
      const { path: approvedPath } = await res.json() as { path: string };
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ ok: true, specId, approvedPath, message: `Spec approved and moved to: ${approvedPath}` }, null, 2),
        }],
      };
    });
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
    const cacheKey = `pipeline_status:${workspaceId}`;
    return wrapToolCall('rorca_pipeline_status', async () => {
      const url = runId
        ? `${RORCA_API}/api/pipeline-runs/${runId}`
        : `${RORCA_API}/api/pipeline-runs?workspaceId=${workspaceId}&limit=1`;
      const res = await fetchWithRetry('rorca_pipeline_status', () => timedFetch(url));
      if (!res.ok) return httpError('rorca_pipeline_status', res);
      const data = await res.json() as {
        id: number; status: string; specPath: string;
        startedAt: string; finishedAt?: string;
        stories: Array<{ storyId: string; status: string; retries: number }>;
      };
      const run = Array.isArray(data) ? data[0] : data;
      if (!run) return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, message: `No pipeline runs found for workspace ${workspaceId}` }, null, 2) }] };
      const pass = run.stories.filter((s: { status: string }) => s.status === 'pass').length;
      const fail = run.stories.filter((s: { status: string }) => s.status === 'fail').length;
      const skip = run.stories.filter((s: { status: string }) => s.status === 'skip').length;
      const total = run.stories.length;
      const elapsed = run.finishedAt
        ? `${Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 60000)}m`
        : `${Math.round((Date.now() - new Date(run.startedAt).getTime()) / 60000)}m (running)`;
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, runId: run.id, status: run.status, elapsed, specPath: run.specPath, stories: { pass, fail, skip, total } }, null, 2) }] };
    }, cacheKey);
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
      reasoningEffort: z.string().optional().describe('Override reasoning effort level for this run (low/medium/high/max — model-dependent). Uses spec-level config if omitted.'),
    },
  },
  async ({ workspaceId, specId, dryRun, autoWorktree, reasoningEffort }) => {
    return wrapToolCall('rorca_trigger_run', async () => {
      const res = await timedFetch(`${RORCA_API}/api/pipeline/trigger`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          specPath: `forge/specs/approved/${specId}.json`,
          dryRun: dryRun ?? false,
          autoWorktree: autoWorktree ?? false,
          ...(reasoningEffort ? { reasoningEffort } : {}),
        }),
      });
      const data = await res.json() as Record<string, unknown>;
      if (!res.ok) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, tool: 'rorca_trigger_run', timestamp: new Date().toISOString(), error: `API error: ${res.status} ${res.statusText}`, body: data }, null, 2) }],
          isError: true as const,
        };
      }
      if (data.conflict) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, tool: 'rorca_trigger_run', timestamp: new Date().toISOString(), error: 'Workspace already has an active run', activeRunId: data.activeRunId, suggestion: 'Wait for it to finish or set autoWorktree: true to run in parallel' }, null, 2) }], isError: true as const };
      }
      if (data.dryRun) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, dryRun: true, specId, estimate: data.estimate }, null, 2) }] };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, runId: data.runId, specId, branchName: data.branchName ?? null, worktreePath: data.worktreePath ?? null }, null, 2) }] };
    });
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
    return wrapToolCall('rorca_run_status', async () => {
    const res = await fetchWithRetry('rorca_run_status', () => timedFetch(`${RORCA_API}/api/pipeline/runs/${runId}`));
    if (!res.ok) return httpError('rorca_run_status', res);

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
        text: JSON.stringify({ ok: true, run: { id: run.id, status: run.status, specPath: run.spec_path, elapsed, branchName: run.branch_name }, progress: { pass, fail, skip, retry, total: stories.length }, storyDetail: storyLines }, null, 2),
      }]
    };
    }, `run_status:${runId}`);
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
    const cacheKey = `usage_stats:${workspaceId}:${groupBy ?? 'model'}`;
    return wrapToolCall('rorca_usage_stats', async () => {
      const params = new URLSearchParams();
      params.set('workspace_id', workspaceId);
      params.set('group_by', groupBy ?? 'model');
      if (from) params.set('from', from);
      if (to) params.set('to', to);

      const res = await fetchWithRetry('rorca_usage_stats', () => timedFetch(`${RORCA_API}/api/analytics/usage?${params.toString()}`));
      if (!res.ok) return httpError('rorca_usage_stats', res);

      const data = await res.json() as {
        grouped: Array<{ group_key: string; total_input_tokens: number; total_output_tokens: number; total_cost_usd: number; count: number }>;
        totals: { total_input_tokens: number; total_output_tokens: number; total_cost_usd: number; total_records: number };
      };

      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, groupBy: groupBy ?? 'model', grouped: data.grouped, totals: data.totals }, null, 2) }] };
    }, cacheKey);
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
    return wrapToolCall('rorca_retry_story', async () => {
      const body: Record<string, unknown> = {};
      if (storyIds !== undefined) body.storyIds = storyIds;
      const res = await timedFetch(`${RORCA_API}/api/pipeline/runs/${runId}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) return httpError('rorca_retry_story', res);
      const data = await res.json() as {
        ok: boolean;
        queued?: boolean;
        jobId?: string;
        runId: number;
        queuePosition?: number;
        retriedStories?: Array<{ storyId: string; attempt: number }>;
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify({
        ok: true,
        queued: data.queued ?? false,
        jobId: data.jobId,
        runId: data.runId,
        queuePosition: data.queuePosition ?? 1,
        retriedStories: data.retriedStories ?? [],
      }, null, 2) }] };
    });
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
    const cacheKey = `list_runs:${workspaceId}`;
    return wrapToolCall('rorca_list_runs', async () => {
      const resolvedLimit = limit ?? 10;
      const res = await fetchWithRetry('rorca_list_runs', () => timedFetch(`${RORCA_API}/api/pipeline/runs?workspaceId=${encodeURIComponent(workspaceId)}&limit=${resolvedLimit}`));
      if (!res.ok) return httpError('rorca_list_runs', res);
      const payload = await res.json() as {
        runs?: Array<{ id: number; status: string; spec_path: string; branch_name: string | null; trigger_type: string | null; started_at: string; finished_at: string | null }>;
        items?: Array<{ id: number; status: string; spec_path: string; branch_name: string | null; trigger_type: string | null; started_at: string; finished_at: string | null }>;
      };
      const runs = payload.runs ?? payload.items ?? [];
      if (runs.length === 0) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, runs: [], message: `No pipeline runs found for workspace ${workspaceId}` }, null, 2) }] };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, runs }, null, 2) }] };
    }, cacheKey);
  }
);

// ─── MC-002: rorca_cancel_run ─────────────────────────────────────────────────

server.registerTool(
  'rorca_cancel_run',
  {
    description: 'Cancel an active pipeline run. Sends SIGTERM to the process, waits 5s, then SIGKILL. Marks run as cancelled in database. Safe to call even if process already exited — idempotent cancel.',
    inputSchema: {
      run_id: z.number().int().positive().describe('Pipeline run ID to cancel — use rorca_list_runs to find active run IDs. To find active run IDs: use rorca_list_runs and look for status: running. To cancel the run started by rorca_forge_and_run, use the run_id from its response.'),
    },
  },
  async ({ run_id }) => {
    // Helper: fetch story counts for this run
    const fetchStoryCounts = async (): Promise<{ stories_completed: number; stories_remaining: number }> => {
      try {
        const r = await fetch(`${RORCA_API}/api/pipeline/runs/${run_id}`);
        if (!r.ok) return { stories_completed: 0, stories_remaining: 0 };
        const d = await r.json() as {
          run?: { status?: string };
          stories?: Array<{ status: string }>;
          specStories?: Array<unknown>;
        };
        const stories = d.stories ?? [];
        const specTotal = d.specStories?.length ?? stories.length;
        const completed = stories.filter(s => s.status === 'pass' || s.status === 'skip').length;
        return {
          stories_completed: completed,
          stories_remaining: Math.max(0, specTotal - completed),
        };
      } catch {
        return { stories_completed: 0, stories_remaining: 0 };
      }
    };

    // Helper: poll until status is 'cancelled' or 2s elapsed
    const waitForCancelled = async (): Promise<void> => {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        try {
          const r = await fetch(`${RORCA_API}/api/pipeline/runs/${run_id}`);
          if (r.ok) {
            const d = await r.json() as { run?: { status?: string } };
            if (d.run?.status === 'cancelled') return;
          }
        } catch { /* ignore */ }
        await new Promise(res => setTimeout(res, 200));
      }
    };

    let cancelRes: Response;
    try {
      cancelRes = await timedFetch(`${RORCA_API}/api/pipeline/runs/${run_id}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (fetchErr: unknown) {
      const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      console.error('[rorca-mcp]', 'rorca_cancel_run', msg);
      if ((fetchErr as NodeJS.ErrnoException & { isTimeout?: boolean }).isTimeout) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, tool: 'rorca_cancel_run', timestamp: new Date().toISOString(), error: 'Tool call timed out after 30 seconds. The Rorca server is running but may be slow. Try again.', category: 'timeout' }, null, 2) }],
          isError: true,
        };
      }
      if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, tool: 'rorca_cancel_run', timestamp: new Date().toISOString(), error: 'Rorca server is offline', offline: true, suggestion: 'Start the server: rorca start', category: 'offline' }, null, 2) }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, tool: 'rorca_cancel_run', timestamp: new Date().toISOString(), error: `Network error: ${msg}` }, null, 2) }],
        isError: true,
      };
    }

    if (cancelRes.status === 404) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: `Run #${run_id} not found`, suggestion: 'Use rorca_list_runs to see recent run IDs' }, null, 2) }],
        isError: true,
      };
    }

    if (cancelRes.status === 409) {
      // Run is already in terminal state — not an error, just informational
      let bodyText = '';
      try { bodyText = await cancelRes.text(); } catch { /* ignore */ }
      // Parse existing status from error message (e.g. "Cannot cancel run with status 'completed'")
      const statusMatch = bodyText.match(/status '([^']+)'/);
      const existingStatus = statusMatch?.[1] ?? 'terminal';

      // Special case: already-cancelled is idempotent OK
      if (existingStatus === 'cancelled') {
        const counts = await fetchStoryCounts();
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            ok: true,
            already_cancelled: true,
            run_id,
            message: `Run #${run_id} was already cancelled`,
            ...counts,
          }, null, 2) }],
        };
      }

      const counts = await fetchStoryCounts();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          ok: false,
          already_terminal: true,
          run_id,
          status: existingStatus,
          message: `Run #${run_id} is already ${existingStatus} — no action taken`,
          ...counts,
        }, null, 2) }],
      };
    }

    if (!cancelRes.ok) {
      let bodyText = '';
      try { bodyText = await cancelRes.text(); } catch { /* ignore */ }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: `Cancel request failed: ${cancelRes.status} ${bodyText.slice(0, 200)}` }, null, 2) }],
        isError: true,
      };
    }

    // Cancel succeeded — wait up to 2s for DB to reflect 'cancelled'
    await waitForCancelled();

    const counts = await fetchStoryCounts();
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({
        ok: true,
        run_id,
        status: 'cancelled',
        message: `Run #${run_id} cancelled`,
        ...counts,
      }, null, 2) }],
    };
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
    return wrapToolCall('rorca_edit_story', async () => {
      const body: Record<string, unknown> = { workspaceId };
      if (title !== undefined) body.title = title;
      if (description !== undefined) body.description = description;
      if (acceptanceCriteria !== undefined) body.acceptanceCriteria = acceptanceCriteria;
      const res = await timedFetch(`${RORCA_API}/api/specs/${specId}/stories/${storyId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) return httpError('rorca_edit_story', res);
      const data = await res.json() as { ok: boolean; story: Record<string, unknown>; version: number };
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, specId, storyId, version: data.version, story: data.story }, null, 2) }] };
    });
  }
);

server.registerTool(
  'rorca_edit_spec',
  {
    description: 'Update spec-level metadata (model, title, or notes) for an existing spec. The spec can be in pending or approved status. Use rorca_list_specs to find the spec ID. Only fields that are provided will be updated — omitted fields are left unchanged.',
    inputSchema: {
      workspaceId: z.string().describe('Rorca workspace ID'),
      specId: z.string().describe('Spec ID (filename slug, e.g. "my-feature-spec")'),
      model: z.string().optional().describe('New model for the spec (e.g. "claude-opus-4-6")'),
      title: z.string().optional().describe('New human-readable title for the spec'),
      notes: z.string().optional().describe('New notes / brief for the spec'),
    },
  },
  async ({ workspaceId, specId, model, title, notes }) => {
    return wrapToolCall('rorca_edit_spec', async () => {
      const body: Record<string, unknown> = { workspaceId };
      if (model !== undefined) body.model = model;
      if (title !== undefined) body.title = title;
      if (notes !== undefined) body.notes = notes;
      const res = await timedFetch(`${RORCA_API}/api/specs/${specId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) return httpError('rorca_edit_spec', res);
      const data = await res.json() as { ok: boolean; id: string; title: string; model: string; storyCount: number };
      return { content: [{ type: 'text' as const, text: `Updated spec "${data.id}": title="${data.title}", model=${data.model}, stories=${data.storyCount}` }] };
    });
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
    return wrapToolCall('rorca_search_stories', async () => {
      const res = await fetchWithRetry('rorca_search_stories', () => timedFetch(`${RORCA_API}/api/specs/search/stories?workspaceId=${encodeURIComponent(workspaceId)}&q=${encodeURIComponent(query)}`));
      if (!res.ok) return httpError('rorca_search_stories', res);
      const data = await res.json() as { query: string; resultCount: number; results: Array<{ specId: string; status: string; story: { id: string; title: string; acceptanceCriteria: string[] }; matchFields: string[] }> };
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, query, resultCount: data.resultCount, results: data.results }, null, 2) }] };
    }, `search_stories:${workspaceId}:${query}`);
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
    return wrapToolCall('rorca_add_stories', async () => {
      const body: Record<string, unknown> = { workspaceId, count: count ?? 3 };
      if (brief !== undefined) body.brief = brief;
      const res = await timedFetch(`${RORCA_API}/api/specs/${specId}/add-stories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, 0); // unbounded — LLM call can be long
      if (!res.ok) return httpError('rorca_add_stories', res);
      const data = await res.json() as { added: number; totalStories: number; newStories: Array<{ id: string; title: string }> };
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, specId, added: data.added, totalStories: data.totalStories, newStories: data.newStories }, null, 2) }] };
    });
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
    return wrapToolCall('rorca_delete_story', async () => {
      const res = await timedFetch(`${RORCA_API}/api/specs/${specId}/stories/${storyId}?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      if (!res.ok) return httpError('rorca_delete_story', res);
      const data = await res.json() as { ok: boolean; deletedStory: { id: string; title: string }; version: number; remainingCount: number };
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, specId, storyId, deletedStory: data.deletedStory, version: data.version, remainingCount: data.remainingCount }, null, 2) }] };
    });
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
    return wrapToolCall('rorca_get_direction', async () => {
      const res = await fetchWithRetry('rorca_get_direction', () => timedFetch(`${RORCA_API}/api/direction/all?workspaceId=${encodeURIComponent(workspaceId)}`));
      if (!res.ok) return httpError('rorca_get_direction', res);
      const data = await res.json() as {
        layers: { l1: { content: string | null }; l2: { content: string | null }; l3: { content: string | null; preferredModel: string | null }; l4: { note: string }; l5: { note: string } };
        teamL1: string | null; teamL2: string | null;
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, workspaceId, layers: data.layers, teamL1: data.teamL1, teamL2: data.teamL2 }, null, 2) }] };
    }, `get_direction:${workspaceId}`);
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
    return wrapToolCall('rorca_update_direction', async () => {
      const body: Record<string, unknown> = { layer, contentYaml };
      if (layer >= 2) body.workspaceId = workspaceId;
      if (domain !== undefined) body.domain = domain;
      if (preferredModel !== undefined) body.preferredModel = preferredModel;
      const res = await timedFetch(`${RORCA_API}/api/direction`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) return httpError('rorca_update_direction', res);
      const layerNames: Record<number, string> = { 1: 'Global Brain', 2: 'Domain Profile', 3: 'Project Brief' };
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, layer, layerName: layerNames[layer], workspaceId, preferredModel: preferredModel ?? null, message: 'Direction layer updated. Changes take effect immediately in subsequent spec generations.' }, null, 2) }] };
    });
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
    return wrapToolCall('rorca_synthesize_direction', async () => {
      const res = await fetchWithRetry('rorca_synthesize_direction', () => timedFetch(`${RORCA_API}/api/direction/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, l4SpecBrief: specBrief ?? '', l5Annotations: storyAnnotations }),
      }));
      if (!res.ok) return httpError('rorca_synthesize_direction', res);
      const { synthesized } = await res.json() as { synthesized: string };
      return { content: [{ type: 'text' as const, text: synthesized }] };
    }, `synthesize_direction:${workspaceId}`);
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
    return wrapToolCall('rorca_list_workspaces', async () => {
      const res = await fetchWithRetry('rorca_list_workspaces', () => timedFetch(`${RORCA_API}/api/workspaces`));
      if (!res.ok) return httpError('rorca_list_workspaces', res);
      const data = await res.json() as { items?: Array<{ id: string; label: string; path: string; domains: string[] }>; workspaces?: Array<{ id: string; label: string; path: string; domains: string[] }> };
      const workspaces = data.items ?? data.workspaces ?? [];
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, workspaces }, null, 2) }] };
    }, 'list_workspaces');
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
    return wrapToolCall('rorca_create_workspace', async () => {
      const resolvedLabel = label ?? wsPath.split('/').pop() ?? id;
      const resolvedDomains = domains ?? [];
      const res = await timedFetch(`${RORCA_API}/api/workspaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, label: resolvedLabel, path: wsPath, domains: resolvedDomains }),
      });
      if (!res.ok) return httpError('rorca_create_workspace', res);
      const data = await res.json() as { workspace: { id: string; label: string; path: string; domains: string[] } };
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, workspace: data.workspace }, null, 2) }] };
    });
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
    return wrapToolCall('rorca_workspace_stats', async () => {
      const res = await fetchWithRetry('rorca_workspace_stats', () => timedFetch(`${RORCA_API}/api/workspaces/${encodeURIComponent(workspaceId)}/stats`));
      if (!res.ok) return httpError('rorca_workspace_stats', res);
      const data = await res.json() as { workspaceId: string; specs: { pending: number; approved: number; total: number }; runs: { total: number; active: number; completed: number; failed: number; lastRunAt: string | null }; stories: { total: number; passed: number; failed: number; passRate: number }; lastActivity: string | null };
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, ...data }, null, 2) }] };
    }, `workspace_stats:${workspaceId}`);
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
    return wrapToolCall('rorca_team_members', async () => {
      const res = await fetchWithRetry('rorca_team_members', () => timedFetch(`${RORCA_API}/api/workspaces/${encodeURIComponent(workspaceId)}/team-members`));
      if (!res.ok) return httpError('rorca_team_members', res);
      const data = await res.json() as { teamScoped: boolean; team: { id: string; name: string; slug: string; permission: string } | null; members: Array<{ userId: string; email: string; displayName: string; role: string; joinedAt: string; acceptedAt: string | null; lastActiveAt: string | null }> };
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, workspaceId, teamScoped: data.teamScoped, team: data.team, members: data.members }, null, 2) }] };
    }, `team_members:${workspaceId}`);
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
    return wrapToolCall('rorca_save_memory', async () => {
      const body: Record<string, string> = { workspaceId, category, title, rule };
      if (context !== undefined) body.context = context;
      if (source !== undefined) body.source = source;

      const res = await timedFetch(`${RORCA_API}/api/memory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) return httpError('rorca_save_memory', res);

      const data = await res.json() as { entry: { date: string; category: string; title: string; rule: string }; total: number };
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ ok: true, workspaceId, entry: data.entry, total: data.total, note: 'Memory will be injected into future spec generations and story executions.' }, null, 2),
        }]
      };
    });
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
    return wrapToolCall('rorca_log_decision', async () => {
      const rule = alternatives
        ? `${decision}\n\nAlternatives considered: ${alternatives}`
        : decision;

      const res = await timedFetch(`${RORCA_API}/api/memory`, {
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

      if (!res.ok) return httpError('rorca_log_decision', res);

      const data = await res.json() as { entry: { date: string; title: string; rule: string }; total: number };
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ ok: true, workspaceId, entry: data.entry, total: data.total }, null, 2),
        }]
      };
    });
  }
);

server.registerTool(
  'rorca_recall_memories',
  {
    description: `Semantic memory retrieval — USE THIS when asking "what do we know about X?" or "find memories related to Y".

Three modes:
1. **Semantic** (currentTask provided): USE THIS FOR SEARCH. Triggers CAG → RAG → Knowledge Graph cascade. Returns top 30 memories ranked by semantic relevance to your task description. Example: currentTask="deploying to Hetzner" finds deployment, infrastructure, and hosting memories even if they don't contain the exact word "Hetzner".
2. **Recent** (default): Returns last N memories (default 100), pinned-first then newest. Use for browsing or "show me recent memories".
3. **Full dump** (fetchAll: true): Returns ALL memories — use only for audits or exports.

DO NOT use for paginated listing with filters — use rorca_memory_items instead.`,
    inputSchema: {
      workspaceId: z.string().describe('Rorca workspace ID'),
      category: z.enum(['Architecture', 'Convention', 'Bug Fix', 'Decision', 'Pattern', 'Gotcha']).optional().describe('Filter by category. If omitted, returns memories across all categories.'),
      limit: z.number().min(1).max(500).optional().default(100).describe('Maximum entries to return (default 100). Ignored when fetchAll is true.'),
      fetchAll: z.boolean().optional().default(false).describe('When true, returns ALL memories with no pagination limit. Overrides limit.'),
      currentTask: z.string().optional().describe('Description of the current task — when provided, triggers semantic retrieval (CAG → RAG → Knowledge Graph) and returns the most relevant memories ranked by score.'),
      titlesOnly: z.boolean().optional().default(false).describe('Return memory titles only (strips full rule content) — ~2K tokens vs ~50K+ for full dump. Useful for getting a quick index before deciding which memories to load in full.'),
    },
  },
  async ({ workspaceId, category, limit, fetchAll, currentTask, titlesOnly }) => {
    const mode = fetchAll ? 'full' : currentTask ? 'semantic' : 'recent';
    const cacheKey = `recall_memories:${workspaceId}:${category ?? 'all'}:${mode}:${fetchAll ? 'all' : limit}`;
    return wrapToolCall('rorca_recall_memories', async () => {

      // ── Mode 3: Semantic retrieval via /api/recall (CAG → RAG → Graph) ──
      if (currentTask) {
        const params = new URLSearchParams({ workspaceId, storyText: currentTask });
        if (category) params.set('category', category);
        if (titlesOnly) params.set('titlesOnly', 'true');

        const res = await fetchWithRetry('rorca_recall_memories', () =>
          timedFetch(`${RORCA_API}/api/recall?${params.toString()}`)
        );
        if (!res.ok) return httpError('rorca_recall_memories', res);

        const data = await res.json() as {
          memories: Array<{ date: string; category: string; title: string; rule: string; context: string; source: string }>;
          meta: { retrievalTier: string; cagHits: number; ragHits: number; graphHits: number; totalTokens: number; latencyMs: number };
        };

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              workspaceId,
              mode: 'semantic',
              retrievalTier: data.meta?.retrievalTier ?? 'unknown',
              cagHits: data.meta?.cagHits ?? 0,
              ragHits: data.meta?.ragHits ?? 0,
              graphHits: data.meta?.graphHits ?? 0,
              items: data.memories,
              total: data.memories.length,
            }, null, 2),
          }]
        };
      }

      // ── Mode 1 & 2: Full dump or Recent — use /api/memory/items (DB-backed) ──
      const params = new URLSearchParams({ workspaceId });
      if (category) params.set('category', category);

      const res = await fetchWithRetry('rorca_recall_memories', () =>
        timedFetch(`${RORCA_API}/api/memory/items?${params.toString()}`)
      );
      if (!res.ok) return httpError('rorca_recall_memories', res);

      const data = await res.json() as {
        items: Array<{
          id: number;
          category: string;
          content: string;
          sourceStoryId: string | null;
          sourceRunId: number | null;
          confidence: string;
          pinned: boolean;
          sourceType: string;
          createdAt: string;
        }>;
        total: number;
      };

      // Map DB items to the ledger format consumers expect
      const mapped = data.items.map(item => {
        const lines = item.content.split('\n');
        const title = (lines[0] || '').replace(/^#+\s*/, '').slice(0, 100);
        return {
          date: new Date(item.createdAt).toISOString().slice(0, 10),
          category: item.category,
          title,
          rule: titlesOnly ? '' : item.content,
          context: '',
          source: item.sourceStoryId || '',
          lineNumber: item.id,
          sourceType: item.sourceType,
        };
      });

      // Apply limit (fetchAll = no limit, otherwise use limit param)
      const limited = fetchAll ? mapped : mapped.slice(0, limit ?? 100);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            workspaceId,
            mode: fetchAll ? 'full' : 'recent',
            category: category ?? null,
            items: limited,
            total: data.total,
          }, null, 2),
        }]
      };
    }, cacheKey);
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
  'cancel_run',
  {
    title: 'Cancel Run',
    description: 'Cancel an active pipeline run by ID. Safe to call even if process already exited.',
    argsSchema: {
      runId: z.string().describe('Pipeline run ID (e.g. 42)'),
    },
  },
  async ({ runId }) => {
    const id = parseInt(runId, 10);
    if (isNaN(id)) {
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Invalid run ID: "${runId}". Must be a number.` } }] };
    }

    let cancelRes: Response;
    try {
      cancelRes = await fetch(`${RORCA_API}/api/pipeline/runs/${id}/cancel`, { method: 'POST' });
    } catch (fetchErr: unknown) {
      const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
        return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Cannot connect to Rorca server. Run: rorca start` } }] };
      }
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Network error: ${msg}` } }] };
    }

    if (cancelRes.status === 404) {
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Run #${id} not found. Use /mcp__rorca__list_runs to see recent run IDs.` } }] };
    }

    if (cancelRes.status === 409) {
      let bodyText = '';
      try { bodyText = await cancelRes.text(); } catch { /* ignore */ }
      const statusMatch = bodyText.match(/status '([^']+)'/);
      const existingStatus = statusMatch?.[1] ?? 'terminal';
      if (existingStatus === 'cancelled') {
        return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Run #${id} was already cancelled.` } }] };
      }
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Run #${id} is already ${existingStatus} — no action taken.` } }] };
    }

    if (!cancelRes.ok) {
      let bodyText = '';
      try { bodyText = await cancelRes.text(); } catch { /* ignore */ }
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Cancel failed (${cancelRes.status}): ${bodyText.slice(0, 200)}` } }] };
    }

    return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `🛑 Run #${id} cancelled.\n\nCheck status with: /mcp__rorca__run_status ${id}` } }] };
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

server.registerPrompt(
  'edit_spec',
  {
    title: 'Edit Spec',
    description: 'Update spec-level metadata (model, title, or notes). Only provided fields are updated.',
    argsSchema: {
      specId: z.string().describe('Spec ID slug (e.g. rorca-feature-enhancements)'),
      workspaceId: z.string().optional().describe(`Workspace ID (default: ${DEFAULT_WORKSPACE})`),
      model: z.string().optional().describe('New model (e.g. claude-opus-4-6)'),
      title: z.string().optional().describe('New human-readable title'),
      notes: z.string().optional().describe('New notes / brief for the spec'),
    },
  },
  async ({ specId, workspaceId, model, title, notes }) => {
    const ws = workspaceId ?? DEFAULT_WORKSPACE;
    const body: Record<string, unknown> = { workspaceId: ws };
    if (model !== undefined) body.model = model;
    if (title !== undefined) body.title = title;
    if (notes !== undefined) body.notes = notes;
    const res = await fetch(`${RORCA_API}/api/specs/${specId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Failed to update spec "${specId}" (${res.status}): ${await res.text()}` } }] };
    }
    const data = await res.json() as { ok: boolean; id: string; title: string; model: string; storyCount: number };
    return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `✅ Spec "${data.id}" updated:\n  title: ${data.title}\n  model: ${data.model}\n  stories: ${data.storyCount}` } }] };
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

server.registerTool(
  'rorca_fix_spec',
  {
    description: 'Apply automated structural fixes to a spec: reindex story IDs to sequential US-001..US-N (updating dependsOn refs), add missing passes:false fields, normalize dependsOn to array, remove duplicate IDs. Never modifies title, description, or acceptanceCriteria text.',
    inputSchema: {
      specId: z.string().describe('Spec slug (e.g. "rorca-feature-enhancements") — filename without .json'),
      workspaceId: z.string().optional().describe(`Workspace ID (default: ${DEFAULT_WORKSPACE})`),
    },
  },
  async ({ specId, workspaceId }) => {
    const ws = workspaceId ?? DEFAULT_WORKSPACE;
    const res = await fetch(`${RORCA_API}/api/specs/${encodeURIComponent(specId)}/fix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: ws }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Spec fix failed (${res.status}): ${err}`);
    }
    const data = await res.json() as {
      fixed: boolean;
      changes: Array<{ type: string; storyId: string; description: string }>;
    };
    const lines: string[] = [
      `Spec: ${specId}`,
      `Fixed: ${data.fixed ? '✅ yes' : '⬜ no changes needed'}`,
      '',
    ];
    if (data.changes.length === 0) {
      lines.push('No structural issues found.');
    } else {
      const byType: Record<string, typeof data.changes> = {};
      for (const c of data.changes) {
        (byType[c.type] ??= []).push(c);
      }
      const typeLabels: Record<string, string> = {
        reindex: 'Reindexed IDs',
        add_passes: 'Added passes field',
        normalize_depends: 'Normalized dependsOn',
        remove_duplicate: 'Removed duplicates',
      };
      for (const [type, items] of Object.entries(byType)) {
        lines.push(`${typeLabels[type] ?? type} (${items.length}):`);
        for (const item of items) {
          lines.push(`  • [${item.storyId}] ${item.description}`);
        }
      }
    }
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
);

server.registerPrompt(
  'fix_spec',
  {
    title: 'Fix Spec',
    description: 'Apply automated structural fixes to a spec (reindex IDs, add passes field, normalize dependsOn, remove duplicates). Never modifies acceptance criteria text.',
    argsSchema: {
      specId: z.string().describe('Spec slug (e.g. "rorca-feature-enhancements") — filename without .json'),
      workspaceId: z.string().optional().describe(`Workspace ID (default: ${DEFAULT_WORKSPACE})`),
    },
  },
  async ({ specId, workspaceId }) => {
    const ws = workspaceId ?? DEFAULT_WORKSPACE;
    const res = await fetch(`${RORCA_API}/api/specs/${encodeURIComponent(specId)}/fix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: ws }),
    });
    if (!res.ok) {
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Spec fix failed (${res.status}): ${await res.text()}` } }] };
    }
    const data = await res.json() as {
      fixed: boolean;
      changes: Array<{ type: string; storyId: string; description: string }>;
    };
    const lines: string[] = [
      `Spec: ${specId}`,
      `Fixed: ${data.fixed ? '✅ yes' : '⬜ no changes needed'}`,
      '',
    ];
    if (data.changes.length === 0) {
      lines.push('No structural issues found.');
    } else {
      for (const c of data.changes) {
        lines.push(`• [${c.type}] [${c.storyId}] ${c.description}`);
      }
    }
    return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: lines.join('\n') } }] };
  },
);

server.registerTool(
  'rorca_queue_run',
  {
    description: 'Smart run trigger — start a pipeline run immediately if no active run exists, or queue it if one is already running. Accepts workspaceId + specId (slug) for convenience. Returns { queued, runId/queuePosition, activeRunId, message }.',
    inputSchema: {
      workspaceId: z.string().describe('Rorca workspace ID'),
      specId: z.string().describe('Spec slug (filename without .json, e.g. rorca-curated-skills-library)'),
    },
  },
  async ({ workspaceId, specId }) => {
    const res = await fetch(`${RORCA_API}/api/pipeline/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, specId }),
    });

    const data = await res.json() as Record<string, unknown>;

    if (!res.ok) {
      throw new Error(`Queue run failed (${res.status}): ${data.error ?? JSON.stringify(data)}`);
    }

    if (data.queued) {
      return {
        content: [{
          type: 'text' as const,
          text: `Run queued for spec "${specId}" (position ${data.queuePosition}).\nActive run: #${data.activeRunId}\n\nUse rorca_run_status to monitor the active run.`,
        }],
      };
    }

    return {
      content: [{
        type: 'text' as const,
        text: `Pipeline run #${data.runId} started immediately for spec "${specId}".\n\nTrack progress with: rorca_run_status runId=${data.runId}`,
      }],
    };
  }
);

server.registerPrompt(
  'queue_run',
  {
    title: 'Queue Pipeline Run',
    description: 'Smart run trigger — starts immediately if no active run, or queues if one is running. Accepts specId (slug) and optional workspaceId.',
    argsSchema: {
      specId: z.string().describe('Spec slug (e.g. rorca-curated-skills-library)'),
      workspaceId: z.string().optional().describe(`Workspace ID (default: ${DEFAULT_WORKSPACE})`),
    },
  },
  async ({ specId, workspaceId }) => {
    const ws = workspaceId ?? DEFAULT_WORKSPACE;
    const res = await fetch(`${RORCA_API}/api/pipeline/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: ws, specId }),
    });
    const data = await res.json() as Record<string, unknown>;
    if (!res.ok) {
      return {
        messages: [{
          role: 'user' as const,
          content: { type: 'text' as const, text: `Queue run failed (${res.status}): ${data.error ?? JSON.stringify(data)}` },
        }],
      };
    }
    if (data.queued) {
      return {
        messages: [{
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `⏳ Run queued for spec "${specId}" (position ${data.queuePosition}).\nActive run: #${data.activeRunId}\n\nTrack active run: /mcp__rorca__run_status ${data.activeRunId}`,
          },
        }],
      };
    }
    return {
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `🚀 Pipeline run #${data.runId} started immediately!\nSpec: ${specId}\nWorkspace: ${ws}\n\nTrack progress: /mcp__rorca__run_status ${data.runId}`,
        },
      }],
    };
  },
);

// ─── MC-001: rorca_forge_and_run — One-shot: brief → spec → approve → run ─────

/** Error categories from specs.ts (mirror, no import needed in stdio server) */
type SpecErrorCategory =
  | 'model_error'
  | 'api_key_error'
  | 'rate_limit'
  | 'context_too_large'
  | 'timeout'
  | 'parse_error'
  | 'network_error'
  | 'unknown';

/** Maps numeric progress token → MCP notification sender. */
type ProgressNotifier = (progress: number, total: number, message: string) => void;

function makeProgressNotifier(server: McpServer, progressToken: string | number | undefined): ProgressNotifier {
  return (progress, total, message) => {
    if (progressToken == null) return;
    server.server.notification({
      method: 'notifications/progress',
      params: { progressToken, progress, total, message },
    });
  };
}

/** Classify a fetch response / error into a SpecErrorCategory. */
function classifySpecError(status: number, body: string): SpecErrorCategory {
  const lower = body.toLowerCase();
  if (status === 401 || status === 403 || lower.includes('api key') || lower.includes('unauthorized')) return 'api_key_error';
  if (status === 429 || lower.includes('rate limit') || lower.includes('overloaded') || lower.includes('throttl')) return 'rate_limit';
  if (lower.includes('context') && (lower.includes('exceed') || lower.includes('too large'))) return 'context_too_large';
  if (status === 408 || status === 504 || lower.includes('timeout')) return 'timeout';
  if (lower.includes('json') || lower.includes('parse') || lower.includes('invalid json')) return 'parse_error';
  if (lower.includes('econnrefused') || lower.includes('network') || lower.includes('enotfound')) return 'network_error';
  if (status >= 500 && lower.includes('model')) return 'model_error';
  return 'unknown';
}

/** Return the user-facing suggestion for a SpecErrorCategory. */
function specErrorSuggestion(cat: SpecErrorCategory): string {
  switch (cat) {
    case 'api_key_error': return 'Check your API key in Rorca Settings > API Keys or run rorca_update_direction to verify your configuration';
    case 'rate_limit':    return 'Rate limit reached. Try again in 60 seconds or switch to a different model using the spec_model parameter';
    case 'context_too_large': return 'Brief or direction stack too long. Shorten the brief or reduce L1/L2 direction layers via rorca_update_direction';
    case 'parse_error':   return 'The model returned invalid JSON. Try spec_model: claude-sonnet-4-5-20250929 which has reliable JSON output';
    case 'timeout':       return 'Spec generation timed out. Try a shorter brief or a faster model.';
    case 'model_error':   return 'Check the model name in Rorca Settings or use the default by omitting the spec_model parameter';
    case 'network_error': return 'Check your internet connection and API provider status. The brief has NOT been processed.';
    default:              return 'An unexpected error occurred during spec generation. Try again.';
  }
}

/** Generate spec with one automatic retry on parse_error. Returns the spec JSON or throws an error result object. */
async function generateSpecWithRetry(
  workspaceId: string,
  brief: string,
  model: string | undefined,
  specModel: string | undefined,
): Promise<{ spec: Record<string, unknown>; specId: string; storyCount: number }> {
  const slugTitle = `forge-${Date.now()}`;
  const body: Record<string, unknown> = {
    workspaceId,
    specBrief: brief,
    title: slugTitle,
    storyCount: 8,
    includeDiagrams: false,
    ...(specModel ? { model: specModel } : model ? { model } : {}),
  };

  let lastCategory: SpecErrorCategory = 'unknown';
  let lastErrText = '';

  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${RORCA_API}/api/specs/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (networkErr: unknown) {
      const msg = networkErr instanceof Error ? networkErr.message : String(networkErr);
      if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
        throw { phase: 'spec_generation', connRefused: true, error: msg };
      }
      throw { phase: 'spec_generation', category: 'network_error' as SpecErrorCategory, error: msg };
    }

    const rawText = await res.text();
    if (!res.ok) {
      lastCategory = classifySpecError(res.status, rawText);
      lastErrText = rawText.slice(0, 200);
      // Only retry on parse_error on first attempt
      if (lastCategory === 'parse_error' && attempt === 0) continue;
      throw { phase: 'spec_generation', category: lastCategory, error: rawText.slice(0, 300) };
    }

    let spec: Record<string, unknown>;
    try {
      spec = JSON.parse(rawText);
    } catch {
      lastCategory = 'parse_error';
      lastErrText = rawText.slice(0, 200);
      if (attempt === 0) continue; // retry once
      throw { phase: 'spec_generation', category: 'parse_error' as SpecErrorCategory, error: 'Invalid JSON from spec generation' };
    }

    const stories = Array.isArray(spec.userStories) ? spec.userStories : [];
    const specId = (spec.id ?? spec.title ?? slugTitle) as string;
    return { spec, specId, storyCount: stories.length };
  }

  // Exhausted retries
  throw { phase: 'spec_generation', category: lastCategory, error: lastErrText || 'Spec generation failed after retry' };
}

/** Poll GET /api/pipeline/runs/:runId every intervalMs until status is terminal or timeout. */
async function pollRunUntilDone(
  runId: number,
  timeoutMs: number,
  intervalMs: number,
  onStory: (story: { id: string; title: string; status: string; elapsed_seconds: number; retries: number }) => void,
): Promise<{
  status: string;
  stories: Array<{ id: string; title: string; status: string; elapsed_seconds: number; retries: number }>;
  branchName: string | null;
  worktreePath: string | null;
}> {
  const deadline = Date.now() + timeoutMs;
  const seenStories = new Set<string>();

  while (Date.now() < deadline) {
    let res: Response;
    try {
      res = await fetch(`${RORCA_API}/api/pipeline/runs/${runId}`);
    } catch (fetchErr: unknown) {
      const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
        throw { phase: 'monitoring', connRefused: true, runId, error: msg };
      }
      // Non-fatal network blip — wait and retry
      await new Promise(r => setTimeout(r, intervalMs));
      continue;
    }

    if (!res.ok) {
      await new Promise(r => setTimeout(r, intervalMs));
      continue;
    }

    const data = await res.json() as {
      run: { status: string; worktree_branch?: string; worktree_path?: string };
      stories: Array<{ story_id: string; status: string; started_at?: string; finished_at?: string; retries?: number }>;
      specStories: Array<{ id: string; title: string }>;
    };

    // Emit per-story progress for newly completed stories
    const storyTitleMap = new Map<string, string>(
      (data.specStories ?? []).map(s => [s.id, s.title] as [string, string])
    );
    for (const sr of (data.stories ?? [])) {
      const storyKey = `${sr.story_id}:${sr.status}`;
      if (!seenStories.has(storyKey) && ['pass', 'fail', 'skip'].includes(sr.status)) {
        seenStories.add(storyKey);
        const elapsedS = sr.started_at && sr.finished_at
          ? Math.round((new Date(sr.finished_at).getTime() - new Date(sr.started_at).getTime()) / 1000)
          : 0;
        onStory({
          id: sr.story_id,
          title: storyTitleMap.get(sr.story_id) ?? sr.story_id,
          status: sr.status === 'pass' ? 'passed' : sr.status === 'fail' ? 'failed' : 'skipped',
          elapsed_seconds: elapsedS,
          retries: sr.retries ?? 0,
        });
      }
    }

    const runStatus = data.run?.status ?? '';
    if (['completed', 'failed', 'cancelled'].includes(runStatus)) {
      // Build final story list
      const finalStories = (data.stories ?? []).map(sr => {
        const elapsedS = sr.started_at && sr.finished_at
          ? Math.round((new Date(sr.finished_at).getTime() - new Date(sr.started_at).getTime()) / 1000)
          : 0;
        return {
          id: sr.story_id,
          title: storyTitleMap.get(sr.story_id) ?? sr.story_id,
          status: sr.status === 'pass' ? 'passed' : sr.status === 'fail' ? 'failed' : 'skipped',
          elapsed_seconds: elapsedS,
          retries: sr.retries ?? 0,
        };
      });

      return {
        status: runStatus,
        stories: finalStories,
        branchName: data.run?.worktree_branch ?? null,
        worktreePath: data.run?.worktree_path ?? null,
      };
    }

    await new Promise(r => setTimeout(r, intervalMs));
  }

  // Timed out
  throw { phase: 'timeout', runId };
}

server.registerTool(
  'rorca_forge_and_run',
  {
    description: '[Specs & Pipeline] One-shot: brief → spec → approve → run → completion. Handles the full pipeline end-to-end. Returns structured results when done. Use for: I have an idea, build it. NOT for: monitoring existing runs (use rorca_run_status) or retrying failed stories (use rorca_retry_story). The auto_worktree parameter (default: true) runs in a new branch feat/<spec-slug>-<timestamp> — safe for parallel execution. When false, runs in the current working directory of the workspace — faster but blocks same-workspace parallel runs. This is a long-running tool call that blocks until complete (up to timeout_minutes).',
    inputSchema: {
      brief: z.string().min(10).describe('Plain-English description of what to build'),
      workspace_id: z.string().describe('Workspace ID from rorca_list_workspaces'),
      model: z.string().optional().describe('Execution model override'),
      spec_model: z.string().optional().describe('Spec generation model override'),
      auto_worktree: z.boolean().optional().default(true).describe('Run in isolated git worktree (default: true). When true, pipeline runs in a new branch feat/<spec-slug>-<timestamp> — safe for parallel execution. When false, runs in the current working directory of the workspace — faster but blocks same-workspace parallel runs.'),
      timeout_minutes: z.number().optional().default(90).describe('Max runtime in minutes (1-480)'),
    },
  },
  async ({ brief, workspace_id, model, spec_model, auto_worktree, timeout_minutes }, extra) => {
    const startTime = Date.now();
    const resolvedAutoWorktree = auto_worktree ?? true;
    const resolvedTimeoutMinutes = timeout_minutes ?? 90;

    // ── Progress notification helper ─────────────────────────────────────────
    const progressToken = (extra as Record<string, unknown> & { _meta?: { progressToken?: string | number } })?._meta?.progressToken;
    const notify = makeProgressNotifier(server, progressToken);

    // Helper to return an error result (isError: true, not a protocol-level throw)
    const errorResult = (payload: Record<string, unknown>) => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, ...payload }, null, 2) }],
      isError: true,
    });

    // ── Input validation ─────────────────────────────────────────────────────
    if (!brief || brief.trim().length < 10) {
      return errorResult({ phase: 'validation', error: 'Brief is too short (minimum 10 characters)', suggestion: 'Provide a detailed description of what to build' });
    }
    if (resolvedTimeoutMinutes < 1 || resolvedTimeoutMinutes > 480) {
      return errorResult({ phase: 'validation', error: 'timeout_minutes must be between 1 and 480' });
    }

    // Validate model if provided (check against backend)
    if (model) {
      // Quick check — allow any provider/model format for execution engines like
      // OpenCode. For bare Claude IDs, validate against the canonical Anthropic
      // registry instead of a duplicated hardcoded allowlist.
      const CLAUDE_MODELS = new Set([
        ...ALL_MODELS
          .filter(m => m.providerType === 'anthropic')
          .map(m => m.id),
        // Back-compat dated IDs still accepted in specs / tests.
        'claude-sonnet-4-5-20250929',
      ]);
      if (!model.includes('/') && !CLAUDE_MODELS.has(model)) {
        return errorResult({
          phase: 'validation',
          error: `Unsupported model: ${model}`,
          suggestion: 'Use rorca_list_specs or GET /api/direction/models to see supported models',
        });
      }
    }

    // Validate workspace_id
    let workspaceCheck: Response;
    try {
      workspaceCheck = await fetch(`${RORCA_API}/api/workspaces/${encodeURIComponent(workspace_id)}`);
    } catch (fetchErr: unknown) {
      const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
        return errorResult({
          phase: 'validation',
          error: 'Cannot connect to Rorca server at http://localhost:3030',
          suggestion: 'Run: rorca start — to launch the Rorca server',
        });
      }
      return errorResult({ phase: 'validation', error: `Network error during workspace validation: ${msg}` });
    }

    if (workspaceCheck.status === 404) {
      return errorResult({
        phase: 'validation',
        error: `Workspace not found: ${workspace_id}`,
        suggestion: 'Use rorca_list_workspaces to see available workspace IDs',
      });
    }
    if (!workspaceCheck.ok) {
      return errorResult({ phase: 'validation', error: `Failed to validate workspace (${workspaceCheck.status})` });
    }

    // ── Phase 1: Generate spec ───────────────────────────────────────────────
    notify(0, 5, 'Generating spec from brief...');

    let specId: string;
    let storyCount: number;

    try {
      const result = await generateSpecWithRetry(workspace_id, brief, model, spec_model);
      specId = result.specId;
      storyCount = result.storyCount;
    } catch (err: unknown) {
      const e = err as Record<string, unknown>;

      // ECONNREFUSED during spec generation
      if (e.connRefused) {
        return errorResult({
          phase: 'spec_generation',
          error: 'Cannot connect to Rorca server at http://localhost:3030',
          suggestion: 'Run: rorca start — to launch the Rorca server',
        });
      }

      const cat = (e.category ?? 'unknown') as SpecErrorCategory;
      const errPayload: Record<string, unknown> = {
        phase: 'spec_generation',
        category: cat,
        error: cat === 'network_error' ? 'LLM API network error' : String(e.error ?? 'Spec generation failed'),
        suggestion: specErrorSuggestion(cat),
      };
      if (cat === 'unknown') {
        errPayload.raw_error = String(e.error ?? '').slice(0, 200);
      }
      return errorResult(errPayload);
    }

    notify(1, 5, `Spec generated: ${storyCount} stories`);

    // ── Phase 2: Approve spec ────────────────────────────────────────────────
    let approveRes: Response;
    try {
      approveRes = await fetch(`${RORCA_API}/api/specs/${encodeURIComponent(specId)}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: workspace_id }),
      });
    } catch (fetchErr: unknown) {
      const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
        return errorResult({
          phase: 'approve',
          spec_id: specId,
          error: 'Cannot connect to Rorca server at http://localhost:3030',
          suggestion: 'Run: rorca start — to launch the Rorca server',
        });
      }
      return errorResult({ phase: 'approve', spec_id: specId, error: `Network error during approval: ${msg}` });
    }

    if (!approveRes.ok) {
      const detail = await approveRes.text().catch(() => '');
      return errorResult({
        phase: 'approve',
        spec_id: specId,
        error: 'Failed to approve spec',
        detail: detail.slice(0, 300),
      });
    }

    // ── Phase 3: Trigger pipeline run ────────────────────────────────────────
    notify(2, 5, 'Starting pipeline...');

    const triggerBody: Record<string, unknown> = {
      workspaceId: workspace_id,
      specPath: `forge/specs/approved/${specId}.json`,
      autoWorktree: resolvedAutoWorktree,
      ...(model ? { modelOverride: model } : {}),
    };

    let triggerRes: Response;
    try {
      triggerRes = await fetch(`${RORCA_API}/api/pipeline/trigger`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(triggerBody),
      });
    } catch (fetchErr: unknown) {
      const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
        return errorResult({
          phase: 'pipeline_trigger',
          spec_id: specId,
          error: 'Cannot connect to Rorca server at http://localhost:3030',
          suggestion: 'Run: rorca start — to launch the Rorca server',
        });
      }
      return errorResult({ phase: 'pipeline_trigger', spec_id: specId, error: `Network error during trigger: ${msg}` });
    }

    const triggerData = await triggerRes.json() as Record<string, unknown>;

    if (!triggerRes.ok) {
      return errorResult({
        phase: 'pipeline_trigger',
        spec_id: specId,
        error: String(triggerData.error ?? `Pipeline trigger failed (${triggerRes.status})`),
      });
    }

    // Conflict: another run is active for this workspace
    if (triggerData.conflict) {
      return errorResult({
        phase: 'pipeline_trigger',
        error: 'A run is already active for this workspace',
        active_run_id: triggerData.activeRunId,
        suggestion: 'Use rorca_cancel_run to stop the active run first, or wait for it to complete',
      });
    }

    // Worktree creation failed gracefully
    const worktreeFallback = !!(triggerData.worktreeFallback);
    const worktreeError = worktreeFallback ? String(triggerData.worktreeError ?? '') : undefined;

    const runId = triggerData.runId as number;
    notify(3, 5 + storyCount, `Pipeline started, run #${runId}`);

    // ── Phase 4: Monitor until done ──────────────────────────────────────────
    const timeoutMs = resolvedTimeoutMinutes * 60 * 1000;
    const pollIntervalMs = 15_000;
    let storyProgressCount = 0;

    let monitorResult: {
      status: string;
      stories: Array<{ id: string; title: string; status: string; elapsed_seconds: number; retries: number }>;
      branchName: string | null;
      worktreePath: string | null;
    };

    try {
      monitorResult = await pollRunUntilDone(
        runId,
        timeoutMs,
        pollIntervalMs,
        (story) => {
          storyProgressCount++;
          const icon = story.status === 'passed' ? '✓' : story.status === 'failed' ? '✗' : '—';
          notify(
            3 + storyProgressCount,
            5 + storyCount,
            `${icon} ${story.id} ${story.title} (${story.elapsed_seconds}s)`,
          );
        },
      );
    } catch (err: unknown) {
      const e = err as Record<string, unknown>;

      if (String(e.phase) === 'timeout') {
        // Try to cancel the run
        try {
          await fetch(`${RORCA_API}/api/pipeline/runs/${runId}/cancel`, { method: 'POST' });
        } catch { /* best-effort */ }

        // Get partial results
        let partialStories: Array<{ id: string; title: string; status: string; elapsed_seconds: number; retries: number }> = [];
        try {
          const partialRes = await fetch(`${RORCA_API}/api/pipeline/runs/${runId}`);
          if (partialRes.ok) {
            const pd = await partialRes.json() as {
              stories: Array<{ story_id: string; status: string; started_at?: string; finished_at?: string; retries?: number }>;
              specStories: Array<{ id: string; title: string }>;
            };
            const titleMap = new Map<string, string>((pd.specStories ?? []).map(s => [s.id, s.title] as [string, string]));
            partialStories = (pd.stories ?? []).map(sr => ({
              id: sr.story_id,
              title: titleMap.get(sr.story_id) ?? sr.story_id,
              status: sr.status === 'pass' ? 'passed' : sr.status === 'fail' ? 'failed' : 'skipped',
              elapsed_seconds: sr.started_at && sr.finished_at
                ? Math.round((new Date(sr.finished_at).getTime() - new Date(sr.started_at).getTime()) / 1000) : 0,
              retries: sr.retries ?? 0,
            }));
          }
        } catch { /* best-effort */ }

        const pPassed = partialStories.filter(s => s.status === 'passed').length;
        const pFailed = partialStories.filter(s => s.status === 'failed').length;
        const pSkipped = partialStories.filter(s => s.status === 'skipped').length;

        return errorResult({
          phase: 'timeout',
          run_id: runId,
          spec_id: specId,
          error: 'Run exceeded timeout_minutes limit',
          partial_results: { passed: pPassed, failed: pFailed, skipped: pSkipped, stories: partialStories },
        });
      }

      if (e.connRefused) {
        // Emit SSE-disconnect polling fallback notification so the client knows we are retrying
        try {
          server.server.notification({
            method: 'notifications/progress',
            params: {
              progressToken,
              progress: 3 + storyProgressCount,
              total: 5 + storyCount,
              message: 'SSE disconnected, falling back to polling every 15s...',
              phase: 'polling_fallback',
            },
          });
        } catch { /* best-effort */ }

        return errorResult({
          phase: 'monitoring',
          run_id: runId,
          error: 'Lost connection to Rorca server mid-run',
          suggestion: `Run: rorca status ${runId} after restarting the server to check run state. The pipeline process may still be running.`,
        });
      }

      return errorResult({ phase: 'monitoring', run_id: runId, error: String(e.error ?? 'Unknown monitoring error') });
    }

    // ── Build success result ─────────────────────────────────────────────────
    const { stories, branchName, worktreePath } = monitorResult;
    const passed = stories.filter(s => s.status === 'passed').length;
    const failed = stories.filter(s => s.status === 'failed').length;
    const skipped = stories.filter(s => s.status === 'skipped').length;
    const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);

    notify(5 + storyCount, 5 + storyCount, `Complete: ${passed} passed, ${failed} failed`);

    const result: Record<string, unknown> = {
      ok: true,
      spec_id: specId,
      spec_title: specId,
      story_count: storyCount,
      run_id: runId,
      passed,
      failed,
      skipped,
      branch: branchName,
      worktree_path: worktreePath,
      elapsed_seconds: elapsedSeconds,
      stories,
    };

    if (worktreeFallback) {
      result.worktree_fallback = true;
      result.worktree_error = worktreeError;
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ─── US-003: Spec Enrichment MCP Tool & Prompt ────────────────────────────────

server.registerTool(
  'rorca_enrich_spec',
  {
    description: '[Specs] Enrich a spec by running the 4-layer retrieval cascade (direction stack synthesis, workspace context, git history, schema snapshot) against each user story. Adds retrieved context to story descriptions so the execution engine has richer information at runtime. Returns retrieval method used, number of stories enriched, and token usage.',
    inputSchema: {
      workspaceId: z.string().describe('Rorca workspace ID'),
      specId: z.string().describe('Spec ID (filename slug) to enrich'),
    },
  },
  async ({ workspaceId, specId }) => {
    return wrapToolCall('rorca_enrich_spec', async () => {
      const res = await timedFetch(`${RORCA_API}/api/specs/${specId}/enrich`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      }, 0); // unbounded — 53-story enrichment can take 10+ min
      if (!res.ok) return httpError('rorca_enrich_spec', res);
      const data = await res.json() as {
        retrieval_method: string;
        storiesEnriched: number;
      };
      return {
        content: [{
          type: 'text' as const,
          text: [
            `Spec ${specId} enriched`,
            `Retrieval method: ${data.retrieval_method}`,
            `Stories enriched: ${data.storiesEnriched}`,
          ].join('\n'),
        }],
      };
    });
  }
);

server.registerPrompt(
  'rorca_enrich_spec',
  {
    title: 'Enrich Spec',
    description: 'Enrich a spec via the 4-layer retrieval cascade. Usage: /mcp__rorca__rorca_enrich_spec <workspaceId> <specId>',
    argsSchema: {
      workspaceId: z.string().describe('Rorca workspace ID'),
      specId: z.string().describe('Spec ID (filename slug) to enrich'),
    },
  },
  async ({ workspaceId, specId }) => {
    return {
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `Enrich spec "${specId}" in workspace "${workspaceId}" by calling rorca_enrich_spec tool with workspaceId="${workspaceId}" and specId="${specId}".`,
        },
      }],
    };
  }
);

// ─── Story Model Assignment MCP Tool (US-002) ────────────────────────────────

server.registerTool(
  'rorca_assign_story_models',
  {
    description: 'Assign per-story model tiers to a spec based on complexity scoring. Each story is scored (low/medium/high) and assigned the appropriate model (haiku→sonnet→opus for claude/opencode). When dryRun=true the spec JSON is NOT modified — only the breakdown is returned, useful for previewing assignments before committing. Codex agent skips assignment entirely (model is fixed to your ChatGPT subscription).',
    inputSchema: {
      workspaceId: z.string().describe('Rorca workspace ID'),
      specId: z.string().describe('Spec slug (filename without .json, e.g. "rorca-feature-enhancements")'),
      dryRun: z.boolean().optional().describe('If true, returns breakdown without writing to spec file (default: false)'),
    },
  },
  async ({ workspaceId, specId, dryRun }) => {
    return wrapToolCall('rorca_assign_story_models', async () => {
      const body: Record<string, unknown> = { workspaceId };
      if (dryRun !== undefined) body.dryRun = dryRun;
      const url = `${RORCA_API}/api/specs/${encodeURIComponent(specId)}/assign-models`;
      const res = await timedFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) return httpError('rorca_assign_story_models', res);
      const data = await res.json() as {
        storiesAssigned: number;
        skipped?: boolean;
        reason?: string;
        breakdown: Array<{ storyId: string; complexity: string; model: string; reason: string }>;
      };
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            specId,
            workspaceId,
            dryRun: dryRun ?? false,
            storiesAssigned: data.storiesAssigned,
            skipped: data.skipped ?? false,
            ...(data.reason !== undefined ? { reason: data.reason } : {}),
            breakdown: data.breakdown,
          }, null, 2),
        }],
      };
    });
  }
);

server.registerPrompt(
  'assign_story_models',
  {
    title: 'Assign Story Models',
    description: 'Assign per-story model tiers based on complexity scoring. Usage: /mcp__rorca__assign_story_models <specId> [dryRun]',
    argsSchema: {
      specId: z.string().describe('Spec slug (filename without .json)'),
      dryRun: z.string().optional().describe('Pass "true" to preview assignments without writing to spec file'),
    },
  },
  async ({ specId, dryRun }) => {
    const isDryRun = dryRun === 'true';
    const dryRunNote = isDryRun
      ? ' Use dryRun=true so the spec file is NOT modified — return only the breakdown.'
      : ' Write the assigned model to each story (dryRun=false).';
    return {
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `Call the rorca_assign_story_models tool with specId="${specId}" and workspaceId="rorcha" and dryRun=${isDryRun}.${dryRunNote} Show the full breakdown table (storyId, complexity, model, reason) and a summary of how many stories were assigned.`,
        },
      }],
    };
  }
);

server.registerPrompt(
  'recall',
  {
    title: 'Recall Workspace Context',
    description: 'Bootstrap your session with full workspace context — direction stack, memories, health report, recent runs, and installed skills. Invoke at the start of any session to load everything in one shot.',
    argsSchema: {
      workspaceId: z.string().optional().describe(`Workspace ID (default: ${DEFAULT_WORKSPACE})`),
    },
  },
  async ({ workspaceId }) => {
    const ws = workspaceId ?? DEFAULT_WORKSPACE;
    return {
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `Call the rorca_recall tool with workspaceId="${ws}". Read and internalize ALL returned context including the direction stack (L1-L5), memory ledger entries, workspace health report, recent pipeline runs, and installed skills. After loading, confirm to me what workspace context has been loaded and summarize: (1) the workspace health score, (2) number of memory entries, (3) recent run pass rate (passed/total stories across last runs), and (4) whether any run is currently active.`,
        },
      }],
    };
  }
);

// ─── Recall Workspace MCP Tool ───────────────────────────────────────────────

server.registerTool(
  'rorca_recall_workspace',
  {
    description: `Semantic workspace context recall — USE THIS when asking "what does Rorca know about X?" or bootstrapping a session with full workspace context.

With query parameter: triggers 3-tier semantic retrieval (CAG cache → RAG embeddings → Knowledge Graph) to find memories, conventions, and decisions most relevant to your question. Example: query="authentication middleware" returns auth-related memories ranked by semantic similarity, not just keyword match.

Without query: returns full brain dump — direction stack, all recent memories, health, runs, skills, workspace context. Use at session start to bootstrap context.

Returns direction stack + memories + health + recent runs + skills + workspace context + active runs in one payload.
DO NOT use for paginated memory listing — use rorca_memory_items.
DO NOT use for cross-source search (specs + stories + memories) — use rorca_search.`,
    inputSchema: {
      workspaceId: z.string().describe('Rorca workspace ID (from rorca_list_workspaces or settings)'),
      category: z.enum(['Architecture', 'Convention', 'Bug Fix', 'Decision', 'Pattern', 'Gotcha']).optional().describe('Filter memories to a specific category'),
      includeRuns: z.boolean().optional().default(true).describe('Include recent pipeline runs in response (default: true)'),
      includeHealth: z.boolean().optional().default(true).describe('Include workspace health report (default: true)'),
      query: z.string().optional().describe('Feature brief or task description — anchors semantic retrieval (CAG → RAG → Knowledge Graph) to fetch the most relevant memories, file-touch history, and convention links for what you are about to build. Pass the raw brief text here.'),
      titlesOnly: z.boolean().optional().default(false).describe('Return memory titles only (strips full rule content) — ~2K tokens vs ~50K+ for full dump. Use when you want a quick index to decide which memories to load in full.'),
    },
  },
  async ({ workspaceId, category, includeRuns, includeHealth, query, titlesOnly }) => {
    return wrapToolCall('rorca_recall_workspace', async () => {
      const params = new URLSearchParams({ workspaceId });
      if (category) params.set('category', category);
      if (includeRuns !== undefined) params.set('includeRuns', String(includeRuns));
      if (includeHealth !== undefined) params.set('includeHealth', String(includeHealth));
      if (query) params.set('query', query);
      if (titlesOnly) params.set('titlesOnly', 'true');

      const res = await fetchWithRetry('rorca_recall_workspace', () =>
        timedFetch(`${RORCA_API}/api/recall?${params.toString()}`)
      );
      if (!res.ok) return httpError('rorca_recall_workspace', res);
      const data = await res.json();
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(data, null, 2),
        }],
      };
    }, `recall_workspace:${workspaceId}`);
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.env.NODE_ENV !== 'test') {
  main().catch((err) => logger.error({ err }, 'MCP server error'));
}
