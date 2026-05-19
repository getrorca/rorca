# Rorca

**Rorca is an AI spec orchestration platform for autonomous software development.**

It turns a plain-English product brief into a structured spec, helps you review and approve it, then runs the work story-by-story with live progress, retrieval-backed context, and a feedback system that gets smarter over time.

It is designed to feel good across the full Rorca product surface:
- as a **local dashboard** with agent selection for **Claude, OpenCode, and Codex**
- as a **backend control plane** that exposes the same spec and execution model everywhere
- as **CLI and TUI operator surfaces** built on the same forge workflow
- as an **MCP server** for tool-capable clients
- as a **Pi-native operator workflow** through the bundled Pi extension

[![CI](https://github.com/getrorca/rorca/actions/workflows/ci.yml/badge.svg)](https://github.com/getrorca/rorca/actions/workflows/ci.yml)
![Status](https://img.shields.io/badge/status-beta-orange)
![Node](https://img.shields.io/badge/node-%3E%3D20-green)
![License](https://img.shields.io/badge/license-BUSL--1.1-blue)

---

## Start here by surface

If you are new to Rorca, pick the surface that matches how you want to work:

- **CLI** — `rorca start`, `rorca tui`, `rorca forge <brief...>`, `rorca run <specSlug>`
- **TUI** — `rorca tui` → `w` to watch, `s` to switch workspace, `Tab` to cycle streams
- **MCP** — `rorca_create_spec`, `rorca_get_context`, `rorca_pipeline_status`
- **Pi extension** — `/rorca-help`, `/rorca-create-spec`, `/rorca-run`, `/rorca-watch`

If you only remember one command: start with `rorca tui` for the local operator view, or `/rorca-help` inside Pi.

## Why Rorca exists

Most AI coding tools are great at taking a single prompt and producing a burst of output.
They are much worse at maintaining **project memory**, **team conventions**, **reviewable specs**, and **long-running execution state**.

Rorca sits one layer above the model.

It gives you:
- a durable **spec-first workflow**
- a **Direction Stack** for project conventions and architectural context
- backend-native **CAG + RAG + graph retrieval**
- explicit **skill-first spec creation**
- a real **execution engine** for running approved work story-by-story
- **telemetry and retrieval feedback** so context quality can improve over time

The result is simple to describe:

> Rorca helps AI stop acting like it just woke up inside your codebase.

---

## One forge workflow across every Rorca product

Rorca now uses one **skill-first** creation model across the whole product:
- **dashboard + backend** use the shared forge workflow
- **CLI + TUI** use the same persisted spec contract
- **Pi extension** exposes the same flow through slash commands
- **MCP clients** use the same explicit tools

The short version is simple:

> **skills think, MCP/tools fetch and mutate, Rorca persists and orchestrates**

### Canonical paths
- **Create or persist a drafted spec:** `rorca_create_spec` or `POST /api/specs/persist`
- **Use the built-in Rorca forge surfaces:** shared `POST /api/specs/forge` and `POST /api/specs/forge/batch`
- **Use legacy server-side drafting only when intentional:** `rorca_generate_spec` or `POST /api/specs/generate`

### Why this matters
- one spec workflow across UI, backend, CLI, TUI, Pi, and MCP clients
- one canonical persisted spec format
- one retrieval and memory layer
- one execution control plane across multiple CLI paths

### Command reference

| Surface | What to use | Examples |
|---|---|---|
| CLI | Local setup, runs, auth, diagnostics | `rorca start`, `rorca tui`, `rorca forge <brief...>`, `rorca run <specSlug>`, `rorca pi install` |
| TUI | Live board, run watching, workspace switching | `rorca tui` → `w`, `s`, `Tab`, `Esc` |
| MCP | Explicit tool calls from clients and skills | `rorca_create_spec`, `rorca_get_context`, `rorca_pipeline_status` |
| Pi extension | Pi-native slash commands | `/rorca-create-spec`, `/rorca-run`, `/rorca-watch`, `/rorca-mcp-status` |

### Product truth
Skills are the reasoning layer.
MCP and API calls are the reliable control surface.
The backend is the source of truth for persistence, retrieval, telemetry, and execution orchestration.

### Bring your own subscription or key

If you were looking for **BYOK**, the product-level docs usually frame that idea as **BYOA** (Bring Your Own Auth): the user brings the subscription or key that the selected provider CLI needs. See the `/docs/tools` page for the full auth model + provider matrix.

| Provider surface | Auth shape | Public docs cue |
|---|---|---|
| Claude Code | Subscription-backed | Uses your Claude subscription via the Claude CLI; no API key needed. |
| OpenCode | API-key-backed / BYOA | Bring your own provider credentials for the models you choose. |
| Codex CLI | Subscription-backed | Uses your ChatGPT Plus/Pro subscription via the Codex CLI; no API key needed. |
| Pi CLI | Provider-authenticated | Pi manages provider authentication natively. |

The broader app settings also support other provider/model sources for non-execution surfaces, including **Anthropic API**, **OpenAI-compatible**, **OpenRouter**, and **local** paths. The public docs keep the first-class execution story focused on Claude Code, OpenCode, Codex CLI, and Pi CLI, with the Pi extension called out separately as an operator surface.

---

## The mental model

Rorca has three core ideas.

### Direction Stack
A layered prompt/context model that captures global standards, project rules, spec intent, and story-specific annotations.

### Retrieval stack
A backend-native memory system that combines:
- cached context
- text and vector-style memory retrieval
- graph traversal
- scoring, reranking, telemetry, and feedback

### Execution engine
Approved specs become executable work.
Rorca runs them story-by-story through a unified execution engine with live status, logs, retries, and final outcomes.

---

## Architecture at a glance

```text
┌──────────────────────────────────────────────────────────────┐
│ Rorca surfaces                                              │
│  - React dashboard / local app                              │
│  - CLI / TUI operator surfaces                              │
│  - HTTP MCP server                                          │
│  - Pi extension                                             │
└───────────────────────────────┬──────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────┐
│ Express backend                                             │
│  - specs, pipeline, workspaces, memory, graph, MCP          │
│  - shared forge workflow (`/api/specs/forge`)               │
│  - explicit spec contract (`/api/specs/persist`)            │
│  - retrieval telemetry + feedback                           │
└───────────────┬──────────────────────────────┬───────────────┘
                │                              │
                ▼                              ▼
┌─────────────────────────────┐    ┌──────────────────────────┐
│ PostgreSQL 16               │    │ Execution engine         │
│  - specs                    │    │  - Claude Code           │
│  - memories                 │    │  - OpenCode              │
│  - retrieval feedback       │    │  - Codex path            │
│  - telemetry                │    │  - Pi-native execution   │
│  - graph-linked evidence    │    └──────────────────────────┘
└─────────────────────────────┘
```

### Main app stack
- **Frontend:** React + Vite + Tailwind
- **Backend:** Express + PostgreSQL 16
- **Live updates:** SSE
- **Retrieval:** direction stack + memory + graph
- **Execution:** Claude / OpenCode / Codex / Pi-native paths
- **Dashboard agent UX:** the browser UI exposes agent selection for **Claude, OpenCode, and Codex**, with OpenCode model selection available in the forge/run flow

### Default local ports
- frontend: `5210`
- backend: `3030`
- landing page: `3002`

---

## One contract, many front doors

| Surface | Recommended path |
|---|---|
| Dashboard / UI | Built-in shared forge workflow |
| CLI / TUI | Shared forge workflow and persisted spec contract |
| MCP clients | `rorca_create_spec` |
| Pi extension | `/rorca-create-spec` |
| Legacy fallback | `rorca_generate_spec` / `/api/specs/generate` |

### Important truth
If you want **reliable cross-client behavior**, use an **explicit tool or command path**.
Freeform intent routing is helpful, but it is not the contract.

---

## Quickstart

### Prerequisites
- Node.js **20+**
- PostgreSQL **16**
- Git
- one execution path:
  - **Claude Code CLI**
  - **OpenCode**
  - or another configured runtime path

### Install

```bash
git clone https://github.com/getrorca/rorca.git
cd rorca
npm install
cd backend && npm install && cd ..
```

### Run the app

```bash
npm run dev
```

`npm run dev` is the smart default:
- if no backend is running, it starts the local dev stack
- if a healthy backend is already running on `:3030`, it starts the frontend only

Default local services:
- frontend UI: `http://localhost:5210`
- backend API: `http://localhost:3030`
- landing page: `http://localhost:3002`

### Managing frontend, backend, and worker

Rorca is easiest to understand as **three local processes**:
- **frontend** — the React/Vite dashboard
- **backend** — the Express API, MCP surface, and retrieval control plane
- **worker** — the separate pg-boss job runner that executes queued pipeline/spec jobs

#### Start the full dev stack

```bash
npm run dev:full
```

This runs:
- `npm run dev:frontend`
- `npm run dev:server`
- `npm run dev:worker:optional`

#### Run services individually

Frontend only:

```bash
npm run dev:frontend
```

Backend only:

```bash
npm run dev:server
```

Worker only:

```bash
npm run dev:worker
```

#### When to run the worker

You will usually want the worker running when you are:
- executing specs
- processing queued pipeline jobs
- running enrich / match-skills / background spec jobs
- testing the autonomous execution path end-to-end

If you are only doing UI work or light API work, the frontend + backend may be enough.

#### Useful backend-only commands

Run the backend in contract-only mode:

```bash
npm run dev:server:contract
```

Run the backend worker under its restart supervisor:

```bash
cd backend
npm run worker
```

If the backend gets stuck on `:3030`, restart it:

```bash
lsof -ti:3030 | xargs kill -9
cd backend && npm run dev
```

---

## Your first workflow

### 1. Register a workspace
Point Rorca at any local git repo.
Rorca stores the path; it does not copy the project.

### 2. Add context
Use the Direction Stack to describe:
- engineering principles
- architecture
- conventions
- domain rules
- project constraints

### 3. Create a spec
All Rorca products now follow the same basic pattern: use a skill-first forge flow, then persist through the shared Rorca contract.

- **Dashboard / UI:** use **Spec Forge**
- **CLI / TUI:** use the shared forge workflow
- **Pi:** use `/rorca-create-spec`
- **MCP / clients:** use `rorca_create_spec`

### 4. Review and approve
Specs land as pending, then move through review and approval.

### 5. Run the work
Trigger the spec through the pipeline.
Rorca executes stories one by one, tracks outcomes, and streams status live.

### 6. Learn from outcomes
Retrieval selections and execution outcomes feed back into the retrieval feedback system.
That is how the system gets better over time instead of only growing noisier.

---

## Retrieval and GraphRAG, explained simply

Rorca does not treat “memory” as a single blob.
It separates concerns.

### CAG
Cached context and structured direction context.
This is the always-available baseline.

### RAG
Memory retrieval from stored observations, specs, and prior work.
This is where the system pulls relevant past knowledge.

### Graph retrieval
A knowledge graph connects memories, specs, stories, and file evidence.
This helps Rorca surface context that is structurally related, not just textually similar.

### What happens at runtime
For a live retrieval call, Rorca now does roughly this:

1. load direction/context cache
2. search memory candidates
3. optionally traverse graph-linked evidence
4. score and rerank candidates
5. select a compact final context set
6. record telemetry
7. later record outcome usefulness

That is the important point:

> retrieval is not just “search.” It is selection plus feedback.

---

## Execution engine

Rorca has one main execution engine with multiple CLI paths.

### Supported paths
- **Claude**
- **OpenCode**
- **Codex path**
- **Pi-native execution mode**

The important UI truth is that OpenCode is not just a backend capability.
It is exposed in the dashboard through the same forge/run controls used for the other execution paths.

### Why this matters
The spec/review/retrieval/control-plane logic stays consistent even if the execution agent changes.
You are not rewriting your workflow every time you switch models.

---

## MCP integration

Rorca exposes HTTP MCP from the backend.

Typical local endpoint:

```text
http://localhost:3030/mcp
```

### Important tools
- `rorca_create_spec` — preferred explicit drafted-spec path
- `rorca_persist_spec` — compatibility alias
- `rorca_generate_spec` — backend drafting fallback
- `rorca_get_context`
- `rorca_list_specs`
- `rorca_approve_spec`
- `rorca_pipeline_status`
- `rorca_edit_story`
- `rorca_add_stories`
- `rorca_delete_story`

### Why this matters
This is the shared contract behind the dashboard/backend, CLI/TUI, Pi extension, and external clients.
It keeps Rorca's spec, retrieval, and execution behavior consistent without embedding the core orchestration logic into each surface separately.

---

## Pi extension

The easiest install path is:

```bash
rorca pi install
```

That installs the bundled Rorca Pi extension into the current Pi project. Advanced/dev fallback:

```bash
pi install ./packages/rorca-pi-extension -l
```

### Useful Pi commands
- `/rorca-help`
- `/rorca-create-spec`
- `/rorca-forge`
- `/rorca-forge-run`
- `/rorca-approve`
- `/rorca-run`
- `/rorca-status`
- `/rorca-watch`

### Recommended command
Use:

```text
/rorca-create-spec <brief or @file>
```

That is the preferred Pi path because it maps to the same skill-first Rorca contract used across the rest of the product.

If Pi was already open when you installed the extension, run `/reload`. If the commands still do not appear, restart Pi.

For extension-specific details, see:
- `packages/rorca-pi-extension/README.md`

---

## Development

### Useful commands

```bash
npm run dev
npm run build
npm run typecheck
npm run test:pi-extension
npm run auth:test
```

Backend:

```bash
cd backend
npm test
npx tsc --noEmit
```

### Project structure

```text
rorca/
├── src/                         # dashboard frontend
├── backend/                     # API, MCP, retrieval, execution engine
├── landing-page/                # public site
├── packages/                    # extension packages, including Pi extension
├── docs/                        # architecture notes and deep dives
├── forge/                       # local runtime/spec assets
├── default-personas/            # built-in persona overlays
└── scripts/                     # dev and maintenance scripts
```

---

## Self-hosting and local-first behavior

Rorca is built to run locally against real repositories.
That means:
- your workspace is a real git repo
- your specs are real files
- execution is tied to real branches/worktrees
- context can be derived from your actual code, history, and project memory

This is one of the big differences between Rorca and “prompt in a web box, get a response back” tooling.

---

## Troubleshooting

### Frontend shows a Vite module error
If you see a missing Vite chunk or `Cannot find module ... vite/dist/node/chunks/...`, reinstall root dependencies:

```bash
npm install
```

### Backend port already in use
```bash
lsof -ti:3030 | xargs kill -9
```

### Frontend port already in use
```bash
lsof -ti:5210 | xargs kill -9
```

### Pi extension installed but commands are missing
Reinstall through Rorca, then reload Pi:

```bash
rorca pi install
```

Then:
- run `/reload` inside Pi if the session was already open
- restart Pi if the commands still do not appear

### MCP client works inconsistently for spec creation
Prefer the explicit path:
- `rorca_create_spec`
- not freeform prompt inference

---

## Further reading

- `docs/graph-rag-deep-dive.md`
- `docs/graph-rag-implementation-backlog.md`
- `docs/graph-rag-implementation-progress.md`
- `docs/cross-cli-spec-creation-plan.md`
- `packages/rorca-pi-extension/README.md`

---

## License

This repository is currently licensed under the **Business Source License 1.1 (BUSL-1.1)**.
See:
- `LICENSE`
- `LICENSE-NOTICES.md`

If the licensing model changes as the project opens up further, the repository should be updated to reflect that explicitly.
