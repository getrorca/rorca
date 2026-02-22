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
    },
  },
  async ({ workspaceId, specBrief, title, storyCount, includeDiagrams }) => {
    const resolvedStoryCount = storyCount ?? 8;
    const resolvedIncludeDiagrams = includeDiagrams ?? true;
    const res = await fetch(`${RORCHA_API}/api/specs/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, specBrief, title, storyCount: resolvedStoryCount, includeDiagrams: resolvedIncludeDiagrams }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Spec generation failed (${res.status}): ${err}`);
    }
    const spec = await res.json();
    return {
      content: [
        { type: 'text' as const, text: `Generated spec: ${title}\n\n${JSON.stringify(spec, null, 2)}` }
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.env.NODE_ENV !== 'test') {
  main().catch(console.error);
}
