import { useState, useMemo, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { HelpTipsProvider } from './contexts/HelpTipsContext';
import { ToastProvider, useGlobalToast } from './contexts/ToastContext';
import { WorkspaceProvider, useWorkspace } from './contexts/WorkspaceContext';
import { NotificationProvider } from './contexts/NotificationContext';
import Shell from './components/Shell';
import Sidebar, { type PanelId } from './components/Sidebar';
import OnboardingWizard from './components/OnboardingWizard';
import CommandPalette from './components/CommandPalette';
// KeyboardShortcutsPanel modal replaced by Settings > Shortcuts tab (UI-032)
import ErrorBoundary from './components/ErrorBoundary';
// NetworkBanner is now inline in Shell.tsx top bar (useNetworkOffline + NetworkIndicator)
import LoginPage from './components/LoginPage';
import RegisterPage from './components/RegisterPage';
import ForgotPasswordPage from './components/ForgotPasswordPage';
import ResetPasswordPage from './components/ResetPasswordPage';
import EmailVerificationBanner from './components/EmailVerificationBanner';
import { useHotkeys, type HotkeyBinding } from './hooks/useHotkeys';
import { onApiFetchError } from './lib/apiFetch';
import PublicReviewPage from './pages/PublicReviewPage';
import { HubSkeleton, RunViewTerminalSkeleton, ForgeSkeleton, SettingsSkeleton, GenericPanelSkeleton } from './components/Skeleton';
import type { SettingsTab } from './panels/SettingsPanel';

// ── Lazy-loaded panels (code-split into separate chunks) ──
const HubPanel = lazy(() => import('./panels/HubPanel'));
const RunViewPanel = lazy(() => import('./panels/RunViewPanel'));
const SpecForgePanelPage = lazy(() => import('./panels/SpecForgePanelPage'));
const SettingsPanel = lazy(() => import('./panels/SettingsPanel'));
const SpecReviewPanel = lazy(() => import('./panels/SpecReviewPanel'));
const ReviewQueuePanel = lazy(() => import('./panels/ReviewQueuePanel'));
const PipelineMonitorPanel = lazy(() => import('./panels/PipelineMonitorPanel'));
const WorktreesPanel = lazy(() => import('./panels/WorktreesPanel'));
const ArchivePanel = lazy(() => import('./panels/ArchivePanel'));
const CompareRunsPanel = lazy(() => import('./panels/CompareRunsPanel'));
const GitHubSettingsPanel = lazy(() => import('./panels/GitHubSettingsPanel'));
const ActivityFeedPanel = lazy(() => import('./panels/ActivityFeedPanel'));
const TeamDirectionPanel = lazy(() => import('./panels/TeamDirectionPanel'));
const TemplateMarketplacePanel = lazy(() => import('./panels/TemplateMarketplacePanel'));
const UsageDashboardPanel = lazy(() => import('./panels/UsageDashboardPanel'));
const CostBreakdownPanel = lazy(() => import('./panels/CostBreakdownPanel'));
const ModelComparisonPanel = lazy(() => import('./panels/ModelComparisonPanel'));
const VelocityChartPanel = lazy(() => import('./panels/VelocityChartPanel'));
const CompletionRatePanel = lazy(() => import('./panels/CompletionRatePanel'));
const HealthDashboardPanel = lazy(() => import('./panels/HealthDashboardPanel'));
const AuditLogPanel = lazy(() => import('./panels/AuditLogPanel'));
const RoiCalculatorPanel = lazy(() => import('./panels/RoiCalculatorPanel'));
const WorkspaceSettingsPanel = lazy(() => import('./panels/WorkspaceSettingsPanel'));

type AuthPage = 'login' | 'register' | 'forgot-password' | 'reset-password';

function AuthGate() {
  const { isAuthenticated, loading } = useAuth();
  const [authPage, setAuthPage] = useState<AuthPage>(() => {
    // Check if landing on /reset-password with a token
    if (window.location.pathname === '/reset-password') return 'reset-password';
    return 'login';
  });

  // EQ-007: Public review page — rendered outside auth gate
  const reviewMatch = window.location.pathname.match(/^\/review\/([a-f0-9-]+)$/i);
  if (reviewMatch) {
    return <PublicReviewPage token={reviewMatch[1]} />;
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg">
        <div className="text-muted text-sm">Loading...</div>
      </div>
    );
  }

  // Handle /reset-password route — show reset page even when auth is bypassed
  if (authPage === 'reset-password') {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') || '';
    if (!token) {
      // No token provided — go to forgot password
      return <ForgotPasswordPage onSwitchToLogin={() => { window.history.replaceState(null, '', '/'); setAuthPage('login'); }} />;
    }
    return (
      <ResetPasswordPage
        token={token}
        onSwitchToLogin={() => { window.history.replaceState(null, '', '/'); setAuthPage('login'); }}
      />
    );
  }

  // Auth gate bypassed — Rorca is a local single-user tool, login wall not needed yet
  void isAuthenticated; void authPage; void setAuthPage;

  return (
    <NotificationProvider>
      <WorkspaceProvider>
        <AppContent />
      </WorkspaceProvider>
    </NotificationProvider>
  );
}

/** Subscribes to apiFetch error events and unhandled rejections, shows toasts */
function GlobalErrorWiring() {
  const { show } = useGlobalToast();

  // Track recent messages to avoid duplicate toasts (apiFetch errors + unhandled rejections)
  const recentRef = useRef(new Set<string>());

  const showDeduped = useCallback((message: string) => {
    const key = message.slice(0, 100);
    if (recentRef.current.has(key)) return;
    recentRef.current.add(key);
    setTimeout(() => recentRef.current.delete(key), 2000);
    show(message, 'error');
  }, [show]);

  // API fetch errors → toast
  useEffect(() => {
    return onApiFetchError((message) => {
      showDeduped(message);
    });
  }, [showDeduped]);

  // Unhandled promise rejections → toast
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

/** Map PanelId to appropriate skeleton fallback */
function panelFallback(id: PanelId) {
  switch (id) {
    case 'hub': return <HubSkeleton />;
    case 'forge': return <ForgeSkeleton />;
    case 'stack':
    case 'settings': return <SettingsSkeleton />;
    default: return <GenericPanelSkeleton />;
  }
}

/** Renders the active panel component with lazy-load Suspense boundary */
function ActivePanel({ id, onNavigate, onNavigateToRun, reviewSpecId, onNavigateToSpecReview, forgeBrief, settingsTab }: { id: PanelId; onNavigate: (p: PanelId) => void; onNavigateToRun?: (runId: number) => void; reviewSpecId?: string | null; onNavigateToSpecReview?: (specId: string) => void; forgeBrief?: string | null; settingsTab?: SettingsTab }) {
  let panel: React.ReactNode;
  switch (id) {
    case 'hub': panel = <HubPanel onNavigate={onNavigate} onNavigateToRun={onNavigateToRun} onNavigateToSpecReview={onNavigateToSpecReview} />; break;
    case 'forge': panel = <SpecForgePanelPage onNavigate={onNavigate} onNavigateToRun={onNavigateToRun} {...(forgeBrief != null ? { initialBrief: forgeBrief } : {})} />; break;
    case 'spec-review': panel = <SpecReviewPanel specId={reviewSpecId ?? ''} onBack={() => onNavigate('hub')} onNavigate={onNavigate} />; break;
    case 'stack': panel = <SettingsPanel initialTab={settingsTab} />; break;
    case 'team-direction': panel = <TeamDirectionPanel />; break;
    case 'queue': panel = <ReviewQueuePanel />; break;
    case 'pipeline': panel = <PipelineMonitorPanel />; break;
    case 'worktrees': panel = <WorktreesPanel />; break;
    case 'compare': panel = <CompareRunsPanel onBack={() => onNavigate('pipeline')} />; break;
    case 'archive': panel = <ArchivePanel onNavigate={onNavigate} />; break;
    case 'marketplace': panel = <TemplateMarketplacePanel />; break;
    case 'usage': panel = <UsageDashboardPanel />; break;
    case 'costs': panel = <CostBreakdownPanel />; break;
    case 'models': panel = <ModelComparisonPanel />; break;
    case 'velocity': panel = <VelocityChartPanel />; break;
    case 'completion': panel = <CompletionRatePanel />; break;
    case 'roi': panel = <RoiCalculatorPanel />; break;
    case 'health': panel = <HealthDashboardPanel />; break;
    case 'audit-log': panel = <AuditLogPanel />; break;
    case 'activity': panel = <ActivityFeedPanel />; break;
    case 'github': panel = <GitHubSettingsPanel />; break;
    case 'workspace-settings': panel = <WorkspaceSettingsPanel />; break;
    case 'settings': panel = <SettingsPanel initialTab={settingsTab} />; break;
    default: return null;
  }
  return <Suspense fallback={panelFallback(id)}>{panel}</Suspense>;
}

/** Panel label for ErrorBoundary fallback */
const PANEL_LABELS: Record<PanelId, string> = {
  hub: 'Hub',
  forge: 'Spec Forge',
  stack: 'Direction Stack',
  'team-direction': 'Team Direction',
  queue: 'Review Queue',
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
  health: 'Health Dashboard',
  'audit-log': 'Audit Log',
  activity: 'Activity Feed',
  github: 'GitHub Settings',
  'workspace-settings': 'Workspace Settings',
  settings: 'Settings',
  'spec-review': 'Spec Review',
};

function AppContent() {
  const [activePanel, setActivePanel] = useState<PanelId>('hub');
  const [activeRunId, setActiveRunId] = useState<number | null>(null);
  const [reviewSpecId, setReviewSpecId] = useState<string | null>(null);
  const { workspaces } = useWorkspace();
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [forgeBrief, setForgeBrief] = useState<string | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | undefined>(undefined);

  // Parse run ID from URL hash on mount (e.g. #/run/42)
  useEffect(() => {
    const parseHash = () => {
      const match = window.location.hash.match(/^#\/run\/(\d+)$/);
      if (match) {
        setActiveRunId(Number(match[1]));
        setActivePanel('hub'); // Run View lives under Hub nav
      }
    };
    parseHash();
    window.addEventListener('hashchange', parseHash);
    return () => window.removeEventListener('hashchange', parseHash);
  }, []);

  // Sync hash when navigating to/from run view
  const navigateToRun = useCallback((runId: number) => {
    setActiveRunId(runId);
    setActivePanel('hub');
    window.location.hash = `/run/${runId}`;
  }, []);

  const navigateBackFromRun = useCallback(() => {
    setActiveRunId(null);
    window.location.hash = '';
  }, []);

  const navigateToSpecReview = useCallback((specId: string) => {
    setReviewSpecId(specId);
    setActivePanel('spec-review');
    if (activeRunId !== null) {
      setActiveRunId(null);
      window.location.hash = '';
    }
  }, [activeRunId]);

  // Send brief from command palette to Forge
  const handleSendToForge = useCallback((brief: string) => {
    setForgeBrief(brief);
    // Clear after a tick so the prop is consumed once
    setTimeout(() => setForgeBrief(null), 500);
  }, []);

  // Override setActivePanel to clear run view when navigating elsewhere
  const handleNavigate = useCallback((panel: PanelId) => {
    setActivePanel(panel);
    // Reset settings tab when navigating away from settings
    if (panel !== 'settings') setSettingsTab(undefined);
    if (activeRunId !== null) {
      setActiveRunId(null);
      window.location.hash = '';
    }
  }, [activeRunId]);

  // Navigate to settings with a specific tab
  const navigateToSettingsTab = useCallback((tab: SettingsTab) => {
    setSettingsTab(tab);
    handleNavigate('settings');
  }, [handleNavigate]);

  // Global keyboard shortcuts via useHotkeys
  const hotkeys = useMemo<HotkeyBinding[]>(() => [
    { key: 'mod+k', handler: () => setShowCommandPalette((prev) => !prev) },
    { key: '?', handler: () => navigateToSettingsTab('shortcuts') },
    { key: 'mod+/', handler: () => navigateToSettingsTab('shortcuts') },
    // Navigation: Cmd+1..4 for Hub / Forge / RunView / Settings
    { key: 'mod+1', handler: () => handleNavigate('hub') },
    { key: 'mod+2', handler: () => handleNavigate('forge') },
    { key: 'mod+3', handler: () => handleNavigate('pipeline') },
    { key: 'mod+4', handler: () => handleNavigate('settings') },
    // Spec actions
    { key: 'mod+n', handler: () => handleNavigate('forge') },
    // Review context: approve / reject (navigate to queue if not already there)
    { key: 'mod+enter', handler: () => { if (activePanel !== 'queue' && activePanel !== 'spec-review') handleNavigate('queue'); } },
    { key: 'mod+backspace', handler: () => { if (activePanel !== 'queue' && activePanel !== 'spec-review') handleNavigate('queue'); } },
    // Pipeline actions
    { key: 'mod+shift+r', handler: () => handleNavigate('pipeline') },
  ], [handleNavigate, navigateToSettingsTab, activePanel]);

  useHotkeys(hotkeys);

  if (workspaces.length === 0) {
    return (
      <Shell>
        <OnboardingWizard />
      </Shell>
    );
  }

  // Run View replaces the main content area when a run ID is active
  const showRunView = activeRunId !== null;

  return (
    <Shell
      sidebar={<Sidebar activePanel={activePanel} onNavigate={handleNavigate} mobileOpen={mobileNavOpen} onMobileClose={() => setMobileNavOpen(false)} />}
      showMenuButton
      onMenuToggle={() => setMobileNavOpen((v) => !v)}
      onNavigate={handleNavigate}
    >
      <EmailVerificationBanner />
      {showRunView ? (
        <ErrorBoundary key={`run-${activeRunId}`} label={`Run #${activeRunId}`}>
          <Suspense fallback={<RunViewTerminalSkeleton />}>
            <RunViewPanel
              runId={activeRunId}
              onBack={navigateBackFromRun}
              onNavigate={handleNavigate}
            />
          </Suspense>
        </ErrorBoundary>
      ) : (
        <>
          {/* key={activePanel} resets ErrorBoundary when switching panels */}
          <ErrorBoundary key={activePanel} label={PANEL_LABELS[activePanel]}>
            <ActivePanel id={activePanel} onNavigate={handleNavigate} onNavigateToRun={navigateToRun} reviewSpecId={reviewSpecId} onNavigateToSpecReview={navigateToSpecReview} forgeBrief={forgeBrief} settingsTab={settingsTab} />
          </ErrorBoundary>
        </>
      )}
      {showCommandPalette && (
        <CommandPalette
          onNavigate={handleNavigate}
          onClose={() => setShowCommandPalette(false)}
          activePanel={activePanel}
          activeRunId={activeRunId}
          onSendToForge={handleSendToForge}
        />
      )}
    </Shell>
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
