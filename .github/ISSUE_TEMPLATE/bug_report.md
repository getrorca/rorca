---
name: Bug report
about: Something is broken or behaves differently than documented
title: "[bug] "
labels: ["bug", "needs-triage"]
---

## What happened

<!-- A clear description of the actual behaviour. -->

## What you expected

<!-- What you expected instead. -->

## Steps to reproduce

1.
2.
3.

## Environment

| | |
| --- | --- |
| Rorca version | <!-- `rorca --version`, or the commit SHA --> |
| Install method | <!-- npm / binary / docker compose / from source --> |
| OS + version | <!-- e.g. macOS 15.2 arm64, Ubuntu 24.04 x64 --> |
| Database mode | <!-- native / docker / byop --> |
| PostgreSQL + extensions | <!-- `SELECT version();` and whether age / vector are installed --> |
| Execution engine | <!-- RORCA_AGENT: claude / opencode / codex / omp / pi --> |

## Diagnostics

<!--
Paste the relevant lines from:
  - the backend log (npm run dev, or `rorca start`)
  - `GET /api/health` output
  - `rorca doctor` if available
Redact tokens, database URLs, and anything private before posting.
-->

```text

```

## Additional context

<!-- Screenshots, related issues, anything you already ruled out. -->
