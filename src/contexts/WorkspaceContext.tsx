import { createContext, useContext, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { apiFetch } from '../lib/apiFetch';

export interface Workspace {
  id: string;
  name: string;
  git_path: string;
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
  return { id: row.id, name: row.label, git_path: row.path };
}

interface WorkspaceContextValue {
  workspaceId: string | null;
  setWorkspaceId: (id: string) => void;
  workspaces: Workspace[];
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

const LS_KEY = 'rorcha_workspaceId';

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceIdRaw] = useState<string | null>(
    () => localStorage.getItem(LS_KEY),
  );
  const [activeRuns, setActiveRuns] = useState<ActiveRun[]>([]);
  const [settings, setSettings] = useState<WorkspaceSettings>({});
  const activeRunsInterval = useRef<ReturnType<typeof setInterval> | null>(null);

  const selectedWorkspace = useMemo(
    () => workspaces.find((w) => w.id === workspaceId) ?? null,
    [workspaces, workspaceId],
  );

  const setWorkspaceId = (id: string) => {
    localStorage.setItem(LS_KEY, id);
    setWorkspaceIdRaw(id);
  };

  const addWorkspace = (ws: Workspace) => {
    setWorkspaces((prev) => [ws, ...prev]);
    setWorkspaceId(ws.id);
  };

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

  // Load workspaces on mount
  useEffect(() => {
    apiFetch<{ items: WorkspaceRow[]; total: number; hasMore: boolean; cursor?: string }>('/api/workspaces')
      .then((res) => {
        const ws = res.items.map(toWorkspace);
        setWorkspaces(ws);
        // Fall back to first workspace if none selected or stale
        if (ws.length > 0 && (!workspaceId || !ws.some((w) => w.id === workspaceId))) {
          setWorkspaceId(ws[0].id);
        }
      })
      .catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  return (
    <WorkspaceCtx.Provider value={{
      workspaceId, setWorkspaceId, workspaces, selectedWorkspace,
      addWorkspace, refreshWorkspaces,
      activeRuns, refreshActiveRuns,
      settings, updateSettings,
    }}>
      {children}
    </WorkspaceCtx.Provider>
  );
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceCtx);
  if (!ctx) throw new Error('useWorkspace must be inside WorkspaceProvider');
  return ctx;
}
