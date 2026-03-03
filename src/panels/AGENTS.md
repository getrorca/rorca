# AGENTS.md — src/panels/

All 7 panel components live here. Each panel is a full-height React component rendered by `Shell.tsx` based on `activePanel` state in `App.tsx`.

## Panel Inventory
| File | Panel | Key State |
|------|-------|-----------|
| `SpecForgePanelPage.tsx` | Spec Forge | brief, title, model, generating state |
| `DirectionStackPanel.tsx` | Direction Stack | layers (L1–L3), hydration state |
| *(deleted — UX-007)* | Review Queue merged into Forge | pending specs now inline in SpecForgePanelPage |
| `PipelineMonitorPanel.tsx` | Pipeline Monitor | runs list, selectedRunId, detailTab, SSE events |
| `WorktreesPanel.tsx` | Worktrees | worktrees list, selectedWorktree, mergeState |
| `ArchivePanel.tsx` | Archive | specs list, selectedId, search, addState, runState |
| `SpecForgeOutput.tsx` | (output sub-component) | Rendered inside SpecForgePanelPage |

## Adding a New Panel
1. Create `src/panels/NewPanel.tsx` with `export default function NewPanel() {}`
2. Add `PanelId` entry in `src/components/Sidebar.tsx`
3. Render in `src/App.tsx` with `{activePanel === 'new' && <NewPanel />}`
4. Add icon button to `src/components/Sidebar.tsx`

## Gotchas

### PipelineMonitorPanel — Tab State
- Default tab is `'terminal'` (not `'stories'`)
- `<RunTerminal key={selectedRunId} runId={selectedRunId} />` — the `key` prop forces remount when switching runs, which reconnects the SSE and clears the terminal buffer
- WAL event polling happens even when no run is selected — it populates the runs list sidebar
- Stale runs (status='running' but process dead) auto-select but terminal shows "run not found or already completed" — this is expected behavior

### ArchivePanel — Spec ID vs Name (CRITICAL)
```typescript
// WRONG — specName is the human title, causes 404
specPath: `ralph/specs/approved/${summary.specName}.json`
// CORRECT — id is the slug/filename
specPath: `ralph/specs/approved/${summary.id}.json`
```
The `spec.id` field is derived from `fileName.replace('.json', '')` in the backend. Use it for all file path construction.

### ArchivePanel — Add Stories Flow
1. User clicks "Add More Stories" → `addState: 'form'`
2. User sets count (1–10) + optional brief → clicks "Generate"
3. `POST /api/specs/${summary.id}/add-stories { workspaceId, count, brief }`
4. Backend generates new stories, appends to spec file, returns `{ ok, addedCount, stories }`
5. `addState: 'done'` → green banner for 3s → resets to `'idle'`
6. Note: the stories tab badge count won't update until the drawer is reopened (spec detail refetch needed)

### WorktreesPanel — Merge State
- `mergeState` resets to `'idle'` whenever `selectedWorktree` changes
- "Merge to main" only shown when selected worktree ≠ the main worktree (index 0)
- 409 response = merge conflict; surface inline with the error message
- After successful merge: `mergeState: 'done'` green banner; worktree still exists (user must delete manually)

### Forge — Pending Specs (UX-007)
ReviewQueuePanel was deleted. Pending specs now show inline in SpecForgePanelPage. The `queue` PanelId still works (redirects to `/forge` with `showPending` prop). Shared review components live in `src/components/SpecReviewInline.tsx`.
