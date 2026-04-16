import { createContext, useContext, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { apiFetch } from '../lib/apiFetch';

export interface Workspace {
  id: string;
  name: string;
  git_path: string;
  domain?: string;
}

export interface WorkspaceSettings {
  autoWorktree?: boolean;
  storyTimeoutMin?: number;
  maxRetries?: number;
}

export interface ActiveRun {
  id: number;
  status: string;
  spec_path: string;
  started_at: string;
}

interface WorkspaceRow {
  id: string;
  label: string;
  path: string;
  domains: string[];
}

function toWorkspace(row: WorkspaceRow): Workspace {
  return { id: row.id, name: row.label, git_path: row.path, domain: row.domains?.[0] };
}

interface WorkspaceContextValue {
  workspaceId: string | null;
  setWorkspaceId: (id: string) => void;
  workspaces: Workspace[];
  workspacesLoading: boolean;
  selectedWorkspace: Workspace | null;
  addWorkspace: (ws: Workspace) => void;
  refreshWorkspaces: () => Promise<void>;
  /** Active pipeline runs for the current workspace */
  activeRuns: ActiveRun[];
  refreshActiveRuns: () => Promise<void>;
  /** Per-workspace settings (lazy-loaded on workspace change) */
  settings: WorkspaceSettings;
  updateSettings: (patch: Partial<WorkspaceSettings>) => Promise<void>;
}

const WorkspaceCtx = createContext<WorkspaceContextValue | null>(null);

const LS_KEY = 'rorca_workspaceId';
const SS_KEY = 'rorca_workspaceId'; // sessionStorage key (per-tab isolation)

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(true);
  // Per-tab workspace: sessionStorage (tab-scoped) first, localStorage (cross-tab) as fallback for new tabs
  const [workspaceId, setWorkspaceIdRaw] = useState<string | null>(
    () => sessionStorage.getItem(SS_KEY) ?? localStorage.getItem(LS_KEY),
  );
  const [activeRuns, setActiveRuns] = useState<ActiveRun[]>([]);
  const [settings, setSettings] = useState<WorkspaceSettings>({});
  const activeRunsInterval = useRef<ReturnType<typeof setInterval> | null>(null);

  const selectedWorkspace = useMemo(
    () => workspaces.find((w) => w.id === workspaceId) ?? null,
    [workspaces, workspaceId],
  );

  const setWorkspaceId = useCallback((id: string) => {
    // sessionStorage = per-tab (primary), localStorage = fallback for brand-new tabs
    sessionStorage.setItem(SS_KEY, id);
    localStorage.setItem(LS_KEY, id);
    setWorkspaceIdRaw(id);
  }, []);

  const addWorkspace = useCallback((ws: Workspace) => {
    setWorkspaces((prev) => [ws, ...prev]);
    setWorkspaceId(ws.id);
  }, [setWorkspaceId]);

  const refreshWorkspaces = useCallback(async () => {
    const res = await apiFetch<{ items: WorkspaceRow[]; total: number; hasMore: boolean; cursor?: string }>('/api/workspaces');
    setWorkspaces(res.items.map(toWorkspace));
  }, []);

  // Fetch active runs for the current workspace
  const refreshActiveRuns = useCallback(async () => {
    if (!workspaceId) { setActiveRuns([]); return; }
    try {
      const res = await apiFetch<{ items: { id: number; status: string; spec_path: string; started_at: string }[] }>(
        `/api/pipeline/runs?workspaceId=${workspaceId}&limit=10`,
      );
      setActiveRuns(res.items.filter((r) => r.status === 'running'));
    } catch {
      // Silently ignore — pipeline endpoint may not be available
    }
  }, [workspaceId]);

  // Fetch workspace pipeline config (settings)
  const fetchSettings = useCallback(async () => {
    if (!workspaceId) { setSettings({}); return; }
    try {
      const res = await apiFetch<{ config: WorkspaceSettings }>(
        `/api/workspaces/${workspaceId}/pipeline-config`,
      );
      setSettings(res.config ?? {});
    } catch {
      setSettings({});
    }
  }, [workspaceId]);

  const updateSettings = useCallback(async (patch: Partial<WorkspaceSettings>) => {
    if (!workspaceId) return;
    const merged = { ...settings, ...patch };
    await apiFetch(`/api/workspaces/${workspaceId}/pipeline-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(merged),
    });
    setSettings(merged);
  }, [workspaceId, settings]);

  // Load workspaces on mount — retry once on failure to guard against transient
  // backend restart windows. Never show onboarding wizard due to a recoverable error.
  useEffect(() => {
    let cancelled = false;
    setWorkspacesLoading(true);

    const fetchWorkspaces = () =>
      apiFetch<{ items: WorkspaceRow[]; total: number; hasMore: boolean; cursor?: string }>('/api/workspaces')
        .then((res) => {
          if (cancelled) return;
          const ws = res.items.map(toWorkspace);
          setWorkspaces(ws);
          if (ws.length > 0 && (!workspaceId || !ws.some((w) => w.id === workspaceId))) {
            setWorkspaceId(ws[0].id);
          }
        });

    fetchWorkspaces()
      .catch(() => {
        if (cancelled) return;
        // Retry once after 1.5s (handles transient backend restart window)
        return new Promise<void>((resolve) => setTimeout(resolve, 1500))
          .then(() => cancelled ? undefined : fetchWorkspaces())
          .catch((err) => console.error('[WorkspaceContext] Failed to load workspaces after retry:', err));
      })
      .finally(() => { if (!cancelled) setWorkspacesLoading(false); });

    return () => { cancelled = true; };
  }, []);

  // Refresh active runs and settings when workspace changes
  useEffect(() => {
    refreshActiveRuns();
    fetchSettings();
  }, [refreshActiveRuns, fetchSettings]);

  // Poll active runs every 15s
  useEffect(() => {
    if (activeRunsInterval.current) clearInterval(activeRunsInterval.current);
    if (!workspaceId) return;
    activeRunsInterval.current = setInterval(refreshActiveRuns, 15_000);
    return () => {
      if (activeRunsInterval.current) clearInterval(activeRunsInterval.current);
    };
  }, [workspaceId, refreshActiveRuns]);

  // Re-fetch data when network comes back online
  useEffect(() => {
    const handleOnline = () => {
      refreshWorkspaces();
      refreshActiveRuns();
      fetchSettings();
    };
    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, [refreshWorkspaces, refreshActiveRuns, fetchSettings]);

  const ctxValue = useMemo(() => ({
    workspaceId, setWorkspaceId, workspaces, workspacesLoading, selectedWorkspace,
    addWorkspace, refreshWorkspaces,
    activeRuns, refreshActiveRuns,
    settings, updateSettings,
  }), [workspaceId, setWorkspaceId, workspaces, workspacesLoading, selectedWorkspace,
    addWorkspace, refreshWorkspaces, activeRuns, refreshActiveRuns, settings, updateSettings]);

  return (
    <WorkspaceCtx.Provider value={ctxValue}>
      {children}
    </WorkspaceCtx.Provider>
  );
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceCtx);
  if (!ctx) throw new Error('useWorkspace must be inside WorkspaceProvider');
  return ctx;
}
