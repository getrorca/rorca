# MCP Integration Guide

Rorca exposes its full API surface as MCP (Model Context Protocol) tools. Any MCP-compatible client — Hermes Agent, OpenClaw, Claude Code, Continue, Cline — can discover and use Rorca's tools.

## Quick Start

### Hermes Agent (recommended)
```bash
hermes mcp add rorca --url http://localhost:3030/mcp
hermes mcp test rorca
```

### Claude Code
```json
// ~/.claude/mcp.json
{
  "mcpServers": {
    "rorca": {
      "type": "http",
      "url": "http://localhost:3030/mcp"
    }
  }
}
```

### OpenClaw
```json
// openclaw.json
{
  "mcpServers": {
    "rorca": {
      "url": "http://localhost:3030/mcp"
    }
  }
}
```

### Cline (VS Code)
```json
// .cline/mcp_settings.json
{
  "mcpServers": {
    "rorca": {
      "url": "http://localhost:3030/mcp",
      "transport": "streamable-http"
    }
  }
}
```

## Available MCP Tools

All tools are auto-generated from Rorca's OpenAPI spec. Tools are tier-gated:

### Public tier (always available)
| Tool | Description |
|------|-------------|
| `rorca_list_specs` | List all specs |
| `rorca_create_spec` | Create a new spec (preferred path) |
| `rorca_get_context` | Get retrieval-backed context |
| `rorca_pipeline_status` | Check pipeline run status |

### Auth tier (requires MCP token)
| Tool | Description |
|------|-------------|
| `rorca_approve_spec` | Approve a spec for execution |
| `rorca_pipeline_trigger` | Trigger pipeline execution |
| `rorca_edit_story` | Edit stories in a spec |
| `rorca_add_stories` | Add new stories |
| `rorca_delete_story` | Remove a story |

### Admin tier (requires admin token)
| Tool | Description |
|------|-------------|
| `rorca_mcp_audit` | View MCP audit log |
| `rorca_database_backup` | Backup database |

## Authentication

Rorca uses Bearer token authentication for MCP:

```bash
# Generate tokens
rorca mcp setup

# Public token (read-only spec listing, context)
cat ~/.rorca/mcp-public-token

# Admin token (full access)
cat ~/.rorca/mcp-admin-token
```

## Architecture

```
┌──────────────┐     MCP (HTTP)      ┌──────────────────┐
│ Hermes Agent │ ←─────────────────→ │  Rorca Backend   │
│ OpenClaw     │    localhost:3030   │  /mcp endpoint   │
│ Claude Code  │    Bearer token     │                  │
│ Cline        │                     │  Auto-generated  │
│ Continue     │                     │  from OpenAPI    │
└──────────────┘                     └──────────────────┘
                                              │
                                    ┌─────────┴─────────┐
                                    │   PostgreSQL 18   │
                                    │   Specs, Memory   │
                                    │   Runs, Telemetry │
                                    └───────────────────┘
```

Rorca's MCP tools are auto-generated from `@swagger` JSDoc annotations on Express routes. Adding a new route with `@swagger` + `x-rorca-tier` automatically creates an MCP tool — zero hand-written MCP code.

## Security

- **Localhost-only by default** — MCP only accepts connections from 127.0.0.1
- **Tier-based access** — public, auth, admin tiers with per-tool authorization
- **Audit logging** — every MCP call is logged with token tier, remote address, and session
- **Rate limiting** — per-token rate limits prevent abuse
- **No OAuth theater** — honest Bearer token model, no OAuth endpoints that accept any token

To allow remote MCP access (behind a trusted TLS terminator):
```bash
export RORCA_MCP_ALLOW_REMOTE=true
```
