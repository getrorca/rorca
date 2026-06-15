# AGENTS.md — backend/src/mcp/

MCP (Model Context Protocol) server — exposes Rorca as a set of tools that Claude can call directly.

## What It Does

`server.ts` builds the MCP server from the OpenAPI spec using `@modelcontextprotocol/sdk`. Public/auth routes become MCP tools automatically, and a small alias layer adds friendly names for the core spec/pipeline workflows.

The MCP server hits Rorca's HTTP API internally: `RORCA_API_URL` env var (default `http://localhost:3030`).

## Tools

| Tool | Inputs | Output |
|------|--------|--------|
| `rorca_get_context` | `workspaceId`, `specBrief`, `storyAnnotations?` | Synthesized Direction Stack (all 5 layers merged) |
| `rorca_create_spec` | `workspaceId`, `title`, `stories`, `slug?`, `specBrief?`, `overwrite?`, `source?`, `contextUsed?`, `contextSummary?`, `postSave?` | Canonical explicit cross-client spec-creation path |
| `rorca_generate_spec` | `workspaceId`, `specBrief`, `title`, `storyCount?` | Legacy/fallback brief→spec generation when you want Rorca to draft |
| `rorca_persist_spec` | `workspaceId`, `title`, `stories`, `slug?`, `specBrief?`, `overwrite?`, `source?`, `contextUsed?`, `contextSummary?`, `postSave?` | Compatibility alias for explicit-draft persistence |
| `rorca_approve_spec` | `workspaceId`, `specSlug` | Approval confirmation, new version number |
| `rorca_list_specs` | `workspaceId`, `status?` (pending/approved) | Array of spec summaries |
| `rorca_list_workspaces` | (none) | All registered workspaces |
| `rorca_pipeline_status` | `workspaceId?`, `runId?` | Current/recent pipeline runs with story results |
| `rorca_trigger_run` | `workspaceId`, `specPath`, `storyId?`, `modelOverride?`, `includeGraph?`, `forceSequential?` | Start pipeline run for approved spec |
| `rorca_run_status` | `runId` | Detailed run status with per-story progress |
| `rorca_retry_story` | `runId`, `storyIds?`, `forceSequential?` | Retry failed stories in a completed run |
| `rorca_list_runs` | `workspaceId`, `limit?` | Recent pipeline runs with status summary |
| `rorca_edit_story` | `workspaceId`, `specId`, `storyId`, fields | Update a single story in a spec |
| `rorca_search_stories` | `workspaceId`, `query` | Cross-spec story search |
| `rorca_add_stories` | `workspaceId`, `specId`, `count?`, `brief?` | Generate and append stories to spec |
| `rorca_delete_story` | `workspaceId`, `specId`, `storyId` | Remove story, reindex IDs |

## Usage Pattern

Preferred universal skill-first flow:
1. caller/skill retrieves context via MCP tools
2. caller drafts the spec content locally
3. caller persists the explicit draft with `rorca_create_spec` (or compatibility alias `rorca_persist_spec`), carrying `contextUsed` + `contextSummary` when available so spec detail can show the real drafting context
4. backend validates, normalizes, saves, and can run post-save enrichment

If `rorca_specs_generation_context` is available, caller-owned forge flows should fetch it before persistence and forward the returned `contextUsed` + `contextSummary`. Any server-side context-summary backfill is recovery-grade fallback only, not a substitute for caller-observed drafting context.

`rorca_generate_spec` remains available as the legacy/fallback path when the caller wants backend-side drafting.


```typescript
// Tools are called by Claude via MCP protocol
// Each tool handler calls the Rorca HTTP API:
const res = await fetch(`${RORCA_API_URL}/api/specs/${specSlug}/approve`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ workspaceId })
});
```

## Adding a New Tool

```typescript
server.tool(
  'rorca_my_tool',
  {
    description: 'What this tool does',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace ID' },
        myParam: { type: 'string', description: 'My parameter' }
      },
      required: ['workspaceId']
    }
  },
  async ({ workspaceId, myParam }) => {
    const res = await fetch(`${RORCA_API_URL}/api/my-endpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, myParam })
    });
    const data = await res.json();
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
  }
);
```

## Gotchas

- **MCP server runs separately** from the main Express server. Not auto-started by `npm run dev` — check if a separate start command exists.
- **`RORCA_API_URL` must be set** (or default `http://localhost:3030` must be reachable) for MCP tools to work.
- **Tool names must be unique** — duplicate tool names will cause the MCP SDK to throw on startup.
- **inputSchema vs parameters**: use `inputSchema` (the current SDK pattern), NOT `parameters` — older Anthropic SDK pattern.
