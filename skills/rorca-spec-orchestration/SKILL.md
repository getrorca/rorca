---
name: rorca-spec-orchestration
description: "Use Rorca's spec orchestration tools — create specs, approve, run pipelines. Requires Rorca MCP server running at localhost:3030/mcp."
version: 1.0.0
author: Rorca + Hermes Agent
license: Apache-2.0
tags: [rorca, spec, orchestration, pipeline, ai, development]
---

# Rorca Spec Orchestration

Rorca is an AI spec orchestration platform. This skill gives you access to Rorca's MCP tools for creating specs, managing pipelines, and running autonomous development workflows.

## Prerequisites

Rorca must be running with its MCP server enabled:
```bash
rorca start
# MCP server at http://localhost:3030/mcp
```

Then register it in Hermes:
```bash
hermes mcp add rorca --url http://localhost:3030/mcp
hermes mcp test rorca
```

## Available MCP Tools

Once connected, these tools become available:

### Spec Management
- `rorca_create_spec` — Create a new spec from a brief (preferred path)
- `rorca_list_specs` — List all specs with status
- `rorca_approve_spec` — Approve a spec for execution
- `rorca_get_context` — Get retrieval-backed context for a spec

### Pipeline
- `rorca_pipeline_status` — Check pipeline run status
- `rorca_pipeline_trigger` — Trigger a spec to run

### Story Management
- `rorca_edit_story` — Edit individual stories in a spec
- `rorca_add_stories` — Add new stories to a spec
- `rorca_delete_story` — Remove a story

## Workflow

### 1. Create a spec
```
Use rorca_create_spec with your project brief. Rorca generates a structured spec with user stories, acceptance criteria, and a direction stack.
```

### 2. Review and approve
```
Use rorca_list_specs to find your spec, review the generated stories, edit with rorca_edit_story if needed, then rorca_approve_spec.
```

### 3. Run the work
```
Use rorca_pipeline_trigger to start execution. Stories run one by one through your configured agent (Claude Code, OpenCode, Codex, or Pi).
```

### 4. Monitor progress
```
Use rorca_pipeline_status to check progress. The dashboard at http://localhost:5210 shows live terminal output.
```

## Tips

- **Direction Stack matters** — add project conventions before creating specs. The better your direction, the better the spec.
- **Iterate on stories** — after a run, use learnings to refine stories for the next run.
- **Workspace isolation** — each Rorca workspace maps to a git repo. Register them before creating specs.
- **Agent selection** — choose the agent that matches your project: OpenCode for model flexibility, Claude Code for quality, Codex for ChatGPT subscribers.
