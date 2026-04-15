import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  ChevronDown,
  Clock3,
  Maximize2,
  Minimize2,
  Plus,
  Trash2,
} from 'lucide-react';
import TerminalPane from '../components/TerminalPane';
import ReadOnlyTerminalPane from '../components/ReadOnlyTerminalPane';
import ModelPickerPopover from '../components/ModelPickerPopover';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { apiFetch, ApiError } from '../lib/apiFetch';
import { getAllLayers } from '../api/direction';
import type { DirectionLayer } from '../api/types';

type TerminalMode = 'panel' | 'drawer';

interface TerminalPanelProps {
  mode: TerminalMode;
  onCollapse?: () => void;
  onExpand?: () => void;
}

interface TerminalSessionRecord {
  sessionId: string;
  workspaceId: string;
  cwd: string;
  createdAt: string;
  exited?: boolean;
}

interface TerminalSessionResponse {
  sessionId: string;
  workspaceId: string;
  cwd: string;
  createdAt: string;
}

interface TerminalHistoryRecord {
  sessionId: string;
  cwd: string;
  status: 'active' | 'exited' | 'killed' | string;
  exitCode: number | null;
  createdAt: string;
  exitedAt: string | null;
  totalOutputBytes: number;
}

interface DirectionLayersResponse {
  layers: Record<string, DirectionLayer>;
}

const LAYER_KEYS = ['l1', 'l2', 'l3', 'l4', 'l5'] as const;

function getBasename(input: string): string {
  const normalized = input.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? input;
}

function summarizeLayer(content: string): string {
  return content.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Empty';
}

function isNotInstalledError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 422 && error.code === 'OPENCODE_NOT_INSTALLED';
}

function formatDuration(createdAt: string, exitedAt: string | null): string {
  const start = new Date(createdAt).getTime();
  const end = exitedAt ? new Date(exitedAt).getTime() : Date.now();
  const diffSeconds = Math.max(0, Math.floor((end - start) / 1000));
  const minutes = Math.floor(diffSeconds / 60);
  const seconds = diffSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getStatusBadgeClass(status: TerminalHistoryRecord['status']): string {
  if (status === 'active') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
  if (status === 'killed') return 'border-rose-500/30 bg-rose-500/10 text-rose-300';
  return 'border-border bg-surface-200 text-muted';
}

export default function TerminalPanel({ mode, onCollapse, onExpand }: TerminalPanelProps) {
  const { workspaceId, selectedWorkspace, workspaces, setWorkspaceId } = useWorkspace();

  const [sessions, setSessions] = useState<TerminalSessionRecord[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notInstalled, setNotInstalled] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [activeModel, setActiveModel] = useState('Select model');
  const [layers, setLayers] = useState<Record<string, DirectionLayer>>({});
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyClearing, setHistoryClearing] = useState(false);
  const [historySessions, setHistorySessions] = useState<TerminalHistoryRecord[]>([]);
  const [selectedHistorySessionId, setSelectedHistorySessionId] = useState<string | null>(null);

  const workspaceMenuRef = useRef<HTMLDivElement>(null);
  const historyDrawerRef = useRef<HTMLDivElement>(null);
  const initialSessionRequestedRef = useRef(false);
  const sessionsRef = useRef<TerminalSessionRecord[]>([]);

  const headerHeightClass = mode === 'panel' ? 'h-10' : 'h-9';
  const headerTextClass = mode === 'panel' ? 'text-[12px]' : 'text-[11px]';

  const activeSession = useMemo(
    () => sessions.find((session) => session.sessionId === activeSessionId) ?? null,
    [sessions, activeSessionId],
  );

  const selectedHistorySession = useMemo(
    () => historySessions.find((session) => session.sessionId === selectedHistorySessionId) ?? null,
    [historySessions, selectedHistorySessionId],
  );

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    if (mode !== 'drawer' || !isFullscreen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setIsFullscreen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [mode, isFullscreen]);

  const directionEntries = useMemo(() => {
    return LAYER_KEYS
      .map((key, index) => {
        const raw = layers[key]?.contentYaml?.trim() ?? '';
        return raw ? { key, label: `L${index + 1}`, summary: summarizeLayer(raw) } : null;
      })
      .filter((entry): entry is { key: string; label: string; summary: string } => entry !== null);
  }, [layers]);

  const directionTooltip = useMemo(() => {
    if (directionEntries.length === 0) return 'No direction layers configured';
    return directionEntries.map((entry) => `${entry.label}: ${entry.summary}`).join('\n');
  }, [directionEntries]);

  const loadDirections = useCallback(async (nextWorkspaceId: string) => {
    try {
      const res = await getAllLayers(nextWorkspaceId) as DirectionLayersResponse;
      setLayers(res.layers ?? {});
    } catch {
      setLayers({});
    }
  }, []);

  const loadHistory = useCallback(async (targetWorkspaceId: string) => {
    setHistoryLoading(true);
    try {
      const res = await apiFetch<{ sessions: TerminalHistoryRecord[] }>(
        `/api/terminal/sessions/history?workspaceId=${encodeURIComponent(targetWorkspaceId)}&limit=20`
      );
      setHistorySessions(res.sessions ?? []);
      setSelectedHistorySessionId((current) => current && res.sessions.some((s) => s.sessionId === current)
        ? current
        : res.sessions[0]?.sessionId ?? null);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const createSession = useCallback(async (targetWorkspaceId: string, activate = true) => {
    setCreating(true);
    setError(null);
    setNotInstalled(false);

    try {
      const res = await apiFetch<TerminalSessionResponse>('/api/terminal/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: targetWorkspaceId,
          rows: mode === 'drawer' ? 20 : 28,
          cols: 120,
        }),
      });

      const nextSession: TerminalSessionRecord = {
        sessionId: res.sessionId,
        workspaceId: res.workspaceId,
        cwd: res.cwd,
        createdAt: res.createdAt,
        exited: false,
      };

      setSessions((prev) => [...prev, nextSession]);
      if (activate) {
        setActiveSessionId(res.sessionId);
      }
    } catch (err) {
      if (isNotInstalledError(err)) {
        setNotInstalled(true);
      } else {
        setError('Failed to start session — is OpenCode installed?');
      }
    } finally {
      setCreating(false);
    }
  }, [mode]);

  useEffect(() => {
    if (!workspaceId) return;
    loadDirections(workspaceId);
  }, [workspaceId, loadDirections]);

  useEffect(() => {
    if (!workspaceId || initialSessionRequestedRef.current) return;
    initialSessionRequestedRef.current = true;
    void createSession(workspaceId, true);
  }, [workspaceId, createSession]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (workspaceMenuRef.current && !workspaceMenuRef.current.contains(target)) {
        setWorkspaceMenuOpen(false);
      }
      if (historyOpen && historyDrawerRef.current && !historyDrawerRef.current.contains(target)) {
        setHistoryOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setWorkspaceMenuOpen(false);
        setHistoryOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [historyOpen]);

  useEffect(() => {
    if (!historyOpen || !workspaceId) return;
    void loadHistory(workspaceId);
  }, [historyOpen, workspaceId, loadHistory]);

  useEffect(() => {
    return () => {
      sessionsRef.current.forEach((session) => {
        void apiFetch(`/api/terminal/sessions/${encodeURIComponent(session.sessionId)}`, {
          method: 'DELETE',
        }).catch(() => undefined);
      });
    };
  }, []);

  const handleWorkspaceSelect = useCallback(async (nextWorkspaceId: string) => {
    if (nextWorkspaceId === workspaceId) return;

    await Promise.allSettled(
      sessionsRef.current.map((session) =>
        apiFetch(`/api/terminal/sessions/${encodeURIComponent(session.sessionId)}`, {
          method: 'DELETE',
        })
      )
    );

    setSessions([]);
    setActiveSessionId(null);
    setHistorySessions([]);
    setSelectedHistorySessionId(null);
    initialSessionRequestedRef.current = false;
    setWorkspaceMenuOpen(false);
    setWorkspaceId(nextWorkspaceId);
    await loadDirections(nextWorkspaceId);
    await createSession(nextWorkspaceId, true);
  }, [workspaceId, setWorkspaceId, loadDirections, createSession]);

  const handleNewSession = useCallback(async () => {
    if (!workspaceId) return;
    await createSession(workspaceId, true);
  }, [workspaceId, createSession]);

  useEffect(() => {
    const handleTerminalNewSession = () => {
      void handleNewSession();
    };

    window.addEventListener('rorca:terminal-new-session', handleTerminalNewSession);
    return () => window.removeEventListener('rorca:terminal-new-session', handleTerminalNewSession);
  }, [handleNewSession]);

  const handleSessionExit = useCallback((sessionId: string) => {
    setSessions((prev) => prev.map((session) => (
      session.sessionId === sessionId ? { ...session, exited: true } : session
    )));
  }, []);

  const handleClearHistory = useCallback(async () => {
    if (!workspaceId) return;
    setHistoryClearing(true);
    try {
      await apiFetch(`/api/terminal/sessions/history?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'DELETE',
      });
      await loadHistory(workspaceId);
    } finally {
      setHistoryClearing(false);
    }
  }, [workspaceId, loadHistory]);

  const showOverlay = creating && !activeSession;

  return (
    <div className={[
      'flex min-h-0 flex-col overflow-hidden bg-[var(--panel)]',
      mode === 'drawer' && isFullscreen ? 'fixed inset-0 z-50 h-screen' : 'h-full',
    ].join(' ')}>
      <div className={`flex shrink-0 items-center justify-between border-b border-border px-3 ${headerHeightClass}`}>
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/10 text-accent">
            <Bot size={14} />
          </div>
          <div className="min-w-0">
            <div className={`font-medium text-[var(--text)] ${headerTextClass}`}>Terminal</div>
            <div className="text-[10px] text-muted" title={directionTooltip}>
              {directionEntries.length > 0 ? (
                <div className="inline-flex items-center gap-1">
                  <span>✦</span>
                  <span>{directionEntries.length} Directions</span>
                </div>
              ) : (
                <span>No directions</span>
              )}
            </div>
          </div>
        </div>

        <div className="flex min-w-0 items-center gap-2">
          <div ref={workspaceMenuRef} className="relative">
            <button
              type="button"
              onClick={() => setWorkspaceMenuOpen((prev) => !prev)}
              className="inline-flex max-w-[180px] items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-[var(--text)] hover:border-accent/40 hover:bg-accent/5"
            >
              <span className="truncate">{selectedWorkspace?.label ?? 'Select workspace'}</span>
              <ChevronDown size={12} />
            </button>
            {workspaceMenuOpen && (
              <div className="absolute right-0 top-full z-20 mt-1 min-w-[220px] rounded-md border border-border bg-panel p-1 shadow-lg">
                {workspaces.map((workspace) => {
                  const active = workspace.id === workspaceId;
                  return (
                    <button
                      key={workspace.id}
                      type="button"
                      onClick={() => { void handleWorkspaceSelect(workspace.id); }}
                      className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-[11px] ${active ? 'bg-accent/10 text-[var(--text)]' : 'text-muted hover:bg-accent/5 hover:text-[var(--text)]'}`}
                    >
                      <span className="truncate">{workspace.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <ModelPickerPopover
            workspaceId={workspaceId ?? undefined}
            value={activeModel}
            onChange={setActiveModel}
            compact
          />

          <button
            type="button"
            onClick={() => setHistoryOpen((prev) => !prev)}
            disabled={!workspaceId}
            className="inline-flex shrink-0 items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-[var(--text)] hover:border-accent/40 hover:bg-accent/5 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Clock3 size={12} />
            <span>History</span>
          </button>

          <button
            type="button"
            onClick={() => { void handleNewSession(); }}
            disabled={!workspaceId || creating}
            className="inline-flex shrink-0 items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-[var(--text)] hover:border-accent/40 hover:bg-accent/5 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus size={12} />
            <span>New Session</span>
          </button>

          {mode === 'drawer' ? (
            <>
              <button
                type="button"
                onClick={onCollapse}
                className="inline-flex shrink-0 items-center rounded border border-border p-1 text-muted hover:border-accent/40 hover:bg-accent/5 hover:text-[var(--text)]"
                aria-label="Collapse terminal drawer"
              >
                <ChevronDown size={14} />
              </button>
              <button
                type="button"
                onClick={() => {
                  if (isFullscreen) {
                    setIsFullscreen(false);
                    return;
                  }
                  setIsFullscreen(true);
                  onExpand?.();
                }}
                className="inline-flex shrink-0 items-center rounded border border-border p-1 text-muted hover:border-accent/40 hover:bg-accent/5 hover:text-[var(--text)]"
                aria-label={isFullscreen ? 'Minimize terminal overlay' : 'Expand terminal drawer'}
              >
                {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={onCollapse}
              className="inline-flex shrink-0 items-center rounded border border-border p-1 text-muted hover:border-accent/40 hover:bg-accent/5 hover:text-[var(--text)]"
              aria-label="Minimize terminal panel"
            >
              <Minimize2 size={14} />
            </button>
          )}
        </div>
      </div>

      {sessions.length > 1 && (
        <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border px-3 py-2">
          {sessions.map((session, index) => {
            const isCurrent = session.sessionId === activeSessionId;
            return (
              <button
                key={session.sessionId}
                type="button"
                onClick={() => setActiveSessionId(session.sessionId)}
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors ${isCurrent ? 'border-accent bg-accent/10 text-[var(--text)]' : 'border-border text-muted hover:border-accent/30 hover:bg-accent/5 hover:text-[var(--text)]'}`}
              >
                <span>Session {index + 1}</span>
                <span className={`h-1.5 w-1.5 rounded-full ${session.exited ? 'bg-muted/50' : 'bg-emerald-400'}`} />
              </button>
            );
          })}
        </div>
      )}

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {(activeSessionId && !error && !notInstalled && !selectedHistorySession) ? (
          <TerminalPane
            sessionId={activeSessionId}
            className="h-full"
            onExit={() => handleSessionExit(activeSessionId)}
          />
        ) : selectedHistorySession ? (
          <div className="flex h-full min-h-0 flex-col">
            <ReadOnlyTerminalPane
              key={selectedHistorySession.sessionId}
              sessionId={selectedHistorySession.sessionId}
              className="flex-1"
            />
            <div className="border-t border-border px-3 py-2 text-xs text-muted">
              Read-only — session ended
            </div>
          </div>
        ) : (
          <div className="h-full w-full bg-[var(--terminal-bg)]" />
        )}

        {showOverlay && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-start justify-start bg-transparent px-4 py-3">
            <div className="rounded border border-border/60 bg-[var(--panel)]/85 px-3 py-2 backdrop-blur-sm">
              <div className="font-mono text-xs text-muted/60">❯ </div>
              <div className="mt-1 text-xs text-muted">Initializing OpenCode session...</div>
            </div>
          </div>
        )}

        {error && (
          <div className="absolute inset-0 z-10 flex items-center justify-center px-4">
            <div className="flex max-w-md items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-4 py-3 text-sm text-[var(--text)] shadow-lg">
              <span className="flex-1">{error}</span>
              <button
                type="button"
                onClick={() => { if (workspaceId) void createSession(workspaceId, true); }}
                className="rounded border border-border px-2 py-1 text-xs hover:border-accent/40 hover:bg-accent/5"
              >
                Retry
              </button>
            </div>
          </div>
        )}

        {notInstalled && (
          <div className="absolute inset-0 z-10 flex items-center justify-center px-4">
            <div className="max-w-md rounded-lg border border-[var(--border)] bg-[var(--panel)] px-4 py-3 text-sm text-[var(--text)] shadow-lg">
              <div className="font-medium">OpenCode is not installed</div>
              <div className="mt-1 text-xs text-muted">
                Install `opencode` to use the terminal session panel.
              </div>
            </div>
          </div>
        )}

        {historyOpen && (
          <div
            ref={historyDrawerRef}
            className="absolute top-0 right-0 bottom-0 z-10 flex w-80 flex-col border-l border-border bg-panel"
          >
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <div>
                <div className="text-sm font-medium text-[var(--text)]">History</div>
                <div className="text-[11px] text-muted">Recent terminal sessions</div>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
              {historyLoading ? (
                <div className="px-2 py-3 text-xs text-muted">Loading history...</div>
              ) : historySessions.length === 0 ? (
                <div className="px-2 py-3 text-xs text-muted">No past sessions yet.</div>
              ) : (
                <div className="space-y-2">
                  {historySessions.map((session) => {
                    const isSelected = session.sessionId === selectedHistorySessionId;
                    return (
                      <button
                        key={session.sessionId}
                        type="button"
                        onClick={() => setSelectedHistorySessionId(session.sessionId)}
                        className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${isSelected ? 'border-accent bg-accent/10' : 'border-border hover:border-accent/30 hover:bg-accent/5'}`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-xs text-[var(--text)]">{session.sessionId.slice(0, 8)}</span>
                          <span className={`rounded-full border px-2 py-0.5 text-[10px] capitalize ${getStatusBadgeClass(session.status)}`}>{session.status}</span>
                        </div>
                        <div className="mt-1 truncate text-xs text-[var(--text)]">{getBasename(session.cwd)}</div>
                        <div className="mt-2 flex items-center justify-between text-[10px] text-muted">
                          <span>{formatDuration(session.createdAt, session.exitedAt)}</span>
                          <span>{formatBytes(session.totalOutputBytes)}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="border-t border-border p-2">
              <button
                type="button"
                onClick={() => { void handleClearHistory(); }}
                disabled={!workspaceId || historyClearing}
                className="flex w-full items-center justify-center gap-2 rounded border border-border px-3 py-2 text-xs text-[var(--text)] hover:border-accent/40 hover:bg-accent/5 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Trash2 size={12} />
                <span>{historyClearing ? 'Clearing...' : 'Clear History'}</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
