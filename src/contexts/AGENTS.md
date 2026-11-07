# AGENTS.md — src/contexts/

## WorkspaceContext.tsx
Provides global workspace state to all panels.

**What it provides:**
```typescript
const {
  workspaceId,          // string | null — currently selected workspace ID
  workspaces,           // Workspace[] — all registered workspaces
  selectedWorkspace,    // Workspace | null — full record for current workspace
  setWorkspaceId,       // (id: string) => void
  addWorkspace,         // (ws: Workspace) => void
  refreshWorkspaces,    // () => Promise<void>
  activeRuns,           // ActiveRun[] — currently running pipelines for this workspace
  refreshActiveRuns,    // () => Promise<void>
  settings,             // WorkspaceSettings — pipeline config (autoWorktree, storyTimeoutMin, maxRetries)
  updateSettings,       // (patch: Partial<WorkspaceSettings>) => Promise<void>
} = useWorkspace();
```

**`Workspace` type:**
```typescript
interface Workspace {
  id: string;
  name: string;
  git_path: string;     // absolute filesystem path to the project repo
}
```

**Source**: Fetches from `GET /api/workspaces` on mount. Persists `workspaceId` to localStorage.
Settings fetched from `GET /api/workspaces/:id/pipeline-config`.
Active runs polled every 15s from `GET /api/pipeline/runs?workspaceId=...&limit=10`.

**Gotchas:**
- `workspaceId` can be null on first load (no workspace registered yet)
- Always guard API calls: `if (!workspaceId) return;`
- `workspace.git_path` is the absolute project root — use `path.basename(workspace.git_path)` for display names
- The context does NOT watch for workspace changes in real-time — refetch if you add/delete workspaces
- `settings` uses `PUT /api/workspaces/:id/pipeline-config` (replaces full config, not PATCH)

## AuthContext.tsx
Manages local single-user auth state for the OSS edition.

**What it provides:**
```typescript
const {
  user,                 // AuthUser | null — { id, email, displayName, githubConnected? }
  isAuthenticated,      // boolean
  loading,              // boolean — true during initial session check
  login,                // (email, password) => Promise<void>
  register,             // (email, password, displayName) => Promise<void>
  loginWithGitHub,      // legacy placeholder — OSS edition does not expose hosted sign-in
  logout,               // () => Promise<void>
} = useAuth();
```

**Gotchas:**
- Auth gate is currently bypassed (Rorca is local single-user tool)
- Tokens stored in-memory (not localStorage) for XSS safety
- 401 responses trigger `rorca:auth-expired` window event → clears session

## ThemeContext.tsx
Manages dark/light/system theme with localStorage persistence.

**What it provides:**
```typescript
const {
  mode,      // ThemeMode — 'light' | 'dark' | 'system'
  setMode,   // (mode: ThemeMode) => void
  resolved,  // 'light' | 'dark' — actual applied theme
} = useTheme();
```

**Source**: Persists to `localStorage('rorca_theme')`. Default: `'dark'`.
Applies `data-theme` attribute to `<html>`.

## NotificationContext.tsx
Manages notification bell state with SSE real-time updates.

**What it provides:**
```typescript
const {
  unreadCount,          // number
  notifications,        // Notification[] — loaded on demand
  loading,              // boolean
  fetchNotifications,   // () => Promise<void> — fetches full list
  refreshUnreadCount,   // () => Promise<void> — lightweight count refresh
  markRead,             // (id: string) => Promise<void>
  markAllRead,          // () => Promise<void>
} = useNotifications();
```

**Real-time**: Subscribes to `/api/pipeline/stream` SSE for WAL events.
Refreshes unread count on: `spec_approved`, `spec_rejected`, `run_finished`, `run_failed`, `review_requested`, `budget_alert`.
Fallback: polls `/api/notifications/unread-count` every 10s.

## ToastContext.tsx
Global toast/snackbar notifications.

```typescript
const { show } = useGlobalToast();
show('Success!', 'success'); // or 'error'
```

## HelpTipsContext.tsx
Toggle help tips visibility. Persists to localStorage.

```typescript
const { showTips, setShowTips } = useHelpTips();
```

## Provider Composition (App.tsx)
```
ThemeProvider
  HelpTipsProvider
    ToastProvider
      AuthProvider
        NotificationProvider
          WorkspaceProvider
            AppContent
```
