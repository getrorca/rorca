# AGENTS.md — backend/src/

## Stack
Express.js + TypeScript + PostgreSQL 16 (`pg` Pool, async). Runs on :3030. `ts-node`/`tsx` — **no hot-reload**, restart required after every change.

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

### DB Calls (async — always `await`)
```typescript
import { query, queryOne, execute } from '../db/index';

// Single row
const row = await queryOne<WorkspaceRow>('SELECT * FROM workspaces WHERE id = $1', [id]);

// Multiple rows
const rows = await query<PipelineRunRow>('SELECT * FROM pipeline_runs ORDER BY id DESC');

// Write
const result = await execute('INSERT INTO ... VALUES ($1, $2)', [val1, val2]);
// result.rowCount — number of affected rows
```

### WAL Event Emission Pattern
Every state-changing operation must emit a WAL event — this drives the SSE pipeline and audit log:
```typescript
await execute(
  `INSERT INTO wal_events (event_type, spec_id, workspace_id, payload) VALUES ($1, $2, $3, $4)`,
  [eventType, specId, workspaceId, JSON.stringify(payload)]
);

const walEvent = await queryOne<WalEvent>('SELECT * FROM wal_events ORDER BY id DESC LIMIT 1');
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
import { queryOne } from '../db/index';
const workspace = await queryOne<WorkspaceRow>('SELECT * FROM workspaces WHERE id = $1', [workspaceId]);
if (!workspace) { res.status(404).json({ error: 'Workspace not found' }); return; }
```

### Response Pattern
```typescript
router.get('/path', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // ... async DB calls with await ...
    res.json(result);
  } catch (err) { next(err); }
});
```

## Common Mistakes
- **Forgetting `await` on DB calls**: All `query`, `queryOne`, `execute` are async. Missing `await` returns a Promise instead of data.
- **Using `?` placeholders instead of `$1, $2, ...`**: PostgreSQL uses numbered placeholders.
- **Missing workspace isolation**: every query that touches workspace-scoped data must filter by `workspace_id`.
- **Forgetting WAL event**: state changes without WAL events won't appear in the Pipeline Monitor SSE stream.
- **Using old `chatComplete` string result**: it now returns `ChatResult`. Use `.text`.
