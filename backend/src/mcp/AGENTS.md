# AGENTS.md — backend/src/mcp/

MCP (Model Context Protocol) server — exposes Rorca as a set of tools that Claude can call directly.

## What It Does

`server.ts` builds the MCP server from the OpenAPI spec using `@modelcontextprotocol/sdk`. Public/auth routes become MCP tools automatically, and a small alias layer adds friendly names for the core spec/pipeline workflows.

The MCP server hits Rorca's HTTP API internally: `RORCA_API_URL` env var (default `http://localhost:3030`).

## Tools

| Tool | Inputs | Output |
|------|--------|--------|
| `rorca_get_context` | `workspaceId`, `specBrief`, `storyAnnotations?` | Synthesized Direction Stack (all 5 layers merged) |
| `rorca_create_spec` | `workspaceId`, `title`, `stories`, `slug?`, `specBrief?`, `overwrite?`, `source?`, `contextUsed?`, `contextSummary?`, `postSave?`, `policyPresetId?`, `postSavePolicy?` | Canonical explicit cross-client spec-creation path |
| `rorca_generate_spec` | `workspaceId`, `specBrief`, `title`, `storyCount?` | Legacy/fallback brief→spec generation when you want Rorca to draft |
| `rorca_persist_spec` | `workspaceId`, `title`, `stories`, `slug?`, `specBrief?`, `overwrite?`, `source?`, `contextUsed?`, `contextSummary?`, `postSave?`, `policyPresetId?`, `postSavePolicy?` | Compatibility alias for explicit-draft persistence |
| `rorca_spec_workflow` | `workspaceId`, `specId` | Durable post-save workflow state for one spec |
| `rorca_spec_readiness` | `workspaceId`, `specId` | Readiness, reason codes, and safe action hints for one spec |
| `rorca_approve_spec` | `workspaceId`, `specSlug` | Approval confirmation, new version number |
| `rorca_list_specs` | `workspaceId`, `status?` (pending/approved) | Array of spec summaries |
| `rorca_list_workspaces` | (none) | All registered workspaces |
| `rorca_contracts_bounty_presentation` | (none) | Read-only OpenAPI-derived bounty presentation contract; no Controller/target authority |
| `rorca_pipeline_status` | `workspaceId?`, `runId?` | Current/recent pipeline runs with story results |
| `rorca_trigger_run` | `workspaceId`, `specPath`, `storyId?`, `modelOverride?`, `includeGraph?`, `forceSequential?` | Start pipeline run for approved spec |
| `rorca_run_status` | `runId` | Detailed run status with per-story progress |
| `rorca_retry_story` | `runId`, `storyIds?`, `forceSequential?` | Retry failed stories in a completed run |
| `rorca_list_runs` | `workspaceId`, `limit?` | Recent pipeline runs with status summary |
| `rorca_edit_story` | `workspaceId`, `specId`, `storyId`, fields | Update a single story in a spec |
| `rorca_search_stories` | `workspaceId`, `query` | Cross-spec story search |
| `rorca_add_stories` | `workspaceId`, `specId`, `count?`, `brief?` | Generate and append stories to spec |
| `rorca_delete_story` | `workspaceId`, `specId`, `storyId` | Remove story, reindex IDs |
| `rorca_subscribe_run_events` | `afterEventId?` | Push idempotent replay and live canonical WAL/SSE run events to the stateful OMP session for its selected workspace |
| `rorca_unsubscribe_run_events` | (none) | Stop run-event notifications for the current OMP session |

## Usage Pattern

Preferred universal skill-first flow:
1. caller/skill retrieves context via MCP tools
2. caller drafts the spec content locally
3. caller persists the explicit draft with `rorca_create_spec` (or compatibility alias `rorca_persist_spec`), carrying `contextUsed` + `contextSummary` and explicitly passing either `policyPresetId` or `postSavePolicy` so the save contract is policy-aware
4. caller reads back the saved spec plus `rorca_spec_workflow` or `rorca_spec_readiness` and classifies story-level skill outcome as `present`, `pending`, `skipped:no_installed_skills`, or `failed:<retryable_reason>` instead of assuming persist success implies enrichment success
5. backend validates, normalizes, saves, and can run post-save enrichment

If `rorca_specs_generation_context` is available, caller-owned forge flows should fetch it before persistence and forward the returned `contextUsed` + `contextSummary`. Any server-side context-summary backfill is repair-only fallback, not a substitute for caller-observed drafting context and not the normal creation contract.

**Post-save enrichment**: When `postSave` options are provided (or defaulted), the persist endpoint enqueues durable post-save jobs:
- `enrich: true` → enqueue enrichment immediately via pg-boss
- `matchSkills: true` → deferred until enrich completes (dependency chain)
- `memorySynthesis: true` → reserved for future implementation

Each stage tracks honest status (`pending`/`queued`/`running`/`completed`/`failed`/`skipped`) and reason in `spec_generation_logs.context_summary_json.postSaveStages`.

**Context capture provenance**: The persist endpoint tracks how context was acquired via `contextCaptureStatus`:
- `provided` — caller supplied `contextSummary` (best case)
- `backfilled` — server derived a summary from `contextUsed.meta`
- `missing` — caller omitted drafting context entirely

**Repair**: If post-save stages fail or specs are missing generation logs:
- `POST /api/specs/:specId/repair` — diagnose and repair a single spec
- `GET /api/specs/repair-candidates` — discover specs needing repair in a workspace
- `POST /api/specs/repair-batch` — apply bounded repair across multiple specs

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
