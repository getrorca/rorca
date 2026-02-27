import { useState, useEffect, useCallback, useRef } from 'react';
import { Menu, HelpCircle, Settings, Zap, Plus, Check } from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useAuth } from '../contexts/AuthContext';
import PricingModal from './PricingModal';
import { useHelpTips } from '../contexts/HelpTipsContext';
import AddWorkspaceModal from './AddWorkspaceModal';
import ThemeToggle from './ThemeToggle';
import NotificationBell from './NotificationBell';
import { useNetworkOffline, NetworkIndicator } from './NetworkBanner';
import { apiFetch } from '../lib/apiFetch';
import { usePipelineSSE } from '../hooks/usePipelineSSE';
import type { PanelId } from './Sidebar';

// ─── Workspace Selector ─────────────────────────────────────────────────────

function WorkspaceSelector() {
  const { workspaceId, setWorkspaceId, workspaces, addWorkspace } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);

  const selected = workspaces.find((w) => w.id === workspaceId);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-1.5 rounded text-sm bg-bg border border-border hover:border-accent transition-colors"
      >
        <span className="truncate max-w-[100px] sm:max-w-[160px]">{selected?.name ?? 'Select workspace'}</span>
        <svg className="w-3 h-3 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 mt-1 w-56 bg-panel border border-border rounded shadow-lg z-50">
            {workspaces.map((w) => (
              <button
                key={w.id}
                onClick={() => { setWorkspaceId(w.id); setOpen(false); }}
                className={`w-full text-left px-3 py-2 text-sm hover:bg-bg transition-colors ${
                  w.id === workspaceId ? 'text-accent' : 'text-[var(--text)]'
                }`}
              >
                {w.name}
              </button>
            ))}
            {workspaces.length > 0 && <div className="border-t border-border" />}
            <button
              onClick={() => { setOpen(false); setShowAddModal(true); }}
              className="w-full text-left px-3 py-2 text-sm text-muted hover:bg-bg transition-colors"
            >
              + Add Workspace
            </button>
          </div>
        </>
      )}

      {showAddModal && (
        <AddWorkspaceModal
          onClose={() => setShowAddModal(false)}
          onSuccess={(ws) => {
            addWorkspace(ws);
            setShowAddModal(false);
          }}
        />
      )}
    </div>
  );
}

// ─── Run Pill ────────────────────────────────────────────────────────────────

type RunPillState = 'idle' | 'running' | 'done';

const AUTO_HIDE_MS = 30_000;

function RunPill({ onNavigate }: { onNavigate?: (panel: PanelId) => void }) {
  const { activeRuns, workspaceId, refreshActiveRuns } = useWorkspace();
  const activeRun = activeRuns[0] ?? null;
  const activeRunId = activeRun?.id ?? null;

  const [pillState, setPillState] = useState<RunPillState>('idle');
  const [passed, setPassed] = useState(0);
  const [total, setTotal] = useState(0);
  const [visible, setVisible] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRunId = useRef<number | null>(null);

  // SSE subscription — stream WAL events for the active run
  const events = usePipelineSSE(activeRunId ? String(activeRunId) : null);

  // Fetch initial total story count when a run starts
  useEffect(() => {
    if (!activeRunId || !workspaceId) return;
    // Reset on new run
    if (lastRunId.current !== activeRunId) {
      lastRunId.current = activeRunId;
      setPassed(0);
      setTotal(0);
      setPillState('running');
      setVisible(true);
      if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
    }

    // Fetch spec to get total story count
    (async () => {
      try {
        const res = await apiFetch<{
          run: { id: number; spec_path: string };
          storyResults: { story_id: string; status: string }[];
        }>(`/api/pipeline/runs/${activeRunId}`);
        const results = res.storyResults ?? [];
        const initialPassed = results.filter((s) => s.status === 'pass').length;
        const specPath = res.run?.spec_path;
        let storyTotal = results.length || 1;
        if (specPath) {
          try {
            const specRes = await apiFetch<{ spec: { userStories?: { id: string }[] } }>(
              `/api/specs/${specPath.split('/').pop()?.replace('.json', '')}?workspaceId=${workspaceId}`,
            );
            storyTotal = specRes.spec?.userStories?.length ?? storyTotal;
          } catch { /* use results count */ }
        }
        setTotal(storyTotal);
        setPassed(initialPassed);
      } catch { /* ignore */ }
    })();
  }, [activeRunId, workspaceId]);

  // Process SSE events to update story count and detect completion
  useEffect(() => {
    if (events.length === 0) return;
    const latest = events[events.length - 1];

    if (latest.event_type === 'story_passed') {
      setPassed((p) => p + 1);
    }

    if (latest.event_type === 'run_finished' || latest.event_type === 'run_failed') {
      setPillState('done');
      // Refresh context so activeRuns clears
      refreshActiveRuns();
      // Auto-hide after 30s
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => {
        setVisible(false);
        setPillState('idle');
        lastRunId.current = null;
      }, AUTO_HIDE_MS);
    }
  }, [events, refreshActiveRuns]);

  // Track whether the dot just appeared (for fade-in animation)
  const [dotJustAppeared, setDotJustAppeared] = useState(false);
  const dotAnimTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync visibility with activeRun presence
  useEffect(() => {
    if (activeRun && pillState === 'idle') {
      setPillState('running');
      setVisible(true);
      setDotJustAppeared(true);
      if (dotAnimTimer.current) clearTimeout(dotAnimTimer.current);
      dotAnimTimer.current = setTimeout(() => setDotJustAppeared(false), 600);
    }
  }, [activeRun, pillState]);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (dotAnimTimer.current) clearTimeout(dotAnimTimer.current);
    };
  }, []);

  // Nothing to show
  if (!visible && !activeRun) {
    return (
      <button
        onClick={() => onNavigate?.('forge')}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium text-accent bg-accent/10 border border-accent/30 hover:bg-accent/20 transition-colors"
      >
        <Plus size={14} />
        New Spec
      </button>
    );
  }

  if (!visible) return null;

  const isDone = pillState === 'done';
  const label = isDone
    ? 'done'
    : total > 0 ? `${passed}/${total}` : '\u2026';

  return (
    <button
      onClick={() => activeRunId ? onNavigate?.('pipeline') : undefined}
      className={`flex items-center gap-2 px-3 py-1.5 rounded text-sm font-medium transition-colors ${
        isDone
          ? 'text-green-600 bg-green-500/10 border border-green-500/30 hover:bg-green-500/20'
          : 'text-[var(--text)] bg-accent/10 border border-accent/30 hover:bg-accent/20'
      }`}
      title={isDone ? 'Run completed' : 'View active run'}
    >
      {isDone ? (
        <span className="relative flex h-2.5 w-2.5">
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500 animate-dot-fade-pulse" />
        </span>
      ) : (
        <span className={`relative flex h-2.5 w-2.5${dotJustAppeared ? ' animate-dot-fade-pulse' : ''}`}>
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75" />
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-accent" />
        </span>
      )}
      <span className="font-mono tabular-nums">{label}</span>
      {isDone && <Check size={14} className="text-green-500" />}
    </button>
  );
}

// ─── User Menu ───────────────────────────────────────────────────────────────

function UserMenu({ onNavigate }: { onNavigate?: (panel: PanelId) => void }) {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);

  if (!user) return null;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-2 py-1.5 rounded text-sm text-muted hover:text-[var(--text)] hover:bg-bg transition-colors"
        title={user.email}
      >
        <span className="w-6 h-6 rounded-full bg-accent/20 text-accent text-xs font-medium flex items-center justify-center">
          {user.displayName.charAt(0).toUpperCase()}
        </span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-1 w-48 bg-panel border border-border rounded shadow-lg z-50">
            <div className="px-3 py-2 border-b border-border">
              <p className="text-sm text-[var(--text)] truncate">{user.displayName}</p>
              <p className="text-xs text-muted truncate">{user.email}</p>
            </div>
            <button
              onClick={() => { setOpen(false); onNavigate?.('settings'); }}
              className="w-full text-left px-3 py-2 text-sm text-muted hover:bg-bg hover:text-[var(--text)] transition-colors flex items-center gap-2"
            >
              <Settings size={14} />
              Settings
            </button>
            <button
              onClick={() => { setOpen(false); logout(); }}
              className="w-full text-left px-3 py-2 text-sm text-muted hover:bg-bg hover:text-[var(--text)] transition-colors"
            >
              Sign out
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Minor Controls ──────────────────────────────────────────────────────────

function ShowTipsToggle() {
  const { showTips, setShowTips } = useHelpTips();
  return (
    <button
      onClick={() => setShowTips(!showTips)}
      className={`flex items-center gap-1 px-2 py-1.5 rounded text-xs transition-colors ${
        showTips
          ? 'text-accent bg-accent/10 hover:bg-accent/20'
          : 'text-muted hover:text-[var(--text)] hover:bg-bg'
      }`}
      title={showTips ? 'Hide help tips' : 'Show help tips'}
      aria-label={showTips ? 'Hide help tips' : 'Show help tips'}
    >
      <HelpCircle size={14} />
      <span className="hidden sm:inline">Tips</span>
    </button>
  );
}

const PLAN_COLORS: Record<string, string> = {
  free: 'text-muted bg-bg border-border',
  solo: 'text-blue-600 bg-blue-500/10 border-blue-500/30',
  pro: 'text-accent bg-accent/10 border-accent/30',
  team: 'text-purple-600 bg-purple-500/10 border-purple-500/30',
};

function PlanBadge() {
  const { user } = useAuth();
  const [showPricing, setShowPricing] = useState(false);
  const plan = user?.plan || 'free';
  const colors = PLAN_COLORS[plan] || PLAN_COLORS.free;

  return (
    <>
      <button
        onClick={() => plan === 'free' ? setShowPricing(true) : undefined}
        className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] font-semibold uppercase tracking-wider border transition-colors ${colors} ${plan === 'free' ? 'cursor-pointer hover:border-accent' : 'cursor-default'}`}
        title={plan === 'free' ? 'Click to upgrade' : `${plan} plan`}
      >
        {plan !== 'free' && <Zap size={10} />}
        {plan}
      </button>
      {showPricing && <PricingModal onClose={() => setShowPricing(false)} />}
    </>
  );
}

// ─── Shell ───────────────────────────────────────────────────────────────────

interface ShellProps {
  sidebar?: React.ReactNode;
  children?: React.ReactNode;
  onMenuToggle?: () => void;
  showMenuButton?: boolean;
  onNavigate?: (panel: PanelId) => void;
}

export default function Shell({ sidebar, children, onMenuToggle, showMenuButton, onNavigate }: ShellProps) {
  const offline = useNetworkOffline();

  return (
    <div className="h-screen flex flex-col bg-bg">
      {/* Top Bar — 48px */}
      <header className="h-12 flex items-center justify-between px-3 sm:px-4 bg-panel border-b border-border shrink-0">
        {/* Left: hamburger + wordmark + workspace */}
        <div className="flex items-center gap-3">
          {showMenuButton && (
            <button
              onClick={onMenuToggle}
              className="md:hidden w-8 h-8 flex items-center justify-center text-muted hover:text-[var(--text)] transition-colors"
              aria-label="Open navigation menu"
            >
              <Menu size={20} />
            </button>
          )}
          <span className="font-mono font-bold text-accent text-sm tracking-tight select-none">rorca</span>
          <WorkspaceSelector />
        </div>

        {/* Right: network + plan + tips + notifications + theme + run pill + user */}
        <div className="flex items-center gap-1.5 sm:gap-2">
          <NetworkIndicator offline={offline} />
          <PlanBadge />
          <ShowTipsToggle />
          <NotificationBell onNavigate={onNavigate} />
          <ThemeToggle />
          <RunPill onNavigate={onNavigate} />
          <UserMenu onNavigate={onNavigate} />
        </div>
      </header>

      {/* Body */}
      <div className="flex flex-1 min-h-0">
        {sidebar}
        <main className="flex-1 overflow-hidden">
          {children}
        </main>
      </div>
    </div>
  );
}
