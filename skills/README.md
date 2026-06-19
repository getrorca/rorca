# Rorca Skills for Hermes Agent

Rorca ships with skills that work in [Hermes Agent](https://github.com/NousResearch/hermes-agent) — the #2 open-source AI agent framework (188K+ GitHub stars).

Instead of building and maintaining our own marketplace, **Rorca skills are Hermes skills.** They plug directly into the 90,000+ skill ecosystem.

## Available Skills

| Skill | What it does |
|-------|-------------|
| `rorca-spec-orchestration` | Create specs, approve, run pipelines via MCP |
| `rorca-memory-retrieval` | Search and inject context from Rorca's retrieval stack |
| `rorca-spec-templates` | Pre-built spec templates for common project types |

## How It Works

```
Hermes Agent ←→ MCP ←→ Rorca Backend
     │                    │
     │  rorca_create_spec │
     │  rorca_approve     │──→ PostgreSQL (specs, memories)
     │  rorca_pipeline    │
     │  rorca_get_context │──→ Execution Engine (Claude/OpenCode/Codex/Pi)
```

Rorca exposes its tools via MCP (Model Context Protocol) at `http://localhost:3030/mcp`. Hermes discovers these tools through `hermes mcp add rorca --url http://localhost:3030/mcp`. The skills provide the reasoning layer — they guide Hermes on WHEN and HOW to use Rorca's tools.

## Install

### 1. Start Rorca
```bash
npm install -g rorca
rorca start
```

### 2. Register Rorca's MCP in Hermes
```bash
hermes mcp add rorca --url http://localhost:3030/mcp
hermes mcp test rorca
# Should show: rorca_create_spec, rorca_list_specs, rorca_approve_spec, ...
```

### 3. Install skills from the Hermes hub
```bash
hermes skills install rorca-spec-orchestration
hermes skills install rorca-memory-retrieval
hermes skills install rorca-spec-templates
```

Or install from this repo:
```bash
hermes skills install https://raw.githubusercontent.com/getrorca/rorca/main/skills/rorca-spec-orchestration/SKILL.md
```

### 4. Use in conversation
```
You: Create a spec for a React dashboard with user auth
Hermes: [loads rorca-spec-orchestration, calls rorca_create_spec]
        → Spec created! 12 stories, pending review.
```

## Why Hermes Skills Instead of Our Own Marketplace

| Approach | Maintenance | Reach | Network Effect |
|----------|------------|-------|----------------|
| **Build our own marketplace** | High — UI, moderation, hosting, discovery | 0 users today | Starting from zero |
| **Publish to Hermes hub** | Zero — Hermes handles everything | 188K+ Hermes users | 90K+ existing skills |

Hermes already has:
- `hermes skills publish` — one-command publishing
- `hermes skills search` — discovery with FTS5
- `hermes skills install` — one-command install
- `hermes skills update` — automatic updates
- Skills hub with 90,000+ community contributions

Rorca skills are just Hermes skills that wrap Rorca's MCP tools. No new infrastructure needed.

## Also Works With OpenClaw

Rorca's MCP server can be registered in OpenClaw (346K+ stars) the same way:

```json
{
  "mcpServers": {
    "rorca": {
      "url": "http://localhost:3030/mcp"
    }
  }
}
```

## Publishing to Hermes Hub

When ready to publish:
```bash
cd skills/rorca-spec-orchestration
hermes skills publish SKILL.md
```

## Creating New Rorca Skills

Skills follow the Hermes Agent skill format:

```markdown
---
name: rorca-my-skill
description: "What this skill does"
version: 1.0.0
author: Your Name
license: Apache-2.0
tags: [rorca, custom]
---

# My Rorca Skill

Description and instructions for Hermes on how to use Rorca's MCP tools
for a specific workflow.
```

Place in `skills/<name>/SKILL.md` and submit a PR to this repo.
