import { useState, useMemo, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
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
import ReviewQueuePanel from './panels/ReviewQueuePanel';
import PipelineMonitorPanel from './panels/PipelineMonitorPanel';
import WorktreesPanel from './panels/WorktreesPanel';
import ArchivePanel from './panels/ArchivePanel';
import CompareRunsPanel from './panels/CompareRunsPanel';
import GitHubSettingsPanel from './panels/GitHubSettingsPanel';
import ActivityFeedPanel from './panels/ActivityFeedPanel';
import TeamDirectionPanel from './panels/TeamDirectionPanel';
import TemplateMarketplacePanel from './panels/TemplateMarketplacePanel';
import UsageDashboardPanel from './panels/UsageDashboardPanel';
import CostBreakdownPanel from './panels/CostBreakdownPanel';
import ModelComparisonPanel from './panels/ModelComparisonPanel';
import VelocityChartPanel from './panels/VelocityChartPanel';
import CompletionRatePanel from './panels/CompletionRatePanel';
import HealthDashboardPanel from './panels/HealthDashboardPanel';
import AuditLogPanel from './panels/AuditLogPanel';
import RoiCalculatorPanel from './panels/RoiCalculatorPanel';
import FinOpsDashboardPanel from './panels/FinOpsDashboardPanel';
import SettingsPanel, { type SettingsTab } from './panels/SettingsPanel';
import WorkspaceSettingsPanel from './panels/WorkspaceSettingsPanel';
import HubPanel from './panels/HubPanel';
import RunViewPanel from './panels/RunViewPanel';
import SpecReviewPanel from './panels/SpecReviewPanel';

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
    return (
      <Suspense fallback={<GenericPanelSkeleton />}>
        <PublicReviewPage token={reviewMatch[1]} />
      </Suspense>
    );
  }

  if (loading) {
    // Render shell + skeleton instead of blocking — top bar and sidebar paint immediately
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

  // Handle /reset-password route — show reset page even when auth is bypassed
  if (authPage === 'reset-password') {
    const params = new URLSearchParams(window.location.search);
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

interface ActivePanelProps {
  id: PanelId;
  onNavigate: (panel: PanelId) => void;
  onNavigateToRun: (runId: number) => void;
  reviewSpecId: string | null;
  onNavigateToSpecReview: (specId: string) => void;
  forgeBrief: string | null;
  onForgeBriefConsumed: () => void;
  settingsTab: SettingsTab | undefined;
}

function ActivePanel({ id, onNavigate, onNavigateToRun, reviewSpecId, onNavigateToSpecReview, forgeBrief, onForgeBriefConsumed, settingsTab }: ActivePanelProps) {
  switch (id) {
    case 'hub': return <HubPanel onNavigate={onNavigate} onNavigateToRun={onNavigateToRun} onNavigateToSpecReview={onNavigateToSpecReview} />;
    case 'forge': return <SpecForgePanelPage onNavigate={onNavigate} onNavigateToRun={onNavigateToRun} {...(forgeBrief != null ? { initialBrief: forgeBrief, onBriefConsumed: onForgeBriefConsumed } : {})} />;
    case 'stack': return <SettingsPanel initialTab={settingsTab} />;
    case 'team-direction': return <TeamDirectionPanel />;
    case 'queue': return <ReviewQueuePanel />;
    case 'pipeline': return <PipelineMonitorPanel />;
    case 'worktrees': return <WorktreesPanel />;
    case 'compare': return <CompareRunsPanel onBack={() => onNavigate('pipeline')} />;
    case 'archive': return <ArchivePanel onNavigate={onNavigate} />;
    case 'marketplace': return <TemplateMarketplacePanel />;
    case 'usage': return <UsageDashboardPanel />;
    case 'costs': return <CostBreakdownPanel />;
    case 'models': return <ModelComparisonPanel />;
    case 'velocity': return <VelocityChartPanel />;
    case 'completion': return <CompletionRatePanel />;
    case 'roi': return <RoiCalculatorPanel />;
    case 'finops': return <FinOpsDashboardPanel />;
    case 'health': return <HealthDashboardPanel />;
    case 'audit-log': return <AuditLogPanel />;
    case 'activity': return <ActivityFeedPanel />;
    case 'github': return <GitHubSettingsPanel />;
    case 'workspace-settings': return <WorkspaceSettingsPanel />;
    case 'settings': return <SettingsPanel initialTab={settingsTab} />;
    default: return null;
  }
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
  finops: 'FinOps Dashboard',
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
  const { workspaces, workspaceId } = useWorkspace();
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [forgeBrief, setForgeBrief] = useState<string | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | undefined>(undefined);
  const [queueCount, setQueueCount] = useState(0);

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
    window.location.hash = `/run/${runId}`;
  }, []);

  const navigateBackFromRun = useCallback(() => {
    setActiveRunId(null);
    window.location.hash = '';
  }, []);

  const navigateToSpecReview = useCallback((specId: string) => {
    setReviewSpecId(specId);
    if (activeRunId !== null) {
      setActiveRunId(null);
      window.location.hash = '';
    }
  }, [activeRunId]);

  // Send brief from command palette to Forge (or signal focus-only with empty string)
  const handleSendToForge = useCallback((brief: string) => {
    setForgeBrief(brief);
  }, []);

  // Called by ForgePanel after consuming the brief — prevents stale state
  const handleForgeBriefConsumed = useCallback(() => {
    setForgeBrief(null);
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
    // New spec with brief focused
    { key: 'mod+shift+n', handler: () => { handleSendToForge(''); handleNavigate('forge'); } },
    // Pipeline actions
    { key: 'mod+shift+r', handler: () => handleNavigate('pipeline') },
  ], [handleNavigate, handleSendToForge, navigateToSettingsTab, activePanel]);

  useHotkeys(hotkeys);

  if (workspaces.length === 0) {
    return (
      <Shell>
        <Suspense fallback={<GenericPanelSkeleton />}>
          <OnboardingWizard />
        </Suspense>
      </Shell>
    );
  }

  // Run View replaces the main content area when a run ID is active
  const showRunView = activeRunId !== null;

  const isSettingsContext = ['settings', 'workspace-settings', 'github', 'stack'].includes(activePanel);

  return (
    <Shell
      sidebar={
        <ResizableSidebar>
          {isSettingsContext ? (
            <SettingsSidebar
              activePanel={activePanel}
              activeSettingsTab={settingsTab}
              onNavigate={handleNavigate}
              onNavigateSettings={navigateToSettingsTab}
            />
          ) : (
            <Sidebar
              activePanel={activePanel}
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
      {/* Underlying panel */}
      <ErrorBoundary key={activePanel} label={PANEL_LABELS[activePanel] || 'Panel'}>
        <ActivePanel id={activePanel} onNavigate={handleNavigate} onNavigateToRun={navigateToRun} reviewSpecId={reviewSpecId} onNavigateToSpecReview={navigateToSpecReview} forgeBrief={forgeBrief} onForgeBriefConsumed={handleForgeBriefConsumed} settingsTab={settingsTab} />
      </ErrorBoundary>

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

      <SlideOver isOpen={reviewSpecId !== null} onClose={() => setReviewSpecId(null)} hideHeader={true}>
        {reviewSpecId !== null && (
          <SpecReviewPanel specId={reviewSpecId} onBack={() => setReviewSpecId(null)} onNavigate={handleNavigate} />
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
