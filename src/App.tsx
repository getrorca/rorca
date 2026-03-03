import { useState, useMemo, useEffect, useRef, useCallback, Suspense } from 'react';
import { Routes, Route, Navigate, Outlet, useLocation, useNavigate as useRouterNavigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { HelpTipsProvider } from './contexts/HelpTipsContext';
import { ToastProvider, useGlobalToast } from './contexts/ToastContext';
import { WorkspaceProvider, useWorkspace } from './contexts/WorkspaceContext';
import { NotificationProvider } from './contexts/NotificationContext';
import Shell from './components/Shell';
import Sidebar, { type PanelId } from './components/Sidebar';
import SettingsSidebar from './components/SettingsSidebar';
import ResizableSidebar from './components/ResizableSidebar';
import ErrorBoundary from './components/ErrorBoundary';
import EmailVerificationBanner from './components/EmailVerificationBanner';
import WorkspaceBootstrapBanner from './components/WorkspaceBootstrapBanner';
import { useHotkeys, type HotkeyBinding } from './hooks/useHotkeys';
import { apiFetch, onApiFetchError } from './lib/apiFetch';
import PublicReviewPage from './pages/PublicReviewPage';
import { HubSkeleton, GenericPanelSkeleton, RunViewTerminalSkeleton } from './components/Skeleton';
import SlideOver from './components/SlideOver';
import CommandPalette from './components/CommandPalette';
import ForgotPasswordPage from './components/ForgotPasswordPage';
import ResetPasswordPage from './components/ResetPasswordPage';
import OnboardingWizard from './components/OnboardingWizard';
import SpecForgePanelPage from './panels/SpecForgePanelPage';
// ReviewQueuePanel removed — pending specs are now inline in Forge (UX-007)
import PipelineMonitorPanel from './panels/PipelineMonitorPanel';
import WorktreesPanel from './panels/WorktreesPanel';
import ArchivePanel from './panels/ArchivePanel';
import CompareRunsPanel from './panels/CompareRunsPanel';
import GitHubSettingsPanel from './panels/GitHubSettingsPanel';
import TeamDirectionPanel from './panels/TeamDirectionPanel';
import TemplateMarketplacePanel from './panels/TemplateMarketplacePanel';
import SettingsPanel, { type SettingsTab } from './panels/SettingsPanel';
import HubPanel from './panels/HubPanel';
import RunViewPanel from './panels/RunViewPanel';
import SpecReviewPanel from './panels/SpecReviewPanel';
import MemoryPanel from './panels/MemoryPanel';
import DirectionTabbedPanel from './panels/DirectionTabbedPanel';
import RunsTabbedPanel from './panels/RunsTabbedPanel';
import { useFileWatchSSE } from './hooks/useFileWatchSSE';
import { useAppNavigate, useActivePanel, PANEL_ROUTES } from './routes';

type AuthPage = 'login' | 'register' | 'forgot-password' | 'reset-password';

function AuthGate() {
  const { isAuthenticated, loading } = useAuth();
  const location = useLocation();
  const [authPage, setAuthPage] = useState<AuthPage>(() => {
    if (location.pathname === '/reset-password') return 'reset-password';
    return 'login';
  });

  // EQ-007: Public review page — rendered outside auth gate
  const reviewMatch = location.pathname.match(/^\/review\/([a-f0-9-]+)$/i);
  if (reviewMatch) {
    return (
      <Suspense fallback={<GenericPanelSkeleton />}>
        <PublicReviewPage token={reviewMatch[1]} />
      </Suspense>
    );
  }

  if (loading) {
    return (
      <NotificationProvider>
        <WorkspaceProvider>
          <Shell>
            <HubSkeleton />
          </Shell>
        </WorkspaceProvider>
      </NotificationProvider>
    );
  }

  // Handle /reset-password route
  if (authPage === 'reset-password') {
    const params = new URLSearchParams(location.search);
    const token = params.get('token') || '';
    if (!token) {
      return (
        <Suspense fallback={<GenericPanelSkeleton />}>
          <ForgotPasswordPage onSwitchToLogin={() => { window.history.replaceState(null, '', '/'); setAuthPage('login'); }} />
        </Suspense>
      );
    }
    return (
      <Suspense fallback={<GenericPanelSkeleton />}>
        <ResetPasswordPage
          token={token}
          onSwitchToLogin={() => { window.history.replaceState(null, '', '/'); setAuthPage('login'); }}
        />
      </Suspense>
    );
  }

  // Auth gate bypassed — Rorca is a local single-user tool
  void isAuthenticated; void authPage; void setAuthPage;

  return (
    <NotificationProvider>
      <WorkspaceProvider>
        <AppRoutes />
      </WorkspaceProvider>
    </NotificationProvider>
  );
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
  hub: 'Hub',
  forge: 'Spec Forge',
  stack: 'Direction',
  'team-direction': 'Team Direction',
  queue: 'Forge',
  pipeline: 'Pipeline Monitor',
  worktrees: 'Worktree Manager',
  compare: 'Compare Runs',
  archive: 'Archive',
  marketplace: 'Template Marketplace',
  usage: 'Token Usage',
  costs: 'Cost Breakdown',
  models: 'Model Comparison',
  velocity: 'Velocity Chart',
  completion: 'Completion Rates',
  roi: 'ROI Calculator',
  finops: 'FinOps Dashboard',
  health: 'Health Dashboard',
  'audit-log': 'Audit Log',
  activity: 'Activity Feed',
  github: 'GitHub Settings',
  'workspace-settings': 'Workspace Settings',
  settings: 'Settings',
  'spec-review': 'Spec Review',
  memory: 'Memory Ledger',
};

/** Top-level route config — Shell layout wraps all panel routes */
function AppRoutes() {
  const { workspaces } = useWorkspace();

  if (workspaces.length === 0) {
    return (
      <Shell>
        <Suspense fallback={<GenericPanelSkeleton />}>
          <OnboardingWizard />
        </Suspense>
      </Shell>
    );
  }

  return (
    <Routes>
      <Route element={<AppLayout />}>
        {/* Index route — Hub */}
        <Route index element={<PanelRoute panel="hub" />} />
        {/* Specs */}
        <Route path="forge" element={<PanelRoute panel="forge" />} />
        <Route path="queue" element={<Navigate to="/forge" replace />} />
        <Route path="archive" element={<PanelRoute panel="archive" />} />
        <Route path="marketplace" element={<PanelRoute panel="marketplace" />} />
        {/* Pipeline */}
        <Route path="pipeline" element={<PanelRoute panel="pipeline" />} />
        <Route path="worktrees" element={<PanelRoute panel="worktrees" />} />
        <Route path="compare" element={<PanelRoute panel="compare" />} />
        {/* Direction */}
        <Route path="direction" element={<PanelRoute panel="stack" />} />
        <Route path="team-direction" element={<PanelRoute panel="team-direction" />} />
        <Route path="memory" element={<PanelRoute panel="memory" />} />
        {/* Analytics — redirect to Settings > Analytics */}
        <Route path="usage" element={<Navigate to="/settings/analytics" replace />} />
        <Route path="costs" element={<Navigate to="/settings/analytics" replace />} />
        <Route path="models" element={<Navigate to="/settings/analytics" replace />} />
        <Route path="velocity" element={<Navigate to="/settings/analytics" replace />} />
        <Route path="completion" element={<Navigate to="/settings/analytics" replace />} />
        <Route path="roi" element={<Navigate to="/settings/analytics" replace />} />
        <Route path="finops" element={<Navigate to="/settings/analytics" replace />} />
        <Route path="health" element={<Navigate to="/settings/analytics" replace />} />
        {/* System — redirect to Settings > System */}
        <Route path="audit-log" element={<Navigate to="/settings/system" replace />} />
        <Route path="activity" element={<Navigate to="/settings/system" replace />} />
        <Route path="github" element={<Navigate to="/settings/github" replace />} />
        <Route path="workspace-settings" element={<Navigate to="/settings/general" replace />} />
        {/* FR-004: Settings with nested sub-tab routes */}
        <Route path="settings" element={<Navigate to="/settings/general" replace />} />
        <Route path="settings/:tab" element={<PanelRoute panel="settings" />} />
        {/* Slide-over nested routes — render Hub underneath, SlideOver opens on top */}
        <Route path="runs/:runId" element={<PanelRoute panel="hub" />} />
        <Route path="specs/:specId/review" element={<PanelRoute panel="hub" />} />
        {/* Catch-all — redirect to hub */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

/** Renders the correct panel component based on the panel prop */
function PanelRoute({ panel }: { panel: PanelId }) {
  const navigate = useAppNavigate();
  const { navigateToRun, reviewSpecId, navigateToSpecReview, forgeBrief, handleForgeBriefConsumed } = useAppContentContext();

  return (
    <ErrorBoundary key={panel} label={PANEL_LABELS[panel] || 'Panel'}>
      <ActivePanel
        id={panel}
        onNavigate={navigate}
        onNavigateToRun={navigateToRun}
        reviewSpecId={reviewSpecId}
        onNavigateToSpecReview={navigateToSpecReview}
        forgeBrief={forgeBrief}
        onForgeBriefConsumed={handleForgeBriefConsumed}
      />
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
  switch (id) {
    case 'hub': return <HubPanel onNavigate={onNavigate} onNavigateToRun={onNavigateToRun} onNavigateToSpecReview={onNavigateToSpecReview} />;
    case 'forge': return <SpecForgePanelPage onNavigate={onNavigate} onNavigateToRun={onNavigateToRun} {...(forgeBrief != null ? { initialBrief: forgeBrief, onBriefConsumed: onForgeBriefConsumed } : {})} />;
    // Direction tabbed panel — embeds Direction Stack, Team, Memory, Rules
    case 'stack': return <DirectionTabbedPanel />;
    case 'team-direction': return <TeamDirectionPanel />;
    case 'memory': return <MemoryPanel />;
    case 'queue': return <SpecForgePanelPage onNavigate={onNavigate} onNavigateToRun={onNavigateToRun} showPending {...(forgeBrief != null ? { initialBrief: forgeBrief, onBriefConsumed: onForgeBriefConsumed } : {})} />;
    // Runs tabbed panel — embeds Pipeline Monitor, Worktrees, Compare
    case 'pipeline': return <RunsTabbedPanel onNavigate={onNavigate} />;
    case 'worktrees': return <WorktreesPanel />;
    case 'compare': return <CompareRunsPanel onBack={() => onNavigate('pipeline')} />;
    case 'archive': return <ArchivePanel onNavigate={onNavigate} />;
    case 'marketplace': return <TemplateMarketplacePanel />;
    // Analytics and System panels are now inside Settings tabs — these cases
    // are kept for CommandPalette navigation compatibility but redirect via router
    case 'usage': case 'costs': case 'models': case 'velocity':
    case 'completion': case 'roi': case 'finops': case 'health':
      return <SettingsPanel />;
    case 'audit-log': case 'activity':
      return <SettingsPanel />;
    case 'github': return <GitHubSettingsPanel />;
    case 'workspace-settings': return <SettingsPanel />;
    case 'settings': return <SettingsPanel />;
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
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [forgeBrief, setForgeBrief] = useState<string | null>(null);
  const [queueCount, setQueueCount] = useState(0);

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

  const navigateToRun = useCallback((runId: number) => {
    routerNavigate(`/runs/${runId}`);
  }, [routerNavigate]);

  const navigateBackFromRun = useCallback(() => {
    routerNavigate(-1);
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

  // Global keyboard shortcuts
  const hotkeys = useMemo<HotkeyBinding[]>(() => [
    { key: 'mod+k', handler: () => setShowCommandPalette((prev) => !prev) },
    { key: '?', handler: () => navigateToSettingsTab('shortcuts') },
    { key: 'mod+/', handler: () => navigateToSettingsTab('shortcuts') },
    { key: 'mod+1', handler: () => handleNavigate('hub') },
    { key: 'mod+2', handler: () => handleNavigate('forge') },
    { key: 'mod+3', handler: () => handleNavigate('pipeline') },
    { key: 'mod+4', handler: () => handleNavigate('settings') },
    { key: 'mod+n', handler: () => handleNavigate('forge') },
    { key: 'mod+enter', handler: () => { if (activePanel !== 'forge' && activePanel !== 'spec-review') handleNavigate('forge'); } },
    { key: 'mod+backspace', handler: () => { if (activePanel !== 'forge' && activePanel !== 'spec-review') handleNavigate('forge'); } },
    { key: 'mod+shift+n', handler: () => { handleSendToForge(''); handleNavigate('forge'); } },
    { key: 'mod+shift+r', handler: () => handleNavigate('pipeline') },
  ], [handleNavigate, handleSendToForge, navigateToSettingsTab, activePanel]);

  useHotkeys(hotkeys);

  const showRunView = activeRunId !== null;

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
                queueCount={queueCount}
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
          handleNavigate('hub');
          window.dispatchEvent(new CustomEvent('rorca:open-wizard'));
        }} />
        {/* Router-driven panel content */}
        <Outlet />

        {/* Slide-over Overlays */}
        <SlideOver isOpen={showRunView} onClose={navigateBackFromRun} hideHeader={true}>
          {showRunView && (
            <Suspense fallback={<RunViewTerminalSkeleton />}>
              <RunViewPanel
                runId={activeRunId}
                onBack={navigateBackFromRun}
                onNavigate={handleNavigate}
              />
            </Suspense>
          )}
        </SlideOver>

        <SlideOver isOpen={reviewSpecId !== null} onClose={navigateBackFromRun} hideHeader={true}>
          {reviewSpecId !== null && (
            <SpecReviewPanel specId={reviewSpecId} onBack={navigateBackFromRun} onNavigate={handleNavigate} />
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
      </Shell>
    </AppContentContext.Provider>
  );
}

function App() {
  return (
    <ThemeProvider>
      <HelpTipsProvider>
        <ToastProvider>
          <AuthProvider>
            <GlobalErrorWiring />
            <AuthGate />
          </AuthProvider>
        </ToastProvider>
      </HelpTipsProvider>
    </ThemeProvider>
  );
}

export default App;
