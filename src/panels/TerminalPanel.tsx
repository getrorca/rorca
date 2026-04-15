import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  ChevronDown,
  Maximize2,
  Minimize2,
  Plus,
} from 'lucide-react';
import TerminalPane from '../components/TerminalPane';
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

interface DirectionLayersResponse {
  layers: Record<string, DirectionLayer>;
}

const LAYER_KEYS = ['l1', 'l2', 'l3', 'l4', 'l5'] as const;
const DEFAULT_FONT_SIZE = 13;
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 20;
const FONT_SIZE_STORAGE_KEY = 'rorca:terminal:fontSize';

function clampFontSize(fontSize: number): number {
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, fontSize));
}

function loadInitialFontSize(): number {
  if (typeof window === 'undefined') return DEFAULT_FONT_SIZE;
  const raw = window.localStorage.getItem(FONT_SIZE_STORAGE_KEY);
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) ? clampFontSize(parsed) : DEFAULT_FONT_SIZE;
}

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
  const [fontSize, setFontSize] = useState<number>(loadInitialFontSize);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const workspaceMenuRef = useRef<HTMLDivElement>(null);
  const initialSessionRequestedRef = useRef(false);
  const sessionsRef = useRef<TerminalSessionRecord[]>([]);

  const headerHeightClass = mode === 'panel' ? 'h-10' : 'h-9';
  const headerTextClass = mode === 'panel' ? 'text-[12px]' : 'text-[11px]';
  const fitKey = `${mode}:${isFullscreen ? 'fullscreen' : 'normal'}:${fontSize}`;

  const activeSession = useMemo(
    () => sessions.find((session) => session.sessionId === activeSessionId) ?? null,
    [sessions, activeSessionId],
  );

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, String(fontSize));
  }, [fontSize]);

  useEffect(() => {
    if (!isFullscreen) return undefined;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isFullscreen]);

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
          cols: 100,
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
        return;
      }
      setError('Failed to start session — is OpenCode installed?');
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
    const onMouseDown = (event: MouseEvent) => {
      if (!workspaceMenuRef.current?.contains(event.target as Node)) {
        setWorkspaceMenuOpen(false);
      }
    };

    if (workspaceMenuOpen) {
      document.addEventListener('mousedown', onMouseDown);
    }

    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [workspaceMenuOpen]);

  useEffect(() => {
    return () => {
      sessionsRef.current.forEach((session) => {
        void apiFetch(`/api/terminal/sessions/${encodeURIComponent(session.sessionId)}`, {
          method: 'DELETE',
          silent: true,
        }).catch(() => undefined);
      });
    };
  }, []);

  const handleWorkspaceSwitch = useCallback(async (nextWorkspaceId: string) => {
    setWorkspaceMenuOpen(false);
    if (nextWorkspaceId === workspaceId) return;

    await Promise.all(
      sessionsRef.current.map((session) =>
        apiFetch(`/api/terminal/sessions/${encodeURIComponent(session.sessionId)}`, {
          method: 'DELETE',
          silent: true,
        }).catch(() => undefined),
      ),
    );

    setWorkspaceId(nextWorkspaceId);
    setSessions([]);
    setActiveSessionId(null);
    setError(null);
    setNotInstalled(false);
    initialSessionRequestedRef.current = false;
    await loadDirections(nextWorkspaceId);
    await createSession(nextWorkspaceId, true);
  }, [workspaceId, setWorkspaceId, loadDirections, createSession]);

  const handleNewSession = useCallback(async () => {
    if (!workspaceId) return;
    await createSession(workspaceId, true);
  }, [workspaceId, createSession]);

  const handleSessionExit = useCallback((sessionId: string) => {
    setSessions((prev) => prev.map((session) => (
      session.sessionId === sessionId ? { ...session, exited: true } : session
    )));
  }, []);

  const adjustFontSize = useCallback((delta: number) => {
    setFontSize((current) => clampFontSize(current + delta));
  }, []);

  const resetFontSize = useCallback(() => {
    setFontSize(DEFAULT_FONT_SIZE);
  }, []);

  const workspaceLabel = selectedWorkspace?.name ?? 'No workspace';
  const cwdLabel = activeSession?.cwd ? getBasename(activeSession.cwd) : (selectedWorkspace?.git_path ? getBasename(selectedWorkspace.git_path) : 'workspace');
  const isActive = Boolean(activeSession && !activeSession.exited && !creating && !error && !notInstalled);
  const showOverlay = creating || (!activeSessionId && !error && !notInstalled);

  return (
    <div className={[
      'flex min-h-0 flex-col overflow-hidden bg-[var(--panel)]',
      isFullscreen ? 'fixed inset-0 z-50 h-screen w-screen' : 'h-full',
    ].join(' ')}>
      <div className={`flex shrink-0 items-center justify-between border-b border-border px-3 ${headerHeightClass}`}>
        <div className="min-w-0 flex items-center gap-2.5">
          <Bot size={14} className="shrink-0 text-accent" />
          <div className="min-w-0 leading-tight">
            <div className={`font-mono ${headerTextClass} text-muted`}>OpenCode</div>
            <div className="flex items-center gap-1.5 text-[10px] text-muted">
              <span className="truncate">{cwdLabel}</span>
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${isActive ? 'animate-pulse bg-emerald-400' : 'bg-muted/50'}`} />
            </div>
          </div>
        </div>

        <div className="ml-3 flex items-center gap-1.5 overflow-x-auto pb-px">
          <div ref={workspaceMenuRef} className="relative shrink-0">
            <button
              type="button"
              onClick={() => setWorkspaceMenuOpen((open) => !open)}
              className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-[var(--text)] hover:border-accent/40 hover:bg-accent/5"
            >
              <span className="truncate max-w-[180px]">[Workspace: {workspaceLabel}</span>
              <ChevronDown size={12} className={`transition-transform ${workspaceMenuOpen ? 'rotate-180' : ''}`} />
              <span>]</span>
            </button>
            {workspaceMenuOpen && (
              <div className="absolute right-0 top-[calc(100%+4px)] z-20 max-h-64 min-w-[220px] overflow-y-auto rounded-md border border-border bg-[var(--panel)] shadow-lg">
                {workspaces.map((workspace) => {
                  const active = workspace.id === workspaceId;
                  return (
                    <button
                      key={workspace.id}
                      type="button"
                      onClick={() => { void handleWorkspaceSwitch(workspace.id); }}
                      className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs transition-colors ${active ? 'bg-accent/10 text-[var(--text)]' : 'text-muted hover:bg-accent/5 hover:text-[var(--text)]'}`}
                    >
                      <span className="truncate">{workspace.name}</span>
                      {active && <span className="text-[10px] text-accent">Active</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="shrink-0">
            <ModelPickerPopover
              engine="opencode"
              value={activeModel}
              onChange={setActiveModel}
              workspaceId={workspaceId ?? undefined}
            />
          </div>

          <div className="inline-flex shrink-0 items-center gap-1 rounded border border-border px-1 py-1">
            <button
              type="button"
              onClick={() => adjustFontSize(-1)}
              className="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] text-[var(--text)] hover:bg-accent/5"
              aria-label="Decrease terminal font size"
              title="Decrease terminal font size"
            >
              A-
            </button>
            <button
              type="button"
              onClick={resetFontSize}
              className="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] text-[var(--text)] hover:bg-accent/5"
              aria-label="Reset terminal font size"
              title="Reset terminal font size"
            >
              A
            </button>
            <button
              type="button"
              onClick={() => adjustFontSize(1)}
              className="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] text-[var(--text)] hover:bg-accent/5"
              aria-label="Increase terminal font size"
              title="Increase terminal font size"
            >
              A+
            </button>
          </div>

          <div className="shrink-0" title={directionTooltip}>
            <div className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-muted">
              <span>✦</span>
              <span>{directionEntries.length} Directions</span>
            </div>
          </div>

          <button
            type="button"
            onClick={() => { void handleNewSession(); }}
            disabled={!workspaceId || creating}
            className="inline-flex shrink-0 items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-[var(--text)] hover:border-accent/40 hover:bg-accent/5 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus size={12} />
            <span>New Session</span>
          </button>

          <button
            type="button"
            onClick={() => setIsFullscreen((current) => !current)}
            className="inline-flex shrink-0 items-center rounded border border-border p-1 text-muted hover:border-accent/40 hover:bg-accent/5 hover:text-[var(--text)]"
            aria-label={isFullscreen ? 'Exit terminal fullscreen' : 'Enter terminal fullscreen'}
            title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          >
            {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
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
                onClick={onExpand}
                className="inline-flex shrink-0 items-center rounded border border-border p-1 text-muted hover:border-accent/40 hover:bg-accent/5 hover:text-[var(--text)]"
                aria-label="Expand terminal drawer"
              >
                <Maximize2 size={14} />
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
        {(activeSessionId && !error && !notInstalled) ? (
          <TerminalPane
            sessionId={activeSessionId}
            className="h-full"
            onExit={() => handleSessionExit(activeSessionId)}
            fontSize={fontSize}
            fitKey={fitKey}
          />
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
      </div>
    </div>
  );
}
