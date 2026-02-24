import { createContext, useContext, useCallback, useEffect, useState, type ReactNode } from 'react';
import { apiFetch } from '../lib/apiFetch';

export interface Workspace {
  id: string;
  name: string;
  git_path: string;
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
  addWorkspace: (ws: Workspace) => void;
  refreshWorkspaces: () => Promise<void>;
}

const WorkspaceCtx = createContext<WorkspaceContextValue | null>(null);

const LS_KEY = 'rorcha_workspaceId';

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceIdRaw] = useState<string | null>(
    () => localStorage.getItem(LS_KEY),
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

  return (
    <WorkspaceCtx.Provider value={{ workspaceId, setWorkspaceId, workspaces, addWorkspace, refreshWorkspaces }}>
      {children}
    </WorkspaceCtx.Provider>
  );
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceCtx);
  if (!ctx) throw new Error('useWorkspace must be inside WorkspaceProvider');
  return ctx;
}
