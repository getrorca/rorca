# AGENTS.md — src/ (React Frontend)

## Stack
React 18 + TypeScript + Vite + Tailwind CSS. Dev server on :5210.

## Key Files
- `src/App.tsx` — Top-level router, manages `activePanel` state, passes `onNavigate` to panels
- `src/panels/` — 7 main panel components (see below)
- `src/components/Shell.tsx` — App shell layout (Sidebar + panel switcher)
- `src/components/Sidebar.tsx` — Left icon sidebar, defines `PanelId` type
- `src/contexts/WorkspaceContext.tsx` — Provides `workspaceId`, `workspaces`, `selectedWorkspace`
- `src/hooks/usePipelineSSE.ts` — SSE subscription for pipeline WAL events
- `src/lib/apiFetch.ts` — Typed fetch wrapper for all API calls

## Panels (`src/panels/`)
| Panel | PanelId | Purpose |
|-------|---------|---------|
| `SpecForgePanelPage.tsx` | `forge` | Brief input → spec generation |
| `DirectionStackPanel.tsx` | `direction` | L1–L3 direction layer editing |
| `ReviewQueuePanel.tsx` | `review` | Approve/reject pending specs |
| `PipelineMonitorPanel.tsx` | `pipeline` | Live run monitoring (Terminal + Stories tabs) |
| `WorktreesPanel.tsx` | `worktrees` | Git worktree management + merge |
| `ArchivePanel.tsx` | `archive` | Spec history + run pipeline + add stories |

## Critical Patterns

### API Calls
Always use `apiFetch<T>` — never raw `fetch`:
```typescript
import { apiFetch } from '../lib/apiFetch';
const result = await apiFetch<{ ok: boolean }>('/api/specs/:id/approve', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ workspaceId }),
});
```

### Workspace Context
```typescript
const { workspaceId, workspaces, selectedWorkspace } = useWorkspace();
```
All API calls must include `workspaceId` — backend enforces workspace isolation.

### Panel Navigation
```typescript
// In App.tsx:
{activePanel === 'archive' && <ArchivePanel onNavigate={setActivePanel} />}
// Component receives:
onNavigate: (panel: PanelId) => void
```
Pass `onNavigate` when a panel needs to trigger navigation (e.g. Archive → Pipeline Monitor after run trigger).

### SSE Pipeline Events
```typescript
const sseEvents = usePipelineSSE(runId ? String(runId) : null);
```
Returns WAL events from `/api/pipeline/stream`. Drives story progress in PipelineMonitorPanel.

## PipelineMonitorPanel — Key Details
- `detailTab: 'terminal' | 'stories'` — Terminal tab is default
- Terminal tab: `<RunTerminal key={runId} runId={runId} />` (key forces remount on run change)
- Stories tab: WAL-event-derived story list, progress bar, per-story expand
- `selectedRunId` drives both the SSE hook and RunTerminal
- Stale "running" runs: auto-selected on load but may have dead processes — terminal shows "run not found"

## ArchivePanel — Key Details
- `spec.id` = filename slug — use for API calls and path construction
- `spec.specName` = human title — display only
- Run trigger path: `ralph/specs/approved/${spec.id}.json` (NEVER `specs/approved/${spec.specName}.json`)
- Add Stories form: inline in drawer footer, number input 1–10, optional brief, calls `POST /api/specs/:id/add-stories`
- Repo badge: `spec.repoName` (basename of workspace.path)
- Branch badge: `spec.branchName` (git worktree branch if applicable)
- `onNavigate` prop: used to switch to Pipeline Monitor after "Run in Pipeline" success

## RunTerminal Component (`src/components/RunTerminal.tsx`)
- Uses ansi-to-html to render ANSI escape sequences into styled `<pre>` tags — no xterm.js dependency
- Connects to `/api/pipeline/runs/:runId/output` SSE
- Chunks arrive base64-encoded: `atob(e.data)` → rendered as styled log lines
- Semantic log view parses `[Read]`, `[Write]`, `[Bash]`, `[Planning]` prefixes with icons
- `key={runId}` on the component forces full remount when switching between runs
- Scroll-lock awareness with 20,000-line buffer cap
- Dark/light theme support via ThemeContext

## Tailwind / CSS Notes
- CSS vars: `var(--bg)`, `var(--surface)`, `var(--panel)`, `var(--text)`, `var(--text-muted)`, `var(--border)`, `var(--accent)`, `var(--success)`, `var(--error)`, `var(--warning)`

## TypeScript
- `npx tsc --noEmit` from repo root (not `src/`) — Vite uses project root tsconfig
- Avoid `any` — use proper interfaces; add to `ArchiveSpec`, `SpecDetail` etc. as features grow
