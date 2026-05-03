import { useState, useEffect, useRef } from 'react';
import { HelpCircle, Settings, Zap, Check, Network, X } from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useAuth } from '../contexts/AuthContext';
import PricingModal from './PricingModal';
import { useHelpTips } from '../contexts/HelpTipsContext';
import { useNetworkOffline, NetworkIndicator } from './NetworkBanner';
import { apiFetch } from '../lib/apiFetch';
import { usePipelineSSE } from '../hooks/usePipelineSSE';
import type { PanelId } from './Sidebar';
import { useCapabilities } from '../contexts/CapabilitiesContext';

// ─── Run Pill ────────────────────────────────────────────────────────────────

type RunPillState = 'idle' | 'running' | 'done';

const AUTO_HIDE_MS = 30_000;

export function RunPill({ onNavigate }: { onNavigate?: (panel: PanelId) => void }) {
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

  // Nothing to show if no active run
  if (!visible && !activeRun) {
    return null;
  }

  const isDone = pillState === 'done';
  const label = isDone
    ? 'done'
    : total > 0 ? `${passed}/${total}` : '\u2026';

  return (
    <button
      onClick={() => activeRunId ? onNavigate?.('runs') : undefined}
      className={`flex items-center gap-2 px-3 py-1.5 min-h-[44px] sm:min-h-0 rounded text-sm font-medium transition-colors ${isDone
        ? 'text-green-600 bg-green-500/10 border border-green-500/30 hover:bg-green-500/20'
        : 'text-[var(--text)] bg-accent/10 border border-accent/30 hover:bg-accent/20'
        }`}
      title={isDone ? 'Run completed' : 'View active run'}
      aria-label={isDone ? `Run completed: ${label}` : `Active run: ${label}`}
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
      {isDone && <Check size={14} className="text-green-500" aria-hidden="true" />}
    </button>
  );
}

// ─── User Menu ───────────────────────────────────────────────────────────────

export function UserMenu({ onNavigate }: { onNavigate?: (panel: PanelId) => void }) {
  const { user, signOut } = useAuth();
  const [open, setOpen] = useState(false);

  if (!user) return null;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center justify-center w-11 h-11 sm:w-auto sm:h-auto sm:px-2 sm:py-1.5 rounded text-sm text-muted hover:text-[var(--text)] hover:bg-bg transition-colors"
        title={user.email}
        aria-label="User menu"
        aria-expanded={open}
      >
        <span className="w-7 h-7 sm:w-6 sm:h-6 rounded-full bg-accent/20 text-accent text-xs font-medium flex items-center justify-center">
          {((user.user_metadata?.full_name as string | undefined) || user.email || '?').charAt(0).toUpperCase()}
        </span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div role="menu" aria-label="User menu" className="fixed right-3 top-14 sm:absolute sm:right-0 sm:top-auto sm:mt-1 w-48 bg-panel border border-border rounded shadow-lg z-50">
            <div className="px-3 py-2 border-b border-border">
              <p className="text-sm text-[var(--text)] truncate">{(user.user_metadata?.full_name as string | undefined) || user.email}</p>
              <p className="text-xs text-muted truncate">{user.email}</p>
            </div>
            <button
              role="menuitem"
              onClick={() => { setOpen(false); onNavigate?.('settings'); }}
              className="w-full text-left px-3 py-2 text-sm text-muted hover:bg-bg hover:text-[var(--text)] transition-colors flex items-center gap-2"
            >
              <Settings size={14} aria-hidden="true" />
              Settings
            </button>
            <button
              role="menuitem"
              onClick={() => { setOpen(false); void signOut(); }}
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

export function ShowTipsToggle() {
  const { showTips, setShowTips } = useHelpTips();
  return (
    <button
      onClick={() => setShowTips(!showTips)}
      className={`flex items-center gap-1 px-2 py-1.5 rounded text-xs transition-colors ${showTips
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

export function PlanBadge() {
  const { user } = useAuth();
  const [showPricing, setShowPricing] = useState(false);
  const plan = ((user?.app_metadata?.plan as string | undefined) || 'free') as keyof typeof PLAN_COLORS;
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
  header?: React.ReactNode; // Optional custom header override from pages
  children?: React.ReactNode;
  onMenuToggle?: () => void;
  showMenuButton?: boolean;
  onNavigate?: (panel: PanelId) => void;
}

const AGE_BANNER_DISMISS_KEY = 'rorca_age_banner_dismissed';

function LiteModeBanner() {
  const { capabilities, mode, recheckAge } = useCapabilities();
  const [dismissed, setDismissed] = useState(() => sessionStorage.getItem(AGE_BANNER_DISMISS_KEY) === '1');
  const [open, setOpen] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (capabilities?.age) {
      setDismissed(false);
      sessionStorage.removeItem(AGE_BANNER_DISMISS_KEY);
    }
  }, [capabilities?.age]);

  if (capabilities?.age !== false || dismissed) {
    return null;
  }

  const handleDismiss = () => {
    sessionStorage.setItem(AGE_BANNER_DISMISS_KEY, '1');
    setDismissed(true);
    setOpen(false);
  };

  const handleCopyCommand = async () => {
    try {
      await navigator.clipboard.writeText('rorca db start');
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const handleRecheck = async () => {
    setRechecking(true);
    try {
      const ageEnabled = await recheckAge();
      if (ageEnabled) {
        setOpen(false);
      }
    } finally {
      setRechecking(false);
    }
  };

  return (
    <>
      <div role="alert" className="flex items-center justify-between gap-3 px-4 py-2.5 bg-amber-500/10 border-b border-amber-500/20">
        <div className="flex min-w-0 items-center gap-2.5">
          <Network size={14} className="text-amber-500 shrink-0" />
          <p className="truncate text-sm text-[var(--text)]">
            Graph memory disabled (Lite Mode).
          </p>
          <button
            onClick={() => setOpen(true)}
            className="shrink-0 text-xs font-medium text-amber-600 hover:text-amber-700"
          >
            Enable →
          </button>
        </div>
        <button
          onClick={handleDismiss}
          className="shrink-0 rounded p-1 text-muted transition-colors hover:bg-amber-500/10 hover:text-[var(--text)]"
          aria-label="Dismiss Lite Mode banner"
        >
          <X size={14} />
        </button>
      </div>

      {open && (
        <>
          <div className="fixed inset-0 z-40 bg-black/45" onClick={() => setOpen(false)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
            <div role="dialog" aria-modal="true" aria-labelledby="age-enable-title" className="w-full max-w-lg rounded-2xl border border-border bg-panel p-6 shadow-2xl">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 id="age-enable-title" className="text-base font-semibold text-[var(--text)]">
                    Enable Apache AGE for graph memory features?
                  </h2>
                  <p className="mt-2 text-sm text-muted">
                    Lite Mode is active because Apache AGE is unavailable in {mode ?? 'this database mode'}.
                    Run <code className="mx-1 rounded bg-bg px-1.5 py-0.5 text-xs text-[var(--text)]">rorca db start</code>
                    in your terminal yourself. The frontend cannot execute shell commands.
                  </p>
                </div>
                <button
                  onClick={() => setOpen(false)}
                  className="rounded p-1 text-muted transition-colors hover:bg-bg hover:text-[var(--text)]"
                  aria-label="Close AGE enable modal"
                >
                  <X size={16} />
                </button>
              </div>

              <div className="mt-4 rounded-xl border border-border bg-bg/60 p-4 text-sm text-muted">
                <p>Enabling AGE requires Docker, adds roughly a 200MB image, and unlocks:</p>
                <ul className="mt-2 list-disc pl-5">
                  <li><code>/api/specs/:id/knowledge-graph</code> for graph memory in spec review</li>
                  <li><code>/api/admin/graph-backfill</code> and <code>/api/admin/graph-stats</code></li>
                  <li>Graph-powered drift detection via <code>/api/workspaces/:id/drift/check</code></li>
                  <li>Related-context expansion in story prompts</li>
                </ul>
              </div>

              <div className="mt-5 flex flex-wrap items-center gap-2">
                <button
                  onClick={() => { void handleCopyCommand(); }}
                  className="inline-flex items-center rounded-md bg-accent px-3 py-2 text-sm font-medium text-white transition-colors hover:opacity-90"
                >
                  Run rorca db start
                </button>
                <button
                  onClick={() => { void handleRecheck(); }}
                  disabled={rechecking}
                  className="inline-flex items-center rounded-md border border-border px-3 py-2 text-sm text-[var(--text)] transition-colors hover:bg-bg disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {rechecking ? 'Rechecking…' : 'Recheck availability'}
                </button>
                <button
                  onClick={handleDismiss}
                  className="inline-flex items-center rounded-md px-3 py-2 text-sm text-muted transition-colors hover:bg-bg hover:text-[var(--text)]"
                >
                  Dismiss for session
                </button>
                {copied && <span className="text-xs text-muted">Command copied.</span>}
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}

export default function Shell({ sidebar, header, children, onMenuToggle: _onMenuToggle, showMenuButton: _showMenuButton, onNavigate: _onNavigate }: ShellProps) {
  const offline = useNetworkOffline();

  return (
    <div className="h-screen flex bg-bg overflow-x-hidden w-full max-w-[100vw]">
      <a href="#main-content" className="skip-to-content">
        Skip to content
      </a>

      {/* Sidebar - Now spans full height on the left */}
      {sidebar}

      {/* Main Content Area (Column) */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden bg-bg">
        {/* If a custom header is provided, render it. Default global header is removed per Linear-style layout. */}
        {header && header}

        {/* Network offline persistent banner */}
        {offline && (
          <div role="alert" className="flex items-center justify-center gap-2 px-4 py-2 bg-warning/10 border-b border-warning/30 text-warning text-xs font-medium">
            <NetworkIndicator offline={offline} />
            <span>Connection lost — retrying…</span>
          </div>
        )}

        <LiteModeBanner />

        {/* Body Main Canvas — pb-16 on mobile for bottom tab bar clearance */}
        <main id="main-content" className="flex-1 min-h-0 min-w-0 overflow-y-auto contain-layout bg-bg relative pb-16 sm:pb-0">
          {children}
        </main>
      </div>
    </div>
  );
}
