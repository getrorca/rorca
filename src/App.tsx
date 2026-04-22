import { useState, useMemo, useEffect, useRef, useCallback, Suspense, lazy } from 'react';
import { Routes, Route, Navigate, Outlet, useLocation, useNavigate as useRouterNavigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { HelpTipsProvider } from './contexts/HelpTipsContext';
import { ToastProvider, useGlobalToast } from './contexts/ToastContext';
import { WorkspaceProvider, useWorkspace } from './contexts/WorkspaceContext';
import { NotificationProvider } from './contexts/NotificationContext';
import Shell from './components/Shell';
import RequireAuth from './components/RequireAuth';
import Sidebar, { type PanelId } from './components/Sidebar';
import SettingsSidebar from './components/SettingsSidebar';
import ResizableSidebar from './components/ResizableSidebar';
import ErrorBoundary from './components/ErrorBoundary';
import EmailVerificationBanner from './components/EmailVerificationBanner';
import WorkspaceBootstrapBanner from './components/WorkspaceBootstrapBanner';
import { useHotkeys, type HotkeyBinding } from './hooks/useHotkeys';
import { useBreakpoint } from './hooks/useBreakpoint';
import { apiFetch, onApiFetchError } from './lib/apiFetch';
import {
  BoardSkeleton,
  ListSkeleton,
  AnalyticsSkeleton,
  DirectionSkeleton,
  RunViewSkeleton,
  SettingsFormSkeleton,
} from './components/skeletons';
import SlideOver from './components/SlideOver';
import TerminalDrawer from './components/TerminalDrawer';
import { useFileWatchSSE } from './hooks/useFileWatchSSE';
import { usePipelineRuns } from './hooks/usePipelineRuns';
import { useAppNavigate, useActivePanel, PANEL_ROUTES } from './routes';
import { TerminalDrawerProvider, useTerminalDrawer } from './contexts/TerminalDrawerContext';

// — Lazy-loaded pages (not part of initial bundle) —
const PublicReviewPage = lazy(() => import('./pages/PublicReviewPage'));
const GitHubCallbackPage = lazy(() => import('./pages/GitHubCallbackPage'));
const AuthCallbackPage = lazy(() => import('./pages/auth/AuthCallbackPage'));
const LoginPage = lazy(() => import('./pages/auth/LoginPage'));
const RegisterPage = lazy(() => import('./pages/auth/RegisterPage'));
const ForgotPasswordPage = lazy(() => import('./pages/auth/ForgotPasswordPage'));
const ResetPasswordPage = lazy(() => import('./pages/auth/ResetPasswordPage'));
const OnboardingWizard = lazy(() => import('./components/OnboardingWizard'));
const CommandPalette = lazy(() => import('./components/CommandPalette'));
const KeyboardShortcutsPanel = lazy(() => import('./components/KeyboardShortcutsPanel'));

// — Lazy-loaded panel components (each gets its own chunk) —
// ULT-006: Only 5 primary panels + RunView + SpecReview + GitHubSettings
const SpecsPanel = lazy(() => import('./panels/SpecsPanel'));
const RunsTabbedPanel = lazy(() => import('./panels/RunsTabbedPanel'));
const DirectionTabbedPanel = lazy(() => import('./panels/DirectionTabbedPanel'));
const AnalyticsPanel = lazy(() => import('./panels/AnalyticsPanel'));
const SettingsPanel = lazy(() => import('./panels/SettingsPanel'));
// GitHubSettingsPanel — now part of Settings > Integrations (loaded within SettingsPanel)
const RunViewPanel = lazy(() => import('./panels/RunViewPanel'));
const SpecReviewPanel = lazy(() => import('./panels/SpecReviewPanel'));
const MarketplacePanel = lazy(() => import('./panels/MarketplacePanel'));
const TerminalPanel = lazy(() => import('./panels/TerminalPanel'));

// SettingsTab type — imported from SettingsPanel module
type SettingsTab = import('./panels/SettingsPanel').SettingsTab;

function PublicOnlyRoute({ children }: { children: JSX.Element }) {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return <BoardSkeleton />;
  }

  if (isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  return children;
}

/** Subscribes to apiFetch error events and unhandled rejections, shows toasts */
function GlobalErrorWiring() {
  const { show } = useGlobalToast();
  const recentRef = useRef(new Set<string>());

  const showDeduped = useCallback((message: string) => {
    const key = message.slice(0, 100);
    if (recentRef.current.has(key)) return;
    recentRef.current.add(key);
    setTimeout(() => recentRef.current.delete(key), 2000);
    show(message, 'error');
  }, [show]);

  useEffect(() => {
    return onApiFetchError((message) => {
      showDeduped(message);
    });
  }, [showDeduped]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (detail) {
        showDeduped(detail.slice(0, 200));
      }
    };
    window.addEventListener('rorca:unhandled-error', handler);
    return () => window.removeEventListener('rorca:unhandled-error', handler);
  }, [showDeduped]);

  return null;
}

/** Panel label for ErrorBoundary fallback */
const PANEL_LABELS: Record<PanelId, string> = {
  specs: 'Specs',
  runs: 'Runs',
  terminal: 'Terminal',
  analytics: 'Analytics',
  direction: 'Direction',
  settings: 'Settings',
  marketplace: 'Marketplace',
  'run-view': 'Run View',
  'spec-review': 'Spec Review',
};

/** Top-level route config — Shell layout wraps all panel routes */
function AppRoutes() {
  const { workspaces, workspacesLoading } = useWorkspace();

  if (workspacesLoading) {
    return <Shell><BoardSkeleton /></Shell>;
  }

  if (workspaces.length === 0) {
    return (
      <Shell>
        <Suspense fallback={<BoardSkeleton />}>
          <OnboardingWizard />
        </Suspense>
      </Shell>
    );
  }

  return (
    <Routes>
      <Route
        path="/review/:token"
        element={
          <Suspense fallback={<BoardSkeleton />}>
            <PublicReviewPage />
          </Suspense>
        }
      />
      <Route
        path="/auth/github/callback"
        element={
          <Suspense fallback={<BoardSkeleton />}>
            <GitHubCallbackPage />
          </Suspense>
        }
      />
      <Route
        path="/auth/callback"
        element={
          <Suspense fallback={<BoardSkeleton />}>
            <AuthCallbackPage />
          </Suspense>
        }
      />
      <Route
        path="/auth/login"
        element={
          <PublicOnlyRoute>
            <Suspense fallback={<BoardSkeleton />}>
              <LoginPage />
            </Suspense>
          </PublicOnlyRoute>
        }
      />
      <Route
        path="/auth/register"
        element={
          <PublicOnlyRoute>
            <Suspense fallback={<BoardSkeleton />}>
              <RegisterPage />
            </Suspense>
          </PublicOnlyRoute>
        }
      />
      <Route
        path="/auth/forgot-password"
        element={
          <Suspense fallback={<BoardSkeleton />}>
            <ForgotPasswordPage />
          </Suspense>
        }
      />
      <Route
        path="/auth/reset-password"
        element={
          <Suspense fallback={<BoardSkeleton />}>
            <ResetPasswordPage />
          </Suspense>
        }
      />
      <Route
        path="/invites/:token"
        element={
          <PublicOnlyRoute>
            <Suspense fallback={<BoardSkeleton />}>
              <RegisterPage />
            </Suspense>
          </PublicOnlyRoute>
        }
      />
      <Route element={<RequireAuth><AppLayout /></RequireAuth>}>
        {/* ULT-006: Index route → Specs */}
        <Route index element={<Navigate to="/specs" replace />} />
        {/* Specs — consolidated panel (Board | List | Marketplace tabs) */}
        <Route path="specs" element={<PanelRoute panel="specs" />} />
        {/* Runs — pipeline queue + run view */}
        <Route path="runs" element={<PanelRoute panel="runs" />} />
        {/* Terminal — OpenCode interactive PTY, fullscreen panel mode */}
        <Route path="terminal" element={<PanelRoute panel="terminal" />} />
        {/* Direction — tabbed: Direction + Team + Memory + Rules */}
        <Route path="direction" element={<PanelRoute panel="direction" />} />
        {/* Analytics — unified panel (ULT-005) */}
        <Route path="analytics" element={<PanelRoute panel="analytics" />} />
        {/* Settings with nested sub-tab routes */}
        <Route path="settings" element={<Navigate to="/settings/general" replace />} />
        <Route path="settings/:tab" element={<PanelRoute panel="settings" />} />
        {/* Run view — full-width panel */}
        <Route path="runs/:runId" element={<PanelRoute panel="runs" />} />
        {/* Spec review — slide-over on top of specs */}
        <Route path="specs/:specId/review" element={<PanelRoute panel="specs" />} />

        {/* Legacy redirects — all old routes redirect to new 5-panel structure */}
        <Route path="forge" element={<Navigate to="/specs" replace />} />
        <Route path="queue" element={<Navigate to="/specs" replace />} />
        <Route path="archive" element={<Navigate to="/specs" replace />} />
        {/* Marketplace — extracted from Specs panel */}
        <Route path="marketplace" element={<PanelRoute panel="marketplace" />} />
        <Route path="pipeline" element={<Navigate to="/runs" replace />} />
        <Route path="worktrees" element={<Navigate to="/runs" replace />} />
        <Route path="compare" element={<Navigate to="/runs" replace />} />
        <Route path="team-direction" element={<Navigate to="/direction" replace />} />
        <Route path="memory" element={<Navigate to="/direction" replace />} />
        <Route path="usage" element={<Navigate to="/analytics" replace />} />
        <Route path="costs" element={<Navigate to="/analytics" replace />} />
        <Route path="models" element={<Navigate to="/analytics" replace />} />
        <Route path="velocity" element={<Navigate to="/analytics" replace />} />
        <Route path="completion" element={<Navigate to="/analytics" replace />} />
        <Route path="roi" element={<Navigate to="/analytics" replace />} />
        <Route path="finops" element={<Navigate to="/analytics" replace />} />
        <Route path="health" element={<Navigate to="/analytics" replace />} />
        <Route path="audit-log" element={<Navigate to="/settings/system" replace />} />
        <Route path="activity" element={<Navigate to="/settings/system" replace />} />
        <Route path="github" element={<Navigate to="/settings/github" replace />} />
        <Route path="workspace-settings" element={<Navigate to="/settings/general" replace />} />

        {/* Catch-all → Specs */}
        <Route path="*" element={<Navigate to="/specs" replace />} />
      </Route>
    </Routes>
  );
}

/** Returns the appropriate Suspense fallback skeleton for a given panel.
 *  ULT-017: Uses shimmer-based skeletons that match each panel's final layout shape. */
function getPanelSkeleton(panel: PanelId) {
  switch (panel) {
    case 'specs': case 'spec-review':
      return <BoardSkeleton />;
    case 'runs':
      return <ListSkeleton />;
    case 'run-view':
      return <RunViewSkeleton />;
    case 'direction':
      return <DirectionSkeleton />;
    case 'analytics':
      return <AnalyticsSkeleton />;
    case 'settings':
      return <SettingsFormSkeleton />;
    case 'marketplace':
      return <BoardSkeleton />;
    case 'terminal':
      return <div className="flex-1 bg-[#0d1117]" />;
    default: return <BoardSkeleton />;
  }
}

/** Renders the correct panel component based on the panel prop */
function PanelRoute({ panel }: { panel: PanelId }) {
  const navigate = useAppNavigate();
  const { navigateToRun, reviewSpecId, navigateToSpecReview, forgeBrief, handleForgeBriefConsumed } = useAppContentContext();

  return (
    <ErrorBoundary key={panel} label={PANEL_LABELS[panel] || 'Panel'}>
      <Suspense fallback={getPanelSkeleton(panel)}>
        <ActivePanel
          id={panel}
          onNavigate={navigate}
          onNavigateToRun={navigateToRun}
          reviewSpecId={reviewSpecId}
          onNavigateToSpecReview={navigateToSpecReview}
          forgeBrief={forgeBrief}
          onForgeBriefConsumed={handleForgeBriefConsumed}
        />
      </Suspense>
    </ErrorBoundary>
  );
}

interface ActivePanelProps {
  id: PanelId;
  onNavigate: (panel: PanelId) => void;
  onNavigateToRun: (runId: number) => void;
  reviewSpecId: string | null;
  onNavigateToSpecReview: (specId: string) => void;
  forgeBrief: string | null;
  onForgeBriefConsumed: () => void;
}

function ActivePanel({ id, onNavigate, onNavigateToRun, reviewSpecId, onNavigateToSpecReview, forgeBrief, onForgeBriefConsumed }: ActivePanelProps) {
  const { activeRunId, navigateBackFromRun } = useAppContentContext();

  switch (id) {
    case 'specs':
      return <SpecsPanel onNavigate={onNavigate} onNavigateToRun={onNavigateToRun} {...(forgeBrief != null ? { initialBrief: forgeBrief, onBriefConsumed: onForgeBriefConsumed } : {})} />;

    case 'runs':
      if (activeRunId !== null) {
        return <RunViewPanel runId={activeRunId} onBack={navigateBackFromRun} onNavigate={onNavigate} />;
      }
      return <RunsTabbedPanel onNavigate={onNavigate} onNavigateToRun={onNavigateToRun} />;

    case 'direction':
      return <DirectionTabbedPanel />;

    case 'analytics':
      return <AnalyticsPanel />;

    case 'settings':
      return <SettingsPanel />;

    case 'marketplace':
      return <MarketplacePanel onNavigate={onNavigate} />;

    case 'terminal':
      // TerminalPanel is always-mounted in AppLayout to preserve PTY session state.
      // Nothing to render here — the always-mounted instance handles display.
      return null;

    default: return null;
  }
}

// ─── Shared context for app-level state (run view, review, forge brief, etc.) ─

import { createContext, useContext } from 'react';

interface AppContentContextValue {
  navigateToRun: (runId: number) => void;
  navigateBackFromRun: () => void;
  activeRunId: number | null;
  reviewSpecId: string | null;
  navigateToSpecReview: (specId: string) => void;
  forgeBrief: string | null;
  handleSendToForge: (brief: string) => void;
  handleForgeBriefConsumed: () => void;
  navigateToSettingsTab: (tab: SettingsTab) => void;
}

const AppContentContext = createContext<AppContentContextValue | null>(null);

function useAppContentContext(): AppContentContextValue {
  const ctx = useContext(AppContentContext);
  if (!ctx) throw new Error('useAppContentContext must be used within AppLayout');
  return ctx;
}

/** Layout route: Shell (sidebar + content area) wrapping an Outlet */
function AppLayout() {
  const activePanel = useActivePanel();
  const navigate = useAppNavigate();
  const routerNavigate = useRouterNavigate();
  const location = useLocation();
  const { workspaceId } = useWorkspace();
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [showShortcutsOverlay, setShowShortcutsOverlay] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [forgeBrief, setForgeBrief] = useState<string | null>(null);
  const [queueCount, setQueueCount] = useState(0);
  const [pendingSpecsCount, setPendingSpecsCount] = useState(0);
  useBreakpoint();
  const { toggle: toggleTerminalDrawer } = useTerminalDrawer();
  // Derive activeRunId from URL path /runs/:runId
  const runMatch = location.pathname.match(/^\/runs\/(\d+)/);
  const activeRunId = runMatch ? Number(runMatch[1]) : null;

  // Derive reviewSpecId from URL path /specs/:specId/review
  const specMatch = location.pathname.match(/^\/specs\/([^/]+)\/review/);
  const reviewSpecId = specMatch ? specMatch[1] : null;

  // CIE-009: Toast on external context file changes
  useFileWatchSSE();

  // Poll queue count every 10s for badge
  useEffect(() => {
    if (!workspaceId) { setQueueCount(0); return; }
    const fetchCount = () => {
      apiFetch<{ queueLength: number }>(`/api/run-queue/status?workspaceId=${workspaceId}`)
        .then((data) => setQueueCount(data.queueLength))
        .catch(() => setQueueCount(0));
    };
    fetchCount();
    const interval = setInterval(fetchCount, 10_000);
    return () => clearInterval(interval);
  }, [workspaceId]);

  // Poll pending specs count every 10s for Review Queue badge
  useEffect(() => {
    if (!workspaceId) { setPendingSpecsCount(0); return; }
    const fetchPendingCount = () => {
      apiFetch<{ items: unknown[]; total: number }>(`/api/specs?workspaceId=${workspaceId}&status=pending`)
        .then((data) => setPendingSpecsCount(data.total))
        .catch(() => setPendingSpecsCount(0));
    };
    fetchPendingCount();
    const interval = setInterval(fetchPendingCount, 10_000);
    return () => clearInterval(interval);
  }, [workspaceId]);

  // ULT-004: Shared singleton poll for pipeline runs (sidebar badge)
  const { runs: pipelineRuns } = usePipelineRuns(workspaceId, 10_000);
  const activeRunCount = pipelineRuns.filter(r => r.status === 'running' || r.status === 'paused').length;

  const navigateToRun = useCallback((runId: number) => {
    routerNavigate(`/runs/${runId}`);
  }, [routerNavigate]);

  const navigateBackFromRun = useCallback(() => {
    routerNavigate('/runs');
  }, [routerNavigate]);

  const navigateToSpecReview = useCallback((specId: string) => {
    routerNavigate(`/specs/${specId}/review`);
  }, [routerNavigate]);

  const handleSendToForge = useCallback((brief: string) => {
    setForgeBrief(brief);
  }, []);

  const handleForgeBriefConsumed = useCallback(() => {
    setForgeBrief(null);
  }, []);

  // Navigate to a panel — uses router
  const handleNavigate = useCallback((panel: PanelId) => {
    navigate(panel);
  }, [navigate]);

  // FR-004: Navigate to a specific settings sub-tab via URL
  const navigateToSettingsTab = useCallback((tab: SettingsTab) => {
    routerNavigate(`/settings/${tab}`);
  }, [routerNavigate]);

  // ULT-013: Global keyboard shortcuts — 1-5 switch panels, n=new spec, ?=shortcuts overlay
  const hotkeys = useMemo<HotkeyBinding[]>(() => [
    { key: 'mod+k', handler: () => setShowCommandPalette((prev) => !prev) },
    { key: '?', handler: () => setShowShortcutsOverlay((prev) => !prev) },
    { key: 'mod+/', handler: () => setShowShortcutsOverlay((prev) => !prev) },
    // Number keys 1-5 switch panels (when no input is focused — useHotkeys skips inputs)
    { key: '1', handler: () => handleNavigate('specs') },
    { key: '2', handler: () => handleNavigate('runs') },
    { key: '3', handler: () => handleNavigate('analytics') },
    { key: '4', handler: () => handleNavigate('direction') },
    { key: '5', handler: () => handleNavigate('settings') },
    // n = New Spec (navigate to specs and trigger forge)
    { key: 'n', handler: () => { handleSendToForge(''); handleNavigate('specs'); } },
    // r = Run pipeline (navigate to runs)
    { key: 'r', handler: () => handleNavigate('runs') },
    // Mod+1-5 also works
    { key: 'mod+1', handler: () => handleNavigate('specs') },
    { key: 'mod+2', handler: () => handleNavigate('runs') },
    { key: 'mod+3', handler: () => handleNavigate('analytics') },
    { key: 'mod+4', handler: () => handleNavigate('direction') },
    { key: 'mod+5', handler: () => handleNavigate('settings') },
    { key: 'mod+n', handler: () => handleNavigate('specs') },
    { key: 'mod+enter', handler: () => { if (activePanel !== 'specs' && activePanel !== 'spec-review') handleNavigate('specs'); } },
    { key: 'mod+backspace', handler: () => { if (activePanel !== 'specs' && activePanel !== 'spec-review') handleNavigate('specs'); } },
    { key: 'mod+shift+n', handler: () => { handleSendToForge(''); handleNavigate('specs'); } },
    // mod+shift+r intentionally removed — conflicts with browser hard refresh (Cmd+Shift+R)
    // Escape: close overlays in reverse order
    { key: 'escape', handler: () => {
      if (showCommandPalette) { setShowCommandPalette(false); return; }
      if (showShortcutsOverlay) { setShowShortcutsOverlay(false); return; }
    }, preventDefault: false },
  ], [handleNavigate, handleSendToForge, activePanel, showCommandPalette, showShortcutsOverlay]);

  useHotkeys(hotkeys);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'j') {
        event.preventDefault();
        toggleTerminalDrawer();
        return;
      }

      if (event.ctrlKey && event.code === 'Backquote') {
        event.preventDefault();
        toggleTerminalDrawer();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleTerminalDrawer]);

  const contextValue = useMemo<AppContentContextValue>(() => ({
    navigateToRun,
    navigateBackFromRun,
    activeRunId,
    reviewSpecId,
    navigateToSpecReview,
    forgeBrief,
    handleSendToForge,
    handleForgeBriefConsumed,
    navigateToSettingsTab,
  }), [navigateToRun, navigateBackFromRun, activeRunId, reviewSpecId, navigateToSpecReview, forgeBrief, handleSendToForge, handleForgeBriefConsumed, navigateToSettingsTab]);

  return (
    <AppContentContext.Provider value={contextValue}>
      <Shell
        sidebar={
          <ResizableSidebar>
            {activePanel === 'settings' ? (
              <SettingsSidebar onNavigate={handleNavigate} />
            ) : (
              <Sidebar
                onNavigate={handleNavigate}
                mobileOpen={mobileNavOpen}
                onMobileClose={() => setMobileNavOpen(false)}
                queueCount={pendingSpecsCount}
                activeRunCount={activeRunCount}
              />
            )}
          </ResizableSidebar>
        }
        showMenuButton
        onMenuToggle={() => setMobileNavOpen((v) => !v)}
        onNavigate={handleNavigate}
      >
        <EmailVerificationBanner />
        <WorkspaceBootstrapBanner onSetUpNow={() => {
          handleNavigate('specs');
          window.dispatchEvent(new CustomEvent('rorca:open-wizard'));
        }} />
        {/* Router-driven panel content */}
        {/* Terminal panel is always mounted to preserve PTY session state across navigation.
            Visibility is controlled via CSS — hidden when not on /terminal route. */}
        <div className={location.pathname === '/terminal' ? 'contents' : 'hidden'}>
          <Suspense fallback={<div className="flex-1 bg-[#0d1117]" />}>
            <TerminalPanel mode="panel" />
          </Suspense>
        </div>
        {location.pathname !== '/terminal' && <Outlet />}

        {/* Slide-over Overlays */}
        <SlideOver isOpen={reviewSpecId !== null} onClose={navigateBackFromRun} hideHeader={true}>
          {reviewSpecId !== null && (
            <SpecReviewPanel specId={reviewSpecId} onBack={navigateBackFromRun} onNavigate={handleNavigate} onNavigateToRun={navigateToRun} />
          )}
        </SlideOver>

        {showCommandPalette && (
          <Suspense fallback={null}>
            <CommandPalette
              onNavigate={handleNavigate}
              onClose={() => setShowCommandPalette(false)}
              activePanel={activePanel}
              activeRunId={activeRunId}
              onSendToForge={handleSendToForge}
            />
          </Suspense>
        )}

        {showShortcutsOverlay && (
          <Suspense fallback={null}>
            <KeyboardShortcutsPanel onClose={() => setShowShortcutsOverlay(false)} />
          </Suspense>
        )}
        <TerminalDrawer />
      </Shell>
    </AppContentContext.Provider>
  );
}

function App() {
  return (
    <ThemeProvider>
      <HelpTipsProvider>
        <ToastProvider>
          <TerminalDrawerProvider>
            <AuthProvider>
              <GlobalErrorWiring />
              <NotificationProvider>
                <WorkspaceProvider>
                  <AppRoutes />
                </WorkspaceProvider>
              </NotificationProvider>
            </AuthProvider>
          </TerminalDrawerProvider>
        </ToastProvider>
      </HelpTipsProvider>
    </ThemeProvider>
  );
}

export default App;
