---
name: rorca-memory-retrieval
description: "Use Rorca's retrieval-augmented memory — search, recall, and inject context from past specs and runs. Requires Rorca MCP server."
version: 1.0.0
author: Rorca + Hermes Agent
license: Apache-2.0
tags: [rorca, memory, retrieval, context, rag, graph]
---

# Rorca Memory & Retrieval

Rorca's retrieval stack combines CAG (cached context), RAG (memory retrieval), and graph traversal. This skill lets you search and inject context from your accumulated project knowledge.

## Prerequisites

Rorca must be running:
```bash
rorca start
hermes mcp add rorca --url http://localhost:3030/mcp
```

## What Rorca's Retrieval Does

Rorca doesn't treat "memory" as a single blob. It separates concerns:

- **CAG** — cached context and direction stack. Always-on baseline.
- **RAG** — memory retrieval from stored observations, specs, and prior work.
- **Graph** — knowledge graph connecting memories, specs, stories, and file evidence.
- **Telemetry** — records what context was used and how useful it was, feeding back to improve future selections.

## Using Retrieval

### Get context for a spec
```
Use rorca_get_context to retrieve relevant memories, past specs, and graph-linked evidence for a spec. This is what the execution engine injects before running each story.
```

### Search across workspaces
```
The cross-workspace memory endpoint searches memories from all your registered workspaces. Use this to find patterns across projects.
```

### Recall specific memories
```
Use rorca_recall to search by key, domain, or semantic similarity. Filter by domain: person, event, concept, message, config, raw_note.
```

## Patterns

### Before creating a spec
1. Register the workspace
2. Add direction layers (conventions, architecture, constraints)
3. Use `rorca_get_context` to see what Rorca already knows about similar work
4. Create the spec — Rorca injects the retrieved context automatically

### After a run
- Check what context was used (Context Inspector in the dashboard)
- Mark useful/unuseful context to train the retrieval system
- The system gets smarter over time as telemetry accumulates

### Debugging retrieval
- Use the Context Inspector in the Rorca dashboard (Run View → Context tab)
- Check the Memory panel to see what's stored
- The Pre-Flight Graph shows what context will be injected before the next run
