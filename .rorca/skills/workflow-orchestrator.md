---
name: workflow-orchestrator
description: Build and orchestrate AI-driven development workflows that iterate until success using configurable patterns and multi-agent coordination
license: MIT
compatibility: opencode
metadata:
  audience: developers, AI agents, team leads
  category: workflow
---

# Workflow Orchestrator

Design, configure, and execute AI-driven development workflows that iterate until tasks complete successfully using configurable patterns, multi-agent coordination, and intelligent stop conditions.

## When to use me

Use this skill when:
- Building complex features requiring multiple AI agent passes
- Implementing automated development workflows with verification steps
- Coordinating parallel AI agents for different aspects of a task
- Creating self-correcting loops that iterate until success criteria met
- Need to orchestrate multiple AI agents in sequence or parallel

## What I do

### 1. Workflow Pattern Selection
- **Analyze task requirements** to recommend optimal workflow patterns
- **Match complexity levels** with appropriate workflow types
- **Compare trade-offs** between speed, cost, control, and quality

### 2. Multi-Agent Coordination
- **Sequence agents** for linear workflows (build → verify → plan)
- **Parallelize agents** for concurrent execution
- **Handle failures and retries** with intelligent routing
- **Implement steering patterns** (linear, conditional, parallel, unblocking)

### 3. SSE Event Streaming
- **Real-time monitoring** via Server-Sent Events
- **Progress tracking** across workflow stages
- **Live output streaming** from subprocess execution
- **Late-joiner replay** from in-memory buffers

### 4. Integration & Tooling
- **Subprocess management** for isolated agent execution
- **Output buffer management** with subscriber patterns
- **Structured event emission** for semantic log parsing
- **Git integration** for automated quality gates

## Key Patterns

### Subprocess → SSE → Terminal Pattern
```
Backend spawns subprocess (claude --print, opencode run)
  → stdout/stderr piped to in-memory buffer
  → buffer broadcasts to SSE subscribers
  → SSE endpoint replays buffer + live chunks
  → Frontend EventSource connects, writes to xterm.js
  → Late joiners get full replay automatically
```

### Buffer Management
- In-memory circular buffer per generation/run ID
- Subscribers added/removed on SSE connect/disconnect
- Auto-cleanup after TTL (30 min default)
- Base64 encoding for binary-safe transport

## Notes

- **Start simple** — single agent pattern before scaling to multi-agent
- **Monitor costs** — parallel agents increase expense
- **Implement escape hatches** — always have manual stop conditions
- **Use structured events** alongside raw output for dual-mode rendering
- **Buffer management is critical** — memory leaks from uncleaned buffers
