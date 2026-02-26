# Rorca

**AI spec orchestration for autonomous development.** Rorca is a standalone dashboard that turns a plain-English brief into a validated, structured spec — then tracks it through approval, execution, and archival. It works with any git repository and integrates with Claude Code via MCP.

![Status](https://img.shields.io/badge/status-beta-orange) ![Node](https://img.shields.io/badge/node-%3E%3D18-green) ![License](https://img.shields.io/badge/license-MIT-blue)

---

## What it does

You give Rorca a brief: *"Add OAuth login with Google and GitHub."* It synthesizes everything it knows about your project — your architecture, tech stack, existing patterns — and produces a spec with 8–12 user stories, each with acceptance criteria and a dependency graph. You review and approve it. Then the Ralph Loop runs story-by-story and Rorca tracks progress in real time.

The key concept is the **Direction Stack**: a 5-layer context cascade (like CSS specificity, but for AI prompts) that makes every generated spec aware of your global engineering standards, domain conventions, and project specifics — without you having to repeat yourself every time.

---

## Architecture overview

```
┌─────────────────────────────────────────────────────────┐
│  Rorca Dashboard (React, port 5210)                     │
│  ┌──────────┐ ┌───────────┐ ┌──────────┐ ┌──────────┐  │
│  │ Spec     │ │ Direction │ │ Review   │ │ Pipeline │  │
│  │ Forge    │ │ Stack     │ │ Queue    │ │ Monitor  │  │
│  └──────────┘ └───────────┘ └──────────┘ └──────────┘  │
│  ┌──────────┐ ┌───────────┐                             │
│  │Worktrees │ │ Archive   │                             │
│  └──────────┘ └───────────┘                             │
└───────────────────────┬─────────────────────────────────┘
                        │ REST + SSE
┌───────────────────────▼─────────────────────────────────┐
│  Express API (port 3030)                                 │
│  /api/workspaces  /api/direction  /api/specs             │
│  /api/pipeline    /api/worktrees  /api/context           │
└───────────┬──────────────────────┬──────────────────────┘
            │                      │
    ┌───────▼──────┐    ┌──────────▼──────────┐
    │ SQLite (WAL) │    │  claude --print      │
    │ rorca.db    │    │  (your subscription) │
    └──────────────┘    └─────────────────────┘
```

**Backend**: Express.js + SQLite (`better-sqlite3`, WAL mode)
**Frontend**: React 18 + TypeScript + Vite + Tailwind CSS
**LLM**: Your Claude subscription via `claude --print` — no API key required
**MCP**: 5 tools that expose Rorca to Claude Code for in-session spec generation

---

## Prerequisites

- **Node.js** 18 or later
- **Claude Code CLI** installed and authenticated (`claude --version`)
- **Git** (for workspace registration and git hydration)

---

## Installation

```bash
git clone https://github.com/your-org/rorca.git
cd rorca
npm install
cd backend && npm install && cd ..
```

No API keys needed. Rorca uses your Claude subscription via the `claude` CLI.

---

## Running Rorca

```bash
npm run dev
```

This starts both servers concurrently:

- **Frontend**: http://localhost:5210
- **Backend API**: http://localhost:3030

---

## The Direction Stack

The Direction Stack is how Rorca makes every spec context-aware. It's a 5-layer cascade where lower layers override higher ones — the same mental model as CSS specificity:

| Layer | Name | Scope | Example content |
|-------|------|-------|-----------------|
| L1 | Global Brain | All workspaces | Engineering principles, preferred libraries, code style |
| L2 | Domain Profile | Domain (e.g. "saas", "api") | Auth patterns, API conventions, error handling |
| L3 | Project Brief | One workspace | Stack, architecture decisions, key constraints |
| L4 | Spec Brief | One spec generation | What this feature is and why |
| L5 | Story Annotations | One story | Edge cases, known gotchas, reviewer notes |

L1–L2 are shared globals. L3 and below are set per workspace in the **Direction Stack** panel. When you generate a spec, all applicable layers are synthesized into a single context that guides the LLM.

**Why YAML?** Direction Stack layers are stored as YAML because it survives LLM prompt injection cleanly, supports key-level merging across layers, and is human-readable enough to edit directly in the UI.

---

## Workflow

### 1. Register a workspace

In the sidebar, click **+ Add Workspace** and point it at any local git repository. Rorca reads the path — it doesn't move or copy files.

### 2. Hydrate context (optional but recommended)

After registering, Rorca can automatically extract context from:

- **Git history** — map/reduce over commit log to build a `memory.yaml` of what was built and when
- **Database schema** — reads SQL migration files, extracts table/column structure

Run hydration from the **Direction Stack** panel → **Hydrate** tab.

### 3. Fill in your Direction Stack

In the **Direction Stack** panel, add L1–L3 content for your workspace. You can:

- Type or paste YAML directly
- Use the **Bootstrap Context** modal for guided input (Q&A wizard, file upload, URL fetch, or multi-source)

### 4. Generate a spec

Go to **Spec Forge**:

1. Select your workspace
2. Write a brief (one paragraph is enough)
3. Click **Generate** — Rorca synthesizes your Direction Stack and calls Claude to produce a structured spec with user stories, acceptance criteria, and a Mermaid dependency diagram

### 5. Review and approve

The generated spec appears in the **Review Queue**. Read through the stories, check the diagram, inspect the raw JSON. When satisfied, click **Approve** — the spec moves to `specs/approved/` in your workspace directory.

### 6. Run the Ralph Loop

**From the UI (recommended):** Open the **Archive** panel, click any approved spec to expand the drawer, then click **Run in Pipeline**. Rorca finds `scripts/run-loop.sh` in the registered workspace directory and spawns it automatically — no terminal needed.

If a run is already active for that workspace, Rorca detects the conflict and prompts: *"Run in a new worktree instead?"* Clicking **Run in worktree** creates a fresh git worktree branch (e.g. `feat/my-spec-1234567890`) and runs the loop there in parallel.

**From the terminal** (also works):
```bash
/path/to/workspace/scripts/run-loop.sh --json specs/approved/your-spec.json
```

Or use `rorca_approve_spec` from Claude Code (see MCP section) — it prints the exact command.

### 7. Monitor progress

The **Pipeline Monitor** panel streams live story-by-story progress via SSE as the Ralph Loop runs. Each story shows status, elapsed time, and expandable log output.

After clicking **Run in Pipeline**, Rorca automatically navigates you to Pipeline Monitor once the run starts.

### 8. Merge worktrees

When a spec running in a dedicated worktree is complete, open the **Worktrees** panel, select the worktree branch, and click **Merge to main**. Rorca runs a `--no-ff` merge into your main branch. If there are merge conflicts, an inline error appears with the conflict details so you can resolve them manually.

### 9. Review history

The **Archive** panel shows all completed runs with full-text search across spec names, story titles, and acceptance criteria.

---

## MCP Integration (Claude Code)

Rorca exposes 5 tools to Claude Code via the Model Context Protocol. This lets you generate and approve specs without leaving your editor.

### Setup

```bash
claude mcp add rorca -- npx tsx /absolute/path/to/rorca/backend/src/mcp/server.ts
```

Verify it connected:

```bash
claude mcp list
```

### Available tools

| Tool | What it does |
|------|-------------|
| `rorca_get_context` | Synthesize and inject your full Direction Stack into the current Claude session |
| `rorca_generate_spec` | Generate a spec from a brief using your workspace's Direction Stack |
| `rorca_list_specs` | List pending or approved specs for a workspace |
| `rorca_approve_spec` | Approve a pending spec and get the exact run-loop command |
| `rorca_pipeline_status` | Check live status of an active or recent pipeline run |

### Example usage in Claude Code

```
Use rorca_get_context for my project at /Users/me/myapp, then generate
a spec for "Add Stripe subscription billing with monthly and annual plans"
```

Claude will inject your full Direction Stack, generate a structured spec aware of your existing codebase, and return the story list directly in the conversation.

---

## Multi-Workspace & Parallel Runs

Rorca's `workspaces` table stores the filesystem `path` of each registered project (e.g. `/Users/me/cashflow-app`, `/Users/me/rorca`). When you trigger a run, the backend resolves `scripts/run-loop.sh` from that path and runs it in the correct project directory — so any workspace can run its own loop without any manual path configuration.

Multiple specs can run simultaneously:
- **Different workspaces**: Each has its own `pipeline_runs` row, its own spawned process, and its own SSE stream.
- **Same workspace, multiple specs**: Rorca detects the active run and prompts you to use a worktree, keeping both specs isolated in parallel git branches.

## Git Worktrees

The **Worktrees** panel manages git worktrees for your registered workspaces. Each spec can run in its own worktree so multiple specs can be in-progress simultaneously without conflicts.

You can create worktrees manually from the panel, or let Rorca create them automatically when you trigger a run and a conflict is detected. The panel shows branch status, ahead/behind counts, and modified files for each worktree.

When a worktree branch is ready to land, click **Merge to main** in the detail panel. Rorca merges with `--no-ff` into the workspace's main branch. Merge conflicts surface inline so you know exactly what needs resolution.

---

## Self-hosting

Rorca can register its own repository as a workspace and generate specs for its own features:

```bash
npm run self-register
```

This registers `~/rorca/` in Rorca's SQLite database, seeds the Direction Stack with Rorca's own architecture context, and verifies the full loop end-to-end on Rorca's own codebase.

---

## Development

### Project structure

```
rorca/
├── src/                      # React frontend
│   ├── panels/               # Six main panel components
│   ├── components/           # Shared UI components
│   ├── contexts/             # WorkspaceContext
│   └── hooks/                # usePipelineSSE, etc.
├── backend/
│   ├── src/
│   │   ├── routes/           # Express route handlers
│   │   ├── lib/              # Core services (see below)
│   │   ├── mcp/              # MCP stdio server
│   │   └── db/
│   │       └── migrations/   # SQLite migration files
│   └── rorca.db             # SQLite database (auto-created)
└── scripts/
    └── self-register.ts      # Self-hosting bootstrap
```

### Core services (`backend/src/lib/`)

| Service | What it does |
|---------|-------------|
| `llm-client.ts` | Calls `claude --print` (your subscription) — no API key needed |
| `direction-stack.ts` | Synthesizes L1–L5 layers into a single context string |
| `spec-writer.ts` | Parses LLM output and writes spec JSON to `specs/` |
| `context-extractor.ts` | Multi-source context ingestion (paste, file, URL, Q&A) |
| `git-hydrator.ts` | Map/reduce over git history → `memory.yaml` |
| `schema-hydrator.ts` | Parses SQL migrations → schema YAML |
| `sse-hub.ts` | In-process pub/sub for Server-Sent Events |

### Commands

```bash
# Development
npm run dev              # Start frontend (5210) + backend (3030)
npm run build            # Production build
npm run typecheck        # TypeScript check (frontend + backend)

# Backend
cd backend
npm test                 # Jest test suite
npm run mcp              # Run MCP server standalone (for debugging)

# Self-hosting
npm run self-register    # Register ~/rorca/ as its own workspace
```

---

## The Ralph Loop (`scripts/run-loop.sh`)

`run-loop.sh` is the execution engine that drives Claude Code story-by-story through a spec. It lives in the **project workspace** (e.g. your app's repo), not in Rorca itself.

### CLI usage

```bash
./scripts/run-loop.sh                                          # Run next pending story (prd-implement.json)
./scripts/run-loop.sh --json specs/approved/my-spec.json      # Relative path (resolved from scripts/)
./scripts/run-loop.sh --json /abs/path/to/my-spec.json        # Absolute path (from UI trigger)
./scripts/run-loop.sh --story US-005                          # Run a specific story by ID
./scripts/run-loop.sh --dry-run                               # Preview next story without running
```

### Context files (auto-discovered in the project working directory)

When the loop runs, it looks for these files in the workspace root and includes them automatically — no manual configuration needed:

| File | Where it's used |
|------|----------------|
| `CLAUDE.md` | Injected into every story prompt — architecture, gotchas, critical conventions |
| `.claude/skills/rorca.md` | Workflow skill injected into implementation mode prompts (falls back to `dimitri.md`) |
| `AGENTS.md` | Referenced in the skill prompt — agents read directory-level `AGENTS.md` before touching code |
| `progress.txt` | Read at start of each story so Claude can resume without re-loading context after compaction |

The skill (`rorca.md` / `dimitri.md`) instructs the agent to: check `progress.txt` first, use subagents for codebase research, run type checks + lint + build after every story, and write back to `progress.txt` on completion.

### Modes (auto-detected from JSON structure)

| Mode | JSON shape | Behavior |
|------|-----------|----------|
| **Implementation** | `{ userStories: [...] }` | Uses `rorca.md`/`dimitri.md` skill, writes `feat:` commits |
| **QA** | `{ phases: [{ stories: [...] }] }` | Test-writing focused prompt, references playbook, `test:` commits |

### Process isolation

Each story invocation gets a completely fresh Claude context — no conversation accumulates between stories. Claude Code environment variables (`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_AGENT_SDK_VERSION`, `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING`) are stripped before spawning so nested invocations work when run from inside Claude Code itself.

A 45-minute per-story timeout is enforced via `gtimeout --foreground` (macOS: `brew install coreutils`). Failed stories are retried up to 2× before being skipped.

### Database

SQLite at `backend/rorca.db`, auto-created on first run. Tables:

| Table | Purpose |
|-------|---------|
| `workspaces` | Registered git repositories |
| `direction_layers` | Direction Stack content per workspace |
| `pipeline_runs` | Ralph Loop execution history |
| `story_results` | Per-story pass/fail/skip outcomes |
| `wal_events` | Event log (spec_generated, approved, run_started, story_passed, etc.) |
| `workspace_context` | Cached git memory and schema snapshots |

WAL mode and foreign key constraints are enabled on every connection.

---

## Troubleshooting

**`claude: command not found` when generating specs**
Ensure Claude Code is installed and on your PATH: `which claude`

**Backend fails to start**
Port 3030 may be in use: `lsof -ti:3030 | xargs kill -9`

**Spec generation returns empty output**
The `claude --print` call has a 2-minute timeout. Try a shorter brief, or test the CLI directly: `claude --print "hello"`

**MCP tools not appearing in Claude Code**
The path must be absolute. Re-add with the full path:
```bash
claude mcp remove rorca
claude mcp add rorca -- npx tsx /absolute/path/to/rorca/backend/src/mcp/server.ts
```

**Pipeline Monitor not updating**
The SSE connection opens on panel mount. Navigate away and back to reconnect.

**"Run in Pipeline" button not visible**
The button only appears for approved specs (those in `specs/approved/`). Specs still in `specs/pending/` show no run button — approve them via the Review Queue first.

**"Run in Pipeline" fails with 422**
`scripts/run-loop.sh` was not found in the registered workspace path. Make sure the workspace you selected has `scripts/run-loop.sh` checked in and the workspace `path` in Rorca points to the correct project root.

**Merge to main conflicts**
Rorca will show the conflict details inline. Resolve conflicts manually in the worktree directory, commit the resolution, then re-attempt the merge — or discard the worktree if you want to start fresh.

---

## License

MIT
