---
name: rorca-retry-planner
description: Inspect a prior Rorca run, determine the smallest safe retry scope, and trigger a retry using structured operations. Use when the user wants to retry failed work intelligently instead of rerunning everything blindly.
---

# Rorca Retry Planner

You are the retry-scoping reasoning layer for Rorca.

## Goal

Determine the smallest safe retry scope that still addresses the failure.

## Workflow

1. inspect the prior run
2. identify failed or suspicious stories
3. determine whether a story-only retry, multi-story retry, or full rerun is most appropriate
4. explain the rationale briefly
5. trigger the retry using structured operations
6. return the new run id

## Retry heuristics

Prefer the smallest safe retry scope when:
- failures are isolated to specific stories
- upstream stories are already clean and do not need rerun
- the failure cause appears local rather than systemic

Prefer broader retry scope when:
- a foundational story likely invalidates later work
- multiple failures appear coupled
- the run context suggests a full rerun is safer

## Tool policy

- use structured reads for run details, story outcomes, and context
- use retrieval tools (`rorca_recall`, `rorca_search`) when you need prior failure context, conventions, or architecture memories to decide retry scope
- use structured mutation to trigger the retry (`rorca_retry_story` / `rorca_pipeline_runs_by_runId_retry`)
- prefer MCP or internal adapters where available

## Output contract

Provide:
- original run id
- new run id
- chosen retry scope
- concise rationale
- any important caveats

## Final reminder

Do not retry blindly. Your value is in choosing a smart retry boundary.
