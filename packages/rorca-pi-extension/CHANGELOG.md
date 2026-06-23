# Changelog

All notable changes to the Rorca Pi Extension will be documented in this file.

The format is inspired by Keep a Changelog and uses semantic-version style release sections.

---

## [0.2.0] - 2026-06-22

Hermes launch-handoff release (LHM-006). Makes Rorca usable from Hermes —
Rorca's external distribution channel — by documenting the integration, install
and update path, and keeping the skill surface honest about current MCP tool
names and Graph Lite / BYOP behavior.

### Added

- Added [`docs/mcp-integration.md`](../../docs/mcp-integration.md): the canonical
  Hermes-facing guide covering MCP server registration, the discoverable tool
  surface, the brief → spec → review → approve → run → inspect workflow, a
  clean-environment install/update flow, version validation and rollback, and
  Graph Lite / BYOP truthfulness.
- Documented the canonical, current MCP tool names (e.g. `rorca_get_context`,
  `rorca_create_spec`, `rorca_list_specs`, `rorca_approve_spec`,
  `rorca_trigger_run`, `rorca_pipeline_status`, `rorca_run_status`) and their
  stable aliases in the README and integration doc.

### Changed

- README now positions this package explicitly as **Hermes** (an external
  distribution channel, not a replacement for the first-party Rorca app/TUI),
  adds an update/rollback section tied to this package's version, and documents
  Graph Lite / BYOP behavior with `dbMode` / `graphMode` from `/api/health`.
- `rorca-forge` and `rorca-forge-run` skills now warn that graph/retrieval
  context may be Graph-Lite-shaped depending on DB mode, so they avoid promising
  AGE-only graph behavior.

### Versioning

- This release pins the extension and bundled skills to `0.2.0` so installs can
  be validated against `CHANGELOG.md` and rolled back as a unit.

---

## [0.1.0] - 2026-05-14

Initial public-ready release of the **Rorca Pi Extension**.

This release introduces a Pi-native operator experience for Rorca that lets users forge specs, approve them, trigger Pi-backed runs, inspect status, retry failures, watch live progress, and optionally bridge Rorca MCP tools directly into Pi.

### Highlights

- Pi-native slash commands for the most important Rorca workflows
- REST-first command UX with optional automatic MCP tool bridging
- Live run watching inside Pi widgets and status bars
- Automatic Pi model fallback to a working local Codex-family model when the saved spec model is unavailable
- True single-story Pi runs via `specificStory` semantics
- Verified end-to-end behavior across forge, approve, run, status, retry, memory persistence, graph context, draft PR creation, and sandbox merge flows

### Added

#### New packaged Pi extension
- Added a first-class package at `packages/rorca-pi-extension/`
- Added extension entrypoint and runtime wiring:
  - `extensions/rorca/index.ts`
  - `extensions/rorca/api.ts`
  - `extensions/rorca/args.ts`
  - `extensions/rorca/bridge.ts`
  - `extensions/rorca/commands.ts`
  - `extensions/rorca/format.ts`
  - `extensions/rorca/state.ts`
  - `extensions/rorca/types.ts`
  - `extensions/rorca/watch.ts`
  - `extensions/rorca/pi-runtime.d.ts`

#### Slash commands
Added these Pi slash commands:
- `/rorca-help`
- `/rorca-forge`
- `/rorca-forge-run`
- `/rorca-approve`
- `/rorca-run`
- `/rorca-status`
- `/rorca-watch`
- `/rorca-attach`
- `/rorca-retry`
- `/rorca-mcp-status`

#### Run watch experience
- Added Pi widget/status integration for active Rorca runs
- Added persisted watch state so sessions can resume run monitoring
- Added status transition notifications in Pi

#### MCP tool bridge
- Added automatic Rorca MCP discovery and tool registration into Pi
- Added HTTP MCP initialize/list/call bridge logic
- Added admin-token fallback loading from `~/.rorca/mcp-admin-token`

#### Documentation
- Added a full extension user guide in `packages/rorca-pi-extension/README.md`
- Added a maintainer/publishing guide in `packages/rorca-pi-extension/PUBLISHING.md`
- Added a store-style listing in `packages/rorca-pi-extension/STORE-LISTING.md`
- Added a public-facing launch/announcement page in `packages/rorca-pi-extension/ANNOUNCEMENT.md`

### Changed

#### Rorca chat integration
- Changed `rorca chat` to load the packaged Pi extension directly instead of generating a transient extension file

#### Pi runtime semantics
- Changed Pi-backed pipeline execution so Rorca remains the orchestrator and Pi acts as the execution backend
- Changed Pi worker execution to use stable server skill files plus per-story prompt context
- Changed progress handling to use persistent per-story logs under `.rorca/progress/run-<runId>/`

#### Model selection
- Changed Pi run model selection to prefer locally available Codex-family models when a spec references an unavailable model
- Defaulted Pi extension run flows toward `openai-codex/gpt-5.4` when appropriate

#### Single-story run payloads
- Changed single-story trigger payloads so `storyId` uses `specificStory`
- Prevented single-story jobs from also carrying `startFromStoryId` in the same payload

### Fixed

#### MCP transport compatibility
- Fixed Pi extension MCP bridge initialization and Accept-header behavior
- Fixed MCP bridge protocol/version handshake issues
- Fixed tool bridging so backend-exposed tools can be loaded into Pi successfully

#### Pi model mismatch failures
- Fixed environments where Pi-backed Rorca runs defaulted to Anthropic/Claude models despite local Pi not having Anthropic credentials
- Fixed extension-triggered runs to resolve to working local Pi models instead of failing immediately on unavailable providers

#### Memory persistence
- Fixed `memories.source_run_id` overflow by migrating the column to `BIGINT`
- Fixed dropped spec-memory synthesis by increasing synthesis timeout budget
- Verified memory writes for real Pi-backed runs and real generated specs

#### Draft PR handling
- Fixed invalid `merge_status` writes rejected by DB constraints
- Added PR metadata persistence fallback using `gh pr create`
- Fixed cases where draft-PR success could be logged before a PR number was actually stored

#### Single-story duplication bug
- Fixed the intended single-story path so it now uses explicit `specificStory` semantics
- Verified live exactly-once behavior for fresh single-story Pi runs on the patched path

### Verified in live runtime

The following behaviors were exercised in live verification, not just tests:

- extension-driven forge
- extension-driven approve
- extension-driven Pi run
- MCP bridge tool loading
- Pi model fallback behavior
- memory persistence after Pi runs
- spec-memory persistence after forge
- graph/retrieval context population
- story-level skill injection visibility
- draft PR creation with persisted `pr_number`
- direct merge behavior in a disposable sandbox workspace
- exact-once single-story execution on the patched `specificStory` path

### Testing and validation

Validated with a combination of:
- extension unit tests
- focused backend route tests
- backend typecheck
- project typecheck
- project build
- live backend + worker verification on isolated feature ports
- real Pi extension command execution
- direct DB and WAL inspection of actual runs

### Known limitations

- The package is still marked `private: true` and is currently optimized for in-repo installation rather than registry publishing
- The extension depends on a running Rorca backend and worker for actual execution
- Existing Pi sessions may need restart/reload after installation to pick up the extension
- Some broader backend test suites still have unrelated pre-existing branch issues outside the Pi extension scope
- MCP bridging is additive: slash commands are the primary UX and should continue to work even if the MCP bridge is temporarily unavailable

### Upgrade notes

If upgrading from an earlier internal/stale branch version of the Pi-backed flow:
- restart both the Rorca backend and worker
- restart or reload Pi sessions
- prefer fresh single-story runs to verify `specificStory` behavior
- ensure Pi auth and available local models are configured (`pi --list-models`, `pi auth login` as needed)
