# Rorca VS Code Extension

AI spec orchestration and pipeline management for autonomous software development, directly in VS Code.

## Overview

The Rorca VS Code extension integrates the Rorca platform into your editor. It provides:

- **Specs Tree View** — browse and manage your specs directly from the activity bar
- **MCP Tools Tree View** — explore and insert Rorca MCP tools without leaving the editor
- **Status Bar** — at-a-glance connection status to your Rorca backend
- **Command Palette** — all Rorca operations via `Ctrl+Shift+P` → "Rorca: ..."

## Prerequisites

- VS Code 1.100.0 or later
- [Rorca backend](https://github.com/rorca/rorca) running locally on port 3030 (default)
- Node.js 18+

## Development

### Setup

```bash
cd rorca-vscode
npm install
```

### Launch (F5)

Open the `rorca-vscode/` folder in VS Code, then press **F5** to open an Extension Development Host window with the extension loaded.

The default build task runs `esbuild` to produce `dist/extension.js` before launching.

### Watch Mode

```bash
npm run watch
```

Runs `watch:esbuild` and `watch:tsc` in parallel. Changes to `src/` are reflected immediately in the Extension Development Host after a window reload.

### Build

```bash
npm run compile       # type-check + bundle (dev mode, sourcemaps)
npm run package       # type-check + bundle (production, minified)
```

### Package for distribution

```bash
npm run package       # produces dist/extension.js
npx vsce package      # produces rorca-vscode-0.0.1.vsix
```

## Architecture

```
rorca-vscode/
├── src/
│   ├── extension.ts        # Entry point — activate/deactivate, registers all providers + commands
│   ├── specProvider.ts     # TreeDataProvider for the Specs view
│   ├── mcpToolsProvider.ts # TreeDataProvider for the MCP Tools view
│   └── auth.ts             # Auth token management + apiFetch helper
├── dist/
│   └── extension.js        # esbuild bundle (generated)
├── resources/
│   └── rorca.svg           # Activity bar icon
├── .vscode/
│   ├── launch.json         # Extension Development Host launch config (F5)
│   └── tasks.json          # Composite watch task (default build task)
├── esbuild.js              # Build script (dev/production/watch modes)
└── tsconfig.json           # TypeScript config (ES2024, strict)
```

### Provider Pattern

Both `SpecTreeDataProvider` and `McpToolsProvider` implement `vscode.TreeDataProvider<TreeItem>`. They expose a `refresh()` method that fires `_onDidChangeTreeData` to trigger VS Code to re-query `getChildren()`.

### API Communication

All backend calls go through `apiFetch(path, options?)` in `src/auth.ts`. It:
1. Prepends `getServerUrl()` (reads `rorca.apiUrl` setting, default `http://localhost:3030`)
2. Adds `Authorization: Bearer <token>` header if `getAuthToken()` returns a token (currently always `null`)

## Configuration

| Setting | Type | Default | Scope | Description |
|---------|------|---------|-------|-------------|
| `rorca.apiUrl` | string | `http://localhost:3030` | window | Rorca backend URL |
| `rorca.defaultWorkspacePath` | string | `""` | resource | Override workspace autodetection |
| `rorca.autoRefreshInterval` | number | `60` | window | Auto-refresh interval in seconds (0 = disabled) |
| `rorca.showStatusBarItem` | boolean | `true` | window | Show status bar item |
| `rorca.insertSyntax` | enum | `name-only` | window | Insert format: `name-only`, `json-call`, `slash-command` |
