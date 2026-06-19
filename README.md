<p align="center">
  <a href="https://github.com/getrorca/rorca">
    <img src="./public/rorca-mark.svg" alt="Rorca logo" width="96" />
  </a>
</p>

<h1 align="center">Rorca</h1>

<p align="center">
  <strong>Give your AI coding agent long-term memory and a plan.</strong><br>
  Turn plain-English briefs into structured specs, then execute them story-by-story with any agent.
</p>

<p align="center">
  <a href="https://github.com/getrorca/rorca/actions/workflows/ci.yml"><img src="https://github.com/getrorca/rorca/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/status-beta-orange" alt="Status">
  <img src="https://img.shields.io/badge/node-%3E%3D20-green" alt="Node">
  <img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License">
</p>

---

## 🚀 Install

```bash
npm install -g rorca
rorca start
```

Opens the dashboard at http://localhost:5210. That's it.

| Method | Command | Best for |
|--------|---------|----------|
| **npm** | `npm install -g rorca` | Developers with Node.js 20+ |
| **curl** | `curl -fsSL https://raw.githubusercontent.com/getrorca/rorca/main/install.sh \| sh` | Quick one-liner, CI/CD |
| **Docker** | `docker run -d --name rorca -p 5210:5210 -p 3030:3030 getrorca/rorca` | Isolated, reproducible |
| **Docker Compose** | `docker compose up -d` | Local dev with PostgreSQL |
| **Helm** | `helm install rorca oci://ghcr.io/getrorca/helm/rorca` | Kubernetes |
| **Source** | `git clone && npm install && npm run dev` | Contributors |

**[Supabase free tier](docs/supabase-setup.md) supported — zero-cost hosted PostgreSQL in 5 minutes.**

See [QUICKSTART.md](QUICKSTART.md) for all install paths.

---

## The Problem

Your AI coding agent is brilliant but forgetful. Every session it wakes up inside your codebase with no memory of yesterday's work, no project conventions, and no plan beyond the current prompt.

Most AI coding tools are great at taking a single prompt and producing a burst of output. They are terrible at maintaining **project memory**, **team conventions**, **reviewable specs**, and **long-running execution state**.

**Rorca sits one layer above the model.** It gives your agent persistent memory, a structured plan, and a feedback loop that gets smarter over time.

> Rorca helps AI stop acting like it just woke up inside your codebase.

---

## Works With Your Tools

Rorca doesn't replace your AI coding agent — it orchestrates it.

<p align="center">
  <strong>Claude Code</strong> &nbsp;·&nbsp;
  <strong>OpenCode</strong> &nbsp;·&nbsp;
  <strong>Codex</strong> &nbsp;·&nbsp;
  <strong>Hermes Agent</strong> &nbsp;·&nbsp;
  <strong>Pi</strong>
</p>

You bring the agent and your API keys. Rorca provides the memory, the spec, and the execution control plane. Switch agents mid-project — the workflow stays the same.

Rorca connects to every major agent ecosystem through MCP:

| Agent | How to connect |
|-------|---------------|
| **Hermes Agent** (188K ⭐) | `hermes mcp add rorca --url http://localhost:3030/mcp` |
| **Claude Code** | MCP JSON config → `~/.claude/mcp.json` |
| **OpenCode** (160K ⭐) | Built-in execution engine support |
| **OpenClaw** (346K ⭐) | MCP server → `openclaw.json` |
| **Cline** (64K ⭐) | MCP settings → `.cline/mcp_settings.json` |

See [MCP Integration Guide](docs/mcp-integration.md) for all clients.

---

## How It Works

```
1. Brief         2. Spec           3. Review          4. Execute          5. Learn
   ┌─────┐          ┌──────────┐       ┌──────┐           ┌──────────┐         ┌────────┐
   │User │──────────│ Rorca    │───────│Review│───────────│ Execution │─────────│Memory  │
   │brief│          │generates │       │  &   │           │  Engine   │         │Feedback│
   │     │          │  spec    │       │Approve│          │story-by-  │         │        │
   └─────┘          └──────────┘       └──────┘           │  story    │         └────────┘
                                                          └──────────┘
                                                    Claude Code · OpenCode
                                                      Codex · Hermes · Pi
```

**1. Write a brief** — Plain English. "Build a REST API for task management with JWT auth."

**2. Rorca generates a spec** — Structured user stories with acceptance criteria, direction stack with your project conventions, and retrieval-backed context from past work.

**3. Review and approve** — Edit stories, reorder, add constraints. Everything is reviewable before execution.

**4. Execute story-by-story** — Your agent runs each story. Live progress in the dashboard. Worktree-isolated branches. Automatic retries on failure.

**5. Learn from outcomes** — What context helped? What didn't? The retrieval system records telemetry and improves. Every run makes the next one smarter.

---

## Why Rorca Wins

| Capability | Most AI Tools | Rorca |
|-----------|---------------|-------|
| Session memory | ❌ Amnesiac — every prompt starts fresh | ✅ Persistent CAG + RAG + graph retrieval |
| Project conventions | ❌ None — reinvents patterns daily | ✅ Direction Stack (5 layers of project context) |
| Spec-first workflow | ❌ Ad-hoc prompts | ✅ Structured specs with review/approve gate |
| Multi-agent execution | ❌ Single tool lock-in | ✅ Claude Code, OpenCode, Codex, Hermes, Pi |
| Retrieval feedback | ❌ Static context | ✅ Telemetry-driven — improves with every run |
| Team collaboration | ❌ Solo only | ✅ Shared specs, workspaces, worktrees |
| MCP native | ❌ Proprietary | ✅ HTTP MCP — any agent can connect |
| BYOK pricing | ❌ Middleman markup | ✅ Your keys, your subscriptions, no markup |

---

## Skills Marketplace

Rorca ships with skills for **Hermes Agent** (188K+ stars, 90K+ skills hub). Instead of building our own marketplace, Rorca skills are Hermes skills — leveraging the largest open-source agent ecosystem.

| Skill | What it enables |
|-------|----------------|
| `rorca-spec-orchestration` | Create specs, approve, run pipelines via MCP |
| `rorca-memory-retrieval` | Search Rorca's CAG + RAG + graph retrieval stack |
| `rorca-spec-templates` | Pre-built specs: SaaS MVP, CLI tool, REST API, React library, E2E suite |

```bash
# Install from Hermes hub
hermes skills install rorca-spec-orchestration
hermes skills install rorca-memory-retrieval
hermes skills install rorca-spec-templates
```

See [skills/README.md](skills/README.md) for the full strategy — why we publish to existing marketplaces instead of building our own.

---

## Start Here by Surface

Pick how you want to interact with Rorca:

- **CLI** — `rorca start`, `rorca tui`, `rorca forge <brief>`, `rorca run <specSlug>`
- **TUI** — `rorca tui` → `w` to watch, `s` to switch workspace, `Tab` to cycle streams
- **Dashboard** — `rorca start` opens http://localhost:5210 with full UI
- **MCP** — `rorca_create_spec`, `rorca_get_context`, `rorca_pipeline_status`
- **Hermes Agent** — `/skill rorca-spec-orchestration`, then use MCP tools naturally
- **Pi extension** — `/rorca-help`, `/rorca-create-spec`, `/rorca-run`, `/rorca-watch`

---

## Architecture

```text
┌──────────────────────────────────────────────────┐
│ Rorca Surfaces                                   │
│  Dashboard · CLI · TUI · MCP · Hermes Skills     │
└────────────────────┬─────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────┐
│ Express Backend                                  │
│  Specs · Pipeline · Memory · Graph · MCP         │
│  Retrieval feedback · Telemetry                  │
└──────────┬───────────────────────┬───────────────┘
           │                       │
           ▼                       ▼
┌──────────────────────┐  ┌───────────────────────┐
│ PostgreSQL 18         │  │ Execution Engine      │
│  · Specs              │  │  · Claude Code        │
│  · Memories           │  │  · OpenCode           │
│  · Graph evidence     │  │  · Codex              │
│  · Telemetry          │  │  · Hermes Agent       │
│  · Supabase (free)    │  │  · Pi                 │
└──────────────────────┘  └───────────────────────┘
```

**Stack:** React + Vite + Tailwind (frontend :5210) · Express + TypeScript (backend :3030) · PostgreSQL 18 · SSE for live updates

**Database options:**
- **Supabase free tier** — zero-cost hosted PostgreSQL, 500 MB, no credit card ([setup guide](docs/supabase-setup.md))
- **Docker PostgreSQL** — `docker compose up -d` (pgvector + Apache AGE included)
- **Bring your own** — any PostgreSQL 16+ instance

---

## Quickstart (Developers)

### Prerequisites
- Node.js 20+
- PostgreSQL 18 (or Supabase free tier, or Docker)
- One execution agent: Claude Code, OpenCode, Codex, Hermes, or Pi

### Install

```bash
git clone https://github.com/getrorca/rorca.git
cd rorca
npm install && cd backend && npm install && cd ..
```

### Run

```bash
npm run dev
# Dashboard: http://localhost:5210
# API:       http://localhost:3030
# MCP:       http://localhost:3030/mcp
```

### First Workflow

```
1. Register a workspace  →  Point Rorca at any local git repo
2. Add direction layers   →  Engineering principles, architecture, conventions
3. Create a spec          →  Type a brief, Rorca generates structured stories
4. Review and approve     →  Edit, reorder, add constraints
5. Run the work           →  Story-by-story execution with live terminal
6. Learn from outcomes    →  Retrieval feedback improves every run
```

---

## Documentation

| Topic | Link |
|-------|------|
| Install guide (all methods) | [QUICKSTART.md](QUICKSTART.md) |
| Supabase free tier setup | [docs/supabase-setup.md](docs/supabase-setup.md) |
| MCP integration (Hermes, Claude Code, etc.) | [docs/mcp-integration.md](docs/mcp-integration.md) |
| SQLite migration analysis | [docs/sqlite-migration-analysis.md](docs/sqlite-migration-analysis.md) |
| Skills marketplace strategy | [skills/README.md](skills/README.md) |
| API contract | [docs/OPEN_API_CONTRACT.md](docs/OPEN_API_CONTRACT.md) |
| Security model | [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md) |
| Troubleshooting | [docs/troubleshooting.md](docs/troubleshooting.md) |
| Full docs index | [docs/README.md](docs/README.md) |

---

## Community

- **GitHub Discussions:** [github.com/getrorca/rorca/discussions](https://github.com/getrorca/rorca/discussions)
- **Report bugs:** Use the [bug report template](https://github.com/getrorca/rorca/issues/new?template=bug_report.yml)
- **Request features:** Use the [feature request template](https://github.com/getrorca/rorca/issues/new?template=feature_request.yml)
- **Security issues:** [SECURITY.md](SECURITY.md) — private reporting to security@rorca.app
- **Contributing:** [CONTRIBUTING.md](CONTRIBUTING.md) — dev setup, conventions, PR process

---

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [LICENSE-NOTICES.md](LICENSE-NOTICES.md).
