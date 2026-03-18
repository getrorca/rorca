# AGENTS.md — src/components/

Shared UI components used across multiple panels.

## Component Inventory
| File | Purpose |
|------|---------|
| `Shell.tsx` | App shell: Sidebar + panel content area layout |
| `Sidebar.tsx` | Left icon nav bar; defines `PanelId` type exported throughout the app |
| `RunTerminal.tsx` | Pure React terminal that streams live pipeline output via SSE |
| `StoryCard.tsx` | Collapsible story display (id, title, description, AC, dependsOn) |
| `AddWorkspaceModal.tsx` | Modal for registering a new workspace (path + label + domain) |
| `BootstrapContextModal.tsx` | Multi-source context ingestion wizard (paste, file, URL, Q&A) |
| `Toast.tsx` | Simple toast notification system |

## RunTerminal.tsx — Critical Details
Pure React terminal that connects to `/api/pipeline/runs/:runId/output` SSE. Uses ansi-to-html to convert ANSI escape sequences into styled HTML rendered in `<pre>` tags — no xterm.js dependency.

**SSE chunk format**: `event: chunk`, data is base64-encoded text. Decode: `atob(e.data)`.
**Done signal**: `event: done` — close EventSource.
**Replay**: backend sends all buffered chunks before live subscription — late-joiners see full output.
**Buffer lifetime**: 30 min after process exit, then auto-deleted. Runs started before backend restart have no buffer.

**Key props**: `runId: number`. Always mount with `key={runId}` from parent to force remount on run switch.

**Features**: Semantic log view with tool-type icons, scroll-lock awareness, 20,000-line buffer cap, dark/light theme via ThemeContext.

## Sidebar.tsx — PanelId
`PanelId` type is defined here and exported — import it for any component that needs `onNavigate`:
```typescript
import type { PanelId } from '../components/Sidebar';
```
Current panels: `'forge' | 'direction' | 'review' | 'pipeline' | 'worktrees' | 'archive'`

## StoryCard.tsx
Accepts a `Story` type:
```typescript
interface Story {
  id: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string[];
  dependsOn?: string[];
}
```
Used in ArchivePanel's StoriesTab. Collapsible — click header to expand AC + deps.

## Adding a New Shared Component
1. Create `src/components/NewComponent.tsx`
2. Import from the panel that uses it
3. If it has significant complexity or gotchas, add a section here
