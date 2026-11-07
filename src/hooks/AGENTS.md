# AGENTS.md — src/hooks/

## usePipelineSSE.ts
SSE subscription hook for pipeline WAL events.

**Usage:**
```typescript
const sseEvents = usePipelineSSE(runId ? String(runId) : null);
```

**Connects to**: `GET /api/pipeline/stream?runId=<id>`
**Returns**: `WalEvent[]` — accumulated events since mount

**WAL event types relevant to pipeline:**
- `run_started` — pipeline run created and spawned
- `story_started` — execution-engine.ts began a story
- `story_passed` — story completed successfully
- `story_failed` — story failed (may retry)
- `story_skipped` — story skipped (max retries exceeded)
- `run_finished` — process exited
- `run_blocked` — execution paused waiting for human input (HITL)
- `story_escalated` — story flagged for human review (CIE model escalation)

**Gotcha**: WAL events come from `execution-engine.ts` writing to the SQLite `wal_events` table. The SSE endpoint polls every 3s. There is a ~3s lag between story completion and UI update.

**Note**: The Terminal tab (`RunTerminal.tsx`) streams raw subprocess output **independently** of WAL events. WAL events drive the Stories tab; raw stdout drives the Terminal tab.
