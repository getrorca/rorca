# AGENTS.md — backend/src/

## Stack
Express.js + TypeScript + SQLite (`better-sqlite3`, WAL mode). Runs on :3030. `ts-node`/`tsx` — **no hot-reload**, restart required after every change.

## Entry Point
`backend/src/server.ts` — mounts all routers, enables CORS, starts listening.

## Router Mounting Order (server.ts)
```typescript
app.use('/api/health', healthRouter);       // public
app.use('/api/workspaces', workspacesRouter);
app.use('/api/direction', directionRouter);
app.use('/api/specs', specsRouter);
app.use('/api/templates', templatesRouter);
app.use('/api/pipeline', pipelineRouter);
app.use('/api/worktrees', worktreesRouter);
app.use('/api/context', contextRouter);
app.use('/api/wal', walRouter);
```
No auth middleware — Rorca is local-only.

## Key Patterns

### DB Calls (synchronous — never async)
```typescript
import { db } from '../db/index';

// Single row
const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow | undefined;

// Multiple rows
const rows = db.prepare('SELECT * FROM pipeline_runs ORDER BY id DESC').all() as PipelineRunRow[];

// Write
const result = db.prepare('INSERT INTO ...').run(val1, val2);
const newId = result.lastInsertRowid; // bigint
```

### WAL Event Emission Pattern
Every state-changing operation must emit a WAL event — this drives the SSE pipeline and audit log:
```typescript
const walResult = db.prepare(
  `INSERT INTO wal_events (event_type, spec_id, workspace_id, payload) VALUES (?, ?, ?, ?)`
).run(eventType, specId, workspaceId, JSON.stringify(payload));

const walEvent = db.prepare('SELECT * FROM wal_events WHERE id = ?').get(walResult.lastInsertRowid) as WalEvent;
broadcastAll(walEvent);  // from '../lib/sse-hub'
```

### chatComplete (LLM calls)
```typescript
import { chatComplete } from '../lib/llm-client';
const result = await chatComplete([{ role: 'user', content: prompt }]);
const text = result.text; // ALWAYS use .text — result is ChatResult, not string
const usage = result.usage; // { inputTokens, outputTokens }
```

### Workspace Lookup Helper
```typescript
import { getWorkspace } from '../db/index'; // or inline db.prepare
const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId) as WorkspaceRow | undefined;
if (!workspace) { res.status(404).json({ error: 'Workspace not found' }); return; }
```

### Response Pattern
```typescript
router.get('/path', (req: Request, res: Response) => {
  try {
    // ... synchronous DB calls ...
    res.json(result);
  } catch (error: any) {
    console.error('[RouteFile] Operation error:', error);
    res.status(500).json({ error: error.message });
  }
});
```

## Common Mistakes
- **Using async for DB**: better-sqlite3 is sync. No `await db.prepare(...).get()`.
- **Missing workspace isolation**: every query that touches workspace-scoped data must filter by `workspace_id`.
- **Forgetting WAL event**: state changes without WAL events won't appear in the Pipeline Monitor SSE stream.
- **Using old `chatComplete` string result**: it now returns `ChatResult`. Use `.text`.
