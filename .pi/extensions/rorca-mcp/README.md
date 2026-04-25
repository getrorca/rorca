# Rorca MCP bridge for Pi

This project-local Pi extension bridges Pi to Rorca's **legacy stdio MCP server** (`backend/src/mcp/server.ts`) and registers the curated `rorca_*` tools as native Pi tools.

## Why stdio and not `/mcp`?

Rorca exposes two MCP surfaces:

- `backend/src/mcp/server.ts` → curated legacy `rorca_*` tools
- `GET/POST /mcp` → auto-generated OpenAPI MCP transport

The curated `rorca_*` tools live on the **stdio server**, so this bridge talks to that server directly.

## Usage

Start Pi in the repo root:

```bash
cd /Users/dimitriteravanessian/rorca
pi
```

On session start the extension will try to register the Rorca tools automatically.

Useful commands:

- `/rorca-mcp-refresh` — reconnect and reload the Rorca tools
- `/rorca-mcp-status` — show bridge status and command/cwd config

## Optional environment overrides

```bash
export RORCA_MCP_COMMAND=npx
export RORCA_MCP_SERVER=/absolute/path/to/backend/src/mcp/server.ts
export RORCA_MCP_CWD=/absolute/path/to/backend
# Optional full arg override instead of default: "tsx <server>"
export RORCA_MCP_ARGS="tsx /absolute/path/to/backend/src/mcp/server.ts"
```
