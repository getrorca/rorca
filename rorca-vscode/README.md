# Rorca VS Code Extension

Spec-driven development — Specs tree, MCP Tools tree, and pipeline control for VS Code.

## Overview

This extension connects VS Code to a running Rorca backend server, providing:

- **Specs tree view** — browse pending, approved, and running specs in the activity bar
- **MCP Tools tree view** — discover and insert Rorca MCP tool names at cursor
- **Status bar item** — live connection indicator (○ Rorca = disconnected, ● Rorca = connected)
- **Commands** — approve specs, trigger runs, forge from selection, test connection

## Prerequisites

- VS Code 1.100.0+
- Node.js 18+
- A running Rorca backend (`npm run dev` in the Rorca repo, listening on `:3030`)

## Development

```bash
cd rorca-vscode
npm install

# Build once
npm run compile

# Watch mode (rebuilds on change)
npm run watch

# Launch Extension Development Host
# Press F5 in VS Code with this folder open
```

### F5 Debug Flow

1. Open `rorca-vscode/` in VS Code
2. Press **F5** — launches Extension Development Host
3. The Rorca activity bar icon appears in the host window
4. Open the Rorca panel to see Specs and MCP Tools tree views

## Architecture

```
rorca-vscode/
├── src/
│   ├── extension.ts        # Entry point — registers providers and commands
│   ├── specProvider.ts     # TreeDataProvider for rorcaSpecs view
│   ├── mcpToolsProvider.ts # TreeDataProvider for rorcaMcpTools view
│   └── auth.ts             # Server URL resolution and apiFetch helper
├── resources/
│   └── rorca.svg           # Activity bar icon
├── dist/                   # esbuild output (generated)
├── esbuild.js              # Bundler config
├── tsconfig.json           # TypeScript config
└── package.json            # Extension manifest
```

The extension uses **esbuild** for bundling (not `tsc` directly), producing `dist/extension.js` as the single entry point. TypeScript type-checking runs separately via `check-types`.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `rorca.apiUrl` | `http://localhost:3030` | Rorca backend URL |
| `rorca.defaultWorkspacePath` | `""` | Override workspace autodetection |
| `rorca.autoRefreshInterval` | `60` | Seconds between auto-refresh (0 = disabled) |
| `rorca.showStatusBarItem` | `true` | Show/hide status bar item |
| `rorca.insertSyntax` | `name-only` | Insert format: `name-only`, `json-call`, or `slash-command` |

## Commands

| Command | Description |
|---------|-------------|
| `Rorca: Refresh Specs` | Reload specs tree from backend |
| `Rorca: Refresh MCP Tools` | Reload MCP tools tree from backend |
| `Rorca: Approve Spec` | Approve a pending spec |
| `Rorca: Trigger Run` | Start a pipeline run for a spec |
| `Rorca: Open in Browser` | Open Rorca UI in browser |
| `Rorca: Copy Spec JSON` | Copy spec JSON to clipboard |
| `Rorca: Test Connection` | Ping backend and show status |
| `Rorca: Start Server` | Open terminal with server start instructions |
| `Rorca: Forge from Selection` | Use selected text as a spec brief |
