<!--
Copyright (c) 2026 Rorca Inc.
SPDX-License-Identifier: Apache-2.0
Licensed under the Apache License, Version 2.0.
See LICENSE file in the project root for full license text.
-->

# Always-On Universal Context Capture Strategy

Story: UCC-001 — Universal capture strategy, ecosystem benchmark, and compatibility contract.

This document defines the product and engineering contract for Rorca's always-on
universal context capture. The goal is to preserve useful engineering context
from the places developers already work while keeping Rorca local-first,
API-only, redacted, reviewable, provider-neutral, and bounded by explicit user
policy.

## Non-negotiable principles

1. **Local-first control plane** — capture sources emit to the local Rorca
   Express API, normally `http://127.0.0.1:3030`; Rorca remains usable without a
   hosted service.
2. **API-only ingestion** — adapters are passive emitters. They never write
   directly to PostgreSQL, migration tables, memory tables, or graph tables. The
   backend is the only writer.
3. **Canonical safety enforcement** — every proposed event must pass through
   `backend/src/lib/context-safety.ts` as the canonical enforcement layer for
   path allow/deny decisions, `.gitignore`/Rorca ignore handling, size caps,
   content hashing, and redaction. Do not invent a parallel scrubber. The
   marketplace-only `backend/src/lib/spec-sanitizer.ts` scrubber is for public
   spec publication and must not be conflated with general capture redaction.
4. **Reviewable provenance** — captured context carries source, timestamp,
   policy version, content hash, redaction report, and user/workspace origin so
   humans and agents can audit why it exists.
5. **Provider-neutral execution** — capture must work symmetrically with
   Rorca's Claude, OpenCode, and Codex execution paths. No source may depend on
   Claude-only behavior unless the same contract is available to other providers
   through a Rorca adapter or explicit user command.
6. **Explicit policy only** — no hidden capture outside configured policy.
   Defaults should prefer metadata and hashes over raw content, and richer
   content capture must be opt-in per source and workspace.
7. **Sidecar boundary** — no direct DB writes, no secret mutation, no
   provider-native execution changes, no hidden capture outside configured
   policy. This mirrors the existing MCP sidecar boundary: external surfaces may
   submit events to Rorca, but Rorca validates, redacts, stores, indexes, and
   exposes them.

If future implementation adds public or MCP-callable API routes for capture,
each route must include `x-rorca-tier` and `x-rorca-rationale` Swagger
annotations before it can be exposed through MCP. Frontend management UI must use
`src/lib/apiFetch`; non-frontend adapters call the same local API over HTTP and
must not bypass it.

## Capture event contract

Rorca should normalize all sources into one event envelope before persistence or
indexing:

```ts
type CaptureCapabilityStatus = 'active' | 'degraded' | 'disabled' | 'failed';

type CaptureSource =
  | 'repoDaemon'
  | 'gitHook'
  | 'shellIntegration'
  | 'vscodeExtension'
  | 'agentAdapter'
  | 'mcpSlashCommand'
  | 'ciPrIngestion'
  | 'externalImport';

interface CaptureEventEnvelope {
  workspaceId: string;
  source: CaptureSource;
  sourceCapability: CaptureCapabilityStatus;
  occurredAt: string;
  policyVersion: string;
  actor?: 'human' | 'agent' | 'ci' | 'system';
  repo?: { root: string; branch?: string; commit?: string; dirty?: boolean };
  payload: unknown; // source-specific, already minimized before persistence
  contentRefs?: Array<{ path: string; hash: string; byteLength: number }>;
  safety: {
    contextSafetyModule: 'backend/src/lib/context-safety.ts';
    redactionCount: number;
    ignoredPathCount: number;
    truncated: boolean;
    hashAlgorithm: 'sha256';
  };
}
```

`activeRunStatus` and `queuePosition` remain run/queue fields on kanban and run
surfaces; they must not be overloaded to describe capture health. Capture health
gets its own `captureCapability` shape, for example:

```json
{
  "captureCapability": {
    "overall": "degraded",
    "sources": {
      "vscodeExtension": {
        "status": "degraded",
        "reason": "extension_host_unavailable",
        "fallbackSources": ["repoDaemon", "gitHook", "shellIntegration", "ciPrIngestion"]
      },
      "gitHook": { "status": "active" },
      "repoDaemon": { "status": "active" }
    }
  }
}
```

A source is **degraded** when an optional integration is unavailable but another
configured capture layer still provides useful context. It is **failed** only
when a configured source should be emitting but cannot reach the local API,
violates policy unexpectedly, or encounters an internal error that needs
operator action.

## Layered capture model

The architecture is intentionally layered so loss of any one integration reduces
fidelity without stopping capture.

| Layer | Source | What Rorca can capture | What Rorca must not capture | Notes |
| --- | --- | --- | --- | --- |
| 1 | Repo/git daemon | Workspace root, branch, HEAD, dirty state, changed file paths, diff statistics, commit graph deltas, file hashes, policy-visible project files | Ignored paths, oversized content, secrets, untracked private files outside policy, direct DB writes | Background local process watches repo/git state and emits summarized events to the local API. `context-safety.ts` is mandatory before storage/indexing. |
| 2 | Git hooks | `post-commit`, `post-checkout`, `post-merge`, `post-rewrite`, `pre-push` metadata; commit ids; author timestamp; sanitized commit message; changed path list; optional redacted diff summary | Mutation of commits, secret scanning results that reveal secrets, blocked pushes without explicit policy, writes to storage outside API | Hooks should be installable per workspace and removable. They are best-effort emitters; if Rorca is offline, they spool minimal events locally or degrade silently according to policy. |
| 3 | Shell integration | CWD, git branch, command string after redaction, exit code, duration, invoked Rorca slash/MCP command, optional opt-in stdout/stderr snippets | Environment variables, password prompts, raw TTY streams, clipboard, SSH agent material, shell history outside configured workspace/policy | Zsh/bash/fish prompt hooks or wrapper functions emit command lifecycle events. Raw output capture must be opt-in and size-limited. |
| 4 | VS Code-compatible extension | Opened/saved files, active workspace, selection ranges, diagnostics, explicit user annotations, Rorca commands, optional chat-export commands when API exists | Proprietary chat panel internals, keystroke logging, hidden editor telemetry, files outside workspace/policy, direct extension DB writes | See compatibility contract below. Extension posts to local API and displays redaction/capability status. |
| 5 | Agent adapters | Rorca-run prompt envelope, story id, model/provider, tool-call summaries, agent output, WAL/story log snippets, memory-save intent | Provider credentials, provider-native execution modifications, scraping provider UIs, provider-specific hidden state | Adapters cover Claude, OpenCode, Codex, and future providers symmetrically. Capture comes from Rorca's own execution boundary and explicit adapter APIs. |
| 6 | MCP/slash-command bridge | Explicit `rorca_save_memory` calls, `/rorca-*` command invocations, brief/spec/run requests, user-curated notes, imported context summaries | Background scraping of the host, non-Rorca MCP tool traffic unless explicitly forwarded by user policy, token values | MCP and slash commands are the most consentful capture path: user or agent asks Rorca to persist context through a structured operation. |
| 7 | CI/PR ingestion | PR metadata, commit statuses, check runs, build/test summaries, changed paths, review comments, generated artifacts/log excerpts after redaction | CI secrets, full environment dumps, unrestricted logs, mutation of repo secrets, hidden access to private systems | GitHub/GitLab/CI adapters emit through local API/webhook relay. Logs are aggressively capped and redacted. |
| 8 | External import adapters | User-initiated imports from memory files, traces, issue trackers, code-review tools, or exported archives | Continuous third-party scraping without policy, imports that bypass redaction/review, secrets from external systems | Imports are batch capture events with provenance and review queues; they never become a second source of truth. |

### Source-specific capability answers

- **CLIs** — Rorca can capture local command metadata, Rorca CLI invocations,
  exit status, duration, cwd, and opt-in redacted snippets. Rorca cannot capture
  password input, environment secrets, arbitrary terminal history, or another
  CLI's private state unless that CLI exposes an API/hook or the user issues an
  explicit import/save command.
- **IDEs** — Rorca can capture what a standard extension API exposes: workspace,
  file events, diagnostics, selections, explicit commands, and permitted
  content. Rorca cannot inspect private IDE internals or hidden telemetry.
- **VS Code forks** — supported only under the compatibility contract below.
- **Proprietary AI chat panes** — Rorca can capture exported transcripts,
  explicit user commands, public extension APIs, or hook outputs. It cannot
  scrape proprietary panels or claim complete chat memory when the pane exposes
  no API.
- **Git hooks** — Rorca can capture repo state changes and commit/PR metadata.
  Hooks must not mutate secrets, rewrite history, or persist directly.
- **Shell sessions** — Rorca can capture sanitized command lifecycle events for
  configured workspaces. It cannot capture raw TTY streams, hidden prompts,
  clipboard contents, or shell sessions outside policy.
- **CI** — Rorca can capture check status, test/build summaries, PR comments,
  changed paths, and redacted log excerpts. It cannot collect CI secret values
  or mutate provider secrets.
- **Rorca-run providers** — Rorca can capture the prompts, outputs, tool
  summaries, and logs that pass through Rorca's own execution engine. It cannot
  change provider-native execution behavior, scrape provider dashboards, or
  privilege one provider over Claude/OpenCode/Codex symmetry.

## Compatibility contract

Canonical statement: VS Code fork support applies when the fork preserves the standard VS Code extension host/API and extension installation mechanisms; proprietary chat panels are only captured through exposed APIs/hooks or explicit user commands. When an IDE integration is unavailable, shell/git/daemon/CI capture still works and source capability is reported as degraded, not failed. The sidecar boundary is: no direct DB writes, no secret mutation, no provider-native execution changes, no hidden capture outside configured policy.

1. **VS Code forks** — VS Code fork support applies when the fork preserves the
   standard VS Code extension host/API and extension installation mechanisms.
   Forks that break extension installation, disable the extension host, or hide
   needed APIs are outside the supported integration surface.
2. **Proprietary chat panels** — proprietary chat panels are only captured
   through exposed APIs/hooks or explicit user commands. If a fork ships a
   private chat UI with no extension API, Rorca may capture surrounding repo,
   shell, git, and CI context but must not claim chat-pane capture.
3. **IDE unavailable fallback** — when an IDE integration is unavailable,
   shell/git/daemon/CI capture still works and source capability is reported as
   degraded, not failed. In `captureCapability.sources.vscodeExtension`, set
   `status: 'degraded'`, include a machine-readable reason, and list fallback
   sources.
4. **No source-of-truth split** — IDE, shell, git, CI, MCP, and import adapters
   are passive emitters to the local API. The backend validates, redacts, stores,
   indexes, and broadcasts events.
5. **User-visible policy** — every integration must show whether it is active,
   degraded, disabled, or failed; what it is allowed to capture; and how to turn
   it off.

## Ecosystem benchmark and Rorca translation

The table evaluates adjacent tools against Rorca's local-first, API-only,
redacted, reviewable, provider-neutral requirement.

| Tool | Relevant model | What Rorca should emulate | What Rorca should avoid | Integration opportunity |
| --- | --- | --- | --- | --- |
| Pieces | Desktop/local workflow memory with broad context capture and retrieval across apps. | Local-first capture posture, timeline-style provenance, user-facing review of saved snippets. | Opaque always-on capture, binary desktop lock-in, capture that is hard to audit or disable per workspace. | User-initiated import of exported memories/snippets when available; map to external import events with hashes/redactions. |
| Cursor / Windsurf memories | IDE-native AI memories tied to editor/chat experience. | Low-friction project memories, per-workspace suggestions, explicit memory acceptance UX. | Proprietary IDE/chat lock-in, hidden memory writes, assuming chat pane internals are accessible. | VS Code-compatible extension commands can import/export explicit memories; private panes require exposed APIs or explicit user commands. |
| Cline / Roo Memory Bank | Markdown memory files in the repo that agents read/write. | Reviewable repo-local memory artifacts, simple text format, agent-readable conventions. | Unbounded agent writes, lack of redaction/policy enforcement, memory files becoming unsourced truth. | External import adapter for Memory Bank markdown with provenance; optional export to Rorca-reviewed markdown summaries. |
| Continue | Open-source IDE assistant with configurable context providers and multiple model backends. | Provider-neutral adapter abstraction, context-provider interface, transparent configuration. | Assuming IDE extension availability, bypassing Rorca's backend to write state, provider-specific context paths. | Potential integration through Continue context providers, MCP, or explicit commands that POST to local Rorca API. |
| Sourcegraph Cody | Codebase search/indexing and IDE assistant backed by code intelligence. | Cited code retrieval, repo-scale indexing, answer provenance tied to files/symbols. | Hosted indexing as a requirement, broad code upload without local policy, opaque ranking. | Optional Sourcegraph API/import adapter for enterprises already using it; imported citations remain secondary to Rorca's local graph. |
| mem0 | Memory API/service for extracting and retrieving user/agent memories. | Clean memory CRUD/retrieval API and typed memory operations. | SaaS-only memory dependency, black-box extraction, storing raw prompts/secrets without Rorca redaction. | Import/export bridge for user-approved memories; Rorca remains source of truth after ingestion. |
| Zep / Graphiti | Temporal knowledge graph memory with facts, episodes, and relationships. | Temporal graph ideas, provenance on facts, relationship extraction with decay/confidence. | Automatic fact extraction without review, graph writes outside policy, replacing Rorca's DB/graph model. | Batch import of episodes/facts via external import adapter; map confidence/provenance to Rorca memory graph. |
| Letta / MemGPT | Agent memory architecture with working/archival memory and tool-mediated recall. | Separation of working context, archival memory, and explicit memory-management tools. | Agent-runtime lock-in, provider-specific execution changes, autonomous hidden memory edits. | Adapter can ingest explicit memory tool events or exported archives; no provider-native behavior changes. |
| LangSmith / Langfuse | Observability traces, spans, prompts, evals, and feedback. | Trace/span provenance, run-level observability, redaction before persistence, eval linkage. | Capturing full prompts/logs by default, SaaS-only traces, leaking provider credentials or secrets. | CI/agent import adapter for redacted traces; map spans to Rorca run/story events. |
| Glean | Enterprise search connectors with permissions and knowledge graph. | Permission-aware connector mindset, citations, source freshness, enterprise import hygiene. | Cloud-only identity requirement for OSS, over-broad connector sync, bypassing local operator consent. | Optional connector/import path for organizations that already export/search through Glean. |
| Unblocked | Team/code knowledge from PRs, issues, ownership, and Q&A. | PR/decision context, ownership hints, linking discussions to files and commits. | Treating SaaS collaboration data as canonical, importing private discussions without review. | CI/PR ingestion and external import can map PR decisions/comments to Rorca memories with file provenance. |
| Greptile | Repo indexing and AI code review over GitHub PRs. | PR-focused code context, review comments with file/line citations, changed-path prioritization. | Delegating hidden review actions, requiring hosted code indexing, mixing review opinions with source facts. | GitHub PR comment/status import; optional code-review summary ingestion as non-authoritative context. |

## Capture policy and review UX requirements

A future implementation should expose a workspace-level capture policy similar to
this conceptual shape:

```json
{
  "version": "2026-07-ucc-001",
  "enabled": true,
  "sources": {
    "repoDaemon": { "enabled": true, "content": "metadata+hash" },
    "gitHook": { "enabled": true, "content": "metadata+diffSummary" },
    "shellIntegration": { "enabled": true, "content": "commandMetadata", "stdout": "off" },
    "vscodeExtension": { "enabled": true, "content": "explicitSelectionOnly" },
    "agentAdapter": { "enabled": true, "content": "runLogsRedacted" },
    "mcpSlashCommand": { "enabled": true, "content": "explicitOnly" },
    "ciPrIngestion": { "enabled": true, "content": "status+redactedLogSummary" },
    "externalImport": { "enabled": false, "content": "manualImportOnly" }
  },
  "retentionDays": 90,
  "reviewRequiredForRawContent": true
}
```

Review UX must show:

- source capability (`active`, `degraded`, `disabled`, `failed`), including
  fallback sources;
- redaction counts and ignored-path counts from `context-safety.ts`;
- event provenance, hash, and policy version;
- whether raw text, summaries, hashes, or metadata were stored;
- actions to approve, delete, reclassify, or disable a source.

## Engineering notes for implementation

- Proposed local endpoint family: `POST /api/context-capture/events`,
  `GET /api/context-capture/capability`, and
  `GET /api/context-capture/events`. These are design targets only; when
  implemented, annotate each with `x-rorca-tier` and `x-rorca-rationale` and
  use AppError subclasses for route errors.
- Adapters must authenticate to the local API using the same local/operator
  model as other Rorca sidecars. They must never connect to PostgreSQL.
- `context-safety.ts` should be the only module that decides path admissibility,
  ignore handling, size truncation, hashing, and redaction for captured content.
- Raw content capture should default to off except for explicit user selections,
  explicit MCP/slash commands, and Rorca-run artifacts already passing through
  the execution engine.
- Spooling for offline local API should store only minimal, already-redacted
  event envelopes and should expire quickly. Spools must not contain secrets or
  raw terminal streams.
- Rorca should prefer summarized/cited context for prompt injection. Captured
  events are evidence; they do not automatically become prompt text.

## Managed local service lifecycle (UCC-003)

`rorca-capture service <install|start|stop|restart|status|uninstall>` manages the always-on capture daemon for a selected workspace. macOS renders and registers a launchd LaunchAgent, Linux renders and registers a systemd user service, and Windows writes a PowerShell fallback suitable for Task Scheduler or a Startup shortcut. The service wraps `rorca-capture daemon`, starts at login/boot where the platform supports it, and should be restarted after Rorca updates so stale in-memory schemas are replaced.

The daemon uses durable workspace-local files under `.rorca/capture/`: `state.json` stores the WAL cursor, `queue/offline.ndjson` stores already-redacted offline payloads, and `status.json` exposes process health, `last_seen`, last scan, last flush, queue depth, backoff, source capabilities, current policy, and resource bounds. Flushes are attempted only after `GET /api/health` succeeds; failed health checks use bounded exponential backoff. Runtime bounds are configurable with `--scan-interval-ms`, `--max-commits-per-scan`, `--max-concurrency`, `--queue-warn-size`, and `--queue-max-size`. The repo daemon uses bounded polling (no recursive root watcher) and preserves cursor/idempotency across launchd/systemd restarts.

## Agent-specific adapters (UCC-006)

`rorca-capture setup --always-on` now renders thin, reversible adapter artifacts for Pi, Claude Code, Codex, and OpenCode. The files live under `.rorca/capture/adapters/` plus a project-local `.pi/extensions/rorca/capture-command.json` alias. They call `rorca-capture remember` or `POST /api/context-capture/events`; none of them write to PostgreSQL, embed bearer/API token values, or modify provider model/configuration.

Claude Code receives documented slash-command/MCP config that points at `~/.rorca/mcp-token` (path only) and follows the local MCP bearer/OAuth flow. Pi receives a first-class `/rorca-remember`/skill alias that routes through the capture CLI/public API. Codex and OpenCode receive pass-through wrapper scripts; if the native binary is missing the wrappers exit `127` and the setup report marks fallback mode, while normal runs invoke the native binary with unchanged arguments and exit with its exact status. Codex examples use `codex exec --dangerously-bypass-approvals-and-sandbox -m <model>` with prompt content on stdin.

Every adapter command/event includes `source_system`, `tool_name`, and `session_id` metadata so downstream consumers can distinguish Pi, Claude Code, Codex, OpenCode, shell, IDE, and daemon events without inspecting free-form body text.

## Completion checklist for future stories

- Layer-specific adapters all emit through the local API on `:3030`.
- Capability reporting uses `captureCapability` and treats missing optional IDE
  integration as degraded, not failed.
- VS Code-compatible support follows the exact fork compatibility rule above.
- Proprietary chat capture occurs only via exposed APIs/hooks or explicit user
  commands.
- Context safety is centralized in `backend/src/lib/context-safety.ts`.
- No adapter performs direct DB writes, secret mutation, provider-native
  execution changes, or hidden capture outside configured policy.
