# Rorcha

**AI spec orchestration for autonomous development.** Rorcha is a standalone dashboard that turns a plain-English brief into a validated, structured spec — then tracks it through approval, execution, and archival. It works with any git repository and integrates with Claude Code via MCP.

![Status](https://img.shields.io/badge/status-beta-orange) ![Node](https://img.shields.io/badge/node-%3E%3D18-green) ![License](https://img.shields.io/badge/license-MIT-blue)

---

## What it does

You give Rorcha a brief: *"Add OAuth login with Google and GitHub."* It synthesizes everything it knows about your project — your architecture, tech stack, existing patterns — and produces a spec with 8–12 user stories, each with acceptance criteria and a dependency graph. You review and approve it. Then the Ralph Loop runs story-by-story and Rorcha tracks progress in real time.

The key concept is the **Direction Stack**: a 5-layer context cascade (like CSS specificity, but for AI prompts) that makes every generated spec aware of your global engineering standards, domain conventions, and project specifics — without you having to repeat yourself every time.

---

## Architecture overview

```
┌─────────────────────────────────────────────────────────┐
│  Rorcha Dashboard (React, port 5210)                     │
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
    │ rorcha.db    │    │  (your subscription) │
    └──────────────┘    └─────────────────────┘
```

**Backend**: Express.js + SQLite (`better-sqlite3`, WAL mode)
**Frontend**: React 18 + TypeScript + Vite + Tailwind CSS
**LLM**: Your Claude subscription via `claude --print` — no API key required
**MCP**: 5 tools that expose Rorcha to Claude Code for in-session spec generation

---

## Prerequisites

- **Node.js** 18 or later
- **Claude Code CLI** installed and authenticated (`claude --version`)
- **Git** (for workspace registration and git hydration)

---

## Installation

```bash
git clone https://github.com/your-org/rorcha.git
cd rorcha
npm install
cd backend && npm install && cd ..
```

No API keys needed. Rorcha uses your Claude subscription via the `claude` CLI.

---

## Running Rorcha

```bash
npm run dev
```

This starts both servers concurrently:

- **Frontend**: http://localhost:5210
- **Backend API**: http://localhost:3030

---

## The Direction Stack

The Direction Stack is how Rorcha makes every spec context-aware. It's a 5-layer cascade where lower layers override higher ones — the same mental model as CSS specificity:

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

In the sidebar, click **+ Add Workspace** and point it at any local git repository. Rorcha reads the path — it doesn't move or copy files.

### 2. Hydrate context (optional but recommended)

After registering, Rorcha can automatically extract context from:

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
3. Click **Generate** — Rorcha synthesizes your Direction Stack and calls Claude to produce a structured spec with user stories, acceptance criteria, and a Mermaid dependency diagram

### 5. Review and approve

The generated spec appears in the **Review Queue**. Read through the stories, check the diagram, inspect the raw JSON. When satisfied, click **Approve** — the spec moves to `specs/approved/` in your workspace directory.

### 6. Run the Ralph Loop

From your workspace directory:

```bash
/path/to/cashflow-app/scripts/ralph/run-loop.sh --json specs/approved/your-spec.json
```

Or use `rorcha_approve_spec` from Claude Code (see MCP section) — it prints the exact command.

### 7. Monitor progress

The **Pipeline Monitor** panel streams live story-by-story progress via SSE as the Ralph Loop runs. Each story shows status, elapsed time, and expandable log output.

### 8. Review history

The **Archive** panel shows all completed runs with full-text search across spec names, story titles, and acceptance criteria.

---

## MCP Integration (Claude Code)

Rorcha exposes 5 tools to Claude Code via the Model Context Protocol. This lets you generate and approve specs without leaving your editor.

### Setup

```bash
claude mcp add rorcha -- npx tsx /absolute/path/to/rorcha/backend/src/mcp/server.ts
```

Verify it connected:

```bash
claude mcp list
```

### Available tools

| Tool | What it does |
|------|-------------|
| `rorcha_get_context` | Synthesize and inject your full Direction Stack into the current Claude session |
| `rorcha_generate_spec` | Generate a spec from a brief using your workspace's Direction Stack |
| `rorcha_list_specs` | List pending or approved specs for a workspace |
| `rorcha_approve_spec` | Approve a pending spec and get the exact run-loop command |
| `rorcha_pipeline_status` | Check live status of an active or recent pipeline run |

### Example usage in Claude Code

```
Use rorcha_get_context for my project at /Users/me/myapp, then generate
a spec for "Add Stripe subscription billing with monthly and annual plans"
```

Claude will inject your full Direction Stack, generate a structured spec aware of your existing codebase, and return the story list directly in the conversation.

---

## Git Worktrees

The **Worktrees** panel manages git worktrees for your registered workspaces. Each spec can run in its own worktree so multiple specs can be in-progress simultaneously without conflicts.

Create a worktree from the panel — Rorcha creates the branch and directory. The panel shows branch status, ahead/behind counts, and modified files in real time.

---

## Self-hosting

Rorcha can register its own repository as a workspace and generate specs for its own features:

```bash
npm run self-register
```

This registers `~/rorcha/` in Rorcha's SQLite database, seeds the Direction Stack with Rorcha's own architecture context, and verifies the full loop end-to-end on Rorcha's own codebase.

---

## Development

### Project structure

```
rorcha/
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
│   └── rorcha.db             # SQLite database (auto-created)
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
npm run self-register    # Register ~/rorcha/ as its own workspace
```

### Database

SQLite at `backend/rorcha.db`, auto-created on first run. Tables:

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
claude mcp remove rorcha
claude mcp add rorcha -- npx tsx /absolute/path/to/rorcha/backend/src/mcp/server.ts
```

**Pipeline Monitor not updating**
The SSE connection opens on panel mount. Navigate away and back to reconnect.

---

## License

MIT
