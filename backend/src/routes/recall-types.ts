Resolved. The merged file combines both sides:

- **`RecallMemory`** interface from US-003 (DB-backed memory shape with id, title, confidence, pinned, etc.)
- **`RecallHealth`** + **`ContextFileStatus`** interfaces from US-004 (transformed health report for MCP consumers)
- `RecallResponse.memories` typed as `RecallMemory[]` (US-003's richer type instead of raw `MemoryEntry[]`)
- `RecallResponse.health` typed as `RecallHealth | null` (US-004's transformed type instead of raw `EcholocationReport`)
- `RunSummary` uses the shared shape from US-003/US-004 (with `passedStories`/`failedStories`/`skippedStories`/`totalTokens`/`costUsd`)
