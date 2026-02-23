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
} = useWorkspace();
```

**`Workspace` type:**
```typescript
interface Workspace {
  id: string;
  label: string;
  path: string;     // absolute filesystem path to the project repo
  domain?: string;
}
```

**Source**: Fetches from `GET /api/workspaces` on mount. Persists `workspaceId` to localStorage.

**Gotchas:**
- `workspaceId` can be null on first load (no workspace registered yet)
- Always guard API calls: `if (!workspaceId) return;`
- `workspace.path` is the absolute project root — use `path.basename(workspace.path)` for display names (this is what `repoName` in archive cards uses)
- The context does NOT watch for workspace changes in real-time — refetch if you add/delete workspaces

## supabase.auth.getSession() Note
NOT applicable to Rorcha (no Supabase). Rorcha uses no auth — all API calls are unauthenticated. This is intentional (local-only tool). Do not add auth middleware to routes.
