# Changelog

All notable changes to the Rorca VS Code extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Rorca sidebar with Specs and MCP Tools tree views in the VS Code activity bar
- Server connection status bar indicator (○ Rorca = disconnected, ● Rorca = connected)
- JWT authentication from `~/.rorca/credentials` for secure backend access
- VS Code settings for server URL (`rorca.apiUrl`) and refresh interval (`rorca.autoRefreshInterval`)
- Right-click context menu actions on specs: Approve, Trigger Run, Open in Browser, Copy JSON
- Forge from Selection command — use selected editor text as a spec brief
- Test Connection command to ping backend and verify connectivity
- MCP Tools tree view for discovering and inserting Rorca MCP tool names at cursor

## [0.1.0] - YYYY-MM-DD

- Initial release

[Unreleased]: https://github.com/getrorca/rorca/compare/v0.1.0-vscode...HEAD
[0.1.0]: https://github.com/getrorca/rorca/releases/tag/v0.1.0-vscode
