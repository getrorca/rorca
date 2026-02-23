# AGENTS.md — backend/src/routes/

All route files are Express routers mounted in `server.ts`. Every mutation must emit a WAL event via `broadcastAll()`.

## Route Inventory

| File | Mount | Purpose |
|------|-------|---------|
| `workspaces.ts` | `/api/workspaces` | Register/manage project repos as workspaces |
| `direction.ts` | `/api/direction` | L1–L3 Direction Stack CRUD + synthesis |
| `specs.ts` | `/api/specs` | Spec generation, approval/rejection, archive, add-stories |
| `context.ts` | `/api/context` | YAML context extraction (file upload, paste, URL) |
| `pipeline.ts` | `/api/pipeline` | Run trigger, SSE output streaming, cancel, story status |
| `worktrees.ts` | `/api/worktrees` | Git worktree list, create, delete, merge |
| `templates.ts` | `/api/templates` | Spec template library CRUD |
| `wal.ts` | `/api/wal` | Paginated WAL event log |
| `health.ts` | `/api/health` | Public health check — no auth |

## Endpoints Reference

### workspaces.ts
```
POST   /api/workspaces          — Create workspace (label, path, domains[])
GET    /api/workspaces          — List all workspaces
GET    /api/workspaces/:id/context — Get schema snapshot + git memory
PUT    /api/workspaces/:id/context — Hydrate: schema (migrations) + git memory (LLM map-reduce)
DELETE /api/workspaces/:id      — Delete workspace
```

### direction.ts
```
GET    /api/direction?workspaceId=&layer=   — Fetch L1/L2/L3 content
PUT    /api/direction                       — Upsert layer (workspaceId, layer, contentYaml, domain?)
POST   /api/direction/synthesize            — Merge all layers + schema/git → single context string
```
Note: GET L3 also returns `preferredModel`. Synthesize is the main input for spec generation.

### specs.ts
```
GET    /api/specs?workspaceId=&status=pending|approved  — List specs from disk
POST   /api/specs                                       — Generate spec from brief (writes to pending/)
POST   /api/specs/generate/batch                        — Queue multiple briefs for sequential generation
GET    /api/specs/generate/batch/:batchId               — Batch status with per-brief progress
PUT    /api/specs/:id/approve                           — Move pending → approved, bump version
GET    /api/specs/:id/reject                            — Reject spec (with reason)
POST   /api/specs/:id/add-stories                       — Generate N more stories, append to spec file
```

**Archive List (GET /api/specs)**: reads `workspace/scripts/ralph/specs/approved/` + rejected list from `spec_versions`. Returns `ArchiveSpecSummary[]` with `id` (slug), `specName` (title), `repoName` (basename of workspace.path), `storyCount`, `branchName`.

**Critical**: `spec.id` = filename slug — use for all path construction. `spec.specName` = human title — display only.

### pipeline.ts
```
POST   /api/pipeline/trigger                   — Spawn run-loop.sh, return runId
GET    /api/pipeline                           — List pipeline runs
GET    /api/pipeline/runs/:runId/output        — SSE: stream stdout/stderr (base64 chunks)
POST   /api/pipeline/runs/:runId/cancel        — Kill process, set status='failed'
GET    /api/pipeline/runs/:runId/stories       — Story results for a run
```

**Output buffer**: in-memory `Map<runId, { chunks: string[], done: boolean, subscribers: Set<fn> }>`. Late-joiners get full replay. Auto-cleaned 30min after process exit.

**Conflict detection**: if workspace already has `status='running'` run → return `{ conflict: true, activeRunId }`. Set `autoWorktree: true` to bypass.

### worktrees.ts
```
GET    /api/worktrees?workspaceId=  — Parse `git worktree list --porcelain`
POST   /api/worktrees               — Create worktree (git worktree add -b <branch> <path> HEAD)
DELETE /api/worktrees/:id           — Remove worktree (git worktree remove)
POST   /api/worktrees/merge         — Merge branch to main (--no-ff), 409 on conflict
```

### templates.ts
```
POST   /api/templates               — Create template from approved spec
GET    /api/templates               — List all templates
GET    /api/templates/:id           — Fetch template detail
DELETE /api/templates/:id           — Delete template
```

### wal.ts
```
GET    /api/wal?limit=50&offset=0   — Paginated WAL event log
```

## Adding a New Route

1. Create `backend/src/routes/newroute.ts`
2. Mount in `server.ts`: `app.use('/api/newroute', newRouter);`
3. Follow the response pattern:
```typescript
router.get('/path', (req: Request, res: Response) => {
  try {
    const row = db.prepare('SELECT ...').get(id) as RowType | undefined;
    if (!row) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(row);
  } catch (error: any) {
    console.error('[RouteName] error:', error);
    res.status(500).json({ error: error.message });
  }
});
```
4. Emit WAL event for every mutation (see AGENTS.md parent dir).

## Common Mistakes

- **Async DB calls**: `better-sqlite3` is synchronous. Remove `await` from `.get()`, `.all()`, `.run()`.
- **Missing workspace validation**: Always `db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId)` and 404 if not found.
- **Wrong spec path**: `ralph/specs/approved/${spec.id}.json` NOT `specs/approved/${spec.specName}.json`.
- **Missing WAL event**: state changes without `broadcastAll()` won't appear in Pipeline Monitor live feed.
- **Spec path join**: Backend resolves `path.join(workspace.path, 'scripts', specPath)` — don't double-prefix.
