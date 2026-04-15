import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  Check,
  ChevronDown,
  Clock3,
  Maximize2,
  Minimize2,
  Plus,
  Trash2,
  X,
  TerminalSquare,
} from 'lucide-react';
import TerminalPane from '../components/TerminalPane';
import ReadOnlyTerminalPane from '../components/ReadOnlyTerminalPane';
import Tooltip from '../components/Tooltip';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useGlobalToast } from '../contexts/ToastContext';
import { apiFetch, ApiError } from '../lib/apiFetch';
import { getAllLayers, listModels } from '../api/direction';
import type { DirectionLayer, DirectionModel } from '../api/types';
import { useNavigate } from 'react-router-dom';

type TerminalMode = 'panel' | 'drawer';

interface TerminalPanelProps {
  mode: TerminalMode;
  onCollapse?: () => void;
  onExpand?: () => void;
}

interface TerminalSessionRecord {
  sessionId: string;
  wsToken: string; // OCT-021: Short-lived WebSocket connection token
  workspaceId: string;
  cwd: string;
  createdAt: string;
  label: string;
  autoLabeled: boolean;
  status: 'active' | 'exited' | 'killed';
}

interface TerminalSessionResponse {
  sessionId: string;
  wsToken: string; // OCT-021: Short-lived WebSocket connection token
  workspaceId: string;
  cwd: string;
  createdAt: string;
}

interface HealthResponse {
  engines?: {
    claude?: { installed: boolean };
    opencode?: { installed: boolean; version?: string };
    codex?: { installed: boolean; version?: string };
  };
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
const MAX_SESSIONS_STORAGE_KEY = 'rorca:terminal:maxSessions';
const DEFAULT_MAX_SESSIONS = 5;
const SHORT_BASH_COMMANDS = /^(ls|pwd|cd|cat|echo|git|npm|node|vim|vi|nano|clear|exit)$/;
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 20;
const DEFAULT_FONT_SIZE = 13;
const FONT_SIZE_STORAGE_KEY = 'rorca:terminal:fontSize';
const SESSIONS_STORAGE_KEY = 'rorca:terminal:sessions';
const MAX_PERSISTED_SESSIONS = 5;

function getMaxSessionsSetting(): number {
  try {
    const stored = localStorage.getItem(MAX_SESSIONS_STORAGE_KEY);
    const parsed = stored ? Number.parseInt(stored, 10) : NaN;
    if (Number.isFinite(parsed)) {
      return Math.min(10, Math.max(1, parsed));
    }
  } catch {
    // Ignore localStorage errors
  }

  return DEFAULT_MAX_SESSIONS;
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

function splitModelParts(modelId: string): { provider: string; name: string } {
  const slashIndex = modelId.indexOf('/');
  if (slashIndex === -1) {
    const dashIndex = modelId.indexOf('-');
    if (dashIndex === -1) return { provider: 'model', name: modelId };
    return { provider: modelId.slice(0, dashIndex), name: modelId.slice(dashIndex + 1) };
  }
  return { provider: modelId.slice(0, slashIndex), name: modelId.slice(slashIndex + 1) };
}

interface PersistedSession {
  sessionId: string;
  workspaceId: string;
  label: string;
  createdAt: string;
}

function loadPersistedSessions(): PersistedSession[] {
  try {
    const stored = localStorage.getItem(SESSIONS_STORAGE_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function savePersistedSession(session: PersistedSession, currentWorkspaceId: string): void {
  try {
    const all = loadPersistedSessions();
    // Add new session
    all.push(session);

    // Filter to current workspace and keep only the 5 most recent
    const forWorkspace = all
      .filter((s) => s.workspaceId === currentWorkspaceId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, MAX_PERSISTED_SESSIONS);

    // Keep all sessions from other workspaces
    const otherWorkspaces = all.filter((s) => s.workspaceId !== currentWorkspaceId);

    // Merge and save
    const updated = [...otherWorkspaces, ...forWorkspace];
    localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(updated));
  } catch {
    // Ignore localStorage errors
  }
}

function removePersistedSession(sessionId: string): void {
  try {
    const all = loadPersistedSessions();
    const filtered = all.filter((s) => s.sessionId !== sessionId);
    localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(filtered));
  } catch {
    // Ignore localStorage errors
  }
}

export default function TerminalPanel({ mode, onCollapse, onExpand }: TerminalPanelProps) {
  const { workspaceId, selectedWorkspace, workspaces, setWorkspaceId } = useWorkspace();
  const navigate = useNavigate();
  const toast = useGlobalToast();

  const [sessions, setSessions] = useState<TerminalSessionRecord[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notInstalled, setNotInstalled] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [activeModel, setActiveModel] = useState('Select model');
  const [sessionModels, setSessionModels] = useState<Record<string, string>>({});
  const [availableModels, setAvailableModels] = useState<DirectionModel[]>([]);
  const [modelQuery, setModelQuery] = useState('');
  const [modelPopoverOpen, setModelPopoverOpen] = useState(false);
  const [engineType, setEngineType] = useState<'claude' | 'opencode' | 'codex'>('opencode');
  const [layers, setLayers] = useState<Record<string, DirectionLayer>>({});
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyClearing, setHistoryClearing] = useState(false);
  const [historySessions, setHistorySessions] = useState<TerminalHistoryRecord[]>([]);
  const [selectedHistorySessionId, setSelectedHistorySessionId] = useState<string | null>(null);
  const [maxSessions, setMaxSessions] = useState(() => getMaxSessionsSetting());

  // Font size state with localStorage persistence
  const [fontSize, setFontSize] = useState(() => {
    try {
      const stored = localStorage.getItem(FONT_SIZE_STORAGE_KEY);
      if (stored) {
        const parsed = parseInt(stored, 10);
        if (!isNaN(parsed) && parsed >= MIN_FONT_SIZE && parsed <= MAX_FONT_SIZE) {
          return parsed;
        }
      }
    } catch {
      // Ignore localStorage errors
    }
    return DEFAULT_FONT_SIZE;
  });

  const workspaceMenuRef = useRef<HTMLDivElement>(null);
  const historyDrawerRef = useRef<HTMLDivElement>(null);
  const modelPopoverRef = useRef<HTMLDivElement>(null);
  const modelButtonRef = useRef<HTMLButtonElement>(null);
  const sessionsRef = useRef<TerminalSessionRecord[]>([]);
  const workspaceSessionsRef = useRef<Record<string, TerminalSessionRecord[]>>({});
  const activeWorkspaceIdRef = useRef<string | null>(workspaceId);
  const nextLabelNumRef = useRef(1);
  const [backgroundSessionsVersion, setBackgroundSessionsVersion] = useState(0);

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

  const selectedSessionModel = activeSessionId ? sessionModels[activeSessionId] : null;
  const displayedModel = selectedSessionModel ?? activeModel;
  const filteredModels = useMemo(() => {
    const query = modelQuery.trim().toLowerCase();
    if (!query) return availableModels;
    return availableModels.filter((model) => {
      const haystack = `${model.id} ${model.name} ${model.provider}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [availableModels, modelQuery]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  const bumpBackgroundSessionsVersion = useCallback(() => {
    setBackgroundSessionsVersion((value) => value + 1);
  }, []);

  const persistWorkspaceSessions = useCallback((targetWorkspaceId: string | null, nextSessions: TerminalSessionRecord[]) => {
    if (!targetWorkspaceId) return;
    workspaceSessionsRef.current[targetWorkspaceId] = nextSessions;
    bumpBackgroundSessionsVersion();
  }, [bumpBackgroundSessionsVersion]);

  const syncWorkspaceSessions = useCallback((updater: (current: TerminalSessionRecord[]) => TerminalSessionRecord[]) => {
    setSessions((prev) => {
      const next = updater(prev);
      persistWorkspaceSessions(activeWorkspaceIdRef.current, next);
      return next;
    });
  }, [persistWorkspaceSessions]);

  useEffect(() => {
    const syncMaxSessions = () => setMaxSessions(getMaxSessionsSetting());
    syncMaxSessions();
    window.addEventListener('storage', syncMaxSessions);
    window.addEventListener('focus', syncMaxSessions);
    return () => {
      window.removeEventListener('storage', syncMaxSessions);
      window.removeEventListener('focus', syncMaxSessions);
    };
  }, []);

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
    return LAYER_KEYS.reduce<Array<{ key: typeof LAYER_KEYS[number]; label: string; summary: string }>>((entries, key, index) => {
      const raw = layers[key]?.contentYaml?.trim() ?? '';
      if (raw) {
        entries.push({ key, label: `L${index + 1}`, summary: summarizeLayer(raw) });
      }
      return entries;
    }, []);
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

  const loadModelPickerData = useCallback(async (targetWorkspaceId: string) => {
    try {
      const [healthRes, modelsRes] = await Promise.all([
        apiFetch<HealthResponse>('/api/health', { silent: true }),
        listModels({ signal: undefined }),
      ]);
      const nextEngineType = healthRes.engines?.opencode?.installed ? 'opencode' : healthRes.engines?.codex?.installed ? 'codex' : 'claude';
      setEngineType(nextEngineType);
      setAvailableModels(modelsRes.models ?? []);
      if (targetWorkspaceId && !activeSessionId && modelsRes.models?.length) {
        setActiveModel((current) => current === 'Select model' ? modelsRes.models[0].id : current);
      }
    } catch {
      setAvailableModels([]);
    }
  }, [activeSessionId]);

  const createSession = useCallback(async (targetWorkspaceId: string, activate = true, modelOverride?: string) => {
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
          ...(modelOverride ? { model: modelOverride } : {}),
        }),
      });

      const labelNum = nextLabelNumRef.current;
      nextLabelNumRef.current += 1;

      const nextSession: TerminalSessionRecord = {
        sessionId: res.sessionId,
        wsToken: res.wsToken,
        workspaceId: res.workspaceId,
        cwd: res.cwd,
        createdAt: res.createdAt,
        label: `OpenCode ${labelNum}`,
        autoLabeled: false,
        status: 'active',
      };

      // Persist to localStorage
      savePersistedSession(
        {
          sessionId: res.sessionId,
          workspaceId: res.workspaceId,
          label: `OpenCode ${labelNum}`,
          createdAt: res.createdAt,
        },
        targetWorkspaceId
      );

      syncWorkspaceSessions((prev) => [...prev, nextSession]);
      if (modelOverride) {
        setSessionModels((prev) => ({ ...prev, [res.sessionId]: modelOverride }));
        setActiveModel(modelOverride);
      }
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
  }, [mode, syncWorkspaceSessions]);

  useEffect(() => {
    if (!workspaceId) return;
    loadDirections(workspaceId);
    void loadModelPickerData(workspaceId);
  }, [workspaceId, loadDirections]);

  useEffect(() => {
    if (!modelPopoverOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (modelPopoverRef.current?.contains(target) || modelButtonRef.current?.contains(target)) {
        return;
      }
      setModelPopoverOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setModelPopoverOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [modelPopoverOpen]);

  useEffect(() => {
    if (!workspaceId) return;

    const previousWorkspaceId = activeWorkspaceIdRef.current;
    if (previousWorkspaceId && previousWorkspaceId !== workspaceId) {
      workspaceSessionsRef.current[previousWorkspaceId] = sessionsRef.current;
    }

    activeWorkspaceIdRef.current = workspaceId;
    setHistorySessions([]);
    setSelectedHistorySessionId(null);
    setError(null);
    setNotInstalled(false);

    const restoreWorkspaceSessions = async () => {
      const storedSessions = workspaceSessionsRef.current[workspaceId];
      if (storedSessions && storedSessions.length > 0) {
        setSessions(storedSessions);
        setActiveSessionId((current) => current && storedSessions.some((session) => session.sessionId === current)
          ? current
          : storedSessions[0]?.sessionId ?? null);
        nextLabelNumRef.current = storedSessions.length + 1;
        bumpBackgroundSessionsVersion();
        return;
      }

      const persisted = loadPersistedSessions().filter((session) => session.workspaceId === workspaceId);
      if (persisted.length === 0) {
        setSessions([]);
        setActiveSessionId(null);
        nextLabelNumRef.current = 1;
        persistWorkspaceSessions(workspaceId, []);
        await createSession(workspaceId, true);
        return;
      }

      const restoredSessions: TerminalSessionRecord[] = [];
      for (const session of persisted) {
        try {
          const res = await apiFetch<TerminalSessionResponse>(
            `/api/terminal/sessions/${encodeURIComponent(session.sessionId)}`
          );

          restoredSessions.push({
            sessionId: res.sessionId,
            wsToken: res.wsToken,
            workspaceId: res.workspaceId,
            cwd: res.cwd,
            createdAt: res.createdAt,
            label: session.label,
            autoLabeled: true,
            status: 'active',
          });
        } catch {
          removePersistedSession(session.sessionId);
        }
      }

      if (restoredSessions.length > 0) {
        workspaceSessionsRef.current[workspaceId] = restoredSessions;
        setSessions(restoredSessions);
        setActiveSessionId(restoredSessions[0]?.sessionId ?? null);
        nextLabelNumRef.current = restoredSessions.length + 1;
        bumpBackgroundSessionsVersion();
        toast.info('Reconnected to existing session');
        return;
      }

      setSessions([]);
      setActiveSessionId(null);
      nextLabelNumRef.current = 1;
      persistWorkspaceSessions(workspaceId, []);
      await createSession(workspaceId, true);
    };

    void restoreWorkspaceSessions();
  }, [workspaceId, createSession, persistWorkspaceSessions, toast, bumpBackgroundSessionsVersion]);

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

    persistWorkspaceSessions(workspaceId, sessionsRef.current);
    setWorkspaceMenuOpen(false);
    setWorkspaceId(nextWorkspaceId);
  }, [workspaceId, setWorkspaceId, persistWorkspaceSessions]);

  const handleNewSession = useCallback(async () => {
    if (!workspaceId || sessions.length >= maxSessions) return;
    await createSession(workspaceId, true);
  }, [workspaceId, createSession, sessions.length, maxSessions]);

  useEffect(() => {
    const handleTerminalNewSession = () => {
      void handleNewSession();
    };

    window.addEventListener('rorca:terminal-new-session', handleTerminalNewSession);
    return () => window.removeEventListener('rorca:terminal-new-session', handleTerminalNewSession);
  }, [handleNewSession]);

  const handleSessionExit = useCallback((sessionId: string) => {
    syncWorkspaceSessions((prev) => prev.map((session) => (
      session.sessionId === sessionId ? { ...session, status: 'exited' } : session
    )));
  }, [syncWorkspaceSessions]);

  const handleSessionInput = useCallback((sessionId: string, data: string) => {
    syncWorkspaceSessions((prev) => prev.map((session) => {
      if (session.sessionId !== sessionId || session.autoLabeled) {
        return session;
      }

      const trimmed = data.trim();

      // Skip empty or very short inputs (just Enter, single char, etc.)
      if (trimmed.length <= 3) {
        return session;
      }

      let newLabel: string;

      // Check if it's a short bash command
      const firstWord = trimmed.split(/\s+/)[0] ?? '';
      if (SHORT_BASH_COMMANDS.test(firstWord)) {
        // Use cwd basename as label
        const basename = getBasename(session.cwd);
        newLabel = basename;
      } else {
        // Use the input text, truncated to 40 chars
        newLabel = trimmed.slice(0, 40).trim();
      }

      return {
        ...session,
        label: newLabel,
        autoLabeled: true,
      };
    }));
  }, [syncWorkspaceSessions]);

  const handleCloseSession = useCallback(async (sessionId: string) => {
    // Delete from backend
    try {
      await apiFetch(`/api/terminal/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
      });
    } catch {
      // Ignore deletion errors
    }

    // Remove from localStorage
    removePersistedSession(sessionId);
    setSessionModels((prev) => {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });

    // Remove from local state
    syncWorkspaceSessions((prev) => {
      const filtered = prev.filter((s) => s.sessionId !== sessionId);

      // If we're closing the active session, activate another one
      if (sessionId === activeSessionId && filtered.length > 0) {
        const closedIndex = prev.findIndex((s) => s.sessionId === sessionId);
        // Try to activate the previous tab, or next if no previous
        const targetIndex = closedIndex > 0 ? closedIndex - 1 : 0;
        setActiveSessionId(filtered[targetIndex]?.sessionId ?? null);
      } else if (filtered.length === 0) {
        setActiveSessionId(null);
      }

      return filtered;
    });
  }, [activeSessionId, syncWorkspaceSessions]);

  const handleSelectSessionModel = useCallback((model: string) => {
    if (!activeSessionId) return;
    setSessionModels((prev) => ({ ...prev, [activeSessionId]: model }));
    setActiveModel(model);
    setModelPopoverOpen(false);
    setModelQuery('');
  }, [activeSessionId]);

  const handleRestartWithModel = useCallback(async () => {
    if (!workspaceId || !activeSessionId) return;
    const model = sessionModels[activeSessionId] ?? activeModel;
    await handleCloseSession(activeSessionId);
    await createSession(workspaceId, true, model);
  }, [workspaceId, activeSessionId, sessionModels, activeModel, handleCloseSession, createSession]);

  useEffect(() => {
    const validWorkspaceIds = new Set(workspaces.map((workspace) => workspace.id));
    let changed = false;

    for (const workspaceKey of Object.keys(workspaceSessionsRef.current)) {
      if (!validWorkspaceIds.has(workspaceKey)) {
        delete workspaceSessionsRef.current[workspaceKey];
        changed = true;
      }
    }

    if (changed) {
      bumpBackgroundSessionsVersion();
    }
  }, [workspaces, bumpBackgroundSessionsVersion]);

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

  const handleFontSizeChange = useCallback((delta: number) => {
    setFontSize((current) => {
      const next = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, current + delta));
      return next;
    });
  }, []);

  const handleFontSizeReset = useCallback(() => {
    setFontSize(DEFAULT_FONT_SIZE);
  }, []);

  // Persist font size to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(FONT_SIZE_STORAGE_KEY, String(fontSize));
    } catch {
      // Ignore localStorage errors
    }
  }, [fontSize]);

  const showOverlay = creating && !activeSession;
  const backgroundWorkspaceSessions = useMemo(() => {
    if (!workspaceId) return [];
    return Object.entries(workspaceSessionsRef.current)
      .filter(([id, workspaceSessions]) => id !== workspaceId && workspaceSessions.length > 0)
      .map(([id, workspaceSessions]) => ({
        workspaceId: id,
        count: workspaceSessions.length,
        label: workspaces.find((workspace) => workspace.id === id)?.name ?? 'Unknown workspace',
      }));
  }, [workspaceId, workspaces, backgroundSessionsVersion]);
  const backgroundSessionCount = backgroundWorkspaceSessions.reduce((sum, workspace) => sum + workspace.count, 0);
  const backgroundSessionsTooltip = backgroundWorkspaceSessions
    .map((workspace) => `${workspace.label}: ${workspace.count}`)
    .join('\n');

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
            <div className={`font-medium text-[var(--text)] ${headerTextClass}`}>OpenCode</div>
            <div className="text-[10px] text-muted">
              {activeSession ? (
                <div className="inline-flex items-center gap-1.5">
                  <span className={activeSession.status === 'active' ? 'h-2 w-2 rounded-full bg-emerald-400 animate-pulse' : 'h-2 w-2 rounded-full bg-muted/50'} />
                  <span>{getBasename(activeSession.cwd)}</span>
                </div>
              ) : (
                <span title={directionTooltip}>
                  {directionEntries.length > 0 ? `${directionEntries.length} Directions` : 'No directions'}
                </span>
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
              <span className="truncate">{selectedWorkspace?.name ?? 'Select workspace'}</span>
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
                      <span className="truncate">{workspace.name}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {backgroundSessionCount > 0 && (
            <Tooltip content={backgroundSessionsTooltip}>
              <span className="inline-flex shrink-0 items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500 dark:bg-gray-800">
                {backgroundSessionCount} background session{backgroundSessionCount === 1 ? '' : 's'}
              </span>
            </Tooltip>
          )}

          {engineType === 'opencode' && (
            <div className="relative shrink-0">
              <button
                ref={modelButtonRef}
                type="button"
                onClick={() => setModelPopoverOpen((prev) => !prev)}
                className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-[var(--text)] hover:border-accent/40 hover:bg-accent/5"
              >
                <Bot size={12} />
                <span className="max-w-[180px] truncate">{displayedModel}</span>
                <ChevronDown size={12} className="text-muted" />
              </button>
              {activeSession && selectedSessionModel && (
                <div className="mt-1 text-[10px] italic text-muted/70">Takes effect on new session</div>
              )}
              {activeSession && selectedSessionModel && (
                <button
                  type="button"
                  onClick={() => { void handleRestartWithModel(); }}
                  className="mt-1 inline-flex items-center rounded border border-border px-2 py-0.5 text-[11px] text-muted hover:text-[var(--text)]"
                >
                  Restart with this model
                </button>
              )}
              {modelPopoverOpen && (
                <div
                  ref={modelPopoverRef}
                  className="absolute right-2 top-[44px] z-50 w-64 rounded-lg border border-border bg-panel p-2 shadow-lg"
                >
                  <div className="mb-2 text-[11px] font-medium text-muted">Session model</div>
                  <input
                    value={modelQuery}
                    onChange={(event) => setModelQuery(event.target.value)}
                    placeholder="Filter models..."
                    className="mb-2 w-full rounded border border-border px-2 py-1 text-[11px] text-[var(--text)] outline-none"
                  />
                  <div className="max-h-48 overflow-y-auto">
                    {filteredModels.map((model) => {
                      const { provider, name } = splitModelParts(model.id);
                      const isSelected = displayedModel === model.id;
                      return (
                        <button
                          key={model.id}
                          type="button"
                          onClick={() => handleSelectSessionModel(model.id)}
                          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent/5"
                        >
                          <span className="rounded bg-surface-200 px-1.5 py-0.5 text-[10px] text-muted">{provider}</span>
                          <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text)]">{name}</span>
                          {isSelected && <Check size={12} className="text-[var(--text)]" />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="flex shrink-0 items-center gap-0.5 rounded border border-border">
            <Tooltip content="Decrease font size">
              <button
                type="button"
                onClick={() => handleFontSizeChange(-1)}
                disabled={fontSize <= MIN_FONT_SIZE}
                className="inline-flex h-7 min-w-8 items-center justify-center px-2 text-[11px] font-medium text-[var(--text)] hover:bg-accent/5 disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="Decrease font size"
              >
                A-
              </button>
            </Tooltip>
            <Tooltip content="Reset font size">
              <button
                type="button"
                onClick={handleFontSizeReset}
                className="inline-flex h-7 min-w-8 items-center justify-center border-x border-border px-2 text-[11px] font-medium text-[var(--text)] hover:bg-accent/5"
                aria-label="Reset font size"
              >
                A
              </button>
            </Tooltip>
            <Tooltip content="Increase font size">
              <button
                type="button"
                onClick={() => handleFontSizeChange(1)}
                disabled={fontSize >= MAX_FONT_SIZE}
                className="inline-flex h-7 min-w-8 items-center justify-center px-2 text-[11px] font-medium text-[var(--text)] hover:bg-accent/5 disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="Increase font size"
              >
                A+
              </button>
            </Tooltip>
          </div>

          <button
            type="button"
            onClick={() => setHistoryOpen((prev) => !prev)}
            disabled={!workspaceId}
            className="inline-flex shrink-0 items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-[var(--text)] hover:border-accent/40 hover:bg-accent/5 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Clock3 size={12} />
            <span>History</span>
          </button>

          <Tooltip content={`Max ${maxSessions} sessions`} disabled={sessions.length < maxSessions}>
            <button
              type="button"
              onClick={() => { void handleNewSession(); }}
              disabled={!workspaceId || creating || sessions.length >= maxSessions}
              className="inline-flex shrink-0 items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-[var(--text)] hover:border-accent/40 hover:bg-accent/5 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus size={12} />
              <span>New Session</span>
            </button>
          </Tooltip>

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
            aria-label={isFullscreen ? 'Exit fullscreen terminal' : 'Enter fullscreen terminal'}
          >
            {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>

          {mode === 'drawer' ? (
            <button
              type="button"
              onClick={onCollapse}
              className="inline-flex shrink-0 items-center rounded border border-border p-1 text-muted hover:border-accent/40 hover:bg-accent/5 hover:text-[var(--text)]"
              aria-label="Collapse terminal drawer"
            >
              <ChevronDown size={14} />
            </button>
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
          {sessions.map((session) => {
            const isCurrent = session.sessionId === activeSessionId;
            const statusDotClass = session.status === 'active' ? 'bg-emerald-400' : 'bg-muted/50';

            return (
              <div
                key={session.sessionId}
                className={`group inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors ${isCurrent ? 'border-accent bg-surface-200 text-[var(--text)]' : 'border-border bg-transparent text-muted hover:border-accent/30 hover:bg-surface-100 hover:text-[var(--text)]'}`}
              >
                <button
                  type="button"
                  onClick={() => setActiveSessionId(session.sessionId)}
                  className="flex items-center gap-1.5"
                  title={session.label}
                >
                  <span className="max-w-[120px] truncate">{session.label}</span>
                  <span className={`h-1.5 w-1.5 rounded-full ${statusDotClass}`} />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleCloseSession(session.sessionId);
                  }}
                  className="ml-0.5 opacity-0 transition-opacity group-hover:opacity-100"
                  aria-label="Close session"
                >
                  <X size={12} className="text-muted hover:text-[var(--text)]" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {(sessions.length > 0 && !error && !notInstalled && !selectedHistorySession) ? (
          <div className="h-full w-full">
            {sessions.map((session) => {
              const isActive = session.sessionId === activeSessionId;

              return (
                <div
                  key={session.sessionId}
                  className="h-full w-full"
                  style={{ display: isActive ? 'block' : 'none' }}
                >
                  <TerminalPane
                    sessionId={session.sessionId}
                    wsToken={session.wsToken}
                    visible={isActive}
                    className="h-full"
                    fontSize={fontSize}
                    onExit={() => handleSessionExit(session.sessionId)}
                    onInput={(data) => handleSessionInput(session.sessionId, data)}
                  />
                </div>
              );
            })}
          </div>
        ) : selectedHistorySession ? (
          <div className="flex h-full min-h-0 flex-col">
            <ReadOnlyTerminalPane
              key={selectedHistorySession.sessionId}
              sessionId={selectedHistorySession.sessionId}
              fontSize={fontSize}
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
            <div className="flex max-w-md flex-col items-center text-center">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-surface-200">
                <TerminalSquare size={48} className="text-muted opacity-50" />
              </div>
              <h3 className="mb-2 text-base font-medium text-[var(--text)]">OpenCode not installed</h3>
              <p className="mb-4 text-[13px] text-muted">
                The terminal requires OpenCode CLI. Install it to use the interactive terminal.
              </p>
              <div className="mb-4 w-full rounded bg-surface-200 px-3 py-2 font-mono text-sm text-[var(--text)]">
                npm install -g opencode
              </div>
              <button
                type="button"
                onClick={() => navigate('/settings/providers')}
                className="rounded border border-accent bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover"
              >
                Open Settings → Providers
              </button>
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
