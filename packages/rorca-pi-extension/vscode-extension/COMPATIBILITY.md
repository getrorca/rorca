# Rorca Capture VS Code Compatibility Matrix

Rorca Capture uses only stable VS Code extension APIs: command registration, workspace trust, status bar items, editor/document events, terminal/task lifecycle events, configuration, and `vscode.open`. It does **not** inspect proprietary AI chat internals.

| Host | CLI names detected | Status | Installation path | Notes |
| --- | --- | --- | --- | --- |
| VS Code Stable | `code` | Validated API target | `code --install-extension <vsix-or-id>` | Primary target for extension test harness validation. |
| VS Code Insiders | `code-insiders` | Validated API target | `code-insiders --install-extension <vsix-or-id>` | Same stable API surface as VS Code Stable. |
| VSCodium | `codium`, `vscodium` | Expected via VS Code API compatibility | `codium --install-extension <vsix>` when marketplace id is unavailable | Marketplace access may differ; VSIX fallback is documented and non-fatal. |
| Cursor | `cursor`, `cursor-insiders` | Expected via VS Code API compatibility | `cursor --install-extension <vsix>` | Proprietary AI chat panes are inaccessible unless Cursor exposes an explicit compatible adapter API. Rorca relies on editor/shell/git layers. |
| Windsurf | `windsurf`, `code-windsurf` | Expected via VS Code API compatibility | `windsurf --install-extension <vsix>` | Proprietary AI chat panes are inaccessible unless Windsurf exposes an explicit compatible adapter API. Rorca relies on editor/shell/git layers. |

## Degraded capability rules

- Missing host CLIs are reported as `missing` and never fail setup.
- Hosts without marketplace support should install a locally built VSIX with the host's `--install-extension` CLI.
- Proprietary AI chat surfaces are reported as `unsupported-without-adapter`; the extension still captures stable editor/workspace, terminal/task, file-save, git, and explicit Remember Selection events.
- Workspace Trust is default-on: capture is disabled in untrusted workspaces until the host marks the workspace trusted.
- `npm run lint:swagger` and `npm run lint:tier` are backend contract checks and are currently limited by the documented tsx/ESM `__dirname` issue; do not use them as extension compatibility gates.

## Setup

After compiling the extension package, detect and install on available hosts:

```bash
cd packages/rorca-pi-extension/vscode-extension
npm run compile
npm run setup:hosts -- --vsix ./rorca-capture-vscode-0.1.0.vsix
```

If no VSIX is provided, setup reports `vsix-required` for installed hosts so operators can package the extension and retry. The detection/installation report is non-fatal and JSON-friendly via `--json`.
