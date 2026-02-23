# AGENTS.md — backend/src/mcp/

MCP (Model Context Protocol) server — exposes Rorcha as a set of tools that Claude can call directly.

## What It Does

`server.ts` registers 6 MCP tools using `@modelcontextprotocol/sdk`. When Claude (or another MCP client) connects, it can call these tools to interact with Rorcha without going through the HTTP API manually.

The MCP server hits Rorcha's HTTP API internally: `RORCHA_API_URL` env var (default `http://localhost:3030`).

## Tools

| Tool | Inputs | Output |
|------|--------|--------|
| `rorcha_get_context` | `workspaceId`, `specBrief`, `storyAnnotations?` | Synthesized Direction Stack (all 5 layers merged) |
| `rorcha_generate_spec` | `workspaceId`, `specBrief`, `title`, `storyCount?` (1-500, default 8) | Generated spec JSON |
| `rorcha_approve_spec` | `workspaceId`, `specSlug` | Approval confirmation, new version number |
| `rorcha_list_specs` | `workspaceId`, `status?` (pending/approved) | Array of spec summaries |
| `rorcha_list_workspaces` | (none) | All registered workspaces |
| `rorcha_pipeline_status` | `workspaceId?`, `runId?` | Current/recent pipeline runs with story results |

## Usage Pattern

```typescript
// Tools are called by Claude via MCP protocol
// Each tool handler calls the Rorcha HTTP API:
const res = await fetch(`${RORCHA_API_URL}/api/specs/${specSlug}/approve`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ workspaceId })
});
```

## Adding a New Tool

```typescript
server.tool(
  'rorcha_my_tool',
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
    const res = await fetch(`${RORCHA_API_URL}/api/my-endpoint`, {
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
- **`RORCHA_API_URL` must be set** (or default `http://localhost:3030` must be reachable) for MCP tools to work.
- **Tool names must be unique** — duplicate tool names will cause the MCP SDK to throw on startup.
- **inputSchema vs parameters**: use `inputSchema` (the current SDK pattern), NOT `parameters` — older Anthropic SDK pattern.
