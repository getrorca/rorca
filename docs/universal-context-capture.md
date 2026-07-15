<!--
Copyright (c) 2026 Rorca Inc.
SPDX-License-Identifier: Apache-2.0
Licensed under the Apache License, Version 2.0.
See LICENSE file in the project root for full license text.
-->

# Always-On Universal Context Capture Strategy

This is the mainline contract after reconciling the production-ready UCC review with the CCS sidecar already on `main`. `packages/rorca-capture` is the single standalone sidecar implementation; `rorca capture` remains a thin alias. UCC policy, multi-source envelopes, queue/distillation, monitoring, adapters, and operator controls extend—not replace—the stable CCS APIs and candidate governance model.

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

## UCC-009 privacy, consent, and audit controls

Always-on setup is opt-in and must include an explicit policy choice:
`off`, `metadata-only`, `repo-and-command`, `ide-assisted`, or `full` explicit-session summaries.
No setup command may silently enable transcript capture by default.

The accepted production baseline, mode-by-mode risk assessment, escalation
criteria, and reversible `repo-and-command` operator procedure are recorded in
[Always-On Capture Policy Baseline](./always-on-capture-policy-decision.md).
`metadata-only` is the default; `repo-and-command` is an explicit workspace
opt-in and does not permit raw terminal or provider transcript capture.

The single operator status surface is `rorca-capture status --workspace-id <id>`
and the Settings → Workspace Context → Capture Status UI. Production alerting,
aggregate failed-job/distillation/audit signals, managed-service checks, and
recovery thresholds are documented in
[Always-On Context production readiness](./always-on-context-production-readiness.md).
Both status surfaces display active integrations, last captured event metadata,
queue depth, redaction policy, ignored paths, pause state, and redaction
diagnostics. Diagnostics are limited
to counts, redaction type names, and regulated-domain flag names; they must not
echo matched secret values or raw payloads.

`rorca-capture pause`, `resume`, and `uninstall --all` are privacy controls, not
UI hints. Pause/resume is enforced at capture queue submission boundaries, and
uninstall removes managed hooks, shell snippets, IDE config, agent adapter
artifacts, and pending capture queue state where possible. Local audit rows may
record only event type, integration id, timestamp, and redaction summary counts
or flag names — never raw captured payloads.

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

`rorca-capture service <install|start|stop|restart|status|uninstall>` manages the always-on capture daemon for a selected workspace. macOS renders and registers a launchd LaunchAgent, Linux renders and registers a systemd user service, and Windows writes a PowerShell fallback suitable for Task Scheduler or a Startup shortcut. The service wraps `rorca-capture daemon`, starts at login/boot where the platform supports it, and should be restarted after Rorca updates so stale in-memory schemas are replaced. On macOS, install is an idempotent definition reload followed by an immediate kickstart, with explicit `HOME`, bounded `PATH`, loopback capture API URL, entrypoint-backed `KeepAlive` demand, and throttling. Use [`always-on-login-readiness.md`](./always-on-login-readiness.md) for the read-only cross-service gate and human-approved reboot smoke checklist.

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

## UCC-011 external memory and trace import adapters

External imports use `backend/src/lib/external-memory-import-adapters.ts`.
The adapter interface is deliberately small: adapters accept a workspace id,
source descriptor, vendor, and first-class `dryRun` flag, then return normalized
`ExternalMemoryImportCandidate` objects. Adapters do not import vendor SDKs at
module load time and do not write to active memory. File adapters use plain file
I/O; API/trace adapters use an injected provider function or dynamically loaded
module so non-users never install every vendor dependency.

Supported concrete adapters:

| Adapter | Vendors / ecosystems | Inputs | Status | Limitations |
| --- | --- | --- | --- | --- |
| `memory-bank-file` | Cline, Roo, Cursor, Windsurf-style memory banks, Continue/Cody/Pieces/custom exports | JSON, JSONL, Markdown | Validated for generic memory-bank shapes | Vendor-specific schemas are normalized heuristically from common `id`, `content/text/summary`, `tags`, `confidence/trust_tier`, and `related_files/files` fields. Proprietary encrypted/local-only stores must be exported by the user first. |
| `trace-memory-api` | mem0, Zep/Graphiti, Letta/MemGPT, LangSmith/Langfuse, Glean, Unblocked, Greptile, Cody/custom API exports | Injected provider or dynamic module returning trace/memory rows | Experimental; covered with mocked provider tests | Rorca ships no required SDKs or credentials. Operators must provide a provider/export function or API-exported rows. Rate limits, pagination, and auth remain vendor-specific. |
| DuckBrain | Existing Rorca support | Existing path | Existing | Not changed by UCC-011. |
| Native proprietary exports without public file/API access | Pieces/Cody/Glean/Greptile variants where no export is available | None | Roadmap | Requires vendor-supported export/API or explicit user-supplied dump. |

Every imported item preserves provenance: `vendor`, `source_file` or
`api_endpoint`, `original_id`, absolute ISO `imported_at`/`occurred_at` when
available, `tags`, `confidence`, US-002 trust-tier vocabulary
(`untrusted|local|verified|privileged`), `related_files`, and
`redaction_diagnostics` from `context-safety.ts`. Idempotency is deterministic:
Rorca derives an external id from `(workspace_id, vendor, original_id)` and a
provenance hash from the sanitized source metadata/content hash; duplicate
`dedupe_key` values are skipped.

The admin endpoint `POST /api/context-capture/imports/{workspaceId}` exposes the
same contract for local operators. It defaults to `dryRun: true`; setting
`dryRun: false` stages rows as canonical `memory_candidates` only, with
`default_retrieval_eligible=false` and `review_status='pending'`. Imports never
write to `memories`, the graph, or retrieval-visible context. Candidate approval
remains on the existing `/api/context-candidates` governance routes.

## Mainline compatibility lab, rollout, and validation runbook

The compatibility lab is intentionally split into automated local checks plus manual smoke scripts for surfaces that are not available in headless CI. The automated entry point is:

```bash
# From the repository root
npm run test:capture
```

That script runs the standalone `packages/rorca-capture` Vitest suite, including dry-run setup, canonical queue/daemon behavior, policy redaction, service rendering, and API-only CLI flows. The VS Code-compatible adapter has its own Vitest config. Backend distillation/route coverage must use a deliberately isolated test database or a no-global-setup unit harness; the repository Jest global setup may recreate its configured `_test` database even when runtime migration flags are set.

### Copy-paste local setup

```bash
# 1. Start a fresh Rorca service. The API server does not hot-reload route/lib changes.
lsof -ti:3030 | xargs -r kill -9
cd backend && RORCA_DISABLE_BACKGROUND_RUNTIME=true npx tsx src/server.ts

# 2. In a second shell, install reversible always-on capture for the current repo.
cd /path/to/your/workspace
rorca-capture setup --always-on --policy metadata-only

# 3. Install/start the managed service for your OS.
rorca-capture service install --workspace-id <workspace-id>
rorca-capture service start --workspace-id <workspace-id>

# 4. Check status and queue health.
rorca-capture status --workspace-id <workspace-id>
```

Use `--policy repo-and-command` only after reviewing the [accepted policy decision](./always-on-capture-policy-decision.md). Raw transcripts are still not enabled by default; richer content requires explicit policy and source support.

### Pause, resume, and uninstall

```bash
# Stop accepting new capture submissions without deleting local setup.
rorca-capture pause --workspace-id <workspace-id>
rorca-capture status --workspace-id <workspace-id>
rorca-capture resume --workspace-id <workspace-id>

# Stop/remove the OS service wrapper.
rorca-capture service stop --workspace-id <workspace-id>
rorca-capture service uninstall --workspace-id <workspace-id>

# Remove generated hooks, shell snippets, adapters, queue, and runtime status files.
rorca-capture teardown --all
```

Uninstall is a privacy control. `teardown --all` may delete pending redacted offline queue entries; inspect the canonical `.rorca-capture-queue.jsonl` first if you need to replay them.

### Adapter installation smoke matrix

Run the applicable commands from a disposable workspace and confirm `rorca-capture status` shows the source as active or degraded with fallback sources:

| Surface | Automated coverage | Manual smoke command |
| --- | --- | --- |
| Pi | E2E verifies `.pi/extensions/rorca/capture-command.json` and agent event distillation. | `pi` then invoke `/rorca-remember` or the generated Pi alias if available. |
| Claude Code | Setup renders Claude Code slash/MCP adapter metadata. | `claude` then invoke the generated `/rorca-remember` command; token path is `~/.rorca/mcp-token`, never an embedded bearer value. |
| Codex | Setup renders pass-through wrapper. | `codex exec --dangerously-bypass-approvals-and-sandbox -m <model>` with a short prompt on stdin; wrapper must preserve exit status. |
| OpenCode | Setup renders pass-through wrapper. | `opencode run` through the generated wrapper; native binary absence should return `127` and report fallback mode. |
| zsh | E2E installs/removes managed startup block. | `SHELL=/bin/zsh rorca-capture setup --always-on --policy metadata-only`, open a new zsh, run `echo rorca-smoke`. |
| bash | Teardown compatibility test covers removal path. | `SHELL=/bin/bash rorca-capture setup --always-on --policy metadata-only`, open bash, run `git status`. |
| fish | Teardown compatibility test covers removal path. | `SHELL=/usr/bin/fish rorca-capture setup --always-on --policy metadata-only`, open fish, run `pwd`. |
| PowerShell | Teardown compatibility test covers removal path. | `pwsh -NoProfile`, run the generated snippet from `.rorca/capture/shell/powershell.ps1`. |
| VS Code | E2E distills a VS Code extension-style editor event. | Install the generated `.vscode/rorca-capture-adapter.json`/extension package, open a file, and run the Rorca capture status command. |
| VSCodium | Documented compatible fork. | Install the VSIX with `codium --install-extension <vsix>`; verify extension host APIs and status command work. |
| Cursor | Manual-only attempted install if locally available. | Try `cursor --install-extension <vsix>` or the UI installer. If chat APIs are unavailable, verify degraded IDE status and repo/shell/git fallback. |
| Windsurf | Manual-only attempted install if locally available. | Try Windsurf's VSIX/extension installer. If proprietary chat APIs are unavailable, verify degraded IDE status and repo/shell/git fallback. |

VS Code fork compatibility means the fork preserves the standard VS Code extension host/API and extension installation mechanism. VSCodium is expected to work when those APIs are present. Cursor and Windsurf are best-effort because local builds may expose standard file/diagnostic APIs while hiding proprietary AI chat panes.

### Privacy model and proprietary chat caveat

Rorca capture remains local-first and API-only. Adapters post to the local Express API; they never write directly to PostgreSQL, migrations, graph tables, or `MEMORY.md`. `backend/src/lib/context-safety.ts` is the canonical redaction and hashing layer. Default setup uses metadata/hash capture, stores already-redacted offline queue entries, and requires human approval before candidates become durable retrieval-visible memories.

Proprietary chat panes cannot be scraped unless the product exposes an API, export, hook, or explicit user command. This is a deliberate limitation, not a bug. When Cursor, Windsurf, or another VS Code-compatible fork blocks chat access, fallback layers continue to capture repo, shell, and git context through the daemon, git hooks, shell integration, CI/PR import, and explicit MCP/slash commands. Capability status should be `degraded` with fallback sources, not `failed`, when those layers remain active.

### Validation checklist

Before release, run or record why each item is unavailable:

```bash
npm run typecheck
npm run test:capture
# Backend: use a no-global-setup unit harness, or explicitly provision an isolated disposable _test database.
npx vitest run --config packages/rorca-capture/vitest.config.ts
npx vitest run --config packages/rorca-pi-extension/vscode-extension/vitest.config.ts
npm run lint:tier
npm run lint:swagger
npm run check:contract
npm run build
```

Caveats:

- Do not run backend Jest or `npm test` against a live database. `JEST_SKIP_RUNTIME_MIGRATIONS=true` does not bypass this repository's global test-database recreation; use a no-global-setup unit harness or an explicitly disposable isolated `_test` database.
- Backend `tsc` excludes `__tests__`; for compile-only test validation, run focused Jest or an explicit test-file TypeScript command before declaring test code green.
- `npm run lint:swagger` and `npm run lint:tier` currently fail in some `tsx` ESM contexts because `__dirname` resolves to an empty spec. If that occurs, run the compiled/node equivalent or document the blocked attempt; do not hide the failure inside the E2E suite.
- Public contract checks remain required to prove the existing CCS public surface did not drift. The new `/api/context-capture` operations are operator `admin`/`auth` routes and intentionally are not marked `x-rorca-public-api`.
- After any E2E/manual validation, confirm no long-running processes remain: `pgrep -fl 'tsx src/(server|worker)\.ts|rorca-capture|extensionHost'` and stop leftovers before handing off.

### Troubleshooting

- **Setup cannot find the workspace**: register the repository in Rorca, then rerun setup from inside that repository or pass `--workspace-id`.
- **MCP token failure**: create/repair `~/.rorca/mcp-token` and ensure POSIX mode `600` (`chmod 600 ~/.rorca/mcp-token`).
- **Queue grows while offline**: start the API, run `rorca-capture status`, then verify `GET /api/health` succeeds. Offline queue payloads are already redacted but should still be treated as local operator data.
- **Stale API routes after code changes**: kill and restart `tsx src/server.ts`; the backend does not hot-reload.
- **Graph/search_path oddities after AGE tests**: verify graph code restores `SET search_path = rorca, public` after `LOAD 'age'` before reusing pooled connections.
- **pg-boss E2E enqueue returns null**: create queues before `send()` (`await boss.createQueue('queue:name')`) and call `boss.stop()` in teardown.
